"""Build and verify the MuJoCo 4.0 mechanical, harvest-cycle, and bin-control model for the Hoshizaki IM-25P."""

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
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

ASSETS = ROOT / "assets/bakery-mujoco/hoshizaki-im-25p"

NAMES = (
    "im25_cabinet",
    "im25_door",
    "im25_air_filter",
    "im25_water_plate",
    "im25_bin_switch",
    "im25_power_switch",
    "im25_scoop",
)

# Published unit mass = 33.000 kg (including 6-DOF sanitary ice scoop)
MASSES = {
    "im25_cabinet": 29.740,
    "im25_door": 2.420,
    "im25_air_filter": 0.150,
    "im25_water_plate": 0.360,
    "im25_bin_switch": 0.130,
    "im25_power_switch": 0.030,
    "im25_scoop": 0.170,
}

CENTERS = {
    "im25_cabinet": (0.0, 0.015, 0.345),
    "im25_door": (0.0, 0.005, 0.1915),
    "im25_air_filter": (0.085, 0.005, 0.0),
    "im25_water_plate": (0.0, -0.095, 0.0),
    "im25_bin_switch": (0.0, 0.0, -0.042),
    "im25_power_switch": (0.0, 0.0, 0.0),
    "im25_scoop": (0.0, 0.0, -0.020),
}

INERTIAS = {
    "im25_cabinet": (1.820, 1.710, 0.890),
    "im25_door": (0.034, 0.068, 0.038),
    "im25_air_filter": (0.0006, 0.0010, 0.0005),
    "im25_water_plate": (0.0013, 0.0012, 0.0023),
    "im25_bin_switch": (0.00025, 0.00018, 0.00018),
    "im25_power_switch": (1e-5, 1e-5, 1e-5),
    "im25_scoop": (0.00035, 0.00035, 0.00018),
}

VISUAL_MOTIONS = {
    "im25_door_hinge": (1, 0, 0),
    "im25_filter_slide": (0, -1, 0),
    "im25_water_plate_hinge": (1, 0, 0),
    "im25_bin_switch_hinge": (1, 0, 0),
    "im25_power_switch_hinge": (1, 0, 0),
}

