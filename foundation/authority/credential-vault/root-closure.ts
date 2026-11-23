import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { type Result } from "@purin-labs/kernel/result";
import { decryptVaultPayload } from "./crypto";
import { parseVaultHandle, type VaultHandle } from "./domain";
import {
  loadCredentialVaultKeyRing,
  vaultRootForVersion,
  type CredentialVaultBindings,
  type VaultKeyRing,
  type VaultKeyRingError,
  type VaultKeyVersion,
} from "./keyring";
import { validateVaultPlaintext } from "./service";

/**
 * The check reads the rows of each database in pages of this size, in the
 * order of their key, and keeps only counts. So the whole Vault fits in one
 * check, however many rows it has.
 */
const RETAINED_VAULT_PAGE_ROWS = 500;

type RetainedVaultCiphertextRow = {
  readonly organisationId: unknown;
  readonly vaultHandle: unknown;
  readonly keyVersion: unknown;
  readonly algorithm: unknown;
  readonly nonceB64: unknown;
  readonly ciphertextB64: unknown;
  readonly revokedAt: unknown;
};

type ParsedRetainedVaultCiphertextRow = {
  readonly organisationId: OrganisationId;
  readonly vaultHandle: VaultHandle;
  readonly keyVersion: VaultKeyVersion;
  readonly algorithm: "AES-GCM-256";
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly revokedAt: number | null;
};

type RetainedVaultRootVersionSummary = {
  readonly keyVersion: VaultKeyVersion;
  readonly rowCount: number;
  readonly decryptedCount: number;
};

type RetainedVaultRootClosureFinding =
  | {
      readonly kind: "referenced_vault_root_unavailable";
      readonly keyVersion: VaultKeyVersion;
      readonly affectedRows: number;
    }
  | {
      readonly kind: "retained_vault_ciphertext_invalid";
      readonly keyVersion: VaultKeyVersion;
      readonly affectedRows: number;
    }
  | {
      readonly kind: "retained_vault_plaintext_invalid";
      readonly keyVersion: VaultKeyVersion;
      readonly affectedRows: number;
    };

type RetainedVaultRootClosureCounts = {
  readonly auditedRowCount: number;
  readonly revokedRowCount: number;
  readonly versions: readonly RetainedVaultRootVersionSummary[];
};

export type RetainedVaultRootClosure =
  | (RetainedVaultRootClosureCounts & {
      readonly status: "passed";
      readonly findings: readonly [];
    })
  | (RetainedVaultRootClosureCounts & {
      readonly status: "failed";
      readonly findings: readonly [
        RetainedVaultRootClosureFinding,
        ...RetainedVaultRootClosureFinding[],
      ];
    });

export type RetainedVaultRootClosureError =
  | VaultKeyRingError
  | { readonly code: "retained_vault_root_data_invalid" }
  | { readonly code: "retained_vault_root_persistence_failed" };

type VersionCounts = {
  rowCount: number;
  decryptedCount: number;
  unavailableCount: number;
  invalidCiphertextCount: number;
  invalidPlaintextCount: number;
};

export async function inspectRetainedVaultRootClosure(input: {
  readonly databases: readonly OrganisationDatabase[];
  readonly keys: CredentialVaultBindings;
}): Promise<Result<RetainedVaultRootClosure, RetainedVaultRootClosureError>> {
  const keyRing = await loadCredentialVaultKeyRing(input.keys);
  if (!keyRing.ok) return keyRing;

  const versionCounts = new Map<VaultKeyVersion, VersionCounts>();
  let auditedRowCount = 0;
  let revokedRowCount = 0;
  for (const database of new Set(input.databases)) {
    let after: RetainedVaultRowKey | null = null;
    for (;;) {
      const page = await readRetainedVaultCiphertextPage(database, after);
      if (!page.ok) return page;
      for (const raw of page.value) {
        const row = parseRetainedVaultCiphertextRow(raw);
        if (!row.ok) return row;
        auditedRowCount += 1;
        if (row.value.revokedAt !== null) revokedRowCount += 1;
        const checked = await checkRetainedVaultRow(
          keyRing.value,
          row.value,
          versionCounts,
        );
        if (!checked.ok) return checked;
        after = row.value;
      }
      if (page.value.length < RETAINED_VAULT_PAGE_ROWS) break;
    }
  }

  const findings = rootClosureFindings(versionCounts);
  const versions = rootVersionSummaries(versionCounts);
  const counts: RetainedVaultRootClosureCounts = {
    auditedRowCount,
    revokedRowCount,
    versions,
  };
  const [first, ...rest] = findings;
  return {
    ok: true,
    value:
      first === undefined
        ? { status: "passed", ...counts, findings: [] }
        : { status: "failed", ...counts, findings: [first, ...rest] },
  };
}

type RetainedVaultRowKey = Readonly<{
  organisationId: string;
  vaultHandle: string;
}>;

/** Decrypts one row with the root of its version and counts the outcome. */
async function checkRetainedVaultRow(
  keyRing: VaultKeyRing,
  row: ParsedRetainedVaultCiphertextRow,
  versionCounts: Map<VaultKeyVersion, VersionCounts>,
): Promise<
  Result<null, { readonly code: "retained_vault_root_data_invalid" }>
