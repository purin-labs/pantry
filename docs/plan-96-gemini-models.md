# Plan 96 — Gemini models in Pantry

Status: accepted with the default decisions on 21 November 2026, when the
owner asked to implement it. Steps A1, A2, B1, B2 and B3 and the journeys of
B4 are built and on `dev` since 21 November 2026 (see "Steps done"). Nothing
is released: the owner chose on 21 November 2026 not to release part A yet. The release of B1 still
waits for D3: not before 27 November 2026, on the newest 1.6 patch.

Owner: the model routes (spec FND-04, "Agent harness and model routes").
Touches: [Plan 73 — model exit Worker](plan-73-model-exit-worker.md),
[Plan 88 — Jev](plan-88-satyr-funded-jev.md) (the meter of each Organisation),
[the sandbox release runbook](runbooks/code-mode-sandbox-release.md) (the Pi
upgrade), [Refactor 17](refactor-17.md) (file paths), and the AGENTS.md sections
"Active runtime" and "Execution contract".

## Goal

Pantry runs the Gemini 4 models of Google: Hydrogen, Carbon, Argon and Neon.

- Part A: the route that Seams pays for runs Gemini 4 Hydrogen in place of
  `moonshotai/kimi-k3`, through OpenRouter, on the current Pi 1.5.0.
- Part B: an Organisation adds its own Gemini API key. A person then picks one
  of the four models in each chat, as with the Claude models today.
- Every route keeps its own funding authority. No route falls back to another
  one.

Not in this plan:

- Vertex AI. In a Worker, Pi can use Vertex only with an API key, and its
  ADC token requests bypass the model exit Worker.
- A Gemini subscription sign-in. Pi has no provider for it.
- A model choice on the route that Seams pays for (decision D6).
- A quality evaluation. The owner tested the four models on 20 November 2026
  and rates all four above kimi-k3. The Plan 50 comparison was cancelled.

## Why

- The owner rates the four Gemini 4 models above kimi-k3.
- Gemini 4 Hydrogen costs about the same per turn as kimi-k3 (see "Cost of use").
- A local proof on 20 November 2026 ran Pantry's OpenRouter route on Pi 1.5.0
  with Gemini 4 Hydrogen and Gemini 3.8 Flash: 13 model calls, no error, $0.08.
  - Each model accepted all 111 Pantry tools (54.5 KB of schema) in one
    request, and each tool argument matched its schema.
  - A three-step tool loop completed. Pi kept the thought signatures and sent
    them back.
  - A history with no signatures that ended on a tool result continued with no
    error.
  - Code Mode gave valid scripts. The reasoning tokens and the costs matched the
    OpenRouter records.
  - The proof ran from a Mac, not from a Worker. The script and its result are
    in the side-session notes of 20 November 2026 (`gemini-proof/`).

## Facts (origin/dev `ebf2996`, 21 November 2026)

The paths are those on `ebf2996`. Refactor 17 can move a file;
`scripts/layers.json` gives its new place.

### Pi

- Pantry pins the six Pi packages at 1.5.0. Pi has the providers `google`
  (API `google-generative-ai`, `generativelanguage.googleapis.com/v1beta`) and
  `google-vertex` since its first `@earendil-works` release, 0.74.0.
- In Pi 1.5.x, both Google adapters throw an error when a call gives its own
  `fetch`. Every direct route of Pantry gives one: `reportingFetch` around
  `modelProviderFetch(env)`, which goes through the model exit Worker. So a
  direct Google route cannot run on Pi 1.5.x.
- Pi 1.6.0 (published 20 November 2026) adds a custom `fetch` to the Google
  adapters. Its catalog has the four models:

