/**
 * Deal Wire mailer — Google Apps Script web app.
 *
 * Holds the subscriber list in a private Google Sheet (never in the public repo) and emails each new
 * digest edition to confirmed subscribers. Site access and email are one flow:
 *   1. A friend asks for access on the request page (?action=request). The owner gets an Approve / Decline email.
 *   2. Approve -> this script adds the address to the Cloudflare Access policy "Approved readers" (API) and tells
 *      the person. They open the site and log in with a 6-digit code mailed to them.
 *   3. Only approved readers can subscribe to the email digest (confirmation email -> "active"), and each
 *      edition goes only to "active" subscribers who are still in "Approved readers" at that moment.
 *   doGet   action=request       -> the public access-request page
 *   doPost  action=request_access -> records the request (sheet AccessRequests) and asks the owner
 *   doGet   action=approve|decline (id, k) -> owner only; shows a confirm page, the button POSTs the same to doPost
 *   doPost  action=subscribe     -> approved readers only: adds the address as "pending" and sends a confirmation email
 *   doPost  action=contact       -> emails the site owner what a reader typed in the Contact box
 *   doPost  action=sync          -> stores one browser's followed stories and companies
 *   doPost  JSON {action:'acct'} -> account sync from the Cloudflare Pages Function (needs SYNC_SECRET): stars, companies, hidden
 *   doGet   action=follows       -> every followed story, no viewer ids (read by the fetch job)
 *   doGet   action=companies     -> one browser's companies with their latest headlines (private)
 *   doGet   action=confirm       -> marks the address "active"
 *   doGet   action=unsubscribe   -> marks the address "unsubscribed" (link in every email)
 *   sendNewEdition (time trigger, every 10 min; create it with setupMailTrigger()) -> if a new edition
 *     exists on GitHub, email it once to "active" subscribers who are still approved readers
 *   refreshCompanies (time trigger, every 30 min) -> Google News headlines for every followed company
 *   kickFetch (time trigger, every 30 min) -> asks GitHub to run fetch.yml (its own schedule runs late)
 *   Run from the editor: approveReader(email), revokeReader(email), pauseExistingSubscribers(),
 *     approveExisting(email), requestApprovalForPaused(), setupMailTrigger()
 *
 * Script properties: SHEET_ID (setup), OWNER_KEY (auto), CF_API_TOKEN and CF_ACCOUNT_ID (Cloudflare, set by hand),
 * GITHUB_TOKEN (optional, kickFetch).
 *
 * Setup: paste this file into a new Apps Script project, run setup() once, then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). Put the /exec URL into MAIL_ENDPOINT in docs/app.js.
 */

const CONFIG = {
  SITE_URL: 'https://dealwire.pages.dev/',
  DATA_URL: 'https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/digests/',
  SHEET_NAME: 'Subscribers',
  SENDER_NAME: 'Deal Wire',
  MAX_EDITION_AGE_HOURS: 3,       // do not email an edition that is older than this (e.g. after downtime)
  CONTACT_MAX_CHARS: 4000,
  CONTACT_MAX_PER_DAY: 40,        // a cap so a bot cannot burn the Gmail quota
  APPROVAL_MAX_PER_DAY: 20,       // approval requests mailed to the owner per day
  ACCESS_REQUESTS_PER_DAY: 40,    // access requests recorded per day (a cap against bots)
  POLICY_NAME: 'Approved readers', // the reusable Cloudflare Access policy that lists who may open the site
  READERS_CACHE_SECONDS: 300,
  CF_API: 'https://api.cloudflare.com/client/v4',
};

/* ---------------- setup ---------------- */

function setup() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create('Deal Wire subscribers (private)');
    const sh = ss.getSheets()[0];
    sh.setName(CONFIG.SHEET_NAME);
    sh.appendRow(['email', 'status', 'token', 'created', 'confirmed', 'unsubscribed']);
    sh.setFrozenRows(1);
    props.setProperty('SHEET_ID', ss.getId());
    id = ss.getId();
  }
  // The mail trigger is no longer made here: run setupMailTrigger() when delivery should start.
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'refreshCompanies').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshCompanies').timeBased().everyMinutes(30).create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kickFetch').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kickFetch').timeBased().everyMinutes(30).create();
  viewersTab_(); newsTab_(); accessTab_();
  // Mark the current newest edition as already sent so setup does not email an old digest.
  const idx = fetchJson_(CONFIG.DATA_URL + 'index.json');
  if (idx && idx.editions && idx.editions[0]) props.setProperty('LAST_SENT', idx.editions[0].id);
  Logger.log('Subscribers sheet: https://docs.google.com/spreadsheets/d/' + id);
}

// Creates the 10-minute sendNewEdition trigger once (an existing one is removed first). Run it by hand.
function setupMailTrigger() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'sendNewEdition'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendNewEdition').timeBased().everyMinutes(10).create();
  Logger.log('sendNewEdition trigger created (every 10 minutes)');
}

/* ---------------- contact box ---------------- */

/**
 * Sends what a reader typed straight to whoever owns this script. The address is read from
 * the session rather than written down, so it never appears in the public repository.
 */
function contact_(p) {
  if (String(p.website || '')) return 'ok';                 // honeypot: only a bot fills this
  const message = String(p.message || '').trim().slice(0, CONFIG.CONTACT_MAX_CHARS);
  if (!message) return 'empty';

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  const key = 'CONTACT_' + today;
  const sent = Number(props.getProperty(key) || 0);
  if (sent >= CONFIG.CONTACT_MAX_PER_DAY) return 'limit';

  const from = String(p.from || '').trim().slice(0, 120);
  const owner = Session.getEffectiveUser().getEmail();
  const body = [message, '', '---', 'From: ' + (from || '(no address given)'),
    'Sent from: ' + CONFIG.SITE_URL, 'At: ' + new Date().toISOString()].join('\n');
  const options = { to: owner, subject: 'Deal Wire · message from a reader', name: CONFIG.SENDER_NAME, body: body };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) options.replyTo = from;
  MailApp.sendEmail(options);
  props.setProperty(key, String(sent + 1));
  return 'ok';
}

/* ---------------- following and companies ----------------
 *
 * Each browser keeps a random viewer id and sends its ☆ stories and its companies here. The id is
 * not tied to a person and never leaves this script.
 *   Stories: the research on them is public (the follow-up Routine writes it into the repository),
 *            so ?action=follows lists every followed story, without viewer ids, for the fetch job.
 *   Companies: private. This script fetches their news itself and hands it back only to the
 *            viewer that registered them (?action=companies&vid=...).
 */

const FOLLOW = {
  VIEWERS: 'Viewers',
  NEWS: 'CompanyNews',
  MAX_FOLLOWS_PER_VIEWER: 20,
  MAX_FOLLOWED_STORIES: 30,       // the Routine researches at most this many stories
  MAX_COMPANIES_PER_VIEWER: 15,
  MAX_COMPANY_QUERIES: 60,        // across all viewers, per refresh
  NEWS_KEEP: 40,                  // headlines kept per company
  NEWS_DAYS: 45,
  ACTIVE_DAYS: 60,                // a browser not seen for this long stops counting
  REFRESH_BUDGET_MS: 4.5 * 60 * 1000,
};

function book_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')); }
function tab_(name, header) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
function viewersTab_() { return tab_(FOLLOW.VIEWERS, ['vid', 'follows', 'companies', 'updated']); }
function newsTab_() { return tab_(FOLLOW.NEWS, ['key', 'names', 'keywords', 'news', 'updated']); }

function clip_(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
function parseList_(raw) { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16);
}

