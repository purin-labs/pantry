"""Export and verify MuJoCo 4.0 MJCF + native models for AICOH MS-30 and Hobart HL200 planetary mixers."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from itertools import pairwise
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
    X_AXIS_QUAT,
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    write_xml,
    z_rot_quat,
)

ASSETS = ROOT / "assets/bakery-mujoco"


def _quat_mul(
    q1: tuple[float, float, float, float],
    q2: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return (
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    )


def _add_geom(
    body: ET.Element,
    name: str,
    gtype: str,
    *,
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    size: str | tuple[float, ...],
    fromto: tuple[float, float, float, float, float, float] | None = None,
    rgba: str = COL_BASE_RGBA,
    friction: str | None = None,
    mass: str | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": gtype,
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if fromto is not None:
        attrib["fromto"] = numbers(fromto)
    elif pos is not None:
        attrib["pos"] = numbers(pos)
    if quat is not None:
        attrib["quat"] = quat
    attrib["size"] = size if isinstance(size, str) else numbers(size)
    if friction is not None:
        attrib["friction"] = friction
    if mass is not None:
        attrib["mass"] = mass
    return ET.SubElement(body, "geom", **attrib)


def _add_conical_guard_staves(
    body: ET.Element,
    prefix: str,
    *,
    center_xy: tuple[float, float],
    start_deg: float,
    stop_deg: float,
    n_staves: int,
    r_bot: float,
    z_bot: float,
    r_top: float,
    z_top: float,
    radial_half: float,
    rgba: str,
) -> None:
    """Cover a curved conical wire-guard arc with thin tilted staves, preserving its open interior."""
    tilt = math.atan2(r_top - r_bot, z_top - z_bot)
    q_tilt = (math.cos(tilt / 2.0), 0.0, math.sin(tilt / 2.0), 0.0)
    r_mid = 0.5 * (r_bot + r_top)
    z_mid = 0.5 * (z_bot + z_top)
    half_h = 0.5 * math.hypot(r_top - r_bot, z_top - z_bot)
    arc_step = math.radians((stop_deg - start_deg) / n_staves)
    half_tan = r_mid * math.sin(0.5 * arc_step) * 1.12
    cx, cy = center_xy
    for idx in range(n_staves):
        ang = math.radians(start_deg + (stop_deg - start_deg) * (idx + 0.5) / n_staves)
        q_stave = _quat_mul(z_rot_quat(ang), q_tilt)
        _add_geom(
            body,
            f"{prefix}_{idx:02d}_col",
            "box",
            pos=(cx + r_mid * math.cos(ang), cy + r_mid * math.sin(ang), z_mid),
            quat=numbers(q_stave),
            size=(radial_half, half_tan, half_h),
            rgba=rgba,
        )


def _add_hobart_colliders(
    mixer: ET.Element,
    lift: ET.Element,
    guard: ET.Element,
    orbit: ET.Element,
    tool: ET.Element,
) -> None:
    bowl_y = -0.194

    # Four elastomer foot pads touching exact Z = 0.0000 m up to Z = 0.0100 m
    for lbl, fx, fy in (
        ("fl", -0.150, -0.199),
        ("fr", 0.150, -0.199),
        ("rl", -0.150, 0.199),
        ("rr", 0.150, 0.199),
    ):
        _add_geom(
            mixer,
            f"hl_foot_{lbl}_col",
            "box",
            pos=(fx, fy, 0.005),
            size=(0.056, 0.027, 0.005),
            friction="0.85 0.015 0.003",
            rgba=COL_BASE_RGBA,
        )

    # Left & right arched cast pedestal legs (kept >= 0.010 m above floor; open arch preserved)
    arch_q = numbers((math.cos(0.26 / 2.0), math.sin(0.26 / 2.0), 0.0, 0.0))
    for side, sx in (("l", -0.150), ("r", 0.150)):
        _add_geom(
            mixer,
            f"hl_leg_{side}_front_col",
            "box",
            pos=(sx, -0.194, 0.050),
            size=(0.059, 0.0335, 0.040),
            rgba=COL_BASE_RGBA,
        )
        _add_geom(
            mixer,
            f"hl_leg_{side}_midfront_col",
            "box",
            pos=(sx, -0.075, 0.092),
            quat=arch_q,
            size=(0.056, 0.102, 0.033),
            rgba=COL_BASE_RGBA,
        )
        _add_geom(
            mixer,
            f"hl_leg_{side}_midrear_col",
            "box",
            pos=(sx, 0.085, 0.115),
            size=(0.055, 0.066, 0.051),
            rgba=COL_BASE_RGBA,
        )
        _add_geom(
            mixer,
            f"hl_leg_{side}_rear_col",
            "box",
            pos=(sx, 0.186, 0.088),
            size=(0.059, 0.0415, 0.078),
            rgba=COL_BASE_RGBA,
        )

    # Rear pedestal bridge, 4-tier sloped cast column, and bowl lift guide rails
    _add_geom(
        mixer,
        "hl_rear_bridge_col",
        "box",
        pos=(0.0, 0.145, 0.122),
        size=(0.145, 0.078, 0.048),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "hl_column_lo_col",
        "box",
        pos=(0.0, 0.108, 0.200),
        size=(0.116, 0.108, 0.050),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "hl_column_midlo_col",
        "box",
        pos=(0.0, 0.094, 0.315),
        size=(0.100, 0.108, 0.065),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "hl_column_midhi_col",
        "box",
        pos=(0.0, 0.057, 0.445),
        size=(0.090, 0.103, 0.065),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "hl_column_hi_col",
        "box",
        pos=(0.0, 0.0135, 0.540),
        size=(0.116, 0.1215, 0.030),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "hl_guide_rails_col",
        "box",
        pos=(0.0, -0.012, 0.322),
        size=(0.078, 0.011, 0.1465),
        rgba=COL_BASE_RGBA,
    )

    # Rounded motor & gearbox housing + crown (exact top Z = 0.7370 m)
    _add_geom(
        mixer,
        "hl_head_main_col",
        "box",
        pos=(0.0, -0.0575, 0.644),
        size=(0.131, 0.244, 0.076),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_head_crown_col",
        "box",
        pos=(0.0, -0.025, 0.7285),
        size=(0.112, 0.210, 0.0085),
        rgba=COL_WALL_RGBA,
    )

    # Front attachment hub, hub clamp knob, and planetary fixed neck + drip cup
    _add_geom(
        mixer,
        "hl_front_hub_col",
        "cylinder",
        pos=(0.0, -0.324, 0.630),
        quat=Y_AXIS_QUAT,
        size=(0.047, 0.0245),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_hub_clamp_col",
        "box",
        pos=(0.038, -0.315, 0.678),
        size=(0.013, 0.015, 0.016),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_planetary_neck_col",
        "cylinder",
        pos=(0.0, bowl_y, 0.546),
        size=(0.112, 0.024),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_drip_lip_col",
        "cylinder",
        pos=(0.0, bowl_y, 0.514),
        size=(0.121, 0.008),
        rgba=COL_WALL_RGBA,
    )

    # Right-side control panel bezel and rotary knobs
    _add_geom(
        mixer,
        "hl_ctrl_panel_col",
        "box",
        pos=(0.141, -0.019, 0.649),
        size=(0.012, 0.085, 0.052),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_timer_knob_col",
        "cylinder",
        pos=(0.162, -0.030, 0.637),
        quat=X_AXIS_QUAT,
        size=(0.016, 0.015),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_speed_knob_col",
        "cylinder",
        pos=(0.162, 0.031, 0.637),
        quat=X_AXIS_QUAT,
        size=(0.016, 0.015),
        rgba=COL_WALL_RGBA,
    )

    # Right-side manual lift lever (reaches X = +0.3145 m)
    _add_geom(
        mixer,
        "hl_lever_upper_col",
        "capsule",
        fromto=(0.130, 0.070, 0.490, 0.166, 0.061, 0.410),
        size="0.008",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_lever_mid_col",
        "capsule",
        fromto=(0.166, 0.061, 0.410, 0.240, 0.055, 0.315),
        size="0.008",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "hl_lever_grip_col",
        "capsule",
        fromto=(0.240, 0.055, 0.315, 0.307, 0.055, 0.315),
        size="0.0075",
        rgba=COL_WALL_RGBA,
    )

    # Sliding bowl carriage + 6-sector curved horseshoe yoke + pins + lock lever (hl_bowl_lift)
    _add_geom(
        lift,
        "hl_lift_carriage_col",
        "box",
        pos=(0.0, -0.005, 0.287),
        size=(0.082, 0.0185, 0.079),
        rgba=COL_ARTIC_RGBA,
    )
    r_yoke = 0.179
    for idx in range(6):
        ang = math.radians(15.0 + 30.0 * idx)
        _add_geom(
            lift,
            f"hl_yoke_{idx:02d}_col",
            "box",
            pos=(r_yoke * math.cos(ang), bowl_y + r_yoke * math.sin(ang), 0.244),
            quat=numbers(z_rot_quat(ang)),
            size=(0.011, 0.048, 0.014),
            rgba=COL_ARTIC_RGBA,
        )
    for side, sx in (("l", -0.181), ("r", 0.181)):
        _add_geom(
            lift,
            f"hl_support_pin_{side}_col",
            "cylinder",
            pos=(sx, bowl_y, 0.263),
            size=(0.012, 0.0245),
            rgba=COL_ARTIC_RGBA,
        )
    _add_geom(
        lift,
        "hl_lock_lever_col",
        "box",
        pos=(0.179, bowl_y - 0.010, 0.276),
        size=(0.007, 0.0235, 0.003),
        rgba=COL_ARTIC_RGBA,
    )

    # Rotating front wire guard (hl_guard, origin at (0, -0.194, 0))
    _add_conical_guard_staves(
        guard,
        "hl_guard_stave",
        center_xy=(0.0, 0.0),
        start_deg=163.0,
        stop_deg=377.0,
        n_staves=8,
        r_bot=0.179,
        z_bot=0.391,
        r_top=0.129,
        z_top=0.508,
        radial_half=0.008,
        rgba=COL_ARTIC_RGBA,
    )

    # Planetary carrier disc (hl_planetary) and agitator shaft (hl_tool_axis)
    _add_geom(
        orbit,
        "hl_planetary_col",
        "cylinder",
        pos=(0.0, 0.0, -0.001),
        size=(0.111, 0.0135),
        rgba=COL_ARTIC_RGBA,
    )
    _add_geom(
        tool,
        "hl_tool_axis_col",
        "cylinder",
        pos=(0.0, 0.0, -0.027),
        size=(0.013, 0.0325),
        rgba=COL_ARTIC_RGBA,
    )


def _add_aicoh_colliders(
    mixer: ET.Element,
    lift: ET.Element,
    guard: ET.Element,
    orbit: ET.Element,
    tool: ET.Element,
) -> None:
    bowl_y = -0.200

    # Four square legs + foot end caps touching exact Z = 0.0000 m
    for lbl, fx, fy in (
        ("fl", -0.220, -0.225),
        ("fr", 0.220, -0.225),
        ("rl", -0.220, 0.335),
        ("rr", 0.220, 0.335),
    ):
        _add_geom(
            mixer,
            f"ms_foot_{lbl}_col",
            "box",
            pos=(fx, fy, 0.003),
            size=(0.039, 0.039, 0.003),
            friction="0.85 0.015 0.003",
            rgba=COL_BASE_RGBA,
        )
        _add_geom(
            mixer,
            f"ms_leg_{lbl}_col",
            "box",
            pos=(fx, fy, 0.1045),
            size=(0.040, 0.040, 0.0985),
            rgba=COL_BASE_RGBA,
        )

    # Open perimeter rectangular base rails + column mounting plate
    for side, sx in (("l", -0.220), ("r", 0.220)):
        _add_geom(
            mixer,
            f"ms_side_rail_{side}_col",
            "box",
            pos=(sx, 0.055, 0.239),
            size=(0.040, 0.320, 0.036),
            rgba=COL_BASE_RGBA,
        )
    for lbl, ry, hy in (("front", -0.226, 0.042), ("rear", 0.335, 0.040)):
        _add_geom(
            mixer,
            f"ms_cross_rail_{lbl}_col",
            "box",
            pos=(0.0, ry, 0.239),
            size=(0.180, hy, 0.036),
            rgba=COL_BASE_RGBA,
        )
    _add_geom(
        mixer,
        "ms_column_plate_col",
        "box",
        pos=(0.0, 0.181, 0.283),
        size=(0.217, 0.1875, 0.008),
        rgba=COL_BASE_RGBA,
    )

    # Lower & upper stainless column enclosure, front lift guides, and fixed bowl stopper brackets
    _add_geom(
        mixer,
        "ms_column_lo_col",
        "box",
        pos=(0.0, 0.210, 0.562),
        size=(0.1225, 0.1425, 0.271),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "ms_lift_guides_col",
        "box",
        pos=(0.0, 0.058, 0.595),
        size=(0.065, 0.0095, 0.300),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        mixer,
        "ms_column_hi_col",
        "box",
        pos=(0.0, 0.207, 0.983),
        size=(0.1225, 0.145, 0.150),
        rgba=COL_BASE_RGBA,
    )
    for side, sx in (("l", -0.155), ("r", 0.155)):
        _add_geom(
            mixer,
            f"ms_stopper_{side}_col",
            "box",
            pos=(sx, 0.030, 0.812),
            size=(0.015, 0.025, 0.038),
            rgba=COL_BASE_RGBA,
        )

    # Motor & gearbox housing + top cover folded lip (exact top Z = 1.4450 m)
    _add_geom(
        mixer,
        "ms_head_main_col",
        "box",
        pos=(0.0, 0.005, 1.278),
        size=(0.130, 0.345, 0.157),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "ms_top_cover_col",
        "box",
        pos=(0.0, 0.005, 1.440),
        size=(0.133, 0.348, 0.005),
        rgba=COL_WALL_RGBA,
    )

    # Front control panel bezel, E-stop mushroom (reaches Y = -0.379 m), and rear lube cups (Y = +0.395 m)
    _add_geom(
        mixer,
        "ms_ctrl_panel_col",
        "box",
        pos=(0.0, -0.346, 1.272),
        size=(0.070, 0.006, 0.088),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        mixer,
        "ms_estop_col",
        "cylinder",
        pos=(-0.030, -0.365, 1.224),
        quat=Y_AXIS_QUAT,
        size=(0.020, 0.014),
        rgba=COL_WALL_RGBA,
    )
    for idx, lz in enumerate((1.140, 1.220)):
        _add_geom(
            mixer,
            f"ms_lube_cup_{idx}_col",
            "cylinder",
            pos=(0.105, 0.374, lz),
            quat=Y_AXIS_QUAT,
            size=(0.013, 0.021),
            rgba=COL_WALL_RGBA,
        )

    # Planetary fixed clutch cover + rear fixed wire guard (merged into ms_mixer)
    _add_geom(
        mixer,
        "ms_clutch_cover_col",
        "cylinder",
        pos=(0.0, bowl_y, 1.104),
        size=(0.128, 0.020),
        rgba=COL_WALL_RGBA,
    )
    _add_conical_guard_staves(
        mixer,
        "ms_fixed_guard_stave",
        center_xy=(0.0, bowl_y),
        start_deg=0.0,
        stop_deg=180.0,
        n_staves=6,
        r_bot=0.184,
        z_bot=0.924,
        r_top=0.115,
        z_top=1.082,
        radial_half=0.005,
        rgba=COL_WALL_RGBA,
    )

    # Right-side manual lift handwheel (merged into ms_mixer; open rim + hub + spokes + crank grip to X = +0.285 m)
    wx, wy, wz = 0.179, 0.146, 0.898
    _add_geom(
        mixer,
        "ms_wheel_hub_col",
        "cylinder",
        pos=(wx, wy, wz),
        quat=X_AXIS_QUAT,
        size=(0.028, 0.0225),
        rgba=COL_WALL_RGBA,
    )
    n_rim = 10
    r_rim = 0.109
    for idx in range(n_rim):
        a0 = idx * math.tau / n_rim
        a1 = (idx + 1) * math.tau / n_rim
        _add_geom(
            mixer,
            f"ms_wheel_rim_{idx:02d}_col",
            "capsule",
            fromto=(
                wx + 0.015,
                wy + r_rim * math.cos(a0),
                wz + r_rim * math.sin(a0),
                wx + 0.015,
                wy + r_rim * math.cos(a1),
                wz + r_rim * math.sin(a1),
            ),
            size="0.009",
            rgba=COL_WALL_RGBA,
        )
    for idx, deg in enumerate((90.0, 210.0, 330.0)):
        ang = math.radians(deg)
        _add_geom(
            mixer,
            f"ms_wheel_spoke_{idx}_col",
            "capsule",
            fromto=(
                wx + 0.015,
                wy,
                wz,
                wx + 0.015,
                wy + 0.104 * math.cos(ang),
                wz + 0.104 * math.sin(ang),
            ),
            size="0.007",
            rgba=COL_WALL_RGBA,
        )
    _add_geom(
        mixer,
        "ms_wheel_crank_col",
        "cylinder",
        pos=(wx + 0.063, wy, wz - 0.093),
        quat=X_AXIS_QUAT,
        size=(0.013, 0.043),
        rgba=COL_WALL_RGBA,
    )

    # Bowl lift carriage, twin support arms, locating saddles, and locating pins (ms_bowl_lift)
    _add_geom(
        lift,
        "ms_lift_carriage_col",
        "box",
        pos=(0.0, 0.043, 0.763),
        size=(0.1025, 0.035, 0.055),
        rgba=COL_ARTIC_RGBA,
    )
    for side, sgn in (("l", -1.0), ("r", 1.0)):
        _add_geom(
            lift,
            f"ms_lift_arm_{side}_col",
            "box",
            pos=(sgn * 0.201, -0.090, 0.748),
            size=(0.018, 0.148, 0.0325),
            rgba=COL_ARTIC_RGBA,
        )
        _add_geom(
            lift,
            f"ms_lift_saddle_{side}_col",
            "box",
            pos=(sgn * 0.204, bowl_y, 0.759),
            size=(0.026, 0.0345, 0.0275),
            rgba=COL_ARTIC_RGBA,
        )
        _add_geom(
            lift,
            f"ms_lift_pin_{side}_col",
            "cylinder",
            pos=(sgn * 0.204, bowl_y, 0.794),
            size=(0.007, 0.0125),
            rgba=COL_ARTIC_RGBA,
        )

    # Rotating front wire guard + handle (ms_guard, origin at (0, -0.200, 0))
    _add_conical_guard_staves(
        guard,
        "ms_guard_stave",
        center_xy=(0.0, 0.0),
        start_deg=180.0,
        stop_deg=360.0,
        n_staves=8,
        r_bot=0.194,
        z_bot=0.921,
        r_top=0.126,
        z_top=1.095,
        radial_half=0.006,
        rgba=COL_ARTIC_RGBA,
    )
    _add_geom(
        guard,
        "ms_guard_handle_col",
        "capsule",
        fromto=(0.214, -0.084, 0.960, 0.179, -0.068, 1.038),
        size="0.007",
        rgba=COL_ARTIC_RGBA,
    )

    # Planetary carrier disc (ms_planetary) and drive spindle + retention collar (ms_tool_axis)
    _add_geom(
        orbit,
        "ms_planetary_col",
        "cylinder",
        pos=(0.0, 0.0, 0.0),
        size=(0.087, 0.0095),
        rgba=COL_ARTIC_RGBA,
    )
    _add_geom(
        tool,
        "ms_tool_spindle_col",
        "cylinder",
        pos=(0.0, 0.0, -0.043),
        size=(0.020, 0.045),
        rgba=COL_ARTIC_RGBA,
    )
    _add_geom(
        tool,
        "ms_tool_collar_col",
        "cylinder",
        pos=(0.0, 0.0, -0.074),
        size=(0.030, 0.0075),
        rgba=COL_ARTIC_RGBA,
    )


def bowl_colliders(asset: ET.Element, body: ET.Element, profile: list[tuple[float, float]]) -> None:
    """Short convex wall sections preserve the empty interior of a curved bowl."""
    for band, ((r0, z0), (r1, z1)) in enumerate(pairwise(profile)):
        for sector in range(24):
            angles = (math.tau * sector / 24, math.tau * (sector + 1) / 24)
            points = []
            for radius, z in ((r0, z0), (r1, z1)):
                for offset in (0, 0.004):
                    for angle in angles:
                        points.extend(
                            (
                                (radius + offset) * math.cos(angle),
                                (radius + offset) * math.sin(angle),
                                z,
                            )
                        )
            name = f"mix_bowl_wall_{band}_{sector}"
            ET.SubElement(asset, "mesh", name=name, vertex=numbers(points))
            ET.SubElement(
                body,
                "geom",
                name=name,
                type="mesh",
                mesh=name,
                contype="1",
                conaffinity="1",
                group="3",
                rgba=COL_ACCESSORY_RGBA,
                mass="0",
            )
    ET.SubElement(
        body,
        "geom",
        name="mix_bowl_floor",
        type="cylinder",
        pos=numbers((0, 0, profile[0][1] - 0.001)),
        size=numbers((profile[0][0], 0.001)),
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
        mass="0",
    )


def build(
    name: str,
    prefix: str,
    speeds: tuple[int, ...],
    lift_travel: float,
    guard_angle: float,
    total_mass: float,
    profile: list[tuple[float, float]],
) -> None:
    import bpy
    from build_oven_visuals import export_visual_meshes

    directory = ASSETS / name
    source = directory / (name + ".blend")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    names = [
        prefix + suffix
        for suffix in (
            "_mixer",
            "_bowl_lift",
            "_bowl",
            "_guard",
            "_planetary",
            "_tool_axis",
        )
    ]
    parts = [bpy.data.objects[value] for value in names]
    attachments = [bpy.data.objects[prefix + suffix] for suffix in ("_beater", "_whip")]
    installed = attachments[1] if prefix == "ms" else attachments[0]
    alternate = attachments[0] if prefix == "ms" else attachments[1]
    alternate.animation_data_clear()
    alternate.parent = parts[5]
    alternate.location = (0, 0, 0)
    alternate.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()

    poses = {obj.name: obj.matrix_world.copy() for obj in parts}
    poses.update({obj.name: obj.matrix_world.copy() for obj in attachments})
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
            continue
        parent = obj.parent
        while parent not in parts + attachments:
            parent = parent.parent
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
        if obj.type == "MESH" and len(obj.data.vertices) >= 3:
            xs = [v.co.x for v in obj.data.vertices]
            ys = [v.co.y for v in obj.data.vertices]
            zs = [v.co.z for v in obj.data.vertices]
            changed = False
            if max(xs) - min(xs) < 1e-5:
                obj.data.vertices[0].co.x += 2e-5
                changed = True
            if max(ys) - min(ys) < 1e-5:
                obj.data.vertices[0].co.y += 2e-5
                changed = True
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
                changed = True
            if changed:
                obj.data.update()
    bpy.context.view_layer.update()

    mesh_dir = directory / "meshes"
    if mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts + attachments, directory)

    model = ET.Element("mujoco", model=name + " — uncalibrated planetary lab")
    ET.SubElement(model, "compiler", angle="radian")
    # The smaller step limits gear-constraint deflection during a sudden jam.
    ET.SubElement(model, "option", timestep="0.0005", integrator="implicitfast")
    ET.SubElement(model, "size", nuserdata="4")

    defaults = add_standard_defaults(
        model,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    custom = ET.SubElement(model, "custom")
    ET.SubElement(
        custom, "numeric", name="mix_speed_settings_rpm", data=numbers(speeds)
    )
    ET.SubElement(custom, "numeric", name="mix_lift_travel", data=str(lift_travel))
    ET.SubElement(custom, "numeric", name="mix_guard_open", data=str(guard_angle))
    # Assumed gear ratio: relative tool spin = -4 × carrier orbit.
    # A selected published RPM is mapped to absolute tool spin in this lab only.
    ET.SubElement(custom, "numeric", name="mix_gear_ratio", data="-4")

    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")
    model_asset = copy.deepcopy(asset)

    world = ET.SubElement(model, "worldbody")
    body_elements: dict[str, ET.Element] = {}
    large = prefix == "ms"
    masses = (
        total_mass - (23 if large else 10.7),
        8.0 if large else 3.0,
        9.0 if large else 4.0,
        2.0 if large else 1.0,
        3.0 if large else 2.0,
        1.0 if large else 0.7,
    )
    if large:
        centers = {
            "ms_mixer": (0.0, 0.080, 0.720),
            "ms_bowl_lift": (0.0, -0.070, 0.760),
            "ms_bowl": (0.0, 0.0, 0.150),
            "ms_guard": (0.0, -0.100, 1.010),
            "ms_planetary": (0.0, 0.0, 0.0),
            "ms_tool_axis": (0.0, 0.0, -0.043),
        }
        inertias = {
            "ms_mixer": (42.0, 38.0, 14.0),
            "ms_bowl_lift": (0.100, 0.180, 0.240),
            "ms_bowl": (0.140, 0.140, 0.180),
            "ms_guard": (0.025, 0.025, 0.040),
            "ms_planetary": (0.008, 0.008, 0.015),
            "ms_tool_axis": (0.003, 0.003, 0.003),
        }
    else:
        centers = {
            "hl_mixer": (0.0, 0.020, 0.360),
            "hl_bowl_lift": (0.0, -0.090, 0.260),
            "hl_bowl": (0.0, 0.0, 0.120),
            "hl_guard": (0.0, -0.090, 0.450),
            "hl_planetary": (0.0, 0.0, 0.0),
            "hl_tool_axis": (0.0, 0.0, -0.027),
        }
        inertias = {
            "hl_mixer": (3.80, 3.40, 1.80),
            "hl_bowl_lift": (0.030, 0.045, 0.055),
            "hl_bowl": (0.042, 0.042, 0.056),
            "hl_guard": (0.012, 0.012, 0.018),
            "hl_planetary": (0.006, 0.006, 0.012),
            "hl_tool_axis": (0.003, 0.003, 0.003),
        }

    for obj, mass in zip(parts, masses):
        parent = body_elements.get(obj.parent.name) if obj.parent else None
        if parent is None:
            parent = world
            transform = poses[obj.name]
        else:
            transform = poses[obj.parent.name].inverted() @ poses[obj.name]
        body = ET.SubElement(
            parent,
            "body",
            name=obj.name,
            pos=numbers(transform.translation),
            quat=numbers(transform.to_quaternion()),
        )
        body_elements[obj.name] = body
        ET.SubElement(
            body,
            "inertial",
            mass=str(mass),
            pos=numbers(centers[obj.name]),
            diaginertia=numbers(inertias[obj.name]),
        )
        ET.SubElement(body, "include", file=f"visual_{obj.name}.xml")

    mixer_body = body_elements[parts[0].name]
    lift, bowl, guard, orbit, tool = [body_elements[obj.name] for obj in parts[1:]]

    # Lift slide joint holds its own carriage weight cleanly against gravity (Scenario 6 gravity-hold)
    ET.SubElement(
        lift,
        "joint",
        name="mix_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range=numbers((-lift_travel, 0)),
        damping="100",
        armature="0.05",
        frictionloss="120" if large else "60",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        guard,
        "joint",
        name="mix_guard",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range=numbers((min(0, guard_angle), max(0, guard_angle))),
        damping="0.5",
        armature="0.005",
        frictionloss="0.5",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        orbit,
        "joint",
        name="mix_orbit",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.05" if large else "0.02",
        armature="0.005",
    )
    ET.SubElement(
        tool,
        "joint",
        name="mix_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.025" if large else "0.01",
        armature="0.002",
        solreffriction="0.004 1",
        solimpfriction="0.9999 0.9999 0.001",
    )

    if large:
        _add_aicoh_colliders(mixer_body, lift, guard, orbit, tool)
    else:
        _add_hobart_colliders(mixer_body, lift, guard, orbit, tool)

    bowl_colliders(asset, bowl, profile)
    equality = ET.SubElement(model, "equality")
    # Removable parts use free joints. Welds approximate engaged clamps/bayonets.
    lift.remove(bowl)
    bowl.set("pos", numbers(poses[parts[2].name].translation))
    world.append(bowl)
    ET.SubElement(bowl, "freejoint", name="mix_bowl_free")
    ET.SubElement(
        lift,
        "site",
        name="mix_bowl_mount",
        pos=bowl.get("pos"),
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        equality,
        "weld",
        name="mix_bowl_coupling",
        body1=parts[1].name,
        body2=parts[2].name,
        solref="0.002 1",
    )
    # A broad receiving pad verifies support when the detached bowl leaves the mixer.
    bowl_z = float(poses[parts[2].name].translation.z)
    ET.SubElement(
        world,
        "geom",
        name="mix_bowl_bench",
        type="box",
        pos=numbers((0, -0.95, bowl_z - lift_travel - 0.025)),
        size="0.3 0.3 0.025",
        rgba="0.32 0.36 0.39 1",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        tool,
        "site",
        name="mix_tool_mount",
        pos="0 0 0",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    tool.find("inertial").set("mass", "0.2")
    tool.find("inertial").set("pos", numbers(centers[parts[5].name]))

    for attachment in attachments:
        kind = attachment.name.split("_")[-1]
        mounted = attachment == installed
        position = poses[attachment.name].translation.copy()
        if not mounted:
            position.x += 0.65
            position.y = -0.65
        body = ET.SubElement(world, "body", name=attachment.name, pos=numbers(position))
        ET.SubElement(body, "freejoint", name=f"mix_{kind}_free")
        ET.SubElement(
            body,
            "inertial",
            mass=str((1 if large else 0.7) - 0.2),
            pos=numbers((0, 0, -0.25 if large else -0.18)),
            diaginertia="0.006 0.006 0.003",
        )
        ET.SubElement(body, "include", file=f"visual_{attachment.name}.xml")
        for index, visual in enumerate(
            ET.parse(directory / f"visual_{attachment.name}.xml").getroot()
        ):
            contact = copy.deepcopy(visual)
            contact.attrib.pop("material", None)
            contact.set("name", f"mix_{kind}_contact_{index}")
            contact.set("contype", "1")
            contact.set("conaffinity", "1")
            contact.set("group", "3")
            contact.set("rgba", COL_ARTIC_RGBA)
            body.append(contact)
        ET.SubElement(
            equality,
            "weld",
            name=f"mix_{kind}_coupling",
            body1=parts[5].name,
            body2=attachment.name,
            relpose="0 0 0 1 0 0 0",
            active=str(mounted).lower(),
            solref="0.002 1",
            solimp="0.9999 0.9999 0.001",
        )
        rack_pos = (
            0.65 if kind == "whip" else -0.65,
            -0.65,
            float(poses[parts[5].name].translation.z),
        )
        if not mounted:
            body.set("pos", numbers(rack_pos))
        rack = ET.SubElement(
            world, "body", name=f"mix_{kind}_rack", pos=numbers(rack_pos)
        )
        ET.SubElement(
            rack,
            "geom",
            type="cylinder",
            pos="0 0 0.02",
            size="0.035 0.02",
            rgba="0.3 0.35 0.4 1",
            contype="0",
            conaffinity="0",
        )
        ET.SubElement(
            equality,
            "weld",
            name=f"mix_{kind}_parking",
            body1=rack.get("name"),
            body2=attachment.name,
            relpose="0 0 0 1 0 0 0",
            active=str(not mounted).lower(),
            solref="0.002 1",
        )

    ET.SubElement(
        equality,
        "joint",
        name="mix_gears",
        joint1="mix_spin",
        joint2="mix_orbit",
        polycoef="0 -4 0 0 0",
        solref="0.001 1",
        solimp="0.9999 0.9999 0.001",
    )

    # Adjacent/nested body excludes (standalone model.xml uses only mixer-internal pairs;
    # mixer.xml also excludes mixer/lift/guard/drive vs removable bowl/tools while keeping bowl <-> tool active!)
    m_name, l_name, b_name, g_name, o_name, t_name = names
    beater_name, whip_name = (att.name for att in attachments)
    internal_excludes = (
        ("exclude_mixer_lift", m_name, l_name),
        ("exclude_mixer_guard", m_name, g_name),
        ("exclude_mixer_planetary", m_name, o_name),
        ("exclude_mixer_tool_axis", m_name, t_name),
        ("exclude_lift_guard", l_name, g_name),
        ("exclude_guard_planetary", g_name, o_name),
        ("exclude_guard_tool_axis", g_name, t_name),
        ("exclude_planetary_tool_axis", o_name, t_name),
    )
    model_contact = ET.Element("contact")
    for ex_name, b1, b2 in internal_excludes:
        ET.SubElement(model_contact, "exclude", name=ex_name, body1=b1, body2=b2)

    attachment_excludes = (
        ("exclude_mixer_bowl", m_name, b_name),
        ("exclude_lift_bowl", l_name, b_name),
        ("exclude_guard_bowl", g_name, b_name),
        ("exclude_planetary_bowl", o_name, b_name),
        ("exclude_tool_axis_bowl", t_name, b_name),
        ("exclude_mixer_beater", m_name, beater_name),
        ("exclude_lift_beater", l_name, beater_name),
        ("exclude_guard_beater", g_name, beater_name),
        ("exclude_planetary_beater", o_name, beater_name),
        ("exclude_tool_axis_beater", t_name, beater_name),
        ("exclude_mixer_whip", m_name, whip_name),
        ("exclude_lift_whip", l_name, whip_name),
        ("exclude_guard_whip", g_name, whip_name),
        ("exclude_planetary_whip", o_name, whip_name),
        ("exclude_tool_axis_whip", t_name, whip_name),
        ("exclude_beater_whip", beater_name, whip_name),
    )
    add_adjacent_excludes(model, (*internal_excludes, *attachment_excludes))

    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="mix_drive",
        joint="mix_orbit",
        kv="20",
        ctrlrange="0 20",
        forcerange="-16 16" if large else "-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mix_lift_fixture",
        joint="mix_lift",
        kp="180000" if large else "120000",
        kv="1800" if large else "1500",
        ctrlrange=numbers((-lift_travel, 0)),
        forcerange="-1000 1000",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mix_guard_fixture",
        joint="mix_guard",
        kp="60",
        kv="12",
        ctrlrange=numbers((min(0, guard_angle), max(0, guard_angle))),
        forcerange="-60 60",
    )

    sensors = ET.SubElement(model, "sensor")
    for joint in ("orbit", "spin", "guard", "lift"):
        ET.SubElement(
            sensors, "jointpos", name=f"mix_{joint}_position", joint=f"mix_{joint}"
        )
        ET.SubElement(
            sensors, "jointvel", name=f"mix_{joint}_velocity", joint=f"mix_{joint}"
        )

    write_xml(directory / "mixer.xml", model)

    emit_standalone_models(
        directory,
        model_name=m_name,
        defaults=defaults,
        asset=model_asset,
        root_body=mixer_body,
        contact=model_contact,
        sensors=sensors,
    )

    scene = ET.Element("mujoco", model=name + " native lab")
    ET.SubElement(scene, "include", file="mixer.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.35 0.35 0.35", diffuse="0.7 0.7 0.7")
    ET.SubElement(
        scene,
        "statistic",
        center=numbers((0, -0.1, 0.7 if large else 0.36)),
        extent="1.8" if large else "1.0",
    )
    scene_assets = ET.SubElement(scene, "asset")
    ET.SubElement(
        scene_assets,
        "texture",
        name="mix_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(
        scene_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1", diffuse="0.8 0.8 0.8"
    )
    ET.SubElement(
        scene_world, "light", pos="2 1 3", dir="-0.5 -0.2 -1", diffuse="0.5 0.5 0.5"
    )
    ET.SubElement(
        scene_world,
        "geom",
        name="mix_floor",
        type="plane",
        pos="0 0 -0.001",
        size="3 3 0.05",
        rgba="0.28 0.32 0.35 1",
        contype="1",
        conaffinity="1",
    )
    write_xml(directory / "scene.xml", scene)

    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "retained_bodies": names,
        "dry_mass_kg": total_mass,
        "assumptions": "Free bowl and two tools; pose-checked welds approximate clamps, bayonets and tool rack sockets. Estimated inertias, gear ratio and handling forces.",
        "scope": "MuJoCo 4.0 visual, contact, standalone model.xml, mixer.xml, scene.xml, and native.xml.",
    }
    (directory / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def export_blender_meshes_and_xml() -> None:
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    build(
        "aicoh-ms-30",
        "ms",
        (120, 220, 320, 430),
        0.120,
        math.pi,
        287.0,
        [
            (0.059, 0.004),
            (0.080, 0.012),
            (0.110, 0.034),
            (0.143, 0.073),
            (0.168, 0.120),
            (0.178, 0.166),
            (0.180, 0.221),
            (0.182, 0.300),
            (0.182, 0.349),
        ],
    )
    build(
        "hobart-hl200",
        "hl",
        (59, 107, 198, 365),
        0.020,
        -math.tau / 3,
        85.7,
        [
            (0.042, 0.002),
            (0.063, 0.008),
            (0.088, 0.022),
            (0.113, 0.043),
            (0.135, 0.071),
            (0.148, 0.105),
            (0.153, 0.140),
            (0.154, 0.245),
            (0.155, 0.292),
        ],
    )


def _verify_mixer(
    folder_name: str,
    prefix: str,
    mujoco,
    np,
) -> dict:
    from live_panels import model_spec

    directory = ASSETS / folder_name
    spec = model_spec(directory / "scene.xml", folder_name)
    _model, rebuilt = kit_export_native_xml(
        directory, folder_name, mujoco, np, spec=spec, strip_general_input=False
    )

    # Verify standalone model.xml compiles and steps cleanly with zero NaN
    standalone = mujoco.MjModel.from_xml_path(str(directory / "model.xml"))
    sdata = mujoco.MjData(standalone)
    mujoco.mj_forward(standalone, sdata)
    for _ in range(100):
        mujoco.mj_step(standalone, sdata)
    if not (np.all(np.isfinite(sdata.qpos)) and np.all(np.isfinite(sdata.qvel))):
        raise RuntimeError(f"Standalone model.xml diverged for {folder_name}")

    # Verify native.xml steps cleanly with bowl and installed tool coupled
    rdata = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, rdata)
    for _ in range(400):
        mujoco.mj_step(rebuilt, rdata)
    if not (np.all(np.isfinite(rdata.qpos)) and np.all(np.isfinite(rdata.qvel))):
        raise RuntimeError(f"Native model diverged for {folder_name}")

    # Verify GLB rest frame alignment against native.xml
    rebuilt_names = [
        prefix + suffix
        for suffix in (
            "_mixer",
            "_bowl_lift",
            "_bowl",
            "_guard",
            "_planetary",
            "_tool_axis",
        )
    ]
    native_path = directory / "native.xml"
    glb_path = directory / f"{folder_name}.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()
    mujoco.mj_resetData(rebuilt, rdata)
    mujoco.mj_forward(rebuilt, rdata)
    body_poses = {}
    for bname in rebuilt_names:
        bid = rebuilt.body(bname).id
        body_poses[bname] = [
            *rdata.xpos[bid].tolist(),
            *rdata.xquat[bid].tolist(),
        ]
    evidence_dir = directory / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                folder_name: {
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
    frames_in.unlink(missing_ok=True)
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    return {
        "appliance": folder_name,
        "status": "passed",
        "native_nq": int(rebuilt.nq),
        "native_nv": int(rebuilt.nv),
        "standalone_nq": int(standalone.nq),
        "frames_passed": frames_report["passed"],
    }


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np

    results = [
        _verify_mixer("aicoh-ms-30", "ms", mujoco, np),
        _verify_mixer("hobart-hl200", "hl", mujoco, np),
    ]
    print(json.dumps(results, indent=2))


def main() -> None:
    if "--blender-export" in sys.argv or "bpy" in sys.modules:
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
    export_and_verify_native_and_physics()


if __name__ == "__main__":
    main()
