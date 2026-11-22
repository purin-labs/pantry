import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  type CustomConnectorId,
  type CustomConnectorRevision,
} from "@purin-labs/connections/custom-connectors/identity";
import {
  resolveCustomConnectorRevision,
  type CustomConnectorRevisionRecord,
} from "./revisions";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";
import { isNonNegativeInteger, isPositiveInteger } from "@purin-labs/std";

const CUSTOM_CONNECTOR_PROJECTION_LIMIT = 100;

type CustomConnectorLifecycle = "draft" | "active" | "disabled";

type CustomConnectorSummary = Readonly<{
  readonly connectorId: CustomConnectorId;
  readonly lifecycle: CustomConnectorLifecycle;
  readonly headRevision: CustomConnectorRevision;
  readonly name: string | null;
  readonly description: string | null;
  readonly origin: string | null;
  readonly reviewState: CustomConnectorRevisionRecord["reviewState"];
  readonly accountCount: number;
  readonly accounts: readonly CustomConnectorAccountSummary[];
  readonly createdAt: number;
  readonly updatedAt: number;
}>;

type CustomConnectorAccountSummary = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly displayName: string;
  readonly lifecycle: "active" | "disabled";
  readonly acceptedRevision: CustomConnectorRevision;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
}>;

type CustomConnectorDetail = Readonly<{
  readonly summary: CustomConnectorSummary;
  readonly revisions: readonly CustomConnectorRevisionRecord[];
  readonly accounts: readonly CustomConnectorAccountSummary[];
}>;

type CustomConnectorProjectionError =
  | { readonly code: "custom_connector_not_found" }
  | { readonly code: "custom_connector_projection_limit_exceeded" }
  | {
      readonly code: "custom_connector_projection_corrupt";
      readonly field: string;
    };

type ConnectorRow = {
  readonly connectorId: unknown;
  readonly lifecycle: unknown;
  readonly headRevision: unknown;
  readonly accountCount: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
};

type RevisionNumberRow = { readonly revision: unknown };

type AccountRow = {
  readonly integrationAccountId: unknown;
  readonly displayName: unknown;
  readonly accountLifecycle: unknown;
  readonly bindingLifecycle: unknown;
  readonly acceptedRevision: unknown;
  readonly bindingRevision: unknown;
  readonly credentialGeneration: unknown;
};

const CONNECTOR_SELECT = `SELECT
  connector.connector_id AS connectorId,
  connector.lifecycle,
  connector.head_revision AS headRevision,
  connector.created_at AS createdAt,
  connector.updated_at AS updatedAt,
  COUNT(account.integration_account_id) AS accountCount
FROM custom_connector AS connector
LEFT JOIN custom_connector_account_binding AS binding
  ON binding.organisation_id = connector.organisation_id
 AND binding.connector_id = connector.connector_id
 AND binding.lifecycle != 'revoked'
LEFT JOIN integration_account AS account
  ON account.organisation_id = binding.organisation_id
 AND account.integration_account_id = binding.integration_account_id
 AND account.lifecycle != 'revoked'`;

