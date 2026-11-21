import { DurableObject } from "cloudflare:workers";
import type { CobotRunSignal } from "@purin-labs/control-api";
import type { BakeRunRecord } from "@purin-labs/kitchen-control-api";

import type { Env } from "../env";
import { parseOrganisationId, type OrganisationId } from "../ids";
import type { BakeRunAction } from "../kitchen/bakes/commands";
import {
  pauseBakeRun,
  readBakeRunRecord,
  receiveBakeRunSignal,
  resumeBakeRun,
  settleBakeRun,
  startBakeRun,
  stopBakeRun,
  watchBakeRun,
  type BakeRunContext,
  type BakeRunError,
  type BakeRunStart,
  type RunActor,
} from "../kitchen/bakes/run";
import {
  loadBakeRun,
  runBakeRunSchemaMigrations,
} from "../kitchen/bakes/run-store";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { requireActiveOrganisationActorAtScope } from "./actor-router";
import { bakeRunDevicePorts, bakeRunNotices } from "./bake-run-ports";

/**
 * The Durable Object of one approved bake run (Plan 24 S4). A physical run
 * lives on the server, because a closed browser cannot stop a bake. The run
 * logic is Kitchen's (`kitchen/bakes/run.ts`); this class gives it its
 * storage, its alarm and its ports, and takes one call at a time, so the
 * gateway's order of signals is the run's order.
 *
 * The alarm exists only while the run runs: it watches for lost evidence and
 * ends with the run. An Organisation with no active run has no alarm here and
 * pays nothing: 0 rows, 0 alarms and 0 requests for 30 idle days.
 */
export class BakeRunActor extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runBakeRunSchemaMigrations(ctx.storage);
  }

  /** Runs one call after the calls before it. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #context(organisationIdRaw: string): Promise<BakeRunContext | null> {
    const parsed = parseOrganisationId(organisationIdRaw);
    if (!parsed.ok) return null;
    const organisationId = parsed.value as OrganisationId;
    const resolved = await OrganisationExecutionScope.resolve(
      this.env,
      organisationId,
    );
    if (!resolved.ok) return null;
    const scope = resolved.value;
    const storage = this.ctx.storage;
    return {
      sql: storage.sql,
      db: scope.database,
      organisationId,
      actorId: this.ctx.id.toString(),
      devices: bakeRunDevicePorts(this.env, scope),
      notices: bakeRunNotices(this.env, scope),
      endProposal: async (reason) => {
        const run = loadBakeRun(storage.sql);
        if (run === null) return;
        const organisation = await requireActiveOrganisationActorAtScope({
          env: this.env,
          scope,
          now: Date.now(),
        });
        await organisation.runBakeCommand({
          organisationId,
          command: { kind: "end", proposalId: run.proposalId, reason },
        });
      },
      alarm: {
        at: (time) => storage.setAlarm(time),
        clear: () => storage.deleteAlarm(),
      },
    };
  }

  async #stored(): Promise<BakeRunContext | null> {
    const run = loadBakeRun(this.ctx.storage.sql);
    return run === null ? null : this.#context(run.organisationId);
  }

  start(
    input: Readonly<{ organisationId: string; start: BakeRunStart }>,
  ): Promise<Result<null, BakeRunError>> {
    return this.#serial(async () => {
      const ctx = await this.#context(input.organisationId);
      if (ctx === null)
        return {
          ok: false,
          error: {
            code: "bake_run_missing",
            message: "The Organisation is not active.",
          },
        };
      const started = await startBakeRun(ctx, input.start, Date.now());
      return started.ok ? { ok: true, value: null } : started;
    });
  }

  /** The device fleet Actor's signal of one of the run's devices. */
  receiveCobotSignal(signal: CobotRunSignal): Promise<void> {
    return this.#serial(async () => {
      const ctx = await this.#stored();
      if (ctx !== null) await receiveBakeRunSignal(ctx, signal, Date.now());
    });
  }

  control(
    input: Readonly<{ action: BakeRunAction; actor: RunActor }>,
  ): Promise<Result<null, BakeRunError>> {
    return this.#serial(async () => {
      const ctx = await this.#stored();
      if (ctx === null)
        return {
          ok: false,
          error: {
            code: "bake_run_missing",
            message: "This bake run has not started.",
          },
        };
      const now = Date.now();
      const { action, actor } = input;
      const done =
        action.kind === "pause"
          ? await pauseBakeRun(ctx, actor, now)
          : action.kind === "resume"
            ? await resumeBakeRun(ctx, actor, now)
            : action.kind === "settle"
              ? await settleBakeRun(ctx, action, actor, now)
              : await stopBakeRun(ctx, actor, now);
      return done.ok ? { ok: true, value: null } : done;
    });
  }

  /** The run's part of the one read of the canvas, timeline and kitchen. */
  read(): Promise<Omit<BakeRunRecord, "check" | "problem"> | null> {
    return this.#serial(async () => {
      const ctx = await this.#stored();
      return ctx === null ? null : readBakeRunRecord(ctx);
    });
  }

  /** The Organisation ended: the run holds nothing after this call. */
  erase(): Promise<void> {
    return this.#serial(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  override async alarm(): Promise<void> {
    await this.#serial(async () => {
      const ctx = await this.#stored();
      if (ctx === null) await this.ctx.storage.deleteAlarm();
      else await watchBakeRun(ctx, Date.now());
    });
  }
}

declare module "../env" {
  interface Env {
    BAKE_RUN?: DurableObjectNamespace<BakeRunActor>;
  }
}
