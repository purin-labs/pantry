# KIT-01 — Orchestration views

The Production page of Kitchen in Purin Pantry lets an operator play a bakery shift
before it starts. The page shows one simulated run in three synchronized views: the
workflow canvas, the resource timeline and the Three.js bakery. The three views share
one run, one selection and one playback cursor. The run comes from a deterministic
scheduler in the browser. It has named bakers, a shared oven, a cooling rack and up to
two simulated FR10 cold workcells with a human transfer between them. A native MuJoCo
recording can settle a robot task, but no simulated result changes stock, orders or a
device. A Sous Chef agent drives the same page through page commands in the Portal chat.
Saves of scenarios and runs stay with the person, who confirms each one on the page.

## What it does

### The page

- The descriptor `workflow-simulator` (`foundation/ui/route.ts`) has the navigation
  label **Production**, the title "Production" and the group `kitchen`. The
  Kitchen switcher opens this page first. The page code loads on demand, so other pages
  do not load the 3D bundle.
- The page has three workspace kinds (`simulator-state.ts`): `shift`, `rehearsal` and
  `production`.

| Workspace    | Heading                          | What it runs                                                                       |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------- |
| `shift`      | "Financier morning"              | The financier finishing shift: batches, bakers, stations, a shared oven and a rack |
| `production` | "Multi-batch production + Robot" | Financier batches with gated cold-tray operations on one or two FR10 cells         |
| `rehearsal`  | "Multi-tray rehearsal + Robot"   | Named trays (A to P) with native operations on the shared cell                     |

- The **Robot rehearsal** item of the **More** menu opens the recording view
  (`physics-replay.tsx`). It plays a native recording alone, with its own recording time.
- The public paths `/workflow-simulator`, `/bakery` and `/floor-plans` open the same
  simulator with a `preview` connection (`workflow-demo.tsx`). That connection has no
  Organisation id and no save transport. `apps/portal/workflow-preview.html` is a dev
  fixture.

### Three views of one run

| View     | What it shows                                                                                                                                                                                                                     | Where                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Workflow | The steps with their state, assignment and current wait. A step selects its task                                                                                                                                                  | `docks/` (shift), `production-workspace.tsx`                |
| Timeline | Shift: tabs Batches, Workers and Equipment (one lane for each of the five stations), and a customer-order track. Production: batches, workers, one lane for each workcell, the transfer buffer, native holds and unresolved waits | `docks/playback.tsx`, `equipment-lanes.tsx`, `timeline.tsx` |
| Bakery   | The Three.js scene: stations, oven doors, batch and worker markers, and the recorded robot cell                                                                                                                                   | `scene.ts`, `spatial/`                                      |

- One selection serves all views and the inspector. Its kinds are `batch`, `station`,
  `task` and `resource` (`simulator/selection.ts`). A workcell selection is a `task` or a
  `resource` of the cell. A shared oven cycle is not a selection kind; the oven lane
  names the cycle of each interval.
- One playback owner drives all views (`simulator/playback-state.ts`,
  `playback-controller.ts`, `simulator-playback.ts`). The controls are Play, Pause,
  Next event, Restart, Speed and a seek scrubber. A workflow plays at 30× or 120×
  (default 120×). A recording plays at 0.25×, 0.5×, 1× or 2×, and a workcell
  recording also at 30× and 120×. Each source keeps a paused bookmark.
- A playback update changes only the time and the playback state (`frameUpdated` in
  `route.tsx`). It settles no task and dispatches no work.
- If the scene does not load, the page says "3D unavailable" and the workflow, the
  timeline and the inspector stay usable. The scene follows `prefers-reduced-motion`.
  The camera has an angled view, a top view and a recenter control.
- The shift workspace opens one dock at a time: `workflow`, `inputs`, `inspector`,
  `timeline`, `scenarios`, `comparison` or `floorPlan`. Below 760 px a dock is a bottom
  sheet. The production workspace has the panels `workflow`, `author`, `details` and
  `files`, and its timeline opens beside a panel.

### The shift and its inputs

- The financier procedure has seven operations on five stations (`financierOperations`
  in `packages/bakery-model/src/bakery.ts`): stage, portion, bake, cool, demould,
  finishCooling and pack. Stage, portion, demould and pack need a baker.
- The defaults and bounds are in `fields` of the same file:

