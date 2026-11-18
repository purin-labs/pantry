import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId, UserId } from "../ids";
import type { Result } from "../result";
import type { OrganisationQuerySource } from "./query-source";
import { isRecord } from "@seams/std";
import { isChatEffort, type ChatEffort } from "@seams/control-api";

export type OrganisationInferenceSelection =
  | { readonly kind: "claude_oauth" }
  | { readonly kind: "codex_subscription" }
  | { readonly kind: "organisation_openai_api_key" }
  | { readonly kind: "organisation_anthropic_api_key" }
  | { readonly kind: "satyr_platform" };

type OrganisationInferenceSelectionSnapshot = {
  readonly organisationId: OrganisationId;
  readonly selection: OrganisationInferenceSelection;
  /** The level that an owner or admin chose for Slack answers, if any. */
  readonly slackReasoningEffort: ChatEffort | null;
  readonly configurationVersion: number;
};

export type OrganisationInferenceSelectionError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "configuration_version_conflict" }
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    };

type SelectionRow = {
  readonly selectionKind: unknown;
  readonly slackReasoningEffort: unknown;
  readonly configurationVersion: unknown;
};

type OrganisationStateRow = {
  readonly lifecycle: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

export function parseOrganisationInferenceSelection(
  raw: unknown,
): Result<
  OrganisationInferenceSelection,
  { readonly code: "inference_selection_invalid" }
> {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof raw.kind !== "string"
  ) {
    return { ok: false, error: { code: "inference_selection_invalid" } };
  }
  switch (raw.kind) {
    case "claude_oauth":
    case "codex_subscription":
      return { ok: true, value: { kind: raw.kind } };
    case "organisation_openai_api_key":
      return { ok: true, value: { kind: raw.kind } };
    case "organisation_anthropic_api_key":
      return { ok: true, value: { kind: raw.kind } };
    case "satyr_platform":
      return { ok: true, value: { kind: raw.kind } };
    default:
      return { ok: false, error: { code: "inference_selection_invalid" } };
  }
}

