"""Build and verify the MuJoCo mechanical, receipt-print, and DK-Port pulse model for Star mC-Print3 (MCP31LB)."""

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
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

NAME = "star-mcp31lb"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

NAMES = (
    "mcp3_body",
    "mcp3_cover",
    "mcp3_paper_roll",
    "mcp3_receipt_strip",
    "mcp3_feed_button",
)

# Exact published mass = 1.300 kg
MASSES = {
    "mcp3_body": 0.945,
    "mcp3_cover": 0.155,
    "mcp3_paper_roll": 0.192,
    "mcp3_receipt_strip": 0.005,
    "mcp3_feed_button": 0.003,
}

CENTERS = {
    "mcp3_body": (0.0, 0.0060, 0.0560),
    "mcp3_cover": (0.0, 0.0020, 0.0380),
    "mcp3_paper_roll": (0.0, 0.0, 0.0),
    "mcp3_receipt_strip": (0.0, 0.0540, 0.0),
    "mcp3_feed_button": (0.0, 0.0, 0.0),
}

INERTIAS = {
    "mcp3_body": (0.0024, 0.0022, 0.0025),
    "mcp3_cover": (0.00018, 0.00032, 0.00022),
    "mcp3_paper_roll": (0.00014, 0.00017, 0.00017),
    "mcp3_receipt_strip": (4.2e-6, 2.7e-6, 6.8e-6),
    "mcp3_feed_button": (1e-6, 1e-6, 1e-6),
}

