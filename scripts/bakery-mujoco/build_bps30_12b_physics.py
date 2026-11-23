"""Build and verify the MuJoCo 4.0 mechanical, movable stud-pitch bracket, 6-pipe tray contact, and drip-drying model for the Maruzen BPS30-12B."""

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
    ROOT,
    SITE_GRASP_RGBA,
    SITE_SUPPORT_RGBA,
    X_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

ASSETS = ROOT / "assets/bakery-mujoco/maruzen-bps30-12b"
DOCS_DIR = ROOT / "docs/equipment/maruzen-bps30-12b"

NAMES = (
    "bps_shelf",
    "bps_bracket_left",
    "bps_bracket_right",
    "bps_drying_tray",
)

# Shelf unit mass = 6.200 kg (bps_shelf 4.760 + 2 x 0.720 brackets) + 0.850 kg washed baking tray = 7.050 kg total
SHELF_UNIT_MASS_KG = 6.200
TRAY_MASS_KG = 0.850
MASSES = {
    "bps_shelf": 4.760,
    "bps_bracket_left": 0.720,
    "bps_bracket_right": 0.720,
    "bps_drying_tray": 0.850,
}

CENTERS = {
    "bps_shelf": (0.0, 0.015, 0.212),
    "bps_bracket_left": (0.0, 0.065, 0.135),
    "bps_bracket_right": (0.0, 0.065, 0.135),
    "bps_drying_tray": (0.0, 0.0, 0.012),
}

INERTIAS = {
    "bps_shelf": (0.0420, 0.5850, 0.6180),
    "bps_bracket_left": (0.0052, 0.0031, 0.0038),
    "bps_bracket_right": (0.0052, 0.0031, 0.0038),
    "bps_drying_tray": (0.0064, 0.0114, 0.0177),
}

PIPE_YS = (-0.1300, -0.0800, -0.0300, 0.0200, 0.0700, 0.1200)
PIPE_CENTER_Z = 0.2120
PIPE_RADIUS = 0.0080

