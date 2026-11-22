# Experiment 1 — Reuse Pi's native discovery and Code Mode

Status: complete — feasibility experiment and authorized Pi/MCP implementation.
Completed: 2026-10-02. Implementation commit: `d015347e0`.

Decision: adopt Pi's native SDK discovery, Code Mode, session persistence and
compaction in Workerd. Satyr retains the trusted executor seam and Actor-owned
authorization, credentials, budgets, cancellation, accepted history and delivery.
Worker SDK/executor patches remain local. Upstream approval and contributions
are outside the work plan.

## Completed work

- [x] Establish the upstream integration surface and record the initial
      compatibility and live-model results: [experiment evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/report.md).
- [x] Implement the Worker-compatible SDK/executor seam:
      [seam evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/worker-seam/report.md).
- [x] Complete SDK adoption steps 1–3: packaged dependency installation,
      replacement of adapter internals, and Actor-owned history/store/discovery
      restoration through compaction: [adoption evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/report.md).
- [x] Verify Actor recovery, governed effects, admission fencing, actionable
      authority errors and approved current-shop reads:
      [release evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/release-report.md) and
      [current-shop evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/current-shop-report.md).
- [x] Implement governed remote MCP support and verify its transport and Satyr
      authorization in Workerd: [MCP evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/remote-mcp-support-report.md).
- [x] Upgrade packaged Pi dependencies to `1.0.0` and verify checkpoint recovery
      across the previous build: [upgrade evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/pi-v1-upgrade-report.md).
- [x] Fix both P1 findings: final REST/MCP authority checks and bounded attempts:
      [P1 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/connector-p1-report.md).
- [x] Fix all three P2 findings: invocation-based read deadlines, conservative
      write dispatch classification and propagated abort signals:
      [P2 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/connector-p2-report.md).

## Separate follow-ups

1. Deploy Pi `1.0.0`, governed remote MCP and the P1/P2 fixes, including the updated
   egress container. The earlier SDK/current-shop release was deployed; the
   implementation in `d015347e0` has local acceptance.
2. Enroll an operator-selected MCP account through the existing review/setup
   workflow and verify a real Case read and a provider-specific approved write.
3. Investigate the earlier controlled Case's two indeterminate outbox entries.
   Their cause and resolution remain unverified.

The experiment and implementation are closed. These follow-ups retain their
own acceptance requirements.

Results and repeatable commands: [experiment report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/report.md).
The initial SDK/executor fix is recorded in the
[Worker SDK/executor seam report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/worker-seam/report.md),
with the portable upstream patch and its acceptance artifacts.
The dependency workflow now installs the Worker SDK candidate as pnpm patches
against `1.0.0`. The production adapter uses upstream session creation,
discovery, Code Mode, store persistence and compaction. The
[SDK adoption report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/report.md) records the
packaged Workerd checks, Actor recovery, compaction recovery and current
verification limits. The [remote MCP support report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/remote-mcp-support-report.md)
records the governed implementation, setup contract, checks and remaining live
verification limits.
The [release verification report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/release-report.md)
records deployment, partial production acceptance, the remaining work and the
approved-effect recovery artifact.
The [follow-up report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/followup-report.md)
records admission fencing, actionable errors, the controlled production repeat,
the exact current-shop grant mismatch and the separate remote MCP experiment.
The [current-shop acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/experiment-1/sdk-adoption/current-shop-report.md)
records the approved grants, deadline correction, complete summary recovery and
the remaining earlier controlled-Case outbox investigation.

## Experiment objective

The experiment determined whether Satyr could reuse Pi's native tool discovery, deferred loading,
Code Mode and MCP client support while retaining Actor-owned authority and
durable recovery. Prefer upstream harness functionality wherever it can satisfy
Satyr's execution contract. Implement custom machinery only for a demonstrated
integration gap.

The experiment must produce a concrete adoption recommendation, a repeatable
end-to-end evidence artifact and an inventory of Satyr code that adoption would
replace. A successful experiment does not itself switch production harnesses.

## Starting evidence

