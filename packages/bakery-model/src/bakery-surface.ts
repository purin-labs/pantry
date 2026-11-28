export {
  parseBakeryProductionControl,
  type BakeryPersistentSurface,
  type BakeryProductionControl,
  type BakeryProductionReview,
  type BakeryProductionSnapshotSurface,
  type BakeryProductionTarget,
} from "./bakery-persistent-surface.ts";
export {
  isBakeryFloorPlanResetAction,
  normalizeYawDegrees,
  parseBakeryStoreInteriorAction,
  quarterTurnDegrees,
  type BakeryFloorPlanResetAction,
  type BakeryStoreInteriorAction,
  type BakerySurfaceEquipment,
  type BakerySurfaceOpening,
  type BakerySurfaceShiftLayout,
  type BakerySurfaceStoreInterior,
} from "./bakery-floor-plan.ts";
import { identifier } from "./bakery-surface-text.ts";
export {
  parseBakeryWorkspaceViewAction,
  type BakeryCameraView,
  type BakeryDoorInspection,
  type BakeryRecordingCameraView,
  type BakeryShiftDock,
  type BakeryWorkspaceViewAction,
} from "./bakery-surface-view.ts";
import { parseBakeryBrowserBinding } from "./bakery-context.ts";
export {
  parseBakeryWorkcellPreparation,
  type BakeryWorkcellPreparation,
  type BakeryRehearsalExample,
} from "./bakery-workcell-preparation.ts";
export {
  parseBakeryPlaybackAction,
  type BakeryPlaybackAction,
} from "./bakery-playback.ts";
import { parseSurfacePageCommand } from "@purin-labs/control-api";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
  sha256HexSync,
} from "@purin-labs/std";
import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceContextV1,
  BakerySurfaceEffectOutcomeV1,
  BakerySurfaceEffectParseResult,
  BakerySurfaceEffectV1,
  BakerySurfaceReceiptParseResult,
  BakerySurfaceReceiptV1,
  ExecutableBakerySurfaceEffectV1,
  PageCommandEffectV1,
} from "./bakery-surface-types.ts";
import {
  ENCODER,
  MAX_CONTEXT_BYTES,
  SHA256_PATTERN,
  invalidEffect,
  invalidReceipt,
  parseContext,
  parseEffectOutcome,
  surfaceCommandName,
} from "./bakery-surface-parsers.ts";
import { parseBakerySurfaceCommand } from "./bakery-surface-command-parser.ts";
export {
  isRehearsalChange,
  parseBakeryFileAction,
  parseBakerySurfaceCommand,
} from "./bakery-surface-command-parser.ts";
export {
  parseBakeryProductionPanel,
  parseBakerySurfaceAttachment,
  parseRecordingAcceptanceReference,
  parseScenarioSaveManifest,
} from "./bakery-surface-parsers.ts";
export type {
  BakeryFileAction,
  BakeryFileManifest,
  BakeryProductionEdit,
  BakeryProductionPanel,
  BakeryProductionReplacement,
  BakeryProductionReplacementSource,
  BakeryRecordingAcceptanceReference,
  BakeryRehearsalChange,
  BakeryRehearsalEdit,
  BakeryRehearsalPreset,
  BakeryRehearsalReview,
  BakeryRunComparison,
  BakeryRunOpenReview,
  BakeryRunSaveInspection,
  BakeryRunSummary,
  BakeryScenarioSaveInspection,
  BakerySimulationMode,
  BakerySurfaceAttachmentV1,
  BakerySurfaceCommandResultV1,
  BakerySurfaceCommandV1,
  BakerySurfaceContextV1,
  BakerySurfaceDraftReference,
  BakerySurfaceEditOperation,
  BakerySurfaceEditProposalV1,
  BakerySurfaceEffectOutcomeV1,
  BakerySurfaceEffectV1,
  BakerySurfaceManualTask,
  BakerySurfacePendingOperation,
  BakerySurfacePlayback,
  BakerySurfaceProductionAssignment,
  BakerySurfaceProductionDraft,
  BakerySurfaceRackLayout,
  BakerySurfaceReceiptV1,
  BakerySurfaceRehearsalTray,
  BakerySurfaceRunPreview,
  BakerySurfaceRunSaveManifest,
  BakerySurfaceScheduledRehearsal,
  BakerySurfaceSelection,
  BakerySurfaceSelectionTarget,
  BakerySurfaceSummary,
  BakerySurfaceTaskDetail,
  BakerySurfaceToolCommandName,
  BakerySurfaceTrayLayout,
  ExecutableBakerySurfaceEffectV1,
  PageCommandEffectV1,
  RejectedBakerySurfaceCommandResultV1,
} from "./bakery-surface-types.ts";

