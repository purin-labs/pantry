import {
  resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
} from "@purin-labs/actor-runtime/actors/actor-router";
import { restoreFlowBinding } from "@purin-labs/conversation/actors/case-walking-path";
import {
  decideHeldOutputRequest,
  HELD_OUTPUT_REQUEST_LIFETIME_MS,
  listHeldOutputReconciliation,
  markHeldOutputRequestReleased,
  type HeldOutputRequest,
} from "@purin-labs/authority/data/held-output-request";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, parseCaseId, parseConnectorId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { approvedOutputDecision } from "@purin-labs/authority/policy/information-flow/index";
import { refreshSlackRequestAuthority } from "@purin-labs/authority/request-authority/index";
import {
  heldEffectDecisionNoticeText,
  heldOutputEndNoticeText,
} from "./held-output-notice";

/**
 * Carry out the end of a held output. Allow sends that one output. Deny and
 * expiry drop it, and the thread and the agent learn that it was not sent.
 *
 * It returns false when the work could not finish now. The decision stays
 * stored, and the scheduled reconciliation tries again.
 */
export async function releaseHeldOutputDecision(
  env: Env,
  scope: OrganisationExecutionScope,
  stored: HeldOutputRequest,
): Promise<boolean> {
  if (stored.status === "pending") return false;
  if (stored.releasedAt !== null) return true;
  const finished = await finishHeldOutput(env, scope, stored).catch(
    () => false,
  );
  if (finished)
    await markHeldOutputRequestReleased(
      scope,
      stored.requestId,
      Date.now(),
    );
  return finished;
}

/** Expire the requests whose time ended, and finish decisions that waited. */
export async function reconcileHeldOutputRequests(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<void> {
  const due = await listHeldOutputReconciliation(
    input.scope.database,
    input.scope.organisationId,
    input.now,
  );
  for (const stored of due) {
    let current = stored;
    if (stored.status === "pending") {
      if (stored.createdAt + HELD_OUTPUT_REQUEST_LIFETIME_MS > input.now)
        continue;
      const expired = await decideHeldOutputRequest(input.scope, {
        requestId: stored.requestId,
        status: "expired",
        userId: null,
        now: input.now,
      });
      if (!expired.ok) continue;
      current = expired.value;
    }
    await releaseHeldOutputDecision(input.env, input.scope, current);
  }
}

/**
 * The end of a held tool effect. A Portal chat has nothing parked: the person
 * asks again, and an allowed pass waits. A Slack thread continues in a new
 * turn after an allow. After a deny or expiry, the thread and the agent's next
 * turn learn that the step did not happen.
 */
async function finishHeldEffect(
  env: Env,
  scope: OrganisationExecutionScope,
  stored: HeldOutputRequest,
): Promise<boolean> {
  if (stored.connectorId === null || stored.effect === null) return true;
  const connectorId = parseConnectorId(stored.connectorId);
  const caseId = parseCaseId(stored.caseId ?? "");
  if (!connectorId.ok || !caseId.ok) return false;
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env,
    namespace: env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) return false;
  let requestAuthority = null;
  if (stored.status === "allowed") {
    const asked = stored.requestAuthority;
    if (
      asked.kind !== "direct_conversation" &&
      asked.kind !== "shared_conversation"
    )
      return false;
    // Null while the Slack account is not active, or the requester left.
    requestAuthority = await refreshSlackRequestAuthority(
      scope.database,
      asked,
    );
    if (requestAuthority === null) return false;
  } else {
    const caseActor = await resolveActiveCaseActorAtPlacement({
      env,
      namespace: env.CASE,
      organisationId: scope.organisationId,
      caseId: caseId.value,
      placement: scope.placement,
      now,
    });
    if (!caseActor.ok) return false;
    const noted = await caseActor.value.noteRefusedEffect({
      requestId: stored.requestId,
      organisationId: scope.organisationId,
      reason: stored.status === "denied" ? "denied" : "expired",
      requestAuthority: stored.requestAuthority,
      authorityPartitionDigest: stored.effect.authorityPartitionDigest,
      notedAt: now,
    });
    if (!noted.ok) return false;
  }
  const decision = stored.status === "allowed" ? "allow" : "deny";
  const released = await connector.value.releaseSlackPermission({
    identity: {
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
    },
    requestId: stored.requestId,
    decision,
    requestAuthority,
    noticeText: heldEffectDecisionNoticeText(
      stored.status === "expired" ? "expired" : decision,
    ),
  });
  return released.ok;
}

