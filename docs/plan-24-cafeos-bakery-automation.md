# Plan 24 — Cobot bakes in the first café kitchen

Status: Rewritten on 3 November 2026 after a review with the owner. S1 to S6 are built and on
`dev` since 21 November 2026 (see "Steps done"). They are released since 21 November 2026 with Plan 95
(`satyr-edge` `55620b6e`), after the four Plan 24 D1 patches and the capability backfill of
`kitchen.bake.read`, `kitchen.bake.propose` and `kitchen.bake_run.pause`. No bake run has run in
production. The owner kept the FR10 for the
simulation on 21 November 2026. The checks of the exit
gate passed on 21 November 2026 in the simulation: `bake-cafe-day` (the café day two times, the same
outcomes), the S6 fault journeys `bake-faults`, `bake-pause` and `bake-approval-gate`, and
`bake-shadow`, `bake-run`, `bake-proposal` and `cobot-gateway`. The full E2E suite passed the same day
(244 files, 475 tests). The owner decides which cobot to buy.
The simulation phase comes first. The owner buys cobots only after its exit gate passes.
Owner: CafeOS operations. Replaces the August version, which used a Japan-to-Singapore export
order as its first path.

## Decisions from the review

The owner chose these on 3 November 2026:

| Question | Answer |
| --- | --- |
| Robots | One or two cobot arms for baking, later. Simulation first |
| Site | The kitchen inside the first café. Later cafés get deliveries from it |
| Demand | Café counter orders. Satyr bakes to a stock level, not to each order |
| First task | Move moulds and trays, and load and unload the oven |
| Cobots | Two cobots that share one oven, from the start |
| Authority | Shadow mode first, then approval mode |
| Simulation gate | The real dispatch path runs against simulated cobots before any purchase |

## Outcome

The café counter sells fresh financiers. When the counter stock of a product falls below its set
level, Satyr proposes the next bake. A person approves it in the Portal or in Slack. Two cobots take
cold moulds from the rack, load the oven, and take the hot moulds out to the cooling rack when the
bake ends. A person releases the financiers from the moulds and checks them. Then the counter
stock rises.

Each step is on the record: the proposal, the approval, each move that a cobot accepted and
finished, each fault and each pause. The workflow canvas, the timeline and the 3D kitchen show the
same run, with the planned and the observed times.

## Production, packaging and commerce

- Counter orders come from the café's order paths: the counter, the QR order page and the order
  queue ([Plan 40B](plan-40B-collaborative-menu-editor.md)). The commerce authority keeps the
  orders and the stock.
- Satyr reads the stock of each fresh product. It never changes the stock from a cobot report.
  The stock rises only when a person checks the released pieces.
- The first path bakes financiers ([Plan 61A](plan-61A-financier-workflow.md)). The recipe
  revision comes from the recipe workflow ([Plan 84](plan-84-general-workflow-canvas.md)).
- Packing of gift boxes, release from the mould, batter dispense and deliveries to other cafés are
  later steps. Each needs its own capability and its own acceptance.

## What exists and what this plan adds

| Need | Owner today | This plan adds |
| --- | --- | --- |
| Devices, gateway, readiness, one task for each device, pause, Slack alerts | [Plan 85](history/plan-85-device-fleet-page.md), live | Nothing. It calls `deviceReadiness` and `reserveDeviceWork` |
| Scheduling, queues, resource reservations, occupancy, the execution adapter boundary | [Plan 70A](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70A-production-engine.md) `packages/production-simulation` | A physical execution adapter, beside the MuJoCo one |
| Oven, rack and robot models, MuJoCo cells | [Plan 60A](plan-60A-bakery-equipment-models.md), [Plan 42B](plan-42B-mujoco-workcell-simulation.md), `crates/bakery-native` | A controller simulator mode that answers like a cobot controller |
| Recipe definitions and revisions | Plan 84 | Nothing |
| Orders and stock | Underclerk and Plan 40B | A stock-level reader and a bake proposal |
| Approvals, Cases, receipts | Platform: policy, ActionLedger, Case Actor | One bake run as a Case with its approval |
| Canvas, timeline and 3D views | Plans 42 and 70 | Observed state from receipts in the same views |

