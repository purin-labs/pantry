# ENG-03 — Names

This spec holds the names of Purin Pantry in each layer: the text that people see, the
code, the deployed resources and the values on the wire. Each layer uses the current
names, and no code reads a value of the old stack. A short list of values keeps an old
word on purpose, and Open work lists the main values that keep one by fault. The table
of old and new names lets a reader of a plan or of the evidence find each current name.

## What it does

### Public names

| Name           | What it names                                                                                                 | Note                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Purin          | The company                                                                                                   | The docs footer gives the legal name, Purin Heavy Industries                          |
| Purin Pantry   | The operator product, "the bakery operating system"                                                           | "Pantry" after the first use on a page                                                |
| Sous Chef      | The agents in Pantry                                                                                          | The full form is Purin Sous Chef. The ChatGPT agent sign-in sends it as the name hint |
| Kitchen        | The production orchestration area                                                                             | Wire value `"kitchen"`                                                                |
| Café           | The café area of the switcher                                                                                 | Wire value `"cafe"`                                                                   |
| Commerce       | The commerce area of the switcher                                                                             | Wire value `"commerce"`                                                               |
| Purin Checkout | The built-in commerce that people see, beside Shopify: the checkout pages, the QR order page and the Register | Provider id `builtin_commerce`, code name `builtInCommerce`                           |
| Purin Vault    | The Vault store that Purin runs, beside 1Password                                                             |                                                                                       |
| Purin AI       | The model route that Purin pays for                                                                           |                                                                                       |
| Jev from Purin | Jev under the key of Purin (ORG-02)                                                                           | The Portal text says "Jev"                                                            |
| Seams Pay      | Signed payment approvals                                                                                      | A product of the Seams wallet, so it keeps the Seams name                             |
| Purin Gantry   | Robot orchestration: the ceiling cobots, the smart ovens and the MuJoCo simulation of Plan 24                 | Reserved. No page or code uses it. The Devices page stays "Devices"                   |

Brain, Inbox and Devices are plain names. Jev and Pi are products of other companies.
Punter is a test package that no person sees. The commerce engine has no display name:
people see Purin Checkout and the Commerce area, and the code name is `commerce`. Two
Portal messages still show the words "the commerce engine" (see Open work).

### The brand line

| Element  | Text                                                            | Where it shows                                                                   |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Wordmark | Purin Pantry                                                    | The Portal sidebar, the sign-in page and the docs header                         |
| Subtitle | Bakery operating system                                         | Under the wordmark, and in the Slack manifests                                   |
| Tagline  | Purin Pantry: the operating system for modern bakeries & cafés. | The Portal `<meta name="description">`, the docs configuration and the docs home |

### Rules for text

1. Use "Purin Pantry" the first time on a page, and "Pantry" after that.
2. Use "Sous Chef" for the agent. Do not write "the Pantry agent".
3. Name a product that a person uses or connects with Purin and a plain noun.
4. Give an internal system only a code name, until an outside person uses it by name.
5. Use kitchen brigade names only for actors that do work, such as Sous Chef.
6. Do not add a code name. Where possible, use one word for the display and the code:
   Pantry and `pantry`, Commerce and `commerce`, Kitchen and `kitchen`.
7. Do not rewrite a plan, a handoff or the evidence. They keep the names of their time.

### Old and new names

The last two tables map the deleted stack. Plans 91, 93 and 94 are the record of their
old names, and the code cannot prove them. No product code reads an old resource or wire
value. The binding `POLICY_KV` has the name of the old namespace, but it points to
`pantry-policy`. `scripts/rename/plan-93-cutover.mjs` holds old names as search patterns.

