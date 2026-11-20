import type {
  GlobalDatabase,
  GlobalDatabaseSession,
} from "../database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type { InstallModel } from "../boundary";
import type { OrganisationEnvironment } from "../data/control-plane";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import {
  parseCaseId,
  parseChannelId,
  parseUserId,
  parseIntegrationAccountId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
  parseOrganisationId,
  parseWorkspaceId,
  type CaseId,
  type ChannelId,
  type UserId,
  type IntegrationAccountId,
  type SlackAppId,
  type SlackInstallationId,
  type SlackOrganisationConnectionId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import type { Result } from "../result";
import { parseSlackUserId, type SlackUserId } from "./events";
import type { Variant } from "@purin-labs/type-utils";
import { isNonNegativeInteger, isPositiveInteger } from "@purin-labs/std";
import { prepareVaultSecretRevocation } from "../credential-vault/secret-revocation";
import { prepareDisconnectedAccountRevocation } from "../data/integration-account-writes";
import { prepareDisconnectedAccountConnectionRevocation } from "../data/provider-connection-writes";
import { prepareDisconnectedAccountGenerationsRevocation } from "../data/provider-credential-generation";

type SlackInstallationSeed = {
  readonly installationId: SlackInstallationId;
  readonly environment: OrganisationEnvironment;
  readonly appId: SlackAppId;
  readonly workspaceId: WorkspaceId;
  readonly credentialOrganisationId: OrganisationId;
  readonly botTokenRef: VaultHandle;
  readonly installModel: InstallModel;
  readonly scopes: readonly string[];
  readonly installedAt: number;
};

type SlackOrganisationConnectionSeed = {
  readonly connectionId: SlackOrganisationConnectionId;
  readonly installationId: SlackInstallationId;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectedAt: number;
};

type SlackInstallationResolution =
  | { readonly kind: "available" }
  | {
      readonly kind: "existing";
      readonly installationId: SlackInstallationId;
      readonly credentialOrganisationId: OrganisationId;
      readonly botTokenRef: VaultHandle;
      readonly lifecycle: "active" | "disabled" | "revoked";
    }
  | { readonly kind: "corrupt" };

export type SlackChannelDefaultChange =
  | {
      readonly kind: "bind_unbound";
      readonly installationId: SlackInstallationId;
      readonly channelId: ChannelId;
      readonly destinationConnectionId: SlackOrganisationConnectionId;
      readonly destinationOrganisationId: OrganisationId;
      readonly boundByUserId: UserId;
      readonly changedAt: number;
    }
  | {
      readonly kind: "replace";
      readonly installationId: SlackInstallationId;
      readonly channelId: ChannelId;
      readonly expectedRevision: number;
      readonly sourceOrganisationId: OrganisationId;
      readonly destinationConnectionId: SlackOrganisationConnectionId;
      readonly destinationOrganisationId: OrganisationId;
      readonly boundByUserId: UserId;
      readonly changedAt: number;
    };

export type SlackChannelDefault = {
  readonly installationId: SlackInstallationId;
  readonly channelId: ChannelId;
  readonly connectionId: SlackOrganisationConnectionId;
  readonly organisationId: OrganisationId;
  readonly revision: number;
  readonly boundByUserId: UserId;
  readonly boundAt: number;
};

type SlackChannelDefaultChangeError = {
  readonly code:
    | "slack_channel_default_conflict"
    | "slack_channel_destination_inactive"
    | "slack_channel_default_corrupt";
};

export type SlackThreadRouteRequest =
  | {
      readonly kind: "root";
      readonly environment: OrganisationEnvironment;
      readonly appId: SlackAppId;
      readonly workspaceId: WorkspaceId;
      readonly channelId: ChannelId;
      readonly rootMessageTs: string;
      readonly caseId: CaseId;
      readonly occurredAt: number;
      readonly externalUserId: SlackUserId;
    }
  | {
      readonly kind: "reply";
      readonly environment: OrganisationEnvironment;
      readonly appId: SlackAppId;
      readonly workspaceId: WorkspaceId;
      readonly channelId: ChannelId;
      readonly rootMessageTs: string;
    };

export type ResolvedSlackThreadRoute = {
  readonly installationId: SlackInstallationId;
  readonly connectionId: SlackOrganisationConnectionId;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly credentialOrganisationId: OrganisationId;
  readonly botTokenRef: VaultHandle;
  readonly caseId: CaseId;
  readonly routingSource: {
    readonly kind: "channel_default" | "dm_selection";
    readonly revision: number;
  };
  /**
   * The organisation's published placement, read from the directory with the
   * route. It addresses the organisation's actors and grants nothing: every
   * receiver resolves its own execution scope. Null while no placement is
   * published, as during a relocation freeze.
   */
  readonly placement: OrganisationPlacement | null;
};

type SlackThreadRouteResolution =
  | { readonly kind: "resolved"; readonly value: ResolvedSlackThreadRoute }
  | { readonly kind: "unbound" }
  | {
      readonly kind: "disabled";
      readonly boundary: "installation" | "organisation_connection";
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "installation_missing"
        | "thread_pin_missing"
        | "routing_record_corrupt";
    };

type ActiveSlackDestinationConnection = {
  readonly installationId: SlackInstallationId;
  readonly connectionId: SlackOrganisationConnectionId;
  readonly integrationAccountId: IntegrationAccountId;
};

export type SlackOrganisationRoutingProjection = {
  readonly installationId: SlackInstallationId;
  readonly connectionId: SlackOrganisationConnectionId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "active" | "disabled" | "revoked";
  readonly channelDefaults: readonly SlackChannelDefault[];
  /** Another organisation also has an active connection on this Slack
   * workspace, so each person chooses where their DMs start. */
  readonly sharedWorkspace: boolean;
};

type SlackOrganisationRoutingRow = {
  readonly installationId: unknown;
  readonly connectionId: unknown;
  readonly integrationAccountId: unknown;
  readonly workspaceId: unknown;
  readonly lifecycle: unknown;
  readonly otherActiveConnections: unknown;
};

type SlackChannelDefaultRow = {
  readonly installationId: unknown;
  readonly channelId: unknown;
  readonly connectionId: unknown;
  readonly organisationId: unknown;
  readonly revision: unknown;
  readonly boundByUserId: unknown;
  readonly boundAt: unknown;
};

type SlackThreadRouteRow = {
  readonly installationId: unknown;
  readonly installationLifecycle: unknown;
  readonly connectionId: unknown;
  readonly connectionLifecycle: unknown;
  readonly organisationId: unknown;
  readonly integrationAccountId: unknown;
  readonly credentialOrganisationId: unknown;
  readonly botTokenRef: unknown;
  readonly caseId: unknown;
  readonly routingSourceKind: unknown;
  readonly routingSourceRevision: unknown;
  readonly placementKind: unknown;
  readonly placementEpoch: unknown;
  readonly placementCellId: unknown;
  readonly locationHint: unknown;
  readonly residencyJurisdiction: unknown;
};

type SlackRouteStateRow = {
  readonly installationLifecycle: unknown;
  readonly connectionLifecycle: unknown;
  readonly channelId: unknown;
};

const SLACK_MESSAGE_TS_PATTERN = /^\d+\.\d+$/u;

export async function createSlackInstallation(
  db: GlobalDatabase,
  seed: SlackInstallationSeed,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO slack_installation (
         installation_id, environment, app_id, workspace_id,
         credential_organisation_id, bot_token_ref, install_model, scopes_json,
         lifecycle, installed_at, updated_at, disabled_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
    )
    .bind(
      seed.installationId,
      seed.environment,
      seed.appId,
      seed.workspaceId,
      seed.credentialOrganisationId,
      seed.botTokenRef,
      seed.installModel,
      JSON.stringify(seed.scopes),
      seed.installedAt,
      seed.installedAt,
    )
    .run();
}

export async function resolveSlackInstallation(
  db: Pick<GlobalDatabase, "prepare">,
  identity: Readonly<{
    environment: OrganisationEnvironment;
    appId: SlackAppId;
    workspaceId: WorkspaceId;
  }>,
): Promise<SlackInstallationResolution> {
  const row = await db
    .prepare(
      `SELECT installation_id AS installationId,
              credential_organisation_id AS credentialOrganisationId,
              bot_token_ref AS botTokenRef, lifecycle
       FROM slack_installation
       WHERE environment = ? AND app_id = ? AND workspace_id = ?`,
    )
    .bind(identity.environment, identity.appId, identity.workspaceId)
    .first<{
      readonly installationId: unknown;
      readonly credentialOrganisationId: unknown;
      readonly botTokenRef: unknown;
      readonly lifecycle: unknown;
    }>();
  if (row === null) return { kind: "available" };
  const installationId = parseStringId(
    row.installationId,
    parseSlackInstallationId,
  );
  const credentialOrganisationId = parseStringId(
    row.credentialOrganisationId,
    parseOrganisationId,
  );
  const botTokenRef = parseStringId(row.botTokenRef, parseVaultHandle);
  if (
    installationId === null ||
    credentialOrganisationId === null ||
    botTokenRef === null ||
    (row.lifecycle !== "active" &&
      row.lifecycle !== "disabled" &&
      row.lifecycle !== "revoked")
  ) {
    return { kind: "corrupt" };
  }
  return {
    kind: "existing",
    installationId,
    credentialOrganisationId,
    botTokenRef,
    lifecycle: row.lifecycle,
  };
}

export async function activateSlackInstallation(input: {
  readonly db: GlobalDatabase;
  readonly installationId: SlackInstallationId;
  /** The Organisation whose Vault holds the bot token from now on. */
  readonly credentialOrganisationId: OrganisationId;
  readonly botTokenRef: VaultHandle;
  readonly scopes: readonly string[];
  readonly activatedAt: number;
}): Promise<boolean> {
  const result = await input.db
    .prepare(
      `UPDATE slack_installation
       SET credential_organisation_id = ?, bot_token_ref = ?, scopes_json = ?,
           lifecycle = 'active', updated_at = ?, disabled_at = NULL, revoked_at = NULL
       WHERE installation_id = ?`,
    )
    .bind(
      input.credentialOrganisationId,
      input.botTokenRef,
      JSON.stringify(input.scopes),
      input.activatedAt,
      input.installationId,
    )
    .run();
  return result.meta.changes === 1;
}

// The connection records below live in the global directory. An Organisation's
// own account rows are regional, so a change to both is two statements on two
// databases. Each directory statement only moves a record forward and is safe
// to repeat after the regional change.

// A reconnect gives the connection a new revision: its active record is
// disabled here and `createSlackOrganisationConnection` activates it again.
export async function disableSlackOrganisationConnection(
  directory: GlobalDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): Promise<void> {
  await directory
    .prepare(
      `UPDATE slack_organisation_connection
       SET lifecycle = 'disabled', revision = revision + 1,
           updated_at = ?, disabled_at = ?, revoked_at = NULL
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'active'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.integrationAccountId,
    )
    .run();
}

// The record of an account that was disabled and is now removed.
export async function revokeDisabledSlackOrganisationConnection(
  directory: GlobalDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): Promise<void> {
  await directory.batch([
    directory
      .prepare(
        `UPDATE slack_organisation_connection
       SET lifecycle = 'revoked', revision = revision + 1,
           updated_at = ?, disabled_at = NULL, revoked_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'disabled'`,
      )
      .bind(
        input.now,
        input.now,
        input.organisationId,
        input.integrationAccountId,
      ),
    prepareRevokedDmSelectionRelease(directory, input.organisationId),
  ]);
}

/**
 * A person's DM choice that names a revoked connection of the Organisation
 * goes, so that their next DM asks them to choose again (or takes the
 * workspace's only connection) instead of reaching a revoked one.
 */
function prepareRevokedDmSelectionRelease(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
): D1PreparedStatement {
  return directory
    .prepare(
      `DELETE FROM slack_dm_organisation_selection
       WHERE EXISTS (SELECT 1 FROM slack_organisation_connection AS connection
         WHERE connection.installation_id = slack_dm_organisation_selection.installation_id
           AND connection.connection_id = slack_dm_organisation_selection.connection_id
           AND connection.organisation_id = ? AND connection.lifecycle = 'revoked')`,
    )
    .bind(organisationId);
}

// Every record of an archived Organisation whose provider cleanup is done.
export async function revokeSlackOrganisationConnections(
  directory: GlobalDatabase,
  input: Readonly<{ organisationId: OrganisationId; now: number }>,
): Promise<number> {
  const [result] = await directory.batch([
    directory
      .prepare(
        `UPDATE slack_organisation_connection
       SET lifecycle = 'revoked', revision = revision + 1, disabled_at = NULL,
           revoked_at = ?, updated_at = ?
       WHERE organisation_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(input.now, input.now, input.organisationId),
    prepareRevokedDmSelectionRelease(directory, input.organisationId),
  ]);
  return result?.meta.changes ?? 0;
}

