"""Build and verify the MuJoCo mechanical and active-state model for the WPM ZD-17OD."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = "wpm-zd-17od"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")
VENV_PYTHON = ROOT / "scripts/bakery-mujoco/.venv/bin/python"

NAMES = (
    "zd17_grinder",
    "zd17_collar",
    "zd17_burr_rotor",
    "zd17_pf_trigger",
    "zd17_hopper_lid",
    "zd17_portafilter",
)

GRINDER_BODY_NAMES = (
    "zd17_grinder",
    "zd17_collar",
    "zd17_burr_rotor",
    "zd17_pf_trigger",
    "zd17_hopper_lid",
)

# Exact published grinder mass = 3.800 kg; detachable 58 mm portafilter = 0.480 kg
MASSES = {
    "zd17_grinder": 3.360,
    "zd17_collar": 0.180,
    "zd17_burr_rotor": 0.160,
    "zd17_pf_trigger": 0.015,
    "zd17_hopper_lid": 0.085,
    "zd17_portafilter": 0.480,
}

CENTERS = {
    "zd17_grinder": (0.0, 0.024, 0.145),
    "zd17_collar": (0.0, 0.0, 0.002),
    "zd17_burr_rotor": (0.0, 0.0, 0.004),
    "zd17_pf_trigger": (0.0, -0.003, 0.0),
    "zd17_hopper_lid": (0.0, 0.0, 0.002),
    # Heavy forged 58 mm stainless head places CoM inside the fork support polygon
    "zd17_portafilter": (0.0, -0.018, -0.004),
}

INERTIAS = {
    "zd17_grinder": (0.0380, 0.0290, 0.0165),
    "zd17_collar": (0.00018, 0.00018, 0.00034),
    "zd17_burr_rotor": (0.00005, 0.00005, 0.00008),
    "zd17_pf_trigger": (2.0e-6, 2.0e-6, 2.0e-6),
    "zd17_hopper_lid": (0.00008, 0.00008, 0.00015),
    "zd17_portafilter": (0.00120, 0.00038, 0.00135),
}

SCALAR_VISUAL_AXES = {
    "zd17_collar_dial": [0.0, 0.0, 1.0],
    "zd17_burr_spin": [0.0, 0.0, 1.0],
    "zd17_trigger_press": [0.0, 1.0, 0.0],
    "zd17_lid_lift": [0.0, 0.0, 1.0],
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

    export_visual_meshes(parts, ASSETS)

    grinder_mass_sum = round(sum(MASSES[k] for k in GRINDER_BODY_NAMES), 6)
    assert grinder_mass_sum == 3.800, f"Expected 3.800 kg grinder mass, got {grinder_mass_sum}"

    app = ET.Element(
        "mujoco",
        model="wpm-zd-17od — WPM ZD-17OD on-demand 40mm conical burr espresso grinder",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

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
        size="1.2 1.2 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="3",
        group="2",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "zd17_portafilter":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "zd17_grinder" else None)
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

    base = bodies["zd17_grinder"]
    collar = bodies["zd17_collar"]
    burr = bodies["zd17_burr_rotor"]
    trig = bodies["zd17_pf_trigger"]
    lid = bodies["zd17_hopper_lid"]
    pf = bodies["zd17_portafilter"]

    # Four rubber feet collision cylinders touching Z = 0.000 m
    for foot_name, fx, fy in (
        ("zd17_foot_fl_col", -0.0460, -0.0950),
        ("zd17_foot_fr_col", 0.0460, -0.0950),
        ("zd17_foot_rl_col", -0.0460, 0.0950),
        ("zd17_foot_rr_col", 0.0460, 0.0950),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0030)),
            size="0.0110 0.0030",
            contype="2",
            conaffinity="1",
            group="3",
            mass="0",
        )

    # Grinder plinth, tower, chute, and hands-free portafilter fork support shelves (top at exact Z = 0.1120 m)
    for cname, cpos, csize in (
        ("zd17_plinth_col", (0.0, 0.0, 0.0170), (0.0625, 0.1175, 0.0110)),
        ("zd17_tower_col", (0.0, 0.0360, 0.1440), (0.0580, 0.0780, 0.1140)),
        ("zd17_hopper_col", (0.0, 0.0200, 0.3420), (0.0480, 0.0480, 0.0580)),
        ("zd17_fork_left_shelf_col", (-0.0320, -0.0840, 0.1085), (0.0060, 0.0330, 0.0035)),
        ("zd17_fork_right_shelf_col", (0.0320, -0.0840, 0.1085), (0.0060, 0.0330, 0.0035)),
        ("zd17_fork_backstop_col", (0.0, -0.0465, 0.1260), (0.0280, 0.0025, 0.0160)),
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

    # Operational sites on zd17_grinder
    ET.SubElement(
        base,
        "site",
        name="zd17_chute_exit_site",
        pos="0 -0.0840 0.1550",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="zd17_fork_seat_site",
        pos="0 -0.0840 0.1260",
        size="0.004",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="zd17_fork_touch_site",
        type="box",
        pos="0 -0.0840 0.1120",
        size="0.0400 0.0350 0.0025",
        group="3",
    )

    # 1. zd17_collar: stepless grind adjustment collar (hinge zd17_collar_dial, axis 0 0 1, range 0 .. 5.236 rad)
    ET.SubElement(
        collar,
        "joint",
        name="zd17_collar_dial",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="0 5.236",
        damping="0.35",
        armature="0.003",
    )
    ET.SubElement(
        collar,
        "geom",
        name="zd17_collar_col",
        type="cylinder",
        pos="0 0 0.0020",
        size="0.0450 0.0090",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
    )

    # 2. zd17_burr_rotor: 40 mm stainless conical burr (hinge zd17_burr_spin, axis 0 0 1, range -1000 .. 1000 rad)
    ET.SubElement(
        burr,
        "joint",
        name="zd17_burr_spin",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-1000 1000",
        damping="0.0025",
        armature="0.0006",
    )
    ET.SubElement(
        burr,
        "geom",
        name="zd17_burr_col",
        type="cylinder",
        pos="0 0 0.0035",
        size="0.0195 0.0100",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
    )

    # 3. zd17_pf_trigger: microswitch button behind fork (slide zd17_trigger_press, axis 0 1 0, range 0 .. 0.006 m)
    ET.SubElement(
        trig,
        "joint",
        name="zd17_trigger_press",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.006",
        stiffness="38.0",
        damping="0.60",
        armature="0.001",
    )
    ET.SubElement(
        trig,
        "geom",
        name="zd17_trigger_col",
        type="box",
        pos="0 -0.0040 0",
        size="0.0065 0.0040 0.0065",
        contype="0",
        conaffinity="0",
        group="3",
        mass="0",
    )

    # 4. zd17_hopper_lid: dark-tinted hopper lid (slide zd17_lid_lift, axis 0 0 1, range 0 .. 0.060 m)
    ET.SubElement(
        lid,
        "joint",
        name="zd17_lid_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.060",
        damping="1.80",
        armature="0.002",
    )
    ET.SubElement(
        lid,
        "geom",
        name="zd17_lid_col",
        type="cylinder",
        pos="0 0 0.0020",
        size="0.0595 0.0040",
        contype="2",
        conaffinity="1",
        group="3",
        mass="0",
    )

    # 5. zd17_portafilter: 58 mm stainless double-spout portafilter (freejoint zd17_portafilter_free)
    ET.SubElement(pf, "freejoint", name="zd17_portafilter_free")
    ET.SubElement(
        pf,
        "geom",
        name="zd17_pf_head_col",
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
        name="zd17_pf_handle_col",
        type="cylinder",
        pos="0 -0.1080 0",
        quat="0.70710678 0.70710678 0 0",
        size="0.0130 0.0520",
        contype="1",
        conaffinity="2",
        group="3",
        mass="0",
    )
    ET.SubElement(
        pf,
        "site",
        name="vessel_socket",
        pos="0 -0.1080 0",
        size="0.005",
        group="3",
    )
    ET.SubElement(
        pf,
        "site",
        name="zd17_pf_basket_center",
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
        size="0.0285 0.0020",
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
        name="zd17_collar_actuator",
        joint="zd17_collar_dial",
        kp="28",
        kv="2.4",
        ctrlrange="0 5.236",
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="zd17_burr_drive",
        joint="zd17_burr_spin",
        kv="1.6",
        ctrlrange="-60 60",
        forcerange="-4.5 4.5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="zd17_trigger_actuator",
        joint="zd17_trigger_press",
        kp="260",
        kv="4.5",
        ctrlrange="0 0.006",
        forcerange="0 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="zd17_lid_actuator",
        joint="zd17_lid_lift",
        kp="420",
        kv="12.0",
        ctrlrange="0 0.060",
        forcerange="-25 25",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="zd17_collar_pos", joint="zd17_collar_dial")
    ET.SubElement(sensors, "jointpos", name="zd17_burr_pos", joint="zd17_burr_spin")
    ET.SubElement(sensors, "jointvel", name="zd17_burr_vel", joint="zd17_burr_spin")
    ET.SubElement(
        sensors, "actuatorfrc", name="zd17_burr_torque", actuator="zd17_burr_drive"
    )
    ET.SubElement(
        sensors, "jointpos", name="zd17_trigger_pos", joint="zd17_trigger_press"
    )
    ET.SubElement(sensors, "jointpos", name="zd17_lid_pos", joint="zd17_lid_lift")
    ET.SubElement(sensors, "touch", name="zd17_fork_touch", site="zd17_fork_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="zd17_pf_relpos",
        objtype="site",
        objname="zd17_pf_basket_center",
        reftype="site",
        refname="zd17_fork_seat_site",
    )

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="wpm-zd-17od physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="-0.8 -1.4 1.8", dir="0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_grinder_mass_kg": 3.800,
                "detachable_portafilter_mass_kg": 0.480,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 130 W",
                "burr_diameter_mm": 40,
                "hopper_capacity_g": 450,
                "grind_rate_g_per_s": [1.5, 2.0],
                "scope": "Articulated MuJoCo 3.13 belt-driven 40 mm conical burr, stepless collar, hopper lid, microswitch trigger, and 6-DOF 58 mm portafilter model.",
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
    grinder_sum = sum(float(rebuilt.body(b).mass[0]) for b in GRINDER_BODY_NAMES)
    pf_mass = float(rebuilt.body("zd17_portafilter").mass[0])
    assert abs(grinder_sum - 3.800) < 1e-6, grinder_sum
    assert abs(pf_mass - 0.480) < 1e-6, pf_mass
    return model, rebuilt


def write_package_docs(report: dict):
    s = report["stages"]
    readme = f"""# WPM ZD-17OD — Blender 5.2 Visual & MuJoCo 3.13 Physics Package

