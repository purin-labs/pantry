import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { newProjectId } from "@purin-labs/control-api";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { encodeBase64, isRecord } from "@purin-labs/std";
import { parsePantryAccountBinding } from "../../src/account-platform/types";
import { parseRequestId } from "../../src/ids";
import { createAccountPlatformClient } from "../../src/account-platform/client";
import { resolvePantryAccountBinding } from "../../src/account-platform/binding";
import { readPantryProvisionEnvelope } from "../../src/account-platform/provisioning-boundary";
import { resolveLinkedPantryAccountUser } from "../../src/account-platform/identity";
import {
  abortSharedAccountActor,
  accountFixtureJson,
  accountProducerRequest,
  completedNativeUsage,
  accountFixtureRequest,
  activateSharedAccountNativeTenant,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  chatPath,
  createSharedAccountConversation,
  fixtureRows,
  fixtureUserPrincipal,
  expiredFixtureUserAssertion,
  inspectNativeAccountBilling,
  inspectNativeAcceptedTurn,
  installSharedAccountSource,
  linkAccountFixtureMember,
  nativeAccountRequest,
  nativeConversationWork,
  nativeProvisionRequest,
  nativeServiceMemberMutation,
  readNativeServiceGrant,
  readSharedNativePortalInvitation,
  readSharedAccountFixture,
  selectSharedAccountModelRoute,
  sharedAccountSessionActor,
  sharedAccountPolicySupersession,
  startSharedAccountTurn,
} from "./shared-account-platform-fixture";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";

interface ProviderFixture {
  readonly requests: Record<string, unknown>[];
  gate:
    | { readonly kind: "immediate" }
    | { readonly kind: "held"; readonly resume: PromiseWithResolvers<void> };
}

it(
  "settles native Satyr turns through the real account authority and preserves independent service and content access",
  sharedAccountPlatformJourney,
  180000,
);

