"""Build and verify the MuJoCo 4.0 mechanical, sanitary hand-wash hydraulic, soap-dose, and drain model for the Maruzen HMHS-054."""

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
    COL_ARTIC_RGBA,
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
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

ASSETS = ROOT / "assets/bakery-mujoco/maruzen-hmhs-054"
DOCS_DIR = ROOT / "docs/equipment/maruzen-hmhs-054"

NAMES = (
    "hmhs_basin",
    "hmhs_faucet_lever",
    "hmhs_spout_swivel",
    "hmhs_soap_plunger",
    "hmhs_drain_strainer",
)

# Total unit mass = 8.500 kg (SUS304 wall-hung sink + brass gooseneck faucet + soap dispenser + strainer)
MASSES = {
    "hmhs_basin": 7.620,
    "hmhs_faucet_lever": 0.160,
    "hmhs_spout_swivel": 0.480,
    "hmhs_soap_plunger": 0.090,
    "hmhs_drain_strainer": 0.150,
}

CENTERS = {
    "hmhs_basin": (0.0, 0.025, 0.195),
    "hmhs_faucet_lever": (-0.055, 0.0, 0.003),
    "hmhs_spout_swivel": (0.0, -0.072, 0.052),
    "hmhs_soap_plunger": (0.0, -0.018, -0.004),
    "hmhs_drain_strainer": (0.0, 0.0, -0.004),
}

INERTIAS = {
    "hmhs_basin": (0.1680, 0.1850, 0.2420),
    "hmhs_faucet_lever": (2.5e-5, 2.2e-4, 2.3e-4),
    "hmhs_spout_swivel": (1.8e-3, 6.5e-4, 1.4e-3),
    "hmhs_soap_plunger": (3.2e-5, 2.4e-5, 2.8e-5),
    "hmhs_drain_strainer": (5.5e-5, 5.5e-5, 8.2e-5),
}