async function finishHeldOutput(
  env: Env,
  scope: OrganisationExecutionScope,
  stored: HeldOutputRequest,
): Promise<boolean> {
  if (stored.subject === "effect") return finishHeldEffect(env, scope, stored);
  const caseId = parseCaseId(stored.caseId ?? "");
  const connectorId = parseConnectorId(stored.connectorId ?? "");
  if (!caseId.ok || !connectorId.ok) return false;
  const now = Date.now();
  const [caseActor, connector] = await Promise.all([
    resolveActiveCaseActorAtPlacement({
      env,
      namespace: env.CASE,
      organisationId: scope.organisationId,
      caseId: caseId.value,
      placement: scope.placement,
      now,
    }),
    resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: scope.organisationId,
      placement: scope.placement,
      connectorId: connectorId.value,
      now,
    }),
  ]);
  if (!caseActor.ok || !connector.ok) return false;
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) return false;
  const outputId = stored.outputId;
  if (outputId === null) return false;
  const lifecycle = snapshot.value.outputs.find(
    (candidate) => candidate.output.outputId === outputId,
  );
  if (lifecycle === undefined) return false;
  // A held output waits for this decision. A pending one was held before the
  // held state existed, or between the request and the Case mark. Any other
  // output has ended, and this decision has nothing left to do.
  if (lifecycle.kind !== "held" && lifecycle.kind !== "pending") return true;
  const identity = {
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
  };
  if (stored.status === "allowed") {
    const binding = await restoreFlowBinding(lifecycle.output.flowBinding);
    if (!binding.ok) return false;
    const delivered = await connector.value.deliverApprovedOutput({
      identity,
      delivery: lifecycle.output.delivery,
      requestedAt: now,
    });
    if (!delivered.ok || delivered.value.kind === "retry") return false;
    if (delivered.value.kind === "rejected") {
      traceWarn("case.held_output_delivery_rejected", {
        requestId: newRequestId(),
        organisation_id: scope.organisationId,
        request_id: stored.requestId,
        reason: delivered.value.reason,
      });
      // The refusal is final: the output ends, so the decision is done and
      // the reconciliation stops asking (Refactor 15).
      const rejected = await caseActor.value.rejectOutput({
        outputId,
        reason: delivered.value.reason,
      });
      return rejected.ok;
    }
    const settled = await caseActor.value.acceptDeliveryReceipt({
      outputId,
      receipt: {
        ...delivered.value.receipt,
        ...(await approvedOutputDecision(binding.value, stored.requestId)),
      },
    });
    if (!settled.ok) return false;
    // The answer is out. A card that keeps its old text harms nothing more.
    await connector.value
      .deliver(
        heldOutputEndDelivery(
          identity,
          lifecycle.output.delivery,
          stored.requestId,
          "allowed",
          now,
        ),
      )
      .catch(() => null);
    return true;
  }
  const end = stored.status === "denied" ? "denied" : "expired";
  const dropped = await caseActor.value.dropHeldOutput({
    outputId,
    reason: end,
    requestAuthority: stored.requestAuthority,
    droppedAt: now,
  });
  if (!dropped.ok) return false;
  const notice = await connector.value.deliver(
    heldOutputEndDelivery(
      identity,
      lifecycle.output.delivery,
      stored.requestId,
      end,
      now,
    ),
  );
  return notice.ok && notice.value.kind !== "retry";
}

/** The delivery that updates a held answer's card with the decision. */
function heldOutputEndDelivery<Identity, Delivery>(
  identity: Identity,
  delivery: Delivery,
  requestId: string,
  end: "allowed" | "denied" | "expired",
  requestedAt: number,
) {
  return {
    identity,
    delivery: {
      ...delivery,
      deliveryId: `delivery_held_end_${requestId}`,
      content: { kind: "text" as const, text: heldOutputEndNoticeText(end) },
      idempotencyKey: `held_output_end_${requestId}`,
    },
    requestedAt,
  };
}