function cleanFollows_(raw) {
  return parseList_(raw).slice(0, FOLLOW.MAX_FOLLOWS_PER_VIEWER).map(function (x) {
    return {
      id: clip_(x.id, 40).replace(/[^A-Za-z0-9_-]/g, ''), title: clip_(x.title, 300), link: clip_(x.link, 600),
      source: clip_(x.source, 80), published: clip_(x.published, 30), since: clip_(x.since, 30),
    };
  }).filter(function (x) { return x.id && x.title && /^https?:\/\//.test(x.link); });
}

// A company is {name, keywords} plus, when the reader picked it from the search list, where it
// is listed: market (JP/US), ticker and, for the US, the SEC's CIK. The name field may hold
// several names separated by commas ("Toyota, トヨタ自動車"); the first is the one shown.
function cleanCompanies_(raw) {
  return parseList_(raw).slice(0, FOLLOW.MAX_COMPANIES_PER_VIEWER).map(function (x) {
    const names = String(x.name || '').split(/[,、]/).map(function (s) { return clip_(s, 60); }).filter(String).slice(0, 4);
    const keywords = (Array.isArray(x.keywords) ? x.keywords : []).map(function (s) { return clip_(s, 40); }).filter(String).slice(0, 8);
    const market = x.market === 'JP' || x.market === 'US' ? x.market : '';
    const ticker = /^[A-Za-z0-9.\-]{1,10}$/.test(String(x.ticker || '')) ? String(x.ticker).toUpperCase() : '';
    const cik = /^\d{1,10}$/.test(String(x.cik || '')) ? String(x.cik) : '';
    return { names: names, keywords: keywords, market: market, ticker: ticker, cik: market === 'US' ? cik : '' };
  }).filter(function (c) { return c.names.length; });
}
function companyKey_(c) {
  return hex_(c.names.map(function (s) { return s.toLowerCase(); }).join('|') + '#' +
    c.keywords.map(function (s) { return s.toLowerCase(); }).sort().join('|'));
}

function sync_(p) {
  const vid = String(p.vid || '');
  if (!/^[a-f0-9]{24,40}$/.test(vid)) return 'bad viewer';
  const follows = cleanFollows_(p.follows), companies = cleanCompanies_(p.companies);
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = viewersTab_(), rows = sh.getDataRange().getValues(), now = new Date();
    // stored in the shape the page sends, so every reader can run it through cleanCompanies_ again
    const stored = companies.map(function (c) {
      return { name: c.names.join(', '), keywords: c.keywords, market: c.market, ticker: c.ticker, cik: c.cik };
    });
    const row = [vid, JSON.stringify(follows), JSON.stringify(stored), now];
    let r = 1;
    while (r < rows.length && rows[r][0] !== vid) r++;
    if (r < rows.length) sh.getRange(r + 1, 1, 1, 4).setValues([row]); else sh.appendRow(row);
  } finally { lock.releaseLock(); }
  kickCompanies_(companies);
  return 'ok';
}

// A company added just now gets its first headlines at once instead of at the next refresh.
function kickCompanies_(companies) {
  const tab = newsTab_(), known = {};
  tab.getDataRange().getValues().slice(1).forEach(function (r) { known[r[0]] = true; });
  companies.filter(function (c) { return !known[companyKey_(c)]; }).slice(0, 3)
    .forEach(function (c) { refreshCompany_(tab, c); });
  // and one new listing its profile; the rest wait for the next refresh
  const have = profilesByKey_();
  companies.filter(function (c) { return profileKey_(c) && !have[profileKey_(c)]; }).slice(0, 1)
    .forEach(function (c) { try { refreshProfile_(c); } catch (e) { Logger.log('profile at sync failed: ' + e); } });
}

// Browsers that sent a sync, plus accounts (rows of Accounts, shaped like a browser). A browser that
// has since logged in to an account is skipped: its stars and companies live in the account now.
function activeViewers_() {
  const cutoff = Date.now() - FOLLOW.ACTIVE_DAYS * 864e5;
  const accounts = accountsTab_().getDataRange().getValues().slice(1).filter(function (r) { return r[0]; });
  const moved = {};
  accounts.forEach(function (r) { parseList_(r[6]).forEach(function (v) { moved[v] = true; }); });
  const rows = viewersTab_().getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0] && !moved[r[0]] && new Date(r[3]).getTime() >= cutoff; });
  accounts.filter(function (r) { return new Date(r[5]).getTime() >= cutoff; })
    .forEach(function (r) { rows.push(acctViewerRow_(r)); });
  return rows;
}

// Every followed story, most followed first, then the most recently followed.
function follows_() {
  const byId = {};
  activeViewers_().forEach(function (r) {
    parseList_(r[1]).forEach(function (x) {
      const s = byId[x.id] || (byId[x.id] = { id: x.id, title: x.title, link: x.link, source: x.source, published: x.published, since: x.since || '', followers: 0 });
      s.followers++;
      if (x.since && (!s.since || x.since < s.since)) s.since = x.since;
    });
  });
  const stories = Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return b.followers - a.followers || String(b.since).localeCompare(String(a.since)); })
    .slice(0, FOLLOW.MAX_FOLLOWED_STORIES);
  return { generated_at: new Date().toISOString(), stories: stories };
}

function companiesFor_(vid) {
  if (!/^[a-f0-9]{24,40}$/.test(String(vid || ''))) return { companies: [] };
  const mine = viewersTab_().getDataRange().getValues().slice(1).filter(function (r) { return r[0] === vid; })[0];
  return companiesView_(mine ? mine[2] : '[]');
}

// A reader's companies (raw JSON list) with their headlines and profiles.
function companiesView_(rawCompanies) {
  const news = {};
  newsTab_().getDataRange().getValues().slice(1).forEach(function (r) {
    news[r[0]] = { names: parseList_(r[1]), news: parseList_(r[3]), updated: r[4] ? new Date(r[4]).toISOString() : '' };
  });
  const profiles = profilesByKey_();
  return {
    companies: cleanCompanies_(rawCompanies).map(function (c) {
      const n = news[companyKey_(c)] || { names: c.names, news: [], updated: '' };
      return { name: c.names.join(', '), keywords: c.keywords, searched: n.names, news: n.news, updated: n.updated,
        facts: null, profile: profileFor_(c, profiles) };
    }),
  };
}

/* ---------------- company profile ----------------
 * What the Companies page shows above the headlines: financials, who holds the shares and whether
 * a takeover defence is in place. Built per listing (JP:7203, US:AAPL). GitHub Actions does the
 * reading (EDINET for Japan, the SEC for the US; both refuse or hide behind keys that cannot live
 * here) and publishes one JSON per ticker under docs/data/jp_profiles and docs/data/us_profiles.
 * This script copies the file for each company someone follows into the Profiles tab, which is
 * what the page receives, and refreshes it when it is a week old. Share prices are not collected;
 * the page embeds TradingView and only needs the symbol in the file.
 * Every figure is what the filing says. The defence flags are matched by text, so they are hints.
 */
const PROFILES_TAB = 'Profiles';
const PROFILE_MAX_AGE_MS = 7 * 864e5;

function profilesTab_() { return tab_(PROFILES_TAB, ['key', 'profile', 'updated']); }
function profilesByKey_() {
  const out = {};
  profilesTab_().getDataRange().getValues().slice(1).forEach(function (r) {
    let p = null; try { p = JSON.parse(r[1] || 'null'); } catch (e) { /* unreadable row: rebuilt */ }
    out[String(r[0])] = { profile: p, updated: new Date(r[2]).getTime() || 0 };
  });
  return out;
}
// JP:7203 or US:AAPL; empty when the company was typed in rather than picked from the search list.
function profileKey_(c) { return c.market && c.ticker ? c.market + ':' + c.ticker : ''; }
function saveProfile_(key, profile) {
  const tab = profilesTab_(), rows = tab.getDataRange().getValues();
  let r = 1;
  while (r < rows.length && String(rows[r][0]) !== key) r++;
  const row = [key, JSON.stringify(profile), new Date()];
  if (r < rows.length) tab.getRange(r + 1, 1, 1, 3).setValues([row]); else tab.appendRow(row);
}
// What the page gets for one company. Never throws: a company with nothing built yet is "pending".
function profileFor_(c, stored) {
  const key = profileKey_(c);
  if (!key) return { status: 'pending', status_note: 'Pick the company from the search list to get its profile', updated: '' };
  const hit = stored[key];
  if (hit && hit.profile) return hit.profile;
  return { market: c.market, ticker: c.ticker, tv_symbol: c.market === 'JP' ? 'TSE:' + c.ticker : '', sector: '',
    fin: null, holders: null, defense: null, status: 'pending', status_note: 'Profile is being prepared', updated: '' };
}

// Builds and stores one profile. Errors are stored as status "error" so the page says so
// and the next run retries after a week at the latest.
function refreshProfile_(c) {
  const key = profileKey_(c);
  if (!key) return;
  let p;
  try { p = c.market === 'JP' ? jpProfile_(c) : usProfile_(c); } catch (e) {
    Logger.log('profile failed for ' + key + ': ' + e);
    p = { market: c.market, ticker: c.ticker, tv_symbol: c.market === 'JP' ? 'TSE:' + c.ticker : '', sector: '',
      fin: null, holders: null, defense: null, status: 'error', status_note: clip_(e && e.message != null ? e.message : e, 200) };
  }
  p.updated = new Date().toISOString();
  saveProfile_(key, p);
}

