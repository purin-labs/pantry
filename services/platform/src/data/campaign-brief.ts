import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * A drafted marketing campaign, staged for a person to review.
 *
 * A brief is a document, not an instruction to anything. Accepting one records
 * the reviewed text in its Case: it sends no message, selects no provider
 * audience, spends no budget, and changes no commerce fact. There is
 * deliberately no execute path here for an approval to reach.
 */
type CampaignBriefLifecycle = "draft" | "accepted" | "dismissed" | "expired";

/** One commerce record the campaign is about, at the revision Sous Chef observed. */
type CampaignBriefTarget = Readonly<{
  entityType: "product" | "sellable_variant" | "offer";
  entityId: string;
  revision: number;
}>;

/** One proposed message, kept separate so a reviewer can accept or cut each. */
export type CampaignMessageVariant = Readonly<{
  variantId: string;
  headline: string;
  body: string;
}>;

type CampaignBrief = Readonly<{
  briefId: string;
  organisationId: OrganisationId;
  merchantId: string;
  caseId: string;
  objective: string;
  targets: readonly CampaignBriefTarget[];
  /** Where it would run and who it would reach, in words. No audience is selected. */
  channel: string;
  audienceDescription: string;
  messageVariants: readonly CampaignMessageVariant[];
  /** What the merchant would be asked to spend. Nothing is committed. */
  requestedBudgetMinor: number;
  currency: string;
  windowStart: string;
  windowEnd: string;
  /** Disclosures and merchant constraints the copy has to carry. */
  disclosures: readonly string[];
  /** Why this campaign, traced to what Sous Chef read. */
  supportingEvidence: string;
  lifecycle: CampaignBriefLifecycle;
  proposedAt: number;
  decidedAt: number | null;
  decidedByPersonId: string | null;
  expiresAt: number;
  revision: number;
}>;

type CampaignBriefError =
  | Readonly<{ code: "campaign_brief_authority_inactive" }>
  | Readonly<{ code: "campaign_brief_invalid"; field: string }>
  | Readonly<{ code: "campaign_brief_conflict"; field: string }>
  | Readonly<{ code: "campaign_brief_not_found" }>
  | Readonly<{ code: "campaign_brief_persistence_failed" }>;

const TEXT_MAX = 4_000;
const MAX_TARGETS = 25;
const MAX_VARIANTS = 5;

export type ProposeCampaignBriefInput = Readonly<{
  scope: OrganisationExecutionScope;
  authorizeCommit: () => Promise<void>;
  briefId: string;
  merchantId: string;
  caseId: string;
  objective: string;
  targets: readonly CampaignBriefTarget[];
  channel: string;
  audienceDescription: string;
  messageVariants: readonly CampaignMessageVariant[];
  requestedBudgetMinor: number;
  currency: string;
  windowStart: string;
  windowEnd: string;
  disclosures: readonly string[];
  supportingEvidence: string;
  expiresAt: number;
  now: number;
}>;

/**
 * Stages one campaign brief for review.
 *
 * Every target must name a record and revision; the caller checks those
 * against what the session observed before calling, the same rule executable
 * proposals follow. A brief with no target would describe a campaign about
 * nothing.
 */
