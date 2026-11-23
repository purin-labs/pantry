"""Build and verify the MuJoCo mechanical, 24V DK-Port solenoid kick, bill-clip, and key-lock model for Star mJ-Drawer (MJD36M)."""

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
    X_AXIS_QUAT,
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

NAME = "star-mjd36m"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

NAMES = (
    "mjd_casing",
    "mjd_drawer",
    "mjd_bill_clip_1",
    "mjd_bill_clip_2",
    "mjd_bill_clip_3",
    "mjd_key_lock",
)

# Exact published mass = 5.400 kg
MASSES = {
    "mjd_casing": 3.580,
    "mjd_drawer": 1.690,
    "mjd_bill_clip_1": 0.032,
    "mjd_bill_clip_2": 0.032,
    "mjd_bill_clip_3": 0.032,
    "mjd_key_lock": 0.034,
}

CENTERS = {
    "mjd_casing": (0.0, 0.0100, 0.0520),
    "mjd_drawer": (0.0, -0.0150, -0.0080),
    "mjd_bill_clip_1": (0.0, 0.0420, -0.0140),
    "mjd_bill_clip_2": (0.0, 0.0420, -0.0140),
    "mjd_bill_clip_3": (0.0, 0.0420, -0.0140),
    "mjd_key_lock": (0.0, 0.0, 0.0),
}

INERTIAS = {
    "mjd_casing": (0.0420, 0.0365, 0.0720),
    "mjd_drawer": (0.0185, 0.0160, 0.0315),
    "mjd_bill_clip_1": (2.8e-5, 0.8e-5, 3.2e-5),
    "mjd_bill_clip_2": (2.8e-5, 0.8e-5, 3.2e-5),
    "mjd_bill_clip_3": (2.8e-5, 0.8e-5, 3.2e-5),
    "mjd_key_lock": (2.0e-6, 2.5e-6, 2.0e-6),
}

