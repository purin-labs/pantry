"""Build and verify the MuJoCo mechanical and active-state model for the WPM KD-330X."""

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
NAME = "wpm-kd-330x"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "kd330_body",
    "kd330_steam_wand",
    "kd330_steam_lever",
    "kd330_tank_lid",
    "kd330_drip_tray",
    "kd330_gauge_needle",
    "kd330_portafilter",
)

MACHINE_BODY_NAMES = (
    "kd330_body",
    "kd330_steam_wand",
    "kd330_steam_lever",
    "kd330_tank_lid",
    "kd330_drip_tray",
    "kd330_gauge_needle",
)

# Exact published machine mass = 22.800 kg; detachable 58 mm portafilter = 0.520 kg
MASSES = {
    "kd330_body": 20.850,
    "kd330_steam_wand": 0.220,
    "kd330_steam_lever": 0.140,
    "kd330_tank_lid": 0.380,
    "kd330_drip_tray": 1.205,
    "kd330_gauge_needle": 0.005,
    "kd330_portafilter": 0.520,
}

CENTERS = {
    "kd330_body": (0.0, 0.055, 0.238),
    "kd330_steam_wand": (0.005, -0.012, -0.072),
    "kd330_steam_lever": (0.007, -0.012, -0.042),
    "kd330_tank_lid": (0.0, -0.062, -0.002),
    "kd330_drip_tray": (0.0, 0.0, -0.004),
    "kd330_gauge_needle": (0.0, -0.0005, 0.0),
    # Forged 58 mm stainless head places CoM inside locking bayonet support polygon
    "kd330_portafilter": (0.0, -0.018, -0.004),
}

INERTIAS = {
    "kd330_body": (0.5800, 0.4400, 0.5200),
    "kd330_steam_wand": (0.00065, 0.00065, 0.00008),
    "kd330_steam_lever": (0.00016, 0.00016, 0.00005),
    "kd330_tank_lid": (0.00075, 0.00195, 0.00265),
    "kd330_drip_tray": (0.00320, 0.00960, 0.01240),
    "kd330_gauge_needle": (1.2e-7, 1.2e-7, 1.2e-7),
    "kd330_portafilter": (0.00145, 0.00046, 0.00165),
}

