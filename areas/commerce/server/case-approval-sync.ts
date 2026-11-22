import { errorMessage } from "@purin-labs/std";

import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  type CaseId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";

/**
 * Tells a Case that the ledger decided the action that it may wait on
 * (Refactor 15, refactor 1). The Case reads the decision from the ledger
 * itself. A failure leaves the repair to the Case alarm, so the caller's own
 * answer does not depend on it; it returns false then.
 */
export async function syncCaseApprovalWait(
  env: Env,
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: CaseId;
    actionNonce: string;
    now: number;
  }>,
): Promise<boolean> {
  try {
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: input.organisationId,
      caseId: input.caseId,
      now: input.now,
    });
    if (!caseActor.ok) return false;
    const synced = await caseActor.value.syncCommerceApprovalWait({
      caseId: input.caseId,
      actionNonce: input.actionNonce,
    });
    return synced.ok;
  } catch (error) {
    traceWarn("commerce.case_approval_sync_failed", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      case_id: input.caseId,
      error: errorMessage(error).slice(0, 500),
    });
    return false;
  }
}
