"""Exercise the Rust process boundary and save repeatable loaded-run evidence."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(
    os.environ.get(
        "BAKERY_APPLIANCE_RUNNER",
        ROOT / "crates/bakery-native/target/release/bakery-native",
    )
).resolve()
MODEL_ROOT = Path(os.environ.get("BAKERY_APPLIANCE_MODEL_ROOT", ROOT)).resolve()
OUTPUT = Path(
    os.environ.get(
        "BAKERY_APPLIANCE_OUTPUT",
        ROOT / "assets/bakery-mujoco/combined-bakery/rust-evidence",
    )
).resolve()
PROGRAMS = {
    "aicoh-ms-30": {"kind": "planetary", "setting": 1, "duration_s": 5},
    "hobart-hl200": {"kind": "planetary", "setting": 2, "duration_s": 5},
    "vitamix-quiet-one": {"kind": "blend", "percent": 25, "duration_s": 5},
    "waring-wsg60": {"kind": "grind", "duration_s": 5},
    "option-o-lagom-casa": {"kind": "grind", "duration_s": 5},
    "timemore-bricks-01s": {"kind": "grind", "duration_s": 5},
    "fellow-opus-2": {"kind": "grind", "duration_s": 5},
    "miicoffee-df64-gen2": {"kind": "grind", "duration_s": 5},
    "severin-sm-3587": {"kind": "heated-mix", "target_c": 45},
    "maruzen-mih-02c": {"kind": "hob-power", "percent": 50, "duration_s": 5},
    "vollrath-59500p": {"kind": "hob-temperature", "target_c": 60, "duration_s": 5},
    "panasonic-kz-ck1402": {"kind": "hob-power", "percent": 50, "duration_s": 5},
    "rinnai-rsb-150pj": {"kind": "hob-power", "percent": 50, "duration_s": 5},
    "maruzen-mbco-5e": {"kind": "preheat", "target_c": 50},
    "hoshizaki-rt-120snj": {"kind": "refrigerate"},
    "hoshizaki-im-35p": {"kind": "make-ice"},
    "ohaus-ranger-3000": {"kind": "weigh"},
    "pastry-bench": {"kind": "sheet-shortcrust", "target_thickness_mm": 3.0, "duration_s": 2.4},
    "winterhalter-uc-l": None,
}


def execute(name, initial, actions, expected="completed"):
    OUTPUT.mkdir(exist_ok=True, parents=True)
    request = {
        "schema_version": 1,
        "run_id": "native-appliance-acceptance",
        "attempt_id": name,
        "initial": initial,
        "actions": actions,
    }
    source = OUTPUT / f"{name}.request.json"
    destination = OUTPUT / f"{name}.json"
    source.write_text(json.dumps(request) + "\n")
    destination.unlink(missing_ok=True)
    completed = subprocess.run(
        [
            str(RUNNER),
            "--root",
            str(MODEL_ROOT),
            "--output",
            str(destination),
            "appliance",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if completed.returncode:
        raise RuntimeError(f"{name}: {completed.stderr}")
    result = json.loads(destination.read_text())
    if result["outcome"]["kind"] != expected:
        raise RuntimeError(f"{name}: {result['outcome']}")
    return result


def main():
    OUTPUT.mkdir(exist_ok=True, parents=True)
    report = {}
    for name, program in PROGRAMS.items():
        initial = {
            "kind": "fresh",
            "appliance": name,
            "contents": {
                "kind": "loaded",
                "batch": {
                    "identity": f"{name}-batch",
                    "mass_kg": 0.3,
                    "temperature_c": 20,
                    "specific_heat": 3900,
                    "density_kg_l": 1.03,
                    "resistance": 0.02,
                },
            },
        }
        actions = [{"kind": "advance", "seconds": 2}]
        actions.append(
            {"kind": "start", "program": program}
            if program
            else {"kind": "prepare-wash"}
        )
        actions.append({"kind": "advance", "seconds": 3})
        first = execute(name, initial, actions)
        continuation = {"kind": "continue", "checkpoint": first["continuation"]}
        resumed = execute(
            name + "-resumed", continuation, [{"kind": "advance", "seconds": 3}]
        )
        continuous = execute(
            name + "-continuous", initial, actions + [{"kind": "advance", "seconds": 3}]
        )
        # A fresh OS process must preserve integration, warmstart and load state.
        assert resumed["continuation"] == continuous["continuation"], name
        contents = resumed["continuation"]["payload"]["contents"]["batch"]
        assert contents["mass_kg"] == 0.3 and contents["identity"] == f"{name}-batch"
        controller = resumed["continuation"]["payload"]["controller"]
        if "motor" in controller:
            state = controller["motor"]["state"]["kind"]
            assert state in ("running", "complete"), (name, state, controller)
            assert controller["motor"]["load_work_j"] > 0, name
        if "hob" in controller:
            assert controller["hob"]["state"]["kind"] == "complete", controller
            assert contents["temperature_c"] > 20, name
        if "scale" in controller:
            assert controller["scale"]["state"] == "stable", controller
            assert abs(controller["scale"]["filtered_kg"] - 0.3) < 0.0002, controller
        report[name] = {
            "passed": True,
            "fresh_process_exact": True,
            "temperature_c": contents["temperature_c"],
            "recording_sha256": hashlib.sha256(
                (OUTPUT / f"{name}-resumed.json").read_bytes()
            ).hexdigest(),
        }
        print(name, "passed", flush=True)
    (OUTPUT / "report.json").write_text(
        json.dumps({"passed": True, "appliances": report}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
