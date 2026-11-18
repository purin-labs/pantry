"""Exercise loaded storage, occupied slots, blocked access and retrieval in Rust."""

import json
from verify_rust_appliances import OUTPUT, execute
from verify_rust_handling import advance, move


def resume(name, result, actions, expected="completed"):
    return execute(
        name,
        {"kind": "continue", "checkpoint": result["continuation"]},
        actions,
        expected,
    )


def run(name):
    oven = name == "maruzen-mbco-5e"
    body = "mbco_tray" if oven else "rt_container"
    batch = {
        "identity": name + "-stored",
        "mass_kg": 0.5,
        "temperature_c": 30,
        "specific_heat": 3900,
        "density_kg_l": 1,
        "resistance": 1,
    }
    result = execute(
        name + "-storage-start",
        {
            "kind": "fresh",
            "appliance": name,
            "contents": {"kind": "loaded", "batch": batch},
        },
        [advance(2)],
    )
    result = resume(name + "-closed-access", result, [{"kind": "grasp"}], "rejected")
    actions = [{"kind": "door", "open": True, "right": False}]
    if not oven:
        actions.append({"kind": "door", "open": True, "right": True})
    result = resume(
        name + "-storage-open", result, actions + [advance(8), {"kind": "grasp"}]
    )
    home = (
        result["samples"][-1]["bodies"][body][:3] if oven else [-0.079, 0.0215, 0.3646]
    )
    occupied = (
        {"kind": "oven", "level": 2}
        if oven
        else {"kind": "refrigerator", "right": True, "level": 2}
    )
    available = (
        {"kind": "oven", "level": 3}
        if oven
        else {"kind": "refrigerator", "right": False, "level": 1}
    )
    result = resume(
        name + "-occupied-slot",
        result,
        [{"kind": "move-to-slot", "slot": occupied}],
        "rejected",
    )
    assert "occupied" in result["outcome"]["message"]
    outside = [-0.1, -0.9, home[2] + 0.02] if oven else [-0.079, -0.65, 0.40]
    result = resume(
        name + "-retrieval",
        result,
        [
            move(outside if not oven else [home[0], home[1], home[2] + 0.025]),
            advance(2),
            move(outside),
            advance(4),
        ],
    )
    retrieved = result["samples"][-1]["bodies"][body][:3]
    assert (
        max(abs(actual - target) for actual, target in zip(retrieved, outside)) < 0.01
    ), retrieved
    # The command guard rejects occupied destinations while retaining custody.
    # The free carrier still uses native contacts during the available placement.
    result = resume(
        name + "-storage-return",
        result,
        [
            move([home[0], home[1], home[2] + 0.025]),
            advance(4),
            {"kind": "move-to-slot", "slot": available},
            advance(3),
            {"kind": "release"},
            advance(3),
        ],
    )
    placed = result["samples"][-1]["bodies"][body][:3]
    assert max(abs(actual - target) for actual, target in zip(placed, home)) < 0.015, (
        home,
        placed,
    )
    assert result["continuation"]["payload"]["hand"]["kind"] == "released"
    assert result["continuation"]["payload"]["contents"]["batch"]["mass_kg"] == 0.5
    result = resume(
        name + "-storage-retrieve-again",
        result,
        [
            {"kind": "grasp"},
            move([home[0], home[1], home[2] + 0.025]),
            advance(2),
            move(outside),
            advance(4),
        ],
    )
    final = result["samples"][-1]["bodies"][body][:3]
    assert max(abs(actual - target) for actual, target in zip(final, outside)) < 0.01
    return {
        "passed": True,
        "placed": placed,
        "retrieved": final,
        "batch": result["continuation"]["payload"]["contents"]["batch"],
    }


def main():
    report = {}
    for name in ("maruzen-mbco-5e", "hoshizaki-rt-120snj"):
        report[name] = run(name)
        print(name, "storage passed", flush=True)
    (OUTPUT / "storage-report.json").write_text(
        json.dumps({"passed": True, "appliances": report}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