| Input                                                    | Default                   | Bounds                                    |
| -------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| Workers, batches                                         | 2, 3                      | 1–3, 1–6                                  |
| Trays per batch, pieces per tray                         | 2, 24                     | 1–4, 1–96                                 |
| Oven trays, rack trays                                   | 4, 8                      | 1–6, 1–16                                 |
| Stage, portion, bake, cool, demould, finishCooling, pack | 2, 6, 16, 5, 3, 20, 8 min | 1–60 min each                             |
| Oven load, unload                                        | 60 s each                 | 1–300 s                                   |
| Loading window                                           | 2 min                     | 0–30 min                                  |
| Shift length                                             | 120 min                   | 30–720 min                                |
| Oven outage                                              | 10–30 min                 | Inside the shift, the end after the start |

- Each whole batch must fit in both the oven and the cooling rack. If trays per batch is
  more than the oven trays or the rack trays, the inputs are invalid.
- The presets are **Normal morning**, **One worker** and **Oven breakdown**
  (`DemoPreset` in `simulator/demo.ts`). The **Compare** dock replays the normal shift or
  compares the oven outage. It shows the finish time, late and unfinished batches, order
  fulfilment, the peak wait at the café bar and a table for each batch. A person can pin
  a baseline.
- The café order demand has the rush presets `quiet`, `normal` and `weekend-rush`. On
  the order track a person drags, adds and removes customer orders, and imports or
  exports them as JSON. The custom orders stay in browser `localStorage`
  (`pantry.bakeryos.vitrineCustomOrders.v1`).
- The **Scenarios** dock also takes a measured-shift JSON file
  (`docks/measured-shift-import.tsx`). It previews the observed durations. For the
  built-in sample shift only, it stages rounded values in the input draft. An incomplete
  file changes nothing.
- The page labels timings as assumptions, for example "Assumed production timings;
  calibrate with a measured shift." (`production-session.ts`).

### The scheduler

`packages/production-simulation/src/recipes/bakery/schedule.ts` is TypeScript with no
React, Three.js or wall clock. It keeps the café order demand in module state: the rush
preset, the channel filter and the custom orders. The full run and the stepped run use
the same loop.

1. Time is whole seconds from the shift start. Intervals are half-open.
2. At each event time the loop settles running tasks and pickups, applies assumed
   recoveries, moves the oven on, checks for an end, dispatches work and then starts an
   oven cycle.
3. Eligible work goes in order of deadline, release time and batch id. By default batch
   _n_ releases at 120·_n_ s and has the deadline 2700 + 1200·_n_ s.
4. A task starts only when all its resources are free, and it reserves them together.
5. The oven gathers whole batches into one cycle. The loading window opens at the first
   load. The oven is full at floor(oven trays / trays per batch) batches. The cycle
   starts when the oven is full, when the window closes or when no batch is still
   upstream. No cycle starts during an oven outage. All members unload before a new
   cycle. The rack holds batches up
   to its tray capacity; another station holds one batch.
6. An outage stops new work on its resource. A bake that runs continues.
7. A run ends `complete`, `horizon` (unfinished work at the shift end) or `blocked` (no
   future event can start the unfinished work). The last two list the unfinished batches.

A task is `queued`, `running`, `completed`, `recovery-required` or `failed`
(`TaskSnapshot`). Its evidence names the source: `assumed-simulation`, `native-recording`
or `injected-failure`. The scheduler has no physical source.

### Workcells, native evidence and the human transfer

- Each robot resource is an explicit instance with capacity 1
  (`recipes/bakery/workcell-instances.ts`): for cell 1 `fr10-1`, `clamp-1`,
  `cold-tray-1`, `source-table-1`, `rack-slot-1`, `maruzen-shelf-3` and `cold-cell-1`.
  Cell 2 has its own set. A tray chain reserves the arm, the tool, the tray, the source,
  the destination and the cell from staging to clearance. The two cells share no
  instance, so they run at the same time.
- A cell takes one robot model. A native operation with no compatible cell is refused. A
  continuation stays in its predecessor's cell. Staging takes 30 s, clearance 15 s.
- A native attempt is pinned to the workflow fingerprint and the operation
  (`attemptId` in `production-workcells.ts`). The scheduler holds the resources at
  `awaiting-evidence` until a recording arrives. The recording must match the request
  exactly. The same recording again is a duplicate with no effect. A different recording
  for a settled attempt is refused.
