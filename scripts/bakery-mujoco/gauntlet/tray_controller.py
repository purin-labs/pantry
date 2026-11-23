"""Unprivileged RGB-D + DLS IK contact-based controller for FR10 baking tray pickup & Rail #2 insertion.

Variants:
- `v0`: Nominal open-loop baseline (no vision adaptation for T2 shifts, no T3 recovery,
  no T4 fault detection).
- `v1`: Closed-loop RGB-D tray & oven localization, T3 push/slip re-perception & re-grasp
  recovery, and T4 `camera_freeze` / `dead_gripper` safe-abort detectors.
- `v2`: Adds unprivileged eye-to-hand overhead-depth spanner-beam self-localization at
  prep-table hover and oven-mouth alignment, compensating combined robot-base Z offset,
  base tilt (Z and lateral X), servo droop, and gravity-comp error to <0.5 mm.

Reads ONLY deployment-allowlisted keys (`joint_position/*`, `overhead_cam`,
`overhead_cam_depth`, `overhead_cam_timestamp`). Zero privileged state access.
"""

from __future__ import annotations

import math
import pathlib
import sys
from collections.abc import Mapping
from typing import Any

import mujoco
import numpy as np

GAUNTLET_DIR = pathlib.Path(__file__).resolve().parent
STUDIO_DIR = GAUNTLET_DIR.parent / 'studio_workcell'
for _p in (str(GAUNTLET_DIR), str(STUDIO_DIR)):
  if _p not in sys.path:
    sys.path.insert(0, _p)

import workcell_scene as ws  # noqa: E402


class _AbortEpisode(Exception):
  def __init__(self, fault: str):
    super().__init__(fault)
    self.fault = fault


