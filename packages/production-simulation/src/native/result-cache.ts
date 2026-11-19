import { isRecord, parseJson, sha256Hex } from "@purin-labs/std";
import type { CellTransport } from "./cell-adapter.ts";
import type { TextCellTransport } from "./wasm-transport.ts";

/**
 * Reuse of physics results (Refactor 16, step 4).
 *
 * The controller is deterministic: a robot cell that receives the same
 * commands from the same opening gives the same replies, byte for byte. So
 * the key of a reply is a chain over the cell's history: the engine
 * namespace, the opening command (its definition pins the engine identity,
 * the model and the cell), and every command that changed the cell since,
 * each with its exact step allowance. Logical time, the run and the attempt
 * identities need no separate place in the key: they are in the commands or
 * fixed by them. A key never leaves out a command, so a hit is possible only
 * where a fresh run would send the same command after the same history.
 *
 * A hit returns the stored reply and does not step the live cell. The live
 * cell stays behind until the first command that misses or that the cache
 * does not serve. Then it is restored from the stored export of the state
 * the hits reached, and the controller checks that the restored checkpoint
 * has the same digest. A command whose end state cannot be restored (a start:
 * its first segment names the state before the plan) is sent again to the
 * live cell, and its reply must be the stored reply. Any difference ends the
 * run with a fault: a wrong hit is never delivered as a result.
 *
 * Only the robot cells (rack, oven rack, pan staging) use the cache. Espresso
 * and pour-over cells answer in their own namespaces and keep their
 * predecessor outside the checkpoint, so their commands always go to the
 * controller.
 */

/** One stored physics result. */
export type PhysicsResult = Readonly<{
  /** The controller's reply text, exactly as it came. */
  reply: string;
  /** The `export` reply text of the state after it, or null if that state cannot be restored. */
  exported: string | null;
}>;

export type PhysicsResultStore = Readonly<{
  get(key: string): Promise<PhysicsResult | null>;
  /** Stores a result. A level may write it later; see `flush`. */
  put(key: string, result: PhysicsResult): void;
  /** Writes what `put` still holds. */
  flush(): Promise<void>;
}>;

export type ResultCacheCounts = {
  /** Cacheable commands served from the store, and computed by the controller. */
  hits: number;
  misses: number;
  /** Operations whose every advance was served, and those with at least one computed advance. */
  operationsReused: number;
  operationsComputed: number;
  /** Idle advances (rests) served and computed. */
  restsReused: number;
  restsComputed: number;
  /** Live cells restored to the state the hits reached, and commands sent again. */
  restores: number;
  /** Restores to a state inside an operation. */
  restoresInOperation: number;
  replays: number;
};

/** One operation that ended, by its controller attempt identity. */
export type CachedOperation = Readonly<{ attempt: string; computed: boolean }>;

export type CachedTransport = CellTransport &
  Readonly<{
    counts(): ResultCacheCounts;
    /** The operations that ended since the last reset, in order. */
    operations(): readonly CachedOperation[];
    reset(): void;
  }>;

type Tracked = {
  token: string;
  /** The export of the state the hits reached; null when the live cell holds that state. */
  base: string | null;
  /** Hits after `base` that the live cell has not performed. */
  replay: { command: string; reply: string }[];
  /** The operation in progress: was any of its advances computed? */
  operation: { attempt: string; computed: boolean } | null;
};

const CACHEABLE = new Set(["start", "recover", "advance"]);
const CHANGES = new Set(["prepare", "commit", "discard"]);

function emptyCounts(): ResultCacheCounts {
  return {
    hits: 0,
    misses: 0,
    operationsReused: 0,
    operationsComputed: 0,
    restsReused: 0,
    restsComputed: 0,
    restores: 0,
    restoresInOperation: 0,
    replays: 0,
  };
}

function chain(token: string, command: string): Promise<string> {
  return sha256Hex(`${token}\n${command}`);
}

