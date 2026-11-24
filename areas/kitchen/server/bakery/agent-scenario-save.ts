import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  agentScenarioSaveManifest,
  type AgentScenarioSaveManifest,
  type AgentScenarioSavePayload,
} from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import {
  parseBakerySurfaceEffect,
  parseBakerySurfaceReceipt,
  parseScenarioSaveManifest,
  verifyBakerySurfaceAttachment,
  verifyBakerySurfaceEffect,
  verifyBakerySurfaceReceipt,
} from "@purin-labs/bakery-model/bakery-surface";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { isRecord } from "@purin-labs/std";
import type { AgentScenarioSaveResult } from "@purin-labs/area-kitchen-contract/server/saved-bakery-runs";

const PROPOSAL_TTL_MS = 15 * 60_000;

type SaveIdentity = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  userId: string;
  effectId: string;
}>;

type ProposalRow = Readonly<{
  effectJson: string;
  receiptJson: string;
  updatedAt: number;
}>;

type SaveRow = Readonly<{
  organisationId: string;
  userId: string;
  scenarioKind: string;
  scenarioId: string;
  payloadDigest: string;
  manifestJson: string;
  stateKind: "approved" | "saved";
  resultJson: string | null;
}>;

export async function approveAgentScenarioSave(
  identity: SaveIdentity,
  payload: AgentScenarioSavePayload,
): Promise<boolean> {
  const manifest = await agentScenarioSaveManifest(payload);
  const existing = await readSaveRow(identity);
  if (existing !== null) return matchesSave(existing, identity, manifest);

  const proposal = await identity.db
    .prepare(
      `SELECT effect_json AS effectJson, receipt_json AS receiptJson,
              updated_at AS updatedAt
       FROM bakery_surface_effect_delivery
       WHERE effect_id = ? AND organisation_id = ? AND user_id = ?
         AND state_kind = 'settled'`,
    )
    .bind(identity.effectId, identity.organisationId, identity.userId)
    .first<ProposalRow>();
  if (proposal === null) return false;
  let effectRaw: unknown;
  let receiptRaw: unknown;
  try {
    effectRaw = JSON.parse(proposal.effectJson);
    receiptRaw = JSON.parse(proposal.receiptJson);
  } catch {
    return false;
  }
  const effect = parseBakerySurfaceEffect(effectRaw);
  const receipt = parseBakerySurfaceReceipt(receiptRaw);
  if (
    effect.kind !== "valid" ||
    receipt.kind !== "valid" ||
    !(await verifyBakerySurfaceEffect(effect.value)) ||
    !(await verifyBakerySurfaceReceipt(receipt.value)) ||
    effect.value.effectId !== identity.effectId ||
    effect.value.command.kind !== "prepare_scenario_save" ||
    receipt.value.effectId !== effect.value.effectId ||
    receipt.value.dispatchId !== effect.value.dispatchId ||
    receipt.value.commandDigest !== effect.value.commandDigest ||
    receipt.value.outcome.kind !== "completed" ||
    receipt.value.outcome.result.kind !== "succeeded" ||
    receipt.value.outcome.result.command !== "prepare_scenario_save" ||
    receipt.value.outcome.result.output.kind !== "scenario_save_proposal" ||
    !(await verifyBakerySurfaceAttachment(receipt.value.outcome.result.surface))
  )
    return false;
  const result = receipt.value.outcome.result;
  const context = result.surface.context;
  if (
    context.surfaceSessionId !== effect.value.command.target.surfaceSessionId ||
    context.surfaceEpoch !== effect.value.command.target.surfaceEpoch ||
    (context.active.kind !== "shift" && context.active.kind !== "production") ||
    context.active.scenarioSaveProposal === null ||
    effect.value.command.name !== manifest.name ||
    effect.value.command.note !== payload.copy.note ||
    JSON.stringify(result.output.manifest) !== JSON.stringify(manifest) ||
    JSON.stringify(context.active.scenarioSaveProposal) !==
      JSON.stringify(manifest)
  )
    return false;
  const approvedAt = Date.now();
  if (approvedAt > proposal.updatedAt + PROPOSAL_TTL_MS) return false;
  await identity.db
    .prepare(
      `INSERT INTO bakery_agent_scenario_save (
         effect_id, organisation_id, user_id, scenario_kind, scenario_id,
         payload_digest, manifest_json, state_kind, result_json,
         approved_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', NULL, ?, ?)
       ON CONFLICT(effect_id) DO NOTHING`,
    )
    .bind(
      identity.effectId,
      identity.organisationId,
      identity.userId,
      manifest.kind,
      manifest.id,
      manifest.digest,
      JSON.stringify(manifest),
      approvedAt,
      approvedAt,
    )
    .run();
  const saved = await readSaveRow(identity);
  return saved !== null && matchesSave(saved, identity, manifest);
}

