# FND-04 — Agent harness and model routes

Each Sous Chef turn in Purin Pantry runs in one harness, Pi, inside the Platform Worker.
A harness adapter joins Pi to `AgentSessionActor`, which owns the history, the leases,
the checkpoints and the budget. Each Session pins one model route. The route names who
pays for the model and which credential signs the request. A route never falls back to
another route. An Organisation selects one inference source: Purin AI, a ChatGPT
sign-in, a Claude account, or its own OpenAI, Anthropic or Gemini API key. Each direct
request to a model provider leaves Cloudflare through an exit Worker near Tokyo. The
OpenRouter route of Purin AI goes direct.

## What it does

### The harness adapter

- `selectEmbeddedHarnessAdapterForModelRoute` gives one Pi Durable adapter for each
  route and model. An adapter has a manifest: the backend `pi`, the build
  `PI_DURABLE_BUILD`, the checkpoint format and the model.
- The selection gives a `Result`. It is `embedded_harness_model_unsupported` when the
  list of the route does not have the pinned model, or the model has no adapter. A
  stored pin is data, so this is not a programmer error. The OpenAI key route has no
  such check: the selection gives the `gpt-5.6-luna` adapter for each model. The
  selection is `embedded_harness_provider_unsupported` for a pair that is not in the
  table below.
- A Session whose pinned model left its list continues on the current route. The Case
  sends the route of the message with each text turn (`currentModelRoute`), and the
  turn start takes that route when the pinned one has no adapter and the harness build
  is the same (`sessionOnRunnableRoute`). The `accept_input` command carries the new
  route, the changed route digest starts a fresh lineage with the Session's history,
  and the next turns keep the new route. A mail, mail assistant or WhatsApp turn runs
  in a Session of its own, made for that turn on the Organisation's current route, so
  it never runs on a model that left the list: a WhatsApp answer comes from the current
  default at once, and Gmail mail waits until an owner or admin accepts the terms of the
  new default (INB-01). A checkpoint restore of a Session whose pinned model left its
  list and a new Session on a route with no adapter refuse with
  `embedded_harness_model_unsupported` and make no model request.
- The Session reports `embedded_harness_model_authority_unavailable` when the model of
  the adapter is not the pinned model, when it cannot make the route lease (the
  placement is not active), or when the turn is not active.
- The Actor constructs a runtime with the accepted input, the model, the token
  allowance, the instructions, the route lease, the checkpoint binding, the Tool Host,
  the two sinks and the turn lease. The source of a runtime is `fresh`, `resume_turn`,
  `fresh_after_abandoned_inputs`, `fresh_lineage` or `restore`.
- Persistence is `actor` (Session SQLite) or `transient` (no durable history, for
  example an email turn).
- The adapter writes through two Actor sinks. `appendHarnessHistory` accepts completed
  user, assistant, tool-call and tool-result entries. `acceptCanonicalHarnessEvent`
  accepts progress and terminal events. The Actor refuses a stale lease or cursor.
- The adapter gets no Actor namespace, no control token, no raw D1 access and no
  executor.
- The backends `codex` and `picocodex` are retired. Their checkpoints start a fresh
  lineage.

### Model routes

| `keySource` + `provider`               | Inference source                 | Lease kind                          | Pi provider                                   | Leaves through                         | Models                                                                              |
| -------------------------------------- | -------------------------------- | ----------------------------------- | --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `platform` + `openai-compatible`       | `pantry_platform` ("Purin AI")   | `platform_api_key`                  | OpenRouter                                    | The Worker itself                      | `google/gemini-4-hydrogen` (default), `moonshotai/kimi-k3`, `qwen/qwen3.7-flash`    |
| `organisation_byo` + `openai`          | `organisation_openai_api_key`    | `organisation_openai_api_key`       | OpenAI                                        | Model exit Worker                      | `gpt-5.6-luna`                                                                      |
| `organisation_byo` + `anthropic`       | `organisation_anthropic_api_key` | `organisation_anthropic_api_key`    | Anthropic                                     | Model exit Worker                      | `claude-opus-5-5`, `claude-sonnet-5-5` (default), `claude-sonnet-4-6`               |
| `organisation_byo` + `google`          | `organisation_google_api_key`    | `organisation_google_api_key`       | Google (Gemini API)                           | Model exit Worker                      | `gemini-4-hydrogen` (default), `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon` |
| `organisation_oauth` + `anthropic`     | `claude_oauth`                   | `organisation_claude_oauth`         | Anthropic                                     | Model exit Worker                      | The three Claude models                                                             |
| `organisation_subscription` + `openai` | `codex_subscription`             | `organisation_chatgpt_subscription` | OpenAI, or the legacy `openai-codex` provider | Model exit Worker, or the ChatGPT exit | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (default)             |

