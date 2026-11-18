"""Generate the dimensioned prototype tool. Rust remains the physics controller."""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets/bakery-robots/universal-robots-ur5e/tooling"
ALUMINIUM = 2700.0
POLYMER = 1100.0


def numbers(values):
    return " ".join(format(float(value), ".16g") for value in values)


def box_properties(size, density, wall):
    dimensions = np.array(size) * 2
    mass = float(np.prod(dimensions) * density)
    inertia = mass / 12 * (np.sum(dimensions**2) - dimensions**2)
    if wall:
        inner = dimensions - 2 * wall
        removed = float(np.prod(inner) * density)
        inertia -= removed / 12 * (np.sum(inner**2) - inner**2)
        mass -= removed
    return mass, np.diag(inertia)


def ring_properties(radius, inner, length, density):
    mass = math.pi * (radius**2 - inner**2) * length * density
    axial = mass * (radius**2 + inner**2) / 2
    radial = mass * (3 * (radius**2 + inner**2) + length**2) / 12
    return mass, np.diag([axial, radial, radial])


def add_component(body, parts, label, position, shape, size, mass, tensor, detail):
    attributes = dict(
        name=label,
        type=shape,
        pos=numbers(position),
        size=numbers(size),
        mass="0",
        rgba="0.65 0.70 0.73 1",
        friction="0.7 0.005 0.0001",
    )
    if shape == "cylinder":
        attributes["quat"] = numbers([2**-0.5, 0, 2**-0.5, 0])
    ET.SubElement(body, "geom", attributes)
    parts.append(
        dict(
            name=label,
            body=body.get("name"),
            positionM=list(position),
            shape=shape,
            sizeM=list(size),
            massKg=mass,
            inertiaAtCenterKgM2=tensor.tolist(),
            detail=detail,
        )
    )


def add_box(body, parts, label, position, size, density, wall=0):
    mass, tensor = box_properties(size, density, wall)
    add_component(
        body,
        parts,
        label,
        position,
        "box",
        size,
        mass,
        tensor,
        dict(densityKgM3=density, closedSectionWallM=wall),
    )


def add_ring(body, parts, label, position, outer, inner, length):
    mass, tensor = ring_properties(outer, inner, length, ALUMINIUM)
    add_component(
        body,
        parts,
        label,
        position,
        "cylinder",
        [outer, length / 2],
        mass,
        tensor,
        dict(densityKgM3=ALUMINIUM, boreRadiusM=inner),
    )


def add_allowance(body, parts, label, position, size, mass, reason):
    _, tensor = box_properties(size, mass / np.prod(np.array(size) * 2), 0)
    add_component(
        body,
        parts,
        label,
        position,
        "box",
        size,
        mass,
        tensor,
        dict(assumedMassReason=reason),
    )