| Pi id               | Max output tokens | Thinking levels          | Price, USD per 1M tokens (input / output / cache read) |
| ------------------- | ----------------: | ------------------------ | ------------------------------------------------------ |
| `gemini-4-hydrogen` |            65,536 | low, medium, high, xhigh | 1.50 / 7.50 / 0.075                                    |
| `gemini-4-carbon`   |            32,768 | low, medium, high        | 2 / 10 / 0.10                                          |
| `gemini-4-argon`    |            32,768 | low, medium, high        | 2 / 10 / 0.10                                          |
| `gemini-4-neon`     |            65,536 | low, medium, high, xhigh | 3 / 15 / 0.15                                          |

- Each model has a context window of 1,048,576 tokens. No model has the `off`
  or `minimal` thinking level in Pi's map. On OpenRouter, `minimal` gave 0
  reasoning tokens in the proof.
- Google raises the price of Carbon and Argon to $4 / $20 on 1 December 2026.

### Region

- The Gemini API lists Japan and does not list Hong Kong. A request from Hong
  Kong fails with "User location is not supported for the API use". A Session
  Actor can run in `apac`, which includes Hong Kong.
- So a direct Gemini request must go through the model exit Worker
  `satyr-model-exit`, which runs near AWS Tokyo. Its host list
  (`MODEL_PROVIDER_HOSTS` in `model-exit/worker.ts`) has four hosts today and
  no Google host.
- OpenRouter calls Google from its own servers, so part A has no region
  limit. In the proof, OpenRouter sent Gemini 4 Hydrogen to Google AI Studio.

### The route that Seams pays for

- `PACKAGED_PI_MODEL = "moonshotai/kimi-k3"` in `actors/pi-model-transport.ts`.
  `PLATFORM_PI_MODELS` holds kimi-k3 and `qwen/qwen3.7-flash`, which the tests
  select with `PANTRY_PLATFORM_PI_MODEL`. `pi-embedded-adapter.ts` has one
  adapter for each.
- `createPiOpenRouterModel` sets a context window of 256,000 tokens, an
  output limit of the smaller of the allowance and 65,536, and a cost of 0.
- `organisationChatModelOptions` (`models/route.ts`) gives this route one
  option: the route's model, named by its raw OpenRouter id.
- **Defect.** `selectStoredConversationModel` (`chat/turn/model.ts`) calls
  `selectOrganisationChatModel`, which refuses a stored model that is not the
  route's model (`chat_model_invalid`). So a change of the default model fails
  the next turn of each open Portal chat on this route, with
  `MODEL_ROUTE_UNAVAILABLE_MESSAGE` (`chat/application.ts` line 318). The same
  check runs for a goal (`control/routes/chat-goal.ts`), a side Case
  (`chat/side-case-start.ts`), a cancel (`control/routes/chat/cancel.ts`) and a
  Case turn with a required route (`loadDirectCasePolicy` in
  `actors/case-direct-processing.ts`). A change of `PANTRY_PLATFORM_PI_MODEL`
  has the same effect today.
- A Session pins its model route in its contract. An unfinished turn restores
  only when an adapter still supports the pinned model
  (`embedded_harness_model_authority_unavailable` in
  `actors/session/harness-source.ts`).
- Execution billing records the funding (`platform`, selection
  `satyr_platform`) and the digest of the route. The fee policy is
  `customer_unpriced`, so no price table changes.
- The mail disclosure names `openrouter` as the recipient for this route. That
  does not change.

### The routes with an Organisation's own key

- `modelRouteSchema` (`packages/contracts/src/model-route.ts`): the
  `organisation_byo` variant takes `provider` `openai` or `anthropic`.
- `createEmbeddedHarnessModelRouteLease` (`actors/session/model-route.ts`)
  maps each route to a lease kind, for example
  `organisation_anthropic_api_key`. `resolvePiInferenceRoute` maps each lease
  to a `PiInferenceRoute` kind.
- `credential-vault/organisation-model-resolution.ts` (567 lines) holds two
  copies of the same code: one to store and resolve an OpenAI key, one for an
  Anthropic key. Each writes a `credential_ref` row with `provider`,
  `host_pattern` and `inject_as`.
