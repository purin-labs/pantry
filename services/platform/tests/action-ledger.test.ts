// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { parseFixtureUserId } from "./test-ids";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  beginActionExecution,
  expireDueActionExecutions,
  completeActionExecution,
  createActionLedgerSchema,
  getAction,
  proposeAction,
  rejectAction,
  reconcileActionExecution,
  readActionActivity,
  readNextActionExecutionLeaseDeadline,
  recordCommerceEntityPlaneEffect,
  requestActionApproval,
  retryIndeterminateActionExecution,
  signAction,
  type ActionLedgerEntry,
  type ExecutingActionLedgerEntry,
  type ProposeActionInput,
} from "@purin-labs/authority/actors/action-ledger";
import {
  parseControlSessionId,
  parsePersonId,
  parseOrganisationId,
  type CaseId,
  type IntegrationAccountId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
  type MerchantActionRejectionEvidence,
} from "@purin-labs/authority/approval-authentication";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  fixtureCustomConnectorActionAuthority,
  fixtureFlowBinding,
  fixtureProviderActionAuthority,
} from "./fixtures/plan25-turn";
import { parseCommerceEntityPlaneEffect } from "@purin-labs/area-commerce/server/entity-plane/proposals";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  requireCaseId,
  requireIntegrationAccountId,
  requireSessionId,
  requireOrganisationId,
} from "./test-ids";

