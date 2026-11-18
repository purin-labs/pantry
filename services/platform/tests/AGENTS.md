# Edge test maintenance guide

This file applies to `services/platform/tests/**`.

Tests are executable evidence for current product behavior. They are not the
source of product intent. When a test conflicts with current specifications,
domain types, or an explicitly requested behavior change, update or delete the
test and any fixture that exists only for the obsolete behavior.

## Test map

- `onboarding-activation.test.ts` covers activation fencing, durable resume,
  fail-closed interruption recovery, stale readiness rejection, and exactly-one
  activation receipts.
- `onboarding/safety.test.ts` contains a small set of user-visible onboarding
  safety boundaries and first-task guarantees.
- `onboarding-projection.test.ts` covers the canonical server projection at its
  transport boundary. Avoid duplicating its full object shape elsewhere.
- `control-mutation.test.ts` covers mutation fencing, idempotency, and replay.
- `provider-onboarding.test.ts`, `provider-attempt.test.ts`, and
  `provider-resource.test.ts` cover provider authorization and discovery
  boundaries.
- `integration-account.test.ts` and `account-removal.test.ts` cover stable
  account identity, credential generations, disable, reconnect, and removal.
- `d1-schema.test.ts` and `do-schema-migrations.test.ts` protect persistence
  boundaries and migration compatibility.
- `split-topology.ts` builds the deployed D1 topology for a unit test: the
  global database behind `DB` and one regional database, each from its own
  schema. `slack-directory-split.test.ts`, `member-names-split.test.ts`,
  `organisation-directory-split.test.ts` and the split cases in
  `onboarding-reconciliation.test.ts`, `account-removal.test.ts` and
  `credential-vault-backup.test.ts` run on it. Use it for a path that reads or
  writes both databases. The one-database schema of the other unit suites
  hides a statement sent to the wrong one; the E2E suite runs on two
  databases.
- `d1-split-statements.test.ts` reads every SQL statement in `src` without
  running it. It fails when one statement names tables of both databases, and
  when a function names a global-only table on a database nobody has traced to
  `env.DB`.
- `e2e/idle-tenant-cost.test.ts` is the cost guard for a shop where nothing
  changes. It runs every cron trigger of the production Worker for one hour,
  stops each Durable Object before each five minutes, and fails when the shop
  writes more than the budget in the file: Durable Object rows, D1 rows, queue
  messages, KV writes and R2 writes. An object that starts again must write
  nothing. `e2e/write-meter.ts` counts the writes and names the D1 statement
  that wrote. Run the journey after a change to a cron, an alarm, a poll or a
  Durable Object constructor. It needs the account Worker.
- `e2e/purged-organisation.test.ts` follows a purge that a Connector blocks:
  the operator's erase, the purge that then completes, and the scheduled run
  that no longer lists the Organisation.
- `e2e/unregistered-actors.test.ts` covers the operator's erase of an Actor by
  its object identifier: what is erased, and the two refusals that protect a
  registered Actor and one whose Organisation exists.
- `e2e/message-link-fetch-placement.test.ts` follows a documentation read of
  a Portal chat and a link read of a Session to the link-fetch Actor of the
  Organisation's region, and checks that the operator's erase refuses that
  Actor. It needs the account Worker (`SATYR_ACCOUNT_WORKER_ARTIFACT`).
- `e2e/custom-connector-fetch-placement.test.ts` follows the Portal setup of a
  custom connector, from the draft to the test of its key, to the fetch
  container of the Organisation, asked for in the Organisation's region, and
  checks that the operator's erase refuses that container. It needs the
  account Worker as well.
- `e2e/outside-written-effect.test.ts` is the allowed/denied journey of the
  writer rule (Plan 89): a Portal request that read text of an outside person
  asks before an Airtable write, shows the exact record to the person who
  asked, refuses another member, writes one time after Allow, and asks again
  for another record. Step 10 of `e2e/chat-agent-recipes-suppliers.test.ts`
  follows the rule in a Portal chat, in a later message of the chat that read
  the text. The supplier Memory journey of `e2e/mail-inbox.test.ts` covers
  the direct reply rule: a stranger's direct reply becomes a draft, and a
  verified supplier's goes. `e2e/airtable-exit-support.ts` holds the Airtable
  account that it shares with `e2e/airtable-exit-approval.test.ts`. Both need
  the account Worker.