The [Earendil post](https://earendil.com/posts/you-said-no-mcp/) describes Pi's
native MCP integration, JavaScript composition and discoverable tools.
[Pi's current SDK documentation](https://pi.dev/docs/latest/sdk) explains that
the CLI loads these as built-in extensions, while SDK sessions explicitly add
`createCodemodeExtension()`, `createToolSearchExtension()` and
`createMcpExtension()`. The SDK is documented for Node.js and Bun.

Satyr started this experiment with Pi packages pinned to `0.82.0` in
[`services/platform/package.json`](../services/platform/package.json).
[`pi-embedded-adapter.ts`](../foundation/agent/actors/pi-embedded-adapter.ts)
constructed the lower-level `pi-agent-core.Agent` and supplied Tool Host tools
directly at the start of the experiment. That integration did not automatically
load the advertised extensions.
The latest documentation did not establish availability in that pinned release.

Satyr already has a governed Dynamic Worker executor in
[`harness-tool-catalog.ts`](../services/platform/src/actors/harness-tool-catalog.ts),
including capability callbacks, budget admission and settlement. Initial source
inspection found an `executeCode` interface without a production call site in
the reviewed harness paths. Confirm its actual reachability before using it as a
baseline. The existing Code Mode result also includes nested-call outputs, so
its model-context savings require measurement.

Relevant boundaries are described in [Plan 14](plan-14-actor-runtime-architecture.md),
[actor-owned history](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md),
and [Plan 35](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-35-access-and-data-flow-controls.md).

## Ownership and scope

| Responsibility                                                                   | Intended owner                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Discovery, deferred declarations, composition and model-facing presentation      | Pi's upstream harness facilities                                      |
| Organisation identity, grants, credentials, policies and information-flow checks | Satyr's trusted Tool Host and Platform operations                     |
| Cases, assignments, approvals, effect identity and receipts                      | Existing Satyr Actors and domain services                             |
| Pinned inference authority, budget enforcement and cancellation                  | Satyr, enforced across the harness boundary                           |
| Accepted history and durable recovery                                            | Actor-owned persistence containing the required Pi session projection |
| Translation between those surfaces                                               | The smallest viable Satyr harness adapter                             |

Run an isolated development experiment. Do not add a production selector,
fallback route, connector marketplace, general workflow engine or second
configuration system. External classifiers such as Jev are outside this probe.
Keep Codex behavior unchanged during the experiment; a future adoption proposal
must explain how both harnesses retain access to the same governed operations.

Native Pi composition can call registered Satyr tools directly. Introducing MCP
between two components in the same process is unnecessary unless the probe
demonstrates a concrete need. Test Pi's MCP client separately against one
controlled server, while retaining the same authority checks for executed calls.

## Phase 1 — Establish the upstream integration surface

1. Inspect the installed package exports and upstream implementation. Pin the
   exact candidate release or commit containing the required extensions and
   record its dependency changes. Keep probe dependencies isolated. The user
   subsequently authorized updating the production dependency pin to `0.99.1`;
   that upgrade initially retained the lower-level harness. The subsequent
   authorized SDK adoption replaces it through the normal dependency workflow.
2. Run the upstream SDK example in its supported Node.js environment with an
   explicitly supplied tool and in-memory session manager. Establish the
   extension-loading and activation sequence before adapting it to Satyr.
3. Identify the supported seams for tool registration, indirect execution,
   discovery, model routing, session export/import, cancellation and usage
   accounting. Record which paths execute callbacks and which events are
   emitted for nested calls.
4. Inspect runtime dependencies: filesystem, subprocesses, WASM loading,
   dynamic evaluation, network access and SDK initialization. Disable ambient
   resource discovery and supply explicit experiment resources and credentials
   through the existing trusted boundaries.
5. Verify whether composition's persistent values and discovered-tool state are
   represented in exportable session entries. Identify exactly what must be
   persisted to restore them, including compaction behavior.

Deliver a short compatibility table with confirmed support, required adapter
work and concrete blockers. Package installation and a successful import alone
are insufficient evidence of working composition or restoration.

## Phase 2 — Prove the deployment and authority boundary

First attempt the actual extension-enabled session inside a local workerd
environment using the repository's existing Worker tooling. Exercise discovery,
a generated script and a governed tool callback; record bundle size, startup
cost, execution limits and any unsupported dependency.

If workerd fails, capture the exact failing API and smallest reproduction. Use
the Node.js control to distinguish upstream behavior from Worker incompatibility.
Assess whether a supported upstream seam resolves the problem without a fork.
An isolated Node.js proof may establish feasibility for a future container-based
Pi harness, but moving production Pi into a container is a separate architecture
decision with latency, cost and lifecycle consequences.

Route every domain tool call, including calls made through native Code Mode and
MCP, through Satyr admission and execution. The adapter must preserve:

- The accepted organisation, session, turn, catalog and lease binding. Discovery only
  reveals the accepted capability set; exposure changes do not grant authority.
- Current grant and account checks at execution, including revocation after
  discovery. A catalog change follows the existing lineage rules.
- Credential custody in trusted operations. Generated JavaScript receives
  capability access without provider secrets or arbitrary network access.
- Cumulative information-flow labels, including data omitted from the final
  summary, and destination checks on delivered results.
- Budget reservations, nested-call accounting, cancellation fencing and terminal
  settlement. Parallel calls cannot escape limits or mutate state after fencing.
- Existing approval and receipt paths for effects. Retries retain the domain
  operation identity across ambiguous responses and runtime replacement.

Do not treat tool hiding, an MCP read-only annotation or a Pi permission prompt
as Satyr authorization. Verify the native executor's isolation and call-routing
seams directly. If those seams cannot preserve the contract, record the blocker
before considering additional execution machinery.

## Phase 3 — One representative end-to-end scenario

Use the existing commerce lab and platform E2E infrastructure. Review their
local instructions and reuse current fixtures. Add no unit tests or source-text
checks. Use one parameterized acceptance flow for the current adapter and the
upstream candidate, with a deterministic provider control and real-model runs
reported separately.

The operator asks for a current-shop brief covering unresolved failed payments
and evidenced fulfillment delays, then requests investigation and a proposed
follow-up action. Seed enough records to require pagination, cross-record joins
and filtering. Include resolved failures, unrelated orders, restricted records
and records belonging to another shop. Existing supported reports and query
operations define the expected findings.

1. Start a fresh Case and accepted session. Supply a realistic catalog with
   unrelated authorized tools so deferred discovery is exercised. Ask the model
   to discover the relevant capabilities and compose the reads with Pi's native
   Code Mode.
2. Verify the brief against the seeded source records. Capture the actual
   model-visible messages to establish whether intermediate datasets stayed out
   of context. Persist complete required audit evidence separately.
3. Ask a follow-up using a computed result retained through Pi's native session
   mechanism. Export the accepted projection, destroy the runtime and all
   process-local state, then restore and repeat the follow-up. Verify retained
   values and tool exposure; no external effect may be replayed to rebuild state.
4. Revoke a previously discovered capability. Attempt it from the restored
   session and verify rejection without a provider operation. Include an output
   destination that cannot receive the restricted observations and verify the
   existing delivery boundary rejects it.
5. Exercise one bounded remote MCP read through a controlled server and the
   same governed callback boundary. Include structured success and tool-error
   responses. Record whether this requires a custom adapter or an upstream hook.
6. Propose one existing supported action through the normal approval flow in
   the test environment. Interrupt after the effect is accepted but before the
   harness receives its result. Restore and retry using the same operation
   identity; verify one effect and the original receipt.
7. In a fault variant, exhaust the budget or cancel during parallel reads.
   Verify outstanding work is fenced, reservations settle and subsequent calls
   cannot execute under the cancelled turn.

The deterministic provider control proves wiring and recovery. Real-model runs
must demonstrate discovery and composition without prescribing the exact tool
call sequence. Run three trials per candidate and baseline with the same model,
reasoning setting, catalog, data and task. Report every trial, including failures.
If credentials or a required service prevent these runs, mark that acceptance
gate unverified.

## Evidence and acceptance

Save a human-readable report and machine-readable run results under
`docs/evidence/experiment-1/`. Reuse existing E2E artifact conventions and link
larger traces from the report. Include:

- Source revision, working-tree changes used by the probe, exact upstream pin,
  runtime configuration and copyable setup, seed, run and verification commands.
- Seed identity and expected findings; accepted event sequence, operation
  identities, receipts and recovery checkpoints, with credentials excluded.
- Actual model-visible requests/results and separate nested-call evidence.
- Per-run outcome, model input/output tokens, catalog size, model round trips,
  tool calls, elapsed time, startup time and measured inference/execution usage.
- Fault outcomes and proof of absent unauthorized or duplicate provider effects.
- An explicit list of upstream facilities reused, adapter code added and existing
  Satyr code that could be deleted. Count maintenance cost as part of the result.

Correctness, authority enforcement and restoration are mandatory gates. Compare
token use and latency against the functioning current direct-tool path. Use the
existing Satyr Code Mode path as an additional baseline only if its model-facing
wiring is actually demonstrated. Report small-sample performance results as
directional evidence; do not claim savings from a scripted model control.

Run the narrow E2E scenario and relevant platform type checks. Changes to shared
domain state also require static fixtures for invalid branch combinations.
If implementation changes lifecycle or commerce behavior, run the closure and
commerce-lab checks required by the repository guide. Document exact commands
and results in the evidence report.

## Decision and completion

The evaluated outcomes were:

| Outcome                   | Required conclusion                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Adopt upstream in workerd | Native features execute and restore under Satyr authority with a small adapter; identify the replacement and deletion work.   |
| Viable in Node.js only    | Record the Worker blocker and the cost of a container-hosted Pi route; propose that deployment change separately.             |
| Partial upstream reuse    | Identify the facilities that passed and the exact missing seam; prefer a focused upstream change or minimal boundary adapter. |
| Defer adoption            | Preserve the current runtime and record a reproducible blocker and the upstream change needed to reconsider.                  |

Do not maintain two permanent discovery or composition systems as the outcome
of this experiment. If adoption is recommended, describe how the replacement
removes obsolete paths and handles persisted sessions at the persistence boundary.
If adoption is deferred, remove unused probe runtime wiring and retain the
reproduction and evidence needed to revisit it.

The experiment is complete when the evidence is repeatable, each acceptance
gate has a recorded result, and the recommendation identifies both the reusable
upstream functionality and Satyr's remaining responsibilities.

Closure recorded on 2026-10-02: **adopt upstream in Workerd**. The packaged SDK,
Actor recovery and governed MCP acceptance pass. All five connector review
findings are fixed in `d015347e0`; the separate follow-ups above retain their
pending status.
