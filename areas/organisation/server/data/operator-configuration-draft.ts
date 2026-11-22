import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  prepareControlMutationReceipt,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";

import type { Env } from "@purin-labs/kernel/env";
import { roleMayConfigure, type ControlRole } from "@purin-labs/tenancy/data/control-plane";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { runAgentOperation } from "@purin-labs/conversation/data/agent-operation-runner";
import { parseProposalChangeSummary } from "@purin-labs/bakery-workflow/changes";
import { parseRunFindings } from "@purin-labs/bakery-workflow/findings";
import {
  workflowChanges,
  type WorkflowChangeCommand,
} from "../../../../services/platform/src/kitchen/contract/workflow-changes";
import { deviceCommands } from "@purin-labs/area-devices/server/contract/device-commands";
import {
  parseBakeStockLevelInput,
  type BakeStockLevelInput,
} from "@purin-labs/kitchen-control-api";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  applyJevDraftCommand,
  jevDraftOperation,
  parseJevDraftCommand,
  type JevDraftCommand,
  type JevDraftRefusal,
} from "@purin-labs/area-integrations/server/contract/jev-draft";
import {
  applyOfferPriceAllowance,
  offerPriceAllowanceAlreadyApplied,
  parseOfferPriceAllowanceCommand,
  type OfferPriceAllowanceCommand,
} from "@purin-labs/area-commerce/server/contract/offer-price-allowance";
import type { PublishedResourceBoundaryError } from "@purin-labs/area-commerce/server/contract/types";
import type { Result } from "@purin-labs/kernel/result";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import {
  parseAgentOperationInput,
  readAgentOperations,
  type AgentOperationInput,
  type AgentOperationsError,
  type AgentOperationsSnapshot,
} from "@purin-labs/agent/data/agent-operations";
import { assertNever, isRecord } from "@purin-labs/std";
/**
 * A configuration change an operator asked for, stored before it is shown.
 *
 * Slack has no durable form state, so a preview an operator confirms minutes
 * later must be recoverable from something other than the message. The draft
 * is that record: it holds the exact normalized command, who may confirm it,
 * and the digest confirmation is bound to.
 *
 * This is a distinct origin from an agent suggesting a change to itself.
 * Only a direct operator request creates one.
 */
/**
 * A short code identifying the exact change a preview showed.
 *
 * The operator repeats it when accepting, which is what ties their reply to
 * the change they read. Without it a reply to an older preview would accept
 * whatever change happens to be pending when it arrives.
 */
export function previewCode(commandDigest: string): string {
  return commandDigest.slice(0, 6).toUpperCase();
}

type OperatorConfigurationDraftState =
  "pending" | "confirmed" | "settled" | "cancelled" | "expired";

export type OperatorConfigurationDraft = Readonly<{
  draftId: string;
  organisationId: OrganisationId;
  /** The Case the request arrived in, which scopes confirmation. */
  caseId: string;
  /** The control identity linked to the verified Slack account. */
  actorUserId: string;
  actorPersonId: string;
  /** The typed command, exactly as it will be applied. */
  command: OperatorDraftCommand;
  /** Confirmation must present this digest, so the text cannot drift. */
  commandDigest: string;
  /** One stable identity for the mutation, reused across retries. */
  mutationId: string;
  state: OperatorConfigurationDraftState;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** The outcome of applying it, so a lost response can be read back. */
  receiptCode: string | null;
}>;

/**
 * What one draft can carry.
 *
 * Agent configuration and a price allowance are different kinds of state with
 * different owners — one is D1, the other Commerce — so they keep separate
 * typed boundaries rather than being forced into one union. The draft carries
 * either, because the thing a draft models is "a change an operator asked for
 * and must confirm", which is true of both.
 */
export type OperatorDraftCommand =
  | Readonly<{ family: "agent_operation"; operation: AgentOperationInput }>
  | Readonly<{
      family: "offer_price_allowance";
      allowance: OfferPriceAllowanceCommand;
    }>
  | Readonly<{ family: "device_command"; command: DeviceDraftCommand }>
  | Readonly<{ family: "workflow_change"; change: WorkflowChangeCommand }>
  /** A Jev switch that the chat agent proposed (Plan 88). */
  | Readonly<{ family: "jev_feature"; command: JevDraftCommand }>
  /** A bake stock level that the chat agent proposed (Plan 24 S1). */
  | Readonly<{ family: "bake_stock_level"; level: BakeStockLevelInput }>;

type WorkflowApprover = Readonly<{
  userId: UserId;
  controlSessionId: ControlSessionId;
}>;

/** A change to a shop device that an agent proposed and a person confirms. */
export type DeviceDraftCommand =
  | Readonly<{
      kind: "device_restrict";
      deviceId: string;
      deviceName: string;
      reason: string;
    }>
  | Readonly<{
      kind: "device_resume";
      deviceId: string;
      deviceName: string;
    }>;

