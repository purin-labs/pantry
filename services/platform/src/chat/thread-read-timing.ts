import type { Env } from "../env";
import { newRequestId } from "../ids";
import { traceLog } from "../observability";

/** One database step of a thread read: start and duration in ms, and its label. */
type TimedStep = readonly [startMs: number, durationMs: number, label: string];

const MOST_STEPS = 120;

type ThreadReadTiming = Readonly<{
  /** `env` with each database timed. The read uses it in place of `env`. */
  env: Env;
  finish(status: number): void;
}>;

/**
 * Times the database steps of one Portal thread read. A gap between two steps
 * is an account call or an Actor call, which have their own Workers Logs spans.
 * A label names a statement's verb and table, and holds no bound value.
 */
export function timeThreadRead(
  request: Request,
  env: Env,
): ThreadReadTiming | null {
  if (request.method !== "GET") return null;
  const params = new URL(request.url).searchParams;
  if (params.get("conversation") === null || params.get("view") !== null)
    return null;
  const startedAt = Date.now();
  const steps: TimedStep[] = [];
  const record = (label: string, at: number): void => {
    if (steps.length < MOST_STEPS)
      steps.push([at - startedAt, Date.now() - at, label]);
  };
  const timed: { -readonly [Name in keyof Env]: Env[Name] } = { ...env };
  for (const name of DATABASE_BINDINGS) {
    const database = env[name];
    // Each binding keeps its own handle type: the proxy wraps that binding.
    if (database !== undefined)
      (timed as Record<typeof name, D1Database>)[name] = timeDatabase(
        database,
        record,
      );
  }
  return {
    env: timed,
    finish(status) {
      traceLog("chat.thread_read_timing", {
        requestId: newRequestId(),
        observe: params.get("observe") === "true",
        status,
        total_ms: Date.now() - startedAt,
        steps,
      });
    },
  };
}

type RecordStep = (label: string, at: number) => void;

/**
 * The D1 bindings of `env`, by name. A shape test cannot find them: an RPC
 * binding, such as a service or a Secrets Store secret, answers every
 * property name, and the timing proxy would then call `bind` on its methods
 * as a remote method.
 */
const DATABASE_BINDINGS = [
  "DB",
  "ORGANISATION_DB_WNAM",
  "ORGANISATION_DB_APAC",
  "ORGANISATION_DB_EU",
] as const satisfies readonly (keyof Env)[];

function timeDatabase<Database extends D1Database>(
  database: Database,
  record: RecordStep,
): Database {
  // `batch` needs the statements that the database itself made.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const labels = new WeakMap<object, string>();
  const timeStatement = (
    statement: D1PreparedStatement,
    label: string,
  ): D1PreparedStatement => {
    const timed = new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "bind")
          return (...values: unknown[]) =>
            timeStatement(target.bind(...values), label);
        return async (...args: unknown[]) => {
          const at = Date.now();
          try {
            return (await Reflect.apply(value, target, args)) as unknown;
          } finally {
            record(label, at);
          }
        };
      },
    });
    originals.set(timed, statement);
    labels.set(timed, label);
    return timed;
  };
  return new Proxy(database, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === "prepare")
        return (sql: string) =>
          timeStatement(target.prepare(sql), sqlLabel(sql));
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const at = Date.now();
          try {
            return await target.batch(
              statements.map(
                (statement) => originals.get(statement) ?? statement,
              ),
            );
          } finally {
            const first = statements[0];
            const label = first === undefined ? undefined : labels.get(first);
            record(
              `batch ${String(statements.length)}: ${label ?? "statement"}`,
              at,
            );
          }
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sqlLabel(sql: string): string {
  const verb = /^\s*(\w+)/u.exec(sql)?.[1]?.toUpperCase() ?? "SQL";
  const table = /\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_]+)/u.exec(sql)?.[1];
  return table === undefined ? verb : `${verb} ${table}`;
}
