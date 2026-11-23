# Plan 91 — Seams Atelier rename

Status: phases 1, 2, 3 and 5 in production (satyr-edge `347178c4`, released from `peitalin/seams-atelier`; the repository is now `seams-tech/pantry`); phase 4 done on 22 November 2026 with the Plan 93 cutover (see "Phase 4 after Plan 93"); phase 6 done on 23 November 2026: the owner switched the wake phrase to "Hey Sous Chef" with the round 3 model, which fails only the macOS voice check; released at 05:51 UTC (`pantry` `9cc4dc3b`), and the owner's first wake in production worked (see "Phase 6: the wake phrase"). See "Built". On 18 November 2026 the owner renamed Atelier to **Pantry** and Commis to **Gantry**: see "Pantry and Gantry". On 22 November 2026 the owner chose the Purin names, and phase 4 now follows [Plan 93](plan-93-clean-cutover.md): see "Purin names" and "Phase 4 after Plan 93".
Date: 16 November 2026.
Owner: Portal, Platform, commerce, docs and the seams-site.
Replaces: the Antigravity draft `seams_product_rename_plan.md` (outside this
repository).
Touches: [Plan 82 — voice control](history/plan-82-portal-voice-control.md),
[Plan 82B — ambient voice](plan-82B-ambient-voice.md),
[Plan 85 — Devices page](history/plan-85-device-fleet-page.md),
[Plan 88 — Jev from Satyr](history/plan-88-satyr-funded-jev.md),
[Plan 90 — café Register](plan-90-cafe-pos-checkout.md),
[Plan 80 — multi-tenant Underclerk](history/plan-80-underclerk-multi-tenant-backend.md)
and Plan 24 (cobots).

## Pantry and Gantry

On 18 November 2026 the owner renamed the operator product from Seams Atelier
to **Seams Pantry** (short form Pantry), and the reserved cobot name from Seams
Commis to **Seams Gantry**. The owner wants a cosy name that people adopt
easily. Gantry names the robot orchestration: the ceiling cobots, the smart
ovens and the MuJoCo simulation of Plan 24. A gantry robot is an overhead
frame robot.

The rest of this plan keeps the names of 16 November 2026. Read each
"Atelier" in it as "Pantry", and each "Commis" as "Gantry". The repository is
`seams-tech/pantry`.

What changed:

- **Display and code.** `scripts/rename/plan-91-pantry.mjs` renames the token
  `atelier` in every case, in file contents and paths, outside `docs/`,
  evidence and recorded data: about 690 files and 4,650 lines, and 9 moved
  files. Every `atelier` came from the first pass, which kept stored and sent
  values as `satyr`, so the deployed and wire layers do not change. The pass
  protects the plain French word in design and recipe data: `atelier-track`,
  `atelier-15`, `location_atelier` and a demo organisation.
- **Porting.** The first codemod now writes Pantry names, and
  `plan-91-port.sh` also ports a branch from before the Pantry rename. Run it
  from a clean branch here: `bash scripts/rename/plan-91-port.sh <checkout>
  <branch> <the dev commit that the branch starts from>`.
- **Slack.** The Slack app becomes "Seams Pantry" at the release, through the
  manifest API. The bot stays "Sous Chef".
- **Public domain.** The default is now `pantry.seams.sh` (decision 8).
  Changed on 22 November 2026: the address is `pantry.purin.io`, and Plan 93
  owns it.

What stays: Worker names, Durable Object classes, D1, R2, KV and queue names,
the env names, the cookie, the `satyr:*` keys, the `x-satyr-*` headers, the
wake phrase "Hey Satyr" and its model file `hey_satyr.onnx`, the file name of
this plan, and the local clone folder `~/Dev/lowerarchy/seams-atelier`.

Risks that the owner accepted: a bakery business app named "Pantry" exists,
and "Open Pantry" sells supplier ordering to restaurants and cafés, so people
can confuse the names. "Pantry" and "Gantry" differ in one sound: when Gantry
gets a voice command, the Plan 82 checks must cover both words.

Fixed in the same change: the first codemod renamed the wake model
`hey_satyr.onnx` to `hey_atelier.onnx`, but the wake worker loads
`hey_satyr.onnx`. From the release of 17 November, production answered that
path with the Portal HTML page, so the wake model could not load. The file has
its old name again. Four strings named files by their old names: the Platform
unit test `globalSetup`, the café acceptance test list and two docs. They now
name the new files.

## Purin names

The brand moved from Seams to Purin: the repository is `purin-labs/pantry`
(Plan 94), and the company site `purin.io` says "Purin Pantry". The Seams
wallet keeps the Seams brand. On 22 November 2026 the owner chose these names
for the product text and for every provider console:

| Name today | Purin name | Note |
|---|---|---|
| Seams Pantry | **Purin Pantry** | Short form Pantry, as before |
| Seams Checkout | Purin Checkout | |
| Seams Vault | Purin Vault | The company site already says it |
| Seams Gantry | Purin Gantry | Reserved; the Devices page stays "Devices" |
| Seams, the company, in Pantry text | Purin | The legal name is "Purin Heavy Industries", as on `purin.io/company` |
| Seams AI, Jev from Seams | Purin AI, Jev from Purin | They follow the company name |
| Sous Chef | no change | |
| Seams Pay | no change | A product of the Seams wallet |

The mark is the Purin cat (`docs/brand/purin-logo`). Every console gets
`icon-pack/icon-1024.png`, or a copy at the size that the console asks for.

The text pass is phase 4A (see "Phase 4 after Plan 93"). It changes the
display layer only, as phases 2, 3 and 5 did. The rest of this plan keeps the
names of 16 November 2026.

## Goal

People see one brand: **Seams**. The operator product is **Seams Atelier**,
the bakery operating system. The agents in it are **Sous Chef** agents. The
commerce engine gets only a plain code name.

The repository gets the name `seams-tech/seams-atelier` and keeps its
history. The code uses the new names. Deployed resources and stored values
keep the old names, so no data moves.

## Brand line

| Element | Text | Where it appears |
|---|---|---|
| Wordmark | Seams Atelier | Sidebar, sign-in, docs header, Slack app name |
| Subtitle | Bakery operating system | Under the wordmark in the sidebar, sign-in and docs header |
| Tagline | Seams Atelier: the operating system for modern bakeries & cafés. | seams.sh hero, docs home, `<meta name="description">`, GitHub description, Slack and OAuth app descriptions |

Write "cafés" with the accent, as the rest of the product text does.

## Naming rules

1. **Seams + a plain noun** for a product that a person uses or connects:
   Seams Atelier, Seams Checkout, Seams Pay, Seams Vault.
2. **An internal system gets only a code name.** It gets a display name
   when a person outside the company uses it by name.
3. **Kitchen brigade names only for actors that do work**: Sous Chef for AI
   agents, Commis for robots. A system does not get a brigade name.
4. **No new code names.** Today three systems have six names: Satyr,
   CafeOS, BakeryOS, AgentCommerce, Underclerk and Urk. Each extra name is
   one more thing that each new person and each agent must learn.
5. **The display name and the code name are the same word** where possible:
   Atelier and `atelier`, Commerce and `commerce`, Kitchen and `kitchen`.

## Name map

Decided by the owner on 16 November 2026:

| Old name | New name | Note |
|---|---|---|
| Satyr (the product), Satyr Agents | Seams Atelier | Short form: Atelier |
| CafeOS, Satyr CafeOS | part of Seams Atelier | CafeOS is no longer a product name |
| Satyr agent, the CafeOS assistant | Sous Chef | "a Sous Chef agent"; full form "Seams Sous Chef" |
| Satyr Commerce, also in the Integrations page | Seams Checkout | The one name that a person sees for the built-in commerce, beside Shopify |
| Checkout pages, the QR order page and the Register | Seams Checkout | |
| Underclerk (the commerce engine and its API) | No display name | Code name `commerce`. Name it when an outside developer first uses its API |
| Cobot and appliance tier (Plan 24) | Seams Commis (コミ) | Reserved; the Devices page stays "Devices" |

Proposed, waiting for the owner:

| Old name | Proposed name |
|---|---|
| Urk (the default merchant agent) | Sous Chef |
| Satyr (the company, the maker of the product) | Seams |
| Satyr Kitchen (BakeryOS area) | Kitchen |
| CafeOS area in the switcher (Menus, Order queue, Register) | Café |
| AgentCommerce area in the switcher | Commerce |
| Satyr identity, signed payment approvals | Seams Pay |
| Satyr Vault | Seams Vault |
| Satyr's AI, "provided by Satyr" | Seams AI, "provided by Seams" |
| Jev from Satyr | Jev from Seams |
| "Hey Satyr" wake phrase | "Hey Sous Chef" |

No change: Brain, Inbox and Devices (plain names already); Jev and Pi
(products of other companies); Punter (a test package that no person sees).