On-demand conical burr espresso grinder (`WPM ZD-17OD`, Japan `100 V AC`, `50/60 Hz`, `130 W` SKU) with `40 mm` stainless conical burr, belt-driven dual-bearing spindle, `450 g` clear conical bean hopper, angled touch LCD panel (`1-CUP`, `2-CUP`, `MANUAL`), anti-static stainless grounds chute, and hands-free portafilter fork with microswitch trigger.
See the [equipment reference specification](../../../docs/equipment/wpm-zd-17od/README.md).

![WPM ZD-17OD main view](studio-main.png)
![WPM ZD-17OD open view](studio-open.png)

## Files

- [Editable Blender 5.2 source](wpm-zd-17od.blend), [articulated GLB](wpm-zd-17od.glb), and standalone [58 mm portafilter GLB](wpm-zd-17od-portafilter.glb).
- Metal GPU Cycles renders (`1400 × 1200`, `48` samples + OIDN): [studio-main.png](studio-main.png), [studio-front.png](studio-front.png), [studio-right.png](studio-right.png), [studio-open.png](studio-open.png), and [studio-active.png](studio-active.png).
- Verification manifests: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), and [physics-export.json](physics-export.json).
- MuJoCo 3.13 MJCF models: [appliance.xml](appliance.xml), [scene.xml](scene.xml), and collision-only [native.xml](native.xml).
- Active-state simulation & frame alignment: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Retained Bodies & Joints (`NAMES`)

