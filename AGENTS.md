# Purin Pantry — Developer Guide

## This codebase is yours

This codebase is yours: what it's for and how it's built are your call, and
you'll keep building on it.

Keep the sentence above word for word. In Anthropic's tests, this exact
sentence raised the rate of merged repeated code from under 10% to about 50%.

Work on the code as its owner:

- If new code repeats existing code, merge the two into one shared module.
  Do not add a second copy.
- If you find a related problem near your change, fix it in the same task.
  Do not only report it.
- Improve the structure of the code that you touch, so that the next change
  is easier. Obey the boundaries and the lint ratchets in this guide.
- If a cleanup is larger than the task or touches another plan's area,
  propose it as separate work. Do not start a mass rewrite.
- In the report, say what you merged or fixed beyond the request.

## Reports to the user

The user reviews more than ten agent threads at the same time and reads each
report cold. A report must show in a few seconds what happened and if the user
must act. These rules apply to explanations, summaries, status reports and next
steps. They do not apply to code, code comments, commit messages or quoted text.

Write in ASD-STE100 Simplified Technical English:

- Write short sentences: a maximum of 20 words for an instruction and 25 words
  for a description. Put one idea in each sentence.
- Use the active voice and simple tenses. Use the imperative for instructions.
- Do not use the "-ing" form of a verb as a noun.
- Use one word for one thing. Use common, short words. Do not use idioms,
  metaphors, slang or filler.
- Keep the articles and "that". Do not make noun clusters of more than three
  words.
- Put a condition before its instruction: "If the test fails, read the log."
- Keep technical names as they are. Explain a term the first time, if it is
  not obvious.

Make each report quick to read:

- Start with the result, and say if the user must act. Then give the reasons.
- Keep a report to one screen, about 15 lines, unless the user asks for more.
- Say what changed for the product. Do not describe how you did the work.
- Leave out commit hashes, file lists and labels that you made during the work,
  unless the user needs them to act.
- State each limit one time and plainly: what failed, what you did not check,
  and what is not committed, pushed or deployed.

Outline next steps as a numbered list, so that the user can answer by number:

- Put the items that need the user first. Put the steps that you do next after
  them. Give a maximum of five items.
- One item is one action or one decision, in one or two sentences.
- For each decision, give a recommendation, its cost, and the default that you
  use if the user does not answer. Do not ask about a cost or a risk that you
  can calculate.
- If the user must do something, give the exact action: the command, the page
  or the value that you need.

## Subagents through the `claude` CLI

The `claude` CLI on this machine signs in to a second Claude account. Use it
as a subagent that completes a task from start to end:

- Give it a goal. Write a brief with the task, the files, the rules and what
  done looks like. Pass a short goal that points to the brief file, so that
  the CLI works until the goal is true: `claude -p "/goal <done condition>.
Read <brief file> and follow it." < /dev/null`. The whole `/goal` text must
  stay under 4,000 characters. Run it in the background.
- Run it from a clean worktree at the commit that the task needs, not from the
  main checkout.
- Give it only the tools that the task needs: `--permission-mode dontAsk`,
  `--allowedTools` and `--disallowedTools`. For example, a production check
  gets read-only `wrangler d1 execute` and no file edits.
- It does not deploy, push or change production data, unless the user
  approved that action for this task.
- Its answer is a report, not proof. Check its claims against the code and the
  results before you report them to the user.

## Product direction

Purin Pantry is the bakery operating system. People and Sous Chef agents
operate it through the Portal and Slack.
The product direction covers the full bakery and café business: demand,
purchasing, recipes, production, quality checks, packaging, inventory, sales,
distribution, and customer service.

Kitchen is the production orchestration area within Purin Pantry. Pantry
connects that work to commerce and daily operations. Agentic ecommerce means
agents can investigate records, prepare changes, and execute authorized
commerce actions with policy checks, approvals, and durable receipts.

Purin is the company. These are its public names:

- Purin Pantry: the operator product, "the bakery operating system". The
  short form is Pantry.
- Sous Chef: the agents in Pantry. The full form is Purin Sous Chef.
- Purin Checkout: the built-in commerce that people see, beside Shopify. It
  includes the checkout pages, the QR order page and the Register.
- Purin Gantry: robot orchestration, for the ceiling cobots, the smart ovens
  and the MuJoCo simulation of Plan 24. The name is reserved; the Devices page
  stays "Devices".
- Seams Pay: signed payment approvals. It is a product of the Seams wallet,
  so it keeps the Seams name.
- Purin Vault: the Vault store that Purin runs.

Use "Purin Pantry" in the Portal, the site, the docs and agent text, and
"Pantry" after the first use on a page. Kitchen is the area name. Code,
Worker names and wire values use the new names (Plan 93); plans keep the old
names. The section "Old and new names" maps each old name.

The business reference is a pâtisserie selling fresh products and packaged gifts
through shops and online channels, such as Noix de Beurre or Lenôtre. These are
product and distribution references. Purin makes no claim about their use of
robotic production.

