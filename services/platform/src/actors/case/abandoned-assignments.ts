import type { CaseAssignmentLifecycle } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  parseSessionId,
  type OrganisationId,
  type SessionId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveSessionActorAtPlacement } from "../actor-router";
import type { CaseActor } from "./case-actor";
import { logAbandonSkipped } from "./assignment-census";

type ActiveAssignment = Variant<
  CaseAssignmentLifecycle,
  "assigned" | "running"
>;

/**
 * The Session's proof that it runs no turn: the time of the read that showed
 * it, or null when it runs one or cannot say.
 */
type SessionQuiescenceProof = (sessionId: string) => Promise<number | null>;

/**
 * Asks the Session of an assignment if it runs a turn. A Session that was
 * never initialized runs none. A Session holds a transient turn only in
 * memory, so that question comes first. For a `canonical` Session, the
 * stored state must then show no turn that holds a lease, a submission or a
 * pending alarm. A `transient` Session, as an email turn uses, keeps no turn
 * after its process stops.
 */
export function sessionQuiescenceProver(
  env: Env,
  scope: Pick<OrganisationExecutionScope, "organisationId" | "placement">,
  sessions: "canonical" | "transient" = "canonical",
): SessionQuiescenceProof {
  return async function proveQuiescence(raw) {
    const sessionId = parseSessionId(raw);
    if (!sessionId.ok) {
      logAbandonSkipped({ reason: "session_id_invalid" });
      return null;
    }
    const inspectedAt = Date.now();
    try {
      const session = await resolveActiveSessionActorAtPlacement({
        env,
        namespace: env.SESSION,
        placement: scope.placement,
        organisationId: scope.organisationId,
        sessionId: sessionId.value,
        now: inspectedAt,
      });
      if (!session.ok)
        return refused(
          sessionId.value,
          `session_unresolved:${session.error.code}`,
        );
      return await askSession(
        session.value,
        { organisationId: scope.organisationId, sessionId: sessionId.value },
        sessions,
        inspectedAt,
      );
    } catch {
      // A transport failure proves nothing.
      return refused(sessionId.value, "session_transport_failed");
    }
  };
}

/**
 * Logs why a Session did not prove that it runs no turn, so an assignment
 * that stays active names its cause. Codes only, never content.
 */
function refused(sessionId: SessionId, reason: string): null {
  traceWarn("case.assignment_abandon_refused", {
    requestId: newRequestId(),
    session_id: sessionId,
    reason,
  });
  return null;
}

type SessionIdentity = Readonly<{
  organisationId: OrganisationId;
  sessionId: SessionId;
}>;

/** The two reads of a Session that prove it runs no turn. */
type QuiescenceSession = {
  releaseStoppedTransientTurns(
    input: SessionIdentity,
  ): Promise<
    Result<{ readonly kind: "running" | "idle" }, { readonly code: string }>
  >;
  inspectCanonicalSessionState(input: SessionIdentity): Promise<
    Result<
      {
        readonly quiescence: {
          readonly kind: string;
          readonly blockers?: readonly string[];
        };
      },
      { readonly code: string }
    >
  >;
};

async function askSession(
  session: QuiescenceSession,
  identity: SessionIdentity,
  sessions: "canonical" | "transient",
  inspectedAt: number,
): Promise<number | null> {
  const transient = await session.releaseStoppedTransientTurns(identity);
  if (!transient.ok)
    return transient.error.code === "session_not_initialized"
      ? inspectedAt
      : refused(identity.sessionId, `transient_read:${transient.error.code}`);
  if (transient.value.kind === "running")
    return refused(identity.sessionId, "transient_turn_running");
  if (sessions === "transient") return inspectedAt;
  const state = await session.inspectCanonicalSessionState(identity);
  if (!state.ok)
    return refused(identity.sessionId, `canonical_read:${state.error.code}`);
  return state.value.quiescence.kind === "ready"
    ? inspectedAt
    : refused(
        identity.sessionId,
        `canonical:${state.value.quiescence.kind}:${(state.value.quiescence.blockers ?? []).join("+")}`,
      );
}

/**
 * Ends the active assignments of a Case that no live turn will finish
 * (Refactor 15, refactor 9). It replaces the copies that each surface kept.
 * An assignment ends only when it is older than `minimumAgeMs` and its
 * Session proves that it runs no turn; the Case checks both and moves only
 * the state that this call read. `mayAbandon` names the assignments that the
 * caller may end. The result lists the assignments that ended and those that
 * stay active.
 */
export async function recoverAbandonedAssignments(
  input: Readonly<{
    caseActor: Pick<CaseActor, "assignmentLifecycles" | "abandonAssignment">;
    proveQuiescence: SessionQuiescenceProof;
    minimumAgeMs: number;
    now: number;
    mayAbandon?: (lifecycle: ActiveAssignment) => boolean;
  }>,
): Promise<
  Result<
    Readonly<{
      abandoned: readonly ActiveAssignment[];
      active: readonly ActiveAssignment[];
    }>,
    { readonly code: string }
  >
> {
  const lifecycles = await input.caseActor.assignmentLifecycles();
  if (!lifecycles.ok) return { ok: false, error: lifecycles.error };
  const abandoned: ActiveAssignment[] = [];
  const active: ActiveAssignment[] = [];
  for (const lifecycle of lifecycles.value) {
    if (lifecycle.kind === "settled") continue;
    if (
      (input.mayAbandon !== undefined && !input.mayAbandon(lifecycle)) ||
      (lifecycle.kind === "running" &&
        input.now < Number(lifecycle.start.acceptedAt) + input.minimumAgeMs)
    ) {
      active.push(lifecycle);
      continue;
    }
    const { assignment } = lifecycle;
    const inspectedAt = await input.proveQuiescence(assignment.sessionId);
    if (inspectedAt === null) {
      active.push(lifecycle);
      continue;
    }
    const ended = await input.caseActor.abandonAssignment({
      caseId: assignment.caseId,
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      expectedCaseRevision: assignment.caseRevision,
      expectedState: lifecycle.kind,
      expectedStartId:
        lifecycle.kind === "running" ? lifecycle.start.startId : null,
      proof: {
        kind: "session_quiescent",
        sessionId: assignment.sessionId,
        inspectedAt,
      },
      minimumAgeMs: input.minimumAgeMs,
      abandonedAt: Math.max(input.now, inspectedAt),
    });
    if (ended.ok) {
      abandoned.push(lifecycle);
      traceWarn("case.assignment_abandoned", {
        requestId: newRequestId(),
        case_id: assignment.caseId,
        assignment_id: assignment.assignmentId,
        from: lifecycle.kind,
      });
      continue;
    }
    // Too recent, or another call moved it: it stays as it is.
    logAbandonSkipped({
      reason: `abandon:${ended.error.code}`,
      case_id: assignment.caseId,
      assignment_id: assignment.assignmentId,
    });
    active.push(lifecycle);
  }
  if (abandoned.length === 0 && active.length === 0)
    logAbandonSkipped({ reason: "no_active_lifecycle" });
  return { ok: true, value: { abandoned, active } };
}
