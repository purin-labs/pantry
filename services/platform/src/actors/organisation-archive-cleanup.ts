import {
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import {
  parseOrganisationId,
  type SessionId,
  type OrganisationId,
} from "../ids";
import { parseOrganisationPlacement } from "../placement";
import {
  isOrganisationPolicyPlacementActive,
  parseOrganisationPlacementFenceToken,
  type OrganisationPolicyPlacement,
} from "../data/organisation-placement";
import type { ActorFenceToken } from "./actor-registry";
import type { ActorExportError } from "./actor-export";
import type { Result } from "../result";

export type OrganisationArchiveCleanupRequest = Readonly<{
  organisationId: OrganisationId;
  placement: OrganisationPolicyPlacement;
  now: number;
}>;

export type OrganisationArchiveCleanupError =
  | { readonly code: "organisation_archive_cleanup_conflict" }
  | {
      readonly code: "organisation_archive_cleanup_failed";
      readonly detail: string;
    };

export type HarnessHistoryErasureRequest = Readonly<{
  requestingOrganisationId: OrganisationId;
  sessionId: SessionId;
  expectedActorFenceToken: ActorFenceToken;
  placement: OrganisationPolicyPlacement;
  archiveReceiptId: string;
}>;

export const ORGANISATION_ARCHIVE_CLEANUP_KEY = "organisation-archive-cleanup";

export class AdmittedOrganisationArchiveCleanup {
  readonly #request: OrganisationArchiveCleanupRequest;

  private constructor(request: OrganisationArchiveCleanupRequest) {
    this.#request = request;
  }

  get request(): OrganisationArchiveCleanupRequest {
    return this.#request;
  }
  get organisationId(): OrganisationId {
    return this.#request.organisationId;
  }
  get placement(): OrganisationPolicyPlacement {
    return this.#request.placement;
  }
  get now(): number {
    return this.#request.now;
  }

  static async admit(
    db: D1Database,
    storage: DurableObjectStorage,
    input: OrganisationArchiveCleanupRequest,
  ): Promise<
    Result<AdmittedOrganisationArchiveCleanup, OrganisationArchiveCleanupError>
  > {
    if (
      !(await isOrganisationPolicyPlacementActive(
        db,
        input.organisationId,
        input.placement,
      ))
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    const pending = await readOrganisationArchiveCleanup(storage);
    if (
      pending !== null &&
      (pending.organisationId !== input.organisationId ||
        pending.placement.fenceToken !== input.placement.fenceToken)
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    if (!canAdmitOrganisationArchiveCleanup(storage.sql, input))
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    const admitted =
      pending ??
      new AdmittedOrganisationArchiveCleanup({
        organisationId: input.organisationId,
        placement: input.placement,
        now: input.now,
      });
    await storage.put(ORGANISATION_ARCHIVE_CLEANUP_KEY, {
      kind: "admitted",
      request: admitted.request,
    });
    return { ok: true, value: admitted };
  }

  static fromStored(raw: unknown): AdmittedOrganisationArchiveCleanup {
    if (!isRecord(raw) || raw.kind !== "admitted")
      throw new Error("organisation_archive_cleanup_invalid");
    return new AdmittedOrganisationArchiveCleanup(
      parseArchiveCleanupRequest(raw.request),
    );
  }
}

export function canAdmitOrganisationArchiveCleanup(
  sql: SqlStorage,
  request: OrganisationArchiveCleanupRequest,
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM state_object_activation
     WHERE singleton = 1 AND object_kind = 'organisation' AND organisation_id = ?
       AND placement_epoch = ? AND placement_cell_id = ?
       AND NOT EXISTS (SELECT 1 FROM state_object_policy_export_barrier)`,
        request.organisationId,
        request.placement.placement.placementEpoch,
        request.placement.placement.placementCellId,
      )
      .toArray().length === 1
  );
}

export function closeOrganisationArchiveCleanupAdmission(
  sql: SqlStorage,
  fence: ActorFenceToken,
): Result<OrganisationId, ActorExportError> {
  const activation = sql
    .exec(
      "SELECT organisation_id, object_kind, fence_token FROM state_object_activation WHERE singleton = 1",
    )
    .toArray()[0];
  if (activation === undefined)
    return { ok: false, error: { code: "actor_not_activated" } };
  if (activation.fence_token !== fence)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  if (
    activation.object_kind !== "organisation" ||
    typeof activation.organisation_id !== "string"
  )
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  const organisation = parseOrganisationId(activation.organisation_id);
  if (!organisation.ok)
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  // The Organisation's export barrier closes policy and archive cleanup together.
  sql.exec(
    "INSERT OR IGNORE INTO state_object_policy_export_barrier (singleton) VALUES (1)",
  );
  return { ok: true, value: organisation.value };
}

export async function readOrganisationArchiveCleanup(
  storage: DurableObjectStorage,
): Promise<AdmittedOrganisationArchiveCleanup | null> {
  const raw = await storage.get<unknown>(ORGANISATION_ARCHIVE_CLEANUP_KEY);
  if (raw === undefined) return null;
  return AdmittedOrganisationArchiveCleanup.fromStored(raw);
}

function parseArchiveCleanupRequest(
  raw: unknown,
): OrganisationArchiveCleanupRequest {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    !isNonNegativeInteger(raw.now) ||
    !isRecord(raw.placement)
  )
    throw new Error("organisation_archive_cleanup_invalid");
  const organisation = parseOrganisationId(raw.organisationId);
  const placement = parseOrganisationPlacement(raw.placement.placement);
  const fence = parseOrganisationPlacementFenceToken(raw.placement.fenceToken);
  if (!organisation.ok || !placement.ok || !fence.ok)
    throw new Error("organisation_archive_cleanup_invalid");
  return {
    organisationId: organisation.value,
    placement: { placement: placement.value, fenceToken: fence.value },
    now: raw.now,
  };
}

export async function canEraseArchivedHarnessHistory(
  env: OrganisationPlacementBindings,
  sql: SqlStorage,
  request: HarnessHistoryErasureRequest,
): Promise<boolean> {
  const selected = selectOrganisationPlacementDatabase(
    env,
    request.requestingOrganisationId,
    request.placement.placement,
  );
  if (!selected.ok) return false;
  const directory = await env.DB.withSession("first-primary")
    .prepare(
      `SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
      AND placement_cell_id = ? AND fence_token = ? AND status IN ('active', 'frozen')`,
    )
    .bind(
      request.requestingOrganisationId,
      request.placement.placement.placementEpoch,
      request.placement.placement.placementCellId,
      request.placement.fenceToken,
    )
    .first();
  if (directory === null) return false;
  const authorized = await selected.value
    .withSession("first-primary")
    .prepare(
      `SELECT 1 FROM organisation_archive_cleanup AS cleanup
     JOIN organisation_onboarding AS organisation ON organisation.organisation_id = cleanup.organisation_id
     JOIN organisation_harness_erasure AS erasure ON erasure.organisation_id = cleanup.organisation_id
     JOIN organisation_placement AS placement ON placement.organisation_id = cleanup.organisation_id
     JOIN durable_object_registry AS registry ON registry.organisation_id = cleanup.organisation_id
     WHERE cleanup.organisation_id = ? AND cleanup.archive_receipt_id = ?
       AND cleanup.status = 'pending_purge' AND organisation.lifecycle IN ('archived', 'purging')
       AND erasure.status = 'erasing'
       AND placement.placement_epoch = ? AND placement.placement_cell_id = ?
       AND placement.fence_token = ? AND placement.status IN ('active', 'frozen')
       AND registry.object_kind = 'session' AND registry.logical_object_id = ?
       AND registry.fence_token = ? AND registry.lifecycle_status IN ('active', 'retired')`,
    )
    .bind(
      request.requestingOrganisationId,
      request.archiveReceiptId,
      request.placement.placement.placementEpoch,
      request.placement.placement.placementCellId,
      request.placement.fenceToken,
      request.sessionId,
      request.expectedActorFenceToken,
    )
    .first();
  if (authorized === null) return false;
  return (
    sql
      .exec(
        `SELECT 1 FROM state_object_activation WHERE singleton = 1 AND object_kind = 'session'
     AND organisation_id = ? AND logical_object_id = ? AND fence_token = ?`,
        request.requestingOrganisationId,
        request.sessionId,
        request.expectedActorFenceToken,
      )
      .toArray().length === 1
  );
}
