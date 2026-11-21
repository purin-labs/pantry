# Runbook — Urk Order Attention Acceptance

Owner: `services/platform` · Plan: [Plan 39](../plan-39-urk-merchant-agent-parity.md)
Scope revised: 2026-10-01 · Mock-order acceptance passed

The operator selected mock orders as the acceptance target on 2026-10-01.
The [completed exercise](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-mock-shop-2026-10-01.md) reuses the
Worker E2E fixture, real Urk inference and native commerce reads. The historical
real-shop/manual-comparison gate below is deferred by that instruction.

Prove one workflow: ask Urk which failed payments and delayed orders still need
attention, investigate an item, and refresh after resolution. This replaces the
previous broad merchant-release gates. Refactor 7 removed the superseded
multi-scenario scorer.

Urk's definitions live in `services/platform/src/data/urk-skills.ts`;
installation lives in `urk-preset.ts`. The existing five default skill names
remain. The shared instructions now define order-attention qualification, and
the performance skill permits a fresh read when records change. Existing
installations pin stored revisions: changing the source templates or rerunning
installation does not update them. Before acceptance, publish the revised skill
and agent definition through the existing agent configuration operations and
select that definition revision for the tested installation. Record the selected
revisions. Commerce access remains
behind governed tools. Urk never reads or writes a commerce database directly
and holds no PII decryption authority. External content cannot grant authority
or bypass approvals.

## Preparation

1. Record the tested commit, any uncommitted changes, deployed version when
   applicable, pinned agent/model/skill revisions, and the commerce provider.
2. Verify the actual merchant account and the existing read permissions. The
   September 8 Café setup report is historical evidence, not a current account
   inventory. Do not assume a test organisation is the user's shop.
3. Identify the source records, payment-to-order linkage, deadlines, sync
   coverage and timestamps available to this account. Write down missing facts.
4. Use an isolated test merchant for fixture changes. Keep the real-shop
   comparison read-only. Reuse existing test and evidence tooling.
5. Verify conversation-scoped source grants for orders, payments, fulfillments
   and shipments. The installed `commerce.entity_plane.context` capability
   does not grant access to those records, and an owner's personal grants do
   not authorize reads shared with a Slack channel.
6. Start a fresh Slack thread with the bot mention followed by `Agent Urk:`.
   Explicit addressing selects Urk when multiple agents are active. Subsequent
   replies retain the Case's pinned definition and skill revisions.
7. Complete configuration changes before starting the thread. Verify that the
   answer compares `expected_by` with the platform's current request time and
   reports source `observedAt` separately. A record last updated before its
   deadline can still be overdue in a current read.
8. Check the workspace's cumulative session budget before the three requests.
   The controlled September 30 exercise exhausted the 180-second default after
   its brief. A second session then exhausted 64,000 tokens during investigation.
   It used the existing AI budget control to allow 600 seconds and 256,000 tokens
   for a new session, retaining 20 tool calls. Existing sessions keep
   their limits and usage; a configuration change requires a fresh thread.

No customer messages, charges or business mutations are required to accept this
read-and-investigate feature.

The [October 1 follow-up](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-runtime-followup-2026-10-01.md)
preserves an OpenRouter HTTP 402 rejection before any commerce read. The request
reserved 65,536 output tokens while the remaining credit allowance covered
37,862. The operator replenished credits; the same Case then completed its exact
investigation and refresh, with two settled Slack receipts and matching native
records. A larger cumulative session budget does not supply provider credits.
Provider-failure recovery is covered by the existing Worker E2E and the live
funded rerun. TypeSafe AI owns the separate JEV evaluation path.

### Ready-to-run Slack requests

Use the approved shop's existing Slack destination. Put the bot mention before
the first request. Replace the investigation's order reference with an actual
item from the delivered brief; keep the subsequent requests in that thread.

1. `Agent Urk: Which orders need my attention because of unresolved failed
   payments or delays? Check later successful payments and cancelled/completed
   work, group attempts by order, and check recorded deadlines even if the
   exception report is empty. Include existing record references and say which
   source records, pages and timestamps you checked.`
2. `Investigate [order reference] from your brief. Re-read its linked payments,
   order, fulfillments and shipments. Explain the evidenced problem, what is
   still uncertain, and the next manual step.`