> {
  const counts = versionCounts.get(row.keyVersion) ?? {
    rowCount: 0,
    decryptedCount: 0,
    unavailableCount: 0,
    invalidCiphertextCount: 0,
    invalidPlaintextCount: 0,
  };
  counts.rowCount += 1;
  versionCounts.set(row.keyVersion, counts);

  const root = vaultRootForVersion(keyRing, row.keyVersion);
  if (!root.ok) {
    if (root.error.code === "vault_key_version_invalid")
      return { ok: false, error: { code: "retained_vault_root_data_invalid" } };
    counts.unavailableCount += 1;
    return { ok: true, value: null };
  }
  const decrypted = await decryptVaultPayload({
    key: root.value.key,
    organisationId: row.organisationId,
    handle: row.vaultHandle,
    keyVersion: row.keyVersion,
    nonceB64: row.nonceB64,
    ciphertextB64: row.ciphertextB64,
  });
  if (!decrypted.ok) {
    counts.invalidCiphertextCount += 1;
    return { ok: true, value: null };
  }
  const plaintext = validateVaultPlaintext(decrypted.value, row.vaultHandle);
  if (!plaintext.ok) {
    counts.invalidPlaintextCount += 1;
    return { ok: true, value: null };
  }
  counts.decryptedCount += 1;
  return { ok: true, value: null };
}

/** One page of rows, in key order, after the key of the last row read. */
async function readRetainedVaultCiphertextPage(
  db: OrganisationDatabase,
  after: RetainedVaultRowKey | null,
): Promise<
  Result<
    readonly RetainedVaultCiphertextRow[],
    | { readonly code: "retained_vault_root_persistence_failed" }
    | { readonly code: "retained_vault_root_data_invalid" }
  >
> {
  try {
    const result = await db
      .prepare(
        `SELECT organisation_id AS organisationId,
              vault_handle AS vaultHandle,
              key_version AS keyVersion,
              algorithm,
              nonce_b64 AS nonceB64,
              ciphertext_b64 AS ciphertextB64,
              revoked_at AS revokedAt
       FROM vault_secret
       WHERE ? IS NULL OR organisation_id > ?
         OR (organisation_id = ? AND vault_handle > ?)
       ORDER BY organisation_id, vault_handle
       LIMIT ?`,
      )
      .bind(
        after?.organisationId ?? null,
        after?.organisationId ?? null,
        after?.organisationId ?? null,
        after?.vaultHandle ?? null,
        RETAINED_VAULT_PAGE_ROWS,
      )
      .all<RetainedVaultCiphertextRow>();
    return Array.isArray(result.results)
      ? { ok: true, value: result.results }
      : { ok: false, error: { code: "retained_vault_root_data_invalid" } };
  } catch {
    return {
      ok: false,
      error: { code: "retained_vault_root_persistence_failed" },
    };
  }
}

function parseRetainedVaultCiphertextRow(
  raw: RetainedVaultCiphertextRow,
): Result<
  ParsedRetainedVaultCiphertextRow,
  { readonly code: "retained_vault_root_data_invalid" }
> {
  const organisationId =
    typeof raw.organisationId === "string"
      ? parseOrganisationId(raw.organisationId)
      : { ok: false as const };
  const vaultHandle =
    typeof raw.vaultHandle === "string"
      ? parseVaultHandle(raw.vaultHandle)
      : { ok: false as const };
  if (
    !organisationId.ok ||
    !vaultHandle.ok ||
    (raw.keyVersion !== "v1" && raw.keyVersion !== "v2") ||
    raw.algorithm !== "AES-GCM-256" ||
    typeof raw.nonceB64 !== "string" ||
    typeof raw.ciphertextB64 !== "string" ||
    (raw.revokedAt !== null &&
      (typeof raw.revokedAt !== "number" ||
        !Number.isSafeInteger(raw.revokedAt) ||
        raw.revokedAt < 0))
  ) {
    return { ok: false, error: { code: "retained_vault_root_data_invalid" } };
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      vaultHandle: vaultHandle.value,
      keyVersion: raw.keyVersion,
      algorithm: raw.algorithm,
      nonceB64: raw.nonceB64,
      ciphertextB64: raw.ciphertextB64,
      revokedAt: raw.revokedAt,
    },
  };
}

function rootClosureFindings(
  counts: ReadonlyMap<
    VaultKeyVersion,
    {
      readonly unavailableCount: number;
      readonly invalidCiphertextCount: number;
      readonly invalidPlaintextCount: number;
    }
  >,
): RetainedVaultRootClosureFinding[] {
  const findings: RetainedVaultRootClosureFinding[] = [];
  for (const keyVersion of orderedKeyVersions()) {
    const version = counts.get(keyVersion);
    if (version === undefined) continue;
    if (version.unavailableCount > 0) {
      findings.push({
        kind: "referenced_vault_root_unavailable",
        keyVersion,
        affectedRows: version.unavailableCount,
      });
    }
    if (version.invalidCiphertextCount > 0) {
      findings.push({
        kind: "retained_vault_ciphertext_invalid",
        keyVersion,
        affectedRows: version.invalidCiphertextCount,
      });
    }
    if (version.invalidPlaintextCount > 0) {
      findings.push({
        kind: "retained_vault_plaintext_invalid",
        keyVersion,
        affectedRows: version.invalidPlaintextCount,
      });
    }
  }
  return findings;
}

function rootVersionSummaries(
  counts: ReadonlyMap<
    VaultKeyVersion,
    {
      readonly rowCount: number;
      readonly decryptedCount: number;
    }
  >,
): RetainedVaultRootVersionSummary[] {
  const versions: RetainedVaultRootVersionSummary[] = [];
  for (const keyVersion of orderedKeyVersions()) {
    const version = counts.get(keyVersion);
    if (version === undefined) continue;
    versions.push({
      keyVersion,
      rowCount: version.rowCount,
      decryptedCount: version.decryptedCount,
    });
  }
  return versions;
}

function orderedKeyVersions(): readonly VaultKeyVersion[] {
  return ["v1", "v2"];
}