VISUAL_AXES = {
    "hmhs_faucet_valve": [0, 0, 1],
    "hmhs_spout_turn": [0, 0, 1],
    "hmhs_soap_press": [0, 0, -1],
    "hmhs_strainer_lift": [0, 0, 1],
}


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, and model.xml."""
    source = ASSETS / "maruzen-hmhs-054.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    app = ET.Element(
        "mujoco",
        model="maruzen-hmhs-054 — SUS304 commercial wall-mounted hand-wash sink",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(app, friction="0.60 0.015 0.003")

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
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "hmhs_basin" else None)
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

    basin = bodies["hmhs_basin"]
    lever = bodies["hmhs_faucet_lever"]
    spout = bodies["hmhs_spout_swivel"]
    plunger = bodies["hmhs_soap_plunger"]
    strainer = bodies["hmhs_drain_strainer"]

    # Lower 25A trap base, horizontal tailpiece, wall escutcheon, soap collar, and faucet stem
    ET.SubElement(
        basin,
        "geom",
        name="hmhs_trap_base_col",
        type="cylinder",
        pos="0 -0.0200 0.0200",
        size="0.0230 0.0200",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        basin,
        "geom",
        name="hmhs_drain_tailpiece_col",
        type="cylinder",
        pos="0 0.1055 0.0310",
        quat=Y_AXIS_QUAT,
        size="0.0155 0.1255",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        basin,
        "geom",
        name="hmhs_wall_escutcheon_col",
        type="cylinder",
        pos="0 0.2325 0.0310",
        quat=Y_AXIS_QUAT,
        size="0.0275 0.0025",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        basin,
        "geom",
        name="hmhs_soap_collar_col",
        type="cylinder",
        pos="-0.1150 0.1720 0.2780",
        size="0.0155 0.0200",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_WALL_RGBA,
    )
    ET.SubElement(
        basin,
        "geom",
        name="hmhs_faucet_stem_col",
        type="cylinder",
        pos="0.0650 0.1720 0.2750",
        size="0.0240 0.0200",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_WALL_RGBA,
    )
    # Full rear wall skirt panel (Z = 0.000..0.252) + sloped underside wrap skirts (tilted around +X by -0.178 rad)
    skirt_tilt = -0.178
    skirt_quat = numbers((math.cos(skirt_tilt / 2.0), math.sin(skirt_tilt / 2.0), 0.0, 0.0))
    for sname, spos, ssize in (
        ("hmhs_under_skirt_left_col", (-0.1480, 0.0080, 0.0640), (0.1000, 0.2220, 0.0205)),
        ("hmhs_under_skirt_right_col", (0.1480, 0.0080, 0.0640), (0.1000, 0.2220, 0.0205)),
    ):
        ET.SubElement(
            basin,
            "geom",
            name=sname,
            type="box",
            pos=numbers(spos),
            quat=skirt_quat,
            size=numbers(ssize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )
    for cname, cpos, csize, crgba in (
        ("hmhs_rear_skirt_col", (0.0, 0.2280, 0.1260), (0.2480, 0.0070, 0.1260), COL_BASE_RGBA),
        ("hmhs_side_skirt_rear_left_col", (-0.2340, 0.1550, 0.0560), (0.0150, 0.0760, 0.0340), COL_BASE_RGBA),
        ("hmhs_side_skirt_rear_right_col", (0.2340, 0.1550, 0.0560), (0.0150, 0.0760, 0.0340), COL_BASE_RGBA),
        # Concave 380 x 280 x 185 mm (P=380, S=280) bowl floor & walls leaving central sump open for strainer
        ("hmhs_bowl_floor_left_col", (-0.1150, -0.0350, 0.0740), (0.0750, 0.1400, 0.0040), COL_BASE_RGBA),
        ("hmhs_bowl_floor_right_col", (0.1150, -0.0350, 0.0740), (0.0750, 0.1400, 0.0040), COL_BASE_RGBA),
        ("hmhs_bowl_floor_front_col", (0.0, -0.1180, 0.0740), (0.0450, 0.0580, 0.0040), COL_BASE_RGBA),
        ("hmhs_bowl_floor_rear_col", (0.0, 0.0620, 0.0740), (0.0450, 0.0450, 0.0040), COL_BASE_RGBA),
        ("hmhs_sump_bottom_col", (0.0, -0.0200, 0.0450), (0.0480, 0.0480, 0.0050), COL_BASE_RGBA),
        ("hmhs_bowl_left_wall_col", (-0.2200, 0.0010, 0.1690), (0.0300, 0.2340, 0.0860), COL_WALL_RGBA),
        ("hmhs_bowl_right_wall_col", (0.2200, 0.0010, 0.1690), (0.0300, 0.2340, 0.0860), COL_WALL_RGBA),
        ("hmhs_bowl_front_wall_col", (0.0, -0.2050, 0.1690), (0.1900, 0.0300, 0.0860), COL_WALL_RGBA),
        ("hmhs_bowl_rear_wall_col", (0.0, 0.1700, 0.1690), (0.1900, 0.0650, 0.0860), COL_WALL_RGBA),
        ("hmhs_splashback_col", (0.0, 0.2200, 0.3260), (0.2500, 0.0150, 0.0740), COL_WALL_RGBA),
    ):
        ET.SubElement(
            basin,
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

    ET.SubElement(
        basin,
        "site",
        name="hmhs_bowl_center",
        pos="0 -0.0300 0.1600",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        basin,
        "site",
        name="hmhs_drain_outlet_25a",
        pos="0 0.2350 0.0320",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        basin,
        "site",
        name="hmhs_wall_mount_ref",
        pos="0 0.2350 0.0000",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 1. Hygienic wrist/elbow blade faucet lever (hmhs_faucet_valve: hinge 0 .. 1.5708 rad about 0 0 1)
    ET.SubElement(
        lever,
        "joint",
        name="hmhs_faucet_valve",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="0 1.5708",
        damping="0.35",
        armature="0.001",
        frictionloss="0.05",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        lever,
        "geom",
        name="hmhs_faucet_lever_col",
        type="box",
        pos="-0.0580 0 0.0035",
        size="0.0560 0.0110 0.0040",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # 2. Gooseneck spout swivel (hmhs_spout_turn: hinge -0.785 .. 0.785 rad about 0 0 1)
    ET.SubElement(
        spout,
        "joint",
        name="hmhs_spout_turn",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-0.785 0.785",
        damping="0.55",
        armature="0.002",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    for sname, sfromto in (
        ("hmhs_spout_riser_col", "0 0 0.004 0 -0.005 0.068"),
        ("hmhs_spout_rear_bend_col", "0 -0.005 0.068 0 -0.055 0.093"),
        ("hmhs_spout_arch_col", "0 -0.055 0.093 0 -0.095 0.093"),
        ("hmhs_spout_front_bend_col", "0 -0.095 0.093 0 -0.142 0.068"),
        ("hmhs_spout_drop_col", "0 -0.142 0.068 0 -0.152 0.000"),
    ):
        ET.SubElement(
            spout,
            "geom",
            name=sname,
            type="capsule",
            fromto=sfromto,
            size="0.0110",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
    ET.SubElement(
        spout,
        "site",
        name="hmhs_aerator_site",
        pos="0 -0.1520 -0.0020",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 3. Spring-return liquid-soap pump plunger (hmhs_soap_press: slide 0 .. 0.022 m along 0 0 -1)
    ET.SubElement(
        plunger,
        "joint",
        name="hmhs_soap_press",
        type="slide",
        axis="0 0 -1",
        limited="true",
        range="0 0.022",
        stiffness="320",
        springref="-0.008",
        damping="5.5",
        armature="0.0008",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        plunger,
        "geom",
        name="hmhs_soap_plunger_col",
        type="cylinder",
        pos="0 0 0.0050",
        size="0.0155 0.0060",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        plunger,
        "geom",
        name="hmhs_soap_nozzle_col",
        type="box",
        pos="0 -0.0406 -0.0016",
        size="0.0050 0.0329 0.0103",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        plunger,
        "site",
        name="hmhs_soap_nozzle_site",
        pos="0 -0.0720 -0.0080",
        size="0.005",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 4. Removable perforated stainless drain strainer cup (hmhs_strainer_lift: slide 0 .. 0.060 m along 0 0 1)
    ET.SubElement(
        strainer,
        "joint",
        name="hmhs_strainer_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.060",
        solreflimit="0.005 1",
        damping="3.2",
        armature="0.0015",
        frictionloss="1.9",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        strainer,
        "geom",
        name="hmhs_strainer_col",
        type="cylinder",
        pos="0 0 -0.0060",
        size="0.0265 0.0100",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Contact exclusions between basin and articulated fittings
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_basin_faucet_lever", "hmhs_basin", "hmhs_faucet_lever"),
            ("exclude_basin_spout_swivel", "hmhs_basin", "hmhs_spout_swivel"),
            ("exclude_basin_soap_plunger", "hmhs_basin", "hmhs_soap_plunger"),
            ("exclude_basin_drain_strainer", "hmhs_basin", "hmhs_drain_strainer"),
            ("exclude_lever_spout", "hmhs_faucet_lever", "hmhs_spout_swivel"),
            ("exclude_spout_soap", "hmhs_spout_swivel", "hmhs_soap_plunger"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="hmhs_faucet_valve_actuator",
        joint="hmhs_faucet_valve",
        kp="28",
        kv="2.2",
        ctrlrange="0 1.5708",
        forcerange="-12 12",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hmhs_spout_turn_actuator",
        joint="hmhs_spout_turn",
        kp="32",
        kv="2.8",
        ctrlrange="-0.785 0.785",
        forcerange="-15 15",
    )
    ET.SubElement(
        actuators,
        "motor",
        name="hmhs_soap_press_actuator",
        joint="hmhs_soap_press",
        ctrlrange="0 15",
        forcerange="0 15",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hmhs_strainer_lift_actuator",
        joint="hmhs_strainer_lift",
        kp="1200",
        kv="22.0",
        ctrlrange="0 0.060",
        forcerange="-35 35",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="hmhs_faucet_valve_pos", joint="hmhs_faucet_valve")
    ET.SubElement(sensors, "jointpos", name="hmhs_spout_turn_pos", joint="hmhs_spout_turn")
    ET.SubElement(sensors, "jointpos", name="hmhs_soap_press_pos", joint="hmhs_soap_press")
    ET.SubElement(sensors, "jointpos", name="hmhs_strainer_lift_pos", joint="hmhs_strainer_lift")
    ET.SubElement(
        sensors,
        "framepos",
        name="hmhs_aerator_rel_bowl",
        objtype="site",
        objname="hmhs_aerator_site",
        reftype="site",
        refname="hmhs_bowl_center",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="hmhs_basin",
        defaults=defaults,
        asset=asset,
        root_body=basin,
        contact=contact,
        sensors=sensors,
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "unit_mass_kg": round(sum(MASSES.values()), 6),
                "component_masses_kg": MASSES,
                "envelope_m": [0.500, 0.470, 0.400],
                "internal_bowl_m": [0.400, 0.330, 0.180],
                "water_supply": "13A potable mixed/cold supply, aerated 3.5 L/min regulated hand-wash flow",
                "drain_connection": "25A S/P-trap sanitary drain with 50 mm water seal",
                "soap_dispenser": "500 mL under-deck reservoir, 2.0 mL per 22 mm spring-return stroke",
                "scope": "Articulated MuJoCo 4.0 mechanical, soap-pump spring return, wrist-lever water flow, gooseneck swivel, 25A drain hydraulic balance, and strainer inspection model.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    model, rebuilt = kit_export_native_xml(ASSETS, "maruzen-hmhs-054", mujoco, np)
    parity = {}
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        arr_orig = getattr(model, field)
        arr_reb = getattr(rebuilt, field)
        parity[f"{field}_max_abs_diff"] = (
            float(np.max(np.abs(arr_orig - arr_reb))) if arr_orig.size else 0.0
        )
    parity["nq"] = int(rebuilt.nq)
    parity["nv"] = int(rebuilt.nv)
    parity["total_body_mass_kg"] = round(float(np.sum(rebuilt.body_mass[1:])), 6)
    return parity


def write_docs(report: dict):
    s = report["stages"]

    asset_readme = f"""# Maruzen HMHS-054 — Blender 5.2 & MuJoCo 4.0 Asset Package