A physical run must live on the server, because a closed browser cannot stop a bake. Plan 70A runs
in a browser or a headless process. This plan adds one Durable Object for each physical run. It uses
the same engine library, which has no browser dependency.

## Rules

- Satyr owns the workflow, the approvals and the receipts. The cobot controller owns the motion.
  The emergency stop and the safety controller on the machine stay the final authority.
- Satyr sends named tasks, such as "move mould group 3 from rack shelf 2 to oven shelf 1". It never
  sends joint angles, speeds or safety settings.
- Each cobot holds at most one task. The oven door is a reserved resource, so two cobots never use
  it at the same time.
- Satyr writes the dispatch identity before the gateway sends a task. A duplicate delivery resolves
  to the first task, so no cobot makes one move twice.
- A report from a cobot is evidence, not authority. A stale, lost or uncertain state stops the next
  dispatch and shows one disposition that a person must settle.
- No Slack message moves a cobot. Slack shows the proposal and its approval, and the approval goes
  through the same policy check as in the Portal.
- The Portal chat agent may read runs, propose a bake and request a pause. It cannot approve a bake,
  dispatch a task or lift a restriction ([Plan 81](plan-81-agent-portal-control.md)).

## Steps of the simulation phase

Times are estimates in agent days.

### S1 — Stock level and bake proposal (2–3 days)

- An admin sets a stock level for each fresh product.
- When the counter stock falls below the level, Satyr opens one bake proposal on a Case. The
  proposal names the recipe revision, the quantity, the mould groups and the oven.
- A person approves or rejects it in the Portal or in Slack. A rejection keeps its reason.
- In the simulation, the counter sales come from a recorded or declared day of orders.

Exit: a sale below the level gives one proposal, not one for each sale. A second proposal waits
until the first one ends.

State (21 November 2026, branch `plan-24-s1`, not released): built.

- Records: the regional tables `bake_stock_level` and `bake_proposal`
  (`services/platform/src/kitchen/bakes/records.ts`, machine `bake_proposal`). Two partial unique
  indexes hold one active (open or approved) and one waiting proposal for each product. Patch:
  `services/platform/scripts/plan-24-bake-proposal-d1-patch.sql`.
- Trigger: the Organisation Actor compares the `available` stock of each position before and after
  a commerce delivery. A café sale lowers `available` at checkout. A delivery with no counted
  position reads nothing more and writes nothing. No cron, alarm or poll.
- Decisions: `runBakeCommand` (`kitchen/bakes/commands.ts`) through `OrganisationDO.runBakeCommand`
  serves the Portal, Slack, the agent and S4. An operator or a higher role decides; an approval
  needs an oven; a rejection keeps its reason.
- Slack: one card in the operations channel. The card's message is the root of a thread pinned
  to the proposal's Case. The card holds the reason field, so a Slack rejection needs no modal.
- For S4: `OrganisationDO.readApprovedBakeProposal` reads the approved proposal that a run starts
  from, and `OrganisationDO.runBakeCommand({ kind: "end" })` ends it and opens the waiting one.
- Proof: `services/platform/tests/e2e/bake-proposal.test.ts`, with the declared morning
  `scripts/plan-24/counter-day.json`.

### S2 — Controller simulator (3–5 days)

- `bakery-native` gets a controller mode. It runs on the gateway computer as its own process, and
  it answers on localhost like a cobot controller.
- It runs two FR10 arms, the oven and the racks in MuJoCo, with the existing table-to-rack and
  table-to-oven cells. Each task gets its time from the physics, not from a fixed number.
- It can inject a fault: a lost grip, a blocked door, a stop of the arm and a local emergency stop.

