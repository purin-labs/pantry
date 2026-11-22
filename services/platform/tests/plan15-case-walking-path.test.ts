import { createMigratedDatabase } from "./sqlite-d1";
import { activateActorFixture } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { CASE_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { parseCaseId } from "@purin-labs/kernel/ids";
import {
  withCaseMutationExecution,
  admitCaseMutationFixture,
  allowCaseMutationFixture,
} from "./case-mutation-fixture";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";
import type {
  CaseContent,
  CaseAssignment,
  StoredMessageAttachment,
} from "@purin-labs/contracts";

vi.mock(
  "@purin-labs/authority/policy/information-flow/source-labels",
  async function mockSourceLabels() {
    const { FlowLabel } =
      await import("@purin-labs/authority/policy/information-flow/labels");
    const { sourceReaderForAuthority } =
      await import("@purin-labs/authority/policy/information-flow/source-readers");
    return {
      createCurrentSourceFlowLabel: async function createFixtureSourceLabel(
        input: Readonly<{
          readonly kind: string;
          readonly authority: import("@purin-labs/contracts").RequestAuthority;
        }>,
      ) {
        if (input.kind !== "ingress") {
          return {
            ok: false as const,
            error: { code: "source_policy_invalid" as const, field: "kind" },
          };
        }
        return FlowLabel.create([
          {
            owner: {
              kind: "organisation",
              organisationId: input.authority.organisationId,
            },
            readers: [sourceReaderForAuthority(input.authority)],
          },
        ]);
      },
    };
  },
);

import { CaseDO } from "../src/actors/case";
import type { CaseSnapshot } from "../src/actors/case/types";
import {
  parseMessageCaseContent,
  caseContentAttachments,
  caseContentInstruction,
} from "../src/actors/case-content";
import { actorPhysicalName } from "@purin-labs/actor-runtime/actors/actor-registry";
import { slackCaseTurnId } from "../src/actors/case-turn-stream";
import {
  authorizeCaseConversationOutput,
  runDirectCasePath,
  runDirectTwoSessionCasePath,
  runOngoingCaseTurn as executeOngoingCaseTurn,
  admitOngoingCaseTurn,
  type CaseWalkingSession,
  type OngoingCaseTurnInput as AdmittedOngoingCaseTurnInput,
  type OngoingCaseWalkingConnector,
  type OngoingCaseWalkingSession,
} from "../src/actors/case-walking-path";
type OngoingCaseTurnInput = Omit<AdmittedOngoingCaseTurnInput, "admittedCase">;

async function runOngoingCaseTurn(input: OngoingCaseTurnInput) {
  const admitted = await admitOngoingCaseTurn({
    connector: input.connector,
    connectorIdentity: input.connectorIdentity,
    caseActor: input.caseActor,
    organisationId: input.organisationId,
    ingress: input.ingress,
    binding: input.binding,
    purpose: input.purpose,
    workspaceRevisionReceipt: input.workspaceRevisionReceipt,
    requestAuthority: input.turnAuthority.requestAuthority,
    receivedAt: input.receivedAt,
  });
  if (!admitted.ok) return admitted;
  return executeOngoingCaseTurn({ ...input, admittedCase: admitted.value });
}

import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { parseSlackUserId } from "../src/slack/events";
import {
  fixtureCaseTurnContext,
  fixtureDirectTwoSessionContext,
  fixtureControlRequestAuthority,
  fixtureRequestAuthority,
  fixtureTurnAuthority,
} from "./fixtures/plan25-turn";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  digestCanonical,
  flowBindingForContext,
  InformationFlowContext,
  type SerializedFlowBinding,
} from "@purin-labs/authority/policy/index";
import { authorityPartitionKey } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const PLAN15_REQUEST_AUTHORITY = fixtureControlRequestAuthority({
  organisationId: requiredOrganisationId(),
  requesterPersonId: "person_plan15",
  userId: "user_f7df3be4-23b5-579a-8d2b-d31b348f5fb0",
  role: "owner",
});
const PLAN15_SLACK_REQUEST_AUTHORITY = fixtureRequestAuthority(
  requiredOrganisationId(),
  "connector_slack_plan15",
);
const PLAN15_ASSIGNMENT_REQUEST_AUTHORITY = fixtureRequestAuthority(
  requiredOrganisationId(),
  "connector_fixture",
);
const PLAN15_TRIGGER_AUTHORITY = fixtureRequestAuthority(
  requiredOrganisationId(),
  "connector_plan15",
);

describe("Plan 15 Case walking path", function plan15CaseWalkingPathSuite() {
  it(
    "retains record messages across replay and rejects changed or foreign locators",
    retainsRecordMessage,
  );
  it(
    "commits Case output before delivery and settles the exact receipt once",
    settlesDurableCaseOutput,
  );
  it(
    "rejects Case output from an incompatible authority partition",
    rejectsPartitionChangedOutput,
  );
  it(
    "rebases stale shared changes and cancels one assignment without changing its sibling",
    rebasesAndCancelsIndependently,
  );
  it(
    "settles an ongoing Slack assignment when its budget is exhausted",
    settlesOngoingBudgetExhaustion,
  );
  it(
    "preserves typed budget exhaustion when replay fails",
    preservesOngoingBudgetExhaustion,
  );
  it(
    "settles an ongoing Slack assignment when session replay fails",
    settlesOngoingSessionStreamFailure,
  );
  it(
    "binds a governed commerce proposal to Case history and rejects stale revisions",
    acceptsCommerceProposal,
  );
  it(
    "appends and delivers a terminal commerce outcome idempotently",
    acceptsCommerceOutcome,
  );
  it(
    "accepts one unbound Cue trigger into shared Case history",
    acceptsDirectCueCase,
  );
  it(
    "accepts a two-session Konbini Cue in completion order",
    acceptsDirectKonbiniCase,
  );
  it(
    "recovers a durable streamed turn without starting the model again",
    recoversStreamedTurn,
  );
  it(
    "settles an existing running assignment when stream recovery times out",
    settlesRecoveredSessionStreamFailure,
  );
  it(
    "addresses a direct two-session Cue to one Slack channel exactly once",
    addressesDirectKonbiniCase,
  );
  it(
    "accepts a WhatsApp support assignment at the Case boundary",
    acceptsWhatsAppSupportAssignment,
  );
});

