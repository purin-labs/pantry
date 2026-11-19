import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type { BakerySurfaceAttachmentV1 } from "@purin-labs/bakery-model/bakery-surface";
import type {
  HarnessTurnLease,
  StoredMessageAttachment,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import type { Env } from "../../env";
import type { RequestId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { CheckpointCommittedSessionCommit } from "../actor-journal";
import {
  listHarnessCheckpointObjectKeys,
  listHarnessHistoryObjectKeys,
  parsePersistedHarnessTurnLease,
} from "../agent-session-harness-authority";
import { listMessagePreparationObjectKeys } from "../message-preparation-store";
import type { EmbeddedHarnessActiveTurn } from "../embedded-harness";
import type { CanonicalTextTurnCompletionIdentity } from "../agent-session-text-turn";
import type { ActorExportError } from "../actor-export";
import {
  beginSessionTurnStream,
  failSessionTurnStream,
} from "../agent-session-turn-stream";
import type { SessionTurnInputDigest } from "../agent-session-turn-input-digest";
import type {
  CanonicalCaseTurnStartRequest,
  CanonicalTextTurnStartRequest,
} from "../agent-session-turn-start";
import type { CanonicalEmbeddedHarnessTextTurnError } from "./types";

/**
 * How long a staged change stays confirmable.
 *
 * Long enough for someone to read it and reply, short enough that a preview
 * nobody answered cannot be confirmed days later against state that moved.
 */
export const OPERATOR_DRAFT_TTL_MS = 60 * 60 * 1000;

/** The wait before a recovery repeats a lease rebind that an owner deferred. */
export const CODE_MODE_LEASE_REBIND_RETRY_MS = 1_000;

/**
 * The wait before the Session repeats the release of an ended execution. A
 * reservation ends by itself within its lease, so few repeats follow.
 */
export const CODE_MODE_RELEASE_RETRY_MS = 30_000;

export const SESSION_REPLAY_POLL_MS = 50;

export const SESSION_REPLAY_MAX_POLL_MS = 400;

export function sessionPlacementR2Keys(sql: SqlStorage): readonly string[] {
  const keys = [
    ...listHarnessCheckpointObjectKeys(sql),
    ...listHarnessHistoryObjectKeys(sql),
    ...listMessagePreparationObjectKeys(sql),
  ];
  return keys;
}

export function checkpointReceipt(
  input: CheckpointCommittedSessionCommit,
): WorkspaceRevisionReceipt {
  return input.state.state.resumePoint.checkpoint.workspaceRevisionReceipt;
}

export function parseHarnessTurnLeaseProjection(
  projection: string | undefined,
): HarnessTurnLease | null {
  if (projection === undefined) return null;
  try {
    return parsePersistedHarnessTurnLease(JSON.parse(projection));
  } catch {
    return null;
  }
}

export async function destroyWorkspaceExecutor(
  env: Env,
  allocationId: string,
): Promise<void> {
  try {
    await env.WORKSPACE_EXECUTOR.getByName(allocationId).destroy();
  } catch {
    // The executor request still owns deadline cleanup when destruction races completion.
  }
}

export type CanonicalTextTurnInput = {
  readonly requestingOrganisationId: OrganisationId;
  readonly requestId: RequestId;
  readonly inputDigest: SessionTurnInputDigest;
  readonly start: CanonicalTextTurnStartRequest | CanonicalCaseTurnStartRequest;
  /**
   * The conversation that takes the turn's streamed output. The Session then
   * decides that sink from the turn's flow binding and its live authority,
   * and starts no turn that the conversation may not receive. Null for a
   * caller that streams nothing.
   */
  readonly streamSink: { readonly channelId: string } | null;
  readonly harnessInstructions: string;
  readonly thinkingLevel?: import("../embedded-harness").EmbeddedHarnessThinkingLevel;
  readonly turnPrompt: string;
  readonly attachments: readonly StoredMessageAttachment[];
  readonly links: readonly string[];
  readonly browserContext: BakeryBrowserContext;
  readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
  readonly context: unknown;
  readonly completion: CanonicalTextTurnCompletionIdentity;
};

export function failFrozenCanonicalPreparation(
  sql: SqlStorage,
  input: Pick<
    CanonicalTextTurnInput,
    "requestingOrganisationId" | "requestId" | "inputDigest" | "start"
  >,
): Result<never, CanonicalEmbeddedHarnessTextTurnError> {
  const stream = beginSessionTurnStream(sql, {
    organisationId: input.requestingOrganisationId,
    turnId: input.start.turnId,
    requestId: input.requestId,
    inputDigest: input.inputDigest,
    startedAt: input.start.admittedAt,
  });
  if (!stream.ok) return stream;
  if (stream.value === "started") {
    const failed = failSessionTurnStream(
      sql,
      input.start.turnId,
      "session_placement_conflict",
      Date.now(),
    );
    if (!failed.ok) return failed;
  }
  return {
    ok: false,
    error: {
      code: "canonical_text_turn_state_invalid",
      reason: "placement_conflict",
    },
  };
}

export type TransientSessionExecution = {
  state:
    | { readonly kind: "preparing"; readonly turn?: never }
    | { readonly kind: "running"; readonly turn: EmbeddedHarnessActiveTurn }
    | { readonly kind: "settling"; readonly turn?: never };
};

export type TrackedTransientSessionExecution = {
  readonly execution: TransientSessionExecution;
  readonly settlement: Promise<Result<null, ActorExportError>>;
};
