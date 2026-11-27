import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  lowerWorkflowDocument,
  parseWorkflowDocument,
  type BakeryWorkflowDocument,
} from "@purin-labs/bakery-workflow";
import {
  parseRunFindings,
  type RunFinding,
} from "@purin-labs/bakery-workflow/findings";
import { admitScenario } from "@purin-labs/production-simulation";
import { canonicalJson, isRecord, sha256Hex } from "@purin-labs/std";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { KitchenOrganisationActor } from "../actors/organisation-kitchen-rpc";
import type { UserId } from "@purin-labs/control-api/ids";
import type { WorkflowRevisionReceipt } from "@purin-labs/area-kitchen-contract/server/workflow-changes";

/**
 * Plan 84: a recipe's applied workflow. Each revision is immutable in R2 under its
 * own digest, and the regional database holds the index and the receipt. A run
 * pins a revision by digest. Applying needs the digest that the person last saw, so
 * a change that nobody saw cannot be overwritten.
 */
export const MAX_WORKFLOW_DOCUMENT_BYTES = 1024 * 1024;
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export function isBakeryWorkflowId(raw: string): boolean {
  return WORKFLOW_ID.test(raw);
}

export function bakeryWorkflowPrefix(organisationId: OrganisationId): string {
  return `bakery-workflows/${encodeURIComponent(organisationId)}/`;
}

/** What an approved proposal adds to the receipt of its revision. */
type WorkflowRevisionOrigin = Readonly<{
  proposalId: string;
  sessionId: string;
  turnId: string;
  operationId: string;
}>;

type CurrentWorkflow = Readonly<{
  document: BakeryWorkflowDocument;
  receipt: WorkflowRevisionReceipt;
}>;

type RevisionRow = Readonly<{
  revision: number;
  digest: string;
  baseDigest: string | null;
  scenarioDigest: string;
  appliedBy: string;
  appliedAt: number;
  proposalId: string | null;
  sessionId: string | null;
  turnId: string | null;
  operationId: string | null;
}>;

const CURRENT_ROW = `SELECT revision.revision AS revision, revision.digest AS digest,
  revision.base_digest AS baseDigest, revision.scenario_digest AS scenarioDigest,
  revision.applied_by AS appliedBy, revision.applied_at AS appliedAt,
  revision.proposal_id AS proposalId, revision.session_id AS sessionId,
  revision.turn_id AS turnId, revision.operation_id AS operationId
  FROM bakery_workflow AS workflow
  JOIN bakery_workflow_revision AS revision
    ON revision.organisation_id = workflow.organisation_id
   AND revision.workflow_id = workflow.workflow_id
   AND revision.revision = workflow.current_revision
  WHERE workflow.organisation_id = ? AND workflow.workflow_id = ?`;

async function readCurrentRow(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workflowId: string,
): Promise<RevisionRow | null> {
  return db
    .prepare(CURRENT_ROW)
    .bind(organisationId, workflowId)
    .first<RevisionRow>();
}

/** Null when nobody applied this recipe yet. A damaged revision throws. */
export async function readCurrentWorkflow(
  env: Pick<Env, "ARCHIVE">,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workflowId: string,
): Promise<CurrentWorkflow | null> {
  const row = await readCurrentRow(db, organisationId, workflowId);
  if (row === null) return null;
  const object = await env.ARCHIVE.get(
    bakeryWorkflowPrefix(organisationId) + row.digest,
  );
  if (object === null) throw new Error("A workflow revision is missing.");
  const content = await object.text();
  if ((await sha256Hex(content)) !== row.digest)
    throw new Error("A workflow revision does not match its digest.");
  const parsed = parseWorkflowDocument(JSON.parse(content));
  if (!parsed.ok) throw new Error("A workflow revision is invalid.");
  return { document: parsed.value, receipt: { workflowId, ...row } };
}

export type AppliedWorkflowHead = Readonly<{
  workflowId: string;
  title: string;
  revision: number;
  digest: string;
}>;

/**
 * The current revision of a recipe workflow, without its document. A bake
 * proposal names it (Plan 24 S1). Null when nobody applied the recipe yet.
 */
