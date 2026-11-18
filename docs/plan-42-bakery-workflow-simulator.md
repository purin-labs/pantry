# Plan 42 — Bakery Orchestration Canvas, Timeline and Simulator

Latest status review (5 October 2026): [42E](plan-42E-chat-canvas-parity.md) and
[42F](plan-42F-general-orchestration.md) are complete for their high-impact local
software/simulation scope. Deferred features and release/physical gates remain
explicit in those closeouts. [42G](plan-42G-automatic-context-loading.md) is
complete, including production Pi and Codex acceptance. The
[current status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) reconciles later
evidence with earlier checklists. Dated implementation sections below retain
their historical scope; their old pending statements do not reopen completed work.

Recipe scope review (6 October 2026): Plan 60A owns equipment models in progress.
[Plan 61A](plan-61A-financier-workflow.md) through
[Plan 61E](plan-61E-combined-cafe-shift.md) define draft preparation and service
workflows over the shared scheduler. The existing finishing-shift preset retains
its named assumptions. Its 24-piece tray and resting placeholders are not the
current eight-cavity recipe definition. See the
[calibration worksheet](plan-42-calibration-worksheet.md).

The target commerce loop connects demand, preparation, observed yield, quality,
packing, inventory, sales, and fulfillment. Existing contracts supply lots,
packaging items, completed batches, and shipments. Integration must preserve
those authorities. Simulated completion cannot post physical stock or shipment.
[Plan 24](plan-24-cafeos-bakery-automation.md#production-packaging-and-commerce)
defines the operating boundary and a proposed integrated acceptance scenario.

Workflow simulations use the [browser execution contract](plan-42B-mujoco-workcell-simulation.md#workflow-execution-contract).
TypeScript schedules work, Rust and MuJoCo execute as WebAssembly in a browser
worker, and Three.js renders the returned motion through WebGL. Python CLI labs
and native CLI verification are not operator workflow entry points.

Status: the bounded single-operator implementation and acceptance tranche is
closed. Financier scheduling, rehearsals and multi-batch cold-proxy integration
share oven/cooling capacity and workers. Plan 42F adds two independent FR10 cells
and a simulated human transfer. Shared scenarios support
acyclic dependencies across existing manual operations, transfers and native tray
tasks, with explicit baker assignments and earliest starts. Native attempts bind
to the execution workflow and procedure fingerprint. Physical continuity,
additional operation types and operational calibration remain open. See the
[authoring acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-cross-operation-authoring.md) and
[current acceptance status](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md). Updated: 2026-09-26.

Cold-proxy material/tooling compatibility and custody are implemented: each native
reservation identifies its production tray, incompatible geometry/poses are
rejected, and Details shows custody through clearance or failure holds. See
[material/tooling acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-material-tooling-handoffs.md).
Measured production-material profiles and physical boundary continuity remain open.

Chat-connected observation, view control, reviewed local edits and candidate
acceptance are implemented in [Plan 42C](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-42C-chat-connection.md). Governed
chat save paths and browser MuJoCo execution passed the bounded signed-in
[C6 acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42C-c6-closeout-2026-09-26.md). This does not close
the broader production, calibration or physical-execution gates in this plan.

Latest: [multi-batch and browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-workcells.md)
records six fresh native successes, a native failure hold, production-scenario
pagination/stale-copy recovery and 390px/no-WebGL checks.
[Calibration intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md) awaits operator measurements.
The [release readiness ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) separates
the latest verified checks from the remaining gates.

Resume from the [agent handoff](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md). It separates verified
deliveries, concurrent worktree changes and the next acceptance gates. The dated
sections below retain historical evidence; their old blockers are superseded by
the linked closeout records.

## Accepted direction — one run, three synchronized views

BakeryOS is the bakery orchestration workspace within CafeOS. An operator
authors production work and watches its execution through three synchronized
views of one bakery orchestration run:

| View              | What it expresses                                                          |
| ----------------- | -------------------------------------------------------------------------- |
| Workflow canvas   | Operations, dependencies, robot/equipment assignments and handoffs         |
| Resource timeline | When each robot, oven and station is occupied; transfers, waits and faults |
| Three.js bakery   | The spatial playback of those same tasks and resource states               |

The workflow canvas is the editable workflow view of the robotics simulation
loop. All three views share the validated procedure, exact scenario inputs,
task and resource identities, ordered execution events, selection and replay
cursor. The orchestration model owns execution state; each view projects it.

[Refactor 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-5.md) keeps this authoring/orchestration boundary in
TypeScript and moves native simulation execution to Rust. The native boundary,
rack/loading/retrieval skills, packaged runner and combined oven→table→rack
fixture have passed their recorded acceptance campaigns. Current native commands
and format versions are in the [runner guide](../crates/bakery-native/README.md).

This section and the O1–O4 milestones define the next implementation. The
21 September review replaces the transport-robot-first proof with the existing
FR10 cold-tray workcell and makes the missing shared task state explicit.
The dated MVP sections below record delivered behavior and verification.
[Plan 24](./plan-24-cafeos-bakery-automation.md) owns physical robot enrollment,
authorization, dispatch and receipt reconciliation. This plan owns simulated
orchestration and its operator views. Plan 40's canvas proposal is now scoped here;
concurrent authoring later reuses the
[Plan 40C multiplayer module](./plan-40C-multiplayer-module.md).

[Plan 42B](./plan-42B-mujoco-workcell-simulation.md) has implemented its native
MuJoCo FR10 workcell, continuous cold-tray transfer and local recording replay
(M0–M2). Its M3 integrates evidence with this plan's task loop. Plan 42 owns
the run; Plan 42B supplies a bounded simulated task execution source. A fixed
arm and a mobile transport robot have different capabilities and spatial limits.

### Repository review — 21 September 2026

The table records the baseline before this day's task-event increment. Named
human allocation, semantic events and worker timeline lanes are now delivered
in the [first O1 slice](#task-identity-and-event-loop-increment--21-september-2026).
The later increments below also deliver local cold-tray run/attempt identity,
fixed-arm reservations, evidence settlement and scheduled shared inspection.
The table's remaining-work column describes the inspected baseline.

| Area         | Evidence in the current source                                                                                                                                                         | Remaining work                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Procedure    | `packages/bakery-model/src/bakery-procedure.ts` strictly compiles six financier operations and five station/equipment roles.                                                      | Compile stable task instances, explicit handling and capability requirements; keep the existing recipe order.                   |
| Run          | `schedule.ts` uses numeric worker indices, process/transfer/wait intervals and event timestamps. Its `Run` has no run/attempt identity or external-evidence state.                     | Named resources, task/attempt IDs, ordered semantic events, reservations and completion/failure transitions.                    |
| Selection    | `scene.ts` defines only batch/station selection; `simulator-state.ts` shares it and one workflow replay cursor.                                                                        | Move selection to the run model and add operation/task/resource/cycle identity without depending on a scene-owned type.         |
| Canvas       | `canvas.tsx` edits saved durations and temporary node positions; its selected operation is component-local.                                                                            | Shared task selection, execution overlays, assignment/dependency edits and saved coordinates.                                   |
| Timeline     | `timeline.tsx` renders one track per batch.                                                                                                                                            | Resource lanes, occupancy, shared cycles, handoff events and explicit waits/failures.                                           |
| Bakery scene | `scene.ts` replays generic workers and now loads the articulated Maruzen MBCO-5E.                                                                                                      | Bind named task/resources to the scene; retain the difference between the five-level visual and scenario-defined tray capacity. |
| Physics      | `physics-replay.tsx` loads validated FR10 recordings; `physics-model.ts`/`physics-scene.ts` replay recorded poses. The shell pauses the workflow while the independent replay is open. | Match an exact pending attempt, settle its events, and project attached evidence through the workflow cursor.                   |
| Persistence  | Scenario copies contain settings and a procedure fingerprint. `bakery/operation.ts` saves durations. Saved-view presentations support table/board.                                     | Executor/constraint schemas, atomic relationship edits, workflow presentation and explicit evidence retention.                  |

The [playback consolidation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-shared-playback.md) gives workflow
and recording inspection one route-owned playback session and one active clock.
The subsequent [scheduled cold-tray increment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-scheduled-dispatch.md)
attaches accepted evidence to a bounded local run: workflow, resource lanes and
3D share its cursor and selection. Standalone recordings retain their own time
coordinates. General financier/workcell scheduling and authoring remain open;
the full O1–O4 and M3 milestones remain incomplete. Native phase-boundary
continuation and a fixed cold oven load–unload sequence are now implemented in
Plan 42B. The dashboard still accepts one transfer per attempt; importing and
projecting the two-task sequence remains open.

Review verification: all 35 existing simulator Node tests, shared-client type
checking and three native recording tests passed on 21 September against the
inspected M2 baseline, before the ongoing oven-recording edits below. These cover
the current scheduler, procedure/state/controllers, oven visuals and recording
boundary. They do not prove pending task integration or resource lanes. The
[M2 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-physics-replay.md) records the earlier browser
walkthrough; this repository review did not repeat that browser acceptance.

Subsequent committed work adds `table-to-oven` replay and single-attempt evidence
handoff, strict recording lifecycle checks, native checkpoint continuation and
a native-only cold load–unload sequence. See Plan 42B's
[oven handoff](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-maruzen-oven-loading.md) and
[two-skill evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-oven-cycle.md). These supersede the
earlier worktree-only status; full production integration remains incomplete.

### Closeout review — 21 September 2026

Commits `3f0d8576`, `264e7abc` and `7c1ca084` add shared replay/resource
explanations, financier equipment lanes and native load–unload continuity.
The baseline table above is historical. Use the delivered increments and the
remaining acceptance criteria below when choosing implementation work.

Historical next steps at this review (use the current [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md)
when resuming):

1. Live-accept O3's bounded oven-assignment slice. Candidate validation, atomic
   mutation, revision/receipt tests and canvas save/readback are implemented
   locally; the workspace backend currently prevents the browser walkthrough.
   See [verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-oven-reassignment.md).
2. Independently, extend M3's shared task/evidence boundary to the proved native
   two-skill sequence before widening to general financier/workcell scheduling.
3. Add page-level collaborative bakery authoring through the existing Plan 40C
   module after the corresponding canonical save path works. Floor-layout
   editing, physical dispatch and a CRDT-engine replacement remain outside this
   increment.

Commands used for that review:

```sh
node --test apps/portal/src/features/workflow-simulator/*.test.mjs
pnpm --filter @satyr/bakery-model check:types
scripts/bakery-robots/.venv/bin/python scripts/bakery-robots/test_recording.py
```

### Shared model and orchestration loop

Keep three distinct layers:

1. **Definition:** the procedure's operations, required material dependencies,
   equipment and executor requirements. Workspace definitions use the entity
   plane; the local demo has an explicit local source identity.
2. **Scenario:** batches, named available resources, assignments or eligible
   resource sets, release constraints, assumed durations and injected outages.
   It references a precise procedure/resource revision set.
3. **Run:** one immutable resolved input snapshot plus ordered task events and
   resource allocations. Each task instance identifies its run, batch, operation
   or handoff, and assigned resources. A shared oven cycle identifies all members.

The loop applies completion or fault observations, settles task state and
allocations, finds work whose dependencies and resources are ready, reserves
the required resources together, starts eligible tasks, and advances to the
next event. Assumed execution supplies deterministic observations at virtual
times. A task requiring native evidence suspends computation at its dispatch
boundary until that exact attempt has a validated result. Precomputation can
then continue through the same loop. Playback and Next event only inspect the
accepted event prefix; animation frames never execute work. Plan 24 later
supplies validated physical receipts to the relevant task transitions.

Expand the financier procedure into inspectable task instances for staging,
portioning, transfers, oven loading, baking, unloading, cooling, demoulding and
packing. Keep the six canonical recipe operations. Transfer and handling tasks
have stable identities derived from their source operation/handoff; generated
bake cycles remain run records. Do not persist each simulated task as a new
commerce operation or production batch.

Resources distinguish humans, fixed arms, mobile carriers and equipment. A task
requires explicit capabilities, capacity and reachable source/destination.
Retain the human-operated financier shift as the regression baseline. The next
robot proof uses the existing fixed FR10 arm, clamp, cold tray, source table and
rack slot in a bounded local workcell scenario. It shares the run model and all
three views with the financier scenario. It adds one supported task template,
without relaxing the six-operation financier compiler into an arbitrary graph.

The cold table-to-rack recording cannot stand in for oven loading, hot unloading
or a walking worker's route. Connect it to a financier handoff only after matching
its material state, tooling, pose, capacity and resource requirements. Keep
unsupported handling human-assigned. A mobile carrier is a later capability
increment. Baking releases its attending executor while retaining oven capacity.

Represent task lifecycle with precise branches for queued, running, awaiting
evidence, completed, failed and indeterminate work, with required branch-specific
identities, allocations and evidence. Completed physical work requires a validated receipt;
completed simulation work requires its simulated event. Use a discriminated
execution-source type so simulated completion cannot become physical evidence.
Model run lifecycle and playback separately. Use existing Result-style boundary
parsers, branch-specific builders, exhaustive switches and type fixtures. The
awaiting-evidence branch requires the attempt, pinned request and held
allocations; the first O1 slice establishes failure and uncertainty settlement
so Plan 42B M3 does not depend on finishing the later O4 acceptance campaign.

### Attach physics evidence to the same run

The reviewed M2 `bakery-physics.ts` boundary validates standalone version-1
recordings with local run/attempt IDs, a `table-to-rack` task label, case,
model hash and timestep. The in-progress oven extension adds another task kind
and fixture/version fields. Neither supplies workflow revision, reservation identity,
request fingerprint or resumable integration checkpoint. A recording that passes
that parser is valid for local inspection; it cannot yet settle a workflow task.

O1 and Plan 42B M3 must add the following at the existing request/result boundary:

- Bind the exact run/task/attempt, compiled input fingerprint, robot/tool/tray,
  cell/source/destination, execution parameters and initial state. Retain the
  complete pinned request and compare the returned fingerprint before settlement.
- Reserve required resources before export; reject an incompatible workcell or
  assignment before waiting for evidence. The first bridge is manual CLI export
  and browser import, using the current native runner and import validation.
- Import the complete artifact atomically. Order observations at
  `dispatch time + physics step × timestep`, interleaved with other run events.
  Native wall-clock latency does not change bakery task duration.
- Release source occupancy only on pickup evidence and settle destination on
  placement. Release the arm/cell on terminal settlement. Unknown tray disposition
  retains conservative reservations until an explicit simulated recovery settles it.
- Identical accepted attempts replay idempotently. Wrong/stale attempts and
  conflicting duplicates leave the run unchanged. Rejected imports or runner
  errors never use the assumed-success duration as a substitute.
- Attached pose playback derives task-local time from the shared workflow cursor.
  Use the existing tested frame conversion and pinned workcell transform; retain
  task/resource selection across all views. Standalone inspection uses the same
  playback owner with an explicit recording mode and paused workflow bookmark.
  Its recording time remains clearly identified as unattached evidence; it cannot
  run a second clock alongside the workflow.
- Seeking changes only visible state. Terminal recording metadata must not show
  a task as completed before the shared cursor reaches its completion event.
- Recordings contain visual pose samples, not a resumable MuJoCo checkpoint.
  Repeated tasks need complete model/controller state continuity under M3 before
  a multi-batch robot run is accepted; never reset the arm or tray implicitly.

Workspace scenario definitions omit recordings. A separate named production-run
snapshot stores exact native requests and accepted evidence, and a pending run
stays pending on reopen. It never recreates success from durations. Imported
local files are unauthenticated simulation evidence and grant no physical
production, inventory or robot authority.

### Interaction contract

- Selecting an operation, task, batch, cycle or resource resolves the same IDs
  across all views and one inspector. An operation spanning several batches
  retains the selected batch and exposes its task instances.
- The timeline defaults to resource lanes and retains batch grouping as another
  projection. Oven cycles appear once in the oven lane with member batches;
  worker/robot lanes show actual allocations. A queued task appears as a wait
  annotation linked to the blocking resource, without implying it occupies it.
- Dragging canvas nodes changes presentation coordinates. Dragging a task to a
  compatible resource lane proposes an assignment. Dragging horizontally edits
  an explicit earliest-start constraint; resizing a supported process edits its
  duration. The scheduler recomputes resulting times and explains blocked or
  rejected constraints. Derived waits, transfers and cycle bars are inspectable.
  Show whether an edit affects the whole procedure or the selected batch before
  applying it; a shared bake duration applies to every member of that cycle.
- Dependency edits affect the procedure draft and must compile before Run.
  The first editor supports the financier operation vocabulary and required
  material order. Missing connections may exist in a draft; cycles, unsupported
  branches and missing required prerequisites prevent execution. Multiple
  batches already permit resource-level concurrency without a general graph DSL.
- Assignments, dependencies and duration changes use the same draft/validation
  path whether initiated on the canvas, timeline or through inspector controls.
  Provide keyboard/form equivalents for every drag operation.
- Apply edits to a new run from shift start. Preserve the previous run and
  baseline with their exact input snapshots; mark them out of date after source
  changes. Seeking backward only replays events. Mid-run editing and branching
  remain deferred. Playback pause is distinct from a workflow dispatch pause.

### Implementation milestones

Build O1 then O2 to establish one run and its projections. Next connect the
existing FR10 evidence through Plan 42B M3. O3 shared authoring can follow the
same O1/O2 foundation independently of native evidence integration. O4 finishes
the integrated failure and operator acceptance campaign. Keep the local preview
and authenticated BakeryOS → Production route on the same feature.

The first implementation slice is the O1 run/task/resource model and shared
selection, preserving current financier outputs. A second slice renders resource
lanes and task overlays. A third proves one cold-tray task with attached FR10
evidence before expanding to repeated transfers or shared scenario editing.

#### O1 — Make simulated orchestration explicit

##### Task identity and event-loop increment — 21 September 2026

M2 physics replay is complete in Plan 42B. Its recording outcomes cannot be
attached to production tasks yet: the current scheduler uses anonymous worker
indices and interval timestamps without an explicit execution-event record.
Implement this bounded first O1 slice before robot assignment or M3 settlement.

| Gap                                                       | This increment                                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers are array indices shared implicitly by views      | Resolve named human resources from validated staffing inputs; use their stable IDs for allocation, inspector and scene projection.                       |
| Tasks have no identity independent of their start time    | Assign run-scoped IDs from batch and canonical operation/handoff, preserving existing procedure entity references.                                       |
| A full simulation hides its execution boundaries          | Expose the existing loop as event-by-event execution; full precomputation drains that same loop. Record ordered starts, pickups and assumed completions. |
| Playback can confuse future intervals with completed work | Derive queued/running/completed task inspection from accepted events at the replay cursor; completion evidence is explicitly simulated.                  |
| Worker contention is hard to inspect                      | Add compact worker-allocation lanes beside the existing batch timeline and show task identity/status in the inspector.                                   |

- [x] Replace index-only worker allocation with named human resource IDs.
- [x] Record stable task IDs and ordered execution events using one stepped/full loop.
- [x] Expose worker lanes and event-derived task details through the current UI.
- [x] Verify unchanged shift timings/capacities, deterministic stepping, immutable
      event snapshots, horizon handling, type rejection and keyboard interaction.

Delivered: [task-event evidence and walkthrough](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-task-events.md).
All 39 simulator tests pass, including four new lifecycle/stepping regressions;
portal/client types and production build pass. Worker-bar and native-selector
navigation preserve the shared batch/time, and 320 px layout checks pass after
constraining the canvas's grid column. Full O1/O2 remain open below.

Scope boundary: this first increment preserves the human-only financier example.
The fixed FR10 workcell, explicit handoffs and failure/reservation settlement
follow within O1 before M3; O4 verifies the integrated failure cases. Shared
assignment authoring belongs to O3. MuJoCo imports remain standalone until M3.
Mobile transport robots are a later capability increment.

##### Bounded evidence handoff increment — 21 September 2026

Before widening the scheduler, exercise one isolated, cold table-to-rack attempt
inside Physics replay. This is a local contract exercise; the financier run,
workspace saves and shared workflow cursor remain unchanged. Full O1/O2 and M3
remain open until the workcell uses their shared compiled input and projections.

| Gap                                               | Implementation in this increment                                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone replay has no pending attempt          | Import a native-prepared request, pin every request field and reserve the fixed FR10, clamp, tray, source, rack slot and cell together. Allow one attempt per session.                                    |
| Valid recordings can belong to another experiment | Compare the entire validated request before accepting an explicitly submitted recording. Keep mismatched/rejected imports from changing state or allocations.                                             |
| Failure and duplicate semantics are undefined     | Success releases execution resources and leaves the rack slot occupied. Failure/runner error holds resources for recovery. Exact duplicate artifacts are idempotent; conflicting duplicates are rejected. |
| Playback could imply successful execution         | Show settlement separately from the read-only replay cursor. Resource/event projections use simulation time and require pickup/placement evidence. Never settle by playing or seeking.                    |
| Manual CLI flow is difficult to discover          | Add a compact expandable attempt panel, request import/export, and an explicitly labelled bundled-example rehearsal. No Python launch, cloud writes or robot dispatch.                                    |

Do not admit a second transfer using the first recording's visual endpoint:
resumable native state and explicit simulated recovery are still missing. Native
`bakeryTaskId` identifies a skill; the local task instance has its own run-scoped ID.
Model hashes pin the current fixed native experiment. General compiled workflow
fingerprints, resource bindings and initial-state snapshots remain M3 work.

- [x] Implement and test the single-attempt boundary and conservative allocations.
- [x] Expose the local evidence handoff in Physics replay and verify keyboard/reflow.
- [x] Document the manual round trip and the remaining shared-run integration.

Implemented with seven focused behavioral tests, lifecycle type fixtures, a native
failure round trip and browser verification. See the
[handoff guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-workcell-handoff.md). The shared scheduler work
below remains open; this local exercise does not complete O1/O2 or M3.

##### Shared cold-tray inspection increment — 21 September 2026

Promote the local attempt out of the handoff component into `simulator-state.ts`.
The next bounded deliverable is one cold-tray workflow, six resource lanes and a
shared inspector synchronized with its accepted recording. The existing financier
procedure editor and scheduler remain unchanged.

| Gap                                                  | Implementation in this increment                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The handoff component privately owns execution state | Route-owned commands reserve and settle the same attempt; the handoff panel only imports/exports evidence and displays command feedback.                                                |
| Views have no common workcell selection              | Define typed task/resource selections outside Three.js. Workflow nodes, resource lanes and scene picks update the same run-scoped selection.                                            |
| Occupancy lifetimes are hidden                       | Derive resource phases from pickup, placement and terminal evidence. Display waiting with unknown duration and terminal occupancy/holds as open-ended, without inventing a finish time. |
| A loaded recording can be unrelated to the attempt   | Only the accepted artifact supplies the attempt cursor and scene selection. Unattached inspection is labelled; restoring accepted evidence uses the existing single playback owner.     |
| WebGL is required to understand the workcell         | Add a fixed source → cold-tray task → rack workflow, resource lanes and inspector that remain usable if 3D loading fails.                                                               |

- [x] Lift reservation/settlement state and commands into the shared simulator model.
- [x] Add shared workflow/resource projections and task/resource selection.
- [x] Connect accepted-recording scene selection and read-only cursor inspection.
- [x] Verify source switching, fault holds, selection, keyboard use and narrow layouts.

Implemented with five focused shared-view tests, type fixtures and browser checks
for scene picking, pickup/completion seeking, unrelated-recording isolation and a
native failure import. See the [shared-view guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-workcell-views.md).

This observational workflow is fixed and read-only. The next increment below
adds nonzero dispatch offsets. General `ProcedureCanvas` authoring, concurrent
financier/workcell scheduling, compiled workflow fingerprints, recovery and
consecutive transfers remain open.
Full O1/O2/M3 completion still requires those broader integration contracts.

##### Scheduled cold-tray dispatch increment — 21 September 2026

After the shared inspection increment, compile the fixed cold-tray input with an
explicit dispatch time. A transfer scheduled at 60 seconds must remain queued
before 60 seconds. Reservations begin at dispatch; pickup, placement and completion
are positioned at dispatch time plus their recorded offsets. Accepted workcell
evidence uses run time in the single playback owner, and the pose projection
subtracts dispatch time to sample the recording. Standalone inspection retains
recording-local time.

- [x] Compile a validated rack request, fixed resource bindings and a bounded
      dispatch time into an immutable input before creating the attempt.
- [x] Project queued state before dispatch, then evidence-derived resource phases
      and terminal settlement at the shifted run times.
- [x] Bind accepted workcell playback to that input; preserve standalone recording
      inspection, source switching and paused bookmarks without adding a clock.
- [x] Add the dispatch-time control, show run/recording time clearly and verify a
      nonzero-start success/failure run in all workcell views.

Implemented with compiler/type fixtures, three scheduled-dispatch behavioral tests
and browser verification of nominal and native failure evidence at a 60-second
dispatch. The 62-test simulator suite and portal build passed. See the
[scheduled-dispatch guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-scheduled-dispatch.md).

This increment leaves the native request schema and model hashes unchanged.
The current native request pins the fixed experiment; general workflow snapshot
fingerprints, dynamic assignments, shared financier/workcell scheduling and native
state continuity remain in O1/M3. Local dispatch timing alone does not complete
the full evidence-binding contract.

##### Reopenable local experiment increment — 21 September 2026

Recording export preserves native evidence but omits the scheduled dispatch and
compiled workcell input. Add a bounded local experiment file so an operator can
reopen the same pending or evidence-backed run after reloading the page. This
does not replace workspace-shared scenario/evidence storage.

| Gap                                                                         | Implementation in this increment                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reload loses dispatch time and the reserved attempt                         | Export the exact native request, dispatch time and fixed resource bindings together. Recompile and compare bindings on import.                                                |
| A recording alone loses its accepted run context                            | Include the existing recording unchanged when evidence has been accepted; distinguish pending from evidence-backed files.                                                     |
| Serialized lifecycle fields could fabricate completion                      | Validate the file at one boundary, then reconstruct through the existing compiler, reservation and settlement functions. Never trust serialized outcome/resource projections. |
| Import could overwrite an active experiment or race a file read             | Allow restore only into an empty workcell session. Invalid, stale and occupied-session imports preserve the current attempt and replay.                                       |
| Local files could be confused with shared cloud saves or native checkpoints | Label local-only export/import explicitly. Restore paused at run start; require explicit evidence acceptance. No hardware authority, Python launch or resumable native state. |

- [x] Implement bounded experiment export/parser and lifecycle/type tests.
- [x] Restore validated inputs through the existing simulator owner and load any
      included recording for explicit acceptance through the normal handoff.
- [x] Add compact native import/export controls with cancellation, errors and focus.
- [x] Verify pending, completed and failed round trips, mismatches, rejected restores
      and the browser workflow; document the local/shared persistence boundary.
- [x] Verify the actual saved browser download. The later isolated Chrome journey
      captured downloaded bytes and reopened complete, partial and failed files.
      See [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).

Delivered with five focused tests, 70 passing simulator tests, portal types/build
and browser import/accept/seek checks. See the
[local experiment guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-local-experiments.md).

Selection and playback positions are presentation state and are omitted. General
workflow revisions, native input fingerprints, resumable MuJoCo checkpoints,
consecutive transfers and workspace artifact retention remain separate work.

##### Workcell wait and allocation explanations — 21 September 2026

The shared cold-tray views expose resource states but leave the operator to infer
why a task is queued, why a reservation persists, or what a failure prevents.
Add read-only explanations to the existing inspector before adding further
scheduler behavior.

| Gap                                                                | Bounded implementation                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued, awaiting evidence and running can look like the same delay | Derive explanations from the existing attempt projection at the shared cursor. Distinguish scheduled start, missing evidence and accepted replay; never infer resource contention. |
| Resource labels omit the owner and release condition               | Explain the selected resource's reservation, source occupancy, destination occupancy or recovery hold using its bound role and current state.                                      |
| A failure reason is separated from held resources                  | Show the accepted failure/runner-error reason at the terminal cursor, preserve unknown tray location, and explain that all six holds require a future recovery protocol.           |
| An explanation could imply unsupported downstream execution        | Explicitly state that the experiment contains one transfer. Follow-on dependencies, automatic recovery and consecutive transfers remain unimplemented.                             |

- [x] Add pure explanation projections without new lifecycle or scheduler state.
- [x] Render the explanation in the existing workflow/resource inspector using
      native semantics and the current selection; support the WebGL failure path.
- [x] Cover pending, queued, pickup, successful placement and failed/unknown
      outcomes for rack and oven inputs; prove scrubbing leaves evidence and
      allocations unchanged.
- [x] Verify browser replay, keyboard selection and narrow-width wrapping, then
      record a reproducible walkthrough.

Delivered with three focused explanation tests, 77 passing simulator tests,
portal types/build, and browser checks for oven pickup/placement plus an imported
native unreachable result. The disclosure and resource selection work by keyboard
and wrap at 320px. The explanation sits outside the scene's failure boundary;
forced WebGL failure and screen-reader speech were not exercised this increment.
See the [workcell explanation guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-workcell-explanations.md).

##### General scheduler contract

Completed bounded workcell portions (see the local task-chain evidence below):

- [x] Compile named FR10/cell/tray/station bindings and two compatible manual
      workers at the input boundary.
- [x] Reserve an exact native attempt, await matching evidence, and settle
      completion, failure or runner error without fabricating success.
- [x] Schedule manual dependencies and exclusive worker allocations around the
      native operation, with unknown evidence blocking its dependents.
- [x] Cover local lifecycle/source invariants, replay isolation, resource waits
      and invalid graph/assignment combinations with type and behavioral tests.

The bounded financier/workcell run model is complete. See the
[general run model evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-general-run-model.md).

- [x] Resolve validated financier settings or compiled production workcells to
      one simulation input with named workers, station capacities and a fixed
      FR10 capability. Keep canonical procedure refs in the compiled procedure
      and raw records at their existing parser boundaries.
- [x] Carry exact native attempt identity and explicit workcell reservations
      through the existing event loop, preserving shared oven cycles, rack
      capacity, empty travel and pickup/drop handling.
- [x] Move selection out of `scene.ts` into `selection.ts` and connect the
      current financier task/human and bounded workcell resource identities.
      General cross-workcell selection remains part of O2 integration.
- [x] Use named humans and the fixed FR10 capability with explicit handoffs.
      Check assigned-worker capability, workcell reach, tray capacity and
      allocations before starting; retain the human-only regression scenario.
- [x] Keep assumed completion separate from an explicit awaiting-evidence
      event. Preserve validated completion, failure, runner error and uncertain
      resource holds with exact attempt identity.
- [x] Run full and stepped computation through the same transitions. Accepting
      evidence recompiles the same resolved run from shift start so native
      duration can be inserted at its original dispatch time; seeking remains
      read-only. No scheduler checkpoint is persisted.
- [x] Cover invalid lifecycle/source combinations with type fixtures and
      deterministic replay, dependent waits, assigned workers, capacity and
      native contention with behavioral tests.

Exit: existing financier runs retain their results through the new task model.
A bounded cold-tray task reserves the arm, tray, destination and workcell, waits
for evidence, then settles one matching result. Invalid results preserve the
waiting state and reservations. No executor overlaps tasks, no tray reservation
exceeds capacity, and downstream work cannot start after an uncertain outcome.

#### O2 — Expose all three views of that run

##### Equipment allocation lanes — 21 September 2026

Extend the financier timeline beyond batch and human tracks to show all five
stations, including oven and cooling-rack capacity. Derive reservations from the
existing run's accepted task events: the destination is reserved at dispatch,
the source stays occupied until pickup, and packing completion releases the
final station. Keep reservations across processing and waiting. A shift horizon
must preserve unresolved allocations without inventing release events.

- [x] Add a pure equipment projection with aggregated capacity, shared bake-cycle
      identity and independent oven availability; an existing bake survives an outage.
- [x] Add equipment lanes, a keyboard-accessible interval picker and current
      occupancy summaries to the existing production timeline.
- [x] Reuse station selection and the one workflow cursor for interval seeking;
      preserve the current dock and make the same station selectable in 3D/Inspector.
- [x] Verify handoffs, shared cycles, outages, horizon reservations, keyboard
      selection and narrow layouts, with no scheduler or evidence mutations.

Delivered with four focused projection tests, the 23-test equipment/selection/
state/scheduler regression group, portal build and browser checks. See the
[equipment-lane walkthrough](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-equipment-lanes.md).

This increment visualizes the existing financier run. Cross-workcell contention,
robot dependencies and authoring remain later O1/O3/M3 work.

##### Bounded workcell workspace — 22 September 2026

The rack, oven-transfer and cold-cycle runs now use a full-page Three.js scene
with floating Workflow, Timeline and Details panels. Desktop operators can open
the three panels together; narrow layouts show the most recently chosen panel.
All panels consume the existing run projection, selection and playback cursor.
Selecting a task, timeline resource or linked scene object reveals its Details;
closing a panel returns keyboard focus to its toolbar control. Setup & files
contains the existing prepare/accept and unified save/reopen controls, including
complete two-task cycle files. Panel changes never rebuild or settle a run.

This completes the bounded workcell workspace surface. The authoring and chain
increment below extends it. General financier/workcell contention and combined
production task projections remain in O1–O3. See the
[workspace walkthrough](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-unified-workspace.md).

##### Local task chains, authoring and native handoff — 22 September 2026

- [x] Schedule a validated dependency graph around one supported native workcell
      operation. Manual tasks use Baker 1 or Baker 2; successful prerequisites
      and exclusive resource availability gate their starts. Independent work
      can finish while native evidence remains unknown. The shared cursor extends
      through post-processing and explicit simulated recovery.
- [x] Prepare a nominal cold oven cycle from its loading request before any
      recording exists. Export the pinned request, run the existing local CLI,
      import the matching continuous sequence and accept it explicitly. Unloading
      derives its request from the actual loading handoff in MuJoCo.
- [x] Add an Edit workflow panel with movable cards, resource drops, keyboard and
      form alternatives, dependency/start edits and a schedule preview. Save
      draft canvas positions separately from execution settings. Applied plans
      travel with saved run files; older local files normalize at import only.
- [x] Preview a resource outage, an injected manual failure and an explicit
      assumed recovery. Compare horizon, completed/unfinished tasks and waiting
      against a pinned baseline. Native failures retain their original evidence;
      simulated reset does not turn a failed prerequisite into a successful one.
- [x] Verify compiler/type boundaries, conflicting assignments, cycles, resource
      exclusion, request matching, save/reopen and synchronized playback.
- [x] Accept completed oven loading while unloading awaits evidence. Replay and
      save/reopen the accepted prefix, preserve resource reservations and gate
      dependent work until the matching full cycle completes. See the
      [incremental-cycle guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-incremental-cycle.md).

The bounded editor permits up to 20 tasks, exactly one native cell operation,
two manual workers and one outage/fault/recovery per comparison. The native
operation is one rack/oven transfer or a mandatory continuous cold load→unload
cycle. Manual tasks have assumed timing and no invented robot motion. Equipment
and robot identity remain pinned by the validated request. Valid graphs with
failed native prerequisites apply as blocked runs: the request and any matching
recording are retained, dispatch has no timestamp, and native resources remain
unreserved. Independent manual work follows the shared clock; the robot stays
at its initial pose. Save/reopen preserves this state. Outages prevent new
dispatch, without interrupting an operation already running.

The multi-tray workspace extends the shared scheduler beyond that individual
operation editor: up to 16 native operations across named trays, each with its
own request and evidence. A generated stage → native → clear queue serializes
the shared cell. The same tray may receive additional operations after explicit
assumed human handling. General dependency authoring across operations,
multi-cell allocation and continuous native handoffs remain separate work.
See [multi-tray verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-multi-tray.md).

This supplies local portions of O1–O4 and M3. General native skill graphs,
financier/native material handoffs, shared authoring/storage, multiple robots and
verified physical recovery remain open. See the
[implementation and test guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-task-chains.md).

##### Remaining shared-view contract

- [x] Consolidate playback ownership in the route and `playback-state.ts`.
      Workflow and standalone recording inspection share one active cursor,
      speed, play/pause state and frame controller. Switching sources retains
      paused time/speed bookmarks; inactive sources cannot play. See
      [verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-shared-playback.md). The fixed cold-tray
      increment now supplies task-bound offsets and shared task/resource selection;
      general run integration remains below and in M3.
- [x] Share bounded workcell task/resource/cycle selection and projections through
      `simulator-state.ts`, including loading, unloading and authored manual tasks.
      Cross-financier/workcell contention remains in the next item.
- [x] Add financier human/equipment lanes alongside batch grouping, exposing
      occupancy, shared bake cycles and handoffs; add bounded workcell resource
      explanations. See the equipment allocation increment above.
- [x] Project shared financier/workcell contention and dependent waits from the
      integrated run. Production Workflow condenses repeated waits by batch and
      names the assigned baker or FR10 cell; Timeline retains individual spans.
      See [integrated acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md).
- [x] Show task state, assignment and current wait text on `ProcedureCanvas`;
      selecting a node resolves the matching run task through shared selection.
      The component does not rebuild the schedule.
- [x] Use the bounded rehearsal's editable canvas as its live Workflow view,
      with shared task selection, cursor-derived status and wait explanations.
      Keep execution drafts separate until Apply; retain them across native
      evidence acceptance. See [live canvas verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-live-canvas.md).
- [x] Bind existing financier humans/equipment and workcell resources to their
      run selections; reuse FR10 geometry and pose lifetime code. Attached native
      evidence uses the shared cursor. The bounded production rehearsal now
      composes bakery stations, active worker/batch markers and the recorded
      robot cell in one scene. Marker positions are illustrative; continuous
      human travel and validated physical material handoffs remain open.
- [x] Make bounded workcell Workflow, Timeline and Bakery peer views within the same workspace,
      with a shared inspector. Support side-by-side inspection on desktop and
      view switching on narrow screens without resetting selection or playback.

Exit: selecting a financier handling task or the bounded cold-tray task resolves
the same task, batch, resource and state in every view. Play, pause, seek and
event stepping keep them synchronized, including an awaiting-evidence state.
The operator can explain one resource wait through the lane or canvas with
WebGL unavailable. M3 then replaces the workcell fixture with native evidence
without introducing a second attached-run clock.

#### O3 — Author and save the orchestration scenario

- [x] Add local workcell draft assignments and earliest-start editing, movable
      cards, resource drops and keyboard/form alternatives. Compile and preview
      the complete candidate before applying or saving. Pointer acceptance is
      tracked separately below.
- [x] Extend bounded FR10 tray, baker and predecessor assignment authoring to
      a shared financier/workcell production scenario definition.
- [x] Extend entity schemas/relationships and scenario fingerprints for the
      bounded executor assignments and timing constraints. Procedure-wide
      requirements belong to the procedure; per-batch overrides belong to the
      scenario. Use the existing entity plane and revision/receipt boundaries.
      The supported per-tray timing constraint is earliest cold-proxy staging;
      see [timing-gate evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-timing-gate.md).
- [x] Implement atomic relationship replacement through contracts, Underclerk
      and platform authorization, with bounded Bake oven reassignment. General
      executor-assignment editing remains part of the broader O3 authoring work.
- [x] Add bounded local dependency editing; validate the entire candidate DAG
      and replace the applied plan atomically. Preserve mandatory native
      load→unload ordering and reject unsupported or cyclic graphs.
- [x] Persist bounded native predecessor relationships in immutable shared
      scenario copies while preserving financier material order. Shared
      production scenarios now accept multiple acyclic native predecessors per
      tray; see [dependency acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-dependencies.md).
- [x] Save local draft coordinates separately from execution settings; moving a
      card leaves dispatch and durations unchanged. Round-trip through draft files.
- [x] Include bounded rehearsal canvas positions with applied assignments,
      dependencies and recordings in local files and named workspace snapshots.
      Normalize older files at import; validate positions before restoring.
      Workspace saves re-read and compile the stored copy and distinguish a
      confirmed save whose readback failed. See [authoring persistence acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-authoring-persistence.md).
- [x] Save shared production node coordinates as validated presentation data on
      immutable scenario copies and their run files. Moving a card creates an
      editable copy and leaves executable source fingerprints unchanged. The
      commerce saved-view contract currently supports tables and boards only;
      mutable per-user canvas views remain a later collaboration concern.
- [x] Re-read and compile saved definitions before replacing the displayed run.
      Preserve drafts on conflict; distinguish saved-but-readback-failed outcomes.
      Reject stale saved scenarios until explicitly recreated against new inputs.
- [x] Separate saved local execution settings from optional recording evidence.
      Restore pending setup or a paused recorded preview; require explicit
      acceptance to reconnect the run. Complete oven cycles preserve both legs.
- [x] Extend missing-evidence and explicit reattachment behavior to shared saved
      scenarios, preserving revision and receipt boundaries.

Exit: change a compatible assignment or timing constraint, rerun and compare,
save a named copy, and replay the same inputs in a second tab. Demonstrate stale
revision rejection and interruption/retry without partial reassignment or
duplicate effects. Canvas arrangement survives reload and never changes timing.
Physical robot enrollment and credentials are outside simulated resource data.

The shared-production authoring slice has a typed definition without recording
evidence. The operator previews a whole candidate before applying or saving;
an admin saves an immutable scenario copy through the authorized entity plane
and verifies readback. Draft IDs survive edits and retries; editing a saved or
uncertain copy starts a new identity. A viewer can reopen a saved definition by
ID, verify its current procedure revision, and apply a fresh run explicitly.
Named production-run snapshots store exact requests and accepted evidence in
the existing authorized workspace storage. Reopening verifies shared-scenario
provenance, then offers explicit acceptance of the paused run. See
[shared authoring and run saves](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-shared-production-saves.md).
Shared canvas coordinates now persist on validated immutable scenario copies.
Concurrent member edits remain open under this gate.

#### O4 — Prove feedback, faults and operator usefulness

- [x] Add a local robot/cell/worker dispatch outage and injected manual failure.
      Keep native failures tied to matching recordings; never relabel successful
      native evidence or assume success after a runner error.
- [x] Retain failed native evidence and conservative allocations. An explicit
      assumed manual recovery releases simulated holds while failed prerequisites
      continue blocking dependent work.
- [x] Compare local assignments, outage and failure/recovery settings against a
      pinned baseline using completed/unfinished counts, horizon and start waits.
- [x] Add guided production phase jumps, current-work/wait explanations and
      minute/second comparisons with the first changed task and outage context.
      Verify paused keyboard jumps and backward selection across the shared views.
      See [guided MVP acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-guided-mvp.md).
- [x] Verify local cycle/chain save and reopen, request-first native acceptance,
      invalid graph isolation and the extended shared playback cursor.
- [x] Verify pointer card movement, compatible resource drops, incompatible-drop
      rejection and keyboard assignment. Replace the unreliable HTML drag path
      with captured pointer handling and explicit target feedback.
- [x] Download the bounded financier run in a normal browser, parse the actual
      bytes and reopen it with all eleven tasks and production metadata intact.
      See [single-operator acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-single-operator-mvp.md).
- [x] Verify v3 authored-cycle save/readback through authenticated Worker/R2
      integration: retain dependencies and layout, require explicit evidence
      acceptance, preserve immutable copies, and exercise pagination/retry/access
      boundaries. See [storage acceptance follow-through](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-authoring-persistence.md#authenticated-storage-follow-through--23-september-2026).
- [x] Verify actual v3 rehearsal and multi-tray browser downloads, read their
      bytes and reopen complete/partial/failed evidence. Verify signed-in layout
      save/reload with unchanged timing and explicit acceptance. See
      [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).
- [x] Apply failure scenarios whose prerequisites block native dispatch as
      first-class runs. Preserve the request and retained recording without
      accepting execution or inventing dispatch/settlement times. Workflow,
      Timeline and Details share the blocker and manual clock; 3D stays at the
      initial pose. Save/reopen supports runs with or without retained evidence.
- [x] Run the integrated nominal/blocked/unreachable/slip campaign across
      financier/workcell tasks, plus a withheld-result boundary, and compare
      lateness, overdue unfinished work and simulated waits. See
      [campaign evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md).
- [x] Verify signed-in production-scenario save/reload and a failed read preserving
      the applied run. Verify bounded rehearsal keyboard controls, reduced motion,
      narrow layout and the context-loss fallback handler. See the guided and
      single-operator acceptance records.
- [x] Consolidate single-/multi-tray playback ownership, preserve session state
      across view switches, reattach responsive observation, cache shared schedules,
      and use one saved-run review and workspace persistence path for both shapes.
      See [workspace consolidation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-workspace-consolidation.md).
- [x] Verify rehearsal saved-run pagination, missing/malformed-copy recovery,
      late-response isolation and keyboard retry at 390px. See
      [saved-run recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-saved-run-recovery.md).
- [x] Verify production-scenario browser pagination and stale-revision feedback.
      See [multi-batch acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-workcells.md).
      Two-member and cross-member walkthroughs remain deferred.
- [x] Verify actual initial WebGL-disabled production, rehearsal and multi-tray
      startup, 390px keyboard controls, partial/failed file restore and scene
      remount. Fix hidden mobile fallback and interrupted-import controls. See
      [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).
- [x] Harden multi-tray scene cleanup for failed loads, context loss and cleared
      runs; verify playback remains usable and unmount cancels its frame. Add
      panel Close/Escape controls with focus return and verify narrow keyboard
      use. See [workspace resilience](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-workspace-resilience.md).
      GPU-disabled startup is now verified in the browser acceptance above.
- [x] Record a named-machine development baseline for scene load, Timeline
      interaction and playback frame cadence in the browser acceptance record.
- [x] Set and verify local development performance targets for the 16-operation
      scheduler, warm 3D scene, Timeline interaction and playback cadence. See
      [integrated acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md).
      Operational calibration remains open until measured financier handling
      and bake-cycle evidence exists.

Exit: the same injected fault stops the same task and dependent work in all
three views. Playback never repairs or redispatches it. An operator can locate
the cause, inspect the recovery outcome and explain the baseline difference.
Uncalibrated scenarios retain the `Simulation · Assumed timings` label.

### Menu clarity pass — 22 September 2026

The five primary menus expose too much implementation detail at once. Preserve
simulation behavior and the portal shell while improving the default reading path.

- [x] Workflow: compact numbered steps, plain status labels and one-line assignment details.
- [x] Edit inputs: four primary settings, compact presets, reachable apply action;
      move outage settings and modelling assumptions into named disclosures.
- [x] Inspector: prioritize activity, worker and finish time; hide internal IDs
      and source references in technical details.
- [x] Compare: lead with the finish-time change and before/after metrics;
      collapse configuration and detailed waiting explanations.
- [x] Robot rehearsal: focus on choosing an example and the next required action;
      collapse file tools and native execution instructions without bypassing acceptance.
- [x] Verify all five panels, edits/comparison, robot preparation/acceptance,
      keyboard use and 320px/390px layouts; run focused tests and portal checks.

Verification: 114 simulator tests and the portal build passed. Browser checks
covered the two-worker comparison (11m 53s earlier), invalid input focus, task
selection, keyboard disclosures/Escape, and cold-cycle preparation and acceptance.
The accepted robot view opens Workflow alone; Timeline and Details remain available.
Technical and file disclosures preserve the existing operations and evidence checks.
Phone-width checks used collapsed navigation. Screen-reader and font-only zoom
checks remain manual; this pass does not change the portal navigation layout.

### Next implementation sequence — 22 September 2026

#### Single-operator priorities — accepted 22 September 2026

Further two-member sharing features and the two-member browser walkthrough are
deferred. Existing named workspace saves and their authorization remain in place.

Gap map for the next increment:

| Gap                                               | Bounded implementation                                                                                                                                                                                                                              | Acceptance                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Changing rehearsals requires a reload             | Add New run with explicit discard confirmation; atomically clear rehearsal, evidence, selection and child drafts while retaining production inputs and its paused bookmark. Invalidate pending imports and opens.                                   | Cancel preserves work; confirmed reset allows another run without reload; late responses cannot restore discarded work.               |
| Single-operator checks are fragmented             | Exercise edit, replay, compare, actual file download and reopen; test invalid/interrupted imports, keyboard, narrow layout and WebGL fallback.                                                                                                      | Record exact browser and automated evidence, keeping authenticated-dashboard blockers explicit.                                       |
| Production and native tasks use separate examples | Compile one financier tray from the applied production timings into the existing task-chain scheduler, with assumed human/equipment tasks and a gated cold table-to-rack transfer before packing. Use the same task/resource projections and clock. | Baker and oven constraints affect native dispatch; missing/failed evidence blocks packing; local save/reopen retains the whole chain. |

The production example is a cold-proxy rehearsal. Assumed cooling does not
validate food temperature, tray mass, tooling or hot handling. It must retain
the native request's fixed cold-tray geometry and explicitly identify that
boundary. General multi-batch native orchestration stays outside this slice.

- [x] Implement and verify safe New run, including stale asynchronous work.
- [x] Complete the bounded single-operator acceptance checks and document remaining gaps.
- [x] Implement the bounded production-to-cold-transfer example and tests.
- [x] Make the editable canvas the live Workflow panel for bounded rehearsals:
      project shared task status, selection and waits; keep unapplied execution
      edits explicit; preserve drafts across evidence acceptance and playback.
- [x] Compose the bakery and robot cell in one rehearsal scene: reuse station
      assets, project assumed production activity from the shared run, preserve
      recorded native poses, and link spatial picks to the shared inspector.
      See [composed scene verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-composed-scene.md).
- [x] Explain bounded rehearsal waits and handoffs: name prerequisites and
      resource holders, link blocking/dependent tasks, show release-time jumps
      and directed dependencies, and expose selectable tray routes with the
      current tray location. See [waits and handoffs verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-waits-handoffs.md).
- [x] Generalize local rehearsals to multiple named trays and native operations:
      key native evidence by operation, serialize the shared FR10 cell, retain
      explicit assumed staging/clearance, project all trays through one cursor,
      and save/reopen the complete run. See [multi-tray verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-multi-tray.md).
- [x] Add a read-only Workflow view to the eight recipe simulations (siphon,
      latte, black sesame cobot, ginger tea cobot, financier batter, bake and
      pack, combined café shift). Cards read the simulation clock and outcome,
      and a card seeks the same replay as the 3D station and the timeline.
      Editing and branch nodes stay deferred. Verify with
      `scripts/production-simulation/verify-recipe-workflow-browser.js`.

Evidence: [live workflow canvas](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-live-canvas.md). Workflow and
Edit workflow now share one mounted canvas. Native cycle legs remain individually
selectable; assumed human/equipment tasks use the same selection boundary.
Apply restarts the shared schedule, while card movement changes presentation only.
This completes the bounded rehearsal surface; general multi-batch
`ProcedureCanvas` integration and shared authoring revisions remain open under
O1–O3. (2026-11-14: Plan 84 D7 removed `ProcedureCanvas`; Plan 84 owns recipe authoring.)

Evidence: [single-operator MVP walkthrough](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-single-operator-mvp.md).
The signed-in local dashboard saved and reopened the eleven-task example,
requiring explicit recording acceptance again. It demonstrated the same oven
outage delay as the isolated browser check. The example fixes one baker and one
tray; it does not consume the full multi-batch production schedule. Production
phases appear in the shared workflow, timeline and status. The composed scene
increment adds bakery stations and assumed activity around the recorded cold
robot cell. Continuous physical material handoffs and calibrated hot handling
remain open. The separate production-scenario HTTP 422 was subsequently fixed:
unpublished scenario types now produce an empty catalogue, and signed-in
load → edit → save → reload plus failed-read preservation passed. See
[guided MVP acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-guided-mvp.md).

Completed: valid blocked graphs now apply, retain requests/recordings, and share
manual playback and blocker explanations across the workspace. Reopening keeps
native tasks undispatched; editing out the blocker recomputes dispatch with the
retained evidence. The robot remains at its initial pose while blocked.

Completed: incremental cold-cycle execution accepts loading, retains its shared
replay while unloading is pending, and saves/reopens that prefix. Importing the
matching resumed cycle continues playback at the loading boundary. The original
native handoff remains required by MuJoCo to resume execution.

1. **Finish remaining single-operator acceptance:** signed-in layout restoration,
   actual downloads, initial WebGL fallback, cleanup and local performance now
   have browser evidence. Rehearsal pagination and stale-response recovery are
   verified. Production-scenario pagination and stale-revision feedback remain
   open; see the [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) for exact verification scope.
2. **Shared scenarios — deferred:** carry assignments, dependency edits and
   presentation positions through existing revision/receipt boundaries; verify
   conflicts and missing-evidence behavior in a second tab when this work resumes.
3. **General orchestration:** the combined sequence now exposes all three native
   tasks and both handoffs, including authored dispatch delays, full saved files
   and nominal/fault replay. See [combined portal acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-combined-portal.md).
   Multi-batch financier integration now supports a per-tray cold-transfer gate
   in the existing scheduler; arbitrary cross-operation authoring remains open. The local multi-tray
   queue uses assumed handling between independent requests; supported physical
   material handoffs and calibration still require evidence.

The local workspace, cycle files, task-chain preview, request-first cycle handoff,
local authoring and fault comparison are checked off above. This sequence is the
remaining integration work. It extends the completed local features.

### Ownership and verification

#### Guided MVP follow-through — accepted 23 September 2026

The composed scene and live canvas were reused, preserving shared task/resource
selection and recorded poses. The following gap map is completed for priorities
1–3; its acceptance evidence is linked below:

| Gap                                                            | Smallest implementation                                                                                                                                                         | Acceptance                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scenario catalogue returns HTTP 422 in the signed-in workspace | Trace the existing graph-query boundary and fix the demonstrated mismatch without bypassing authorization or hiding genuine errors.                                             | Empty catalogue is usable; load sample, edit, save, reload and open a named scenario; failed reads preserve the current run.                                             |
| Scene composition needs final integration verification         | Verify the existing bakery stations, worker/batch markers and translated native cell against the applied task projection.                                                       | Bake, robot transfer and packing selections agree across canvas, timeline, scene and details, including backward seeking.                                                |
| Long runs are difficult to explore                             | Add three production jump controls and a compact happening/waiting/reason summary using applied tasks. Show comparison durations in minutes and explain the first changed wait. | Keyboard jumps pause and select the exact task; unavailable phases never invent a timestamp; outage comparison names its cause; controls remain usable at narrow widths. |

- [x] Repair and verify the production scenario round trip.
- [x] Verify composed-scene integration against the current native recording boundary.
- [x] Implement and verify guided phase jumps, run summary and readable comparisons.

Verified in the signed-in local dashboard and at desktop/mobile widths. See
[guided MVP acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-guided-mvp.md) for reproduction steps,
test results and unrelated workspace verification failures.

Keep measured recipe calibration, continuous physical material handoffs,
two-member collaboration, multi-robot scheduling and hardware dispatch deferred.

Reuse the existing boundaries:

| Owner                                                                   | Work                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/bakery-model/src/bakery*.ts`                             | Boundary parsing, procedure compilation, scenario inputs and source fingerprints               |
| `apps/portal/src/features/workflow-simulator/`                          | Pure simulation loop, task/resource projections, canvas, timeline, scene and shared view state |
| `services/underclerk/src/entity-plane/`                                 | Canonical entities, relationships, atomic mutation and receipts                                |
| `packages/contracts` and `services/platform/src/commerce/entity-plane/` | Shared command contracts, authorized request boundaries and projections                        |
| Plan 24's existing platform/Case boundaries                             | Later robot enrollment, governed dispatch, observations and terminal receipt reconciliation    |

`crates/bakery-native/` owns native execution and resumable MuJoCo state;
`packages/bakery-model/src/bakery-physics.ts` owns the portal artifact
boundary. Python is retained for offline asset preparation. Extend these existing
boundaries for exact pending attempts; do not add a parallel recording schema
in the views. Preserve standalone recording inspection and attached pose replay.

Run the existing simulator Node tests and portal type/build checks for O1–O4.
Run Underclerk/shared-client checks and targeted entity/platform tests when O3
changes their contracts. Regenerate bindings through existing tooling. Shared
lifecycle changes require static fixtures for invalid direct construction,
broad spreads and branch combinations. Review boundary casts. Commerce lifecycle
or enrollment changes also require the repository's commerce-lab or onboarding
closure checks as applicable. Finish with focused formatter and diff checks.

Do not introduce a second workflow store, per-view scheduler, generic workflow
engine, new service or deployment for these milestones. Concurrent editing and
comments follow O3 using the existing multiplayer module and a bounded bakery
draft schema; execution still consumes a validated revision. Real equipment
control proceeds through Plan 24 after the simulation and physical readiness
gates. Plan 42B owns bounded workcell kinematics/contact evidence. General
floor-layout authoring, mobile navigation/collision avoidance, unrestricted
graph editing, multi-site optimization and mid-run branching remain deferred.

## Implemented MVP — evidence from 2026-09-08

The initial increment made a small example to explore the product before
expanding entity architecture. Assignment editing now belongs to O3 above.

- [x] Open directly into the local three-batch financier demo, with no setup or
      entity IDs required. Keep playback user-started and shared records untouched.
- [x] Add Normal morning, Two workers and Oven breakdown presets plus Reset.
      Presets replace local inputs and reset the time cursor; warn about unrun drafts.
- [x] Surface worker count and bake duration as the simple experiment form;
      retain the existing normal/outage switch and hide full inputs behind disclosure.
- [x] Show the six-step workflow next to the bakery, with step selection seeking
      the same schedule. This is a fixed local workflow preview; shared drag-and-drop
      authoring remains available in the advanced workspace tools.
- [x] Show finish time, late/unfinished counts and the largest recorded source
      of waiting. Label that wait summary accurately rather than inferring causality.
- [x] Collapse workspace setup/saves and detailed cycle diagnostics behind named
      disclosures. Shared save-a-copy remains available for entity-backed procedures;
      local demo experiments reset on leaving and do not silently become cloud saves.
- [x] Verify presets, invalid input, reset, selection/playback and responsive
      layout; run focused tests and the portal build. Record remaining limitations.

Use the existing scheduler and scene. No new persistence, authority, dependency
graph editor, atomic relationship command or robot execution belongs in this slice.

MVP verification, 2026-09-08: the existing development-only
`https://localhost:3003/workflow-preview.html` now opens the same simulator with
no account data or backend dependency. Portal workspace routes use the same UI.
Browser checks passed for two workers (07:07:06), oven breakdown (07:35:51),
zero-minute bake rejection with focus on the field and unchanged results,
Enter-key application of a 20-minute bake (outage finish 07:45:51), page-reload
reset, and Play/Pause/Reset to 06:00. Selecting Baking seeks to 06:19:08 and
shows Baking/running in the workflow and station observation. A 390px layout
check exposed minimum-content overflow; explicit grid-child minimum widths
fixed it. Controls and scene then measured 366px within the 390px viewport.
Desktop layout and 3D assets were visually inspected; temporary viewport
override was reset. Eleven focused simulator tests, portal types and production
build pass. No workspace records were changed by these checks.

Try it: open the local preview, choose a preset, select Play shift or a workflow
step, then change Workers or Baking and select Apply experiment. Use Reset demo
to return to the initial morning. The fixed workflow preview is selectable;
drag-and-drop duration authoring remains in the workspace procedure tools.
Local demo edits deliberately have no save action. Cloud save-a-copy still
requires a loaded shared procedure. Full screen-reader/reduced-motion audits,
shared-copy cross-tab checks and physical timing calibration remain separate
follow-up work; they do not prevent trying this bounded local product example.

## Completion summary — 2026-09-08

The delivery checklist below records current completion. Dated progress notes
retain the evidence and limitations of each increment; their earlier pending
items are superseded by this summary and later entries.

- Implemented deterministic financier shifts with worker/tray limits, shared
  oven cycles, rack queues, handling intervals and oven-outage comparison.
- Integrated the shared Three.js bakery, timeline and workflow canvas into
  CafeOS. Canvas duration edits update the canonical operation entities;
  the views use the same validated procedure and simulated run.
- Implemented workspace-shared named scenario copies, source revision
  fingerprints, bounded staffing/outage assumptions, and paginated name search.
- Corrected relationship cardinality enforcement so multiple scenario copies
  can reference one procedure while each copy retains one procedure link.
- Latest verification: 2,267 platform tests, 177 Underclerk tests and ten
  simulator tests passed, along with relevant production type checks and the
  portal build. The broader platform test-type check still fails on unrelated
  `harness-tool-catalog.test.ts` fixtures missing `readMerchantReport`.

Earlier authenticated browser checks demonstrated the simulator, shared bake
cycles, canvas duration save/readback and two-tab stale-edit rejection. The
first named scenario save/readback also passed. The later browser check below
also verified assumption drafts, Discard, name search and saved-copy replay.
Cross-tab scenario-copy loading remains pending: opening the second tab was
blocked by the browser client. No production deploy
or live equipment control occurred. All bakery timings remain assumptions.

### Remaining MVP checks

Signed-in same-workspace save/reload, failed-read preservation and bounded
rehearsal keyboard/narrow-screen checks are complete. Rehearsal pagination and
stale-response recovery, initial WebGL fallback, scene cleanup and local
performance measurements now have evidence. Production-scenario pagination and
stale-revision feedback now pass isolated browser checks; see
[multi-batch acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-workcells.md). Supported
integrated faults and local performance targets now have
[acceptance evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md).
Cross-member sharing is deferred. Operational
calibration needs measured bakery data. See the [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md)
before choosing more implementation work; O1–O4 and M3 remain broader than the
completed bounded examples.

## Existing foundation — financier shifts and workspace-shared scenarios

### O3 prerequisite detail — replace the bake operation's oven

Inspection, 2026-09-08: the canvas edits operation durations today. The compiler
accepts exactly seven operations and five equipment records, with one equipment
record per station role. The scene selects models and floor positions by station
role. Equipment links are canonical custom relationships. The entity command
contract supported creating and deleting these relationships, with no command
to replace an endpoint atomically. The 21 September implementation below closes
that command gap.

The smallest assignment increment replaces the single oven used by Bake.
Keep the six-step financier chain, one active oven and current floor positions.
Do not introduce parallel ovens, alternative routing, layout authoring or an
equipment catalogue service. Candidate equipment must already exist in the
workspace, be active on the supported bakery schema, have the bake station
role and fit the requested whole-batch tray load within current simulator bounds.
The visual now uses the approved Maruzen MBCO-5E asset. Its five modeled levels
do not override the assigned entity's tray capacity or establish measured layout.

| Gap                                                            | Required behavior before shipping                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint replacement has no atomic command                     | Add a narrowly typed replacement command through the existing entity command/receipt transaction. Require the current relationship reference/revision, replacement equipment reference and expected merchant revision. Validate endpoint type, cardinality and authority before changing anything. An interruption or rejection must preserve the original assignment; retry must reuse the command ID and receipt. |
| Canvas currently exposes only the selected equipment reference | Retain the assignment relationship identity/revision in the compiled operation. Let an admin enter an existing oven entity ID and validate it before saving. Start with ID entry rather than building a new catalogue picker.                                                                                                                                                                                       |
| Compiler and simulation need the replacement together          | Validate the candidate procedure with the existing strict compiler before mutation. Read back the saved graph, then rebuild both runs and update the inspector's equipment reference together. Preserve the previous replay until readback succeeds.                                                                                                                                                                |
| Capacity and identity can diverge between views                | Demonstrate the replacement entity's tray capacity driving shared bake cycles and the same entity ID appearing in canvas and observation. Floor position and representative asset remain fixed and disclosed.                                                                                                                                                                                                       |
| A saved scenario references the previous assignment            | Existing source fingerprints must reject the old scenario after assignment replacement. Do not rewrite old copies or silently retarget them.                                                                                                                                                                                                                                                                        |

Delivery order:

- [x] Inspect existing assignment, scene and command boundaries and map the gap.
- [x] Implement the shared atomic relationship-command prerequisite within O3.
      This spans contracts/generated bindings, Underclerk and platform
      authorization, plus the canvas and tests.
- [x] Implement and demonstrate atomic replacement through the existing command
      transaction, with stale-revision and interrupted-retry evidence.
- [x] Add the bounded Bake oven-ID editor and consistent save/readback flow.
- [x] Demonstrate through the isolated Underclerk HTTP fixture a compatible
      replacement oven, invalid-target rejection without mutation, and a stale
      old scenario after replacement.
- [x] Retired 2026-11-14: Repeat the save/readback and conflict walkthrough in the live local portal
      once workspace procedure loading succeeds. Plan 84 D7 removed the Bake oven editor with
      `ProcedureCanvas`; the Plan 84 canvas edits recipe resources.
- [x] Map and implement bounded dependency editing through the shared production
      workflow, including cycle rejection and saved rules. See
      [cross-operation acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-cross-operation-authoring.md).

The earlier localized scope checkpoint is superseded by the O3 plan. Atomic
assignment replacement is implemented locally on 21 September. The command
preserves the relationship ID, increments its revision and commits its endpoint,
merchant revision, observation and receipt together. The bakery route validates
the complete candidate graph and the editor reloads the saved procedure before
replacing both runs. Rejected or uncertain saves preserve the draft and previous
replay; a confirmed save with failed readback requires reload. Floor position
and the representative oven asset remain fixed. Live acceptance is pending;
see [checks and limitations](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-oven-reassignment.md).

User direction, 2026-09-08: financiers are the primary product; equipment has
not been selected and no measured production timings are available. Scenarios
must be shared within a CafeOS workspace. The drag-and-drop workflow canvas and
Three.js bakery are two views of the same object/entity system, sharing logic
and identity. Map gaps before implementing them.
This section supersedes the cookie-only, single-batch-oven and local-only save
limits below. The earlier progress report remains evidence for the shipped
cookie increment only.

### Gap map and decisions

| Gap                                             | Decision for this increment                                                                                                                                                                                                                                                                                                                       | Completion evidence                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cookie workflow does not represent financiers   | Use a finishing shift starting with prepared, rested batter and a preheated oven. First station stages/weighs batter; next portions moulds. Cooling includes an explicit attended demoulding step before packing. Brown butter preparation, batter mixing/resting, washing and preheating occur before the shift and are disclosed prerequisites. | Financier labels and step allocations agree in form, timeline and scene.                                                |
| Equipment and moulds are unselected             | Reference one four-tray 600 × 400 mm convection oven. Make pieces per tray, trays per batch, usable oven trays and rack trays editable; never infer mould yield from tray dimensions.                                                                                                                                                             | A batch too large for either resource is rejected. Quantity is derived from explicit yield and tray count.              |
| Whole oven reserved by one batch                | Gather whole compatible batches into one shared cycle, up to tray capacity. Same recipe, temperature, fan setting and bake duration for all batches in this bounded scenario. No mixing arbitrary products or splitting batches.                                                                                                                  | Shared batches have identical bake start/end; tray limits hold during loading, baking and unloading.                    |
| Filling strategy and door handling are implicit | Loading window starts at first incoming reservation. Start when full, when the window expires after admitted loads finish, or when all remaining unbaked batches are loaded. Zero means bake after the first load. After baking, unload all batches before admitting a new cycle. Doors animate only for actual load/unload handling.             | Show cycle IDs, member batches, used/capacity trays and start/end; demonstrate immediate versus fill-window scheduling. |
| Transfer handling is hard-coded                 | Expose per-batch oven loading/unloading seconds separately from walking time. Keep ordinary pickup/drop handling explicit in assumptions.                                                                                                                                                                                                         | Changing handling time changes worker occupancy, door interval and cycle availability consistently.                     |
| Timings have no bakery evidence                 | Retain a persistent assumed-timings label. Save an operator timing note with each scenario. Published recipe timings are references, never observations of this bakery.                                                                                                                                                                           | No UI or saved record claims validated timings without actual observations.                                             |
| Scenarios disappear on navigation               | Persist named workflow definitions and scenario inputs through the existing entity-plane ownership and command paths. Reuse the control-plane session, membership and CSRF boundaries. Simulation still runs in the browser.                                                                                                                      | Save, reload, reopen from a second tab and obtain identical runs.                                                       |
| Concurrent edits can overwrite work             | Require expected revision for updates; return conflict on stale revision. Preserve local input and offer reload or save a separate copy.                                                                                                                                                                                                          | Two-tab stale save cannot overwrite the newer revision.                                                                 |
| Cross-workspace access and malformed saves      | Reuse entity-plane read/mutation authority, resource sensitivity and revision checks. Validate workflow-specific attributes, references and bounded settings once at the boundary. Use one shared contract consumed by both views and the backend.                                                                                                | Focused coverage for denied cross-organisation access, read-only mutations, CSRF, invalid inputs and stale updates.     |

### Entity identity across the three views

The canonical workflow belongs to the entity system. Neither a Three.js object
tree nor canvas node state is authoritative business data. The canvas authors
workflows/procedures; the resource timeline and Three.js observe their simulated
execution. All three select the same entity/task references and consume the same
validated workflow revision and run projection. Canvas, timeline and inspector
authoring controls submit through the same validated draft/mutation path.

| Shared concept                   | Workflow canvas         | Resource timeline                  | Three.js bakery                            |
| -------------------------------- | ----------------------- | ---------------------------------- | ------------------------------------------ |
| Resource identity and capability | Operation assignment    | Named resource lane                | Scene instance linked to that resource     |
| Operation and dependency         | Step and connection     | Eligible task and predecessor      | Work at the assigned station               |
| Task and handoff                 | Active task instance    | Processing/transfer interval       | Recorded work or movement                  |
| Batch and shared bake cycle      | Cycle membership        | One oven cycle with member batches | Loaded trays, oven state and door handling |
| Run event at a cursor time       | Progress, wait or fault | Occupancy, wait or fault           | Corresponding machine/carrier state        |

Canvas node coordinates are presentation data. Equipment floor positions and
handoff routes are physical-layout data in meters and can affect travel times.
Dragging a node to tidy the canvas never moves an oven or changes the schedule.
Floor-layout authoring is deferred; Three.js has no equipment-dragging mutation
mode in this increment. Playback dragging/orbiting is view-only.
Wiring a dependency or assigning equipment changes the workflow definition;
moving a card between visual lanes must not accidentally execute production.

A scenario references a workflow revision and adds bounded simulation inputs
(batches, timings, staffing and outage assumptions). Alternative scenarios can
reference the same equipment without mutating its live operational state.
Runs retain their exact resolved input snapshot; editing a definition marks
older runs out of date instead of rewriting their history. Generated bake
cycles and queue intervals are derived run records, not authored graph nodes.

Current code evidence: the commerce entity plane already supplies custom
entities, typed attributes, relationships, saved views, revision-checked
commands and mutation receipts. Ownership is in
`services/underclerk/src/entity-plane/`; the platform projects and authorizes
it through `services/platform/src/commerce/entity-plane/`. The portal has
drag-and-drop commerce boards and the bounded `ProcedureCanvas`. Its operation
duration editing and temporary layout are implemented. Dependency editing and
resource assignment remain O3 work; board dragging does not supply them.

Existing contracts cover procedure/operation/equipment schemas, relationship
reads, scenario references, source fingerprints and bounded compilation. O1–O3
extend these for executor capabilities, assignments, task instances and timing
constraints. Retain the financier material order and reject unsupported
cycles/branches and incompatible assignments. Multiplayer dragging is a later
consumer of the existing collaboration module; workspace-shared saves retain
the established revision/conflict path.

#### Entity mapping and remaining contract work

| Concept                      | Existing owner/type to reuse           | Narrow addition                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe ingredients and yield | System `recipe_revision` entity        | Procedure references the recipe; do not duplicate its inventory recipe or add execution steps to its existing ingredient contract.                                                                |
| Work location/station        | System `preparation_station` entity    | Reuse station identity; physical equipment is a distinct custom entity related to that station, with capability, tray capacity and illustrative asset/layout attributes.                          |
| Procedure                    | Custom entity                          | Name, prerequisites and recipe relationship; related operation entities define the procedure.                                                                                                     |
| Operation                    | Custom entity plus typed relationships | Operation kind, duration and labor attributes; procedure membership, predecessor and equipment-assignment relationships. Canvas coordinates belong to presentation.                               |
| Scenario                     | Custom entity                          | Bounded batch/staff/outage assumptions and calibration note; relationship to the procedure. Pin the resolved entity-plane snapshot for each run.                                                  |
| Completed real production    | System `production_batch` entity       | Read/reference only in later live observability. Simulated batches never write this record: its existing contract includes inventory movements, actual yield and completion.                      |
| Canvas layout                | Saved-view presentation                | Add a bounded workflow presentation variant with entity-keyed coordinates and procedure scope; current `CommerceViewPresentation` supports only table and board. No Three.js scene serialization. |

Entity attributes already support bounded integers, decimals, text and choices;
custom relationship definitions already constrain endpoint types and cardinality.
Use these facilities instead of adding a parallel workflow persistence schema.
The browser adapter still needs semantic checks across records: one procedure,
required operations, acyclic supported dependencies, compatible equipment,
consistent units and a complete readable snapshot. A structurally valid entity
record alone does not guarantee a runnable procedure.

Implement persistence as revision-checked edits to the owned entities and
relationships. A canvas may contain an incomplete draft; disable Run and
explain missing connections until compilation succeeds. Pin a single resolved
snapshot for a run so edits cannot produce a mixture of old/new definitions.
Resolve the existing snapshot reader's guarantees before implementing revision
pinning; avoid a multi-record publication protocol unless that path proves
insufficient. Do not grant new mutation authority or bypass existing approvals
merely to make the demo save successfully.

The first adapter is deliberately bounded to the financier finishing template.
It consumes already parsed entity-plane records from one authorized snapshot:
one `bakery_procedure`, six `bakery_operation` entities, five
`bakery_equipment` entities, and their relationships. Operations use `operation`
text and `minutes` integer attributes; equipment uses `station` text and
`capacity_trays` integer attributes. Relationship definitions are
`bakery_procedure_operation`, `bakery_operation_equipment`, and
`bakery_operation_next`. Schema revisions start at 1. Require the complete
stage → portion → bake → cool → demould → finishCooling → pack sequence and compatible station
assignments. Unsupported topology returns an actionable compile error instead
of being ignored. Scenario settings supply staffing, batch sizes and outages;
operation durations and equipment capacities come from the entity records.

The compiled value retains the snapshot revision and the procedure, operation
and equipment references. A run pairs that immutable compiled source with its
schedule; observation can resolve a scheduled operation back to its entity.
The existing sample UI remains a clearly labelled local template until the
authorized entity read/save path is connected. This adapter does not provision
schemas, publish entities, grant authority or claim cloud persistence.

Adapter progress, 2026-09-08: `procedure.ts` now compiles the bounded entity
snapshot and pairs the resulting schedule with its pinned source. The portal
can request a procedure through the existing authorized commerce graph route;
loaded definitions are read-only, and the batch inspector resolves processing
steps to operation/equipment entity IDs. The page is keyed by organisation and
workspace so switching context unmounts prior state. Late load responses are
discarded after unmount, and failed loads preserve the displayed simulation.

Nine focused tests pass, including entity identity retention, immutable run
inputs and rejection of missing/extra dependencies, wrong equipment, duplicate
attributes, wrong attribute scope and archived objects. A normalized fixture
produced the same 07:18:59 run as the financier sample. Portal types/build pass.
Authenticated browser verification first exercised the missing-procedure failure
path and confirmed that sample playback remained available.

Provisioning progress, 2026-09-08: the admin-only sample action now creates the
three schemas, three relationship definitions, twelve entities and seventeen
relationships through existing entity commands. The authenticated local
workspace created and loaded `financier-finishing-sample` at snapshot 174.
Repeating setup retained snapshot 174; switching to the local sample and loading
the saved ID again succeeded. Seeking to cycle 1 showed the saved bake operation
and oven equipment identities, two batches baking and the same 07:18:59 finish.
This changes local shared entity records only; no production deployment,
permission grants, production batches or inventory mutations occurred.

The first real readback exposed integer attributes serialized as strings by the
graph route. The existing portal response boundary now normalizes those integer
assignments before domain parsing. A focused real entity-service test proves
interrupted setup resumes, repeats create no duplicates or revision changes,
and graph integer attributes survive the platform/browser round trip. It rejects
fractional integer wire values. All 2,265 platform tests and nine simulator tests
pass; portal production build passes. Platform test type-checking remains blocked
by unrelated harness-tool-catalog fixtures missing `readMerchantReport`.
Canvas authoring progress, 2026-09-08: a connected six-operation canvas now
edits one shared duration at a time. Nodes retain operation/equipment identities;
pointer arrangement and keyboard movement affect temporary presentation only.
The editor preserves failed drafts, guards source/operation switches and ordinary
link navigation, and distinguishes a saved write whose readback failed from an
unconfirmed write. Browser history/back navigation needs broader portal-level
unsaved-draft coordination; this slice does not add a global navigation framework.

Authenticated local verification saved Bake from 15 to 16 minutes: entity revision
1 → 2, snapshot 174 → 175, and cycle 1 ended at 06:35:08 instead of 06:34:08.
The canvas action sought that same bake entity in the 3D replay. A second tab
loaded snapshot 175; after the first tab restored 15 minutes at snapshot 176,
the second tab's 17-minute write was rejected and retained its draft. Reload
recovered the saved value. The sample is restored to 15 minutes, revision 3.
Keyboard node movement and the narrow scrollable canvas were visually checked.

All 2,266 platform tests and nine simulator tests pass, including duration
validation, entity/snapshot revision conflicts and sample provisioning preserving
later edits. Portal production build passes. The same unrelated harness fixture
test-type errors remain. Named scenario saves, persistent canvas layout, equipment
reassignment, editable dependencies and physical timing calibration remain pending.

Named scenario-copy progress, 2026-09-08: workspace admins can save the displayed
procedure inputs with a required name and timing/calibration note. The existing
entity plane stores typed `bakery_scenario` attributes and a procedure relationship.
The shared compiler and settings boundary now live in the existing entity client
package; the scheduler stays in the browser. Loading by entity ID recomputes both
runs only when the source fingerprint matches. There is no historical replay or
automatic substitution of current workflow revisions.

Authenticated local save and readback succeeded for “Financier baseline — assumed
timings”, ID `scenario-ac9faeb6-fe7c-474b-8b6a-040664f41245`, at merchant snapshot 182. The displayed bake remains 15 minutes. A real entity-service test covers an
interruption between entity and relationship creation, idempotent completion,
unchanged run inputs after reload, and fingerprint invalidation after a duration
edit. Scenario backlinks do not invalidate the source fingerprint. Nine simulator
tests, 2,267 platform tests, platform/shared-client/portal types and the portal
production build pass. Broader platform test types still report the unrelated
`readMerchantReport` harness fixtures.

The Mac locked before the second-tab visual check; cross-tab UI verification
and a visual stale-copy rejection remain to be completed after unlock. No
production deployment occurred. Copy names/notes and interrupted-save IDs remain
in page memory until a save completes; drafts are not recoverable after closing
the page. Next: verify that second-tab path, then add a named scenario picker and
editable staffing/outage assumptions that retain the procedure source. Equipment
assignment, dependency editing, persistent canvas layout and real timing
calibration remain separate increments.

### Reference equipment and timing basis

Current visual reference, 21 September: the portal uses the articulated
[Maruzen MBCO-5E](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/maruzen-mbco-5e/README.md) from Plan 42B. The
financier defaults still assume four usable oven trays; saved entity/scenario
capacity remains authoritative for scheduling. Asset replacement did not
calibrate timings or change capacity. The UNOX reference below records the
origin of the earlier four-tray planning assumptions.

Provisional oven reference: **UNOX BAKERLUX SHOP.Pro TOUCH XEFR-04EU-ETDV**.
The [manufacturer specification](https://partnerhub.unox.com/data/spec_sheet/XEFR-04EU-ETDV-SPC_en_Electric_2023-12.pdf)
lists four 600 × 400 mm trays, 75 mm pitch, an 800 × 811 × 500 mm body,
57 kg weight, 6.9 kW electrical power, and two fan speeds. This is a planning
reference; confirm regional availability, voltage, service, water, ventilation,
clearances and a demonstration using the intended moulds before ordering.
The earlier generic four-tray GLB has been replaced in the portal. Neither
visual asset establishes a certified installation drawing or calibrated mechanics.

For the initial editable scenario, assume two trays per batch and 24 pieces per
tray (48 financiers). This yield is a placeholder until mould cavities and
layout are selected. A four-tray cycle can then hold two batches / 96 pieces;
that arithmetic is capacity, not a throughput promise. Start with an eight-tray
cooling rack so the operator can compare it with a restrictive two-tray rack.

Current provisional defaults (26 September 2026): two workers, stage prepared
batter 2 minutes, portion moulds 6 minutes, bake 16 minutes, cool in moulds 5
minutes, demould 3 minutes, cool before packing 20 minutes and pack 8 minutes.
Oven load and unload each take 60 seconds per batch plus travel; the loading
window is 2 minutes. These remain unmeasured. The one-bench scheduler completes
the sample at 07:43:18. The two-bench worksheet is a different planning layout.
See [the worksheet](plan-42-calibration-worksheet.md) and
[acceptance evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-operating-defaults.md), including saved
schema revisions and the requirement for fresh workflow-bound native evidence.
The [Valrhona chocolate financier recipe](https://www.valrhona.com/en/inspiring-you/recipes/all-our-recipes/tonka-flavored-financier-sponges)
uses refrigerated resting followed by a 170°C fan-assisted, 15-minute bake.
It supports a trial starting point for that recipe, not a validated setting for
plain financiers or this equipment. Temperature is recipe context, with no
thermal physics or doneness prediction in this scheduler.

Calibration remains an explicit open gate: record recipe, portion mass, mould
material/cavities, oven program, actual tray load and timestamps for at least
three representative cycles. Measure active labor separately from elapsed
cooling/resting, including demoulding and walking. Compare predicted versus
observed cycle and packed-batch completion, retain the deviations and revise
the saved input. Do not certify food safety, shelf life or product quality from
simulation output.

### Shared-save implementation boundary

Reuse the entity plane for canonical workflow/equipment identities,
relationships and revisions. The earlier proposal for an independent
`workflow-scenarios` D1 table is withdrawn before implementation. Do not create
a second workflow store, generic document service or collaboration framework.
Save inputs and provenance notes; regenerate results on load.

- First map financier workflow/equipment/scenario fields to existing typed
  custom-entity and relationship capabilities. Record any precise contract
  extension needed here before changing the shared contracts. Do not hide
  an unvalidated graph in a string attribute to bypass the entity model.
- Use the existing organisation/merchant binding, entity-plane command authority,
  expected revisions and mutation receipts. Canvas, timeline and inspector edits
  use one mutation path; all views read the resulting definition and run state.
- Pin workflow and referenced resource revisions and validate the resolved
  snapshot before scheduling. Preserve stable entity references in every
  generated operation/transfer so either view can explain or select it.
- Keep persistence and request parsing at boundaries; no Worker imports from
  app source and no duplicated setting validators.
- UI: named scenario picker, new/save-copy/update actions, unsaved-change
  warning, saved revision and workspace scope. Disable mutations for readers.
  Failed loads/saves and revision conflicts preserve current work. Selection
  changes must not discard edited inputs without confirmation.
- Any necessary persistence extension follows the owning runtime's existing
  schema patterns. Never reset existing local workspace data. Production
  schema application and deployment require a later authorized deployment.

### Delivery order and verification

#### Bounded sample provisioning

Add an admin-only, CSRF-protected `commerce/bakery/sample` control mutation.
It uses the existing entity-plane command client and receipt boundary to create
and publish three custom entity types and three relationship definitions, then
create the financier procedure, seven operations, five equipment objects and
seventeen relationships described above. These are merchant-scoped shared
records; the action grants no permissions and creates no production batches.

Use fixed, versioned command IDs for this one sample. Repeating the action
replays accepted creates, so it neither duplicates objects nor restores old
values over later edits. After interruption, resume remaining commands using
the greater of the initial merchant revision and each receipt revision: replay
receipts describe their original revision. Concurrent changes can reject the
next command; expose a retryable failure and preserve the current simulation.
An existing identity with different content is a conflict, never overwritten.
The sequence is intentionally non-atomic; only a complete graph passes the
existing compiler. No new entity service, database table or publication protocol
is needed. A portal admin action creates the sample and reads it back through
the existing graph API. Reader access remains read-only. Canvas editing and
scenario persistence follow this demonstrated saved-record path.

#### First canvas authoring slice

Expose the six compiled operation entities as connected, selectable canvas
nodes. Dragging or keyboard-moving nodes changes only temporary presentation
coordinates; it never changes operation order or physical equipment placement.
Keep the same ordered connections and equipment references visible. Selecting
an operation can seek its first processing interval in the 3D replay.

Initially edit one operation duration at a time. Persist it by patching that
`bakery_operation` through existing entity commands, with both the loaded
merchant snapshot and operation revision required. The control route is
admin-only, CSRF-protected and receipt-backed. Read the current entity through
the scoped merchant binding; preserve its operation kind and all other
attributes when replacing minutes. Reject stale snapshots, archived entities,
unsupported schema revisions and invalid durations. No new persistence schema
or general graph mutation endpoint is needed.

The editor keeps its draft on failed writes or conflicts. A successful write
reloads and recompiles the complete procedure, then replaces both runs together
and resets playback. If readback fails after saving, say that the save succeeded
and retain the old replay until an explicit reload. Switching operations or
loading another source prompts before discarding duration edits. Readers can
inspect nodes and replay them; mutation controls require an admin. Verify a
15 → 16 minute bake edit, reload in another tab, rejection of its stale edit,
and restoration to the provisional 15-minute sample value using a fresh revision.
Named scenarios, persistent canvas layout, new connections and equipment
reassignment remain explicit follow-on work.

#### Procedure-backed assumption editing

Implemented bounded increment: edit workers, shift length, and outage start/end while
retaining the compiled procedure's entity identities, revisions and fingerprint.
All other inputs remain fixed in this editor. A shared boundary accepts the four
editable fields, validates their bounds together, and constructs the new compiled
run source explicitly. It preserves procedure-owned durations and tray capacities
even if a caller submits replacements for those fields.

Run shift recalculates both variants locally. Save scenario copy persists the
applied inputs through the existing copy action; it must reject an unrun draft.
Keep assumption inputs controlled so an operation save/reload cannot erase a
concurrent assumption draft. Explicit source loads confirm before discarding it;
a discard action restores the displayed run inputs. Warn before closing a page
with an unrun draft. Broader in-app history/navigation coordination remains the
existing portal-level gap. Validate the unchanged identities/fingerprint, changed
staffing/outage results, invalid-input recovery and saved-copy round trip.

Verification, 2026-09-08: a direct run with two workers finishes at 07:07:06,
compared with 07:18:59 for the one-worker baseline. Its 06:20–06:45 outage run
finishes at 07:20:02. The procedure fingerprint and operation/equipment references
stay unchanged; submitted replacements for bake time, oven capacity and batch
count cannot alter them through this boundary. Tests verify saved input decoding
and recompilation reproduce both revised runs, invalid edits retain the original
source, and invalid result branches cannot expose a compiled procedure.
Ten simulator tests, 2,267 platform tests, portal/shared-client/platform types,
and the portal build pass. The Mac remains locked, so browser checks for the new
form's draft/discard behavior and cross-tab shared-copy loading remain pending.
This increment changes five files and adds no persistence or schema path.

#### Named scenario picker

Implemented a workspace-scoped browse/search form over the existing
`entity_type_page` and `search` graph queries for `bakery_scenario`. Read 25 entities
at a time with the returned opaque cursor. Show active revision-1 copies by name
and entity ID so duplicate names remain distinguishable. A result is a candidate;
its completeness and source fingerprint are checked only when it is loaded.
Use the existing scenario loader for both picker selections and pasted IDs.

Search and pagination must never alter the displayed replay. Keep an explicit
load action, retain the existing draft confirmation, and show empty/error states
with a way to search again. A cursor rejected after workspace changes should
invite a fresh search. Keep browsing read-only: no new list entity, schema, index,
server endpoint, or local scenario store. Browser verification remains blocked by
the locked Mac; validate listing/search through the real entity-service fixture.

Observed prerequisite: creating a second copy returns `duplicate_identity` because
the shared relationship cardinality checker constrains the target for
`many_to_one`, and the source for `one_to_many`. Correct these reversed checks:
many-to-one limits each source to one target; one-to-many limits each target to
one source. Preserve the published bakery relationship definition and existing
records. Keep this as a focused underlying fix, without schema migrations or a
bakery-specific workaround. Verify multiple scenario sources can reference one
procedure, then exercise picker pagination with duplicate names. This observed
shared prerequisite adds one implementation file beyond the five-file picker slice.
The existing one-to-many regression fixture also encoded the reversed endpoint;
update that fixture to reject two sources for one target and retain its no-effects
assertions. The picker slice and cardinality correction will be separate commits.

Cardinality correction verified, 2026-09-08: many scenario entities can now point
to the same procedure. One-to-many permits a source to reference another target,
and rejects a second source for an already-owned target without adding mutation
effects. All 177 Underclerk tests and 2,267 platform tests pass. The published
definition and existing records are unchanged; previously inconsistent data is
not rewritten automatically.

Picker verification, 2026-09-08: the real entity-service fixture lists and searches
saved scenario entities through the portal graph boundary. Twenty-six copies with
the same display name remain distinguishable by ID and paginate as 25 + 1 without
duplicates. A missing-name search is empty. A cursor becomes invalid after a
workspace mutation and requires a fresh search. The picker and pasted-ID form
call the same guarded scenario loader; browsing alone never replaces the replay.
Portal build/types and backend tests pass. The broader platform test-type check
still reports the unrelated harness fixtures missing `readMerchantReport`.
Visual, keyboard and cross-tab verification await Mac unlock; nothing is deployed.

Next gap: procedure reads still traverse a bounded 100-result graph, including
scenario backlinks before compilation filters them out. A sufficiently large
copy collection can exhaust that read budget. Scope the procedure read to its
workflow connections before claiming large-library replay support; retain complete
graph validation rather than silently accepting a truncated graph. Then proceed
with equipment assignment and dependency editing.

Implementation decision: reuse two existing bounded graph queries. First read
only procedure-membership relationships at depth one, requiring exactly six
operation members. Then traverse all relationships from those operation seeds
at depth one, which includes equipment, dependencies and membership without
following the procedure's scenario backlinks. Compile the second graph with
the existing strict compiler. Require matching merchant revisions across both
reads and reject a result at the read budget, since traversal truncation does
not currently emit a cursor. Share this reader between portal loading and
backend save validation. Prove saving and reloading with over 100 scenario
copies, retain malformed-graph rejection, and reject concurrent source reads.
This is confined to the shared reader, two callers, existing test and this plan.

Verified, 2026-09-08: the shared reader now serves portal procedure loading and
backend scenario-save validation. The real entity-service test saves 111 copies;
the old unscoped query fails on that dataset, while the bounded reader reproduces
the same source fingerprint, inputs and operations. A changed revision between
reads is rejected, and editing the bake duration still invalidates older copies.
All three bakery integration tests and ten simulator tests pass. Shared-client,
portal and direct platform TypeScript checks pass; the portal production build
passes with its existing chunk-size warning. The platform wrapper's Wasm
rebuild was blocked by sandbox permissions, so its direct TypeScript check was
run against existing generated bindings. `git diff --check` passes.

Authenticated browser evidence: started the stopped local commerce Workers on
3101/3102, then loaded `financier-finishing-sample` at snapshot 182. Browsing
returned the existing baseline. Changing Workers from one to two creates an
unrun draft; Discard restores one. Running with two workers finishes at 07:07:06.
Saved `Financier two-worker browser check` as
`scenario-46180869-fcd0-4a02-a85e-41c41a20a0e7` at snapshot 184, with an explicit
unmeasured-timings note. Name search found it. Switching to the local one-worker
sample and loading that result restored two workers and the same 07:07:06 finish.
The second-tab attempt was blocked by the browser client, so independent-tab
replay remains unchecked. The 111-copy dataset exists only in the test database;
one demonstration copy was added to the local acceptance workspace.

To see it: open Automation → Workflow simulator in the acceptance workspace.
Expand Shared scenario copies, search `two-worker`, and load the demonstration
copy. Expand Author procedure to inspect the shared operation canvas. Use Play
shift, Next event or the timeline to follow batches and machine states; switch
to Oven outage to compare delays. Edit shift assumptions → Workers → Run shift
recalculates locally; Save scenario copy persists a separate named input set.

#### Scenario-copy persistence contract

The current planned graph reader rejects older merchant watermarks; it is not
a historical snapshot API. First implement immutable named scenario copies:
save the validated shift inputs and a required calibration note, relate the
scenario to its procedure, and pin a SHA-256 fingerprint of the procedure,
operation, equipment and relationship revisions. Ignore scenario backlink
records in that fingerprint. Unrelated merchant changes do not stale a scenario;
changes to its actual workflow do. A stale scenario must refuse replay and
preserve the displayed run. Historical procedure replay and in-place scenario
updates remain follow-on work, without an automatic "use latest" fallback.

Use `bakery_scenario` custom entities with typed integer attributes for every
shift setting, a bounded timing note and source fingerprint. Use the typed
`bakery_scenario_procedure` relationship for the procedure reference. Never put
a graph or scene JSON blob in a text attribute. Extract the existing setting
definitions/parser and procedure compiler into the shared entity client package
so the browser and Worker validate the same bounds and workflow constraints. Keep the scheduler
browser-local. This is a cross-runtime change; no new package, service or table.

Save-copy creates one entity and one relationship using stable per-copy command
IDs. Retry can finish the relationship after an interrupted write; only copies
with one valid procedure link can load. Publish the narrow schema through the
same existing command path. Before saving, read and fingerprint the source
graph and reject a mismatch. Record the whole sequence through the control
mutation receipt boundary. The graph compiler ignores the known scenario
backlink while retaining its strict checks on workflow connections.

UI: required name/note, save a copy of the currently displayed run inputs,
and load a copy by entity ID. The saved ID is shown for another workspace member
or tab to load. The named searchable picker and bounded procedure-backed
assumption editor are described above.
On load, use the saved integer inputs and the matching current procedure to
recompute both runs, without changing any workflow or equipment records.
Verify save → second-tab load gives the same run, malformed inputs fail, a source
edit makes the copy stale, and an unrelated scenario save does not stale it.

1. Finish the financier/tray-cycle model and demonstrate one full shared bake
   and a rack-induced unload queue in the current portal. Keep edits confined
   to the existing feature where possible.
2. Map and implement the shared entity-backed workflow/input contract and its
   scheduler adapter, then connect workspace saves through existing commands.
   Keep the contract in its existing owners and avoid a parallel scenario
   service or unrelated refactor.
3. Add the bounded canvas projection over those same workflow objects.
   Demonstrate selecting the same operation in both views, changing an oven
   assignment once, and seeing consistent schedule/scene results. Demonstrate
   create → reload → edit → save from the authenticated workspace, plus a
   two-tab revision conflict. Add the focused behavioral and type checks
   justified by these paths. Run platform types/tests and portal build.
4. Record results and remaining calibration gaps here, then make focused local
   commits. Do not claim completed timing validation, production deployment,
   mixed-recipe scheduling or live equipment control.

Implementation status: financier finishing-shift simulation and shared oven
cycles, entity-backed definitions and bounded canvas duration editing are
implemented locally. Shared named scenarios, bounded assumptions and the named
picker are also implemented. Equipment reassignment and physical timing
calibration remain pending; see the current completion summary above.

#### Financier increment evidence — 2026-09-08

- Editable tray load/yield, four-tray oven capacity, fill window and separate
  oven handling times. Explicit attended demoulding retains rack capacity.
- Default normal cycle 1: A+B, four trays, 06:19:08–06:34:08; cycle 2: C,
  06:37:08–06:52:08. All batches finish by 07:18:59. These are predictions from
  unmeasured inputs, not operating targets.
- Authenticated CafeOS demonstration: changing rack capacity from eight trays
  to two delays cycle 2 to 06:54:42; the timeline explains B waiting in the
  oven for rack space. All batches then finish by 07:29:54. Browser error log
  was empty during the check.
- Seven focused tests pass, including the 108 resource configurations and
  shared-cycle checks across tray loads 1–4 and loading windows 0/10/30 minutes.
  Checks cover worker exclusivity, rack/oven reservations, identical shared
  bake intervals, demoulding, doors closed during baking, unloading barriers,
  outages and horizon outcomes. Portal type checking and production build pass
  with the existing large-chunk warning.
- No entity schemas, cloud records, production data or live equipment were
  changed. The current form remains explicitly temporary until the entity-backed
  canvas/save slice replaces its in-memory ownership.

### Progress — 2026-09-08

The native feature now lives in `apps/portal/src/features/workflow-simulator/`
and is registered under Automation → Workflow simulator. It includes a pure
TypeScript scheduler, validated settings, worker assignments, cooling-rack tray
capacity, station reservations, explicit shift-end outcomes, and an outage
comparison. The lazy-loaded Three.js scene bundles the existing GLBs and replays
machine states, transfers and door poses from simulated time.

The portal build and six behavioral tests pass, including 108 resource
configurations. The real component has been exercised in the CafeOS shell's
development preview: queue inspection, event stepping, oven-door opening and
closing, playback, and input validation. Authenticated verification in the
Seams sandbox / Square acceptance workspace now also passes: direct route
loading, keyboard sidebar navigation, form-error focus and accessible names,
two-worker/four-tray recalculation, horizon outcomes, playback, outage selection,
and leaving/returning with default settings restored. No browser errors were
reported during those checks. Use
`https://localhost:3003` for sign-in; port 3103 is the internal Vite endpoint.

The final production build passed with the existing large-chunk warning
(the lazy-loaded Three.js scene is approximately 597 kB before compression).
WebGL-disabled fallback and a full screen-reader audit remain unverified.
This evidence applies to the bounded cookie-shift increment, not every release
milestone below. No production deployment or live equipment control occurred.

This increment retains the cookie recipe and fixed layout (1–6 batches,
1–3 workers). General recipe authoring, multiple ovens, JSON import/export,
shared oven cycles and persistence remain outside this implementation.

Verification: `node --experimental-strip-types --test
apps/portal/src/features/workflow-simulator/schedule.test.mjs`,
`pnpm --filter satyr-portal exec tsc --noEmit`, and `pnpm portal:build`.

#### Earlier local integration study

`output/bakery-assets/simulator.html` now demonstrates a cookie-production
shift using the generated equipment library. Its deterministic JavaScript
schedule covers worker contention, station reservations, transfers, queues and
an oven-outage comparison, with a shared 3D scene and seekable timeline. The
local editor supports 1–3 batches, 1–2 workers and five recipe timings. Changes
recalculate both comparisons and reset playback; there is no saved scenario.
Scheduling checks exercise 36 configurations, resource exclusivity and input
limits. The oven still reserves one entire batch at a time.
The study informed the native portal increment above. General scenario
authoring, shared oven cycles and persistence remain future work. Validate
recipe timings and layout with operators before using outcomes for planning.

Date: 2026-09-08 · Owner: CafeOS
Related: [Plan 24](./plan-24-cafeos-bakery-automation.md),
[Plan 21](./plan-21-cafeos-ux-foundation.md),
[Plan 22](./plan-22-commerce-capabilities-and-storefront-demos.md),
[design system](./style-guide.md)

## Product outcome

Play through tomorrow's production before the shift begins. An operator loads
a bakery scenario, runs its batches through constrained stations, sees queues
and late orders emerge, changes one assumption, and compares the result.

The product combines a workflow canvas, resource timeline and Three.js bakery
over one orchestration run, with a shared inspector. Time, capability, capacity
and dependencies determine the simulation. Geometry makes those relationships
visible. O1–O4 deliver shared task orchestration; Plan 42B M3 attaches recorded
workcell execution to that run. Label assumed durations and recorded simulation
evidence distinctly. Plan 24 owns physical observations and execution.

## First complete user journey

1. Open **BakeryOS → Production** in the existing CafeOS workspace shell.
2. Replay the human-operated financier shift through the shared canvas,
   resource timeline and bakery. Inspect named allocations and one wait.
3. Select the bounded cold-tray workcell scenario using the same run/view model.
   Inspect its fixed FR10 assignment, source table, tray and destination rack.
4. Start its task, export the exact pending request, run the existing native CLI
   and import its recording. Show awaiting evidence until validated settlement.
5. Select that task in any view. Seek through pickup, transfer and placement;
   task state, resource occupancy and recorded robot/tray poses agree on time.
6. Run the failure case with a new attempt. Show the blocked dependent work and
   explicit tray uncertainty; replaying the evidence never repairs it.
7. In O3, change a supported assignment/timing constraint, compare a new run,
   and save its inputs. On reload, disclose required local evidence separately.

Repeated transfers and financier integration require M3's state-continuity and
handoff-compatibility checks. The existing standalone Physics replay remains
available for inspecting arbitrary valid local recordings.

The operator must be able to explain one delay and demonstrate one useful
change through this journey. A scene with decorative batch movement does not
satisfy the exit gate.

## Release scope

| Include through O1–O4                                                | Defer                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| One site, fixed layout and bounded financier shift                   | Multi-site orchestration, CAD import and floor-layout editing       |
| Named humans and bounded fixed FR10 workcell, explicit handoffs      | Mobile transport robots, navigation and arbitrary manipulation      |
| Capability/capacity checks, shared oven cycles and rack queues       | Optimization solver, demand forecasting and inventory accounting    |
| Canvas authoring, resource/batch timeline, 3D and Plan 42B evidence  | Unrestricted graph authoring, mid-run branching and general physics |
| Deterministic completion/fault events and dispatch eligibility       | Physical robot enrollment, commands and receipts: Plan 24           |
| Workspace-shared definitions, named scenarios and saved presentation | JSON import/export, live order import and concurrent canvas editing |

Display **Simulation · Assumed timings** for the financier model and identify
attached **Recorded simulation · Uncalibrated** evidence. The sample bakery and
its dimensions are illustrative until replaced by measured inputs. Simulated
completion never changes commerce orders, inventory, Cases, or task receipts.
Plan 24 retains ownership of physical automation and its authority boundaries.

## Working surface

Use the existing portal shell, route descriptors, tokens, and shared controls.
Use the existing `workflow-simulator` route exposed as BakeryOS → Production
through the established descriptor and page ownership path.

- **Toolbar:** scenario name, run revision, run action, shared playback controls
  and Workflow/Timeline/Bakery view selection.
- **Workflow:** connected recipe operations with task state, dependencies,
  resource assignments and inspectable transfer/handling tasks.
- **Timeline:** one lane per resource by default, with optional batch grouping;
  show processing, transfer, shared-cycle occupancy, queues and faults.
- **Bakery:** cutaway scene with selectable equipment, robots, humans and
  batches; retain the floor-plan camera and labels on selection.
- **Inspector:** the selected task/resource/batch, requirements, allocations,
  source identity, wait/fault evidence and projected completion.
- **Scenario editor:** equivalent form controls for drag operations, explicit
  earliest-start constraints, durations, compatible assignments and outages.
- **Comparison:** baseline and candidate completion times, late-batch count,
  and waiting time by constrained station. All values derive from run events.

An edited scenario requires a new run. Retain the baseline as an immutable
input/result pair; never relabel an old result with new input values. Comparison
always reruns from shift start. Mid-shift branching is deferred.

All selections and actions have ordinary DOM controls. The station list and
timeline remain usable without WebGL and through the keyboard. On narrow
screens, stack the timeline and inspector. Honor reduced motion and provide
text labels alongside color. Synthetic playback uses a simulation clock, never
a misleading live indicator.

## Simulation model

Keep engine/run types in `apps/portal/src/features/workflow-simulator/` and
extend the existing shared bakery input/compiler contracts in
`packages/bakery-model/src/`.
Existing commerce contracts remain authoritative for real production batches;
simulation entities have their own identities and cannot masquerade as those
records. Extract a shared package only when another runtime actually consumes it.

| Concept         | Required information                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Scenario        | Schema version, identity, source revisions, shift duration, resources, batches, constraints, outages  |
| Station         | Identity, operation capabilities, tray capacity, position, handoff node                               |
| Worker          | Identity, operation capabilities, availability intervals                                              |
| Fixed arm       | Identity, capability, pinned workcell/tool, reachable handoffs, availability and exclusive allocation |
| Route           | Identity, endpoint nodes, polyline in meters, length derived from geometry                            |
| Batch           | Identity, product label, output quantity, tray load, release time, deadline, ordered steps            |
| Processing step | Identity, operation, compatible station IDs, duration, tray demand, explicit labor requirement        |
| Transfer step   | Identity, route, duration inputs, explicit human/robot carrier requirement                            |
| Outage          | Station identity, start, end                                                                          |
| Task instance   | Run/batch/source identity, capability requirements, dependency IDs, allocations and lifecycle         |
| Run result      | Identity, exact input snapshot, ordered task/resource events and terminal disposition                 |

Use integer simulated seconds relative to shift start and meters in a documented
site frame (X/Z floor, Y up). Product output quantity and tray demand are distinct
units. Step times apply to the whole specified batch; changing quantity does
not silently scale duration or split batches.

Model executor requirement as `unattended` or `attended` with required
capabilities. An attended task holds its compatible human/robot allocation for
its full duration. Represent loading, unattended baking and unloading as
separate task instances; distinguish cooling from attended demoulding. Resource
reservations and task allocations retain their explicit, different lifetimes.

Use the task lifecycle defined above. A running simulated task requires its
start, planned completion and allocations; completed work requires completion
evidence from its execution source. Failed/indeterminate branches carry their
settlement or uncertainty explicitly. Reject incompatible fields with `never`.
Use exhaustive switches and the existing `assertNever` pattern.

Parse entity snapshots and UI drafts at their respective boundaries into
validated scenario values. Reject duplicate/dangling IDs, invalid units,
nonpositive durations/capacities, impossible tray loads, invalid availability,
unsupported versions, and routes disconnected from the specified handoffs.
Use Result-style errors with field context. Core simulation consumes validated
inputs and returns explicit outcomes, with no domain casts or optional identity.

## Deterministic execution

Extend the existing discrete-event engine as pure TypeScript, independent of
React, Three.js, rendering frame rate and wall-clock time. Compute and step the
same orchestration transitions, then replay the resulting event sequence.

1. At each event time, settle completion/failure observations and their
   allocations, apply availability changes, and admit newly released batches.
2. Order eligible steps by batch deadline, then release time, batch ID, and step
   ID. Choose compatible resources by stable ID. This is the documented
   scheduling heuristic; the UI makes no claim of an optimal schedule.
3. Start work only when all required resources are available. Allocate them
   together; waiting work holds no partial allocations. Reserve destination
   capacity before starting a transfer. A batch continues occupying its source
   station until pickup and occupies destination capacity through the next
   processing step and any wait for onward transfer.
4. Preserve the current shared oven cycles: gather whole compatible batches
   within tray capacity and the loading window, bake together, then unload all
   members before admitting a new cycle. Racks hold several batches within tray
   capacity. Mixed bake programs, cleaning and setup are outside this template.
5. Emit step and transfer starts/completions, allocation changes, and waiting
   reason changes. Advance to the next event until all batches finish or the
   shift horizon is reached. No future event with unfinished work produces a
   blocked result with unmet requirements instead of an endless loop.

An availability outage prevents new work from starting. Preserve and label the
existing oven-outage assumption that a running bake completes. An injected task
failure is a distinct event: it prevents assumed completion and follows O1's
failure/uncertainty settlement, verified by O4. Interrupting a bake, scrapping output and
restarting a batch require product-specific rules and remain deferred. Future
outage windows are not anticipated by the baseline scheduler.

At identical timestamps, completion precedes outage application, which precedes
new scheduling. Intervals are half-open. Log a deterministic sequence number
for ties. Playback speed and seeking cannot change the schedule.

Transfers use authored routes and distance/speed plus explicit pickup/dropoff
time. A simulated carrier holds one task at a time. Track its location and
include empty travel to pickup; a disconnected pickup is blocked. Congestion,
collision avoidance, manipulation, and robot safety are outside this model.
The scene interpolates position along the recorded route and interval.

Each run records whether all work completed, the horizon was reached with
unfinished work, or work was blocked. Report unfinished batches separately from
completed late batches. Explain waiting using resource requirements; summary
diagnostics never drive engine decisions.

## Implementation ownership

Reuse the existing React/Vite/Three.js feature and the ownership table above.
`schedule.ts` owns simulation; `simulator-state.ts` owns screen/run projections;
`workspace-commands.ts` owns command coordination; `canvas.tsx`, `timeline.tsx`
and `scene.ts` own the views. Retain the playback and scene lifetime controllers
introduced by [Refactor 3](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-3.md). Extend these responsibilities
directly; no replacement scene framework or parallel simulation module is needed.

Keep functions standalone, reuse existing helpers, and split a module only when
its responsibilities become difficult to read. Wire the feature through
`apps/portal/src/route.ts` and the current portal page controller. Lazy-load the
feature so ordinary commerce pages do not load the 3D bundle.

Use the existing equipment assets and representative geometry for people and the
robot. Model dimensions come from the same layout used by route lengths.
Use an orthographic camera, OrbitControls, and a top-down preset. Keep UI text
in HTML. Stop animation when paused unless the camera changes; cap pixel ratio
and reuse geometry/materials. Dispose scene resources and controls on unmount,
including React development remounts. See the official
[Three.js cleanup guidance](https://threejs.org/manual/en/cleanup.html) and
[Three.js documentation](https://threejs.org/docs/).

Run in the browser with the existing validated financier scenario bounds.
Document any necessary bound change in the shared input contract and benchmark
the largest supported scenario. If a run blocks interaction for more than
100 ms on the recorded reference machine, move the existing pure engine into
a Web Worker; introduce no backend simulation service.

Persistence uses workspace-shared scenario entities and validated inputs.
Production and rehearsal JSON import/export is complete under Plan 42E.
Standalone Shift-scenario JSON import/export remains deferred. Unsaved drafts remain
in page memory; saved copies survive navigation. There is no hidden local-storage
persistence or credential-bearing scenario data.

## MVP delivery record — 2026-09-08

These checklists record the original delivery and later verified completions.
The current status ledger above distinguishes completed implementation, deferred
features and unverified acceptance. O1–O4 are complete for the bounded scope.

### S1 — Run one shift end to end

- [x] Create validated scenario types and the sample financier bakery.
- [x] Implement release, sequential processing, capacity, labor, transfers,
      deterministic scheduling, and terminal outcomes.
- [x] Expose the native portal simulator with Run shift and batch/event details.
- [x] Demonstrate the complete sample shift once, including a visible queue.

Exit: every completed batch has an explainable start-to-finish path, resource
capacity is respected, and the result is independent of animation.

### S2 — Make the shift spatial and inspectable

- [x] Add Three.js layout, station selection, batch markers, and transfers.
- [x] Add timeline, synchronized selection, inspector, playback, event stepping,
      seeking, and floor-plan camera.
- [x] Verify the same state at the same cursor time across all views.
- [x] Provide DOM controls and details alongside the scene; verify base canvas
      keyboard movement.
- [x] Verify keyboard phase jumps and bounded rehearsal controls, including
      narrow layout and reduced motion; exercise the context-loss fallback.
- [x] Verify initial WebGL-disabled startup, keyboard seek/timeline and file
      controls across rehearsal and multi-tray at 390px. See
      [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).

Exit: an operator can locate a batch, identify its wait, and replay its transfer.

### S3 — Compare a changed shift

- [x] Add named scenario copies and bounded procedure-backed assumption editing.
- [x] Add outage handling and baseline/candidate comparison.
- [x] Model human worker transfers with location-aware travel.
- [x] Demonstrate outage delay and the effect of staffing/rack-capacity changes.
- [x] Add production/rehearsal JSON import/export with review and exact reopen.
      See [file acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-scenario-files-2026-10-01.md).
      Standalone Shift-scenario JSON parity remains deferred.
- [x] Add simulated robot transfers with explicit handoffs through the accepted
      FR10 cold-cell scope. Plan 42F also verifies two cells and a human transfer;
      a mobile carrier is outside that scope. See [42F](plan-42F-general-orchestration.md).

Exit: the candidate and baseline remain independently reproducible and their
differences can be explained through recorded events.

### S3b — Share workflow objects and scenarios

- [x] Compile shared procedure, operation and equipment entities into both views.
- [x] Provision the sample procedure through existing authorized entity commands.
- [x] Save operation durations from the canvas with stale-revision protection;
      demonstrate authenticated readback and a two-tab conflict.
- [x] Save immutable named scenario copies with required timing notes and source
      fingerprints; recover an interrupted entity/link save using stable commands.
- [x] Edit staffing, horizon and outage assumptions while retaining source identity.
- [x] Browse/search saved copies with pagination and distinct accessible labels.
- [x] Verify 26 copies across two pages through the real entity service; correct
      relationship cardinality enforcement for shared procedure references.
- [x] Verify assumption drafts/Discard, named search, save and same-tab copy replay
      in the authenticated browser.
- [x] Verify an unpublished-type empty catalogue, signed-in save/full reload/open,
      and a missing scenario ID preserving the current run.
- [x] Verify production-scenario browser pagination, failed-page retry, Previous
      and stale-copy preservation; rehearsal catalogue checks are recorded separately.
- Deferred: cross-member scenario-copy walkthrough and collaborative authoring.
- [x] Remove scenario backlinks from the bounded procedure-read traversal.
- [x] Add supported assignment and dependency editing in the workflow workspace.
      The canvas edits the Bake oven assignment; production authoring edits
      task assignments and prerequisites. See [oven assignment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-oven-reassignment.md)
      and [cross-operation authoring](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-cross-operation-authoring.md).
      The separate live oven-editor walkthrough above remains unverified.
- [x] Persist bounded canvas presentation coordinates on scenario copies without
      changing the executable definition fingerprint.

### S4 — Validate usefulness and finish

- [x] After the working demonstration, add targeted behavioral coverage for
      resource contention, shared cycles, outage ordering, horizon results and replay.
- [x] Add narrow type fixtures for invalid lifecycle combinations, direct
      construction, and broad spreads; inspect boundary code for unsafe casts.
      See `workcell-input.type-fixtures.ts` and `schedule.type-fixtures.ts` in
      `packages/production-simulation/src/recipes/bakery/`. The Portal integration
      fixture `workcell-attempt.type-fixtures.ts` remains in
      `apps/portal/src/features/workflow-simulator/`. Also see
      [task-chain acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-task-chains.md).
- [x] Run portal type/build checks and the focused engine tests using the
      existing repository test tooling. Run `git diff --check`.
- [x] Check bounded rehearsal keyboard operation, reduced motion, narrow layout
      and the WebGL context-loss fallback handler.
- [x] Verify initial WebGL failure, multi-tray remount and representative local
      scene/frame/interaction measurements. See
      [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).
- [ ] Observe one actual production sequence and compare assumed timings with
      measured timings. Record errors and update the scenario assumptions.

Exit: record the scenario, result, browser demonstration, reference machine,
performance measurements, and operator feedback in a concise evidence note.
If actual bakery measurements are unavailable, call the release a demo and
leave operational calibration explicitly incomplete.

## Completion and next decision

### Canvas workspace increment

#### MVP observability and scenario usability

- [x] Show machine batches, oven tray reservations and active bake countdown using the deterministic run.
- [x] Surface batch count, workers, oven capacity, baking and outage timings as common inputs. Shared procedure fields retain their existing read-only constraints.
- [x] Expose a Scenarios dock with named browsing, save form, and explicit workspace-sample setup; keep entity IDs under advanced controls.
- [x] Highlight the equipment used by the selected batch and expose procedure steps in the equipment inspector.
- [x] Verify edit/replay/outage comparison and named rehearsal save/reopen in the
      signed-in dashboard; verify production-scenario edit/save/full reload/open.
      Verify bounded keyboard and narrow-screen controls. See the
      [single-operator](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-single-operator-mvp.md) and
      [guided MVP](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-guided-mvp.md) evidence.
- [x] Accept a local measured-shift JSON with oven/mould, recipe, worker, tray,
      mass and timestamp provenance. Preview observed process durations and
      batch-finish errors, then stage rounded values in the sample input draft.
      Reject incomplete files without changing the run. See the
      [calibration intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md).
- [ ] Calibrate against one observed financier bake. Pending operator data:
      oven/mould identification, pieces per tray, portion mass, tray count,
      and timestamps for portioning, loading, baking, unloading, cooling,
      demoulding and packing. Keep assumptions labelled until supplied.

Reuse the existing procedure/scenario endpoints and revision checks. Workspace
sample setup is an explicit action that loads the shared sample; it must explain
that local experiment settings are replaced. No live machine control is added.

2026-09-09 verification: this checkout's portal runs on 3113 because ports
3103 and 3101 are owned by `/private/tmp/satyr-plan-40-drafting`. The real
Square acceptance workspace loads saved scenarios by name. A two-worker run
finishes at 07:07:06; its outage comparison adds 25m 12s. Active baking shows
batches A/B, 4/4 reserved trays and a decreasing countdown. Narrow-screen
scrolling and Escape dismissal work at 480px. All 11 simulator tests and direct
countdown/bake-end checks pass.

Historical blocker on 9 September: the backend on 3101 was from the older checkout
and its commerce router lacked the bakery scenario endpoint. No new scenario
was confirmed saved at that check.
This blocker was resolved for the signed-in Financier Factory / Cafe operations
workspace on 23 September; the guided MVP record documents the successful round trip.

#### Real dashboard handoff

- [x] Confirm the real workspace route uses the same simulator component with organisation permissions and shared scenario tools.
- [x] Verify navigation between the real simulator and another dashboard page.
- [x] Run the portal build and simulator checks, then commit the simulator changes on dev.

Verified the authenticated Square acceptance workspace: simulator → Commerce
overview (loaded account data) → simulator. Portal build and all 11 simulator
tests pass. The existing large-bundle warning remains.

Use `/portal/seams-sandbox/acceptance/workflow-simulator` for the working
dashboard. `workflow-preview.html` is an isolated development fixture and does
not implement the other dashboard pages.

#### Compact timeline contents

- [x] Reduce track heights and gaps, align the scrubber inline, and let the drawer fit its content within a bounded height.
- [x] Preserve larger touch rows and verify the desktop drawer visually.

Desktop preview verified: all three 28px batch rows and the outcome fit without
scrolling. Touch rows retain 44px height; the drawer scrolls when needed.

#### Direct canvas panning

- [x] Make primary-button dragging pan the bakery; preserve rotation on secondary-button drag and wheel zoom.
- [x] Keep clicks selecting equipment while camera drags do not select it.
- [x] Verify the camera gesture and run the portal type check.

Verified a 140px horizontal / 30px vertical drag translates the bakery without
opening Inspector or moving the floating controls. TypeScript passes.

#### Timeline exploration follow-up

- [x] Add a shift time ruler aligned to batch tracks and use operation names on bars.
- [x] Keep the drawer open when seeking to an interval; highlight the selected batch's current interval and describe it above the tracks.
- [x] Verify interval selection, playback and keyboard dismissal in the local preview, then check TypeScript.

Verified in the port 3103 preview: selecting Batch B's bake seeks to 06:19:08,
keeps the drawer open and updates the selected-step description. Playback
continues from that point; Escape closes the drawer and restores trigger focus.

#### Compact controls and bottom timeline drawer

- [x] Reduce simulator toolbar padding and control size, preserving the portal shell.
- [x] Move the existing production timeline into an expandable bottom playback drawer with a persistent disclosure control.
- [x] Verify expansion, collapse, seeking and keyboard dismissal; run portal checks.

Verified in the running portal on port 3103: expansion exposes the batch tracks,
arrow-key seeking updates simulated time, and Escape collapses the drawer and
restores focus to its trigger. Desktop controls are 32px; touch controls retain
44px targets. Portal TypeScript and build checks pass.

#### Main-content canvas boundary

- [x] Keep portal navigation and sidebar in the standard shell layout and
      respect the existing sidebar preference without automatically collapsing it.
- [x] Fill the main content area with Three.js; float only simulator controls
      and docks above that canvas, with no content margins around the scene.
- [x] Verify canvas bounds match main-content bounds with navigation expanded
      and collapsed, then run the portal build.

The earlier full-viewport implementation included portal chrome in the canvas
area. This correction restores that boundary to the main content area.
Verified at 1440×900: expanded sidebar gives canvas/main bounds (264, 60),
1176×840; icon rail gives (60, 60), 1380×840. Portal build and type checking
passed, with the existing bundle-size warning.

Replace the long report layout with one full-height bakery surface. Reuse the
existing procedure editor and simulation state; this adds no workflow engine or
window-management framework.

- [x] Add a compact scenario/outcome bar and persistent playback strip.
- [x] Put workflow/inputs in a collapsible left dock, selected-object details in
      a right dock, and timeline/comparison in a collapsible bottom dock.
- [x] Consolidate outage comparison into the comparison dock; move queues,
      cycle details, waits and assumptions into their relevant panels.
- [x] Remember dock preferences only, provide Reset view, and keep draft editors
      mounted while hidden. Preserve selection and time when changing panels.
- [x] On narrow screens open one dock at a time; verify keyboard close/focus,
      playback, comparison, field validation, and viewport layout.

This first docked version opens one panel at a time on every screen size, keeping
the bakery visible and panel state simple. Dock choice persists in browser
storage; simulation inputs and drafts retain their existing save semantics.
Navigation retains the standard portal behavior and sidebar preference.

Verified in the local preview on 2026-09-08: baseline/staffing comparison,
same-input outage comparison, invalid bake-duration focus, timeline-to-Batch-C
inspection, Escape focus restoration, live playback/pause, Reset view, and the
390px bottom-sheet layout. All 11 existing simulator tests, portal type/build
checks and diff whitespace checks passed. Shared-save mutation paths were not
rerun; the build retains its existing large-chunk warning.

The MVP keeps the step list as its workflow surface. The shared drag-and-drop
procedure editor stays available inside Workflow when a shared procedure is
loaded. The three-view workspace and authoring extensions now belong to O2–O3.

### MVP review follow-up — explain experiments

Keep this increment in existing view files and presentation helpers. The engine
and shared persistence contract remain unchanged.

- [x] Retain one replaceable baseline; show overall and per-batch finish changes,
      including regressions and unfinished/missing batches.
- [x] Preserve batch selection when seeking a workflow step.
- [x] Tighten scene framing; label stations, queues, batches and selection.
- [x] State per-batch lateness and link to recorded waits; clarify batch-minutes.
- [x] Merge adjacent identical waits for display, preserving engine events.

Verify normal versus two workers (11m53s earlier overall, Batch A 1m55s later),
Batch C → Baking, wait navigation, baseline replacement and narrow scene layout.
Run existing focused tests and portal type/build checks.

Verified 2026-09-08 in the local preview: two-worker overall/per-batch deltas,
Batch C baking at 06:33:29 without changing selection, baseline replacement and
reverse comparison, and Batch A wait navigation to 06:09:31. Inspected scene
labels at 390px width and restored the default viewport and paused morning run.
All 11 existing simulator tests, portal type check and production build passed.
Presentation checks confirmed merged wait durations and unchanged engine data.
The build retains its large-chunk warning. Shared saves and a full screen-reader
audit were outside this increment's verification scope.

At this 8 September checkpoint, the demo supported workspace-saved inputs,
reproducible runs against matching procedure revisions, coherent 3D/timeline
playback and a baseline-versus-outage comparison. The browser and performance
checks were pending then; the later
[integrated acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md) records their
results and current local targets. Operational calibration remains incomplete.

The accepted next investment is the O1–O4 orchestration workspace. Operational
calibration remains a separate evidence gate. Plan 24 owns live observation and
governed execution using the same task identities and views. Extend the existing
entity contracts as needed; this plan introduces no robot controller or new
deployment boundary.

## Equipment accuracy correction — 14 September 2026

The equipment archive exposes physical-fit and identity gaps in the simplified
GLBs. This increment corrects the highest-impact assets in the existing generator
and validation path. It does not add robot control or claim engineering-grade
kinematics. The portal already imports the oven and rack directly from this pack.

| Demonstrated gap                                                                                   | Correction                                                                                                                                                                                       | Verification                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Rack rail gap is 405 mm; a rotated 400 mm tray has no support                                      | Move the support ledges inward while retaining the trolley envelope and 16 levels; record the assumed internal rail layout                                                                       | Load the exported tray and rack, place trays at every level, check bilateral support, pitch and insertion clearance         |
| Oven asset identifies LED while the scenario selects TOUCH; solid shelves fill an oversized cavity | Match TOUCH controls, drop-down door and published tray pitch; distinguish body and complete closed envelope; bound the cavity using an appropriate drawing or an explicitly labelled assumption | Check reference, source-derived dimensions/hinge travel, four supported trays and unobstructed insertion with the door open |
| Ice machine is a generic refrigerator-shaped 500 × 600 × 850 mm cabinet                            | Model the selected Scotsman EC 47 family body and bin/service-panel arrangement; remove unsupported refrigerator-like shelves and side-door motion                                               | Check the archived drawing, body envelope, documented versus illustrative motion and valid animation export                 |
| Pitcher rinser is a 200 mm square prop for a 600 mm inset fixture                                  | Model RHPR600-S proportions, shallow tray, drain and actuator; distinguish below-counter depth from above-counter parts                                                                          | Check published plan dimensions and mounting-plane/drain depth; inspect the exported geometry                               |

- [x] Resolve the reference drawing details and record remaining assumptions.
- [x] Correct these four assets in `output/bakery-assets/generate.mjs`.
- [x] Add independent physical-fit and source-dimension regressions to asset validation.
- [x] Regenerate GLBs/catalog, verify all existing machine controls, and inspect the changed assets in Three.js.
- [x] Update equipment mappings and asset documentation, and verify the portal consumes the revised assets.

Verified: all 37 GLBs have zero validator errors/warnings; all 18 door clips and
machine-state controls pass. Exported trays have bilateral support and pass 25
insertion positions at each of four oven and 16 rack levels. All 29 portal
simulator tests and three local workflow tests pass. Portal TypeScript checking
and the Vite build pass, with the existing chunk-size/dynamic-import warnings.
The build consumes the updated oven and rack GLBs directly. Browser review of
the four assets confirms the oven opening, ice-bin retraction and active-state
cue, rack ledges and rinser proportions; the preview reports no browser errors.

Source distinctions retained: the oven body is 811 mm deep and its handle makes
the closed envelope 861 mm; the archived Scotsman sheet now gives 645 mm height;
the rinser's 85 mm depth is below the countertop. Exact TOUCH chamber dimensions,
rack internals, the ice-door trajectory and the rinser's 25 mm actuator projection
remain explicit approximations. These changes do not calibrate physical machinery.

Deferred: exact manufacturer robot models/URDF/MJCF and joint limits, complete
equipment-library replacement, calibrated bake timings, and premises/service
clearance validation. These require their own source evidence or physical trials.

## Supporting acceptance records

These dated records retain the evidence links from the consolidated handoff.
The [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) owns current status.

- [production release record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42C-production-release-2026-09-26.md)
- [save binding](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42C-save-boundary.md)
- [chat save acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42C-chat-run-save.md)
- [scenario save acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42C-scenario-save.md)
- [timeout acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-timeout-recovery.md)
- [The refactor evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-6-spatial-ownership.md)
- [F1a evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1a-browser-production.md)
- [F1b evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1b-rehearsal-chains.md)
- [F1c fault evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-rehearsal-faults.md)
- [F1c preset evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-presets.md)
- [F1c chat evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-chat-commands.md)
- [F1c rack dragging evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-tray-layout-drag.md)
- [F1d evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1d-retirement.md)
- [F2a evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f2a-instances.md)
- [acceptance and usage](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-authored-continuation.md)
- [Plan 42D acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42D-layout-experiments.md)
- [inspection closeout](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42D-inspection-closeout.md)
- [Agent-save acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42D-agent-saving.md)
- [host/device evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-host-device-validation.md)
- [Native acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-native-boundary.md)
- [combined fixture](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-combined-fixture.md)

## Information-flow contracts

Moved from the IFC integration guide
(`services/platform/src/policy/information-flow/README.md`) on 2026-10-19.
Code paths are under `services/platform/src/`, and test paths are under
`services/platform/tests/`. Record this plan's information-flow contracts here.
Change the guide only when the kernel, a sink, a rule for every surface or an
entry point changes.

Persistent bakery saves use the organisation-scoped run routes. Preparation binds
the exact candidate document and artifact index to the authenticated uploader.
Staged artifact reads require that principal's current admin access. A digest
alone grants no read access. Publication requires every referenced artifact and
the retained execution bundle. Published artifact reads require a referring
snapshot and current organisation membership. Routes recheck authority after
archive reads and before publication. These simulation artifacts carry no live
commerce authority. Agent-originated saves retain the existing reviewed-save
boundary. The `e2e/bakery-run-artifacts.test.ts` journey covers incomplete staging,
hash mismatch, immutable retry, private staging, publication, and revoked reads.

Linea and Eagle One rehearsal files reuse these organisation-scoped run routes as inline snapshots.
Their shared parser validates the machine identity, requests, action evidence, cup state and presets before storage.
A file labeled for another machine is refused. Machine filters grant no additional authority.
The appliance page's organisation query selects a scope and grants no authority.
Every save requires current admin access; reads require current viewer access.
A shared file passes Rust checkpoint inspection before it replaces the local run.
The `e2e/linea-shared-run.test.ts` journey covers immutable retry, viewer reads,
foreign refusal, viewer write refusal and revoked reads. These snapshots do not
create a canvas room or physical execution authority.

Workflow canvas routes require current organisation membership. The OrganisationActor loads
operation membership from the organisation's selected Underclerk procedure or a
validated appliance run in that organisation's saved-run archive. Saved-run canvas
identities use `run:<snapshot SHA-256>`. The loader verifies content integrity,
recipe membership, recorded actions and ingredient custody before room creation.
Saved-run sources recheck execution authority after the archive read. The saved
document contains only stable operation IDs and bounded positions. Snapshot
delivery rechecks membership after loading the source. Socket reads and writes
use the existing collaboration-room authorization checks. A recheck that cannot
run closes the socket without a final failure; the reconnect checks access
again before any sync, so nothing is sent to the socket in between. Moves check live edit
permission before reading an operation receipt or changing a position.
Canvas and text-room presence include temporary agent targets only for admitted mutations.
Each target carries the authenticated session, bounded operation identity, and
server-resolved agent name. Tool arguments cannot supply an agent name.
Independent operations retain independent presence entries, including while
accepted work waits for the room queue. Completion removes only its own entry.
The room rechecks execution authority before mutation and rechecks each observer
before publishing activity or presence. Completion and failure clear the target;
a disconnected client shows activity as unknown. Targets contain the canvas object ID or text field identifier. Pointer positions, names, and selections remain
room-authorized, temporary presence data and create no saved layout revision.
The `workflow_canvas_read` and `move_object` Tool Host adapters support procedure
and saved-run identities. Procedure reads admit the exact integration source.
Access grant creation accepts validated system or custom commerce record types.
A custom type grant remains scoped to that type in the selected merchant.
Role grants describe defined organisation audiences even when those roles
currently have no members. Each disclosure still requires current membership
and account eligibility. Person and automation grants retain their lifecycle checks.
It grants no unrelated type or automatic shared-canvas disclosure. All current
canvas readers must still pass the source label before an agent mutation.
Saved-run reads admit an organisation-record observation after checking the live
request authority, capability, source integrity and membership. Saved-run labels
name the organisation and the four organisation roles that can read the
archive. They require no merchant connection.

Persistent production files use the same organisation-scoped saved-run archive.
Saving requires current admin authority. Reading requires current membership.
Storage admits the bounded, versioned envelope and checks its content identity.
Portal checks engine state and artifact digests before it offers continuation.
Archive summaries expose metadata for these files. Unsupported task and recording
counts are null. A shared save or read does not start execution, update inventory,
or grant a persistent run access to the saved-appliance canvas tools.

A move checks the cumulative turn label against every organisation role that can view
the shared canvas. Private chat or source context cannot enter the room through
position changes. This also blocks direct edits from a private chat whose input
label is limited to that chat. Dedicated `workspace_canvas` chats admit requests
to the organisation-wide audience. Operators can submit requests; all current members
can read requests, replies and canvas actions. History and stream delivery check
current membership, source access and labels for all four organisation roles. Newly
joined viewers can read this shared history without execution grants. Private
chat approval mode remains deferred. No private history is copied into the
shared chat. Canvas tools resolve the admitted turn's canonical conversation and
reject document IDs outside its workspace canvas. This check precedes source
reads and mutations; prompt text does not define the tool's authority.

Each canvas has a current conversation and numbered earlier conversations.
Continuation preserves earlier history and requires an idle or failed current
conversation. Earlier conversations remain readable. Admission and persistence
reject writes to superseded conversations. Concurrent continuation requests
resolve to the same next conversation.

Settled chat refreshes compare a cursor containing the conversation revision and
current disclosure state. Membership and policy, grant, account and project
revisions are checked on every request. A matching cursor returns no content and
skips completed-history reconstruction. Running turns still pass full disclosure
checks. Chat history reads do not reload immutable simulation archives; source
validation remains at canvas creation and tool execution.

The move capability, current member, parent execution deadline and accepted
tool-call identity remain separate checks.

Workflow canvas and product-description draft tools admit the caller through the named commerce source grant.
Their new observations use `createCurrentObservedSourceFlowLabel` to retain all
current readers of that exact source. This uses the policy-owned grant matcher.
It does not replace or release any previously accepted turn restriction.
Canvas moves and draft edits require the cumulative turn label to allow every role that can
read the shared room, then pass the existing effect-sink check. A private source
therefore prevents publishing a position into the organisation-wide room. Portal
control callers also require a current matching user, person, and membership
role. Viewers cannot move objects or edit drafts. Draft edits retain the existing
explicit Slack-thread sharing path when the cumulative label requires it.
The native draft browser journey verifies both an allowed Portal edit and a
denied edit whose product source is private to the owner role.

Shared canvas chat derives its automatic context scope from the authenticated
turn audience. It assembles only the current Case's canonical conversation tail,
then admits the current chat input. It does not automatically retrieve other
workspace chats, files or Memory. Explicit tool reads still admit their complete
source labels. Current-conversation history retains every contributing restriction.
Other chat surfaces retain the workspace context search. The shared canvas E2E
seeds a retired chat and verifies that a fresh canvas
conversation excludes that source before the model reads it. Agent editing,
human intervention, peer updates and private-context denial remain covered.
Canvas reads include step labels from the same authorized source as object
membership. Saved appliance labels come from the validated run. The complete
read enters the accepted observation before the agent receives it.
