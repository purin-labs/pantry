import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import type { OrganisationUserAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { CONNECTOR_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { actorPhysicalName } from "@purin-labs/actor-runtime/actors/actor-registry";
import type { CredentialVaultBindings } from "@purin-labs/authority/credential-vault/keyring";
import {
  resolveVaultSecretRow,
  type VaultSecretRow,
} from "@purin-labs/authority/credential-vault/service";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type AssignmentId,
  type CaseId,
  type ConnectorId,
  type IntegrationAccountId,
  type SlackAppId,
  type SlackInstallationId,
  type SlackOrganisationConnectionId,
  type SessionId,
  type OrganisationId,
  parseStrictPersonId,
  type PersonId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "@purin-labs/tenancy/placement";
import type { SlackMessageEvent } from "./events";
import {
  deriveSlackCaseId,
  deriveSlackCaseRouteIdentities,
} from "./case-routing";
import {
  resolveOrClaimSlackThreadRoute,
  type ResolvedSlackThreadRoute,
  type SlackThreadRouteRequest,
} from "./organisation-routing";
import {
  parseControlRole,
  type OrganisationEnvironment,
} from "@purin-labs/tenancy/data/control-plane";
import type { Variant } from "@purin-labs/type-utils";
import { isPositiveInteger } from "@purin-labs/std";

export type SlackIngressCredential =
  | { readonly kind: "ready"; readonly token: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The bot credential for replies to this ingress. Admission never depends on
 * it, so it resolves beside admission and only its consumers await it. It never
 * rejects, and it is released only after its placement fence is rechecked.
 */
export type PendingSlackIngressCredential = Promise<SlackIngressCredential>;

/** An admission decided in the Worker, with the credential its replies use. */
export type SlackCaseIngress = {
  readonly admission: SlackCaseIngressAdmission;
  readonly slackCredential: PendingSlackIngressCredential | null;
};

/** The directory facts an admission is decided against. */
export type SlackCaseIngressRoute = Pick<
  ResolvedSlackThreadRoute,
  | "installationId"
  | "connectionId"
  | "organisationId"
  | "integrationAccountId"
  | "caseId"
  | "routingSource"
>;

type SlackCaseIngressRouting =
  | { readonly kind: "routed"; readonly route: ResolvedSlackThreadRoute }
  | Variant<SlackCaseIngressAdmission, "rejected" | "retry">;

export type AuthorizedSlackCaseIngress = {
  readonly installationId: SlackInstallationId;
  readonly organisationConnectionId: SlackOrganisationConnectionId;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly userId: UserId;
  readonly principalId: PersonId;
  readonly membershipRole: SlackCommandRole;
  readonly membershipRevision: number;
  readonly placement: OrganisationPlacement;
  readonly caseId: CaseId;
  readonly connectorId: ConnectorId;
  readonly sessionId: SessionId;
  readonly assignmentId: AssignmentId;
};

export type SlackCommandRole = "owner" | "admin" | "operator";

type SlackIdentityLinkRequired = {
  readonly organisationId: OrganisationId;
  readonly workspaceId: SlackMessageEvent["workspaceId"];
  readonly externalUserId: SlackMessageEvent["author"];
};

export type SlackCaseIngressAdmission =
  | { readonly kind: "authorized"; readonly value: AuthorizedSlackCaseIngress }
  | {
      readonly kind: "identity_link_required";
      readonly value: SlackIdentityLinkRequired;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "organisation_inactive"
        | "install_inactive"
        | "destination_missing"
        | "case_missing"
        | "identity_link_missing"
        | "organisation_membership_missing"
        | "command_not_permitted";
    }
  | { readonly kind: "retry"; readonly code: string };

type SlackCaseIngressRow = {
  readonly integrationAccountId: unknown;
  readonly organisationId: unknown;
  readonly organisationStatus: unknown;
  readonly accountLifecycle: unknown;
  readonly destinationChannelId: unknown;
  readonly placementKind: unknown;
  readonly placementEpoch: unknown;
  readonly placementCellId: unknown;
  readonly placementFenceToken: unknown;
  readonly locationHint: unknown;
  readonly residencyJurisdiction: unknown;
  readonly userId: unknown;
  readonly personId: unknown;
  readonly membershipStatus: unknown;
  readonly membershipRole: unknown;
  readonly membershipRevision: unknown;
  readonly commandPermitted: unknown;
  readonly connectorPhysicalObjectName: unknown;
  readonly connectorLifecycleStatus: unknown;
  readonly connectorSchemaVersion: unknown;
  readonly connectorPlacementEpoch: unknown;
  readonly connectorPlacementCellId: unknown;
  readonly caseLifecycleStatus: unknown;
};

type SlackIngressCredentialRow = {
  readonly credentialActive: unknown;
  readonly vaultHandle: unknown;
  readonly keyVersion: unknown;
  readonly algorithm: unknown;
  readonly nonceB64: unknown;
  readonly ciphertextB64: unknown;
  readonly createdAt: unknown;
  readonly rotatedAt: unknown;
  readonly revokedAt: unknown;
};

export async function resolveSlackCaseIngressRoute(input: {
  readonly db: GlobalDatabase;
  readonly event: SlackMessageEvent;
  readonly occurredAt: number;
  readonly installationIdentity: {
    readonly environment: OrganisationEnvironment;
    readonly appId: SlackAppId;
  };
}): Promise<SlackCaseIngressRouting> {
  if (input.event.appId !== input.installationIdentity.appId) {
    return { kind: "rejected", reason: "install_inactive" };
  }
  const caseId = deriveSlackCaseId(input.event);
  if (caseId === null) return retryCorrupt();
  const isRoot = input.event.messageTs === input.event.threadTs;
  const routeRequest: SlackThreadRouteRequest = isRoot
    ? {
        kind: "root",
        environment: input.installationIdentity.environment,
        appId: input.installationIdentity.appId,
        workspaceId: input.event.workspaceId,
        channelId: input.event.channelId,
        rootMessageTs: input.event.threadTs,
        caseId,
        occurredAt: input.occurredAt,
        externalUserId: input.event.author,
      }
    : {
        kind: "reply",
        environment: input.installationIdentity.environment,
        appId: input.installationIdentity.appId,
        workspaceId: input.event.workspaceId,
        channelId: input.event.channelId,
        rootMessageTs: input.event.threadTs,
      };
  const route = await resolveOrClaimSlackThreadRoute(input.db, routeRequest);
  switch (route.kind) {
    case "unbound":
      return { kind: "rejected", reason: "destination_missing" };
    case "disabled":
      return { kind: "rejected", reason: "install_inactive" };
    case "rejected":
      return route.reason === "thread_pin_missing"
        ? { kind: "rejected", reason: "case_missing" }
        : { kind: "retry", code: route.reason };
    case "resolved":
      return { kind: "routed", route: route.value };
    default:
      return route satisfies never;
  }
}

/**
 * Admission decided in the Worker. It serves the answers the Worker gives
 * itself and every message whose Connector is not yet serving the published
 * placement.
 */
export async function authorizeResolvedSlackCaseIngress(input: {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly event: SlackMessageEvent;
  readonly route: ResolvedSlackThreadRoute;
}): Promise<SlackCaseIngress> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.route.organisationId,
  );
  if (!scope.ok) return undecided(scope.error.code);
  const credentialScope =
    input.route.credentialOrganisationId === input.route.organisationId
      ? scope
      : await OrganisationExecutionScope.resolve(
          input.env,
          input.route.credentialOrganisationId,
        );
  if (!credentialScope.ok) return undecided(credentialScope.error.code);
  const [admission, credentialPlacementActive] = await Promise.all([
    authorizeSlackCaseIngressAtScope({
      scope: scope.value,
      event: input.event,
      route: input.route,
    }),
    credentialScope.value === scope.value
      ? true
      : credentialScope.value.isActive(),
  ]);
  if (admission.kind === "retry") return { admission, slackCredential: null };
  if (!credentialPlacementActive)
    return undecided("organisation_placement_conflict");
  return {
    admission,
    slackCredential:
      admission.kind === "rejected" &&
      admission.reason !== "command_not_permitted"
        ? null
        : resolveSlackIngressCredential({
            keys: input.keys,
            scope: credentialScope.value,
            route: input.route,
          }),
  };
}

function undecided(code: string): SlackCaseIngress {
  return { admission: { kind: "retry", code }, slackCredential: null };
}

/** A read of one message's ingress records, started before its scope was known. */
type SlackCaseIngressRead = {
  readonly database: D1Database;
  readonly row: Promise<SlackCaseIngressRow | null>;
};

/**
 * Start reading one message's ingress records from a regional database. An
 * Actor calls this beside its recovery admission, against the database its
 * activation pins. The read decides nothing by itself: the decision uses it
 * only under a scope on the same database, and only when the fence its
 * statement read is that scope's fence.
 */
export function startSlackCaseIngressRead(
  database: OrganisationDatabase,
  event: SlackMessageEvent,
  route: SlackCaseIngressRoute,
): SlackCaseIngressRead {
  const row = readSlackCaseIngressRow(
    database.withSession("first-primary"),
    event,
    route,
  );
  void row.catch(ignoreUnusedIngressRead);
  return { database, row };
}

/** A call refused before it consults the read makes the read's failure moot. */
function ignoreUnusedIngressRead(): void {}

/**
 * Decide one Slack message against the organisation's own records. The caller
 * supplies the execution scope it resolved. The statement that reads the
 * records reads the regional fence too, so a decision never outlives a
 * placement frozen before the records were read.
 */
export async function authorizeSlackCaseIngressAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly event: SlackMessageEvent;
  readonly route: SlackCaseIngressRoute;
  readonly started?: SlackCaseIngressRead | null;
}): Promise<SlackCaseIngressAdmission> {
  const started = input.started ?? null;
  const row = await (started !== null &&
  started.database === input.scope.database
    ? started.row
    : readSlackCaseIngressRow(
        input.scope.database.withSession("first-primary"),
        input.event,
        input.route,
      ));
  if (row === null) return { kind: "retry", code: "install_missing" };
  const parsed = parseSlackCaseIngressRow(row, input.event, input.route);
  // The statement that read the records also read the regional fence: its
  // placement row is the active one. The decision stands only when that row
  // is the placement and fence this scope was admitted under, so it never
  // outlives a placement frozen before the records were read.
  if (
    row.placementEpoch !== input.scope.placement.placementEpoch ||
    row.placementCellId !== input.scope.placement.placementCellId ||
    row.placementFenceToken !== input.scope.fenceToken
  ) {
    return { kind: "retry", code: "organisation_placement_conflict" };
  }
  if (parsed.kind !== "authorized") return parsed;
  if (
    input.event.messageTs !== input.event.threadTs &&
    row.caseLifecycleStatus !== "active"
  )
    return { kind: "rejected", reason: "case_missing" };
  const account = await input.scope.accountAccess.checkUser({
    userId: parsed.value.userId,
    authority: slackEventAccountAuthority(
      input.event,
      parsed.value.integrationAccountId,
    ),
    action: "execute",
  });
  if (!account.ok) {
    return account.error.code === "authority_unavailable"
      ? { kind: "retry", code: "authority_unavailable" }
      : { kind: "rejected", reason: "organisation_membership_missing" };
  }
  const currentRow = await readSlackCaseIngressRow(
    input.scope.database.withSession("first-primary"),
    input.event,
    input.route,
  );
  if (currentRow === null) return { kind: "retry", code: "install_missing" };
  if (
    currentRow.placementEpoch !== input.scope.placement.placementEpoch ||
    currentRow.placementCellId !== input.scope.placement.placementCellId ||
    currentRow.placementFenceToken !== input.scope.fenceToken
  )
    return { kind: "retry", code: "organisation_placement_conflict" };
  const current = parseSlackCaseIngressRow(
    currentRow,
    input.event,
    input.route,
  );
  if (current.kind !== "authorized") return current;
  if (current.value.userId !== parsed.value.userId)
    return { kind: "rejected", reason: "identity_link_missing" };
  if (
    input.event.messageTs !== input.event.threadTs &&
    currentRow.caseLifecycleStatus !== "active"
  )
    return { kind: "rejected", reason: "case_missing" };
  return current;
}

