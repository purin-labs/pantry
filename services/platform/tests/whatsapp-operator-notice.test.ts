// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  activateWhatsAppRuntime,
  createConnectorWhatsAppSchema,
  markWhatsAppNoticeDelivered,
  pauseWhatsAppRuntime,
  readWhatsAppOperatorNotice,
  recordWhatsAppOperatorNotice,
  updateWhatsAppRuntimePolicy,
  type WhatsAppIngressLimits,
  type WhatsAppPauseReason,
} from "../src/actors/connector-whatsapp";
import { deliverWhatsAppOperatorNotice } from "../src/actors/whatsapp-operator-notice";
import {
  WHATSAPP_TEST_NOW,
  createWhatsAppWorld,
  whatsappTestEnvBindings,
} from "./whatsapp/environment";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { platformEnv } from "./worker-fakes";

/**
 * `pause_and_notify` is two obligations. These cover the notify half: one
 * notice per cause per published policy, and a delivery path that degrades
 * quietly when the organisation has no destination or no usable credential.
 */

const NOW = WHATSAPP_TEST_NOW;

describe("whatsapp operator notices", whatsappOperatorNoticeSuite);

function whatsappOperatorNoticeSuite(): void {
  it("raises one notice per cause and reopens it on a new policy", dedupeTest);
  it("reports an unselected destination instead of failing", noDestinationTest);
  it(
    "reports an unusable destination credential instead of failing",
    noCredentialTest,
  );
}

function limits(): WhatsAppIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4_096,
    maxActiveCaseMessages: 20,
    maxActiveCaseBytes: 32_768,
    debounceSeconds: 15,
  };
}

function setup(): ReturnType<typeof sqlStorage> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorWhatsAppSchema(sql);
  createActorExecutionBarrierSchema(sql);
  const activated = activateWhatsAppRuntime(sql, {
    organisationId: "organisation_notice",
    integrationAccountId: "integration_account_notice",
    policyVersion: 1,
    limits: limits(),
    supportBindingId: "whatsapp_binding_notice",
    bindingRevision: 1,
    credentialGeneration: 1,
    now: NOW,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  return sql;
}

function dedupeTest(): void {
  const sql = setup();
  const reason: WhatsAppPauseReason = {
    kind: "hourly_message_limit",
    observed: 20,
    limit: 20,
    windowEndsAt: NOW + 3_600_000,
  };
  const first = pauseWhatsAppRuntime(sql, { reason, now: NOW });
  expect(first.kind).toBe("paused");
  expect(first.pendingNoticeKey).not.toBeNull();

  // Still undelivered, so the same cause stays claimable: deduplication must
  // not mean "give up after one failed Slack post".
  const second = pauseWhatsAppRuntime(sql, { reason, now: NOW + 1_000 });
  expect(second.pendingNoticeKey).toBe(first.pendingNoticeKey);

  // Once it has actually been delivered, it stops being raised again.
  markWhatsAppNoticeDelivered(sql, first.pendingNoticeKey ?? "", NOW + 1_500);
  const afterDelivery = pauseWhatsAppRuntime(sql, { reason, now: NOW + 2_000 });
  expect(afterDelivery).toEqual({
    kind: "already_paused",
    pendingNoticeKey: null,
  });

  // A different cause is its own notice.
  const other = recordWhatsAppOperatorNotice(sql, {
    reason: { kind: "active_case_limit", observed: 3, limit: 3 },
    policyVersion: 1,
    now: NOW + 2_000,
  });
  expect(other).not.toBeNull();

  // Per-item causes are keyed by the item they name.
  const firstMessage = recordWhatsAppOperatorNotice(sql, {
    reason: {
      kind: "unsupported_message_type",
      providerMessageId: "wamid.A",
      messageType: "image",
    },
    policyVersion: 1,
    now: NOW + 3_000,
  });
  const secondMessage = recordWhatsAppOperatorNotice(sql, {
    reason: {
      kind: "unsupported_message_type",
      providerMessageId: "wamid.B",
      messageType: "image",
    },
    policyVersion: 1,
    now: NOW + 4_000,
  });
  expect(firstMessage).not.toBe(secondMessage);

  // Republishing the policy is the operator saying they have seen the last
  // notice, so the same cause can raise a fresh one.
  const republished = updateWhatsAppRuntimePolicy(sql, {
    policyVersion: 2,
    limits: limits(),
    supportBindingId: "whatsapp_binding_notice",
    bindingRevision: 1,
    credentialGeneration: 1,
  });
  expect(republished.ok).toBe(true);
  const reopened = recordWhatsAppOperatorNotice(sql, {
    reason,
    policyVersion: 2,
    now: NOW + 5_000,
  });
  expect(reopened).not.toBeNull();
  expect(
    readWhatsAppOperatorNotice(sql, reopened ?? "")?.deliveredAt,
  ).toBeNull();
}

async function noDestinationTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const sql = setup();
  const noticeKey = recordWhatsAppOperatorNotice(sql, {
    reason: { kind: "active_case_limit", observed: 3, limit: 3 },
    policyVersion: 1,
    now: NOW,
  });
  const delivered = await deliverWhatsAppOperatorNotice({
    env: platformEnv({ DB: world.db }),
    sql,
    scope: await requireOrganisationExecutionScope(
      platformEnv(whatsappTestEnvBindings(world.db)),
      world.organisationId,
    ),
    displayPhoneNumber: "+15550001111",
    noticeKey: noticeKey ?? "",
    now: NOW + 100,
    fetcher: unreachableFetcher,
  });
  expect(delivered.ok && delivered.value).toEqual({
    kind: "undeliverable",
    reason: "destination_unselected",
  });
  // An undelivered notice stays open so the next occurrence tries again.
  expect(
    readWhatsAppOperatorNotice(sql, noticeKey ?? "")?.deliveredAt,
  ).toBeNull();
}

async function noCredentialTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  await world.db
    .prepare(
      `INSERT INTO organisation_communication_destination (
       organisation_id, integration_account_id, workspace_id, channel_id,
       provider_revision, selected_at
     ) VALUES (?, ?, 'T0000000001', 'C0000000001', 'rev-1', ?)`,
    )
    .bind(world.organisationId, world.integrationAccountId, NOW)
    .run();
  const sql = setup();
  const noticeKey = recordWhatsAppOperatorNotice(sql, {
    reason: {
      kind: "send_indeterminate",
      proposalId: "proposal_1",
      caseId: "case_1",
    },
    policyVersion: 1,
    now: NOW,
  });
  const delivered = await deliverWhatsAppOperatorNotice({
    env: platformEnv({ DB: world.db }),
    sql,
    scope: await requireOrganisationExecutionScope(
      platformEnv(whatsappTestEnvBindings(world.db)),
      world.organisationId,
    ),
    displayPhoneNumber: "+15550001111",
    noticeKey: noticeKey ?? "",
    now: NOW + 100,
    fetcher: unreachableFetcher,
  });
  expect(delivered.ok && delivered.value.kind).toBe("undeliverable");
  expect(
    readWhatsAppOperatorNotice(sql, noticeKey ?? "")?.deliveredAt,
  ).toBeNull();
}

/** Delivery must never reach the network on these paths. */
const unreachableFetcher = (async () => {
  throw new Error("operator notice delivery attempted a network call");
}) as unknown as typeof fetch;