Underclerk does more than checkout: catalog, orders, payments, gift cards,
store credit, B2B price lists and payouts. But no person outside the company
uses it by name today: its packages are private, and operators see its
records in the Commerce area. So it gets only the code name `commerce`.
People see Seams Checkout. Choose a display name when an outside developer
first uses its API (Plan 80).

Considered and not proposed: **Seams Kobo**. 工房 (kōbō) means workshop, the
same meaning as Atelier. So it names the place where products are made, not
the place where they are sold, and it gives one meaning two names. In Japan,
Kobo is also the e-book brand of Rakuten, one of the largest online
marketplaces there. A commerce product with that name invites confusion and
a trademark conflict.

Rules for the text:

- Use "Seams Atelier" the first time on a page, and "Atelier" after that.
- Use "Sous Chef" for the agent. Do not write "the Atelier agent" or "the
  Seams agent".
- An error message names no brand. Write "The server returned an invalid
  response", not "Satyr returned an invalid response".
- The agent's prompt says one time that "Satyr" is the old name of Seams
  Atelier and that "Urk" is the old name of Sous Chef. Old Case history,
  Brain memories and people who still use the old names then stay clear to
  the model.

## Four layers of a name

**Ended on 22 November 2026 by [Plan 93](plan-93-clean-cutover.md).** Plan
93 moved Pantry to a new stack with Purin-era names and no data move, and
deleted the old stack. So the "Keep it" rules of the deployed and wire layers
below no longer apply: every layer uses the new names. The table stays as the
record of phases 1 to 3.

A name lives in four layers. Each layer has its own rule.

| Layer | Examples | Rule |
|---|---|---|
| Display | Page text, prompts, Slack cards, docs, error text | Change all of it |
| Code | Identifiers, file and folder names, packages, CSS classes, lint names | Change it in phase 1 |
| Deployed | Worker scripts, Durable Object classes, D1, R2, KV and queue names, Wrangler secrets and variables | Keep it |
| Wire | Event kinds, provider ids, area values, capability keys, headers, cookie, localStorage keys | Keep a stored value. See the exception below |

**Why the deployed layer stays.** A Durable Object's storage belongs to its
Worker script and its class. A new script name or class name needs a
migration that moves the data. Cloudflare documents rename and transfer
migrations for this, but I have not tested them. After the custom domain is
live (see "The public address"), no person sees a Worker name. So the rename
gives people nothing and puts each Organisation's data at risk.

**The wire exception.** Cookies and localStorage belong to one origin. The
domain switch resets them in any case. So in that release the cookie
`satyr_control_session` and the `satyr:*` keys get new names at no extra
cost. The CSRF header `x-satyr-csrf` and the gateway headers
`x-satyr-device-*` may also change, if the Worker accepts the old header for
30 days. Saved Portal themes are lost one time, because of the new origin.

## System names

| Today | Code name in `seams-atelier` | Display name | Stays in the deployed and wire layers |
|---|---|---|---|
| `satyr`, `Satyr*` identifiers (about 10,700 lines in 2,860 files) | `atelier`, `Atelier*` | Seams Atelier | Worker `satyr-edge`, `SATYR_*` variables |
| `@satyr/*` (16 packages), `@lowerarchy/*` (4) | `@seams/*`, one scope; the `@satyr/std` and `@satyr/type-utils` aliases go | — | — |
| `services/underclerk`, `@underclerk/contracts`, `@underclerk/client` (about 19,000 lines) | `services/commerce`, `@seams/commerce-contracts`, `@seams/commerce-client` | None (internal) | Worker `underclerk`, `Underclerk*DO` classes, event kinds `underclerk.*.v1` |
| `satyr_commerce` provider | `builtInCommerce` in code | Seams Checkout | Wire value `satyr_commerce` |
| Urk (`urk-*.ts`, `URK_*`, about 160 lines) | `merchant-agent-*`, `MERCHANT_AGENT_*` | Sous Chef | Agent rows store the display name: change it one time |
| BakeryOS, CafeOS, AgentCommerce in code (about 430 lines) | `kitchen`, `cafe`, `commerce` | Kitchen, Café, Commerce | Wire values `"BakeryOS"`, `"CafeOS"`, `"AgentCommerce"` and `area: "BakeryOS"` |
| `pnpm lint:underclerk-spec` and other lint names | `lint:commerce-spec` | — | — |
| `scripts/slack/satyr-*-manifest.json` | `atelier-*-manifest.json` | — | — |
| `crates/shop-gateway`, `services/shop-voice` | no change | Text says "Seams Atelier" | launchd label `sh.seams.satyr.*` |
| Punter, Brain, Jev, Pi | no change | no change | — |

AGENTS.md gets one glossary table: each old name, its new name and the
deployed or wire values that keep the old name. An agent that reads an old
plan or a stored value can then map it.

## The repository

Facts on 16 November 2026:

- `seams-tech/satyr` has 4,042 commits. GitHub stores 1.3 GB. The local
  `.git` holds 9.3 GB only because its 36 packs are not combined; a fresh
  clone is about 1.3 GB.
- The tracked files hold about 2 GB and compress to about 960 MB:
  `assets/bakery-mujoco` 862 MB, `apps/portal` 649 MB and `docs/evidence`
  129 MB. So the history adds only about 0.4 GB to the files.
- The history holds 100 vendor PDFs that later moved to R2, and code from
  two earlier projects (the "centaur" fork and the "Cue realtime harness")
  with commits by two other authors. It has seven root commits.
- Plans, evidence and agent memory cite commit hashes of this repository.
- `docs/` holds 3,044 files. 2,512 of them are evidence.

Options:

| Option | What happens | Cost |
|---|---|---|
| A. Rename on GitHub (chosen) | `seams-tech/satyr` becomes `seams-tech/seams-atelier`. History, hashes, pull requests, Actions settings and old URLs keep working. A fresh clone at a new local path ends the 9.3 GB local copy | The history stays, with the old PDFs and the code of the earlier projects |
| B. New repository, one import commit | `seams-atelier` starts with one commit that imports `satyr` at a named hash. `satyr` becomes a read-only archive | Blame, `git log -S` and bisect stop at the import. Old hashes resolve only in the archive. Parked branches move by cherry-pick from an unrelated history. Saves about 0.4 GB |
| C. New repository with rewritten history | `git filter-repo` removes the large files from history | Every hash changes, so each old reference breaks. Most work. Not recommended |

The owner chose option A on 16 November 2026, after the size facts above
were corrected. The history is a daily tool: blame, `git log -S`, bisect
and the hashes in plans, evidence and agent memory. A new history saves
only about 0.4 GB.

If the owner later opens the repository to people outside the company,
plan a history cleanup then. The old PDFs and the code of the earlier
projects are the reason.

### State to move (16 November 2026)

| Item | State | Action |
|---|---|---|
| GitHub settings | Private. No Actions secrets or variables, no webhooks, no deploy keys, no branch protection (the plan does not offer it), one collaborator | The rename keeps them. Nothing to copy |
| CI access to seams-monorepo | `.github/workflows/satyr.yml` checks out `seams-tech/seams-monorepo` with the job token | The rename keeps the repository id. Check that the first CI run after the rename can still read seams-monorepo |
| Old URLs | Remotes, links in docs and the CI pin name `seams-tech/satyr` | GitHub redirects them. Change the remotes and links anyway, because a new repository with the old name would end the redirect |
| Branches | `main` is 693 commits behind `dev`. Draft pull request 3 (`dev` to `main`) runs the bakery physics CI job | No change. The rename keeps both branches and the pull request |
| `refactor-16` | 5 commits ahead of `dev`, and 15 changed files in `~/Dev/lowerarchy/satyr-r16`. Not pushed | Land before the freeze, or commit and push it as a parked branch |
| `plan-87-sources` | 1 commit ahead of `dev` (a design section). Not pushed | Land before the freeze |
| `ci-repair` | No new commits, but 19 changed files in `~/Dev/lowerarchy/satyr-ci` | Commit and land, or drop |
| `plan-40b-gaps`, `plan-40b-phase-7` | Already in `dev` | Delete with their worktrees |
| Other worktrees | 13 in all. One holds a stray untracked `packages/underclerk-contracts/` folder | Check each one, then remove it |
| Git-ignored secret files | `.env.local`, `.dev.vars` and the operator secret files | Copy them to the new clone by hand. Never commit them |
| Repository binaries | `repo-binaries.json` and the R2 bucket `satyr-repo-binaries-apac` | No change. The bucket keeps its name. Run `node scripts/repo-binaries.mjs fetch` in the new clone |
| seams-monorepo | Two docs name the old local path. `tests/e2e/console/shared-account-live-restore.migration.test.ts` reads patch scripts from that path | Change the path in the same week. The test fails until then |
| Claude memory | The memory folder key is the checkout path | Copy the folder to the key of the new path |

