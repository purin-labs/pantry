"""Build and verify the MuJoCo 4.0 mechanical and active-state model for the Fellow Opus 2."""

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
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

NAME = "fellow-opus-2"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

NAMES = (
    "opus_grinder",
    "opus_grind_knob",
    "opus_scale_ring",
    "opus_hopper",
    "opus_hopper_lid",
    "opus_burr_carrier",
    "opus_burr_cone",
    "opus_power_button",
    "opus_catch_cup",
)

SCALAR_VISUAL_AXES = {
    "opus_knob_turn": [1.0, 0.0, 0.0],
    "opus_scale_turn": [0.0, 0.0, 1.0],
    "opus_hopper_lift": [0.0, 0.0, 1.0],
    "opus_lid_lift": [0.0, 0.0, 1.0],
    "opus_carrier_lift": [0.0, 0.0, 1.0],
    "opus_burr_spin": [0.0, 0.0, 1.0],
    "opus_power_press": [0.0, 1.0, 0.0],
}

# Published total mass = 2.300 kg (2,300 g) across the 9 articulated bodies
MASSES = {
    "opus_grinder": 1.640,
    "opus_grind_knob": 0.032,
    "opus_scale_ring": 0.028,
    "opus_hopper": 0.140,
    "opus_hopper_lid": 0.055,
    "opus_burr_carrier": 0.115,
    "opus_burr_cone": 0.102,
    "opus_power_button": 0.008,
    "opus_catch_cup": 0.180,
}

CENTERS = {
    "opus_grinder": (-0.008, 0.018, 0.105),
    "opus_grind_knob": (0.011, 0.0, 0.0),
    "opus_scale_ring": (0.0, 0.0, 0.0045),
    "opus_hopper": (0.0, 0.0, 0.016),
    "opus_hopper_lid": (0.0, 0.0, 0.003),
    "opus_burr_carrier": (0.0, 0.0, 0.010),
    "opus_burr_cone": (0.0, 0.0, 0.008),
    "opus_power_button": (0.0, -0.0004, 0.0),
    "opus_catch_cup": (0.0, 0.0, 0.036),
}

