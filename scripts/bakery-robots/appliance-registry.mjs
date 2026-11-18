#!/usr/bin/env node
// Refactor 16 step 12: one appliance registry.
//
// assets/bakery-mujoco/appliances.json is the one list of the engine
// appliances. This script writes from it:
//
// - ApplianceName and the cases of parseName in
//   packages/bakery-model/src/bakery-appliance-protocol.ts;
// - the enum Name, Name::ALL and Name::folder() in
//   crates/bakery-native/src/appliances.rs;
// - the appliance entries of the asset list
//   assets/bakery-mujoco/fr10-workcell/native/assets.json, and its SHA-256 in
//   PHYSICS_ASSETS_SHA256 of packages/bakery-model/src/bakery-physics.ts, as
//   build_native_assets.py writes it. ASSESSED_ASSETS_SHA256 is not written:
//   a person sets it after the UR5e mass check (ur5e_mass_check.py).
//
// model-packs.mjs and retain-appliance-builds.mjs read the table through
// `applianceTable`. The script also checks the facts of each row that other
// source holds: the model folder assets/bakery-mujoco/<name>, the timestep of its native.xml, the
// Controller arm of its family in appliance_run.rs, and the files that its
// model names. It also checks that each bundled example recording names a
// model of the pinned asset list.
//
// Each generated list follows a marker comment (RUST_MARK in appliances.rs,
// a "Generated" comment in the protocol file). The script finds each list by
// its marker and the code around it, and it writes the bytes that rustfmt
// gives. Every list follows the table order.
//
//   node scripts/bakery-robots/appliance-registry.mjs           write the lists
//   node scripts/bakery-robots/appliance-registry.mjs --check   fail on a difference
//   ... --root <directory>                                      another checkout
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { physicsCellOf } from "../../packages/bakery-model/src/bakery-physics.ts";

const TABLE = "assets/bakery-mujoco/appliances.json";
const MODELS = "assets/bakery-mujoco";
const ASSET_LIST = "assets/bakery-mujoco/fr10-workcell/native/assets.json";
const PROTOCOL = "packages/bakery-model/src/bakery-appliance-protocol.ts";
const RUST = "crates/bakery-native/src/appliances.rs";
const CONTROLLERS = "crates/bakery-native/src/appliance_run.rs";
const CONTRACT = "packages/bakery-model/src/bakery-physics.ts";
// The bundled examples that the Portal opens as presets and as chat sources.
const RECORDINGS = "assets/bakery-mujoco/fr10-workcell/recordings";
// MuJoCo's timestep when a model names none.
const MUJOCO_TIMESTEP = 0.002;
// The comment before each generated list of appliances.rs.
const RUST_MARK = `// Generated from ${TABLE} by scripts/bakery-robots/appliance-registry.mjs.`;

