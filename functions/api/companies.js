import { authenticate, relay } from "../_lib/common.js";

// This reader's companies with their latest headlines (replaces the vid-based JSONP read).
export async function onRequestGet({ request, env }) {
  const who = await authenticate(request, env);
  if (who instanceof Response) return who;
  return relay(env, { op: "companies", email: who.email });
}