async function acceptsWhatsAppSupportAssignment(): Promise<void> {
  const caseActor = actor(CaseDO);
  const ensured = await caseActor.ensure({
    identity: {
      organisationId: "organisation_plan15",
      caseId: "case_plan15_whatsapp",
    },
    purpose: "WhatsApp support 61433641770",
    workspaceRevision: "workspace_revision_plan15_1",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  expect(ensured.ok).toBe(true);
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  expect(
    await caseActor.assignSession(whatsAppAssignmentFixture(snapshot.value)),
  ).toMatchObject({ ok: true, value: { kind: "assigned" } });
}

function testSessionRoute(
  organisationId: OrganisationId,
  sessionId: SessionId,
) {
  const placement = parseOrganisationPlacement(
    {
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "multi-region-preview",
      locationHint: "wnam",
    },
    "test.sessionRoute",
  );
  if (!placement.ok) throw new Error(placement.error.code);
  return {
    physicalObjectName: actorPhysicalName(
      { objectKind: "session", organisationId, logicalObjectId: sessionId },
      placement.value,
    ),
    placement: placement.value,
  };
}

async function recoversStreamedTurn(): Promise<void> {
  const caseActor = actor(CaseDO);
  await caseActor.ensure({
    identity: {
      organisationId: "organisation_plan15",
      caseId: "case_plan15_rebase",
    },
    purpose: "Recover one streamed turn.",
    workspaceRevision: "workspace_revision_plan15_1",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  await caseActor.acceptTrigger({
    triggerId: "trigger_ingress_plan15_recovery",
    caseId: "case_plan15_rebase",
    source: {
      kind: "connector",
      connectorId: "connector_slack_plan15",
      ingressId: "ingress_plan15_recovery",
    },
    content: { kind: "text", text: "Recover this response." },
    acceptedAt: 1_000,
    attachments: [],
  });
  await caseActor.attachBinding({
    bindingId: "binding_plan15_recovery",
    caseId: "case_plan15_rebase",
    connectorId: "connector_slack_plan15",
    address: {
      kind: "slack",
      workspaceId: "T_plan15",
      channelId: "conversation_fixture",
      threadTs: "1785700000.000010",
    },
  });
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignment = assignmentFixture(
    "coordinator",
    snapshot.value,
    "case_plan15_rebase",
    "connector_slack_plan15",
  );
  await caseActor.assignSession(assignment);
  await caseActor.beginAssignment(
    beginFixture(assignment, slackCaseTurnId("ingress_plan15_recovery")),
  );
  const baseConnector = recordingConnector();
  let recoveryCalls = 0;
  const connector: OngoingCaseWalkingConnector = {
    ...baseConnector,
    async streamCaseTurn() {
      recoveryCalls += 1;
      return {
        ok: true,
        value: {
          finalMessage: "Recovered response.",
          canonicalMessage: "Recovered response.",
        },
      };
    },
  };
  const session: OngoingCaseWalkingSession = {
    async inspectTurnStream() {
      return { ok: true, value: { kind: "present", state: "complete" } };
    },
    async initializeCaseSession() {
      throw new Error("recovery must not initialize the session");
    },
    async prepareSessionInformationFlow(input) {
      return {
        ok: true,
        value: { flowBinding: await fixtureSerializedFlowBinding(input) },
      };
    },
    async startCanonicalEmbeddedHarnessTextTurn() {
      throw new Error("recovery must not start the model");
    },
  };
  const recipientUserId = parseSlackUserId("U0RECOVERY", "recipientUserId");
  if (!recipientUserId.ok) throw new Error(recipientUserId.error.code);
  const base = walkingInput(baseConnector, caseActor, session);
  const input = {
    ...base,
    // A later attempt of the same work: an earlier one started the turn.
    attempt: 2,
    connector,
    session,
    sessionId: requiredSessionId(assignment.sessionId),
    sessionRoute: testSessionRoute(
      base.organisationId,
      requiredSessionId(assignment.sessionId),
    ),
    ingress: {
      ...base.ingress,
      ingressId: "ingress_plan15_recovery",
      nativeEventId: "Ev_plan15_recovery",
      caseId: "case_plan15_rebase",
      content: { kind: "text" as const, text: "Recover this response." },
    },
    binding: {
      bindingId: "binding_plan15_recovery",
      caseId: "case_plan15_rebase",
      connectorId: "connector_slack_plan15",
      address: {
        kind: "slack" as const,
        workspaceId: "T_plan15",
        channelId: "conversation_fixture",
        threadTs: "1785700000.000010",
      },
    },
    assignmentId: assignment.assignmentId,
    output: {
      kind: "slack_stream" as const,
      recipientUserId: recipientUserId.value,
    },
  } satisfies OngoingCaseTurnInput;
  const result = await runOngoingCaseTurn(input);
  if (!result.ok) throw new Error(result.error.code);
  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: "completed",
      completion: { finalMessage: "Recovered response." },
    },
  });
  expect(recoveryCalls).toBe(1);
}

async function settlesRecoveredSessionStreamFailure(): Promise<void> {
  const caseActor = actor(CaseDO);
  const caseId = "case_plan15_recovery_timeout";
  await caseActor.ensure({
    identity: { organisationId: "organisation_plan15", caseId },
    purpose: "Settle a timed-out recovered stream.",
    workspaceRevision: "workspace_revision_plan15_1",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  await caseActor.acceptTrigger({
    triggerId: "trigger_plan15_recovery_timeout",
    caseId,
    source: {
      kind: "connector",
      connectorId: "connector_slack_plan15",
      ingressId: "ingress_plan15_recovery_timeout",
    },
    content: { kind: "text", text: "Recover this timed-out response." },
    acceptedAt: 1_000,
    attachments: [],
  });
  await caseActor.attachBinding({
    bindingId: "binding_plan15_recovery_timeout",
    caseId,
    connectorId: "connector_slack_plan15",
    address: {
      kind: "slack",
      workspaceId: "T_plan15",
      channelId: "conversation_fixture",
      threadTs: "1785700000.000011",
    },
  });
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignment = assignmentFixture(
    "coordinator",
    snapshot.value,
    caseId,
    "connector_slack_plan15",
  );
  await caseActor.assignSession(assignment);
  await caseActor.beginAssignment(
    beginFixture(
      assignment,
      slackCaseTurnId("ingress_plan15_recovery_timeout"),
    ),
  );

  let starts = 0;
  let recoveries = 0;
  const session: OngoingCaseWalkingSession = {
    async inspectTurnStream() {
      return { ok: true, value: { kind: "present", state: "running" } };
    },
    async initializeCaseSession() {
      throw new Error("recovery must not initialize the session");
    },
    async prepareSessionInformationFlow(input) {
      return {
        ok: true,
        value: { flowBinding: await fixtureSerializedFlowBinding(input) },
      };
    },
    async startCanonicalEmbeddedHarnessTextTurn() {
      starts += 1;
      throw new Error("recovery must not start the model");
    },
  };
  const baseConnector = recordingConnector();
  const connector: OngoingCaseWalkingConnector = {
    ...baseConnector,
    async streamCaseTurn() {
      recoveries += 1;
      return {
        ok: false,
        error: { kind: "operational", code: "session_stream_replay_timeout" },
      };
    },
  };
  const recipientUserId = parseSlackUserId("U0RECOVERFAIL", "recipientUserId");
  if (!recipientUserId.ok) throw new Error(recipientUserId.error.code);
  const base = walkingInput(connector, caseActor, session);
  const result = await runOngoingCaseTurn({
    ...base,
    attempt: 2,
    sessionId: requiredSessionId(assignment.sessionId),
    sessionRoute: testSessionRoute(
      base.organisationId,
      requiredSessionId(assignment.sessionId),
    ),
    ingress: {
      ...base.ingress,
      ingressId: "ingress_plan15_recovery_timeout",
      nativeEventId: "Ev_plan15_recovery_timeout",
      caseId,
    },
    binding: {
      ...base.binding,
      bindingId: "binding_plan15_recovery_timeout",
      caseId,
      address: {
        kind: "slack",
        workspaceId: "T_plan15",
        channelId: "conversation_fixture",
        threadTs: "1785700000.000011",
      },
    },
    assignmentId: assignment.assignmentId,
    output: { kind: "slack_stream", recipientUserId: recipientUserId.value },
  });

  expect(result).toEqual({
    ok: false,
    error: {
      kind: "operational",
      code: "session_stream:session_stream_replay_timeout",
    },
  });
  expect(recoveries).toBe(1);
  expect(starts).toBe(0);
  expect(await caseActor.inspect()).toMatchObject({
    ok: true,
    value: {
      outputs: [],
      assignmentLifecycles: [
        {
          kind: "settled",
          disposition: {
            kind: "failed",
            code: "session_stream:session_stream_replay_timeout",
          },
        },
      ],
    },
  });
}

async function acceptsDirectCueCase(): Promise<void> {
  const caseActor = actor(CaseDO);
  const session = fakeSession();
  const input = directCueInput(caseActor, session.value);
  const first = await runDirectCasePath(input);
  expect(first.ok && first.value).toMatchObject({
    kind: "completed",
    caseRevision: 2,
    assignment: { role: "coordinator", caseId: "case_plan15_cue" },
    completion: { finalMessage: "Catalog is ready." },
  });
  const snapshot = await caseActor.inspect();
  expect(snapshot.ok && snapshot.value).toMatchObject({
    bindings: [],
    outputs: [],
    entries: [
      { entryId: "trigger:trigger_plan15_cue" },
      { entryId: "entry_assignment_plan15_cue" },
    ],
    acceptedProposalIds: ["proposal_assignment_plan15_cue"],
    assignmentLifecycles: [
      { kind: "settled", disposition: { kind: "completed" } },
    ],
  });
  expect(await runDirectCasePath(input)).toEqual({
    ok: true,
    value: { kind: "duplicate_trigger", caseId: "case_plan15_cue" },
  });
  expect(session.initializations).toBe(1);
  expect(session.turns).toBe(1);
}

async function settlesOngoingBudgetExhaustion(): Promise<void> {
  const caseActor = actor(CaseDO);
  const session = exhaustedSession();
  const result = await runOngoingCaseTurn(
    walkingInput(recordingConnector(), caseActor, session),
  );
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      kind: "budget_exhausted",
      code: "session_turn:budget_exhausted",
      exhaustion: expect.objectContaining({ dimension: "active_wall_ms" }),
      budget: expect.objectContaining({ maxWallMs: 60_000 }),
    }),
  });
  expect(await caseActor.inspect()).toMatchObject({
    ok: true,
    value: {
      assignmentLifecycles: [
        {
          kind: "settled",
          disposition: {
            kind: "budget_exhausted",
            dimension: "active_wall_ms",
          },
        },
      ],
    },
  });
}

