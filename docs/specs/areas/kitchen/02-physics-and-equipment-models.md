# KIT-02 — Physics and equipment models

Kitchen in Purin Pantry simulates robot cells and bakery appliances with MuJoCo 4.0.0.
One Rust engine, `crates/bakery-native`, holds the controllers and the MuJoCo state. It
runs as a native binary for the Node journeys and as WebAssembly in one Web Worker of the
Portal page. TypeScript plans the schedule of the run. Rust plans each arm path by
inverse kinematics, runs the controllers and steps physics. The engine records
samples, events and one outcome, and it writes checkpoints from which a run resumes
exactly. The Portal plays the recordings in Three.js. The Platform Worker runs no physics.
The engine builds are content-addressed bundles that the Portal serves, and a lint ties
the pinned bundle to the engine source. Every result is simulation evidence only: it
grants no hardware authority, and its coefficients are uncalibrated.

## What it does

### Who owns what

| Responsibility                                             | Where it runs                                      | Owner                                    |
| ---------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Dependencies, schedule, resources, evidence acceptance     | Browser TypeScript                                 | KIT-01, KIT-03                           |
| Robot and appliance controllers, MuJoCo steps, checkpoints | Wasm in one Web Worker; native binary for journeys | This spec                                |
| Workflow canvas, timeline and 3D playback                  | Browser; Three.js on WebGL                         | KIT-01, this spec for the physics scenes |
| Authorization, chat effects, saved runs                    | Platform                                           | KIT-01, FND-09                           |

### Robot transfers

- Six arms (`Robot` in `crates/bakery-native/src/robot.rs`, `ROBOT_IDS` in
  `packages/bakery-model/src/bakery-robots.ts`): `fairino-fr10`, `fairino-fr5`,
  `ufactory-xarm6`, `fanuc-crx10ial`, `universal-robots-ur5e` and `dobot-cr10`.
  `prepare` selects `fairino-fr10` when a request names no arm.
- Three tasks (`BakeryTask` in `artifact.rs`) move one 600 × 400 mm cold tray with a
  hypothetical parallel-jaw clamp:

| Task            | Source support | Destination site                                              |
| --------------- | -------------- | ------------------------------------------------------------- |
| `table-to-rack` | `table_top`    | `rack_tray_center` on two rack rails                          |
| `table-to-oven` | `table_top`    | `mbco_slot_3`, shelf 3 of the Maruzen MBCO-5E, door held open |
| `oven-to-table` | Shelf 3 rails  | `source_tray_center` on `table_top`                           |

- A request selects the case: `nominal`, `blocked`, `unreachable`, `slip` or
  `closed-door`. `closed-door` is valid only for oven loading, and `oven-to-table`
  needs `nominal`. The run and attempt ids are 1–80 characters of `[A-Za-z0-9_-]`.
- A test-only `speedRatingScale` (above 0, below 1) lowers every rated joint speed, so
  that a journey can prove `joint-speed`. A production request has none.
- The physics step is 1 ms or 2 ms. The controller sets a new servo target every 10 ms
  (100 Hz), and the recorder takes samples at 30 Hz (`transfer.rs`).
- The request also sets the load: ingredient mass 0–4 kg (default 1 kg), an offset of at
  most ±100 mm forward and ±60 mm lateral, and a clamp force of 20–100 N (default 100 N).
  MuJoCo computes the combined tray inertia again before the run.
- A standalone nominal `table-to-rack` request can move the rack by whole millimetres,
  −600 to +600 on each horizontal axis. Zero offsets give the fixed layout.
- The fixture cells are `separate`, `combined`, `combined-blocked-rack`,
  `combined-unreachable-rack` and `pan-staging` (`PHYSICS_CELLS` in
  `packages/bakery-model/src/bakery-physics.ts`). The model hash names the robot, the
  cell and the SHA-256 of the asset list.
- The plan checks reach, contacts and static load at each path target before the arm
  moves (`walk` in `transfer.rs`). Then the arm moves through actuator dynamics and
  real contacts. The tray is a free body.