Exit: the simulator accepts a task, reports its progress and its end, and reports each injected
fault in the same form as a real controller report.

### S3 — Typed cobot adapter on the gateway (2–3 days)

- `crates/shop-gateway` gets one typed adapter for the cobot task protocol.
- Task states: accepted, running, completed, rejected and indeterminate. Pause and stop requests
  get their own receipts.
- After a reconnect, the adapter asks the controller for the state of each open task by its
  identity. It does not send the task again.

Exit: the gateway journey from Plan 85 runs with two simulated cobots behind the adapter.

### S4 — Physical run on the server (4–6 days)

- A Durable Object owns one approved bake run. It uses the production-simulation engine with the
  physical execution adapter.
- For each task, it reserves the device through Plan 85, writes the ActionLedger entry and the
  dispatch identity, and then sends the task.
- It reconciles each receipt with the run. The canvas, the timeline and the 3D kitchen show the
  observed state, and an unknown position stays unknown.

Exit: one approved bake runs to its end with two cobots, and the views agree on each task.

State (21 November 2026, branch `plan-24-s4`, not released): built.

- Start: the approval of a proposal (Portal or Slack) starts the run (D1). The run compiles from
  the proposal, the recipe revision's bake time and the active devices at the kitchen: the first
  two cobots by name with `move_mould_group` and the oven with `bake`. A device that is missing
  or not ready leaves the run `not_started` with its reason on the Bakes page; an operator starts
  it again with the same approval. The recipe holds no oven temperature yet, so the run uses
  180 °C.
- Run: `BakeRunActor` (Worker layer) gives Kitchen's `kitchen/bakes/run.ts` its storage, alarm
  and ports. For each task the run writes its action record (approval, task, device, dispatch
  identity) in its own SQLite, reserves the device through Plan 85, records the identity in its
  evidence and then asks `DeviceFleetActor` to send. The commerce `action_ledger` needs an
  integration account and an agent session, so the action record stays in the run's table.
- Ledger: `DeviceFleetActor` writes each dispatch before `cobot_task`, answers a second dispatch
  with the stored state, moves the Work fact on from each report, turns open dispatches into
  `result_unknown` on a lost socket and sends `cobot_inquire` at the next hello. It gives each
  report, clock, observed move and fault of a watched device to the run, by the id string of the
  run's Durable Object. The run's logical zero is the answer to `cobot_clock_read`.
- Holds: a refused or stale report, a failed attempt, an unknown result, a fault, 30 s with no
  signal, a device that is not ready or a task that no socket carried stops the next dispatch,
  and the run shows one hold that an operator settles (`continue` or `stop`).
- Stock (D4): the run changes no stock. An operator's check of the good pieces raises the counter
  stock through the commerce authority with its receipt, and the proposal ends.
- Views: the Bakes page drawer reads one object (`GET .../bakes/proposals/:id/run`): the task
  graph, the timeline of each cobot and the oven, and the place of each mould group. The
  Three.js kitchen does not show the run yet.
- Agent: `bake_run_read` and `bake_run_pause` (capability `kitchen.bake_run.pause`). The agent
  cannot resume, settle, stop or dispatch.
- Patch: `services/platform/scripts/plan-24-bake-run-d1-patch.sql`, and
  `node scripts/capability-policy-backfill-sql.mjs` for the new capability.

### S5 — Shadow mode (2 days)

- The controller simulator runs a bake from its own script, as a person at the teach pendant would.
- Satyr observes and correlates each move to the planned task. It sends no command.
- The run records the difference between the planned and the observed times.

Exit: a shadow run gives zero commands to a cobot and zero stock changes.

State (21 November 2026, branch `plan-24-s56`, not released): built.

- Authority: each kitchen location has a mode, `shadow` or `approval`, in the regional table
  `bake_authority` (`kitchen/bakes/authority.ts`). A location with no row is in shadow mode. An
  admin or the owner sets the mode on the Bakes page (`PUT .../bakes/authority`, with the revision
  that they read). A run takes the mode of its location when it starts and keeps it.
