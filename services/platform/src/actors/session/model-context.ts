import type { ChatContextDetails } from "@purin-labs/control-api";
import type {
  AcceptedInputRef,
  HarnessHistoryEntry,
  HarnessTurnLease,
  TurnIdentity,
} from "@purin-labs/contracts";
import type { Result } from "@purin-labs/kernel/result";
import {
  preflightHarnessTurnLease,
  type HarnessAuthorityError,
  type HarnessHistoryMaterialization,
} from "../agent-session-harness-authority";
import type {
  HarnessHistoryRead,
  HarnessHistoryContent,
} from "../harness-history";
import type { EmbeddedHarnessSource } from "../embedded-harness";
import { ObservationEvidence } from "../../policy";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { materializedHarnessHistory } from "./harness-source";
import type { FreshLineageHistoryError } from "./types";

export function assertFreshLineageHistory(
  history: HarnessHistoryRead,
): Result<HarnessHistoryRead, FreshLineageHistoryError> {
  const cursor = history.cursor;
  const coherent =
    history.entries.length === 0
      ? cursor === null
      : cursor !== null && cursor.lastSequence === history.entries.length;
  return coherent
    ? { ok: true, value: history }
    : { ok: false, error: { code: "harness_history_lineage_conflict" } };
}

export function recoverFreshHarnessHistory(input: {
  readonly history: HarnessHistoryRead;
  readonly acceptedInput: AcceptedInputRef;
  readonly turn: TurnIdentity;
}): Result<
  Variant<EmbeddedHarnessSource, "fresh_after_abandoned_inputs">,
  FreshLineageHistoryError
> {
  const inputIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const entry of input.history.entries) {
    if (entry.kind !== "user_input") {
      return { ok: false, error: { code: "harness_history_lineage_conflict" } };
    }
    inputIds.add(entry.input.inputId);
    turnIds.add(entry.turn.turnId);
  }
  if (
    input.history.entries.length === 0 ||
    input.history.cursor === null ||
    input.history.cursor.lastSequence !== input.history.entries.length ||
    inputIds.size !== input.history.entries.length ||
    turnIds.size !== input.history.entries.length ||
    inputIds.has(input.acceptedInput.inputId) ||
    turnIds.has(input.turn.turnId)
  ) {
    return { ok: false, error: { code: "harness_history_lineage_conflict" } };
  }
  return {
    ok: true,
    value: {
      kind: "fresh_after_abandoned_inputs",
      historyCursor: input.history.cursor,
      history: input.history,
    },
  };
}

export function confirmedContextObservation(
  evidence: ObservationEvidence,
): Variant<ChatContextDetails, "observed"> | null {
  const source = evidence.source;
  switch (source.kind) {
    case "case_context_collection_evidence":
      return null;
    case "organisation_record":
      return {
        kind: "observed",
        area: "kitchen",
        source: {
          id: source.recordId,
          revision: String(evidence.sourceRevision),
          digest: evidence.contentDigest,
          observedAt: evidence.observedAt,
          origin: "saved",
        },
      };
    case "integration_resource":
      return {
        kind: "observed",
        area: source.resourceScope.startsWith("commerce")
          ? "cafe"
          : "commerce",
        source: {
          id: `${source.integrationAccountId}:${source.resourceScope}`,
          revision: String(evidence.sourceRevision),
          digest: evidence.contentDigest,
          observedAt: evidence.observedAt,
          origin: source.resourceScope.startsWith("commerce")
            ? "business"
            : "file",
        },
      };
    case "project":
    case "chat_conversation":
    case "case_entry":
      return null;
    default:
      return assertNever(source);
  }
}

/** The accepted Memory in a model context, with any limitation on it. */
export function memoryModelContext(
  context: import("../../context/assembly").ModelContextBundle,
): import("../../context/assembly").ModelContextBundle {
  return {
    assemblyStrategyVersion: context.assemblyStrategyVersion,
    items: context.items.filter((item) => item.provenance.kind === "memory"),
    disposition: context.disposition,
    ...(context.memoryLimitation === undefined
      ? {}
      : { memoryLimitation: context.memoryLimitation }),
  };
}

