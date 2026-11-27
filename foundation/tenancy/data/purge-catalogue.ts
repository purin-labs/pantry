/**
 * What the purge does with each regional table (Refactor 15, refactor 5).
 * Every table of the regional baseline has one entry; `pnpm
 * lint:purge-catalogue` (scripts/check-purge-catalogue.mjs) refuses a table
 * with no entry, an entry for a table that does not exist, and an order in
 * which a row would be erased before a row that refers to it.
 *
 * The owner of each table gives its entries from a `purge-entries.ts` file
 * of its own (Refactor 17), so that only the owner names an erase of its
 * table. The Worker joins the lists (`joinPurgeCatalogue`) and gives the
 * catalogue to tenancy through the lifecycle port. Tenancy keeps the entry
 * type, the order rule, the erase statement (`organisation-purge.ts`) and
 * the entries of its own tables.
 *
 * - `erase`: the purge deletes every row of the Organisation. `statement`
 *   is the DELETE of the entry's own table. `where` selects the rows of a
 *   table with no `organisation_id` column; its one `?` is the Organisation
 *   id.
 * - `pseudonymize`: the row stays, because other rows refer to it, but it
 *   loses what identifies a person or a provider account. The owner gives a
 *   rewrite for each such table.
 * - `keep`: the row stays as it is. It is a receipt of the purge, or the
 *   placement owns it. The reason says which.
 *
 * The order rule: the purge runs the entries in the order of `order`, so a
 * table comes before every table that it refers to. Each entry has its own
 * number; a new entry takes a free number between its neighbours.
 */
/**
 * The statement of an erase entry: the DELETE of one table, before its
 * WHERE. It is a type, not a write: the purge runs the literal statement of
 * each entry.
 */
type EraseStatement<Table extends string> = `${"DELETE FROM"} ${Table}`;

type EraseEntry = Readonly<{
  order: number;
  table: string;
  action: "erase";
  statement: EraseStatement<string>;
  where?: string;
}>;

export type PurgeCatalogueEntry =
  | EraseEntry
  | Readonly<{
      order: number;
      table: string;
      action: "pseudonymize" | "keep";
      reason: string;
    }>;

/** The tables of a list of entries that the purge pseudonymizes. */
export type PseudonymizedTable<Entry extends PurgeCatalogueEntry> = Extract<
  Entry,
  Readonly<{ action: "pseudonymize" }>
>["table"];

/** An erase entry must delete from its own table. */
type OwnTableEntry<Entry> =
  Entry extends Readonly<{ action: "erase"; table: infer Table extends string }>
    ? Entry & Readonly<{ statement: EraseStatement<Table> }>
    : Entry;

type OwnTableLists<Lists extends readonly (readonly PurgeCatalogueEntry[])[]> =
  {
    readonly [List in keyof Lists]: {
      readonly [Index in keyof Lists[List]]: OwnTableEntry<Lists[List][Index]>;
    };
  };

/**
 * The catalogue: the entries of each table owner in the order of `order`.
 * Two entries with one number, or two entries for one table, are a
 * programmer error.
 */
export function joinPurgeCatalogue<
  const Lists extends readonly (readonly PurgeCatalogueEntry[])[],
>(...lists: Lists & OwnTableLists<Lists>): readonly Lists[number][number][] {
  const owners: Lists = lists;
  const entries = owners
    .flatMap((list: Lists[number]): Lists[number][number][] => [...list])
    .sort((left, right) => left.order - right.order);
  const orders = new Set<number>();
  const tables = new Set<string>();
  for (const entry of entries) {
    if (orders.has(entry.order))
      throw new Error(`purge_catalogue_order_repeated:${entry.order}`);
    if (tables.has(entry.table))
      throw new Error(`purge_catalogue_table_repeated:${entry.table}`);
    orders.add(entry.order);
    tables.add(entry.table);
  }
  return entries;
}

