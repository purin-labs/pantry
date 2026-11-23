"""Build and verify the MuJoCo planetary drive, head-lift safety interlock, and 6.7 L bowl model for the Aicohsha Kenmix KPL9000S."""

from __future__ import annotations

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
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
    z_rot_quat,
)

ASSETS = ROOT / "assets/bakery-mujoco/aicohsha-kpl9000s"

NAMES = (
    "kpl_base",
    "kpl_head",
    "kpl_planetary",
    "kpl_whip",
    "kpl_speed_dial",
    "kpl_finger_guard",
    "kpl_bowl",
)

# Published total mass = 8.600 kg (7.500 kg mixer assembly + 1.100 kg removable 6.7 L SUS304 bowl)
MASSES = {
    "kpl_base": 3.150,
    "kpl_head": 3.420,
    "kpl_planetary": 0.380,
    "kpl_whip": 0.280,
    "kpl_speed_dial": 0.060,
    "kpl_finger_guard": 0.210,
    "kpl_bowl": 1.100,
}

CENTERS = {
    "kpl_base": (0.0, 0.055, 0.065),
    "kpl_head": (0.0, -0.115, 0.095),
    "kpl_planetary": (0.0, -0.008, -0.004),
    "kpl_whip": (0.0, 0.0, -0.088),
    "kpl_speed_dial": (0.012, 0.0, 0.0),
    "kpl_finger_guard": (0.0, -0.085, -0.004),
    "kpl_bowl": (0.0, 0.0, 0.078),
}

INERTIAS = {
    "kpl_base": (0.0380, 0.0165, 0.0440),
    "kpl_head": (0.0460, 0.0145, 0.0490),
    "kpl_planetary": (0.00055, 0.00055, 0.00095),
    "kpl_whip": (0.00085, 0.00085, 0.00038),
    "kpl_speed_dial": (0.00002, 0.000015, 0.000015),
    "kpl_finger_guard": (0.00095, 0.00095, 0.00180),
    "kpl_bowl": (0.00680, 0.00680, 0.00820),
}

BOWL_REST_POS = (0.0, -0.0800, 0.0120)
PLANETARY_RATIO = 3.50  # whip spin (around -Z) to planetary carrier orbit (around +Z)

VISUAL_MOTIONS = {
    "kpl_head_tilt": (-1, 0, 0),
    "kpl_orbit_spin": (0, 0, 1),
    "kpl_whip_spin": (0, 0, -1),
    "kpl_dial_turn": (1, 0, 0),
    "kpl_guard_hinge": (1, 0, 0),
}


