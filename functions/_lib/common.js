import { verifyAccessJwt, AuthError, teamHost, allowedAuds } from "./access.js";

export const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export function configured(env) {
  return !!(env.APPS_SCRIPT_URL && env.SYNC_SECRET && teamHost(env.CF_ACCESS_TEAM_DOMAIN) && allowedAuds(env.CF_ACCESS_AUD).length);
}

// Returns { email } or a Response to send back.
export async function authenticate(request, env, opts) {
  if (!configured(env)) return json(503, { error: "not_configured" });
  try {
    return await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), env, opts);
  } catch (e) {
    if (e instanceof AuthError) return json(e.code === "certs_unavailable" ? 503 : 401, { error: e.code });
    return json(500, { error: "auth_failed" });
  }
}

// Sends one request to the Apps Script with the shared secret. The email is the verified one.
export async function relay(env, body, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(env.APPS_SCRIPT_URL, {
      method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: "acct", secret: env.SYNC_SECRET }),
    });
  } catch { return json(502, { error: "upstream_unreachable" }); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { return json(502, { error: "upstream_bad_reply" }); }
  if (data && data.error) return json(data.error === "forbidden" ? 502 : 400, { error: String(data.error) });
  return json(200, data);
}

export const cleanVid = (v) => (/^[a-f0-9]{24,40}$/.test(String(v || "")) ? String(v) : "");
