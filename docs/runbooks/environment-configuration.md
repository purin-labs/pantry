# Environment configuration

Status: local Worker, Docker and Slack startup verified on 2026-10-04;
fresh Square owner OAuth and four production identifier values remain pending.
Production deployment was not performed.

## Ownership

| Setting                                                                                          | Owner                                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Public/callback/ingress origins, provider modes, application IDs, service targets, Vault version | `services/*/wrangler.jsonc`, named `env.local` or `env.production`                         |
| Local Worker ports and inspector ports                                                           | Each service's shared top-level Wrangler `dev` settings                                    |
| Local application secrets                                                                        | Each service's ignored `.dev.vars.local`                                                   |
| Deployed application secrets                                                                     | Cloudflare secrets for the explicitly selected Worker                                      |
| Vault roots                                                                                      | Existing Secrets Store bindings                                                            |
| Seller credentials                                                                               | Existing encrypted Vault records; organisation/account/environment fences remain unchanged |
| Browser settings                                                                                 | Public Vite values only; no Worker environment is passed to the portal bundle              |
| Acceptance persistence                                                                           | Each service's `.wrangler/square-acceptance`                                               |

Production `GOOGLE_OIDC_CLIENT_ID`, `SLACK_APP_ID`, `SLACK_CLIENT_ID`,
`GDRIVE_OAUTH_CLIENT_ID`, and `GDRIVE_PICKER_APP_ID` have verified values in
`env.production.vars`. The first three retain their existing deployed secret
bindings until an authorized rollout replaces them. Drive's client and Picker
app IDs were already deployed as plaintext vars; they are now explicit in source.

Four application identifiers remain in existing Worker secrets:
`SQUARE_OAUTH_CLIENT_ID`, `SHOPIFY_CLIENT_ID`, `STRIPE_CONNECT_CLIENT_ID`, and
`STRIPE_CONNECT_WEBHOOK_ID`. Cloudflare lists secret names without exposing their
values. Verify the production application's values in the owning provider console
before moving them. Local Sandbox IDs must never be copied into production.

## Standard local commerce path

Public ports remain 3001 (café), 3002 (store), 3003 (HTTPS portal),
3004 (Commerce API), and 3005 (docs). Internal servers use 3101 (Platform),
3102 (Commerce), 3103 (portal Vite), 3104 (storefront Vite), and 3105 (docs).
Optional provider ingress uses 3111 and the local harness uses 3112. Worker
inspectors use 9231 and 9232; Codex's existing provider login callback uses 1455.

OAuth provider consoles must allow `https://localhost:3003` callbacks. The
Google web client needs that JavaScript origin and
`https://localhost:3003/v1/control/auth/google/callback`; Square Sandbox needs
`https://localhost:3003/v1/control/providers/square/callback`. Provider-side
confirmation remains pending. Production callbacks are unchanged.

```sh
pnpm local:init
pnpm portal:build
pnpm storefront:build
pnpm backend
# In a second terminal:
pnpm site
# When Slack delivery is needed, in a third terminal:
pnpm slack:ingress
```

For an existing installation, retain its secrets and persistence. `local:init`
creates missing local service/signing secrets; provider secrets still need to
be supplied in `.dev.vars.local`. Examples contain secret names only.

Platform listens internally on `http://127.0.0.1:3101`; Commerce listens on
`http://127.0.0.1:3102`. The public portal and OAuth origin is
`https://localhost:3003` through Caddy. Service bindings join the two local processes.
Remote bindings are disabled. When Docker is available, backend startup builds
the configured native containers and reuses the existing local Codex harness.
A stopped harness is restarted with its stored state; a missing harness is
built from the profile's existing container recipe. For OAuth and commerce
without container startup, use `pnpm backend --enable-containers=false`.
Docker absence also leaves that operating path available.

Startup never seeds, resets, or
silently migrates existing acceptance data. Apply an intentional migration with
`pnpm --filter @purin-labs/platform d1:migrate:local`.

The launcher requires the environment-specific secret file and disables dotenv
fallback. Avoid `--env-file`: Wrangler's native `--env local` file selection
loads `.dev.vars.local` directly. Origins and provider modes come from vars,
so the required-secret filter cannot drop them.
Platform local startup requires only its service and session/state-signing
secrets. Optional integration credentials are loaded from the same file and
validated by the provider boundary, so missing Dropbox or Gmail credentials
cannot prevent Square testing or unrelated portal functions from starting.

Square uses `development`, which selects `connect.squareupsandbox.com`.
Missing/unsupported environment or recognizable cross-environment application
IDs fail configuration validation. OAuth initiation also checks the organisation's
environment before creating an attempt. Token exchange, refresh, and revocation
check the account/attempt against the configured application environment.