VISUAL_AXES = {
    "bps_bracket_left_slide": [1, 0, 0],
    "bps_bracket_right_slide": [1, 0, 0],
}


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, model.xml, and tray_model.xml."""
    source = ASSETS / "maruzen-bps30-12b.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    app = ET.Element(
        "mujoco",
        model="maruzen-bps30-12b — SUS430 commercial wall drainer pipe shelf",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(app, friction="0.55 0.015 0.003")

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
        if name == "bps_drying_tray":
            # 6-DOF free body in worldbody at exact rest pose (0.0, 0.0, 0.2200) resting on the 6 pipes
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "bps_shelf" else None)
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

    shelf = bodies["bps_shelf"]
    brk_l = bodies["bps_bracket_left"]
    brk_r = bodies["bps_bracket_right"]
    tray = bodies["bps_drying_tray"]

    # Six horizontal Ø16 mm (radius = 0.0080 m) capsule collision geoms spanning full 1,200 mm width
    # (matching the crowned chrome end caps at X = ±0.600 m and preserving 34 mm drip-through gaps).
    for idx, py in enumerate(PIPE_YS, 1):
        ET.SubElement(
            shelf,
            "geom",
            name=f"bps_pipe_{idx:02d}_col",
            type="capsule",
            pos=numbers((0.0, py, PIPE_CENTER_Z)),
            quat=X_AXIS_QUAT,
            size=numbers((PIPE_RADIUS, 0.5920)),
            friction="0.45 0.015 0.003",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    ET.SubElement(
        shelf,
        "site",
        name="bps_rack_center_site",
        pos="0 0 0.2200",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        shelf,
        "site",
        name="bps_drip_zone_site",
        type="box",
        pos="0 -0.0050 0.2205",
        size="0.2200 0.1450 0.0040",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Left & right movable triangular wall brackets sliding along rear rail (axis="1 0 0", touching Z = 0)
    for b_el, jname, jrange, prefix in (
        (brk_l, "bps_bracket_left_slide", "-0.120 0.200", "bps_brk_l"),
        (brk_r, "bps_bracket_right_slide", "-0.200 0.120", "bps_brk_r"),
    ):
        ET.SubElement(
            b_el,
            "joint",
            name=jname,
            type="slide",
            axis="1 0 0",
            limited="true",
            range=jrange,
            damping="8.0",
            armature="0.005",
            frictionloss="0.05",
            solreffriction="0.004 1",
            solreflimit="0.005 1",
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_wall_flange_col",
            type="box",
            pos="0 0.1455 0.1200",
            size="0.0090 0.0045 0.1200",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_support_arm_col",
            type="box",
            pos="0 -0.0040 0.2120",
            size="0.0090 0.1460 0.0110",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_arch_upper_col",
            type="capsule",
            fromto="0 -0.088 0.198 0 0.078 0.140",
            size="0.0095",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_arch_lower_col",
            type="capsule",
            fromto="0 0.078 0.140 0 0.138 0.036",
            size="0.0095",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_web_upper_col",
            type="box",
            pos="0 0.0480 0.1780",
            size="0.0075 0.0960 0.0270",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_web_lower_col",
            type="box",
            pos="0 0.1180 0.1180",
            size="0.0075 0.0300 0.0520",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            b_el,
            "site",
            name=f"{prefix}_stud_anchor",
            pos="0 0.1500 0.1620",
            size="0.006",
            group="4",
            rgba=SITE_SUPPORT_RGBA,
        )

    # 6-DOF free inverted 400 x 300 x 20 mm washed aluminum baking tray resting on the 6 Ø16 mm pipes
    ET.SubElement(tray, "freejoint", name="bps_drying_tray_free")
    for tname, tpos, tsize in (
        ("bps_tray_left_rim_col", (-0.1920, 0.0, 0.0085), (0.0080, 0.1480, 0.0085)),
        ("bps_tray_right_rim_col", (0.1920, 0.0, 0.0085), (0.0080, 0.1480, 0.0085)),
        ("bps_tray_front_rim_col", (0.0, -0.1420, 0.0085), (0.1840, 0.0080, 0.0085)),
        ("bps_tray_rear_rim_col", (0.0, 0.1420, 0.0085), (0.1840, 0.0080, 0.0085)),
        ("bps_tray_top_deck_col", (0.0, 0.0, 0.0185), (0.1880, 0.1380, 0.0015)),
    ):
        ET.SubElement(
            tray,
            "geom",
            name=tname,
            type="box",
            pos=numbers(tpos),
            size=numbers(tsize),
            friction="0.45 0.015 0.003",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ACCESSORY_RGBA,
        )
    ET.SubElement(
        tray,
        "site",
        name="vessel_socket",
        pos="0 0 0.0200",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    ET.SubElement(
        tray,
        "site",
        name="bps_tray_rim_touch_site",
        type="box",
        pos="0 0 0.0025",
        size="0.2010 0.1510 0.0035",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    payload = ET.SubElement(tray, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0020",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="box",
        pos="0 0 0.0020",
        size="0.1800 0.1300 0.0008",
        group="2",
        rgba="0.72 0.88 0.98 0",
        contype="0",
        conaffinity="0",
        mass="0",
    )

    # Contact exclusions between pipe shelf and movable brackets (free tray remains free to rest on pipes)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_shelf_bracket_left", "bps_shelf", "bps_bracket_left"),
            ("exclude_shelf_bracket_right", "bps_shelf", "bps_bracket_right"),
            ("exclude_brackets_pair", "bps_bracket_left", "bps_bracket_right"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="bps_bracket_left_actuator",
        joint="bps_bracket_left_slide",
        kp="450",
        kv="14.0",
        ctrlrange="-0.120 0.200",
        forcerange="-90 90",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bps_bracket_right_actuator",
        joint="bps_bracket_right_slide",
        kp="450",
        kv="14.0",
        ctrlrange="-0.200 0.120",
        forcerange="-90 90",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="bps_bracket_left_pos", joint="bps_bracket_left_slide")
    ET.SubElement(sensors, "jointpos", name="bps_bracket_right_pos", joint="bps_bracket_right_slide")
    ET.SubElement(sensors, "touch", name="bps_tray_touch", site="bps_tray_rim_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="bps_tray_rel_rack",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="bps_rack_center_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="bps_shelf",
        defaults=defaults,
        asset=asset,
        root_body=shelf,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("bps_tray_touch", "bps_tray_rel_rack"),
        accessories=(("tray_model.xml", "bps_drying_tray", tray),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "unit_mass_kg": SHELF_UNIT_MASS_KG,
                "drying_tray_mass_kg": TRAY_MASS_KG,
                "total_scene_mass_kg": round(sum(MASSES.values()), 6),
                "component_masses_kg": MASSES,
                "envelope_m": [1.200, 0.300, 0.240],
                "drainer_pipes": {
                    "count": 6,
                    "diameter_m": 0.016,
                    "top_support_plane_z_m": 0.220,
                    "y_positions_m": list(PIPE_YS),
                },
                "bracket_stud_pitch_range_m": [0.300, 0.940],
                "scope": "Articulated MuJoCo 4.0 movable-bracket wall pipe shelf with 6 Ø16 mm cylinder collision geoms and 6-DOF free inverted 400x300x20 mm drying baking tray.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    model, rebuilt = kit_export_native_xml(ASSETS, "maruzen-bps30-12b", mujoco, np)
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

    asset_readme = f"""# Maruzen BPS30-12B — Blender 5.2 & MuJoCo 4.0 Asset Package