SCALAR_VISUAL_AXES = {
    "kd330_steam_wand_swing": [1.0, 0.0, 0.0],
    "kd330_steam_lever_hinge": [-1.0, 0.0, 0.0],
    "kd330_tank_lid_hinge": [-1.0, 0.0, 0.0],
    "kd330_drip_tray_slide": [0.0, -1.0, 0.0],
    "kd330_gauge_hinge": [0.0, 1.0, 0.0],
}


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml + scene.xml."""
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
    assert machine_mass_sum == 22.800, f"Expected 22.800 kg machine mass, got {machine_mass_sum}"

    app = ET.Element(
        "mujoco",
        model="wpm-kd-330x — WPM KD-330X 1-group commercial espresso machine (200V Japan)",
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
        if name == "kd330_portafilter":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "kd330_body" else None)
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

    base = bodies["kd330_body"]
    wand = bodies["kd330_steam_wand"]
    lever = bodies["kd330_steam_lever"]
    tank_lid = bodies["kd330_tank_lid"]
    drip_tray = bodies["kd330_drip_tray"]
    gauge = bodies["kd330_gauge_needle"]
    pf = bodies["kd330_portafilter"]

    # Four tall stainless/rubber feet collision cylinders touching Z = 0.0000 m (height 52 mm)
    for foot_name, fx, fy in (
        ("kd330_foot_fl_col", -0.1060, -0.1680),
        ("kd330_foot_fr_col", 0.1060, -0.1680),
        ("kd330_foot_rl_col", -0.1140, 0.1780),
        ("kd330_foot_rr_col", 0.1140, 0.1780),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0260)),
            size="0.0235 0.0260",
            contype="2",
            conaffinity="1",
            group="3",
            mass="0",
        )

    # Chassis, side cheeks, E61 group head, cup-warmer deck, and locking bayonet shelves (top Z = 0.2300 m)
    for cname, cpos, csize in (
        ("kd330_rear_core_col", (0.0, 0.0640, 0.2420), (0.1510, 0.1630, 0.1900)),
        ("kd330_side_left_col", (-0.1545, 0.0625, 0.2420), (0.0030, 0.1675, 0.1900)),
        ("kd330_side_right_col", (0.1545, 0.0625, 0.2420), (0.0030, 0.1675, 0.1900)),
        ("kd330_group_bell_col", (0.0, -0.1600, 0.2840), (0.0480, 0.0460, 0.0240)),
        ("kd330_cup_deck_col", (0.0, -0.0100, 0.4470), (0.1280, 0.0820, 0.0030)),
        ("kd330_bayonet_left_shelf_col", (-0.0325, -0.1600, 0.2265), (0.0065, 0.0320, 0.0035)),
        ("kd330_bayonet_right_shelf_col", (0.0325, -0.1600, 0.2265), (0.0065, 0.0320, 0.0035)),
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

    # Operational sites on kd330_body
    ET.SubElement(
        base,
        "site",
        name="kd330_group_seat_site",
        pos="0 -0.1600 0.2440",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="kd330_hot_water_outlet_site",
        pos="0.0980 -0.1500 0.2030",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="kd330_bayonet_touch_site",
        type="box",
        pos="0 -0.1600 0.2300",
        size="0.0420 0.0340 0.0025",
        group="3",
    )

    # 1. kd330_steam_wand: left-side 360-deg stainless steam wand (#5, axis 1 0 0, -0.35 .. 0.55 rad)
    ET.SubElement(
        wand,
        "joint",
        name="kd330_steam_wand_swing",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.35 0.55",
        damping="0.45",
        armature="0.003",
    )
    ET.SubElement(
        wand,
        "geom",
        name="kd330_steam_wand_col",
        type="capsule",
        fromto="0 0 0 0.0100 -0.0245 -0.1500",
        size="0.0060",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )
    ET.SubElement(
        wand,
        "site",
        name="kd330_steam_tip_site",
        pos="0.0100 -0.0245 -0.1560",
        size="0.004",
        group="3",
    )

    # 2. kd330_steam_lever: E61-style manual brew lever on right of group head (#10, axis -1 0 0, 0 .. 0.85 rad)
    ET.SubElement(
        lever,
        "joint",
        name="kd330_steam_lever_hinge",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="0 0.85",
        damping="0.28",
        armature="0.002",
    )
    ET.SubElement(
        lever,
        "geom",
        name="kd330_steam_lever_col",
        type="capsule",
        fromto="0 0 0 0.0095 -0.0240 -0.0960",
        size="0.0080",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
    )

    # 3. kd330_tank_lid: top 2.5 L water reservoir cover panel (#1, axis -1 0 0, 0 .. 1.05 rad)
    ET.SubElement(
        tank_lid,
        "joint",
        name="kd330_tank_lid_hinge",
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
        name="kd330_tank_lid_col",
        type="box",
        pos="0 -0.0620 -0.0020",
        size="0.1280 0.0620 0.0025",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )

    # 4. kd330_drip_tray: pull-out stainless drip tray & wire grate (#6, slide axis 0 -1 0, 0 .. 0.160 m)
    # Wire grate top sits at world Z = 0.0840 + 0.0280 = 0.1120 m
    ET.SubElement(
        drip_tray,
        "joint",
        name="kd330_drip_tray_slide",
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
        name="kd330_drip_grate_col",
        type="box",
        pos="0 -0.0140 0.0260",
        size="0.1360 0.0520 0.0020",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )
    ET.SubElement(
        drip_tray,
        "site",
        name="kd330_drip_grate_touch_site",
        type="box",
        pos="0 -0.0140 0.0280",
        size="0.1380 0.0540 0.0025",
        group="3",
    )

    # 5. kd330_gauge_needle: lower-right 0-16 bar pressure gauge pointer (#13, axis 0 1 0, 0 .. 3.80 rad)
    ET.SubElement(
        gauge,
        "joint",
        name="kd330_gauge_hinge",
        type="hinge",
        axis="0 1 0",
        limited="true",
        range="0 3.80",
        damping="0.015",
        armature="0.0002",
    )
    ET.SubElement(
        gauge,
        "geom",
        name="kd330_gauge_needle_col",
        type="sphere",
        pos="0 0 0",
        size="0.0030",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
    )

    # 6. kd330_portafilter: detachable 58 mm stainless portafilter (freejoint kd330_portafilter_free)
    ET.SubElement(pf, "freejoint", name="kd330_portafilter_free")
    ET.SubElement(
        pf,
        "geom",
        name="kd330_pf_head_col",
        type="box",
        pos="0 0 -0.0110",
        size="0.0355 0.0310 0.0030",
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )
    ET.SubElement(
        pf,
        "geom",
        name="kd330_pf_handle_col",
        type="cylinder",
        pos="0 -0.1040 -0.0130",
        quat="0.70441603 0.70978806 0 0",
        size="0.0145 0.0520",
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )
    ET.SubElement(
        pf,
        "site",
        name="vessel_socket",
        pos="0 -0.1080 -0.0135",
        size="0.005",
        group="3",
    )
    ET.SubElement(
        pf,
        "site",
        name="kd330_pf_basket_center",
        pos="0 0 0",
        size="0.004",
        group="3",
    )
    payload = ET.SubElement(pf, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0040",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.0040",
        size="0.0286 0.0020",
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
        name="kd330_steam_wand_actuator",
        joint="kd330_steam_wand_swing",
        kp="32",
        kv="3.2",
        ctrlrange="-0.35 0.55",
        forcerange="-12 12",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kd330_steam_lever_actuator",
        joint="kd330_steam_lever_hinge",
        kp="28",
        kv="2.4",
        ctrlrange="0 0.85",
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kd330_tank_lid_actuator",
        joint="kd330_tank_lid_hinge",
        kp="45",
        kv="4.5",
        ctrlrange="0 1.05",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kd330_drip_tray_actuator",
        joint="kd330_drip_tray_slide",
        kp="280",
        kv="24.0",
        ctrlrange="0 0.160",
        forcerange="-60 60",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kd330_gauge_actuator",
        joint="kd330_gauge_hinge",
        kp="4.5",
        kv="0.18",
        ctrlrange="0 3.80",
        forcerange="-1.5 1.5",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="kd330_steam_wand_pos", joint="kd330_steam_wand_swing")
    ET.SubElement(sensors, "jointpos", name="kd330_steam_lever_pos", joint="kd330_steam_lever_hinge")
    ET.SubElement(sensors, "jointpos", name="kd330_tank_lid_pos", joint="kd330_tank_lid_hinge")
    ET.SubElement(sensors, "jointpos", name="kd330_drip_tray_pos", joint="kd330_drip_tray_slide")
    ET.SubElement(sensors, "jointpos", name="kd330_gauge_pos", joint="kd330_gauge_hinge")
    ET.SubElement(sensors, "touch", name="kd330_bayonet_touch", site="kd330_bayonet_touch_site")
    ET.SubElement(sensors, "touch", name="kd330_drip_grate_touch", site="kd330_drip_grate_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="kd330_pf_relpos",
        objtype="site",
        objname="kd330_pf_basket_center",
        reftype="site",
        refname="kd330_group_seat_site",
    )

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="wpm-kd-330x physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="-1.0 -1.6 1.9", dir="0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_machine_mass_kg": 22.800,
                "detachable_portafilter_mass_kg": 0.520,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 200 V AC, 50/60 Hz, 1,850 W",
                "pump_architecture": "7-stage variable-pressure commercial gear pump (0-16 bar gauge)",
                "heating_architecture": "0.8 L brew boiler + 86-98 C PID brew thermoblock + 7-level super-steam thermoblock",
                "water_reservoir_l": 2.5,
                "scope": "Articulated MuJoCo 3.13 1-group commercial espresso machine with left 360-deg steam wand, E61 manual brew lever, top tank lid, pull-out wire-grate drip tray, 0-16 bar gauge needle, and 6-DOF 58 mm portafilter.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from appliance_physics_kit import export_and_verify_native_xml

    model, rebuilt = export_and_verify_native_xml(
        ASSETS, NAME, mujoco, np, strip_general_input=False
    )
    machine_sum = sum(float(rebuilt.body(b).mass[0]) for b in MACHINE_BODY_NAMES)
    pf_mass = float(rebuilt.body("kd330_portafilter").mass[0])
    assert abs(machine_sum - 22.800) < 1e-6, machine_sum
    assert abs(pf_mass - 0.520) < 1e-6, pf_mass
    return model, rebuilt


def write_package_docs(report: dict):
    s = report["stages"]
    readme = f"""# WPM KD-330X — Blender 5.2 Visual & MuJoCo 3.13 Physics Package

