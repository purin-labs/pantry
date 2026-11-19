import {
  handleBakeryRunRoute,
  matchBakeryRunRoute,
} from "../../services/platform/src/control/routes/bakery-runs.ts";
import {
  handleBakeryRunArtifactRoute,
  matchBakeryRunArtifactRoute,
} from "../../services/platform/src/control/routes/bakery-run-artifacts.ts";
import {
  issueControlSession,
  upsertUser,
} from "../../services/platform/src/data/control-plane.ts";
import { ensureInitialOrganisationPlacement } from "../../services/platform/src/data/organisation-placement.ts";
import { parseOrganisationId } from "../../services/platform/src/ids.ts";
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement.ts";

// This entry is used only by the isolated, loopback acceptance runtime.
const organisationId = required(
  parseOrganisationId("organisation_archive_browser"),
);
const placement = required(
  parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "archive-browser",
    locationHint: "wnam",
  }),
);

export default { fetch: handleRequest };

async function handleRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/setup") return setup(env);
  const artifact = matchBakeryRunArtifactRoute(path);
  if (artifact !== null)
    return handleBakeryRunArtifactRoute(request, env, artifact);
  const run = matchBakeryRunRoute(path);
  if (run !== null) return handleBakeryRunRoute(request, env, run);
  return new Response("Not found", { status: 404 });
}

async function setup(env) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'Archive browser acceptance', ?) ON CONFLICT DO NOTHING",
  )
    .bind(organisationId, now)
    .run();
  required(
    await ensureInitialOrganisationPlacement({
      db: env.DB,
      organisationId,
      environment: "development",
      placement,
      now,
    }),
  );
  const sessions = [];
  for (const subject of ["archive-owner", "archive-reviewer"]) {
    const user = await upsertUser({
      db: env.DB,
      identity: {
        issuer: "https://acceptance.invalid",
        subject,
        email: `${subject}@example.test`,
        displayName: subject,
        emailVerified: true,
      },
      now,
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      ).bind(organisationId, subject, subject),
      env.DB.prepare(
        "INSERT INTO organisation_membership (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'owner', 'active', ?, NULL) ON CONFLICT DO NOTHING",
      ).bind(organisationId, user.userId, subject, now),
    ]);
    sessions.push(
      await issueControlSession({
        db: env.DB,
        userId: user.userId,
        now,
        ttlMs: 3_600_000,
      }),
    );
  }
  return Response.json({ organisationId, sessions });
}

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
