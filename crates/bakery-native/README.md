# Bakery native simulation

Rust runs cold FR10 table-to-rack transfers, shelf-3 oven loading and retrieval
of the same tray. TypeScript owns authoring, scheduling, resource allocation,
evidence acceptance and the synchronized portal views. There is no hardware I/O.

## Build without Python

Install Rust 1.97 and libclang, then install the checksum-pinned MuJoCo 4.0.0 SDK:

```sh
node scripts/bakery-robots/install-native-sdk.mjs /tmp/bakery-sdk
export MUJOCO_DIR=/tmp/bakery-sdk
cargo build --locked --release --manifest-path crates/bakery-native/Cargo.toml
```

The installer supports macOS arm64/x64 and Linux arm64/x64 and verifies the
published release archive SHA-256 before extraction. The native crate stays
outside the default Cargo workspace; commerce and portal builds need no SDK.

## Execute and resume

Run from the repository root. Outputs must use new filenames.

```sh
crates/bakery-native/target/release/bakery-native --output /tmp/request.json prepare
crates/bakery-native/target/release/bakery-native --output /tmp/recording.json run /tmp/request.json

crates/bakery-native/target/release/bakery-native --output /tmp/paused.json --pause-after lift run /tmp/request.json
crates/bakery-native/target/release/bakery-native --output /tmp/resumed.json resume /tmp/paused.json

crates/bakery-native/target/release/bakery-native --output /tmp/oven-request.json prepare --task table-to-oven
crates/bakery-native/target/release/bakery-native --output /tmp/handoff.json load /tmp/oven-request.json
crates/bakery-native/target/release/bakery-native --output /tmp/cycle.json unload /tmp/handoff.json
```

`cycle REQUEST` runs loading and retrieval continuously. `load` and `unload`
also accept `--pause-after`; resuming paused loading retains its handoff output,
and resuming retrieval retains the accepted loading prefix. Only successful
nominal oven loading can hand off. Retrieval preserves integration time, solver
state and servo targets. It never initializes a new pose or chooses a new IK branch.

Preparation accepts `--case nominal|blocked|unreachable|slip`, plus `closed-door`
for oven loading, and `--timestep 0.001|0.002`. Retrieval requires nominal loading.
A failed operation produces failed evidence; malformed inputs exit unsuccessfully
without creating an output. A terminal recording cannot resume as a checkpoint.

Requests (v2) pin separate asset, controller and runtime hashes. Portable
recordings (v3) contain those identities, observed geometry, samples and a
completed/failed/execution-error outcome. Pending native checkpoints (v1) contain
full integration state, controller progress, contact mutations and the recording
prefix. Completed loading handoffs (v2) include the exact native result and its
portable recording, protected by a corruption digest. These local files do not
provide authenticity or physical dispatch authority. The portal migrates old
recordings only at import; Rust accepts its current native contracts exclusively.

Open a recording, handoff or sequence in the portal. Explicit evidence acceptance
changes the local run; playback and import alone cannot settle a task. Saved
portal runs preserve accepted loading while retrieval is pending. Keep the native
handoff separately for continued simulation.

## One-shot commands as host programs

`serve` and the browser module (`bakery_cell_command` in
[`browser.rs`](src/browser.rs)) answer one protocol. Besides the cell
commands, it runs each one-shot command as a program in bounded calls
([`program.rs`](src/program.rs)): `prepare`, then `open` with a program
(`run`, `load`, `cycle`, `oven-handoff`, `unload`, `rack` or `comparison`),
`advance` with a step count, and `close`. A running program replies with the
step of its present operation and that operation's expected length. A
finished program replies with the output file, byte for byte as the command
line writes it. `close` ends a job at its last step boundary; the host and
its other jobs stay.

The robot comparison is the `comparison` program. Its table-to-rack transfer
runs on a new persistent rack cell that rests until it offers its hold, takes
the tray, rests again and starts, as the first transfer of a production run
does. Its table-to-oven transfer is a one-shot transfer, because no
persistent cell has the standalone oven fixture.

The same protocol defines cells (`define`, with an optional `grinder` for
the espresso and pour-over cells) and runs appliance requests (`appliance`).
Every host of the browser module uses only this protocol: the module has no
command line and exports no `callMain` (Refactor 16, step 11).
[`verify-host-programs.mjs`](../../scripts/production-simulation/verify-host-programs.mjs)
checks every program against its command line on the native runner, and in
Wasm against the same program in one call.

The browser module holds no model files. The runtime bundle keeps them in
model packs (`models.json` and `models-<name>.pack`, one for each robot and
each appliance with meshes, and a core pack;
[`model-packs.ts`](../../packages/production-simulation/src/native/model-packs.ts)).
A host checks the SHA-256 of each pack once and writes its files into the
module. A command that needs a file that is not there is refused with
`"missing": "<path>"` and changes nothing; the browser worker then mounts
that file's pack and sends the command again. The module does not hash the
files again.