| Body | Mass (`kg`) | Joint | Axis | Range |
| --- | --- | --- | --- | --- |
| `zd17_grinder` | `3.360` | Fixed base (`Z = 0.000 m` feet) | — | `125 × 235 × 410 mm` envelope |
| `zd17_collar` | `0.180` | `zd17_collar_dial` (`hinge`) | `0 0 1` | `0 .. 5.236 rad` |
| `zd17_burr_rotor` | `0.160` | `zd17_burr_spin` (`hinge`) | `0 0 1` | `-1000 .. 1000 rad` |
| `zd17_pf_trigger` | `0.015` | `zd17_trigger_press` (`slide`) | `0 1 0` | `0 .. 0.006 m` |
| `zd17_hopper_lid` | `0.085` | `zd17_lid_lift` (`slide`) | `0 0 1` | `0 .. 0.060 m` |
| **Grinder Total** | **`3.800`** | — | — | Exact published grinder mass |
| `zd17_portafilter` | `0.480` | `zd17_portafilter_free` (`freejoint`) | 6-DOF | Seated on `Z = 0.112 m` fork shelf (`vessel_socket` + `ingredient_payload`) |

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_zd_17od_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_zd_17od_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# WPM ZD-17OD — MuJoCo 3.13 Active-State & Frame Alignment Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded telemetry samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **Standby with 58 mm Portafilter Seated on Fork (`standby_portafilter_seated`):**
   - `zd17_portafilter` (`0.480 kg`) rests in passive static equilibrium on the hands-free fork collision shelf (`fork_touch_n = {s['standby_portafilter_seated']['fork_touch_n']} N`, `pf_rel_z_m = {s['standby_portafilter_seated']['pf_rel_z_m']} m`, LCD standby power `{s['standby_portafilter_seated']['electrical_power_w']} W`).