### Steps

1. **Freeze.** Land the open work in the table above, or push it as a
   parked branch. A local branch that is not pushed does not reach the new
   clone. From this point, no session lands work until step 5 is done.
2. **Rename on GitHub.** The owner renames `seams-tech/satyr` to
   `seams-tech/seams-atelier` (Settings, or `gh repo rename`). Tag
   `satyr-final` on `dev` first, so that the last commit under the old name
   is easy to find.
3. **Clone fresh.** Clone to a new local path, for example
   `~/Dev/seams/seams-atelier`. Run `pnpm install` and `cargo check
   --workspace`. Copy the secret files and the Claude memory folder. Update
   the seams-monorepo path references.
4. **Rename the code.** In the new clone, a codemod in `scripts/rename/`
   makes one commit for each system: commerce, the merchant agent,
   `atelier`, the `@seams/*` scope and the area names. It holds a list of
   protected strings: the deployed names and wire values. Each commit passes
   the type checks, the lints, `pnpm portal:build`, `cargo test --workspace`
   and the E2E suite. The CI workflow, the `pnpm --filter` names and the
   AGENTS.md commands change in the same commits.
5. **Deploy with no change.** Deploy from the new clone to the same
   Workers. Before the upload, compare the bindings, Durable Object classes
   and migrations with production. They must be equal. The freeze ends.
6. **Retire the old checkout.** For each parked branch, run the codemod on
   it, then rebase it on `dev`. Remove the old worktrees. Keep
   `~/Dev/lowerarchy/satyr` until no session uses it, then delete it.

Not in this plan: moving the 2 GB of assets out of git and into R2. The
repository keeps them as they are. One part to look at later:
`apps/portal/public/bakery-physics/bundles` holds 22 bundle versions
(593 MB). Saved runs can pin an old version, so Refactor 16 decides which
versions stay.

## Work outside the code

### 1. The public address

Changed on 22 November 2026: [Plan 93](plan-93-clean-cutover.md) owns the
address switch. It builds a new stack (the Worker `pantry`) with new, empty
storage on `purin.io` domains, moves the providers to it, and then deletes
the old stack. This replaces the first design of this section (a custom
domain on `seams.sh` and a redirect for 90 days):

- The Portal address is `pantry.purin.io` (Plan 93, decision 2). The Slack
  ingress is `slack.pantry.purin.io`, the commerce engine
  `commerce.pantry.purin.io` and the docs `docs.pantry.purin.io`.
- No redirect from the old address, and no reader for the old cookie, the
  old storage keys or the old headers. Each person signs in again on the new
  address.
- Plan 93 owns the Worker, the domain routes, the values of
  `PANTRY_PUBLIC_ORIGIN`, `PANTRY_OAUTH_CALLBACK_ORIGIN` and
  `GMAIL_PUBSUB_*`, and the switch day (its step 4).
- The Console item goes: since Plan 95 step 4, Pantry names no Console
  service.
- AGENTS.md says that a change of a Worker name, a public origin or a
  callback path is a release of its own, and that Plan 93 moves the address
  with no redirect.

This plan keeps the provider registrations: the names, the icons and the
callback URLs at each provider (section 2).

### 2. Outside app registrations

Changed on 22 November 2026 for Plan 93 and the Purin names. The paths come
from the code on dev `79462c0f` and on the Plan 93 branch (tag
`plan-93-step-2`); the cutover changes no provider path. Every console gets
the name "Purin Pantry", the Purin cat icon and these texts, where the
console has the field:

| Field | Value |
|---|---|
| Short description | Bakery operating system |
| Long description | Purin Pantry: the operating system for modern bakeries & cafés. |
| Home page | `https://purin.io` |
| Privacy policy | `https://pantry.purin.io/docs/privacy` |
| Terms | `https://pantry.purin.io/docs/terms` |
| Domain | `purin.io` |

The privacy and terms pages are Portal pages, so they answer only after Plan
93 step 3. purin.io has no privacy or terms page (owner decision, 22 November
2026).

Each URL change has one of four times:

- **Early.** An added redirect URL. Only a flow that starts on the new stack
  uses it, so it is safe at once.
- **Live.** A push endpoint that gets events at once. Add it after Plan 93
  step 3 attaches the domains, because each event to a dead address fails.
- **Switch.** A field that holds one value. Change it on the switch day
  (Plan 93 step 4).
- **Delete.** Remove the old value or app when Plan 93 step 5 deletes the
  old stack.

| Provider | URLs on the new stack | Time | Who |
|---|---|---|---|
| Slack, app `A0BFVDZLFLM` | Redirect URLs `https://pantry.purin.io/slack/install` and `https://pantry.purin.io/v1/control/providers/slack/callback` | Early | I, through the manifest API, after the owner's yes |
| | Event request URL `https://slack.pantry.purin.io/slack/events`, interactivity URL `https://slack.pantry.purin.io/slack/interactions`. Slack checks the event URL with a challenge, so the new ingress must answer | Switch | I, through the manifest API |
| Google, one new project (below) | One Web client. Redirect URIs `https://pantry.purin.io/v1/control/auth/google/callback`, `…/v1/control/providers/gmail/callback`, `…/v1/control/providers/google_drive/callback`; JavaScript origin `https://pantry.purin.io` (Drive Picker). The Picker API key allows the referrer `https://pantry.purin.io/*` | Early | The owner, in the console |
| | Pub/Sub push subscription to `https://pantry.purin.io/hook/email/google`, with the same URL as the OIDC audience (`GMAIL_PUBSUB_AUDIENCE`) | Live | I, with `gcloud`, after the owner's yes |
| Square, production app | Point of Sale API web callback `https://pantry.purin.io/portal/square-pos-return` | Early | The owner |
| | OAuth redirect URL `https://pantry.purin.io/v1/control/providers/square/callback`. Square keeps one redirect URL for each environment | Switch | The owner |
| Stripe, platform account | Connect OAuth redirect `https://pantry.purin.io/v1/control/providers/stripe/callback` | Early | The owner |
| | A new Connect webhook endpoint (events of connected accounts) `https://pantry.purin.io/hook/stripe/connect`; its id and signing secret go to `STRIPE_CONNECT_WEBHOOK_ID` and `STRIPE_CONNECT_WEBHOOK_SECRET`. The commerce engine has its own endpoint (the old `underclerk` Worker has `STRIPE_WEBHOOK_SECRET`): a second new endpoint `https://commerce.pantry.purin.io/v1/providers/stripe/webhooks`, whose signing secret goes to `STRIPE_WEBHOOK_SECRET` of `pantry-commerce` | Live | The owner |
| Shopify, app "Nuki" (`integrations/shopify/shopify.app.toml`) | `redirect_urls` gets `https://pantry.purin.io/v1/control/providers/shopify/callback` beside the old URL | Early | I, with `shopify app deploy`, after the owner's yes |
| | `application_url` `https://pantry.purin.io/portal` (one value) | Switch | I, as above |
| | The "Order creation" webhook in the development store's admin (Settings › Notifications › Webhooks, API version `2026-07`) to `https://pantry.purin.io/hook/shopify/<new organisation id>`, when Shopify's protected-customer-data gate refuses the app's own `orders/create` subscription (`integrations/shopify/README.md`). Its signing secret goes in with `pnpm shopify:m8:credentials` | Switch | The owner, after the Shopify connect in the new organisation |
| Discord, the owner's application | Interactions endpoint `https://pantry.purin.io/hook/discord/<new organisation id>`. The id exists only after the owner makes the new organisation, and Discord sends a ping when the URL is saved | Switch | The owner, after the Discord install in the new organisation |
| Meta (WhatsApp), app `316717…` | Valid OAuth redirect URI `https://pantry.purin.io/v1/control/providers/whatsapp/callback` | Early | The owner |
| | Webhook callback `https://pantry.purin.io/hook/whatsapp` with the new `WHATSAPP_VERIFY_TOKEN`; Meta checks it with a challenge | Switch | The owner |
| Dropbox | Redirect URI `https://pantry.purin.io/v1/control/providers/dropbox/callback` | Early | The owner |
| | Webhook URI `https://pantry.purin.io/hook/dropbox`; Dropbox checks it with a challenge | Live | The owner |
| Notion, public integration | Redirect URI `https://pantry.purin.io/v1/control/providers/notion/callback` | Early | The owner |
| Airtable, OAuth integration | Redirect URL `https://pantry.purin.io/v1/control/providers/airtable/callback`. If the form holds one URL only, change it on the switch day | Early or Switch | The owner |

Pantry makes the other endpoints itself through each provider's API when a
person connects: the Stripe endpoint of each organisation
(`/hook/stripe/<organisation id>`) and the Shopify webhooks of each shop
(`/hook/shopify/<organisation id>`). The commerce engine's webhook to the
Platform (`/hook/commerce/<organisation id>` after the cutover) is internal.
The ChatGPT and Claude sign-ins use the providers' fixed redirect URIs, so
they need no change.

