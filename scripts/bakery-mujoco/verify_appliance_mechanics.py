"""Plan 60A campaign: existing Rust journeys at nominal and half timesteps.

Python copies model inputs and compares evidence. Only Rust advances MuJoCo.
"""

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
from verify_rust_appliances import PROGRAMS, ROOT

SUITES = (
    "appliances",
    "planetary",
    "handling",
    "storage",
    "cleaning",
    "hobs",
    "espresso",
)
MODELS = (
    *PROGRAMS,
    "la-marzocco-linea-classic-s-2g",
    "victoria-arduino-eagle-one-2g",
    "victoria-arduino-e1-prima",
)
VESSELS = {
    "victoria-arduino-eagle-one-2g": [
        "eo_left_portafilter",
        "eo_right_portafilter",
        "eo_left_cup",
        "eo_right_cup",
        "eo_hot_water_cup",
    ],
    "victoria-arduino-e1-prima": ["e1p_portafilter"],
    "la-marzocco-linea-classic-s-2g": [
        "lcs_left_portafilter",
        "lcs_right_portafilter",
        "lcs_left_cup",
        "lcs_right_cup",
        "lcs_hot_water_cup",
    ],
    "aicoh-ms-30": ["ms_bowl"],
    "hobart-hl200": ["hl_bowl"],
    "vitamix-quiet-one": ["tqo_container"],
    "waring-wsg60": ["wsg_bowl"],
    "option-o-lagom-casa": ["casa_dosing_cup"],
    "timemore-bricks-01s": ["bricks_dosing_cup"],
    "fellow-opus-2": ["opus_catch_cup"],
    "miicoffee-df64-gen2": ["df64_dosing_cup"],
    "severin-sm-3587": ["sm3587_jug"],
    "maruzen-mih-02c": ["ih_pan"],
    "vollrath-59500p": ["ih_pan"],
    "panasonic-kz-ck1402": ["ih_pan"],
    "rinnai-rsb-150pj": ["ih_pan"],
    "maruzen-mbco-5e": ["mbco_tray"],
    "hoshizaki-rt-120snj": ["rt_container"],
    "hoshizaki-im-35p": ["im_scoop"],
    "ohaus-ranger-3000": ["ranger_weighing_pan"],
    "pastry-bench": ["pb_dough_carrier"],
    "winterhalter-uc-l": ["ucl_wash_rack", "wash_hl_bowl", "wash_hl_beater"],
}
# Final-state numerical agreement limits, not measured physical fit tolerances.
LIMITS = {"position_m": 0.005, "temperature_c": 0.1, "scale_kg": 0.0002}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect_frames(output):
    references = {}
    for name in MODELS:
        directory = ROOT / "assets/bakery-mujoco" / name
        filename = "ohaus-r31pe6" if name == "ohaus-ranger-3000" else name
        visual = output / "visuals" / name / f"{filename}.glb"
        visual.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(directory / f"{filename}.glb", visual)
        native = output / "nominal/models/assets/bakery-mujoco" / name / "native.xml"
        model = mujoco.MjModel.from_xml_path(str(native))
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        references[name] = {
            "glb": str(visual),
            "native_sha256": digest(native),
            "bodies": {
                model.body(index).name: [
                    *data.xpos[index].tolist(),
                    *data.xquat[index].tolist(),
                ]
                for index in range(1, model.nbody)
            },
        }
    source = output / "geometry-poses.json"
    source.write_text(json.dumps(references, indent=2) + "\n")
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(source),
            str(output / "geometry-report.json"),
        ],
        check=True,
    )


