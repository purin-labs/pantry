# Plan 73 — The Model Exit Worker

Status: released on 2026-10-19 (satyr-model-exit `a42fe2d9`, ref
`refs/backup/released-2026-10-19-plan-73`), and again with dev `370e6444b`
(satyr-model-exit `bd29e6f0`). The placement works, but chatgpt.com refuses
the exit Worker (see Live gate result).
[Plan 74B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-74B-sign-in-with-chatgpt.md) moves the subscription route to
api.openai.com.

## Problem

Plan 72 moved the ChatGPT subscription route into Pi, which runs in the
Session Durable Object. The first real Slack turn in Nini Corp then failed
with no token usage (Plan 72, "First production turn"). The cause is not
confirmed.

The main suspect is the location of the request. OpenAI and Anthropic
refuse requests from Hong Kong. Satyr's Durable Objects use the location
hint `apac`, and that hint allows Hong Kong. A Session in Hong Kong sends
its model requests from a Hong Kong address. Public reports show Workers
whose requests to OpenAI fail at HKG and work at NRT.

The same problem can affect every direct provider request that Satyr sends:

| Request                                                               | Runs in                     | Location today                                                  |
| --------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| ChatGPT model request (`chatgpt.com/backend-api/codex/responses`)     | Session DO                  | `apac` hint: HKG is possible                                    |
| ChatGPT token refresh before a turn (`auth.openai.com/oauth/token`)   | Session DO                  | `apac` hint                                                     |
| Weekly ChatGPT refresh                                                | 15-minute cron              | Any Cloudflare location                                         |
| ChatGPT device-code sign-in and allowance read (`wham/usage`)         | Platform Worker             | The location of the request: the person, the cron, or a Session |
| BYO OpenAI model request (`api.openai.com`)                           | Session DO                  | `apac` hint                                                     |
| Claude account and BYO Anthropic model requests (`api.anthropic.com`) | Session DO                  | `apac` hint                                                     |
| Claude account sign-in and token refresh (`platform.claude.com`)      | Platform Worker, Session DO | Any                                                             |

The live check before Plan 72 ran on the owner's computer, not from
Cloudflare. Rule from that mistake: run a live check from the production
runtime before anything depends on it.

## Decision

The owner chose one small, stateless Worker that sends every direct
model-provider request from a Tokyo data centre (2026-10-19). There is no
pool of exit Actors, no location probe and no retry. The extra hop is one
call inside Cloudflare.

A Durable Object location hint (`apac-ne`) does not replace this Worker. A
hint affects only new objects, and it is best effort. The cron and the
Platform Worker have no hint at all.

Production stays in Tokyo and APAC. Smart Placement toward OpenAI could
move the Worker to the United States, so this plan uses a fixed region.

## Cloudflare facts (checked 2026-10-19)

1. **The region is valid.** The account API
   `/accounts/{accountId}/workers/placement/regions` lists `ap-northeast-1`
   under the provider `aws`. The Slack ingress Worker already runs with
   `placement.region = "aws:ap-northeast-1"`. (`ap-east-1` is Hong Kong.)
2. **Placement applies to `fetch` handlers only.** The placement page says:
   "It does not affect RPC methods or named entrypoints." So the exit
   Worker has one default `fetch` handler, and the Platform calls it with
   `env.MODEL_EXIT.fetch()`, never with RPC.
3. **`request.cf.colo` is not a reliable answer here.** A request from a
   Durable Object through a service binding carries no `cf` object of its
   own, and placement runs the Worker away from the caller. The exit
   Worker reads its location from Cloudflare's trace endpoint, one time
   for each isolate. Satyr already does this for its trace records
   (`src/isolate-location.ts`). The endpoint names the data centre that
   sends the Worker's requests, so it names the location that the
   provider sees.
4. **Placement for a service-binding call is not stated directly.** The
   placement page shows a back-end Worker that a front-end Worker calls
   through a service binding, with placement on the back end. No page says
   how a call from a Durable Object is placed. The live gate checks it.

## Design

### The exit Worker

`satyr-model-exit` (`services/platform/wrangler.model-exit.jsonc`, source
`services/platform/src/model-exit/worker.ts`):

- `placement.region = "aws:ap-northeast-1"`. Cloudflare runs it in the data
  centre with the lowest latency to AWS Tokyo.
