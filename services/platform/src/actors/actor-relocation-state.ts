import type { GlobalDatabase } from "../database-handles";
import {
  assertNever,
  isNonEmptyString,
  isNonNegativeInteger,
} from "@purin-labs/std";
import type { Env } from "../env";
import type { Result } from "../result";
import type { ActorFenceToken } from "./actor-registry";
import type { ActorRelocationId } from "./actor-relocation";
import {
  readActivationExportSource,
  type ActorExportError,
  type ActorExportSource,
} from "./actor-export";
import { eraseActorContentSql } from "./placement-execution-quiescence";

export type RelocationReceiptError = {
  readonly code: "relocation_receipt_rejected";
};

export function frozenRelocationReceiptGate(
  directory: GlobalDatabase,
  activation: ActorExportSource,
  relocationId: ActorRelocationId,
): D1PreparedStatement {
  return directory
    .prepare(
      `SELECT 1 FROM state_object_relocation operation
    JOIN organisation_placement source ON source.organisation_id = operation.organisation_id
      AND source.placement_epoch = operation.source_placement_epoch
    JOIN organisation_placement target ON target.organisation_id = operation.organisation_id
      AND target.placement_epoch = operation.target_placement_epoch
    WHERE operation.relocation_id = ? AND operation.organisation_id = ?
      AND operation.source_placement_epoch = ? AND operation.status = 'frozen'
      AND operation.source_quiesced_at IS NULL AND source.status = 'frozen'
      AND target.status = 'reserved'`,
    )
    .bind(
      relocationId,
      activation.identity.organisationId,
      activation.placementEpoch,
    );
}

export type InactiveActorErasureRequest = {
  readonly kind: "retired_source" | "abandoned_target";
  readonly relocationId: ActorRelocationId;
  readonly expectedFenceToken: ActorFenceToken;
};

/** Preserve the local activation tombstone so stale requests remain fenced after erasure. */
export async function eraseInactiveActorState(
  env: Pick<Env, "DB">,
  storage: DurableObjectStorage,
  request: InactiveActorErasureRequest,
): Promise<Result<null, ActorExportError>> {
  const activation = readActivationExportSource(storage.sql);
  if (!activation.ok) return activation;
  if (activation.value.fenceToken !== request.expectedFenceToken)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  const allowed =
    request.kind === "retired_source"
      ? await env.DB.prepare(
          `SELECT 1 FROM state_object_relocation operation
    JOIN state_object_relocation_item item ON item.relocation_id = operation.relocation_id
    JOIN organisation_placement source ON source.organisation_id = operation.organisation_id
      AND source.placement_epoch = operation.source_placement_epoch
    JOIN organisation_placement target ON target.organisation_id = operation.organisation_id
      AND target.placement_epoch = operation.target_placement_epoch
    WHERE operation.relocation_id = ? AND operation.organisation_id = ?
      AND operation.source_placement_epoch = ? AND operation.status = 'cleaning'
      AND (operation.retain_until <= ? OR operation.retention_waived_at IS NOT NULL) AND operation.data_verified_at IS NOT NULL
      AND source.status = 'retired' AND target.status IN ('active', 'retired')
      AND item.source_registry_id = ? AND item.status = 'retired'`,
        )
          .bind(
            request.relocationId,
            activation.value.identity.organisationId,
            activation.value.placementEpoch,
            Date.now(),
            activation.value.registryId,
          )
          .first()
      : await env.DB.prepare(
          `WITH RECURSIVE recovery AS (
            SELECT relocation_id, organisation_id, status, recovery_relocation_id, retain_until, retention_waived_at
              FROM state_object_relocation WHERE relocation_id = ?
            UNION SELECT successor.relocation_id, successor.organisation_id, successor.status,
                successor.recovery_relocation_id, successor.retain_until, successor.retention_waived_at
              FROM state_object_relocation successor JOIN recovery predecessor
                ON successor.relocation_id = predecessor.recovery_relocation_id
              WHERE predecessor.status = 'abandoned'
          ) SELECT 1 FROM state_object_relocation operation
          JOIN organisation_placement target ON target.organisation_id = operation.organisation_id
            AND target.placement_epoch = operation.target_placement_epoch
          WHERE operation.relocation_id = ? AND operation.organisation_id = ?
            AND operation.target_placement_epoch = ? AND operation.status = 'abandoned'
            AND target.status = 'abandoned' AND EXISTS (
              SELECT 1 FROM recovery WHERE recovery.status = 'cleaning'
                AND recovery.organisation_id = operation.organisation_id
                AND (recovery.retain_until <= ? OR recovery.retention_waived_at IS NOT NULL)
            )`,
        )
          .bind(
            request.relocationId,
            request.relocationId,
            activation.value.identity.organisationId,
            activation.value.placementEpoch,
            Date.now(),
          )
          .first();
  if (allowed === null)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  await storage.deleteAlarm();
  storage.transactionSync(eraseActorContentSql.bind(null, storage.sql));
  while (true) {
    const keys = await storage.list({ limit: 128 });
    if (keys.size === 0) break;
    await storage.delete([...keys.keys()]);
  }
  return { ok: true, value: null };
}

