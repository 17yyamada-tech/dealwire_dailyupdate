// Unit tests for the account sync: Access JWT check, the Function handlers, and the merge rules
// (the same code that runs in Code.gs and docs/app.js is cut out of those files between its markers).
// Run: node tests/sync.test.mjs   (Node 20+)
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAccessJwt, clearCertsCache } from "../functions/_lib/access.js";
import { onRequestGet as meGet } from "../functions/api/me.js";
import { onRequestPost as opsPost } from "../functions/api/ops.js";
import { onRequestGet as stateGet } from "../functions/api/state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("ok   " + name); } catch (e) { console.log("FAIL " + name + "\n  " + (e.stack || e)); process.exitCode = 1; } };

/* ---------- JWT ---------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const TEAM = "myteam.cloudflareaccess.com";
async function makeKey(kid) {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { priv: kp.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}
async function sign(key, kid, payload, alg = "RS256") {
  const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" })), p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64u(sig);
}
const real = await makeKey("k1"), fake = await makeKey("k1");   // the attacker's key even claims the same kid
const certsFetch = (keys) => async () => ({ ok: true, json: async () => ({ keys }) });
const NOW = 1_800_000_000_000, nowS = NOW / 1000;
const good = { iss: "https://" + TEAM, aud: ["aud-prod"], email: "Friend@Example.com", exp: nowS + 600, iat: nowS };
const env = { CF_ACCESS_TEAM_DOMAIN: "myteam", CF_ACCESS_AUD: "aud-prod, aud-preview", APPS_SCRIPT_URL: "https://script.example/exec", SYNC_SECRET: "s3cret" };
const opts = (keys = [real.jwk]) => ({ fetch: certsFetch(keys), nowMs: NOW });
const rejects = async (token, code, e = env, keys) => { clearCertsCache(); await assert.rejects(verifyAccessJwt(token, e, opts(keys)), (err) => err.code === code, "expected " + code); };

await test("valid token gives the lower-cased email", async () => {
  clearCertsCache();
  const r = await verifyAccessJwt(await sign(real.priv, "k1", good), env, opts());
  assert.equal(r.email, "friend@example.com");
});
await test("token signed with a different (fake) key is rejected", async () => rejects(await sign(fake.priv, "k1", good), "bad_signature"));
await test("tampered payload is rejected", async () => {
  const t = (await sign(real.priv, "k1", good)).split(".");
  t[1] = b64u(JSON.stringify({ ...good, email: "victim@example.com" }));
  await rejects(t.join("."), "bad_signature");
});
await test("aud that is not one of the two apps is rejected", async () => rejects(await sign(real.priv, "k1", { ...good, aud: ["other"] }), "bad_aud"));
await test("the preview app's aud (second in the list) is accepted", async () => {
  clearCertsCache();
  assert.equal((await verifyAccessJwt(await sign(real.priv, "k1", { ...good, aud: ["aud-preview"] }), env, opts())).email, "friend@example.com");
});
await test("expired token is rejected", async () => rejects(await sign(real.priv, "k1", { ...good, exp: nowS - 1 }), "expired"));
await test("wrong issuer is rejected", async () => rejects(await sign(real.priv, "k1", { ...good, iss: "https://evil.cloudflareaccess.com" }), "bad_iss"));
await test("alg other than RS256 is rejected", async () => rejects(await sign(real.priv, "k1", good, "none"), "bad_alg"));
await test("unknown kid is rejected", async () => rejects(await sign(real.priv, "zzz", good), "unknown_key"));
await test("missing token and unset variables are rejected", async () => {
  await rejects("", "no_token");
  await rejects("a.b.c", "malformed");
  await rejects(await sign(real.priv, "k1", good), "not_configured", { ...env, CF_ACCESS_AUD: "" });
});

/* ---------- Function handlers ---------- */
const req = (url, init = {}) => new Request(url, init);
await test("/api/me is 503 while the variables are not set, 401 without a token", async () => {
  assert.equal((await meGet({ request: req("https://x/api/me"), env: {} })).status, 503);
  clearCertsCache();
  assert.equal((await meGet({ request: req("https://x/api/me"), env })).status, 401);
});
await test("/api/me answers 200 with the verified email", async () => {
  clearCertsCache();
  const orig = globalThis.fetch;
  globalThis.fetch = certsFetch([real.jwk]);
  try {
    const token = await sign(real.priv, "k1", { ...good, exp: Date.now() / 1000 + 600 });
    const res = await meGet({ request: req("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }), env });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).email, "friend@example.com");
  } finally { globalThis.fetch = orig; }
});
await test("relay sends the verified email and the secret, never an email the browser claims", async () => {
  clearCertsCache();
  const orig = globalThis.fetch, upstream = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/cdn-cgi/access/certs")) return { ok: true, json: async () => ({ keys: [real.jwk] }) };
    upstream.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ recs: { saved: {}, companies: {}, hidden: {} } }), { status: 200 });
  };
  try {
    const token = await sign(real.priv, "k1", { ...good, exp: Date.now() / 1000 + 600 });
    const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", "X-DW-Sync": "1" };
    const res = await opsPost({ request: req("https://x/api/ops", { method: "POST", headers, body: JSON.stringify({ email: "victim@example.com", ops: [{ k: "saved", key: "a", t: 1, v: null }], vid: "a".repeat(32) }) }), env });
    assert.equal(res.status, 200);
    assert.equal(upstream[0].email, "friend@example.com");
    assert.equal(upstream[0].secret, "s3cret");
    assert.equal(upstream[0].action, "acct");
    // no CSRF header: refused before anything is relayed
    const n = upstream.length;
    const bad = await opsPost({ request: req("https://x/api/ops", { method: "POST", headers: { ...headers, "X-DW-Sync": "0" }, body: "{}" }), env });
    assert.equal(bad.status, 400);
    assert.equal(upstream.length, n);
    const st = await stateGet({ request: req("https://x/api/state?vid=" + "b".repeat(32), { headers: { "Cf-Access-Jwt-Assertion": token } }), env });
    assert.equal(st.status, 200);
    assert.equal(upstream.at(-1).op, "state");
  } finally { globalThis.fetch = orig; }
});

