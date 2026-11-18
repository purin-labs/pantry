"""Export Linea visual bodies and guided mechanisms for the shared Rust runner.

58 kg total appliance mass follows the Japanese reference. Distribution, inertia,
servo forces, guided portafilter travel and swivel limits are unmeasured assumptions.
"""

import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import export_visual_meshes, write_xml

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "assets/bakery-mujoco/la-marzocco-linea-classic-s-2g"


def numbers(values):
    return " ".join(f"{value:.12g}" for value in values)


def joint(body, name, axis, limits, mass, kind="hinge"):
    ET.SubElement(
        body,
        "joint",
        name=name,
        type=kind,
        axis=numbers(axis),
        range=numbers(limits),
        damping="8" if kind == "slide" else ".08",
    )
    if body.find("inertial") is None:
        ET.SubElement(
            body,
            "inertial",
            pos="0 0 0",
            mass=str(mass),
            diaginertia=".0004 .0004 .0004",
        )


def position(actuators, name, joint_name, limits, slide=False):
    ET.SubElement(
        actuators,
        "position",
        name=name,
        joint=joint_name,
        kp="20000" if slide else "30",
        kv="100" if slide else "1",
        ctrlrange=numbers(limits),
        forcerange="-100 100" if slide else "-8 8",
    )


def guided_cup(world, actuators, prefix, label, location, radius):
    name = f"{prefix}_{label}_cup"
    cup = ET.SubElement(world, "body", name=name, pos=numbers(location))
    joint(cup, name + "_travel", (0, -1, 0), (0, 0.18), 0.2, "slide")
    position(actuators, name + "_control", name + "_travel", (0, 0.18), True)
    joint(cup, name + "_vertical", (0, 0, 1), (-0.02, 0.005), 0.2, "slide")
    cup.find("inertial").set(
        "diaginertia",
        numbers(
            (
                0.2 * (3 * radius**2 + 0.07**2) / 12,
                0.2 * (3 * radius**2 + 0.07**2) / 12,
                0.2 * radius**2 / 2,
            )
        ),
    )
    ET.SubElement(
        cup,
        "geom",
        name=name + "_contact",
        type="sphere",
        pos="0 0 -.02",
        size=".015",
        mass="0",
        contype="8",
        conaffinity="8",
        friction="0 0 0",
        solref=".02 1",
        condim="1",
        rgba=".92 .92 .89 1",
    )
    # A frictionless support is part of the guided handling fixture, not the appliance.
    ET.SubElement(
        world,
        "geom",
        name=name + "_guide",
        type="box",
        pos=numbers((location[0], location[1] - 0.09, location[2] - 0.037)),
        size=numbers((radius + 0.005, 0.09 + radius + 0.005, 0.002)),
        contype="8",
        conaffinity="8",
        condim="1",
        friction="0 0 0",
        rgba=".3 .3 .3 .1",
    )