// The credentials of the workspace installations an Organisation installed.
// Other Organisations in those workspaces use them, so they outlive its archive
// and its purge.
export async function listSlackInstallationCredentialHandles(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const rows = await directory
    .prepare(
      "SELECT bot_token_ref AS handle FROM slack_installation WHERE credential_organisation_id = ?",
    )
    .bind(organisationId)
    .all<{ readonly handle: unknown }>();
  const handles: string[] = [];
  for (const row of rows.results)
    if (typeof row.handle === "string") handles.push(row.handle);
  return handles;
}

export async function hasSlackOrganisationConnection(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const row = await directory
    .prepare(
      `SELECT 1 AS present
       FROM slack_organisation_connection
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{ readonly present: unknown }>();
  return row?.present === 1;
}

export async function createSlackOrganisationConnection(
  env: OrganisationPlacementBindings,
  seed: SlackOrganisationConnectionSeed,
): Promise<SlackOrganisationConnectionId> {
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    seed.organisationId,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  const scope = resolved.value;
  const account = await scope.database
    .prepare(
      `SELECT provider_account_id AS workspaceId, environment
     FROM integration_account WHERE organisation_id = ? AND integration_account_id = ?
       AND provider = 'slack' AND lifecycle = 'active'`,
    )
    .bind(seed.organisationId, seed.integrationAccountId)
    .first<{
      readonly workspaceId: unknown;
      readonly environment: unknown;
    }>();
  if (
    account === null ||
    typeof account.workspaceId !== "string" ||
    (account.environment !== "development" &&
      account.environment !== "production")
  ) {
    throw new Error("slack_organisation_account_inactive");
  }
  const workspaceId = parseWorkspaceId(account.workspaceId);
  if (!workspaceId.ok) throw new Error("slack_organisation_account_invalid");
  const revoked = await scope.database
    .prepare(
      `SELECT integration_account_id AS integrationAccountId FROM integration_account
     WHERE organisation_id = ? AND provider = 'slack' AND lifecycle = 'revoked'`,
    )
    .bind(seed.organisationId)
    .all<{ readonly integrationAccountId: string }>();
  if (!(await scope.isActive()))
    throw new Error("organisation_placement_conflict");
  const directory = env.DB.withSession("first-primary");
  const statements: D1PreparedStatement[] = [];
  // Keep revoked directory records so existing thread pins cannot reactivate.
  for (const retired of revoked.results) {
    statements.push(
      directory
        .prepare(
          `UPDATE slack_organisation_connection
       SET lifecycle = 'revoked', revision = revision + 1,
           updated_at = ?, disabled_at = NULL, revoked_at = ?
       WHERE installation_id = ? AND organisation_id = ? AND integration_account_id = ?
         AND lifecycle != 'revoked'`,
        )
        .bind(
          seed.connectedAt,
          seed.connectedAt,
          seed.installationId,
          seed.organisationId,
          retired.integrationAccountId,
        ),
    );
  }
  statements.push(
    directory
      .prepare(
        `INSERT INTO slack_organisation_connection (
       connection_id, installation_id, organisation_id, integration_account_id,
       lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
     )
     SELECT ?, installation_id, ?, ?, 'active', 1, ?, ?, NULL, NULL
     FROM slack_installation
     WHERE installation_id = ? AND workspace_id = ? AND environment = ?
       AND lifecycle = 'active'
       AND EXISTS (
         SELECT 1 FROM organisation_placement WHERE organisation_id = ?
           AND placement_epoch = ? AND placement_cell_id = ?
           AND fence_token = ? AND status = 'active'
       )
     ON CONFLICT (organisation_id, integration_account_id) DO UPDATE SET
       lifecycle = 'active', revision = slack_organisation_connection.revision + 1,
       updated_at = excluded.updated_at, disabled_at = NULL, revoked_at = NULL
     WHERE slack_organisation_connection.installation_id = excluded.installation_id
       AND slack_organisation_connection.lifecycle != 'active'`,
      )
      .bind(
        seed.connectionId,
        seed.organisationId,
        seed.integrationAccountId,
        seed.connectedAt,
        seed.connectedAt,
        seed.installationId,
        workspaceId.value,
        account.environment,
        seed.organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      ),
  );
  await directory.batch(statements);
  const row = await directory
    .prepare(
      `SELECT connection_id AS connectionId FROM slack_organisation_connection
     WHERE installation_id = ? AND organisation_id = ?
       AND integration_account_id = ? AND lifecycle = 'active'`,
    )
    .bind(seed.installationId, seed.organisationId, seed.integrationAccountId)
    .first<{ readonly connectionId: unknown }>();
  const connectionId = parseStringId(
    row?.connectionId,
    parseSlackOrganisationConnectionId,
  );
  if (connectionId === null)
    throw new Error("slack_organisation_connection_not_created");
  if (!(await scope.isActive()))
    throw new Error("organisation_placement_conflict");
  return connectionId;
}

/**
 * Binds the setup's Slack channel to this Organisation's own active
 * connection in that workspace when no connection holds the channel, as a
 * setup save does. An Organisation that saved its setup before setup saves
 * bound the channel has the channel in its setup but no binding, so nothing
 * it sends can reach that channel.
 */
export async function bindUnboundSetupChannel(
  env: OrganisationPlacementBindings,
  input: {
    readonly environment: OrganisationEnvironment;
    readonly appId: SlackAppId;
    readonly organisationId: OrganisationId;
    readonly workspaceId: WorkspaceId;
    readonly channelId: ChannelId;
    readonly userId: UserId;
    readonly changedAt: number;
  },
): Promise<
  Result<
    {
      readonly change: Variant<SlackChannelDefaultChange, "bind_unbound">;
      readonly channelDefault: SlackChannelDefault;
    },
    { readonly code: string }
  >
> {
  const row = await env.DB.prepare(
    `SELECT installation.installation_id AS installationId,
            connection.connection_id AS connectionId
       FROM slack_installation AS installation
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = installation.installation_id
        AND connection.organisation_id = ?
        AND connection.lifecycle = 'active'
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'`,
  )
    .bind(
      input.organisationId,
      input.environment,
      input.appId,
      input.workspaceId,
    )
    .first<{
      readonly installationId: unknown;
      readonly connectionId: unknown;
    }>();
  const installationId = parseStringId(
    row?.installationId,
    parseSlackInstallationId,
  );
  const connectionId = parseStringId(
    row?.connectionId,
    parseSlackOrganisationConnectionId,
  );
  if (installationId === null || connectionId === null)
    return {
      ok: false,
      error: { code: "slack_destination_connection_inactive" },
    };
  const change = {
    kind: "bind_unbound",
    installationId,
    channelId: input.channelId,
    destinationConnectionId: connectionId,
    destinationOrganisationId: input.organisationId,
    boundByUserId: input.userId,
    changedAt: input.changedAt,
  } as const;
  if (
    !(await userMayChangeSlackChannelDefault(env, {
      userId: input.userId,
      change,
    }))
  )
    return {
      ok: false,
      error: { code: "slack_channel_default_authority_missing" },
    };
  const configured = await configureSlackChannelDefault(env.DB, change);
  return configured.ok
    ? { ok: true, value: { change, channelDefault: configured.value } }
    : configured;
}