async function preservesOngoingBudgetExhaustion(): Promise<void> {
  const caseActor = actor(CaseDO);
  const session = exhaustedSession();
  const baseConnector = recordingConnector();
  const connector: OngoingCaseWalkingConnector = {
    ...baseConnector,
    async streamCaseTurn() {
      return {
        ok: false,
        error: { kind: "operational", code: "budget_exhausted" },
      };
    },
  };
  const recipientUserId = parseSlackUserId("U0BUDGETFAIL", "recipientUserId");
  if (!recipientUserId.ok) throw new Error(recipientUserId.error.code);

  const result = await runOngoingCaseTurn({
    ...walkingInput(connector, caseActor, session),
    output: { kind: "slack_stream", recipientUserId: recipientUserId.value },
  });

  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      kind: "budget_exhausted",
      code: "session_turn:budget_exhausted",
      exhaustion: expect.objectContaining({ dimension: "active_wall_ms" }),
      budget: expect.objectContaining({ maxWallMs: 60_000 }),
    }),
  });
  expect(await caseActor.inspect()).toMatchObject({
    ok: true,
    value: {
      assignmentLifecycles: [
        {
          kind: "settled",
          disposition: {
            kind: "budget_exhausted",
            dimension: "active_wall_ms",
          },
        },
      ],
    },
  });
}

async function settlesOngoingSessionStreamFailure(): Promise<void> {
  const caseActor = actor(CaseDO);
  const controlled = controlledSession(
    "The model must not finish after replay failure.",
  );
  const session: OngoingCaseWalkingSession = {
    ...controlled.value,
    inspectTurnStream: missingTurnStream,
  };
  const baseConnector = recordingConnector();
  const connector: OngoingCaseWalkingConnector = {
    ...baseConnector,
    async streamCaseTurn() {
      return {
        ok: false,
        error: { kind: "operational", code: "session_stream_replay_timeout" },
      };
    },
  };
  const recipientUserId = parseSlackUserId("U0STREAMFAIL", "recipientUserId");
  if (!recipientUserId.ok) throw new Error(recipientUserId.error.code);

  const result = await runOngoingCaseTurn({
    ...walkingInput(connector, caseActor, session),
    output: { kind: "slack_stream", recipientUserId: recipientUserId.value },
  });

  expect(result).toEqual({
    ok: false,
    error: {
      kind: "operational",
      code: "session_stream:session_stream_replay_timeout",
    },
  });
  controlled.fail(new Error("late model rejection"));
  await Promise.resolve();
  await Promise.resolve();
  expect(await caseActor.inspect()).toMatchObject({
    ok: true,
    value: {
      outputs: [],
      assignmentLifecycles: [
        {
          kind: "settled",
          disposition: {
            kind: "failed",
            code: "session_stream:session_stream_replay_timeout",
          },
        },
      ],
    },
  });
}

async function acceptsCommerceProposal(): Promise<void> {
  const caseActor = actor(CaseDO);
  await caseActor.ensure({
    identity: {
      organisationId: "organisation_plan15",
      caseId: "case_plan15_commerce",
    },
    purpose: "Merchant commerce action",
    workspaceRevision: "commerce:integration_lab",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  const proposal = {
    proposalId: "proposal_plan15_publish",
    caseId: "case_plan15_commerce",
    basedOnRevision: 0,
    requestAuthority: PLAN15_REQUEST_AUTHORITY,
    action: {
      kind: "publish_catalog_listing",
      productId: "product_field_watch",
      productRevision: 2,
      variantId: "variant_field_watch_black",
      variantRevision: 2,
      offerId: "offer_variant_field_watch_black_lab_online",
      offerRevision: 2,
      salesChannelId: "sales_channel_lab_online",
      salesChannelRevision: 2,
    },
    authority: { kind: "lab" },
    provenance: {
      organisationId: "organisation_plan15",
      integrationAccountId: "integration_lab",
      source: "lab",
      resourceType: "offer",
      resourceId: "offer_variant_field_watch_black_lab_online",
      revision: 2,
      occurredAt: "2026-08-04T00:00:00.000Z",
      observedAt: "2026-08-04T00:00:00.000Z",
    },
    origin: {
      kind: "merchant_control",
      userId: "user_f7df3be4-23b5-579a-8d2b-d31b348f5fb0",
      controlSessionId: "control_session_plan15",
    },
  };
  const authorityPartition = await merchantInputAuthorityPartition(
    proposal.requestAuthority,
  );
  expect(
    await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_plan15", {
        proposal,
        acceptedAt: 1_001,
        authorityPartition,
      }),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "accepted", revision: 1 },
  });
  expect(
    await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_plan15", {
        proposal,
        acceptedAt: 1_002,
        authorityPartition,
      }),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "already_accepted", revision: 1, acceptedAt: 1_001 },
  });
  expect(
    await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_plan15", {
        proposal: {
          ...proposal,
          proposalId: "proposal_plan15_wrong_authority",
          authority: {
            kind: "commerce_system",
            system: "shopify",
            revision: 1,
            integrationAccountId: "integration_lab",
          },
        },
        acceptedAt: 1_002,
        authorityPartition,
      }),
    ),
  ).toEqual({ ok: false, error: { code: "case_commerce_proposal_invalid" } });
  expect(
    await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_plan15", {
        proposal: { ...proposal, basedOnRevision: 1 },
        acceptedAt: 1_003,
        authorityPartition,
      }),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "already_accepted", revision: 1, acceptedAt: 1_001 },
  });
  const stale = await caseActor.acceptCommerceProposal(
    withCaseMutationExecution("organisation_plan15", {
      proposal: {
        ...proposal,
        proposalId: "proposal_plan15_stale",
        basedOnRevision: 0,
      },
      acceptedAt: 1_004,
      authorityPartition,
    }),
  );
  expect(stale).toEqual({
    ok: false,
    error: { code: "case_commerce_proposal_rebase_required" },
  });
  const beforeAgent = await caseActor.inspect();
  if (!beforeAgent.ok) throw new Error(beforeAgent.error.code);
  const agentAssignment = assignmentFixture(
    "coordinator",
    beforeAgent.value,
    "case_plan15_commerce",
  );
  expect(await caseActor.assignSession(agentAssignment)).toMatchObject({
    ok: true,
  });
  expect(
    await caseActor.beginAssignment(beginFixture(agentAssignment)),
  ).toMatchObject({ ok: true });
  const agentProposalRequest = {
    proposal: {
      ...proposal,
      proposalId: "proposal_plan15_agent_publish",
      basedOnRevision: 1,
      requestAuthority: PLAN15_ASSIGNMENT_REQUEST_AUTHORITY,
      origin: {
        kind: "agent_session",
        sessionId: agentAssignment.sessionId,
        assignmentId: agentAssignment.assignmentId,
        threadId: "case_plan15_commerce",
      },
    },
    acceptedAt: 1_005,
    flowBinding: await fixtureSerializedFlowBinding({
      sessionId: agentAssignment.sessionId,
      turnId: `turn_${agentAssignment.assignmentId}`,
      authorityPartitionDigest: agentAssignment.authorityPartition.digest,
    }),
  };
  const agentProposal = await caseActor.acceptCommerceProposal(
    withCaseMutationExecution("organisation_plan15", agentProposalRequest),
  );
  expect(agentProposal).toMatchObject({
    ok: true,
    value: { kind: "accepted", revision: 2 },
  });
  expect(
    await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_plan15", {
        ...agentProposalRequest,
        flowBinding: await fixtureSerializedFlowBinding({
          sessionId: "session_plan15_conflicting_binding",
          turnId: `turn_${agentAssignment.assignmentId}`,
          authorityPartitionDigest: agentAssignment.authorityPartition.digest,
        }),
      }),
    ),
  ).toEqual({
    ok: false,
    error: { code: "case_commerce_proposal_conflict" },
  });
  const snapshot = await caseActor.inspect();
  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      revision: 2,
      acceptedCommerceProposalIds: [
        "proposal_plan15_agent_publish",
        "proposal_plan15_publish",
      ],
      entries: [
        { entryId: "commerce_proposal:proposal_plan15_publish" },
        { entryId: "commerce_proposal:proposal_plan15_agent_publish" },
      ],
    },
  });
}

