// Plan 91 phase 1: the old and new code names, and the names that must stay.
// Each list here is data for plan-91-codemod.mjs. See
// docs/plan-91-seams-atelier-rename.md, sections "Four layers of a name" and
// "System names".

/** Package names. A subpath (`@satyr/contracts/media`) keeps its subpath. */
export const PACKAGE_RENAMES = new Map([
  // The two Satyr aliases merge into the packages they re-export.
  ["@satyr/std", "@seams/std"],
  ["@satyr/type-utils", "@seams/type-utils"],
  ["@lowerarchy/std", "@seams/std"],
  ["@lowerarchy/type-utils", "@seams/type-utils"],
  ["@lowerarchy/async-control", "@seams/async-control"],
  ["@lowerarchy/punter", "@seams/punter"],
  ["@satyr/bakery-model", "@seams/bakery-model"],
  ["@satyr/bakery-workflow", "@seams/bakery-workflow"],
  ["@satyr/collaboration", "@seams/collaboration"],
  ["@satyr/contracts", "@seams/contracts"],
  ["@satyr/control-api", "@seams/control-api"],
  ["@satyr/costs-sheet-crdt", "@seams/costs-sheet-crdt"],
  ["@satyr/email-draft-crdt", "@seams/email-draft-crdt"],
  ["@satyr/mail-reply-crdt", "@seams/mail-reply-crdt"],
  ["@satyr/menu-board-crdt", "@seams/menu-board-crdt"],
  ["@satyr/menu-draft-crdt", "@seams/menu-draft-crdt"],
  ["@satyr/product-description-crdt", "@seams/product-description-crdt"],
  ["@satyr/production-plan-crdt", "@seams/production-plan-crdt"],
  ["@satyr/production-simulation", "@seams/production-simulation"],
  ["@satyr/workflow-canvas-crdt", "@seams/workflow-canvas-crdt"],
  ["@underclerk/contracts", "@seams/commerce-contracts"],
  ["@underclerk/client", "@seams/commerce-client"],
  ["@underclerk/storefront", "@seams/storefront"],
  ["@underclerk/commerce-query-sqlite", "@seams/commerce-query-sqlite"],
  ["@underclerk/worker", "@seams/commerce-worker"],
]);

/**
 * Unscoped package names. Each one is also a Worker name or a word in prose,
 * so the codemod changes it only in a package.json `name`, a dependency key
 * and a `pnpm --filter` argument.
 */
export const UNSCOPED_PACKAGE_RENAMES = new Map([
  ["satyr-edge", "@seams/platform"],
  ["satyr-portal", "@seams/portal"],
  ["satyr-docs", "@seams/docs"],
  ["satyr-plan50-experiment", "@seams/plan50-experiment"],
  ["satyr", "seams-pantry"],
]);

/** Folders that move. A deleted folder maps to null. */
export const DIRECTORY_RENAMES = new Map([
  ["services/underclerk", "services/commerce"],
  ["packages/underclerk-contracts", "packages/commerce-contracts"],
  ["packages/underclerk-commerce-client", "packages/commerce-client"],
  ["packages/satyr-std", null],
  ["packages/satyr-type-utils", null],
]);

/** Paths that the codemod never reads or moves. */
export const EXCLUDED_PATHS = [
  /^docs\//,
  /^assets\//,
  /^output\//,
  /(^|\/)evidence\//,
  // Recorded fixture data; fixture modules (.ts) are code and change.
  /(^|\/)fixtures?\/.*\.(json|jsonl|txt|md|html|csv|eml|ya?ml|sql|ndjson)$/,
  /(^|\/)__snapshots__\//,
  /(^|\/)migrations[^/]*\//,
  /^apps\/portal\/public\/brand\//,
  /^apps\/docs\/src\/public\/brand\//,
  /^scripts\/rename\//,
  // The legacy Python tool SDK: about 40 Python tools import `satyr_sdk`.
  // It is not part of the product; a later cleanup can delete or rename it.
  /^satyr_sdk\//,
  // The physics bundle pins a hash of the bakery-native controller sources
  // (scripts/check-physics-bundle.mjs). A changed comment would need a new
  // engine bundle, so these files keep their text until the next rebuild.
  /^crates\/bakery-native\//,
  /^tools\//,
  /\.sql$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /\.generated\.[a-z]+$/,
];

