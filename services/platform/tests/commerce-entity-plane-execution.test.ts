/// <reference types="@cloudflare/workers-types" />

// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { describe, expect, it, vi } from "vitest";
import { parseEntityPlaneCommandResult } from "@purin-labs/commerce-client";
import type { CommerceMutationReceiptV1 } from "@purin-labs/commerce-contracts";
import type { CommerceEntityPlaneCaseProposal } from "../src/actors/case/types";
import type { ActionLedgerEntry } from "@purin-labs/authority/actors/action-ledger";
import { parseApprovalEvidence } from "@purin-labs/authority/approval-authentication";
import {
  executeCommerceEntityPlaneAction,
  type CommerceEntityPlaneExecutionEnv,
} from "../src/commerce/entity-plane/execution";
import { parseCommerceEntityPlaneProposal } from "../src/commerce/entity-plane/proposals";
import { parseCommerceSystemRevision } from "@purin-labs/connections/data/organisation-commerce-system";
import {
  realProviderActionAuthority,
  realProviderExecutionFixture,
} from "./real-provider-execution-fixture";
import {
  compileTurnAuthority,
  type CompiledTurnAuthority,
} from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { defaultDenyPolicy } from "@purin-labs/authority/policy-snapshot";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import {
  FlowBinding,
  InformationFlowContext,
} from "@purin-labs/authority/policy/information-flow/index";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  requireCaseId,
  requireIntegrationAccountId,
  requireSessionId,
  requireOrganisationId,
} from "./test-ids";

vi.mock("@purin-labs/connections/data/commerce-merchant-binding", () => ({
  resolveCommerceMerchantBinding: async () => ({
    ok: true,
    value: { merchantId: "merchant_execution" },
  }),
}));