2. **Hopper Bean Charge & Stepless Grind Collar Adjustment (`hopper_load_and_collar_dial`):**
   - `zd17_hopper_lid` lifts `{s['hopper_load_and_collar_dial']['peak_lid_lift_mm']} mm` to load `250.0 g` roasted espresso beans into the `450 g` hopper, re-seats cleanly (`{s['hopper_load_and_collar_dial']['lid_lift_mm']} mm`), and dials `zd17_collar_dial` to `{s['hopper_load_and_collar_dial']['collar_rad']} rad` (`1.80 g/s` espresso setting).
3. **On-Demand 2-Cup (`18.0 g`) Microswitch Grind & Auto-Stop (`ondemand_2cup_18g_grind`):**
   - Depressing `zd17_trigger_press` (`{s['ondemand_2cup_18g_grind']['trigger_press_mm']} mm`) starts the `130.0 W` (`100 V AC`) belt-driven `40 mm` stainless conical burr (`peak_burr_rpm = {s['ondemand_2cup_18g_grind']['peak_burr_rpm']} RPM`, `peak_torque_nm = {s['ondemand_2cup_18g_grind']['peak_torque_nm']} N·m`), dosing `{s['ondemand_2cup_18g_grind']['portafilter_grounds_g']} g` into `ingredient_payload` (`fork_touch_n = {s['ondemand_2cup_18g_grind']['fork_touch_n']} N`) and stopping automatically.
4. **Manual Pulse Top-Up & Portafilter Transfer (`manual_pulse_and_transfer`):**
   - Manual touch pulse adds `0.50 g` (`{s['manual_pulse_and_transfer']['portafilter_grounds_g']} g` total), releases `zd17_trigger_press`, lifts `zd17_portafilter` clear of the fork (`min_fork_touch_n = 0.0 N`), and returns to rest.
