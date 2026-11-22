import {
  prepareInstallOrganisationRename,
  prepareInstallOrganisationRow,
  type RowGuard,
} from "./shared-rows/organisation-row";
import type {
  GlobalDatabase,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import type { SurfaceKind } from "@purin-labs/contracts";

import type { InstallModel } from "../boundary";
import {
  newIntegrationAccountId,
  newProviderConnectionId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseWorkspaceId,
  type IntegrationAccountId,
  type OrganisationId,
  type WorkspaceId,
  parseVaultHandle,
  type VaultHandle,
} from "@purin-labs/kernel/ids";
import {
  newUserId,
  parseUserId,
  type UserId,
} from "@purin-labs/control-api/ids";
import {
  parseOrganisationPlacement,
  type InitialOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import type { Result } from "@purin-labs/kernel/result";
import {
  organisationLifecycleParts,
  type OrganisationCreationParts,
} from "./organisation-lifecycle-port";
import {
  ensureInitialOrganisationPlacement,
  prepareInitialOrganisationPlacementInsert,
} from "./shared-rows/placement-row";
import type { OrganisationQuerySource } from "./query-source";
import { assertNever, isString } from "@purin-labs/std";
import { resolveActiveOrganisationPlacementRecord } from "./organisation-placement";
import {
  liveOrganisationGuard,
  prepareInstalledOnboardingRow,
} from "./organisation-lifecycle-moves";

type OrganisationStatus = "active" | "suspended" | "deleted" | "purged";
type InstallStatus = "active" | "revoked" | "disabled";

export type OrganisationInstallSeed = {
  organisationId: OrganisationId;
  name: string;
  surfaceKind: SurfaceKind;
  workspaceId: WorkspaceId;
  installModel: InstallModel;
  botTokenRef: string;
  scopes: readonly string[];
  placement: InitialOrganisationPlacement;
  createdAt: number;
  installedAt: number;
};

export type OrganisationInstallRecord = {
  integrationAccountId: IntegrationAccountId;
  organisationId: OrganisationId;
  name: string;
  plan: "beta";
  organisationStatus: OrganisationStatus;
  surfaceKind: SurfaceKind;
  workspaceId: WorkspaceId;
  installModel: InstallModel;
  botTokenRef: VaultHandle;
  scopes: readonly string[];
  installedAt: number;
  installStatus: InstallStatus;
  lastEventReceivedAt: number | null;
  placement: OrganisationPlacement;
};

export type InstallLivenessRecord = {
  organisationId: OrganisationId;
  name: string;
  surfaceKind: SurfaceKind;
  workspaceId: WorkspaceId;
  installModel: InstallModel;
  installStatus: InstallStatus;
  installedAt: number;
  lastEventReceivedAt: number | null;
};

type InstallLookupKey = {
  surfaceKind: SurfaceKind;
  workspaceId: WorkspaceId;
};

type InstallLookupError = {
  code: "install_not_found";
  surfaceKind: SurfaceKind;
};

type ExistingInstallModelPolicy =
  | { kind: "preserveExistingInstallModel" }
  | { kind: "replaceExistingInstallModel" };

const preserveExistingInstallModel: ExistingInstallModelPolicy = {
  kind: "preserveExistingInstallModel",
};

const replaceExistingInstallModel: ExistingInstallModelPolicy = {
  kind: "replaceExistingInstallModel",
};

type OrganisationInstallRow = {
  integrationAccountId: unknown;
  organisationId: unknown;
  name: string;
  plan: "beta";
  organisationStatus: OrganisationStatus;
  surfaceKind: SurfaceKind;
  workspaceId: unknown;
  installModel: InstallModel;
  botTokenRef: unknown;
  scopes: string;
  installedAt: number;
  installStatus: InstallStatus;
  lastEventReceivedAt: number | null;
  placementKind: unknown;
  placementEpoch: unknown;
  placementCellId: unknown;
  locationHint: unknown;
  residencyJurisdiction: unknown;
};

type InstallLivenessRow = {
  organisationId: unknown;
  name: string;
  surfaceKind: SurfaceKind;
  workspaceId: unknown;
  installModel: InstallModel;
  installStatus: InstallStatus;
  installedAt: number;
  lastEventReceivedAt: number | null;
};

export async function createOrganisationInstall(
  db: OrganisationDatabase,
  identityDatabase: GlobalDatabase,
  seed: OrganisationInstallSeed,
): Promise<OrganisationInstallRecord> {
  return createOrganisationInstallWithInstallModelPolicy(
    db,
    identityDatabase,
    seed,
    replaceExistingInstallModel,
  );
}

export async function createOrganisationInstallPreservingExistingInstallModel(
  db: OrganisationDatabase,
  identityDatabase: GlobalDatabase,
  seed: OrganisationInstallSeed,
): Promise<OrganisationInstallRecord> {
  return createOrganisationInstallWithInstallModelPolicy(
    db,
    identityDatabase,
    seed,
    preserveExistingInstallModel,
  );
}

async function createOrganisationInstallWithInstallModelPolicy(
  db: OrganisationDatabase,
  identityDatabase: GlobalDatabase,
  seed: OrganisationInstallSeed,
  existingInstallModel: ExistingInstallModelPolicy,
): Promise<OrganisationInstallRecord> {
  const parts = organisationLifecycleParts().creation;
  const botTokenRef = requireVaultHandle(seed.botTokenRef);
  const existing = await resolveInstallOrganisation(db, {
    surfaceKind: seed.surfaceKind,
    workspaceId: seed.workspaceId,
  });

  if (existing.ok) {
    const placement = await ensureInitialOrganisationPlacement({
      db,
      organisationId: existing.value.organisationId,
      environment: "development",
      placement: seed.placement,
      now: seed.createdAt,
    });

    if (!placement.ok) {
      throw new Error(placement.error.code);
    }

    return updateOrganisationInstall(
      parts,
      db,
      existing.value,
      { ...seed, botTokenRef },
      existingInstallModel,
    );
  }

  const userId = await ensureSystemUserId(identityDatabase, seed);
  const providerConnectionId = newProviderConnectionId();
  const integrationAccountId = newIntegrationAccountId();
  const defaultProjectId = await parts.baseProjectId(seed.organisationId);
  const session = db.withSession("first-primary");

  await session.batch([
    prepareInstallOrganisationRow(session, {
      organisationId: seed.organisationId,
      name: seed.name,
      createdAt: seed.createdAt,
    }),
    ...parts.surfaceInstall(session, {
      surfaceKind: seed.surfaceKind,
      providerConnectionId,
      integrationAccountId,
      organisationId: seed.organisationId,
      botTokenRef,
      scopesJson: JSON.stringify(seed.scopes),
      userId,
      workspaceId: seed.workspaceId,
      name: seed.name,
      capabilitySetJson: JSON.stringify(surfaceCapabilities(seed.surfaceKind)),
      audiencePolicyJson: JSON.stringify({ kind: "operator" }),
      retentionPolicyJson: JSON.stringify({ kind: "organisation_default" }),
      createdAt: seed.createdAt,
      installedAt: seed.installedAt,
    }),
    prepareSurfaceInstallationInsert(
      session,
      integrationAccountId,
      botTokenRef,
      seed,
    ),
    prepareInstalledOnboardingRow(session, {
      organisationId: seed.organisationId,
      installedAt: seed.installedAt,
    }),
    prepareInitialOrganisationPlacementInsert(
      session,
      seed.organisationId,
      "development",
      seed.placement,
      seed.createdAt,
    ),
    ...parts.accessDefaults(session, {
      organisationId: seed.organisationId,
      placement: seed.placement,
      materializationReceiptId: `system-install:${seed.organisationId}`,
      now: seed.installedAt,
    }),
    // An install has no member yet, so its Base starts without an owner.
    ...parts.baseProject(session, {
      organisationId: seed.organisationId,
      projectId: defaultProjectId,
      ownerUserId: null,
      now: seed.createdAt,
    }),
  ]);

  const created = await resolveInstallOrganisation(session, {
    surfaceKind: seed.surfaceKind,
    workspaceId: seed.workspaceId,
  });

  if (!created.ok) {
    throw new Error(
      "organisation install create did not produce a resolvable install",
    );
  }

  return created.value;
}

async function updateOrganisationInstall(
  parts: OrganisationCreationParts,
  db: OrganisationDatabase,
  existing: OrganisationInstallRecord,
  seed: OrganisationInstallSeed & { readonly botTokenRef: VaultHandle },
  existingInstallModel: ExistingInstallModelPolicy,
): Promise<OrganisationInstallRecord> {
  const defaultProjectId = await parts.baseProjectId(existing.organisationId);
  const session = db.withSession("first-primary");
  // A repeat install reactivates the provider connection and the account. It
  // may do so only for an Organisation in use, under its placement fence
  // (Refactor 15): every statement carries the guard, so an archived, purging
  // or purged Organisation, or a moved one, keeps what it has.
  const placement = await resolveActiveOrganisationPlacementRecord(
    session,
    existing.organisationId,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  const live = liveOrganisationGuard({
    organisationId: existing.organisationId,
    placement: placement.value.placement,
    fenceToken: placement.value.fenceToken,
  });

  const [renamed] = await session.batch([
    prepareInstallOrganisationRename(session, {
      organisationId: existing.organisationId,
      name: seed.name,
      guard: live,
    }),
    ...parts.surfaceReinstall(session, {
      organisationId: existing.organisationId,
      integrationAccountId: existing.integrationAccountId,
      botTokenRef: seed.botTokenRef,
      name: seed.name,
      capabilitySetJson: JSON.stringify(surfaceCapabilities(seed.surfaceKind)),
      audiencePolicyJson: JSON.stringify({ kind: "operator" }),
      retentionPolicyJson: JSON.stringify({ kind: "organisation_default" }),
      installedAt: seed.installedAt,
      live,
    }),
    parts.replacedSurfaceTokenRevocation(session, {
      installedAt: seed.installedAt,
      organisationId: existing.organisationId,
      integrationAccountId: existing.integrationAccountId,
      botTokenRef: seed.botTokenRef,
      guard: live,
    }),
    prepareSurfaceInstallationUpdate(
      session,
      existing.integrationAccountId,
      seed,
      existingInstallModel,
      live,
    ),
  ]);
  if (renamed?.meta.changes !== 1)
    throw new Error("organisation_lifecycle_conflict");
  await session.batch([
    ...parts.baseProject(session, {
      organisationId: existing.organisationId,
      projectId: defaultProjectId,
      ownerUserId: null,
      now: seed.installedAt,
    }),
  ]);

  const updated = await resolveInstallOrganisation(session, {
    surfaceKind: seed.surfaceKind,
    workspaceId: seed.workspaceId,
  });

  if (!updated.ok) {
    throw new Error(
      "organisation install update did not produce a resolvable install",
    );
  }

  return updated.value;
}

function prepareSurfaceInstallationUpdate(
  session: OrganisationDatabaseSession,
  integrationAccountId: IntegrationAccountId,
  seed: OrganisationInstallSeed & { readonly botTokenRef: VaultHandle },
  existingInstallModel: ExistingInstallModelPolicy,
  live: RowGuard,
): D1PreparedStatement {
  switch (existingInstallModel.kind) {
    case "preserveExistingInstallModel":
      return session
        .prepare(
          `UPDATE surface_installation
           SET bot_token_ref = ?,
               scopes = ?,
               installed_at = ?,
               last_event_received_at = NULL
           WHERE integration_account_id = ? AND ${live.sql}`,
        )
        .bind(
          seed.botTokenRef,
          JSON.stringify(seed.scopes),
          seed.installedAt,
          integrationAccountId,
          ...live.bindings,
        );
    case "replaceExistingInstallModel":
      return session
        .prepare(
          `UPDATE surface_installation
           SET install_model = ?,
               bot_token_ref = ?,
               scopes = ?,
               installed_at = ?,
               last_event_received_at = NULL
           WHERE integration_account_id = ? AND ${live.sql}`,
        )
        .bind(
          seed.installModel,
          seed.botTokenRef,
          JSON.stringify(seed.scopes),
          seed.installedAt,
          integrationAccountId,
          ...live.bindings,
        );
    default:
      return assertNever(existingInstallModel);
  }
}

export async function resolveInstallOrganisation(
  db: OrganisationQuerySource,
  key: InstallLookupKey,
): Promise<Result<OrganisationInstallRecord, InstallLookupError>> {
  const row = await db
    .prepare(
      `SELECT
         integration_account.integration_account_id AS integrationAccountId,
         organisation.organisation_id AS organisationId,
         organisation.name AS name,
         organisation.plan AS plan,
         organisation.status AS organisationStatus,
         surface_installation.surface_kind AS surfaceKind,
         surface_installation.workspace_id AS workspaceId,
         surface_installation.install_model AS installModel,
         surface_installation.bot_token_ref AS botTokenRef,
         surface_installation.scopes AS scopes,
         surface_installation.installed_at AS installedAt,
         CASE integration_account.lifecycle
           WHEN 'active' THEN 'active'
           WHEN 'revoked' THEN 'revoked'
           ELSE 'disabled'
         END AS installStatus,
         surface_installation.last_event_received_at AS lastEventReceivedAt,
         organisation_placement.placement_kind AS placementKind,
         organisation_placement.placement_epoch AS placementEpoch,
         organisation_placement.placement_cell_id AS placementCellId,
         organisation_placement.location_hint AS locationHint,
         organisation_placement.residency_jurisdiction AS residencyJurisdiction
       FROM surface_installation
       JOIN integration_account
         ON integration_account.integration_account_id = surface_installation.integration_account_id
       JOIN organisation ON organisation.organisation_id = surface_installation.organisation_id
       JOIN organisation_placement
         ON organisation_placement.organisation_id = organisation.organisation_id
        AND organisation_placement.status = 'active'
       WHERE surface_installation.surface_kind = ? AND surface_installation.workspace_id = ?`,
    )
    .bind(key.surfaceKind, key.workspaceId)
    .first<OrganisationInstallRow>();

  if (row === null) {
    return {
      ok: false,
      error: { code: "install_not_found", surfaceKind: key.surfaceKind },
    };
  }

  return { ok: true, value: rowToOrganisationInstallRecord(row) };
}

export async function listInstallLiveness(input: {
  db: OrganisationDatabase;
  surfaceKind: SurfaceKind;
}): Promise<readonly InstallLivenessRecord[]> {
  const rows = await input.db
    .prepare(
      `SELECT
         organisation.organisation_id AS organisationId,
         organisation.name AS name,
         surface_installation.surface_kind AS surfaceKind,
         surface_installation.workspace_id AS workspaceId,
         surface_installation.install_model AS installModel,
         CASE integration_account.lifecycle
           WHEN 'active' THEN 'active'
           WHEN 'revoked' THEN 'revoked'
           ELSE 'disabled'
         END AS installStatus,
         surface_installation.installed_at AS installedAt,
         surface_installation.last_event_received_at AS lastEventReceivedAt
       FROM surface_installation
       JOIN integration_account
         ON integration_account.integration_account_id = surface_installation.integration_account_id
       JOIN organisation ON organisation.organisation_id = surface_installation.organisation_id
       WHERE surface_installation.surface_kind = ?
       ORDER BY surface_installation.last_event_received_at ASC,
                surface_installation.installed_at ASC`,
    )
    .bind(input.surfaceKind)
    .all<InstallLivenessRow>();

  return (rows.results ?? []).map(rowToInstallLivenessRecord);
}

function prepareSurfaceInstallationInsert(
  session: OrganisationDatabaseSession,
  integrationAccountId: IntegrationAccountId,
  botTokenRef: VaultHandle,
  seed: OrganisationInstallSeed,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT INTO surface_installation (
       integration_account_id, organisation_id, surface_kind, workspace_id, install_model,
       bot_token_ref, scopes, installed_at, last_event_received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      integrationAccountId,
      seed.organisationId,
      seed.surfaceKind,
      seed.workspaceId,
      seed.installModel,
      botTokenRef,
      JSON.stringify(seed.scopes),
      seed.installedAt,
    );
}

function surfaceCapabilities(surfaceKind: SurfaceKind): readonly string[] {
  switch (surfaceKind) {
    case "slack":
    case "discord":
    case "telegram":
    case "whatsapp":
    case "teams":
    case "line-works":
      return ["conversation.read", "conversation.write"];
    case "gdrive":
    case "dropbox":
      return ["file.read", "file.write"];
    default:
      return assertNever(surfaceKind);
  }
}

function rowToInstallLivenessRecord(
  row: InstallLivenessRow,
): InstallLivenessRecord {
  return {
    organisationId: requireOrganisationId(row.organisationId),
    name: row.name,
    surfaceKind: row.surfaceKind,
    workspaceId: requireWorkspaceId(row.workspaceId),
    installModel: row.installModel,
    installStatus: row.installStatus,
    installedAt: row.installedAt,
    lastEventReceivedAt: row.lastEventReceivedAt,
  };
}

function rowToOrganisationInstallRecord(
  row: OrganisationInstallRow,
): OrganisationInstallRecord {
  const integrationAccountId = requireIntegrationAccountId(
    row.integrationAccountId,
  );
  const organisationId = requireOrganisationId(row.organisationId);
  const workspaceId = requireWorkspaceId(row.workspaceId);
  const botTokenRef = requireVaultHandle(row.botTokenRef);
  const placement = parseOrganisationPlacement({
    kind: row.placementKind,
    placementEpoch: row.placementEpoch,
    placementCellId: row.placementCellId,
    locationHint: row.locationHint,
    ...(row.placementKind === "residency"
      ? { residencyJurisdiction: row.residencyJurisdiction }
      : {}),
  });

  if (!placement.ok) {
    throw new Error("organisation_placement_corrupt");
  }

  return {
    integrationAccountId,
    organisationId,
    name: row.name,
    plan: row.plan,
    organisationStatus: row.organisationStatus,
    surfaceKind: row.surfaceKind,
    workspaceId,
    installModel: row.installModel,
    botTokenRef,
    scopes: parseScopes(row.scopes),
    installedAt: row.installedAt,
    installStatus: row.installStatus,
    lastEventReceivedAt: row.lastEventReceivedAt,
    placement: placement.value,
  };
}

function parseScopes(scopes: string): readonly string[] {
  const parsed: unknown = JSON.parse(scopes);
  if (!Array.isArray(parsed) || !parsed.every(isString)) {
    throw new Error("surface_installation_scopes_corrupt");
  }
  return parsed;
}

function requireIntegrationAccountId(raw: unknown): IntegrationAccountId {
  if (typeof raw !== "string") {
    throw new Error("integration_account_id_corrupt");
  }
  const parsed = parseIntegrationAccountId(raw);
  if (!parsed.ok) {
    throw new Error("integration_account_id_corrupt");
  }
  return parsed.value;
}

function requireOrganisationId(raw: unknown): OrganisationId {
  if (typeof raw !== "string") {
    throw new Error("organisation_id_corrupt");
  }
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) {
    throw new Error("organisation_id_corrupt");
  }
  return parsed.value;
}

function requireWorkspaceId(raw: unknown): WorkspaceId {
  if (typeof raw !== "string") {
    throw new Error("workspace_id_corrupt");
  }
  const parsed = parseWorkspaceId(raw);
  if (!parsed.ok) {
    throw new Error("workspace_id_corrupt");
  }
  return parsed.value;
}

function requireVaultHandle(raw: unknown): VaultHandle {
  if (typeof raw !== "string") {
    throw new Error("bot_token_ref_corrupt");
  }
  const parsed = parseVaultHandle(raw);
  if (!parsed.ok) {
    throw new Error("bot_token_ref_corrupt");
  }
  return parsed.value;
}

async function ensureSystemUserId(
  db: GlobalDatabase,
  seed: OrganisationInstallSeed,
): Promise<UserId> {
  const row = await db
    .prepare(
      `INSERT INTO app_user
    (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at)
    VALUES (?, 'urn:pantry:system', ?, ?, 'Purin Pantry system', 0, ?, ?)
    ON CONFLICT (issuer, subject) DO UPDATE SET last_authenticated_at = excluded.last_authenticated_at
    RETURNING user_id AS userId`,
    )
    .bind(
      newUserId(),
      seed.organisationId,
      `${seed.organisationId}@system.invalid`,
      seed.createdAt,
      seed.createdAt,
    )
    .first<{ userId: string }>();
  if (row === null) throw new Error("stored_system_user_missing");
  const parsed = parseUserId(row.userId);
  if (!parsed.ok) throw new Error("stored_system_user_invalid");
  return parsed.value;
}