describe("organisation action ledger", function actionLedgerSuite() {
  it("pins custom connector write authority and reuses the proposal on duplicate delivery", function customConnectorWriteReplay() {
    const fixture = ledgerFixture();
    const connectorId = "custom_connector_inventory";
    const definitionDigest = "a".repeat(64);
    const operationId = "create_record";
    const authority = fixtureCustomConnectorActionAuthority({
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.firstIntegrationAccountId,
      connectorId,
      definitionRevision: 2,
      definitionDigest,
      operationId,
    });
    const input: ProposeActionInput = {
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.firstIntegrationAccountId,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: {
        kind: "custom_connector",
        connectorId,
        definitionRevision: 2,
        definitionDigest,
        bindingRevision: 3,
        credentialGeneration: 4,
        operationId,
        effect: "external_record_create",
        retryPolicy: { kind: "single_attempt" },
        canonicalInputJson: '{"name":"Morning bun"}',
        canonicalInputDigest: "b".repeat(64),
        outputContractDigest: "c".repeat(64),
        resourceIdentity: { kind: "new_record" },
        providerEffectId: "effect_case_1_call_1",
      },
      caseId: requireCaseId("case_custom_connector_write"),
      proposalId: "proposal_custom_connector_write",
      sessionId: fixture.firstSessionId,
      threadId: "slack:T:C:custom-write",
      draft: {
        host: "api.inventory.example",
        verb: "custom_connector.external_record_create",
        path: "/v1/records",
        argsHash: "b".repeat(64),
        amount: null,
        resourceKey: "custom_connector:inventory:create:effect_case_1_call_1",
      },
      flowBinding: fixtureFlowBinding({
        organisationId: fixture.organisationId,
        sessionId: fixture.firstSessionId,
        authorityPartitionDigest: authority.authorityPartition.digest,
      }),
      exp: 1_100,
      now: 100,
    };

    const proposed = requireEntry(proposeAction(fixture.sql, input));
    const duplicate = requireEntry(proposeAction(fixture.sql, input));
    requireEntry(
      requestActionApproval(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 110,
      }),
    );
    requireEntry(
      signAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        approval: approvalEvidence("operator", 120),
        now: 120,
      }),
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: proposed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    const uncertain = requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "indeterminate",
        providerResult: JSON.stringify({ code: "transport_interrupted" }),
        now: 140,
      }),
    );
    const receipt = JSON.stringify({
      kind: "custom_connector_reconciliation",
      providerEffectId: "effect_case_1_call_1",
      outcome: "confirmed",
    });
    const reconciled = requireEntry(
      reconcileActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        outcome: "confirmed",
        providerResult: receipt,
        now: 150,
      }),
    );

    expect(duplicate.action.nonce).toEqual(proposed.action.nonce);
    expect(duplicate.action.authority).toEqual(input.authority);
    expect(duplicate.idempotencyKey).toBe(proposed.idempotencyKey);
    expect(uncertain.state).toBe("indeterminate");
    expect(reconciled).toMatchObject({
      state: "confirmed",
      providerResult: receipt,
    });
  });

  it("reuses one nonce across retries and denies replay after confirmation", function deduplicatesAction() {
    const fixture = ledgerFixture();
    const input = proposalInput(
      fixture,
      fixture.firstIntegrationAccountId,
      fixture.firstSessionId,
      "hash-first",
      100,
    );
    const proposed = requireEntry(proposeAction(fixture.sql, input));
    const duplicate = requireEntry(proposeAction(fixture.sql, input));
    const requested = requireEntry(
      requestActionApproval(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 110,
      }),
    );
    const signed = requireEntry(
      signAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        approval: approvalEvidence("operator", 120),
        now: 120,
      }),
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: proposed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    const confirmed = requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "confirmed",
        providerResult: "stripe:ch_test_1",
        now: 140,
      }),
    );
    const replay = beginActionExecution(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: proposed.action.nonce.value,
      now: 150,
    });

    expect(duplicate.action.nonce).toEqual(proposed.action.nonce);
    expect(duplicate.idempotencyKey).toBe(proposed.idempotencyKey);
    expect(requested.state).toBe("approval_requested");
    expect(signed.state).toBe("signed");
    expect(executing.state).toBe("executing");
    expect(confirmed).toMatchObject({
      state: "confirmed",
      providerResult: "stripe:ch_test_1",
    });
    expect(replay).toEqual({ ok: false, error: { code: "action_replay" } });
  });

  it("keeps retries and provider idempotency scoped to one integration account", function scopesActionIdentity() {
    const fixture = ledgerFixture();
    const first = requireEntry(
      proposeAction(
        fixture.sql,
        proposalInput(
          fixture,
          fixture.firstIntegrationAccountId,
          fixture.firstSessionId,
          "shared-args",
          100,
        ),
      ),
    );
    const second = requireEntry(
      proposeAction(
        fixture.sql,
        proposalInput(
          fixture,
          fixture.secondIntegrationAccountId,
          fixture.firstSessionId,
          "shared-args",
          110,
        ),
      ),
    );

    expect(second.action.nonce.value).not.toBe(first.action.nonce.value);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(first.idempotencyKey).toContain(fixture.firstIntegrationAccountId);
    expect(second.idempotencyKey).toContain(fixture.secondIntegrationAccountId);
  });

  it("replays identical approval evidence and rejects a changed approval", function replaysApprovalEvidence() {
    const fixture = ledgerFixture();
    const proposed = requireEntry(
      proposeAction(
        fixture.sql,
        proposalInput(
          fixture,
          fixture.firstIntegrationAccountId,
          fixture.firstSessionId,
          "hash-replay",
          100,
        ),
      ),
    );
    requireEntry(
      requestActionApproval(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 110,
      }),
    );
    const approval = approvalEvidence("replay", 120);
    const signed = requireEntry(
      signAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        approval,
        now: 120,
      }),
    );
    const replayed = signAction(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: proposed.action.nonce.value,
      approval,
      now: 130,
    });
    const changed = signAction(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: proposed.action.nonce.value,
      approval: approvalEvidence("changed", 130),
      now: 130,
    });

    expect(replayed).toEqual({ ok: true, value: signed });
    expect(changed).toEqual({
      ok: false,
      error: { code: "invalid_action_transition", state: "signed" },
    });
  });

  it("records a terminal merchant rejection and prevents provider execution", function rejectsAction() {
    const fixture = ledgerFixture();
    const proposed = requireEntry(
      proposeAction(
        fixture.sql,
        proposalInput(
          fixture,
          fixture.firstIntegrationAccountId,
          fixture.firstSessionId,
          "hash-rejection",
          100,
        ),
      ),
    );
    requireEntry(
      requestActionApproval(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 110,
      }),
    );
    const rejection = rejectionEvidence(
      fixture.organisationId,
      proposed.action.nonce.value,
      "merchant",
    );
    const rejected = requireEntry(
      rejectAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        rejection,
        now: 120,
      }),
    );

    expect(rejected).toMatchObject({ state: "rejected", rejection });
    expect(
      rejectAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        rejection,
        now: 130,
      }),
    ).toEqual({ ok: true, value: rejected });
    expect(
      rejectAction(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        rejection: rejectionEvidence(
          fixture.organisationId,
          proposed.action.nonce.value,
          "changed",
        ),
        now: 130,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_transition", state: "rejected" },
    });
    expect(
      beginActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 140,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_transition", state: "rejected" },
    });
    expect(
      proposeAction(fixture.sql, {
        ...proposalInput(
          fixture,
          fixture.firstIntegrationAccountId,
          fixture.firstSessionId,
          "hash-rejection",
          100,
        ),
        now: 2_000,
        exp: 3_000,
      }),
    ).toEqual({ ok: true, value: rejected });
  });

  it("allows proposals and fences execution for the same resource", function fencesResource() {
    const fixture = ledgerFixture();
    const first = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-first",
      100,
    );
    const second = signProposal(
      fixture,
      fixture.secondSessionId,
      "hash-second",
      130,
    );
    const denied = beginActionExecution(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: second.action.nonce.value,
      now: 160,
    });

    expect(first.state).toBe("signed");
    expect(second.state).toBe("signed");
    expect(denied).toEqual({
      ok: false,
      error: { code: "resource_busy", resourceKey: "stripe:charge.create" },
    });
  });

  it("rejects provider execution before approval is signed", function requiresApprovalBeforeExecution() {
    const fixture = ledgerFixture();
    const proposed = requireEntry(
      proposeAction(
        fixture.sql,
        proposalInput(
          fixture,
          fixture.firstIntegrationAccountId,
          fixture.firstSessionId,
          "hash-without-approval",
          100,
        ),
      ),
    );

    expect(
      beginActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: proposed.action.nonce.value,
        now: 110,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_transition", state: "proposed" },
    });
  });

  it("returns bounded Case-linked work with terminal receipts", function readsActionActivity() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-activity",
      100,
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    const confirmed = requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "confirmed",
        providerResult: JSON.stringify({
          kind: "commerce_provider_receipt",
          receiptId: "receipt_activity",
          effectId: "effect_activity",
        }),
        now: 140,
      }),
    );
    const activity = readActionActivity(fixture.sql, {
      organisationId: fixture.organisationId,
      resourceKey: null,
      limit: 10,
    });

    expect(confirmed.state).toBe("confirmed");
    expect(activity).toMatchObject({
      ok: true,
      value: [
        {
          caseId: signed.caseId,
          proposalId: signed.proposalId,
          state: "confirmed",
          providerResult: expect.stringContaining("receipt_activity"),
        },
      ],
    });
  });

  it("reconciles a provider receipt after an effect commit and replays it idempotently", function reconcilesProviderReceipt() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-reconcile",
      100,
    );
    requireEntry(
      beginActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        now: 130,
      }),
    );
    const receipt = JSON.stringify({
      kind: "commerce_provider_receipt",
      provider: "shopify",
      receiptId: "shopify_receipt_reconcile",
      effectId: "shopify_effect_reconcile",
      actionNonce: signed.action.nonce.value,
    });
    const settled = requireEntry(
      reconcileActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        outcome: "confirmed",
        providerResult: receipt,
        now: 140,
      }),
    );
    const replay = reconcileActionExecution(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: signed.action.nonce.value,
      outcome: "confirmed",
      providerResult: receipt,
      now: 150,
    });
    expect(settled).toMatchObject({
      state: "confirmed",
      providerResult: receipt,
    });
    expect(replay).toEqual({ ok: true, value: settled });
  });

  it("rejects a different receipt from overwriting terminal provider evidence", function rejectsReceiptConflict() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-reconcile-conflict",
      100,
    );
    requireEntry(
      beginActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        now: 130,
      }),
    );
    const first = JSON.stringify({
      kind: "commerce_provider_receipt",
      receiptId: "receipt_first",
    });
    requireEntry(
      reconcileActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        outcome: "confirmed",
        providerResult: first,
        now: 140,
      }),
    );
    expect(
      reconcileActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        outcome: "confirmed",
        providerResult: JSON.stringify({
          kind: "commerce_provider_receipt",
          receiptId: "receipt_second",
        }),
        now: 150,
      }),
    ).toEqual({ ok: false, error: { code: "action_receipt_conflict" } });
  });

  it("records one commerce effect atomically and replays only the exact effect", function recordsCommerceEffect() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-commerce-effect",
      100,
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "confirmed",
        providerResult: "entity-plane:confirmed",
        now: 140,
      }),
    );
    const effect = entityEffect("command_effect_first");
    const first = recordCommerceEntityPlaneEffect(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: signed.action.nonce.value,
      effect,
      now: 150,
    });
    const replay = recordCommerceEntityPlaneEffect(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: signed.action.nonce.value,
      effect,
      now: 160,
    });
    const changedEffect = entityEffect("command_effect_second");
    const conflict = recordCommerceEntityPlaneEffect(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: signed.action.nonce.value,
      effect: changedEffect,
      now: 170,
    });

    expect(first).toMatchObject({
      ok: true,
      value: { commerceEffect: effect },
    });
    expect(replay).toEqual(first);
    expect(conflict).toEqual({
      ok: false,
      error: { code: "action_receipt_conflict" },
    });
  });

  it("turns a lost conditional effect write into a conflict", function handlesLostCommerceEffectWrite() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-commerce-effect-race",
      100,
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "confirmed",
        providerResult: "entity-plane:confirmed-race",
        now: 140,
      }),
    );
    const competingEffect = entityEffect("command_effect_competing");
    const racingSql = sqlThatLosesEffectWrite(
      fixture.sql,
      fixture.organisationId,
      signed.action.nonce.value,
      competingEffect,
    );
    const result = recordCommerceEntityPlaneEffect(racingSql, {
      organisationId: fixture.organisationId,
      nonce: signed.action.nonce.value,
      effect: entityEffect("command_effect_lost"),
      now: 150,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "action_receipt_conflict" },
    });
  });

  it("expires an execution lease into indeterminate and exposes the next deadline", function expiresExecutionLease() {
    const fixture = ledgerFixture();
    const first = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-lease-first",
      100,
    );
    const second = signProposalOnAccount(
      fixture,
      fixture.secondIntegrationAccountId,
      fixture.secondSessionId,
      "hash-lease-second",
      110,
    );
    const firstExecuting = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: first.action.nonce.value,
          now: 130,
        }),
      ),
    );
    const secondExecuting = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: second.action.nonce.value,
          now: 140,
        }),
      ),
    );

    expect(
      readNextActionExecutionLeaseDeadline(fixture.sql, fixture.organisationId),
    ).toBe(firstExecuting.executionLease.expiresAt);
    expect(
      expireDueActionExecutions(
        fixture.sql,
        fixture.organisationId,
        firstExecuting.executionLease.expiresAt,
      ),
    ).toBe(1);
    expect(
      fixture.sql
        .exec<{ state: string }>(
          "SELECT state FROM action_ledger WHERE organisation_id = ? AND nonce = ?",
          fixture.organisationId,
          first.action.nonce.value,
        )
        .toArray(),
    ).toEqual([{ state: "indeterminate" }]);
    expect(
      readNextActionExecutionLeaseDeadline(fixture.sql, fixture.organisationId),
    ).toBe(secondExecuting.executionLease.expiresAt);
  });

  it("requires matching provider reconciliation evidence before retrying indeterminate work", function gatesIndeterminateRetry() {
    const fixture = ledgerFixture();
    const signed = signProposal(
      fixture,
      fixture.firstSessionId,
      "hash-retry-evidence",
      100,
    );
    const executing = requireExecutingEntry(
      requireEntry(
        beginActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          now: 130,
        }),
      ),
    );
    const indeterminate = requireEntry(
      completeActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        executionLeaseId: executing.executionLease.leaseId,
        outcome: "indeterminate",
        providerResult: JSON.stringify({ code: "transport_interrupted" }),
        now: 140,
      }),
    );
    expect(
      beginActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        now: 150,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_transition", state: "indeterminate" },
    });
    expect(
      retryIndeterminateActionExecution(fixture.sql, {
        organisationId: fixture.organisationId,
        nonce: signed.action.nonce.value,
        evidence: {
          kind: "provider_idempotency_absent",
          integrationAccountId: signed.action.integrationAccountId,
          idempotencyKey: "wrong_idempotency_key",
          observedAt: 150,
        },
        now: 150,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action", field: "retryEvidence" },
    });
    expect(
      requireEntry(
        getAction(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          now: signed.action.exp + 1,
        }),
      ).state,
    ).toBe("indeterminate");
    const retried = requireExecutingEntry(
      requireEntry(
        retryIndeterminateActionExecution(fixture.sql, {
          organisationId: fixture.organisationId,
          nonce: signed.action.nonce.value,
          evidence: {
            kind: "provider_idempotency_absent",
            integrationAccountId: signed.action.integrationAccountId,
            idempotencyKey: signed.idempotencyKey,
            observedAt: signed.action.exp + 2,
          },
          now: signed.action.exp + 2,
        }),
      ),
    );

    expect(indeterminate.state).toBe("indeterminate");
    expect(retried.executionLease.leaseId).not.toBe(
      executing.executionLease.leaseId,
    );
  });
});