def quat_mul(
    q1: tuple[float, float, float, float],
    q2: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return (
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    )


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local OBJ meshes and author appliance.xml, scene.xml, and standalone models."""
    source = ASSETS / "aicohsha-kpl9000s.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    app = ET.Element(
        "mujoco",
        model="aicohsha-kpl9000s — Kenmix Aicoh Chef PRO 6.7 L planetary mixer",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(app)

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.2 1.2 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="1",
    )

    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        if name == "kpl_bowl":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "kpl_base" else None)
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

    base = bodies["kpl_base"]
    head = bodies["kpl_head"]
    planetary = bodies["kpl_planetary"]
    whip = bodies["kpl_whip"]
    dial = bodies["kpl_speed_dial"]
    guard = bodies["kpl_finger_guard"]
    bowl = bodies["kpl_bowl"]

    # Five elastomer feet touching exact Z = 0.0000 m
    for foot_name, fx, fy in (
        ("kpl_foot_fl_col", -0.0680, -0.1420),
        ("kpl_foot_fr_col", 0.0680, -0.1420),
        ("kpl_foot_ml_col", -0.0800, 0.0380),
        ("kpl_foot_mr_col", 0.0800, 0.0380),
        ("kpl_foot_rear_col", 0.0, 0.1680),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0040)),
            size="0.0145 0.0040",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Lower pedestal deck: bayonet bowl seat pad (top face at exact Z = 0.0120 m),
    # 5-sector circular front apron collar around the bowl recess, angled side cheeks,
    # connecting deck bridge, two-tier rear column, and rear power cord strain relief
    ET.SubElement(
        base,
        "geom",
        name="kpl_seat_pad_col",
        type="cylinder",
        pos="0 -0.0800 0.0083",
        size="0.0925 0.0037",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    apron_angles_deg = (-170.0, -130.0, -90.0, -50.0, -10.0)
    r_apron = 0.1035
    for a_idx, deg in enumerate(apron_angles_deg):
        ang = math.radians(deg)
        ax = r_apron * math.cos(ang)
        ay = -0.0800 + r_apron * math.sin(ang)
        ET.SubElement(
            base,
            "geom",
            name=f"kpl_apron_{a_idx:02d}_col",
            type="box",
            pos=numbers((ax, ay, 0.0200)),
            quat=numbers(z_rot_quat(ang)),
            size="0.0060 0.0410 0.0130",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )
    for side_lbl, sx, sgn in (("left", -0.0940, -1.0), ("right", 0.0940, 1.0)):
        # Angled deck cheek transitioning from front circular apron (Y=-0.055) to straight rear pedestal (Y=+0.025)
        ET.SubElement(
            base,
            "geom",
            name=f"kpl_deck_{side_lbl}_col",
            type="box",
            pos=numbers((sx, -0.0150, 0.0200)),
            quat=numbers(z_rot_quat(sgn * 0.16)),
            size="0.0075 0.0440 0.0130",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )
    ET.SubElement(
        base,
        "geom",
        name="kpl_deck_bridge_col",
        type="box",
        pos="0 0.0350 0.0180",
        size="0.0940 0.0185 0.0110",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="kpl_pedestal_column_col",
        type="box",
        pos="0.0030 0.1235 0.0725",
        size="0.0975 0.0760 0.0655",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="kpl_pedestal_neck_col",
        type="box",
        pos="0.0050 0.1180 0.1650",
        size="0.0975 0.0665 0.0280",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="kpl_cord_relief_col",
        type="cylinder",
        pos="0.0480 0.2075 0.0260",
        quat=Y_AXIS_QUAT,
        size="0.0090 0.0085",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="kpl_bowl_seat_site",
        pos="0 -0.0800 0.0120",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="kpl_seat_touch_site",
        type="cylinder",
        pos="0 -0.0800 0.0120",
        size="0.0920 0.0025",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Tilt-back motor head housing (`kpl_head_tilt`, axis="-1 0 0", range 0 .. 0.68 rad -> lifts top to 0.5200 m)
    ET.SubElement(
        head,
        "joint",
        name="kpl_head_tilt",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="0 0.68",
        damping="3.2",
        armature="0.018",
        frictionloss="8.0",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        head,
        "geom",
        name="kpl_head_housing_col",
        type="box",
        pos="0.0005 -0.1475 0.1133",
        size="0.0935 0.1985 0.0520",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_WALL_RGBA,
    )
    ET.SubElement(
        head,
        "geom",
        name="kpl_head_skirt_col",
        type="box",
        pos="0.0005 -0.0240 0.0320",
        size="0.0935 0.0748 0.0305",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_WALL_RGBA,
    )
    # Sites tracking closed vs tilted envelope datums (front-top stainless edge and rear-top cap)
    ET.SubElement(
        head,
        "site",
        name="kpl_head_top_front_site",
        pos="0 -0.3288 0.1653",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        head,
        "site",
        name="kpl_head_rear_top_site",
        pos="0 0.0512 0.1613",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Orbital planetary carrier (`kpl_orbit_spin`, child of `kpl_head`, continuous unlimited rotation about +Z)
    ET.SubElement(
        planetary,
        "joint",
        name="kpl_orbit_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.004",
        armature="0.0015",
    )
    ET.SubElement(
        planetary,
        "geom",
        name="kpl_planetary_disc_col",
        type="cylinder",
        pos="0 0 -0.0020",
        size="0.0550 0.0045",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Eccentric counter-rotating 12-wire balloon whip (`kpl_whip_spin`, child of `kpl_planetary`, continuous unlimited about -Z)
    # Active collision (contype=1, conaffinity=1, un-excluded from kpl_bowl) genuinely tests physical whip-to-bowl clearance!
    ET.SubElement(
        whip,
        "joint",
        name="kpl_whip_spin",
        type="hinge",
        axis="0 0 -1",
        limited="false",
        damping="0.002",
        armature="0.0006",
    )
    ET.SubElement(
        whip,
        "geom",
        name="kpl_whip_collar_col",
        type="cylinder",
        pos="0 0 -0.0200",
        size="0.0240 0.0200",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        whip,
        "geom",
        name="kpl_whip_cage_col",
        type="ellipsoid",
        pos="0 0 -0.0900",
        size="0.0550 0.0550 0.0645",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        whip,
        "site",
        name="kpl_whip_tip_site",
        pos="0 0 -0.1500",
        size="0.005",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # Stepless rotary speed + pulse knob (`kpl_dial_turn`, child of `kpl_head`, axis="1 0 0", range 0 .. 4.71 rad)
    ET.SubElement(
        dial,
        "joint",
        name="kpl_dial_turn",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 4.71",
        damping="0.35",
        armature="0.0020",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        dial,
        "geom",
        name="kpl_dial_col",
        type="cylinder",
        pos="0.0117 0 0",
        quat=X_AXIS_QUAT,
        size="0.0222 0.0115",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Hinged stainless wire safety finger guard (`kpl_guard_hinge`, child of `kpl_head`, axis="1 0 0", range 0 .. 0.35 rad)
    # Open 12-sector wire ring preserves central opening while covering visual wire guard above bowl rim
    ET.SubElement(
        guard,
        "joint",
        name="kpl_guard_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.35",
        damping="0.12",
        armature="0.0005",
        frictionloss="0.30",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        guard,
        "geom",
        name="kpl_guard_col",
        type="box",
        pos="0 0 0.0020",
        size="0.0310 0.0090 0.0036",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    n_guard = 12
    r_guard = 0.1005
    for g_idx in range(n_guard):
        ang = g_idx * math.tau / n_guard
        gx = r_guard * math.cos(ang)
        gy = -0.0950 + r_guard * math.sin(ang)
        ET.SubElement(
            guard,
            "geom",
            name=f"kpl_guard_ring_{g_idx:02d}_col",
            type="box",
            pos=numbers((gx, gy, 0.0009)),
            quat=numbers(z_rot_quat(ang)),
            size="0.0104 0.0300 0.0046",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )

    # 6-DOF removable 6.7 L stainless mixing bowl (`kpl_bowl`, 1.100 kg, hollow two-tier 16-sector flared wall + floor resting on Z = 0.0120 m)
    ET.SubElement(bowl, "freejoint", name="kpl_bowl_free")
    ET.SubElement(
        bowl,
        "geom",
        name="kpl_bowl_floor_col",
        type="cylinder",
        pos="0 0 0.0035",
        size="0.0900 0.0035",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    n_sectors = 16
    bowl_tiers = (
        ("lo", 0.0875, 0.0065, 0.1070, 0.1025, 0.0205),
        ("hi", 0.1068, 0.1005, 0.1174, 0.2266, 0.0245),
    )
    for tier_lbl, r_bot, z_bot, r_top, z_top, half_tan in bowl_tiers:
        wall_tilt = math.atan2(r_top - r_bot, z_top - z_bot)
        r_mid = 0.5 * (r_bot + r_top)
        z_mid = 0.5 * (z_bot + z_top)
        wall_half_h = 0.5 * math.hypot(r_top - r_bot, z_top - z_bot)
        q_tilt = (math.cos(wall_tilt / 2.0), 0.0, math.sin(wall_tilt / 2.0), 0.0)
        for s_idx in range(n_sectors):
            ang = s_idx * math.tau / n_sectors
            q_stave = quat_mul(z_rot_quat(ang), q_tilt)
            ET.SubElement(
                bowl,
                "geom",
                name=f"kpl_bowl_wall_{tier_lbl}_{s_idx:02d}_col",
                type="box",
                pos=numbers((r_mid * math.cos(ang), r_mid * math.sin(ang), z_mid)),
                quat=numbers(q_stave),
                size=numbers((0.0024, half_tan, wall_half_h)),
                contype="1",
                conaffinity="1",
                group="3",
                rgba=COL_ACCESSORY_RGBA,
            )
    ET.SubElement(
        bowl,
        "site",
        name="vessel_socket",
        pos="0 -0.1180 0.2220",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    payload = ET.SubElement(bowl, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0450",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.0450",
        size="0.0920 0.0030",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.96 0.94 0.88 0",
        mass="0",
    )

    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_base_head", "kpl_base", "kpl_head"),
            ("exclude_head_planetary", "kpl_head", "kpl_planetary"),
            ("exclude_head_whip", "kpl_head", "kpl_whip"),
            ("exclude_head_dial", "kpl_head", "kpl_speed_dial"),
            ("exclude_head_guard", "kpl_head", "kpl_finger_guard"),
            ("exclude_planetary_whip", "kpl_planetary", "kpl_whip"),
            ("exclude_planetary_guard", "kpl_planetary", "kpl_finger_guard"),
            ("exclude_whip_guard", "kpl_whip", "kpl_finger_guard"),
            ("exclude_base_guard", "kpl_base", "kpl_finger_guard"),
        ),
    )

    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="kpl_head_tilt_actuator",
        joint="kpl_head_tilt",
        kp="2000",
        kv="60.0",
        ctrlrange="0 0.68",
        forcerange="-150 150",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="kpl_orbit_actuator",
        joint="kpl_orbit_spin",
        kv="2.80",
        ctrlrange="-30 30",
        forcerange="-20 20",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="kpl_whip_actuator",
        joint="kpl_whip_spin",
        kv="0.25",
        ctrlrange="-85 85",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kpl_dial_actuator",
        joint="kpl_dial_turn",
        kp="18",
        kv="0.25",
        ctrlrange="0 4.71",
        forcerange="-100 100",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kpl_guard_actuator",
        joint="kpl_guard_hinge",
        kp="35",
        kv="1.20",
        ctrlrange="0 0.35",
        forcerange="-25 25",
    )

    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="kpl_head_tilt_pos", joint="kpl_head_tilt")
    ET.SubElement(sensors, "jointpos", name="kpl_orbit_pos", joint="kpl_orbit_spin")
    ET.SubElement(sensors, "jointvel", name="kpl_orbit_vel", joint="kpl_orbit_spin")
    ET.SubElement(sensors, "jointpos", name="kpl_whip_pos", joint="kpl_whip_spin")
    ET.SubElement(sensors, "jointvel", name="kpl_whip_vel", joint="kpl_whip_spin")
    ET.SubElement(sensors, "jointpos", name="kpl_dial_pos", joint="kpl_dial_turn")
    ET.SubElement(sensors, "jointpos", name="kpl_guard_pos", joint="kpl_guard_hinge")
    ET.SubElement(sensors, "touch", name="kpl_seat_touch", site="kpl_seat_touch_site")
    ET.SubElement(sensors, "framepos", name="kpl_head_top_pos", objtype="site", objname="kpl_head_top_front_site")
    ET.SubElement(sensors, "framepos", name="kpl_head_rear_pos", objtype="site", objname="kpl_head_rear_top_site")
    ET.SubElement(sensors, "framepos", name="kpl_whip_tip_pos", objtype="site", objname="kpl_whip_tip_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="kpl_bowl_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="kpl_bowl_seat_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="kpl_base",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("kpl_bowl_sense",),
        accessories=(("bowl_model.xml", "kpl_bowl", bowl),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_total_mass_kg": 8.60,
                "mixer_assembly_mass_kg": 7.50,
                "bowl_mass_kg": 1.10,
                "component_masses_kg": MASSES,
                "bowl_capacity_l": 6.7,
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
                "whip_speed_range_rpm": [150, 676],
                "planetary_gear_ratio": PLANETARY_RATIO,
                "closed_envelope_m": [0.240, 0.400, 0.350],
                "lifted_envelope_m": [0.240, 0.490, 0.520],
                "scope": "Articulated MuJoCo 4.0 Filament PBR planetary carrier + counter-rotating 12-wire whip, stepless speed + pulse dial, head-lift 520 mm safety interlock, wire finger guard, and 6-DOF 6.7 L bowl model.",
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_xml(mujoco, np) -> None:
    kit_export_native_xml(ASSETS, "aicohsha-kpl9000s", mujoco, np)


def verify_frames_and_motions(mujoco, evidence_dir: Path) -> tuple[dict, dict]:
    return kit_verify_frames_and_motions(
        ASSETS, "aicohsha-kpl9000s", NAMES, VISUAL_MOTIONS, mujoco, evidence_dir
    )


def write_package_docs(summary: dict) -> None:
    readme = f"""# Aicohsha Kenmix Aicoh Chef PRO KPL9000S (`aicohsha-kpl9000s`)

Articulated Blender 5.2 + MuJoCo 4.0 Filament PBR visual, mechanical, planetary-whip, and head-lift safety-interlock asset package for the **Aicohsha Kenmix Aicoh Chef PRO KPL9000S** (`愛工舎製作所 ケンミックス アイコー シェフPRO`) `6.7 L` tabletop planetary mixer.

## Key Specifications

| Parameter | Value |
| --- | --- |
| Closed operating envelope (`W × D × H`) | `0.240 × 0.400 × 0.350 m` (`240 × 400 × 350 mm`) |
| Lifted tilt-head envelope (`0.68 rad`) | `0.240 × 0.490 × 0.520 m` (`240 × 490 × 520 mm`) |
| Published mass | `8.600 kg` total (`7.500 kg` mixer assembly + `1.100 kg` `6.7 L` SUS304 bowl) |
| Electrical supply | Single-phase `100 V AC`, `50/60 Hz`, `500 W` (`15 min` continuous duty) |
| Stepless whip speed range | `150 – 676 rpm` (`125 rpm` creep threshold + momentary `P` pulse detent; `3.50 : 1` whip-to-orbit planetary ratio) |
| Safety protection | Head-lift auto-stop microswitch interlock (`ヘッドリフト安全装置`) + hinged stainless wire finger guard (`フィンガーガード`) |

## Retained Bodies & Joints (`appliance.xml` / `scene.xml` / `model.xml` / `bowl_model.xml` / `native.xml`)

- `kpl_base` (`3.150 kg`) — die-cast L-pedestal base, 5 rubber feet touching `Z = 0.000 m`, recessed stainless bayonet seat (`Z = 0.0120 m`) with 3 locking lugs, circular front apron collar, rear column & hinge clevis.
- `kpl_head` (`3.420 kg`) — `hinge` `kpl_head_tilt` (`axis="-1 0 0"`, `range="0 .. 0.68"` rad at `(0.0, +0.1488, +0.1847) m`), lifting the top-front stainless edge to `0.5200 m` and tilting the rear cap to `+0.2900 m` (`0.4900 m` depth).
- `kpl_planetary` (`0.380 kg`, child of `kpl_head`) — `hinge` `kpl_orbit_spin` (`axis="0 0 1"`, continuous `limited="false"`).
- `kpl_whip` (`0.280 kg`, child of `kpl_planetary`) — `hinge` `kpl_whip_spin` (`axis="0 0 -1"`, continuous `limited="false"`), eccentric (`26 mm`) 12-wire SUS304 balloon whip (`ホイッパー`) counter-rotating at `3.50 ×` orbital speed.
- `kpl_speed_dial` (`0.060 kg`, child of `kpl_head`) — `hinge` `kpl_dial_turn` (`axis="1 0 0"`, `range="0 .. 4.71"` rad), right-side stepless rotary speed & pulse knob.
- `kpl_finger_guard` (`0.210 kg`, child of `kpl_head`) — `hinge` `kpl_guard_hinge` (`axis="1 0 0"`, `range="0 .. 0.35"` rad), stainless wire finger guard ring.
- `kpl_bowl` (`1.100 kg`) — 6-DOF `freejoint` `kpl_bowl_free` `6.7 L` flared stainless bowl (`Ø240 mm` rolled rim, `180 mm` height) with `site name="vessel_socket"` and `body name="ingredient_payload"`.

## Regenerating & Verifying

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_kpl9000s_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_kpl9000s_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme)

    active_md = """# Aicohsha Kenmix KPL9000S Active States

Verified at `dt = 0.002 s` (`integrator="implicitfast"`) across five operational stages:

1. **`standby_bowl_seated`** — Head closed (`0.0 rad`, `Z_top = 0.3500 m`), dial at `OFF` (`0.0 rad`), `6.7 L` (`1.100 kg`) SUS304 bowl seated stably on bayonet pad (`10.791 N` touch force), `0 rpm`, `0 W`, zero whip-to-bowl contacts.
2. **`stepless_speed_ramp_150_to_676rpm_500w`** — Stepless rotary dial turns from `MIN` (`150 rpm`) to `MAX` (`4.50 rad`, `676 rpm` whip spin around `-Z` + `193.1 rpm` planetary carrier orbit around `+Z`), drawing `500.0 W` (`5.00 A` at `100 V AC`) with zero whip-to-bowl contacts.
3. **`head_lift_520mm_safety_interlock`** — While dial remains at `MAX`, `kpl_head` tilts back `0.68 rad` (`38.96°`) to `Z_top = 0.5200 m` (`D_open = 0.4900 m`) and `kpl_finger_guard` opens `0.22 rad`; the head-lift safety interlock (`ヘッドリフト安全装置`) trips at `> 0.025 rad`, immediately cutting motor power (`0 W`) and braking both shafts to `0 rpm` while clearing the bowl rim without contact.
4. **`head_lower_and_pulse_detent`** — Head lowers back to `0.0 rad`, dial resets to `OFF` to clear the interlock latch, then actuates the momentary `P` pulse detent (`0.55 rad`, `320 rpm` burst) before returning to `OFF`.
5. **`rest_pose_and_frame_motion_alignment`** — Returns to closed rest pose and verifies both rest-frame parity (`7` bodies) and 21-sample scalar-joint motion trajectories (`5` joints including 3-level nested `kpl_whip` on `kpl_planetary` on `kpl_head`) via `inspect_appliance_frames.mjs`.
"""
    (ASSETS / "active-states.md").write_text(active_md)

    (ASSETS / "active-states.json").write_text(
        json.dumps(
            {
                "appliance": "aicohsha-kpl9000s",
                "supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
                "whip_speed_range_rpm": [150, 676],
                "planetary_ratio": PLANETARY_RATIO,
                "userdata_channels": [
                    "0: motor_power_w",
                    "1: line_current_a",
                    "2: whip_speed_rpm",
                    "3: orbit_speed_rpm",
                    "4: interlock_tripped_flag",
                    "5: head_top_z_m",
                    "6: whip_bowl_contact_count",
                    "7: duty_elapsed_s",
                ],
                "stages": list(summary["stages"].keys()),
            },
            indent=2,
        )
        + "\n"
    )


