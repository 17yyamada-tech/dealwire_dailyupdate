import { authenticate, relay, cleanVid } from "../_lib/common.js";

// The shared items (stars, companies, hidden stories) for the verified email.
export async function onRequestGet({ request, env }) {
  const who = await authenticate(request, env);
  if (who instanceof Response) return who;
  const vid = cleanVid(new URL(request.url).searchParams.get("vid"));
  return relay(env, { op: "state", email: who.email, vid });
}
