import { DurableObject } from "cloudflare:workers";
import { errorMessage } from "@seams/std";

import type { Env } from "../../env";
import { startIsolateLocationRead } from "../../isolate-location";
import type { Result } from "../../result";
import {
  activateActor,
  admitActorActivation,
  createActorActivationSchema,
} from "../actor-activation";
import { createActorExecutionBarrierSchema } from "../actor-execution-quiescence";
import {
  createActorImportSchema,
  exportActorPlacement,
  importActorPlacement,
  type ActorExportError,
  type ActorExportRef,
  type ActorExportRequest,
  type ActorImportedState,
  type ActorImportRequest,
  type ActorImportSqlMigration,
} from "../actor-export";
import type {
  ActorActivationRequest,
  ActorActivationResult,
  ActorFenceToken,
} from "../actor-registry";
import {
  eraseInactiveActorState,
  inspectActorRelocationReadiness,
  type ActorRelocationReadiness,
  type InactiveActorErasureRequest,
} from "../actor-relocation-state";
import { eraseUnregisteredActorState } from "../unregistered-actor-erasure";

interface PlacedActorOptions {
  /**
   * Whether the actor keeps an execution barrier: the export closes its
   * execution admission before the state is copied.
   */
  readonly executionBarrier: boolean;
}

/** What an export copies beside the actor's SQL state. */
export interface PlacedActorExportSource {
  readonly referencedR2Keys: readonly string[];
}

const NO_ARCHIVE_KEYS: Result<readonly string[], ActorExportError> = {
  ok: true,
  value: [],
};

/**
 * The placement lifecycle that every placed actor shares (Refactor 10, step
 * 2): activation, relocation readiness, export, import and erasure. The RPC
 * names are the same as before; workerd serves an RPC method that a class
 * inherits (scripts/refactor-10/step-2-rpc-spike).
 *
 * An actor gives only its state hooks. The export envelope and its version
 * belong to actor-export.ts and do not change here.
 */
export abstract class PlacedActor<
  Quiesced = unknown,
> extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env, options: PlacedActorOptions) {
    super(ctx, env);
    startIsolateLocationRead(env, ctx);
    createActorActivationSchema(ctx.storage.sql);
    createActorImportSchema(ctx.storage.sql);
    if (options.executionBarrier)
      createActorExecutionBarrierSchema(ctx.storage.sql);
  }

  /** Whether this actor accepts the activation's identity and schema. */
  protected abstract acceptsActivation(input: ActorActivationRequest): boolean;

  /**
   * Stops the actor's own work for an export. The export copies the state
   * only after every admitted call has settled.
   */
  protected abstract quiesceForExport(
    expectedFenceToken: ActorFenceToken,
  ): Promise<Result<Quiesced, ActorExportError>>;

  /**
   * The archive objects that the actor's state names. Relocation readiness
   * checks that each one exists.
   */
  protected async referencedArchiveKeys(): Promise<
    Result<Iterable<string>, ActorExportError>
  > {
    return NO_ARCHIVE_KEYS;
  }

  /** Prepares the state after the quiesce and names what the export copies. */
  protected async prepareExport(
    _quiesced: Quiesced,
  ): Promise<Result<PlacedActorExportSource, ActorExportError>> {
    const keys = await this.referencedArchiveKeys();
    if (!keys.ok) return keys;
    return { ok: true, value: { referencedR2Keys: [...keys.value] } };
  }

  /** The SQL migration that an import of an older export applies. */
  protected importSqlMigration(): ActorImportSqlMigration | undefined {
    return undefined;
  }

  /**
   * Runs before the actor's storage is emptied, and returns the work that runs
   * after a successful erasure (for state that the actor holds elsewhere).
   */
  protected async prepareErasure(): Promise<() => Promise<void>> {
    return async () => {};
  }

  async activate(
    input: ActorActivationRequest,
  ): Promise<ActorActivationResult> {
    if (!(await admitActorActivation(this.env, input)))
      return { ok: false, error: { code: "activation_placement_conflict" } };
    if (!this.acceptsActivation(input))
      return { ok: false, error: { code: "activation_conflict" } };
    return this.ctx.storage.transactionSync(
      activateActor.bind(null, this.ctx.storage.sql, input),
    );
  }

  async inspectRelocationReadiness(request: {
    readonly expectedFenceToken: ActorFenceToken;
    readonly stage: "preflight" | "quiescent";
  }): Promise<Result<ActorRelocationReadiness, ActorExportError>> {
    const ready = inspectActorRelocationReadiness(this.ctx.storage, request);
    if (!ready.ok || ready.value.kind === "blocked") return ready;
    try {
      const keys = await this.referencedArchiveKeys();
      if (!keys.ok) return keys;
      for (const key of new Set(keys.value)) {
        if ((await this.env.ARCHIVE.head(key)) === null)
          return { ok: false, error: { code: "referenced_r2_missing", key } };
      }
      return ready;
    } catch (error) {
      return {
        ok: false,
        error: { code: "export_read_failed", detail: errorMessage(error) },
      };
    }
  }

  async exportPlacementState(
    input: ActorExportRequest,
  ): Promise<Result<ActorExportRef, ActorExportError>> {
    const quiesced = await this.quiesceForExport(input.expectedFenceToken);
    if (!quiesced.ok) return quiesced;
    const source = await this.prepareExport(quiesced.value);
    if (!source.ok) return source;
    return exportActorPlacement({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      request: input,
      referencedR2Keys: source.value.referencedR2Keys,
    });
  }

  async importPlacementState(
    input: ActorImportRequest,
  ): Promise<Result<ActorImportedState, ActorExportError>> {
    const sqlMigration = this.importSqlMigration();
    return importActorPlacement({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      request: input,
      ...(sqlMigration === undefined ? {} : { sqlMigration }),
    });
  }

  /** Empties this Actor when no registry names it. */
  async eraseUnregisteredState() {
    const after = await this.prepareErasure();
    const erased = await eraseUnregisteredActorState(
      this.env,
      this.ctx.storage,
    );
    if (erased.ok) await after();
    return erased;
  }

  async eraseInactivePlacementState(request: InactiveActorErasureRequest) {
    const after = await this.prepareErasure();
    const erased = await eraseInactiveActorState(
      this.env,
      this.ctx.storage,
      request,
    );
    if (erased.ok) await after();
    return erased;
  }
}
