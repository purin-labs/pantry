# Integration discovery operations

## Purpose

Integration discovery lets an authorized Satyr agent answer which integrations
are connected for its organisation. The response distinguishes configured data
classes from data classes the current requester may read.

The feature exposes bounded metadata only. It does not call provider APIs,
resolve provider credentials, enumerate protected resources, or grant access to
provider data.

## Runtime contract

The model receives the `integration_list` tool only when the current authority
partition contains `integration.discovery.read` version 1. A successful result
contains at most 50 deterministically ordered accounts with:

- an opaque account reference;
- provider and bounded display name;
- `available`, `attention_required`, or `unavailable` connection state;
- configured data classes; and
- readable data classes for the current authority.

Canonical integration IDs, provider account IDs, OAuth scopes, credential
handles, provider errors, protected counts, resource listings, and content are
excluded.

Readable data remains independently governed. For example, a connected Stripe
account can report `payments` as configured while reporting no readable data
until the payment-read capability and its required grants are effective.

## Enable a Slack conversation

Use the Access portal for the target organisation:

1. Enable `integration.discovery.read` in Capabilities.
2. Create an active grant whose subject is the exact Slack conversation and
   whose target is `integration.discovery.read` version 1.
3. Confirm the newly compiled policy includes
   `integration.discovery.read` in `authz.allowedTools`.
4. Confirm the D1 policy snapshot, the `POLICY_KV` latest snapshot, and the
   Organisation Actor active policy head agree.
5. Start a new Slack root thread with one `@satyr-dev` mention. Continue that
   thread without mentioning the app.

The initial mention creates the Case. Ordinary replies in that active thread
should reach the same Case without another mention.

For Pi-backed sessions, only the terminal assistant message is eligible for
Slack delivery. Tool-use preambles and intermediate assistant deltas remain in
harness history and must not enter the canonical Connector output stream.

## Production verification

Ask this in a fresh authorized thread:

> What integrations are connected? Distinguish configured data classes from
> readable data classes. Do not make changes.

Accept the result only when:

- exactly one agent reply arrives in the same thread;
- only accounts discoverable by the current authority appear;
- configured and readable data classes are reported separately;
- opaque account references and protected identifiers are absent from prose;
- no provider request or provider-credential resolution occurs; and
- the Worker version under test still serves 100% of traffic.

Repeat the request from an ungranted conversation to verify denial without an
account-existence leak.

## Information-flow behavior

Satyr joins every admitted source label into cumulative Case/session state.
Revocation or policy narrowing takes effect immediately and cannot erase
information already observed by that Case. This is deliberate: broadening a
later grant must not declassify earlier observations.

Run post-grant acceptance in a new root thread when an earlier thread was used
to test different grants, capability modes, or revocation. A cumulative flow
denial in such a historical thread can be correct. Diagnose the flow decision
before changing policy code.

## Troubleshooting

### The app does not answer an untagged reply

- Confirm the reply is inside an active thread that Satyr previously joined.
- Confirm the Connector admitted the event and the Case still exists.
- Check for an expired Case-work lease or a missing recovery alarm.

### The tool is unavailable

- Confirm the organisation capability is enabled.
- Confirm the exact conversation has an active version-1 discovery grant.
- Confirm D1, `POLICY_KV`, and the Organisation Actor expose the same active policy.
- Confirm the active policy contains `integration.discovery.read`.

### Slack says the output was held

- Treat `Message held by Satyr output guardrail.` as a content-screen hold.
  Inspect the terminal assistant output for sensitive entities or leaked
  internal model/tool protocol before changing grants.
- Confirm intermediate tool-use preambles were excluded from canonical Slack
  output.
- Inspect the conversation-delivery flow decision separately. A cumulative
  source-label denial happens at the destination sink and has a different
  cause.
- Retest in a fresh root thread with the final grant state after correcting the
  identified source of the hold.

### The list is incomplete

- Revoked accounts are intentionally omitted.
- Unsupported providers are omitted.
- Connection metadata can be visible while readable data classes remain empty.
- Results are capped at 50 accounts and report `truncated: true` at the bound.

## Focused verification commands

```bash
pnpm --filter @seams/platform exec vitest run \
  tests/integration-discovery.test.ts \
  tests/current-source-flow-label.test.ts

pnpm --filter @seams/platform exec vitest run \
  --config vitest.e2e.config.ts \
  tests/e2e/slack-actor-journey.test.ts

pnpm --filter @seams/platform check:types
pnpm --filter @seams/platform check:test-types
git diff --check
```

Use the full [Plan 35 production acceptance runbook](./plan-35-production-acceptance.md)
for a grant/revoke, protected-resource, approval, isolation, and cleanup window.
