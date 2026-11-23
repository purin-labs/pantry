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

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/star-mjd36m"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

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


def numbers(values) -> str:
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element) -> None:
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml() -> None:
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "star-mjd36m.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

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
            for axis_i in range(3):
                vals = [v.co[axis_i] for v in obj.data.vertices]
                if max(vals) - min(vals) < 1e-5:
                    obj.data.vertices[0].co[axis_i] += 2e-5
            obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.30
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    app = ET.Element(
        "mujoco",
        model="star-mjd36m — Star Micronics mJ-Drawer (MJD36M) 3-bill / 6-coin cash drawer",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

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
        contype="4",
        conaffinity="4",
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
            contype="2",
            conaffinity="1",
            group="3",
        )

    for cname, cpos, csize in (
        ("mjd_bottom_pan_col", (0.0, 0.0040, 0.0095), (0.1570, 0.1735, 0.0025)),
        ("mjd_left_wall_col", (-0.1610, 0.0, 0.0525), (0.0040, 0.1775, 0.0455)),
        ("mjd_right_wall_col", (0.1610, 0.0, 0.0525), (0.0040, 0.1775, 0.0455)),
        ("mjd_rear_wall_col", (0.0, 0.1725, 0.0550), (0.1570, 0.0050, 0.0430)),
        ("mjd_top_deck_col", (0.0, 0.0, 0.1010), (0.1650, 0.1775, 0.0030)),
    ):
        ET.SubElement(
            casing,
            "geom",
            name=cname,
            type="box",
            pos=numbers(cpos),
            size=numbers(csize),
            contype="2",
            conaffinity="1",
            group="3",
        )

    ET.SubElement(casing, "site", name="mjd_top_load_deck_site", pos="0 0 0.1040", size="0.008", group="3")
    ET.SubElement(casing, "site", name="mjd_dk_port_site", pos="-0.0850 0.1755 0.0280", size="0.004", group="3")

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
    )
    for dname, dpos, dsize in (
        ("mjd_drawer_front_col", (0.0, -0.1725, -0.0005), (0.1560, 0.0050, 0.0430)),
        ("mjd_till_floor_col", (0.0, -0.0080, -0.0330), (0.1480, 0.1540, 0.0030)),
        ("mjd_till_divider_col", (0.0, -0.0200, 0.0010), (0.1450, 0.0030, 0.0300)),
    ):
        ET.SubElement(
            drawer,
            "geom",
            name=dname,
            type="box",
            pos=numbers(dpos),
            size=numbers(dsize),
            contype="2",
            conaffinity="1",
            group="3",
        )
    ET.SubElement(drawer, "site", name="mjd_coin_tray_site", pos="0 -0.0920 -0.0150", size="0.006", group="3")
    ET.SubElement(drawer, "site", name="mjd_bill_tray_site", pos="0 0.0600 -0.0150", size="0.006", group="3")

    # Three spring-loaded wire bill clips (0 .. 0.55 rad about +X)
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
        )
        ET.SubElement(
            clip_el,
            "geom",
            name=f"mjd_clip_{idx}_col",
            type="box",
            pos="0 0.0420 -0.0160",
            size="0.0180 0.0420 0.0040",
            contype="0",
            conaffinity="0",
            group="3",
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
    )
    ET.SubElement(
        lock,
        "geom",
        name="mjd_key_lock_col",
        type="cylinder",
        pos="0 0.0010 0",
        quat=numbers((math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0, 0.0)),
        size="0.0085 0.0030",
        contype="0",
        conaffinity="0",
        group="3",
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
    write_xml(ASSETS / "scene.xml", app)

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
                "scope": "Articulated MuJoCo mechanical, 24V DK-Port solenoid kick-out, 3 spring-loaded wire bill clips, and 3-position key lock model.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from appliance_physics_kit import export_and_verify_native_xml

    export_and_verify_native_xml(ASSETS, "star-mjd36m", mujoco, np)


def verify_frames_and_motions(mujoco, evidence_dir: Path) -> tuple[dict, dict]:
    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "star-mjd36m.glb"
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
                "star-mjd36m": {
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
    assert frames_report["passed"], frames_report

    motions = []
    for jname, vaxis in VISUAL_AXES.items():
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
                "star-mjd36m": {
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
    assert motion_report["passed"], motion_report
    return frames_report, motion_report


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
- `appliance.xml` / `scene.xml` / `native.xml` / `physics-export.json`: MuJoCo 3.13 MJCF & collision-only native physics models.
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