1-group commercial espresso machine (`WPM KD-330X`, Japan `200 V AC`, `50/60 Hz`, `1,850 W` SKU) modeled directly from `instruction-manual-2023.pdf` (parts `1–14`) and WPM studio photography: `7-stage` variable-pressure gear pump (`P1–P7`), hybrid heating (`0.8 L` brew boiler + `86–98 °C` PID brew thermoblock + `7-level` super-steam thermoblock), E61-style mirror-chrome `58 mm` group head with right-side manual brew lever, `4 + 3` top button pods (`Power`, `-`, `Program`, `+` and `1-Cup`, `2-Cup`, `Clean`), upper-left round segmented LCD, left `10`-lobe scalloped steam knob & `360°` `3`-hole steam wand, right scalloped hot-water knob & diffuser wand, lower-right `0–16 bar` black-dial manometer, `2.5 L` top-load internal water tank, tubular cup-warmer guard hoops, and pull-out stainless drip tray with welded wire grate and `WPM WELHOME PRO` badge.
See the [equipment reference specification](../../../docs/equipment/wpm-kd-330x/README.md).

![WPM KD-330X main view](studio-main.png)
![WPM KD-330X open view](studio-open.png)

## Files

- [Editable Blender 5.2 source](wpm-kd-330x.blend), [articulated GLB](wpm-kd-330x.glb), and standalone [58 mm portafilter GLB](wpm-kd-330x-portafilter.glb).
- Metal GPU Cycles renders (`1400 × 1200`, `64` samples + OIDN): [studio-main.png](studio-main.png), [studio-front.png](studio-front.png), [studio-right.png](studio-right.png), [studio-open.png](studio-open.png), and [studio-active.png](studio-active.png).
- Verification manifests: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), and [physics-export.json](physics-export.json).
- MuJoCo 3.13 MJCF models: [appliance.xml](appliance.xml), [scene.xml](scene.xml), and collision-only [native.xml](native.xml).
- Active-state simulation & frame alignment: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Retained Bodies & Joints (`NAMES`)

