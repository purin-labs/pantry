import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  BindingObservation,
  type BindingObservationSnapshot,
} from "./binding-observation";
import { resolveActiveCaseActor } from "../../src/actors/actor-router";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import { CaseDO } from "../../src/actors/case";
import { parseCaseId } from "@purin-labs/kernel/ids";
import { buildControlAuthority } from "../../src/request-authority";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import {
  installDiscoveryActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

it(
  "recovers a trigger projection after interrupted acknowledgment, eviction, relocation and duplicate admission",
  projectionRecovery,
  60_000,
);

async function projectionRecovery({ task }: TestContext): Promise<void> {
  const queueObservation = new BindingObservation();
  await installDiscoveryActorFixture();
  const caseId = parseCaseId("case_projection_recovery");
  if (!caseId.ok) throw new Error(caseId.error.code);
  const resolved = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  let actor = resolved.value;
  expect(
    await actor.ensure({
      identity: { organisationId: ORGANISATION_ID, caseId: caseId.value },
      purpose: "Recover durable context publication",
      workspaceRevision: "workspace_projection_recovery",
      lifecycle: { kind: "open", openedAt: Date.now() },
    }),
  ).toMatchObject({ ok: true });
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_projection_recovery', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (membershipRevision === null)
    throw new Error("Missing active fixture membership");
  const authority = buildControlAuthority({
    organisationId: ORGANISATION_ID,
    requesterPersonId: "person_e2e-slack-actor",
    userId: "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
    membershipRevision,
    role: "operator",
  }).requestAuthority;
  const trigger = {
    triggerId: "trigger_projection_recovery",
    caseId: caseId.value,
    source: { kind: "api", commandId: "projection_recovery" },
    requestAuthority: authority,
    content: {
      kind: "text",
      text: "Preserve this canonical input through queue interruption.",
    },
    acceptedAt: Date.now(),
  };

  await runInDurableObject(actor, failProjectionIntent);
  const initialEnv = await runInDurableObject(
    actor,
    observeProjectionQueue.bind(null, queueObservation),
  );
  let rolledBackQueue: BindingObservationSnapshot;
  let interruptedQueue: BindingObservationSnapshot;
  let interrupted: Awaited<ReturnType<typeof readProjectionState>>;
  try {
    expect(
      await runInDurableObject(
        actor,
        rejectProjectionIntent.bind(null, trigger),
      ),
    ).toContain("projection_intent_unavailable");
    rolledBackQueue = queueObservation.snapshot();
    expect(rolledBackQueue.operations).toEqual({});
    expect(await runInDurableObject(actor, readProjectionState)).toMatchObject({
      triggers: 0,
      journalEntries: 0,
      pending: 0,
    });

    await runInDurableObject(actor, interruptProjectionAcknowledgment);
    const admission = await actor.acceptTrigger(trigger);
    expect(admission, JSON.stringify(admission)).toMatchObject({
      ok: true,
      value: { kind: "accepted" },
    });
    interrupted = await runInDurableObject(actor, readProjectionState);
    expect(interrupted).toMatchObject({ triggers: 1, pending: 1 });
    expect(interrupted.alarm).not.toBeNull();
    interruptedQueue = queueObservation.snapshot();
    expect(interruptedQueue.kind).toBe("settled_calls");
    expect(interruptedQueue.operations["queue.send"]?.fulfilled).toBe(1);
  } finally {
    await runInDurableObject(
      actor,
      restoreProjectionEnv.bind(null, initialEnv),
    );
  }
  await evictDurableObject(actor);
  const sourceActor = actor;
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const move = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!move.ok) throw new Error(move.error.code);
  const moved = await resumeActorRelocation({
    env,
    relocationId: move.value.relocationId,
    now: Date.now(),
  });
  expect(moved, JSON.stringify(moved)).toMatchObject({
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
  expect(await runInDurableObject(actor, readProjectionState)).toMatchObject({
    triggers: 1,
    pending: 1,
  });
  expect(await sourceActor.acceptTrigger(trigger)).toMatchObject({ ok: false });
  const recoveredEnv = await runInDurableObject(
    actor,
    observeProjectionQueue.bind(null, queueObservation),
  );
  try {
    expect(await runDurableObjectAlarm(actor)).toBe(true);
    expect(await actor.acceptTrigger(trigger)).toMatchObject({
      ok: true,
      value: { kind: "duplicate" },
    });
  } finally {
    await runInDurableObject(
      actor,
      restoreProjectionEnv.bind(null, recoveredEnv),
    );
  }
  const recoveredQueue = queueObservation.snapshot();
  expect(recoveredQueue.kind).toBe("settled_calls");
  expect(recoveredQueue.operations["queue.send"]?.fulfilled).toBe(3);
  expect(await runInDurableObject(actor, readProjectionState)).toMatchObject({
    triggers: 1,
    pending: 0,
  });

  await evictDurableObject(actor);
  await runDurableObjectAlarm(actor);
  const recovered = await runInDurableObject(actor, readProjectionState);
  expect(recovered).toMatchObject({
    triggers: 1,
    journalEntries: 1,
    pending: 0,
  });
  Object.assign(task.meta, {
    projectionRecovery: {
      caseId: caseId.value,
      interrupted,
      recovered,
      relocationId: move.value.relocationId,
      atomicIntentRollback: true,
      duplicateJournalEntries: recovered.journalEntries - 1,
      queueUsage: { rolledBackQueue, interruptedQueue, recoveredQueue },
    },
  });
}

function observeProjectionQueue(
  observation: BindingObservation,
  actor: object,
) {
  const descriptor = Object.getOwnPropertyDescriptor(actor, "env");
  if (descriptor === undefined) throw new Error("Missing Case environment");
  const originalEnv = Reflect.get(actor, "env");
  const observedEnv = Object.create(originalEnv);
  Object.defineProperty(observedEnv, "EVENT_Q", {
    value: observation.queue(Reflect.get(originalEnv, "EVENT_Q")),
  });
  Object.defineProperty(actor, "env", { ...descriptor, value: observedEnv });
  return descriptor;
}

function restoreProjectionEnv(descriptor: PropertyDescriptor, actor: object) {
  Object.defineProperty(actor, "env", descriptor);
}

function failProjectionIntent(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "CREATE TRIGGER fail_projection_intent BEFORE INSERT ON case_context_projection_outbox BEGIN SELECT RAISE(ABORT, 'projection_intent_unavailable'); END",
  );
}

function interruptProjectionAcknowledgment(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec("DROP TRIGGER fail_projection_intent");
  state.storage.sql.exec(
    "CREATE TRIGGER interrupt_projection_ack BEFORE DELETE ON case_context_projection_outbox BEGIN SELECT RAISE(ABORT, 'projection_ack_interrupted'); END",
  );
}

async function readProjectionState(_actor: unknown, state: DurableObjectState) {
  return {
    triggers: state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM case_trigger")
      .toArray()[0]?.count,
    journalEntries: state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM case_journal")
      .one().count,
    pending: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM case_context_projection_outbox",
      )
      .toArray()[0]?.count,
    alarm: await state.storage.getAlarm(),
  };
}

async function rejectProjectionIntent(
  trigger: unknown,
  actor: unknown,
): Promise<string> {
  if (!(actor instanceof CaseDO)) throw new Error("Expected Case Actor");
  try {
    await actor.acceptTrigger(trigger);
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected projection intent failure");
}
