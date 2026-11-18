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
import { assertNever } from "@seams/std";
import { hashOpaqueSecret } from "./control-plane";
import {
  prepareOrganisationLifecycleMove,
  type LifecycleFence,
} from "./organisation-lifecycle-moves";
import { PURGE_CATALOGUE } from "./purge-catalogue";
import { prepareExpiredOrganisationReceiptsDeletion } from "./shared-rows/mutation-receipt";
import {
  prepareOrganisationPurge,
  publishOrganisationDirectoryRow,
  type RowGuard,
} from "./shared-rows/organisation-row";

type Session = OrganisationDatabaseSession;

type PurgeContext = Readonly<{
  session: Session;
  organisationId: OrganisationId;
  /** True once the batch's first statement has moved the lifecycle. */
  purged: RowGuard;
  accounts: readonly Readonly<{ id: string; providerAccountHash: string }>[];
  connections: readonly Readonly<{ id: string; providerSubjectHash: string }>[];
  now: number;
}>;

type PseudonymizedTable = Extract<
  (typeof PURGE_CATALOGUE)[number],
  Readonly<{ action: "pseudonymize" }>
>["table"];

/** The rewrite of each table that the catalogue marks pseudonymize. */
const PSEUDONYMIZE: Readonly<
  Record<PseudonymizedTable, (context: PurgeContext) => D1PreparedStatement[]>
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
  integration_account: (context) => [
    guarded(
      context,
      "DELETE FROM integration_account WHERE organisation_id = ? AND source_kind = 'custom_api'",
    ),
    ...context.accounts.map((account) =>
      context.session
        .prepare(
          `UPDATE integration_account
           SET provider_account_id = ?, display_name = 'Archived account',
               lifecycle = 'revoked', lifecycle_reason_code = NULL,
               capability_set = '[]', is_default_for_provider = 0,
               disabled_by_user_id = NULL, disabled_at = NULL,
               revoked_at = ?, updated_at = ?
           WHERE integration_account_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `archived:${account.providerAccountHash}`,
          context.now,
          context.now,
          account.id,
          ...context.purged.bindings,
        ),
    ),
  ],
  provider_credential_generation: (context) => [
    guarded(
      context,
      `DELETE FROM provider_credential_generation
       WHERE organisation_id = ? AND provider_connection_id IN (
         SELECT provider_connection_id FROM provider_connection
         WHERE source_kind = 'custom_api'
       )`,
    ),
    ...context.connections.map((connection) =>
      context.session
        .prepare(
          `UPDATE provider_credential_generation SET credential_ref = ?
           WHERE provider_connection_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `vault:archived:${connection.id}:revoked`,
          connection.id,
          ...context.purged.bindings,
        ),
    ),
  ],
  provider_connection: (context) => [
    guarded(
      context,
      "DELETE FROM provider_connection WHERE organisation_id = ? AND source_kind = 'custom_api'",
    ),
    ...context.connections.map((connection) =>
      context.session
        .prepare(
          // A shared-application connection has no organisation credential to
          // pseudonymize, and its authority branch requires the handle to stay
          // null, so only the organisation-credential branch is rewritten.
          `UPDATE provider_connection
           SET provider_subject_id = ?,
               credential_ref = CASE
                 WHEN authority_kind = 'connection_credential' THEN ?
                 ELSE NULL
               END,
               lifecycle = 'revoked', revoked_at = ?, disabled_at = NULL,
               updated_at = ?
           WHERE provider_connection_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `archived:${connection.providerSubjectHash}`,
          `vault:archived:${connection.id}:revoked`,
          context.now,
          context.now,
          connection.id,
          ...context.purged.bindings,
        ),
    ),
  ],
};

function guarded(context: PurgeContext, sql: string): D1PreparedStatement {
  return context.session
    .prepare(`${sql} AND ${context.purged.sql}`)
    .bind(context.organisationId, ...context.purged.bindings);
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
  entry: (typeof PURGE_CATALOGUE)[number],
): D1PreparedStatement[] {
  switch (entry.action) {
    case "erase":
      return [
        guarded(
          context,
          `DELETE FROM ${entry.table} WHERE (${"where" in entry ? entry.where : "organisation_id = ?"})`,
        ),
      ];
    case "pseudonymize":
      return PSEUDONYMIZE[entry.table](context);
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
    purged: {
      sql: `EXISTS (SELECT 1 FROM organisation_onboarding
        WHERE organisation_id = ? AND lifecycle = 'purged')`,
      bindings: [input.organisationId],
    },
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
    ...PURGE_CATALOGUE.flatMap((entry) => catalogueStatements(context, entry)),
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
  // The directory's Slack records that name the Organisation's connections:
  // a person's DM choice and the thread pins. A DM choice that named a
  // revoked connection asks the person to choose again; a pin has no Case
  // to reach.
  await input.directory.batch([
    input.directory
      .prepare(
        `DELETE FROM slack_dm_organisation_selection
         WHERE EXISTS (SELECT 1 FROM slack_organisation_connection AS connection
           WHERE connection.installation_id = slack_dm_organisation_selection.installation_id
             AND connection.connection_id = slack_dm_organisation_selection.connection_id
             AND connection.organisation_id = ? AND connection.lifecycle = 'revoked')`,
      )
      .bind(input.organisationId),
    input.directory
      .prepare("DELETE FROM slack_thread_case_pin WHERE organisation_id = ?")
      .bind(input.organisationId),
  ]);
  return statements.length;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} is invalid`);
  return raw;
}
