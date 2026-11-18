/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  resolveControlSession: vi.fn(),
  validateControlCsrf: vi.fn(),
  resolveUser: vi.fn(),
  readActiveOrganisationMembershipRevision: vi.fn(),
}));
const accountMocks = vi.hoisted(() => ({
  listIntegrationAccounts: vi.fn(),
}));
const actorMocks = vi.hoisted(() => ({
  requireActiveOrganisationActor: vi.fn(),
  resolveActiveCaseActorAtPlacement: vi.fn(),
  resolveActiveConnectorActorAtPlacement: vi.fn(),
}));
const commerceSystemMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceSystem: vi.fn(),
  resolveOrganisationCommerceSystemAuthority: vi.fn(),
}));
const mutationMocks = vi.hoisted(() => ({
  readControlMutationReplay: vi.fn(),
  prepareControlMutationReceipt: vi.fn(),
}));
const onboardingMocks = vi.hoisted(() => ({
  buildOnboardingProjection: vi.fn(),
}));
const capabilityMocks = vi.hoisted(() => ({
  admitCommerceCapability: vi.fn(),
}));
const providerExecutionMocks = vi.hoisted(() => ({
  reconcileCommerceProviderAction: vi.fn(),
}));
const turnAuthorityMocks = vi.hoisted(() => ({
  authorizeCapabilityUse: vi.fn(),
}));
const turnContextMocks = vi.hoisted(() => ({
  prepareTurnAuthority: vi.fn(),
}));
const modelRouteMocks = vi.hoisted(() => ({
  resolveOrganisationModelRoute: vi.fn(),
}));
const policyMocks = vi.hoisted(() => ({
  loadOrganisationPolicyOrDefaultDeny: vi.fn(),
}));
const slackRoutingMocks = vi.hoisted(() => ({
  resolveActiveSlackDestinationConnection: vi.fn(),
}));

vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
  resolveUser: controlMocks.resolveUser,
  readActiveOrganisationMembershipRevision:
    controlMocks.readActiveOrganisationMembershipRevision,
}));
vi.mock("../src/data/integration-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/integration-account")>()),
  listIntegrationAccounts: accountMocks.listIntegrationAccounts,
}));
vi.mock("../src/projects/case-project", () => ({
  ensureCaseProject: vi.fn(async () => ({
    ok: true,
    value: {
      organisationId: "organisation_fixture",
      caseId: "case_fixture",
      projectId: "project_00000000-0000-4000-8000-000000000000",
      revision: 1,
    },
  })),
}));
vi.mock("../src/actors/actor-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/actor-router")>()),
  requireActiveOrganisationActor: actorMocks.requireActiveOrganisationActor,
  requireActiveOrganisationActorAtScope:
    actorMocks.requireActiveOrganisationActor,
  resolveActiveCaseActorAtPlacement: actorMocks.resolveActiveCaseActorAtPlacement,
  resolveActiveCaseActor: actorMocks.resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActorAtPlacement: actorMocks.resolveActiveConnectorActorAtPlacement,
}));
vi.mock("../src/data/organisation-commerce-system", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/organisation-commerce-system")
  >()),
  resolveOrganisationCommerceSystem: commerceSystemMocks.resolveOrganisationCommerceSystem,
  resolveOrganisationCommerceSystemAuthority:
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority,
}));
vi.mock("../src/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-mutation")>()),
  readControlMutationReplay: mutationMocks.readControlMutationReplay,
  prepareControlMutationReceipt: mutationMocks.prepareControlMutationReceipt,
  prepareOrganisationControlMutationReceipt: mutationMocks.prepareControlMutationReceipt,
}));
vi.mock("../src/data/onboarding-projection", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/onboarding-projection")
  >()),
  buildOnboardingProjection: onboardingMocks.buildOnboardingProjection,
}));
vi.mock(
  "../src/data/commerce-capability-activation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/data/commerce-capability-activation")
    >()),
    admitCommerceCapability: capabilityMocks.admitCommerceCapability,
  }),
);
vi.mock("../src/commerce/provider-execution", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/commerce/provider-execution")
  >()),
  reconcileCommerceProviderAction:
    providerExecutionMocks.reconcileCommerceProviderAction,
}));
vi.mock(
  "../src/authorization/access-grants/turn-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/authorization/access-grants/turn-authority")
    >()),
    authorizeCapabilityUse: turnAuthorityMocks.authorizeCapabilityUse,
  }),
);
vi.mock("../src/context/turn-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/turn-context")>()),
  prepareTurnAuthority: turnContextMocks.prepareTurnAuthority,
}));
vi.mock("../src/models/route", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models/route")>()),
  resolveOrganisationModelRoute: modelRouteMocks.resolveOrganisationModelRoute,
}));
vi.mock("../src/policy-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policy-snapshot")>()),
  loadOrganisationPolicyOrDefaultDeny: policyMocks.loadOrganisationPolicyOrDefaultDeny,
}));
vi.mock("../src/slack/organisation-routing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/slack/organisation-routing")
  >()),
  resolveActiveSlackDestinationConnection:
    slackRoutingMocks.resolveActiveSlackDestinationConnection,
}));

