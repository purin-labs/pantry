import React from "react";

/**
 * What this browser has opened on the Brain page, so that a row can say that
 * its record changed since. It is a convenience of one browser: nothing
 * depends on it, and the page works when the browser keeps nothing.
 */
export type SeenRecords = Readonly<{
  /** When this browser first opened the list. Older changes are not new. */
  baseline: number;
  /** For each record, the time of the change that was on screen last. */
  opened: Readonly<Record<string, number>>;
}>;

const MAX_OPENED = 600;

function storageKey(organisationId: string): string {
  return `satyr.brain.seen.${organisationId}`;
}

function readSeen(organisationId: string, now: number): SeenRecords {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(organisationId)) ?? "null",
    );
    if (
      typeof raw === "object" &&
      raw !== null &&
      "baseline" in raw &&
      typeof raw.baseline === "number" &&
      "opened" in raw &&
      typeof raw.opened === "object" &&
      raw.opened !== null
    ) {
      const opened: Record<string, number> = {};
      for (const [key, at] of Object.entries(raw.opened))
        if (typeof at === "number") opened[key] = at;
      return { baseline: raw.baseline, opened };
    }
  } catch {
    // A browser that keeps nothing starts from now on each visit.
  }
  return { baseline: now, opened: {} };
}

function writeSeen(organisationId: string, seen: SeenRecords): void {
  try {
    window.localStorage.setItem(
      storageKey(organisationId),
      JSON.stringify(seen),
    );
  } catch {
    // The mark is kept for this visit only.
  }
}

/** Whether a record changed after this browser last had it on screen. */
export function isNewRecord(
  seen: SeenRecords,
  key: string,
  changedAt: number | null,
): boolean {
  return (
    changedAt !== null &&
    changedAt > seen.baseline &&
    changedAt > (seen.opened[key] ?? 0)
  );
}

export type SeenStore = Readonly<{
  seen: SeenRecords;
  /** Records that a record is on screen with its change of `changedAt`. */
  markOpened: (key: string, changedAt: number | null) => void;
}>;

export function useSeenRecords(organisationId: string): SeenStore {
  const [seen, setSeen] = React.useState<SeenRecords>(() => {
    const read = readSeen(organisationId, Date.now());
    writeSeen(organisationId, read);
    return read;
  });
  const markOpened = React.useCallback(
    (key: string, changedAt: number | null): void => {
      if (changedAt === null) return;
      setSeen((current) => {
        if ((current.opened[key] ?? 0) >= changedAt) return current;
        const entries = Object.entries({ ...current.opened, [key]: changedAt });
        // The oldest marks go first when a browser holds very many.
        const kept = entries
          .sort((left, right) => right[1] - left[1])
          .slice(0, MAX_OPENED);
        const next = { ...current, opened: Object.fromEntries(kept) };
        writeSeen(organisationId, next);
        return next;
      });
    },
    [organisationId],
  );
  return { seen, markOpened };
}
