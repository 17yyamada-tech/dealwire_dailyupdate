// Verifies the Cloudflare Access JWT (header Cf-Access-Jwt-Assertion) with WebCrypto, RS256.
// Only the email inside a verified token is ever trusted; nothing the browser says about itself is.
const CERTS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 60 * 1000;     // a token with an unknown kid may trigger one refetch per minute
const certsCache = new Map();         // host -> { at, keys }

export class AuthError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function teamHost(team) {
  let t = String(team || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!t) return "";
  if (!t.includes(".")) t += ".cloudflareaccess.com";
  return t;
}
export function allowedAuds(raw) {
  return String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
}

function b64uBytes(s) {
  s = String(s);
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function b64uJson(s) { return JSON.parse(new TextDecoder().decode(b64uBytes(s))); }

async function getKeys(host, fetchFn, nowMs, force) {
  const c = certsCache.get(host);
  if (c && nowMs - c.at < CERTS_TTL_MS && !force) return c.keys;
  if (c && force && nowMs - c.at < REFETCH_MIN_MS) return c.keys;
  const res = await fetchFn(`https://${host}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AuthError("certs_unavailable");
  const body = await res.json();
  const keys = (body && body.keys) || [];
  certsCache.set(host, { at: nowMs, keys });
  return keys;
}
export function clearCertsCache() { certsCache.clear(); }

export async function verifyAccessJwt(token, env, opts = {}) {
  const fetchFn = opts.fetch || ((u) => fetch(u));
  const nowMs = opts.nowMs ?? Date.now(), nowS = Math.floor(nowMs / 1000);
  const host = teamHost(env.CF_ACCESS_TEAM_DOMAIN), auds = allowedAuds(env.CF_ACCESS_AUD);
  if (!host || !auds.length) throw new AuthError("not_configured");
  if (!token || typeof token !== "string") throw new AuthError("no_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed");
  let header, payload;
  try { header = b64uJson(parts[0]); payload = b64uJson(parts[1]); } catch { throw new AuthError("malformed"); }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("bad_alg");

  let keys = await getKeys(host, fetchFn, nowMs, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await getKeys(host, fetchFn, nowMs, true); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) throw new AuthError("unknown_key");
  let key;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch { throw new AuthError("bad_key"); }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new AuthError("bad_signature");

  if (payload.iss !== "https://" + host) throw new AuthError("bad_iss");
  const tokenAuds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!tokenAuds.some(a => auds.includes(a))) throw new AuthError("bad_aud");
  if (typeof payload.exp !== "number" || payload.exp <= nowS) throw new AuthError("expired");
  if (typeof payload.nbf === "number" && payload.nbf > nowS + 60) throw new AuthError("not_yet");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new AuthError("no_email");
  return { email, sub: payload.sub || "" };
}