async function sharedAccountPlatformJourney(
  context: TestContext,
): Promise<void> {
  const evidence: Record<string, unknown> = {
    stage: "native-bootstrap",
    accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
  };
  storeSharedAccountEvidence(context, evidence);
  context.onTestFinished(
    storeSharedAccountEvidence.bind(null, context, evidence),
  );
  const native = await bootstrapSharedAccountNativeTenants();
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", native.setup),
  );
  evidence.stage = "account-provision";
  expect(setup.primary.scope.organizationId).not.toBe(
    setup.foreign.scope.organizationId,
  );
  expect(setup.primary.scope.projectId).not.toBe(setup.foreign.scope.projectId);
  const primaryProvision = await applyAccountFixtureProvision(
    setup.provisionEnvelopes.primary,
  );
  const foreignProvision = await applyAccountFixtureProvision(
    setup.provisionEnvelopes.foreign,
  );
  expect(primaryProvision.owner.nativePrincipalId).toBe(
    native.primary.owner.identity.userId,
  );
  expect(foreignProvision.owner.nativePrincipalId).toBe(
    native.foreign.owner.identity.userId,
  );
  const replay = await nativeProvisionRequest(
    "provision",
    setup.provisionEnvelopes.primary,
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({
    kind: "accepted",
    value: primaryProvision,
  });
  const status = await nativeProvisionRequest("status", {
    version: 1,
    instanceId: setup.primary.instanceId,
  });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    kind: "accepted",
    value: {
      accountState: "active",
      nativeOperationalReadiness: { kind: "configuring" },
    },
  });
  await linkAccountFixtureMember(
    native.primary.organisationId,
    native.finance,
    setup,
  );
  await linkAccountFixtureMember(
    native.primary.organisationId,
    native.operator,
    setup,
  );
  await linkAccountFixtureMember(
    native.primary.organisationId,
    native.privateMember,
    setup,
  );
  evidence.provision = {
    primary: primaryProvision,
    foreign: foreignProvision,
    duplicate: "same_receipt",
    accountState: "active",
    nativeReadiness: "configuring",
  };
  const route = await selectSharedAccountModelRoute(
    native.primary.organisationId,
    native.primary.owner,
    "satyr_platform",
  );
  const foreignRoute = await selectSharedAccountModelRoute(
    native.foreign.organisationId,
    native.foreign.owner,
    "satyr_platform",
  );
  await activateSharedAccountNativeTenant(native.primary.organisationId);
  await activateSharedAccountNativeTenant(native.foreign.organisationId);
  evidence.policySupersession = await sharedAccountPolicySupersession(
    native.primary.organisationId,
    native.primary.owner,
  );
  const sharedWorkProjectId = newProjectId();
  const projectBase = `/v1/control/organisations/${native.primary.organisationId}/projects`;
  const createdProject = await nativeAccountRequest(
    native.primary.owner,
    projectBase,
    {
      kind: "create_project",
      operationId: crypto.randomUUID(),
      projectId: sharedWorkProjectId,
      content: {
        name: "Prior shared project grant",
        brief: "Private native work project acceptance",
        references: [],
      },
    },
  );
  expect(createdProject.status, await createdProject.text()).toBe(200);
  const sharedProject = await nativeAccountRequest(
    native.primary.owner,
    `${projectBase}/${sharedWorkProjectId}/access`,
    {
      kind: "share_project",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 0,
      members: [{ userId: native.operator.identity.userId, role: "viewer" }],
    },
  );
  expect(sharedProject.status, await sharedProject.text()).toBe(200);
  const oldProjectAccess = await nativeAccountRequest(
    native.operator,
    `${projectBase}/${sharedWorkProjectId}/access`,
    null,
  );
  expect(oldProjectAccess.status).toBe(200);
  evidence.priorProjectGrant = {
    projectId: sharedWorkProjectId,
    beforeRemoval: oldProjectAccess.status,
  };
  const provider: ProviderFixture = {
    requests: [],
    gate: { kind: "immediate" },
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      platformReply.bind(null, provider),
    ),
  );
  const conversationId = await createSharedAccountConversation(
    native.primary.organisationId,
    native.operator,
    route,
    null,
  );
  evidence.stage = "native-paid-turn";
  const started = await startSharedAccountTurn(
    native.primary.organisationId,
    native.operator,
    conversationId,
    route,
    "shared_account_first",
  );
  expect(started.status, await started.text()).toBe(200);
  await expect
    .poll(
      nativeConversationWork.bind(
        null,
        native.primary.organisationId,
        native.operator,
        conversationId,
      ),
      { timeout: 30000 },
    )
    .toBe("ready");
  const session = await sharedAccountSessionActor(
    native.primary.organisationId,
    native.operator,
    conversationId,
  );
  await runDurableObjectAlarm(session.actor);
  const paid = await runInDurableObject(
    session.actor,
    inspectNativeAccountBilling.bind(null, session.turnId),
  );
  expect(paid).toMatchObject({
    kind: "isolated_e2e_completed_turn",
    phase: { kind: "delivered", receipt: { kind: "charged", amountMinor: 1 } },
    identity: {
      instanceId: setup.primary.instanceId,
      funding: { kind: "platform", selection: "satyr_platform" },
    },
  });
  const acceptedNative = await runInDurableObject(
    session.actor,
    inspectNativeAcceptedTurn.bind(null, session.sessionId, session.turnId),
  );
  expect(acceptedNative.streams).toEqual([
    {
      turn_id: session.turnId,
      state: "complete",
      last_sequence: acceptedNative.checkpoint.cursor.lastSequence - 1,
      error_detail: null,
    },
  ]);
  const acceptedUsage = completedNativeUsage(paid);
  expect(acceptedUsage.evidence.sourceRecordId).toBe(
    `finalize_${session.turnId}_${acceptedNative.checkpoint.cursor.lastSequence}`,
  );
  expect(acceptedUsage.occurredAt).toBe(
    new Date(acceptedNative.checkpoint.blob.createdAt).toISOString(),
  );
  evidence.paidTurn = { financialIntent: paid, native: acceptedNative };
  const firstSnapshot = await accountFixtureJson("snapshot", { version: 1 });
  expect(fixtureRows(firstSnapshot, "billing_funds_reservations")).toHaveLength(
    1,
  );
  expect(fixtureRows(firstSnapshot, "billing_usage_events")).toHaveLength(1);
  expect(
    fixtureRows(firstSnapshot, "billing_charge_attributions"),
  ).toHaveLength(1);
  evidence.firstFinancialSnapshot = firstSnapshot;
  evidence.stage = "content-and-finance-boundaries";
  const privateRead = await nativeAccountRequest(
    native.privateMember,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}`,
    null,
  );
  expect(privateRead.status).toBe(404);
  const ownerPrivateRead = await nativeAccountRequest(
    native.primary.owner,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}`,
    null,
  );
  expect(ownerPrivateRead.status).toBe(200);
  const ownerPrivatePayload: unknown = await ownerPrivateRead.json();
  expect(ownerPrivatePayload).toMatchObject({ conversation: null });
  expect(JSON.stringify(ownerPrivatePayload)).not.toContain(
    "Shared account turn accepted.",
  );
  const financeRead = await nativeAccountRequest(
    native.finance,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}`,
    null,
  );
  expect([403, 404]).toContain(financeRead.status);
  const foreignRead = await nativeAccountRequest(
    native.foreign.owner,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}`,
    null,
  );
  expect([403, 404]).toContain(foreignRead.status);
  const replayRead = await nativeAccountRequest(
    native.primary.owner,
    `${chatPath(native.primary.organisationId)}/stream?conversation=${conversationId}&request=shared_account_first`,
    null,
  );
  expect(replayRead.status).toBe(409);
  expect(await replayRead.json()).toMatchObject({
    ok: false,
    error: "chat_stream_unavailable",
  });
  const ownHistory = await nativeAccountRequest(
    native.operator,
    `${chatPath(native.primary.organisationId)}/stream?conversation=${conversationId}&request=shared_account_first`,
    null,
  );
  expect(ownHistory.status).toBe(200);
  const ownHistoryEvents = new TextDecoder().decode(
    await ownHistory.arrayBuffer(),
  );
  expect(ownHistoryEvents).toContain('"kind":"complete"');
  const ownConversation = await nativeAccountRequest(
    native.operator,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}&observe=true`,
    null,
  );
  expect(ownConversation.status).toBe(200);
  const ownConversationPayload: unknown = await ownConversation.json();
  expect(JSON.stringify(ownConversationPayload)).toContain(
    "Shared account turn accepted.",
  );
  const financeBinding = await resolvePantryAccountBinding(
    env,
    native.primary.organisationId,
  );
  const financeUser = await resolveLinkedPantryAccountUser(
    env,
    native.finance.identity.userId,
  );
  const account = createAccountPlatformClient(env);
  if (!financeBinding.ok || !financeUser.ok || !account.ok)
    throw new Error("Current account client unavailable");
  const financeEligibility = await account.value.checkUser({
    binding: financeBinding.value,
    user: financeUser.value,
    authority: {
      kind: "authenticated_session",
      nativeSessionId: native.finance.session.session.controlSessionId,
    },
    action: "disclose",
  });
  expect(financeEligibility).toMatchObject({ ok: false });
  const financeBody = {
    version: 1,
    instanceId: setup.primary.instanceId,
    principal: fixtureUserPrincipal(
      financeUser.value,
      native.finance.session.session.controlSessionId,
    ),
    action: "disclose",
  };
  const producerOnly = await accountProducerRequest("eligibility", financeBody);
  expect(producerOnly.status).toBe(403);
  const expiredAssertion = await expiredFixtureUserAssertion(
    financeBinding.value,
    financeUser.value,
    native.finance.session.session.controlSessionId,
  );
  const expired = await accountProducerRequest(
    "eligibility",
    financeBody,
    expiredAssertion,
  );
  expect(expired.status).toBe(403);
  const wrongScope = parsePantryAccountBinding({
    version: 1,
    instanceId: financeBinding.value.instanceId,
    scope: setup.foreign.scope,
    nativeOrganisationId: financeBinding.value.nativeOrganisationId,
    deploymentId: financeBinding.value.deploymentId,
    feePolicy: financeBinding.value.feePolicy,
  });
  if (!wrongScope.ok)
    throw new Error("Invalid deliberate foreign scope request");
  const ownerUser = await resolveLinkedPantryAccountUser(
    env,
    native.primary.owner.identity.userId,
  );
  if (!ownerUser.ok) throw new Error("Native account owner is not linked");
  const crossScope = await account.value.checkUser({
    binding: wrongScope.value,
    user: ownerUser.value,
    authority: {
      kind: "authenticated_session",
      nativeSessionId: native.primary.owner.session.session.controlSessionId,
    },
    action: "disclose",
  });
  expect(crossScope).toEqual({ ok: false, error: { code: "scope_forbidden" } });
  evidence.serviceAuthentication = {
    producerOnly: producerOnly.status,
    expiredAssertion: expired.status,
    crossScope,
  };
  evidence.access = {
    nativeOperatorPrivateRead: privateRead.status,
    unrelatedAdminPrivateRead: {
      status: ownerPrivateRead.status,
      conversation: null,
    },
    financeRead: financeRead.status,
    foreignRead: foreignRead.status,
    ownHistory: ownHistory.status,
    privateHistory: replayRead.status,
    financeEligibility,
  };
  const sourceProbe = { metadataReads: 0, bodyReads: 0 };
  await installSharedAccountSource(
    native.primary.organisationId,
    native.setup.organisations.primary.owner,
    native.setup.members.operator,
    sourceProbe,
  );
  await activateSharedAccountNativeTenant(native.primary.organisationId);
  const sourcePath = `/v1/control/organisations/${native.primary.organisationId}/projects/references?search=restricted%20account`;
  const ownerSources = await nativeAccountRequest(
    native.primary.owner,
    sourcePath,
    null,
  );
  expect(ownerSources.status).toBe(200);
  const allowedSources: unknown = await ownerSources.json();
  expect(allowedSources).toMatchObject({
    references: [
      expect.objectContaining({ label: "Restricted account supplier.pdf" }),
    ],
  });
  const peerSources = await nativeAccountRequest(
    native.operator,
    sourcePath,
    null,
  );
  expect(peerSources.status).toBe(200);
  const deniedSources: unknown = await peerSources.json();
  expect(deniedSources).toMatchObject({ references: [] });
  expect(JSON.stringify(deniedSources)).not.toContain(
    "Restricted account supplier.pdf",
  );
  expect(sourceProbe.bodyReads).toBe(0);
  evidence.sourceAccess = {
    allowedSourceCount: 1,
    deniedSourceCount: 0,
    privateLabelDisclosed: false,
    metadataReads: sourceProbe.metadataReads,
    bodyReads: sourceProbe.bodyReads,
  };
  await accountFixtureJson("fault", { version: 1, kind: "eligibility_outage" });
  const unavailable = await nativeAccountRequest(
    native.operator,
    `${chatPath(native.primary.organisationId)}?conversation=${conversationId}`,
    null,
  );
  expect(unavailable.status).toBe(503);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  evidence.eligibilityOutage = {
    status: unavailable.status,
    providerCalls: provider.requests.length,
  };
  evidence.stage = "native-unpriced-turn";
  const foreignConversation = await createSharedAccountConversation(
    native.foreign.organisationId,
    native.foreign.owner,
    foreignRoute,
    null,
  );
  const unpricedStart = await startSharedAccountTurn(
    native.foreign.organisationId,
    native.foreign.owner,
    foreignConversation,
    foreignRoute,
    "shared_account_unpriced",
  );
  expect(unpricedStart.status, await unpricedStart.text()).toBe(200);
  await expect
    .poll(
      nativeConversationWork.bind(
        null,
        native.foreign.organisationId,
        native.foreign.owner,
        foreignConversation,
      ),
      { timeout: 30000 },
    )
    .toBe("ready");
  const foreignSession = await sharedAccountSessionActor(
    native.foreign.organisationId,
    native.foreign.owner,
    foreignConversation,
  );
  const unpriced = await runInDurableObject(
    foreignSession.actor,
    inspectNativeAccountBilling.bind(null, foreignSession.turnId),
  );
  expect(unpriced).toMatchObject({
    kind: "customer_unpriced",
    phase: { kind: "recorded" },
    identity: { instanceId: setup.foreign.instanceId },
  });
  const afterUnpriced = await accountFixtureJson("snapshot", { version: 1 });
  expect(fixtureRows(afterUnpriced, "billing_funds_reservations")).toHaveLength(
    1,
  );
  expect(fixtureRows(afterUnpriced, "billing_usage_events")).toHaveLength(1);
  evidence.unpricedTurn = unpriced;
  await evictDurableObject(session.actor);
  const restored = await runInDurableObject(
    session.actor,
    inspectNativeAccountBilling.bind(null, session.turnId),
  );
  expect(restored).toEqual(paid);
  evidence.restoredPaidTurn = restored;
  evidence.stage = "duplicate-and-conflict";
  const usage = completedNativeUsage(paid);
  const duplicate = await accountProducerRequest("usage", usage);
  expect(duplicate.status).toBe(200);
  const duplicateReceipt: unknown = await duplicate.json();
  expect(duplicateReceipt).toMatchObject({
    kind: "accepted",
    value: { kind: "charged", amountMinor: 1 },
  });
  const conflicting = await accountProducerRequest("usage", {
    version: 1,
    eventId: usage.eventId,
    instanceId: usage.instanceId,
    occurredAt: usage.occurredAt,
    meterId: usage.meterId,
    quantity: 0,
    unit: "turn",
    evidence: {
      kind: "satyr_turn",
      sessionId: usage.evidence.sessionId,
      turnId: usage.evidence.turnId,
      terminalOutcome: "cancelled",
      reservationId: usage.evidence.reservationId,
      sourceRecordId: usage.evidence.sourceRecordId,
      sourceDigest: usage.evidence.sourceDigest,
      funding: usage.evidence.funding,
    },
  });
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({
    kind: "rejected",
    error: { code: "event_conflict" },
  });
  await accountFixtureJson("fault", { version: 1, kind: "lose_reserve_reply" });
  const reserveRequest = {
    version: 1,
    operationId: JSON.stringify([
      "satyr",
      usage.instanceId,
      usage.evidence.sessionId,
      usage.evidence.turnId,
      "reserve",
    ]),
    instanceId: usage.instanceId,
    executionId: JSON.stringify([
      usage.evidence.sessionId,
      usage.evidence.turnId,
    ]),
    requestedMinor: 1,
    priceVersion: "satyr-completed-turn-test-v1",
  };
  const lostReserve = await accountProducerRequest(
    "funds/reserve",
    reserveRequest,
  );
  expect(lostReserve.status).toBe(503);
  const reserveReplay = await accountProducerRequest(
    "funds/reserve",
    reserveRequest,
  );
  expect(reserveReplay.status).toBe(200);
  evidence.idempotence = {
    duplicateReceipt,
    conflictStatus: conflicting.status,
    lostReserveStatus: lostReserve.status,
    reserveReplay: await reserveReplay.json(),
  };

  evidence.stage = "customer-funded-lost-usage-reply";
  const customerRoute = await selectSharedAccountModelRoute(
    native.primary.organisationId,
    native.primary.owner,
    "organisation_openai_api_key",
  );
  await activateSharedAccountNativeTenant(native.primary.organisationId);
  const customerProvider: ProviderFixture = {
    requests: [],
    gate: { kind: "immediate" },
  };
  network.use(
    http.post(
      "https://api.openai.com/v1/responses",
      customerReply.bind(null, customerProvider),
    ),
  );
  const customerConversation = await createSharedAccountConversation(
    native.primary.organisationId,
    native.operator,
    customerRoute,
    null,
  );
  await accountFixtureJson("fault", { version: 1, kind: "lose_usage_reply" });
  const customerStart = await startSharedAccountTurn(
    native.primary.organisationId,
    native.operator,
    customerConversation,
    customerRoute,
    "shared_account_customer",
  );
  expect(customerStart.status, await customerStart.text()).toBe(200);
  await expect
    .poll(
      nativeConversationWork.bind(
        null,
        native.primary.organisationId,
        native.operator,
        customerConversation,
      ),
      { timeout: 30000 },
    )
    .toBe("ready");
  const customerSession = await sharedAccountSessionActor(
    native.primary.organisationId,
    native.operator,
    customerConversation,
  );
  const lostReplyIntent = await runInDurableObject(
    customerSession.actor,
    inspectNativeAccountBilling.bind(null, customerSession.turnId),
  );
  expect(lostReplyIntent).toMatchObject({
    kind: "isolated_e2e_completed_turn",
    identity: {
      funding: { kind: "customer", selection: "organisation_openai_api_key" },
    },
  });
  const afterLostReply = await accountFixtureJson("snapshot", { version: 1 });
  expect(fixtureRows(afterLostReply, "billing_usage_events")).toHaveLength(2);
  expect(
    fixtureRows(afterLostReply, "billing_funds_reservations"),
  ).toHaveLength(2);
  await evictDurableObject(customerSession.actor);
  await runDurableObjectAlarm(customerSession.actor);
  const customerPaid = await runInDurableObject(
    customerSession.actor,
    inspectNativeAccountBilling.bind(null, customerSession.turnId),
  );
  expect(customerPaid).toMatchObject({
    phase: { kind: "delivered", receipt: { kind: "charged", amountMinor: 1 } },
  });
  const afterReplay = await accountFixtureJson("snapshot", { version: 1 });
  expect(fixtureRows(afterReplay, "billing_usage_events")).toHaveLength(2);
  expect(fixtureRows(afterReplay, "billing_funds_reservations")).toHaveLength(
    2,
  );
  expect(customerProvider.requests).toHaveLength(1);
  evidence.customerFunding = {
    native: await runInDurableObject(
      customerSession.actor,
      inspectNativeAcceptedTurn.bind(
        null,
        customerSession.sessionId,
        customerSession.turnId,
      ),
    ),
    financialIntent: customerPaid,
    beforeReplay: lostReplyIntent,
    afterLostReply,
    afterReplay,
    providerCalls: customerProvider.requests.length,
  };

  evidence.stage = "settlement-after-member-removal";
  await accountFixtureJson("fault", { version: 1, kind: "usage_outage" });
  const removalConversation = await createSharedAccountConversation(
    native.primary.organisationId,
    native.operator,
    customerRoute,
    null,
  );
  const removalStart = await startSharedAccountTurn(
    native.primary.organisationId,
    native.operator,
    removalConversation,
    customerRoute,
    "shared_account_removed_initiator",
  );
  expect(removalStart.status, await removalStart.text()).toBe(200);
  await expect
    .poll(
      nativeConversationWork.bind(
        null,
        native.primary.organisationId,
        native.operator,
        removalConversation,
      ),
      { timeout: 30000 },
    )
    .toBe("ready");
  const removalSession = await sharedAccountSessionActor(
    native.primary.organisationId,
    native.operator,
    removalConversation,
  );
  const pendingSettlement = await runInDurableObject(
    removalSession.actor,
    inspectNativeAccountBilling.bind(null, removalSession.turnId),
  );
  expect(pendingSettlement).toMatchObject({
    phase: { kind: "terminal_pending", terminal: { kind: "completed" } },
  });
  await accountFixtureJson("mutate", {
    version: 1,
    kind: "remove_member",
    organisation: "primary",
    membershipId: setup.operator.membershipId,
  });
  const removedRead = await nativeAccountRequest(
    native.operator,
    `${chatPath(native.primary.organisationId)}?conversation=${removalConversation}`,
    null,
  );
  expect(removedRead.status).toBe(404);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  await evictDurableObject(removalSession.actor);
  await runDurableObjectAlarm(removalSession.actor);
  const removedSettled = await runInDurableObject(
    removalSession.actor,
    inspectNativeAccountBilling.bind(null, removalSession.turnId),
  );
  expect(removedSettled).toMatchObject({
    phase: { kind: "delivered", receipt: { kind: "charged", amountMinor: 1 } },
  });
  evidence.removedInitiator = {
    pendingSettlement,
    deniedRead: removedRead.status,
    settled: removedSettled,
    native: await runInDurableObject(
      removalSession.actor,
      inspectNativeAcceptedTurn.bind(
        null,
        removalSession.sessionId,
        removalSession.turnId,
      ),
    ),
  };
  const invitationBase = `/v1/control/organisations/${native.primary.organisationId}/invitations`;
  const invitationIssued = await nativeAccountRequest(
    native.primary.owner,
    invitationBase,
    { email: native.operator.identity.email, role: "admin" },
  );
  expect(invitationIssued.status).toBe(201);
  const nativeInvitation = readSharedNativePortalInvitation(
    await invitationIssued.json(),
  );
  const acceptPath = `${invitationBase}/${nativeInvitation.invitationId}/accept`;
  const acceptedInvitation = await nativeAccountRequest(
    native.operator,
    acceptPath,
    { token: nativeInvitation.token },
  );
  expect(
    acceptedInvitation.status,
    await acceptedInvitation.clone().text(),
  ).toBe(200);
  expect(await acceptedInvitation.json()).toMatchObject({
    ok: true,
    member: { userId: native.operator.identity.userId, role: "admin" },
  });
  const acceptedGrant = await readNativeServiceGrant(
    native.primary.organisationId,
    native.operator,
  );
  expect(acceptedGrant).toMatchObject({
    role: "admin",
    status: "active",
    accountAcceptanceReceiptId: nativeInvitation.invitationId,
  });
  if (typeof acceptedGrant.platformMembershipId !== "string")
    throw new Error(
      "Native grant omitted its actual shared membership identity",
    );
  const rejoined = { membershipId: acceptedGrant.platformMembershipId };
  const oldProjectAfterRejoin = await nativeAccountRequest(
    native.operator,
    `${projectBase}/${sharedWorkProjectId}/access`,
    null,
  );
  const nativeProjectGrants = await fixtureDatabase()
    .prepare(
      "SELECT project_id, user_id, role FROM project_member WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(native.primary.organisationId, native.operator.identity.userId)
    .all();
  const nativeAccountRevision = await fixtureDatabase()
    .prepare(
      "SELECT access_revision, cleanup_pending FROM account_service_access_revision WHERE native_organisation_id = ? AND native_user_id = ?",
    )
    .bind(native.primary.organisationId, native.operator.identity.userId)
    .all();
  evidence.rejoinDiagnostics = {
    nativeProjectGrants: nativeProjectGrants.results,
    nativeAccountRevision: nativeAccountRevision.results,
    account: await accountFixtureJson("snapshot", { version: 1 }),
  };
  expect(oldProjectAfterRejoin.status).toBe(404);
  evidence.rejoin = {
    membershipId: rejoined.membershipId,
    oldProjectAccess: oldProjectAfterRejoin.status,
  };
  const roleChanged = await nativeServiceMemberMutation(
    native.primary.organisationId,
    native.primary.owner,
    native.operator,
    "PATCH",
    { role: "operator" },
  );
  expect(roleChanged.status, await roleChanged.clone().text()).toBe(200);
  const replayAfterRoleChange = await nativeAccountRequest(
    native.operator,
    acceptPath,
    { token: nativeInvitation.token },
  );
  expect(replayAfterRoleChange.status).toBe(200);
  expect(await replayAfterRoleChange.json()).toMatchObject({
    ok: true,
    member: { role: "operator" },
  });
  const changedGrant = await readNativeServiceGrant(
    native.primary.organisationId,
    native.operator,
  );
  expect(changedGrant).toMatchObject({ role: "operator", status: "active" });
  const revokedNativeMember = await nativeServiceMemberMutation(
    native.primary.organisationId,
    native.primary.owner,
    native.operator,
    "DELETE",
    {},
  );
  expect(
    revokedNativeMember.status,
    await revokedNativeMember.clone().text(),
  ).toBe(200);
  const replayAfterRevoke = await nativeAccountRequest(
    native.operator,
    acceptPath,
    { token: nativeInvitation.token },
  );
  expect(replayAfterRevoke.status).toBe(403);
  const revokedGrant = await readNativeServiceGrant(
    native.primary.organisationId,
    native.operator,
  );
  expect(revokedGrant).toMatchObject({ role: "operator", status: "revoked" });
  evidence.nativeInvitationReplay = {
    invitationId: nativeInvitation.invitationId,
    acceptedGrant,
    changedGrant,
    replayAfterRoleChange: replayAfterRoleChange.status,
    revokeStatus: revokedNativeMember.status,
    replayAfterRevoke: replayAfterRevoke.status,
    revokedGrant,
  };
  evidence.stage = "uncertain-provider-interruption";
  const gate = Promise.withResolvers<void>();
  customerProvider.gate = { kind: "held", resume: gate };
  const uncertainConversation = await createSharedAccountConversation(
    native.primary.organisationId,
    native.primary.owner,
    customerRoute,
    null,
  );
  const uncertainStart = await startSharedAccountTurn(
    native.primary.organisationId,
    native.primary.owner,
    uncertainConversation,
    customerRoute,
    "shared_account_uncertain",
  );
  expect(uncertainStart.status).toBe(200);
  const uncertainResponse = uncertainStart.text().catch(ignoreAbortedResponse);
  try {
    await expect
      .poll(providerCalls.bind(null, customerProvider), { timeout: 15000 })
      .toBe(3);
    const uncertainSession = await sharedAccountSessionActor(
      native.primary.organisationId,
      native.primary.owner,
      uncertainConversation,
    );
    const dispatched = await runInDurableObject(
      uncertainSession.actor,
      inspectNativeAccountBilling.bind(null, uncertainSession.turnId),
    );
    expect(dispatched).toMatchObject({
      kind: "isolated_e2e_completed_turn",
      phase: { kind: "dispatched" },
    });
    if (
      dispatched === null ||
      dispatched.kind !== "isolated_e2e_completed_turn" ||
      dispatched.phase.kind !== "dispatched"
    )
      throw new Error("Native dispatched financial intent missing");
    const beforeAbort = await account.value.getReservation(
      dispatched.phase.hold.reservationId,
    );
    expect(beforeAbort).toMatchObject({
      ok: true,
      value: { kind: "reserved", requestedMinor: 1 },
    });
    await expect(
      runInDurableObject(uncertainSession.actor, abortSharedAccountActor),
    ).rejects.toThrow();
    const restartedSession = await sharedAccountSessionActor(
      native.primary.organisationId,
      native.primary.owner,
      uncertainConversation,
    );
    expect(restartedSession.sessionId).toBe(uncertainSession.sessionId);
    const retained = await runInDurableObject(
      restartedSession.actor,
      inspectNativeAccountBilling.bind(null, uncertainSession.turnId),
    );
    expect(retained).toMatchObject({ phase: { kind: "indeterminate" } });
    const retainedHold = await account.value.getReservation(
      dispatched.phase.hold.reservationId,
    );
    expect(retainedHold).toMatchObject({
      ok: true,
      value: { kind: "indeterminate", requestedMinor: 1 },
    });
    const beforeCancellation = await accountFixtureJson("snapshot", {
      version: 1,
    });
    expect(
      fixtureRows(beforeCancellation, "billing_funds_reservations"),
    ).toHaveLength(4);
    expect(
      fixtureRows(beforeCancellation, "billing_usage_events"),
    ).toHaveLength(3);
    evidence.uncertainty = {
      dispatched,
      retained,
      retainedHold,
      beforeCancellation,
      proof: "No accepted completion or cancellation exists.",
    };
    const cancellationId = parseRequestId("shared_account_cancel");
    if (!cancellationId.ok) throw new Error(cancellationId.error.code);
    const cancelled =
      await restartedSession.actor.interruptCanonicalEmbeddedHarnessTurn({
        requestId: cancellationId.value,
        organisationId: native.primary.organisationId,
        sessionId: uncertainSession.sessionId,
        interruptedAt: Date.now(),
      });
    expect(cancelled).toMatchObject({ ok: true });
    await runDurableObjectAlarm(restartedSession.actor);
    const released = await runInDurableObject(
      restartedSession.actor,
      inspectNativeAccountBilling.bind(null, uncertainSession.turnId),
    );
    expect(released).toMatchObject({
      phase: {
        kind: "delivered",
        terminal: { kind: "cancelled" },
        receipt: {
          kind: "recorded_without_charge",
          reason: "nonbillable_outcome",
        },
      },
    });
    const releasedHold = await account.value.getReservation(
      dispatched.phase.hold.reservationId,
    );
    expect(releasedHold).toMatchObject({
      ok: true,
      value: { kind: "released" },
    });
    evidence.cancellationProof = { cancelled, released, releasedHold };
  } finally {
    customerProvider.gate = { kind: "immediate" };
    gate.resolve();
    await uncertainResponse;
  }

  evidence.stage = "fee-policy-dispatch-failure";
  await accountFixtureJson("fault", { version: 1, kind: "fee_policy_outage" });
  const feeFailureConversation = await createSharedAccountConversation(
    native.primary.organisationId,
    native.primary.owner,
    customerRoute,
    null,
  );
  const callsBeforeFeeFailure = customerProvider.requests.length;
  const feeFailure = await startSharedAccountTurn(
    native.primary.organisationId,
    native.primary.owner,
    feeFailureConversation,
    customerRoute,
    "shared_account_fee_unavailable",
  );
  expect(feeFailure.status).toBe(200);
  await expect
    .poll(
      nativeConversationWork.bind(
        null,
        native.primary.organisationId,
        native.primary.owner,
        feeFailureConversation,
      ),
      { timeout: 30000 },
    )
    .toBe("failed");
  expect(customerProvider.requests).toHaveLength(callsBeforeFeeFailure);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  evidence.feePolicyFailure = {
    status: feeFailure.status,
    work: "failed",
    providerCallsBefore: callsBeforeFeeFailure,
    providerCallsAfter: customerProvider.requests.length,
  };

  evidence.stage = "service-disable-wallet-active";
  const disable = await accountFixtureJson("mutate", {
    version: 1,
    kind: "request_service_disable",
    organisation: "primary",
    instanceId: setup.primary.instanceId,
  });
  const disabled = await applyAccountFixtureProvision(
    readPantryProvisionEnvelope(disable.provisionEnvelope),
  );
  expect(disabled.receipt.result).toBe("disabled");
  const disabledStatus = await nativeProvisionRequest("status", {
    version: 1,
    instanceId: setup.primary.instanceId,
  });
  expect(await disabledStatus.json()).toMatchObject({
    kind: "accepted",
    value: {
      accountState: "disabled",
      nativeOperationalReadiness: { kind: "active" },
    },
  });
  const disabledRead = await nativeAccountRequest(
    native.primary.owner,
    `${chatPath(native.primary.organisationId)}?conversation=${uncertainConversation}`,
    null,
  );
  expect(disabledRead.status).toBe(404);
  const walletUsage = await accountFixtureJson("mutate", {
    version: 1,
    kind: "wallet_usage",
    organisation: "primary",
    occurredAt: new Date().toISOString(),
  });
  evidence.serviceDisable = {
    disabled,
    disabledRead: disabledRead.status,
    walletUsage,
  };
  const finalSnapshot = await accountFixtureJson("snapshot", { version: 1 });
  expect(fixtureRows(finalSnapshot, "billing_usage_events")).toHaveLength(5);
  expect(fixtureRows(finalSnapshot, "billing_funds_reservations")).toHaveLength(
    4,
  );
  const reservations = fixtureRows(finalSnapshot, "billing_funds_reservations");
  expect(reservations.filter(settledReservation)).toHaveLength(3);
  expect(reservations.filter(releasedReservation)).toHaveLength(1);
  const instances = fixtureRows(finalSnapshot, "platform_service_instances");
  expect(finalSnapshot.charges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        attribution: expect.objectContaining({
          serviceId: "wallet",
          scope: expect.objectContaining({
            projectId: "project_shared_account_wallet",
          }),
        }),
      }),
      expect.objectContaining({
        attribution: expect.objectContaining({
          serviceId: "satyr",
          scope: expect.objectContaining({
            projectId: setup.primary.scope.projectId,
          }),
        }),
      }),
    ]),
  );
  expect(
    instances.find(instanceWithId.bind(null, setup.primary.walletInstanceId)),
  ).toMatchObject({
    phase: "active",
    desired_state: "enabled",
    observed_state: "active",
  });
  expect(
    instances.find(instanceWithId.bind(null, setup.primary.instanceId)),
  ).toMatchObject({
    phase: "disabled",
    desired_state: "disabled",
    observed_state: "disabled",
  });
  expect(finalSnapshot.overview).toMatchObject({
    reservedMinor: 0,
    activeReservationCount: 0,
    pendingRefundMinor: 0,
  });
  const postedUsageMinor = sumPostedUsage(finalSnapshot.charges);
  expect(finalSnapshot.overview).toMatchObject({
    creditBalanceMinor: 2000 - postedUsageMinor,
    availableBalanceMinor: 2000 - postedUsageMinor,
  });
  const ledger = balancedLedgerEntries(finalSnapshot);
  evidence.reconciliation = {
    postedUsageMinor,
    balancedLedgerEntryCount: ledger.size,
    settledReservations: 3,
    releasedReservations: 1,
    activeReservations: 0,
  };
  evidence.finalFinancialSnapshot = finalSnapshot;
  const documentResponse = await accountFixtureRequest("statement", {
    version: 1,
    organisation: "primary",
    periodMonthUtc: new Date().toISOString().slice(0, 7),
    format: "json",
  });
  expect(documentResponse.status).toBe(200);
  const statement: unknown = await documentResponse.json();
  if (!isRecord(statement)) throw new Error("Invalid account statement");
  if (!isRecord(statement.document) || !isRecord(statement.document.invoice))
    throw new Error("Consolidated statement missing invoice");
  expect(statement.document.invoice.amountDueMinor).toBe(postedUsageMinor);
  evidence.statement = statement;
  const pdfResponse = await accountFixtureRequest("statement", {
    version: 1,
    organisation: "primary",
    periodMonthUtc: new Date().toISOString().slice(0, 7),
    format: "pdf",
  });
  expect(pdfResponse.status).toBe(200);
  expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
  const pdf = new Uint8Array(await pdfResponse.arrayBuffer());
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  evidence.statementPdf = {
    mediaType: "application/pdf",
    bytes: pdf.byteLength,
    base64: encodeBase64(pdf),
  };
  evidence.stage = "complete-financial-journey";
}

async function platformReply(
  provider: ProviderFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model provider request");
  provider.requests.push(body);
  const gate = provider.gate;
  if (gate.kind === "held") await gate.resume.promise;
  return openRouterText(
    JSON.stringify({ kind: "reply", text: "Shared account turn accepted." }),
    `shared-account-${provider.requests.length}`,
  );
}

async function customerReply(
  provider: ProviderFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  expect(
    request.headers.get("authorization") ===
      "Bearer sk-project-shared-account-acceptance-1234567890",
  ).toBe(true);
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid customer-funded model request");
  provider.requests.push(body);
  const gate = provider.gate;
  if (gate.kind === "held") await gate.resume.promise;
  const text = JSON.stringify({
    kind: "reply",
    text: "Customer-funded shared account turn accepted.",
  });
  const message = {
    type: "message",
    id: `msg_account_${provider.requests.length}`,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      response: {
        id: `resp_account_${provider.requests.length}`,
        model: body.model,
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: message.id,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_account_${provider.requests.length}`,
        model: body.model,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return new HttpResponse(events.map(accountSseEvent).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function accountSseEvent(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function providerCalls(provider: ProviderFixture): number {
  return provider.requests.length;
}

function ignoreAbortedResponse(): string {
  return "Native response interrupted.";
}

function settledReservation(row: Record<string, unknown>): boolean {
  return row.status === "settled";
}

function releasedReservation(row: Record<string, unknown>): boolean {
  return row.status === "released";
}

function instanceWithId(
  instanceId: string,
  row: Record<string, unknown>,
): boolean {
  return row.id === instanceId;
}

function sumPostedUsage(charges: unknown): number {
  if (!Array.isArray(charges)) throw new Error("Shared cost breakdown missing");
  let total = 0;
  for (const charge of charges) {
    if (
      !isRecord(charge) ||
      typeof charge.amountMinor !== "number" ||
      !Number.isSafeInteger(charge.amountMinor)
    )
      throw new Error("Invalid posted usage cost");
    total += charge.amountMinor;
  }
  return total;
}

function balancedLedgerEntries(
  snapshot: Record<string, unknown>,
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const posting of fixtureRows(snapshot, "billing_ledger_postings")) {
    if (
      typeof posting.ledger_entry_id !== "string" ||
      typeof posting.amount_minor !== "number" ||
      !Number.isSafeInteger(posting.amount_minor) ||
      (posting.direction !== "DEBIT" && posting.direction !== "CREDIT")
    )
      throw new Error("Invalid ledger posting");
    const previous = balances.get(posting.ledger_entry_id) ?? 0;
    balances.set(
      posting.ledger_entry_id,
      previous +
        (posting.direction === "DEBIT"
          ? posting.amount_minor
          : -posting.amount_minor),
    );
  }
  for (const [ledgerEntryId, balance] of balances)
    expect(balance, `Ledger entry ${ledgerEntryId} must balance.`).toBe(0);
  return balances;
}

/** Contract classes cross the test runner's IPC boundary as their JSON wire values. */
function storeSharedAccountEvidence(
  context: TestContext,
  evidence: Record<string, unknown>,
): void {
  const serialized: unknown = JSON.parse(JSON.stringify(evidence));
  Object.assign(context.task.meta, { sharedAccountPlatform: serialized });
}