export async function settleAgentScenarioSave(
  identity: SaveIdentity,
  payload: AgentScenarioSavePayload,
  result: Readonly<{ ok: true; scenarioId: string }>,
): Promise<void> {
  const manifest = await agentScenarioSaveManifest(payload);
  if (result.scenarioId !== manifest.id)
    throw new Error("bakery_agent_scenario_result_mismatch");
  const updated = await identity.db
    .prepare(
      `UPDATE bakery_agent_scenario_save
       SET state_kind = 'saved', result_json = ?, updated_at = ?
       WHERE effect_id = ? AND organisation_id = ? AND user_id = ?
         AND scenario_kind = ? AND scenario_id = ? AND payload_digest = ?`,
    )
    .bind(
      JSON.stringify(result),
      Date.now(),
      identity.effectId,
      identity.organisationId,
      identity.userId,
      manifest.kind,
      manifest.id,
      manifest.digest,
    )
    .run();
  if (updated.meta.changes !== 1)
    throw new Error("bakery_agent_scenario_settlement_missing");
}

export async function readCompletedAgentScenarioSave(
  identity: SaveIdentity,
): Promise<Readonly<{ ok: true; scenarioId: string }> | null> {
  const row = await readSaveRow(identity);
  if (
    row === null ||
    row.organisationId !== identity.organisationId ||
    row.userId !== identity.userId ||
    row.stateKind !== "saved"
  )
    return null;
  return { ok: true, scenarioId: row.scenarioId };
}

async function readSaveRow(identity: SaveIdentity): Promise<SaveRow | null> {
  return identity.db
    .prepare(
      `SELECT organisation_id AS organisationId, user_id AS userId,
              scenario_kind AS scenarioKind, scenario_id AS scenarioId,
              payload_digest AS payloadDigest, manifest_json AS manifestJson,
              state_kind AS stateKind, result_json AS resultJson
       FROM bakery_agent_scenario_save WHERE effect_id = ?`,
    )
    .bind(identity.effectId)
    .first<SaveRow>();
}

function matchesSave(
  row: SaveRow,
  identity: SaveIdentity,
  manifest: AgentScenarioSaveManifest,
): boolean {
  return (
    row.organisationId === identity.organisationId &&
    row.userId === identity.userId &&
    row.scenarioKind === manifest.kind &&
    row.scenarioId === manifest.id &&
    row.payloadDigest === manifest.digest &&
    row.manifestJson === JSON.stringify(manifest)
  );
}

type LatestSaveRow = SaveRow & Readonly<{ effectId: string }>;

export async function readLatestAgentScenarioSave(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    userId: string;
    surfaceSessionId: string;
  }>,
): Promise<AgentScenarioSaveResult> {
  const row = await input.db
    .prepare(
      `SELECT save.effect_id AS effectId, save.organisation_id AS organisationId,
              save.user_id AS userId,
              save.scenario_kind AS scenarioKind, save.scenario_id AS scenarioId,
              save.payload_digest AS payloadDigest, save.manifest_json AS manifestJson,
              save.state_kind AS stateKind, save.result_json AS resultJson
       FROM bakery_agent_scenario_save AS save
       JOIN bakery_surface_effect_delivery AS effect
         ON effect.effect_id = save.effect_id
       WHERE save.organisation_id = ? AND save.user_id = ?
         AND effect.surface_session_id = ? AND save.state_kind = 'saved'
       ORDER BY save.updated_at DESC, save.effect_id DESC LIMIT 1`,
    )
    .bind(input.organisationId, input.userId, input.surfaceSessionId)
    .first<LatestSaveRow>();
  if (row === null) return { kind: "none" };
  let manifestRaw: unknown;
  let resultRaw: unknown;
  try {
    manifestRaw = JSON.parse(row.manifestJson);
    resultRaw = row.resultJson === null ? null : JSON.parse(row.resultJson);
  } catch {
    return { kind: "unavailable", effectId: row.effectId };
  }
  const manifest = parseScenarioSaveManifest(manifestRaw);
  if (
    manifest === null ||
    !matchesSave(
      row,
      {
        db: input.db,
        organisationId: input.organisationId,
        userId: input.userId,
        effectId: row.effectId,
      },
      manifest,
    ) ||
    !isRecord(resultRaw) ||
    Object.keys(resultRaw).length !== 2 ||
    resultRaw.ok !== true ||
    resultRaw.scenarioId !== manifest.id
  )
    return { kind: "unavailable", effectId: row.effectId };
  return {
    kind: "saved",
    effectId: row.effectId,
    manifest,
    scenarioId: manifest.id,
  };
}
