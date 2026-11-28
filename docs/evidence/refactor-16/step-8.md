# Refactor 16 — Step 8 evidence (part 8A)

Date: 2026-11-28
Branch: `refactor-16` (from `origin/dev` at `f6dd43ff`)
Pinned runtime bundle: `468e95da77e3e1c4c1586f4c74b8a4a5b8cf8c3d5332ec65a52988db71f2a017` (not changed; no Rust edit)
Pinned execution bundle: `bc455d5608beb5b9b43e4828303eafd4549d21ca40533c4b00879ae233a19da3` (host protocol 6)
Earlier pin: `5bf61fd606c468c8d9237738d76c325bfd3bdbea4d9f579df119c7406a3d0867` (host protocol 5)

The owner accepted D4 on 2026-11-28: a continued run plays its inputs again on the
present engine. Part 8A changes how a save continues. Part 8B (the removal of the old
bundles) is not done; see [the plan](../../refactor-16.md#step-8--a-saved-run-does-not-pin-a-build-f24).

## 1. What a save of another build does now

| Subject                             | Before                                                           | After                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A save of the pinned build          | The Portal restores its checkpoints                              | The same                                                                                    |
| A save of another build             | The Portal starts the worker of that build; no file, no continue | The pinned engine runs the inputs of the save again, to the place where the save stopped    |
| A route that another build authored | The Portal starts the worker of that build (`executionBundleId`) | The pinned engine defines the cell again and runs the route                                 |
| The page                            | "Cannot start this run: inspection_only."                        | A notice before the run, a disabled control during it, and a report of the first difference |
| The server, for each resumable save | Reads and hashes the engine and each runtime file (about 33 MB)  | Reads no engine file                                                                        |
| Host protocols in the Portal client | 1 to 5                                                           | 6                                                                                           |

Files: `packages/production-simulation/src/replay.ts` (the plan of a replay, its
cursor, the rebind of a cell and of a scenario, the report),
`execution-host.ts` (the origin `replay`, the cells of another build),
`saved-run.ts` (`openSaved`), `areas/kitchen/ui/features/production-run/execution-client.ts`
(one bundle), `saved-run-continuation.ts` (the origin and the page texts),
`oven-workspace.tsx`, `areas/kitchen/server/control/routes/bakery-run-artifacts.ts`.

Rules that the journeys found:

- A host that restores a paused save goes on with no resume command. A chain of
  restored saves therefore holds pauses with no resume between them. The replay
  releases a pause when the next command, or the save, belongs to another execution.
- A cell definition holds inputs (the weak clamp of the failure fixture is one). A
  cell that the engine defines again keeps the inputs of the saved definition and
  takes only `execution` and each model hash of the present build.
- The run page showed its notice only inside a detail panel. The notice of a replay is
  now also above the run controls.

## 2. Journey `file-execution`: a save of release A continues on release B

`node scripts/production-simulation/run-journeys.mjs --id file-execution`
(`verify-file-execution.mjs`, the 24-order route, separate Node processes on the Wasm
engine). Release A is the execution bundle `8ecd88c1…` on the runtime `c9f6e8cc…`.
Release B is the pinned bundle. Release B holds no file of release A; the journey
asserts that.

| Run                                    | Bundle      | Origin   | Run time (s) | End status | Wall time (s) | Replay                                              |
| -------------------------------------- | ----------- | -------- | -----------: | ---------- | ------------: | --------------------------------------------------- |
| 1. Release A saves at a pause          | `8ecd88c1…` | scenario |          160 | paused     |           4.3 | —                                                   |
| 2. Release B continues that save       | `bc455d56…` | replay   |         6713 | completed  |          80.3 | 1 of 1 commands, none refused, no difference, 4.7 s |
| 3. Release B runs from the start       | `bc455d56…` | scenario |         6713 | completed  |          77.9 | —                                                   |
| 4a. Release B saves at a pause         | `bc455d56…` | scenario |          160 | paused     |           2.2 | —                                                   |
| 4b. Release B restores after host loss | `bc455d56…` | snapshot |         6713 | completed  |          76.5 | —                                                   |
| 5. Release B runs its own save again   | `bc455d56…` | replay   |          160 | paused     |           2.0 | 1 of 1 commands, none refused, no difference, 1.9 s |

The journey took 246 s. Release A's recording and release B's replay of the same
inputs have the same task times up to the pause (the report of run 2 has no
difference).

Assertions that passed:

- Run 2 reports a replay of the snapshot of run 1: one command (the pause), applied,
  none refused; it stopped at the saved time, paused. The run then completed under the
  bundle of release B, with the run id of the save and the save as its parent.
- The events and the final state of run 2 equal those of run 3 (a run that release B
  makes from the start, with the cells that release A defined). Admission events of
  commands are left out, as before.
- Run 4b restores the checkpoints of run 4a after the host process was killed
  (`SIGKILL`), and it equals run 3.
- Run 5 is a replay on one engine. Its report has no difference, and its events equal
  the saved events of run 4a.
- Refused: a missing engine file, an altered engine file, an altered checkpoint (for a
  restore) and an edited input of the save of release A (`snapshot_differs`).

The recovery journey (`verify-recovery-journey.mjs`, journeys `recovery-wasm` and
`recovery-native`) also replays its continued run in one fresh host: two recoveries
and two pauses that a fresh host continued from. The replay applies the four commands,
refuses none, reports no difference, and ends with the events and the state of the
uninterrupted run. It ran here on the Wasm transport.

## 3. Browser journeys

Run with a Portal dev server on port 5294 (`--base-url http://127.0.0.1:5294`).

| Journey                      | Result | Time (s) | What it proves for step 8                                          |
| ---------------------------- | ------ | -------: | ------------------------------------------------------------------ |
| `contact-inspection-browser` | passed |     17.3 | The run page continues a save of an older build by replay          |
| `engine-cell-browser`        | passed |     22.3 | Restore of four saves; a replay of the last save equals the run    |
| `oven-financier-browser`     | passed |     43.9 | A route that another build authored runs on the present engine     |
| `shared-artifacts-browser`   | passed |     22.7 | The older save is staged, published and continued from a workspace |
| `oven-authoring-browser`     | passed |        — | An authored oven route starts on the one pinned worker             |

The journey `contact-inspection-browser` writes `continued-on-present-engine.png`: the
run page after the saved inputs ran again, with the notice above the run controls.

- **`contact-inspection-browser`** opens `bakery-persistent-failure.json` on the run
  page. The execution bundle `aad23dca…` made that save (host protocol 4). The page
  shows "An earlier engine made this save. Continue runs its inputs again on the
  present engine. The results can differ from the saved recording." After **Continue
  saved run** it shows "The saved inputs ran again on the present engine. Each task has
  the times of the saved recording." The transfer fails again (the weak clamp is an
  input), and the contacts on the page equal the contacts in the save that the page
  exports. That export names the pinned bundle.
