// The pages that the draft browser trial opens: one signed-in page for each
// trial person, and the bundled entry that evaluate-pi-durable.mjs builds.
import { issueControlSession } from "../../services/platform/src/data/control-plane.ts";
import { agentUser, humanUser } from "./draft-seed.mjs";

export async function browserFixture(request, env, pathname) {
  if (pathname === "/fixture/entry.js")
    return new Response(env.FIXTURE_BROWSER_ENTRY, {
      headers: { "content-type": "text/javascript" },
    });
  if (pathname === "/fixture/entry.css")
    return new Response(env.FIXTURE_BROWSER_STYLE, {
      headers: { "content-type": "text/css" },
    });
  if (pathname === "/fixture/user/1" || pathname === "/fixture/user/2") {
    const session = await issueControlSession({
      db: env.DB,
      userId: pathname.endsWith("/1") ? agentUser : humanUser,
      now: Date.now(),
      ttlMs: 3600_000,
    });
    const headers = new Headers({ "content-type": "text/html" });
    headers.append(
      "set-cookie",
      `pantry_session=${session.token}; Path=/; HttpOnly; SameSite=Lax`,
    );
    headers.append(
      "set-cookie",
      `pantry_csrf=${session.csrfToken}; Path=/; SameSite=Lax`,
    );
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>R50 draft collaboration</title><link rel="stylesheet" href="/fixture/entry.css"></head><body><main id="root"></main><script type="module" src="/fixture/entry.js"></script></body></html>`,
      { headers },
    );
  }
  return new Response(null, { status: 404 });
}