// Time-trigger helper: the oldest or missing profiles first, as many as the time allows.
function refreshProfiles_(wanted, start) {
  const stored = profilesByKey_(), todo = [];
  Object.keys(wanted).forEach(function (k) {
    const key = profileKey_(wanted[k]);
    if (!key) return;
    const have = stored[key];
    const age = have ? Date.now() - have.updated : 0, st = have && have.profile ? have.profile.status : '';
    // a good profile lasts a week; an error, a pending one (the Actions build has not reached the
    // company yet) or one still collecting holders is looked at again every 6 hours
    const waiting = have && have.profile && have.profile.detail === 'pending';
    // a pending or error row whose note this version never writes was left by older code: rebuild it at once
    const note = have && have.profile ? String(have.profile.status_note) : '';
    const oldNote = st === 'pending' && !/not built yet$|search list/.test(note) || st === 'error' && /SEC|EDINET|submissions/.test(note);
    const stale = oldNote || (st === 'ok' && !waiting ? age > PROFILE_MAX_AGE_MS : age > 6 * 36e5);
    if (!have || !have.profile || stale) todo.push({ key: key, c: wanted[k], at: have ? have.updated : 0 });
  });
  const seen = {};
  todo.filter(function (t) { return seen[t.key] ? false : (seen[t.key] = true); })
    .sort(function (a, b) { return a.at - b.at; }).slice(0, 8)
    .forEach(function (t) { if (Date.now() - start < FOLLOW.REFRESH_BUDGET_MS) refreshProfile_(t.c); });
  // forget profiles nobody follows any more
  const tab = profilesTab_(), rows = tab.getDataRange().getValues(), keep = {};
  Object.keys(wanted).forEach(function (k) { const pk = profileKey_(wanted[k]); if (pk) keep[pk] = true; });
  for (let r = rows.length - 1; r >= 1; r--) if (!keep[String(rows[r][0])]) tab.deleteRow(r + 1);
}

/* ---------------- Japan: profiles built by GitHub Actions ----------------
 * fetcher/jp_profiles.py reads each listed company's annual securities report on EDINET (the key
 * lives in a GitHub secret, not here) and publishes docs/data/jp_profiles/<ticker>.json in the
 * shape the page uses. This script only copies that file in; no EDINET call is made from here.
 */
const JP_PROFILE_URL = 'https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/jp_profiles/';

function jpProfile_(c) {
  const p = fetchJson_(JP_PROFILE_URL + encodeURIComponent(c.ticker) + '.json');
  if (!p) {
    return { market: 'JP', ticker: c.ticker, tv_symbol: 'TSE:' + c.ticker, sector: '', fin: null, holders: null, defense: null,
      status: 'pending', status_note: 'Japanese filing data not built yet' };
  }
  p.status = 'ok'; p.status_note = '';
  return p;
}

/* ---------------- US: profiles built by GitHub Actions ----------------
 * fetcher/us_profiles.py reads the SEC (XBRL frames for the financials, Schedule 13D/13G for
 * holders of 5% and over, rights-plan filings for the defence hint) and publishes
 * docs/data/us_profiles/<ticker>.json. Google's servers are refused by the SEC, so nothing here
 * calls it. The file has detail "pending" until holders and defence have been looked at.
 */
const US_PROFILE_URL = 'https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/us_profiles/';

function usProfile_(c) {
  const p = fetchJson_(US_PROFILE_URL + encodeURIComponent(c.ticker) + (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(c.ticker) ? '_' : '') + '.json');
  if (!p) {
    return { market: 'US', ticker: c.ticker, tv_symbol: '', sector: '', fin: null, holders: null, defense: null,
      status: 'pending', status_note: 'US filing data not built yet' };
  }
  p.status = 'ok';
  p.status_note = p.detail === 'pending' ? 'Shareholder and defence details are still being collected for this company' : '';
  return p;
}

// The name in the other language, so "Toyota" also finds トヨタ and トヨタ自動車 also finds Toyota Motor.
// A translation that is not a name (Apple -> りんご) would search for the wrong thing, so the
// company is framed as a company and anything that comes back in plain hiragana is dropped.
function otherName_(name) {
  const isJa = /[぀-ヿ一-鿿]/.test(name);
  try {
    let t = isJa ? LanguageApp.translate(name, 'ja', 'en') : LanguageApp.translate('the company ' + name, 'en', 'ja');
    t = String(t || '').replace(/^(その|同)?(会社|企業)\s*/, '').replace(/(社|株式会社)$/, '').replace(/^the company\s+/i, '').trim();
    if (!t || t.toLowerCase() === name.toLowerCase()) return '';
    if (!isJa && /^[぀-ゟ\s]+$/.test(t)) return '';
    return t.slice(0, 60);
  } catch (e) { return ''; }
}

function quote_(s) { return /\s/.test(s) ? '"' + s.replace(/"/g, '') + '"' : s; }

function refreshCompany_(tab, c) {
  const key = companyKey_(c);
  const rows = tab.getDataRange().getValues();
  let r = 1;
  while (r < rows.length && rows[r][0] !== key) r++;
  const existing = r < rows.length ? rows[r] : null;
  let names = existing ? parseList_(existing[1]) : [];
  if (!names.length) {
    names = c.names.slice();
    if (names.length === 1) { const o = otherName_(names[0]); if (o) names.push(o); }
  }
  let q = '(' + names.map(quote_).join(' OR ') + ')';
  if (c.keywords.length) q += ' (' + c.keywords.map(quote_).join(' OR ') + ')';
  let news = existing ? parseList_(existing[3]) : [];
  [['en-US', 'US', 'US:en'], ['ja', 'JP', 'JP:ja']].forEach(function (ed) {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:30d') +
      '&hl=' + ed[0] + '&gl=' + ed[1] + '&ceid=' + encodeURIComponent(ed[2]);
    news = news.concat(parseRss_(url));
  });
  const cutoff = Date.now() - FOLLOW.NEWS_DAYS * 864e5, seen = {};
  news = news.filter(function (x) {
    const k = x.title.toLowerCase().replace(/\s+/g, ' ');
    if (seen[x.link] || seen[k] || Date.parse(x.published) < cutoff) return false;
    seen[x.link] = seen[k] = true; return true;
  }).sort(function (a, b) { return String(b.published).localeCompare(String(a.published)); }).slice(0, FOLLOW.NEWS_KEEP);
  const row = [key, JSON.stringify(names), JSON.stringify(c.keywords), JSON.stringify(news), new Date()];
  if (existing) tab.getRange(r + 1, 1, 1, 5).setValues([row]); else tab.appendRow(row);
}

function parseRss_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    const channel = XmlService.parse(res.getContentText()).getRootElement().getChild('channel');
    return channel.getChildren('item').map(function (it) {
      const src = it.getChild('source'), source = src ? src.getText() : '';
      let title = it.getChildText('title') || '';
      if (source && title.slice(-(source.length + 3)) === ' - ' + source) title = title.slice(0, -(source.length + 3));
      const d = new Date(it.getChildText('pubDate'));
      return { title: clip_(title, 300), link: clip_(it.getChildText('link'), 600), source: clip_(source, 80),
        published: isNaN(d) ? '' : d.toISOString() };
    }).filter(function (x) { return x.title && x.link && x.published; });
  } catch (e) { return []; }
}

// Time trigger (every 30 minutes): refresh every company someone still follows, stalest first,
// and drop the ones nobody follows any more.
function refreshCompanies() {
  try { refreshCompanies_(); } catch (e) {
    if (!transient_(e)) throw e;
    console.warn('refreshCompanies: transient error, will retry next run: ' + e.message);
  }
}
function refreshCompanies_() {
  const start = Date.now(), wanted = {};
  activeViewers_().forEach(function (r) {
    cleanCompanies_(r[2]).forEach(function (c) { wanted[companyKey_(c)] = c; });
  });
  const tab = newsTab_(), rows = tab.getDataRange().getValues(), updated = {};
  for (let r = rows.length - 1; r >= 1; r--) {
    if (!wanted[rows[r][0]]) tab.deleteRow(r + 1); else updated[rows[r][0]] = new Date(rows[r][4]).getTime() || 0;
  }
  Object.keys(wanted).sort(function (a, b) { return (updated[a] || 0) - (updated[b] || 0); })
    .slice(0, FOLLOW.MAX_COMPANY_QUERIES).forEach(function (k) {
      if (Date.now() - start < FOLLOW.REFRESH_BUDGET_MS) refreshCompany_(tab, wanted[k]);
    });
  // profiles (financials, holders, takeover defence): a few per run, in what time is left
  refreshProfiles_(wanted, start);
}

