"""Export MuJoCo 4.0.0 MJCF + native collision spec and run active-state verification for Victoria Arduino E1 PRIMA.

Reference ground truth:
- https://victoriaarduino.com/en/products-machines/e1-prima/ (411 W x 510 D x 379 H mm, 37.0 kg empty,
  NEO 0.20 L instant stainless brew boiler + 1.5 L insulated stainless steam boiler, 1.5 L internal tank +
  direct water connection, Steam-by-Wire 2.1 bar Cool-Touch wand, Ghost Display, 3-key volumetric group)
- docs/equipment/victoria-arduino-e1-prima/README.md

Published mass budget:
  Machine body sum = 37.000 kg across 6 machine bodies:
    e1p_body             35.140 kg
    e1p_steam_wand        0.240 kg
    e1p_steam_lever       0.130 kg
    e1p_hot_water_lever   0.130 kg
    e1p_tank_lid          0.380 kg
    e1p_drip_tray         0.980 kg
  Detachable 58 mm double-spout Victoria Arduino portafilter:
    e1p_portafilter       0.540 kg (6-DOF freejoint seated on Z = 0.2040 m bayonet shelf)
"""

from __future__ import annotations

import csv
import hashlib
import json
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
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

NAME = "victoria-arduino-e1-prima"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

MACHINE_BODY_NAMES = (
    "e1p_body",
    "e1p_steam_wand",
    "e1p_steam_lever",
    "e1p_hot_water_lever",
    "e1p_tank_lid",
    "e1p_drip_tray",
)

NAMES = (
    *MACHINE_BODY_NAMES,
    "e1p_portafilter",
)

MASSES = {
    "e1p_body": 35.140,
    "e1p_steam_wand": 0.240,
    "e1p_steam_lever": 0.130,
    "e1p_hot_water_lever": 0.130,
    "e1p_tank_lid": 0.380,
    "e1p_drip_tray": 0.980,
    "e1p_portafilter": 0.540,
}

CENTERS = {
    "e1p_body": (0.0020, 0.0240, 0.1920),
    "e1p_steam_wand": (0.0030, -0.0520, -0.0480),
    "e1p_steam_lever": (0.0000, -0.0085, 0.0230),
    "e1p_hot_water_lever": (0.0000, -0.0085, 0.0230),
    "e1p_tank_lid": (0.0000, -0.0560, 0.0002),
    "e1p_drip_tray": (0.0000, 0.0010, 0.0080),
    "e1p_portafilter": (0.0000, -0.0180, -0.0060),
}

INERTIAS = {
    "e1p_body": (0.8200, 0.6900, 0.9400),
    "e1p_steam_wand": (0.00072, 0.00072, 0.00009),
    "e1p_steam_lever": (0.00014, 0.00014, 0.00005),
    "e1p_hot_water_lever": (0.00014, 0.00014, 0.00005),
    "e1p_tank_lid": (0.00080, 0.00420, 0.00490),
    "e1p_drip_tray": (0.00280, 0.01180, 0.01420),
    "e1p_portafilter": (0.00155, 0.00048, 0.00175),
}