| Old name                                                   | New name                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Satyr, the product; Atelier (16 to 18 November 2026)       | Purin Pantry, then Pantry. Code: `pantry`, `Pantry*`, `PANTRY_*`              |
| Satyr, the company, the maker or the party that keeps data | Purin                                                                         |
| Satyr, the agent; Urk                                      | Sous Chef                                                                     |
| Satyr Agents                                               | Purin Pantry                                                                  |
| CafeOS                                                     | Purin Pantry for the product; Café for the switcher area. Wire value `"cafe"` |
| Satyr Kitchen, BakeryOS                                    | Kitchen. Wire value `"kitchen"`                                               |
| AgentCommerce                                              | Commerce, the switcher area. Wire value `"commerce"`                          |
| Satyr Commerce                                             | Purin Checkout. Provider id `builtin_commerce`, code name `builtInCommerce`   |
| Underclerk                                                 | The commerce engine. Code `commerce`, `Commerce*`, `COMMERCE_*`               |
| Satyr Vault                                                | Purin Vault                                                                   |
| Satyr identity                                             | Seams Pay, for payment approvals only                                         |
| Satyr's AI, Jev from Satyr                                 | Purin AI, Jev from Purin                                                      |
| Seams Commis                                               | Purin Gantry                                                                  |
| Seams Atelier, Seams Pantry                                | Purin Pantry                                                                  |
| Seams Checkout, Seams Vault, Seams Gantry                  | Purin Checkout, Purin Vault, Purin Gantry                                     |
| Seams AI, Jev from Seams                                   | Purin AI, Jev from Purin                                                      |

| Old deployed name                                                       | New deployed name                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Worker `satyr-edge`                                                     | `pantry`                                                                   |
| Worker `underclerk`                                                     | `pantry-commerce`                                                          |
| Workers `satyr-slack-ingress`, `satyr-model-exit`, `satyr-chatgpt-exit` | `pantry-slack-ingress`, `pantry-model-exit`, `pantry-chatgpt-exit`         |
| Workers `satyr-vault-onepassword`, `satyr-code-mode-sandbox`            | `pantry-vault-onepassword`, `pantry-code-sandbox`                          |
| Workers `satyr-docs`, `seams-shop`                                      | `pantry-docs`, `purin-shop`                                                |
| D1 `satyr-global-tokyo`, `satyr-organisation-apac`                      | `pantry-global-apac`, `pantry-organisation-apac`                           |
| R2 `satyr-archive-apac`, `underclerk-apac`, `satyr-repo-binaries-apac`  | `pantry-archive-apac`, `pantry-commerce-apac`, `pantry-repo-binaries-apac` |
| KV `POLICY_KV`                                                          | `pantry-policy`. The binding stays `POLICY_KV`                             |
| Queues `satyr-events`, `satyr-cues`, `satyr-event-dlq`, `satyr-cue-dlq` | `pantry-events`, `pantry-cues`, `pantry-event-dlq`, `pantry-cue-dlq`       |
| Classes `UnderclerkMerchantDO`, `UnderclerkShopNameDO`                  | `CommerceMerchantDO`, `CommerceShopNameDO`                                 |
| Secrets `data-encryption-root-v1`, `vault-root-v1`, `vault-root-v2`     | `pantry-data-encryption-root`, `pantry-vault-root`                         |

| Old code or wire name                                     | New name                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `satyr`, `Satyr*`, `SATYR_*`                              | `pantry`, `Pantry*`, `PANTRY_*`                                           |
| `underclerk`, `Underclerk*`, `UNDERCLERK_*`               | `commerce`, `Commerce*`, `COMMERCE_*`                                     |
| `@satyr/*`, `@seams/*`, `@underclerk/*`                   | `@purin-labs/*`                                                           |
| Schema versions `underclerk.*.v1`                         | `commerce.*.v1`. An event kind has no prefix, for example `order.created` |
| Provider id `satyr_commerce`                              | `builtin_commerce`                                                        |
| Area values `"BakeryOS"`, `"CafeOS"`, `"AgentCommerce"`   | `"kitchen"`, `"cafe"`, `"commerce"`                                       |
| Headers `x-satyr-*`                                       | `x-pantry-*`                                                              |
| Cookies `satyr_control_session`, `satyr_control_csrf`     | `pantry_session`, `pantry_csrf`                                           |
| Browser storage keys `satyr:*`                            | `pantry:*`                                                                |
| launchd label `sh.seams.satyr.*`, folder `~/.satyr-voice` | `io.purin.pantry.*`, `~/.pantry-voice`                                    |
| Wake phrase "Hey Satyr", model `hey_satyr.onnx`           | "Hey Sous Chef", `hey_sous_chef.onnx`                                     |

### Values that keep an old name on purpose