- A native failure or runner error is `recovery-required`, and all its resources stay
  held. Dependent work does not start. Only an explicit assumed recovery releases the
  holds; a failed prerequisite still blocks its dependants.
- The human transfer (`HUMAN_CELL_TRANSFER` in `human-cell-transfer.ts`) carries one
  tray from `rack-slot-1` through the one-slot `cold-transfer-buffer` to
  `source-table-2`: pickup 10 s, carry 20 s, placement 10 s, all assumed. An
  interrupted transfer keeps its baker, its reservations and the buffer held until an
  assumed recovery. No MuJoCo state crosses between the two cell models.
- MuJoCo runs as WebAssembly in one Web Worker of the page
  (`production-run/engine-jobs.ts`). Jobs run one at a time, at most 2000 steps for each
  call and 125 s of wall time for each job (`STEPS_PER_CALL`, `MAX_WALL_MS`).
  `BrowserProductionRun` (`browser-production-run.ts`) starts no second run while one
  runs. The scheduler models overlap in logical time.

### Faults and authoring

- `RunFaults` (`recipes/bakery/run-faults.ts`) holds at most one outage, one injected
  failure and one assumed recovery. An outage names a baker or a workcell resource. A
  failure names a stage, clear or transfer task, at most 600 s after its start
  (`MAX_FAILURE_AFTER_SECONDS`). A recovery takes at most 3600 s
  (`MAX_RECOVERY_SECONDS`). Native failures come only from recordings.
- In the production and rehearsal workspaces a person edits tray assignments, the baker,
  prerequisites, earliest starts and manual tasks (at most 60, `MAX_MANUAL_TASKS`). An
  earliest start is before the shift end, and never later than 720 min
  (`MAX_WORKCELL_DISPATCH_SECONDS`). The candidate compiles and previews
  before **Apply**. Apply makes a new run from the shift start; it keeps the previous run
  as the baseline. A cyclic or unsupported graph does not apply.
- A native task after a task with no recording is `blocked`, and its timing stays
  unknown (`workcellTasks` in `workcell-attempt.ts`).
- A card move changes only presentation, not dispatch or the fingerprint.
- The **Rack placement experiment** (`rack-layout-editor.tsx`, `rack-layout.ts`) moves
  the cell-1 rack by X and Y offsets of at most ±600 mm. A solid overlap with the table
  or the robot base blocks Apply. Apply changes the native request layout and clears the
  results of that tray.
- The floor-plan tools move and turn equipment and open or close doors. The plan stays in
  browser storage (`pantry:floor-plan-workspace:v1`).

### Shared scenarios and saved runs

- An admin creates the financier sample (`FINANCIER_SAMPLE_ID`,
  `financier-finishing-cooling-sample`) through entity-plane commands. Repeated setup
  replays the same command ids, so it makes no copies.
- An admin edits one operation duration at a time with the loaded snapshot and the
  operation revision. A stale revision is refused, and the draft stays.
- A **scenario copy** is immutable. It holds the shift inputs, a required timing note and
  the source fingerprint. A **production scenario** also holds the variant, the
  assignments, the manual tasks, the dependencies, the canvas positions and the route.
  The route `cold-racking` has tray assignments on the cold cells. The route `oven-rack`
  has a one-slot oven fixture (`PersistentOvenCell`), an `executionBundleId` and no
  assignments; it compares its settings with the procedure at 1 oven tray. The Portal
  reads both through the commerce graph route. The scenario picker reads 25 copies at a
  time.
- A scenario loads only when its fingerprint matches the live procedure. Otherwise it is
  `bakery_scenario_stale`, and the page keeps the current run. There is no historical
  replay and no "use latest" fallback.
- A **saved run** is an immutable snapshot in R2. Its id is the SHA-256 of its content.
  It holds the exact requests and the accepted evidence. A reopened run replaces the
  current setup and its accepted results only after the person selects **Use saved
  production run**. A save of a known id returns the stored summary.
- A run with native artifacts is staged first, private to the admin who uploads it.
  Publication needs each staged artifact and the retained execution bundle. The stage
  and the publication read the stored artifacts with one R2 listing of the run's
  artifact folder.
