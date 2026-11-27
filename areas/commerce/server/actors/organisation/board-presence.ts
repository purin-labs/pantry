// The presence on a commerce board of the Organisation actor: who looks at
// which resource now. The Actor holds the entries in memory only.
import type { CommerceBoardPresenceEntry } from "@purin-labs/commerce-control-api";

const COMMERCE_BOARD_PRESENCE_TTL_MS = 30_000;

export function pruneCommerceBoardPresence(
  presence: Map<string, CommerceBoardPresenceEntry>,
  now: number,
): void {
  for (const [identityId, entry] of presence) {
    if (now - entry.observedAt >= COMMERCE_BOARD_PRESENCE_TTL_MS)
      presence.delete(identityId);
  }
}

export function readCommerceBoardPresence(
  presence: ReadonlyMap<string, CommerceBoardPresenceEntry>,
  resourceKey: string,
): readonly CommerceBoardPresenceEntry[] {
  const entries: CommerceBoardPresenceEntry[] = [];
  for (const entry of presence.values()) {
    if (entry.resourceKey === resourceKey) entries.push(entry);
  }
  entries.sort(compareCommerceBoardPresence);
  return entries;
}

function compareCommerceBoardPresence(
  left: CommerceBoardPresenceEntry,
  right: CommerceBoardPresenceEntry,
): number {
  return left.userId === right.userId ? 0 : left.userId < right.userId ? -1 : 1;
}
