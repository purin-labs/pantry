# Plan 29F — Agentic Inbox live pilot

Status, 2026-10-04: the existing Financier Factory local workspace was reused.
Live supplier drafting, editing, correction and exact-version sending are verified;
the controlled supplier mailbox independently received the reviewed reply.
Purchasing fixture cleanup is complete. Live exit of the existing Gmail connection
awaits operator confirmation; the timed manual comparison and final acceptance
remain pending. The operator accepted the local-pilot processing disclosure on
2026-10-02. No complete pilot acceptance or production deployment is claimed.

Use this with the [Plan 29D enrollment and incident runbook](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29D-pilot-runbook.md).
Keep participant identities, mailbox addresses, controlled recipient and consent
records in the restricted pilot register. Repository evidence contains IDs,
counts, timings and outcomes. Never export email content, credentials or model
transcripts.

## Selected local environment and 2026-10-02 checkpoints

Reuse **Financier Factory → Cafe operations** at `https://localhost:3003`, backed
by the existing local Worker on `127.0.0.1:3101` and
`workers/platform/.wrangler/square-acceptance`. Organisation:
`organisation_e980f411-e92b-4faf-8745-bf58ae9b7413`. The signed-in operator is Pta. Use
the existing full-mailbox Gmail account
`integration_account_00e83783-2c42-4434-af1a-e5018a62bd33` and its existing agent
binding. Financier Factory B remains available for isolation checks. No fresh
organisation, workspace or provider connection is needed.

If the existing Portal shows its global retry state, check the local Workers
before changing enrollment. Restore the existing profiles from the repository
root in separate terminals:

```sh
node scripts/run-worker.mjs platform dev local
node scripts/run-worker.mjs commerce dev local
```

These profiles retain `.wrangler/square-acceptance` persistence and listen on
3101 and 3102. The Portal development server continues to use its existing
localhost origin. Do not reset or reseed the Financier Factory databases to
recover a stopped Worker.

The operator approved the portal Owner role's exact mailbox-read grant through
Access: `grant_b3305463d7b8c30a4a827e5445e261fe`, active at revision 1, for
`email.mailbox.read@1` on this account's `mailbox` resource. The existing Gmail
credential returned Google `invalid_grant`; reconnect through **More → Reconnect
Gmail in a popup** succeeded for the same identity and readonly/compose scopes.
The retained provider connection is now at credential generation 5. The Inbox
loaded 20 real message rows and a bounded search returned zero matches. Financier
Factory B's Inbox displayed its connect-mailbox state without the primary
organisation's mailbox or counts.

General mailbox-agent processing remains disabled under mailbox policy version 13.
Automatic JEV processing is also off because no Inbox rules are published. After
the operator approved JEV/model processing and scoped purchasing access, four
exact `commerce.entity.read@1` grants were applied: Supplier Directory and
Replenishment Queue for the Owner role and the bound mailbox agent, revision 1.
The commerce-read capability is enabled at revision 2; organisation policy version 15
is published. No commerce write capability was enabled.

The current Gmail source pin and TypeSafe connection revision 1 have a
`mail_classification` review expiring on 2026-10-08. A bounded live JEV preview
matched one existing synthetic marker. Replay reused its settled evaluation;
temporary review revocation blocked another preview without a provider call.
The reviewed classification route was restored afterward. No rules were
published, classification projections written, or reply proposals created.

The operator selected the existing ChatGPT Pro account and its purchased
credits. Two consecutive live GPT-5.6 Luna turns succeeded on that connection
at 0% included allowance remaining. Connection revision 3 and authentication
generation 1 remain connected. The allowance resets on 2026-10-04 at 02:39 JST;
this date does not prevent credit-funded turns. Pantry now keeps allowance
percentages as diagnostics and fences actual account verification failures.
The integration meter explains included allowance and credits separately.

The browser account matches the materialized harness identity, and its training
switch was observed off without changing it. On 2026-10-02 the operator directed
Pantry to disclose retention and recipient handling beside the processing toggle
and in these docs. Further formal retention/recipient-review work is outside this
authorized local-pilot delivery. A fixed ChatGPT Pro/Codex retention period and
the complete downstream-provider list remain unverified; training being off
does not establish either fact. Applicable provider terms and account settings
govern their handling. This disclosure does not claim public-release compliance.