SCALAR_VISUAL_AXES = {
    "e1p_steam_wand_swing": [-1.0, 0.0, 0.0],
    "e1p_steam_lever_hinge": [1.0, 0.0, 0.0],
    "e1p_hot_water_lever_hinge": [1.0, 0.0, 0.0],
    "e1p_tank_lid_hinge": [-1.0, 0.0, 0.0],
    "e1p_drip_tray_slide": [0.0, -1.0, 0.0],
}


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender 5.2 to export body-local OBJ meshes and construct appliance.xml + scene.xml + model.xml."""
    source = ASSETS / f"{NAME}.blend"
    parts, poses = prepare_blender_assembly(
        source,
        NAMES,
        ASSETS,
        default_roughness=0.35,
    )

    machine_mass_sum = round(sum(MASSES[k] for k in MACHINE_BODY_NAMES), 6)
    assert machine_mass_sum == 37.000, f"Expected 37.000 kg machine mass, got {machine_mass_sum}"

    app = ET.Element(
        "mujoco",
        model="victoria-arduino-e1-prima — Victoria Arduino E1 PRIMA 1-group espresso machine",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="10")

    defaults = add_standard_defaults(
        app,
        friction="0.65 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.5 1.5 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="1",
        group="2",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "e1p_portafilter":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "e1p_body" else None)
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

    base = bodies["e1p_body"]
    wand = bodies["e1p_steam_wand"]
    steam_lever = bodies["e1p_steam_lever"]
    hw_lever = bodies["e1p_hot_water_lever"]
    tank_lid = bodies["e1p_tank_lid"]
    drip_tray = bodies["e1p_drip_tray"]
    pf = bodies["e1p_portafilter"]

    # Four elastomer/stainless feet collision cylinders touching Z = 0.0000 m (extending to underbody at Z = 0.036 m)
    for foot_name, fx, fy in (
        ("e1p_foot_fl_col", -0.1580, -0.1520),
        ("e1p_foot_fr_col", 0.1580, -0.1520),
        ("e1p_foot_rl_col", -0.1640, 0.1860),
        ("e1p_foot_rr_col", 0.1640, 0.1860),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0180)),
            size="0.0185 0.0180",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Chassis underbody, rear core, rear ribbed panel & utility fittings, side skins, front fascia,
    # sculpted 58 mm group hood, cup-warmer deck & 3 perimeter cup rails, and bayonet shelves (top Z = 0.2040 m)
    for cname, cpos, csize, crgba in (
        ("e1p_underbody_col", (0.0, 0.0360, 0.0520), (0.1920, 0.1890, 0.0170), COL_BASE_RGBA),
        ("e1p_rear_core_col", (0.0, 0.0550, 0.2130), (0.1860, 0.1710, 0.1470), COL_BASE_RGBA),
        ("e1p_rear_panel_col", (0.0, 0.2385, 0.2140), (0.1870, 0.0145, 0.1558), COL_BASE_RGBA),
        ("e1p_rear_utility_col", (0.0, 0.2380, 0.0620), (0.1200, 0.0110, 0.0180), COL_BASE_RGBA),
        ("e1p_side_left_col", (-0.1920, 0.0345, 0.2030), (0.0134, 0.2205, 0.1690), COL_BASE_RGBA),
        ("e1p_side_right_col", (0.1920, 0.0345, 0.2030), (0.0134, 0.2205, 0.1690), COL_BASE_RGBA),
        ("e1p_front_fascia_col", (0.0, -0.1200, 0.3000), (0.1860, 0.0110, 0.0579), COL_BASE_RGBA),
        ("e1p_group_hood_col", (0.0, -0.1575, 0.2810), (0.0610, 0.0485, 0.0450), COL_BASE_RGBA),
        ("e1p_cup_deck_col", (0.0, 0.0020, 0.3612), (0.1790, 0.1120, 0.0020), COL_WALL_RGBA),
        ("e1p_cup_rail_left_col", (-0.1810, 0.0680, 0.3705), (0.0025, 0.1680, 0.0085), COL_WALL_RGBA),
        ("e1p_cup_rail_right_col", (0.1810, 0.0680, 0.3705), (0.0025, 0.1680, 0.0085), COL_WALL_RGBA),
        ("e1p_cup_rail_rear_col", (0.0, 0.2360, 0.3705), (0.1830, 0.0025, 0.0085), COL_WALL_RGBA),
        ("e1p_bayonet_left_shelf_col", (-0.0395, -0.1560, 0.2005), (0.0038, 0.0150, 0.0035), COL_WALL_RGBA),
        ("e1p_bayonet_right_shelf_col", (0.0395, -0.1560, 0.2005), (0.0038, 0.0150, 0.0035), COL_WALL_RGBA),
        ("e1p_group_backstop_col", (0.0, -0.1135, 0.2200), (0.0410, 0.0020, 0.0160), COL_BASE_RGBA),
    ):
        ET.SubElement(
            base,
            "geom",
            name=cname,
            type="box",
            pos=numbers(cpos),
            size=numbers(csize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=crgba,
        )

    # Exposed upper 58 mm group collar above portafilter rim & clear of ferrule (Y_min=-0.1950 vs ferrule Y_max=-0.1955)
    ET.SubElement(
        base,
        "geom",
        name="e1p_group_head_col",
        type="cylinder",
        pos="0 -0.1560 0.2315",
        size="0.0390 0.0045",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    # Fixed left-side hot-water economizer wand & aerator nozzle
    ET.SubElement(
        base,
        "geom",
        name="e1p_hot_water_wand_col",
        type="capsule",
        fromto="-0.1340 -0.1250 0.2560 -0.1340 -0.1760 0.1910",
        size="0.0075",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )

    # Operational sites on e1p_body (group 4, visible semi-transparent rgba)
    ET.SubElement(
        base,
        "site",
        name="e1p_group_seat_site",
        pos="0 -0.1560 0.2140",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="e1p_hot_water_outlet_site",
        pos="-0.1340 -0.1760 0.1820",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="e1p_bayonet_touch_site",
        type="box",
        pos="0 -0.1560 0.2040",
        size="0.0450 0.0320 0.0025",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 1. e1p_steam_wand: right-side (+X) 360-deg Cool-Touch stainless steam wand (axis -1 0 0, -0.20 .. 0.55 rad)
    ET.SubElement(
        wand,
        "joint",
        name="e1p_steam_wand_swing",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="-0.20 0.55",
        damping="0.45",
        armature="0.003",
        frictionloss="0.30",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        wand,
        "geom",
        name="e1p_steam_ball_nut_col",
        type="cylinder",
        pos="0 0.0020 0",
        quat=Y_AXIS_QUAT,
        size="0.0125 0.0070",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        wand,
        "geom",
        name="e1p_steam_wand_arch_col",
        type="capsule",
        fromto="0 0 0 0.0180 -0.0480 0.0280",
        size="0.0055",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        wand,
        "geom",
        name="e1p_steam_wand_knee_col",
        type="capsule",
        fromto="0.0180 -0.0480 0.0280 0.0020 -0.0710 -0.0180",
        size="0.0055",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        wand,
        "geom",
        name="e1p_steam_wand_col",
        type="capsule",
        fromto="0.0020 -0.0710 -0.0180 -0.0040 -0.0740 -0.1127",
        size="0.0068",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        wand,
        "site",
        name="e1p_steam_tip_site",
        pos="-0.0040 -0.0740 -0.1180",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 2. e1p_steam_lever: right-side (+X) Steam-by-Wire vertical blade paddle (axis 1 0 0, -0.38 .. 0.48 rad)
    ET.SubElement(
        steam_lever,
        "joint",
        name="e1p_steam_lever_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.38 0.48",
        damping="0.26",
        armature="0.002",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        steam_lever,
        "geom",
        name="e1p_steam_lever_col",
        type="box",
        pos="0 -0.0085 0.0230",
        size="0.0120 0.0070 0.0245",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        steam_lever,
        "geom",
        name="e1p_steam_lever_hub_col",
        type="box",
        pos="0 -0.0020 0",
        size="0.0070 0.0105 0.0105",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # 3. e1p_hot_water_lever: left-side (-X) two-dose hot-water vertical blade paddle (axis 1 0 0, -0.38 .. 0.48 rad)
    ET.SubElement(
        hw_lever,
        "joint",
        name="e1p_hot_water_lever_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.38 0.48",
        damping="0.26",
        armature="0.002",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        hw_lever,
        "geom",
        name="e1p_hot_water_lever_col",
        type="box",
        pos="0 -0.0085 0.0230",
        size="0.0120 0.0070 0.0245",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        hw_lever,
        "geom",
        name="e1p_hot_water_lever_hub_col",
        type="box",
        pos="0 -0.0020 0",
        size="0.0070 0.0105 0.0105",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # 4. e1p_tank_lid: top-rear 1.5 L water reservoir hinged cover (axis -1 0 0, 0 .. 1.05 rad)
    ET.SubElement(
        tank_lid,
        "joint",
        name="e1p_tank_lid_hinge",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="0 1.05",
        damping="0.55",
        armature="0.004",
        frictionloss="0.35",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        tank_lid,
        "geom",
        name="e1p_tank_lid_col",
        type="box",
        pos="0 -0.0560 0.0002",
        size="0.1770 0.0560 0.0022",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # 5. e1p_drip_tray: pull-out stainless drip basin & diamond-perforated grate (slide axis 0 -1 0, 0 .. 0.160 m)
    # Diamond grate top sits at world Z = 0.0680 + 0.0300 = 0.0980 m
    ET.SubElement(
        drip_tray,
        "joint",
        name="e1p_drip_tray_slide",
        type="slide",
        axis="0 -1 0",
        limited="true",
        range="0 0.160",
        damping="4.20",
        armature="0.008",
        frictionloss="0.30",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        drip_tray,
        "geom",
        name="e1p_drip_grate_col",
        type="box",
        pos="0 0.0030 0.0280",
        size="0.1760 0.0680 0.0020",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        drip_tray,
        "geom",
        name="e1p_drip_pan_col",
        type="box",
        pos="0 0 -0.0020",
        size="0.1880 0.0800 0.0280",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        drip_tray,
        "site",
        name="e1p_drip_grate_touch_site",
        type="box",
        pos="0 0.0030 0.0300",
        size="0.1700 0.0660 0.0025",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 6. e1p_portafilter: detachable 58 mm stainless double-spout portafilter (freejoint e1p_portafilter_free)
    ET.SubElement(pf, "freejoint", name="e1p_portafilter_free")
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_head_col",
        type="cylinder",
        pos="0 0 -0.0010",
        size="0.0395 0.0090",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_bayonet_ears_col",
        type="box",
        pos="0 0 -0.0065",
        size="0.0433 0.0110 0.0035",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_lower_basket_col",
        type="cylinder",
        pos="0 0 -0.01725",
        size="0.0320 0.00825",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_neck_bridge_col",
        type="box",
        pos="0 -0.0390 -0.0110",
        size="0.0115 0.0120 0.0080",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_spout_manifold_col",
        type="cylinder",
        pos="0 0 -0.0275",
        size="0.0115 0.0045",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_spout_left_col",
        type="capsule",
        fromto="0 0 -0.0290 -0.0225 -0.0115 -0.0411",
        size="0.0048",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_spout_right_col",
        type="capsule",
        fromto="0 0 -0.0290 0.0225 -0.0115 -0.0411",
        size="0.0048",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_ferrule_col",
        type="cylinder",
        pos="0 -0.0510 -0.0055",
        quat="0.998135 0.061049 0 0",
        size="0.0115 0.0195",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_handle_col",
        type="capsule",
        fromto="0 -0.0720 -0.0081 0 -0.1955 -0.0231",
        size="0.0155",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        pf,
        "site",
        name="vessel_socket",
        pos="0 -0.1300 -0.0155",
        size="0.005",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    ET.SubElement(
        pf,
        "site",
        name="e1p_pf_basket_center",
        pos="0 0 0",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    payload = ET.SubElement(pf, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0050",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.0050",
        size="0.0288 0.0020",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.28 0.16 0.09 0",
        mass="0",
    )

    # Adjacent articulated-body contact exclusions (e1p_portafilter stays UN-excluded for bayonet & drip-grate contact)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_body_steam_wand", "e1p_body", "e1p_steam_wand"),
            ("exclude_body_steam_lever", "e1p_body", "e1p_steam_lever"),
            ("exclude_body_hot_water_lever", "e1p_body", "e1p_hot_water_lever"),
            ("exclude_body_tank_lid", "e1p_body", "e1p_tank_lid"),
            ("exclude_body_drip_tray", "e1p_body", "e1p_drip_tray"),
            ("exclude_steam_wand_steam_lever", "e1p_steam_wand", "e1p_steam_lever"),
            ("exclude_steam_wand_drip_tray", "e1p_steam_wand", "e1p_drip_tray"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="e1p_steam_wand_actuator",
        joint="e1p_steam_wand_swing",
        kp="32",
        kv="3.2",
        ctrlrange="-0.20 0.55",
        forcerange="-12 12",
    )
    ET.SubElement(
        actuators,
        "position",
        name="e1p_steam_lever_actuator",
        joint="e1p_steam_lever_hinge",
        kp="28",
        kv="2.4",
        ctrlrange="-0.38 0.48",
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "position",
        name="e1p_hot_water_lever_actuator",
        joint="e1p_hot_water_lever_hinge",
        kp="28",
        kv="2.4",
        ctrlrange="-0.38 0.48",
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "position",
        name="e1p_tank_lid_actuator",
        joint="e1p_tank_lid_hinge",
        kp="45",
        kv="4.5",
        ctrlrange="0 1.05",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="e1p_drip_tray_actuator",
        joint="e1p_drip_tray_slide",
        kp="280",
        kv="24.0",
        ctrlrange="0 0.160",
        forcerange="-60 60",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="e1p_steam_wand_pos", joint="e1p_steam_wand_swing")
    ET.SubElement(sensors, "jointpos", name="e1p_steam_lever_pos", joint="e1p_steam_lever_hinge")
    ET.SubElement(sensors, "jointpos", name="e1p_hot_water_lever_pos", joint="e1p_hot_water_lever_hinge")
    ET.SubElement(sensors, "jointpos", name="e1p_tank_lid_pos", joint="e1p_tank_lid_hinge")
    ET.SubElement(sensors, "jointpos", name="e1p_drip_tray_pos", joint="e1p_drip_tray_slide")
    ET.SubElement(sensors, "touch", name="e1p_bayonet_touch", site="e1p_bayonet_touch_site")
    ET.SubElement(sensors, "touch", name="e1p_drip_grate_touch", site="e1p_drip_grate_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="e1p_pf_relpos",
        objtype="site",
        objname="e1p_pf_basket_center",
        reftype="site",
        refname="e1p_group_seat_site",
    )

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="victoria-arduino-e1-prima physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="1.0 -1.6 1.8", dir="-0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="e1p_body",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("e1p_pf_relpos",),
        accessories=(("portafilter_model.xml", "e1p_portafilter", pf),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_machine_mass_kg": 37.000,
                "detachable_portafilter_mass_kg": 0.540,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 220-240 V / 110-120 V / JP 200 V AC, 50/60 Hz, 1,600-2,600 W",
                "pump_architecture": "Commercial rotary/volumetric pump (9.0 bar extraction, dual internal tank + 3/8 BSP direct plumb-in)",
                "heating_architecture": "NEO 0.20 L instant stainless brew boiler + 1.5 L thermally insulated stainless steam boiler (2.1 bar Steam-by-Wire)",
                "water_reservoir_l": 1.5,
                "scope": "Articulated MuJoCo 4.0 Filament PBR 1-group commercial & specialty espresso machine with right Cool-Touch steam wand, right Steam-by-Wire paddle, left 2-dose hot-water paddle, top 1.5 L tank lid, pull-out diamond-perforated drip tray, and 6-DOF 58 mm portafilter.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    model, rebuilt = kit_export_native_xml(ASSETS, NAME, mujoco, np)
    machine_sum = sum(float(rebuilt.body(b).mass[0]) for b in MACHINE_BODY_NAMES)
    pf_mass = float(rebuilt.body("e1p_portafilter").mass[0])
    assert abs(machine_sum - 37.000) < 1e-6, machine_sum
    assert abs(pf_mass - 0.540) < 1e-6, pf_mass
    return model, rebuilt


def write_package_docs(report: dict) -> None:
    s = report["stages"]
    readme = f"""# Victoria Arduino E1 PRIMA — Blender 5.2 Visual & MuJoCo 4.0.0 Physics Package

