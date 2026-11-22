import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import type { OrganisationInstallRecord } from "@purin-labs/tenancy/data/organisation";
import {
  parseOrganisationId,
  parseIntegrationAccountId,
  type ChannelId,
  type IntegrationAccountId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { SlackInstallationIdentity } from "../slack/installation-identity";
import type { VaultResolveError, VaultSecret } from "./domain";
import { parseVaultHandle, type VaultHandle } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle } from "./service";

export type SurfaceInstallationResolutionError =
  VaultResolveError | { readonly code: "surface_installation_inactive" };

export type SlackThreadCredentialResolutionError =
  VaultResolveError | { readonly code: "slack_thread_route_inactive" };

export async function resolveSurfaceInstallationCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly install: OrganisationInstallRecord;
}): Promise<Result<VaultSecret, SurfaceInstallationResolutionError>> {
  if (
    input.install.organisationStatus !== "active" ||
    input.install.installStatus !== "active"
  ) {
    return { ok: false, error: { code: "surface_installation_inactive" } };
  }

  const active = await input.db
    .prepare(
      `SELECT installation.bot_token_ref AS botTokenRef
       FROM surface_installation AS installation
       JOIN organisation
         ON organisation.organisation_id = installation.organisation_id
        AND organisation.status = 'active'
       JOIN integration_account AS account
         ON account.integration_account_id = installation.integration_account_id
        AND account.organisation_id = installation.organisation_id
        AND account.lifecycle = 'active'
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
        AND connection.provider = account.provider
        AND connection.environment = account.environment
        AND connection.credential_ref = installation.bot_token_ref
        AND connection.lifecycle = 'active'
       JOIN provider_credential_generation AS generation
         ON generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.organisation_id = connection.organisation_id
        AND generation.provider = connection.provider
        AND generation.environment = connection.environment
        AND generation.credential_ref = connection.credential_ref
        AND generation.lifecycle = 'active'
       WHERE installation.organisation_id = ?
         AND installation.integration_account_id = ?
         AND installation.surface_kind = ?
         AND installation.workspace_id = ?
         AND installation.bot_token_ref = ?
       LIMIT 1`,
    )
    .bind(
      input.install.organisationId,
      input.install.integrationAccountId,
      input.install.surfaceKind,
      input.install.workspaceId,
      input.install.botTokenRef,
    )
    .first<{ readonly botTokenRef: unknown }>();

  if (active?.botTokenRef !== input.install.botTokenRef) {
    return { ok: false, error: { code: "surface_installation_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.install.organisationId,
    handle: input.install.botTokenRef,
  });
}

export async function resolveActiveSlackThreadCredential(input: {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly installationIdentity: SlackInstallationIdentity;
  readonly organisationId: OrganisationId;
  readonly workspaceId: WorkspaceId;
  readonly channelId: ChannelId;
  readonly rootMessageTs: string;
}): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  const route = await readSlackThreadCredentialRoute(input);
  if (!route.ok) return route;
  return resolveRegionalSlackCredential({
    env: input.env,
    keys: input.keys,
    organisationId: input.organisationId,
    integrationAccountId: route.value.integrationAccountId,
    credentialOrganisationId: route.value.credentialOrganisationId,
    handle: route.value.botTokenRef,
  });
}

/** Where the bot credential of a Slack thread is kept. */
type SlackThreadCredentialRoute = {
  readonly credentialOrganisationId: OrganisationId;
  readonly botTokenRef: VaultHandle;
  readonly integrationAccountId: IntegrationAccountId;
};

/**
 * Whether the scope's database holds the credential of the route. It does
 * not when another Organisation holds the credential.
 */
export function slackThreadCredentialIsAtScope(
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  route: SlackThreadCredentialRoute,
): boolean {
  return (
    scope.organisationId === organisationId &&
    route.credentialOrganisationId === organisationId
  );
}

/**
 * The thread's bot credential for a caller that holds the Organisation's
 * admitted scope and has read the credential's route. When the scope's
 * database holds the credential, the account check and the vault read start
 * together in it, and the placement directory is not read again.
 *
 * This function reads no placement fence. The caller must read the scope's
 * fence before it uses the credential. It reads the fence after this
 * function returns. When `slackThreadCredentialIsAtScope` holds, it can
 * start the fence read beside this function instead, so the two share one
 * wait.
 */