// Reads come back as JSONP when the page asks for it: a script tag loads across origins
// where a fetch of an Apps Script reply cannot be relied on.
function json_(obj, callback) {
  const body = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]{0,40}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- keeping the headline fetch on time ----------------
 * GitHub starts scheduled workflows late when it is busy: fetch.yml says every 30 minutes but ran
 * every 3 to 5 hours, so the digest found nothing new. This trigger asks GitHub to run it every
 * 30 minutes instead. It needs a fine-grained token limited to this repository with
 * Actions: read and write, saved as the script property GITHUB_TOKEN. Without it, nothing happens.
 */
const GITHUB_FETCH_WORKFLOW = 'https://api.github.com/repos/17yyamada-tech/dealwire_dailyupdate/actions/workflows/fetch.yml/dispatches';

function kickFetch() {
  try { kickFetch_(); } catch (e) {
    if (!transient_(e)) throw e;
    console.warn('kickFetch: transient error, will retry next run: ' + e.message);
  }
}
function kickFetch_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('No GITHUB_TOKEN script property: nothing to do'); return; }
  const res = UrlFetchApp.fetch(GITHUB_FETCH_WORKFLOW, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ ref: 'main' }), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const code = res.getResponseCode();
  // A rejected token never fixes itself, so make it a visible failure; 5xx and 429 pass on their own.
  if (code === 401 || code === 403 || code === 404) {
    throw new Error('kickFetch: GitHub returned ' + code + ' (token expired or lacks Actions write?) ' + res.getContentText().slice(0, 200));
  }
  Logger.log(code === 204 ? 'fetch.yml started' : 'fetch.yml did not start: ' + code + ' ' + res.getContentText().slice(0, 200));
}

/* ---------------- accounts: the same stars, companies and hidden stories on every device ----------------
 *
 * The Cloudflare Pages Function (functions/api/*) proves who is asking from the Cloudflare Access
 * login and calls doPost with {action:'acct', secret, email, op, ops, vid}. The secret is the script
 * property SYNC_SECRET; a call without it is refused. The browser never names its own email.
 *
 * Each account is one row of the sheet Accounts. The three shared lists are stored as records
 * {t, v}: v is the value, or null once deleted (a "tombstone"), t the time of the last change.
 * A change is an operation {k, key, t, v}; the newer t wins per key, so a deletion is not undone by
 * another device that still has the old item, and two devices changing different things both keep
 * their changes. Tombstones are kept 90 days.
 *
 * Followed stories and companies of an account feed the same jobs as before (follows_,
 * refreshCompanies_) through activeViewers_. The vids a browser used before it logged in are
 * recorded here so that its old Viewers row is not counted twice.
 */
// ACCT-CORE-BEGIN
const ACCT = {
  TAB: 'Accounts',
  MAX_SAVED: 20, MAX_COMPANIES: 15, MAX_HIDDEN: 600,
  TOMB_DAYS: 90, TOMB_MAX: 100, HIDDEN_DAYS: 120,
  MAX_OPS: 200, FUTURE_MS: 5 * 60 * 1000, MAX_VIDS: 10,
};

function acctStr_(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
function acctStrs_(a, n, m) { return (Array.isArray(a) ? a : []).slice(0, m).map(function (x) { return acctStr_(x, n); }).filter(String); }
function acctId_(s) { return acctStr_(s, 40).replace(/[^A-Za-z0-9_-]/g, ''); }

function acctCleanSaved_(v) {
  if (!v || typeof v !== 'object') return null;
  const o = {
    id: acctId_(v.id), title: acctStr_(v.title, 300), link: acctStr_(v.link, 600), source: acctStr_(v.source, 80),
    source_id: acctStr_(v.source_id, 40), published: acctStr_(v.published, 30), fetched: acctStr_(v.fetched, 30),
    since: acctStr_(v.since, 30), snippet: acctStr_(v.snippet, 300),
    categories: acctStrs_(v.categories, 30, 8), countries: acctStrs_(v.countries, 30, 8), sectors: acctStrs_(v.sectors, 30, 8),
    is_deal: v.is_deal === true, has_amount: v.has_amount === true, actor: acctStr_(v.actor, 20),
  };
  if (!o.id || !o.title || !/^https?:\/\//.test(o.link)) return null;
  if (JSON.stringify(o).length > 1800) o.snippet = '';
  return o;
}

function acctCleanCompany_(v) {
  if (!v || typeof v !== 'object') return null;
  const o = {
    name: acctStr_(v.name, 240), keywords: acctStrs_(v.keywords, 40, 8),
    market: v.market === 'JP' || v.market === 'US' ? v.market : '',
    ticker: /^[A-Za-z0-9.\-]{1,10}$/.test(String(v.ticker || '')) ? String(v.ticker).toUpperCase() : '',
    cik: /^\d{1,10}$/.test(String(v.cik || '')) ? String(v.cik) : '',
    exchange: acctStr_(v.exchange, 12), sector: acctStr_(v.sector, 40),
    kind: v.kind === 'fund' || v.kind === 'corp' ? v.kind : '',
  };
  return o.name ? o : null;
}

// Applies operations to state ({saved:{}, companies:{}, hidden:{}}) in place. Returns the live
// company values that arrived in this call (so their first headlines can be fetched).
function acctApply_(state, ops, nowMs) {
  const arrived = [];
  (Array.isArray(ops) ? ops : []).slice(0, ACCT.MAX_OPS).forEach(function (op) {
    if (!op || (op.k !== 'saved' && op.k !== 'companies' && op.k !== 'hidden')) return;
    const key = op.k === 'companies' ? acctStr_(op.key, 300) : acctId_(op.key);
    if (!key) return;
    let t = Math.floor(Number(op.t));
    if (!(t > 0)) t = nowMs;
    if (t > nowMs + ACCT.FUTURE_MS) t = nowMs;
    let v = null;
    if (op.v != null) {
      v = op.k === 'saved' ? acctCleanSaved_(op.v) : op.k === 'companies' ? acctCleanCompany_(op.v) : 1;
      if (v === null) return;                       // an invalid value is dropped, not read as a deletion
      if (op.k === 'saved' && v.id !== key) return;
    }
    const cur = state[op.k][key];
    if (cur && (cur.t > t || (cur.t === t && (cur.v === null || v !== null)))) return;   // the newer wins; a tie goes to deletion
    const rec = { t: t, v: v };
    if (op.k === 'companies') {
      let o = Math.floor(Number(op.o));
      if (!(o > 0) || o > nowMs) o = cur && cur.o ? cur.o : t;
      rec.o = o;
      if (v !== null) arrived.push(v);
    }
    state[op.k][key] = rec;
  });
  acctEnforce_(state, nowMs);
  return { companies: arrived };
}

function acctLiveKeys_(recs) { return Object.keys(recs).filter(function (k) { return recs[k].v !== null; }); }

// Caps (20 stars, 15 companies), the 120-day memory of hidden stories and the 90-day tombstones.
function acctEnforce_(state, nowMs) {
  function tomb(recs, k) { recs[k] = { t: recs[k].t + 1, v: null, o: recs[k].o }; }
  const bySince = acctLiveKeys_(state.saved).sort(function (a, b) {
    const x = state.saved[a], y = state.saved[b];
    return String(y.v.since).localeCompare(String(x.v.since)) || y.t - x.t;
  });
  bySince.slice(ACCT.MAX_SAVED).forEach(function (k) { tomb(state.saved, k); });
  const byAdded = acctLiveKeys_(state.companies).sort(function (a, b) { return (state.companies[b].o || 0) - (state.companies[a].o || 0); });
  byAdded.slice(ACCT.MAX_COMPANIES).forEach(function (k) { tomb(state.companies, k); });
  const hid = acctLiveKeys_(state.hidden).sort(function (a, b) { return state.hidden[b].t - state.hidden[a].t; });
  hid.forEach(function (k, i) { if (i >= ACCT.MAX_HIDDEN || state.hidden[k].t < nowMs - ACCT.HIDDEN_DAYS * 864e5) delete state.hidden[k]; });
  ['saved', 'companies', 'hidden'].forEach(function (kind) {
    const recs = state[kind];
    const dead = Object.keys(recs).filter(function (k) { return recs[k].v === null; })
      .sort(function (a, b) { return recs[b].t - recs[a].t; });
    dead.forEach(function (k, i) { if (i >= ACCT.TOMB_MAX || recs[k].t < nowMs - ACCT.TOMB_DAYS * 864e5) delete recs[k]; });
  });
}
// ACCT-CORE-END

function accountsTab_() { return tab_(ACCT.TAB, ['email', 'saved', 'companies', 'hidden', 'updated', 'seen', 'vids']); }
function acctObj_(raw) { try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
function acctSame_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function acctRowState_(row) { return { saved: acctObj_(row[1]), companies: acctObj_(row[2]), hidden: acctObj_(row[3]) }; }

// A company in the shape the page sends (and cleanCompanies_ reads).
function acctCompanyStored_(c) { return { name: c.name, keywords: c.keywords, market: c.market, ticker: c.ticker, cik: c.cik }; }
function acctLive_(recs, sortBy) {
  return acctLiveKeys_(recs).sort(function (a, b) { return sortBy(recs[b]) - sortBy(recs[a]); }).map(function (k) { return recs[k].v; });
}
// An account as a Viewers-style row [id, follows json, companies json, seen], so follows_ and
// refreshCompanies_ treat it like any other reader.
function acctViewerRow_(row) {
  const st = acctRowState_(row);
  const follows = acctLive_(st.saved, function (r) { return Date.parse(r.v.since) || r.t; });
  const companies = acctLive_(st.companies, function (r) { return r.o || 0; }).map(acctCompanyStored_);
  return ['acct:' + row[0], JSON.stringify(follows), JSON.stringify(companies), row[5]];
}

function acct_(b) {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret || !acctSame_(String(b.secret || ''), secret)) return { error: 'forbidden' };
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: 'bad email' };
  const vid = /^[a-f0-9]{24,40}$/.test(String(b.vid || '')) ? String(b.vid) : '';
  if (b.op === 'companies') {
    const mine = accountsTab_().getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]).toLowerCase() === email; })[0];
    return companiesView_(mine ? acctViewerRow_(mine)[2] : '[]');
  }
  if (b.op !== 'state' && b.op !== 'ops') return { error: 'bad op' };
  let state, arrived = [];
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = accountsTab_(), rows = sh.getDataRange().getValues(), now = Date.now();
    let r = 1;
    while (r < rows.length && String(rows[r][0]).toLowerCase() !== email) r++;
    const found = r < rows.length, row = found ? rows[r] : [email, '{}', '{}', '{}', '', '', '[]'];
    state = acctRowState_(row);
    const vids = parseList_(row[6]).filter(String);
    let dirty = !found;
    if (b.op === 'ops' && Array.isArray(b.ops) && b.ops.length) { arrived = acctApply_(state, b.ops, now).companies; dirty = true; }
    if (vid && vids.indexOf(vid) < 0) { vids.push(vid); while (vids.length > ACCT.MAX_VIDS) vids.shift(); dirty = true; }
    const seen = row[5] ? new Date(row[5]).getTime() : 0;
    if (dirty || now - seen > 3600e3) {
      const out = [email, JSON.stringify(state.saved), JSON.stringify(state.companies), JSON.stringify(state.hidden),
        dirty ? new Date(now) : row[4], new Date(now), JSON.stringify(vids)];
      if (found) sh.getRange(r + 1, 1, 1, 7).setValues([out]); else sh.appendRow(out);
    }
  } finally { lock.releaseLock(); }
  // a company added just now gets its first headlines at once
  if (arrived.length) kickCompanies_(cleanCompanies_(JSON.stringify(arrived.map(acctCompanyStored_))));
  return { recs: state, now: Date.now() };
}

