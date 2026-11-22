// Counts what a run writes, because Cloudflare bills each write: the rows of
// every Durable Object of the test Worker, the rows of one Commerce merchant
// object, and the D1 rows, queue messages, KV writes and R2 writes that code
// sends through `WriteMeter.env`. A Durable Object's own D1, queue, KV and R2
// writes are not counted; its rows are.
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  evictAllDurableObjects,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { isRecord } from "@purin-labs/std";

import type { Env } from "@purin-labs/kernel/env";
import gateway from "../../src/integration-gateway";

/** Writes by meter line, for example `rows ORGANISATION`. Zero lines are left out. */
export type WriteCounts = Readonly<Record<string, number>>;

type Unit = "rows" | "messages" | "kv writes" | "r2 writes";

/** Cloudflare list prices in USD for one million units, read 2026-11-15. */
const USD_PER_MILLION: Readonly<Record<Unit, number>> = {
  rows: 1.0,
  // A message is one write, one read and one delete at $0.40 each.
  messages: 1.2,
  "kv writes": 5.0,
  "r2 writes": 4.5,
};

const ROW_CHANGES = "SELECT total_changes() AS changes";
const STARTED = Symbol("write meter saw this start");
const COMMERCE_OPERATOR = "Bearer commerce-e2e-token";

type ActorNamespace = DurableObjectNamespace<undefined>;
type ActorReading = Readonly<{ changes: number; sameStart: boolean }>;
type Reading = Readonly<{
  actors: ReadonlyMap<string, ActorReading>;
  commerce: Readonly<{ instance: string; changes: number }> | null;
  sends: Readonly<Record<string, number>>;
}>;

export class WriteMeter {
  /** The Worker's bindings; its D1 databases, queues, KV and R2 count each write. */
  readonly env: Env;
  readonly #sends: Record<string, number> = {};
  readonly #statements = new Map<string, number>();
  readonly #merchantId: string | null;

  constructor(options: Readonly<{ commerceMerchantId?: string }> = {}) {
    this.#merchantId = options.commerceMerchantId ?? null;
    const metered: Record<string, unknown> = { ...env };
    for (const [name, binding] of Object.entries(env)) {
      const unit = sendUnit(binding);
      if (unit !== null)
        metered[name] = this.#counting(binding as object, `${unit} ${name}`);
      if (isDatabase(binding))
        metered[name] = countingDatabase(binding, (rows, query) => {
          this.#count(`rows ${name}`, rows);
          if (rows === 0) return;
          const statement = `${name}: ${query.replace(/\s+/gu, " ").trim().slice(0, 160)}`;
          this.#statements.set(
            statement,
            (this.#statements.get(statement) ?? 0) + rows,
          );
        });
    }
    this.env = metered as unknown as Env;
  }

  /** What `run` wrote. */
  async during(run: () => Promise<void>): Promise<WriteCounts> {
    const before = await this.#read();
    await run();
    return written(before, await this.#read());
  }

  /**
   * What each object writes when it starts again. Cloudflare stops an idle
   * object after about ten seconds, so a shop pays this at each later call.
   */
  async onStart(): Promise<WriteCounts> {
    const before = await this.#read();
    await this.stopObjects();
    const after = await this.#read();
    for (const [name, reading] of after.actors)
      if (reading.sameStart) throw new Error(`${name} did not stop`);
    if (
      after.commerce?.instance === before.commerce?.instance &&
      after.commerce
    )
      throw new Error("The Commerce merchant object did not stop");
    return written(before, after);
  }

  /** The D1 statements that wrote rows since the last call, most rows first. */
  takeStatements(): readonly string[] {
    const statements = [...this.#statements]
      .sort((a, b) => b[1] - a[1])
      .map(([statement, rows]) => `${rows} rows: ${statement}`);
    this.#statements.clear();
    return statements;
  }

  /** Stops every running object, as an idle period does. Storage stays. */
  async stopObjects(): Promise<void> {
    await evictAllDurableObjects();
    if (this.#merchantId === null) return;
    await commerceFixture(this.#merchantId, { kind: "stop_object" });
    // The object stops after its answer has left.
    await scheduler.wait(20);
  }

  /** The objects that hold an alarm, with its time. */
  async armedAlarms(): Promise<Readonly<Record<string, number>>> {
    const alarms: Record<string, number> = {};
    for (const [name, stub] of await actors()) {
      const alarm = await runInDurableObject(stub, readAlarm);
      if (alarm !== null) alarms[name] = alarm;
    }
    return alarms;
  }

  /** Runs every armed alarm now; answers the objects whose alarm ran. */
  async runAlarms(): Promise<readonly string[]> {
    const ran: string[] = [];
    for (const [name, stub] of await actors())
      if (await runDurableObjectAlarm(stub)) ran.push(name);
    return ran;
  }

  async #read(): Promise<Reading> {
    const actorReadings = new Map<string, ActorReading>();
    for (const [name, stub] of await actors())
      actorReadings.set(name, await runInDurableObject(stub, readActor));
    return {
      actors: actorReadings,
      commerce:
        this.#merchantId === null
          ? null
          : await commerceFixture(this.#merchantId, {
              kind: "storage_row_changes",
            }),
      sends: { ...this.#sends },
    };
  }

  #count(line: string, amount: number): void {
    this.#sends[line] = (this.#sends[line] ?? 0) + amount;
  }

  #counting<T extends object>(binding: T, line: string): T {
    const count = (amount: number): void => this.#count(line, amount);
    return new Proxy(binding, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          if (key === "sendBatch")
            count(Array.isArray(args[0]) ? args[0].length : 1);
          else if (key === "send" || key === "put" || key === "delete")
            count(1);
          return Reflect.apply(value, target, args);
        };
      },
    });
  }
}