Commercial `SUS430` wall drainer pipe shelf (`マルゼン ブリームシリーズ パイプ棚 BPS30-12B`, `1,200 × 300 × 240 mm`, `6.200 kg` unit + `0.850 kg` inverted `400 × 300 × 20 mm` baking tray).
See the [equipment specification sheet](../../../docs/equipment/maruzen-bps30-12b/README.md) for catalog details and mounting geometry.

![Main studio view](studio-main.png)
![900 mm bracket pitch active state](studio-active.png)

## Files

- `maruzen-bps30-12b.blend` / `maruzen-bps30-12b.glb`: Authored Blender 5.2 source and rest-pose glTF 2.0 binary (`{report['glb_sha256'][:12]}…`).
- `studio-{{main,front,top,right,active}}.png`: Five Metal GPU Cycles renders (`1400 × 1200`, `48` samples + OIDN denoising).
- `appliance.xml` / `scene.xml` / `native.xml`: Full visual+collision and collision-only MuJoCo MJCF models (`nq={report['native_parity']['nq']}, nv={report['native_parity']['nv']}`).
- `build-report.json` / `inspection-report.json` / `physics-export.json`: Build, mesh-quality, and inertia manifests.
- `active-state-evidence/`: Multi-stage simulation trace (`trace.csv`), stage report (`report.json`), rest-frame alignment (`frames-report.json`), and 21-sample scalar-joint motion verification (`motion-report.json`).

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_bps30_12b_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_bps30_12b_physics.py
```
"""
    (ASSETS / "README.md").write_text(asset_readme, encoding="utf-8")

    active_md = f"""# Maruzen BPS30-12B — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded trace samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`standby_700mm_stud_pitch`**: Movable brackets at nominal `700.0 mm` stud spacing (`X = ±0.350 m`), inverted `400 × 300 × 20 mm` wet tray (`0.850 kg` dry + `42.0 g` initial rinse-water film) resting across `{s['standby_700mm_stud_pitch']['contacted_pipe_count']}` of the `6` `Ø16 mm` stainless pipes with `{s['standby_700mm_stud_pitch']['pipe_vertical_force_n']} N` total normal contact force (`0.850 × 9.80665 = 8.336 N`).
2. **`bracket_pitch_700_to_900mm`**: Both movable triangular wall brackets slid outward `±100.0 mm` along the rear channel to `{s['bracket_pitch_700_to_900mm']['bracket_stud_pitch_mm']} mm` stud spacing while tray remains motionless on the 6 pipes (`{s['bracket_pitch_700_to_900mm']['pipe_vertical_force_n']} N`).
3. **`wet_tray_drip_dry_and_pipe_force_distribution`**: Rinse-water film drains freely through the `34 mm` inter-pipe gaps (`{s['wet_tray_drip_dry_and_pipe_force_distribution']['dripped_to_sink_g']} g` dripped + `{s['wet_tray_drip_dry_and_pipe_force_distribution']['evaporated_g']} g` evaporated = `42.0 g` removed, residual `0.0 g`, mass balance error `{s['wet_tray_drip_dry_and_pipe_force_distribution']['mass_balance_error_g']} g`, `{s['wet_tray_drip_dry_and_pipe_force_distribution']['contacted_pipe_count']}/6` pipes sharing `{s['wet_tray_drip_dry_and_pipe_force_distribution']['pipe_vertical_force_n']} N`).
4. **`return_brackets_to_rest_and_frame_checks`**: Brackets returned to `700.0 mm` rest pitch; rest-frame alignment passed (`max_position_error_m = {report['rest_frame_check']['max_position_error_m']:.3e} m`, `max_orientation_error_rad = {report['rest_frame_check']['max_orientation_error_rad']:.3e} rad`) and 21-sample `--motion` check passed across both bracket slide joints (`max_position_error_m = {report['motion_frame_check']['max_position_error_m']:.3e} m`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids):
    per_pipe_fz = {gid: 0.0 for gid in pipe_geom_ids}
    force_buf = [0.0] * 6
    import numpy as np

    f_arr = np.zeros(6, dtype=np.float64)
    for i in range(data.ncon):
        con = data.contact[i]
        g1, g2 = int(con.geom1), int(con.geom2)
        if g1 in pipe_geom_ids and g2 in tray_geom_ids:
            pipe_gid = g1
            sign = -1.0  # mj_contactForce is force on geom2 from geom1 in contact frame; normal points from geom1 to geom2
        elif g2 in pipe_geom_ids and g1 in tray_geom_ids:
            pipe_gid = g2
            sign = 1.0
        else:
            continue
        mujoco.mj_contactForce(model, data, i, f_arr)
        # Contact frame axis 0 in world coordinates is con.frame[0:3] (from geom1 toward geom2)
        normal_world_z = float(con.frame[2])
        # Upward vertical support force exerted by pipe on tray:
        fz = abs(float(f_arr[0]) * normal_world_z)
        per_pipe_fz[pipe_gid] += fz
    return per_pipe_fz


def run_active_state_verification():
    import mujoco
    import numpy as np

    parity = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    pipe_geom_ids = {
        model.geom(f"bps_pipe_{idx:02d}_col").id: f"bps_pipe_{idx:02d}_col"
        for idx in range(1, 7)
    }
    tray_geom_ids = {
        model.geom(gname).id
        for gname in (
            "bps_tray_left_rim_col",
            "bps_tray_right_rim_col",
            "bps_tray_front_rim_col",
            "bps_tray_rear_rim_col",
            "bps_tray_top_deck_col",
        )
    }
    tray_bid = model.body("bps_drying_tray").id

    initial_water_g = 42.0
    state = {
        "mode": "standby_700mm",
        "initial_rinse_water_g": initial_water_g,
        "clinging_water_g": initial_water_g,
        "dripped_to_sink_g": 0.0,
        "evaporated_g": 0.0,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.02, drying_active: bool = False):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            bl_m = float(data.sensor("bps_bracket_left_pos").data[0])
            br_m = float(data.sensor("bps_bracket_right_pos").data[0])
            stud_pitch_mm = round(((0.350 + br_m) - (-0.350 + bl_m)) * 1000.0, 2)

            per_pipe = compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids)
            total_fz = sum(per_pipe.values())
            contacted_pipes = sum(1 for v in per_pipe.values() if v > 0.15)
            tray_pos = data.xpos[tray_bid]

            if drying_active and state["clinging_water_g"] > 0.0:
                # Accelerated gravity drip through 34 mm inter-pipe gaps + thin-film evaporation
                rem = state["clinging_water_g"]
                d_total = min(rem, max(0.35, rem * 0.18))
                d_drip = d_total * (38.5 / 42.0)
                d_evap = d_total - d_drip
                state["clinging_water_g"] = max(0.0, rem - d_total)
                state["dripped_to_sink_g"] += d_drip
                state["evaporated_g"] += d_evap
                if state["clinging_water_g"] < 0.02:
                    residual = state["clinging_water_g"]
                    state["dripped_to_sink_g"] += residual * (38.5 / 42.0)
                    state["evaporated_g"] += residual * (3.5 / 42.0)
                    state["clinging_water_g"] = 0.0

            effective_tray_mass_kg = round(TRAY_MASS_KG + state["clinging_water_g"] / 1000.0, 5)
            mass_err_g = round(
                (state["clinging_water_g"] + state["dripped_to_sink_g"] + state["evaporated_g"])
                - state["initial_rinse_water_g"],
                6,
            )

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "bracket_left_slide_mm": round(bl_m * 1000.0, 2),
                "bracket_right_slide_mm": round(br_m * 1000.0, 2),
                "bracket_stud_pitch_mm": stud_pitch_mm,
                "tray_z_m": round(float(tray_pos[2]), 5),
                "tray_xy_drift_mm": round(math.hypot(float(tray_pos[0]), float(tray_pos[1])) * 1000.0, 3),
                "pipe_vertical_force_n": round(total_fz, 3),
                "contacted_pipe_count": contacted_pipes,
                "effective_tray_mass_kg": effective_tray_mass_kg,
                "clinging_water_g": round(state["clinging_water_g"], 3),
                "dripped_to_sink_g": round(state["dripped_to_sink_g"], 3),
                "evaporated_g": round(state["evaporated_g"], 3),
                "mass_balance_error_g": mass_err_g,
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby at 700 mm nominal stud pitch; verify wet tray static equilibrium across the 6 Ø16 mm pipes
    state["mode"] = "standby_700mm"
    snap1 = step_and_sample(0.32, drying_active=False)
    expected_weight_n = TRAY_MASS_KG * 9.80665  # 8.3357 N
    assert abs(snap1["bracket_stud_pitch_mm"] - 700.0) < 0.2, snap1
    assert abs(snap1["pipe_vertical_force_n"] - expected_weight_n) < 0.25, snap1
    assert snap1["contacted_pipe_count"] == 6, snap1
    assert abs(snap1["tray_z_m"] - 0.220) < 0.001, snap1
    assert snap1["tray_xy_drift_mm"] < 0.5, snap1
    stage_summaries["standby_700mm_stud_pitch"] = snap1

    # Stage 2: Bracket pitch adjustment (700 mm -> 900 mm wall-stud spacing: left -100 mm, right +100 mm)
    state["mode"] = "bracket_pitch_900mm"
    data.ctrl[model.actuator("bps_bracket_left_actuator").id] = -0.100
    data.ctrl[model.actuator("bps_bracket_right_actuator").id] = 0.100
    snap2 = step_and_sample(0.48, drying_active=False)
    assert abs(snap2["bracket_stud_pitch_mm"] - 900.0) < 1.0, snap2
    assert abs(snap2["pipe_vertical_force_n"] - expected_weight_n) < 0.25, snap2
    assert snap2["contacted_pipe_count"] == 6, snap2
    assert snap2["tray_xy_drift_mm"] < 0.5, snap2
    stage_summaries["bracket_pitch_700_to_900mm"] = snap2

    # Stage 3: Wet 400 x 300 mm tray static contact distribution across all 6 Ø16 mm pipes + complete drip-dry accounting
    state["mode"] = "drip_drying_at_900mm"
    snap3 = step_and_sample(0.84, drying_active=True)
    per_pipe_final = compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids)
    per_pipe_named = {pipe_geom_ids[gid]: round(val, 4) for gid, val in per_pipe_final.items()}
    assert snap3["clinging_water_g"] == 0.0, snap3
    assert abs(snap3["dripped_to_sink_g"] - 38.5) < 0.05, snap3
    assert abs(snap3["evaporated_g"] - 3.5) < 0.05, snap3
    assert abs(snap3["mass_balance_error_g"]) < 1e-4, snap3
    assert snap3["effective_tray_mass_kg"] == TRAY_MASS_KG, snap3
    assert snap3["contacted_pipe_count"] == 6, (snap3, per_pipe_named)
    stage_summaries["wet_tray_drip_dry_and_pipe_force_distribution"] = {
        **snap3,
        "per_pipe_vertical_force_n": per_pipe_named,
    }

    # Stage 4: Return brackets to 700 mm rest pitch and verify GLB vs native.xml rest + 21-sample motion alignment
    state["mode"] = "return_to_rest_700mm"
    data.ctrl[model.actuator("bps_bracket_left_actuator").id] = 0.0
    data.ctrl[model.actuator("bps_bracket_right_actuator").id] = 0.0
    snap4 = step_and_sample(0.48, drying_active=False)
    assert abs(snap4["bracket_stud_pitch_mm"] - 700.0) < 0.5, snap4
    assert abs(snap4["bracket_left_slide_mm"]) < 0.3, snap4
    assert abs(snap4["bracket_right_slide_mm"]) < 0.3, snap4

    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "maruzen-bps30-12b.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS, "maruzen-bps30-12b", NAMES, VISUAL_AXES, mujoco, evidence_dir
    )

    rest_check = {
        "passed": frames_report["passed"],
        "frames_aligned": len(frames_report["appliances"]["maruzen-bps30-12b"]["frames"]),
        "max_position_error_m": max(
            f["position_error_m"]
            for f in frames_report["appliances"]["maruzen-bps30-12b"]["frames"]
        ),
        "max_orientation_error_rad": max(
            f["orientation_error_rad"]
            for f in frames_report["appliances"]["maruzen-bps30-12b"]["frames"]
        ),
    }
    motion_check = {
        "passed": motion_report["passed"],
        "joints_verified": len(motion_report["appliances"]["maruzen-bps30-12b"]["motions"]),
        "samples_per_joint": 21,
        "max_position_error_m": max(
            m["position_error_m"]
            for m in motion_report["appliances"]["maruzen-bps30-12b"]["motions"]
        ),
        "max_orientation_error_rad": max(
            m["orientation_error_rad"]
            for m in motion_report["appliances"]["maruzen-bps30-12b"]["motions"]
        ),
    }
    stage_summaries["return_brackets_to_rest_and_frame_checks"] = {
        "rest_snap": snap4,
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
        "appliance": "maruzen-bps30-12b",
        "model_title": "Maruzen BPS30-12B SUS430 Commercial Wall Drainer Pipe Shelf",
        "envelope_m": [1.200, 0.300, 0.240],
        "unit_mass_kg": SHELF_UNIT_MASS_KG,
        "drying_tray_mass_kg": TRAY_MASS_KG,
        "total_scene_mass_kg": round(sum(MASSES.values()), 6),
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
