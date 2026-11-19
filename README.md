# Seams Pantry

Seams Pantry: the operating system for modern bakeries & cafés.

People and Sous Chef agents operate Seams Pantry through the Portal and Slack.
The product direction covers the full bakery and café business: demand,
purchasing, recipes, production, quality checks, packaging, inventory, sales,
distribution, and customer service.

Kitchen is the production orchestration area within Pantry. Pantry connects
that work to commerce and daily operations. Agentic ecommerce means agents can
investigate records, prepare changes, and execute authorized commerce actions
with policy checks, approvals, and durable receipts.

The business reference is a pâtisserie selling fresh products and packaged gifts
through shops and online channels, such as Noix de Beurre or Lenôtre. These are
product and distribution references. Seams makes no claim about their use of
robotic production.

Commerce paths from Plans 22 and 23 are accepted. The bounded Plan 42 Kitchen
software supports synchronized canvas, timeline, and spatial views, native
simulation, saved scenarios, and governed chat control. The Plan 60A equipment
simulation phase is complete. Plans 61C–E are implemented and the combined café
shift is released; Plan 61A is in progress and Plan 61B is on hold.

Physical robot enrollment and dispatch remain planned under Plan 24. Simulation
acceptance does not establish physical production readiness. See the
[release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) for exact limits.

## Product surface

- **Pantry Portal:** Kitchen production views, shared agent conversations,
  inventory and order operations, organisation creation, team access, provider connections,
  operating setup, readiness, activation, credential rotation, reconnect, and
  lifecycle controls.
- **Slack operations:** fast acknowledgment, thread context, export-commerce
  tools, production workflows, progress, approvals, and final receipts.
- **Governed automation:** typed actions for people and agents today, with
  machine-facing bakery and robot-fleet actions entering through the same
  policy and authorization boundaries.
- **Commerce contracts:** strict TypeScript (TypeBox) schemas, using the
  merchant-native commerce domain and versioned provider adapters.
- **Commerce ownership:** the commerce engine (`services/commerce`) owns
  transactions; Contracts defines shared types; Platform hosts Sous Chef and the
  Commerce Read Layer. Punter runs independent
  buyer acceptance journeys from `scripts/punter`.

## Architecture

```text
Browser portal ───────────────┐
Slack / provider webhooks ────┼──> services/platform (Cloudflare Worker)
OAuth callbacks ──────────────┘        │
                                      ├── D1 / Durable Objects
                                      ├── Queues / R2 / KV
                                      ├── provider integrations and organisation OAuth
                                      ├── explicit inference route
                                      │   └── Pi via the organisation ChatGPT subscription,
                                      │       an organisation OpenAI key or Seams OpenRouter funding
                                      └── on-demand workspace executor
```

The production Worker is still deployed as `satyr-edge`; the stable name keeps
existing hostnames and OAuth callbacks valid. Satyr is the old name of Seams
Pantry. Code names and commands keep it until the
[Plan 91](docs/plan-91-seams-atelier-rename.md) codemod, and deployed names keep
it after that.

`AgentSessionActor` pins one inference route for a session:

- `organisation_subscription` + `openai`: Pi using the organisation's ChatGPT sign-in
  through pi-ai's legacy `openai-codex` provider (Plan 72).
- `organisation_byo` + `openai`: Pi using the organisation's purpose-bound, Vault-encrypted
  OpenAI API key.
- `platform` + `openai-compatible`: Pi using the Seams `OPENROUTER_API_KEY`.

Missing or exhausted authority fails the selected route. The Actor owns accepted
history, tools, checkpoints, budgets, cancellation, and delivery for every route.

## Layout

```text
satyr/
├── apps/
│   └── portal/                 # React operator portal
├── services/
│   ├── platform/               # Control plane, integrations and Sous Chef
│   ├── workspace-executor/     # Heavy execution Container image
│   └── underclerk/             # Commerce engine: private commerce authority
├── packages/
│   ├── contracts/              # Provider-neutral contract schemas
│   └── bakery-model/           # Kitchen model: recipes, procedures, physics
├── crates/
│   └── workspace-executor/     # Validated workspace execution service
├── docs/
└── scripts/
    └── punter/                 # External buyer acceptance
```

