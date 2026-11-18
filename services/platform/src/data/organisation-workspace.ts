import type { OrganisationDatabase } from "../database-handles";
import type { WorkspaceRevisionReceipt } from "@seams/contracts";

import {
  parseOrganisationHandle,
  parseWorkspaceHandle,
  parseWorkspaceId,
  type OrganisationHandle,
  type OrganisationId,
  type WorkspaceHandle,
  type WorkspaceId,
} from "../ids";
import type { Result } from "../result";
import {
  commitWorkspaceRevision,
  prepareWorkspaceRevisionMutation,
  readCurrentWorkspaceRevisionReceipt,
  readEstablishedDefaultWorkspaceReceipt,
  type WorkspaceRevisionStoreError,
} from "../workspace-revision-store";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";

type OrganisationWorkspaceRow = {
  readonly workspace_id: unknown;
  readonly created_at: unknown;
};

type OrganisationWorkspaceBinding = {
  readonly workspaceId: WorkspaceId;
  readonly createdAt: number;
};

type OrganisationWorkspaceError =
  | WorkspaceRevisionStoreError
  | { readonly code: "organisation_workspace_binding_failed" }
  | { readonly code: "organisation_workspace_binding_corrupt" };

type OrganisationWorkspacePortalAddressError =
  | { readonly code: "organisation_workspace_portal_address_missing" }
  | { readonly code: "organisation_workspace_portal_address_corrupt" };

type OrganisationWorkspacePortalAddress = Readonly<{
  organisationHandle: OrganisationHandle;
  workspaceHandle: WorkspaceHandle;
}>;

export async function ensureOrganisationDefaultWorkspace(input: {
  readonly scope: OrganisationExecutionScope;
  readonly archive: R2Bucket;
  readonly now: number;
}): Promise<Result<WorkspaceRevisionReceipt, OrganisationWorkspaceError>> {
  // An established workspace answers in one wait: its receipt and the
  // placement fence are read together. Anything else takes the stepwise path
  // below, which reads the fence again before each of its steps.
  const [established, active] = await Promise.all([
    readEstablishedDefaultWorkspaceReceipt(
      input.scope.database,
      input.scope.organisationId,
    ),
    input.scope.isActive(),
  ]);
  if (established !== null && parseWorkspaceId(established.workspaceId).ok) {
    return active
      ? { ok: true, value: established }
      : { ok: false, error: { code: "organisation_placement_conflict" } };
  }
  const binding = await ensureOrganisationDefaultWorkspaceBinding(input);
  if (!binding.ok) return binding;
  const current = await readCurrentWorkspaceRevisionReceipt(
    input.scope.database,
    input.scope.organisationId,
    binding.value.workspaceId,
  );
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (current.ok) return current;
  if (current.error.code !== "workspace_revision_receipt_missing")
    return current;

  const commandId = `workspace-genesis:${binding.value.workspaceId}`;
  const prepared = await prepareWorkspaceRevisionMutation(
    input.scope,
    { kind: "placement" },
    input.archive,
    {
      kind: "genesis",
      organisationId: input.scope.organisationId,
      workspaceId: binding.value.workspaceId,
      idempotencyKey: commandId,
      files: [
        {
          path: "workspace.yaml",
          mediaType: "application/yaml",
          content: [
            "schemaVersion: satyr.workspace.v1",
            `organisationId: ${input.scope.organisationId}`,
            `workspaceId: ${binding.value.workspaceId}`,
            "",
          ].join("\n"),
        },
      ],
      correlationId: commandId,
      causation: { kind: "command", commandId },
      committedAt: binding.value.createdAt,
    },
  );
  if (!prepared.ok) return prepared;
  const committed = await commitWorkspaceRevision(
    input.archive,
    prepared.value,
  );
  if (!committed.ok) return committed;
  const receipt = await readCurrentWorkspaceRevisionReceipt(
    input.scope.database,
    input.scope.organisationId,
    binding.value.workspaceId,
  );
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  return receipt;
}