type OperatorDraftError =
  | Readonly<{ code: "operator_draft_authority_inactive" }>
  | Readonly<{ code: "operator_draft_invalid"; field: string }>
  | Readonly<{ code: "operator_draft_not_found" }>
  | Readonly<{ code: "operator_draft_expired" }>
  | Readonly<{
      code: "operator_draft_not_pending";
      state: OperatorConfigurationDraftState;
    }>
  | Readonly<{ code: "operator_draft_actor_mismatch" }>
  | Readonly<{ code: "operator_draft_digest_mismatch" }>
  | Readonly<{ code: "operator_draft_persistence_failed" }>
  /** The applied recipe moved after the proposal read it. */
  | Readonly<{ code: "workflow_revision_conflict" }>
  /** A person changed the same steps in the shared draft. */
  | Readonly<{ code: "workflow_human_intervention" }>
  /** A proposal needs a signed-in person, because it writes to the shared draft. */
  | Readonly<{ code: "workflow_approver_required" }>
  /** A Jev switch that could not turn on, in the words of Settings › Jev. */
  | JevDraftRefusal
  /** A bake stock level that the Bakes page would refuse too. */
  | Readonly<{
      code: "bake_level_invalid" | "bake_recipe_missing" | "bake_level_stale";
    }>;

/**
 * The commands a confirmation can carry out — every command the Portal can
 * submit.
 *
 * Two used to be excluded. `dispatch_manual_run` needed a Case opened, and
 * `publish_responsibility_scope` needed published-resource evidence that only
 * the control route fetched. Both now go through the shared runner both
 * surfaces use, so excluding them would be a Slack-only restriction with
 * nothing behind it.
 */
const CONFIRMABLE_COMMANDS: ReadonlySet<AgentOperationInput["kind"]> = new Set([
  "create_area",
  "create_skill",
  "publish_skill_revision",
  "create_agent_definition",
  "publish_agent_definition_revision",
  "activate_agent_definition_revision",
  "install_agent",
  "bind_skill",
  "configure_cue_binding",
  "configure_schedule_binding",
  "update_cue_binding",
  "update_schedule_binding",
  "configure_installation_governance",
  "configure_escalation_policy",
  "accept_configuration_proposal",
  "dismiss_configuration_proposal",
  "dispatch_manual_run",
  "publish_responsibility_scope",
]);

export type CreateOperatorDraftInput = Readonly<{
  scope: OrganisationExecutionScope;
  authorizeCommit: () => Promise<void>;
  draftId: string;
  caseId: string;
  actorUserId: string;
  actorPersonId: string;
  /** The raw command body a Portal form or a Slack intent produced. */
  rawCommand: unknown;
  mutationId: string;
  now: number;
  expiresAt: number;
}>;

/**
 * Records one operator-requested configuration change for confirmation.
 *
 * The command is parsed by the same boundary the Portal uses, so a Slack
 * request cannot express anything a Portal form could not. Creating a new
 * draft in a Case cancels the pending one, so an operator who rephrases their
 * request cannot leave an older reading of it confirmable.
 */
export async function createOperatorConfigurationDraft(
  input: CreateOperatorDraftInput,
): Promise<
  Result<OperatorConfigurationDraft, OperatorDraftError | AgentOperationsError>
> {
  await input.authorizeCommit();
  if (input.expiresAt <= input.now) {
    return {
      ok: false,
      error: { code: "operator_draft_invalid", field: "expiresAt" },
    };
  }
  if (input.actorUserId.length === 0 || input.actorPersonId.length === 0) {
    return {
      ok: false,
      error: { code: "operator_draft_invalid", field: "actor" },
    };
  }
  const parsed = parseDraftCommand(input.rawCommand);
  if (!parsed.ok) {
    return parsed;
  }
  if (
    parsed.value.family === "agent_operation" &&
    !CONFIRMABLE_COMMANDS.has(parsed.value.operation.kind)
  ) {
    return {
      ok: false,
      error: { code: "operator_draft_invalid", field: "kind" },
    };
  }
  const commandDigest = await digestCanonical(parsed.value);
  // Staging the same change again is not a new request. Returning the draft
  // already awaiting confirmation keeps its preview code valid; cancelling it
  // and inserting a twin under the same id failed the insert and left the
  // operator with nothing to confirm at all.
  const pending = await readPendingOperatorDraft({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    caseId: input.caseId,
    now: input.now,
  });
  if (
    pending !== null &&
    pending.commandDigest === commandDigest &&
    pending.actorUserId === input.actorUserId
  ) {
    await input.authorizeCommit();
    return { ok: true, value: pending };
  }
  const draft: OperatorConfigurationDraft = {
    draftId: input.draftId,
    organisationId: input.scope.organisationId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    actorPersonId: input.actorPersonId,
    command: parsed.value,
    commandDigest,
    mutationId: input.mutationId,
    state: "pending",
    createdAt: input.now,
    expiresAt: input.expiresAt,
    decidedAt: null,
    receiptCode: null,
  };
  await input.authorizeCommit();
  try {
    const written = await input.scope.database.batch([
      input.scope.database
        .prepare(
          `UPDATE operator_configuration_draft
            SET state = 'cancelled', decided_at = ?
          WHERE organisation_id = ? AND case_id = ? AND state = 'pending'
            AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
              AND placement_epoch = ? AND placement_cell_id = ?
              AND fence_token = ? AND status = 'active')`,
        )
        .bind(
          input.now,
          input.scope.organisationId,
          input.caseId,
          input.scope.organisationId,
          input.scope.placement.placementEpoch,
          input.scope.placement.placementCellId,
          input.scope.fenceToken,
        ),
      input.scope.database
        .prepare(
          `INSERT INTO operator_configuration_draft (
           draft_id, organisation_id, case_id, actor_user_id, actor_person_id,
           command_json, command_digest, mutation_id, state, created_at, expires_at,
           decided_at, receipt_code
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL
          WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
            AND placement_epoch = ? AND placement_cell_id = ?
            AND fence_token = ? AND status = 'active')`,
        )
        .bind(
          draft.draftId,
          draft.organisationId,
          draft.caseId,
          draft.actorUserId,
          draft.actorPersonId,
          JSON.stringify(draft.command),
          draft.commandDigest,
          draft.mutationId,
          draft.createdAt,
          draft.expiresAt,
          input.scope.organisationId,
          input.scope.placement.placementEpoch,
          input.scope.placement.placementCellId,
          input.scope.fenceToken,
        ),
    ]);
    if (written[1]?.meta.changes !== 1)
      return {
        ok: false,
        error: { code: "operator_draft_authority_inactive" },
      };
  } catch {
    return { ok: false, error: { code: "operator_draft_persistence_failed" } };
  }
  await input.authorizeCommit();
  return { ok: true, value: draft };
}

