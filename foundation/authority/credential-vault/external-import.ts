import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { CredentialVaultBindings } from "./keyring";
import type { VaultHandle, VaultSecret, VaultStoreError } from "./domain";
import { revokeVaultSecret, storeVaultSecret } from "./service";
import type { Variant } from "@purin-labs/type-utils";

export type ExternalVaultSource = {
  readonly kind: "onepassword";
  readonly locator: string;
};

export type ExternalVaultRead =
  | {
      readonly kind: "secret";
      readonly revision: string;
      readonly secret: VaultSecret;
    }
  | {
      readonly kind: "authenticated_tombstone";
      readonly revision: string;
    };

export type ExternalVaultReadError =
  | { readonly code: "external_vault_unavailable" }
  | { readonly code: "external_vault_unauthorized" }
  | { readonly code: "external_vault_response_invalid" }
  | { readonly code: "external_vault_secret_invalid" };

export type ExternalVaultAdapter = {
  readonly source: ExternalVaultSource;
  read(): Promise<Result<ExternalVaultRead, ExternalVaultReadError>>;
};

export type ExternalVaultValidationError = {
  readonly code: "external_vault_validation_failed";
};

export type ExternalVaultImportError =
  | ExternalVaultReadError
  | ExternalVaultValidationError
  | VaultStoreError
  | { readonly code: "external_vault_generation_handle_reused" };

export type ExternalVaultImportReceipt = {
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly source: ExternalVaultSource;
  readonly revision: string;
  readonly state: "active" | "revoked";
  readonly importedAt: number;
  readonly activatedAt: number | null;
  readonly revokedAt: number | null;
};

type ExternalVaultImportRow = {
  readonly externalRevision: unknown;
  readonly state: unknown;
  readonly importedAt: unknown;
  readonly activatedAt: unknown;
  readonly revokedAt: unknown;
};

export async function importExternalVaultSecret(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly adapter: ExternalVaultAdapter;
  readonly validate: (
    secret: VaultSecret,
  ) => Promise<Result<true, ExternalVaultValidationError>>;
  readonly now: number;
}): Promise<Result<ExternalVaultImportReceipt, ExternalVaultImportError>> {
  const read = await input.adapter.read();

  if (!read.ok) {
    return read;
  }

  const existing = await readExternalVaultImport(input);

  if (existing !== null && existing.revision === read.value.revision) {
    return { ok: true, value: existing };
  }

  if (existing !== null && read.value.kind === "secret") {
    return {
      ok: false,
      error: { code: "external_vault_generation_handle_reused" },
    };
  }

  switch (read.value.kind) {
    case "secret":
      return importExternalSecretValue(input, read.value);
    case "authenticated_tombstone":
      return importExternalTombstone(input, read.value.revision);
  }
}

async function importExternalSecretValue(
  input: {
    readonly db: OrganisationDatabase;
    readonly keys: CredentialVaultBindings;
    readonly organisationId: OrganisationId;
    readonly handle: VaultHandle;
    readonly adapter: ExternalVaultAdapter;
    readonly validate: (
      secret: VaultSecret,
    ) => Promise<Result<true, ExternalVaultValidationError>>;
    readonly now: number;
  },
  read: Variant<ExternalVaultRead, "secret">,
): Promise<Result<ExternalVaultImportReceipt, ExternalVaultImportError>> {
  const validated = await input.validate(read.secret);

  if (!validated.ok) {
    return validated;
  }

  const stored = await storeVaultSecret({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
    secret: read.secret,
    now: input.now,
  });

  if (!stored.ok) {
    return stored;
  }

  const receipt: ExternalVaultImportReceipt = {
    organisationId: input.organisationId,
    handle: input.handle,
    source: input.adapter.source,
    revision: read.revision,
    state: "active",
    importedAt: input.now,
    activatedAt: input.now,
    revokedAt: null,
  };
  await writeExternalVaultImport(input.db, receipt);
  return { ok: true, value: receipt };
}

async function importExternalTombstone(
  input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly handle: VaultHandle;
    readonly adapter: ExternalVaultAdapter;
    readonly now: number;
  },
  revision: string,
): Promise<Result<ExternalVaultImportReceipt, ExternalVaultImportError>> {
  await revokeVaultSecret({
    db: input.db,
    organisationId: input.organisationId,
    handle: input.handle,
    now: input.now,
  });

  const receipt: ExternalVaultImportReceipt = {
    organisationId: input.organisationId,
    handle: input.handle,
    source: input.adapter.source,
    revision,
    state: "revoked",
    importedAt: input.now,
    activatedAt: null,
    revokedAt: input.now,
  };
  await writeExternalVaultImport(input.db, receipt);
  return { ok: true, value: receipt };
}

async function readExternalVaultImport(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly adapter: ExternalVaultAdapter;
}): Promise<ExternalVaultImportReceipt | null> {
  const row = await input.db
    .prepare(
      `SELECT external_revision AS externalRevision, state,
              imported_at AS importedAt, activated_at AS activatedAt,
              revoked_at AS revokedAt
       FROM external_vault_import
       WHERE organisation_id = ? AND vault_handle = ?
         AND source_kind = ? AND source_locator = ?`,
    )
    .bind(
      input.organisationId,
      input.handle,
      input.adapter.source.kind,
      input.adapter.source.locator,
    )
    .first<ExternalVaultImportRow>();

  if (row === null) {
    return null;
  }

  return parseExternalVaultImportRow(input, row);
}

function parseExternalVaultImportRow(
  input: {
    readonly organisationId: OrganisationId;
    readonly handle: VaultHandle;
    readonly adapter: ExternalVaultAdapter;
  },
  row: ExternalVaultImportRow,
): ExternalVaultImportReceipt | null {
  if (
    typeof row.externalRevision !== "string" ||
    typeof row.importedAt !== "number"
  ) {
    return null;
  }

  if (
    row.state === "active" &&
    typeof row.activatedAt === "number" &&
    row.revokedAt === null
  ) {
    return {
      organisationId: input.organisationId,
      handle: input.handle,
      source: input.adapter.source,
      revision: row.externalRevision,
      state: "active",
      importedAt: row.importedAt,
      activatedAt: row.activatedAt,
      revokedAt: null,
    };
  }

  if (
    row.state === "revoked" &&
    row.activatedAt === null &&
    typeof row.revokedAt === "number"
  ) {
    return {
      organisationId: input.organisationId,
      handle: input.handle,
      source: input.adapter.source,
      revision: row.externalRevision,
      state: "revoked",
      importedAt: row.importedAt,
      activatedAt: null,
      revokedAt: row.revokedAt,
    };
  }

  return null;
}

async function writeExternalVaultImport(
  db: OrganisationDatabase,
  receipt: ExternalVaultImportReceipt,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO external_vault_import (
         organisation_id, vault_handle, source_kind, source_locator,
         external_revision, state, imported_at, activated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, vault_handle, source_kind, source_locator)
       DO UPDATE SET
         external_revision = excluded.external_revision,
         state = excluded.state,
         imported_at = excluded.imported_at,
         activated_at = excluded.activated_at,
         revoked_at = excluded.revoked_at`,
    )
    .bind(
      receipt.organisationId,
      receipt.handle,
      receipt.source.kind,
      receipt.source.locator,
      receipt.revision,
      receipt.state,
      receipt.importedAt,
      receipt.activatedAt,
      receipt.revokedAt,
    )
    .run();
}