type LedgerFixture = {
  sql: SqlStorage;
  organisationId: OrganisationId;
  firstIntegrationAccountId: IntegrationAccountId;
  secondIntegrationAccountId: IntegrationAccountId;
  firstSessionId: SessionId;
  secondSessionId: SessionId;
};

function ledgerFixture(): LedgerFixture {
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  const organisationId = requireOrganisationId("organisation_action_ledger");
  createActionLedgerSchema(sql);
  return {
    sql,
    organisationId,
    firstIntegrationAccountId: requireIntegrationAccountId(
      "integration_stripe_primary",
    ),
    secondIntegrationAccountId: requireIntegrationAccountId(
      "integration_stripe_secondary",
    ),
    firstSessionId: requireSessionId("session_action_first"),
    secondSessionId: requireSessionId("session_action_second"),
  };
}

function proposalInput(
  fixture: LedgerFixture,
  integrationAccountId: IntegrationAccountId,
  sessionId: SessionId,
  argsHash: string,
  now: number,
): ProposeActionInput {
  const authority = fixtureProviderActionAuthority({
    organisationId: fixture.organisationId,
    integrationAccountId,
    providerResourceScope: "stripe:charge.create",
  });
  return {
    organisationId: fixture.organisationId,
    integrationAccountId,
    requestAuthority: authority.requestAuthority,
    authorityPartition: authority.authorityPartition,
    authority: { kind: "integration_account" },
    caseId: requireCaseId(`case_${sessionId}`),
    proposalId: `proposal_${integrationAccountId}_${sessionId}_${argsHash}`,
    sessionId,
    threadId: `slack:T:C:${sessionId}`,
    draft: {
      host: "api.stripe.com",
      verb: "stripe.charge.create",
      path: "/v1/charges",
      argsHash,
      amount: { value: 10, currency: "USD" },
      resourceKey: "stripe:charge.create",
    },
    flowBinding: fixtureFlowBinding({
      organisationId: fixture.organisationId,
      sessionId,
      authorityPartitionDigest: authority.authorityPartition.digest,
    }),
    exp: now + 1_000,
    now,
  };
}