export async function resolveRoutedSlackThreadCredential(input: {
  readonly scope: OrganisationExecutionScope;
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly route: SlackThreadCredentialRoute;
}): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  if (
    !slackThreadCredentialIsAtScope(
      input.scope,
      input.organisationId,
      input.route,
    )
  ) {
    // Another Organisation holds the credential. Its scope is not the
    // caller's, so its placement is resolved and read in full.
    return resolveRegionalSlackCredential({
      env: input.env,
      keys: input.keys,
      organisationId: input.organisationId,
      integrationAccountId: input.route.integrationAccountId,
      credentialOrganisationId: input.route.credentialOrganisationId,
      handle: input.route.botTokenRef,
    });
  }
  const [active, credential] = await Promise.all([
    readActiveIntegrationAccount(
      input.scope.database,
      input.organisationId,
      input.route.integrationAccountId,
    ),
    resolveVaultHandle({
      db: input.scope.database,
      keys: input.keys,
      organisationId: input.organisationId,
      handle: input.route.botTokenRef,
    }),
  ]);
  if (active === null) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  return credential;
}

/**
 * The route of a thread's bot credential: one read of the global database.
 * It decides nothing and reads no placement fence.
 */
export async function readSlackThreadCredentialRoute(input: {
  readonly env: OrganisationPlacementBindings;
  readonly installationIdentity: SlackInstallationIdentity;
  readonly organisationId: OrganisationId;
  readonly workspaceId: WorkspaceId;
  readonly channelId: ChannelId;
  readonly rootMessageTs: string;
}): Promise<
  Result<
    SlackThreadCredentialRoute,
    { readonly code: "slack_thread_route_inactive" }
  >
> {
  const row = await input.env.DB.prepare(
    `SELECT installation.credential_organisation_id AS credentialOrganisationId,
              installation.bot_token_ref AS botTokenRef,
              connection.integration_account_id AS integrationAccountId
       FROM slack_installation AS installation
       JOIN slack_thread_case_pin AS pin
         ON pin.installation_id = installation.installation_id
        AND pin.channel_id = ?
        AND pin.root_message_ts = ?
        AND pin.organisation_id = ?
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = pin.installation_id
        AND connection.connection_id = pin.connection_id
        AND connection.organisation_id = pin.organisation_id
        AND connection.integration_account_id = pin.integration_account_id
        AND connection.lifecycle = 'active'
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'`,
  )
    .bind(
      input.channelId,
      input.rootMessageTs,
      input.organisationId,
      input.installationIdentity.environment,
      input.installationIdentity.appId,
      input.workspaceId,
    )
    .first<{
      readonly credentialOrganisationId: unknown;
      readonly botTokenRef: unknown;
      readonly integrationAccountId: unknown;
    }>();
  if (
    row === null ||
    typeof row.credentialOrganisationId !== "string" ||
    typeof row.botTokenRef !== "string" ||
    typeof row.integrationAccountId !== "string"
  ) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credentialOrganisationId = parseOrganisationId(
    row.credentialOrganisationId,
  );
  const botTokenRef = parseVaultHandle(row.botTokenRef);
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  if (
    !credentialOrganisationId.ok ||
    !botTokenRef.ok ||
    !integrationAccountId.ok
  ) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  return {
    ok: true,
    value: {
      credentialOrganisationId: credentialOrganisationId.value,
      botTokenRef: botTokenRef.value,
      integrationAccountId: integrationAccountId.value,
    },
  };
}

type SlackOrganisationCredentialRequest = {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly installationIdentity: SlackInstallationIdentity;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly workspaceId: WorkspaceId;
};

export function resolveActiveSlackOrganisationCredential(
  input: SlackOrganisationCredentialRequest,
): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  return resolveSlackOrganisationCredential(input, "active");
}

/**
 * The bot token for a health check of the Organisation's Slack account. It
 * reads a degraded account too, so that a healthy check can make the account
 * usable again; nothing else may use a degraded account's token.
 */
export function resolveSlackHealthCheckCredential(
  input: SlackOrganisationCredentialRequest,
): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  return resolveSlackOrganisationCredential(input, "active_or_degraded");
}

