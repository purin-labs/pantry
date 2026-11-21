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
} from "../database-handles";
import type { OrganisationId } from "../ids";
import { assertNever } from "@purin-labs/std";
import { hashOpaqueSecret } from "./control-plane";
import {
  prepareOrganisationLifecycleMove,
  type LifecycleFence,
} from "./organisation-lifecycle-moves";
import {
  organisationLifecycleParts,
  purgeGuardedStatement as guardedStatement,
  type OrganisationPurgeContext as PurgeContext,
  type OrganisationPurgeParts,
} from "./organisation-lifecycle-port";
import { eraseEntryWhere, PURGE_CATALOGUE } from "./purge-catalogue";
import { prepareExpiredOrganisationReceiptsDeletion } from "./shared-rows/mutation-receipt";
import {
  prepareOrganisationPurge,
  publishOrganisationDirectoryRow,
  type RowGuard,
} from "./shared-rows/organisation-row";

type Session = OrganisationDatabaseSession;

type PseudonymizedTable = Extract<
  (typeof PURGE_CATALOGUE)[number],
  Readonly<{ action: "pseudonymize" }>
>["table"];

/** The rewrite of each table that the catalogue marks pseudonymize. */
type Pseudonymizers = Readonly<
  Record<
    PseudonymizedTable,
    (context: PurgeContext) => readonly D1PreparedStatement[]
  >
>;

/** The rewrite of each table of tenancy that the catalogue marks pseudonymize. */
const TENANCY_PSEUDONYMIZE: Pick<
  Pseudonymizers,
  Exclude<PseudonymizedTable, keyof OrganisationPurgeParts["pseudonymize"]>
> = {
  organisation: (context) => [
    prepareOrganisationPurge(context.session, {
      organisationId: context.organisationId,
      guard: context.purged,
    }),
  ],
  // A Google account can belong to one Organisation at a time. The purge
  // gives it up, and the erased address stays a valid value.
  email_mailbox_account: (context) => [
    googleAccountRelease(context, "email_mailbox_account"),
  ],
  email_sender_account: (context) => [
    googleAccountRelease(context, "email_sender_account"),
  ],
};

type EraseEntry = Extract<
  (typeof PURGE_CATALOGUE)[number],
  Readonly<{ action: "erase" }>
>;

/** Holds once the Organisation's lifecycle says purged. */
function purgedGuard(organisationId: OrganisationId): RowGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_onboarding
      WHERE organisation_id = ? AND lifecycle = 'purged')`,
    bindings: [organisationId],
  };
}

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
    `DELETE FROM ${entry.table} WHERE (${eraseEntryWhere(entry)})`,
  );
}

function googleAccountRelease(
  context: PurgeContext,
  table: "email_mailbox_account" | "email_sender_account",
): D1PreparedStatement {
  return context.session
    .prepare(
      `UPDATE ${table}
       SET google_subject = 'archived:' || integration_account_id,
           observed_address = integration_account_id || '@archived.invalid'
       WHERE organisation_id = ? AND ${context.purged.sql}`,
    )
    .bind(context.organisationId, ...context.purged.bindings);
}

/** The statements of one catalogue entry, in the batch's order. */
function catalogueStatements(
  context: PurgeContext,
  pseudonymize: Pseudonymizers,
  entry: (typeof PURGE_CATALOGUE)[number],
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
    case "pseudonymize":
      return pseudonymize[entry.table](context);
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
  const pseudonymize: Pseudonymizers = {
    ...TENANCY_PSEUDONYMIZE,
    ...parts.pseudonymize,
  };
  const accounts = await input.db
    .prepare(
      `SELECT integration_account_id AS id, provider_account_id AS providerAccountId
       FROM integration_account
       WHERE organisation_id = ? AND source_kind != 'custom_api'`,
    )
    .bind(input.organisationId)
    .all<{ readonly id: unknown; readonly providerAccountId: unknown }>();
  const connections = await input.db
    .prepare(
      `SELECT provider_connection_id AS id, provider_subject_id AS providerSubjectId
       FROM provider_connection
       WHERE organisation_id = ? AND source_kind != 'custom_api'`,
    )
    .bind(input.organisationId)
    .all<{ readonly id: unknown; readonly providerSubjectId: unknown }>();
  const session = input.db.withSession("first-primary");
  const context: PurgeContext = {
    session,
    organisationId: input.organisationId,
    purged: purgedGuard(input.organisationId),
    accounts: await Promise.all(
      accounts.results.map(async (row) => ({
        id: requireString(row.id, "purged account id"),
        providerAccountHash: await hashOpaqueSecret(
          requireString(row.providerAccountId, "purged provider account id"),
        ),
      })),
    ),
    connections: await Promise.all(
      connections.results.map(async (row) => ({
        id: requireString(row.id, "purged connection id"),
        providerSubjectHash: await hashOpaqueSecret(
          requireString(row.providerSubjectId, "purged provider subject"),
        ),
      })),
    ),
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
    ...PURGE_CATALOGUE.flatMap((entry) =>
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

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} is invalid`);
  return raw;
}