export async function listCustomConnectorSummaries(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<readonly CustomConnectorSummary[], CustomConnectorProjectionError>
> {
  const rows = await input.db
    .prepare(
      `${CONNECTOR_SELECT}
       WHERE connector.organisation_id = ? AND connector.lifecycle != 'removed'
       GROUP BY connector.connector_id
       ORDER BY connector.updated_at DESC, connector.connector_id
       LIMIT ?`,
    )
    .bind(input.organisationId, CUSTOM_CONNECTOR_PROJECTION_LIMIT + 1)
    .all<ConnectorRow>();
  if (rows.results.length > CUSTOM_CONNECTOR_PROJECTION_LIMIT) {
    return {
      ok: false,
      error: { code: "custom_connector_projection_limit_exceeded" },
    };
  }
  const summaries: CustomConnectorSummary[] = [];
  for (const row of rows.results) {
    const summary = await parseConnectorSummary(
      input.db,
      input.organisationId,
      row,
    );
    if (!summary.ok) return summary;
    summaries.push(summary.value);
  }
  return { ok: true, value: Object.freeze(summaries) };
}

export async function resolveCustomConnectorDetail(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
}): Promise<Result<CustomConnectorDetail, CustomConnectorProjectionError>> {
  const row = await input.db
    .prepare(
      `${CONNECTOR_SELECT}
       WHERE connector.organisation_id = ? AND connector.connector_id = ?
         AND connector.lifecycle != 'removed'
       GROUP BY connector.connector_id`,
    )
    .bind(input.organisationId, input.connectorId)
    .first<ConnectorRow>();
  if (row === null) {
    return { ok: false, error: { code: "custom_connector_not_found" } };
  }
  const summary = await parseConnectorSummary(
    input.db,
    input.organisationId,
    row,
  );
  if (!summary.ok) return summary;
  const revisions = await readConnectorRevisions(input);
  if (!revisions.ok) return revisions;
  return {
    ok: true,
    value: {
      summary: summary.value,
      revisions: revisions.value,
      accounts: summary.value.accounts,
    },
  };
}