function signProposal(
  fixture: LedgerFixture,
  sessionId: SessionId,
  argsHash: string,
  now: number,
): ActionLedgerEntry {
  return signProposalOnAccount(
    fixture,
    fixture.firstIntegrationAccountId,
    sessionId,
    argsHash,
    now,
  );
}

function signProposalOnAccount(
  fixture: LedgerFixture,
  integrationAccountId: IntegrationAccountId,
  sessionId: SessionId,
  argsHash: string,
  now: number,
): ActionLedgerEntry {
  const proposed = requireEntry(
    proposeAction(
      fixture.sql,
      proposalInput(fixture, integrationAccountId, sessionId, argsHash, now),
    ),
  );
  requireEntry(
    requestActionApproval(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: proposed.action.nonce.value,
      now: now + 10,
    }),
  );
  return requireEntry(
    signAction(fixture.sql, {
      organisationId: fixture.organisationId,
      nonce: proposed.action.nonce.value,
      approval: approvalEvidence(argsHash, now + 20),
      now: now + 20,
    }),
  );
}

function requireEntry(
  result: ReturnType<
    | typeof proposeAction
    | typeof requestActionApproval
    | typeof rejectAction
    | typeof signAction
    | typeof beginActionExecution
    | typeof completeActionExecution
    | typeof getAction
  >,
): ActionLedgerEntry {
  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value;
}