- `executionFunding` (`account-platform/execution-billing.ts`) maps each key
  to a customer funding selection.
- The selection kinds are in `data/organisation-inference-selection.ts`. Three
  CHECK constraints in `migrations-regional/0001_current_schema.sql` name the
  providers: the selection kind (line 3419), the Gmail inference eligibility
  (line 3566) and the mail disclosure recipient (line 4401).
- The Portal key forms are in `features/integrations/inference.tsx` and
  `inference-actions.ts`. The control route is
  `control/routes/agents/inference.ts`, with its shapes in
  `packages/control-api/src/portal/inference.ts`. The Brain evaluation model
  list (`features/brain/evals-model.ts`, `control-api/src/evals.ts`) and the
  Slack reasoning setting (`slack-reasoning-effort.tsx`) also name the kinds.
- The Claude model choice is the pattern for part B:
  `ORGANISATION_ANTHROPIC_MODEL_OPTIONS` (`models/catalog.ts`),
  `PI_ANTHROPIC_EMBEDDED_HARNESS_ADAPTERS`, and the journey
  `tests/e2e/claude-model-choice-portal.test.ts`.

### Thought signatures

- Gemini 3 and later need a thought signature on each function call of the
  current turn. Pi keeps the signatures in its own transcript and checkpoint,
  so a `restore` and a `resume_turn` keep them.
- Pantry imports its own history into Pi for a new lineage, for example a fork,
  a side Case or a new model (`importHistory` in `actors/pi-durable-runtime.ts`).
  `actors/pi-history-adapter.ts` writes `continuation: { kind: "none" }` for each
  block, so it drops the signatures. The history type already has
  `{ kind: "opaque", value }` (`HarnessOpaqueContinuation`).
- OpenRouter accepted a history with no signatures in the proof. The direct
  Gemini API is not proven.

### Tool schemas

- `hostTool()` (`actors/pi-durable-tools.ts`) gives Pi no
  `constrainedSampling`, so `strict: true` reaches no provider on any route.
  Gemini gets plain function declarations (mode AUTO). The proof showed no
  invalid argument. This plan changes nothing here.

## Target design

### Part A: Gemini 4 Hydrogen on the route that Seams pays for

- Rename `PACKAGED_PI_MODEL` to `PLATFORM_DEFAULT_PI_MODEL`, with the value
  `google/gemini-4-hydrogen`. `PLATFORM_PI_MODELS` holds Hydrogen, kimi-k3 (only
  for turns that pin it) and `qwen/qwen3.7-flash` (tests). Each has one adapter.
- A stored chat model on this route follows the route's model. The person did
  not choose the stored model, because the route offers only one model. One
  change in `selectStoredConversationModel` covers the chat, goal, side Case
  and cancel paths. `loadDirectCasePolicy` gets the route that this selects.
- A message that names a model of `PLATFORM_PI_MODELS` runs on the route's
  model, because a page loaded before the release still names the earlier
  default. A message that names any other model is refused
  (`chat_model_invalid`) before a model request.
- A Slack thread keeps the model that its Session started with: the Session
  pins its route at its start (`initializedSession` in
  `actors/case-walking-path.ts`). A new thread starts on the new default. So
  an earlier default stays in `PLATFORM_PI_MODELS` while an open thread can
  pin it.
- The model option shows "Gemini 4 Hydrogen", not the raw id. The context
  window stays at 256,000 tokens. The effort options stay low, medium and high.
- The default thinking level stays `minimal`. The Slack reasoning setting still
  applies.
- No change to Pi, the sandbox Worker, D1, a Durable Object or the exit Worker.

### Part B: an Organisation's own Gemini API key

- Contract: `organisation_byo` takes `provider: "google"`.
- One provider table in `organisation-model-resolution.ts` replaces the two
  copies: for each of `openai`, `anthropic` and `google`, the host, the header,
  the credential name, the handle prefix and the error codes. One store function
  and one resolve function use it. The error codes keep their current values,
  for example `organisation_anthropic_credential_invalid`.