- `e2e/chat-side-case.test.ts` follows a side Case (Plan 74) from the agent's
  proposal to the person's start, the limit of open proposals, a dismissal
  and the deletion of the source chat. `e2e/chat-side-case-ifc.test.ts` is
  its allowed/denied journey: a side Case closes for a person who loses the
  source chat. Both need the account Worker.
- `e2e/chat-paused-read.test.ts` is the allowed/denied journey of a chat that
  waits for a permission: the chat and its goal open for a person who may read
  the paused turn, and close when that person loses a read that the turn used.
  It needs the account Worker.
- `e2e/chat-queued-steer.test.ts` and `e2e/chat-queued-steer-join.test.ts` follow
  Steer on a queued Portal message: the cancel path with a second queued message
  behind it and a double click, and the join path with no second turn. Each
  needs its own process.
- `e2e/slack-side-case.test.ts` follows a side Case in a Slack channel: the
  proposal with its Start button, a double click that starts one new thread,
  the first turn for the member who clicked, a reply in the new thread and a
  late click. `e2e/slack-side-case-dm.test.ts` does the same in a DM, where a
  click by another member is refused. Both need the account Worker, and each
  runs in its own process. A second journey in `slack-side-case.test.ts`
  follows a start that stops after its claim: when the start's lease ends,
  another member starts the side Case (Refactor 15).
- `e2e/bakery-surface-quarantine.test.ts` gives a Session 33 damaged Satyr
  Kitchen effects: recovery ends them as `quarantined`, one page for each
  pass, and then reads none of them again (Refactor 15).
- `e2e/cue-claim-sweep.test.ts` follows a Cue claim whose queue message went
  to the dead-letter queue: the Organisation's alarm ends it as a failed
  delivery, the cutover no longer waits for it, and a replay delivers
  nothing twice (Refactor 15).
- `e2e/case-assignment-wake.test.ts` gives a stopped command's Case the
  state that a release before the abandon wakeup left: a `running`
  assignment with no wakeup. When the Case wakes, it sets the wakeup, which
  ends the assignment as abandoned with no new command (Refactor 15). It
  needs the account Worker.
- `e2e/session-quarantine-end.test.ts` gives two stopped commands the
  quarantine that a release before Refactor 15 wrote for an interrupted
  turn. When the Sessions and then the Cases wake, the clean Session ends as
  failed and its Case ends the assignment as abandoned; the Session with an
  effect whose result is unknown stays quarantined, and its assignment stays
  `running`. Before they wake, the Session census counts that effect by its
  kind, reason and age, and the clean Session has no such entry. A second
  journey quarantines two Sessions with a Code Mode settlement that the
  Organisation refuses while a call is in flight. A day later, the Session
  whose reservation expired settles it from that record and ends, and its Case
  abandons the assignment; the Session whose reservation moved to another
  lease stays quarantined.
- `e2e/device-commands.test.ts` follows the pauses that Satyr sends to a shop
  gateway: a refused snapshot of a paused camera leaves the pause unconfirmed
  until the gateway answers the pause, and a pause sent while the gateway is
  offline reaches it at its next hello, one time (Refactor 15). It needs the
  account Worker.
- `e2e/whatsapp-send-attempt.test.ts` follows an approved WhatsApp reply
  while a fake Meta holds the message: a Connector that stops during the
  call ends the reply as `send_indeterminate` and fences the number, so the
  agent's next draft is not sent; a revoke or the end of the approval time
  during the call stays, and Meta's answer records no reply over it
  (Refactor 15). `e2e/whatsapp-connector-support.ts` installs the WhatsApp
  number, Case and proposal that it shares with `whatsapp-placement.test.ts`.
  It needs the account Worker.
- `e2e/slack-held-output.test.ts` follows an answer that the exit check
  holds (Plan 27C): it waits as `held` until a person decides, and an allowed
  answer that Slack refuses for good ends as `rejected`, so the
  reconciliation does not post it again (Refactor 15).