def prepare_models(output):
    manifest_path = Path("assets/bakery-mujoco/fr10-workcell/native/assets.json")
    original_manifest = json.loads((ROOT / manifest_path).read_text())
    for variant in ("nominal", "half"):
        snapshot = output / variant / "models"
        for filename in [
            str(manifest_path),
            *original_manifest,
            *(f"assets/bakery-mujoco/{name}/native.xml" for name in MODELS),
        ]:
            destination = snapshot / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / filename, destination)
        crate = snapshot / "crates/bakery-native"
        shutil.copytree(ROOT / "crates/bakery-native/src", crate / "src")
        for filename in ("Cargo.toml", "Cargo.lock", "build.rs"):
            shutil.copy2(ROOT / "crates/bakery-native" / filename, crate / filename)
        # The evidence directory is inside the main workspace, which excludes
        # only the original crate path. Isolate each copied package explicitly.
        with (crate / "Cargo.toml").open("a") as manifest:
            manifest.write("\n[workspace]\n")
    models = {}
    for name in MODELS:
        relative = Path("assets/bakery-mujoco") / name / "native.xml"
        source = ROOT / relative
        timestep = float(mujoco.MjModel.from_xml_path(str(source)).opt.timestep)
        models[name] = {"source_sha256": digest(source), "timestep_s": timestep}
        for variant, divisor in (("nominal", 1), ("half", 2)):
            destination = output / variant / "models" / relative
            if divisor == 2:
                tree = ET.parse(destination)
                tree.getroot().find("option").set("timestep", repr(timestep / divisor))
                tree.write(destination, encoding="unicode")
            models[name][variant + "_sha256"] = digest(destination)
    half_manifest = dict(original_manifest)
    for name, model in models.items():
        key = f"assets/bakery-mujoco/{name}/native.xml"
        if key in half_manifest:
            half_manifest[key] = model["half_sha256"]
    (output / "half/models" / manifest_path).write_text(
        json.dumps(half_manifest, indent=2) + "\n"
    )
    return models


def build_runner(output, variant, sdk):
    environment = dict(os.environ)
    environment["MUJOCO_DIR"] = str(sdk)
    environment["CARGO_TARGET_DIR"] = str(output / variant / "target")
    manifest = output / variant / "models/crates/bakery-native/Cargo.toml"
    with (output / variant / "build.log").open("w") as log:
        subprocess.run(
            [
                "cargo",
                "build",
                "--locked",
                "--release",
                "--manifest-path",
                str(manifest),
            ],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=600,
        )
    runner = output / variant / "bakery-native"
    shutil.copy2(output / variant / "target/release/bakery-native", runner)
    return digest(runner)


def run_suites(output, variant, suites, espresso_appliance):
    environment = dict(os.environ)
    environment["BAKERY_APPLIANCE_MODEL_ROOT"] = str(output / variant / "models")
    environment["BAKERY_APPLIANCE_OUTPUT"] = str(output / variant / "recordings")
    environment["BAKERY_APPLIANCE_RUNNER"] = str(output / variant / "bakery-native")
    results = {}
    for suite in suites:
        command = [
            sys.executable,
            str(ROOT / "scripts/bakery-mujoco" / f"verify_rust_{suite}.py"),
        ]
        if suite == "espresso":
            command.extend(["--appliance", espresso_appliance])
        with (output / variant / f"{suite}.log").open("w") as log:
            result = subprocess.run(
                command,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=1800,
                check=False,
            )
        results[suite] = {"passed": result.returncode == 0, "command": command}
        print(
            variant, suite, "passed" if result.returncode == 0 else "FAILED", flush=True
        )
    return results


