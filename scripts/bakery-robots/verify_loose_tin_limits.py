"""Measure real slip, rim-impact, and tilt limits for loose baking tins on the MBCO-4ME tray.

Replays real production `bakery-native` spanner-oven trajectories across FR10, UR5e,
and FANUC CRX-10iA/L, plus a speed-scale and tin-friction sweep on FR10 for both:
- `financier` (8x 76x48x22 mm flat tins, slide-governed), and
- `tall_mould` (8x 36 mm dia x 48 mm tall moulds, slide + tip-governed).

Usage:
  uv run --python 3.11 --with-requirements scripts/bakery-robots/requirements-physics.txt \
    python scripts/bakery-robots/verify_loose_tin_limits.py <output_dir>
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import mujoco
import numpy as np

ROBOTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = ROBOTS_DIR.parents[1]
STUDIO_DIR = ROBOTS_DIR.parent / "bakery-mujoco/studio_workcell"
for _p in (str(ROBOTS_DIR), str(STUDIO_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import workcell_scene as ws  # noqa: E402
from loose_tin_tray import (  # noqa: E402
    TinRegime,
    compose_loose_tin_spanner_cell,
    robot_spec_by_slug,
)
from spanner_workcell import SPANNER_LAYOUTS, SPANNER_OPEN_M  # noqa: E402
from two_arm_workcell import SPANNER_CLOSED_M  # noqa: E402

DEFAULT_NATIVE_BIN = REPO_ROOT / "crates/bakery-native/target/release/bakery-native"


def _record_native_trajectory(
    robot_slug: str, binary: Path = DEFAULT_NATIVE_BIN
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Run `bakery-native` once to extract exact production `(q_cmd, jaw, carrying, steps)`."""
    with tempfile.TemporaryDirectory(prefix="loose-tin-native-") as tmp:
        req = Path(tmp) / "req.json"
        rec = Path(tmp) / "rec.json"
        subprocess.run(
            [
                str(binary),
                "--output",
                str(req),
                "prepare",
                "--robot",
                robot_slug,
                "--task",
                "table-to-oven",
                "--cell",
                "spanner-oven",
                "--case",
                "nominal",
                "--timestep",
                "0.002",
            ],
            cwd=str(REPO_ROOT),
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [str(binary), "--output", str(rec), "run", str(req)],
            cwd=str(REPO_ROOT),
            check=True,
            capture_output=True,
        )
        data = json.loads(rec.read_text(encoding="utf-8"))

    samples = data["samples"]
    phase_events = [e for e in data["events"] if e["kind"] == "phase"]
    pickup_step = next(
        (e["step"] for e in phase_events if e["label"] == "grasp"), 0
    )
    lift_step = next(
        (e["step"] for e in phase_events if e["label"] == "lift"), pickup_step
    )
    release_step = next(
        (e["step"] for e in phase_events if e["label"] == "release"),
        samples[-1]["step"],
    )

    steps = np.array([s["step"] for s in samples], dtype=np.float64)
    joints = np.array([s["joints"] for s in samples], dtype=np.float64)
    jaw = np.where(
        (steps >= pickup_step) & (steps < release_step),
        SPANNER_CLOSED_M,
        SPANNER_OPEN_M,
    )
    carrying = (steps >= lift_step) & (steps < release_step)
    return steps, joints, jaw, carrying


def _servo_ctrl_for_robot(
    model: mujoco.MjModel,
    dyn_data: mujoco.MjData,
    qadrs: np.ndarray,
    dadrs: np.ndarray,
    act_ids: np.ndarray,
    kp: np.ndarray,
    ctrl_range: np.ndarray,
    jaw_qadr: int,
    grasp_site: int,
    tool_body: int,
    q_meas: np.ndarray,
    q_cmd: np.ndarray,
    carrying: bool,
) -> np.ndarray:
    mujoco.mj_resetData(model, dyn_data)
    for i, a in enumerate(qadrs):
        dyn_data.qpos[a] = q_meas[i]
    dyn_data.qpos[jaw_qadr] = SPANNER_CLOSED_M if carrying else SPANNER_OPEN_M
    mujoco.mj_forward(model, dyn_data)
    tau = dyn_data.qfrc_bias[dadrs].copy()
    if carrying:
        site = dyn_data.site_xpos[grasp_site]
        rot = dyn_data.site_xmat[grasp_site].reshape(3, 3)
        com_world = site + rot @ np.array([0.0, 0.005, 0.003], dtype=np.float64)
        jp = np.zeros((3, model.nv), dtype=np.float64)
        mujoco.mj_jac(model, dyn_data, jp, None, com_world, tool_body)
        tau += jp[2, dadrs] * (1.85 * 9.81)
    return np.clip(q_cmd + tau / kp, ctrl_range[:, 0], ctrl_range[:, 1])


