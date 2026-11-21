#!/usr/bin/env node
// Plan 93, step 2: the code change for the clean cutover to the new stack.
//
// The new stack starts with empty storage, so every old name changes in every
// layer: code, wire values, stored names, deployed names and display text.
// Nothing reads an old value after the cutover (Plan 93, "Names in the code
// and on the wire" and group B of "Legacy names on dev").
//
//   node scripts/rename/plan-93-cutover.mjs               # dry run: report only
//   node scripts/rename/plan-93-cutover.mjs --write       # change the tree
//   node scripts/rename/plan-93-cutover.mjs --collisions  # new names that exist already
//
// Run it from the repository root on a clean tree. After --write, run
// `pnpm install --prefer-offline`. A second run changes nothing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const isBinary = (file) =>
  /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|data|wasm|onnx|pdf|zip|gz|mp3|mp4|wav|woff2?|ttf|otf|mjb|stl|obj|npz|npy)$/i.test(
    file,
  );

/** Each tracked file that exists in the working tree. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const COLLISIONS = args.includes("--collisions");
const SELF = "scripts/rename/plan-93-cutover.mjs";

/** The two D1 baselines. The new databases load them fresh, so their old names change too. */
const BASELINES = [
  "services/platform/migrations-global/0001_current_schema.sql",
  "services/platform/migrations-regional/0001_current_schema.sql",
];

/**
 * Documents under docs/ that describe the product as it is: they follow the
 * code. The other documents there are records (plans, refactors, handoffs,
 * evidence, brand work) and keep the names of their time.
 */
const LIVING_DOCUMENTS = [
  /^docs\/(?:architecture|deployment|integrations|reference|runbooks|specs)\//,
  /^docs\/(?:layers|commerce-monorepo|commerce-domain-architecture|code-style|organisation-setup-flow|portal-ui-inventory|style-guide|workflow-canvas-design-profile|economics-costs|blocked-deferred-tasks)\.md$/,
];

/** Paths that keep their text and their names. */
const EXCLUDED_PATHS = [
  // Plans, evidence, handoffs and the other records keep the names of their
  // time. AGENTS.md is edited by hand: its glossary maps the old names.
  /^docs\//,
  /(^|\/)plan[^/]*\.md$/,
  /^AGENTS\.md$/,
  /(^|\/)evidence\//,
  /^output\//,
  /^assets\//,
  // The applied D1 patch scripts are records of the old databases.
  /(^|\/)migrations[^/]*\//,
  /\.sql$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  // The earlier rename passes, and this one.
  /^scripts\/rename\//,
  // Pinned Kitchen physics bundles and the native source that they hash: a
  // saved run names its bundle by hash. The bundles hold the old build path.
  /^apps\/portal\/public\/bakery-physics\//,
  /^crates\/bakery-native\/(?!README\.md$)/,
  // The names of the files in R2 and the scripts that build those files: a
  // model or a mesh keeps the name that its recorded output has. The
  // manifest's bucket changes: renameManifest below.
  /^repo-binaries\.json$/,
  // The known broken links: renameRatchet below handles them.
  /^scripts\/doc-links-ratchet\.json$/,
  /^scripts\/bakery-mujoco\//,
];

const isExcluded = (file) =>
  !BASELINES.includes(file) &&
  !LIVING_DOCUMENTS.some((pattern) => pattern.test(file)) &&
  (file === SELF || EXCLUDED_PATHS.some((pattern) => pattern.test(file)));

/**
 * Text that keeps its old name: names of things outside this repository, and
 * the wake phrase. Each match is masked before the rules run.
 */
const PROTECTED = [
  // The wake phrase stays "Hey Satyr" until a "Hey Sous Chef" wake model
  // passes (AGENTS.md). Its model and training files keep the name.
  /\b[Hh]ey,? Satyr\b/g,
  /\bhey[_-]satyr\b/gi,
  // The archived repository and the old local clone.
  /\bseams-tech\/satyr\b/g,
  /\blowerarchy\/satyr\b/g,
  // The Google Cloud project, topic and service account of the Gmail push
  // channel. A project id cannot change; step 4 changes only the push
  // endpoint of the subscription.
  /\bsatyr-gmail-(?:dev|push)\b/g,
  // The browser folder of the physics results. The pinned execution bundle
  // holds the name, so it changes with the next bundle build.
  /"satyr-physics-results"/g,
  // The file names of plans and refactors, which keep their names.
  /\b(?:plan|refactor)-[0-9]+[A-Za-z]?-[\w-]+\.md\b/g,
];

