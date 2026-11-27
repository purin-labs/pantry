export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 68;
/** The steps of a chain leave room for two ports and a wire between them. */
export const NODE_COLUMN = 248;
/** A row leaves room for the label above each step. */
export const NODE_ROW = 108;
/** A long chain wraps, so a recipe stays on one screen and a person reads it in rows. */
const BAND_RANKS = 5;
export const BAND_GAP = 28;

type Link = Readonly<{ from: string; to: string }>;
type PlacedNode = Readonly<{
  id: string;
  rank: number;
  column: number;
}>;
type NodePlace = Readonly<{ id: string; x: number; y: number }>;

/**
 * Rank by longest path. A node stays in a prerequisite's column when it can, so a
 * chain draws straight. A node on a cycle keeps rank zero, because a draft may
 * hold a cycle.
 */
export function layoutGraph(
  nodes: readonly string[],
  links: readonly Link[],
): readonly PlacedNode[] {
  const known = new Set(nodes);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const link of links) {
    if (!known.has(link.from) || !known.has(link.to)) continue;
    incoming.set(link.to, [...(incoming.get(link.to) ?? []), link.from]);
    outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), link.to]);
    pending.set(link.to, (pending.get(link.to) ?? 0) + 1);
  }
  const ranks = new Map<string, number>();
  const ready: string[] = [];
  for (const node of nodes)
    if ((pending.get(node) ?? 0) === 0) {
      ranks.set(node, 0);
      ready.push(node);
    }
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    if (id === undefined) continue;
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(id) ?? 0) + 1));
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  const ordered = [...nodes].sort(
    (left, right) => (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0),
  );
  const columns = new Map<string, number>();
  const taken = new Set<string>();
  const placed: PlacedNode[] = [];
  for (const id of ordered) {
    const rank = ranks.get(id) ?? 0;
    let column: number | null = null;
    for (const from of incoming.get(id) ?? []) {
      const candidate = columns.get(from);
      if (candidate !== undefined && !taken.has(`${rank} ${candidate}`)) {
        column = candidate;
        break;
      }
    }
    if (column === null) {
      column = 0;
      while (taken.has(`${rank} ${column}`)) column++;
    }
    taken.add(`${rank} ${column}`);
    columns.set(id, column);
    placed.push({ id, rank, column });
  }
  return placed;
}

/** The flow reads from left to right. Each band of ranks starts below the last one. */
export function placeGraph(
  nodes: readonly string[],
  links: readonly Link[],
): readonly NodePlace[] {
  const placed = layoutGraph(nodes, links);
  const lowest = new Map<number, number>();
  const highest = new Map<number, number>();
  let lastBand = 0;
  for (const node of placed) {
    const band = Math.floor(node.rank / BAND_RANKS);
    lowest.set(band, Math.min(lowest.get(band) ?? node.column, node.column));
    highest.set(band, Math.max(highest.get(band) ?? node.column, node.column));
    lastBand = Math.max(lastBand, band);
  }
  const tops = new Map<number, number>();
  let top = 0;
  for (let band = 0; band <= lastBand; band++) {
    tops.set(band, top);
    const rows = (highest.get(band) ?? 0) - (lowest.get(band) ?? 0) + 1;
    top += rows * NODE_ROW + BAND_GAP;
  }
  const places: NodePlace[] = [];
  for (const node of placed) {
    const band = Math.floor(node.rank / BAND_RANKS);
    places.push({
      id: node.id,
      x: (node.rank % BAND_RANKS) * NODE_COLUMN,
      y:
        (tops.get(band) ?? 0) +
        (node.column - (lowest.get(band) ?? 0)) * NODE_ROW,
    });
  }
  return places;
}