/**
 * The verified Slack event, as the account platform checks its author. A
 * check made after admission names the same event, so it asks about the
 * same person.
 */
export function slackEventAccountAuthority(
  event: SlackMessageEvent,
  integrationAccountId: IntegrationAccountId,
): OrganisationUserAuthority {
  return {
    kind: "authenticated_provider_event",
    provider: "slack",
    nativeEventId: event.eventId,
    nativeIntegrationAccountId: integrationAccountId,
    nativeWorkspaceId: event.workspaceId,
    nativeExternalUserId: event.author,
  };
}

function readSlackCaseIngressRow(
  db: Pick<OrganisationDatabase, "prepare">,
  event: SlackMessageEvent,
  pinnedRoute: SlackCaseIngressRoute,
): Promise<SlackCaseIngressRow | null> {
  return db
    .prepare(
      `SELECT
       account.integration_account_id AS integrationAccountId,
       organisation.organisation_id AS organisationId,
       organisation.status AS organisationStatus,
       account.lifecycle AS accountLifecycle,
       destination.channel_id AS destinationChannelId,
       placement.placement_kind AS placementKind,
       placement.placement_epoch AS placementEpoch,
       placement.placement_cell_id AS placementCellId,
       placement.fence_token AS placementFenceToken,
       placement.location_hint AS locationHint,
       placement.residency_jurisdiction AS residencyJurisdiction,
       identity_link.user_id AS userId,
       membership.person_id AS personId,
       membership.status AS membershipStatus,
       membership.role AS membershipRole,
       onboarding.configuration_version AS membershipRevision,
       CASE WHEN membership.status = 'active'
                  AND membership.role IN ('owner', 'admin', 'operator')
            THEN 1 ELSE 0 END AS commandPermitted,
       connector.physical_object_name AS connectorPhysicalObjectName,
       connector.lifecycle_status AS connectorLifecycleStatus,
       connector.schema_version AS connectorSchemaVersion,
       connector.placement_epoch AS connectorPlacementEpoch,
       connector.placement_cell_id AS connectorPlacementCellId,
       thread_case.lifecycle_status AS caseLifecycleStatus
     FROM integration_account AS account
     JOIN organisation ON organisation.organisation_id = account.organisation_id
     LEFT JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = account.organisation_id
      AND onboarding.environment = account.environment
     LEFT JOIN organisation_slack_channel AS destination
       ON destination.organisation_id = account.organisation_id
      AND destination.integration_account_id = account.integration_account_id
      AND destination.workspace_id = ?
      AND destination.channel_id = ?
     JOIN organisation_placement AS placement
       ON placement.organisation_id = organisation.organisation_id
      AND placement.status = 'active'
     LEFT JOIN external_identity_link AS identity_link
       ON identity_link.organisation_id = organisation.organisation_id
      AND identity_link.workspace_connection_id = account.provider_connection_id
      AND identity_link.workspace_id = ?
      AND identity_link.external_user_id = ?
     LEFT JOIN service_role_grant AS membership
       ON membership.organisation_id = identity_link.organisation_id
      AND membership.user_id = identity_link.user_id
     LEFT JOIN durable_object_registry AS connector
       ON connector.organisation_id = organisation.organisation_id
      AND connector.object_kind = 'connector'
      AND connector.logical_object_id = 'connector_slack_' || account.integration_account_id
      AND connector.placement_epoch = placement.placement_epoch
     LEFT JOIN durable_object_registry AS thread_case
       ON thread_case.organisation_id = organisation.organisation_id
      AND thread_case.object_kind = 'case'
      AND thread_case.logical_object_id = ?
      AND thread_case.placement_epoch = placement.placement_epoch
      AND thread_case.lifecycle_status = 'active'
     WHERE account.organisation_id = ?
       AND account.integration_account_id = ?`,
    )
    .bind(
      event.workspaceId,
      event.channelId,
      event.workspaceId,
      event.author,
      pinnedRoute.caseId,
      pinnedRoute.organisationId,
      pinnedRoute.integrationAccountId,
    )
    .first<SlackCaseIngressRow>();
}