- The Session contract pins the route. A subscription route also pins the connection
  revision and the profile generation. An OAuth route pins the connection id. A key
  route pins the Vault handle of the key (`byoKeyRef`).
- The lease reads the key or the token for each model request, and only while the
  placement of the Organisation is active. A failed read sends no request.
- A missing credential, an exhausted allowance or a transport failure fails the pinned
  route. The harness selects no other route.
- With no stored selection, the inference source is `codex_subscription`.
- `PANTRY_PLATFORM_PI_MODEL` selects another model of `PLATFORM_PI_MODELS` for the
  Purin AI route. Tests use it. An earlier default stays in the list while a Session
  can pin it.
- On OpenRouter, the context window is 256,000 tokens and the output limit is the
  smaller of the allowance and 65,536 tokens. On the Gemini key route, Pantry lowers
  the context window of Pi's model to 256,000 tokens.
- Pi's own retries are off (`maxRetries` 0). Each failed model request writes the trace
  `pi.model_request_failed` with the route, the model and the HTTP status, and never the
  provider's error text, which can quote the request. An OpenRouter request sorts the providers
  by throughput and sends session affinity headers. The legacy `openai-codex` provider
  uses SSE.

### Models and effort

- The model menu of a Portal chat comes from `organisationChatModelOptions`. The Purin
  AI route and the OpenAI key route offer one model. The other routes offer their list.
- Effort options are `low`, `medium` and `high`. The ChatGPT route offers only `high`.
  The Portal default is `medium` when the model offers it.
- When a caller gives no level, Pi runs at `minimal` on OpenRouter and at `high` on the
  key routes and the Claude account route. The ChatGPT route always runs at `high`.
- A stored chat on the Purin AI route follows the model of the route. A message that
  names a model of `PLATFORM_PI_MODELS` runs on the model of the route. Another model
  name is refused with `chat_model_invalid`, before a model request.
- In the AI account drawer, a Claude or ChatGPT source whose account is not connected
  has no save button. When an admin chooses it and its sign-in connects the account,
  the drawer selects the source with the same `PUT` and the same checks.
- When an admin changes the inference source, an open Portal chat does not move to the
  new source. Its next message gets HTTP 409 `chat_model_changed`, and a queued message
  becomes a failed turn that the person can retry. Steering needs a stored route that
  is equal to the current route. A new chat uses the new source.
- An open Slack thread keeps the model that its Session pinned. A new thread starts on
  the current route. When the pinned model leaves the list, the thread's next message
  continues on the current route, with the thread's history.
- An admin sets one effort for Slack answers, in the Slack drawer of the Portal. It
  applies to the next Slack turn, also in an open thread, when the model of the route
  offers that effort.

### The ChatGPT sign-in

1. An owner starts "Sign in with ChatGPT" in the Portal. The Portal shows an OpenAI
   address. The attempt ends after 15 minutes. An Organisation has one open attempt.
2. The owner approves Pantry at OpenAI and pastes the address of the callback page
   into the Portal. Pantry exchanges the code at `auth.openai.com`.
3. Pantry stores the tokens as one Vault secret. The connection becomes `connected`,
   with a new revision.

- A pasted address that is not the callback of the attempt leaves the attempt open
  (HTTP 422 `codex_sign_in_address_invalid`), and so does an OpenAI outage (HTTP 503
  `codex_sign_in_unavailable`). A missing scope ends the attempt with
  `codex_plan_usage_not_allowed`. A later sign-in uses again the client and the host
  id that OpenAI issued.
- A connection is `disconnected`, `authorizing`, `connected` or `action_required`. The
  reasons are `authorization_expired`, `workspace_access_revoked`,
  `device_authorization_unavailable` and `account_unavailable`.
- A model request of this sign-in runs on Pi's OpenAI provider (lease `api`
  `openai_responses`). That provider calls `api.openai.com`. The host is in the Pi
  package, and the model exit Worker accepts it.
