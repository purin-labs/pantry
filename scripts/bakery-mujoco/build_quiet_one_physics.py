"""Export saved Quiet One surfaces and build an uncalibrated native mechanism."""

import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import export_visual_meshes, write_xml
from vessel_handling import add_vessel_contacts

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/vitamix-quiet-one"
NAMES = (
    "tqo_blender",
    "tqo_enclosure_door",
    "tqo_container",
    "tqo_container_lid",
    "tqo_blade",
)


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    source = ASSETS / "vitamix-quiet-one.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
            continue
        parent = obj.parent
        while parent not in parts:
            parent = parent.parent
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
    bpy.context.view_layer.update()
    for name in ("TQO clear enclosure polymer", "TQO clear container polymer"):
        bpy.data.materials[name].diffuse_color = (0.8, 0.9, 0.96, 0.18)
    export_visual_meshes(parts, ASSETS)

    model = ET.Element("mujoco", model="Quiet One — assumed native dynamics")
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep="0.0005", integrator="implicitfast")
    ET.SubElement(model, "size", nuserdata="4")
    defaults = ET.SubElement(model, "default")
    ET.SubElement(defaults, "pair", solref="0.002 1", solimp="0.99 0.999 0.001")
    ET.SubElement(
        defaults,
        "geom",
        group="3",
        friction="0.6 0.005 0.0001",
        solref="0.003 1",
        solimp="0.95 0.99 0.001",
        contype="0",
        conaffinity="0",
    )
    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")
    world = ET.SubElement(model, "worldbody")
    bodies = {}
    # Component masses and inertias are estimates, with no total-mass claim.
    masses = (8.0, 0.4, 0.65, 0.10, 0.08)
    centers = ((0, 0, 0.09), (0, -0.04, 0.02), (0, 0, 0.11), (0, 0, 0.01), (0, 0, 0))
    inertias = (0.025, 0.003, 0.002, 0.0002, 0.00002)
    for obj, mass, center, inertia in zip(parts, masses, centers, inertias):
        parent = bodies.get(obj.parent.name) if obj.parent else None
        transform = (
            poses[obj.name]
            if parent is None
            else poses[obj.parent.name].inverted() @ poses[obj.name]
        )
        body = ET.SubElement(
            world if parent is None else parent,
            "body",
            name=obj.name,
            pos=numbers(transform.translation),
            quat=numbers(transform.to_quaternion()),
        )
        bodies[obj.name] = body
        ET.SubElement(
            body,
            "inertial",
            mass=str(mass),
            pos=numbers(center),
            diaginertia=numbers((inertia, inertia, inertia)),
        )
        ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")
    base, door, jar, lid, blade = [bodies[name] for name in NAMES]
    ET.SubElement(
        base,
        "geom",
        name="tqo_pad_contact",
        type="box",
        pos="-.009 .003 .170",
        size=".067 .068 .0045",
    )
    ET.SubElement(
        door,
        "joint",
        name="tqo_door",
        type="hinge",
        axis="1 0 0",
        range=numbers((-math.radians(105), 0)),
        damping="0.3",
    )
    parent = next(node for node in model.iter() if jar in list(node))
    parent.remove(jar)
    model.find("worldbody").append(jar)
    ET.SubElement(jar, "freejoint", name="vessel_free")
    ET.SubElement(parent, "site", name="vessel_socket", pos=jar.get("pos"), size=".002", group="3")
    ET.SubElement(
        jar,
        "geom",
        name="tqo_jar_foot",
        type="box",
        pos="0 0 .004",
        size=".050 .050 .002",
    )
    ET.SubElement(
        lid,
        "joint",
        name="tqo_lid_lift",
        type="slide",
        axis="0 0 1",
        range="0 .10",
        damping="1",
    )
    ET.SubElement(
        blade,
        "joint",
        name="tqo_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping=".0002",
        solreffriction=".001 1",
        solimpfriction=".9999 .9999 .001",
    )
    ET.SubElement(
        blade,
        "geom",
        name="tqo_blade_envelope",
        type="cylinder",
        size=".040 .009",
        pos="0 0 .006",
        contype="2",
        conaffinity="4",
    )
    # A conservative cylindrical cavity proxy, independent of transparent surfaces.
    for i in range(24):
        angle = math.tau * i / 24
        ET.SubElement(
            jar,
            "geom",
            name=f"tqo_wall_{i}",
            type="box",
            pos=numbers((0.050 * math.cos(angle), 0.050 * math.sin(angle), 0.13)),
            size=".003 .007 .09",
            euler=numbers((0, 0, angle)),
            contype="4",
            conaffinity="2",
        )
    ET.SubElement(
        jar,
        "geom",
        name="tqo_inner_floor",
        type="cylinder",
        pos="0 0 .034",
        size=".05 .002",
        contype="4",
        conaffinity="2",
    )
    contact = ET.SubElement(model, "contact")
    # Explicit pairs permit contacts between parent and child bodies.
    ET.SubElement(contact, "pair", geom1="tqo_pad_contact", geom2="tqo_jar_foot")
    for i in range(24):
        ET.SubElement(
            contact, "pair", geom1="tqo_blade_envelope", geom2=f"tqo_wall_{i}"
        )
    ET.SubElement(contact, "pair", geom1="tqo_blade_envelope", geom2="tqo_inner_floor")
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="tqo_drive",
        joint="tqo_spin",
        kv=".02",
        forcerange="-1.2 1.2",
        ctrlrange="0 2514",
    )
    ET.SubElement(
        actuators,
        "position",
        name="tqo_door_fixture",
        joint="tqo_door",
        kp="30",
        kv="3",
        ctrlrange=numbers((-math.radians(105), 0)),
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "position",
        name="tqo_lid_fixture",
        joint="tqo_lid_lift",
        kp="1000",
        kv="10",
        ctrlrange="0 .09",
        forcerange="-10 10",
    )
    sensors = ET.SubElement(model, "sensor")
    ET.SubElement(sensors, "jointvel", name="tqo_blade_velocity", joint="tqo_spin")
    ET.SubElement(sensors, "actuatorfrc", name="tqo_motor_torque", actuator="tqo_drive")
    add_vessel_contacts(model, "tqo_container")
    write_xml(ASSETS / "blender.xml", model)
    scene = ET.Element("mujoco", model="Quiet One native lab")
    ET.SubElement(scene, "include", file="blender.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient=".4 .4 .4")
    world = ET.SubElement(scene, "worldbody")
    ET.SubElement(world, "light", pos="-1 -2 3", dir=".3 .5 -1")
    ET.SubElement(
        world,
        "geom",
        name="tqo_bench",
        type="plane",
        size="2 2 .05",
        pos="0 0 -.001",
        rgba=".25 .29 .32 1",
        group="2",
    )
    write_xml(ASSETS / "scene.xml", scene)
    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": NAMES,
                "assumptions": "Fixed base, guided jar/lid, estimated mass/inertia, conservative cavity and ideal blade coupling.",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
