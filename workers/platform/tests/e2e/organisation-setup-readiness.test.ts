import { exports } from "cloudflare:workers";
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