**Names at the providers.** Change them on the switch day, at the same time
as the URLs, so that people see one name: the Slack app "Purin Pantry" with
the bot "Sous Chef" (the manifest API; the icon only in the console), the
Square application, the Stripe Connect branding (business name and icon),
the Shopify app (in `shopify.app.toml`), the Discord application, the Meta
app, the Dropbox app, the Notion and Airtable integrations. The owner also
renames the Slack workspace "CafeOS".

**Google: one new project.** Pantry's Google sign-in uses the project `seams`
(`seams-501403`), and the Seams wallet uses the same project and the same
OAuth client. One project has one consent screen, so a rename there renames
the wallet's sign-in too. Gmail and Drive use two more projects
(`satyr-gmail-dev`, `satyr-drive-pilot`). On 22 November 2026 the owner chose
one new project for Pantry, for example `purin-pantry`:

1. The owner makes the project and sets the consent screen (Google Auth
   Platform, Branding): the name "Purin Pantry", a 120 × 120 px logo, the
   support email, the home page, privacy and terms URLs above, and the
   authorized domain `purin.io`. Google asks for proof of the domain in
   Search Console; Cloudflare can add the TXT record.
2. Audience: External, "In production". In "Testing", a Gmail or Drive
   refresh token ends after 7 days, and only listed test users can sign in.
   Before Google verifies the Gmail and Drive scopes, a person sees the
   "unverified app" page for them, and at most 100 people can grant them.
   Sign-in asks only for `openid`, `email` and `profile`, so it works for
   every person.
3. A logo on the consent screen needs brand verification. Google reads the
   home page and the privacy page for it, so submit it after Plan 93 step 3.
   It can take some days. Until it passes, the screen shows the name
   without the logo.
4. Data access: the scopes that the code asks for (sign-in, Gmail, Drive).
   Clients: one Web client with the URIs in the table. Its id goes to
   `GOOGLE_OIDC_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_ID` and
   `GDRIVE_OAUTH_CLIENT_ID`, and its secret to `GOOGLE_OIDC_CLIENT_SECRET`,
   `GMAIL_OAUTH_CLIENT_SECRET` and `GDRIVE_OAUTH_CLIENT_SECRET`. A Picker
   API key, and the project number as `GDRIVE_PICKER_APP_ID`. With the
   project "In production", the new Worker leaves
   `GMAIL_OAUTH_PILOT_EXPIRY_DAYS` unset.
5. I enable the Gmail, Drive, Picker and Pub/Sub APIs with `gcloud`, make the
   topic `pantry-gmail-push`, give `gmail-api-push@system.gserviceaccount.com`
   the publisher role on it, make the service account `pantry-gmail-push`
   for the push token, and make the push subscription when the new stack
   answers. `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUBSUB_SERVICE_ACCOUNT` then
   name the new project.
6. At Plan 93 step 5: delete `satyr-gmail-dev` and `satyr-drive-pilot`, and
   remove the Pantry redirect URI from the client in `seams-501403`. The
   wallet keeps that project.

This also ends the Plan 93 exception for `satyr-gmail-dev`: no Google name
keeps "satyr".

### 3. Brand marks

The Portal, the docs and the TV screen use `satyr-mark-*` and
`satyr-horn-mark-*` PNG files and the `SatyrMark` component. The horn is a
satyr symbol, so it does not fit the new name.

- Status, 17 November 2026: the goat mark stays for now. The owner rejected
  an arch with a stitched score line; a chef's hat, a croissant and a cup are
  drafts for the next round.
- Make one Seams Atelier mark in light and dark, at 32 to 1024 px.
- Add the new files with new names. Delete the old files when no page uses
  them.
- Update the favicon, `tv.webmanifest`, the docs logo and the TV icons.

### 4. Voice

- The wake model hears only "Hey Satyr". The training pipeline is in
  `scripts/plan-82-g04/wake.py`. Train a "Hey Sous Chef" model with the same
  pipeline, and measure false wakes on the same noise set.
- Until the new model passes, the Portal keeps "Hey Satyr" in the voice
  prompts. Only the privacy text changes ("Seams keeps no audio.").
- Update the speech bias list in `surfaces/voice/server/vocabulary.ts`
  and the lexicon entry in `services/shop-voice/shop_voice/speech.py`.
- Plan 82B has no addressee check in the code yet. Update the Plan 82B text
  so that the check, when it is built, listens for "Sous Chef".

### 5. The agent's name

- The Portal chat prompt, the embedded harness prompt, the mailbox and
  WhatsApp agents and the tool descriptions say "Sous Chef" and "Seams
  Atelier".
- Slack cards, permission prompts, held-output notices and budget notices
  name the agent "Sous Chef".
- Stored agent rows with the display name "Urk" change to "Sous Chef" one
  time. A name that a person chose stays.
- The capability catalogue text shows on the Access page. Update the text.
  A capability key must not change.

### 6. Programs in the shop

- `crates/shop-gateway` prints "Connected to Satyr." and similar text.
  Change the text to "Seams Atelier".
- `services/shop-voice` prints "Satyr shop voice". Change the text. The
  launchd label stays, because a new label needs an uninstall step on each
  Mac.
- The Portal build includes the gateway build. Rebuild both before the
  Platform upload, as the deploy rule says.

### 7. Error messages in the control API

About 76 strings in `@satyr/control-api` say "Satyr returned …". Change them
to text with no brand.

### 8. Docs, site and Console

- The docs site (`apps/docs`): title, logo, sidebar header, footer and about
  100 lines of text.
- The seams.sh site (seams-monorepo `apps/seams-site`): about 136 lines,
  with "Satyr Kitchen" in the hero, the navigation and the product tour.
  The ink drawings stay.
- The Console (seams-monorepo): about 34 lines in the sign-in and approval
  pages.

These two repositories release apart from `satyr-edge`. Release them on the
same day as the Portal text, so that the site and the product agree.

### 9. Legal name

The first draft writes "Seams (株式会社シームズ)". On 25 August 2026 there was
no registered company. A page must not name a company that does not exist.

- If the company is registered, use its exact registered name in the
  footer, the terms, the privacy page and the OAuth consent screens.
- If it is not registered, write "Seams" only.

Before the outside registrations, the owner checks that "Seams Atelier",
"Seams Checkout" and "Sous Chef" are free to use as product names in Japan.
"Sous Chef" is a common kitchen word, and other software uses it.

### 10. Tests and guidance

- Change each test that asserts an old visible name in the same commit as
  the text. About 70 lines in `services/platform/tests` assert old names.
- Update AGENTS.md: the product direction section, the public name rule,
  the repository boundaries (Underclerk becomes commerce) and the glossary.
- Update `README.md`, `.agents/skills` and `apps/portal/public/brand/README.md`.
- Do not rewrite the old plans or the evidence.

### 11. Japanese text

The Portal has no Japanese brand text today. Use コミ for Commis in Japanese
text. Use a Japanese name for Seams Checkout only when the Register gets
Japanese text (Plan 90).

## Order of work

Each phase is one release. A phase does not start before the last one is in
production.

0. **Decisions, no code.** The owner answers the decisions below, checks the
   legal name and the product names, and adds the custom domain in
   Cloudflare.
1. **Repository name and code names.** The freeze, the GitHub rename, the
   fresh clone, the codemod and a deploy that changes nothing for people.
   This phase comes first, so that all later work happens with the final
   names.
2. **Portal and storefront text.** The name map in `apps/portal` and
   `apps/storefront`, the control API errors, the brand line, the new marks
   and the tests that assert the text. Checks: `pnpm portal:build`,
   `pnpm lint:portal-select`, `pnpm lint:portal-fetch`, `pnpm lint:file-size`
   and the Portal E2E journeys that the text touches.
3. **Agent and server text.** Prompts, tool descriptions, Slack cards,
   callback pages, the stored "Urk" display names and the shop program text.
   Checks: `pnpm lint:runtime-boundary`, `pnpm lint:ifc-boundaries`, the chat
   journeys and the live Slack journey (`pnpm --filter satyr-edge
   slack:live-reply`), because Slack delivery text changes.
4. **The public address and the provider consoles.** Changed on 22 November
   2026: see "Phase 4 after Plan 93". Plan 93 owns the address switch, and
   this phase owns the Purin text and the provider registrations. Check: one
   live sign-in and one live OAuth connect on each provider that matters.
5. **Docs, site and Console.** Release on the same day as phase 2 or 3.
6. **Voice.** Train and measure "Hey Sous Chef". Switch the wake phrase and
   the voice prompts in one release.

After phase 1, phases 2, 3 and 5 can run in parallel sessions, because they
touch different files.

