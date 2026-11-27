"""Verify the coupled two-arm FR10 + Maruzen MBCO-4ME bake cell (Plan 24).

Runs three coupled MuJoCo 4.0.0 rollouts in one shared collision space:
1. Overlapped pipelined swap: cobot-2 unloads `tray_baked_` from Rail #2 onto the
   cooling rack while cobot-1 simultaneously picks `tray_fresh_` from the cold table,
   holds at the mouth interlock until cobot-2 clears, then loads `tray_fresh_` onto Rail #2.
2. Sequential baseline: cobot-2 completes unload + rack before cobot-1 starts load.
3. Interlock-off negative safety control: both arms enter Rail #2 together, proving
   shared MuJoCo collision space detects real arm-to-arm / tray-to-tray contact.

Usage:
  uv run --python 3.11 --with-requirements scripts/bakery-robots/requirements-physics.txt \
    python scripts/bakery-robots/verify_two_arm_cell.py <output_dir>
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import mujoco
import numpy as np

ROBOTS_DIR = Path(__file__).resolve().parent
STUDIO_DIR = ROBOTS_DIR.parent / "bakery-mujoco/studio_workcell"
for _p in (str(ROBOTS_DIR), str(STUDIO_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import workcell_scene as ws  # noqa: E402
from two_arm_workcell import (  # noqa: E402
    BAKED_TRAY_RAIL2_POS,
    COOLING_RACK_POS,
    COOLING_RACK_Z,
    FRESH_TRAY_POS,
    SPANNER_GRASP_OFFSET,
    SPANNER_OPEN_M,
    CoupledArmRig,
    LegRunner,
    PhaseLeg,
    compose_two_arm_oven_cell,
)


def _solve_standby_q(rig: CoupledArmRig, target: np.ndarray, seed: np.ndarray) -> np.ndarray:
    """Find a clean collision-free standby configuration at `target`."""
    candidates = [seed]
    for j1 in (-2.2, -1.6, -1.1, -0.55, 0.0, 0.55, 1.1, 1.6, 2.2):
        candidates.append(np.array([j1, -1.25, 1.85, -0.60, 1.57 + j1, 1.57]))
        candidates.append(np.array([j1, -1.25, 1.85, -0.60, 1.57 - j1, 1.57]))
    for cand in candidates:
        try:
            q = rig.solve_ik(target, cand, iters=400)
            if abs(q[2]) > 0.35:
                return q
        except RuntimeError:
            continue
    raise RuntimeError(f"Could not solve standby IK for {rig.prefix} at {target.tolist()}")


def _min_group_distance_mm(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    geoms_a: list[int],
    geoms_b: list[int],
    distmax: float = 0.50,
) -> float:
    best = distmax
    for ga in geoms_a:
        for gb in geoms_b:
            d = mujoco.mj_geomDistance(model, data, ga, gb, distmax, None)
            if d < best:
                best = d
    return float(best * 1000.0)


def _tray_error(
    model: mujoco.MjModel, data: mujoco.MjData, tray_body: str, target_xyz: np.ndarray
) -> dict[str, float]:
    bid = model.body(tray_body).id
    pos = data.xpos[bid]
    quat = data.xquat[bid]
    up = np.zeros(3)
    mujoco.mju_rotVecQuat(up, np.array([0.0, 0.0, 1.0]), quat)
    tilt_deg = math.degrees(math.acos(float(np.clip(up[2], -1.0, 1.0))))
    err_mm = float(np.linalg.norm(pos - target_xyz) * 1000.0)
    return {
        "pos_err_mm": round(err_mm, 2),
        "tilt_deg": round(tilt_deg, 2),
        "final_xyz": [round(float(v), 4) for v in pos],
    }


def _build_legs(mode: str) -> tuple[list[PhaseLeg], list[PhaseLeg], np.ndarray, np.ndarray]:
    """Return `(cobot1_legs, cobot2_legs, cobot1_standby_xyz, cobot2_standby_xyz)`."""
    fresh_src = np.array(FRESH_TRAY_POS, dtype=np.float64)
    rail2_dest = np.array(BAKED_TRAY_RAIL2_POS, dtype=np.float64)
    rack_dest = np.array([COOLING_RACK_POS[0], COOLING_RACK_POS[1], COOLING_RACK_Z + 0.0005], dtype=np.float64)

    fresh_grasp = fresh_src + np.array([0.0, 0.0, 0.011])
    rail2_grip = rail2_dest + SPANNER_GRASP_OFFSET
    rack_grip = rack_dest + SPANNER_GRASP_OFFSET
    slide_z = max(rail2_dest[2] + 0.042, fresh_src[2] + 0.30)

    c1_standby = np.array([fresh_src[0], fresh_src[1], fresh_src[2] + 0.24])
    c2_standby = np.array([rack_dest[0], rack_dest[1], slide_z])
    c1_stage = np.array([0.34, -0.56, slide_z])

    # cobot-2: Oven Rail #2 -> Cooling Rack (`tray_baked_`)
    c2_mouth_enter = np.array([rail2_grip[0], rail2_grip[1] - 0.48, rail2_grip[2] + 0.049])
    c2_enter = np.array([rail2_grip[0], rail2_grip[1], rail2_grip[2] + 0.049])
    c2_seat = np.array([rail2_grip[0], rail2_grip[1], rail2_grip[2]])
    c2_lift = np.array([rail2_grip[0], rail2_grip[1], slide_z])
    # Extract past y = -0.82 before sweeping -X so tray_baked clears the open door tip (> 50 mm)
    c2_extract = np.array([rail2_grip[0], -0.82, slide_z])
    c2_clear = np.array([-0.96, -1.16, slide_z])
    c2_over_rack = np.array([rack_grip[0], rack_grip[1], slide_z])
    c2_place = rack_grip + np.array([0.0, 0.0, 0.004])
    c2_clear_rear = c2_place + np.array([0.0, 0.004, 0.0])
    c2_retract = c2_clear_rear + np.array([0.0, 0.0, 0.16])

    cobot2_legs = [
        PhaseLeg("c2_settle", c2_standby, 0.4, False, False),
        PhaseLeg("c2_to_clear", c2_clear, 2.0, False, False),
        PhaseLeg("c2_to_mouth", c2_mouth_enter, 2.0, False, False),
        PhaseLeg("c2_enter_oven", c2_enter, 2.2, False, False),
        PhaseLeg("c2_seat", c2_seat, 1.5, False, False),
        PhaseLeg("c2_grasp", c2_seat, 0.8, True, False),
        PhaseLeg("c2_hold", c2_seat, 0.4, True, False),
        PhaseLeg("c2_lift", c2_lift, 1.2, True, True),
        PhaseLeg("c2_extract", c2_extract, 2.4, True, True),
        PhaseLeg("c2_clear_mouth", c2_clear, 2.2, True, True),
        PhaseLeg("c2_over_rack", c2_over_rack, 2.2, True, True),
        PhaseLeg("c2_place", c2_place, 2.0, True, True),
        PhaseLeg("c2_release", c2_place, 0.8, False, False),
        PhaseLeg("c2_clear_rear", c2_clear_rear, 0.6, False, False),
        PhaseLeg("c2_retract", c2_retract, 1.5, False, False),
        PhaseLeg("c2_settled", c2_retract, 1.2, False, False),
    ]

    # cobot-1: Cold Table -> Oven Rail #2 (`tray_fresh_`)
    c1_approach = fresh_src + np.array([0.0, 0.0, 0.16])
    c1_lifted = np.array([fresh_grasp[0], fresh_grasp[1], slide_z])
    c1_mouth = np.array([rail2_grip[0], rail2_grip[1] - 0.48, slide_z])
    c1_insert = np.array([rail2_grip[0], rail2_grip[1], slide_z])
    c1_place = rail2_grip + np.array([0.0, 0.0, 0.004])
    c1_clear_rear = c1_place + np.array([0.0, 0.004, 0.0])
    c1_lift_clear = c1_clear_rear + np.array([0.0, 0.0, 0.049])
    c1_mouth_out = np.array([rail2_grip[0], rail2_grip[1] - 0.48, c1_lift_clear[2]])

    wait_before_start = mode == "sequential"
    wait_at_mouth = mode == "overlapped"
    cobot1_legs = [
        PhaseLeg("c1_settle", c1_standby, 0.4, False, False, wait_for_mouth=wait_before_start),
        PhaseLeg("c1_approach", c1_approach, 1.2, False, False),
        PhaseLeg("c1_seat", fresh_grasp, 2.0, False, False),
        PhaseLeg("c1_grasp", fresh_grasp, 0.8, True, False),
        PhaseLeg("c1_hold", fresh_grasp, 0.4, True, False),
        PhaseLeg("c1_lift", c1_lifted, 2.0, True, True),
        PhaseLeg("c1_stage", c1_stage, 2.0, True, True),
        PhaseLeg("c1_align_oven", c1_mouth, 2.4, True, True, wait_for_mouth=wait_at_mouth),
        PhaseLeg("c1_insert_oven", c1_insert, 2.6, True, True),
        PhaseLeg("c1_place", c1_place, 1.5, True, True),
        PhaseLeg("c1_release", c1_place, 0.8, False, False),
        PhaseLeg("c1_clear_rear", c1_clear_rear, 0.6, False, False),
        PhaseLeg("c1_lift_clear", c1_lift_clear, 1.2, False, False),
        PhaseLeg("c1_out", c1_mouth_out, 2.2, False, False),
        PhaseLeg("c1_return_stage", c1_stage, 2.0, False, False),
        PhaseLeg("c1_settled", c1_stage, 1.2, False, False),
    ]
    return cobot1_legs, cobot2_legs, c1_standby, c2_standby


def run_coupled_scenario(
    mode: str,
    *,
    render_frames: bool = False,
) -> tuple[dict[str, Any], list[np.ndarray], list[np.ndarray]]:
    """Simulate one coupled two-arm scenario (`overlapped`, `sequential`, `conflict`)."""
    spec = compose_two_arm_oven_cell(door_angle_rad=1.90)
    model = spec.compile()
    data = mujoco.MjData(model)
    dt = float(model.opt.timestep)

    rig1 = CoupledArmRig(model, "cobot1_")
    rig2 = CoupledArmRig(model, "cobot2_")
    c1_legs, c2_legs, c1_standby, c2_standby = _build_legs(mode)

    q1_init = _solve_standby_q(rig1, c1_standby, np.array(ws.FR10_HOME_Q, dtype=np.float64))
    q2_init = _solve_standby_q(rig2, c2_standby, np.array([0.85, -1.25, 1.85, -0.60, 2.42, 1.57]))

    # Initialize both arms, both grippers, and both free trays
    for i, a in enumerate(rig1.qadrs):
        data.qpos[a] = q1_init[i]
    for i, a in enumerate(rig2.qadrs):
        data.qpos[a] = q2_init[i]
    data.qpos[rig1.jaw_qadr] = SPANNER_OPEN_M
    data.qpos[rig2.jaw_qadr] = SPANNER_OPEN_M

    tf_adr = int(model.jnt_qposadr[model.joint("tray_fresh_mbco_tray_free").id])
    tb_adr = int(model.jnt_qposadr[model.joint("tray_baked_mbco_tray_free").id])
    data.qpos[tf_adr : tf_adr + 3] = FRESH_TRAY_POS
    data.qpos[tf_adr + 3 : tf_adr + 7] = [1.0, 0.0, 0.0, 0.0]
    data.qpos[tb_adr : tb_adr + 3] = BAKED_TRAY_RAIL2_POS
    data.qpos[tb_adr + 3 : tb_adr + 7] = [1.0, 0.0, 0.0, 0.0]
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)

    runner1 = LegRunner(rig1, q1_init, c1_legs, dt)
    runner2 = LegRunner(rig2, q2_init, c2_legs, dt)

    tray_fresh_geoms = [
        g for g in range(model.ngeom) if model.geom(g).name.startswith("tray_fresh_") and model.geom_contype[g] != 0
    ]
    tray_baked_geoms = [
        g for g in range(model.ngeom) if model.geom(g).name.startswith("tray_baked_") and model.geom_contype[g] != 0
    ]
    door_geoms = [
        g for g in range(model.ngeom) if "mbco4_door" in model.geom(g).name or "mbco4_handle" in model.geom(g).name
    ]
    c1_set = set(rig1.geom_ids)
    c2_set = set(rig2.geom_ids)
    tf_set = set(tray_fresh_geoms)
    tb_set = set(tray_baked_geoms)
    door_set = set(door_geoms)

    renderer = mujoco.Renderer(model, height=240, width=320) if render_frames else None
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = 1
    frames_hero: list[np.ndarray] = []
    frames_top: list[np.ndarray] = []

    min_arm_arm_mm = 500.0
    min_c1_door_mm = 500.0
    min_c2_door_mm = 500.0
    min_tray_tray_mm = 500.0
    arm_arm_contacts = 0
    tray_tray_contacts = 0
    door_contacts = 0
    max_arm_contact_n = 0.0
    c2_cleared_mouth_s: float | None = None

    max_steps = int(round(60.0 / dt))
    c_force = np.zeros(6, dtype=np.float64)
    step = 0
    while step < max_steps and not (runner1.done and runner2.done):
        c2_grasp_xyz = data.site_xpos[rig2.grasp_site]
        if mode == "overlapped":
            # Mouth unlocks once cobot-2 has extracted tray_baked past x < -0.82 and y < -1.05
            if c2_cleared_mouth_s is None and runner2.leg_idx >= 10 and c2_grasp_xyz[0] < -0.82 and c2_grasp_xyz[1] < -1.05:
                c2_cleared_mouth_s = step * dt
            mouth_free = c2_cleared_mouth_s is not None
        elif mode == "sequential":
            mouth_free = runner2.done
        else:
            # Conflict negative control: mouth interlock disabled!
            mouth_free = True

        q1_cmd, jaw1, carry1 = runner1.step(mouth_free=mouth_free)
        q2_cmd, jaw2, carry2 = runner2.step(mouth_free=True)

        q1_meas = np.array([data.qpos[a] for a in rig1.qadrs], dtype=np.float64)
        q2_meas = np.array([data.qpos[a] for a in rig2.qadrs], dtype=np.float64)
        ctrl1 = rig1.servo_ctrl(q1_meas, q1_cmd, carry1)
        ctrl2 = rig2.servo_ctrl(q2_meas, q2_cmd, carry2)
        for i, aid in enumerate(rig1.act_ids):
            data.ctrl[aid] = ctrl1[i]
        for i, aid in enumerate(rig2.act_ids):
            data.ctrl[aid] = ctrl2[i]
        data.ctrl[rig1.jaw_act] = jaw1
        data.ctrl[rig2.jaw_act] = jaw2

        mujoco.mj_step(model, data)

        # Contact auditing every step
        for k in range(data.ncon):
            con = data.contact[k]
            g1, g2 = int(con.geom1), int(con.geom2)
            pair_a_b = ((g1 in c1_set or g1 in tf_set) and (g2 in c2_set or g2 in tb_set)) or (
                (g2 in c1_set or g2 in tf_set) and (g1 in c2_set or g1 in tb_set)
            )
            if pair_a_b and con.dist < 0.0:
                mujoco.mj_contactForce(model, data, k, c_force)
                fn = float(np.linalg.norm(c_force[:3]))
                max_arm_contact_n = max(max_arm_contact_n, fn)
                if (g1 in tf_set and g2 in tb_set) or (g2 in tf_set and g1 in tb_set):
                    tray_tray_contacts += 1
                else:
                    arm_arm_contacts += 1
            if ((g1 in c1_set or g1 in c2_set or g1 in tf_set or g1 in tb_set) and g2 in door_set) or (
                (g2 in c1_set or g2 in c2_set or g2 in tf_set or g2 in tb_set) and g1 in door_set
            ):
                if con.dist < 0.0:
                    door_contacts += 1

        # Exact geometric clearance audit every 20 ms (10 physics steps)
        if step % 10 == 0:
            min_arm_arm_mm = min(
                min_arm_arm_mm,
                _min_group_distance_mm(
                    model, data, rig1.geom_ids + tray_fresh_geoms, rig2.geom_ids + tray_baked_geoms
                ),
            )
            min_c1_door_mm = min(
                min_c1_door_mm,
                _min_group_distance_mm(model, data, rig1.geom_ids + tray_fresh_geoms, door_geoms),
            )
            min_c2_door_mm = min(
                min_c2_door_mm,
                _min_group_distance_mm(model, data, rig2.geom_ids + tray_baked_geoms, door_geoms),
            )
            min_tray_tray_mm = min(
                min_tray_tray_mm,
                _min_group_distance_mm(model, data, tray_fresh_geoms, tray_baked_geoms),
            )

        if renderer is not None and step % 125 == 0:
            renderer.update_scene(data, camera="two_arm_hero", scene_option=opt)
            frames_hero.append(renderer.render().copy())
            renderer.update_scene(data, camera="two_arm_top", scene_option=opt)
            frames_top.append(renderer.render().copy())

        step += 1

    if renderer is not None:
        renderer.update_scene(data, camera="two_arm_hero", scene_option=opt)
        frames_hero.append(renderer.render().copy())
        renderer.update_scene(data, camera="two_arm_top", scene_option=opt)
        frames_top.append(renderer.render().copy())
        renderer.close()

    rack_target = np.array([COOLING_RACK_POS[0], COOLING_RACK_POS[1], COOLING_RACK_Z + 0.0005])
    rail2_target = np.array(BAKED_TRAY_RAIL2_POS)
    metrics = {
        "mode": mode,
        "cycle_seconds": round(step * dt, 2),
        "c1_interlock_wait_s": round(runner1.waiting_steps * dt, 2),
        "c2_cleared_mouth_s": round(c2_cleared_mouth_s, 2) if c2_cleared_mouth_s is not None else None,
        "min_arm_to_arm_mm": round(min_arm_arm_mm, 1),
        "min_cobot1_to_door_mm": round(min_c1_door_mm, 1),
        "min_cobot2_to_door_mm": round(min_c2_door_mm, 1),
        "min_tray_to_tray_mm": round(min_tray_tray_mm, 1),
        "arm_to_arm_contacts": arm_arm_contacts,
        "tray_to_tray_contacts": tray_tray_contacts,
        "door_contacts": door_contacts,
        "max_inter_arm_contact_n": round(max_arm_contact_n, 1),
        "tray_baked_at_rack": _tray_error(model, data, "tray_baked_mbco_tray", rack_target),
        "tray_fresh_at_rail2": _tray_error(model, data, "tray_fresh_mbco_tray", rail2_target),
    }
    return metrics, frames_hero, frames_top


def _save_contact_sheet(
    frames_hero: list[np.ndarray], frames_top: list[np.ndarray], out_png: Path
) -> None:
    n = len(frames_hero)
    fracs = (0.0, 0.20, 0.38, 0.54, 0.76, 1.0)
    use_top = (False, True, False, True, False, True)
    panels = []
    for frac, top in zip(fracs, use_top):
        idx = min(n - 1, int(round(frac * (n - 1))))
        panels.append(frames_top[idx] if top else frames_hero[idx])
    grid = np.concatenate(
        [np.concatenate(panels[0:3], axis=1), np.concatenate(panels[3:6], axis=1)],
        axis=0,
    )
    grid[238:242, :, :] = 24
    grid[:, 318:322, :] = 24
    grid[:, 638:642, :] = 24
    ws._write_rgb_png(out_png, grid.astype(np.float32) / 255.0)


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("output/two-arm-cell")
    out_dir.mkdir(parents=True, exist_ok=True)

    overlapped, frames_hero, frames_top = run_coupled_scenario("overlapped", render_frames=True)
    sequential, _, _ = run_coupled_scenario("sequential", render_frames=False)
    conflict, _, _ = run_coupled_scenario("conflict", render_frames=False)

    saved_s = round(sequential["cycle_seconds"] - overlapped["cycle_seconds"], 2)
    speedup_pct = round(100.0 * saved_s / max(1e-6, sequential["cycle_seconds"]), 1)

    sheet_path = out_dir / "two_arm_bake_swap_rollout.png"
    _save_contact_sheet(frames_hero, frames_top, sheet_path)

    report = {
        "overlapped": overlapped,
        "sequential": sequential,
        "conflict_negative_control": conflict,
        "cycle_time_saved_s": saved_s,
        "throughput_gain_pct": speedup_pct,
        "rollout_sheet": str(sheet_path),
    }
    report_path = out_dir / "two_arm_metrics.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))

    # Hard verification assertions
    assert overlapped["arm_to_arm_contacts"] == 0, f"Overlapped arm collision: {overlapped}"
    assert overlapped["tray_to_tray_contacts"] == 0, f"Overlapped tray collision: {overlapped}"
    assert overlapped["door_contacts"] == 0, f"Overlapped door collision: {overlapped}"
    assert overlapped["min_arm_to_arm_mm"] >= 20.0, f"Arm clearance too small: {overlapped}"
    assert overlapped["min_cobot2_to_door_mm"] >= 15.0, f"Door clearance too small: {overlapped}"
    assert overlapped["tray_baked_at_rack"]["pos_err_mm"] < 10.0, f"Baked tray placement error: {overlapped}"
    assert overlapped["tray_fresh_at_rail2"]["pos_err_mm"] < 10.0, f"Fresh tray placement error: {overlapped}"
    assert saved_s > 8.0, f"Expected meaningful overlap savings (>8 s), got {saved_s} s"
    assert (
        conflict["arm_to_arm_contacts"] + conflict["tray_to_tray_contacts"] > 0
        or conflict["min_arm_to_arm_mm"] <= 0.0
    ), f"Negative control failed: shared collision space did not detect interlock-off conflict! {conflict}"
    print(
        f"PASSED coupled two-arm MBCO-4ME bake cell: overlapped={overlapped['cycle_seconds']}s "
        f"vs sequential={sequential['cycle_seconds']}s (saved {saved_s}s / {speedup_pct}%), "
        f"min_arm_arm={overlapped['min_arm_to_arm_mm']}mm, min_door={min(overlapped['min_cobot1_to_door_mm'], overlapped['min_cobot2_to_door_mm'])}mm"
    )


if __name__ == "__main__":
    main()
