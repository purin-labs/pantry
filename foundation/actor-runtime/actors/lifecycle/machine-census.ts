import type { MachineDefinition } from "@purin-labs/std/state-machine";

/** The age of the rows in one state of one machine. Times, never content. */
export type MachineStateAge = Readonly<{
  /** The earliest `since` time of the rows in the state, or null. */
  oldestSince: number | null;
  /** The rows for which the store keeps no time. */
  untimed: number;
  /** The rows that are older than the due exit of their state. */
  pastExit: number;
  /**
   * The rows past their exit in an Actor that has no alarm: no reconciler
   * wakes for them.
   */
  pastExitNoAlarm: number;
}>;

/**
 * The count of rows in each state that is not terminal, for one machine,
 * and the age of the rows in each state that holds one, when the store
 * names its `since` time.
 */
export type MachineCensus = Readonly<{
  machine: string;
  states: Readonly<Record<string, number>>;
  ages?: Readonly<Record<string, MachineStateAge>>;
}>;

/** The Actor's alarm and the time of the census. */
type CensusClock = Readonly<{ alarm: number | null; now: number }>;

/**
 * The census of an Actor's machines, read with its alarm and the time. The
 * Worker gives the list of the machines whose state lives in an Actor's
 * SQLite (`actors/actor-machines.ts`).
 */
export async function actorMachineCensus(
  storage: DurableObjectStorage,
  machines: readonly MachineDefinition[],
): Promise<readonly MachineCensus[]> {
  const alarm = await storage.getAlarm();
  return censusOfActorMachines(
    storage.sql,
    { alarm, now: Date.now() },
    machines,
  );
}

/**
 * Counts the rows of each machine whose table this Actor holds, in each
 * state that is not terminal, with the age of those rows. It reads counts
 * and times only, never content.
 */
export function censusOfActorMachines(
  sql: SqlStorage,
  clock: CensusClock,
  machines: readonly MachineDefinition[],
): readonly MachineCensus[] {
  const tables = new Set(
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .toArray()
      .map((row) => row.name),
  );
  const census: MachineCensus[] = [];
  for (const machine of machines) {
    const store = machine.store;
    if (store === undefined || !tables.has(store.table)) continue;
    const open = Object.entries(machine.states)
      .filter(
        ([, state]) => state.kind !== "terminal" && state.kind !== "external",
      )
      .map(([name]) => name);
    const stateOf =
      store.path === undefined
        ? store.column
        : `json_extract(${store.column}, '${store.path}')`;
    const counts = new Map(
      sql
        .exec<{ state: string; count: number }>(
          `SELECT ${stateOf} AS state, COUNT(*) AS count
           FROM ${store.table} GROUP BY ${stateOf}`,
        )
        .toArray()
        .map((row) => [row.state, row.count]),
    );
    const held = open.filter((state) => (counts.get(state) ?? 0) > 0);
    const ages =
      store.since === undefined || held.length === 0
        ? undefined
        : stateAges(
            sql,
            machine,
            { table: store.table, stateOf, since: store.since },
            held,
            { counts, clock },
          );
    census.push({
      machine: machine.name,
      states: Object.fromEntries(
        open.map((state) => [state, counts.get(state) ?? 0]),
      ),
      ...(ages === undefined ? {} : { ages }),
    });
  }
  return census;
}

/**
 * The age of the rows in each named state. When the `since` expression
 * cannot run on this Actor's table, every row reads as untimed, so the
 * census still counts it.
 */
function stateAges(
  sql: SqlStorage,
  machine: MachineDefinition,
  store: Readonly<{ table: string; stateOf: string; since: string }>,
  states: readonly string[],
  context: Readonly<{
    counts: ReadonlyMap<string, number>;
    clock: CensusClock;
  }>,
): Record<string, MachineStateAge> {
  let rows: readonly { state: string; since: SqlStorageValue }[] | null;
  try {
    rows = sql
      .exec<{ state: string; since: SqlStorageValue }>(
        `SELECT ${store.stateOf} AS state, ${store.since} AS since
         FROM ${store.table}
         WHERE ${store.stateOf} IN (${states.map(() => "?").join(", ")})`,
        ...states,
      )
      .toArray();
  } catch {
    rows = null;
  }
  const { counts, clock } = context;
  return Object.fromEntries(
    states.map((state): [string, MachineStateAge] => {
      if (rows === null)
        return [
          state,
          {
            oldestSince: null,
            untimed: counts.get(state) ?? 0,
            pastExit: 0,
            pastExitNoAlarm: 0,
          },
        ];
      const exit = machine.states[state]?.exit;
      const times = rows
        .filter((row) => row.state === state)
        .map((row) =>
          typeof row.since === "number" && Number.isFinite(row.since)
            ? row.since
            : null,
        );
      const timed = times.filter((since) => since !== null);
      const pastExit =
        exit?.kind === "due"
          ? timed.filter((since) => clock.now - since > exit.afterMs).length
          : 0;
      return [
        state,
        {
          oldestSince: timed.length === 0 ? null : Math.min(...timed),
          untimed: times.length - timed.length,
          pastExit,
          pastExitNoAlarm: clock.alarm === null ? pastExit : 0,
        },
      ];
    }),
  );
}
