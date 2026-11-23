"""Build and verify the MuJoCo mechanical and contactless POS model for Square Register (2nd Gen, SPS1-01)."""

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

NAME = "square-register-2g"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME

NAMES = (
    "sqreg_base",
    "sqreg_operator_screen",
    "sqreg_customer_display",
    "sqreg_power_button",
    "sqreg_payment_card",
)

# Operator terminal = 1.120 + 0.686 + 0.004 = 1.810 kg
# Customer payment display = 0.550 kg
# Combined POS mass = 2.360 kg (+ 0.005 kg contactless EMV card = 2.365 kg scene total)
MASSES = {
    "sqreg_base": 1.120,
    "sqreg_operator_screen": 0.686,
    "sqreg_customer_display": 0.550,
    "sqreg_power_button": 0.004,
    "sqreg_payment_card": 0.005,
}

CENTERS = {
    "sqreg_base": (0.0, -0.0840, 0.0360),
    "sqreg_operator_screen": (0.0, 0.0100, 0.0150),
    "sqreg_customer_display": (0.0, -0.0060, -0.0040),
    "sqreg_power_button": (0.0, 0.0, 0.0),
    "sqreg_payment_card": (0.0, 0.0, 0.0),
}

INERTIAS = {
    "sqreg_base": (0.0038, 0.0092, 0.0114),
    "sqreg_operator_screen": (0.0024, 0.0058, 0.0062),
    "sqreg_customer_display": (0.0014, 0.0014, 0.0027),
    "sqreg_power_button": (1e-6, 1e-6, 1e-6),
    "sqreg_payment_card": (3.06e-6, 1.22e-6, 4.25e-6),
}

VISUAL_AXES = {
    "sqreg_screen_tilt": [1, 0, 0],
    "sqreg_customer_undock": [0, 1, 0],
    "sqreg_power_press": [-1, 0, 0],
}

