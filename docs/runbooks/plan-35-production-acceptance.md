# Plan 35 production acceptance and cleanup

Status: completed 2026-08-31 · retained as the historical acceptance and rollback procedure

## Purpose

This runbook records the procedure used to finish the Plan 35 production canary
and retire its one-time cutover assets. The D1 migration and cleanup completed
in production. The retired cutover utilities must not be recreated or replayed
once `organisation_capability_policy` exists.

The authoritative Phase 7 checkpoint is recorded in
[Plan 35 Phase 7 local canary evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-35-phase-7-local-canary-2026-08-30.md).
The earlier [production readback](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-35-phase-7-production-readback-2026-08-30.md)
is retained for historical thread-continuity and interruption observations.
The later [integration-discovery production evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-35-integration-discovery-production-2026-08-30.md)
records the accepted metadata-only Slack path on exact source `013cafe0` and
Worker `c8da530c`.

## Required steady state

Integration discovery is an intended CafeOS feature. For every supported
active organisation, require `integration.discovery.read` to be enabled, require the
owner and admin baseline grants, and materialize an explicit versioned grant
for every selected Slack agent conversation. Treat a missing capability or
missing intended grant as configuration drift that requires a forward repair.

Discovery returns bounded connection metadata and configured-versus-readable
data classes. Provider content remains protected by its own adapter,
capability, exact grant, resource lifecycle, and information-flow checks. A
deliberately revoked discovery grant remains revoked until an operator grants
it again.

## Entry gate

Name one change owner and pause concurrent deployments for the acceptance
window. Before any production mutation, record:

1. the current git revision used for the canary;
2. `wrangler deployments status --json` and its 100% Worker version;
3. `wrangler d1 time-travel info satyr --json` and the returned bookmark;
4. the mechanism and timestamp for holding control-plane mutations; and
5. the disposable organisation, Slack workspace, channel, and root thread.

Stop if an enforceable mutation hold cannot be named and verified. An operator
announcement alone is not a concurrency boundary.

The historical pre-cutover bookmark must be recovered from the original
cutover receipt before it can be used for rollback. A new bookmark protects the
acceptance and cleanup window; it cannot recreate writes that preceded it.

## Read-only verification

Run the access-control checks from the exact revision under test:

```bash
pnpm --filter @seams/platform check:types
pnpm --filter @seams/platform check:test-types
pnpm --filter @seams/platform test -- \
  access-control-grant-mutation.test.ts \
  access-control-read-route.test.ts \
  capability-policy.test.ts
pnpm portal:build
```

Run the authenticated production closure audit without printing secret values:

```bash
set -a
source .env.local
set +a
WRANGLER_LOG_PATH=/tmp/plan35-credential-closure.log \
  pnpm --filter @seams/platform audit:credential-closure:remote
```

Require a `passed` receipt, the expected organisation cohort, zero D1 findings, zero
active-policy failures, and zero retained-root findings. Record the full JSON
receipt in the production evidence document.

The pre-cutover command now returns `cutover_target_table_exists` in production.
That result protects against replay and is expected. Any additional blocker is
a stop condition.

## Disposable-organisation Slack canary

The production Nuki smoke has already satisfied the root mention, untagged
same-thread follow-up, bounded discovery, configured-versus-readable, and
zero-provider-call checks. It does not replace the disposable-organisation resource
grant, revocation, approval, explanation, or second-workspace isolation checks
below.

Run this path in one new Slack root thread where the agent is installed:

1. Create the disposable organisation and select the exact Slack conversation.
2. Confirm the ordinary conversation defaults are materialized as versioned
   grants with provenance.
3. Mention `@satyr-dev` once in the root message to start the Case.
4. Send the next user reply in the same thread without a mention. Require an
   agent response in that thread.
5. Ask which integrations are connected. Require `integration_list` to return
   only accounts discoverable by the current authority, with configured and
   readable data classes distinguished.
6. Confirm account identifiers, credential handles, inaccessible resource
   contents, and accounts from another Slack workspace are absent.
7. Grant one exact readable resource and prove the follow-up can read it.
8. Revoke that grant, then repeat the protected read. Require immediate denial
   before any credential resolution and no visible Slack output that contains
   the revoked data.
9. Exercise one approval-required effect. Require the Spec 8 approval,
   authority recheck, and exactly-once mutation receipt.
10. Run the decision explanation for the exact conversation and require the
    explanation outcome and runtime delivery decision to match.

Record the root and reply permalinks, Case and session identifiers, policy
versions, mutation receipts, and the observation window. Use the repository QA
skill from the live Slack thread for tool, file, context, logs, and metrics
coverage; a desktop shell without `SATYR_THREAD_KEY`, `SLACK_CHANNEL_ID`, and
`SLACK_THREAD_TS` cannot substitute for that proof.

## Acceptance gate

Accept only when all of these are true:

- the Worker and Portal revision under test is still serving 100% of traffic;
- canonical D1 row counts and legacy/canonical allowed-tool parity hold;
- the credential and Organisation Actor closure audit passes;
- the root mention and untagged follow-up each receive exactly one response;
- integration discovery is redacted, bounded, organisation-isolated, and performs no
  provider request or credential resolution;
- every supported active CafeOS organisation has discovery enabled and each intended
  owner, admin, and selected-conversation grant is active;
- a deliberately revoked discovery grant survives default application and
  policy recompilation until an operator grants it again;
- revocation denies the next protected operation immediately;
- the explanation and runtime decisions match; and
- the canary window has zero unauthorized capability, stale-policy success,
  post-denial credential resolution, or duplicate mutation counters.

Release the mutation hold only after these checks are recorded.

## Failure and rollback

Keep the mutation hold active. Capture the failing response, Worker version,
policy versions, D1 counts, and relevant logs before changing state.

Use `wrangler rollback <version-id>` only with the Worker version recorded at
the entry gate. A D1 Time Travel restore discards every write after its
bookmark. Restore only to the bookmark accepted for the affected window and
only after the owner has accounted for later writes.

If the original pre-cutover bookmark or mutation receipt is unavailable, use a
forward repair. Do not infer a safe historical restore point from timestamps.

## Cleanup after acceptance

Cleanup is a separate reviewed checkpoint:

1. capture another D1 Time Travel bookmark;
2. verify the canary evidence and owner acceptance;
3. drop `organisation_tool_enablement` through one bounded, receipt-producing D1
   change;
4. confirm the Plan 35 cutover SQL, runners, settlement route, and route token
   are absent after the production table readback;
5. deploy the cleanup revision;
6. rerun the closure audit and one untagged Slack follow-up; and
7. update Plan 35 Phase 7 and the production evidence with the final Worker
   version, cleanup receipt, and retained rollback disposition.
