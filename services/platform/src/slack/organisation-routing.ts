import type {
  GlobalDatabase,
  GlobalDatabaseSession,
} from "../database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type { OrganisationEnvironment } from "../data/control-plane";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import {
  parseCaseId,
  parseIntegrationAccountId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
  parseOrganisationId,
  parseWorkspaceId,
  type CaseId,
  type ChannelId,
  type IntegrationAccountId,
  type SlackAppId,
  type SlackInstallationId,
  type SlackOrganisationConnectionId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import { type UserId } from "@purin-labs/control-api/ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import type { Result } from "../result";
import { parseSlackUserId, type SlackUserId } from "./events";
import type { Variant } from "@purin-labs/type-utils";
import { isPositiveInteger } from "@purin-labs/std";
import { parseStringId } from "./installation-store";

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

/**
 * A person's DM choice that names a revoked connection of the Organisation
 * goes, so that their next DM asks them to choose again (or takes the
 * workspace's only connection) instead of reaching a revoked one.
 */
export function prepareRevokedDmSelectionRelease(
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

/**
 * The directory's Slack records that name the Organisation's connections: a
 * person's DM choice and the thread pins. A DM choice that named a revoked
 * connection asks the person to choose again; a pin has no Case to reach.
 */
export function directorySlackRecordDeletions(
  directory: GlobalDatabase,
  organisationId: OrganisationId,
): readonly (readonly [table: string, statement: D1PreparedStatement])[] {
  return [
    [
      "slack_dm_organisation_selection",
      directory
        .prepare(
          `DELETE FROM slack_dm_organisation_selection
           WHERE EXISTS (SELECT 1 FROM slack_organisation_connection AS connection
             WHERE connection.installation_id = slack_dm_organisation_selection.installation_id
               AND connection.connection_id = slack_dm_organisation_selection.connection_id
               AND connection.organisation_id = ? AND connection.lifecycle = 'revoked')`,
        )
        .bind(organisationId),
    ],
    [
      "slack_thread_case_pin",
      directory
        .prepare("DELETE FROM slack_thread_case_pin WHERE organisation_id = ?")
        .bind(organisationId),
    ],
  ];
}