import { handleControlRequest } from "../src/control-router";
import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "../src/commerce-lab/lab-metadata";
import { parseOrganisationId } from "../src/ids";
import { fixtureFlowBinding } from "./fixtures/plan25-turn";
import { isRecord } from "@seams/std";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_commerce_console";
const OTHER_ORGANISATION_ID = "organisation_commerce_other";
const INTEGRATION_ACCOUNT_ID = COMMERCE_LAB_INTEGRATION_ACCOUNT_ID;
const COMMERCE_INTEGRATION_ACCOUNT_ID = "integration_underclerk_console";
const COMMERCE_BINDING_ID = "underclerk_binding_console";
const COMMERCE_MERCHANT_ID = "merchant_console";
const OBSERVED_AT = "2026-07-26T00:00:00.000Z";

describe("commerce action approval route", () => {
  it("returns a typed step-up error before touching the action actor for an old session", async () => {
    const now = Date.now();
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok) throw new Error("organisation fixture is invalid");
    controlMocks.resolveControlSession.mockResolvedValue({
      ok: true,
      value: {
        kind: "active",
        controlSessionId: "control_session_console",
        userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
        rotationGeneration: 1,
        createdAt: now - 11 * 60 * 1000,
        rotatedAt: now - 11 * 60 * 1000,
        expiresAt: now + 60_000,
      },
    });
    controlMocks.validateControlCsrf.mockResolvedValue({
      ok: true,
      value: true,
    });
    controlMocks.authorizeOrganisationControl.mockResolvedValue({
      ok: true,
      value: {
        session: undefined,
        membership: {
          kind: "active",
          organisationId: organisationId.value,
          userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
          personId: "person_console",
          role: "owner",
          createdAt: now - 60 * 60 * 1000,
        },
      },
    });
    controlMocks.resolveUser.mockResolvedValue({
      userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
      issuer: "https://accounts.google.com",
      subject: "google-console",
      email: "console@example.com",
      displayName: "Console Owner",
      emailVerified: true,
      createdAt: now - 60 * 60 * 1000,
      lastAuthenticatedAt: now - 11 * 60 * 1000,
    });
    actorMocks.requireActiveOrganisationActor.mockClear();

    const response = await handleControlRequest(
      new Request(
        `https://satyr.example/v1/control/organisations/${ORGANISATION_ID}/commerce/actions/00000000-0000-4000-8000-000000000001/approval`,
        {
          method: "POST",
          headers: {
            origin: "https://satyr.example",
            cookie:
              "satyr_control_session=session-console; satyr_control_csrf=csrf-console",
            "x-satyr-csrf": "csrf-console",
            "idempotency-key": "commerce-approval-old-session",
          },
          body: "{}",
        },
      ),
      approvalRouteEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "approval_step_up_required",
    });
    expect(actorMocks.requireActiveOrganisationActor).not.toHaveBeenCalled();
  });
});