3. After the controlled source resolution is independently confirmed:
   `Refresh the order-attention brief from current source records. Re-check
   [order reference] and explain whether the evidence now clears it. Include
   any other issues that remain and disclose incomplete coverage.`

Before the first request, record the operator's manual findings and elapsed
time. For each issue, retain its existing reference, payment or deadline
evidence, expected inclusion, and observed inclusion. Record the resolution
receipt and source revision before the refresh. Finish with the operator's
elapsed time using Urk, omissions, false alarms, and judgment of usefulness.
Leave unavailable measurements blank and identify them as unavailable.

## End-to-end exercise

Use the existing application entry point and real authorized commerce read path.
A mocked report response alone is insufficient. Use the configured route intended
for the pilot; adding support for other model routes is outside this exercise.

Prepare a bounded set of orders containing:

| Record state                                                              | Expected result                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Multiple failed attempts on one still-unpaid order                        | One attention item identifying the payment problem and affected order.  |
| A failed attempt followed by a successful payment                         | No unresolved-payment alert for the recovered attempt.                  |
| An incomplete order past its recorded fulfillment deadline               | A delay item naming the missed deadline and current state.              |
| A carrier delivery exception without a known deadline                     | An exception item with its actual reason; no invented overdue duration. |
| An open order still within its deadline, plus a completed/cancelled order | No delay alert solely because the order exists or is open.              |

Then perform the complete interaction:

1. Ask, "Which orders need my attention because of failed payments or delays?"
   Compare every reported item, reason and reference against the source records.
   Failed attempts and shipments must not be miscounted as distinct orders.
2. Ask what happened with one affected order. Check its linked payment and
   fulfillment evidence, freshness and suggested manual next step.
3. Resolve one problem through the fixture's existing source operation. Allow
   the normal synchronization path to observe it, then ask again. The resolved
   item must disappear while the other problem remains.
4. Exercise a missing-access or unavailable-source condition. The answer must
   name the missing coverage rather than report a clean shop.
5. Exercise changed records between reads and bounded/truncated results using
   the existing fixture controls. Verify a retry or qualified result for changed
   data and an explicit partial result when coverage is incomplete. Do not add
   a separate fixture platform for these conditions.

Reuse existing safety and boundary coverage. Add E2E coverage only for a real
gap in this workflow, following repository test guidance. Run the required
checks for the implementation files changed.

## Evidence artifact

Save one readable evidence report with supporting machine-readable output from
the existing tooling. Record:

- Exact build, route, skill, provider and fixture identities.
- Seed/reset instructions or existing commands that reproduce the starting state.
- Authorized source records before and after the controlled resolution, including
  deadlines, payment outcomes, relationships and source timestamps.
- The question, follow-up, delivered answers, Case/trace references and observed
  source reads.
- Expected versus observed items, false alarms, omissions, partial coverage and
  the result of each exercise step.
- Completion time, available usage/cost and errors. Label unavailable measurements.
- Independent evidence that the agent made no business mutations; distinguish
  the deliberate fixture resolution from agent behavior.

Use a dated file under `docs/evidence/` when this exercise is actually run.
Protect customer data using the existing evidence/redaction practices. Do not
add a new manifest, scoring framework or artifact schema.

## Real-shop comparison

For one representative daily check, have the operator review the same account
and records manually, then compare Urk's list and one investigation follow-up.
Record manual time, Urk-assisted time, incorrect or missing items, and the
operator's judgment of whether the answer reduced work.

All visible actionable issues within the declared coverage must be accounted
for or explicitly marked as uncertain. Every reported problem must have source
evidence. A zero-issue shop can establish live access and an accurate empty
result; the controlled exercise still supplies evidence for positive cases.

If the provider lacks a required feed, deadline or linkage, record that specific
blocker. Do not declare the full failed-payments-and-delayed-orders workflow
complete from an exception-only report or a synthetic merchant.

## Acceptance and follow-up

Accept after the end-to-end exercise passes and the operator confirms a useful,
accurate improvement over manual checking. Preserve failures and repeat the
affected steps after fixes. Record the actual observed timings; no latency or
cost result has been established by this plan audit.

Automation, execution actions, extra providers and the retired feature matrix
need separate demonstrated demand. They are not prerequisites for acceptance.