function parseSlackCaseIngressRow(
  row: SlackCaseIngressRow,
  event: SlackMessageEvent,
  pinnedRoute: SlackCaseIngressRoute,
): SlackCaseIngressAdmission {
  if (
    typeof row.organisationId !== "string" ||
    typeof row.integrationAccountId !== "string"
  ) {
    return retryCorrupt();
  }
  const organisationId = parseOrganisationId(row.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) return retryCorrupt();
  if (
    organisationId.value !== pinnedRoute.organisationId ||
    integrationAccountId.value !== pinnedRoute.integrationAccountId
  ) {
    return retryCorrupt();
  }
  if (row.organisationStatus !== "active") {
    return row.organisationStatus === "suspended" ||
      row.organisationStatus === "deleted" ||
      row.organisationStatus === "purged"
      ? { kind: "rejected", reason: "organisation_inactive" }
      : retryCorrupt();
  }
  if (row.accountLifecycle !== "active") {
    return typeof row.accountLifecycle === "string"
      ? { kind: "rejected", reason: "install_inactive" }
      : retryCorrupt();
  }
  if (
    pinnedRoute.routingSource.kind === "channel_default" &&
    row.destinationChannelId !== event.channelId
  ) {
    return row.destinationChannelId === null
      ? { kind: "rejected", reason: "destination_missing" }
      : retryCorrupt();
  }
  if (row.userId === null) {
    return {
      kind: "identity_link_required",
      value: {
        organisationId: organisationId.value,
        workspaceId: event.workspaceId,
        externalUserId: event.author,
      },
    };
  }
  const userId =
    typeof row.userId === "string" ? parseUserId(row.userId) : null;
  if (userId === null || !userId.ok) return retryCorrupt();
  if (row.personId === null || row.membershipStatus !== "active") {
    return { kind: "rejected", reason: "organisation_membership_missing" };
  }
  const principalId = parseStrictPersonId(row.personId);
  if (principalId === null) return retryCorrupt();
  // A known role that may not command, such as viewer, is a refusal. Only a
  // role that the schema does not know is a corrupt record.
  if (row.commandPermitted === 0 && parseControlRole(row.membershipRole).ok)
    return { kind: "rejected", reason: "command_not_permitted" };
  const membershipRole = parseSlackCommandRole(row.membershipRole);
  if (
    membershipRole === null ||
    row.commandPermitted !== 1 ||
    !isPositiveInteger(row.membershipRevision)
  )
    return retryCorrupt();
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
    "slackIngress.placement",
  );
  if (!placement.ok) return retryCorrupt();
  const identities = deriveSlackCaseRouteIdentities(
    integrationAccountId.value,
    event,
  );
  if (!identities.ok || identities.value.caseId !== pinnedRoute.caseId)
    return { kind: "retry", code: "slack_case_route_unavailable" };
  if (
    !connectorRouteIsValidOrAbsent(
      row,
      organisationId.value,
      identities.value.connectorId,
      placement.value,
    )
  ) {
    return { kind: "retry", code: "connector_registry_unavailable" };
  }
  return {
    kind: "authorized",
    value: {
      installationId: pinnedRoute.installationId,
      organisationConnectionId: pinnedRoute.connectionId,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      userId: userId.value,
      principalId,
      membershipRole,
      membershipRevision: row.membershipRevision,
      placement: placement.value,
      ...identities.value,
    },
  };
}

