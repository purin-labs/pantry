/**
 * The last step of a purge (Refactor 15, refactor 5): one regional batch that
 * moves the lifecycle from `purging` to `purged` and runs the purge
 * catalogue. Its first statement is the lifecycle move under the placement
 * fence; every later statement runs only once that move holds, so a batch
 * for an Organisation that is not purging changes nothing.
 *
 * The Actors, the attachments, the device fleets, the WhatsApp Connectors,
 * the Commerce merchant and the Slack installation credentials end before
 * this batch (see `reconcileArchivedOrganisation`).
 */
import type {
  GlobalDatabase,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { assertNever } from "@purin-labs/std";
import {
  prepareOrganisationLifecycleMove,
  type LifecycleFence,
} from "./organisation-lifecycle-moves";
import {
  organisationLifecycleParts,
  purgeGuardedStatement as guardedStatement,
  type OrganisationPurgeContext as PurgeContext,
  type PurgeRewrite,
} from "./organisation-lifecycle-port";
import {
  eraseEntryWhere,
  type PseudonymizedTable,
  type PurgeCatalogueEntry,
  type TENANCY_PURGE_ENTRIES,
} from "./purge-catalogue";
import { prepareExpiredOrganisationReceiptsDeletion } from "./shared-rows/mutation-receipt";
import {
  prepareOrganisationPurge,
  publishOrganisationDirectoryRow,
  type RowGuard,
} from "./shared-rows/organisation-row";

type Session = OrganisationDatabaseSession;

/** The tables of tenancy that the catalogue marks pseudonymize. */
export type TenancyPseudonymizedTable = PseudonymizedTable<
  (typeof TENANCY_PURGE_ENTRIES)[number]
>;

/** The rewrite of each table of tenancy that the catalogue marks pseudonymize. */
const TENANCY_PSEUDONYMIZE: Readonly<
  Record<TenancyPseudonymizedTable, PurgeRewrite>
> = {
  organisation: (context) => [
    prepareOrganisationPurge(context.session, {
      organisationId: context.organisationId,
      guard: context.purged,
    }),
  ],
};

type EraseEntry = Extract<PurgeCatalogueEntry, Readonly<{ action: "erase" }>>;

/**
 * The rows of the Organisation in a table with no `organisation_id` column:
 * the `where` of its erase entry, or undefined. The regional copy selects
 * the same rows.
 */
export function organisationRowsWhere(table: string): string | undefined {
  const entry = organisationLifecycleParts().purge.catalogue.find(
    (candidate) => candidate.table === table,
  );
  return entry !== undefined && "where" in entry ? entry.where : undefined;
}

/** Holds once the Organisation's lifecycle says purged. */
function purgedGuard(organisationId: OrganisationId): RowGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_onboarding
      WHERE organisation_id = ? AND lifecycle = 'purged')`,
    bindings: [organisationId],
  };
}

/** The entry's DELETE of its own table, for the rows of the Organisation. */
function eraseStatement(
  session: Session,
  guard: RowGuard,
  organisationId: OrganisationId,
  entry: EraseEntry,
): D1PreparedStatement {
  return guardedStatement(
    session,
    guard,
    organisationId,
    `${entry.statement} WHERE (${eraseEntryWhere(entry)})`,
  );
}

/** The statements of one catalogue entry, in the batch's order. */
function catalogueStatements(
  context: PurgeContext,
  pseudonymize: Readonly<Record<string, PurgeRewrite>>,
  entry: PurgeCatalogueEntry,
): readonly D1PreparedStatement[] {
  switch (entry.action) {
    case "erase":
      return [
        eraseStatement(
          context.session,
          context.purged,
          context.organisationId,
          entry,
        ),
      ];
    case "pseudonymize": {
      const rewrite = pseudonymize[entry.table];
      if (rewrite === undefined)
        throw new Error(`organisation_purge_rewrite_missing:${entry.table}`);
      return rewrite(context);
    }
    case "keep":
      // Idempotency receipts end on their own; the expired ones go now.
      return entry.table === "control_mutation_receipt"
        ? [
            prepareExpiredOrganisationReceiptsDeletion(
              context.session,
              context.organisationId,
              context.now,
            ),
          ]
        : [];
    default:
      return assertNever(entry);
  }
}

export async function purgeArchivedOrganisation(input: {
  readonly db: OrganisationDatabase;
  readonly directory: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly fence: LifecycleFence;
  readonly now: number;
}): Promise<number> {
  const parts = organisationLifecycleParts().purge;
  const pseudonymize: Readonly<Record<string, PurgeRewrite>> = {
    ...TENANCY_PSEUDONYMIZE,
    ...parts.pseudonymize,
  };
  const subjects = await parts.subjects(input.db, input.organisationId);
  const session = input.db.withSession("first-primary");
  const context: PurgeContext = {
    session,
    organisationId: input.organisationId,
    purged: purgedGuard(input.organisationId),
    accounts: subjects.accounts,
    connections: subjects.connections,
    now: input.now,
  };
  const statements: D1PreparedStatement[] = [
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.organisationId,
      event: "purge",
      from: ["purging"],
      fence: input.fence,
      now: input.now,
    }),
    ...parts.catalogue.flatMap((entry) =>
      catalogueStatements(context, pseudonymize, entry),
    ),
    session
      .prepare(
        `UPDATE organisation_archive_cleanup
         SET status = 'purged', updated_at = ?
         WHERE organisation_id = ? AND status = 'pending_purge' AND ${context.purged.sql}`,
      )
      .bind(input.now, input.organisationId, ...context.purged.bindings),
    session
      .prepare(
        `UPDATE organisation_archive_tombstone SET purged_at = ?
         WHERE organisation_id = ? AND purged_at IS NULL AND ${context.purged.sql}`,
      )
      .bind(input.now, input.organisationId, ...context.purged.bindings),
  ];
  const [moved] = await session.batch(statements);
  if (moved?.meta.changes !== 1)
    throw new Error("organisation_purge_lifecycle_conflict");
  // The directory's copy of the row loses the name and the handle with the
  // regional one.
  await publishOrganisationDirectoryRow({
    directory: input.directory,
    db: input.db,
    organisationId: input.organisationId,
  });
  await input.directory.batch(
    parts
      .directoryRecordDeletions(input.directory, input.organisationId)
      .map(([, statement]) => statement),
  );
  return statements.length;
}
