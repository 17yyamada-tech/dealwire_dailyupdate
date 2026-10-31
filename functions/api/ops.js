import { authenticate, relay, cleanVid, json } from "../_lib/common.js";

const MAX_BODY = 200 * 1024, MAX_OPS = 200;

// Applies change operations ({k, key, t, v}) to the verified email's state and returns the new state.
export async function onRequestPost({ request, env }) {
  // a custom header plus JSON makes this a request another site cannot send from a browser
  if (request.headers.get("X-DW-Sync") !== "1" || !/^application\/json/i.test(request.headers.get("Content-Type") || "")) {
    return json(400, { error: "bad_request" });
  }
  const who = await authenticate(request, env);
  if (who instanceof Response) return who;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "bad_json" }); }
  const ops = Array.isArray(body && body.ops) ? body.ops.slice(0, MAX_OPS) : null;
  if (!ops) return json(400, { error: "bad_ops" });
  return relay(env, { op: "ops", email: who.email, ops, vid: cleanVid(body.vid) });
}
