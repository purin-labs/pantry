# Plan 93 — Clean cutover to new Workers and infrastructure

Status: 22 November 2026. Steps 0 to 2 are done; step 2 landed on dev after
a short freeze. Step 3 is in progress (see "Step 3 results"). Steps 4 to 7
are open.

Change on 21 November 2026 ([Plan 95](plan-95-pantry-own-accounts.md) step
4): Pantry no longer binds the Console. The new stack has no
`ACCOUNT_PLATFORM` binding and no `ACCOUNT_PLATFORM_*` value, a sign-up makes
the organisation in Pantry, and the Console records of the old organisations
are Refactor 260 work. The Console items below are history.

- The owner asked for a Worker rename ("Plan a Worker rename").
- Then the owner chose a clean cutover with the brand rename: "don't worry
  about legacy support or backwards compatibility, this will be a clean
  cutover (with the rename)". And: "It's an opportunity to clean out stale
  workers, and stale infra".
- The first draft (`c677c79`) planned an in-place rename or a Durable Object
  transfer. A clean cutover needs neither, so this version replaces it.

Owner: the deploy procedure and the Cloudflare account.
Touches: [Plan 91 — names](plan-91-seams-atelier-rename.md) (its rules for
the deployed and wire layers end here),
[Plan 80 — multi-tenant Underclerk](plan-80-underclerk-multi-tenant-backend.md),
the AGENTS.md sections "Old and new names", "Active runtime" and
"Deployment", the Console in seams-monorepo, and the shop Mac.

## Goal

Pantry moves in one cutover to a new Cloudflare stack. Each Worker, database,
bucket, queue, KV namespace, container and secret gets a Purin-era name. The
stack serves only custom domains on `purin.io`. Then the old stack and all
stale resources are deleted.

There is no legacy support:

- No redirect from an old address.
- No code that accepts an old cookie, header, event kind or provider id.
- No data move and no adapter for old stored values.
- No `SATYR_*` fallback, no old-name glossary row for a deployed or wire name.

## The approach: a new stack beside the old one

1. Build the new stack with new names and new, empty storage.
2. Test it end to end on its custom domains, while the old stack still runs.
3. Point the providers, the Console and the shop Mac at the new stack.
4. Delete the old stack and the stale resources.

This needs no in-place rename, no Durable Object transfer and no copy of a
secret. The Cloudflare questions of the first draft (what a rename keeps,
containers in a transfer) do not matter any more.

**What the cutover deletes.** The owner said on 8 October 2026: "production
is actually just test accounts for now". The cutover deletes all of it:

- The organisation "Satyr workspace" (the only live organisation since the
  regional cutover; an earlier draft named "Nuki Inc.") and every record in
  it: chats, Cases, drafts,
  products, recipes, workflows, orders, gift cards, devices, saved runs and
  Brain records.
- Each provider connection: the Slack install, Square, Stripe, Shopify,
  Gmail, Google Drive, Airtable, Notion and Dropbox.
- The Underclerk merchants and the catalog of `shop.seams.tokyo`.
- The objects in `satyr-archive-apac` and every sign-in.

After the cutover, the owner makes a new organisation and connects each
provider again. The owner confirmed this list on 21 November 2026 (decision 1).

## Facts (dev `c677c79` and the Cloudflare account, 19 November 2026)

I read the account with Wrangler: `d1 list`, `d1 info`, `r2 bucket list`,
`kv namespace list`, `queues list`, `containers list` and
`deployments list --name`. Wrangler cannot list all Workers, and the API
listing was not allowed in this session. So the Worker list below has only
the names that the repositories know (see "Open item").

### The Pantry production stack and its new names

| Old Worker | Last deploy | New Worker | Public address |
|---|---|---|---|
| `satyr-edge` | 18 Nov | `pantry` | `pantry.purin.io` |
| `underclerk` | 15 Nov | `pantry-commerce` | `commerce.pantry.purin.io` (API and MCP) |
| `satyr-slack-ingress` | 18 Nov | `pantry-slack-ingress` | `slack.pantry.purin.io` |
| `satyr-model-exit` | 18 Nov | `pantry-model-exit` | none |
| `satyr-chatgpt-exit` | 18 Nov | `pantry-chatgpt-exit` | none |
| `satyr-vault-onepassword` | 18 Nov | `pantry-vault-onepassword` | none |
| `satyr-code-mode-sandbox` | 18 Nov | `pantry-code-sandbox` | none |
| `satyr-docs` | 3 Sep | `pantry-docs` | `docs.pantry.purin.io` |
| `seams-shop` | 5 Nov | `purin-shop` | the shop domain of the brand plan |

Each new Worker has `workers_dev: false`, so it has one address only.

| Old resource | New resource |
|---|---|
| D1 `satyr-global-tokyo`, `satyr-organisation-apac` | `pantry-global-apac`, `pantry-organisation-apac` |
| R2 `satyr-archive-apac`, `underclerk-apac` | `pantry-archive-apac`, `pantry-commerce-apac` |
| R2 `satyr-repo-binaries-apac` (CI and build files) | `pantry-repo-binaries-apac`. Copy its files: they are build input, not tenant data. Make a new read-only R2 token for CI |
| KV `POLICY_KV` | `pantry-policy` |
| Queues `satyr-events`, `satyr-cues`, `satyr-event-dlq`, `satyr-cue-dlq` | `pantry-events`, `pantry-cues`, `pantry-event-dlq`, `pantry-cue-dlq` |
| Containers `satyr-edge-workspaceexecutorcontainer`, `-messagelinkfetchcontainer`, `-customconnectorfetchcontainer`, `satyr-chatgpt-exit-container` | `pantry-workspace-executor`, `pantry-message-link-fetch`, `pantry-custom-connector-fetch`, `pantry-chatgpt-exit` |
| Secrets Store `data-encryption-root-v1`, `vault-root-v1`, `vault-root-v2` | `pantry-data-encryption-root`, `pantry-vault-root`. One vault root: no old data needs `v1` |
| Durable Object classes `UnderclerkMerchantDO`, `UnderclerkShopNameDO` | `CommerceMerchantDO`, `CommerceShopNameDO`. The `exports` of each new Worker start with only `created` entries. The three `CodexHarness` tombstones go |

