"""Export MuJoCo 4.0 MJCF, standalone model.xml, and native collision spec for Victoria Arduino Eagle One (2-group).

Reference ground truth:
- Victoria Arduino Eagle One 2-group specification (758 W x 576 D x 437 H mm, 68.5 kg empty)
- assets/bakery-mujoco/victoria-arduino-eagle-one-2g/inspection.json

Mass budget (total = 68.500 kg):
  victoria-arduino-eagle-one-2g  66.875 kg
  eo_{left,right}_portafilter     0.600 kg each (1.200 kg)
  eo_{left,right}_steam_wand      0.120 kg each (0.240 kg)
  eo_{left,right}_steam_lever     0.050 kg each (0.100 kg)
  eo_hot_water_lever              0.050 kg
  6 dose + 1 power button         0.005 kg each (0.035 kg)
"""

from __future__ import annotations

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
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers as kit_numbers,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)
from build_linea_classic_s_physics import add_col_geom, guided_cup, joint, numbers, position

NAME = "victoria-arduino-eagle-one-2g"
OUT = ROOT / "assets/bakery-mujoco" / NAME

SCALAR_VISUAL_AXES = {
    "eo_left_lift": [0.0, 0.0, 1.0],
    "eo_left_lock": [0.0, 0.0, 1.0],
    "eo_right_lift": [0.0, 0.0, 1.0],
    "eo_right_lock": [0.0, 0.0, 1.0],
    "eo_left_steam": [1.0, 0.0, 0.0],
    "eo_right_steam": [1.0, 0.0, 0.0],
    "eo_left_wand": [0.0, 0.0, 1.0],
    "eo_right_wand": [0.0, 0.0, 1.0],
    "eo_left_dose_1": [0.0, -1.0, 0.0],
    "eo_left_dose_2": [0.0, -1.0, 0.0],
    "eo_left_dose_3": [0.0, -1.0, 0.0],
    "eo_right_dose_1": [0.0, -1.0, 0.0],
    "eo_right_dose_2": [0.0, -1.0, 0.0],
    "eo_right_dose_3": [0.0, -1.0, 0.0],
    "eo_power": [0.0, -1.0, 0.0],
    "eo_hot_water": [1.0, 0.0, 0.0],
}


