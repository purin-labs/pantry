# ENG-04 — Testing

This spec describes how Purin Pantry proves that its product works. A journey is an
E2E test: it enters the product from outside and asserts an outcome that an operator or
a customer sees. Journeys are the main proof, and new work does not add unit tests.
Platform journeys run in workerd (the Cloudflare Workers runtime). Commerce journeys run
against a disposable backend. Kitchen physics and browser journeys have one index, and a
small set of journeys uses real services. The unit suites also stay, and a decision page
records the decision for each Platform unit test file. CI runs most of these suites on a
pull request to `main`.

## What it does

### The test policy

- Do not write unit tests. Use E2E tests to verify complex features.
- Choose a medium to hard scenario for an E2E test.
- At the end of an E2E test, produce a verifiable and repeatable artifact.
- Do not add a regression test for a bug fix, unless the fix shows a real gap in the
  behavior tests.
- A test is executable evidence of current behavior. It is not the source of product
  intent. If a test conflicts with a spec, a domain type or a requested change, change
  or delete the test. Also delete each fixture that only that test uses.
- A passing old test shows that a behavior existed. It does not show that the behavior
  is still intended.

### Which tests stay

| Kind of test                                                         | Decision                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| Tautological: a mock or a fixture produces the asserted result       | Delete                                                    |
| Change detector: asserts internal step order or a private state name | Delete                                                    |
| Its outcome is in a journey                                          | Delete, and name the journey in the commit                |
| Fails only because setup drifted, and its outcome no longer matters  | Delete. Do not repair the fixture                         |
| The only check of an authorization, money or data outcome            | Keep. Move the check into a journey if the journey exists |
| A fault journey with one case for each internal time window          | Keep one case for each distinct outcome                   |

- A fake outside service only records or answers calls. Product code must produce the
  asserted outcome, so that the test fails when that code is wrong.
- Assert what an operator or a customer sees: one Slack message, no repeated inference,
  no lost draft, a refused request.
- Read internal rows only for a safety property, such as the absence of an attempt, a
  receipt, a grant or a credential generation.
- Use a `*.type-fixtures.ts` file for a state that the type system must reject. Use a
  runtime test for the parse of untrusted input and for persistence.
- Delete a test in its own commit. The commit names the outcome and where it is still
  checked, or says that no check is left and why that is accepted.

[The decision page](../../refactor-17-test-decisions.md) records one decision for each
Platform unit test file and for 17 commerce test files. It keeps 317 files whole, keeps
one file with one case deleted, and deletes no file.

### The suites

| Suite                  | Where                                                      | Size                           | Runner                                        | Command                                               |
| ---------------------- | ---------------------------------------------------------- | ------------------------------ | --------------------------------------------- | ----------------------------------------------------- |
| Platform journeys      | `services/platform/tests/e2e/`                             | 251 files                      | Vitest with the Cloudflare plugin, in workerd | `pnpm --filter @purin-labs/platform test:e2e`         |
| Platform unit          | `services/platform/tests/`                                 | 300 files                      | Vitest in Node                                | `pnpm --filter @purin-labs/platform test`             |
| Platform type fixtures | `services/platform/tests/`                                 | 90 files                       | The type check                                | `pnpm --filter @purin-labs/platform check:test-types` |
| Commerce               | `services/commerce/tests/`                                 | 86 files, 69 named `*-journey` | Vitest in Node                                | `pnpm commerce:test`                                  |
| Kitchen journeys       | `scripts/production-simulation/`, `scripts/bakery-robots/` | 128 rows, 122 files            | `run-journeys.mjs`                            | See "The Kitchen journey index"                       |
| Portal                 | `apps/portal/src/features/workflow-simulator/`             | 5 files                        | `node --test`                                 | `pnpm --filter @purin-labs/portal test`               |
| Storefront             | `apps/storefront/`                                         | 1 file                         | Vitest                                        | `pnpm --filter @purin-labs/storefront test`           |
| Shared packages        | 7 packages in `packages/`                                  | 12 files                       | Vitest                                        | `pnpm test:units`                                     |
| Worker environment     | `scripts/worker-environment.test.mjs`                      | 1 file                         | `node --test`                                 | `pnpm test:units`                                     |
| Rust                   | 6 crates of the Cargo workspace                            | —                              | Cargo                                         | `cargo test --workspace`                              |

