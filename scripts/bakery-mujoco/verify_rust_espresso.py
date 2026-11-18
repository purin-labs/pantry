"""Rust E2E: cold refusal, both groups, loaded portafilter access and water-loss recovery."""

import json
import argparse
import subprocess
import copy
import mujoco
import numpy as np
from verify_rust_appliances import execute, OUTPUT, RUNNER, MODEL_ROOT

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--appliance",
    choices=[
        "la-marzocco-linea-classic-s-2g",
        "victoria-arduino-eagle-one-2g",
        "victoria-arduino-e1-prima",
    ],
    default="la-marzocco-linea-classic-s-2g",
)
NAME = parser.parse_args().appliance
PREFIX = {
    "la-marzocco-linea-classic-s-2g": "lcs",
    "victoria-arduino-eagle-one-2g": "eo",
    "victoria-arduino-e1-prima": "e1p",
}[NAME]
MAXIMUM_W = {"lcs": 3730, "eo": 5000, "e1p": 2600}[PREFIX]


def state(result):
    return result["continuation"]["payload"]["controller"]["espresso"]


def advance(seconds):
    return {"kind": "advance", "seconds": seconds}


def shot(group, duration=12):
    return {
        "kind": "start",
        "program": {"kind": "espresso-shot", "group": group, "duration_s": duration},
    }


def hot_water(duration=15):
    return {
        "kind": "start",
        "program": {"kind": "espresso-hot-water", "duration_s": duration},
    }


def resume(label, result, actions, expected="completed"):
    return execute(
        "linea-" + label,
        {"kind": "continue", "checkpoint": result["continuation"]},
        actions,
        expected,
    )


def port(group, position):
    return {"kind": "portafilter", "group": group, "position": position}