| Value                                                             | Where                                                                                                   | Why                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| The wake training scripts                                         | `scripts/plan-82-g04/`                                                                                  | They train and compare the two phrases       |
| The pinned Kitchen physics bundles                                | `apps/portal/public/bakery-physics`                                                                     | A saved run names its bundle by hash         |
| The native source of the bundles                                  | `crates/bakery-native`                                                                                  | The bundles hash this source                 |
| The browser folder `satyr-physics-results`                        | `opfs-result-files.ts` and `physics-result-directory.ts` in `areas/kitchen/ui/features/production-run/` | The pinned execution bundle holds this name  |
| R2 file names and model text                                      | `repo-binaries.json`, `scripts/bakery-mujoco`                                                           | These names are inputs of the pinned builds  |
| Plan file names and the applied D1 patch scripts of the old stack | `docs/`, `workers/platform/scripts/`                                                                    | They are records                             |
| The rename script                                                 | `scripts/rename/plan-93-cutover.mjs`                                                                    | Its search patterns must match the old names |

The plain French words "atelier" and "commis" appear in recipe, lighting and test data.

## Contracts

This spec owns no D1 or Actor table, route, event, capability or agent tool.

### Workers and addresses

`WORKER_NAMES` and `WORKER_DOMAINS` in `scripts/worker-environment.mjs` are the one list.

| Service           | Production Worker          | Address                    | Wrangler file                                       |
| ----------------- | -------------------------- | -------------------------- | --------------------------------------------------- |
| Platform          | `pantry`                   | `pantry.purin.io`          | `workers/platform/wrangler.jsonc`                   |
| Commerce engine   | `pantry-commerce`          | `commerce.pantry.purin.io` | `services/commerce/wrangler.jsonc`                  |
| Slack ingress     | `pantry-slack-ingress`     | `slack.pantry.purin.io`    | `workers/platform/wrangler.slack-ingress.jsonc`     |
| Docs              | `pantry-docs`              | `docs.pantry.purin.io`     | `apps/docs/wrangler.jsonc`                          |
| Shop              | `purin-shop`               | `shop.purin.io`            | `apps/storefront/wrangler.jsonc`                    |
| Code Mode sandbox | `pantry-code-sandbox`      | None                       | `workers/platform/wrangler.code-mode-sandbox.jsonc` |
| Model exit        | `pantry-model-exit`        | None                       | `workers/platform/wrangler.model-exit.jsonc`        |
| ChatGPT exit      | `pantry-chatgpt-exit`      | None                       | `workers/platform/wrangler.chatgpt-exit.jsonc`      |
| 1Password store   | `pantry-vault-onepassword` | None                       | `workers/platform/wrangler.vault-onepassword.jsonc` |

The local profiles of the sandbox, the two exit Workers and the 1Password store add the
suffix `-local`. The Platform and the commerce engine have the same name in both profiles.

Each profile reader in `scripts/worker-environment.mjs` refuses a Worker name that differs
from `WORKER_NAMES`. The readers of the sandbox, the two exit Workers and the 1Password
store also refuse a Platform profile that binds the Worker by another name.

### Production resources

| Kind                   | Name                                                                                      | Binding or owner                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D1                     | `pantry-global-apac`, `pantry-organisation-apac`                                          | `DB`, `ORGANISATION_DB_APAC`                         |
| R2                     | `pantry-archive-apac`, `pantry-commerce-apac`                                             | `ARCHIVE`, `BUCKET` of `pantry-commerce`             |
| R2                     | `pantry-repo-binaries-apac`                                                               | `scripts/repo-binaries.mjs`                          |
| KV                     | `pantry-policy`                                                                           | `POLICY_KV`                                          |
| Queues                 | `pantry-events`, `pantry-cues`, with `pantry-event-dlq`, `pantry-cue-dlq`                 | `EVENT_Q`, `CUE_Q`                                   |
| Containers of `pantry` | `pantry-workspace-executor`, `pantry-message-link-fetch`, `pantry-custom-connector-fetch` | One class for each                                   |
| Container              | `pantry-chatgpt-exit`                                                                     | `pantry-chatgpt-exit`                                |
| Secrets Store          | `pantry-data-encryption-root`, `pantry-vault-root`                                        | `DATA_ENCRYPTION_ROOT`, `VAULT_ROOT_V1`              |
| Google Cloud           | Project `purin-pantry`, topic `pantry-gmail-push`, service account `pantry-gmail-push`    | `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_SERVICE_ACCOUNT` |

The Durable Object classes of the commerce engine are `CommerceMerchantDO` and
`CommerceShopNameDO`. The Platform class names hold no Purin, Pantry, Seams or old word.

