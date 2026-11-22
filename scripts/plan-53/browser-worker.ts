import {
  handleUserPreferencesRoute,
  matchUserPreferencesRoute,
} from "../../services/platform/src/control/routes/user-preferences";
import {
  issueControlSession,
  upsertUser,
} from "../../services/platform/src/data/control-plane";
import type { Env } from "../../foundation/kernel/env";

// This entry point is used only by the isolated local acceptance Worker.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (request.method === "OPTIONS")
      response = new Response(null, { status: 204 });
    else if (url.pathname === "/test/session" && request.method === "POST") {
      const name = url.searchParams.get("user");
      if (name !== "alice" && name !== "bob")
        return new Response(null, { status: 400 });
      const user = await upsertUser({
        db: env.DB,
        now: Date.now(),
        identity: {
          issuer: "urn:pantry:plan53-browser",
          subject: name,
          email: `${name}@example.test`,
          displayName: name,
          emailVerified: true,
        },
      });
      const session = await issueControlSession({
        db: env.DB,
        userId: user.userId,
        now: Date.now(),
        ttlMs: 3600000,
      });
      response = Response.json({ userId: user.userId });
      response.headers.append(
        "set-cookie",
        `pantry_session=${session.token}; HttpOnly; Path=/; SameSite=Lax`,
      );
      response.headers.append(
        "set-cookie",
        `pantry_csrf=${session.csrfToken}; Path=/; SameSite=Lax`,
      );
    } else {
      const route = matchUserPreferencesRoute(url.pathname);
      response =
        route === null
          ? new Response(null, { status: 404 })
          : await handleUserPreferencesRoute(request, env, route);
    }
    response.headers.set(
      "access-control-allow-origin",
      env.PANTRY_PUBLIC_ORIGIN ?? "http://127.0.0.1:3115",
    );
    response.headers.set("access-control-allow-credentials", "true");
    response.headers.set(
      "access-control-allow-headers",
      "content-type,x-pantry-csrf",
    );
    response.headers.set(
      "access-control-allow-methods",
      "GET,PATCH,POST,OPTIONS",
    );
    return response;
  },
};