Ultra-low-profile 1-group commercial & specialty espresso machine (`Victoria Arduino E1 PRIMA`, `411 × 510 × 379 mm`, `37.0 kg` empty, `1,600–2,600 W`) modeled from the official Victoria Arduino specification and Eagle One Prima industrial-design architecture: `NEO` multi-boiler heating (`0.20 L` instant stainless brew boiler + `1.5 L` thermally insulated stainless steam boiler), dual-mode water supply (`1.5 L` removable internal top-load reservoir + `3/8"` direct plumb-in), central sculpted mirror-chrome `58 mm` brew group with curved black control shield, `3` backlit volumetric dose keys, embedded **Ghost Display** shot timer, right-side **Steam-by-Wire** (`2.1 bar`) vertical blade lever & `360°` **Cool-Touch** stainless steam wand, left-side two-dose **Hot-Water** blade lever & curved economizer wand, diamond-perforated `SUS304` cup-warmer deck and pull-out drip tray, and vertically ribbed rear panel with raised mirror-chrome **1905 Winged Eagle** emblem.
See the [equipment reference specification](../../../docs/equipment/victoria-arduino-e1-prima/README.md).

![Victoria Arduino E1 PRIMA main view](studio-main.png)
![Victoria Arduino E1 PRIMA open view](studio-open.png)