- Local files: a production file is `bakery-production-workcells` version 9 on export,
  and an import accepts versions 7, 8 and 9. A rehearsal file is `bakery-rehearsal-run`
  version 4. A file is validated at one boundary and rebuilt through the compiler, so
  stored outcome fields cannot fake a completion.

### Sous Chef on the page

- A Portal turn of an owner or an admin gets 38 page commands, one `bakery_surface_*`
  tool for each (`SURFACE_TOOL_LIST`). FND-09 owns the protocol, and FND-05 owns the
  browser context and the `prepare_context` reveal.

| Group             | Tools (each with the prefix `bakery_surface_`)                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Read              | `inspect`, `read_draft`, `query_tasks`, `inspect_scenario_save`, `inspect_run_save`, `list_saved_runs`                                        |
| View and playback | `control_workspace_view`, `show_production_panel`, `control_baseline`, `control_playback`, `set_view`, `select`, `compare_shift`              |
| Simulation        | `prepare_workcell`, `simulate_workcell`, `stop_simulation`, `accept_candidate`, `discard_candidate`, `run_shift`, `start_production`          |
| Authoring         | `edit_rehearsal`, `edit_production`, `preview_production`, `apply_production`, `prepare_production_control`, `prepare_edit`, `prepare_layout` |
| Floor plan        | `rotate_equipment`, `move_equipment`, `toggle_opening`, `select_floor_plan`, `set_equipment_angle`, `configure_interior`, `reset_floor_plan`  |
| Files and saves   | `file`, `prepare_run_open`, `prepare_run_save`, `prepare_scenario_save`                                                                       |

- A command changes the page as the person's own clicks do. It saves nothing. A
  destructive rehearsal change, a production replacement, a layout proposal, a
  production control and a reviewed edit become a proposal. The person applies it on the
  page (`apply_reviewed_edit` is not a tool command).
- `prepare_run_save` and `prepare_scenario_save` only prepare. The page shows "Review
  shared run save" or "Review and save this scenario" with **Confirm save**. The person
  then sends the normal admin save with `agentEffectId`. Opening a saved run waits for
  **Use saved production run**.
- `bakery_saved_run_read` (`agent-tools/kitchen/saved-runs.ts`) reads saved runs with no
  page: the newest, one exact id, or a list of 8.
- The page refuses a command for an older surface session or epoch, or for a changed
  recording candidate (`stale_surface`). It refuses a command for a changed draft
  (`stale_draft`).

### The shared canvas of a saved appliance run

The `workflow_canvas` room (FND-10) holds the card positions of one saved run of kind
`appliance`. Its document id is `run:<snapshot SHA-256>` (`bakery-canvas-source.ts`).

- The source check reads the run from R2, checks its hash and builds the cards
  (`actors/workflow-canvas-source.ts`). The document holds at most 128 operation ids with
  positions inside `CANVAS_BOUNDS` (x 10–570, y 10–250).
- Members read the canvas and its `workspace_canvas` chat (FND-03). An operator moves and
  undoes, and continues the chat. The agent uses `workflow_canvas_read` and
  `move_object`. A move checks the turn label against each role that reads the room.

## Contracts

- **Portal feature:** `areas/kitchen/ui/features/workflow-simulator/` (route, views,
  docks, `spatial/`), with the page bridge `bakery-surface.ts`. The shared Portal files
  are `features/bakery-surface-effect-bridge.tsx`, `bakery-surface-registry.ts`,
  `bakery-browser-context.ts` and `bakery-workspace-reveal.tsx`.
- **Scheduler and run model:** `packages/production-simulation/src/recipes/bakery/`
  (`schedule.ts`, `production-workcells.ts`, `workcell-attempt.ts`,
  `workcell-instances.ts`, `workcell-input.ts`, `human-cell-transfer.ts`,
  `run-faults.ts`) and `src/simulator/` (`selection.ts`, `playback-state.ts`,
  `demo.ts`, `production-execution.ts`).
- **Model contracts** in `packages/bakery-model/src/`: `bakery.ts` (settings,
  `bakeryFingerprint`), `bakery-procedure.ts` (the procedure reader),
  `bakery-scenario.ts`, `bakery-production-scenario.ts`, `bakery-run-snapshot.ts`,
  `bakery-surface.ts`, `bakery-surface-view.ts`, `bakery-playback.ts`,
  `bakery-persistent-surface.ts`, `bakery-agent-scenario-save.ts` and
  `bakery-canvas-source.ts`. The canvas document is `packages/workflow-canvas-crdt`
  (`workflow_canvas_crdt.v1`, protocol `workflow_canvas_sync.v2`).