/** The rows of the table, checked for shape. Throws on a bad table. */
export function applianceTable(root) {
  const table = JSON.parse(readFileSync(join(root, TABLE), "utf8"));
  const rows = table.appliances;
  const problems = [];
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`${TABLE} has no appliances.`);
  const seen = new Set();
  for (const row of rows) {
    const label = row?.name ?? JSON.stringify(row);
    if (typeof row.name !== "string" || !/^[a-z0-9-]+$/u.test(row.name))
      problems.push(
        `${label}: name must be lower-case letters, digits and "-".`,
      );
    if (typeof row.rust !== "string" || !/^[A-Z][A-Za-z0-9]*$/u.test(row.rust))
      problems.push(`${label}: rust must be a Rust variant name.`);
    if (
      typeof row.family !== "string" ||
      !/^[a-z]+(-[a-z]+)*$/u.test(row.family)
    )
      problems.push(
        `${label}: family must be a Controller variant in kebab case.`,
      );
    if (typeof row.timestep !== "number" || !(row.timestep > 0))
      problems.push(`${label}: timestep must be a positive number.`);
    if (
      !Array.isArray(row.assets) ||
      !row.assets.includes("native.xml") ||
      row.assets.some((file) => typeof file !== "string")
    )
      problems.push(
        `${label}: assets must list the files of the folder for assets.json, native.xml among them.`,
      );
    for (const key of ["name", "rust"]) {
      if (seen.has(`${key}:${row[key]}`))
        problems.push(`${label}: another row has the same ${key}.`);
      seen.add(`${key}:${row[key]}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { rows };
}

/** Replaces the text between `start` and `end`; `end` is searched after `start`. */
function between(text, file, start, end, replacement) {
  const from = text.indexOf(start);
  if (from < 0 || text.indexOf(start, from + 1) >= 0)
    throw new Error(
      `${file}: cannot find one "${start.trim()}". Update ${TABLE}'s generator.`,
    );
  const open = from + start.length;
  const close = text.indexOf(end, open);
  if (close < 0)
    throw new Error(
      `${file}: cannot find "${end.trim()}" after "${start.trim()}".`,
    );
  return text.slice(0, open) + replacement + text.slice(close);
}

function protocolSource(text, table) {
  const union = table.rows.map((row) => `  | "${row.name}"`).join("\n");
  const cases = table.rows.map((row) => `    case "${row.name}":\n`).join("");
  text = between(text, PROTOCOL, "export type ApplianceName =\n", ";\n", union);
  return between(
    text,
    PROTOCOL,
    "function parseName(raw: unknown): ApplianceName {\n  switch (raw) {\n",
    "      return raw;\n",
    cases,
  );
}

function rustSource(text, table) {
  const variants = table.rows
    .map(
      (row) =>
        `    #[serde(rename = "${row.name}")]\n    #[value(name = "${row.name}")]\n    ${row.rust},\n`,
    )
    .join("");
  const all = table.rows.map((row) => `        Self::${row.rust},\n`).join("");
  const arms = table.rows
    .map((row) => `            Self::${row.rust} => "${row.name}",\n`)
    .join("");
  text = between(
    text,
    RUST,
    `${RUST_MARK}\n#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]\npub enum Name {\n`,
    "}\n",
    variants,
  );
  text = between(
    text,
    RUST,
    `impl Name {\n    ${RUST_MARK}\n    pub const ALL: [Self; `,
    "    ];\n",
    `${table.rows.length}] = [\n${all}`,
  );
  return between(
    text,
    RUST,
    `    ${RUST_MARK}\n    pub fn folder(self) -> &'static str {\n        match self {\n`,
    "        }\n",
    arms,
  );
}

/** The asset list with its appliance entries written from the table. */
function assetListSource(root, text, table) {
  const files = JSON.parse(text);
  const folders = new Set(table.rows.map((row) => row.name));
  for (const path of Object.keys(files)) {
    const folder = /^assets\/bakery-mujoco\/([^/]+)\//u.exec(path)?.[1];
    if (folders.has(folder)) delete files[path];
  }
  for (const row of table.rows)
    for (const file of row.assets ?? []) {
      const path = `${MODELS}/${row.name}/${file}`;
      files[path] = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
    }
  // The order of build_native_assets.py: sorted paths, two-space indent.
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * A cleared example tray runs again with its recorded request, and the engine
 * refuses a model hash of another asset list. Returns the problems.
 */
async function checkRecordings(root, assetsSha256) {
  const problems = [];
  const folder = join(root, RECORDINGS);
  for (const file of readdirSync(folder).filter((name) =>
    name.endsWith(".json"),
  )) {
    const recording = JSON.parse(readFileSync(join(folder, file), "utf8"));
    const requests = [
      recording.request,
      recording.loading?.request,
      recording.unloading?.request,
      recording.racking?.request,
    ].filter((request) => request !== undefined);
    for (const request of requests)
      if ((await physicsCellOf(request, assetsSha256)) === null)
        problems.push(
          `${RECORDINGS}/${file} names a model of another asset list. Run it again with bakery-native (prepare, then run or cycle) and replace the file.`,
        );
  }
  return problems;
}

/** Facts of each row that other source holds. Returns the problems. */
function checkRows(root, table) {
  const problems = [];
  const controllers = readFileSync(join(root, CONTROLLERS), "utf8");
  const from = controllers.indexOf("let controller = match name {");
  const block = controllers.slice(from, controllers.indexOf("};", from));
  const family = new Map();
  let pending = [];
  for (const match of block.matchAll(/Name::(\w+)|=> Controller::(\w+)/gu)) {
    if (match[1] !== undefined) pending.push(match[1]);
    else {
      const kebab = match[2]
        .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
        .toLowerCase();
      for (const variant of pending) family.set(variant, kebab);
      pending = [];
    }
  }
  if (from < 0 || family.size === 0)
    problems.push(
      `${CONTROLLERS}: cannot find "let controller = match name {".`,
    );
  // A model may name a file of another appliance's folder (the dishwasher
  // names Hobart meshes), so a named file must be in some row's assets.
  const listed = new Set(
    table.rows.flatMap((row) =>
      (row.assets ?? []).map((file) => `${MODELS}/${row.name}/${file}`),
    ),
  );
  for (const row of table.rows) {
    const model = `${MODELS}/${row.name}/native.xml`;
    if (!existsSync(join(root, model))) {
      problems.push(`${row.name}: ${model} is missing.`);
      continue;
    }
    const xml = readFileSync(join(root, model), "utf8");
    const named = /<option\b[^>]*\btimestep="([^"]+)"/u.exec(xml);
    const timestep = named === null ? MUJOCO_TIMESTEP : Number(named[1]);
    if (timestep !== row.timestep)
      problems.push(
        `${row.name}: ${model} has timestep ${timestep}, the table ${row.timestep}.`,
      );
    if (family.get(row.rust) !== row.family)
      problems.push(
        `${row.name}: the table gives family ${row.family}, and ${CONTROLLERS} gives Name::${row.rust} ${
          family.has(row.rust)
            ? `Controller ${family.get(row.rust)}`
            : "no Controller arm"
        }.`,
      );
    for (const file of row.assets ?? [])
      if (!existsSync(join(root, MODELS, row.name, file)))
        problems.push(`${row.name}: asset ${file} is missing.`);
    if (row.assets === undefined) continue;
    for (const [, file] of xml.matchAll(/\bfile="([^"]+)"/gu))
      if (!listed.has(posix.normalize(posix.join(MODELS, row.name, file))))
        problems.push(
          `${row.name}: ${model} names ${file}, which no row's assets list.`,
        );
  }
  return problems;
}