- `e2e/slack-steering-recovery.test.ts` follows a steering reply through the
  loss of the Session Actor: a turn that resumes places it once, and a turn
  that cannot resume reports it as withdrawn, so the reply returns to the
  Connector queue and does not stay parked (Refactor 15). It needs the
  account Worker.
- `e2e/provider-removed-access.test.ts` follows Shopify's `app/uninstalled`
  and Stripe's `account.application.deauthorized` to the credential
  revocation: the account, its connection, its webhooks and its Vault secret
  are revoked once. A signed order body with a changed topic, another
  application's event, an unknown account and a repeated event change
  nothing (Refactor 15). Run each journey in its own process.
- `e2e/slack-commerce-approval.test.ts` follows the one approval card of a
  commerce change: Approve, Decline, a refused operator, a lost provider answer,
  a decision in the Portal and an approved change that fails, with no second
  message in the thread. Its lost-update journey writes a decline to the
  ledger only: the Case reads the ledger, so the next message gets an answer
  (Refactor 15).
  `e2e/slack-working-notes.test.ts` follows what the thread shows of a turn with
  tools: the agent's short notes before tool calls stay out of the answer.
- `e2e/slack-channel-after-deletion.test.ts` follows a workspace whose
  installing Organisation is archived, cleaned up and deleted: a new
  Organisation connects the workspace in the Portal and adds the channel that
  the deleted one left behind, but not a channel that an Organisation in use
  holds. It needs the account Worker.
- `e2e/schedule-runs.test.ts` follows one hourly schedule from the agent
  operations and the owner's grants to its dispatched Case, whose agent
  lists the integrations under the schedule's grant. It reads the runs of
  the window: a member of the schedule's Project gets the finished run, with
  the first line of its instruction as its title and no record withheld, as
  their Activity timeline shows it. An administrator without a seat in that
  Project gets the same run (Plan 27C). It needs the account Worker.
- `e2e/order-queue.test.ts` follows QR orders through the staff queue and the
  pickup board (Plan 40B phase 3): a made-to-order drink and a cookie from
  stock, a sale in the middle of a staff action, an early hand-over, a second
  tablet and a viewer. It also follows a declined QR payment and its paid
  retry to the failed payments list. It needs the account Worker.
- `e2e/paid-receipt-outbox.test.ts` takes two paid QR orders while the
  café's Slack connection is disabled: the feed reads every event of the
  shop, the receipts wait as `failed` with their reason, and the retry pass
  posts each one once when Slack works again (Refactor 15). It needs the
  account Worker.
- `e2e/placement-move.test.ts` follows the operator's placement moves
  through the admin routes (Refactor 15): a restore that stops after the
  freeze is abandoned, a recovery relocation makes the Organisation active
  again, and a second restore and the first relocation's cleanup complete; a
  relocation leaves a quarantined Actor out with a receipt; and the 15-minute
  run reconciles a stale Actor reservation, so the freeze goes on.
- `e2e/product-photos.test.ts` follows an owner who adds, orders and removes
  a product's photos on the product page: a retry and a second click add
  nothing, Undo puts a removed photo back, an older view, an operator, a
  drawing and a file whose bytes are not its named type change nothing, and
  the shop's catalog shows each order. It needs the account Worker.
- `e2e/portal-order-cancel.test.ts` follows a paid order that an owner cancels
  from the Orders page, with the id that the page reads from Underclerk: no
  money moves before the approval, and the approval cancels and refunds it.
- `e2e/chat-agent-order-queue.test.ts` follows the Portal chat agent through
  the same queue and "sold out today" (Plan 81): a prompt for each missing read
  and capability, an order from start to hand-over, an early hand-over refused,
  and a mark that checkout refuses and a clear that it accepts.
  `e2e/chat-agent-order-queue-recovery.test.ts` loses the Session Actor after a
  hand-over: the receipt answers the repeated call. A person who loses the staff
  role during a turn moves nothing. Both need the account Worker.
- `e2e/chat-agent-order-lifecycle.test.ts` follows an owner who asks the
  Portal chat agent if the orders are fulfilled, with one order handed over
  and one in the queue: the agent's order read names no `lifecycle` field and
  still gets each order's state as the Orders page shows it. An administrator
  without the order read gets no order. It needs the account Worker.
