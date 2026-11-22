import { controlActionMutationExecution } from "../../src/actors/action-mutation-execution";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import type { ActionLedgerEntry } from "../../src/actors/action-ledger";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { googleConfig } from "../../src/control/google-oidc-config";
import { type IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  ORGANISATION_ID,
  ROOT_TS,
  discoverSlackChannel,
  installSlackActorFixture,
  inspectSlackActors,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";
import { network } from "./network";
import {
  executionRequest,
  readCanonicalToolResults,
  verifyCommerceExecution,
} from "./case-execution-support";
import {
  OWNER,
  installEffectAuthority,
  ListingProvider,
  lastListingToolText,
  listingNonce,
  sendListingMessage,
  postControl,
  effectEvidence,
} from "./pi-sdk-effect-support";

it("explains denied commerce authority through composition and a direct read without retrying admission", async ({
  task,
}) => {
  const fixture = await installSlackActorFixture();
  await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "report_denial",
  );
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToCommerceDenial.bind(null, requests),
    ),
  );
  await sendListingMessage(
    "app_mention",
    "EvPiCommerceDenied",
    ROOT_TS,
    "<@U0PANTRY> Read failed payments and open orders, and explain any missing access.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(requests).toHaveLength(4);
  expect(slack.messages[0]?.text).toContain(
    "commerce_context_authority_denied",
  );
  const accepted = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "commerce-authority-denial",
      requests,
      session: accepted.session,
      delivered: slack.messages,
    },
  });
});

async function respondToCommerceDenial(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid commerce denial model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        "denied_discovery",
      );
    case 2:
      return openRouterToolCall(
        "codemode",
        {
          code: `text(await tools.commerce_entity_context({request:${JSON.stringify(deniedPaymentRequest())}}));`,
        },
        "denied_composition",
      );
    case 3:
      expect(lastListingToolText(body)).toContain(
        "commerce_context_authority_denied",
      );
      expect(lastListingToolText(body)).not.toContain("access controls");
      expect(lastListingToolText(body)).toContain(
        "Do not retry this denied read",
      );
      return openRouterToolCall(
        "commerce_entity_context",
        { request: deniedPaymentRequest() },
        "denied_direct",
      );
    case 4:
      expect(lastListingToolText(body)).toContain("shared channel");
      expect(lastListingToolText(body)).toContain(
        "Do not retry this denied read",
      );
      return openRouterText(
        "commerce_context_authority_denied: an authorized operator must grant these report reads for this conversation through access controls before a new turn.",
        "denied_final",
      );
    default:
      throw new Error("Unexpected commerce denial model request");
  }
}

