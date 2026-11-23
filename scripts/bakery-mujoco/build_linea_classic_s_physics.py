"""Export MuJoCo 4.0 MJCF, standalone model.xml, and native collision spec for La Marzocco Linea Classic S AV (2-group).

Reference ground truth:
- Japanese approval drawing revised 2022.9 (693 W x 585 D x 522 H mm, 58.0 kg empty)
- assets/bakery-mujoco/la-marzocco-linea-classic-s-2g/README.md

Mass budget (total = 58.000 kg):
  lcs_machine                56.203 kg
  lcs_{left,right}_portafilter 0.600 kg each (1.200 kg)
  lcs_{left,right}_steam_wand  0.150 kg each (0.300 kg)
  lcs_{left,right}_steam_knob  0.100 kg each (0.200 kg)
  lcs_power_switch             0.060 kg
  6 dose + 1 hot water button  0.005 kg each (0.035 kg)
  2 pressure gauge needles     0.001 kg each (0.002 kg)
"""

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
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers as kit_numbers,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

NAME = "la-marzocco-linea-classic-s-2g"
DIRECTORY = ROOT / "assets/bakery-mujoco" / NAME

SCALAR_VISUAL_AXES = {
    "lcs_left_lift": [0.0, 0.0, 1.0],
    "lcs_left_lock": [0.0, 0.0, 1.0],
    "lcs_right_lift": [0.0, 0.0, 1.0],
    "lcs_right_lock": [0.0, 0.0, 1.0],
    "lcs_left_steam": [0.0, -1.0, 0.0],
    "lcs_right_steam": [0.0, -1.0, 0.0],
    "lcs_left_wand_swivel": [0.0, 0.0, 1.0],
    "lcs_right_wand_swivel": [0.0, 0.0, 1.0],
    "lcs_left_dose_1": [0.0, -1.0, 0.0],
    "lcs_left_dose_2": [0.0, -1.0, 0.0],
    "lcs_left_dose_3": [0.0, -1.0, 0.0],
    "lcs_right_dose_1": [0.0, -1.0, 0.0],
    "lcs_right_dose_2": [0.0, -1.0, 0.0],
    "lcs_right_dose_3": [0.0, -1.0, 0.0],
    "lcs_hot_water": [0.0, -1.0, 0.0],
    "lcs_coffee_pressure": [0.0, -1.0, 0.0],
    "lcs_steam_pressure": [0.0, -1.0, 0.0],
    "lcs_power": [0.0, -1.0, 0.0],
}


def numbers(values) -> str:
    return " ".join(f"{value:.12g}" for value in values)