- A placement passes when the tray is within 10 mm and 5° of the target, moves slower
  than 0.02 m/s and 0.05 rad/s, touches each support of the task and no clamp geometry
  (`placement_with` in `transfer.rs`). A tray 25 mm out of the grip for 60 ms is a lost
  grasp.
- An outcome is `completed`, `failed`, `execution-error` or `recovered` (the end of a
  persistent-cell recovery). A failure names its reason:
  `unreachable`, `destination-blocked`, `door-obstructed`, `collision`, `joint-limit`,
  `joint-speed`, `actuator-limit`, `lost-grasp` or `placement-failed`. It also gives the
  tray disposition: `source`, `gripped`, `destination` or `unknown`.

### Robot limits

Each operation reports margins against the robot's rated limits (`limits.rs`): the peak
joint speed, the time at the torque clamp, the peak penetration and the peak slip. A
joint above its rated speed fails the operation with `joint-speed`. The other limits warn:

| Warning        | Bound                              | Constant              |
| -------------- | ---------------------------------- | --------------------- |
| `penetration`  | 1 mm                               | `PENETRATION_BOUND_M` |
| `slip`         | 10 mm                              | `SLIP_BOUND_M`        |
| `torque-clamp` | 50 ms at the clamp without a break | `CLAMP_BOUND_S`       |

A joint with no rated value in the repository reports `no-rated-value`. The CR10 effort
values come from a vendor simulation file, so they are not a rating.

### Continuation and handoffs

- A transfer can pause at a phase boundary. The pending checkpoint (`Prefix` in
  `artifact.rs`) holds the full MuJoCo integration state, the controller progress with
  its limit measurements, and the recorded samples and events. A resume in a new
  process gives the same samples, events and outcome.
- Only a successful nominal oven loading hands off. The handoff holds the loading
  result and its recording, with a SHA-256 digest that detects corruption. Retrieval
  continues from that state. It never sets a new pose or chooses a new IK branch.
- A finished retrieval gives a sequence file: the loading recording, the retrieval
  recording and the handoff digest (`bakery-physics-sequence`).
- In the `combined` fixture, retrieval can hand off to a rack transfer. The rack
  sequence file (`bakery-physics-rack-sequence`) holds the loading, retrieval and
  racking recordings and the digest of each handoff.
- A failed or pending predecessor cannot hand off. A terminal recording cannot resume.

### Persistent cells and the host protocol

- `serve` (native) and `bakery_cell_command` (`browser.rs`, Wasm) answer one JSON
  protocol (`host.rs`). The commands are `program`, `define`, `appliance`, `espresso`,
  `pour-over`, `open`, `prepare`, `commit`, `discard`, `start`, `recover`, `advance`,
  `export`, `observe` and `dispose`. A refused command changes nothing.
- A persistent robot cell is `persistent-rack/1`, `persistent-oven-rack/1` or
  `persistent-pan-staging/1` (`CellFixture` in `cell.rs`). Its world is never reset. A
  carrier is admitted to the source table and removed after release. The cell steps at
  2 ms only. An idle cell offers a settled hold (`cold-cell-rest.1`) after it rests for
  one second (500 steps). The hold is qualified against four hours (7,200,000 steps) of
  ordinary advancement.
- A failed operation holds the cell. The cell refuses new work until an explicit
  `recover` command, which ends with the `recovered` outcome. A recovery records the
  events `carrier-removed` and `recovery-completed`.
- Espresso and pour-over station cells (`espresso_cell.rs`, `pour_over_cell.rs`) can
  include a coffee grinder.
- A one-shot command runs as a host program in bounded calls (`program.rs`): `run`,
  `load`, `cycle`, `oven-handoff`, `unload`, `rack` or `comparison`. A finished program
  gives the same bytes as the command line. `comparison` runs its rack transfer on a new
  persistent rack cell, as the first transfer of a production run does.
- Every checkpoint is one envelope (`checkpoint.rs`, schema 1): kind, engine identity,
  payload and the SHA-256 of the canonical payload. The kinds are
  `rack-cell-checkpoint`, `espresso-cell-checkpoint`, `pour-over-cell-checkpoint` and
  `appliance-checkpoint`. The engine opens only an envelope of its own identity.

### Equipment models