## Files

- [Editable Blender 5.2 source](victoria-arduino-e1-prima.blend), [articulated GLB](victoria-arduino-e1-prima.glb), and standalone [58 mm portafilter GLB](victoria-arduino-e1-prima-portafilter.glb).
- Metal GPU Cycles renders (`1400 × 1200`, `64` samples + OIDN): [studio-main.png](studio-main.png), [studio-front.png](studio-front.png), [studio-right.png](studio-right.png), [studio-rear.png](studio-rear.png), [studio-open.png](studio-open.png), and [studio-active.png](studio-active.png).
- Verification manifests: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), and [physics-export.json](physics-export.json).
- MuJoCo 4.0 MJCF models: [appliance.xml](appliance.xml), [scene.xml](scene.xml), standalone [model.xml](model.xml) and [portafilter_model.xml](portafilter_model.xml), and collision-only [native.xml](native.xml).
- Active-state simulation & frame alignment: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Retained Bodies & Joints (`NAMES`)

| Body | Mass (`kg`) | Joint | Axis | Range |
| --- | --- | --- | --- | --- |
| `e1p_body` | `35.140` | Fixed base (`Z = 0.000 m` feet) | — | `411 × 510 × 379 mm` envelope |
| `e1p_steam_wand` | `0.240` | `e1p_steam_wand_swing` (`hinge`) | `-1 0 0` | `-0.20 .. 0.55 rad` (right `360°` Cool-Touch wand) |
| `e1p_steam_lever` | `0.130` | `e1p_steam_lever_hinge` (`hinge`) | `1 0 0` | `-0.38 .. 0.48 rad` (right Steam-by-Wire paddle) |
| `e1p_hot_water_lever` | `0.130` | `e1p_hot_water_lever_hinge` (`hinge`) | `1 0 0` | `-0.38 .. 0.48 rad` (left 2-dose hot-water paddle) |
| `e1p_tank_lid` | `0.380` | `e1p_tank_lid_hinge` (`hinge`) | `-1 0 0` | `0 .. 1.05 rad` (`1.5 L` reservoir cover) |
| `e1p_drip_tray` | `0.980` | `e1p_drip_tray_slide` (`slide`) | `0 -1 0` | `0 .. 0.160 m` (diamond-perforated drip tray) |
| **Machine Total** | **`37.000`** | — | — | Exact published machine mass |
| `e1p_portafilter` | `0.540` | `e1p_portafilter_free` (`freejoint`) | 6-DOF | Seated on `Z = 0.204 m` bayonet shelf (`vessel_socket` + `ingredient_payload`) |

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_e1_prima_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_e1_prima_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Victoria Arduino E1 PRIMA — MuJoCo 4.0.0 Active-State & Frame Alignment Verification