`pnpm slack:ingress` reads the local app ID and callbacks from the same profile,
requires Slack application secrets in Platform's `.dev.vars.local`, refreshes
the existing tooling OAuth pair in root `.env.local`, updates the existing
local app, and waits for its restricted tunnel. Restarting the command assigns
a fresh tunnel URL and updates that app again. Keep the command running while
local Slack delivery is needed. It accepts only POST `/slack/events` and
organisation-scoped `/hook/shopify/:organisationId`; the Worker validates provider signatures.
Portal and control paths return 404. Shopify registration still follows the
fixed Worker ingress profile and needs its own verified routing before use.

The existing `square-sandbox-webhook.seams.sh` tunnel is independent. Its ingress
must continue to expose only the Square webhook path. It does not provide portal
or OAuth callback access. Other provider ingress is not certified through this
Square-only hostname.

## Production

The package deployment commands explicitly select `production`, retaining
`pantry` and `commerce` and their existing resource identities. Production
origins must be HTTPS and cannot be loopback.
Production container application names are pinned explicitly; Wrangler would
otherwise append `-production` to their previously generated names.

There is no staging environment. Its Workers, databases, bucket, KV namespace,
queues and containers were deleted on 19 November 2026
([Plan 93](../history/plan-93-clean-cutover.md), step 1), and the launcher accepts only
`local` and `production`. A new staging stack needs its own plan: Worker
names, databases, storage, queues, service bindings, root keys, application
secrets, origins and provider allowlists. No staging resource may alias
production.

Direct Wrangler commands must select an environment explicitly. Secret upload
and deletion helpers require `--env production`; they do not choose a default.
Slack manifest and M6 preparation helpers also require an explicit profile.
`pnpm slack:app:update` and `pnpm slack:m6:prep` select production;
`pnpm slack:public-app:update --request-url <tunnel>/slack/events` selects local.
Manifest templates own permissions and features. Helpers derive callback URLs
and production event delivery from the selected profile and reject conflicting
production ingress overrides. Direct configuration-token helper calls require
`--environment local` or `--environment production`.

## Verification

```sh
pnpm test:environments
pnpm --filter @purin-labs/platform test:onboarding-closure
pnpm --filter @purin-labs/platform check:types
pnpm --filter @purin-labs/platform check:test-types
pnpm portal:build
# With pnpm backend running, before pnpm slack:ingress starts on port 3111:
node scripts/environment-acceptance.mjs local output/environment-acceptance.json
```

The loading test uses the pinned Wrangler loader and disposable secrets. It
proves that the actual local vars generate a Sandbox authorization URL. Startup
tests reject missing secret files, unavailable profiles, and loopback production
callbacks. Configuration validation never prints secret values.

Checks on 2026-10-04: 2,390 Platform tests passed (3 skipped), 51 onboarding
closure tests passed, configuration loading checks passed, Platform source/test
and Commerce type checks passed, and the portal build passed. Both production
Worker dry runs passed without upload; the Platform dry run used
`--containers-rollout none`. Normal backend startup built all four configured
native container images. The public Slack tunnel accepted repeated signed UTF-8
URL verification requests, rejected invalid signatures, and denied portal/control
paths. Production Slack manifest readback was unchanged.

The existing Seams KK account remains active in `development`; its prior
successful OAuth attempts are preserved. A fresh owner-initiated resource read
returned one location and 20 terminal devices using that preserved credential.
Fresh OAuth acceptance reached the
Sandbox authorization host and is awaiting the owner's Square developer login.
Complete the developer login, launch the existing Sandbox test account, then
start a fresh portal refresh and read locations and devices.

Public results are in the [dated acceptance record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-41-follow-up-2026-10-04.md),
[environment E2E receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-41-environment-acceptance-2026-10-04.json),
and [public ingress receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-41-public-ingress-2026-10-04.json).
The [Square readback receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-41-square-readback-2026-10-04.json)
records the existing account credential and keeps fresh OAuth acceptance pending.

The original local secret files were moved to the private backup directory
`/tmp/pantry-env-migration.izd9Yk`; active secrets are in `.dev.vars.local`.
No secret values or database contents were deleted.

For a real-user proof, open the signed-in local portal, select Square, refresh
access, then refresh locations and devices. Record only the outcome,
environment, and account identity. A green unit test does not prove live OAuth.

## Remaining acceptance and rollout

The competing Docker/Slack backend launcher was removed after the standard
backend and restricted ingress paths passed. Historical acceptance tools retain
their script-specific credentials. The Square Terminal certification runner
requires an explicit profile before its run ID and resolves its provider mode
through the Wrangler configuration.

The two remaining Plan 41 gates are fresh owner Square OAuth/readback and
verification of the four production identifiers listed above. During a separately
authorized production rollout, replace verified identifier secret bindings with
their matching profile vars. Application secrets and Vault roots retain their
existing authority. Review resolved configuration and a dry run before upload;
the work recorded here performs no production mutation.