- Shadow run: an approved proposal at a shadow location starts a run with the same compiled plan.
  It reserves no device, writes no dispatch and sends no task, pause or stop. The device fleet
  Actor gives it each `cobot_observed` move of its devices; the run matches each move to its
  planned task with `correlateShadowMoves` and keeps the difference of the planned and observed
  times. The canvas, the timeline and the positions show the observed times; a move that the plan
  does not have shows as "Not in the plan". When every planned task has a completed move, the run
  completes and its proposal ends. A shadow run has no alarm, no pause and no check: it changes no
  stock.
- Agent: `bake_read` shows the mode of each location and `bake_run_read` the shadow matches. The
  agent cannot change the mode: approval mode lifts the restriction that keeps the cobots still,
  and the agent lifts no restriction (rules above, Plan 81).
- Patch: `services/platform/scripts/plan-24-shadow-mode-d1-patch.sql`, after the S4 patch.

### S6 — Approval mode and faults (4–6 days)

Each case is one E2E journey with its own outcome:

- A duplicate delivery of a task.
- A gateway disconnect during a move.
- Stale data from a cobot.
- A revoke of a cobot during a run.
- A workflow pause from the Portal, from Slack and from the agent.
- A local emergency stop.
- Both cobots need the oven door at the same time.
- The unload is late. The run shows the risk of an over-bake to the person on shift.

Exit: no move without an approval, no duplicate move, and each uncertain outcome stops the next
dispatch with one visible disposition.

State (21 November 2026, branch `plan-24-s56`, not released): built.

- Disposition: the run's hold is the one visible disposition, on the Bakes page and on the run's
  Slack card. A person settles it with what they saw (`seen`: on the source shelf, on the tool, on
  the destination shelf, or lost), and the run keeps each settlement. Settling never sends a move
  again: a failed task cannot continue; the person says where the mould group is, and the run
  stops. An unknown result continues only after the gateway gave the task's end.
- Duplicate delivery: the device fleet Actor answers a known identity from its ledger, and the
  gateway's journal answers a second `cobot_task` with `replayed`. One move for each task.
- Gateway disconnect: a lost socket holds the run with `result_unknown`; the next hello asks
  `cobot_inquire`; a person settles.
- Stale data: the run counts silence from the last new line of each device, not from any signal,
  so a frozen cobot holds the run with `evidence_lost` (30 s) while the gateway still sends its
  last clock. An old line sent again is a duplicate and changes nothing.
- Revoke: a revoke of a device on the Devices page tells the fleet Actor, and each run that
  watches the device holds at once (`device_revoked`). The revoked device gets no task.
- Pause: from the Portal, from the Pause button of the run's Slack card (same check, a viewer is
  refused) and from the agent's `bake_run_pause`. Only a person resumes.
- Emergency stop and door conflict: the controller's fault holds the run with the failed task.
  The engine reserves the oven door, so Pantry sends a door move only after the receipt of the one
  before; a move from outside the plan that meets the run's move in the door stops both cobots.
- Late unload: the grace time is the recipe's `examine-bake` step, the person's look into the
  oven between the bake and the unload (30 s for the financier; 60 s when a recipe has no such
  step). When the bake ends and an unload does not start within the grace time, the run records
  the over-bake risk once, shows it on the Bakes page and on the run's card, and posts one message
  in the proposal's Slack thread. A paused or held run reads the device clocks from the gateway
  each 10 s while its bake has ended and its unload has not started; then the alarm ends.
- No move without an approval: the fleet Actor sends a new task only for a run that watches the
  device, so a forged call or a call for a run that ended is refused, and nothing is written or
  sent. An open or rejected proposal has no run to start.
- Slack: the run posts its own card in the proposal's thread (`bake_proposal.card_ts`), and each
  change of its state or hold updates it: each task with its dispatch and the controller's receipt,
  the hold and each settlement. The proposal's card shows the end, with the check and its receipt.