/** One idle shop's cost for 30 days in USD, from what it wrote in one hour. */
export function monthlyCostUsd(hour: WriteCounts): number {
  let usd = 0;
  for (const [line, amount] of Object.entries(hour)) {
    const unit = (Object.keys(USD_PER_MILLION) as Unit[]).find((candidate) =>
      line.startsWith(`${candidate} `),
    );
    if (unit === undefined) throw new Error(`No price for ${line}`);
    usd += (amount * 24 * 30 * USD_PER_MILLION[unit]) / 1_000_000;
  }
  return Number(usd.toFixed(4));
}

export function addWrites(total: WriteCounts, more: WriteCounts): WriteCounts {
  const sum: Record<string, number> = { ...total };
  for (const [line, amount] of Object.entries(more))
    sum[line] = (sum[line] ?? 0) + amount;
  return sum;
}

/**
 * Runs the Worker's scheduled entry for each cron trigger that is due, minute
 * by minute, as Cloudflare does.
 */
export async function runCronMinutes(
  input: Readonly<{
    env: Env;
    crons: readonly string[];
    from: number;
    minutes: number;
  }>,
): Promise<void> {
  for (let minute = 0; minute < input.minutes; minute += 1) {
    const scheduledTime = input.from + minute * 60_000;
    for (const cron of input.crons) {
      if (!cronDue(cron, new Date(scheduledTime).getUTCMinutes())) continue;
      const context = createExecutionContext();
      gateway.scheduled(
        createScheduledController({ cron, scheduledTime }),
        input.env,
        context,
      );
      await waitOnExecutionContext(context);
    }
  }
}

// A minute field of `*` or of a step, with `*` in each other field; the
// production Worker has no other kind of trigger.
function cronDue(cron: string, minute: number): boolean {
  const [minutes, ...rest] = cron.trim().split(/\s+/u);
  const step = /^\*(?:\/(\d+))?$/u.exec(minutes ?? "");
  if (step === null || rest.length !== 4 || rest.some((field) => field !== "*"))
    throw new Error(`Teach runCronMinutes the cron trigger ${cron}`);
  return minute % Number(step[1] ?? 1) === 0;
}

function written(before: Reading, after: Reading): WriteCounts {
  const counts: Record<string, number> = {};
  const add = (line: string, amount: number): void => {
    if (amount > 0) counts[line] = (counts[line] ?? 0) + amount;
  };
  for (const [name, reading] of after.actors) {
    // A counter starts at zero with each start of its object.
    const earlier = reading.sameStart
      ? (before.actors.get(name)?.changes ?? 0)
      : 0;
    add(`rows ${name.slice(0, name.indexOf("/"))}`, reading.changes - earlier);
  }
  if (after.commerce !== null) {
    const sameStart = after.commerce.instance === before.commerce?.instance;
    add(
      "rows Commerce merchant",
      after.commerce.changes -
        (sameStart ? (before.commerce?.changes ?? 0) : 0),
    );
  }
  for (const [line, amount] of Object.entries(after.sends))
    add(line, amount - (before.sends[line] ?? 0));
  return counts;
}