The appliance list has one source, `assets/bakery-mujoco/appliances.json`.
`scripts/bakery-robots/appliance-registry.mjs` writes `Name` in `appliances.rs`, the
TypeScript `ApplianceName` and the appliance part of the asset list from it. It has 22
models:

| Kind                          | Model names                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Espresso machines             | `la-marzocco-linea-classic-s-2g`, `victoria-arduino-eagle-one-2g`, `victoria-arduino-e1-prima` |
| Hobs and stove                | `maruzen-mih-02c`, `vollrath-59500p`, `panasonic-kz-ck1402`, `rinnai-rsb-150pj`                |
| Cold storage, ice             | `hoshizaki-rt-120snj`, `hoshizaki-im-35p`                                                      |
| Oven                          | `maruzen-mbco-5e`                                                                              |
| Mixers, blender, grinder      | `aicoh-ms-30`, `hobart-hl200`, `vitamix-quiet-one`, `waring-wsg60`                             |
| Milk mixer, scale, dishwasher | `severin-sm-3587`, `ohaus-ranger-3000`, `winterhalter-uc-l`                                    |
| Coffee grinders               | `option-o-lagom-casa`, `timemore-bricks-01s`, `fellow-opus-2`, `miicoffee-df64-gen2`           |
| Pastry                        | `pastry-bench`                                                                                 |

- An appliance request runs one `Program` (`appliances.rs`), for example `bake`,
  `preheat`, `planetary`, `blend`, `grind`, `hob-power`, `refrigerate`, `make-ice`,
  `weigh`, `wash`, `espresso-shot` or `press-dough-block`. The controller lives in
  `appliance_run.rs` and its process modules (`appliance_thermal.rs`,
  `appliance_motors.rs`, `appliance_services.rs`, `appliance_espresso.rs`,
  `appliance_pastry.rs`).
- Mechanics are MuJoCo contacts, joints and motors: vessel support, door obstruction,
  interlocks, stalls and removable parts. Heat, temperature, mixing and washing are
  explicit process state with assumed coefficients.
- Each model folder has a GLB for Three.js and a `native.xml` with MJCF bodies. The
  collision shapes are separate from the GLB: MuJoCo primitives, and convex mesh parts
  in the MS-30, HL200 and UC-L. Units are metres, kilograms, seconds and radians.
  Physics uses a Z-up frame, and the Portal converts it to the Y-up scene.
- A new appliance needs one table row, its model folder and its `Controller` arm in
  `appliance_run.rs`. The new row changes engine source, so it is an engine release.

### The browser engine

- `engine-jobs.ts` keeps one engine worker for each page. "Run in browser", the agent's
  `simulate_workcell`, the robot comparison and the espresso pages use it. A second job
  fetches and compiles nothing again.
- The worker (`execution-worker.ts`) runs only bytes that its manifest names, and it
  checks each SHA-256. A job runs in calls of 2000 steps and reports its step. Stop
  ends it at a step boundary and keeps the worker.
- The runtime bundle keeps its models in packs (`models.json`, `models-core.pack` and
  one pack for each robot and each appliance with meshes). A command that needs a file
  that is not mounted gets `"missing": "<path>"`, and the worker mounts that pack.
- Results of the robot cells are reused (`native/result-cache.ts`). The key is a chain
  over the engine, the opening command and each later command. A hit returns the
  stored reply. A restored cell must give the same checkpoint digest, or the run stops
  with a fault. The store is memory (256 MiB) and then the origin private file system
  (1 GiB, folder `satyr-physics-results`) in `opfs-result-files.ts`.

### Recordings in the Portal

- The parser in `bakery-physics.ts` validates a whole file before it replaces any
  state: size, schema, model binding, finite values, step order, normalized quaternions
  and exactly one terminal outcome. A rejected file leaves the current run unchanged.
- One transfer has exactly one pickup before a placement. A success ends with a
  placement and a failure ends with a failure event at the terminal step.
- A pending checkpoint is not evidence, and an import refuses it. Playback and seek
  only move a cursor over the recorded samples (`simulator/playback-state.ts`), which
  imports no engine.
