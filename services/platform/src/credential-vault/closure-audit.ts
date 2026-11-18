import {
  parseProviderConnectionId,
  parseOrganisationId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../ids";
import { parseVaultHandle, type VaultHandle } from "./domain";
import { isRecord } from "@seams/std";

export type CredentialClosureVaultIssue = "missing" | "revoked";

export type CredentialClosureReferenceKind =
  | "credential_ref"
  | "provider_webhook"
  | "discord_interaction_install"
  | "thread_file_watch"
  | "discord_thread_binding"
  | "surface_installation"
  | "provider_account_cleanup";

export type CredentialClosureFinding =
  | {
      readonly kind: "active_provider_generation_without_live_vault";
      readonly organisationId: OrganisationId;
      readonly providerConnectionId: ProviderConnectionId;
      readonly credentialGeneration: number;
      readonly provider: string;
      readonly environment: string;
      readonly vaultHandle: VaultHandle;
      readonly vaultIssue: CredentialClosureVaultIssue;
    }
  | {
      readonly kind: "active_provider_generation_with_invalid_vault_handle";
      readonly organisationId: OrganisationId;
      readonly providerConnectionId: ProviderConnectionId;
      readonly credentialGeneration: number;
      readonly provider: string;
      readonly environment: string;
    }
  | {
      readonly kind: "active_external_import_without_live_vault";
      readonly organisationId: OrganisationId;
      readonly sourceKind: "onepassword";
      readonly vaultHandle: VaultHandle;
      readonly vaultIssue: CredentialClosureVaultIssue;
    }
  | {
      readonly kind: "active_external_import_with_invalid_vault_handle";
      readonly organisationId: OrganisationId;
      readonly sourceKind: "onepassword";
    }
  | {
      readonly kind: "active_stored_ref_without_live_vault";
      readonly organisationId: OrganisationId;
      readonly referenceKind: CredentialClosureReferenceKind;
      readonly referenceId: string;
      readonly vaultHandle: VaultHandle;
      readonly vaultIssue: CredentialClosureVaultIssue;
    }
  | {
      readonly kind: "active_stored_ref_with_invalid_vault_handle";
      readonly organisationId: OrganisationId;
      readonly referenceKind: CredentialClosureReferenceKind;
      readonly referenceId: string;
    };

type StoredReferenceFinding = Extract<
  CredentialClosureFinding,
  | { readonly kind: "active_stored_ref_without_live_vault" }
  | { readonly kind: "active_stored_ref_with_invalid_vault_handle" }
>;

export type CredentialClosureAuditSummary = {
  readonly activeProviderGenerationIssues: number;
  readonly activeExternalImportIssues: number;
  readonly activeStoredRefIssues: number;
  readonly totalIssues: number;
};

export type CredentialClosureAuditResult =
  | {
      readonly status: "passed";
      readonly summary: CredentialClosureAuditSummary;
      readonly findings: readonly [];
    }
  | {
      readonly status: "failed";
      readonly summary: CredentialClosureAuditSummary;
      readonly findings: readonly [
        CredentialClosureFinding,
        ...CredentialClosureFinding[],
      ];
    };

export type CredentialClosureQueryResult = {
  readonly results?: readonly unknown[];
};

export type CredentialClosureStatement = {
  all(): Promise<CredentialClosureQueryResult>;
};

export type CredentialClosureDatabase = {
  prepare(query: string): CredentialClosureStatement;
};

export async function auditCredentialClosure(
  db: CredentialClosureDatabase,
): Promise<CredentialClosureAuditResult> {
  const providerFindings = await activeProviderGenerationFindings(db);
  const externalImportFindings = await activeExternalImportFindings(db);
  const storedReferenceFindings = await activeStoredReferenceFindings(db);
  const findings: CredentialClosureFinding[] = [
    ...providerFindings,
    ...externalImportFindings,
    ...storedReferenceFindings,
  ];
  const summary: CredentialClosureAuditSummary = {
    activeProviderGenerationIssues: providerFindings.length,
    activeExternalImportIssues: externalImportFindings.length,
    activeStoredRefIssues: storedReferenceFindings.length,
    totalIssues: findings.length,
  };
  const first = findings[0];

  return first === undefined
    ? { status: "passed", summary, findings: [] }
    : { status: "failed", summary, findings: [first, ...findings.slice(1)] };
}

const ACTIVE_STORED_REFERENCE_SOURCES = [
  `SELECT credential.organisation_id AS organisationId,
          'credential_ref' AS referenceKind,
          credential.provider || ':' || credential.name AS referenceId,
          credential.vault_handle AS vaultHandle
     FROM credential_ref AS credential
     JOIN organisation ON organisation.organisation_id = credential.organisation_id
                AND organisation.status = 'active'
    WHERE credential.revoked_at IS NULL`,
  `SELECT webhook.organisation_id AS organisationId,
          'provider_webhook' AS referenceKind,
          webhook.provider_webhook_id AS referenceId,
          webhook.signing_secret_ref AS vaultHandle
     FROM provider_webhook AS webhook
     JOIN organisation ON organisation.organisation_id = webhook.organisation_id
                AND organisation.status = 'active'
    WHERE webhook.lifecycle = 'live'`,
  `SELECT installation.organisation_id AS organisationId,
          'discord_interaction_install' AS referenceKind,
          installation.application_id AS referenceId,
          installation.public_key_ref AS vaultHandle
     FROM discord_interaction_install AS installation
     JOIN organisation ON organisation.organisation_id = installation.organisation_id
                AND organisation.status = 'active'
    WHERE installation.status = 'active'`,
  `SELECT watch.organisation_id AS organisationId,
          'thread_file_watch' AS referenceKind,
          watch.provider || ':' || watch.watch_id AS referenceId,
          watch.secret_ref AS vaultHandle
     FROM thread_file_watch AS watch
     JOIN organisation ON organisation.organisation_id = watch.organisation_id
                AND organisation.status = 'active'
    WHERE watch.status = 'active'`,
  `SELECT binding.organisation_id AS organisationId,
          'discord_thread_binding' AS referenceKind,
          binding.thread_id AS referenceId,
          json_extract(binding.external_ref, '$.credentialRef') AS vaultHandle
     FROM thread_binding AS binding
     JOIN organisation ON organisation.organisation_id = binding.organisation_id
                AND organisation.status = 'active'
    WHERE binding.status = 'active'
      AND binding.surface_kind = 'discord'
      AND json_valid(binding.external_ref)
      AND json_type(binding.external_ref, '$.credentialRef') = 'text'`,
  `SELECT installation.organisation_id AS organisationId,
          'surface_installation' AS referenceKind,
          installation.integration_account_id AS referenceId,
          installation.bot_token_ref AS vaultHandle
     FROM surface_installation AS installation
     JOIN organisation ON organisation.organisation_id = installation.organisation_id
                AND organisation.status = 'active'
     JOIN integration_account AS account
       ON account.integration_account_id = installation.integration_account_id
      AND account.organisation_id = installation.organisation_id
      AND account.lifecycle = 'active'`,
  `SELECT cleanup.organisation_id AS organisationId,
          'provider_account_cleanup' AS referenceKind,
          cleanup.cleanup_id AS referenceId,
          handle.value AS vaultHandle
     FROM provider_account_cleanup AS cleanup
     JOIN organisation ON organisation.organisation_id = cleanup.organisation_id
                AND organisation.status = 'active'
     JOIN json_each(cleanup.credential_handles) AS handle
    WHERE cleanup.lifecycle IN (
      'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
    )
      AND handle.type = 'text'`,
] as const;

async function activeStoredReferenceFindings(
  db: CredentialClosureDatabase,
): Promise<CredentialClosureFinding[]> {
  const findings: StoredReferenceFinding[] = [];
  for (const source of ACTIVE_STORED_REFERENCE_SOURCES) {
    const result = await db.prepare(storedReferenceQuery(source)).all();
    findings.push(...(result.results ?? []).map(parseStoredReferenceFinding));
  }
  findings.sort(compareStoredReferenceFindings);
  return findings;
}

function storedReferenceQuery(source: string): string {
  return `WITH active_reference AS (${source})
    SELECT reference.organisationId,
           reference.referenceKind,
           reference.referenceId,
           reference.vaultHandle,
           CASE WHEN secret.vault_handle IS NULL THEN 'missing' ELSE 'revoked' END AS vaultIssue
      FROM active_reference AS reference
      LEFT JOIN vault_secret AS secret
        ON secret.organisation_id = reference.organisationId
       AND secret.vault_handle = reference.vaultHandle
     WHERE secret.vault_handle IS NULL OR secret.revoked_at IS NOT NULL
     ORDER BY reference.organisationId, reference.referenceId, reference.vaultHandle`;
}

function compareStoredReferenceFindings(
  left: StoredReferenceFinding,
  right: StoredReferenceFinding,
): number {
  return storedReferenceFindingKey(left).localeCompare(
    storedReferenceFindingKey(right),
  );
}

function storedReferenceFindingKey(finding: StoredReferenceFinding): string {
  return `${finding.organisationId}\u0000${finding.referenceKind}\u0000${finding.referenceId}`;
}

async function activeProviderGenerationFindings(
  db: CredentialClosureDatabase,
): Promise<CredentialClosureFinding[]> {
  const result = await db
    .prepare(
      `SELECT
         generation.organisation_id AS organisationId,
         generation.provider_connection_id AS providerConnectionId,
         generation.credential_generation AS credentialGeneration,
         generation.provider,
         generation.environment,
         generation.credential_ref AS vaultHandle,
         CASE
           WHEN secret.vault_handle IS NULL THEN 'missing'
           ELSE 'revoked'
         END AS vaultIssue
       FROM provider_credential_generation AS generation
       LEFT JOIN vault_secret AS secret
         ON secret.organisation_id = generation.organisation_id
        AND secret.vault_handle = generation.credential_ref
       WHERE generation.lifecycle = 'active'
         AND (secret.vault_handle IS NULL OR secret.revoked_at IS NOT NULL)
       ORDER BY
         generation.organisation_id,
         generation.provider_connection_id,
         generation.credential_generation`,
    )
    .all();

  return (result.results ?? []).map(parseProviderGenerationFinding);
}

async function activeExternalImportFindings(
  db: CredentialClosureDatabase,
): Promise<CredentialClosureFinding[]> {
  const result = await db
    .prepare(
      `SELECT
         external_import.organisation_id AS organisationId,
         external_import.source_kind AS sourceKind,
         external_import.vault_handle AS vaultHandle,
         CASE
           WHEN secret.vault_handle IS NULL THEN 'missing'
           ELSE 'revoked'
         END AS vaultIssue
       FROM external_vault_import AS external_import
       LEFT JOIN vault_secret AS secret
         ON secret.organisation_id = external_import.organisation_id
        AND secret.vault_handle = external_import.vault_handle
       WHERE external_import.state = 'active'
         AND (secret.vault_handle IS NULL OR secret.revoked_at IS NOT NULL)
       ORDER BY
         external_import.organisation_id,
         external_import.source_kind,
         external_import.vault_handle`,
    )
    .all();

  return (result.results ?? []).map(parseExternalImportFinding);
}

function parseProviderGenerationFinding(
  raw: unknown,
): CredentialClosureFinding {
  const row = requireRow(raw);
  const organisationId = requireOrganisationId(row.organisationId);
  const providerConnectionId = requireProviderConnectionId(
    row.providerConnectionId,
  );
  const credentialGeneration = requirePositiveInteger(
    row.credentialGeneration,
    "credential_generation",
  );
  const provider = requireNonEmptyString(row.provider, "provider");
  const environment = requireNonEmptyString(row.environment, "environment");
  const vaultHandle = parseOptionalVaultHandle(row.vaultHandle);
  if (vaultHandle === null) {
    return {
      kind: "active_provider_generation_with_invalid_vault_handle",
      organisationId,
      providerConnectionId,
      credentialGeneration,
      provider,
      environment,
    };
  }
  return {
    kind: "active_provider_generation_without_live_vault",
    organisationId,
    providerConnectionId,
    credentialGeneration,
    provider,
    environment,
    vaultHandle,
    vaultIssue: requireVaultIssue(row.vaultIssue),
  };
}

function parseExternalImportFinding(raw: unknown): CredentialClosureFinding {
  const row = requireRow(raw);
  if (row.sourceKind !== "onepassword") {
    throw new Error("credential_closure_audit_source_kind_invalid");
  }
  const organisationId = requireOrganisationId(row.organisationId);
  const vaultHandle = parseOptionalVaultHandle(row.vaultHandle);
  if (vaultHandle === null) {
    return {
      kind: "active_external_import_with_invalid_vault_handle",
      organisationId,
      sourceKind: row.sourceKind,
    };
  }

  return {
    kind: "active_external_import_without_live_vault",
    organisationId,
    sourceKind: row.sourceKind,
    vaultHandle,
    vaultIssue: requireVaultIssue(row.vaultIssue),
  };
}

function parseStoredReferenceFinding(raw: unknown): StoredReferenceFinding {
  const row = requireRow(raw);
  const organisationId = requireOrganisationId(row.organisationId);
  const referenceKind = requireReferenceKind(row.referenceKind);
  const referenceId = requireNonEmptyString(row.referenceId, "reference_id");
  const vaultHandle = parseOptionalVaultHandle(row.vaultHandle);
  if (vaultHandle === null) {
    return {
      kind: "active_stored_ref_with_invalid_vault_handle",
      organisationId,
      referenceKind,
      referenceId,
    };
  }
  return {
    kind: "active_stored_ref_without_live_vault",
    organisationId,
    referenceKind,
    referenceId,
    vaultHandle,
    vaultIssue: requireVaultIssue(row.vaultIssue),
  };
}

function requireRow(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) {
    throw new Error("credential_closure_audit_row_invalid");
  }
  return raw;
}

