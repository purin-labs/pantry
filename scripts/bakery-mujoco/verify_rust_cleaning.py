"""Drive real removable parts through interrupted Rust dishwasher cycles."""

import json
import math

from verify_rust_appliances import OUTPUT, execute
from verify_rust_handling import advance, move


def resume(label, previous, actions, expected="completed"):
    return execute(
        "washer-" + label,
        {"kind": "continue", "checkpoint": previous["continuation"]},
        actions,
        expected,
    )


def controller(result):
    return result["continuation"]["payload"]["controller"]["dishwasher"]


def door(opened):
    return {"kind": "door", "open": opened, "right": False}


def main():
    result = execute(
        "washer-parts-start",
        {
            "kind": "fresh",
            "appliance": "winterhalter-uc-l",
            "contents": {"kind": "empty"},
        },
        [advance(2)],
    )
    result = resume(
        "closed-loading-rejected",
        result,
        [{"kind": "load-part", "part": "bowl"}],
        "rejected",
    )
    receipts = []
    for index, part in enumerate(("bowl", "beater")):
        result = resume(
            part + "-access",
            result,
            [
                {"kind": "stop"},
                door(True),
                advance(3),
                {"kind": "rack", "extended": True},
                advance(20),
            ],
        )
        if part == "bowl":
            result = resume(
                part + "-moving-access-rejected",
                result,
                [{"kind": "grasp-part", "part": part}],
                "rejected",
            )
            assert "fully extended rack to stop" in json.dumps(result["outcome"])
        result = resume(part + "-access-stopped", result, [advance(5)])
        poses = result["samples"][-1]["bodies"]
        home = poses["wash_hl_" + part][:3]
        rack = poses["ucl_wash_rack"][:3]
        quaternion = (
            [0, 1, 0, 0] if part == "bowl" else [math.sqrt(0.5), math.sqrt(0.5), 0, 0]
        )
        target = (
            [rack[0], rack[1], rack[2] + 0.298]
            if part == "bowl"
            else [rack[0], rack[1] - 0.18, rack[2] + 0.025]
        )
        above = [target[0], target[1], target[2] + 0.38]
        # Move the beater beyond the parked bowl before lifting it. A vertical
        # lift at its home position intersects the bowl's wider upper rim.
        clear_home = [home[0] + 0.15, home[1], home[2]] if part == "beater" else home
        result = resume(
            part + "-grasped", result, [{"kind": "grasp-part", "part": part}]
        )
        result = resume(
            part + "-held-rack-motion-rejected",
            result,
            [{"kind": "rack", "extended": False}],
            "rejected",
        )
        assert "Release the held part" in json.dumps(result["outcome"])
        assert controller(result)["rack_target"] == "extended"
        pickup = []
        if part == "beater":
            pickup += [move(clear_home, quaternion), advance(2)]
        result = resume(
            part + "-loaded",
            result,
            pickup
            + [
                move([clear_home[0], clear_home[1], clear_home[2] + 0.38], quaternion),
                advance(3),
                move(above, quaternion),
                advance(4),
                move(target, quaternion),
                advance(3),
                {"kind": "release"},
                advance(2),
                {"kind": "load-part", "part": part},
            ],
        )
        assert controller(result)["parts"][index]["loaded"]
        result = resume(
            part + "-insert",
            result,
            [
                {"kind": "rack", "extended": False},
                advance(25),
                door(False),
                advance(3),
                {"kind": "prepare-wash"},
            ],
        )
        for segment in range(6):
            result = resume(part + f"-warm-{segment}", result, [advance(110)])
            if controller(result)["phase"] == "ready":
                break
        result = resume(
            part + "-ready", result, [{"kind": "require", "state": "ready"}]
        )
        result = resume(
            part + "-washing",
            result,
            [{"kind": "start", "program": {"kind": "wash"}}, advance(8)],
        )
        assert controller(result)["parts"][index]["cleanliness"]["kind"] == "washing"
        result = resume(
            part + "-unload-rejected",
            result,
            [{"kind": "unload-part", "part": part}],
            "rejected",
        )
        fault = (
            [door(True), advance(1)]
            if part == "bowl"
            else [{"kind": "drain-blocked", "blocked": True}, advance(40)]
        )
        result = resume(part + "-interrupted", result, fault)
        interrupted = controller(result)
        assert interrupted["phase"] == (
            "door-fault" if part == "bowl" else "drain-fault"
        ), interrupted
        assert interrupted["parts"][index]["cleanliness"]["kind"] == "dirty"
        result = resume(
            part + "-recovered",
            result,
            [
                door(False),
                {"kind": "drain-blocked", "blocked": False},
                advance(3),
                {"kind": "prepare-wash"},
                advance(120),
                {"kind": "require", "state": "ready"},
                {"kind": "start", "program": {"kind": "wash"}},
                advance(80),
                {"kind": "require", "state": "complete"},
            ],
        )
        assert controller(result)["parts"][index]["cleanliness"]["kind"] == "clean"
        result = resume(
            part + "-retrieve-access",
            result,
            [
                door(True),
                advance(3),
                {"kind": "rack", "extended": True},
                advance(25),
                {"kind": "unload-part", "part": part},
                {"kind": "grasp-part", "part": part},
            ],
        )
        position = result["samples"][-1]["bodies"]["wash_hl_" + part][:3]
        # Return the bowl upright on the bench; keep the beater horizontal.
        bench_rotation = [1, 0, 0, 0] if part == "bowl" else quaternion
        approach = [
            move([position[0], position[1], position[2] + 0.38], quaternion),
            advance(3),
            move([clear_home[0], clear_home[1], clear_home[2] + 0.4], bench_rotation),
            advance(4),
        ]
        if part == "beater":
            approach += [move(clear_home, bench_rotation), advance(3)]
        result = resume(
            part + "-retrieved",
            result,
            approach
            + [
                move(home, bench_rotation),
                advance(3),
                {"kind": "release"},
                advance(2),
            ],
        )
        state = controller(result)["parts"][index]
        assert not state["loaded"] and state["cleanliness"]["kind"] == "clean"
        receipts.append(
            {"part": part, "interruptedPhase": interrupted["phase"], "retrieved": state}
        )
        print(part, "cleaning passed", flush=True)
    (OUTPUT / "cleaning-report.json").write_text(
        json.dumps({"passed": True, "parts": receipts}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