- `e2e/chat-agent-recipes-suppliers.test.ts` follows the Portal chat agent through
  recipes and suppliers (Plan 81): a prompt for each missing read and capability,
  the exit check of a private chat, a save that the person's page shows, a stale
  edit and a wrong unit refused, and a supplier added, repeated and refused. It
  needs the account Worker.
- `e2e/mail-inbox-reconnect.test.ts` follows a Gmail mailbox whose sign-in
  Google refuses: the Inbox asks each reader to reconnect it, asks Google one
  time, refuses a viewer's reconnect, and reads mail after the owner's
  reconnect. It needs the account Worker. `e2e/gmail-mailbox-support.ts`
  holds the connected mailbox, its setup and Google's ID token that the mail
  journeys share.
- `commerce-fixture-worker.ts` runs Underclerk's built fixture Worker in
  Miniflare: the production Worker with a deterministic payment gateway, an
  optional fixed clock and named seed scenarios at `/test-fixture`. The E2E
  config binds `UNDERCLERK` to the same artifact. Tests never import
  Underclerk source; seed state through a scenario in
  `services/commerce/tests/fixture-worker/scenarios.ts` and read it over
  HTTP. `pnpm lint:runtime-boundary` refuses a new import of Underclerk
  source.
- `*.type-fixtures.ts` use `@ts-expect-error` for invalid domain states that the
  type system must reject.

## Stale-readiness contract

Keep one representative acceptance test for this boundary in
`onboarding-activation.test.ts`. It should prove only these durable guarantees:

1. A canonical activation-relevant configuration change advances the
   configuration fence and invalidates the current readiness assessment.
2. Activation carrying the prior readiness version and hash returns
   `activation_readiness_stale`.
3. Rejection creates no activation attempt or receipt and cannot make the
   organisation active.
4. The latest server projection exposes the new configuration as requiring a
   fresh readiness assessment.

Do not add a fixture for every field that can invalidate readiness. Do not
freeze digest values, SQL row order, support copy, labels, timestamps, or the
complete projection object in this test. Add another stale-readiness case only
when it represents a distinct security boundary that the existing
configuration-fence test cannot exercise.

## Capability and diagnostics boundaries

Keep the capability safety evidence focused on the product boundary: an
unlinked `read_and_propose` organisation may activate, while generated provider-write
tools cannot be enabled or executed. Support-diagnostics reads must preserve
the lifecycle, readiness, activation, attempt, and receipt state they inspect.
Test the policy and enforcement boundary once; do not create one fixture per
provider action or diagnostic field.

## Refactor workflow

Before changing lifecycle, onboarding, provider, or persistence behavior:

1. Read the current applicable spec and the domain type or boundary parser.
2. Run the narrow tests listed below and identify which guarantee each failure
   represents.
3. Classify failures as current contract, incidental implementation detail, or
   obsolete behavior.
4. Preserve current contracts. Replace brittle assertions about incidental
   details. Delete obsolete tests, fixtures, helpers, and snapshots.
5. Prefer one end-to-end boundary assertion over several near-duplicate unit
   fixtures.
6. Assert outcomes visible at a domain or API boundary. Inspect internal rows
   only for safety properties such as absence of an attempt, receipt, grant, or
   credential generation.
7. Keep fixtures local and minimal. Avoid shared “world” fixtures with hidden
   lifecycle transitions.
8. Use type fixtures for compile-time invalid states and runtime tests for
   untrusted-input parsing or persistence behavior.

After context compaction or when inheriting a partially completed agent task,
re-read this file, the relevant spec, and the implementation before treating a
test expectation as authoritative. A passing historical test is evidence that
an old behavior existed; it does not establish that the behavior is still
intended.

## Commands

For activation or readiness changes:

```bash
pnpm --filter @seams/platform exec vitest run \
  tests/onboarding-activation.test.ts \
  tests/onboarding/safety.test.ts \
  tests/onboarding-projection.test.ts
```

For the onboarding lifecycle closure gate:

```bash
pnpm --filter @seams/platform test:onboarding-closure
pnpm --filter @seams/platform check:test-types
```

Run the full edge suite when changing shared domain types, boundary parsers,
schemas, migrations, control routing, generated artifacts, or configuration:

```bash
pnpm --filter @seams/platform test
pnpm --filter @seams/platform check:types
```
