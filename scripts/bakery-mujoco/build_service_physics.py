"""Build native grinder, ingredient scale and dishwasher inspection models."""

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

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco"


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def export_model(folder, source_name, names, masses):
    directory = ASSETS / folder
    source = directory / source_name
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    parts = [bpy.data.objects[name] for name in names]
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
    for material in bpy.data.materials:
        if "clear" in material.name.lower():
            material.diffuse_color = (0.8, 0.9, 0.96, 0.2)
    export_visual_meshes(parts, directory)
    model = ET.Element("mujoco", model=folder + " — assumed native dynamics")
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep=".001", integrator="implicitfast")
    defaults = ET.SubElement(model, "default")
    ET.SubElement(
        defaults,
        "geom",
        group="3",
        contype="0",
        conaffinity="0",
        friction=".6 .005 .0001",
        solref=".002 1",
        solimp=".99 .999 .001",
    )
    ET.SubElement(defaults, "pair", solref=".002 1", solimp=".99 .999 .001")
    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")
    world = ET.SubElement(model, "worldbody")
    bodies = {}
    for obj, mass in zip(parts, masses):
        parent = bodies.get(obj.parent.name) if obj.parent else None
        pose = (
            poses[obj.name]
            if parent is None
            else poses[obj.parent.name].inverted() @ poses[obj.name]
        )
        body = ET.SubElement(
            world if parent is None else parent,
            "body",
            name=obj.name,
            pos=numbers(pose.translation),
            quat=numbers(pose.to_quaternion()),
        )
        inertia = max(0.00002, mass * 0.04**2)
        ET.SubElement(
            body,
            "inertial",
            mass=str(mass),
            pos="0 0 0",
            diaginertia=numbers((inertia,) * 3),
        )
        ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")
        bodies[obj.name] = body
    (directory / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": names,
                "assumptions": "Estimated component mass/inertia and inspection fixtures; see active-states.md.",
            },
            indent=2,
        )
        + "\n"
    )
    return model, bodies, world


def fixture(actuators, name, joint, limits, kp, kv, force):
    ET.SubElement(
        actuators,
        "position",
        name=name,
        joint=joint,
        ctrlrange=limits,
        kp=str(kp),
        kv=str(kv),
        forcerange=f"-{force} {force}",
    )


def finish(folder, model):
    directory = ASSETS / folder
    write_xml(directory / "appliance.xml", model)
    scene = ET.Element("mujoco", model=folder + " lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient=".4 .4 .4")
    asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        asset,
        "texture",
        name="lab_sky",
        type="skybox",
        builtin="gradient",
        rgb1=".25 .30 .34",
        rgb2=".07 .09 .12",
        width="256",
        height="1536",
    )
    world = ET.SubElement(scene, "worldbody")
    ET.SubElement(world, "light", pos="-1 -2 3", dir=".3 .5 -1")
    ET.SubElement(
        world,
        "geom",
        name="bench",
        type="plane",
        size="3 3 .05",
        pos="0 0 -.001",
        rgba=".25 .29 .32 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(directory / "scene.xml", scene)


def grinder():
    names = ("wsg_grinder", "wsg_bowl", "wsg_cover", "wsg_blade")
    model, bodies, _ = export_model(
        "waring-wsg60", "waring-wsg60.blend", names, (2.55, 0.5, 0.14, 0.08)
    )
    base, bowl, cover, blade = [bodies[name] for name in names]
    ET.SubElement(
        base,
        "geom",
        name="wsg_seat",
        type="cylinder",
        pos="0 .015 .158",
        size=".042 .002",
    )
    parent = next(node for node in model.iter() if bowl in list(node))
    parent.remove(bowl)
    model.find("worldbody").append(bowl)
    ET.SubElement(bowl, "freejoint", name="vessel_free")
    ET.SubElement(
        parent,
        "site",
        name="vessel_socket",
        pos=bowl.get("pos"),
        size=".002",
        group="3",
    )
    ET.SubElement(
        bowl, "geom", name="wsg_foot", type="cylinder", pos="0 0 .002", size=".040 .002"
    )
    ET.SubElement(
        cover,
        "joint",
        name="wsg_unlock",
        type="hinge",
        axis="0 0 1",
        range="0 .32",
        damping=".1",
    )
    ET.SubElement(
        cover,
        "joint",
        name="wsg_cover_lift",
        type="slide",
        axis="0 0 1",
        range="0 .18",
        damping="2",
    )
    ET.SubElement(
        blade,
        "joint",
        name="wsg_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping=".0002",
        solreffriction=".002 1",
    )
    ET.SubElement(
        blade,
        "geom",
        name="wsg_blade_proxy",
        type="cylinder",
        pos="0 0 .004",
        size=".041 .006",
    )
    ET.SubElement(
        bowl, "geom", name="wsg_floor", type="cylinder", pos="0 0 .033", size=".05 .002"
    )
    contact = ET.SubElement(model, "contact")
    ET.SubElement(contact, "pair", geom1="wsg_seat", geom2="wsg_foot")
    ET.SubElement(contact, "pair", geom1="wsg_blade_proxy", geom2="wsg_floor")
    for i in range(24):
        angle = i * math.tau / 24
        ET.SubElement(
            bowl,
            "geom",
            name=f"wsg_wall_{i}",
            type="box",
            pos=numbers((0.05 * math.cos(angle), 0.05 * math.sin(angle), 0.075)),
            size=".002 .007 .035",
            euler=numbers((0, 0, angle)),
        )
        ET.SubElement(contact, "pair", geom1="wsg_blade_proxy", geom2=f"wsg_wall_{i}")
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="wsg_drive",
        joint="wsg_spin",
        kv=".02",
        ctrlrange="0 2200",
        forcerange="-.6 .6",
    )
    fixture(actuators, "wsg_unlock_fixture", "wsg_unlock", "0 .32", 10, 1, 5)
    fixture(actuators, "wsg_cover_fixture", "wsg_cover_lift", "0 .17", 1000, 15, 20)
    add_vessel_contacts(model, "wsg_bowl")
    finish("waring-wsg60", model)


