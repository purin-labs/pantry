import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { fixtureDatabase } from "./organisation-database";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  WORKSPACE_ID,
  discoverSlackChannel,
  installSlackActorFixture,
} from "./slack-journey-support";
import { slackAuthTestHandler } from "./slack-workspace-support";
import { network } from "./network";
import { runCronMinutes, WriteMeter, type WriteCounts } from "./write-meter";

declare module "vitest" {
  interface TaskMeta {
    organisationSetupReadiness?: Record<string, unknown>;
  }
}

const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;

// An admin saves the setup of a shop that has its Slack channel but no shop
// system yet. Readiness names the missing shop system, so the Portal offers no
// activation. A request that sends the version and hash of that blocked
// assessment anyway is refused, and the Organisation stays in setup.
it(
  "refuses to activate an Organisation whose readiness assessment names a blocker, and keeps it in setup",
  blockedActivationJourney,
  120_000,
);

async function blockedActivationJourney({ task }: TestContext): Promise<void> {
  const owner = await savedSetupWithoutShop();
  const before = await readProjection(owner);
  expect(before.organisation).toMatchObject({
    lifecycle: { kind: "configuring" },
  });
  const readiness = record(before.readiness);
  expect(readiness.kind).toBe("blocked");
  expect(blockerCodes(readiness)).toContain("commerce_system_missing");

  const activated = await mutate(
    owner,
    "POST",
    "activate",
    {
      readinessVersion: readiness.readiness_version,
      readinessHash: readiness.readiness_hash,
    },
    Number(before.configuration_version),
  );
  const answer: unknown = await activated.json();
  expect(activated.status, JSON.stringify(answer)).toBe(409);
  expect(answer).toMatchObject({
    error: "activation_readiness_stale",
    detail: "readiness_assessment_blocked",
  });

  // The Organisation stays in setup, and no activation attempt or receipt
  // exists for it.
  const after = await readProjection(owner);
  expect(after.organisation).toMatchObject({
    lifecycle: { kind: "configuring" },
  });
  expect(await activationRows()).toEqual({ attempts: 0, receipts: 0 });

  task.meta.organisationSetupReadiness = {
    blockers: blockerCodes(readiness),
    activation: { status: activated.status, answer },
    lifecycleAfter: record(record(after.organisation).lifecycle).kind,
  };
}

// The same shop waits in setup and nothing changes. The 15-minute run of the
// production Worker still names the missing shop system in readiness, but a
// run that finds nothing new writes no row and leaves the Organisation
// unchanged, so that a shop in setup costs close to nothing.
it(
  "writes nothing in the 15-minute runs while a saved setup waits for its shop system",
  idleSetupJourney,
  180_000,
);

async function idleSetupJourney({ task }: TestContext): Promise<void> {
  const owner = await savedSetupWithoutShop();
  // The health check of the run asks Slack about the bot token.
  const slackChecks: string[] = [];
  network.use(slackAuthTestHandler(WORKSPACE_ID, slackChecks));
  const crons = env.TEST_PRODUCTION_CRONS.filter(isQuarterHourCron);
  expect(crons).toHaveLength(1);
  const meter = new WriteMeter();
  const quarter = 15 * 60_000;
  const firstRunAt = Math.ceil(Date.now() / quarter) * quarter;
  // The first run may settle what the setup left.
  await runCronMinutes({ env: meter.env, crons, from: firstRunAt, minutes: 1 });
  const settled = await readProjection(owner);
  meter.takeStatements();

  const idleRuns: WriteCounts[] = [];
  for (const run of [1, 2, 3])
    idleRuns.push(
      await meter.during(() =>
        runCronMinutes({
          env: meter.env,
          crons,
          from: firstRunAt + run * quarter,
          minutes: 1,
        }),
      ),
    );
  const statements = meter.takeStatements();
  expect(
    idleRuns.filter((written) => Object.keys(written).length > 0),
    `rows that the idle runs wrote\n${statements.join("\n")}`,
  ).toEqual([]);

  // Readiness still names the missing shop system, and the Organisation
  // reads as unchanged since the first run.
  const after = await readProjection(owner);
  expect(blockerCodes(record(after.readiness))).toContain(
    "commerce_system_missing",
  );
  expect(after.updated_at).toBe(settled.updated_at);
  expect(record(after.readiness).readiness_version).toBe(
    record(settled.readiness).readiness_version,
  );

  task.meta.organisationSetupReadiness = {
    idleRuns,
    readinessVersion: record(after.readiness).readiness_version,
    blockers: blockerCodes(record(after.readiness)),
  };
}