- `spatial/physics-model.ts` maps the recorded joints and poses into the scene and
  interpolates between samples. `production-run/scene-host.ts` owns the renderer, the
  camera, the resize and the dispose of the physics scenes.

### Builds, pins and the R2 rule

- A runtime bundle (`apps/portal/public/bakery-physics/bundles/<sha>`) holds the
  loader, the Wasm and the model packs. Its id is the SHA-256 of its descriptor. An
  execution bundle (`executions/<sha>`) holds `production-engine.mjs` for one runtime
  bundle. Visuals are `visuals/<sha>.glb`.
- `browser-physics-asset.ts` pins the runtime bundle (`BAKERY_BROWSER_BUNDLE`) and the
  retained espresso builds (`BAKERY_APPLIANCE_BUILDS`). `execution-manifest.generated.ts`
  pins the execution bundle. Its host protocol is 6 (`HOST_PROTOCOL_VERSION`). The
  Portal client starts only this bundle (`openExecutionWorker`).
- `build.rs` hashes 38 controller files into `BAKERY_CONTROLLER_SOURCE_HASH`, and the
  runner and runtime hashes follow. A request, a recording and a checkpoint carry this
  identity. A checkpoint restores only on the bundle that made it.
- A saved run does not pin a build (Refactor 16, step 8). The host takes three origins
  (`execution-host.ts`): a scenario, a snapshot of its own build, and a replay. For a
  replay (`replay.ts`) the engine starts the saved scenario again, gives each admitted
  command of the save to the run at the time of its admission, releases a pause that a
  later execution continued from, and stops where the save stopped. A decision on a
  task (an inspection or a recovery) waits for its condition, up to the time of the
  next timed command. During a replay the host refuses a command and a save
  (`replaying`). The reply carries a report: the commands, the commands that the
  engine refused, and the first task whose start, completion or failure has another
  time than in the saved recording.
- A cell definition names the build and the model of the controller that made it. For
  a scenario or a replay with a definition of another build, the controller defines
  the same cell again (`define`), the cell keeps the inputs of the saved definition
  (its run name, its load, its clamp force) and takes the pins of the present build,
  and the scenario takes the model of the new definition (`rebindScenario`). The
  `began` reply returns the definitions.
- `pnpm lint:physics-bundle` (`scripts/check-physics-bundle.mjs`) needs no MuJoCo. It
  fails when the source hash differs from `controllerSourceHash` of the pin, when the
  two pins disagree, when a named runtime bundle or file is missing or has another
  length, when a pinned file has another SHA-256, or when the execution sources do not
  build the pinned bundle again. It also fails when the pinned `execution.json` is
  missing or differs from the pin, when a crate `.rs` file other than `main.rs` and
  `browser.rs` is not in the `controller_files` list of `build.rs`, and when a file
  allows `unsafe_code` outside the modules `mj` and `browser`. It keeps in git each
  bundle that a Platform test fixture names.
- `pnpm lint:appliance-registry` refuses a generated list that differs from the table.
  `pnpm lint:journey-index` refuses a journey file with no row in
  `scripts/production-simulation/journeys.json`.
- Large files are in the R2 bucket `pantry-repo-binaries-apac` (`repo-binaries.json`),
  not in git. For this subsystem, R2 holds the folders `assets/bakery-mujoco/`,
  `assets/bakery-robots/`, `assets/bakery-rooms/`, `assets/bakery-living/` and
  `docs/equipment/`. It also holds the two retained espresso runtime bundles of
  `BAKERY_APPLIANCE_BUILDS` and two older execution bundles that journeys name. Git
  keeps the runtime bundle of `BAKERY_BROWSER_BUNDLE`, its execution bundles, the
  visuals and the fixture bundles. Run `node scripts/repo-binaries.mjs fetch` before a
  Portal build, a Kitchen build or a physics journey.
- A production upload of the Platform refuses a Portal build that lacks a bundle that
  a manifest names, or that has a changed file (`requirePhysicsBundles` in
  `scripts/check-physics-dist.mjs`, called by `scripts/run-worker.mjs`).
- `apps/portal/public/_headers` gives `Cache-Control: public, max-age=31536000,
immutable` to the bundle, execution and visual folders.

### Calibration