/** Markdown outside docs/: the codemod changes names of packages, paths, lints and code spans. */
export const MARKDOWN_PATHS = [/\.md$/];

/**
 * Developer docs next to the code: their prose also changes, so that
 * "Underclerk" reads "Commerce" and "Satyr" reads "Pantry". AGENTS.md and the
 * root README keep their prose: the display pass and the glossary own them.
 */
export const DEVELOPER_PROSE_PATHS = [/^services\/underclerk\//, /^packages\/[^/]+\/README\.md$/, /^services\/[^/]+\/README\.md$/, /^scripts\/[^/]+\/README\.md$/];

/**
 * Identifier words, in the order the codemod applies them. Each rule matches a
 * whole word inside a camelCase, PascalCase or SCREAMING_CASE identifier.
 */
export const IDENTIFIER_WORDS = [
  { from: "Underclerk", to: "Commerce" },
  { from: "Urk", to: "MerchantAgent" },
  { from: "Satyr", to: "Pantry" },
  { from: "BakeryOS", to: "Kitchen", alsoFrom: ["BakeryOs"] },
  { from: "CafeOS", to: "Cafe", alsoFrom: ["CafeOs"] },
  { from: "AgentCommerce", to: "Commerce" },
];

/** Words in file and folder names (kebab or snake case). */
export const PATH_WORDS = [
  { from: "underclerk", to: "commerce" },
  { from: "urk", to: "merchant-agent", snake: "merchant_agent" },
  { from: "satyr", to: "pantry" },
];

/**
 * Names that a Worker, a Durable Object binding, an entrypoint or stored data
 * refer to by text. The codemod never changes them.
 */
export const PROTECTED_IDENTIFIERS = new Set([
  "UnderclerkMerchantDO",
  "UnderclerkShopNameDO",
  "SatyrAccountPlatform",
]);

/**
 * Text that stays in every file: deployed names, hosts, env names, headers,
 * storage keys, cookies, wire values and links to the docs folder. The codemod
 * masks each match before it rewrites a comment, a Markdown line or a path.
 */
export const PROTECTED_TEXT = [
  /https?:\/\/[^\s"'`)<>]+/g,
  /[A-Za-z0-9.-]*satyr[A-Za-z0-9.-]*\.(?:dev|com|sh|tokyo|io|test|example)\b/g,
  /\bsh\.seams\.satyr[\w.-]*/g,
  /\bsatyr-(?:edge|model-exit|chatgpt-exit|vault-onepassword|code-mode-sandbox|slack-ingress|repo-binaries|shop-|plan|docs\b|voice-|e2e)[\w-]*/g,
  /\bunderclerk(?:-staging|-local|-migration-rehearsal)?\b(?=[`'"]?\s*(?:Worker|worker|script))/g,
  /\bSATYR_[A-Z0-9_]+\b/g,
  /\bUNDERCLERK_[A-Z0-9_]+\b/g,
  // Markers that scripts/check-underclerk-spec.mjs finds in the spec.
  /underclerk-spec:[a-z]+:(?:start|end)/g,
  // Generated validator names from the contract build.
  /\bvalidate_underclerk_\w+/g,
  /\bU0SATYRBOT\b/g,
  /\bhey_satyr[\w.]*/g,
  /\.satyr-voice\b/g,
  /\/Users\/[^\s"'`)]+/g,
  /\bx-satyr-[a-z-]+/gi,
  /\bsatyr_[a-z_]+/g,
  /\bsatyr:[\w:*-]*/g,
  // Event and command kinds, such as underclerk.create-location.v1.
  /\bunderclerk\.[a-z_.-]+\.v\d+\b/g,
  // Route paths and their parameters, such as /v1/.../:satyrLocationId.
  /\/v\d+\/[^\s`|"')]+/g,
  /\bUnderclerk(?:Merchant|ShopName)DO\b/g,
  /\bSatyrAccountPlatform\b/g,
  /(?:docs\/)?plan-\d+[A-Za-z]?-[\w-]*\.md/g,
  /\brefactor-\d+\.md/g,
  /\/brand\/satyr-[\w.-]+/g,
  /\bsatyr-(?:horn-)?mark-(?:dark|light)-\d+\.png\b/g,
];

/** `pnpm` lint names that move with their scripts. */
export const LINT_RENAMES = new Map([["lint:underclerk-spec", "lint:commerce-spec"]]);