- **Entity plane** (COM-01, COM-02), written by `areas/kitchen/server/bakery/`:
  the types `bakery_procedure`, `bakery_operation` (`operation`, `minutes`),
  `bakery_equipment` (`station`, `capacity_trays`), `bakery_scenario` (type revisions 1
  and 2), `bakery_production_scenario` (1 to 5) and `bakery_production_task` (1 and 2).
  The relationships are `bakery_procedure_operation`, `bakery_operation_equipment`,
  `bakery_operation_next`, `bakery_scenario_procedure`, `bakery_production_procedure`
  and `bakery_production_task_member`. A production scenario keeps the dependencies of
  its tasks in its `task_dependencies` attribute.
- **Procedure reader:** two graph reads at depth 1 with a limit of 100. It needs seven
  operations and five equipment records, and it refuses a cursor, a full page or a
  changed merchant revision between the reads. An oven takes up to `ovenTrays` (6) trays,
  a cooling rack up to `rackTrays` (16), and another station up to `traysPerBatch` (4):
  the largest value of the setting that the capacity becomes.
- **Fingerprint:** `bakeryProcedureKey` covers the type, id and revision of each
  procedure, operation and equipment entity and each relationship, apart from
  `bakery_scenario_procedure`. The procedure reader also drops
  `bakery_production_procedure` before the key. So a scenario save, a production
  scenario save or another copy does not stale a copy.
- **R2** (binding `ARCHIVE`): `bakery-runs/<org>/<sha>` for saved runs,
  `bakery-run-prepared/<org>/<user>/<id>` for staged runs and
  `bakery-run-artifacts/<org>/<user>/<id>/<digest>` for artifacts. A write uses
  `etagDoesNotMatch: "*"`.
- **Snapshot kinds** (`bakery-run-snapshot.ts`): `saved` (stored as
  `persistent-production`), `linea-rehearsal`, `eagle-rehearsal`, `bakery-appliance-run`,
  `bakery-orchestration-run` v1–4, `bakery-workcell-experiment` v1–3,
  `bakery-rehearsal-run` v1–4 and `bakery-production-workcells` v3–9. A name has 1 to
  80 characters. A snapshot is at most 16 MiB + 65 KiB (`MAX_RUN_SNAPSHOT_BYTES`). A run
  has at most 512 artifacts of 16 MiB each (`MAX_ARTIFACTS`, `MAX_ARTIFACT_BYTES` in
  `packages/production-simulation/src/saved-run.ts`).
- **Regional D1** (`migrations-regional/0001_current_schema.sql`):
  `bakery_surface_effect_delivery` (`dispatching`, `settled`, `indeterminate`),
  `bakery_surface_timeline_event` (`started`, `settled`, `indeterminate`),
  `bakery_agent_run_save` and `bakery_agent_scenario_save` (`approved`, then `saved`).
- **Actor SQLite:** the Session keeps each page effect in `actor_outbox`
  (`actors/bakery-surface-effect.ts`). Recovery quarantines an effect that it cannot
  read or repair. A quarantined effect whose page delivery still waits as `dispatching`
  ends as `indeterminate`, with its timeline event. The Organisation Actor keeps the canvas in
  `workflow_canvas`, `workflow_canvas_operation`, `workflow_canvas_request` and
  `workflow_canvas_human_change` (`actors/workflow-canvas.ts`).

Routes under `/v1/control/organisations/:id`. A mutation checks the Origin and the CSRF
token:

