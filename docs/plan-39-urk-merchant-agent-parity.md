# Plan 39 — Urk: Failed Payments and Delayed Orders

Status: acceptance passed with operator-approved mock orders; production fixes deployed · Revised: 2026-10-01
Owners: Urk and Satyr platform

## Product decision

Make Urk useful for one daily job: **find failed payments and delayed orders
that still need the operator's attention**. The user selected this priority on
2026-09-27.

The operator asks in Slack, "Which orders need my attention?" Urk returns a
short, evidence-backed list, explains each problem, and points to the existing
record or operational screen where the operator can act. A follow-up such as
"What happened with this order?" explains its payment and fulfillment history
from authorized records.

This decision replaces the earlier five-capability release, blueprint parity,
Portal/Slack configuration parity, P39-0–8 and R1–R5 completion requirements.
The retained filename preserves incoming links. Historical plans remain in Git:
the pre-audit dev document at `63930136` and the larger Merchant release
document at `15391b7f`. Their unfinished checklists are historical context.

The operator authorized mock-order acceptance on 2026-10-01, replacing the
remaining real-shop/manual-comparison gate. The controlled acceptance below
closes this deliverable. Real-shop usefulness and the separate latency target
remain unmeasured by that exercise.

## One deliverable

An on-demand **order attention brief**, in the existing Slack conversation:

- Identify unresolved payment problems and overdue or exception-bearing orders.
- Give the order reference, specific reason, relevant time, source freshness,
  and a link to an existing record or screen when a valid destination exists.
  Otherwise give a usable record reference without inventing a URL.
- Explain the next manual step from the known condition. Distinguish that advice
  from an action Urk has executed.
- Let the operator investigate an item in the same conversation.
- Re-read current state when asked again, so recovered payments and resolved
  delivery problems disappear from the active list.

The first release reads and explains. The operator handles payment collection,
customer contact and fulfillment changes through existing tools. Adding an
execution action requires a demonstrated recurring need after this brief is
useful. Scheduled messages and continuous monitoring are outside this release.

## Audit findings

Source inspected: dev `6393013648efe336511e3a3acd1da3b7f4680cd2` and Merchant
release `15391b7f65fd30ec30e755ec923355dfea097e74`. This was a source and plan
audit; no current merchant deployment or account was queried.

| Finding                                                                                                                                 | Evidence                                                                                                                                                                                                                                                 | Consequence for this release                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Useful read foundations already exist on dev.                                                                                           | [Named reports](../services/platform/src/commerce/entity-plane/merchant-reports.ts), [authorized runner](../services/platform/src/commerce/entity-plane/merchant-report-runner.ts), and [Urk instructions](../services/platform/src/data/urk-skills.ts). | Reuse the existing commerce reader and agent runtime.                                                                                                                      |
| `payment_failures` counts Payment records whose lifecycle is `failed`. It does not check the linked order or later successful attempts. | `merchantReportDefinition("payment_failures")`.                                                                                                                                                                                                          | A failed-attempt count cannot establish how many orders still need payment attention.                                                                                      |
| `fulfillment_exceptions` selects Shipment records in `delivery_exception`. `open_orders` only excludes fulfilled/cancelled orders.      | Named reports; [home aggregation](../services/platform/src/commerce/entity-plane/graph-reader.ts) also calls the exception count `home_delayed_shipments`.                                                                                               | Check actual deadlines and order/fulfillment state before claiming an order is late. An exception may also need attention without being overdue.                           |
| Report populations contain identifiers, revisions and display names, with a 25-record limit and no ordering.                            | `statePair` and `recordsFrom` in the report files.                                                                                                                                                                                                       | Read the relevant order/payment/fulfillment details for reasons and next steps. Make partial coverage explicit; do not present the first page as a complete priority list. |
| Dev reads the count and supporting records separately without comparing their merchant revisions.                                       | `runMerchantReport`; release commit `b54295df6` adds that comparison and explicit missing-freshness handling.                                                                                                                                            | Recover this small consistency fix when implementing the brief. Request time must remain distinct from source freshness.                                                   |
| There is already an Operations workbench for missing tracking.                                                                          | [Plan 31-C](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31C-ecommerce-operations-workbench.md) and [workbench implementation](../services/platform/src/commerce/operations-workbench.ts).                                                                                                     | Link to existing operational work when supported. Its missing-tracking cohort does not cover every delayed order or failed payment.                                        |
| The reader has Satyr Commerce and Shopify paths; provider mapping alone does not prove complete, current data for this merchant.        | `CommerceGraphReaderOptions` and [Shopify normalization](../services/platform/src/shopify-connector.ts).                                                                                                                                                 | Verify the user's actual connected system, record coverage and freshness first. Do not assume an Underclerk lab proves current-shop usefulness.                            |
| Existing brief tests exercise report construction through a fixture reader. Historical acceptance is incomplete.                        | [Brief tests](../services/platform/tests/urk-daily-brief.test.ts), [September 8 baseline](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-cafeos-baseline-2026-09-08.md), and the release branch's status table.                                                                      | Require one meaningful end-to-end scenario and a real-shop comparison. Neither historical setup failures nor later lab successes establish today's readiness.              |