All timings, masses, forces and layouts are assumptions. The calibration worksheet
(`docs/plan-42-calibration-worksheet.md`) lists each value with an empty "Actual /
evidence" column. Examples from the code: the
human transfer takes 10 s pickup, 20 s carry and 10 s placement
(`human-cell-transfer.ts`), and the source and rack fixtures sit at (1.31, −0.50, 0.78)
and (1.05, 0.50, 0.79) m in each model frame (`workcell-instances.ts`).
`shift-metrics.ts` compares a run with 12 assumed reference bands. It labels the result
"Assumed timings / Uncalibrated". A change to geometry, payload or contact parameters
needs new native requests and recordings; an old recording is never reinterpreted.

## Contracts

| Contract                   | Version or kind                                                                                    | Where                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Transfer request           | `schemaVersion` 7, `source: "local-simulation"`                                                    | `artifact.rs` `Request`; `PhysicsRequest` in `bakery-physics.ts`                             |
| Recording                  | `bakery-physics-recording` 4                                                                       | `recording.rs`; the parser reads 2, 3 and 4, and request versions 3 to 7 in a version 4 file |
| Pending checkpoint, result | `bakery-native-checkpoint` 2, `bakery-native-result`                                               | `artifact.rs` `Artifact`                                                                     |
| Loading handoff            | `bakery-physics-handoff` 3                                                                         | `handoff.rs`                                                                                 |
| Return and rack artifacts  | `bakery-native-return-checkpoint` 2, `bakery-native-rack-handoff`, `bakery-native-rack-checkpoint` | `handoff.rs`, `rack.rs`                                                                      |
| Sequence                   | `bakery-physics-sequence` 2                                                                        | `handoff.rs`; the parser reads 1 and 2                                                       |
| Rack sequence              | `bakery-physics-rack-sequence` 2                                                                   | `rack.rs`; `bakery-physics.ts`                                                               |
| Margins                    | `schemaVersion` 1                                                                                  | `limits.rs` `Margins`                                                                        |
| Checkpoint envelope        | `schema` 1                                                                                         | `checkpoint.rs`                                                                              |
| Appliance recording        | `bakery-appliance-recording`                                                                       | `appliance_run.rs`; `bakery-appliance-protocol.ts`                                           |
| Execution manifest         | `schemaVersion` 1, protocol 5, cell checkpoint schema 4                                            | `execution-manifest.generated.ts`, `execution-bundle.ts`                                     |

- **Rust crate:** `crates/bakery-native` (`Cargo.toml`, `build.rs`, `src/`, `Dockerfile`,
  `README.md`). `src/native/` holds the three MuJoCo worlds: `transfer`, `appliance` and
  `station`. `mj.rs` is the only file with raw MuJoCo pointers. `ik.rs` and `servo.rs`
  serve the transfer world and the pour-over station; the appliance world uses
  neither. The CLI (`main.rs`) has `prepare`, `run`, `resume`, `load`,
  `unload`, `rack`, `cycle`, `appliance`, `prepare-cell`, `cell`,
  `prepare-espresso-cell`, `prepare-pour-over-cell` and `serve`.
- **TypeScript packages:** `packages/bakery-model/src/` (`bakery-physics.ts`,
  `bakery-robots.ts`, `bakery-appliance-protocol.ts`, `bakery-appliance-workflow.ts`,
  `bakery-checkpoint.ts`) and `packages/production-simulation/src/` (`native/`,
  `execution-bundle.ts`, `execution-entry.ts`, `execution-host.ts`,
  `simulator/browser-physics-asset.ts`, `simulator/browser-physics-task.ts`,
  `simulator/appliance-runtime.ts`).
- **Portal:** `areas/kitchen/ui/features/production-run/` (`engine-jobs.ts`,
  `engine-programs.ts`, `execution-client.ts`, `execution-worker.ts`,
  `opfs-result-files.ts`, `retained-appliance-worker.ts`, `scene-host.ts`) and
  `features/workflow-simulator/` (`physics-replay.tsx`, `browser-production-run.ts`,
  `spatial/physics-model.ts`).
