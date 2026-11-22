# Plan 75 — A Container Exit for the ChatGPT Route

Status: built on 2026-10-19. In production since the whole-dev release of
2026-10-20 (`refs/backup/released-2026-10-20-plan-74-whole-dev`). Each
release deploys `satyr-chatgpt-exit` before the Platform Worker.

## Problem

Plan 72 moved the ChatGPT subscription route from the Codex harness, which
ran in a container, to Pi, which runs in the Session Actor. Plan 73 sent
every direct provider request through a Worker placed near AWS Tokyo. After
the Plan 73 release on 2026-10-19, every chatgpt.com request left from
Tokyo (NRT) and chatgpt.com still answered HTTP 403. Slack turns on the
ChatGPT route failed.

## Probe (2026-10-19)

A throwaway Worker with the Plan 73 placement and one lite container in
Asia Pacific sent the same requests, with invalid tokens only. Result:
`docs/evidence/plan-75-chatgpt-exit-container/probe-result.json`.

| Request                                       | From the Worker (NRT) | From the container (KIX) |
| --------------------------------------------- | --------------------- | ------------------------ |
| chatgpt.com Codex responses, as Pi            | 403, HTML block page  | 401 JSON login error     |
| chatgpt.com Codex responses, as the Codex CLI | 403, HTML block page  | 401 JSON login error     |
| chatgpt.com wham/usage                        | 403, HTML block page  | 401 JSON login error     |
| auth.openai.com token refresh                 | 401 JSON              | 401 JSON                 |
| auth.openai.com Sign in with ChatGPT token    | 400 JSON              | 400 JSON                 |
| api.openai.com models                         | 401 JSON              | 401 JSON                 |

So chatgpt.com blocks requests that leave Cloudflare from a Worker, with any
client name, and accepts them from a container. Hong Kong was not the cause.
auth.openai.com and api.openai.com accept Workers. The block page carried no
`cf-mitigated` header. The probe was deleted after the run.

## Decision

The owner said: "if a container is the only way to make Codex Subscription
work, then we should bring it back." The probe showed that a container
accepts Pi's own requests, so the full Codex harness does not come back.
Pi stays the only harness, and one small shared container forwards Pi's
chatgpt.com requests.

## Design

- **Routing.** `modelProviderFetch` sends a chatgpt.com request to the
  service binding `CHATGPT_EXIT`, and every other provider request to
  `MODEL_EXIT` (Plan 73). The sign-in and the token refresh use
  auth.openai.com, so they stay on the Plan 73 exit Worker. The Plan 73
  exit Worker no longer accepts chatgpt.com.
- **The ChatGPT exit Worker** (`satyr-chatgpt-exit`,
  `wrangler.chatgpt-exit.jsonc`, `src/chatgpt-exit/worker.ts`). It holds one
  Actor binding for the container class `ChatGptExitContainer` and nothing
  else: no credential, no storage, no public route, invocation logs off.
  Placement `aws:ap-northeast-1`. All organisations share one container
  (`max_instances` 1, Actor name `chatgpt-exit`, location hint `apac-ne`).
- **The container** (`services/chatgpt-exit`, a lite instance with
  `constraints.regions` APAC). Node 24 runs `server.mjs` and the shared
  `src/chatgpt-exit/forward.ts`. It forwards only https URLs on
  chatgpt.com under `/backend-api/`, streams the answer back, and names its
  data centre in `x-satyr-exit-colo`. It refuses to forward when its trace
  location is China, Hong Kong or Macau. It never logs a header, a body or a
  token, and it does not retry. `sleepAfter` is one hour.
- **Cost.** A lite container costs about US$0.003 an hour while it runs:
  about US$2 to 3 a month if it runs all the time, for all organisations.
  After an idle hour, the next request waits about two seconds for a start.
- **Deploy.** `pnpm --filter satyr-edge run deploy` checks the profile with
  `chatgpt-exit:check`, then deploys the sandbox, the model exit Worker, the
  ChatGPT exit Worker, the Platform and the Slack ingress Worker, in that
  order. The Platform binds `CHATGPT_EXIT` by name, so the ChatGPT exit
  Worker deploys first.

## Tests

The E2E runtime cannot run a container. The entrypoint `ChatGptExitNetwork`
stands in for the ChatGPT exit Worker and its container: it runs both of
their steps, `containerRequest` and `forwardChatGptRequest`, and marks each
forwarded request. The fake chatgpt.com answers a request from the Plan 73
exit Worker with the HTML block page, as production does.

- The ChatGPT Slack journey passes: model requests and allowance reads use
  the ChatGPT exit, the sign-in and refreshes use the model exit Worker, and
  each exit refuses the other's hosts. With the old routing (chatgpt.com
  through the model exit Worker) the same journey fails at the first
  allowance read.
- These journeys also pass: the ChatGPT Portal journey, chat goal controls,
  checkpoint acceptance (2), checkpoint restart (6), the Claude account
  journey, Pi funding (2) and the mail Memory comparison.
- `check:types`, `check:test-types`, `chatgpt-exit:check` (production,
  staging, local) and `model-exit:check` pass. The container server passed
  a local run against the real chatgpt.com (401 JSON for an invalid token,
  refusal of another host).

Not checked: the real container in production with a real token. The live
gate checks it.

## Release steps

1. The owner's word.
2. Read `wrangler deployments list` for each Worker. Production runs the
   narrow release `9d759f581` (ref `refs/backup/released-2026-10-19-plan-73`);
   dev also holds Plan 40C work that needs its own D1 patch first.
3. Deploy. The ChatGPT exit Worker is new; the deploy creates its container
   application `satyr-chatgpt-exit-container`.
4. Run the live gate.

## Live gate

1. Tail `satyr-chatgpt-exit` and the Platform.
2. The owner sends one ChatGPT Slack message in a new Nini Corp thread. The
   thread must get an answer. The model request must report a Japanese
   `x-satyr-exit-colo`.
3. Portal shows the ChatGPT allowance again.

If the container refuses or chatgpt.com blocks it, restore the Codex harness
from git (`refs/backup/released-2026-10-18-plan-71-fixes` holds the last
release with it).