CARD_REST_POS = (0.1240, 0.0700, 0.0044)


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
        model="square-register-2g — Square Register (2nd Generation, SPS1-01) dual-display POS",
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
        if name == "sqreg_payment_card":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "sqreg_base" else None)
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

    base = bodies["sqreg_base"]
    screen = bodies["sqreg_operator_screen"]
    cust = bodies["sqreg_customer_display"]
    pwr = bodies["sqreg_power_button"]
    card = bodies["sqreg_payment_card"]

    # Base collision boxes (174 mm rounded-corner graphite base & curved neck) + counter NFC card rest pad at Z_top = 0.0040 m
    for cname, cpos, csize in (
        ("sqreg_base_ring_col", (0.0, -0.0808, 0.0018), (0.0780, 0.0490, 0.0018)),
        ("sqreg_base_deck_col", (0.0, -0.0808, 0.0103), (0.0870, 0.0572, 0.0067)),
        ("sqreg_pedestal_col", (0.0, -0.0540, 0.0520), (0.0780, 0.0260, 0.0400)),
        ("sqreg_card_pad_col", (0.1240, 0.0700, 0.0020), (0.0305, 0.0465, 0.0020)),
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
            rgba=COL_BASE_RGBA,
        )
    neck_ang = math.radians(28.0)
    ET.SubElement(
        base,
        "geom",
        name="sqreg_neck_upper_col",
        type="box",
        pos="0 -0.0780 0.1180",
        quat=numbers((math.cos(0.5 * neck_ang), math.sin(0.5 * neck_ang), 0.0, 0.0)),
        size="0.0680 0.0180 0.0420",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="sqreg_hinge_bar_col",
        type="cylinder",
        pos="0 -0.0885 0.1500",
        quat=X_AXIS_QUAT,
        size="0.0065 0.0580",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )

    ET.SubElement(
        base,
        "site",
        name="sqreg_usb_hub_site",
        pos="0 -0.0320 0.0074",
        size="0.005",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="sqreg_card_pad_touch_site",
        type="box",
        pos="0.1240 0.0700 0.0044",
        size="0.0300 0.0460 0.0012",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Operator 13.2 in screen tilt joint (-0.20 .. 0.35 rad about +X)
    ET.SubElement(
        screen,
        "joint",
        name="sqreg_screen_tilt",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.20 0.35",
        damping="1.8",
        armature="0.008",
        frictionloss="0.25",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    tilt_rad = math.radians(34.4)
    s_mid = 0.01564
    ET.SubElement(
        screen,
        "geom",
        name="sqreg_operator_screen_col",
        type="box",
        pos=numbers((0.0, s_mid * math.sin(tilt_rad), s_mid * math.cos(tilt_rad))),
        quat=numbers((math.cos(-0.5 * tilt_rad), math.sin(-0.5 * tilt_rad), 0.0, 0.0)),
        size="0.15875 0.0080 0.1075",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        screen,
        "site",
        name="sqreg_operator_ui_site",
        pos="0 0.0060 0.0180",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Customer 7.0 in payment display slide/undock joint (0 .. 0.180 m along +Y)
    ET.SubElement(
        cust,
        "joint",
        name="sqreg_customer_undock",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.180",
        damping="3.5",
        armature="0.006",
        frictionloss="0.04",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        cust,
        "geom",
        name="sqreg_customer_base_col",
        type="box",
        pos="0 0 -0.0078",
        size="0.0870 0.0870 0.0138",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cust,
        "geom",
        name="sqreg_customer_nfc_deck_col",
        type="box",
        pos="0 0.0160 0.0080",
        size="0.0820 0.0680 0.0060",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cust,
        "geom",
        name="sqreg_customer_magstripe_ridge_col",
        type="box",
        pos="0 -0.0675 0.0140",
        size="0.0850 0.0195 0.0080",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )
    ET.SubElement(
        cust,
        "site",
        name="sqreg_nfc_tap_site",
        pos="0 0.0180 0.0144",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        cust,
        "site",
        name="sqreg_nfc_touch_site",
        type="box",
        pos="0 0.0180 0.0148",
        size="0.0650 0.0550 0.0035",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        cust,
        "site",
        name="sqreg_emv_slot_site",
        pos="0 0.0860 -0.0130",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        cust,
        "site",
        name="sqreg_magstripe_site",
        pos="0 -0.0735 0.0160",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Side power/wake tactile button slide joint (0 .. 0.002 m along -X)
    ET.SubElement(
        pwr,
        "joint",
        name="sqreg_power_press",
        type="slide",
        axis="-1 0 0",
        limited="true",
        range="0 0.002",
        stiffness="4.0",
        damping="0.35",
        armature="0.0002",
        frictionloss="0.01",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        pwr,
        "geom",
        name="sqreg_power_button_col",
        type="box",
        pos="0.0005 0 0",
        size="0.0015 0.0090 0.0028",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # 6-DOF contactless EMV payment card resting stably at CARD_REST_POS (Z = 0.0044 m)
    ET.SubElement(card, "freejoint", name="sqreg_card_free")
    ET.SubElement(
        card,
        "geom",
        name="sqreg_card_col",
        type="box",
        pos="0 0 0",
        size="0.0270 0.0428 0.0004",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        card,
        "site",
        name="vessel_socket",
        pos="0 0.0100 0",
        size="0.004",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # Adjacent articulated-body contact exclusions (sqreg_payment_card stays UN-excluded for pad & NFC contact)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_base_operator_screen", "sqreg_base", "sqreg_operator_screen"),
            ("exclude_base_customer_display", "sqreg_base", "sqreg_customer_display"),
            ("exclude_base_power_button", "sqreg_base", "sqreg_power_button"),
            ("exclude_screen_customer_display", "sqreg_operator_screen", "sqreg_customer_display"),
            ("exclude_screen_power_button", "sqreg_operator_screen", "sqreg_power_button"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="sqreg_screen_tilt_actuator",
        joint="sqreg_screen_tilt",
        kp="48",
        kv="4.2",
        ctrlrange="-0.20 0.35",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="sqreg_customer_undock_actuator",
        joint="sqreg_customer_undock",
        kp="55",
        kv="6.0",
        ctrlrange="0 0.180",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="sqreg_power_press_actuator",
        joint="sqreg_power_press",
        kp="60",
        kv="0.8",
        ctrlrange="0 0.002",
        forcerange="-6 6",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="sqreg_screen_tilt_pos", joint="sqreg_screen_tilt")
    ET.SubElement(sensors, "jointpos", name="sqreg_customer_undock_pos", joint="sqreg_customer_undock")
    ET.SubElement(sensors, "jointpos", name="sqreg_power_press_pos", joint="sqreg_power_press")
    ET.SubElement(sensors, "touch", name="sqreg_card_pad_touch", site="sqreg_card_pad_touch_site")
    ET.SubElement(sensors, "touch", name="sqreg_nfc_touch", site="sqreg_nfc_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="sqreg_card_to_nfc_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="sqreg_nfc_tap_site",
    )

    write_xml(ASSETS / "appliance.xml", app)

    scene = ET.Element("mujoco", model="square-register-2g physics lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1400", offheight="1200")
    ET.SubElement(visual, "headlight", ambient="0.42 0.42 0.44")
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="0.8 -1.2 1.4", dir="-0.35 0.6 -0.8")
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="sqreg_base",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("sqreg_card_to_nfc_sense",),
        accessories=(("payment_card_model.xml", "sqreg_payment_card", card),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "operator_terminal_mass_kg": 1.810,
                "customer_display_mass_kg": 0.550,
                "published_pos_mass_kg": 2.360,
                "payment_card_mass_kg": 0.005,
                "component_masses_kg": MASSES,
                "main_terminal_envelope_m": [0.3175, 0.1270, 0.2540],
                "customer_display_envelope_m": [0.1740, 0.1740, 0.0440],
                "payment_card_dimensions_m": [0.0856, 0.0540, 0.0008],
                "interfaces": ["5-port USB hub", "Ethernet", "Wi-Fi", "NFC Contactless", "EMV IC Chip", "Magstripe"],
                "scope": "Articulated MuJoCo 4.0 mechanical, dual-display tilt/undock, power button, and 6-DOF contactless NFC card tap model.",
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
    readme = f"""# Square Register (2nd Generation, `SPS1-01`) — Blender & MuJoCo Package

Dual-display commercial POS terminal (`Block, Inc. / Square SPS1-01`) operating **Satyr Kitchen / CafeOS** order intake and contactless customer payment.
See the [hardware reference sheet](../../../docs/equipment/square-register-2g/README.md) for full specifications.

![Square Register 2G Main](studio-main.png)
![Square Register 2G Active NFC Tap](studio-active.png)

## Specifications & Envelope

| Parameter | Value |
| --- | --- |
| Main operator terminal (`W × D × H`) | `317.5 × 127.0 × 254.0 mm` (`0.3175 × 0.1270 × 0.2540 m`), `1.810 kg` |
| Customer payment display (`W × D × H`) | `174.0 × 174.0 × 44.0 mm` (`0.1740 × 0.1740 × 0.0440 m`), `0.550 kg` |
| Combined docked POS (`W × D × H`) | `317.5 × 301.0 × 254.0 mm` (`2.360 kg` POS + `0.005 kg` EMV/NFC card) |
| Displays | `13.2 in` operator touchscreen (`-Y` cashier side) + `7.0 in` customer display (`+Y` customer side) |
| Payment interfaces | Contactless NFC tap zone (`ISO/IEC 14443`), EMV IC chip slot (`ISO/IEC 7816`), 3-track magstripe |
| Peripheral connectivity | Integrated 5-port USB hub + Ethernet + Bosstab customer-display undock (`0 .. 180 mm`) |

## Retained MuJoCo Bodies & Joints

| Body | Joint | Type & Axis | Range | Mass (`kg`) |
| --- | --- | --- | --- | --- |
| `sqreg_base` | *(fixed root)* | — | Touching `Z = 0.000 m` | `1.120` |
| `sqreg_operator_screen` | `sqreg_screen_tilt` | `hinge` (`1 0 0`) | `-0.20 .. 0.35 rad` | `0.686` |
| `sqreg_customer_display` | `sqreg_customer_undock` | `slide` (`0 1 0`) | `0 .. 0.180 m` | `0.550` |
| `sqreg_power_button` | `sqreg_power_press` | `slide` (`-1 0 0`) | `0 .. 0.002 m` | `0.004` |
| `sqreg_payment_card` | `sqreg_card_free` | `freejoint` (6-DOF) | Free (`85.6 × 54.0 × 0.8 mm`) | `0.005` |

## Files

- `square-register-2g.blend` / `square-register-2g.glb`: Editable Blender 5.2 source and glTF 2.0 runtime asset (`{report['glb_sha256'][:12]}…`).
- `cafeos-order-ui.png` / `customer-tap-ui.png`: Embedded Satyr Kitchen / CafeOS POS & NFC tap UI textures.
- `studio-{{main,front,right,active}}.png`: Cycles Metal GPU studio renders (`1400 × 1200`, `48` samples + OIDN).
- `appliance.xml` / `scene.xml` / `model.xml` / `payment_card_model.xml` / `native.xml` / `physics-export.json`: MuJoCo 4.0 MJCF, standalone attachable models, & collision-only native physics models.
- `build-report.json` / `inspection-report.json` / `active-states.json` / `active-states.md`: Automated QA & frame-alignment reports (`max_rest_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_motion_pos_err = {rf['motion_max_position_error_m']:.3e} m`).
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Square Register (2nd Generation, `SPS1-01`) — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Operational Stages

1. **`sleep_docked_card_on_pad`**: Terminal in standby (`{s['sleep_docked_card_on_pad']['power_draw_w']} W`) with customer display docked (`0.0 mm`) and 6-DOF EMV/NFC card resting stably under gravity on `sqreg_card_pad` (`card_z_m = {s['sleep_docked_card_on_pad']['card_z_m']} m`, `pad_touch_n = {s['sleep_docked_card_on_pad']['card_pad_touch_n']} N`).
2. **`power_wake_and_cashier_tilt`**: Side power button pressed (`{s['power_wake_and_cashier_tilt']['power_press_mm']} mm`), waking the `13.2 in` CafeOS terminal (`{s['power_wake_and_cashier_tilt']['power_draw_w']} W`, `Order #204: ¥2,260`) and tilting `sqreg_screen_tilt` to `{s['power_wake_and_cashier_tilt']['screen_tilt_deg']}°`.
3. **`customer_display_undock_counter_mode`**: Customer `7.0 in` display slid rearward `{s['customer_display_undock_counter_mode']['customer_undock_mm']} mm` (`+Y`) for ergonomic customer-facing payment (`payment_state = "{s['customer_display_undock_counter_mode']['payment_state']}"`).
4. **`contactless_nfc_tap_payment`**: 6-DOF `sqreg_payment_card` placed onto the undocked customer NFC tap deck (`nfc_touch_n = {s['contactless_nfc_tap_payment']['nfc_touch_n']} N`, `card_to_nfc_dist_m = {s['contactless_nfc_tap_payment']['card_to_nfc_dist_m']} m`), completing contactless Visa authorization (`payment_state = "{s['contactless_nfc_tap_payment']['payment_state']}"`, `receipt_queued = {s['contactless_nfc_tap_payment']['receipt_queued']}`).
5. **`cashier_review_tilt_forward`**: Payment card returned to free-resting counter pad (`card_z_m = {s['cashier_review_tilt_forward']['card_z_m']} m`) while `sqreg_screen_tilt` adjusts forward to `{s['cashier_review_tilt_forward']['screen_tilt_deg']}°`.
6. **`rest_and_motion_alignment_verified`**: Restored all joints to rest; verified `5/5` rest frames (`max_pos_err = {rf['rest_max_position_error_m']:.3e} m`, `max_rot_err = {rf['rest_max_orientation_error_rad']:.3e} rad`) and `3/3` scalar-joint trajectories (`21` samples/joint, `max_pos_err = {rf['motion_max_position_error_m']:.3e} m`, `max_rot_err = {rf['motion_max_orientation_error_rad']:.3e} rad`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification() -> None:
    import mujoco
    import numpy as np

    export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    card_qpos_adr = model.joint("sqreg_card_free").qposadr[0]
    card_qvel_adr = model.joint("sqreg_card_free").dofadr[0]
    card_bid = model.body("sqreg_payment_card").id

    state = {
        "system_awake": False,
        "power_draw_w": 3.2,
        "order_total_jpy": 2260,
        "payment_state": "idle",
        "receipt_queued": False,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, pin_card_pose=None) -> dict:
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                if pin_card_pose is not None:
                    pos, quat = pin_card_pose
                    data.qpos[card_qpos_adr : card_qpos_adr + 3] = pos
                    data.qpos[card_qpos_adr + 3 : card_qpos_adr + 7] = quat
                    data.qvel[card_qvel_adr : card_qvel_adr + 6] = 0.0
                mujoco.mj_step(model, data)

            tilt_rad = float(data.sensor("sqreg_screen_tilt_pos").data[0])
            undock_m = float(data.sensor("sqreg_customer_undock_pos").data[0])
            pwr_m = float(data.sensor("sqreg_power_press_pos").data[0])
            pad_touch = float(data.sensor("sqreg_card_pad_touch").data[0])
            nfc_touch = float(data.sensor("sqreg_nfc_touch").data[0])
            rel_nfc = data.sensor("sqreg_card_to_nfc_sense").data
            nfc_dist = float(math.sqrt(rel_nfc[0] ** 2 + rel_nfc[1] ** 2 + rel_nfc[2] ** 2))
            card_z = float(data.xpos[card_bid][2])

            if pwr_m >= 0.0012 and not state["system_awake"]:
                state["system_awake"] = True
                state["power_draw_w"] = 18.5
                state["payment_state"] = "order_entry"

            if state["payment_state"] == "awaiting_tap" and nfc_dist <= 0.035 and nfc_touch > 0.01:
                state["payment_state"] = "approved"
                state["power_draw_w"] = 22.4
                state["receipt_queued"] = True

            last_snap = {
                "time_s": round(float(data.time), 3),
                "system_awake": state["system_awake"],
                "power_draw_w": round(state["power_draw_w"], 1),
                "order_total_jpy": state["order_total_jpy"],
                "payment_state": state["payment_state"],
                "receipt_queued": state["receipt_queued"],
                "screen_tilt_deg": round(math.degrees(tilt_rad), 2),
                "customer_undock_mm": round(undock_m * 1000.0, 2),
                "power_press_mm": round(pwr_m * 1000.0, 3),
                "card_z_m": round(card_z, 5),
                "card_pad_touch_n": round(pad_touch, 4),
                "nfc_touch_n": round(nfc_touch, 4),
                "card_to_nfc_dist_m": round(nfc_dist, 4),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Free-resting card stability check (NO pinning!) on sqreg_card_pad at Z = 0.0044 m
    snap1 = step_and_sample(0.36)
    assert abs(snap1["card_z_m"] - 0.0044) < 0.0005, snap1
    assert snap1["card_pad_touch_n"] > 0.03, snap1
    assert snap1["system_awake"] is False, snap1
    stage_summaries["sleep_docked_card_on_pad"] = snap1

    # Stage 2: Press side power button to wake CafeOS POS, tilt 13.2 in operator screen +0.22 rad
    data.ctrl[model.actuator("sqreg_power_press_actuator").id] = 0.0018
    data.ctrl[model.actuator("sqreg_screen_tilt_actuator").id] = 0.22
    snap2 = step_and_sample(0.36)
    data.ctrl[model.actuator("sqreg_power_press_actuator").id] = 0.0
    assert snap2["system_awake"] is True, snap2
    assert snap2["power_press_mm"] > 1.2, snap2
    assert abs(snap2["screen_tilt_deg"] - math.degrees(0.22)) < 1.5, snap2
    stage_summaries["power_wake_and_cashier_tilt"] = snap2

    # Stage 3: Slide/undock 7.0 in customer display +140 mm rearward (+Y) for counter payment
    state["payment_state"] = "awaiting_tap"
    data.ctrl[model.actuator("sqreg_customer_undock_actuator").id] = 0.140
    snap3 = step_and_sample(0.48)
    assert snap3["customer_undock_mm"] > 132.0, snap3
    assert snap3["payment_state"] == "awaiting_tap", snap3
    stage_summaries["customer_display_undock_counter_mode"] = snap3

    # Stage 4: Place 6-DOF contactless EMV card onto undocked customer NFC tap deck (free-resting under gravity!)
    nfc_site_world = data.site("sqreg_nfc_tap_site").xpos.copy()
    data.qpos[card_qpos_adr : card_qpos_adr + 3] = (
        float(nfc_site_world[0]),
        float(nfc_site_world[1]) - 0.010,
        float(nfc_site_world[2]) + 0.0006,
    )
    data.qpos[card_qpos_adr + 3 : card_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[card_qvel_adr : card_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    snap4 = step_and_sample(0.40)
    assert snap4["nfc_touch_n"] > 0.03, snap4
    assert snap4["card_to_nfc_dist_m"] < 0.025, snap4
    assert snap4["payment_state"] == "approved", snap4
    assert snap4["receipt_queued"] is True, snap4
    stage_summaries["contactless_nfc_tap_payment"] = snap4

    # Stage 5: Return payment card to counter NFC card holder pad (free-resting) & tilt screen -0.15 rad
    data.qpos[card_qpos_adr : card_qpos_adr + 3] = CARD_REST_POS
    data.qpos[card_qpos_adr + 3 : card_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[card_qvel_adr : card_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    data.ctrl[model.actuator("sqreg_screen_tilt_actuator").id] = -0.15
    snap5 = step_and_sample(0.44)
    assert abs(snap5["card_z_m"] - 0.0044) < 0.0005, snap5
    assert snap5["screen_tilt_deg"] < -7.0, snap5
    stage_summaries["cashier_review_tilt_forward"] = snap5

    # Stage 6: Redock customer display & restore screen tilt to 0.0 rad
    data.ctrl[model.actuator("sqreg_customer_undock_actuator").id] = 0.0
    data.ctrl[model.actuator("sqreg_screen_tilt_actuator").id] = 0.0
    snap6 = step_and_sample(0.52)
    assert abs(snap6["customer_undock_mm"]) < 1.5, snap6
    assert abs(snap6["screen_tilt_deg"]) < 0.8, snap6

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)
    stage_summaries["rest_and_motion_alignment_verified"] = {
        "rest_snap": snap6,
        "rest_frames_aligned": len(frames_report["appliances"]["square-register-2g"]["frames"]),
        "rest_max_position_error_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["square-register-2g"]["frames"]
        ),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["square-register-2g"]["frames"]
        ),
        "motion_joints_aligned": len(motion_report["appliances"]["square-register-2g"]["motions"]),
        "motion_max_position_error_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["square-register-2g"]["motions"]
        ),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["square-register-2g"]["motions"]
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "square-register-2g",
        "model_title": "Square Register (2nd Generation, SPS1-01) Dual-Display POS",
        "main_terminal_envelope_m": [0.3175, 0.1270, 0.2540],
        "customer_display_envelope_m": [0.1740, 0.1740, 0.0440],
        "combined_docked_envelope_m": [0.3175, 0.3010, 0.2540],
        "operator_terminal_mass_kg": 1.810,
        "customer_display_mass_kg": 0.550,
        "pos_mass_kg": 2.360,
        "payment_card_mass_kg": 0.005,
        "total_scene_mass_kg": round(sum(MASSES.values()), 6),
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "square-register-2g.glb").read_bytes()).hexdigest(),
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