// The Portal records each setup stage that a person opens. A page on
// another site, or a request without the Portal's CSRF header, cannot add
// such a record in the person's name.
it(
  "records a viewed setup stage only from the Portal with its CSRF header",
  stageViewedJourney,
  120_000,
);

async function stageViewedJourney({ task }: TestContext): Promise<void> {
  const { ownerSession: owner } = await installSlackActorFixture();
  const path = `${BASE}/onboarding/stage-viewed`;
  const body = JSON.stringify({ stage: "operating_profile" });
  const viewed = await exports.default.fetch(path, {
    method: "POST",
    headers: headers(owner),
    body,
  });
  expect(viewed.status, await viewed.clone().text()).toBe(200);
  expect(await stageViews()).toBe(1);

  // Denied: no CSRF header, as a form on another page sends it.
  const noCsrf = headers(owner);
  noCsrf.delete("x-pantry-csrf");
  const forged = await exports.default.fetch(path, {
    method: "POST",
    headers: noCsrf,
    body,
  });
  expect(forged.status).toBe(403);
  expect(await forged.json()).toMatchObject({ error: "csrf_invalid" });
  // Denied: another origin.
  const elsewhere = headers(owner);
  elsewhere.set("origin", "https://elsewhere.example");
  const crossSite = await exports.default.fetch(path, {
    method: "POST",
    headers: elsewhere,
    body,
  });
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ error: "origin_invalid" });
  expect(await stageViews()).toBe(1);

  task.meta.organisationSetupReadiness = {
    portal: viewed.status,
    withoutCsrf: forged.status,
    otherOrigin: crossSite.status,
    stageViews: 1,
  };
}

async function stageViews(): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM onboarding_event WHERE organisation_id = ? AND event_type = 'onboarding_stage_viewed'",
    )
    .bind(ORGANISATION_ID)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function isQuarterHourCron(cron: string): boolean {
  return cron.trim().startsWith("*/15 ");
}

/**
 * The Slack fixture Organisation, with its channel discovered, after its
 * owner saved the setup in the Portal. It has no shop system.
 */
async function savedSetupWithoutShop(): Promise<IssuedControlSession> {
  const { ownerSession } = await installSlackActorFixture();
  await discoverSlackChannel("public_channel");
  const projection = await readProjection(ownerSession);
  const saved = await mutate(
    ownerSession,
    "PUT",
    "setup",
    {
      policyTemplateId: "commerce_operator",
      capabilityProfile: "read_and_propose",
      cuePresetId: "observe_commerce",
      cueTarget: { workspaceId: WORKSPACE_ID, channelId: CHANNEL_ID },
    },
    Number(projection.configuration_version),
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  return ownerSession;
}

async function readProjection(
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(BASE, {
    headers: headers(session),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return record(body);
}

function mutate(
  session: IssuedControlSession,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
  configurationVersion: number,
): Promise<Response> {
  const sent = headers(session);
  sent.set("idempotency-key", crypto.randomUUID());
  sent.set("x-pantry-configuration-version", String(configurationVersion));
  return exports.default.fetch(`${BASE}/${path}`, {
    method,
    headers: sent,
    body: JSON.stringify(body),
  });
}

function headers(session: IssuedControlSession): Headers {
  return new Headers({
    "content-type": "application/json",
    origin: "https://localhost",
    cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
    "x-pantry-csrf": session.csrfToken,
  });
}

async function activationRows(): Promise<{
  attempts: number;
  receipts: number;
}> {
  const row = await fixtureDatabase()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM organisation_activation_attempt WHERE organisation_id = ?) AS attempts,
         (SELECT COUNT(*) FROM organisation_activation_receipt WHERE organisation_id = ?) AS receipts`,
    )
    .bind(ORGANISATION_ID, ORGANISATION_ID)
    .first<{ attempts: number; receipts: number }>();
  if (row === null) throw new Error("Missing activation counts");
  return { attempts: row.attempts, receipts: row.receipts };
}

function blockerCodes(readiness: Record<string, unknown>): string[] {
  const blockers = readiness.blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.map((blocker: unknown) =>
    isRecord(blocker) ? String(blocker.code) : "",
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Expected a record: ${JSON.stringify(value)}`);
  return value;
}
