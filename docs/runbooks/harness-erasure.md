# Organisation harness erasure

This runbook covers automatic organisation-wide NF9 harness erasure and its terminal
receipts. It applies to archived organisations whose retention window has elapsed.
The current scheduled purge is disposable organisation
`organisation_c9266513-71b4-464b-8ad4-c504adba1721`, archived 2026-08-08 with
`purge_after = 1788752196469` (2026-09-07T03:36:36Z).

## Invariants

- Erasure runs only for an `archived` organisation whose archive cleanup reached
  `pending_purge` and whose `purge_after` has elapsed. There is no supported
  early-erasure path; the retention fence is enforced in
  `reconcileArchivedOrganisation` and cannot be bypassed by the operator routes.
- Each addressed SessionActor remains authoritative for its private history.
  The coordinator addresses every active registered SessionActor from one
  fingerprinted registry snapshot and fails closed on registry drift.
- The reachability filter retains any object referenced by a relocation or
  restore export and any object outside the organisation's own prefixes.
- The erasure ledger (`organisation_harness_erasure`,
  `organisation_harness_erasure_session`, `organisation_harness_erasure_object`), archive
  cleanup row, and tombstone survive the final purge. They are the durable
  receipt.

## Operator surface

Both routes require an authenticated control session whose identity holds the
`support_admin` role.

```text
GET /v1/control/operator/organisations/:organisationId/harness-history
```

Read-only pre-erasure inventory: every active SessionActor, its private
history and checkpoint object keys, and the candidate versus retained split
after reachability filtering. It mutates nothing and fails with
`organisation_harness_history_registry_changed` if the registry moves during
inspection.

```text
GET /v1/control/operator/organisations/:organisationId/harness-erasure
```

The receipt document (`organisation_harness_erasure_receipts.v1`). Its `status` is
one of:

| Status                  | Meaning                                                |
| ----------------------- | ------------------------------------------------------ |
| `retention_window_open` | Archived, fenced; `purgeAfter` reports the fence       |
| `not_started`           | No erasure ledger and no open fence                    |
| `in_progress`           | The ledger is `inventorying`, `erasing`, or `deleting` |
| `failed`                | The last pass failed; `failureCode` names the blocker  |
| `completed`             | Terminal; one receipt per addressed SessionActor       |

Each per-session receipt carries the deterministic identity
`harness_erasure_<registryId>`, the terminal per-session status, the erased
row counts (`historyRows`, `checkpointRows`, `leaseRows`, `deliveryRows`),
the erasure time, and the candidate object-key count. `objectAccounting`
totals candidate, deleted, and retained shared objects. The read is
idempotent and remains answerable after the purge completes.

## Running the erasure

The scheduled reconciler runs every 15 minutes and executes the erasure
automatically once the fence elapses. To run it deliberately under an
operator identity instead of waiting for the next cron pass:

```text
POST /v1/control/operator/organisations/:organisationId/reconcile
```

with the standard configuration-versioned mutation boundary. The
reconciliation executes the same fenced path: harness erasure per
SessionActor, shared-object deletion behind the reachability filter, then the
final purge. Partial failures are resumable under the same ledger; repeat the
reconcile until the receipt route reports `completed`.

## Follow-up

No manual evidence packet or plan update is required. The erasure ledger and
purge-surviving receipt are the durable record. Inspect the receipt route and
run an operator reconcile only when automatic reconciliation reports a failure
or remains incomplete after the retention fence.
