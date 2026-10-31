/* Deal Wire front end — static, no build step.
 * Data:     data/latest.json (7 days), data/archive/YYYY-MM.json (search), data/digests/ (3 editions a day, written by the Routine).
 * Learning: per viewer. Each browser logs its own opens/saves/hides to localStorage (nothing leaves the browser);
 *           once per day the profile (weights per category / region / sector / source / keyword) is recomputed
 *           and used to rank Top stories and to reorder the digest for that viewer.
 * Look:     markup is skin-neutral; everything visual is in skins/<name>.css (see SKINS).
 * Digest:   three editions a day (data/digests/<YYYY-MM-DD-HHMM>.json + index.json). Every item has a permanent
 *           link ?e=<edition>&i=<index> so links in past emails always open the right story.
 * Email:    sign-up posts to a Google Apps Script web app (MAIL_ENDPOINT); addresses never touch this repo.
 */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem("dw." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("dw." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  // Google Apps Script web app that stores subscribers and sends the emails (apps_script/Code.gs). Empty = feature hidden.
  const MAIL_ENDPOINT = "https://script.google.com/macros/s/AKfycbwkLZNyFOe8UkUWMeIw-8PDnhCLW9DsDW_llufj2kGfZwWMaAw7HSTsIHoSmvpjU6DqTw/exec";
  const ASSET_V = "20261031-2100";   // same stamp as the ?v= on base.css and app.js in index.html
  const SKINS = { board: "Departure board", navy: "Navy glass", "navy-classic": "Navy classic", editorial: "Editorial" };
  const SECTORS = ["AI & Semis", "TMT", "Financials", "Real Estate", "Energy", "Healthcare", "Consumer", "Industrials", "Infrastructure", "Materials", "Public / Macro"];
  const FOCUS = ["Sponsor", "Strategic"];   // who is on the deal; narrows the deal board only
  const REGION_ORDER = ["SG", "JP", "HK/CN", "SEA", "US"];   // SG items also carry SEA; show the most specific first
  const CJK = "\\u3040-\\u30ff\\u4e00-\\u9fff\\uff66-\\uff9f";
  const TYPE_ORDER = ["M&A", "PE", "Credit", "Infra"];
  const STOP = new Set("the a an and or of to in on for with by at from as is are be its it this that after over into new says said will than more up amid us uk sg".split(" "));
  const DEALS_PAGE = 14;
  const REFRESH_MS = 5 * 60 * 1000;
  const HALF_LIFE_H = 18;
  const PROFILE_WINDOW_DAYS = 45;
  const DAILY_DECAY = 0.94;

  const state = {
    items: [], updated: null, editions: [], edition: null, editionCache: new Map(), pinned: null, lastRanked: [],
    filters: normFilters(store.get("filters", null)),
    dealsShown: DEALS_PAGE, view: "home",
    seenDeals: new Set(store.get("seenDeals", [])), firstLoad: true,
    archive: new Map(), archiveMonths: [], filings: [],
    dealsToday: store.get('dealsToday', false) === true,
    dealsAll: store.get('dealsAll', false) === true,
    dealsInterest: store.get('dealsInterest', false) === true,
    lang: store.get("lang", "en") === "ja" ? "ja" : "en",
  };

  /* ---------------- language ----------------
     Only the digest's own writing switches: the summary and the "why it matters" line, which
     the editor writes in both languages. Headlines stay as published, in English for the
     digest and in their own language in the feed, because a headline we did not write is not
     ours to translate. The rest of the page stays in English. */
  function applyLang(lang) {
    state.lang = lang === "ja" ? "ja" : "en";
    store.set("lang", state.lang);
    const btn = $("#btn-lang");
    btn.textContent = state.lang === "ja" ? "EN" : "JP";
    btn.title = btn.ariaLabel = state.lang === "ja"
      ? "English: digest summaries in English, stories written in Japanese hidden"
      : "日本語: 日本語の記事も表示し、ダイジェストの要約を日本語で読む";
    btn.classList.toggle("on", state.lang === "ja");
  }
  // Editions published before the editor wrote Japanese keep only the English text.
  const dtext = (x, field) => (state.lang === "ja" && x[field + "_ja"]) || x[field] || "";
  function normFilters(f) {
    const ok = { category: TYPE_ORDER, country: REGION_ORDER };
    f = f || {};
    return {
      category: (f.category || []).filter(x => ok.category.includes(x)),
      country: (f.country || []).filter(x => ok.country.includes(x)),
      sector: SECTORS.includes(f.sector) ? f.sector : "",
      focus: FOCUS.includes(f.focus) ? f.focus : "",
    };
  }

  /* ---------------- skin ---------------- */
  function applySkin(name) {
    if (!SKINS[name]) name = document.documentElement.dataset.skin in SKINS ? document.documentElement.dataset.skin : "board";
    document.documentElement.dataset.skin = name;
    $("#skin-css").href = `skins/${name}.css?v=${ASSET_V}`;
  }

  /* ---------------- learning ---------------- */
  const events = () => store.get("events", []);
  function logEvent(kind, it) {
    const ev = events();
    ev.push({ k: kind, t: Date.now(), id: it.id, c: it.categories, n: it.countries, s: it.sectors, src: it.source_id, kw: keywords(it.title) });
    const cutoff = Date.now() - PROFILE_WINDOW_DAYS * 864e5;
    store.set("events", ev.filter(e => e.t >= cutoff).slice(-3000));
  }
  // words that carry no signal about what a reader likes, so they never become a keyword
  const JA_STOP = new Set(["買収", "取得", "株式", "会社", "企業", "発表", "検討", "完了", "予定", "実施",
    "投資", "事業", "経営", "提案", "報道", "計画", "方針", "可能", "影響", "関する", "について"]);
  function keywords(title) {
    // proper nouns / tickers are the most predictive of what gets opened again
    const latin = (title.match(/\b[A-Z][A-Za-z0-9&'.-]{2,}\b/g) || [])
      .map(w => w.replace(/['.]+$/, "").toLowerCase());
    // Japanese headlines carry their names as katakana runs and kanji compounds instead
    const kana = title.match(/[ァ-ヶー]{3,}/g) || [];
    const kanji = title.match(/[一-鿿]{2,5}/g) || [];
    return [...new Set([...latin, ...kana, ...kanji])]
      .filter(w => !STOP.has(w) && !JA_STOP.has(w)).slice(0, 8);
  }
  const KIND_W = { open: 1, save: 2.5, hide: -2 };
  function buildProfile() {
    const w = {}, now = Date.now();
    for (const e of events()) {
      const age = Math.floor((now - e.t) / 864e5);
      const v = (KIND_W[e.k] || 0) * Math.pow(DAILY_DECAY, age);
      const add = (key) => { w[key] = (w[key] || 0) + v; };
      (e.c || []).forEach(x => add("cat:" + x));
      (e.n || []).forEach(x => add("cty:" + x));
      (e.s || []).filter(x => x !== "Other").forEach(x => add("sec:" + x));
      if (e.src) add("src:" + e.src);
      (e.kw || []).forEach(x => add("kw:" + x));
    }
    const max = Math.max(1, ...Object.values(w).map(Math.abs));
    const top = Object.entries(w).map(([k, v]) => [k, +(v / max).toFixed(3)])
      .filter(([, v]) => Math.abs(v) >= 0.05).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 120);
    return { date: todaySG(), events: events().length, weights: Object.fromEntries(top) };
  }
  function todaySG() { return new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10); }
  // The ranking profile is rebuilt once a day (first visit after midnight SGT).
  function activeProfile() {
    let p = store.get("profile", null);
    if (!p || p.date !== todaySG()) { p = buildProfile(); store.set("profile", p); }
    return p;
  }

  /* ---------------- ranking ---------------- */
  function affinity(it, prof, reasons) {
    const W = prof.weights || {};
    let a = 0;
    const take = (key, label, mult = 1) => { const v = (W[key] || 0) * mult; if (v) { a += v; if (reasons && v > 0.25) reasons.push(label); } };
    (it.categories || []).forEach(c => take("cat:" + c, c));
    (it.countries || []).forEach(c => take("cty:" + c, c, 0.6));
    (it.sectors || []).forEach(s => take("sec:" + s, s, 0.6));
    if (it.source_id) take("src:" + it.source_id, it.source, 0.4);
    keywords(it.title || "").forEach(k => take("kw:" + k, k, 0.8));
    return Math.max(-0.9, Math.min(a, 2.5));
  }
  function score(it, prof, read, hidden) {
    if (hidden[it.id]) return { s: -1, reasons: [] };
    const ageH = Math.max(0, (Date.now() - Date.parse(it.published)) / 36e5);
    const recency = Math.pow(0.5, ageH / HALF_LIFE_H);
    const reasons = [];
    const aff = affinity(it, prof, reasons);
    const base = 0.35 + (it.is_deal ? 0.35 : 0) + (it.has_amount ? 0.15 : 0) + (it.categories.length ? 0.1 : 0);
    let s = recency * (base + aff);
    if (read[it.id]) s *= 0.55;
    return { s, reasons: [...new Set(reasons)].slice(0, 2) };
  }

  // The same story from several outlets: keep the first/best one and note the others.
  const tokenSet = (t) => {
    const s = t.toLowerCase().replace(/us\$|s\$|\$/g, "");
    const out = new Set(s.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
    // Japanese has no spaces, so splitting on non-letters returns nothing and two reports of
    // the same deal never match. Character pairs stand in for words here.
    (s.match(new RegExp("[" + CJK + "]{2,}", "g")) || []).forEach(run => {
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    });
    return out;
  };
  function similar(a, b) { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / Math.min(a.size, b.size || 1); }
  function collapseDupes(list) {
    const kept = [];
    for (const x of list) {
      const ts = tokenSet(x.it.title);
      const dup = ts.size >= 4 && kept.find(k => similar(ts, k.ts) >= 0.7);
      if (dup) { dup.also.add(x.it.source); continue; }
      kept.push({ ...x, ts, also: new Set() });
    }
    return kept;
  }

  /* ---------------- filters ---------------- */
  // In English mode a story written in Japanese is left out everywhere (board, search, company
  // news). Followed stories stay: the reader chose them. Kana or kanji in the headline decides.
  const isJa = (it) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(it.title || "");
  function passes(it) {
    if (state.lang === "en" && isJa(it)) return false;
    const f = state.filters;
    if (f.category.length && !f.category.some(c => (it.categories || []).includes(c))) return false;
    if (f.country.length && !f.country.some(c => (it.countries || []).includes(c))) return false;
    if (f.sector && !(it.sectors || []).includes(f.sector)) return false;
    return true;
  }
  const anyFilter = () => state.filters.category.length || state.filters.country.length || state.filters.sector || state.filters.focus;
  function syncFilterUI() {
    $$(".chip-group").forEach(g => {
      const key = g.dataset.group, v = state.filters[key];
      $$(".chip", g).forEach(b => b.setAttribute("aria-pressed", Array.isArray(v) ? v.includes(b.dataset.v) : v === b.dataset.v));
    });
    $("#sector").value = state.filters.sector;
    $("#sector").classList.toggle("active", !!state.filters.sector);
    $("#clear").hidden = !anyFilter();
  }

  /* ---------------- formatting ---------------- */
  const fmtAgo = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < 1440) return Math.round(m / 60) + "h";
    return Math.round(m / 1440) + "d";
  };
  const sgParts = (iso) => {
    const d = new Date(Date.parse(iso) + 8 * 36e5);
    return { day: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), dm: d.getUTCDate() + " " + d.toLocaleString("en", { month: "short", timeZone: "UTC" }).toUpperCase() };
  };
  const boardTime = (iso) => { const p = sgParts(iso); return p.day === todaySG() ? p.hm : p.dm; };
  const fmtDate = (iso) => new Date(iso).toLocaleString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const regionsOf = (it) => {
    const c = it.countries || [];
    return REGION_ORDER.filter(x => c.includes(x) && !(x === "SEA" && c.includes("SG"))).slice(0, 2);
  };
  // SEA has no flag of its own, so it flies the ASEAN emblem; HK/CN shows both flags.
  const FLAGS = { US: ["us"], SEA: ["sea"], SG: ["sg"], JP: ["jp"], "HK/CN": ["hk", "cn"] };
  function flagNode(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "flag");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", "#flag-" + name);
    svg.append(use);
    return svg;
  }
  // Every type a story carries, in board order: a take-private by a fund is both M&A and PE.
  const typesOf = (it) => { const t = TYPE_ORDER.filter(x => (it.categories || []).includes(x)); return t.length ? t : [it.is_deal ? "Deal" : "News"]; };
  const typeClass = (t) => "t-" + t.toLowerCase().replace(/[^a-z]/g, "");

  /* ---------------- rows ---------------- */
  function rowNode(it, { reasons = [], also = null, q = null, compact = false, fresh = false } = {}) {
    const n = $("#row-tpl").content.firstElementChild.cloneNode(true);
    if (compact) n.classList.add("compact");
    if (fresh) n.classList.add("fresh");
    const time = $(".c-time", n);
    time.textContent = q ? sgParts(it.published).dm : boardTime(it.published);
    time.title = fmtDate(it.published) + " SGT";
    const reg = $(".c-reg", n);
    reg.textContent = "";
    const regions = regionsOf(it);
    // the most specific region only: its flag (two for HK/CN) and its code. A second region
    // would not fit beside the flags, so it lives in the tooltip instead.
    (FLAGS[regions[0]] || []).forEach(f => reg.append(flagNode(f)));
    reg.append(regions[0] || "—");
    reg.title = regions.join(" ") || "No region tagged";
    const tys = $(".c-types", n);
    typesOf(it).forEach(t => { const s = document.createElement("span"); s.className = "c-type " + typeClass(t); s.textContent = t; tys.append(s); });
    const a = $(".c-title", n); a.href = it.link; highlight(a, it.title, q);
    highlight($(".c-snip", n), compact ? "" : (it.snippet || ""), q);
    $(".src", n).textContent = it.source;
    $(".sponsor", n).textContent = it.actor === "Sponsor" ? "Sponsor" : "";
    $(".ago", n).textContent = fmtAgo(it.published) + " ago";
    const sec = (it.sectors || []).filter(s => s !== "Other")[0];
    $(".sector", n).textContent = sec || "";
    $(".why", n).textContent = reasons.length ? "for you: " + reasons.join(", ") : "";
    $(".also", n).textContent = also && also.size ? "also " + [...also].join(", ") : "";
    if (store.get("read", {})[it.id]) n.classList.add("read");
    const sb = $(".save", n);
    if (store.get("saved", {})[it.id]) { sb.classList.add("on"); sb.textContent = "★"; }
    const open = () => { markRead(it); n.classList.add("read"); };
    a.addEventListener("click", open);
    a.addEventListener("auxclick", open);
    sb.addEventListener("click", () => toggleSave(it, sb));
    $(".co", n).addEventListener("click", () => openCompanyDialog(it));
    $(".hide", n).addEventListener("click", () => { hide(it); n.remove(); });
    return n;
  }
  function highlight(el, text, q) {
    el.textContent = "";
    if (!q || !q.terms.length) { el.textContent = text; return; }
    const re = new RegExp("(" + q.terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
    let last = 0;
    text.replace(re, (m, _g, i) => {
      el.append(text.slice(last, i));
      const mk = document.createElement("mark"); mk.textContent = m; el.append(mk);
      last = i + m.length; return m;
    });
    el.append(text.slice(last));
  }
  function empty(msg) { const li = document.createElement("li"); li.className = "empty"; li.textContent = msg; return li; }

  /* ---------------- panels ---------------- */
  // The board draws itself; this is the ranking behind "By interest", and the order the
  // digest falls back to when no edition has been published yet.
  function rankedItems() {
    const prof = activeProfile(), read = store.get("read", {}), hidden = store.get("hidden", {});
    return collapseDupes(state.items.filter(passes).map(it => ({ it, ...score(it, prof, read, hidden) }))
      .filter(x => x.s >= 0).sort((a, b) => b.s - a.s));
  }

  function renderDeals() {
    const hidden = store.get("hidden", {});
    // Three ways to cut the same list. "Today only" is the counterpart of "Show all deals":
    // on a busy day the seven-day window buries this morning. "All stories" opens it up to
    // the market and macro pieces that are not deals. "By interest" reorders by what this
    // viewer reads, which is otherwise only visible in the digest.
    const today = todaySG();
    const collect = (onlyToday) => {
      const wanted = (it) => (state.dealsAll || it.is_deal) && passes(it) && !hidden[it.id]
        && (!onlyToday || sgParts(it.published).day === today)
        && (!state.filters.focus || it.actor === state.filters.focus);
      return state.dealsInterest
        ? rankedItems().filter(x => wanted(x.it))
        : collapseDupes(state.items.filter(wanted)
          .sort((a, b) => a.published.localeCompare(b.published)).map(it => ({ it })))   // oldest first: first report wins
          .reverse();
    };
    let deals = collect(state.dealsToday);
    // An empty board reads as a missing board (a quiet morning, or English mode on a day of
    // Japanese-only news): when today has nothing, fall back to the week and say so.
    const fellBack = state.dealsToday && !deals.length;
    if (fellBack) deals = collect(false);
    const ol = $("#deals"); ol.textContent = "";
    if (fellBack && deals.length) {
      const li = empty("Nothing reported yet today" + (state.lang === "en" ? " in English" : "") + ". Showing the last 7 days.");
      li.classList.add("fallback"); ol.append(li);
    }
    const limit = state.view === "deals" ? 200 : state.dealsShown;
    deals.slice(0, limit).forEach(x => {
      const isNew = !state.firstLoad && !state.seenDeals.has(x.it.id);
      ol.append(rowNode(x.it, { also: x.also, reasons: x.reasons || [], compact: true, fresh: isNew }));
    });
    if (!deals.length) ol.append(empty("Nothing matches these filters."));
    $("#deals-count").textContent = deals.length + (state.dealsToday && !fellBack ? " today" : " in 7 days");
    $("#deals-range").textContent = state.dealsToday ? "Last 7 days" : "Today only";
    $("#deals-scope").textContent = state.dealsAll ? "Deals only" : "All stories";
    $("#deals-order").textContent = state.dealsInterest ? "Newest first" : "By interest";
    [["deals-range", state.dealsToday], ["deals-scope", state.dealsAll], ["deals-order", state.dealsInterest]]
      .forEach(([id, on]) => $("#" + id).setAttribute("aria-pressed", on));
    $("#deals-more").hidden = deals.length <= limit;
    deals.forEach(d => state.seenDeals.add(d.it.id));
    store.set("seenDeals", [...state.seenDeals].slice(-3000));
    requestAnimationFrame(syncDigestHeight);   // the board's height is what the digest is capped to
  }

  /* ---------------- Japan filings ----------------
     EDINET says who is bidding for whom and when they filed, which the news coverage often
     leaves out. One row per case: a tender offer's documents (original, amendments, result) are
     one row, a 5% report is one row. The sentence on each row is built from the filed fields by a
     fixed template (no AI); nothing here is interpreted beyond what the filing says. */
  const FL_GLOSS = {
    tob: ["Tender offer", "A public offer to buy shares straight from shareholders at a set price within a set period (公開買付け, TOB)."],
    result: ["Offer result", "The bidder's report after the offer period closes: how many shares were tendered and bought."],
    proposal: ["Proposal intent", "The holder says it may make 'important proposals' to management, such as board changes, payouts or restructuring (重要提案行為等). Often an activist signal."],
    stake: ["Stake change", "A holder of more than 5% of a listed company reports its holding, and again when it moves by 1 point or more (大量保有報告書・変更報告書)."],
    joint: ["Joint holders", "The percentage is the group total, counting funds and affiliates that hold together (共同保有者)."],
    sponsor: ["Sponsor", "An investor already on this site's list of funds and corporate sponsors."],
    sought: ["Shares sought", "The number of shares the bidder offers to buy, with the stake that would give it."],
    floor: ["Minimum to succeed", "If fewer shares than this are tendered, the offer fails and nothing is bought (買付予定数の下限)."],
    settles: ["Payment date", "When the bidder pays for the shares that were tendered (決済の開始日)."],
    backer: ["Fund behind bidder", "A known sponsor found among the shareholders of the bid vehicle. News often just says 'an investment fund'."]
  };
  const FL_BACKER_EN = { "政府系ファンド": "Government-backed fund" };
  const nfkc = (s) => (s || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const stripJa = (s) => s.replace(/^(株式会社|有限会社|合同会社)\s*/, "").replace(/\s*(株式会社|有限会社|合同会社)$/, "");
  const stripEn1 = (s) => s.replace(/[,.\s]*\b(co[.,\s]*ltd|pte[.,\s]*ltd|k\.?\s?k|inc|corporation|corp|company|co|limited|ltd|llc|llp)\b[.\s]*$/i, "").replace(/[\s&,]+$/, "").trim();
  const stripEn = (s) => stripEn1(stripEn1(s));
  const flClip = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
  function flName(p) {
    const en = nfkc(p.name_en), ja = nfkc(p.name);
    const enS = en ? stripEn(en) : "";
    let jaS = stripJa(ja) || ja; if (/^[\x00-\x7f]+$/.test(jaS)) jaS = stripEn(jaS) || jaS;
    return { en, ja, enS, jaS, ticker: p.ticker || "", main: enS || jaS, sub: enS ? ja : "" };
  }
  const flEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const flTip = (key) => {
    const g = FL_GLOSS[key], i = flEl("span", "fx-i", "ⓘ");
    i.tabIndex = 0; i.setAttribute("role", "note"); i.dataset.tip = g[1]; i.setAttribute("aria-label", g[0] + ": " + g[1]);
    return i;
  };
  const flDay = (iso) => fmtDay(iso.slice(0, 10)).replace(/ \d{4}$/, "").replace("Sept", "Sep");               // "12 Nov"
  const flDayJa = (iso) => { const [, m, d] = iso.slice(0, 10).split("-"); return (+m) + "月" + (+d) + "日"; };
  const flShares = (s) => { const n = +String(s).replace(/,/g, ""); return n >= 1e6 ? (n / 1e6).toFixed(1) + "M shares" : n.toLocaleString("en-US") + " shares"; };
  const flYen = (s) => "¥" + Number(String(s).replace(/,/g, "")).toLocaleString("en-US");
  const flFlat = (d) => Math.abs(d) < 0.005;
  const flPt = (d) => (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(2) + "pt";
  function flBizDaysLeft(closes) {
    let n = 0; const e = new Date(closes + "T00:00:00Z").getTime();
    for (let t = new Date(todaySG() + "T00:00:00Z").getTime() + 864e5; t <= e; t += 864e5) { const w = new Date(t).getUTCDay(); if (w && w < 6) n++; }
    return n;
  }
  const flDocLabel = (c) => c.kind === "tob_result" ? "Result" : c.kind === "tob_withdrawn" ? "Withdrawn" : c.kind === "opinion" ? "Response" : /訂正/.test(c.type_ja) ? "Amended" : "Filed";
  const flPdf = (id) => "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/" + id + ".pdf";

  // Same case = same chain of documents: ids linked through `parent`. Earlier documents the feed no longer holds are kept as plain links.
  function flItems(cards) {
    const uf = new Map(), find = (x) => { while (uf.get(x) !== x) { uf.set(x, uf.get(uf.get(x))); x = uf.get(x); } return x; };
    const add = (x) => { if (!uf.has(x)) uf.set(x, x); };
    const ids = new Set(cards.map(c => c.id));
    cards.forEach(c => { add(c.id); if (c.parent) { add(c.parent); uf.set(find(c.id), find(c.parent)); } });
    const groups = new Map();
    cards.forEach(c => { const r = find(c.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    return [...groups.values()].map(docs => {
      docs.sort((a, b) => a.filed < b.filed ? -1 : 1);                       // oldest first
      // the target's own response is filed under the bidder's case but names the two the other way round, so
      // the offer itself (not the response) speaks for the case when there is one
      const offerDocs = docs.filter(d => d.kind !== "opinion");
      const latest = (offerDocs.length ? offerDocs : docs)[(offerDocs.length ? offerDocs : docs).length - 1];
      const earlier = [...new Set(docs.map(d => d.parent).filter(p => p && !ids.has(p)))];
      const family = latest.kind === "stake" ? "stake" : "tob";
      const terms = Object.assign({}, ...docs.map(d => d.terms || {}));
      const it = { family, docs, latest, earlier, terms, chain: Math.max(docs.length + earlier.length, latest.filings || 1),
        target: flName(latest.target), buyer: flName(latest.buyer), changes: [] };
      if (family === "tob") {
        it.hasResult = docs.some(d => d.kind === "tob_result");
        it.withdrawn = docs.some(d => d.kind === "tob_withdrawn");
        const t = terms, today = todaySG();
        if (it.withdrawn) it.status = ["Withdrawn", "done"];
        else if (it.hasResult) it.status = ["Closed · result filed", "done"];
        else if (t.closes && today > t.closes) it.status = ["Closed", "done"];
        else if (t.opens && today < t.opens) it.status = ["Opens " + flDay(t.opens), "soon"];
        else if (t.closes) { const n = flBizDaysLeft(t.closes); it.status = [n === 0 ? "Open · closes today" : "Open · " + n + " business day" + (n === 1 ? "" : "s") + " left", "open"]; }
        else it.status = ["Filed", "soon"];
        // terms that moved between the first filing of the offer and the latest one
        const withTerms = docs.filter(d => d.terms && (d.terms.price || d.terms.closes));
        if (withTerms.length > 1) {
          const a = withTerms[0].terms, b = withTerms[withTerms.length - 1].terms;
          if (a.price && b.price && a.price !== b.price) it.changes.push((+b.price.replace(/,/g, "") > +a.price.replace(/,/g, "") ? "Price raised " : "Price lowered ") + flYen(a.price) + " → " + flYen(b.price));
          if (a.closes && b.closes && a.closes !== b.closes) it.changes.push((b.closes > a.closes ? "Extended to " : "Shortened to ") + flDay(b.closes));
          if (a.shares && b.shares && a.shares !== b.shares) it.changes.push("Shares sought " + flShares(a.shares) + " → " + flShares(b.shares));
        }
      } else {
        const t = latest.terms || {};
        it.delta = t.stake_now != null && t.stake_prev != null ? t.stake_now - t.stake_prev : null;
      }
      return it;
    });
  }
  // One sentence, from filed fields only. Japanese uses the same template.
  function flSummary(it) {
    const t = it.terms, tg = it.target, by = it.buyer, L = it.latest;
    const B = flClip(by.main, 38), T = tg.main, Bj = flClip(by.jaS, 38), Tj = tg.jaS;
    if (it.family === "tob") {
      const closeEn = t.closes ? flDay(t.closes) : "", closeJa = t.closes ? flDayJa(t.closes) : "";
      if (it.withdrawn) return { en: `${B} withdrew its tender offer for ${T}`, ja: `${Bj}は${Tj}の公開買付けを撤回` };
      if (L.kind === "opinion") return { en: `${B} filed its response to the tender offer by ${T}`, ja: `${Bj}が${Tj}による公開買付けへの意見表明を提出` };
      if (it.hasResult) {
        const n = t.tendered ? flShares(t.tendered) : "", after = t.stake_after != null ? t.stake_after.toFixed(2) + "%" : "";
        if (t.outcome === "success") return {
          en: `Tender offer for ${T} succeeded: ${n ? n + " tendered" : "closed" + (closeEn ? " " + closeEn : "")}${after ? `, bidder now holds ${after}` : ""}`,
          ja: `${Tj}の公開買付けは成立${n ? "、応募" + t.tendered + "株" : ""}${after ? "、買付後の所有割合" + after : ""}` };
        if (t.outcome === "failed") return {
          en: `Tender offer for ${T} did not succeed${n ? ": " + n + " tendered, below the minimum" : ""}`,
          ja: `${Tj}の公開買付けは不成立${n ? "、応募" + t.tendered + "株で下限に届かず" : ""}` };
        return { en: `Tender offer for ${T} closed${closeEn ? " " + closeEn : ""}; result filed`, ja: `${Tj}の公開買付けは${closeJa ? closeJa + "に" : ""}終了、結果報告書を提出` };
      }
      const px = t.price ? `, ${flYen(t.price)} a share` : "", pxJa = t.price ? `、1株${flYen(t.price)}` : "";
      if (it.status[1] === "done") return { en: `Tender offer for ${T} by ${B} closed ${closeEn}`, ja: `${Bj}による${Tj}の公開買付けは${closeJa}に終了` };
      return { en: `${B} is bidding for ${T}${px}; offer closes ${closeEn}`, ja: `${Bj}が${Tj}の株式公開買付けを実施中${pxJa}、${closeJa}まで` };
    }
    const now = t.stake_now, pct = now.toFixed(2) + "%", prop = t.proposal;
    const propEn = prop ? "; may make proposals" : "", propJa = prop ? "。重要提案行為を行う可能性あり" : "";
    if (t.stake_prev == null) return { en: `${B} disclosed a new ${pct} stake in ${T}${propEn}`, ja: `${Bj}が${Tj}株を${pct}保有と報告（新規）${propJa}` };
    const d = now - t.stake_prev;
    if (Math.abs(d) < 0.005) return { en: `${B} reported its stake in ${T} unchanged at ${pct}${propEn}`, ja: `${Bj}の${Tj}株の保有割合は${pct}で変わらず${propJa}` };
    return d > 0
      ? { en: `${B} raised its stake in ${T} to ${pct} (${flPt(d)})${propEn}`, ja: `${Bj}が${Tj}株の保有割合を${pct}に引き上げ（${flPt(d)}）${propJa}` }
      : { en: `${B} cut its stake in ${T} to ${pct} (${flPt(d)})${propEn}`, ja: `${Bj}が${Tj}株の保有割合を${pct}に引き下げ（${flPt(d)}）${propJa}` };
  }
  const flText = (it) => flSummary(it)[state.lang === "ja" ? "ja" : "en"];
  // [label, value, tipKey, deltaText]
  function flFigures(it, all) {
    const t = it.terms, f = [];
    if (it.family === "tob") {
      if (t.price) f.push(["Offer price", flYen(t.price) + " a share"]);
      if (t.opens && t.closes) f.push(["Offer period", `${flDay(t.opens)} to ${flDay(t.closes)}` + (t.business_days ? ` (${t.business_days} business days)` : "")]);
      if (t.shares) f.push(["Shares sought", flShares(t.shares) + (t.stake_pct ? ` · ${t.stake_pct}%` : ""), "sought"]);
      if (t.floor) f.push(["Minimum to succeed", flShares(t.floor), "floor"]);
      if (t.backer) f.push(["Fund behind bidder", FL_BACKER_EN[t.backer] || nfkc(t.backer), "backer"]);
      if (t.settles) f.push(["Payment date", flDay(t.settles), "settles"]);
      if (t.outcome) f.push(["Result", t.outcome === "success" ? "Succeeded" : "Did not succeed"]);
      if (t.tendered) f.push(["Shares tendered", flShares(t.tendered)]);
      if (t.bought && t.bought !== t.tendered) f.push(["Shares bought", flShares(t.bought)]);
      if (t.stake_after != null) f.push(["Bidder stake after", t.stake_after.toFixed(2) + "%"]);
    } else {
      const now = t.stake_now.toFixed(2) + "%";
      if (t.stake_prev != null) f.push(["Stake", `${t.stake_prev.toFixed(2)}% → ${now}`, "joint", flFlat(it.delta) ? "unchanged" : (it.delta >= 0 ? "▲ " : "▼ ") + flPt(it.delta)]);
      else f.push(["Stake", now + " (new report)", "joint"]);
      if (all && t.purpose) f.push(["Holding purpose", nfkc(t.purpose)]);
    }
    return all ? f : f.slice(0, 4);
  }
  function flFigNode(rows, cls) {
    const dl = flEl("dl", cls || "fx-figs");
    rows.forEach(([k, v, tip, delta]) => {
      const dt = flEl("dt", null, k); if (tip) dt.append(flTip(tip));
      const dd = flEl("dd", null, v); if (delta) dd.append(flEl("span", "fx-delta", " " + delta));
      dl.append(dt, dd);
    });
    return dl;
  }
  function flHistory(it) {
    const box = flEl("div", "fx-hist");
    box.append(flEl("span", "fx-hist-k", it.docs.length > 1 || it.earlier.length ? "Filings" : "Filing"));
    const link = (txt, href) => { const a = flEl("a", "fx-doc", txt); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; };
    it.earlier.forEach(id => box.append(link("Earlier filing ↗", flPdf(id))));
    // a long offer can have thirty documents: the first, a count of the ones between, then the last three
    const shown = it.docs.length > 7 ? [...it.docs.slice(0, 1), null, ...it.docs.slice(-3)] : it.docs;
    shown.forEach(d => d ? box.append(link(`${flDocLabel(d)} ${flDay(d.filed)} ↗`, d.link))
      : box.append(flEl("span", "fx-hist-more", `· ${it.docs.length - 4} more ·`)));
    const extra = it.chain - it.docs.length - it.earlier.length;
    if (extra > 0) box.append(flEl("span", "fx-hist-more", `+${extra} older in this chain`));
    return box;
  }
  function flBadges(it, withKind) {
    const row = flEl("div", "fx-badges");
    const k = flEl("span", "fx-kind k-" + it.family, it.family === "tob" ? "Tender offer" : "Stake change");
    k.append(flTip(it.family === "tob" ? "tob" : "stake"));
    if (withKind !== false) row.append(k);
    if (it.family === "tob") row.append(flEl("span", "fx-status s-" + it.status[1], it.status[0]));
    if (it.latest.terms && it.latest.terms.proposal) { const p = flEl("span", "fx-flag", "Proposal intent"); p.append(flTip("proposal")); row.append(p); }
    if (it.latest.sponsor) { const p = flEl("span", "fx-flag", "Sponsor"); p.append(flTip("sponsor")); row.append(p); }
    it.changes.forEach(c => row.append(flEl("span", "fx-change", c)));
    return row;
  }
  function flCompany(it) {
    const box = flEl("div", "fx-co");
    const a = flEl("a", "fx-co-main", it.target.main); a.href = it.latest.link; a.target = "_blank"; a.rel = "noopener";
    box.append(a);
    if (it.target.ticker) box.append(flEl("span", "fx-ticker", it.target.ticker));
    if (it.target.sub) box.append(flEl("span", "fx-co-sub", it.target.sub));
    return box;
  }
  function flOrder(items) {
    const rank = (i) => i.family === "stake" ? 3 : i.status[1] === "open" ? 0 : i.status[1] === "soon" ? 1 : 2;
    return items.slice().sort((a, b) => rank(a) - rank(b) || (a.family === "tob" && rank(a) === 2 ? (b.terms.closes || "").localeCompare(a.terms.closes || "") : a.family === "tob" ? (a.terms.closes || "").localeCompare(b.terms.closes || "") : b.latest.filed.localeCompare(a.latest.filed)));
  }
  const FL_PAGE = 25;
  const flState = { filter: "all", open: new Set(), shown: FL_PAGE };

  function renderFilings() {
    const panel = $("#filings"), body = $("#filing-body"), tools = $("#filing-tools");
    const cards = (state.filings || []).filter(c => !state.filters.country.length || state.filters.country.includes("JP"));
    panel.hidden = !cards.length;
    if (!cards.length) return;
    const items = flOrder(flItems(cards));
    const nT = items.filter(i => i.family === "tob").length, nS = items.length - nT;
    $("#filings-meta").textContent = `${items.length} ${items.length === 1 ? "case" : "cases"} · EDINET`;
    body.textContent = ""; tools.textContent = "";
    renderFilingsTable(items, nT, nS, tools, body);
  }
  function renderFilingsTable(items, nT, nS, tools, body) {
    [["all", "All", items.length], ["tob", "Tender offers", nT], ["stake", "Stake changes", nS]].forEach(([k, label, n]) => {
      const b = flEl("button", "chip", `${label} · ${n}`); b.setAttribute("aria-pressed", flState.filter === k);
      b.addEventListener("click", () => { flState.filter = k; flState.shown = FL_PAGE; renderFilings(); });
      tools.append(b);
    });
    const wrap = flEl("div", "fx-tablewrap"), table = flEl("table", "fx-table");
    const thead = flEl("thead"), hr = flEl("tr");
    ["Date", "Company", "What happened", "Key figures", "Filing"].forEach(h => hr.append(flEl("th", null, h)));
    thead.append(hr); table.append(thead);
    const tb = flEl("tbody");
    const list = items.filter(i => flState.filter === "all" || i.family === flState.filter);
    list.slice(0, flState.shown).forEach(it => {
      const open = flState.open.has(it.latest.id);
      const tr = flEl("tr", "fx-row k-" + it.family + (open ? " is-open" : ""));
      tr.tabIndex = 0; tr.setAttribute("aria-expanded", open);
      const td = (cls) => { const c = flEl("td", cls); tr.append(c); return c; };
      td("c-date").textContent = fmtDate(it.latest.filed).replace("Sept", "Sep");
      td("c-co").append(flCompany(it));
      const w = td("c-what"); w.append(flEl("span", "fx-sentence", flText(it)));
      const key = td("c-key");
      if (it.family === "tob") {
        key.append(flBadges(it, false));
        const t = it.terms; const l = [];
        if (t.price) l.push(flYen(t.price));
        if (t.opens && t.closes) l.push(`${flDay(t.opens)} to ${flDay(t.closes)}`);
        key.append(flEl("span", "fx-key-line", l.join(" · ")));
      } else {
        const f = flFigures(it, false)[0];
        key.append(flEl("span", "fx-key-line", f[1]));
        if (f[3]) key.append(flEl("span", "fx-delta", f[3]));
        if (it.latest.terms.proposal) { const p = flEl("span", "fx-flag", "Proposal intent"); p.append(flTip("proposal")); key.append(p); }
      }
      const fl = td("c-file");
      const k = flEl("span", "fx-kind k-" + it.family, it.family === "tob" ? "Tender offer" : "Stake"); fl.append(k);
      const a = flEl("a", "fx-doc", `${flDocLabel(it.latest)} ↗`); a.href = it.latest.link; a.target = "_blank"; a.rel = "noopener"; a.addEventListener("click", e => e.stopPropagation());
      fl.append(a);
      if (it.chain > 1) fl.append(flEl("span", "fx-n", it.chain + " in chain"));
      tb.append(tr);
      const toggle = () => { flState.open.has(it.latest.id) ? flState.open.delete(it.latest.id) : flState.open.add(it.latest.id); renderFilings(); };
      tr.addEventListener("click", e => { if (!e.target.closest("a,.fx-i")) toggle(); });
      tr.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target === tr) { e.preventDefault(); toggle(); } });
      if (open) {
        const dr = flEl("tr", "fx-detail"), dc = flEl("td"); dc.colSpan = 5;
        dc.append(flBadges(it), flFigNode(flFigures(it, true), "fx-figs fx-figs-all"));
        const names = flEl("p", "fx-names");
        names.textContent = "Filed by " + (it.buyer.en || it.buyer.ja) + (it.buyer.en ? " (" + it.buyer.ja + ")" : "") + ". Target: " + (it.target.en || it.target.ja) + (it.target.en ? " (" + it.target.ja + ")" : "") + ".";
        dc.append(names, flHistory(it)); dr.append(dc); tb.append(dr);
      }
    });
    table.append(tb); wrap.append(table); body.append(wrap);
    if (list.length > flState.shown) {
      const more = flEl("button", "chip fx-more", `Show ${Math.min(FL_PAGE, list.length - flState.shown)} more (${list.length - flState.shown} left)`);
      more.addEventListener("click", () => { flState.shown += FL_PAGE; renderFilings(); });
      body.append(more);
    }
  }
  // one floating note for every ⓘ: hover or keyboard focus on desktop, tap on phones
  (function flPopover() {
    const pop = flEl("div", "fx-pop"); pop.hidden = true; pop.setAttribute("role", "tooltip"); document.body.append(pop);
    const show = (i) => {
      pop.textContent = i.dataset.tip; pop.hidden = false;
      const r = i.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
      pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? r.top - 6 - pop.offsetHeight : r.bottom + 6) + "px";
    };
    const hide = () => { pop.hidden = true; };
    document.addEventListener("mouseover", e => { const i = e.target.closest && e.target.closest(".fx-i"); if (i) show(i); });
    document.addEventListener("mouseout", e => { if (e.target.closest && e.target.closest(".fx-i")) hide(); });
    document.addEventListener("focusin", e => { const i = e.target.closest && e.target.closest(".fx-i"); if (i) show(i); });
    document.addEventListener("focusout", hide);
    document.addEventListener("click", e => { const i = e.target.closest && e.target.closest(".fx-i"); if (i) { e.stopPropagation(); pop.hidden && show(i); } else hide(); }, true);
    window.addEventListener("scroll", hide, { passive: true });
  })();

  /* ---------------- digest editions ---------------- */
  const permalink = (eid, i) => `${location.origin}${location.pathname}?e=${encodeURIComponent(eid)}` + (i == null ? "" : `&i=${i}`);
  const editionTime = (e) => e.id.slice(11, 13) + ":" + e.id.slice(13, 15);
  const editionDay = (e) => e.id.slice(0, 10);
  const fmtDay = (day, weekday) => new Date(day + "T00:00:00Z").toLocaleDateString("en-SG", { weekday: weekday ? "short" : undefined, day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  async function loadEdition(id) {
    if (!state.editionCache.has(id)) state.editionCache.set(id, await getJSON(dataUrl(`digests/${id}.json`)));
    return state.editionCache.get(id);
  }
  function renderEditionTabs() {
    const box = $("#edition-tabs"); box.textContent = "";
    if (!state.editions.length) return;
    const cur = state.edition || state.editions[0].id;
    const day = cur.slice(0, 10);
    const d = document.createElement("span"); d.className = "ed-day";
    d.textContent = day === todaySG() ? "Today" : fmtDay(day);
    box.append(d);
    state.editions.filter(e => editionDay(e) === day).slice().reverse().forEach(e => {
      const b = document.createElement("button");
      b.className = "ed-tab"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", e.id === cur);
      b.textContent = editionTime(e);
      b.title = e.label || e.id;
      b.addEventListener("click", () => { state.pinned = null; history.replaceState(null, "", location.pathname); showEdition(e.id); });
      box.append(b);
    });
  }
  async function showEdition(id, scrollTo = null) {
    state.edition = id;
    try { await loadEdition(id); } catch { /* missing edition: fall back to auto-picked */ }
    renderDigest(state.lastRanked);
    if (scrollTo != null) {
      const el = $(`#digest-list li[data-n="${scrollTo}"]`);
      if (el) { el.classList.add("pinned"); el.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }
  }

  function digestItemNode(x, n, eid, displayNo) {
    const li = document.createElement("li");
    li.dataset.n = n; li.id = `d-${n}`;
    const num = document.createElement("span"); num.className = "d-num"; num.textContent = String(displayNo).padStart(2, "0");
    const body = document.createElement("div"); body.className = "d-body";
    if (x.status === "update") {
      const up = document.createElement("span"); up.className = "d-badge"; up.textContent = "Update";
      body.append(up);
    }
    const h = document.createElement("h3");
    const a = document.createElement("a"); a.textContent = x.headline; a.href = (x.links && x.links[0] && x.links[0].url) || "#"; a.target = "_blank"; a.rel = "noopener";
    h.append(a);
    const p = document.createElement("p"); p.className = "d-sum"; p.textContent = dtext(x, "summary");
    const why = document.createElement("p"); why.className = "d-why";
    const b = document.createElement("b"); b.textContent = "Why it matters"; why.append(b, " ", dtext(x, "why_it_matters"));
    const links = document.createElement("p"); links.className = "d-links";
    (x.links || []).forEach((l, j) => { if (j) links.append(" · "); const la = document.createElement("a"); la.href = l.url; la.target = "_blank"; la.rel = "noopener"; la.textContent = l.source; links.append(la); });
    if (x.prev && x.prev.edition) {
      const pv = document.createElement("a"); pv.className = "d-prev"; pv.href = permalink(x.prev.edition, x.prev.index);
      pv.textContent = "earlier coverage →";
      pv.addEventListener("click", ev => { ev.preventDefault(); openPermalink(x.prev.edition, x.prev.index); });
      links.append(" · ", pv);
    }
    const share = document.createElement("button"); share.type = "button"; share.className = "d-share"; share.textContent = "copy link";
    share.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(permalink(eid, n)); share.textContent = "copied"; } catch { prompt("Link to this story", permalink(eid, n)); }
      setTimeout(() => { share.textContent = "copy link"; }, 1500);
    });
    links.append(" · ", share);
    body.append(h, p, why, links); li.append(num, body);
    return li;
  }

  function renderDigest(ranked) {
    const list = $("#digest-list"); list.textContent = "";
    const meta = $("#digest-meta");
    renderEditionTabs();
    const eid = state.edition || (state.editions[0] && state.editions[0].id);
    const d = eid && state.editionCache.get(eid);
    const isLatest = !!(eid && state.editions[0] && eid === state.editions[0].id);
    const usable = d && d.items && d.items.length && (!isLatest || (Date.now() - Date.parse(d.generated_at)) < 36 * 36e5);
    $("#digest-h").textContent = eid && eid.slice(0, 10) !== todaySG() ? "Digest" : "Today's Digest";
    if (usable) {
      // The latest edition is reordered by this viewer's reading; a linked or past edition keeps the editor's order.
      const personal = isLatest && !state.pinned;
      const prof = activeProfile(), N = d.items.length;
      let rows = d.items.map((x, n) => ({ x, n, s: (N - n) / N + (personal ? 0.6 * affinity({ categories: x.categories, countries: x.countries, sectors: x.sectors, title: x.headline }, prof) : 0) }));
      rows.sort((a, b) => b.s - a.s);
      if (personal) rows = rows.filter(r => !anyFilter() || passes(r.x));
      meta.textContent = `${d.reading_minutes || 5} min read · ${fmtDate(d.generated_at)} SGT`;
      rows.forEach((r, k) => list.append(digestItemNode(r.x, r.n, eid, k + 1)));
      if (!rows.length) list.append(empty("None of this edition's stories match these filters."));
      return;
    }
    // No edition yet (or the latest is stale): the top-ranked stories of the last ~day.
    const top = (ranked || []).filter(x => (Date.now() - Date.parse(x.it.published)) < 30 * 36e5).slice(0, 6);
    meta.textContent = "auto-picked · written summary arrives with the next edition";
    top.forEach(({ it }, i) => {
      const li = document.createElement("li");
      const num = document.createElement("span"); num.className = "d-num"; num.textContent = String(i + 1).padStart(2, "0");
      const body = document.createElement("div"); body.className = "d-body";
      const h = document.createElement("h3");
      const a = document.createElement("a"); a.textContent = it.title; a.href = it.link; a.target = "_blank"; a.rel = "noopener";
      a.addEventListener("click", () => markRead(it));
      h.append(a);
      const p = document.createElement("p"); p.className = "d-sum"; p.textContent = it.snippet || "";
      const l = document.createElement("p"); l.className = "d-links"; l.textContent = it.source + " · " + fmtAgo(it.published) + " ago";
      body.append(h, p, l); li.append(num, body); list.append(li);
    });
    if (!top.length) list.append(empty("No stories in the last 24 hours."));
    requestAnimationFrame(syncDigestHeight);
  }

  /* The digest often runs far longer than the deal board beside it, leaving the left column
     short and the page lopsided. Where the two share a row, cap the digest list at the
     board's height and let it scroll, so the two columns end level. */
  let syncing = false;
  function syncDigestHeight() {
    if (syncing) return;                                           // our own resize, not a real one
    const list = $("#digest-list"), board = $("#view-deals"), panel = $("#digest"), grid = $(".grid");
    if (!list || !board || !panel || !grid) return;
    syncing = true;
    try { measureDigest(list, board, panel, grid); } finally { syncing = false; }
  }
  function measureDigest(list, board, panel, grid) {
    list.style.maxHeight = "";
    if (board.offsetParent === null) return;                       // board hidden in this view
    const b = board.getBoundingClientRect(), p = panel.getBoundingClientRect();
    // only worth doing where the two actually sit side by side; stacked, they follow each other
    if (Math.abs(b.top - p.top) > 4) return;
    if (b.height >= p.height - 1) return;                          // digest is already the shorter one
    const l = list.getBoundingClientRect();
    const head = l.top - p.top;        // panel head and edition tabs above the list
    const tail = p.bottom - l.bottom;  // whatever the skin puts below it
    list.style.maxHeight = Math.max(240, Math.round(b.height - head - tail)) + "px";
  }

  function renderArchive() {
    const ol = $("#archive-list"); ol.textContent = "";
    const byDay = new Map();
    state.editions.forEach(e => { const d = editionDay(e); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); });
    byDay.forEach((eds, day) => {
      const li = document.createElement("li"); li.className = "arch-day";
      const h = document.createElement("h3"); h.textContent = fmtDay(day, true);
      li.append(h);
      eds.forEach(e => {
        const a = document.createElement("a"); a.className = "arch-ed"; a.href = permalink(e.id, null);
        const t = document.createElement("span"); t.className = "arch-time"; t.textContent = editionTime(e);
        const hl = document.createElement("span"); hl.className = "arch-heads"; hl.textContent = (e.headlines || []).join(" · ");
        const n = document.createElement("span"); n.className = "arch-n"; n.textContent = (e.items || 0) + " stories";
        a.append(t, hl, n);
        a.addEventListener("click", ev => { ev.preventDefault(); openPermalink(e.id, null); });
        li.append(a);
      });
      ol.append(li);
    });
    if (!state.editions.length) ol.append(empty("No digests yet."));
    $("#archive-meta").textContent = state.editions.length + " editions";
  }

  async function openPermalink(eid, i) {
    state.pinned = { e: eid, i };
    history.replaceState(null, "", permalink(eid, i));
    setView("home");
    await showEdition(eid, i);
    if (i == null) $("#digest").scrollIntoView({ behavior: "smooth" });
  }

  function renderAll() {
    syncFilterUI();
    state.lastRanked = rankedItems();
    renderDigest(state.lastRanked);
    renderDeals();
    renderFilings();
    if (state.view === "search") runSearch();
    if (state.view === "follow") renderFollow();
    if (state.view === "companies") renderCompanies();
    state.firstLoad = false;
  }

  /* ---------------- actions ---------------- */
  function markRead(it) {
    const r = store.get("read", {});
    if (!r[it.id]) { r[it.id] = Date.now(); store.set("read", prune(r)); logEvent("open", it); }
  }
  function toggleSave(it, btn) {
    const s = store.get("saved", {});
    // ☆ = follow: the story joins the Deals page and the follow-up research
    if (s[it.id]) { delete s[it.id]; btn.classList.remove("on"); btn.textContent = "☆"; }
    else { s[it.id] = { ...it, since: new Date().toISOString() }; btn.classList.add("on"); btn.textContent = "★"; logEvent("save", it); }
    store.set("saved", s);
    updateCounts(); queueSync();
    if (state.view === "follow") renderFollow();
  }
  function hide(it) { const h = store.get("hidden", {}); h[it.id] = Date.now(); store.set("hidden", prune(h)); logEvent("hide", it); }
  function prune(obj) { const c = Date.now() - 120 * 864e5; return Object.fromEntries(Object.entries(obj).filter(([, t]) => t >= c)); }

  /* ---------------- following and companies ----------------
     A ☆ story is followed: the browser sends its list to the Apps Script (with a random id that
     names no one), a fetch job copies the combined list into data/follow/queue.json, and the
     follow-up Routine writes what it finds to data/follow/<id>.json. Companies go to the same
     script and stay there: it fetches their headlines and returns them only to this browser. */
  function viewerId() {
    let v = store.get("vid", "");
    if (!/^[a-f0-9]{32}$/.test(v)) {
      const b = new Uint8Array(16); crypto.getRandomValues(b);
      v = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
      store.set("vid", v);
    }
    return v;
  }
  const followed = () => Object.values(store.get("saved", {}))
    .sort((a, b) => String(b.since || b.published).localeCompare(String(a.since || a.published)));
  const companies = () => store.get("companies", []);

  let syncTimer = null;
  function queueSync(delay = 1200) {
    if (!MAIL_ENDPOINT) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const follows = followed().map(it => ({ id: it.id, title: it.title, link: it.link, source: it.source, published: it.published, since: it.since || it.published }));
      fetch(MAIL_ENDPOINT, { method: "POST", mode: "no-cors",
        body: new URLSearchParams({ action: "sync", vid: viewerId(), follows: JSON.stringify(follows), companies: JSON.stringify(companies()) }) })
        .catch(() => { /* offline: the next change or visit sends it again */ });
    }, delay);
  }
  // Apps Script replies are read as JSONP: a script tag loads across origins without CORS.
  let jsonpSeq = 0;
  function jsonp(params) {
    return new Promise((resolve, reject) => {
      const cb = "dwcb" + (++jsonpSeq) + Date.now().toString(36), s = document.createElement("script");
      const done = () => { delete window[cb]; s.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { done(); reject(new Error("timeout")); }, 20000);
      window[cb] = (data) => { done(); resolve(data); };
      s.onerror = () => { done(); reject(new Error("load")); };
      s.src = MAIL_ENDPOINT + "?" + new URLSearchParams({ ...params, callback: cb });
      document.head.append(s);
    });
  }
  function updateCounts() {
    const n = { follow: Object.keys(store.get("saved", {})).length, companies: companies().length };
    $$("[data-count]").forEach(el => { el.textContent = n[el.dataset.count] || ""; });
  }

  const agoText = (iso) => { const a = fmtAgo(iso); return a === "now" ? "just now" : a + " ago"; };
  const fmtWhen = (d) => {
    if (!d) return "";
    const m = String(d).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return d;
    const mon = new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    return (m[3] ? +m[3] + " " : "") + mon + " " + m[1];
  };
  // One entry in a Background / Since then column, or one company headline.
  function flItem({ date, title, url, source, summary, tags }) {
    const li = document.createElement("li"); li.className = "fl-item"; li.dataset.url = url || "";
    const meta = document.createElement("p"); meta.className = "d-links fl-meta";
    const ms = document.createElement("span"); ms.className = "fl-ms"; ms.textContent = ms.title = [fmtWhen(date), source].filter(Boolean).join(" · "); meta.append(ms);
    // the company's keywords this headline contains, boxed in the company's colour
    (tags || []).forEach(k => { const t = document.createElement("span"); t.className = "kw-tag"; t.textContent = k; meta.append(t); });
    const h = document.createElement("h3"), a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = title; h.append(a);
    li.append(meta, h);
    if (summary) { const p = document.createElement("p"); p.className = "d-sum"; p.textContent = summary; li.append(p); }
    return li;
  }
  function flColumn(label, items, emptyMsg) {
    const col = document.createElement("div"); col.className = "fl-col";
    const head = document.createElement("p"); head.className = "panel-meta fl-head";
    head.textContent = label + (items && items.length ? " · " + items.length : "");
    const ol = document.createElement("ol"); ol.className = "digest-list fl-items";
    if (items && items.length) items.forEach(x => ol.append(flItem(x)));
    else { const li = document.createElement("li"); li.className = "empty"; li.textContent = emptyMsg; ol.append(li); }
    col.append(head, ol);
    return col;
  }
  const arrow = () => { const s = document.createElement("div"); s.className = "fl-arrow"; s.setAttribute("aria-hidden", "true"); s.textContent = "→"; return s; };

  /* Deals page */
  const followData = new Map();
  let followIndex = null;
  async function loadFollow() {
    followIndex = await getJSON(dataUrl("follow/index.json")).catch(() => ({ stories: {} }));
    const ids = followed().map(it => it.id).filter(id => followIndex.stories && followIndex.stories[id]);
    await Promise.all(ids.map(async id => {
      const stamp = followIndex.stories[id].checked_at;
      if (followData.has(id) && followData.get(id).checked_at === stamp) return;
      const d = await getJSON(dataUrl(`follow/${id}.json`)).catch(() => null);
      if (d) followData.set(id, d);
    }));
  }
  // "Where it stands": a speech bubble under the story whose tail points up at the headline.
  // Jump to the entry (in Background / Since then) that backs the status; fall back to the article.
  function goToRef(card, url) {
    const li = $$(".fl-item", card).find(x => x.dataset.url === url);
    if (!li) { window.open(url, "_blank", "noopener"); return; }
    const box = li.closest(".fl-items");
    if (box) box.scrollTo({ top: Math.max(0, li.offsetTop - box.offsetTop - 4), behavior: "smooth" });
    if (window.matchMedia("(max-width: 760px)").matches) li.scrollIntoView({ behavior: "smooth", block: "center" });
    li.classList.remove("fl-hit"); void li.offsetWidth; li.classList.add("fl-hit");
    setTimeout(() => li.classList.remove("fl-hit"), 2200);
  }
  function statusBubble(d) {
    const ja = state.lang === "ja", st = d && d.status;
    const b = document.createElement("div"); b.className = "fl-status";
    const label = document.createElement("p"); label.className = "fl-status-label";
    const body = document.createElement("p"); body.className = "fl-status-text";
    const m = st && String(st.as_of || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const text = st && ((ja && st.text_ja) || st.text);
    if (!m || !text) {
      b.classList.add("pending");
      label.textContent = ja ? "現況" : "Where it stands";
      body.textContent = ja ? "現況サマリーは次回のリサーチで届く" : "Status summary arrives with the next research run";
    } else {
      const mon = new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
      label.textContent = ja ? `現況 · ${+m[2]}/${+m[3]}時点` : `Where it stands · as of ${+m[3]} ${mon}`;
      body.textContent = text;
    }
    b.append(label, body);
    if (st && Array.isArray(st.refs) && text) {
      const items = [...(d.since || []), ...(d.background || [])];
      const refs = st.refs.map(r => items.find(x => x.url === (r && r.url))).filter(Boolean).slice(0, 3);
      if (refs.length) {
        const ul = document.createElement("ul"); ul.className = "fl-refs";
        refs.forEach(x => {
          const li = document.createElement("li"), a = document.createElement("a");
          a.href = x.url; a.className = "fl-ref"; a.rel = "noopener";
          a.textContent = "→ " + [fmtWhen(x.date), x.headline || x.title].filter(Boolean).join(" · ");
          a.addEventListener("click", e => { e.preventDefault(); goToRef(a.closest(".fl-row"), x.url); });
          li.append(a); ul.append(li);
        });
        b.append(ul);
      }
    }
    return b;
  }
  function renderFollow() {
    const ol = $("#follow-list"); ol.textContent = "";
    const list = followed();
    if (!list.length) { ol.append(empty("Nothing followed yet. Tap ☆ on any story and its background and follow-ups will build up here.")); return; }
    const pick = (x) => ({ date: x.date, title: x.headline || x.title, url: x.url, source: x.source, summary: dtext(x, "summary") });
    list.forEach(it => {
      const li = document.createElement("li"); li.className = "fl-row";
      const story = document.createElement("div"); story.className = "fl-story";
      const rows = document.createElement("ol"); rows.className = "rows"; rows.append(rowNode(it));
      story.append(rows);
      const d = followData.get(it.id);
      story.append(statusBubble(d));
      const wait = "Being researched. The first results arrive with the next run (08:45, 12:45 or 15:45 SGT).";
      li.append(story,
        flColumn("Background", d ? (d.background || []).map(pick) : null, d ? "Nothing earlier found." : wait),
        arrow(),
        flColumn("Since then", d ? (d.since || []).map(pick) : null, d ? "No developments yet. Checked " + agoText(d.checked_at) + "." : wait));
      ol.append(li);
    });
  }

  /* Companies page */
  let coData = null, coLoading = false;
  async function loadCompanies() {
    if (!MAIL_ENDPOINT || coLoading) return;
    coLoading = true;
    try { coData = await jsonp({ action: "companies", vid: viewerId() }); $("#co-status").textContent = ""; }
    catch { $("#co-status").textContent = "Could not reach the news service. Showing what this browser remembers."; }
    finally { coLoading = false; }
    if (state.view === "companies") renderCompanies();
  }
  // Fund or corporate: the company's own choice if the reader set one, otherwise a guess from the
  // fund list behind the Sponsor tag (data/sponsors.json) and names such as "... Capital".
  let sponsorWords = null;
  async function loadSponsors() { if (!sponsorWords) sponsorWords = await getJSON(dataUrl("sponsors.json")).catch(() => []); }
  const FUND_NAME = /\b(capital|partners|equity|funds?|investments?|investors|asset management)\b|ファンド|キャピタル|パートナーズ|インベストメント/i;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function wordHit(text, w) {
    if (w.startsWith("cs:")) return new RegExp("(?<![A-Za-z])" + reEsc(w.slice(3)) + "(?![A-Za-z])").test(text);
    if (w.startsWith("re:")) { try { return new RegExp(w.slice(3), "i").test(text); } catch { return false; } }
    const lw = w.toLowerCase(), lt = text.toLowerCase();
    if (!/^[\x00-\x7f]*$/.test(lw)) return lt.includes(lw);
    return new RegExp("(?<![a-z])" + reEsc(lw) + "(?![a-z])").test(lt);
  }
  function kindOf(c, searched) {
    if (c.kind === "fund" || c.kind === "corp") return c.kind;
    const names = [...c.name.split(/[,、]/), ...(searched || [])].map(s => s.trim()).filter(Boolean);
    if (names.some(n => FUND_NAME.test(n))) return "fund";
    return (sponsorWords || []).some(w => names.some(n => wordHit(n, w))) ? "fund" : "corp";
  }
  const coKey = (c) => (c.name.split(/[,、]/).map(x => x.trim()).filter(Boolean).join(",") + "#" + c.keywords.map(x => x.trim()).join(",")).toLowerCase();

  /* The search list (data/company_index.json, rebuilt weekly): every listed Japanese company from
     the FSA's EDINET code list and every US-listed ticker from the SEC. Loaded on first use. */
  let coIndex = null, coIndexLoading = null;
  function loadCompanyIndex() {
    if (coIndex) return Promise.resolve(coIndex);
    return coIndexLoading || (coIndexLoading = getJSON(dataUrl("company_index.json")).catch(() => ({ rows: [] }))
      .then(d => (coIndex = (d.rows || []).map(r => ({ ...r, ln: r.n.toLowerCase(), le: (r.e || "").toLowerCase(), lt: r.t.toLowerCase() })))));
  }
  function searchCompanies(q) {
    q = q.trim().toLowerCase();
    if (!q || !coIndex) return [];
    const tiers = [[], [], [], []];   // ticker exact, ticker prefix, name prefix, name contains
    for (const r of coIndex) {
      if (r.lt === q) tiers[0].push(r);
      else if (r.lt.startsWith(q)) tiers[1].push(r);
      else if (r.ln.startsWith(q) || r.le.startsWith(q)) tiers[2].push(r);
      else if (q.length > 1 && (r.ln.includes(q) || r.le.includes(q))) tiers[3].push(r);
    }
    return tiers.flat().slice(0, 8);
  }
  const EXCHANGE_TV = { NYSE: "NYSE", Nasdaq: "NASDAQ", "NYSE American": "AMEX", CBOE: "CBOE" };
  const listingLabel = (c) => c.market === "JP" ? `${c.ticker} · TSE` : c.market === "US" ? `${c.ticker} · ${c.exchange || "US"}` : "";
  // The 33 TSE industries as EDINET names them, in English for an English page.
  const JP_SECTOR = { "水産・農林業": "Fishery & Agriculture", "鉱業": "Mining", "建設業": "Construction", "食料品": "Foods",
    "繊維製品": "Textiles", "パルプ・紙": "Pulp & Paper", "化学": "Chemicals", "医薬品": "Pharmaceuticals",
    "石油・石炭製品": "Oil & Coal Products", "ゴム製品": "Rubber Products", "ガラス・土石製品": "Glass & Ceramics",
    "鉄鋼": "Iron & Steel", "非鉄金属": "Nonferrous Metals", "金属製品": "Metal Products", "機械": "Machinery",
    "電気機器": "Electric Appliances", "輸送用機器": "Transportation Equipment", "精密機器": "Precision Instruments",
    "その他製品": "Other Products", "電気・ガス業": "Electric Power & Gas", "陸運業": "Land Transportation",
    "海運業": "Marine Transportation", "空運業": "Air Transportation", "倉庫・運輸関連業": "Warehousing",
    "情報・通信業": "Information & Communication", "卸売業": "Wholesale Trade", "小売業": "Retail Trade", "銀行業": "Banks",
    "証券、商品先物取引業": "Securities & Commodities", "保険業": "Insurance", "その他金融業": "Other Financing",
    "不動産業": "Real Estate", "サービス業": "Services" };
  // Legal suffixes make a poor news query ("KKR & Co. Inc."); drop them from a picked US name.
  const plainUS = (n) => n.replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|plc|PLC|L\.?P\.?|N\.V\.|S\.A\.|AG|SE|Holdings?,? Inc\.?)$/i, "").trim();
  const pickFields = (r) => ({ market: r.m, ticker: r.t, cik: r.c || "", exchange: r.x || "", sector: r.m === "JP" ? (JP_SECTOR[r.s] || r.s || "") : "" });
  // An already-added company with no listing: link it when the name is exactly a ticker or a
  // listed name. Anything less certain waits for the reader to pick from the list.
  function autoListing(c) {
    if (c.market || !coIndex) return null;
    const first = c.name.split(/[,、]/)[0].trim().toLowerCase();
    const hits = coIndex.filter(r => r.lt === first || r.ln === first || r.le === first || (r.m === "US" && plainUS(r.n).toLowerCase() === first));
    return hits.length === 1 ? hits[0] : null;
  }

  // Suggestions under a text box: type a name or a ticker, pick with a click or the arrow keys.
  function attachSuggest(input, onPick) {
    const wrap = document.createElement("div"); wrap.className = "co-suggest-wrap";
    input.replaceWith(wrap); wrap.append(input);
    const ul = document.createElement("ul"); ul.className = "co-suggest"; ul.hidden = true; ul.setAttribute("role", "listbox");
    wrap.append(ul);
    let rows = [], at = -1;
    const close = () => { ul.hidden = true; at = -1; };
    const draw = () => {
      ul.textContent = "";
      rows.forEach((r, i) => {
        const li = document.createElement("li"); li.setAttribute("role", "option"); if (i === at) li.className = "on";
        const t = document.createElement("span"); t.className = "sg-t"; t.textContent = r.t;
        const n = document.createElement("span"); n.className = "sg-n"; n.textContent = r.n;
        const m = document.createElement("span"); m.className = "sg-m";
        m.textContent = r.m === "JP" ? ["TSE", JP_SECTOR[r.s] || r.s].filter(Boolean).join(" · ") : (r.x || "US");
        li.append(t, n, m);
        li.addEventListener("mousedown", ev => { ev.preventDefault(); pick(r); });
        ul.append(li);
      });
      ul.hidden = !rows.length;
    };
    const pick = (r) => { input.value = r.m === "US" ? plainUS(r.n) : r.n; input.dataset.pick = JSON.stringify(r); close(); onPick && onPick(r); };
    input.addEventListener("input", () => {
      delete input.dataset.pick;
      loadCompanyIndex().then(() => { rows = searchCompanies(input.value); at = -1; draw(); });
    });
    input.addEventListener("keydown", ev => {
      if (ul.hidden) return;
      if (ev.key === "ArrowDown") { at = Math.min(rows.length - 1, at + 1); draw(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { at = Math.max(0, at - 1); draw(); ev.preventDefault(); }
      else if (ev.key === "Enter" && at >= 0) { pick(rows[at]); ev.preventDefault(); }
      else if (ev.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    return input;
  }
  const picked = (input) => { try { return input.dataset.pick ? JSON.parse(input.dataset.pick) : null; } catch { return null; } };

  const money = (v) => {
    const a = Math.abs(v), s = v < 0 ? "−$" : "$";
    return a >= 1e9 ? s + (a / 1e9).toFixed(a >= 1e11 ? 0 : 1) + "bn" : a >= 1e6 ? s + Math.round(a / 1e6) + "m" : s + Math.round(a).toLocaleString();
  };
  // US figures, exactly as filed with the SEC (10-K): no estimates, no market prices.
  function factsLines(f) {
    const out = [];
    if (f.sic) out.push(f.sic.replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase()));
    const rev = f.revenue || [];
    if (rev.length) {
      let s = `Revenue FY${rev[0].end.slice(0, 4)} ${money(rev[0].val)}`;
      if (rev[1] && rev[1].val) { const g = (rev[0].val / rev[1].val - 1) * 100; s += ` (${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(0)}% YoY)`; }
      out.push(s);
    }
    const bits = [];
    if (f.operating_income && f.operating_income[0]) bits.push("Op. income " + money(f.operating_income[0].val));
    if (f.net_income && f.net_income[0]) bits.push("Net income " + money(f.net_income[0].val));
    if (bits.length) out.push(bits.join(" · "));
    return out;
  }
  // One click to the places a reader would look next; the page does not try to be them.
  function listingLinks(c) {
    const T = encodeURIComponent(c.ticker);
    const L = c.market === "JP"
      ? [["IR BANK", `https://irbank.net/${T}`], ["Kabutan", `https://kabutan.jp/stock/?code=${T}`],
         ["Yahoo!ファイナンス", `https://finance.yahoo.co.jp/quote/${T}.T`], ["TradingView", `https://www.tradingview.com/symbols/TSE-${T}/`]]
      : [["Yahoo Finance", `https://finance.yahoo.com/quote/${T}`], ["SEC filings", `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(c.cik || "")}`],
         ["TradingView", `https://www.tradingview.com/symbols/${EXCHANGE_TV[c.exchange] || "NYSE"}-${T}/`]];
    const p = document.createElement("p"); p.className = "co-links";
    L.forEach(([label, href]) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; p.append(a); });
    return p;
  }
  function setListing(i, r) {
    const list = companies(); list[i] = { ...list[i], ...pickFields(r) };
    store.set("companies", list); renderCompanies(); queueSync(0);
    if (r.m === "US") { setTimeout(loadCompanies, 8000); setTimeout(loadCompanies, 25000); }
  }

  function renderCompanies() {
    const ol = $("#co-list"); ol.textContent = "";
    const mine = companies();
    const sv = store.get("coSub", "news"), sub = sv === "profile" || sv === "price" ? sv : "news";
    $$(".co-sub .chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sub === sub)));
    ol.hidden = sub !== "news" && mine.length > 0;
    $("#co-profile").hidden = !(sub === "profile" && mine.length > 0);
    $("#co-price").hidden = !(sub === "price" && mine.length > 0);
    if (!mine.length) { ol.hidden = false; ol.append(empty("No companies yet. Add one above; keywords narrow it to the news you care about.")); return; }
    const remote = new Map(((coData && coData.companies) || []).map(c => [coKey(c), c]));
    // companies added before the search list existed: link the unambiguous ones once
    if (coIndex) {
      let changed = false;
      const list = mine.map(c => { const r = autoListing(c); if (r) { changed = true; return { ...c, ...pickFields(r) }; } return c; });
      if (changed) { store.set("companies", list); queueSync(0); return renderCompanies(); }
    } else loadCompanyIndex().then(() => { if (state.view === "companies") renderCompanies(); });
    if (sponsorWords === null && sub !== "news") loadSponsors().then(() => { if (state.view === "companies") renderCompanies(); });   // Fund or Corporate needs the sponsor list
    if (sub === "profile") { renderProfile(mine, remote); return; }
    if (sub === "price") { renderPrice(mine, remote); return; }
    mine.forEach((c, i) => {
      const r = remote.get(coKey(c));
      const kind = kindOf(c, r && r.searched);
      const li = document.createElement("li"); li.className = "fl-row co-row kind-" + kind;
      const card = document.createElement("div"); card.className = "co-card";
      const h = document.createElement("h3"); h.className = "co-name"; h.textContent = c.name.split(/[,、]/)[0].trim();
      if (c.market) { const t = document.createElement("span"); t.className = "co-ticker"; t.textContent = listingLabel(c); h.append(t); }
      const also = (r && r.searched || []).slice(1);
      const meta = document.createElement("p"); meta.className = "panel-meta";
      meta.textContent = also.length ? "Also searching: " + also.join(", ") : "";
      // what it is: the sector, and for a US company its last filed figures
      const facts = document.createElement("div"); facts.className = "co-facts";
      const lines = [];
      if (c.market === "JP" && c.sector) lines.push(c.sector);
      if (c.market === "US" && r && r.facts) lines.push(...factsLines(r.facts));
      lines.forEach(t => { const p = document.createElement("p"); p.textContent = t; facts.append(p); });
      if (c.market === "US" && r && r.facts && r.facts.revenue) { const s = document.createElement("p"); s.className = "co-src"; s.textContent = "As filed with the SEC (10-K)"; facts.append(s); }
      if (c.market === "US" && !(r && r.facts)) { const p = document.createElement("p"); p.className = "co-src"; p.textContent = "SEC figures arrive within a few minutes."; facts.append(p); }
      // Keywords one by one: × drops one, the box below adds one (or several, comma separated).
      const kw = document.createElement("div"); kw.className = "co-kw";
      if (!c.keywords.length) { const s = document.createElement("span"); s.className = "chip co-chip"; s.textContent = "All news"; kw.append(s); }
      c.keywords.forEach((k, j) => {
        const s = document.createElement("span"); s.className = "chip co-chip"; s.textContent = k;
        const x = document.createElement("button"); x.type = "button"; x.className = "co-chip-x"; x.textContent = "×";
        x.title = x.ariaLabel = "Remove keyword " + k;
        x.addEventListener("click", () => setKeywords(i, c.keywords.filter((_, n) => n !== j)));
        s.append(x); kw.append(s);
      });
      const add = document.createElement("form"); add.className = "co-kw-add";
      const inp = document.createElement("input"); inp.maxLength = 120; inp.autocomplete = "off";
      inp.placeholder = "Add a keyword"; inp.setAttribute("aria-label", "Add a keyword for " + c.name);
      const go = document.createElement("button"); go.type = "submit"; go.className = "co-kw-go"; go.textContent = "＋ Add";
      const msg = document.createElement("p"); msg.className = "panel-meta co-kw-msg";
      add.append(inp, go, msg);
      add.addEventListener("submit", ev => {
        ev.preventDefault();
        const more = inp.value.split(/[,、]/).map(s => s.trim()).filter(Boolean);
        if (!more.length) return;
        const next = [...c.keywords];
        more.forEach(k => { if (!next.some(o => o.toLowerCase() === k.toLowerCase())) next.push(k); });
        if (next.length > 8) { msg.textContent = "Up to 8 keywords."; return; }
        msg.textContent = setKeywords(i, next);
      });
      const foot = document.createElement("p"); foot.className = "panel-meta";
      foot.textContent = r && r.updated ? "Updated " + agoText(r.updated) : "First headlines arrive within a few minutes.";
      const acts = document.createElement("p"); acts.className = "co-acts";
      const kb = document.createElement("button"); kb.type = "button"; kb.className = "link-btn";
      kb.textContent = kind === "fund" ? "Mark as corporate" : "Mark as fund";
      kb.addEventListener("click", () => {
        const list = companies(); list[i] = { ...list[i], kind: kind === "fund" ? "corp" : "fund" };
        store.set("companies", list); renderCompanies();
      });
      const rm = document.createElement("button"); rm.className = "link-btn"; rm.type = "button"; rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        store.set("companies", companies().filter((_, j) => j !== i)); updateCounts(); renderCompanies(); queueSync(200);
      });
      acts.append(kb, rm);
      card.append(h, meta, facts);
      if (c.market) card.append(listingLinks(c));
      else {
        // not linked to a listing yet: let the reader pick it, which adds the ticker and links
        const lf = document.createElement("div"); lf.className = "co-link-pick";
        const li2 = document.createElement("input"); li2.placeholder = "Find its ticker (name or code)"; li2.autocomplete = "off";
        li2.setAttribute("aria-label", "Find the listing for " + c.name);
        lf.append(li2); card.append(lf);
        attachSuggest(li2, row => setListing(i, row));
      }
      card.append(kw, add, foot, acts);
      // With keywords, only headlines that name one of them: Google matches article bodies too,
      // which lets in stories that are not about the keyword at all.
      const news = r ? (r.news || []).filter(x => state.lang !== "en" || !isJa(x))
        .map(x => ({ date: x.published && x.published.slice(0, 10), title: x.title, url: x.link, source: x.source,
          tags: c.keywords.filter(k => wordHit(x.title, k)) }))
        .filter(x => !c.keywords.length || x.tags.length) : null;
      const rule = document.createElement("div"); rule.className = "co-rule"; rule.setAttribute("aria-hidden", "true");
      li.append(card, rule, flColumn("Latest", news, r ? (c.keywords.length ? "No headlines with these keywords in the last 45 days." : "No headlines in the last 45 days.") : "Fetching…"));
      ol.append(li);
    });
  }

  /* ---------------- Companies > Profile ----------------
     One row per company from companies[i].profile (Apps Script). Opening a row loads the TradingView
     widgets for that company only. */
  const pfOpen = new Set();
  const TIER = { official: "Official", machine: "Machine", vendor: "Vendor" };
  function conf(kind) { const s = document.createElement("span"); s.className = "pf-conf t-" + kind; s.textContent = TIER[kind]; return s; }
  function fmtAmt(cur, v) {
    if (v == null || isNaN(v)) return "n/a";
    const sym = cur === "JPY" ? "¥" : "$", a = Math.abs(v), sg = v < 0 ? "−" : "";
    const u = a >= 1e12 ? [1e12, "tn", 2] : a >= 1e9 ? [1e9, "bn", 1] : a >= 1e6 ? [1e6, "M", 1] : null;
    return sg + sym + (u ? (a / u[0]).toFixed(u[2]) + u[1] : Math.round(a).toLocaleString());
  }
  // the profile from the script, or, for a US company without one yet, the filed figures it already sends
  function profileOf(c, r) {
    if (r && r.profile) return r.profile;
    if (c.market === "US" && r && r.facts && r.facts.revenue) {
      const f = r.facts;
      return { market: "US", ticker: c.ticker, sector: f.sic ? f.sic.replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase()) : "",
        fin: { currency: "USD", basis: "us-gaap", revenue: f.revenue, operating_income: f.operating_income || [], net_income: f.net_income || [], source: "SEC" },
        holders: null, defense: null, status: "ok", _fallback: true };
    }
    return null;
  }
  // display-only tidy of a shareholder name: NFKC (㈱ to (株)), drop the "(常任代理人 ...)" agent, one space
  function tidyHolder(raw) {
    let s = String(raw || "").normalize("NFKC"), agent = "";
    const i = s.indexOf("(常任代理人");
    if (i >= 0) {
      let d = 0, j = i;
      for (; j < s.length; j++) { if (s[j] === "(") d++; else if (s[j] === ")" && --d === 0) break; }
      agent = s.slice(i + 1, j).replace(/^常任代理人\s*/, "").trim();
      s = s.slice(0, i) + s.slice(j + 1);
    }
    return { name: s.replace(/\s+/g, " ").trim(), agent };
  }
  const NOTE_SHORT = { "Pick the company from the search list to get its profile": "Not linked · pick from list" };
  const cell = (tr, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; tr.append(td); return td; };
  function renderProfile(mine, remote) {
    const wrap = $("#co-profile"); wrap.textContent = "";
    const t = document.createElement("table"); t.className = "pf-table";
    t.innerHTML = "<thead><tr><th>Company</th><th>Sector</th><th class='num'>Revenue</th><th class='num'>Op. income</th><th class='num'>Net income</th><th class='num'>Rev. growth</th><th>Top holders</th><th>Takeover defense</th></tr></thead>";
    const cg = document.createElement("colgroup");
    ["pc-name", "pc-sec", "pc-num", "pc-num", "pc-num", "pc-gr", "pc-hold", "pc-def"].forEach(c => { const e = document.createElement("col"); e.className = c; cg.append(e); });
    t.prepend(cg);
    const tb = document.createElement("tbody");
    mine.forEach(c => {
      const key = coKey(c), r = remote.get(key), p = profileOf(c, r), f = p && p.fin;
      const tr = document.createElement("tr"); tr.className = "pf-row kind-" + kindOf(c, r && r.searched) + (pfOpen.has(key) ? " open" : "");
      const n = cell(tr);
      const nb = document.createElement("button"); nb.type = "button"; nb.className = "pf-name";
      const nm = c.name.split(/[,、]/)[0].trim(), nt = document.createElement("span"); nt.className = "pf-nt"; nt.textContent = nm; nb.title = nm; nb.append(nt);
      nb.setAttribute("aria-expanded", String(pfOpen.has(key)));
      n.append(nb);
      const tk = (p && p.ticker) || c.ticker, mk = (p && p.market) || c.market;
      if (tk) { const s = document.createElement("span"); s.className = "pf-tk"; s.textContent = tk + (mk ? " · " + mk : ""); n.append(s); }
      const na = (td) => { td.textContent = "n/a"; td.classList.add("pf-na"); };
      const note = (txt) => { const s = document.createElement("span"); s.className = "pf-note"; s.title = txt; s.textContent = NOTE_SHORT[txt] || txt; return s; };
      if (!p) {
        const td = cell(tr, "pf-pend"); td.colSpan = 7; td.textContent = "Profile pending";
      } else {
        const sec = cell(tr, "pf-sec"), sv = p.sector || c.sector;
        if (sv) { sec.textContent = sv; sec.title = sv; } else na(sec);
        const cur = f && f.currency;
        [f && f.revenue, f && f.operating_income, f && f.net_income].forEach((arr, k) => {
          const td = cell(tr, "num");
          if (f && arr && arr[0]) { td.textContent = fmtAmt(cur, arr[0].val); td.append(conf("official")); td.title = "Year ended " + arr[0].end; }
          else na(td);
        });
        const g = cell(tr, "num"), rv = f && f.revenue;
        if (rv && rv[0] && rv[1] && rv[1].val) { const x = (rv[0].val / rv[1].val - 1) * 100; g.textContent = (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%"; g.append(conf("official")); }
        else na(g);
        const h = cell(tr), hs = p.holders;
        if (hs && hs.list && hs.list.length) {
          hs.list.slice(0, 3).forEach(x => {
            const tn = tidyHolder(x.name), s = document.createElement("span"); s.className = "pf-hold"; s.title = String(x.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
            const a = document.createElement("span"); a.className = "pf-hn"; a.textContent = tn.name;
            const b = document.createElement("span"); b.className = "pf-hp"; b.textContent = x.pct != null ? x.pct + "%" : "";
            s.append(a, b); h.append(s);
          });
          h.append(conf("official"));
        } else na(h);
        const d = cell(tr), df = p.defense;
        if (df) {
          const s = document.createElement("span"); const fl = df.flag === "none_found" ? "none found" : (df.flag || "unknown");
          s.className = "pf-def " + (df.flag || "unknown"); s.textContent = fl; d.append(s, conf("machine"));
        } else na(d);
        if (p.status === "pending" || p.status === "error") n.append(note(p.status_note || (p.status === "error" ? "Profile could not be built." : "Profile pending")));
        if (p._fallback) n.append(note("Filed figures only; the rest is pending."));
      }
      const det = document.createElement("tr"); det.className = "pf-detail"; det.hidden = !pfOpen.has(key);
      const dtd = document.createElement("td"); dtd.colSpan = 8; det.append(dtd);
      if (pfOpen.has(key)) fillDetail(dtd, p, c);
      const toggle = () => {
        const open = !pfOpen.has(key);
        open ? pfOpen.add(key) : pfOpen.delete(key);
        tr.classList.toggle("open", open); nb.setAttribute("aria-expanded", String(open)); det.hidden = !open;
        if (open && !dtd.firstChild) fillDetail(dtd, p, c);
      };
      tr.addEventListener("click", ev => { if (ev.target.closest("a")) return; toggle(); });
      tb.append(tr, det);
    });
    t.append(tb); wrap.append(t);
  }
  /* ---------------- Companies > Price ----------------
     One card per linked company. Tokyo-listed: a range chart drawn here from the annual report
     (high to low of each of the last five years, the estimated year-end price as a line) plus the
     estimates under it. US-listed: TradingView's chart (loaded only once the card scrolls into view)
     and the public float from the 10-K cover. The figures sit in data/jp_profiles and data/us_profiles
     (same site, so they are read straight from there; the Apps Script copy is only a fallback). */
  const pxCache = new Map();
  const RESERVED_FILE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  function pxLoad(c, p) {
    const mk = (p && p.market) || c.market, tk = (p && p.ticker) || c.ticker;
    if (!mk || !tk) return Promise.resolve(null);
    const key = mk + ":" + tk;
    if (!pxCache.has(key)) {
      const url = DATA_BASE + (mk === "JP" ? "jp_profiles/" : "us_profiles/") + encodeURIComponent(tk) + (mk === "US" && RESERVED_FILE.test(tk) ? "_" : "") + ".json?v=" + ASSET_V;
      pxCache.set(key, fetch(url).then(r => r.ok ? r.json() : null).then(j => (j && j.price) || null).catch(() => null));
    }
    return pxCache.get(key).then(px => px || (p && p.price) || null);
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (text != null) e.textContent = text;
    return e;
  }
  function hEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayText(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return m ? (+m[3]) + " " + MON[+m[2] - 1] + " " + m[1] : ""; }
  function niceAxis(lo, hi, n) {
    const span = Math.max(hi - lo, hi * 0.05, 1), raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const a = Math.max(0, Math.floor(lo / step) * step), b = Math.ceil(hi / step) * step, ticks = [];
    for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }
  const yen = (v) => v == null ? "n/a" : "¥" + (v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
  function pxChart(years, asOfLabel) {
    const W = 480, H = 232, L = 56, R = 12, T = 16, B = 38, n = years.length;
    const vals = years.flatMap(y => [y.high, y.low, y.est_close]).filter(v => v != null);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "px-svg", role: "img", preserveAspectRatio: "xMidYMid meet" });
    svg.setAttribute("aria-label", "Yearly share price range and estimated year-end price, in yen, " + asOfLabel);
    if (!vals.length || !n) { svg.append(svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "px-axis" }, "No price history in the filing")); return svg; }
    const ticks = niceAxis(Math.min(...vals) * 0.92, Math.max(...vals) * 1.05, 5), lo = ticks[0], hi = ticks[ticks.length - 1];
    const yv = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo)), slot = (W - L - R) / n, bw = Math.min(30, slot * 0.46);
    ticks.forEach(t => {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: yv(t), y2: yv(t), class: "px-grid-line" }));
      svg.append(svgEl("text", { x: L - 6, y: yv(t) + 3.5, "text-anchor": "end", class: "px-axis" }, yen(t)));
    });
    const pts = [];
    years.forEach((y, i) => {
      const cx = L + slot * (i + 0.5), yr = y.fy_end.slice(0, 4), mo = MON[+y.fy_end.slice(5, 7) - 1];
      svg.append(svgEl("text", { x: cx, y: H - B + 14, "text-anchor": "middle", class: "px-axis px-axis-x" }, "FY" + yr));
      svg.append(svgEl("text", { x: cx, y: H - B + 26, "text-anchor": "middle", class: "px-axis px-axis-m" }, "year to " + mo));
      if (y.high != null && y.low != null) {
        const bar = svgEl("rect", { x: cx - bw / 2, y: yv(y.high), width: bw, height: Math.max(yv(y.low) - yv(y.high), 2), class: "px-bar" });
        bar.append(svgEl("title", {}, "FY" + yr + " high " + yen(y.high) + " / low " + yen(y.low)));
        svg.append(bar);
      }
      if (y.est_close != null) pts.push([cx, yv(y.est_close), y]);
    });
    if (pts.length > 1) svg.append(svgEl("polyline", { points: pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" "), class: "px-line" }));
    pts.forEach(([x, y, d]) => {
      const dot = svgEl("circle", { cx: x, cy: y, r: 4, class: "px-dot" });
      dot.append(svgEl("title", {}, "FY" + d.fy_end.slice(0, 4) + " estimated year-end price " + yen(d.est_close) + " (PER " + (d.per != null ? d.per : "n/a") + " × EPS " + (d.eps != null ? d.eps : "n/a") + ")"));
      svg.append(dot);
      svg.append(svgEl("text", { x, y: y - 8, "text-anchor": "middle", class: "px-val" }, Math.round(d.est_close).toLocaleString("en-US")));
    });
    return svg;
  }
  function pxCell(label, value, tier, sub) {
    const d = hEl("div", "px-cell"); d.append(hEl("span", "px-k", label));
    const v = hEl("span", "px-v", value); if (tier) v.append(conf(tier)); d.append(v);
    if (sub) d.append(hEl("span", "px-sub", sub));
    return d;
  }
  function pxHead(c, p) {
    const h = hEl("div", "px-head"), nm = c.name.split(/[,、]/)[0].trim();
    const t = hEl("span", "px-name", nm); t.title = nm; h.append(t);
    const tk = (p && p.ticker) || c.ticker, mk = (p && p.market) || c.market;
    if (tk) h.append(hEl("span", "px-tk", tk + (mk ? " · " + mk : "")));
    return h;
  }
  function pxFillJP(card, c, p, px) {
    const asOf = dayText(px.as_of), fy = "FY" + (px.as_of || "").slice(0, 4);
    card.append(pxChart(px.years || [], asOf));
    const lg = hEl("p", "px-legend"); lg.append(hEl("span", "px-key px-key-bar"), " High to low in the year   ", hEl("span", "px-key px-key-dot"), " Estimated year-end price (PER × EPS)");
    card.append(lg);
    card.append(hEl("p", "px-asof", "As of " + fy + " end (" + asOf + "), estimated from the annual report"));
    const g = hEl("div", "px-cells");
    g.append(pxCell("Est. price", yen(px.est_price), px.est_price != null ? "machine" : null, "as of " + fy + " end (est.)"),
      pxCell("Est. market cap", px.est_mcap != null ? fmtAmt("JPY", px.est_mcap) : "n/a", px.est_mcap != null ? "machine" : null, "as of " + fy + " end (est.)"),
      pxCell("P/E", px.per != null ? px.per.toFixed(1) + "×" : "n/a", px.per != null ? "official" : null, "as reported, " + fy + " end"),
      pxCell("P/B", px.pbr != null ? px.pbr.toFixed(2) + "×" : "n/a", px.pbr != null ? "machine" : null, "as of " + fy + " end (est.)"),
      pxCell("TSR (5y)", px.tsr != null ? px.tsr.toFixed(0) + "%" : "n/a", px.tsr != null ? "official" : null, px.tsr_index != null ? "index " + px.tsr_index.toFixed(0) + "%" : "as reported"),
      pxCell("Shares out", px.shares_out != null ? (px.shares_out / 1e6 >= 1000 ? (px.shares_out / 1e9).toFixed(2) + "bn" : (px.shares_out / 1e6).toFixed(0) + "M") : "n/a", null, "excl. treasury, " + fy + " end"));
    card.append(g);
    (px.notes || []).forEach(t => card.append(hEl("p", "px-note", t)));
    const T = encodeURIComponent((p && p.ticker) || c.ticker);
    const ln = hEl("p", "px-links", "Today's price: ");
    [["株探", `https://kabutan.jp/stock/?code=${T}`], ["Yahoo!ファイナンス", `https://finance.yahoo.co.jp/quote/${T}.T`], ["TradingView", `https://www.tradingview.com/symbols/TSE-${T}/`]]
      .forEach(([l, u], i) => { if (i) ln.append("  "); ln.append(srcLink(l, u)); });
    if (px.url) { ln.append("   Filing: "); ln.append(srcLink("EDINET", px.url)); }
    card.append(ln);
  }
  function pxFillUS(card, c, p, px) {
    const sym = px.tv_symbol || (p && p.tv_symbol) || "";
    const host = hEl("div", "px-tv");
    if (sym) {
      card.append(host);
      const go = () => tvWidget(host, "mini-symbol-overview", { symbol: sym, width: "100%", height: 220, locale: "en", dateRange: "12M", colorTheme: isDarkPage() ? "dark" : "light", isTransparent: true, autosize: false, chartOnly: false });
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: "200px" });
        io.observe(host);
      } else go();
    } else card.append(hEl("p", "px-note", "No chart: the exchange of this ticker is not mapped."));
    const g = hEl("div", "px-cells px-cells-1");
    const fl = px.public_float;
    g.append(pxCell("Public float (non-affiliates)", fl ? fmtAmt("USD", fl) : "n/a", fl ? "official" : null,
      fl ? "as of " + dayText(px.as_of) + " (10-K cover, end of the second fiscal quarter)" : "not stated on a 10-K cover"));
    card.append(g);
    const ln = hEl("p", "px-links", "Chart by TradingView, delayed; not stored here.");
    if (px.url) { ln.append("   Filing: "); ln.append(srcLink("SEC", px.url)); }
    card.append(ln);
  }
  function renderPrice(mine, remote) {
    const wrap = $("#co-price"); wrap.textContent = "";
    const grid = hEl("div", "px-grid"), skipped = [];
    mine.forEach(c => {
      const r = remote.get(coKey(c)), p = profileOf(c, r), mk = (p && p.market) || c.market, tk = (p && p.ticker) || c.ticker;
      if (!mk || !tk) { skipped.push(c.name.split(/[,、]/)[0].trim()); return; }
      const card = hEl("article", "px-card kind-" + kindOf(c, (remote.get(coKey(c)) || {}).searched)); card.append(pxHead(c, p));
      const body = hEl("div", "px-body"); body.append(hEl("p", "px-note", "Loading…")); card.append(body);
      grid.append(card);
      pxLoad(c, p).then(px => {
        body.textContent = "";
        if (!px) { body.append(hEl("p", "px-note", mk === "JP" ? "No annual report figures yet for this ticker." : "No SEC price data yet for this ticker.")); return; }
        if (px.kind === "jp_fy") pxFillJP(body, c, p, px); else if (px.kind === "us_float") pxFillUS(body, c, p, px);
      });
    });
    wrap.append(grid);
    if (skipped.length) wrap.append(hEl("p", "px-skip", "Not linked to a listing, so no price: " + skipped.join(", ") + ". Pick the company from the search list to link it."));
  }

  function srcLink(label, url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; return a; }
  /* Five-year financials chart for the Financials box: same hand-made SVG as the price chart above.
     Top panel = revenue bars with the change on the year before; bottom panel = operating income and net
     income side by side (a loss hangs below the zero line). A year with no value has no bar. */
  function finPeriods(f) {
    const ends = [...new Set(["revenue", "operating_income", "net_income"].flatMap(k => (f[k] || []).map(x => x.end)))].sort();
    const groups = [];
    ends.forEach(e => {                      // the same fiscal year can carry end dates a few days apart
      const g = groups[groups.length - 1];
      if (g && (new Date(e) - new Date(g[g.length - 1])) / 864e5 <= 20) g.push(e); else groups.push([e]);
    });
    const get = (k, g) => { const x = (f[k] || []).find(y => g.includes(y.end)); return x && x.val != null ? x.val : null; };
    return groups.slice(-5).map(g => ({ end: g[g.length - 1], revenue: get("revenue", g), op: get("operating_income", g), ni: get("net_income", g) }));
  }
  function signedTicks(lo, hi, n) {
    const t = niceAxis(0, Math.max(hi, -lo, 1e-9), n), step = t[1] - t[0], out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function finChart(f) {
    const per = finPeriods(f), n = per.length;
    if (!f || n < 2) return null;
    const hasRev = per.some(p => p.revenue != null), hasOp = per.some(p => p.op != null), hasNi = per.some(p => p.ni != null);
    if (!hasRev && !hasOp && !hasNi) return null;
    const cur = f.currency, W = 480, L = 62, R = 10, slot = (W - L - R) / n, cx = (i) => L + slot * (i + 0.5);
    const panels = (hasRev ? 1 : 0) + (hasOp || hasNi ? 1 : 0), PH = 96, GAP = 38, T0 = 24, H = T0 + panels * PH + (panels - 1) * GAP + 40;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "px-svg fin-svg", role: "img", preserveAspectRatio: "xMidYMid meet" });
    svg.setAttribute("aria-label", "Revenue, operating income and net income over the last " + n + " fiscal years");
    let top = T0;
    const fy = (e) => "FY" + e.slice(0, 4);
    const axis = (ticks, yv) => ticks.forEach(t => {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: yv(t), y2: yv(t), class: t === 0 ? "px-grid-line fin-zero" : "px-grid-line" }));
      svg.append(svgEl("text", { x: L - 6, y: yv(t) + 3.5, "text-anchor": "end", class: "px-axis" }, t === 0 ? "0" : fmtAmt(cur, t)));
    });
    const bar = (x, w, v, yv, cls, label) => {
      const y0 = yv(0), y1 = yv(v), r = svgEl("rect", { x, y: Math.min(y0, y1), width: w, height: Math.max(Math.abs(y1 - y0), 1), class: cls });
      r.append(svgEl("title", {}, label)); svg.append(r);
    };
    if (hasRev) {
      const vals = per.map(p => p.revenue).filter(v => v != null), ticks = niceAxis(0, Math.max(...vals) * 1.02, 3), hi = ticks[ticks.length - 1];
      const yv = (v) => top + PH * (1 - v / hi), bw = Math.min(34, slot * 0.5);
      svg.append(svgEl("text", { x: L, y: top - 12, class: "fin-cap" }, "Revenue and change on the year before"));
      axis(ticks, yv);
      per.forEach((p, i) => {
        if (p.revenue == null) return;
        bar(cx(i) - bw / 2, bw, p.revenue, yv, "fin-bar fin-bar-rev", fy(p.end) + " revenue " + fmtAmt(cur, p.revenue));
        const q = per[i - 1], gap = q ? (new Date(p.end) - new Date(q.end)) / 864e5 : 0;
        if (q && q.revenue > 0 && gap > 300 && gap < 430) {
          const g = (p.revenue / q.revenue - 1) * 100, a = Math.abs(g);
          svg.append(svgEl("text", { x: cx(i), y: yv(p.revenue) - 5, "text-anchor": "middle", class: "px-val" }, (g >= 0 ? "+" : "−") + a.toFixed(a < 10 ? 1 : 0) + "%"));
        }
      });
      top += PH + GAP;
    }
    if (hasOp || hasNi) {
      const vals = per.flatMap(p => [p.op, p.ni]).filter(v => v != null), lo = Math.min(0, ...vals), hiV = Math.max(0, ...vals);
      const ticks = signedTicks(lo * 1.02, hiV * 1.02, 3), tlo = ticks[0], thi = ticks[ticks.length - 1];
      const yv = (v) => top + PH * (1 - (v - tlo) / (thi - tlo)), two = hasOp && hasNi, bw = two ? Math.min(20, slot * 0.34) : Math.min(34, slot * 0.5);
      svg.append(svgEl("text", { x: L, y: top - 12, class: "fin-cap" }, hasOp && hasNi ? "Operating income and net income" : hasOp ? "Operating income" : "Net income"));
      axis(ticks, yv);
      per.forEach((p, i) => {
        const kinds = [["op", p.op, "fin-bar-op", "operating income"], ["ni", p.ni, "fin-bar-ni", "net income"]].filter(k => k[0] === "op" ? hasOp : hasNi);
        kinds.forEach((k, j) => {
          if (k[1] == null) return;
          const x = two ? cx(i) - bw - 0.5 + j * (bw + 1) : cx(i) - bw / 2;
          bar(x, bw, k[1], yv, "fin-bar " + k[2], fy(p.end) + " " + k[3] + " " + fmtAmt(cur, k[1]));
        });
      });
      top += PH;
    }
    per.forEach((p, i) => {
      const mo = MON[+p.end.slice(5, 7) - 1];
      svg.append(svgEl("text", { x: cx(i), y: top + 16, "text-anchor": "middle", class: "px-axis px-axis-x" }, fy(p.end)));
      svg.append(svgEl("text", { x: cx(i), y: top + 28, "text-anchor": "middle", class: "px-axis px-axis-m" }, "year to " + mo));
    });
    const box = hEl("div", "fin-chart"); box.append(svg);
    const lg = hEl("p", "px-legend");
    const key = (cls, txt) => { lg.append(hEl("span", "px-key fin-key " + cls), " " + txt + "   "); };
    if (hasRev) key("fin-bar-rev", "Revenue");
    if (hasOp) key("fin-bar-op", "Operating income");
    if (hasNi) key("fin-bar-ni", "Net income");
    box.append(lg);
    return box;
  }
  function pfBox(title) { const b = document.createElement("div"); b.className = "pf-box"; const h = document.createElement("h4"); h.textContent = title; b.append(h); return b; }
  function pfLine(box, text, url, label) {
    const q = document.createElement("p"); q.textContent = text;
    if (url) { q.append(" "); q.append(srcLink(label || "Source", url)); }
    box.append(q); return q;
  }
  /* ---------------- Profile detail: fixed sections ----------------
     Overview, Price, Financials, Ownership, Takeover defense, Sources, always in this order. Each section has one
     heading style, label/value lists for text, and one last line saying where the numbers come from and as of when. */
  const HK_LABEL = { custody: "Custody / trust banks", fund: "Funds & investors", bank: "Banks & insurers", plan: "Employee & partner plans", corp: "Corporates", other: "Individuals & other" };
  const HK_ORDER = ["custody", "fund", "bank", "plan", "corp", "other"];
  const HK_RX = {
    custody: /日本マスタートラスト|日本カストディ|マスタートラスト|カストディ|信託口|custody|master trust|state street|bank of new york|bny |jpmorgan|j\.p\. morgan|ステート.?ストリート|ジェーピー.?モルガン|バンク.?オブ.?ニューヨーク|デポジタリ|nominee|natscumco|secs lending|chase manhattan/i,
    plan: /持株会|持ち株会|employee (stock|share)|stock ownership plan|esop/i,
    fund: /government of|政府|sovereign|norges bank|gic|temasek|年金積立金|pension|fund|capital|partners|investment|investor|\blp\b|l\.p\.|asset management|vanguard|blackrock|fidelity|invesco|ファンド|投資事業|投資組合|キャピタル|パートナーズ|インベストメント|アセット.?マネジメント|運用|ブラックロック|バンガード/i,
    bank: /銀行|信用金庫|信用組合|生命|保険|証券|共済|信託|bank|insurance|assurance|securities|mutual/i,
    corp: /株式会社|\(株\)|有限会社|合同会社|財団|社団|学校法人|\binc\b|corp|ltd|\bco\.|company|holdings|gmbh|\bplc\b|\bllc\b|s\.a\.|n\.v\./i,
  };
  const HK_GENERIC = new Set(["日本", "ジャパン", "ザ", "the", "グローバル", "インターナショナル", "ユナイテッド", "アメリカ", "トラスト"]);
  function holderKind(name) {
    const n = tidyHolder(name).name, flat = n.replace(/[\s・]/g, "");
    if (HK_RX.custody.test(n) || HK_RX.custody.test(flat)) return "custody";
    if (HK_RX.plan.test(n)) return "plan";
    if (HK_RX.fund.test(n) || HK_RX.fund.test(flat) || (sponsorWords || []).some(w => wordHit(n, w))) return "fund";
    if (HK_RX.bank.test(n) || HK_RX.bank.test(flat)) return "bank";
    if (HK_RX.corp.test(n) || HK_RX.corp.test(flat)) return "corp";
    return "other";
  }
  // Japan only, funds only: two or more funds whose names start with the same word (Japanese names carry no spaces, so the
  // shared start of the name must be at least 4 characters and not a generic word). Conservative: nothing else is bundled.
  function holderGroups(rows) {
    const nm = (r) => r.name.replace(/\s+/g, " ");
    const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++; return a.slice(0, i); };
    const ok = (t) => t.length >= 4 && ![...HK_GENERIC].some(g => t.toLowerCase().startsWith(g)) && (!/^[ -~]+$/.test(t) || /\s/.test(t) || t.length >= 6);
    const funds = rows.filter(r => r.kind === "fund");
    const parent = new Map(funds.map(r => [r, r]));
    const find = (r) => { while (parent.get(r) !== r) r = parent.get(r); return r; };
    const lead = new Map(funds.map(r => [r, null]));
    for (let i = 0; i < funds.length; i++) for (let j = i + 1; j < funds.length; j++) {
      let t = lcp(nm(funds[i]), nm(funds[j]));
      if (/^[ -~]+$/.test(t)) t = t.replace(/\s+\S*$/, "");   // Latin names: whole first word(s) only
      if (!ok(t.trim())) continue;
      parent.set(find(funds[i]), find(funds[j]));
      [funds[i], funds[j]].forEach(r => { const cur = lead.get(r); lead.set(r, cur == null || t.length < cur.length ? t.trim() : cur); });
    }
    const groups = new Map();
    funds.forEach(r => { if (lead.get(r) != null) { const g = groups.get(find(r)) || { members: [], name: lead.get(r) }; g.members.push(r); if (lead.get(r).length < g.name.length) g.name = lead.get(r); groups.set(find(r), g); } });
    groups.forEach(g => { const sum = g.members.reduce((a, r) => a + (r.pct || 0), 0); g.members.forEach(r => { r.group = { name: g.name, sum }; }); });
  }
  const pct1 = (v) => (Math.round(v * 100) / 100).toString() + "%";
  function dl(pairs) {
    const d = hEl("dl", "pf-dl");
    pairs.forEach(([k, v, cls]) => {
      if (v == null || v === "") return;
      d.append(hEl("dt", null, k));
      const dd = hEl("dd", cls || null);
      if (v instanceof Node) dd.append(v); else dd.textContent = v;
      d.append(dd);
    });
    return d;
  }
  function pfSection(title) { const s = hEl("section", "pf-sec-box"); s.append(hEl("h4", "pf-sec-h", title)); return s; }
  function pfFoot(sec, asOf, source, url, extra) {
    const f = hEl("p", "pf-foot");
    f.append((asOf ? "As of " + asOf : "Date not stated") + (source ? " · " + source : "") + (extra ? " · " + extra : "") + " ");
    if (url) f.append(srcLink("Filing", url));
    sec.append(f);
  }
  function monthName(iso) { const m = /^\d{4}-(\d{2})/.exec(iso || ""); return m ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+m[1] - 1] : ""; }
  function legendKeys(items, cls) {
    const lg = hEl("p", "px-legend pf-keys");
    items.forEach(([k, label, extra]) => { const i = hEl("span", "pf-key " + cls + k); lg.append(i, " " + label + (extra ? " " + extra : "") + "   "); });
    return lg;
  }
  function ownersBand(o) {
    const wrap = hEl("div", "ow-wrap");
    const band = (cats, thin) => {
      const b = hEl("div", "ow-band" + (thin ? " thin" : ""));
      cats.forEach(c => { const s = hEl("span", "ow-seg ow-" + c.key); s.style.flexGrow = c.pct; s.title = c.label_en + " " + pct1(c.pct); b.append(s); });
      return b;
    };
    wrap.append(hEl("p", "pf-sub", "Shareholding by holder category, % of shares"), band(o.cats, false), legendKeys(o.cats.map(c => [c.key, c.label_en, pct1(c.pct)]), "ow-"));
    if (o.prior && o.prior.cats && o.prior.cats.length) {
      wrap.append(hEl("p", "pf-sub", "A year earlier (" + o.prior.as_of + ")"), band(o.prior.cats, true));
    }
    return wrap;
  }
  function holderBars(hs, market) {
    const wrap = hEl("div", "hk-wrap");
    const rows = hs.list.map(x => { const tn = tidyHolder(x.name); return { name: tn.name, agent: tn.agent, raw: x.name, pct: x.pct, kind: holderKind(x.name), x }; });
    if (market === "JP") holderGroups(rows);
    const total = rows.reduce((a, r) => a + (r.pct || 0), 0), top = Math.max(...rows.map(r => r.pct || 0), 1e-9);
    const lead = market === "JP" ? "Top " + rows.length + " hold " : "5% holders hold ";
    wrap.append(hEl("p", "pf-sub", lead + pct1(total) + " of the shares"));
    const stack = hEl("div", "hk-stack");
    rows.filter(r => r.pct > 0).forEach(r => { const s = hEl("span", "hk-seg hk-" + r.kind); s.style.flexGrow = r.pct; s.title = r.name + " " + pct1(r.pct); stack.append(s); });
    const rest = hEl("span", "hk-seg hk-rest"); rest.style.flexGrow = Math.max(100 - total, 0); rest.title = "All other holders"; stack.append(rest);
    wrap.append(stack);
    const kinds = HK_ORDER.filter(k => rows.some(r => r.kind === k));
    wrap.append(legendKeys([...kinds.map(k => [k, HK_LABEL[k]]), ["rest", "Everyone else"]], "hk-"));
    const list = hEl("div", "hk-rows");
    rows.forEach(r => {
      const row = hEl("div", "hk-row");
      const nm = hEl("span", "hk-name", r.name); nm.title = r.raw;
      if (r.agent) nm.append(hEl("small", "pf-agent", "  (常任代理人 " + r.agent + ")"));
      const track = hEl("span", "hk-track"), bar = hEl("span", "hk-bar hk-" + r.kind); bar.style.width = ((r.pct || 0) / top * 100).toFixed(1) + "%"; track.append(bar);
      const val = hEl("span", "hk-val", r.pct != null ? pct1(r.pct) : "n/a");
      const ch = hEl("span", "hk-chg");
      const x = r.x;
      if ("prev_pct" in x) {
        if (x.prev_pct == null) { ch.textContent = "New"; ch.classList.add("new"); ch.title = "Not among last year's top ten (" + (hs.prev_as_of || "prior report") + ")"; }
        else if (r.pct != null) {
          const d = Math.round((r.pct - x.prev_pct) * 10) / 10;
          ch.title = "Was " + pct1(x.prev_pct) + (x.prev_date ? " (" + x.prev_date + ")" : hs.prev_as_of ? " (" + hs.prev_as_of + ")" : "");
          if (d > 0) { ch.textContent = "▲" + d.toFixed(1) + "pt"; ch.classList.add("up"); }
          else if (d < 0) { ch.textContent = "▼" + Math.abs(d).toFixed(1) + "pt"; ch.classList.add("down"); }
          
        }
      }
      row.append(nm, track, val, ch);
      if (r.group) { const g = hEl("small", "hk-group", "(" + r.group.name + " group " + pct1(r.group.sum) + ")"); g.title = "Funds whose names start with the same word; shown together, not merged"; nm.append(g); }
      list.append(row);
    });
    wrap.append(list);
    if (hs.dropped && hs.dropped.length) {
      wrap.append(hEl("p", "pf-note2", "Left the top 10: " + hs.dropped.map(d => tidyHolder(d.name).name + (d.prev_pct != null ? " (" + pct1(d.prev_pct) + ")" : "")).join("; ")));
    }
    return wrap;
  }
  function finTable(f) {
    const per = finPeriods(f);
    const t = hEl("table", "fin-table"), hd = hEl("tr");
    hd.append(hEl("th", null, ""));
    per.forEach(p => hd.append(hEl("th", "num", "FY" + p.end.slice(0, 4))));
    const th = hEl("thead"); th.append(hd); t.append(th);
    const tb = hEl("tbody");
    [["Revenue", "revenue"], ["Op. income", "op"], ["Net income", "ni"]].forEach(([lab, k]) => {
      if (!per.some(p => p[k] != null)) return;
      const tr = hEl("tr"); tr.append(hEl("th", null, lab));
      per.forEach(p => { const td = hEl("td", "num", p[k] == null ? "n/a" : fmtAmt(f.currency, p[k])); if (p[k] == null) td.classList.add("pf-na"); td.title = "Year ended " + p.end; tr.append(td); });
      tb.append(tr);
    });
    t.append(tb);
    return t;
  }
  function fillDetail(td, p, c) {
    if (!p) { td.textContent = "Profile pending"; return; }
    if (sponsorWords === null) { loadSponsors().then(() => fillDetail(td, p, c)); return; }   // the fund list decides some holder types
    c = c || {};
    const mk = p.market || c.market, tk = p.ticker || c.ticker, f = p.fin;
    const root = hEl("div", "pf-detail-in");
    // 1 Overview
    const ov = pfSection("Overview");
    const fye = p.period_end || (f && f.revenue && f.revenue[0] && f.revenue[0].end) || "";
    const links = listingLinks({ ...c, ticker: tk, market: mk, cik: c.cik || p.cik });
    ov.append(dl([["Company", (c.name || p.filer || "").split(/[,、]/)[0].trim()], ["Ticker", tk ? tk + (mk ? " · " + mk : "") : ""],
      ["Sector", p.sector || c.sector || ""], ["Fiscal year end", fye ? monthName(fye) + " (latest year ended " + fye + ")" : ""], ["Links", links]]));
    root.append(ov);
    // 2 Price
    const pr = pfSection("Price");
    if (mk === "JP") {
      pr.append(dl([["Chart", "Not shown here: TradingView's embeds do not cover Tokyo-listed stocks. Open a link above."]]));
      pr.append(hEl("p", "pf-foot", "Estimated year-end prices from the annual report are on the Price tab."));
    } else if (p.tv_symbol) {
      const w1 = hEl("div", "pf-tv"), w2 = hEl("div", "pf-tv"), box = hEl("div", "pf-tvbox"); box.append(w1, w2); pr.append(box);
      const theme = isDarkPage() ? "dark" : "light";
      tvWidget(w1, "symbol-info", { symbol: p.tv_symbol, width: "100%", locale: "en", colorTheme: theme, isTransparent: true });
      tvWidget(w2, "mini-symbol-overview", { symbol: p.tv_symbol, width: "100%", height: 220, locale: "en", dateRange: "12M", colorTheme: theme, isTransparent: true, autosize: false, chartOnly: false });
      const ft = hEl("p", "pf-foot"); ft.append("Delayed quotes · TradingView (vendor data, not stored here) ", conf("vendor")); pr.append(ft);
    } else pr.append(dl([["Chart", "No exchange mapped for this ticker."]]));
    root.append(pr);
    // 3 Financials
    const fs = pfSection("Financials");
    if (f) {
      const fc = finChart(f);
      const body = hEl("div", fc ? "fin-body" : "fin-plain");
      if (fc) body.append(fc);
      const side = hEl("div", "fin-lines");
      side.append(finTable(f));
      body.append(side); fs.append(body);
      const last = (f.revenue && f.revenue[0]) || (f.net_income && f.net_income[0]);
      pfFoot(fs, last ? "FY" + last.end.slice(0, 4) + " (year ended " + last.end + ")" : "", f.source, f.url, f.basis + " basis");
    } else { fs.append(hEl("p", "pf-na2", "Not available yet.")); }
    root.append(fs);
    // 4 Ownership
    const os = pfSection("Ownership");
    const hs = p.holders;
    if (p.owners && p.owners.cats && p.owners.cats.length) { os.append(ownersBand(p.owners)); }
    if (hs && hs.list && hs.list.length) {
      os.append(hEl("h5", "pf-sub-h", hs.kind === "5pct" ? "Holders of 5% or more" : "Largest shareholders"));
      os.append(holderBars(hs, mk));
      const det = hEl("details", "hk-text"); det.append(hEl("summary", null, "Holders as text"));
      const ul = hEl("ul");
      hs.list.forEach(x => {
        const tn = tidyHolder(x.name), li = hEl("li", null, tn.name + (x.pct != null ? "  " + x.pct + "%" : ""));
        if (tn.agent) li.append(hEl("small", "pf-agent", "  (常任代理人 " + tn.agent + ")"));
        ul.append(li);
      });
      det.append(ul); os.append(det);
    } else os.append(hEl("p", "pf-na2", "Holder list not available yet."));
    if (hs || p.owners) pfFoot(os, (hs && hs.as_of) || (p.owners && p.owners.as_of), (hs && hs.source) || (p.owners && p.owners.source), (hs && hs.url) || (p.owners && p.owners.url), hs && hs.prev_as_of ? "changes vs " + hs.prev_as_of : "");
    root.append(os);
    // 5 Takeover defense
    const ds = pfSection("Takeover defense");
    const df = p.defense;
    if (df) {
      const badge = hEl("span", "pf-def-badge " + (df.flag === "none_found" ? "none" : "alert"), df.flag === "none_found" ? "None found" : df.flag === "possible" ? "Possibly in place" : df.flag === "yes" ? "In place" : String(df.flag || "Unknown"));
      ds.append(dl([["Status", badge], ["What was checked", df.note || ""]]));
      pfFoot(ds, df.as_of, df.source, df.url, "read by software");
    } else ds.append(hEl("p", "pf-na2", "Not available yet."));
    root.append(ds);
    // 6 Sources
    const so = pfSection("Sources");
    const src = [];
    if (f && f.url) src.push(["Financials", srcLink((f.source || "Filing") + " filing", f.url)]);
    if (hs && hs.url) src.push(["Holders", srcLink((hs.source || "Filing") + " filing", hs.url)]);
    else if (p.owners && p.owners.url) src.push(["Holders", srcLink("EDINET filing", p.owners.url)]);
    if (df && df.url) src.push(["Takeover defense", srcLink((df.source || "Filing") + " filing", df.url)]);
    so.append(src.length ? dl(src) : hEl("p", "pf-na2", "No filing linked yet."));
    so.append(hEl("p", "pf-foot", "Figures are read from the filings by software; check the filing before relying on one."));
    root.append(so);
    td.append(root);
    if (p.status === "pending" || p.status === "error") td.append(hEl("p", "pf-foot", p.status_note || p.status));
  }
  function isDarkPage() {
    const m = (getComputedStyle(document.body).backgroundColor || "").match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return true;
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) < 140;
  }
  // TradingView's own embed script, one per widget; if it cannot load the rest of the row still shows.
  function tvWidget(host, name, cfg) {
    const box = document.createElement("div"); box.className = "tradingview-widget-container";
    const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; box.append(inner);
    const sc = document.createElement("script"); sc.async = true;
    sc.src = "https://s3.tradingview.com/external-embedding/embed-widget-" + name + ".js";
    sc.textContent = JSON.stringify(cfg);
    sc.onerror = () => { box.textContent = "TradingView could not be loaded."; box.className = "pf-note"; };
    box.append(sc); host.append(box);
  }
  // Saves a company's keywords and re-sends the list; the script fetches headlines for the new
  // query straight away. Returns an error message, or "".
  function setKeywords(i, keywords) {
    const list = companies(), c = list[i];
    if (list.some((o, j) => j !== i && coKey(o) === coKey({ name: c.name, keywords }))) return "The same company with these keywords is already on the list.";
    list[i] = { ...c, keywords };
    store.set("companies", list);
    renderCompanies();
    queueSync(0);
    setTimeout(loadCompanies, 6000); setTimeout(loadCompanies, 20000);
    return "";
  }
  // Returns an error message, or "" when the company was added.
  function addCompany(name, kwText, pick) {
    name = name.trim();
    if (!name) return "Enter a company name.";
    const keywords = kwText.split(/[,、]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
    const list = companies();
    if (list.length >= 15) return "Up to 15 companies. Remove one to add another.";
    if (list.some(c => coKey(c) === coKey({ name, keywords }))) return "Already on the list.";
    const listing = pick || autoListing({ name });
    list.unshift({ name, keywords, ...(listing ? pickFields(listing) : {}) });
    store.set("companies", list);
    updateCounts();
    if (state.view === "companies") renderCompanies();
    queueSync(0);
    // the script fetches a new company's first headlines while it stores it; ask again shortly
    setTimeout(loadCompanies, 6000); setTimeout(loadCompanies, 20000);
    return "";
  }
  // From a story: guess the company as the headline's first phrase ("小林製薬、…", "Acme to buy …")
  // and let the reader correct it.
  function openCompanyDialog(it) {
    const t = it.title || "";
    const head = t.replace(/^【[^】]*】\s*/, "");
    const m = head.match(/^([^、，,：:｢「（(\s]{2,24}?)(?:は|が)?[、，,]/) || head.match(/^([^、，,：:｢「（(\s]{2,20}?)(?:は|が)/)
      || head.match(/^(.{2,40}?)\s+(?:to|agrees|plans|weighs|buys|acquires|sells|says|in talks)\b/i);
    $("#co-dlg-story").textContent = t;
    $("#co-dlg-name").value = m ? m[1].trim() : "";
    $("#co-dlg-kw").value = ""; $("#co-dlg-status").textContent = ""; delete $("#co-dlg-name").dataset.pick;
    loadCompanyIndex();
    $("#co-dialog").showModal();
    $("#co-dlg-name").select();
  }
  function setupCompanies() {
    $$(".co-sub .chip").forEach(b => b.addEventListener("click", () => { store.set("coSub", b.dataset.sub); renderCompanies(); }));
    attachSuggest($("#co-name"));
    attachSuggest($("#co-dlg-name"));
    $("#co-form").addEventListener("submit", ev => {
      ev.preventDefault();
      const err = addCompany($("#co-name").value, $("#co-kw").value, picked($("#co-name")));
      $("#co-status").textContent = err;
      if (!err) { $("#co-form").reset(); delete $("#co-name").dataset.pick; renderCompanies(); }
    });
    $("#co-dlg-form").addEventListener("submit", ev => {
      ev.preventDefault();
      const err = addCompany($("#co-dlg-name").value, $("#co-dlg-kw").value, picked($("#co-dlg-name")));
      $("#co-dlg-status").textContent = err || "Added. It is on the Companies page.";
      if (!err) setTimeout(() => $("#co-dialog").close(), 900);
    });
    $("#co-dlg-cancel").addEventListener("click", () => $("#co-dialog").close());
  }

  /* ---------------- search ---------------- */
  async function loadArchiveMonths(n) {
    if (!state.archiveMonths.length) {
      const idx = await getJSON(dataUrl("archive/index.json")).catch(() => ({ months: [] }));
      state.archiveMonths = idx.months || [];
    }
    const months = n ? state.archiveMonths.slice(0, n) : state.archiveMonths;
    await Promise.all(months.filter(m => !state.archive.has(m)).map(async m => {
      state.archive.set(m, await getJSON(dataUrl(`archive/${m}.json`)).catch(() => []));
    }));
    return months.flatMap(m => state.archive.get(m) || []);
  }
  function parseQuery(s) {
    const phrases = [...s.matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase());
    const words = s.replace(/"[^"]*"/g, " ").toLowerCase().split(/\s+/).filter(w => w.length > 1);
    return { terms: [...phrases, ...words] };
  }
  let searchSeq = 0;
  async function runSearch() {
    const s = $("#q").value.trim(), seq = ++searchSeq, days = +$("#period").value;
    const status = $("#search-status"), ol = $("#results");
    if (!s) { ol.textContent = ""; status.textContent = "Type to search every story collected so far. Use quotes for exact phrases."; return; }
    status.textContent = "Searching…";
    const all = await loadArchiveMonths(days ? Math.ceil(days / 30) + 1 : 0);
    if (seq !== searchSeq) return;
    const q = parseQuery(s), since = days ? Date.now() - days * 864e5 : 0, seen = new Set();
    const hits = all.filter(it => {
      if (seen.has(it.id)) return false; seen.add(it.id);
      if (Date.parse(it.published) < since || !passes(it)) return false;
      const hay = (it.title + " " + (it.snippet || "") + " " + it.source + " " + it.categories.join(" ") + " " + it.countries.join(" ") + " " + it.sectors.join(" ")).toLowerCase();
      return q.terms.every(t => hay.includes(t));
    }).sort((a, b) => b.published.localeCompare(a.published));
    ol.textContent = "";
    hits.slice(0, 200).forEach(it => ol.append(rowNode(it, { q })));
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${hits.length > 200 ? " (showing 200 newest)" : ""} · ${all.length.toLocaleString()} stories searched`;
    if (!hits.length) ol.append(empty("No matches. Try fewer words or a longer period."));
  }

  /* ---------------- views ---------------- */
  function setView(v) {
    state.view = v;
    document.body.dataset.view = v;
    $("#view-search").hidden = v !== "search";
    $("#view-follow").hidden = v !== "follow";
    $("#view-companies").hidden = v !== "companies";
    $("#view-archive").hidden = v !== "archive";
    if (v === "archive") renderArchive();
    $$(".tab, .vtab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
    if (v === "search") runSearch();
    if (v === "follow") { renderFollow(); loadFollow().then(() => { if (state.view === "follow") renderFollow(); }); }
    if (v === "companies") { renderCompanies(); loadSponsors().then(() => { if (state.view === "companies") renderCompanies(); }); loadCompanies(); }
    renderDeals();
    window.scrollTo({ top: 0 });
  }

  /* ---------------- data ---------------- */
  /* Cloudflare Pages is not rebuilt on data commits, so the data is read straight from GitHub (raw is CORS-open,
     cached about 5 minutes). On localhost the relative path is used so a local copy can be tested. */
  const DATA_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "data/"
    : "https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/";
  const dataUrl = p => DATA_BASE + p;
  async function getJSON(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / 6e4), { cache: "no-store" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  async function load() {
    try {
      const [latest, idx, filings] = await Promise.all([
        getJSON(dataUrl("latest.json")),
        getJSON(dataUrl("digests/index.json")).catch(() => ({ editions: [] })),
        getJSON(dataUrl("edinet.json")).catch(() => ({ cards: [] })),   // absent until the first EDINET run
      ]);
      state.items = latest.items || [];
      state.filings = filings.cards || [];
      state.updated = latest.updated;
      const newest = idx.editions && idx.editions[0] && idx.editions[0].id;
      const hadNewest = state.editions[0] && state.editions[0].id;
      state.editions = idx.editions || [];
      // follow the newest edition unless the viewer is reading a specific (linked or chosen) one
      if (!state.pinned && (!state.edition || state.edition === hadNewest)) state.edition = newest || null;
      if (state.edition) await loadEdition(state.edition).catch(() => null);
      renderAll();
    } catch (e) {
      console.error(e);
    }
  }

  /* ---------------- settings ---------------- */
  function renderProfileView() {
    const p = buildProfile(), box = $("#profile-view"); box.textContent = "";
    const title = document.createElement("div");
    title.textContent = events().length
      ? `What this browser has learned from you (${events().length} signals). It never leaves this browser.`
      : "Nothing learned yet. Open, save (☆) or hide (×) stories — the ranking adapts from the next day.";
    box.append(title);
    const label = { "cat:": "type ", "cty:": "region ", "sec:": "sector ", "src:": "source ", "kw:": "keyword " };
    Object.entries(p.weights || {}).filter(([, v]) => v > 0).slice(0, 12).forEach(([k, v]) => {
      const row = document.createElement("div");
      row.textContent = k.replace(/^(cat|cty|sec|src|kw):/, m => label[m]) + " ";
      const bar = document.createElement("span"); bar.className = "bar"; bar.style.width = Math.round(v * 120) + "px";
      row.append(bar); box.append(row);
    });
  }
  function tickClock() {
    const c = $("#clock"), t = new Date().toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false });
    c.textContent = t;
    const tz = document.createElement("span"); tz.className = "tz"; tz.textContent = " SGT";   // dropped on phones, where the header is full
    c.append(tz);
  }

  /* ---------------- email sign-up ---------------- */
  function setupSubscribe() {
    if (!MAIL_ENDPOINT) return;               // not configured yet: keep the feature invisible
    const dlg = $("#subscribe"), form = $("#sub-form"), status = $("#sub-status");
    $("#btn-mail").hidden = false;
    const open = () => { status.textContent = ""; dlg.showModal(); };
    $("#btn-mail").addEventListener("click", open);
    $("#sub-skip").addEventListener("click", () => { store.set("mailAsked", Date.now()); dlg.close(); });
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const email = $("#sub-email").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = "Please enter a valid email."; return; }
      $("#sub-submit").disabled = true; status.textContent = "Sending…";
      try {
        // Apps Script web apps do not send CORS headers; a no-cors POST still delivers the form.
        await fetch(MAIL_ENDPOINT, { method: "POST", mode: "no-cors", body: new URLSearchParams({ action: "subscribe", email }) });
        store.set("mailAsked", Date.now()); store.set("mailSubscribed", email);
        status.textContent = "Almost done: check your inbox and click the confirmation link.";
      } catch {
        status.textContent = "Could not reach the mail service. Please try again later.";
      } finally { $("#sub-submit").disabled = false; }
    });
    // First visit on this device: offer it once (not when arriving from an email link).
    if (!store.get("mailAsked", 0) && !store.get("mailSubscribed", "") && !new URLSearchParams(location.search).get("e")) setTimeout(open, 2500);
  }

  /* ---------------- contact box ----------------
     Posts to the same Apps Script as the mail sign-up, which forwards it to the owner's
     inbox. Apps Script sends no CORS headers, so the reply cannot be read: the form says
     it was sent, and the honest fallback is the owner noticing nothing arrived. */
  function setupContact() {
    const panel = $("#contact"), form = $("#contact-form"), status = $("#contact-status");
    if (!MAIL_ENDPOINT) { panel.hidden = true; return; }   // nowhere to send it
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const message = $("#contact-message").value.trim();
      if (!message) return;
      const btn = $("#contact-send");
      btn.disabled = true; status.textContent = "Sending…";
      try {
        await fetch(MAIL_ENDPOINT, {
          method: "POST", mode: "no-cors",
          body: new URLSearchParams({
            action: "contact", message,
            from: $("#contact-from").value.trim(),
            website: $("#contact-website").value,
          }),
        });
        form.reset();
        status.textContent = "Sent. Thank you.";
      } catch {
        status.textContent = "Could not send it. Please try again later.";
      } finally { btn.disabled = false; }
    });
  }

  /* ---------------- staying current ----------------
     GitHub Pages lets a browser keep the page itself for ten minutes, and the ?v= stamps only help
     once the new page is in hand. So ask the server which stamp is live; if it is not this one,
     reload once (a reload revalidates the page). */
  async function checkVersion() {
    try {
      const html = await (await fetch("index.html?t=" + Date.now(), { cache: "no-store" })).text();
      const live = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
      if (!live || live === ASSET_V) return;
      let tried = "";
      try { tried = sessionStorage.getItem("dw.reloadedFor") || ""; sessionStorage.setItem("dw.reloadedFor", live); } catch { /* no storage: reload anyway, once per load */ }
      if (tried !== live) location.reload();
    } catch { /* offline: keep what we have */ }
  }

  /* ---------------- wiring ---------------- */
  function init() {
    const urlSkin = new URLSearchParams(location.search).get("skin");
    // ?skin= previews a look for this page load only; the Settings choice is what persists
    applySkin(SKINS[urlSkin] ? urlSkin : store.get("skin", document.documentElement.dataset.skin));
    const sel = $("#sector");
    SECTORS.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; sel.append(o); });
    const skinSel = $("#skin-select");
    Object.entries(SKINS).forEach(([k, v]) => { const o = document.createElement("option"); o.value = k; o.textContent = v; skinSel.append(o); });
    skinSel.addEventListener("change", () => {
      store.set("skin", skinSel.value); applySkin(skinSel.value);
      setTimeout(syncDigestHeight, 60);   // the new skin's stylesheet changes both column heights
    });
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(syncDigestHeight, 150); });
    applyLang(state.lang);
    $("#btn-lang").addEventListener("click", () => { applyLang(state.lang === "ja" ? "en" : "ja"); renderAll(); });
    // One measurement after render is not enough: the web fonts land later and re-wrap both
    // columns, and an edition arrives after its own fetch. Watch instead of guessing.
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => syncDigestHeight());
      ro.observe($("#view-deals"));
      ro.observe($("#digest"));
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncDigestHeight);
    $$(".chip-group .chip").forEach(b => b.addEventListener("click", () => {
      const g = b.closest(".chip-group"), key = g.dataset.group, v = b.dataset.v, cur = state.filters[key];
      // data-single groups (Focus) hold one value at a time; the others toggle in a list
      state.filters[key] = g.dataset.single != null
        ? (cur === v ? "" : v)
        : (cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]);
      store.set("filters", state.filters); state.dealsShown = DEALS_PAGE; renderAll();
    }));
    sel.addEventListener("change", () => { state.filters.sector = sel.value; store.set("filters", state.filters); state.dealsShown = DEALS_PAGE; renderAll(); });
    $("#clear").addEventListener("click", () => { state.filters = normFilters(null); store.set("filters", state.filters); renderAll(); });
    $("#deals-more").addEventListener("click", () => { state.dealsShown += 30; renderDeals(); });
    [["deals-range", "dealsToday"], ["deals-scope", "dealsAll"], ["deals-order", "dealsInterest"]]
      .forEach(([id, key]) => $("#" + id).addEventListener("click", () => {
        state[key] = !state[key];
        store.set(key, state[key]);
        state.dealsShown = DEALS_PAGE;
        renderDeals();
      }));
    let t;
    $("#q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if ($("#q").value.trim()) { if (state.view !== "search") setView("search"); else runSearch(); }
        else if (state.view === "search") setView("home");
      }, 220);
    });
    $("#period").addEventListener("change", runSearch);
    $$(".tab, .vtab").forEach(b => b.addEventListener("click", () => {
      if ($("#q").value) $("#q").value = "";   // leaving search for a page
      setView(b.dataset.view);
    }));
    const dlg = $("#settings");
    $("#btn-settings").addEventListener("click", () => { skinSel.value = document.documentElement.dataset.skin; renderProfileView(); dlg.showModal(); });
    $("#reset-profile").addEventListener("click", () => {
      if (confirm("Clear everything this browser has learned?")) { store.set("events", []); store.set("profile", null); renderProfileView(); renderAll(); }
    });
    tickClock(); setInterval(tickClock, 15000);
    $("#btn-archive").addEventListener("click", () => setView("archive"));
    setupSubscribe();
    setupContact();
    setupCompanies();
    updateCounts();
    queueSync(3000);   // keeps this browser's follows counted (a browser unseen for 60 days drops out)
    setView("home");
    const qp = new URLSearchParams(location.search);
    if (qp.get("e")) {
      const i = qp.get("i");
      state.pinned = { e: qp.get("e"), i: i == null ? null : +i };
      state.edition = qp.get("e");
      load().then(() => openPermalink(state.pinned.e, state.pinned.i));
    } else if (qp.get("view") === "archive") {
      load().then(() => setView("archive"));   // "All past digests" link in every email
    } else load();
    setInterval(load, REFRESH_MS);
    checkVersion(); setInterval(checkVersion, REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); checkVersion(); } });
  }
  init();
})();