/* ---------------- web endpoints ---------------- */

function doPost(e) {
  // the Pages Function sends JSON (account sync); the page itself posts forms
  if (e && e.postData && /json|text\/plain/.test(String(e.postData.type))) {
    let b = null;
    try { b = JSON.parse(e.postData.contents); } catch (err) { b = null; }
    if (b && b.action === 'acct') return json_(acct_(b));
  }
  const p = (e && e.parameter) || {};
  if (p.action === 'subscribe') return text_(subscribe_(String(p.email || '').trim().toLowerCase()));
  if (p.action === 'contact') return text_(contact_(p));
  if (p.action === 'sync') return text_(sync_(p));
  if (p.action === 'approve' || p.action === 'decline') return page_(ownerDecision_(p.action, p.id, p.k));   // button on the confirmation page
  if (p.action === 'request_access') return page_(requestAccess_(p));
  return text_('unknown action');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'follows') return json_(follows_(), p.callback);
  if (p.action === 'companies') return json_(companiesFor_(p.vid), p.callback);
  if (p.action === 'request') return requestPage_();
  if (p.action === 'approve' || p.action === 'decline') return ownerConfirmPage_(p.id, p.k);   // asks first; nothing changes on GET
  if (p.action === 'confirm') return page_(setStatusByToken_(p.t, 'active')
    ? ['You are subscribed', 'Deal Wire will arrive at 08:30, 12:30 and 15:30 SGT.']
    : ['Link not valid', 'This confirmation link has expired or was already used.']);
  if (p.action === 'unsubscribe') return page_(setStatusByToken_(p.t, 'unsubscribed')
    ? ['Unsubscribed', 'You will not receive Deal Wire emails any more. You can sign up again on the site at any time.']
    : ['Link not valid', 'We could not find this subscription.']);
  return page_(['Deal Wire', 'Nothing to see here.']);
}

function subscribe_(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return 'invalid email';
  // only people already let into the site (the Cloudflare policy) may subscribe; no second approval is needed
  let readers;
  try { readers = getReaders_(false); } catch (e) { Logger.log('subscribe: ' + e); return 'try again later'; }
  if (readers.indexOf(email) < 0) return 'request access first';
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = sheet_(), rows = sh.getDataRange().getValues();
    const now = new Date();
    for (let r = 1; r < rows.length; r++) {
      if (rows[r][0] !== email) continue;
      if (rows[r][1] === 'active') return 'already subscribed';
      // re-send the confirmation at most every 10 minutes to stop the form being used to spam an inbox
      if (rows[r][1] === 'pending' && now - new Date(rows[r][3]) < 10 * 60 * 1000) return 'confirmation already sent';
      const t = Utilities.getUuid();
      sh.getRange(r + 1, 2, 1, 3).setValues([['pending', t, now]]);
      sendConfirm_(email, t);
      return 'confirmation sent';
    }
    const token = Utilities.getUuid();
    sh.appendRow([email, 'pending', token, now, '', '']);
    sendConfirm_(email, token);
    return 'confirmation sent';
  } finally { lock.releaseLock(); }
}

/* ---------------- Cloudflare Access: who may open the site ----------------
 * The reusable policy "Approved readers" (Allow, Include = Emails) is the list. This script reads and
 * edits it through the Cloudflare API with a token that can edit Access policies (property CF_API_TOKEN)
 * and the account id (CF_ACCOUNT_ID). Docs: developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/
 */

// One Cloudflare call. Throws with a message that says "try again" for 5xx, 429 and network errors,
// so the time triggers treat those as passing (see transient_).
function cf_(method, path, payload) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('CF_API_TOKEN'), account = props.getProperty('CF_ACCOUNT_ID');
  if (!token || !account) throw new Error('Cloudflare is not set up: save CF_API_TOKEN and CF_ACCOUNT_ID as script properties');
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token.trim() } };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  let res;
  try { res = UrlFetchApp.fetch(CONFIG.CF_API + '/accounts/' + account.trim() + path, opts); } catch (e) {
    throw new Error('Cloudflare API unreachable, try again: ' + e.message);
  }
  const code = res.getResponseCode(), text = res.getContentText();
  let body = null; try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (code >= 500 || code === 429) throw new Error('Cloudflare API ' + code + ', try again');
  if (code < 200 || code >= 300 || !body || body.success === false) {
    throw new Error('Cloudflare API ' + code + ': ' + text.slice(0, 300));
  }
  return body.result;
}