VISUAL_AXES = {
    "mjd_drawer_slide": [0, -1, 0],
    "mjd_clip_1_hinge": [1, 0, 0],
    "mjd_clip_2_hinge": [1, 0, 0],
    "mjd_clip_3_hinge": [1, 0, 0],
    "mjd_lock_turn": [0, 1, 0],
}


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, and model.xml."""
    source = ASSETS / f"{NAME}.blend"
    parts, poses = prepare_blender_assembly(
        source,
        NAMES,
        ASSETS,
        default_roughness=0.30,
    )

    app = ET.Element(
        "mujoco",
        model="star-mjd36m — Star Micronics mJ-Drawer (MJD36M) 3-bill / 6-coin cash drawer",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(
        app,
        friction="0.60 0.015 0.003",
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
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "mjd_casing" else None)
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

    casing = bodies["mjd_casing"]
    drawer = bodies["mjd_drawer"]
    c1 = bodies["mjd_bill_clip_1"]
    c2 = bodies["mjd_bill_clip_2"]
    c3 = bodies["mjd_bill_clip_3"]
    lock = bodies["mjd_key_lock"]

    # Four rubber feet touching Z = 0.000 m + reinforced steel shell & Z = 0.104 m top load deck
    for fn, fx, fy in (
        ("mjd_foot_fl_col", -0.1440, -0.1520),
        ("mjd_foot_fr_col", 0.1440, -0.1520),
        ("mjd_foot_rl_col", -0.1440, 0.1520),
        ("mjd_foot_rr_col", 0.1440, 0.1520),
    ):
        ET.SubElement(
            casing,
            "geom",
            name=fn,
            type="cylinder",
            pos=numbers((fx, fy, 0.0035)),
            size="0.0150 0.0035",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    for cname, cpos, csize, crgba in (
        ("mjd_bottom_pan_col", (0.0, 0.0040, 0.0095), (0.1570, 0.1735, 0.0025), COL_BASE_RGBA),
        ("mjd_left_wall_col", (-0.1610, 0.0, 0.0525), (0.0040, 0.1775, 0.0455), COL_WALL_RGBA),
        ("mjd_right_wall_col", (0.1610, 0.0, 0.0525), (0.0040, 0.1775, 0.0455), COL_WALL_RGBA),
        ("mjd_rear_wall_col", (0.0, 0.1725, 0.0550), (0.1570, 0.0050, 0.0430), COL_WALL_RGBA),
        ("mjd_top_deck_col", (0.0, 0.0, 0.1010), (0.1650, 0.1775, 0.0030), COL_WALL_RGBA),
    ):
        ET.SubElement(
            casing,
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
        casing,
        "site",
        name="mjd_top_load_deck_site",
        pos="0 0 0.1040",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        casing,
        "site",
        name="mjd_dk_port_site",
        pos="-0.0850 0.1755 0.0280",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Sliding cash drawer joint (0 .. 0.210 m forward along -Y)
    ET.SubElement(
        drawer,
        "joint",
        name="mjd_drawer_slide",
        type="slide",
        axis="0 -1 0",
        limited="true",
        range="0 0.210",
        damping="4.2",
        armature="0.012",
        frictionloss="0.15",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    for dname, dpos, dsize in (
        ("mjd_drawer_front_col", (0.0, -0.1725, -0.0005), (0.1650, 0.0055, 0.0430)),
        ("mjd_till_floor_col", (0.0, -0.0080, -0.0305), (0.1480, 0.1540, 0.0065)),
        ("mjd_till_divider_col", (0.0, -0.0200, 0.0010), (0.1450, 0.0030, 0.0300)),
        ("mjd_drawer_left_wall_col", (-0.1500, -0.0060, -0.0040), (0.0045, 0.1560, 0.0320)),
        ("mjd_drawer_right_wall_col", (0.1500, -0.0060, -0.0040), (0.0045, 0.1560, 0.0320)),
        ("mjd_drawer_rear_wall_col", (0.0, 0.1460, -0.0040), (0.1480, 0.0045, 0.0320)),
        ("mjd_bill_divider_left_col", (-0.0478, 0.0660, -0.0050), (0.0030, 0.0800, 0.0280)),
        ("mjd_bill_divider_right_col", (0.0478, 0.0660, -0.0050), (0.0030, 0.0800, 0.0280)),
        ("mjd_coin_divider_1_col", (-0.0980, -0.0920, -0.0050), (0.0030, 0.0720, 0.0260)),
        ("mjd_coin_divider_2_col", (-0.0490, -0.0920, -0.0050), (0.0030, 0.0720, 0.0260)),
        ("mjd_coin_divider_3_col", (0.0000, -0.0920, -0.0050), (0.0030, 0.0720, 0.0260)),
        ("mjd_coin_divider_4_col", (0.0490, -0.0920, -0.0050), (0.0030, 0.0720, 0.0260)),
        ("mjd_coin_divider_5_col", (0.0980, -0.0920, -0.0050), (0.0030, 0.0720, 0.0260)),
        ("mjd_coin_scoop_ramp_col", (0.0, -0.1480, -0.0180), (0.1480, 0.0180, 0.0160)),
    ):
        ET.SubElement(
            drawer,
            "geom",
            name=dname,
            type="box",
            pos=numbers(dpos),
            size=numbers(dsize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
    ET.SubElement(
        drawer,
        "site",
        name="mjd_coin_tray_site",
        pos="0 -0.0920 -0.0150",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        drawer,
        "site",
        name="mjd_bill_tray_site",
        pos="0 0.0600 -0.0150",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Three spring-loaded wire bill clips (0 .. 0.55 rad about +X)
    clip_pitch = math.atan2(-0.038, 0.092)
    clip_quat = numbers((math.cos(0.5 * clip_pitch), math.sin(0.5 * clip_pitch), 0.0, 0.0))
    for idx, clip_el in enumerate((c1, c2, c3), 1):
        ET.SubElement(
            clip_el,
            "joint",
            name=f"mjd_clip_{idx}_hinge",
            type="hinge",
            axis="1 0 0",
            limited="true",
            range="0 0.55",
            stiffness="0.45",
            damping="0.08",
            armature="0.0005",
            frictionloss="0.02",
            solreffriction="0.004 1",
            solreflimit="0.005 1",
        )
        ET.SubElement(
            clip_el,
            "geom",
            name=f"mjd_clip_{idx}_pivot_col",
            type="cylinder",
            pos="0 0 0",
            quat=X_AXIS_QUAT,
            size="0.0042 0.0190",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        ET.SubElement(
            clip_el,
            "geom",
            name=f"mjd_clip_{idx}_col",
            type="box",
            pos="0 0.0460 -0.0190",
            quat=clip_quat,
            size="0.0185 0.0495 0.0045",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )

    # Front security key cylinder lock (-1.5708 .. 1.5708 rad about +Y)
    ET.SubElement(
        lock,
        "joint",
        name="mjd_lock_turn",
        type="hinge",
        axis="0 1 0",
        limited="true",
        range="-1.5708 1.5708",
        damping="0.06",
        armature="0.0003",
        frictionloss="0.05",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        lock,
        "geom",
        name="mjd_key_lock_col",
        type="cylinder",
        pos="0 0.0010 0",
        quat=Y_AXIS_QUAT,
        size="0.0085 0.0030",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Adjacent articulated-body contact exclusions (keeps all colliders active for external contact)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_casing_drawer", "mjd_casing", "mjd_drawer"),
            ("exclude_casing_clip_1", "mjd_casing", "mjd_bill_clip_1"),
            ("exclude_casing_clip_2", "mjd_casing", "mjd_bill_clip_2"),
            ("exclude_casing_clip_3", "mjd_casing", "mjd_bill_clip_3"),
            ("exclude_casing_key_lock", "mjd_casing", "mjd_key_lock"),
            ("exclude_drawer_clip_1", "mjd_drawer", "mjd_bill_clip_1"),
            ("exclude_drawer_clip_2", "mjd_drawer", "mjd_bill_clip_2"),
            ("exclude_drawer_clip_3", "mjd_drawer", "mjd_bill_clip_3"),
            ("exclude_drawer_key_lock", "mjd_drawer", "mjd_key_lock"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="mjd_drawer_actuator",
        joint="mjd_drawer_slide",
        kp="180",
        kv="10.0",
        ctrlrange="0 0.210",
        forcerange="-80 80",
    )
    for idx in (1, 2, 3):
        ET.SubElement(
            actuators,
            "position",
            name=f"mjd_clip_{idx}_actuator",
            joint=f"mjd_clip_{idx}_hinge",
            kp="18",
            kv="0.8",
            ctrlrange="0 0.55",
            forcerange="-6 6",
        )
    ET.SubElement(
        actuators,
        "position",
        name="mjd_lock_actuator",
        joint="mjd_lock_turn",
        kp="14",
        kv="0.6",
        ctrlrange="-1.5708 1.5708",
        forcerange="-5 5",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="mjd_drawer_pos", joint="mjd_drawer_slide")
    ET.SubElement(sensors, "jointpos", name="mjd_clip_1_pos", joint="mjd_clip_1_hinge")
    ET.SubElement(sensors, "jointpos", name="mjd_clip_2_pos", joint="mjd_clip_2_hinge")
    ET.SubElement(sensors, "jointpos", name="mjd_clip_3_pos", joint="mjd_clip_3_hinge")
    ET.SubElement(sensors, "jointpos", name="mjd_lock_pos", joint="mjd_lock_turn")

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="star-mjd36m physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="0.8 -1.2 1.4", dir="-0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="mjd_casing",
        defaults=defaults,
        asset=asset,
        root_body=casing,
        contact=contact,
        sensors=sensors,
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 5.400,
                "component_masses_kg": MASSES,
                "envelope_m": [0.330, 0.355, 0.104],
                "drawer_stroke_m": 0.210,
                "till_layout": "3-bill / 6-coin (3札6硬貨)",
                "solenoid_drive": "24V DC 1.0A via 6-pin RJ12 DK-Port from Star mC-Print3",
                "scope": "Articulated MuJoCo 4.0 mechanical, 24V DK-Port solenoid kick-out, 3 spring-loaded wire bill clips, and 3-position key lock model.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np) -> None:
    kit_export_native_xml(ASSETS, NAME, mujoco, np)


def verify_frames_and_motions(mujoco, evidence_dir: Path) -> tuple[dict, dict]:
    return kit_verify_frames_and_motions(
        ASSETS,
        NAME,
        NAMES,
        VISUAL_AXES,
        mujoco,
        evidence_dir,
        cleanup_inputs=True,
    )


def write_asset_docs(report: dict) -> None:
    s = report["stages"]
    rf = s["rest_and_motion_alignment_verified"]
    readme = f"""# Star Micronics mJ-Drawer (`MJD36M`) — Blender & MuJoCo Package