export type ActorRelocationReadiness =
  | {
      readonly kind: "ready";
      readonly storedBytes: number;
      readonly unresolvedOperationId?: never;
    }
  | {
      readonly kind: "blocked";
      readonly unresolvedOperationId: string;
      readonly storedBytes?: never;
    };

export function inspectActorRelocationReadiness(
  storage: DurableObjectStorage,
  request: {
    readonly expectedFenceToken: ActorFenceToken;
    readonly stage: "preflight" | "quiescent";
  },
): Result<ActorRelocationReadiness, ActorExportError> {
  const activation = readActivationExportSource(storage.sql);
  if (!activation.ok) return activation;
  if (activation.value.fenceToken !== request.expectedFenceToken)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  const queries: string[] = [];
  switch (activation.value.identity.objectKind) {
    case "organisation":
      queries.push(`SELECT nonce AS operationId FROM action_ledger
        WHERE state = 'indeterminate' OR (? = 'quiescent' AND state = 'executing') LIMIT 1`);
      break;
    case "session":
      queries.push(`SELECT effect_id AS operationId FROM actor_outbox
        CROSS JOIN (SELECT ? AS inspection_stage)
        WHERE (state_kind = 'indeterminate'
          OR json_extract(state_projection, '$.kind') = 'surface_indeterminate'
          OR (inspection_stage = 'quiescent' AND state_kind = 'dispatching'))
          AND NOT (inspection_stage = 'preflight'
            AND COALESCE(json_extract(request_envelope, '$.kind'), '') = 'code_mode_execution_settlement.v1')
        LIMIT 1`);
      break;
    case "connector":
      queries.push(`SELECT proposal_id AS operationId FROM connector_email_draft
        WHERE state = 'send_indeterminate' AND ? IN ('preflight', 'quiescent') LIMIT 1`);
      queries.push(`SELECT proposal_id AS operationId FROM connector_email_operational_proposal
        WHERE state = 'send_indeterminate' AND ? IN ('preflight', 'quiescent') LIMIT 1`);
      queries.push(`SELECT delivery_id AS operationId FROM connector_delivery
        WHERE json_extract(state_json, '$.kind') = 'sending' AND ? = 'quiescent' LIMIT 1`);
      break;
    case "case":
      break;
    default:
      return assertNever(activation.value.identity);
  }
  for (const query of queries) {
    const row = storage.sql
      .exec<{ operationId: string }>(query, request.stage)
      .toArray()[0];
    if (row !== undefined) {
      if (!isNonEmptyString(row.operationId))
        return { ok: false, error: { code: "export_manifest_corrupt" } };
      return {
        ok: true,
        value: { kind: "blocked", unresolvedOperationId: row.operationId },
      };
    }
  }
  const storedBytes = storage.sql.databaseSize;
  if (!isNonNegativeInteger(storedBytes))
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  return { ok: true, value: { kind: "ready", storedBytes } };
}
