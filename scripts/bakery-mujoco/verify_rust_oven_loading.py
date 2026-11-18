"""Inspect rack contacts and run loaded oven journeys through the Rust process.

Python only probes fixed poses. The existing Rust controller executes motion.
Evidence describes the authored model, not calibrated physical equipment.
"""

import hashlib
import json
import math
import subprocess

import mujoco
import numpy as np

from verify_rust_appliances import OUTPUT, ROOT, RUNNER, execute
from verify_rust_handling import advance, move
from verify_rust_storage import resume


OVEN = ROOT / "assets/bakery-mujoco/maruzen-mbco-5e"
EVIDENCE = OVEN / "loading-evidence"


def tray_contacts(model, data):
    contacts = {}
    for contact in data.contact:
        first = model.geom(contact.geom1).name
        second = model.geom(contact.geom2).name
        if not any(name.startswith("mbco_tray_") for name in (first, second)):
            continue
        if contact.dist >= -0.00001:
            continue
        pair = " / ".join(sorted((first, second)))
        contacts[pair] = max(contacts.get(pair, 0), round(-contact.dist * 1000, 4))
    return contacts


def probe(model, level, x_offset, yaw_degrees, roll_degrees, door_degrees):
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    slot = data.site(f"mbco_slot_{level}").xpos.copy()
    quaternion = np.zeros(4)
    mujoco.mju_euler2Quat(
        quaternion, np.radians([roll_degrees, 0, yaw_degrees]), "XYZ"
    )
    contacts = {}
    for fraction in np.linspace(0, 1, 201):
        position = slot + [x_offset, -(1 - fraction), 0.012]
        data.joint("mbco_door_hinge").qpos[0] = math.radians(door_degrees)
        data.joint("mbco_tray_free").qpos[:] = [*position, *quaternion]
        mujoco.mj_forward(model, data)
        for pair, depth in tray_contacts(model, data).items():
            contacts[pair] = max(contacts.get(pair, 0), depth)
    return contacts


def inspect_paths():
    model = mujoco.MjModel.from_xml_path(str(OVEN / "scene.xml"))
    # Deliberate offsets exceed the estimated 7 mm upright clearance.
    cases = [
        ("aligned", 0, 0, 0, 100, False),
        ("left-10mm", -0.010, 0, 0, 100, True),
        ("right-10mm", 0.010, 0, 0, 100, True),
        ("yaw-3deg", 0, 3, 0, 100, True),
        ("tilt-5deg", 0, 0, 5, 100, True),
        ("door-closed", 0, 0, 0, 0, True),
        ("door-45deg", 0, 0, 0, 45, True),
        ("door-75deg", 0, 0, 0, 75, True),
    ]
    results = []
    for level in range(1, 6):
        for name, offset, yaw, roll, door, expected in cases:
            contacts = probe(model, level, offset, yaw, roll, door)
            results.append({
                "level": level,
                "case": name,
                "expected_obstruction": expected,
                "contacts_max_penetration_mm": contacts,
                "passed": bool(contacts) == expected,
            })
    (EVIDENCE / "contact-probes.json").write_text(json.dumps(results, indent=2) + "\n")
    assert all(item["passed"] for item in results), results
    return results


def assert_position(recording, target):
    actual = recording["samples"][-1]["bodies"]["mbco_tray"][:3]
    error = max(abs(a - b) for a, b in zip(actual, target))
    assert error < 0.004, (actual, target, error)
    return actual