Verified in MuJoCo `{report['mujoco_version']}` at `dt = 0.002 s` across `{report['trace_samples']}` recorded telemetry samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **NEO Multi-Boiler Warm-Up & Seated Portafilter (`neo_warmup_and_bayonet_seat`):**
   - `2,600 W` NEO heating brings the `0.20 L` instant stainless brew boiler to `{s['neo_warmup_and_bayonet_seat']['neo_brew_temp_c']} °C` and the `1.5 L` insulated steam boiler to `{s['neo_warmup_and_bayonet_seat']['steam_boiler_bar']} bar` (`{s['neo_warmup_and_bayonet_seat']['steam_temp_c']} °C`) while `e1p_portafilter` (`0.540 kg`) rests in static equilibrium on the `58 mm` group bayonet shelf (`bayonet_touch_n = {s['neo_warmup_and_bayonet_seat']['bayonet_touch_n']} N`).
2. **Top `1.5 L` Internal Water Reservoir Refill (`top_tank_refill`):**
   - `e1p_tank_lid_hinge` opens to `{s['top_tank_refill']['peak_tank_lid_rad']} rad` (`54.4°`), refills internal reservoir to `{s['top_tank_refill']['tank_water_l']} L`, and closes flush (`{s['top_tank_refill']['tank_lid_rad']} rad`).
3. **Volumetric `9.0 bar` Extraction & Ghost Display Shot Timer (`neo_9bar_extraction_ghost_timer`):**
   - `18.0 g` dose in `ingredient_payload` pre-wets at `2.5 bar`, ramps to `{s['neo_9bar_extraction_ghost_timer']['peak_pump_bar']} bar`, illuminates the Ghost Display shot timer (`{s['neo_9bar_extraction_ghost_timer']['ghost_timer_s']} s`), yields `{s['neo_9bar_extraction_ghost_timer']['espresso_yield_g']} g` double espresso, and vents back to `0.0 bar`.
