/**
 * Deal Wire mailer — Google Apps Script web app.
 *
 * Holds the subscriber list in a private Google Sheet (never in the public repo) and emails each new
 * digest edition to confirmed subscribers.
 *   doPost  action=subscribe     -> adds the address as "pending" and sends a confirmation email
 *   doPost  action=contact       -> emails the site owner what a reader typed in the Contact box
 *   doPost  action=sync          -> stores one browser's followed stories and companies
 *   doGet   action=follows       -> every followed story, no viewer ids (read by the fetch job)
 *   doGet   action=companies     -> one browser's companies with their latest headlines (private)
 *   doGet   action=confirm       -> marks the address "active"
 *   doGet   action=unsubscribe   -> marks the address "unsubscribed" (link in every email)
 *   sendNewEdition (time trigger, every 10 min) -> if a new edition exists on GitHub, email it once
 *   refreshCompanies (time trigger, every 30 min) -> Google News headlines for every followed company
 *   kickFetch (time trigger, every 30 min) -> asks GitHub to run fetch.yml (its own schedule runs late)
 *
 * Setup: paste this file into a new Apps Script project, run setup() once, then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). Put the /exec URL into MAIL_ENDPOINT in docs/app.js.
 */

const CONFIG = {
  SITE_URL: 'https://17yyamada-tech.github.io/dealwire_dailyupdate/',
  DATA_URL: 'https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/digests/',
  SHEET_NAME: 'Subscribers',
  SENDER_NAME: 'Deal Wire',
  MAX_EDITION_AGE_HOURS: 3,       // do not email an edition that is older than this (e.g. after downtime)
  CONTACT_MAX_CHARS: 4000,
  CONTACT_MAX_PER_DAY: 40,        // a cap so a bot cannot burn the Gmail quota
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
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendNewEdition').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendNewEdition').timeBased().everyMinutes(10).create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'refreshCompanies').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshCompanies').timeBased().everyMinutes(30).create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kickFetch').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kickFetch').timeBased().everyMinutes(30).create();
  viewersTab_(); newsTab_();
  // Mark the current newest edition as already sent so setup does not email an old digest.
  const idx = fetchJson_(CONFIG.DATA_URL + 'index.json');
  if (idx && idx.editions && idx.editions[0]) props.setProperty('LAST_SENT', idx.editions[0].id);
  Logger.log('Subscribers sheet: https://docs.google.com/spreadsheets/d/' + id);
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

// A company is {name, keywords}. The name field may hold several names separated by commas
// ("Toyota, トヨタ自動車"); the first is the one shown.
function cleanCompanies_(raw) {
  return parseList_(raw).slice(0, FOLLOW.MAX_COMPANIES_PER_VIEWER).map(function (x) {
    const names = String(x.name || '').split(/[,、]/).map(function (s) { return clip_(s, 60); }).filter(String).slice(0, 4);
    const keywords = (Array.isArray(x.keywords) ? x.keywords : []).map(function (s) { return clip_(s, 40); }).filter(String).slice(0, 8);
    return { names: names, keywords: keywords };
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
    const stored = companies.map(function (c) { return { name: c.names.join(', '), keywords: c.keywords }; });
    const row = [vid, JSON.stringify(follows), JSON.stringify(stored), now];
    let r = 1;
    while (r < rows.length && rows[r][0] !== vid) r++;
    if (r < rows.length) sh.getRange(r + 1, 1, 1, 4).setValues([row]); else sh.appendRow(row);
  } finally { lock.releaseLock(); }
  // A company added just now gets its first headlines at once instead of at the next refresh.
  const tab = newsTab_(), known = {};
  tab.getDataRange().getValues().slice(1).forEach(function (r) { known[r[0]] = true; });
  companies.filter(function (c) { return !known[companyKey_(c)]; }).slice(0, 3)
    .forEach(function (c) { refreshCompany_(tab, c); });
  return 'ok';
}

function activeViewers_() {
  const cutoff = Date.now() - FOLLOW.ACTIVE_DAYS * 864e5;
  return viewersTab_().getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0] && new Date(r[3]).getTime() >= cutoff; });
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
  const news = {};
  newsTab_().getDataRange().getValues().slice(1).forEach(function (r) {
    news[r[0]] = { names: parseList_(r[1]), news: parseList_(r[3]), updated: r[4] ? new Date(r[4]).toISOString() : '' };
  });
  return {
    companies: (mine ? cleanCompanies_(mine[2]) : []).map(function (c) {
      const n = news[companyKey_(c)] || { names: c.names, news: [], updated: '' };
      return { name: c.names.join(', '), keywords: c.keywords, searched: n.names, news: n.news, updated: n.updated };
    }),
  };
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
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('No GITHUB_TOKEN script property: nothing to do'); return; }
  const res = UrlFetchApp.fetch(GITHUB_FETCH_WORKFLOW, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ ref: 'main' }), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const code = res.getResponseCode();
  Logger.log(code === 204 ? 'fetch.yml started' : 'fetch.yml did not start: ' + code + ' ' + res.getContentText().slice(0, 200));
}

/* ---------------- web endpoints ---------------- */

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'subscribe') return text_(subscribe_(String(p.email || '').trim().toLowerCase()));
  if (p.action === 'contact') return text_(contact_(p));
  if (p.action === 'sync') return text_(sync_(p));
  return text_('unknown action');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'follows') return json_(follows_(), p.callback);
  if (p.action === 'companies') return json_(companiesFor_(p.vid), p.callback);
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
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = sheet_(), rows = sh.getDataRange().getValues();
    const now = new Date();
    for (let r = 1; r < rows.length; r++) {
      if (rows[r][0] !== email) continue;
      if (rows[r][1] === 'active') return 'already subscribed';
      // re-send the confirmation at most every 10 minutes to stop the form being used to spam an inbox
      if (rows[r][1] === 'pending' && now - new Date(rows[r][3]) < 10 * 60 * 1000) return 'confirmation already sent';
      const token = Utilities.getUuid();
      sh.getRange(r + 1, 2, 1, 3).setValues([['pending', token, now]]);
      sendConfirm_(email, token);
      return 'confirmation sent';
    }
    const token = Utilities.getUuid();
    sh.appendRow([email, 'pending', token, now, '', '']);
    sendConfirm_(email, token);
    return 'confirmation sent';
  } finally { lock.releaseLock(); }
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
  // Claim the edition before sending so an overlapping trigger run cannot send it twice.
  props.setProperty('LAST_SENT', newest.id);

  const subs = sheet_().getDataRange().getValues().slice(1).filter(r => r[1] === 'active');
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