Gmail agent and Inbox assistant eligibility were provisioned on 2026-10-02 for
the exact source and model route, referencing the operator's actual consent and
disclosure decision. Assistant readiness and a live rule suggestion passed. The
operator supplied controlled addresses and confirmed three synthetic historical
messages arrived. The reviewed preview correctly classified all three samples;
no rules or supplier work were persisted. See the
[live historical preview evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-29F-live-historical-preview-2026-10-02.md).
At the preview checkpoint, the shared Commerce service used a different local
dataset. The subsequent supplier run restored the Financier profile. Reconnect
changes the Gmail source pin and requires a new matching review.

Local preview cleanup removed the two synthetic suppliers, three requests and
three stock policies from the existing Financier store, preserving unrelated
purchasing data. All three temporary API control sessions are revoked. The
mailbox and approved reviews/grants remain connected, general processing is off,
and no rules, supplier Cases or reply drafts are pending. See the
[cleanup receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-29F-pilot-cleanup-2026-10-02.json).
That preview cleanup does not establish live mailbox exit or erasure.

The subsequent [live supplier run](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-29F-live-supplier-2026-10-02.md)
restored the shared Platform/Commerce services to the existing Financier
profile and recreated the namespaced purchasing fixtures at merchant revision 181. Live classification, canonical automatic drafting, Inbox editing and
correction, external Gmail edit fencing, source revocation/restoration and
rejected-draft provider cleanup passed. A separate version-3 reply and its
purchasing fixtures were preserved for final review at that checkpoint.

Automatic JEV rules are paused at revision 5. General policy 14 remains enabled
for the existing review. The live Codex turn settled 137,679 tokens against a
37,644-token reservation, bringing total mailbox settlement to 200,035 against
the 100,000-token daily budget. This failed the live budget gate. The
[budget-boundary fix](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-29F-token-budget-boundaries-2026-10-02.md)
is now verified through real-Actor E2E: native interruption, terminal allowance
checks and reported-usage failure settlement. The live ledger is retained and
automatic processing remains paused. The earlier disabled-policy-13 statements
describe the preview-only checkpoint.

## 2026-10-04 follow-up

The preserved version-3 reply was approved against its current Gmail snapshot
and sent once. A provider thread read and the controlled supplier's native Outlook
reading pane verified the complete reviewed reply. The API round trip was 1,356 ms.
Both pilot proposals are terminal: one sent and one rejected. The owning purchasing
helpers removed the two suppliers, three requests and three stock policies;
unrelated data was unchanged and merchant revision advanced from 181 to 182.

Mailbox exit now erases saved Inbox rules, pending classification work, response
links, classification projections and Inbox inference reviews. Temporary account
disable retains that state. Existing send and ingress receipts remain auditable;
provider messages remain in Gmail. A real-Actor E2E journey verifies all six Inbox
tables are empty after restart while another mailbox's classification remains.

Before the live exit, confirm disconnection of the existing Gmail account and
erasure of its saved Inbox state. Execute the existing agent-mailbox revoke action
with a fresh configuration fence and record its watch, draft, credential and
provider-grant receipts. Verify the erased state through the owning stores and
that protected mailbox reads fail. Keep any incomplete provider cleanup explicit.
The manual comparison still needs the operator's triage time, misses, false
priorities, incorrect links and edit effort, plus workflow acceptance. See the
[follow-up evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-29F-follow-up-2026-10-04.md).

## Automatic JEV processing

Open **Inbox options → Automatic mailbox processing**. This toggle applies
published JEV rules to new emails. Publish rules first if none are saved. Turning
it off pauses new classifications and rule-driven follow-up. Turning it on resumes
the saved rules, preserves classifications and starts from a fresh Gmail history
floor. Process older mail only through an explicit bounded classification request.
The saved server state determines the toggle; stale changes require a refresh.

Open **Email processing and privacy** beside the toggle for the disclosure.
TypeSafe receives bounded message evidence for JEV classification. A supplier
reply rule can delegate to the mailbox agent, whose selected provider receives
the authorized evidence needed for its work. The current organisation ChatGPT route
uses OpenAI. Replies remain drafts until the operator approves the exact version.
General mailbox-agent processing remains separately controlled in Integrations.