describe("commerce capability admission", () => {
  it("holds a new governed effect until its capability is admitted", async () => {
    const fixture = configurePendingDescriptionAction("signed");
    capabilityMocks.admitCommerceCapability.mockResolvedValueOnce({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });

    const held = await handleControlRequest(
      descriptionExecutionRequest(),
      fixture.env,
    );

    expect(held.status).toBe(409);
    await expect(held.json()).resolves.toEqual({
      ok: false,
      error: "commerce_action_capability_inactive",
    });
    expect(capabilityMocks.admitCommerceCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: ORGANISATION_ID,
        capability: "core",
        scope: { kind: "organisation" },
      }),
    );
    expect(fixture.beginExecution).not.toHaveBeenCalled();

    capabilityMocks.admitCommerceCapability.mockResolvedValueOnce({
      ok: true,
      value: { kind: "implicit" },
    });
    const admitted = await handleControlRequest(
      descriptionExecutionRequest(),
      fixture.env,
    );

    expect(admitted.status).toBe(409);
    await expect(admitted.json()).resolves.toEqual({
      ok: false,
      error: "resource_busy",
    });
    expect(fixture.beginExecution).toHaveBeenCalledOnce();
  });

  it("reconciles an indeterminate effect without capability admission", async () => {
    const fixture = configurePendingDescriptionAction("indeterminate");
    capabilityMocks.admitCommerceCapability.mockResolvedValue({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });
    providerExecutionMocks.reconcileCommerceProviderAction.mockResolvedValue({
      ok: true,
      value: { kind: "unresolved" },
    });

    const response = await handleControlRequest(
      descriptionExecutionRequest(),
      fixture.env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "commerce_action_reconciliation_pending",
    });
    expect(
      providerExecutionMocks.reconcileCommerceProviderAction,
    ).toHaveBeenCalledOnce();
    expect(capabilityMocks.admitCommerceCapability).not.toHaveBeenCalled();
    expect(fixture.beginExecution).not.toHaveBeenCalled();
  });

  it("holds an approved list patch until core commerce is admitted", async () => {
    const fixture = configureConfirmedDescriptionAction();
    capabilityMocks.admitCommerceCapability.mockReset();
    capabilityMocks.admitCommerceCapability.mockResolvedValue({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });
    const beginExecution = vi.fn();
    actorMocks.requireActiveOrganisationActor.mockResolvedValue({
      getAction: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...fixture.entry,
          state: "signed",
          providerResult: null,
          action: {
            ...fixture.entry.action,
            verb: "commerce.list_entry.patch",
            path: "/list-entries/entry_menu/patch?list_id=list_menu&expected_revision=1&expected_list_revision=1",
          },
        },
      }),
      beginActionExecution: beginExecution,
    });
    const readProposal = vi.fn().mockResolvedValue({
      ok: true,
      value: { caseId: fixture.entry.caseId },
    });
    actorMocks.resolveActiveCaseActorAtPlacement.mockResolvedValue({
      ok: true,
      value: { readAcceptedCommerceEntityPlaneProposal: readProposal },
    });

    const response = await handleControlRequest(
      descriptionExecutionRequest(),
      fixture.env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "commerce_action_capability_inactive",
    });
    expect(capabilityMocks.admitCommerceCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: ORGANISATION_ID,
        capability: "core",
        scope: { kind: "organisation" },
      }),
    );
    expect(readProposal).toHaveBeenCalledOnce();
    expect(beginExecution).not.toHaveBeenCalled();
  });
});

