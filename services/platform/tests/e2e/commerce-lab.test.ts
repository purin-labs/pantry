import { setTimeout as delay } from "node:timers/promises";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";

import {
  COMMERCE_LAB_SCENARIO_IDS,
  parseLabOptions,
  runCommerceLabWorkflow,
} from "../../../../scripts/lab/run-commerce-lab.mjs";
import {
  compileAndStoreCueSnapshot,
  writeTierOneCommerceSubscription,
  type CommerceCueEventType,
} from "../../src/cues/engine";
import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { CaseSnapshot } from "../../src/actors/case/types";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { issueControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  parseCaseId,
  parseChannelId,
  parseThreadKey,
} from "@purin-labs/kernel/ids";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { requireUserId } from "../test-ids";
import { verifyParallelAssignmentExecution } from "./case-execution-support";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  WORKSPACE_ID,
  installSlackActorFixture,
  openRouterText,
  slackSimulator,
} from "./slack-journey-support";

const NAMESPACE = "lab_pi_sdk_release";
const OWNER = requireUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");

it(
  "runs the six commerce lab scenarios through signed ingress and queue delivery",
  acceptsCommerceLab,
  180_000,
);

async function acceptsCommerceLab(context: TestContext): Promise<void> {
  await installSlackActorFixture();
  await ensureCreatedOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const slack = slackSimulator();
  network.use(
    slack.handler,
    http.post("https://openrouter.ai/api/v1/chat/completions", respondToCue),
  );
  const events: readonly CommerceCueEventType[] = [
    "payment_failed",
    "inventory_shortage",
    "delivery_exception",
    "cancellation_refund_proposed",
  ];
  const channel = parseChannelId(CHANNEL_ID);
  const thread = parseThreadKey(`slack:${WORKSPACE_ID}:${CHANNEL_ID}:channel`);
  if (!channel.ok || !thread.ok) throw new Error("Lab cue destination invalid");
  for (const eventType of events) {
    const subscriptionId = `commerce-lab-${eventType}`;
    await writeTierOneCommerceSubscription({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      subscriptionId,
      workspaceId: WORKSPACE_ID,
      channelId: channel.value,
      threadKey: thread.value,
      eventType,
      template: `Review ${eventType}.`,
      delivery: { kind: "immediate" },
      debounceMs: 0,
      maxPerHour: 20,
    });
    const grant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      grantId: `grant_${subscriptionId}_context`,
      subject: {
        kind: "workflow",
        workflowKind: "cue_subscription",
        workflowId: subscriptionId,
        workflowRevision: 1,
      },
      target: {
        kind: "platform_capability",
        capabilityId: CONTEXT_CASE_READ_CAPABILITY,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_${subscriptionId}`,
      },
      now: Date.now(),
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  await compileAndStoreCueSnapshot({
    db: fixtureDatabase(),
    kv: env.POLICY_KV,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });

  const operations: { command: string; result: unknown }[] = [];
  for (const command of ["seed", "reset", "seed"]) {
    operations.push({ command, result: await runLab([command]) });
  }
  for (const scenario of COMMERCE_LAB_SCENARIO_IDS) {
    const result = await runLab(["scenario", scenario]);
    expect(result).toMatchObject({ scenarioId: scenario, result: "success" });
    operations.push({ command: `scenario ${scenario}`, result });
  }
  const verification = await runLab(["verify"]);
  expect(verification).toMatchObject({
    organisationId: ORGANISATION_ID,
    labNamespace: NAMESPACE,
  });
  await expect.poll(slack.visibleMessageCount).toBe(5);
  const caseExecution = await readInventoryCaseExecution();
  Object.assign(context.task.meta, {
    caseExecution: {
      substituted: [
        "model provider (deterministic OpenRouter transport)",
        "Slack",
        "commerce events (signed by the lab)",
      ],
      ...caseExecution,
    },
    commerceLabEvidence: {
      namespace: NAMESPACE,
      operations,
      verification,
      messages: slack.messages,
    },
  });
}

/**
 * The inventory shortage starts a coordinator and a specialist side by side
 * in one Case. An owner of the active organisation reads that Case's
 * execution. Activation, the owner's Case read grant and membership of the
 * default Project are what provisioning gives an owner. This fixture adds
 * them after the scenarios, for the read alone.
 */
async function readInventoryCaseExecution() {
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, OWNER),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_attempt (
         activation_attempt_id, organisation_id, readiness_version, readiness_hash,
         status, started_at, updated_at, completed_at
       ) VALUES ('activation_attempt_lab_reader', ?, 1, 'lab-reader-ready',
         'completed', ?, ?, ?)`,
      )
      .bind(ORGANISATION_ID, now, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_receipt (
         activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
         policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at
       ) VALUES ('activation_receipt_lab_reader', 'activation_attempt_lab_reader', ?,
         'lab-reader-ready', 'setup_policy_lab_reader', 'setup_cue_lab_reader',
         'read_and_propose', ?)`,
      )
      .bind(ORGANISATION_ID, now),
    fixtureDatabase()
      .prepare(
        `UPDATE organisation_onboarding SET lifecycle = 'active',
         activation_receipt_id = 'activation_receipt_lab_reader', activated_at = ?
       WHERE organisation_id = ?`,
      )
      .bind(now, ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
       SELECT organisation_id, project_id, ?, 'owner'
       FROM organisation_default_project WHERE organisation_id = ?`,
      )
      .bind(OWNER, ORGANISATION_ID),
  ]);
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_lab_owner_case_read",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_lab_owner_case_read",
    },
    now,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const session = await issueControlSession({
    db: env.DB,
    userId: OWNER,
    now,
    ttlMs: 30 * 60_000,
  });
  const filed = await fixtureDatabase()
    .prepare(
      "SELECT case_id FROM case_project WHERE organisation_id = ? ORDER BY case_id",
    )
    .bind(ORGANISATION_ID)
    .all<{ case_id: string }>();
  const parallel: { caseId: string; snapshot: CaseSnapshot }[] = [];
  for (const row of filed.results) {
    const caseId = parseCaseId(row.case_id);
    if (!caseId.ok) throw new Error("Lab Case identity invalid");
    const actor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: ORGANISATION_ID,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!actor.ok) throw new Error(actor.error.code);
    const snapshot = await actor.value.inspect();
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    if (snapshot.value.assignmentLifecycles.length > 1)
      parallel.push({ caseId: row.case_id, snapshot: snapshot.value });
  }
  // One scenario of the lab starts two assignments: the inventory shortage.
  expect(parallel).toHaveLength(1);
  const inventory = parallel[0];
  if (inventory === undefined) throw new Error("Missing inventory Case");
  return verifyParallelAssignmentExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId: inventory.caseId,
    canonical: inventory.snapshot,
  });
}

async function runLab(args: readonly string[]): Promise<unknown> {
  const options = parseLabOptions(args, {
    PANTRY_WORKER_URL: "https://localhost",
    PANTRY_LAB_ORGANISATION_ID: ORGANISATION_ID,
    PANTRY_COMMERCE_LAB_NAMESPACE: NAMESPACE,
    ORGANISATION_ADMIN_TOKEN: env.ORGANISATION_ADMIN_TOKEN,
    PANTRY_COMMERCE_LAB_SIGNING_SECRET: env.COMMERCE_LAB_SIGNING_SECRET,
  });
  return runCommerceLabWorkflow(options, {
    fetchImplementation: fetchWorker,
    clock: Date.now,
    delay,
  });
}

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return exports.default.fetch(new Request(input, init));
}

function respondToCue(): Response {
  return openRouterText(
    "Commerce evidence reviewed. Operator approval is required for any business action.",
    `lab_cue_${crypto.randomUUID()}`,
  );
}