### Wire names

| Kind                          | Value                                                                                                                                                               | Defined in                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Session cookie                | `pantry_session`                                                                                                                                                    | `SESSION_COOKIE`, `foundation/control/worker/authorization.ts`                            |
| CSRF cookie and header        | `pantry_csrf`, `x-pantry-csrf`                                                                                                                                      | `CSRF_COOKIE`, `CSRF_HEADER`, the same file                                               |
| Configuration version         | `x-pantry-configuration-version`                                                                                                                                    | `foundation/tenancy/data/control-mutation.ts`                                             |
| Gateway identity              | `x-pantry-device-gateway`, `-organisation`, `-location`                                                                                                             | `areas/devices/server/gateway-routes.ts`                                                  |
| Voice device                  | `x-pantry-voice-device`                                                                                                                                             | `VOICE_DEVICE_HEADER`, `packages/control-api/src/voice.ts`                                |
| Exit Workers                  | `x-pantry-upstream-url`, `x-pantry-exit-colo`                                                                                                                       | `chatgpt-exit/forward.ts`, `model-exit/protocol.ts` in `workers/platform/src/`            |
| Commerce lab                  | `x-pantry-lab-timestamp`, `x-pantry-lab-signature`                                                                                                                  | `areas/commerce/server/commerce-lab/ingress.ts`                                           |
| Connector probe               | `x-pantry-probe-key`                                                                                                                                                | `crates/custom-connector-fetch/src/lib.rs`                                                |
| Commerce webhook              | `x-commerce-event-id`, `-event-kind`, `-timestamp`, `-signature`                                                                                                    | `services/commerce/src/webhooks.ts`                                                       |
| Catalog snapshot              | `x-commerce-public-origin`, `x-commerce-snapshot-fetched-at`                                                                                                        | `services/commerce/src/catalog-snapshots.ts`                                              |
| Drag types                    | `application/x-pantry-menu-item`, `-board-image`, `-board-product`                                                                                                  | `content-studio/route.tsx`, `menu-boards/` in `areas/cafe/ui/features/`                   |
| Browser storage               | Mostly the prefix `pantry:`. Some keys use `pantry.` or `pantry-`, and some have no brand prefix                                                                    | The Portal and shop features, and `packages/production-simulation`                        |
| Surface areas                 | `Workspace`, `commerce`, `cafe`, `kitchen`, `Agents`, `Settings`. `surfaceAreaTitle` gives each title, so no label comes from a value                               | `packages/control-api/src/surface-observation.ts`                                         |
| Commerce systems              | `builtin_commerce`, `shopify`                                                                                                                                       | `packages/contracts/src/commerce-system.ts`                                               |
| Commerce schemas and commands | Mostly `commerce.<name>.v<n>`. A few use `pantry.`, such as `pantry.commerce.inventory.v1`, `pantry.commerce.lab.event.v1` and `pantry.storefront-demo-manifest.v1` | `packages/commerce-contracts/src/`, `services/commerce/src/`                              |
| Commerce event kinds          | `<resource>.<change>`, such as `order.created`                                                                                                                      | `services/commerce/src/event-feed.ts`, and Appendix C of `services/commerce/docs/spec.md` |
| Shop gateway service          | `io.purin.pantry.shop-gateway` (macOS), `pantry-shop-gateway.service` (Linux), folder `~/.pantry-gateway`                                                           | `services/shop-gateway/install.sh`                                                        |
| Shop voice service            | `io.purin.pantry.shop-voice`, folder `~/.pantry-voice`                                                                                                              | `services/shop-voice/shop_voice/state.py`                                                 |

### Code and packages

- Each pnpm workspace package has the scope `@purin-labs/`. The root package is
  `@purin-labs/pantry`.
- `SLACK_APP_NAME` ("Purin Pantry") and `SLACK_BOT_NAME` ("Sous Chef") are in
  `packages/control-api/src/slack-names.ts`.
- `MERCHANT_AGENT_DISPLAY_NAME` ("Sous Chef") is in
  `areas/commerce/server/data/merchant-agent-skills.ts`. `AGENT_NAME` ("Purin Sous Chef")
  is in `foundation/agent/models/chatgpt-agent-oauth.ts`.
