import {
  parseBakeBoard,
  type BakeBoard,
  type BakeDecisionInput,
  type BakeStockLevelInput,
} from "@purin-labs/kitchen-control-api";
import { isRecord } from "@purin-labs/std";

import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import { controlPath } from "../../control-paths";

/**
 * The Bakes page's calls to the Platform (Plan 24 S1). The read is for
 * `useLatestRead`, and each write for `useMutation`; a refused write fails
 * with the Platform's reason.
 */

export async function readBakes(
  organisationId: string,
  signal: AbortSignal,
): Promise<BakeBoard> {
  return parseBakeBoard(
    await controlRead(controlPath(organisationId, "bakes"), signal),
  );
}

export async function saveBakeLevel(
  organisationId: string,
  level: BakeStockLevelInput,
  idempotencyKey: string,
): Promise<void> {
  await controlMutation(
    controlPath(organisationId, "bakes/levels"),
    "PUT",
    level,
    undefined,
    { kind: "prepared", idempotencyKey },
  );
}

export async function decideBake(
  organisationId: string,
  proposalId: string,
  decision: BakeDecisionInput,
  idempotencyKey: string,
): Promise<void> {
  await controlMutation(
    controlPath(
      organisationId,
      `bakes/proposals/${encodeURIComponent(proposalId)}/decision`,
    ),
    "POST",
    decision,
    undefined,
    { kind: "prepared", idempotencyKey },
  );
}

/** The Platform's words for a refused write, or a general sentence. */
export function refusalText(error: unknown): string {
  if (
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.message === "string"
  )
    return error.details.message;
  return "The change was not saved. Try again.";
}
