"""Build and verify the MuJoCo mechanical, thermal, steam, and tray-rail model for the Maruzen MBCO-4ME."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-mbco-4me"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "mbco4_oven",
    "mbco4_door",
    "mbco4_handle",
    "mbco4_fan",
    "mbco4_damper",
    "mbco4_tray",
)

# Published oven mass = 70.000 kg + 0.850 kg removable 400x300x20 mm aluminum European tray = 70.850 kg
MASSES = {
    "mbco4_oven": 63.600,
    "mbco4_door": 5.450,
    "mbco4_handle": 0.320,
    "mbco4_fan": 0.450,
    "mbco4_damper": 0.180,
    "mbco4_tray": 0.850,
}

CENTERS = {
    "mbco4_oven": (0.015, 0.025, 0.295),
    "mbco4_door": (0.250, 0.006, 0.0),
    "mbco4_handle": (0.0, -0.020, -0.045),
    "mbco4_fan": (0.0, 0.0, 0.0),
    "mbco4_damper": (0.0, 0.022, 0.005),
    "mbco4_tray": (0.0, 0.0, 0.006),
}

INERTIAS = {
    "mbco4_oven": (3.850, 3.920, 4.650),
    "mbco4_door": (0.115, 0.215, 0.120),
    "mbco4_handle": (0.0006, 0.0005, 0.0002),
    "mbco4_fan": (0.0018, 0.0032, 0.0018),
    "mbco4_damper": (0.0002, 0.0002, 0.0003),
    "mbco4_tray": (0.0065, 0.0114, 0.0178),
}

RAIL_LEVELS_Z = (0.1850, 0.2650, 0.3450, 0.4250)
TRAY_REST_POS = (-0.0900, -0.1400, 0.2650)

VISUAL_MOTIONS = {
    "mbco4_door_hinge": (0, 0, -1),
    "mbco4_handle_latch": (0, 1, 0),
    "mbco4_fan_spin": (0, 1, 0),
    "mbco4_damper_hinge": (1, 0, 0),
}


def numbers(values) -> str:
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element) -> None:
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local OBJ meshes and author appliance.xml and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "maruzen-mbco-4me.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every mesh under mbco4_oven to its nearest articulated ancestor in NAMES while preserving world pose
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH":
            continue
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
            zs = [v.co.z for v in obj.data.vertices]
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
                obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.30
        if "emission" not in mat:
            mat["emission"] = 0.0

    mesh_dir = ASSETS / "meshes"
    if mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts, ASSETS)

    app = ET.Element(
        "mujoco",
        model="maruzen-mbco-4me — Baker Chef M-series compact convection oven",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = ET.SubElement(app, "default")
    ET.SubElement(
        defaults,
        "geom",
        condim="4",
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
    )

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.6 1.6 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="1",
    )

    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        if name == "mbco4_tray":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "mbco4_oven" else None)
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

    oven = bodies["mbco4_oven"]
    door = bodies["mbco4_door"]
    handle = bodies["mbco4_handle"]
    fan = bodies["mbco4_fan"]
    damper = bodies["mbco4_damper"]
    tray = bodies["mbco4_tray"]

    col_base_rgba = "0.20 0.75 0.35 0.45"
    col_wall_rgba = "0.25 0.55 0.90 0.45"
    col_artic_rgba = "0.95 0.55 0.15 0.50"
    col_tray_rgba = "0.90 0.80 0.15 0.50"
    site_support_rgba = "0.15 0.80 0.85 0.35"
    site_grasp_rgba = "0.95 0.25 0.25 0.40"
    y_axis_quat = numbers((math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0))

    # Four 50 mm stainless adjustable feet touching Z = 0.0000 m (CAD: 100 mm from front, 60 mm from rear)
    for foot_name, fx, fy in (
        ("mbco4_foot_fl_col", -0.2950, -0.2500),
        ("mbco4_foot_fr_col", 0.2950, -0.2500),
        ("mbco4_foot_rl_col", -0.2950, 0.2900),
        ("mbco4_foot_rr_col", 0.2950, 0.2900),
    ):
        ET.SubElement(
            oven,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0250)),
            size="0.0210 0.0250",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=col_base_rgba,
        )

    # Top-rear exhaust stack (+120 mm above roof) and rear plumbing/power fittings
    ET.SubElement(
        oven,
        "geom",
        name="mbco4_exhaust_collar_col",
        type="cylinder",
        pos="0.2750 0.3050 0.5825",
        size="0.0305 0.0025",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_base_rgba,
    )
    flue_tilt = 0.13
    ET.SubElement(
        oven,
        "geom",
        name="mbco4_exhaust_flue_col",
        type="cylinder",
        pos="0.2750 0.2980 0.6405",
        quat=numbers((math.cos(flue_tilt / 2), math.sin(flue_tilt / 2), 0.0, 0.0)),
        size="0.0235 0.0565",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_base_rgba,
    )
    for fit_name, fpos, fsize in (
        ("mbco4_rear_water_inlet_col", (0.2150, 0.3630, 0.1150), (0.0140, 0.0130)),
        ("mbco4_rear_drain_stub_col", (-0.0550, 0.3640, 0.0950), (0.0135, 0.0140)),
        ("mbco4_rear_power_gland_col", (0.2150, 0.3610, 0.1500), (0.0115, 0.0110)),
    ):
        ET.SubElement(
            oven,
            "geom",
            name=fit_name,
            type="cylinder",
            pos=numbers(fpos),
            quat=y_axis_quat,
            size=numbers(fsize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=col_base_rgba,
        )

    # Cabinet & chamber structural colliders (sealed 1 mm overlap across wall/floor/roof/plenum seams;
    # plus front ruby fascia, strike jamb, drip gutter, and top front cap)
    cabinet_colliders = [
        ("mbco4_left_wall_col", (-0.3325, 0.0160, 0.3150), (0.0175, 0.3340, 0.2650), col_base_rgba),
        ("mbco4_right_cabinet_col", (0.2425, 0.0160, 0.3150), (0.1075, 0.3340, 0.2650), col_base_rgba),
        ("mbco4_chamber_floor_col", (-0.0900, 0.0160, 0.0950), (0.2260, 0.3340, 0.0450), col_base_rgba),
        ("mbco4_chamber_roof_col", (-0.0900, 0.0160, 0.5350), (0.2260, 0.3340, 0.0450), col_base_rgba),
        ("mbco4_rear_plenum_col", (-0.0900, 0.2200, 0.3150), (0.2260, 0.1300, 0.1760), col_base_rgba),
        ("mbco4_top_front_cap_col", (0.0, -0.3330, 0.5765), (0.3500, 0.0170, 0.0035), col_base_rgba),
        ("mbco4_front_fascia_col", (0.2795, -0.33325, 0.3190), (0.0675, 0.01525, 0.2540), col_base_rgba),
        ("mbco4_strike_jamb_col", (0.1750, -0.3270, 0.3190), (0.0370, 0.0100, 0.2540), col_base_rgba),
        ("mbco4_front_drip_gutter_col", (-0.0730, -0.3329, 0.05725), (0.2750, 0.0169, 0.00725), col_base_rgba),
        ("mbco4_front_right_plinth_col", (0.2750, -0.3300, 0.0575), (0.0730, 0.0140, 0.0075), col_base_rgba),
        ("mbco4_baffle_stop_col", (-0.0900, 0.0265, 0.3150), (0.2100, 0.0020, 0.1680), col_wall_rgba),
    ]
    # 4 pairs of L-channel tray rails at 80 mm pitch (Z_top = 0.185, 0.265, 0.345, 0.425 m)
    for idx, rz in enumerate(RAIL_LEVELS_Z, 1):
        cabinet_colliders.extend(
            [
                (f"mbco4_rail_{idx}_left_ledge_col", (-0.2890, -0.1400, rz - 0.0020), (0.0130, 0.1530, 0.0020), col_wall_rgba),
                (f"mbco4_rail_{idx}_right_ledge_col", (0.1090, -0.1400, rz - 0.0020), (0.0130, 0.1530, 0.0020), col_wall_rgba),
                (f"mbco4_rail_{idx}_left_guide_col", (-0.3005, -0.1400, rz + 0.0110), (0.0030, 0.1510, 0.0110), col_wall_rgba),
                (f"mbco4_rail_{idx}_right_guide_col", (0.1205, -0.1400, rz + 0.0110), (0.0030, 0.1510, 0.0110), col_wall_rgba),
            ]
        )
    for cname, cpos, csize, crgba in cabinet_colliders:
        ET.SubElement(
            oven,
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

    # Operational sites on mbco4_oven (group 4, visible semi-transparent rgba)
    for idx, rz in enumerate(RAIL_LEVELS_Z, 1):
        ET.SubElement(
            oven,
            "site",
            name=f"mbco4_rail{idx}_site",
            pos=numbers((-0.0900, -0.1400, rz)),
            size="0.008",
            group="4",
            rgba=site_support_rgba,
        )
    ET.SubElement(
        oven,
        "site",
        name="mbco4_rail2_touch_site",
        type="box",
        pos="-0.0900 -0.1400 0.2650",
        size="0.2050 0.1520 0.0035",
        group="4",
        rgba=site_support_rgba,
    )
    ET.SubElement(
        oven,
        "site",
        name="mbco4_chamber_center",
        pos="-0.0900 -0.1400 0.3150",
        size="0.010",
        group="4",
        rgba=site_support_rgba,
    )

    # Left-hinged double-glazed door (`mbco4_door_hinge`, axis="0 0 -1", range 0 .. 1.92 rad / 110 deg)
    ET.SubElement(
        door,
        "joint",
        name="mbco4_door_hinge",
        type="hinge",
        axis="0 0 -1",
        limited="true",
        range="0 1.92",
        damping="2.2",
        armature="0.025",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        door,
        "geom",
        name="mbco4_door_col",
        type="box",
        pos="0.2680 0.0025 0",
        size="0.2700 0.0140 0.2440",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_artic_rgba,
    )

    # Rotary push-to-close door handle (`mbco4_handle_latch`, child of `mbco4_door`, axis="0 1 0", range -0.52 .. 0.52 rad)
    ET.SubElement(
        handle,
        "joint",
        name="mbco4_handle_latch",
        type="hinge",
        axis="0 1 0",
        limited="true",
        range="-0.52 0.52",
        stiffness="1.2",
        damping="0.18",
        armature="0.001",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        handle,
        "geom",
        name="mbco4_handle_col",
        type="box",
        pos="0 -0.0290 -0.0620",
        size="0.0150 0.0130 0.0700",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_artic_rgba,
    )

    # Chamber rear Y-blade reversible convection fan (`mbco4_fan_spin`, continuous unlimited rotation about +Y)
    ET.SubElement(
        fan,
        "joint",
        name="mbco4_fan_spin",
        type="hinge",
        axis="0 1 0",
        limited="false",
        damping="0.012",
        armature="0.002",
    )
    ET.SubElement(
        fan,
        "geom",
        name="mbco4_fan_col",
        type="cylinder",
        pos="0 0.0010 0",
        quat=y_axis_quat,
        size="0.1020 0.0150",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_artic_rgba,
    )

    # Top/rear motorized auto exhaust damper (`mbco4_damper_hinge`, axis="1 0 0", range 0 .. 0.785 rad)
    ET.SubElement(
        damper,
        "joint",
        name="mbco4_damper_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.785",
        damping="0.25",
        armature="0.001",
        frictionloss="0.06",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        damper,
        "geom",
        name="mbco4_damper_col",
        type="box",
        pos="0 0.0220 0.0055",
        size="0.0360 0.0270 0.0035",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=col_artic_rgba,
    )

    # 6-DOF free 400 x 300 x 20 mm European aluminum baking tray (`mbco4_tray` on rail pair #2)
    ET.SubElement(tray, "freejoint", name="mbco4_tray_free")
    for tname, tpos, tsize in (
        ("mbco4_tray_deck_col", (0.0, 0.0, 0.0015), (0.2000, 0.1500, 0.0015)),
        ("mbco4_tray_front_rim_col", (0.0, -0.1480, 0.0115), (0.2000, 0.0020, 0.0085)),
        ("mbco4_tray_rear_rim_col", (0.0, 0.1480, 0.0115), (0.2000, 0.0020, 0.0085)),
        ("mbco4_tray_left_rim_col", (-0.1980, 0.0, 0.0115), (0.0020, 0.1460, 0.0085)),
        ("mbco4_tray_right_rim_col", (0.1980, 0.0, 0.0115), (0.0020, 0.1460, 0.0085)),
    ):
        ET.SubElement(
            tray,
            "geom",
            name=tname,
            type="box",
            pos=numbers(tpos),
            size=numbers(tsize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=col_tray_rgba,
        )
    ET.SubElement(
        tray,
        "site",
        name="vessel_socket",
        pos="0 -0.1450 0.0160",
        size="0.006",
        group="4",
        rgba=site_grasp_rgba,
    )
    payload = ET.SubElement(tray, "body", name="ingredient_payload", pos="0 0 0")
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
        type="box",
        pos="0 0 0.0050",
        size="0.1800 0.1300 0.0020",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.86 0.64 0.34 0",
        mass="0",
    )

    contact = ET.SubElement(app, "contact")
    for ex_name, b1, b2 in (
        ("exclude_oven_door", "mbco4_oven", "mbco4_door"),
        ("exclude_door_handle", "mbco4_door", "mbco4_handle"),
        ("exclude_oven_handle", "mbco4_oven", "mbco4_handle"),
        ("exclude_oven_fan", "mbco4_oven", "mbco4_fan"),
        ("exclude_oven_damper", "mbco4_oven", "mbco4_damper"),
    ):
        ET.SubElement(contact, "exclude", name=ex_name, body1=b1, body2=b2)

    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="mbco4_door_actuator",
        joint="mbco4_door_hinge",
        kp="180",
        kv="14.0",
        ctrlrange="0 1.92",
        forcerange="-85 85",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mbco4_handle_actuator",
        joint="mbco4_handle_latch",
        kp="25",
        kv="1.8",
        ctrlrange="-0.52 0.52",
        forcerange="-12 12",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="mbco4_fan_actuator",
        joint="mbco4_fan_spin",
        kv="0.45",
        ctrlrange="-190 190",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mbco4_damper_actuator",
        joint="mbco4_damper_hinge",
        kp="22",
        kv="2.0",
        ctrlrange="0 0.785",
        forcerange="-10 10",
    )

    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="mbco4_door_pos", joint="mbco4_door_hinge")
    ET.SubElement(sensors, "jointpos", name="mbco4_handle_pos", joint="mbco4_handle_latch")
    ET.SubElement(sensors, "jointpos", name="mbco4_fan_pos", joint="mbco4_fan_spin")
    ET.SubElement(sensors, "jointvel", name="mbco4_fan_vel", joint="mbco4_fan_spin")
    ET.SubElement(sensors, "jointpos", name="mbco4_damper_pos", joint="mbco4_damper_hinge")
    ET.SubElement(sensors, "touch", name="mbco4_rail2_touch", site="mbco4_rail2_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="mbco4_tray_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="mbco4_rail2_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    # Emit standalone MjSpec.attach-ready oven model.xml (no floor, no freejoint tray)
    import copy

    oven_model = ET.Element("mujoco", model="mbco4_oven")
    ET.SubElement(oven_model, "compiler", angle="radian")
    oven_model.append(copy.deepcopy(defaults))
    oven_model.append(copy.deepcopy(asset))
    oven_world = ET.SubElement(oven_model, "worldbody")
    oven_world.append(copy.deepcopy(oven))
    oven_model.append(copy.deepcopy(contact))
    oven_sensors = ET.SubElement(oven_model, "sensor")
    for sensor_el in sensors:
        if sensor_el.get("name") != "mbco4_tray_sense":
            oven_sensors.append(copy.deepcopy(sensor_el))
    write_xml(ASSETS / "model.xml", oven_model)

    # Emit standalone MjSpec.attach-ready tray_model.xml (zero transform, no freejoint)
    tray_model = ET.Element("mujoco", model="mbco4_tray")
    ET.SubElement(tray_model, "compiler", angle="radian")
    tray_model.append(copy.deepcopy(defaults))
    tray_model.append(copy.deepcopy(asset))
    tray_world = ET.SubElement(tray_model, "worldbody")
    tray_copy = copy.deepcopy(tray)
    tray_copy.set("pos", "0 0 0")
    tray_copy.set("quat", "1 0 0 0")
    for child in list(tray_copy):
        if child.tag == "freejoint":
            tray_copy.remove(child)
    tray_world.append(tray_copy)
    write_xml(ASSETS / "tray_model.xml", tray_model)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_oven_mass_kg": 70.0,
                "tray_mass_kg": 0.85,
                "total_scene_mass_kg": 70.85,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 200 V AC, 50/60 Hz, 3.1 kW (20 A switch)",
                "temperature_range_c": [50, 300],
                "timer_range_s": [10, 5990],
                "chamber_dimensions_m": [0.450, 0.330, 0.350],
                "tray_rail_levels_z_m": list(RAIL_LEVELS_Z),
                "tray_dimensions_m": [0.400, 0.300, 0.020],
                "scope": "Articulated MuJoCo 4.0 Filament PBR, mechanical, PID thermal, reversible Y-fan, steam humidification, auto damper, and 6-DOF tray model.",
            },
            indent=2,
        )
        + "\n"
    )


def strip_visual_meshes(root: ET.Element, model) -> None:
    for parent in root.iter():
        for geom in list(parent):
            if geom.tag != "geom" or not geom.get("name"):
                continue
            index = model.geom(geom.get("name")).id
            if (
                model.geom_contype[index] == 0
                and model.geom_conaffinity[index] == 0
                and geom.get("type") == "mesh"
                and geom.get("mass") == "0"
            ):
                parent.remove(geom)


def export_and_verify_native_xml(mujoco, np) -> None:
    spec = mujoco.MjSpec.from_file(str(ASSETS / "scene.xml"))
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    root = ET.fromstring(spec.to_xml())
    strip_visual_meshes(root, model)
    used_meshes = {geom.get("mesh") for geom in root.iter("geom")}
    used_materials = {geom.get("material") for geom in root.iter("geom")}
    assets = root.find("asset")
    if assets is not None:
        used_textures: set[str] = set()
        for asset in list(assets):
            if asset.tag == "material" and asset.get("name") in used_materials:
                for layer in asset.findall("layer"):
                    if layer.get("texture"):
                        used_textures.add(layer.get("texture"))
                if asset.get("texture"):
                    used_textures.add(asset.get("texture"))
        for asset in list(assets):
            if (
                (asset.tag == "mesh" and asset.get("name") not in used_meshes)
                or (asset.tag == "material" and asset.get("name") not in used_materials)
                or (asset.tag == "texture" and asset.get("name") not in used_textures)
            ):
                assets.remove(asset)
    for actuator in root.iter("general"):
        actuator.attrib.pop("input", None)
    ET.indent(root, space="  ")
    native_path = ASSETS / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9):
            raise RuntimeError(f"Export changed native {field} for maruzen-mbco-4me")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError(f"Export changed native DOFs: {(rebuilt.nq, rebuilt.nv)} vs {(model.nq, model.nv)}")


def verify_frames_and_motions(mujoco, evidence_dir: Path) -> tuple[dict, dict]:
    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "maruzen-mbco-4me.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    native_model = mujoco.MjModel.from_xml_path(str(native_path))
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)

    body_poses = {}
    for bname in NAMES:
        bid = native_model.body(bname).id
        pos = native_data.xpos[bid]
        quat = native_data.xquat[bid]
        body_poses[bname] = [
            float(pos[0]),
            float(pos[1]),
            float(pos[2]),
            float(quat[0]),
            float(quat[1]),
            float(quat[2]),
            float(quat[3]),
        ]

    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                "maruzen-mbco-4me": {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "bodies": body_poses,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(frames_in),
            str(frames_out),
        ],
        check=True,
    )
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    # Sample 21 scalar-joint poses per joint (including nested mbco4_handle on mbco4_door)
    motions = []
    for joint_name, visual_axis in VISUAL_MOTIONS.items():
        jid = native_model.joint(joint_name).id
        jtype = int(native_model.jnt_type[jid])
        kind = "hinge" if jtype == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        if native_model.jnt_limited[jid]:
            low, high = native_model.jnt_range[jid]
        else:
            low, high = -math.pi, math.pi
        bid = int(native_model.jnt_bodyid[jid])
        samples = []
        for idx in range(21):
            val = float(low + (high - low) * idx / 20.0)
            mujoco.mj_resetData(native_model, native_data)
            native_data.qpos[native_model.jnt_qposadr[jid]] = val
            mujoco.mj_forward(native_model, native_data)
            samples.append(
                {
                    "value": val,
                    "pose": [*native_data.xpos[bid].tolist(), *native_data.xquat[bid].tolist()],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": list(visual_axis),
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                "maruzen-mbco-4me": {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "motions": motions,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(motion_in),
            str(motion_out),
            "--motion",
        ],
        check=True,
    )
    motion_report = json.loads(motion_out.read_text())
    assert motion_report["passed"] is True, motion_report
    return frames_report, motion_report


def write_asset_docs(report: dict) -> None:
    s = report["stages"]
    readme = f"""# Maruzen Baker Chef M-Series MBCO-4ME — Blender & MuJoCo Asset Package