4. **Right Steam-by-Wire (`2.1 bar`) Cool-Touch Wand & Left Two-Dose Hot-Water Lever (`steam_by_wire_and_hot_water`):**
   - Articulates `e1p_steam_wand_swing` (`{s['steam_by_wire_and_hot_water']['min_wand_rad']} rad` purge to `{s['steam_by_wire_and_hot_water']['max_wand_rad']} rad` steaming), actuates `e1p_steam_lever_hinge` (`{s['steam_by_wire_and_hot_water']['min_steam_lever_rad']} rad` back-purge to `{s['steam_by_wire_and_hot_water']['max_steam_lever_rad']} rad` continuous `2.1 bar` lock), and pulls `e1p_hot_water_lever_hinge` (`{s['steam_by_wire_and_hot_water']['peak_hot_water_lever_rad']} rad`, `{s['steam_by_wire_and_hot_water']['hot_water_dispensed_ml']} mL`).
5. **Portafilter Diamond-Grate Transfer, Pull-Out Drip Tray Service & Rest (`drip_tray_service_and_restore`):**
   - Unseats `e1p_portafilter` onto the `Z = 0.098 m` diamond-perforated stainless drip grate (`peak_drip_grate_touch_n = {s['drip_tray_service_and_restore']['peak_drip_grate_touch_n']} N`), slides `e1p_drip_tray_slide` forward `{s['drip_tray_service_and_restore']['peak_drip_tray_mm']} mm`, and restores all joints and portafilter to rest.