async function resolveSlackOrganisationCredential(
  input: SlackOrganisationCredentialRequest,
  accounts: AccountLifecycles,
): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  const row = await input.env.DB.prepare(
    `SELECT installation.credential_organisation_id AS credentialOrganisationId,
              installation.bot_token_ref AS botTokenRef
       FROM slack_installation AS installation
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = installation.installation_id
        AND connection.organisation_id = ?
        AND connection.integration_account_id = ?
        AND connection.lifecycle = 'active'
       WHERE installation.environment = ?
         AND installation.app_id = ?
         AND installation.workspace_id = ?
         AND installation.lifecycle = 'active'`,
  )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.installationIdentity.environment,
      input.installationIdentity.appId,
      input.workspaceId,
    )
    .first<{
      readonly credentialOrganisationId: unknown;
      readonly botTokenRef: unknown;
    }>();
  if (
    row === null ||
    typeof row.credentialOrganisationId !== "string" ||
    typeof row.botTokenRef !== "string"
  ) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credentialOrganisationId = parseOrganisationId(
    row.credentialOrganisationId,
  );
  const botTokenRef = parseVaultHandle(row.botTokenRef);
  if (!credentialOrganisationId.ok || !botTokenRef.ok) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  return resolveRegionalSlackCredential({
    env: input.env,
    keys: input.keys,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    credentialOrganisationId: credentialOrganisationId.value,
    handle: botTokenRef.value,
    accounts,
  });
}

export async function resolveActiveSlackPhysicalInstallationCredential(input: {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly installationIdentity: SlackInstallationIdentity;
  readonly workspaceId: WorkspaceId;
}): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  const row = await input.env.DB.prepare(
    `SELECT credential_organisation_id AS credentialOrganisationId,
              bot_token_ref AS botTokenRef
       FROM slack_installation
       WHERE environment = ? AND app_id = ? AND workspace_id = ?
         AND lifecycle = 'active'`,
  )
    .bind(
      input.installationIdentity.environment,
      input.installationIdentity.appId,
      input.workspaceId,
    )
    .first<{
      readonly credentialOrganisationId: unknown;
      readonly botTokenRef: unknown;
    }>();
  if (
    row === null ||
    typeof row.credentialOrganisationId !== "string" ||
    typeof row.botTokenRef !== "string"
  ) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credentialOrganisationId = parseOrganisationId(
    row.credentialOrganisationId,
  );
  const botTokenRef = parseVaultHandle(row.botTokenRef);
  if (!credentialOrganisationId.ok || !botTokenRef.ok) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    credentialOrganisationId.value,
  );
  if (!scope.ok) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credential = await resolveVaultHandle({
    db: scope.value.database,
    keys: input.keys,
    organisationId: credentialOrganisationId.value,
    handle: botTokenRef.value,
  });
  if (!(await scope.value.isActive())) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  return credential;
}

async function resolveRegionalSlackCredential(input: {
  readonly env: OrganisationPlacementBindings;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly credentialOrganisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly accounts?: AccountLifecycles;
}): Promise<Result<VaultSecret, SlackThreadCredentialResolutionError>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const active = await readActiveIntegrationAccount(
    scope.value.database,
    input.organisationId,
    input.integrationAccountId,
    input.accounts,
  );
  if (active === null) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credentialScope =
    input.credentialOrganisationId === input.organisationId
      ? scope
      : await OrganisationExecutionScope.resolve(
          input.env,
          input.credentialOrganisationId,
        );
  if (!credentialScope.ok) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  const credential = await resolveVaultHandle({
    db: credentialScope.value.database,
    keys: input.keys,
    organisationId: input.credentialOrganisationId,
    handle: input.handle,
  });
  if (
    !(await scope.value.isActive()) ||
    !(await credentialScope.value.isActive())
  ) {
    return { ok: false, error: { code: "slack_thread_route_inactive" } };
  }
  return credential;
}

type AccountLifecycles = "active" | "active_or_degraded";

/**
 * A row when the account and its Organisation are both active. A health
 * check also accepts a degraded account.
 */
function readActiveIntegrationAccount(
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  accounts: AccountLifecycles = "active",
): Promise<unknown> {
  return database
    .prepare(
      `SELECT 1 FROM integration_account AS account
     JOIN organisation ON organisation.organisation_id = account.organisation_id AND organisation.status = 'active'
     WHERE account.organisation_id = ? AND account.integration_account_id = ?
       AND (account.lifecycle = 'active' OR (? AND account.lifecycle = 'degraded'))`,
    )
    .bind(
      organisationId,
      integrationAccountId,
      accounts === "active_or_degraded" ? 1 : 0,
    )
    .first();
}
