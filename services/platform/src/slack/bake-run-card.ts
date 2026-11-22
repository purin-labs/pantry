import type {
  BakeRunRecord,
  BakeRunSeen,
  BakeRunTaskView,
} from "@purin-labs/kitchen-control-api";
import { cardDeliveryIds } from "./card-delivery-ids";

/**
 * The card of one bake run in its proposal's Slack thread (Plan 24 S6). The
 * card shows the run's state, each task with its dispatch and the
 * controller's receipt, the one hold that a person settles, each settlement
 * and the over-bake risk. While the run runs or holds, the card has a Pause
 * button: the click goes through the same check as the Bakes page, and it
 * only stops the next dispatch and pauses the cobots. No Slack click moves a
 * cobot; a person resumes, settles and stops on the Bakes page.
 */

export const BAKE_RUN_CARD = cardDeliveryIds("bake_run");
export const SLACK_BAKE_RUN_PAUSE_ACTION = "bake_run_pause";

type RunRecord = Omit<BakeRunRecord, "check" | "problem">;

const SECTION_TEXT_LIMIT = 3_000;

const STATE: Readonly<Record<RunRecord["state"], string>> = {
  not_started: "not started",
  running: "running",
  paused: "paused",
  held: "held for a person",
  completed: "baked. A person checks the pieces on the Bakes page",
  stopped: "stopped",
  checked: "checked",
};

const TASK: Readonly<Record<BakeRunTaskView["state"], string>> = {
  planned: "planned",
  ready: "next",
  dispatched: "sent",
  accepted: "accepted",
  running: "running",
  completed: "done",
  rejected: "refused",
  failed: "failed",
};

const SEEN: Readonly<Record<BakeRunSeen, string>> = {
  source: "on its source shelf",
  tool: "on the cobot's tool",
  destination: "on its destination shelf",
  lost: "lost",
};

function pausable(record: RunRecord): boolean {
  return (
    record.mode === "approval" &&
    (record.state === "running" || record.state === "held")
  );
}

/** The card's subject keeps the run's mode, so its first post knows it. */
function subjectOf(record: RunRecord): string {
  return `${record.runId}.${record.mode}`;
}

export function bakeRunCardNotice(record: RunRecord): string {
  return BAKE_RUN_CARD.notice(subjectOf(record));
}

export function bakeRunCardUpdate(record: RunRecord, revision: number): string {
  return BAKE_RUN_CARD.update(
    subjectOf(record),
    `${String(revision)}-${pausable(record) ? "pause" : "plain"}`,
  );
}

/** The run of a card that shows the Pause button, or null. */
export function bakeRunPauseTarget(deliveryId: string): string | null {
  if (!BAKE_RUN_CARD.isCard(deliveryId)) return null;
  const notice = BAKE_RUN_CARD.noticeOfUpdate(deliveryId);
  const subject = (notice ?? deliveryId).slice(BAKE_RUN_CARD.notice("").length);
  const [runId, mode] = subject.split(".");
  const shows = notice === null ? null : deliveryId.split(":")[1];
  const pause =
    shows === undefined || shows === null
      ? mode === "approval"
      : shows.endsWith("-pause");
  return pause && runId !== undefined ? runId : null;
}

function taskLine(record: RunRecord, task: BakeRunTaskView): string {
  const dispatch = record.dispatches.find(
    (item) => item.requestId === task.requestId,
  );
  const sent =
    dispatch === undefined
      ? ""
      : ` Dispatch ${dispatch.requestId}: ${dispatch.state}.`;
  const receipt =
    task.state === "completed" && task.observed.observedSeconds !== null
      ? ` The controller's receipt: ${task.observed.observedSeconds.toFixed(1)} s.`
      : task.reason === null
        ? ""
        : ` Reason: ${task.reason}.`;
  return `- ${task.key} on ${task.sourceKey}: ${TASK[task.state]}.${sent}${receipt}`;
}

export function bakeRunCardText(record: RunRecord): string {
  const lines = [
    record.mode === "shadow"
      ? `Shadow run of ${record.productName}: ${STATE[record.state]}. Purin Pantry only watches the cobots and sends them nothing.`
      : `Bake run of ${record.productName}: ${STATE[record.state]}.`,
  ];
  for (const task of record.view?.tasks ?? [])
    lines.push(taskLine(record, task));
  if (record.hold !== null)
    lines.push(
      `Hold for a person: ${record.hold.message} Settle it on the Bakes page.`,
    );
  for (const settled of record.settlements)
    lines.push(
      `Settled (${settled.holdCode.replaceAll("_", " ")}): ${settled.decision}${settled.seen === null ? "" : `, the mould group was ${SEEN[settled.seen]}`}.`,
    );
  if (record.unloadRisk !== null)
    lines.push(
      `Over-bake risk: ${record.unloadRisk.step} did not start within ${String(record.unloadRisk.graceSeconds)} s after the bake ended.`,
    );
  return lines.join("\n");
}

/** The one Slack message of the over-bake risk, in the proposal's thread. */
export function bakeRunOverBakeText(
  record: RunRecord,
  risk: NonNullable<RunRecord["unloadRisk"]>,
): string {
  return `Over-bake risk: the bake of ${record.productName} ended, and ${risk.step} did not start within ${String(risk.graceSeconds)} s. It is ${Math.round(risk.lateSeconds)} s late. The person on shift checks the oven now. ${record.state === "paused" ? "The run is paused: resume it on the Bakes page." : record.state === "held" ? "The run is held: settle it on the Bakes page." : "The unload goes when the run can send it."}`;
}

export function bakeRunCardBlocks(
  text: string,
  pauseRunId: string | null,
  portalUrl: string | null,
): readonly Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  if (pauseRunId !== null)
    elements.push({
      type: "button",
      action_id: SLACK_BAKE_RUN_PAUSE_ACTION,
      text: { type: "plain_text", text: "Pause" },
      style: "danger",
      value: pauseRunId,
      confirm: {
        title: { type: "plain_text", text: "Pause this bake run?" },
        text: {
          type: "plain_text",
          text: "No next task goes, and the cobots pause. The oven keeps its program. A person resumes the run on the Bakes page. This is not an emergency stop.",
        },
        confirm: { type: "plain_text", text: "Pause" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    });
  if (portalUrl !== null)
    elements.push({
      type: "button",
      action_id: "bake_run_open",
      text: { type: "plain_text", text: "Open Bakes" },
      url: portalUrl,
    });
  const section = {
    type: "section",
    text: {
      type: "plain_text",
      text: text.slice(0, SECTION_TEXT_LIMIT),
      emoji: false,
    },
  };
  return elements.length === 0
    ? [section]
    : [section, { type: "actions", elements }];
}