Plans 22 and 23 record accepted commerce paths. Plan 24 owns the cobot bake
path: governed dispatch to cobots and receipt reconciliation, simulation first. Human, agent,
and future machine actions use the same typed policy, authorization, approval,
receipt, and replay boundaries.

Collaborative authoring is scoped by
[Plan 40](docs/plan-40-product-description-drafting.md) and
[Plan 40B](docs/plan-40B-collaborative-menu-editor.md), the collaborative
menu editor: one live menu on every screen in the shop and on the QR order
page. Purin builds no merchant websites; operators build their own sites with
Claude or Codex on the commerce engine. They replace the retired file-native plans. General desktop filesystem synchronization
remains deferred. Cloud agent profiles and Markdown playbooks belong to Plan 16.

Plans 9, 15, and 16 own the active commerce and
agent foundations. Plans 22 and 23 record the completed café commerce paths.
Plan 39 is scoped to an on-demand Slack brief for unresolved failed payments
and evidenced order delays in the operator's current shop, with investigation
follow-up and existing record links. Its earlier merchant feature parity and
broad evaluation gates are superseded; operator-approved mock-order acceptance passed on
2026-10-01. Real-shop comparison is deferred.
Plan 42 owns the Kitchen orchestration workspace within Pantry: workflow
canvas, resource timeline and Three.js bakery are three synchronized views of
one run. The bounded Plan 42/42B implementation is complete, including shared
authoring, native execution, accepted evidence and fault handling. Plans 42E/F
close the accepted chat-control and shared-orchestration scope, including two
independent cold cells and a simulated human transfer. Plan 42G automatic context
loading passed production Pi/Codex acceptance. Plan 42H is in production; its
integrated file upload, fork and continuation journeys and the production smoke
journey passed on 2026-10-28. The [status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md)
separates completed work from deferred features, broader release acceptance and
physical calibration. Brain is the product area for Memory, Evals and Case
execution inspection: [Plan 42J](docs/plan-42J-brain.md) owns its records and
[Plan 42K](docs/plan-42K-brain-ui.md) owns its interface.
[Plan 79](docs/plan-79-agent-vault.md) owns the agent Vault: website logins,
secure notes, contact profiles and payment cards that agents use without
seeing a secret, an agent browser that fills them, and a store that each
Organisation chooses: Purin Vault or 1Password. Cards stay off in production
until the PCI DSS verification passes.
[Plan 74](docs/plan-74-side-cases.md) owns side Cases: an agent proposes
separate work from a Portal chat or a Slack thread, and a person starts it as
a new chat or a new thread in the same channel.
[Plan 81](docs/plan-81-agent-portal-control.md) owns the Portal chat agent's
control of the Portal apps: the Kitchen, Commerce and Café pages, through
the person's own checks, approvals and receipts.
[Plan 84](docs/plan-84-general-workflow-canvas.md) owns the editable recipe
workflow in Kitchen: one definition, a shared draft, immutable revisions,
decision branches, and agent proposals that the person who asked approves.
[Plan 83](docs/plan-83-one-inbox.md) owns the one Inbox: email and WhatsApp
conversations in one Portal page, with an optional agent for each channel.
[Plan 82](docs/plan-82-portal-voice-control.md) owns Portal voice control: a
wake phrase on the device, Whisper turbo with MLX on a Mac in the shop, Workers AI
as the fallback when the Mac does not answer, English first, and spoken commands
and approvals for the Portal chat agent.
[Plan 82B](docs/plan-82B-ambient-voice.md) owns voice with no wake phrase: a
follow-up window, opt-in ambient mode, a speaker check on the device and an
addressee check.
[Plan 82C](docs/plan-82C-speech-engines.md) owns speech engines: one engine
interface on the shop Mac and on Workers AI, one text check for every engine,
the engine on every transcript, and Qwen3-ASR as a choice for each Mac.
[The voice handover](docs/plan-82-voice-handover.md) gives the state and the remaining steps of
Plans 82, 82B and 82C. Plan 24 owns the cobot bake path in the
first café kitchen: two simulated cobots first, then governed dispatch and receipts.
[Plan 85](docs/history/plan-85-device-fleet-page.md) owns the Devices page: one list of
shop devices, with gateway enrollment, health, alerts and device access, and it
gives Plan 24 its enrollment record. A shop gateway dials out from
`crates/shop-gateway`; `DeviceFleetActor` holds its socket.
[Plan 86](docs/plan-86-bakery-costs-and-margins.md) owns Costs & margins in
Kitchen: one shared workbook (`@purin-labs/costs-sheet-crdt`) for supplier
pack prices, 7-day volume tiers, lot costs from purchase invoices (`FIFO` and
weighted average), weekday and weekend demand, fixed overhead, two-way `fx`
formulas and product margins, with live multiplayer and chat agent tools.
Workflow labor and energy costs remain a future Plan 86 feature.
[Plan 87](docs/plan-87-screen-context.md) owns screen context: where a chat
started, which page each message carries, and one surface protocol for what a
person sees and what the agent does on it.
[Plan 88](docs/plan-88-satyr-funded-jev.md) owns Jev from Purin: the TypeSafe key of
Purin, an on/off switch for each Jev feature, and a monthly allowance in the
subscription.
[Plan 89](docs/plan-89-outside-written-content.md) owns the defence against
prompt injection: a label says that a person outside the Organisation wrote
the content, and an effect with a consequence then asks the person who asked,
with the exact action. A mailbox agent sends a direct reply only to a
verified contact.
[Plan 90](docs/plan-90-cafe-pos-checkout.md) owns the café counter Register
and its POS payment adapters: menu items and modifiers at the counter, cash
with change, Square Terminal Japan cashless (`CARD_PRESENT`, `FELICA_ALL`,
`QR_CODE`) with manual cash refunds for FeliCa, and GMO `stera` over
`shop-gateway` LAN (proposed).
[Plan 91](docs/plan-91-seams-atelier-rename.md) owns the Purin Pantry rename:
the display names, the code names, the repository name and the provider
registrations (names, icons and callback URLs at each provider).
[Plan 92](docs/plan-92-new-pantry-repository.md) owns the new repository and
the cleanup of unused, duplicate and legacy code and weak tests.
[Plan 93](docs/plan-93-clean-cutover.md) owns the clean cutover to the new
`pantry-*` stack on `purin.io` domains, with no data move and no old name.
[Plan 96](docs/plan-96-gemini-models.md) owns the Gemini models: Gemini 4
Hydrogen on the route that Purin pays for, and an Organisation's own Gemini
API key for Hydrogen, Carbon, Argon and Neon, through the model exit Worker.
Plan 60A owns
equipment models. Its simulation phase is complete, with reference gaps accepted
and physical calibration and robot load qualification deferred. Plans 61A–E define recipe
workflows and a combined café shift. Plans 61C–E are implemented and the combined
shift is released; Plan 61A remains in progress and Plan 61B is on hold. Physical calibration
remains a separate increment. Concurrent
workflow authoring later reuses the
[Plan 40C multiplayer module](docs/plan-40C-multiplayer-module.md).