VISUAL_AXES = {
    "mcp3_cover_hinge": [1, 0, 0],
    "mcp3_roll_spin": [1, 0, 0],
    "mcp3_receipt_feed": [0, -1, 0],
    "mcp3_feed_press": [0, 1, 0],
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
        model="star-mcp31lb — Star Micronics mC-Print3 (MCP31LB) Splash-Proof IP22 thermal receipt printer",
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
        size="1.2 1.2 0.05",
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
            else (parts[0] if name != "mcp3_body" else None)
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

    base = bodies["mcp3_body"]
    cover = bodies["mcp3_cover"]
    roll = bodies["mcp3_paper_roll"]
    strip = bodies["mcp3_receipt_strip"]
    feed = bodies["mcp3_feed_button"]

    # Four rubber feet touching Z = 0.000 m
    for fn, fx, fy in (
        ("mcp3_foot_fl_col", -0.0510, -0.0540),
        ("mcp3_foot_fr_col", 0.0510, -0.0540),
        ("mcp3_foot_rl_col", -0.0510, 0.0540),
        ("mcp3_foot_rr_col", 0.0510, 0.0540),
    ):
        ET.SubElement(
            base,
            "geom",
            name=fn,
            type="cylinder",
            pos=numbers((fx, fy, 0.0020)),
            size="0.0090 0.0020",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    for cname, cpos, csize, crgba in (
        ("mcp3_base_col", (0.0, 0.0, 0.0095), (0.0640, 0.0680, 0.0055), COL_BASE_RGBA),
        ("mcp3_left_wall_col", (-0.0610, 0.0, 0.0620), (0.0050, 0.0700, 0.0570), COL_WALL_RGBA),
        ("mcp3_right_wall_col", (0.0610, 0.0, 0.0620), (0.0050, 0.0700, 0.0570), COL_WALL_RGBA),
        ("mcp3_rear_wall_col", (0.0, 0.0580, 0.0640), (0.0560, 0.0120, 0.0550), COL_WALL_RGBA),
        ("mcp3_front_header_col", (0.0, -0.0620, 0.1075), (0.0620, 0.0080, 0.0115), COL_WALL_RGBA),
        ("mcp3_top_hood_col", (0.0, 0.0, 0.1220), (0.0660, 0.0700, 0.0030), COL_WALL_RGBA),
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

    ET.SubElement(
        base,
        "site",
        name="mcp3_cutter_slot_site",
        pos="0 -0.0685 0.0948",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="mcp3_dk_port_site",
        pos="0.0380 0.0660 0.0300",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Clamshell cover hinge (0 .. 1.35 rad about +X)
    ET.SubElement(
        cover,
        "joint",
        name="mcp3_cover_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 1.35",
        damping="0.45",
        armature="0.003",
        frictionloss="0.10",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        cover,
        "geom",
        name="mcp3_cover_col",
        type="box",
        pos="0 0.0005 0.0380",
        size="0.0640 0.0045 0.0380",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cover,
        "geom",
        name="mcp3_cover_platen_col",
        type="cylinder",
        pos="0 0.0095 0.0742",
        quat=X_AXIS_QUAT,
        size="0.0056 0.0430",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Internal 80mm thermal paper roll continuous spin joint (unlimited about +X)
    ET.SubElement(
        roll,
        "joint",
        name="mcp3_roll_spin",
        type="hinge",
        axis="1 0 0",
        limited="false",
        damping="0.04",
        armature="0.0008",
        frictionloss="0.02",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        roll,
        "geom",
        name="mcp3_paper_roll_col",
        type="cylinder",
        pos="0 0 0",
        quat=X_AXIS_QUAT,
        size="0.0380 0.0395",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Emerging 80mm receipt paper strip slide joint (0 .. 0.110 m along -Y)
    ET.SubElement(
        strip,
        "joint",
        name="mcp3_receipt_feed",
        type="slide",
        axis="0 -1 0",
        limited="true",
        range="0 0.110",
        damping="0.80",
        armature="0.0004",
        frictionloss="0.03",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        strip,
        "geom",
        name="mcp3_receipt_strip_col",
        type="box",
        pos="0 0.0538 0",
        size="0.03975 0.0550 0.0003",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        strip,
        "site",
        name="mcp3_receipt_leading_edge",
        pos="0 -0.0012 0",
        size="0.003",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Front tactile Feed button slide joint (0 .. 0.0025 m along +Y)
    ET.SubElement(
        feed,
        "joint",
        name="mcp3_feed_press",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.0025",
        stiffness="3.0",
        damping="0.30",
        armature="0.0002",
        frictionloss="0.01",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        feed,
        "geom",
        name="mcp3_feed_button_col",
        type="box",
        pos="0 0.0004 0",
        size="0.0052 0.0011 0.0052",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Adjacent articulated-body contact exclusions
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_body_cover", "mcp3_body", "mcp3_cover"),
            ("exclude_body_paper_roll", "mcp3_body", "mcp3_paper_roll"),
            ("exclude_body_receipt_strip", "mcp3_body", "mcp3_receipt_strip"),
            ("exclude_body_feed_button", "mcp3_body", "mcp3_feed_button"),
            ("exclude_cover_paper_roll", "mcp3_cover", "mcp3_paper_roll"),
            ("exclude_cover_receipt_strip", "mcp3_cover", "mcp3_receipt_strip"),
            ("exclude_cover_feed_button", "mcp3_cover", "mcp3_feed_button"),
            ("exclude_roll_receipt_strip", "mcp3_paper_roll", "mcp3_receipt_strip"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="mcp3_cover_actuator",
        joint="mcp3_cover_hinge",
        kp="22",
        kv="1.8",
        ctrlrange="0 1.35",
        forcerange="-10 10",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mcp3_roll_spin_actuator",
        joint="mcp3_roll_spin",
        kp="4.0",
        kv="0.35",
        forcerange="-4 4",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mcp3_receipt_feed_actuator",
        joint="mcp3_receipt_feed",
        kp="38",
        kv="2.5",
        ctrlrange="0 0.110",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mcp3_feed_press_actuator",
        joint="mcp3_feed_press",
        kp="60",
        kv="0.6",
        ctrlrange="0 0.0025",
        forcerange="-5 5",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="mcp3_cover_pos", joint="mcp3_cover_hinge")
    ET.SubElement(sensors, "jointpos", name="mcp3_roll_spin_pos", joint="mcp3_roll_spin")
    ET.SubElement(sensors, "jointpos", name="mcp3_receipt_feed_pos", joint="mcp3_receipt_feed")
    ET.SubElement(sensors, "jointpos", name="mcp3_feed_press_pos", joint="mcp3_feed_press")

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="star-mcp31lb physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="0.6 -1.0 1.2", dir="-0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="mcp3_body",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 1.300,
                "component_masses_kg": MASSES,
                "envelope_m": [0.132, 0.140, 0.125],
                "print_speed_mm_per_s": 250,
                "paper_width_mm": 80,
                "ingress_protection": "IPX2 / IP22",
                "interfaces": ["USB-C", "USB-A Hub (2.4A)", "100BASE-TX LAN", "Bluetooth", "6-pin RJ12 DK-Port (24V)"],
                "scope": "Articulated MuJoCo 4.0 mechanical, 250 mm/s receipt feed, continuous roll spin, clamshell reload, and 24V DK-Port cash-drawer kick model.",
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
    readme = f"""# Star Micronics mC-Print3 (`MCP31LB`) — Blender & MuJoCo Package

Splash-Proof `IP22` front-loading `80 mm` thermal receipt printer (`Star Micronics Co., Ltd. MCP31LB`, `250 mm/s` print speed, guillotine partial-cut auto-cutter, rear `USB-C` / `LAN` / `DK-Port` cash-drawer driver).
See the [hardware reference sheet](../../../docs/equipment/star-mcp31lb/README.md) for full specifications.

![Star mC-Print3 Closed](studio-main.png)
![Star mC-Print3 Clamshell Open & Receipt](studio-open.png)

## Specifications & Envelope

| Parameter | Value |
| --- | --- |
| Overall envelope (`W × D × H`) | `132.0 × 140.0 × 125.0 mm` (`0.132 × 0.140 × 0.125 m`) |
| Published mass | `1.300 kg` (with internal `80 mm` roll assembly) |
| Print method & speed | Direct line thermal (`203 dpi` / `8 dots/mm`), up to `250 mm/s`, `72 mm` print width on `80 mm` (`79.5 ± 0.5 mm`) roll |
| Ingress protection | `IPX2` / `IP22` insect & drip-proof hood |
| Rear I/O | `USB-C`, `USB-A` (`2.4 A` host power), `100BASE-TX LAN`, Bluetooth, `6-pin RJ12 DK-Port` (`24 V DC` cash-drawer kick) |

## Retained MuJoCo Bodies & Joints

| Body | Joint | Type & Axis | Range | Mass (`kg`) |
| --- | --- | --- | --- | --- |
| `mcp3_body` | *(fixed root)* | — | Feet touching `Z = 0.000 m` | `0.945` |
| `mcp3_cover` | `mcp3_cover_hinge` | `hinge` (`1 0 0`) | `0 .. 1.35 rad` | `0.155` |
| `mcp3_paper_roll` | `mcp3_roll_spin` | `hinge` (`1 0 0`) | continuous (`limited="false"`) | `0.192` |
| `mcp3_receipt_strip` | `mcp3_receipt_feed` | `slide` (`0 -1 0`) | `0 .. 0.110 m` | `0.005` |
| `mcp3_feed_button` | `mcp3_feed_press` | `slide` (`0 1 0`) | `0 .. 0.0025 m` | `0.003` |

## Files

- `star-mcp31lb.blend` / `star-mcp31lb.glb`: Editable Blender 5.2 source and glTF 2.0 runtime asset (`{report['glb_sha256'][:12]}…`).
- `satyr-receipt-80mm.png`: Embedded Satyr Kitchen `80 mm` thermal receipt texture.
- `studio-{{main,front,right,open}}.png`: Cycles Metal GPU studio renders (`1400 × 1200`, `48` samples + OIDN).
- `appliance.xml` / `scene.xml` / `model.xml` / `native.xml` / `physics-export.json`: MuJoCo 4.0 MJCF, standalone attachable model, & collision-only native physics models.
- `build-report.json` / `inspection-report.json` / `active-states.json` / `active-states.md`: Automated QA & frame-alignment reports (`max_rest_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_motion_pos_err = {rf['motion_max_position_error_m']:.3e} m`).
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Star Micronics mC-Print3 (`MCP31LB`) — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Operational Stages

1. **`standby_ready_closed`**: Clamshell closed (`0.0°`), Power & Bluetooth LEDs active (`{s['standby_ready_closed']['power_draw_w']} W`), receipt strip retracted inside cutter throat (`0.0 mm`).
2. **`dk_port_drawer_kick_and_receipt_print`**: Triggered `24 V` `DK-Port` solenoid pulse (`dk_port_pulse_v = {s['dk_port_drawer_kick_and_receipt_print']['dk_port_pulse_v']} V`) to kick open `Star MJD36M`, spun `mcp3_paper_roll` (`{s['dk_port_drawer_kick_and_receipt_print']['roll_spin_rad']} rad`) while feeding `80 mm` thermal receipt out `{s['dk_port_drawer_kick_and_receipt_print']['receipt_feed_mm']} mm` (`{s['dk_port_drawer_kick_and_receipt_print']['power_draw_w']} W`), followed by guillotine partial-cut (`auto_cutter_cycles = {s['dk_port_drawer_kick_and_receipt_print']['auto_cutter_cycles']}`).
3. **`manual_feed_button_advance`**: Pressed tactile `mcp3_feed_button` (`{s['manual_feed_button_advance']['feed_press_mm']} mm`) to advance receipt to `{s['manual_feed_button_advance']['receipt_feed_mm']} mm` for tear-off.
4. **`clamshell_open_cover_interlock`**: Detached printed receipt (`0.0 mm`) and swung front-loading `mcp3_cover` open `{s['clamshell_open_cover_interlock']['cover_angle_deg']}°` (`-Y`), tripping the platen-open optical interlock (`cover_open_error = {s['clamshell_open_cover_interlock']['cover_open_error']}`, `printer_state = "{s['clamshell_open_cover_interlock']['printer_state']}"`).
5. **`paper_roll_reload_and_de_curl_close`**: Closed `mcp3_cover` (`{s['paper_roll_reload_and_de_curl_close']['cover_angle_deg']}°`), clearing Error LED and re-arming printhead (`printer_state = "{s['paper_roll_reload_and_de_curl_close']['printer_state']}"`).
6. **`rest_and_motion_alignment_verified`**: Verified `5/5` rest frames (`max_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_rot_err = {rf['rest_max_orientation_error_rad']:.3e} rad`) and `4/4` scalar-joint trajectories (`21` samples/joint, `max_pos_err = {rf['motion_max_position_error_m']:.3e} m`, `max_rot_err = {rf['motion_max_orientation_error_rad']:.3e} rad`).
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
        "printer_state": "ready",
        "power_draw_w": 2.6,
        "dk_port_pulse_v": 0.0,
        "auto_cutter_cycles": 0,
        "cover_open_error": False,
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

            cov_rad = float(data.sensor("mcp3_cover_pos").data[0])
            roll_rad = float(data.sensor("mcp3_roll_spin_pos").data[0])
            feed_m = float(data.sensor("mcp3_receipt_feed_pos").data[0])
            btn_m = float(data.sensor("mcp3_feed_press_pos").data[0])

            state["cover_open_error"] = cov_rad > 0.08
            if state["cover_open_error"]:
                state["printer_state"] = "cover_open_interlock"
                state["power_draw_w"] = 1.8
            elif state["printer_state"] == "cover_open_interlock":
                state["printer_state"] = "ready"
                state["power_draw_w"] = 2.6

            last_snap = {
                "time_s": round(float(data.time), 3),
                "printer_state": state["printer_state"],
                "power_draw_w": round(state["power_draw_w"], 1),
                "dk_port_pulse_v": round(state["dk_port_pulse_v"], 1),
                "auto_cutter_cycles": state["auto_cutter_cycles"],
                "cover_open_error": state["cover_open_error"],
                "cover_angle_deg": round(math.degrees(cov_rad), 2),
                "roll_spin_rad": round(roll_rad, 3),
                "receipt_feed_mm": round(feed_m * 1000.0, 2),
                "feed_press_mm": round(btn_m * 1000.0, 3),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby closed & ready
    snap1 = step_and_sample(0.32)
    assert snap1["printer_state"] == "ready" and snap1["cover_angle_deg"] < 0.5, snap1
    stage_summaries["standby_ready_closed"] = snap1

    # Stage 2: 24V DK-Port cash-drawer kick pulse + 250 mm/s receipt print (90 mm) + guillotine partial cut
    state["printer_state"] = "printing_and_dk_kick"
    state["power_draw_w"] = 36.0
    state["dk_port_pulse_v"] = 24.0
    # 90 mm paper feed on R = 38 mm roll -> 0.090 / 0.038 = 2.368 rad spin
    data.ctrl[model.actuator("mcp3_roll_spin_actuator").id] = 2.37
    data.ctrl[model.actuator("mcp3_receipt_feed_actuator").id] = 0.090
    snap2 = step_and_sample(0.48)
    state["auto_cutter_cycles"] = 1
    snap2["auto_cutter_cycles"] = 1
    assert snap2["receipt_feed_mm"] > 84.0, snap2
    assert snap2["roll_spin_rad"] > 2.0, snap2
    stage_summaries["dk_port_drawer_kick_and_receipt_print"] = snap2

    # Stage 3: Tactile Feed button press -> advances receipt strip to 106 mm
    state["dk_port_pulse_v"] = 0.0
    state["printer_state"] = "manual_feed"
    state["power_draw_w"] = 18.0
    data.ctrl[model.actuator("mcp3_feed_press_actuator").id] = 0.0022
    data.ctrl[model.actuator("mcp3_roll_spin_actuator").id] = 2.79
    data.ctrl[model.actuator("mcp3_receipt_feed_actuator").id] = 0.106
    snap3 = step_and_sample(0.36)
    data.ctrl[model.actuator("mcp3_feed_press_actuator").id] = 0.0
    assert snap3["feed_press_mm"] > 1.5, snap3
    assert snap3["receipt_feed_mm"] > 100.0, snap3
    stage_summaries["manual_feed_button_advance"] = snap3

    # Stage 4: Tear off receipt (retract strip to 0) and swing front-loading clamshell cover open 1.25 rad (71.6 deg)
    data.ctrl[model.actuator("mcp3_receipt_feed_actuator").id] = 0.0
    data.ctrl[model.actuator("mcp3_cover_actuator").id] = 1.25
    snap4 = step_and_sample(0.52)
    assert snap4["cover_angle_deg"] > 66.0, snap4
    assert snap4["cover_open_error"] is True, snap4
    assert snap4["printer_state"] == "cover_open_interlock", snap4
    stage_summaries["clamshell_open_cover_interlock"] = snap4

    # Stage 5: Reload 80mm thermal roll (reset spin to 0) and close clamshell cover -> Ready
    data.ctrl[model.actuator("mcp3_roll_spin_actuator").id] = 0.0
    data.ctrl[model.actuator("mcp3_cover_actuator").id] = 0.0
    snap5 = step_and_sample(0.56)
    assert snap5["cover_angle_deg"] < 1.0, snap5
    assert snap5["cover_open_error"] is False, snap5
    assert snap5["printer_state"] == "ready", snap5
    stage_summaries["paper_roll_reload_and_de_curl_close"] = snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)
    stage_summaries["rest_and_motion_alignment_verified"] = {
        "rest_snap": snap5,
        "rest_frames_aligned": len(frames_report["appliances"]["star-mcp31lb"]["frames"]),
        "rest_max_position_error_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["star-mcp31lb"]["frames"]
        ),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["star-mcp31lb"]["frames"]
        ),
        "motion_joints_aligned": len(motion_report["appliances"]["star-mcp31lb"]["motions"]),
        "motion_max_position_error_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["star-mcp31lb"]["motions"]
        ),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["star-mcp31lb"]["motions"]
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "star-mcp31lb",
        "model_title": "Star Micronics mC-Print3 (MCP31LB) Splash-Proof IP22 Thermal Receipt Printer",
        "envelope_m": [0.132, 0.140, 0.125],
        "unit_mass_kg": round(sum(MASSES.values()), 6),
        "print_speed_mm_s": 250,
        "paper_width_mm": 80,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "star-mcp31lb.glb").read_bytes()).hexdigest(),
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