def scale():
    names = ("ranger_scale", "ranger_weighing_pan")
    model, bodies, world = export_model(
        "ohaus-ranger-3000", "ohaus-r31pe6.blend", names, (3.8, 0.4)
    )
    pan = bodies[names[1]]
    ET.SubElement(
        pan,
        "joint",
        name="ranger_cell",
        type="slide",
        axis="0 0 1",
        limited="false",
        stiffness="20000",
        damping="300",
    )
    ET.SubElement(
        pan,
        "geom",
        name="ranger_pan_contact",
        type="box",
        pos="0 0 -.002",
        size=".15 .1125 .002",
        contype="1",
        conaffinity="1",
    )
    for name, mass, size, pos, color in (
        ("vessel", 0.5, (0.065, 0.05, 0.02), (-0.3, 0.04, 0.021), ".3 .6 .8 1"),
        ("sample", 1.25, (0.04, 0.035, 0.018), (0.3, 0.04, 0.019), ".85 .65 .25 1"),
        ("overload", 5, (0.035, 0.03, 0.025), (0.3, 0.2, 0.026), ".7 .3 .3 1"),
    ):
        body = ET.SubElement(world, "body", name=name, pos=numbers(pos))
        ET.SubElement(body, "freejoint", name=name + "_free")
        ET.SubElement(
            body,
            "geom",
            name=name + "_contact",
            type="box",
            size=numbers(size),
            mass=str(mass),
            rgba=color,
            group="2",
            contype="1",
            conaffinity="1",
        )
    finish("ohaus-ranger-3000", model)


def dishwasher():
    names = (
        "ucl_dishwasher",
        "ucl_door",
        "ucl_wash_rack",
        "ucl_lower_wash_field",
        "ucl_upper_wash_field",
    )
    model, bodies, _ = export_model(
        "winterhalter-uc-l", "winterhalter-uc-l.blend", names, (55, 7, 2, 0.25, 0.25)
    )
    base, door, rack, lower, upper = [bodies[name] for name in names]
    # Door centre of mass is estimated in its local upright frame.
    door.find("inertial").set("pos", "0 0 .2")
    door.find("inertial").set("diaginertia", ".4 .4 .2")
    ET.SubElement(
        door,
        "joint",
        name="ucl_door_hinge",
        type="hinge",
        axis="1 0 0",
        range="0 1.57079633",
        damping="2",
    )
    ET.SubElement(
        door,
        "geom",
        name="ucl_door_support",
        type="box",
        pos="0 .010 .22",
        size=".255 .003 .218",
    )
    ET.SubElement(
        base,
        "geom",
        name="ucl_rails",
        type="box",
        pos="0 0 .323",
        size=".255 .275 .005",
    )
    ET.SubElement(
        rack,
        "joint",
        name="ucl_rack_slide",
        type="slide",
        axis="0 1 0",
        range="-.56 0",
        damping="5",
    )
    # The handling fixture guides the rack along the horizontal supports.
    # Vertical removal belongs to the Blender access demonstration, not this
    # native fixture. The passive vertical joint caused rack bounce under load.
    ET.SubElement(
        rack,
        "geom",
        name="ucl_rack_floor",
        type="box",
        pos="0 0 0",
        size=".247 .247 .003",
    )
    contact = ET.SubElement(model, "contact")
    ET.SubElement(contact, "pair", geom1="ucl_rails", geom2="ucl_rack_floor")
    ET.SubElement(contact, "pair", geom1="ucl_door_support", geom2="ucl_rack_floor")
    actuators = ET.SubElement(model, "actuator")
    fixture(
        actuators, "ucl_door_fixture", "ucl_door_hinge", "0 1.57079633", 800, 80, 150
    )
    fixture(actuators, "ucl_rack_fixture", "ucl_rack_slide", "-.56 0", 3000, 100, 100)
    for name, body in (("lower", lower), ("upper", upper)):
        ET.SubElement(
            body,
            "joint",
            name=f"ucl_{name}_spin",
            type="hinge",
            axis="0 0 1",
            limited="false",
            damping=".01",
        )
        ET.SubElement(
            actuators,
            "velocity",
            name=f"ucl_{name}_drive",
            joint=f"ucl_{name}_spin",
            kv=".2",
            ctrlrange="0 10",
            forcerange="-.5 .5",
        )
    finish("winterhalter-uc-l", model)


if __name__ == "__main__":
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    grinder()
    scale()
    dishwasher()