### Names in the code and on the wire

There is no stored data to keep, so these change without a reader for the
old value. Counts are lines outside the docs, on dev `c677c79`.

| Old name | Lines | New name |
|---|---|---|
| `satyr` (any case) | 2,859 in 857 files | `pantry` |
| `underclerk` (any case) | 3,693 in 579 files | `commerce` |
| Event kinds `underclerk.*.v1` | 1,287 | `commerce.*.v1` |
| `UNDERCLERK_*` variables and secrets | 1,066 | `COMMERCE_*` |
| `SATYR_*` variables | 817 | `PANTRY_*` |
| Provider id `satyr_commerce` | 194 | `builtin_commerce` |
| Area values `"BakeryOS"`, `"CafeOS"`, `"AgentCommerce"` | 146 | `"kitchen"`, `"cafe"`, `"commerce"` |
| Headers `x-satyr-*` | 172 | `x-pantry-*` |
| Cookie `satyr_control_session` and `satyr:*` storage keys | 152 | `pantry_session`, `pantry:*` |
| launchd label `sh.seams.satyr.*`, folder `~/.satyr-voice` | — | `io.purin.pantry.*`, `~/.pantry-voice` |
| Console service id `satyr` (seams-monorepo) | part of 888 lines | `pantry` |

The two D1 baselines stay one file each
(`migrations-global/0001_current_schema.sql`,
`migrations-regional/0001_current_schema.sql`). The new databases load them
fresh, so a table or column with an old name can change too.

### Legacy names on dev (`3371386`, 19 November 2026)

The word `satyr` was on 2,704 lines in 853 files outside `docs/` and the
Markdown files. Plan 92 already removed the unused and duplicate code, so
these are names, not dead code. They fall into two groups.

**Group A: names that no deployed Worker, stored row, signed value or
other repository knows.** Done on 19 November 2026, with
`scripts/rename/plan-93-test-names.mjs`: 330 lines in 172 files.

| Kind | Old | New |
|---|---|---|
| Reserved test hosts | `satyr.example`, `satyr.test`, `satyr-test.myshopify.com`, `e2e-satyr` | `pantry.example`, `pantry.test`, `pantry-test.myshopify.com`, `e2e-pantry` |
| Slack fixture user ids | `U0SATYR`, `U0BGSATYR` | `U0PANTRY`, `U0BGPANTRY` |
| Fixture location ids | `satyr_location_1` and three more | `pantry_location_1` |
| Phrases | "Satyr Kitchen", "Satyr Worker" | "Kitchen", "Pantry Worker" |
| The word "Satyr" in code comments | "Satyr" | "Pantry" |

The first estimate for group A was about 1,100 lines. A check of each of the
678 distinct names showed that most of the rest are not safe now:

- An identifier such as `satyrLocationId` is a field of a stored record and
  of the contract between the Platform and Underclerk.
- A value such as `satyr_email_body_v1` or `satyr_harness_history_chain_v1`
  is the domain of a stored hash.
- A name such as `SatyrProvisionEnvelopeV1` or `shared-account-satyr-e2e`
  is also in seams-monorepo (the Console).
- A GraphQL operation name such as `SatyrOrderCancel` goes to Shopify.
- The brand files `satyr-mark-*` are public URLs of the Worker.
- "Satyr Commerce", "Satyr Vault" and the wake phrase "Hey Satyr" wait for
  the brand names and for a new wake model.

**Group B: all other names (2,356 lines in 745 files after group A).** A
change breaks the data and the sessions of the stack that runs today, or it
needs a change in another repository. They change in step 2, for the new
stack:

| Kind | Examples | Lines |
|---|---|---|
| Cookie, CSRF and headers | `satyr_control_session`, `satyr_control_csrf`, `x-satyr-csrf`, `x-satyr-configuration-version` | about 430 |
| Provider and platform ids | `satyr_commerce`, `satyr_platform`, `shared_satyr_app` | about 370 |
| Contract fields, event kinds and hash domains | `satyrLocationId`, `satyr_location_id`, `satyr.checkout.*`, `satyr.counter-sale.v1`, `urn:satyr` | about 450 |
| Deployed names | Workers, queues, D1 and R2 names | 148 |
| Shop Mac | `sh.seams.satyr.*`, `~/.satyr-voice`, `hey_satyr` | 55 |
| `SATYR_*` constants | `SATYR_COMMERCE`, `SATYR_ECOMMERCE_FIXTURE_TIMESTAMP` | 63 |
| Identifiers, test harness names, brand files and display text | `SatyrProvisionEnvelopeV1`, `satyr-plan40-browser`, `satyr-mark-dark-64.png`, "Satyr Commerce" | the rest |

Not changed by any codemod: the pinned Kitchen physics bundles under
`apps/portal/public/bakery-physics` hold the build path
`/Users/pta/Dev/lowerarchy/satyr`. A saved run names its bundle by hash, so
the files stay as they are.

Found on the way: `scripts/production-simulation/verify-factory-overview-browser.js`
(in the journey index) reads
`/Users/pta/Dev/lowerarchy/satyr/output/acceptance/plan-70/j2-recurring-campaign-2026-10-11-r2`.
That folder does not exist on this machine, so the journey cannot pass.
Plan 92 deleted the journey on 19 November 2026: two-cell-workspace-browser
and recurring-logistics prove its outcome.

### Stale Pantry resources (delete them)

