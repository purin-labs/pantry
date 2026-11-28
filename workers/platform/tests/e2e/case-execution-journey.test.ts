import { fixtureDatabase } from "./organisation-database";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import {
  deriveDirectCaseIdentities,
  processTwoSessionDirectCaseCommand,
} from "@purin-labs/conversation/actors/case-direct-processing";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  newRequestId,
  type CaseId,
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
  listExecutionCases,
  openNodes,
  readCanonicalRuntimes,
  readCanonicalToolAttempts,
  readCanonicalToolResults,
  journalAttempts,
  readCaseExecution,
  verifyCombinedProposalExecution,
  verifyCommerceExecution,
  verifyExecutionHidden,
} from "./case-execution-support";
import { commerceClient } from "./commerce-support";
import {
  controlCapabilityCompletions,
  countCalls,
} from "./durable-codemode-journey-support";
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

/**
 * The acceptance journey of the Case execution view (Plan 42J, B2). One Case
 * holds every step: two assignments side by side, a third that was given what
 * both proposed, its proposal, an approval wait, one governed effect, an
 * attempt that was interrupted and tried again, and Actors replaced before
 * the outcome is delivered. The owner reads every record in the open, and a
 * member without the Case read gets the answer of a missing Case. The
 * artifact is output/plan-42j/execution-journey.json.
 */
const COMBINED_WORKFLOW = "combined-inventory";
const STABLE_IDENTITY = `${ORGANISATION_ID}:cue:commerce:combined-inventory-1`;
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

it(
  "holds one Case from two side-by-side assignments to one approved effect, through an interrupted attempt and replaced Actors",
  { timeout: 120_000 },
  caseExecutionJourney,
);