function deniedPaymentRequest() {
  return {
    selection: {
      kind: "entity_seeds",
      seeds: [
        {
          origin: "system",
          typeId: "payment",
          entityId: "payment_not_granted",
        },
      ],
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [],
    freshnessRequirement: "current_only",
  };
}

it("restores a Pi listing proposal and one approved effect after response loss and Actor eviction", async ({
  task,
}) => {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const provider = new ListingProvider();
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
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  Object.assign(task.meta, {
    piSdkEvidence: { requests: provider.requests, delivered: slack.messages },
  });
  await sendListingMessage(
    "app_mention",
    "EvPiListing",
    ROOT_TS,
    "<@U0PANTRY> Read the prepared cookie catalog and propose publishing its listing for approval.",
  );
  // The approval notice and the agent's reply. This workspace has no Portal
  // handles, so the notice names the place without a link.
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  expect(slack.messages[0]?.text).toMatch(
    /\n\nNothing changes until an owner or admin approves it\.$/u,
  );
  const nonce = listingNonce(provider.requests);
  const initialActors = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  const proposal = action.value;
  const beforeApproval = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "pi-effect-before-approval",
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
    stepUpId: "pi-effect-step-up",
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    "pi-effect-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(await approved.json()).toMatchObject({ state: "signed" });

  const lost = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "pi-effect-execute",
  );
  expect(lost.status, await lost.clone().text()).toBe(503);
  const indeterminate = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  expect(indeterminate).toMatchObject({
    ok: true,
    value: { state: "indeterminate" },
  });
  const committed = await effectEvidence();
  expect(committed).toMatchObject({
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
    "pi-effect-execute",
  );
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  const result = await recovered.json();
  expect(result).toMatchObject({
    ok: true,
    action: { state: "confirmed" },
    follow_up: { kind: "complete" },
  });
  const replayed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "pi-effect-execute",
  );
  expect(await replayed.json()).toEqual(result);
  const evidence = await effectEvidence();
  expect(evidence).toMatchObject({ mutations: 1, receiptReads: 1 });
  if (
    !isRecord(evidence) ||
    !isRecord(evidence.committed) ||
    !isRecord(evidence.committed.receipt) ||
    !isRecord(result) ||
    !isRecord(result.receipt)
  )
    throw new Error("Missing recovered provider receipt");
  expect(result.receipt.receiptId).toBe(evidence.committed.receipt.receiptId);
  expect(result.receipt.effectId).toBe(evidence.committed.receipt.effectId);
  const restored = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const final = await restored.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!final.ok) throw new Error(final.error.code);
  expect(final.value.idempotencyKey).toBe(action.value.idempotencyKey);
  expect(final.value.action.nonce).toEqual(action.value.action.nonce);
  const proposalReplay = await repeatListingProposal(
    session,
    restored,
    final.value,
    final.value.action.argsHash,
  );
  expect(proposalReplay).toEqual({ ok: true, value: final.value });
  const proposalConflict = await repeatListingProposal(
    session,
    restored,
    final.value,
    "changed-proposal-arguments",
  );
  expect(proposalConflict).toEqual({
    ok: false,
    error: { code: "action_replay" },
  });
  const proposalActivity = await restored.readActionActivity({
    organisationId: ORGANISATION_ID,
    resourceKey: final.value.action.resourceKey,
    limit: 100,
  });
  if (!proposalActivity.ok) throw new Error(proposalActivity.error.code);
  expect(proposalActivity.value).toHaveLength(1);
  expect(await effectEvidence()).toMatchObject({
    mutations: 1,
    receiptReads: 1,
  });
  // The outcome updates the one card; the thread gets no new message.
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 15_000 })
    .toContain("Purin Pantry made the change.");
  expect(slack.visibleMessageCount()).toBe(2);
  const sessionRow = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (sessionRow === null) throw new Error("Missing Pi session Actor");
  await evictDurableObject(env.SESSION.getByName(sessionRow.name));
  await sendListingMessage(
    "message",
    "EvPiListingRestored",
    "1787500000.000003",
    "Report the retained listing proposal without reading or proposing it again.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(provider.requests).toHaveLength(7);
  const afterFollowup = await effectEvidence();
  expect(afterFollowup).toMatchObject({ mutations: 1, receiptReads: 1 });
  const restoredActors = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  expect(restoredActors.sessionId).toBe(initialActors.sessionId);
  // The Case's execution, read on the control plane. The Case came from a
  // Slack channel that Pantry has not listed as public, so it answers as
  // missing (Plan 27C).
  expect(
    await executionRequest(
      ORGANISATION_ID,
      session,
      `/cases/${action.value.caseId}/execution`,
    ),
  ).toMatchObject({ status: 404, body: { error: "case_execution_not_found" } });
  // Once a discovery lists the channel as public, the owner reads every
  // record of the Case.
  await discoverSlackChannel("public_channel");
  const executionCase = await caseActor.value.inspect();
  if (!executionCase.ok) throw new Error(executionCase.error.code);
  const caseExecution = await verifyCommerceExecution({
    organisationId: ORGANISATION_ID,
    session,
    caseId: action.value.caseId,
    canonical: executionCase.value,
    triggers: 2,
    turns: 2,
    toolResults: await runInDurableObject(
      env.SESSION.getByName(sessionRow.name),
      readCanonicalToolResults,
    ),
  });
  Object.assign(task.meta, {
    caseExecution: {
      substituted: [
        "model provider (deterministic OpenRouter transport)",
        "Slack",
        "commerce provider (Commerce test merchant)",
      ],
      ...caseExecution,
    },
  });
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "pi-origin-approved-listing-response-loss",
      requests: provider.requests,
      proposal,
      indeterminate,
      provider: evidence,
      recovered: result,
      finalAction: final.value,
      proposalReplay,
      proposalConflict,
      proposalOperationCount: proposalActivity.value.length,
      case: await caseActor.value.inspect(),
      delivered: slack.messages,
      initialActors,
      restoredActors,
    },
  });
});

async function repeatListingProposal(
  session: IssuedControlSession,
  organisation: DurableObjectStub<OrganisationDO>,
  entry: ActionLedgerEntry,
  argsHash: string,
) {
  const now = Date.now();
  const execution = await controlActionMutationExecution(
    env,
    entry.action.organisationId,
    session.session,
  );
  if (!execution.ok) throw new Error(execution.error.code);
  return organisation.proposeAction({
    execution: execution.value,
    organisationId: entry.action.organisationId,
    integrationAccountId: entry.action.integrationAccountId,
    requestAuthority: entry.action.requestAuthority,
    authorityPartition: entry.action.authorityPartition,
    authority: entry.action.authority,
    caseId: entry.caseId,
    proposalId: entry.proposalId,
    sessionId: entry.action.sessionId,
    threadId: entry.action.threadId,
    draft: {
      host: entry.action.host,
      verb: entry.action.verb,
      path: entry.action.path,
      argsHash,
      amount: entry.action.amount,
      resourceKey: entry.action.resourceKey,
    },
    flowBinding: entry.action.flowBinding,
    exp: now + 15 * 60_000,
    now,
  });
}