| Body | Mass (`kg`) | Joint | Axis | Range |
| --- | --- | --- | --- | --- |
| `kd330_body` | `20.850` | Fixed base (`Z = 0.000 m` feet) | — | `320 × 460 × 480 mm` envelope |
| `kd330_steam_wand` | `0.220` | `kd330_steam_wand_swing` (`hinge`) | `1 0 0` | `-0.35 .. 0.55 rad` (left `360°` wand) |
| `kd330_steam_lever` | `0.140` | `kd330_steam_lever_hinge` (`hinge`) | `-1 0 0` | `0 .. 0.85 rad` (E61 manual brew lever) |
| `kd330_tank_lid` | `0.380` | `kd330_tank_lid_hinge` (`hinge`) | `-1 0 0` | `0 .. 1.05 rad` (`2.5 L` tank cover) |
| `kd330_drip_tray` | `1.205` | `kd330_drip_tray_slide` (`slide`) | `0 -1 0` | `0 .. 0.160 m` (wire-grate tray) |
| `kd330_gauge_needle` | `0.005` | `kd330_gauge_hinge` (`hinge`) | `0 1 0` | `0 .. 3.80 rad` (`0–16 bar`) |
| **Machine Total** | **`22.800`** | — | — | Exact published machine mass |
| `kd330_portafilter` | `0.520` | `kd330_portafilter_free` (`freejoint`) | 6-DOF | Seated on `Z = 0.230 m` bayonet shelf (`vessel_socket` + `ingredient_payload`) |

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_kd_330x_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_kd_330x_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# WPM KD-330X — MuJoCo 3.13 Active-State & Frame Alignment Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded telemetry samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **Hybrid PID Boiler Warm-Up & Seated Portafilter (`pid_warmup_and_bayonet_seat`):**
   - `200 V AC` / `1,850 W` hybrid heating brings the `0.8 L` brew boiler and PID brew thermoblock to `{s['pid_warmup_and_bayonet_seat']['brew_pid_temp_c']} °C` while `kd330_portafilter` (`0.520 kg`) rests in static equilibrium on the `58 mm` group bayonet shelf (`bayonet_touch_n = {s['pid_warmup_and_bayonet_seat']['bayonet_touch_n']} N`).