## What counts as needing attention

**Payment problem:** the source records a failed attempt and the related
order/payment state still supports an unresolved problem. Check later successful
attempts and cancelled orders before raising it. Group repeated attempts for the
same order into one item. If an attempt cannot be linked to an order, identify it
as an unlinked payment requiring investigation and keep it out of order totals.
Do not describe failed attempts as lost revenue.

**Delayed order:** a recorded fulfillment deadline has passed and the
corresponding work remains incomplete. Show which deadline was missed; identify
pickup, dispatch or delivery only when the source supplies that meaning. A source
delivery exception is a separate reason for attention, even without a deadline.
An old or open order alone does not establish lateness. When the provider supplies
no usable deadline, state that overdue detection is unavailable for that portion
of the report.

**Resolved item:** current payment, order or fulfillment evidence establishes
that the original problem is cleared or no longer actionable. A prior assistant
reply, task assignment or proposed action does not establish resolution.

Show the most time-sensitive evidenced issues first, using recorded deadlines
where available. Keep uncertainty visible when payment linkage, deadlines,
freshness or source coverage are missing. Report confirmed findings separately
from records that still require investigation.

## Small implementation sequence

### 1. Prove access to the current shop

- [x] Identify the connected commerce account and existing Urk installation.
- [ ] Verify access to representative orders, their payment attempts and their
      fulfillment/shipment records through the existing authorized reader.
- [ ] Record available deadlines, linkage, synchronization coverage and source
      timestamps. Distinguish no matching problems from missing access or data.
- [x] Fix only the installation, permission or provider-read gap blocking this
      workflow. If a required fact is unavailable, name that exact gap before
      expanding integration work.

Nuki Inc. / Cafe operations uses Satyr Commerce and has an active Urk
installation. Authoritative storage reads confirm zero orders, payments,
fulfillments and shipments. Representative shop data
and the operator's comparison remain required. Neither a new shop nor a new
commerce backend is required by this plan.

The [September 30 implementation check](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-start-2026-09-30.md)
reran the backend read acceptance and updated the source instructions for
order qualification, investigation and fresh reruns. At that checkpoint, live
source coverage and the positive-case exercise remained open.

The [September 30 production release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-production-release-2026-09-30.md)
deployed the authorized reader, portal, Slack selection and request-time fixes
from an isolated checkout. Nuki's current Urk definition 8 and performance skill
3 are active. Its earlier definition-4 Slack exercise in CafeOS #cafe-ops read
all four empty entity types successfully at merchant revision 93. This establishes
access and accurate empty-shop handling; representative current-shop records and
the manual comparison remain required.

The separate, approved Plan 39 Commerce Lab now has a private Seams
#plan39-acceptance destination with four scoped commerce read grants. Three
native synthetic pickup orders supplied two overdue fulfillments and one
completed control. On active Urk definition 20, a fresh Slack brief identified
both overdue orders, and its same-thread investigation re-read current evidence.
Two exact-record attempts failed; successful complete page reads supplied the
answer, and Urk disclosed that limitation.

The designated Resolve fixture was then completed through native pickup
operations, advancing the merchant from revision 135 to 137. The same-thread
refresh cleared Resolve, retained Remain, and excluded the completed control.
It disclosed that individual payments and shipments were not rescanned in that
turn. The lab used its existing AI budget editor to allow 256,000 tokens and
600 seconds for new sessions while retaining 20 calls and read-only permissions.
Nuki's budget and commerce records were unchanged.

The evidence preserves earlier deadline/clock failures, two exhausted sessions
and a quarantined runtime incident. The successful controlled delay workflow
does not establish live failed-payment positives or usefulness for the current
shop. The acceptance runbook still requires representative payment failures and
the operator's manual comparison.

The [October 1 runtime follow-up](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-runtime-followup-2026-10-01.md)
deployed provider-error preservation and accepted-history cursor recovery for
Pi retries. Its Worker/Durable Object recovery E2E passed. The live exact-record
investigation first reached OpenRouter and was rejected with HTTP 402 before any
commerce call. After the operator replenished credits, the same Case completed
three exact investigation reads and nine exact refresh reads without errors or
page fallback. The refresh retained Remain and cleared both completed orders;
native records and two settled Slack receipts confirm the result. Nuki remains
empty and the lab remains at revision 137. Representative current-shop records
and the operator's comparison remain required.

The [October 1 latency release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-latency-fixes-2026-10-01.md)
deployed throughput routing, session affinity, same-type batching and actionable
query validation. Successful live investigation and refresh runs took 18.75 and
22.55 seconds, with all reads succeeding and all three Slack receipts settled.
The record includes the higher provider cost, remaining startup time and failed
diagnostic attempts. Current-shop usefulness acceptance remains open.

The [follow-up preparation release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-followup-preparation-2026-10-01.md)
removed recovery-path duplication and measured the remaining startup stages.
Fresh follow-ups perform one Case-path binding/authorization pass; existing-turn
replay and final destination checks remain in place. Two live probes attributed
96–98% of the Case-prepared → inference interval (4.21 and 3.43 seconds).
The 3-second first-model-token target remains unmet; catalog/authority preparation
and variable checkpoint restoration are the measured next candidates.