`pnpm test:units` runs the shared package, Portal, storefront and Platform unit suites.
If one of these suites fails, the others still run, but the Worker environment test does
not run. `pnpm test:units` does not run the commerce suite. In a new worktree, it needs
the R2 files, `pnpm async-control:build` and
`pnpm --filter @purin-labs/platform contracts:media`.

The Portal `test` script names its five files. A new Portal test file does not run until
the script names it. `crates/bakery-native` is outside the Cargo workspace, so
`cargo test --workspace` does not run it.

### Run the checks

Run the narrowest relevant check first:

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

To run one journey, add its path after `test:e2e`, for example
`tests/e2e/idle-tenant-cost.test.ts`.

| Change                                                                             | Required check                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Onboarding or lifecycle                                                            | `pnpm --filter @purin-labs/platform test:onboarding-closure` (9 files)                                                     |
| Commerce lifecycle                                                                 | `pnpm --filter @purin-labs/platform test:commerce-lab`, then `pnpm lab:reset`, `lab:seed`, `lab:scenario` and `lab:verify` |
| D1 baseline                                                                        | A patch script, and `pnpm lint:d1-patch`                                                                                   |
| Cron, alarm, poll or Durable Object constructor                                    | `tests/e2e/idle-tenant-cost.test.ts`                                                                                       |
| New information-flow source or output                                              | `pnpm lint:ifc-boundaries` and an allowed/denied journey                                                                   |
| New Portal or Slack ability                                                        | A chat journey: the agent does the action, and a person without the right stays refused                                    |
| Slack ingress, model routes or Slack delivery                                      | `pnpm --filter @purin-labs/platform slack:live-reply`, before the release                                                  |
| Shared domain types, parsers, schemas, migrations, control routes or configuration | The full Platform unit suite and `check:types`                                                                             |

The commerce lab commands need a running Worker. `scripts/lab/run-commerce-lab.mjs` reads
`PANTRY_WORKER_URL`, `PANTRY_LAB_ORGANISATION_ID`, `PANTRY_COMMERCE_LAB_NAMESPACE`,
`ORGANISATION_ADMIN_TOKEN` and `PANTRY_COMMERCE_LAB_SIGNING_SECRET`. `reset`, `seed` and
`scenario` refuse a target that is not localhost, unless the command has `--remote-yes`.
`lab:scenario` runs `happy-order`. The other scenarios are `product-listing`,
`payment-failed`, `inventory-shortage`, `shipment-delayed` and `cancellation-refund`.

### The Platform E2E runtime

`services/platform/vitest.e2e.config.ts` runs the journeys in workerd with no remote
binding. One file runs at a time, and a failed test does not retry.

| Part                             | How the suite provides it                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform Worker                  | `tests/e2e/wrangler.jsonc`                                                                                                                                   |
| Code Mode sandbox Worker         | Built with Wrangler, as a deployment builds it                                                                                                               |
| Model exit Worker                | Built with Wrangler. Its requests go to the `ModelExitNetwork` entrypoint                                                                                    |
| Commerce engine                  | The built fixture Worker: the production Worker with a deterministic payment gateway and named seed scenarios                                                |
| ChatGPT exit and 1Password store | The `ChatGptExitNetwork` and `OnePasswordNetwork` entrypoints of the runner Worker                                                                           |
| Shop gateway                     | `SHOP_GATEWAY_ADAPTERS`: the real `shop-gateway answer` with a simulated printer, and the real `shop-gateway relay` with the controller simulator for cobots |
| Outside providers                | The `network` of `tests/e2e/network.ts` (`@msw/cloudflare`). An unhandled socket frame is an error                                                           |
| Artifacts                        | `JOURNEY_ARTIFACTS` writes one JSON file under `output/`                                                                                                     |

Before each test, `tests/e2e/setup.ts` loads the resident Actors and resets the runtime.
It then applies the D1 baselines and creates the data root and the two Vault roots.

Tests reach the commerce engine only as a built Worker and over HTTP. To seed it, add a
scenario in `services/commerce/tests/fixture-worker/scenarios.ts`.
`pnpm lint:runtime-boundary` refuses a new import of commerce source.

### The D1 databases in E2E

Production keeps global records and each Organisation's records in separate D1
databases, and the E2E suite does the same.

| Binding                | Local database    | Holds                                                                              |
| ---------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `DB`                   | `pantry-e2e`      | Global records only (`migrations-global`)                                          |
| `ORGANISATION_DB_WNAM` | `pantry-e2e-wnam` | Organisation records of `regional-wnam` and of every fixture cell (`e2e`, `e2e-*`) |
| `ORGANISATION_DB_APAC` | `pantry-e2e-apac` | Organisation records of `regional-apac`                                            |

