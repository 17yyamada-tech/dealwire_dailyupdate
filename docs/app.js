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
  const ASSET_V = "20260928-2130";   // same stamp as the ?v= on base.css and app.js in index.html
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
     leaves out. Nothing here is interpreted: every field is copied from the filing index. */
  const FILING_LABEL = { tob: "Tender offer", tob_result: "Offer result", opinion: "Target response", stake: "5% stake" };
  function renderFilings() {
    const panel = $("#filings"), ol = $("#filing-list");
    const cards = (state.filings || []).filter(c => !state.filters.country.length || state.filters.country.includes("JP"));
    panel.hidden = !cards.length;
    if (!cards.length) return;
    ol.textContent = "";
    cards.slice(0, 30).forEach(c => ol.append(filingNode(c)));
    $("#filings-meta").textContent = cards.length + (cards.length === 1 ? " filing" : " filings") + " · EDINET";
  }
  const coName = (p) => p.name_en || p.name || "";
  function filingNode(c) {
    const li = document.createElement("li"); li.className = "filing-card";
    const head = document.createElement("div"); head.className = "fc-head";
    const k = document.createElement("span"); k.className = "fc-kind k-" + c.kind;
    k.textContent = FILING_LABEL[c.kind] || c.kind;
    head.append(k);
    if (c.sponsor) { const s = document.createElement("span"); s.className = "fc-sponsor"; s.textContent = "Sponsor"; head.append(s); }
    // the filing's own purpose says the holder may make proposals: the activist signal
    if (c.terms && c.terms.proposal) { const s = document.createElement("span"); s.className = "fc-proposal"; s.textContent = "Proposal intent"; s.title = "Holding purpose includes 重要提案行為等"; head.append(s); }
    const d = document.createElement("span"); d.className = "fc-date"; d.textContent = fmtDate(c.filed); head.append(d);

    const target = document.createElement("a"); target.className = "fc-target";
    target.href = c.link; target.target = "_blank"; target.rel = "noopener";
    target.textContent = coName(c.target) || "Target not named in the index";
    if (c.target.ticker) { const t = document.createElement("span"); t.className = "fc-ticker"; t.textContent = " " + c.target.ticker; target.append(t); }
    target.title = c.target.name || "";

    const by = document.createElement("p"); by.className = "fc-line";
    const byl = document.createElement("span"); byl.className = "fc-lbl"; byl.textContent = "By";
    const byv = document.createElement("span"); byv.textContent = coName(c.buyer);
    by.append(byl, byv);

    li.append(head, target, by);
    // Terms come straight out of the filing. There is no premium here on purpose: it is not
    // a filed figure, and we do not hold the pre-announcement share price to work it out.
    const t = c.terms || {};
    const pairs = [];
    if (t.price) pairs.push(["Price", "¥" + t.price + " / sh"]);
    if (t.opens && t.closes) pairs.push(["Period", fmtDay(t.opens) + " – " + fmtDay(t.closes) + (t.business_days ? ` (${t.business_days}d)` : "")]);
    if (t.shares) pairs.push(["Sought", t.shares + " sh" + (t.stake_pct ? ` · ${t.stake_pct}%` : "")]);
    if (t.floor) pairs.push(["Floor", t.floor + " sh"]);
    if (t.settles) pairs.push(["Settles", fmtDay(t.settles)]);
    if (t.backer) pairs.push(["Backer", t.backer]);
    // 5% reports: the holding before and after, as filed, and why it is held
    if (t.stake_now != null) {
      const now = t.stake_now.toFixed(2) + "%";
      if (t.stake_prev != null) {
        const d = t.stake_now - t.stake_prev;
        pairs.push(["Holding", `${t.stake_prev.toFixed(2)}% → ${now}`, `(${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}pt)`, d >= 0 ? "up" : "down"]);
      } else pairs.push(["Holding", now, "(new)", "up"]);
    }
    if (t.purpose) pairs.push(["Purpose", t.purpose]);
    if (pairs.length) {
      const dl = document.createElement("dl"); dl.className = "fc-terms";
      pairs.forEach(([k, v, extra, dir]) => {
        const dt = document.createElement("dt"); dt.textContent = k;
        const dd = document.createElement("dd"); dd.textContent = v;
        if (extra) { const e = document.createElement("span"); e.className = "fc-chg " + (dir || ""); e.textContent = " " + extra; dd.append(e); }
        if (k === "Purpose") dd.className = "fc-purpose";
        dl.append(dt, dd);
      });
      li.append(dl);
    }

    const foot = document.createElement("div"); foot.className = "fc-foot";
    const type = document.createElement("span"); type.className = "fc-type"; type.textContent = c.type_en;
    type.title = c.type_ja;
    const n = document.createElement("span"); n.className = "fc-n";
    n.textContent = c.filings > 1 ? c.filings + " filings" : "";
    foot.append(type, n);
    li.append(foot);
    return li;
  }

  /* ---------------- digest editions ---------------- */
  const permalink = (eid, i) => `${location.origin}${location.pathname}?e=${encodeURIComponent(eid)}` + (i == null ? "" : `&i=${i}`);
  const editionTime = (e) => e.id.slice(11, 13) + ":" + e.id.slice(13, 15);
  const editionDay = (e) => e.id.slice(0, 10);
  const fmtDay = (day, weekday) => new Date(day + "T00:00:00Z").toLocaleDateString("en-SG", { weekday: weekday ? "short" : undefined, day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  async function loadEdition(id) {
    if (!state.editionCache.has(id)) state.editionCache.set(id, await getJSON(`data/digests/${id}.json`));
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
    const li = document.createElement("li"); li.className = "fl-item";
    const meta = document.createElement("p"); meta.className = "d-links fl-meta";
    meta.textContent = [fmtWhen(date), source].filter(Boolean).join(" · ");
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
    followIndex = await getJSON("data/follow/index.json").catch(() => ({ stories: {} }));
    const ids = followed().map(it => it.id).filter(id => followIndex.stories && followIndex.stories[id]);
    await Promise.all(ids.map(async id => {
      const stamp = followIndex.stories[id].checked_at;
      if (followData.has(id) && followData.get(id).checked_at === stamp) return;
      const d = await getJSON(`data/follow/${id}.json`).catch(() => null);
      if (d) followData.set(id, d);
    }));
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
  async function loadSponsors() { if (!sponsorWords) sponsorWords = await getJSON("data/sponsors.json").catch(() => []); }
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
    return coIndexLoading || (coIndexLoading = getJSON("data/company_index.json").catch(() => ({ rows: [] }))
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
    if (!mine.length) { ol.append(empty("No companies yet. Add one above; keywords narrow it to the news you care about.")); return; }
    const remote = new Map(((coData && coData.companies) || []).map(c => [coKey(c), c]));
    // companies added before the search list existed: link the unambiguous ones once
    if (coIndex) {
      let changed = false;
      const list = mine.map(c => { const r = autoListing(c); if (r) { changed = true; return { ...c, ...pickFields(r) }; } return c; });
      if (changed) { store.set("companies", list); queueSync(0); return renderCompanies(); }
    } else loadCompanyIndex().then(() => { if (state.view === "companies") renderCompanies(); });
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
      const idx = await getJSON("data/archive/index.json").catch(() => ({ months: [] }));
      state.archiveMonths = idx.months || [];
    }
    const months = n ? state.archiveMonths.slice(0, n) : state.archiveMonths;
    await Promise.all(months.filter(m => !state.archive.has(m)).map(async m => {
      state.archive.set(m, await getJSON(`data/archive/${m}.json`).catch(() => []));
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
  async function getJSON(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / 6e4), { cache: "no-store" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  async function load() {
    try {
      const [latest, idx, filings] = await Promise.all([
        getJSON("data/latest.json"),
        getJSON("data/digests/index.json").catch(() => ({ editions: [] })),
        getJSON("data/edinet.json").catch(() => ({ cards: [] })),   // absent until the first EDINET run
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
