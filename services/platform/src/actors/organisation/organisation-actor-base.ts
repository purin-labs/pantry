import type { OrganisationModuleHost } from "@purin-labs/tenancy/actors/organisation/module-host";
import {
  runScreenRelevanceCheck,
  type ScreenRelevanceCheckInput,
} from "../../jev-features/screen-relevance-check";
import { decideScreenRelevanceRecord } from "../../jev-features/screen-relevance";
import type { ScreenRelevanceChoice } from "@purin-labs/control-api";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import {
  evaluateMail,
  type MailEvaluationInput,
} from "../../mail-inbox/evaluation";
import { reconcileAdmittedOrganisationArchiveCleanup } from "../../data/onboarding-reconciliation";
import { ARCHIVE_CLEANUP_PARTS } from "../../archive-cleanup-parts";
import {
  AdmittedOrganisationArchiveCleanup,
  readOrganisationArchiveCleanup,
  ORGANISATION_ARCHIVE_CLEANUP_KEY,
  type OrganisationArchiveCleanupError,
  type OrganisationArchiveCleanupRequest,
} from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import {
  OrganisationExecutionScope,
  selectOrganisationPlacementDatabase,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  settleActorExecution,
  isOrganisationExecutionActive,
} from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { admitActorRecovery } from "@purin-labs/actor-runtime/actors/actor-activation";
import { type ActorExportError } from "@purin-labs/actor-runtime/actors/actor-export";
import {
  acceptShopifyLocationObservation,
  assignShopifyLocationClassification,
  shopifyLocationClassificationAuthority,
  shopifyLocationProjectionAuthority,
  type AssignShopifyLocationClassificationInput,
  type ShopifyLocationClassificationAssignmentError,
  type ShopifyLocationClassificationAssignmentResult,
  type ShopifyLocationObservationAcceptanceError,
  type ShopifyLocationObservationInput,
  type ShopifyLocationObservationResult,
} from "../../shopify/location-observation";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import {
  applyEvalCommand,
  checkEvalReviewLabel,
  listEvalRunResults,
  listEvals,
  prepareEvalCommand,
  readEval,
  readEvalCommandReceipt,
  serializeEval,
  settleEvalRunResult,
} from "../../evals/store";
import {
  applyMemoryCommand,
  checkSharedReviewLabel,
  listMemories,
  prepareMemoryCommand,
  readAcceptedMemories,
  readAcceptedMemoryRevisions,
  readMemory,
  readMemoryCommandReceipt,
  serializeMemory,
  type AcceptedMemoryCursor,
} from "../../memory/store";
import { cleanupTypeSafeCredentials } from "../../integrations/typesafe/connection";
import { resolveTypeSafeCredential } from "../../integrations/typesafe/authority";
import { identifier, integerIn } from "../../case-context-discovery/policy";
import { errorMessage, isRecord } from "@purin-labs/std";
import { PlacedActor } from "@purin-labs/actor-runtime/actors/lifecycle/placed-actor";
import { rearmActorAlarm } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import { organisationAlarmReconcilers } from "../organisation-alarm";
import { schemaTransaction } from "./schema";
import {
  executeOrganisationCommand,
  readNextOrganisationAlarmAt,
  resolveOrganisationActorDatabase,
} from "./support";
import type {
  OrganisationMeta,
  OrganisationMetaInput,
  OrganisationStateError,
} from "@purin-labs/tenancy/actors/organisation/types";
import {
  organisationPlacementConflict,
  validateActionOrganisation,
} from "@purin-labs/tenancy/actors/organisation/organisation-record";

/**
 * The Organisation actor's state, its command admission and its shared helpers (Refactor 10, step 2.6). The layers above add policy and credentials, then commerce, Code Mode and activation; `OrganisationDO` keeps the members that use its private rooms and drafts.
 */
export abstract class OrganisationActorBase extends PlacedActor<OrganisationId> {
  protected readonly executions = new Set<
    Promise<Result<null, ActorExportError>>
  >();

  protected alarmExecution: Promise<void> | null = null;

  protected archiveCleanup: Promise<
    Result<number, OrganisationArchiveCleanupError>
  > | null = null;

  protected archiveQuiescence: Promise<
    Result<OrganisationId, ActorExportError>
  > | null = null;