function requireOrganisationId(raw: unknown): OrganisationId {
  if (typeof raw !== "string") {
    throw new Error("credential_closure_audit_organisation_id_invalid");
  }

  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) {
    throw new Error("credential_closure_audit_organisation_id_invalid");
  }
  return parsed.value;
}

function requireProviderConnectionId(raw: unknown): ProviderConnectionId {
  if (typeof raw !== "string") {
    throw new Error("credential_closure_audit_provider_connection_id_invalid");
  }

  const parsed = parseProviderConnectionId(raw);
  if (!parsed.ok) {
    throw new Error("credential_closure_audit_provider_connection_id_invalid");
  }
  return parsed.value;
}

function parseOptionalVaultHandle(raw: unknown): VaultHandle | null {
  if (typeof raw !== "string") return null;
  const parsed = parseVaultHandle(raw);
  return parsed.ok ? parsed.value : null;
}

function requireVaultIssue(raw: unknown): CredentialClosureVaultIssue {
  if (raw !== "missing" && raw !== "revoked") {
    throw new Error("credential_closure_audit_vault_issue_invalid");
  }
  return raw;
}

function requireReferenceKind(raw: unknown): CredentialClosureReferenceKind {
  switch (raw) {
    case "credential_ref":
    case "provider_webhook":
    case "discord_interaction_install":
    case "thread_file_watch":
    case "discord_thread_binding":
    case "surface_installation":
    case "provider_account_cleanup":
      return raw;
    default:
      throw new Error("credential_closure_audit_reference_kind_invalid");
  }
}

function requirePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`credential_closure_audit_${field}_invalid`);
  }
  return raw;
}

function requireNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`credential_closure_audit_${field}_invalid`);
  }
  return raw;
}