/** The audit record of one channel binding change. */
export function prepareSlackRoutingAuditEvent(
  db: GlobalDatabase,
  input: {
    readonly change: SlackChannelDefaultChange;
    readonly revision: number;
    readonly nextConnectionId: SlackChannelDefaultChange["destinationConnectionId"];
    readonly mutationIdentity: Readonly<{
      auditEventId: string;
      receiptId: string;
    }>;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO slack_routing_audit_event (
         audit_event_id, installation_id, channel_id,
         previous_connection_id, next_connection_id, revision,
         actor_user_id, idempotency_receipt_id, occurred_at
       )
       SELECT ?, ?, ?, previous.connection_id, ?, ?, ?, ?, ?
       FROM (SELECT 1) AS seed
       LEFT JOIN slack_channel_default_revision AS previous
         ON previous.installation_id = ? AND previous.channel_id = ?
        AND previous.revision = ?`,
    )
    .bind(
      input.mutationIdentity.auditEventId,
      input.change.installationId,
      input.change.channelId,
      input.nextConnectionId,
      input.revision,
      input.change.boundByUserId,
      input.mutationIdentity.receiptId,
      input.change.changedAt,
      input.change.installationId,
      input.change.channelId,
      input.revision - 1,
    );
}

export async function configureSlackChannelDefault(
  db: GlobalDatabase,
  change: SlackChannelDefaultChange,
): Promise<Result<SlackChannelDefault, SlackChannelDefaultChangeError>> {
  const session = db.withSession("first-primary");
  const mutation =
    change.kind === "bind_unbound"
      ? prepareInitialChannelBinding(session, change)
      : prepareReplacementChannelBinding(session, change);
  const result = await mutation.run();
  if (result.meta.changes === 0) {
    return diagnoseChannelBindingFailure(session, change);
  }
  const row = await readSlackChannelDefault(
    session,
    change.installationId,
    change.channelId,
  );
  const parsed = row === null ? null : parseSlackChannelDefaultRow(row);
  return parsed === null
    ? { ok: false, error: { code: "slack_channel_default_corrupt" } }
    : { ok: true, value: parsed };
}

export async function resolveOrClaimSlackThreadRoute(
  db: GlobalDatabase,
  request: SlackThreadRouteRequest,
): Promise<SlackThreadRouteResolution> {
  if (!SLACK_MESSAGE_TS_PATTERN.test(request.rootMessageTs)) {
    return { kind: "rejected", reason: "routing_record_corrupt" };
  }
  if (request.kind === "reply") {
    const existing = await readSlackThreadRoute(db, request);
    return existing === null
      ? { kind: "rejected", reason: "thread_pin_missing" }
      : parseSlackThreadRouteRow(existing);
  }
  // A thread's first message has no pin unless Slack repeats it, and the
  // claim keeps a pin that exists. The claim and the read of the pin it
  // leaves therefore travel in one round trip on the primary.
  const session = db.withSession("first-primary");
  const claim = request.channelId.startsWith("D")
    ? [
        prepareSoleConnectionDmSelection(session, request),
        prepareSlackDmThreadClaim(session, request),
      ]
    : [prepareSlackChannelThreadClaim(session, request)];
  const results = await session.batch<SlackThreadRouteRow>([
    ...claim,
    prepareSlackThreadRouteRead(session, request),
  ]);
  const claimed = results.at(-1)?.results[0] ?? null;
  if (claimed !== null) return parseSlackThreadRouteRow(claimed);
  return diagnoseRouteFailure(session, request);
}

export async function selectSlackDmOrganisation(
  env: OrganisationPlacementBindings,
  input: {
    readonly installationId: SlackInstallationId;
    readonly destinationConnectionId: SlackOrganisationConnectionId;
    readonly destinationOrganisationId: OrganisationId;
    readonly userId: UserId;
    readonly selectedAt: number;
  },
): Promise<
  Result<
    { readonly revision: number; readonly externalUserId: SlackUserId },
    { readonly code: "slack_dm_organisation_selection_unauthorised" }
  >
> {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    input.destinationOrganisationId,
  );
  if (!scope.ok) {
    return {
      ok: false,
      error: { code: "slack_dm_organisation_selection_unauthorised" },
    };
  }
  const session = env.DB.withSession("first-primary");
  const route = await session
    .prepare(
      `SELECT connection.integration_account_id AS integrationAccountId,
            installation.workspace_id AS workspaceId
     FROM slack_installation AS installation
     JOIN slack_organisation_connection AS connection
       ON connection.installation_id = installation.installation_id
     WHERE installation.installation_id = ? AND installation.lifecycle = 'active'
       AND connection.connection_id = ? AND connection.organisation_id = ?
       AND connection.lifecycle = 'active'`,
    )
    .bind(
      input.installationId,
      input.destinationConnectionId,
      input.destinationOrganisationId,
    )
    .first<{
      readonly integrationAccountId: unknown;
      readonly workspaceId: unknown;
    }>();
  const accountId =
    typeof route?.integrationAccountId === "string"
      ? parseIntegrationAccountId(route.integrationAccountId)
      : null;
  const workspaceId =
    typeof route?.workspaceId === "string"
      ? parseWorkspaceId(route.workspaceId)
      : null;
  if (!accountId?.ok || !workspaceId?.ok) {
    return {
      ok: false,
      error: { code: "slack_dm_organisation_selection_unauthorised" },
    };
  }
  const identity = await scope.value.database
    .prepare(
      `SELECT identity_link.external_user_id AS externalUserId
     FROM integration_account AS account
     JOIN external_identity_link AS identity_link
       ON identity_link.organisation_id = account.organisation_id
       AND identity_link.workspace_connection_id = account.provider_connection_id
       AND identity_link.workspace_id = ? AND identity_link.user_id = ?
     JOIN service_role_grant AS membership
       ON membership.organisation_id = identity_link.organisation_id
       AND membership.user_id = identity_link.user_id AND membership.status = 'active'
     WHERE account.organisation_id = ? AND account.integration_account_id = ?
       AND account.provider = 'slack' AND account.lifecycle = 'active'`,
    )
    .bind(
      workspaceId.value,
      input.userId,
      input.destinationOrganisationId,
      accountId.value,
    )
    .first<{ readonly externalUserId: unknown }>();
  const externalUserId =
    typeof identity?.externalUserId === "string"
      ? parseSlackUserId(identity.externalUserId, "external_user_id")
      : null;
  if (!externalUserId?.ok || !(await scope.value.isActive())) {
    return {
      ok: false,
      error: { code: "slack_dm_organisation_selection_unauthorised" },
    };
  }
  await session
    .prepare(
      `INSERT INTO slack_dm_organisation_selection (
       installation_id, external_user_id, connection_id, revision, selected_at
     )
     SELECT installation.installation_id, ?, connection.connection_id, 1, ?
     FROM slack_installation AS installation
     JOIN slack_organisation_connection AS connection
       ON connection.installation_id = installation.installation_id
       AND connection.connection_id = ? AND connection.organisation_id = ?
       AND connection.lifecycle = 'active'
     WHERE installation.installation_id = ? AND installation.lifecycle = 'active'
       AND EXISTS (
         SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
           AND placement_cell_id = ? AND fence_token = ? AND status = 'active'
       )
     ON CONFLICT (installation_id, external_user_id) DO UPDATE SET
       connection_id = excluded.connection_id,
       revision = slack_dm_organisation_selection.revision + 1,
       selected_at = excluded.selected_at
     WHERE slack_dm_organisation_selection.connection_id != excluded.connection_id`,
    )
    .bind(
      externalUserId.value,
      input.selectedAt,
      input.destinationConnectionId,
      input.destinationOrganisationId,
      input.installationId,
      input.destinationOrganisationId,
      scope.value.placement.placementEpoch,
      scope.value.placement.placementCellId,
      scope.value.fenceToken,
    )
    .run();
  const row = await session
    .prepare(
      `SELECT revision FROM slack_dm_organisation_selection
     WHERE installation_id = ? AND external_user_id = ? AND connection_id = ?`,
    )
    .bind(
      input.installationId,
      externalUserId.value,
      input.destinationConnectionId,
    )
    .first<{ readonly revision: unknown }>();
  if (
    row === null ||
    !isPositiveInteger(row.revision) ||
    !(await scope.value.isActive())
  ) {
    return {
      ok: false,
      error: { code: "slack_dm_organisation_selection_unauthorised" },
    };
  }
  return {
    ok: true,
    value: { revision: row.revision, externalUserId: externalUserId.value },
  };
}

export async function resolveActiveSlackDestinationConnection(
  env: OrganisationPlacementBindings,
  input: {
    readonly environment: OrganisationEnvironment;
    readonly appId: SlackAppId;
    readonly organisationId: OrganisationId;
    readonly workspaceId: WorkspaceId;
    readonly channelId: ChannelId;
  },
): Promise<
  Result<
    ActiveSlackDestinationConnection,
    { readonly code: "slack_destination_connection_inactive" }
  >
> {
  const row = await env.DB.prepare(
    `SELECT installation.installation_id AS installationId,
              connection.connection_id AS connectionId,
              connection.integration_account_id AS integrationAccountId
       FROM slack_installation AS installation
       JOIN slack_channel_default AS channel
         ON channel.installation_id = installation.installation_id
        AND channel.channel_id = ?
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = channel.installation_id
        AND connection.connection_id = channel.connection_id
        AND connection.organisation_id = ?
        AND connection.lifecycle = 'active'
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'`,
  )
    .bind(
      input.channelId,
      input.organisationId,
      input.environment,
      input.appId,
      input.workspaceId,
    )
    .first<{
      readonly installationId: unknown;
      readonly connectionId: unknown;
      readonly integrationAccountId: unknown;
    }>();
  if (row === null) {
    return {
      ok: false,
      error: { code: "slack_destination_connection_inactive" },
    };
  }
  const installationId = parseStringId(
    row.installationId,
    parseSlackInstallationId,
  );
  const connectionId = parseStringId(
    row.connectionId,
    parseSlackOrganisationConnectionId,
  );
  const integrationAccountId = parseStringId(
    row.integrationAccountId,
    parseIntegrationAccountId,
  );
  if (
    installationId === null ||
    connectionId === null ||
    integrationAccountId === null
  ) {
    return {
      ok: false,
      error: { code: "slack_destination_connection_inactive" },
    };
  }
  const scope = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!scope.ok) {
    return {
      ok: false,
      error: { code: "slack_destination_connection_inactive" },
    };
  }
  const active = await scope.value.database
    .prepare(
      `SELECT 1 FROM integration_account WHERE organisation_id = ?
     AND integration_account_id = ? AND provider = 'slack' AND lifecycle = 'active'`,
    )
    .bind(input.organisationId, integrationAccountId)
    .first();
  if (active === null || !(await scope.value.isActive())) {
    return {
      ok: false,
      error: { code: "slack_destination_connection_inactive" },
    };
  }
  return {
    ok: true,
    value: { installationId, connectionId, integrationAccountId },
  };
}