function requireExecutingEntry(
  entry: ActionLedgerEntry,
): ExecutingActionLedgerEntry {
  if (entry.state !== "executing")
    throw new Error(`expected executing, got ${entry.state}`);
  return entry;
}

function entityEffect(commandId: string) {
  const effect = parseCommerceEntityPlaneEffect({
    kind: "patch_custom_entity",
    entityRef: { origin: "custom", typeId: "customer", entityId: "customer_1" },
    typeRevision: 1,
    expectedRevision: 1,
    receipt: {
      commandId,
      outcome: "applied",
      target: {
        kind: "custom_entity",
        entityRef: {
          origin: "custom",
          typeId: "customer",
          entityId: "customer_1",
        },
        revision: 2,
      },
      merchantRevision: 2,
      committedAt: "2026-08-25T00:00:00.000Z",
      deliveryId: "delivery_effect",
      signer: {
        keyId: "key_effect",
        algorithm: "ed25519",
        signature: "signature_effect",
      },
    },
  });
  if (effect === null) throw new Error("invalid commerce effect fixture");
  return effect;
}

function sqlThatLosesEffectWrite(
  sql: SqlStorage,
  organisationId: OrganisationId,
  nonce: string,
  competingEffect: ReturnType<typeof entityEffect>,
): SqlStorage {
  let raced = false;
  return {
    exec<Row extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ) {
      if (!raced && query.includes("SET commerce_effect_json = ?")) {
        raced = true;
        sql.exec(
          "UPDATE action_ledger SET commerce_effect_json = ?, updated_at = ? WHERE organisation_id = ? AND nonce = ?",
          JSON.stringify(competingEffect),
          151,
          organisationId,
          nonce,
        );
        return { toArray: () => [] };
      }
      if (raced && query === "SELECT changes() AS count") {
        return { toArray: () => [{ count: 0 }] };
      }
      return sql.exec<Row>(query, ...bindings);
    },
  } as unknown as SqlStorage;
}