export async function readAppliedWorkflowHead(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workflowId: string,
): Promise<AppliedWorkflowHead | null> {
  const row = await db
    .prepare(
      `SELECT workflow.title AS title, revision.revision AS revision,
              revision.digest AS digest
         FROM bakery_workflow AS workflow
         JOIN bakery_workflow_revision AS revision
           ON revision.organisation_id = workflow.organisation_id
          AND revision.workflow_id = workflow.workflow_id
          AND revision.revision = workflow.current_revision
        WHERE workflow.organisation_id = ? AND workflow.workflow_id = ?`,
    )
    .bind(organisationId, workflowId)
    .first<Readonly<{ title: string; revision: number; digest: string }>>();
  return row === null ? null : { workflowId, ...row };
}

/** A stored document by its digest: a revision or an open proposal. */
export async function readWorkflowDocument(
  env: Pick<Env, "ARCHIVE">,
  organisationId: OrganisationId,
  digest: string,
): Promise<BakeryWorkflowDocument | null> {
  const object = await env.ARCHIVE.get(
    bakeryWorkflowPrefix(organisationId) + digest,
  );
  if (object === null) return null;
  const content = await object.text();
  if ((await sha256Hex(content)) !== digest)
    throw new Error("A workflow document does not match its digest.");
  const parsed = parseWorkflowDocument(JSON.parse(content));
  if (!parsed.ok) throw new Error("A workflow document is invalid.");
  return parsed.value;
}

/** Keeps a proposal's exact content. Nothing that a person or a run uses reads it. */
export async function storeWorkflowDocument(
  env: Pick<Env, "ARCHIVE">,
  organisationId: OrganisationId,
  document: BakeryWorkflowDocument,
): Promise<string> {
  const content = canonicalJson(document);
  const digest = await sha256Hex(content);
  await env.ARCHIVE.put(
    bakeryWorkflowPrefix(organisationId) + digest,
    content,
    { httpMetadata: { contentType: "application/json" } },
  );
  return digest;
}

type AppliedWorkflowEntry = Readonly<{
  workflowId: string;
  recipe: string;
  title: string;
  revision: number;
}>;