class BakeryTrayController:
  """Callable `robosim_gauntlet` controller for `fr10_mbco4_rail2_insert`."""

  def __init__(self, variant: str = 'v2'):
    if variant not in ('v0', 'v1', 'v2'):
      raise ValueError(f'Unknown variant {variant!r}; expected "v0", "v1", or "v2".')
    self.variant = variant
    self._use_vision = variant in ('v1', 'v2')
    self._use_ee_depth_cal = variant == 'v2'
    # Build nominal kinematic-only MuJoCo model once (pure CAD kinematics, zero sim state!)
    spec = ws.build_workcell_spec(for_gauntlet=True, pastry_load=False)
    self._kin_model = spec.compile()
    self._arm_jids = [
        mujoco.mj_name2id(self._kin_model, mujoco.mjtObj.mjOBJ_JOINT, f'arm/fairino-fr10__j{i}')
        for i in range(1, 7)
    ]
    self._grasp_sid = mujoco.mj_name2id(
        self._kin_model, mujoco.mjtObj.mjOBJ_SITE, 'arm/grip/cell_grasp'
    )
    self._cam_id = mujoco.mj_name2id(
        self._kin_model, mujoco.mjtObj.mjOBJ_CAMERA, 'overhead_cam'
    )
    self._cam_pos_nom = np.asarray(self._kin_model.cam_pos[self._cam_id], dtype=np.float64)
    self._cam_fovy_rad = math.radians(float(self._kin_model.cam_fovy[self._cam_id]))
    # Nominal oven roof center in T0 (calibrated from Maruzen MBCO-4ME roof above open door)
    self._nom_oven_roof = np.array([-0.4001, 0.1400, 1.4300], dtype=np.float64)
    self._nom_table_corner = np.array(
        [ws.PREP_TABLE_POS[0] - 0.52, ws.PREP_TABLE_POS[1] - 0.38], dtype=np.float64
    )

  # --- Helpers for unprivileged measurements & commands ---

  @staticmethod
  def _read_q(meas: Mapping[str, Any]) -> tuple[np.ndarray, float]:
    q = np.array([float(meas[f'joint_position/j{i}']) for i in range(1, 7)], dtype=np.float64)
    g = float(meas['joint_position/gripper'])
    return q, g

  @staticmethod
  def _make_cmd(q: np.ndarray, g: float) -> dict[str, np.float32]:
    cmd = {f'goal_position/j{i}': np.float32(q[i - 1]) for i in range(1, 7)}
    cmd['goal_position/gripper'] = np.float32(g)
    return cmd

  def _ik(self, q_seed: np.ndarray, target_pos: np.ndarray, yaw_rad: float = 0.0) -> np.ndarray:
    q, _, _ = ws.solve_spanner_ik(
        self._kin_model, self._arm_jids, self._grasp_sid, q_seed, target_pos, yaw_rad, iters=120
    )
    return q

  # --- Unprivileged RGB-D perception ---

  def _deproject(self, depth: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    h_px, w_px = depth.shape
    fy = 0.5 * h_px / math.tan(0.5 * self._cam_fovy_rad)
    fx = fy
    cx, cy = (w_px - 1) * 0.5, (h_px - 1) * 0.5
    u, v = np.meshgrid(np.arange(w_px, dtype=np.float64), np.arange(h_px, dtype=np.float64))
    d = np.asarray(depth, dtype=np.float64)
    valid = np.isfinite(d) & (d > 0.4) & (d < 2.4)
    xw = self._cam_pos_nom[0] + (u - cx) / fx * d
    yw = self._cam_pos_nom[1] - (v - cy) / fy * d
    zw = self._cam_pos_nom[2] - d
    return xw, yw, zw, valid

  def _calibrate_camera_xy(
      self, xw: np.ndarray, yw: np.ndarray, zw: np.ndarray, valid: np.ndarray
  ) -> tuple[float, float, np.ndarray]:
    """Fit static prep-table plane; its slope (ax, ay) measures camera tilt directly (zero bias on T0-T3)."""
    roi = valid & (xw > 0.10) & (xw < 0.78) & (yw > -0.48) & (yw < 0.12) & (zw > 0.78) & (zw < 0.94)
    if np.count_nonzero(roi) < 100:
      return 0.0, 0.0, np.array([0.0, 0.0, ws.PREP_TABLE_TOP_Z], dtype=np.float64)
    z_cut = float(np.percentile(zw[roi], 45))
    tbl = roi & (zw <= z_cut + 0.003)
    A = np.column_stack([xw[tbl], yw[tbl], np.ones(np.count_nonzero(tbl))])
    coef, *_ = np.linalg.lstsq(A, zw[tbl], rcond=None)
    # Only apply tilt compensation when plane slope exceeds flat noise floor (> 0.002 rad)
    ax = float(coef[0]) if abs(float(coef[0])) > 0.002 else 0.0
    ay = float(coef[1]) if abs(float(coef[1])) > 0.002 else 0.0
    return ax, ay, coef

  def _perceive_tray(
      self, depth: np.ndarray, cam_cal: tuple[float, float, np.ndarray] | None = None
  ) -> tuple[float, float, float, float] | None:
    """Detect prep-table baking tray `(cx, cy, z_table_at_tray, yaw_rad)` from overhead depth."""
    xw, yw, zw, valid = self._deproject(depth)
    if cam_cal is None:
      ax, ay, coef = self._calibrate_camera_xy(xw, yw, zw, valid)
    else:
      ax, ay, coef = cam_cal
    d_tbl = float(self._cam_pos_nom[2] - ws.PREP_TABLE_TOP_Z)
    dx_cam = float(np.clip(-ax * d_tbl, -0.025, 0.025))
    dy_cam = float(np.clip(-ay * d_tbl, -0.025, 0.025))
    z_plane = coef[0] * xw + coef[1] * yw + coef[2]
    h = zw - z_plane
    # 1. Symmetric 3x2 croissant tops (h in [0.022, 0.046] strictly above 20 mm thin rims!)
    #    Zero thin-rim perspective bias -> sub-2 mm centroid accuracy under T2 noise/dropout!
    box_roi = (
        valid
        & (xw - dx_cam > 0.06)
        & (xw - dx_cam < 0.77)
        & (yw - dy_cam > -0.52)
        & (yw - dy_cam < 0.14)
    )
    cmask = box_roi & (h > 0.022) & (h < 0.046)
    if int(np.count_nonzero(cmask)) < 45:
      return None
    cx_pts = xw[cmask] - dx_cam
    cy_pts = yw[cmask] - dy_cam
    mx, my = float(np.median(cx_pts)), float(np.median(cy_pts))
    c_in = (np.abs(cx_pts - mx) < 0.22) & (np.abs(cy_pts - my) < 0.22)
    if int(np.count_nonzero(c_in)) < 40:
      return None
    cpts = np.column_stack([cx_pts[c_in], cy_pts[c_in]])
    center_xy = cpts.mean(axis=0)

    # 2. Full 400x300 mm tray silhouette (rims + croissants, h in [0.008, 0.046]) for <0.5 deg PCA yaw!
    rmask = box_roi & (h > 0.008) & (h < 0.046)
    rx = xw[rmask] - dx_cam
    ry = yw[rmask] - dy_cam
    r_in = (np.abs(rx - center_xy[0]) < 0.25) & (np.abs(ry - center_xy[1]) < 0.25)
    ypts = np.column_stack([rx[r_in], ry[r_in]]) if int(np.count_nonzero(r_in)) >= 60 else cpts
    ym = ypts.mean(axis=0)
    _, eigvecs = np.linalg.eigh(np.cov((ypts - ym).T))
    major = eigvecs[:, 1]
    if major[0] < 0.0:
      major = -major
    yaw = math.atan2(float(major[1]), float(major[0]))
    if yaw > math.pi / 2.0:
      yaw -= math.pi
    elif yaw < -math.pi / 2.0:
      yaw += math.pi

    z_tbl = float(coef[0] * (center_xy[0] + dx_cam) + coef[1] * (center_xy[1] + dy_cam) + coef[2])
    z_tbl = float(np.clip(z_tbl, ws.PREP_TABLE_TOP_Z - 0.03, ws.PREP_TABLE_TOP_Z + 0.03))
    return float(center_xy[0]), float(center_xy[1]), z_tbl, float(yaw)

  def _perceive_oven_rail2(
      self, depth: np.ndarray, cam_cal: tuple[float, float, np.ndarray]
  ) -> np.ndarray:
    """Locate oven Rail #2 3D world target `(x, y, z)` from oven roof strictly above open door."""
    ax, ay, _ = cam_cal
    d_roof = float(self._cam_pos_nom[2] - 1.430)
    dx_cam = float(np.clip(-ax * d_roof, -0.025, 0.025))
    dy_cam = float(np.clip(-ay * d_roof, -0.025, 0.025))
    xw, yw, zw, valid = self._deproject(depth)
    # Require zw > 1.422 m (strictly above 1.410 m open oven door!)
    roi = (
        valid
        & (xw > -0.92)
        & (xw < 0.08)
        & (yw > -0.32)
        & (yw < 0.65)
        & (zw > 1.422)
        & (zw < 1.56)
    )
    if np.count_nonzero(roi) < 100:
      return np.array(ws.OVEN_RAIL2_WORLD, dtype=np.float64)
    z_med = float(np.median(zw[roi]))
    roof = roi & (np.abs(zw - z_med) < 0.015)
    ox, oy, oz = xw[roof] - dx_cam, yw[roof] - dy_cam, zw[roof]
    ocx = 0.5 * (float(np.percentile(ox, 2.0)) + float(np.percentile(ox, 98.0)))
    ocy = 0.5 * (float(np.percentile(oy, 2.0)) + float(np.percentile(oy, 98.0)))
    ocz = float(np.median(oz))
    delta = np.array([ocx, ocy, ocz], dtype=np.float64) - self._nom_oven_roof
    # Clamp to physical perturbation bounds (±5 cm XY, ±3 cm Z)
    delta[:2] = np.clip(delta[:2], -0.05, 0.05)
    delta[2] = float(np.clip(delta[2], -0.03, 0.03))
    return np.array(ws.OVEN_RAIL2_WORLD, dtype=np.float64) + delta

  def _measure_ee_z_offset(
      self,
      depth: np.ndarray,
      target_xy: tuple[float, float],
      q_cmd: np.ndarray,
      cam_cal: tuple[float, float, np.ndarray] | None,
      *,
      yaw_rad: float = 0.0,
  ) -> float:
    """Measure real-vs-nominal end-effector Z offset from overhead depth on the spanner beam.

    Compensates combined robot-base Z offset (`table_dz_m`), base tilt (`table_tilt_deg`),
    servo droop (`gain_scale`), and gravity-comp residual (`gravcomp_delta`) to <0.5 mm
    using purely unprivileged `overhead_cam_depth` + nominal CAD kinematics.
    Samples only the rotated 48 mm-wide spanner beam strip ahead of the wrist flange so
    the FR10 forearm/wrist never biases the median at any tray yaw.
    """
    kd = mujoco.MjData(self._kin_model)
    for k, jid in enumerate(self._arm_jids):
      kd.qpos[self._kin_model.jnt_qposadr[jid]] = float(q_cmd[k])
    mujoco.mj_kinematics(self._kin_model, kd)
    z_site_fk = float(kd.site_xpos[self._grasp_sid][2])
    z_beam_fk = z_site_fk + (ws.SPANNER_DROP_Z - 0.010) + 0.009

    xw, yw, zw, valid = self._deproject(depth)
    if cam_cal is not None:
      ax, ay, _ = cam_cal
      d_beam = float(self._cam_pos_nom[2] - z_beam_fk)
      dx_cam = float(np.clip(-ax * d_beam, -0.025, 0.025))
      dy_cam = float(np.clip(-ay * d_beam, -0.025, 0.025))
    else:
      dx_cam = dy_cam = 0.0

    xc, yc = target_xy
    rx = (xw - dx_cam) - xc
    ry = (yw - dy_cam) - yc
    # Tool +X (along spanner beam from wrist toward rear blade) = (-sin(yaw), cos(yaw))
    # Tool -Y (across spanner beam width) = (cos(yaw), sin(yaw))
    sy, cy = math.sin(yaw_rad), math.cos(yaw_rad)
    u_along = -sy * rx + cy * ry
    u_perp = cy * rx + sy * ry
    roi = (
        valid
        & (np.abs(u_perp) < 0.024)
        & (u_along > -0.09)
        & (u_along < 0.14)
        & (zw > z_beam_fk - 0.050)
        & (zw < z_beam_fk + 0.050)
    )
    if int(np.count_nonzero(roi)) < 35:
      return 0.0
    z_beam_obs = float(np.median(zw[roi]))
    return float(np.clip(z_beam_obs - z_beam_fk, -0.045, 0.045))

  # --- Main execution loop ---

  def __call__(self, dl: Any) -> dict[str, Any]:
    meas = dl.begin_stepping()
    q_cur, g_cur = self._read_q(meas)

    # Runtime state for T4 fault monitors (used in v1/v2)
    state: dict[str, Any] = {
        'meas': meas,
        'tick': 0,
        'prev_ts': float(meas.get('overhead_cam_timestamp', 0.0)),
        'stale_ts_ticks': 0,
        'ref_rgb': np.array(meas['overhead_cam'], copy=True),
        'ref_q': q_cur.copy(),
        'same_rgb_ticks': 0,
        'g_hist': [g_cur],
        'cmd_q': q_cur.copy(),
        'cmd_g': g_cur,
    }

    def step_to(q_cmd: np.ndarray, g_cmd: float, *, check_grip: str = '') -> Mapping[str, Any]:
      m = dl.step(self._make_cmd(q_cmd, g_cmd))
      state['meas'] = m
      state['tick'] += 1
      state['cmd_q'] = q_cmd.copy()
      state['cmd_g'] = g_cmd
      q_now, g_now = self._read_q(m)
      state['g_hist'].append(g_now)
      if len(state['g_hist']) > 40:
        state['g_hist'].pop(0)

      if self._use_vision:
        # 1. T4 `camera_freeze` detector (works for both fault_restamp=False and fault_restamp=True!)
        ts = float(m.get('overhead_cam_timestamp', state['tick'] * 0.02))
        if ts <= state['prev_ts'] + 1e-9:
          state['stale_ts_ticks'] += 1
        else:
          state['stale_ts_ticks'] = 0
        state['prev_ts'] = ts

        rgb = np.asarray(m['overhead_cam'])
        if np.array_equal(rgb, state['ref_rgb']):
          state['same_rgb_ticks'] += 1
        else:
          state['ref_rgb'] = np.array(rgb, copy=True)
          state['ref_q'] = q_now.copy()
          state['same_rgb_ticks'] = 0

        arm_moved = float(np.max(np.abs(q_now - state['ref_q'])))
        if state['stale_ts_ticks'] >= 6:
          raise _AbortEpisode('camera_freeze')
        if state['same_rgb_ticks'] >= 12 and arm_moved > 0.055:
          raise _AbortEpisode('camera_freeze')

        # 2. T4 `dead_gripper` detector (checks actual joint response during close/open!)
        # Note: a slightly rotated tray can stop jaw_front near +0.015 m; a truly dead
        # gripper stays stuck near +0.045 m (> 0.034 m) during close or < 0.012 m during open!
        if check_grip == 'close' and len(state['g_hist']) >= 20:
          g_prev = state['g_hist'][-16]
          if g_now > 0.034 and abs(g_now - g_prev) < 0.0018:
            raise _AbortEpisode('dead_gripper')
        elif check_grip == 'open' and len(state['g_hist']) >= 20:
          g_prev = state['g_hist'][-16]
          if g_now < 0.012 and abs(g_now - g_prev) < 0.0018:
            raise _AbortEpisode('dead_gripper')
      return m

    def move_joints(
        q_target: np.ndarray,
        g_target: float,
        *,
        max_step_rad: float = 0.024,
        min_ticks: int = 10,
        settle_ticks: int = 4,
    ) -> None:
      q_start = state['cmd_q'].copy()
      g_start = float(state['cmd_g'])
      diff = q_target - q_start
      max_d = float(np.max(np.abs(diff)))
      n_steps = max(min_ticks, int(math.ceil(max_d / max_step_rad)))
      for i in range(1, n_steps + 1):
        # Minimum-jerk cosine ease-in / ease-out -> ultra-low acceleration & impact forces!
        s = 0.5 * (1.0 - math.cos(math.pi * i / n_steps))
        q_i = q_start + s * diff
        g_i = g_start + s * (g_target - g_start)
        step_to(q_i, g_i)
      for _ in range(settle_ticks):
        step_to(q_target, g_target)

    def move_cartesian(
        p_start: np.ndarray,
        p_end: np.ndarray,
        yaw_start: float,
        yaw_end: float,
        g_target: float,
        *,
        step_m: float = 0.010,
        max_step_rad: float = 0.020,
        settle_ticks: int = 4,
    ) -> None:
      dist = float(np.linalg.norm(p_end - p_start))
      n_wp = max(2, int(math.ceil(dist / step_m)))
      q_prev = state['cmd_q'].copy()
      for k in range(1, n_wp + 1):
        s = 0.5 * (1.0 - math.cos(math.pi * k / n_wp))
        p_k = p_start + s * (p_end - p_start)
        y_k = yaw_start + s * (yaw_end - yaw_start)
        q_k = self._ik(q_prev, p_k, y_k)
        # Sub-interpolate if joint step exceeds max_step_rad
        dq = q_k - q_prev
        sub = max(1, int(math.ceil(float(np.max(np.abs(dq))) / max_step_rad)))
        for j in range(1, sub + 1):
          step_to(q_prev + (j / sub) * dq, g_target)
        q_prev = q_k
      for _ in range(settle_ticks):
        step_to(q_prev, g_target)

    def actuate_gripper(g_target: float, *, ticks: int = 24, mode: str = '') -> None:
      q_hold = state['cmd_q'].copy()
      g_start = float(state['cmd_g'])
      for i in range(1, ticks + 1):
        s = i / ticks
        step_to(q_hold, g_start + s * (g_target - g_start))
      # Hold & monitor gripper response (catches T4 `dead_gripper`)
      for _ in range(18):
        step_to(q_hold, g_target, check_grip=mode)

    try:
      # --- Stage 0: Initial perception (v1/v2) or nominal targets (v0) ---
      if self._use_vision:
        xw0, yw0, zw0, val0 = self._deproject(meas['overhead_cam_depth'])
        cam_cal = self._calibrate_camera_xy(xw0, yw0, zw0, val0)
        tray_obs = self._perceive_tray(meas['overhead_cam_depth'], cam_cal)
        if tray_obs is None:
          tx, ty, tz, tyaw = (*ws.PREP_TRAY_WORLD, 0.0)
        else:
          tx, ty, tz, tyaw = tray_obs
        rail2_target = self._perceive_oven_rail2(meas['overhead_cam_depth'], cam_cal)
      else:
        cam_cal = None
        tx, ty, tz, tyaw = ws.PREP_TRAY_WORLD[0], ws.PREP_TRAY_WORLD[1], ws.PREP_TABLE_TOP_Z, 0.0
        rail2_target = np.array(ws.OVEN_RAIL2_WORLD, dtype=np.float64)

      # --- Stage 1: Contact-based tray pickup (with T3 push/slip recovery & v2 Z calibration) ---
      max_attempts = 2 if self._use_vision else 1
      dz_prep = 0.0
      x_prep_cal = tx
      for attempt in range(max_attempts):
        p_hover = np.array([tx, ty, tz + 0.160], dtype=np.float64)
        move_joints(self._ik(state['cmd_q'], p_hover, tyaw), ws.GRIPPER_OPEN_M, max_step_rad=0.024, settle_ticks=16)

        if self._use_ee_depth_cal:
          # Eye-to-hand spanner-beam Z calibration over prep table (rejects ±20 mm table_dz + ±1.5 deg tilt!)
          dz_prep = self._measure_ee_z_offset(
              state['meas']['overhead_cam_depth'], (tx, ty), state['cmd_q'], cam_cal, yaw_rad=tyaw
          )
          x_prep_cal = tx

        if self._use_vision:
          # Descend to 6.5 cm above tray (triggers any T3 `push` before final descent!),
          # then swing completely clear of overhead_cam's prep-table FOV AND oven front-right corner!
          p_probe = np.array([tx, ty, tz + 0.068 - dz_prep], dtype=np.float64)
          move_cartesian(p_hover, p_probe, tyaw, tyaw, ws.GRIPPER_OPEN_M, step_m=0.016, settle_ticks=14)
          move_cartesian(p_probe, p_hover, tyaw, tyaw, ws.GRIPPER_OPEN_M, step_m=0.020, settle_ticks=2)
          # Clear overhead view of prep table cleanly over the open front corridor (far from oven corner!)
          p_peek = np.array([0.12, -0.68, 1.30], dtype=np.float64)
          move_cartesian(p_hover, p_peek, tyaw, 0.0, ws.GRIPPER_OPEN_M, step_m=0.026, max_step_rad=0.026, settle_ticks=6)
          tray_re = self._perceive_tray(state['meas']['overhead_cam_depth'], cam_cal)
          if tray_re is not None:
            tx, ty, tz, tyaw = tray_re
          p_hover = np.array([tx, ty, tz + 0.160], dtype=np.float64)
          move_cartesian(p_peek, p_hover, 0.0, tyaw, ws.GRIPPER_OPEN_M, step_m=0.026, max_step_rad=0.026, settle_ticks=16)
          if self._use_ee_depth_cal:
            dz_prep = self._measure_ee_z_offset(
                state['meas']['overhead_cam_depth'], (tx, ty), state['cmd_q'], cam_cal, yaw_rad=tyaw
            )
            x_prep_cal = tx

        # Descend gently to calibrated grasp height with +4 mm extra rear-rim clearance along tool +X
        # (9 mm total rear clearance prevents jaw_rear from ever grazing the rear rim under T2 proprio bias!)
        des_x_grasp = np.array([-math.sin(tyaw), math.cos(tyaw), 0.0], dtype=np.float64)
        rear_pad_shift = 0.004 * des_x_grasp if self._use_ee_depth_cal else np.zeros(3, dtype=np.float64)
        p_grasp = np.array([tx, ty, tz + 0.011 - dz_prep], dtype=np.float64) + rear_pad_shift
        move_cartesian(p_hover, p_grasp, tyaw, tyaw, ws.GRIPPER_OPEN_M, step_m=0.006, settle_ticks=8)

        # Close sliding front jaw smoothly onto tray front rim (<= 15.5 N silicone pinch!)
        actuate_gripper(ws.GRIPPER_CLOSE_M, ticks=34, mode='close')

        # Lift straight up +30 cm (smoothly; covers 0.15 s T3 `slip` pull!)
        slide_z_off = 0.042 if self._use_ee_depth_cal else 0.052
        p_lifted = np.array([tx, ty, max(tz + 0.300, rail2_target[2] + slide_z_off) - dz_prep], dtype=np.float64)
        move_cartesian(p_grasp, p_lifted, tyaw, tyaw, ws.GRIPPER_CLOSE_M, step_m=0.010, max_step_rad=0.020, settle_ticks=14)

        # Level Cartesian carry forward to clear corridor (Y = -0.48, 80 mm in front of oven face!)
        p_corridor = np.array([0.04, -0.48, rail2_target[2] + slide_z_off - 0.5 * dz_prep], dtype=np.float64)
        move_cartesian(p_lifted, p_corridor, tyaw, 0.0, ws.GRIPPER_CLOSE_M, step_m=0.016, max_step_rad=0.020, settle_ticks=6)

        if self._use_vision and attempt + 1 < max_attempts:
          # Prep table is now 100% unobstructed in overhead_cam! Did the tray slip back onto it?
          tray_left = self._perceive_tray(state['meas']['overhead_cam_depth'], cam_cal)
          if tray_left is not None:
            # Tray slipped back onto prep table! Open, re-localize, and re-grasp cleanly!
            actuate_gripper(ws.GRIPPER_OPEN_M, ticks=16, mode='open')
            tx, ty, tz, tyaw = tray_left
            continue
        break

      # --- Stage 2: Level Cartesian Corridor -> Oven Mouth Alignment (80 mm clear of oven face) ---
      # Clamped tray sits +5 mm along tool +X (+Y world) relative to cell_grasp, and +6 mm right
      # in +X from grasp-centroid & j1-approach compliance -> compensate (-0.006, -0.005, 0.0).
      # With v2 exact Z-calibration, slide at +42 mm (tray deck ~1.153 m): dead-center with
      # +16 mm clearance ABOVE Rail #2 side guides (1.137 m) AND +16 mm BELOW Rail #3 ledges (1.191 m)!
      rail2_grip = rail2_target - np.array([0.006, 0.005, 0.0], dtype=np.float64)

      p_mouth = np.array([rail2_grip[0], rail2_grip[1] - 0.48, rail2_grip[2] + slide_z_off], dtype=np.float64)
      move_cartesian(p_corridor, p_mouth, 0.0, 0.0, ws.GRIPPER_CLOSE_M, step_m=0.014, max_step_rad=0.020, settle_ticks=14)

      dz_oven = 0.0
      dx_oven = 0.0
      if self._use_ee_depth_cal:
        # 1. Eye-to-hand spanner-beam Z calibration right at oven mouth (<0.5 mm error!)
        dz_oven = self._measure_ee_z_offset(
            state['meas']['overhead_cam_depth'],
            (float(p_mouth[0]), float(p_mouth[1])),
            state['cmd_q'],
            cam_cal,
            yaw_rad=0.0,
        )
        # 2. Infer base tilt from two-point Z difference (subtracting ~8.5 mm nominal 0.85 kg tray
        #    elastic droop at oven mouth so T0 zero-tilt stays unbiased at 0.00 deg!)
        dz_oven_unloaded = dz_oven + 0.0085
        sin_tilt = float(
            np.clip((dz_prep - dz_oven_unloaded) / max(x_prep_cal - float(p_mouth[0]), 0.4), -0.04, 0.04)
        )
        dx_oven = float(np.clip(-(rail2_grip[2] + 0.03 - ws.ARM_BASE_POS[2]) * sin_tilt, -0.014, 0.014))
        p_mouth_cal = np.array(
            [rail2_grip[0] - dx_oven, rail2_grip[1] - 0.48, rail2_grip[2] + slide_z_off - dz_oven],
            dtype=np.float64,
        )
        move_cartesian(p_mouth, p_mouth_cal, 0.0, 0.0, ws.GRIPPER_CLOSE_M, step_m=0.008, max_step_rad=0.016, settle_ticks=4)
        p_mouth = p_mouth_cal

      # --- Stage 3: Linear Slide Insertion into Maruzen MBCO-4ME Rail #2 ---
      p_over_rail2 = np.array(
          [rail2_grip[0] - dx_oven, rail2_grip[1], rail2_grip[2] + slide_z_off - dz_oven], dtype=np.float64
      )
      move_cartesian(p_mouth, p_over_rail2, 0.0, 0.0, ws.GRIPPER_CLOSE_M, step_m=0.010, max_step_rad=0.018, settle_ticks=6)

      # Gently lower to ~4 mm above Rail #2 ledges so releasing sets the tray down under pure gravity
      # (zero downward arm crush force even under T2 ±20 mm table_dz / ±1.5 deg tilt!)
      p_seat = np.array(
          [rail2_grip[0] - dx_oven, rail2_grip[1], rail2_grip[2] + 0.030 - dz_oven], dtype=np.float64
      )
      move_cartesian(p_over_rail2, p_seat, 0.0, 0.0, ws.GRIPPER_CLOSE_M, step_m=0.004, max_step_rad=0.014, settle_ticks=8)

      # --- Stage 4: Gentle Release, Vertical Clearance Lift & Retract Home ---
      actuate_gripper(0.036, ticks=18, mode='open')

      # Shift 8 mm forward (-Y) so rear blade clears rear tray rim before lifting straight up!
      p_clear_rear = np.array(
          [rail2_grip[0] - dx_oven, rail2_grip[1] - 0.008, rail2_grip[2] + 0.030 - dz_oven],
          dtype=np.float64,
      )
      move_cartesian(p_seat, p_clear_rear, 0.0, 0.0, 0.036, step_m=0.004, max_step_rad=0.014, settle_ticks=4)

      # Lift +42 mm straight up inside oven chamber (still >115 mm clear of chamber ceiling!)
      p_up = np.array(
          [rail2_grip[0] - dx_oven, rail2_grip[1] - 0.008, rail2_grip[2] + 0.072 - dz_oven],
          dtype=np.float64,
      )
      move_cartesian(p_clear_rear, p_up, 0.0, 0.0, 0.036, step_m=0.008, max_step_rad=0.018, settle_ticks=4)

      # Retract linearly out of oven doorway to mouth (Y = -0.48, 80 mm clear!)
      p_out = np.array(
          [rail2_grip[0] - dx_oven, rail2_grip[1] - 0.48, rail2_grip[2] + 0.072 - dz_oven],
          dtype=np.float64,
      )
      move_cartesian(p_up, p_out, 0.0, 0.0, ws.GRIPPER_OPEN_M, step_m=0.016, max_step_rad=0.022, settle_ticks=4)

      # Return smoothly to home standby via wide front corridor (100% clear even at +35 mm oven shift!)
      p_back = np.array([0.16, -0.54, 1.28], dtype=np.float64)
      move_cartesian(p_out, p_back, 0.0, 0.0, ws.GRIPPER_OPEN_M, step_m=0.022, max_step_rad=0.024, settle_ticks=2)
      move_joints(ws.FR10_HOME_Q, ws.GRIPPER_OPEN_M, max_step_rad=0.024, settle_ticks=10)
      return {'status': 'done'}

    except _AbortEpisode as exc:
      # Safe stop: hold current pose for 3 ticks so settle window starts cleanly past onset
      q_hold = state['cmd_q'].copy()
      g_hold = float(state['cmd_g'])
      for _ in range(3):
        dl.step(self._make_cmd(q_hold, g_hold))
      return {'status': 'abort', 'fault': exc.fault}