function digestOf(reply: unknown): string | null {
  return isRecord(reply) &&
    isRecord(reply.checkpoint) &&
    typeof reply.checkpoint.digest === "string"
    ? reply.checkpoint.digest
    : null;
}

/**
 * The cell transport over `inner`, with the results of robot cells kept in
 * `store`. `namespace` names the engine build; give each build its own.
 */
export function cachedTransport(
  inner: TextCellTransport,
  store: PhysicsResultStore,
  namespace: string,
): CachedTransport {
  const cells = new Map<string, Tracked>();
  let counts = emptyCounts();
  let operations: CachedOperation[] = [];

  async function live(cell: string, command: string): Promise<string> {
    try {
      return await inner.exchange(command);
    } catch (error) {
      // The cell's state is unknown after a fault: stop tracking it.
      cells.delete(cell);
      throw error;
    }
  }

  async function materialize(cell: string, tracked: Tracked): Promise<void> {
    if (tracked.base === null && tracked.replay.length === 0) return;
    if (tracked.base !== null) {
      const exported = parseJson(tracked.base);
      const digest = digestOf(exported);
      if (
        !isRecord(exported) ||
        typeof exported.content !== "string" ||
        typeof exported.sequence !== "number" ||
        digest === null
      )
        throw new Error("A stored physics result has no state to restore");
      const disposed = parseJson(
        await live(cell, JSON.stringify({ op: "dispose", cell })),
      );
      if (!isRecord(disposed) || disposed.kind !== "disposed")
        throw new Error("The cell did not close before its restore");
      const opened = parseJson(
        await live(
          cell,
          JSON.stringify({
            op: "open",
            cell,
            opening: {
              kind: "restore",
              content: exported.content,
              digest,
              sequence: exported.sequence,
            },
          }),
        ),
      );
      if (
        !isRecord(opened) ||
        opened.kind !== "opened" ||
        digestOf(opened) !== digest
      )
        throw new Error("A stored physics result did not restore");
      counts.restores += 1;
      if (exported.sequence > 0) counts.restoresInOperation += 1;
    }
    for (const { command, reply } of tracked.replay) {
      if ((await live(cell, command)) !== reply)
        throw new Error("The controller's reply differs from the stored one");
      counts.replays += 1;
    }
    tracked.base = null;
    tracked.replay = [];
  }

  function account(
    tracked: Tracked,
    command: Readonly<Record<string, unknown>>,
    reply: unknown,
    computed: boolean,
  ): void {
    if (command.op === "start" || command.op === "recover") {
      tracked.operation =
        isRecord(reply) && reply.kind === "started"
          ? { attempt: String(command.attemptId), computed }
          : null;
      return;
    }
    if (!isRecord(reply) || reply.kind !== "advanced") return;
    if (reply.stop === "idle") {
      if (computed) counts.restsComputed += 1;
      else counts.restsReused += 1;
      return;
    }
    if (tracked.operation === null) return;
    tracked.operation.computed ||= computed;
    if (reply.stop === "terminal") {
      if (tracked.operation.computed) counts.operationsComputed += 1;
      else counts.operationsReused += 1;
      operations.push({ ...tracked.operation });
      tracked.operation = null;
    }
  }

  async function cacheable(
    cell: string,
    request: Readonly<Record<string, unknown>>,
    command: string,
    tracked: Tracked,
  ): Promise<unknown> {
    const op = request.op;
    const key = await chain(tracked.token, command);
    let found: PhysicsResult | null = null;
    try {
      found = await store.get(key);
    } catch {
      // A store that cannot be read is a miss.
    }
    if (found !== null) {
      let reply: unknown = null;
      try {
        reply = parseJson(found.reply);
      } catch {
        // A stored reply that does not parse is a miss.
      }
      if (isRecord(reply)) {
        tracked.token = key;
        if (found.exported !== null) {
          tracked.base = found.exported;
          tracked.replay = [];
        } else tracked.replay.push({ command, reply: found.reply });
        counts.hits += 1;
        account(tracked, request, reply, false);
        return reply;
      }
    }
    await materialize(cell, tracked);
    const text = await live(cell, command);
    tracked.token = key;
    const reply = parseJson(text);
    if (!isRecord(reply) || reply.kind === "failed") return reply;
    let exported: string | null = null;
    if (op === "advance") {
      const exportText = await live(
        cell,
        JSON.stringify({ op: "export", cell }),
      );
      const parsed = parseJson(exportText);
      if (
        isRecord(parsed) &&
        parsed.kind === "exported" &&
        digestOf(parsed) === digestOf(reply)
      )
        exported = exportText;
    }
    // An advance whose end state was not exported is not stored.
    if (op !== "advance" || exported !== null)
      store.put(key, { reply: text, exported });
    counts.misses += 1;
    account(tracked, request, reply, true);
    return reply;
  }

  return {
    async send(command) {
      const text = JSON.stringify(command);
      const op = command.op;
      const cell = command.cell;
      if (typeof cell !== "string" || typeof op !== "string")
        return parseJson(await inner.exchange(text));
      const tracked = cells.get(cell);
      if (op === "open") {
        cells.delete(cell);
        const reply = parseJson(await inner.exchange(text));
        if (isRecord(reply) && reply.kind === "opened")
          cells.set(cell, {
            token: await sha256Hex(`${namespace}\n${text}`),
            base: null,
            replay: [],
            operation: null,
          });
        return reply;
      }
      if (op === "dispose") {
        cells.delete(cell);
        return parseJson(await inner.exchange(text));
      }
      if (tracked === undefined) return parseJson(await inner.exchange(text));
      if (
        op === "export" &&
        tracked.replay.length === 0 &&
        tracked.base !== null
      )
        return parseJson(tracked.base);
      if (CACHEABLE.has(op)) return cacheable(cell, command, text, tracked);
      await materialize(cell, tracked);
      const reply = parseJson(await live(cell, text));
      if (CHANGES.has(op)) tracked.token = await chain(tracked.token, text);
      else if (op !== "export" && op !== "observe") cells.delete(cell);
      return reply;
    },
    counts() {
      return { ...counts };
    },
    operations() {
      return operations;
    },
    reset() {
      counts = emptyCounts();
      operations = [];
    },
  };
}

