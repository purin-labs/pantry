"""Rust process E2E: loaded handling, rejected coupling, recovery and restart."""

import json
import math

from verify_rust_appliances import OUTPUT, execute


def advance(seconds):
    return {"kind": "advance", "seconds": seconds}


def move(position, quaternion=(1, 0, 0, 0)):
    return {"kind": "move", "position": position, "quaternion": quaternion}


def access(name, opening):
    if name == "vitamix-quiet-one":
        return [{"kind": "door", "open": opening, "right": False}]
    if name == "waring-wsg60":
        return [{"kind": "lid", "open": opening}]
    return []


def run(name, program):
    contents = {
        "kind": "loaded",
        "batch": {
            "identity": name + "-handling",
            "mass_kg": 0.3,
            "temperature_c": 42,
            "specific_heat": 3900,
            "density_kg_l": 1,
            "resistance": 0.02,
        },
    }
    initial = {"kind": "fresh", "appliance": name, "contents": contents}
    start = [{"kind": "start", "program": program}]
    seated = execute(name + "-handling-seat", initial, [advance(1)])
    body = {
        "vitamix-quiet-one": "tqo_container",
        "waring-wsg60": "wsg_bowl",
        "severin-sm-3587": "sm3587_jug",
        "option-o-lagom-casa": "casa_dosing_cup",
        "timemore-bricks-01s": "bricks_dosing_cup",
        "fellow-opus-2": "opus_catch_cup",
        "miicoffee-df64-gen2": "df64_dosing_cup",
    }[name]
    bench_target = {
        "vitamix-quiet-one": [0.32, 0.0, 0.18],
        "waring-wsg60": [0.32, 0.0, 0.18],
        "severin-sm-3587": [0.32, 0.0, 0.18],
        "option-o-lagom-casa": [0.22, -0.0545, 0.038],
        "timemore-bricks-01s": [0.18, -0.036, 0.016],
        "fellow-opus-2": [0.22, -0.036, 0.02],
        "miicoffee-df64-gen2": [0.22, -0.077, 0.02],
    }[name]
    home = seated["samples"][-1]["bodies"][body][:3]
    is_grinder = name in (
        "option-o-lagom-casa",
        "timemore-bricks-01s",
        "fellow-opus-2",
        "miicoffee-df64-gen2",
    )
    clearance = (
        [bench_target[0], bench_target[1], home[2] + 0.004]
        if is_grinder
        else [home[0], home[1], home[2] + 0.2]
    )
    lifted = [bench_target[0], bench_target[1], bench_target[2] + 0.12]
    actions = (
        start
        + [advance(2), {"kind": "stop"}, advance(12)]
        + access(name, True)
        + [
            advance(2),
            {"kind": "grasp"},
            move(clearance),
            advance(2),
            move(lifted, [math.cos(0.12), 0, math.sin(0.12), 0]),
            advance(2),
        ]
    )
    held = execute(
        name + "-handling-held",
        {"kind": "continue", "checkpoint": seated["continuation"]},
        actions,
    )
    bench = execute(
        name + "-handling-bench",
        {"kind": "continue", "checkpoint": held["continuation"]},
        [
            move([bench_target[0], bench_target[1], bench_target[2] + 0.002]),
            advance(2),
            {"kind": "release"},
            advance(2),
        ],
    )
    pose = bench["samples"][-1]["bodies"][body]
    assert (
        abs(pose[0] - bench_target[0]) < 0.003
        and abs(pose[2] - bench_target[2]) < 0.015
    ), pose
    rejected = execute(
        name + "-handling-rejected-coupling",
        {"kind": "continue", "checkpoint": bench["continuation"]},
        [{"kind": "engage"}],
        expected="rejected",
    )
    assert rejected["outcome"]["action"] == 0
    assert not rejected["continuation"]["payload"]["controller"]["vessel"]["coupled"]
    assert rejected["continuation"]["payload"]["contents"] == bench["continuation"]["payload"]["contents"]
    rejected = execute(
        name + "-handling-start-away-from-base",
        {"kind": "continue", "checkpoint": rejected["continuation"]},
        start,
        expected="rejected",
    )
    actions = (
        [
            {"kind": "grasp"},
            move(lifted),
            advance(2),
            move(clearance),
            advance(2),
            move(home),
            advance(2),
            {"kind": "release"},
            advance(2),
            {"kind": "engage"},
        ]
        + access(name, False)
        + [advance(2), {"kind": "reset"}]
        + start
        + [advance(2)]
    )
    restored = execute(
        name + "-handling-restored",
        {"kind": "continue", "checkpoint": rejected["continuation"]},
        actions,
    )
    assert restored["continuation"]["payload"]["controller"]["motor"]["state"]["kind"] == "running"
    assert restored["continuation"]["payload"]["contents"]["batch"]["mass_kg"] == 0.3
    return {
        "passed": True,
        "bench_pose": pose,
        "restored_state": restored["continuation"]["payload"]["controller"]["motor"]["state"],
    }


def main():
    result = {}
    for name, program in [
        ("vitamix-quiet-one", {"kind": "blend", "percent": 25, "duration_s": 4}),
        ("waring-wsg60", {"kind": "grind", "duration_s": 4}),
        ("option-o-lagom-casa", {"kind": "grind", "duration_s": 4}),
        ("timemore-bricks-01s", {"kind": "grind", "duration_s": 4}),
        ("fellow-opus-2", {"kind": "grind", "duration_s": 4}),
        ("miicoffee-df64-gen2", {"kind": "grind", "duration_s": 4}),
        ("severin-sm-3587", {"kind": "cold-mix", "duration_s": 4}),
    ]:
        result[name] = run(name, program)
        print(name, "handling passed", flush=True)
    (OUTPUT / "handling-report.json").write_text(
        json.dumps({"passed": True, "appliances": result}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
