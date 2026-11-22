import { isNonEmptyString, isRecord } from "@purin-labs/std";
import {
  parseSessionId,
  parseOrganisationId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import type { ActorFenceToken } from "./actor-registry";
import type { ActorExportError } from "./actor-export";

export type PortalChatCleanupRequest = Readonly<{
  requestingOrganisationId: OrganisationId;
  sessionId: SessionId;
  placement: OrganisationExecutionScope["placement"];
  placementFenceToken: OrganisationExecutionScope["fenceToken"];
  objectKeys: readonly string[];
}>;

export type PortalChatCleanupError =
  | { readonly code: "chat_cleanup_conflict" }
  | { readonly code: "chat_cleanup_failed"; readonly detail: string };

export type PortalChatErasure =
  | Readonly<{
      kind: "pending";
      organisationId: OrganisationId;
      sessionId: SessionId;
      objectKeys: readonly string[];
    }>
  | Readonly<{
      kind: "erased";
      organisationId: OrganisationId;
      sessionId: SessionId;
      objectKeys?: never;
    }>;

export const PORTAL_CHAT_ERASURE_KEY = "portal-chat-erasure";

export function canAdmitSessionWork(
  sql: SqlStorage,
  request: Pick<
    PortalChatCleanupRequest,
    "requestingOrganisationId" | "sessionId" | "placement"
  >,
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM state_object_activation
      WHERE singleton = 1 AND organisation_id = ? AND object_kind = 'session'
        AND logical_object_id = ? AND placement_epoch = ? AND placement_cell_id = ?
        AND NOT EXISTS (SELECT 1 FROM state_object_cleanup_export_barrier)`,
        request.requestingOrganisationId,
        request.sessionId,
        request.placement.placementEpoch,
        request.placement.placementCellId,
      )
      .toArray().length === 1
  );
}

export async function isPortalChatCleanupPlacementActive(
  db: D1Database,
  request: PortalChatCleanupRequest,
): Promise<boolean> {
  return (
    (await db
      .withSession("first-primary")
      .prepare(
        `SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
      AND placement_cell_id = ? AND fence_token = ? AND status = 'active'`,
      )
      .bind(
        request.requestingOrganisationId,
        request.placement.placementEpoch,
        request.placement.placementCellId,
        request.placementFenceToken,
      )
      .first()) !== null
  );
}

export function closePortalChatCleanupAdmission(
  sql: SqlStorage,
  expectedFenceToken: ActorFenceToken,
): Result<
  { organisationId: OrganisationId; sessionId: SessionId },
  ActorExportError
> {
  const row = sql
    .exec(
      "SELECT organisation_id, logical_object_id, fence_token, object_kind FROM state_object_activation WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined)
    return { ok: false, error: { code: "actor_not_activated" } };
  if (row.fence_token !== expectedFenceToken)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  if (
    typeof row.organisation_id !== "string" ||
    typeof row.logical_object_id !== "string"
  )
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  const organisation = parseOrganisationId(row.organisation_id);
  const session = parseSessionId(row.logical_object_id);
  if (row.object_kind !== "session" || !organisation.ok || !session.ok)
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  sql.exec(
    "INSERT OR IGNORE INTO state_object_cleanup_export_barrier (singleton) VALUES (1)",
  );
  return {
    ok: true,
    value: { organisationId: organisation.value, sessionId: session.value },
  };
}

export async function readPortalChatErasure(
  storage: DurableObjectStorage,
): Promise<PortalChatErasure | null> {
  const raw = await storage.get<unknown>(PORTAL_CHAT_ERASURE_KEY);
  if (raw === undefined) return null;
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    typeof raw.sessionId !== "string"
  )
    throw new Error("portal_chat_erasure_invalid");
  const organisation = parseOrganisationId(raw.organisationId);
  const session = parseSessionId(raw.sessionId);
  if (!organisation.ok || !session.ok)
    throw new Error("portal_chat_erasure_invalid");
  switch (raw.kind) {
    case "pending": {
      if (!Array.isArray(raw.objectKeys))
        throw new Error("portal_chat_erasure_invalid");
      const objectKeys: string[] = [];
      for (const key of raw.objectKeys) {
        if (!isNonEmptyString(key))
          throw new Error("portal_chat_erasure_invalid");
        objectKeys.push(key);
      }
      return {
        kind: "pending",
        organisationId: organisation.value,
        sessionId: session.value,
        objectKeys,
      };
    }
    case "erased":
      if (raw.objectKeys !== undefined)
        throw new Error("portal_chat_erasure_invalid");
      return {
        kind: "erased",
        organisationId: organisation.value,
        sessionId: session.value,
      };
    default:
      throw new Error("portal_chat_erasure_invalid");
  }
}
