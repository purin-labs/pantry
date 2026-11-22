import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { FileResourceAccessGrantTarget } from "./types";

type StatementDatabase = Pick<OrganisationDatabase, "prepare">;

/** The pending sync of a file grant, from its grant and its account. */
type FileGrantSyncInput = Readonly<{
  organisationId: string;
  grantId: string;
  integrationAccountId: string;
  now: number;
}>;

/** Why a file resource cannot be the target of a grant. */
export type FileGrantValidationError = Readonly<{
  readonly code:
    "provider_resource_not_accessible" | "provider_resource_identity_mismatch";
}>;

/**
 * The parts of a file grant that the file context owns: the statements of
 * its tables, which a grant change puts in its own batch, and the check of
 * the provider file that a new grant names. The agent module owns the file
 * tables and the provider reads, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type FileGrantParts = Readonly<{
  /** Adds the pending sync of a new file grant at its first revision. */
  prepareNewFileGrantSync(
    db: StatementDatabase,
    input: FileGrantSyncInput,
  ): D1PreparedStatement;
  /**
   * Adds the pending sync of an active file grant at its current revision,
   * when the statement before it in the batch changed one row.
   */
  prepareChangedFileGrantSync(
    db: StatementDatabase,
    input: FileGrantSyncInput,
  ): D1PreparedStatement;
  /** Deletes the admissions and then the sync of a revoked file grant. */
  prepareRevokedFileGrantRows(
    db: StatementDatabase,
    input: Readonly<{ organisationId: string; grantId: string }>,
  ): D1PreparedStatement[];
  /**
   * Deletes the rows of a revoked file grant after the receipt of the
   * revoke settles in the same batch.
   */
  prepareRevokedFileGrantCleanup(
    input: Readonly<{
      scope: OrganisationExecutionScope;
      receiptId: string;
      grantId: string;
      integrationAccountId: IntegrationAccountId;
      now: number;
    }>,
  ): D1PreparedStatement[];
  /** Supersedes the file projections that no active grant admits. */
  supersedeUnadmittedFileProjectionsStatement(
    input: Readonly<{
      db: StatementDatabase;
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
      reason: "provider_resource_unavailable" | "grant_revoked";
      now: number;
    }>,
  ): D1PreparedStatement;
  /** Checks that the provider file of a new grant exists and is the same. */
  validateFileGrantTarget(
    input: Readonly<{
      env: Env;
      scope: OrganisationExecutionScope;
      target: FileResourceAccessGrantTarget;
      now: number;
    }>,
  ): Promise<Result<FileResourceAccessGrantTarget, FileGrantValidationError>>;
}>;

export const fileGrantParts = definePort<FileGrantParts>("file_grant_parts");