function configureConfirmedDescriptionAction() {
  const configured = configureCommerceControlSession();
  const nonce = "00000000-0000-4000-8000-000000000040";
  const requestAuthority = {
    kind: "control" as const,
    organisationId: ORGANISATION_ID,
    requesterPersonId: "person_console",
    userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
    membershipRevision: 1,
    role: "owner",
  };
  const authorityPartition = { digest: "b".repeat(64) };
  const receipt = {
    kind: "commerce_provider_receipt" as const,
    provider: "underclerk" as const,
    receiptId: "receipt_description_confirmed",
    effectId: "effect_description_confirmed",
    actionNonce: nonce,
    flowBindingDigest: "a".repeat(64),
    decisionDigest: "b".repeat(64),
    eventId: "delivery_description_confirmed",
    resourceId: "product_ginger_cookie",
    projectionKind: "product" as const,
    revision: 2,
    status: "accepted" as const,
    merchantId: COMMERCE_MERCHANT_ID,
    merchantRevision: 94,
    observedAt: OBSERVED_AT,
  };
  const entry = {
    state: "confirmed" as const,
    caseId: "case_description_confirmed",
    proposalId: "proposal_description_confirmed",
    providerResult: JSON.stringify(receipt),
    action: {
      organisationId: ORGANISATION_ID,
      integrationAccountId: COMMERCE_INTEGRATION_ACCOUNT_ID,
      nonce: { value: nonce },
      verb: "commerce.catalog.update_description",
      path: "/catalog/product_ginger_cookie/description?expected_revision=1&description=Reviewed",
      resourceKey: "product:product_ginger_cookie",
      amount: null,
      authority: {
        kind: "commerce_system" as const,
        system: "satyr_commerce" as const,
        revision: 1,
      },
      requestAuthority,
      authorityPartition,
    },
  };
  const beginExecution = vi.fn();
  actorMocks.requireActiveOrganisationActor.mockResolvedValue({
    getAction: vi.fn().mockResolvedValue({ ok: true, value: entry }),
    beginActionExecution: beginExecution,
  });
  const acceptOutcome = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      revision: 4,
      output: {
        kind: "pending",
        output: {
          connectorId: "connector_slack_console",
          flowBinding: fixtureFlowBinding({
            organisationId: ORGANISATION_ID,
            sessionId: "control_session_console",
            authorityPartitionDigest: authorityPartition.digest,
          }),
          delivery: {
            address: {
              kind: "slack_channel",
              workspaceId: "workspace_console",
              channelId: "channel_console",
            },
          },
        },
      },
    },
  });
  actorMocks.resolveActiveCaseActorAtPlacement.mockResolvedValue({
    ok: true,
    value: { acceptCommerceOutcome: acceptOutcome },
  });
  actorMocks.resolveActiveConnectorActorAtPlacement.mockReset();
  turnContextMocks.prepareTurnAuthority.mockResolvedValue({
    ok: true,
    value: { requestAuthority, authorityPartition },
  });
  return {
    env: platformEnv({
      ...configured.env,
      EVENT_Q: { send: vi.fn().mockResolvedValue(undefined) },
    }),
    entry,
  };
}

function configurePendingDescriptionAction(state: "signed" | "indeterminate") {
  const fixture = configureConfirmedDescriptionAction();
  capabilityMocks.admitCommerceCapability.mockReset();
  providerExecutionMocks.reconcileCommerceProviderAction.mockReset();
  const beginExecution = vi.fn().mockResolvedValue({
    ok: false,
    error: { code: "resource_busy" },
  });
  actorMocks.requireActiveOrganisationActor.mockResolvedValue({
    getAction: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...fixture.entry, state, providerResult: null },
    }),
    readCurrentCommerceProjection: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kind: "product",
        projection: {
          provenance: {
            organisationId: ORGANISATION_ID,
            source: "underclerk",
            integrationAccountId: COMMERCE_INTEGRATION_ACCOUNT_ID,
            resourceType: "product",
            resourceId: "product_ginger_cookie",
            revision: 1,
            observedAt: OBSERVED_AT,
          },
        },
      },
    }),
    beginActionExecution: beginExecution,
  });
  return { env: fixture.env, beginExecution };
}

function descriptionExecutionRequest(): Request {
  return new Request(
    `https://satyr.example/v1/control/organisations/${ORGANISATION_ID}/commerce/actions/00000000-0000-4000-8000-000000000040/execute`,
    {
      method: "POST",
      headers: {
        origin: "https://satyr.example",
        cookie:
          "satyr_control_session=session-console; satyr_control_csrf=csrf-console",
        "x-satyr-csrf": "csrf-console",
        "idempotency-key": "description-execute-confirmed",
      },
      body: "{}",
    },
  );
}

describe("Google OIDC callback state binding", () => {
  it("rejects a callback without the browser state cookie", async () => {
    const response = await handleControlRequest(
      new Request(
        "https://satyr.example/v1/control/auth/google/callback?state=state-1&code=code-1",
      ),
      googleCallbackEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "oidc_callback_invalid",
    });
  });

  it("rejects a callback whose browser state cookie does not match", async () => {
    const response = await handleControlRequest(
      new Request(
        "https://satyr.example/v1/control/auth/google/callback?state=state-1&code=code-1",
        {
          headers: { cookie: "satyr_control_oidc_state=state-2" },
        },
      ),
      googleCallbackEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "oidc_callback_invalid",
    });
  });
});