/* ---------- merge rules (Code.gs core, as it runs in Apps Script) ---------- */
function between(file, begin, end) {
  const s = fs.readFileSync(path.join(root, file), "utf8");
  const a = s.indexOf(begin), b = s.indexOf(end);
  assert.ok(a >= 0 && b > a, "markers in " + file);
  return s.slice(a, b);
}
const gas = vm.createContext({});
vm.runInContext(between("apps_script/Code.gs", "// ACCT-CORE-BEGIN", "// ACCT-CORE-END") + "\nthis.ACCT = ACCT; this.acctApply_ = acctApply_;", gas);
const { acctApply_, ACCT } = gas;
const fresh = () => ({ saved: {}, companies: {}, hidden: {} });
const story = (id, since) => ({ id, title: "Story " + id, link: "https://example.com/" + id, source: "S", published: since, since });
const iso = (n) => new Date(1_790_000_000_000 + n * 1000).toISOString();
const T0 = 1_790_000_000_000, now = T0 + 1e6;
const put = (id, t) => ({ k: "saved", key: id, t: T0 + t, v: story(id, iso(t)) });   // t = milliseconds after T0
const del = (k, key, t) => ({ k, key, t: T0 + t, v: null });
const co = (name, kw = []) => ({ name, keywords: kw });
const coKey = (c) => (c.name + "#" + c.keywords.join(",")).toLowerCase();
const cput = (c, t) => ({ k: "companies", key: coKey(c), t: T0 + t, o: T0 + t, v: c });
const live = (recs) => Object.keys(recs).filter((k) => recs[k].v !== null).sort();

