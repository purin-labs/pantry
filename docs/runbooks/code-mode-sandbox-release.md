# Code Mode sandbox release

Status: Active operator runbook
Last reviewed: 2026-10-19

A Pi Code Mode script runs in the QuickJS VM of the `CodeModeSandbox` class.
That class lives in its own Worker, `pantry-code-sandbox`
(`services/platform/wrangler.code-mode-sandbox.jsonc`). The Platform Worker
binds the class by name as `CODE_MODE_SANDBOX`. [Integration architecture: capabilities and tools (was Spec 10)](../architecture/integrations.md#capabilities-and-tools)
describes the engine and its recovery. This runbook covers the deployment
order, what an unfinished script depends on, a release that changes it, and a
release that moves the governor.

## Deployment order

```bash
pnpm --filter @purin-labs/platform run deploy
```

The command runs its builds and checks first. It then deploys in this order:

1. `pantry-code-sandbox`, the sandbox Worker.
2. `pantry-model-exit`, the model exit Worker
   ([Plan 73](../plan-73-model-exit-worker.md)).
3. `pantry`, the Platform Worker with its containers.
4. `pantry-slack-ingress`, the Slack ingress Worker.

The sandbox and the exit Worker deploy first because the Platform Worker
names them. A failed deployment of either stops the command before the
Platform Worker changes. `pnpm --filter @purin-labs/platform model-exit:check` checks
the exit Worker's profile and script before any deployment.

Run the sandbox check alone with:

```bash
pnpm --filter @purin-labs/platform code-mode-sandbox:check
```

The check builds the Worker and reads both profiles. It fails when:

- the Worker name differs from the name in the Platform binding;
- the sandbox profile holds a variable, a database, a bucket, a service, a
  secret, or another outbound binding;
- the Worker has a public route;
- `limits.cpu_ms` is below the time that the interrupt budget needs; or
- the script holds a Wasm module other than QuickJS.

Local development (`pnpm --filter @purin-labs/platform dev`) runs the Platform, sandbox
and model exit Workers in one process. The start-up table of Wrangler marks the binding `[not connected]`.
The binding works: the table is printed before the second Worker starts.

A harness that starts `wrangler dev` by itself must pass the three profiles:
`--config wrangler.jsonc --config wrangler.code-mode-sandbox.jsonc --config
wrangler.model-exit.jsonc`. With the
Platform profile alone the Worker starts, and a Pi script ends with a sandbox
failure. `scripts/plan40/real-worker.mjs` and
`services/platform/scripts/whatsapp-dev.sh` start the Platform Worker alone.

## CPU limit

| Value                      | Where                                                 | Now       |
| -------------------------- | ----------------------------------------------------- | --------- |
| Interrupt budget           | `foundation/agent/code-mode-sandbox/limits.ts`                     | 50,000    |
| CPU limit of one execution | `limits.cpu_ms` in `wrangler.code-mode-sandbox.jsonc` | 30,000 ms |
| Deadline of one execution  | `CODE_MODE_PILOT_BUDGET.maxDurationMs`                | 30,000 ms |
| VM memory limit            | `foundation/agent/code-mode-sandbox/limits.ts`                     | 32 MB     |

One execution is one call to one sandbox object. QuickJS makes about 10,000
interrupt polls for each second of computation on Cloudflare, so the budget
stops a script after about five seconds of computation. The check requires a
CPU limit for a quarter of that rate: 20,000 ms. Cloudflare allows 30 seconds
by default and five minutes at most. A VM that the platform stops at the CPU
limit ends as a sandbox failure, and its execution settles as failed.

Raise `limits.cpu_ms` together with the interrupt budget. The interrupt budget
is part of the sandbox fingerprint below.

## What an unfinished script depends on

A script that is running or stopped depends on these values. A release that
changes one of them is an incompatible release for the scripts that are active
at that moment.

| Value                                                                         | Recorded in                                                             | After a change, an active script                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Sandbox fingerprint: QuickJS build, prelude, stack, heap, interrupt budget    | The run record of Pi, in the Session Actor                              | Does not replay: "the sandbox changed since it started". It admits no new call. |
| Version of Pi's Code Mode module                                              | The run record of Pi                                                    | Does not replay.                                                                |
| Engine, pinned Pi Code Mode package, tool catalog, policy, price book, budget | The admission digest at the Session, the Organisation, and the governor | Does not start again: "the tools of this runtime differ". No VM starts.         |
| Runtime generation and lease                                                  | The Session, the Organisation, and the governor                         | Continues. The reservation moves to the lease of the next generation.           |

Values on 2026-11-21 (Plan 96 step B1, Pi 1.6.0):

- Sandbox fingerprint: `quickjs-wasi 3.6.2, quickjs 0.17.0, prelude a5a5c307, deterministic 1, stack 262144, heap 33554432, budget 50000`.
- Pi Code Mode module version: 2. Pinned package: `1.6.0` (`SANDBOX_PACKAGE_VERSION` in `actors/code-mode-router.ts`).
- Runtime revision of a reservation: `pi-codemode-sandbox-1.6.0`.
- Pi build of a checkpoint: `pi-durable-1.6.0+actor.2` (`PI_DURABLE_BUILD`).

These changes are incompatible: an edit of `src/code-mode-sandbox`, a change
of the interrupt budget or the memory limit, a new pin of the Pi packages or
of `quickjs-wasi`, and a change of the tool catalog, the price book, or the
budget of a script.

An incompatible release damages nothing. Each active script ends with a
stated reason. Its execution settles as failed with the calls that ran. No
call runs a second time, and the turn completes with the answer of the model.
A script lives for 30 seconds at most, and its reservation for 5 seconds
more. A release without a drain therefore ends only the scripts of those 35
seconds. The procedure below ends none.

A checkpoint never holds an unfinished script. A sleeping Session is not
affected by any of these changes.

## Release that changes the sandbox contract

Set `ORIGIN` to the public origin of the Platform Worker and
`ORGANISATION_ADMIN_TOKEN` to the organisation-admin bearer token.

1. Read the state. The answer names each blocker.

   ```bash
   curl -s -H "Authorization: Bearer ${ORGANISATION_ADMIN_TOKEN}" \
     "${ORIGIN}/v1/admin/code-mode-platform-cutover"
   ```

2. Freeze admission. A new script is refused before it reserves anything. A
   running script stops at its next capability call and settles.

   ```bash
   curl -s -X POST -H "Authorization: Bearer ${ORGANISATION_ADMIN_TOKEN}" \
     -H "content-type: application/json" \
     -d '{"command":"freeze_admission","idempotencyKey":"<release>-freeze","reason":"<release>"}' \
     "${ORIGIN}/v1/admin/code-mode-platform-cutover"
   ```

3. Read the state again until it names no `live_root_reservations`. This takes
   35 seconds at most.
4. Deploy.
5. Open admission with the command `open_admission` and a new idempotency key.
6. Read the state. It must name `admission_open`. Then run one turn with a
   script.

The journey `services/platform/tests/e2e/durable-codemode-release.test.ts`
rehearses this procedure on the real route. It observed these answers:

| Step                                  | Blockers in the answer                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| Before, with one script running       | `admission_open`, `live_root_reservations` (1), `scheduled_alarm` |
| Frozen, with the script still running | `live_root_reservations` (1), `scheduled_alarm`                   |
| Frozen, after the script stopped      | `settled_unreconciled` (1)                                        |
| Open again, after the next script     | `admission_open`, `settled_unreconciled` (2)                      |

During the freeze the script of a new turn receives
`code_mode_platform_disabled`, and the model answers without it.

`settled_unreconciled` is not a condition of this procedure. It counts settled
executions whose provider cost is not reconciled (command
`reconcile_execution` of the same route). A settled execution holds no script.

## Release that moves the governor

One object keeps the Code Mode budget of the platform: the governor
(`CodeModePlatformGovernorActor`). Each script calls it two times, and one
more time for each capability call. A workspace allocation calls it two
times. A governor that is far from the Sessions adds one crossing to each of
these calls.

Cloudflare keeps a Durable Object in the region where it was created. A
location hint counts only on the first call of a name. So a move of the
governor needs a new name.
`foundation/agent/actors/code-mode-platform-governor-stub.ts` holds the
name and the region, and every caller uses that module. The name is
`code-mode-platform-governor:v3` and the region is `apac-ne`, Northeast
Asia-Pacific. Cloudflare has no hint for one city, and this is the smallest
region with Tokyo in it. Change both in one release.

A release that changes the name starts a new governor:

- Admission is open. No operator step opens it.
- The budget ledger is empty. The day counter and the month counter of the
  platform start at zero.
- The new governor does not know a reservation of the earlier one. A script
  that runs across the release cannot settle at the platform.
- The earlier object keeps its storage in its region. Nothing reads it. A
  deployment of the earlier build uses it again.

Procedure:

1. Freeze admission and wait for the drain: steps 1 to 3 of the procedure
   above. The freeze applies to the earlier governor only.
2. Deploy. Do not open admission: the new governor is open.
3. Read the state. `governorLocation` is the Cloudflare location that runs
   the governor, for example `NRT`. This read can be the first call, which
   creates the object. A local runtime answers `null`.
4. Run one turn with a script.

The hint is a request, and Cloudflare does not guarantee the location: it
selects a site with a short path to the region. If `governorLocation` is far
from the Sessions, the object cannot be moved: a new name is necessary.

## A release that fails

- **The sandbox deployment fails.** The command stops. The Platform Worker
  and the Slack ingress Worker did not change.
- **The Platform deployment fails after the sandbox deployed.** The new
  sandbox serves the Platform Worker that is live. If its contract changed,
  the scripts that were active end as the table above says. Deploy again.
- **A fault appears after Sessions wrote checkpoints of the new build.**
  Freeze admission and keep the records. Repair with a build that keeps the
  build name `pi-durable-1.6.0+actor.2`. No build reads the checkpoint
  of another build: an earlier build, or a build with a new name, starts each
  Session on a fresh lineage without the values that scripts stored.

## Mixed versions

| State                                                          | Result                                                                         | Proof                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| The Platform Worker has no sandbox binding                     | A Pi script is refused before admission. No reservation. The turn completes.   | `durable-codemode-faults.test.ts`: no sandbox binding                     |
| The call to the sandbox Worker fails                           | The script ends with "Script sandbox failed". The execution settles as failed. | `durable-codemode-faults.test.ts`: connection lost                        |
| A script that another build admitted                           | No VM starts. The execution settles as failed.                                 | `durable-codemode-faults.test.ts`: another build                          |
| A script that started on another sandbox build                 | Pi refuses to replay. No new call. The execution settles as failed.            | `durable-codemode-faults.test.ts`: sandbox changed                        |
| The sandbox Worker is deployed and no Platform Worker binds it | Nothing calls it. It has no route.                                             | The profile check                                                         |
| An earlier Platform build reads a checkpoint of this build     | It starts a fresh lineage from the accepted history.                           | [Phase D report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-50A-durable-codemode/phase-d-report.md) |

Not rehearsed: a Platform deployment whose binding names a Worker that does
not exist. That needs a deployment to Cloudflare. The deployment order
prevents the case.
