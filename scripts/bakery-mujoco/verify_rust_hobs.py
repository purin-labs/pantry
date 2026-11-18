"""Rust E2E: supported misalignment, lost hob support, and pan recovery."""

import json

from verify_rust_appliances import OUTPUT, execute
from verify_rust_handling import advance, move
from verify_rust_storage import resume


def run(name):
    start = {
        "kind": "start",
        "program": {
            "kind": "hob-power",
            "percent": 50,
            "duration_s": 30,
        },
    }
    result = execute(
        name + "-pan-seated",
        {
            "kind": "fresh",
            "appliance": name,
            "contents": {
                "kind": "loaded",
                "batch": {
                    "identity": name + "-pan-load",
                    "mass_kg": 0.3,
                    "temperature_c": 20,
                    "specific_heat": 3900,
                    "density_kg_l": 1,
                    "resistance": 0.02,
                },
            },
        },
        [advance(2), start, advance(2)],
    )
    home = result["samples"][-1]["bodies"]["ih_pan"][:3]
    assert result["continuation"]["payload"]["controller"]["hob"]["heater_w"] > 0
    result = resume(
        name + "-pan-misaligned",
        result,
        [
            {"kind": "stop"},
            {"kind": "grasp"},
            move([home[0], home[1], home[2] + 0.15]),
            advance(1),
            move([home[0] + 0.06, home[1], home[2]]),
            advance(2),
            {"kind": "release"},
            advance(2),
            start,
            advance(2),
        ],
    )
    pose = result["samples"][-1]["bodies"]["ih_pan"][:3]
    assert abs(pose[2] - home[2]) < 0.003, pose
    assert abs(pose[0] - home[0] - 0.06) < 0.003, pose
    hob = result["continuation"]["payload"]["controller"]["hob"]
    assert not hob["seated"] and hob["heater_w"] == 0, hob
    result = resume(
        name + "-pan-false-completion",
        result,
        [{"kind": "require", "state": "complete"}],
        "rejected",
    )
    result = resume(
        name + "-pan-unsupported",
        result,
        [
            {"kind": "stop"},
            {"kind": "reset"},
            {"kind": "grasp"},
            move([home[0], home[1], home[2] + 0.15]),
            advance(2),
            start,
            advance(2),
        ],
    )
    hob = result["continuation"]["payload"]["controller"]["hob"]
    assert not hob["seated"] and hob["heater_w"] == 0, hob
    result = resume(
        name + "-pan-recovered",
        result,
        [
            {"kind": "stop"},
            move(home),
            advance(2),
            {"kind": "release"},
            advance(2),
            {"kind": "reset"},
            start,
            advance(31),
            {"kind": "require", "state": "complete"},
        ],
    )
    hob = result["continuation"]["payload"]["controller"]["hob"]
    assert hob["seated"] and hob["heater_w"] == 0, hob
    assert result["continuation"]["payload"]["contents"]["batch"]["mass_kg"] == 0.3
    return {"passed": True, "supported_offset_m": 0.06, "misaligned_pose": pose}


def main():
    report = {}
    for name in (
        "maruzen-mih-02c",
        "vollrath-59500p",
        "panasonic-kz-ck1402",
        "rinnai-rsb-150pj",
    ):
        report[name] = run(name)
        print(name, "pan recovery passed", flush=True)
    (OUTPUT / "hob-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