- `scripts/slack/pantry-dev-manifest.json` holds the app name "Purin Pantry Dev" and the
  bot name `sous-chef-dev`. `pnpm slack:app:update` sends this file to the production app
  in `SLACK_APP_ID`. The command keeps these names, unless it gets `--app-name` and
  `--bot-name` (see Open work).
- `scripts/slack/pantry-public-manifest.json` holds the app "Purin Pantry Local" and the
  bot `sous-chef`. `pnpm slack:public-app:update` sends it to the local app, with the
  events and the interactions URL of the local tunnel.
- `integrations/shopify/shopify.app.toml` names the Shopify app "Purin Pantry".

### Provider registrations

The code defines each path in this table. Two providers also have values in the
repository. `integrations/shopify/shopify.app.toml` holds the Shopify name, application
URL and redirect URLs. `pantry-dev-manifest.json` holds the Slack request URLs, and
`scripts/slack/create-dev-app.mjs` builds the Slack redirect URLs and sends them. For the
other values at a provider, Plan 91 is the only record, except where Open work differs.

| Provider         | Addresses on `pantry.purin.io`, unless a host is given                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack            | `/slack/install`, `/v1/control/providers/slack/callback`; on `slack.pantry.purin.io`: `/slack/events`, `/slack/interactions`                                      |
| Google           | `/v1/control/auth/google/callback`, `/v1/control/providers/gmail/callback`, `/v1/control/providers/google_drive/callback`, the push endpoint `/hook/email/google` |
| Square           | `/v1/control/providers/square/callback`, the Point of Sale callback `/portal/square-pos-return`                                                                   |
| Stripe           | `/v1/control/providers/stripe/callback`, `/hook/stripe/connect`, `/hook/stripe/<organisation id>`; on `commerce.pantry.purin.io`: `/v1/providers/stripe/webhooks` |
| Shopify          | `/portal`, `/v1/control/providers/shopify/callback`, `/hook/shopify/<organisation id>`                                                                            |
| Discord          | `/hook/discord/<organisation id>`                                                                                                                                 |
| WhatsApp (Meta)  | `/v1/control/providers/whatsapp/callback`, `/hook/whatsapp`                                                                                                       |
| Dropbox          | `/v1/control/providers/dropbox/callback`, `/hook/dropbox`                                                                                                         |
| Notion, Airtable | `/v1/control/providers/notion/callback`, `/v1/control/providers/airtable/callback`                                                                                |

The commerce engine posts its events to `/hook/commerce/<organisation id>`. The Platform
sets this address in its webhook subscription, so no provider console holds it.

Where a console has the fields, Plan 91 sets the home page `https://purin.io`, the
privacy page `https://pantry.purin.io/docs/privacy` and the terms page
`https://pantry.purin.io/docs/terms`. The Portal serves these two pages.

## Rules and limits

- **Who changes a name.** No route, capability or agent tool changes a name in this
  spec. A name changes through a code change and a release. No role check applies.
- **Release guard.** `requireReleaseTarget` runs before a production deployment through
  `scripts/run-worker.mjs`, `scripts/lib/side-worker.mjs` and
  `scripts/check-release-target.mjs`. It refuses a name that is not a production name in
  `WORKER_NAMES`, so it also refuses a local name such as `pantry-model-exit-local`. It
  refuses a `workers_dev` or `preview_urls` value other than `false`, also a missing
  key. It refuses a route other than the custom domains in `WORKER_DOMAINS` (the shop
  has two: `shop.purin.io` and `menu.purin.io`). It does not check a D1 or KV id.
- **No new resources.** `run-worker.mjs` and `side-worker.mjs` deploy with
  `--experimental-provision=false`, so Wrangler cannot create a missing D1, KV or R2
  resource. `run-worker.mjs` also refuses resource creation options and target overrides.
  The docs site and the shop use plain `wrangler deploy`, and they bind no such resource.
- **Old names.** Do not add an old Worker name to `WORKER_NAMES`. Do not add a reader, a
  redirect or an adapter for an old cookie, header, storage key or provider id. One
  exception: the browser keys `pantry:cafeos:sidebar-expanded` and
  `pantry.bakeryos.vitrineCustomOrders.v1` move one time to `pantry:sidebar-expanded`
  and `pantry.kitchen.vitrineCustomOrders.v1` (`moveStoredValue` of
  `@purin-labs/std`): if the new key is empty, the old value moves, and the old key is
  removed.