- **Build and asset scripts:** `scripts/bakery-robots/` (`build-browser.mjs`,
  `install-native-sdk.mjs`, `package-native.mjs`, `build_native_assets.py`,
  `appliance-registry.mjs`, `retain-appliance-builds.mjs`, `requirements-physics.txt`),
  `scripts/production-simulation/build-execution-bundle.mjs`, `scripts/bakery-mujoco/`
  (asset builders and appliance labs) and `scripts/repo-binaries.mjs`.
- **Static paths:** `/bakery-physics/bundles/<sha>/`, `/bakery-physics/executions/<sha>/`
  and `/bakery-physics/visuals/<sha>.glb` in the Portal assets, with no sign-in.
- **No tables, routes, events or capabilities.** The subsystem owns no D1 table, no
  Actor SQLite table, no control route and no agent tool. The KIT-01 artifact routes
  read no engine file: a staged run needs no bundle on the server.

## Rules and limits

| Limit                                            | Value                      | Constant                                              |
| ------------------------------------------------ | -------------------------- | ----------------------------------------------------- |
| Solver steps for one transfer, planning included | 6,000,000                  | `SOLVER_BUDGET` (`transfer.rs`)                       |
| One JSON artifact or program output              | 16 MiB                     | `read_json` (`artifact.rs`), `program.rs`, `host.rs`  |
| One native cell journey output                   | 128 MiB                    | `main.rs`                                             |
| Recording import; request import                 | 16 MiB; 4096 bytes         | `MAX_RECORDING_BYTES`, `MAX_REQUEST_BYTES`            |
| Browser job wall time; steps for each call       | 125 s; 2000                | `MAX_WALL_MS`, `STEPS_PER_CALL` (`engine-jobs.ts`)    |
| Result cache                                     | 256 MiB memory, 1 GiB disk | `MEMORY_BYTES`, `DISK_BYTES` (`opfs-result-files.ts`) |
| Wasm memory                                      | 512 MiB at most            | `-sMAXIMUM_MEMORY` (`build-browser.mjs`)              |
| Rest of a comparison cell                        | 1000 calls of 32 steps     | `REST_CALLS`, `REST_CALL_STEPS` (`program.rs`)        |

- **Who runs physics.** Each person who can open a Kitchen page runs jobs in their own
  browser. The agent starts a job only through `bakery_surface_simulate_workcell` on an
  owner's or admin's open page (KIT-01). `bakery_surface_prepare_workcell`,
  `bakery_surface_start_production` and `bakery_surface_apply_production` prepare
  native requests and run no job.
- **Evidence.** A recording, checkpoint or handoff is unauthenticated local evidence. A
  digest detects corruption only. Simulation never completes physical production,
  stock or a device task, and it grants no robot authority.
- **Versions.** The engine refuses every MuJoCo version except 4.0.0 (`require_version`
  in `mj.rs`). The browser build needs Emscripten 4.0.10. It refuses a bundle file that
  names a local path (`refuseLocalPaths`). Rust reads only its current contracts. The
  Portal converts an old recording only at import.
- **Retention.** A saved run and an authored route need no bundle but the pinned one.
  A saved espresso rehearsal still continues only on the runtime bundle that made it
  (`BAKERY_APPLIANCE_BUILDS`, `retain-appliance-builds.mjs`). The lint and the
  production upload refuse a build that lacks a bundle that a retained execution
  manifest names. The old bundles stay in the repository until a saved run continues
  by replay in production; their removal is the second part of step 8.
  The result cache is per browser origin and can be lost.
- **Cost.** The server runs no physics, so an idle Organisation costs nothing here.
  The engine loads only when a person or the agent starts a job.
- **Out of scope:** fluid flow, heat transfer as physics, baking chemistry, mixing
  quality; hot tray handling; door actuation and latch forces; hardware drivers and
  dispatch; depth sensors; robot learning; mobile robots.
- **KIT-01** owns the scheduler that consumes this evidence, the workcell resources,
  evidence acceptance, the saved runs and the page commands. **KIT-03** owns the recipe
  workflows and the production engine (`engine.ts`) that drives the persistent cells.
- **Plan 24** owns the physical bake path. Its cobot controller simulator
  (`crates/bakery-native/controller/`, binary `cobot-controller`) stays outside the
  engine identity. **DEV-01** owns devices.