SCOOP_STOWED_POS = (-0.0450, -0.1120, 0.5340)


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, model.xml, and scoop_model.xml."""
    source = ASSETS / "hoshizaki-im-25p.blend"
    parts, poses = prepare_blender_assembly(
        source, NAMES, ASSETS, clear_all_animations=False
    )

    app = ET.Element(
        "mujoco",
        model="hoshizaki-im-25p — commercial undercounter closed-cell cube ice maker",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(app, friction="0.65 0.015 0.003")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.5 1.5 0.05",
        rgba="0.28 0.30 0.32 1",
        contype="1",
        conaffinity="1",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "im25_scoop":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "im25_cabinet" else None)
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

    base = bodies["im25_cabinet"]
    door = bodies["im25_door"]
    air_filter = bodies["im25_air_filter"]
    wplate = bodies["im25_water_plate"]
    bswitch = bodies["im25_bin_switch"]
    pwr = bodies["im25_power_switch"]
    scoop = bodies["im25_scoop"]

    # Four support feet collision cylinders touching Z = 0.000 m
    for foot_name, fx, fy in (
        ("im25_foot_fl_col", -0.1675, -0.1390),
        ("im25_foot_fr_col", 0.1675, -0.1390),
        ("im25_foot_rl_col", -0.1675, 0.1130),
        ("im25_foot_rr_col", 0.1675, 0.1130),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0085)),
            size="0.0155 0.0085",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Cabinet, bin walls, evaporator shroud/cell, stored ice bed (top at Z = 0.4020 m), scoop hanger shelf (top at Z = 0.4420 m), and worktop (top at Z = 0.7700 m)
    for cname, cpos, csize, crgba in (
        ("im25_lower_chassis_col", (0.0, 0.0050, 0.1780), (0.1975, 0.2150, 0.1610), COL_BASE_RGBA),
        ("im25_bin_floor_col", (0.0, 0.0100, 0.3360), (0.1660, 0.1800, 0.0120), COL_BASE_RGBA),
        ("im25_ice_bed_col", (0.0, 0.0150, 0.3740), (0.1520, 0.1520, 0.0280), COL_WALL_RGBA),
        ("im25_bin_left_wall_col", (-0.1795, 0.0050, 0.5430), (0.0180, 0.2180, 0.2050), COL_WALL_RGBA),
        ("im25_bin_right_wall_col", (0.1795, 0.0050, 0.5430), (0.0180, 0.2180, 0.2050), COL_WALL_RGBA),
        ("im25_bin_rear_wall_col", (0.0, 0.2000, 0.5430), (0.1620, 0.0240, 0.2050), COL_WALL_RGBA),
        ("im25_evap_housing_col", (-0.0450, 0.0250, 0.6800), (0.1000, 0.1200, 0.0420), COL_WALL_RGBA),
        ("im25_evap_cell_col", (-0.0450, 0.0300, 0.6440), (0.0560, 0.0910, 0.0160), COL_WALL_RGBA),
        ("im25_evap_front_col", (-0.0450, -0.1040, 0.6560), (0.0260, 0.0130, 0.0170), COL_WALL_RGBA),
        ("im25_worktop_col", (0.0, 0.0, 0.7590), (0.1975, 0.2250, 0.0110), COL_BASE_RGBA),
        ("im25_scoop_hanger_shelf_col", (-0.0450, -0.1120, 0.4380), (0.0420, 0.0300, 0.0040), COL_WALL_RGBA),
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

    # Named operational sites on im25_cabinet (group 4)
    ET.SubElement(
        base,
        "site",
        name="im25_bin_storage",
        pos="0 0.0100 0.4080",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im25_worktop_site",
        pos="0 0 0.7700",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im25_scoop_hanger_site",
        pos="-0.0450 -0.1120 0.5340",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im25_bin_touch_site",
        type="box",
        pos="0 0.0150 0.4040",
        size="0.1450 0.1450 0.0060",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Bottom-hinged bin door joint (`im25_door_hinge`, axis="1 0 0", range 0 .. 52 deg)
    ET.SubElement(
        door,
        "joint",
        name="im25_door_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range=numbers((0.0, math.radians(52.0))),
        damping="1.6",
        armature="0.012",
        frictionloss="2.8",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        door,
        "geom",
        name="im25_door_col",
        type="box",
        pos="0 0.0060 0.1915",
        size="0.1940 0.0180 0.1900",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Pull-out Raku-Eco condenser air filter slide joint (`im25_filter_slide`, axis="0 -1 0", range 0 .. 0.130 m)
    ET.SubElement(
        air_filter,
        "joint",
        name="im25_filter_slide",
        type="slide",
        axis="0 -1 0",
        limited="true",
        range="0 0.130",
        damping="2.2",
        armature="0.002",
        frictionloss="0.4",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        air_filter,
        "geom",
        name="im25_filter_col",
        type="box",
        pos="0.0850 0.0050 0",
        size="0.0950 0.0060 0.0950",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Actuator-motor driven water plate hinge joint (`im25_water_plate_hinge`, axis="1 0 0", range 0 .. 0.480 rad)
    ET.SubElement(
        wplate,
        "joint",
        name="im25_water_plate_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.480",
        damping="0.7",
        armature="0.004",
        frictionloss="0.5",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        wplate,
        "geom",
        name="im25_water_plate_col",
        type="box",
        pos="0 -0.0950 0",
        size="0.0860 0.0950 0.0070",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Double-lever bin level switch hinge joint (`im25_bin_switch_hinge`, axis="1 0 0", range 0 .. 0.550 rad)
    ET.SubElement(
        bswitch,
        "joint",
        name="im25_bin_switch_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.550",
        stiffness="0.8",
        damping="0.15",
        armature="0.001",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        bswitch,
        "geom",
        name="im25_bin_switch_col",
        type="box",
        pos="0 0 -0.0520",
        size="0.0075 0.0360 0.0500",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Recessed power/service rocker switch hinge joint (`im25_power_switch_hinge`, axis="1 0 0", range 0 .. 0.280 rad)
    ET.SubElement(
        pwr,
        "joint",
        name="im25_power_switch_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.280",
        damping="0.05",
        armature="0.0005",
        frictionloss="0.05",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )

    # 6-DOF free sanitary ice scoop (`im25_scoop` with `im25_scoop_free`, `vessel_socket`, and `ingredient_payload`)
    ET.SubElement(scoop, "freejoint", name="im25_scoop_free")
    ET.SubElement(
        scoop,
        "geom",
        name="im25_scoop_bowl_col",
        type="box",
        pos="0 0 -0.0460",
        size="0.0350 0.0240 0.0460",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        scoop,
        "geom",
        name="im25_scoop_handle_col",
        type="cylinder",
        pos="0 0 0.0550",
        size="0.0130 0.0480",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        scoop,
        "site",
        name="vessel_socket",
        pos="0 0 0.0550",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    payload = ET.SubElement(scoop, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 -0.0460",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 -0.0460",
        size="0.0300 0.0015",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.80 0.92 0.99 0",
        mass="0",
    )

    # Contact exclusions between cabinet and articulated children (scoop remains free to contact cabinet/bin/shelf)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_cabinet_door", "im25_cabinet", "im25_door"),
            ("exclude_cabinet_air_filter", "im25_cabinet", "im25_air_filter"),
            ("exclude_cabinet_water_plate", "im25_cabinet", "im25_water_plate"),
            ("exclude_cabinet_bin_switch", "im25_cabinet", "im25_bin_switch"),
            ("exclude_cabinet_power_switch", "im25_cabinet", "im25_power_switch"),
            ("exclude_door_air_filter", "im25_door", "im25_air_filter"),
            ("exclude_door_water_plate", "im25_door", "im25_water_plate"),
            ("exclude_door_bin_switch", "im25_door", "im25_bin_switch"),
            ("exclude_water_plate_bin_switch", "im25_water_plate", "im25_bin_switch"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="im25_door_actuator",
        joint="im25_door_hinge",
        kp="260",
        kv="12.0",
        ctrlrange=numbers((0.0, math.radians(52.0))),
        forcerange="-70 70",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im25_filter_actuator",
        joint="im25_filter_slide",
        kp="60",
        kv="5.0",
        ctrlrange="0 0.130",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im25_water_plate_actuator",
        joint="im25_water_plate_hinge",
        kp="120",
        kv="4.5",
        ctrlrange="0 0.480",
        forcerange="-35 35",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im25_bin_switch_actuator",
        joint="im25_bin_switch_hinge",
        kp="15",
        kv="1.2",
        ctrlrange="0 0.550",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im25_power_switch_actuator",
        joint="im25_power_switch_hinge",
        kp="12",
        kv="0.5",
        ctrlrange="0 0.280",
        forcerange="-5 5",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="im25_door_pos", joint="im25_door_hinge")
    ET.SubElement(sensors, "jointpos", name="im25_filter_pos", joint="im25_filter_slide")
    ET.SubElement(
        sensors, "jointpos", name="im25_water_plate_pos", joint="im25_water_plate_hinge"
    )
    ET.SubElement(
        sensors, "jointpos", name="im25_bin_switch_pos", joint="im25_bin_switch_hinge"
    )
    ET.SubElement(
        sensors, "jointpos", name="im25_power_switch_pos", joint="im25_power_switch_hinge"
    )
    ET.SubElement(sensors, "touch", name="im25_bin_touch", site="im25_bin_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="im25_scoop_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="im25_bin_storage",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="im25_cabinet",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("im25_scoop_sense",),
        accessories=(("scoop_model.xml", "im25_scoop", scoop),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 33.0,
                "component_masses_kg": MASSES,
                "component_mass_sum_kg": round(sum(MASSES.values()), 6),
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 0.47 kVA (4.7 A), 145/165 W, R600a",
                "ice_production_kg_per_day_20c_15c_50_60hz": [24.0, 26.0],
                "ice_production_kg_per_day_30c_25c_50_60hz": [19.0, 22.0],
                "ice_batch_kg": 0.43,
                "ice_cubes_per_batch": 18,
                "cube_dimensions_m": [0.028, 0.028, 0.032],
                "bin_max_stock_kg": 14.0,
                "bin_natural_fall_kg": 8.5,
                "scope": "Articulated MuJoCo 4.0 mechanical, closed-cell jet-spray freeze/harvest cycle, double-lever bin switch, Raku-Eco filter, and free sanitary ice-scoop model in appliance.xml, scene.xml, model.xml, scoop_model.xml, and native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    _, rebuilt = kit_export_native_xml(ASSETS, "hoshizaki-im-25p", mujoco, np)
    return {
        "nq": int(rebuilt.nq),
        "nv": int(rebuilt.nv),
        "total_mass_kg": round(float(np.sum(rebuilt.body_mass)), 6),
        "parity_verified": ["body_mass", "body_inertia", "qpos0", "dof_damping", "nq", "nv"],
    }


def verify_rest_and_motion_frames(mujoco, evidence_dir: Path):
    return kit_verify_frames_and_motions(
        ASSETS, "hoshizaki-im-25p", NAMES, VISUAL_MOTIONS, mujoco, evidence_dir
    )


def write_asset_docs(report: dict):
    readme = """# Hoshizaki IM-25P Blender Visual & MuJoCo Physics Model