export async function proposeCampaignBrief(
  input: ProposeCampaignBriefInput,
): Promise<Result<CampaignBrief, CampaignBriefError>> {
  await input.authorizeCommit();
  const objective = boundedText(input.objective);
  if (objective === null) return invalid("objective");
  const channel = boundedText(input.channel);
  if (channel === null) return invalid("channel");
  const audienceDescription = boundedText(input.audienceDescription);
  if (audienceDescription === null) return invalid("audienceDescription");
  const supportingEvidence = boundedText(input.supportingEvidence);
  if (supportingEvidence === null) return invalid("supportingEvidence");
  if (input.targets.length === 0 || input.targets.length > MAX_TARGETS)
    return invalid("targets");
  if (
    input.targets.some(
      (target) => target.entityId.length === 0 || target.revision <= 0,
    )
  ) {
    return invalid("targets");
  }
  if (
    input.messageVariants.length === 0 ||
    input.messageVariants.length > MAX_VARIANTS
  ) {
    return invalid("messageVariants");
  }
  if (
    input.messageVariants.some(
      (variant) =>
        boundedText(variant.headline) === null ||
        boundedText(variant.body) === null,
    )
  ) {
    return invalid("messageVariants");
  }
  if (
    !Number.isSafeInteger(input.requestedBudgetMinor) ||
    input.requestedBudgetMinor < 0
  ) {
    return invalid("requestedBudgetMinor");
  }
  if (!/^[A-Z]{3}$/u.test(input.currency)) return invalid("currency");
  const windowStart = Date.parse(input.windowStart);
  const windowEnd = Date.parse(input.windowEnd);
  if (
    Number.isNaN(windowStart) ||
    Number.isNaN(windowEnd) ||
    windowEnd <= windowStart
  ) {
    return invalid("window");
  }
  if (input.expiresAt <= input.now) return invalid("expiresAt");

  const brief: CampaignBrief = {
    briefId: input.briefId,
    organisationId: input.scope.organisationId,
    merchantId: input.merchantId,
    caseId: input.caseId,
    objective,
    targets: input.targets,
    channel,
    audienceDescription,
    messageVariants: input.messageVariants,
    requestedBudgetMinor: input.requestedBudgetMinor,
    currency: input.currency,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    disclosures: input.disclosures.filter(
      (entry) => boundedText(entry) !== null,
    ),
    supportingEvidence,
    lifecycle: "draft",
    proposedAt: input.now,
    decidedAt: null,
    decidedByPersonId: null,
    expiresAt: input.expiresAt,
    revision: 1,
  };
  await input.authorizeCommit();
  try {
    const written = await input.scope.database
      .prepare(
        `INSERT INTO campaign_brief (
         brief_id, organisation_id, merchant_id, case_id, objective, targets_json,
         channel, audience_description, message_variants_json,
         requested_budget_minor, currency, window_start, window_end,
         disclosures_json, supporting_evidence, lifecycle, proposed_at,
         decided_at, decided_by_person_id, expires_at, revision
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, ?, 1
       WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ?
         AND fence_token = ? AND status = 'active')`,
      )
      .bind(
        brief.briefId,
        brief.organisationId,
        brief.merchantId,
        brief.caseId,
        brief.objective,
        JSON.stringify(brief.targets),
        brief.channel,
        brief.audienceDescription,
        JSON.stringify(brief.messageVariants),
        brief.requestedBudgetMinor,
        brief.currency,
        brief.windowStart,
        brief.windowEnd,
        JSON.stringify(brief.disclosures),
        brief.supportingEvidence,
        brief.proposedAt,
        brief.expiresAt,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      )
      .run();
    if (written.meta.changes !== 1)
      return {
        ok: false,
        error: { code: "campaign_brief_authority_inactive" },
      };
  } catch (error) {
    return constraintFailure(error)
      ? {
          ok: false,
          error: { code: "campaign_brief_conflict", field: "briefId" },
        }
      : { ok: false, error: { code: "campaign_brief_persistence_failed" } };
  }
  await input.authorizeCommit();
  return { ok: true, value: brief };
}

type CampaignBriefDecision = "accepted" | "dismissed";

/**
 * Records a person's decision on one brief.
 *
 * Acceptance is a review record and nothing more. It reaches no provider,
 * because none is wired to this table.
 */
export async function decideCampaignBrief(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    briefId: string;
    expectedRevision: number;
    decision: CampaignBriefDecision;
    decidedByPersonId: string;
    /** The reviewer's edit of the brief, when they changed it before accepting. */
    editedObjective: string | null;
    editedMessageVariants: readonly CampaignMessageVariant[] | null;
    now: number;
  }>,
): Promise<Result<true, CampaignBriefError>> {
  if (input.decidedByPersonId.length === 0) return invalid("decidedByPersonId");
  const objective =
    input.editedObjective === null ? null : boundedText(input.editedObjective);
  if (input.editedObjective !== null && objective === null)
    return invalid("editedObjective");
  const variants = input.editedMessageVariants;
  if (
    variants !== null &&
    (variants.length === 0 ||
      variants.length > MAX_VARIANTS ||
      variants.some(
        (variant) =>
          boundedText(variant.headline) === null ||
          boundedText(variant.body) === null,
      ))
  ) {
    return invalid("editedMessageVariants");
  }
  const updated = await input.db
    .prepare(
      `UPDATE campaign_brief
        SET lifecycle = ?,
            decided_at = ?,
            decided_by_person_id = ?,
            objective = COALESCE(?, objective),
            message_variants_json = COALESCE(?, message_variants_json),
            revision = revision + 1
      WHERE brief_id = ? AND organisation_id = ?
        AND lifecycle = 'draft' AND revision = ? AND expires_at > ?`,
    )
    .bind(
      input.decision,
      input.now,
      input.decidedByPersonId,
      objective,
      variants === null ? null : JSON.stringify(variants),
      input.briefId,
      input.organisationId,
      input.expectedRevision,
      input.now,
    )
    .run();
  if (updated.meta.changes === 0) {
    const present = await input.db
      .prepare(
        `SELECT lifecycle, expires_at AS expiresAt FROM campaign_brief
        WHERE brief_id = ? AND organisation_id = ?`,
      )
      .bind(input.briefId, input.organisationId)
      .first<{
        readonly lifecycle: unknown;
        readonly expiresAt: unknown;
      }>();
    if (present === null)
      return { ok: false, error: { code: "campaign_brief_not_found" } };
    if (present.lifecycle !== "draft") {
      return {
        ok: false,
        error: { code: "campaign_brief_conflict", field: "lifecycle" },
      };
    }
    if (
      typeof present.expiresAt === "number" &&
      present.expiresAt <= input.now
    ) {
      return {
        ok: false,
        error: { code: "campaign_brief_conflict", field: "expiresAt" },
      };
    }
    return {
      ok: false,
      error: { code: "campaign_brief_conflict", field: "expectedRevision" },
    };
  }
  return { ok: true, value: true };
}