const MAX_EFFECT_BYTES = 20 * 1024;
/** A page command's receipt carries a fresh observation of up to 24 KiB. */
const MAX_PAGE_RECEIPT_BYTES = 28 * 1024;

export async function createBakerySurfaceAttachment(
  context: BakerySurfaceContextV1,
): Promise<BakerySurfaceAttachmentV1> {
  const normalized = parseContext(context);
  if (normalized === null)
    throw new Error("Invalid Kitchen surface context.");
  const serialized = JSON.stringify(normalized);
  if (ENCODER.encode(serialized).byteLength > MAX_CONTEXT_BYTES)
    throw new Error("The Kitchen context exceeds the 16 KiB limit.");
  return {
    kind: "bakery-surface-context",
    digest: await sha256Hex(serialized),
    context: normalized,
  };
}

export async function createBakerySurfaceEffect(input: {
  readonly effectId: string;
  readonly dispatchId: string;
  readonly deadlineAt: number;
  readonly command: BakerySurfaceEffectV1["command"];
}): Promise<BakerySurfaceEffectV1> {
  const command = parseBakeryEffectCommand(input.command);
  if (command.kind === "invalid") throw new Error(command.message);
  return {
    schemaVersion: 1,
    kind: "bakery-surface-effect",
    effectId: input.effectId,
    dispatchId: input.dispatchId,
    commandDigest: await sha256Hex(JSON.stringify(command.value)),
    deadlineAt: input.deadlineAt,
    command: command.value,
  };
}

export async function createBakerySurfaceReceipt(
  effect: BakerySurfaceEffectV1,
  outcome: BakerySurfaceEffectOutcomeV1,
): Promise<BakerySurfaceReceiptV1> {
  return {
    schemaVersion: 1,
    kind: "bakery-surface-receipt",
    effectId: effect.effectId,
    dispatchId: effect.dispatchId,
    commandDigest: effect.commandDigest,
    resultDigest: await sha256Hex(JSON.stringify(outcome)),
    outcome,
  };
}

/**
 * The attachment of a Kitchen state that a screen observation carries
 * (Plan 87 phase 2). The server computes the digest, so the browser sends
 * none; it is the digest that `createBakerySurfaceAttachment` gives. Null
 * when the state is not a valid Kitchen context of at most 16 KiB.
 */
export function bakerySurfaceAttachmentFromState(
  raw: unknown,
): BakerySurfaceAttachmentV1 | null {
  const context = parseContext(raw);
  if (context === null) return null;
  const serialized = JSON.stringify(context);
  if (ENCODER.encode(serialized).byteLength > MAX_CONTEXT_BYTES) return null;
  return {
    kind: "bakery-surface-context",
    digest: sha256HexSync(serialized),
    context,
  };
}

export function parseBakerySurfaceEffect(
  raw: unknown,
): BakerySurfaceEffectParseResult {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "effectId",
      "dispatchId",
      "commandDigest",
      "deadlineAt",
      "command",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-surface-effect" ||
    !identifier(raw.effectId) ||
    !identifier(raw.dispatchId) ||
    typeof raw.commandDigest !== "string" ||
    !SHA256_PATTERN.test(raw.commandDigest) ||
    !isNonNegativeInteger(raw.deadlineAt)
  )
    return invalidEffect("The Kitchen surface effect is invalid.");
  const command = parseBakeryEffectCommand(raw.command);
  if (command.kind === "invalid") return invalidEffect(command.message);
  const value: BakerySurfaceEffectV1 = {
    schemaVersion: 1,
    kind: "bakery-surface-effect",
    effectId: raw.effectId,
    dispatchId: raw.dispatchId,
    commandDigest: raw.commandDigest,
    deadlineAt: raw.deadlineAt,
    command: command.value,
  };
  return ENCODER.encode(JSON.stringify(value)).byteLength <= MAX_EFFECT_BYTES
    ? { kind: "valid", value }
    : invalidEffect("The Kitchen surface effect exceeds the size limit.");
}

export async function verifyBakerySurfaceEffect(
  effect: BakerySurfaceEffectV1,
): Promise<boolean> {
  return (
    effect.commandDigest === (await sha256Hex(JSON.stringify(effect.command)))
  );
}