export async function readOrganisationDefaultWorkspacePortalAddress(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<
    OrganisationWorkspacePortalAddress,
    OrganisationWorkspacePortalAddressError
  >
> {
  let row: {
    readonly organisationHandle: unknown;
    readonly workspaceHandle: unknown;
  } | null;
  try {
    row = await input.db
      .prepare(
        `SELECT organisation.organisation_handle AS organisationHandle,
          organisation_workspace.workspace_handle AS workspaceHandle
       FROM organisation_default_workspace
       JOIN organisation ON organisation.organisation_id = organisation_default_workspace.organisation_id
       JOIN organisation_workspace
         ON organisation_workspace.workspace_id = organisation_default_workspace.workspace_id
       WHERE organisation_default_workspace.organisation_id = ?
         AND organisation_workspace.status = 'active'
       LIMIT 1`,
      )
      .bind(input.organisationId)
      .first<{
        readonly organisationHandle: unknown;
        readonly workspaceHandle: unknown;
      }>();
  } catch {
    return {
      ok: false,
      error: { code: "organisation_workspace_portal_address_missing" },
    };
  }
  if (row === null) {
    return {
      ok: false,
      error: { code: "organisation_workspace_portal_address_missing" },
    };
  }
  const organisationHandle =
    typeof row.organisationHandle === "string"
      ? parseOrganisationHandle(row.organisationHandle)
      : null;
  const workspaceHandle =
    typeof row.workspaceHandle === "string"
      ? parseWorkspaceHandle(row.workspaceHandle)
      : null;
  if (
    organisationHandle === null ||
    !organisationHandle.ok ||
    workspaceHandle === null ||
    !workspaceHandle.ok
  ) {
    return {
      ok: false,
      error: { code: "organisation_workspace_portal_address_corrupt" },
    };
  }
  return {
    ok: true,
    value: {
      organisationHandle: organisationHandle.value,
      workspaceHandle: workspaceHandle.value,
    },
  };
}

async function ensureOrganisationDefaultWorkspaceBinding(input: {
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<Result<OrganisationWorkspaceBinding, OrganisationWorkspaceError>> {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return {
      ok: false,
      error: { code: "organisation_workspace_binding_failed" },
    };
  }
  let existing: OrganisationWorkspaceRow | null;
  try {
    existing = await input.scope.database
      .prepare(
        `SELECT workspace_id, created_at
       FROM organisation_default_workspace
       WHERE organisation_id = ?
       LIMIT 1`,
      )
      .bind(input.scope.organisationId)
      .first<OrganisationWorkspaceRow>();
  } catch {
    return {
      ok: false,
      error: { code: "organisation_workspace_binding_failed" },
    };
  }
  if (existing !== null) {
    return parseOrganisationWorkspaceBinding(existing);
  }
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const candidate = `workspace_${crypto.randomUUID()}`;
  try {
    const workspace = input.scope.database
      .prepare(
        `INSERT OR IGNORE INTO organisation_workspace (
         workspace_id, organisation_id, workspace_handle, name, status, created_at, archived_at
       ) SELECT ?, ?, 'cafe-operations', 'Cafe operations', 'active', ?, NULL
       WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
      )
      .bind(
        candidate,
        input.scope.organisationId,
        input.now,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      );
    const binding = input.scope.database
      .prepare(
        `INSERT OR IGNORE INTO organisation_default_workspace (organisation_id, workspace_id, created_at)
       SELECT organisation_id, workspace_id, created_at
       FROM organisation_workspace
       WHERE organisation_id = ?
         AND workspace_handle = 'cafe-operations' COLLATE NOCASE
         AND status = 'active'
         AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
           AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
       LIMIT 1`,
      )
      .bind(
        input.scope.organisationId,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      );
    await input.scope.database.batch([workspace, binding]);
  } catch {
    return {
      ok: false,
      error: { code: "organisation_workspace_binding_failed" },
    };
  }
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  let row: OrganisationWorkspaceRow | null;
  try {
    row = await input.scope.database
      .prepare(
        `SELECT workspace_id, created_at
       FROM organisation_default_workspace
       WHERE organisation_id = ?
       LIMIT 1`,
      )
      .bind(input.scope.organisationId)
      .first<OrganisationWorkspaceRow>();
  } catch {
    return {
      ok: false,
      error: { code: "organisation_workspace_binding_failed" },
    };
  }
  if (row === null) {
    return {
      ok: false,
      error: { code: "organisation_workspace_binding_failed" },
    };
  }
  return parseOrganisationWorkspaceBinding(row);
}

function parseOrganisationWorkspaceBinding(
  row: OrganisationWorkspaceRow,
): Result<OrganisationWorkspaceBinding, OrganisationWorkspaceError> {
  const workspaceId =
    typeof row.workspace_id === "string"
      ? parseWorkspaceId(row.workspace_id)
      : null;
  return workspaceId !== null &&
    workspaceId.ok &&
    workspaceId.value.startsWith("workspace_") &&
    typeof row.created_at === "number" &&
    Number.isSafeInteger(row.created_at) &&
    row.created_at >= 0
    ? {
        ok: true,
        value: { workspaceId: workspaceId.value, createdAt: row.created_at },
      }
    : { ok: false, error: { code: "organisation_workspace_binding_corrupt" } };
}
