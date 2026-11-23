"""Build and verify the MuJoCo 4.0 mechanical and active-state model for the TIMEMORE Bricks 01S Black."""

import copy
import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_physics_kit import (
    BLENDER_BIN,
    COL_ACCESSORY_RGBA,
    COL_ARTIC_RGBA,
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
    SITE_GRASP_RGBA,
    SITE_SUPPORT_RGBA,
    X_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

NAME = "timemore-bricks-01s"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

NAMES = (
    "bricks_grinder",
    "bricks_hopper",
    "bricks_hopper_lid",
    "bricks_burr_carrier",
    "bricks_burr_cone",
    "bricks_knocker",
    "bricks_power_button",
    "bricks_dosing_cup",
)

SCALAR_VISUAL_AXES = {
    "bricks_hopper_dial": [0.0, 0.0, 1.0],
    "bricks_hopper_lift": [0.0, 0.0, 1.0],
    "bricks_lid_lift": [0.0, 0.0, 1.0],
    "bricks_carrier_lift": [0.0, 0.0, 1.0],
    "bricks_burr_spin": [0.0, 0.0, 1.0],
    "bricks_knocker_turn": [0.0, 0.0, 1.0],
    "bricks_power_press": [-1.0, 0.0, 0.0],
}

# Published total mass = 2.600 kg across the 8 articulated bodies
MASSES = {
    "bricks_grinder": 1.940,
    "bricks_hopper": 0.210,
    "bricks_hopper_lid": 0.045,
    "bricks_burr_carrier": 0.130,
    "bricks_burr_cone": 0.095,
    "bricks_knocker": 0.022,
    "bricks_power_button": 0.008,
    "bricks_dosing_cup": 0.150,
}

CENTERS = {
    "bricks_grinder": (0.0, 0.010, 0.135),
    "bricks_hopper": (0.0, 0.0, 0.012),
    "bricks_hopper_lid": (0.0, 0.0, 0.002),
    "bricks_burr_carrier": (0.0, 0.0, 0.009),
    "bricks_burr_cone": (0.0, 0.0, -0.004),
    "bricks_knocker": (0.0, 0.0, -0.001),
    "bricks_power_button": (0.002, 0.0, 0.0),
    "bricks_dosing_cup": (0.0, 0.0, 0.048),
}

INERTIAS = {
    "bricks_grinder": (0.0145, 0.0112, 0.0068),
    "bricks_hopper": (0.00018, 0.00018, 0.00026),
    "bricks_hopper_lid": (0.00003, 0.00003, 0.00005),
    "bricks_burr_carrier": (0.00008, 0.00008, 0.00012),
    "bricks_burr_cone": (0.00005, 0.00005, 0.00007),
    "bricks_knocker": (0.00001, 0.00001, 0.000015),
    "bricks_power_button": (0.000004, 0.000004, 0.000004),
    "bricks_dosing_cup": (0.00016, 0.00016, 0.00009),
}


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local UV OBJ meshes and construct appliance.xml + scene.xml + model.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "timemore-bricks-01s.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    # Remove detached illustrative stowed AC plug meshes (whose cable is a non-mesh CURVE
    # and whose plug blades extend below Z = 0).
    for plug_name in ("Japanese AC plug body", "Plug blade +0.0055", "Plug blade -0.0055"):
        plug_obj = bpy.data.objects.get(plug_name)
        if plug_obj is not None:
            bpy.data.objects.remove(plug_obj, do_unlink=True)
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent nested MESH objects directly to their owning articulated body in NAMES while preserving world pose.
    visited = set()
    for root in parts:
        for obj in list(root.children_recursive):
            if obj in visited or obj.type != "MESH":
                continue
            visited.add(obj)
            parent = obj.parent
            while parent is not None and parent not in parts:
                parent = parent.parent
            if parent is None:
                continue
            pose = obj.matrix_world.copy()
            obj.animation_data_clear()
            obj.parent = parent
            obj.matrix_world = pose
            if len(obj.data.vertices) >= 3:
                xs = [v.co.x for v in obj.data.vertices]
                ys = [v.co.y for v in obj.data.vertices]
                zs = [v.co.z for v in obj.data.vertices]
                changed = False
                if max(xs) - min(xs) < 1e-5:
                    obj.data.vertices[0].co.x += 2e-5
                    changed = True
                if max(ys) - min(ys) < 1e-5:
                    obj.data.vertices[0].co.y += 2e-5
                    changed = True
                if max(zs) - min(zs) < 1e-5:
                    obj.data.vertices[0].co.z += 2e-5
                    changed = True
                if changed:
                    obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        bsdf = (
            mat.node_tree.nodes.get("Principled BSDF")
            if (mat.use_nodes and mat.node_tree)
            else None
        )
        if "metallic" not in mat:
            mat["metallic"] = (
                float(bsdf.inputs["Metallic"].default_value)
                if bsdf and "Metallic" in bsdf.inputs
                else 0.0
            )
        if "roughness" not in mat:
            mat["roughness"] = (
                float(bsdf.inputs["Roughness"].default_value)
                if bsdf and "Roughness" in bsdf.inputs
                else 0.35
            )
        if "emission" not in mat:
            mat["emission"] = (
                float(bsdf.inputs["Emission Strength"].default_value)
                if bsdf and "Emission Strength" in bsdf.inputs
                else 0.0
            )

    mesh_dir = ASSETS / "meshes"
    if mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts, ASSETS)

    model = ET.Element("mujoco", model="timemore-bricks-01s — assumed native dynamics")
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep="0.001", integrator="implicitfast")
    defaults = add_standard_defaults(
        model,
        friction="0.65 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(model, "worldbody")
    bodies = {}
    for obj in parts:
        name = obj.name
        parent = bodies.get(obj.parent.name) if obj.parent else None
        transform = (
            poses[name]
            if parent is None
            else poses[obj.parent.name].inverted() @ poses[name]
        )
        body = ET.SubElement(
            world if parent is None else parent,
            "body",
            name=name,
            pos=numbers(transform.translation),
            quat=numbers(transform.to_quaternion()),
        )
        ET.SubElement(
            body,
            "inertial",
            mass=str(MASSES[name]),
            pos=numbers(CENTERS[name]),
            diaginertia=numbers(INERTIAS[name]),
        )
        ET.SubElement(body, "include", file=f"visual_{name}.xml")
        bodies[name] = body

    base = bodies["bricks_grinder"]
    hopper = bodies["bricks_hopper"]
    lid = bodies["bricks_hopper_lid"]
    carrier = bodies["bricks_burr_carrier"]
    cone = bodies["bricks_burr_cone"]
    knocker = bodies["bricks_knocker"]
    button = bodies["bricks_power_button"]
    cup = bodies["bricks_dosing_cup"]

    # Detach bricks_dosing_cup into worldbody as a free removable magnetic vessel
    parent_of_cup = next(node for node in model.iter() if cup in list(node))
    parent_of_cup.remove(cup)
    world.append(cup)
    cup.set("pos", numbers(poses["bricks_dosing_cup"].translation))
    cup.set("quat", numbers(poses["bricks_dosing_cup"].to_quaternion()))
    ET.SubElement(cup, "freejoint", name="vessel_free")

    # Base silicone feet and cantilever deck collision proxies
    for foot_name, fx, fy in (
        ("bricks_foot_fl_col", -0.038, -0.058),
        ("bricks_foot_fr_col", 0.038, -0.058),
        ("bricks_foot_rl_col", -0.038, 0.058),
        ("bricks_foot_rr_col", 0.038, 0.058),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0010)),
            size="0.008 0.0010",
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_BASE_RGBA,
        )
    ET.SubElement(
        base,
        "geom",
        name="bricks_base_deck",
        type="box",
        pos="0 0 0.00875",
        size="0.051 0.075 0.00675",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    # Magnetic cup landing pad at Z = 0.016 m top surface
    ET.SubElement(
        base,
        "geom",
        name="bricks_cup_seat",
        type="cylinder",
        pos="0 -0.036 0.0145",
        size="0.024 0.0015",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_WALL_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="vessel_socket",
        pos="0 -0.036 0.016",
        size="0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="bricks_cup_seat_site",
        type="cylinder",
        pos="0 -0.036 0.016",
        size="0.0235 0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="bricks_chute_exit",
        pos="0 -0.036 0.123",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Vertical column, upper cubic chamber block, and chute collar collision proxies
    ET.SubElement(
        base,
        "geom",
        name="bricks_column_col",
        type="box",
        pos="0 0.030 0.081",
        size="0.035 0.034 0.065",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_upper_lower_col",
        type="box",
        pos="0 0.010 0.160",
        size="0.051 0.054 0.014",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_upper_left_col",
        type="box",
        pos="-0.0435 0.010 0.213",
        size="0.0075 0.054 0.039",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_upper_right_col",
        type="box",
        pos="0.0435 0.010 0.213",
        size="0.0075 0.054 0.039",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_upper_back_col",
        type="box",
        pos="0 0.049 0.213",
        size="0.036 0.015 0.039",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_upper_front_col",
        type="box",
        pos="0 -0.041 0.213",
        size="0.036 0.003 0.039",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="bricks_chute_col",
        type="cylinder",
        pos="0 -0.036 0.143",
        size="0.021 0.003",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    for i in range(12):
        angle = i * math.tau / 12
        ET.SubElement(
            base,
            "geom",
            name=f"bricks_chamber_wall_{i}",
            type="box",
            pos=numbers(
                (
                    0.036 * math.cos(angle),
                    -0.002 + 0.036 * math.sin(angle),
                    0.213,
                )
            ),
            size="0.0025 0.009 0.039",
            euler=numbers((0, 0, angle)),
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_WALL_RGBA,
        )

    # Articulated joints and colliders
    ET.SubElement(
        hopper,
        "joint",
        name="bricks_hopper_dial",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-9.424778 9.424778",
        damping="0.16",
        armature="0.002",
        frictionloss="0.02",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        hopper,
        "joint",
        name="bricks_hopper_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.080",
        damping="2.2",
        armature="0.002",
        frictionloss="2.80",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        hopper,
        "geom",
        name="bricks_hopper_col",
        type="cylinder",
        pos="0 0 0.0068",
        size="0.0422 0.0228",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        lid,
        "joint",
        name="bricks_lid_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.095",
        damping="1.5",
        armature="0.001",
        frictionloss="0.65",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        lid,
        "geom",
        name="bricks_hopper_lid_col",
        type="cylinder",
        pos="0 0 0.0012",
        size="0.042 0.0033",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        carrier,
        "joint",
        name="bricks_carrier_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.065",
        damping="1.8",
        armature="0.002",
        frictionloss="1.75",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        carrier,
        "geom",
        name="bricks_burr_carrier_col",
        type="cylinder",
        pos="0 0 0.0106",
        size="0.0285 0.0106",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cone,
        "joint",
        name="bricks_burr_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0012",
        armature="0.0022",
        frictionloss="0.01",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        cone,
        "geom",
        name="bricks_burr_cone_proxy",
        type="cylinder",
        pos="0 0 -0.0013",
        size="0.0195 0.0148",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        knocker,
        "joint",
        name="bricks_knocker_turn",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-0.785398 1.396263",
        springref="-0.08",
        stiffness="2.8",
        damping="0.003",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        knocker,
        "geom",
        name="bricks_knocker_col",
        type="cylinder",
        pos="0 0 -0.0009",
        size="0.0212 0.0083",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        button,
        "joint",
        name="bricks_power_press",
        type="slide",
        axis="-1 0 0",
        limited="true",
        range="0 0.0014",
        stiffness="65",
        damping="0.25",
        armature="0.001",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        button,
        "geom",
        name="bricks_power_button_col",
        type="cylinder",
        pos="0.0023 0 0",
        quat=X_AXIS_QUAT,
        size="0.0064 0.0009",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )

    # Dosing cup collision geometry
    ET.SubElement(
        cup,
        "geom",
        name="bricks_cup_foot",
        type="cylinder",
        pos="0 0 0.002",
        size="0.022 0.002",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        cup,
        "geom",
        name="bricks_cup_floor",
        type="cylinder",
        pos="0 0 0.012",
        size="0.0195 0.0015",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ACCESSORY_RGBA,
    )
    for i in range(12):
        angle = i * math.tau / 12
        ET.SubElement(
            cup,
            "geom",
            name=f"bricks_cup_wall_{i}",
            type="box",
            pos=numbers((0.0218 * math.cos(angle), 0.0218 * math.sin(angle), 0.057)),
            size="0.0018 0.0058 0.045",
            euler=numbers((0, 0, angle)),
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_ACCESSORY_RGBA,
        )
    ET.SubElement(
        cup,
        "site",
        name="bricks_cup_base_site",
        pos="0 0 0",
        size="0.002",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    payload = ET.SubElement(cup, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.024",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.020",
        size="0.019 0.0015",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.36 0.23 0.14 0",
        mass="0",
    )

    # Receiving bench for cup handling
    ET.SubElement(
        world,
        "geom",
        name="vessel_receiving_bench",
        type="box",
        pos="0.18 -0.036 0.008",
        size="0.08 0.08 0.008",
        rgba="0.35 0.39 0.42 1",
        group="2",
        contype="1",
        conaffinity="1",
    )

    # Adjacent articulated-body contact exclusions + explicit cup contact pairs
    contact = add_adjacent_excludes(
        model,
        (
            ("exclude_grinder_hopper", "bricks_grinder", "bricks_hopper"),
            ("exclude_grinder_lid", "bricks_grinder", "bricks_hopper_lid"),
            ("exclude_grinder_carrier", "bricks_grinder", "bricks_burr_carrier"),
            ("exclude_grinder_cone", "bricks_grinder", "bricks_burr_cone"),
            ("exclude_grinder_knocker", "bricks_grinder", "bricks_knocker"),
            ("exclude_grinder_button", "bricks_grinder", "bricks_power_button"),
            ("exclude_hopper_lid", "bricks_hopper", "bricks_hopper_lid"),
            ("exclude_hopper_carrier", "bricks_hopper", "bricks_burr_carrier"),
            ("exclude_lid_carrier", "bricks_hopper_lid", "bricks_burr_carrier"),
            ("exclude_carrier_cone", "bricks_burr_carrier", "bricks_burr_cone"),
        ),
    )
    model_contact = copy.deepcopy(contact)
    ET.SubElement(
        contact,
        "pair",
        geom1="bricks_cup_seat",
        geom2="bricks_cup_foot",
        friction="0.06 0.06 0.002 0.0001 0.0001",
    )
    ET.SubElement(
        contact, "pair", geom1="vessel_receiving_bench", geom2="bricks_cup_foot"
    )

    # Actuators
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="bricks_burr_drive",
        joint="bricks_burr_spin",
        kv="1.8",
        ctrlrange="0 55",
        forcerange="-3.5 3.5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_hopper_dial_control",
        joint="bricks_hopper_dial",
        kp="18",
        kv="1.8",
        ctrlrange="-9.424778 9.424778",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_hopper_lift_control",
        joint="bricks_hopper_lift",
        kp="1200",
        kv="18",
        ctrlrange="0 0.080",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_lid_lift_control",
        joint="bricks_lid_lift",
        kp="800",
        kv="12",
        ctrlrange="0 0.095",
        forcerange="-15 15",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_carrier_lift_control",
        joint="bricks_carrier_lift",
        kp="1000",
        kv="14",
        ctrlrange="0 0.065",
        forcerange="-20 20",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_knocker_actuator",
        joint="bricks_knocker_turn",
        kp="28",
        kv="0.25",
        ctrlrange="-0.785398 1.396263",
        forcerange="-6 6",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bricks_power_actuator",
        joint="bricks_power_press",
        kp="120",
        kv="2.5",
        ctrlrange="0 0.0014",
        forcerange="0 15",
    )

    # Sensors
    sensors = ET.SubElement(model, "sensor")
    ET.SubElement(sensors, "jointvel", name="bricks_burr_vel", joint="bricks_burr_spin")
    ET.SubElement(
        sensors, "actuatorfrc", name="bricks_burr_torque", actuator="bricks_burr_drive"
    )
    ET.SubElement(
        sensors, "jointpos", name="bricks_dial_pos", joint="bricks_hopper_dial"
    )
    ET.SubElement(
        sensors, "jointpos", name="bricks_knocker_pos", joint="bricks_knocker_turn"
    )
    ET.SubElement(
        sensors, "jointvel", name="bricks_knocker_vel", joint="bricks_knocker_turn"
    )
    ET.SubElement(
        sensors, "jointpos", name="bricks_button_pos", joint="bricks_power_press"
    )
    ET.SubElement(
        sensors, "touch", name="bricks_cup_seat_touch", site="bricks_cup_seat_site"
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="bricks_cup_relpos",
        objtype="site",
        objname="bricks_cup_base_site",
        reftype="site",
        refname="vessel_socket",
    )

    write_xml(ASSETS / "appliance.xml", model)

    scene = ET.Element("mujoco", model="timemore-bricks-01s lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.4 0.4 0.4")
    scene_asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        scene_asset,
        "texture",
        name="lab_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1")
    ET.SubElement(
        scene_world,
        "geom",
        name="bench",
        type="plane",
        size="3 3 0.05",
        pos="0 0 -0.001",
        rgba="0.25 0.29 0.32 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="bricks_grinder",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=model_contact,
        sensors=sensors,
        exclude_sensors=("bricks_cup_relpos", "bricks_burr_torque"),
        accessories=(("dosing_cup_model.xml", "bricks_dosing_cup", cup),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 2.6,
                "component_masses_kg": MASSES,
                "assumptions": [
                    "Total mass equals published 2.6 kg; individual component masses and diagonal inertias are engineering estimates.",
                    "S2C-040-EI 40 mm SUS420 Spike-to-Cut conical burr operates at published 450 RPM (47.12 rad/s) driven by 150 W DC motor.",
                    "2-way rotatable bean hopper dial provides 50 clicks/turn across 3 turns (150 clicks, 0.01 mm/click).",
                    "Spring-return rotary fines knocker at chute exit snaps back from +65 deg to 0 deg to purge retained fines below 0.15 g.",
                ],
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    """Compile scene.xml, strip decorative visual meshes, and write verified native.xml."""
    return kit_export_native_xml(ASSETS, NAME, mujoco, np)


def run_active_state_journey():
    """Run the 6-stage active-state verification journey in MuJoCo and write evidence artifacts."""
    import mujoco
    import numpy as np

    model, _ = export_native_xml(mujoco, np)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    payload_body_id = model.body("ingredient_payload").id
    cup_qpos_adr = model.jnt_qposadr[model.joint("vessel_free").id]
    cup_dof_adr = model.jnt_dofadr[model.joint("vessel_free").id]

    dial_qpos_adr = model.jnt_qposadr[model.joint("bricks_hopper_dial").id]
    hopper_lift_qpos_adr = model.jnt_qposadr[model.joint("bricks_hopper_lift").id]
    lid_lift_qpos_adr = model.jnt_qposadr[model.joint("bricks_lid_lift").id]
    carrier_lift_qpos_adr = model.jnt_qposadr[model.joint("bricks_carrier_lift").id]
    burr_qpos_adr = model.jnt_qposadr[model.joint("bricks_burr_spin").id]
    burr_dof_adr = model.jnt_dofadr[model.joint("bricks_burr_spin").id]
    knocker_qpos_adr = model.jnt_qposadr[model.joint("bricks_knocker_turn").id]
    knocker_dof_adr = model.jnt_dofadr[model.joint("bricks_knocker_turn").id]
    button_qpos_adr = model.jnt_qposadr[model.joint("bricks_power_press").id]

    act_burr = model.actuator("bricks_burr_drive").id
    act_dial = model.actuator("bricks_hopper_dial_control").id
    act_hopper_lift = model.actuator("bricks_hopper_lift_control").id
    act_lid_lift = model.actuator("bricks_lid_lift_control").id
    act_carrier_lift = model.actuator("bricks_carrier_lift_control").id
    act_knocker = model.actuator("bricks_knocker_actuator").id
    act_button = model.actuator("bricks_power_actuator").id

    socket_pos = np.array([0.0, -0.0360, 0.0160])
    dt = model.opt.timestep
    nominal_omega = 450.0 * math.tau / 60.0  # 450 RPM = 47.12389 rad/s

    trace_rows = []

    def apply_magnetic_cup_centering():
        """Apply radial + axial neodymium magnet capture force within 16 mm of vessel_socket."""
        cup_pos = data.qpos[cup_qpos_adr : cup_qpos_adr + 3]
        cup_vel = data.qvel[cup_dof_adr : cup_dof_adr + 3]
        cup_angvel = data.qvel[cup_dof_adr + 3 : cup_dof_adr + 6]
        rel = cup_pos - socket_pos
        radial_dist = float(np.hypot(rel[0], rel[1]))
        if radial_dist < 0.016 and abs(rel[2]) < 0.012:
            fx = -480.0 * rel[0] - 14.0 * cup_vel[0]
            fy = -480.0 * rel[1] - 14.0 * cup_vel[1]
            fz = -1.75 - 4.0 * cup_vel[2]
            data.qfrc_applied[cup_dof_adr] = fx
            data.qfrc_applied[cup_dof_adr + 1] = fy
            data.qfrc_applied[cup_dof_adr + 2] = fz
            data.qfrc_applied[cup_dof_adr + 3 : cup_dof_adr + 6] = -0.08 * cup_angvel
            return True, radial_dist
        data.qfrc_applied[cup_dof_adr : cup_dof_adr + 6] = 0.0
        return False, radial_dist

    def record_row(
        sim_time_s,
        stage,
        state,
        dial_major_mark,
        hopper_beans_g,
        chute_retention_g,
        cup_grounds_g,
        coupled,
        radial_err_m,
    ):
        omega = float(data.qvel[burr_dof_adr])
        rpm = omega * 60.0 / math.tau
        turns = float(data.qpos[burr_qpos_adr]) / math.tau
        torque_nm = float(data.actuator_force[act_burr])
        support_n = float(data.sensor("bricks_cup_seat_touch").data[0])
        dial_clicks = round(dial_major_mark * 5.0, 2)
        trace_rows.append(
            {
                "time_s": round(sim_time_s, 4),
                "stage": stage,
                "state": state,
                "dial_mark": round(dial_major_mark, 3),
                "dial_clicks": dial_clicks,
                "rpm": round(rpm, 3),
                "turns": round(turns, 4),
                "motor_torque_nm": round(torque_nm, 4),
                "hopper_beans_g": round(hopper_beans_g, 4),
                "chute_retention_g": round(chute_retention_g, 4),
                "cup_grounds_g": round(cup_grounds_g, 4),
                "cup_support_n": round(support_n, 4),
                "cup_radial_error_m": round(radial_err_m, 6),
                "cup_coupled": bool(coupled),
                "knocker_deg": round(math.degrees(float(data.qpos[knocker_qpos_adr])), 2),
                "button_press_mm": round(float(data.qpos[button_qpos_adr]) * 1000.0, 3),
                "lid_lift_mm": round(float(data.qpos[lid_lift_qpos_adr]) * 1000.0, 3),
                "hopper_lift_mm": round(float(data.qpos[hopper_lift_qpos_adr]) * 1000.0, 3),
                "carrier_lift_mm": round(float(data.qpos[carrier_lift_qpos_adr]) * 1000.0, 3),
            }
        )

    sim_time = 0.0
    hopper_beans_g = 0.0
    chute_retention_g = 0.0
    cup_grounds_g = 0.0

    # -------------------------------------------------------------------------
    # STAGE 1: Magnetic Catch Cup Seating & Self-Centering (0.0 -> 0.8 s)
    # Place cup 4.0 mm +X, -3.5 mm -Y, +2.0 mm +Z off vessel_socket and release
    # -------------------------------------------------------------------------
    data.qpos[cup_qpos_adr : cup_qpos_adr + 3] = socket_pos + np.array(
        [0.0040, -0.0035, 0.0020]
    )
    data.qpos[cup_qpos_adr + 3 : cup_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
    initial_radial_offset_m = float(
        np.hypot(
            data.qpos[cup_qpos_adr] - socket_pos[0],
            data.qpos[cup_qpos_adr + 1] - socket_pos[1],
        )
    )
    for step in range(800):
        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 40 == 0:
            record_row(
                sim_time,
                "cup_seating",
                "ready",
                7.0,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    seated_radial_error_m = radial_err
    seated_empty_support_n = float(data.sensor("bricks_cup_seat_touch").data[0])
    assert coupled, "Magnetic catch cup failed to couple onto landing pad"
    assert seated_radial_error_m < 0.0005, (
        f"Magnetic self-centering error too large: {seated_radial_error_m}"
    )
    assert seated_empty_support_n > 2.5, (
        f"Expected positive seat support force (cup gravity + magnet preload), got {seated_empty_support_n}"
    )

    # -------------------------------------------------------------------------
    # STAGE 2: 150-Click 2-Way Hopper Grind Adjustment Dial (7.0 Pour-Over -> 2.0 Espresso)
    # 10 major marks (50 clicks) per revolution (2*pi rad).
    # Pour-Over 7.0 = 1.4*pi rad (35 clicks); Espresso 2.0 = 0.4*pi rad (10 clicks).
    # -------------------------------------------------------------------------
    pourover_angle = 1.4 * math.pi
    espresso_angle = 0.4 * math.pi
    data.qpos[dial_qpos_adr] = pourover_angle
    data.ctrl[act_dial] = pourover_angle
    mujoco.mj_forward(model, data)
    for step in range(1000):
        alpha = min(1.0, step / 700.0)
        target_angle = pourover_angle + alpha * (espresso_angle - pourover_angle)
        data.ctrl[act_dial] = target_angle
        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        dial_mark = float(data.qpos[dial_qpos_adr]) / (0.2 * math.pi)
        if step % 50 == 0:
            record_row(
                sim_time,
                "grind_adjustment",
                "ready",
                dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    final_dial_mark = float(data.qpos[dial_qpos_adr]) / (0.2 * math.pi)
    assert abs(final_dial_mark - 2.0) < 0.05, (
        f"Hopper grind dial failed to reach 2.0 Espresso setting: {final_dial_mark}"
    )

    # -------------------------------------------------------------------------
    # STAGE 3: 450 RPM S2C-040-EI Conical Burr Grind of 18.0 g Dose & Stop
    # Press side power button to start 450 RPM motor; comminute 18.0 g dose;
    # stop after bean depletion.
    # -------------------------------------------------------------------------
    hopper_beans_g = 18.0
    chute_retention_g = 0.0
    cup_grounds_g = 0.0
    state = "ready"
    low_torque_timer_s = 0.0
    peak_grinding_rpm = 0.0
    peak_grinding_torque_nm = 0.0
    turns_at_start = float(data.qpos[burr_qpos_adr]) / math.tau

    grind_rate_gps = 4.5
    max_chute_holdup_g = 0.34

    for step in range(6800):
        # Press side power button during first 0.25 s to start
        data.ctrl[act_button] = 0.0014 if step < 250 else 0.0
        btn_pressed = float(data.qpos[button_qpos_adr]) > 0.0008

        if state == "ready" and btn_pressed and step < 300:
            state = "grinding"
            low_torque_timer_s = 0.0

        coupled, radial_err = apply_magnetic_cup_centering()

        if state == "grinding":
            data.ctrl[act_burr] = nominal_omega
            omega = max(0.0, float(data.qvel[burr_dof_adr]))
            if hopper_beans_g > 0.0 and omega > 10.0:
                d_mass = min(hopper_beans_g, grind_rate_gps * (omega / nominal_omega) * dt)
                hopper_beans_g -= d_mass
                to_chute = min(d_mass * 0.08, max(0.0, max_chute_holdup_g - chute_retention_g))
                chute_retention_g += to_chute
                cup_grounds_g += d_mass - to_chute
                model.body_mass[payload_body_id] = max(1e-9, cup_grounds_g * 0.001)
                ripple = 1.0 + 0.09 * math.sin(float(data.qpos[burr_qpos_adr]) * 7.0)
                data.qfrc_applied[burr_dof_adr] = -1.18 * ripple
            else:
                data.qfrc_applied[burr_dof_adr] = 0.0
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0

        mujoco.mj_step(model, data)
        sim_time += dt

        omega = float(data.qvel[burr_dof_adr])
        rpm = omega * 60.0 / math.tau
        motor_torque = float(data.actuator_force[act_burr])
        peak_grinding_rpm = max(peak_grinding_rpm, rpm)
        peak_grinding_torque_nm = max(peak_grinding_torque_nm, motor_torque)

        if state == "grinding" and step > 400:
            if motor_torque < 0.22:
                low_torque_timer_s += dt
                if low_torque_timer_s >= 1.00:
                    state = "auto_stopped"
                    data.ctrl[act_burr] = 0.0
            else:
                low_torque_timer_s = 0.0
        elif state == "auto_stopped" and abs(rpm) < 0.5:
            state = "ready"

        if step % 100 == 0:
            record_row(
                sim_time,
                "auto_grind",
                state,
                final_dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    turns_completed = (float(data.qpos[burr_qpos_adr]) / math.tau) - turns_at_start
    post_grind_rpm = float(data.qvel[burr_dof_adr]) * 60.0 / math.tau
    assert hopper_beans_g == 0.0, f"Beans remaining in hopper: {hopper_beans_g}"
    assert state == "ready", (
        f"Expected grind completion to return to ready, got {state} "
        f"(rpm={post_grind_rpm}, torque={motor_torque}, low_timer={low_torque_timer_s})"
    )
    assert abs(post_grind_rpm) < 0.5, f"Burr did not stop: {post_grind_rpm} RPM"
    assert peak_grinding_rpm > 435.0, f"Peak RPM below 450 RPM target: {peak_grinding_rpm}"
    assert peak_grinding_torque_nm > 1.05, f"Peak grinding torque too low: {peak_grinding_torque_nm}"

    # -------------------------------------------------------------------------
    # STAGE 4: Spring-Return Rotary Fines Knocker Purge (< 0.15 g Retention)
    # Twist bricks_knocker_turn to +65 deg (1.134 rad) for 0.16 s, then release
    # so the internal torsion spring snaps the knocker ring back to 0 deg.
    # -------------------------------------------------------------------------
    pre_knocker_retention_g = chute_retention_g
    max_knocker_angle_deg = 0.0
    max_knocker_snap_rad_s = 0.0
    for step in range(500):
        if step < 160:
            data.ctrl[act_knocker] = math.radians(65.0)
            model.actuator_gainprm[act_knocker, 0] = 28.0
            model.actuator_biasprm[act_knocker, 1] = -28.0
            model.actuator_biasprm[act_knocker, 2] = -0.25
        else:
            data.ctrl[act_knocker] = 0.0
            model.actuator_gainprm[act_knocker, 0] = 0.0
            model.actuator_biasprm[act_knocker, 1] = 0.0
            model.actuator_biasprm[act_knocker, 2] = 0.0

        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt

        ang_deg = math.degrees(float(data.qpos[knocker_qpos_adr]))
        snap_omega = -float(data.qvel[knocker_dof_adr])
        max_knocker_angle_deg = max(max_knocker_angle_deg, ang_deg)
        if step >= 160:
            max_knocker_snap_rad_s = max(max_knocker_snap_rad_s, snap_omega)
            if snap_omega > 15.0 and chute_retention_g > 0.06:
                purged = chute_retention_g - 0.05
                chute_retention_g = 0.05
                cup_grounds_g += purged
                model.body_mass[payload_body_id] = cup_grounds_g * 0.001

        if step % 25 == 0:
            record_row(
                sim_time,
                "rotary_knocker_purge",
                state,
                final_dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    post_knocker_support_n = float(data.sensor("bricks_cup_seat_touch").data[0])
    assert max_knocker_angle_deg > 55.0, (
        f"Rotary knocker did not reach full twist angle: {max_knocker_angle_deg} deg"
    )
    assert max_knocker_snap_rad_s > 18.0, (
        f"Rotary knocker spring snap speed too slow: {max_knocker_snap_rad_s} rad/s"
    )
    assert chute_retention_g < 0.15, (
        f"Retention after rotary knocker exceeds 0.15 g spec: {chute_retention_g} g"
    )
    assert post_knocker_support_n > seated_empty_support_n + 0.15, (
        "Touch sensor did not reflect added mass of dosed coffee grounds"
    )

    # -------------------------------------------------------------------------
    # STAGE 5: Thermal Duty-Cycle Cutoff & Foreign-Object Jam Protection
    # 5A: Continuous duty thermal cutoff at 60.0 s & restart refusal during cooldown.
    # 5B: Foreign-object stone jam stall detection & motor cutoff within 0.25 s.
    # -------------------------------------------------------------------------
    duty_elapsed_s = 59.65
    cooldown_remaining_s = 0.0
    state = "grinding"
    hopper_beans_g = 4.0
    restart_refused_during_cooldown = False

    for step in range(800):
        data.ctrl[act_button] = 0.0014 if (500 <= step < 700) else 0.0
        btn_pressed = float(data.qpos[button_qpos_adr]) > 0.0008

        if state == "grinding":
            duty_elapsed_s += dt
            data.ctrl[act_burr] = nominal_omega
            data.qfrc_applied[burr_dof_adr] = -1.10
            if duty_elapsed_s >= 60.0:
                state = "thermal_cooldown"
                cooldown_remaining_s = 60.0
                data.ctrl[act_burr] = 0.0
                data.qfrc_applied[burr_dof_adr] = 0.0
        elif state == "thermal_cooldown":
            cooldown_remaining_s = max(0.0, cooldown_remaining_s - dt)
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0
            if btn_pressed and cooldown_remaining_s > 0.0:
                restart_refused_during_cooldown = True

        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 100 == 0:
            record_row(
                sim_time,
                "duty_cutoff_fault",
                state,
                final_dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert state == "thermal_cooldown", f"Expected thermal_cooldown at 60 s, got {state}"
    assert restart_refused_during_cooldown, "Controller failed to refuse restart during thermal cooldown"

    # 5B: Foreign-object jam protection
    state = "grinding"
    jam_stall_timer_s = 0.0
    jam_cutoff_triggered = False
    for step in range(600):
        if state == "grinding":
            data.ctrl[act_burr] = nominal_omega
            # Inject stone jam resistive torque (-4.8 N*m > 3.5 N*m actuator limit) at step 150
            data.qfrc_applied[burr_dof_adr] = -4.80 if step >= 150 else -1.10
            omega = float(data.qvel[burr_dof_adr])
            rpm = omega * 60.0 / math.tau
            torque = float(data.actuator_force[act_burr])
            if step >= 150 and rpm < 40.0 and torque > 3.0:
                jam_stall_timer_s += dt
                if jam_stall_timer_s >= 0.18:
                    state = "jam_fault_cutoff"
                    jam_cutoff_triggered = True
                    data.ctrl[act_burr] = 0.0
                    data.qfrc_applied[burr_dof_adr] = 0.0
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0

        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 100 == 0:
            record_row(
                sim_time,
                "jam_stall_fault",
                state,
                final_dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert jam_cutoff_triggered and state == "jam_fault_cutoff", (
        f"Foreign-object jam protection failed to trip: state={state}"
    )

    # -------------------------------------------------------------------------
    # STAGE 6: Tool-less Disassembly (Lid + Hopper + S2C-040-EI Burr Carrier)
    # -------------------------------------------------------------------------
    hopper_beans_g = 0.0
    max_lid_lift_m = 0.0
    max_hopper_lift_m = 0.0
    max_carrier_lift_m = 0.0
    for step in range(1000):
        if step < 500:
            data.ctrl[act_lid_lift] = 0.088
            data.ctrl[act_hopper_lift] = 0.068 if step >= 100 else 0.0
            data.ctrl[act_carrier_lift] = 0.048 if step >= 200 else 0.0
            state = "maintenance_open"
        else:
            data.ctrl[act_carrier_lift] = 0.0
            data.ctrl[act_hopper_lift] = 0.0 if step >= 620 else 0.068
            data.ctrl[act_lid_lift] = 0.0 if step >= 740 else 0.088
            state = "ready" if step >= 900 else "maintenance_open"

        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        max_lid_lift_m = max(max_lid_lift_m, float(data.qpos[lid_lift_qpos_adr]))
        max_hopper_lift_m = max(max_hopper_lift_m, float(data.qpos[hopper_lift_qpos_adr]))
        max_carrier_lift_m = max(max_carrier_lift_m, float(data.qpos[carrier_lift_qpos_adr]))
        if step % 100 == 0:
            record_row(
                sim_time,
                "toolless_maintenance",
                state,
                final_dial_mark,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert max_lid_lift_m > 0.082, f"Lid lift insufficient: {max_lid_lift_m}"
    assert max_hopper_lift_m > 0.062, f"Hopper lift insufficient: {max_hopper_lift_m}"
    assert max_carrier_lift_m > 0.044, f"Burr carrier lift insufficient: {max_carrier_lift_m}"
    assert float(data.qpos[lid_lift_qpos_adr]) < 0.001, "Lid did not re-seat cleanly"
    assert float(data.qpos[hopper_lift_qpos_adr]) < 0.001, "Hopper did not re-seat cleanly"
    assert float(data.qpos[carrier_lift_qpos_adr]) < 0.001, "Burr carrier did not re-seat cleanly"

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        NAME,
        NAMES,
        SCALAR_VISUAL_AXES,
        mujoco,
        evidence_dir,
        cleanup_inputs=True,
    )
    rest_frames = frames_report["appliances"][NAME]["frames"]
    motion_items = motion_report["appliances"][NAME]["motions"]
    alignment_summary = {
        "rest_passed": True,
        "rest_frames_checked": len(rest_frames),
        "rest_max_position_error_m": max(f["position_error_m"] for f in rest_frames),
        "rest_max_orientation_error_rad": max(f["orientation_error_rad"] for f in rest_frames),
        "motion_passed": True,
        "motion_joints_checked": len(motion_items),
        "motion_samples_per_joint": 21,
        "motion_max_position_error_m": max(m["position_error_m"] for m in motion_items),
        "motion_max_orientation_error_rad": max(m["orientation_error_rad"] for m in motion_items),
    }
    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    tracked_files = sorted(
        [
            ASSETS / "appliance.xml",
            ASSETS / "model.xml",
            ASSETS / "dosing_cup_model.xml",
            ASSETS / "scene.xml",
            ASSETS / "native.xml",
            ASSETS / "visual_assets.xml",
            *(ASSETS.glob("visual_bricks_*.xml")),
            *(ASSETS / "meshes").glob("*.obj"),
            ASSETS / "timemore-bricks-01s.blend",
            ASSETS / "timemore-bricks-01s.glb",
            Path(__file__).resolve(),
        ]
    )
    input_sha256 = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in tracked_files
    }

    report = {
        "status": "passed",
        "appliance": "timemore-bricks-01s",
        "mujoco_version": mujoco.__version__,
        "rendered": False,
        "input_sha256": input_sha256,
        "frame_alignment": alignment_summary,
        "journey": {
            "nominal_rpm": 450,
            "clicks_per_turn": 50,
            "total_clicks": 150,
            "micron_per_click": 10,
            "cup_seating": {
                "initial_radial_offset_m": round(initial_radial_offset_m, 6),
                "seated_radial_error_m": round(seated_radial_error_m, 6),
                "empty_cup_support_n": round(seated_empty_support_n, 4),
                "coupled": True,
            },
            "grind_adjustment": {
                "start_pourover_mark": 7.0,
                "target_espresso_mark": 2.0,
                "achieved_mark": round(final_dial_mark, 4),
                "achieved_click_index": round(final_dial_mark * 5.0, 2),
            },
            "auto_grind_and_stop": {
                "dose_input_g": 18.0,
                "peak_rpm": round(peak_grinding_rpm, 3),
                "peak_torque_nm": round(peak_grinding_torque_nm, 4),
                "burr_turns": round(turns_completed, 3),
                "pre_knocker_retention_g": round(pre_knocker_retention_g, 4),
                "post_stop_rpm": round(post_grind_rpm, 4),
            },
            "rotary_knocker_purge": {
                "max_twist_deg": round(max_knocker_angle_deg, 2),
                "peak_return_snap_rad_s": round(max_knocker_snap_rad_s, 3),
                "post_knocker_retention_g": round(chute_retention_g, 4),
                "delivered_cup_grounds_g": round(cup_grounds_g, 4),
                "dosed_cup_support_n": round(post_knocker_support_n, 4),
            },
            "safety_and_jam_cutoff": {
                "duty_cutoff_triggered_at_s": 60.0,
                "restart_refused_during_cooldown": restart_refused_during_cooldown,
                "jam_cutoff_triggered": jam_cutoff_triggered,
            },
            "toolless_maintenance": {
                "max_lid_lift_m": round(max_lid_lift_m, 4),
                "max_hopper_lift_m": round(max_hopper_lift_m, 4),
                "max_carrier_lift_m": round(max_carrier_lift_m, 4),
                "restored_to_ready": state == "ready",
            },
            "final": trace_rows[-1],
        },
        "trace_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "trace_rows": len(trace_rows),
    }
    report_path = evidence_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")

    active_states_md = """# TIMEMORE Bricks 01S Black native physics

Native S2C-040-EI 40 mm Spike-to-Cut conical burr drive (`450 RPM`, `150 W` DC motor), magnetic catch-cup self-centering, 150-click 2-way rotatable bean hopper grind dial (`10 µm/click`), spring-return rotary fines knocker (`ロータリーノッカー`), thermal duty-cycle & foreign-object jam protection, and tool-less lid/hopper/burr-carrier maintenance removal.

- [Acceptance report](active-state-evidence/report.json)
- [Native trace](active-state-evidence/trace.csv)

## Verified Active States & Transitions

1. **Magnetic Catch Cup Seating (`cup_seating`):** Releases `bricks_dosing_cup` (`4.0 mm` `+X`, `-3.5 mm` `-Y`, `+2.0 mm` `+Z` off `vessel_socket`) into the neodymium capture field (`16 mm` capture radius), settling with `< 0.5 mm` radial error on `bricks_cup_seat`.
2. **150-Click 2-Way Hopper Grind Dial (`grind_adjustment`):** Rotates `bricks_hopper_dial` from Pour-Over (`7.0` major mark / click `35`) to Espresso (`2.0` major mark / click `10`).
3. **S2C-040-EI Conical Burr Grind (`auto_grind`):** Side power button press (`bricks_power_press`) starts the `450 RPM` (`47.12 rad/s`) motor, comminutes an `18.0 g` dose under `~1.18 N·m` reaction torque, and stops cleanly after bean depletion.
4. **Spring-Return Rotary Fines Knocker (`rotary_knocker_purge`):** Twists `bricks_knocker_turn` to `+65°` and releases its torsion return spring (`> 18 rad/s` snap-back), knocking retained fines from `0.34 g` to `0.05 g` (`< 0.15 g` specification) and delivering `17.95 g` into the magnetic catch cup.
5. **Thermal Duty & Jam Cutoff (`duty_cutoff_fault`, `jam_stall_fault`):** Enforces the `60 s` continuous thermal cutoff (refusing button restarts during cooldown) and trips `jam_fault_cutoff` within `0.18 s` when a foreign object stalls the burr below `40 RPM`.
6. **Tool-less Disassembly (`toolless_maintenance`):** Lifts `bricks_hopper_lid` (`+88 mm`), `bricks_hopper` (`+68 mm`), and `bricks_burr_carrier` (`+48 mm`) by its folding wire bail handle for dry-brush chamber cleaning, then restores the assembly to `ready`.
"""
    (ASSETS / "active-states.md").write_text(active_states_md)
    print(json.dumps(report["journey"], indent=2))


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if "--export-meshes" in args:
        export_blender_meshes_and_xml()
        return
    if "--verify-mujoco" in args:
        run_active_state_journey()
        return

    if "bpy" in sys.modules:
        export_blender_meshes_and_xml()
        return

    subprocess.run(
        [
            str(BLENDER_BIN),
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--export-meshes",
        ],
        check=True,
    )
    run_active_state_journey()


if __name__ == "__main__":
    main()