The [overlapped initialization release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-overlap-initialization-2026-10-01.md)
concurrently reads current identity, grants and policy; overlaps harness input and
catalog resolution; and loads checkpoints alongside independent Tool Host/history
setup. A successful checkpoint-restored refresh measured 1.907 seconds from Case
prepared to inference, versus the earlier 3.427-second sample. Live first model
tokens arrived after 9.286 and 7.433 seconds, so the 3-second target remains unmet.
Native receipts and unchanged commerce verify both successful probes; an older
Case's cumulative token exhaustion is retained separately in the evidence.

### 2. Deliver the brief and investigation follow-up

- [x] Reuse existing reports to locate candidate records; add only the missing
      qualification needed for unresolved payments and evidenced delays.
- [x] Use existing typed reads and relationships for details, deduplication and
      resolution. Preserve organisation and conversation authority.
- [x] Recover the report consistency/freshness fix and the existing bounded
      lookup/pagination fixes. The brief must still disclose its coverage.
- [x] Deliver the Slack answer with reasons, references, next manual
      steps and source timestamps. Reuse existing Case history and delivery.
- [x] Prove a follow-up and a fresh rerun after a controlled delay has been resolved.

Use the existing Operations page, commerce projections and Case runtime. Add
no dashboard, exception store, workflow engine, generic ranking system or second
evaluation framework.

### 3. Prove usefulness

- [x] Complete the operator-approved mock-shop acceptance with real Urk inference,
      signed Slack ingress, authorized native commerce reads, investigation and
      refresh after controlled payment recovery.
- [x] Compare every issue with fixture truth: repeated failures produce one item;
      recovered/cancelled/completed and future-deadline controls are excluded;
      the resolved payment disappears while the delay and exception remain.
- [x] Preserve missing-capability evidence and explicit coverage limitations.

The [mock-shop acceptance evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-mock-shop-2026-10-01.md)
records seven synthetic orders, three settled Case deliveries and unchanged
commerce during agent work. The operator waived the real-shop/manual-review
gate; no manual-time or business-usefulness measurement is claimed.

## Removed from this release

| Earlier work                                                                    | Decision                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Sales analytics, product rankings and promotion recommendations                 | No Plan 39 completion requirement.                                                                                                       |
| Inventory/reordering and supplier planning                                      | Separate operational priority; retain existing capabilities without extending them here.                                                 |
| Catalogue publication, product editing and product-specific Ask Urk entry       | Outside the order-attention deliverable. Product authoring remains with its existing plans.                                              |
| Offer pricing and allowance controls                                            | Outside this release, including new provider price commands.                                                                             |
| Campaign briefs, campaign review UI and marketing integrations                  | Outside this release.                                                                                                                    |
| Every Portal setting configurable in Slack; dedicated Urk setup UI              | Use existing setup controls; repair a concrete access blocker only.                                                                      |
| New structured presentation framework and full Portal/Slack feature parity      | Use clear text and existing record destinations.                                                                                         |
| Merchant memory and personalization                                             | Deferred; explicit configuration and existing Case history suffice.                                                                      |
| Broad scenario matrix, 48 attempts per route and new fixture infrastructure     | Replace release gates with the focused exercise and real-shop comparison. Existing tools may be reused without changing their contracts. |
| Autonomous payment recovery, refunds, customer messages or scheduled monitoring | Outside the first release.                                                                                                               |

## Merchant branch disposition

The local `codex/plan-39-merchant-release` branch was retired on 2026-09-27
after selective integration. Its temporary archive tag was also removed.

Selective recovery on 2026-09-27 brings four fixes onto dev:

- `b54295df6`: reject report counts and records from different revisions and
  identify missing source freshness. Keep the existing report shape; the old
  branch's additional request-time field is unnecessary.
- `f83f373c`: select conversation-scoped source grants for shared Slack reads.
- `ad8f1b4a`: align the tool input with exact-record selection and implement
  those reads in Underclerk.
- `2a8eb00d`: preserve continuation cursors through context reads.

The [integration evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-selective-integration-2026-09-27.md)
records the exercised boundaries and exclusions. Other setup, tool-error or
delivery fixes qualify only if this workflow demonstrates the same defect on
current dev. The order-attention brief passed the operator-approved mock-shop acceptance;
real-shop comparison remains deferred.

Campaign, catalogue, pricing, presentation and evaluation additions remain
outside this plan's scope.

## Completion

Plan 39's operator-approved mock-order acceptance is complete. The real Urk
model identifies unresolved payment problems and evidenced delays through the
existing conversation and authorized read path, investigates linked evidence,
and removes a recovered payment on refresh. Source gaps are disclosed.

The fixture run uses simulated Slack transport and isolated commerce storage.
Production Slack delivery was exercised separately in the linked release
evidence. Real-shop comparison and the 3-second latency target remain separate
follow-ups and are not claimed as achieved.
