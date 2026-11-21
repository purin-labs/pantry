import type {
  HarnessCheckpointRecord,
  HarnessHistoryEntry,
} from "@purin-labs/contracts";
import { describe, expect, test } from "vitest";

import { classifyHarnessCheckpoint } from "../src/actors/agent-session-harness-authority";
import {
  assertFreshLineageHistory,
  recoverFreshHarnessHistory,
} from "../src/actors/session/model-context";
import { TEST_ACCEPTED_INPUT_CONTEXT } from "./fixtures/plan25-turn";

const CURRENT_MODEL_ROUTE_DIGEST =
  "83680166ac49c3308cfc3c1232bc1f45dc8fb453054b0f4097aed483b0b30ee4";
const LEGACY_MODEL_ROUTE_DIGEST =
  "d136e30dc65f3ce3fbc133166e0e40ec96c3e5385592ae8ea5160a1fce718edc";

const manifest = {
  backendId: "pi",
  harnessBuild: "pi-build-nf9",
  checkpointFormat: "pantry-pi-sdk-session-v3",
  modelRouteDigest: CURRENT_MODEL_ROUTE_DIGEST,
} as const;

describe("NF9 checkpoint lineage classification", function checkpointClassificationSuite() {
  test("accepts only the current backend build and format", function acceptsCurrentLineage() {
    const checkpoint = currentCheckpoint();
    const result = classifyHarnessCheckpoint({ checkpoint, ...manifest });
    expect(result).toEqual({ kind: "compatible", checkpoint });
  });

  test("classifies incompatible metadata without parsing opaque bytes", function classifiesMetadata() {
    const checkpoint = currentCheckpoint();
    expect(
      classifyHarnessCheckpoint({
        checkpoint: {
          ...checkpoint,
          blob: { ...checkpoint.blob, harnessBuild: "pi-build-old" },
        },
        ...manifest,
      }),
    ).toEqual({ kind: "fresh_lineage_restart", reason: "build_mismatch" });
    expect(
      classifyHarnessCheckpoint({
        checkpoint: {
          ...checkpoint,
          blob: {
            ...checkpoint.blob,
            formatVersion: "pantry-pi-native-compaction-v2",
          },
        },
        ...manifest,
      }),
    ).toEqual({ kind: "fresh_lineage_restart", reason: "format_mismatch" });
  });

  test("rebuilds a stale checkpoint after the model route contract changes", function classifiesStaleModelRoute() {
    const checkpoint = currentCheckpoint();
    expect(
      classifyHarnessCheckpoint({
        checkpoint: {
          ...checkpoint,
          modelRouteDigest: LEGACY_MODEL_ROUTE_DIGEST,
        },
        ...manifest,
      }),
    ).toEqual({
      kind: "fresh_lineage_restart",
      reason: "model_route_digest_mismatch",
    });
  });

  test("classifies a persisted backend against the selected active manifest", function classifiesCrossBackend() {
    const checkpoint = currentCheckpoint();
    // A checkpoint of the retired Codex harness starts a fresh Pi lineage.
    expect(
      classifyHarnessCheckpoint({
        checkpoint: { ...checkpoint, backendId: "codex" },
        ...manifest,
      }),
    ).toEqual({ kind: "fresh_lineage_restart", reason: "backend_mismatch" });
    expect(
      classifyHarnessCheckpoint({
        checkpoint: { ...checkpoint, backendId: "picocodex" },
        ...manifest,
      }),
    ).toEqual({ kind: "fresh_lineage_restart", reason: "backend_mismatch" });
  });

  test("carries settled canonical history into a fresh lineage only under a coherent cursor", function carriesSettledHistory() {
    const turn = currentCheckpoint().turn;
    const inputEntry: HarnessHistoryEntry = {
      kind: "user_input",
      turn,
      input: {
        ...TEST_ACCEPTED_INPUT_CONTEXT,
        kind: "case",
        inputId: turn.inputId,
        caseId: "case_nf9_classification",
        assignmentId: "assignment_nf9_classification",
        caseRevision: 1,
        contentDigest: "a".repeat(64),
        workspaceRevision: "workspace_nf9_classification",
      },
      content: [{ kind: "text", text: "existing" }],
      acceptedAt: 1,
    };
    const toolCallEntry: HarnessHistoryEntry = {
      kind: "assistant_message",
      turn,
      model: "picocodex-retired",
      content: [
        {
          kind: "tool_call",
          callId: "call_nf9_settled",
          tool: "catalog_read",
          arguments: {},
          continuation: { kind: "none" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
      },
      acceptedAt: 2,
    };
    const toolResultEntry: HarnessHistoryEntry = {
      kind: "tool_result",
      turn,
      callId: "call_nf9_settled",
      tool: "catalog_read",
      outcome: {
        kind: "succeeded",
        output: {
          kind: "inline",
          content: [{ kind: "text", text: "catalog" }],
          digest: "b".repeat(64),
        },
      },
      authority: { kind: "read", resultDigest: "b".repeat(64) },
      acceptedAt: 3,
    };
    const assistantEntry: HarnessHistoryEntry = {
      kind: "assistant_message",
      turn,
      model: "picocodex-retired",
      content: [
        { kind: "text", text: "settled", continuation: { kind: "none" } },
      ],
      stopReason: "completed",
      usage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
      },
      acceptedAt: 4,
    };
    const history = {
      cursor: { lastSequence: 4, lastEntryDigest: "f".repeat(64) },
      entries: [inputEntry, toolCallEntry, toolResultEntry, assistantEntry],
    } as const;
    expect(assertFreshLineageHistory(history)).toEqual({
      ok: true,
      value: history,
    });
    expect(assertFreshLineageHistory({ cursor: null, entries: [] })).toEqual({
      ok: true,
      value: { cursor: null, entries: [] },
    });
    expect(
      assertFreshLineageHistory({
        ...history,
        cursor: { ...history.cursor, lastSequence: 3 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "harness_history_lineage_conflict" },
    });
    expect(
      assertFreshLineageHistory({ cursor: history.cursor, entries: [] }),
    ).toEqual({
      ok: false,
      error: { code: "harness_history_lineage_conflict" },
    });
  });

  test("rejects fresh recovery after any accepted tool effect", function rejectsEffectReplay() {
    const checkpoint = currentCheckpoint();
    const input = {
      ...TEST_ACCEPTED_INPUT_CONTEXT,
      kind: "case" as const,
      inputId: checkpoint.turn.inputId,
      caseId: "case_nf9_effect",
      assignmentId: "assignment_nf9_effect",
      caseRevision: 1,
      contentDigest: "a".repeat(64),
      workspaceRevision: "workspace_nf9_effect",
    };
    const entries: HarnessHistoryEntry[] = [
      {
        kind: "user_input",
        turn: checkpoint.turn,
        input,
        content: [{ kind: "text", text: "perform an effect" }],
        acceptedAt: 1,
      },
      {
        kind: "tool_result",
        turn: checkpoint.turn,
        callId: "call_nf9_effect",
        tool: "commerce_action",
        outcome: {
          kind: "succeeded",
          output: {
            kind: "inline",
            content: [{ kind: "text", text: "accepted" }],
            digest: "b".repeat(64),
          },
        },
        authority: {
          kind: "provider_effect",
          receiptId: "receipt_nf9_effect",
          resultDigest: "c".repeat(64),
        },
        acceptedAt: 2,
      },
    ];
    expect(
      recoverFreshHarnessHistory({
        history: {
          cursor: { lastSequence: 2, lastEntryDigest: "d".repeat(64) },
          entries,
        },
        acceptedInput: { ...input, inputId: "input_nf9_next" },
        turn: {
          ...checkpoint.turn,
          turnId: "turn_nf9_next",
          inputId: "input_nf9_next",
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "harness_history_lineage_conflict" },
    });
  });
});

function currentCheckpoint(): HarnessCheckpointRecord {
  const turn = {
    turnId: "turn_nf9_classification",
    inputId: "input_nf9_classification",
    turnLeaseGeneration: 1,
    budgetRevision: "budget_nf9_classification",
  };
  return {
    backendId: "pi",
    blob: {
      objectKey:
        "harness-checkpoints/organisation/session/turn/sequence-1/checkpoint.bin",
      sha256: "a".repeat(64),
      byteLength: 1,
      formatVersion: manifest.checkpointFormat,
      harnessBuild: manifest.harnessBuild,
      createdAt: 1,
    },
    session: {
      organisationId: "organisation_nf9_classification",
      sessionId: "session_nf9_classification",
      streamId: "stream_nf9_classification",
    },
    turn,
    runtimeLease: { generation: 1, leaseId: "runtime_nf9_classification" },
    runtimeRevision: "runtime_nf9_classification",
    policyVersion: "policy_nf9_classification",
    budgetRevision: turn.budgetRevision,
    budgetUsage: { tokens: 100, activeWallMs: 10, capabilityCalls: 1 },
    usageCursor: 3,
    budgetAccountDigest: "9".repeat(64),
    cursor: { turn, lastSequence: 1, lastEventDigest: "b".repeat(64) },
    historyCursor: { lastSequence: 1, lastEntryDigest: "c".repeat(64) },
    lastActorEventSequence: 1,
    workspaceBaseRevision: "workspace_nf9_classification",
    workspaceRevision: "workspace_nf9_classification",
    instructionDigest: "d".repeat(64),
    toolCatalogDigest: "e".repeat(64),
    modelRouteDigest: CURRENT_MODEL_ROUTE_DIGEST,
  };
}
