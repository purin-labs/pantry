import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  BakeDecidedVia,
  BakeDeciderRole,
  BakeProposal,
  BakeProposalState,
} from "@purin-labs/area-kitchen-contract/server/bake-proposals";

/**
 * The records of Plan 24 S1: the stock level of each fresh product and the
 * bake proposals. This module is the one writer of `bake_stock_level` and of
 * `bake_proposal.state` (see `bake-proposal.machine.ts`). The two partial
 * unique indexes of `bake_proposal` hold the rule "one active proposal and
 * one waiting proposal for each product"; each write here also checks it, so
 * a second writer at the same time loses its write and changes nothing.
 */

export type BakeStockLevel = Readonly<{
  inventoryItemId: string;
  productName: string;
  levelPieces: number;
  piecesPerGroup: number;
  workflowId: string;
  kitchenLocation: string;
  revision: number;
  setBy: string;
  setAt: number;
}>;

export type {
  BakeDecidedVia,
  BakeDeciderRole,
  BakeProposal,
} from "@purin-labs/area-kitchen-contract/server/bake-proposals";

/** What a new proposal holds before it has a state. */
export type BakeProposalDraft = Omit<
  BakeProposal,
  "state" | "openedAt" | "announcedAt" | "decision" | "endedAt" | "endReason"
>;

type LevelRow = Readonly<{
  inventory_item_id: string;
  product_name: string;
  level_pieces: number;
  pieces_per_group: number;
  workflow_id: string;
  kitchen_location: string;
  revision: number;
  set_by: string;
  set_at: number;
}>;

type ProposalRow = Readonly<{
  proposal_id: string;
  inventory_item_id: string;
  product_name: string;
  state: BakeProposalState;
  origin: "stock" | "agent";
  case_id: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  quantity_pieces: number;
  mould_groups: number;
  pieces_per_group: number;
  kitchen_location: string;
  oven_device_id: string | null;
  oven_name: string | null;
  stock_location_id: string | null;
  stock_available: number;
  stock_level: number;
  proposed_by: string;
  proposed_at: number;
  opened_at: number | null;
  announced_at: number | null;
  decided_by: string | null;
  decided_role: BakeDeciderRole | null;
  decided_via: BakeDecidedVia | null;
  decided_at: number | null;
  reason: string | null;
  ended_at: number | null;
  end_reason: string | null;
}>;

const LEVEL_COLUMNS = `inventory_item_id, product_name, level_pieces,
  pieces_per_group, workflow_id, kitchen_location, revision, set_by, set_at`;
const PROPOSAL_COLUMNS = `proposal_id, inventory_item_id, product_name, state,
  origin, case_id, workflow_id, workflow_revision, workflow_digest,
  quantity_pieces, mould_groups, pieces_per_group, kitchen_location,
  oven_device_id, oven_name, stock_location_id, stock_available, stock_level,
  proposed_by, proposed_at, opened_at, announced_at, decided_by, decided_role,
  decided_via, decided_at, reason, ended_at, end_reason`;
const ACTIVE = `state IN ('open', 'approved')`;

function levelFromRow(row: LevelRow): BakeStockLevel {
  return {
    inventoryItemId: row.inventory_item_id,
    productName: row.product_name,
    levelPieces: row.level_pieces,
    piecesPerGroup: row.pieces_per_group,
    workflowId: row.workflow_id,
    kitchenLocation: row.kitchen_location,
    revision: row.revision,
    setBy: row.set_by,
    setAt: row.set_at,
  };
}

