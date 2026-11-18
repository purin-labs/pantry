# Satyr staging

Satyr staging uses `https://staging.satyr.seams.sh/portal`.
It has its own data, queues, storage, encryption keys, sessions, and service-signing keys.
The existing production and local profiles remain unchanged.

## Deployment targets

| Component           | Staging target                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- |
| Platform and Portal | `satyr-edge-staging`                                                                |
| Code Mode sandbox   | `satyr-code-mode-sandbox-staging`                                                   |
| Commerce service    | `underclerk-staging`                                                                |
| Account service     | `seams-sdk-d1-console-staging`, entrypoint `SatyrAccountPlatform`                   |
| Global database     | `satyr-staging-global-apac`, `71685d97-1ff9-48fc-9b95-b8aa5068f03a`                 |
| Regional database   | `satyr-staging-organisation-apac`, `e4c84444-8f5e-4506-b0eb-f00bcca915e5`           |
| Policy KV           | `satyr-staging-policy`                                                              |
| Archive bucket      | `satyr-staging-archive-apac`                                                        |
| Queues              | `satyr-staging-events`, `satyr-staging-cues`, and their separate dead-letter queues |

The deployment uses one APAC placement cell, `staging-apac`.
Its containers each have a maximum of one instance.
The private sandbox has no public route or data bindings.
Provider connections remain subject to their existing setup and permission checks.

## Repeat deployment

Supply the existing Cloudflare deployment credentials, then run:

```sh
pnpm --filter @seams/platform exec wrangler whoami
pnpm --filter @seams/platform deploy:staging
pnpm --filter @underclerk/worker deploy:staging
```

The first command builds the current Portal, checks both database schemas, and
deploys the sandbox, the exit Workers and Platform. The second command builds
the storefront and deploys the commerce service, Underclerk, which has its own
release since Plan 76 phase 2.
Automatic resource creation remains disabled. The named staging profiles contain
the allocated resource identifiers.

The first deployment needed a private Platform upload before the commerce
service, because the commerce service then called Platform's payment
entrypoint. Plan 80 removed that call, so the services deploy in either order.
Repeat deployments use the full profile.

The October 15 rollout built a Git archive of committed source. This excluded
concurrent model edits from the uploaded Portal assets. Existing Docker Desktop
credential lookup stalled during the first public image fetch. An isolated Docker
configuration completed the same deployment. The user's Docker settings stayed unchanged.

## Account connection

The private account binding targets staging Console. Both services use separate
Ed25519 keys for user assertions and provisioning assertions. The deployment
identifier is `satyr-staging`.

The logical account assertion audience and provisioning issuer remain
`https://staging.wallet.seams.sh`. The Satyr issuer and audience use
`https://staging.satyr.seams.sh`. These values identify signed assertions; they do
not select a browser destination.

Protected local credentials live under `/Users/pta/.seams/satyr/`.
The existing Console staging environment also holds the complete connection settings.
The `staging-console` GitHub environment has the corresponding 14 deployment values.
No credential values belong in this repository.

## Acceptance and pending actions

Health, Portal HTML, and unauthenticated account checks pass on the staging domain.
The private provisioning endpoint rejects unsigned requests. Console retains its
existing secret bindings, database, service bindings, placement, and passkey relying-party ID.

The existing shared-account E2E passes with a built account Worker. Its JSON report
records identity verification, project selection, lost-reply recovery, replay,
foreign-access rejection, and disabled-state preservation.

The rollout also fixed regional recovery ownership for account tables. The regional
authorization schema now keeps global user identifiers without a foreign key into
the separate global database. Its repair script preserves existing authorization rows:

```sh
pnpm --filter @seams/platform exec wrangler d1 execute ORGANISATION_DB_APAC \
  --env staging --remote --file scripts/regional-claude-authorization-user-patch.sql
```

This repair is applied to staging. Production remains a separate release.
The regional recovery E2E passes. Other regional journeys still need their fixtures
to establish current account-service eligibility before they exercise protected work.

Google sign-in uses this approved redirect on the existing **Satyr Portal** client:

```text
https://staging.satyr.seams.sh/v1/control/auth/google/callback
```

The callback is saved and verified in Google Cloud. Manual sign-in reached the
callback after the user canceled ChatGPT browser control. The original Chrome block
remains unexplained. A fresh attempt then returned `scope_forbidden` from Console.

