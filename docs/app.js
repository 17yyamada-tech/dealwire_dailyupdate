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
  const SKINS = { board: "Departure board", navy: "Navy glass", "navy-classic": "Navy classic", editorial: "Editorial" };
  const SECTORS = ["AI & Semis", "TMT", "Financials", "Real Estate", "Energy", "Healthcare", "Consumer", "Industrials", "Infrastructure", "Materials", "Public / Macro"];
  const FOCUS = ["Sponsor", "Strategic"];   // who is on the deal; re-orders the list, never filters
  const REGION_ORDER = ["SG", "JP", "HK/CN", "SEA", "US"];   // SG items also carry SEA; show the most specific first
  const CJK = "\\u3040-\\u30ff\\u4e00-\\u9fff\\uff66-\\uff9f";
  const TYPE_ORDER = ["M&A", "PE", "Credit", "Infra"];
  const STOP = new Set("the a an and or of to in on for with by at from as is are be its it this that after over into new says said will than more up amid us uk sg".split(" "));
  const PAGE = 30, DEALS_PAGE = 14;
  const REFRESH_MS = 5 * 60 * 1000;
  const HALF_LIFE_H = 18;
  const FOCUS_LIFT = 2.2;   // how hard a Focus chip lifts matching deals up the list
  const PROFILE_WINDOW_DAYS = 45;
  const DAILY_DECAY = 0.94;

  const state = {
    items: [], updated: null, editions: [], edition: null, editionCache: new Map(), pinned: null, lastRanked: [],
    filters: normFilters(store.get("filters", null)),
    shown: PAGE, dealsShown: DEALS_PAGE, view: "home",
    seenDeals: new Set(store.get("seenDeals", [])), firstLoad: true,
    archive: new Map(), archiveMonths: [], filings: [],
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
    btn.textContent = state.lang === "ja" ? "EN" : "日本語";
    btn.title = btn.ariaLabel = state.lang === "ja"
      ? "Read the digest summaries in English"
      : "ダイジェストの要約を日本語で読む";
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
    $("#skin-css").href = `skins/${name}.css`;
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
    if (state.filters.focus && it.actor === state.filters.focus) s *= FOCUS_LIFT;
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
  function passes(it) {
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
  const typeOf = (it) => (TYPE_ORDER.find(t => (it.categories || []).includes(t))) || (it.is_deal ? "Deal" : "News");
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
    const t = typeOf(it); const ty = $(".c-type", n); ty.textContent = t; ty.classList.add(typeClass(t));
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
  function renderStories() {
    const prof = activeProfile(), read = store.get("read", {}), hidden = store.get("hidden", {});
    const ranked = collapseDupes(state.items.filter(passes).map(it => ({ it, ...score(it, prof, read, hidden) }))
      .filter(x => x.s >= 0).sort((a, b) => b.s - a.s));
    const ol = $("#stories"); ol.textContent = "";
    ranked.slice(0, state.shown).forEach(x => ol.append(rowNode(x.it, { reasons: x.reasons, also: x.also })));
    if (!ranked.length) ol.append(empty(anyFilter() ? "Nothing matches these filters in the last 7 days." : "No stories yet."));
    $("#more").hidden = ranked.length <= state.shown;
    $("#rank-hint").textContent = Object.keys(prof.weights || {}).length ? "ranked for you" : "ranked by recency & deal relevance";
    return ranked;
  }

  function renderDeals() {
    const hidden = store.get("hidden", {});
    const deals = collapseDupes(state.items.filter(it => it.is_deal && passes(it) && !hidden[it.id])
      .sort((a, b) => a.published.localeCompare(b.published)).map(it => ({ it })))   // oldest first: first report wins
      .reverse();
    // A Focus chip moves matching deals to the front of the board, keeping each block by time.
    const focus = state.filters.focus;
    if (focus) deals.sort((a, b) => (b.it.actor === focus) - (a.it.actor === focus));
    const ol = $("#deals"); ol.textContent = "";
    const limit = state.view === "deals" ? 200 : state.dealsShown;
    deals.slice(0, limit).forEach(x => {
      const isNew = !state.firstLoad && !state.seenDeals.has(x.it.id);
      ol.append(rowNode(x.it, { also: x.also, compact: true, fresh: isNew }));
    });
    if (!deals.length) ol.append(empty("No deals match these filters."));
    $("#deals-count").textContent = deals.length + " in 7 days";
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

    const foot = document.createElement("div"); foot.className = "fc-foot";
    const type = document.createElement("span"); type.className = "fc-type"; type.textContent = c.type_en;
    type.title = c.type_ja;
    const n = document.createElement("span"); n.className = "fc-n";
    n.textContent = c.filings > 1 ? c.filings + " filings" : "";
    foot.append(type, n);
    li.append(head, target, by, foot);
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
    // "stories stories" marks the two-column layout; the phone and the navy-classic
    // layouts put the board elsewhere, where lining the columns up makes no sense
    if (!getComputedStyle(grid).gridTemplateAreas.includes("stories stories")) return;
    if (board.offsetParent === null) return;                       // board hidden in this view
    const b = board.getBoundingClientRect(), p = panel.getBoundingClientRect();
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

  function renderSaved() {
    const saved = Object.values(store.get("saved", {})).sort((a, b) => b.published.localeCompare(a.published));
    const ol = $("#saved-list"); ol.textContent = "";
    saved.forEach(it => ol.append(rowNode(it)));
    if (!saved.length) ol.append(empty("Tap ☆ on a story to keep it here."));
  }

  function renderAll() {
    syncFilterUI();
    state.lastRanked = renderStories();
    renderDigest(state.lastRanked);
    renderDeals();
    renderFilings();
    if (state.view === "search") runSearch();
    if (state.view === "saved") renderSaved();
    state.firstLoad = false;
  }

  /* ---------------- actions ---------------- */
  function markRead(it) {
    const r = store.get("read", {});
    if (!r[it.id]) { r[it.id] = Date.now(); store.set("read", prune(r)); logEvent("open", it); }
  }
  function toggleSave(it, btn) {
    const s = store.get("saved", {});
    if (s[it.id]) { delete s[it.id]; btn.classList.remove("on"); btn.textContent = "☆"; }
    else { s[it.id] = it; btn.classList.add("on"); btn.textContent = "★"; logEvent("save", it); }
    store.set("saved", s);
  }
  function hide(it) { const h = store.get("hidden", {}); h[it.id] = Date.now(); store.set("hidden", prune(h)); logEvent("hide", it); }
  function prune(obj) { const c = Date.now() - 120 * 864e5; return Object.fromEntries(Object.entries(obj).filter(([, t]) => t >= c)); }

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
    $("#view-saved").hidden = v !== "saved";
    $("#view-archive").hidden = v !== "archive";
    if (v === "archive") renderArchive();
    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
    if (v === "search") runSearch();
    if (v === "saved") renderSaved();
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
      $("#updated").textContent = "Updated " + fmtAgo(latest.updated) + " ago";
      $("#updated").title = fmtDate(latest.updated) + " SGT";
      renderAll();
    } catch (e) {
      $("#updated").textContent = "Offline";
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
    $("#clock").textContent = new Date().toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false }) + " SGT";
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
      store.set("filters", state.filters); state.shown = PAGE; renderAll();
    }));
    sel.addEventListener("change", () => { state.filters.sector = sel.value; store.set("filters", state.filters); state.shown = PAGE; renderAll(); });
    $("#clear").addEventListener("click", () => { state.filters = normFilters(null); store.set("filters", state.filters); renderAll(); });
    $("#more").addEventListener("click", () => { state.shown += PAGE; renderStories(); });
    $("#deals-more").addEventListener("click", () => { state.dealsShown += 30; renderDeals(); });
    let t;
    $("#q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if ($("#q").value.trim()) { if (state.view !== "search") setView("search"); else runSearch(); }
        else if (state.view === "search") setView("home");
      }, 220);
    });
    $("#period").addEventListener("change", runSearch);
    $$(".tab").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
    $("#btn-saved").addEventListener("click", () => setView(state.view === "saved" ? "home" : "saved"));
    const dlg = $("#settings");
    $("#btn-settings").addEventListener("click", () => { skinSel.value = document.documentElement.dataset.skin; renderProfileView(); dlg.showModal(); });
    $("#reset-profile").addEventListener("click", () => {
      if (confirm("Clear everything this browser has learned?")) { store.set("events", []); store.set("profile", null); renderProfileView(); renderAll(); }
    });
    tickClock(); setInterval(tickClock, 15000);
    $("#btn-archive").addEventListener("click", () => setView("archive"));
    setupSubscribe();
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
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  }
  init();
})();
