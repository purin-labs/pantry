import { exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  replyingModel,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    organisationArchiveAccess?: Record<string, unknown>;
  }
}

// Plan 95 step 1, journey J2. Pantry decides access from its own records. An
// archive stops the work of the Organisation, but its owner can still read
// the archived Organisation and restore it: the access check of Pantry keeps
// an archived Organisation eligible until its purge.
it(
  "stops Slack work after an archive and keeps the owner's read and restore",
  archiveJourney,
  60_000,
);

async function archiveJourney(context: TestContext): Promise<void> {
  const { ownerSession } = await installSlackActorFixture();
  const model = replyingModel();
  const slack = slackSimulator();
  network.use(model.handler, slack.handler);

  // Before the archive, a mention opens a Case and gets an answer.
  const before = await mention("EvArchive_BEFORE", ROOT_TS);
  expect(before).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(model.requests).toBe(1);

  const archived = await lifecycleCommand(ownerSession, "archive");
  expect(archived.status, await archived.clone().text()).toBe(200);

  // Denied: a mention during the archive starts no turn.
  const during = await mention("EvArchive_DURING", "1787500300.000001");
  expect(during.status).toBe(200);
  expect(during.durableMode).not.toBe("case_accepted");
  // The owner still reads the archived Organisation.
  const archivedRead = await readOrganisation(ownerSession);
  expect(archivedRead.status).toBe(200);
  expect(archivedRead.text).toContain('"archived"');

  // The owner restores it, and reads it again.
  const restored = await lifecycleCommand(ownerSession, "restore");
  expect(restored.status, await restored.clone().text()).toBe(200);
  const restoredRead = await readOrganisation(ownerSession);
  expect(restoredRead.status).toBe(200);
  const lifecycle = await fixtureDatabase()
    .prepare(
      "SELECT lifecycle FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<string>("lifecycle");
  expect(lifecycle).not.toBe("archived");

  // The mention during the archive added no turn and no answer.
  expect(model.requests).toBe(1);
  expect(slack.visibleMessageCount()).toBe(1);
  context.task.meta.organisationArchiveAccess = {
    mentionBefore: before,
    archive: archived.status,
    mentionDuringArchive: during,
    ownerReadDuringArchive: archivedRead.status,
    restore: restored.status,
    ownerReadAfterRestore: restoredRead.status,
    lifecycleAfterRestore: lifecycle,
    modelRequests: model.requests,
    slackAnswers: slack.visibleMessageCount(),
  };
}

async function mention(
  eventId: string,
  ts: string,
): Promise<{ readonly status: number; readonly durableMode: string | null }> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs: ts,
        threadTs: ts,
        text: "<@U0PANTRY> what sold today?",
      }),
    ),
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    durableMode:
      isRecord(body) && typeof body.durableMode === "string"
        ? body.durableMode
        : null,
  };
}

async function lifecycleCommand(
  owner: IssuedControlSession,
  command: "archive" | "restore",
): Promise<Response> {
  const version = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  const headers = commerceHeaders(owner);
  headers.set("idempotency-key", `archive-access-${command}`);
  headers.set("x-satyr-configuration-version", String(version));
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/${command}`,
    { method: "POST", headers, body: "{}" },
  );
}

async function readOrganisation(
  owner: IssuedControlSession,
): Promise<{ readonly status: number; readonly text: string }> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}`,
    { headers: commerceHeaders(owner) },
  );
  return { status: response.status, text: await response.text() };
}
