/* Deal Wire front end — static, no build step.
 * Data:     data/latest.json (7 days), data/archive/YYYY-MM.json (search), data/digest.json (daily, written by the Routine).
 * Learning: per viewer. Each browser logs its own opens/saves/hides to localStorage (nothing leaves the browser);
 *           once per day the profile (weights per category / region / sector / source / keyword) is recomputed
 *           and used to rank Top stories and to reorder the digest for that viewer.
 * Look:     markup is skin-neutral; everything visual is in skins/<name>.css (see SKINS).
 */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem("dw." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("dw." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const SKINS = { board: "Departure board", navy: "Navy glass", "navy-classic": "Navy classic", editorial: "Editorial" };
  const SECTORS = ["TMT", "Financials", "Real Estate", "Energy", "Healthcare", "Consumer", "Industrials", "Infrastructure", "Materials", "Public / Macro"];
  const REGION_ORDER = ["SG", "HK/CN", "SEA", "US"];   // SG items also carry SEA; show the most specific first
  const TYPE_ORDER = ["M&A", "PE", "Credit", "Infra"];
  const STOP = new Set("the a an and or of to in on for with by at from as is are be its it this that after over into new says said will than more up amid us uk sg".split(" "));
  const PAGE = 30, DEALS_PAGE = 14;
  const REFRESH_MS = 5 * 60 * 1000;
  const HALF_LIFE_H = 18;
  const PROFILE_WINDOW_DAYS = 45;
  const DAILY_DECAY = 0.94;

  const state = {
    items: [], updated: null, digest: null,
    filters: normFilters(store.get("filters", null)),
    shown: PAGE, dealsShown: DEALS_PAGE, view: "home",
    seenDeals: new Set(store.get("seenDeals", [])), firstLoad: true,
    archive: new Map(), archiveMonths: [],
  };
  function normFilters(f) {
    const ok = { category: TYPE_ORDER, country: REGION_ORDER };
    f = f || {};
    return {
      category: (f.category || []).filter(x => ok.category.includes(x)),
      country: (f.country || []).filter(x => ok.country.includes(x)),
      sector: SECTORS.includes(f.sector) ? f.sector : "",
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
  function keywords(title) {
    // proper nouns / tickers are the most predictive of what gets opened again
    return [...new Set((title.match(/\b[A-Z][A-Za-z0-9&'.-]{2,}\b/g) || [])
      .map(w => w.replace(/['.]+$/, "").toLowerCase()).filter(w => !STOP.has(w)))].slice(0, 6);
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
  const tokenSet = (t) => new Set(t.toLowerCase().replace(/us\$|s\$|\$/g, "").split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
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
  const anyFilter = () => state.filters.category.length || state.filters.country.length || state.filters.sector;
  function syncFilterUI() {
    $$(".chip-group").forEach(g => {
      const key = g.dataset.group;
      $$(".chip", g).forEach(b => b.setAttribute("aria-pressed", state.filters[key].includes(b.dataset.v)));
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
  const regionOf = (it) => {
    const c = it.countries || [];
    const r = REGION_ORDER.filter(x => c.includes(x) && !(x === "SEA" && c.includes("SG")));
    return r.slice(0, 2).join(" ") || "—";
  };
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
    $(".c-reg", n).textContent = regionOf(it);
    const t = typeOf(it); const ty = $(".c-type", n); ty.textContent = t; ty.classList.add(typeClass(t));
    const a = $(".c-title", n); a.href = it.link; highlight(a, it.title, q);
    highlight($(".c-snip", n), compact ? "" : (it.snippet || ""), q);
    $(".src", n).textContent = it.source;
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
  }

  function renderDigest(ranked) {
    const list = $("#digest-list"); list.textContent = "";
    const d = state.digest, meta = $("#digest-meta");
    const fresh = d && d.items && d.items.length && (Date.now() - Date.parse(d.generated_at)) < 36 * 36e5;
    if (fresh) {
      // Chosen once a day for everyone; each viewer sees them reordered by their own reading.
      const prof = activeProfile(), N = d.items.length;
      const items = d.items
        .map((x, i) => ({ x, s: (N - i) / N + 0.6 * affinity({ categories: x.categories, countries: x.countries, sectors: x.sectors, title: x.headline }, prof) }))
        .sort((a, b) => b.s - a.s).map(o => o.x)
        .filter(x => !anyFilter() || passes(x));
      meta.textContent = `${d.reading_minutes || 5} min read · ${fmtDate(d.generated_at)} SGT`;
      items.forEach((x, i) => {
        const li = document.createElement("li");
        const num = document.createElement("span"); num.className = "d-num"; num.textContent = String(i + 1).padStart(2, "0");
        const body = document.createElement("div"); body.className = "d-body";
        const h = document.createElement("h3");
        const a = document.createElement("a"); a.textContent = x.headline; a.href = (x.links && x.links[0] && x.links[0].url) || "#"; a.target = "_blank"; a.rel = "noopener";
        h.append(a);
        const p = document.createElement("p"); p.className = "d-sum"; p.textContent = x.summary;
        const why = document.createElement("p"); why.className = "d-why";
        const b = document.createElement("b"); b.textContent = "Why it matters"; why.append(b, " ", x.why_it_matters || "");
        const links = document.createElement("p"); links.className = "d-links";
        (x.links || []).forEach((l, j) => { if (j) links.append(" · "); const la = document.createElement("a"); la.href = l.url; la.target = "_blank"; la.rel = "noopener"; la.textContent = l.source; links.append(la); });
        body.append(h, p, why, links); li.append(num, body); list.append(li);
      });
      if (!items.length) list.append(empty("None of today's digest items match these filters."));
      return;
    }
    // Until the daily digest exists: the top-ranked stories of the last ~day.
    const top = ranked.filter(x => (Date.now() - Date.parse(x.it.published)) < 30 * 36e5).slice(0, 6);
    meta.textContent = "auto-picked · written summary arrives with the morning digest";
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
  }

  function renderSaved() {
    const saved = Object.values(store.get("saved", {})).sort((a, b) => b.published.localeCompare(a.published));
    const ol = $("#saved-list"); ol.textContent = "";
    saved.forEach(it => ol.append(rowNode(it)));
    if (!saved.length) ol.append(empty("Tap ☆ on a story to keep it here."));
  }

  function renderAll() {
    syncFilterUI();
    renderDigest(renderStories());
    renderDeals();
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
      const [latest, digest] = await Promise.all([getJSON("data/latest.json"), getJSON("data/digest.json").catch(() => null)]);
      state.items = latest.items || [];
      state.updated = latest.updated;
      state.digest = digest;
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

  /* ---------------- wiring ---------------- */
  function init() {
    const urlSkin = new URLSearchParams(location.search).get("skin");
    // ?skin= previews a look for this page load only; the Settings choice is what persists
    applySkin(SKINS[urlSkin] ? urlSkin : store.get("skin", document.documentElement.dataset.skin));
    const sel = $("#sector");
    SECTORS.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; sel.append(o); });
    const skinSel = $("#skin-select");
    Object.entries(SKINS).forEach(([k, v]) => { const o = document.createElement("option"); o.value = k; o.textContent = v; skinSel.append(o); });
    skinSel.addEventListener("change", () => { store.set("skin", skinSel.value); applySkin(skinSel.value); });
    $$(".chip-group .chip").forEach(b => b.addEventListener("click", () => {
      const key = b.closest(".chip-group").dataset.group, v = b.dataset.v, arr = state.filters[key];
      state.filters[key] = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
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
    setView("home");
    load();
    setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  }
  init();
})();
