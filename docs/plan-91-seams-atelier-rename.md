# Plan 91 — Seams Atelier rename

Status: phases 1, 2, 3 and 5 in production (satyr-edge `347178c4`, released from `peitalin/seams-atelier`; the repository is now `seams-tech/pantry`); phases 4 and 6 open. See "Built". On 18 November 2026 the owner renamed Atelier to **Pantry** and Commis to **Gantry**: see "Pantry and Gantry".
Date: 16 November 2026.
Owner: Portal, Platform, commerce, docs and the seams-site.
Replaces: the Antigravity draft `seams_product_rename_plan.md` (outside this
repository).
Touches: [Plan 82 — voice control](plan-82-portal-voice-control.md),
[Plan 82B — ambient voice](plan-82B-ambient-voice.md),
[Plan 85 — Devices page](plan-85-device-fleet-page.md),
[Plan 88 — Jev from Satyr](plan-88-satyr-funded-jev.md),
[Plan 90 — café Register](plan-90-cafe-pos-checkout.md),
[Plan 80 — multi-tenant Underclerk](plan-80-underclerk-multi-tenant-backend.md)
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

The production Portal runs on `satyr-edge.n6378056.workers.dev`. Each person
sees "satyr" in the address bar, in Slack links and on each OAuth consent
screen. Staging runs on `staging.satyr.seams.sh`.

- Give the Portal a custom domain, for example `atelier.seams.sh`, and
  staging `staging.atelier.seams.sh`.
- Change the values of `SATYR_PUBLIC_ORIGIN` and
  `SATYR_OAUTH_CALLBACK_ORIGIN`. The variable names stay.
- Add the new callback URL at each provider before the switch: Slack,
  Google, Square, Stripe, Shopify, Discord and Meta.
- Keep the old address as a redirect for 90 days. Its OAuth callbacks keep
  working in that time.
- Each person signs in one time more after the switch.
- The Console in seams-monorepo names the Satyr origin
  (`scripts/deployment-targets.mjs`). Change it in the same release.

AGENTS.md says "Never change the public origin as part of a directory
rename". This change is a brand change with its own release, so the rule
does not block it. Update the rule text so that it stays true.

### 2. Outside app registrations

The owner changes these in each provider console. No code can do it.

| Provider | What changes | Risk |
|---|---|---|
| Slack | App name "Seams Atelier", bot name `sous-chef`, icon, descriptions | People type `@sous-chef`, not `@satyr`. Each workspace sees the new name at once |
| Slack workspace | The owner's workspace is named "CafeOS". Rename it | None |
| Google Cloud (Gmail) | Consent screen name, logo, home page, privacy URL | A name or logo change can start Google brand verification again. Gmail scopes can make this take days |
| Square | Application name | Low |
| Stripe | Platform name and icon | Low |
| Shopify | App name | Low |
| Discord | Bot name | Low |
| Meta (WhatsApp) | App name | Blocked by business verification today |

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
- Update the speech bias list in `services/platform/src/voice/vocabulary.ts`
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
4. **The public address and the provider consoles.** New callbacks at each
   provider, then the origin switch with the new cookie and storage names,
   then the 90-day redirect. The owner renames the Slack app and the bot on
   the same day. Check: one live sign-in and one live OAuth connect on each
   provider that matters.
5. **Docs, site and Console.** Release on the same day as phase 2 or 3.
6. **Voice.** Train and measure "Hey Sous Chef". Switch the wake phrase and
   the voice prompts in one release.

After phase 1, phases 2, 3 and 5 can run in parallel sessions, because they
touch different files.

Changed order, 16 November 2026: the freeze could not start, because
Refactor 16 is open. So the text phases 2, 3 and 5 went first, and the
codemod of phase 1 waits for the freeze. The text phases change strings and
the codemod changes code names, so the two do not touch the same tokens.

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
  `seams-tech/satyr`.

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
- The domain switch adds no recurring cost. The redirect runs in the same
  Worker.
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
  passes. Existing connections keep their tokens.
- An OAuth callback that a provider does not know fails the connect. Add
  each new callback before the switch, and keep the old one for 90 days.
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
7. **The wake phrase.** Default: keep "Hey Satyr" until a "Hey Sous Chef"
   model passes.
8. **The public domain.** Default: `pantry.seams.sh` (was `atelier.seams.sh`).
9. **Seams Pay, Seams Vault, Seams AI and Jev from Seams.** Default: use
   these names.
10. **The subtitle.** "Bakery operating system" leaves out cafés. Default:
    keep the owner's text.