- No route and no `workers.dev` URL. Only the Platform Worker reaches it,
  through the service binding `MODEL_EXIT`.
- No binding except the variable `SATYR_DEPLOYMENT_PROFILE`: no database,
  no secret, no service.
- Pass-through only. It sends the request on with the same method, headers
  and body, and it streams the response body back (SSE) without a buffer.
  It removes Cloudflare's own `cf-*` request headers. It never follows a
  redirect: a redirect goes back to the caller.
- It allows an exact list of hosts, over HTTPS on the default port:

  | Host                  | Use                                                   |
  | --------------------- | ----------------------------------------------------- |
  | `chatgpt.com`         | Codex responses and the allowance read (`wham/usage`) |
  | `auth.openai.com`     | Device-code sign-in and token refresh                 |
  | `api.openai.com`      | The BYO OpenAI route                                  |
  | `api.anthropic.com`   | The Claude account route and the BYO Anthropic route  |
  | `platform.claude.com` | Claude account sign-in and token refresh              |

  It refuses every other host with HTTP 403 and sends nothing.
  `platform.claude.com` is not in the first brief. The Claude account route
  exchanges and refreshes its tokens there, and Anthropic also refuses Hong
  Kong.

- Each response carries the header `x-satyr-exit-colo` with the exit
  Worker's data-centre code, for example `NRT`. The value is `unknown` when
  the trace read gives no answer, and in a local runtime.
- It never logs headers, bodies or tokens. For each request it logs the
  host and the status (`model_exit.forwarded`), its own data-centre code
  (`colo`), and the data-centre code at the end of the provider's `cf-ray`
  (`provider_colo`). That second code is where the provider's network
  received the request. A refused host gives `model_exit.host_refused`.
  Invocation logs are off: Cloudflare keeps no other record of a request.

### The Platform side

- `src/model-exit/provider-fetch.ts` gives `modelProviderFetch(env)`: a
  fetch that calls `env.MODEL_EXIT.fetch()`. `globalThis.fetch` stays as it
  is.
- **Model requests.** Each direct model route lease carries this fetch as
  `providerFetch`, and Pi passes it to pi-ai with the `fetch` stream option.
  This covers the ChatGPT subscription route, the BYO OpenAI route, the
  Claude account route and the BYO Anthropic route.
- **Sign-in, refresh and allowance.** `chatgpt-oauth.ts` and
  `claude-oauth.ts` take the fetch as an argument. `codex-connection.ts`
  and `claude-connection.ts` pass it from the Worker bindings that their
  contexts already hold.
- **The OpenRouter platform route stays direct.** OpenRouter serves Hong
  Kong.
- **No retries.** A provider refusal for the region ends the turn with the
  Plan 72 behaviour: known zero usage and one notice. The Session's
  `session.chatgpt_model_request_refused` log adds `exit_colo`.

### Deploy order

`pnpm --filter satyr-edge run deploy` deploys four Workers:

1. `satyr-code-mode-sandbox` (the Platform binds its class).
2. `satyr-model-exit` (the Platform binds it).
3. `satyr-edge`, the Platform Worker.
4. `satyr-slack-ingress`.

`pnpm --filter satyr-edge model-exit:check` builds the exit Worker and
fails when: the Worker name differs from the Platform binding; the region
is not `aws:ap-northeast-1`; it holds a binding other than its profile
variable; it has a public route; its invocation logs are on; or its script
holds Wasm or more than 64 KiB.

Local development (`pnpm --filter satyr-edge dev`) runs the exit Worker in
the same process, with no placement.

## Tests

One journey, changed from Plan 72 (`tests/e2e/chatgpt-subscription-slack.test.ts`,
"answers Slack threads on Pi through the ChatGPT subscription…"):

- The E2E runtime builds the exit Worker with Wrangler, as a deployment
  does, and binds it as `MODEL_EXIT`. Its outbound requests reach the fake
  providers through the test network, with a mark that the exit Worker
  cannot add.
- The fake ChatGPT answers a request without that mark as OpenAI answers a
  request from Hong Kong: HTTP 403, `unsupported_country_region_territory`.
  So the journey passes only when the device-code sign-in, the allowance
  read, the refresh and each model request pass through the exit Worker.