def run_verification() -> dict:
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

    import mujoco
    import numpy as np

    export_and_verify_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    mixer_mass = sum(float(model.body_mass[model.body(n).id]) for n in NAMES if n != "kpl_bowl")
    bowl_mass = float(model.body_mass[model.body("kpl_bowl").id])
    total_mass = float(np.sum(model.body_mass))
    if abs(mixer_mass - 7.500) > 1e-4 or abs(bowl_mass - 1.100) > 1e-4 or abs(total_mass - 8.600) > 1e-4:
        raise RuntimeError(f"Mass mismatch: mixer={mixer_mass:.4f}, bowl={bowl_mass:.4f}, total={total_mass:.4f}")

    whip_body_id = model.body("kpl_whip").id
    bowl_body_id = model.body("kpl_bowl").id

    act_head = model.actuator("kpl_head_tilt_actuator").id
    act_orbit = model.actuator("kpl_orbit_actuator").id
    act_whip = model.actuator("kpl_whip_actuator").id
    act_dial = model.actuator("kpl_dial_actuator").id
    act_guard = model.actuator("kpl_guard_actuator").id

    # Velocity feedforward compensation for passive joint damping (kv * (ctrl - qvel) = damping * qvel)
    orbit_ff = (2.80 + 0.004) / 2.80
    whip_ff = (0.25 + 0.002) / 0.25

    state = {
        "mode": "standby",
        "interlock_latched": False,
        "motor_power_w": 0.0,
        "line_current_a": 0.0,
        "duty_elapsed_s": 0.0,
        "cumulative_whip_bowl_contacts": 0,
    }

    trace_rows: list[dict] = []
    stage_summaries: dict[str, dict] = {}

    def dial_target_whip_rpm(dial_rad: float) -> float:
        if dial_rad < 0.35:
            return 0.0
        if dial_rad < 0.72:
            return 320.0  # P (pulse) momentary burst detent
        frac = min(1.0, max(0.0, (dial_rad - 0.80) / (4.48 - 0.80)))
        return 150.0 + frac * (676.0 - 150.0)

    def count_whip_bowl_contacts() -> int:
        hits = 0
        for c_idx in range(data.ncon):
            con = data.contact[c_idx]
            b1 = int(model.geom_bodyid[con.geom1])
            b2 = int(model.geom_bodyid[con.geom2])
            if (b1 == whip_body_id and b2 == bowl_body_id) or (b2 == whip_body_id and b1 == bowl_body_id):
                hits += 1
        return hits

    def control_step() -> None:
        dt = model.opt.timestep
        head_rad = float(data.sensor("kpl_head_tilt_pos").data[0])
        dial_rad = float(data.sensor("kpl_dial_pos").data[0])

        # Head-lift safety microswitch (`ヘッドリフト安全装置`): trips immediately if head lifts > 0.025 rad,
        # and stays latched until head is closed (<= 0.015 rad) AND dial is returned to OFF (< 0.20 rad).
        if head_rad > 0.025:
            state["interlock_latched"] = True
        elif head_rad <= 0.015 and dial_rad < 0.20:
            state["interlock_latched"] = False

        cmd_rpm = 0.0 if state["interlock_latched"] else dial_target_whip_rpm(dial_rad)
        if cmd_rpm > 0.0:
            whip_rad_s = cmd_rpm * math.tau / 60.0
            orbit_rad_s = whip_rad_s / PLANETARY_RATIO
            data.ctrl[act_whip] = whip_rad_s * whip_ff
            data.ctrl[act_orbit] = orbit_rad_s * orbit_ff
            # Electrical load curve up to rated 500 W at 676 rpm on single-phase 100 V AC
            load_frac = cmd_rpm / 676.0
            power_w = min(500.0, 95.0 + 405.0 * (load_frac ** 1.15))
            state["duty_elapsed_s"] += dt
        else:
            data.ctrl[act_whip] = 0.0
            data.ctrl[act_orbit] = 0.0
            power_w = 0.0

        state["motor_power_w"] = round(power_w, 2)
        state["line_current_a"] = round(power_w / 100.0, 3)

        whip_vel = float(data.sensor("kpl_whip_vel").data[0])
        orbit_vel = float(data.sensor("kpl_orbit_vel").data[0])
        top_z = float(data.sensor("kpl_head_top_pos").data[2])
        wb_hits = count_whip_bowl_contacts()
        state["cumulative_whip_bowl_contacts"] += wb_hits

        data.userdata[0] = state["motor_power_w"]
        data.userdata[1] = state["line_current_a"]
        data.userdata[2] = whip_vel * 60.0 / math.tau
        data.userdata[3] = orbit_vel * 60.0 / math.tau
        data.userdata[4] = 1.0 if state["interlock_latched"] else 0.0
        data.userdata[5] = top_z
        data.userdata[6] = float(wb_hits)
        data.userdata[7] = state["duty_elapsed_s"]

    def snapshot() -> dict:
        head_rad = float(data.sensor("kpl_head_tilt_pos").data[0])
        dial_rad = float(data.sensor("kpl_dial_pos").data[0])
        guard_rad = float(data.sensor("kpl_guard_pos").data[0])
        whip_vel = float(data.sensor("kpl_whip_vel").data[0])
        orbit_vel = float(data.sensor("kpl_orbit_vel").data[0])
        seat_touch = float(data.sensor("kpl_seat_touch").data[0])
        top_pos = data.sensor("kpl_head_top_pos").data
        rear_pos = data.sensor("kpl_head_rear_pos").data
        whip_tip = data.sensor("kpl_whip_tip_pos").data
        bowl_rel = data.sensor("kpl_bowl_sense").data
        return {
            "time_s": round(float(data.time), 4),
            "mode": state["mode"],
            "motor_power_w": state["motor_power_w"],
            "line_current_a": state["line_current_a"],
            "whip_rpm": round(whip_vel * 60.0 / math.tau, 2),
            "orbit_rpm": round(orbit_vel * 60.0 / math.tau, 2),
            "interlock_tripped": state["interlock_latched"],
            "head_tilt_deg": round(math.degrees(head_rad), 2),
            "dial_angle_rad": round(dial_rad, 3),
            "guard_angle_deg": round(math.degrees(guard_rad), 2),
            "head_top_z_m": round(float(top_pos[2]), 4),
            "head_rear_y_m": round(float(rear_pos[1]), 4),
            "whip_tip_z_m": round(float(whip_tip[2]), 4),
            "seat_touch_n": round(seat_touch, 3),
            "bowl_socket_rel_y_m": round(float(bowl_rel[1]), 4),
            "bowl_socket_rel_z_m": round(float(bowl_rel[2]), 4),
            "whip_bowl_contacts": state["cumulative_whip_bowl_contacts"],
        }

    def step_and_sample(duration_s: float) -> dict:
        steps = max(1, round(duration_s / model.opt.timestep))
        last = {}
        for idx in range(steps):
            control_step()
            mujoco.mj_step(model, data)
            if (idx + 1) % 20 == 0 or idx == steps - 1:
                last = snapshot()
                trace_rows.append(last)
        return last

    # Stage 1: Standby with 6.7 L (1.100 kg) stainless bowl seated in bayonet recess
    state["mode"] = "standby"
    snap1 = step_and_sample(0.40)
    assert snap1["motor_power_w"] == 0.0, snap1
    assert abs(snap1["whip_rpm"]) < 0.05, snap1
    assert abs(snap1["head_top_z_m"] - 0.3500) < 0.001, snap1
    assert 10.3 <= snap1["seat_touch_n"] <= 11.3, snap1
    assert snap1["whip_bowl_contacts"] == 0, snap1
    stage_summaries["standby_bowl_seated"] = snap1

    # Stage 2: Stepless rotary speed ramp (150 rpm MIN -> 676 rpm MAX, 500 W at 100 V AC, counter-rotating planetary whip)
    state["mode"] = "speed_min_150rpm"
    data.ctrl[act_dial] = 0.78
    snap2_min = step_and_sample(0.48)
    assert 145.0 <= snap2_min["whip_rpm"] <= 156.0, snap2_min
    assert 41.0 <= snap2_min["orbit_rpm"] <= 45.0, snap2_min
    assert snap2_min["whip_bowl_contacts"] == 0, snap2_min

    state["mode"] = "speed_max_676rpm"
    data.ctrl[act_dial] = 4.52
    snap2_max = step_and_sample(0.64)
    assert 670.0 <= snap2_max["whip_rpm"] <= 680.0, snap2_max
    assert 191.0 <= snap2_max["orbit_rpm"] <= 195.0, snap2_max
    assert abs(snap2_max["motor_power_w"] - 500.0) < 1.0, snap2_max
    assert snap2_max["seat_touch_n"] > 10.2, snap2_max
    assert snap2_max["whip_bowl_contacts"] == 0, snap2_max
    stage_summaries["stepless_speed_ramp_150_to_676rpm_500w"] = {
        "min_speed_snap": snap2_min,
        "max_speed_snap": snap2_max,
    }

    # Stage 3: Head-lift tilt to 520 mm height while dial remains at MAX -> immediate safety interlock (0 rpm, 0 W)
    state["mode"] = "head_lift_interlock"
    data.ctrl[act_head] = 0.68
    data.ctrl[act_guard] = 0.22
    snap3 = step_and_sample(0.72)
    assert snap3["interlock_tripped"] is True, snap3
    assert snap3["motor_power_w"] == 0.0, snap3
    assert abs(snap3["whip_rpm"]) < 0.2, snap3
    assert abs(snap3["orbit_rpm"]) < 0.2, snap3
    assert 0.5180 <= snap3["head_top_z_m"] <= 0.5215, snap3
    assert 0.2885 <= snap3["head_rear_y_m"] <= 0.2915, snap3
    assert snap3["whip_tip_z_m"] > 0.198, snap3
    assert snap3["whip_bowl_contacts"] == 0, snap3
    stage_summaries["head_lift_520mm_safety_interlock"] = snap3

    # Stage 4: Lower head, reset dial to clear interlock latch, then actuate momentary P pulse detent
    state["mode"] = "head_lower_and_reset"
    data.ctrl[act_guard] = 0.0
    data.ctrl[act_dial] = 0.0
    data.ctrl[act_head] = 0.0
    snap4_reset = step_and_sample(0.72)
    assert snap4_reset["interlock_tripped"] is False, snap4_reset
    assert abs(snap4_reset["head_top_z_m"] - 0.3500) < 0.0015, snap4_reset

    state["mode"] = "pulse_detent"
    data.ctrl[act_dial] = 0.55
    snap4_pulse = step_and_sample(0.44)
    assert 312.0 <= snap4_pulse["whip_rpm"] <= 325.0, snap4_pulse
    assert snap4_pulse["motor_power_w"] > 180.0, snap4_pulse
    assert snap4_pulse["whip_bowl_contacts"] == 0, snap4_pulse
    stage_summaries["head_lower_and_pulse_detent"] = {
        "reset_snap": snap4_reset,
        "pulse_snap": snap4_pulse,
    }

    # Stage 5: Return to closed rest pose & verify GLB rest frames + 21-sample --motion trajectories
    state["mode"] = "rest"
    data.ctrl[act_dial] = 0.0
    data.ctrl[act_head] = 0.0
    data.ctrl[act_guard] = 0.0
    snap5 = step_and_sample(0.56)
    assert snap5["motor_power_w"] == 0.0, snap5
    assert abs(snap5["whip_rpm"]) < 0.1, snap5
    assert 10.3 <= snap5["seat_touch_n"] <= 11.3, snap5
    assert snap5["whip_bowl_contacts"] == 0, snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)

    stage_summaries["rest_pose_and_frame_motion_alignment"] = {
        "rest_snap": snap5,
        "frames_aligned": len(frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]),
        "rest_max_pos_err_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]
        ),
        "rest_max_rot_err_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]
        ),
        "motion_joints_verified": len(motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]),
        "motion_max_pos_err_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]
        ),
        "motion_max_rot_err_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]
        ),
    }

    trace_csv = evidence_dir / "trace.csv"
    with trace_csv.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(trace_rows[0].keys()))
        writer.writeheader()
        writer.writerows(trace_rows)

    summary = {
        "status": "passed",
        "appliance": "aicohsha-kpl9000s",
        "model_title": "Aicohsha Kenmix Aicoh Chef PRO KPL9000S Planetary Mixer",
        "supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
        "closed_envelope_m": [0.240, 0.400, 0.350],
        "lifted_envelope_m": [0.240, 0.490, 0.520],
        "mixer_mass_kg": 7.500,
        "bowl_mass_kg": 1.100,
        "total_mass_kg": 8.600,
        "bowl_capacity_l": 6.7,
        "whip_speed_range_rpm": [150, 676],
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_csv.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "aicohsha-kpl9000s.glb").read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(summary, indent=2) + "\n")
    write_package_docs(summary)
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    if "--blender-export" in sys.argv:
        export_blender_meshes_and_xml()
    else:
        run_verification()