/** Writes or checks each generated file. Returns the problems. */
export async function applianceRegistry(root, { check }) {
  const table = applianceTable(root);
  const problems = checkRows(root, table);
  const assetList = assetListSource(
    root,
    readFileSync(join(root, ASSET_LIST), "utf8"),
    table,
  );
  const assetsSha256 = createHash("sha256").update(assetList).digest("hex");
  problems.push(...(await checkRecordings(root, assetsSha256)));
  for (const [file, generate] of [
    [PROTOCOL, (text) => protocolSource(text, table)],
    [RUST, (text) => rustSource(text, table)],
    [ASSET_LIST, () => assetList],
    // The engine hashes the asset list into each model hash; a request with
    // another PHYSICS_ASSETS_SHA256 names models that the engine does not run.
    [
      CONTRACT,
      (text) =>
        between(
          text,
          CONTRACT,
          'export const PHYSICS_ASSETS_SHA256 =\n  "',
          '";\n',
          assetsSha256,
        ),
    ],
  ]) {
    const current = readFileSync(join(root, file), "utf8");
    const generated = generate(current);
    if (generated === current) continue;
    if (check)
      problems.push(
        `${file} differs from ${TABLE}. Edit the table, not the list, and run node scripts/bakery-robots/appliance-registry.mjs.`,
      );
    else {
      writeFileSync(join(root, file), generated);
      console.log(`appliance registry: wrote ${file}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root =
    rootFlag >= 0
      ? args[rootFlag + 1]
      : join(dirname(fileURLToPath(import.meta.url)), "../..");
  const check = args.includes("--check");
  let problems;
  try {
    problems = await applianceRegistry(root, { check });
  } catch (error) {
    problems = [error.message];
  }
  if (problems.length > 0) {
    for (const problem of problems)
      console.error(`appliance registry: ${problem}`);
    process.exit(1);
  }
  console.log(
    `appliance registry: ${applianceTable(root).rows.length} appliances; the generated lists equal ${TABLE}.`,
  );
}