| Resource | Why it is stale |
|---|---|
| Staging Workers `satyr-edge-staging` (last deploy 16 Oct), `underclerk-staging` (14 Oct), `satyr-code-mode-sandbox-staging` (16 Oct) | Nobody deployed them for a month. The staging config binds `satyr-model-exit-staging`, `satyr-chatgpt-exit-staging` and `satyr-vault-onepassword-staging`, and those Workers do not exist. So staging cannot run a model call |
| Staging D1 `satyr-staging-global-apac`, `satyr-staging-organisation-apac` (42 MiB) | The staging crons still run: 3,009 writes and 6,671 reads in 24 hours, for nobody |
| Staging R2 `satyr-staging-archive-apac`, KV `satyr-staging-policy`, queues `satyr-staging-events`, `-cues`, `-event-dlq`, `-cue-dlq` | Part of the staging stack |
| Staging containers `satyr-edge-staging-workspaceexecutorcontainer`, `-customconnectorfetchcontainer`, `-messagelinkfetchcontainer`, `-apaccodexharnesscontainer` | Part of the staging stack. The Codex harness class is deleted |
| Domain `staging.satyr.seams.sh` | Staging address |
| Queues `satyr-thread-files`, `satyr-thread-file-dlq` | No producer. `satyr-edge` is still listed as the consumer, but no Wrangler file names the queue |

No test Worker that the repository names exists any more. I checked 14
names (`satyr-plan42j-brain-acceptance`, `satyr-voice-path-test`,
`satyr-edge-e2e` and the others).

The plan does not rebuild staging. The new production stack is tested on its
own domains before the switch (step 3), and that replaces the rehearsal. A
new staging stack can come later, with Pantry names.

### Stale resources of other projects

These are not Pantry resources. Each one had no query in 24 hours, or its
Worker is gone. Delete each group only after the owner says yes for that
group.

| Group | Resources | Owner repository |
|---|---|---|
| `ml-dsa-sdk-set-1101-77af96` | 4 D1 databases, 2 R2 backup buckets. Its 23 Workers were deleted on 15 Nov | seams-wallet |
| `r150-bench-20260925` and `-20261001` | 10 D1 databases, 4 R2 backup buckets, the Worker `r150-bench-20260925-probe` (deployed 7 Oct) and its 3 probe containers | seams-wallet `tests/r150-hosted` |
| Old Seams databases with no query in 24 h | `seams-console-sin` (empty), `seams-console-staging`, `seams-console-staging-sin`, `seams-console-testnet`, `seams-signer-staging`, `seams-signer-testnet`, `router-ab-deriver-a-testnet-private-tokyo`, `router-ab-deriver-b-testnet-private-nrt`, `router-ab-signing-worker-testnet-private` | seams-monorepo, seams-wallet |
| `hadimar` | D1 `hadimar` (no query in 24 h), R2 `hadimar-media` | `~/Dev/web2/hadima` |
| Buckets with no known owner | R2 `outlayer1`, `w3a-sdk`, `watchbook-analytics` | none of the repositories names them |

Keep `seams-console-sin-candidate-20261014`. Its name says "candidate", but it
is in use (15,570 reads and 1,456 writes in 24 hours). Keep the speak-to-sign
KV namespaces (hackathon).

### Who uses the old addresses

The cutover replaces each of these. Nothing keeps the old value.

- `satyr-edge.n6378056.workers.dev`: the Platform variables
  `PANTRY_PUBLIC_ORIGIN`, `PANTRY_OAUTH_CALLBACK_ORIGIN`,
  and `GMAIL_PUBSUB_AUDIENCE`; the OAuth apps of Slack,
  Google sign-in, Gmail, Google Drive, Square, Stripe Connect and its
  webhook, Shopify (`integrations/shopify/shopify.app.toml`), Airtable,
  Notion, Dropbox and the Meta webhook; the Gmail Pub/Sub push subscription;
  the Console GitHub secrets `PANTRY_ACCOUNT_ASSERTION_ISSUER`,
  `PANTRY_ACCOUNT_ASSERTION_AUDIENCE` and `PANTRY_SERVICE_ORIGIN`
  (seams-monorepo `.github/workflows/deploy-console-backend.yml`); the shop
  Mac `~/.satyr-voice/config.json`.
- `underclerk.n6378056.workers.dev`: `UNDERCLERK_BASE_URL` and the MCP
  address in `services/commerce/docs/mcp.md`.
- `satyr-slack-ingress.n6378056.workers.dev`: the Slack event and
  interaction request URLs.
- `satyr-docs.n6378056.workers.dev`: `VITE_DOCS_ORIGIN` in
  `apps/portal/.env.production`.

### Secrets

The new stack gets new secrets. Wrangler secrets are write-only, so nothing
can copy the old ones, and nothing needs to.

- Secrets that Pantry makes (session secret, service token, signing keys,
  encryption roots): generate new values. Save each one in the git-ignored
  `.env.local.production`, as the owner's rule says.
- Provider client secrets (Slack, Square, Stripe, Shopify, Google, Airtable,
  Notion, Dropbox, Meta): rotate each one in its provider console in step 4.
  The owner gives me the new value, and I set it and save it locally.
