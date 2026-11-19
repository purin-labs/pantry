import type { CellId } from "./workcell-instances.ts";
import {
  parsePhysicsReplay,
  parsePhysicsCyclePlan,
  parsePhysicsRackPlan,
  isCompletedLoading,
  type PhysicsReplay,
  type PhysicsSequence,
} from "@purin-labs/bakery-model/bakery-physics";
import { bakeryFingerprint } from "@purin-labs/bakery-model/bakery";
import {
  compileCycleInput,
  compileRackCycleInput,
  type WorkcellInput,
} from "./workcell-input.ts";
import { physicsOutcome } from "./physics-playback.ts";

const validated: unique symbol = Symbol("native continuation");
type HandoffIdentity = Readonly<{
  [validated]: true;
  digest: string;
  file: string;
}>;
export type NativeContinuation = HandoffIdentity &
  (
    | Readonly<{ kind: "unload"; predecessor: PhysicsSequence["loading"] }>
    | Readonly<{ kind: "rack"; predecessor: PhysicsSequence }>
  );
// A successor's request derives only from its predecessor's accepted result
// and the handoff digest; the handoff file itself is needed only to resume.
export type ContinuationState =
  | Readonly<{
      kind: "unload";
      predecessor: PhysicsSequence["loading"];
      digest: string;
    }>
  | Readonly<{
      kind: "rack";
      predecessor: PhysicsSequence;
      digest: string;
    }>;

// The browser validates the projected evidence. Rust validates full integration
// and controller state before it resumes this original native artifact.
export function parseNativeContinuation(file: string): NativeContinuation {
  if (new TextEncoder().encode(file).length > 16 * 1024 * 1024)
    throw new Error("Choose a native handoff smaller than 16 MiB.");
  const raw = object(JSON.parse(file));
  let kind: NativeContinuation["kind"];
  let digest: unknown;
  let replay: unknown;
  if (raw.kind === "bakery-physics-handoff" && raw.schemaVersion === 3) {
    kind = "unload";
    digest = raw.digest;
    replay = raw.recording;
  } else if (raw.kind === "bakery-native-rack-handoff") {
    kind = "rack";
    const handoff = object(raw.handoff);
    const loading = object(handoff.loading);
    if (handoff.schemaVersion !== 2 || loading.schemaVersion !== 3)
      throw new Error("Unsupported native handoff version.");
    digest = handoff.digest;
    replay = {
      kind: "bakery-physics-sequence",
      schemaVersion: 2,
      handoffDigest: loading.digest,
      loading: loading.recording,
      unloading: handoff.recording,
    };
  } else {
    throw new Error("Open a completed native loading or retrieval handoff.");
  }
  if (typeof digest !== "string")
    throw new Error("The native handoff has no valid predecessor digest.");
  const parsed = parsePhysicsReplay(JSON.stringify(replay));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  const state = continuationState(kind, parsed.recording, digest);
  return Object.freeze<NativeContinuation>({
    [validated]: true,
    ...state,
    file,
  });
}

export function continuationState(
  kind: ContinuationState["kind"],
  predecessor: PhysicsReplay,
  digest: string,
): ContinuationState {
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw new Error("The native handoff has no valid predecessor digest.");
  if (physicsOutcome(predecessor).kind !== "completed")
    throw new Error("A failed operation cannot supply a continuation.");
  if (kind === "unload") {
    if (
      predecessor.kind !== "bakery-physics-recording" ||
      !isCompletedLoading(predecessor)
    )
      throw new Error("Unloading requires successful nominal loading.");
    return { kind, predecessor, digest };
  }
  if (
    predecessor.kind !== "bakery-physics-sequence" ||
    predecessor.loading.fixture.kind !== "oven-and-rack"
  )
    throw new Error(
      "Racking requires completed retrieval in the combined fixture.",
    );
  return { kind, predecessor, digest };
}

export async function continuationInput(
  handoff: ContinuationState,
  rackCase: "nominal" | "slip",
  cellId: CellId,
): Promise<WorkcellInput> {
  if (handoff.kind === "unload") {
    const request = handoff.predecessor.request;
    const plan = parsePhysicsCyclePlan(
      JSON.stringify({
        request,
        returnRequest: {
          ...request,
          bakeryTaskId: "oven-to-table",
          attemptId: await bakeryFingerprint(`unload:${handoff.digest}`),
        },
        handoffDigest: handoff.digest,
      }),
    );
    if (plan.kind === "rejected") throw new Error(plan.message);
    const compiled = compileCycleInput(plan.plan, "0", cellId);
    if (compiled.kind === "invalid") throw new Error(compiled.message);
    return compiled.input;
  }
  if (handoff.kind === "rack") {
    const predecessor = handoff.predecessor;
    const request = predecessor.unloading.request;
    const plan = parsePhysicsRackPlan(
      JSON.stringify({
        cycle: {
          request: predecessor.loading.request,
          returnRequest: request,
          handoffDigest: predecessor.handoffDigest,
        },
        rackRequest: {
          ...request,
          bakeryTaskId: "table-to-rack",
          case: rackCase,
          attemptId: await bakeryFingerprint(
            JSON.stringify(["rack", rackCase, handoff.digest]),
          ),
        },
        rackHandoffDigest: handoff.digest,
      }),
    );
    if (plan.kind === "rejected") throw new Error(plan.message);
    const compiled = compileRackCycleInput(plan.plan, "0", cellId);
    if (compiled.kind === "invalid") throw new Error(compiled.message);
    return compiled.input;
  }
  throw new Error(
    "The native handoff does not describe a supported successor.",
  );
}

export function continuationMatchesInput(
  handoff: NativeContinuation,
  input: WorkcellInput,
): boolean {
  if (handoff.kind === "unload" && input.kind === "oven-cycle")
    return (
      input.handoffDigest === handoff.digest &&
      JSON.stringify(input.request) ===
        JSON.stringify(handoff.predecessor.request)
    );
  if (handoff.kind === "rack" && input.kind === "rack-cycle")
    return (
      input.rackPlan.rackHandoffDigest === handoff.digest &&
      input.handoffDigest === handoff.predecessor.handoffDigest &&
      JSON.stringify(input.request) ===
        JSON.stringify(handoff.predecessor.loading.request) &&
      JSON.stringify(input.returnRequest) ===
        JSON.stringify(handoff.predecessor.unloading.request)
    );
  return false;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a native handoff object.");
  return Object.fromEntries(Object.entries(value));
}
