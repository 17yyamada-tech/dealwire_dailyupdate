/**
 * Deal Wire mailer — Google Apps Script web app.
 *
 * Holds the subscriber list in a private Google Sheet (never in the public repo) and emails each new
 * digest edition to confirmed subscribers.
 *   doPost  action=subscribe     -> adds the address as "pending" and sends a confirmation email
 *   doPost  action=contact       -> emails the site owner what a reader typed in the Contact box
 *   doGet   action=confirm       -> marks the address "active"
 *   doGet   action=unsubscribe   -> marks the address "unsubscribed" (link in every email)
 *   sendNewEdition (time trigger, every 10 min) -> if a new edition exists on GitHub, email it once
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

/* ---------------- web endpoints ---------------- */

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'subscribe') return text_(subscribe_(String(p.email || '').trim().toLowerCase()));
  if (p.action === 'contact') return text_(contact_(p));
  return text_('unknown action');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
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
    '<span style="font:11px/1 Consolas,Menlo,monospace;letter-spacing:.1em;color:#8a929c;margin-left:10px">US · SEA · SG · HK/CN</span></td></tr>' +
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
