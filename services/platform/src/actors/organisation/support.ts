import type { OrganisationDatabase } from "../../database-handles";
import { readPlacementByEpoch } from "../../data/organisation-placement";
import {
  OrganisationExecutionScope,
  selectOrganisationPlacementDatabase,
} from "../../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actor-execution-quiescence";
import { collaborationSocketRoute } from "../collaboration-room";
import {
  SOCKET_SILENCE_LIMIT_MS,
  SOCKET_SWEEP_INTERVAL_MS,
  openSockets,
} from "../hibernatable-sockets";
import type { Env } from "../../env";
import {
  parseOrganisationId,
  newRequestId,
  type OrganisationId,
} from "../../ids";
import {
  parseVaultHandle,
  type VaultHandle,
} from "../../credential-vault/domain";
import { traceWarn } from "../../observability";
import {
  parseOrganisationPolicySnapshot,
  type OrganisationPolicySnapshot,
} from "../../policy-snapshot";
import type { Result } from "../../result";
import {
  ACTION_EXECUTION_LEASE_DURATION_MS,
  readNextActionExecutionLeaseDeadline,
} from "../action-ledger";
import { admitActorRecovery } from "../actor-activation";
import {
  readActivationExportSource,
  type ActorExportError,
} from "../actor-export";
import { readNextCodeModeOrganisationAlarmAt } from "../code-mode-budget";
import type { VariantBy } from "@seams/type-utils";
import { errorMessage } from "@seams/std";
import type { CommerceBoardPresenceEntry } from "@seams/control-api";
import { armAlarmBy } from "../lifecycle/actor-alarm";
import type {
  CodeModeOrganisationActorError,
  OrganisationMeta,
  OrganisationMetaRow,
  OrganisationPolicyActivation,
  OrganisationPolicyHead,
  OrganisationPolicyHeadRow,
  OrganisationStateError,
} from "./types";

export const COMMERCE_BOARD_PRESENCE_TTL_MS = 30_000;

export function validateActionOrganisation(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Result<null, OrganisationStateError> {
  const organisation = readOrganisationMetaRow(sql);

  if (organisation === undefined) {
    return { ok: false, error: { code: "organisation_not_initialized" } };
  }

  if (organisation.organisation_id !== organisationId) {
    return { ok: false, error: { code: "organisation_mismatch" } };
  }

  return { ok: true, value: null };
}

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

export function compareCommerceBoardPresence(
  left: CommerceBoardPresenceEntry,
  right: CommerceBoardPresenceEntry,
): number {
  return left.userId === right.userId ? 0 : left.userId < right.userId ? -1 : 1;
}

export function validateCodeModeOrganisation(
  sql: SqlStorage,
  organisationId: OrganisationId,
  requireActive: boolean,
): Result<OrganisationMetaRow, CodeModeOrganisationActorError> {
  const organisation = readOrganisationMetaRow(sql);
  if (organisation === undefined) {
    return { ok: false, error: { code: "organisation_not_initialized" } };
  }
  if (organisation.organisation_id !== organisationId) {
    return { ok: false, error: { code: "organisation_mismatch" } };
  }
  if (requireActive && organisation.status !== "active") {
    return {
      ok: false,
      error: { code: "organisation_not_active", status: organisation.status },
    };
  }
  return { ok: true, value: organisation };
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

export async function armActionExecutionAlarm(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const deadline = now + ACTION_EXECUTION_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline))
    return;
  await armAlarmBy(storage, deadline);
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

export function requireOrganisationMetaId(sql: SqlStorage): OrganisationId {
  const organisation = readOrganisationMetaRow(sql);
  if (organisation === undefined) throw new Error("organisation_meta_missing");
  const organisationId = parseOrganisationId(organisation.organisation_id);
  if (!organisationId.ok) throw new Error("organisation_meta_identity_invalid");
  return organisationId.value;
}

export function readOrganisationMetaRow(
  sql: SqlStorage,
): OrganisationMetaRow | undefined {
  const rows = sql
    .exec<OrganisationMetaRow>(
      `SELECT organisation_id, name, plan, status, created_at
       FROM organisation_meta
       LIMIT 1`,
    )
    .toArray();

  return rows[0];
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

export function readOrganisationPolicyHead(
  sql: SqlStorage,
): OrganisationPolicyHeadRow | undefined {
  return sql
    .exec<OrganisationPolicyHeadRow>(
      `SELECT organisation_id, active_version, restriction_version, digest, body, activated_at
       FROM organisation_policy_head
       LIMIT 1`,
    )
    .toArray()[0];
}

export function policyHeadFromRow(
  row: OrganisationPolicyHeadRow,
): OrganisationPolicyHead {
  return {
    activeVersion: row.active_version,
    restrictionVersion: row.restriction_version,
    digest: row.digest,
    activatedAt: row.activated_at,
  };
}

export function parseStoredOrganisationPolicy(
  raw: string,
): Result<
  OrganisationPolicySnapshot,
  VariantBy<OrganisationStateError, "code", "invalid_policy_snapshot">
> {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalid_policy_snapshot" } };
  }

  const parsed = parseOrganisationPolicySnapshot(value);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: { code: "invalid_policy_snapshot" } };
}

export function activePolicyCredentialRefs(
  snapshot: OrganisationPolicySnapshot,
): Result<
  readonly { readonly ruleId: string; readonly credentialRef: VaultHandle }[],
  VariantBy<OrganisationStateError, "code", "invalid_policy_snapshot">
> {
  const refs: {
    readonly ruleId: string;
    readonly credentialRef: VaultHandle;
  }[] = [];

  for (const injection of snapshot.egress.injections) {
    const credentialRef = parseVaultHandle(injection.credentialRef);
    if (!credentialRef.ok) {
      return { ok: false, error: { code: "invalid_policy_snapshot" } };
    }
    refs.push({ ruleId: injection.ruleId, credentialRef: credentialRef.value });
  }

  refs.sort(compareActivePolicyCredentialRefs);
  return { ok: true, value: refs };
}

export function compareActivePolicyCredentialRefs(
  left: { readonly ruleId: string; readonly credentialRef: VaultHandle },
  right: { readonly ruleId: string; readonly credentialRef: VaultHandle },
): number {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.credentialRef.localeCompare(right.credentialRef)
  );
}

export async function digestPolicyBody(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map(function hexByte(value) {
      return value.toString(16).padStart(2, "0");
    })
    .join("");
}

export function existingPolicyActivation(
  _sql: SqlStorage,
  row: OrganisationPolicyHeadRow,
): Result<OrganisationPolicyActivation, OrganisationStateError> {
  return {
    ok: true,
    value: {
      head: policyHeadFromRow(row),
      consumers: 0,
      delivered: 0,
      pending: 0,
    },
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

export function organisationPlacementConflict(): Result<
  never,
  { readonly code: "organisation_placement_conflict" }
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
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