async function acceptsCommerceOutcome(): Promise<void> {
  const fixture = actorFixture(CaseDO);
  let caseActor = fixture.actor;
  const caseId = "case_plan15_outcome";
  const proposalId = "proposal_plan15_outcome";
  const actionNonce = "nonce_plan15_outcome";
  await caseActor.ensure({
    identity: { organisationId: "organisation_plan15", caseId },
    purpose: "Merchant commerce action outcome",
    workspaceRevision: "commerce:integration_lab",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  const proposal = {
    proposalId,
    caseId,
    basedOnRevision: 0,
    requestAuthority: PLAN15_REQUEST_AUTHORITY,
    action: {
      kind: "publish_catalog_listing" as const,
      productId: "product_outcome",
      productRevision: 1,
      variantId: "variant_outcome",
      variantRevision: 1,
      offerId: "offer_outcome",
      offerRevision: 1,
      salesChannelId: "sales_channel_outcome",
      salesChannelRevision: 1,
    },
    authority: { kind: "lab" },
    provenance: {
      organisationId: "organisation_plan15",
      integrationAccountId: "integration_lab",
      source: "lab",
      resourceType: "offer",
      resourceId: "offer_outcome",
      revision: 1,
      occurredAt: "2026-08-04T00:00:00.000Z",
      observedAt: "2026-08-04T00:00:00.000Z",
    },
    origin: {
      kind: "merchant_control" as const,
      userId: "user_f7df3be4-23b5-579a-8d2b-d31b348f5fb0",
      controlSessionId: "control_session_plan15",
    },
  };
  const proposalAcceptance = await caseActor.acceptCommerceProposal(
    withCaseMutationExecution("organisation_plan15", {
      proposal,
      acceptedAt: 1_001,
      authorityPartition: await merchantInputAuthorityPartition(
        proposal.requestAuthority,
      ),
    }),
  );
  if (!proposalAcceptance.ok) throw new Error(proposalAcceptance.error.code);
  await caseActor.attachBinding({
    bindingId: "binding_plan15_outcome",
    caseId,
    connectorId: "connector_slack_plan15",
    address: {
      kind: "slack",
      workspaceId: "T_plan15",
      channelId: "conversation_fixture",
      threadTs: "1785700000.000010",
    },
  });
  const outcome = {
    kind: "commerce_provider_receipt" as const,
    provider: "lab" as const,
    receiptId: "receipt_plan15_outcome",
    effectId: "effect_plan15_outcome",
    actionNonce,
    eventId: "event_plan15_outcome",
    resourceId: "offer_outcome",
    projectionKind: "offer" as const,
    revision: 1,
    status: "settled" as const,
    flowBindingDigest: await digestCanonical(
      proposalAcceptance.value.flowBinding,
    ),
    decisionDigest: "d".repeat(64),
    observedAt: "2026-08-04T00:00:01.000Z",
  };
  const accepted = await caseActor.acceptCommerceOutcome({
    caseId,
    proposalId,
    actionNonce,
    outcome: { kind: "provider_receipt", receipt: outcome },
    content: {
      kind: "text",
      text: "Commerce action publish_catalog_listing settled.",
    },
    acceptedAt: 1_002,
  });
  expect(accepted).toMatchObject({
    ok: true,
    value: {
      kind: "accepted",
      revision: 2,
      output: {
        kind: "pending",
        output: { delivery: { address: { threadTs: "1785700000.000010" } } },
      },
    },
  });
  if (!accepted.ok || accepted.value.output?.kind !== "pending") {
    throw new Error("commerce outcome flow binding missing");
  }
  expect(accepted.value.output.output.source).toEqual({
    kind: "commerce_outcome",
    proposalId,
    actionNonce,
  });
  caseActor = fixture.restart();
  const snapshot = await caseActor.inspect();
  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      revision: 2,
      entries: [
        { entryId: "commerce_proposal:proposal_plan15_outcome" },
        { entryId: "commerce_outcome:nonce_plan15_outcome" },
      ],
      outputs: [
        {
          kind: "pending",
          output: { outputId: "output_commerce_nonce_plan15_outcome" },
        },
      ],
    },
  });
  const receipt = {
    deliveryId: "delivery_commerce_nonce_plan15_outcome",
    connectorId: "connector_slack_plan15",
    idempotencyKey: "case_commerce_outcome_nonce_plan15_outcome",
    nativeReceiptId: "slack_ts_plan15_outcome",
    deliveredAt: 1_003,
    flowBindingDigest: await digestCanonical(
      accepted.value.output.output.flowBinding,
    ),
    decisionDigest: "d".repeat(64),
  };
  expect(
    await caseActor.acceptDeliveryReceipt({
      outputId: "output_commerce_nonce_plan15_outcome",
      receipt,
    }),
  ).toMatchObject({
    ok: true,
    value: { kind: "settled" },
  });
  expect(
    await caseActor.acceptCommerceOutcome({
      caseId,
      proposalId,
      actionNonce,
      outcome: { kind: "provider_receipt", receipt: outcome },
      content: {
        kind: "text",
        text: "Commerce action publish_catalog_listing settled.",
      },
      acceptedAt: 1_004,
    }),
  ).toMatchObject({
    ok: true,
    value: { kind: "already_accepted", output: { kind: "settled" } },
  });
}

async function acceptsDirectKonbiniCase(): Promise<void> {
  const caseActor = actor(CaseDO);
  const coordinator = controlledSession(
    "Coordinate an immediate transfer and replenish 20 units.",
  );
  const specialist = controlledSession(
    "Transfer 8 units now and assess the remaining replenishment gap.",
  );
  const running = runDirectTwoSessionCasePath(
    directKonbiniInput(caseActor, coordinator.value, specialist.value),
  );
  await Promise.all([coordinator.started, specialist.started]);
  expect(
    await runDirectTwoSessionCasePath(
      directKonbiniInput(caseActor, coordinator.value, specialist.value),
    ),
  ).toEqual({
    ok: false,
    error: { kind: "operational", code: "case_assignment_in_progress" },
  });
  specialist.complete();
  await Promise.resolve();
  coordinator.complete();
  const result = await running;
  expect(result.ok && result.value).toMatchObject({
    kind: "completed",
    finalCaseRevision: 3,
    participants: [
      { assignment: { role: "coordinator", caseRevision: 1 } },
      { assignment: { role: "specialist", caseRevision: 1 } },
    ],
  });
  const snapshot = await caseActor.inspect();
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) {
    throw new Error(snapshot.error.code);
  }
  expect(snapshot.value).toMatchObject({
    bindings: [],
    outputs: [],
    assignmentLifecycles: [
      {
        kind: "settled",
        assignment: { role: "coordinator" },
        disposition: { kind: "completed" },
      },
      {
        kind: "settled",
        assignment: { role: "specialist" },
        disposition: { kind: "completed" },
      },
    ],
  });
  expect(snapshot.value.entries.map((entry) => entry.entryId)).toEqual(
    expect.arrayContaining([
      "trigger:trigger_plan15_konbini",
      "entry_assignment_plan15_inventory_specialist",
      "entry_assignment_plan15_replenishment",
    ]),
  );
}

async function addressesDirectKonbiniCase(): Promise<void> {
  const caseActor = actor(CaseDO);
  const connector = recordingConnector();
  const coordinator = controlledSession(
    "Coordinate an immediate transfer and replenish 20 units.",
  );
  const specialist = controlledSession(
    "Transfer 8 units now and assess the remaining replenishment gap.",
  );
  const base = directKonbiniInput(
    caseActor,
    coordinator.value,
    specialist.value,
  );
  const input = {
    ...base,
    delivery: {
      kind: "connector" as const,
      connector,
      connectorIdentity: {
        organisationId: base.organisationId,
        connectorId: "connector_slack_plan15_cue",
      },
      binding: {
        bindingId: "binding_case_plan15_konbini",
        caseId: base.caseId,
        connectorId: "connector_slack_plan15_cue",
        address: {
          kind: "slack_channel" as const,
          workspaceId: "T_plan15",
          channelId: "conversation_fixture",
        },
      },
    },
  };
  const running = runDirectTwoSessionCasePath(input);
  await Promise.all([coordinator.started, specialist.started]);
  coordinator.complete();
  specialist.complete();
  const result = await running;
  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: "completed",
      participants: [
        { delivery: { kind: "delivered" } },
        { delivery: { kind: "delivered" } },
      ],
    },
  });
  const snapshot = await caseActor.inspect();
  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      bindings: [
        {
          address: {
            kind: "slack_channel",
            workspaceId: "T_plan15",
            channelId: "conversation_fixture",
          },
        },
      ],
      outputs: [
        {
          kind: "settled",
          output: { delivery: { address: { kind: "slack_channel" } } },
        },
        {
          kind: "settled",
          output: { delivery: { address: { kind: "slack_channel" } } },
        },
      ],
    },
  });
  expect(connector.inspect().deliveryCount).toBe(2);
  expect(await runDirectTwoSessionCasePath(input)).toEqual({
    ok: true,
    value: { kind: "duplicate_trigger", caseId: "case_plan15_konbini" },
  });
  expect(connector.inspect().deliveryCount).toBe(2);
}