- A token that ends within 5 minutes refreshes before its use. OpenAI rotates the
  refresh token, so one request holds the refresh lease and the others wait.
- The connection becomes `action_required` with `authorization_expired` in four
  cases: OpenAI refuses the refresh, a refresh lease ends with no published token, the
  Vault cannot store the new tokens, or an owner reconnects.
- The 15-minute cron refreshes each connected sign-in that is older than 7 days, for
  an active Organisation only. One run refreshes at most 50 sign-ins in each database.
  The query does not look at the kind of the sign-in.
- The allowance comes from the `x-codex-*` headers of a model response. It is
  `not_reported` or `available`, with the used percentages and the reset times.
- A 401 answer sets a Codex device-code connection to `account_unavailable`. It does
  not change a "Sign in with ChatGPT" connection.
- A reconnect fences the connected profile and starts a new attempt. A disconnect
  revokes the Vault secret, cancels the open attempt and deletes the connection row.
- The code keeps the earlier Codex device-code sign-in (`codex_device`, lease `api`
  `chatgpt_backend`). The Portal does not start it. Its model requests run on Pi's
  legacy `openai-codex` provider, which calls `chatgpt.com` (the host is in the Pi
  package).
- A Codex device-code sign-in cannot refresh. Its refresh attempt sets
  `action_required` with `authorization_expired`: at a turn when its token ends within
  5 minutes, or at the cron 7 days after the sign-in. The owner then signs in again.

### The Claude account and the API keys

- An admin connects a Claude account with a pasted authorization code. The attempt
  ends after 10 minutes, and only the user who started it can complete it. Pantry
  exchanges and refreshes the tokens at `platform.claude.com`. One request holds the
  refresh lease. A refused refresh sets `action_required`.
- An admin saves an API key together with the selection of its source. A key has 20 to
  4,096 characters. An Anthropic key starts with `sk-ant-`. A new key revokes the key
  that it replaces. The Portal does not show a saved key again.
- The Portal note for a Gemini key tells the admin to use a Google Cloud project with
  billing turned on.
- A change of the source names the current configuration version. Another version
  gets HTTP 409 `configuration_version_conflict`.
- An Organisation that is `activating`, `suspended`, `archived`, `purging` or `purged`
  gets HTTP 409 `organisation_lifecycle_conflict` for a change of the source. The same
  rule applies to `POST` and `DELETE /claude`.
- Pantry stores a new key, and revokes the earlier key, before the route check. A
  change of the source on an active Organisation then succeeds only when the new route
  resolves. If not, the route answers with a code such as `codex_subscription_required`
  or `organisation_google_api_key_required`.

### The exits

`modelProviderFetch(env)` gives the fetch of a direct provider request. It sends a
`chatgpt.com` request to the binding `CHATGPT_EXIT` and each other request to
`MODEL_EXIT`. Sign-in, refresh and model requests all use it.

|                          | Model exit Worker                                                                                                                                 | ChatGPT exit Worker                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Name (production, local) | `pantry-model-exit`, `pantry-model-exit-local`                                                                                                    | `pantry-chatgpt-exit`, `pantry-chatgpt-exit-local`                               |
| Placement                | `aws:ap-northeast-1`                                                                                                                              | `aws:ap-northeast-1`                                                             |
| Bindings                 | The variable `PANTRY_DEPLOYMENT_PROFILE` only                                                                                                     | That variable, and `CHATGPT_EXIT_CONTAINER` for the class `ChatGptExitContainer` |
| Accepts                  | HTTPS on the default port to `auth.openai.com`, `api.openai.com`, `api.anthropic.com`, `platform.claude.com`, `generativelanguage.googleapis.com` | `chatgpt.com`; the container forwards only HTTPS paths under `/backend-api/`     |
| Refuses                  | Each other host: HTTP 403, `model_exit_host_refused`                                                                                              | Each other host: HTTP 403, `chatgpt_exit_host_refused`                           |
| Script limit             | 64 KiB, no Wasm                                                                                                                                   | 96 KiB, no Wasm                                                                  |

- Each exit has no public route and no state, and its Wrangler profile has no
  credential binding. Invocation logs are off.
  An exit never logs a header, a body or a token. It does not retry, and it returns a
  redirect to the caller.
