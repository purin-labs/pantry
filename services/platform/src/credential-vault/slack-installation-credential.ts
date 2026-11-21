/**
 * The Slack workspace installation owns its bot token (Refactor 15, refactor
 * 5). One Organisation's Vault holds the token for every Organisation that
 * uses the workspace, and `slack_installation.credential_organisation_id`
 * names it. The owner must be an Organisation that still uses the
 * workspace:
 *
 * - Before a purge erases an owner's Vault, the purge moves the token to
 *   another Organisation with an active connection in the workspace. With no
 *   such Organisation, the installation is revoked and the token is erased
 *   with the Vault.
 * - A connect to a workspace whose owner has no active connection there makes
 *   the connecting Organisation the owner (`slackInstallationOwnerIsLive`).
 */
import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import {
  parseOrganisationId,
  parseSlackInstallationId,
  type OrganisationId,
  type SlackInstallationId,
} from "../ids";
import { organisationLifecycleParts } from "../data/organisation-lifecycle-port";
import { parseVaultHandle } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import {
  resolveVaultHandle,
  storeOrganisationPlacementVaultSecret,
} from "./service";

type OwnedInstallationRow = Readonly<{
  installationId: unknown;
  workspaceId: unknown;
  botTokenRef: unknown;
}>;

/**
 * True when the installation's credential owner has an active connection in
 * the installation, so its Vault serves the workspace.
 */
export async function slackInstallationOwnerIsLive(
  directory: Pick<GlobalDatabase, "prepare">,
  installationId: SlackInstallationId,
  ownerOrganisationId: OrganisationId,
): Promise<boolean> {
  const row = await directory
    .prepare(
      `SELECT 1 AS live FROM slack_organisation_connection
       WHERE installation_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(installationId, ownerOrganisationId)
    .first<{ readonly live: unknown }>();
  return row !== null;
}

/**
 * Moves the bot token of each installation that `organisationId` owns to an
 * Organisation that still uses the workspace, or revokes the installation
 * when none does. The purge calls it before it erases the Vault, and it is
 * safe to repeat: a moved installation no longer names the Organisation. A
 * token that cannot be read or stored throws, so the purge waits.
 */
export async function releaseSlackInstallationCredentials(input: {
  readonly env: OrganisationPlacementBindings & CredentialVaultBindings;
  readonly directory: GlobalDatabase;
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<number> {
  const parts = organisationLifecycleParts().purge;
  const owned = await input.directory
    .prepare(
      `SELECT installation_id AS installationId, workspace_id AS workspaceId,
              bot_token_ref AS botTokenRef
       FROM slack_installation WHERE credential_organisation_id = ?`,
    )
    .bind(input.organisationId)
    .all<OwnedInstallationRow>();
  let moved = 0;
  for (const row of owned.results) {
    const installationId =
      typeof row.installationId === "string"
        ? parseSlackInstallationId(row.installationId)
        : null;
    const handle =
      typeof row.botTokenRef === "string"
        ? parseVaultHandle(row.botTokenRef)
        : null;
    if (
      !installationId?.ok ||
      !handle?.ok ||
      typeof row.workspaceId !== "string"
    )
      throw new Error("slack_installation_corrupt");
    const next = await input.directory
      .prepare(
        `SELECT organisation_id AS organisationId FROM slack_organisation_connection
         WHERE installation_id = ? AND organisation_id != ? AND lifecycle = 'active'
         ORDER BY connected_at, organisation_id LIMIT 1`,
      )
      .bind(installationId.value, input.organisationId)
      .first<{ readonly organisationId: unknown }>();
    if (next === null) {
      const revoked = await parts
        .slackInstallationRevocation(input.directory, {
          installationId: installationId.value,
          organisationId: input.organisationId,
          now: input.now,
        })
        .run();
      moved += revoked.meta.changes;
      continue;
    }
    const nextOrganisationId =
      typeof next.organisationId === "string"
        ? parseOrganisationId(next.organisationId)
        : null;
    if (!nextOrganisationId?.ok) throw new Error("slack_connection_corrupt");
    const secret = await resolveVaultHandle({
      db: input.db,
      keys: input.env,
      organisationId: input.organisationId,
      handle: handle.value,
    });
    if (!secret.ok) throw new Error(`slack_credential_${secret.error.code}`);
    const scope = await OrganisationExecutionScope.resolve(
      input.env,
      nextOrganisationId.value,
    );
    if (!scope.ok) throw new Error(scope.error.code);
    const parsedHandle = parseVaultHandle(
      `vault:${nextOrganisationId.value.toLowerCase()}:slack:${row.workspaceId.toLowerCase().replace(/[^a-z0-9_-]/gu, "-")}:installation:${input.now}`,
    );
    if (!parsedHandle.ok) throw new Error(parsedHandle.error.code);
    const nextHandle = parsedHandle.value;
    const stored = await storeOrganisationPlacementVaultSecret({
      scope: scope.value,
      keys: input.env,
      handle: nextHandle,
      secret: secret.value,
      now: input.now,
    });
    if (!stored.ok) throw new Error(stored.error.code);
    const changed = await parts
      .slackInstallationCredentialMove(input.directory, {
        installationId: installationId.value,
        organisationId: input.organisationId,
        botTokenRef: handle.value,
        nextOrganisationId: nextOrganisationId.value,
        nextBotTokenRef: nextHandle,
        now: input.now,
      })
      .run();
    moved += changed.meta.changes;
  }
  return moved;
}