- Idle cost: an Organisation with no active run writes nothing more. The over-bake watch exists only
  while a paused or held run waits for its unload, and it ends when the risk is recorded.
- Patch: `services/platform/scripts/plan-24-run-card-d1-patch.sql`, after the S5 patch.

## Steps done

| Step | What exists | Proof |
| --- | --- | --- |
| S1 | Stock levels for each fresh product, set by an admin; one bake proposal on a Case when a café sale takes the counter stock below the level, and one that waits while another is open; approval or rejection with a reason in the Portal and on one Slack card; the Bakes page; agent tools that read and propose | `services/platform/tests/e2e/bake-proposal.test.ts` (artifacts `output/plan-24/bake-proposal-slack.json`, `bake-proposal-agent.json`) |
| S2 | `cobot-controller`, the controller simulator of `bakery-native` (`crates/bakery-native/controller/`): two FR10 arms and the oven on localhost, task times from the FR10 physics cases, and the four faults | `scripts/plan-24/controller-journey.mjs` (artifact `output/plan-24/controller-journey.json`) |
| S3 | The typed `cobot` adapter of `crates/shop-gateway` with its journal, `status` after a reconnect, receipts for pause, resume and stop, the `relay` session, and the cobot messages in `packages/control-api` | `services/platform/tests/e2e/cobot-gateway.test.ts` (artifact `output/plan-24/cobot-gateway-journey.json`) |
| S4 (engine) | The physical execution adapter of the engine (`@purin-labs/production-simulation/physical`): the bake run scenario, the cobot assignment by the engine, the host loop that advances only on receipts and device clocks, the observed read and the shadow correlation | `scripts/plan-24/physical-run-journey.mjs` (artifact `output/plan-24/physical-run-journey.json`) |
| S4 | The bake run Durable Object on the server: start at approval, the dispatch ledger in the device fleet Actor, holds that a person settles, pause, stop, the check that raises the stock, one read for the drawer's canvas, timeline and positions, and two agent tools | `services/platform/tests/e2e/bake-run.test.ts` (artifact `output/plan-24/bake-run-journey.json`; the agent's read and pause moved to `bake-pause.test.ts` in S6, with the real gateway) |
| S5 | Shadow mode: the authority of each kitchen location, a shadow run that matches each observed move to its planned task, zero commands and zero stock changes | `services/platform/tests/e2e/bake-shadow.test.ts` (artifact `output/plan-24/bake-shadow-journey.json`) |
| S6 | Approval mode and faults: one hold for each uncertain outcome, settled with what a person saw; the revoke signal; stale data from a frozen cobot; the Slack run card with Pause; the over-bake risk from the recipe's grace time; no new dispatch for a run that does not watch the device. Exit gate: the declared café day two times | `services/platform/tests/e2e/bake-faults.test.ts`, `bake-pause.test.ts`, `bake-approval-gate.test.ts`, `bake-cafe-day.test.ts` (artifacts `output/plan-24/bake-fault-*.json`, `bake-pause-*.json`, `bake-late-unload.json`, `bake-approval-gate.json`, `cafe-day.json`) |

## Exit gate of the simulation phase

One simulated café day repeats with fresh identities. The counter sales cause bake proposals, a
person approves them, and two cobots load and unload the oven through the real gateway and the
controller simulator. Each fault case in S6 passes. The Portal and Slack hold the full record. After
this gate, the owner decides which cobot to buy.

The whole simulation phase is 17–25 agent days.

## Physical phase, after a purchase

1. Enroll the real cobot on the Devices page, and add its controller driver behind the S3 adapter.
2. Run shadow mode with the real cobot.
3. Run approval mode. Before an approved move near people, the cell integrator does the risk
   assessment of the cell to ISO 10218-2.

## Decisions

