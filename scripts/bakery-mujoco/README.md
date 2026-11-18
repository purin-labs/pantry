# Bakery model authoring and acceptance

BakeryOS executes MuJoCo through `crates/bakery-native`. The same Rust controller
builds as a native executable and as the browser Wasm module. The TypeScript
scheduler owns dependencies, resources, accepted results and recovery.

Python in this directory authors Blender assets, exports MuJoCo geometry, and
submits acceptance requests to Rust. It contains no appliance or robot controller.

## Build and verify

Install the pinned authoring dependencies when exporting models:

```sh
python3 -m venv scripts/bakery-mujoco/.venv
scripts/bakery-mujoco/.venv/bin/python -m pip install -r scripts/bakery-mujoco/requirements.txt
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/export_native_appliances.py
```

Build the native executable and run the complete appliance journeys:

```sh
MUJOCO_DIR="$PWD/scripts/bakery-mujoco/.venv/lib/python3.11/site-packages/mujoco" cargo build --release --manifest-path crates/bakery-native/Cargo.toml
python3 scripts/bakery-mujoco/verify_rust_appliances.py
python3 scripts/bakery-mujoco/verify_rust_planetary.py
python3 scripts/bakery-mujoco/verify_rust_handling.py
python3 scripts/bakery-mujoco/verify_rust_storage.py
python3 scripts/bakery-mujoco/verify_rust_cleaning.py
python3 scripts/bakery-mujoco/verify_rust_espresso.py
```

Each journey writes requests, recordings and a report under
`assets/bakery-mujoco/combined-bakery/rust-evidence`. Each request uses the same
`appliance` command and checkpoint format as the browser worker.

For Plan 60A numerical acceptance, run all appliance journeys at nominal and
half timesteps in a fresh evidence directory:

```sh
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/verify_appliance_mechanics.py output/acceptance/plan-60A/fresh-mechanics --sdk output/acceptance/release-20261009/sdk
```

Use repeated `--suite` arguments to select existing journeys, for example
`--suite appliances --suite cleaning`. The 5 mm position gate compares final
poses and aligned motion samples for washer recordings that move the rack.
Sample agreement does not establish accuracy between samples or physical calibration.

Use a pinned MuJoCo SDK path for `--sdk`. This command copies source and model
inputs, builds both variants, and retains hashes, requests, recordings and logs.
It includes pan misalignment/recovery for both hobs. Its numerical tolerances
are independent of physical calibration.

Individual Rust journeys accept `BAKERY_APPLIANCE_OUTPUT`,
`BAKERY_APPLIANCE_MODEL_ROOT` and `BAKERY_APPLIANCE_RUNNER` for isolated campaigns.
Without these values, they use the repository models, release runner and the
existing evidence location above.

Use the BakeryOS appliance workspace for playback, cancellation, resume,
workspace saves and shared canvas positions. The
[execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md)
records browser acceptance and remaining recipe scope.

The `build_*_visuals.py` files author Blender surfaces. The `build_*_physics.py`
files export mechanisms and collision geometry. `prepare_model.py` prepares the
robot engineering model. `inspect_*.py` files inspect saved Blender assets.

All forces and thermal coefficients remain assumptions. Follow the
[calibration procedure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/appliance-calibration-procedure.md)
before claiming measured appliance behavior.

## Blender polish checks

Use the existing appliance inspectors for dimensions, access and animation.
`inspect_mesh_quality.py` adds exported-mesh checks across the same eleven-appliance
inventory. It reads named parts from a Git commit and records the resolved commit
and baseline GLB hashes. It does not require a prior local evidence directory.
It saves seven deliberately faulty Quiet One copies and checks the corrected model.
Boundary-edge counts are advisory because sheet parts and decals can remain open.

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/inspect_mesh_quality.py -- --output output/acceptance/plan-60A/fresh-polish --baseline-ref HEAD
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/inspect_quiet_one.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/inspect_appliance_motion.py output/acceptance/plan-60A/fresh-moving-frames
```

Use an explicit earlier commit instead of `HEAD` when comparing a particular revision.
The motion inspector compares 22 scalar joints against independently authored visual
axes at 201 poses each. It checks moving attachment frames, without advancing physics.
Two faulty Quiet One GLBs verify missing-frame and displaced-pivot detection.
Free vessel motion, coupled tools, contacts and load behavior remain covered by the
existing Rust journeys. The hobs have no matching articulated appliance frames;
scale deflection and synthetic wash fields are outside this visual-axis check.

`render_appliance_review.py` renders a saved `.blend` file with its existing camera,
lights and initial pose. Pass the source and output PNG after `--`. Add `--opaque`
to distinguish surface shape from optical distortion. Use identical settings for
both revisions, then examine the images and actual GLB exports in Three.js.
The [polish evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-blender-polish.md) records limits
and the complete October comparison set.
