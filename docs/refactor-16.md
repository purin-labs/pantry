# Refactor 16 — Satyr Kitchen physics: faster runs, one runtime, builds out of git

Date: 2026-11-15.
Status: proposed; rewritten on 2026-11-15 after a second review. No step has started.
Steps 8, 9, 10 and 15 wait for decisions. The findings come from a read-only review of
the MuJoCo system on `dev` at `6fdcee0c3`, and from six read-only code reviews after
it. "Checked" means that the code was read or the count was run at that commit. No
journey reproduced a fault.

This refactor changes how the physics system is built, shared, loaded and run. It now
changes run speed and some results. It changes no recipe, no schedule and no physics
result, except in the places that [Behavior changes](#behavior-changes) lists.

## The system today

- **TypeScript plans.** A recipe compiler or the workflow canvas (Plan 84) makes a
  `CompiledScenario` (`packages/production-simulation/src/scenario.ts`). The
  production engine (`engine.ts`) plans the run as discrete events.
- **Rust does physics only.** `crates/bakery-native` (17,851 lines) runs MuJoCo 4.0.0.
  It is a native binary for the Node journeys and WebAssembly for the browser. It
  steps the model every 2 ms and plans nothing.
- **The browser runs every job.** Path A (`browser-physics-job.ts`) runs one workcell
  job in a Web Worker. Path B (`production-run/execution-worker.ts`) keeps one engine
  worker for a whole production run.
- **The server stores saved runs only.** The Platform Worker writes them to R2 by
  content hash. It never simulates.
- **Each build has a content address.** A runtime bundle (`bundles/<sha>`) holds the
  Wasm (7.0 MB), the models (22.3 MB) and the loader. An execution bundle
  (`executions/<id>`, about 450 kB) holds the TypeScript engine for one runtime
  bundle. A saved run names the bundle that made it, and only that bundle can resume
  it ([Plan 70B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70B-mujoco-workflow-composition.md#supported-resume-builds)).

## What the design costs today

The design buys an exact digest for every state and an exact resume of every run. It
pays for them on every step, every call and every release. The main claims were read
again in the code. The timings come from committed evidence on one Apple M4 Pro. That
evidence says that it is not a reference measurement.

| Measure                                    | Today                                       | Source                                                 |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------ |
| Speed, one moving cell (Wasm)              | 41 times real time                          | `evidence/plan-70-j1-engine-cell-journey.md:240`       |
| Speed, two cells                           | 13 times real time                          | `evidence/plan-70-j2-tick-barriers-and-restore.md:53`  |
| A run of 24 orders (1.9 h of kitchen time) | 126 s headless; 188 to 246 s in the browser | `evidence/plan-70-j3-bounded-operation-batching.md:28` |
| The stress run                             | 366 and 439 s; the target is 300 s          | `evidence/plan-70-j2-recurring-logistics.md:207`       |
| Recordings of the 24-order run             | 347 MB of JSON                              | `evidence/plan-70-j3-bounded-operation-batching.md:28` |
| A run again after one edit                 | The full run again; "Run draft" makes two   | `recipe-draft-run.ts:129-153`                          |
| Engine download                            | 29 MB for each job on path A; no cache rule | `browser-physics-worker.ts:402-462`                    |
| Old code that must stay served             | 20 runtime bundles, 68 execution bundles    | `apps/portal/public/bakery-physics`                    |
| Host protocols that must stay supported    | 1 to 5                                      | `execution-client.ts:295-308`                          |
| Model builders                             | 103 files, 76,641 lines, no shared library  | `scripts/bakery-mujoco`                                |
| A run for the agent with no open browser   | Not possible                                | `agent-tools/bakery/handlers.ts:88-93`                 |

**Targets.** Each phase measures its rows before and after, and records them in the
evidence:

- **Phase 1:** the run time of the 24-order run, the run time after one edit, and the
  speed with two cells.
- **Phase 2:** the bytes fetched on a second job.
- **Phase 3:** the count of retained bundles.
- **Phase 4:** the bytes fetched on a second job.
- **Phase 5:** the lines for a new appliance.

## Why

Each finding has a number, and each step names the findings that it closes.

**Build output**

- **F1. Engine builds are in git.** `apps/portal/public/bakery-physics` holds 20
  runtime bundles (536 MB) and 68 execution bundles (25 MB). The 20 bundles arrived
  between 2026-10-09 and 2026-11-15. Each one adds about 27 MB to the history, and
  git keeps it for ever. The `.git` folder is 9.3 GB.
- **F2. Captures are in git.** `assets/bakery-mujoco` holds 104 MB of evidence
  captures. Refactor 10 step 0B moved the same kind of file out of `docs/`.
- **F3. Local paths ship to production.** 19 of the 20 `bakery-native.js` loaders
  name the build folder under a home folder, and one names a temporary folder. All
  20 Wasm files name the Cargo registry under the home folder. 66 of the 68
  `production-engine.mjs` files embed the loader with its path. The Portal serves
  these files as static assets, with no sign-in.

**Checks**

- **F4. The CI job is wrong in two places.** `.github/workflows/satyr.yml:153`
  installs MuJoCo 3.13.0, but the engine refuses every version except 4.0.0
  (`native.rs:106`), and both `requirements.txt` files pin 4.0.0. Lines 176, 197 and
  221 import `apps/portal/src/features/workflow-simulator/browser-physics-asset.ts`,
  but that file moved to `packages/production-simulation/src/simulator/`. The job
  runs only for a pull request to `main`, so `dev` does not show the fault.
- **F5. No check ties the engine source to the pinned bundle.** A Rust edit with no
  rebuild passes every check. The source and the pinned bundle agree today
  (`controllerSourceHash` `4c73ea36…`).
- **F6. The journeys have no index.** `scripts/production-simulation` holds 83
  journeys and `scripts/bakery-robots` holds 45. CI names 23 of the 83 by hand. No
  file records the time, the backend or the owner plan of a journey.
- **F7. The file-size ratchet stops at three folders.**
  `scripts/check-file-size-ratchet.mjs:23` covers `apps`, `packages` and `services`.
  `crates/` and `scripts/` are free to grow. `native.rs` has 2,200 lines.

**Copies**

- **F8. The appliance list has no single source.** The 22 names are a TypeScript
  union (`packages/bakery-model/src/bakery-appliance-protocol.ts:4-26`) and a Rust
  enum (`crates/bakery-native/src/appliances.rs:8`). Footprints are in
  `floor/appliance-catalogue.ts`, and positions are in `recipes/bakery/bakery-shift.ts`.
  The asset list `assets.json` has the `native.xml` of 13 appliances and not of 9:
  `victoria-arduino-e1-prima`, `panasonic-kz-ck1402`, `rinnai-rsb-150pj`,
  `option-o-lagom-casa`, `timemore-bricks-01s`, `fellow-opus-2`,
  `miicoffee-df64-gen2`, `hoshizaki-im-35p` and `pastry-bench`.
- **F9. The builders repeat themselves.** 51 scripts fix the Blender path to
  `/Applications/Blender.app`. The physics builders each carry their own mesh export
  functions.
- **F10. `native.rs` holds three engines with copied control code.** The inverse
  kinematics is at lines 454–531 and again at 2034–2117. The step with its servo
  targets is at 661–716 and again at 2122–2177. The file has about 100 `unsafe`
  blocks with raw pointer arithmetic.
- **F11. Checkpoints and replies have about eight shapes.** The espresso and
  pour-over cells answer in untyped JSON (`espresso_cell.rs:362-381`). The appliance
  continuation checkpoint has no digest (`appliance_run.rs:104-116`).
- **F12. Seven recipes each repeat three appliance functions.** `financier.ts`,
  `black-sesame-milk.ts`, `espresso.ts`, `pie.ts`, `pour-over.ts`, `tea.ts` and
  `bakery-shift.ts` each have a task function, a list function and an execute
  function. A recipe from the canvas gets none. The shared `appliance-execution.ts`
  has 3,844 lines, which is over the limit.
- **F13. Eleven scenes repeat their host code.** The 11 `*-scene.ts` files in
  `apps/portal/src/features/production-run` have 14,942 lines. Each one has its own
  renderer, controls, resize, loop and dispose code.

**Run time**

- **F14. Path A starts cold for each job.** `browser-physics-job.ts:98` makes a new
  Worker for each job. The worker fetches, hashes and compiles 29 MB again. Stop
  ends the worker. The job reports no progress. The Wasm exports a session with
  bounded steps (`browser.rs:85`), but path A does not use it.
- **F15. The main thread does heavy work.** It hashes and parses a recording of up
  to 16 MiB (`browser-physics-job.ts:261-275`). Playback sets React state on each
  frame (`workflow-simulator/route.tsx:2092`). That file has 3,044 lines.
- **F16. The hash-named folders have no cache rule.** `apps/portal/public/_headers`
  holds one rule, for `Cross-Origin-Opener-Policy`.
- **F17. Time budgets use the wall clock.** `transfer.rs:724` gives an operation 120
  seconds of real time (also lines 550 and 1304). A slow machine can fail an
  operation that a fast machine completes.
- **F18. The station cells take two steps of a 1 ms model in one 2 ms tick**
  (`espresso_cell.rs:250-253`). [Plan 70A](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70A-production-engine.md) lists
  substeps as an open decision.

**Speed**

- **F19. Two moving cells advance one 2 ms step for each call.** Each cell has its own
  MuJoCo world, and cells link only through handoffs, resources and events
  (`host.rs:201-211`, `cell.rs:856`). When two cells move, each call gives one 2 ms
  step (`engine.ts:514-524`). That is 1,000 JSON calls for each simulated second.
  Each call seals a full checkpoint with a SHA-256 (`host.rs:428-438`,
  `cell.rs:778-806`) and copies the run history (`engine-draft.ts:118-139`). A cell
  with an oven rack never holds (`cell.rs:1144-1149`), so it keeps all other cells at
  one step.
- **F20. Each step does work that it does not need.** A step costs 31 µs native and
  47 µs in Wasm (`evidence/plan-70-e1-bounded-stepping.md:120`). Each step runs a
  second `mj_forward`, three contact scans with one `String` for each contact, and a
  site lookup by name (`native.rs:663-706`, `transfer.rs:1376-1430`). The espresso
  cell builds a JSON sample of all poses and flex meshes on each step
  (`espresso_cell.rs:331`). It calls `mj_setConst` on each step while the cup fills
  (`appliance_espresso.rs:921-926`). The Wasm build has no LTO and no SIMD
  (`build-browser.mjs:63-70`). Samples are JSON objects, not typed arrays.

**Reuse**

- **F21. Nothing reuses a physics result.** An operation is deterministic. The world
  is canonical at the main boundaries: a parked tray has a fixed pose and zero
  velocity (`native.rs:350-383`), and an admitted carrier starts at a fixed pose.

**Paths**

- **F22. Three entry routes run the same physics.** Path A calls a command line
  inside the Wasm (`browser-physics-worker.ts:259`) for "Run in browser", the agent's
  `simulate_workcell`, the robot comparison and the Linea and Eagle pages. Path B
  sends cell commands. The recipe appliance executor is a third route through the
  same command line (`appliance-execution.ts:102-113`). The session exports and the
  `step` command have one caller each, both journeys.
- **F23. The two paths integrate different physics.** The persistent world of path B
  compiles a stiffer table top than the one-shot world of path A
  (`native.rs:147-178`). The same transfer therefore gets different physics in the
  robot comparison and in the production run. The pour-over copy of the inverse
  kinematics also uses other solver limits (`native.rs:463`, `:2049`).

**Saved runs**

- **F24. A saved run pins its build.** This rule is the cause of F1. A save holds the
  full recordings, and the state keeps the scenario and the commands
  (`state.ts:425-444`). A resume needs the exact bundle. For each resumable save, the
  Platform Worker reads and hashes the 29 MB bundle
  (`control/routes/bakery-run-artifacts.ts:229-254`). Only protocol 1 has an adapter;
  protocols 2 to 4 run old code as it is.

**Limits**

- **F25. No check compares an operation with the limits of the robot.** Of 25 sampled
  journeys, 9 assert that digests or recordings are equal. None asserts a rated joint
  speed or a torque margin. The torque check at run time cannot fail, because MuJoCo
  already clamps a force-limited actuator (`native.rs:707-712`). No joint speed limit
  was found in the engine. The CR10 torque limit comes from a Gazebo file
  (`scripts/bakery-robots/generate.py:515`).

**Reach**

- **F26. The agent cannot run a schedule with no open browser.** Each
  `bakery_surface_*` tool sends a command to the person's open Portal page and fails
  with no page (`agent-tools/bakery/handlers.ts:88-93`). The engine uses no DOM and no
  Wasm, and it runs in workerd with no cells (`bakery-runs.test.ts:297-317`). Nothing
  on the server calls it.

**Start**

- **F27. The start loads and hashes more than it needs.** The 22.3 MB model pack is
  one file: STL 10.4 MB, OBJ 6.6 MB, XML 2.8 MB, JSON 2.4 MB. The browser hashes it,
  and the engine hashes each file again when it opens (`assets.rs:95-105`). The XML is
  parsed and the meshes are compiled at each start. `production-workspace.tsx`
  imports all 29 scene and view modules eagerly.

**Recipes**

- **F28. The Portal does not call recipe appliance physics.** The recipe appliance
  executions have callers in the recipe modules and in two scripts, and none in the
  Portal. The Portal appliance panel derives its readings from formulas
  (`morning-shift-appliances.ts:891`). The results never reach the schedule. The
  Portal runs appliance physics only for the pastry bench and the espresso pages.
- **F29. A compiled engine scenario depends on hidden state.**
  `setScheduleSpatialLayout` changes `travelSeconds` for the whole module
  (`schedule.ts:983-1049`), and `financier.ts:65` imports it.

**Builders**

- **F30. The builders have no shared library.** This extends F9. `main` is defined in
  91 files, `write_xml` in 23 and `strip_visual_meshes` in 22. Masses, inertias and
  collision shapes are typed by hand, and only the mass sum is checked.

## Rules for every step

- **A move changes no physics.** The journeys give the same samples and the same
  results before and after. Where a digest includes the engine identity, compare
  the samples.
- **One engine release for each Rust step, at most.** `build.rs` hashes every source
  file, so each Rust edit makes a new engine identity and a new bundle. Steps 2, 3, 5,
  6 and 7 edit Rust. Each of them makes one engine release at most.
- **Measure before and after each step of phase 1.** Record the rows of
  [Targets](#what-the-design-costs-today) in the evidence of the step.
- **A cached result equals a fresh result,** sample for sample.
- **Keep the wire values:** bundle ids, host protocol v5, checkpoint schema
  versions and appliance names.
- **Never remove a bundle that a saved run can name.**
  `scripts/bakery-robots/retain-appliance-builds.mjs` stays the owner of that rule.
  New code gets no reader for an old checkpoint; the old bundle reads it. If the owner
  accepts D4, step 8 changes this rule.
- **E2E journeys, no unit tests.** Each step leaves a text artifact in
  `docs/evidence/refactor-16/`.
- **No recurring server cost.** No step adds a cron trigger, an alarm, a poll or a
  Durable Object write. The engine still loads only when a person or the agent starts
  a job. Step 10 runs only on demand, and an idle Organisation costs nothing.
- **Plan 61B is on hold.** Its code moves with the other recipes, and its journeys
  must still pass. This refactor adds no sesame feature.
- **Stage explicit paths.** Another session edits this checkout.
- **No push, deploy or merge** without the owner's word. No git history rewrite
  (Refactor 10, D1).

## Steps and status

The estimates come from the size of the code. They are not measured. The sum is 66 to
70 days. "Was" gives the label of the first pass (Step) or of the second review (A).

The phases are:

1. **Speed that a person feels:** steps 1 to 4.
2. **One engine:** steps 5 to 7.
3. **Saved runs and build output:** steps 8 and 9.
4. **Reach and start:** steps 10 and 11.
5. **Less code to keep:** steps 12 to 16.

| Phase | Step | Scope                                                                  | Was                | Estimate   | Area owner        | Waits for           | Status                               |
| ----- | ---- | ---------------------------------------------------------------------- | ------------------ | ---------- | ----------------- | ------------------- | ------------------------------------ |
| 1     | 1    | Repair the CI job; tie the source to the pinned bundle                 | Step 1             | 0.5 day    | Plan 70           | —                   | Done locally 2026-11-16; CI run open |
| 1     | 2    | Measure a step, then remove its waste                                  | A5, Step 5G        | 3 days     | Plans 42B and 70A | —                   | Done on refactor-16, 2026-11-16      |
| 1     | 3    | Each cell runs alone to its next event                                 | A1                 | 5 days     | Plan 70A          | —                   | Done on refactor-16, 2026-11-16      |
| 1     | 4    | Reuse a physics result                                                 | A2                 | 6 days     | Plan 70E          | —                   | Done on refactor-16, 2026-11-16      |
| 2     | 5    | One runtime path                                                       | A4, Step 4         | 6 days     | Plan 70E          | —                   | Done on refactor-16, 2026-11-17      |
| 2     | 6    | One safe MuJoCo core in Rust                                           | Step 5A–5F         | 5–6 days   | Plans 42B and 70A | D2 (6F)             | Done on refactor-16, 2026-11-17      |
| 2     | 7    | Check each operation against the robot's limits                        | A6                 | 4 days     | Plan 70           | —                   | Done on refactor-16, 2026-11-17      |
| 3     | 8    | A saved run does not pin a build                                       | A3                 | 4 days     | Plan 70B          | D4                  | Not started                          |
| 3     | 9    | Engine builds and captures out of git; clean build path                | Step 2             | 2–3 days   | Plan 70B, R10 0B  | D1                  | 9A and 9B done 2026-11-17; 9C waits for a check of each capture |
| 4     | 10   | The agent runs a schedule with no open browser                         | A7                 | 5 days     | Plan 81           | D6, Step 4          | Not started                          |
| 4     | 11   | A smaller start                                                        | A10, Step 4 (part) | 4 days     | Plan 70E          | —                   | Done on refactor-16, 2026-11-17      |
| 5     | 12   | One appliance registry                                                 | Step 3A            | 2 days     | Plan 60A          | —                   | Done on refactor-16, 2026-11-17      |
| 5     | 13   | One scene host; playback outside React state                           | Step 6             | 4 days     | Plans 42 and 84   | Step 5              | Done on refactor-16, 2026-11-17      |
| 5     | 14   | A journey index and a wider ratchet                                    | Step 8             | 1.5 days   | Plan 70           | —                   | Done on refactor-16, 2026-11-17      |
| 5     | 15   | Recipe appliance physics: show its report, then appliance work as data | A8, Step 7         | 3 + 3 days | Plan 84           | D5 (15B, 15C)       | 15A done 2026-11-17; 15B and 15C done locally 2026-11-27 |
| 5     | 16   | Builders as data                                                       | A9, Step 3B        | 8–10 days  | Plan 60A          | The next appliances | Not started                          |

### Step 1 — Repair the CI job (F4, F5)

- Install the pins of `scripts/bakery-robots/requirements.txt` in CI. Do not keep a
  second list of versions in the workflow.
- Correct the three import paths in `satyr.yml`.
- Add `workflow_dispatch` to the workflow, so that the job can run for `dev`.
- Add `pnpm lint:physics-bundle`. It hashes the engine source files in the order of
  `build.rs` and compares the result with `controllerSourceHash` of the pinned
  execution bundle. It also checks that each bundle that an execution manifest
  names is present. It needs no MuJoCo, so it runs in the `checks` job.
- Correct the MuJoCo 3.13 text in `crates/bakery-native/README.md:177`.
- The first CI run (2026-11-16) found a third fault. The oven journey asked one
  cell call for six dense operations, about 152 MiB. The native runner refuses a
  cell result above 128 MiB, and the Wasm module cannot encode it. The journey now
  runs its reference as one call for each carrier, about 78 MB each.
- The upload step continues when the artifact storage quota is full, so that the
  job result shows the journeys.

Done when: the `bakery-physics` job passes one time on GitHub, and the lint fails
on a Rust edit that has no rebuild.

### Step 2 — Measure a step, then remove its waste (F20)

- Profile a step first, native and Wasm. The gain is not known before the profile.
- Measure the `mj_forward` call after each `mj_step` (`native.rs:706` and `:2167`).
  Remove it only if every journey keeps its samples. If one sample changes, keep the
  call and record the measurement.
- Look names up one time, and scan contacts one time.
- Sample at 30 Hz, and write samples as typed arrays.
- If the profile shows a gain, build the Wasm with LTO and SIMD.

Done when: the evidence holds the profile before and after, the `mj_forward`
measurement and the rows of phase 1 in [Targets](#what-the-design-costs-today).

### Step 3 — Each cell runs alone to its next event (F19)

- A cell runs in batches to its next visible event. The engine keeps one copy of the
  cell state in memory.
- If an event from another cell falls inside the batch, the cell goes back and runs
  to that tick again (32 steps at most).
- Seal a checkpoint only on pause, save and handoff.
- Then give each cell its own Worker.

Effect: two-cell phases go from 13 times toward the one-cell rate, and N cells use N
cores.

Done when: the two-cell journeys pass, and the evidence holds the speed with two
cells before and after.

### Step 4 — Reuse a physics result (F21)

- Key = engine identity, model hash, held cell state, operation request.
- Value = duration, events, end state, recording.
- Look in memory, then in OPFS.

Against:

- The checkpoint digest includes the step count (`cell.rs:779-806`), and an
  operation starts bit-exact from the live world. The key must leave out the time,
  and it is valid only from a held state.

Effect: a run after an edit computes only the operations that changed. "Run draft"
halves at once.

Done when: a journey proves that a cached run equals a fresh run, sample for sample.
The evidence holds the run time after one edit, before and after.

### Step 5 — One runtime path (F14, F22, F23)

Step 5 replaces the warm path A worker of the first pass. One worker stays warm,
because only one path is left.

- A one-shot command becomes a short program on the persistent cell, through the
  path B worker.
- Delete the command line route in the browser, `Session`, the `step` command and
  the session exports.
- Use one world definition.
- The worker keeps the compiled `WebAssembly.Module` and the model bytes after the
  hash check.
- The worker sends the step count as progress. Stop ends the job at a step boundary
  and keeps the worker.

Effect: the comparison and the run agree, one worker stays warm, and three entry
routes become one. Path A results change, because the table changes.

Done when: the robot comparison and the production run give the same result for one
transfer. A second job makes no request for the Wasm or the models. The page shows
progress, and after Stop a new job runs with no reload.

### Step 6 — One safe MuJoCo core in Rust (F10, F11, F17, F18)

Steps 2 and 5 go first. Step 6 then works on the one engine path that is left. It
makes one engine release.

Moves:

- **6A.** `mj.rs` owns the model and the data, frees them on drop, and gives typed
  slices for positions, velocities, controls and contacts. `unsafe` stays in `mj.rs`
  and in the C interface of `browser.rs`. A lint refuses it in other files.
- **6B.** Split `native.rs` into one file for each engine. The three engines call
  one `ik.rs` and one `servo.rs`.
- **6C.** The espresso and pour-over cells answer with typed structures. The
  TypeScript side parses them with a contract in its owning package (Plan 78).
- **6D.** One checkpoint envelope: schema, kind, engine identity, payload and
  SHA-256. The appliance continuation checkpoint gets a digest.

Behavior changes:

- **6E.** Replace the wall-clock budgets with a count of solver steps.
- **6F.** Apply D2 to the station cells.

Done when: all journeys give the same samples, and a journey saves under the old
bundle and resumes under it after the release.

### Step 7 — Check each operation against the robot's limits (F25)

- The engine reports peak joint speed against the rated speed, the time at the
  torque limit, peak penetration and slip, for each operation.
- Over a limit, the operation warns or fails.
- The robot comparison shows the margins. The journeys assert the margins.

Effect: "this robot can do this move" becomes an answer with evidence, and the
journeys stop as change detectors.

Done when: the robot comparison shows the margins, and the journeys assert them.

### Step 8 — A saved run does not pin a build (F24)

This step waits for D4. It removes the cause of F1.

- A saved run is its inputs, plus the recordings for view.
- "Continue" runs the inputs again on the present engine, then goes on. With steps 3
  and 4 that is fast.
- Exact resume stays inside one engine release.
- Keep the present and the previous bundle only.

Effect: no bundle store that grows, no old protocols, no 29 MB hash on the server,
and one engine in production, so a fix reaches every run.

Against:

- After an engine change, a continued run can differ from its old recording. The
  Portal must say so. This changes a rule of Plan 70B (D4).

Done when: a journey saves a run under one engine release and continues it under the
next.

### Step 9 — Engine builds and captures out of git (F1, F2, F3)

This step stops the growth of the repository.

**9A. A clean build path.** This part needs no decision.

- Give `rustc` a `--remap-path-prefix` for the home folder and the workspace.
- Make the data package from a fixed relative folder, so that `PACKAGE_NAME` is the
  file name only.
- `scripts/bakery-robots/build-browser.mjs` refuses a bundle that contains the home
  folder or the workspace path.
- The compiler flags are part of the engine identity. Do this with the next engine
  release of step 2, 3, 5, 6 or 7, not as a rebuild of its own.
- The 20 old bundles keep their paths. Their content is their address, so they
  cannot change.

**9B. The bundles live in R2.** This part follows D1. If the owner accepts D4, it
holds two bundles, not a store that grows.

- `scripts/repo-binaries.mjs` accepts a folder. It then holds
  `bakery-physics/bundles` and `bakery-physics/executions` in `repo-binaries.json`.
- `build-browser.mjs` and `scripts/production-simulation/build-execution-bundle.mjs`
  upload a new build and change the manifest and the pin.
- Add a guard in `scripts/run-worker.mjs`, beside `requireGatewayBuilds`. It refuses
  a production upload when `apps/portal/dist/bakery-physics` lacks a bundle of the
  manifest, or when a file differs from its hash. Without this guard, a deploy from
  a clean worktree ships a Portal with no engine, and no saved run can resume.
- Add the fetch to the deploy runbook and to the Setup section of `AGENTS.md`.

**9C. The captures.** Use the rule of Refactor 10 step 0B: move each capture that is
larger than 1 MB. A file that a builder, the engine or the Portal reads stays in git.

Done when: a build in a clean worktree gives a `dist/bakery-physics` in which each
file matches its manifest hash. The saved-run resume journey passes on that build.
Under D1 option (a), git tracks no file in `bundles/` or `executions/`.

Result on `refactor-16`, 2026-11-17 ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-16/step-9.md)):
9A is done; the release is runtime `31da6f43…` with execution bundle `3156c877…`.
D1 has no answer, so option (b) applies. The code of 9B and the list of 9C are
ready. The move waits for the owner's yes: the upload to R2, the removal of the
moved folders from git and the move of the captures are not done. Under (b), git
also keeps the runtime bundles `1fa6f270…` and `dc5c58e2…` and six execution
bundles of them, because CI reads them and CI has no R2 secret.

### Step 10 — The agent runs a schedule with no open browser (F26)

This step waits for D6 and step 4. Plan 81 owns the tool.

- A server run with a recorded executor.
- A native task takes its duration and events from the stored summary of step 4.
- With no summary, it takes the declared duration and marks the task as not
  verified.

Effect: "Can we make 60 financiers by 9:00?" works from Slack. Cost: one run on
demand, nothing for an idle Organisation, and one small write for each new operation
result.

Done when: a chat journey from Slack with no open page gets the answer, and a person
without the right stays refused.

### Step 11 — A smaller start (F15, F16, F27)

- One pack for each model, compiled models, one hash and lazy scene imports.
- The worker checks the digest of the recording and parses it. The main thread gets
  the parsed result.
- `_headers` gives `Cache-Control: public, max-age=31536000, immutable` to
  `/bakery-physics/bundles/*`, `/bakery-physics/executions/*` and
  `/bakery-physics/visuals/*`. The folder name is the hash, and the client still
  checks each SHA-256.

Done when: a browser journey records the bytes fetched on a second visit. The
artifact is a table of start times for the first job and the second job.

### Step 12 — One appliance registry (F8)

- Make one table, `assets/bakery-mujoco/appliances.json`: name, model folder, engine
  family, timestep, footprint and asset files. A generator writes the TypeScript
  union, the Rust enum, the footprints and the appliance part of `assets.json`.
  `pnpm lint:appliance-registry` runs the generator with `--check`.
- List all 22 `native.xml` files in the asset list, or record in the table why a
  file is not in it.
- The generated Rust file is engine source. Land it with the next engine release of
  step 2, 3, 5, 6 or 7.

Done when: a new appliance needs one table row and its model folder, and the lint
proves that no other list changed by hand.

### Step 13 — One scene host (F13, F15)

- `apps/portal/src/features/production-run/scene-host.ts` owns the renderer, the
  environment, the camera controls, the resize, the render on demand and the
  dispose. Move the 11 scenes to it one at a time.
- Playback time lives in a small store outside React. The scenes and the timeline
  cursor subscribe to it. React reads only the coarse state: playing, paused and
  the selected task.
- `workflow-simulator/route.tsx` goes below 3,000 lines. Update the ratchet.

Done when: the recipe browser journeys pass, a paused scene draws no frame, and
playback causes no React commit for each frame. The artifact is the count of
commits and frames before and after.

### Step 14 — A journey index and a wider ratchet (F6, F7)

- `scripts/production-simulation/journeys.json` lists each journey: tier (fast,
  slow or browser), backend, owner plan and last measured time. One runner takes a
  tier. CI calls the runner for the fast tier, in place of its hand-written list.
- Delete a journey whose outcome no longer matters (`AGENTS.md`, Testing). List each
  deletion in the evidence.
- The ratchet also covers `crates/**/*.rs` and `scripts/**/*.{mjs,js,py}`. The
  baseline gets `scripts/plan-50/evaluate-pi-durable.mjs` (5,444 lines).

Done when: CI runs the fast tier from the index, and each of the 128 journeys has
a tier and a measured time.

### Step 15 — Recipe appliance physics (F12, F28, F29)

Parts 15B and 15C wait for D5. D3 stays.

- **15A.** Remove the hidden state of F29, so that a compiled engine scenario does
  not depend on `setScheduleSpatialLayout`. This part needs no decision.
- **15B.** Show the report of recipe appliance physics in the Portal run view. A
  failed check marks its task as at risk. Estimate: 3 days.
- **15C. Appliance work as data.** Estimate: 3 days.
  - One table maps a task kind to its appliance, its action and its batch values.
    Each recipe gives its rows as data. One function makes the tasks, and the present
    `executeRecipeApplianceTasks` runs them. The 21 recipe functions go.
  - The canvas compiler (Plan 84) gives the same task kinds, so a recipe from the
    canvas gets its appliance checks.
  - Split `appliance-execution.ts` below 3,000 lines with the scripts of Refactor 10.

Done when: the seven recipe journeys give the same appliance reports. One more
journey shows an appliance report for a recipe that a person edited on the canvas.

### Step 16 — Builders as data (F9, F30)

Do this step when the next appliances are due.

- The 51 scripts read the Blender path from one shared module, with the variable
  `BLENDER` and the present path as its default.
- One builder library and one description file for each appliance. The physics
  builders import one mesh export module.
- MuJoCo computes mass and inertia from density and geometry.

Done when: the appliance journeys pass, and the evidence gives the lines for a new
appliance before and after.

## Deferred

| Item                              | Reason                                                                                                                                                                                                                                                                                     | Cost          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| A narrow engine identity          | Measured: 30 of the 38 engine commits since 2026-09-01 touch the shared files. A hash for each engine family keeps the identity for 8 of them. After step 9, an old bundle costs about $0.0004 each month. Measure again after part 6B. If the owner accepts D4, step 8 removes its cause. | About 3 days  |
| Removal of `schedule.ts`          | Plan 84 D7 (2026-11-14) keeps it: the financier shift, the factory views and the pastry bench run on it. It has 4,602 lines, and 63 files name it. Those three must move to `engine.ts` first.                                                                                             | About 2 weeks |
| A Wasm build in CI                | It needs emsdk 4.0.10 and a MuJoCo build in CI. The lint of step 1 finds a source edit with no rebuild at almost no cost.                                                                                                                                                                  | About 2 days  |
| Appliance results in the schedule | D3. It changes run results, so it needs its own plan.                                                                                                                                                                                                                                      | About 1 week  |
| A git history rewrite             | Refactor 10, D1: it breaks every clone, worktree and open branch.                                                                                                                                                                                                                          | —             |

## Order

Phase 1 goes first, because a person feels steps 2, 3 and 4 in each run. Step 1 is
half a day, and it makes the CI result true. The phases then follow in their order.
Steps 12 and 14 touch other folders and can run beside phases 1 to 3. Step 13 can
also run beside them, but it follows step 5, because both change the workflow
simulator. Each Rust step is one engine release.

## Decisions

- **D1. Where the engine bundles live.** On 2026-11-04 the owner kept them in git
  (Refactor 10, step 0B). CI reads the pinned bundle from its checkout, and the
  owner wanted no new GitHub secret. If the owner accepts D4, only two bundles are in
  the store.
  - (a) Recommendation: a bucket with public read, keyed by hash. CI fetches with
    plain HTTPS and checks each SHA-256, so it needs no secret. The Portal already
    serves the same files with no sign-in. Cost: about $0.01 each month for 0.6 GB,
    and one new public address.
  - (b) Keep the pinned bundle and its execution bundles in git. Move the other 19
    bundles to the private bucket. No new address and no secret. The tree loses
    about 530 MB, but each rebuild still adds about 29 MB to the history.
  - (c) No change. Step 9 then does only parts 9A and 9C.
  - Default with no answer: (b).
- **D2. Substeps for models of 0.5 ms and 1 ms** (the open decision of Plan 70A).
  - Recommendation: admit a whole number of substeps, with events and checkpoints
    on the 2 ms tick. The station cells already step in this way. Cost: 0.5 day for
    an explicit adapter, an admission check and the text in Plan 70A.
  - Default with no answer: keep the code, and record the exception in Plan 70A.
- **D3. Appliance results and the schedule.** The appliance step runs after the
  schedule is complete, and its results go to a report.
  - Recommendation: keep the report only. A failed appliance check does not fail
    its task in this refactor.
  - Default with no answer: the report only.
- **D4. Saved runs (step 8).** Recommendation: a continued run plays its inputs again
  on the present engine. Cost: an old run can change after an engine release.
  Default with no answer: the rule of Plan 70B stays, and D1 decides where the
  bundles live.
- **D5. Recipe appliance physics (step 15).** Recommendation: show its report in the
  Portal run view, and let a failed check mark its task as at risk. Estimate: 3
  days. The other choice is to stop work on it. Default with no answer: parts 15B and
  15C hold.
- **D6. Server runs for the agent (step 10).** Recommendation: yes, after step 4.
  Default with no answer: no.

## Behavior changes

- **Step 1:** the CI job installs MuJoCo 4.0.0, and a new lint runs on each pull
  request.
- **Step 2:** a recording holds samples at 30 Hz, as typed arrays.
- **Step 3:** each cell seals a checkpoint only on pause, save and handoff.
- **Step 4:** a run after an edit computes only the operations that changed.
- **Step 5:** path A results change, because the table changes. A second job starts
  with no download. A job shows progress. Stop keeps the engine.
- **Step 6 (6E):** an operation fails after a fixed count of steps, not after 120
  seconds of real time.
- **Step 7:** an operation over a limit warns or fails.
- **Step 8:** "Continue" runs the inputs again on the present engine. A continued
  run can differ from its old recording, and the Portal says so.
- **Step 9 (9A):** a new bundle holds no local path.
- **Step 10:** the agent runs a schedule with no open page. A task with no stored
  summary is marked as not verified.
- **Step 15:** the Portal run view shows the appliance report, and a failed check
  marks its task as at risk. A recipe from the canvas gets an appliance report.

Every other change is a move.

## Verification

| Step | Proof                                                                                  |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | One green run of the `bakery-physics` job; the lint output for an edit with no rebuild |
| 2    | The profile before and after; the `mj_forward` timing                                  |
| 3    | The two-cell journeys; the speed with two cells                                        |
| 4    | A cached run equal to a fresh run, sample for sample                                   |
| 5    | The robot comparison and the production run give the same result for one transfer      |
| 6    | Sample comparison for each journey; resume under the old bundle                        |
| 7    | The margins in the robot comparison and in the journeys                                |
| 8    | A save under one engine release, continued under the next                              |
| 9    | The hash check of a clean build; the saved-run resume journey on that build            |
| 10   | A chat journey from Slack with no open page; a person without the right stays refused  |
| 11   | The bytes fetched on a second visit; the start-time table                              |
| 12   | The lint output; the appliance journeys                                                |
| 13   | The recipe browser journeys; the commit and frame counts                               |
| 14   | The journey index with measured times                                                  |
| 15   | The appliance reports of the seven recipes; one canvas recipe report                   |
| 16   | The appliance journeys; the lines for a new appliance                                  |

## Not checked

- The CI job was not run. The two faults of F4 come from the workflow file and the
  repository tree.
- The count of saved runs in production.
- The line ranges of F10 and F11 and the count of checkpoint shapes come from the
  review. Only the two step loops of F10 were read again.
- No timing is a reference measurement. This refactor measured no timing of its own.
  Step 2 measures before it changes code.
- The estimates. See [Steps and status](#steps-and-status).

## History

The first pass (2026-11-15) had eight steps. A second review on the same day found
that it tidied the design and did not test it. It warmed the older path. It tidied
code that the Portal does not call. It moved the bundles but kept the rule that makes
them. The owner accepted the review, and this version folds it into one plan.

## Sound parts that stay

- TypeScript owns the plan and Rust owns the physics. The crate does no planning.
- Each runtime bundle, execution bundle and saved run has the SHA-256 of its
  content.
- A run that pauses and resumes in a new process ends with the same digest.
- The same engine runs in the Node journeys and in the browser.
- The server runs no physics, so its cost does not grow with simulation use.