- **Refactor 16** stays a plan. It owns the open changes to this runtime, listed below.
- **FND-11** owns the contract rules. The R2 rule belongs to Plan 92 (ENG-02).

## Open work

- **Physical calibration.** No measurement exists. The "Actual / evidence" columns of the
  worksheet are empty, and no tolerance is agreed. Door and latch forces, payload and
  tool parameters, hot handling and door actuation need separate evidence.
- **Plan 42B M3 and M4.** Physical material and tooling handoffs beyond the cold proxy,
  financier handoff validation, parameter sensitivity, the integrated fault and timeout
  matrix, production executor timeouts, host power loss, and performance on operator
  devices are open.
- **Plan 60A.** Exact manuals, supplied-unit revisions and missing interface dimensions
  are deferred. Each appliance keeps its calibration gaps, for example door axes of the
  RT-120SNJ, HL200 and MS-30 travel and drive ratios, and the Vollrath and WSG60
  dimension conflicts. Robot load qualification is deferred.
- **Shared execution and depth.** No server or heavy-executor job runs physics. Depth
  recordings with observed frames are not built.
- **Refactor 16:** the second part of step 8 (the removal of the old bundles, and a
  saved espresso rehearsal without a pinned runtime), the move of step 9B (every bundle
  in R2), step 10 (agent runs with no open browser) and the rest of step 16 (builders
  as data). Recipe appliance results do not reach the
  schedule. The `bakery-physics` CI job tests the pinned bundle; it does not build the
  Emscripten bundle again.

## Sources

- [Plan 42B](../../../history/plan-42B-mujoco-workcell-simulation.md),
  [Plan 60A](../../../history/plan-60A-bakery-equipment-models.md) and the
  [calibration worksheet](../../../plan-42-calibration-worksheet.md). Where they differ
  from the code, this spec follows the code. Background:
  [Refactor 16](../../../refactor-16.md) and `crates/bakery-native/README.md`.
- Evidence in the archive:
  [status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md),
  [FR10 workcell](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-workcell-readiness.md),
  [tray transfer](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-fr10-tray-transfer.md),
  [physics replay](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-physics-replay.md),
  [oven loading](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-maruzen-oven-loading.md),
  [recording integrity](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-recording-integrity.md),
  [native continuation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-native-continuation.md),
  [oven cycle](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-oven-cycle.md),
  [timeout recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-timeout-recovery.md),
  [native boundary](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-native-boundary.md),
  [combined fixture](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-combined-fixture.md),
  [browser bundles](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/bakery-browser-asset-bundles.md),
  [60A mechanical acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-mechanical-acceptance.md),
  [60A Blender polish](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-blender-polish.md),
  [appliance execution](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md),
  [coffee machines](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/coffee-machines-release-20261018.md),
  [calibration intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md)
  and [Refactor 16 step 9](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-16/step-9.md).
  The plans link each other record.
- Journeys in `scripts/`, indexed in `scripts/production-simulation/journeys.json`: the
  rows whose owner is Plan 42B, Plan 60A or Refactor 16. Examples:
  `bakery-robots/verify-native.mjs`, `verify-browser-linkage.mjs`,
  `verify-ingredient-loads.mjs`, `verify-ur5e-rack-browser.js`,
  `production-simulation/verify-host-programs.mjs`,
  `verify-physics-result-cache.mjs`, `verify-comparison-matches-run.mjs`,
  `verify-engine-jobs-browser.js`, `verify-espresso-journey.mjs` and
  `verify-pastry-bench-browser.js`. Also `bakery-robots/verify-timeout-recovery.mjs`
  and `production-simulation/verify-persistent-cell.mjs`. The appliance labs are in
  `scripts/bakery-mujoco/` (`verify_rust_appliances.py` and the other `verify_rust_*`
  files). The CI job `bakery-physics` in `.github/workflows/pantry.yml` runs the
  headless set `ci` and then the browser set `ci-browser`.
- E2E journey in `workers/platform/tests/e2e/`: `bakery-runs.test.ts` reads a native
  recording through the shared parser.
