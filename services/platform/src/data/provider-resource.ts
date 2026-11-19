import type { OrganisationDatabase } from "../database-handles";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type { Result } from "../result";
import { hashOpaqueSecret } from "./control-plane";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import type { ConnectionProvider } from "./provider-attempt";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import { isPositiveInteger } from "@purin-labs/std";

export type DiscoveredProviderResource = {
  readonly canonicalResourceId: string;
  readonly providerResourceId: string;
  readonly providerAccountId: string;
  readonly displayLabel: string;
  readonly accessState: "accessible" | "inaccessible";
  readonly providerRevision: string;
  readonly resourceKind: string;
};

type ProviderResourcePage = {
  readonly resources: readonly {
    readonly canonical_resource_id: string;
    readonly provider_resource_id: string;
    readonly provider_account_id: string;
    readonly display_label: string;
    readonly access_state: "accessible" | "inaccessible";
    readonly provider_revision: string;
    readonly resource_kind: string;
  }[];
  readonly next_cursor: string;
  readonly snapshot_revision: string;
};

type ProviderResourceError =
  | { readonly code: "integration_account_not_found" }
  | { readonly code: "provider_resource_cursor_invalid" }
  | { readonly code: "provider_resource_query_invalid" };

type ProviderResourceSnapshotMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type ProviderResourceSnapshotRefreshInput = {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: ConnectionProvider;
  readonly environment: "development" | "production";
  readonly resources: readonly DiscoveredProviderResource[];
  readonly mutation: ProviderResourceSnapshotMutation;
  readonly now: number;
};

type ProviderResourceSnapshotRefreshResult = {
  readonly snapshotRevision: string;
  readonly resourceCount: number;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly receiptId: string;
};

type ProviderResourceSnapshotRefreshError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "configuration_version_conflict" };

type ProviderResourceRow = {
  readonly canonicalResourceId: unknown;
  readonly providerResourceId: unknown;
  readonly providerAccountId: unknown;
  readonly displayLabel: unknown;
  readonly accessState: unknown;
  readonly providerRevision: unknown;
  readonly resourceKind: unknown;
};

type CursorRow = {
  readonly organisationId: unknown;
  readonly integrationAccountId: unknown;
  readonly snapshotRevision: unknown;
  readonly queryHash: unknown;
  readonly nextOffset: unknown;
  readonly expiresAt: unknown;
};

const PAGE_SIZE = 50;
const CURSOR_TTL_MS = 10 * 60 * 1_000;

type ResourceSnapshotWriteInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: ConnectionProvider;
  readonly environment: "development" | "production";
  readonly resources: readonly DiscoveredProviderResource[];
  readonly now: number;
};