- The model exit Worker removes the `cf-*` request headers and streams the response
  body back. It logs the host and the status (`model_exit.forwarded`) with the data
  centre of the provider (`provider_colo`), or `model_exit.host_refused`.
- All Organisations share one container: a `lite` instance in the region `APAC`,
  `max_instances` 1, Actor name `chatgpt-exit`, location hint `apac-ne`. It sleeps after
  one idle hour. Node 24 runs `server.mjs` and the shared `forward.ts`.
- The container answers HTTP 503 `chatgpt_exit_location_refused` when its trace
  location is `CN`, `HK` or `MO`, and `chatgpt_exit_location_unknown` when the trace
  read fails or names no country. It keeps only a location that names a country, so
  the next request reads an unknown location again.
- Each exit names its data centre in the response header `x-pantry-exit-colo`
  (`unknown` when it is not known). A refused ChatGPT model request adds it to the trace
  `session.chatgpt_model_request_refused` as `exit_colo`.
- The deploy command sends six Workers in this order: the Code Mode sandbox, the model
  exit, the ChatGPT exit, the 1Password store, the Platform (`pantry`) and the Slack
  ingress. The Platform binds each exit by name.

### Tools, replay and the answer

- Pi gets the tools of the accepted catalog. The Session makes the Tool Host from the
  capability keys of the assignment and the catalog digest of the turn. Code Mode is
  one tool. FND-09 owns the check of each call and the admission of each nested call.
- Each tool has a replay rule for a call that a lost process left in flight:
  `any_caller` (a repeat is safe), `script` (only a Code Mode script may repeat it) or
  `none` (the turn waits).
- The adapter streams answer text in parts of 256 characters or 250 ms. In one SQLite
  transaction, the Actor sink writes each accepted event to `turn_delivery_segment`
  and to `session_event`, the table of the Session event stream. A transient runtime
  stores no event.
- `steer` adds a message from the requester of the turn. The result is `queued` or
  `refused` (`turn_not_running`, `steering_unsupported`). A transient runtime refuses.
- `stopAtNextStep` ends a turn before its next model call. `cancel` marks the turn as
  cancelled and aborts the Pi run. A closed runtime answers `cancel` with success.
- Pi compacts a long transcript in the turn. Background compaction is off.
- For a new lineage, Pantry imports its own history into Pi. A history entry keeps the
  signature of a thought, a text or a tool call with the provider, the API and the
  model that wrote it. Pi gets a signature back only for that same model.

### Checkpoint and lineage

- The checkpoint copies the Pi Durable tables of Session SQLite, with the checkpoint
  binding and the history cursor. Restore refuses another session, binding or cursor.
- `classifyHarnessCheckpoint` gives `compatible` or `fresh_lineage_restart`. The
  reasons are `backend_mismatch`, `build_mismatch`, `format_mismatch` and
  `model_route_digest_mismatch`. A fresh lineage starts from the accepted history.
- So a new model, a new key, a reconnect or a new Pi build starts a fresh lineage.

| Failure                                             | Result                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The key or the token cannot be read                 | No request; `embedded_harness_model_credential_unavailable` or the code of the connection                                                   |
| The provider answers with an error status           | The request counts as zero tokens                                                                                                           |
| The provider refuses for an exhausted allowance     | `embedded_harness_model_usage_missing` with `refusal: "authority_exhausted"`. Any HTTP 402 counts, also a Gemini key with no prepaid credit |
| Model usage is missing                              | `embedded_harness_model_usage_missing`; the Session marks the run budget as indeterminate (`model_receipt_missing`)                         |
| The token allowance is used                         | `embedded_harness_token_budget_exhausted`                                                                                                   |
| A harness event is malformed, stale or out of order | The Actor sink refuses it (`harness_event_invalid`, `harness_event_stale`, `harness_event_gap`)                                             |

## Contracts

- `ModelRoute` (`packages/contracts/src/model-route.ts`) and the `modelRoute` field of
  the Session contract (`packages/contracts/src/session-schemas.ts`).
- The adapter contract: `foundation/agent/actors/embedded-harness.ts`. The
  selection: `actors/embedded-harness-adapter.ts` and `actors/pi-embedded-adapter.ts`.