export async function listSlackOrganisationRouting(
  db: GlobalDatabase,
  organisationId: OrganisationId,
): Promise<readonly SlackOrganisationRoutingProjection[]> {
  const result = await db
    .prepare(
      `SELECT installation.installation_id AS installationId,
              connection.connection_id AS connectionId,
              connection.integration_account_id AS integrationAccountId,
              installation.workspace_id AS workspaceId,
              connection.lifecycle AS lifecycle,
              (
                SELECT COUNT(*) FROM slack_organisation_connection AS other
                WHERE other.installation_id = connection.installation_id
                  AND other.connection_id != connection.connection_id
                  AND other.lifecycle = 'active'
              ) AS otherActiveConnections
       FROM slack_organisation_connection AS connection
       JOIN slack_installation AS installation
         ON installation.installation_id = connection.installation_id
       WHERE connection.organisation_id = ? AND connection.lifecycle != 'revoked'
       ORDER BY installation.workspace_id`,
    )
    .bind(organisationId)
    .all<SlackOrganisationRoutingRow>();
  const projections: SlackOrganisationRoutingProjection[] = [];
  for (const row of result.results ?? []) {
    const parsed = await parseSlackOrganisationRoutingRow(db, row);
    if (parsed === null) {
      throw new Error("slack_organisation_routing_projection_corrupt");
    }
    projections.push(parsed);
  }
  return projections;
}