## Old and new names

[Plan 91](docs/plan-91-seams-atelier-rename.md) renamed the brand, and
[Plan 93](docs/plan-93-clean-cutover.md) moved Pantry to a new stack with new
names in every layer: display text, code, deployed names and wire values.
The new stack started with empty storage, so no stored value, cookie, header,
event kind or provider id keeps an old name, and no code reads one.

Plans, evidence and handoffs keep the names of their time. Do not rewrite
them. If you read an old name there, use this table to find the new name.

| Old name                                               | New name                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Satyr, the product; Atelier (16 to 18 November 2026)   | Purin Pantry, then Pantry. Code: `pantry`, `Pantry*`, `PANTRY_*`                   |
| Satyr, the company, the maker or the party that keeps data | Purin                                                                          |
| Satyr, the agent; Urk                                  | Sous Chef                                                                          |
| Satyr Agents                                           | Purin Pantry                                                                       |
| CafeOS                                                 | Purin Pantry for the product; Café for the switcher area. Wire value `"cafe"`      |
| Satyr Kitchen, BakeryOS                                | Kitchen. Wire value `"kitchen"`                                                    |
| AgentCommerce                                          | Commerce, the switcher area. Wire value `"commerce"`                               |
| Satyr Commerce                                         | Purin Checkout. Provider id `builtin_commerce`, code name `builtInCommerce`        |
| Underclerk                                             | The commerce engine. Code `commerce`, `Commerce*`, `COMMERCE_*`; events `commerce.*.v1` |
| Satyr Vault                                            | Purin Vault                                                                        |
| Satyr identity, Satyr's AI, Jev from Satyr             | Seams Pay (payment approvals only), Purin AI, Jev from Purin                       |
| Seams Commis                                           | Purin Gantry                                                                       |
| Seams Pantry, Checkout, Vault, Gantry                  | Purin Pantry, Purin Checkout, Purin Vault, Purin Gantry                            |
| `satyr-edge`, `underclerk`, `satyr-*` Workers          | `pantry`, `pantry-commerce`, `pantry-*` (Plan 93 tables)                           |

Three things keep an old name on purpose, and `git grep` finds them:

- The wake phrase "Hey Satyr", its model `hey_satyr.onnx` and its training
  scripts, until a "Hey Sous Chef" wake model passes. The privacy text says
  "Purin keeps no audio."
- The pinned Kitchen physics bundles in `apps/portal/public/bakery-physics`,
  the native source that they hash, the browser folder
  `satyr-physics-results` that the execution bundle holds, and the R2 file
  names that `repo-binaries.json` and `scripts/bakery-mujoco` give. A saved
  run names its bundle by hash.
- The file names of plans, and the applied D1 patch scripts of the old stack.

## Agent access to features

Each Pantry feature is also a feature of the Portal chat agent. When a change
lets a person do something new in the Portal or in Slack, the same change
gives the agent a way to do it:

