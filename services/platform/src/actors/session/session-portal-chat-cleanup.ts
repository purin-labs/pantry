import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { type SessionId, type OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
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
import { sessionPlacementR2Keys } from "./support";

import type { SessionShared } from "./session-shared";

/**
 * The cleanup of a Portal chat in its Session: the erasure of the content,
 * and the wait for the work that runs (Refactor 17, step A1.9). It is a
 * module of the Session actor and gets the shared state.
 */
export class SessionPortalChatCleanup {
  constructor(private readonly shared: SessionShared) {}

  async admitPortalChatCleanup(
    input: PortalChatCleanupRequest,
  ): Promise<Result<void, PortalChatCleanupError>> {
    try {
      const execution = await OrganisationExecutionScope.resolveAtPlacement(
        this.shared.env,
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
      let erasure = await readPortalChatErasure(this.shared.ctx.storage);
      if (
        erasure !== null &&
        (erasure.organisationId !== input.requestingOrganisationId ||
          erasure.sessionId !== input.sessionId)
      )
        throw new Error("session_organisation_mismatch");
      if (erasure === null) {
        const session = await readCanonicalSessionForPersistence(
          this.shared.persistence,
          this.shared.ctx.storage.sql,
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
              ...sessionPlacementR2Keys(this.shared.ctx.storage.sql),
            ]),
          ],
        };
      }
      // A placement read may finish after export has closed local admission.
      if (!canAdmitSessionWork(this.shared.ctx.storage.sql, input))
        return { ok: false, error: { code: "chat_cleanup_conflict" } };
      if (erasure.kind === "erased") return { ok: true, value: undefined };
      await this.shared.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, erasure);
      await this.finishPortalChatCleanup(erasure);
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: { code: "chat_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  private async finishPortalChatCleanup(
    erasure: Variant<PortalChatErasure, "pending">,
  ): Promise<void> {
    await this.shared.activeMessagePreparation?.cancel();
    await this.shared.activeEmbeddedHarnessTurn?.turn.cancel();
    // An archive write that is in flight would put the checkpoint back after
    // the delete below.
    await this.shared.checkpointPublication;
    await this.shared.ctx.storage.deleteAlarm();
    this.shared.ctx.storage.transactionSync(
      eraseActorContentSql.bind(null, this.shared.ctx.storage.sql),
    );
    const keys: string[] = [];
    for (const key of (await this.shared.ctx.storage.list()).keys()) {
      if (key !== PORTAL_CHAT_ERASURE_KEY) keys.push(key);
    }
    if (keys.length > 0) await this.shared.ctx.storage.delete(keys);
    if (erasure.objectKeys.length > 0)
      await this.shared.env.ARCHIVE.delete([...erasure.objectKeys]);
    await this.shared.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, {
      kind: "erased",
      organisationId: erasure.organisationId,
      sessionId: erasure.sessionId,
    } satisfies PortalChatErasure);
  }

  async drainPortalChatCleanup(identity: {
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
      const erasure = await readPortalChatErasure(this.shared.ctx.storage);
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
}