- The Google row: host `generativelanguage.googleapis.com`, header
  `x-goog-api-key`, provider `google` in `credential_ref`.
- Lease kind `organisation_google_api_key`, and a `PiInferenceRoute` kind
  `google` with `Model<"google-generative-ai">` and Pi's Google provider. Its
  `providerFetch` is the same as on the Anthropic route.
- The exit Worker adds `generativelanguage.googleapis.com` to its host list.
- Selection kind `organisation_google_api_key`. Billing maps it to a customer
  funding selection of the same name.
- `ORGANISATION_GOOGLE_MODEL_OPTIONS` holds the four models, with Hydrogen
  first (decision D4). The effort options are low, medium and high. The output
  limit comes from Pi's catalog: 32,768 for Carbon and Argon, 65,536 for
  Hydrogen and Neon. The context window is 256,000 tokens (decision D5).
- The Portal key form for Google says: "Use a key from a Google Cloud project
  with billing turned on." Reason: Google can use the content of free-tier
  Gemini API requests to improve its products.
- The three D1 CHECKs add `google`, with a patch script in
  `services/platform/scripts/` (`pnpm lint:d1-patch`).
- History: `pi-history-adapter.ts` writes the thinking signature and the
  signature of each tool call into `continuation: { kind: "opaque" }`, and gives
  them back to Pi on import. Pi decides whether a signature fits the model. The
  value stays in the same history entry, so the labels of that entry cover it
  (IFC). This also helps the Anthropic route, whose thinking blocks carry a
  signature.

### Agent access

- The chat agent does not add, read or remove a Gemini API key, and it does not
  change the inference source. The key is a secret, and the source decides who
  pays. The OpenAI and Anthropic keys have the same rule.
- A person picks the model in the chat menu. The agent tools do not change.

### Cost for an idle Organisation

- The plan adds no cron trigger, alarm, poll or queue message.
- A Google key writes rows only when a person saves or removes it.
- So an idle Organisation gets no new row, queue message, KV write or R2 write
  in 30 days. `tests/e2e/idle-tenant-cost.test.ts` must pass with its current
  budget.

### Cost of use

OpenRouter prices on 20 November 2026. An example turn has 30,000 input tokens,
of which 20,000 come from the cache, and 1,500 output tokens. Reasoning tokens
count as output.

