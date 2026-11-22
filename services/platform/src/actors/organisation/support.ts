import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { readPlacementByEpoch } from "@purin-labs/tenancy/data/organisation-placement";
import {
  OrganisationExecutionScope,
  selectOrganisationPlacementDatabase,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { collaborationSocketRoute } from "../collaboration-room";
import {
  SOCKET_SILENCE_LIMIT_MS,
  SOCKET_SWEEP_INTERVAL_MS,
  openSockets,
} from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  newRequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  expireDueActionExecutions,
  readNextActionExecutionLeaseDeadline,
} from "../action-ledger";
import { admitActorRecovery } from "@purin-labs/actor-runtime/actors/actor-activation";
import {
  readActivationExportSource,
  type ActorExportError,
} from "@purin-labs/actor-runtime/actors/actor-export";
import {
  expireCodeModeOrganisationReservations,
  readNextCodeModeOrganisationAlarmAt,
} from "../code-mode-budget";
import { expireAbandonedCueClaims } from "../cue-delivery";
import { errorMessage } from "@purin-labs/std";
import type { CommerceBoardPresenceEntry } from "@purin-labs/commerce-control-api";
import type { OrganisationMeta, OrganisationMetaRow } from "@purin-labs/tenancy/actors/organisation/types";
import {
  organisationPlacementConflict,
  readOrganisationMetaRow,
} from "@purin-labs/tenancy/actors/organisation/organisation-record";

const COMMERCE_BOARD_PRESENCE_TTL_MS = 30_000;

export function pruneCommerceBoardPresence(
  presence: Map<string, CommerceBoardPresenceEntry>,
  now: number,
): void {
  for (const [identityId, entry] of presence) {
    if (now - entry.observedAt >= COMMERCE_BOARD_PRESENCE_TTL_MS)
      presence.delete(identityId);
  }
}

export function readCommerceBoardPresence(
  presence: ReadonlyMap<string, CommerceBoardPresenceEntry>,
  resourceKey: string,
): readonly CommerceBoardPresenceEntry[] {
  const entries: CommerceBoardPresenceEntry[] = [];
  for (const entry of presence.values()) {
    if (entry.resourceKey === resourceKey) entries.push(entry);
  }
  entries.sort(compareCommerceBoardPresence);
  return entries;
}

function compareCommerceBoardPresence(
  left: CommerceBoardPresenceEntry,
  right: CommerceBoardPresenceEntry,
): number {
  return left.userId === right.userId ? 0 : left.userId < right.userId ? -1 : 1;
}

/** A socket without a room route cannot belong to this Actor's rooms. */
/** Runs one socket sweep; its failure leaves the other sweeps to run. */
export async function sweepSafely(
  name: string,
  sweep: () => Promise<void>,
): Promise<void> {
  try {
    await sweep();
  } catch (error) {
    traceWarn("organisation.socket_sweep_failed", {
      requestId: newRequestId(),
      sweep: name,
      detail: errorMessage(error),
    });
  }
}

/**
 * The time until the next sweep: short while two sockets share a room, so a
 * dropped client leaves its presence soon; long otherwise; none without
 * sockets.
 */
export function socketSweepInterval(ctx: DurableObjectState): number | null {
  const sockets = openSockets(ctx);
  if (sockets.length === 0) return null;
  const rooms = new Set<string>();
  for (const socket of sockets) {
    const route = collaborationSocketRoute(socket.deserializeAttachment());
    if (route === null) continue;
    const key = JSON.stringify([route.kind, route.key]);
    if (rooms.has(key)) return SOCKET_SILENCE_LIMIT_MS;
    rooms.add(key);
  }
  return SOCKET_SWEEP_INTERVAL_MS;
}

/** The lease step of the alarm: it ends the leases that are past their time. */
export function expireOrganisationLeases(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): void {
  expireDueActionExecutions(sql, organisationId, now);
  expireCodeModeOrganisationReservations(sql, now);
  expireAbandonedCueClaims(sql, organisationId, now);
}

export function readNextOrganisationAlarmAt(sql: SqlStorage): number | null {
  const actionAt = readNextActionExecutionLeaseDeadline(
    sql,
    requireOrganisationMetaId(sql),
  );
  const codeModeAt = readNextCodeModeOrganisationAlarmAt(sql);
  if (actionAt === null) return codeModeAt;
  if (codeModeAt === null) return actionAt;
  return Math.min(actionAt, codeModeAt);
}

function requireOrganisationMetaId(sql: SqlStorage): OrganisationId {
  const organisation = readOrganisationMetaRow(sql);
  if (organisation === undefined) throw new Error("organisation_meta_missing");
  const organisationId = parseOrganisationId(organisation.organisation_id);
  if (!organisationId.ok) throw new Error("organisation_meta_identity_invalid");
  return organisationId.value;
}

export function organisationRowToMeta(
  row: OrganisationMetaRow,
): OrganisationMeta {
  const organisationId = parseOrganisationId(row.organisation_id);

  if (!organisationId.ok) {
    throw new Error("organisation_meta_identity_invalid");
  }

  return {
    organisationId: organisationId.value,
    name: row.name,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function executeOrganisationCommand<
  Outcome extends Result<unknown, { readonly code: string }>,
>(
  env: Env,
  storage: DurableObjectStorage,
  organisationId: OrganisationId,
  start: (scope: OrganisationExecutionScope) => Promise<Outcome>,
): Promise<
  Outcome | Result<never, { readonly code: "organisation_placement_conflict" }>
> {
  const admission = await admitActorRecovery(env, storage);
  if (
    admission.kind !== "admitted" ||
    admission.scope.organisationId !== organisationId ||
    !(await isOrganisationExecutionActive(storage.sql, admission.scope))
  )
    return organisationPlacementConflict();
  const result = await start(admission.scope);
  if (!(await isOrganisationExecutionActive(storage.sql, admission.scope)))
    return organisationPlacementConflict();
  return result;
}

export async function resolveOrganisationActorDatabase(
  env: Env,
  sql: SqlStorage,
): Promise<Result<OrganisationDatabase, ActorExportError>> {
  const activation = readActivationExportSource(sql);
  if (!activation.ok) return activation;
  const placement = await readPlacementByEpoch(
    env.DB,
    activation.value.identity.organisationId,
    activation.value.placementEpoch,
  );
  if (!placement.ok)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  const selected = selectOrganisationPlacementDatabase(
    env,
    activation.value.identity.organisationId,
    placement.value.placement,
  );
  return selected.ok
    ? selected
    : {
        ok: false,
        error: { code: "actor_cleanup_failed", detail: selected.error.code },
      };
}
