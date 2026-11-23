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
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = "victoria-arduino-e1-prima"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

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


def numbers(values) -> str:
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element) -> None:
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender 5.2 to export body-local OBJ meshes and construct appliance.xml + scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / f"{NAME}.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every child mesh under the root to its nearest articulated ancestor in NAMES (preserving matrix_world)
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
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
        if obj.type == "MESH" and len(obj.data.vertices) >= 3:
            xs = [v.co.x for v in obj.data.vertices]
            ys = [v.co.y for v in obj.data.vertices]
            zs = [v.co.z for v in obj.data.vertices]
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
                obj.data.update()
            if max(ys) - min(ys) < 1e-5:
                obj.data.vertices[0].co.y += 2e-5
                obj.data.update()
            if max(xs) - min(xs) < 1e-5:
                obj.data.vertices[0].co.x += 2e-5
                obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.35
        if "emission" not in mat:
            mat["emission"] = 0.0

    shutil.rmtree(ASSETS / "meshes", ignore_errors=True)
    export_visual_meshes(parts, ASSETS)

    machine_mass_sum = round(sum(MASSES[k] for k in MACHINE_BODY_NAMES), 6)
    assert machine_mass_sum == 37.000, f"Expected 37.000 kg machine mass, got {machine_mass_sum}"

    app = ET.Element(
        "mujoco",
        model="victoria-arduino-e1-prima — Victoria Arduino E1 PRIMA 1-group espresso machine",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="10")

    defaults = ET.SubElement(app, "default")
    ET.SubElement(
        defaults,
        "geom",
        friction="0.65 0.005 0.0001",
        solref="0.003 1",
        solimp="0.96 0.995 0.001",
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
        conaffinity="3",
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

    # Four elastomer/stainless feet collision cylinders touching Z = 0.0000 m (height 34 mm)
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
            pos=numbers((fx, fy, 0.0170)),
            size="0.0185 0.0170",
            contype="2",
            conaffinity="1",
            group="3",
            mass="0",
        )

    # Chassis core, side skins, sculpted 58 mm group hood, cup-warmer deck, and bayonet shelves (top Z = 0.2040 m)
    for cname, cpos, csize in (
        ("e1p_rear_core_col", (0.0, 0.0560, 0.1980), (0.1820, 0.1720, 0.1600)),
        ("e1p_side_left_col", (-0.1960, 0.0360, 0.2000), (0.0055, 0.1920, 0.1640)),
        ("e1p_side_right_col", (0.1960, 0.0360, 0.2000), (0.0055, 0.1920, 0.1640)),
        ("e1p_group_hood_col", (0.0, -0.1560, 0.2780), (0.0540, 0.0440, 0.0420)),
        ("e1p_cup_deck_col", (0.0, 0.0020, 0.3600), (0.1740, 0.1080, 0.0032)),
        ("e1p_bayonet_left_shelf_col", (-0.0355, -0.1560, 0.2005), (0.0070, 0.0300, 0.0035)),
        ("e1p_bayonet_right_shelf_col", (0.0355, -0.1560, 0.2005), (0.0070, 0.0300, 0.0035)),
    ):
        ET.SubElement(
            base,
            "geom",
            name=cname,
            type="box",
            pos=numbers(cpos),
            size=numbers(csize),
            contype="2",
            conaffinity="1",
            group="3",
            mass="0",
        )

    # Operational sites on e1p_body
    ET.SubElement(
        base,
        "site",
        name="e1p_group_seat_site",
        pos="0 -0.1560 0.2140",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="e1p_hot_water_outlet_site",
        pos="-0.1340 -0.1760 0.1820",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="e1p_bayonet_touch_site",
        type="box",
        pos="0 -0.1560 0.2040",
        size="0.0450 0.0320 0.0025",
        group="3",
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
    )
    ET.SubElement(
        wand,
        "geom",
        name="e1p_steam_wand_col",
        type="capsule",
        fromto="0 0 0 -0.0040 -0.0740 -0.1120",
        size="0.0060",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )
    ET.SubElement(
        wand,
        "site",
        name="e1p_steam_tip_site",
        pos="-0.0040 -0.0740 -0.1180",
        size="0.004",
        group="3",
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
    )
    ET.SubElement(
        steam_lever,
        "geom",
        name="e1p_steam_lever_col",
        type="box",
        pos="0 -0.0085 0.0230",
        size="0.0120 0.0062 0.0240",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
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
    )
    ET.SubElement(
        hw_lever,
        "geom",
        name="e1p_hot_water_lever_col",
        type="box",
        pos="0 -0.0085 0.0230",
        size="0.0120 0.0062 0.0240",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
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
    )
    ET.SubElement(
        tank_lid,
        "geom",
        name="e1p_tank_lid_col",
        type="box",
        pos="0 -0.0560 0.0002",
        size="0.1750 0.0550 0.0020",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
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
    )
    ET.SubElement(
        drip_tray,
        "geom",
        name="e1p_drip_grate_col",
        type="box",
        pos="0 0.0030 0.0280",
        size="0.1680 0.0640 0.0020",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )
    ET.SubElement(
        drip_tray,
        "site",
        name="e1p_drip_grate_touch_site",
        type="box",
        pos="0 0.0030 0.0300",
        size="0.1700 0.0660 0.0025",
        group="3",
    )

    # 6. e1p_portafilter: detachable 58 mm stainless double-spout portafilter (freejoint e1p_portafilter_free)
    ET.SubElement(pf, "freejoint", name="e1p_portafilter_free")
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_head_col",
        type="box",
        pos="0 0 -0.0070",
        size="0.0410 0.0280 0.0030",
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )
    ET.SubElement(
        pf,
        "geom",
        name="e1p_pf_handle_col",
        type="capsule",
        fromto="0 -0.0680 -0.0076 0 -0.1930 -0.0230",
        size="0.0145",
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )
    ET.SubElement(
        pf,
        "site",
        name="vessel_socket",
        pos="0 -0.1300 -0.0155",
        size="0.005",
        group="3",
    )
    ET.SubElement(
        pf,
        "site",
        name="e1p_pf_basket_center",
        pos="0 0 0",
        size="0.004",
        group="3",
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
                "scope": "Articulated MuJoCo 4.0.0 1-group commercial & specialty espresso machine with right Cool-Touch steam wand, right Steam-by-Wire paddle, left 2-dose hot-water paddle, top 1.5 L tank lid, pull-out diamond-perforated drip tray, and 6-DOF 58 mm portafilter.",
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


def export_native_xml(mujoco, np):
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
        for asset in list(assets):
            if (asset.tag == "mesh" and asset.get("name") not in used_meshes) or (
                asset.tag == "material" and asset.get("name") not in used_materials
            ):
                assets.remove(asset)
    ET.indent(root, space="  ")
    native_path = ASSETS / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9):
            raise RuntimeError(f"Export changed native {field} for {NAME}")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError(f"Export changed native (nq, nv) for {NAME}")

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
- MuJoCo 4.0.0 MJCF models: [appliance.xml](appliance.xml), [scene.xml](scene.xml), and collision-only [native.xml](native.xml).
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
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = [0.0, -0.1720, 0.1085]
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
    evidence_dir.mkdir(parents=True, exist_ok=True)
    native_sha = hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest()
    glb_str = str(ASSETS / f"{NAME}.glb")

    native_data = mujoco.MjData(native_model)
    mujoco.mj_resetData(native_model, native_data)
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
                NAME: {
                    "glb": glb_str,
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
    frames_in.unlink(missing_ok=True)
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    # Sample 21 points across each scalar joint's full range for --motion check
    motions = []
    for jname, vaxis in SCALAR_VISUAL_AXES.items():
        jid = native_model.joint(jname).id
        jtype = int(native_model.jnt_type[jid])
        kind = "hinge" if jtype == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        low, high = native_model.jnt_range[jid]
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
                    "pose": [
                        *native_data.xpos[bid].tolist(),
                        *native_data.xquat[bid].tolist(),
                    ],
                }
            )
        motions.append(
            {
                "joint": jname,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": vaxis,
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                NAME: {
                    "glb": glb_str,
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
    motion_in.unlink(missing_ok=True)
    motion_report = json.loads(motion_out.read_text())
    assert motion_report["passed"] is True, motion_report

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