describe("commerce control query routes", () => {
  it("queues one Satyr Commerce sync and replays the accepted mutation", async () => {
    const organisationId = parseOrganisationId(ORGANISATION_ID);
    if (!organisationId.ok) throw new Error("organisation fixture is invalid");
    const queueSend = vi.fn(
      async (_message: unknown, _options?: unknown) => undefined,
    );
    const receiptBatch = vi.fn(async () => [{ meta: { changes: 1 } }]);
    controlMocks.resolveControlSession.mockResolvedValue({
      ok: true,
      value: {
        kind: "active",
        controlSessionId: "control_session_console",
        userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
        rotationGeneration: 1,
        createdAt: Date.now() - 60_000,
        rotatedAt: Date.now() - 60_000,
        expiresAt: Date.now() + 60_000,
      },
    });
    controlMocks.validateControlCsrf.mockResolvedValue({
      ok: true,
      value: true,
    });
    controlMocks.authorizeOrganisationControl.mockResolvedValue({
      ok: true,
      value: {
        session: undefined,
        membership: {
          organisationId: organisationId.value,
          userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
          personId: "person_console",
          role: "owner",
          createdAt: Date.now() - 60_000,
        },
      },
    });
    controlMocks.resolveUser.mockResolvedValue({
      userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
      issuer: "https://accounts.google.com",
      subject: "google-console",
      email: "console@example.com",
      displayName: "Console Owner",
      emailVerified: true,
      createdAt: Date.now() - 60_000,
      lastAuthenticatedAt: Date.now() - 60_000,
    });
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue({
      ok: true,
      value: {
        commerceSystem: {
          kind: "satyr_commerce",
          organisationId: organisationId.value,
          bindingId: "underclerk_binding_console",
          merchantId: "merchant_console",
          revision: 1,
        },
        provider: "underclerk",
        integrationAccountId: INTEGRATION_ACCOUNT_ID,
      },
    });
    mutationMocks.readControlMutationReplay.mockResolvedValueOnce({
      kind: "absent",
    });
    mutationMocks.prepareControlMutationReceipt.mockReturnValue({
      kind: "prepared_receipt",
    });
    const env = platformEnv({
      ...routeEnv(),
      DB: {
        withSession: vi.fn(() => ({ batch: receiptBatch, prepare: routeEnv().DB.prepare })),
      },
      EVENT_Q: { send: queueSend },
    });
    const request = commerceSystemSyncRequest();
    const response = await handleControlRequest(request, env);
    const acceptedBody = {
      ok: true,
      outcome: "sync_queued",
      commerceSystem: {
        kind: "satyr_commerce",
        organisationId: ORGANISATION_ID,
        bindingId: "underclerk_binding_console",
        merchantId: "merchant_console",
        revision: 1,
      },
    };
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(acceptedBody);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0]?.[0]).toMatchObject({
      type: "underclerk.outbox_reconcile.v1",
      organisationId: ORGANISATION_ID,
      integrationAccountId: INTEGRATION_ACCOUNT_ID,
    });
    expect(receiptBatch).toHaveBeenCalledTimes(1);

    mutationMocks.readControlMutationReplay.mockResolvedValueOnce({
      kind: "replay",
      receipt: { responseStatus: 200, responseBody: acceptedBody },
    });
    const replay = await handleControlRequest(commerceSystemSyncRequest(), env);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(acceptedBody);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("serves CafeOS Home and rejects missing or cross-organisation authorization", async () => {
    onboardingMocks.buildOnboardingProjection.mockResolvedValue(
      homeProjection(),
    );
    actorMocks.requireActiveOrganisationActor.mockClear();
    const actor = {
      readActionActivity: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    actorMocks.requireActiveOrganisationActor.mockResolvedValue(actor);
    accountMocks.listIntegrationAccounts.mockResolvedValue([]);
    controlMocks.resolveControlSession.mockResolvedValue({
      ok: true,
      value: {
        userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
        expiresAt: Date.now() + 60_000,
      },
    });
    controlMocks.authorizeOrganisationControl.mockImplementation(
      async ({ organisationId }: { organisationId: string }) =>
        organisationId === ORGANISATION_ID
          ? { ok: true, value: { membership: { organisationId, role: "viewer" } } }
          : {
              ok: false,
              error: { code: "organisation_membership_missing", organisationId },
            },
    );

    const env = routeEnv();
    const paths = [`/v1/control/organisations/${ORGANISATION_ID}/home`];
    for (const path of paths) {
      const response = await handleControlRequest(
        authenticatedRequest(path),
        env,
      );
      expect(response.status, path).toBe(200);
      const body = await response.json();
      expect(body, path).toMatchObject({ ok: true });
      if (path.endsWith("/home")) {
        expect(body).toMatchObject({
          schemaVersion: "satyr.cafeos.home.v1",
          home: {
            workspace: {
              organisationId: ORGANISATION_ID,
              name: "Console workspace",
              lifecycle: "active",
              environment: "development",
            },
            attention: [],
            blockers: [],
          },
        });
        if (!isRecord(body) || !isRecord(body.home))
          throw new Error("home response is not an object");
        expect(body.home.today).toEqual([]);
      }
    }
    const unauthorized = await handleControlRequest(
      new Request(`https://satyr.example/v1/control/organisations/${ORGANISATION_ID}/home`),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const crossOrganisation = await handleControlRequest(
      authenticatedRequest(`/v1/control/organisations/${OTHER_ORGANISATION_ID}/home`),
      env,
    );
    expect(crossOrganisation.status).toBe(404);
    expect(actorMocks.requireActiveOrganisationActor).toHaveBeenCalledTimes(
      paths.length,
    );
  });
});

function configureCommerceControlSession(): { readonly env: UnitTestEnv } {
  const organisationId = parseOrganisationId(ORGANISATION_ID);
  if (!organisationId.ok) throw new Error("organisation fixture is invalid");
  const now = Date.now();

  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_console",
      userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
      rotationGeneration: 1,
      createdAt: now - 60_000,
      rotatedAt: now - 60_000,
      expiresAt: now + 60_000,
    },
  });
  controlMocks.validateControlCsrf.mockResolvedValue({ ok: true, value: true });
  controlMocks.authorizeOrganisationControl.mockResolvedValue({
    ok: true,
    value: {
      session: undefined,
      membership: {
        kind: "active",
        organisationId: organisationId.value,
        userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
        personId: "person_console",
        role: "owner",
        createdAt: now - 60_000,
      },
    },
  });
  controlMocks.resolveUser.mockResolvedValue({
    userId: "user_c5956029-c75e-5016-8043-b331c19fe29d",
    issuer: "https://accounts.google.com",
    subject: "google-console",
    email: "console@example.com",
    displayName: "Console Owner",
    emailVerified: true,
    createdAt: now - 60_000,
    lastAuthenticatedAt: now - 60_000,
  });
  controlMocks.readActiveOrganisationMembershipRevision.mockResolvedValue(1);
  mutationMocks.readControlMutationReplay.mockResolvedValue({ kind: "absent" });
  commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue({
    ok: true,
    value: {
      commerceSystem: {
        kind: "satyr_commerce",
        organisationId: organisationId.value,
        bindingId: COMMERCE_BINDING_ID,
        merchantId: COMMERCE_MERCHANT_ID,
        revision: 1,
      },
      provider: "underclerk",
      integrationAccountId: COMMERCE_INTEGRATION_ACCOUNT_ID,
    },
  });
  modelRouteMocks.resolveOrganisationModelRoute.mockResolvedValue({
    ok: true,
    value: {
      keySource: "platform",
      provider: "openai-compatible",
      model: "test-model",
    },
  });
  policyMocks.loadOrganisationPolicyOrDefaultDeny.mockResolvedValue({
    snapshot: { version: 1, egress: {}, authz: {}, conversationRisk: {} },
  });
  turnContextMocks.prepareTurnAuthority.mockResolvedValue({
    ok: true,
    value: { authorityPartition: { digest: "authority-partition" } },
  });
  turnAuthorityMocks.authorizeCapabilityUse.mockResolvedValue({
    ok: true,
    value: null,
  });
  onboardingMocks.buildOnboardingProjection.mockResolvedValue({
    operating_profile: {
      kind: "configured",
      cue_target: {
        kind: "slack",
        workspace_id: "workspace_console",
        channel_id: "channel_console",
      },
    },
  });
  slackRoutingMocks.resolveActiveSlackDestinationConnection.mockResolvedValue({
    ok: true,
    value: {
      installationId: "slack_installation_console",
      connectionId: "slack_connection_console",
      integrationAccountId: "integration_slack_console",
    },
  });
  const receiptBatch = vi.fn(async () => [{ meta: { changes: 1 } }]);
  const baseEnv = routeEnv();
  return {
    env: platformEnv({
      ...baseEnv,
      DB: {
        ...baseEnv.DB,
        withSession: vi
          .fn()
          .mockReturnValue({
            prepare: baseEnv.DB.prepare,
            batch: receiptBatch,
          }),
      },
      UNDERCLERK_BASE_URL: "https://underclerk.example",
      UNDERCLERK_SERVICE_TOKEN: "underclerk-service-token",
      UNDERCLERK: { fetch: vi.fn() },
    }),
  };
}

