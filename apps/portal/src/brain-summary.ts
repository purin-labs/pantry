import React from "react";

import {
  brainItemsToReview,
  parseBrainSummaryResponse,
  type BrainSummary,
} from "@purin-labs/control-api";

import { controlRead, forgetWithControlReads } from "./control-client";
import { brainSummaryPath } from "./control-paths";

/**
 * What waits for the signed-in person in the Brain. The navigation and the
 * Brain page read one copy for each Organisation, so both show one number.
 */
const summaries = new Map<string, BrainSummary>();
const listeners = new Set<() => void>();
/** The read that runs for an Organisation, and whether one more must follow. */
const reads = new Map<string, { again: boolean; done: Promise<void> }>();

forgetWithControlReads(() => {
  summaries.clear();
  notify();
});

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type SummaryRead = (path: string) => Promise<unknown>;

async function readSummary(
  organisationId: string,
  read: SummaryRead,
): Promise<void> {
  try {
    summaries.set(
      organisationId,
      parseBrainSummaryResponse(await read(brainSummaryPath(organisationId))),
    );
  } catch {
    // The count is supplementary. A failed read shows no count.
    summaries.delete(organisationId);
  }
  notify();
}

/**
 * Reads the summary again. A call that arrives while a read runs starts one
 * more read after it, so the last answer was asked for after the last change.
 */
export function refreshBrainSummary(
  organisationId: string,
  read: SummaryRead = controlRead,
): Promise<void> {
  const running = reads.get(organisationId);
  if (running !== undefined) {
    running.again = true;
    return running.done;
  }
  const state = { again: false, done: Promise.resolve() };
  state.done = (async (): Promise<void> => {
    do {
      state.again = false;
      await readSummary(organisationId, read);
    } while (state.again);
    reads.delete(organisationId);
  })();
  reads.set(organisationId, state);
  return state.done;
}

/** The summary this tab holds for an Organisation, or null before a read. */
export function useBrainSummary(organisationId: string): BrainSummary | null {
  const snapshot = (): BrainSummary | null =>
    summaries.get(organisationId) ?? null;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

const REFRESH_MS = 300_000;

function watchBrainSummary(organisationId: string): () => void {
  void refreshBrainSummary(organisationId);
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible")
      void refreshBrainSummary(organisationId);
  }, REFRESH_MS);
  return () => window.clearInterval(timer);
}

/**
 * How many items wait for this person, for the Brain entry of the
 * navigation. Null means that no count is known. The count is read when the
 * workspace opens, every five minutes while the tab is in view, and when the
 * Brain page changes a record.
 */
export function useBrainItemsToReview(organisationId: string): number | null {
  React.useEffect(() => watchBrainSummary(organisationId), [organisationId]);
  const summary = useBrainSummary(organisationId);
  return summary === null ? null : brainItemsToReview(summary);
}