/** The draft awaiting confirmation in one Case, if it is still usable. */
export async function readPendingOperatorDraft(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
    now: number;
  }>,
): Promise<OperatorConfigurationDraft | null> {
  const row = await input.db
    .prepare(
      `SELECT draft_id AS draftId, organisation_id AS organisationId, case_id AS caseId,
            actor_user_id AS actorUserId,
            actor_person_id AS actorPersonId, command_json AS command,
            command_digest AS commandDigest, mutation_id AS mutationId, state,
            created_at AS createdAt, expires_at AS expiresAt,
            decided_at AS decidedAt, receipt_code AS receiptCode
       FROM operator_configuration_draft
      WHERE organisation_id = ? AND case_id = ? AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.organisationId, input.caseId)
    .first<Record<string, unknown>>();
  if (row === null) {
    return null;
  }
  const draft = parseDraftRow(row);
  if (draft === null) {
    return null;
  }
  return draft.expiresAt <= input.now ? { ...draft, state: "expired" } : draft;
}

/**
 * The most recently decided draft in one Case.
 *
 * An operator whose reply was lost and who repeats it should be told the
 * change was already made, not met with silence, so the settled record has to
 * be findable after it stops being pending.
 */
export async function readLatestDecidedOperatorDraft(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
  }>,
): Promise<OperatorConfigurationDraft | null> {
  const row = await input.db
    .prepare(
      `SELECT draft_id AS draftId, organisation_id AS organisationId, case_id AS caseId,
            actor_user_id AS actorUserId,
            actor_person_id AS actorPersonId, command_json AS command,
            command_digest AS commandDigest, mutation_id AS mutationId, state,
            created_at AS createdAt, expires_at AS expiresAt,
            decided_at AS decidedAt, receipt_code AS receiptCode
       FROM operator_configuration_draft
      WHERE organisation_id = ? AND case_id = ? AND state IN ('settled', 'confirmed')
      ORDER BY decided_at DESC, created_at DESC LIMIT 1`,
    )
    .bind(input.organisationId, input.caseId)
    .first<Record<string, unknown>>();
  return row === null ? null : parseDraftRow(row);
}

/** The drafts of one Case in the order they were staged, for its chat cards. */
export async function listOperatorDraftsForCase(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
    now: number;
  }>,
): Promise<readonly OperatorConfigurationDraft[]> {
  const rows = await input.db
    .prepare(
      `SELECT draft_id AS draftId, organisation_id AS organisationId, case_id AS caseId,
            actor_user_id AS actorUserId,
            actor_person_id AS actorPersonId, command_json AS command,
            command_digest AS commandDigest, mutation_id AS mutationId, state,
            created_at AS createdAt, expires_at AS expiresAt,
            decided_at AS decidedAt, receipt_code AS receiptCode
       FROM operator_configuration_draft
      WHERE organisation_id = ? AND case_id = ?
      ORDER BY created_at ASC LIMIT 50`,
    )
    .bind(input.organisationId, input.caseId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).flatMap((row) => {
    const draft = parseDraftRow(row);
    if (draft === null) return [];
    return draft.state === "pending" && draft.expiresAt <= input.now
      ? [{ ...draft, state: "expired" as const }]
      : [draft];
  });
}

type ConfirmOperatorDraftInput = Readonly<{
  db: OrganisationDatabase;
  /**
   * Needed because carrying out a command may reach past D1 — opening a Case
   * for a manual run, or resolving published-resource evidence.
   */
  env: Env;
  organisationId: OrganisationId;
  draftId: string;
  /** The Portal session that confirms. A recipe change writes to a shared draft with it. */
  controlSessionId?: ControlSessionId;
  /** Who is confirming, resolved from the verified account, not the message. */
  actorUserId: string;
  /**
   * The confirmer's current role, read fresh for this message. A manual run
   * opens a Case under this authority, so it must be the role they hold now,
   * never one assumed for them.
   */
  actorRole: ControlRole;
  /**
   * The short code the preview displayed and the operator repeated back.
   *
   * Checked against the stored draft's own code, so a reply written for an
   * earlier preview cannot accept the change that replaced it.
   */
  previewCode: string;
  now: number;
}>;

type OperatorDraftReceipt = Readonly<{
  draft: OperatorConfigurationDraft;
  snapshot: AgentOperationsSnapshot;
}>;

/**
 * Claims pending drafts, resumes confirmed drafts, and reads settled outcomes.
 * Retries reuse the draft's mutation identity to reconcile an interrupted effect.
 */
export async function confirmOperatorConfigurationDraft(
  input: ConfirmOperatorDraftInput,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const stored = await readOperatorDraft(
    input.db,
    input.organisationId,
    input.draftId,
  );
  if (stored === null) {
    return { ok: false, error: { code: "operator_draft_not_found" } };
  }
  if (stored.actorUserId !== input.actorUserId) {
    return { ok: false, error: { code: "operator_draft_actor_mismatch" } };
  }
  if (
    draftPreviewCode(stored.commandDigest) !== input.previewCode.toUpperCase()
  ) {
    return { ok: false, error: { code: "operator_draft_digest_mismatch" } };
  }
  // A settled draft returns what it recorded rather than refusing. A lost
  // response is then a read, which is what the operator's retry deserves.
  if (stored.state === "settled") {
    return stored.receiptCode === "accepted"
      ? {
          ok: true,
          value: {
            draft: stored,
            snapshot: await readAgentOperations(input.db, input.organisationId),
          },
        }
      : { ok: false, error: recordedFailure(stored.receiptCode) };
  }
  if (stored.state === "confirmed") {
    // Claimed but never settled: an interruption between the claim and the
    // apply. Re-drive it under the same mutation identity rather than leaving
    // the operator with a change they confirmed and that never happened.
    return applyClaimedDraft(
      input.env,
      input.organisationId,
      stored,
      input.actorRole,
      input.now,
      approverOf(input),
    );
  }
  if (stored.state !== "pending") {
    return {
      ok: false,
      error: { code: "operator_draft_not_pending", state: stored.state },
    };
  }
  if (stored.expiresAt <= input.now) {
    await input.db
      .prepare(
        `UPDATE operator_configuration_draft SET state = 'expired', decided_at = ?
        WHERE draft_id = ? AND organisation_id = ? AND state = 'pending'`,
      )
      .bind(input.now, input.draftId, input.organisationId)
      .run();
    return { ok: false, error: { code: "operator_draft_expired" } };
  }
  const claimed = await input.db
    .prepare(
      `UPDATE operator_configuration_draft SET state = 'confirmed', decided_at = ?
      WHERE draft_id = ? AND organisation_id = ? AND state = 'pending'`,
    )
    .bind(input.now, input.draftId, input.organisationId)
    .run();
  if (claimed.meta.changes === 0) {
    const current = await readOperatorDraft(
      input.db,
      input.organisationId,
      input.draftId,
    );
    return {
      ok: false,
      error: {
        code: "operator_draft_not_pending",
        state: current?.state ?? "cancelled",
      },
    };
  }
  return applyClaimedDraft(
    input.env,
    input.organisationId,
    stored,
    input.actorRole,
    input.now,
    approverOf(input),
  );
}

function approverOf(input: ConfirmOperatorDraftInput): WorkflowApprover | null {
  return input.controlSessionId === undefined
    ? null
    : {
        userId: input.actorUserId as UserId,
        controlSessionId: input.controlSessionId,
      };
}

/**
 * Applies a draft that has been claimed, and records what happened.
 *
 * Reached both by a first confirmation and by a retry that found the draft
 * claimed but unsettled. The mutation identity is the draft's own, so a
 * re-drive after an interruption is the same mutation rather than a second
 * one.
 */
async function applyClaimedDraft(
  env: Env,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  actorRole: ControlRole,
  now: number,
  approver: WorkflowApprover | null,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return {
      ok: false,
      error: { code: "agent_operation_invalid", field: "placement" },
    };
  const db = execution.value.database;
  const scope = draftMutationScope(organisationId, stored);
  const boundary = {
    kind: "unversioned",
    idempotencyKey: stored.mutationId,
    requestHash: stored.commandDigest,
  } as const;
  // Check for a completed effect before resuming execution.
  // D1 changes batch the receipt with the effect;
  // Case dispatch and Commerce changes persist it after successful execution.
  const replay = await readControlMutationReplay({ db, scope, boundary });
  if (replay.kind === "conflict") {
    return { ok: false, error: { code: "operator_draft_digest_mismatch" } };
  }
  if (replay.kind === "replay") {
    return settleFromReceipt(
      db,
      organisationId,
      stored,
      now,
      replay.receipt.responseBody,
    );
  }
  if (stored.command.family === "workflow_change") {
    return applyClaimedWorkflowChange(
      env,
      execution.value,
      organisationId,
      stored,
      stored.command.change,
      now,
      scope,
      boundary,
      approver,
    );
  }
  if (stored.command.family === "device_command") {
    return applyClaimedDeviceCommand(
      env,
      execution.value,
      organisationId,
      stored,
      stored.command.command,
      now,
      scope,
      boundary,
    );
  }
  if (stored.command.family === "bake_stock_level") {
    return applyClaimedBakeStockLevel(
      env,
      execution.value,
      organisationId,
      stored,
      stored.command.level,
      actorRole,
      now,
      scope,
      boundary,
    );
  }
  if (stored.command.family === "jev_feature") {
    return applyClaimedJevFeature(
      env,
      execution.value,
      organisationId,
      stored,
      stored.command.command,
      actorRole,
      now,
      scope,
      boundary,
    );
  }
  if (stored.command.family === "offer_price_allowance") {
    return applyClaimedAllowance(
      env,
      execution.value,
      organisationId,
      stored,
      stored.command.allowance,
      now,
      scope,
      boundary,
    );
  }
  // The same runner the Portal route uses, so a command confirmed in Slack is
  // carried out exactly as the Portal would carry it out.
  const applied = await runAgentOperation({
    env,
    scope: execution.value,
    operation: stored.command.operation,
    actor: {
      userId: stored.actorUserId,
      personId: stored.actorPersonId,
      role: actorRole,
      origin: { kind: "slack" },
    },
    operationId: stored.mutationId,
    now,
    trailing: [
      prepareControlMutationReceipt(db, {
        scope,
        boundary,
        identity: newControlMutationIdentity({
          portalSubjectHash: await hashPortalSubject(
            "slack",
            stored.actorPersonId,
          ),
          causationId: stored.draftId,
          now,
        }),
        responseStatus: 200,
        responseBody: { receiptCode: "accepted" },
      }),
      settleStatement(db, organisationId, stored, "accepted"),
    ],
  });
  if (!applied.ok) {
    const failure = draftFailure(applied.error);
    // A refusal wrote nothing, so nothing needs to be undone. Recording the
    // refusal on the draft is a separate, safely repeatable write.
    await settleStatement(db, organisationId, stored, failure.code)
      .run()
      .catch(() => undefined);
    return { ok: false, error: failure };
  }
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: applied.value,
    },
  };
}

/**
 * Applies one confirmed allowance change.
 *
 * The effect lands in Commerce, not D1, so it cannot ride in the same batch
 * as the receipt the way a configuration write does. Instead a retry asks
 * Commerce what the allowance is now: the policy carries its own revision
 * and value, so "did my write land" is answerable exactly. Without that the
 * retry would bind a revision its own first attempt advanced and report a
 * stale conflict for a change that succeeded.
 */
async function applyClaimedAllowance(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  command: OfferPriceAllowanceCommand,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: Readonly<{
    kind: "unversioned";
    idempotencyKey: string;
    requestHash: string;
  }>,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const db = execution.database;
  const settled = (await offerPriceAllowanceAlreadyApplied(
    env,
    organisationId,
    command,
  ))
    ? { ok: true as const, value: null as unknown }
    : await applyOfferPriceAllowance(env, organisationId, command, now);
  if (!settled.ok) {
    const code =
      settled.error.code === "offer_price_allowance_stale" ||
      settled.error.code === "offer_price_allowance_price_moved"
        ? ("agent_operation_conflict" as const)
        : ("agent_operation_invalid" as const);
    const failure: AgentOperationsError = { code, field: "allowance" };
    await settleStatement(db, organisationId, stored, failure.code)
      .run()
      .catch(() => undefined);
    return { ok: false, error: failure };
  }
  await db.batch([
    prepareControlMutationReceipt(db, {
      scope,
      boundary,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          "slack",
          stored.actorPersonId,
        ),
        causationId: stored.draftId,
        now,
      }),
      responseStatus: 200,
      responseBody: { receiptCode: "accepted" },
    }),
    settleStatement(db, organisationId, stored, "accepted"),
  ]);
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: await readAgentOperations(db, organisationId),
    },
  };
}

async function applyClaimedWorkflowChange(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  change: WorkflowChangeCommand,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: Readonly<{
    kind: "unversioned";
    idempotencyKey: string;
    requestHash: string;
  }>,
  approver: WorkflowApprover | null,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const db = execution.database;
  if (approver === null)
    return { ok: false, error: { code: "workflow_approver_required" } };
  const applied = await workflowChanges.use().applyApprovedWorkflowChange(
    env,
    execution,
    organisationId,
    stored.draftId,
    change,
    approver,
  );
  switch (applied.kind) {
    case "applied":
      break;
    case "draft_unavailable":
      // The draft stays claimed, so the next confirmation finishes it.
      return {
        ok: false,
        error: { code: "agent_operation_persistence_failed" },
      };
    case "revision_conflict":
    case "human_intervention":
    case "invalid": {
      const failure =
        applied.kind === "revision_conflict"
          ? ({ code: "workflow_revision_conflict" } as const)
          : applied.kind === "human_intervention"
            ? ({ code: "workflow_human_intervention" } as const)
            : ({
                code: "agent_operation_conflict",
                field: "workflow",
              } as const);
      await settleStatement(db, organisationId, stored, failure.code)
        .run()
        .catch(() => undefined);
      return { ok: false, error: failure };
    }
    default:
      return assertNever(applied, "Unexpected workflow approval");
  }
  await db.batch([
    prepareControlMutationReceipt(db, {
      scope,
      boundary,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          "slack",
          stored.actorPersonId,
        ),
        causationId: stored.draftId,
        now,
      }),
      responseStatus: 200,
      responseBody: { receiptCode: "accepted" },
    }),
    settleStatement(db, organisationId, stored, "accepted"),
  ]);
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: await readAgentOperations(db, organisationId),
    },
  };
}

async function applyClaimedDeviceCommand(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  command: DeviceDraftCommand,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: Readonly<{
    kind: "unversioned";
    idempotencyKey: string;
    requestHash: string;
  }>,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const db = execution.database;
  const applied = await deviceCommands.use().runDeviceCommand({
    env,
    scope: execution,
    subjectId: command.deviceId,
    command:
      command.kind === "device_restrict"
        ? { kind: "restrict", reason: command.reason }
        : { kind: "resume" },
    actor: { kind: "person", id: stored.actorUserId },
    idempotencyKey: stored.mutationId,
    now,
  });
  if (!applied.ok) {
    const failure: AgentOperationsError = {
      code: "agent_operation_conflict",
      field: "device",
    };
    await settleStatement(db, organisationId, stored, failure.code)
      .run()
      .catch(() => undefined);
    return { ok: false, error: failure };
  }
  await db.batch([
    prepareControlMutationReceipt(db, {
      scope,
      boundary,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          "slack",
          stored.actorPersonId,
        ),
        causationId: stored.draftId,
        now,
      }),
      responseStatus: 200,
      responseBody: { receiptCode: "accepted" },
    }),
    settleStatement(db, organisationId, stored, "accepted"),
  ]);
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: await readAgentOperations(db, organisationId),
    },
  };
}

type DraftReceiptBoundary = Readonly<{
  kind: "unversioned";
  idempotencyKey: string;
  requestHash: string;
}>;

/**
 * Applies one confirmed Jev switch change (Plan 88). The person who confirms
 * must be an owner or admin now, as on Settings › Jev, and the change runs as
 * that person. A switch that cannot turn on settles with the page's reason.
 */
async function applyClaimedJevFeature(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  command: JevDraftCommand,
  actorRole: ControlRole,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: DraftReceiptBoundary,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  return settleClaimedChange(
    execution,
    organisationId,
    stored,
    roleMayConfigure(actorRole)
      ? await applyJevDraftCommand(
          env,
          organisationId,
          command,
          stored.actorUserId,
        )
      : {
          ok: false,
          error: { code: "agent_operation_invalid", field: "role" },
        },
    now,
    scope,
    boundary,
  );
}

/**
 * Applies one confirmed bake stock level (Plan 24 S1) through the
 * Organisation Actor, the same function that the Bakes page calls. The person
 * who confirms must be an admin or the owner now, as on the page.
 */
async function applyClaimedBakeStockLevel(
  env: Env,
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  level: BakeStockLevelInput,
  actorRole: ControlRole,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: DraftReceiptBoundary,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  let applied: Result<true, OperatorDraftError | AgentOperationsError> = {
    ok: false,
    error: { code: "agent_operation_invalid", field: "role" },
  };
  if (roleMayConfigure(actorRole)) {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId,
      now,
    });
    const set = await organisation.setBakeStockLevel({
      organisationId,
      level,
      setBy: stored.actorUserId,
    });
    applied = set.ok
      ? { ok: true, value: true }
      : {
          ok: false,
          error: {
            code:
              set.error.code === "bake_recipe_missing" ||
              set.error.code === "bake_level_stale"
                ? set.error.code
                : "bake_level_invalid",
          },
        };
  }
  return settleClaimedChange(
    execution,
    organisationId,
    stored,
    applied,
    now,
    scope,
    boundary,
  );
}

/** Records the receipt and the settlement of a change that a draft applied. */
async function settleClaimedChange(
  execution: OrganisationExecutionScope,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  applied: Result<true, OperatorDraftError | AgentOperationsError>,
  now: number,
  scope: ControlMutationReceiptScope,
  boundary: DraftReceiptBoundary,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const db = execution.database;
  if (!applied.ok) {
    await settleStatement(db, organisationId, stored, applied.error.code)
      .run()
      .catch(() => undefined);
    return { ok: false, error: applied.error };
  }
  await db.batch([
    prepareControlMutationReceipt(db, {
      scope,
      boundary,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          "slack",
          stored.actorPersonId,
        ),
        causationId: stored.draftId,
        now,
      }),
      responseStatus: 200,
      responseBody: { receiptCode: "accepted" },
    }),
    settleStatement(db, organisationId, stored, "accepted"),
  ]);
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: await readAgentOperations(db, organisationId),
    },
  };
}

/**
 * Answers a repeat confirmation from the receipt the first one wrote.
 *
 * The effect is known to have landed, so the only thing left to do is bring
 * the draft's own record in line and report the same outcome again.
 */
async function settleFromReceipt(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  now: number,
  responseBody: unknown,
): Promise<
  Result<OperatorDraftReceipt, OperatorDraftError | AgentOperationsError>
> {
  const code =
    isRecord(responseBody) && typeof responseBody.receiptCode === "string"
      ? responseBody.receiptCode
      : "accepted";
  await settleStatement(db, organisationId, stored, code)
    .run()
    .catch(() => undefined);
  if (code !== "accepted") {
    return { ok: false, error: recordedFailure(code) };
  }
  return {
    ok: true,
    value: {
      draft: {
        ...stored,
        state: "settled",
        decidedAt: now,
        receiptCode: "accepted",
      },
      snapshot: await readAgentOperations(db, organisationId),
    },
  };
}

function settleStatement(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
  receiptCode: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE operator_configuration_draft SET state = 'settled', receipt_code = ?
      WHERE draft_id = ? AND organisation_id = ? AND state = 'confirmed'`,
    )
    .bind(receiptCode, stored.draftId, organisationId);
}