export async function userMayChangeSlackChannelDefault(
  env: OrganisationPlacementBindings,
  input: {
    readonly userId: UserId;
    readonly change: SlackChannelDefaultChange;
  },
): Promise<boolean> {
  const requiredOrganisationIds =
    input.change.kind === "bind_unbound"
      ? [input.change.destinationOrganisationId]
      : [
          input.change.sourceOrganisationId,
          input.change.destinationOrganisationId,
        ];
  for (const organisationId of new Set(requiredOrganisationIds)) {
    if (
      !(await userMayAdministerSlackOrganisation(
        env,
        input.userId,
        organisationId,
      ))
    )
      return false;
  }
  return true;
}

export async function userMayDisconnectSlackInstallation(
  env: OrganisationPlacementBindings,
  input: {
    readonly userId: UserId;
    readonly installationId: SlackInstallationId;
  },
): Promise<boolean> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT organisation_id AS organisationId FROM slack_organisation_connection
     WHERE installation_id = ? AND lifecycle = 'active'`,
  )
    .bind(input.installationId)
    .all<{ readonly organisationId: unknown }>();
  if (rows.results.length === 0) return false;
  for (const row of rows.results) {
    if (typeof row.organisationId !== "string") return false;
    const organisationId = parseOrganisationId(row.organisationId);
    if (
      !organisationId.ok ||
      !(await userMayAdministerSlackOrganisation(
        env,
        input.userId,
        organisationId.value,
      ))
    )
      return false;
  }
  return true;
}

async function userMayAdministerSlackOrganisation(
  env: OrganisationPlacementBindings,
  userId: UserId,
  organisationId: OrganisationId,
): Promise<boolean> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) return false;
  const membership = await scope.value.database
    .prepare(
      `SELECT 1 FROM service_role_grant WHERE organisation_id = ? AND user_id = ?
     AND status = 'active' AND role IN ('owner', 'admin')`,
    )
    .bind(organisationId, userId)
    .first();
  return membership !== null && (await scope.value.isActive());
}

export async function disconnectSlackInstallation(input: {
  readonly env: OrganisationPlacementBindings;
  readonly installationId: SlackInstallationId;
  readonly disconnectedAt: number;
}): Promise<
  Result<
    { readonly disconnectedConnectionCount: number },
    { readonly code: "slack_installation_disconnect_conflict" }
  >
> {
  const directory = input.env.DB.withSession("first-primary");
  const installation = await directory
    .prepare(
      `SELECT credential_organisation_id AS organisationId, bot_token_ref AS tokenRef
     FROM slack_installation WHERE installation_id = ?`,
    )
    .bind(input.installationId)
    .first<{ readonly organisationId: unknown; readonly tokenRef: unknown }>();
  const credentialOrganisationId = parseStringId(
    installation?.organisationId,
    parseOrganisationId,
  );
  const tokenRef =
    typeof installation?.tokenRef === "string"
      ? parseVaultHandle(installation.tokenRef)
      : null;
  if (credentialOrganisationId === null || !tokenRef?.ok) {
    return {
      ok: false,
      error: { code: "slack_installation_disconnect_conflict" },
    };
  }
  const credentialScope = await OrganisationExecutionScope.resolve(
    input.env,
    credentialOrganisationId,
  );
  if (!credentialScope.ok) {
    return {
      ok: false,
      error: { code: "slack_installation_disconnect_conflict" },
    };
  }
  const rows = await directory
    .prepare(
      `SELECT organisation_id AS organisationId, integration_account_id AS accountId
     FROM slack_organisation_connection WHERE installation_id = ?`,
    )
    .bind(input.installationId)
    .all<{ readonly organisationId: unknown; readonly accountId: unknown }>();
  const targets: {
    readonly scope: OrganisationExecutionScope;
    readonly accountId: IntegrationAccountId;
  }[] = [];
  for (const row of rows.results) {
    const organisationId = parseStringId(
      row.organisationId,
      parseOrganisationId,
    );
    const accountId = parseStringId(row.accountId, parseIntegrationAccountId);
    if (organisationId === null || accountId === null) {
      return {
        ok: false,
        error: { code: "slack_installation_disconnect_conflict" },
      };
    }
    const scope = await OrganisationExecutionScope.resolve(
      input.env,
      organisationId,
    );
    if (!scope.ok) {
      return {
        ok: false,
        error: { code: "slack_installation_disconnect_conflict" },
      };
    }
    targets.push({ scope: scope.value, accountId });
  }
  // Keep directory records until each regional write has completed. Retries use
  // the retained account identities and repeat only idempotent revocations.
  for (const target of targets) {
    if (!(await target.scope.isActive())) {
      return {
        ok: false,
        error: { code: "slack_installation_disconnect_conflict" },
      };
    }
    const database = target.scope.database.withSession("first-primary");
    const disconnected = {
      now: input.disconnectedAt,
      organisationId: target.scope.organisationId,
      integrationAccountId: target.accountId,
    };
    await database.batch([
      prepareDisconnectedAccountRevocation(database, disconnected),
      prepareDisconnectedAccountConnectionRevocation(database, disconnected),
      prepareDisconnectedAccountGenerationsRevocation(database, disconnected),
    ]);
  }
  if (!(await credentialScope.value.isActive())) {
    return {
      ok: false,
      error: { code: "slack_installation_disconnect_conflict" },
    };
  }
  await prepareVaultSecretRevocation(credentialScope.value.database, {
    organisationId: credentialOrganisationId,
    handle: tokenRef.value,
    now: input.disconnectedAt,
  }).run();
  await directory.batch([
    directory
      .prepare(
        `UPDATE slack_installation SET lifecycle = 'revoked', updated_at = ?, revoked_at = ?,
       disabled_at = NULL WHERE installation_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(input.disconnectedAt, input.disconnectedAt, input.installationId),
    directory
      .prepare(
        `UPDATE slack_organisation_connection SET lifecycle = 'revoked', revision = revision + 1,
       updated_at = ?, revoked_at = ?, disabled_at = NULL
       WHERE installation_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(input.disconnectedAt, input.disconnectedAt, input.installationId),
  ]);
  return { ok: true, value: { disconnectedConnectionCount: targets.length } };
}

async function parseSlackOrganisationRoutingRow(
  db: GlobalDatabase,
  row: SlackOrganisationRoutingRow,
): Promise<SlackOrganisationRoutingProjection | null> {
  const installationId = parseStringId(
    row.installationId,
    parseSlackInstallationId,
  );
  const connectionId = parseStringId(
    row.connectionId,
    parseSlackOrganisationConnectionId,
  );
  const integrationAccountId = parseStringId(
    row.integrationAccountId,
    parseIntegrationAccountId,
  );
  const workspaceId = parseStringId(row.workspaceId, parseWorkspaceId);
  const lifecycle = parseSlackLifecycle(row.lifecycle);
  const otherActiveConnections = row.otherActiveConnections;
  if (
    installationId === null ||
    connectionId === null ||
    integrationAccountId === null ||
    workspaceId === null ||
    lifecycle === null ||
    typeof otherActiveConnections !== "number" ||
    !Number.isInteger(otherActiveConnections) ||
    otherActiveConnections < 0
  ) {
    return null;
  }
  const defaults = await db
    .prepare(
      `SELECT channel.installation_id AS installationId,
              channel.channel_id AS channelId,
              channel.connection_id AS connectionId,
              connection.organisation_id AS organisationId,
              channel.revision AS revision,
              channel.bound_by_user_id AS boundByUserId,
              channel.bound_at AS boundAt
       FROM slack_channel_default AS channel
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = channel.installation_id
        AND connection.connection_id = channel.connection_id
       WHERE channel.installation_id = ? AND channel.connection_id = ?
       ORDER BY channel.channel_id`,
    )
    .bind(installationId, connectionId)
    .all<SlackChannelDefaultRow>();
  const channelDefaults: SlackChannelDefault[] = [];
  for (const defaultRow of defaults.results ?? []) {
    const parsedDefault = parseSlackChannelDefaultRow(defaultRow);
    if (parsedDefault === null) return null;
    channelDefaults.push(parsedDefault);
  }
  return {
    installationId,
    connectionId,
    integrationAccountId,
    workspaceId,
    lifecycle,
    channelDefaults,
    sharedWorkspace: otherActiveConnections > 0,
  };
}

function parseSlackLifecycle(
  value: unknown,
): "active" | "disabled" | "revoked" | null {
  return value === "active" || value === "disabled" || value === "revoked"
    ? value
    : null;
}

// A channel is unbound when it has no default, and also when its default names
// a revoked connection: the Organisation that bound it was archived or removed
// its workspace, and nobody can replace its binding any more. A disabled
// connection keeps its channels, because its Organisation can enable it again.
function prepareInitialChannelBinding(
  db: GlobalDatabaseSession,
  change: Variant<SlackChannelDefaultChange, "bind_unbound">,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO slack_channel_default (
         installation_id, channel_id, connection_id, revision,
         bound_by_user_id, bound_at
       )
       SELECT ?, ?, connection_id, 1, ?, ?
       FROM slack_organisation_connection
       WHERE installation_id = ? AND connection_id = ? AND organisation_id = ?
         AND lifecycle = 'active'
       ON CONFLICT (installation_id, channel_id) DO UPDATE
         SET connection_id = excluded.connection_id,
             revision = slack_channel_default.revision + 1,
             bound_by_user_id = excluded.bound_by_user_id,
             bound_at = excluded.bound_at
         WHERE EXISTS (
           SELECT 1 FROM slack_organisation_connection AS previous
           WHERE previous.installation_id = slack_channel_default.installation_id
             AND previous.connection_id = slack_channel_default.connection_id
             AND previous.lifecycle = 'revoked'
         )`,
    )
    .bind(
      change.installationId,
      change.channelId,
      change.boundByUserId,
      change.changedAt,
      change.installationId,
      change.destinationConnectionId,
      change.destinationOrganisationId,
    );
}