/** The real statement behind each counting one, with its SQL; `batch` takes real ones. */
const REAL_STATEMENTS = new WeakMap<
  object,
  Readonly<{ real: D1PreparedStatement; query: string }>
>();

/**
 * A D1 binding that reports `meta.rows_written` of each statement: the
 * number that Cloudflare bills. `first` reads through `all`, which carries
 * that number; `raw` and `exec` carry none and count nothing.
 */
function countingDatabase<T extends D1Database | D1DatabaseSession>(
  database: T,
  count: (rows: number, query: string) => void,
): T {
  const counted = <R>(result: R, query: string): R => {
    const meta = isRecord(result) && isRecord(result.meta) ? result.meta : {};
    const rows = meta.rows_written ?? meta.changes;
    if (typeof rows === "number") count(rows, query);
    return result;
  };
  const statement = (
    real: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const counting = new Proxy(real, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), query);
        if (key === "run" || key === "all")
          return async () => counted(await target.all(), query);
        if (key === "first")
          return async (column?: string) => {
            const row = counted(await target.all(), query).results[0] ?? null;
            if (column === undefined || row === null) return row;
            return (row as Record<string, unknown>)[column] ?? null;
          };
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      },
    });
    REAL_STATEMENTS.set(counting, { real, query });
    return counting;
  };
  return new Proxy(database, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "prepare")
        return (query: string) => statement(target.prepare(query), query);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) =>
          (
            await target.batch(
              statements.map((item) => REAL_STATEMENTS.get(item)?.real ?? item),
            )
          ).map((result, index) =>
            counted(
              result,
              REAL_STATEMENTS.get(statements[index] ?? {})?.query ?? "batch",
            ),
          );
      if (key === "withSession" && "withSession" in target)
        return (...args: Parameters<D1Database["withSession"]>) =>
          countingDatabase(target.withSession(...args), count);
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, target, args);
    },
  });
}

/** Every Durable Object of the test Worker, as `BINDING/object id`. */
async function actors(): Promise<Map<string, DurableObjectStub<undefined>>> {
  const stubs = new Map<string, DurableObjectStub<undefined>>();
  for (const [name, binding] of Object.entries(env)) {
    if (!isActorNamespace(binding)) continue;
    let ids: DurableObjectId[];
    try {
      ids = await listDurableObjectIds(binding);
    } catch {
      // Another Worker's class; this runtime cannot open its objects.
      continue;
    }
    for (const id of ids)
      stubs.set(`${name}/${id.toString()}`, binding.get(id));
  }
  return stubs;
}

function readActor(instance: unknown, state: DurableObjectState): ActorReading {
  const marked = instance as { [STARTED]?: true };
  const sameStart = marked[STARTED] === true;
  marked[STARTED] = true;
  const row = state.storage.sql.exec<{ changes: number }>(ROW_CHANGES).one();
  return { changes: row.changes, sameStart };
}

function readAlarm(
  _instance: unknown,
  state: DurableObjectState,
): Promise<number | null> {
  return state.storage.getAlarm();
}

async function commerceFixture(
  merchantId: string,
  body: Readonly<{ kind: string }>,
): Promise<{ instance: string; changes: number }> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: COMMERCE_OPERATOR,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const answer: unknown = await response.json();
  if (!response.ok || !isRecord(answer))
    throw new Error(
      `Commerce fixture ${body.kind}: ${JSON.stringify(answer)}`,
    );
  return {
    instance: typeof answer.instance === "string" ? answer.instance : "",
    changes: typeof answer.changes === "number" ? answer.changes : 0,
  };
}

/** The runtime's class of a binding. A service binding answers every method name, so its methods say nothing. */
function bindingClass(binding: unknown): string {
  return typeof binding === "object" && binding !== null
    ? binding.constructor.name
    : "";
}

function sendUnit(binding: unknown): Unit | null {
  switch (bindingClass(binding)) {
    case "WorkerQueue":
      return "messages";
    case "KvNamespace":
      return "kv writes";
    case "R2Bucket":
      return "r2 writes";
    default:
      return null;
  }
}

function isDatabase(binding: unknown): binding is D1Database {
  return bindingClass(binding) === "D1Database";
}

function isActorNamespace(binding: unknown): binding is ActorNamespace {
  return bindingClass(binding) === "DurableObjectNamespace";
}