| Route                                                                                   | Role     | Purpose                                        |
| --------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `POST /commerce/bakery/sample`                                                          | Admin    | Create the financier sample                    |
| `POST /commerce/bakery/operation`                                                       | Admin    | Change one operation duration (1–60 min)       |
| `POST /commerce/bakery/scenario`, `POST /commerce/bakery/production-scenario`           | Admin    | Save a scenario copy; may name `agentEffectId` |
| `GET /bakery/runs`, `GET /bakery/runs/:sha`                                             | Viewer   | List (25 a page) and read saved runs           |
| `POST /bakery/runs`                                                                     | Admin    | Save or publish a run                          |
| `POST`, `GET /bakery/runs/prepared/:id`; `POST`, `GET …/prepared/:id/artifacts/:digest` | Admin    | Stage a run and its artifacts                  |
| `GET /bakery/runs/:id/artifacts/:digest`                                                | Viewer   | Read a published artifact                      |
| `GET /collaboration/workflow-canvas/:docId`, `…/socket`, `GET`, `POST …/chat`           | Viewer   | Canvas snapshot, socket and chat               |
| `POST …/workflow-canvas/:docId/move`, `…/undo`, `…/chat/continue`                       | Operator | Move, undo, continue the chat                  |

The page effect routes `GET /chat/surface-effects` and `POST
/chat/surface-effects/:effectId/receipt` belong to FND-05 and FND-09. The agent tools are
in `areas/kitchen/server/agent-tools/bakery/` (`surface.ts`, `handlers.ts`,
`page-effects.ts`) and `agent-tools/kitchen/` (`saved-runs.ts`, `workflow-canvas.ts`).
The capabilities are `workspace.query` (`bakery_saved_run_read`),
`commerce.entity_plane.context` (`workflow_canvas_read`) and
`commerce.workflow_canvas.move` (`move_object`). The page commands use the `surface`
selection and no capability.

## Rules and limits

| Action                                                                      | Viewer           | Operator         | Admin and owner | Agent                                          |
| --------------------------------------------------------------------------- | ---------------- | ---------------- | --------------- | ---------------------------------------------- |
| Open the page, run and compare a shift, play                                | Yes              | Yes              | Yes             | Page commands of an owner or an admin          |
| List and read saved runs and artifacts                                      | Yes              | Yes              | Yes             | `bakery_saved_run_read` with `workspace.query` |
| Create the sample, change a duration                                        | No               | No               | Yes             | No                                             |
| Save a scenario or a run, stage artifacts                                   | No               | No               | Yes             | Prepares only; the person confirms             |
| Read the canvas and its chat                                                | Yes              | Yes              | Yes             | `workflow_canvas_read`                         |
| Move a card, undo, continue the canvas chat                                 | No               | Yes              | Yes             | `move_object`, inside the label rule           |
| Apply an agent proposal on the page (edit, replacement, production control) | No page commands | No page commands | Yes             | Proposal only                                  |
| Dispatch a physical device                                                  | No               | No               | No              | No                                             |

| Time limit                                     | Value                           | Constant                                                                                      |
| ---------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| Agent save proposal before the person confirms | 15 min                          | `AGENT_SAVE_PROPOSAL_TTL_MS` (`bakery-runs.ts`), `PROPOSAL_TTL_MS` (`agent-scenario-save.ts`) |
| Page effect deadline; simulation effect        | 20 s; 150 s                     | `SURFACE_EFFECT_TTL_MS`, `SURFACE_SIMULATION_TTL_MS`                                          |
| Repair retries of an effect, then quarantine   | 12, back-off up to 15 min       | `SURFACE_EFFECT_REPAIR_ATTEMPTS`, `SURFACE_EFFECT_MAX_BACKOFF_MS`                             |
| Browser engine job                             | 125 s, 2000 steps for each call | `MAX_WALL_MS`, `STEPS_PER_CALL`                                                               |

- **Retention.** Saved runs, staged runs, artifacts and the four D1 tables have no time
  limit. The Organisation purge erases the four D1 tables and the R2 objects under
  `bakery-runs/`, `bakery-run-prepared/` and `bakery-run-artifacts/`
  (`data/purge-catalogue.ts`).
  An unsaved draft stays in page memory only.
- **Information flow.** A saved-run read and a canvas read enter the turn under the
  `saved_bakery_run` label, which all four roles read. A canvas move passes the exit
  check of FND-07. A page command receipt carries no source label. A shared chat carries
  no Kitchen page, and a canvas chat prompt has no page (FND-09). File bytes stay in the
  browser, and the Kitchen state is at most 16 KiB.
- **No commerce or device effect.** The page calls only the bakery routes above and the
  page effect routes. None of them writes `production_batch`, stock, orders, Cases or
  task receipts. An imported recording is unauthenticated
  simulation evidence and grants no robot authority.