function authenticatedRequest(path: string): Request {
  return new Request(`https://satyr.example${path}`, {
    headers: { cookie: "satyr_control_session=session-console" },
  });
}

function commerceSystemSyncRequest(): Request {
  return new Request(
    `https://satyr.example/v1/control/organisations/${ORGANISATION_ID}/commerce-system/sync`,
    {
      method: "POST",
      headers: {
        origin: "https://satyr.example",
        cookie:
          "satyr_control_session=session-console; satyr_control_csrf=csrf-console",
        "x-satyr-csrf": "csrf-console",
        "idempotency-key": "commerce-system-sync-console",
      },
      body: "{}",
    },
  );
}

function routeEnv(): UnitTestEnv {
  const first = vi.fn().mockResolvedValue({
    environment: "development",
    placementKind: "affinity",
    placementEpoch: 1,
    placementCellId: "test",
    locationHint: "wnam",
    residencyJurisdiction: null,
    fenceToken: "fixture-action-fence",
    status: "active",
    createdAt: 1,
    activatedAt: 1,
    frozenAt: null,
    abandonedAt: null,
    retiredAt: null,
  });
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ first, all });
  const database = { prepare: vi.fn().mockReturnValue({ bind }) };
  return platformEnv({
    DB: { ...database, withSession: vi.fn().mockReturnValue(database) },
    SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
 databaseBinding: "DB",
      kind: "affinity",
      placementCellId: "test",
      locationHint: "wnam",
    }),
    SATYR_PUBLIC_ORIGIN: "https://satyr.example",
    SATYR_DEPLOYMENT_PROFILE: "local",
    SLACK_APP_ID: "A_COMMERCE_CONSOLE",
  });
}

function homeProjection() {
  return {
    organisation: {
      organisation_id: ORGANISATION_ID,
      name: "Console workspace",
      lifecycle: {
        kind: "active",
        organisation_id: ORGANISATION_ID,
        activation_receipt_id: "receipt_console",
        activated_at: Date.parse(OBSERVED_AT),
        environment: "development",
      },
    },
    readiness: {
      kind: "ready",
      readiness_version: 1,
      readiness_hash: "hash_console",
      requirements: [],
      configuration_version: 1,
      assessed_at: Date.parse(OBSERVED_AT),
    },
    updated_at: Date.parse(OBSERVED_AT),
  };
}

function approvalRouteEnv(): UnitTestEnv {
  return platformEnv({
    ...routeEnv(),
    SATYR_PUBLIC_ORIGIN: "https://satyr.example",
  });
}

function googleCallbackEnv(): UnitTestEnv {
  return platformEnv({
    DB: {},
    SATYR_PUBLIC_ORIGIN: "https://satyr.example",
    GOOGLE_OIDC_CLIENT_ID: "google-client-id",
    GOOGLE_OIDC_CLIENT_SECRET: "google-client-secret",
  });
}