| ID | Decision | Recommendation | Cost | Default |
| --- | --- | --- | --- | --- |
| D1 | Unit of approval | One approval covers one bake run, its load and its unload. A wait for an approval of a hot unload burns the bake | A person stops a single move with a pause, not by holding back an approval | Recommendation |
| D2 | Stock level | One level for each product for the whole day, set by an admin. The agent may propose a change | No level for each part of the day | Recommendation |
| D3 | Place of the controller simulator | Its own process on the gateway computer, on localhost | One more process to start. The gateway builds need no MuJoCo | Recommendation |
| D4 | When the stock rises | When a person checks the released pieces | A person checks each batch | Recommendation |
| D5 | Cobot in the simulation | FR10, because both cells exist. No purchase choice now | Other arms need their own cells | FR10 |
| D6 | Split of work between the cobots | Each cobot can load and unload. The engine assigns the tasks, and the oven door is reserved | More conflict cases to test | Recommendation |

## Future NVIDIA Isaac Lab compatibility

BakeryOS workflow simulation runs MuJoCo in the browser through the shared
Rust/WebAssembly boundary defined in [Plan 42B](./plan-42B-mujoco-workcell-simulation.md).
NVIDIA and Google DeepMind provide MuJoCo Warp (Newton), which loads `MJCF`
models directly into Isaac Lab. If we train camera-guided policies for physical
robots under this plan later, we can reuse our existing MuJoCo assets in Isaac
offline.

An offline import spike ([`scripts/bakery-robots/verify_isaac_lab_import.py`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/scripts/bakery-robots/verify_isaac_lab_import.py),
receipt in [`docs/evidence/plan-24-isaac-lab-import-spike.json`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-24-isaac-lab-import-spike.json))
verified all twelve nominal workcell `MJCF` models (`dobot-cr10`, `fairino-fr10`,
`fairino-fr5`, `fanuc-crx10ial`, `ufactory-xarm6`, and `universal-robots-ur5e`
across `table-to-rack-nominal` and `table-to-oven-nominal`) in `newton` (`1.8.0.dev0`)
and `mujoco_warp` (`3.16.0`):

- **Closed-loop parity:** Over `250` steps (`0.5 s`) on `fairino-fr10/table-to-oven-nominal`,
  both `mujoco_warp` and `newton.solvers.SolverMuJoCo` match C MuJoCo within `0.39 µrad`
  on arm joints and `0.77 µm` on the free `mbco_tray` pose.
- **Multi-world replication and OpenUSD export:** `ModelBuilder.replicate(copy_count=4)`
  steps `4` parallel workcells (`64` bodies, `396` shapes) with `3.14 nrad` cross-world
  arm spread, and `ViewerUSD` exports the scene to OpenUSD (`239` prims, `142` mesh prims).
- **Adapter rules for Newton / Isaac Lab import:** Pass `ctrl_direct=True` to
  `ModelBuilder.add_mjcf` to expose the seven `<general>` affine servos on
  `control.mujoco.ctrl`; convert free-joint quaternions from MuJoCo `[w, x, y, z]`
  to Newton `[x, y, z, w]`; call `newton.eval_fk` after setting `state.joint_q`;
  and configure `SolverMuJoCo(..., nconmax=256, njmax=512)` so the `79`-geom oven
  workcell does not overflow Newton's default `nconmax=48` contact buffer.

## Non-goals

- Control of safety functions, safety controllers or device firmware.
- Joint, speed or path commands from Satyr.
- Dough shaping, cream or decoration.
- Autonomous approval of a bake, a payment, a price or a customer promise.
- Export orders. The old Japan-to-Singapore path is closed with
  [Plan 23](plan-23-flavored-export-catalog.md).
- More than one site, or fleet optimisation across sites.

## What changed from the August version

- The first path is a café counter bake, not an export order.
- Plan 85 now owns device enrollment, the gateway and readiness.
- Plans 70A, 84 and 60A now own scheduling, recipes and equipment models.
- The plan supports two cobots and a shared oven from the start.
- The simulation phase runs the real dispatch path, so the purchase decision rests on that proof.