function parseSlackCommandRole(value: unknown): SlackCommandRole | null {
  return value === "owner" || value === "admin" || value === "operator"
    ? value
    : null;
}

function connectorRouteIsValidOrAbsent(
  row: SlackCaseIngressRow,
  organisationId: OrganisationId,
  connectorId: ConnectorId,
  placement: OrganisationPlacement,
): boolean {
  const expectedPhysicalObjectName = actorPhysicalName(
    {
      objectKind: "connector",
      organisationId,
      logicalObjectId: connectorId,
    },
    placement,
  );
  if (
    row.connectorPhysicalObjectName === null &&
    row.connectorLifecycleStatus === null &&
    row.connectorSchemaVersion === null &&
    row.connectorPlacementEpoch === null &&
    row.connectorPlacementCellId === null
  ) {
    return true;
  }
  return (
    row.connectorLifecycleStatus === "active" &&
    typeof row.connectorSchemaVersion === "number" &&
    Number.isSafeInteger(row.connectorSchemaVersion) &&
    row.connectorSchemaVersion > 0 &&
    row.connectorSchemaVersion <= CONNECTOR_ACTOR_SCHEMA_VERSION &&
    row.connectorPlacementEpoch === placement.placementEpoch &&
    row.connectorPlacementCellId === placement.placementCellId &&
    row.connectorPhysicalObjectName === expectedPhysicalObjectName
  );
}