def add_col_geom(
    body: ET.Element,
    name: str,
    gtype: str,
    *,
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    size: str | tuple[float, ...],
    fromto: tuple[float, float, float, float, float, float] | None = None,
    rgba: str = COL_BASE_RGBA,
    friction: str | None = None,
    mass: str | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": gtype,
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if fromto is not None:
        attrib["fromto"] = kit_numbers(fromto)
    elif pos is not None:
        attrib["pos"] = kit_numbers(pos)
    if quat is not None:
        attrib["quat"] = quat
    attrib["size"] = size if isinstance(size, str) else kit_numbers(size)
    if friction is not None:
        attrib["friction"] = friction
    if mass is not None:
        attrib["mass"] = mass
    elif body.find("inertial") is None and body.find("joint") is None:
        attrib["mass"] = "0"
    return ET.SubElement(body, "geom", **attrib)


def joint(
    body: ET.Element,
    name: str,
    axis,
    limits,
    mass: float,
    kind: str = "hinge",
    *,
    damping: float | None = None,
    armature: float | None = None,
    frictionloss: float | None = None,
    com: tuple[float, float, float] = (0.0, 0.0, 0.0),
    diaginertia: tuple[float, float, float] = (0.0004, 0.0004, 0.0004),
) -> ET.Element:
    damp = (8.0 if kind == "slide" else 0.20) if damping is None else damping
    arm = (0.004 if kind == "slide" else 0.002) if armature is None else armature
    floss = (0.05 if kind == "slide" else 0.08) if frictionloss is None else frictionloss
    j_el = ET.SubElement(
        body,
        "joint",
        name=name,
        type=kind,
        axis=numbers(axis),
        limited="true",
        range=numbers(limits),
        damping=kit_numbers((damp,)),
        armature=kit_numbers((arm,)),
        frictionloss=kit_numbers((floss,)),
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    if body.find("inertial") is None:
        ET.SubElement(
            body,
            "inertial",
            pos=kit_numbers(com),
            mass=str(mass),
            diaginertia=kit_numbers(diaginertia),
        )
    return j_el


def position(actuators: ET.Element, name: str, joint_name: str, limits, slide: bool = False) -> None:
    ET.SubElement(
        actuators,
        "position",
        name=name,
        joint=joint_name,
        kp="20000" if slide else "30",
        kv="100" if slide else "1",
        ctrlrange=numbers(limits),
        forcerange="-100 100" if slide else "-8 8",
    )


def guided_cup(world: ET.Element, actuators: ET.Element, prefix: str, label: str, location, radius: float) -> None:
    """Rehearsal-only guided cup fixture added to scene.xml (never part of standalone model.xml)."""
    name = f"{prefix}_{label}_cup"
    cup = ET.SubElement(world, "body", name=name, pos=numbers(location))
    joint(
        cup,
        name + "_travel",
        (0, -1, 0),
        (0, 0.18),
        0.2,
        "slide",
        damping=8.0,
        armature=0.001,
        frictionloss=0.0,
        diaginertia=(
            0.2 * (3 * radius**2 + 0.07**2) / 12,
            0.2 * (3 * radius**2 + 0.07**2) / 12,
            0.2 * radius**2 / 2,
        ),
    )
    position(actuators, name + "_control", name + "_travel", (0, 0.18), True)
    joint(
        cup,
        name + "_vertical",
        (0, 0, 1),
        (-0.02, 0.005),
        0.2,
        "slide",
        damping=8.0,
        armature=0.001,
        frictionloss=0.0,
    )
    ET.SubElement(
        cup,
        "geom",
        name=name + "_contact",
        type="sphere",
        pos="0 0 -.02",
        size=".015",
        mass="0",
        contype="8",
        conaffinity="8",
        friction="0 0 0",
        solref=".02 1",
        condim="1",
        group="3",
        rgba=".92 .92 .89 .65",
    )
    # Frictionless support rail is part of the guided handling rehearsal fixture, not the appliance.
    ET.SubElement(
        world,
        "geom",
        name=name + "_guide",
        type="box",
        pos=numbers((location[0], location[1] - 0.09, location[2] - 0.037)),
        size=numbers((radius + 0.005, 0.09 + radius + 0.005, 0.002)),
        contype="8",
        conaffinity="8",
        condim="1",
        friction="0 0 0",
        group="3",
        rgba=".3 .3 .3 .25",
    )


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local UV OBJ meshes and author appliance.xml, model.xml, and scene.xml."""
    import bpy
    from build_oven_visuals import export_visual_meshes

    source = DIRECTORY / f"{NAME}.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    parts = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "EMPTY" and obj.name.startswith("lcs_")
    ]
    # Live readouts replace the two decorative Blender timers in the physics view.
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith("Inactive shot timer"):
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

    mesh_dir = DIRECTORY / "meshes"
    if mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts, DIRECTORY)

    app = ET.Element(
        "mujoco",
        model="la-marzocco-linea-classic-s-2g — La Marzocco Linea Classic S AV 2-group espresso machine",
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
        name="lcs_floor",
        type="plane",
        size="2 2 0.1",
        rgba="0.30 0.32 0.34 1",
        contype="1",
        conaffinity="1",
        group="2",
    )

    bodies: dict[str, ET.Element] = {}
    remaining = list(parts)
    while remaining:
        progressed = False
        for obj in remaining[:]:
            if obj.parent and obj.parent.name not in bodies:
                continue
            parent = world if obj.parent is None else bodies[obj.parent.name]
            transform = obj.matrix_local if obj.parent else obj.matrix_world
            body = ET.SubElement(
                parent,
                "body",
                name=obj.name,
                pos=numbers(transform.translation),
                quat=numbers(transform.to_quaternion()),
            )
            ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")
            bodies[obj.name] = body
            remaining.remove(obj)
            progressed = True
        assert progressed, "Unresolved named body parent"

    root = bodies["lcs_machine"]
    # Published empty weight: 58.000 kg total (56.203 kg static housing + 1.797 kg articulated parts).
    ET.SubElement(
        root,
        "inertial",
        pos="0 0.025 0.285",
        mass="56.203",
        diaginertia="2.0 2.8 3.0",
    )

    # Four tapered stainless/elastomer feet touching Z = 0.000 m up to lower chassis at Z = 0.099 m.
    for side in ("left", "right"):
        for end in ("front", "rear"):
            foot_body = bodies[f"lcs_foot_{side}_{end}"]
            add_col_geom(
                foot_body,
                f"lcs_foot_{side}_{end}_col",
                "cylinder",
                pos=(0.0, 0.0, 0.0495),
                size="0.0240 0.0495",
                friction="0.80 0.015 0.003",
                rgba=COL_BASE_RGBA,
            )

    # Underbody water/drain/power connection collars (Z = 0.094 .. 0.106 m, flush under lower chassis).
    for conn in ("water", "drain", "power"):
        add_col_geom(
            bodies[f"lcs_{conn}_connection"],
            f"lcs_{conn}_connection_col",
            "cylinder",
            pos=(0.0, 0.0, 0.0),
            size="0.0090 0.0060",
            rgba=COL_BASE_RGBA,
        )

    # Main chassis decomposition (leaves brew space below groups Y < -0.092, Z = 0.187 .. 0.359 open).
    add_col_geom(
        root,
        "lcs_lower_chassis_col",
        "box",
        pos=(0.0, 0.012, 0.143),
        size=(0.3285, 0.2460, 0.0440),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        root,
        "lcs_housing_contact",
        "box",
        pos=(0.0, 0.080, 0.273),
        size=(0.3190, 0.1720, 0.0860),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        root,
        "lcs_upper_housing_col",
        "box",
        pos=(0.0, 0.091, 0.434),
        size=(0.3460, 0.1910, 0.0750),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        root,
        "lcs_front_control_col",
        "box",
        pos=(0.0, -0.168, 0.431),
        size=(0.3190, 0.0680, 0.0580),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        root,
        "lcs_top_rail_left_col",
        "box",
        pos=(-0.335, 0.094, 0.5155),
        size=(0.0115, 0.1985, 0.0065),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        root,
        "lcs_top_rail_right_col",
        "box",
        pos=(0.335, 0.094, 0.5155),
        size=(0.0115, 0.1985, 0.0065),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        root,
        "lcs_top_rail_rear_col",
        "box",
        pos=(0.0, 0.285, 0.5155),
        size=(0.3240, 0.0075, 0.0065),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        root,
        "lcs_gauge_bezel_col",
        "cylinder",
        pos=(0.0, -0.240, 0.430),
        quat=Y_AXIS_QUAT,
        size="0.0270 0.0050",
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        root,
        "lcs_hot_water_nozzle_col",
        "cylinder",
        pos=(0.215, -0.180, 0.340),
        size="0.0100 0.0320",
        rgba=COL_BASE_RGBA,
    )

    # Rear upper panel, cup warmer tray, drip basin, and cup-support wire grate.
    add_col_geom(
        bodies["lcs_rear_panel"],
        "lcs_rear_panel_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.3435, 0.0020, 0.0780),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["lcs_cup_tray"],
        "lcs_cup_tray_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.3245, 0.1855, 0.0020),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["lcs_drip_tray"],
        "lcs_drip_tray_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.3300, 0.0930, 0.0410),
        rgba=COL_BASE_RGBA,
    )
    add_col_geom(
        bodies["lcs_drip_grate"],
        "lcs_cup_support",
        "box",
        pos=(0.0, 0.0, -0.0004),
        size=(0.3220, 0.0890, 0.0024),
        rgba=COL_WALL_RGBA,
    )
    add_col_geom(
        bodies["lcs_left_aux_button"],
        "lcs_left_aux_button_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.0135, 0.0020, 0.0165),
        rgba=COL_BASE_RGBA,
    )

    # Operational sites on static machine and grate (group 4, visible semi-transparent rgba).
    ET.SubElement(
        root,
        "site",
        name="lcs_left_group_seat_site",
        pos="-0.12 -0.177 0.318",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        root,
        "site",
        name="lcs_right_group_seat_site",
        pos="0.12 -0.177 0.318",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        root,
        "site",
        name="lcs_hot_water_outlet_site",
        pos="0.215 -0.180 0.308",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        bodies["lcs_drip_grate"],
        "site",
        name="lcs_drip_grate_site",
        type="box",
        pos="0 0 0.002",
        size="0.315 0.085 0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    actuator = ET.SubElement(app, "actuator")
    exclude_pairs: list[tuple[str, str, str]] = []

    for side in ("left", "right"):
        sign = -1.0 if side == "left" else 1.0

        # Saturated brew group head collider.
        add_col_geom(
            bodies[f"lcs_{side}_group"],
            f"lcs_{side}_group_col",
            "cylinder",
            pos=(0.0, 0.0, -0.0185),
            size="0.0460 0.0185",
            rgba=COL_BASE_RGBA,
        )

        # Portafilter + basket: vertical guided lift (holds against 5.89 N gravity) + bayonet lock rotation.
        pf = bodies[f"lcs_{side}_portafilter"]
        joint(
            pf,
            f"lcs_{side}_lift",
            (0, 0, 1),
            (-0.10, 0),
            0.600,
            "slide",
            damping=8.0,
            armature=0.010,
            frictionloss=10.0,
            com=(0.0, -0.020, -0.010),
            diaginertia=(0.0016, 0.0005, 0.0018),
        )
        joint(
            pf,
            f"lcs_{side}_lock",
            (0, 0, 1),
            (-0.62, 0),
            0.600,
            "hinge",
            damping=0.35,
            armature=0.004,
            frictionloss=0.25,
        )
        position(actuator, f"lcs_{side}_lift_control", f"lcs_{side}_lift", (-0.10, 0), True)
        position(actuator, f"lcs_{side}_lock_control", f"lcs_{side}_lock", (-0.62, 0))
        add_col_geom(
            pf,
            f"lcs_{side}_filter_contact",
            "cylinder",
            pos=(0.0, 0.0, -0.0055),
            size="0.0350 0.0145",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"lcs_{side}_pf_lugs_col",
            "box",
            pos=(0.0, 0.0, 0.0040),
            size=(0.0415, 0.0055, 0.0025),
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"lcs_{side}_pf_handle_col",
            "capsule",
            fromto=(0.0, -0.036, -0.005, 0.0, -0.145, -0.018),
            size="0.0135",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"lcs_{side}_pf_spout_l_col",
            "capsule",
            fromto=(0.0, 0.0, -0.020, -0.018, -0.010, -0.038),
            size="0.0050",
            rgba=COL_ACCESSORY_RGBA,
        )
        add_col_geom(
            pf,
            f"lcs_{side}_pf_spout_r_col",
            "capsule",
            fromto=(0.0, 0.0, -0.020, 0.018, -0.010, -0.038),
            size="0.0050",
            rgba=COL_ACCESSORY_RGBA,
        )
        ET.SubElement(
            pf,
            "site",
            name=f"lcs_{side}_pf_grasp_site",
            pos="0 -0.105 -0.014",
            size="0.005",
            group="4",
            rgba=SITE_GRASP_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_machine_{side}_pf", "lcs_machine", f"lcs_{side}_portafilter"),
                (f"exclude_{side}_group_pf", f"lcs_{side}_group", f"lcs_{side}_portafilter"),
                (f"exclude_tray_{side}_pf", "lcs_drip_tray", f"lcs_{side}_portafilter"),
                (f"exclude_grate_{side}_pf", "lcs_drip_grate", f"lcs_{side}_portafilter"),
                (f"exclude_{side}_wand_pf", f"lcs_{side}_steam_wand", f"lcs_{side}_portafilter"),
            ]
        )

        # Steam valve mount + six-lobe steam knob.
        add_col_geom(
            bodies[f"lcs_{side}_steam_valve"],
            f"lcs_{side}_steam_valve_col",
            "cylinder",
            pos=(0.0, 0.0, 0.0),
            quat=Y_AXIS_QUAT,
            size="0.0260 0.0045",
            rgba=COL_BASE_RGBA,
        )
        knob = bodies[f"lcs_{side}_steam_knob"]
        joint(
            knob,
            f"lcs_{side}_steam",
            (0, -1, 0),
            (0, math.pi),
            0.100,
            "hinge",
            damping=0.20,
            armature=0.002,
            frictionloss=0.08,
            com=(0.0, -0.0033, 0.0),
            diaginertia=(0.00008, 0.00008, 0.00008),
        )
        position(actuator, f"lcs_{side}_steam_control", f"lcs_{side}_steam", (0, math.pi))
        add_col_geom(
            knob,
            f"lcs_{side}_steam_knob_col",
            "cylinder",
            pos=(0.0, -0.0033, 0.0),
            quat=Y_AXIS_QUAT,
            size="0.0265 0.0212",
            rgba=COL_ARTIC_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_{side}_valve_knob", f"lcs_{side}_steam_valve", f"lcs_{side}_steam_knob"),
                (f"exclude_machine_{side}_knob", "lcs_machine", f"lcs_{side}_steam_knob"),
            ]
        )

        # Steam wand swivel + upper/lower tube capsules.
        wand = bodies[f"lcs_{side}_steam_wand"]
        joint(
            wand,
            f"lcs_{side}_wand_swivel",
            (0, 0, 1),
            (-0.7, 0.7),
            0.150,
            "hinge",
            damping=0.30,
            armature=0.003,
            frictionloss=0.15,
            com=(sign * 0.024, -0.030, -0.072),
            diaginertia=(0.00055, 0.00055, 0.00010),
        )
        position(actuator, f"lcs_{side}_wand_control", f"lcs_{side}_wand_swivel", (-0.7, 0.7))
        add_col_geom(
            wand,
            f"lcs_{side}_wand_swivel_col",
            "cylinder",
            pos=(0.0, 0.0, 0.0),
            size="0.0100 0.0100",
            rgba=COL_ARTIC_RGBA,
        )
        add_col_geom(
            wand,
            f"lcs_{side}_wand_upper_col",
            "capsule",
            fromto=(0.0, 0.0, -0.004, sign * 0.038, -0.048, -0.062),
            size="0.0065",
            rgba=COL_ARTIC_RGBA,
        )
        add_col_geom(
            wand,
            f"lcs_{side}_wand_lower_col",
            "capsule",
            fromto=(sign * 0.039, -0.049, -0.063, sign * 0.041, -0.053, -0.143),
            size="0.0050",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            wand,
            "site",
            name=f"lcs_{side}_steam_tip_site",
            pos=kit_numbers((sign * 0.041, -0.053, -0.148)),
            size="0.004",
            group="4",
            rgba=SITE_SUPPORT_RGBA,
        )
        exclude_pairs.extend(
            [
                (f"exclude_machine_{side}_wand", "lcs_machine", f"lcs_{side}_steam_wand"),
                (f"exclude_tray_{side}_wand", "lcs_drip_tray", f"lcs_{side}_steam_wand"),
                (f"exclude_grate_{side}_wand", "lcs_drip_grate", f"lcs_{side}_steam_wand"),
            ]
        )

        # Three volumetric dose buttons per group.
        for index in (1, 2, 3):
            button = bodies[f"lcs_{side}_dose_{index}"]
            joint_name = f"lcs_{side}_dose_{index}"
            joint(
                button,
                joint_name,
                (0, -1, 0),
                (-0.001, 0),
                0.005,
                "slide",
                damping=8.0,
                armature=0.001,
                frictionloss=0.05,
                diaginertia=(5e-6, 5e-6, 5e-6),
            )
            position(actuator, joint_name + "_control", joint_name, (-0.001, 0), True)
            add_col_geom(
                button,
                f"{joint_name}_col",
                "box",
                pos=(0.0, -0.001, 0.0),
                size=(0.0140, 0.0025, 0.0170),
                rgba=COL_ARTIC_RGBA,
            )
            exclude_pairs.append((f"exclude_machine_{joint_name}", "lcs_machine", joint_name))

    # Hot water dose button.
    hot_water_button = bodies["lcs_hot_water_button"]
    joint(
        hot_water_button,
        "lcs_hot_water",
        (0, -1, 0),
        (-0.001, 0),
        0.005,
        "slide",
        damping=8.0,
        armature=0.001,
        frictionloss=0.05,
        diaginertia=(5e-6, 5e-6, 5e-6),
    )
    position(actuator, "lcs_hot_water_control", "lcs_hot_water", (-0.001, 0), True)
    add_col_geom(
        hot_water_button,
        "lcs_hot_water_button_col",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.0135, 0.0020, 0.0165),
        rgba=COL_ARTIC_RGBA,
    )
    exclude_pairs.append(("exclude_machine_hot_water", "lcs_machine", "lcs_hot_water_button"))

    # Dual boiler pressure gauge needles (coffee & steam).
    for kind, npos, nsize in (
        ("coffee", (-0.0080, 0.0, 0.0025), (0.0082, 0.0006, 0.0030)),
        ("steam", (0.0040, 0.0, -0.0055), (0.0044, 0.0004, 0.0058)),
    ):
        body = bodies[f"lcs_{kind}_pressure_needle"]
        joint(
            body,
            f"lcs_{kind}_pressure",
            (0, -1, 0),
            (0, 4),
            0.001,
            "hinge",
            damping=0.005,
            armature=1e-6,
            frictionloss=0.002,
            diaginertia=(1e-7, 1e-7, 1e-7),
        )
        position(actuator, f"lcs_{kind}_pressure_control", f"lcs_{kind}_pressure", (0, 4))
        add_col_geom(
            body,
            f"lcs_{kind}_pressure_needle_col",
            "box",
            pos=npos,
            size=nsize,
            rgba=COL_ARTIC_RGBA,
        )
        exclude_pairs.append((f"exclude_machine_{kind}_needle", "lcs_machine", f"lcs_{kind}_pressure_needle"))
    exclude_pairs.append(
        ("exclude_coffee_steam_needles", "lcs_coffee_pressure_needle", "lcs_steam_pressure_needle")
    )

    # Rotary main power switch.
    switch = bodies["lcs_power_switch"]
    joint(
        switch,
        "lcs_power",
        (0, -1, 0),
        (0, math.pi / 2),
        0.060,
        "hinge",
        damping=0.15,
        armature=0.001,
        frictionloss=0.05,
        com=(0.0, -0.0032, 0.0),
        diaginertia=(0.00002, 0.00002, 0.00002),
    )
    position(actuator, "lcs_power_control", "lcs_power", (0, math.pi / 2))
    add_col_geom(
        switch,
        "lcs_power_switch_col",
        "box",
        pos=(0.0, -0.0032, 0.0),
        size=(0.0130, 0.0077, 0.0130),
        rgba=COL_ARTIC_RGBA,
    )
    exclude_pairs.append(("exclude_machine_power_switch", "lcs_machine", "lcs_power_switch"))

    contact = add_adjacent_excludes(app, exclude_pairs)

    write_xml(DIRECTORY / "appliance.xml", app)

    # Scene wrapper includes appliance.xml + rehearsal guided cups (for native Rust journeys).
    scene = ET.Element("mujoco", model="Linea Classic S AV — uncalibrated control rehearsal")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="1.0 -1.6 1.8", dir="-0.35 0.6 -0.8")
    scene_actuator = ET.SubElement(scene, "actuator")
    for label, x in (("left", -0.12), ("right", 0.12), ("hot_water", 0.215)):
        guided_cup(scene_world, scene_actuator, "lcs", label, (x, -0.195, 0.225), 0.032)
    write_xml(DIRECTORY / "scene.xml", scene)

    emit_standalone_models(
        DIRECTORY,
        model_name="lcs_machine",
        defaults=defaults,
        asset=asset,
        root_body=root,
        contact=contact,
    )

    (DIRECTORY / "physics-export.json").write_text(
        json.dumps(
            {
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "bodies": [obj.name for obj in parts],
                "published_mass_kg": 58.0,
                "envelope_m": [0.693, 0.585, 0.522],
                "scope": "MuJoCo 4.0 visual, contact, standalone model.xml, and native.xml with guided portafilter travel and live display readouts.",
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    spec = model_spec(DIRECTORY / "scene.xml", NAME)
    _model, rebuilt = kit_export_native_xml(
        DIRECTORY,
        NAME,
        mujoco,
        np,
        spec=spec,
        strip_general_input=False,
    )

    export_meta = json.loads((DIRECTORY / "physics-export.json").read_text())
    body_names = export_meta["bodies"]
    frames_report, motion_report = kit_verify_frames_and_motions(
        DIRECTORY,
        NAME,
        body_names,
        SCALAR_VISUAL_AXES,
        mujoco,
        DIRECTORY / "active-state-evidence",
        cleanup_inputs=True,
    )

    # Verify standalone model.xml compiles cleanly and settles with finite state.
    standalone_model = mujoco.MjModel.from_xml_path(str(DIRECTORY / "model.xml"))
    standalone_data = mujoco.MjData(standalone_model)
    mujoco.mj_forward(standalone_model, standalone_data)
    total_mass = float(np.sum(standalone_model.body_mass[1:]))
    assert abs(total_mass - 58.0) < 1e-6, f"Expected 58.0 kg standalone mass, got {total_mass}"

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
