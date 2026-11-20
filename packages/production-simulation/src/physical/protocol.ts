import { canonicalJson, sha256HexSync } from "@purin-labs/std";
import type { CarrierDisposition } from "../physics.ts";

/**
 * The value shapes of the Plan 24 cobot protocol between the Platform and
 * the shop gateway, as this engine reads them. The TypeBox schemas that
 * check them on the wire belong to the control API; the engine receives
 * values that the wire layer has already parsed.
 */

export type CobotStation = "cold_rack" | "oven" | "cooling_rack";

export type CobotPlace = Readonly<{ station: CobotStation; shelf: number }>;

/** A named task. It never carries a joint, a speed or a safety setting. */
export type CobotTask =
  | Readonly<{
      kind: "move_mould_group";
      mouldGroup: number;
      from: CobotPlace;
      to: CobotPlace;
      programSeconds?: never;
      temperatureC?: never;
    }>
  | Readonly<{
      kind: "bake";
      programSeconds: number;
      temperatureC: number;
      mouldGroup?: never;
      from?: never;
      to?: never;
    }>;

export type CobotTaskState =
  "accepted" | "running" | "completed" | "rejected" | "indeterminate";

/** Where the controller evidences the mould group, as the engine names it. */
export type CarrierAt = CarrierDisposition;

export type DeviceRunState = "idle" | "busy" | "paused" | "stopped" | "estop";

/** Platform to gateway: the task, sent after its dispatch identity is written. */
export type CobotTaskMessage = Readonly<{
  type: "cobot_task";
  requestId: string;
  sourceKey: string;
  runId: string;
  taskId: string;
  task: CobotTask;
}>;

/** Gateway to Platform: one state of one dispatched task. */
export type CobotReport = Readonly<{
  type: "cobot_report";
  requestId: string;
  sourceKey: string;
  state: CobotTaskState;
  sequence: number;
  deviceClockMs: number;
  progress: number | null;
  phase: string | null;
  carrierAt: CarrierAt | null;
  reason: string | null;
  observedSeconds: number | null;
  replayed: boolean;
}>;

export type CobotClockEntry = Readonly<{
  sourceKey: string;
  sequence: number;
  deviceClockMs: number;
  state: DeviceRunState;
}>;

/** Gateway to Platform: the device clocks while a task is open. */
export type CobotClock = Readonly<{
  type: "cobot_clock";
  clocks: readonly CobotClockEntry[];
}>;

/** Shadow mode: a move that the controller ran from its own script. */
export type CobotObserved = Readonly<{
  type: "cobot_observed";
  sourceKey: string;
  observationId: string;
  task: CobotTask;
  state: "started" | "completed" | "failed";
  sequence: number;
  deviceClockMs: number;
  carrierAt: CarrierAt | null;
  reason: string | null;
}>;

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
