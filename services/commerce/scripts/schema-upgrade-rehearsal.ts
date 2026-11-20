// Rehearses a commerce schema upgrade in workerd before a release.
//
// The old code (a git ref, for example the commit that production runs) seeds
// a merchant object in workerd with paid orders and an unpaid checkout. This
// tree then opens the same storage, so the object's constructor runs the
// upgrade as it does after a deploy. A SQLite Durable Object enforces foreign
// keys even after `PRAGMA foreign_keys = OFF`, so a table rebuild that passes
// in the Node suite can fail here, or delete child rows.
//
// The rehearsal passes when the object opens, the snapshot lists the seeded
// orders, every table keeps its rows, `PRAGMA foreign_key_check` is clean, and
// the upgraded columns, foreign keys, indexes, triggers and views equal those
// of a new database at the same version.
//
// Usage (from services/commerce):
//   node --experimental-strip-types scripts/schema-upgrade-rehearsal.ts \
//     --from <git ref> [--out <report.json>] [--keep]
// The ref gets a throwaway worktree and its own `pnpm install`.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { CommerceDatabase } from "../src/database.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import {
  FIXTURE_NOW,
  FIXTURE_SERVICE_TOKEN,
  buildFixtureWorker,
  fixtureSigningKey,
  startFixtureMiniflare,
} from "./fixture-miniflare.ts";

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Runs in the old tree's vitest, so it uses that tree's own clients and
// journey helpers.
const SEED_TEST = `import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { startWorkerdBackend } from "./workerd-backend.ts";
import { Buyer, StaffDesk, catalogLine, merchantId, required } from "./journey-support.ts";

it("seeds a merchant for the schema upgrade rehearsal", async () => {
  const persistDirectory = process.env.REHEARSAL_PERSIST;
  const summary = process.env.REHEARSAL_SUMMARY;
  if (!persistDirectory || !summary) throw new Error("REHEARSAL_PERSIST and REHEARSAL_SUMMARY are required");
  const backend = await startWorkerdBackend({ persistDirectory });
  try {
    await new StaffDesk(backend.admin, "rehearsal").createTea();
    for (const index of [0, 1, 2]) {
      const buyer = await Buyer.start(backend.buyer, \`rehearsal_paid_\${index}\`);
      const quoted = await buyer.tryQuote([catalogLine("variant_tea_small_sencha")]);
      if (quoted.kind === "refused") throw new Error(\`Quote refused: \${JSON.stringify(quoted.error)}\`);
      await buyer.pay(quoted.checkout);
    }
    const waiting = await Buyer.start(backend.buyer, "rehearsal_unpaid");
    const unpaid = await waiting.tryQuote([catalogLine("variant_tea_small_sencha")]);
    if (unpaid.kind === "refused") throw new Error(\`Quote refused: \${JSON.stringify(unpaid.error)}\`);
    const snapshot = await required(backend.admin.readSnapshot(merchantId));
    writeFileSync(summary, JSON.stringify({ merchantId, orders: snapshot.resources.orders.length }));
  } finally {
    await backend.close();
  }
}, 600_000);
`;

type Inspection = Readonly<{
  version: number;
  rows: Readonly<Record<string, number>>;
  structure: ReadonlyMap<string, string>;
  tableSql: ReadonlyMap<string, string>;
  foreignKeyViolations: number;
  missingParents: readonly string[];
}>;

const args = process.argv.slice(2);
const from = option("--from");
if (from === undefined) {
  console.error(
    "Usage: schema-upgrade-rehearsal.ts --from <git ref> [--out <report.json>] [--keep]",
  );
  process.exit(2);
}
const out = option("--out");
const keep = args.includes("--keep");

