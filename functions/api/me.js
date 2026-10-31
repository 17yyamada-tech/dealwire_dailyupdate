import { authenticate, json } from "../_lib/common.js";

// Who am I, as far as Cloudflare Access can prove. 503 until the Pages variables are set.
export async function onRequestGet({ request, env }) {
  const who = await authenticate(request, env);
  if (who instanceof Response) return who;
  return json(200, { ok: true, email: who.email, sync: true });
}