- The exit Worker refuses a host outside the list, also a host that only
  starts with `chatgpt.com`, and no request leaves it.

Every other journey with the fake ChatGPT, the fake Anthropic or the fake
OpenAI now runs through the exit Worker too. The Pi funding journey
(`pi-durable-funding.test.ts`) builds its BYO OpenAI and Anthropic leases
with `modelProviderFetch`, as the Session does.

## Release steps

1. The owner's word.
2. Read `wrangler deployments list` for each Worker. The Plan 72 session
   started a release of dev `f4ae2aca0` (the Plan 72 fix and the weekly
   refresh) on 2026-10-19. If production runs `f4ae2aca0`, this release
   adds Plan 73 only. Release from a dev that holds `f4ae2aca0` or later.
3. Deploy with `pnpm --filter satyr-edge run deploy`. No D1 patch.
4. Run the live gate.

If the exit Worker fails, roll back `satyr-edge` to the version before the
release. The exit Worker can stay: nothing else calls it.

## Live gate

The gate runs after the release, from production. It needs the owner, for
Portal and Slack.

1. **Read the exit colo once.** Run
   `pnpm --filter satyr-edge exec wrangler tail satyr-model-exit --format pretty`.
   The owner opens Portal at Settings → AI inference. Portal reads the
   ChatGPT allowance when the last read is more than five minutes old.
   `model_exit.forwarded` for `chatgpt.com` must show a Japanese `colo`,
   such as `NRT` or `KIX`, and status 200. `provider_colo` must also be
   Japanese.
2. **One Slack turn.** The owner sends one message on the ChatGPT route in
   a new Nini Corp thread. The thread must get an answer, and the tail must
   show `chatgpt.com` with a Japanese `colo`.

If step 1 shows a location outside Japan, placement does not apply to these
calls, and this plan does not fix the problem. Stop and report. If step 2
fails, read `session.chatgpt_model_request_refused`: its `status`,
`cf_mitigated`, `cf_ray` and `exit_colo`.

### Live gate result (2026-10-19)

Step 1 ran from 02:43 to 03:08 UTC, after the release of `370e6444b`. All
200 allowance reads left from NRT, and `provider_colo` was NRT. So the
placement works, and Hong Kong was not the cause. chatgpt.com answered
HTTP 403 to each read. The Plan 74B probe from the same placement got an
HTML block page without `cf-mitigated`. The read was not throttled then:
the open Settings page sent about 8 reads a minute. Plan 74B step 1
(`0cefcc419`) limits it to one read in each five minutes. Step 2, the Slack
turn, did not run.

## Build status (2026-10-19)

Built on branch `plan-73-model-exit` from dev `f4ae2aca0`, the current dev
tip. Dev holds the Plan 72 fix (`plan-72-refusal-unblock`) and the weekly
refresh, so the journeys ran with both. Merged into dev as `4b6a0204e`;
the merged result was not re-tested. Not pushed, not deployed.

Checks in an isolated worktree:

- `check:types` and `check:test-types` pass.
- `model-exit:check` passes for production, staging and local: one module
  of 6.5 KiB, and the only binding is `SATYR_DEPLOYMENT_PROFILE`. A changed
  region (`aws:ap-east-1`) and invocation logs that are on each fail the
  check.
- The Slack journey file passes (both cases). Its artifact shows two
  device-code sign-ins, two refreshes, two allowance reads and six model
  requests through the exit Worker, no direct request, and two refused
  hosts. With `modelProviderFetch` changed to the runtime's fetch, the
  journey fails at the first sign-in (`codex_device_authorization_unavailable`).
- These journeys also pass through the exit Worker: the ChatGPT Portal
  journey, the Claude account journey, the Pi funding journey (BYO OpenAI
  and Anthropic), chat goal controls, checkpoint acceptance (2 cases),
  checkpoint restart (6 cases), the mail Memory comparison and the shared
  account platform journey.
- `portal:build` and `git diff --check` pass.
- The unit suite has the same 7 failures as dev `f4ae2aca0`: the 6 email
  reply tests, and `scheduled-onboarding-trigger.test.ts`. That last one
  fails on dev since the weekly refresh: the cron's refresh reads a
  placement profile that the unit test does not set.

Not checked: the placement of a service-binding call in production, and
the real providers through the exit Worker. The live gate checks both.