// Directory pins select an organisation. Ingress admission checks the integration and
// membership in that organisation's regional database before it admits execution.
function prepareSlackChannelThreadClaim(
  db: GlobalDatabaseSession,
  request: Variant<SlackThreadRouteRequest, "root">,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO slack_thread_case_pin (
         installation_id, channel_id, root_message_ts, connection_id,
         organisation_id, integration_account_id, case_id,
         routing_source_kind, routing_source_revision, pinned_at
       )
       SELECT installation.installation_id, ?, ?, connection.connection_id,
              connection.organisation_id, connection.integration_account_id, ?,
              'channel_default', channel.revision, ?
       FROM slack_installation AS installation
       JOIN slack_channel_default AS channel
         ON channel.installation_id = installation.installation_id
        AND channel.channel_id = ?
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = channel.installation_id
        AND connection.connection_id = channel.connection_id
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'
         AND connection.lifecycle = 'active'`,
    )
    .bind(
      request.channelId,
      request.rootMessageTs,
      request.caseId,
      request.occurredAt,
      request.channelId,
      request.environment,
      request.appId,
      request.workspaceId,
    );
}

/**
 * A workspace that serves one organisation needs no DM choice: a person who
 * has none, or whose choice points at a revoked connection, gets the only
 * active connection as their choice. A workspace that serves several leaves
 * the choice to the person. Admission still decides whether the person may
 * start a Case there.
 */
function prepareSoleConnectionDmSelection(
  db: GlobalDatabaseSession,
  request: Variant<SlackThreadRouteRequest, "root">,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO slack_dm_organisation_selection (
         installation_id, external_user_id, connection_id, revision, selected_at
       )
       SELECT installation.installation_id, ?, connection.connection_id, 1, ?
       FROM slack_installation AS installation
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = installation.installation_id
        AND connection.lifecycle = 'active'
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'
         AND (
           SELECT COUNT(*) FROM slack_organisation_connection AS other
           WHERE other.installation_id = installation.installation_id
             AND other.lifecycle = 'active'
         ) = 1
       ON CONFLICT (installation_id, external_user_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         revision = slack_dm_organisation_selection.revision + 1,
         selected_at = excluded.selected_at
       WHERE NOT EXISTS (
         SELECT 1 FROM slack_organisation_connection AS chosen
         WHERE chosen.installation_id = slack_dm_organisation_selection.installation_id
           AND chosen.connection_id = slack_dm_organisation_selection.connection_id
           AND chosen.lifecycle != 'revoked'
       )`,
    )
    .bind(
      request.externalUserId,
      request.occurredAt,
      request.environment,
      request.appId,
      request.workspaceId,
    );
}