/**
 * Names this confirmation in the same receipt table the Portal writes to.
 *
 * Keying on the acting identity and the command kind rather than the surface
 * means a change confirmed in Slack and the same change submitted in the
 * Portal cannot both apply.
 */
function draftMutationScope(
  organisationId: OrganisationId,
  stored: OperatorConfigurationDraft,
): ControlMutationReceiptScope {
  return {
    userId: stored.actorUserId as ControlMutationReceiptScope["userId"],
    organisationScope: organisationId,
    route: "slack/operator_configuration_draft",
    operation:
      stored.command.family === "workflow_change"
        ? "bakery.workflow_change"
        : stored.command.family === "device_command"
          ? `device.${stored.command.command.kind}`
          : stored.command.family === "jev_feature"
            ? jevDraftOperation(stored.command.command)
            : stored.command.family === "bake_stock_level"
              ? "kitchen.bake_level.set"
              : stored.command.family === "offer_price_allowance"
                ? `commerce.offer_price_allowance.${stored.command.allowance.kind}`
                : `agent.operations.${stored.command.operation.kind}`,
  };
}

/**
 * Maps a runner refusal onto something a draft can record.
 *
 * Resolving published-resource evidence can fail in ways the configuration
 * vocabulary has no word for. A scope that is not published is a bad request
 * and the operator can fix it; the rest are conditions that may clear, so they
 * are recorded as a failure to persist rather than as a rejected change.
 */