The helpers are in `tests/e2e/organisation-database.ts`:

- `organisationDatabase(id)` gives the database that production placement selects.
- `fixtureDatabase()` gives the database of the fixture cell `e2e`.
- `onboardFixtureOrganisation(name)` creates an Organisation through production
  onboarding. Use it when the journey does not fix the id in advance.
- `publishGlobalOrganisation(id)` copies the Organisation and placement rows to `DB`.
  A fixture that writes an Organisation row itself calls it before it writes global
  rows that name the Organisation.

Most unit suites run on one database that `singleDatabaseSchema()`
(`services/platform/scripts/single-database-schema.mjs`) builds from the two baselines.
That schema hides a statement sent to the wrong database, so two guards exist:

- `tests/split-topology.ts` builds one global and one regional database for a unit test.
  Use it for a path that reads or writes both.
- `tests/d1-split-statements.test.ts` reads the SQL of `src` without a run. It fails when
  one statement names tables of both databases. It also fails when a function names a
  global-only table on a database that nobody has traced to `env.DB`.

### Fixtures

- Seed data is input, not proof. Keep it minimal.
- Build seed data through the same authorities that production uses.
- Keep fixtures local. Do not add a shared "world" fixture with hidden lifecycle
  transitions.
- Shared helpers of the journeys are the `tests/e2e/*-support.ts` files.
- Do not add a fixture for each field that can invalidate readiness. Test a policy and
  its enforcement one time, not one time for each provider action or diagnostic field.
- If a test breaks because setup drifted, first ask if its outcome still matters. If it
  does not, delete the test.
- Before you change lifecycle, onboarding, provider or persistence behavior, read the
  current spec and the domain type. Then classify each failure as a current contract, an
  incidental detail or an obsolete behavior.

### Fault journeys

A fault journey injects an eviction, a relocation, a delayed admission or a revoked
access. It keeps one case for each distinct outcome. Three fault points are in product
code, and each one acts only when the Worker has `PANTRY_FAULT_INJECTION_TOKEN`:

| Fault                              | Storage key                                 | Route                                                    | Test that arms it                                     |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Onboarding activation stops        | `acceptance:onboarding-activation-fault:v1` | `/v1/organisations/:id/onboarding/activation-acceptance` | `onboarding-activation.test.ts`, in storage           |
| The Café commerce queue step fails | `acceptance:cafe-commerce-fault:v1`         | `/v1/acceptance/organisations/:id/cafe-commerce-fault`   | `e2e/commerce-webhook-catch-up.test.ts`, on the Actor |
| A steer answer is lost             | `fault:steer_answer_lost`                   | None                                                     | `e2e/slack-steer-park-loss.test.ts`, in storage       |

The two routes accept `POST`, `GET` and `DELETE`. Any other method gets 405 from every
caller. An accepted method needs a localhost request or the bearer token, and an
Organisation in the `development` environment. If one of these is missing, the caller
gets 404. `pnpm cloudflare:fault-injection-secret` sets the token on production, and
`pnpm cloudflare:fault-injection-secret:delete` removes it.

### Guard journeys

- **Idle tenant cost** (`tests/e2e/idle-tenant-cost.test.ts`). The journey sets up a shop
  with Commerce and Slack. It then runs every production cron trigger for one idle hour,
  and stops each Durable Object before each five minutes. A restarted object must write
  nothing. The shop must still read as in sync. An alarm of the idle hour must not arm
  itself again. The journey reads the triggers from the production Wrangler file, so it
  measures a new trigger with no test change. It throws on a trigger whose minute field
  is not `*` or a step, or whose other fields are not `*`.
  `e2e/write-meter.ts` counts the writes and names the D1 statements.
  `IDLE_HOUR_BUDGET` allows only 12 rows on `ORGANISATION` in the hour. To raise a line,
  write its reason and its cost for 30 days beside it.
- **First chat budget** (`tests/e2e/new-organisation-first-chat.test.ts`). A new
  Organisation's first chat turn has two tool calls and reports 71,114 tokens. It must
  answer under the budget that the Organisation gets at creation. Do not raise the budget
  in this journey.

### The Kitchen journey index