- Add a tool with the definer of its family, for example `defineKitchenTool`,
  in a family module under `services/platform/src/agent-tools/`, and one line
  in `registry.ts` at the end of its group. A tool keeps its place: the session
  pins a digest of the list. The services type of the family names what the
  Session gives to the handler. The selection rule says when a turn offers
  the tool (a capability, a turn flag or a page command), and the effect says
  what a call proves. A refusal that the agent can act on is a
  `ToolRequestError`. The catalog that selects and runs the tools is
  `agent-tools/catalog/`: it imports no product area. Or add a
  Code Mode capability. The agent acts through the person's own role checks,
  approvals and receipts, and it reads only what the person can read
  ([Plan 81](docs/plan-81-agent-portal-control.md)).
- If the tool needs a new capability, add it to
  `foundation/authority/authorization/capability-catalogue.ts`. Apply
  `node scripts/capability-policy-backfill-sql.mjs` before the release.
- Prove it with a chat journey: the agent does the action, and a person
  without the right stays refused.
- If the agent must not do the action, write the reason in the owning plan.

## Cost of each tenant

Pantry serves many Organisations, and each one pays every recurring cost again.
An Organisation where nothing changes must cost close to nothing. Cloudflare
bills each written row of a Durable Object and of D1, each queue message, each
KV write and each R2 write.

- A run that finds no change writes nothing: no row, no queue message, no KV
  write and no R2 write. Compare before you write. Record an audit row only
  when the run repairs something or fails.
- A Durable Object stops after about ten seconds without work, and the next
  call starts it again. Its constructor and its first call write nothing when
  its data is current.
- Before you add a cron trigger, an alarm, a poll or a queue retry, calculate
  its cost for one idle Organisation for 30 days. Write that cost in the
  commit message or the owning plan. Prefer an event to a poll, and a long
  interval to a short one. An alarm that arms itself again needs an end.
- `services/platform/tests/e2e/idle-tenant-cost.test.ts` is the guard. It
  runs every production cron trigger for one hour on a shop where nothing
  changes, and it fails above the budget in the file. To raise a budget line,
  write its reason and its cost beside it. Run the journey after a change to a
  cron, an alarm, a poll or a Durable Object constructor:
  `pnpm --filter @purin-labs/platform test:e2e tests/e2e/idle-tenant-cost.test.ts`
- Delete a test Worker and its Durable Objects when the test ends. Forgotten
  load-test Workers were a third of the Durable Object bill in November 2026.
- To measure production, read `rowsWritten` in the GraphQL Analytics datasets
  `durableObjectsPeriodicGroups` and `d1AnalyticsAdaptiveGroups`.

## Active runtime

Pantry’s production runtime is Cloudflare-native:

- `services/platform` owns the Worker, HTTP routes, Slack ingress, OAuth,
  onboarding, D1 migrations, Durable Objects, queues, R2, KV, and container
  orchestration.
- `apps/portal` is the React operator portal compiled into Worker assets.
- `AgentSessionActor` runs Pi on every route; its pinned model route selects
  the authority. `organisation_subscription` + `openai` runs Pi through
  pi-ai's legacy `openai-codex` provider with the organisation's ChatGPT
  sign-in (Plan 72). `organisation_byo` + `openai`, `anthropic` or
  `google` runs Pi with the organisation's purpose-bound, Vault-encrypted
  API key of that provider (Gemini 4 for `google`, Plan 96). `platform` +
  `openai-compatible` runs Pi with the Purin `OPENROUTER_API_KEY`; its default
  model is Gemini 4 Hydrogen. Missing or exhausted authority fails the
  selected route.
- The model exit Worker `pantry-model-exit` sends every direct model-provider
  request from a data centre near AWS Tokyo (Plan 73): the ChatGPT sign-in
  and refresh, the BYO OpenAI, Anthropic and Gemini keys and the Claude
  account. OpenAI, Anthropic and the Gemini API refuse Hong Kong, where an
  `apac` Actor can run.
  chatgpt.com blocks every request from a Worker, so the ChatGPT model
  requests and allowance reads go through the ChatGPT exit Worker
  `pantry-chatgpt-exit` and its one shared container (Plan 75). Use
  `modelProviderFetch(env)` for a new provider call; it picks the exit by
  host. Never patch `globalThis.fetch`. The OpenRouter route stays direct.
- `crates/workspace-executor` and `services/workspace-executor` provide the
  on-demand heavy execution boundary.
- `packages/commerce-contracts` (`@purin-labs/commerce-contracts`) owns the
  provider-neutral commerce contracts as TypeBox schemas and their parsers.
  `packages/contracts` (`@purin-labs/contracts`) owns Pantry's contracts and
  re-exports the commerce ones.

The production Worker is `pantry`, on its one address `pantry.purin.io`
(Plan 93). “Platform” is the source ownership boundary.

## Repository boundaries

