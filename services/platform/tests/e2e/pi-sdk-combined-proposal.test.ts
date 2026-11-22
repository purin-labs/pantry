import { fixtureDatabase } from "./organisation-database";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import { processTwoSessionDirectCaseCommand } from "../../src/actors/case-direct-processing";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  newRequestId,
  parseChannelId,
  parseConnectorId,
  parseSessionId,
  parseThreadKey,
} from "@purin-labs/kernel/ids";
import {
  compileAndStoreCueSnapshot,
  writeTierOneCommerceSubscription,
} from "@purin-labs/agent/cues/engine";
import { buildWorkflowAuthority } from "@purin-labs/authority/request-authority/index";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import {
  ORGANISATION_ID,
  WORKSPACE_ID,
  CHANNEL_ID,
  createRequiredGrant,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";
import { network } from "./network";
import {
  readCanonicalToolResults,
  verifyCombinedProposalExecution,
  verifyCommerceExecution,
} from "./case-execution-support";
import {
  ACCOUNT,
  OWNER,
  installEffectAuthority,
  listingReadCode,
  listingProposalRequest,
  listingNonce,
  postControl,
  effectEvidence,
} from "./pi-sdk-effect-support";

const COMBINED_WORKFLOW = "combined-inventory";
const COORDINATOR_MARK = "COMBINED-CASE-COORDINATOR";
const SPECIALIST_MARK = "COMBINED-CASE-SPECIALIST";
const COMBINED_MARK = "COMBINED-CASE-PROPOSAL";

/**
 * The model of the combined Case. Each of the three Sessions names itself in
 * its objective. The two that run side by side answer with one observation.
 * The third reads the catalog and proposes the listing for approval.
 */
class CombinedProvider {
  readonly requests: Record<string, unknown>[] = [];
  readonly combined: Record<string, unknown>[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid combined model request");
    this.requests.push(body);
    const text = JSON.stringify(body);
    if (text.includes(COMBINED_MARK)) {
      this.combined.push(body);
      const results = Array.isArray(body.messages)
        ? body.messages.filter(
            (message) => isRecord(message) && message.role === "tool",
          ).length
        : 0;
      switch (results) {
        case 0:
          return openRouterToolCall(
            "tool_search",
            { query: "commerce_entity_context", limit: 1 },
            "combined_discover",
          );
        case 1:
          return openRouterToolCall(
            "tool_search",
            { query: "commerce_propose_action", limit: 1 },
            "combined_action_discover",
          );
        case 2:
          return openRouterToolCall(
            "codemode",
            { code: listingReadCode() },
            "combined_read",
          );
        case 3:
          return openRouterToolCall(
            "commerce_propose_action",
            { request: listingProposalRequest() },
            "combined_propose",
          );
        default:
          return openRouterText(
            "COMBINED_PROPOSAL_AWAITING_APPROVAL",
            "combined_waiting",
          );
      }
    }
    if (text.includes(COORDINATOR_MARK))
      return openRouterText(
        "COORDINATOR_OBSERVATION: the shortage can be met from the online listing.",
        "combined_coordinator",
      );
    if (text.includes(SPECIALIST_MARK))
      return openRouterText(
        "SPECIALIST_OBSERVATION: forty cookie boxes are ready to list.",
        "combined_specialist",
      );
    throw new Error("Unexpected combined model request");
  }
}

it("joins two assignments that ran side by side into one proposal, one approval and one effect", async ({
  task,
}) => {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const provider = new CombinedProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );
  const now = Date.now();
  // An inventory cue of this organisation, as the lab has it. The cue engine
  // acts for this subscription.
  const channel = parseChannelId(CHANNEL_ID);
  const thread = parseThreadKey(`slack:${WORKSPACE_ID}:${CHANNEL_ID}:channel`);
  if (!channel.ok || !thread.ok) throw new Error("Cue destination invalid");
  await writeTierOneCommerceSubscription({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    subscriptionId: COMBINED_WORKFLOW,
    workspaceId: WORKSPACE_ID,
    channelId: channel.value,
    threadKey: thread.value,
    eventType: "inventory_shortage",
    template: "Review inventory_shortage.",
    delivery: { kind: "immediate" },
    debounceMs: 0,
    maxPerHour: 20,
  });
  await compileAndStoreCueSnapshot({
    db: fixtureDatabase(),
    kv: env.POLICY_KV,
    organisationId: ORGANISATION_ID,
    now,
  });
  // This workflow may read the Case and the catalog and may propose an
  // action. A person still approves it.
  const workflow = {
    kind: "workflow",
    workflowKind: "cue_subscription",
    workflowId: COMBINED_WORKFLOW,
    workflowRevision: 1,
  } as const;
  await createRequiredGrant({
    grantId: "grant_combined_case_read",
    subject: workflow,
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now,
  });
  await createRequiredGrant({
    grantId: "grant_combined_propose",
    subject: workflow,
    target: {
      kind: "provider_resource",
      capabilityId: "commerce.action.propose",
      capabilityVersion: 1,
      integrationAccountId: ACCOUNT,
      resourceScope: "*",
    },
    now,
  });
  await createRequiredGrant({
    grantId: "grant_combined_entity_context",
    subject: workflow,
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.entity_plane.context",
      capabilityVersion: 1,
    },
    now,
  });
  for (const typeId of [
    "product",
    "sellable_variant",
    "offer",
    "sales_channel",
  ] as const)
    await createRequiredGrant({
      grantId: `grant_combined_read_${typeId}`,
      subject: workflow,
      target: {
        kind: "commerce_read",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId },
        },
      },
      now,
    });
  const connectorId = parseConnectorId(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const started = await processTwoSessionDirectCaseCommand(env, {
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    projectContext: null,
    organisationId: ORGANISATION_ID,
    requestId: newRequestId(),
    stableIdentity: `${ORGANISATION_ID}:cue:commerce:combined-inventory-1`,
    triggerSource: { kind: "cue", eventId: "cue_combined_inventory_1" },
    content: { kind: "text", text: "Cookie boxes are short for tomorrow." },
    purpose: "Review a shortage of cookie boxes.",
    principal: { kind: "system", componentId: "cue_engine" },
    requestAuthority: buildWorkflowAuthority({
      organisationId: ORGANISATION_ID,
      workflowId: COMBINED_WORKFLOW,
      workflowRevision: 1,
    }).requestAuthority,
    receivedAt: now,
    coordinatorObjective: `${COORDINATOR_MARK} Use only the supplied Case context. Do not call tools. Add one observation.`,
    specialistObjective: `${SPECIALIST_MARK} Use only the supplied Case context. Do not call tools. Add one observation.`,
    combinedObjective: `${COMBINED_MARK} Read both observations in the Case context. Read the prepared cookie catalog and propose publishing its listing for approval.`,
    delivery: {
      kind: "connector",
      connectorId: connectorId.value,
      address: {
        kind: "slack_channel",
        workspaceId: WORKSPACE_ID,
        channelId: CHANNEL_ID,
      },
    },
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  if (started.value.kind !== "completed") throw new Error(started.value.kind);
  const caseId = started.value.caseId;
  expect(started.value.combined).not.toBeNull();
  // Each of the three Sessions delivered its own message. The two that ran
  // side by side asked the model one time each. The third asked five times:
  // two tool searches, the catalog read, the proposal and its last answer.
  // The proposal also posts the fixed notice that it waits for approval.
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(4);
  expect(JSON.stringify(slack.messages)).toContain(
    "Nothing changes until an owner or admin approves it.",
  );
  expect(provider.requests).toHaveLength(7);
  expect(provider.combined).toHaveLength(5);
  // The third Session was given what the other two proposed.
  expect(JSON.stringify(provider.combined[0])).toContain(
    "COORDINATOR_OBSERVATION",
  );
  expect(JSON.stringify(provider.combined[0])).toContain(
    "SPECIALIST_OBSERVATION",
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const nonce = listingNonce(provider.combined);
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  expect(action.value.caseId).toBe(caseId);
  // The action waits for a person. Nothing runs before the approval.
  const beforeApproval = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "combined-before-approval",
  );
  expect(beforeApproval.status).toBe(409);
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });
  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  const grant = await completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: "combined-step-up",
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    "combined-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  // The provider applies the effect and its answer is lost. The Case's
  // instance and the Organisation's instance are then replaced, before the
  // outcome is delivered. The same command sent again settles one effect.
  const lost = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "combined-execute",
  );
  expect(lost.status, await lost.clone().text()).toBe(503);
  expect(await effectEvidence()).toMatchObject({
    mutations: 1,
    committed: { outcome: "applied" },
  });
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: action.value.caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  await evictDurableObject(caseActor.value);
  await evictDurableObject(organisation);
  const recovered = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "combined-execute",
  );
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  expect(await recovered.json()).toMatchObject({
    ok: true,
    action: { state: "confirmed" },
    follow_up: { kind: "complete" },
  });
  expect(await effectEvidence()).toMatchObject({
    mutations: 1,
    receiptReads: 1,
  });
  // The outcome updates the one card; the thread gets no new message.
  await expect
    .poll(() => JSON.stringify(slack.messages), { timeout: 15_000 })
    .toContain("Purin Pantry made the change.");
  expect(slack.visibleMessageCount()).toBe(4);

  // The Case's execution, read on the control plane by the owner. The Case
  // came from a cue, which belongs to the whole Organisation, so the owner
  // reads every record of it, with no seat in its Project (Plan 27C).
  const canonical = await caseActor.value.inspect();
  if (!canonical.ok) throw new Error(canonical.error.code);
  const toolResults = [];
  for (const lifecycle of canonical.value.assignmentLifecycles) {
    const sessionId = parseSessionId(lifecycle.assignment.sessionId);
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    const actor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: sessionId.value,
      now: Date.now(),
    });
    if (!actor.ok) throw new Error(actor.error.code);
    toolResults.push(
      ...(await runInDurableObject(actor.value, readCanonicalToolResults)),
    );
  }
  expect(canonical.value.assignmentLifecycles).toHaveLength(3);
  expect(toolResults).toHaveLength(4);
  const execution = await verifyCommerceExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId,
    canonical: canonical.value,
    triggers: 1,
    turns: 3,
    toolResults,
  });
  const joined = await verifyCombinedProposalExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId,
  });
  Object.assign(task.meta, {
    caseExecution: {
      substituted: [
        "model provider (deterministic OpenRouter transport)",
        "Slack",
        "commerce provider (Commerce test merchant)",
        "the cue (the journey starts the two-session command itself)",
      ],
      ...execution,
      joined,
      canonical: {
        assignments: canonical.value.assignmentLifecycles.map((lifecycle) => ({
          role: lifecycle.assignment.role,
          state: lifecycle.kind,
          givenEntries: lifecycle.assignment.context.entries.length,
        })),
        proposals: canonical.value.acceptedProposalIds.length,
        commerceProposals: canonical.value.acceptedCommerceProposalIds.length,
        approvals: canonical.value.commerceApprovals.length,
        outputs: canonical.value.outputs.length,
      },
      modelRequests: {
        all: provider.requests.length,
        combined: provider.combined.length,
      },
    },
  });
});