/** Every brief in one Case, newest first, for the operator to review. */
export async function listCaseCampaignBriefs(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseId: string;
    now: number;
  }>,
): Promise<readonly CampaignBrief[]> {
  const rows = (
    await input.db
      .prepare(
        `SELECT brief_id AS briefId, organisation_id AS organisationId, merchant_id AS merchantId,
            case_id AS caseId, objective, targets_json AS targets, channel,
            audience_description AS audienceDescription,
            message_variants_json AS messageVariants,
            requested_budget_minor AS requestedBudgetMinor, currency,
            window_start AS windowStart, window_end AS windowEnd,
            disclosures_json AS disclosures, supporting_evidence AS supportingEvidence,
            lifecycle, proposed_at AS proposedAt, decided_at AS decidedAt,
            decided_by_person_id AS decidedByPersonId, expires_at AS expiresAt, revision
       FROM campaign_brief
      WHERE organisation_id = ? AND case_id = ?
      ORDER BY proposed_at DESC, brief_id`,
      )
      .bind(input.organisationId, input.caseId)
      .all<Record<string, unknown>>()
  ).results;
  return rows.flatMap((row) => {
    const brief = parseBriefRow(row);
    if (brief === null) return [];
    // An undecided brief past its window is expired, whether or not a sweep
    // has run; showing it as still open would invite a stale decision.
    return brief.lifecycle === "draft" && brief.expiresAt <= input.now
      ? [{ ...brief, lifecycle: "expired" as const }]
      : [brief];
  });
}

function boundedText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > TEXT_MAX ? null : trimmed;
}

function parseBriefRow(row: Record<string, unknown>): CampaignBrief | null {
  const targets = parseTargets(row.targets);
  const messageVariants = parseVariants(row.messageVariants);
  const disclosures = parseStrings(row.disclosures);
  if (
    typeof row.briefId !== "string" ||
    typeof row.organisationId !== "string" ||
    typeof row.merchantId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.objective !== "string" ||
    typeof row.channel !== "string" ||
    typeof row.audienceDescription !== "string" ||
    typeof row.requestedBudgetMinor !== "number" ||
    typeof row.currency !== "string" ||
    typeof row.windowStart !== "string" ||
    typeof row.windowEnd !== "string" ||
    typeof row.supportingEvidence !== "string" ||
    !isLifecycle(row.lifecycle) ||
    typeof row.proposedAt !== "number" ||
    typeof row.expiresAt !== "number" ||
    typeof row.revision !== "number" ||
    targets === null ||
    messageVariants === null ||
    disclosures === null
  ) {
    return null;
  }
  return {
    briefId: row.briefId,
    organisationId: row.organisationId as OrganisationId,
    merchantId: row.merchantId,
    caseId: row.caseId,
    objective: row.objective,
    targets,
    channel: row.channel,
    audienceDescription: row.audienceDescription,
    messageVariants,
    requestedBudgetMinor: row.requestedBudgetMinor,
    currency: row.currency,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    disclosures,
    supportingEvidence: row.supportingEvidence,
    lifecycle: row.lifecycle,
    proposedAt: row.proposedAt,
    decidedAt: typeof row.decidedAt === "number" ? row.decidedAt : null,
    decidedByPersonId:
      typeof row.decidedByPersonId === "string" ? row.decidedByPersonId : null,
    expiresAt: row.expiresAt,
    revision: row.revision,
  };
}

function isLifecycle(value: unknown): value is CampaignBriefLifecycle {
  return (
    value === "draft" ||
    value === "accepted" ||
    value === "dismissed" ||
    value === "expired"
  );
}

function parseTargets(value: unknown): readonly CampaignBriefTarget[] | null {
  const parsed = parseJsonArray(value);
  if (parsed === null) return null;
  const targets: CampaignBriefTarget[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    const entityType = record.entityType;
    if (
      entityType !== "product" &&
      entityType !== "sellable_variant" &&
      entityType !== "offer"
    ) {
      return null;
    }
    if (
      typeof record.entityId !== "string" ||
      typeof record.revision !== "number"
    )
      return null;
    targets.push({
      entityType,
      entityId: record.entityId,
      revision: record.revision,
    });
  }
  return targets;
}

function parseVariants(
  value: unknown,
): readonly CampaignMessageVariant[] | null {
  const parsed = parseJsonArray(value);
  if (parsed === null) return null;
  const variants: CampaignMessageVariant[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.variantId !== "string" ||
      typeof record.headline !== "string" ||
      typeof record.body !== "string"
    ) {
      return null;
    }
    variants.push({
      variantId: record.variantId,
      headline: record.headline,
      body: record.body,
    });
  }
  return variants;
}

function parseStrings(value: unknown): readonly string[] | null {
  const parsed = parseJsonArray(value);
  if (parsed === null) return null;
  return parsed.every((entry) => typeof entry === "string")
    ? (parsed as string[])
    : null;
}

function parseJsonArray(value: unknown): readonly unknown[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function invalid(field: string): Result<never, CampaignBriefError> {
  return { ok: false, error: { code: "campaign_brief_invalid", field } };
}

function constraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /constraint|unique|primary key/i.test(error.message)
  );
}