Console passed an unbound Worker `fetch` function to Google verification and native
provisioning. Cloudflare rejected that call. The fix uses the existing bound-fetch
pattern and returns HTTP 503 for provider failures. Identity checks remain intact.
Console staging version `1b9dbae7-e518-4e33-916c-87dc638695c9` contains the fix and public fetch routing.
The actual Worker E2E passes through Google verification, account/project creation,
automatic Satyr setup, and replay. Health and Console readiness checks also pass.

Fresh manual Google sign-in passes after the deployment. Read-only staging records
confirm that Satyr linked the native identity to Platform. The browser opened
`/portal%20i`, which does not match a Portal page. Return to organisations restores
`/portal` with the current session. The user selected an existing Platform account
and project. Setup completed after 274 seconds through durable retry. Console and
Satyr agree on one active instance, one native organisation, and matching revision-one
receipts. The user confirmed organisation or workspace entry after refresh on
October 15, 2026.
Browser protections remain unchanged. Creating a Platform project alone provisions no product.

Live probes identified a same-zone routing fault in Console's global fetch.
HTTP invocations returned 522 before reaching Satyr. Scheduled invocations reached
Satyr with the same awaited requests. Adding `global_fetch_strictly_public` to Console
alone made both contexts return the expected health 200 and unsigned-provisioning 403.
Response hashes matched public controls. This verifies the measured routing fault;
the logs do not identify every historical defer. Temporary probes are removed.

Portal staging version `5671d1bd-d0ce-4bde-b4ce-0bfd5aadb3ef` uses committed application source
`5eb4152e3064372d21f1a0036903c5606bafe478`. The button says Set up Satyr.
Configuration revision `a54088ad53b54fe8860b1153d19401698016e31f` adds the staging placement hint.
Setup completion updates account state without a document reload. Existing membership
skips duplicate session and organisation reads. The user confirmed one load and
estimated about five seconds, down from about ten.

The document head applies saved appearance before the first visible frame.
System mode follows the browser setting. Account preferences remain authoritative.
The browser journey covers uncertain acceptance, operation replay, pending setup,
workspace entry, saved Dark appearance, and System mode. Local and published staging
assets pass with mocked account APIs. Real setup and workspace entry were confirmed
separately by the user. The user also confirmed Dark starts without a Light flash.
Portal type checks and its build pass. Bindings, sessions, and containers are preserved.

The organisation list now has one loading layout with its final heading and navigation.
Portal code and validators load together. Remembered organisation identifiers start
fresh authorised reads alongside the session request on return visits. Fresh session
memberships select the displayed organisations. The browser journey checks the heading
position through the ready screen and confirms no revoked card appears in observed frames.

Before this release, the user reported about 3.5 seconds and three loading layouts.
Live traces measured about one second for the session, followed by about 2.3 seconds
for organisation details. The reproduction verifies overlapping requests after the fix.
A first visit without remembered identifiers still waits for the session before it
can request organisation records.

The user confirmed one loading layout after this release, but reported nine seconds.
Slow requests entered through PDX; earlier requests entered through NRT. Their low CPU
times show that the Worker spent most of its elapsed time waiting. The specific wait
was not instrumented. Database probes report the global primary in HKG, with regional
and account primaries in SIN.

Staging now requests `placement.region: aws:ap-southeast-1` through the existing
[Cloudflare placement setting](https://developers.cloudflare.com/workers/configuration/placement/).
The health response confirms `cf-placement: remote-SIN`. The same application assets
remain deployed. Local and production placement stay unchanged. Existing environment
checks pass.
The user subsequently reported roughly 2.5 seconds and accepted the result.
Latest authenticated requests returned HTTP 200: session 688 ms, organisation 1,230 ms.
They entered through NRT. This ingress change prevents attribution of the full
improvement to placement alone. The single loading layout and startup check are accepted.

The Console rollout now includes the invitation acceptance page and identity-based
redemption. Its browser journey verifies recipients without developer accounts,
wrong accounts, invalid tokens, replay, revoked links, and preserved project grants.

Evidence is saved in the Console repository under `.artifacts/platform-console/rollout/`.
The final release report is `satyr-apac-placement-release.json`. Browser screenshots and
results are in `satyr-startup-browser-live/`. The before/after trace and evidence limits
are in `satyr-single-loading-evidence.json`.
`satyr-portal-startup-regression.json` records the slow requests. The location control
is in `satyr-portal-placement-observations.json` and `satyr-apac-placement-health.json`.

Production still needs a preflight of existing organisations and the private account
connection. Its live Worker lacks `ACCOUNT_PLATFORM`. Complete that preflight before
releasing the account-service admission changes or changing production Console routes.