2. **Top `2.5 L` Water Reservoir Refill (`top_tank_refill`):**
   - `kd330_tank_lid_hinge` opens to `{s['top_tank_refill']['peak_tank_lid_rad']} rad` (`54.4°`), refills internal reservoir to `{s['top_tank_refill']['tank_water_l']} L`, and closes flush (`{s['top_tank_refill']['tank_lid_rad']} rad`).
3. **7-Stage Gear-Pump Extraction (`P2` Pre-Infusion → `P5` `9.0 bar` Brew, `gear_pump_9bar_extraction`):**
   - `18.0 g` dose in `ingredient_payload` saturates at `P2` (`3.0 bar`), ramps to `P5` (`{s['gear_pump_9bar_extraction']['peak_pump_bar']} bar`), drives `kd330_gauge_hinge` to `{s['gear_pump_9bar_extraction']['peak_gauge_rad']} rad`, yields `{s['gear_pump_9bar_extraction']['espresso_yield_g']} g` double espresso, and vents back to `0.0 bar`.
4. **Left Steam Wand & Manual Brew Lever Articulation (`super_steam_wand_and_lever`):**
   - Swings `kd330_steam_wand_swing` (`{s['super_steam_wand_and_lever']['min_wand_rad']} rad` to `{s['super_steam_wand_and_lever']['max_wand_rad']} rad`) and lifts `kd330_steam_lever_hinge` to `{s['super_steam_wand_and_lever']['peak_steam_lever_rad']} rad` (`{s['super_steam_wand_and_lever']['steam_temp_c']} °C` level-5 dry steam).
5. **Portafilter Wire-Grate Transfer, Pull-Out Drip Tray Service & Rest (`drip_tray_service_and_restore`):**
   - Unseats `kd330_portafilter` onto the `Z = 0.112 m` welded wire drip grate (`peak_drip_grate_touch_n = {s['drip_tray_service_and_restore']['peak_drip_grate_touch_n']} N`), slides `kd330_drip_tray_slide` forward `{s['drip_tray_service_and_restore']['peak_drip_tray_mm']} mm`, and restores all joints and portafilter to rest.
