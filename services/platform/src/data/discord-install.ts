import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";

declare const discordApplicationIdBrand: unique symbol;
declare const discordGuildIdBrand: unique symbol;

export type DiscordApplicationId = string & {
  readonly [discordApplicationIdBrand]: "DiscordApplicationId";
};
export type DiscordGuildId = string & {
  readonly [discordGuildIdBrand]: "DiscordGuildId";
};

export type DiscordInteractionInstall = {
  organisationId: OrganisationId;
  applicationId: DiscordApplicationId;
  guildId: DiscordGuildId;
  publicKeyRef: VaultHandle;
  status: "active";
};

export type DiscordInstallError =
  | { code: "discord_install_not_found" }
  | { code: "discord_install_invalid"; field: string };

type DiscordInstallRow = {
  applicationId: unknown;
  guildId: unknown;
  publicKeyRef: unknown;
  status: unknown;
};

const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{5,24}$/u;

export function parseDiscordApplicationId(
  raw: string,
): Result<DiscordApplicationId, DiscordInstallError> {
  return DISCORD_SNOWFLAKE_PATTERN.test(raw)
    ? { ok: true, value: raw as DiscordApplicationId }
    : invalidInstall("applicationId");
}

export function parseDiscordGuildId(
  raw: string,
): Result<DiscordGuildId, DiscordInstallError> {
  return DISCORD_SNOWFLAKE_PATTERN.test(raw)
    ? { ok: true, value: raw as DiscordGuildId }
    : invalidInstall("guildId");
}

export async function writeDiscordInteractionInstall(
  db: OrganisationDatabase,
  input: DiscordInteractionInstall & { installedAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO discord_interaction_install (
         organisation_id, application_id, guild_id, public_key_ref, status, installed_at
       ) VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         application_id = excluded.application_id,
         guild_id = excluded.guild_id,
         public_key_ref = excluded.public_key_ref,
         status = 'active',
         installed_at = excluded.installed_at`,
    )
    .bind(
      input.organisationId,
      input.applicationId,
      input.guildId,
      input.publicKeyRef,
      input.installedAt,
    )
    .run();
}

export async function readActiveDiscordInteractionInstall(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<DiscordInteractionInstall, DiscordInstallError>> {
  const row = await db
    .prepare(
      `SELECT
         application_id AS applicationId,
         guild_id AS guildId,
         public_key_ref AS publicKeyRef,
         status
       FROM discord_interaction_install
       WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<DiscordInstallRow>();

  if (row === null || row.status !== "active") {
    return { ok: false, error: { code: "discord_install_not_found" } };
  }

  const applicationId =
    typeof row.applicationId === "string"
      ? parseDiscordApplicationId(row.applicationId)
      : invalidInstall("applicationId");
  const guildId =
    typeof row.guildId === "string"
      ? parseDiscordGuildId(row.guildId)
      : invalidInstall("guildId");
  const publicKeyRef =
    typeof row.publicKeyRef === "string"
      ? parseVaultHandle(row.publicKeyRef)
      : {
          ok: false as const,
          error: { code: "invalid_vault_handle" as const },
        };

  if (!applicationId.ok) {
    return applicationId;
  }

  if (!guildId.ok) {
    return guildId;
  }

  if (!publicKeyRef.ok) {
    return invalidInstall("publicKeyRef");
  }

  return {
    ok: true,
    value: {
      organisationId,
      applicationId: applicationId.value,
      guildId: guildId.value,
      publicKeyRef: publicKeyRef.value,
      status: "active",
    },
  };
}

function invalidInstall(field: string): Result<never, DiscordInstallError> {
  return { ok: false, error: { code: "discord_install_invalid", field } };
}