async function caseExecutionJourney(test: TestContext): Promise<void> {
  // A member with the viewer role holds no Case read. The account attach of
  // the fixture admits this person before the role exists.
  const outsider = await commerceClient(
    `execution-viewer-${crypto.randomUUID()}`,
  );
  const fixture = await installSlackActorFixture();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Viewer')",
      )
      .bind(ORGANISATION_ID, OUTSIDER_PERSON),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'viewer', 'active', ?)",
      )
      .bind(
        ORGANISATION_ID,
        outsider.identity.userId,
        OUTSIDER_PERSON,
        Date.now(),
      ),
  ]);
  const slack = slackSimulator();
  const identities = await deriveDirectCaseIdentities(STABLE_IDENTITY);
  if (!identities.ok) throw new Error(identities.error.code);
  const caseId = identities.value.caseId;
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
  // One delivery of the cue's command. Each delivery names the same trigger,
  // as a queue retry does.
  const deliver = async () =>
    processTwoSessionDirectCaseCommand(env, {
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      projectContext: null,
      organisationId: ORGANISATION_ID,
      requestId: newRequestId(),
      stableIdentity: STABLE_IDENTITY,
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

  // The first delivery runs the two assignments side by side and starts the
  // third. The third Session's script reads the catalog, and that read gets
  // no answer. The Session's instance is lost during the read, and the
  // delivery ends with it. No model request is open then.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const reads = await controlCapabilityCompletions(test, organisation, [
    "never",
  ]);
  const delivery = deliver().then(returned, threw);
  await expect
    .poll(countCalls.bind(null, reads.calls), { timeout: 30_000 })
    .toBe(1);
  const stopped = await runningSession(caseId);
  await runInDurableObject(stopped.actor, abortActor).catch(ignoreLostActor);
  const stoppedDelivery = await delivery;
  expect(stoppedDelivery).not.toMatchObject({ result: { ok: true } });
  // Each of the two side-by-side Sessions delivered its own message.
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  // The Session's next instance resumes the turn under a new attempt. The
  // read runs again, and the turn proposes the listing and ends. The
  // proposal posts the notice that it waits for approval.
  const turnId = `turn_trigger_${identities.value.digest}_combined`;
  await expect
    .poll(resumedTurnState.bind(null, stopped.sessionId, turnId), {
      timeout: 40_000,
      interval: 500,
    })
    .toEqual({ ok: true, value: { kind: "present", state: "complete" } });
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(JSON.stringify(slack.messages)).toContain(APPROVAL_NOTICE);
  // The next delivery gives the completed turn to the Case: the third
  // Session's message is delivered and its assignment ends.
  const finished = await deliver();
  expect(finished).toMatchObject({
    ok: true,
    value: { kind: "duplicate_trigger", caseId },
  });
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(4);
  // One more delivery adds no message and no model request.
  const modelRequests = provider.requests.length;
  expect(await deliver()).toMatchObject({
    ok: true,
    value: { kind: "duplicate_trigger", caseId },
  });
  expect(slack.visibleMessageCount()).toBe(4);
  expect(provider.requests).toHaveLength(modelRequests);
  // The third Session was given what the other two proposed.
  expect(JSON.stringify(provider.combined[0])).toContain(
    "COORDINATOR_OBSERVATION",
  );
  expect(JSON.stringify(provider.combined[0])).toContain(
    "SPECIALIST_OBSERVATION",
  );
  const nonce = listingNonce(provider.combined);
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  expect(action.value.caseId).toBe(caseId);
  // The action waits for a person. Nothing runs before the approval, and the
  // owner reads the wait as a wait: no decision and no effect that ran.
  const beforeApproval = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "combined-before-approval",
  );
  expect(beforeApproval.status).toBe(409);
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });
  const waiting = await readCaseExecution(
    ORGANISATION_ID,
    session,
    caseId,
    100,
  );
  const waitingApproval = openNodes(waiting, "approval");
  expect(waitingApproval).toMatchObject([
    { state: "waiting", decidedAt: null },
  ]);
  const waitingEffects = openNodes(waiting, "effect").map(
    (effect) => effect.state,
  );
  expect(waitingEffects).toHaveLength(1);
  expect(["proposed", "approval_requested"]).toContain(waitingEffects[0]);
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
  const provided = await effectEvidence();
  expect(provided).toMatchObject({ mutations: 1, receiptReads: 1 });
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
  expect(
    canonical.value.assignmentLifecycles.map((lifecycle) =>
      lifecycle.kind === "settled"
        ? lifecycle.disposition.kind
        : lifecycle.kind,
    ),
  ).toEqual(["completed", "completed", "completed"]);
  expect(toolResults).toHaveLength(4);
  // Three turns ran under four attempts: the third turn has two.
  const execution = await verifyCommerceExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId,
    canonical: canonical.value,
    triggers: 1,
    turns: 3,
    attempts: 4,
    toolResults,
  });
  const joined = await verifyCombinedProposalExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId,
  });
  const full = await readCaseExecution(ORGANISATION_ID, session, caseId, 100);
  // The attempts of the third turn are the runtimes of its Session's
  // journal: the first was interrupted at the recovery that fenced it, and
  // the second ended.
  const thirdActor = (await sessionOf(stopped.sessionId)).actor;
  const journal = await runInDurableObject(thirdActor, readCanonicalRuntimes);
  const attempts = openNodes(full, "attempt").filter(
    (attempt) => attempt.sessionId === stopped.sessionId,
  );
  expect(
    attempts.map((attempt) => ({
      generation: attempt.generation,
      startedAt: attempt.startedAt,
      interruptedAt: attempt.interruptedAt,
    })),
  ).toEqual(journalAttempts(journal));
  expect(
    attempts.map((attempt) => [attempt.generation, attempt.state]),
  ).toEqual([
    [1, "interrupted"],
    [2, "ended"],
  ]);
  // Each tool operation names the attempt that accepted its call and the one
  // that accepted its result, as the Session's history holds them. The first
  // attempt stopped during the catalog read: the second attempt accepted
  // that call's result and made the proposal call.
  const tools = openNodes(full, "tool_operation").filter(
    (tool) => tool.sessionId === stopped.sessionId,
  );
  expect(
    tools.map((tool) => ({
      callId: tool.callId,
      called: tool.generation,
      settled: tool.settledGeneration,
    })),
  ).toEqual(await runInDurableObject(thirdActor, readCanonicalToolAttempts));
  expect(
    tools.map((tool) => [tool.tool, tool.generation, tool.settledGeneration]),
  ).toEqual([
    ["tool_search", 1, 1],
    ["tool_search", 1, 1],
    ["codemode", 1, 2],
    ["commerce_propose_action", 2, 2],
  ]);
  // The proposal hangs from the tool call of the second attempt.
  const proposing = tools.filter((tool) =>
    full.edges.some(
      (edge) => edge.from === tool.nodeId && edge.basis === "tool_call",
    ),
  );
  expect(proposing).toMatchObject([
    { tool: "commerce_propose_action", generation: 2, settledGeneration: 2 },
  ]);
  // The approval wait moved from waiting to approved, with the times of the
  // Case's own record. One effect is settled, with the provider's receipt.
  const wait = canonical.value.commerceApprovals[0];
  if (wait?.kind !== "decided") throw new Error("Expected a decided wait");
  const approval = openNodes(full, "approval");
  expect(approval).toMatchObject([
    {
      nodeId: waitingApproval[0]?.nodeId,
      state: "approved",
      requestedAt: wait.request.requestedAt,
      decidedAt: wait.decision.decidedAt,
    },
  ]);
  const effects = openNodes(full, "effect");
  // One effect is settled. It carries the receipt that the commerce
  // provider committed.
  expect(effects).toMatchObject([{ actionId: nonce, state: "confirmed" }]);
  if (
    !isRecord(provided) ||
    !isRecord(provided.committed) ||
    !isRecord(provided.committed.receipt)
  )
    throw new Error("Missing provider receipt");
  expect(effects[0]?.receipt?.receiptId).toBe(
    provided.committed.receipt.receiptId,
  );
  const deliveries = openNodes(full, "delivery");
  expect(deliveries.map((delivery) => delivery.state)).toEqual(
    deliveries.map(() => "delivered"),
  );
  // After the Session's instance and the Case's instance are replaced, the
  // owner reads the same projection.
  await evictDurableObject(thirdActor);
  await evictDurableObject(caseActor.value);
  expect(
    await readCaseExecution(ORGANISATION_ID, session, caseId, 100),
  ).toEqual(full);
  // A member without the Case read gets the answer of a missing Case, for
  // the projection, for a node of it and for the list.
  const firstNode = full.nodes[0];
  if (firstNode === undefined) throw new Error("No node");
  const denied = await verifyExecutionHidden(
    ORGANISATION_ID,
    outsider.session,
    caseId,
    firstNode.nodeId,
  );
  const lists = {
    owner: await listExecutionCases(ORGANISATION_ID, session),
    outsider: await listExecutionCases(ORGANISATION_ID, outsider.session),
  };
  expect(lists.owner.cases?.map((entry) => entry.caseId)).toContain(caseId);
  expect(lists.outsider).toEqual({ status: 404, cases: null });

  const artifact = {
    journey: "Plan 42J B2: Case execution acceptance journey",
    rerun:
      "pnpm --filter @purin-labs/platform test:e2e tests/e2e/case-execution-journey.test.ts",
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack",
      "commerce provider (Commerce test merchant)",
      "the cue (the journey sends the two-session command itself)",
    ],
    caseId,
    deliveries: {
      stopped: stoppedDelivery.kind,
      afterRecovery: "duplicate_trigger",
      slackMessages: slack.visibleMessageCount(),
    },
    modelRequests: {
      all: provider.requests.length,
      combined: provider.combined.length,
      catalogReadsThatReachedTheOrganisation: reads.calls.length,
    },
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
      journal,
    },
    execution,
    joined,
    attempts: attempts.map((attempt) => ({
      generation: attempt.generation,
      state: attempt.state,
      startedAt: attempt.startedAt,
      interruptedAt: attempt.interruptedAt,
    })),
    toolOperations: tools.map((tool) => ({
      tool: tool.tool,
      state: tool.state,
      calledInAttempt: tool.generation,
      resultAcceptedInAttempt: tool.settledGeneration,
    })),
    approval: {
      whileWaiting: waitingApproval.map((node) => ({
        state: node.state,
        requestedAt: node.requestedAt,
        decidedAt: node.decidedAt,
      })),
      effectWhileWaiting: waitingEffects,
      afterDecision: approval.map((node) => ({
        state: node.state,
        requestedAt: node.requestedAt,
        decidedAt: node.decidedAt,
      })),
    },
    effect: effects.map((effect) => ({
      state: effect.state,
      receipt: effect.receipt,
    })),
    providerEvidence: provided,
    deliveryReceipts: deliveries.map((delivery) => ({
      state: delivery.state,
      receipt: delivery.receipt,
    })),
    reads: {
      owner: { access: "open", nodes: full.nodes.length },
      afterActorReplacement: "same projection",
      memberWithoutCaseRead: {
        projection: denied.status,
        list: lists.outsider.status,
      },
    },
    // Each link that the records do not hold, as the read names it.
    absentLinks: full.limitations.map((limitation) => ({
      limitation,
      reason: ABSENT_LINKS[limitation] ?? "not explained",
    })),
    eventExport: { nodes: full.nodes, edges: full.edges },
  };
  expect(artifact.absentLinks.map((link) => link.reason)).not.toContain(
    "not explained",
  );
  Object.assign(test.task.meta, { caseExecution: artifact });
  const written = await env.JOURNEY_ARTIFACTS.fetch(
    "http://artifacts/plan-42j/execution-journey.json",
    { method: "PUT", body: JSON.stringify({ status: "passed", ...artifact }) },
  );
  expect(written.status, await written.clone().text()).toBe(200);
}