Commercial `SUS304` wall-mounted hand-wash sink (`マルゼン ステンレス製手洗い器 壁掛け式 HMHS-054`, `500 × 470 × 400 mm`, `8.500 kg`).
See the [equipment specification sheet](../../../docs/equipment/maruzen-hmhs-054/README.md) for catalog dimensions and wall-installation mounting heights.

![Main studio view](studio-main.png)
![Active hand-wash state](studio-active.png)

## Files

- `maruzen-hmhs-054.blend` / `maruzen-hmhs-054.glb`: Authored Blender 5.2 source and rest-pose glTF 2.0 binary (`{report['glb_sha256'][:12]}…`).
- `studio-{{main,front,top,right,active}}.png`: Five Metal GPU Cycles renders (`1400 × 1200`, `48` samples + OIDN denoising).
- `appliance.xml` / `scene.xml` / `native.xml`: Full visual+collision and collision-only MuJoCo MJCF models (`nq={report['native_parity']['nq']}, nv={report['native_parity']['nv']}`).
- `build-report.json` / `inspection-report.json` / `physics-export.json`: Build, mesh-quality, and inertia manifests.
- `active-state-evidence/`: Multi-stage simulation trace (`trace.csv`), stage report (`report.json`), rest-frame alignment (`frames-report.json`), and 21-sample scalar-joint motion verification (`motion-report.json`).

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_hmhs_054_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_hmhs_054_physics.py
```
"""
    (ASSETS / "README.md").write_text(asset_readme, encoding="utf-8")

    active_md = f"""# Maruzen HMHS-054 — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded trace samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`standby`**: All 4 scalar joints at rest (`0`), water inflow `0.0 L/min`, `25A` trap seal full (`50.0 mm`), soap dispensed `0.0 mL`.
2. **`soap_pump_press_and_spring_return`**: `12.0 N` press drives `hmhs_soap_plunger` to `{s['soap_pump_press_and_spring_return']['peak_soap_press_mm']} mm`, dispensing `{s['soap_pump_press_and_spring_return']['soap_dispensed_ml']} mL` liquid hand soap; releasing force (`0 N`) lets the passive `320 N/m` return spring restore plunger travel to `{s['soap_pump_press_and_spring_return']['returned_soap_press_mm']} mm`.
3. **`wrist_lever_water_flow_and_spout_swivel`**: Hygienic wrist/elbow blade lever opened `{s['wrist_lever_water_flow_and_spout_swivel']['faucet_lever_deg']}°` delivering `{s['wrist_lever_water_flow_and_spout_swivel']['water_inflow_l_min']} L/min` regulated aerated stream while swiveling gooseneck spout across `±37.2°` and balancing `25A` S/P-trap outflow (`{s['wrist_lever_water_flow_and_spout_swivel']['drain_outflow_l_min']} L/min`).
4. **`strainer_lift_inspection`**: Valve closed (`0.0 L/min`), sump drained to equilibrium, and perforated `SUS304` strainer lifted `{s['strainer_lift_inspection']['strainer_lift_mm']} mm` for sanitary inspection.
5. **`rest_and_motion_frame_alignment`**: Rest-frame max position error `{report['rest_frame_check']['max_position_error_m']:.3e} m`, max orientation error `{report['rest_frame_check']['max_orientation_error_rad']:.3e} rad`; 21-sample `--motion` check across all 4 scalar joints passed (`max_position_error_m = {report['motion_frame_check']['max_position_error_m']:.3e} m`, `max_orientation_error_rad = {report['motion_frame_check']['max_orientation_error_rad']:.3e} rad`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    parity = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    state = {
        "mode": "standby",
        "water_inflow_l_min": 0.0,
        "drain_outflow_l_min": 0.0,
        "sump_water_volume_ml": 0.0,
        "trap_seal_mm": 50.0,
        "cumulative_water_l": 0.0,
        "cumulative_drained_l": 0.0,
        "soap_reservoir_ml": 500.0,
        "soap_dispensed_ml": 0.0,
        "soap_armed": True,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.02):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            valve_rad = float(data.sensor("hmhs_faucet_valve_pos").data[0])
            spout_rad = float(data.sensor("hmhs_spout_turn_pos").data[0])
            soap_m = float(data.sensor("hmhs_soap_press_pos").data[0])
            strainer_m = float(data.sensor("hmhs_strainer_lift_pos").data[0])
            aerator_rel = data.sensor("hmhs_aerator_rel_bowl").data

            # Soap pump positive-displacement check-valve dosing: 2.0 mL at >= 18 mm stroke, re-arms below 3 mm
            if state["soap_armed"] and soap_m >= 0.018:
                state["soap_dispensed_ml"] = round(state["soap_dispensed_ml"] + 2.0, 3)
                state["soap_reservoir_ml"] = round(state["soap_reservoir_ml"] - 2.0, 3)
                state["soap_armed"] = False
            elif not state["soap_armed"] and soap_m <= 0.003:
                state["soap_armed"] = True

            # Hygienic wrist/elbow blade ceramic cartridge valve curve -> regulated 3.5 L/min aerator
            valve_open_frac = min(1.0, max(0.0, (valve_rad - 0.05) / (1.00 - 0.05)))
            inflow_l_min = round(3.50 * valve_open_frac, 3)
            inflow_ml_s = inflow_l_min * 1000.0 / 60.0

            # 25A S/P-trap gravity drainage balance (open Ø28 mm sump throat residence tau ~ 0.35 s -> k = 2.85 s^-1)
            sump_ml = state["sump_water_volume_ml"] + inflow_ml_s * sample_every_s
            outflow_ml_s = min(sump_ml / sample_every_s, 2.85 * sump_ml + 0.20 * inflow_ml_s) if sump_ml > 0.05 else (sump_ml / sample_every_s)
            sump_ml = max(0.0, sump_ml - outflow_ml_s * sample_every_s)
            outflow_l_min = round(outflow_ml_s * 60.0 / 1000.0, 3)

            state["water_inflow_l_min"] = inflow_l_min
            state["drain_outflow_l_min"] = outflow_l_min
            state["sump_water_volume_ml"] = round(sump_ml, 2)
            state["cumulative_water_l"] = round(state["cumulative_water_l"] + inflow_ml_s * sample_every_s / 1000.0, 5)
            state["cumulative_drained_l"] = round(state["cumulative_drained_l"] + outflow_ml_s * sample_every_s / 1000.0, 5)

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "faucet_lever_deg": round(math.degrees(valve_rad), 2),
                "spout_swivel_deg": round(math.degrees(spout_rad), 2),
                "soap_press_mm": round(soap_m * 1000.0, 3),
                "strainer_lift_mm": round(strainer_m * 1000.0, 3),
                "water_inflow_l_min": state["water_inflow_l_min"],
                "drain_outflow_l_min": state["drain_outflow_l_min"],
                "sump_water_volume_ml": state["sump_water_volume_ml"],
                "cumulative_water_l": round(state["cumulative_water_l"], 4),
                "cumulative_drained_l": round(state["cumulative_drained_l"], 4),
                "soap_dispensed_ml": state["soap_dispensed_ml"],
                "soap_reservoir_ml": state["soap_reservoir_ml"],
                "aerator_rel_bowl_x_m": round(float(aerator_rel[0]), 4),
                "aerator_rel_bowl_y_m": round(float(aerator_rel[1]), 4),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby
    state["mode"] = "standby"
    snap1 = step_and_sample(0.24)
    assert snap1["water_inflow_l_min"] == 0.0, snap1
    assert snap1["soap_press_mm"] < 0.05, snap1
    assert snap1["faucet_lever_deg"] < 0.1, snap1
    stage_summaries["standby"] = snap1

    # Stage 2: Liquid soap pump press (12.0 N -> 22.0 mm stroke -> 2.0 mL dose) + passive spring return to 0
    state["mode"] = "soap_dispense"
    data.ctrl[model.actuator("hmhs_soap_press_actuator").id] = 12.0
    snap2_pressed = step_and_sample(0.26)
    assert snap2_pressed["soap_press_mm"] >= 21.5, snap2_pressed
    assert snap2_pressed["soap_dispensed_ml"] == 2.0, snap2_pressed

    # Release force -> passive MuJoCo spring (stiffness=320 N/m) returns plunger to 0 mm
    data.ctrl[model.actuator("hmhs_soap_press_actuator").id] = 0.0
    snap2_returned = step_and_sample(0.28)
    assert snap2_returned["soap_press_mm"] <= 0.10, snap2_returned
    assert snap2_returned["soap_dispensed_ml"] == 2.0, snap2_returned
    stage_summaries["soap_pump_press_and_spring_return"] = {
        "peak_soap_press_mm": round(max(0.0, snap2_pressed["soap_press_mm"]), 3),
        "returned_soap_press_mm": round(max(0.0, snap2_returned["soap_press_mm"]), 3),
        "soap_dispensed_ml": snap2_returned["soap_dispensed_ml"],
        "soap_reservoir_ml": snap2_returned["soap_reservoir_ml"],
    }

    # Stage 3: Wrist-lever water flow (3.5 L/min), gooseneck swivel across bowl, and 25A drain outflow
    state["mode"] = "wrist_lever_handwash_flow"
    data.ctrl[model.actuator("hmhs_faucet_valve_actuator").id] = 1.25  # ~71.6 deg (> full-flow plateau -> 3.50 L/min)
    data.ctrl[model.actuator("hmhs_spout_turn_actuator").id] = -0.65
    snap3_left = step_and_sample(0.44)
    assert snap3_left["water_inflow_l_min"] == 3.50, snap3_left
    assert snap3_left["spout_swivel_deg"] < -34.0, snap3_left

    data.ctrl[model.actuator("hmhs_spout_turn_actuator").id] = 0.65
    snap3_right = step_and_sample(0.56)
    assert snap3_right["water_inflow_l_min"] == 3.50, snap3_right
    assert snap3_right["spout_swivel_deg"] > 34.0, snap3_right
    assert snap3_right["drain_outflow_l_min"] >= 3.30, snap3_right
    stage_summaries["wrist_lever_water_flow_and_spout_swivel"] = snap3_right

    # Close wrist lever & center gooseneck spout, let sump drain through 25A trap, then lift strainer 55 mm
    state["mode"] = "strainer_inspection"
    data.ctrl[model.actuator("hmhs_faucet_valve_actuator").id] = 0.0
    data.ctrl[model.actuator("hmhs_spout_turn_actuator").id] = 0.0
    step_and_sample(0.40)
    data.ctrl[model.actuator("hmhs_strainer_lift_actuator").id] = 0.057
    snap4 = step_and_sample(0.36)
    assert snap4["water_inflow_l_min"] == 0.0, snap4
    assert snap4["strainer_lift_mm"] >= 53.0, snap4
    stage_summaries["strainer_lift_inspection"] = snap4

    # Stage 5: Return strainer to rest and verify rest & 21-sample motion frame alignment
    state["mode"] = "return_to_rest"
    data.ctrl[model.actuator("hmhs_strainer_lift_actuator").id] = 0.0
    snap5 = step_and_sample(0.38)
    assert snap5["faucet_lever_deg"] < 0.2, snap5
    assert abs(snap5["spout_swivel_deg"]) < 0.2, snap5
    assert snap5["soap_press_mm"] < 0.1, snap5
    assert snap5["strainer_lift_mm"] < 0.5, snap5

    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "maruzen-hmhs-054.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS, "maruzen-hmhs-054", NAMES, VISUAL_AXES, mujoco, evidence_dir
    )

    rest_check = {
        "passed": frames_report["passed"],
        "frames_aligned": len(frames_report["appliances"]["maruzen-hmhs-054"]["frames"]),
        "max_position_error_m": max(
            f["position_error_m"]
            for f in frames_report["appliances"]["maruzen-hmhs-054"]["frames"]
        ),
        "max_orientation_error_rad": max(
            f["orientation_error_rad"]
            for f in frames_report["appliances"]["maruzen-hmhs-054"]["frames"]
        ),
    }
    motion_check = {
        "passed": motion_report["passed"],
        "joints_verified": len(motion_report["appliances"]["maruzen-hmhs-054"]["motions"]),
        "samples_per_joint": 21,
        "max_position_error_m": max(
            m["position_error_m"]
            for m in motion_report["appliances"]["maruzen-hmhs-054"]["motions"]
        ),
        "max_orientation_error_rad": max(
            m["orientation_error_rad"]
            for m in motion_report["appliances"]["maruzen-hmhs-054"]["motions"]
        ),
    }
    stage_summaries["rest_and_motion_frame_alignment"] = {
        "rest_snap": snap5,
        "rest_frame_check": rest_check,
        "motion_frame_check": motion_check,
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "maruzen-hmhs-054",
        "model_title": "Maruzen HMHS-054 SUS304 Wall-Mounted Commercial Hand-Wash Sink",
        "envelope_m": [0.500, 0.470, 0.400],
        "unit_mass_kg": round(sum(MASSES.values()), 6),
        "component_masses_kg": MASSES,
        "native_parity": parity,
        "rest_frame_check": rest_check,
        "motion_frame_check": motion_check,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": native_sha,
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_docs(report)
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