function draftFailure(
  error: AgentOperationsError | PublishedResourceBoundaryError,
): AgentOperationsError {
  switch (error.code) {
    case "invalid_reference":
    case "not_published":
      return { code: "agent_operation_invalid", field: "scope" };
    case "revision_conflict":
      return { code: "agent_operation_conflict", field: "scope" };
    case "organisation_mismatch":
    case "merchant_mismatch":
    case "unavailable":
      return { code: "agent_operation_persistence_failed" };
    default:
      return error;
  }
}

/** The failure a settled draft recorded, replayed for a repeat confirmation. */
function recordedFailure(
  receiptCode: string | null,
): AgentOperationsError | OperatorDraftError {
  switch (receiptCode) {
    case "workflow_revision_conflict":
    case "workflow_human_intervention":
    case "jev_key_unavailable":
    case "jev_feature_source_unavailable":
    case "jev_feature_unavailable":
    case "bake_level_invalid":
    case "bake_recipe_missing":
    case "bake_level_stale":
      return { code: receiptCode };
    case "agent_operation_conflict":
      return { code: "agent_operation_conflict", field: "record" };
    case "agent_operation_not_found":
      return { code: "agent_operation_not_found", field: "record" };
    case "agent_operation_invalid":
      return { code: "agent_operation_invalid", field: "record" };
    default:
      return { code: "agent_operation_persistence_failed" };
  }
}

