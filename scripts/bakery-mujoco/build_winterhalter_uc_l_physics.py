"""Build and verify MuJoCo 4.0 contact mechanics for the Winterhalter UC-L undercounter dishwasher."""

from __future__ import annotations

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
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
    z_rot_quat,
)

FOLDER = "winterhalter-uc-l"
ASSETS = ROOT / "assets/bakery-mujoco" / FOLDER

NAMES = (
    "ucl_dishwasher",
    "ucl_door",
    "ucl_wash_rack",
    "ucl_lower_wash_field",
    "ucl_upper_wash_field",
)

# Manufacturer net weight ~64 kg (55 kg cabinet/sump/pump + 7 kg insulated door
# + 2 kg 500x500 mm wire rack + 2x0.25 kg S-shaped spray fields = 64.5 kg).
MASSES = {
    "ucl_dishwasher": 55.0,
    "ucl_door": 7.0,
    "ucl_wash_rack": 2.0,
    "ucl_lower_wash_field": 0.25,
    "ucl_upper_wash_field": 0.25,
}

# Physically realistic CoM and principal inertia for the 600 x 603 x 820 mm undercounter unit.
# Lower bay houses the wash pump, boiler, and tank, keeping CoM low and inside the 4-foot polygon
# even with the drop-down door open to 90 deg.
CENTERS = {
    "ucl_dishwasher": (0.0, 0.010, 0.340),
    "ucl_door": (0.0, -0.002, 0.215),
    "ucl_wash_rack": (0.0, 0.0, 0.032),
    "ucl_lower_wash_field": (0.0, 0.0, 0.002),
    "ucl_upper_wash_field": (0.0, 0.0, 0.002),
}

INERTIAS = {
    "ucl_dishwasher": (4.20, 4.20, 3.20),
    "ucl_door": (0.115, 0.295, 0.190),
    "ucl_wash_rack": (0.044, 0.044, 0.083),
    "ucl_lower_wash_field": (0.0005, 0.0044, 0.0046),
    "ucl_upper_wash_field": (0.0005, 0.0044, 0.0046),
}

VISUAL_MOTIONS = {
    "ucl_door_hinge": (1, 0, 0),
    "ucl_rack_slide": (0, 1, 0),
    "ucl_lower_spin": (0, 0, 1),
    "ucl_upper_spin": (0, 0, 1),
}


