import type { BakeryRecordingAcceptanceReference } from "@purin-labs/bakery-model/bakery-surface";
import type {
  RecordingAcceptanceTarget,
  SimulatorState,
} from "./simulator-state.ts";
import { assertNever, sha256Hex } from "@purin-labs/std";

export type RecordingAcceptanceReference = BakeryRecordingAcceptanceReference;

export async function currentRecordingAcceptanceReference(
  state: SimulatorState,
): Promise<RecordingAcceptanceReference | null> {
  const current = currentCandidate(state);
  return current === null ? null : recordingAcceptanceReference(state, current);
}

export async function recordingAcceptanceReference(
  state: SimulatorState,
  target: RecordingAcceptanceTarget,
): Promise<RecordingAcceptanceReference | null> {
  const current = currentCandidate(state);
  if (current === null || !sameCandidate(current, target)) return null;
  return {
    surfaceSessionId: state.workspace.surfaceSessionId,
    surfaceEpoch: state.workspace.surfaceEpoch,
    recordingDigest: await sha256Hex(
      JSON.stringify(current.candidate.recording),
    ),
    kind: "production",
    operationId: current.candidate.operationId,
    planFingerprint: current.candidate.fingerprint,
  };
}

export async function resolveRecordingAcceptanceReference(
  state: SimulatorState,
  reference: RecordingAcceptanceReference,
): Promise<RecordingAcceptanceTarget | null> {
  if (
    reference.surfaceSessionId !== state.workspace.surfaceSessionId ||
    reference.surfaceEpoch !== state.workspace.surfaceEpoch
  )
    return null;
  const current = currentCandidate(state);
  if (current === null || current.kind !== reference.kind) return null;
  const expected = await recordingAcceptanceReference(state, current);
  if (expected === null || !sameReference(expected, reference)) return null;
  return current;
}

// Only a production or rehearsal run's pending result is a candidate.
function currentCandidate(
  state: SimulatorState,
): RecordingAcceptanceTarget | null {
  if (state.workspace.kind !== "production") return null;
  const session = state.workspace.production;
  if (
    session.data.kind !== "ready" ||
    session.pending.kind !== "recording" ||
    session.pending.fingerprint !== session.data.plan.fingerprint
  )
    return null;
  return { kind: "production", candidate: session.pending };
}

function sameCandidate(
  current: RecordingAcceptanceTarget,
  target: RecordingAcceptanceTarget,
): boolean {
  return current.candidate === target.candidate;
}

function sameReference(
  expected: RecordingAcceptanceReference,
  received: RecordingAcceptanceReference,
): boolean {
  if (
    expected.kind !== received.kind ||
    expected.surfaceSessionId !== received.surfaceSessionId ||
    expected.surfaceEpoch !== received.surfaceEpoch ||
    expected.recordingDigest !== received.recordingDigest
  )
    return false;
  switch (expected.kind) {
    case "production":
      return (
        received.kind === "production" &&
        expected.operationId === received.operationId &&
        expected.planFingerprint === received.planFingerprint
      );
    // Earlier single-rehearsal and multi-tray candidates can no longer be
    // current.
    case "workcell":
    case "trays":
      return false;
    default:
      return assertNever(expected, "Unsupported recording candidate");
  }
}