function proposalFromRow(row: ProposalRow): BakeProposal {
  return {
    proposalId: row.proposal_id,
    inventoryItemId: row.inventory_item_id,
    productName: row.product_name,
    state: row.state,
    origin: row.origin,
    caseId: row.case_id,
    workflowId: row.workflow_id,
    workflowRevision: row.workflow_revision,
    workflowDigest: row.workflow_digest,
    quantityPieces: row.quantity_pieces,
    mouldGroups: row.mould_groups,
    piecesPerGroup: row.pieces_per_group,
    kitchenLocation: row.kitchen_location,
    oven:
      row.oven_device_id === null || row.oven_name === null
        ? null
        : { deviceId: row.oven_device_id, name: row.oven_name },
    stockLocationId: row.stock_location_id,
    stockAvailable: row.stock_available,
    stockLevel: row.stock_level,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    openedAt: row.opened_at,
    announcedAt: row.announced_at,
    decision:
      row.decided_at === null ||
      row.decided_by === null ||
      row.decided_role === null ||
      row.decided_via === null
        ? null
        : {
            by: row.decided_by,
            role: row.decided_role,
            via: row.decided_via,
            at: row.decided_at,
            reason: row.reason,
          },
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

export async function listBakeStockLevels(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly BakeStockLevel[]> {
  const rows = await db
    .prepare(
      `SELECT ${LEVEL_COLUMNS} FROM bake_stock_level
        WHERE organisation_id = ? ORDER BY product_name, inventory_item_id`,
    )
    .bind(organisationId)
    .all<LevelRow>();
  return rows.results.map(levelFromRow);
}

export async function readBakeStockLevel(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  inventoryItemId: string,
): Promise<BakeStockLevel | null> {
  const row = await db
    .prepare(
      `SELECT ${LEVEL_COLUMNS} FROM bake_stock_level
        WHERE organisation_id = ? AND inventory_item_id = ?`,
    )
    .bind(organisationId, inventoryItemId)
    .first<LevelRow>();
  return row === null ? null : levelFromRow(row);
}

/**
 * The levels of the items whose stock a delivery changed. A delivery that
 * names no item with a level reads one empty answer and writes nothing.
 */
export async function readBakeStockLevelsOf(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  inventoryItemIds: readonly string[],
): Promise<readonly BakeStockLevel[]> {
  const ids = [...new Set(inventoryItemIds)].slice(0, 90);
  if (ids.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT ${LEVEL_COLUMNS} FROM bake_stock_level
        WHERE organisation_id = ?
          AND inventory_item_id IN (${ids.map(() => "?").join(", ")})`,
    )
    .bind(organisationId, ...ids)
    .all<LevelRow>();
  return rows.results.map(levelFromRow);
}

export type BakeStockLevelWrite = Omit<
  BakeStockLevel,
  "revision" | "setBy" | "setAt"
>;

/**
 * Sets one level. `expectedRevision` is the revision that the person saw, or
 * null for a new level; a level that changed since then stays as it is. The
 * same values again write nothing.
 */
export async function writeBakeStockLevel(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  level: BakeStockLevelWrite,
  expectedRevision: number | null,
  setBy: string,
  now: number,
): Promise<
  | Readonly<{ kind: "written" | "unchanged"; level: BakeStockLevel }>
  | Readonly<{ kind: "stale"; current: BakeStockLevel | null }>
> {
  const current = await readBakeStockLevel(
    db,
    organisationId,
    level.inventoryItemId,
  );
  if ((current?.revision ?? null) !== expectedRevision)
    return { kind: "stale", current };
  if (
    current !== null &&
    current.productName === level.productName &&
    current.levelPieces === level.levelPieces &&
    current.piecesPerGroup === level.piecesPerGroup &&
    current.workflowId === level.workflowId &&
    current.kitchenLocation === level.kitchenLocation
  )
    return { kind: "unchanged", level: current };
  const revision = (current?.revision ?? 0) + 1;
  const written = await db
    .prepare(
      `INSERT INTO bake_stock_level (organisation_id, ${LEVEL_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, inventory_item_id) DO UPDATE SET
         product_name = excluded.product_name,
         level_pieces = excluded.level_pieces,
         pieces_per_group = excluded.pieces_per_group,
         workflow_id = excluded.workflow_id,
         kitchen_location = excluded.kitchen_location,
         revision = excluded.revision,
         set_by = excluded.set_by,
         set_at = excluded.set_at
       WHERE bake_stock_level.revision = ?`,
    )
    .bind(
      organisationId,
      level.inventoryItemId,
      level.productName,
      level.levelPieces,
      level.piecesPerGroup,
      level.workflowId,
      level.kitchenLocation,
      revision,
      setBy,
      now,
      revision - 1,
    )
    .run();
  if ((written.meta.changes ?? 0) === 0)
    return {
      kind: "stale",
      current: await readBakeStockLevel(
        db,
        organisationId,
        level.inventoryItemId,
      ),
    };
  return {
    kind: "written",
    level: { ...level, revision, setBy, setAt: now },
  };
}

export async function readBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<BakeProposal | null> {
  const row = await db
    .prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM bake_proposal
        WHERE organisation_id = ? AND proposal_id = ?`,
    )
    .bind(organisationId, proposalId)
    .first<ProposalRow>();
  return row === null ? null : proposalFromRow(row);
}

export async function listBakeProposals(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  limit = 50,
): Promise<readonly BakeProposal[]> {
  const rows = await db
    .prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM bake_proposal
        WHERE organisation_id = ?
        ORDER BY proposed_at DESC, proposal_id DESC LIMIT ?`,
    )
    .bind(organisationId, Math.min(Math.max(limit, 1), 200))
    .all<ProposalRow>();
  return rows.results.map(proposalFromRow);
}

/** The active and the waiting proposal of one product, if any. */
export async function readProductProposals(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  inventoryItemId: string,
): Promise<
  Readonly<{ active: BakeProposal | null; waiting: BakeProposal | null }>
> {
  const rows = await db
    .prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM bake_proposal
        WHERE organisation_id = ? AND inventory_item_id = ?
          AND state IN ('waiting', 'open', 'approved')`,
    )
    .bind(organisationId, inventoryItemId)
    .all<ProposalRow>();
  const proposals = rows.results.map(proposalFromRow);
  return {
    active: proposals.find((proposal) => proposal.state !== "waiting") ?? null,
    waiting: proposals.find((proposal) => proposal.state === "waiting") ?? null,
  };
}

/**
 * Adds a proposal. It opens when the product has no active proposal, and it
 * waits when the product has one. Null when the product already has an active
 * and a waiting proposal: then nothing is written.
 */
export async function insertBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  draft: BakeProposalDraft,
): Promise<BakeProposal | null> {
  try {
    await db
      .prepare(
        `INSERT INTO bake_proposal (
           proposal_id, organisation_id, inventory_item_id, product_name,
           state, origin, case_id, workflow_id, workflow_revision,
           workflow_digest, quantity_pieces, mould_groups, pieces_per_group,
           kitchen_location, oven_device_id, oven_name, stock_location_id,
           stock_available, stock_level, proposed_by, proposed_at, opened_at)
         SELECT ?1, ?2, ?3, ?4,
                CASE WHEN active.n > 0 THEN 'waiting' ELSE 'open' END,
                ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20,
                CASE WHEN active.n > 0 THEN NULL ELSE ?20 END
           FROM (SELECT COUNT(*) AS n FROM bake_proposal
                  WHERE organisation_id = ?2 AND inventory_item_id = ?3
                    AND ${ACTIVE}) AS active
          WHERE active.n = 0
             OR NOT EXISTS (
               SELECT 1 FROM bake_proposal
                WHERE organisation_id = ?2 AND inventory_item_id = ?3
                  AND state = 'waiting')`,
      )
      .bind(
        draft.proposalId,
        organisationId,
        draft.inventoryItemId,
        draft.productName,
        draft.origin,
        draft.caseId,
        draft.workflowId,
        draft.workflowRevision,
        draft.workflowDigest,
        draft.quantityPieces,
        draft.mouldGroups,
        draft.piecesPerGroup,
        draft.kitchenLocation,
        draft.oven?.deviceId ?? null,
        draft.oven?.name ?? null,
        draft.stockLocationId,
        draft.stockAvailable,
        draft.stockLevel,
        draft.proposedBy,
        draft.proposedAt,
      )
      .run();
  } catch (error) {
    // Another writer took the product's place between the read and the write.
    if (isUniqueConstraintError(error)) return null;
    throw error;
  }
  return readBakeProposal(db, organisationId, draft.proposalId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed")
  );
}

export type BakeDecisionWrite = Readonly<{
  proposalId: string;
  state: "approved" | "rejected";
  by: string;
  role: BakeDeciderRole;
  via: BakeDecidedVia;
  reason: string | null;
  at: number;
}>;

/** Decides an open proposal. False when it was not open: nothing changed. */
export async function writeBakeDecision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  decision: BakeDecisionWrite,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bake_proposal
          SET state = ?, decided_by = ?, decided_role = ?, decided_via = ?,
              decided_at = ?, reason = ?
        WHERE organisation_id = ? AND proposal_id = ? AND state = 'open'`,
    )
    .bind(
      decision.state,
      decision.by,
      decision.role,
      decision.via,
      decision.at,
      decision.reason,
      organisationId,
      decision.proposalId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Ends an approved proposal. False when it was not approved. */
export async function writeBakeEnd(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
  reason: string,
  at: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bake_proposal SET state = 'ended', ended_at = ?, end_reason = ?
        WHERE organisation_id = ? AND proposal_id = ? AND state = 'approved'`,
    )
    .bind(at, reason, organisationId, proposalId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export type BakeOpenRefresh = Readonly<{
  workflowRevision: number;
  workflowDigest: string;
  oven: Readonly<{ deviceId: string; name: string }> | null;
}>;

/**
 * Opens the waiting proposal of a product when it has no active one. The
 * recipe revision and the oven are read again at this time, because the
 * proposal waited. Null when no proposal opened.
 */
export async function openWaitingBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
  refresh: BakeOpenRefresh,
  at: number,
): Promise<BakeProposal | null> {
  try {
    const result = await db
      .prepare(
        `UPDATE bake_proposal
            SET state = 'open', opened_at = ?, workflow_revision = ?,
                workflow_digest = ?, oven_device_id = ?, oven_name = ?
          WHERE organisation_id = ? AND proposal_id = ? AND state = 'waiting'
            AND NOT EXISTS (
              SELECT 1 FROM bake_proposal AS other
               WHERE other.organisation_id = bake_proposal.organisation_id
                 AND other.inventory_item_id = bake_proposal.inventory_item_id
                 AND other.${ACTIVE})`,
      )
      .bind(
        at,
        refresh.workflowRevision,
        refresh.workflowDigest,
        refresh.oven?.deviceId ?? null,
        refresh.oven?.name ?? null,
        organisationId,
        proposalId,
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
  } catch (error) {
    if (isUniqueConstraintError(error)) return null;
    throw error;
  }
  return readBakeProposal(db, organisationId, proposalId);
}

/** Records that the proposal's Case and Slack card exist. */
/**
 * The proposal's card went out. `cardTs` is the Slack message of the card,
 * the root of the thread where its bake run posts (Plan 24 S6).
 */
export async function markBakeProposalAnnounced(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
  at: number,
  cardTs: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE bake_proposal SET announced_at = ?, card_ts = ?
        WHERE organisation_id = ? AND proposal_id = ? AND announced_at IS NULL`,
    )
    .bind(at, cardTs, organisationId, proposalId)
    .run();
}

/** The Slack message of the proposal's card, or null with no card. */
export async function readBakeProposalCardTs(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT card_ts FROM bake_proposal
        WHERE organisation_id = ? AND proposal_id = ?`,
    )
    .bind(organisationId, proposalId)
    .first<{ card_ts: string | null }>();
  return row?.card_ts ?? null;
}
