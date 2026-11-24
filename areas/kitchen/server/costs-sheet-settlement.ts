import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { CostsSheetSettlement } from "./costs-sheet-save";

/**
 * The settlement of a save that a person made on the Costs & margins page: the
 * Organisation Actor removes the saved cells from the shared draft. A failed
 * settlement is logged and does not fail the save.
 */
export function controlSessionCostsSheetSettlement(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): CostsSheetSettlement {
  return async (cellKeys, clearPriceCells, savedAtMs) => {
    try {
      const organisation = await requireActiveOrganisationActor({
        env,
        organisationId: authorized.organisationId,
        now: savedAtMs,
      });
      const settled = await organisation.settleCostsSheetDraft({
        organisationId: authorized.organisationId,
        cellKeys,
        clearPriceCells,
        savedAtMs,
        userId: authorized.authenticated.session.userId,
        origin: {
          kind: "control_session",
          controlSessionId: authorized.authenticated.session.controlSessionId,
        },
      });
      if (!settled.ok) {
        traceWarn("commerce.costs_sheet_settle_deferred", {
          requestId: newRequestId(),
          organisationId: authorized.organisationId,
          code: settled.error.code,
        });
      }
    } catch (error) {
      traceWarn("commerce.costs_sheet_settle_deferred", {
        requestId: newRequestId(),
        organisationId: authorized.organisationId,
        detail: error instanceof Error ? error.message : "actor_unavailable",
      });
    }
  };
}
