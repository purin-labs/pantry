import {
  withCaseMutationExecution,
  admitCaseMutationFixture,
  allowCaseMutationFixture,
} from "./case-mutation-fixture";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";

vi.mock(
  "../src/policy/information-flow/source-labels",
  async function mockSourceLabels() {
    const { FlowLabel } = await import("../src/policy/information-flow/labels");
    const { sourceReaderForAuthority } =
      await import("../src/policy/information-flow/source-readers");
    return {
      createCurrentSourceFlowLabel: async function createFixtureSourceLabel(
        input: Readonly<{
          readonly kind: string;
          readonly authority: import("@seams/contracts").RequestAuthority;
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
import { parseOrganisationId } from "../src/ids";
import { digestCanonical } from "../src/policy";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { fixtureControlRequestAuthority } from "./fixtures/plan25-turn";
import { authorityPartitionKey } from "../src/authorization/access-grants/turn-authority";
import type { Variant } from "@seams/type-utils";
import { requireCaseId, requireOrganisationId } from "./test-ids";
import { platformEnv } from "./worker-fakes";

describe("Case context source reader", function caseContextSourceReaderSuite() {
  it("accepts a payout approval with account authority and rejects fabricated commerce provenance", async function payoutProposal() {
    const { actor } = actorFixture();
    const organisationId = parseOrganisationId("organisation_context_reader");
    if (!organisationId.ok) throw new Error(organisationId.error.code);
    const caseId = "case_payout_approval";
    await actor.ensure({
      identity: { organisationId: organisationId.value, caseId },
      purpose: "Resume payout funding",
      workspaceRevision: "payout:1",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    const proposal = {
      proposalId: "proposal_payout_approval",
      caseId,
      basedOnRevision: 0,
      requestAuthority: fixtureControlRequestAuthority({
        organisationId: organisationId.value,
        requesterPersonId: "person_context_reader",
        userId: "user_72e600ce-c5f5-50b8-8227-c018036e579e",
        role: "owner",
      }),
      action: {
        kind: "resume_supplier_payout_funding",
        payoutId: "payout_1",
        expectedPayoutRevision: 3,
        approvalDigest: "a".repeat(64),
        attemptId: "attempt_1",
        providerTransferId: "transfer_1",
      },
      authority: {
        kind: "integration_account",
        integrationAccountId: "integration_context_reader",
      },
      provenance: null,
      origin: {
        kind: "merchant_control",
        userId: "user_72e600ce-c5f5-50b8-8227-c018036e579e",
        controlSessionId: "control_session_context_reader",
      },
    };
    expect(
      await actor.acceptCommerceProposal(
        withCaseMutationExecution("organisation_context_reader", {
          proposal: { ...proposal, authority: { kind: "lab" } },
          acceptedAt: 1_001,
        }),
      ),
    ).toEqual({ ok: false, error: { code: "case_commerce_proposal_invalid" } });
    const accepted = await actor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_context_reader", {
        proposal,
        acceptedAt: 1_001,
        authorityPartition: await merchantInputAuthorityPartition(
          proposal.requestAuthority,
        ),
      }),
    );
    expect(accepted).toMatchObject({
      ok: true,
      value: { kind: "accepted", revision: 1 },
    });
    expect(
      await actor.waitForCommerceApproval(
        withCaseMutationExecution("organisation_context_reader", {
          caseId,
          proposalId: proposal.proposalId,
          actionNonce: "nonce_payout_approval",
          expectedCaseRevision: 1,
          requestedAt: 1_002,
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("reads one exact accepted trigger with authority-derived visibility", async function readsAcceptedTrigger() {
    const fixture = actorFixture();
    const caseActor = fixture.actor;
    await caseActor.ensure({
      identity: {
        organisationId: "organisation_context_reader",
        caseId: "case_context_reader",
      },
      purpose: "Project accepted context.",
      workspaceRevision: "workspace_context_reader_1",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    expect(
      await caseActor.acceptTrigger({
        triggerId: "trigger_context_reader",
        caseId: "case_context_reader",
        source: {
          kind: "connector",
          connectorId: "connector_context_reader",
          ingressId: "ingress_context_reader",
        },
        requestAuthority: {
          kind: "shared_conversation",
          organisationId: "organisation_context_reader",
          requesterPersonId: "person_context_reader",
          membershipRevision: 1,
          role: "operator",
          connectorId: "connector_context_reader",
          integrationAccountId: "integration_context_reader",
          conversationId: "C0CONTEXTREADER",
        },
        content: { kind: "text", text: "Accepted shared context." },
        acceptedAt: 1_001,
      }),
    ).toMatchObject({ ok: true, value: { kind: "accepted", revision: 1 } });
    await Promise.all(PROJECTION_WORK);
    expect(PROJECTION_COMMANDS).toEqual([
      {
        type: "context.projection.v1",
        organisationId: requireOrganisationId("organisation_context_reader"),
        source: {
          kind: "case_entry",
          caseId: requireCaseId("case_context_reader"),
          entryId: "trigger:trigger_context_reader",
        },
        sourceRevision: 1,
      },
    ]);
    await caseActor.attachBinding({
      bindingId: "binding_context_reader",
      caseId: "case_context_reader",
      connectorId: "connector_context_reader",
      address: {
        kind: "slack",
        workspaceId: "T0CONTEXTREADER",
        channelId: "C0CONTEXTREADER",
        threadTs: "1785700000.000001",
      },
    });

    expect(
      await caseActor.read({
        organisationId: requireOrganisationId("organisation_context_reader"),
        source: {
          kind: "case_entry",
          caseId: "case_context_reader",
          entryId: "trigger:trigger_context_reader",
        },
        sourceRevision: 1,
      }),
    ).toEqual({
      ok: true,
      value: {
        organisationId: "organisation_context_reader",
        source: {
          kind: "case_entry",
          caseId: "case_context_reader",
          entryId: "trigger:trigger_context_reader",
        },
        sourceRevision: 1,
        replayAuthority: { kind: "partition_independent" },
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        content: { kind: "text", text: "Accepted shared context." },
        visibility: {
          kind: "conversation",
          integrationAccountId: "integration_context_reader",
          conversationId: "C0CONTEXTREADER",
        },
        inputLabel: expect.objectContaining({
          policies: [
            expect.objectContaining({
              owner: {
                kind: "organisation",
                organisationId: "organisation_context_reader",
              },
              readers: [
                {
                  kind: "conversation",
                  integrationAccountId: "integration_context_reader",
                  conversationId: "C0CONTEXTREADER",
                },
              ],
            }),
          ],
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        observedAt: 1_001,
      },
    });

    expect(
      await caseActor.readTail({
        organisationId: requireOrganisationId("organisation_context_reader"),
        caseId: requireCaseId("case_context_reader"),
        authorityPartitionDigest: "a".repeat(64),
        visibility: [
          {
            kind: "conversation",
            integrationAccountId: "integration_context_reader",
            conversationId: "C0CONTEXTREADER",
          },
        ],
        limit: 5,
      }),
    ).toEqual([
      {
        organisationId: "organisation_context_reader",
        source: {
          kind: "case_entry",
          caseId: "case_context_reader",
          entryId: "trigger:trigger_context_reader",
        },
        replayAuthority: { kind: "partition_independent" },
        sourceRevision: 1,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        boundedExcerpt: "Accepted shared context.",
        inputLabel: expect.objectContaining({
          policies: expect.arrayContaining([
            expect.objectContaining({
              owner: {
                kind: "organisation",
                organisationId: "organisation_context_reader",
              },
              readers: [
                {
                  kind: "conversation",
                  integrationAccountId: "integration_context_reader",
                  conversationId: "C0CONTEXTREADER",
                },
              ],
            }),
          ]),
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        observedAt: 1_001,
      },
    ]);
    expect(
      await caseActor.readTail({
        organisationId: requireOrganisationId("organisation_context_reader"),
        caseId: requireCaseId("case_context_reader"),
        authorityPartitionDigest: "a".repeat(64),
        visibility: [{ kind: "person", personId: "person_context_reader" }],
        limit: 5,
      }),
    ).toEqual([]);
  });

  it("filters an incompatible authority partition before applying the tail limit", async function filtersBeforeTailLimit() {
    const fixture = actorFixture();
    const caseActor = fixture.actor;
    await caseActor.ensure({
      identity: {
        organisationId: "organisation_context_reader",
        caseId: "case_context_reader",
      },
      purpose: "Filter incompatible context.",
      workspaceRevision: "workspace_context_reader_1",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    const requestAuthority = {
      kind: "shared_conversation" as const,
      organisationId: "organisation_context_reader",
      requesterPersonId: "person_context_reader",
      membershipRevision: 1,
      role: "operator" as const,
      connectorId: "connector_context_reader",
      integrationAccountId: "integration_context_reader",
      conversationId: "C0CONTEXTREADER",
    };
    for (const [triggerId, acceptedAt] of [
      ["trigger_context_reader_old", 1_001],
      ["trigger_context_reader_new", 1_002],
    ] as const) {
      expect(
        await caseActor.acceptTrigger({
          triggerId,
          caseId: "case_context_reader",
          source: {
            kind: "connector",
            connectorId: "connector_context_reader",
            ingressId: `ingress_${triggerId}`,
          },
          requestAuthority,
          content: { kind: "text", text: triggerId },
          acceptedAt,
        }),
      ).toMatchObject({ ok: true });
    }
    fixture.sql.exec(
      "UPDATE case_journal SET authority_scope_json = ? WHERE entry_id = ?",
      JSON.stringify({
        kind: "authority_partition",
        authorityPartitionDigest: "b".repeat(64),
      }),
      "trigger:trigger_context_reader_new",
    );

    const tail = await caseActor.readTail({
      organisationId: requireOrganisationId("organisation_context_reader"),
      caseId: requireCaseId("case_context_reader"),
      authorityPartitionDigest: "a".repeat(64),
      visibility: [
        {
          kind: "conversation",
          integrationAccountId: "integration_context_reader",
          conversationId: "C0CONTEXTREADER",
        },
      ],
      limit: 1,
    });
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({
      source: {
        entryId: "trigger:trigger_context_reader_old",
      },
      replayAuthority: { kind: "partition_independent" },
    });
  });

  it("rejects triggers without canonical request authority", async function rejectsMissingAuthority() {
    const caseActor = actor();
    await caseActor.ensure({
      identity: {
        organisationId: "organisation_context_reader",
        caseId: "case_context_reader",
      },
      purpose: "Reject incomplete context.",
      workspaceRevision: "workspace_context_reader_1",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    expect(
      await caseActor.acceptTrigger({
        triggerId: "trigger_context_reader",
        caseId: "case_context_reader",
        source: {
          kind: "connector",
          connectorId: "connector_context_reader",
          ingressId: "ingress_context_reader",
        },
        content: { kind: "text", text: "Incomplete context." },
        acceptedAt: 1_001,
      }),
    ).toEqual({ ok: false, error: { code: "case_trigger_invalid" } });
  });

  it("projects a commerce outcome with proposal authority and its accepted timestamp", async function readsAcceptedCommerceOutcome() {
    const fixture = actorFixture();
    const caseActor = fixture.actor;
    const caseId = "case_context_commerce_outcome";
    const organisationId = parseOrganisationId("organisation_context_reader");
    if (!organisationId.ok) throw new Error(organisationId.error.code);
    const requestAuthority = fixtureControlRequestAuthority({
      organisationId: organisationId.value,
      requesterPersonId: "person_context_reader",
      userId: "user_72e600ce-c5f5-50b8-8227-c018036e579e",
      role: "owner",
    });
    const proposal = {
      proposalId: "proposal_context_commerce_outcome",
      caseId,
      basedOnRevision: 0,
      requestAuthority,
      action: {
        kind: "cancel_order" as const,
        resourceId: "order_context_reader",
        expectedRevision: 1,
        reason: "customer_requested" as const,
        refund: "none" as const,
        restock: false,
        notifyCustomer: false,
        note: null,
      },
      authority: { kind: "lab" as const },
      provenance: {
        organisationId: "organisation_context_reader",
        integrationAccountId: "integration_context_reader",
        source: "lab" as const,
        resourceType: "commerce_order",
        resourceId: "order_context_reader",
        revision: 1,
        occurredAt: "2026-08-20T00:00:00.000Z",
        observedAt: "2026-08-20T00:00:00.000Z",
      },
      origin: {
        kind: "merchant_control" as const,
        userId: "user_72e600ce-c5f5-50b8-8227-c018036e579e",
        controlSessionId: "control_session_context_reader",
      },
    };
    await caseActor.ensure({
      identity: { organisationId: "organisation_context_reader", caseId },
      purpose: "Project commerce outcome context.",
      workspaceRevision: "workspace_context_reader_1",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    const proposalAcceptance = await caseActor.acceptCommerceProposal(
      withCaseMutationExecution("organisation_context_reader", {
        proposal,
        acceptedAt: 1_001,
        authorityPartition: await merchantInputAuthorityPartition(
          proposal.requestAuthority,
        ),
      }),
    );
    expect(proposalAcceptance).toMatchObject({
      ok: true,
      value: { kind: "accepted", revision: 1 },
    });
    if (!proposalAcceptance.ok) throw new Error(proposalAcceptance.error.code);
    const outcomeAccepted = await caseActor.acceptCommerceOutcome({
      caseId,
      proposalId: proposal.proposalId,
      actionNonce: "nonce_context_commerce_outcome",
      outcome: {
        kind: "provider_receipt" as const,
        receipt: {
          kind: "commerce_provider_receipt" as const,
          provider: "lab" as const,
          receiptId: "receipt_context_commerce_outcome",
          effectId: "effect_context_commerce_outcome",
          actionNonce: "nonce_context_commerce_outcome",
          eventId: "event_context_commerce_outcome",
          resourceId: "order_context_reader",
          projectionKind: "commerce_order" as const,
          revision: 1,
          status: "settled" as const,
          flowBindingDigest: await digestCanonical(
            proposalAcceptance.value.flowBinding,
          ),
          decisionDigest: "d".repeat(64),
          observedAt: "2026-08-20T00:00:01.000Z",
        },
      },
      content: { kind: "text", text: "Commerce order cancelled." },
      acceptedAt: 1_002,
    });
    if (!outcomeAccepted.ok) throw new Error(outcomeAccepted.error.code);
    expect(outcomeAccepted).toMatchObject({
      ok: true,
      value: { kind: "accepted", revision: 2 },
    });
    expect(PROJECTION_COMMANDS).toHaveLength(2);
    expect(PROJECTION_COMMANDS[1]).toMatchObject({
      type: "context.projection.v1",
      source: {
        kind: "case_entry",
        caseId,
        entryId: "commerce_outcome:nonce_context_commerce_outcome",
      },
    });

    const projectedOutcome = await caseActor.read({
      organisationId: requireOrganisationId("organisation_context_reader"),
      source: {
        kind: "case_entry",
        caseId,
        entryId: "commerce_outcome:nonce_context_commerce_outcome",
      },
      sourceRevision: 2,
    });
    const storedScope =
      fixture.sql
        .exec<{ readonly authority_scope_json: string | null }>(
          "SELECT authority_scope_json FROM case_journal WHERE entry_id = ?",
          "commerce_outcome:nonce_context_commerce_outcome",
        )
        .toArray()[0]?.authority_scope_json ?? null;
    expect(storedScope).toBe(
      JSON.stringify({
        kind: "authority_partition",
        authorityPartitionDigest:
          proposalAcceptance.value.flowBinding.authorityPartitionDigest,
      }),
    );
    expect(projectedOutcome).toEqual({
      ok: true,
      value: {
        organisationId: "organisation_context_reader",
        source: {
          kind: "case_entry",
          caseId,
          entryId: "commerce_outcome:nonce_context_commerce_outcome",
        },
        sourceRevision: 2,
        replayAuthority: {
          kind: "authority_partition",
          authorityPartitionDigest:
            proposalAcceptance.value.flowBinding.authorityPartitionDigest,
        },
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        content: { kind: "text", text: "Commerce order cancelled." },
        visibility: { kind: "person", personId: "person_context_reader" },
        inputLabel: {
          policies: [
            {
              owner: {
                kind: "organisation",
                organisationId: "organisation_context_reader",
              },
              readers: [{ kind: "person", personId: "person_context_reader" }],
            },
          ],
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        observedAt: 1_002,
      },
    });
  });
});

function actor(): CaseDO {
  return actorFixture().actor;
}

function actorFixture(): { readonly actor: CaseDO; readonly sql: SqlStorage } {
  PROJECTION_COMMANDS.length = 0;
  PROJECTION_WORK.length = 0;
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = new TestStorage(fixture.database, sql);
  return {
    actor: new CaseDO(
      { storage, waitUntil: retainProjectionWork } as unknown as DurableObjectState,
      platformEnv({ EVENT_Q: { send: recordProjectionCommand } }),
    ),
    sql,
  };
}

const PROJECTION_COMMANDS: unknown[] = [];
const PROJECTION_WORK: Promise<unknown>[] = [];

function retainProjectionWork(work: Promise<unknown>): void {
  PROJECTION_WORK.push(work);
}

async function recordProjectionCommand(message: unknown): Promise<void> {
  PROJECTION_COMMANDS.push(message);
}

class TestStorage {
  readonly setAlarm = vi.fn().mockResolvedValue(undefined);
  readonly deleteAlarm = vi.fn().mockResolvedValue(undefined);
  constructor(
    private readonly database: ReturnType<
      typeof emptySqliteFixture
    >["database"],
    readonly sql: SqlStorage,
  ) {}

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

async function merchantInputAuthorityPartition(
  requestAuthority: Variant<
    import("@seams/contracts").RequestAuthority,
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

vi.mock(
  "../src/actors/actor-activation",
  async function caseRecoveryMock(importOriginal) {
    const original =
      await importOriginal<typeof import("../src/actors/actor-activation")>();
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
