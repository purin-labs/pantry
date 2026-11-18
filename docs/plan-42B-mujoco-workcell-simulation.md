# Plan 42B — MuJoCo Bakery Workcell Simulation

Execution contract reviewed: **6 October 2026**. BakeryOS runs workflow physics
in the browser through the shared Rust/MuJoCo WebAssembly build. See the
[workflow execution contract](#workflow-execution-contract) below.

Status: the bounded native and single-operator acceptance tranche is closed.
M0–M2, cold-cycle orchestration and the Rust native boundary are implemented.
The combined oven→table→rack skill and bounded M3 integration are complete.
Plan 42F completes the accepted shared scheduler, two-cell and simulated human
handoff scope. Physical production handoffs and broader M4 acceptance remain open.
Multi-batch cold-proxy gates
share the financier scheduler. Existing manual/native tasks now support authored
cross-operation dependencies and exact workflow-bound attempts; see
[authoring and binding acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-cross-operation-authoring.md).
See
[production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-workcells.md) and the
[current acceptance status](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md).
Status reconciled: 2026-10-05. See the
[current status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md).

Browser MuJoCo is implemented and accepted for the bounded scope in
[Plan 42C](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-42C-chat-connection.md). Recording import remains an inspection
and evidence boundary. Native CLI runs support developer verification only.
Physical extensions and broader M4 gates
remain open; historical pending statements below do not reopen the completed
bounded integration.

Use the [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) for current
acceptance and remaining work. Dated implementation notes below retain their
original scope.

Native language migration is owned by [Refactor 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-5.md): TypeScript
retains orchestration and shared views; Rust takes over native controllers and
MuJoCo state. Native setup, execution, portal recordings, full-state handoffs
and the combined oven→table→rack fixture are implemented and verified. Python
may prepare offline assets. Historical Python lab results remain evidence of
those experiments; they do not define a supported workflow execution path.

## Workflow execution contract

This section defines the execution path for BakeryOS workflows, including new
equipment and recipe work in Plans 60A, 61A–E and 70. Extend this path.

| Responsibility | Execution location | Owner |
| --- | --- | --- |
| Workflow dependencies, scheduling, resource allocation and result acceptance | Browser TypeScript | Existing production scheduler and run state |
| Robot and supported appliance controllers, MuJoCo stepping and resumable state | WebAssembly in a dedicated browser Web Worker | Shared `crates/bakery-native` Rust code linked with MuJoCo |
| Workflow canvas, timeline and 3D inspection/playback | Browser UI; Three.js uses WebGL | Projections of the same run and accepted recordings |
| Authorization, chat effects and durable saves | Platform | Existing control and persistence boundaries |

A Web Worker executes separately from the UI thread. WebAssembly runs the compiled
Rust controller and MuJoCo on the client CPU. Three.js draws through WebGL.

1. The scheduler selects an eligible operation and binds its exact attempt.
2. The browser creates a worker and loads the integrity-checked Wasm module.
3. The worker writes a validated request into the module's in-memory filesystem.
4. It calls the compiled Rust command through Emscripten's `callMain` interface.
5. Rust advances MuJoCo and returns recorded observations and supported continuation state.
6. The browser validates the result against the attempt. The selected mode either
   presents it for review or accepts it through the existing scheduler boundary.
7. Three.js uses recorded joints and poses for playback. It interpolates between
   samples and converts physics coordinates into scene coordinates.

The current robot path returns a completed recording for playback. It does not
stream each physics step to the renderer. Viewing or importing a recording does
not execute physics or authorize physical hardware. Successor operations consume
validated continuation state where the supported controller provides it.

For the persistent factory, [Plan 70E](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70E-incremental-physics-and-faithful-playback.md)
plans bounded Rust stepping, disposable previews, accepted recording segments and
complete cell checkpoints. It replaces the final-only execution interface while
retaining this browser/Rust/Three.js ownership. These changes remain draft scope.

The [build script](../scripts/bakery-robots/build-browser.mjs) compiles the pinned
MuJoCo engine and Rust controller into a Wasm module with a separate preloaded
model-data file. It targets `wasm32-unknown-emscripten`. The JavaScript, Wasm and
data files form one [retained native bundle](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/bakery-browser-asset-bundles.md).
The
[job owner](../apps/portal/src/features/production-run/engine-jobs.ts)
keeps one engine worker for the page, reports the step and stops a job at a
step boundary. The
[engine worker](../apps/portal/src/features/production-run/execution-worker.ts)
loads the module one time and runs each job as a
[host program](../apps/portal/src/features/production-run/engine-programs.ts)
(Refactor 16, step 5). The
[production runner](../apps/portal/src/features/workflow-simulator/browser-production-run.ts)
accepts results and advances the workflow. The
[Three.js model](../apps/portal/src/features/workflow-simulator/spatial/physics-model.ts)
projects recorded motion into the scene.

### One workflow path

- Add controller behavior to the shared Rust implementation and its browser build.
  Reuse the existing request, result, continuation and acceptance boundaries.
- Do not add Python MuJoCo controllers, CLI recipe runners, separate workflow
  schedulers or native-viewer panels as product execution paths.
- Python and Blender may build assets or analyze recorded evidence offline.
  Historical Python labs do not establish browser workflow acceptance.
- NVIDIA and Google DeepMind provide MuJoCo Warp (Newton), which loads `MJCF`
  models directly into Isaac Lab. If we train camera-guided policies for physical
  robots in [Plan 24](plan-24-cafeos-bakery-automation.md) later, we can reuse our
  MuJoCo assets in Isaac offline without changing the browser execution runtime.
- The native Rust executable supports controller parity, diagnostics and recovery
  verification. It uses the same controller source and is not a second operator flow.
- New equipment requires browser integration and an E2E workflow artifact before
  it can be described as available in BakeryOS. Native lab success alone is insufficient.
- Plan 70's proposed headless host must reuse the shared scheduler and Rust
  controller contracts. It must not introduce another controller implementation.
  Headless execution remains draft scope; the current operator path uses the browser.

Dated lab and CLI reports below retain their original evidence scope. Their
commands are historical reproduction details, not current operator instructions.
The [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) tracks acceptance;
this contract does not mark pending equipment or recipe integration complete.

## Maruzen oven asset increment — 20 September 2026

Requested scope: create reusable MuJoCo assets for the MBCO-5E using the
[archived manufacturer references](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/maruzen-mbco-5e/README.md).
This is an independent model preparation increment; it does not complete the
robot transfer milestones below or replace the portal's current oven.

Gaps mapped before implementation:

| Gap                                                      | This increment                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official product photo has a different model badge       | Use published MBCO-5E dimensions and a visibly simplified series-inspired appearance; keep exact panel geometry unverified.                                                   |
| Door, hinge, handle and tray mechanical data are missing | Label mass allocation, inertia, travel and friction as simulation assumptions. Leave latch/seal mechanics and thermal behaviour unmodelled.                                   |
| Hollow visual meshes can block tray access in collision  | Build the chamber and rails from separate primitive shapes, with a separate free-body tray.                                                                                   |
| No oven asset or inspection experiment exists            | Add composable MJCF oven/tray files, a standalone scene and a bounded local viewer/demo using the existing pinned environment.                                                |
| No behavioural evidence for the oven exists              | Test published dimensions, five rail levels, stable contact support, open-door access, closed-door obstruction, dynamics and warning-free stepping; render closed/open views. |

- [x] Create the oven, articulated door/handle, five support levels and tray assets.
- [x] Document source dimensions, coordinate frames and every assumed mechanical parameter.
- [x] Add and run focused physics tests and an inspectable door-motion demo.
- [x] Inspect rendered closed/open views and record evidence/run instructions.

Delivered: [assets and viewer instructions](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/maruzen-mbco-5e/README.md),
with [verification evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-maruzen-oven-assets.md). Six new oven
tests and the six existing arm tests pass. The 12-second door cycle produces
no engine warnings. The assembled robot workcell and calibrated forces remain open.

No robot controller, automatic door-opening skill, button-pusher mechanism,
firmware emulation or hardware safety claim is included. Button/display details
are visual references with named interaction sites only.

### Visual rebuild — user review, 20 September 2026

The first visual pass was rejected. Its oversized control panel, broad exposed
glass, block-like framing and flat materials did not resemble the reference.
Physics regressions alone were insufficient for visual acceptance.

- [x] Separate detailed, non-colliding visual meshes from the existing tested
      collision primitives and rigid-body inertia.
- [x] Rebuild the ruby door surround, narrow rounded window, black ceramic mask,
      pinstripes, stainless trim, hinges, fasteners and feet from the reference.
- [x] Replace placeholder display blocks with a compact, labelled control panel;
      add recessed chamber lining, fan guard, shaped rails and side service details.
- [x] Render front, three-quarter and open-door views with neutral studio lighting,
      inspect against the source photo, and rerun the complete physics suite.

Exact-model source caveats and uncalibrated force assumptions still apply.

Implementation approach after Blender MCP setup:

1. Author one reproducible Blender scene in metres, with separate cabinet,
   door-pivot and handle-pivot objects matching the MJCF body frames. Preserve
   the existing collision shapes, mass allocation and passive joints.
2. Export bevelled, material-grouped OBJ visual meshes for MuJoCo and a GLB
   with the same articulated hierarchy for Three.js. Keep render lighting and
   cameras out of the GLB. Author panel markings ourselves; archived manufacturer
   photos remain references, never redistributed texture maps.
3. Hide contact proxies in the inspection viewer while retaining an explicit
   collision inspection mode. Verify exported mesh bounds and body-frame
   alignment, disabled visual contacts and unchanged dynamics.
4. Save the editable `.blend`, three studio views and native MuJoCo previews.
   Inspect the result in Blender through the working MCP connection without
   discarding the user's existing unsaved scene.

This increment delivers reviewable assets. Replacing the portal's oven,
calibrating forces and adding robot tray transfer are separate next steps.

Delivered: editable Blender scene, articulated Three.js GLB, body-local OBJ
visual meshes/MJCF includes, three studio renders and updated native MuJoCo
previews. All 13 Python and two Three.js tests pass; the door-cycle results are
unchanged. The oven was appended into the running Blender session through the
official MCP bridge as a separate review scene; the original Camera/Cube/Light
scene was preserved. The user's visual acceptance remains a review step.

### Exact-model photo correction — 20 September 2026

The user supplied a clear photograph bearing the MBCO-5E badge, a product photo
and an installation drawing. This resolves the exterior-reference ambiguity
for that photographed unit; it does not supply internal engineering CAD.

Gaps mapped before revising the assets:

| Observed mismatch                                         | Correction and evidence boundary                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front-mounted hose and invented ventilation slots         | Move the hand shower, holder, hanging hose and white-handled valve to the right side; use the photographed side-panel seams and fasteners.                                                                                   |
| Inset door, prominent roof lip and high handle            | Extend the door to the photographed cabinet edges, lower its handle and enlarge the drop grip; update the MJCF pivots and coarse proxies alongside the GLB.                                                                  |
| Wrong panel arrangement and decorative heading            | Reproduce the smaller upper-right panel with its 16 controls, Japanese labels, section borders, crown emblem and MBCO-5E badge. Treat tiny pictograms and unmeasured positions as approximations.                            |
| Shiny feet and pale opaque window                         | Match the supplied unit's black feet, darker ruby enamel and thin dark glazing edge; preserve the window opening.                                                                                                            |
| Everything incorrectly squeezed into a 900 × 800 mm box   | Keep the nominal cabinet dimensions; distinguish projecting handle, 35 mm side valve and 30 mm rear exhaust from that nominal reference. The 830 mm drawing label denotes the power-cable entry position, not cabinet width. |
| Claimed complete anatomical accuracy from exterior photos | Mark the chamber fixtures, latch/seal, hidden fan, back fittings and force parameters by evidence level. Never present visual approximation as calibrated mechanics.                                                         |

- [x] Archive the supplied references and record the corrected dimensional interpretation.
- [x] Correct exterior geometry, corresponding rigid-body frames and visual export.
- [x] Render front, reference-angle, right-side and open-door views for comparison.
- [x] Rerun bounds, articulation, contact and dynamics checks; show the result.

Delivered: updated Blender/GLB/MJCF assets, four studio views and native MuJoCo
previews. All 13 Python and two Three.js tests pass. The corrected inspection
cycle reaches 99.802° and closes to 0.216°, with no warnings. The 181-object
photo-matched scene is selected in Blender; both earlier scenes remain intact.
Published nominal dimensions and modeled accessory bounds are documented
separately. Exact hidden mechanics and user visual acceptance remain open.

### Approved-model integration and continuous-transfer increment

The user approved the Maruzen appearance and requested the next implementation
steps. Implement and verify the following in order; retain physical calibration
as an explicit measurement gate.

| Gap                                                              | Implementation / acceptance boundary                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal still loads the generic four-tray oven                    | Load the approved articulated GLB at metre scale, bind its door/handle and emissive surfaces to existing playback, preserve equipment identity and saved capacity, and label the visual reference independently of scenario assumptions. |
| Independently solved FR10 poses can choose different IK branches | Continue from the preceding joint solution across a bounded Cartesian path. Initialize the tray once; use actuator dynamics and actual contact for every pickup, transfer and release.                                                   |
| Static grip does not prove pickup or release                     | Verify source pickup, retained support, rack placement, jaw opening and tool retreat; fail on collision, lost grasp, numerical error or timeout. Exercise blocked, unreachable and lost-grasp cases.                                     |
| No cross-runtime recording exists                                | Export bounded, versioned local request/result artifacts with model hashes, ordered phase events and pose samples. Validate imports before replacing replay state. Keep recorded evidence separate from assumed bakery timing.           |
| Scheduler lacks O1/O2/O4 task/outcome ownership                  | Implement shared-state prerequisites before making physics results settle production tasks. Standalone replay must never claim to complete real production or silently fall back to assumed success.                                     |
| Oven loading adds unproven tooling clearance                     | Attempt it only after continuous table-to-rack transfer passes; hold the door open, check actual fork/tray/rail access, and document any tool/layout blocker.                                                                            |

Oven follow-up starts with a kinematic clearance probe using the existing clamp
and tray across the five modeled levels, with the door already at 100°. This
probe can reject an incompatible tool before implementing another robot skill;
it cannot establish dynamic loading success or whole-arm reach.

- [x] Commit the approved oven assets and provenance without unrelated worktree changes.
- [x] Integrate the Maruzen visual and active states into the existing bakery.
- [x] Implement and prove continuous cold-tray transfer and bounded failures (M1).
- [x] Add validated local recording replay in CafeOS (M2).
- [x] Establish bounded workcell task-state prerequisites and connect native outcomes.
- [x] Complete financier/workcell task integration for the accepted simulation
      scope (M3). [Plan 42F](plan-42F-general-orchestration.md) closes shared
      scheduling, two independent cells and the simulated human handoff.
      Physical material/tooling extensions remain separately listed below.
- [x] Probe open-door oven/tool clearance; identify the top-shelf jaw-opening collision.
- [x] Extend to open-door Maruzen loading after access and reach verification.
- [ ] Collect physical measurements before calibrated manipulation claims.

Delivered: approved oven assets committed as `d708591d`; the portal loads their
articulated GLB with existing equipment identity, schedule and capacity preserved.
Browser verification shows the door open at 06:09:02 and closed at 06:09:31 in
the sample shift. Readout/lamp states and reduced-motion playback have a focused
real-GLB regression test. M1 now executes a continuous 28.5-second contact-based
table-to-rack transfer with 3.5 mm final position error; deterministic repeat,
half-timestep and fault checks pass. See [M1 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-tray-transfer.md).
M2 adds local import/export and a bundled genuine transfer in CafeOS, with
play/pause, seeking, event inspection and verified CAD-frame alignment.
See [replay instructions and evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-physics-replay.md).
The subsequent sampled oven/tool probe clears insertion on all five shelves,
but the current 35 mm jaw opening penetrates the top-shelf ceiling by 1 mm.
Shelves 1–4 clear the tested release/retreat sequence. The subsequent increment
below proves whole-arm reach and continuous dynamic loading on shelf 3 only.

## Outcome and scope

### Open-door oven-loading increment — 21 September 2026

Next bounded skill: transfer the existing cold 3 kg tray from the source table
into Maruzen shelf 3, release it onto both rails, and withdraw the FR10 tool.
Keep the existing rack experiment and reuse its controller, contact gates,
request boundary and recording pipeline. This increment does not settle
production tasks or command hardware.

| Gap                                                        | Implementation / acceptance decision                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-only clearance omits arm reach and cabinet collisions | Compose the approved oven with the FR10 cell, choose a fixed documented layout, and preflight one continuous joint branch before stepping dynamics.                                                     |
| A vertical rack approach cannot enter a closed chamber     | Add explicit approach-to-mouth, horizontal insertion, lowering, release and retreat phases; preserve actual contact support and a free tray throughout.                                                 |
| Door manipulation is unproven                              | Fix the door at 100° as a held-open fixture assumption. A closed-door negative case must fail. No oven door motor or latch-release claim.                                                               |
| Top-shelf jaw opening collides with the ceiling            | Target shelf 3 only; keep the top-shelf limitation test. Do not disable cabinet/tool contacts or enlarge the chamber.                                                                                   |
| Existing local recordings describe only the rack task      | Extend the precise task/fixture boundary for oven loading, hash the oven dependencies, and reject mismatched task/fixture recordings. Reuse playback and show the approved visual at its recorded pose. |
| New skill needs inspectable evidence                       | Add a genuine bundled oven-loading recording, tests for nominal/repeat/half-step and meaningful failures, and browser verification of the existing local replay controls.                               |

- [x] Establish a reachable, collision-checked fixed oven-cell layout.
- [x] Complete continuous contact-based loading, release and retreat.
- [x] Verify closed-door, obstructed-destination and lost-grasp failures.
- [x] Extend and test the recording/replay boundary and bundled example.
- [x] Document timings, accuracy, assumptions and how to inspect the result.

Delivered: a 35.5-second continuous shelf-3 loading with 8.443 mm final position
error, repeated-request determinism and successful 1 ms stepping. Closed-door,
blocked, unreachable and lost-grip cases fail explicitly. Version 2 recordings
carry precise task/fixture metadata and a pinned oven visual; CafeOS offers
separate rack and oven examples. The authenticated dashboard renders the
approved Maruzen and supports playback, pause and event seeking. See
[measurements, verification and instructions](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-maruzen-oven-loading.md).

Following this increment, implement Plan 42 O1/O2/O4 before M3 production-task
settlement. Physical calibration still requires actual oven, tray and tool
measurements.

### FR10 fixed-workcell increment — 20 September 2026

The first manipulation candidate is now **FAIRINO FR10**, using the prepared
[manufacturer-CAD arm](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-robots/README.md). The earlier CRX lab
remains a separate model-foundation experiment. This selection concerns local
simulation only and does not authorize hardware procurement or dispatch.

Gaps mapped before implementation:

| Gap                                        | This increment                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last-link origin differs from flange plane | Use the FR10 manual's nominal 106 mm final DH offset, cross-check the CAD end plane, and document unverified bolt clocking and physical calibration.                                              |
| No selected production gripper             | Model an explicitly hypothetical parallel-jaw rim clamp with lower support forks, bounded force/stroke, mass and friction. No procurement or food-contact claim.                                  |
| Payload is undefined                       | Reuse the existing free-body 600 × 400 mm tray; add a documented fixed ballast representing cold contents. Record tool/tray/contents masses and COM.                                              |
| No fixed layout or reach proof             | Assemble a pedestal, overhanging source table and one open rack slot. Solve orientation-constrained source/lift/destination inspection poses within source joint limits.                          |
| No loaded stability evidence               | Test a stationary, contact-supported grasp initialized at the lifted pose, without welding the tray. Separately test source-table and two-rail rack support, clearance and an unreachable target. |
| Inspectability is missing                  | Provide a local CLI, native viewer, rendered workcell views and focused regression evidence. Keep portal integration and continuous transfer in M1–M3.                                            |

- [x] Build the fixed FR10/tool/tray/table/rack model with explicit assumptions.
- [x] Verify nominal flange mapping, payload, reach, clearance and idle support.
- [x] Verify bounded stationary loaded grip with a genuinely free tray.
- [x] Render and inspect the cell, document commands and mark the scope boundary.

Delivered: [fixed-cell assets and launch instructions](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/fr10-workcell/README.md)
and [verification evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-workcell-readiness.md).
Six workcell tests, eight robot-model tests and two GLB tests pass. The loaded
tray settles within 0.23 mm over five seconds, using ideal known-payload
gravity compensation through bounded motors. Tool design, contact parameters
and dynamics remain uncalibrated. Each inspection pose initializes separately;
continuous pickup/transfer remains M1.

Demonstrate one simulated robot transferring one cold 600 × 400 mm tray from
a table to a cooling-rack slot. Replay the movement in CafeOS and use its
completion or failure to drive the same production run shown by the workflow
canvas, resource timeline and Three.js bakery.

The first deliverable is a native, CPU-based MuJoCo experiment with a bounded
recording import/export workflow. This keeps installation and model debugging
local. It does not introduce a production service, browser-to-localhost bridge,
robot driver or hardware command path.

- [Plan 42](plan-42-bakery-workflow-simulator.md) owns task scheduling, resource
  allocation, entity identity and the three operator views. Its O1–O4 milestones
  remain the orchestration prerequisites; this plan adds detailed manipulation.
- [Plan 24](plan-24-cafeos-bakery-automation.md) owns future physical enrollment,
  governed dispatch and receipt reconciliation. Simulation evidence never
  completes physical production or inventory transactions.
- [Equipment documentation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/README.md) owns manufacturer references
  and the distinction between proposed equipment and confirmed purchases.

Keep the current Three.js renderer during the first physics increment. WebGPU
evaluation, browser MuJoCo/Wasm, Isaac Sim, depth ingestion, autonomous door
opening, thermal/batter physics, robot learning and mobile navigation are
separate work. A single fixed workcell has exclusive access during each task;
concurrent robot interaction inside it is outside the initial model.

## Historical gap review — 21 September 2026

This table records the earlier M0–M2 baseline. Subsequent increments implement
bounded shared task/evidence state, request-first native execution, the composed
bakery/robot scene and workspace run snapshots. Use M3/M4 and the current
[release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) for remaining work.

Concurrent worktree edits extend the native/replay path to `table-to-oven`,
Maruzen fixture geometry and version-2 recordings. This review records those as
in progress; their physics, artifact and browser acceptance must be recorded
separately. They do not settle the shared orchestration prerequisites for M3.

| Area          | Current state                                                                                                                   | Required change                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration | `schedule.ts` precomputes intervals using generic worker indices. O1–O4 are planned.                                            | Complete stable task/resource identities, completion-driven transitions and failure handling before attaching physics outcomes.               |
| Robot assets  | FR10 CAD pose replay and the Maruzen portal visual are implemented.                                                             | Reuse tested transforms/geometry for attached task replay; retain model assumptions.                                                          |
| Layout        | Standalone replay preserves the fixed workcell placement; bakery stations remain separate.                                      | Pin the workcell-to-bakery transform when attaching evidence. Reject handoffs outside the modeled reach/material scope.                       |
| Execution     | Native CLI and versioned local request/result files are implemented; the browser does not launch them.                          | Export from an exact reserved pending workflow attempt and validate its result before settlement.                                             |
| Replay        | One route-owned playback session selects workflow or standalone recording inspection; inactive sources retain paused bookmarks. | Attached evidence uses the workflow cursor, task-local offsets and shared task/resource selection. Standalone inspection uses the same clock. |
| Persistence   | Scenarios save settings/source fingerprints; recordings are local artifacts.                                                    | Disclose missing evidence after reload. Define shared artifact retention separately; never reconstruct recorded success from assumed timing.  |
| Validation    | Timings and equipment handling are uncalibrated.                                                                                | Separate software regression success, model assumptions and later physical validation.                                                        |

## First workcell and model gate

Use **FAIRINO FR10** from the pinned [robot asset pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-robots/README.md).
The CAD articulation and nominal-DH inertial correction are tested. The tensor
basis remains an explicit engineering inference, and controller/contact
parameters are uncalibrated. FR5 and xArm 6 remain separately identified
comparison assets. The historical CRX experiment is outside this workcell.

Before treating the model as runnable:

- Pin the upstream revision, MuJoCo release and Python dependencies. Review
  the selected files' licenses, retain attribution and record asset hashes.
- Expand the selected Xacro to URDF during asset preparation; resolve package
  mesh references and convert to checked-in MJCF. Runtime requires no ROS 2
  installation or network model download. Record the conversion command.
- Verify base/flange frames, joint order, axes, angle units, mesh scaling,
  inertial frames and limits. Flag placeholder effort values and unknown
  controller characteristics; never interpret them as manufacturer ratings.
- Model one simulation-only parallel-jaw clamp with explicit finger geometry,
  stroke, force limits and friction. Validate an accessible tray grasp. The
  clamp is a tooling hypothesis, with no procurement or food-contact claim.
- Specify tray geometry, total payload and centre of mass. Use published
  dimensions where available and label assumed mass/material parameters.
- Arrange the table, robot mount and one rack slot within verified kinematic
  reach. Record the arrangement as a fixed scenario; no floor-plan editor.
- Build the rack opening from separate rails/posts and the tray from suitable
  primitives or convex pieces. Standard mesh collision uses convex geometry;
  one hollow-looking mesh can obstruct its own usable opening. [MuJoCo
  modelling guidance][modeling]

If the FR10 model or grasp cannot pass these checks, stop at this gate and
document the specific missing data. A different arm requires an explicit
model decision and its own equipment identity.

## Responsibilities and execution contract

### State ownership

- The entity plane owns equipment/resource definitions and their revisions.
- Plan 42's run owns task state, allocations and event ordering.
- MuJoCo owns physical state while a simulated manipulation is evaluated.
- Three.js displays accepted recording samples and task events.

Use the existing explicit local-demo/workspace identity distinction. One
workcell binding maps resource/entity references to named MuJoCo bodies, joints
and sites. Avoid a second equipment catalogue or workflow store. Physical
placements are independent of canvas presentation coordinates.

Use metres, kilograms, seconds and radians. Record right-handed Z-up physics
coordinates and an explicit transform into Three.js's Y-up scene. Name the
quaternion ordering at the file boundary; normalize it once during import.
Test a translated, rotated workcell so an origin-only example cannot hide an
axis-convention error.

### Request and recording

The current version-2 request and version-3 recording boundary lives in
`crates/bakery-native/src/artifact.rs`, `crates/bakery-native/src/recording.rs`
and `packages/bakery-model/src/bakery-physics.ts`. It supports local inspection
and a bounded pending-attempt handoff with run/attempt IDs, `table-to-rack` or
`table-to-oven`, case, model hash and timestep. A separate native checkpoint
resumes the same unfinished attempt. The recording remains playback evidence.
Completed native handoffs support the fixed oven load–unload sequence and its
combined-fixture rack continuation. The portal validates the full rack sequence
and projects its final transfer into the single-transfer workflow.
General workflow revision/reservation bindings and shared consecutive tasks
remain M3. Extend this boundary with format conversion confined to file/request
ingress. Parse raw input once in each receiving runtime into precise internal types.

Every M3 task-bound request requires:

- Run/task/attempt identity, source scope and the pinned scenario revision set.
- Robot, tool, tray, source and destination references; the reserved workcell.
- Model/controller hashes, initial physical state and fixed fixture poses.
- Grasp/placement targets, payload and controller/contact parameters.
- Physics timestep, simulated-time limit, seed and acceptance thresholds.

Each returned recording echoes the request fingerprint and includes engine
version, platform, model provenance, integration settings, ordered task events,
sampled body/joint poses and a terminal result. Events carry integer physics
steps; simulated seconds are derived from the fixed timestep. Record every
semantic event and terminal pose even between regular visual samples.

Use result branches that distinguish:

- **Completed:** placement evidence, terminal step and final state.
- **Failed:** modelled failure reason, step and final state when available;
  explicitly represent known versus unknown tray disposition.
- **Execution error:** invalid input, missing asset, numerical failure,
  interruption or runner timeout. This is not evidence of a physical outcome.

Use required branch fields, branch-specific builders, exhaustive switches and
`never` exclusions. Reuse Plan 42's lifecycle types rather than maintaining
another task state machine in the viewer. Add type fixtures preventing a
simulation result from satisfying a physical receipt requirement.

Initial proposed bounds: 2 ms physics steps, 100 Hz control, 30 Hz display
samples, 60 simulated seconds and 120 wall-clock seconds per attempt, and a
16 MiB recording limit. Measure these during the workcell milestone and retain
the tested settings with each run. These are software budgets, not hardware
controller specifications. Import validates identities, hashes, finite values,
array bounds, step order and exactly one terminal outcome before mutation.

## Implementation milestones

### M0 — Prepare and verify the model

Implement this in two reviewable increments:

1. **Model foundation:** use the pinned FR10 CAD/URDF and documented inertial
   correction, reproduce the MJCF conversion, and test forward kinematics and
   idle dynamics. Preserve vendor provenance and unresolved source assumptions.
2. **Workcell readiness:** add the assumed clamp, cold tray, table and open rack
   slot; check source/destination reach, clearance, payload and idle stability.
   Static reach checks do not establish a successful contact-based grasp or a
   collision-free transfer trajectory; those require M1.

- [x] Select and pin the model/runtime revisions and retain their license data.
- [x] M0 foundation: convert the unloaded arm, verify source hashes, kinematics,
      inertias/limits and mesh scale; test holding and disturbance recovery;
      inspect the model in the native viewer.
- [x] Convert the arm, build the fixed cell and document all assumed parameters.
- [x] Compare forward-kinematic reference poses before/after conversion; check
      inertias, joint limits, reach, collision shapes and tray/tool payload.
- [x] Confirm idle stability, inspect native MuJoCo renders and provide an
      interactive viewer for independent review.

**Exit:** a reproducible local model loads, settles without numerical warnings
and has a documented source, coordinate convention and feasible grasp target.

The FR10 foundation is available in the [robot asset guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-robots/README.md).
The [fixed-cell guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/fr10-workcell/README.md) documents
the clamp, loaded tray, fixtures and launch commands, with
[readiness evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-workcell-readiness.md).
M0's software/model-readiness exit is complete. M1 is delivered below; hardware
calibration and M3–M4 remain pending. The earlier unloaded CRX experiment
remains documented separately in the [MuJoCo lab guide](../scripts/bakery-mujoco/README.md).

### M1 — Implement one headless tray-transfer skill

- [x] Add a local Python runner with explicit request and output paths, pinned
      dependencies and a documented virtual-environment setup.
- [x] Implement approach → grasp → lift → transfer → place → release → retract
      using bounded waypoints/IK and actuator control. Initialize state once;
      move the robot through dynamics during execution.
- [x] Require gripper/tray contact and stable payload motion. An early welded
      payload smoke test is labelled as such and cannot pass this milestone.
- [x] Detect joint/actuator limit violations, disallowed contacts, lost grasp,
      unreachable targets, numerical errors and time limits.
- [x] Evaluate placement at physics rate after release: tray inside the target
      support region, supported, settled and clear of the retracted gripper.
      Initial regression targets are 10 mm position error, 5° orientation error,
      and linear/angular speed below 0.02 m/s and 0.05 rad/s for 0.5 seconds.
      Tighten against actual fixture clearance; these are uncalibrated demo gates.
- [x] Run the nominal case, occupied/obstructed destination, unreachable target,
      and loss-of-grasp cases. Record actual outcomes rather than forcing success.

**Exit:** a cold tray reaches and rests in the rack; the negative cases produce
bounded, inspectable failures. No real robot connectivity exists.

Exit verified on 21 September 2026. See [continuous-transfer evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-tray-transfer.md)
and the [runner/test instructions](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/fr10-workcell/README.md).

### M2 — Record and replay the workcell in CafeOS

#### Local replay increment — 21 September 2026

Ownership: the Maruzen task owns M1's controller and physics checks; the depth-map
task owns the recording boundary and CafeOS replay. Preserve ongoing changes
to the portal oven and shared workcell. This increment leaves task settlement
and workspace recording storage for M3 and later persistence work.

Gaps mapped before implementation:

| Gap                                                     | Implementation decision                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native output lacks a stable browser contract           | Add one versioned local-simulation artifact with request identity, provenance, bounded samples/events and exactly one terminal outcome.                               |
| A separate hand-built scene could drift from physics    | Export fixture/tool/tray primitive geometry and world poses directly from the compiled model; bind the pinned FR10 GLB to recorded joint angles.                      |
| Files can be malformed, partial or incompatible         | Validate size, schema, model binding, finite values, ordered steps, normalized quaternions and complete terminal samples before accepting the entire recording.       |
| Replay controls could accidentally alter workflow state | Add a local Physics replay view within the existing simulator shell; reuse its playback clock, retain the workflow view and never invoke task or inventory mutations. |
| Imports and graphics loading can race or fail           | Keep the accepted recording on import failure, cancel stale loads and dispose scene resources; provide non-3D event/pose inspection.                                  |
| No browser evidence exists                              | Test native-to-TypeScript import, transformed coordinates, seeking, malformed files and playback lifecycle; inspect keyboard and responsive UI.                       |

- [x] Implement native recording export and the strict TypeScript boundary.
- [x] Add local import/export, scene replay and accessible playback controls.
- [x] Verify cross-runtime samples, terminal outcomes, cleanup and UI behaviour.
- [x] Document how to export a native run and inspect it in CafeOS.

- [x] Implement the request/recording parsers and a small cross-runtime fixture.
- [x] Export pose traces and event evidence from the native runner.
- [x] Add local recording import in the existing simulator shell, reusing its
      playback controller with a dedicated workcell scene and event/pose inspector.
      Preserve the accepted recording on rejection and the paused workflow on return.
- [x] Render physics-derived link transforms using the pinned manufacturer-CAD
      GLB with verified frame mapping. Display exported fixture/tool/tray primitive
      geometry; arm collision-proxy inspection remains in the native viewer.
- [x] Keep seek, speed, reduced motion and selection as replay operations.
      Seeking never steps physics, dispatches work or changes a recorded outcome.
- [x] Show model provenance, assumptions and local-recording status. Export the
      input and result together so reopening reproduces the displayed evidence.

**Exit:** the same recording replays without Python running, with correct joint
and tray poses at arbitrary cursor positions and no UI-driven outcome changes.
This standalone model/replay work can proceed while O1/O2 are being completed.

Exit verified on 21 September 2026. **Physics replay → Load example** loads the
actual 28.5-second nominal transfer (852 samples, 798,302 bytes). Native export,
boundary/type checks, transformed frames, terminal outcomes and the authenticated
portal flow are verified in [M2 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-physics-replay.md).
Playback now uses the route's single active session and frame controller, verified
in the [playback consolidation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-shared-playback.md). Opening or
closing standalone inspection preserves time/speed bookmarks and restores the
destination paused. Standalone recordings keep their local time coordinates.
Plan 42's [scheduled cold-tray increment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-scheduled-dispatch.md)
now attaches accepted rack evidence to a local task's dispatch time and shared
cursor. General production scheduling, workflow fingerprint binding and native
state-continuity integration remain M3. Native checkpoint continuation and the
fixed two-skill oven sequence are delivered below. Files stay in the browser session unless explicitly
exported. No hardware or workspace writes occur.

### Oven evidence handoff increment — 21 September 2026

Implemented after the scheduled-dispatch task's shared-file handoff: the
existing single-attempt cold-workcell handoff now accepts the proved Maruzen
shelf-3 task. It preserves one playback owner, route-owned state and explicit
evidence acceptance. Standalone oven replay remains available independently.

| Gap                                                     | Bounded implementation                                                                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The handoff currently rejects oven requests             | Admit the already-validated `table-to-oven` request through the same reservation and settlement functions.                                                                              |
| Every task displays a rack destination                  | Derive exactly six participating resources from the pinned task, selecting either rack slot or Maruzen shelf 3. Never reserve or display the unrelated destination.                     |
| Successful playback can be mistaken for task completion | Keep explicit acceptance, exact request matching, immutable settlement and source/placement event timing. Playing or seeking alone never settles an attempt.                            |
| Oven failures have only native coverage                 | Pass genuine native closed-door and lost-grip evidence through the same import and settlement boundary. Preserve all holds on failure, wrong-task evidence and conflicting duplicates.  |
| UI guidance is rack-specific                            | Let the loaded rack or oven recording supply the rehearsal request; display the pinned destination and the held-open cold-oven assumption. Preserve native controls and focus feedback. |

Use the compiled input's task-specific destination binding throughout: rack
transfers bind `rack-slot-1`; oven loading binds `maruzen-shelf-3`. Each attempt
still reserves exactly six resources. Correlate the validated request and its
bindings in the input type, then derive workflow nodes, resource lanes and 3D
selection from that same input. The Maruzen shell selects its shelf resource;
an unrelated standalone recording cannot select a resource in the accepted task.
Verify the existing nonzero dispatch offset with the 35.5-second oven example.
No native model, request schema or physics-controller changes are required.

- [x] Extend task-specific resources and reservation types without a parallel lifecycle.
- [x] Test native oven success/failure evidence, wrong-task imports, duplicate acceptance and historical resource states.
- [x] Verify oven rehearsal and destination labels in the shared UI, with keyboard controls.
- [x] Record evidence and preserve explicit deferred gates for recovery, state continuity and hardware calibration.

Verified oven dispatch at 60 seconds, pickup at 68.06 and completion at 95.50
through the shared dashboard. Workflow, six resource lanes and 3D selection
resolve Maruzen shelf 3 consistently. Actual native fault recordings retain all
holds through the import/settlement boundary. See the
[oven handoff evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-maruzen-oven-loading.md).

This increments the existing local handoff. It does not complete general M3:
dashboard integration of consecutive transfers, arbitrary workflow/resource snapshots, physical recovery,
hot handling and workspace evidence persistence remain separate gates.

### Recording evidence integrity increment — 21 September 2026

Implement this independent prerequisite while shared workcell integration is
in progress. The existing import checks order and pose sampling, but its
pickup/placement presence check can accept contradictory terminal histories.
Such a recording could incorrectly release resources when explicitly accepted.

| Gap                                                               | Implementation                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate or reversed pickup/placement events                     | Validate the one-transfer lifecycle once at the recording boundary. Require exactly one pickup before successful placement.                                                                       |
| Completed outcome mixed with failure, or missing failure evidence | Require a final placement event for success and a final failure event for failure/runner error, at the recorded terminal step. Reject events following termination.                               |
| Cross-runtime fault evidence lacks import coverage                | Exercise real native rack/oven fault recordings, successful bundled examples and adversarial event mutations through the browser parser. Preserve immutable replay and existing request matching. |
| Existing synthetic failure fixtures omit terminal observations    | Update supported test fixtures to represent the runner's actual failure-event contract. No native schema, controller, model hash or compatibility path changes.                                   |

- [x] Replace the permissive event check with a precise one-transfer evidence lifecycle.
- [x] Verify genuine native successes, failures and runner errors across the import boundary.
- [x] Verify contradictory evidence is rejected at the parser boundary before settlement; existing invalid-import state tests preserve accepted replay.
- [x] Document the guarantees and remaining unauthenticated-evidence limitations.
- [x] Import invalid JSON in a normal browser and verify the active run is
      unchanged. See [single-operator acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-single-operator-mvp.md).

Delivered: a one-transfer evidence state machine rejects duplicate, reversed,
missing and contradictory terminal observations. Nine real native fault/error
runs import correctly across both workcells; both bundled success recordings
remain valid. Shared task/resource keyboard acceptance and completion seeking
pass in the authenticated portal. The deliberate invalid-file browser upload
was blocked by Chrome's extension file-access permission. See
[evidence integrity verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-recording-integrity.md).

### Native continuation prerequisite — 21 September 2026

Implement phase-boundary pause/resume for the same pending cold-tray attempt
before adding consecutive skills or releasing failed-task allocations. The
runner previously initialized every invocation; a pose recording or exported
local experiment cannot reconstruct its dynamics and controller state.

| Gap                                                  | Bounded implementation                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay poses omit integration state                  | Export MuJoCo's full integration state, including velocities, controls and solver warm-start state, at a completed nonterminal phase.                                                                                  |
| Controller progress is lost                          | Preserve the next phase, absolute physics step, last commanded joint targets, grasp-loss counter and pickup observation. Derive completed-phase targets from the pinned skill.                                         |
| Runtime/model changes invalidate continuation        | Bind the checkpoint to the exact request, model/controller fingerprint and native runtime/platform. Preserve the runner's grip-contact mutation explicitly. Reject malformed or incompatible files before resuming.    |
| A pause could be mistaken for completion             | Use a distinct native checkpoint artifact with an unfinished recording prefix and no terminal outcome. Existing portal recording imports reject it. Resume continues the same request and produces a normal recording. |
| Restoration could silently reset or perturb dynamics | Verify uninterrupted versus pause/JSON round-trip/resume equality for rack and oven, including loaded grasp and release. Restore without initializing a pose or replanning a starting branch.                          |

- [x] Implement bounded native checkpoint export/resume through the existing CLI.
- [x] Verify identical samples/events/outcomes, fault continuation and invalid-file rejection.
- [x] Regenerate bundled evidence for the changed controller fingerprint and verify portal imports.
- [x] Document commands and keep recovery, terminal-state handoff and consecutive transfers explicitly open.

Delivered: all 50 nonterminal phase-boundary round trips across rack/oven and
1 ms/2 ms timesteps match uninterrupted recordings exactly. Fresh CLI processes
preserve oven success and slip failure; CafeOS accepts the final recording and
rejects the checkpoint as evidence. See
[native continuation verification](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-native-continuation.md).

This checkpoint resumes an unfinished attempt at phase boundaries. It grants no
hardware authority and does not recover a failed transfer. A later increment
must carry a completed skill's state into a compatible next skill, establish
occupied-source/destination preconditions, and preserve recovery holds until
explicit recovery evidence settles them.

### Completed oven handoff and cold return — 21 September 2026

The next bounded increment proves two consecutive native skills: table to shelf
3, then the same cold tray back to the original table. Keep the door fixed open
at 100°. The existing browser handoff remains single-attempt until the physical
sequence and its two-task evidence contract are verified.

| Gap                                            | Implementation and acceptance                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending checkpoints cannot start another skill | Capture a separate completed handoff containing successful loading evidence, full integration state, final controller targets and pinned runtime/model identity. Reject incomplete/failed predecessors.                    |
| Unloading has different clearance constraints  | Reinsert open forks beneath the settled tray, clamp, lift a small clearance inside the chamber, withdraw horizontally, then raise and return to the table. Check actual contacts and grasp stability every step.           |
| Source/destination semantics reverse           | Require the tray supported on shelf 3, tool clear/open and return table clear. Observe shelf pickup and table placement using task-specific supports and targets.                                                          |
| A restart could silently reset the cell        | Reuse the same model/data in-process and compare with full-state JSON export/import in a fresh process. No pose initialization or starting-branch selection for unloading.                                                 |
| Evidence must preserve causal identity         | Keep the run identity, give unloading its own deterministic attempt identity, and link both recordings through the exact completed-handoff digest. Keep sequence output distinct from the portal's one-transfer recording. |
| Failure could release held resources           | Refuse continuation after failed loading. Stop failed unloading with a terminal failure; no recovery or second portal reservation is implied.                                                                              |

- [x] Implement completed native handoff and reverse cold-tray skill using the existing controller/recorder.
- [x] Prove load–unload continuity, fresh-process equality, half-timestep behavior and invalid-predecessor rejection.
- [x] Regenerate existing examples for the source fingerprint and preserve their portal behavior.
- [x] Document commands, results and physical limits.
- [x] Replay the native two-task sequence in the dashboard as standalone inspection.
- [x] Extend the bounded task/evidence contract to prepare a cycle before recordings exist; the local request-first handoff is implemented below.
- [x] Verify cold-cycle checkpoint preservation and fresh-process recovery after
      interruption, with explicit evidence acceptance. See
      [timeout recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-timeout-recovery.md).
      Physical failure recovery, door manipulation and hot handling remain separate.

Delivered: a 72.5-second native cold load–unload sequence, with the same tray
returned to the table within 6.822 mm of its target. In-process execution and
fresh-process handoff restoration produce identical recordings; 1 ms stepping
also succeeds. Failed/pending predecessors are rejected and a lost-grasp return
has no placement observation. The portal supports standalone sequence inspection
and the bounded two-task rehearsal described below. See
[cycle verification and commands](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-oven-cycle.md).

### Cold oven cycle inspection in CafeOS — 22 September 2026

Before adding two-task resource settlement, make the existing native sequence
inspectable using the route's single replay clock. This increment is local,
read-only recording playback; it grants no task completion or hardware authority.

| Gap                                                    | Implementation and acceptance                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The browser accepts only individual outbound transfers | Add a distinct validated sequence type/parser. Require successful nominal oven loading, nominal return, matching run/model/timestep/fixture/geometry, distinct attempts, a well-formed handoff digest and matching boundary poses. Completed handoffs can supply their validated loading recording; the CLI validates native resume state. Reject checkpoints and standalone returns as task evidence. |
| Two local recording clocks restart at zero             | Project both legs onto one continuous clock, offsetting return events by loading duration. Preserve the native envelope on export; never fabricate a single-transfer recording.                                                                                                                                                                                                                        |
| The loading/return boundary is invisible               | Add a cold-cycle example, explicit loading/unloading phase jumps and current phase/result text. Reuse existing keyboard-accessible playback and provenance controls.                                                                                                                                                                                                                                   |
| Sequence inspection could imply accepted task evidence | Keep it standalone; do not expose sequence acceptance or settle reservations. Show unauthenticated, uncalibrated, cold-tray/fixed-door limits. A digest alone does not authenticate the underlying native state.                                                                                                                                                                                       |

- [x] Validate native sequence imports and reject mismatched/contradictory legs.
- [x] Replay both legs, boundary poses and offset events on the shared clock.
- [x] Add example/import/export and keyboard-accessible phase inspection.
- [x] Verify parser, replay transitions, evidence isolation, type checks and portal build; document how to try it.

Verification: 88 simulator tests, shared-client/portal type checks and portal
build pass. Local browser import, keyboard phase jumps, playback and terminal
pose checks pass. The signed-in dashboard check was blocked by stopped local
backend listeners; the existing preview exercised the same route component.
The browser download observer timed out, so download delivery remains unverified
there; serialized JSON round trips pass. See
[cycle inspection evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-cycle-inspection.md).

The following increments add bounded two-task reservations, recorded settlement
and local cycle run files. Native pre-execution dispatch, recovery and
workspace-shared cycle storage remain open.

### Bounded two-task cold-cycle rehearsal — 22 September 2026

Extend the existing local workcell lifecycle and shared views. Prepare from a
validated cycle recording, pin both requests and its handoff digest, then require
explicit evidence acceptance. This is recorded-run rehearsal; native dispatch
before evidence exists, arbitrary workflows and cloud persistence remain open.

| Gap                                                       | Implementation and acceptance                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A prepared run identifies one transfer                    | Add an explicit cold-cycle input with two task identities, one dependency and exact request/digest bindings. Preserve transfer inputs as a separate current variant.                                                                                                                                   |
| Return occupancy reverses the original source/destination | Reserve the original table for the return throughout the cycle. Show table occupied → reserved → occupied and shelf reserved → occupied → available from accepted observations. Keep arm/tool/cell allocated across the boundary.                                                                      |
| Preview and run evidence are separate                     | Explicit acceptance validates the whole sequence against the pinned plan atomically; duplicates are idempotent and conflicting input/digest/evidence is rejected. A matching failed loading recording terminates loading and blocks unloading. Partial successful loading cannot settle a whole cycle. |
| One task card cannot explain dependencies                 | Project loading and unloading independently, with blocked/running/completed/recovery states, onto the existing workflow and resource timeline. Use the same dispatch-relative clock and selection identities as 3D.                                                                                    |
| Failure and view changes could free resources             | Failed loading/return retain all six holds. Seeking, imports and source switches never settle evidence or enable another run.                                                                                                                                                                          |
| Existing experiment saves only cover transfers            | Keep transfer saves unchanged. Explicitly identify cycle scheduling as session-only and allow native sequence export; full cycle run persistence follows this increment.                                                                                                                               |

- [x] Add typed cycle preparation, exact evidence matching and conservative settlement.
- [x] Connect two task projections, shared selection and resource transitions to playback.
- [x] Add the prepare/accept flow and explicit session-only limits to the existing UI.
- [x] Test scheduled boundaries, both failure legs, conflicts, duplicates, type escape hatches and existing transfer behavior; verify the browser flow.

Verification: **93 simulator tests**, shared-client/portal type checks and the
portal build pass. Browser checks cover preparation without acceptance, delayed
dispatch, loading/return task selection, the handoff, final table occupancy and
play/pause. Desktop and narrow viewport checks preserve scrollable docks and
keyboard access. The portal backend was stopped, so UI verification used the
existing preview of the shared dashboard route. See
[two-task rehearsal guide and evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-cycle-orchestration.md).

### Save and reopen bounded cycle runs — 22 September 2026

Extend the existing local experiment file boundary and Save & open controls.
Preserve exact setup and recorded results across reloads. Workspace-shared
storage, native pre-execution dispatch and recovery follow this file increment.

| Gap                                                    | Implementation and acceptance                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle setup cannot be saved without recording evidence | Validate the paired loading/return requests and handoff digest independently at the persistence boundary. Compile the same cycle input and task identities without fabricating motion or completion.                                                  |
| Experiment files only carry single transfers           | Add a precise cycle input variant to the existing file format, retaining current transfer files. Save pending setup, completed cycles, failed loading and failed/errored returns.                                                                     |
| Reopening could bypass evidence acceptance             | Rebuild reservations from validated inputs; restore recorded evidence as a paused preview. Require explicit acceptance through the existing settlement boundary. Never restore serialized lifecycle/status or resource-release claims.                |
| Corrupt or mismatched saves could replace a run        | Reject altered request pairs, digest/evidence mismatches, invalid dispatch/bindings, oversized files and invalid variant combinations. A successful loading prefix restores as awaiting unloading. Keep active runs and playback intact on rejection. |
| Cycle UI advertises session-only scheduling            | Reuse Save run setup only, Save run to file and Open a saved file, with copy that distinguishes saved setup from accepted recording and portable files from cloud saves.                                                                              |

- [x] Add the paired-request boundary and precise saved-cycle state types.
- [x] Round-trip cycle setup and all terminal outcomes through the current file opener.
- [x] Enable cycle save/reopen controls and verify keyboard/error feedback.
- [x] Verify mismatches, restoration isolation, current transfer files, type fixtures and portal build; update usage instructions.

Verification: **97 simulator tests**, shared-client/portal type checks and the
portal build pass. The browser reopened serializer-produced pending, completed
and failed-loading files; explicit acceptance retained the scheduled handoff or
failure holds. Opening a saved run over an active run was rejected and focused
the file input. Save controls invoked the download path, but the browser's
download event observer timed out; delivered download bytes remain unverified.
The backend was stopped, so browser checks used the existing shared-route
preview. See [updated usage and limits](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-cycle-orchestration.md).

### Request-first cold-cycle execution — 22 September 2026

The portal can reserve a `native-cycle` from a validated nominal table-to-oven
loading request before any motion exists. No return attempt or handoff is
invented at this boundary. **Execute locally with MuJoCo** exports the request
and shows `bakery-native load` followed by `unload`; `cycle` runs both phases
continuously. The CLI obtains the return request from
the successful native loading handoff and continues in that state. The portal
can accept successful loading first, replay and save that prefix while unloading
awaits evidence, then accept a full sequence with exactly the same loading.
Loading alone never settles the cycle or releases its reserved resources.
Failed loading evidence keeps the return blocked. See the
[incremental-cycle guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-incremental-cycle.md).

Saved local run version 2 includes the authored chain and requested start time;
actual native dispatch is derived again on import. Version 1 files normalize to
the one-operation default at the persistence boundary. Manual prerequisites,
resource contention and availability affect dispatch; native duration comes
only from matching evidence. Follow-on manual tasks start after actual success.

Verified with a fresh native request reserved in the browser before running the
CLI: both loading and unloading completed, then the newly generated sequence
was imported and accepted. The saved authored run reopened with its 120-second
outage and inspection beginning at 192.50 seconds. See the
[local task-chain guide](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-task-chains.md).

Explicit manual recovery is a simulation assumption: it can reset the displayed
cell and release simulated holds after a duration, while retaining failed native
evidence and blocking dependent work. It is not a native recovery trajectory or
a checkpoint that can start another skill. General native chaining, hardware
recovery, financier material compatibility and shared execution remain M3/M4.

### Workspace-shared rehearsal snapshots — 22 September 2026

Persist named immutable copies of the existing run file, including authored
chains, blocked/pending setup and retained or accepted recordings. Reuse the
private ARCHIVE R2 binding and organisation control authorization. This storage path
does not dispatch native work or certify uploaded evidence.

| Gap                                                             | Implementation and acceptance                                                                                                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local files cannot be opened by another member                  | Add organisation-scoped create/list/read routes and Save & open workspace controls. Admins save; authorized viewers read. Preview remains file-only.                                                             |
| Evidence is too large for scenario entity attributes            | Store each bounded run-file envelope as one private R2 object. No new binding, public URL, database schema or duplicate execution model.                                                                         |
| Retries could duplicate or overwrite another save               | Address immutable snapshots by a server-computed content digest; conditional creation makes retries idempotent. List metadata with bounded pagination.                                                           |
| Stored data could bypass current validation                     | Storage validates its envelope and supported file version; the existing full run parser validates task/evidence semantics on open. Require explicit evidence acceptance and reject replacement of an active run. |
| Workspace switches or delayed requests could restore stale data | Scope the panel by organisation, ignore superseded/unmounted requests and recheck the active-run guard before restoring. Surface loading, errors and permission limits with native controls.                     |

- [x] Implement bounded immutable storage and organisation-authorized endpoints.
- [x] Add named workspace save/list/open controls beside portable files.
- [x] Test isolation, authorization, retries, pagination, unavailable storage,
      invalid saves and explicit-acceptance restoration; run types/build checks.
- [x] Update interaction instructions and record verification limits.

Verification: 114 simulator tests, shared-client/portal/platform source type
checks, e2e type checks and portal build pass. A real Worker/D1/R2 test covers
session and CSRF enforcement, viewer access, membership revocation, foreign
organisations, immutable retries, bounded uploads and pagination. Two focused route
tests cover unavailable storage and denied access. The full platform suite had
2 failures (chat transport and a bakery-sample timeout); the bakery sample passes
on targeted rerun. The platform test-type command reports errors in unrelated
chat, JSX and lifecycle fixtures. See the
[shared-save guide and verification limits](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-shared-runs.md).

### M3 — Feed physics outcomes into the orchestration run

Requires Plan 42's O1 task loop including awaiting-evidence, failure and
reservation settlement, plus O2 shared identities/projections. O4 exercises the
integrated failure campaign afterward. O3 general authoring, multiplayer and
shared recording storage are independent of this bounded local integration.

Current acceptance scope (reviewed 23 September): the local rack/oven transfer
and continuous cold load→unload run reserve exact inputs before evidence exists,
settle matching results and share workflow/resource/3D projections. Manual task
chains, local files and assumed recovery extend this boundary. The completed
items below cover that bounded implementation; general integration stays open.
The local multi-tray queue adds per-operation evidence and exclusive shared-cell
dispatch. Its assumed stage/clear steps do not claim native state continuity.
Refactor 5 separately verifies continuous native oven→table→rack execution.
See [task-chain evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-task-chains.md) and
[native sequence evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-oven-cycle.md).

- [x] Require the fixed FR10 manipulation assignment for native work; reject
      incompatible human assignments and preserve pinned tooling/fixture bindings.
- [x] Run the bounded cold-tray scenario through one shared task, resource and
      playback owner while preserving the financier compiler.
- [x] Reserve the exact arm/tray/destination/cell input and export its request
      before motion exists. Unknown native duration keeps dependents blocked.
- [x] Run the Rust CLI manually and import evidence for that exact pending
      attempt; the browser does not launch the native process.
- [x] Validate the whole result before settlement, derive timing from dispatch
      plus native steps, and schedule independent/dependent manual tasks using
      successful completion and resource availability.
- [x] Project pickup/placement occupancy, release after native success and retain
      failure holds until explicit assumed recovery. Accepted failures remain intact.
- [x] Continue native loading into unloading using the actual completed loading
      state and derived handoff identity. Check continuity before accepting a cycle.
- [x] Reject mismatched evidence and conflicting duplicates. Reaccepting the same
      evidence is idempotent and never creates another reservation.
- [x] Show bounded task states and resource occupancy through the shared views;
      runner errors cannot fall back to assumed successful native duration.
- [x] Sample attached poses with the shared cursor and dispatch offset; preserve
      standalone inspection as an explicit source with paused bookmarks.
- [x] Keep native tasks undispatched when a manual prerequisite fails. Retain
      matching recordings separately from accepted execution, keep native
      allocations available, and preserve blocked runs through local save/reopen.
      Manual tasks share the run cursor while recorded robot motion stays at zero.
- [x] Replay accepted cold-cycle loading while unloading awaits evidence. Preserve
      that prefix through save/reopen, retain native reservations, and accept only
      a matching continuous cycle. Start resumed playback at the loading boundary.
- [x] Support up to 16 independently identified native operations in the local
      multi-tray queue, with per-operation evidence, shared-cell exclusion and
      complete local run files. See [multi-tray evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-multi-tray.md).
- [x] Integrate multi-batch financier scheduling with per-tray cold-transfer gates,
      shared oven/cooling capacity, human staging/clearance and exclusive FR10 use.
      Verify six fresh native successes, a real slip failure and a 16-operation
      scheduler campaign. See [production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-production-workcells.md).
- [x] Author prerequisites across existing manual operations, transfers and native
      cold-proxy tasks. Include mandatory material order in cycle validation;
      persist assigned bakers and earliest starts through shared copies and files.
      See [cross-operation acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-cross-operation-authoring.md).
- [x] Preauthor loading → retrieval → racking and execute continuously through
      the existing browser MuJoCo/Rust worker. Automatically bind successors to
      accepted state, retain waits and failure holds, and stop on cancellation.
      Save/reopen completed boundaries without rerunning them. Browser success,
      slip/blocking and download/reopen acceptance passed. See
      [authored continuation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-authored-continuation.md).
- [ ] Extend the task catalogue and implement physical material/tooling handoffs
      beyond the supported cold-proxy gate. Physical material continuity remains open.
- [x] Bind cold-proxy material identity to cell/tool reservations, validate fixture
      geometry and tray/clamp poses before accepting evidence, and project custody
      through staging, native transfer, clearance and failure holds. Verify actual
      native runs, incompatible recordings, save/reopen and keyboard endpoints.
      See [material/tooling acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-material-tooling-handoffs.md).
- [x] Bind production settings and exact per-tray requests with a compiled workflow
      fingerprint; validate local run files before accepting their saved results.
- [x] Bind each production native attempt to the execution workflow and procedure
      fingerprint, including authored manual constraints. Reject prior evidence
      after execution edits and preserve evidence across presentation-only changes.
      Financier oven/human and native events continue through the shared scheduler.
- [x] Extend native continuation to the combined cold oven→table→rack fixture,
      preserving successful predecessor state and rejecting incompatible handoffs.
      See [combined fixture acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-combined-fixture.md).
- [x] Expose all three combined native operations through the existing authored
      workflow, exact evidence acceptance and shared playback. Preserve both
      handoffs through v3 save/reopen; verify authored waits and native failures.
      See [combined portal acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-combined-portal.md).
- [ ] Validate material, pose, tooling, reach and capacity for supported financier
      handoffs; hot handling requires separate evidence.
- [x] Add private workspace-shared run-file storage with explicit acceptance on reopen.
- [ ] Complete the full M4 acceptance campaign.

**First exit:** a single cold table-to-rack task reserves resources, waits for its
exact recording and settles into one run visible in all three views. A failed
placement stops dependent work; unrelated eligible work follows Plan 42's rules.
Replaying accepted evidence requires no native process or new execution.

**M3 completion:** prove consecutive transfers with complete native state
continuity, then compare supported financier handoffs against assumed handling
only where source/destination and material requirements match. The current cold
recording is insufficient evidence for hot oven handling. This requirement
prevents a visually similar recording from being attached to an incompatible task.

### M4 — Validate repeatability and usability

- [x] Verify pinned nominal/fault execution against fresh-process checkpoints and
      completed-state handoffs for the supported Rust skills. Retain integration,
      controller and solver state. The macOS/Linux campaigns are recorded in
      [native boundary acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-native-boundary.md).
- [x] Repeat supported nominal skills at 1 ms and 2 ms and record outcomes and
      placement differences, including the combined fixture's three transfers.
- [ ] Measure wider parameter sensitivity and physically validate supported ranges.
- [x] Cover request mismatch, malformed/oversized evidence, partial loading,
      duplicate/conflicting results and invalid import isolation in bounded tests.
- [x] Reconcile saved-run format fixtures with v3 presentation persistence;
      the closeout simulator suite passes all 142 tests. See the handoff for the
      concurrent-checkout caveat and remaining browser checks.
- [ ] Extend interruption and timeout coverage across the integrated workflow.
      The campaign now stops the native runner during either A or B, verifies
      independent progress and held reservations, then checks explicit retries.
      A separate local [campaign](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-timeout-recovery.md)
      verifies combined-cycle checkpoint preservation and resume. Local macOS
      process signals and Linux container termination now have
      [host/device evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-host-device-validation.md).
      Production executor timeout delivery, host power loss and the broader
      integrated recovery matrix remain open. See
      [integrated acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md).
- [x] Verify local macOS SIGINT/SIGKILL and Linux arm64 container
      SIGTERM/SIGKILL interruption from loading, unloading and racking
      checkpoints, exact fresh-process recovery, and browser-worker stop/reload
      cleanup in Chromium, GPU-disabled Chromium and WebKit.
- [x] Verify bounded second/third transfer continuity, resource exclusion and
      shared task selection; verify keyboard, narrow layout and the context-loss
      fallback in the documented portal walkthroughs.
- [x] Verify initial no-WebGL startup and actual v3/multi-tray downloads. Verify
      the combined nominal/blocked/unreachable/slip recordings in the portal.
      See [combined portal acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-combined-portal.md) and
      [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md).
- [ ] Complete the general integrated fault matrix and timeout coverage.
- [x] Record native campaigns, UI walkthroughs, sources and cold-model limitations
      in `docs/evidence/` (linked above and in the handoff).
- [ ] Record representative end-to-end performance, artifact sizes and operator
      usefulness for the full integrated scenario. The expanded cold-proxy
      campaign records native request/recording sizes and a 16-operation local
      scheduler baseline. The [host/device matrix](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-host-device-validation.md)
      adds three browser configurations at desktop, tablet and phone widths;
      actual operator devices and broader production evidence remain open.

MuJoCo documents exact reproducibility within the same version/architecture,
with complete integration state. Cross-platform/version checks use documented
tolerances and outcome comparisons. Recorded replay uses the stored evidence.
[Reproducibility guidance][reproducibility]

**Exit:** the bounded local MuJoCo example is ready to inspect and repeat.
Operational calibration and hardware readiness remain explicitly incomplete.

## Follow-up gates

After M0–M4, choose the next demonstrated need:

1. **Physical calibration:** cold oven loading/retrieval and the combined rack
   continuation are implemented. Measured latch/door forces, payload/tool
   parameters, hot handling and autonomous door actuation need separate evidence.
2. **Automatic/shared execution:** map the existing heavy-execution and artifact
   boundaries before adding a dispatch endpoint. Define authorization, job
   ownership, cancellation, result validation and workspace artifact retention.
   Workspace scenarios already remain shared; first-release local recordings
   are not silently uploaded or recreated when a colleague opens a scenario.
3. **Depth recordings:** extend the recording boundary with calibrated, timestamped
   observations and explicit frame transforms. Preserve simulated/observed source
   distinctions; recorded geometry must be reviewed before driving a physics run.

## Code ownership and checks

Extend the existing bounded workcell modules; avoid a generic simulator plugin
framework. Refactor 5 owns the completed Rust execution migration.

| Location                                              | Responsibility                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `crates/bakery-native/`                               | Native controllers, MuJoCo state, recording, checkpoints and completed-state handoffs.      |
| `scripts/bakery-robots/` and `scripts/bakery-mujoco/` | Offline assets, pinned SDK/package tooling and acceptance campaigns.                        |
| `assets/bakery-robots/` and `assets/bakery-mujoco/`   | Reviewed CAD/MJCF, composable fixtures, provenance and license files.                       |
| `packages/bakery-model/src/bakery-physics.ts`    | Shared request/recording boundary parser and precise types.                                 |
| `apps/portal/src/features/workflow-simulator/`        | Evidence import/export, task-result integration, shared playback, scene bindings and tests. |
| `docs/equipment/` and `docs/evidence/`                | Engineering assumptions, upstream sources and reproducible acceptance evidence.             |

Do not put recorded frames in entity attributes or persist simulated transfers
as real production batches. Existing scenario mutations retain their established
authorization and revision checks. Bounded workspace snapshots are implemented;
hosted native execution and general artifact retention remain separate work.

For native changes, run the Rust/native campaign from the runner guide. Run
simulator Node tests, Underclerk-client type checks, the portal build and
`git diff --check` for the relevant TypeScript integration.
Add targeted type fixtures for lifecycle/source combinations and behavioral
tests for event ordering and resource settlement. Run shared platform/commerce
checks if a later milestone changes those boundaries. Validate new controls for
keyboard access, cancellation/error feedback and reduced motion when implemented.

The isolated Python environment, FR10 model foundation, fixed workcell, M1
continuous transfer and M2 local CafeOS replay are implemented. Plan 42's O1/O2
establish the task loop, reservations and shared projections needed by M3.
The portal now uses the
approved Maruzen visual; the deployed runtime and real hardware remain unchanged.

## Primary references

MuJoCo/FR10 references checked 2026-09-20; historical FANUC references checked 2026-09-17:

- [MuJoCo Python bindings][python] — historical labs and offline asset preparation.
- [MuJoCo modelling][modeling] — contacts, collision geometry and model setup.
- [MuJoCo state and reproducibility][reproducibility] — repeatable experiments.
- [FAIRINO ROS 2 source](https://github.com/FAIR-INNOVATION/frcobot_ros2/tree/5bed0b0263c8f1e95f51aa45079f904d463c5c50) — pinned FR10 engineering source.
- [FAIRINO DH parameters](https://fairino-doc-en.readthedocs.io/3.9.4/CobotsManual/robot_brief_introduction.html#robot-denavit-hartenberg-parameters) — nominal dimensions and COM data.
- [FAIRINO installation manual](https://fairino-doc-en.readthedocs.io/3.9.4/CobotsManual/installation.html) — flange drawing and payload/COM guidance.
- [FANUC robot-description repository][fanuc-description] — historical CRX experiment source.
- [FANUC CRX-10iA link/joint description][fanuc-model] — historical model reference.

[python]: https://mujoco.readthedocs.io/en/stable/python.html
[modeling]: https://mujoco.readthedocs.io/en/stable/modeling.html
[reproducibility]: https://mujoco.readthedocs.io/en/stable/computation/index.html#reproducibility
[fanuc-description]: https://github.com/FANUC-CORPORATION/fanuc_description
[fanuc-model]: https://github.com/FANUC-CORPORATION/fanuc_description/blob/main/fanuc_crx_description/urdf/crx10ia_urdf_macro.xacro