export function parseBakerySurfaceReceipt(
  raw: unknown,
): BakerySurfaceReceiptParseResult {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "effectId",
      "dispatchId",
      "commandDigest",
      "resultDigest",
      "outcome",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-surface-receipt" ||
    !identifier(raw.effectId) ||
    !identifier(raw.dispatchId) ||
    typeof raw.commandDigest !== "string" ||
    !SHA256_PATTERN.test(raw.commandDigest) ||
    typeof raw.resultDigest !== "string" ||
    !SHA256_PATTERN.test(raw.resultDigest)
  )
    return invalidReceipt("The Kitchen surface receipt is invalid.");
  const outcome = parseEffectOutcome(raw.outcome);
  if (outcome === null)
    return invalidReceipt(
      "The Kitchen surface receipt outcome is invalid.",
    );
  const value: BakerySurfaceReceiptV1 = {
    schemaVersion: 1,
    kind: "bakery-surface-receipt",
    effectId: raw.effectId,
    dispatchId: raw.dispatchId,
    commandDigest: raw.commandDigest,
    resultDigest: raw.resultDigest,
    outcome,
  };
  const limit =
    outcome.kind === "page_completed"
      ? MAX_PAGE_RECEIPT_BYTES
      : MAX_EFFECT_BYTES;
  return ENCODER.encode(JSON.stringify(value)).byteLength <= limit
    ? { kind: "valid", value }
    : invalidReceipt(
        "The Kitchen surface receipt exceeds the size limit.",
      );
}

export async function verifyBakerySurfaceReceipt(
  receipt: BakerySurfaceReceiptV1,
): Promise<boolean> {
  return (
    receipt.resultDigest === (await sha256Hex(JSON.stringify(receipt.outcome)))
  );
}

export async function verifyBakerySurfaceAttachment(
  attachment: BakerySurfaceAttachmentV1,
): Promise<boolean> {
  return (
    attachment.digest === (await sha256Hex(JSON.stringify(attachment.context)))
  );
}

function parseBakeryEffectCommand(
  raw: unknown,
):
  | Readonly<{ kind: "valid"; value: BakerySurfaceEffectV1["command"] }>
  | Readonly<{ kind: "invalid"; message: string }> {
  if (isRecord(raw) && raw.kind === "page_command") {
    const command = parseSurfacePageCommand(raw);
    return command === null
      ? { kind: "invalid", message: "Invalid Portal page command." }
      : { kind: "valid", value: command };
  }
  if (!isRecord(raw) || raw.kind !== "prepare_context")
    return parseBakerySurfaceCommand(raw);
  const binding = parseBakeryBrowserBinding(raw.binding);
  if (
    !hasExactKeys(raw, [
      "kind",
      "schemaVersion",
      "binding",
      "requiredCommand",
    ]) ||
    raw.schemaVersion !== 1 ||
    binding === null ||
    !surfaceCommandName(raw.requiredCommand) ||
    raw.requiredCommand === "apply_reviewed_edit"
  ) {
    return {
      kind: "invalid",
      message: "Invalid Kitchen preparation binding.",
    };
  }
  return {
    kind: "valid",
    value: {
      kind: "prepare_context",
      schemaVersion: 1,
      binding,
      requiredCommand: raw.requiredCommand,
    },
  };
}

export function isExecutableBakerySurfaceEffect(
  effect: BakerySurfaceEffectV1,
): effect is ExecutableBakerySurfaceEffectV1 {
  return (
    effect.command.kind !== "prepare_context" &&
    effect.command.kind !== "page_command"
  );
}

export function isPageCommandEffect(
  effect: BakerySurfaceEffectV1,
): effect is PageCommandEffectV1 {
  return effect.command.kind === "page_command";
}

export function bakeryEffectDeliveryTarget(
  effect: BakerySurfaceEffectV1,
): Readonly<{ surfaceSessionId: string; surfaceEpoch: number }> {
  // A page command goes to the browser of the request, as a preparation does.
  if (effect.command.kind === "page_command")
    return {
      surfaceSessionId: `browser:${effect.command.binding.browserInstanceId}`,
      surfaceEpoch: 0,
    };
  return effect.command.kind === "prepare_context"
    ? {
        surfaceSessionId: `browser:${effect.command.binding.browserInstanceId}`,
        surfaceEpoch: 0,
      }
    : effect.command.target;
}
