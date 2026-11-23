import {
  withCaseMutationExecution,
  admitCaseMutationFixture,
  allowCaseMutationFixture,
} from "./case-mutation-fixture";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";
import { CaseDO } from "../src/actors/case";
import {
  fixtureControlRequestAuthority,
  fixtureFlowBinding,
} from "./fixtures/plan25-turn";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireOrganisationId } from "./test-ids";
import { platformEnv } from "./worker-fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObjectMock<Bindings> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Bindings;
    constructor(ctx: DurableObjectState, env: Bindings) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class WorkerEntrypointMock {},
}));

describe("commerce entity-plane Case replay binding", () => {
  it("rejects an identical proposal replay with changed flow binding", async () => {
    const fixture = actorFixture();
    const organisationId = "organisation_entity_plane_case";
    const caseId = "case_entity_plane_case";
    const proposalId = "proposal_entity_plane_case";
    await fixture.actor.ensure({
      identity: { organisationId, caseId },
      purpose: "Entity-plane replay binding",
      workspaceRevision: "commerce:entity-plane",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    const request = {
      proposal: {
        kind: "entity_plane" as const,
        proposalId,
        caseId,
        basedOnRevision: 0,
        requestAuthority: fixtureControlRequestAuthority({
          organisationId: requireOrganisationId(organisationId),
          requesterPersonId: "person_entity_plane_case",
          userId: "user_0cc12df1-115d-5a5f-991f-1428ab64fd6a",
          role: "owner",
        }),
        proposal: {
          kind: "patch_custom_entity" as const,
          entityRef: {
            origin: "custom" as const,
            typeId: "customer",
            entityId: "customer_1",
          },
          typeRevision: 1,
          expectedRevision: 1,
          attributes: [],
          displayName: null,
        },
        origin: {
          kind: "merchant_control" as const,
          userId: "user_0cc12df1-115d-5a5f-991f-1428ab64fd6a",
          controlSessionId: "control_session_entity_plane_case",
        },
      },
      acceptedAt: 1_001,
      flowBinding: fixtureFlowBinding({
        organisationId,
        sessionId: "control_session_entity_plane_case",
        turnId: `merchant:${proposalId}`,
        authorityPartitionDigest: "a".repeat(64),
      }),
    };

    expect(
      await fixture.actor.acceptCommerceProposal(
        withCaseMutationExecution(organisationId, request),
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: "accepted", revision: 1 },
    });
    expect(
      await fixture.actor.acceptCommerceProposal(
        withCaseMutationExecution(organisationId, request),
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: "already_accepted", revision: 1 },
    });
    expect(
      fixture.sql
        .exec<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM case_commerce_proposal WHERE proposal_id = ?",
          proposalId,
        )
        .toArray(),
    ).toEqual([{ count: 1 }]);
    expect(
      await fixture.actor.acceptCommerceProposal(
        withCaseMutationExecution(organisationId, {
          ...request,
          flowBinding: fixtureFlowBinding({
            organisationId,
            sessionId: "control_session_entity_plane_other",
            turnId: `merchant:${proposalId}`,
            authorityPartitionDigest: "b".repeat(64),
          }),
        }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "case_entity_plane_proposal_conflict" },
    });
  });

  it("uses the ordinary approval lifecycle for an accepted entity-plane proposal", async () => {
    const fixture = actorFixture();
    const organisationId = "organisation_entity_plane_approval";
    const caseId = "case_entity_plane_approval";
    const proposalId = "proposal_entity_plane_approval";
    await fixture.actor.ensure({
      identity: { organisationId, caseId },
      purpose: "Entity-plane approval lifecycle",
      workspaceRevision: "commerce:entity-plane",
      lifecycle: { kind: "open", openedAt: 1_000 },
    });
    const accepted = await fixture.actor.acceptCommerceProposal(
      withCaseMutationExecution(organisationId, {
        proposal: {
          kind: "entity_plane",
          proposalId,
          caseId,
          basedOnRevision: 0,
          requestAuthority: fixtureControlRequestAuthority({
            organisationId: requireOrganisationId(organisationId),
            requesterPersonId: "person_entity_plane_approval",
            userId: "user_129a962d-25e8-5610-9a0a-1e9364f11eee",
            role: "owner",
          }),
          proposal: {
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
          },
          origin: {
            kind: "merchant_control",
            userId: "user_129a962d-25e8-5610-9a0a-1e9364f11eee",
            controlSessionId: "control_session_entity_plane_approval",
          },
        },
        acceptedAt: 1_001,
        flowBinding: fixtureFlowBinding({
          organisationId,
          sessionId: "control_session_entity_plane_approval",
          turnId: `merchant:${proposalId}`,
          authorityPartitionDigest: "a".repeat(64),
        }),
      }),
    );
    expect(accepted).toMatchObject({ ok: true, value: { revision: 1 } });

    expect(
      await fixture.actor.waitForCommerceApproval(
        withCaseMutationExecution(organisationId, {
          caseId,
          proposalId,
          actionNonce: "nonce_entity_plane_approval",
          expectedCaseRevision: 1,
          requestedAt: 1_002,
        }),
      ),
    ).toMatchObject({ ok: true, value: { kind: "waiting", revision: 2 } });
  });
});

function actorFixture(): {
  readonly actor: CaseDO;
  readonly sql: ReturnType<typeof sqlStorage>;
} {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = {
    sql,
    transactionSync<Value>(callback: () => Value): Value {
      fixture.database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        fixture.database.exec("COMMIT");
        return value;
      } catch (error) {
        fixture.database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const state = { storage } as unknown as DurableObjectState;
  const env = platformEnv({ EVENT_Q: { send: async () => undefined } });
  return { actor: new CaseDO(state, env), sql };
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
  "@purin-labs/conversation/actors/action-mutation-execution",
  async function caseAuthorityMock(importOriginal) {
    const original =
      await importOriginal<
        typeof import("@purin-labs/conversation/actors/action-mutation-execution")
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