function readerPolicy_() {
  const list = cf_('get', '/access/policies?per_page=100') || [];
  const hit = list.filter(function (x) { return x.name === CONFIG.POLICY_NAME; })[0];
  if (!hit) throw new Error('Cloudflare policy "' + CONFIG.POLICY_NAME + '" was not found in this account');
  return cf_('get', '/access/policies/' + hit.id);
}
function policyEmails_(policy) {
  return (policy.include || []).filter(function (r) { return r && r.email && r.email.email; })
    .map(function (r) { return String(r.email.email).toLowerCase(); });
}
// The addresses in "Approved readers", lower case. Cached for a few minutes unless fresh is true.
function getReaders_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const hit = cache.get('READERS'); if (hit) return JSON.parse(hit); }
  const list = policyEmails_(readerPolicy_());
  cache.put('READERS', JSON.stringify(list), CONFIG.READERS_CACHE_SECONDS);
  return list;
}
// Writes the policy back with a new include list. Only the editable fields are sent; the rest stays as it was.
function savePolicy_(policy, include) {
  const body = { include: include };
  ['name', 'decision', 'exclude', 'require', 'precedence', 'session_duration', 'approval_required', 'approval_groups',
    'isolation_required', 'purpose_justification_required', 'purpose_justification_prompt'].forEach(function (f) {
    if (policy[f] !== undefined && policy[f] !== null) body[f] = policy[f];
  });
  cf_('put', '/access/policies/' + policy.id, body);
  CacheService.getScriptCache().remove('READERS');
}
function addReader_(email) {
  email = String(email).trim().toLowerCase();
  const policy = readerPolicy_();
  if (policyEmails_(policy).indexOf(email) >= 0) return false;   // already in; nothing to change
  savePolicy_(policy, (policy.include || []).concat([{ email: { email: email } }]));
  return true;
}
function removeReader_(email) {
  email = String(email).trim().toLowerCase();
  const policy = readerPolicy_();
  const keep = (policy.include || []).filter(function (r) { return !(r && r.email && String(r.email.email).toLowerCase() === email); });
  if (keep.length === (policy.include || []).length) return false;
  savePolicy_(policy, keep);
  return true;
}

/* ---------------- access requests and the owner's decision ---------------- */

function accessTab_() { return tab_('AccessRequests', ['email', 'note', 'status', 'token', 'requested', 'decided']); }

function pageHead_(title, intro) {
  return '<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">' +
    '<p style="font:bold 14px Consolas,monospace;letter-spacing:.14em;color:#c98a00">DEAL WIRE</p>' +
    '<h1 style="font-size:22px">' + esc_(title) + '</h1><p style="color:#374151">' + intro + '</p>';
}

// The public page a friend opens to ask for access.
function requestPage_() {
  const url = ScriptApp.getService().getUrl();
  const input = 'width:100%;box-sizing:border-box;padding:10px;font:15px Arial,sans-serif;border:1px solid #9ca3af;border-radius:3px;margin:0 0 12px';
  return HtmlService.createHtmlOutput(
    pageHead_('Ask for access to Deal Wire', 'Enter your email address. After the owner approves it, you open the site and log in with a 6-digit code sent to this address.') +
    '<form method="post" action="' + esc_(url) + '" target="_top">' +
    '<input type="hidden" name="action" value="request_access">' +
    '<input type="email" name="email" required maxlength="200" placeholder="you@example.com" style="' + input + '">' +
    '<input type="text" name="note" maxlength="300" placeholder="Who are you? (optional)" style="' + input + '">' +
    '<input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">' +
    '<button type="submit" style="background:#ffbf3c;color:#000;border:0;border-radius:3px;font:bold 13px Arial,sans-serif;letter-spacing:.06em;padding:12px 18px;cursor:pointer">ASK FOR ACCESS</button>' +
    '</form></div>').setTitle('Deal Wire');
}

// Records a request and asks the owner. The answer never says what happened to an earlier request.
function requestAccess_(p) {
  const done = ['Request received', 'The owner has been asked. If it is approved, you will get an email at this address.'];
  if (String(p.website || '')) return done;                                  // honeypot: only a bot fills this
  const email = String(p.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return ['Check the address', 'That does not look like an email address.'];
  const note = clip_(p.note, 300);
  const props = PropertiesService.getScriptProperties();
  const dayKey = 'ACCESS_' + Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = accessTab_(), rows = sh.getDataRange().getValues(), now = new Date();
    for (let r = 1; r < rows.length; r++) {
      if (rows[r][0] !== email) continue;
      const st = rows[r][2];
      if (st === 'approved') return ['Already approved', 'Open Deal Wire and log in with the 6-digit code sent to this address.'];
      if (st !== 'error') return done;                                       // awaiting, declined or revoked: no new mail
      const t = Utilities.getUuid();                                         // a failed approval is asked again
      sh.getRange(r + 1, 2, 1, 5).setValues([[note, 'awaiting_owner', t, now, '']]);
      askOwner_(email, t, note);
      return done;
    }
    const n = Number(props.getProperty(dayKey) || 0);
    if (n >= CONFIG.ACCESS_REQUESTS_PER_DAY) return ['Please try tomorrow', 'Too many requests today.'];
    props.setProperty(dayKey, String(n + 1));
    const token = Utilities.getUuid();
    sh.appendRow([email, note, 'awaiting_owner', token, now, '']);
    askOwner_(email, token, note);
    return done;
  } finally { lock.releaseLock(); }
}

/* ---------------- owner approval ---------------- */

// A secret only this script knows; the owner links carry a signature made with it.
function ownerKey_() {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('OWNER_KEY');
  if (!k) { k = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('OWNER_KEY', k); }
  return k;
}
function ownerSig_(action, id) {
  return Utilities.computeHmacSha256Signature('owner:' + action + ':' + id, ownerKey_())
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function ownerLink_(action, id) {
  return ScriptApp.getService().getUrl() + '?action=' + action + '&id=' + encodeURIComponent(id) + '&k=' + ownerSig_(action, id);
}
function mailOwner_(subject, body) {
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: subject, name: CONFIG.SENDER_NAME, body: body });
}

// Mails the owner an Approve / Decline pair for one request (capped per day against floods).
function askOwner_(email, token, note) {
  const props = PropertiesService.getScriptProperties();
  const key = 'APPROVAL_' + Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  const n = Number(props.getProperty(key) || 0);
  if (n >= CONFIG.APPROVAL_MAX_PER_DAY) return false;
  props.setProperty(key, String(n + 1));
  const owner = Session.getEffectiveUser().getEmail();
  const yes = ownerLink_('approve', token), no = ownerLink_('decline', token);
  const html = shell_(
    '<p style="margin:0 0 8px;font:15px/1.55 Arial,sans-serif;color:#1b1f24"><b>' + esc_(email) + '</b> asked for access to Deal Wire.</p>' +
    (note ? '<p style="margin:0 0 16px;font:14px/1.55 Arial,sans-serif;color:#374151">Note: ' + esc_(note) + '</p>' : '') +
    button_(yes, 'Approve') + '&nbsp;&nbsp;' + button_(no, 'Decline') +
    '<p style="margin:18px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280">These links work for you only; each opens a page where you press the button. Approving adds the address to "Approved readers" in Cloudflare Access, so they can open the site and subscribe to the email digest.</p>', '');
  MailApp.sendEmail({ to: owner, subject: 'Deal Wire · access for ' + email + '?', name: CONFIG.SENDER_NAME, htmlBody: html,
    body: email + ' asked for access to Deal Wire.' + (note ? '\nNote: ' + note : '') + '\nApprove: ' + yes + '\nDecline: ' + no + '\n' });
  return true;
}

// What the link in the owner email opens: a question with two buttons. Nothing changes until a button
// is pressed, so a mail scanner that opens the link cannot approve anyone. Each button posts its own
// signed id (approve and decline have different signatures) back to doPost.
function ownerConfirmPage_(id, k) {
  const bad = ['Link not valid', 'This link is not valid or was already used.'];
  if (!id) return page_(bad);
  const okSig = String(k) === ownerSig_('approve', String(id)) || String(k) === ownerSig_('decline', String(id));
  if (!okSig) return page_(bad);
  const rows = accessTab_().getDataRange().getValues();
  let email = '', note = '';
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][3] === id && (rows[r][2] === 'awaiting_owner' || rows[r][2] === 'error')) { email = rows[r][0]; note = rows[r][1]; break; }
  }
  if (!email) return page_(['Already handled', 'This request was already approved or declined.']);
  const url = ScriptApp.getService().getUrl();
  function form(action, label, color) {
    return '<form method="post" action="' + esc_(url) + '" target="_top" style="display:inline-block;margin:0 10px 0 0">' +
      '<input type="hidden" name="action" value="' + action + '"><input type="hidden" name="id" value="' + esc_(id) + '">' +
      '<input type="hidden" name="k" value="' + ownerSig_(action, String(id)) + '">' +
      '<button type="submit" style="background:' + color + ';color:#000;border:0;border-radius:3px;font:bold 13px Arial,sans-serif;letter-spacing:.06em;padding:12px 18px;cursor:pointer">' + label + '</button></form>';
  }
  return HtmlService.createHtmlOutput(
    pageHead_('Let this person in?', '<b>' + esc_(email) + '</b> asked for access to Deal Wire.' + (note ? ' Note: ' + esc_(note) : '') +
      ' Approving adds the address to "Approved readers" in Cloudflare Access.') +
    form('approve', 'APPROVE', '#ffbf3c') + form('decline', 'DECLINE', '#e5e7eb') + '</div>').setTitle('Deal Wire');
}