`scripts/production-simulation/journeys.json` lists each physics journey of
`scripts/production-simulation` and `scripts/bakery-robots`. `run-journeys.mjs` runs them
and gives each one a fresh output directory. It writes `journeys-summary.json` with the
result and the time of each journey.

| Field      | Values                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `tier`     | `fast` (62 rows, under 300 s), `slow` (2 rows, 300 s or more, or a large heap), `browser` (64 rows) |
| `backend`  | `native`, `wasm`, `both`, `browser`, `none`                                                         |
| `run.tool` | `node` (47), `tsx` (22), `python` (6), `browser` (53)                                               |
| `status`   | `passes`, `fails`, `not run`                                                                        |
| `lastRun`  | The seconds, the date and the commit of the last recorded run                                       |
| `failure`  | The reason, for a row that does not pass                                                            |

In the `browser` tier, 53 rows drive a Portal page. The other 11 rows use `tsx` to read
the output of a browser journey. The `status` field is a recorded result, and a run
changes it only with `--record`.

```bash
node scripts/production-simulation/run-journeys.mjs --set ci
node scripts/production-simulation/run-journeys.mjs --tier fast --output output/journeys/fast
node scripts/production-simulation/run-journeys.mjs --id two-cell,batch-cycles
node scripts/production-simulation/run-journeys.mjs --tier browser --base-url http://127.0.0.1:5194
node scripts/production-simulation/run-journeys.mjs --list --tier slow
```

- A journey that reads the output of another journey runs after it. If the first one
  fails, the second one is `skipped`, and the run exits with a failure.
- A later run in the same `--output` reuses the passed journeys that it reads. A chosen
  journey does not reuse its output. If its directory exists, it fails with the reason
  `the output directory exists`, unless its row has `sharesOutputOf`. To repeat a chosen
  journey, give a new `--output`.
- A browser journey uses `scripts/bakery-robots/browser-acceptance.mjs`. By default, it
  opens the Portal dev server at `--base-url`.
- A row with `run.portal: "built"` runs on the built Portal. A row with `run.server`
  starts its own fixture server. Three rows have a server, and one row uses the built
  Portal.
- `pnpm lint:journey-index` refuses a journey file with no row and a row in a set that
  does not pass. It refuses a passing row with no recorded time, and a browser limit
  under four times the recorded time. It refuses a row that does not pass and has no
  `failure.reason`, or has the reason `not measured yet`. It refuses a row that reads an
  unknown row or a row later in the index. It also refuses a workflow that calls the
  browser runner directly.

Other browser scripts are outside this index. They are in folders such as
`scripts/plan21`, `scripts/plan-40b`, `scripts/plan-53`, `scripts/plan-81` and
`scripts/mail-inbox`, and CI does not run them.

### Journeys on real services

Fixture journeys do not prove that real Slack, model providers or payment providers
behave like the fakes. These journeys use the real service. The Slack reply journey
refuses to run when a value is missing. The `plan15-connector-delivery` case skips when
`PANTRY_CAFE_LIVE_SLACK` is not `1`. With the flag, it throws if one of its three Slack
values is missing or has the wrong prefix. Each other journey skips when its secret is
missing.

| Journey                                                                                                                                                     | Real service                                   | Needs                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `services/platform/scripts/slack-live-reply-journey.ts`                                                                                                     | The deployed Worker, Slack and the model route | `SLACK_LIVE_USER_TOKEN`, `SLACK_LIVE_CHANNEL`, `SLACK_APP_USER_ID`                                              |
| `e2e/goal-pi-live`, `e2e/chat-menu-board-permission-live`, `e2e/order-attention`, one case of `e2e/portal-chat-finalization`, two cases of `e2e/mail-inbox` | The model through OpenRouter                   | `PANTRY_PI_ACCEPTANCE_API_KEY`                                                                                  |
| `services/commerce/tests/square-journey.test.ts` (two cases)                                                                                                | Square sandbox                                 | `COMMERCE_SQUARE_SANDBOX_TOKEN`, `COMMERCE_SQUARE_SANDBOX_APPLICATION_ID`                                       |
| `services/commerce/tests/stripe-journey.test.ts`                                                                                                            | Stripe test mode                               | `COMMERCE_STRIPE_TEST_SECRET_KEY`, `COMMERCE_STRIPE_TEST_PUBLISHABLE_KEY`, `COMMERCE_STRIPE_TEST_ACCOUNT`       |
| One case of `tests/plan15-connector-delivery.test.ts`                                                                                                       | Slack                                          | `PANTRY_CAFE_LIVE_SLACK=1`, `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_TEAM_ID` (`T`), `PANTRY_SLACK_CHANNEL_ID` (`C`) |