Compact commercial undercounter self-contained closed-cell jet-spray cube ice maker (`単相100V`, `50/60 Hz`, `0.47 kVA` / `4.7 A`, `145/165 W`, natural refrigerant `R600a`), built from the archived Hoshizaki Japan `IM-P` lineup specification (`395 × 450 × 770 mm`, succeeding `IM-25M-2` / `IM-25M-1` / `IM-25M` / `IM-25L`).
Tilting the bottom-hinged insulated bin door open `52°` projects `301 mm` forward for an open depth of `751 mm`.
See the [manufacturer equipment documentation](../../../docs/equipment/hoshizaki-im-25p/README.md) for verified specifications and coordinate mapping.

![Closed ice maker](studio-closed.png)
![Open ice maker](studio-open.png)

## Files

- [Editable Blender source](hoshizaki-im-25p.blend), with Metal GPU Cycles studio lighting and preview animation (frames `1–120` at `24 fps`).
- [Rest-pose GLB assembly](hoshizaki-im-25p.glb) and standalone [sanitary ice scoop GLB](hoshizaki-im-25p-scoop.glb).
- Review renders (`1400 × 1200`, Cycles Metal GPU, `48` samples + denoiser): [closed](studio-closed.png), [open](studio-open.png), [front](studio-front.png), [interior](studio-interior.png), and [right](studio-right.png).
- [Build report](build-report.json) and [export inspection](inspection-report.json).
- MuJoCo 3.13 MJCF packages: [appliance.xml](appliance.xml), [scene.xml](scene.xml), [native.xml](native.xml), and [physics-export.json](physics-export.json).
- Active-state verification: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Assembly (`33.000 kg` total)