- **`engine-cell-browser`** pauses, saves, destroys the worker and restores four times,
  as before. It then runs the last save again from its inputs: four pauses, three
  released, none refused, no difference, and the run stops at the last pause. A command
  during the replay is refused (`replaying`). After a resume the run ends with the
  events and the state of the uninterrupted run. A replay of an edited save is refused.
  The part that ran four older bundles in the page is gone: the client starts no old
  bundle.
- **`oven-financier-browser`** gives the engine a route with the cell of another build
  (another runtime hash and another model hash). The `began` reply returns the present
  definition, and the scenario of the run equals the present scenario except for the
  source revision of the route. The two refusal cases of the old client
  (`inspection_only`, `fixture_bundle_mismatch`) are gone with that client code.

## 4. Checks

- Regression on the final bundle: 41 journey runs passed and none failed for a reason
  of this change. The headless Wasm journeys `two-cell`, `batch-cycles`, `oven-wasm`,
  `spanner-oven-wasm`, `oven-engine`, `financier`, `schedule-layout`,
  `native-financier`, `oven-financier`, `recovery-wasm`, `workflow-branch`,
  `recurring-logistics` and `artifact-handoff` passed. Of the set `ci-browser`, 22 of
  23 passed (`oven-authoring-browser` with its fixture server on another port,
  because another session held port 5197). `robot-selection-artifacts` needs the native
  binary and did not run. `artifact-storage-browser` and `artifact-import-browser`
  passed.
- Types: `tsrs --noEmit` in `packages/production-simulation` (both projects),
  `apps/portal` and `workers/platform` (source, tests and E2E projects): no error.
- `pnpm lint:static`: each lint passes (file size, Kitchen DOM, layers, journey index,
  lint paths, doc links, clones, unused exports, physics bundle, appliance registry).
  The clone count fell from 734 to 730 copies.
- `pnpm lint:physics-bundle`: the source matches the execution bundle `bc455d56…` on
  the runtime `468e95da…`.

## 5. Not run, and limits

- The Platform E2E files (`bakery-run-artifacts.test.ts`, `bakery-runs.test.ts`,
  `kitchen-files-erasure.test.ts`) were not run on this machine. Their types pass. The
  server change removes a check; it adds none.
- The native runner was not built here (a worktree under the main checkout cannot build
  the crate), so the journeys of the native backend were not run. The change has no
  Rust edit. The same TypeScript host runs on the Wasm transport in the journeys above.
- The machine ran other sessions (load average 12 to 27), so the wall times are slow.
  They are not reference measurements.
- A replay of a long run takes the time of the run: the 24-order route replays 160 s of
  kitchen time in about 2 s, and the full 6,713 s in about 75 s on an idle machine.
- The 3D recording of a save of another build does not open. The replay makes the
  recording again.
- A recovery of the saved run waits for its failure; the journeys `recovery-wasm` and
  `recovery-native` cover that on one engine (section 2). No journey replays a save
  with an inspection command, and no journey has a command that the present engine
  refuses. Those rules are covered only by the type check and by reading.
- The agent gets no new command. Before and after this step, the page surface of a
  saved run offers `inspect_surface` only, so a person presses **Continue saved run**.
  While the saved inputs run again, the page reports the run as not live, and a
  proposed control waits. The replay notice is not in the surface view of the agent.
- No production data was read or changed. Part 8B (the removal of bundles) is not done.