await test("a deletion is not undone by a stale device that still has the item", () => {
  const s = fresh();
  acctApply_(s, [put("a", 1000)], now);
  acctApply_(s, [del("saved", "a", 2000)], now);
  acctApply_(s, [put("a", 1000)], now);                  // the other device's old copy arrives late
  assert.deepEqual(live(s.saved), []);
  acctApply_(s, [put("a", 3000)], now);                  // starring it again afterwards does bring it back
  assert.deepEqual(live(s.saved), ["a"]);
});
await test("two devices changing at the same time both keep their changes, in any order", () => {
  const A = [put("x", 1000), cput(co("Alpha"), 1100)], B = [put("y", 1050), cput(co("Beta"), 1200), del("saved", "x", 1500)];
  const s1 = fresh(), s2 = fresh();
  acctApply_(s1, A, now); acctApply_(s1, B, now);
  acctApply_(s2, B, now); acctApply_(s2, A, now);
  assert.deepEqual(s1, s2);
  assert.deepEqual(live(s1.saved), ["y"]);
  assert.deepEqual(live(s1.companies), [coKey(co("Alpha")), coKey(co("Beta"))].sort());
});
await test("same key: the newer change wins, and a tie goes to deletion", () => {
  const s = fresh();
  acctApply_(s, [{ ...cput(co("Alpha"), 1000), v: { ...co("Alpha"), kind: "fund" } }, { ...cput(co("Alpha"), 2000), v: { ...co("Alpha"), kind: "corp" } }], now);
  assert.equal(s.companies[coKey(co("Alpha"))].v.kind, "corp");
  acctApply_(s, [del("companies", coKey(co("Alpha")), 2000)], now);
  assert.deepEqual(live(s.companies), []);
});
await test("first login merges both lists, drops duplicates, and keeps the newest 20 stars / 15 companies", () => {
  const s = fresh();
  acctApply_(s, Array.from({ length: 15 }, (_, i) => put("s" + i, 1000 + i)), now);            // already on the server
  acctApply_(s, Array.from({ length: 15 }, (_, i) => put("s" + (i + 10), 1010 + i)), now);     // this device: 5 overlap, 10 new
  assert.equal(live(s.saved).length, 20);
  assert.ok(live(s.saved).includes("s24") && !live(s.saved).includes("s0"), "oldest dropped, newest kept");
  acctApply_(s, Array.from({ length: 20 }, (_, i) => cput(co("C" + i), 5000 + i)), now);
  assert.equal(live(s.companies).length, ACCT.MAX_COMPANIES);
  assert.ok(live(s.companies).includes(coKey(co("C19"))) && !live(s.companies).includes(coKey(co("C0"))));
  // a story dropped for the cap does not come back from a device that still has it
  acctApply_(s, [put("s0", 1000)], now);
  assert.ok(!live(s.saved).includes("s0"));
});
await test("invalid operations are ignored; future timestamps are clamped; tombstones expire", () => {
  const s = fresh();
  acctApply_(s, [{ k: "nope", key: "a", t: 1, v: 1 }, { k: "saved", key: "a", t: 1, v: { id: "a", title: "x", link: "javascript:1" } }, { k: "saved", key: "b", t: 1, v: story("c", iso(1)) }], now);
  assert.deepEqual(live(s.saved), []);
  acctApply_(s, [put("f", now + 9e9)], now);
  assert.ok(s.saved.f.t <= now);
  acctApply_(s, [{ k: "saved", key: "old", t: T0, v: null }], T0 + 100 * 864e5);
  assert.ok(!s.saved.old, "tombstone older than 90 days is gone");
});

/* ---------- client side (docs/app.js, same markers) ---------- */
const page = vm.createContext({ Date, JSON, Object, Map });
const appSrc = fs.readFileSync(path.join(root, "docs/app.js"), "utf8");
const coKeyLine = appSrc.match(/^\s*const coKey = .*$/m)[0];
vm.runInContext(coKeyLine + "\n" + between("docs/app.js", "// ACCT-LWW-BEGIN", "// ACCT-LWW-END") +
  "\nthis.api = { lwwPut, lwwApply, lwwView, diffCompanies, diffViews, coStrip };", page);
// pull the real coStrip/diff pieces too (they sit between the markers)
const { lwwApply, lwwView, diffCompanies } = page.api;

await test("client: pending operations are shown on top of the server records, and they match what the server will do", () => {
  const server = fresh();
  acctApply_(server, [put("a", 1000), cput(co("Alpha"), 1000)], now);
  const recs = JSON.parse(JSON.stringify(server));
  const pending = [del("saved", "a", 2000), cput(co("Beta"), 2100)];
  const v = lwwView(lwwApply(recs, pending));
  assert.deepEqual(Object.keys(v.saved), []);
  assert.deepEqual(v.companies.map((c) => c.name), ["Beta", "Alpha"]);       // newest first
  acctApply_(server, pending, now);
  assert.deepEqual(lwwView(server).companies.map((c) => c.name), ["Beta", "Alpha"]);
});
await test("client: diffCompanies yields add, change and delete, and ignores the 'added' stamp", () => {
  const a = { name: "A", keywords: [], added: 10 }, b = { name: "B", keywords: ["m&a"], added: 20 };
  const ops = diffCompanies([a, b], [{ ...a, added: 99 }, { ...b, kind: "fund" }, { name: "C", keywords: [], added: 30 }].slice(1), 5000);
  const by = Object.fromEntries(ops.map((o) => [o.key, o]));
  assert.equal(by[coKey(a)].v, null);                                 // A removed
  assert.equal(by[coKey(b)].v.kind, "fund");                          // B changed
  assert.equal(by[coKey({ name: "C", keywords: [] })].v.name, "C");   // C added
  assert.equal(ops.length, 3);
  assert.equal(diffCompanies([a], [{ ...a, added: 99 }], 5000).length, 0);
});

console.log(`\n${passed} passed` + (process.exitCode ? ", some FAILED" : ""));