Changed order, 16 November 2026: the freeze could not start, because
Refactor 16 is open. So the text phases 2, 3 and 5 went first, and the
codemod of phase 1 waits for the freeze. The text phases change strings and
the codemod changes code names, so the two do not touch the same tokens.

### Phase 4 after Plan 93

Decided on 22 November 2026. Plan 93 owns the address, the Worker, the env
values and the switch day. This phase owns the rest:

- **4A. Purin text.** One pass changes the names in "Purin names" in the
  Portal, the storefront, the agent and Slack text, the shop programs, the
  docs site, `AGENTS.md` and the tests that assert the text. It lands
  before the switch, so that the new stack shows the names that the consent
  screens show. Checks as for phases 2 and 3.
- **4B. Registrations.** The list in "Outside app registrations": the Early
  items now, the Live items after Plan 93 step 3, and the Switch items and
  the names on the switch day (Plan 93 step 4). The Google project starts
  first. I make the changes that an API can make (the Slack manifest, the
  Shopify app file, `gcloud`) after the owner's yes for each one. The owner
  makes the console changes from the steps that I give.
- **4C. Live checks**, after the switch, on the new stack: one Google
  sign-in; one OAuth connect each for Slack (an install and one card),
  Gmail, Google Drive, Square, Stripe and Shopify; one Dropbox, Notion and
  Airtable connect if the owner uses them; Discord and WhatsApp only when
  their accounts can run. The results go into "Built".
- **4D. Delete**, with Plan 93 step 5: the old redirect URLs and webhook
  endpoints at each provider, and the two old Google projects.

Phase 4 is done when each provider shows the new name and has only the
`pantry.purin.io` URLs, and the checks of 4C pass.

State on 22 November 2026:

- **4A** is on the branch `plan-91-purin-text`, on top of the Plan 93
  branch, so that the first deploy of the new stack shows the Purin names:
  247 files, about 650 lines. Checks that pass: the Platform types and test
  types, `pnpm check:packages`, `pnpm lint:static`, `pnpm test:units` (the
  Platform suite: 301 files, 1,729 tests), `pnpm portal:build`, the three
  commerce journeys that name the shop, and the 20 Platform E2E files that
  the pass changed. In the batch run of the 20 files,
  `counter-receipt-printer` failed one time, because the drawer task was
  still `sent`; it passed alone. The receipt text is not in that check.
- **4B**, with the owner's yes of 22 November 2026 to the API changes:
  - Slack app `A0BFVDZLFLM`: the manifest API added
    `https://pantry.purin.io/slack/install` and
    `https://pantry.purin.io/v1/control/providers/slack/callback`. The
    export after the update lists them beside the old callback and the two
    `localhost:3003` URLs. The app is still "Seams Pantry" with the bot
    "Sous Chef", and its request URLs are still on the old ingress.
  - Shopify app "Nuki": version `nuki-12` adds
    `https://pantry.purin.io/v1/control/providers/shopify/callback`. Before
    the deploy, the released config was equal to the repository file; after
    it, the released config lists the old, the new and the `localhost`
    callbacks, with the old `application_url`.
  - Google, on the owner's "Continue and finish phase 4": `gcloud` made the
    project `purin-pantry` (number 136715459438), enabled the Gmail, Drive,
    Picker and Pub/Sub APIs, made the topic `pantry-gmail-push` (publisher
    role for `gmail-api-push@system.gserviceaccount.com`), the service
    account `pantry-gmail-push` and the push subscription
    `pantry-gmail-push-sub` to `https://pantry.purin.io/hook/email/google`
    with that audience, and the Picker API key (Picker API only, referrer
    `https://pantry.purin.io/*`). The new subscription never expires; the
    old one expired after 31 idle days, so an idle shop could lose its Gmail
    push. The Plan 93 session made the consent screen (External, "In
    production", seven scopes, `purin.io`, the Portal privacy and terms
    pages) and the Web client "Purin Pantry web" in the owner's Chrome, and
    made the two Stripe endpoints through the API.