- Pi: `actors/pi-durable-runtime.ts`, `pi-model-transport.ts`, `pi-durable-tools.ts`,
  `pi-tool-replay.ts`, `pi-history-adapter.ts`, `pi-durable-checkpoint.ts` and
  `pi-durable-recovery.ts`. The six `@earendil-works` packages are pinned at 1.6.0 in
  `workers/platform/package.json`.
- The lease: `createEmbeddedHarnessModelRouteLease` in `actors/session/model-route.ts`.
- Routes, models and connections (`foundation/agent/models/`): `route.ts`,
  `catalog.ts`, `codex-connection.ts`, `chatgpt-agent-oauth.ts`, `chatgpt-oauth.ts`,
  `claude-connection.ts` and `claude-oauth.ts`.
- Keys: `credential-vault/organisation-model-resolution.ts`, with one row for each of
  `openai`, `anthropic` and `google` (host, header, prefix).
- Exits: `src/model-exit/` (`worker.ts`, `provider-fetch.ts`, `protocol.ts`),
  `src/chatgpt-exit/` (`worker.ts`, `forward.ts`), `services/chatgpt-exit/`
  (`Dockerfile`, `server.mjs`), `wrangler.model-exit.jsonc` and
  `wrangler.chatgpt-exit.jsonc`. The checks are `model-exit:check`
  (`scripts/model-exit-worker.mjs`) and `chatgpt-exit:check`
  (`scripts/chatgpt-exit-worker.mjs`). The profile rules of each check are in
  `scripts/worker-environment.mjs`.
- Portal: `areas/integrations/ui/features/integrations/` (`inference.tsx`, `codex.tsx`,
  `claude-connection.tsx`, `slack-reasoning-effort.tsx`). The shapes are in
  `packages/control-api/src/` (`portal/inference.ts`, `agents.ts`, `claude.ts`,
  `chat.ts`, `slack-reasoning-effort.ts`).