def reject_model_substitution(result):
    checkpoint = copy.deepcopy(result["continuation"])
    checkpoint["controller"]["espresso"]["model"] = (
        "linea" if PREFIX == "eo" else "eagle-one"
    )
    request = {
        "schema_version": 1,
        "run_id": "model-substitution",
        "attempt_id": "model-substitution",
        "initial": {"kind": "continue", "checkpoint": checkpoint},
        "actions": [{"kind": "inspect"}],
    }
    source = OUTPUT / "model-substitution.request.json"
    source.write_text(json.dumps(request) + "\n")
    attempt = subprocess.run(
        [
            str(RUNNER),
            "--root",
            str(MODEL_ROOT),
            "--output",
            str(OUTPUT / "model-substitution.json"),
            "appliance",
            str(source),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    (OUTPUT / "model-substitution.log").write_text(attempt.stdout + attempt.stderr)
    assert attempt.returncode != 0
    assert "Espresso model does not match checkpoint appliance" in attempt.stderr


def inspect_dose_controls(result, selected):
    model = mujoco.MjModel.from_xml_path(
        str(MODEL_ROOT / "assets/bakery-mujoco" / NAME / "native.xml")
    )
    data = mujoco.MjData(model)
    mujoco.mj_setState(
        model,
        data,
        np.array(result["continuation"]["payload"]["state"]),
        mujoco.mjtState.mjSTATE_INTEGRATION,
    )
    for index in (1, 2, 3):
        actuator = model.actuator(f"{PREFIX}_left_dose_{index}_control").id
        assert abs(data.ctrl[actuator] - (-0.001 if index == selected else 0)) < 1e-9
        position = data.joint(f"{PREFIX}_left_dose_{index}").qpos[0]
        assert abs(position - (-0.001 if index == selected else 0)) < 0.00015


def inspect_cup_load(result, outlet, index, mass_g):
    model = mujoco.MjModel.from_xml_path(
        str(MODEL_ROOT / "assets/bakery-mujoco" / NAME / "native.xml")
    )
    body = model.body(f"{PREFIX}_{outlet}_cup").id
    expected = 0.2 + mass_g / 1000
    params = result["continuation"]["payload"]["parameters"]
    assert abs(params["body_mass"][body] - expected) < 1e-8
    radius = 0.027 if PREFIX == "eo" else 0.032
    expected_inertia = expected * radius**2 / 2
    assert abs(params["body_inertia"][body * 3 + 2] - expected_inertia) < 1e-10
    assert abs(state(result)["cups"][index]["support_n"] - expected * 9.81) < 0.03


def inspect_e1_prima_joint(result, joint_name):
    model = mujoco.MjModel.from_xml_path(
        str(MODEL_ROOT / "assets/bakery-mujoco" / NAME / "native.xml")
    )
    data = mujoco.MjData(model)
    mujoco.mj_setState(
        model,
        data,
        np.array(result["continuation"]["payload"]["state"]),
        mujoco.mjtState.mjSTATE_INTEGRATION,
    )
    return float(data.joint(joint_name).qpos[0])


def run_e1_prima(batch):
    result = execute(
        "e1p-cold",
        {"kind": "fresh", "appliance": NAME, "contents": batch},
        [shot("left")],
        "rejected",
    )
    assert "Warm both boilers" in result["outcome"]["message"]
    reject_model_substitution(result)
    resume("cold-hot-water-refused", result, [hot_water()], "rejected")
    for label, action in [
        ("right-shot", shot("right")),
        (
            "right-preset",
            {
                "kind": "start",
                "program": {
                    "kind": "espresso-shot-preset",
                    "group": "right",
                    "slot": "one",
                },
            },
        ),
        (
            "right-dose",
            {
                "kind": "set-shot-dose",
                "group": "right",
                "slot": "one",
                "duration_s": 10,
            },
        ),
        ("right-portafilter", port("right", "unlocked")),
        ("right-steam", {"kind": "steam", "group": "right", "open": True}),
        (
            "right-wand",
            {"kind": "steam-wand", "group": "right", "angle_degrees": 15},
        ),
        (
            "right-cup",
            {"kind": "move-cup", "outlet": "right", "position": "removed"},
        ),
    ]:
        resume(f"single-group-{label}-refused", result, [action], "rejected")
    result = resume(
        "power",
        result,
        [
            {
                "kind": "start",
                "program": {"kind": "espresso-warmup", "coffee_c": 93, "steam_c": 125},
            }
        ],
    )
    for index in range(12):
        result = resume(f"warm-{index}", result, [advance(120)])
        print(
            "warm",
            index,
            state(result)["coffee_c"],
            state(result)["steam_c"],
            flush=True,
        )
        if state(result)["coffee_c"] >= 92 and state(result)["steam_c"] >= 123:
            break
    ready = resume("ready", result, [{"kind": "require", "state": "ready"}])
    assert ready["continuation"]["payload"]["contents"]["batch"]["temperature_c"] > 70
    assert state(ready)["heater_w"] <= MAXIMUM_W
    for slot in ("one", "two"):
        active = resume(
            f"button-{slot}",
            ready,
            [
                {
                    "kind": "start",
                    "program": {
                        "kind": "espresso-shot-preset",
                        "group": "left",
                        "slot": slot,
                    },
                },
                advance(3),
            ],
        )
        assert state(active)["dose_controls"][0] == slot
        assert state(active)["shots"][0]["kind"] == "dispensing"
        stopped = resume(
            f"button-{slot}-stop",
            active,
            [{"kind": "stop-shot", "group": "left"}, advance(0.2)],
        )
        assert state(stopped)["shots"][0]["kind"] == "interrupted"
    programmed = resume(
        "program-doses",
        ready,
        [
            {"kind": "set-shot-dose", "group": "left", "slot": "two", "duration_s": 9},
            {"kind": "set-hot-water-dose", "duration_s": 30},
        ],
    )
    cups = resume(
        "preset-cups",
        programmed,
        [
            {
                "kind": "start",
                "program": {
                    "kind": "espresso-shot-preset",
                    "group": "left",
                    "slot": "two",
                },
            },
            {"kind": "start", "program": {"kind": "espresso-hot-water-preset"}},
            advance(3),
        ],
    )
    assert inspect_e1_prima_joint(cups, "e1p_hot_water_lever_hinge") > 0.35
    resume(
        "tray-slide-during-dispense-refused",
        cups,
        [{"kind": "rack", "extended": True}],
        "rejected",
    )
    cups = resume("preset-cups-complete", cups, [advance(28)])
    assert abs(state(cups)["cups"][0]["mass_g"] - 18) < 1e-6
    assert abs(state(cups)["cups"][2]["mass_g"] - 250) < 1e-6
    assert abs(state(cups)["drain_g"] - 50) < 1e-6
    assert state(cups)["cups"][2]["temperature_c"] > 80
    moved = resume(
        "cup-remove",
        cups,
        [
            {"kind": "move-cup", "outlet": "hot-water", "position": "removed"},
            advance(5),
        ],
    )
    assert (
        state(moved)["cups"][2]["temperature_c"]
        < state(cups)["cups"][2]["temperature_c"]
    )
    # Drawing 300 mL from the compact 1.5 L boiler drops steam_c below ready until reheated.
    assert state(moved)["steam_c"] < 123
    reheated = resume(
        "compact-boiler-reheat",
        moved,
        [advance(25), {"kind": "require", "state": "ready"}],
    )
    missing = resume("no-cup-drain", reheated, [hot_water(2), advance(3)])
    assert abs(state(missing)["drain_g"] - 70) < 1e-6
    emptied = resume(
        "cup-empty", missing, [{"kind": "empty-cup", "outlet": "hot-water"}]
    )
    served = resume(
        "cup-serve-left",
        emptied,
        [
            {"kind": "move-cup", "outlet": "left", "position": "removed"},
            advance(5),
            {"kind": "serve-cup", "outlet": "left"},
            {"kind": "move-cup", "outlet": "left", "position": "placed"},
            {"kind": "move-cup", "outlet": "hot-water", "position": "placed"},
            advance(5),
        ],
    )
    total = (
        sum(cup["mass_g"] for cup in state(served)["cups"])
        + state(served)["drain_g"]
        + state(served)["discarded_g"]
        + state(served)["served_g"]
    )
    assert abs(total - state(served)["drawn_water_g"]) < 1e-6
    flows = resume(
        "water-overlap",
        ready,
        [
            shot("left", 10),
            {"kind": "steam", "group": "left", "open": True},
            hot_water(8),
            advance(3),
        ],
    )
    assert state(flows)["heater_w"] <= MAXIMUM_W
    assert state(flows)["steam_open"] == [True, False]
    assert inspect_e1_prima_joint(flows, "e1p_steam_lever_hinge") > 0.35
    baseline = resume(
        "water-overlap-baseline",
        ready,
        [
            shot("left", 10),
            {"kind": "steam", "group": "left", "open": True},
            advance(3),
        ],
    )
    assert state(flows)["steam_c"] < state(baseline)["steam_c"]
    wand = resume(
        "wand-angle",
        ready,
        [{"kind": "steam-wand", "group": "left", "angle_degrees": 25}, advance(1)],
    )
    assert abs(inspect_e1_prima_joint(wand, "e1p_steam_wand_swing") - np.deg2rad(25)) < 0.03
    resume(
        "wand-range-refused",
        ready,
        [{"kind": "steam-wand", "group": "left", "angle_degrees": 35}],
        "rejected",
    )
    # Guided 4-state 6-DOF bayonet portafilter removal and re-locking.
    unlocked = resume("bayonet-unlock", ready, [port("left", "unlocked"), advance(2)])
    resume("cup-blocks-filter", unlocked, [port("left", "removed")], "rejected")
    cleared = resume(
        "clear-cup-for-filter",
        unlocked,
        [{"kind": "move-cup", "outlet": "left", "position": "removed"}, advance(5)],
    )
    removed = resume("bayonet-removed", cleared, [port("left", "removed"), advance(3)])
    assert removed["samples"][-1]["bodies"]["e1p_portafilter"][2] < 0.15
    resume(
        "filter-blocks-cup",
        removed,
        [{"kind": "move-cup", "outlet": "left", "position": "placed"}],
        "rejected",
    )
    resume("unseated-shot-refused", removed, [shot("left", 5)], "rejected")
    seated = resume("bayonet-seated", removed, [port("left", "seated"), advance(3)])
    locked = resume(
        "bayonet-locked",
        seated,
        [
            port("left", "locked"),
            advance(2),
            {"kind": "move-cup", "outlet": "left", "position": "placed"},
        ],
    )
    pf_pose = locked["samples"][-1]["bodies"]["e1p_portafilter"]
    assert np.linalg.norm(np.array(pf_pose[:3]) - np.array([0.0, -0.156, 0.214])) < 0.002
    # Free-hand 6-DOF grasp/move/release, reservoir lid, and drip tray interlock.
    held = resume("hand-grasp", locked, [{"kind": "grasp"}])
    resume("held-guided-refused", held, [port("left", "unlocked")], "rejected")
    resume("held-shot-refused", held, [shot("left", 5)], "rejected")
    bayonet_q = [float(np.cos(-0.275)), 0.0, 0.0, float(np.sin(-0.275))]
    parked = resume(
        "hand-park-on-tray",
        held,
        [
            {
                "kind": "move",
                "position": [0.0, -0.17, 0.215],
                "quaternion": bayonet_q,
            },
            advance(0.6),
            {
                "kind": "move",
                "position": [0.0, -0.23, 0.215],
                "quaternion": [1.0, 0.0, 0.0, 0.0],
            },
            advance(0.6),
            {
                "kind": "move",
                "position": [0.0, -0.18, 0.09],
                "quaternion": [1.0, 0.0, 0.0, 0.0],
            },
            advance(0.8),
            {"kind": "release"},
            advance(0.5),
        ],
    )
    resume("parked-shot-refused", parked, [shot("left", 5)], "rejected")
    reseated = resume(
        "hand-reseat",
        parked,
        [
            {"kind": "grasp"},
            {
                "kind": "move",
                "position": [0.0, -0.23, 0.215],
                "quaternion": bayonet_q,
            },
            advance(0.8),
            {
                "kind": "move",
                "position": [0.0, -0.168, 0.215],
                "quaternion": bayonet_q,
            },
            advance(0.6),
            {
                "kind": "move",
                "position": [0.0, -0.156, 0.214],
                "quaternion": [1.0, 0.0, 0.0, 0.0],
            },
            advance(0.6),
            {"kind": "release"},
            advance(0.5),
        ],
    )
    accessories = resume(
        "lid-and-tray-open",
        reseated,
        [
            {"kind": "lid", "open": True},
            {"kind": "rack", "extended": True},
            advance(2),
        ],
    )
    assert inspect_e1_prima_joint(accessories, "e1p_tank_lid_hinge") > 0.85
    assert inspect_e1_prima_joint(accessories, "e1p_drip_tray_slide") > 0.12
    resume("tray-open-shot-refused", accessories, [shot("left", 5)], "rejected")
    resume("tray-open-water-refused", accessories, [hot_water(5)], "rejected")
    closed = resume(
        "lid-and-tray-closed",
        accessories,
        [
            {"kind": "lid", "open": False},
            {"kind": "rack", "extended": False},
            advance(2),
        ],
    )
    # Water-loss fault, recovery, and exact continuation equality.
    fault = resume(
        "water-fault",
        closed,
        [
            shot("left", 8),
            advance(2),
            {"kind": "water-supply", "available": False},
            advance(2),
        ],
    )
    assert state(fault)["power"]["kind"] == "no-water"
    assert state(fault)["shots"][0]["kind"] == "interrupted"
    assert state(fault)["heater_w"] == 0
    recovered = resume(
        "water-restored",
        fault,
        [
            {"kind": "water-supply", "available": True},
            {
                "kind": "start",
                "program": {"kind": "espresso-warmup", "coffee_c": 93, "steam_c": 125},
            },
            advance(30),
            {"kind": "require", "state": "ready"},
            shot("left", 5),
            advance(6),
            {"kind": "require", "state": "complete"},
        ],
    )
    first = resume("checkpoint-first", ready, [shot("left", 10), advance(2)])
    split = resume("checkpoint-resumed", first, [advance(3)])
    continuous = resume("checkpoint-continuous", ready, [shot("left", 10), advance(5)])
    assert split["continuation"] == continuous["continuation"]
    cooled = resume("cooldown", recovered, [{"kind": "stop"}, advance(120)])
    assert state(cooled)["heater_w"] == 0
    assert all(display["text"] == "" for display in cooled["samples"][-1]["displays"])
    report = {
        "appliance": NAME,
        "model_substitution_refused": True,
        "single_group_right_refused": True,
        "bayonet_guided_and_free_hand": True,
        "lid_and_drip_tray_interlocks": True,
        "hot_water_overlap_stop_fault_and_continuation": True,
        "continuation_exact": True,
        "passed": True,
        "scope": "Single-group NEO/steam thermal control, 6-DOF bayonet portafilter, tank lid, drip tray interlock, water loss and fresh-process continuation",
        "final": state(cooled),
    }
    (OUTPUT / "espresso-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("E1 PRIMA espresso journey passed", flush=True)


def main():
    batch = {
        "kind": "loaded",
        "batch": {
            "identity": "linea-coffee-dose",
            "mass_kg": 0.018,
            "temperature_c": 20,
            "specific_heat": 1500,
            "density_kg_l": 0.5,
            "resistance": 0,
        },
    }
    if NAME == "victoria-arduino-e1-prima":
        run_e1_prima(batch)
        return
    result = execute(
        "linea-cold",
        {"kind": "fresh", "appliance": NAME, "contents": batch},
        [shot("left")],
        "rejected",
    )
    assert "Warm both boilers" in result["outcome"]["message"]
    reject_model_substitution(result)
    result = resume("cold-hot-water-refused", result, [hot_water()], "rejected")
    result = resume(
        "power",
        result,
        [
            {
                "kind": "start",
                "program": {"kind": "espresso-warmup", "coffee_c": 93, "steam_c": 125},
            }
        ],
    )
    for index in range(12):
        result = resume(f"warm-{index}", result, [advance(120)])
        print(
            "warm",
            index,
            state(result)["coffee_c"],
            state(result)["steam_c"],
            flush=True,
        )
        if state(result)["coffee_c"] >= 92 and state(result)["steam_c"] >= 123:
            break
    result = resume("ready", result, [{"kind": "require", "state": "ready"}])
    assert result["continuation"]["payload"]["contents"]["batch"]["temperature_c"] > 70
    ready = result
    inspect_cup_load(ready, "hot_water", 2, 0)
    for slot, index in [("one", 1), ("two", 2)]:
        active = resume(
            "button-" + slot,
            ready,
            [
                {
                    "kind": "start",
                    "program": {
                        "kind": "espresso-shot-preset",
                        "group": "left",
                        "slot": slot,
                    },
                },
                advance(0.2),
            ],
        )
        inspect_dose_controls(active, index)
        stopped = resume(
            "button-" + slot + "-stop",
            active,
            [{"kind": "stop-shot", "group": "left"}, advance(0.2)],
        )
        inspect_dose_controls(stopped, 0)
    # Presets persist across process boundaries; collected and drained water balance.
    programmed = resume(
        "program-doses",
        ready,
        [
            {"kind": "set-shot-dose", "group": "left", "slot": "two", "duration_s": 9},
            {"kind": "set-hot-water-dose", "duration_s": 30},
        ],
    )
    cups = resume(
        "preset-cups",
        programmed,
        [
            {
                "kind": "start",
                "program": {
                    "kind": "espresso-shot-preset",
                    "group": "left",
                    "slot": "two",
                },
            },
            {"kind": "start", "program": {"kind": "espresso-hot-water-preset"}},
            advance(3),
        ],
    )
    inspected = resume("inspect-active-cups", cups, [{"kind": "inspect"}])
    assert inspected["continuation"] == cups["continuation"]
    resume(
        "active-cup-removal-refused",
        cups,
        [{"kind": "move-cup", "outlet": "hot-water", "position": "removed"}],
        "rejected",
    )
    resume(
        "active-dose-edit-refused",
        cups,
        [{"kind": "set-hot-water-dose", "duration_s": 5}],
        "rejected",
    )
    cups = resume("preset-cups-complete", cups, [advance(28)])
    assert abs(state(cups)["cups"][0]["mass_g"] - 18) < 1e-6
    assert abs(state(cups)["cups"][2]["mass_g"] - 250) < 1e-6
    assert abs(state(cups)["drain_g"] - 50) < 1e-6
    assert state(cups)["cups"][2]["temperature_c"] > 80
    inspect_cup_load(cups, "hot_water", 2, 250)
    moved = resume(
        "cup-remove",
        cups,
        [
            {"kind": "move-cup", "outlet": "hot-water", "position": "removed"},
            advance(5),
        ],
    )
    assert state(moved)["cups"][2]["mass_g"] == state(cups)["cups"][2]["mass_g"]
    assert (
        state(moved)["cups"][2]["temperature_c"]
        < state(cups)["cups"][2]["temperature_c"]
    )
    missing = resume("no-cup-drain", moved, [hot_water(2), advance(3)])
    assert abs(state(missing)["drain_g"] - 70) < 1e-6
    emptied = resume(
        "cup-empty", missing, [{"kind": "empty-cup", "outlet": "hot-water"}]
    )
    assert abs(state(emptied)["discarded_g"] - 250) < 1e-6
    assert state(emptied)["cups"][2]["mass_g"] == 0
    replaced = resume(
        "cup-replace",
        emptied,
        [{"kind": "move-cup", "outlet": "hot-water", "position": "placed"}, advance(5)],
    )
    assert state(replaced)["shot_doses_s"][0][1] == 9
    resume(
        "placed-cup-empty-refused",
        replaced,
        [{"kind": "empty-cup", "outlet": "hot-water"}],
        "rejected",
    )
    total = (
        sum(cup["mass_g"] for cup in state(replaced)["cups"])
        + state(replaced)["drain_g"]
        + state(replaced)["discarded_g"]
    )
    assert abs(total - state(replaced)["drawn_water_g"]) < 1e-6
    # Concurrent coffee, steam and hot water compete for the same heater budget.
    flows = resume(
        "water-overlap",
        ready,
        [
            shot("left", 10),
            {"kind": "steam", "group": "right", "open": True},
            hot_water(8),
            advance(3),
        ],
    )
    assert state(flows)["hot_water"]["kind"] == "dispensing"
    assert abs(state(flows)["hot_water"]["delivered_g"] - 30) < 1e-6
    assert state(flows)["shots"][0]["kind"] == "dispensing"
    assert state(flows)["steam_open"][1]
    assert state(flows)["heater_w"] <= MAXIMUM_W
    baseline = resume(
        "water-overlap-baseline",
        ready,
        [
            shot("left", 10),
            {"kind": "steam", "group": "right", "open": True},
            advance(3),
        ],
    )
    assert state(flows)["steam_c"] < state(baseline)["steam_c"]
    assert (
        abs(state(flows)["drawn_water_g"] - state(baseline)["drawn_water_g"] - 30)
        < 1e-6
    )
    assert flows["continuation"]["payload"]["contents"] == baseline["continuation"]["payload"]["contents"]
    resume("water-duplicate-refused", flows, [hot_water()], "rejected")
    finished = resume("water-complete", flows, [advance(8)])
    assert state(finished)["hot_water"]["kind"] == "complete"
    assert abs(state(finished)["hot_water"]["delivered_g"] - 80) < 1e-6
    resume(
        "steam-still-active",
        finished,
        [{"kind": "require", "state": "complete"}],
        "rejected",
    )
    resume(
        "all-flows-complete",
        finished,
        [
            {"kind": "steam", "group": "right", "open": False},
            {"kind": "require", "state": "complete"},
        ],
    )
    interrupted = resume("water-stop", flows, [{"kind": "stop-hot-water"}, advance(1)])
    assert state(interrupted)["hot_water"]["kind"] == "interrupted"
    assert abs(state(interrupted)["hot_water"]["delivered_g"] - 30) < 1e-6
    assert state(interrupted)["shots"][0]["kind"] == "dispensing"
    resume(
        "water-interrupted-not-complete",
        interrupted,
        [
            advance(10),
            {"kind": "steam", "group": "right", "open": False},
            {"kind": "require", "state": "complete"},
        ],
        "rejected",
    )
    fault = resume(
        "water-overlap-fault",
        flows,
        [{"kind": "water-supply", "available": False}, advance(1)],
    )
    assert state(fault)["hot_water"]["kind"] == "interrupted"
    assert state(fault)["shots"][0]["kind"] == "interrupted"
    assert not any(state(fault)["steam_open"]) and state(fault)["heater_w"] == 0
    resume("water-fault-restart-refused", fault, [hot_water()], "rejected")
    powered_off = resume(
        "water-overlap-power-off", flows, [{"kind": "stop"}, advance(1)]
    )
    assert state(powered_off)["hot_water"]["kind"] == "interrupted"
    first_water = resume("water-checkpoint-first", ready, [hot_water(8), advance(2)])
    split_water = resume("water-checkpoint-resumed", first_water, [advance(7)])
    continuous_water = resume(
        "water-checkpoint-continuous", ready, [hot_water(8), advance(9)]
    )
    assert split_water["continuation"] == continuous_water["continuation"]
    maximum = resume("water-maximum-dose", ready, [hot_water(60), advance(61)])
    resume("water-maximum-resumed", maximum, [advance(1)])
    assert abs(state(maximum)["hot_water"]["delivered_g"] - 600) < 1e-6
    resume(
        "water-only-complete", split_water, [{"kind": "require", "state": "complete"}]
    )
    result = resume(
        "both-groups", result, [shot("left", 12), shot("right", 18), advance(3)]
    )
    assert all(s["kind"] == "dispensing" for s in state(result)["shots"])
    assert all(display["text"] == "03" for display in result["samples"][-1]["displays"])
    result = resume(
        "active-removal-refused", result, [port("left", "unlocked")], "rejected"
    )
    result = resume(
        "left-stopped", result, [{"kind": "stop-shot", "group": "left"}, advance(1)]
    )
    assert state(result)["shots"][0]["kind"] == "interrupted"
    assert state(result)["shots"][1]["kind"] == "dispensing"
    result = resume(
        "right-complete",
        result,
        [advance(16)],
    )
    assert abs(state(result)["shots"][1]["delivered_g"] - 36) < 1e-6
    result = resume(
        "interrupted-group-not-complete",
        result,
        [{"kind": "require", "state": "complete"}],
        "rejected",
    )
    result = resume("unlock", result, [port("left", "unlocked"), advance(2)])
    resume("cup-blocks-filter", result, [port("left", "removed")], "rejected")
    result = resume(
        "clear-cup-for-filter",
        result,
        [{"kind": "move-cup", "outlet": "left", "position": "removed"}, advance(5)],
    )
    result = resume("removed", result, [port("left", "removed"), advance(3)])
    assert result["samples"][-1]["bodies"][f"{PREFIX}_left_portafilter"][2] < 0.225
    resume(
        "filter-blocks-cup",
        result,
        [{"kind": "move-cup", "outlet": "left", "position": "placed"}],
        "rejected",
    )
    result = resume("unseated-shot-refused", result, [shot("left")], "rejected")
    result = resume("raised", result, [port("left", "seated"), advance(3)])
    result = resume("locked", result, [port("left", "locked"), advance(2)])
    result = resume(
        "wand-position",
        result,
        [{"kind": "steam-wand", "group": "right", "angle_degrees": 25}, advance(1)],
    )
    result = resume(
        "steam-open",
        result,
        [{"kind": "steam", "group": "right", "open": True}, advance(5)],
    )
    assert state(result)["steam_open"] == [False, True]
    result = resume(
        "steam-closed",
        result,
        [{"kind": "steam", "group": "right", "open": False}, advance(1)],
    )
    result = resume("before-water-fault", result, [shot("left"), advance(2)])
    result = resume(
        "water-fault",
        result,
        [{"kind": "water-supply", "available": False}, advance(2)],
    )
    assert state(result)["power"]["kind"] == "no-water"
    assert state(result)["shots"][0]["kind"] == "interrupted"
    assert state(result)["heater_w"] == 0 and not any(state(result)["steam_open"])
    result = resume("fault-start-refused", result, [shot("left")], "rejected")
    result = resume(
        "water-restored",
        result,
        [
            {"kind": "water-supply", "available": True},
            {
                "kind": "start",
                "program": {"kind": "espresso-warmup", "coffee_c": 93, "steam_c": 125},
            },
            advance(30),
            {"kind": "require", "state": "ready"},
        ],
    )
    result = resume("recovered-shot", result, [shot("left", 5), advance(6)])
    assert state(result)["shots"][0]["kind"] == "complete"
    # Fresh process continuation must equal the same uninterrupted simulated time.
    first = resume("checkpoint-first", ready, [shot("left", 10), advance(2)])
    split = resume("checkpoint-resumed", first, [advance(3)])
    continuous = resume("checkpoint-continuous", ready, [shot("left", 10), advance(5)])
    assert split["continuation"] == continuous["continuation"]
    result = resume("cooldown", result, [{"kind": "stop"}, advance(120)])
    assert state(result)["coffee_c"] < 92 and state(result)["heater_w"] == 0
    assert all(display["text"] == "" for display in result["samples"][-1]["displays"])
    assert (
        result["continuation"]["payload"]["contents"]["batch"]["identity"] == "linea-coffee-dose"
    )
    batch["batch"]["temperature_c"] = 4
    batch["batch"]["identity"] = "linea-cold-dose"
    cold = execute(
        "linea-cold-contents",
        {"kind": "fresh", "appliance": NAME, "contents": batch},
        [advance(10)],
    )
    cold = resume("cold-contents-resumed", cold, [advance(10)])
    assert cold["continuation"]["payload"]["contents"]["batch"]["temperature_c"] > 4
    assert state(cold)["power"]["kind"] == "off" and state(cold)["heater_w"] == 0
    report = {
        "appliance": NAME,
        "model_substitution_refused": True,
        "loaded_cup_mass_inertia_support": True,
        "separate_preset_buttons": True,
        "passed": True,
        "scope": "Uncalibrated dual-group control, guided portafilter access, steam, water loss and fresh-process continuation",
        "final": state(result),
        "hot_water_overlap_stop_fault_and_continuation": True,
        "continuation_exact": True,
        "cold_contents_continuation": True,
    }
    (OUTPUT / "espresso-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Espresso journey passed", flush=True)


if __name__ == "__main__":
    main()