- **Switch**, 22 November 2026, about 19:10 JST, with the owner's yes. Each
  change was read back after it:
  - Slack: the manifest API set the name "Purin Pantry", the bot "Sous
    Chef", and the request URLs `https://slack.pantry.purin.io/slack/events`
    and `/slack/interactions`. The icon is the Purin cat (console). The
    Plan 93 session's test in #cafe-ops then got one reply in the thread on
    the new stack.
  - Shopify: the name "Purin Pantry" and `application_url`
    `https://pantry.purin.io/portal`.
  - Dropbox (console): the name "Purin Pantry", publisher, website and
    privacy URL, the new redirect URI and the webhook
    `https://pantry.purin.io/hook/dropbox`, which Dropbox shows as
    "Enabled" after its challenge to the new stack. The Dropbox icons are
    not changed: the console opens a native file picker.
  - Square (console, the Japanese business login): the application
    (`sq0idp-fSopNCB…`, before "Satyr") is now "Purin Pantry"; its
    Production OAuth redirect URL is
    `https://pantry.purin.io/v1/control/providers/square/callback` (Pantry
    sends no `redirect_uri` to Square, so this one field decides); the
    Point of Sale web callback `https://pantry.purin.io/portal/square-pos-return`
    is added (the production list was empty).
  - Stripe Connect (console, test mode, account `acct_1TMMrqQ1O5Xa8Eic`,
    "Seams Sandbox"): the redirect
    `https://pantry.purin.io/v1/control/providers/stripe/callback` is added
    and is the default; the old `satyr-edge` redirect is removed; the two
    `localhost` redirects stay. The Seams wallet uses the same Stripe
    account, so its name does not change.
  - Stripe move, the same evening, on the owner's "Do this task here": Pantry
    left the shared account for the sandbox "Purin Heavy Industries
    sandbox" (`acct_1UanmI9Z5LoDEq60`, test mode, Japan, login of the Purin
    company). In its Connect settings OAuth is on, with the test client ID
    `ca_VfwExHMjdL3DwGWEXrFyTTz9qKFSUgFr` and the redirects
    `https://pantry.purin.io/v1/control/providers/stripe/callback`
    (default) and the `localhost:3003` one. The API made the two webhook
    endpoints with the events of the old ones: Connect
    `we_1UeaeG9Z5LoDEq608kzPZsWC` and commerce
    `we_1UeaeG9Z5LoDEq60FIbD36t3`. With the owner's yes, `wrangler secret
    bulk` set the four `STRIPE_CONNECT_*` secrets of `pantry` and
    `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and
    `STRIPE_WEBHOOK_SECRET` of `pantry-commerce`. No Stripe account was
    connected on the new stack before the move. A live key that the owner
    first gave was not used: Pantry runs Stripe in test mode, and a live
    platform needs an activated business. The old account keeps Pantry's
    endpoints and redirects until the first Stripe connect on the new
    account passes.
  - Airtable, Notion and Meta keep their old names and URLs: Airtable and
    Notion until the owner uses them on the new stack, Meta until its
    business verification passes (its Graph API answers "API access
    blocked").
- **4D**, with the owner's yes, after Plan 93 step 5 deleted the old
  Workers: the old Slack redirect, the old Shopify callback, the old
  Dropbox redirect and webhook, and the two old Stripe endpoints (Connect
  and commerce) are removed. Kept: the `localhost:3003` URLs for local
  development. The Plan 93 session deletes the third old Stripe endpoint
  (`/hook/stripe/tenant_T0BGQSSG45N`, made by the code for an old
  organisation) under the owner's step 5 yes. Kept by the owner's decision:
  `satyr-gmail-dev` and `satyr-drive-pilot`, because the local profile
  still uses them. They go when local development moves to `purin-pantry`,
  which is a separate task of its own (Plan 93 follow-ups).
- **Secrets.** Decided by the owner on 22 November 2026: the new stack
  reuses the current provider client secrets, with no rotation. The owner
  first answered "rotate on the switch day", then chose reuse in the Plan 93
  session and confirmed it here. The Plan 93 session set the current Slack,
  Square, Shopify, Stripe Connect, Airtable, Notion, Dropbox and WhatsApp
  values on the new Workers. So the old stack keeps working until Plan 93
  step 5. New values come only from the new Google project and the two new
  Stripe webhook endpoints.
- **Live.** Since 22 November 2026, 12:30 JST, `pantry.purin.io` serves the
  Purin text (Plan 93 redeploy from dev `f6993814`); the privacy and terms
  pages show "Purin Pantry", so Google brand verification can read them.
- **4C, live checks** on `pantry.purin.io`, organisation "Purin workspace",
  22 November 2026 (in the owner's Chrome, on the owner's request; the
  owner typed the Square and Shopify passwords). Each provider accepted the
  new client ID and the new redirect and returned to the new callback:

  | Provider | Result |
  |---|---|
  | Google sign-in | Passed (Plan 93 check) |
  | Slack | Passed: install in CafeOS, and one reply in a #cafe-ops thread (Plan 93 check) |
  | Gmail | Connected, `purinindustries@gmail.com` |
  | Google Drive | Connected, `purinindustries@gmail.com`, with the `purin-pantry` client. Google names the app "purin.io" until brand verification passes |
  | Square | Connected, the Japanese business "Purin Heavy Industries" |
  | Stripe | Registration works: the new client ID and redirect, and the token exchange (last phase `discovering_identity`). Pantry then refused the account (`provider_account_ineligible`): a blank Stripe test account has no details and no card payments |
  | Shopify | Registration works: the token exchange and the shop read (last phase `discovering_identity`). Pantry then refused the shop (`provider_environment_mismatch`): `nuki-ub5drbcx.myshopify.com` is a partner development store, and "Purin workspace" is a production organisation |

  The Stripe and Shopify refusals are Pantry's own account rules, not
  registration faults. Shopify: a production organisation takes only a
  store that is not a development store. Stripe (corrected by the audit
  below): the account rule follows the mode of the platform key, not the
  organisation (`connectStripe` in `provider-workflows/stripe-connection.ts`),
  so with the test key every organisation takes a test account whose
  Stripe sign-up is finished (`details_submitted`); a blank test account
  has not finished it.
- **Test organisation**, the same evening, on the owner's "set up a
  development test organisation": Plan 95 now lets an owner on the Worker
  secret `PANTRY_TEST_ORGANISATION_OWNERS` (`n6378056@gmail.com`) make an
  organisation in the development environment (dev `549f5e50`, `pantry`
  version `5e878705`). "Purin test shop" (`organisation_a911940a-…`,
  handle `purin-test-shop`) reads `environment: "development"`. Shopify
  connected there: the development store `nuki-ub5drbcx` shows as "Nuki".
  The test organisation stays in setup (no AI account, commerce system or
  Slack yet); the connects do not need it to be active.
- **Stripe, closed by audit** (22 November 2026, on the owner's "test it
  yourself or audit the code and declare it done"). A live run needs
  Stripe's test sign-up form, which first asks the owner's Stripe user to
  set up two-step authentication, a security setting that stays the
  owner's. `connectStripe` runs these steps: the platform key and its mode,
  the platform webhook check, the code exchange, the account read and its
  rule, then the token store and the connection. Proven live on the new
  stack: the new client ID and redirect (Stripe accepted them), the webhook
  check of `we_1UeaeG9Z5LoDEq608kzPZsWC` (it runs before the exchange,
  and the attempt went past it), the code exchange with the Purin platform
  key (last phase `discovering_identity`), and the account read (Pantry
  read the blank account and applied its rule). Proven by the journey
  `tests/e2e/stripe-in-commerce.test.ts` on dev, which passes: the
  remaining step, a finished account accepted, its token stored and the
  connection made. The only part not run live is Stripe's own sign-up form.
- **4D, after the Stripe move**: Pantry's two webhook endpoints in the shared
  Seams account are deleted (it now holds only the Seams Console's two
  endpoints). Its `pantry.purin.io` redirect stays there, because the
  Chrome session could not open that account; it is unused, because Pantry
  no longer sends that client ID. Its `localhost` redirects stay for local
  development, which still uses that account's keys.
- **Airtable and Notion**, the same evening, on the owner's "make new ones":
  two new OAuth integrations named "Purin Pantry", under the owner's
  Airtable and Notion logins, with the Purin icon, `https://purin.io` as the
  home page and the Portal privacy and terms pages. Airtable client
  `7abda7cf-…`, with the seven scopes of `provider-adapters/airtable.ts`.
  Notion public connection `420d872b-…`, with "Read content" and "Read user
  information without email addresses" only: Pantry only searches the
  shared pages and reads its bot user. Each has only the
  `pantry.purin.io` callback. The client IDs are in the production vars
  (dev `dd9c0bca`); the secrets went to `pantry` with `wrangler secret
  bulk`; `pantry` version `9591e2c8` runs them. Live check in "Purin
  workspace": both consent pages showed "Purin Pantry" with the new client
  ID, and both connects returned "You're connected" and show under
  Connected. The test grants are narrow: one Airtable example base
  ("Restaurant Field Guide") and one Notion page ("Demo Satyr Page"); the
  owner widens them at the provider. The old Airtable integration stays,
  because the local profile still uses its client. The old Notion
  connection "Satyr" is deleted (23 November 2026, on the owner's
  request): "Purin Pantry" took its two local redirects
  (`https://portal.localhost/…` and `https://localhost:3003/…`), and the
  local `.env.local` now names the new client.

Phase 4 is done, on 22 November 2026. Open items, each outside the switch:

- Meta keeps its old name and URLs. Deferred on 23 November 2026: Meta
  banned the owner's account, so every WhatsApp integration waits until the
  owner has a working Meta business account.
- `satyr-gmail-dev` and `satyr-drive-pilot` are deleted (Plan 93 follow-ups,
  22 November 2026). On 23 November 2026 Google shows both as
  `DELETE_REQUESTED`; it removes them for good after 22 December 2026.
- The Dropbox icons: the Branding buttons open the Dropbox Chooser, a popup
  that picks a file from the owner's Dropbox; the browser tools cannot reach
  the popup. On 23 November 2026 the two files went into the owner's Dropbox,
  folder `Purin Pantry icons` (`purin-pantry-icon-64.png` and
  `purin-pantry-icon-256.png`, copies of `docs/brand/purin-logo/icon-pack/mark-64.png`
  and `mark-256.png`). The owner picks them on the Branding tab of the app
  "Purin Pantry" and saves.
- The callback page now has the Portal's look (dev `29024dc0`, released in
  `pantry` `5e878705`).

### Phase 6: the wake phrase

State on 23 November 2026: the wake phrase is "Hey Sous Chef", with the
round 3 model, by the owner's decision. No model passes the rule below.
Each model is better than the old "Hey Satyr" model on every shared test.
But each hears fewer clips from macOS voices, which no model trains on,
and the rule requires that check. The owner chose the switch without the
real-voice check (see "The switch" at the end of this section).

**Pipeline.** The same pipeline as "Hey Satyr", in `scripts/plan-82-g04`.
`phrases.py` holds each phrase: its wake forms, near phrases, near test and
macOS bench lines. `wake.py phrase --phrase sous-chef` makes only the clips
of the phrase, and every phrase shares the speech and noise sets. So both
phrases count false wakes on the same files. `compare.py` holds the pass
rule. It was written before the first number.

**Training data, in each round.** 24,000 wake clips: 14,000 from Piper
`en_US-libritts_r-medium` speakers 0–799 and 10,000 from Kokoro v1.0 voice
blends. 53,500 near clips: near phrases, bakery talk and generated near
phonemes. The shared 72.4 h of LibriSpeech and DEMAND kitchen, café and
dishwasher noise. The test sets are held out: 400 clips in each of 7
conditions from Piper speakers 800–903 and the last 30% of each noise,
37.1 h of speech and noise for false wakes, and 120 macOS voice clips in
each of 6 conditions. The data is on the shop Mac in
`~/.satyr-voice-test/wake/hey-sous-chef` (rounds 2 and 3, with the
subfolders `round2`, `round2-nearweight4` and `round3-accents`) and
`hey-sous-chef-round1`, about 250 MB each. The
comparisons are in `output/shop-voice/wake-phrase-compare-hey-sous-chef-*.json`.

**The pass rule**, at the Portal's threshold 0.995:

1. False wakes on all shared sets: not more than "Hey Satyr".
2. Recall in each condition: not more than 2 points below "Hey Satyr". The
   mean of the 7 conditions: not lower.
3. macOS voices: the mean share heard is not more than 5 points lower, and
   the mean share of near phrases accepted is not more than 5 points higher.

| At 0.995                                 | Hey Satyr (live) | Round 1 | Round 2 | Round 2, near weight 4 | Round 3, accents |
| ---------------------------------------- | ---------------- | ------- | ------- | ---------------------- | ---------------- |
| False wakes, 37.1 h shared               | 5                | 7       | 5       | 3                      | 4                |
| False wakes in 8 h, held-out speakers    | 1.17             | 1.76    | 1.46    | 0.88                   | 1.17             |
| Heard, clean, 1 m                        | 94.5%            | 98.0%   | 96.2%   | 95.5%                  | 95.8%            |
| Heard, mixer at 0 dB, 1 m                | 93.8%            | 97.5%   | 97.2%   | 94.2%                  | 95.0%            |
| Heard, café at 5 dB, 1 m                 | 45.8%            | 75.5%   | 69.2%   | 68.5%                  | 69.0%            |
| Heard, mixer at 5 dB, 2 m                | 91.2%            | 95.8%   | 95.2%   | 94.8%                  | 95.5%            |
| Heard, mean of 7 conditions              | 86.2%            | 94.1%   | 91.8%   | 90.7%                  | 91.0%            |
| Near test accepted (each phrase its own) | 34.9%            | 43.8%   | 30.2%   | 27.0%                  | 30.9%            |
| macOS voices heard, mean of 6 conditions | 66.5%            | 56.0%   | 48.3%   | 50.4%                  | 53.3%            |
| macOS near phrases accepted, mean        | 6.2%             | 9.8%    | 6.6%    | 5.5%                   | 7.0%             |
| Checks that fail                         | —                | 1, 3    | 3       | 3                      | 3                |

The rounds:

- **Round 1.** Seven wake forms: "sue chef", "sous chef" (espeak says
  /suːz/), the stress on either word, and /sʊ/. The near phrases include
  "hey chef", "yes chef" and "the sous chef".
- **Round 2.** Two causes from round 1. Five of the ten macOS voices say
  "sous" with a final consonant, up to 190 ms longer than "sue". And the
  model woke on "hey" + any word + "chef" ("hey see chef", "hey so chef").
  Round 2 adds the form /suːs ʃɛf/, and 28% of the generated near phrases
  keep "chef" and 14% keep "sous".
- **Round 2, near weight 4.** The same data, trained with
  `train.py --near-weight 4` (default 8), because the harder near phrases
  made the model too strict.
- **Round 3, accents.** The round 2 data, and 7,000 wake and 7,000 near
  clips from the Piper voice `en_GB-vctk-medium` (109 speakers of the VCTK
  corpus, many English accents, CC BY 4.0), trained with near weight 4.
  `wake.py accents` makes these clips. The owner approved the download on
  23 November 2026. Like `libritts_r`, this voice starts from the Piper
  lessac voice.

Why no model passes: on macOS voices, every model is 10 to 18 points below
"Hey Satyr", also at a threshold of 0.9. The accent clips of round 3 closed
only 3 points. Over the six conditions, round 3 hears "Hey Sous Chef" better
than "Hey Satyr" from three of the four natural macOS voices (Samantha 89%
against 58%, Moira 89% against 58%, Karen 75% against 58%, Daniel 63%
against 67%). It is worse for Rishi (Indian English, 0% against 63%), Tessa
(South African, 51% against 79%) and the four old formant voices Eddy, Flo,
Reed and Shelley (31% to 54% against 54% to 81%). So the macOS check now
measures robotic voices and one accent more than people.

A check on real voices measures more than more synthetic data. One
person says each phrase 10 times at 1 m and 10 times at 2 m (about 3
minutes):

```bash
~/.satyr-voice-test/wake/.venv/bin/python scripts/plan-82-g04/real-voices.py record
~/.satyr-voice-test/wake/.venv/bin/python scripts/plan-82-g04/real-voices.py score
```

This check has not run. The rule in `compare.py` stays as it is, so a
later model is measured the same way.

Fixed during this work: the Plan 91 codemod had changed the training forms
from "hey satyr" to "hey pantry", the data folder to `~/.pantry-voice-test`,
and the Mac's lexicon so that it read "pantry" as "Satyr". The Mac now says
"sous" without a final z (shop voice 0.5.2). The Portal reads the wake
phrase and its model from `features/voice/wake-phrase.ts`, so the switch is
a change of two names and one model file. The Chrome voice journey opens the
fixture shop by its real handle and no longer reloads at the first voice
start.

**The switch** (owner's decision, 23 November 2026). The round 3 model is
`apps/portal/public/voice/hey_sous_chef.onnx` (SHA-256 `3a0c6e3b…`).
`WAKE_PHRASE` is "Hey Sous Chef" and `WAKE_MODEL` is `hey_sous_chef`, so the
prompts, the approval text and the dev recorder say the new phrase. "Sous
Chef" is the first speech term, and "Satyr" left the speech terms, the Mac's
lexicon and the confidence bench prompt. The journeys say "hey, sous chef"
with the macOS voice Samantha (`scripts/shop-voice/wake-phrase.json`); the
model scores it 1.0, and five natural macOS voices score at least 0.997.
The Portal no longer loads `hey_satyr.onnx`, and the wake worker removes it
from each device's cache. The file stayed in `apps/portal/public/voice` as
the rollback until the first production wake (see "Released").

Proof on the branch, 23 November 2026:

- The closed-chat Chrome journey passes. The Portal wakes on "hey, sous
  chef" two times and opens the chat beside the page.
- The Platform voice journey passes (4 tests), with "Sous Chef" as the
  first speech term.
- The phase bench on the Portal's model file, with 18 macOS voices
  (`output/shop-voice/wake-phase-bench-hey-sous-chef.json`): the four
  natural voices Samantha, Daniel, Karen and Moira are heard in 376 of 384
  clips, against 348 of 384 for "Hey Satyr". All 18 voices: 710 of 1,728
  against 1,397 of 1,728, because Rishi, Tessa and the novelty voices
  (Ralph, Eddy, Flo, Sandy, Shelley, Rocko, Grandma and Grandpa) fail. Café
  talk: no false wake in 17.8 minutes, against 4.

Known risk: on macOS voices the model hears 53.3% against 66.5% for "Hey
Satyr" (compare check 3), and it does not hear the Indian English voice
Rishi. A person with such an accent may need the held key.

**Released** on 23 November 2026 at 05:51 UTC, with the owner's words
"Push and release": `pantry` `9cc4dc3b` (before: `fc7b7dcd`). Only the
Platform Worker changed. It is a narrow release: the live commit `c2348c16`
and the eight voice commits of this phase, as release commit `cd06042d`
(ref `refs/backup/released-2026-11-23-hey-sous-chef`). The Refactor 17
moves on `dev` are not in it. Before the upload, the release tree passed the
Portal build, the type checks, both voice journeys and the D1 schema check.
After it: `/health` and `/portal` answer 200, `/voice/hey_sous_chef.onnx`
has the model's SHA-256, the Portal file with the new phrase is served,
`/shop-voice/install.sh` gives shop voice 0.5.2, and 114 tail events were
`ok` with no exception. Rollback target: `fc7b7dcd`.

**First wake in production**, 23 November 2026 at about 06:37 UTC: the owner
said "Hey Sous Chef" to the production Portal in Chrome on the Mac, and the
spoken question "What's your name?" reached the chat, and Sous Chef
answered. A first try failed because the owner spoke while voice control
still said "Starting voice control…" (the first start downloads about 15 MB).
After that wake, `hey_satyr.onnx` left `apps/portal/public/voice` on `dev`
(owner's yes). It leaves production with the next release; until then the
live Portal serves it but does not load it. A rollback to "Hey Satyr" now
needs the earlier version `fc7b7dcd`, or the file again from
`~/.satyr-voice-test/wake/models/hey_satyr.onnx` (SHA-256 `6d1b58d9…`).
Open: the owner's real-voice check (`real-voices.py`), which measures how
often the model hears a person.

## Built

State on 17 November 2026:

- **Phases 2, 3 and 5 (text):** in production since 16 November 2026
  (satyr-edge `11c6f658`, then `a4f55a5a` with the goat mark). The Portal,
  the storefront, the control API errors, the agent prompts, the Slack
  text, the shop programs, the docs site, AGENTS.md and the journey scripts
  use the new names. One helper, `surfaceAreaTitle` in the control API,
  gives the area titles to the Portal and the Platform. The goat mark stays:
  the owner rejected a first replacement (an arch with a stitched score line)
  on 17 November 2026, and a better mark comes later.
- **The seams.sh site and the Console:** on seams-monorepo `dev` since 17
  November 2026 (`330816c7`), in English and Japanese, not yet released. The
  Portal screenshots on the site still show the old wordmark and area names;
  capture them again after the Portal release.
- **Slack app:** on 17 November 2026 the production app `A0BFVDZLFLM`
  (before: "Satyr Dev", bot "satyr-dev") became "Seams Atelier", with the bot
  "Sous Chef" and the description "Bakery operating system", through the
  manifest API. The goat icon stays. `SLACK_APP_NAME` and `SLACK_BOT_NAME` in
  the control API follow the app; their new values reach people with the next
  deploy.
- **The agent "Urk":** production has no agent with that name (its agents are
  "Mail assistant" and "Nuki"), so no stored row changed. New installs of the
  merchant agent preset get the name "Sous Chef".
- **Phase 1 codemod:** `scripts/rename/plan-91-apply.sh` runs
  `scripts/rename/plan-91-codemod.mjs` (data in `plan-91-map.mjs`), then
  `pnpm install`, the async-control build, the action registry and the
  commerce spec appendices. It changes about 3,040 files, moves 715 files,
  renames about 1,730 identifiers, 69 CSS classes and 256 CSS custom
  properties, and merges the `@satyr/std` and `@satyr/type-utils` aliases.
  The dry-run report lists each rename, each exact-string rename and what
  stays. It leaves `crates/bakery-native` alone, because the physics bundle
  pins a hash of those sources.
- **Repository:** the owner made the new private repository
  `peitalin/seams-atelier` on 17 November 2026, in place of a rename of
  `seams-tech/satyr`. It holds the full history of `dev` and `main`, and the
  codemod is its first change. The owner weighed a new history with one
  import commit against the full history, and kept the full history: open
  branches in `seams-tech/satyr` move by a rebase, and `blame`, `log -S`,
  `bisect` and the hashes in plans and memory keep working. A new-history
  export is the step to take if people outside the company get access. On 17
  November 2026 production was released from this repository: satyr-edge
  `347178c4` and the Slack ingress `646c72fa`, with no change to a binding,
  a Durable Object class or a migration. A fresh clone needs
  `node scripts/repo-binaries.mjs fetch apps/portal/public/bakery-physics`
  and `pnpm contracts:media` before a Portal build or the E2E suite. The local clone is
  `~/Dev/lowerarchy/seams-atelier`; the project memory was copied to its
  path. `seams-tech/satyr` and its checkouts stay as they are until each open
  branch moves: rebase the branch on old `dev` `e13ff331f`, then run
  `bash scripts/rename/plan-91-port.sh <old checkout> <branch> e13ff331f` in
  a clean branch here. Old `dev` up to `e13ff331f` and the Plan 82C commit
  `0d56416bc` are here. Refactor 16 step 13 (old `e13ff331f..80b2bd9f0`)
  moved on 18 November 2026, and `seams-tech/satyr` is archived. The next
  port base is `80b2bd9f0`. On 18 November 2026 the owner moved the repository to
  `seams-tech/pantry`: the same `dev` and `main`, with the same hashes. The
  local clone keeps the path `~/Dev/lowerarchy/seams-atelier`; its `origin`
  is `seams-tech/pantry`. On the same day
  `peitalin/seams-atelier` was renamed to `peitalin/satyr` and archived; the
  older July 2026 copy that held that name is archived as
  `peitalin/satyr-2026-07`.
- **CI:** the workflows run on a pull request to `main`. The draft pull
  request `seams-tech/pantry#1` (`dev` to `main`) runs them for a push to `dev` only while it has
  the label `run-ci`; adding the label starts a run. Pull request 3 in
  `seams-tech/satyr` ran CI for every push: about 2,160 runner minutes in
  two days, because every session pushes to `dev` and a full run takes about
  290 minutes (edge checks 45, bakery 220, commerce 9).
  `seams-tech/seams-monorepo` is public, so the job token of this repository
  can check it out. The bakery job limit is 300 minutes, below the GitHub
  limit of 360. The `seams-tech` Actions budget is $0, and
  `seams-tech/satyr` used the 2,000 free private minutes of November 2026.
  So no run starts in `seams-tech/pantry` before 1 December 2026, unless
  the owner raises the budget. A full run costs about $1.74 at $0.006 a
  minute. The last run (`7f9f4011c`, in `peitalin/seams-atelier`) failed
  one edge journey, `slack-follow-up-authority` (the follow-up was still
  pending), and the first bakery browser journey (`playwright-cli` timed
  out).
- **Proof, on a test worktree with the text and the codemod applied:** all
  26 checks pass (every package type check, the E2E type check, 13 lints, the
  D1 patch check, the Portal build and the docs build). The Platform E2E
  suite fails the same 15 tests as the code before the rename, and the
  commerce Worker suite passes (202 tests). Local E2E runs need
  `SATYR_ACCOUNT_WORKER_ARTIFACT`.
- **Checked in a browser:** the sign-in page at desktop and phone width, in
  light and dark. Not checked in a browser: the signed-in sidebar and the
  area switcher, because the preview pages have no signed-in shell.
- **Member names keep the old words** (about 850 names). The codemod cannot
  prove that a member is not a stored or sent field. A later change can
  rename internal members with the type checker.
- **Not done:** phase 4 (the domain and the provider consoles), phase 6 (a
  new wake model is a research task), a new mark, the seams.sh site release
  (pull request 74 waits for the owner), and the archive of
  `seams-tech/satyr`. Changed on 22 November 2026: phase 4 is done (see
  "Phase 4 after Plan 93"), the mark is the Purin cat, and the company site
  is `purin.io`. Changed on 23 November 2026: phase 6 is done (see "Phase 6:
  the wake phrase").

## Acceptance

- A `git grep` for `satyr`, `underclerk` and `urk` in the code of
  `seams-atelier` finds only the deployed names and wire values that the
  AGENTS.md glossary lists.
- The phase 1 deploy changes no binding, Durable Object class, migration or
  stored value.
- A person who signs in, opens each area, uses the chat, gets a Slack card
  and connects one provider sees no old name.
- The chat agent calls itself Sous Chef. When a person asks about "Satyr"
  or "Urk", the agent knows that it is an old name.
- Drafts, Slack threads, orders and saved runs work as before. Saved Portal
  themes reset one time.

## Cost

- Phase 1 is a codemod over about 30,000 identifier lines: about 10,700
  for `satyr` and about 19,000 for Underclerk. The freeze lasts until the
  renamed code passes the full checks. No other session can land work in
  that time.
- The text phases are copy edits with test updates: about 1,000 string
  lines in this repository and about 170 in seams-monorepo.
- The domain switch adds no recurring cost. There is no redirect (Plan 93).
- The wake model training runs one time on the shop Mac.
- No phase adds a cron, an alarm, a poll or a write for an idle
  Organisation.

## Risks

- A codemod can change a wire value by mistake. The phase 1 deploy check
  and the E2E suite catch a changed binding or stored value. The codemod
  keeps a list of protected strings.
- People type `@satyr` in Slack after the bot rename. The mention then does
  not reach the agent. Tell each workspace one time in its channel.
- Google brand verification can stop new Gmail connections until it
  passes. Existing connections keep their tokens. Changed on 22 November
  2026: the new Google project starts with no connection. Until the
  verification passes, the consent screen shows no logo, and the Gmail and
  Drive scopes show the "unverified app" page.
- An OAuth callback that a provider does not know fails the connect. Add
  each new callback before the switch, and keep the old one until Plan 93
  step 5 deletes the old stack. Square and some single-value fields cannot
  hold two URLs, so they change on the switch day.
- A parked branch conflicts with the renamed code. Run the codemod on the
  branch, then rebase it.
- A local branch that is not pushed stays in the old checkout. Push or land
  each one before the fresh clone.

## Decisions for the owner

1. **The repository.** Changed on 18 November 2026: the owner moved it to
   `seams-tech/pantry`, with the full history. Before that, on 17 November
   2026, the owner made the new repository `peitalin/seams-atelier`, and the
   full history moved to it.
   Earlier decision, 16 November 2026: option A. Rename
   `seams-tech/satyr` to `seams-tech/seams-atelier` on GitHub, keep the
   history, and clone fresh to a new local path.
2. **The commerce engine.** Decided on 16 November 2026: Underclerk gets
   only the code name `commerce` and no display name. People see Seams Checkout, also in the
   Integrations page. Name the engine when an outside developer first uses
   its API.
3. **The code names.** Default: the `@seams/*` scope and the code names
   `atelier`, `commerce`, `kitchen` and `cafe`. Worker names, Durable Object
   classes and stored values keep the old names.
4. **The freeze date.** Default: the first day after the open work lands.
5. **The company name.** Is the company registered? Default: "Seams" only,
   with no 株式会社.
6. **The switcher areas.** Default: Commerce, Café and Kitchen.
7. **The wake phrase.** Decided on 23 November 2026: the owner switched
   to "Hey Sous Chef" with the round 3 model. It passes the false-wake and
   recall checks and fails the macOS voice check (see "Phase 6: the wake
   phrase"). Earlier default: keep "Hey Satyr" until a model passes.
8. **The public domain.** Decided on 21 November 2026 in Plan 93
   (decision 2): `pantry.purin.io`, with no redirect from the old address.
   Earlier default: `pantry.seams.sh` (was `atelier.seams.sh`).
9. **Seams Pay, Seams Vault, Seams AI and Jev from Seams.** Default: use
   these names.
10. **The subtitle.** "Bakery operating system" leaves out cafés. Default:
    keep the owner's text.
11. **The Purin names.** Decided on 22 November 2026: "Purin Pantry" on
    every consent screen and in the product, and Purin Checkout, Purin Vault
    and Purin Gantry. Seams Pay keeps its name.
12. **The Google project.** Decided on 22 November 2026: one new project
    for Pantry's sign-in, Gmail and Drive. The wallet keeps `seams-501403`.
13. **The legal pages.** Decided on 22 November 2026: the consoles name the
    Portal pages `https://pantry.purin.io/docs/privacy` and
    `https://pantry.purin.io/docs/terms`, and the home page
    `https://purin.io`.