- `scripts/layers.json` puts the harness, the lease, `models/`, the control routes of
  the source and the connections, and the two exit folders in the module
  `foundation/agent`. The other files are in other modules: the Portal pages in
  `areas/integrations`, `credential-vault/` in `foundation/authority`, the route
  `slack-reasoning-effort.ts` in `surfaces/slack`, `services/chatgpt-exit/` in
  `workers/chatgpt-exit`, and the two packages in `foundation/contracts`.

Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`):

| Table                                      | Holds                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `organisation_inference_selection`         | The selection kind, the user and the time                                                                          |
| `organisation_slack_reasoning_effort`      | The effort for Slack answers                                                                                       |
| `organisation_codex_connection`            | The lifecycle, the revision, the profile handle and generation, the plan type, the allowance and the refresh lease |
| `organisation_codex_authorization_attempt` | An attempt: `awaiting_user`, `connected`, `cancelled`, `failed` or `expired`                                       |
| `organisation_claude_connection`           | The connection: `connected`, `refreshing` or `action_required`                                                     |
| `organisation_claude_authorization`        | An attempt: `pending` or `exchanging`                                                                              |
| `credential_ref`                           | The model key of a provider, under the name `model`                                                                |

Session SQLite (`actors/agent-session-harness-authority.ts`): `session_harness_lease`,
`session_harness_history`, `session_harness_checkpoint`,
`session_harness_checkpoint_payload`, `session_harness_usage` and
`turn_delivery_segment`. Pi adds its own tables and `pantry_pi_usage`.

Vault handle kinds: `vault:chatgpt_agent_profile:`, `vault:chatgpt_agent_sign_in:`,
`vault:codex_auth_profile:` and `vault:codex_device_authorization:`.

The control routes are under `/v1/control/organisations/:id/inference`. The Role column
gives the lowest role. The order is viewer, operator, admin, owner.

| Route                                                  | Role          | Purpose                                                               |
| ------------------------------------------------------ | ------------- | --------------------------------------------------------------------- |
| `GET`, `PUT`                                           | Viewer, admin | Read or change the inference source. A key source also takes `apiKey` |
| `GET`, `PUT` `/slack-reasoning-effort`                 | Viewer, admin | Read or change the effort for Slack answers                           |
| `GET /codex`                                           | Viewer        | The ChatGPT connection, the open attempt and the allowance            |
| `POST /codex/authorizations`, `POST /codex/reconnect`  | Owner         | Start a sign-in, or fence the connection and start one                |
| `POST /codex/authorizations/:attemptId/complete`       | Owner         | Finish the sign-in with the pasted address (`callbackUrl`)            |
| `POST /codex/authorizations/:attemptId/cancel`         | Owner         | Cancel the open attempt                                               |
| `DELETE /codex`                                        | Owner         | Disconnect                                                            |
| `GET /claude`                                          | Viewer        | The Claude connection and the open attempt                            |
| `POST /claude` (`start`, `complete`), `DELETE /claude` | Admin         | Connect or disconnect the Claude account                              |

This subsystem has no event kind, no capability and no agent tool.

## Rules and limits

| Action                                             | Viewer | Operator | Admin | Owner | Agent |
| -------------------------------------------------- | ------ | -------- | ----- | ----- | ----- |
| Read the source, the connections and the allowance | Yes    | Yes      | Yes   | Yes   | No    |
| Change the source, save an API key                 | No     | No       | Yes   | Yes   | No    |
| Set the effort for Slack answers                   | No     | No       | Yes   | Yes   | No    |
| Connect or disconnect the Claude account           | No     | No       | Yes   | Yes   | No    |
| Connect, reconnect or disconnect ChatGPT           | No     | No       | No    | Yes   | No    |

| Limit                                     | Value                    | Constant                                                          |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| ChatGPT sign-in attempt                   | 15 minutes               | `AUTHORIZATION_TTL_MS`                                            |
| Refresh before the token ends             | 5 minutes                | `ACCESS_TOKEN_REFRESH_MARGIN_MS`                                  |
| ChatGPT refresh lease, wait for it        | 60 s, 30 s               | `REFRESH_LEASE_MS`, `REFRESH_WAIT_MS`                             |
| Cron refresh age, batch                   | 7 days, 50               | `WEEKLY_REFRESH_AGE_MS`, `WEEKLY_REFRESH_BATCH`                   |
| Claude attempt, refresh lease, wait       | 10 minutes, 60 s, 30 s   | Literals in `claude-connection.ts`                                |
| API key length                            | 20 to 4,096 characters   | `MODEL_API_KEY_MIN_LENGTH`, `MODEL_API_KEY_MAX_LENGTH`            |
| Context window, output limit (OpenRouter) | 256,000, 65,536 tokens   | `PI_CONTEXT_WINDOW`, `PI_MAX_OUTPUT_TOKENS`                       |
| Answer part                               | 256 characters or 250 ms | `ANSWER_DELTA_CHARS`, `ANSWER_DELTA_MS`                           |
| Steering text                             | 8,000 characters         | `MAX_STEERING_TEXT_CHARS`                                         |
| Checkpoint, upload chunk                  | 16 MiB, 1 MiB            | `MAX_CHECKPOINT_PLAINTEXT_BYTES`, `CHECKPOINT_UPLOAD_CHUNK_BYTES` |
| Container sleep                           | 1 hour                   | `sleepAfter`                                                      |
| Exit script size                          | 64 KiB, 96 KiB           | `MAXIMUM_SCRIPT_BYTES` in each script                             |

- **No fallback.** A Session uses its pinned route for its lineage. Purin AI needs
  `OPENROUTER_API_KEY`. No failure selects another funding authority. Only a pinned
  model with no adapter moves the Session to the current route, in a new lineage.
- **Credentials.** A key or a token reaches Pi only for one model request, under the
  admission of the turn. It does not enter Actor state, a prompt, the history, a
  checkpoint, generated code or a tool argument. D1 holds Vault handles only.
- **Provider calls.** Use `modelProviderFetch(env)` for a new provider call. Do not
  patch `globalThis.fetch`. Do not give an exit Worker Smart Placement, a public
  route, a Secrets Store binding or a second binding: the two checks refuse the
  profile. The checks read the Wrangler profile only. They do not see a secret that
  `wrangler secret put` sets.
- **Information flow.** A signature stays in the history entry of its block, so the
  labels of that entry cover it. FND-07 owns the check of each answer part before its
  delivery.
- **Agents.** Sous Chef does not read, add or remove a key or a sign-in, and does not
  change the inference source. The key is a secret, and the source decides who pays.
  A person picks the model and the effort of a Portal chat in the chat menu.
- **Idle cost.** An idle Organisation writes no row here. The cron reads each regional
  database one time in each run and writes only when a sign-in is older than 7 days.
- **Out of scope:** Vertex AI; a Gemini subscription sign-in; a model choice on the
  Purin AI route; more than one ChatGPT or Claude connection for an Organisation; a
  change of route inside one lineage.

Boundaries:

- FND-03 owns the Session lifecycle, the turn lease, the delivery stream, checkpoint
  publication and recovery. FND-02 owns the Actors and the cron.
- FND-08 owns the Vault, `credential_ref` and secret revocation. FND-01 owns the
  placement fence that each key read checks.
- FND-09 owns the tool catalog and the Tool Host rules. FND-05 owns the turn input
  (text, images, attachments). FND-07 owns information flow.
- ORG-01 owns activation: it reads the route errors as readiness blockers. ORG-02 owns
  Jev and its allowance on the Purin AI funding.
- INB-01 owns `gmail_inference_eligibility` and `mail_assistant_eligibility`, whose
  CHECKs name the same providers. BRN-01 owns the model of an evaluation.
- [Plan 96](../../plan-96-gemini-models.md) stays a plan for its open steps. Plan 93
  gave the Workers their `pantry-*` names.
- The egress rules are in
  [security.md](../../architecture/security.md#model-routes-and-exit-workers). Read
  [the sandbox release runbook](../../runbooks/code-mode-sandbox-release.md) before a
  change of the pinned Pi packages.

## Open work

- The Codex device-code sign-in and its `chatgpt_backend` API are still in the code.
  Only they use the ChatGPT exit Worker and its container. The code comment keeps them
  until one production turn passes on "Sign in with ChatGPT".
- OpenAI documents no allowance header for "Sign in with ChatGPT". The Session traces
  the `x-` header names of the first answer (`session.chatgpt_agent_response_headers`).
- The container forwards a request when its trace read fails, with the colo `unknown`.
- Plan 96 has open steps: the live check of a Gemini key turn through the deployed exit
  Worker, and the comparison of the OpenRouter spend after the change of the default.
- No route removes a stored model key. A key leaves the Vault only when another key of
  the same provider replaces it. A change of the source keeps the key.
- The Wrangler files have a `local` and a `production` profile, and no staging profile.

## Sources

- [Plan 28](../../history/plan-28-organisation-codex-oauth.md). The code has its connection
  records and control routes. It does not have the Codex App Server or its container.
- [Plan 73](../../history/plan-73-model-exit-worker.md) and
  [Plan 75](../../history/plan-75-chatgpt-exit-container.md). In the archive:
  [Plan 74B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-74B-sign-in-with-chatgpt.md)
  and
  [the Plan 75 probe result](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-75-chatgpt-exit-container/probe-result.json).
- [The runtime architecture](../../architecture/runtime.md#harness-adapter), section
  "Harness adapter".
- [Plan 96](../../plan-96-gemini-models.md), as background.
- Where a source differs from the code, this spec follows the code.
- E2E journeys in `workers/platform/tests/e2e/`:
  - Routes and sign-ins: `chatgpt-subscription-slack.test.ts`,
    `chatgpt-subscription-portal.test.ts`, `claude-oauth.test.ts`,
    `claude-model-choice-portal.test.ts`, `gemini-key-portal.test.ts`,
    `platform-model-change.test.ts`, `slack-model-change.test.ts`,
    `slack-reasoning-effort.test.ts` and `chat-model-route-unavailable.test.ts`.
  - Harness: `pi-sdk-actor.test.ts`, `pi-sdk-effect.test.ts`,
    `pi-sdk-compaction.test.ts`, `pi-native-steering.test.ts`,
    `checkpoint-restart.test.ts` and `checkpoint-atomic-acceptance.test.ts`.
  - The exits in the E2E runtime: `model-exit-network.ts` (`ChatGptExitNetwork`).
- The live journey on real services: `pnpm --filter @purin-labs/platform
slack:live-reply` (`workers/platform/scripts/slack-live-reply-journey.ts`).
- The live check of a Gemini API key: `pnpm --filter @purin-labs/platform
gemini:live-key` (`workers/platform/scripts/gemini-key-live-check.ts`). It runs a tool
  loop on each of the four models through Pi's Google provider, from the machine that
  runs it and not through the exit Worker.