def discrete_state(controller):
    result = {}
    for part in (
        "motor",
        "hob",
        "oven",
        "refrigerator",
        "ice_maker",
        "scale",
        "dishwasher",
        "vessel",
        "espresso",
    ):
        if part not in controller:
            continue
        for field in (
            "state",
            "phase",
            "cooling",
            "coupled",
            "seated",
            "parts",
            "power",
            "water_available",
            "steam_open",
        ):
            value = controller[part].get(field)
            if value is not None:
                result[part + "." + field] = (
                    value.get("kind") if isinstance(value, dict) else value
                )
    if "espresso" in controller:
        result["espresso.cups"] = [
            cup["position"] for cup in controller["espresso"]["cups"]
        ]
        result["espresso.shot_doses_s"] = controller["espresso"]["shot_doses_s"]
        result["espresso.hot_water_dose_s"] = controller["espresso"]["hot_water_dose_s"]
        result["espresso.hot_water"] = controller["espresso"]["hot_water"]["kind"]
        result["espresso.shots"] = [
            shot["kind"] for shot in controller["espresso"]["shots"]
        ]
        result["espresso.filters"] = [
            part["target"] for part in controller["espresso"]["filters"]
        ]
    return result


def compare_washer_motion(first, second):
    """Check recorded motion, so equal end stops cannot hide rack travel errors."""
    a, b = first["samples"], second["samples"]
    aligned = len(a) == len(b)
    maximum = 0.0
    for left, right in zip(a, b):
        left_time = left["time_s"] - a[0]["time_s"]
        right_time = right["time_s"] - b[0]["time_s"]
        aligned = aligned and abs(left_time - right_time) <= 1e-6
        for body in VESSELS["winterhalter-uc-l"]:
            maximum = max(
                maximum,
                math.dist(left["bodies"][body][:3], right["bodies"][body][:3]),
            )
    return {"samples_aligned": aligned, "position_difference_m": maximum}