def loaded_cycle(level):
    name = f"oven-rack-level-{level}"
    batch = {
        "identity": "six-croissants-assumed-60g-each",
        "mass_kg": 0.36,
        "temperature_c": 22,
        "specific_heat": 2500,
        "density_kg_l": 0.3,
        "resistance": 0,
    }
    initial = {
        "kind": "fresh",
        "appliance": "maruzen-mbco-5e",
        "contents": {"kind": "loaded", "batch": batch},
    }
    closed = execute(name + "-closed-access", initial, [{"kind": "grasp"}], "rejected")
    assert "Open the oven" in closed["outcome"]["message"]
    opened = resume(
        name + "-open",
        closed,
        [
            {"kind": "door", "open": True, "right": False},
            advance(8),
            {"kind": "grasp"},
        ],
    )
    # Move outside before changing shelves; do not drive through the intervening rails.
    shelf_z = 0.181 + (level - 1) * 0.088
    approach = [-0.1, -0.92, shelf_z + 0.012]
    outside = resume(
        name + "-approach",
        opened,
        [
            move([-0.1, -0.013, 0.369]),
            advance(2),
            move([-0.1, -0.92, 0.369]),
            advance(4),
            move(approach),
            advance(3),
        ],
    )
    assert_position(outside, approach)
    if level == 2:
        rejected = resume(name + "-occupied", outside, [
            {"kind": "move-to-slot", "slot": {"kind": "oven", "level": level}},
        ], "rejected")
        assert "occupied" in rejected["outcome"]["message"]
        return {"level": level, "passed": True, "result": "occupied slot rejected"}
    inserted = resume(
        name + "-inserted",
        outside,
        [
            move([-0.1, -0.013, shelf_z + 0.012]),
            advance(4),
            {"kind": "move-to-slot", "slot": {"kind": "oven", "level": level}},
            advance(3),
            {"kind": "release"},
            advance(3),
        ],
    )
    placed = assert_position(inserted, [-0.1, -0.013, shelf_z])
    settled = resume(
        name + "-closed",
        inserted,
        [{"kind": "door", "open": False, "right": False}, advance(8)],
    )
    assert_position(settled, [-0.1, -0.013, shelf_z])
    restored = resume(
        name + "-retrieved",
        settled,
        [
            {"kind": "door", "open": True, "right": False},
            advance(8),
            {"kind": "grasp"},
            move([-0.1, -0.013, shelf_z + 0.012]),
            advance(2),
            move(approach),
            advance(4),
        ],
    )
    retrieved = assert_position(restored, approach)
    assert restored["continuation"]["payload"]["contents"]["batch"]["mass_kg"] == 0.36
    assert restored["continuation"]["payload"]["hand"]["kind"] == "holding"
    return {"level": level, "passed": True, "placed": placed, "retrieved": retrieved}


def native_command(path, arguments):
    path.unlink(missing_ok=True)
    subprocess.run(
        [str(RUNNER), "--root", str(ROOT), "--output", str(path), *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=150,
    )
    return json.loads(path.read_text())


def inspect_robot_cycle():
    request = EVIDENCE / "robot-request.json"
    native_command(request, ["prepare", "--task", "table-to-oven"])
    recording = native_command(EVIDENCE / "robot-cycle.json", ["cycle", str(request)])
    if recording["kind"] == "bakery-physics-sequence":
        accepted = all(
            recording[phase]["outcome"]["kind"] == "completed"
            for phase in ("loading", "unloading")
        )
        return {"accepted": accepted, "kind": recording["kind"]}
    assert recording["kind"] == "bakery-physics-recording", recording["kind"]
    # A stopped transfer is retained as evidence, not relabelled as acceptance.
    model = mujoco.MjModel.from_xml_path(str(
        ROOT / "assets/bakery-mujoco/fr10-workcell/native/fairino-fr10/table-to-oven-nominal.xml"
    ))
    data = mujoco.MjData(model)
    sample = recording["samples"][-1]
    for index, value in enumerate(sample["joints"], 1):
        data.joint(f"fairino-fr10__j{index}").qpos[0] = value
    data.joint("mbco_tray_free").qpos[:] = sample["tray"]
    mujoco.mj_forward(model, data)
    contacts = tray_contacts(model, data)
    return {
        "accepted": False,
        "outcome": recording["outcome"],
        "rack_contacts_at_recorded_stop_mm": {
            pair: depth for pair, depth in contacts.items() if "mbco_rack_" in pair
        },
        "next_requirement": "Observed tray alignment and grip control before robot insertion",
    }


def main():
    EVIDENCE.mkdir(exist_ok=True)
    OUTPUT.mkdir(exist_ok=True, parents=True)
    probes = inspect_paths()
    journeys = []
    for level in range(1, 6):
        journeys.append(loaded_cycle(level))
        print(f"Oven shelf {level} passed", flush=True)
    report = {
        "direct_loading_passed": True,
        "scope": "Authored geometry and Rust/MuJoCo consistency; no real-oven calibration",
        "assumed_food_load_kg": 0.36,
        "payload_distribution": "Existing centred aggregate payload; individual pastry contacts are not modelled",
        "native_sha256": hashlib.sha256((OVEN / "native.xml").read_bytes()).hexdigest(),
        "geometry_cases": len(probes),
        "poses_per_geometry_case": 201,
        "journeys": journeys,
        "robot_transfer": inspect_robot_cycle(),
        "recordings": str(OUTPUT.relative_to(ROOT)) + "/oven-rack-level-*.json",
    }
    (EVIDENCE / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