function prepareSlackDmThreadClaim(
  db: GlobalDatabaseSession,
  request: Variant<SlackThreadRouteRequest, "root">,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO slack_thread_case_pin (
         installation_id, channel_id, root_message_ts, connection_id,
         organisation_id, integration_account_id, case_id,
         routing_source_kind, routing_source_revision, pinned_at
       )
       SELECT installation.installation_id, ?, ?, connection.connection_id,
              connection.organisation_id, connection.integration_account_id, ?,
              'dm_selection', selection.revision, ?
       FROM slack_installation AS installation
       JOIN slack_dm_organisation_selection AS selection
         ON selection.installation_id = installation.installation_id
        AND selection.external_user_id = ?
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = selection.installation_id
        AND connection.connection_id = selection.connection_id
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'
         AND connection.lifecycle = 'active'`,
    )
    .bind(
      request.channelId,
      request.rootMessageTs,
      request.caseId,
      request.occurredAt,
      request.externalUserId,
      request.environment,
      request.appId,
      request.workspaceId,
    );
}

function prepareReplacementChannelBinding(
  db: GlobalDatabaseSession,
  change: Variant<SlackChannelDefaultChange, "replace">,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE slack_channel_default
       SET connection_id = ?, revision = revision + 1,
           bound_by_user_id = ?, bound_at = ?
       WHERE installation_id = ? AND channel_id = ? AND revision = ?
         AND EXISTS (
           SELECT 1 FROM slack_organisation_connection AS source
           WHERE source.installation_id = slack_channel_default.installation_id
             AND source.connection_id = slack_channel_default.connection_id
             AND source.organisation_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM slack_organisation_connection AS destination
           WHERE destination.installation_id = slack_channel_default.installation_id
             AND destination.connection_id = ? AND destination.organisation_id = ?
             AND destination.lifecycle = 'active'
         )`,
    )
    .bind(
      change.destinationConnectionId,
      change.boundByUserId,
      change.changedAt,
      change.installationId,
      change.channelId,
      change.expectedRevision,
      change.sourceOrganisationId,
      change.destinationConnectionId,
      change.destinationOrganisationId,
    );
}

async function diagnoseChannelBindingFailure(
  db: GlobalDatabaseSession,
  change: SlackChannelDefaultChange,
): Promise<Result<never, SlackChannelDefaultChangeError>> {
  const destination = await db
    .prepare(
      `SELECT lifecycle FROM slack_organisation_connection
       WHERE installation_id = ? AND connection_id = ? AND organisation_id = ?`,
    )
    .bind(
      change.installationId,
      change.destinationConnectionId,
      change.destinationOrganisationId,
    )
    .first<{ readonly lifecycle: unknown }>();
  return destination?.lifecycle === "active"
    ? { ok: false, error: { code: "slack_channel_default_conflict" } }
    : { ok: false, error: { code: "slack_channel_destination_inactive" } };
}

async function readSlackChannelDefault(
  db: Pick<GlobalDatabase, "prepare"> | Pick<GlobalDatabaseSession, "prepare">,
  installationId: SlackInstallationId,
  channelId: ChannelId,
): Promise<SlackChannelDefaultRow | null> {
  return db
    .prepare(
      `SELECT channel.installation_id AS installationId,
              channel.channel_id AS channelId,
              channel.connection_id AS connectionId,
              connection.organisation_id AS organisationId,
              channel.revision AS revision,
              channel.bound_by_user_id AS boundByUserId,
              channel.bound_at AS boundAt
       FROM slack_channel_default AS channel
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = channel.installation_id
        AND connection.connection_id = channel.connection_id
       WHERE channel.installation_id = ? AND channel.channel_id = ?`,
    )
    .bind(installationId, channelId)
    .first<SlackChannelDefaultRow>();
}

function parseSlackChannelDefaultRow(
  row: SlackChannelDefaultRow,
): SlackChannelDefault | null {
  const installationId = parseStringId(
    row.installationId,
    parseSlackInstallationId,
  );
  const connectionId = parseStringId(
    row.connectionId,
    parseSlackOrganisationConnectionId,
  );
  const organisationId = parseStringId(row.organisationId, parseOrganisationId);
  const channelId = parseStringId(row.channelId, parseChannelId);
  const boundByUserId = parseStringId(row.boundByUserId, parseUserId);
  if (
    installationId === null ||
    connectionId === null ||
    organisationId === null ||
    channelId === null ||
    boundByUserId === null ||
    !isPositiveInteger(row.revision) ||
    !isNonNegativeInteger(row.boundAt)
  ) {
    return null;
  }
  return {
    installationId,
    channelId,
    connectionId,
    organisationId,
    revision: row.revision,
    boundByUserId,
    boundAt: row.boundAt,
  };
}