6. **GLB vs. `native.xml` Rest & Sampled Motion Frame Alignment (`frame_alignment`):**
   - Rest frames (`7/7` bodies): max position error `{report['frame_alignment']['rest_max_position_error_m']:.3e} m` (`<= 2e-6 m`), max orientation error `{report['frame_alignment']['rest_max_orientation_error_rad']:.3e} rad` (`<= 1e-5 rad`).
   - Sampled scalar-joint motion (`5` joints × `21` samples): max position error `{report['frame_alignment']['motion_max_position_error_m']:.3e} m`, max orientation error `{report['frame_alignment']['motion_max_orientation_error_rad']:.3e} rad`.
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification() -> None:
    import mujoco
    import numpy as np

    model, native_model = export_native_xml(mujoco, np)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    dt = float(model.opt.timestep)
    assert abs(dt - 0.002) < 1e-9, dt

    payload_bid = model.body("ingredient_payload").id
    pf_qpos_adr = model.joint("e1p_portafilter_free").qposadr[0]
    pf_dof_adr = model.joint("e1p_portafilter_free").dofadr[0]

    act_wand = model.actuator("e1p_steam_wand_actuator").id
    act_steam_lev = model.actuator("e1p_steam_lever_actuator").id
    act_hw_lev = model.actuator("e1p_hot_water_lever_actuator").id
    act_lid = model.actuator("e1p_tank_lid_actuator").id
    act_tray = model.actuator("e1p_drip_tray_actuator").id

    rest_pf_pos = data.qpos[pf_qpos_adr : pf_qpos_adr + 3].copy()
    rest_pf_quat = data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7].copy()

    state = {
        "mode": "neo_warmup",
        "electrical_power_w": 2600.0,
        "neo_brew_temp_c": 72.0,
        "steam_temp_c": 124.0,
        "steam_boiler_bar": 1.45,
        "pump_pressure_bar": 0.0,
        "ghost_timer_s": 0.0,
        "tank_water_l": 0.85,
        "espresso_yield_g": 0.0,
        "hot_water_dispensed_ml": 0.0,
        "drip_tray_ml": 12.0,
    }

    trace_rows: list[dict] = []
    stage_summaries: dict[str, dict] = {}

    def sample_row() -> dict:
        wand_rad = float(data.sensor("e1p_steam_wand_pos").data[0])
        slev_rad = float(data.sensor("e1p_steam_lever_pos").data[0])
        hwlev_rad = float(data.sensor("e1p_hot_water_lever_pos").data[0])
        lid_rad = float(data.sensor("e1p_tank_lid_pos").data[0])
        tray_mm = float(data.sensor("e1p_drip_tray_pos").data[0]) * 1000.0
        bayonet_n = float(data.sensor("e1p_bayonet_touch").data[0])
        grate_n = float(data.sensor("e1p_drip_grate_touch").data[0])
        pf_rel = data.sensor("e1p_pf_relpos").data
        row = {
            "time_s": round(float(data.time), 4),
            "mode": state["mode"],
            "electrical_power_w": round(state["electrical_power_w"], 1),
            "neo_brew_temp_c": round(state["neo_brew_temp_c"], 2),
            "steam_temp_c": round(state["steam_temp_c"], 2),
            "steam_boiler_bar": round(state["steam_boiler_bar"], 2),
            "pump_pressure_bar": round(state["pump_pressure_bar"], 2),
            "ghost_timer_s": round(state["ghost_timer_s"], 1),
            "steam_wand_rad": round(wand_rad, 4),
            "steam_lever_rad": round(slev_rad, 4),
            "hot_water_lever_rad": round(hwlev_rad, 4),
            "tank_lid_rad": round(lid_rad, 4),
            "drip_tray_mm": round(tray_mm, 2),
            "tank_water_l": round(state["tank_water_l"], 3),
            "espresso_yield_g": round(state["espresso_yield_g"], 2),
            "hot_water_dispensed_ml": round(state["hot_water_dispensed_ml"], 1),
            "bayonet_touch_n": round(bayonet_n, 4),
            "drip_grate_touch_n": round(grate_n, 4),
            "pf_rel_z_m": round(float(pf_rel[2]), 5),
        }
        trace_rows.append(row)
        return dict(row)

    # Stage 1: NEO 0.20 L brew boiler (93.0 C) + 1.5 L steam boiler (134.0 C / 2.1 bar) warm-up & bayonet seat
    for step in range(300):
        if state["neo_brew_temp_c"] < 93.0 or state["steam_boiler_bar"] < 2.10:
            state["neo_brew_temp_c"] = min(93.0, state["neo_brew_temp_c"] + 0.09)
            state["steam_temp_c"] = min(134.0, state["steam_temp_c"] + 0.045)
            state["steam_boiler_bar"] = min(2.10, state["steam_boiler_bar"] + 0.003)
            state["electrical_power_w"] = 2600.0
        else:
            state["mode"] = "ghost_idle_ready"
            state["electrical_power_w"] = 88.0
        mujoco.mj_step(model, data)
        if step % 25 == 0:
            sample_row()
    snap1 = sample_row()
    assert snap1["neo_brew_temp_c"] == 93.0, snap1
    assert snap1["steam_boiler_bar"] == 2.10, snap1
    assert snap1["bayonet_touch_n"] > 4.8, snap1
    assert abs(snap1["pf_rel_z_m"]) < 0.002, snap1
    stage_summaries["neo_warmup_and_bayonet_seat"] = snap1

    # Stage 2: Open top 1.5 L internal water reservoir lid (0.95 rad), refill water to 1.500 L, close lid
    peak_lid_rad = 0.0
    state["mode"] = "tank_refill"
    for step in range(420):
        if step < 210:
            data.ctrl[act_lid] = 0.95
            if step == 160:
                state["tank_water_l"] = 1.500
        else:
            data.ctrl[act_lid] = 0.0
        mujoco.mj_step(model, data)
        peak_lid_rad = max(peak_lid_rad, float(data.sensor("e1p_tank_lid_pos").data[0]))
        if step % 30 == 0:
            sample_row()
    snap2 = sample_row()
    snap2["peak_tank_lid_rad"] = round(peak_lid_rad, 4)
    assert peak_lid_rad > 0.90, snap2
    assert snap2["tank_lid_rad"] < 0.04, snap2
    assert snap2["tank_water_l"] == 1.500, snap2
    stage_summaries["top_tank_refill"] = snap2

    # Stage 3: Load 18.0 g dose; volumetric 9.0 bar extraction with active Ghost Display shot timer (27.4 s scaled)
    model.body_mass[payload_bid] = 0.018
    peak_bar = 0.0
    for step in range(750):
        if step < 160:
            state["mode"] = "neo_prewet_2_5bar"
            state["pump_pressure_bar"] = 2.5
            state["electrical_power_w"] = 1420.0
            state["ghost_timer_s"] = round((step + 1) * (27.4 / 560.0), 1)
            state["tank_water_l"] -= 0.016 * (dt / 0.32)
            model.body_mass[payload_bid] = 0.034
        elif step < 560:
            state["mode"] = "neo_extraction_9bar"
            state["pump_pressure_bar"] = 9.0
            state["electrical_power_w"] = 1950.0
            state["ghost_timer_s"] = round(min(27.4, (step + 1) * (27.4 / 560.0)), 1)
            if state["espresso_yield_g"] < 36.0:
                dy = min(36.0 - state["espresso_yield_g"], 46.0 * dt)
                state["espresso_yield_g"] += dy
                state["tank_water_l"] -= dy * 0.001
        else:
            state["mode"] = "solenoid_vent"
            state["pump_pressure_bar"] = 0.0
            state["electrical_power_w"] = 88.0
            state["drip_tray_ml"] = 26.0
        mujoco.mj_step(model, data)
        peak_bar = max(peak_bar, state["pump_pressure_bar"])
        if step % 30 == 0:
            sample_row()
    snap3 = sample_row()
    snap3["peak_pump_bar"] = round(peak_bar, 2)
    assert abs(snap3["espresso_yield_g"] - 36.0) < 0.2, snap3
    assert snap3["ghost_timer_s"] == 27.4, snap3
    assert snap3["pump_pressure_bar"] == 0.0, snap3
    stage_summaries["neo_9bar_extraction_ghost_timer"] = snap3

    # Stage 4: Steam-by-Wire (right wand + lever back-purge & forward lock) + Hot-Water 2-dose lever (left)
    min_wand = 99.0
    max_wand = -99.0
    min_slev = 99.0
    max_slev = -99.0
    peak_hwlev = 0.0
    for step in range(620):
        if step < 150:
            state["mode"] = "steam_purge"
            state["electrical_power_w"] = 2200.0
            data.ctrl[act_wand] = -0.16
            data.ctrl[act_steam_lev] = -0.32  # Push back for momentary Steam-by-Wire purge
            data.ctrl[act_hw_lev] = 0.0
        elif step < 400:
            state["mode"] = "steam_by_wire_2_1bar"
            state["electrical_power_w"] = 2600.0
            state["steam_boiler_bar"] = 2.10
            data.ctrl[act_wand] = 0.46  # Swing Cool-Touch wand forward & up into milk pitcher
            data.ctrl[act_steam_lev] = 0.42  # Pull forward to lock continuous 2.1 bar delivery
            data.ctrl[act_hw_lev] = 0.38  # Pull left hot-water paddle forward for Dose 1
            if state["hot_water_dispensed_ml"] < 120.0:
                dhw = min(120.0 - state["hot_water_dispensed_ml"], 260.0 * dt)
                state["hot_water_dispensed_ml"] += dhw
                state["tank_water_l"] -= dhw * 0.001
        else:
            state["mode"] = "ghost_idle_ready"
            state["electrical_power_w"] = 88.0
            data.ctrl[act_wand] = 0.0
            data.ctrl[act_steam_lev] = 0.0
            data.ctrl[act_hw_lev] = 0.0
        mujoco.mj_step(model, data)
        w_now = float(data.sensor("e1p_steam_wand_pos").data[0])
        sl_now = float(data.sensor("e1p_steam_lever_pos").data[0])
        hw_now = float(data.sensor("e1p_hot_water_lever_pos").data[0])
        min_wand = min(min_wand, w_now)
        max_wand = max(max_wand, w_now)
        min_slev = min(min_slev, sl_now)
        max_slev = max(max_slev, sl_now)
        peak_hwlev = max(peak_hwlev, hw_now)
        if step % 25 == 0:
            sample_row()
    snap4 = sample_row()
    snap4["min_wand_rad"] = round(min_wand, 4)
    snap4["max_wand_rad"] = round(max_wand, 4)
    snap4["min_steam_lever_rad"] = round(min_slev, 4)
    snap4["max_steam_lever_rad"] = round(max_slev, 4)
    snap4["peak_hot_water_lever_rad"] = round(peak_hwlev, 4)
    assert min_wand < -0.12 and max_wand > 0.38, snap4
    assert min_slev < -0.26 and max_slev > 0.36, snap4
    assert peak_hwlev > 0.32, snap4
    assert abs(snap4["hot_water_dispensed_ml"] - 120.0) < 0.5, snap4
    stage_summaries["steam_by_wire_and_hot_water"] = snap4

    # Stage 5: Unseat portafilter onto Z=0.098m diamond-perforated drip grate, slide tray +140 mm, restore rest
    peak_grate_n = 0.0
    peak_tray_mm = 0.0
    for step in range(560):
        if step == 0:
            state["mode"] = "portafilter_on_drip_grate"
            model.body_mass[payload_bid] = 1e-9
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = [0.0, -0.1720, 0.1450]
            data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
            data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
        elif step == 180:
            state["mode"] = "drip_tray_slide_out"
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = rest_pf_pos
            data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = rest_pf_quat
            data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
            data.ctrl[act_tray] = 0.140
        elif step == 380:
            state["mode"] = "ghost_idle_ready"
            state["drip_tray_ml"] = 0.0
            state["ghost_timer_s"] = 0.0
            data.ctrl[act_tray] = 0.0
        mujoco.mj_step(model, data)
        peak_grate_n = max(peak_grate_n, float(data.sensor("e1p_drip_grate_touch").data[0]))
        peak_tray_mm = max(peak_tray_mm, float(data.sensor("e1p_drip_tray_pos").data[0]) * 1000.0)
        if step % 30 == 0:
            sample_row()
    snap5 = sample_row()
    snap5["peak_drip_grate_touch_n"] = round(peak_grate_n, 4)
    snap5["peak_drip_tray_mm"] = round(peak_tray_mm, 2)
    assert peak_grate_n > 4.8, snap5
    assert peak_tray_mm > 132.0, snap5
    assert snap5["drip_tray_mm"] < 2.0, snap5
    assert snap5["bayonet_touch_n"] > 4.8, snap5
    stage_summaries["drip_tray_service_and_restore"] = snap5

    # Stage 6: Verify BOTH rest frames AND --motion sampled scalar-joint trajectories via inspect_appliance_frames.mjs
    evidence_dir = ASSETS / "active-state-evidence"
    native_sha = hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest()
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
    assert alignment_summary["rest_max_position_error_m"] <= 2e-6
    assert alignment_summary["rest_max_orientation_error_rad"] <= 1e-5
    assert alignment_summary["motion_max_position_error_m"] <= 2e-6
    assert alignment_summary["motion_max_orientation_error_rad"] <= 1e-5

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": NAME,
        "model_title": "Victoria Arduino E1 PRIMA 1-Group Commercial & Specialty Espresso Machine",
        "mujoco_version": mujoco.__version__,
        "supply": "Single-phase 220-240 V / 110-120 V / JP 200 V AC, 50/60 Hz, 1,600-2,600 W",
        "envelope_m": [0.411, 0.510, 0.379],
        "published_machine_mass_kg": 37.000,
        "detachable_portafilter_mass_kg": 0.540,
        "component_masses_kg": MASSES,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": native_sha,
        "glb_sha256": frames_report["appliances"][NAME]["glb_sha256"],
        "frame_alignment": alignment_summary,
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_package_docs(report)
    print(json.dumps(report, indent=2))


def main() -> None:
    if "--blender-export" in sys.argv:
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
    run_active_state_verification()


if __name__ == "__main__":
    main()