| Model                                  |                   Example turn | Per 1,000 turns |
| -------------------------------------- | -----------------------------: | --------------: |
| `moonshotai/kimi-k3` (today's default) |                         $0.030 |             $30 |
| `google/gemini-4-hydrogen`             |                         $0.028 |             $28 |
| `google/gemini-4-carbon` or `argon`    | $0.037; $0.074 from 1 December |        $37; $74 |
| `google/gemini-4-neon`                 |                         $0.056 |             $56 |

- Part A: Seams pays OpenRouter. The cost per turn does not change.
- Part B: the Organisation pays Google. Seams pays nothing.

## Steps

Each step lands on `dev` alone, with its checks. Part A does not wait for
part B.

### A1. A stored model follows the route that Seams pays for

- Change `selectStoredConversationModel` and `selectOrganisationChatModel` as
  in the design.
- Journeys, on the model fake of the platform-route journeys. Each sets
  `PANTRY_PLATFORM_PI_MODEL` to kimi-k3 for the time before the release and
  removes it for the release:
  - J1 (`platform-model-change.test.ts`): a Portal chat that kimi-k3 answered
    opens with "Gemini 4 Hydrogen" in its menu. A message from a page that
    still names kimi-k3 gets one answer from Hydrogen. A message that names
    another model is refused before a model request. Without the change, the
    chat shows "Connect the workspace's selected AI provider in Integrations
    before chatting."
  - J2 (`slack-model-change.test.ts`): an open Slack thread gets its next
    answer in the same thread, on kimi-k3, with its history. A new thread gets
    its answer from Hydrogen.
- Checks: `check:types`, the two journeys, the changed journey files.

### A2. Gemini 4 Hydrogen as the default

- Change the constants and the adapters, and add the display name.
- Run the live Slack journey (`slack:live-reply`) on Hydrogen. AGENTS.md
  requires it for a change of a model route.

### A3. Release part A

- Deploy the Platform Worker alone, by the production deploy runbook.
- Production proof: one live Slack answer with a tool call, and one Portal chat
  that started before the release answers its next message.
- Rollback: set the Worker variable `PANTRY_PLATFORM_PI_MODEL` to
  `moonshotai/kimi-k3`. After A1, open chats keep their work.

### A4. One week after A3

- Compare the OpenRouter spend per day with the week before A3.
- Keep kimi-k3 in `PLATFORM_PI_MODELS`. An open Slack thread pins it for
  the life of its Session (J2), and a removal fails that thread's next message
  with `embedded_harness_model_authority_unavailable`.
- A removal needs its own step first: a Session whose pinned model left the
  list continues in a new lineage on the current default, with the thread's
  history. Propose that step only when kimi-k3 must go, for example when
  OpenRouter stops it.

### B1. Pi 1.6 upgrade

- Not before 27 November 2026, on the newest 1.6 patch (decision D3).
- Follow the sandbox release runbook. The sandbox Worker and the Platform
  Worker both go out, in the order of the runbook. On 3 November 2026, an upload
  of the Platform Worker alone left the sandbox on the old Pi.
- Run the Pi journeys (34 files on `ebf2996`). The 1.5 upgrade needed adapter
  changes that only the journeys found.
- Rollback: the Platform and sandbox versions before B1. A turn that started on
  1.6 and is not finished at a rollback fails. That is the same rule as for 1.5.

### B2. The Google key route in the Platform

- The contract, the merged credential module, the lease, the Pi route, the exit
  host, billing, the selection kind, the catalog and the adapters.
- The D1 patch script, applied to each regional database before the release.
- The history signatures.

### B3. The Portal

- The Google key form, the model menu, the Brain evaluation list and the Slack
  reasoning setting. Use the components in `apps/portal/src/ui/`.

### B4. Journeys and the live check

- J3: an owner saves a Gemini key. The chat menu offers the four models, and a
  new chat starts on Hydrogen. A chat on Carbon at high effort reaches the Gemini
  API through the exit Worker with that model and level. A model that the menu
  does not offer is refused before a request leaves. A tool loop of two calls
  completes, and its use settles.
- J4: a fork of a chat that ended on a tool call continues on Gemini. The
  request carries the signature from the history.
- J5: a member without the right to change the inference source cannot save a
  Gemini key.
- Live check: one turn with a tool loop through the deployed exit Worker on a
  real Gemini API key that the owner gives for this purpose.

### B5. Release part B

- Deploy the model exit Worker first, then the Platform Worker. Read Plan 73
  before the release, because the host list changes.
- Update the AGENTS.md sections "Active runtime" and "Execution contract" in
  the same commit.
- Production proof: the live check of B4 on production, and the live Slack
  journey.

## Steps done

| Step | What exists                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `selectStoredOrganisationChatModel` in `models/route.ts`: a stored chat on the paid route follows the route's model, and a message that names a model of `PLATFORM_PI_MODELS` runs on the route's model. Journeys J1 and J2 pass, and J1 fails without the change                                                                                                                |
| A2   | `PLATFORM_DEFAULT_PI_MODEL` is `google/gemini-4-hydrogen`, with the Portal name "Gemini 4 Hydrogen". `PLATFORM_PI_MODELS` is one table of the three models and their names, with one adapter for each. 32 test files take the default from the constant in place of a literal kimi-k3 id. Two digest tests keep the literal kimi-k3 route, because a stored digest must not move |

| B1 | Pi 1.6.0 in the six packages. `chord` exports `Context` and `JsonValue` from subpaths; a parked Code Mode result ends the script as a failure; `PI_DURABLE_BUILD` and the sandbox package pin name 1.6.0, and the sandbox runbook values are current. The 30 Pi and Code Mode journey files pass |
| B2 | One provider table in `credential-vault/organisation-model-resolution.ts` replaces the copies for OpenAI and Anthropic, and adds Google (`x-goog-api-key`, `generativelanguage.googleapis.com`). One route resolver, one lease branch and one key path serve the three providers. The contract, the selection kind, the Pi route (context window 256,000), the four adapters, the exit host, the three D1 CHECKs with `scripts/plan-96-gemini-key-d1-patch.sql`, and the history signatures with their provider, API and model |
| B3 | The Portal source list has "Gemini API key" with the billing note, and every source label names it. The two copies of the selection union in Portal and the two selection parsers in `control-api` are one each |
| B4 | `gemini-key-portal.test.ts` (J3, J4): the menu, a Hydrogen chat, a Carbon chat at high effort with a signed tool call, the refusal of a model that the menu does not offer, and a fork whose first request carries the signature from the history. J4 fails without the history change. No new J5: the inference route's admin check is the same for each provider |

Billing: the Console contract names no Gemini key, so a Gemini key turn settles in
Pantry unpriced, as every turn does in production. Only the E2E test meter differs.
Plan 95 step 3 deletes `execution-billing.ts` and this exception.

Checks on 21 November 2026: `check:types`, the E2E type check, every lint, the Platform
unit suite (1,732 tests) and the full E2E suite (241 files, 465 tests). One journey,
`counter-receipt-printer.test.ts`, failed once under the load of the full suite and passed
twice alone; it uses no model route.

Checks of part B on 21 November 2026: both type checks, the Portal and `control-api`
type checks, every lint, the changed unit tests, the 30 Pi journey files and 11 journey
files of the key routes, history and forks, then the Platform unit suite (1,730 tests)
and the full E2E suite (242 files, 460 tests passed, 6 skipped).

Not done: the live Slack journey on Hydrogen (A2), the releases (A3, B5), the check of A4,
and the live Gemini check of B4. They need the owner's approval for a production change,
and B4 needs a Gemini API key from the owner.

## Decisions

| Id  | Question                                           | Recommendation                                                                                 | Cost                                                                        | Default        |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------- |
| D1  | The default model of the route that Seams pays for | Gemini 4 Hydrogen                                                                              | $28 per 1,000 turns, against $30 now. Carbon: $37, then $74 from 1 December | Hydrogen       |
| D2  | Open chats on that route after the change          | Portal chats move to the new default at their next message. Open Slack threads stay on kimi-k3 | None. kimi-k3 costs the same per turn                                       | As recommended |
| D3  | When to upgrade Pi to 1.6                          | Not before 27 November 2026, on the newest 1.6 patch, in its own release                       | About one day of adapter work and journeys, plus a sandbox release          | As recommended |
| D4  | The first model of the Google key route            | Hydrogen; the menu offers all four                                                             | None. The Organisation pays Google                                          | Hydrogen       |
| D5  | The context window on the Google key route         | 256,000 tokens, as on the other routes                                                         | A full 1,048,576-token turn on Neon costs about $3 of input                 | 256,000        |
| D6  | A model choice on the route that Seams pays for    | Not in this plan. It needs a meter and a limit for each Organisation, as Jev has (Plan 88)     | Carbon from 1 December costs 2.5 times kimi-k3 per turn                     | No choice      |

## The owner's actions

- Decide D1 to D6. If the owner does not answer, the plan uses the defaults.
- Before B4: give a Gemini API key from a Google Cloud project with billing.
  Put it in `.env.local` as `GEMINI_API_KEY`. Nobody prints it.