type ProviderResourceMutationState = {
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

type ProviderResourceMutationStateRow = {
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

export async function persistProviderResourceSnapshot(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: ConnectionProvider;
  readonly environment: "development" | "production";
  readonly resources: readonly DiscoveredProviderResource[];
  readonly now: number;
}): Promise<string> {
  const snapshotRevision = `resource_snapshot_${crypto.randomUUID()}`;
  const queryHash = await resourceQueryHash(input.integrationAccountId, "");
  const session = input.db.withSession("first-primary");
  const statements = prepareResourceSnapshotStatements(
    session,
    input,
    snapshotRevision,
    queryHash,
  );
  statements.push(
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET projection_revision = projection_revision + 1
       WHERE organisation_id = ?`,
      )
      .bind(input.organisationId),
  );
  await session.batch(statements);
  return snapshotRevision;
}

export async function refreshProviderResourceSnapshot(
  input: ProviderResourceSnapshotRefreshInput,
): Promise<
  Result<
    ProviderResourceSnapshotRefreshResult,
    ProviderResourceSnapshotRefreshError
  >
> {
  const session = input.db.withSession("first-primary");
  const state = await readProviderResourceMutationState(
    session,
    input.organisationId,
  );
  if (state === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }

  const snapshotRevision = `resource_snapshot_${crypto.randomUUID()}`;
  const projectionRevision = state.projectionRevision + 1;
  const queryHash = await resourceQueryHash(input.integrationAccountId, "");
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    integration_account_id: input.integrationAccountId,
    snapshot_revision: snapshotRevision,
    resource_count: input.resources.length,
    configuration_version: state.configurationVersion,
    projection_revision: projectionRevision,
  };
  const statements = prepareResourceSnapshotStatements(
    session,
    input,
    snapshotRevision,
    queryHash,
  );
  statements.push(
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET projection_revision = projection_revision + 1
       WHERE organisation_id = ? AND configuration_version = ?`,
      )
      .bind(input.organisationId, state.configurationVersion),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: input.environment,
      actorUserId: input.mutation.scope.userId,
      operation: "provider.resource.refresh",
      targetKind: "integration_account",
      targetId: input.integrationAccountId,
      oldLifecycle: null,
      newLifecycle: null,
      configurationVersion: state.configurationVersion,
      projectionRevision,
      reasonCode: "resource_snapshot_refreshed",
    }),
  );
  await session.batch(statements);
  return {
    ok: true,
    value: {
      snapshotRevision,
      resourceCount: input.resources.length,
      configurationVersion: state.configurationVersion,
      projectionRevision,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

function prepareResourceSnapshotStatements(
  db: OrganisationQuerySource,
  input: ResourceSnapshotWriteInput,
  snapshotRevision: string,
  queryHash: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO provider_resource_snapshot (
         snapshot_revision, organisation_id, integration_account_id, provider,
         environment, query_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotRevision,
        input.organisationId,
        input.integrationAccountId,
        input.provider,
        input.environment,
        queryHash,
        input.now,
      ),
  ];
  for (const resource of input.resources) {
    statements.push(
      db
        .prepare(
          `INSERT INTO provider_discovered_resource (
           snapshot_revision, canonical_resource_id, provider_resource_id,
           provider_account_id, display_label, access_state,
           provider_revision, resource_kind
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          snapshotRevision,
          resource.canonicalResourceId,
          resource.providerResourceId,
          resource.providerAccountId,
          resource.displayLabel,
          resource.accessState,
          resource.providerRevision,
          resource.resourceKind,
        ),
    );
  }
  return statements;
}

async function readProviderResourceMutationState(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<ProviderResourceMutationState | null> {
  const row = await db
    .prepare(
      `SELECT configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<ProviderResourceMutationStateRow>();
  if (
    row === null ||
    !isPositiveInteger(row.configurationVersion) ||
    !isPositiveInteger(row.projectionRevision)
  ) {
    return null;
  }
  return {
    configurationVersion: row.configurationVersion,
    projectionRevision: row.projectionRevision,
  };
}

export async function listProviderResourcePage(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly query: string;
  readonly cursor: string | null;
  readonly now: number;
}): Promise<Result<ProviderResourcePage, ProviderResourceError>> {
  const query = normalizeQuery(input.query);
  if (query === null) {
    return { ok: false, error: { code: "provider_resource_query_invalid" } };
  }
  const queryHash = await resourceQueryHash(input.integrationAccountId, query);
  const position =
    input.cursor === null
      ? await latestSnapshotPosition(
          input.db,
          input.organisationId,
          input.integrationAccountId,
        )
      : await consumeCursorPosition({
          db: input.db,
          organisationId: input.organisationId,
          integrationAccountId: input.integrationAccountId,
          cursor: input.cursor,
          queryHash,
          now: input.now,
        });
  if (!position.ok) {
    return position;
  }
  const rows = await readResourceRows({
    db: input.db,
    snapshotRevision: position.value.snapshotRevision,
    query,
    offset: position.value.offset,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore
    ? await createResourceCursor({
        db: input.db,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        snapshotRevision: position.value.snapshotRevision,
        queryHash,
        nextOffset: position.value.offset + PAGE_SIZE,
        now: input.now,
      })
    : "end";
  return {
    ok: true,
    value: {
      resources: pageRows.map(providerResourceWire),
      next_cursor: nextCursor,
      snapshot_revision: position.value.snapshotRevision,
    },
  };
}

async function latestSnapshotPosition(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<
  Result<
    {
      readonly snapshotRevision: string;
      readonly offset: number;
    },
    ProviderResourceError
  >
> {
  const row = await db
    .prepare(
      `SELECT snapshot_revision AS snapshotRevision
     FROM provider_resource_snapshot
     WHERE organisation_id = ? AND integration_account_id = ?
     ORDER BY created_at DESC, snapshot_revision DESC
     LIMIT 1`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{
      readonly snapshotRevision: unknown;
    }>();
  return row === null || typeof row.snapshotRevision !== "string"
    ? { ok: false, error: { code: "integration_account_not_found" } }
    : {
        ok: true,
        value: { snapshotRevision: row.snapshotRevision, offset: 0 },
      };
}

async function consumeCursorPosition(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly cursor: string;
  readonly queryHash: string;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly snapshotRevision: string;
      readonly offset: number;
    },
    ProviderResourceError
  >
> {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(input.cursor)) {
    return { ok: false, error: { code: "provider_resource_cursor_invalid" } };
  }
  const cursorHash = await hashOpaqueSecret(input.cursor);
  const row = await input.db
    .prepare(
      `SELECT organisation_id AS organisationId,
            integration_account_id AS integrationAccountId,
            snapshot_revision AS snapshotRevision,
            query_hash AS queryHash, next_offset AS nextOffset,
            expires_at AS expiresAt
     FROM provider_resource_cursor WHERE cursor_hash = ?`,
    )
    .bind(cursorHash)
    .first<CursorRow>();
  if (
    row === null ||
    row.organisationId !== input.organisationId ||
    row.integrationAccountId !== input.integrationAccountId ||
    row.queryHash !== input.queryHash ||
    typeof row.snapshotRevision !== "string" ||
    typeof row.nextOffset !== "number" ||
    typeof row.expiresAt !== "number" ||
    row.expiresAt <= input.now
  ) {
    return { ok: false, error: { code: "provider_resource_cursor_invalid" } };
  }
  return {
    ok: true,
    value: { snapshotRevision: row.snapshotRevision, offset: row.nextOffset },
  };
}

async function readResourceRows(input: {
  readonly db: OrganisationQuerySource;
  readonly snapshotRevision: string;
  readonly query: string;
  readonly offset: number;
}): Promise<readonly DiscoveredProviderResource[]> {
  const rows = await input.db
    .prepare(
      `SELECT canonical_resource_id AS canonicalResourceId,
            provider_resource_id AS providerResourceId,
            provider_account_id AS providerAccountId,
            display_label AS displayLabel, access_state AS accessState,
            provider_revision AS providerRevision, resource_kind AS resourceKind
     FROM provider_discovered_resource
     WHERE snapshot_revision = ?
       AND (? = '' OR instr(lower(display_label), ?) > 0)
     ORDER BY lower(display_label), canonical_resource_id
     LIMIT ? OFFSET ?`,
    )
    .bind(
      input.snapshotRevision,
      input.query,
      input.query,
      PAGE_SIZE + 1,
      input.offset,
    )
    .all<ProviderResourceRow>();
  const resources: DiscoveredProviderResource[] = [];
  for (const row of rows.results ?? []) {
    resources.push(requireProviderResource(row));
  }
  return resources;
}

async function createResourceCursor(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly snapshotRevision: string;
  readonly queryHash: string;
  readonly nextOffset: number;
  readonly now: number;
}): Promise<string> {
  const cursor = randomCursor();
  await input.db
    .prepare(
      `INSERT INTO provider_resource_cursor (
       cursor_hash, organisation_id, integration_account_id, snapshot_revision,
       query_hash, next_offset, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await hashOpaqueSecret(cursor),
      input.organisationId,
      input.integrationAccountId,
      input.snapshotRevision,
      input.queryHash,
      input.nextOffset,
      input.now,
      input.now + CURSOR_TTL_MS,
    )
    .run();
  return cursor;
}

function requireProviderResource(
  row: ProviderResourceRow,
): DiscoveredProviderResource {
  return {
    canonicalResourceId: requireString(
      row.canonicalResourceId,
      "canonical resource id",
    ),
    providerResourceId: requireString(
      row.providerResourceId,
      "provider resource id",
    ),
    providerAccountId: requireString(
      row.providerAccountId,
      "provider account id",
    ),
    displayLabel: requireString(row.displayLabel, "display label"),
    accessState: requireAccessState(row.accessState),
    providerRevision: requireString(row.providerRevision, "provider revision"),
    resourceKind: requireString(row.resourceKind, "resource kind"),
  };
}

function providerResourceWire(
  resource: DiscoveredProviderResource,
): ProviderResourcePage["resources"][number] {
  return {
    canonical_resource_id: resource.canonicalResourceId,
    provider_resource_id: resource.providerResourceId,
    provider_account_id: resource.providerAccountId,
    display_label: resource.displayLabel,
    access_state: resource.accessState,
    provider_revision: resource.providerRevision,
    resource_kind: resource.resourceKind,
  };
}

function normalizeQuery(raw: string): string | null {
  const query = raw.trim().toLowerCase();
  return query.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(query)
    ? query
    : null;
}

async function resourceQueryHash(
  integrationAccountId: IntegrationAccountId,
  query: string,
): Promise<string> {
  return hashOpaqueSecret(`${integrationAccountId}\u0000${query}`);
}

function requireAccessState(raw: unknown): "accessible" | "inaccessible" {
  if (raw === "accessible" || raw === "inaccessible") {
    return raw;
  }
  throw new Error("provider resource access state is invalid");
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`provider resource ${field} is invalid`);
  }
  return raw;
}

function randomCursor(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}