describe("commerce entity-plane governed execution", () => {
  it("sends one stable command, records the signed effect, and replays terminal evidence", async () => {
    const organisationId = requireOrganisationId(
      "organisation_entity_plane_execution",
    );
    const native = await entityExecutionAuthority(organisationId, "allowed");
    const authority = native.authority;
    const requestAuthority = authority.requestAuthority;
    const entityProposal = parseCommerceEntityPlaneProposal({
      kind: "patch_custom_entity",
      entityRef: {
        origin: "custom",
        typeId: "customer",
        entityId: "customer_1",
      },
      typeRevision: 1,
      expectedRevision: 1,
      attributes: [],
      displayName: null,
    });
    if (entityProposal === null)
      throw new Error("invalid entity-plane proposal fixture");
    const proposal: CommerceEntityPlaneCaseProposal = {
      kind: "entity_plane",
      proposalId: "proposal_entity_plane_execution",
      caseId: "case_entity_plane_execution",
      basedOnRevision: 0,
      requestAuthority,
      proposal: entityProposal,
      origin: {
        kind: "merchant_control",
        userId: "user_3ebf8f2e-c8ea-53e2-b67b-c59d5d299c7f",
        controlSessionId: "session_execution",
      },
    };
    const parsedReceipt = parseEntityPlaneCommandResult({
      status: "accepted",
      receipt: {
        commandId: "integration_execution:nonce_execution",
        outcome: "applied",
        target: {
          kind: "custom_entity",
          entityRef: proposal.proposal.entityRef,
          revision: 2,
        },
        merchantRevision: 2,
        committedAt: "2026-08-26T00:00:00Z",
        deliveryId: "delivery_execution",
        signer: {
          keyId: "key_execution",
          algorithm: "ed25519",
          signature: "signature_execution",
        },
      },
    });
    if (parsedReceipt.status !== "accepted")
      throw new Error("invalid receipt fixture");
    const receipt = parsedReceipt.receipt;
    let commandCalls = 0;
    const commandIds: string[] = [];
    const receiptIds: string[] = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("/changes?")) {
        return jsonResponse({
          merchantId: "merchant_execution",
          merchantRevision: 1,
          changes: [],
          nextAfterMerchantRevision: 1,
          hasMore: false,
        });
      }
      commandCalls += 1;
      commandIds.push(String(JSON.parse(String(init?.body)).commandId));
      expect(init?.method).toBe("POST");
      return jsonResponse({ status: "accepted", receipt });
    };
    if (requestAuthority.kind !== "direct_conversation")
      throw new Error("invalid authority fixture");
    const execution = native.scope;
    const action = await signedAction(organisationId, authority);
    let terminal: ActionLedgerEntry = action;
    let effectCalls = 0;
    const organisation = {
      beginActionExecution: async () => {
        terminal = {
          ...action,
          state: "executing",
          executionLease: { leaseId: "lease_execution", expiresAt: 2_000 },
        };
        return { ok: true as const, value: terminal };
      },
      retryIndeterminateActionExecution: async () => ({
        ok: false as const,
        error: { code: "invalid_action" as const, field: "retry" },
      }),
      completeActionExecution: async (input: {
        readonly providerResult: string;
      }) => {
        terminal = confirmedAction(action, input.providerResult);
        return { ok: true as const, value: terminal };
      },
      recordCommerceEntityPlaneEffect: async (input: {
        readonly effect: NonNullable<ActionLedgerEntry["commerceEffect"]>;
      }) => {
        if (terminal.state !== "confirmed")
          throw new Error("terminal fixture invariant");
        effectCalls += 1;
        const deliveryId = input.effect.receipt.deliveryId;
        if (deliveryId === null)
          throw new Error("receipt fixture must carry delivery evidence");
        receiptIds.push(deliveryId);
        terminal = { ...terminal, commerceEffect: input.effect };
        return { ok: true as const, value: terminal };
      },
    };
    const env: CommerceEntityPlaneExecutionEnv = {
      COMMERCE_BASE_URL: "https://commerce.example",
      COMMERCE_SERVICE_TOKEN: "service-token",
      COMMERCE: { fetch: fetcher },
    };
    const caseActor = {
      readAcceptedCommerceEntityPlaneProposal: async () => ({
        ok: true as const,
        value: proposal,
      }),
    };

    const first = await executeCommerceEntityPlaneAction({
      execution,
      env,
      organisation,
      caseActor,
      action,
      now: 1_000,
    });
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      value: {
        action: { state: "confirmed" },
        receipt: {
          commandId: receipt.commandId,
          deliveryId: receipt.deliveryId,
          signer: {
            keyId: receipt.signer.keyId,
            algorithm: receipt.signer.algorithm,
            signature: receipt.signer.signature,
          },
        },
        effect: { kind: "patch_custom_entity" },
      },
    });
    expect(commandCalls).toBe(1);
    expect(commandIds).toEqual([receipt.commandId]);
    expect(effectCalls).toBe(1);
    expect(receiptIds).toEqual([receipt.deliveryId]);

    const replay = await executeCommerceEntityPlaneAction({
      execution,
      env,
      organisation,
      caseActor,
      action: terminal,
      now: 1_100,
    });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        action: { state: "confirmed" },
        receipt,
        effect: { kind: "patch_custom_entity" },
      },
    });
    expect(commandCalls).toBe(1);
    expect(effectCalls).toBe(1);
  });

  it("retries an indeterminate action with idempotent replay evidence", async () => {
    const fixture = await executionFixture("allowed");
    const execution = fixture.execution;
    const indeterminate = indeterminateAction(fixture.action);
    let current: ActionLedgerEntry = indeterminate;
    let retryEvidence: unknown = null;
    let commandCalls = 0;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("/changes?")) {
        return jsonResponse({
          merchantId: "merchant_execution",
          merchantRevision: 1,
          changes: [],
          nextAfterMerchantRevision: 1,
          hasMore: false,
        });
      }
      commandCalls += 1;
      expect(init?.method).toBe("POST");
      return jsonResponse({
        status: "accepted",
        receipt: { ...fixture.receipt, outcome: "already_applied" },
      });
    };
    const organisation = {
      beginActionExecution: async () => ({
        ok: false as const,
        error: { code: "invalid_action" as const, field: "begin" },
      }),
      retryIndeterminateActionExecution: async (input: {
        readonly evidence: unknown;
      }) => {
        retryEvidence = input.evidence;
        current = {
          ...indeterminate,
          state: "executing",
          executionLease: { leaseId: "lease_replay", expiresAt: 2_000 },
        };
        return { ok: true as const, value: current };
      },
      completeActionExecution: async (input: {
        readonly providerResult: string;
      }) => {
        current = confirmedAction(indeterminate, input.providerResult);
        return { ok: true as const, value: current };
      },
      recordCommerceEntityPlaneEffect: async (input: {
        readonly effect: NonNullable<ActionLedgerEntry["commerceEffect"]>;
      }) => {
        if (current.state !== "confirmed")
          throw new Error("terminal fixture invariant");
        current = { ...current, commerceEffect: input.effect };
        return { ok: true as const, value: current };
      },
    };
    const first = await executeCommerceEntityPlaneAction({
      execution,
      env: testEnv(fetcher),
      organisation,
      caseActor: fixture.caseActor,
      action: indeterminate,
      now: 1_000,
    });
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      value: {
        action: { state: "confirmed" },
        receipt: { outcome: "already_applied" },
        effect: { kind: "patch_custom_entity" },
      },
    });
    expect(retryEvidence).toMatchObject({
      kind: "provider_idempotent_replay",
      idempotencyKey: indeterminate.idempotencyKey,
    });
    expect(commandCalls).toBe(1);

    const replay = await executeCommerceEntityPlaneAction({
      execution,
      env: testEnv(fetcher),
      organisation,
      caseActor: fixture.caseActor,
      action: current,
      now: 1_100,
    });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        action: { state: "confirmed" },
        receipt: { outcome: "already_applied" },
      },
    });
    expect(commandCalls).toBe(1);
  });

  it("rechecks current command policy before touching Commerce", async () => {
    const fixture = await executionFixture("denied");
    const execution = fixture.execution;
    const fetcher = vi.fn(async () => jsonResponse({}));
    const organisation = {
      beginActionExecution: vi.fn(),
      retryIndeterminateActionExecution: vi.fn(),
      completeActionExecution: vi.fn(),
      recordCommerceEntityPlaneEffect: vi.fn(),
    };

    const result = await executeCommerceEntityPlaneAction({
      execution,
      env: testEnv(fetcher),
      organisation,
      caseActor: fixture.caseActor,
      action: fixture.action,
      now: 1_000,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "commerce_entity_plane_authority_invalid",
        evidence: { code: "commerce_entity_plane_command_policy_denied" },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(organisation.beginActionExecution).not.toHaveBeenCalled();
  });
});

