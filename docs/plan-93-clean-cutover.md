# Plan 93 — Clean cutover to new Workers and infrastructure

Status: draft, 19 November 2026. Step 1 is done (see "Step 1 results").
Steps 0 and 2 to 7 are open.

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

- The organisation "Nuki Inc." and every record in it: chats, Cases, drafts,
  products, recipes, workflows, orders, gift cards, devices, saved runs and
  Brain records.
- Each provider connection: the Slack install, Square, Stripe, Shopify,
  Gmail, Google Drive, Airtable, Notion and Dropbox.
- The Underclerk merchants and the catalog of `shop.seams.tokyo`.
- The objects in `satyr-archive-apac` and every sign-in.

After the cutover, the owner makes a new organisation and connects each
provider again. The owner confirms this list in step 0.

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

The word `satyr` is on 2,704 lines in 853 files outside `docs/` and the
Markdown files. Plan 92 already removed the unused and duplicate code, so
these are names, not dead code. They fall into two groups.

**Group A: no effect on production or on stored data (about 1,100 lines).**
A codemod can change them at any time, in one commit:

| Kind | Examples | Lines |
|---|---|---|
| Test and fixture values | `https://satyr.example`, `@U0SATYR`, `shared_satyr_app`, `satyr.test`, `satyr-test.myshopify.com` | about 500 |
| Identifiers and comments | `SatyrX` and `satyrX` names (358 lines), the word "Satyr" in comments and test titles (239) | about 600 |
| Brand files | 32 files named `satyr-mark-*` and `satyr-horn-mark-*`, with their references | — |

**Group B: wire, stored and deployed names (about 1,600 lines).** A change
breaks the data and the sessions of the stack that runs today. They change
in step 2, for the new stack:

| Kind | Examples | Lines |
|---|---|---|
| Cookie, CSRF and headers | `satyr_control_session`, `satyr_control_csrf`, `x-satyr-csrf`, `x-satyr-configuration-version` | about 430 |
| Provider and platform ids | `satyr_commerce`, `satyr_platform` | about 300 |
| Contract fields and event kinds | `satyrLocationId`, `satyr_location_id`, `satyr.checkout.*`, `satyr.counter-sale.v1`, `urn:satyr` | about 250 |
| Deployed names | Workers, queues, D1 and R2 names | 148 |
| Shop Mac | `sh.seams.satyr.*`, `~/.satyr-voice`, `hey_satyr` | 55 |
| `SATYR_*` variables that are left | `SATYR_COMMERCE`, `SATYR_ECOMMERCE_FIXTURE_TIMESTAMP` | 63 |

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
  `GMAIL_PUBSUB_AUDIENCE`, `ACCOUNT_PLATFORM_ASSERTION_ISSUER` and
  `ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE`; the OAuth apps of Slack,
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
  (Console). Group A can land before this step, as its own commit. It also removes code that exists only for
  old names: fallbacks, aliases, the glossary rows and the old-name notes in
  AGENTS.md.
- New Wrangler files: new Worker, storage, container and secret names,
  `workers_dev: false`, custom domain routes, and fresh `exports`.
- A release guard: a deploy refuses a Worker name that is not in the new
  name list. So no deploy can reach an old Worker after the cutover.
- Checks: `pnpm check:packages`, `pnpm test:units`, the Platform E2E suite,
  `pnpm portal:build`, `cargo test --workspace`, and a `git grep` that finds
  `satyr` and `underclerk` only in plans and evidence.

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
   organisation through the Console, the chat answers, and the idle-tenant
   check writes close to nothing in one hour.

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
- The Console records of the old organisations (seams-monorepo).

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

1. **Confirm the data loss** in "What the cutover deletes". Default: confirm
   (production holds only test accounts).
2. **The new names.** Default: the tables above. Rule: each Pantry resource
   starts with `pantry-`, and storage ends with its region (`-apac`).
3. **Delete the stale Pantry resources now (step 1).** Decided and done on
   19 November 2026.
4. **No staging stack after the cutover.** Default: none until a plan needs
   one.
5. **Stale resources of other projects.** Default: keep them until you say
   yes for each group.

## Open item

The full Worker list. Wrangler has no command for it, and the API listing
was blocked in this session. To finish the stale list, either allow a
read-only call to `GET /accounts/<id>/workers/scripts` with the Wrangler
sign-in, or copy the list from the Cloudflare dashboard (Workers & Pages).

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