def _box_collider(
    body: ET.Element,
    name: str,
    position: tuple[float, float, float],
    size: tuple[float, float, float],
    rgba: str,
    *,
    quat: str | None = None,
) -> ET.Element:
    attrib = {
        "name": name,
        "type": "box",
        "pos": numbers(position),
        "size": numbers(size),
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if quat is not None:
        attrib["quat"] = quat
    return ET.SubElement(body, "geom", **attrib)


def _cyl_collider(
    body: ET.Element,
    name: str,
    position: tuple[float, float, float],
    size: tuple[float, float],
    rgba: str,
    *,
    quat: str | None = None,
) -> ET.Element:
    attrib = {
        "name": name,
        "type": "cylinder",
        "pos": numbers(position),
        "size": numbers(size),
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if quat is not None:
        attrib["quat"] = quat
    return ET.SubElement(body, "geom", **attrib)


def _add_spray_field_colliders(body: ET.Element, prefix: str) -> None:
    """Author tight S-shaped analytic colliders matching the 464 mm spray field contour."""
    # Central hub + release cap + finger grip (Z in [-0.006, +0.026])
    _cyl_collider(
        body,
        f"{prefix}_hub_col",
        (0.0, 0.0, 0.010),
        (0.028, 0.016),
        COL_ARTIC_RGBA,
    )
    # Center diagonal spine bridging (-0.11, -0.034) to (+0.11, +0.034)
    _box_collider(
        body,
        f"{prefix}_spine_col",
        (0.0, 0.0, 0.000),
        (0.115, 0.020, 0.0065),
        COL_ARTIC_RGBA,
        quat=numbers(z_rot_quat(0.30)),
    )
    # Left and right curved outer S-wings
    _box_collider(
        body,
        f"{prefix}_wing_left_col",
        (-0.165, -0.043, 0.000),
        (0.067, 0.016, 0.0065),
        COL_ARTIC_RGBA,
        quat=numbers(z_rot_quat(0.05)),
    )
    _box_collider(
        body,
        f"{prefix}_wing_right_col",
        (0.165, 0.043, 0.000),
        (0.067, 0.016, 0.0065),
        COL_ARTIC_RGBA,
        quat=numbers(z_rot_quat(0.05)),
    )


def export_blender_meshes_and_xml() -> None:
    """Run inside background Blender to export UV+PBR visual meshes and author MJCF files."""
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    source = ASSETS / f"{FOLDER}.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    app = ET.Element(
        "mujoco",
        model="winterhalter-uc-l — commercial undercounter dishwasher",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")

    defaults = add_standard_defaults(app)

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "ucl_dishwasher" else None)
        )
        parent_el = bodies.get(parent_obj.name) if parent_obj else None
        transform = (
            poses[name]
            if parent_obj is None
            else poses[parent_obj.name].inverted() @ poses[name]
        )
        body = ET.SubElement(
            world if parent_el is None else parent_el,
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

    base = bodies["ucl_dishwasher"]
    door = bodies["ucl_door"]
    rack = bodies["ucl_wash_rack"]
    lower = bodies["ucl_lower_wash_field"]
    upper = bodies["ucl_upper_wash_field"]

    # 1. Four adjustable levelling feet touching Z = 0.000 m and sealing into the lower bay
    for foot_name, fx, fy in (
        ("ucl_foot_fl_col", -0.278, -0.276),
        ("ucl_foot_fr_col", 0.278, -0.276),
        ("ucl_foot_rl_col", -0.278, 0.269),
        ("ucl_foot_rr_col", 0.278, 0.269),
    ):
        _cyl_collider(base, foot_name, (fx, fy, 0.008), (0.012, 0.008), COL_BASE_RGBA)

    # 2. Hollow stainless steel cabinet shell + lower machinery sump + rack rails.
    #    Wash chamber interior X in [-0.272, +0.272], Y in [-0.254, +0.264], Z in [0.328, 0.732]
    #    stays completely open so the 500 x 500 mm rack slides cleanly in and out.
    cabinet_boxes = (
        # Top stainless cover (Z = 0.806 .. 0.820) and inner chamber ceiling (Z = 0.792 .. 0.806)
        ("ucl_top_cover_col", (0.0, 0.0, 0.813), (0.300, 0.3015, 0.007), COL_BASE_RGBA),
        ("ucl_ceiling_col", (0.0, 0.0, 0.799), (0.274, 0.275, 0.007), COL_WALL_RGBA),
        # Left & right insulated side walls + liners + front corner trims (Z = 0.010 .. 0.808)
        ("ucl_wall_left_col", (-0.286, -0.007, 0.409), (0.014, 0.3085, 0.399), COL_WALL_RGBA),
        ("ucl_wall_right_col", (0.286, -0.007, 0.409), (0.014, 0.3085, 0.399), COL_WALL_RGBA),
        # Rear insulated wall + wash chamber back + rear service panel (Y = 0.264 .. 0.3015)
        ("ucl_wall_rear_col", (0.0, 0.28275, 0.411), (0.2745, 0.01875, 0.400), COL_WALL_RGBA),
        # Lower machinery enclosure + wash tank sump floor (Z = 0.012 .. 0.244)
        ("ucl_lower_base_col", (0.0, 0.0, 0.128), (0.2745, 0.2835, 0.116), COL_BASE_RGBA),
        # Wash tank filter plate & strainer (Z = 0.245 .. 0.253)
        ("ucl_filter_plate_col", (-0.165, -0.015, 0.249), (0.071, 0.205, 0.004), COL_BASE_RGBA),
        # Lower front dosing panel & lip (Y = -0.3355 .. -0.2835, Z = 0.016 .. 0.296)
        (
            "ucl_lower_front_panel_col",
            (0.0, -0.3095, 0.156),
            (0.279, 0.026, 0.140),
            COL_BASE_RGBA,
        ),
        # Front tank sill & loading entry threshold (Z = 0.296 .. 0.328)
        ("ucl_front_sill_col", (0.0, -0.270, 0.312), (0.273, 0.016, 0.016), COL_WALL_RGBA),
        # Upper control fascia & glass touch panel (Y = -0.320 .. -0.295, Z = 0.748 .. 0.814)
        (
            "ucl_control_fascia_col",
            (0.0, -0.3075, 0.781),
            (0.300, 0.0125, 0.033),
            COL_WALL_RGBA,
        ),
        # Upper opening jamb (Z = 0.732 .. 0.748, preserving 404 mm clear entry height)
        ("ucl_upper_jamb_col", (0.0, -0.273, 0.740), (0.273, 0.022, 0.008), COL_WALL_RGBA),
        # Left & right interior rack guide rails (top at Z = 0.328 m)
        ("ucl_rail_left_col", (-0.246, -0.003, 0.322), (0.0115, 0.264, 0.006), COL_WALL_RGBA),
        ("ucl_rail_right_col", (0.246, -0.003, 0.322), (0.0115, 0.264, 0.006), COL_WALL_RGBA),
    )
    for cname, cpos, csize, crgba in cabinet_boxes:
        _box_collider(base, cname, cpos, csize, crgba)

    # Loading threshold reference site (group 4)
    ET.SubElement(
        base,
        "site",
        name="ucl_loading_site",
        type="box",
        pos="0 -0.267 0.328",
        size="0.240 0.015 0.003",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 3. Front drop-down door (0..90 deg around local +X)
    # Counterbalanced commercial dishwasher hinge friction (14 N*m > 10.54 N*m mid-pose gravity torque)
    # holds the door against gravity without slamming while remaining easily driven by ucl_door_fixture.
    ET.SubElement(
        door,
        "joint",
        name="ucl_door_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 1.57079633",
        damping="2",
        armature="0.02",
        frictionloss="14.0",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    # Main insulated door leaf (inner wash face at local Y = +0.013 -> world Z = 0.328 when open 90 deg)
    _box_collider(
        door,
        "ucl_door_support",
        (0.0, -0.0005, 0.2175),
        (0.2795, 0.0135, 0.2135),
        COL_ARTIC_RGBA,
    )
    # Left & right hinge barrels
    _cyl_collider(
        door,
        "ucl_door_hinge_left_col",
        (-0.272, 0.0, 0.0),
        (0.008, 0.006),
        COL_ARTIC_RGBA,
        quat=X_AXIS_QUAT,
    )
    _cyl_collider(
        door,
        "ucl_door_hinge_right_col",
        (0.272, 0.0, 0.0),
        (0.008, 0.006),
        COL_ARTIC_RGBA,
        quat=X_AXIS_QUAT,
    )
    # 5-part bowed stainless door handle preserving the open hand-grasp pass-through gap
    _box_collider(
        door,
        "ucl_door_handle_mount_left_col",
        (-0.255, -0.021, 0.399),
        (0.014, 0.008, 0.016),
        COL_ARTIC_RGBA,
    )
    _box_collider(
        door,
        "ucl_door_handle_mount_right_col",
        (0.255, -0.021, 0.399),
        (0.014, 0.008, 0.016),
        COL_ARTIC_RGBA,
    )
    _box_collider(
        door,
        "ucl_door_handle_left_col",
        (-0.1725, -0.0365, 0.399),
        (0.074, 0.0065, 0.016),
        COL_ARTIC_RGBA,
        quat=numbers(z_rot_quat(-0.1222)),
    )
    _box_collider(
        door,
        "ucl_door_handle_center_col",
        (0.0, -0.0470, 0.399),
        (0.102, 0.0070, 0.016),
        COL_ARTIC_RGBA,
    )
    _box_collider(
        door,
        "ucl_door_handle_right_col",
        (0.1725, -0.0365, 0.399),
        (0.074, 0.0065, 0.016),
        COL_ARTIC_RGBA,
        quat=numbers(z_rot_quat(0.1222)),
    )
    ET.SubElement(
        door,
        "site",
        name="ucl_handle_site",
        type="box",
        pos="0 -0.047 0.399",
        size="0.060 0.010 0.016",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # 4. Sliding 500 x 500 mm wire wash rack (slides along local Y in [-0.56, 0])
    ET.SubElement(
        rack,
        "joint",
        name="ucl_rack_slide",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="-0.56 0",
        damping="5",
        armature="0.01",
        frictionloss="0.5",
        solreflimit="0.005 1",
    )
    _box_collider(
        rack,
        "ucl_rack_floor",
        (0.0, 0.0, 0.0),
        (0.247, 0.247, 0.003),
        COL_ACCESSORY_RGBA,
    )
    _box_collider(
        rack,
        "ucl_rack_wall_left_col",
        (-0.2465, 0.0, 0.0525),
        (0.0035, 0.247, 0.0525),
        COL_ACCESSORY_RGBA,
    )
    _box_collider(
        rack,
        "ucl_rack_wall_right_col",
        (0.2465, 0.0, 0.0525),
        (0.0035, 0.247, 0.0525),
        COL_ACCESSORY_RGBA,
    )
    _box_collider(
        rack,
        "ucl_rack_wall_front_col",
        (0.0, -0.2465, 0.0525),
        (0.243, 0.0035, 0.0525),
        COL_ACCESSORY_RGBA,
    )
    _box_collider(
        rack,
        "ucl_rack_wall_rear_col",
        (0.0, 0.2465, 0.0525),
        (0.243, 0.0035, 0.0525),
        COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        rack,
        "site",
        name="ucl_rack_handle_site",
        type="box",
        pos="0 -0.247 0.080",
        size="0.060 0.008 0.015",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    ET.SubElement(
        rack,
        "site",
        name="ucl_rack_support_site",
        type="box",
        pos="0 0 0.005",
        size="0.220 0.220 0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 5. Lower & upper rotating S-shaped wash fields (continuous Z spin)
    for label, arm_body in (("lower", lower), ("upper", upper)):
        ET.SubElement(
            arm_body,
            "joint",
            name=f"ucl_{label}_spin",
            type="hinge",
            axis="0 0 1",
            limited="false",
            damping="0.01",
            armature="0.001",
        )
        _add_spray_field_colliders(arm_body, f"ucl_{label}_arm")

    # 6. Adjacent body contact excludes so all joints sweep freely with zero internal jams
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_dishwasher_door", "ucl_dishwasher", "ucl_door"),
            ("exclude_dishwasher_rack", "ucl_dishwasher", "ucl_wash_rack"),
            ("exclude_door_rack", "ucl_door", "ucl_wash_rack"),
            ("exclude_dishwasher_lower_arm", "ucl_dishwasher", "ucl_lower_wash_field"),
            ("exclude_dishwasher_upper_arm", "ucl_dishwasher", "ucl_upper_wash_field"),
            ("exclude_rack_lower_arm", "ucl_wash_rack", "ucl_lower_wash_field"),
            ("exclude_rack_upper_arm", "ucl_wash_rack", "ucl_upper_wash_field"),
        ),
    )

    # 7. Actuators preserving exact Rust/Wasm controller fixture & drive names
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="ucl_door_fixture",
        joint="ucl_door_hinge",
        ctrlrange="0 1.57079633",
        kp="1200",
        kv="80",
        forcerange="-150 150",
    )
    ET.SubElement(
        actuators,
        "position",
        name="ucl_rack_fixture",
        joint="ucl_rack_slide",
        ctrlrange="-0.56 0",
        kp="3000",
        kv="100",
        forcerange="-100 100",
    )
    for label in ("lower", "upper"):
        ET.SubElement(
            actuators,
            "velocity",
            name=f"ucl_{label}_drive",
            joint=f"ucl_{label}_spin",
            kv="0.2",
            ctrlrange="0 10",
            forcerange="-0.5 0.5",
        )

    write_xml(ASSETS / "appliance.xml", app)

    # Lab scene wrapper (includes appliance.xml + bench floor at Z = 0.000 m)
    scene = ET.Element("mujoco", model=f"{FOLDER} lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.4 0.4 0.4")
    s_asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        s_asset,
        "texture",
        name="lab_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    s_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(s_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1")
    ET.SubElement(
        s_world,
        "geom",
        name="bench",
        type="plane",
        size="3 3 0.05",
        pos="0 0 0",
        rgba="0.25 0.29 0.32 0.50",
        group="3",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    # Emit standalone MjSpec.attach-ready model.xml (no floor, skybox, or actuators)
    emit_standalone_models(
        ASSETS,
        model_name="ucl_dishwasher",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "total_mass_kg": sum(MASSES.values()),
                "component_masses_kg": MASSES,
                "envelope_m": [0.600, 0.657, 0.820],
                "scope": (
                    "MuJoCo 4.0 UV+PBR visuals, full hollow cabinet/foot/door/rack/spray-field "
                    "collision geometry, and Rust-compatible native cleaning model."
                ),
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_and_physics() -> None:
    """Export native.xml via live_panels.model_spec and verify frames, motions, and dishwasher mechanics."""
    import mujoco
    import numpy as np

    from live_panels import model_spec

    spec = model_spec(ASSETS / "scene.xml", FOLDER)
    _model, rebuilt = kit_export_native_xml(
        ASSETS, FOLDER, mujoco, np, spec=spec, strip_general_input=True
    )

    # 1. Verify all Rust-required bodies, joints, actuators, geoms, and sites exist in native.xml
    for bname in (*NAMES, "wash_hl_bowl", "wash_hl_beater", "live_temperature"):
        rebuilt.body(bname)
    for jname in (
        "ucl_door_hinge",
        "ucl_rack_slide",
        "ucl_lower_spin",
        "ucl_upper_spin",
    ):
        rebuilt.joint(jname)
    for aname in (
        "ucl_door_fixture",
        "ucl_rack_fixture",
        "ucl_lower_drive",
        "ucl_upper_drive",
    ):
        rebuilt.actuator(aname)
    for gname in ("ucl_door_support", "ucl_rack_floor", "wash_receiving_bench"):
        rebuilt.geom(gname)
    for sname in (
        "ucl_loading_site",
        "ucl_handle_site",
        "ucl_rack_handle_site",
        "ucl_rack_support_site",
    ):
        rebuilt.site(sname)

    # 2. Verify GLB rest frames and 21-sample scalar joint trajectories
    evidence_dir = ASSETS / "active-state-evidence"
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        FOLDER,
        NAMES,
        VISUAL_MOTIONS,
        mujoco,
        evidence_dir,
        cleanup_inputs=True,
    )

    # 3. Verify door open (90 deg), rack full extension (-0.52 m), spray-arm spin, and return to closed
    data = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, data)

    door_act = rebuilt.actuator("ucl_door_fixture").id
    rack_act = rebuilt.actuator("ucl_rack_fixture").id
    lower_act = rebuilt.actuator("ucl_lower_drive").id
    upper_act = rebuilt.actuator("ucl_upper_drive").id

    # Open door to 90 deg
    data.ctrl[door_act] = math.pi / 2.0
    for _ in range(int(round(2.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)
    door_open_deg = math.degrees(float(data.joint("ucl_door_hinge").qpos[0]))
    assert door_open_deg >= 85.0, door_open_deg

    # Extend rack to -0.52 m (Rust access target)
    data.ctrl[rack_act] = -0.52
    for _ in range(int(round(3.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)
    rack_ext_m = float(data.joint("ucl_rack_slide").qpos[0])
    assert abs(rack_ext_m + 0.52) <= 0.01, rack_ext_m

    # Retract rack, close door, and spin both spray arms
    data.ctrl[rack_act] = 0.0
    for _ in range(int(round(3.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)
    data.ctrl[door_act] = 0.0
    data.ctrl[lower_act] = 6.0
    data.ctrl[upper_act] = 6.0
    for _ in range(int(round(2.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)
    door_closed_deg = math.degrees(float(data.joint("ucl_door_hinge").qpos[0]))
    rack_closed_m = float(data.joint("ucl_rack_slide").qpos[0])
    lower_vel = float(data.joint("ucl_lower_spin").qvel[0])
    upper_vel = float(data.joint("ucl_upper_spin").qvel[0])
    assert abs(door_closed_deg) < 2.0, door_closed_deg
    assert abs(rack_closed_m) < 0.01, rack_closed_m
    assert lower_vel > 4.0 and upper_vel > 4.0, (lower_vel, upper_vel)
    assert np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))

    print(
        json.dumps(
            {
                "status": "passed",
                "appliance": FOLDER,
                "native_nq": int(rebuilt.nq),
                "native_nv": int(rebuilt.nv),
                "total_mass_kg": float(sum(MASSES.values())),
                "frames_passed": frames_report["passed"],
                "motion_passed": motion_report["passed"],
                "door_open_deg": round(door_open_deg, 2),
                "rack_ext_m": round(rack_ext_m, 4),
                "door_closed_deg": round(door_closed_deg, 2),
                "spray_arm_rad_s": [round(lower_vel, 2), round(upper_vel, 2)],
            },
            indent=2,
        )
    )


def main() -> None:
    if "--blender-export" in sys.argv or "bpy" in sys.modules:
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
            "--blender-export",
        ],
        check=True,
    )
    export_and_verify_native_and_physics()


if __name__ == "__main__":
    main()