// Checks the signed owner request (from the confirmation page) and applies it.
function ownerDecision_(action, id, k) {
  const bad = ['Link not valid', 'This link is not valid or was already used.'];
  if (!id || !k || String(k) !== ownerSig_(action, String(id))) return bad;
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = accessTab_(), rows = sh.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++) {
      if (rows[r][3] !== id) continue;
      if (rows[r][2] !== 'awaiting_owner' && rows[r][2] !== 'error') return bad;
      const email = rows[r][0];
      if (action === 'decline') {
        sh.getRange(r + 1, 3).setValue('declined'); sh.getRange(r + 1, 6).setValue(new Date());
        return ['Declined', email + ' was not let in.'];
      }
      try { addReader_(email); } catch (e) {
        sh.getRange(r + 1, 3).setValue('error');
        const why = String(e && e.message != null ? e.message : e);
        try { mailOwner_('Deal Wire · could not add ' + email, 'Adding ' + email + ' to "' + CONFIG.POLICY_NAME + '" failed:\n' + why + '\n\nFix the cause (script properties CF_API_TOKEN / CF_ACCOUNT_ID, policy name) and press the Approve link again, or run approveReader("' + email + '") in the editor.'); } catch (m) { /* mail quota */ }
        return ['Could not add the address', why.slice(0, 300)];
      }
      sh.getRange(r + 1, 3, 1, 2).setValues([['approved', Utilities.getUuid()]]);   // a new token: the link cannot be reused
      sh.getRange(r + 1, 6).setValue(new Date());
      welcome_(email);
      return ['Approved', email + ' was added to "' + CONFIG.POLICY_NAME + '" and has been told.'];
    }
    return bad;
  } finally { lock.releaseLock(); }
}

function welcome_(email) {
  const url = CONFIG.SITE_URL;
  const html = shell_(
    '<p style="margin:0 0 16px;font:15px/1.55 Arial,sans-serif;color:#1b1f24">You are approved. Open Deal Wire and enter the address <b>' + esc_(email) + '</b>; a 6-digit code is emailed to you and lets you in.</p>' +
    button_(url, 'Open Deal Wire') +
    '<p style="margin:18px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280">To get each edition by email, use the email form inside the site (the envelope button).</p>', '');
  MailApp.sendEmail({ to: email, subject: 'Deal Wire access approved', name: CONFIG.SENDER_NAME, htmlBody: html,
    body: 'You are approved. Open ' + url + ' and log in with the 6-digit code that is emailed to this address.\nTo get each edition by email, use the email form inside the site.' });
}

// Run from the editor: lets an address in without a request (adds it to Approved readers and tells them).
function approveReader(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { Logger.log('Not an email address: ' + email); return; }
  const added = addReader_(email);
  const sh = accessTab_(), rows = sh.getDataRange().getValues();
  let r = 1;
  while (r < rows.length && rows[r][0] !== email) r++;
  const row = [email, r < rows.length ? rows[r][1] : 'added by the owner', 'approved', Utilities.getUuid(), r < rows.length ? rows[r][4] : new Date(), new Date()];
  if (r < rows.length) sh.getRange(r + 1, 1, 1, 6).setValues([row]); else sh.appendRow(row);
  if (added) welcome_(email);
  Logger.log(added ? 'Added ' + email + ' to ' + CONFIG.POLICY_NAME + ' and sent the welcome email' : email + ' was already in ' + CONFIG.POLICY_NAME);
}

// Run from the editor: takes an address out of Approved readers and pauses their email.
function revokeReader(email) {
  email = String(email || '').trim().toLowerCase();
  const removed = removeReader_(email);
  const sh = sheet_(), rows = sheet_().getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) if (rows[r][0] === email && rows[r][1] !== 'unsubscribed') sh.getRange(r + 1, 2).setValue('paused');
  const at = accessTab_(), ar = at.getDataRange().getValues();
  for (let r = 1; r < ar.length; r++) if (ar[r][0] === email) { at.getRange(r + 1, 3).setValue('revoked'); at.getRange(r + 1, 6).setValue(new Date()); }
  Logger.log((removed ? 'Removed ' : 'Was not in the policy: ') + email + '; email subscription paused');
}

// Run once from the editor: everyone subscribed before approval existed goes to "paused" (no mail).
function pauseExistingSubscribers() {
  const sh = sheet_(), rows = sh.getDataRange().getValues();
  let n = 0;
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][1] === 'active' || rows[r][1] === 'pending') { sh.getRange(r + 1, 2).setValue('paused'); n++; }
  }
  Logger.log('Paused ' + n + ' subscribers');
}

// Run from the editor to let a paused address back into the email list: approveExisting('name@example.com').
// It must already be in Approved readers (approveReader does that). They get the confirmation email and the
// digest resumes when they press it.
function approveExisting(email) {
  email = String(email || '').trim().toLowerCase();
  if (getReaders_(true).indexOf(email) < 0) { Logger.log(email + ' is not in Approved readers: run approveReader first'); return; }
  const sh = sheet_(), rows = sh.getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][0] !== email) continue;
    const token = Utilities.getUuid();
    sh.getRange(r + 1, 2, 1, 3).setValues([['pending', token, new Date()]]);
    sendConfirm_(email, token);
    Logger.log('Sent the confirmation email to ' + email);
    return;
  }
  Logger.log('Not on the subscriber list: ' + email);
}

// Run from the editor: for every paused address, the owner gets an access Approve / Decline email
// (an address that is already an approved reader just gets its confirmation email).
function requestApprovalForPaused() {
  const sh = sheet_(), rows = sh.getDataRange().getValues(), readers = getReaders_(true);
  let asked = 0, confirmed = 0;
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][1] !== 'paused') continue;
    const email = rows[r][0];
    if (readers.indexOf(email) >= 0) { approveExisting(email); confirmed++; continue; }
    const at = accessTab_(), ar = at.getDataRange().getValues(), token = Utilities.getUuid();
    let i = 1;
    while (i < ar.length && ar[i][0] !== email) i++;
    if (i < ar.length) at.getRange(i + 1, 2, 1, 5).setValues([['existing subscriber', 'awaiting_owner', token, new Date(), '']]);
    else at.appendRow([email, 'existing subscriber', 'awaiting_owner', token, new Date(), '']);
    if (askOwner_(email, token, 'existing subscriber')) asked++;
  }
  Logger.log('Approval emails to the owner: ' + asked + '; confirmation emails: ' + confirmed);
}

function setStatusByToken_(token, status) {
  if (!token) return false;
  const sh = sheet_(), rows = sh.getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][2] !== token) continue;
    if (status === 'active' && rows[r][1] === 'unsubscribed') return false;
    sh.getRange(r + 1, 2).setValue(status);
    sh.getRange(r + 1, status === 'active' ? 5 : 6).setValue(new Date());
    return true;
  }
  return false;
}

/* ---------------- sending ---------------- */