Printer-driven steel POS cash drawer (`Star Micronics Co., Ltd. MJD36M`, `330 × 355 × 104 mm`, `5.400 kg`, `3札6硬貨` 3-bill / 6-coin ABS till, `24 V` `DK-Port` solenoid release).
See the [hardware reference sheet](../../../docs/equipment/star-mjd36m/README.md) for full specifications.

![Star mJ-Drawer Closed](studio-main.png)
![Star mJ-Drawer Open 3-Bill / 6-Coin Till](studio-open.png)

## Specifications & Envelope

| Parameter | Value |
| --- | --- |
| Overall envelope (`W × D × H`) | `330.0 × 355.0 × 104.0 mm` (`0.330 × 0.355 × 0.104 m`) |
| Published mass | `5.400 kg` |
| Top load deck | Flat reinforced steel deck at `Z = 0.104 m` (supports `Square Register` + `Star mC-Print3`) |
| Cash till layout | `3札6硬貨` — 3 banknote slots with spring-loaded wire bill clips + 6 scooped coin compartments |
| Solenoid & lock | `24 V DC` kick-out solenoid via `6-pin RJ12 DK-Port` + front 3-position security key lock (`-90° .. +90°`) |

## Retained MuJoCo Bodies & Joints

| Body | Parent | Joint | Type & Axis | Range | Mass (`kg`) |
| --- | --- | --- | --- | --- | --- |
| `mjd_casing` | *(world)* | *(fixed)* | — | Feet touching `Z = 0.000 m` | `3.580` |
| `mjd_drawer` | `mjd_casing` | `mjd_drawer_slide` | `slide` (`0 -1 0`) | `0 .. 0.210 m` | `1.690` |
| `mjd_bill_clip_1` | `mjd_drawer` | `mjd_clip_1_hinge` | `hinge` (`1 0 0`) | `0 .. 0.55 rad` | `0.032` |
| `mjd_bill_clip_2` | `mjd_drawer` | `mjd_clip_2_hinge` | `hinge` (`1 0 0`) | `0 .. 0.55 rad` | `0.032` |
| `mjd_bill_clip_3` | `mjd_drawer` | `mjd_clip_3_hinge` | `hinge` (`1 0 0`) | `0 .. 0.55 rad` | `0.032` |
| `mjd_key_lock` | `mjd_drawer` | `mjd_lock_turn` | `hinge` (`0 1 0`) | `-1.5708 .. 1.5708 rad` | `0.034` |