export function modelContextWithoutProject(
  context: import("../../context/assembly").ModelContextBundle,
): import("../../context/assembly").ModelContextBundle {
  return {
    assemblyStrategyVersion: context.assemblyStrategyVersion,
    items: context.items.filter(isChatContextItem),
    disposition: context.disposition,
    ...(context.memoryLimitation === undefined
      ? {}
      : { memoryLimitation: context.memoryLimitation }),
  };
}

export function projectModelContext(
  context: import("../../context/assembly").ModelContextBundle,
): import("../../context/assembly").ModelContextBundle {
  return {
    assemblyStrategyVersion: context.assemblyStrategyVersion,
    items: context.items.filter(isProjectContextItem),
    disposition: context.disposition,
  };
}

function isProjectContextItem(
  item: import("../../context/assembly").ModelContextItem,
): boolean {
  return item.provenance.kind === "project_context";
}

function isChatContextItem(
  item: import("../../context/assembly").ModelContextItem,
): boolean {
  return item.provenance.kind !== "project_context";
}

export function projectWorkingHistory(
  entries: readonly HarnessHistoryEntry[],
  currentTurnId: string,
): readonly HarnessHistoryEntry[] {
  return entries.map(projectWorkingEntry.bind(null, currentTurnId));
}

function projectWorkingEntry(
  currentTurnId: string,
  entry: HarnessHistoryEntry,
): HarnessHistoryEntry {
  if (entry.kind !== "user_input" || entry.turn.turnId === currentTurnId)
    return entry;
  return {
    kind: entry.kind,
    turn: entry.turn,
    input: entry.input,
    content: entry.content.filter(isChatHistoryContent),
    acceptedAt: entry.acceptedAt,
  };
}

function isChatHistoryContent(content: HarnessHistoryContent): boolean {
  return content.kind !== "project_context";
}

/**
 * True when the history ends on an answer, such as the failure note of a
 * turn that the provider failed. A turn past the checkpoint that ended so
 * stored no checkpoint, and the next turn may rebuild from its history.
 */
export function endsOnAnswer(history: HarnessHistoryRead): boolean {
  const last = history.entries.at(-1);
  return last?.kind === "assistant_message" && last.stopReason === "completed";
}

export function freshLineageSource(
  history: HarnessHistoryRead,
): Result<EmbeddedHarnessSource, FreshLineageHistoryError> {
  const lineage = assertFreshLineageHistory(history);
  if (!lineage.ok) return lineage;
  return {
    ok: true,
    value: {
      kind: "fresh_lineage",
      historyCursor: lineage.value.cursor,
      history: lineage.value,
    },
  };
}

export function projectMaterializedHarnessHistory(
  materialization: HarnessHistoryMaterialization,
  currentTurnId: string,
): Result<HarnessHistoryRead, HarnessAuthorityError> {
  const history = materializedHarnessHistory(materialization);
  if (!history.ok) return history;
  return {
    ok: true,
    value: {
      ...history.value,
      entries: projectWorkingHistory(history.value.entries, currentTurnId),
    },
  };
}

export function hasSupersededProjectContext(
  entries: readonly HarnessHistoryEntry[],
  currentTurnId: string,
): boolean {
  for (const entry of entries) {
    if (
      entry.kind === "user_input" &&
      entry.turn.turnId !== currentTurnId &&
      entry.content.some(isProjectHistoryContent)
    )
      return true;
  }
  return false;
}

function isProjectHistoryContent(content: HarnessHistoryContent): boolean {
  return content.kind === "project_context";
}

export function requirePiHarnessLease(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): void {
  const result = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!result.ok) throw new Error(result.error.code);
}