See [`docs/commerce-monorepo.md`](docs/commerce-monorepo.md) for ownership and
extraction rules. [Plan 40](docs/plan-40-product-description-drafting.md) records accepted product
drafting. [Plan 40B](docs/plan-40B-collaborative-menu-editor.md) owns
the proposed collaborative menu editor: menu boards on the shop's screens and
the QR order page.

## Getting started

```bash
corepack enable
pnpm install
node scripts/repo-binaries.mjs fetch
pnpm portal:build
pnpm backend
```

`repo-binaries.mjs fetch` gets the large files that live in R2, not in git: the
Kitchen models, the unpinned Kitchen physics bundles and the equipment manuals. It needs a
Wrangler sign-in. A second worktree on the same machine copies them from a local
cache.

TypeScript checks and package builds use the pinned [tsrs compiler](https://github.com/oxc-project/tsrs).
For a direct check, run `pnpm exec tsrs --noEmit -p path/to/tsconfig.json`.
The `typescript` package supplies the syntax-tree API for repository checks.

The Worker reads local configuration from the platform’s Wrangler configuration
and local environment files. Keep secrets out of source control.

### Named local sites

Caddy exposes the buyer storefronts, operator portal, and Underclerk boundary
under stable local names. Add this line to `/etc/hosts` once:

```text
127.0.0.1 example.cafe example.store example.satyr example.portal example.underclerk
```

Start each development surface in its own terminal:

```bash
pnpm backend
pnpm site
# When local Slack event delivery is needed:
pnpm slack:ingress
```

For local Google sign-in, register these exact values on the web OAuth client:

```text
Authorized JavaScript origin: https://localhost:3003
Authorized redirect URI:      https://localhost:3003/v1/control/auth/google/callback
```

Google OAuth uses the loopback portal origin. The named café and store hosts do
not participate in authentication.

`backend` selects the named local profiles and preserves Square acceptance data.
It requires each service's `.dev.vars.local`; see
[environment configuration](docs/runbooks/environment-configuration.md).
Docker enables the configured containers. Use `pnpm backend --enable-containers=false` for OAuth and commerce
without container startup. `slack:ingress` updates the existing local Slack app
from the same profile and exposes only provider POST routes through its tunnel.

`site` starts Caddy on
the unprivileged local ports in the foreground. Ctrl+C stops Caddy and releases
those ports.
Backend output prefixes each line with a colored service label so concurrent
Underclerk and Platform logs remain distinguishable.
Wrangler provides the local D1, Durable Object, KV, R2, queue, service-binding,
and Worker Loader resources. Docker provides the configured container execution
when available. `site` starts
both buyer storefronts and the operator portal, then prints their named local
links. `pnpm portal` remains available when only the portal is needed. Run
`pnpm local:init` once when local service secrets are missing. Backend startup
preserves data and never seeds or migrates it automatically.

The Platform asks the shared account Worker on each Portal request, through
the `ACCOUNT_PLATFORM` service binding. In local development that Worker is
`seams-sdk-d1-local` of the Seams checkout, and it runs in its own process
(`pnpm router` there). The two Workers share a provision token and two
signing keys. `pnpm local:init` creates them and writes the account Worker's
side to `services/platform/.dev.vars.local.account-platform`. With
`SEAMS_MONOREPO_ROOT` set to the Seams checkout, it also installs those lines
in the `.env.local` of that checkout and keeps the other lines of that file.
An Organisation is created in the local Console, which then provisions it on
the local Platform. While the account Worker does not run, the Portal's
control requests answer `503`.

The local HTTP addresses are:

- `http://cafe.localhost:3001/store/cafe` → café storefront
- `http://store.localhost:3002/store/shipping` → shipping storefront
- `https://localhost:3003` → Pantry operator Portal and OAuth-compatible loopback origin
- `http://underclerk.localhost:3004` → Underclerk API and health boundary
- `http://docs.localhost:3005` → Seams Pantry documentation

Platform and Underclerk remain separate Worker processes. Caddy only owns local
host routing. The `example.cafe`, `example.store`, and `example.portal` names
remain available as aliases. Google sign-in uses the HTTPS loopback origin at
`localhost:3003`.

## Checks

Protected-access checks use the real account authority through a built acceptance Worker.
Build it in a separate `seams-monorepo` checkout, then set its absolute path:

```bash
pnpm -C /path/to/seams-monorepo/tests exec node helpers/buildSharedAccountPlatformWorker.mjs
export PANTRY_ACCOUNT_WORKER_ARTIFACT=/path/to/seams-monorepo/.artifacts/shared-account-platform/account-worker/index.mjs
```

The Worker contains fixture controls and test keys. Use it only for acceptance tests.
Pantry production imports no seams-monorepo source.
CI checks out an exact commit from the public `seams-tech/seams-monorepo` repository.
It installs the locked dependencies and builds the same acceptance Worker in that separate checkout.
Native journeys receive only the built Worker path and record its SHA-256 digest.
The workflow needs no additional access token or repository variables.

```bash
pnpm --filter @seams/platform check:types
pnpm --filter @seams/platform check:test-types
pnpm --filter @seams/platform test
pnpm underclerk:check
pnpm underclerk:test
pnpm portal:build
cargo test --workspace
git diff --check
```

## Collaborative authoring

Plan 40 provides collaborative product drafts. Plan 40B proposes the
collaborative menu editor over the shared drafting foundation.
General desktop filesystem synchronization remains deferred.
Cloud agent profiles and Markdown playbooks belong to Plan 16 and require no
desktop or file-sync path.

## Deployment

```bash
pnpm --filter @seams/platform run deploy
```

The deploy command builds the media Wasm and portal assets and validates the
fleet manifest. It then deploys the Code Mode sandbox Worker, the model exit
Worker, the Platform Worker with its configured Cloudflare Containers, and the
Slack ingress Worker, in that order. See
[the sandbox release runbook](docs/runbooks/code-mode-sandbox-release.md) and
[Plan 73](docs/plan-73-model-exit-worker.md).

## Seams Vault

Seams Vault stores organisation provider credentials and opaque, organisation-scoped
ChatGPT sign-in profiles (a Codex `auth.json`). Ciphertext and lifecycle metadata live in D1, while versioned
encryption roots live in Cloudflare Secrets Store. Runtime consumers authorize
an exact purpose before resolving a credential for one trusted operation.
`OPENROUTER_API_KEY` is a platform deployment secret used only by the explicit
Seams-funded Pi route. That route runs `moonshotai/kimi-k3`; tests that call
OpenRouter set the Worker variable `PANTRY_PLATFORM_PI_MODEL` to the cheaper
`qwen/qwen3.7-flash`.

See the [Vault operations guide](apps/docs/src/operate/vault.md), the
[Vault API reference](apps/docs/src/reference/vault-api.md), and the
[operations runbook](docs/runbooks/vault-operations.md) for configuration,
rotation, revocation, recovery, and compromise procedures.

## Documentation

- [VitePress documentation app](apps/docs/README.md) — run with `pnpm docs:dev`;
  validate with `pnpm docs:check` and build with `pnpm docs:build`.
- [Developer guide](AGENTS.md)
- [Commerce service architecture and monorepo boundaries](docs/commerce-monorepo.md)
- [Collaborative product-description drafting](docs/plan-40-product-description-drafting.md)
- [Collaborative menu editor](docs/plan-40B-collaborative-menu-editor.md)
- [Reusable multiplayer drafting module](docs/plan-40C-multiplayer-module.md)
- [Commerce Kernel and provider integration](docs/plan-9-commerce-lifecycle-lab.md)
- [Policy-governed harness secrets](docs/plan-12-policy-governed-harness-secrets-vault.md)
- [Durable Actor runtime](docs/plan-14-actor-runtime-architecture.md)
- [Connector, Case, and session architecture](docs/plan-15.md)
- [Merchant console and commerce operations](docs/plan-16-merchant-console-commerce-operations.md)
- [Café / patisserie commerce and storefront demos](docs/plan-22-commerce-capabilities-and-storefront-demos.md)
- [Flavored export catalog](docs/plan-23-flavored-export-catalog.md)
- [Bakery production automation and robot-fleet access control](docs/plan-24-cafeos-bakery-automation.md)
- [Organisation Codex subscription OAuth](docs/plan-28-organisation-codex-oauth.md)