The commerce engine owns commerce transactions in `services/commerce`. Its
contracts live in `packages/commerce-contracts` and its typed client in
`packages/commerce-client` (`@purin-labs/commerce-client`). Commerce code
imports no Platform package, and Platform code reaches the commerce engine
only through those packages or the built Worker `pantry-commerce`; `pnpm lint:runtime-boundary` refuses a new
crossing. Platform code in `actors/`, `slack/` and `chat/` imports no
file in `control/routes/`; the same lint refuses it. Put the code that a route
and an actor share in a domain module, or in `control/admission/` for a request
check. A route file parses the request, checks authorization, calls one domain
function and maps its result; it runs no D1 query (the same lint refuses one).
A domain function returns a `Result` and knows no HTTP; code throws only for a
programmer error. This rule applies to new and moved code; there is no mass
rewrite. [The commerce spec](services/commerce/docs/spec.md) is
the contract for its behavior and API, with Shopify as the reference. A change
to a route, a scope, an event kind or a rule updates the spec in the same
commit; `pnpm lint:commerce-spec` refuses an API change that the spec does
not list. [Plan 77](docs/plan-77-underclerk-modular-core.md) owns the commerce engine's
modular core and plugins: built-in plugins, merchant plugins that agents write
at run time, the payments module and checkout pipeline, state machines and one
type source. [Plan 80](docs/plan-80-underclerk-multi-tenant-backend.md)
owns the commerce engine as a multi-tenant headless backend that Pantry
exposes to many operators: one request shape, tenant isolation, attribution,
merchant-managed keys, and Square and Stripe inside the commerce engine with
no payment path through the Platform. Sous Chef's merchant-agent instructions
and installation
belong to `services/platform/src/data/merchant-agent-skills.ts` and `merchant-agent-preset.ts`.
The Commerce Read Layer is Platform's projections and commerce-query code.
Punter is the independent shopping acceptance package in `scripts/punter`.
Scrutineer and Etherea have been removed, and video-service selection remains
undecided.
Runtime boundaries use versioned APIs and signed events; they do not import
another runtime's database or private source.

Projects group Cases from every surface. General Project code lives in
`services/platform/src/projects/` and its routes under
`/v1/control/organisations/:id/projects`; a member's sidebar ordering stays in
`services/platform/src/chat/`. Every Case has one `case_project` row, and work
with no named Project is filed in the Organisation's default Project. See
[`docs/refactor-9.md`](docs/refactor-9.md). A change to a D1 baseline ships
with a patch script for deployed databases in `services/platform/scripts/`.
The patch scripts there before Plan 93 are records of the old stack; the new
databases loaded the baselines fresh.

