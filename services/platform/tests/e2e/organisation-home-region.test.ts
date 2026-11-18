import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";

// What Cloudflare reports for the client of a request, as `request.cf`.
const TOKYO = {
  continent: "AS",
  country: "JP",
  latitude: "35.68950",
  longitude: "139.69171",
};
const NEW_YORK = {
  continent: "NA",
  country: "US",
  latitude: "40.71280",
  longitude: "-74.00600",
};
// An address with no known coordinates.
const OCEANIA = { continent: "OC", country: "NZ" };

type RequestOrigin = Readonly<Record<string, string>> | null;

it(
  "suggests the home region nearest to the request",
  homeRegionJourney,
  60_000,
);

async function homeRegionJourney({ task }: TestContext): Promise<void> {
  const session = await signIn();

  // The form's choices, and the one it selects first.
  const suggestions = {
    tokyo: await readHomeRegions(session, TOKYO),
    newYork: await readHomeRegions(session, NEW_YORK),
    continentOnly: await readHomeRegions(session, OCEANIA),
    unknown: await readHomeRegions(session, null),
  };
  // The test profile also offers the fixture cells of the other journeys.
  const choices = expect.arrayContaining([
    { id: "regional-wnam", area: "wnam" },
    { id: "regional-apac", area: "apac" },
  ]);
  expect(suggestions).toEqual({
    tokyo: { suggested: "regional-apac", choices },
    newYork: { suggested: "regional-wnam", choices },
    continentOnly: { suggested: "regional-apac", choices },
    unknown: { suggested: "regional-wnam", choices },
  });
  expect(
    (await exports.default.fetch("https://localhost/v1/control/home-regions"))
      .status,
  ).toBe(401);

  Object.assign(task.meta, {
    homeRegion: { suggestions },
  });
}

async function signIn(): Promise<IssuedControlSession> {
  const now = Date.now();
  const user = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "home-region-owner",
      email: "owner@home-region.example.test",
      displayName: "Home region owner",
      emailVerified: true,
    },
    now,
  });
  return issueControlSession({
    db: env.DB,
    userId: user.userId,
    now,
    ttlMs: 600_000,
  });
}

function controlRequest(
  session: IssuedControlSession,
  origin: RequestOrigin,
  path: string,
  init: { readonly idempotencyKey: string; readonly body: unknown } | null,
): Promise<Response> {
  const headers = new Headers({
    origin: "https://localhost",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  });
  if (init !== null) {
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", init.idempotencyKey);
  }
  return exports.default.fetch(
    new Request(`https://localhost${path}`, {
      method: init === null ? "GET" : "POST",
      headers,
      body: init === null ? undefined : JSON.stringify(init.body),
      ...(origin === null ? {} : { cf: origin }),
    }),
  );
}

async function readHomeRegions(
  session: IssuedControlSession,
  origin: RequestOrigin,
): Promise<unknown> {
  const response = await controlRequest(
    session,
    origin,
    "/v1/control/home-regions",
    null,
  );
  const body = await response.json<{ ok: boolean; homeRegions?: unknown }>();
  if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
  return body.homeRegions;
}