## Keep one cell across operations

`cell` (native only) applies a list of actions to a persistent cold cell and
writes its checkpoint envelope and digest (`{ content, digest }`, as the
host's `export` gives them). The world is never reset: the next request
continues from that checkpoint (`{ kind: "continue", content, digest,
sequence }`) in any process built from the same runner. The host commands
cover the same actions; `cell` stays for the hold journeys, which rest an
idle cell for hours in one call.

```sh
bakery-native --output /tmp/definition.json prepare-cell
bakery-native --output /tmp/cell.json cell /tmp/request.json
```

A request names a new definition or an earlier checkpoint, then its actions:
`admit` and `remove` a carrier, `start` a rack transfer, `advance` a number of
steps, or `finish` the running operation. An empty cell keeps its one carrier
body parked below the floor with its collisions off. Admission places it at
rest on the source table; removal parks it again once the tool has released
it. Both write only the carrier body. Each admission starts a new binding
generation.

An operation starts from wherever the arm is. After a transfer the arm stays
at its retracted pose, so the next plan begins with `return_lift` and
`return_traverse` before the usual approach. A reference block rests on the
table throughout and no operation touches it. A cell steps at 2 ms only.
[`verify-persistent-cell.mjs`](../../scripts/production-simulation/verify-persistent-cell.mjs)
is the repeatable campaign, including the settled-hold comparison.

### Serve a factory host

`serve` keeps cells resident and answers one JSON command per input line:
open or restore a cell, prepare a carrier admission or removal and then
commit or discard it, start an operation, advance by at most a step
allowance, and export the checkpoint. An advance returns at a pickup, at the
operation's end or when the allowance runs out. A refused command replies
with its reason and leaves the cell unchanged.

```sh
bakery-native --output /tmp/closing.json serve
```

An idle advance also reports the settled hold the cell may enter, once it
has rested for a second within the hold's limits.
The browser build answers the same commands through `bakery_cell_command`.
The production engine drives a cell through this protocol; see the
[single-cell journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-70-j1-engine-cell-journey.md).

## Package for developers or a heavy executor

```sh
MUJOCO_DIR=/tmp/bakery-sdk node scripts/bakery-robots/package-native.mjs /tmp/bakery-package
/tmp/bakery-package/bakery-native --output /tmp/packaged-request.json prepare

docker build -f crates/bakery-native/Dockerfile -t satyr-bakery-native .
docker run --rm -v /tmp/bakery-results:/work satyr-bakery-native --output /work/request.json prepare
```

The package includes the runner, native library/licenses, verified model inputs
and referenced meshes/visuals. It can move independently of the checkout and SDK.
The Debian image is an offline CLI environment suitable for executor jobs; it
adds no cloud service or dispatch endpoint. Native checkpoints remain bound to
the exact controller/runtime build, including target and compiler identity.

## Verification and asset rebuilds

```sh
MUJOCO_DIR=/tmp/bakery-sdk node scripts/bakery-robots/verify-native.mjs /tmp/bakery-campaign
node --experimental-strip-types scripts/bakery-robots/verify-timeout-recovery.mjs /tmp/bakery-timeout-campaign
node --experimental-strip-types scripts/bakery-robots/verify-container-recovery.mjs satyr-bakery-native /tmp/bakery-container-campaign
cargo fmt --manifest-path crates/bakery-native/Cargo.toml --check
MUJOCO_DIR=/tmp/bakery-sdk cargo clippy --manifest-path crates/bakery-native/Cargo.toml --all-targets -- -D warnings
```

The campaign compares against retained Python migration observations, checks
nominal/fault/half-timestep outcomes and motion, resumes every nonterminal phase
in fresh processes, compares continuous and handed-off retrieval exactly, and
rejects mismatched requests, corrupt state and terminal-as-checkpoint inputs.
Set `BAKERY_NATIVE_BINARY` to a packaged executable or container wrapper to run
that same campaign without rebuilding. See the [reference provenance](../../scripts/bakery-robots/reference-recordings/README.md)
and [acceptance evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-native-boundary.md).
The timeout campaign produces request, checkpoint, handoff, recording and
`report.json` artifacts for the combined workflow, including host signal
interruption from each phase checkpoint. The container campaign uses the image
built above to terminate actual offline containers and resume preserved
checkpoints in fresh containers. Use a new output directory
for every run; see [timeout evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42B-timeout-recovery.md).

Python remains an **asset-build dependency only**. The checked-in XML and source
states are generated by `scripts/bakery-robots/build_native_assets.py` using the
pinned asset environment. The builder requests 17-digit XML serialization through
the exported precision hook of MuJoCo 4.0.0 (`_mjPRIVATE__set_xml_precision`); the
default of six digits changed retrieval contact timing. Every model input, source
state and referenced mesh/visual is hashed in `assets.json`, whose digest is
compiled into the runner. Rebuilding assets or controllers requires new requests
and the full acceptance campaign. `pnpm lint:physics-bundle` fails when a file in
the `controller_files` list of `build.rs` changes and the pinned browser bundle
was not rebuilt.

The appliance list has one source, `assets/bakery-mujoco/appliances.json`.
`node scripts/bakery-robots/appliance-registry.mjs` writes `Name`, `Name::ALL`
and `Name::folder()` in `src/appliances.rs`, the TypeScript `ApplianceName`
and `parseName`, and the appliance entries of `assets.json` from it. Do not
edit those lists by hand; `pnpm lint:appliance-registry` refuses a difference.
A new appliance needs a table row, its model folder and its engine code (the
`Controller` arm in `src/appliance_run.rs` and its `Port`). The new row changes
`src/appliances.rs`, so it is an engine release.

## Combined oven, table and cooling rack

The combined fixture retains the fixed-open oven and adds an open receiving
rack beside the source table. It has a separate model identity. Start with
oven loading, then retain both completed native states:

```sh
bakery-native --output /tmp/combined-request.json prepare --robot fanuc-crx10ial --task table-to-oven --cell combined
bakery-native --output /tmp/loaded.json load /tmp/combined-request.json
bakery-native --output /tmp/returned.json unload --for-rack /tmp/loaded.json
bakery-native --output /tmp/oven-rack-cycle.json rack /tmp/returned.json

# Same live Engine throughout all three operations:
bakery-native --output /tmp/continuous-rack.json cycle --to-rack /tmp/combined-request.json

# Pause/resume each leg; retrieval retains its rack-handoff completion mode:
bakery-native --output /tmp/rack-paused.json --pause-after lift rack /tmp/returned.json
bakery-native --output /tmp/rack-resumed.json resume /tmp/rack-paused.json
```

Use the packaged `bakery-native` command or the release binary path from the
build section. `--cell blocked-rack` and `--cell unreachable-rack` prepare
versioned fault fixtures. `rack --case slip` or `cycle --to-rack --rack-case slip`
injects the existing grip-loss fault during the final transfer. All keep the
same native model across loading, retrieval and rack transfer. A failed leg
produces evidence for that failure and cannot emit a successor handoff.

The combined sequence contains the successful loading/retrieval prefix and the
rack outcome, including both handoff digests and each distinct attempt identity.
The portal validates the whole file and opens its final rack transfer in the
existing single-transfer workflow. It renders both oven and rack geometry and
can save/reopen accepted rack evidence. The portal's authored oven-cycle
workflow still covers loading and retrieval; authoring a three-operation
workflow remains outside this fixture extension. Preserve the native sequence
and handoffs separately for their complete history and resumable state.

The [combined acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-5-combined-fixture.md)
records layout, unchanged acceptance thresholds, phase resumes and fault results.

## Bounded rack translation

The standalone nominal table-to-rack fixture accepts integer offsets of −600 to
+600 mm on each horizontal axis. Request schema 6 carries the layout explicitly;
zero offsets canonicalize to the fixed layout. Height and yaw remain fixed.

```sh
bakery-native --output /tmp/moved-request.json prepare --rack-x-mm 200 --rack-y-mm 0
bakery-native --output /tmp/moved-recording.json run /tmp/moved-request.json
```

The rack body, child geometry and receiving site move before model compilation.
The exact layout participates in model/request/checkpoint identity. A supported
offset may be obstructed or unreachable; simulation determines the outcome.
The UI additionally blocks confirmed static solid overlaps before Apply.
See [layout acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42D-layout-experiments.md) for
matched browser/native cases, lifecycle verification and retained artifacts.

## Robot and load selection

`prepare --robot` selects an existing arm. `--ingredient-mass-kg` sets total
ingredient mass from 0–4 kg, excluding tray and tool. The default is 1 kg.
`--ingredient-forward-mm` and `--ingredient-lateral-mm` set integer offsets from
the tray center, bounded by ±100 mm and ±60 mm. Both default to zero.
`--clamp-force-n` sets the prototype clamp limit from 20–100 N, defaulting to 100 N.
Request version 7 preserves these values through recordings and continuations.
MuJoCo recomputes the combined tray inertia before simulation.
These input bounds do not establish manufacturer payload or gripper ratings.

The planner checks static gravity torque against the arm's existing actuator limits.
A rejected path reports `actuator-limit`. Runtime collision checks remain active.
Use [the repeatable comparison and workcell acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/robot-selection-and-comparison.md)
to inspect layout, load, recovery and browser parity evidence.
