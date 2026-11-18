"""Export Eagle One guided appliance mechanics; no calibrated hardware dynamics."""

import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import export_visual_meshes, write_xml
from build_linea_classic_s_physics import joint, position, numbers, guided_cup

ROOT = Path(__file__).resolve().parents[2]
NAME = "victoria-arduino-eagle-one-2g"
OUT = ROOT / "assets/bakery-mujoco" / NAME


def contact(body, name, pos, size, kind="box"):
    ET.SubElement(
        body,
        "geom",
        name=name,
        type=kind,
        pos=pos,
        size=size,
        mass="0",
        contype="1",
        conaffinity="1",
        rgba=".2 .3 .4 .15",
    )


def mechanism(body, actuators, suffix, limits, mass, axis=(0, 0, 1), slide=False):
    joint(body, "eo_" + suffix, axis, limits, mass, "slide" if slide else "hinge")
    position(actuators, "eo_" + suffix + "_control", "eo_" + suffix, limits, slide)


def main():
    source = OUT / (NAME + ".blend")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    root = bpy.data.objects[NAME]
    parts = [root, *[o for o in root.children_recursive if o.type == "EMPTY"]]
    for obj in list(root.children_recursive):
        if "group timer" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
    export_visual_meshes(parts, OUT)
    model = ET.Element("mujoco", model="Eagle One two-group uncalibrated rehearsal")
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep=".002", integrator="implicitfast")
    ET.SubElement(
        ET.SubElement(model, "default"),
        "geom",
        contype="0",
        conaffinity="0",
        friction=".7 .005 .001",
    )
    ET.SubElement(ET.SubElement(model, "asset"), "include", file="visual_assets.xml")
    world = ET.SubElement(model, "worldbody")
    ET.SubElement(
        world, "geom", type="plane", size="2 2 .1", contype="1", conaffinity="1"
    )
    bodies = {}
    remaining = parts.copy()
    while remaining:
        available = [
            o for o in remaining if o.parent is None or o.parent.name in bodies
        ]
        assert available, "Unresolved visual hierarchy"
        for obj in available:
            parent = world if obj.parent is None else bodies[obj.parent.name]
            transform = obj.matrix_local if obj.parent else obj.matrix_world
            body = ET.SubElement(
                parent,
                "body",
                name=obj.name,
                pos=numbers(transform.translation),
                quat=numbers(transform.to_quaternion()),
            )
            ET.SubElement(body, "include", file="visual_" + obj.name + ".xml")
            bodies[obj.name] = body
            remaining.remove(obj)
    # Fixed housing avoids sealing the working space under the groups.
    housing = bodies[NAME]
    ET.SubElement(
        housing, "inertial", pos="0 .06 .24", mass="66.88", diaginertia="2.2 2.5 2"
    )
    contact(housing, "eo_rear_housing", "0 .08 .25", ".335 .17 .16")
    contact(bodies["drip_grate"], "eo_lower_support", "0 0 -.002", ".335 .073 .002")
    contact(
        bodies["raised_cup_support"],
        "eo_raised_support",
        "0 0 -.002",
        ".326 .0325 .002",
    )
    actuators = ET.SubElement(model, "actuator")
    for side in ("left", "right"):
        pf = bodies["eo_" + side + "_portafilter"]
        mechanism(pf, actuators, side + "_lift", (-0.10, 0), 0.6, slide=True)
        mechanism(pf, actuators, side + "_lock", (-0.62, 0), 0.6)
        contact(
            pf, "eo_" + side + "_filter_contact", "0 0 -.01", ".034 .01", "cylinder"
        )
        mechanism(
            bodies["eo_" + side + "_steam_lever"],
            actuators,
            side + "_steam",
            (0, 0.45),
            0.05,
            (1, 0, 0),
        )
        mechanism(
            bodies["eo_" + side + "_steam_wand"],
            actuators,
            side + "_wand",
            (-0.7, 0.7),
            0.12,
        )
        for index in (1, 2, 3):
            mechanism(
                bodies[f"eo_{side}_dose_{index}"],
                actuators,
                f"{side}_dose_{index}",
                (-0.001, 0),
                0.005,
                (0, -1, 0),
                True,
            )
        frame = ET.SubElement(
            bodies["eo_" + side + "_brew_group"],
            "body",
            name="live_" + side + "_timer",
            pos="0 -.053 .075",
            euler="1.57079632679 0 0",
        )
        ET.SubElement(
            frame,
            "geom",
            name="live_" + side + "_timer_back",
            type="box",
            size=".012 .007 .0002",
            rgba=".02 .02 .02 1",
            mass="0",
        )
    mechanism(
        bodies["eo_power_button"],
        actuators,
        "power",
        (-0.001, 0),
        0.005,
        (0, -1, 0),
        True,
    )
    mechanism(
        bodies["eo_hot_water_lever"], actuators, "hot_water", (0, 0.45), 0.05, (1, 0, 0)
    )
    for label, x, y, z in [
        ("left", -0.094, -0.17, 0.168),
        ("right", 0.144, -0.17, 0.168),
        ("hot_water", -0.218, -0.179, 0.168),
    ]:
        guided_cup(world, actuators, "eo", label, (x, y, z), 0.027)
    write_xml(OUT / "scene.xml", model)
    (OUT / "physics-export.json").write_text(
        json.dumps(
            {
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "bodies": [o.name for o in parts],
                "assumptions": [
                    "Guided cups and filter removal; no qualified bayonet geometry.",
                    "5000 W ceiling follows current page; Japanese electrical variant unverified.",
                    "Aggregate two-group thermal capacity; no separate NEO/TERS simulation.",
                    "Fixed housing inertia and moving component masses are estimates.",
                ],
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