function readSlackThreadRoute(
  db: Pick<GlobalDatabase, "prepare"> | Pick<GlobalDatabaseSession, "prepare">,
  request: SlackThreadRouteRequest,
): Promise<SlackThreadRouteRow | null> {
  return prepareSlackThreadRouteRead(db, request).first<SlackThreadRouteRow>();
}

function prepareSlackThreadRouteRead(
  db: Pick<GlobalDatabase, "prepare"> | Pick<GlobalDatabaseSession, "prepare">,
  request: SlackThreadRouteRequest,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT installation.installation_id AS installationId,
              installation.lifecycle AS installationLifecycle,
              connection.connection_id AS connectionId,
              connection.lifecycle AS connectionLifecycle,
              pin.organisation_id AS organisationId,
              pin.integration_account_id AS integrationAccountId,
              installation.credential_organisation_id AS credentialOrganisationId,
              installation.bot_token_ref AS botTokenRef,
              pin.case_id AS caseId,
              pin.routing_source_kind AS routingSourceKind,
              pin.routing_source_revision AS routingSourceRevision,
              placement.placement_kind AS placementKind,
              placement.placement_epoch AS placementEpoch,
              placement.placement_cell_id AS placementCellId,
              placement.location_hint AS locationHint,
              placement.residency_jurisdiction AS residencyJurisdiction
       FROM slack_installation AS installation
       JOIN slack_thread_case_pin AS pin
         ON pin.installation_id = installation.installation_id
        AND pin.channel_id = ? AND pin.root_message_ts = ?
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = pin.installation_id
        AND connection.connection_id = pin.connection_id
       LEFT JOIN organisation_placement AS placement
         ON placement.organisation_id = pin.organisation_id
        AND placement.status = 'active'
       WHERE installation.environment = ? AND installation.app_id = ?
         AND installation.workspace_id = ?`,
    )
    .bind(
      request.channelId,
      request.rootMessageTs,
      request.environment,
      request.appId,
      request.workspaceId,
    );
}

function parseSlackThreadRouteRow(
  row: SlackThreadRouteRow,
): SlackThreadRouteResolution {
  if (row.installationLifecycle !== "active") {
    return row.installationLifecycle === "disabled" ||
      row.installationLifecycle === "revoked"
      ? { kind: "disabled", boundary: "installation" }
      : { kind: "rejected", reason: "routing_record_corrupt" };
  }
  if (row.connectionLifecycle !== "active") {
    return row.connectionLifecycle === "disabled" ||
      row.connectionLifecycle === "revoked"
      ? { kind: "disabled", boundary: "organisation_connection" }
      : { kind: "rejected", reason: "routing_record_corrupt" };
  }
  const installationId = parseStringId(
    row.installationId,
    parseSlackInstallationId,
  );
  const connectionId = parseStringId(
    row.connectionId,
    parseSlackOrganisationConnectionId,
  );
  const organisationId = parseStringId(row.organisationId, parseOrganisationId);
  const credentialOrganisationId = parseStringId(
    row.credentialOrganisationId,
    parseOrganisationId,
  );
  const integrationAccountId = parseStringId(
    row.integrationAccountId,
    parseIntegrationAccountId,
  );
  const caseId = parseStringId(row.caseId, parseCaseId);
  const botTokenRef = parseStringId(row.botTokenRef, parseVaultHandle);
  if (
    installationId === null ||
    connectionId === null ||
    organisationId === null ||
    credentialOrganisationId === null ||
    integrationAccountId === null ||
    caseId === null ||
    botTokenRef === null ||
    (row.routingSourceKind !== "channel_default" &&
      row.routingSourceKind !== "dm_selection") ||
    !isPositiveInteger(row.routingSourceRevision)
  ) {
    return { kind: "rejected", reason: "routing_record_corrupt" };
  }
  return {
    kind: "resolved",
    value: {
      installationId,
      connectionId,
      organisationId,
      integrationAccountId,
      credentialOrganisationId,
      botTokenRef,
      caseId,
      routingSource: {
        kind: row.routingSourceKind,
        revision: row.routingSourceRevision,
      },
      placement: parsePublishedRoutePlacement(row),
    },
  };
}

function parsePublishedRoutePlacement(
  row: SlackThreadRouteRow,
): OrganisationPlacement | null {
  if (row.placementKind === null || row.placementKind === undefined)
    return null;
  const placement = parseOrganisationPlacement(
    {
      kind: row.placementKind,
      placementEpoch: row.placementEpoch,
      placementCellId: row.placementCellId,
      locationHint: row.locationHint,
      ...(row.placementKind === "residency"
        ? { residencyJurisdiction: row.residencyJurisdiction }
        : {}),
    },
    "slackThreadRoute.placement",
  );
  // An unreadable placement addresses nothing. The scoped admission path
  // reports the directory fault.
  return placement.ok ? placement.value : null;
}

async function diagnoseRouteFailure(
  db: GlobalDatabaseSession,
  request: SlackThreadRouteRequest,
): Promise<SlackThreadRouteResolution> {
  const directMessage = request.channelId.startsWith("D");
  const row = await db
    .prepare(
      `SELECT installation.lifecycle AS installationLifecycle,
              connection.lifecycle AS connectionLifecycle,
              routing.routeKey AS channelId
       FROM slack_installation AS installation
       LEFT JOIN (
         SELECT installation_id, channel_id AS routeKey, connection_id
         FROM slack_channel_default
         WHERE ? = 0 AND channel_id = ?
         UNION ALL
         SELECT installation_id, external_user_id AS routeKey, connection_id
         FROM slack_dm_organisation_selection
         WHERE ? = 1 AND external_user_id = ?
       ) AS routing
         ON routing.installation_id = installation.installation_id
       LEFT JOIN slack_organisation_connection AS connection
         ON connection.installation_id = routing.installation_id
        AND connection.connection_id = routing.connection_id
       WHERE installation.environment = ? AND installation.app_id = ?
         AND installation.workspace_id = ?`,
    )
    .bind(
      directMessage ? 1 : 0,
      request.channelId,
      directMessage ? 1 : 0,
      request.kind === "root" ? request.externalUserId : "",
      request.environment,
      request.appId,
      request.workspaceId,
    )
    .first<SlackRouteStateRow>();
  if (row === null) return { kind: "rejected", reason: "installation_missing" };
  if (row.installationLifecycle !== "active") {
    return row.installationLifecycle === "disabled" ||
      row.installationLifecycle === "revoked"
      ? { kind: "disabled", boundary: "installation" }
      : { kind: "rejected", reason: "routing_record_corrupt" };
  }
  if (row.channelId === null) return { kind: "unbound" };
  if (row.connectionLifecycle !== "active") {
    return row.connectionLifecycle === "disabled" ||
      row.connectionLifecycle === "revoked"
      ? { kind: "disabled", boundary: "organisation_connection" }
      : { kind: "rejected", reason: "routing_record_corrupt" };
  }
  return { kind: "rejected", reason: "routing_record_corrupt" };
}

function parseStringId<T>(
  value: unknown,
  parser: (raw: string) => Result<T, unknown>,
): T | null {
  if (typeof value !== "string") return null;
  const parsed = parser(value);
  return parsed.ok ? parsed.value : null;
}