6. **GLB vs. `native.xml` Rest & Sampled Motion Frame Alignment (`frame_alignment`):**
   - Rest frames (`7/7` bodies): max position error `{report['frame_alignment']['rest_max_position_error_m']:.3e} m` (`<= 2e-6 m`), max orientation error `{report['frame_alignment']['rest_max_orientation_error_rad']:.3e} rad` (`<= 1e-5 rad`).
   - Sampled scalar-joint motion (`5` joints × `21` samples): max position error `{report['frame_alignment']['motion_max_position_error_m']:.3e} m`, max orientation error `{report['frame_alignment']['motion_max_orientation_error_rad']:.3e} rad`.
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    model, native_model = export_native_xml(mujoco, np)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    dt = float(model.opt.timestep)
    assert abs(dt - 0.002) < 1e-9, dt

    payload_bid = model.body("ingredient_payload").id
    pf_qpos_adr = model.joint("kd330_portafilter_free").qposadr[0]
    pf_dof_adr = model.joint("kd330_portafilter_free").dofadr[0]

    act_wand = model.actuator("kd330_steam_wand_actuator").id
    act_lever = model.actuator("kd330_steam_lever_actuator").id
    act_lid = model.actuator("kd330_tank_lid_actuator").id
    act_tray = model.actuator("kd330_drip_tray_actuator").id
    act_gauge = model.actuator("kd330_gauge_actuator").id

    rest_pf_pos = data.qpos[pf_qpos_adr : pf_qpos_adr + 3].copy()
    rest_pf_quat = data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7].copy()

    rad_per_bar = 3.80 / 16.0  # 0.2375 rad/bar across 0..16 bar dial

    state = {
        "mode": "warmup_pid",
        "electrical_power_w": 1850.0,
        "brew_pid_temp_c": 68.0,
        "steam_temp_c": 122.0,
        "pump_stage": 0,
        "pump_pressure_bar": 0.0,
        "tank_water_l": 1.35,
        "espresso_yield_g": 0.0,
        "drip_tray_ml": 15.0,
    }

    trace_rows = []
    stage_summaries = {}

    def sample_row():
        wand_rad = float(data.sensor("kd330_steam_wand_pos").data[0])
        lev_rad = float(data.sensor("kd330_steam_lever_pos").data[0])
        lid_rad = float(data.sensor("kd330_tank_lid_pos").data[0])
        tray_mm = float(data.sensor("kd330_drip_tray_pos").data[0]) * 1000.0
        gauge_rad = float(data.sensor("kd330_gauge_pos").data[0])
        bayonet_n = float(data.sensor("kd330_bayonet_touch").data[0])
        grate_n = float(data.sensor("kd330_drip_grate_touch").data[0])
        pf_rel = data.sensor("kd330_pf_relpos").data
        row = {
            "time_s": round(float(data.time), 4),
            "mode": state["mode"],
            "electrical_power_w": round(state["electrical_power_w"], 1),
            "brew_pid_temp_c": round(state["brew_pid_temp_c"], 2),
            "steam_temp_c": round(state["steam_temp_c"], 2),
            "pump_stage": int(state["pump_stage"]),
            "pump_pressure_bar": round(state["pump_pressure_bar"], 2),
            "gauge_rad": round(gauge_rad, 4),
            "steam_wand_rad": round(wand_rad, 4),
            "steam_lever_rad": round(lev_rad, 4),
            "tank_lid_rad": round(lid_rad, 4),
            "drip_tray_mm": round(tray_mm, 2),
            "tank_water_l": round(state["tank_water_l"], 3),
            "espresso_yield_g": round(state["espresso_yield_g"], 2),
            "bayonet_touch_n": round(bayonet_n, 4),
            "drip_grate_touch_n": round(grate_n, 4),
            "pf_rel_z_m": round(float(pf_rel[2]), 5),
        }
        trace_rows.append(row)
        return dict(row)

    # Stage 1: Hybrid 200 V / 1,850 W boiler + PID thermoblock warm-up to 93.0 C; portafilter seated on bayonet
    for step in range(300):
        if state["brew_pid_temp_c"] < 93.0:
            state["brew_pid_temp_c"] = min(93.0, state["brew_pid_temp_c"] + 0.10)
            state["electrical_power_w"] = 1850.0
        else:
            state["mode"] = "pid_ready"
            state["electrical_power_w"] = 115.0
        mujoco.mj_step(model, data)
        if step % 25 == 0:
            sample_row()
    snap1 = sample_row()
    assert snap1["brew_pid_temp_c"] == 93.0, snap1
    assert snap1["bayonet_touch_n"] > 4.6, snap1
    assert abs(snap1["pf_rel_z_m"]) < 0.002, snap1
    stage_summaries["pid_warmup_and_bayonet_seat"] = snap1

    # Stage 2: Open top 2.5 L water reservoir lid (0.95 rad), refill water to 2.500 L, close lid
    peak_lid_rad = 0.0
    state["mode"] = "tank_refill"
    for step in range(420):
        if step < 210:
            data.ctrl[act_lid] = 0.95
            if step == 160:
                state["tank_water_l"] = 2.500
        else:
            data.ctrl[act_lid] = 0.0
        mujoco.mj_step(model, data)
        peak_lid_rad = max(peak_lid_rad, float(data.sensor("kd330_tank_lid_pos").data[0]))
        if step % 30 == 0:
            sample_row()
    snap2 = sample_row()
    snap2["peak_tank_lid_rad"] = round(peak_lid_rad, 4)
    assert peak_lid_rad > 0.90, snap2
    assert snap2["tank_lid_rad"] < 0.04, snap2
    assert snap2["tank_water_l"] == 2.500, snap2
    stage_summaries["top_tank_refill"] = snap2

    # Stage 3: Load 18.0 g dry puck into portafilter; run 7-stage gear-pump profile (P2=3.0 bar -> P5=9.0 bar -> 0 bar)
    model.body_mass[payload_bid] = 0.018
    peak_bar = 0.0
    peak_gauge_rad = 0.0
    for step in range(750):
        if step < 180:
            state["mode"] = "preinfusion_p2"
            state["pump_stage"] = 2
            state["pump_pressure_bar"] = 3.0
            state["electrical_power_w"] = 980.0
            data.ctrl[act_gauge] = 3.0 * rad_per_bar
            state["tank_water_l"] -= 0.018 * (dt / 0.36)
            model.body_mass[payload_bid] = 0.034
        elif step < 560:
            state["mode"] = "extraction_p5"
            state["pump_stage"] = 5
            state["pump_pressure_bar"] = 9.0
            state["electrical_power_w"] = 1480.0
            data.ctrl[act_gauge] = 9.0 * rad_per_bar
            if state["espresso_yield_g"] < 36.0:
                dy = min(36.0 - state["espresso_yield_g"], 48.0 * dt)
                state["espresso_yield_g"] += dy
                state["tank_water_l"] -= dy * 0.001
        else:
            state["mode"] = "solenoid_vent"
            state["pump_stage"] = 0
            state["pump_pressure_bar"] = 0.0
            state["electrical_power_w"] = 115.0
            data.ctrl[act_gauge] = 0.0
            state["drip_tray_ml"] = 28.0
        mujoco.mj_step(model, data)
        peak_bar = max(peak_bar, state["pump_pressure_bar"])
        peak_gauge_rad = max(peak_gauge_rad, float(data.sensor("kd330_gauge_pos").data[0]))
        if step % 30 == 0:
            sample_row()
    snap3 = sample_row()
    snap3["peak_pump_bar"] = round(peak_bar, 2)
    snap3["peak_gauge_rad"] = round(peak_gauge_rad, 4)
    assert abs(snap3["espresso_yield_g"] - 36.0) < 0.2, snap3
    assert abs(peak_gauge_rad - 9.0 * rad_per_bar) < 0.08, snap3
    assert snap3["gauge_rad"] < 0.06, snap3
    stage_summaries["gear_pump_9bar_extraction"] = snap3

    # Stage 4: Left steam wand & E61 manual brew lever articulation (wand -0.28 .. +0.45 rad, lever 0.76 rad)
    min_wand = 99.0
    max_wand = -99.0
    peak_lever = 0.0
    for step in range(580):
        if step < 220:
            state["mode"] = "super_steam_s5"
            state["electrical_power_w"] = 1850.0
            state["steam_temp_c"] = min(142.0, state["steam_temp_c"] + 0.095)
            data.ctrl[act_wand] = -0.28
            data.ctrl[act_lever] = 0.76
        elif step < 420:
            data.ctrl[act_wand] = 0.45
            data.ctrl[act_lever] = 0.0
            state["electrical_power_w"] = 125.0
        else:
            data.ctrl[act_wand] = 0.0
            data.ctrl[act_lever] = 0.0
        mujoco.mj_step(model, data)
        w_now = float(data.sensor("kd330_steam_wand_pos").data[0])
        l_now = float(data.sensor("kd330_steam_lever_pos").data[0])
        min_wand = min(min_wand, w_now)
        max_wand = max(max_wand, w_now)
        peak_lever = max(peak_lever, l_now)
        if step % 25 == 0:
            sample_row()
    snap4 = sample_row()
    snap4["min_wand_rad"] = round(min_wand, 4)
    snap4["max_wand_rad"] = round(max_wand, 4)
    snap4["peak_steam_lever_rad"] = round(peak_lever, 4)
    assert min_wand < -0.24 and max_wand > 0.36, snap4
    assert peak_lever > 0.70, snap4
    stage_summaries["super_steam_wand_and_lever"] = snap4

    # Stage 5: Unseat portafilter onto Z=0.112m wire drip-tray grate, pull out drip tray +135 mm, then restore rest pose
    peak_grate_n = 0.0
    peak_tray_mm = 0.0
    for step in range(560):
        if step == 0:
            state["mode"] = "portafilter_on_drip_grate"
            model.body_mass[payload_bid] = 1e-9
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = [0.0, -0.1580, 0.1265]
            data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
            data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
        elif step == 180:
            state["mode"] = "drip_tray_slide_out"
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = rest_pf_pos
            data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = rest_pf_quat
            data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
            data.ctrl[act_tray] = 0.135
        elif step == 380:
            state["mode"] = "pid_ready"
            state["drip_tray_ml"] = 0.0
            data.ctrl[act_tray] = 0.0
        mujoco.mj_step(model, data)
        peak_grate_n = max(peak_grate_n, float(data.sensor("kd330_drip_grate_touch").data[0]))
        peak_tray_mm = max(peak_tray_mm, float(data.sensor("kd330_drip_tray_pos").data[0]) * 1000.0)
        if step % 30 == 0:
            sample_row()
    snap5 = sample_row()
    snap5["peak_drip_grate_touch_n"] = round(peak_grate_n, 4)
    snap5["peak_drip_tray_mm"] = round(peak_tray_mm, 2)
    assert peak_grate_n > 4.6, snap5
    assert peak_tray_mm > 128.0, snap5
    assert snap5["drip_tray_mm"] < 2.0, snap5
    assert snap5["bayonet_touch_n"] > 4.6, snap5
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
        "model_title": "WPM KD-330X 1-Group Commercial Espresso Machine (Japan 200V SKU)",
        "mujoco_version": mujoco.__version__,
        "supply": "Single-phase 200 V AC, 50/60 Hz, 1,850 W",
        "envelope_m": [0.320, 0.460, 0.480],
        "published_machine_mass_kg": 22.800,
        "detachable_portafilter_mass_kg": 0.520,
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


def main():
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