- Other keys (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`): new keys, or the
  owner gives the current values.

## Steps

Each step ends with a check. A step does not start before the last one
passes.

### 0. Decisions and gates (no code)

- The hackathon is over, and the brand rename starts.
- `purin.io` is a zone in the Cloudflare account.
- The owner answers "Decisions for the owner", and confirms the list in
  "What the cutover deletes".

### 1. Delete the stale Pantry resources

This step does not wait for the brand rename. It starts after the owner's
yes to decision 3. It stops the staging crons and their cost at once.
Order: remove the queue consumers
(`wrangler queues consumer remove`), delete the staging Workers
(`satyr-edge-staging` before `satyr-code-mode-sandbox-staging`, because it
binds the sandbox class by `script_name`), delete the container applications
(a deleted Worker leaves its application), then the D1 databases, the bucket
(empty it with a temporary Worker, as in the October clean-up), the KV
namespace, the queues and the staging DNS record. Then delete
`satyr-thread-files` and its dead-letter queue.

Remove the `staging` environments from the Wrangler files in the same
change.

#### Step 1 results (19 November 2026)

The owner said "Yes, delete them". I deleted, with Wrangler:

- The consumers of `satyr-staging-events`, `satyr-staging-cues` and
  `satyr-thread-files`.
- The Workers `satyr-edge-staging`, `satyr-code-mode-sandbox-staging` and
  `underclerk-staging`, with their Durable Objects. The custom domain
  `staging.satyr.seams.sh` went with `satyr-edge-staging`: it has no DNS
  answer now.
- The four staging container applications.
- The bucket `satyr-staging-archive-apac` (28 objects, 11.6 kB, emptied
  through a local remote binding, with no deployed Worker), the D1 databases
  `satyr-staging-global-apac` and `satyr-staging-organisation-apac`, the KV
  namespace `satyr-staging-policy`, and the queues `satyr-staging-events`,
  `satyr-staging-cues`, `satyr-staging-event-dlq`, `satyr-staging-cue-dlq`,
  `satyr-thread-files` and `satyr-thread-file-dlq`.

Checks after the deletion: no resource with a staging or thread-file name
is left; the live versions of `satyr-edge`, `underclerk` and
`satyr-slack-ingress` did not change; `satyr-edge` is still the producer and
consumer of `satyr-events` and `satyr-cues`; the Portal answers 200.

The code change removes the `staging` environment from the six Wrangler
files, the two `deploy:staging` scripts, the launcher
(`scripts/worker-environment.mjs`, `scripts/run-worker.mjs`), the isolate
location read, the staging runbook and the environment runbook text. The
launcher now accepts only `local` and `production`.

Left in place: the Secrets Store secrets `satyr-staging-data-encryption-root-v1`
and `satyr-staging-vault-root-v1`. They were not on the approved list. Step 5
deletes them with the other old secrets.

### 2. The code change

One branch, from a freeze of dev:

- A codemod for the names in "Names in the code and on the wire" and for
  group B of "Legacy names on dev", in pantry and in seams-monorepo
  (Console). Group A is done. It also removes code that exists only for
  old names: fallbacks, aliases, the glossary rows and the old-name notes in
  AGENTS.md.
- New Wrangler files: new Worker, storage, container and secret names,
  `workers_dev: false`, custom domain routes, and fresh `exports`.
- A release guard: a deploy refuses a Worker name that is not in the new
  name list. So no deploy can reach an old Worker after the cutover.
- Checks: `pnpm check:packages`, `pnpm test:units`, the Platform E2E suite,
  `pnpm portal:build`, `cargo test --workspace`, and a `git grep` that finds
  `satyr` and `underclerk` only in plans and evidence.

#### Step 2 results (21 November 2026, branch `plan-93`)

**The freeze.** Refactor 17 still landed on dev when step 2 started. The
owner chose a short freeze later: I wrote and tested the codemod as a script
on the branch first. Before the branch lands, dev freezes, the branch
rebases on the newest dev, the codemod runs again and the checks run again.
The freeze lasts about two hours: the rebase and the run take minutes, the
checks other than E2E about 20 minutes, and the full E2E suite about one
hour.

**The Console part is not needed.** Since Plan 95 step 4 (dev `396278ef`)
Pantry names no Console service, binding, package or secret, so the
seams-monorepo codemod of this step goes. The Console's own record of the
old Pantry service is the work of the session "Console Pantry service
removal" and of Refactor 260.

**What the branch holds**, in this order:

1. The new Worker profiles and the release guard (hand-written, new names).
   Each Worker has `workers_dev: false`, `preview_urls: false` and one
   custom domain: `pantry.purin.io`, `commerce.pantry.purin.io`,
   `slack.pantry.purin.io`, `docs.pantry.purin.io` and `shop.purin.io`.
   The D1 and KV ids are the placeholder `made-in-plan-93-step-3`; step 3
   writes the real ids. One vault root (`pantry-vault-root`) and one data
   encryption root. The exports drop the three Codex harness tombstones.
   `scripts/worker-environment.mjs` holds the one table of Worker names
   (`WORKER_NAMES`), which every profile check reads; `run-worker.mjs`, the
   side Worker scripts, the docs site and the shop refuse to deploy any other
   name, a workers.dev or preview address, another route, or a placeholder
   id.
2. The removal of code for old names and old stored states: the agent's
   old-name note, the finished rename passes, the stale package check of
   the standalone commerce journey, and the Plan 92 adapters (see "Adapter
   code with no test").
3. `scripts/rename/plan-93-cutover.mjs` and its run. It renames `satyr` to
   `pantry` and `underclerk` to `commerce` in every case form, with these
   exact rules first: the workers.dev addresses to the purin.io domains;
   `satyr-edge` to `pantry`, `underclerk` (Worker) to `pantry-commerce`,
   `satyr-code-mode-sandbox` to `pantry-code-sandbox`, `seams-shop` to
   `purin-shop`, the containers and storage of the tables above;
   `satyr_commerce` to `builtin_commerce` ("Satyr Commerce" to "Seams
   Checkout"); `satyr_control_*` cookies to `pantry_*` (`pantry_session`,
   `pantry_csrf`); `sh.seams.satyr` to `io.purin.pantry`; the area values
   to `"kitchen"`, `"cafe"` and `"commerce"`; `@satyr/` to `@purin-labs/`.
   It changes code, wire values, the two D1 baselines, the Wrangler files
   and the living documents (READMEs, the commerce spec, runbooks,
   architecture and reference pages, the docs site). Plans, evidence and
   handoffs keep their names. After the run it writes the commerce spec
   tables and the layers page again, and it waives each renamed D1 baseline
   object in `d1-patch-waivers.txt`: no deployed database takes the
   rename. `--collisions` lists each new name that the tree already holds:
   112 pairs on the branch. Each one is a local name, a comment, or a name
   in a document that lagged behind code renamed earlier (the
   `--pantry-*` CSS tokens, package paths, the `x-commerce-signature` that
   the spec already named). None merges two meanings. A renamed key can
   move in the sort order, so the codemod sorts a sorted key list such as
   `"deviceName,integrationAccountId,pantryLocationId,providerLocationId"`
   again; the Square counter journey found that. A zero-padded test id
   keeps its length (a 1Password vault id has 26 characters); the
   1Password journey found that.
4. AGENTS.md: the old-name table maps old names for readers of plans and no
   longer keeps old names in a layer; the runtime, boundary, setup and
   deployment sections name the new stack and the release guard.

**Checks** (22 November 2026, on dev `79462c0f` plus the branch, with the
codemod run). Pass: `check:types` and `check:test-types` of the Platform
(E2E types included), `pnpm check:packages`, the commerce engine type
check, `pnpm lint:static`, `pnpm lint:d1-patch`, `pnpm test:units` (the
Platform suite: 301 files, 1,728 tests), `pnpm portal:build`,
`cargo test --workspace` (47 tests) and `git diff --check`. The release
guard passes for `pantry-commerce`, `pantry-docs`, `purin-shop` and the
four Workers with no route, and refuses `pantry` and
`pantry-slack-ingress` only for the step 3 placeholder ids.

The Platform E2E suite ran in full on the branch before the second adapter
pass and before the last two codemod fixes: 238 of 250 files passed (460 of
484 journeys), 3 were skipped. The 9 failures: the Square counter journey
and the 1Password journey, which found the two codemod faults above, and the
7 cobot files, which need a MuJoCo SDK with its headers. On the final branch
these 9 files, the journeys of the second adapter pass and the counter
journeys ran again: 23 files and 52 journeys, all pass. The cobot files ran
in a checkout outside the main clone: inside it, Cargo takes the main
clone's workspace and cannot build `cobot-controller` (the nested-worktree
trap). They need `MUJOCO_DIR` with the SDK headers.

The `git grep`: 59 lines outside plans and records still say `satyr` or
`underclerk`, and each one is an exception of the next list.

**The freeze run.** When the owner opens the freeze, in the `plan-93`
worktree:

1. `git fetch origin`, then `git rebase origin/dev` without the codemod run
   commit (drop it first: it is the tip, "Plan 93: run the cutover
   codemod"). Resolve a conflict in the hand-written commits by hand.
2. `pnpm install --prefer-offline --frozen-lockfile`, then
   `node scripts/rename/plan-93-cutover.mjs --collisions`. Read each new
   pair against the list above.
3. `node scripts/rename/plan-93-cutover.mjs --write`, then commit every
   change as "Plan 93: run the cutover codemod".
4. Run the checks below again, and the `git grep`.
5. Before the push: step 3.2 copies the large files to
   `pantry-repo-binaries-apac`, because the code now reads that bucket. A
   file that is not in the local cache of a machine needs the new bucket.

**The freeze run (22 November 2026).** The owner opened the freeze at
10:55 JST. Dev was still `79462c0f`, so the rebase was empty, and the
codemod run gave the tested tree again. On the final tree (the codemod run
plus the step 3 id commits) these checks pass: the Platform E2E suite (239
files; the 7 cobot files fail there for MuJoCo only, and pass in a checkout
outside the clone with `MUJOCO_DIR`: 16 journeys; 3 files skip), the
Platform type checks and test types, `pnpm check:packages`, the commerce
engine type check, `pnpm lint:static`, `pnpm lint:d1-patch`,
`pnpm test:units` (Platform: 301 files, 1,728 tests), `pnpm portal:build`,
`cargo test --workspace` (47 tests) and `git diff --check`.

Missed: the freeze checks did not run the commerce engine suite
(`services/commerce`, part of CI). After the push, CI found
`tests/punter-acceptance.test.ts` failing with
`commercial_snapshot_mismatch`: `scripts/punter/src/scenario-fixtures.ts`
pins six quote, carrier, tax, duty and package-plan digests, and the rename
changed text inside those hashes (no price, item or date changed). The
Refactor 17 session made the fix (`2372ad0f`, branch `punter-digests`); the
test passes on it. A later codemod run needs the commerce suite in its
checks.

**What keeps an old name on purpose** (the `git grep` exceptions):

- The wake phrase "Hey Satyr", `hey_satyr.onnx` and the wake training
  scripts, until a "Hey Sous Chef" wake model passes.
- The Google Cloud project `satyr-gmail-dev`, its topic `satyr-gmail-push`
  and its service account: a project id cannot change. Step 4 changes only
  the push endpoint of the subscription.
- The pinned physics bundles, the `crates/bakery-native` source, the R2
  file names of `repo-binaries.json` and `scripts/bakery-mujoco`, and the
  browser folder `satyr-physics-results`: the pinned execution bundle holds
  that name, and a rename would change the bundle's hash. It changes with
  the next bundle build.
- Plan file names and links to them, the applied D1 patch scripts, and the
  records under `docs/` (plans, refactors, handoffs, evidence, brand work).

### 3. Build and test the new stack

1. Make the D1 databases (load the two baselines), the buckets, the KV
   namespace, the queues and the Secrets Store secrets.
2. Copy the files of `satyr-repo-binaries-apac` to
   `pantry-repo-binaries-apac`.
3. Deploy the Workers in binding order: `pantry-code-sandbox`,
   `pantry-model-exit`, `pantry-chatgpt-exit`, `pantry-vault-onepassword`,
   `pantry-commerce`, `pantry`, `pantry-slack-ingress`, `pantry-docs`,
   `purin-shop`.
4. Set the secrets that step 4 does not need.
5. Attach the custom domains.
6. Check: the Portal loads on `pantry.purin.io`, a sign-up makes a new
   organisation in Pantry, the chat answers, and the idle-tenant
   check writes close to nothing in one hour.

#### Step 3 results (22 November 2026)

The owner said "Freeze now" and "Yes, all of step 3" on 22 November 2026,
and chose the OpenRouter key of the local `.env.local` for the new Worker.
Dev had not moved since `79462c0f`, and the codemod run on it gave a tree
equal to the tested one (the same 112 collisions), so the freeze run needed
no new review.

**3.1 Resources.** Made with Wrangler and the account token:

| Resource | Name | Id or note |
|---|---|---|
| D1 (global) | `pantry-global-apac` | `ced3f859-6a2b-4e54-bc8e-92d2dae424fa`, served from NRT |
| D1 (regional) | `pantry-organisation-apac` | `130a94eb-71a6-40a9-991d-b359f36a939a`, served from NRT |
| R2 | `pantry-archive-apac`, `pantry-commerce-apac`, `pantry-repo-binaries-apac` | location hint `apac` |
| KV | `pantry-policy` | `1b538734635b4da481ac9cf7c3315d36` |
| Queues | `pantry-events`, `pantry-cues`, `pantry-event-dlq`, `pantry-cue-dlq` | |
| Secrets Store | `pantry-data-encryption-root`, `pantry-vault-root` | 32 random bytes each, in store `41fe2fa0…` |

The two baselines loaded with `d1 execute --file`, and
`run-worker.mjs platform schema production` reports 50 and 375 objects that
match. A database made with the hint `apac` was served from Singapore,
Seoul or Hong Kong in six tries. A database made from this Mac with no hint
was served from Tokyo or Osaka, so both databases were made again that way
until each query answered from NRT. The profiles name the real ids, and the
release guard's placeholder check went with the placeholder.

The secrets that Pantry makes (session, admin, Slack state, commerce service
token, WhatsApp verify token, buyer session, Ed25519 signing key, carrier
key and the two roots) are new values in the git-ignored
`.env.local.production`, with the prefix `PANTRY_STACK_`. The required
`SQUARE_SANDBOX_DEFAULT_ACCESS_TOKEN` went from the profile: no code reads
it, and a first deploy refuses a missing required secret.

**3.2 Repo binaries.** All 3,574 objects (2.4 GB) of
`satyr-repo-binaries-apac` are in `pantry-repo-binaries-apac`: 3,568 from
the local cache and 6 from the old bucket, each checked against its
`sha256/<hash>` name. A random sample of 20, read back from the new bucket,
matched. The read-only R2 key of CI (`R2_READ_*`) reads only the old bucket
(HEAD answers 403 on the new one). The owner chose to push anyway, so the CI
fetch fails until that key can read `pantry-repo-binaries-apac`.

**Step 2 landed** on dev as `79462c0f..a2086e94` on 22 November 2026, after
the freeze-run checks.

**3.3 to 3.5 The first deploy** (12:00 to 12:07 JST, release commit
`a2086e94`, from a clean worktree at the dev tip). The first deploy of a new
Worker refuses a missing required secret, so the Platform and the commerce
engine took their secrets with `--secrets-file`: the generated values, the
OpenRouter key, and the placeholder `unset-until-plan-93-step-4` for each
provider secret that step 4 sets. Live versions:

| Worker | Version | Address |
|---|---|---|
| `pantry-code-sandbox` | `03b5179f` | none |
| `pantry-model-exit` | `9fdd76fb` | none |
| `pantry-chatgpt-exit` | `71fe480a` | none; container application `pantry-chatgpt-exit` |
| `pantry-vault-onepassword` | `068bf92b` | none |
| `pantry-commerce` | `d4ba7af8` | `commerce.pantry.purin.io` |
| `pantry` | `e73c7cb8` | `pantry.purin.io`; container applications `pantry-message-link-fetch`, `pantry-custom-connector-fetch`, `pantry-workspace-executor` |
| `pantry-slack-ingress` | `db668e42` | `slack.pantry.purin.io` |
| `pantry-docs` | `a977225c` | `docs.pantry.purin.io` |

`purin-shop` is not deployed: its build needs `VITE_SHOP_MERCHANT_ID`, and
the new commerce engine has no merchant until the owner makes the new
organisation. The old Workers kept their live versions, and
`satyr-edge` and `underclerk` still answer `/health`. No new Worker has a
workers.dev address (each answers 404 there).

Checks after the deploy: `https://pantry.purin.io/` (the Portal) and
`/health` answer 200, `https://commerce.pantry.purin.io/health` answers
200, `https://docs.pantry.purin.io/` answers 200, an unsigned post to
`https://slack.pantry.purin.io/slack/events` answers 401, and the Google
sign-in start sends
`redirect_uri=https://pantry.purin.io/v1/control/auth/google/callback`. The
two names under `pantry.purin.io` had no TLS for about five minutes after
the deploy, while Cloudflare issued their certificates. The live versions of
the nine old Workers did not change.

The Plan 91 phase 4 push of the Purin names (dev `7fccf635`) came after the
build, so `pantry` (`787aec6a`) and `pantry-docs` (`8d23a786`) were deployed
again from dev `f6993814`, with the owner's yes. The Portal, `/docs/privacy`
and `/docs/terms` now have the title "Purin Pantry"; Google brand
verification reads these pages.

**3.6 Idle cost.** In the hour 12:10 to 13:10 JST, with no organisation,
the GraphQL Analytics datasets show: `pantry-global-apac` 2 rows written in
one write query (the sign-in state of the start-route check above) and 656
rows read; `pantry-organisation-apac` no row written, 5,237 rows read in 132
queries (the crons); no Durable Object of the 15 new namespaces read or
wrote a row. The sign-up and chat checks of 3.6 wait for the new Google
client.

#### Step 4 results so far (22 November 2026)

**Secrets: reuse, no rotation.** The owner chose to keep the provider
secrets of the same apps, so the old stack works until the switch, and
confirmed it in the Plan 91 phase 4 session ("reuse, no rotation"). New
values come only where a console makes one (the new Google project of Plan
91 phase 4 decision 2, the new Stripe webhook endpoints). Each reused
value was checked where a provider allows it without side effects: Slack
`oauth.v2.access`, the Square token endpoint and the Notion token endpoint
accept the client and refuse only the bad code; for Dropbox only the
`services/platform/.dev.vars.local` value is valid. Set on the new Workers
with `wrangler secret bulk`: the Slack signing and client secrets (`pantry`
and `pantry-slack-ingress`), Square, Shopify, Stripe Connect (test mode),
Airtable, Notion, Dropbox and the WhatsApp app secret (`pantry`), and Square
(`pantry-commerce`). The commerce engine's Stripe keys wait for its new
webhook secret, so that no Stripe payment starts without a webhook.

A signed Slack `url_verification` to
`https://slack.pantry.purin.io/slack/events` returns its challenge, so the
Slack request URLs can switch.

**Stripe webhooks.** With the owner's yes, two new test-mode endpoints were
made by API, with the events and API version of the old ones:
`https://pantry.purin.io/hook/stripe/connect` (Connect, 5 events) and
`https://commerce.pantry.purin.io/v1/providers/stripe/webhooks` (Connect, 8
events). Their ids and signing secrets are in the `PANTRY_STACK_` block and
on `pantry` and `pantry-commerce`, with the commerce engine's Stripe keys. A
wrong signature gets 401 (Platform) and 400 (commerce engine); a correctly
signed event of an ignored type gets 200.

**Google: the new project `purin-pantry`** (Plan 91 phase 4, decision 2:
one project for sign-in, Gmail and Drive). The Plan 91 phase 4 session made
the project with `gcloud`: the Gmail, Drive, Picker and Pub/Sub APIs, the
topic `pantry-gmail-push` (publisher: `gmail-api-push@system`), the push
service account `pantry-gmail-push`, the push subscription to
`https://pantry.purin.io/hook/email/google` (OIDC, audience the same URL)
and the Picker key. In the owner's Chrome, with the owner's yes (including
the agreement to Google's API Services User Data Policy), I made the consent
screen (External, "In production", home page `https://purin.io`, the
privacy and terms pages, domain `purin.io`, the seven scopes) and the web
client "Purin Pantry web" with the three callbacks. The production profile
names the client, the project number, the topic and the service account, and
`GMAIL_OAUTH_PILOT_EXPIRY_DAYS` is gone ("In production" tokens do not end
after seven days). The secrets are set on `pantry`. Open: Google verification
of the restricted Gmail scopes and the logo (the owner's), and the move of
local development, which still uses `satyr-gmail-dev`, `satyr-drive-pilot`
and the `seams-501403` sign-in client, before step 5 deletes them.

A fault on the way: a `find` call on the "client created" dialog returned the
label of its copy button, which holds the full client secret, so that secret
entered the session transcript. It was replaced at once: a second secret was
made and saved through a local file, and the first one was disabled and
deleted before any Worker used it. Never read the page of a Google client
secret dialog with a tool that returns element labels.

**3.6 Sign-up and chat, and the first live OAuth connect** (22 November
2026, 18:45 to 19:00 JST, `pantry` `03a1ad00` from dev `a50c4854`). At the
owner's request I did them in the owner's Chrome:

- Google sign-in on `https://pantry.purin.io` with the owner's account
  (the consent asked only name, picture and email) opened the Portal with
  "No organisations yet".
- Sign-up made the organisation "Purin workspace" (owner: the owner's
  account). Jev was skipped: `TYPESAFE_API_KEY` is still a placeholder.
- Setup: Purin AI as the AI account, Purin Checkout as the commerce system
  (it made the merchant `merchant_pantry_5d62fad5_d6cc_418d_98dc_957312a4a71e`
  with the demo catalogue), Slack connected through the OAuth callback on
  `pantry.purin.io` (workspace CafeOS), `#cafe-ops` as the update channel;
  then "Activate workspace".
- The first chat turn stopped at the session budget: "71114 used; 64000
  allowed". A new organisation gets `workspace_ai_budget.max_tokens` 64,000
  (the baseline default), and one turn with tool calls used more. The old
  live organisation had 500,000, set by hand. With the budget at 500,000
  (Access, AI budgets), a new chat answered: "I can help you manage your
  shop's products, menus, recipes, orders, inventory, production plans,
  kitchen bakes, devices, and connected apps." The 64,000 default is a fault
  of every new sign-up, on the old stack too; it is reported as its own work.

`purin-shop` (`e7c6df9b`) is deployed with that merchant on
`https://shop.purin.io`. It reads the merchant ("Cafe / Patisserie") and
shows "Today's selection is unavailable" while the demo menu is not open.
A test order needs a card form on a production host, so the owner does it.

The shop Mac voice service (`sh.seams.satyr.shop-voice`, names in
`voice.seams.sh` of the Seams account) stays on the old stack. The owner
chose: step 5 uninstalls it, and its enrollment on `pantry.purin.io` (zone
`voice.purin.io`, a DNS token limited to `purin.io`) is separate work.

### 4. Switch the outside parties

The owner does the provider consoles. I do the rest.

1. In each provider console: change the app name, the callback and webhook
   URLs to the new domains, and rotate the client secret. Slack gets the new
   request URLs.
2. Set the rotated secrets on the new Workers.
3. Set the new Console GitHub secrets and deploy the Console.
4. Change the Gmail push subscription and the Shopify app file.
5. Install the new shop Mac config and the new launchd label.
6. Check, on the new stack: one sign-in, one Slack install and one Slack
   card, one Square or Stripe connect, one order through `pantry-commerce`
   and `purin-shop`, one MCP call, one device heartbeat, the docs link.

### 5. Delete the old stack

Only after step 4 passes, and after the owner says yes again. No rollback is
possible after this step.

- Workers in this order: `satyr-slack-ingress`, then `satyr-edge` (remove its
  queue consumers first), then `satyr-code-mode-sandbox`, `seams-shop`,
  `underclerk`, `satyr-model-exit`, `satyr-chatgpt-exit`,
  `satyr-vault-onepassword` and `satyr-docs`.
- Their container applications, the D1 databases, the buckets (empty them
  first), `POLICY_KV`, the queues, the old Secrets Store secrets, the old R2
  token for CI, and `shop.seams.tokyo`.
- The old Kitchen physics bundles. A saved run resumes only on the bundle
  that made it, so each release of the old stack must hold every old bundle
  (Refactor 16: "Never remove a bundle that a saved run can name"). This
  step deletes every saved run, so no saved run can name an old bundle after
  it. In one commit, keep the pinned runtime bundle, its execution bundle and
  each bundle that a test or a fixture names, and delete the rest:
  - in git: the runtime bundles `31da6f43…` and `419afa85…` (57 MB) and
    their execution bundles;
  - in R2: the 22 runtime bundles and 69 execution bundles that
    `repo-binaries.json` names (about 660 MB), in the bucket that holds them
    at that time;
  - the entries of the deleted bundles in `BAKERY_APPLIANCE_BUILDS`
    (`browser-physics-asset.ts`).

  `pnpm lint:physics-bundle` and `scripts/check-physics-dist.mjs` must pass.
  The files stay in the git history of the import commit.

### 6. Clean the records

- Update AGENTS.md ("Old and new names", "Active runtime", "Deployment"),
  the deploy runbook, the release scripts and their guards, the
  observability scripts that filter by Worker name, and the memory notes.
- Mark Plan 91's deployed-layer and wire-layer rules as ended by this plan.

### 7. Other projects (separate)

Delete the groups in "Stale resources of other projects" when the owner says
yes for each group. This step does not block steps 0 to 6.

## Rollback

Until step 5, the old stack still runs. If the new stack fails a check,
point the providers back to the old addresses. After step 5 there is no
rollback.

## Risks

| Risk | Control |
|---|---|
| A deploy reaches an old Worker name, or makes an empty Worker by mistake | The release guard of step 2 |
| A provider keeps an old callback URL | The checks of step 4 cover each provider that matters. The old stack stays until they pass |
| Google asks for brand verification again | Start the Google console work first. Gmail scopes can take days |
| A secret is lost | Each new secret goes into `.env.local.production` when it is set |
| The codemod changes a third-party name that contains `satyr` or `underclerk` | The codemod has a list of protected names, as the Plan 91 codemod had |
| Another session lands work during the freeze | One freeze, announced to the open sessions before step 2 |

No step adds a cron, an alarm, a poll or a write for an idle tenant. Step 1
removes the staging crons.

## Decisions for the owner

1. **Confirm the data loss** in "What the cutover deletes". Decided on
   21 November 2026: confirmed. I stated the default "confirm" and the owner
   did not object. The list now names the live organisation "Satyr
   workspace".
2. **The new names.** Decided on 21 November 2026: the tables above. The
   owner first said "satyr-edge should be renamed something purin-edge or
   something", then chose "pantry" for the main Worker, on
   `pantry.purin.io`. Every other Pantry resource starts with `pantry-`, and
   storage ends with its region (`-apac`).
3. **Delete the stale Pantry resources now (step 1).** Decided and done on
   19 November 2026.
4. **No staging stack after the cutover.** Default: none until a plan needs
   one.
5. **Stale resources of other projects.** Default: keep them until you say
   yes for each group.
6. **The shop domain.** Default: `purin-shop` on `shop.purin.io`, and the
   commerce engine's `SHOP_SITE_ORIGIN` names it. The order page domain
   (`MENU_HOST_SUFFIX`, still `menu.seams.tokyo`, with no route) stays
   unchosen.

## Adapter code with no test (19 November 2026)

Plan 92's test sweep removed the journeys that repaired stored states from
releases before Refactor 15 or before a rename. Their adapter code stays
until this cutover and has no test now. Remove it with the other adapters.
The list is in Plan 92, "Phase 2 results: the low-impact test sweep".

Step 2 removed them on branch `plan-93` (about 2,200 lines):

- Removed: the purged Connector erase and its `tenant_id` reads; the lapse
  of an approval wait with no ledger entry; the old Kitchen observation,
  the v1 page view and `surfaceContext` (the chat parser now refuses those
  keys, and the route's Kitchen digest check for the old key went too);
  the Square token hand-over; the `public-links` erase; the menu board
  `style` fallback (a release always carries `style`); the `codex_device`
  allowance, pause and refresh (with the `unavailable` allowance and
  `unknown` credits values that only they wrote); the start-time drop of
  the old warning table.
- Removed beyond the list, for the same reason: the erase of a Code Mode
  governor with an earlier name; `erase_purged_organisation_rows` for
  purges before the purge catalogue; the Case wake for old rows and the
  `assigned_at` fallback; `'allowance_exhausted'` in the CHECK of
  `organisation_codex_connection`; the start-time upgrade of the TypeSafe
  evaluation table.
- Kept: the quarantine end with no Code Mode settlement. Current code
  quarantines a Session whose turn cannot end as failed, and this step
  ends that quarantine.
- Kept for separate work: the versioned migration steps of the Actor
  schemas (`SchemaMigrationPlan`), about 30 steps in seven Actors (the
  Case, cue delivery, commerce projection, device fleet, WhatsApp reply
  proposal and Session outbox plans, and the commerce engine's outbox
  signing migration). The new stack starts empty, so each plan can fold
  its steps into one baseline. That is a change of its own, with its own
  checks.

Found on the way, not fixed: if a Session's process is lost while it is
quarantined in a turn, its stream stays `running`, and the quarantine never
ends by itself. Only the operator command `interrupt_session` clears it. The
old quarantine journey hid this with a seed from an old release.

## The full Worker list (closed on 22 November 2026)

`GET /accounts/<id>/workers/scripts` with the account token lists 35 Workers:
the 9 of the new stack, the 9 of the old stack (step 5), and 17 of other
projects: `seams-sdk-d1-*` (8) and `router-ab-*` (5) of the Seams wallet,
`seams-voice-intents-x-refresh`, and `hadimar-web` and `hadimar-api`. No
other Pantry Worker exists, so step 5 has the complete list.

## Cost

- Step 1: about 1 hour.
- Step 2: about 2 days (a codemod over about 6,500 lines in pantry and
  about 900 in seams-monorepo, then the full checks).
- Step 3: about half a day.
- Step 4: about half a day for me. The owner's work in about 10 provider
  consoles takes a few hours. Google verification can add days of wait.
- Step 5 and 6: about half a day.
- Recurring cost: lower than today. Staging and the stale queues go, and the
  new stack has the same shape as the old one.