function sendNewEdition() {
  try { sendNewEdition_(); } catch (e) {
    if (!transient_(e)) throw e;
    console.warn('sendNewEdition: transient error, will retry next run: ' + e.message);
  }
}
function sendNewEdition_() {
  const props = PropertiesService.getScriptProperties();
  const idx = fetchJson_(CONFIG.DATA_URL + 'index.json');
  if (!idx || !idx.editions || !idx.editions.length) return;
  const newest = idx.editions[0];
  if (newest.id === props.getProperty('LAST_SENT')) return;
  if (Date.now() - Date.parse(newest.generated_at) > CONFIG.MAX_EDITION_AGE_HOURS * 3600e3) {
    props.setProperty('LAST_SENT', newest.id);   // too old to be "news"; skip it but do not retry forever
    return;
  }
  const ed = fetchJson_(CONFIG.DATA_URL + newest.id + '.json');
  if (!ed || !ed.items || !ed.items.length) return;
  // Who is still an approved reader right now. If Cloudflare cannot be asked, send nothing and try next run
  // (cf_ words passing failures with "try again", which sendNewEdition treats as transient).
  const readers = getReaders_(true);
  // Claim the edition before sending so an overlapping trigger run cannot send it twice.
  props.setProperty('LAST_SENT', newest.id);

  const subs = sheet_().getDataRange().getValues().slice(1).filter(r => r[1] === 'active' && readers.indexOf(String(r[0]).toLowerCase()) >= 0);
  const subject = 'Deal Wire · ' + editionLabel_(newest.id) + ' · ' + ed.items[0].headline;
  let sent = 0;
  subs.forEach(r => {
    if (MailApp.getRemainingDailyQuota() < 1) return;
    const unsub = ScriptApp.getService().getUrl() + '?action=unsubscribe&t=' + encodeURIComponent(r[2]);
    MailApp.sendEmail({ to: r[0], subject: subject, name: CONFIG.SENDER_NAME, htmlBody: renderEmail_(newest.id, ed, unsub), body: renderText_(newest.id, ed, unsub) });
    sent++;
  });
  Logger.log('Sent ' + newest.id + ' to ' + sent + ' of ' + subs.length + ' subscribers');
}

function sendConfirm_(email, token) {
  const url = ScriptApp.getService().getUrl() + '?action=confirm&t=' + encodeURIComponent(token);
  const html = shell_(
    '<p style="margin:0 0 16px;font:15px/1.55 Arial,sans-serif;color:#1b1f24">Confirm that you want the Deal Wire digest by email at 08:30, 12:30 and 15:30 SGT.</p>' +
    button_(url, 'Confirm subscription') +
    '<p style="margin:18px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280">If you did not sign up, ignore this email and nothing will be sent.</p>', '');
  MailApp.sendEmail({ to: email, subject: 'Confirm your Deal Wire subscription', name: CONFIG.SENDER_NAME, htmlBody: html,
    body: 'Confirm your Deal Wire subscription: ' + url + '\n\nIf you did not sign up, ignore this email.' });
}

/* ---------------- email rendering ---------------- */

function permalink_(eid, i) { return CONFIG.SITE_URL + '?e=' + encodeURIComponent(eid) + (i == null ? '' : '&i=' + i); }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function editionLabel_(eid) {
  const d = new Date(eid.slice(0, 10) + 'T00:00:00Z');
  return Utilities.formatDate(d, 'UTC', 'd MMM') + ' ' + eid.slice(11, 13) + ':' + eid.slice(13, 15) + ' SGT';
}
function button_(url, label) {
  return '<a href="' + esc_(url) + '" style="display:inline-block;background:#ffbf3c;color:#000;text-decoration:none;font:bold 12px/1 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:10px 14px;border-radius:3px">' + esc_(label) + '</a>';
}
function shell_(inner, footer) {
  return '<div style="background:#eef0f3;padding:24px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-collapse:collapse">' +
    '<tr><td style="background:#07090b;padding:18px 24px"><span style="display:inline-block;width:10px;height:10px;background:#ffbf3c;margin-right:10px"></span>' +
    '<span style="font:bold 18px/1 Consolas,Menlo,monospace;letter-spacing:.14em;color:#ffbf3c">DEAL WIRE</span>' +
    '<span style="font:11px/1 Consolas,Menlo,monospace;letter-spacing:.1em;color:#8a929c;margin-left:10px">US · SEA · SG · JP · HK/CN</span></td></tr>' +
    '<tr><td style="padding:22px 24px">' + inner + '</td></tr>' +
    (footer ? '<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font:12px/1.6 Arial,sans-serif;color:#6b7280">' + footer + '</td></tr>' : '') +
    '</table></div>';
}
function renderEmail_(eid, ed, unsub) {
  let html = '<p style="margin:0 0 4px;font:bold 11px/1 Consolas,Menlo,monospace;letter-spacing:.14em;color:#9a6b00;text-transform:uppercase">Digest · ' + esc_(editionLabel_(eid)) + ' · ' + esc_(ed.reading_minutes || 5) + ' min read</p>';
  ed.items.forEach(function (x, i) {
    const badge = x.status === 'update' ? '<span style="display:inline-block;background:#0b6e4f;color:#fff;font:bold 10px/1 Arial,sans-serif;letter-spacing:.1em;padding:3px 6px;border-radius:2px;margin-right:6px;vertical-align:2px">UPDATE</span>' : '';
    const sources = (x.links || []).map(function (l) { return '<a href="' + esc_(l.url) + '" style="color:#6b7280">' + esc_(l.source) + '</a>'; }).join(' · ');
    const prev = x.prev && x.prev.edition ? ' · <a href="' + esc_(permalink_(x.prev.edition, x.prev.index)) + '" style="color:#6b7280">earlier coverage</a>' : '';
    html += '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e5e7eb;margin-top:16px"><tr>' +
      '<td valign="top" style="width:40px;padding-top:16px;font:bold 20px/1 Consolas,Menlo,monospace;color:#c98a00">' + ('0' + (i + 1)).slice(-2) + '</td>' +
      '<td style="padding-top:14px">' +
      '<p style="margin:0 0 6px;font:bold 17px/1.35 Arial,sans-serif;color:#111">' + badge + '<a href="' + esc_(permalink_(eid, i)) + '" style="color:#111;text-decoration:none">' + esc_(x.headline) + '</a></p>' +
      '<p style="margin:0 0 8px;font:14px/1.55 Arial,sans-serif;color:#374151">' + esc_(x.summary) + '</p>' +
      '<p style="margin:0 0 10px;font:14px/1.55 Arial,sans-serif;color:#111"><b style="font:bold 10px/1 Arial,sans-serif;letter-spacing:.12em;color:#9a6b00;text-transform:uppercase">Why it matters</b> ' + esc_(x.why_it_matters) + '</p>' +
      button_(permalink_(eid, i), 'Open on Deal Wire →') +
      '<p style="margin:8px 0 0;font:11px/1.5 Arial,sans-serif;color:#6b7280">' + sources + prev + '</p>' +
      '</td></tr></table>';
  });
  const footer = '<a href="' + esc_(CONFIG.SITE_URL) + '" style="color:#374151">Open Deal Wire</a> · ' +
    '<a href="' + esc_(CONFIG.SITE_URL + '?view=archive') + '" style="color:#374151">All past digests</a> · ' +
    '<a href="' + esc_(unsub) + '" style="color:#6b7280">Unsubscribe</a><br>Headlines and links come from public sources; summaries are machine-written from them.';
  return shell_(html, footer);
}
function renderText_(eid, ed, unsub) {
  let t = 'DEAL WIRE · ' + editionLabel_(eid) + '\n\n';
  ed.items.forEach(function (x, i) {
    t += (i + 1) + '. ' + (x.status === 'update' ? '[UPDATE] ' : '') + x.headline + '\n' + x.summary + '\nWhy it matters: ' + x.why_it_matters + '\nOpen: ' + permalink_(eid, i) + '\n\n';
  });
  return t + 'All past digests: ' + CONFIG.SITE_URL + '?view=archive\nUnsubscribe: ' + unsub + '\n';
}

/* ---------------- helpers ---------------- */

// Google now and then fails a call with a passing error ("We're sorry, a server error occurred.
// Please wait a bit and try again."). Time triggers treat these as "try next run" instead of
// failing, so no "Summary of failures" email goes out for something that fixes itself.
function transient_(e) {
  if (/^kickFetch: GitHub returned/.test(String(e && e.message))) return false;   // our own token error, never transient
  return /server error occurred|try again|timed out|timeout|Service unavailable|Address unavailable|Bandwidth quota exceeded/i
    .test(String(e && e.message != null ? e.message : e));
}

function sheet_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName(CONFIG.SHEET_NAME);
}
function fetchJson_(url) {
  const res = UrlFetchApp.fetch(url + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText());
}
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function page_(tm) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">' +
    '<p style="font:bold 14px Consolas,monospace;letter-spacing:.14em;color:#c98a00">DEAL WIRE</p>' +
    '<h1 style="font-size:22px">' + esc_(tm[0]) + '</h1><p style="color:#374151">' + esc_(tm[1]) + '</p>' +
    '<p><a href="' + esc_(CONFIG.SITE_URL) + '">Open Deal Wire →</a></p></div>').setTitle('Deal Wire');
}
