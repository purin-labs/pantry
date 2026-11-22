// The agent's proposals to save a bakery run, and the person's approvals.

type Database = Pick<D1Database, "prepare">;

type AgentProposalRow = Readonly<{
  effectJson: string;
  receiptJson: string;
  updatedAt: number;
}>;

export type AgentApprovalRow = Readonly<{
  organisationId: string;
  userId: string;
  contentId: string;
  name: string;
  stateKind: "approved" | "saved";
  summaryJson: string | null;
}>;

/** The settled surface effect that proposed the save, or null. */
export function readSettledAgentSaveProposal(
  db: Database,
  input: Readonly<{ effectId: string; organisationId: string; userId: string }>,
): Promise<AgentProposalRow | null> {
  return db
    .prepare(
      `SELECT effect_json AS effectJson, receipt_json AS receiptJson,
              updated_at AS updatedAt
       FROM bakery_surface_effect_delivery
       WHERE effect_id = ? AND organisation_id = ? AND user_id = ?
         AND state_kind = 'settled'`,
    )
    .bind(input.effectId, input.organisationId, input.userId)
    .first<AgentProposalRow>();
}

/** Records the approval once; a second approval of the effect changes nothing. */
export async function insertAgentRunSaveApproval(
  db: Database,
  input: Readonly<{
    effectId: string;
    organisationId: string;
    userId: string;
    contentId: string;
    name: string;
    approvedAt: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bakery_agent_run_save (
         effect_id, organisation_id, user_id, content_id, name,
         state_kind, summary_json, approved_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'approved', NULL, ?, ?)
       ON CONFLICT(effect_id) DO NOTHING`,
    )
    .bind(
      input.effectId,
      input.organisationId,
      input.userId,
      input.contentId,
      input.name,
      input.approvedAt,
      input.approvedAt,
    )
    .run();
}

/** Marks an approved save as saved, with the saved run's summary. */
export async function markAgentRunSaved(
  db: Database,
  input: Readonly<{
    effectId: string;
    organisationId: string;
    userId: string;
    contentId: string;
    name: string;
    summaryJson: string;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE bakery_agent_run_save
       SET state_kind = 'saved', summary_json = ?, updated_at = ?
       WHERE effect_id = ? AND organisation_id = ? AND user_id = ?
         AND content_id = ? AND name = ? AND state_kind = 'approved'`,
    )
    .bind(
      input.summaryJson,
      input.now,
      input.effectId,
      input.organisationId,
      input.userId,
      input.contentId,
      input.name,
    )
    .run();
}

export function readAgentApproval(
  db: Database,
  effectId: string,
): Promise<AgentApprovalRow | null> {
  return db
    .prepare(
      `SELECT organisation_id AS organisationId, user_id AS userId,
              content_id AS contentId, name, state_kind AS stateKind,
              summary_json AS summaryJson
       FROM bakery_agent_run_save WHERE effect_id = ?`,
    )
    .bind(effectId)
    .first<AgentApprovalRow>();
}
