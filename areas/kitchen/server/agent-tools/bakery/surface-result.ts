import {
  parseBakerySurfaceReceipt,
  parseScenarioSaveManifest,
} from "@purin-labs/bakery-model/bakery-surface";
import { parseRunSnapshotSummary } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { isRecord } from "@purin-labs/std";
import type { AgentRunSaveVerification } from "../../bakery/agent-run-save";
import type { AgentScenarioSaveResult } from "../../bakery/agent-scenario-save";
import type { HarnessBakerySurfaceToolResult } from "../kitchen/services";

// The result of a Kitchen surface tool, as the Kitchen and the Register tools
// read it: the receipt of the page, and if the command succeeded. A part of
// the Kitchen contract.

export function readBakerySurfaceReceiptId(value: unknown): string {
  const parsed = parseBakerySurfaceToolResult(value);
  if (parsed === null) {
    throw new Error("Kitchen surface receipt is missing");
  }
  return parsed.receiptId;
}

export function bakerySurfaceToolSucceeded(value: unknown): boolean {
  const parsed = parseBakerySurfaceToolResult(value);
  return (
    parsed !== null &&
    // A Costs view command answers with the page it now shows (Plan 87).
    (parsed.receipt.outcome.kind === "page_completed" ||
      (parsed.receipt.outcome.kind === "completed" &&
        parsed.receipt.outcome.result.kind === "succeeded"))
  );
}

function parseBakerySurfaceToolResult(
  value: unknown,
): HarnessBakerySurfaceToolResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.receiptId !== "string"
  ) {
    return null;
  }
  const receipt = parseBakerySurfaceReceipt(value.receipt);
  const saveVerification = parseAgentRunSaveVerification(
    value.saveVerification,
  );
  const scenarioSaveResult = parseAgentScenarioSaveResult(
    value.scenarioSaveResult,
  );
  return receipt.kind === "valid" &&
    saveVerification !== null &&
    scenarioSaveResult !== null
    ? {
        receiptId: value.receiptId,
        receipt: receipt.value,
        saveVerification,
        scenarioSaveResult,
      }
    : null;
}

function parseAgentScenarioSaveResult(
  value: unknown,
): AgentScenarioSaveResult | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "none" || value.kind === "read_failed") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (value.kind === "unavailable") {
    return Object.keys(value).length === 2 && typeof value.effectId === "string"
      ? { kind: "unavailable", effectId: value.effectId }
      : null;
  }
  if (
    value.kind !== "saved" ||
    Object.keys(value).length !== 4 ||
    typeof value.effectId !== "string" ||
    typeof value.scenarioId !== "string"
  ) {
    return null;
  }
  const manifest = parseScenarioSaveManifest(value.manifest);
  return manifest !== null && manifest.id === value.scenarioId
    ? {
        kind: "saved",
        effectId: value.effectId,
        manifest,
        scenarioId: value.scenarioId,
      }
    : null;
}

function parseAgentRunSaveVerification(
  value: unknown,
): AgentRunSaveVerification | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "none" || value.kind === "read_failed") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (
    value.kind === "unavailable" &&
    Object.keys(value).length === 2 &&
    typeof value.effectId === "string"
  ) {
    return { kind: "unavailable", effectId: value.effectId };
  }
  if (
    value.kind !== "verified" ||
    Object.keys(value).length !== 3 ||
    typeof value.effectId !== "string"
  ) {
    return null;
  }
  const snapshot = parseRunSnapshotSummary(value.snapshot);
  return snapshot === null
    ? null
    : { kind: "verified", effectId: value.effectId, snapshot };
}