function resultBytes(key: string, result: PhysicsResult): number {
  return key.length + result.reply.length + (result.exported?.length ?? 0);
}

/**
 * The session level: results in memory, at most `limitBytes` of text. A hit
 * makes an entry the newest; the oldest entries go first.
 */
export function memoryResultStore(
  limitBytes: number,
): PhysicsResultStore & Readonly<{ bytes(): number; entries(): number }> {
  const entries = new Map<string, PhysicsResult>();
  let bytes = 0;
  return {
    async get(key) {
      const found = entries.get(key);
      if (found === undefined) return null;
      entries.delete(key);
      entries.set(key, found);
      return found;
    },
    put(key, result) {
      const size = resultBytes(key, result);
      if (entries.has(key) || size > limitBytes) return;
      entries.set(key, result);
      bytes += size;
      for (const [oldest, entry] of entries) {
        if (bytes <= limitBytes) break;
        entries.delete(oldest);
        bytes -= resultBytes(oldest, entry);
      }
    },
    async flush() {},
    bytes: () => bytes,
    entries: () => entries.size,
  };
}

/** Looks in each level in order; a hit in a later level fills the earlier ones. */
export function tieredResultStore(
  levels: readonly PhysicsResultStore[],
): PhysicsResultStore {
  return {
    async get(key) {
      for (let index = 0; index < levels.length; index++) {
        const found = await levels[index]?.get(key);
        if (found === null || found === undefined) continue;
        for (let earlier = 0; earlier < index; earlier++)
          levels[earlier]?.put(key, found);
        return found;
      }
      return null;
    },
    put(key, result) {
      for (const level of levels) level.put(key, result);
    },
    async flush() {
      for (const level of levels) await level.flush();
    },
  };
}