- **Name changes.** A change of a Worker name, a public origin or an OAuth callback path
  is a release of its own. Add each new callback at each provider first.
- **Time limits and information flow.** Names have no time limit or retention. This spec
  adds no information-flow source or output. FND-07 owns those rules.
- **Out of scope:** the names of Seams wallet products other than Seams Pay, and a
  display name for the commerce engine, until an outside developer uses its API.

**Neighbours.** ENG-02 owns the repository and its file rules. FND-04 owns the model
routes and the exit Workers. FND-06 owns the approval methods, and FND-08 owns Purin
Vault. FND-11 owns the contract schemas, and COM-02 owns the commerce engine and its event
kinds. INT-01 owns the provider connections, and ORG-02 owns Jev from Purin. PRT-01 owns
the Portal text and marks, and VOX-01 owns the speech engines. Plan 24 owns the cobot path
that Purin Gantry will name. Plans 93 (the cutover) and 94 (the GitHub organisation) are
closed records.

## Open work

**Slack manifest:** `pnpm slack:app:update` with no name options sets the production app
to "Purin Pantry Dev" and its bot to `sous-chef-dev`. These names differ from
`SLACK_APP_NAME` and `SLACK_BOT_NAME`. Until the file changes, pass
`--app-name "Purin Pantry" --bot-name "Sous Chef"`.

**Release guard text:** AGENTS.md says that the guard refuses a D1 or KV id that the stack
has not made. The code has no such check. Correct AGENTS.md when it points to this spec.

**Provider consoles (Plan 91 phase 4):** Plans 91 and 93 record these states. The code
cannot prove them.

- Meta keeps its old name and addresses until its business verification passes.
- The sources record no change to the Discord application or the Stripe Connect brand.
- The Dropbox app has no Purin icons. The owner must select `mark-64.png` and
  `mark-256.png` from `docs/brand/purin-logo/icon-pack/` on its Branding tab.
- Google has not verified the brand or the restricted Gmail scopes. Until it does, it
  names the app "purin.io", the consent screen shows no logo, and the Gmail and Drive
  scopes show the "unverified app" page.
- The Slack workspace keeps the name "CafeOS". The owner renames it.
- The earlier shared Stripe account keeps one unused `pantry.purin.io` redirect. The
  local profile still uses the old Airtable integration.
- A full Stripe connect through the sign-up form of Stripe has not run on the live stack.

**The wake phrase (Plan 91 phase 6):** the phrase is "Hey Sous Chef" since 23 November 2026,
by the owner's decision. Its model fails the macOS voice check of
`scripts/plan-82-g04/compare.py`, mostly on Indian English and older macOS voices. The
owner's first wake in production worked; no recording of real voices has scored it yet
(`real-voices.py`).

**The mark:** the Portal and the docs still show the goat mark (`pantry-mark-*`,
`PantryMark`). Only the provider callback page shows the Purin cat. No feature uses the
exported `PurinMark` and `PurinIcon`.

**Stored names renamed in November 2026:** the preference area `bakeryos` is `kitchen`
(a global D1 patch moves the rows of `user_preferences`), the home view version
`pantry.cafeos.home.v1` is `pantry.home.v1`, and the two browser keys move as the rule
above says. An open Portal tab of the release before must reload.

**The commerce engine in Portal text:** `areas/organisation/ui/pages/automation.tsx` and
`areas/commerce/ui/features/commerce/production-plan.tsx` show these words to people.

**Domains:** The QR order pages are at `menu.purin.io/<shop name>/`, a custom domain
of `purin-shop`. The local `PANTRY_PROVIDER_INGRESS_ORIGIN` is still the
Square sandbox tunnel `square-sandbox-webhook.seams.sh`. The shop site is `shop.purin.io`.

## Sources

- [Plan 91](../../history/plan-91-seams-atelier-rename.md) and
  [Plan 93](../../history/plan-93-clean-cutover.md). Where they differ from the code, this spec
  follows the code. They give no evidence link in the archive.
- [AGENTS.md](../../../AGENTS.md), sections "Product direction" and "Old and new names".
- Checks: `scripts/worker-environment.test.mjs` and
  `workers/platform/tests/environment-configuration.test.ts` cover the Platform profiles
  and the commerce release target. `workers/platform/tests/e2e/voice-control.test.ts`
  covers the speech terms. No E2E journey has the names as its subject.