const OUTSIDER_PERSON = "person_execution_journey_viewer";
const APPROVAL_NOTICE = "Nothing changes until an owner or admin approves it.";

/** Why the records hold no link, for each limitation this Case shows. */
const ABSENT_LINKS: Readonly<Record<string, string>> = {
  effect_attempts_unrecorded:
    "The action ledger keeps the latest state of an effect. The lost try and the try that settled it are one record.",
  delivery_attempts_unrecorded:
    "A delivery keeps its latest state and its receipt. Each try to send it is not a record.",
};

function returned(result: unknown) {
  return { kind: "returned" as const, result };
}

function threw(error: unknown) {
  return { kind: "threw" as const, result: String(error) };
}

function ignoreLostActor(): void {}

/**
 * The state of the turn in the Session's present instance. The lost instance
 * broke its stub, so each read takes a new one. The read also runs the
 * Session's alarm when one is due, as the runtime does.
 */
async function resumedTurnState(sessionId: string, turnId: string) {
  const session = await sessionOf(sessionId);
  await runDurableObjectAlarm(session.actor);
  return session.actor.inspectTurnStream({
    organisationId: ORGANISATION_ID,
    turnId,
  });
}

function abortActor(_actor: unknown, state: DurableObjectState): void {
  state.abort("Case execution journey interruption");
}

async function sessionOf(raw: string) {
  const sessionId = parseSessionId(raw);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return { sessionId: sessionId.value, actor: actor.value };
}

/** The Session of the one assignment of the Case that runs now. */
async function runningSession(caseId: CaseId) {
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const running = snapshot.value.assignmentLifecycles.filter(
    (lifecycle) => lifecycle.kind === "running",
  );
  if (running.length !== 1 || running[0] === undefined)
    throw new Error(`Expected one running assignment: ${running.length}`);
  return sessionOf(running[0].assignment.sessionId);
}