def compare_recordings(output, directory="recordings"):
    results = []
    nominal = output / "nominal" / directory
    half = output / "half" / directory
    for path in sorted(nominal.glob("*.json")):
        first = json.loads(path.read_text())
        if first.get("kind") != "bakery-appliance-recording":
            continue
        other = half / path.name
        if not other.exists():
            results.append(
                {
                    "recording": path.name,
                    "passed": False,
                    "reason": "Half-step result missing",
                }
            )
            continue
        second = json.loads(other.read_text())
        a, b = first["samples"][-1], second["samples"][-1]
        name = first["continuation"]["payload"]["appliance"]
        distance = max(
            math.dist(a["bodies"][body][:3], b["bodies"][body][:3])
            for body in VESSELS[name]
        )
        batch_a = a["contents"].get("batch")
        batch_b = b["contents"].get("batch")
        temperature = (
            abs(batch_a["temperature_c"] - batch_b["temperature_c"])
            if batch_a and batch_b
            else 0
        )
        if name in ("la-marzocco-linea-classic-s-2g", "victoria-arduino-eagle-one-2g"):
            for field in ("coffee_c", "steam_c"):
                temperature = max(
                    temperature,
                    abs(
                        a["controller"]["espresso"][field]
                        - b["controller"]["espresso"][field]
                    ),
                )
            for cup_a, cup_b in zip(
                a["controller"]["espresso"]["cups"], b["controller"]["espresso"]["cups"]
            ):
                temperature = max(
                    temperature, abs(cup_a["temperature_c"] - cup_b["temperature_c"])
                )
        material_equal = a["contents"]["kind"] == b["contents"]["kind"]
        if batch_a and batch_b:
            material_equal = material_equal and all(
                batch_a[key] == batch_b[key]
                for key in batch_a
                if key != "temperature_c"
            )
        if name in ("la-marzocco-linea-classic-s-2g", "victoria-arduino-eagle-one-2g"):
            espresso_a = a["controller"]["espresso"]
            espresso_b = b["controller"]["espresso"]
            material_equal = material_equal and all(
                abs(first["mass_g"] - second["mass_g"]) < 0.001
                for first, second in zip(espresso_a["cups"], espresso_b["cups"])
            )
            material_equal = material_equal and all(
                abs(espresso_a[field] - espresso_b[field]) < 0.001
                for field in ("drain_g", "discarded_g")
            )
        scale = 0
        if name == "ohaus-ranger-3000":
            scale = abs(
                a["controller"]["scale"]["filtered_kg"]
                - b["controller"]["scale"]["filtered_kg"]
            )
        state_equal = discrete_state(a["controller"]) == discrete_state(b["controller"])
        execution_equal = all(
            first["execution"][key] == second["execution"][key]
            for key in ("backend", "controllerSourceHash", "runtimeHash")
        )
        outcome_equal = first["outcome"] == second["outcome"]
        events_equal = [
            (event["kind"], event["action"]["kind"]) for event in first["events"]
        ] == [(event["kind"], event["action"]["kind"]) for event in second["events"]]
        motion = (
            compare_washer_motion(first, second)
            if name == "winterhalter-uc-l"
            and any(event["action"]["kind"] == "rack" for event in first["events"])
            else None
        )
        passed = (
            distance <= LIMITS["position_m"]
            and temperature <= LIMITS["temperature_c"]
            and scale <= LIMITS["scale_kg"]
            and material_equal
            and state_equal
            and execution_equal
            and outcome_equal
            and events_equal
            and (
                motion is None
                or (
                    motion["samples_aligned"]
                    and motion["position_difference_m"] <= LIMITS["position_m"]
                )
            )
        )
        results.append(
            {
                "recording": path.name,
                "nominal_recording": str(path.relative_to(output)),
                "half_recording": str(other.relative_to(output)),
                "appliance": name,
                "passed": passed,
                "position_difference_m": distance,
                "temperature_difference_c": temperature,
                "scale_difference_kg": scale,
                "material_equal": material_equal,
                "state_equal": state_equal,
                "execution_equal": execution_equal,
                "outcome_equal": outcome_equal,
                "events_equal": events_equal,
                # The declared 5 mm gate compares final positions. Keep sampled
                # motion separate; matching end stops do not qualify the path.
                "washer_motion": motion,
            }
        )
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--suite", choices=SUITES, action="append")
    parser.add_argument(
        "--espresso-appliance",
        choices=[
            "la-marzocco-linea-classic-s-2g",
            "victoria-arduino-eagle-one-2g",
            "victoria-arduino-e1-prima",
        ],
        default="la-marzocco-linea-classic-s-2g",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    verification = output / "verification"
    verification.mkdir()
    for filename in (
        "verify_appliance_mechanics.py",
        "verify_rust_appliances.py",
        "verify_rust_planetary.py",
        "verify_rust_handling.py",
        "verify_rust_storage.py",
        "verify_rust_cleaning.py",
        "verify_rust_hobs.py",
        "verify_rust_espresso.py",
        "inspect_appliance_frames.mjs",
    ):
        shutil.copy2(ROOT / "scripts/bakery-mujoco" / filename, verification / filename)
    models = prepare_models(output)
    inspect_frames(output)
    suites = {}
    runners = {}
    for variant in ("nominal", "half"):
        runners[variant] = build_runner(output, variant, args.sdk.resolve())
        suites[variant] = run_suites(
            output, variant, args.suite or SUITES, args.espresso_appliance
        )
    comparisons = compare_recordings(output)
    passed = (
        bool(comparisons)
        and all(item["passed"] for item in comparisons)
        and all(
            item["passed"] for variant in suites.values() for item in variant.values()
        )
    )
    hashes = {}
    for path in sorted(output.rglob("*")):
        if path.is_file() and "target" not in path.relative_to(output).parts:
            hashes[str(path.relative_to(output))] = digest(path)
    report = {
        "passed": passed,
        "scope": "Plan 60A final-state and sampled rack-motion numerical acceptance; no physical calibration",
        "position_comparison": "Final recorded vessel poses",
        "washer_motion_comparison": "Aligned rack-motion samples must meet the position limit",
        "runner_sha256": runners,
        "mujoco_version": mujoco.__version__,
        "limits": LIMITS,
        "models": models,
        "suites": suites,
        "comparisons": comparisons,
        "artifact_sha256": hashes,
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(output / "report.json", flush=True)
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
