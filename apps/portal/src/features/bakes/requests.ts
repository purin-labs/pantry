import {
  parseBakeBoard,
  parseBakeRunRead,
  type BakeAuthorityInput,
  type BakeBoard,
  type BakeRunActionInput,
  type BakeRunRead,
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

/** Plan 24 S5: an admin sets the shadow or approval mode of a kitchen. */
export async function saveBakeAuthority(
  organisationId: string,
  authority: BakeAuthorityInput,
  idempotencyKey: string,
): Promise<void> {
  await controlMutation(
    controlPath(organisationId, "bakes/authority"),
    "PUT",
    authority,
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

/** Plan 24 S4: the one read of a proposal's bake run. */
export async function readBakeRun(
  organisationId: string,
  proposalId: string,
  signal: AbortSignal,
): Promise<BakeRunRead> {
  return parseBakeRunRead(
    await controlRead(
      controlPath(
        organisationId,
        `bakes/proposals/${encodeURIComponent(proposalId)}/run`,
      ),
      signal,
    ),
  );
}

export async function actOnBakeRun(
  organisationId: string,
  proposalId: string,
  action: BakeRunActionInput,
  idempotencyKey: string,
): Promise<void> {
  await controlMutation(
    controlPath(
      organisationId,
      `bakes/proposals/${encodeURIComponent(proposalId)}/run`,
    ),
    "POST",
    action,
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
