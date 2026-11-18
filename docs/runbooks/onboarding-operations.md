# Merchant Onboarding Operations Runbook

Status: current · Owners: Specs 11–13 and Plan 16

Use this runbook for the authenticated onboarding control plane: organisation
creation, Slack/Shopify/Stripe connections, readiness, activation, reconnect,
disable, cleanup, and archival. Use the operator lookup by support reference,
organisation ID, provider account, or correlation ID before taking action.

Every repair uses an authenticated control-plane operation with an idempotency
key and configuration fence. Direct lifecycle updates in D1 are prohibited.
Connector, Case, and AgentSession state is owned by their respective Actors and
is outside this runbook's direct mutation surface.

Use [Provider callback origins](./provider-callback-origins.md) when adding a
deployment environment or changing a portal/provider-ingress hostname.

## Common incident workflow

1. Open the operator timeline and confirm organisation, environment, lifecycle,
   latest receipt, provider manifest, and webhook health.
2. Preserve the support reference and correlation ID in the incident.
3. Run organisation reconciliation. Automatic repair may restore existing
   permissions and registrations; permission expansion remains action-required.
4. Re-read the timeline and merchant projection. Close the incident only when
   canonical state and a durable receipt agree.

## Provider authorization

| Incident                            | Detection                                                        | Safe repair                                    | Manual action                                              | Closure evidence                                        |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Slack distribution disabled         | `provider_distribution_disabled` or blocked manifest             | Reconcile after distribution is restored       | Enable the distributed installation in Slack settings      | Healthy Slack observation and connected-attempt receipt |
| Shopify scope missing               | `provider_scope_missing`                                         | None; reconciliation cannot broaden permission | Reconnect and grant the manifest scopes                    | New credential generation and scope receipt             |
| Shopify webhook denied or stale     | Registration failure or unhealthy webhook                        | Reconcile an existing authorized registration  | Restore permission, then retry reconciliation              | Desired and observed versions match                     |
| Stripe endpoint missing             | `provider_webhook_unhealthy`                                     | Restore a previously configured endpoint       | Configure the correct test/live endpoint and secret        | Healthy platform observation                            |
| Account ineligible or mode mismatch | `provider_account_ineligible` or `provider_environment_mismatch` | None                                           | Select an eligible account in the organisation environment | Failed attempt followed by a valid connected attempt    |
| Provider rate limiting              | `provider_rate_limited` / HTTP 429                               | Retry through bounded reconciliation           | Escalate only after bounded retries                        | Successful reconciliation with unchanged scopes         |
| OAuth replay or expiry              | `provider_state_replayed` / `authorization_expired`              | Expire stale open attempts                     | Start a fresh authorization attempt                        | One terminal attempt; no raw OAuth state or code        |
| Popup completion lost               | Open or terminal attempt while portal is stale                   | Refresh the canonical projection by polling    | Refresh the organisation page using the same attempt       | Terminal attempt visible without duplicate account      |

## Credential and lifecycle incidents

| Incident                         | Detection                                        | Safe repair                                                        | Manual action                                             | Closure evidence                                       |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Credential verification failed   | `credential_verification_failed`                 | None until a new generation is proven                              | Reconnect or rotate the account                           | Atomic generation cutover and revoked predecessor      |
| Readiness repeatedly invalidated | Repeated `readiness_invalidated` events          | Reconcile credentials, webhooks, primary accounts, and setup pairs | Stabilize the changing dependency and refresh readiness   | Current readiness hash matches input revisions         |
| Activation stalled               | Activating lifecycle with no phase progress      | Scheduled reconciliation resumes from phase receipts               | Run operator reconciliation and inspect the failing phase | Phase receipts, one activation receipt, one first task |
| Organisation placement missing   | `placement_missing` or runtime admission blocker | Restore declared environment placement                             | Correct placement and rerun readiness                     | Placement receipt and ready assessment                 |
| Account cleanup incomplete       | Cleanup remains pending or failed                | Retry provider cleanup without re-enabling the account             | Remove the provider registration, then reconcile          | Completed cleanup row and non-sensitive tombstone      |
| Archive or purge stalled         | Cleanup remains pending past its window          | Revoke credentials, finish provider cleanup, then purge            | Resolve provider cleanup failure and rerun reconciliation | Purged state and retained non-sensitive tombstone      |

## Evidence handling

Export only stable reason codes, support references, correlation IDs, receipt
IDs, lifecycle branches, coarse timestamps, manifest versions, and health
summaries. Keep OAuth values, credentials, provider bodies, merchant form
content, customer content, cookies, CSRF values, stack traces, and internal
storage keys out of incident notes.