Connection changes require reviewing and publishing rules again. Turning the
toggle on does not grant access or enroll an inference route. Existing mailbox,
purchasing, consent and eligibility checks continue to apply.

The current App Server authentication is exercised locally. OpenAI's
[App Server documentation](https://learn.chatgpt.com/docs/app-server) requires
the supported Sign in with ChatGPT integration for commercial or hosted
services. Include that authentication boundary in hosted-release review;
successful local credit-funded turns do not establish hosted authorization.

## Required pilot facts

Record the environment/origin, organisation ID, dedicated test integration account,
operator, mailbox administrator and controlled supplier recipient. Reference
current Google authorization, organisation mail-processing consent, Gmail inference
eligibility for the exact pinned agent model, classification eligibility for
the current JEV route, and separate assistant eligibility for the current source
pin and organisation model-route digest. Check all three records' review deadlines and
revocation state. Assistant eligibility must disclose its inference recipient and
reference affirmative consent to transient Inbox assistance.
An earlier operational-email self-test does not establish consent to inbox
processing or classification.

The operator needs the exact mailbox resource grant and Supplier Directory and
Replenishment Queue read grants. The mailbox agent needs its own purchasing
source grants. Select the supported installed agent and its revision. Record
policy limits, rule revision and the new-message history floor while processing
is disabled. Resolve missing facts through the existing onboarding and Access
flows; do not create evidence references or grant defaults to make a canary run.

Deploy the reviewed Mail changes in isolation from unrelated workspace edits,
using the existing platform deployment command. Record the deployed version and
schema verification before enabling the named test mailbox. Preserve the
connected mailbox when upgrading a database whose squashed baseline is already
applied. Inspect the three Inbox tables and `mail_classification_matches` index;
use `workers/platform/scripts/plan29f-inbox-d1-patch.sql` for the additive upgrade.
It creates empty tables and grants no eligibility. The shared deployment schema
check verifies the Inbox columns and classification index. Durable Object Inbox
tables are upgraded by their owning Connector.

For the configured local database, back it up before applying the patch, then run
from `workers/platform`:

```sh
pnpm exec wrangler d1 execute pantry --env local --local --persist-to .wrangler/square-acceptance --file scripts/plan29f-inbox-d1-patch.sql
node ../../scripts/run-worker.mjs platform schema local
```

For the designated production pilot, inspect the schema and retain a current
native D1 recovery bookmark in the restricted register before applying the same
file with `--env production --remote`. From the platform package:

```sh
pnpm exec wrangler d1 time-travel info pantry --env production --json
```

Keep the bookmark in owner-only local evidence. Rehearse the patch against the
current production schema, then run `pnpm d1:schema:remote:check` after the
upgrade. The 2026-10-01 production upgrade is complete: the full schema gate
passes, existing schema definitions are unchanged and the three new tables are
empty. A successful schema check establishes persistence readiness; enrollment
and deployment have their own required evidence.

## Controlled acceptance

1. Create synthetic purchasing records for the controlled supplier: one delayed
   request, a resolved request and unrelated records under a different supplier.
   If testing sender ambiguity, add a second directory entry with the controlled
   sender's address. Do not change real supplier relationships.
2. Record the operator's manual baseline on the same synthetic message set:
   important-message misses, false priority, incorrect associations, time to
   decision and time spent editing a reply. Keep the underlying messages in the
   dedicated Gmail account.
3. Preview the supplier-delay rule against a bounded historical sample. Confirm
   no Case assignment or draft starts from the preview. Publish the reviewed
   rule, then send a new synthetic delay email from the controlled supplier to
   the dedicated mailbox. Record message/thread IDs, rule and classification
   revisions, assignment/proposal IDs and the Gmail draft ID.
4. Confirm one classification and one installed-agent draft for the supported
   supplier request. Reconcile a duplicate provider notification through normal
   ingress; confirm no second assignment or draft. Leave the rule paused when
   observation has finished.
5. Review the reply in Inbox. Enter body editing with the keyboard; save a
   substantive change. Confirm recipient, subject and conversation remain fixed,
   the saved version advances and the earlier approval fails. Reload the exact
   saved text before approval. Also change a draft in Gmail before submitting an
   older Inbox edit; confirm the stale edit is rejected without another write.
   Avoid simultaneous editing during a Gmail update: Gmail supplies no atomic
   conditional draft update, so Pantry's pre/post-read checks cannot prevent every
   external edit between those reads.
6. Introduce a synthetic ambiguous supplier match or update the purchasing
   snapshot. Confirm the earlier grounded reply cannot be approved. Use
   **Correct purchasing link**, choose the canonical sender-matching supplier,
   enter its purchase request reference, and review the current bounded facts.
   Confirm unrelated suppliers and private notes are absent. Write a replacement
   reply and save it. Confirm a new exact-version review is required. This
   correction applies to this proposal; it does not change Supplier Directory or
   install a rule for future mail.
7. Approve the corrected version once to the designated controlled recipient.
   Record Gmail acceptance and the exact version's receipt. Confirm the owned
   recipient mailbox observes one message; record that observation separately
   from provider acceptance. Resolve any uncertain result through the existing
   exact Message-ID reconciliation. Never repeat a send to test a lost receipt;
   use local fault injection for that condition.
8. On a second synthetic draft, revoke purchasing access while a preview/save is
   pending. Confirm content/effects are withheld, refresh clears old content and
   no unapproved send occurs. Exercise mailbox revocation and a rejected draft.
   An unconfirmed correction blocks the older proposal; inspect Gmail and reject
   it rather than retrying the provider write.
9. Verify keyboard focus, 320px reflow, viewer mutation restrictions, navigation
   disposal of unsaved bodies/facts, paused-rule visibility and budget failure
   states. Disable processing and remove synthetic test records through their
   owning workflows. Verify draft cleanup and the mailbox exit/erasure receipt.
10. Compare with the manual baseline. Record classification and action latency,
    settled inference usage/cost, edit effort, errors, cleanup outcome and the
    operator's acceptance or reasons for rejection. Do not describe fixtures as
    live evidence or choose a performance target after seeing results.

## Measurement sheet

Before classification is enabled, the operator labels the synthetic message set
with expected priority, category, canonical supplier/request, and whether action
should start. Freeze that set and record acceptable error, latency and cost
limits in the restricted register before the automated run. Compare the same
messages and purchasing facts; record any changed facts separately.

| Measure                  | Observation to record for manual and automated runs                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Important-message misses | Expected important messages omitted / expected important messages.                                                             |
| False priority           | Expected ordinary messages marked important / expected ordinary messages.                                                      |
| Incorrect relationships  | Incorrect supplier/request pairs / reviewed pairs; ambiguous messages require review.                                          |
| Decision time            | Seconds from first opening the message to a recorded triage decision.                                                          |
| Reply edit effort        | Active editing seconds, saved revisions and relationship corrections.                                                          |
| Arrival to visible       | Provider-received timestamp to first visible authorized Inbox row.                                                             |
| Classification latency   | Provider-received timestamp to first visible current-rule classification.                                                      |
| Draft-ready latency      | Provider-received timestamp to first reviewable Gmail-backed proposal. Include ingress coalescing.                             |
| Inference usage and cost | Settled JEV input/output tokens and estimated micro-USD, assistant and agent usage, and available provider billing references. |
| Outcome                  | Exact approved version, provider receipt, recipient observation, revocation and cleanup receipts, operator acceptance.         |

Use one timestamp source per elapsed interval and state browser polling or clock
uncertainty. For this small pilot, retain each sample and report median and
maximum; do not claim population percentiles. Classification reservations and
settlements live in the organisation's TypeSafe ledger, with purpose
`mail_classification`; they are not D1 classification rows. Assistant/agent
accepted usage comes from their session budget receipts. Keep reservation
allowances, settled usage, estimated cost and billed cost separate. Unavailable
billing or failed-call usage is recorded as unknown rather than zero. Export
only aggregate measurements and receipt references, without prompts or content.

## Acceptance record

Create a dated evidence document after the run with:

- Environment, deployed build, schema check and restricted enrollment reference.
- Mailbox/account IDs, policy/rule/binding/model revisions and eligibility refs.
- Expected/observed outcome for each numbered step and sanitized screenshots.
- Message → classification → Case → proposal/version → Gmail acceptance receipt.
- Controlled-recipient observation, duplicates, revocation and cleanup outcomes.
- Manual baseline versus pilot measurements and operator acceptance.

Private pilot acceptance stays open until those observations exist. Public
availability retains Plan 29B/29D launch gates and cohort limits.
