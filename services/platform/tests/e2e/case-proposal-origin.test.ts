import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { sha256Hex } from "@purin-labs/std";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  admitOperatorControlTurnFixture,
  requireOrganisationExecutionScope,
} from "../organisation-execution-fixture";
import {
  issueControlSession,
  type ActiveControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { parseCaseId } from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { resolveActiveCaseActor } from "../../src/actors/actor-router";
import { authorityPartitionKey } from "../../src/authorization/access-grants/turn-authority";
import { fixtureFlowBinding } from "../fixtures/plan25-turn";
import {
  controlActionMutationExecution,
  type ActionMutationExecution,
} from "../../src/actors/action-mutation-execution";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";

type Boundary = "session_origin" | "placement" | "approval_wait";
type Pause = {
  phase: "armed" | "paused" | "released";
  digest: SubtleCrypto["digest"];
};
let pause: Pause | null = null;
it.for(["session_origin", "placement", "approval_wait"] as const)(
  "fences Case %s and preserves replay through native eviction",
  { timeout: 60_000 },
  caseProposalJourney,
);

async function caseProposalJourney(boundary: Boundary, { task }: TestContext) {
  await installSlackActorFixture();
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  const caseId = parseCaseId(`case_origin_${boundary}`);
  if (!userId.ok || !caseId.ok) throw new Error("Invalid Case identity");
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
    ).bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase().prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'case-origin-fixture', activated_at = ? WHERE organisation_id = ?",
    ).bind(Date.now(), ORGANISATION_ID),
  ]);
  const session = await issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const resolved = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  const source = resolved.value;
  let actor = source;
  expect(
    await actor.ensure({
      identity: { organisationId: ORGANISATION_ID, caseId: caseId.value },
      purpose: "Review cancellation",
      workspaceRevision: "case-origin-fixture",
      lifecycle: { kind: "open", openedAt: Date.now() },
    }),
  ).toMatchObject({ ok: true });
  const input = await caseProposalInput(
    actor,
    caseId.value,
    session.session,
    boundary === "session_origin",
    "original",
  );
  if (boundary === "approval_wait") {
    const accepted = await actor.acceptCommerceProposal(input);
    if (!accepted.ok) throw new Error(accepted.error.code);
    await revokeCaseOrigin(session.session);
    const waiting = {
      execution: input.execution,
      caseId: caseId.value,
      proposalId: input.proposal.proposalId,
      actionNonce: "nonce_case_origin",
      expectedCaseRevision: accepted.value.revision,
      requestedAt: Date.now(),
    };
    expect(await actor.waitForCommerceApproval(waiting)).toMatchObject({
      ok: false,
      error: { code: "case_execution_authority_inactive" },
    });
    await evictDurableObject(actor);
    expect(await actor.waitForCommerceApproval(waiting)).toMatchObject({
      ok: false,
    });
    expect(await actor.inspect()).toMatchObject({
      ok: true,
      value: { revision: accepted.value.revision, lifecycle: { kind: "open" } },
    });
    const fresh = await issueControlSession({
      db: env.DB,
      userId: userId.value,
      now: Date.now(),
      ttlMs: 600_000,
    });
    const authority = await controlActionMutationExecution(
      env,
      ORGANISATION_ID,
      fresh.session,
    );
    if (!authority.ok) throw new Error(authority.error.code);
    const resumed = {
      execution: authority.value,
      caseId: waiting.caseId,
      proposalId: waiting.proposalId,
      actionNonce: waiting.actionNonce,
      expectedCaseRevision: waiting.expectedCaseRevision,
      requestedAt: waiting.requestedAt,
    };
    expect(await actor.waitForCommerceApproval(resumed)).toMatchObject({
      ok: true,
      value: { kind: "waiting" },
    });
    await evictDurableObject(actor);
    expect(await actor.waitForCommerceApproval(resumed)).toMatchObject({
      ok: true,
      value: { kind: "already_waiting" },
    });
  } else {
    const probe: Pause = { phase: "armed", digest: crypto.subtle.digest };
    pause = probe;
    crypto.subtle.digest = pauseCaseDigest;
    const work = actor.acceptCommerceProposal(input);
    try {
      await expect.poll(casePausePhase.bind(null, probe)).toBe("paused");
      if (boundary === "placement") {
        const target = parseOrganisationPlacementMoveTarget({
          kind: "affinity",
          placementCellId: "e2e",
          locationHint: "wnam",
        });
        if (!target.ok) throw new Error(target.error.code);
        const started = await startActorRelocation({
          env,
          organisationId: ORGANISATION_ID,
          target: target.value,
          now: Date.now(),
        });
        if (!started.ok) throw new Error(started.error.code);
        const moving = resumeActorRelocation({
          env,
          relocationId: started.value.relocationId,
          now: Date.now(),
        });
        // Publication cannot overtake the paused Case mutation.
        await expect.poll(casePlacementStatus).toBe("frozen");
        probe.phase = "released";
        expect(await work).toMatchObject({ ok: false });
        expect(await moving).toMatchObject({
          ok: true,
          value: { status: "retained" },
        });
        const targetActor = await resolveActiveCaseActor({
          env,
          namespace: env.CASE,
          organisationId: ORGANISATION_ID,
          caseId: caseId.value,
          now: Date.now(),
        });
        if (!targetActor.ok) throw new Error(targetActor.error.code);
        actor = targetActor.value;
        expect(await source.acceptCommerceProposal(input)).toMatchObject({
          ok: false,
        });
      } else {
        await revokeCaseOrigin(session.session);
        probe.phase = "released";
        expect(await work).toMatchObject({
          ok: false,
          error: { code: "case_execution_authority_inactive" },
        });
      }
      await evictDurableObject(actor);
      expect(await actor.acceptCommerceProposal(input)).toMatchObject({
        ok: false,
      });
      expect(await actor.inspect()).toMatchObject({
        ok: true,
        value: { revision: 0, entries: [] },
      });
      const fresh = await issueControlSession({
        db: env.DB,
        userId: userId.value,
        now: Date.now(),
        ttlMs: 600_000,
      });
      const authorized = await caseProposalInput(
        actor,
        caseId.value,
        fresh.session,
        false,
        "fresh",
      );
      const accepted = await actor.acceptCommerceProposal(authorized);
      expect(accepted).toMatchObject({ ok: true, value: { revision: 1 } });
      await evictDurableObject(actor);
      expect(await actor.acceptCommerceProposal(authorized)).toMatchObject({
        ok: true,
        value: { kind: "already_accepted", revision: 1 },
      });
      expect(await actor.inspect()).toMatchObject({
        ok: true,
        value: { revision: 1, entries: [expect.anything()] },
      });
    } finally {
      probe.phase = "released";
      crypto.subtle.digest = probe.digest;
      await work;
      pause = null;
    }
  }
  Object.assign(task.meta, {
    caseProposalOrigin: {
      boundary,
      nativeEviction: true,
      staleCommitDenied: true,
      freshContinuation: true,
      duplicateJournalEntries: 0,
    },
  });
}
async function casePlacementStatus() {
  const row = await env.DB.prepare(
    "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 1",
  )
    .bind(ORGANISATION_ID)
    .first<{ status: string }>();
  return row?.status;
}
async function revokeCaseOrigin(session: ActiveControlSession) {
  await env.DB.prepare(
    "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
  )
    .bind(Date.now(), session.controlSessionId)
    .run();
}
function casePausePhase(probe: Pause) {
  return probe.phase;
}
async function pauseCaseDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const probe = pause;
  if (probe === null) throw new Error("Missing Case pause");
  const result = await probe.digest.call(this, algorithm, data);
  if (probe.phase === "armed") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  return result;
}
async function caseProposalInput(
  actor: DurableObjectStub<
    import("../../src/actors/case").CaseDO
  >,
  caseId: string,
  session: ActiveControlSession,
  fromSession: boolean,
  suffix: string,
) {
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const turn = await admitOperatorControlTurnFixture(
    env,
    ORGANISATION_ID,
    session.userId,
    session.controlSessionId,
  );
  const partition = {
    key: authorityPartitionKey(turn.requestAuthority),
    selectedGrantSetDigest: "a".repeat(64),
    capabilityKeys: [],
    policyVersion: "policy_1",
  };
  const authorityPartition = {
    ...partition,
    digest: await sha256Hex(JSON.stringify(partition)),
  };
  const control = await controlActionMutationExecution(env, ORGANISATION_ID, session);
  if (!control.ok) throw new Error(control.error.code);
  const now = Date.now();
  const proposalId = `proposal_${caseId}_${suffix}`;
  const action = {
    kind: "cancel_order" as const,
    resourceId: "order_origin",
    expectedRevision: 1,
    reason: "customer_requested" as const,
    refund: "none" as const,
    restock: false,
    notifyCustomer: false,
    note: null,
    description: null,
    fulfillmentId: null,
    fulfillmentRevision: null,
    shipmentId: null,
    shipmentRevision: null,
    trackingNumber: null,
  };
  const provenance = {
    organisationId: ORGANISATION_ID,
    integrationAccountId: "integration_lab",
    source: "lab" as const,
    resourceType: "commerce_order" as const,
    resourceId: "order_origin",
    revision: 1,
    occurredAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
  };
  if (fromSession) {
    const snapshot = await actor.inspect();
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const assignmentId = `assignment_${caseId}_${suffix}`;
    expect(
      await actor.assignSession({
        assignmentId,
        caseId,
        caseRevision: 0,
        sessionId: turn.sessionId,
        role: "coordinator",
        objective: { instruction: "Review cancellation" },
        authority: {
          capabilityProfile: "read_and_propose",
          authorityPartitionDigest: authorityPartition.digest,
        },
        authorityPartition,
        budget: {
          budgetRevision: "budget_1",
          maxTokens: 1000,
          maxWallMs: 60000,
          maxToolCalls: 10,
        },
        context: {
          evidenceDependency: { kind: "source_only" },
          caseId,
          revision: 0,
          journalCursor: snapshot.value.journalCursor,
          workspaceRevision: "case-origin-fixture",
          entries: [],
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await actor.beginAssignment({
        caseId,
        assignmentId,
        sessionId: turn.sessionId,
        expectedCaseRevision: 0,
        start: {
          startId: `start_${turn.turnId}`,
          sessionId: turn.sessionId,
          acceptedAt: now,
        },
      }),
    ).toMatchObject({ ok: true });
    const execution: ActionMutationExecution = {
      kind: "session_turn",
      execution: turn,
      organisationId: ORGANISATION_ID,
      placement: scope.placement,
      fenceToken: scope.fenceToken,
      deadlineAt: now + 60000,
    };
    return {
      execution,
      proposal: {
        proposalId,
        caseId,
        basedOnRevision: 0,
        requestAuthority: turn.requestAuthority,
        action,
        authority: { kind: "lab" as const },
        provenance,
        origin: {
          kind: "agent_session" as const,
          sessionId: turn.sessionId,
          assignmentId,
          threadId: caseId,
        },
      },
      acceptedAt: now,
      flowBinding: fixtureFlowBinding({
        organisationId: ORGANISATION_ID,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        authorityPartitionDigest: authorityPartition.digest,
      }),
    };
  }
  return {
    execution: control.value,
    proposal: {
      proposalId,
      caseId,
      basedOnRevision: 0,
      requestAuthority: turn.requestAuthority,
      action,
      authority: { kind: "lab" as const },
      provenance,
      origin: {
        kind: "merchant_control" as const,
        userId: session.userId,
        controlSessionId: session.controlSessionId,
      },
    },
    acceptedAt: now,
    authorityPartition,
  };
}