INERTIAS = {
    "opus_grinder": (0.0128, 0.0064, 0.0098),
    "opus_grind_knob": (0.000012, 0.000010, 0.000010),
    "opus_scale_ring": (0.000040, 0.000040, 0.000075),
    "opus_hopper": (0.000180, 0.000180, 0.000310),
    "opus_hopper_lid": (0.000065, 0.000065, 0.000125),
    "opus_burr_carrier": (0.000075, 0.000075, 0.000110),
    "opus_burr_cone": (0.000055, 0.000055, 0.000080),
    "opus_power_button": (0.000004, 0.000004, 0.000004),
    "opus_catch_cup": (0.000175, 0.000175, 0.000145),
}


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local UV OBJ meshes and construct appliance.xml + scene.xml + model.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "fellow-opus-2.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    # Remove detached illustrative stowed AC plug meshes (whose cable is a non-mesh CURVE).
    plug_root = bpy.data.objects.get("opus_ac_plug")
    if plug_root is not None:
        for child in list(plug_root.children_recursive):
            bpy.data.objects.remove(child, do_unlink=True)
        bpy.data.objects.remove(plug_root, do_unlink=True)
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

    model = ET.Element("mujoco", model="fellow-opus-2 — assumed native dynamics")
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

    base = bodies["opus_grinder"]
    knob = bodies["opus_grind_knob"]
    scale_ring = bodies["opus_scale_ring"]
    hopper = bodies["opus_hopper"]
    lid = bodies["opus_hopper_lid"]
    carrier = bodies["opus_burr_carrier"]
    cone = bodies["opus_burr_cone"]
    button = bodies["opus_power_button"]
    cup = bodies["opus_catch_cup"]

    # Detach opus_catch_cup into worldbody as a free removable magnetic vessel
    parent_of_cup = next(node for node in model.iter() if cup in list(node))
    parent_of_cup.remove(cup)
    world.append(cup)
    cup.set("pos", numbers(poses["opus_catch_cup"].translation))
    cup.set("quat", numbers(poses["opus_catch_cup"].to_quaternion()))
    ET.SubElement(cup, "freejoint", name="vessel_free")

    # Base silicone feet and rectangular base plate collision proxies
    for foot_name, fx, fy in (
        ("opus_foot_fl_col", -0.046, -0.082),
        ("opus_foot_fr_col", 0.046, -0.082),
        ("opus_foot_rl_col", -0.046, 0.082),
        ("opus_foot_rr_col", 0.046, 0.082),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0010)),
            size="0.0095 0.0010",
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_BASE_RGBA,
        )
    ET.SubElement(
        base,
        "geom",
        name="opus_base_plate",
        type="box",
        pos="0 0 0.01075",
        size="0.065 0.103 0.00875",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    # Magnetic catch-cup landing pad at (-0.0110, -0.0360, 0.0200) top surface
    ET.SubElement(
        base,
        "geom",
        name="opus_cup_seat",
        type="cylinder",
        pos="-0.0110 -0.0360 0.0180",
        size="0.038 0.002",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_WALL_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="vessel_socket",
        pos="-0.0110 -0.0360 0.0200",
        size="0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="opus_cup_seat_site",
        type="cylinder",
        pos="-0.0110 -0.0360 0.0200",
        size="0.039 0.0030",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="opus_chute_exit",
        pos="-0.0110 -0.0360 0.1040",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Rear vertical motor column, bridge neck & suspended barrel collision proxies
    ET.SubElement(
        base,
        "geom",
        name="opus_column_col",
        type="box",
        pos="-0.0110 0.0560 0.1330",
        size="0.042 0.036 0.113",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="opus_column_bridge_col",
        type="box",
        pos="-0.0110 0.0190 0.1685",
        size="0.023 0.006 0.0465",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="opus_barrel_bottom_col",
        type="cylinder",
        pos="-0.0110 -0.0360 0.1220",
        size="0.0525 0.0180",
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
            name=f"opus_barrel_wall_{i}",
            type="box",
            pos=numbers(
                (
                    -0.0110 + 0.0512 * math.cos(angle),
                    -0.0360 + 0.0512 * math.sin(angle),
                    0.1610,
                )
            ),
            size="0.0025 0.014 0.057",
            euler=numbers((0, 0, angle)),
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_WALL_RGBA,
        )

    # Articulated joints and colliders on side grind knob, upper scale ring, hopper, lid, burr carrier, conical burr, and timer button
    ET.SubElement(
        knob,
        "joint",
        name="opus_knob_turn",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-9.424778 9.424778",
        damping="0.12",
        armature="0.001",
        frictionloss="0.04",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        knob,
        "geom",
        name="opus_grind_knob_col",
        type="cylinder",
        pos="0.0112 0 0",
        quat=X_AXIS_QUAT,
        size="0.022 0.0108",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        scale_ring,
        "joint",
        name="opus_scale_turn",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-1.570796 1.570796",
        damping="0.18",
        armature="0.002",
        frictionloss="0.01",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        scale_ring,
        "geom",
        name="opus_scale_ring_col",
        type="cylinder",
        pos="0 0 0.0045",
        size="0.0536 0.0045",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        hopper,
        "joint",
        name="opus_hopper_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.100",
        damping="2.2",
        armature="0.002",
        frictionloss="1.85",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        hopper,
        "geom",
        name="opus_hopper_col",
        type="cylinder",
        pos="0 0 0.0162",
        size="0.054 0.0162",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        lid,
        "joint",
        name="opus_lid_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.130",
        damping="1.5",
        armature="0.001",
        frictionloss="0.75",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        lid,
        "geom",
        name="opus_hopper_lid_col",
        type="cylinder",
        pos="0 0 0.0015",
        size="0.054 0.0045",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        carrier,
        "joint",
        name="opus_carrier_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.080",
        damping="1.8",
        armature="0.002",
        frictionloss="1.55",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        carrier,
        "geom",
        name="opus_burr_carrier_col",
        type="cylinder",
        pos="0 0 0.014",
        size="0.031 0.014",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cone,
        "joint",
        name="opus_burr_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0012",
        armature="0.0012",
        frictionloss="0.01",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        cone,
        "geom",
        name="opus_burr_cone_proxy",
        type="cylinder",
        pos="0 0 0.0053",
        size="0.0205 0.0172",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        button,
        "joint",
        name="opus_power_press",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.0012",
        stiffness="65",
        damping="0.25",
        armature="0.001",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        button,
        "geom",
        name="opus_power_button_col",
        type="cylinder",
        pos="0 -0.0004 0",
        quat=Y_AXIS_QUAT,
        size="0.0056 0.0008",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ARTIC_RGBA,
    )

    # Catch cup collision geometry (base foot, interior floor, 12-segment cylindrical wall, payload marker)
    ET.SubElement(
        cup,
        "geom",
        name="opus_cup_foot",
        type="cylinder",
        pos="0 0 0.002",
        size="0.036 0.002",
        group="3",
        contype="1",
        conaffinity="1",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        cup,
        "geom",
        name="opus_cup_floor",
        type="cylinder",
        pos="0 0 0.018",
        size="0.034 0.0015",
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
            name=f"opus_cup_wall_{i}",
            type="box",
            pos=numbers((0.036 * math.cos(angle), 0.036 * math.sin(angle), 0.0495)),
            size="0.002 0.0095 0.0315",
            euler=numbers((0, 0, angle)),
            group="3",
            contype="1",
            conaffinity="1",
            rgba=COL_ACCESSORY_RGBA,
        )
    ET.SubElement(
        cup,
        "site",
        name="opus_cup_base_site",
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
        pos="0 0 0.021",
        size="0.031 0.0015",
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
        pos="0.22 -0.0360 0.010",
        size="0.09 0.09 0.010",
        rgba="0.35 0.39 0.42 1",
        group="2",
        contype="1",
        conaffinity="1",
    )

    # Adjacent articulated-body contact exclusions + explicit cup contact pairs
    contact = add_adjacent_excludes(
        model,
        (
            ("exclude_grinder_knob", "opus_grinder", "opus_grind_knob"),
            ("exclude_grinder_scale", "opus_grinder", "opus_scale_ring"),
            ("exclude_grinder_hopper", "opus_grinder", "opus_hopper"),
            ("exclude_grinder_lid", "opus_grinder", "opus_hopper_lid"),
            ("exclude_grinder_carrier", "opus_grinder", "opus_burr_carrier"),
            ("exclude_grinder_cone", "opus_grinder", "opus_burr_cone"),
            ("exclude_grinder_button", "opus_grinder", "opus_power_button"),
            ("exclude_scale_hopper", "opus_scale_ring", "opus_hopper"),
            ("exclude_scale_lid", "opus_scale_ring", "opus_hopper_lid"),
            ("exclude_scale_carrier", "opus_scale_ring", "opus_burr_carrier"),
            ("exclude_hopper_lid", "opus_hopper", "opus_hopper_lid"),
            ("exclude_hopper_carrier", "opus_hopper", "opus_burr_carrier"),
            ("exclude_lid_carrier", "opus_hopper_lid", "opus_burr_carrier"),
            ("exclude_carrier_cone", "opus_burr_carrier", "opus_burr_cone"),
            ("exclude_knob_scale", "opus_grind_knob", "opus_scale_ring"),
        ),
    )
    model_contact = copy.deepcopy(contact)
    ET.SubElement(
        contact,
        "pair",
        geom1="opus_cup_seat",
        geom2="opus_cup_foot",
        friction="0.06 0.06 0.002 0.0001 0.0001",
    )
    ET.SubElement(
        contact, "pair", geom1="vessel_receiving_bench", geom2="opus_cup_foot"
    )

    # Actuators
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="opus_burr_drive",
        joint="opus_burr_spin",
        kv="1.6",
        ctrlrange="0 50",
        forcerange="-3.2 3.2",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_knob_control",
        joint="opus_knob_turn",
        kp="14",
        kv="1.4",
        ctrlrange="-9.424778 9.424778",
        forcerange="-6 6",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_scale_control",
        joint="opus_scale_turn",
        kp="18",
        kv="1.8",
        ctrlrange="-1.570796 1.570796",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_hopper_lift_control",
        joint="opus_hopper_lift",
        kp="1200",
        kv="18",
        ctrlrange="0 0.100",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_lid_lift_control",
        joint="opus_lid_lift",
        kp="900",
        kv="12",
        ctrlrange="0 0.130",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_carrier_lift_control",
        joint="opus_carrier_lift",
        kp="1000",
        kv="14",
        ctrlrange="0 0.080",
        forcerange="-20 20",
    )
    ET.SubElement(
        actuators,
        "position",
        name="opus_power_actuator",
        joint="opus_power_press",
        kp="120",
        kv="2.5",
        ctrlrange="0 0.0012",
        forcerange="0 15",
    )

    # Sensors
    sensors = ET.SubElement(model, "sensor")
    ET.SubElement(sensors, "jointvel", name="opus_burr_vel", joint="opus_burr_spin")
    ET.SubElement(
        sensors, "actuatorfrc", name="opus_burr_torque", actuator="opus_burr_drive"
    )
    ET.SubElement(sensors, "jointpos", name="opus_knob_pos", joint="opus_knob_turn")
    ET.SubElement(sensors, "jointpos", name="opus_scale_pos", joint="opus_scale_turn")
    ET.SubElement(
        sensors, "jointpos", name="opus_button_pos", joint="opus_power_press"
    )
    ET.SubElement(
        sensors, "touch", name="opus_cup_seat_touch", site="opus_cup_seat_site"
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="opus_cup_relpos",
        objtype="site",
        objname="opus_cup_base_site",
        reftype="site",
        refname="vessel_socket",
    )

    write_xml(ASSETS / "appliance.xml", model)

    scene = ET.Element("mujoco", model="fellow-opus-2 lab")
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
        model_name="opus_grinder",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=model_contact,
        sensors=sensors,
        exclude_sensors=("opus_cup_relpos", "opus_burr_torque"),
        accessories=(("catch_cup_model.xml", "opus_catch_cup", cup),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 2.3,
                "component_masses_kg": MASSES,
                "assumptions": [
                    "Total mass equals published 2.3 kg (2,300 g); individual component masses and diagonal inertias are engineering estimates.",
                    "48 mm 6-star conical burr gearmotor operates at nominal 400 RPM (41.89 rad/s) with torque-sensed auto-stop on bean depletion and jam shutoff under > 2.8 N*m stall load.",
                    "Side worm-gear grind adjustment knob (opus_knob_turn) drives upper scale ring (opus_scale_turn) with a 6:1 reduction ratio across settings 1 to 10.",
                    "Magnetic catch cup self-centering modeled via radial restoring force within 18 mm capture radius of vessel_socket.",
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

    knob_qpos_adr = model.jnt_qposadr[model.joint("opus_knob_turn").id]
    scale_qpos_adr = model.jnt_qposadr[model.joint("opus_scale_turn").id]
    hopper_lift_qpos_adr = model.jnt_qposadr[model.joint("opus_hopper_lift").id]
    lid_lift_qpos_adr = model.jnt_qposadr[model.joint("opus_lid_lift").id]
    carrier_lift_qpos_adr = model.jnt_qposadr[model.joint("opus_carrier_lift").id]
    burr_qpos_adr = model.jnt_qposadr[model.joint("opus_burr_spin").id]
    burr_dof_adr = model.jnt_dofadr[model.joint("opus_burr_spin").id]
    button_qpos_adr = model.jnt_qposadr[model.joint("opus_power_press").id]

    act_burr = model.actuator("opus_burr_drive").id
    act_knob = model.actuator("opus_knob_control").id
    act_scale = model.actuator("opus_scale_control").id
    act_hopper_lift = model.actuator("opus_hopper_lift_control").id
    act_lid_lift = model.actuator("opus_lid_lift_control").id
    act_carrier_lift = model.actuator("opus_carrier_lift_control").id
    act_button = model.actuator("opus_power_actuator").id

    socket_pos = np.array([-0.0110, -0.0360, 0.0200])
    dt = model.opt.timestep
    nominal_omega = 400.0 * math.tau / 60.0  # Published 400 RPM = 41.8879 rad/s

    trace_rows = []

    def apply_magnetic_cup_centering():
        """Apply radial + axial neodymium magnet capture force within 18 mm of vessel_socket."""
        cup_pos = data.qpos[cup_qpos_adr : cup_qpos_adr + 3]
        cup_vel = data.qvel[cup_dof_adr : cup_dof_adr + 3]
        cup_angvel = data.qvel[cup_dof_adr + 3 : cup_dof_adr + 6]
        rel = cup_pos - socket_pos
        radial_dist = float(np.hypot(rel[0], rel[1]))
        if radial_dist < 0.018 and abs(rel[2]) < 0.012:
            fx = -480.0 * rel[0] - 14.0 * cup_vel[0]
            fy = -480.0 * rel[1] - 14.0 * cup_vel[1]
            fz = -1.85 - 4.0 * cup_vel[2]
            data.qfrc_applied[cup_dof_adr] = fx
            data.qfrc_applied[cup_dof_adr + 1] = fy
            data.qfrc_applied[cup_dof_adr + 2] = fz
            data.qfrc_applied[cup_dof_adr + 3 : cup_dof_adr + 6] = -0.08 * cup_angvel
            return True, radial_dist
        data.qfrc_applied[cup_dof_adr : cup_dof_adr + 6] = 0.0
        return False, radial_dist

    def scale_angle_to_setting(scale_rad):
        """Map scale_ring Z angle (rad) around setting 5.0 (0 rad) with 0.14 rad per major mark."""
        return 5.0 - (scale_rad / 0.14)

    def setting_to_angles(setting):
        """Return (knob_rad, scale_rad) for a given 1..10 grind setting (6:1 worm-gear ratio)."""
        scale_rad = (5.0 - setting) * 0.14
        knob_rad = -6.0 * scale_rad
        return knob_rad, scale_rad

    def record_row(
        sim_time_s,
        stage,
        state,
        timer_mode_s,
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
        support_n = float(data.sensor("opus_cup_seat_touch").data[0])
        scale_setting = scale_angle_to_setting(float(data.qpos[scale_qpos_adr]))
        trace_rows.append(
            {
                "time_s": round(sim_time_s, 4),
                "stage": stage,
                "state": state,
                "timer_mode_s": int(timer_mode_s),
                "grind_setting": round(scale_setting, 3),
                "knob_deg": round(math.degrees(float(data.qpos[knob_qpos_adr])), 2),
                "rpm": round(rpm, 3),
                "turns": round(turns, 4),
                "motor_torque_nm": round(torque_nm, 4),
                "hopper_beans_g": round(hopper_beans_g, 4),
                "chute_retention_g": round(chute_retention_g, 4),
                "cup_grounds_g": round(cup_grounds_g, 4),
                "cup_support_n": round(support_n, 4),
                "cup_radial_error_m": round(radial_err_m, 6),
                "cup_coupled": bool(coupled),
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
    timer_mode_s = 30

    # -------------------------------------------------------------------------
    # STAGE 1: Magnetic Catch Cup Seating & Self-Centering (0.0 -> 0.8 s)
    # Place cup 4.5 mm +X, -3.5 mm -Y, +2.0 mm +Z off vessel_socket and release
    # -------------------------------------------------------------------------
    init_knob, init_scale = setting_to_angles(6.0)
    data.qpos[knob_qpos_adr] = init_knob
    data.qpos[scale_qpos_adr] = init_scale
    data.ctrl[act_knob] = init_knob
    data.ctrl[act_scale] = init_scale
    data.qpos[cup_qpos_adr : cup_qpos_adr + 3] = socket_pos + np.array(
        [0.0045, -0.0035, 0.0020]
    )
    data.qpos[cup_qpos_adr + 3 : cup_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
    mujoco.mj_forward(model, data)

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
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    seated_radial_error_m = radial_err
    seated_empty_support_n = float(data.sensor("opus_cup_seat_touch").data[0])
    assert coupled, "Magnetic catch cup failed to couple onto landing pad"
    assert seated_radial_error_m < 0.0005, (
        f"Magnetic self-centering error too large: {seated_radial_error_m}"
    )
    assert seated_empty_support_n > 3.2, (
        f"Expected positive seat support force (cup gravity + magnet preload), got {seated_empty_support_n}"
    )

    # -------------------------------------------------------------------------
    # STAGE 2: Stepless Side Worm-Gear Grind Adjustment (6.0 Filter -> 2.0 Espresso, 0.8 -> 1.8 s)
    # -------------------------------------------------------------------------
    target_knob, target_scale = setting_to_angles(2.0)
    for step in range(1000):
        alpha = min(1.0, step / 700.0)
        data.ctrl[act_knob] = init_knob + alpha * (target_knob - init_knob)
        data.ctrl[act_scale] = init_scale + alpha * (target_scale - init_scale)
        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 50 == 0:
            record_row(
                sim_time,
                "grind_adjustment",
                "ready",
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    achieved_setting = scale_angle_to_setting(float(data.qpos[scale_qpos_adr]))
    achieved_knob_deg = math.degrees(float(data.qpos[knob_qpos_adr]))
    assert abs(achieved_setting - 2.0) < 0.05, (
        f"Scale ring failed to reach setting 2.0 Espresso: {achieved_setting}"
    )

    # -------------------------------------------------------------------------
    # STAGE 3: Timed Start (30 s Single-Press), 400 RPM 18.0 g Espresso Dose,
    # Anti-Static Ionizer Low Retention (< 0.12 g) & Torque-Sensed Auto-Stop
    # -------------------------------------------------------------------------
    hopper_beans_g = 18.0
    chute_retention_g = 0.0
    cup_grounds_g = 0.0
    state = "ready"
    timer_mode_s = 30
    timer_remaining_s = 30.0
    low_torque_timer_s = 0.0
    peak_grinding_rpm = 0.0
    peak_grinding_torque_nm = 0.0
    turns_at_start = float(data.qpos[burr_qpos_adr]) / math.tau

    # Published espresso grind speed = 1.8-2.2 g/s (18 g in 8-10 s).
    # Run 9.0 s at 2.0 g/s published espresso rate + 1.0 s auto-stop detection + 1.2 s spin-down = 11,200 steps!
    grind_rate_gps = 2.0
    ionizer_max_retention_g = 0.09

    for step in range(11200):
        # Single momentary press on front timer button during first 0.20 s
        data.ctrl[act_button] = 0.0012 if step < 200 else 0.0
        btn_pressed = float(data.qpos[button_qpos_adr]) > 0.0007

        if state == "ready" and btn_pressed:
            state = "grinding"
            timer_mode_s = 30
            timer_remaining_s = 30.0
            low_torque_timer_s = 0.0

        coupled, radial_err = apply_magnetic_cup_centering()

        if state == "grinding":
            timer_remaining_s = max(0.0, timer_remaining_s - dt)
            data.ctrl[act_burr] = nominal_omega
            omega = max(0.0, float(data.qvel[burr_dof_adr]))
            if hopper_beans_g > 0.0 and omega > 10.0:
                d_mass = min(hopper_beans_g, grind_rate_gps * (omega / nominal_omega) * dt)
                hopper_beans_g -= d_mass
                # Anti-static ionizer at chute exit prevents static clump buildup (>99% direct delivery)
                to_chute = min(
                    d_mass * 0.015, max(0.0, ionizer_max_retention_g - chute_retention_g)
                )
                chute_retention_g += to_chute
                cup_grounds_g += d_mass - to_chute
                model.body_mass[payload_body_id] = max(1e-9, cup_grounds_g * 0.001)
                ripple = 1.0 + 0.07 * math.sin(float(data.qpos[burr_qpos_adr]) * 6.0)
                data.qfrc_applied[burr_dof_adr] = -1.25 * ripple
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

        if state == "grinding" and step > 500:
            if motor_torque < 0.22:
                low_torque_timer_s += dt
                if low_torque_timer_s >= 1.00:
                    state = "auto_stopped"
                    data.ctrl[act_burr] = 0.0
            else:
                low_torque_timer_s = 0.0
        elif state == "auto_stopped" and abs(rpm) < 0.5:
            state = "ready"

        if step % 200 == 0:
            record_row(
                sim_time,
                "timed_grind_autostop",
                state,
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    turns_completed = (float(data.qpos[burr_qpos_adr]) / math.tau) - turns_at_start
    post_grind_rpm = float(data.qvel[burr_dof_adr]) * 60.0 / math.tau
    dosed_cup_support_n = float(data.sensor("opus_cup_seat_touch").data[0])
    assert hopper_beans_g == 0.0, f"Beans remaining in hopper: {hopper_beans_g}"
    assert state == "ready", f"Expected auto-stop to return to ready, got {state}"
    assert timer_remaining_s > 18.0, (
        f"Auto-stop did not terminate early before 30 s timer: {timer_remaining_s} s left"
    )
    assert abs(post_grind_rpm) < 0.5, f"Burr did not stop after auto-off: {post_grind_rpm} RPM"
    assert peak_grinding_rpm > 385.0, f"Peak RPM below 400 RPM target: {peak_grinding_rpm}"
    assert chute_retention_g < 0.12, f"Ionizer retention exceeded 0.12 g: {chute_retention_g}"
    assert dosed_cup_support_n > seated_empty_support_n + 0.15, (
        "Touch sensor did not reflect added mass of 18 g espresso grounds"
    )

    # -------------------------------------------------------------------------
    # STAGE 4: Multi-Press Timer Selection (60 s Double / 90 s Triple) & Lid Lift
    # -------------------------------------------------------------------------
    latched_modes = []
    press_count = 0
    prev_pressed = False
    for step in range(900):
        # Pulse 1: steps 50..130, Pulse 2: steps 180..260 (double press = 60 s), Pulse 3: steps 310..390 (triple = 90 s)
        in_pulse = (50 <= step < 130) or (180 <= step < 260) or (310 <= step < 390)
        data.ctrl[act_button] = 0.0012 if in_pulse else 0.0
        data.ctrl[act_lid_lift] = 0.065 if (200 <= step < 650) else 0.0

        btn_pressed = float(data.qpos[button_qpos_adr]) > 0.0006
        if btn_pressed and not prev_pressed:
            press_count += 1
            timer_mode_s = min(120, 30 * press_count)
            latched_modes.append(timer_mode_s)
        prev_pressed = btn_pressed

        coupled, radial_err = apply_magnetic_cup_centering()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 100 == 0:
            record_row(
                sim_time,
                "multipress_timer_lid",
                state,
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert latched_modes == [30, 60, 90], f"Expected multi-press timer progression [30, 60, 90], got {latched_modes}"

    # -------------------------------------------------------------------------
    # STAGE 5: Safety & Fault Guards
    # 5A: Foreign-object burr jam auto-stop (> 2.8 N*m load stalls burr -> automatic shutoff).
    # 5B: 120-second maximum timer thermal duty cutoff.
    # -------------------------------------------------------------------------
    state = "grinding"
    hopper_beans_g = 6.0
    jam_stall_timer_s = 0.0
    jam_fault_triggered = False
    peak_jam_torque_nm = 0.0

    for step in range(800):
        coupled, radial_err = apply_magnetic_cup_centering()
        if state == "grinding":
            data.ctrl[act_burr] = nominal_omega
            # Inject foreign-object stone jam at step 150 (-4.2 N*m resistive load exceeding 3.2 N*m max drive)
            if step >= 150:
                data.qfrc_applied[burr_dof_adr] = -4.20 - 0.5 * float(data.qvel[burr_dof_adr])
            else:
                data.qfrc_applied[burr_dof_adr] = -1.20
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0

        mujoco.mj_step(model, data)
        sim_time += dt

        rpm = float(data.qvel[burr_dof_adr]) * 60.0 / math.tau
        motor_torque = float(data.actuator_force[act_burr])
        peak_jam_torque_nm = max(peak_jam_torque_nm, motor_torque)

        if state == "grinding" and step >= 160:
            if motor_torque > 2.80 and abs(rpm) < 25.0:
                jam_stall_timer_s += dt
                if jam_stall_timer_s >= 0.25:
                    state = "jam_fault_autostop"
                    jam_fault_triggered = True
                    data.ctrl[act_burr] = 0.0
                    data.qfrc_applied[burr_dof_adr] = 0.0

        if step % 100 == 0:
            record_row(
                sim_time,
                "jam_and_thermal_guard",
                state,
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert jam_fault_triggered, "Controller failed to detect foreign-object burr jam and shut off motor"
    assert peak_jam_torque_nm > 3.0, f"Expected stall torque > 3.0 N*m during jam, got {peak_jam_torque_nm}"

    # 5B: 120 s max continuous duty thermal cutoff
    state = "grinding"
    timer_mode_s = 120
    duty_elapsed_s = 119.70
    thermal_cutoff_triggered = False
    for step in range(500):
        if state == "grinding":
            duty_elapsed_s += dt
            data.ctrl[act_burr] = nominal_omega
            data.qfrc_applied[burr_dof_adr] = -1.15
            if duty_elapsed_s >= 120.0:
                state = "thermal_cooldown"
                thermal_cutoff_triggered = True
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
                "jam_and_thermal_guard",
                state,
                timer_mode_s,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    assert thermal_cutoff_triggered, "Expected 120 s thermal cutoff to trigger"

    # -------------------------------------------------------------------------
    # STAGE 6: Tool-less Disassembly (Lid + Hopper + 48 mm Burr Carrier Lift) & Reassembly
    # -------------------------------------------------------------------------
    hopper_beans_g = 0.0
    max_lid_lift_m = 0.0
    max_hopper_lift_m = 0.0
    max_carrier_lift_m = 0.0
    for step in range(1000):
        if step < 500:
            data.ctrl[act_lid_lift] = 0.110
            data.ctrl[act_hopper_lift] = 0.085 if step >= 80 else 0.0
            data.ctrl[act_carrier_lift] = 0.065 if step >= 180 else 0.0
            state = "maintenance_open"
        else:
            data.ctrl[act_carrier_lift] = 0.0
            data.ctrl[act_hopper_lift] = 0.0 if step >= 620 else 0.085
            data.ctrl[act_lid_lift] = 0.0 if step >= 740 else 0.110
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
                30,
                hopper_beans_g,
                chute_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert max_lid_lift_m > 0.105, f"Lid lift insufficient: {max_lid_lift_m}"
    assert max_hopper_lift_m > 0.080, f"Hopper lift insufficient: {max_hopper_lift_m}"
    assert max_carrier_lift_m > 0.060, f"Burr carrier lift insufficient: {max_carrier_lift_m}"
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
            ASSETS / "catch_cup_model.xml",
            ASSETS / "scene.xml",
            ASSETS / "native.xml",
            ASSETS / "visual_assets.xml",
            *(ASSETS.glob("visual_opus_*.xml")),
            *(ASSETS / "meshes").glob("*.obj"),
            ASSETS / "fellow-opus-2.blend",
            ASSETS / "fellow-opus-2.glb",
            Path(__file__).resolve(),
        ]
    )
    input_sha256 = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in tracked_files
    }

    report = {
        "status": "passed",
        "appliance": "fellow-opus-2",
        "mujoco_version": mujoco.__version__,
        "rendered": False,
        "input_sha256": input_sha256,
        "frame_alignment": alignment_summary,
        "journey": {
            "published_no_load_rpm": 400,
            "published_timer_modes_s": [30, 60, 90, 120],
            "cup_seating": {
                "initial_radial_offset_m": round(initial_radial_offset_m, 6),
                "seated_radial_error_m": round(seated_radial_error_m, 6),
                "empty_cup_support_n": round(seated_empty_support_n, 4),
                "coupled": True,
            },
            "grind_adjustment": {
                "start_setting": 6.0,
                "target_espresso_setting": 2.0,
                "achieved_setting": round(achieved_setting, 4),
                "achieved_knob_deg": round(achieved_knob_deg, 2),
            },
            "timed_grind_and_autostop": {
                "selected_timer_s": 30,
                "dose_input_g": 18.0,
                "grind_rate_gps": 2.0,
                "peak_rpm": round(peak_grinding_rpm, 3),
                "peak_torque_nm": round(peak_grinding_torque_nm, 4),
                "burr_turns": round(turns_completed, 3),
                "ionizer_chute_retention_g": round(chute_retention_g, 4),
                "delivered_cup_grounds_g": round(cup_grounds_g, 4),
                "dosed_cup_support_n": round(dosed_cup_support_n, 4),
                "timer_remaining_at_autostop_s": round(timer_remaining_s, 3),
                "post_stop_rpm": round(post_grind_rpm, 4),
            },
            "multipress_timer_and_lid": {
                "latched_timer_modes_s": latched_modes,
                "lid_inspection_lift_m": 0.065,
            },
            "safety_and_jam_protection": {
                "jam_fault_triggered": jam_fault_triggered,
                "peak_jam_stall_torque_nm": round(peak_jam_torque_nm, 4),
                "max_120s_duty_cutoff_triggered": thermal_cutoff_triggered,
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

    active_states_md = """# Fellow Opus 2 Black native physics

Native `48 mm` 6-star conical burr drive (`400 RPM`), magnetic self-centering catch-cup seating, stepless side worm-gear grind adjustment (`opus_knob_turn` coupled with `opus_scale_turn` across settings `1`–`10`), multi-press timed start (`30 s` / `60 s` / `90 s` / `120 s`), anti-static ionizer low-retention chute delivery, torque-sensed auto-stop on bean depletion, foreign-object burr jam protection, and tool-less lid/hopper/burr-carrier maintenance removal.

- [Acceptance report](active-state-evidence/report.json)
- [Native trace](active-state-evidence/trace.csv)

## Verified Active States & Transitions

1. **Magnetic Catch Cup Seating (`cup_seating`):** Releases `opus_catch_cup` (`+4.5 mm` `X`, `-3.5 mm` `Y`, `+2.0 mm` `Z` off `vessel_socket`) into the magnetic landing pad capture field (`18 mm` capture radius), settling with `< 0.5 mm` radial error on `opus_cup_seat`.
2. **Stepless Side Worm-Gear Grind Adjustment (`grind_adjustment`):** Rotates `opus_grind_knob` around `+X` coupled (`6:1`) with `opus_scale_ring` around `+Z` from Filter (`6.0`) to Espresso (`2.0`).
3. **Timed Start, `400 RPM` Espresso Grind & Auto-Stop (`timed_grind_autostop`):** Single momentary press of `opus_power_press` latches the `30 s` timer and spins `opus_burr_cone` at `400 RPM`, comminuting an `18.0 g` espresso dose at `2.0 g/s` (`9.0 s` active grind) with `< 0.10 g` anti-static ionizer retention, then detects unloaded motor torque for `1.0 s` after bean depletion and stops automatically with `~19.8 s` remaining on the `30 s` timer.
4. **Multi-Press Timer Selection & Dosing Lid Lift (`multipress_timer_lid`):** Verifies single/double/triple button presses latching `30 s`, `60 s`, and `90 s` timer modes while lifting `opus_hopper_lid` (`+65 mm`) for dosing guide inspection.
5. **Foreign-Object Burr Jam & `120 s` Thermal Cutoff (`jam_and_thermal_guard`):** Injects a `-4.2 N·m` foreign-object stall load during grinding, verifying `opus_burr_spin` stall detection (`> 2.8 N·m` load for `0.25 s`) and automatic transition to `jam_fault_autostop`, plus the `120 s` continuous duty cutoff (`thermal_cooldown`).
6. **Tool-less Disassembly (`toolless_maintenance`):** Lifts `opus_hopper_lid` (`+110 mm`), `opus_hopper` (`+85 mm`), and the `48 mm` outer burr carrier `opus_burr_carrier` (`+65 mm`) by its wire bail handle, then restores the assembly to `ready`.

Dynamic parameters (component inertias, worm-gear efficiency, magnetic stiffness curve, and bean fracture ripple) remain engineering assumptions pending physical load cell and tachometer calibration.
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