def main():
    source = DIRECTORY / "la-marzocco-linea-classic-s-2g.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    parts = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "EMPTY" and obj.name.startswith("lcs_")
    ]
    # Live readouts replace the two decorative Blender timers in the physics view.
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith("Inactive shot timer"):
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in parts:
        obj.animation_data_clear()
    bpy.context.view_layer.update()
    export_visual_meshes(parts, DIRECTORY)
    model = ET.Element(
        "mujoco", model="Linea Classic S AV — uncalibrated control rehearsal"
    )
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep=".002", integrator="implicitfast")
    default = ET.SubElement(model, "default")
    ET.SubElement(
        default, "geom", contype="0", conaffinity="0", friction=".7 .005 .001"
    )
    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")
    world = ET.SubElement(model, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="lcs_floor",
        type="plane",
        size="2 2 .1",
        rgba=".3 .32 .34 1",
        contype="1",
        conaffinity="1",
    )
    bodies = {}
    remaining = list(parts)
    while remaining:
        progressed = False
        for obj in remaining[:]:
            if obj.parent and obj.parent.name not in bodies:
                continue
            parent = world if obj.parent is None else bodies[obj.parent.name]
            transform = obj.matrix_local if obj.parent else obj.matrix_world
            body = ET.SubElement(
                parent,
                "body",
                name=obj.name,
                pos=numbers(transform.translation),
                quat=numbers(transform.to_quaternion()),
            )
            ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")
            bodies[obj.name] = body
            remaining.remove(obj)
            progressed = True
        assert progressed, "Unresolved named body parent"
    root = bodies["lcs_machine"]
    # Fixed housing; dynamic component estimates are separate below.
    ET.SubElement(
        root, "inertial", pos="0 .02 .3", mass="56.183", diaginertia="2.2 2.5 2.0"
    )
    ET.SubElement(
        root,
        "geom",
        name="lcs_housing_contact",
        type="box",
        pos="0 .09 .34",
        size=".32 .18 .15",
        mass="0",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        bodies["lcs_drip_grate"],
        "geom",
        name="lcs_cup_support",
        type="box",
        size=".32 .085 .002",
        mass="0",
        contype="1",
        conaffinity="1",
    )
    actuator = ET.SubElement(model, "actuator")
    for side in ("left", "right"):
        pf = bodies[f"lcs_{side}_portafilter"]
        joint(pf, f"lcs_{side}_lift", (0, 0, 1), (-0.10, 0), 0.6, "slide")
        joint(pf, f"lcs_{side}_lock", (0, 0, 1), (-0.62, 0), 0.6)
        position(
            actuator, f"lcs_{side}_lift_control", f"lcs_{side}_lift", (-0.10, 0), True
        )
        position(actuator, f"lcs_{side}_lock_control", f"lcs_{side}_lock", (-0.62, 0))
        ET.SubElement(
            pf,
            "geom",
            name=f"lcs_{side}_filter_contact",
            type="cylinder",
            pos="0 0 -.01",
            size=".034 .01",
            mass="0",
            contype="1",
            conaffinity="1",
        )
        knob = bodies[f"lcs_{side}_steam_knob"]
        joint(knob, f"lcs_{side}_steam", (0, -1, 0), (0, math.pi), 0.1)
        position(
            actuator, f"lcs_{side}_steam_control", f"lcs_{side}_steam", (0, math.pi)
        )
        wand = bodies[f"lcs_{side}_steam_wand"]
        joint(wand, f"lcs_{side}_wand_swivel", (0, 0, 1), (-0.7, 0.7), 0.15)
        position(
            actuator, f"lcs_{side}_wand_control", f"lcs_{side}_wand_swivel", (-0.7, 0.7)
        )
        for index in (1, 2, 3):
            button = bodies[f"lcs_{side}_dose_{index}"]
            joint_name = f"lcs_{side}_dose_{index}"
            joint(button, joint_name, (0, -1, 0), (-0.001, 0), 0.005, "slide")
            position(actuator, joint_name + "_control", joint_name, (-0.001, 0), True)
    hot_water_button = bodies["lcs_hot_water_button"]
    joint(hot_water_button, "lcs_hot_water", (0, -1, 0), (-0.001, 0), 0.005, "slide")
    position(actuator, "lcs_hot_water_control", "lcs_hot_water", (-0.001, 0), True)
    for kind in ("coffee", "steam"):
        body = bodies[f"lcs_{kind}_pressure_needle"]
        joint(body, f"lcs_{kind}_pressure", (0, -1, 0), (0, 4), 0.001)
        body.find("inertial").set("diaginertia", "1e-7 1e-7 1e-7")
        body.find("joint").set("damping", ".001")
        position(
            actuator, f"lcs_{kind}_pressure_control", f"lcs_{kind}_pressure", (0, 4)
        )
    # Generic cups belong to the rehearsal, separate from the manufacturer asset.
    for label, x in (("left", -0.12), ("right", 0.12), ("hot_water", 0.215)):
        guided_cup(world, actuator, "lcs", label, (x, -0.195, 0.225), 0.032)
    switch = bodies["lcs_power_switch"]
    joint(switch, "lcs_power", (0, -1, 0), (0, math.pi / 2), 0.1)
    position(actuator, "lcs_power_control", "lcs_power", (0, math.pi / 2))
    write_xml(DIRECTORY / "scene.xml", model)
    (DIRECTORY / "physics-export.json").write_text(
        json.dumps(
            {
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "bodies": [obj.name for obj in parts],
                "scope": "Guided portafilter travel, compliant actuators and display frames. No free handling or certified bayonet geometry.",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