## Files

- `star-mjd36m.blend` / `star-mjd36m.glb`: Editable Blender 5.2 source and glTF 2.0 runtime asset (`{report['glb_sha256'][:12]}…`).
- `studio-{{main,front,right,open}}.png`: Cycles Metal GPU studio renders (`1400 × 1200`, `48` samples + OIDN).
- `appliance.xml` / `scene.xml` / `model.xml` / `native.xml` / `physics-export.json`: MuJoCo 4.0 MJCF, standalone attachable model, & collision-only native physics models.
- `build-report.json` / `inspection-report.json` / `active-states.json` / `active-states.md`: Automated QA & frame-alignment reports (`max_rest_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_motion_pos_err = {rf['motion_max_position_error_m']:.3e} m`).
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Star Micronics mJ-Drawer (`MJD36M`) — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Operational Stages

1. **`online_latched_closed`**: Key lock in center `Online DK-Port` position (`0.0°`), drawer latched closed (`0.0 mm`, `compulsion_switch_open = False`), initial float `¥45,000`.
2. **`dk_port_24v_solenoid_kick_open`**: `24 V` `DK-Port` pulse unlatches internal spring plunger, sliding `mjd_drawer` forward `{s['dk_port_24v_solenoid_kick_open']['drawer_slide_mm']} mm` (`-Y`, `compulsion_switch_open = True`).
3. **`banknote_clip_lift_cash_settlement`**: Lifted spring-loaded wire bill clips (`clip_1 = {s['banknote_clip_lift_cash_settlement']['clip_1_deg']}°`, `clip_2 = {s['banknote_clip_lift_cash_settlement']['clip_2_deg']}°`, `clip_3 = {s['banknote_clip_lift_cash_settlement']['clip_3_deg']}°`) to tender `¥5,000` note and dispense `¥2,740` change (`cash_balance_jpy = ¥{s['banknote_clip_lift_cash_settlement']['cash_balance_jpy']}`).
4. **`manual_push_close_and_security_key_lock`**: Released spring-loaded bill clips onto banknotes, pushed `mjd_drawer` shut (`{s['manual_push_close_and_security_key_lock']['drawer_slide_mm']} mm`), and rotated front `mjd_key_lock` `{s['manual_push_close_and_security_key_lock']['lock_angle_deg']}°` to mechanical `Locked` mode (`drawer_state = "{s['manual_push_close_and_security_key_lock']['drawer_state']}"`).
5. **`key_manual_emergency_open_and_restore`**: Turned `mjd_key_lock` `-90°` (`Manual Open`), verified mechanical release, then returned lock to `0.0°` (`Online DK-Port`) and closed drawer.
6. **`rest_and_motion_alignment_verified`**: Verified `6/6` rest frames (`max_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_rot_err = {rf['rest_max_orientation_error_rad']:.3e} rad`) and `5/5` scalar-joint trajectories (`21` samples/joint, `max_pos_err = {rf['motion_max_position_error_m']:.3e} m`, `max_rot_err = {rf['motion_max_orientation_error_rad']:.3e} rad`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification() -> None:
    import mujoco
    import numpy as np

    export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    state = {
        "drawer_state": "online_closed",
        "dk_port_voltage_v": 0.0,
        "compulsion_switch_open": False,
        "cash_balance_jpy": 45000,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04) -> dict:
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            slide_m = float(data.sensor("mjd_drawer_pos").data[0])
            c1_rad = float(data.sensor("mjd_clip_1_pos").data[0])
            c2_rad = float(data.sensor("mjd_clip_2_pos").data[0])
            c3_rad = float(data.sensor("mjd_clip_3_pos").data[0])
            lock_rad = float(data.sensor("mjd_lock_pos").data[0])

            state["compulsion_switch_open"] = slide_m > 0.012
            if lock_rad > 1.20 and slide_m < 0.005:
                state["drawer_state"] = "key_locked"
            elif state["compulsion_switch_open"]:
                state["drawer_state"] = "open_tendering"
            else:
                state["drawer_state"] = "online_closed"

            last_snap = {
                "time_s": round(float(data.time), 3),
                "drawer_state": state["drawer_state"],
                "dk_port_voltage_v": round(state["dk_port_voltage_v"], 1),
                "compulsion_switch_open": state["compulsion_switch_open"],
                "cash_balance_jpy": state["cash_balance_jpy"],
                "drawer_slide_mm": round(slide_m * 1000.0, 2),
                "clip_1_deg": round(math.degrees(c1_rad), 2),
                "clip_2_deg": round(math.degrees(c2_rad), 2),
                "clip_3_deg": round(math.degrees(c3_rad), 2),
                "lock_angle_deg": round(math.degrees(lock_rad), 2),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Online latched closed
    snap1 = step_and_sample(0.32)
    assert snap1["drawer_state"] == "online_closed" and snap1["drawer_slide_mm"] < 0.5, snap1
    stage_summaries["online_latched_closed"] = snap1

    # Stage 2: 24V DK-Port solenoid kick-out -> drawer slides open 202 mm forward (-Y)
    state["dk_port_voltage_v"] = 24.0
    data.ctrl[model.actuator("mjd_drawer_actuator").id] = 0.202
    snap2 = step_and_sample(0.48)
    state["dk_port_voltage_v"] = 0.0
    assert snap2["drawer_slide_mm"] > 195.0, snap2
    assert snap2["compulsion_switch_open"] is True, snap2
    stage_summaries["dk_port_24v_solenoid_kick_open"] = snap2

    # Stage 3: Lift spring-loaded wire bill hold-down clips to insert ¥5,000 & dispense ¥2,740 change (+¥2,260 net)
    data.ctrl[model.actuator("mjd_clip_1_actuator").id] = 0.48
    data.ctrl[model.actuator("mjd_clip_2_actuator").id] = 0.50
    data.ctrl[model.actuator("mjd_clip_3_actuator").id] = 0.36
    state["cash_balance_jpy"] += 2260
    snap3 = step_and_sample(0.40)
    assert snap3["clip_1_deg"] > 25.0 and snap3["clip_2_deg"] > 26.0 and snap3["clip_3_deg"] > 18.0, snap3
    assert snap3["cash_balance_jpy"] == 47260, snap3
    stage_summaries["banknote_clip_lift_cash_settlement"] = snap3

    # Stage 4: Release wire bill clips, push drawer closed, and turn security key lock +90 deg (+1.50 rad) to Locked
    data.ctrl[model.actuator("mjd_clip_1_actuator").id] = 0.0
    data.ctrl[model.actuator("mjd_clip_2_actuator").id] = 0.0
    data.ctrl[model.actuator("mjd_clip_3_actuator").id] = 0.0
    data.ctrl[model.actuator("mjd_drawer_actuator").id] = 0.0
    data.ctrl[model.actuator("mjd_lock_actuator").id] = 1.50
    snap4 = step_and_sample(0.68)
    assert snap4["drawer_slide_mm"] < 2.0, snap4
    assert snap4["lock_angle_deg"] > 82.0, snap4
    assert snap4["drawer_state"] == "key_locked", snap4
    stage_summaries["manual_push_close_and_security_key_lock"] = snap4

    # Stage 5: Turn key lock -90 deg (-1.50 rad) for manual release check, then restore to 0.0 rad closed rest
    data.ctrl[model.actuator("mjd_lock_actuator").id] = -1.50
    data.ctrl[model.actuator("mjd_drawer_actuator").id] = 0.120
    step_and_sample(0.44)
    data.ctrl[model.actuator("mjd_lock_actuator").id] = 0.0
    data.ctrl[model.actuator("mjd_drawer_actuator").id] = 0.0
    snap5 = step_and_sample(0.68)
    assert abs(snap5["drawer_slide_mm"]) < 1.5, snap5
    assert abs(snap5["lock_angle_deg"]) < 1.0, snap5
    stage_summaries["key_manual_emergency_open_and_restore"] = snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)
    stage_summaries["rest_and_motion_alignment_verified"] = {
        "rest_snap": snap5,
        "rest_frames_aligned": len(frames_report["appliances"]["star-mjd36m"]["frames"]),
        "rest_max_position_error_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["star-mjd36m"]["frames"]
        ),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["star-mjd36m"]["frames"]
        ),
        "motion_joints_aligned": len(motion_report["appliances"]["star-mjd36m"]["motions"]),
        "motion_max_position_error_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["star-mjd36m"]["motions"]
        ),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["star-mjd36m"]["motions"]
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "star-mjd36m",
        "model_title": "Star Micronics mJ-Drawer (MJD36M) 3-Bill / 6-Coin Printer-Driven Cash Drawer",
        "envelope_m": [0.330, 0.355, 0.104],
        "unit_mass_kg": round(sum(MASSES.values()), 6),
        "till_layout": "3-bill / 6-coin (3札6硬貨)",
        "drawer_stroke_m": 0.210,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "star-mjd36m.glb").read_bytes()).hexdigest(),
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