/**
 * Resolve the bot credential for a message decided inside its Connector. The
 * Worker holds no execution scope there, so it resolves one at the published
 * placement first.
 */
export async function resolveSlackIngressCredentialAtPlacement(input: {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly route: ResolvedSlackThreadRoute;
  readonly placement: OrganisationPlacement;
}): PendingSlackIngressCredential {
  try {
    const scope = await OrganisationExecutionScope.resolveAtPlacement(
      input.env,
      input.route.credentialOrganisationId,
      input.placement,
    );
    if (!scope.ok) return unavailableCredential(scope.error.code);
    return await resolveSlackIngressCredential({
      keys: input.keys,
      scope: scope.value,
      route: input.route,
    });
  } catch {
    return unavailableCredential("credential_resolution_failed");
  }
}

async function resolveSlackIngressCredential(input: {
  readonly keys: CredentialVaultBindings;
  readonly scope: OrganisationExecutionScope;
  readonly route: Pick<
    ResolvedSlackThreadRoute,
    "credentialOrganisationId" | "botTokenRef"
  >;
}): PendingSlackIngressCredential {
  try {
    const row = await input.scope.database
      .prepare(
        `SELECT vault_handle AS vaultHandle, key_version AS keyVersion,
        algorithm, nonce_b64 AS nonceB64, ciphertext_b64 AS ciphertextB64,
        created_at AS createdAt, rotated_at AS rotatedAt, revoked_at AS revokedAt,
        1 AS credentialActive
       FROM vault_secret WHERE organisation_id = ? AND vault_handle = ?
        AND revoked_at IS NULL`,
      )
      .bind(input.route.credentialOrganisationId, input.route.botTokenRef)
      .first<SlackIngressCredentialRow>();
    if (row === null || row.credentialActive !== 1)
      return unavailableCredential("credential_inactive");
    const secret = parseVaultSecretRow(row);
    if (secret === null || secret.vaultHandle !== input.route.botTokenRef) {
      return unavailableCredential("credential_corrupt");
    }
    const resolved = await resolveVaultSecretRow({
      keys: input.keys,
      organisationId: input.route.credentialOrganisationId,
      handle: input.route.botTokenRef,
      row: secret,
    });
    if (!resolved.ok) return unavailableCredential(resolved.error.code);
    if (resolved.value.kind !== "bearer")
      return unavailableCredential("credential_kind_invalid");
    // The secret was read beside admission. Its own fence follows the read, so
    // a placement frozen in between cannot release it.
    if (!(await input.scope.isActive()))
      return unavailableCredential("organisation_placement_conflict");
    return { kind: "ready", token: resolved.value.value };
  } catch {
    return unavailableCredential("credential_resolution_failed");
  }
}

function parseVaultSecretRow(
  row: SlackIngressCredentialRow,
): VaultSecretRow | null {
  return typeof row.vaultHandle === "string" &&
    typeof row.keyVersion === "string" &&
    typeof row.algorithm === "string" &&
    typeof row.nonceB64 === "string" &&
    typeof row.ciphertextB64 === "string" &&
    typeof row.createdAt === "number" &&
    (row.rotatedAt === null || typeof row.rotatedAt === "number") &&
    row.revokedAt === null
    ? {
        vaultHandle: row.vaultHandle,
        keyVersion: row.keyVersion,
        algorithm: row.algorithm,
        nonceB64: row.nonceB64,
        ciphertextB64: row.ciphertextB64,
        createdAt: row.createdAt,
        rotatedAt: row.rotatedAt,
        revokedAt: null,
      }
    : null;
}

function unavailableCredential(reason: string): SlackIngressCredential {
  return { kind: "unavailable", reason };
}

function retryCorrupt(): Variant<SlackCaseIngressAdmission, "retry"> {
  return { kind: "retry", code: "slack_case_ingress_record_corrupt" };
}