- **Out of scope:** mobile carriers, navigation and collision avoidance; a mixed-recipe
  oven; mid-run edits and branches; an optimizing solver; multi-site scheduling; CAD
  import; food safety, shelf life or doneness from simulation output.
- **KIT-02** owns the physics: MuJoCo cells, the native runner, recordings, checkpoints
  and the equipment models. This spec owns how the run uses their evidence.
- **KIT-03** owns the recipe workflows in `features/production-run/` (siphon, latte,
  black sesame, ginger tea, the three financier stages and the café shift) and the
  `workflow_draft` room. They run on the kernel engine of `production-simulation`, not
  on `schedule.ts`, and share only the browser engine worker.
- **Plan 24** owns physical bake runs, the Bakes page, `BakeRunActor`, dispatch and
  receipts. The Three.js bakery does not show a physical run. **DEV-01** owns devices.
- **FND-09** owns the tool catalogue and the page effect protocol. **FND-05** owns the
  browser context and the reveal. **FND-10** owns rooms. **FND-07** owns labels.
  **COM-01** and **COM-02** own the entity plane.

## Open work

- The Portal has no client of the `workflow_canvas` room. Only the server side and the
  E2E journeys use it. A canvas for a procedure source is not built: the code accepts
  only `run:` identities.
- Calibration is open: no real shift, observed bake or transfer trial has arrived. The
  labels "Simulation · Assumed timings" and "Recorded simulation · Uncalibrated" are not
  built; the page uses the shorter texts above.
- The shift scene (`scene.ts`) has no `webglcontextlost` handler, unlike the other scenes.
- One spatial view of both cells and the buffer, parallel browser workers, other handoff
  routes, new manipulation skills and automatic recovery planning are not built.
- Chat parity is partial: the recording view has no chat file import or export, and no
  page command opens a saved scenario. The full signed-in release journey (setup,
  simulate, accept, save, reopen, Stop, revoked access) has not run on both model routes.
- Two-member editing of a scenario and the cross-member walkthrough are deferred. A
  standalone shift-scenario JSON file is not built. Old scenarios do not replay against
  an older procedure revision.
- Only the Organisation purge deletes the R2 runs, staged runs and artifacts. A staged
  run that is never published stays until then.

## Sources

- [Plan 42](../../../history/plan-42-bakery-workflow-simulator.md),
  [Plan 42E](../../../history/plan-42E-chat-canvas-parity.md) and
  [Plan 42F](../../../history/plan-42F-general-orchestration.md). Where they differ from the code,
  this spec follows the code. Background:
  [Plan 24](../../../plan-24-cafeos-bakery-automation.md).
- Evidence in the archive: the
  [status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md),
  [integrated acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-integrated-acceptance.md),
  [browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-browser-acceptance.md),
  [shared saves](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-shared-production-saves.md),
  [42E playback](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-playback-2026-09-27.md),
  [42E scenario files](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-scenario-files-2026-10-01.md),
  [42F two cells](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-two-cell-scheduling-2026-10-01.md),
  [42F human transfer](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-human-transfer-2026-10-01.md),
  [42E/F closeout](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42EF-closeout-2026-10-01.md),
  [calibration intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md).
- E2E journeys in `workers/platform/tests/e2e/`: `bakery-runs.test.ts`,
  `bakery-run-artifacts.test.ts`, `bakery-appliance-runs.test.ts`,
  `bakery-agent-canvas.test.ts`, `bakery-procedure-access.test.ts`,
  `bakery-surface-quarantine.test.ts`, `canvas-chat-signals.test.ts` and
  `chat-kitchen-observation.test.ts`.
- Journeys in `scripts/`, indexed in `scripts/production-simulation/journeys.json`. In
  `production-simulation/`: `verify-two-cell-journey.mjs`,
  `verify-two-cell-workspace-browser.js`, `verify-batch-journey.mjs`,
  `verify-recovery-journey.mjs`, `verify-comparison-matches-run.mjs` and
  `verify-playback-fidelity.mjs`. In `bakery-robots/`: the journeys whose owner in the
  index is Plan 42E or Plan 42F, for example `verify-production-authoring.mjs`,
  `verify-cell-robot-bindings.mjs`, `verify-chat-production-browser.js` and
  `verify-rehearsal-faults-browser.js`.
