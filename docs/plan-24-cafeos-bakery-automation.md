# Plan 24 — Cobot bakes in the first café kitchen

Status: Rewritten on 3 November 2026 after a review with the owner. No code exists for this plan.
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
| Devices, gateway, readiness, one task for each device, pause, Slack alerts | [Plan 85](plan-85-device-fleet-page.md), live | Nothing. It calls `deviceReadiness` and `reserveDeviceWork` |
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

### S5 — Shadow mode (2 days)

- The controller simulator runs a bake from its own script, as a person at the teach pendant would.
- Satyr observes and correlates each move to the planned task. It sends no command.
- The run records the difference between the planned and the observed times.

Exit: a shadow run gives zero commands to a cobot and zero stock changes.

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