  /**
   * Runs one Organisation command: it admits the placement, runs `start` with
   * the admitted scope, checks the placement again and tracks the execution for
   * the export barrier (Refactor 10, step 2.6).
   */
  protected command<Outcome extends Result<unknown, { readonly code: string }>>(
    organisationId: OrganisationId,
    start: (scope: OrganisationExecutionScope) => Promise<Outcome>,
  ) {
    return this.trackExecution(
      (executeOrganisationCommand<Outcome>).bind(
        null,
        this.env,
        this.ctx.storage,
        organisationId,
        start,
      ),
    );
  }

  protected async trackExecution<Value>(
    start: () => Promise<Value>,
  ): Promise<Value> {
    const work = start();
    const settlement = settleActorExecution(work);
    this.executions.add(settlement);
    try {
      return await work;
    } finally {
      this.executions.delete(settlement);
    }
  }

  protected async evaluateAdmittedMailClassification(
    input: MailEvaluationInput,
  ) {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.organisationId ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    )
      return {
        ok: false as const,
        error: { code: "organisation_placement_conflict" },
      };
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return evaluateMail({
      env: this.env,
      sql: this.ctx.storage.sql,
      scope: admission.scope,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      credential: await resolveTypeSafeCredential({
        sql: this.ctx.storage.sql,
        db: admission.scope.database,
        keys: this.env,
        organisationId: admission.scope.organisationId,
      }),
      request: input,
      fetcher: runtimeFetch,
    });
  }

  /** One Jev relevance check of the composer (Plan 87 section 3A). */
  protected async admittedCheckScreenRelevance(
    input: ScreenRelevanceCheckInput,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return runScreenRelevanceCheck({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      credential: await resolveTypeSafeCredential({
        sql: this.ctx.storage.sql,
        db: scope.database,
        keys: this.env,
        organisationId: input.organisationId,
      }),
      request: input,
      fetcher: runtimeFetch,
    });
  }

  /** The person's choice for a hint or a question that they saw. */
  protected async admittedDecideScreenRelevance(
    input: Readonly<{
      organisationId: OrganisationId;
      checkId: string;
      userId: string;
      choice: ScreenRelevanceChoice;
    }>,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const found = decideScreenRelevanceRecord(this.ctx.storage.sql, {
      ...input,
      now: Date.now(),
    });
    return found
      ? { ok: true as const, value: null }
      : {
          ok: false as const,
          error: { code: "screen_relevance_check_not_found" },
        };
  }

  protected async admittedReadMemories(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const memories = await listMemories(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!memories.ok) return memories;
    return { ok: true as const, value: memories.value.map(serializeMemory) };
  }

  protected async admittedReadMemory(
    memoryId: string,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (!identifier(memoryId))
      return { ok: false as const, error: { code: "memory_invalid" as const } };
    const memory = await readMemory(
      this.ctx.storage.sql,
      scope.organisationId,
      memoryId,
    );
    if (!memory.ok) return memory;
    return {
      ok: true as const,
      value: memory.value === null ? null : serializeMemory(memory.value),
    };
  }

  protected async admittedReadMemoryCommandReceipt(
    commandId: string,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return {
      ok: true as const,
      value: readMemoryCommandReceipt(
        this.ctx.storage.sql,
        scope.organisationId,
        commandId,
      ),
    };
  }

  protected async admittedReadAcceptedMemories(
    input: Readonly<{
      applicabilityKeys: readonly string[];
      after: AcceptedMemoryCursor | null;
      limit: number;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (
      !Array.isArray(input.applicabilityKeys) ||
      input.applicabilityKeys.length === 0 ||
      input.applicabilityKeys.length > 32 ||
      !input.applicabilityKeys.every(
        (key) => typeof key === "string" && key.length <= 2_048,
      ) ||
      !integerIn(input.limit, 1, 64) ||
      (input.after !== null &&
        (!isRecord(input.after) ||
          typeof input.after.applicabilityKey !== "string" ||
          input.after.applicabilityKey.length > 2_048 ||
          !identifier(input.after.memoryId)))
    )
      return { ok: false as const, error: { code: "memory_invalid" as const } };
    return readAcceptedMemories(
      this.ctx.storage.sql,
      scope.organisationId,
      input.applicabilityKeys,
      input.after,
      input.limit,
    );
  }

  protected async admittedReadAcceptedMemoryRevisions(
    memoryIds: readonly string[],
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (
      !Array.isArray(memoryIds) ||
      memoryIds.length === 0 ||
      memoryIds.length > 64 ||
      !memoryIds.every(identifier)
    )
      return { ok: false as const, error: { code: "memory_invalid" as const } };
    return readAcceptedMemoryRevisions(
      this.ctx.storage.sql,
      scope.organisationId,
      memoryIds,
    );
  }

  protected async admittedCommandMemory(
    input: Readonly<{ principal: unknown; body: unknown; flowLabel: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const prepared = await prepareMemoryCommand(input);
    if (!prepared.ok) return prepared;
    const inherited = await checkSharedReviewLabel(
      this.ctx.storage.sql,
      scope.organisationId,
      prepared.value,
    );
    if (!inherited.ok) return inherited;
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return applyMemoryCommand({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      requestDigest: prepared.value.requestDigest,
      now: Date.now(),
      command: prepared.value.command,
      inheritedRevision: inherited.value,
    });
  }

  protected async admittedReadEvals(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const evals = await listEvals(this.ctx.storage.sql, scope.organisationId);
    if (!evals.ok) return evals;
    return { ok: true as const, value: evals.value.map(serializeEval) };
  }

  protected async admittedReadEval(
    evalId: string,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (!identifier(evalId))
      return { ok: false as const, error: { code: "eval_invalid" as const } };
    const stored = await readEval(
      this.ctx.storage.sql,
      scope.organisationId,
      evalId,
    );
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      value: stored.value === null ? null : serializeEval(stored.value),
    };
  }

  protected async admittedReadEvalCommandReceipt(
    commandId: string,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return {
      ok: true as const,
      value: readEvalCommandReceipt(
        this.ctx.storage.sql,
        scope.organisationId,
        commandId,
      ),
    };
  }

  protected async admittedCommandEval(
    input: Readonly<{ principal: unknown; body: unknown; flowLabel: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const prepared = await prepareEvalCommand(input);
    if (!prepared.ok) return prepared;
    const inherited = await checkEvalReviewLabel(
      this.ctx.storage.sql,
      scope.organisationId,
      prepared.value,
    );
    if (!inherited.ok) return inherited;
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return applyEvalCommand({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      requestDigest: prepared.value.requestDigest,
      now: Date.now(),
      command: prepared.value.command,
      inheritedRevision: inherited.value,
    });
  }

  protected async admittedSettleEvalRun(
    input: Readonly<{ result: unknown; flowLabel: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return settleEvalRunResult({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      result: input.result,
      flowLabel: input.flowLabel,
    });
  }

  protected async admittedReadEvalRunResults(
    evalId: string,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (!identifier(evalId))
      return { ok: false as const, error: { code: "eval_invalid" as const } };
    return {
      ok: true as const,
      value: listEvalRunResults(
        this.ctx.storage.sql,
        scope.organisationId,
        evalId,
      ),
    };
  }

  protected async admitArchiveCleanup(
    input: OrganisationArchiveCleanupRequest,
  ): Promise<Result<number, OrganisationArchiveCleanupError>> {
    try {
      const execution = await OrganisationExecutionScope.resolveAtPlacement(
        this.env,
        input.organisationId,
        input.placement.placement,
      );
      if (
        !execution.ok ||
        execution.value.fenceToken !== input.placement.fenceToken
      ) {
        return {
          ok: false,
          error: { code: "organisation_archive_cleanup_conflict" },
        };
      }
      const admitted = await AdmittedOrganisationArchiveCleanup.admit(
        execution.value.database,
        this.ctx.storage,
        input,
      );
      if (!admitted.ok) return admitted;
      const repaired = await this.finishArchiveCleanup(admitted.value);
      return { ok: true, value: repaired };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "organisation_archive_cleanup_failed",
          detail: errorMessage(error),
        },
      };
    }
  }

  protected async finishArchiveCleanup(
    request: AdmittedOrganisationArchiveCleanup,
  ): Promise<number> {
    const database = selectOrganisationPlacementDatabase(
      this.env,
      request.organisationId,
      request.placement.placement,
    );
    if (!database.ok) throw new Error(database.error.code);
    const repaired = await reconcileAdmittedOrganisationArchiveCleanup({
      env: this.env,
      parts: ARCHIVE_CLEANUP_PARTS,
      db: database.value,
      directory: this.env.DB,
      archive: this.env.ARCHIVE,
      sessionNamespace: this.env.SESSION,
      connectorNamespace: this.env.CONNECTOR,
      request,
    });
    await this.ctx.storage.delete(ORGANISATION_ARCHIVE_CLEANUP_KEY);
    return repaired;
  }

  protected async drainArchiveCleanup(
    organisationId: OrganisationId,
  ): Promise<Result<OrganisationId, ActorExportError>> {
    try {
      for (const work of [...this.executions]) {
        const settled = await work;
        if (!settled.ok) return settled;
      }
      const alarm = this.alarmExecution;
      if (alarm !== null) {
        const settled = await settleActorExecution(alarm);
        if (!settled.ok) return settled;
      }
      const cleanup = await this.archiveCleanup;
      if (
        cleanup !== null &&
        !cleanup.ok &&
        cleanup.error.code === "organisation_archive_cleanup_failed"
      )
        return {
          ok: false,
          error: { code: "actor_cleanup_failed", detail: cleanup.error.detail },
        };
      const pending = await readOrganisationArchiveCleanup(this.ctx.storage);
      if (pending !== null) {
        if (pending.organisationId !== organisationId)
          throw new Error("organisation_archive_cleanup_identity_mismatch");
        await this.finishArchiveCleanup(pending);
      }
      const database = await resolveOrganisationActorDatabase(
        this.env,
        this.ctx.storage.sql,
      );
      if (!database.ok) return database;
      const credentials = await cleanupTypeSafeCredentials({
        sql: this.ctx.storage.sql,
        db: database.value,
        organisationId,
        now: Date.now(),
      });
      if (!credentials.ok)
        return {
          ok: false,
          error: {
            code: "actor_cleanup_failed",
            detail: credentials.error.code,
          },
        };
      return { ok: true, value: organisationId };
    } catch (error) {
      return {
        ok: false,
        error: { code: "actor_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  protected async admittedAcceptShopifyLocationObservation(
    input: ShopifyLocationObservationInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ShopifyLocationObservationResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | ShopifyLocationObservationAcceptanceError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const selected = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: input.organisationId,
    });
    const projectionAuthority = shopifyLocationProjectionAuthority(
      selected,
      input.integrationAccountId,
    );
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return this.ctx.storage.transactionSync(
      acceptShopifyLocationObservation.bind(
        null,
        this.ctx.storage.sql,
        input,
        projectionAuthority,
      ),
    );
  }

  protected async admittedAssignShopifyLocationClassification(
    input: AssignShopifyLocationClassificationInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ShopifyLocationClassificationAssignmentResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | ShopifyLocationClassificationAssignmentError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const selected = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: input.organisationId,
    });
    const commerceSystem = shopifyLocationClassificationAuthority(
      selected,
      input.integrationAccountId,
    );
    if (!commerceSystem.ok) return commerceSystem;
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return this.ctx.storage.transactionSync(
      assignShopifyLocationClassification.bind(
        null,
        this.ctx.storage.sql,
        input,
        commerceSystem.value,
      ),
    );
  }

  async ensureOrganisation(
    input: OrganisationMetaInput,
  ): Promise<OrganisationMeta> {
    this.ctx.storage.sql.exec(
      `INSERT INTO organisation_meta (organisation_id, name, plan, status, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         name = excluded.name,
         plan = excluded.plan,
         status = excluded.status`,
      input.organisationId,
      input.name,
      input.plan,
      input.status,
      input.createdAt,
    );

    await this.rearm();

    return input;
  }

  /** What this Organisation gives to a module of a product area. */
  protected readonly moduleHost: OrganisationModuleHost = (() => {
    const actor = this;
    return {
      get ctx() {
        return actor.ctx;
      },
      get env() {
        return actor.env;
      },
      command: (organisationId, start) => actor.command(organisationId, start),
      rearm: () => actor.rearm(),
    };
  })();

  /** Sets the alarm from the Organisation's stored work. */
  protected rearm(): Promise<number | null> {
    const sql = this.ctx.storage.sql;
    return rearmActorAlarm(
      this.ctx.storage,
      organisationAlarmReconcilers(sql, () => readNextOrganisationAlarmAt(sql)),
    );
  }
}
