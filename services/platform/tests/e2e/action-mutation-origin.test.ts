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
import { parseCaseId, parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { authorityPartitionKey } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { fixtureFlowBinding } from "../fixtures/plan25-turn";
import { FlowLabel } from "@purin-labs/authority/policy/information-flow/index";
import type { ProposeActionInput } from "@purin-labs/authority/actors/action-ledger";
import type { ActionMutationExecution } from "../../src/actors/action-mutation-execution";

type Pause = {
  phase: "armed" | "paused" | "released";
  digest: SubtleCrypto["digest"];
};
let pause: Pause | null = null;
it.for(["origin", "placement", "approval"] as const)(
  "retains action authority through %s, eviction and fresh authorized continuation",
  { timeout: 45_000 },
  actionMutationJourney,
);

async function actionMutationJourney(
  boundary: "origin" | "placement" | "approval",
  { task }: TestContext,
) {
  await installSlackActorFixture();
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!userId.ok) throw new Error(userId.error.code);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'action-origin-fixture', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), ORGANISATION_ID),
  ]);
  const session = await issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const input = await actionInput(session.session, `action_${boundary}`);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  if (boundary === "approval") {
    const proposed = await organisation.proposeAction(input);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    await revokeOrigin(session.session);
    const request = {
      organisationId: ORGANISATION_ID,
      nonce: proposed.value.action.nonce.value,
      execution: input.execution,
      now: Date.now(),
    };
    expect(await organisation.requestActionApproval(request)).toMatchObject({
      ok: false,
      error: { code: "invalid_action", field: "execution" },
    });
    await evictDurableObject(organisation);
    expect(await organisation.requestActionApproval(request)).toMatchObject({
      ok: false,
    });
    expect(await organisation.getAction(request)).toMatchObject({
      ok: true,
      value: { state: "proposed" },
    });
    const freshSession = await issueControlSession({
      db: env.DB,
      userId: userId.value,
      now: Date.now(),
      ttlMs: 600_000,
    });
    const fresh = await actionInput(freshSession.session, "fresh_approval");
    const approved = await organisation.requestActionApproval({
      organisationId: ORGANISATION_ID,
      nonce: request.nonce,
      execution: fresh.execution,
      now: Date.now(),
    });
    expect(approved).toMatchObject({
      ok: true,
      value: { state: "approval_requested" },
    });
    await evictDurableObject(organisation);
    expect(
      await organisation.requestActionApproval({
        organisationId: ORGANISATION_ID,
        nonce: request.nonce,
        execution: fresh.execution,
        now: Date.now(),
      }),
    ).toEqual(approved);
  } else {
    // The proposal pauses at the first hash it computes: the restore of its
    // flow label, before any authority check. A restored label is remembered
    // by its text, so the in-flight proposal carries a label of its own.
    const inFlight = {
      ...input,
      flowBinding: {
        ...input.flowBinding,
        flowLabel: await inFlightFlowLabel(boundary),
      },
    };
    const probe: Pause = { phase: "armed", digest: crypto.subtle.digest };
    pause = probe;
    crypto.subtle.digest = pauseActionDigest;
    const work = organisation.proposeAction(inFlight);
    try {
      await expect.poll(actionPhase.bind(null, probe)).toBe("paused");
      if (boundary === "origin") await revokeOrigin(session.session);
      else
        for (const database of [env.DB, fixtureDatabase()])
          await database
            .prepare(
              "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND status = 'active'",
            )
            .bind(Date.now(), ORGANISATION_ID)
            .run();
      probe.phase = "released";
      expect(await work).toMatchObject({ ok: false });
      await evictDurableObject(organisation);
      expect(await organisation.proposeAction(inFlight)).toMatchObject({
        ok: false,
      });
      if (boundary === "placement") {
        expect(
          await organisation.readActionActivity({
            organisationId: ORGANISATION_ID,
            resourceKey: null,
            limit: 20,
          }),
        ).toMatchObject({
          ok: false,
          error: { code: "organisation_placement_conflict" },
        });
        for (const database of [env.DB, fixtureDatabase()])
          await database
            .prepare(
              "UPDATE organisation_placement SET status = 'active', frozen_at = NULL WHERE organisation_id = ? AND status = 'frozen'",
            )
            .bind(ORGANISATION_ID)
            .run();
      }
      expect(
        await organisation.readActionActivity({
          organisationId: ORGANISATION_ID,
          resourceKey: null,
          limit: 20,
        }),
      ).toMatchObject({ ok: true, value: [] });
      const freshSession = await issueControlSession({
        db: env.DB,
        userId: userId.value,
        now: Date.now(),
        ttlMs: 600_000,
      });
      const fresh = await actionInput(freshSession.session, "fresh_action");
      const proposed = await organisation.proposeAction(fresh);
      expect(proposed).toMatchObject({
        ok: true,
        value: { state: "proposed" },
      });
      await evictDurableObject(organisation);
      expect(await organisation.proposeAction(fresh)).toEqual(proposed);
      expect(
        await organisation.readActionActivity({
          organisationId: ORGANISATION_ID,
          resourceKey: null,
          limit: 20,
        }),
      ).toMatchObject({
        ok: true,
        value: [expect.objectContaining({ state: "proposed" })],
      });
    } finally {
      probe.phase = "released";
      crypto.subtle.digest = probe.digest;
      await work;
      pause = null;
    }
  }
  Object.assign(task.meta, {
    actionOrigin: {
      boundary,
      nativeEviction: true,
      staleMutationDenied: true,
      freshMutationCompleted: true,
      duplicateMutation: false,
    },
  });
}
async function revokeOrigin(session: ActiveControlSession) {
  await env.DB.prepare(
    "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
  )
    .bind(Date.now(), session.controlSessionId)
    .run();
}
/** A flow label that no other proposal carries, and so no restore has seen. */
async function inFlightFlowLabel(boundary: string) {
  const label = await FlowLabel.create([
    {
      owner: {
        kind: "integration_resource",
        organisationId: ORGANISATION_ID,
        integrationAccountId: "integration_action_origin",
        resourceScope: `in_flight_${boundary}_${crypto.randomUUID()}`,
      },
      readers: [{ kind: "person", personId: "person_e2e-slack-actor" }],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  return label.value.toJSON();
}
function actionPhase(probe: Pause) {
  return probe.phase;
}
async function pauseActionDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const probe = pause;
  if (probe === null) throw new Error("Missing action pause");
  const result = await probe.digest.call(this, algorithm, data);
  if (probe.phase === "armed") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  return result;
}
async function actionInput(
  session: ActiveControlSession,
  id: string,
): Promise<ProposeActionInput & { execution: ActionMutationExecution }> {
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const execution = await admitOperatorControlTurnFixture(
    env,
    ORGANISATION_ID,
    session.userId,
    session.controlSessionId,
  );
  const account = parseIntegrationAccountId("integration_action_origin");
  const caseId = parseCaseId(`case_${id}`);
  if (!account.ok || !caseId.ok) throw new Error("Invalid action identity");
  const partition = {
    key: authorityPartitionKey(execution.requestAuthority),
    selectedGrantSetDigest: "a".repeat(64),
    capabilityKeys: [`provider:commerce.action.propose:1:${account.value}:*`],
    policyVersion: "policy_1",
  };
  const authorityPartition = {
    ...partition,
    digest: await sha256Hex(JSON.stringify(partition)),
  };
  const now = Date.now();
  return {
    execution: {
      kind: "session_turn",
      execution,
      organisationId: ORGANISATION_ID,
      placement: scope.placement,
      fenceToken: scope.fenceToken,
      deadlineAt: now + 60_000,
    },
    organisationId: ORGANISATION_ID,
    integrationAccountId: account.value,
    requestAuthority: execution.requestAuthority,
    authorityPartition,
    authority: { kind: "integration_account" },
    caseId: caseId.value,
    proposalId: id,
    sessionId: execution.sessionId,
    threadId: caseId.value,
    draft: {
      host: "commerce.lab",
      verb: "commerce.publish_catalog_listing",
      path: "/offers/offer_origin/publish",
      argsHash: "b".repeat(64),
      amount: null,
      resourceKey: "offer_origin",
    },
    flowBinding: fixtureFlowBinding({
      organisationId: ORGANISATION_ID,
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      authorityPartitionDigest: authorityPartition.digest,
    }),
    exp: now + 60_000,
    now,
  };
}