function rejectionEvidence(
  organisationId: OrganisationId,
  actionNonce: string,
  suffix: string,
): MerchantActionRejectionEvidence {
  const userId = parseFixtureUserId(`control_reject_${suffix}`);
  const controlSessionId = parseControlSessionId(
    `control_session_reject_${suffix}`,
  );
  const personId = parsePersonId(`person_reject_${suffix}`);
  const actionDigest = parseApprovalProofDigest("44".repeat(32));
  if (
    !userId.ok ||
    !controlSessionId.ok ||
    !personId.ok ||
    actionDigest === null
  ) {
    throw new Error("invalid rejection fixture");
  }
  return {
    kind: "merchant_rejection",
    principal: {
      kind: "app_user",
      userId: userId.value,
      personId: personId.value,
      role: "owner",
    },
    authentication: {
      kind: "control_session",
      controlSessionId: controlSessionId.value,
      authenticatedAt: 120,
    },
    decision: {
      kind: "rejected",
      reason: "merchant_declined",
      action: { organisationId, actionNonce, actionDigest },
    },
  };
}

function approvalEvidence(
  suffix: string,
  authenticatedAt: number,
): ApprovalEvidence {
  const userId = parseFixtureUserId(`control_${suffix}`);
  const controlSessionId = parseControlSessionId(`control_session_${suffix}`);
  const personId = parsePersonId(`person_${suffix}`);
  const organisationId = parseOrganisationId(`organisation_${suffix}`);
  const actionDigest = parseApprovalProofDigest("00".repeat(32));
  if (
    !userId.ok ||
    !controlSessionId.ok ||
    !personId.ok ||
    !organisationId.ok ||
    actionDigest === null
  ) {
    throw new Error("invalid approval fixture");
  }
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: userId.value,
      personId: personId.value,
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: controlSessionId.value,
      authenticatedAt,
      challenge: {
        stepUpId: `fixture:${suffix}`,
        organisationId: organisationId.value,
        actionNonce: `action_${suffix}`,
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: authenticatedAt,
        expiresAt: authenticatedAt + 600_000,
      },
    },
  };
}