const repository = run("git", ["rev-parse", "--show-toplevel"], SERVICE).trim();
const scratch = mkdtempSync(join(tmpdir(), "commerce-upgrade-rehearsal-"));
const oldTree = join(scratch, "from");
const persist = join(scratch, "persist");
const failures: string[] = [];
try {
  const fromCommit = run(
    "git",
    ["rev-parse", `${from}^{commit}`],
    repository,
  ).trim();
  const toCommit = run("git", ["rev-parse", "HEAD"], repository).trim();
  const dirty =
    run(
      "git",
      ["status", "--porcelain", "--", "services/commerce", "packages"],
      repository,
    ).trim() !== "";
  step(`old code ${fromCommit.slice(0, 9)}: worktree and install`);
  run("git", ["worktree", "add", "--detach", oldTree, fromCommit], repository);
  run("pnpm", ["install", "--prefer-offline", "--frozen-lockfile"], oldTree);
  const oldService = ["services/commerce", "services/underclerk"]
    .map((path) => join(oldTree, path))
    .find((path) => existsSync(join(path, "tests/workerd-backend.ts")));
  if (oldService === undefined)
    throw new Error(
      `${from} has no commerce service with tests/workerd-backend.ts`,
    );

  step("old code: seed paid orders and an unpaid checkout in workerd");
  writeFileSync(
    join(oldService, "tests/upgrade-rehearsal-seed.test.ts"),
    SEED_TEST,
  );
  const summaryPath = join(scratch, "seed.json");
  run(
    join(oldService, "node_modules/.bin/vitest"),
    ["run", "tests/upgrade-rehearsal-seed.test.ts"],
    oldService,
    { REHEARSAL_PERSIST: persist, REHEARSAL_SUMMARY: summaryPath },
  );
  const seeded = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    merchantId: string;
    orders: number;
  };
  const databaseFile = merchantDatabase(persist);
  const before = inspect(databaseFile);
  if ((before.rows.checkout_payment_attempt ?? 0) === 0)
    failures.push(
      "the seed wrote no checkout payment attempt, so the rehearsal proves too little",
    );

  step(
    `this tree ${toCommit.slice(0, 9)}${dirty ? " with uncommitted changes" : ""}: open the same storage`,
  );
  const artifact = join(scratch, "to-artifact");
  buildFixtureWorker(artifact);
  const miniflare = await startFixtureMiniflare({
    artifact,
    signingKey: fixtureSigningKey(),
    persistDirectory: persist,
  });
  let snapshotStatus = 0;
  let snapshotOrders = -1;
  let snapshotError = "";
  try {
    const response = await miniflare.dispatchFetch(
      `${miniflare.origin}/v1/admin/merchants/${encodeURIComponent(seeded.merchantId)}/snapshot`,
      { headers: { authorization: `Bearer ${FIXTURE_SERVICE_TOKEN}` } },
    );
    snapshotStatus = response.status;
    const text = await response.text();
    if (response.ok) {
      const body = JSON.parse(text) as { resources?: { orders?: unknown[] } };
      snapshotOrders = body.resources?.orders?.length ?? -1;
    } else {
      snapshotError = text.slice(0, 500);
    }
  } finally {
    await miniflare.dispose();
  }
  if (snapshotStatus !== 200)
    failures.push(
      `the snapshot read answered ${snapshotStatus}: ${snapshotError}`,
    );
  else if (snapshotOrders !== seeded.orders)
    failures.push(
      `the snapshot lists ${snapshotOrders} orders, the old code placed ${seeded.orders}`,
    );

  step("compare the upgraded database with a new one");
  const after = inspect(databaseFile);
  const baseline = freshBaseline();
  if (after.version !== baseline.version)
    failures.push(
      `the upgraded version is ${after.version}, a new database is ${baseline.version}`,
    );
  for (const [table, count] of Object.entries(before.rows)) {
    // Each upgrade step adds its row; the version check covers it.
    if (table === "schema_migration") continue;
    const now = after.rows[table];
    if (now === undefined)
      failures.push(`table ${table} is gone (${count} rows before)`);
    else if (now !== count)
      failures.push(`table ${table} has ${now} rows, ${count} before`);
  }
  if (after.foreignKeyViolations > 0)
    failures.push(
      `PRAGMA foreign_key_check lists ${after.foreignKeyViolations} rows`,
    );
  for (const missing of after.missingParents)
    failures.push(
      `a foreign key names a table that does not exist: ${missing}`,
    );
  const differences = compare(after.structure, baseline.structure);
  for (const difference of differences)
    failures.push(`schema differs: ${difference}`);
  const tableSqlNotes = [...baseline.tableSql]
    .filter(
      ([table, sql]) =>
        after.tableSql.has(table) && after.tableSql.get(table) !== sql,
    )
    .map(([table]) => table);

  const report = {
    rehearsedAt: new Date().toISOString(),
    fixtureNow: FIXTURE_NOW,
    from: { ref: from, commit: fromCommit, version: before.version },
    to: { commit: toCommit, uncommittedChanges: dirty, version: after.version },
    seeded,
    snapshot: { status: snapshotStatus, orders: snapshotOrders },
    rows: { before: before.rows, after: after.rows },
    foreignKeyViolations: after.foreignKeyViolations,
    // Text only: a column that an upgrade adds with ALTER TABLE is written
    // differently from the same column in a CREATE TABLE.
    tablesWithOtherSqlText: tableSqlNotes,
    failures,
    result: failures.length === 0 ? "passed" : "failed",
  };
  if (out !== undefined)
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\nschema ${before.version} -> ${after.version}; ` +
      `${before.rows.buyer_checkout ?? 0} checkouts, ` +
      `${before.rows.checkout_payment_attempt ?? 0} payment attempts, ` +
      `${seeded.orders} orders seeded; snapshot ${snapshotStatus}`,
  );
  if (failures.length === 0) console.log("rehearsal passed");
  else {
    console.log("rehearsal FAILED:");
    for (const failure of failures) console.log(`- ${failure}`);
    process.exitCode = 1;
  }
} finally {
  if (keep) console.log(`kept ${scratch}`);
  else {
    spawnSync("git", ["worktree", "remove", "--force", oldTree], {
      cwd: repository,
    });
    rmSync(scratch, { recursive: true, force: true });
  }
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function step(text: string): void {
  console.log(`- ${text}`);
}

function run(
  command: string,
  commandArgs: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): string {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

/** The merchant object's SQLite file in the Miniflare storage folder. */
function merchantDatabase(directory: string): string {
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".sqlite"))
    .map((path) => join(directory, path))
    .filter((path) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return (
          database
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name = 'schema_migration'",
            )
            .get() !== undefined
        );
      } finally {
        database.close();
      }
    });
  if (files.length !== 1)
    throw new Error(
      `expected one merchant database in ${directory}, found ${files.length}`,
    );
  return files[0]!;
}

function inspect(path: string): Inspection {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return inspectDatabase({
      all: (query, ...bindings) =>
        database.prepare(query).all(...bindings) as Record<string, unknown>[],
    });
  } finally {
    database.close();
  }
}

/** A new database at this tree's version, as a new merchant gets it. */
function freshBaseline(): Inspection {
  const commerce: CommerceDatabase = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(commerce, FIXTURE_NOW);
  return inspectDatabase({
    all: (query, ...bindings) =>
      commerce
        .prepare(query)
        .all<Record<string, unknown>>(...bindings) as Record<string, unknown>[],
  });
}

function inspectDatabase(
  database: Readonly<{
    all: (query: string, ...bindings: string[]) => Record<string, unknown>[];
  }>,
): Inspection {
  const objects = database.all(
    `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
     WHERE substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_'
     ORDER BY type, name`,
  ) as { type: string; name: string; tableName: string; sql: string | null }[];
  const tables = objects
    .filter((item) => item.type === "table")
    .map((item) => item.name);
  const rows: Record<string, number> = {};
  const structure = new Map<string, string>();
  const tableSql = new Map<string, string>();
  const missingParents: string[] = [];
  for (const table of tables) {
    rows[table] = Number(
      database.all(`SELECT count(*) AS n FROM "${table}"`)[0]!.n,
    );
    for (const column of database.all(
      `SELECT * FROM pragma_table_xinfo(?)`,
      table,
    )) {
      structure.set(
        `column ${table}.${String(column.name)}`,
        `${String(column.type)} notnull=${String(column.notnull)} default=${String(column.dflt_value)} pk=${String(column.pk)} hidden=${String(column.hidden)}`,
      );
    }
    const keys = new Map<
      number,
      { parent: string; from: string[]; to: string[]; rule: string }
    >();
    for (const key of database.all(
      `SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      table,
    )) {
      const id = Number(key.id);
      const entry = keys.get(id) ?? {
        parent: String(key.table),
        from: [],
        to: [],
        rule: `on delete ${String(key.on_delete)} on update ${String(key.on_update)}`,
      };
      entry.from.push(String(key.from));
      entry.to.push(String(key.to));
      keys.set(id, entry);
    }
    for (const key of keys.values()) {
      structure.set(
        `foreign key ${table}(${key.from.join(",")}) -> ${key.parent}(${key.to.join(",")})`,
        key.rule,
      );
      if (!tables.includes(key.parent))
        missingParents.push(`${table} -> ${key.parent}`);
    }
    const sql = objects.find(
      (item) => item.type === "table" && item.name === table,
    )?.sql;
    if (sql) tableSql.set(table, normalizeSql(sql));
  }
  for (const item of objects) {
    if (item.type === "table" || item.sql === null) continue;
    structure.set(
      `${item.type} ${item.name} on ${item.tableName}`,
      normalizeSql(item.sql),
    );
  }
  const version = Number(
    database.all("SELECT MAX(version) AS v FROM schema_migration")[0]!.v,
  );
  const foreignKeyViolations = database.all(
    "SELECT * FROM pragma_foreign_key_check",
  ).length;
  return {
    version,
    rows,
    structure,
    tableSql,
    foreignKeyViolations,
    missingParents,
  };
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1")
    .replace(/"/g, "")
    .trim();
}

function compare(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): string[] {
  const differences: string[] = [];
  for (const [key, value] of expected) {
    const found = actual.get(key);
    if (found === undefined) differences.push(`missing ${key}`);
    else if (found !== value)
      differences.push(`${key}: ${found} (a new database has ${value})`);
  }
  for (const key of actual.keys())
    if (!expected.has(key)) differences.push(`extra ${key}`);
  return differences;
}
