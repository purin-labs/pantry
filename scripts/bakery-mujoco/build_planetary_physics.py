"""Export the saved AICOH/Hobart surfaces and author bounded planetary mechanisms."""

import copy
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from itertools import pairwise
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import export_visual_meshes, write_xml

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco"


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def bowl_colliders(asset, body, profile):
    """Short convex wall sections preserve the empty interior of a curved bowl."""
    for band, ((r0, z0), (r1, z1)) in enumerate(pairwise(profile)):
        for sector in range(24):
            angles = (math.tau * sector / 24, math.tau * (sector + 1) / 24)
            points = []
            for radius, z in ((r0, z0), (r1, z1)):
                for offset in (0, 0.004):
                    for angle in angles:
                        points.extend(
                            (
                                (radius + offset) * math.cos(angle),
                                (radius + offset) * math.sin(angle),
                                z,
                            )
                        )
            name = f"mix_bowl_wall_{band}_{sector}"
            ET.SubElement(asset, "mesh", name=name, vertex=numbers(points))
            ET.SubElement(
                body,
                "geom",
                name=name,
                type="mesh",
                mesh=name,
                contype="1",
                conaffinity="2",
                group="3",
                mass="0",
            )
    ET.SubElement(
        body,
        "geom",
        name="mix_bowl_floor",
        type="cylinder",
        pos=numbers((0, 0, profile[0][1] - 0.001)),
        size=numbers((profile[0][0], 0.001)),
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )


