import { hasExactKeys, isRecord } from "@seams/std";
import { bakeryFingerprint } from "@seams/bakery-model/bakery";
import { parsePhysicsRequest } from "@seams/bakery-model/bakery-physics";
import { validateProductionMaterial } from "./production-material.ts";
import type { CompletedAttempt } from "./workcell-attempt.ts";
import { compileWorkcellInput, type WorkcellInput } from "./workcell-input.ts";

// This bounded rehearsal transfers custody between independent model frames.
// Each placement is assumed; no native integration state crosses the boundary.
export const HUMAN_CELL_TRANSFER = Object.freeze({
  id: "cold-rack-1-to-source-2",
  evidence: "assumed-simulation",
  source: "rack-slot-1",
  buffer: "cold-transfer-buffer",
  destination: "source-table-2",
  capacity: 1,
  pickupSeconds: 10,
  carrySeconds: 20,
  placementSeconds: 10,
  placement: "cell-2 native model source pose",
  frame: "independent native model frames; no measured global layout",
  positionToleranceMetres: 0.01,
  orientationToleranceDegrees: 5,
} as const);

export function supportsHumanCellTransfer(input: WorkcellInput): boolean {
  return (
    input.kind === "transfer" &&
    input.bindings.cell === "cold-cell-1" &&
    input.request.bakeryTaskId === "table-to-rack" &&
    input.request.case === "nominal" &&
    input.request.execution.backend === "browser" &&
    input.request.layout.kind === "fixed"
  );
}

export async function humanCellTransferInput(attempt: CompletedAttempt) {
  if (!supportsHumanCellTransfer(attempt.input))
    throw new Error(
      "Run cell 1's nominal cold table-to-rack task in the browser before preparing human transfer.",
    );
  const compatibility = validateProductionMaterial(attempt.recording);
  if (compatibility.kind === "incompatible")
    throw new Error(compatibility.message);
  const digest = await bakeryFingerprint(
    JSON.stringify({
      route: HUMAN_CELL_TRANSFER,
      recording: attempt.recording,
    }),
  );
  const parsed = parsePhysicsRequest(
    JSON.stringify({
      ...attempt.input.request,
      attemptId: digest,
    }),
  );
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  const compiled = compileWorkcellInput(parsed.request, "0", "cold-cell-2");
  if (compiled.kind === "invalid") throw new Error(compiled.message);
  return { input: compiled.input, digest };
}

export function parseHumanCellTransfer(
  value: unknown,
): typeof HUMAN_CELL_TRANSFER {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, Object.keys(HUMAN_CELL_TRANSFER))
  )
    throw new Error(
      "The human transfer must retain its assumed route and timings.",
    );
  for (const [key, expected] of Object.entries(HUMAN_CELL_TRANSFER))
    if (value[key] !== expected)
      throw new Error(
        "The saved human transfer uses an unsupported route or assumption.",
      );
  return HUMAN_CELL_TRANSFER;
}