async function settlesDurableCaseOutput(): Promise<void> {
  const fixture = actorFixture(CaseDO);
  let caseActor = fixture.actor;
  const connector = recordingConnector();
  const session = fakeSession();
  const result = await runOngoingCaseTurn(
    walkingInput(connector, caseActor, ongoingSession(session.value)),
  );
  if (!result.ok || result.value.kind !== "completed")
    throw new Error("ongoing Case turn failed");
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const output = snapshot.value.outputs[0];
  if (output === undefined || output.kind !== "settled")
    throw new Error("Case output did not settle");
  expect(output.output.source).toEqual({
    kind: "agent_turn",
    assignmentId: result.value.proposal.assignmentId,
    sessionId: result.value.proposal.sessionId,
    turnId: result.value.proposal.turnId,
    proposalId: result.value.proposal.proposalId,
  });
  caseActor = fixture.restart();
  const recovered = await caseActor.inspect();
  expect(recovered).toEqual(snapshot);
  caseActor = fixture.restart();
  const replay = await caseActor.acceptDeliveryReceipt({
    outputId: output.output.outputId,
    receipt: output.receipt,
  });
  expect(replay).toMatchObject({
    ok: true,
    value: { kind: "already_settled" },
  });
  const proposalReplay = await caseActor.acceptSessionProposal({
    proposal: result.value.proposal,
    requestAuthority: PLAN15_SLACK_REQUEST_AUTHORITY,
    acceptedAt: 1_002,
    flowBinding: await fixtureSerializedFlowBinding({
      sessionId: result.value.assignment.sessionId,
      turnId: slackCaseTurnId("ingress_plan15_1"),
      authorityPartitionDigest:
        result.value.assignment.authorityPartition.digest,
    }),
  });
  expect(proposalReplay).toMatchObject({
    ok: true,
    value: {
      disposition: { kind: "accepted", revision: 2 },
      outputs: [{ outputId: output.output.outputId }],
    },
  });
  const afterReplay = await caseActor.inspect();
  if (!afterReplay.ok) throw new Error(afterReplay.error.code);
  expect(afterReplay.value).toMatchObject({
    revision: 2,
    acceptedProposalIds: ["proposal_ingress_plan15_1"],
    outputs: [{ kind: "settled" }],
  });
}

async function rejectsPartitionChangedOutput(): Promise<void> {
  const caseActor = actor(CaseDO);
  const connector = recordingConnector();
  const session = fakeSession();
  const result = await runOngoingCaseTurn(
    walkingInput(connector, caseActor, ongoingSession(session.value)),
  );
  if (!result.ok || result.value.kind !== "completed")
    throw new Error("ongoing Case turn failed");
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const output = snapshot.value.outputs[0];
  if (output === undefined) throw new Error("Case output missing");
  const narrowedOrganisationId = parseOrganisationId(
    "organisation_plan15_narrowed",
  );
  if (!narrowedOrganisationId.ok)
    throw new Error(narrowedOrganisationId.error.code);
  const decision = await authorizeCaseConversationOutput(
    fixtureTurnAuthority(
      narrowedOrganisationId.value,
      "connector_slack_plan15",
    ),
    output.output,
    platformEnv({}),
  );
  expect(decision).toEqual({
    ok: false,
    error: {
      kind: "operational",
      code: "case_flow_authority_partition_changed",
    },
  });
}

async function rebasesAndCancelsIndependently(): Promise<void> {
  const fixture = actorFixture(CaseDO);
  const caseActor = fixture.actor;
  await caseActor.ensure({
    identity: {
      organisationId: "organisation_plan15",
      caseId: "case_plan15_rebase",
    },
    purpose: "Prove independent mutable work.",
    workspaceRevision: "workspace_revision_plan15_1",
    lifecycle: { kind: "open", openedAt: 1_000 },
  });
  await caseActor.acceptTrigger({
    triggerId: "trigger_plan15_rebase",
    caseId: "case_plan15_rebase",
    source: {
      kind: "connector",
      connectorId: "connector_plan15",
      ingressId: "ingress_plan15_rebase",
    },
    requestAuthority: PLAN15_TRIGGER_AUTHORITY,
    content: { kind: "text", text: "Update the shared catalog plan." },
    acceptedAt: 1_000,
  });
  await caseActor.attachBinding({
    bindingId: "binding_plan15_rebase",
    caseId: "case_plan15_rebase",
    connectorId: "connector_plan15",
    address: {
      kind: "slack",
      workspaceId: "T_plan15",
      channelId: "conversation_fixture",
      threadTs: "1785700000.000004",
    },
  });
  const snapshot = await caseActor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const coordinator = assignmentFixture("coordinator", snapshot.value);
  const specialist = assignmentFixture("specialist", snapshot.value);
  await caseActor.assignSession(coordinator);
  await caseActor.assignSession(specialist);
  await caseActor.beginAssignment(beginFixture(coordinator));
  await caseActor.beginAssignment(beginFixture(specialist));
  const accepted = await caseActor.acceptSessionProposal({
    proposal: sharedChangeProposal(coordinator),
    requestAuthority: PLAN15_ASSIGNMENT_REQUEST_AUTHORITY,
    acceptedAt: 1_001,
    flowBinding: await assignmentFlowBinding(coordinator),
  });
  expect(accepted).toMatchObject({
    ok: true,
    value: { disposition: { kind: "accepted", revision: 2 } },
  });
  const atomic = await caseActor.inspect();
  expect(atomic).toMatchObject({
    ok: true,
    value: {
      revision: 2,
      entries: [
        { entryId: "trigger:trigger_plan15_rebase" },
        { entryId: `entry_${coordinator.assignmentId}` },
      ],
      outputs: [
        {
          kind: "pending",
          output: {
            delivery: {
              address: {
                kind: "slack",
                workspaceId: "T_plan15",
                channelId: "conversation_fixture",
                threadTs: "1785700000.000004",
              },
            },
          },
        },
      ],
    },
  });
  const stale = await caseActor.acceptSessionProposal({
    proposal: sharedChangeProposal(specialist),
    requestAuthority: PLAN15_ASSIGNMENT_REQUEST_AUTHORITY,
    acceptedAt: 1_002,
    flowBinding: await assignmentFlowBinding(specialist),
  });
  expect(stale).toEqual({
    ok: true,
    value: {
      disposition: { kind: "rebase_required", revision: 2 },
      outputs: [],
    },
  });
  await caseActor.settleAssignment({
    caseId: specialist.caseId,
    assignmentId: specialist.assignmentId,
    sessionId: specialist.sessionId,
    expectedCaseRevision: specialist.caseRevision,
    expectedStartId: `start_turn_${specialist.assignmentId}`,
    disposition: {
      kind: "cancelled",
      commandId: "cancel_specialist",
      settledAt: 1_003,
    },
  });
  const restored = await fixture.restart().inspect();
  expect(restored.ok && restored.value).toMatchObject({
    revision: 2,
    assignmentLifecycles: [
      {
        kind: "running",
        assignment: { assignmentId: coordinator.assignmentId },
      },
      {
        kind: "settled",
        assignment: { assignmentId: specialist.assignmentId },
        disposition: { kind: "cancelled" },
      },
    ],
  });
}