`services/commerce/tests/punter-acceptance.test.ts` runs the Punter buyer journeys over
HTTP against a disposable backend. To keep the evidence, set
`PUNTER_ACCEPTANCE_ARTIFACT_DIR`.

### What CI runs

`.github/workflows/pantry.yml` runs on a pull request to `main`, on `merge_group` and by
hand. A draft pull request runs a job only with the label `run-ci`. A push to `dev` does
not cancel the run in progress. Another pull request cancels its own older run.

| Job              | Steps, in order                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`         | Fetch the R2 files. `pnpm async-control:check`, `commerce-data:check`, `pnpm check:packages`, `pnpm lint:static`. On a pull request, the D1 patch check. Platform `check:types` and `check:test-types`, `pnpm test:units`, and the Platform journeys in four shards, one after the other. A failed shard does not stop the next shard |
| `bakery-physics` | Fetch the R2 files, install the tools, and build `bakery-native`. Check the execution bundle, then build the Portal. Run the set `ci` (17 journeys). Start the Portal dev server on port 5194 and run the set `ci-browser` (22 journeys). Upload the reports. A failed upload does not fail the job                                   |

`.github/workflows/commerce-components.yml` has the job `checks`. It runs
`pnpm lint:runtime-boundary`, `commerce-data:check`, `pnpm commerce:check` and
`pnpm commerce:test`. On a pull request to `main`, it runs only when a path in its list
changes. The list holds the commerce paths and shared paths, such as `pnpm-lock.yaml`,
`patches/**` and `tsconfig.base.json`. It also runs on `merge_group`. Its `run-ci` rule
for a draft pull request and its cancel rule are the same as in `pantry.yml`.

## Contracts

This subsystem has no D1 table, Actor table, event, capability or agent tool of its own.

| File                                                 | Purpose                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `services/platform/vitest.config.ts`                 | The Platform unit suite. It builds the commerce fixture Worker one time |
| `services/platform/vitest.e2e.config.ts`             | The E2E runtime, bindings, fake secrets and placement cells             |
| `services/platform/tests/e2e/write-meter.ts`         | The write counter and the cost for 30 days                              |
| `services/platform/tests/journey-artifacts.ts`       | The artifact writer. A path is one `.json` file under `output/`         |
| `services/platform/tests/commerce-fixture-worker.ts` | The build and the start of the commerce fixture Worker                  |
| `services/platform/tests/shop-gateway-adapters.ts`   | The runs of the real gateway binary and the controller simulator        |
| `services/commerce/vitest.config.ts`                 | The commerce suite                                                      |
| `services/commerce/tests/fixture-worker/`            | The commerce fixture Worker and its scenarios                           |
| `foundation/kernel/fault-injection-auth.ts`          | The bearer check of the fault routes                                    |
| `scripts/production-simulation/run-journeys.mjs`     | The Kitchen runner and the index check                                  |
| `scripts/list-tests.mjs`                             | Lists each test file with its kind, lines, mocks and source imports     |

The Plan 24 cobot journeys build the controller simulator. Set `MUJOCO_DIR` to an SDK from
`node scripts/bakery-robots/install-native-sdk.mjs <dir>`, or set
`PANTRY_COBOT_CONTROLLER_BINARY` to a built `cobot-controller`. These journeys and the
receipt printer journey also need `cargo`.

## Rules and limits

| Limit                              | Value                               | Name                                  |
| ---------------------------------- | ----------------------------------- | ------------------------------------- |
| E2E test and hook                  | 30 s, unless a test gives its own   | `testTimeout`, `hookTimeout`          |
| E2E retries                        | 0                                   | `retry`                               |
| Idle tenant journey                | 300 s                               | `timeout` in the test                 |
| Commerce test                      | 60 s                                | `testTimeout`                         |
| Browser journey                    | 600 s, unless the row gives its own | `BROWSER_LIMIT_MS`, `run.timeoutMs`   |
| Smallest browser limit             | 4 times the recorded time           | `BROWSER_LIMIT_FACTOR`                |
| Start of a fixture server          | 180 s                               | `SERVER_START_MS`                     |
| Lab scenario settlement            | 90 s                                | `SCENARIO_SETTLEMENT_TIMEOUT_MS`      |
| Slack reply, then the quiet period | 180 s, 30 s                         | `REPLY_TIMEOUT_MS`, `QUIET_PERIOD_MS` |
| Fault token                        | At least 32 characters              | `MINIMUM_FAULT_TOKEN_LENGTH`          |
| `bakery-physics` job               | 300 minutes                         | `timeout-minutes`                     |
| CI reports of `bakery-physics`     | 14 days                             | `retention-days`                      |

- **People and agents.** Tests have no role of their own. A journey for a new feature
  proves the role check of that feature: the allowed person acts, and a person without
  the right stays refused. An agent journey uses the person's own checks and approvals.
- **Information flow.** A new source or output needs `pnpm lint:ifc-boundaries` and an
  allowed/denied journey. The rules are in FND-07.
- **Cost.** Delete a test Worker and its Durable Objects when the test ends.
- **Secrets.** The E2E config holds only fake values. A real key comes from the
  environment of the person who runs the journey, and CI sets none of the keys above.
- **Out of scope.** This spec does not define the lints and ratchets, the release steps
  or the behavior that a journey checks.

The boundaries to the neighbours:

- **ENG-02** owns the lints, the ratchets and the repository layout.
- **FND-01** owns the two D1 databases, their baselines and their patches.
- **FND-02** owns Actor alarms and recovery, which the fault journeys exercise.
- **FND-07** owns the information-flow rules.
- **FND-09** owns the agent tool catalog that a chat journey uses.
- **COM-02** owns the commerce engine and its fixture Worker.
- **KIT-02** owns the physics bundles that the Kitchen journeys run.
- **Plan 24** stays a plan. It owns the cobot journeys and `scripts/plan-24/`.
- **Refactor 17** stays a plan. It owns the `foundation/testing` module and the rule that
  each refactor step decides on the tests of the code that it changes.

## Open work

- **The `foundation/testing` module has no file.** Of the 251 Platform journeys, 185
  import product source directly. Refactor 17 plans a `testing` entry for each module
  and a ratchet on those imports.
- **The write meter has a gap.** It does not count the D1, queue, KV and R2 writes that a
  Durable Object sends itself. It counts only the rows of the object, so the idle tenant
  guard cannot see those writes.
- **CI does not run some suites.** It does not run `cargo test --workspace` or 89 of the
  128 Kitchen journeys. It also does not run the browser scripts outside the index, the
  journeys on real services or the commerce lab commands.
- **No test calls the two fault routes.** The tests arm each fault directly. The E2E fault
  token has 25 characters, so the bearer check of the routes refuses it.
- **The fault checks differ.** The routes need a token of 32 characters. The three fault
  points act on a shorter token.
- **The large cuts in money-path test files are not done** (Batch E of Plan 92).
- **Some product code has no test.** A search by name finds no test for
  `connectionAttentionMessage`, `renderOperatorNotice`, `readOrganisationHomeRegions` or
  the 1Password `listCache`. Plan 92 gives its full list of code with no test.
- **The decision page is one file behind.** It has a row for
  `portal-gmail-mailbox.test.ts`, which no longer exists.
- **The test guide names two files that do not exist:** `do-schema-migrations.test.ts` and
  `organisation-directory-split.test.ts`.

## Sources

- [`AGENTS.md`](../../../AGENTS.md), section "Testing", and
  [`services/platform/tests/AGENTS.md`](../../../services/platform/tests/AGENTS.md). These
  two guides are not plans and do not move.
- [The decision for each test file](../../refactor-17-test-decisions.md),
  [Refactor 17](../../refactor-17.md), section "Prune with each step", and
  [Plan 92](../../history/plan-92-new-pantry-repository.md), for the open test gaps.
- Background: [`pantry.yml`](../../../.github/workflows/pantry.yml),
  [`commerce-components.yml`](../../../.github/workflows/commerce-components.yml) and
  [`journeys.json`](../../../scripts/production-simulation/journeys.json).
- The sources give no archive evidence link for this subsystem.
- Journeys of this subsystem: `services/platform/tests/e2e/idle-tenant-cost.test.ts`,
  `new-organisation-first-chat.test.ts` and `slack-steer-park-loss.test.ts`;
  `services/commerce/tests/punter-acceptance.test.ts`;
  `services/platform/scripts/slack-live-reply-journey.ts`; and the journeys of
  `scripts/production-simulation/journeys.json`.