/** The code one draft's preview displayed. */
function draftPreviewCode(commandDigest: string): string {
  return commandDigest.slice(0, 6).toUpperCase();
}

/** Withdraws a pending draft without applying it. */
export async function cancelOperatorConfigurationDraft(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    draftId: string;
    actorUserId: string;
    now: number;
  }>,
): Promise<Result<true, OperatorDraftError>> {
  const stored = await readOperatorDraft(
    input.db,
    input.organisationId,
    input.draftId,
  );
  if (stored === null) {
    return { ok: false, error: { code: "operator_draft_not_found" } };
  }
  if (stored.actorUserId !== input.actorUserId) {
    return { ok: false, error: { code: "operator_draft_actor_mismatch" } };
  }
  const cancelled = await input.db
    .prepare(
      `UPDATE operator_configuration_draft SET state = 'cancelled', decided_at = ?
      WHERE draft_id = ? AND organisation_id = ? AND state = 'pending'`,
    )
    .bind(input.now, input.draftId, input.organisationId)
    .run();
  return cancelled.meta.changes === 1
    ? { ok: true, value: true }
    : {
        ok: false,
        error: { code: "operator_draft_not_pending", state: stored.state },
      };
}

export async function readOperatorDraft(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  draftId: string,
): Promise<OperatorConfigurationDraft | null> {
  const row = await db
    .prepare(
      `SELECT draft_id AS draftId, organisation_id AS organisationId, case_id AS caseId,
            actor_user_id AS actorUserId,
            actor_person_id AS actorPersonId, command_json AS command,
            command_digest AS commandDigest, mutation_id AS mutationId, state,
            created_at AS createdAt, expires_at AS expiresAt,
            decided_at AS decidedAt, receipt_code AS receiptCode
       FROM operator_configuration_draft
      WHERE organisation_id = ? AND draft_id = ?`,
    )
    .bind(organisationId, draftId)
    .first<Record<string, unknown>>();
  return row === null ? null : parseDraftRow(row);
}