/** Voice code writes about the spoken word "Satyr" of the wake phrase. It keeps the word. */
const SPOKEN_WORD_PATHS = [
  /^services\/platform\/src\/voice\/vocabulary\.ts$/,
  /^services\/platform\/tests\/e2e\/voice-control\.test\.ts$/,
  /^services\/shop-voice\/shop_voice\/speech\.py$/,
  /^scripts\/shop-voice\/(?:confidence|phrase)-bench\.py$/,
  /^scripts\/plan-82-g04\//,
];

/**
 * Rules for names that the generic word rules would get wrong. They run in
 * order, before the generic rules.
 */
const SPECIFIC_RULES = [
  // Public addresses: the new stack serves only custom domains on purin.io.
  [/\bsatyr-edge\.n6378056\.workers\.dev\b/g, "pantry.purin.io"],
  [/\bunderclerk\.n6378056\.workers\.dev\b/g, "commerce.pantry.purin.io"],
  [/\bsatyr-slack-ingress\.n6378056\.workers\.dev\b/g, "slack.pantry.purin.io"],
  [/\bsatyr-docs\.n6378056\.workers\.dev\b/g, "docs.pantry.purin.io"],

  // Deployed names that do not follow the word rule (the Plan 93 tables).
  [/\bsatyr-edge-workspaceexecutorcontainer\b/g, "pantry-workspace-executor"],
  [/\bsatyr-edge-messagelinkfetchcontainer\b/g, "pantry-message-link-fetch"],
  [
    /\bsatyr-edge-customconnectorfetchcontainer\b/g,
    "pantry-custom-connector-fetch",
  ],
  [/\bsatyr-chatgpt-exit-container\b/g, "pantry-chatgpt-exit"],
  [/\bsatyr-edge(?![\w.])/g, "pantry"],
  [/\bsatyr-code-mode-sandbox\b/g, "pantry-code-sandbox"],
  [/\bsatyr-global-tokyo\b/g, "pantry-global-apac"],
  [/\bunderclerk-apac\b/g, "pantry-commerce-apac"],
  [/\bseams-shop\b/g, "purin-shop"],
  [/\bdata-encryption-root-v1(?![\w-])/g, "pantry-data-encryption-root"],
  [/\bvault-root-v1(?![\w-])/g, "pantry-vault-root"],
  // The commerce Worker: a Worker name, a service binding or a launcher name.
  [
    /("(?:name|service|script_name)"\s*:\s*")underclerk(")/g,
    "$1pantry-commerce$2",
  ],
  [/(readWorkerEnvironment\()"underclerk"/g, '$1"commerce"'],

  // Package scope: the Platform packages are @purin-labs/* since Plan 94.
  [/@satyr\//g, "@purin-labs/"],

  // The built-in commerce: provider id, code name and display name.
  [/\bSatyr Commerce\b/g, "Seams Checkout"],
  [/satyr_commerce/g, "builtin_commerce"],
  [/SATYR_COMMERCE/g, "BUILTIN_COMMERCE"],
  [/SatyrCommerce/g, "BuiltInCommerce"],
  [/satyrCommerce/g, "builtInCommerce"],
  [/satyr-commerce/g, "builtin-commerce"],

  // Display names of the brand (AGENTS.md, "Old and new names").
  [/\bSatyr(?:'s)? (?:Kitchen|BakeryOS)\b/g, "Kitchen"],
  [/\bSatyr Vault\b/g, "Seams Vault"],
  [/\bSatyr Agents\b/g, "Seams Pantry"],
  [/\bJev from Satyr\b/g, "Jev from Seams"],
  // The company pays for the platform route.
  [/\bSatyr-funded\b/g, "Seams-funded"],

  // Cookies: the session, CSRF, OIDC state and approval cookies.
  [/satyr_control_/g, "pantry_"],

  // The launchd labels of the shop Mac.
  [/\bsh\.seams\.satyr\b/g, "io.purin.pantry"],

  // Area values of the Portal switcher and of each surface.
  [/(["'`])BakeryOS\1/g, "$1kitchen$1"],
  [/(["'`])CafeOS\1/g, "$1cafe$1"],
  [/(["'`])AgentCommerce\1/g, "$1commerce$1"],
  [/^(\s*)BakeryOS(\??:)/gm, "$1kitchen$2"],
  [/^(\s*)CafeOS(\??:)/gm, "$1cafe$2"],
  [/^(\s*)AgentCommerce(\??:)/gm, "$1commerce$2"],
  [/\bBakeryOS\b/g, "Kitchen"],
  [/\bCafeOS\b/g, "Café"],
  [/\bAgentCommerce\b/g, "Commerce"],
];

/** The word rules. Each case keeps its case. */
const WORD_RULES = [
  [/SATYR/g, "PANTRY"],
  [/Satyr/g, "Pantry"],
  [/satyr/g, "pantry"],
  [/UNDERCLERK/g, "COMMERCE"],
  [/Underclerk/g, "Commerce"],
  [/underclerk/g, "commerce"],
];

/** A word that the word rules doubled: "UnderclerkCommerce" is "Commerce". */
const DOUBLE_RULES = [
  [/(?<![A-Za-z0-9])(commerce)[_-]commerce(?![A-Za-z0-9])/g, "$1"],
  [/\bCommerceCommerce/g, "Commerce"],
  [/\bcommerceCommerce/g, "commerce"],
  [/\bCOMMERCE_COMMERCE/g, "COMMERCE"],
  [/(?<![A-Za-z0-9])(pantry)[_-]pantry(?![A-Za-z0-9])/g, "$1"],
  [/\bPantryPantry/g, "Pantry"],
  [/\bpantryPantry/g, "pantry"],
  [/\bPANTRY_PANTRY/g, "PANTRY"],
  [/\b([Cc])ommerce commerce\b/g, "$1ommerce"],
  // "an Underclerk" was right; "an Commerce" is not.
  [/\b([Aa])n (Commerce|commerce)\b/g, "$1 $2"],
];

/** Files that change their name, and files that go. */
const FILE_RULES = [
  // The goat mark stays the Pantry mark until the brand switch; it gets the
  // Pantry name. The horn marks have no reader.
  [/^(apps\/(?:portal|docs)(?:\/src)?\/public\/brand\/)satyr-mark/, "$1pantry-mark"],
];
const DELETED_FILES = [/^apps\/portal\/public\/brand\/satyr-horn-mark-/];

const OLD_NAME = /satyr|underclerk|BakeryOS|CafeOS|AgentCommerce|seams-shop|sh\.seams\.|data-encryption-root-v1|vault-root-v1/i;

function mask(text) {
  const kept = [];
  const masked = PROTECTED.reduce(
    (current, pattern) =>
      current.replace(pattern, (match) => {
        kept.push(match);
        return `\u0000${kept.length - 1}\u0000`;
      }),
    text,
  );
  return {
    masked,
    unmask: (value) =>
      value.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)]),
  };
}

export function renameText(text, file = "") {
  const { masked, unmask } = mask(text);
  let next = masked;
  for (const [pattern, replacement] of SPECIFIC_RULES)
    next = next.replace(pattern, replacement);
  const spoken = SPOKEN_WORD_PATHS.some((pattern) => pattern.test(file));
  for (const [pattern, replacement] of WORD_RULES) {
    if (spoken && replacement === "Pantry")
      next = next.replace(/Satyr(?=[A-Za-z_])/g, "Pantry");
    else next = next.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of DOUBLE_RULES)
    next = next.replace(pattern, replacement);
  return unmask(next);
}

const RATCHET = "scripts/doc-links-ratchet.json";
const MANIFEST = "repo-binaries.json";

/** The manifest of the large files names its bucket; the files keep their paths. */
function renameManifest(text) {
  return text.replace(
    /^(  "bucket": ")satyr-repo-binaries-apac(",)$/m,
    "$1pantry-repo-binaries-apac$2",
  );
}

/**
 * The known broken links, as "<source> -> <target>": a link of a living
 * document follows its renamed target, and a record's link keeps its old one.
 */
function renameRatchet(text) {
  const entries = Object.entries(JSON.parse(text)).map(([key, count]) => {
    const [source, target] = key.split(" -> ");
    return [
      isExcluded(source) ? key : `${source} -> ${renameText(target)}`,
      count,
    ];
  });
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

function renamePath(file) {
  for (const [pattern, replacement] of FILE_RULES)
    if (pattern.test(file)) return file.replace(pattern, replacement);
  return file;
}

const files = trackedFiles();

if (COLLISIONS) {
  reportCollisions();
  process.exit(0);
}

const changes = [];
const moves = [];
const deletions = [];
for (const file of files) {
  if (DELETED_FILES.some((pattern) => pattern.test(file))) {
    deletions.push(file);
    continue;
  }
  const target = renamePath(file);
  if (target !== file) moves.push([file, target]);
  const special =
    file === RATCHET ? renameRatchet : file === MANIFEST ? renameManifest : null;
  if (isBinary(file) || (isExcluded(file) && special === null)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("\u0000") || !OLD_NAME.test(text)) continue;
  const rewritten =
    special === null ? renameText(text, file) : special(text);
  if (rewritten === text) continue;
  const before = text.split("\n");
  const after = rewritten.split("\n");
  changes.push({
    file,
    text: rewritten,
    lines: before.filter((line, index) => line !== after[index]).length,
  });
}

console.log(
  `Plan 93 cutover ${WRITE ? "write" : "dry run"}: ${changes.length} files, ${changes.reduce((sum, change) => sum + change.lines, 0)} lines; ${moves.length} moves; ${deletions.length} deletions`,
);
if (WRITE) {
  for (const change of changes) fs.writeFileSync(change.file, change.text);
  for (const [from, to] of moves) execFileSync("git", ["mv", from, to]);
  if (deletions.length > 0) execFileSync("git", ["rm", "-q", ...deletions]);
  // Generated pages: the new names change the width of the spec's route
  // tables and the order of the table lists on the layers page.
  for (const command of [
    ["scripts/check-commerce-spec.mjs", "--write"],
    ["scripts/check-layers.mjs", "--areas", "--write"],
  ])
    execFileSync(process.execPath, command, { stdio: "inherit" });
  waiveBaselineChanges();
} else {
  for (const change of changes)
    console.log(`  ${change.lines}\t${change.file}`);
  for (const [from, to] of moves) console.log(`  move\t${from} -> ${to}`);
  for (const file of deletions) console.log(`  delete\t${file}`);
}

/**
 * The new databases load the baselines fresh, and no deployed database ever
 * takes the renamed objects. So each changed object gets a waiver instead of
 * a patch script (`pnpm lint:d1-patch`).
 */
function waiveBaselineChanges() {
  const check = spawnSync(
    process.execPath,
    ["scripts/check-d1-patch.mjs", "--base", "HEAD"],
    { encoding: "utf8" },
  );
  const objects = [
    ...check.stderr.matchAll(
      /^\s+(?:adds|alters|removes) (?:table|index|trigger) (\S+)/gm,
    ),
  ].map((match) => match[1]);
  if (objects.length === 0) return;
  fs.appendFileSync(
    "services/platform/scripts/d1-patch-waivers.txt",
    objects
      .map(
        (object) =>
          `${object}: Plan 93 renames it for the new stack, whose databases load the baseline fresh\n`,
      )
      .join(""),
  );
  console.log(`waived ${objects.length} baseline changes for the new stack`);
}

/**
 * Each new name that the tree already holds with another meaning. Two names
 * that become one can merge two meanings: read each pair before a write.
 */
function reportCollisions() {
  const TOKEN = /[A-Za-z0-9_$][A-Za-z0-9_$.:\/-]*[A-Za-z0-9_$]|[A-Za-z0-9_$]/g;
  const existing = new Map();
  const old = new Map();
  for (const file of files) {
    if (isBinary(file) || isExcluded(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\u0000")) continue;
    for (const token of text.match(TOKEN) ?? []) {
      for (const part of new Set([token, ...token.split(/[.:\/]/)])) {
        if (part.length === 0) continue;
        const target = OLD_NAME.test(part) ? old : existing;
        if (!target.has(part)) target.set(part, new Set());
        target.get(part).add(file);
      }
    }
  }
  const found = [];
  for (const [token, where] of old) {
    const renamed = renameText(token);
    if (renamed !== token && existing.has(renamed))
      found.push({
        token,
        renamed,
        oldFiles: [...where].slice(0, 3),
        newFiles: [...existing.get(renamed)].slice(0, 3),
      });
  }
  found.sort((left, right) => left.renamed.localeCompare(right.renamed));
  console.log(`${found.length} new names exist already:`);
  for (const item of found)
    console.log(
      `  ${item.token} -> ${item.renamed}\n    old: ${item.oldFiles.join(", ")}\n    new: ${item.newFiles.join(", ")}`,
    );
}