def mechanism(
    body: ET.Element,
    actuators: ET.Element,
    suffix: str,
    limits,
    mass: float,
    axis=(0, 0, 1),
    slide: bool = False,
    *,
    damping: float | None = None,
    armature: float | None = None,
    frictionloss: float | None = None,
    com: tuple[float, float, float] = (0.0, 0.0, 0.0),
    diaginertia: tuple[float, float, float] = (0.0004, 0.0004, 0.0004),
) -> None:
    joint(
        body,
        "eo_" + suffix,
        axis,
        limits,
        mass,
        "slide" if slide else "hinge",
        damping=damping,
        armature=armature,
        frictionloss=frictionloss,
        com=com,
        diaginertia=diaginertia,
    )
    position(actuators, "eo_" + suffix + "_control", "eo_" + suffix, limits, slide)


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local UV OBJ meshes and author appliance.xml, model.xml, and scene.xml."""
    import bpy
    from build_oven_visuals import export_visual_meshes

    source = OUT / f"{NAME}.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    root_obj = bpy.data.objects[NAME]
    parts = [root_obj, *[o for o in root_obj.children_recursive if o.type == "EMPTY"]]
    for obj in list(root_obj.children_recursive):
        if "group timer" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in parts:
        obj.animation_data_clear()
        for child in obj.children_recursive:
            child.animation_data_clear()
    bpy.context.view_layer.update()

    # Ensure every Blender material carries scalar PBR properties for MuJoCo 4.0 Filament rendering.
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
                else 0.30
            )
        if "emission" not in mat:
            mat["emission"] = (
                float(bsdf.inputs["Emission Strength"].default_value)
                if bsdf and "Emission Strength" in bsdf.inputs
                else 0.0
            )

    mesh_dir = OUT / "meshes"
    if mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts, OUT)

    app = ET.Element(
        "mujoco",
        model="victoria-arduino-eagle-one-2g — Victoria Arduino Eagle One 2-group espresso machine",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")

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
        name="eo_floor",
        type="plane",
        size="2 2 0.1",
        rgba="0.30 0.32 0.34 1",
        contype="1",
        conaffinity="1",
        group="2",
    )

    bodies: dict[str, ET.Element] = {}
    remaining = parts.copy()
    while remaining:
        available = [o for o in remaining if o.parent is None or o.parent.name in bodies]
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

    housing = bodies[NAME]
    # Published empty weight: 68.500 kg total (66.875 kg static housing + 1.625 kg articulated parts).
    ET.SubElement(
        housing,
        "inertial",
        pos="0 0.065 0.235",
        mass="66.875",
        diaginertia="2.2 3.1 3.5",
    )

    # Four adjustable rubber/stainless feet touching Z = 0.000 m up to underbody at Z = 0.055 m.
    for foot_name, fx, fy in (
        ("eo_foot_fl_col", -0.315, -0.085),
        ("eo_foot_fr_col", 0.315, -0.085),
        ("eo_foot_rl_col", -0.315, 0.232),
        ("eo_foot_rr_col", 0.315, 0.232),
    ):
        add_col_geom(
            housing,
            foot_name,
            "cylinder",
            pos=(fx, fy, 0.0275),
            size="0.0210 0.0275",
            friction="0.80 0.015 0.003",
            rgba=COL_BASE_RGBA,
        )

    # Chassis decomposition: underbody, lower/upper rear core, tapered side cheeks, rear cup guard,
    # touchscreen bezel, and fixed left-side hot-water outlet spout (brew workspace left open).
    add_col_geom(
        housing,
        "eo_underbody_col",
        "box",
        pos=(0.0, 0.065, 0.073),
        size=(0.3570, 0.1950, 0.0180),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        housing,
        "eo_rear_housing",
        "box",
        pos=(0.0, 0.085, 0.1805),
        size=(0.3650, 0.1930, 0.0895),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        housing,
        "eo_upper_housing_col",
        "box",
        pos=(0.0, 0.0675, 0.343),
        size=(0.3530, 0.1905, 0.0730),
        rgba=COL_BASE_RGBA,
    )
    for side_label, sx in (("left", -1.0), ("right", 1.0)):
        add_col_geom(
            housing,
            f"eo_side_{side_label}_low_col",
            "box",
            pos=(sx * 0.365, 0.070, 0.160),
            size=(0.0140, 0.2180, 0.1060),
            rgba=COL_BASE_RGBA,
        )
        add_col_geom(
            housing,
            f"eo_side_{side_label}_top_col",
            "box",
            pos=(sx * 0.348, 0.062, 0.348),
            size=(0.0140, 0.1940, 0.0820),
            rgba=COL_BASE_RGBA,
        )
    add_col_geom(
        housing,
        "eo_rear_cup_guard_col",
        "box",
        pos=(0.0, 0.247, 0.427),
        size=(0.3400, 0.0030, 0.0100),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        housing,
        "eo_touchscreen_col",
        "box",
        pos=(0.025, -0.128, 0.342),
        size=(0.0400, 0.0070, 0.0300),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        housing,
        "eo_hot_water_nozzle_col",
        "capsule",
        fromto=(-0.218, -0.139, 0.285, -0.218, -0.179, 0.230),
        size="0.0090",
        rgba=COL_BASE_RGBA,
    )

    # Top cup warmer sheet, lower drip basin, wire grate, and raised two-tier espresso cup shelf.
    add_col_geom(
        bodies["cup_warmer"],
        "eo_cup_warmer_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.3380, 0.1835, 0.0020),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["drip_tray"],
        "eo_drip_tray_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.3590, 0.0900, 0.0145),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        bodies["drip_grate"],
        "eo_lower_support",
        "box",
        pos=(0.0, 0.0, -0.0004),
        size=(0.3350, 0.0735, 0.0015),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["raised_cup_support"],
        "eo_raised_support",
        "box",
        pos=(0.0, 0.0, -0.0015),
        size=(0.3260, 0.0325, 0.0020),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["raised_cup_support"],
        "eo_raised_leg_left_col",
        "box",
        pos=(-0.318, 0.0, -0.012),
        size=(0.0050, 0.0300, 0.0120),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["raised_cup_support"],
        "eo_raised_leg_right_col",
        "box",
        pos=(0.318, 0.0, -0.012),
        size=(0.0050, 0.0300, 0.0120),
        rgba=COL_WALL_RGBA,
    )

    # Operational sites (group 4, visible semi-transparent rgba).
    ET.SubElement(
        housing,
        "site",
        name="eo_hot_water_outlet_site",
        pos="-0.218 -0.179 0.225",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        bodies["drip_grate"],
        "site",
        name="eo_drip_grate_site",
        type="box",
        pos="0 0 0.001",
        size="0.330 0.070 0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    actuators = ET.SubElement(app, "actuator")
    exclude_pairs: list[tuple[str, str, str]] = []

    for side in ("left", "right"):
        sign = -1.0 if side == "left" else 1.0
        group_body = bodies[f"eo_{side}_brew_group"]

        # Sculpted brew group hood and lower 58 mm collar.
        add_col_geom(
            group_body,
            f"eo_{side}_group_hood_col",
            "box",
            pos=(0.0, 0.0, 0.047),
            size=(0.0640, 0.0490, 0.0460),
            rgba=COL_BASE_RGBA,
        )
        add_col_geom(
            group_body,
            f"eo_{side}_group_collar_col",
            "cylinder",
            pos=(0.0, 0.0, -0.009),
            size="0.0450 0.0115",
            rgba=COL_BASE_RGBA,
        )
        ET.SubElement(
            group_body,
            "site",
            name=f"eo_{side}_group_seat_site",
            pos="0 0 -0.025",
            size="0.004",
            group="4",
            rgba=SITE_SUPPORT_RGBA,
        )

        # Portafilter: vertical guided lift (holds against 5.89 N gravity) + bayonet lock rotation.
        pf = bodies[f"eo_{side}_portafilter"]
        mechanism(
            pf,
            actuators,
            f"{side}_lift",
            (-0.10, 0),
            0.600,
            slide=True,
            damping=8.0,
            armature=0.010,
            frictionloss=10.0,
            com=(0.0, -0.024, -0.010),
            diaginertia=(0.0016, 0.0005, 0.0018),
        )
        mechanism(
            pf,
            actuators,
            f"{side}_lock",
            (-0.62, 0),
            0.600,
            damping=0.35,
            armature=0.004,
            frictionloss=0.25,
        )
        add_col_geom(
            pf,
            f"eo_{side}_filter_contact",
            "cylinder",
            pos=(0.0, 0.0, -0.008),
            size="0.0390 0.0170",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"eo_{side}_pf_handle_col",
            "capsule",
            fromto=(0.0, -0.042, -0.004, 0.0, -0.162, -0.004),
            size="0.0145",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"eo_{side}_pf_spout_l_col",
            "capsule",
            fromto=(0.0, 0.0, -0.023, -0.022, -0.015, -0.043),
            size="0.0050",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"eo_{side}_pf_spout_r_col",
            "capsule",
            fromto=(0.0, 0.0, -0.023, 0.022, -0.015, -0.043),
            size="0.0050",
            rgba=COL_ACCESSORY_RGBA,
        )
        ET.SubElement(
            pf,
            "site",
            name=f"eo_{side}_pf_grasp_site",
            pos="0 -0.115 -0.004",
            size="0.005",
            group="4",
            rgba=SITE_GRASP_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_housing_{side}_pf", NAME, f"eo_{side}_portafilter"),
                (f"exclude_{side}_group_pf", f"eo_{side}_brew_group", f"eo_{side}_portafilter"),
                (f"exclude_tray_{side}_pf", "drip_tray", f"eo_{side}_portafilter"),
                (f"exclude_grate_{side}_pf", "drip_grate", f"eo_{side}_portafilter"),
                (f"exclude_raised_{side}_pf", "raised_cup_support", f"eo_{side}_portafilter"),
                (f"exclude_{side}_wand_pf", f"eo_{side}_steam_wand", f"eo_{side}_portafilter"),
            ]
        )

        # Steam-by-Wire paddle lever.
        lever = bodies[f"eo_{side}_steam_lever"]
        mechanism(
            lever,
            actuators,
            f"{side}_steam",
            (0, 0.45),
            0.050,
            (1, 0, 0),
            damping=0.20,
            armature=0.002,
            frictionloss=0.08,
            com=(0.0, -0.005, 0.017),
            diaginertia=(0.00004, 0.00004, 0.00002),
        )
        add_col_geom(
            lever,
            f"eo_{side}_steam_lever_col",
            "box",
            pos=(0.0, -0.005, 0.017),
            size=(0.0135, 0.0075, 0.0275),
            rgba=COL_ARTIC_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_housing_{side}_steam", NAME, f"eo_{side}_steam_lever"),
                (f"exclude_{side}_steam_wand", f"eo_{side}_steam_lever", f"eo_{side}_steam_wand"),
            ]
        )

        # Cool-touch stainless steam wand.
        wand = bodies[f"eo_{side}_steam_wand"]
        mechanism(
            wand,
            actuators,
            f"{side}_wand",
            (-0.7, 0.7),
            0.120,
            damping=0.30,
            armature=0.003,
            frictionloss=0.15,
            com=(sign * 0.008, -0.048, -0.032),
            diaginertia=(0.00050, 0.00050, 0.00009),
        )
        add_col_geom(
            wand,
            f"eo_{side}_wand_arch_col",
            "capsule",
            fromto=(0.0, 0.0, 0.0, sign * 0.023, -0.056, 0.055),
            size="0.0050",
            rgba=COL_ARTIC_RGBA,
        )
        add_col_geom(
            wand,
            f"eo_{side}_wand_bend_col",
            "capsule",
            fromto=(sign * 0.023, -0.056, 0.055, 0.0, -0.086, 0.033),
            size="0.0050",
            rgba=COL_ARTIC_RGBA,
        )
        add_col_geom(
            wand,
            f"eo_{side}_wand_stem_col",
            "capsule",
            fromto=(0.0, -0.086, 0.033, -sign * 0.007, -0.089, -0.124),
            size="0.0055",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            wand,
            "site",
            name=f"eo_{side}_steam_tip_site",
            pos=kit_numbers((-sign * 0.007, -0.089, -0.130)),
            size="0.004",
            group="4",
            rgba=SITE_SUPPORT_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_housing_{side}_wand", NAME, f"eo_{side}_steam_wand"),
                (f"exclude_tray_{side}_wand", "drip_tray", f"eo_{side}_steam_wand"),
                (f"exclude_grate_{side}_wand", "drip_grate", f"eo_{side}_steam_wand"),
                (f"exclude_raised_{side}_wand", "raised_cup_support", f"eo_{side}_steam_wand"),
            ]
        )

        # Three volumetric dose keys per brew group.
        for index in (1, 2, 3):
            dose_body = bodies[f"eo_{side}_dose_{index}"]
            mechanism(
                dose_body,
                actuators,
                f"{side}_dose_{index}",
                (-0.001, 0),
                0.005,
                (0, -1, 0),
                True,
                damping=8.0,
                armature=0.001,
                frictionloss=0.05,
                diaginertia=(5e-6, 5e-6, 5e-6),
            )
            add_col_geom(
                dose_body,
                f"eo_{side}_dose_{index}_col",
                "box",
                pos=(0.0, 0.0, 0.0),
                size=(0.0090, 0.0025, 0.0060),
                rgba=COL_ARTIC_RGBA,
            )
            exclude_pairs.extend(
                [
                    (f"exclude_{side}_group_dose_{index}", f"eo_{side}_brew_group", f"eo_{side}_dose_{index}"),
                    (f"exclude_housing_{side}_dose_{index}", NAME, f"eo_{side}_dose_{index}"),
                ]
            )

        # Live shot timer backing panel (visual only, group 2, zero mass, non-colliding).
        frame = ET.SubElement(
            group_body,
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
            contype="0",
            conaffinity="0",
            density="0",
            mass="0",
            group="2",
        )

    # Power button.
    power_btn = bodies["eo_power_button"]
    mechanism(
        power_btn,
        actuators,
        "power",
        (-0.001, 0),
        0.005,
        (0, -1, 0),
        True,
        damping=8.0,
        armature=0.001,
        frictionloss=0.05,
        diaginertia=(5e-6, 5e-6, 5e-6),
    )
    add_col_geom(
        power_btn,
        "eo_power_button_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.0085, 0.0045, 0.0060),
        rgba=COL_ARTIC_RGBA,
    )
    exclude_pairs.append(("exclude_housing_power_btn", NAME, "eo_power_button"))

    # Hot water paddle lever.
    hw_lever = bodies["eo_hot_water_lever"]
    mechanism(
        hw_lever,
        actuators,
        "hot_water",
        (0, 0.45),
        0.050,
        (1, 0, 0),
        damping=0.20,
        armature=0.002,
        frictionloss=0.08,
        com=(0.0, 0.0, 0.0),
        diaginertia=(0.00004, 0.00004, 0.00002),
    )
    add_col_geom(
        hw_lever,
        "eo_hot_water_lever_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.0130, 0.0075, 0.0260),
        rgba=COL_ARTIC_RGBA,
    )
    exclude_pairs.append(("exclude_housing_hw_lever", NAME, "eo_hot_water_lever"))

    contact = add_adjacent_excludes(app, exclude_pairs)

    write_xml(OUT / "appliance.xml", app)

    # Scene wrapper includes appliance.xml + rehearsal guided cups (for native Rust journeys).
    scene = ET.Element("mujoco", model="Eagle One two-group uncalibrated rehearsal")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="1.0 -1.6 1.8", dir="-0.35 0.6 -0.8")
    scene_actuators = ET.SubElement(scene, "actuator")
    for label, x, y, z in [
        ("left", -0.094, -0.17, 0.168),
        ("right", 0.144, -0.17, 0.168),
        ("hot_water", -0.218, -0.179, 0.168),
    ]:
        guided_cup(scene_world, scene_actuators, "eo", label, (x, y, z), 0.027)
    write_xml(OUT / "scene.xml", scene)

    emit_standalone_models(
        OUT,
        model_name=NAME,
        defaults=defaults,
        asset=asset,
        root_body=housing,
        contact=contact,
    )

    (OUT / "physics-export.json").write_text(
        json.dumps(
            {
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "bodies": [o.name for o in parts],
                "published_mass_kg": 68.5,
                "envelope_m": [0.758, 0.576, 0.437],
                "assumptions": [
                    "Guided cups and filter removal; no qualified bayonet geometry.",
                    "5000 W ceiling follows current page; Japanese electrical variant unverified.",
                    "Aggregate two-group thermal capacity; no separate NEO/TERS simulation.",
                    "Fixed housing inertia and moving component masses are estimates.",
                ],
                "scope": "MuJoCo 4.0 visual, contact, standalone model.xml, and native.xml with guided portafilter travel.",
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    spec = model_spec(OUT / "scene.xml", NAME)
    _model, rebuilt = kit_export_native_xml(
        OUT,
        NAME,
        mujoco,
        np,
        spec=spec,
        strip_general_input=False,
    )

    export_meta = json.loads((OUT / "physics-export.json").read_text())
    body_names = export_meta["bodies"]
    frames_report, motion_report = kit_verify_frames_and_motions(
        OUT,
        NAME,
        body_names,
        SCALAR_VISUAL_AXES,
        mujoco,
        OUT / "active-state-evidence",
        cleanup_inputs=True,
    )

    # Verify standalone model.xml compiles cleanly and matches published mass.
    standalone_model = mujoco.MjModel.from_xml_path(str(OUT / "model.xml"))
    standalone_data = mujoco.MjData(standalone_model)
    mujoco.mj_forward(standalone_model, standalone_data)
    total_mass = float(np.sum(standalone_model.body_mass[1:]))
    assert abs(total_mass - 68.5) < 1e-6, f"Expected 68.5 kg standalone mass, got {total_mass}"

    # Verify native.xml settles stably for 0.5 s with all finite states.
    rdata = mujoco.MjData(rebuilt)
    for _ in range(int(round(0.5 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, rdata)
    assert np.all(np.isfinite(rdata.qpos)) and np.all(np.isfinite(rdata.qvel))

    print(
        json.dumps(
            {
                "appliance": NAME,
                "status": "passed",
                "standalone_mass_kg": round(total_mass, 3),
                "native_nq": int(rebuilt.nq),
                "native_nv": int(rebuilt.nv),
                "frames_passed": frames_report["passed"],
                "motion_passed": motion_report["passed"],
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