function parseDraftRow(
  row: Record<string, unknown>,
): OperatorConfigurationDraft | null {
  const command = parseStoredCommand(row.command);
  if (
    typeof row.draftId !== "string" ||
    typeof row.organisationId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.actorUserId !== "string" ||
    typeof row.actorPersonId !== "string" ||
    typeof row.commandDigest !== "string" ||
    typeof row.mutationId !== "string" ||
    !isDraftState(row.state) ||
    typeof row.createdAt !== "number" ||
    typeof row.expiresAt !== "number" ||
    command === null
  ) {
    return null;
  }
  return {
    draftId: row.draftId,
    organisationId: row.organisationId as OrganisationId,
    caseId: row.caseId,
    actorUserId: row.actorUserId,
    actorPersonId: row.actorPersonId,
    command,
    commandDigest: row.commandDigest,
    mutationId: row.mutationId,
    state: row.state,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: typeof row.decidedAt === "number" ? row.decidedAt : null,
    receiptCode: typeof row.receiptCode === "string" ? row.receiptCode : null,
  };
}

function parseStoredCommand(value: unknown): OperatorDraftCommand | null {
  if (typeof value !== "string") {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = parseDraftCommand(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Reads either family from a request body or a stored row.
 *
 * A body naming an allowance kind is read as one; anything else goes to the
 * agent configuration parser, so the Portal's own command shapes reach a draft
 * unchanged and no caller has to label what it is submitting.
 */
function parseWorkflowChangeCommand(
  raw: unknown,
): WorkflowChangeCommand | null {
  if (!isRecord(raw)) return null;
  const { workflowId, title, baseDigest, proposedDigest, reason } = raw;
  const { sessionId, turnId, operationId } = raw;
  const findings = parseRunFindings(raw.findings);
  const change = parseProposalChangeSummary(raw.change);
  return typeof workflowId === "string" &&
    typeof title === "string" &&
    typeof baseDigest === "string" &&
    typeof proposedDigest === "string" &&
    typeof reason === "string" &&
    typeof sessionId === "string" &&
    typeof turnId === "string" &&
    typeof operationId === "string" &&
    findings !== null &&
    change !== null
    ? {
        workflowId,
        title,
        baseDigest,
        proposedDigest,
        reason,
        findings,
        change,
        sessionId,
        turnId,
        operationId,
      }
    : null;
}

function parseDeviceDraftCommand(raw: unknown): DeviceDraftCommand | null {
  if (!isRecord(raw)) return null;
  const { kind, deviceId, deviceName, reason } = raw;
  if (typeof deviceId !== "string" || typeof deviceName !== "string")
    return null;
  if (kind === "device_resume") return { kind, deviceId, deviceName };
  return kind === "device_restrict" && typeof reason === "string"
    ? { kind, deviceId, deviceName, reason }
    : null;
}

function parseDraftCommand(
  raw: unknown,
): Result<OperatorDraftCommand, OperatorDraftError | AgentOperationsError> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const body = raw as Readonly<Record<string, unknown>>;
    if (body.family === "workflow_change") {
      const change = parseWorkflowChangeCommand(body.change);
      return change === null
        ? {
            ok: false,
            error: { code: "operator_draft_invalid", field: "change" },
          }
        : { ok: true, value: { family: "workflow_change", change } };
    }
    if (body.family === "bake_stock_level") {
      const level = parseBakeStockLevelInput(body.level);
      return level === null
        ? {
            ok: false,
            error: { code: "operator_draft_invalid", field: "level" },
          }
        : { ok: true, value: { family: "bake_stock_level", level } };
    }
    if (body.family === "jev_feature") {
      const command = parseJevDraftCommand(body.command);
      return command === null
        ? {
            ok: false,
            error: { code: "operator_draft_invalid", field: "command" },
          }
        : { ok: true, value: { family: "jev_feature", command } };
    }
    if (body.family === "device_command") {
      const command = parseDeviceDraftCommand(body.command);
      return command === null
        ? {
            ok: false,
            error: { code: "operator_draft_invalid", field: "command" },
          }
        : { ok: true, value: { family: "device_command", command } };
    }
    if (
      body.family === "agent_operation" ||
      body.family === "offer_price_allowance"
    ) {
      return parseDraftCommand(
        body.family === "agent_operation" ? body.operation : body.allowance,
      );
    }
    if (
      body.kind === "set_offer_price_allowance" ||
      body.kind === "withdraw_offer_price_allowance"
    ) {
      const allowance = parseOfferPriceAllowanceCommand(body);
      return allowance.ok
        ? {
            ok: true,
            value: {
              family: "offer_price_allowance",
              allowance: allowance.value,
            },
          }
        : {
            ok: false,
            error: { code: "operator_draft_invalid", field: "allowance" },
          };
    }
  }
  const operation = parseAgentOperationInput(raw);
  return operation.ok
    ? {
        ok: true,
        value: { family: "agent_operation", operation: operation.value },
      }
    : operation;
}

function isDraftState(
  value: unknown,
): value is OperatorConfigurationDraftState {
  return (
    value === "pending" ||
    value === "confirmed" ||
    value === "settled" ||
    value === "cancelled" ||
    value === "expired"
  );
}