async function retainsRecordMessage(): Promise<void> {
  const fixture = actorFixture(CaseDO);
  const input = walkingInput(
    recordingConnector(),
    fixture.actor,
    fakeSession().value,
  );
  const message = userMessageContentFixture(
    "What is its status?",
    [storedAttachmentFixture()],
    ["https://shop.test/orders/1"],
  );
  if (message.kind !== "user_message")
    throw new Error("expected message fixture");
  const content = parseMessageCaseContent({
    kind: "record_message",
    message: message.message,
    provenance: {
      organisationId: "organisation_plan15",
      integrationAccountId: "integration_lab",
      source: "lab",
      resourceType: "commerce_order",
      resourceId: "order_plan15",
      revision: 1,
      occurredAt: "2026-08-04T00:00:00.000Z",
      observedAt: "2026-08-04T00:00:00.000Z",
    },
  });
  if (content?.kind !== "record_message")
    throw new Error("expected valid record message");
  expect(caseContentAttachments(content)).toEqual([storedAttachmentFixture()]);
  expect(caseContentInstruction(content, "fallback")).toBe(
    "What is its status?\n[link] https://shop.test/orders/1",
  );
  expect(
    parseMessageCaseContent({
      kind: "record_message",
      message: message.message,
    }),
  ).toBeNull();
  expect(
    parseMessageCaseContent({
      kind: "record_message",
      provenance: content.provenance,
    }),
  ).toBeNull();
  const trigger = {
    triggerId: `trigger_${input.ingress.ingressId}`,
    caseId: input.ingress.caseId,
    source: {
      kind: "connector",
      connectorId: input.ingress.connectorId,
      ingressId: input.ingress.ingressId,
    },
    requestAuthority: input.turnAuthority.requestAuthority,
    content,
    acceptedAt: input.receivedAt,
    attachments: caseContentAttachments(content),
  };
  const prepared = await fixture.actor.prepareOngoingTurn({
    ensure: {
      identity: {
        organisationId: input.organisationId,
        caseId: input.ingress.caseId,
      },
      purpose: input.purpose,
      workspaceRevision: input.workspaceRevisionReceipt.revision,
      lifecycle: { kind: "open", openedAt: input.receivedAt },
    },
    trigger,
    binding: input.binding,
  });
  expect(prepared.ok).toBe(true);
  const restarted = fixture.restart();
  expect(await restarted.acceptTrigger(trigger)).toMatchObject({
    ok: true,
    value: { kind: "duplicate" },
  });
  expect(
    await restarted.acceptTrigger({
      ...trigger,
      content: {
        ...content,
        provenance: { ...content.provenance, revision: 2 },
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "case_trigger_conflict" } });
  expect(
    await restarted.acceptTrigger({
      ...trigger,
      triggerId: "foreign_record",
      content: {
        ...content,
        provenance: {
          ...content.provenance,
          organisationId: "organisation_foreign",
        },
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "case_trigger_invalid" } });
}

function walkingInput<T extends CaseWalkingSession>(
  connector: OngoingCaseWalkingConnector,
  caseActor: CaseDO,
  session: T,
) {
  const organisationId = requiredOrganisationId();
  const sessionId = requiredSessionId();
  return {
    env: platformEnv({}),
    attempt: 1,
    projectContext: null,
    ...fixtureCaseTurnContext({
      organisationId,
      caseId: "case_plan15_1",
      assignmentId: "assignment_plan15_1",
      sessionId,
      connectorId: "connector_slack_plan15",
    }),
    connector,
    caseActor,
    session,
    organisationId,
    requestId: requiredRequestId(),
    sessionId,
    sessionRoute: testSessionRoute(organisationId, sessionId),
    connectorIdentity: {
      organisationId: "organisation_plan15",
      connectorId: "connector_slack_plan15",
    },
    ingress: {
      ingressId: "ingress_plan15_1",
      connectorId: "connector_slack_plan15",
      nativeEventId: "Ev_plan15_1",
      nativeCursor: "1785700000.000001",
      caseId: "case_plan15_1",
      // The attachment travels inside the canonical message, not beside it.
      content: userMessageContentFixture("Summarize the catalog status.", [
        storedAttachmentFixture(),
      ]),
      receivedAt: 1_000,
    },
    binding: {
      bindingId: "binding_plan15_1",
      caseId: "case_plan15_1",
      connectorId: "connector_slack_plan15",
      address: {
        kind: "slack" as const,
        workspaceId: "T_plan15",
        channelId: "conversation_fixture",
        threadTs: "1785700000.000001",
      },
    },
    assignmentId: "assignment_plan15_1",
    purpose: "Resolve the catalog question.",
    principalId: "person_plan15",
    policy: {
      version: 1,
      egress: {
        allowedHosts: [],
        injections: [],
        modelRoute: { baseUrl: "https://model-gateway.test" },
      },
      authz: {
        allowedTools: [],
        deniedTools: [],
        approvalRequired: [],
        maxBudget: { maxTokens: 10_000, maxWallMs: 60_000, maxToolCalls: 20 },
      },
      conversationRisk: { outputScreeningMode: "stream" as const },
      modelRoute: {
        keySource: "organisation_subscription" as const,
        provider: "openai" as const,
        model: "gpt-5.6-luna",
        connectionRevision: 1,
        authProfileGeneration: 1,
      },
    },
    pinnedAgent: null,
    workspaceRevisionReceipt: {
      receiptId: "workspace_receipt_plan15",
      outcome: "accepted" as const,
      workspaceId: "workspace_plan15",
      revision: "workspace_revision_plan15_1",
      canonicalHead: "a".repeat(64),
      correlationId: "request_plan15",
      causation: { kind: "command" as const, commandId: "workspace_plan15" },
    },
    receivedAt: 1_000,
    output: { kind: "terminal" as const },
  };
}

/**
 * A committed attachment as the acquisition adapter would produce it.
 *
 * Branded values are minted by Lexicon at the real boundary; a fixture asserts
 * the shape once rather than laundering each field separately.
 */
function storedAttachmentFixture(): StoredMessageAttachment {
  return {
    id: `att_${"a".repeat(32)}`,
    displayName: "catalog.png",
    extensionHint: { kind: "named", value: "png" },
    descriptor: {
      kind: "image",
      media: {
        kind: "signature_verified",
        mediaType: "image/png",
        method: "magic_bytes",
      },
    },
    byteLength: 4,
    sha256: "a".repeat(64),
    objectKey: `attachments/organisation_plan15/slack/${"a".repeat(64)}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_plan15",
      workspaceId: "T_plan15",
      channelId: "C_plan15",
      messageTs: "1000.000100",
      fileId: "F_plan15_image",
      revision: "1",
    },
    retention: "session",
    storedAt: 1_000,
  } as StoredMessageAttachment;
}

/** A canonical message as the Slack boundary would have admitted it. */
function userMessageContentFixture(
  text: string,
  attachments: readonly StoredMessageAttachment[],
  links: readonly string[] = [],
): CaseContent {
  return {
    kind: "user_message",
    message: {
      firstPart: { kind: "text", text },
      remainingParts: [
        ...links.map(function linkPart(url) {
          return { kind: "link", link: { url, presentation: { kind: "url" } } };
        }),
        ...attachments.map(function attachmentPart(attachment) {
          return { kind: "attachment", attachment };
        }),
      ],
    },
  } as CaseContent;
}

function directCueInput(caseActor: CaseDO, session: CaseWalkingSession) {
  const single = walkingInput(recordingConnector(), caseActor, session);
  return {
    env: single.env,
    projectContext: null,
    ...fixtureCaseTurnContext({
      organisationId: single.organisationId,
      caseId: "case_plan15_cue",
      assignmentId: "assignment_plan15_cue",
      sessionId: requiredSessionId("session_plan15_cue"),
      connectorId: "connector_fixture",
    }),
    caseActor,
    session,
    organisationId: single.organisationId,
    requestId: requiredRequestId("request_plan15_cue"),
    sessionId: requiredSessionId("session_plan15_cue"),
    caseId: "case_plan15_cue",
    triggerId: "trigger_plan15_cue",
    triggerSource: { kind: "cue" as const, eventId: "event_plan15_cue" },
    content: {
      kind: "text" as const,
      text: "Investigate low inventory without sending a message.",
    },
    assignmentId: "assignment_plan15_cue",
    purpose: "Investigate the low-inventory event.",
    principal: { kind: "system" as const, componentId: "cue_engine" },
    policy: single.policy,
    pinnedAgent: null,
    workspaceRevisionReceipt: single.workspaceRevisionReceipt,
    receivedAt: single.receivedAt,
    role: "coordinator" as const,
    objective: "Propose a replenishment response without external effects.",
    delivery: { kind: "none" as const },
    browserContext: { kind: "unavailable" as const },
    surfaceContext: null,
  };
}

function directKonbiniInput(
  caseActor: CaseDO,
  coordinator: CaseWalkingSession,
  specialist: CaseWalkingSession,
) {
  const single = directCueInput(caseActor, coordinator);
  return {
    env: single.env,
    ...fixtureDirectTwoSessionContext({
      organisationId: single.organisationId,
      caseId: "case_plan15_konbini",
      connectorId: "connector_fixture",
      participants: [
        {
          assignmentId: "assignment_plan15_replenishment",
          sessionId: requiredSessionId("session_plan15_replenishment"),
        },
        {
          assignmentId: "assignment_plan15_inventory_specialist",
          sessionId: requiredSessionId("session_plan15_inventory_specialist"),
        },
      ],
    }),
    caseActor,
    organisationId: single.organisationId,
    caseId: "case_plan15_konbini",
    triggerId: "trigger_plan15_konbini",
    triggerSource: { kind: "cue" as const, eventId: "event_plan15_konbini" },
    content: {
      kind: "text" as const,
      text: "Inventory is below the order requirement.",
    },
    purpose: "Coordinate replenishment for the low-inventory Case.",
    principal: single.principal,
    policy: single.policy,
    pinnedAgent: null,
    workspaceRevisionReceipt: single.workspaceRevisionReceipt,
    receivedAt: single.receivedAt,
    participants: [
      {
        session: coordinator,
        requestId: requiredRequestId("request_plan15_replenishment"),
        sessionId: requiredSessionId("session_plan15_replenishment"),
        assignmentId: "assignment_plan15_replenishment",
        role: "coordinator" as const,
        objective:
          "Coordinate the replenishment response without external effects.",
      },
      {
        session: specialist,
        requestId: requiredRequestId("request_plan15_inventory_specialist"),
        sessionId: requiredSessionId("session_plan15_inventory_specialist"),
        assignmentId: "assignment_plan15_inventory_specialist",
        role: "specialist" as const,
        objective:
          "Assess replenishment and transfer options without external effects.",
      },
    ] as const,
    delivery: { kind: "none" as const },
  };
}

function fakeSession(): {
  readonly value: CaseWalkingSession;
  readonly initializations: number;
  readonly turns: number;
} {
  const state: {
    initializations: number;
    turns: number;
    sessionId: string | null;
  } = {
    initializations: 0,
    turns: 0,
    sessionId: null,
  };
  return {
    value: {
      async initializeCaseSession(input) {
        state.initializations += 1;
        state.sessionId = input.assignment.sessionId;
        return {
          ok: true,
          value: { kind: "accepted", eventId: "initialized", sequence: 0 },
        };
      },
      async prepareSessionInformationFlow(input) {
        return {
          ok: true,
          value: { flowBinding: await fixtureSerializedFlowBinding(input) },
        };
      },
      async startCanonicalEmbeddedHarnessTextTurn(input) {
        state.turns += 1;
        if (state.sessionId === null)
          throw new Error("session was not initialized");
        return {
          ok: true,
          value: {
            outcome: { status: "success", summary: null, artifacts: [] },
            finalMessage: "Catalog is ready.",
            flowBinding: await fixtureSerializedFlowBinding({
              sessionId: state.sessionId,
              turnId: input.start.turnId,
              authorityPartitionDigest: input.start.authorityPartitionDigest,
            }),
          },
        };
      },
    },
    get initializations() {
      return state.initializations;
    },
    get turns() {
      return state.turns;
    },
  };
}

function exhaustedSession(): OngoingCaseWalkingSession {
  return {
    inspectTurnStream: missingTurnStream,
    async initializeCaseSession() {
      return {
        ok: true,
        value: { kind: "accepted", eventId: "initialized", sequence: 0 },
      };
    },
    async prepareSessionInformationFlow(input) {
      return {
        ok: true,
        value: { flowBinding: await fixtureSerializedFlowBinding(input) },
      };
    },
    async startCanonicalEmbeddedHarnessTextTurn() {
      return {
        ok: false,
        error: {
          code: "budget_exhausted",
          exhaustion: {
            exhaustionId: "exhaustion_plan15_ongoing",
            dimension: "active_wall_ms",
            runId: "run_plan15_ongoing",
            observedUsage: {
              tokens: 1,
              activeWallMs: 60_001,
              capabilityCalls: 0,
            },
            exhaustedAt: 61_001,
          },
        },
      };
    },
  };
}

async function missingTurnStream(): Promise<{
  readonly ok: true;
  readonly value: { readonly kind: "missing" };
}> {
  return { ok: true, value: { kind: "missing" } };
}

function ongoingSession(
  session: CaseWalkingSession,
): OngoingCaseWalkingSession {
  return {
    ...session,
    inspectTurnStream: missingTurnStream,
  };
}

function controlledSession(message: string): {
  readonly value: CaseWalkingSession;
  readonly started: Promise<void>;
  complete(): void;
  fail(error: unknown): void;
} {
  let completeTurn:
    ((value: { readonly finalMessage: string }) => void) | null = null;
  let rejectTurn: ((reason?: unknown) => void) | null = null;
  let markStarted: (() => void) | null = null;
  let sessionId: string | null = null;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const completion = new Promise<{ readonly finalMessage: string }>(
    (resolve, reject) => {
      completeTurn = resolve;
      rejectTurn = reject;
    },
  );
  return {
    value: {
      async initializeCaseSession(input) {
        sessionId = input.assignment.sessionId;
        return {
          ok: true,
          value: {
            kind: "accepted",
            eventId: `initialized_${message}`,
            sequence: 0,
          },
        };
      },
      async prepareSessionInformationFlow(input) {
        return {
          ok: true,
          value: { flowBinding: await fixtureSerializedFlowBinding(input) },
        };
      },
      async startCanonicalEmbeddedHarnessTextTurn(input) {
        markStarted?.();
        if (sessionId === null) throw new Error("session was not initialized");
        return {
          ok: true,
          value: {
            ...(await completion),
            outcome: { status: "success", summary: null, artifacts: [] },
            flowBinding: await fixtureSerializedFlowBinding({
              sessionId,
              turnId: input.start.turnId,
              authorityPartitionDigest: input.start.authorityPartitionDigest,
            }),
          },
        };
      },
    },
    started,
    complete() {
      completeTurn?.({ finalMessage: message });
    },
    fail(error) {
      rejectTurn?.(error);
    },
  };
}

async function fixtureSerializedFlowBinding(
  input: Readonly<{
    readonly sessionId: string;
    readonly turnId: string;
    readonly authorityPartitionDigest: string;
  }>,
): Promise<SerializedFlowBinding> {
  const context = await InformationFlowContext.create({
    organisationId: "organisation_plan15",
    sessionId: input.sessionId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  if (!context.ok) throw new Error(context.error.code);
  return flowBindingForContext(context.value, input.turnId).toJSON();
}

function assignmentFlowBinding(
  assignment: ReturnType<typeof assignmentFixture>,
): Promise<SerializedFlowBinding> {
  return fixtureSerializedFlowBinding({
    sessionId: assignment.sessionId,
    turnId: `turn_${assignment.assignmentId}`,
    authorityPartitionDigest: assignment.authorityPartition.digest,
  });
}

function assignmentFixture(
  role: "coordinator" | "specialist",
  snapshot: CaseSnapshot,
  caseId = "case_plan15_rebase",
  connectorId = "connector_fixture",
) {
  const turnAuthority = fixtureTurnAuthority(
    requiredOrganisationId(),
    connectorId,
  );
  return {
    assignmentId: `assignment_plan15_${role}_rebase`,
    caseId,
    caseRevision: snapshot.revision,
    sessionId: `session_plan15_${role}_rebase`,
    role,
    objective: { instruction: `${role} mutable work` },
    authority: {
      capabilityProfile: "read_and_propose" as const,
      authorityPartitionDigest: turnAuthority.authorityPartition.digest,
    },
    authorityPartition: turnAuthority.authorityPartition,
    budget: {
      budgetRevision: "budget_1",
      maxTokens: 1_000,
      maxWallMs: 10_000,
      maxToolCalls: 10,
    },
    context: {
      evidenceDependency: { kind: "source_only" as const },
      caseId,
      revision: snapshot.revision,
      journalCursor: snapshot.journalCursor,
      workspaceRevision: snapshot.workspaceRevision,
      entries: snapshot.entries,
    },
  };
}

function whatsAppAssignmentFixture(snapshot: CaseSnapshot): CaseAssignment {
  const base = assignmentFixture(
    "coordinator",
    snapshot,
    "case_plan15_whatsapp",
  );
  return {
    assignmentId: "assignment_case_plan15_whatsapp_1",
    caseId: base.caseId,
    caseRevision: base.caseRevision,
    sessionId: "session_case_plan15_whatsapp",
    role: base.role,
    objective: base.objective,
    authority: base.authority,
    authorityPartition: {
      digest: base.authorityPartition.digest,
      key: {
        kind: "whatsapp_support",
        organisationId: "organisation_plan15",
        integrationAccountId: "integration_whatsapp_plan15",
        supportBindingId: "binding_whatsapp_plan15",
        bindingRevision: 2,
        ingressPolicyVersion: 4,
      },
      selectedGrantSetDigest: base.authorityPartition.selectedGrantSetDigest,
      capabilityKeys: base.authorityPartition.capabilityKeys,
      policyVersion: base.authorityPartition.policyVersion,
    },
    budget: base.budget,
    context: {
      evidenceDependency: base.context.evidenceDependency,
      caseId: base.context.caseId,
      revision: base.context.revision,
      journalCursor: base.context.journalCursor,
      workspaceRevision: base.context.workspaceRevision,
      entries: [...base.context.entries],
    },
  };
}

function beginFixture(
  assignment: ReturnType<typeof assignmentFixture>,
  turnId = `turn_${assignment.assignmentId}`,
) {
  return {
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    expectedCaseRevision: assignment.caseRevision,
    start: {
      startId: `start_${turnId}`,
      sessionId: assignment.sessionId,
      acceptedAt: 1_000,
    },
  };
}

function sharedChangeProposal(
  assignment: ReturnType<typeof assignmentFixture>,
) {
  return {
    proposalId: `proposal_${assignment.assignmentId}`,
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    sessionId: assignment.sessionId,
    turnId: `turn_${assignment.assignmentId}`,
    basedOnRevision: assignment.caseRevision,
    entries: [
      {
        kind: "shared_change" as const,
        entryId: `entry_${assignment.assignmentId}`,
        baseRevision: assignment.caseRevision,
        content: {
          kind: "text" as const,
          text: `${assignment.role} shared change`,
        },
      },
    ],
    requestedEffects: [],
  };
}

function actor(
  Constructor: new (state: DurableObjectState, env: UnitTestEnv) => CaseDO,
): CaseDO {
  return actorFixture(Constructor).actor;
}

function actorFixture(
  Constructor: new (state: DurableObjectState, env: UnitTestEnv) => CaseDO,
): {
  readonly actor: CaseDO;
  restart(): CaseDO;
} {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = new TestStorage(fixture.database, sql);
  const state = {
    storage,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: <Value>(callback: () => Promise<Value>) =>
      callback(),
  } as unknown as DurableObjectState;
  const env = platformEnv({
    DB: createMigratedDatabase(),
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    EVENT_Q: { send: ignoreQueueMessage },
  });
  const instance = new Constructor(state, env);
  const ensure = instance.ensure.bind(instance);
  vi.spyOn(instance, "ensure").mockImplementation(
    ensureActivatedFixtureCase.bind(null, instance, env, ensure),
  );
  const prepare = instance.prepareOngoingTurn.bind(instance);
  vi.spyOn(instance, "prepareOngoingTurn").mockImplementation(
    prepareActivatedFixtureCase.bind(null, instance, prepare),
  );
  return {
    actor: instance,
    restart() {
      return new Constructor(state, env);
    },
  };
}

async function prepareActivatedFixtureCase(
  actor: CaseDO,
  prepare: CaseDO["prepareOngoingTurn"],
  raw: unknown,
): ReturnType<CaseDO["prepareOngoingTurn"]> {
  if (isRecord(raw)) await actor.ensure(raw.ensure);
  return prepare(raw);
}

async function ensureActivatedFixtureCase(
  actor: CaseDO,
  env: UnitTestEnv,
  ensure: CaseDO["ensure"],
  raw: unknown,
): ReturnType<CaseDO["ensure"]> {
  const ensured = await ensure(raw);
  if (!ensured.ok) return ensured;
  const snapshot = await actor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const organisationId = parseOrganisationId(
    snapshot.value.identity.organisationId,
  );
  const caseId = parseCaseId(snapshot.value.identity.caseId);
  if (!organisationId.ok || !caseId.ok)
    throw new Error("Invalid Case fixture identity");
  await activateActorFixture(
    env,
    actor,
    {
      objectKind: "case",
      organisationId: organisationId.value,
      logicalObjectId: caseId.value,
    },
    CASE_ACTOR_SCHEMA_VERSION,
  );
  return ensured;
}

async function ignoreQueueMessage(_message: unknown): Promise<void> {}

function recordingConnector(): OngoingCaseWalkingConnector & {
  inspect(): { readonly deliveryCount: number };
} {
  const ingresses = new Map<string, string>();
  const deliveries = new Map<
    string,
    {
      readonly payload: string;
      readonly receipt: {
        readonly deliveryId: string;
        readonly connectorId: string;
        readonly idempotencyKey: string;
        readonly nativeReceiptId: string;
        readonly deliveredAt: number;
      };
    }
  >();
  return {
    // This Connector keeps no warm slots, so every thread creates its Actors.
    warmActorSlots: {
      take: () => null,
      giveBack: () => undefined,
      refresh: () => ({ current: [], stale: [] }),
    },
    async acceptIngress(raw) {
      const input = parseRecordingIngress(raw);
      if (input === null)
        return { ok: false, error: { code: "connector_ingress_invalid" } };
      const payload = JSON.stringify(input);
      const existing = ingresses.get(input.ingress.nativeEventId);
      if (existing !== undefined) {
        return existing === payload
          ? {
              ok: true,
              value: {
                kind: "duplicate" as const,
                caseId: input.ingress.caseId,
              },
            }
          : { ok: false, error: { code: "connector_ingress_conflict" } };
      }
      ingresses.set(input.ingress.nativeEventId, payload);
      return {
        ok: true,
        value: { kind: "accepted" as const, caseId: input.ingress.caseId },
      };
    },
    async deliver(raw) {
      const input = parseRecordingDelivery(raw);
      if (input === null)
        return { ok: false, error: { code: "connector_delivery_invalid" } };
      const payload = JSON.stringify(input.delivery);
      const existing = deliveries.get(input.delivery.deliveryId);
      if (existing !== undefined)
        return existing.payload === payload
          ? {
              ok: true,
              value: {
                kind: "already_delivered" as const,
                receipt: existing.receipt,
              },
            }
          : { ok: false, error: { code: "connector_delivery_conflict" } };
      const receipt = {
        deliveryId: input.delivery.deliveryId,
        connectorId: input.identity.connectorId,
        idempotencyKey: input.delivery.idempotencyKey,
        nativeReceiptId: "1785700000.000099",
        deliveredAt: input.requestedAt,
      };
      deliveries.set(input.delivery.deliveryId, { payload, receipt });
      return { ok: true, value: { kind: "delivered" as const, receipt } };
    },
    async streamCaseTurn() {
      return {
        ok: false,
        error: { kind: "operational", code: "unexpected_stream_case_turn" },
      };
    },
    inspect() {
      return { deliveryCount: deliveries.size };
    },
  };
}

function parseRecordingIngress(raw: unknown): {
  readonly ingress: { readonly nativeEventId: string; readonly caseId: string };
  readonly attachments: readonly unknown[];
  readonly payload: string;
} | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.ingress) ||
    typeof raw.ingress.nativeEventId !== "string" ||
    typeof raw.ingress.caseId !== "string"
  )
    return null;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  return {
    ingress: {
      nativeEventId: raw.ingress.nativeEventId,
      caseId: raw.ingress.caseId,
    },
    attachments,
    payload: JSON.stringify(raw),
  };
}

function parseRecordingDelivery(raw: unknown): {
  readonly identity: { readonly connectorId: string };
  readonly delivery: {
    readonly deliveryId: string;
    readonly idempotencyKey: string;
  };
  readonly requestedAt: number;
} | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.identity) ||
    typeof raw.identity.connectorId !== "string" ||
    !isRecord(raw.delivery) ||
    typeof raw.delivery.deliveryId !== "string" ||
    typeof raw.delivery.idempotencyKey !== "string" ||
    typeof raw.requestedAt !== "number"
  )
    return null;
  return {
    identity: { connectorId: raw.identity.connectorId },
    delivery: {
      deliveryId: raw.delivery.deliveryId,
      idempotencyKey: raw.delivery.idempotencyKey,
    },
    requestedAt: raw.requestedAt,
  };
}

class TestStorage {
  private alarm: number | null = null;
  constructor(
    private readonly database: ReturnType<
      typeof emptySqliteFixture
    >["database"],
    readonly sql: SqlStorage,
  ) {}
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.alarm = typeof at === "number" ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  transactionSync<Value>(callback: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId("organisation_plan15");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function merchantInputAuthorityPartition(
  requestAuthority: Variant<
    import("@purin-labs/contracts").RequestAuthority,
    "control"
  >,
) {
  const partition = {
    key: authorityPartitionKey(requestAuthority),
    selectedGrantSetDigest: "b".repeat(64),
    capabilityKeys: [],
    policyVersion: "policy_1",
  };
  return { ...partition, digest: await digestAuthorityPartition(partition) };
}

async function digestAuthorityPartition(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requiredRequestId(value = "request_plan15") {
  const parsed = parseRequestId(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredSessionId(value = "session_plan15_1") {
  const parsed = parseSessionId(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

vi.mock(
  "@purin-labs/actor-runtime/actors/actor-activation",
  async function caseRecoveryMock(importOriginal) {
    const original =
      await importOriginal<
        typeof import("@purin-labs/actor-runtime/actors/actor-activation")
      >();
    return { ...original, admitActorRecovery: caseFixtureRecovery };
  },
);
vi.mock(
  "../src/actors/action-mutation-execution",
  async function caseAuthorityMock(importOriginal) {
    const original =
      await importOriginal<
        typeof import("../src/actors/action-mutation-execution")
      >();
    return {
      ...original,
      authorizeActionMutationExecution: caseFixtureAuthority,
    };
  },
);

function caseFixtureRecovery(
  ...args: Parameters<typeof admitCaseMutationFixture>
) {
  return admitCaseMutationFixture(...args);
}
function caseFixtureAuthority() {
  return allowCaseMutationFixture();
}
