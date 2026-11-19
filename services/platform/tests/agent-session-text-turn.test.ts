import type {
  AgentSessionLifecycle,
  HarnessCheckpointRecord,
  HarnessTurnLease,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import { describe, expect, test } from "vitest";

import {
  buildTextTurnCheckpointCommittedCommit,
  buildTextTurnCheckpointingCommit,
} from "../src/actors/agent-session-text-turn";
import { TEST_HARNESS_LEASE_AUTHORITY } from "./fixtures/plan25-turn";
import type { Variant } from "@purin-labs/type-utils";

const DIGEST = "d".repeat(64);
const MODEL_ROUTE_DIGEST =
  "b1cb2ef60df8212bf12e482db1f74ce7c921ba34585a1cb56de4cfde3d0b47cc";

describe(
  "canonical embedded harness text-turn transitions",
  textTurnTransitionSuite,
);

function textTurnTransitionSuite(): void {
  test(
    "rejects a stale harness lease before checkpoint persistence",
    rejectsStaleLease,
  );
  test(
    "rejects a checkpoint from another accepted Actor cursor",
    rejectsStaleCheckpoint,
  );
}

function rejectsStaleLease(): void {
  const processing = processingState();
  const lease = harnessLease(processing);
  const result = buildTextTurnCheckpointingCommit({
    current: processing,
    harnessLease: {
      ...lease,
      runtimeLease: { generation: 3, leaseId: "runtime_lease_stale" },
    },
    workspaceRevisionReceipt: workspaceReceipt(),
    completion: completionIdentity(),
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "canonical_text_turn_transition_invalid" },
  });
}

async function rejectsStaleCheckpoint(): Promise<void> {
  const processing = processingState();
  const lease = harnessLease(processing);
  const checkpointing = buildTextTurnCheckpointingCommit({
    current: processing,
    harnessLease: lease,
    workspaceRevisionReceipt: workspaceReceipt(),
    completion: completionIdentity(),
  });
  if (!checkpointing.ok) throw new Error(checkpointing.error.reason);
  const checkpoint = harnessCheckpoint(processing);
  const result = await buildTextTurnCheckpointCommittedCommit({
    current: checkpointing.value.state,
    harnessCheckpoint: { ...checkpoint, lastActorEventSequence: 1 },
    completion: completionIdentity(),
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "canonical_text_turn_transition_invalid",
      reason: "harness_checkpoint_mismatch",
    },
  });
}

function processingState(): Variant<AgentSessionLifecycle, "processing"> {
  const receipt = workspaceReceipt();
  return {
    kind: "processing",
    state: {
      identity: {
        organisationId: "organisation_1",
        sessionId: "session_1",
        streamId: "stream_1",
      },
      contract: {
        policyVersion: "policy_1",
        budgetRevision: "budget_1",
        runtimeRevision: "runtime_1",
        modelRoute: {
          keySource: "platform",
          provider: "openai-compatible",
          model: "moonshotai/kimi-k3",
        },
        lastEventSequence: 2,
      },
      resumePoint: {
        kind: "checkpoint",
        checkpoint: {
          checkpointId: "checkpoint_previous",
          stateDigest: "a".repeat(64),
          lastEventSequence: 1,
          runtimeRevision: "runtime_1",
          runtimeGeneration: 1,
          policyVersion: "policy_1",
          budgetRevision: "budget_1",
          budgetUsage: { tokens: 100, activeWallMs: 10, capabilityCalls: 1 },
          usageCursor: 3,
          budgetAccountDigest: "d".repeat(64),
          workspaceRevisionReceipt: receipt,
        },
      },
      runtimeLease: { generation: 2, leaseId: "runtime_lease_2" },
      activeTurn: {
        kind: "admitted",
        state: {
          identity: {
            turnId: "turn_2",
            inputId: "input_2",
            turnLeaseGeneration: 2,
            budgetRevision: "budget_1",
          },
          admittedAt: 20,
        },
      },
    },
  };
}

function harnessLease(
  state: Variant<AgentSessionLifecycle, "processing">,
): HarnessTurnLease {
  return {
    ...TEST_HARNESS_LEASE_AUTHORITY,
    leaseId: "harness_lease_2",
    session: state.state.identity,
    turn: state.state.activeTurn.state.identity,
    runtimeLease: state.state.runtimeLease,
    runtimeRevision: state.state.contract.runtimeRevision,
    issuedAt: 20,
    expiresAt: 100,
  };
}

function harnessCheckpoint(
  state: Variant<AgentSessionLifecycle, "processing">,
): HarnessCheckpointRecord {
  const turn = state.state.activeTurn.state.identity;
  return {
    backendId: "pi",
    blob: {
      objectKey:
        "harness-checkpoints/organisation_1/session_1/turn_2/checkpoint.bin",
      sha256: DIGEST,
      byteLength: 100,
      formatVersion: "pi-checkpoint-v1",
      harnessBuild: "pi-build-1",
      createdAt: 30,
    },
    session: state.state.identity,
    turn,
    runtimeLease: state.state.runtimeLease,
    runtimeRevision: state.state.contract.runtimeRevision,
    policyVersion: state.state.contract.policyVersion,
    budgetRevision: state.state.contract.budgetRevision,
    budgetUsage: { tokens: 100, activeWallMs: 10, capabilityCalls: 1 },
    usageCursor: 3,
    budgetAccountDigest: "d".repeat(64),
    cursor: {
      turn,
      lastSequence: 4,
      lastEventDigest: "e".repeat(64),
    },
    historyCursor: { lastSequence: 1, lastEntryDigest: "f".repeat(64) },
    lastActorEventSequence: state.state.contract.lastEventSequence,
    workspaceBaseRevision: "workspace_2",
    workspaceRevision: "workspace_2",
    instructionDigest: "1".repeat(64),
    toolCatalogDigest: "2".repeat(64),
    modelRouteDigest: MODEL_ROUTE_DIGEST,
  };
}

function workspaceReceipt(): WorkspaceRevisionReceipt {
  return {
    receiptId: "workspace_receipt_2",
    outcome: "accepted",
    workspaceId: "workspace_catalog_1",
    revision: "workspace_2",
    canonicalHead: "c".repeat(64),
    correlationId: "correlation_2",
    causation: { kind: "command", commandId: "workspace_command_2" },
  };
}

function completionIdentity() {
  return { completionId: "completion_2", acceptedAt: 30 };
}
