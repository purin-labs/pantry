import type { OrganisationDatabase } from "../database-handles";
import {
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  type UnversionedControlMutationBoundary,
  type ControlMutationIdentity,
} from "./control-mutation";
import type { OrganisationEnvironment } from "./control-plane";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { SessionBudget } from "@purin-labs/contracts";
import type { OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "../result";

export type WorkspaceAiBudgetLimits = Pick<
  SessionBudget,
  "maxTokens" | "maxWallMs" | "maxToolCalls"
>;

export const WORKSPACE_AI_BUDGET_MAXIMUM: WorkspaceAiBudgetLimits = {
  maxTokens: 1_000_000,
  maxWallMs: 600_000,
  maxToolCalls: 200,
};

export type WorkspaceAiBudget = Readonly<{
  limits: WorkspaceAiBudgetLimits;
  previousLimits: WorkspaceAiBudgetLimits;
  revision: number;
  activation: "active" | "pending";
  mutationReceiptId: string;
}>;

export function parseWorkspaceAiBudgetLimits(
  value: unknown,
): WorkspaceAiBudgetLimits | null {
  if (typeof value !== "object" || value === null) return null;
  if (!(
    "maxTokens" in value &&
    "maxWallMs" in value &&
    "maxToolCalls" in value
  ))
    return null;
  if (
    Object.keys(value).length !== 3 ||
    !bounded(value.maxTokens, WORKSPACE_AI_BUDGET_MAXIMUM.maxTokens) ||
    !bounded(value.maxWallMs, WORKSPACE_AI_BUDGET_MAXIMUM.maxWallMs) ||
    value.maxWallMs % 1000 !== 0 ||
    !bounded(value.maxToolCalls, WORKSPACE_AI_BUDGET_MAXIMUM.maxToolCalls)
  )
    return null;
  return {
    maxTokens: value.maxTokens,
    maxWallMs: value.maxWallMs,
    maxToolCalls: value.maxToolCalls,
  };
}

function bounded(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

export async function readWorkspaceAiBudget(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<WorkspaceAiBudget, "workspace_ai_budget_unavailable">> {
  try {
    const row = await db
      .prepare(
        `SELECT max_tokens, max_wall_ms, max_tool_calls, revision, applied_revision, mutation_receipt_id, previous_limits_json FROM workspace_ai_budget WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<Record<string, unknown>>();
    if (row === null)
      return { ok: false, error: "workspace_ai_budget_unavailable" };
    const limits = parseWorkspaceAiBudgetLimits({
      maxTokens: row.max_tokens,
      maxWallMs: row.max_wall_ms,
      maxToolCalls: row.max_tool_calls,
    });
    const previousLimits =
      typeof row.previous_limits_json === "string"
        ? parseWorkspaceAiBudgetLimits(JSON.parse(row.previous_limits_json))
        : null;
    if (
      limits === null ||
      previousLimits === null ||
      !bounded(row.revision, Number.MAX_SAFE_INTEGER) ||
      typeof row.applied_revision !== "number" ||
      row.applied_revision < 0 ||
      row.applied_revision > row.revision ||
      typeof row.mutation_receipt_id !== "string"
    )
      return { ok: false, error: "workspace_ai_budget_unavailable" };
    return {
      ok: true,
      value: {
        limits,
        previousLimits,
        revision: row.revision,
        activation:
          row.applied_revision === row.revision ? "active" : "pending",
        mutationReceiptId: row.mutation_receipt_id,
      },
    };
  } catch {
    return { ok: false, error: "workspace_ai_budget_unavailable" };
  }
}

export async function changeWorkspaceAiBudget(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    limits: WorkspaceAiBudgetLimits;
    expectedRevision: number;
    mutationReceiptId: string;
    now: number;
  }>,
): Promise<
  Result<
    WorkspaceAiBudget,
    "workspace_ai_budget_unavailable" | "workspace_ai_budget_conflict"
  >
> {
  if (!(await input.scope.isActive())) {
    return { ok: false, error: "workspace_ai_budget_unavailable" };
  }
  const current = await readWorkspaceAiBudget(
    input.scope.database,
    input.scope.organisationId,
  );
  if (!current.ok) return current;
  if (current.value.mutationReceiptId === input.mutationReceiptId) {
    return current.value.revision === input.expectedRevision + 1 &&
      current.value.limits.maxTokens === input.limits.maxTokens &&
      current.value.limits.maxWallMs === input.limits.maxWallMs &&
      current.value.limits.maxToolCalls === input.limits.maxToolCalls
      ? current
      : { ok: false, error: "workspace_ai_budget_conflict" };
  }
  if (current.value.revision !== input.expectedRevision)
    return { ok: false, error: "workspace_ai_budget_conflict" };
  await input.scope.database
    .prepare(
      `UPDATE workspace_ai_budget SET previous_limits_json = json_object('maxTokens', max_tokens, 'maxWallMs', max_wall_ms, 'maxToolCalls', max_tool_calls), max_tokens = ?, max_wall_ms = ?, max_tool_calls = ?, revision = revision + 1, mutation_receipt_id = ?, updated_at = ? WHERE organisation_id = ? AND revision = ?
       AND EXISTS (
         SELECT 1 FROM organisation_placement WHERE organisation_id = workspace_ai_budget.organisation_id
           AND placement_epoch = ? AND placement_cell_id = ?
           AND fence_token = ? AND status = 'active'
       )`,
    )
    .bind(
      input.limits.maxTokens,
      input.limits.maxWallMs,
      input.limits.maxToolCalls,
      input.mutationReceiptId,
      input.now,
      input.scope.organisationId,
      input.expectedRevision,
      input.scope.placement.placementEpoch,
      input.scope.placement.placementCellId,
      input.scope.fenceToken,
    )
    .run();
  const changed = await readWorkspaceAiBudget(
    input.scope.database,
    input.scope.organisationId,
  );
  if (!changed.ok) return changed;
  return changed.value.mutationReceiptId === input.mutationReceiptId
    ? changed
    : { ok: false, error: "workspace_ai_budget_conflict" };
}

export async function settleWorkspaceAiBudget(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    budget: WorkspaceAiBudget;
    userId: UserId;
    boundary: UnversionedControlMutationBoundary;
    identity: ControlMutationIdentity;
    environment: OrganisationEnvironment;
    configurationVersion: number;
    projectionRevision: number;
  }>,
): Promise<
  Result<
    Readonly<{
      ok: true;
      limits: WorkspaceAiBudgetLimits;
      revision: number;
      previousLimits: WorkspaceAiBudgetLimits;
      activation: "active";
    }>,
    "workspace_ai_budget_conflict"
  >
> {
  if (input.budget.mutationReceiptId !== input.identity.receiptId) {
    return { ok: false, error: "workspace_ai_budget_conflict" };
  }
  const responseBody = {
    ok: true as const,
    limits: input.budget.limits,
    revision: input.budget.revision,
    previousLimits: input.budget.previousLimits,
    activation: "active" as const,
  };
  const session = input.scope.database.withSession("first-primary");
  // Receipt and audit writes depend on the fenced activation in this batch.
  // A later SQL failure rolls back all three writes, leaving activation pending.
  const results = await session.batch([
    session
      .prepare(
        `UPDATE workspace_ai_budget SET applied_revision = revision
       WHERE organisation_id = ? AND revision = ? AND mutation_receipt_id = ?
         AND EXISTS (
           SELECT 1 FROM organisation_placement WHERE organisation_id = workspace_ai_budget.organisation_id
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active'
         )`,
      )
      .bind(
        input.scope.organisationId,
        input.budget.revision,
        input.identity.receiptId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      ),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: {
        userId: input.userId,
        organisationScope: input.scope.organisationId,
        route: `/v1/control/organisations/${input.scope.organisationId}/access-control/ai-budget`,
        operation: "access_control.budget.change",
      },
      boundary: input.boundary,
      identity: input.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.identity, {
      organisationId: input.scope.organisationId,
      environment: input.environment,
      actorUserId: input.userId,
      operation: "access_control.budget.change",
      targetKind: "workspace_ai_budget",
      targetId: input.scope.organisationId,
      oldLifecycle: null,
      newLifecycle: "active",
      configurationVersion: input.configurationVersion,
      projectionRevision: input.projectionRevision,
      reasonCode: "operator_changed_ai_budget",
    }),
  ]);
  return results.every(settlementWriteCommitted)
    ? { ok: true, value: responseBody }
    : { ok: false, error: "workspace_ai_budget_conflict" };
}

function settlementWriteCommitted(result: D1Result): boolean {
  return result.meta.changes === 1;
}