function actionLedgerTypeFixtures(
  entry: VariantBy<ActionLedgerEntry, "state", "proposed">,
): void {
  // @ts-expect-error Proposed actions cannot carry approval evidence.
  const invalidProposed: ActionLedgerEntry = {
    ...entry,
    approval: approvalEvidence("invalid", 1),
  };
  // @ts-expect-error Confirmed actions require a provider result.
  const invalidConfirmed: ActionLedgerEntry = {
    ...entry,
    state: "confirmed",
    approval: approvalEvidence("confirmed", 1),
  };
  // @ts-expect-error Rejected actions require typed merchant decision evidence.
  const invalidRejected: ActionLedgerEntry = {
    ...entry,
    state: "rejected",
  };
  // @ts-expect-error Executing actions require a durable execution lease.
  const invalidExecuting: ActionLedgerEntry = {
    ...entry,
    state: "executing",
    approval: approvalEvidence("executing", 1),
  };
  // @ts-expect-error Action proposals always target one integration account.
  const missingIntegrationAccount: ProposeActionInput = {
    organisationId: entry.action.organisationId,
    sessionId: entry.action.sessionId,
    threadId: entry.action.threadId,
    draft: {
      host: entry.action.host,
      verb: entry.action.verb,
      path: entry.action.path,
      argsHash: entry.action.argsHash,
      amount: entry.action.amount,
      resourceKey: entry.action.resourceKey,
    },
    exp: entry.action.exp,
    now: 1,
  };

  void invalidProposed;
  void invalidConfirmed;
  void invalidRejected;
  void invalidExecuting;
  void missingIntegrationAccount;
}

void actionLedgerTypeFixtures;