async function parseConnectorSummary(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: OrganisationId,
  row: ConnectorRow,
): Promise<Result<CustomConnectorSummary, CustomConnectorProjectionError>> {
  const connectorId = parseCustomConnectorId(row.connectorId);
  const headRevision = parseCustomConnectorRevision(row.headRevision);
  const lifecycle = parseConnectorLifecycle(row.lifecycle);
  if (!connectorId.ok || !headRevision.ok || lifecycle === null) {
    return corrupt("connector.identity");
  }
  if (
    !isNonNegativeInteger(row.accountCount) ||
    !isNonNegativeInteger(row.createdAt) ||
    !isNonNegativeInteger(row.updatedAt)
  ) {
    return corrupt("connector.metadata");
  }
  const revision = await resolveCustomConnectorRevision({
    db,
    organisationId,
    connectorId: connectorId.value,
    revision: headRevision.value,
  });
  if (!revision.ok) return corrupt("connector.headRevision");
  const accounts = await readConnectorAccounts({
    db,
    organisationId,
    connectorId: connectorId.value,
  });
  if (!accounts.ok) return accounts;
  const display = revisionDisplay(revision.value);
  return {
    ok: true,
    value: {
      connectorId: connectorId.value,
      lifecycle,
      headRevision: headRevision.value,
      ...display,
      reviewState: revision.value.reviewState,
      accountCount: accounts.value.length,
      accounts: accounts.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

async function readConnectorRevisions(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
}): Promise<
  Result<
    readonly CustomConnectorRevisionRecord[],
    CustomConnectorProjectionError
  >
> {
  const rows = await input.db
    .prepare(
      `SELECT revision FROM custom_connector_revision
       WHERE organisation_id = ? AND connector_id = ?
       ORDER BY revision DESC LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.connectorId,
      CUSTOM_CONNECTOR_PROJECTION_LIMIT + 1,
    )
    .all<RevisionNumberRow>();
  if (rows.results.length > CUSTOM_CONNECTOR_PROJECTION_LIMIT) {
    return {
      ok: false,
      error: { code: "custom_connector_projection_limit_exceeded" },
    };
  }
  const revisions: CustomConnectorRevisionRecord[] = [];
  for (const row of rows.results) {
    const revision = parseCustomConnectorRevision(row.revision);
    if (!revision.ok) return corrupt("revision.revision");
    const resolved = await resolveCustomConnectorRevision({
      db: input.db,
      organisationId: input.organisationId,
      connectorId: input.connectorId,
      revision: revision.value,
    });
    if (!resolved.ok) return corrupt("revision.record");
    revisions.push(resolved.value);
  }
  return { ok: true, value: Object.freeze(revisions) };
}

async function readConnectorAccounts(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
}): Promise<
  Result<
    readonly CustomConnectorAccountSummary[],
    CustomConnectorProjectionError
  >
> {
  const rows = await input.db
    .prepare(
      `SELECT account.integration_account_id AS integrationAccountId,
         account.display_name AS displayName,
         account.lifecycle AS accountLifecycle,
         binding.lifecycle AS bindingLifecycle,
         binding.accepted_revision AS acceptedRevision,
         binding.binding_revision AS bindingRevision,
         binding.credential_generation AS credentialGeneration
       FROM custom_connector_account_binding AS binding
       JOIN integration_account AS account
         ON account.organisation_id = binding.organisation_id
        AND account.integration_account_id = binding.integration_account_id
       WHERE binding.organisation_id = ? AND binding.connector_id = ?
         AND binding.lifecycle != 'revoked' AND account.lifecycle != 'revoked'
       ORDER BY account.display_name, account.integration_account_id
       LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.connectorId,
      CUSTOM_CONNECTOR_PROJECTION_LIMIT + 1,
    )
    .all<AccountRow>();
  if (rows.results.length > CUSTOM_CONNECTOR_PROJECTION_LIMIT) {
    return {
      ok: false,
      error: { code: "custom_connector_projection_limit_exceeded" },
    };
  }
  const accounts: CustomConnectorAccountSummary[] = [];
  for (const row of rows.results) {
    const account = parseAccountSummary(row);
    if (!account.ok) return account;
    accounts.push(account.value);
  }
  return { ok: true, value: Object.freeze(accounts) };
}

function parseAccountSummary(
  row: AccountRow,
): Result<CustomConnectorAccountSummary, CustomConnectorProjectionError> {
  if (typeof row.integrationAccountId !== "string") {
    return corrupt("account.integrationAccountId");
  }
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  const acceptedRevision = parseCustomConnectorRevision(row.acceptedRevision);
  if (
    !integrationAccountId.ok ||
    !acceptedRevision.ok ||
    typeof row.displayName !== "string" ||
    row.displayName.length === 0 ||
    row.displayName.length > 256 ||
    (row.accountLifecycle !== "active" &&
      row.accountLifecycle !== "disabled") ||
    row.bindingLifecycle !== row.accountLifecycle ||
    !isPositiveInteger(row.bindingRevision) ||
    !isPositiveInteger(row.credentialGeneration)
  ) {
    return corrupt("account");
  }
  return {
    ok: true,
    value: {
      integrationAccountId: integrationAccountId.value,
      displayName: row.displayName,
      lifecycle: row.accountLifecycle,
      acceptedRevision: acceptedRevision.value,
      bindingRevision: row.bindingRevision,
      credentialGeneration: row.credentialGeneration,
    },
  };
}

function revisionDisplay(revision: CustomConnectorRevisionRecord): Readonly<{
  readonly name: string | null;
  readonly description: string | null;
  readonly origin: string | null;
}> {
  if (revision.reviewState !== "draft") {
    return {
      name: revision.definition.name,
      description: revision.definition.description,
      origin: revision.definition.origin,
    };
  }
  const document = revision.authoringDocument;
  return {
    name: boundedDraftText(
      document.name,
      CUSTOM_CONNECTOR_LIMITS.nameCharacters,
    ),
    description: boundedDraftText(
      document.description,
      CUSTOM_CONNECTOR_LIMITS.descriptionCharacters,
    ),
    origin: boundedDraftText(
      document.origin,
      CUSTOM_CONNECTOR_LIMITS.urlCharacters,
    ),
  };
}

function boundedDraftText(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
    ? value
    : null;
}

function parseConnectorLifecycle(
  raw: unknown,
): CustomConnectorLifecycle | null {
  return raw === "draft" || raw === "active" || raw === "disabled" ? raw : null;
}

function corrupt(field: string): Result<never, CustomConnectorProjectionError> {
  return {
    ok: false,
    error: { code: "custom_connector_projection_corrupt", field },
  };
}