5. **GLB vs. `native.xml` Rest & Sampled Motion Frame Alignment (`frame_alignment`):**
   - Rest frames (`6/6` bodies): max position error `{report['frame_alignment']['rest_max_position_error_m']:.3e} m` (`<= 2e-6 m`), max orientation error `{report['frame_alignment']['rest_max_orientation_error_rad']:.3e} rad` (`<= 1e-5 rad`).
   - Sampled scalar-joint motion (`4` joints × `21` samples): max position error `{report['frame_alignment']['motion_max_position_error_m']:.3e} m`, max orientation error `{report['frame_alignment']['motion_max_orientation_error_rad']:.3e} rad`.
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
    pf_qpos_adr = model.joint("zd17_portafilter_free").qposadr[0]
    pf_dof_adr = model.joint("zd17_portafilter_free").dofadr[0]
    burr_dof_adr = model.joint("zd17_burr_spin").dofadr[0]

    act_collar = model.actuator("zd17_collar_actuator").id
    act_burr = model.actuator("zd17_burr_drive").id
    act_trig = model.actuator("zd17_trigger_actuator").id
    act_lid = model.actuator("zd17_lid_actuator").id

    rest_pf_pos = data.qpos[pf_qpos_adr : pf_qpos_adr + 3].copy()
    rest_pf_quat = data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7].copy()

    nominal_omega = 450.0 * math.tau / 60.0  # 450 RPM = 47.12389 rad/s
    standby_w = 2.2
    rated_grind_w = 130.0

    state = {
        "mode": "standby",  # standby | dosing_2cup | manual_pulse | transfer
        "hopper_beans_g": 60.0,
        "portafilter_grounds_g": 0.0,
        "electrical_power_w": standby_w,
        "chute_led_on": False,
        "burr_temp_c": 23.0,
    }

    trace_rows = []
    stage_summaries = {}

    def sample_row():
        collar_rad = float(data.sensor("zd17_collar_pos").data[0])
        burr_vel = float(data.sensor("zd17_burr_vel").data[0])
        burr_rpm = burr_vel * 60.0 / math.tau
        burr_trq = float(data.sensor("zd17_burr_torque").data[0])
        trig_mm = float(data.sensor("zd17_trigger_pos").data[0]) * 1000.0
        lid_mm = float(data.sensor("zd17_lid_pos").data[0]) * 1000.0
        fork_n = float(data.sensor("zd17_fork_touch").data[0])
        pf_rel = data.sensor("zd17_pf_relpos").data
        row = {
            "time_s": round(float(data.time), 4),
            "mode": state["mode"],
            "electrical_power_w": round(state["electrical_power_w"], 2),
            "collar_rad": round(collar_rad, 4),
            "burr_rpm": round(burr_rpm, 2),
            "burr_torque_nm": round(burr_trq, 4),
            "trigger_press_mm": round(trig_mm, 3),
            "lid_lift_mm": round(lid_mm, 2),
            "hopper_beans_g": round(state["hopper_beans_g"], 3),
            "portafilter_grounds_g": round(state["portafilter_grounds_g"], 3),
            "fork_touch_n": round(fork_n, 4),
            "pf_rel_z_m": round(float(pf_rel[2]), 5),
            "chute_led_on": bool(state["chute_led_on"]),
            "burr_temp_c": round(state["burr_temp_c"], 2),
        }
        trace_rows.append(row)
        return dict(row)

    # Stage 1: Standby with 58 mm portafilter resting freely under gravity on fork collision shelf
    for step in range(250):
        mujoco.mj_step(model, data)
        if step % 25 == 0:
            sample_row()
    snap1 = sample_row()
    assert snap1["fork_touch_n"] > 4.2, snap1
    assert abs(snap1["pf_rel_z_m"]) < 0.002, snap1
    stage_summaries["standby_portafilter_seated"] = snap1

    # Stage 2: Lift hopper lid +50 mm, charge +190 g beans (to 250 g), close lid, dial collar to 1.15 rad (Espresso)
    peak_lid_mm = 0.0
    data.ctrl[act_collar] = 3.20
    for step in range(450):
        if step < 220:
            data.ctrl[act_lid] = 0.050
            if step == 160:
                state["hopper_beans_g"] = 250.0
        else:
            data.ctrl[act_lid] = 0.0
            data.ctrl[act_collar] = 1.15
        mujoco.mj_step(model, data)
        peak_lid_mm = max(peak_lid_mm, float(data.sensor("zd17_lid_pos").data[0]) * 1000.0)
        if step % 25 == 0:
            sample_row()
    snap2 = sample_row()
    snap2["peak_lid_lift_mm"] = round(peak_lid_mm, 2)
    assert peak_lid_mm > 46.0, snap2
    assert snap2["lid_lift_mm"] < 1.0, snap2
    assert abs(snap2["collar_rad"] - 1.15) < 0.06, snap2
    stage_summaries["hopper_load_and_collar_dial"] = snap2

    # Stage 3: Depress portafilter microswitch (+5.5 mm) -> 2-Cup on-demand 18.0 g dose at 1.80 g/s
    # Accelerated 5x mass integration (9.0 g/s over 2.0 s active spin = 1000 steps) while running full 450 RPM burr mechanics
    target_dose_g = 18.0
    peak_rpm = 0.0
    peak_trq = 0.0
    state["mode"] = "standby"
    for step in range(1350):
        data.ctrl[act_trig] = 0.0056 if step < 1150 else 0.0
        trig_m = float(data.sensor("zd17_trigger_pos").data[0])
        if trig_m >= 0.0035 and state["portafilter_grounds_g"] < target_dose_g:
            state["mode"] = "dosing_2cup"
            state["chute_led_on"] = True
            data.ctrl[act_burr] = nominal_omega
            omega = max(0.0, float(data.sensor("zd17_burr_vel").data[0]))
            if omega > 8.0 and state["hopper_beans_g"] > 0.0:
                dm = min(
                    target_dose_g - state["portafilter_grounds_g"],
                    state["hopper_beans_g"],
                    9.0 * (omega / nominal_omega) * dt,
                )
                state["hopper_beans_g"] -= dm
                state["portafilter_grounds_g"] += dm
                model.body_mass[payload_bid] = max(1e-9, state["portafilter_grounds_g"] * 0.001)
                ripple = 1.0 + 0.06 * math.sin(float(data.sensor("zd17_burr_pos").data[0]) * 7.0)
                data.qfrc_applied[burr_dof_adr] = -1.65 * ripple
                state["electrical_power_w"] = rated_grind_w * (0.88 + 0.12 * (omega / nominal_omega))
                state["burr_temp_c"] += 0.0032
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0
            if state["portafilter_grounds_g"] >= target_dose_g - 1e-6:
                state["mode"] = "standby"
                state["electrical_power_w"] = standby_w
                state["chute_led_on"] = False

        mujoco.mj_step(model, data)
        rpm_now = float(data.sensor("zd17_burr_vel").data[0]) * 60.0 / math.tau
        trq_now = float(data.sensor("zd17_burr_torque").data[0])
        peak_rpm = max(peak_rpm, rpm_now)
        peak_trq = max(peak_trq, trq_now)
        if step % 30 == 0:
            sample_row()

    snap3 = sample_row()
    snap3["peak_burr_rpm"] = round(peak_rpm, 2)
    snap3["peak_torque_nm"] = round(peak_trq, 4)
    assert abs(snap3["portafilter_grounds_g"] - 18.0) < 0.05, snap3
    assert snap3["peak_burr_rpm"] > 430.0, snap3
    assert snap3["fork_touch_n"] > snap1["fork_touch_n"] + 0.14, (snap1, snap3)
    stage_summaries["ondemand_2cup_18g_grind"] = snap3

    # Stage 4: Manual touch pulse (+0.50 g -> 18.50 g), unseat portafilter off fork, then restore rest pose
    min_fork_n = 999.0
    for step in range(450):
        if step < 120:
            state["mode"] = "manual_pulse"
            state["chute_led_on"] = True
            data.ctrl[act_burr] = nominal_omega
            omega = max(0.0, float(data.sensor("zd17_burr_vel").data[0]))
            if state["portafilter_grounds_g"] < 18.50 and omega > 8.0:
                dm = min(18.50 - state["portafilter_grounds_g"], 6.0 * (omega / nominal_omega) * dt)
                state["hopper_beans_g"] -= dm
                state["portafilter_grounds_g"] += dm
                model.body_mass[payload_bid] = state["portafilter_grounds_g"] * 0.001
                data.qfrc_applied[burr_dof_adr] = -1.55
                state["electrical_power_w"] = 128.0
        elif step < 280:
            state["mode"] = "transfer"
            state["chute_led_on"] = False
            state["electrical_power_w"] = standby_w
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0
            # Lift portafilter forward & up off the fork
            data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = [0.0, -0.155, 0.145]
            data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
            data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
        else:
            state["mode"] = "standby"
            data.ctrl[act_collar] = 0.0
            data.ctrl[act_trig] = 0.0
            data.ctrl[act_lid] = 0.0
            if step == 280:
                data.qpos[pf_qpos_adr : pf_qpos_adr + 3] = rest_pf_pos
                data.qpos[pf_qpos_adr + 3 : pf_qpos_adr + 7] = rest_pf_quat
                data.qvel[pf_dof_adr : pf_dof_adr + 6] = 0.0
        mujoco.mj_step(model, data)
        min_fork_n = min(min_fork_n, float(data.sensor("zd17_fork_touch").data[0]))
        if step % 25 == 0:
            sample_row()

    snap4 = sample_row()
    snap4["min_fork_touch_n"] = round(min_fork_n, 4)
    assert min_fork_n == 0.0, snap4
    assert snap4["portafilter_grounds_g"] >= 18.45, snap4
    assert snap4["fork_touch_n"] > 4.3, snap4
    stage_summaries["manual_pulse_and_transfer"] = snap4

    # Stage 5: Verify BOTH rest frames AND --motion sampled scalar-joint trajectories via inspect_appliance_frames.mjs
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
        "model_title": "WPM ZD-17OD On-Demand Conical Burr Espresso Grinder (Japan 100V SKU)",
        "mujoco_version": mujoco.__version__,
        "supply": "Single-phase 100 V AC, 50/60 Hz, 130 W",
        "envelope_m": [0.125, 0.235, 0.410],
        "published_grinder_mass_kg": 3.800,
        "detachable_portafilter_mass_kg": 0.480,
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
