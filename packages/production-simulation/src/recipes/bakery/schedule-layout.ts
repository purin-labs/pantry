import type { Settings, StationId } from "@seams/bakery-model/bakery";

// The bakery stations and the walks between them. A floor layout moves the
// stations and plans the walks; each run takes its layout as an input and
// keeps the resolved layout, so that no module holds a layout.

export type Point = readonly [number, number];

export type Station = {
  readonly id: StationId;
  readonly label: string;
  readonly asset: string;
  readonly position: readonly [number, number, number];
  readonly handoff: Point;
};

export const stations: readonly Station[] = [
  {
    id: "stage",
    label: "Batter staging",
    asset: "prep-table-steel",
    position: [-3.5, 0, -2],
    handoff: [-3.5, -0.8],
  },
  {
    id: "portion",
    label: "Portioning",
    asset: "prep-table-maple",
    position: [-1.5, 0, -2],
    handoff: [-1.5, -0.8],
  },
  {
    id: "bake",
    label: "Baking",
    asset: "maruzen-mbco-5e",
    position: [0.7, 0.902, -2],
    handoff: [0.7, -0.8],
  },
  {
    id: "cool",
    label: "Cooling",
    asset: "cooling-rack-16",
    position: [3, 0, -2],
    handoff: [3, -0.8],
  },
  {
    id: "pack",
    label: "Packing",
    asset: "prep-table-steel",
    position: [3, 0, 1.5],
    handoff: [3, 2.4],
  },
];

/** A floor layout as the Portal authors it: station points and a walk planner. */
export type ScheduleSpatialLayout = Readonly<{
  handoffs: Readonly<Record<StationId, Point>>;
  positions?: Readonly<Record<StationId, readonly [number, number, number]>>;
  workerStarts?: readonly Point[];
  routeBetween?: (from: Point, to: Point) => readonly Point[];
}>;

/**
 * The layout that one run used, as plain data: each station at its layout
 * point, the start of each baker, and the walk from each start or handoff to
 * each handoff. A run input and its run carry it. A run on the built-in layout
 * carries none, so its data and its digests do not change.
 */
export type ResolvedScheduleLayout = Readonly<{
  stations: readonly Station[];
  workerStarts: readonly Point[];
  routes: Readonly<Record<string, readonly Point[]>>;
}>;

/** Resolve a layout for a run of `workerCount` bakers; null is the built-in layout. */
export function resolveScheduleLayout(
  layout: ScheduleSpatialLayout | null,
  workerCount: number,
): ResolvedScheduleLayout | undefined {
  // Untyped journey scripts omit the layout; that also means the built-in one.
  if (!layout) return undefined;
  const placed = stations.map(placedStation.bind(null, layout));
  const workerStarts: Point[] = [];
  for (let id = 0; id < workerCount; id++)
    workerStarts.push(layout.workerStarts?.[id] ?? builtInWorkerStart(id));
  const routes: Record<string, readonly Point[]> = {};
  // A baker stands at a start or at a handoff, and walks to a handoff.
  const origins = [...workerStarts, ...placed.map(stationHandoff)];
  for (const from of origins)
    for (const item of placed) {
      const key = routeKey(from, item.handoff);
      if (routes[key] !== undefined) continue;
      const custom = layout.routeBetween?.(from, item.handoff);
      routes[key] =
        custom !== undefined && custom.length >= 2
          ? custom
          : builtInRoute(from, item.handoff);
    }
  return { stations: placed, workerStarts, routes };
}

function placedStation(layout: ScheduleSpatialLayout, item: Station): Station {
  const handoff = layout.handoffs[item.id] ?? item.handoff;
  const position = layout.positions?.[item.id] ?? item.position;
  return handoff === item.handoff && position === item.position
    ? item
    : { ...item, position, handoff };
}

function stationHandoff(item: Station): Point {
  return item.handoff;
}

function builtInWorkerStart(id: number): Point {
  return [-4 + id * 0.4, 0.6];
}

/** Where baker `id` starts in `layout`; undefined is the built-in layout. */
export function workerStart(
  id: number,
  layout: ResolvedScheduleLayout | undefined,
): Point {
  return layout?.workerStarts[id] ?? builtInWorkerStart(id);
}

function routeKey(from: Point, to: Point): string {
  return `${from[0]},${from[1]}>${to[0]},${to[1]}`;
}

function builtInRoute(from: Point, to: Point): readonly Point[] {
  return from[0] === to[0]
    ? [from, to]
    : [from, [from[0], 0.6], [to[0], 0.6], to];
}

/** The station at its point in `layout`; undefined is the built-in layout. */
export function station(
  id: StationId,
  layout: ResolvedScheduleLayout | undefined,
): Station {
  const result = (layout?.stations ?? stations).find(
    matchesStation.bind(null, id),
  );
  if (!result) {
    throw new Error(`Unknown station ${id}`);
  }
  return result;
}

/** A station label does not depend on the layout. */
export function stationLabel(id: StationId): string {
  return station(id, undefined).label;
}

function matchesStation(id: StationId, value: Station): boolean {
  return value.id === id;
}

export function route(
  from: Point,
  to: Point,
  layout: ResolvedScheduleLayout | undefined,
): readonly Point[] {
  if (layout === undefined) return builtInRoute(from, to);
  const known = layout.routes[routeKey(from, to)];
  if (known === undefined)
    throw new Error(
      `The layout has no walk from ${from.join(",")} to ${to.join(",")}`,
    );
  return known;
}

export function distance(points: readonly Point[]): number {
  let total = 0;
  let previous: Point | null = null;
  for (const point of points) {
    if (previous !== null)
      total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return total;
}

/** Shared recipe timing for scheduling, persistent compilation and route display. */
export function travelSeconds(
  from: Point,
  to: Point,
  layout: ResolvedScheduleLayout | undefined,
): number {
  return Math.ceil(distance(route(from, to, layout)) / 0.8);
}

export function transferTiming(
  settings: Settings,
  from: StationId,
  to: StationId,
  layout: ResolvedScheduleLayout | undefined,
): Readonly<{
  pickupAfter: number;
  loadedEndAfter: number;
  duration: number;
}> {
  const pickupAfter = from === "bake" ? settings.unloadSeconds : 15;
  const loadedEndAfter =
    pickupAfter +
    travelSeconds(
      station(from, layout).handoff,
      station(to, layout).handoff,
      layout,
    );
  return {
    pickupAfter,
    loadedEndAfter,
    duration: loadedEndAfter + (to === "bake" ? settings.loadSeconds : 15),
  };
}

export function along(points: readonly Point[], fraction: number): Point {
  let remaining = distance(points) * Math.max(0, Math.min(1, fraction));
  let previous = points[0];
  if (previous === undefined)
    throw new Error("A playback route requires a point");
  for (const b of points.slice(1)) {
    const a = previous;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 0 && remaining <= length) {
      return [
        a[0] + ((b[0] - a[0]) * remaining) / length,
        a[1] + ((b[1] - a[1]) * remaining) / length,
      ];
    }
    remaining -= length;
    previous = b;
  }
  return previous;
}
