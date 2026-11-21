import { canonicalJson, sha256HexSync } from "@purin-labs/std";
import type {
  CobotClock,
  CobotReport,
  CobotTask,
  CobotTaskMessage,
} from "@purin-labs/control-api/device-cobot";

/**
 * The Plan 24 cobot protocol as this engine reads it. The shapes and their
 * TypeBox checks belong to the control API (`device-cobot.ts`); the engine
 * receives values that the wire layer has already parsed.
 */

export type {
  CarrierAt,
  CobotClock,
  CobotClockEntry,
  CobotObserved,
  CobotPlace,
  CobotReport,
  CobotStation,
  CobotTask,
  CobotTaskMessage,
  CobotTaskState,
  DeviceRunState,
} from "@purin-labs/control-api/device-cobot";

/**
 * The evidence a physical run reads: the dispatch records that the caller
 * wrote before each send, and what the gateway reported.
 */
export type PhysicalEvidence = CobotTaskMessage | CobotReport | CobotClock;

/** Each device clock reading at the run's logical zero, by source key. */
export type ClockOrigin = Readonly<Record<string, number>>;

export const SOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/** One identity for each attempt, so a repeated send names the same task. */
export function dispatchIdentity(
  runId: string,
  executionId: string,
  attemptId: string,
): string {
  const digest = sha256HexSync(
    canonicalJson({ runId, executionId, attemptId }),
  );
  return `dsp_${digest.slice(0, 24)}`;
}

export function sameTask(left: CobotTask, right: CobotTask): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