def build(name, prefix, speeds, lift_travel, guard_angle, total_mass, profile):
    directory = ASSETS / name
    source = directory / (name + ".blend")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    names = [
        prefix + suffix
        for suffix in (
            "_mixer",
            "_bowl_lift",
            "_bowl",
            "_guard",
            "_planetary",
            "_tool_axis",
        )
    ]
    parts = [bpy.data.objects[value] for value in names]
    attachments = [bpy.data.objects[prefix + suffix] for suffix in ("_beater", "_whip")]
    installed = attachments[1] if prefix == "ms" else attachments[0]
    alternate = attachments[0] if prefix == "ms" else attachments[1]
    alternate.animation_data_clear()
    alternate.parent = parts[5]
    alternate.location = (0, 0, 0)
    alternate.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}
    poses.update({obj.name: obj.matrix_world.copy() for obj in attachments})
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
            continue
        parent = obj.parent
        while parent not in parts + attachments:
            parent = parent.parent
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
    bpy.context.view_layer.update()
    export_visual_meshes(parts + attachments, directory)
    model = ET.Element("mujoco", model=name + " — uncalibrated planetary lab")
    ET.SubElement(model, "compiler", angle="radian")
    # The smaller step limits gear-constraint deflection during a sudden jam.
    ET.SubElement(model, "option", timestep="0.0005", integrator="implicitfast")
    ET.SubElement(model, "size", nuserdata="4")
    defaults = ET.SubElement(model, "default")
    ET.SubElement(
        defaults,
        "geom",
        friction="0.4 0.005 0.0001",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
    )
    custom = ET.SubElement(model, "custom")
    ET.SubElement(
        custom, "numeric", name="mix_speed_settings_rpm", data=numbers(speeds)
    )
    ET.SubElement(custom, "numeric", name="mix_lift_travel", data=str(lift_travel))
    ET.SubElement(custom, "numeric", name="mix_guard_open", data=str(guard_angle))
    # Assumed gear ratio: relative tool spin = -4 × carrier orbit.
    # A selected published RPM is mapped to absolute tool spin in this lab only.
    ET.SubElement(custom, "numeric", name="mix_gear_ratio", data="-4")
    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")
    world = ET.SubElement(model, "worldbody")
    body_elements = {}
    large = prefix == "ms"
    masses = (
        total_mass - (23 if large else 10.7),
        8 if large else 3,
        9 if large else 4,
        2 if large else 1,
        3 if large else 2,
        1 if large else 0.7,
    )
    for obj, mass in zip(parts, masses):
        parent = body_elements.get(obj.parent.name) if obj.parent else None
        if parent is None:
            parent = world
            transform = poses[obj.name]
        else:
            transform = poses[obj.parent.name].inverted() @ poses[obj.name]
        body = ET.SubElement(
            parent,
            "body",
            name=obj.name,
            pos=numbers(transform.translation),
            quat=numbers(transform.to_quaternion()),
        )
        body_elements[obj.name] = body
        # Explicit inertias; visual meshes and contact walls do not infer mass.
        inertia = max(0.003, mass * (0.1 if large else 0.05) ** 2)
        center = (0, 0, 0)
        if obj == parts[1]:
            center = (0, -0.1, 0.75 if large else 0.25)
        if obj == parts[2]:
            center = (0, 0, 0.15 if large else 0.12)
        if obj == parts[3]:
            center = (0, 0, 1.0 if large else 0.42)
        if obj == parts[5]:
            center = (0, 0, -0.25 if large else -0.18)
        ET.SubElement(
            body,
            "inertial",
            mass=str(mass),
            pos=numbers(center),
            diaginertia=numbers((inertia, inertia, inertia)),
        )
        ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")
    lift, bowl, guard, orbit, tool = [body_elements[obj.name] for obj in parts[1:]]
    ET.SubElement(
        lift,
        "joint",
        name="mix_lift",
        type="slide",
        axis="0 0 1",
        range=numbers((-lift_travel, 0)),
        damping="100",
        solreflimit="0.004 1",
    )
    ET.SubElement(
        guard,
        "joint",
        name="mix_guard",
        type="hinge",
        axis="0 0 1",
        range=numbers((min(0, guard_angle), max(0, guard_angle))),
        damping="0.5",
    )
    ET.SubElement(
        orbit,
        "joint",
        name="mix_orbit",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.05" if large else "0.02",
    )
    ET.SubElement(
        tool,
        "joint",
        name="mix_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.025" if large else "0.01",
        solreffriction="0.004 1",
        solimpfriction="0.9999 0.9999 0.001",
    )
    bowl_colliders(asset, bowl, profile)
    equality = ET.SubElement(model, "equality")
    # Removable parts use free joints. Welds approximate engaged clamps/bayonets.
    lift.remove(bowl)
    bowl.set("pos", numbers(poses[parts[2].name].translation))
    world.append(bowl)
    ET.SubElement(bowl, "freejoint", name="mix_bowl_free")
    ET.SubElement(
        lift,
        "site",
        name="mix_bowl_mount",
        pos=bowl.get("pos"),
        size="0.004",
        group="3",
    )
    ET.SubElement(
        equality,
        "weld",
        name="mix_bowl_coupling",
        body1=parts[1].name,
        body2=parts[2].name,
        solref="0.002 1",
    )
    # A broad receiving pad verifies support when the detached bowl leaves the mixer.
    bowl_z = float(poses[parts[2].name].translation.z)
    ET.SubElement(
        world,
        "geom",
        name="mix_bowl_bench",
        type="box",
        pos=numbers((0, -0.95, bowl_z - lift_travel - 0.025)),
        size="0.3 0.3 0.025",
        rgba="0.32 0.36 0.39 1",
        contype="2",
        conaffinity="1",
    )
    ET.SubElement(tool, "site", name="mix_tool_mount", size="0.004", group="3")
    tool.find("inertial").set("mass", "0.2")
    tool.find("inertial").set("pos", "0 0 0")
    for attachment in attachments:
        kind = attachment.name.split("_")[-1]
        mounted = attachment == installed
        position = poses[attachment.name].translation.copy()
        if not mounted:
            position.x += 0.65
            position.y = -0.65
        body = ET.SubElement(world, "body", name=attachment.name, pos=numbers(position))
        ET.SubElement(body, "freejoint", name=f"mix_{kind}_free")
        ET.SubElement(
            body,
            "inertial",
            mass=str((1 if large else 0.7) - 0.2),
            pos=numbers((0, 0, -0.25 if large else -0.18)),
            diaginertia="0.006 0.006 0.003",
        )
        ET.SubElement(body, "include", file=f"visual_{attachment.name}.xml")
        for index, visual in enumerate(
            ET.parse(directory / f"visual_{attachment.name}.xml").getroot()
        ):
            contact = copy.deepcopy(visual)
            contact.set("name", f"mix_{kind}_contact_{index}")
            contact.set("contype", "2")
            contact.set("conaffinity", "1")
            contact.set("group", "3")
            body.append(contact)
        ET.SubElement(
            equality,
            "weld",
            name=f"mix_{kind}_coupling",
            body1=parts[5].name,
            body2=attachment.name,
            relpose="0 0 0 1 0 0 0",
            active=str(mounted).lower(),
            solref="0.002 1",
            solimp="0.9999 0.9999 0.001",
        )
        rack_pos = (0.65 if kind == "whip" else -0.65, -0.65, float(poses[parts[5].name].translation.z))
        if not mounted:
            body.set("pos", numbers(rack_pos))
        rack = ET.SubElement(
            world, "body", name=f"mix_{kind}_rack", pos=numbers(rack_pos)
        )
        ET.SubElement(
            rack,
            "geom",
            type="cylinder",
            pos="0 0 0.02",
            size="0.035 0.02",
            rgba="0.3 0.35 0.4 1",
            contype="0",
            conaffinity="0",
        )
        ET.SubElement(
            equality,
            "weld",
            name=f"mix_{kind}_parking",
            body1=rack.get("name"),
            body2=attachment.name,
            relpose="0 0 0 1 0 0 0",
            active=str(not mounted).lower(),
            solref="0.002 1",
        )
    ET.SubElement(
        equality,
        "joint",
        name="mix_gears",
        joint1="mix_spin",
        joint2="mix_orbit",
        polycoef="0 -4 0 0 0",
        solref="0.001 1",
        solimp="0.9999 0.9999 0.001",
    )
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="mix_drive",
        joint="mix_orbit",
        kv="20",
        ctrlrange="0 20",
        forcerange="-16 16" if large else "-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mix_lift_fixture",
        joint="mix_lift",
        kp="120000",
        kv="1500",
        ctrlrange=numbers((-lift_travel, 0)),
        forcerange="-1000 1000",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mix_guard_fixture",
        joint="mix_guard",
        kp="60",
        kv="12",
        ctrlrange=numbers((min(0, guard_angle), max(0, guard_angle))),
        forcerange="-60 60",
    )
    sensors = ET.SubElement(model, "sensor")
    for joint in ("orbit", "spin", "guard", "lift"):
        ET.SubElement(
            sensors, "jointpos", name=f"mix_{joint}_position", joint=f"mix_{joint}"
        )
        ET.SubElement(
            sensors, "jointvel", name=f"mix_{joint}_velocity", joint=f"mix_{joint}"
        )
    write_xml(directory / "mixer.xml", model)
    scene = ET.Element("mujoco", model=name + " native lab")
    ET.SubElement(scene, "include", file="mixer.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.35 0.35 0.35", diffuse="0.7 0.7 0.7")
    ET.SubElement(
        scene,
        "statistic",
        center=numbers((0, -0.1, 0.7 if large else 0.36)),
        extent="1.8" if large else "1.0",
    )
    scene_assets = ET.SubElement(scene, "asset")
    ET.SubElement(
        scene_assets,
        "texture",
        name="mix_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(
        scene_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1", diffuse="0.8 0.8 0.8"
    )
    ET.SubElement(
        scene_world, "light", pos="2 1 3", dir="-0.5 -0.2 -1", diffuse="0.5 0.5 0.5"
    )
    ET.SubElement(
        scene_world,
        "geom",
        name="mix_floor",
        type="plane",
        pos="0 0 -0.001",
        size="3 3 0.05",
        rgba="0.28 0.32 0.35 1",
        contype="1",
        conaffinity="2",
    )
    write_xml(directory / "scene.xml", scene)
    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "retained_bodies": names,
        "dry_mass_kg": total_mass,
        "assumptions": "Free bowl and two tools; pose-checked welds approximate clamps, bayonets and tool rack sockets. Estimated inertias, gear ratio and handling forces.",
    }
    (directory / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    build(
        "aicoh-ms-30",
        "ms",
        (120, 220, 320, 430),
        0.120,
        math.pi,
        287,
        [
            (0.059, 0.004),
            (0.080, 0.012),
            (0.110, 0.034),
            (0.143, 0.073),
            (0.168, 0.120),
            (0.178, 0.166),
            (0.180, 0.221),
            (0.182, 0.300),
            (0.182, 0.349),
        ],
    )
    build(
        "hobart-hl200",
        "hl",
        (59, 107, 198, 365),
        0.020,
        -math.tau / 3,
        85.7,
        [
            (0.042, 0.002),
            (0.063, 0.008),
            (0.088, 0.022),
            (0.113, 0.043),
            (0.135, 0.071),
            (0.148, 0.105),
            (0.153, 0.140),
            (0.154, 0.245),
            (0.155, 0.292),
        ],
    )


if __name__ == "__main__":
    main()