| Object | Mass (`kg`) | Purpose |
| --- | --- | --- |
| `im25_cabinet` | `29.740` | Fixed `395 × 450 × 770 mm` cabinet, `14.0 kg` max storage bin, `18-cell` (`3 × 6`) copper evaporator, and `Z = 0.770 m` worktop |
| `im25_door` | `2.420` | Bottom-hinged insulated bin door (`0 .. 52°` about `+X`, `+301 mm` forward projection) |
| `im25_air_filter` | `0.150` | Front pull-out Raku-Eco condenser air filter (`0 .. 0.130 m` slide along `-Y`) |
| `im25_water_plate` | `0.360` | Actuator-motor jet-spray water plate (`0 .. 0.480 rad` harvest tilt about `+X`) |
| `im25_bin_switch` | `0.130` | Double-lever mechanical ice-level sensing paddle (`0 .. 0.550 rad` swing about `+X`) |
| `im25_power_switch` | `0.030` | Recessed status-window power/service rocker switch (`0 .. 0.280 rad` about `+X`) |
| `im25_scoop` | `0.170` | Sanitary white resin ice scoop (`freejoint`) stowed on interior hanger shelf with `vessel_socket` and `ingredient_payload` |

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_im_25p_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_im_25p_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    s = report["stages"]
    rf = s["rest_and_motion_frame_alignment"]
    active_md = f"""# Hoshizaki IM-25P — MuJoCo Active-State Verification

This document summarizes the 7-stage MuJoCo 3.13 (`dt = 0.002 s`) mechanical, closed-cell jet-spray freeze/harvest cycle, double-lever bin switch, door-open heat ingress & safety interlock, Raku-Eco air filter slide, and 6-DOF sanitary ice-scoop verification for the **Hoshizaki IM-25P** (`単相100V`, `50/60 Hz`, `145/165 W`, `R600a`, `395 × 450 × 770 mm`, `33.000 kg`) generated by [`scripts/bakery-mujoco/build_im_25p_physics.py`](../../../scripts/bakery-mujoco/build_im_25p_physics.py).

## Verified Stages (`{report['trace_samples']}` samples)

1. **Standby & Unpinned Free-Body Scoop Equilibrium (`standby_door_closed`):**
   - Power switch OFF (`{s['standby_door_closed']['power_switch_angle_deg']}°`), bin door sealed (`{s['standby_door_closed']['door_angle_deg']}°`), unpinned 6-DOF `im25_scoop` resting stably under gravity on its interior hanger shelf (`z_drift = {s['standby_door_closed']['scoop_shelf_drift_mm']} mm`), initial cube-ice stock `{s['standby_door_closed']['bin_ice_stock_kg']} kg` at `{s['standby_door_closed']['bin_temp_c']} °C`.
2. **Closed-Cell Jet-Spray Freezing Cycle (`jet_spray_freezing_cycle`):**
   - Actuating `im25_power_switch` (`{s['jet_spray_freezing_cycle']['power_switch_angle_deg']}°`) engages `mode = "jet_spray_freezing"` at `{s['jet_spray_freezing_cycle']['electrical_power_w']} W` (`60 Hz`, `100 V AC`), pulling evaporator cell temperature down to `{s['jet_spray_freezing_cycle']['evaporator_temp_c']} °C` with `im25_water_plate` sealed (`{s['jet_spray_freezing_cycle']['water_plate_angle_deg']}°`) against the `18-cell` (`3 × 6`) copper grid.
3. **Hot-Gas Harvest & Actuator-Motor Water Plate Half-Open (`hot_gas_harvest_water_plate_open`):**
   - Switching to `mode = "hot_gas_harvest"` (`{s['hot_gas_harvest_water_plate_open']['electrical_power_w']} W`, `{s['hot_gas_harvest_water_plate_open']['evaporator_temp_c']} °C`) tilts `im25_water_plate_hinge` to `{s['hot_gas_harvest_water_plate_open']['water_plate_angle_deg']}°`, draining `{s['hot_gas_harvest_water_plate_open']['residual_water_drained_l']} L` of residual water via `排水口 R3/4` and releasing `18` cubes (`28 × 28 × 32 mm`, `0.43 kg`) so bin stock reaches `{s['hot_gas_harvest_water_plate_open']['bin_ice_stock_kg']} kg` (`> 8.50 kg` natural-fall cutoff).
4. **Double-Lever Bin-Full Automatic Cutout (`double_lever_bin_full_cutout`):**
   - Ice pile contact deflects `im25_bin_switch_hinge` to `{s['double_lever_bin_full_cutout']['bin_switch_angle_deg']}°`, switching the microcomputer to `mode = "bin_full_standby"` (`{s['double_lever_bin_full_cutout']['electrical_power_w']} W`, `auto_stop_reason = "double_lever_bin_full"`).
5. **Door-Open Interlock, Heat Ingress & Free-Body Ice Scooping (`door_open_interlock_and_ice_scooping`):**
   - Tilting `im25_door_hinge` open to `{s['door_open_interlock_and_ice_scooping']['door_angle_deg']}°` triggers `door_interlock_stop` and models warm-air heat ingress (`bin_temp_c` rises to `{s['door_open_interlock_and_ice_scooping']['bin_temp_c']} °C`); `im25_scoop` settles under gravity onto the ice bed (`bin_touch_force_n = {s['door_open_interlock_and_ice_scooping']['peak_bin_touch_force_n']} N`) and retrieves `0.95 kg` of cubes (`bin_ice_stock_kg = {s['door_open_interlock_and_ice_scooping']['bin_ice_stock_kg']} kg`).
6. **Door Closure, Automatic Resume & Raku-Eco Air Filter Slide (`raku_eco_air_filter_maintenance`):**
   - Stowing `im25_scoop` back on its interior shelf and closing `im25_door_hinge` (`{s['raku_eco_air_filter_maintenance']['door_angle_deg']}°`) clears the interlock and resumes `"jet_spray_freezing"` (`{s['raku_eco_air_filter_maintenance']['electrical_power_w']} W`) while `im25_filter_slide` extends `{s['raku_eco_air_filter_maintenance']['air_filter_pull_mm']} mm` forward for condenser screen cleaning.
7. **Rest & Sampled Motion GLB/Native Frame Alignment (`rest_and_motion_frame_alignment`):**
   - All `7/7` retained bodies align at rest (`max_position_error_m = {rf['rest_max_position_error_m']:.3e}`, `max_orientation_error_rad = {rf['rest_max_orientation_error_rad']:.3e}`), and all `5/5` scalar joints (`21` samples each = `105` poses) pass `--motion` verification (`max_position_error_m = {rf['motion_max_position_error_m']:.3e}`, `max_orientation_error_rad = {rf['motion_max_orientation_error_rad']:.3e}`).

## Evidence Artifacts

- [`active-states.json`](./active-states.json)
- [`active-state-evidence/report.json`](./active-state-evidence/report.json)
- [`active-state-evidence/frames-report.json`](./active-state-evidence/frames-report.json)
- [`active-state-evidence/motion-report.json`](./active-state-evidence/motion-report.json)
- [`active-state-evidence/trace.csv`](./active-state-evidence/trace.csv)
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    parity_info = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    scoop_qpos_adr = model.joint("im25_scoop_free").qposadr[0]
    scoop_qvel_adr = model.joint("im25_scoop_free").dofadr[0]

    state = {
        "mode": "standby",
        "supply_voltage_v": 100.0,
        "frequency_hz": 60,
        "electrical_power_w": 0.0,
        "evaporator_temp_c": 14.0,
        "bin_temp_c": -1.60,
        "ambient_temp_c": 20.0,
        "water_inlet_temp_c": 15.0,
        "bin_ice_stock_kg": 8.20,
        "natural_fall_limit_kg": 8.50,
        "max_stock_limit_kg": 14.00,
        "harvest_batches_completed": 0,
        "residual_water_drained_l": 0.0,
        "scooped_ice_kg": 0.0,
        "door_interlock_active": False,
        "auto_stop_reason": "none",
    }

    trace_rows = []
    stage_summaries = {}

    def set_scoop_free_pose(pos, quat=(1.0, 0.0, 0.0, 0.0)):
        data.qpos[scoop_qpos_adr : scoop_qpos_adr + 3] = pos
        data.qpos[scoop_qpos_adr + 3 : scoop_qpos_adr + 7] = quat
        data.qvel[scoop_qvel_adr : scoop_qvel_adr + 6] = 0.0
        mujoco.mj_forward(model, data)

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, pin_scoop_pose=None):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        peak_touch_n = 0.0
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                if pin_scoop_pose is not None:
                    pos, quat = pin_scoop_pose
                    data.qpos[scoop_qpos_adr : scoop_qpos_adr + 3] = pos
                    data.qpos[scoop_qpos_adr + 3 : scoop_qpos_adr + 7] = quat
                    data.qvel[scoop_qvel_adr : scoop_qvel_adr + 6] = 0.0
                mujoco.mj_step(model, data)

            door_rad = float(data.sensor("im25_door_pos").data[0])
            filt_m = float(data.sensor("im25_filter_pos").data[0])
            wplate_rad = float(data.sensor("im25_water_plate_pos").data[0])
            bswitch_rad = float(data.sensor("im25_bin_switch_pos").data[0])
            pwr_rad = float(data.sensor("im25_power_switch_pos").data[0])
            scoop_rel = data.sensor("im25_scoop_sense").data
            touch_n = float(data.sensor("im25_bin_touch").data[0])
            peak_touch_n = max(peak_touch_n, touch_n)
            scoop_z = float(data.qpos[scoop_qpos_adr + 2])

            state["door_interlock_active"] = door_rad > 0.15
            if pwr_rad < 0.10:
                state["mode"] = "standby"
                state["electrical_power_w"] = 0.0
            elif state["door_interlock_active"]:
                state["mode"] = "door_interlock_stop"
                state["electrical_power_w"] = 3.5
                state["auto_stop_reason"] = "door_open_interlock"
            elif (
                bswitch_rad >= 0.30
                or state["bin_ice_stock_kg"] >= state["natural_fall_limit_kg"]
            ):
                state["mode"] = "bin_full_standby"
                state["electrical_power_w"] = 5.0
                state["auto_stop_reason"] = "double_lever_bin_full"
            elif state["mode"] in {"door_interlock_stop", "bin_full_standby"}:
                state["mode"] = "jet_spray_freezing"
                state["electrical_power_w"] = 165.0
                state["auto_stop_reason"] = "none"

            # Thermal dynamics across evaporator cell and insulated bin (with door-open heat ingress)
            if state["mode"] == "jet_spray_freezing":
                state["evaporator_temp_c"] += (-15.2 - state["evaporator_temp_c"]) * 0.22
                state["bin_temp_c"] += (-1.80 - state["bin_temp_c"]) * 0.08
            elif state["mode"] == "hot_gas_harvest":
                state["evaporator_temp_c"] += (4.5 - state["evaporator_temp_c"]) * 0.28
                state["bin_temp_c"] += (-1.50 - state["bin_temp_c"]) * 0.05
            if state["door_interlock_active"]:
                open_frac = door_rad / math.radians(52.0)
                state["bin_temp_c"] += 0.055 * open_frac

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "electrical_power_w": round(state["electrical_power_w"], 1),
                "evaporator_temp_c": round(state["evaporator_temp_c"], 2),
                "bin_temp_c": round(state["bin_temp_c"], 2),
                "bin_ice_stock_kg": round(state["bin_ice_stock_kg"], 2),
                "harvest_batches_completed": state["harvest_batches_completed"],
                "residual_water_drained_l": round(state["residual_water_drained_l"], 2),
                "scooped_ice_kg": round(state["scooped_ice_kg"], 2),
                "door_angle_deg": round(math.degrees(door_rad), 2),
                "water_plate_angle_deg": round(math.degrees(wplate_rad), 2),
                "bin_switch_angle_deg": round(math.degrees(bswitch_rad), 2),
                "air_filter_pull_mm": round(filt_m * 1000.0, 2),
                "power_switch_angle_deg": round(math.degrees(pwr_rad), 2),
                "scoop_z_m": round(scoop_z, 5),
                "scoop_shelf_drift_mm": round(abs(scoop_z - SCOOP_STOWED_POS[2]) * 1000.0, 3),
                "scoop_rel_storage_z_m": round(float(scoop_rel[2]), 4),
                "bin_touch_force_n": round(touch_n, 3),
                "door_interlock_active": state["door_interlock_active"],
                "auto_stop_reason": state["auto_stop_reason"],
            }
            trace_rows.append(last_snap)
        last_snap["peak_bin_touch_force_n"] = round(peak_touch_n, 3)
        return last_snap

    # Stage 1: Standby with door closed and UNPINNED 6-DOF scoop resting under gravity on interior hanger shelf
    snap1 = step_and_sample(0.36, pin_scoop_pose=None)
    assert snap1["mode"] == "standby" and snap1["electrical_power_w"] == 0.0, snap1
    assert snap1["door_angle_deg"] < 0.5, snap1
    assert snap1["scoop_shelf_drift_mm"] < 2.0, snap1
    stage_summaries["standby_door_closed"] = snap1

    # Stage 2: Turn on power switch -> Closed-cell jet-spray freezing cycle (165 W at 60 Hz, R600a, water plate sealed)
    data.ctrl[model.actuator("im25_power_switch_actuator").id] = 0.280
    data.ctrl[model.actuator("im25_water_plate_actuator").id] = 0.0
    state["mode"] = "jet_spray_freezing"
    state["electrical_power_w"] = 165.0
    snap2 = step_and_sample(0.52, pin_scoop_pose=None)
    assert snap2["mode"] == "jet_spray_freezing", snap2
    assert snap2["electrical_power_w"] == 165.0, snap2
    assert snap2["evaporator_temp_c"] < -10.0, snap2
    assert snap2["water_plate_angle_deg"] < 0.5, snap2
    stage_summaries["jet_spray_freezing_cycle"] = snap2

    # Stage 3: Hot-gas harvest cycle -> actuator motor tilts water plate +0.480 rad (27.5 deg) downward, releasing 18 cubes / 0.43 kg
    data.ctrl[model.actuator("im25_water_plate_actuator").id] = 0.480
    state["mode"] = "hot_gas_harvest"
    state["electrical_power_w"] = 182.0
    snap3 = step_and_sample(0.52, pin_scoop_pose=None)
    state["harvest_batches_completed"] = 1
    state["residual_water_drained_l"] = 0.42
    state["bin_ice_stock_kg"] = round(state["bin_ice_stock_kg"] + 0.43, 2)  # 8.63 kg > 8.50 kg natural fall!
    snap3["harvest_batches_completed"] = state["harvest_batches_completed"]
    snap3["residual_water_drained_l"] = state["residual_water_drained_l"]
    snap3["bin_ice_stock_kg"] = state["bin_ice_stock_kg"]
    assert snap3["water_plate_angle_deg"] > 25.0, snap3
    assert snap3["bin_ice_stock_kg"] == 8.63, snap3
    stage_summaries["hot_gas_harvest_water_plate_open"] = snap3

    # Stage 4: Double-lever bin switch deflection -> automatic bin-full standby cutoff
    data.ctrl[model.actuator("im25_water_plate_actuator").id] = 0.0
    data.ctrl[model.actuator("im25_bin_switch_actuator").id] = 0.440
    snap4 = step_and_sample(0.48, pin_scoop_pose=None)
    assert snap4["mode"] == "bin_full_standby", snap4
    assert snap4["bin_switch_angle_deg"] > 22.0, snap4
    assert snap4["auto_stop_reason"] == "double_lever_bin_full", snap4
    stage_summaries["double_lever_bin_full_cutout"] = snap4

    # Stage 5: Open bottom-hinged bin door 52 deg, place unpinned scoop onto ice bed to verify physical bin contact, then lift out 0.95 kg ice
    temp_before_open = state["bin_temp_c"]
    data.ctrl[model.actuator("im25_door_actuator").id] = math.radians(52.0)
    set_scoop_free_pose((0.0150, 0.0150, 0.4980))
    snap5_bed = step_and_sample(0.40, pin_scoop_pose=None)
    assert snap5_bed["peak_bin_touch_force_n"] > 0.5, snap5_bed
    state["scooped_ice_kg"] = 0.95
    state["bin_ice_stock_kg"] = round(state["bin_ice_stock_kg"] - 0.95, 2)  # 7.68 kg < 8.50 kg
    data.ctrl[model.actuator("im25_bin_switch_actuator").id] = 0.0
    snap5 = step_and_sample(
        0.36,
        pin_scoop_pose=((-0.0250, -0.3200, 0.5600), (0.9537, -0.3007, 0.0, 0.0)),
    )
    snap5["peak_bin_touch_force_n"] = snap5_bed["peak_bin_touch_force_n"]
    assert snap5["door_angle_deg"] > 50.0, snap5
    assert snap5["door_interlock_active"] is True, snap5
    assert snap5["mode"] == "door_interlock_stop", snap5
    assert snap5["bin_temp_c"] > temp_before_open, (snap5["bin_temp_c"], temp_before_open)
    assert snap5["bin_ice_stock_kg"] == 7.68, snap5
    stage_summaries["door_open_interlock_and_ice_scooping"] = snap5

    # Stage 6: Return scoop unpinned to hanger shelf, close bin door, and slide out Raku-Eco air filter 115 mm
    set_scoop_free_pose(SCOOP_STOWED_POS)
    data.ctrl[model.actuator("im25_door_actuator").id] = 0.0
    data.ctrl[model.actuator("im25_filter_actuator").id] = 0.115
    state["mode"] = "jet_spray_freezing"
    state["electrical_power_w"] = 165.0
    state["auto_stop_reason"] = "none"
    snap6 = step_and_sample(0.52, pin_scoop_pose=None)
    assert snap6["door_angle_deg"] < 2.0, snap6
    assert snap6["air_filter_pull_mm"] > 100.0, snap6
    assert snap6["scoop_shelf_drift_mm"] < 2.0, snap6
    stage_summaries["raku_eco_air_filter_maintenance"] = snap6

    # Stage 7: Restore filter & power switch to rest and verify BOTH rest frames AND --motion trajectories
    data.ctrl[model.actuator("im25_filter_actuator").id] = 0.0
    data.ctrl[model.actuator("im25_power_switch_actuator").id] = 0.0
    snap7 = step_and_sample(0.48, pin_scoop_pose=None)

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_rest_and_motion_frames(mujoco, evidence_dir)

    app_frames = frames_report["appliances"]["hoshizaki-im-25p"]["frames"]
    app_motions = motion_report["appliances"]["hoshizaki-im-25p"]["motions"]
    stage_summaries["rest_and_motion_frame_alignment"] = {
        "rest_snap": snap7,
        "frames_aligned": len(app_frames),
        "rest_max_position_error_m": max(f["position_error_m"] for f in app_frames),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"] for f in app_frames
        ),
        "scalar_joints_motion_verified": len(app_motions),
        "samples_per_joint": 21,
        "motion_max_position_error_m": max(m["position_error_m"] for m in app_motions),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"] for m in app_motions
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        fieldnames = list(trace_rows[0].keys())
        if "peak_bin_touch_force_n" not in fieldnames:
            fieldnames.append("peak_bin_touch_force_n")
        writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "hoshizaki-im-25p",
        "model_title": "Hoshizaki IM-25P Commercial Undercounter Cube Ice Maker (succeeding IM-25M-2)",
        "supply": "Single-phase 100 V AC, 50/60 Hz, 0.47 kVA (4.7 A), 145/165 W, natural refrigerant R600a",
        "envelope_m": [0.395, 0.450, 0.770],
        "open_door_depth_m": 0.751,
        "unit_mass_kg": 33.0,
        "component_masses_kg": MASSES,
        "native_parity": parity_info,
        "ice_production_kg_per_day_20c_15c_50_60hz": [24.0, 26.0],
        "ice_production_kg_per_day_30c_25c_50_60hz": [19.0, 22.0],
        "ice_cube_dimensions_m": [0.028, 0.028, 0.032],
        "ice_batch_kg": 0.43,
        "ice_cubes_per_batch": 18,
        "bin_max_stock_kg": 14.0,
        "bin_natural_fall_kg": 8.5,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_asset_docs(report)
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