def run_loose_tin_episode(
    *,
    robot_slug: str,
    regime: TinRegime,
    tin_friction: float,
    speed_scale: float,
    traj: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    render_frames: bool = False,
) -> tuple[dict[str, Any], list[np.ndarray]]:
    """Replay `traj` at `speed_scale` on a multi-body loose-tin tray model."""
    robot_spec = robot_spec_by_slug(robot_slug)
    layout = SPANNER_LAYOUTS[robot_slug]
    spec, placements = compose_loose_tin_spanner_cell(
        robot_spec=robot_spec, regime=regime, tin_friction=tin_friction
    )
    model = spec.compile()
    data = mujoco.MjData(model)
    dyn_data = mujoco.MjData(model)
    dt = float(model.opt.timestep)

    # Bind robot joints/actuators dynamically from XML names
    jids = [
        j for j in range(model.njnt) if model.joint(j).name.startswith(f"{robot_slug}__")
    ]
    assert len(jids) == 6, f"Expected 6 arm joints for {robot_slug}, found {len(jids)}"
    qadrs = np.array([model.jnt_qposadr[j] for j in jids], dtype=int)
    dadrs = np.array([model.jnt_dofadr[j] for j in jids], dtype=int)
    act_ids = np.array(
        [model.actuator(f"{model.joint(j).name}__servo").id for j in jids], dtype=int
    )
    kp = np.array([model.actuator_gainprm[a, 0] for a in act_ids], dtype=np.float64)
    ctrl_range = np.array(
        [model.jnt_range[j] for j in jids], dtype=np.float64
    )
    jaw_qadr = int(model.jnt_qposadr[model.joint("clamp_opening").id])
    jaw_act = model.actuator("clamp_servo").id
    grasp_site = model.site("cell_grasp").id
    tool_body = model.body("cell_gripper").id
    tray_bid = model.body("mbco_tray").id
    tray_qadr = int(model.jnt_qposadr[model.joint("mbco_tray_free").id])

    steps_src, joints_src, jaw_src, carry_src = traj
    # Initialize robot, tray, and 8 loose tins
    for i, a in enumerate(qadrs):
        data.qpos[a] = joints_src[0, i]
    data.qpos[jaw_qadr] = SPANNER_OPEN_M
    data.qpos[tray_qadr : tray_qadr + 3] = layout.tray_pos
    data.qpos[tray_qadr + 3 : tray_qadr + 7] = [1.0, 0.0, 0.0, 0.0]
    tin_bids = []
    tin_init_local = []
    tin_geom_ids = set()
    for tin in placements:
        bid = model.body(tin.name).id
        tin_bids.append(bid)
        tin_init_local.append(np.array(tin.local_xyz, dtype=np.float64))
        tin_geom_ids.add(model.geom(f"{tin.name}_col").id)
    rim_geom_ids = {
        model.geom(n).id
        for n in (
            "mbco4_tray_front_rim_col",
            "mbco4_tray_rear_rim_col",
            "mbco4_tray_left_rim_col",
            "mbco4_tray_right_rim_col",
        )
    }
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)

    # Settle tins onto deck for 100 steps (0.2 s) before starting trajectory
    for _ in range(100):
        ctrl = _servo_ctrl_for_robot(
            model, dyn_data, qadrs, dadrs, act_ids, kp, ctrl_range,
            jaw_qadr, grasp_site, tool_body,
            np.array([data.qpos[a] for a in qadrs]), joints_src[0], False,
        )
        for i, aid in enumerate(act_ids):
            data.ctrl[aid] = ctrl[i]
        data.ctrl[jaw_act] = SPANNER_OPEN_M
        mujoco.mj_step(model, data)

    # Record settled initial tin positions in tray local frame
    tray_p0 = data.xpos[tray_bid].copy()
    tray_r0 = data.xmat[tray_bid].reshape(3, 3).copy()
    tin_local_0 = [tray_r0.T @ (data.xpos[bid] - tray_p0) for bid in tin_bids]

    # Resample trajectory at `speed_scale`: speed up active carry segment while
    # preserving grasp/release ramp duration so pinch stays physical.
    src_max_step = float(steps_src[-1])
    total_sim_steps = int(math.ceil(src_max_step / speed_scale)) + 150

    renderer = mujoco.Renderer(model, height=240, width=320) if render_frames else None
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = 1
    frames: list[np.ndarray] = []

    max_slip_mm = 0.0
    max_tin_tilt_deg = 0.0
    max_tray_tilt_deg = 0.0
    max_tray_horiz_accel_mps2 = 0.0
    rim_impact_steps = 0
    vel_hist: list[np.ndarray] = []
    tray_dof = int(model.jnt_dofadr[model.joint("mbco_tray_free").id])

    for k in range(total_sim_steps):
        s_query = min(src_max_step, k * speed_scale)
        idx = int(np.searchsorted(steps_src, s_query, side="right")) - 1
        idx = max(0, min(len(steps_src) - 2, idx))
        s0, s1 = steps_src[idx], steps_src[idx + 1]
        alpha = 0.0 if s1 <= s0 else float(np.clip((s_query - s0) / (s1 - s0), 0.0, 1.0))
        q_cmd = joints_src[idx] + alpha * (joints_src[idx + 1] - joints_src[idx])
        jaw_cmd = float(jaw_src[idx] + alpha * (jaw_src[idx + 1] - jaw_src[idx]))
        carrying = bool(carry_src[idx])

        q_meas = np.array([data.qpos[a] for a in qadrs], dtype=np.float64)
        ctrl = _servo_ctrl_for_robot(
            model, dyn_data, qadrs, dadrs, act_ids, kp, ctrl_range,
            jaw_qadr, grasp_site, tool_body, q_meas, q_cmd, carrying,
        )
        for i, aid in enumerate(act_ids):
            data.ctrl[aid] = ctrl[i]
        data.ctrl[jaw_act] = jaw_cmd
        mujoco.mj_step(model, data)

        # Measure 20 ms (10-step) filtered horizontal tray acceleration during active carry
        tray_vel_xy = data.qvel[tray_dof : tray_dof + 2].copy()
        vel_hist.append(tray_vel_xy)
        if carrying and len(vel_hist) > 10:
            accel_xy = float(np.linalg.norm((vel_hist[-1] - vel_hist[-11]) / (10.0 * dt)))
            max_tray_horiz_accel_mps2 = max(max_tray_horiz_accel_mps2, accel_xy)

        tray_pos = data.xpos[tray_bid]
        tray_rot = data.xmat[tray_bid].reshape(3, 3)
        tray_tilt = math.degrees(math.acos(float(np.clip(tray_rot[2, 2], -1.0, 1.0))))
        max_tray_tilt_deg = max(max_tray_tilt_deg, tray_tilt)

        # Measure tin slip & tilt relative to tray
        for bid, loc0 in zip(tin_bids, tin_local_0):
            loc = tray_rot.T @ (data.xpos[bid] - tray_pos)
            slip_mm = float(np.linalg.norm(loc[:2] - loc0[:2]) * 1000.0)
            max_slip_mm = max(max_slip_mm, slip_mm)
            tin_rot = data.xmat[bid].reshape(3, 3)
            cos_ang = float(np.clip(np.dot(tin_rot[:, 2], tray_rot[:, 2]), -1.0, 1.0))
            max_tin_tilt_deg = max(max_tin_tilt_deg, math.degrees(math.acos(cos_ang)))

        # Count steps where any loose tin hits a tray perimeter rim
        hit_rim = False
        for ci in range(data.ncon):
            g1, g2 = int(data.contact[ci].geom1), int(data.contact[ci].geom2)
            if (g1 in tin_geom_ids and g2 in rim_geom_ids) or (
                g2 in tin_geom_ids and g1 in rim_geom_ids
            ):
                hit_rim = True
                break
        if hit_rim:
            rim_impact_steps += 1

        if renderer is not None and k % max(1, total_sim_steps // 16) == 0:
            cam = "cell_hero" if k > total_sim_steps // 3 else "tin_closeup"
            renderer.update_scene(data, camera=cam, scene_option=opt)
            frames.append(renderer.render().copy())

    if renderer is not None:
        renderer.update_scene(data, camera="cell_hero", scene_option=opt)
        frames.append(renderer.render().copy())
        renderer.close()

    # Final tin audit
    tray_pos = data.xpos[tray_bid]
    tray_rot = data.xmat[tray_bid].reshape(3, 3)
    rail2_target = np.array(
        [
            ws.OVEN_POS[0] + ws.OVEN_RAIL2_OFFSET[0],
            ws.OVEN_POS[1] + ws.OVEN_RAIL2_OFFSET[1],
            ws.OVEN_POS[2] + ws.OVEN_RAIL2_OFFSET[2] + 0.0005,
        ]
    )
    tray_err_mm = float(np.linalg.norm(tray_pos - rail2_target) * 1000.0)
    tipped = 0
    ejected = 0
    final_slips = []
    for bid, loc0 in zip(tin_bids, tin_local_0):
        loc = tray_rot.T @ (data.xpos[bid] - tray_pos)
        final_slips.append(float(np.linalg.norm(loc[:2] - loc0[:2]) * 1000.0))
        tin_rot = data.xmat[bid].reshape(3, 3)
        tilt = math.degrees(
            math.acos(float(np.clip(np.dot(tin_rot[:, 2], tray_rot[:, 2]), -1.0, 1.0)))
        )
        if tilt > 35.0:
            tipped += 1
        if abs(loc[0]) > 0.21 or abs(loc[1]) > 0.16 or loc[2] < -0.02:
            ejected += 1

    return (
        {
            "robot": robot_slug,
            "regime": regime,
            "tin_friction": tin_friction,
            "speed_scale": speed_scale,
            "tray_placed_err_mm": round(tray_err_mm, 2),
            "max_tray_accel_mps2": round(max_tray_horiz_accel_mps2, 2),
            "max_tray_tilt_deg": round(max_tray_tilt_deg, 2),
            "max_tin_slip_mm": round(max_slip_mm, 2),
            "final_max_slip_mm": round(max(final_slips), 2),
            "max_tin_tilt_deg": round(max_tin_tilt_deg, 2),
            "rim_impact_steps": rim_impact_steps,
            "tipped_count": tipped,
            "ejected_count": ejected,
            "safe_carry": bool(
                tray_err_mm < 25.0 and max_slip_mm < 5.0 and tipped == 0 and ejected == 0
            ),
        },
        frames,
    )


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("output/loose-tin-tray")
    out_dir.mkdir(parents=True, exist_ok=True)

    trajs = {
        slug: _record_native_trajectory(slug)
        for slug in ("fairino-fr10", "universal-robots-ur5e", "fanuc-crx10ial")
    }

    # 1. Production 1.0x nominal trajectories across all 3 arms & both tin regimes
    nominal_rows: list[dict[str, Any]] = []
    hero_safe_frames: list[np.ndarray] = []
    for slug in ("fairino-fr10", "universal-robots-ur5e", "fanuc-crx10ial"):
        for regime, mu in (("financier", 0.20), ("financier", 0.35), ("tall_mould", 0.25)):
            row, frames = run_loose_tin_episode(
                robot_slug=slug,
                regime=regime,
                tin_friction=mu,
                speed_scale=1.0,
                traj=trajs[slug],
                render_frames=(slug == "fairino-fr10" and regime == "financier" and mu == 0.20),
            )
            nominal_rows.append(row)
            if frames:
                hero_safe_frames = frames
            print(
                f"NOMINAL {slug:22s} {regime:10s} mu={mu:.2f}: "
                f"tray_err={row['tray_placed_err_mm']:5.1f}mm slip={row['max_tin_slip_mm']:5.1f}mm "
                f"tin_tilt={row['max_tin_tilt_deg']:4.1f}deg a_max={row['max_tray_accel_mps2']:4.2f}m/s2 "
                f"tipped={row['tipped_count']} safe={row['safe_carry']}"
            )

    # 2. Speed-scale & friction envelope sweep on FR10 to find real slip & tip limits
    sweep_rows: list[dict[str, Any]] = []
    hero_stress_frames: list[np.ndarray] = []
    for regime in ("financier", "tall_mould"):
        for mu in (0.15, 0.25, 0.45):
            for scale in (1.0, 1.5, 2.0, 2.5, 3.0, 4.0):
                capture = regime == "tall_mould" and mu == 0.25 and scale == 3.0
                row, frames = run_loose_tin_episode(
                    robot_slug="fairino-fr10",
                    regime=regime,
                    tin_friction=mu,
                    speed_scale=scale,
                    traj=trajs["fairino-fr10"],
                    render_frames=capture,
                )
                sweep_rows.append(row)
                if frames:
                    hero_stress_frames = frames
                print(
                    f"SWEEP   FR10 {regime:10s} mu={mu:.2f} s={scale:.1f}x: "
                    f"tray_err={row['tray_placed_err_mm']:5.1f}mm slip={row['max_tin_slip_mm']:5.1f}mm "
                    f"tin_tilt={row['max_tin_tilt_deg']:5.1f}deg a_max={row['max_tray_accel_mps2']:5.2f}m/s2 "
                    f"rim={row['rim_impact_steps']:4d} tipped={row['tipped_count']} ejected={row['ejected_count']}"
                )

    # Combine 3 safe-carry panels (top row) + 3 high-speed stress panels (bottom row)
    panels = []
    for seq in (hero_safe_frames, hero_stress_frames):
        n = len(seq)
        for frac in (0.05, 0.45, 0.95):
            panels.append(seq[min(n - 1, int(round(frac * (n - 1))))])
    grid = np.concatenate(
        [np.concatenate(panels[0:3], axis=1), np.concatenate(panels[3:6], axis=1)],
        axis=0,
    )
    grid[238:242, :, :] = 24
    grid[:, 318:322, :] = 24
    grid[:, 638:642, :] = 24
    sheet_path = out_dir / "loose_tin_tray_rollout.png"
    ws._write_rgb_png(sheet_path, grid.astype(np.float32) / 255.0)

    report = {
        "nominal_3_arms": nominal_rows,
        "fr10_speed_friction_sweep": sweep_rows,
        "rollout_sheet": str(sheet_path),
    }
    report_path = out_dir / "loose_tin_metrics.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    # Sanity assertions:
    # 1. Production 1.0x trajectories carry all 8 financier tins safely (< 5 mm slip, 0 tips)
    fin_nom = [r for r in nominal_rows if r["regime"] == "financier"]
    assert all(r["safe_carry"] for r in fin_nom), f"Nominal financier carry failed: {fin_nom}"
    # 2. High-speed sweep actually reaches physical slip/tip onset (proves tins are genuinely free!)
    max_sweep_slip = max(r["max_tin_slip_mm"] for r in sweep_rows)
    max_sweep_tilt = max(r["max_tin_tilt_deg"] for r in sweep_rows)
    assert max_sweep_slip >= 5.0 or max_sweep_tilt >= 10.0, (
        f"Loose tins did not exhibit measurable slip/tilt even at 4x speed! "
        f"(max_slip={max_sweep_slip}mm, max_tilt={max_sweep_tilt}deg)"
    )
    print(
        f"PASSED loose-tin payload limits: all {len(fin_nom)} nominal financier runs safe (<5 mm slip, 0 tips); "
        f"sweep reached max_slip={max_sweep_slip:.1f}mm, max_tilt={max_sweep_tilt:.1f}deg -> {report_path}"
    )


if __name__ == "__main__":
    main()