A source file over 3,000 lines may not grow, and a new source file may not pass
3,000 lines; `pnpm lint:file-size` refuses both. The rule also holds for a
style sheet. Put new code in a new module
beside the large file. When a listed file gets smaller, run
`node scripts/check-file-size-ratchet.mjs --update`.
[Refactor 10](docs/refactor-10.md) splits the large files.
[Refactor 17](docs/refactor-17.md) gives each source file a module in one of
three layers: foundation, product areas and surfaces. `scripts/layers.json` is
the map. An import goes only down the layers. One area imports no file of
another area; it may import the contract of that area: its workspace package,
or a public file that `contracts` in the map lists, such as
`services/platform/src/commerce/contract/`. A public file holds types,
schemas and entry points. It imports no file of its own area that is not
public, except with `import type`; `pnpm lint:layers` refuses a public file
that does. A service that needs the inside of its area stays behind an
interface that the Worker wires. Only the owner module of a D1 table writes it. `pnpm lint:layers` refuses a
new crossing, and it refuses a source file, a top-level folder or a D1 table
with no line in the map. Remove a crossing with a port: the lower module
defines an interface, and the higher one gives the implementation. Then run
`node scripts/check-layers.mjs --update`. A crossing that stays needs a reason
and a fix under `reasons` in `scripts/layers-ratchet.json`. `docs/layers.md`
lists the files, tables and public files of each module; after a new file or a
map change, run `node scripts/check-layers.mjs --areas --write`, or
`pnpm lint:layers-page` fails. `pnpm lint:clones` refuses a new copy
of product code, and `pnpm lint:unused` refuses a new unused file or export. A
file that only a tool starts, such as a new Worker entry or a page with its own
HTML file, goes into the entry list of its workspace in `knip.json`. When a
copy or an unused export goes, run the script with `--update`.
A Portal feature reads the control API through `controlRead` and changes it
through `controlMutation` (`foundation/control/portal/control-client.ts`); `pnpm
lint:portal-fetch` refuses a new raw `fetch`. When a file loses one, run
`node scripts/check-portal-fetch-ratchet.mjs --update`.
A Portal component reads through `useLatestRead` and changes through
`useMutation` (`apps/portal/src/ui`). The request is a function in the request
module of its feature, for example `features/devices/requests.ts`; `pnpm
lint:portal-requests` refuses a new direct `controlRead` or `controlMutation`
call in a component file. When a file loses one, run
`node scripts/check-portal-requests-ratchet.mjs --update`.
Portal components use [Base UI](https://base-ui.com) (`@base-ui/react`) for
behaviour and plain CSS with Portal tokens for styles. Do not add shadcn/ui,
Tailwind or a second component library. Before you build a control, look in
`apps/portal/src/ui/`: it holds the prebuilt Portal components, for example
`Select`, `Popover`, `Switch`, `SideDrawer`, `ActionMenu`, `CrmTable`,
`Button`, `EmptyState`, `TaskList`, `Trace`, `TimeLanes` and
`PermissionRequestDialog`.
Import them from `apps/portal/src/ui` (the `index.ts` entrypoint); `ui/README.md` describes
each one. If no component fits, build the new one in `ui/` on a Base UI part,
with its own CSS file, and export it from `ui/index.ts`. A new button with a
label is the `Button` of `apps/portal/src/ui/button.tsx`, with a `variant`
(`primary`, `secondary`, `danger` or `link`); do not give a raw `<button>` the
classes `primary-button`, `secondary` or `danger`. Every Portal dropdown
is the [Base UI Select](https://base-ui.com/react/components/select) in
`apps/portal/src/ui/select.tsx`, with the Base UI part names: `Select.Root`,
`Select.Trigger`, `Select.Value`, `Select.Popup`, `Select.Item`,
`Select.Group`, `Select.GroupLabel` and `Select.Separator`. Pass `items` to
`Select.Root`, so that the trigger shows the label and not the value. Use
`variant="ghost"` on `Select.Trigger` in a toolbar or a table cell, and
`size="sm"` in a dense panel. Do not add a second select component, a native
`<select>` or a direct `@base-ui/react/select` import. `ui/select.css` owns
the caret. Page CSS targets the trigger as `.pantry-select-trigger`; a page
rule for buttons excludes it with `button:not(:where(.pantry-select-trigger))`.
`pnpm lint:portal-select` refuses a raw `<select>`, an `<option>` outside a
`<datalist>`, a `<Select.Root>` without `items`, and page CSS for a `select`
element or the caret.

Every drawer and sheet uses the drawer that the app already has: `SideDrawer`
in the Portal and `CartDrawer` (`apps/storefront/src/patisserie.tsx`) on the
storefront. Do not add Vaul or another drawer library, even when a skill
recommends it. If a drawer needs a swipe or drag gesture, add it to that
drawer.

Shared packages live in `packages/`. Browser applications live in `apps/`.
Contracts are TypeBox 1.x schemas with `Value` checks (Plan 78); no contract
remains in Rust. Add each new contract type or lifecycle to its owning
TypeScript package. See `docs/plan-78-contracts-in-typescript.md`.
See [`docs/commerce-monorepo.md`](docs/commerce-monorepo.md). Reach for the
shared helpers before writing a local copy: `@purin-labs/std` for value guards,
`assertNever`, encoding, SHA-256 and canonical JSON; `@purin-labs/type-utils`
for `Variant`, `VariantBy` and `StrictUnion`; `@purin-labs/contract-schema` for
`StrictObject`, `recordParser` and the other contract schema helpers;
`@purin-labs/control-api` for shapes the portal and the platform exchange. The
shapes of one area are in the control API package of that area, for example
`@purin-labs/kitchen-control-api`; `control-api` names no area package.

Source-derived model and user-visible content must use the established live
authorization and IFC boundaries, including titles, previews, errors and replay.
Use the [IFC integration guide](foundation/authority/policy/information-flow/README.md)
when adding a source or output. Preserve contributing restrictions through moves,
summaries, forks and restore. Update the guide when an entry-point contract changes;
run `pnpm lint:ifc-boundaries` and an allowed/denied E2E journey for new sources.

## Setup

```bash
corepack enable
pnpm install
cargo check --workspace
```

Large files live in the R2 bucket `pantry-repo-binaries-apac`, not in git: the
Kitchen models in `assets/`, the Kitchen physics bundles in
`apps/portal/public/bakery-physics` that no pin names (git keeps the pinned
runtime bundle and its execution bundles; `pnpm lint:physics-bundle` checks it),
the equipment manuals in `docs/equipment` and other large files ([Plan 92](docs/plan-92-new-pantry-repository.md)).
`repo-binaries.json` names each file, and each file of a folder, with its SHA-256.
After a clone, and before a Portal build, a Kitchen build or the E2E suite, run
`node scripts/repo-binaries.mjs fetch` with a Wrangler sign-in (or the R2 S3 keys,
as CI does). Each file also goes into a local cache (`~/.cache/repo-binaries`),
so a new worktree on the same machine copies the files and downloads nothing.
To add or change a large file or a folder, run `node scripts/repo-binaries.mjs
upload <path>` instead of `git add`; `upload --dry-run <path>` lists what it
would send. Run `upload` again for a folder after you change a file in it.

This repository started on 18 November 2026 with one import commit
([Plan 92](docs/plan-92-new-pantry-repository.md)). The older history, the
evidence and the closed plans are in the archived `seams-tech/pantry-history`.
A commit hash in a plan, in the evidence or in the memory resolves there.

Copy environment examples only when a local flow requires them. Secrets belong
in `.env.local`, Wrangler secrets, or the configured vault. Never commit them.

## Local development

Build the portal:

```bash
pnpm portal:build
```

Run the Worker locally:

```bash
pnpm --filter @purin-labs/platform dev
```

Apply local D1 migrations when a change requires persistence:

```bash
pnpm --filter @purin-labs/platform d1:migrate:local
```

## Testing

### Policy

- Do not write unit tests.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify
  complex features work. At the end of E2E tests, produce a verifiable and
  repeatable artifact.
- When writing E2E tests, choose a medium to hard scenario to verify the work.

When implementing with tests:

- Tautological tests are harmful.
- Change-detector tests are harmful.
- Do not create regression tests for bug fixes without a genuine gap in
  behavior testing.

What makes a test worth keeping:

- A test is tautological when a mock or fixture produces the result that the
  test asserts. Such a test proves nothing. Delete it.
- A fake outside service may only record or answer calls. Product code must
  produce the asserted outcome, so the test fails when that code is wrong.
- Seed data (an Organisation, members, grants) is input, not proof. Keep it
  minimal, and build it through the same authorities that production uses.
- Assert outcomes that an operator or customer sees: one Slack message, no
  repeated inference, no lost draft, a refused request. Do not assert internal
  step order or private state names; those assertions are change detectors.
- Fault journeys (eviction, relocation, delayed admission, revoked access) are
  the reason to inject faults. Keep one case per distinct outcome, not one case
  per internal timing window.
- Legacy tests can encode faulty legacy behavior. When a test breaks because
  setup drifted, first ask if its outcome still matters. If it does not, delete
  the test instead of repairing its fixture.
- Fixture journeys do not prove that real Slack, model providers or payment
  providers behave like the fakes. Keep one simple journey on real services for
  each integration that matters, and run it before a release.

### Checks

Run the narrowest relevant checks first:

```bash
pnpm --filter @purin-labs/platform check:types
pnpm --filter @purin-labs/platform check:test-types
pnpm --filter @purin-labs/platform test
pnpm check:packages
pnpm test:units
pnpm portal:build
cargo test --workspace
git diff --check
```

`pnpm check:packages` runs the type check of each shared package, Punter and
the storefront. `pnpm test:units` runs the Platform unit suite, the Portal,
storefront and package suites and the Worker environment test. CI runs both.
In a new worktree, `pnpm test:units` needs the R2 files, `pnpm
async-control:build` and `pnpm --filter @purin-labs/platform contracts:media`.

Before a release that changes Slack ingress, model routes or Slack delivery,
run the live Slack journey against the deployed Worker. It needs a human user
token, the channel and the app user ID (see the script header):

```bash
pnpm --filter @purin-labs/platform slack:live-reply
```

Onboarding and lifecycle changes must include:

```bash
pnpm --filter @purin-labs/platform test:onboarding-closure
```

Commerce lifecycle changes must include:

```bash
pnpm --filter @purin-labs/platform test:commerce-lab
pnpm lab:reset
pnpm lab:seed
pnpm lab:scenario
pnpm lab:verify
```

Production keeps global records and each Organisation's records in two D1
databases, and the E2E suite does the same. `env.DB` holds only the global
records. An E2E file writes and reads Organisation records through
`organisationDatabase(id)` or `fixtureDatabase()` from
`tests/e2e/organisation-database.ts`. A fixture that writes an Organisation
row itself calls `publishGlobalOrganisation(id)` before it writes global rows
that name the Organisation, as onboarding does.
`check:test-types` checks the unit test files (`tsconfig.tests.json`) and then
the E2E files (`tsconfig.e2e.json`).
The Plan 24 cobot journeys build the controller simulator: set `MUJOCO_DIR`
to an SDK from `node scripts/bakery-robots/install-native-sdk.mjs <dir>`, or
`PANTRY_COBOT_CONTROLLER_BINARY` to a built `cobot-controller`. CI does the same.

Tests under `services/platform/tests` have additional guidance in their local
`AGENTS.md`. Review fixtures before preserving them. Delete tests that encode
retired behavior.

## Deployment

Production deploys use the platform package, after the fetch of the R2 files
([the production deploy runbook](docs/runbooks/platform-production-deploy.md)):

```bash
node scripts/repo-binaries.mjs fetch apps/portal/public/bakery-physics
node scripts/repo-binaries.mjs fetch assets
pnpm --filter @purin-labs/platform run deploy
```

That command builds the contracts and portal. It then deploys six Workers in
this order: the Code Mode sandbox Worker (`pantry-code-sandbox`), the
model exit Worker (`pantry-model-exit`), the ChatGPT exit Worker
(`pantry-chatgpt-exit`) with its container, the 1Password store Worker
(`pantry-vault-onepassword`, Plan 79), the Platform Worker (`pantry`) with its
configured containers, and the Slack ingress Worker (`pantry-slack-ingress`).
The commerce engine (`pantry-commerce`), the docs site (`pantry-docs`) and the
shop (`purin-shop`) deploy with their own packages. The Platform Worker binds
the sandbox class, both exit Workers and the 1Password store Worker by name,
so they deploy first. A Platform upload to production refuses a Portal build
without the shop gateway builds: before an upload of the Platform alone, run
`bash services/shop-gateway/build.sh` (Docker), then `pnpm portal:build`. Read
[the sandbox release runbook](docs/runbooks/code-mode-sandbox-release.md)
before a release that changes the sandbox Worker or the pinned Pi packages.
Read [Plan 73](docs/plan-73-model-exit-worker.md) and
[Plan 75](docs/plan-75-chatgpt-exit-container.md) before a release that
changes an exit Worker, its host list, its container or its placement.
The release guard (Plan 93) refuses every deployment of a Worker that is not
in `WORKER_NAMES` of `scripts/worker-environment.mjs`, a `workers.dev` or
preview address, a route other than the Worker's custom domain, and a D1 or
KV id that the stack has not made. Never add an old Worker name to that list.
A change of a Worker name, a public origin or an OAuth callback path is a
release of its own: add each new callback at each provider first.

## Persistence

D1 schema lives in replaceable `0001_current_schema.sql` baselines while D1
databases are disposable. The Worker binds two databases:
`services/platform/migrations-global` holds global identity, the ingress
directory and placement, and `services/platform/migrations-regional` holds each
Organisation's operational data. The E2E suite loads the two baselines into
two databases, as production does. Unit tests and local harnesses with one
database load `singleDatabaseSchema()` from
`services/platform/scripts/single-database-schema.mjs`, which builds it from
the two baselines. A change to a global or
regional baseline ships with a patch script in `services/platform/scripts/`
that names each table, index or trigger that it adds, alters or removes;
`pnpm lint:d1-patch` refuses a change without one. Apply the patch to each
bound database before the release. `pnpm --filter @purin-labs/platform d1:schema:remote:check`
(and `node scripts/run-worker.mjs platform schema local`) compares every bound
database with its baseline and names what is missing. The same check fails when an
Organisation lacks a policy row for a catalogue capability: apply
`node scripts/capability-policy-backfill-sql.mjs` to that regional database. Durable Object schema upgrades live with the owning
DO. Convert raw D1 and request records into precise domain types at the
boundary.

## Execution contract

`AgentSessionActor` pins one of its inference authorities for each session,
and every route runs Pi. Organisation-funded `organisation_subscription` +
`openai` turns call the ChatGPT backend with the organisation's ChatGPT
sign-in, through the ChatGPT exit container. The Worker signs in with a device code, and the Session refreshes the
token under a lease on `organisation_codex_connection`, because OpenAI rotates
refresh tokens. Organisation-funded `organisation_byo` turns use a
purpose-bound, Vault-encrypted API key of OpenAI, Anthropic or Google. Purin-funded `platform` +
`openai-compatible` turns use `OPENROUTER_API_KEY`. The Actor owns accepted
history, Tool Host authority, checkpoints, budgets, cancellation, and delivery.
Pi Durable owns Pi tasks in Actor SQLite and restores from the Actor-owned
native checkpoint. Actor alarms recover supported unfinished tasks with fresh
leases. Unknown usage and uncertain effects block replay until reconciled.
Missing or exhausted authority fails the pinned route; no route falls back to
another funding authority.
Direct capabilities and workspace operations remain in the trusted platform.
Code Mode handles bounded composition. A Pi script runs in the QuickJS VM of
the `CodeModeSandbox` Worker, and Pi replays it from its journal after a
process loss. The Actor admits
each nested call and each replayed result. Linux-heavy work
materializes an immutable workspace revision in `WorkspaceExecutorContainer`,
returns artifacts plus a validated changeset, and releases the executor. Raw
provider credentials never enter generated code, prompts, transcripts, or
executor storage.

## Current request flow

1. Slack sends a signed event to `/slack/events`.
2. The Worker verifies the event and durably admits interactive Case work to
   `ConnectorActor` before acknowledging it. The actor starts work immediately;
   its alarm recovers expired leases and scheduled retries.
3. `ConnectorActor` deduplicates provider ingress and addresses a `CaseActor`.
4. `CaseActor` owns shared context, assignments, accepted proposals, and its
   durable output outbox.
5. `AgentSessionActor` runs Pi on the pinned route, persists every
   accepted event, and exposes a cursor-based replay stream. It allocates a
   heavy executor only when the requested work requires one.
6. `ConnectorActor` streams the answer into the Slack thread. Each part waits
   until the turn's current information-flow binding passes the destination
   check. A short answer is one post. The final cumulative binding must pass
   before the stream ends, and the provider receipt settles the exact Case
   outbox entry.

Pantry owns organisation creation, members, invitations and request
eligibility ([Plan 95](docs/plan-95-pantry-own-accounts.md)). The portal uses
the native control plane for these and for provider OAuth, setup, readiness,
activation, rotation, disable, reconnect, archive, and restore operations.