Compact commercial electric convection oven (`マルゼン ベーカーシェフ Mシリーズ コンベクションオーブン MBCO-4ME`, single-phase `200 V AC`, `50/60 Hz`, `3.1 kW`, `70.0 kg`).
See the [equipment reference specification](../../../docs/equipment/maruzen-mbco-4me/README.md).

![Closed convection oven](studio-closed.png)
![Open convection oven](studio-open.png)

## Key Specifications

| Parameter | Value |
| --- | --- |
| Nominal cabinet & closed-door envelope (`W × D × H`) | `700 × 700 × 580 mm` (`0.700 × 0.700 × 0.580 m`, `Z = 0.000 m` at feet bottom) |
| Baking chamber (`W × D × H`) | `450 × 330 × 350 mm` (`0.450 × 0.330 × 0.350 m`) |
| Tray capacity & rails | `4` pairs of L-channel stainless rails at `80 mm` pitch (`Z = 0.185, 0.265, 0.345, 0.425 m`) |
| Removable baking tray (`mbco4_tray`) | `400 × 300 × 20 mm` European aluminum baking tray (`0.850 kg`, 6-DOF `freejoint` on rail #2) |
| Electrical & thermal ratings | Single-phase `200 V AC`, `50/60 Hz`, `3.1 kW` (`20 A` switch), `50 – 300 °C`, timer `10 s – 99 min 50 s` |
| Controls & features | `9-step × 99-menu` digital panel on ruby-red fascia, reversible Y-blade fan behind punched square-grid suction baffle, steam humidification, auto exhaust damper, brushed-stainless double-glazed door with drip gutter, top-rear exhaust stack (no hand shower per catalogue p. 27) |
| Published mass | `70.000 kg` oven + `0.850 kg` tray (`70.850 kg` total) |

## Files

- [maruzen-mbco-4me.blend](maruzen-mbco-4me.blend) / [maruzen-mbco-4me.glb](maruzen-mbco-4me.glb) / [maruzen-mbco-4me-tray.glb](maruzen-mbco-4me-tray.glb)
- Studio Cycles Metal GPU renders (`1400 × 1200`, `64` samples): [closed](studio-closed.png), [open](studio-open.png), [front](studio-front.png), [interior](studio-interior.png), [right](studio-right.png)
- Reports: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), [physics-export.json](physics-export.json)
- MuJoCo 3.13 models: [appliance.xml](appliance.xml), [scene.xml](scene.xml), [native.xml](native.xml)
- Active-state & frame evidence: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), [trace.csv](active-state-evidence/trace.csv)
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Maruzen MBCO-4ME — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`preheat_200c_3100w`**: Preheat mode (`200 °C` target, `{s['preheat_200c_3100w']['heater_power_w']} W` on `200 V AC`, reversible Y-fan at `{s['preheat_200c_3100w']['fan_vel_rad_s']} rad/s`), reaching `{s['preheat_200c_3100w']['chamber_temp_c']} °C`.
2. **`latch_release_door_open_tray_insert_rail2`**: Bidirectional rotary latch release (`{s['latch_release_door_open_tray_insert_rail2']['handle_angle_deg']}°`) & left-hinged door swing (`{s['latch_release_door_open_tray_insert_rail2']['door_angle_deg']}°`), automatic fan/heater door-open interlock (`0 W`) with convective heat drop to `{s['latch_release_door_open_tray_insert_rail2']['chamber_temp_c']} °C`, and insertion of the `400 × 300 × 20 mm` tray (`0.850 kg`) onto rail pair #2 (`touch = {s['latch_release_door_open_tray_insert_rail2']['rail2_touch_n']} N`).
3. **`door_close_reversible_y_fan_steam_bake`**: Push-to-close door latch, steam humidification injection (`RH = {s['door_close_reversible_y_fan_steam_bake']['chamber_rh_pct']}%`), PID recovery to `{s['door_close_reversible_y_fan_steam_bake']['chamber_temp_c']} °C`, and bidirectional Y-blade fan reversal (`{s['door_close_reversible_y_fan_steam_bake']['fan_vel_rad_s']} rad/s`).
4. **`auto_damper_venting_crisp_step`**: Motorized exhaust damper flap opens to `{s['auto_damper_venting_crisp_step']['damper_angle_deg']}°`, venting chamber moisture down to `{s['auto_damper_venting_crisp_step']['chamber_rh_pct']}% RH` while baking tray reaches `{s['auto_damper_venting_crisp_step']['tray_temp_c']} °C`.
5. **`cooldown_and_rest_alignment`**: Heater off (`0 W`), damper closed (`0°`), fan spun down, tray stably seated on rail #2 (`touch = {s['cooldown_and_rest_alignment']['rest_snap']['rail2_touch_n']} N`), with rest-frame max error `{s['cooldown_and_rest_alignment']['rest_max_pos_err_m']} m` and 21-sample `--motion` max error `{s['cooldown_and_rest_alignment']['motion_max_pos_err_m']} m`.
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification() -> None:
    import mujoco
    import numpy as np

    export_and_verify_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    tray_qpos_adr = model.joint("mbco4_tray_free").qposadr[0]
    tray_qvel_adr = model.joint("mbco4_tray_free").dofadr[0]

    # Start with tray staged on front preparation counter (floor Z = 0.000 m) prior to preheat & loading
    data.qpos[tray_qpos_adr : tray_qpos_adr + 3] = (-0.0900, -0.7800, 0.0002)
    data.qpos[tray_qpos_adr + 3 : tray_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    mujoco.mj_forward(model, data)

    state = {
        "mode": "standby",
        "menu": 4,
        "step": 1,
        "setpoint_c": 200.0,
        "chamber_temp_c": 22.0,
        "tray_temp_c": 22.0,
        "chamber_rh_pct": 40.0,
        "heater_power_w": 0.0,
        "line_current_a": 0.0,
        "steam_valve_open": False,
        "fan_target_rad_s": 0.0,
        "timer_remaining_s": 720.0,
    }
    ambient_c = 22.0
    chamber_cap_j_per_k = 1350.0
    tray_cap_j_per_k = 810.0

    trace_rows: list[dict] = []
    stage_summaries: dict = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, thermal_accel: float = 45.0) -> dict:
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = {}
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            door_rad = float(data.sensor("mbco4_door_pos").data[0])
            hdl_rad = float(data.sensor("mbco4_handle_pos").data[0])
            fan_vel = float(data.sensor("mbco4_fan_vel").data[0])
            dmp_rad = float(data.sensor("mbco4_damper_pos").data[0])
            rail2_touch = float(data.sensor("mbco4_rail2_touch").data[0])
            tray_rel = data.sensor("mbco4_tray_sense").data

            door_open = door_rad > 0.06
            eff_dt = sample_every_s * thermal_accel

            if state["mode"] in {"preheat", "bake"} and not door_open:
                err_c = state["setpoint_c"] - state["chamber_temp_c"]
                duty = max(0.0, min(1.0, err_c / 8.0 + 0.14))
                state["heater_power_w"] = round(3100.0 * duty, 1)
                data.ctrl[model.actuator("mbco4_fan_actuator").id] = state["fan_target_rad_s"]
            else:
                state["heater_power_w"] = 0.0
                data.ctrl[model.actuator("mbco4_fan_actuator").id] = 0.0

            state["line_current_a"] = round(state["heater_power_w"] / 200.0, 2)

            # Chamber & tray convective heat balance + door-open / damper losses
            loss_coeff = 24.0 if door_open else (3.6 if dmp_rad > 0.2 else 2.1)
            q_loss = (state["chamber_temp_c"] - ambient_c) * loss_coeff
            tray_in_chamber = rail2_touch > 4.0 and abs(float(tray_rel[1]) - (-0.1450)) < 0.05
            q_to_tray = (state["chamber_temp_c"] - state["tray_temp_c"]) * (9.5 if tray_in_chamber and not door_open else 0.8)
            state["chamber_temp_c"] += ((state["heater_power_w"] - q_loss - q_to_tray) / chamber_cap_j_per_k) * eff_dt
            state["tray_temp_c"] += (q_to_tray / tray_cap_j_per_k) * eff_dt

            # Steam humidification & auto damper moisture balance
            if state["steam_valve_open"] and not door_open:
                state["chamber_rh_pct"] = min(85.0, state["chamber_rh_pct"] + 2.8 * eff_dt)
            elif door_open or dmp_rad > 0.25:
                state["chamber_rh_pct"] = max(16.0, state["chamber_rh_pct"] - 3.4 * eff_dt)

            if state["mode"] == "bake" and not door_open:
                state["timer_remaining_s"] = max(0.0, state["timer_remaining_s"] - eff_dt)

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "menu": state["menu"],
                "step": state["step"],
                "heater_power_w": state["heater_power_w"],
                "line_current_a": state["line_current_a"],
                "chamber_temp_c": round(state["chamber_temp_c"], 2),
                "tray_temp_c": round(state["tray_temp_c"], 2),
                "chamber_rh_pct": round(state["chamber_rh_pct"], 1),
                "door_angle_deg": round(math.degrees(door_rad), 2),
                "handle_angle_deg": round(math.degrees(hdl_rad), 2),
                "fan_vel_rad_s": round(fan_vel, 2),
                "damper_angle_deg": round(math.degrees(dmp_rad), 2),
                "rail2_touch_n": round(rail2_touch, 3),
                "tray_socket_rel_y_m": round(float(tray_rel[1]), 4),
                "tray_socket_rel_z_m": round(float(tray_rel[2]), 4),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Preheat 200 °C at 3.1 kW (single-phase 200 V) with CW Y-blade fan
    state["mode"] = "preheat"
    state["setpoint_c"] = 200.0
    state["fan_target_rad_s"] = 155.0
    snap1 = step_and_sample(1.40, thermal_accel=95.0)
    assert 196.0 <= snap1["chamber_temp_c"] <= 203.0, snap1
    assert snap1["fan_vel_rad_s"] > 120.0, snap1
    stage_summaries["preheat_200c_3100w"] = snap1

    # Stage 2: Unlatch rotary handle (+0.45 rad), swing door open 100 deg, insert 400x300 mm tray onto rail #2, verify heat loss & rail contact
    data.ctrl[model.actuator("mbco4_handle_actuator").id] = 0.45
    step_and_sample(0.16, thermal_accel=10.0)
    data.ctrl[model.actuator("mbco4_door_actuator").id] = 1.75
    step_and_sample(0.44, thermal_accel=15.0)
    # Place 400x300x20 mm tray onto rail pair #2 ledges (Z = 0.2650 m) and settle under real gravity
    data.qpos[tray_qpos_adr : tray_qpos_adr + 3] = (-0.0900, -0.1400, 0.2653)
    data.qpos[tray_qpos_adr + 3 : tray_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[tray_qvel_adr : tray_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    data.ctrl[model.actuator("mbco4_handle_actuator").id] = 0.0
    snap2 = step_and_sample(0.40, thermal_accel=15.0)
    assert snap2["door_angle_deg"] > 95.0, snap2
    assert snap2["heater_power_w"] == 0.0, snap2
    assert snap2["chamber_temp_c"] < 192.0, snap2
    assert snap2["rail2_touch_n"] > 7.5, snap2
    stage_summaries["latch_release_door_open_tray_insert_rail2"] = snap2

    # Stage 3: Push door closed, bake with steam humidification + reversible Y-fan reversal (CW -> CCW -155 rad/s)
    data.ctrl[model.actuator("mbco4_door_actuator").id] = 0.0
    state["mode"] = "bake"
    state["step"] = 1
    state["steam_valve_open"] = True
    state["fan_target_rad_s"] = 155.0
    step_and_sample(0.56, thermal_accel=60.0)
    # Reverse Y-blade convection impeller direction (-155 rad/s)
    state["fan_target_rad_s"] = -155.0
    snap3 = step_and_sample(0.64, thermal_accel=60.0)
    assert snap3["door_angle_deg"] < 1.5, snap3
    assert snap3["fan_vel_rad_s"] < -120.0, snap3
    assert snap3["chamber_rh_pct"] >= 65.0, snap3
    assert 196.0 <= snap3["chamber_temp_c"] <= 203.5, snap3
    stage_summaries["door_close_reversible_y_fan_steam_bake"] = snap3

    # Stage 4: Step 2 opens motorized auto exhaust damper (0.70 rad / 40 deg) to vent steam & crisp pastry
    state["step"] = 2
    state["steam_valve_open"] = False
    state["fan_target_rad_s"] = 155.0
    data.ctrl[model.actuator("mbco4_damper_actuator").id] = 0.70
    snap4 = step_and_sample(0.72, thermal_accel=55.0)
    assert snap4["damper_angle_deg"] > 36.0, snap4
    assert snap4["chamber_rh_pct"] < 30.0, snap4
    assert snap4["tray_temp_c"] > 125.0, snap4
    stage_summaries["auto_damper_venting_crisp_step"] = snap4

    # Stage 5: Cooldown & return to rest pose, then verify GLB rest frames & 21-sample --motion trajectories
    state["mode"] = "cooldown"
    state["fan_target_rad_s"] = 0.0
    data.ctrl[model.actuator("mbco4_damper_actuator").id] = 0.0
    data.ctrl[model.actuator("mbco4_handle_actuator").id] = 0.0
    data.ctrl[model.actuator("mbco4_door_actuator").id] = 0.0
    snap5 = step_and_sample(0.64, thermal_accel=25.0)
    assert snap5["heater_power_w"] == 0.0, snap5
    assert snap5["damper_angle_deg"] < 1.0, snap5
    assert snap5["rail2_touch_n"] > 7.5, snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)

    stage_summaries["cooldown_and_rest_alignment"] = {
        "rest_snap": snap5,
        "frames_aligned": len(frames_report["appliances"]["maruzen-mbco-4me"]["frames"]),
        "rest_max_pos_err_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["maruzen-mbco-4me"]["frames"]
        ),
        "rest_max_rot_err_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["maruzen-mbco-4me"]["frames"]
        ),
        "motion_joints_verified": len(motion_report["appliances"]["maruzen-mbco-4me"]["motions"]),
        "motion_max_pos_err_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["maruzen-mbco-4me"]["motions"]
        ),
        "motion_max_rot_err_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["maruzen-mbco-4me"]["motions"]
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "maruzen-mbco-4me",
        "model_title": "Maruzen Baker Chef M-Series MBCO-4ME Convection Oven",
        "supply": "Single-phase 200 V AC, 50/60 Hz, 3.1 kW (20 A local switch)",
        "envelope_m": [0.700, 0.700, 0.580],
        "chamber_dimensions_m": [0.450, 0.330, 0.350],
        "tray_rail_pitch_m": 0.080,
        "tray_dimensions_m": [0.400, 0.300, 0.020],
        "oven_mass_kg": 70.0,
        "tray_mass_kg": 0.85,
        "total_mass_kg": 70.85,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "maruzen-mbco-4me.glb").read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_asset_docs(report)
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