async function signedAction(
  organisationId: ReturnType<typeof requireOrganisationId>,
  authority: CompiledTurnAuthority,
): Promise<VariantBy<ActionLedgerEntry, "state", "signed">> {
  const requestAuthority = authority.requestAuthority;
  const integrationAccountId = requireIntegrationAccountId(
    "integration_execution",
  );
  const sessionId = requireSessionId("session_execution");
  const caseId = requireCaseId("case_entity_plane_execution");
  const authorityRevision = parseCommerceSystemRevision(1);
  const approval = parseApprovalEvidence({
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: "user_3ebf8f2e-c8ea-53e2-b67b-c59d5d299c7f",
      personId: "person_execution",
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: "session_execution",
      authenticatedAt: 1,
      challenge: {
        stepUpId: "step_up_execution",
        organisationId: String(organisationId),
        actionNonce: "nonce_execution",
        actionDigest: "a".repeat(64),
        policy: { kind: "unversioned_default" },
        issuedAt: 1,
        expiresAt: 2_000,
      },
    },
  });
  if (!authorityRevision.ok || !approval.ok)
    throw new Error("invalid signed action fixture");
  return {
    state: "signed",
    action: {
      organisationId,
      integrationAccountId,
      requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: authorityRevision.value,
      },
      threadId: "case_entity_plane_execution",
      sessionId,
      host: "commerce",
      verb: "POST",
      path: "/entity-plane/commands",
      argsHash: "c".repeat(64),
      amount: null,
      nonce: { value: "nonce_execution" },
      exp: Date.parse("2099-01-01T00:00:00.000Z"),
      resourceKey: "commerce.entity:customer:customer_1",
      flowBinding: await emptyExecutionFlowBinding(
        organisationId,
        sessionId,
        authority.authorityPartition.digest,
      ),
    },
    caseId,
    proposalId: "proposal_entity_plane_execution",
    idempotencyKey: "integration_execution:nonce_execution",
    createdAt: 1,
    updatedAt: 1,
    commerceEffect: null,
    approval: approval.value,
  };
}

function confirmedAction(
  action: VariantBy<ActionLedgerEntry, "state", "signed" | "indeterminate">,
  providerResult: string,
): VariantBy<ActionLedgerEntry, "state", "confirmed"> {
  return { ...action, state: "confirmed", providerResult };
}