export async function listAppliedWorkflows(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly AppliedWorkflowEntry[]> {
  const rows = await db
    .prepare(
      `SELECT workflow_id AS workflowId, recipe, title, current_revision AS revision
         FROM bakery_workflow WHERE organisation_id = ?
        ORDER BY updated_at DESC LIMIT 50`,
    )
    .bind(organisationId)
    .all<AppliedWorkflowEntry>();
  return rows.results ?? [];
}

type WorkflowFindings = Readonly<{
  digest: string;
  ranAt: number;
  findings: readonly RunFinding[];
}>;

function findingsKey(
  organisationId: OrganisationId,
  workflowId: string,
): string {
  return `${bakeryWorkflowPrefix(organisationId)}findings/${workflowId}`;
}

/** The last run of a revision. A newer run replaces it. */
export async function writeWorkflowFindings(
  env: Pick<Env, "ARCHIVE">,
  organisationId: OrganisationId,
  workflowId: string,
  value: WorkflowFindings,
): Promise<void> {
  await env.ARCHIVE.put(
    findingsKey(organisationId, workflowId),
    JSON.stringify(value),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** Findings of another revision say nothing about this one, so they read as none. */
export async function readWorkflowFindings(
  env: Pick<Env, "ARCHIVE">,
  organisationId: OrganisationId,
  workflowId: string,
  digest: string,
): Promise<WorkflowFindings | null> {
  const object = await env.ARCHIVE.get(findingsKey(organisationId, workflowId));
  if (object === null) return null;
  const stored: unknown = JSON.parse(await object.text());
  if (!isRecord(stored) || stored.digest !== digest) return null;
  const findings = parseRunFindings(stored.findings);
  return findings === null || typeof stored.ranAt !== "number"
    ? null
    : { digest, ranAt: stored.ranAt, findings };
}

type ApplyWorkflowOutcome =
  | Readonly<{ kind: "applied"; receipt: WorkflowRevisionReceipt }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{
      kind: "refused";
      problems: readonly Readonly<{ code: string; where: string }>[];
    }>
  | Readonly<{ kind: "stale"; currentDigest: string | null }>;

export async function applyWorkflowRevision(
  env: Pick<Env, "ARCHIVE">,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workflowId: string,
  userId: UserId,
  raw: unknown,
  baseDigest: string | null,
  origin: WorkflowRevisionOrigin | null = null,
): Promise<ApplyWorkflowOutcome> {
  const parsed = parseWorkflowDocument(raw);
  if (!parsed.ok) return { kind: "invalid", message: parsed.error.message };
  const admitted = await admitScenario(lowerWorkflowDocument(parsed.value));
  if (!admitted.ok)
    return {
      kind: "refused",
      problems: admitted.error.map(problemSummary),
    };
  const content = canonicalJson(parsed.value);
  const digest = await sha256Hex(content);
  const current = await readCurrentRow(db, organisationId, workflowId);
  // A lost reply repeats the same apply. It returns the first receipt.
  if (current !== null && current.digest === digest)
    return { kind: "applied", receipt: { workflowId, ...current } };
  if ((current?.digest ?? null) !== baseDigest)
    return { kind: "stale", currentDigest: current?.digest ?? null };
  await env.ARCHIVE.put(
    bakeryWorkflowPrefix(organisationId) + digest,
    content,
    { httpMetadata: { contentType: "application/json" } },
  );
  const revision = (current?.revision ?? 0) + 1;
  const appliedAt = Date.now();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO bakery_workflow
           (organisation_id, workflow_id, recipe, title, current_revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (organisation_id, workflow_id) DO UPDATE SET
           title = excluded.title,
           current_revision = excluded.current_revision,
           updated_at = excluded.updated_at
         WHERE bakery_workflow.current_revision = ?`,
      )
      .bind(
        organisationId,
        workflowId,
        parsed.value.recipe,
        parsed.value.title,
        revision,
        appliedAt,
        revision - 1,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO bakery_workflow_revision
           (organisation_id, workflow_id, revision, digest, base_digest,
            scenario_digest, applied_by, applied_at, proposal_id, session_id,
            turn_id, operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        organisationId,
        workflowId,
        revision,
        digest,
        baseDigest,
        admitted.value.digest,
        userId,
        appliedAt,
        origin?.proposalId ?? null,
        origin?.sessionId ?? null,
        origin?.turnId ?? null,
        origin?.operationId ?? null,
      ),
  ]);
  // Another person applied between the read and this batch.
  if ((results[1]?.meta.changes ?? 0) === 0) {
    const latest = await readCurrentRow(db, organisationId, workflowId);
    return { kind: "stale", currentDigest: latest?.digest ?? null };
  }
  return {
    kind: "applied",
    receipt: {
      workflowId,
      revision,
      digest,
      baseDigest,
      scenarioDigest: admitted.value.digest,
      appliedBy: userId,
      appliedAt,
      proposalId: origin?.proposalId ?? null,
      sessionId: origin?.sessionId ?? null,
      turnId: origin?.turnId ?? null,
      operationId: origin?.operationId ?? null,
    },
  };
}

function problemSummary(
  problem: Readonly<{ code: string; where: string }>,
): Readonly<{ code: string; where: string }> {
  return { code: problem.code, where: problem.where };
}

/**
 * Tells the open Workflow pages of a recipe to read it again, after a new
 * revision or a new proposal is stored. The stored change does not depend on
 * the signal: a lost signal waits for the page's next read, and a failure is
 * traced, not thrown.
 */
export async function signalBakeryWorkflowApplied(
  env: Env,
  organisationId: OrganisationId,
  workflowId: string,
): Promise<void> {
  try {
    const organisation =
      await requireActiveOrganisationActor<KitchenOrganisationActor>({
        env,
        organisationId,
        now: Date.now(),
      });
    await organisation.bakeryWorkflowApplied(workflowId);
  } catch (error) {
    traceWarn("bakery_workflow.applied_signal_failed", {
      requestId: newRequestId(),
      organisationId,
      workflowId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