/** The entries of the tables of tenancy. */
export const TENANCY_PURGE_ENTRIES = [
  {
    order: 480,
    table: "control_mutation_receipt",
    action: "keep",
    reason:
      "Idempotency receipts of control requests. They hold no Organisation data beyond the request scope, and each one expires on its own; the purge deletes the expired ones.",
  },
  {
    order: 890,
    table: "surface_installation",
    action: "erase",
    statement: "DELETE FROM surface_installation",
  },
  {
    order: 1200,
    table: "onboarding_audit_event",
    action: "keep",
    reason:
      "Audit of lifecycle mutations, with hashed subjects. The archive, delete and purge decisions are proved by it.",
  },
  {
    order: 1210,
    table: "onboarding_event",
    action: "keep",
    reason:
      "Lifecycle events with hashed subjects. The scheduled run writes its own events, also in the purge run.",
  },
  {
    order: 1260,
    table: "organisation",
    action: "pseudonymize",
    reason:
      "The row stays, as other rows and the directory refer to it. It loses its name and its handle, and says purged.",
  },
  {
    order: 1310,
    table: "organisation_archive_cleanup",
    action: "keep",
    reason:
      "The archive cleanup state. It says purged after the purge, and the erasure status reads it.",
  },
  {
    order: 1320,
    table: "organisation_archive_tombstone",
    action: "keep",
    reason:
      "The archive receipt: who archived the Organisation, when, and when it was purged.",
  },
  {
    order: 1430,
    table: "organisation_invitation",
    action: "erase",
    statement: "DELETE FROM organisation_invitation",
  },
  {
    order: 1440,
    table: "organisation_logo",
    action: "erase",
    statement: "DELETE FROM organisation_logo",
  },
  {
    order: 1450,
    table: "organisation_onboarding",
    action: "keep",
    reason: "The lifecycle row. It says purged after the purge.",
  },
  {
    order: 1470,
    table: "organisation_placement",
    action: "keep",
    reason: "The placement and its fence, which the placement owns.",
  },
  {
    order: 1550,
    table: "service_role_grant",
    action: "erase",
    statement: "DELETE FROM service_role_grant",
  },
  {
    order: 1560,
    table: "person",
    action: "erase",
    statement: "DELETE FROM person",
  },
  {
    order: 1880,
    table: "workspace_ai_budget",
    action: "erase",
    statement: "DELETE FROM workspace_ai_budget",
  },
] as const satisfies readonly PurgeCatalogueEntry[];

/** The rows of the Organisation that an erase entry selects. */
export function eraseEntryWhere(
  entry: Readonly<{ action: "erase"; where?: string }>,
): string {
  return entry.where ?? "organisation_id = ?";
}

/**
 * What the purge deletes in R2 (the `ARCHIVE` bucket). Each key that the
 * Worker writes for an Organisation starts with `<root>/<Organisation id>/`;
 * `encoded` says that the writer passes the id through encodeURIComponent.
 * The purge deletes each object under each prefix, after the Session erasure
 * and before the D1 rows go. It keeps an export that a relocation or restore
 * journal of the global database still names.
 * `pnpm lint:purge-catalogue` refuses a key root, in a template that puts an
 * Organisation id after it, that this list does not name. A new kind of
 * object gets one entry here.
 */
type PurgeR2Prefix = Readonly<{
  root: string;
  encoded: boolean;
  holds: string;
}>;

export const PURGE_R2_PREFIXES = [
  {
    root: "attachments",
    encoded: false,
    holds:
      "Chat, Slack and email files, their stills and their prepared copies.",
  },
  {
    root: "attachment-collection",
    encoded: false,
    holds: "The receipts of the attachment collection.",
  },
  {
    root: "organisation-logos",
    encoded: false,
    holds: "The logos of the Organisation and of its workspaces.",
  },
  {
    root: "harness-checkpoints",
    encoded: true,
    holds: "The harness checkpoints of the Sessions.",
  },
  {
    root: "workspace-revisions",
    encoded: false,
    holds: "The manifests and changesets of the workspace revisions.",
  },
  {
    root: "state-object-exports",
    encoded: false,
    holds: "The Actor exports of a relocation or a restore.",
  },
  {
    root: "state-object-organisation-data-v1",
    encoded: false,
    holds: "The regional rows that a relocation copies.",
  },
  {
    root: "device-snapshots",
    encoded: false,
    holds: "The camera snapshots of the devices.",
  },
  {
    root: "bakery-runs",
    encoded: true,
    holds: "The saved Kitchen runs.",
  },
  {
    root: "bakery-run-prepared",
    encoded: true,
    holds: "The staged Kitchen runs, under the user who staged them.",
  },
  {
    root: "bakery-run-artifacts",
    encoded: true,
    holds: "The artifacts of the Kitchen runs, under the user who stored them.",
  },
  {
    root: "bakery-workflows",
    encoded: true,
    holds:
      "The recipe workflow revisions, the proposal documents and the findings.",
  },
] as const satisfies readonly PurgeR2Prefix[];

/** The R2 prefix of one entry for one Organisation. */
export function purgeR2Prefix(
  entry: Readonly<{ root: string; encoded: boolean }>,
  organisationId: string,
): string {
  const id = entry.encoded
    ? encodeURIComponent(organisationId)
    : organisationId;
  return `${entry.root}/${id}/`;
}
