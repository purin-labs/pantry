# Refactor 12 — Typed database handles, one owner for the shared rows

Date: 2026-11-06.
Status: parts 1 and 2 are done on the branch `typed-database-handles`,
rebased on `dev` `f6b5b2660`. The full E2E suite passes: 213 files, 2
live-model files skipped ([run](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/full-e2e-run.md)).
Landed on `dev` on 2026-11-06 with the owner's word, pushed and released the
same day (satyr-edge `e61e3b8f`, source `c7df479ca`). The owner named it Refactor 12: the branch `refactor-11` holds
Refactor 11.

Part 1 changes no product behavior. Part 2 changes behavior in the three places
that [part 2](#behavior-changes) lists. Each task lands on the branch when its
checks pass.

## Why

Refactor 10 made the E2E suite run on two databases: `DB` holds the global
records (`migrations-global`), and each Organisation's records live in the
regional database of its placement cell (`migrations-regional`,
`ORGANISATION_DB_WNAM`, `ORGANISATION_DB_APAC`, `ORGANISATION_DB_EU`). That work
showed two weaknesses. Measured on `dev` (`f74f63b95`):

- **Every handle has one type.** `services/platform/src` used `D1Database` 962
  times and `D1DatabaseSession` 59 times in 224 files. A call that passes the
  global database where an Organisation's database is needed type-checks. It
  fails only at run time, and only on two databases.
- **Three tables live in both baselines.** `organisation`,
  `organisation_placement` and `control_mutation_receipt` are in both schemas.
  38 write statements in 13 files write them, and four code paths keep the
  copies in step:
  - Onboarding (`bootstrapOrganisation`) reserves in the global database,
    writes the regional rows, then activates the global placement.
  - A rename, an archive, a restore and a deletion write the regional row only.
    `publishOrganisationDirectoryRow` copies name and status to the global row
    in the scheduled onboarding run, which runs every 15 minutes. Until then
    the global row shows the old values.
  - A relocation freezes the global placement, then the regional copy, in
    separate steps.
  - The regional copier (`organisation-regional-copy.ts`) skips the placement
    table, copies the receipts and the Organisation row with the other rows,
    and blanks the old row on cleanup.
- **One wrong-database call is live.** The part 1 analysis found that the
  checkout profile routes read the replay receipt from `env.DB`, but they write
  the receipt to the Organisation's database. A repeated request with the same
  idempotency key therefore runs again instead of replaying.

## Rules for every step

- **Part 1 changes no behavior.** It changes types only. Part 2 lists each
  behavior change below, and only those change.
- **Keep the wire values:** table names, receipt kinds, journal kinds, Durable
  Object and RPC names. Old and new Workers run side by side during a deploy.
- **Moves are scripts.** A bulk change is a script that can run again on a new
  `dev`. A hand edit is listed in the evidence.
- **E2E journeys, not unit tests.** The full E2E suite must pass 212 of 212
  files. Each part leaves a text artifact in `docs/evidence/refactor-12/`.
- **Stage explicit paths.** Another session edits `control/routes/agents.ts`,
  `data/agent-operations.ts`, Actor helper memory and E2E fixtures. Rebase on
  `dev` and run the scripts again; do not merge a moved file by hand.
- **No push, deploy or merge to `dev`** without the owner's word.

## Steps and status

| Step | Scope | Status |
| ---- | ----- | ------ |
| 1 | Typed database handles | Done 2026-11-06 on the branch |
| 2 | One owner for the shared rows | Done 2026-11-06 on the branch ([journeys](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/part-2-journeys.md), [moves](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/hand-edits.md)) |

### Part 1 — Typed database handles

`services/platform/src/database-handles.ts` defines the handle types:

| Type | Is | Made by |
| ---- | -- | ------- |
| `GlobalDatabase`, `GlobalDatabaseSession` | `env.DB` | `Env.DB` is declared a `GlobalDatabase` |
| `OrganisationDatabase`, `OrganisationDatabaseSession` | an Organisation's regional database | `selectOrganisationPlacementDatabase`, `configuredOrganisationDatabases`, so also `OrganisationExecutionScope.database` |
| `SingleDatabase` | one database that holds both schemas | unit tests only (`tests/sqlite-d1.ts`) |
| plain `D1Database` | either one | code that names only the three shared tables, or that copies rows between databases |

A brand is a type-only property, so a handle is still the binding at run time.
`prepare` returns a branded statement, so `Pick<GlobalDatabase, "prepare">`
keeps its brand. The two brands use two keys, so `SingleDatabase` carries both
and fits either kind. `sameBinding(a, b)` replaces `a === b` where a
one-database profile binds a cell to `DB` itself.

The bulk is one script that can run again:

```bash
node scripts/refactor-12/database-roles.mjs --write
```

It loads the platform program with the TypeScript compiler. Each declaration
whose type is a D1 handle is a node. A node collects the tables that its SQL
names (`prepare`, `exec`, also through `withSession` and SQL helper functions)
and the needs of each node that it flows into: a callee's parameter, the
property of a contextual or target type, a variable, a getter, the element of
a handle array, and the parameter of a function that implements a contextual
signature. A node that names only global tables is global; one that names only
regional tables is an Organisation node. The three shared tables decide
nothing. The script rewrites only plain annotations, and it never changes a
branded one. A second script names every unit test handle a `SingleDatabase`
and every unit test `Env` a `UnitTestEnv`:

```bash
python3 scripts/refactor-12/unit-test-handles.py
```

Result on `f74f63b95`: 1,103 annotated handles. 113 are global, 906 are
Organisation handles, 84 stay plain, and none is mixed
([analysis](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/database-roles.json)). The
[hand edits](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/hand-edits.md) list each place that no script
reached: four functions that return a selected database, two handle lists, a
getter's fields, a callback, two union members, the `QuerySource` twins
(`GlobalQuerySource`, `OrganisationQuerySource`), and the test fixtures.

`pnpm lint:database-handles` refuses a cast to a handle type outside
`database-handles.ts`, and a new plain handle in any source file
(`scripts/database-handles-ratchet.json`). The
[probe](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/wrong-database-probe.md) shows that a
wrong-database call is a type error in both directions, and that a plain
binding is refused too.

File size: `chat/application.ts` would have grown by one import line, so
`missingChatPermissionItems` moved to `chat/permission-items.ts`; the file is
3,549 lines, below its old entry. `data/agent-operations.ts` grew by one
import line, and its ratchet entry rose by one. Branch `refactor-11` splits that
file; when it lands, the entry falls again, or one function moves out.

### Part 2 — One owner for the shared rows

`services/platform/src/data/shared-rows/` owns every write and every sync of the
three shared tables. No other source file writes them;
`pnpm lint:database-handles` refuses an `INSERT`, `UPDATE`, `DELETE` or
`REPLACE` of a shared table outside the folder. Each statement names the copy
that it writes with its handle type. The callers keep their batches, so each
write stays atomic with its fence and its effects.

#### The rule for each row

| Row | Source | Copy | How long the copies may differ |
| --- | ------ | ---- | ------------------------------ |
| `organisation` at onboarding and Slack install | the request writes both | — | Until the request ends. If it stops after the regional commit, the next scheduled onboarding run activates the global placement (change C2): at most one run, 15 minutes |
| `organisation` name and status | regional row | global directory row | Until the request ends: the request copies them after the regional commit (change C1). If that copy fails, the next scheduled onboarding run copies them: at most 15 minutes |
| `organisation` during a move | source cell | target cell | The move provisions the target row before the copy, and cleanup blanks the old row. Routing reads the global placement, so no request reads a stale cell |
| `organisation_placement` | global row: routing and publication | regional row: the execution fence | The global row leads: it freezes first and publishes first. The regional row follows in the next step of the same relocation. A stopped relocation resumes or is abandoned after the publication budget, 5 minutes |
| `control_mutation_receipt` | — | never copied | Each receipt lives in the database of the effect that it records, in the same batch, and its replay reads that database (change C3). A receipt moves and is restored with its Organisation's rows |

#### Behavior changes

- **C1. A lifecycle change reaches the directory in the same request.** After a
  rename, an archive, a restore or a deletion commits in the regional database,
  the request copies name and status to the global row. A failed copy does not
  fail the request: the regional row is the record, and the scheduled run
  repairs the copy. Before: the copy waited for the next 15-minute run.
- **C2. A stopped onboarding publication is repaired.** The scheduled
  onboarding run activates a global epoch-1 placement that is still `reserved`
  while the regional placement with the same fence token is `active`. Before:
  only a repeat of the same request activated it, so the Organisation stayed
  unroutable without one.
- **C3. A checkout profile replay reads the Organisation's database.** The
  replay now reads the database where the receipt was written. Before: a repeat
  with the same idempotency key ran the mutation again.

#### Tasks

1. Move each write of the three tables into `data/shared-rows/`: the
   Organisation row, the placement row, and the receipts. Keep the old exports
   where many files import them, as re-exports.
2. Move the regional copier's rules for the three tables into the folder.
3. C1, C2 and C3, each with its journey.
4. Extend `pnpm lint:database-handles` to refuse a shared-row write outside the
   folder.

Done when one module owns these writes, the onboarding, relocation and
deletion journeys pass, and the full E2E suite passes. All four tasks are
done. The new journey `shared-organisation-rows.test.ts` fails when C1, C2 or
C3 is undone.

## Decisions

- **D1. Where a receipt lives.**
  - Recommendation: with the effect that it records, in the same batch.
  - Cost: none; the code does this today except for checkout profiles.
  - The alternative, every Organisation-scoped receipt in the Organisation's
    database, splits the Slack routing receipts from their global effects, so
    a receipt could commit without its effect.
  - Default: with the effect.
- **D2. A failed directory copy in C1.**
  - Recommendation: log it and return success; the scheduled run repairs it.
  - Cost: the copy can lag for one run, 15 minutes, as today.
  - Default: return success.