def set_inertia(body, parts):
    selected = [part for part in parts if part["body"] == body.get("name")]
    mass = sum(part["massKg"] for part in selected)
    center = (
        sum(part["massKg"] * np.array(part["positionM"]) for part in selected) / mass
    )
    tensor = np.zeros((3, 3))
    for part in selected:
        delta = np.array(part["positionM"]) - center
        tensor += np.array(part["inertiaAtCenterKgM2"]) + part["massKg"] * (
            np.dot(delta, delta) * np.eye(3) - np.outer(delta, delta)
        )
    ET.SubElement(
        body,
        "inertial",
        mass=str(mass),
        pos=numbers(center),
        fullinertia=numbers(
            [
                tensor[0, 0],
                tensor[1, 1],
                tensor[2, 2],
                tensor[0, 1],
                tensor[0, 2],
                tensor[1, 2],
            ]
        ),
    )
    return dict(
        massKg=mass, centerOfMassM=center.tolist(), inertiaAtCenterKgM2=tensor.tolist()
    )


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    root = ET.Element(
        "mujoco", model="UR5e hollow spacer and guided tray clamp prototype"
    )
    ET.SubElement(root, "compiler", angle="radian", autolimits="true")
    world = ET.SubElement(root, "worldbody")
    tool = ET.SubElement(
        world,
        "body",
        name="cell_gripper",
        pos="0 0 0.12",
        quat=numbers([0, 2**-0.5, 0, 2**-0.5]),
    )
    jaw = ET.SubElement(tool, "body", name="cell_upper_jaw")
    ET.SubElement(
        jaw,
        "joint",
        name="clamp_opening",
        type="slide",
        axis="0 0 1",
        range="-0.002 0.04",
        damping="10",
        armature="0.002",
        frictionloss="0.2",
    )
    parts = []
    add_ring(tool, parts, "clamp_mount_spacer", [-0.06, 0, 0], 0.019, 0.016, 0.104)
    add_ring(tool, parts, "clamp_mount_base", [-0.116, 0, 0], 0.0315, 0.01575, 0.008)
    add_ring(tool, parts, "clamp_mount_end", [-0.004, 0, 0], 0.0315, 0.01575, 0.008)
    add_ring(tool, parts, "clamp_adapter", [0.004, 0, 0], 0.0315, 0.01575, 0.008)
    add_ring(tool, parts, "clamp_hub", [0.020, 0, 0], 0.015, 0, 0.024)
    add_box(tool, parts, "clamp_palm", [0.035, 0, 0.01], [0.003, 0.17, 0.02], ALUMINIUM)
    for suffix, y in [("left", 0.14), ("right", -0.14)]:
        add_box(
            tool,
            parts,
            "clamp_fork_" + suffix,
            [0.18, y, -0.006],
            [0.13, 0.015, 0.006],
            ALUMINIUM,
            0.0015,
        )
        add_box(
            jaw,
            parts,
            "clamp_finger_" + suffix,
            [0.1175, 0.19 if y > 0 else -0.19, 0.025],
            [0.0525, 0.005, 0.004],
            ALUMINIUM,
            0.0015,
        )
        add_box(
            jaw,
            parts,
            "clamp_pad_" + suffix,
            [0.16, 0.19 if y > 0 else -0.19, 0.0135],
            [0.025, 0.005, 0.0115],
            POLYMER,
        )
    add_box(
        jaw,
        parts,
        "clamp_bridge",
        [0.065, 0, 0.035],
        [0.012, 0.20, 0.01],
        ALUMINIUM,
        0.0015,
    )
    add_allowance(
        tool,
        parts,
        "clamp_actuator",
        [0.006, 0, 0.047],
        [0.020, 0.0125, 0.022],
        0.14,
        "Compact pneumatic drive and guides: supplier selection pending",
    )
    add_allowance(
        tool,
        parts,
        "clamp_fasteners",
        [-0.110, 0, 0.023],
        [0.004, 0.018, 0.003],
        0.055,
        "M6 fasteners, dowel and ancillary hardware allowance; unmeasured",
    )
    add_allowance(
        jaw,
        parts,
        "clamp_guide_carriage",
        [0.055, 0, 0.032],
        [0.008, 0.012, 0.012],
        0.025,
        "Moving guide and rod hardware allowance; unmeasured",
    )
    ET.SubElement(
        tool, "site", name="cell_grasp", pos="0.16 0 0", size="0.008", group="3"
    )
    bodies = {"tool": set_inertia(tool, parts), "jaw": set_inertia(jaw, parts)}
    actuators = ET.SubElement(root, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="clamp_servo",
        joint="clamp_opening",
        kp="20000",
        kv="40",
        forcelimited="true",
        forcerange="-100 100",
        ctrllimited="true",
        ctrlrange="-0.005 0.04",
    )
    ET.indent(root)
    ET.ElementTree(root).write(OUTPUT / "gripper.xml", encoding="unicode")
    report = dict(
        status="dimensioned simulation prototype; supplier and structural validation pending",
        units="metres, kilograms, seconds",
        bodies=bodies,
        parts=parts,
        totalMassKg=sum(part["massKg"] for part in parts),
        mounting=dict(
            faceToFaceM=0.12,
            boltCircleDiameterM=0.05,
            bolts="4 x M6 at each interface",
            flangeOuterDiameterM=0.063,
            flangeThicknessM=0.008,
            boreDiameterM=0.0315,
            note="Bolt engagement, recesses, dowel slot, tube-to-flange joints and tolerances need released drawings. Collision cylinders conservatively close the bores. Machined bolt holes are not deducted from mass.",
        ),
    )
    (OUTPUT / "mass-properties.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(bodies))
    print("Tool mass", report["totalMassKg"])


if __name__ == "__main__":
    main()