function indeterminateAction(
  action: VariantBy<ActionLedgerEntry, "state", "signed">,
): VariantBy<ActionLedgerEntry, "state", "indeterminate"> {
  return { ...action, state: "indeterminate" };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function testEnv(
  fetcher: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): CommerceEntityPlaneExecutionEnv {
  return {
    COMMERCE_BASE_URL: "https://commerce.example",
    COMMERCE_SERVICE_TOKEN: "service-token",
    COMMERCE: { fetch: fetcher },
  };
}

async function executionFixture(commandPolicy: "allowed" | "denied"): Promise<
  Readonly<{
    readonly execution: OrganisationExecutionScope;
    readonly proposal: CommerceEntityPlaneCaseProposal;
    readonly action: VariantBy<ActionLedgerEntry, "state", "signed">;
    readonly receipt: CommerceMutationReceiptV1;
    readonly caseActor: Readonly<{
      readonly readAcceptedCommerceEntityPlaneProposal: () => Promise<{
        readonly ok: true;
        readonly value: CommerceEntityPlaneCaseProposal;
      }>;
    }>;
  }>
> {
  const organisationId = requireOrganisationId(
    "organisation_entity_plane_replay",
  );
  const native = await entityExecutionAuthority(organisationId, commandPolicy);
  const authority = native.authority;
  if (authority.requestAuthority.kind !== "direct_conversation")
    throw new Error("invalid authority fixture");
  const entityProposal = parseCommerceEntityPlaneProposal({
    kind: "patch_custom_entity",
    entityRef: { origin: "custom", typeId: "customer", entityId: "customer_1" },
    typeRevision: 1,
    expectedRevision: 1,
    attributes: [],
    displayName: null,
  });
  if (entityProposal === null)
    throw new Error("invalid entity-plane proposal fixture");
  const proposal: CommerceEntityPlaneCaseProposal = {
    kind: "entity_plane",
    proposalId: "proposal_entity_plane_execution",
    caseId: "case_entity_plane_execution",
    basedOnRevision: 0,
    requestAuthority: authority.requestAuthority,
    proposal: entityProposal,
    origin: {
      kind: "merchant_control",
      userId: "user_3ebf8f2e-c8ea-53e2-b67b-c59d5d299c7f",
      controlSessionId: "session_execution",
    },
  };
  const parsedReceipt = parseEntityPlaneCommandResult({
    status: "accepted",
    receipt: {
      commandId: "integration_execution:nonce_execution",
      outcome: "applied",
      target: {
        kind: "custom_entity",
        entityRef: entityProposal.entityRef,
        revision: 2,
      },
      merchantRevision: 2,
      committedAt: "2026-08-26T00:00:00Z",
      deliveryId: "delivery_execution",
      signer: {
        keyId: "key_execution",
        algorithm: "ed25519",
        signature: "signature_execution",
      },
    },
  });
  if (parsedReceipt.status !== "accepted")
    throw new Error("invalid receipt fixture");
  const action = await signedAction(organisationId, authority);
  return {
    execution: native.scope,
    proposal,
    action,
    receipt: parsedReceipt.receipt,
    caseActor: {
      readAcceptedCommerceEntityPlaneProposal: async () => ({
        ok: true,
        value: proposal,
      }),
    },
  };
}

async function emptyExecutionFlowBinding(
  organisationId: string,
  sessionId: string,
  authorityPartitionDigest: string,
) {
  const context = await InformationFlowContext.create({
    organisationId,
    sessionId,
    authorityPartitionDigest,
  });
  if (!context.ok) throw new Error(context.error.code);
  return FlowBinding.fromContext(context.value, "turn_execution").toJSON();
}

async function entityExecutionAuthority(
  organisationId: ReturnType<typeof requireOrganisationId>,
  commandPolicy: "allowed" | "denied",
) {
  const integrationAccountId = requireIntegrationAccountId(
    "integration_execution",
  );
  const native = await realProviderExecutionFixture({
    organisationId,
    integrationAccountId,
    capabilityId: "commerce.action.propose",
    resourceScope: "*",
    grantActive: true,
  });
  const entityProposal = parseCommerceEntityPlaneProposal({
    kind: "patch_custom_entity",
    entityRef: { origin: "custom", typeId: "customer", entityId: "customer_1" },
    typeRevision: 1,
    expectedRevision: 1,
    attributes: [],
    displayName: null,
  });
  if (entityProposal === null || entityProposal.kind !== "patch_custom_entity")
    throw new Error("Invalid command grant fixture");
  const grant = await createAccessGrant({
    db: native.scope.database,
    organisationId,
    grantId: "entity_command_grant",
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "commerce_command",
      capabilityId: "commerce.entity.patch",
      capabilityVersion: 1,
      scope: {
        kind: "entity",
        entityRef: entityProposal.entityRef,
      },
      target: {
        kind: "custom_entity",
        entityRef: entityProposal.entityRef,
        revision: entityProposal.expectedRevision,
      },
    },
    provenance: {
      kind: "cutover",
      migrationId: "entity-execution-fixture",
      originalChangedAt: 1,
    },
    now: 1,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const policy = defaultDenyPolicy({ now: 1 });
  policy.version = 2;
  policy.authz.allowedTools = [
    "commerce.action.propose",
    "commerce.entity.patch",
  ];
  policy.authz.deniedTools =
    commandPolicy === "denied" ? ["commerce.entity.patch"] : [];
  await native.scope.database
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 2, ?, 2, 'entity-execution-fixture')",
    )
    .bind(organisationId, JSON.stringify(policy))
    .run();
  const requestAuthority = realProviderActionAuthority({
    organisationId,
    integrationAccountId,
    providerResourceScope: "commerce.entity:customer:customer_1",
  }).requestAuthority;
  const authority = await compileTurnAuthority({
    db: native.scope.database,
    accountAccess: native.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      "session_execution",
      "nonce_execution",
    ),
    action: "execute",
    organisationId,
    requestAuthority,
    policy: { version: 2 },
  });
  if (!authority.ok) throw new Error(JSON.stringify(authority.error));
  return { scope: native.scope, authority: authority.value };
}
