import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { Env } from "../../env";
import { type SessionId, type OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import {
  canAdmitSessionWork,
  isPortalChatCleanupPlacementActive,
  readPortalChatErasure,
  PORTAL_CHAT_ERASURE_KEY,
  type PortalChatCleanupError,
  type PortalChatCleanupRequest,
  type PortalChatErasure,
} from "../portal-chat-cleanup";
import { eraseActorContentSql } from "../placement-execution-quiescence";
import type { ActorExportError } from "../actor-export";
import type { Variant } from "@purin-labs/type-utils";
import { errorMessage } from "@purin-labs/std";
import { PlacedActor } from "../lifecycle/placed-actor";
import { SessionShared } from "./session-shared";
import {
  type TrackedTransientSessionExecution,
  type TransientSessionExecution,
  sessionPlacementR2Keys,
} from "./support";
import type { SessionToolWiring } from "./tool-wiring";
import type { SessionTransientHost } from "./transient-host";
import { piToolRules } from "../pi-tool-replay";
import { settleActorExecution } from "../actor-execution-quiescence";

/**
 * The Session actor's state and its Portal chat cleanup (Refactor 10, step 2.5). The layers above it add checkpoints, harness turns, recovery and transient turns; `SessionDO` adds the RPC methods.
 */
export abstract class SessionActorBase extends PlacedActor<null> {
  /**
   * The agent tools and the parts of the product areas. The Worker's class
   * gives them, so the Session names no area. It is a method, not a field:
   * the constructor reads it before a field of the last class exists.
   */
  protected abstract sessionTools(): SessionToolWiring;

  /**
   * The state that the modules of the Session share. Each module gets this
   * one value; no module reads a field of the Actor class.
   */
  protected readonly shared = new SessionShared(
    { ctx: () => this.ctx, env: () => this.env },
    () => this.sessionTools(),
  );

  /**
   * Runs one transient turn and holds it in the set that the cleanup, the
   * relocation and the release of stopped turns read.
   */
  protected async trackTransientTurn<Value>(
    start: (execution: TransientSessionExecution) => Promise<Value>,
  ): Promise<Value> {
    const execution: TransientSessionExecution = {
      state: { kind: "preparing" },
    };
    const work = start(execution);
    const tracked: TrackedTransientSessionExecution = {
      execution,
      settlement: settleActorExecution(work),
    };
    this.shared.transientExecutions.add(tracked);
    try {
      return await work;
    } finally {
      this.shared.transientExecutions.delete(tracked);
    }
  }

  /** What a module of a transient turn gets from the Session. */
  protected transientHost(): SessionTransientHost {
    return {
      env: this.env,
      ctx: this.ctx,
      persistence: this.shared.persistence,
      liveGoalRuns: this.shared.liveGoalRuns,
      toolRules: piToolRules.bind(null, this.sessionTools().registry),
    };
  }

  protected async admitPortalChatCleanup(
    input: PortalChatCleanupRequest,
  ): Promise<Result<void, PortalChatCleanupError>> {
    try {
      const execution = await OrganisationExecutionScope.resolveAtPlacement(
        this.env,
        input.requestingOrganisationId,
        input.placement,
      );
      if (
        !execution.ok ||
        !(await isPortalChatCleanupPlacementActive(
          execution.value.database,
          input,
        ))
      )
        return { ok: false, error: { code: "chat_cleanup_conflict" } };
      let erasure = await readPortalChatErasure(this.ctx.storage);
      if (
        erasure !== null &&
        (erasure.organisationId !== input.requestingOrganisationId ||
          erasure.sessionId !== input.sessionId)
      )
        throw new Error("session_organisation_mismatch");
      if (erasure === null) {
        const session = await readCanonicalSessionForPersistence(
          this.shared.persistence,
          this.ctx.storage.sql,
          input.requestingOrganisationId,
        );
        if (!session.ok) throw new Error(session.error.code);
        if (session.value.sessionId !== input.sessionId)
          throw new Error("session_identity_mismatch");
        erasure = {
          kind: "pending",
          organisationId: input.requestingOrganisationId,
          sessionId: input.sessionId,
          objectKeys: [
            ...new Set([
              ...input.objectKeys,
              ...sessionPlacementR2Keys(this.ctx.storage.sql),
            ]),
          ],
        };
      }
      // A placement read may finish after export has closed local admission.
      if (!canAdmitSessionWork(this.ctx.storage.sql, input))
        return { ok: false, error: { code: "chat_cleanup_conflict" } };
      if (erasure.kind === "erased") return { ok: true, value: undefined };
      await this.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, erasure);
      await this.finishPortalChatCleanup(erasure);
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: { code: "chat_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  protected async finishPortalChatCleanup(
    erasure: Variant<PortalChatErasure, "pending">,
  ): Promise<void> {
    await this.shared.activeMessagePreparation?.cancel();
    await this.shared.activeEmbeddedHarnessTurn?.turn.cancel();
    // An archive write that is in flight would put the checkpoint back after
    // the delete below.
    await this.shared.checkpointPublication;
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(
      eraseActorContentSql.bind(null, this.ctx.storage.sql),
    );
    const keys: string[] = [];
    for (const key of (await this.ctx.storage.list()).keys()) {
      if (key !== PORTAL_CHAT_ERASURE_KEY) keys.push(key);
    }
    if (keys.length > 0) await this.ctx.storage.delete(keys);
    if (erasure.objectKeys.length > 0)
      await this.env.ARCHIVE.delete([...erasure.objectKeys]);
    await this.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, {
      kind: "erased",
      organisationId: erasure.organisationId,
      sessionId: erasure.sessionId,
    } satisfies PortalChatErasure);
  }

  protected async drainPortalChatCleanup(identity: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<Result<null, ActorExportError>> {
    try {
      const cleanup = await this.shared.portalChatCleanup;
      if (
        cleanup !== null &&
        !cleanup.ok &&
        cleanup.error.code === "chat_cleanup_failed"
      )
        return {
          ok: false,
          error: { code: "actor_cleanup_failed", detail: cleanup.error.detail },
        };
      const erasure = await readPortalChatErasure(this.ctx.storage);
      if (
        erasure !== null &&
        (erasure.organisationId !== identity.organisationId ||
          erasure.sessionId !== identity.sessionId)
      )
        throw new Error("session_organisation_mismatch");
      if (erasure?.kind === "pending")
        await this.finishPortalChatCleanup(erasure);
      await this.shared.activeMessagePreparation?.cancel();
      await this.shared.activeEmbeddedHarnessTurn?.turn.cancel();
      const transientExecutions = [...this.shared.transientExecutions];
      for (const transient of transientExecutions) {
        if (transient.execution.state.kind === "running") {
          const cancelled = await transient.execution.state.turn.cancel();
          if (!cancelled.ok) throw new Error(cancelled.error.detail);
        }
      }
      const execution = await this.shared.canonicalTurn;
      if (execution !== null && !execution.ok) return execution;
      // A checkpoint's archive write continues after its turn's call.
      await this.shared.checkpointPublication;
      for (const transient of transientExecutions) {
        const settled = await transient.settlement;
        if (!settled.ok) return settled;
      }
      return { ok: true, value: null };
    } catch (error) {
      return {
        ok: false,
        error: { code: "actor_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  acceptCanonicalHarnessEvent(
    ...input: Parameters<SessionShared["acceptCanonicalHarnessEvent"]>
  ) {
    return this.shared.acceptCanonicalHarnessEvent(...input);
  }

  appendHarnessHistory(
    ...input: Parameters<SessionShared["appendHarnessHistory"]>
  ) {
    return this.shared.appendHarnessHistory(...input);
  }

  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  get durableState(): DurableObjectState {
    return this.ctx;
  }

  get bindings(): Env {
    return this.env;
  }
}