export async function readOrganisationInferenceSelection(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<OrganisationInferenceSelectionSnapshot | null> {
  const row = await input.db
    .prepare(
      `SELECT inference.selection_kind AS selectionKind,
            slack.effort AS slackReasoningEffort,
            onboarding.configuration_version AS configurationVersion
     FROM organisation_onboarding AS onboarding
     LEFT JOIN organisation_inference_selection AS inference
       ON inference.organisation_id = onboarding.organisation_id
     LEFT JOIN organisation_slack_reasoning_effort AS slack
       ON slack.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<SelectionRow>();
  if (row === null) return null;
  const selection =
    row.selectionKind === null
      ? defaultOrganisationInferenceSelection()
      : requirePersistedOrganisationInferenceSelection(row.selectionKind);
  return {
    organisationId: input.organisationId,
    selection,
    slackReasoningEffort: requirePersistedSlackReasoningEffort(
      row.slackReasoningEffort,
    ),
    configurationVersion: requirePositiveInteger(
      row.configurationVersion,
      "organisation inference configuration version",
    ),
  };
}

/**
 * Stores the level for Slack answers, or removes the choice when `effort` is
 * null. It is a preference of the organisation, not part of its setup, so it
 * leaves the configuration version and the readiness as they are. The last
 * write wins. The caller runs the statement in one batch with its receipt.
 */
export function prepareOrganisationSlackReasoningEffortWrite(
  db: OrganisationQuerySource,
  input: {
    readonly organisationId: OrganisationId;
    readonly effort: ChatEffort | null;
    readonly selectedByUserId: UserId;
    readonly now: number;
  },
): D1PreparedStatement {
  if (input.effort === null)
    return db
      .prepare(
        `DELETE FROM organisation_slack_reasoning_effort WHERE organisation_id = ?`,
      )
      .bind(input.organisationId);
  return db
    .prepare(
      `INSERT INTO organisation_slack_reasoning_effort (
         organisation_id, effort, selected_by_user_id, selected_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         effort = excluded.effort,
         selected_by_user_id = excluded.selected_by_user_id,
         selected_at = excluded.selected_at`,
    )
    .bind(
      input.organisationId,
      input.effort,
      input.selectedByUserId,
      input.now,
    );
}

export async function selectOrganisationInferenceSelection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly selection: OrganisationInferenceSelection;
  readonly expectedConfigurationVersion: number;
  readonly selectedByUserId: UserId;
  readonly now: number;
}): Promise<
  Result<
    Omit<OrganisationInferenceSelectionSnapshot, "slackReasoningEffort">,
    OrganisationInferenceSelectionError
  >
> {
  const current = await input.db
    .prepare(
      `SELECT lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<OrganisationStateRow>();
  if (current === null)
    return { ok: false, error: { code: "organisation_not_found" } };
  const configurationVersion = requirePositiveInteger(
    current.configurationVersion,
    "organisation inference configuration version",
  );
  if (configurationVersion !== input.expectedConfigurationVersion) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (typeof current.lifecycle !== "string") {
    throw new Error("organisation inference lifecycle is invalid");
  }
  if (
    current.lifecycle === "activating" ||
    current.lifecycle === "suspended" ||
    current.lifecycle === "archived" ||
    current.lifecycle === "purging" ||
    current.lifecycle === "purged"
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: current.lifecycle,
      },
    };
  }
  const projectionRevision = requirePositiveInteger(
    current.projectionRevision,
    "organisation inference projection revision",
  );
  const nextConfigurationVersion = configurationVersion + 1;
  const nextProjectionRevision = projectionRevision + 1;
  const session = input.db.withSession("first-primary");
  const invalidateReadiness = current.lifecycle !== "active";
  const statements = [
    session
      .prepare(
        `INSERT INTO organisation_inference_selection (
         organisation_id, selection_kind, selected_by_user_id, selected_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         selection_kind = excluded.selection_kind,
         selected_by_user_id = excluded.selected_by_user_id,
         selected_at = excluded.selected_at`,
      )
      .bind(
        input.organisationId,
        input.selection.kind,
        input.selectedByUserId,
        input.now,
      ),
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET configuration_version = ?, projection_revision = ?,
           readiness_version = CASE WHEN ? = 1 THEN NULL ELSE readiness_version END,
           activation_attempt_id = CASE WHEN ? = 1 THEN NULL ELSE activation_attempt_id END,
           activation_receipt_id = CASE WHEN ? = 1 THEN NULL ELSE activation_receipt_id END,
           activated_at = CASE WHEN ? = 1 THEN NULL ELSE activated_at END,
           updated_at = ?
       WHERE organisation_id = ? AND configuration_version = ?`,
      )
      .bind(
        nextConfigurationVersion,
        nextProjectionRevision,
        invalidateReadiness ? 1 : 0,
        invalidateReadiness ? 1 : 0,
        invalidateReadiness ? 1 : 0,
        invalidateReadiness ? 1 : 0,
        input.now,
        input.organisationId,
        configurationVersion,
      ),
  ];
  const results = await session.batch(statements);
  if (results[1]?.meta.changes !== 1) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      selection: input.selection,
      configurationVersion: nextConfigurationVersion,
    },
  };
}

function defaultOrganisationInferenceSelection(): OrganisationInferenceSelection {
  return { kind: "codex_subscription" };
}

function requirePersistedOrganisationInferenceSelection(
  raw: unknown,
): OrganisationInferenceSelection {
  const parsed = parseOrganisationInferenceSelection({ kind: raw });
  if (!parsed.ok)
    throw new Error("organisation inference selection is invalid");
  return parsed.value;
}

function requirePersistedSlackReasoningEffort(raw: unknown): ChatEffort | null {
  if (raw === null) return null;
  if (!isChatEffort(raw))
    throw new Error("organisation Slack reasoning effort is invalid");
  return raw;
}

function requirePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}
