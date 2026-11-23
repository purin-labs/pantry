"""Simulation-side MuJoCo Studio plugin for the FR10 + Maruzen MBCO-4ME Bakery Workcell.

Imports the single-source-of-truth MjSpec builder from `workcell_scene.py` (shared with
`gauntlet/bakery_tray_task.py`) and runs a live, real-contact FR10 tray pickup &
Maruzen MBCO-4ME Rail #2 insertion cycle with real-time Gauntlet safety force telemetry.
Offline preview only (Plan 42B keeps production workflow controllers in Rust).
"""

from __future__ import annotations

import math
import pathlib
import sys

import messages as user_messages
import mujoco
from mujoco.studio import messages
from mujoco.studio import plugin
import numpy as np

WORKSPACE_DIR = pathlib.Path(__file__).resolve().parent
if str(WORKSPACE_DIR) not in sys.path:
  sys.path.insert(0, str(WORKSPACE_DIR))

import workcell_scene as ws  # noqa: E402


def _build_contact_cycle_plan(
    model: mujoco.MjModel,
    arm_jids: list[int],
    grasp_sid: int,
) -> list[tuple[str, float, np.ndarray, float, float, float]]:
  """Precompute smooth minimum-jerk waypoints for the live real-contact pickup & Rail #2 cycle.

  Each entry is `(phase_label, duration_s, q_target_6, gripper_m, door_rad, fan_rad_s)`.
  """
  prep = np.array(ws.PREP_TRAY_WORLD, dtype=np.float64)
  r2 = np.array(ws.OVEN_RAIL2_WORLD, dtype=np.float64) - np.array([0.0, 0.005, 0.0])

  def ik(q_seed: np.ndarray, pos: np.ndarray, yaw: float = 0.0) -> np.ndarray:
    q, _, _ = ws.solve_spanner_ik(model, arm_jids, grasp_sid, q_seed, pos, yaw, iters=120)
    return q

  q_home = ws.FR10_HOME_Q.copy()
  q_hover = ik(q_home, prep + [0.0, 0.0, 0.160])
  q_grasp = ik(q_hover, prep + [0.0, 0.0, 0.016])
  q_lift = ik(q_grasp, np.array([prep[0], prep[1], max(prep[2] + 0.300, r2[2] + 0.050)]))
  q_corr = ik(q_lift, np.array([0.04, -0.48, r2[2] + 0.050]))
  q_mouth = ik(q_corr, np.array([r2[0], r2[1] - 0.48, r2[2] + 0.050]))
  q_over = ik(q_mouth, np.array([r2[0], r2[1], r2[2] + 0.050]))
  q_seat = ik(q_over, np.array([r2[0], r2[1], r2[2] + 0.024]))
  q_clr = ik(q_seat, np.array([r2[0], r2[1] - 0.008, r2[2] + 0.024]))
  q_up = ik(q_clr, np.array([r2[0], r2[1] - 0.008, r2[2] + 0.068]))
  q_out = ik(q_up, np.array([r2[0], r2[1] - 0.48, r2[2] + 0.068]))
  q_back = ik(q_out, np.array([0.04, -0.48, 1.24]))

  g_open = ws.GRIPPER_OPEN_M
  g_close = ws.GRIPPER_CLOSE_M
  g_rel = 0.036
  d_open = 1.90

  return [
      ('1. Approach Prep Table', 1.5, q_hover, g_open, d_open, 0.0),
      ('2. Descend Over Tray', 1.2, q_grasp, g_open, d_open, 0.0),
      ('3. Silicone Rim Clamp', 0.9, q_grasp, g_close, d_open, 0.0),
      ('4. Contact Lift', 1.4, q_lift, g_close, d_open, 0.0),
      ('5. Level Carry Corridor', 1.8, q_corr, g_close, d_open, 0.0),
      ('6. Align Oven Mouth', 1.8, q_mouth, g_close, d_open, 0.0),
      ('7. Slide Above Rail #2 Guides', 1.8, q_over, g_close, d_open, 0.0),
      ('8. Lower Onto Rail #2', 1.0, q_seat, g_close, d_open, 0.0),
      ('9. Release Tray', 0.7, q_seat, g_rel, d_open, 0.0),
      ('10. Clear Rear Rim', 0.5, q_clr, g_rel, d_open, 0.0),
      ('11. Vertical Clearance Lift', 0.8, q_up, g_rel, d_open, 0.0),
      ('12. Retract From Oven', 1.5, q_out, g_open, d_open, 0.0),
      ('13. Return Home Standby', 1.6, q_back, g_open, d_open, 0.0),
      ('14. Close Door & Bake', 2.4, q_home, g_open, 0.0, 150.0),
      ('15. Hold Bake Cycle', 2.5, q_home, g_open, 0.0, 155.0),
      ('16. Open Door & Reset', 1.6, q_home, g_open, d_open, 0.0),
  ]


class SimPlugin(plugin.SimPlugin):
  """Interactive Bakery Workcell simulation with live real-contact FR10 tray loading."""

  # Class-level defaults survive hot-reload swaps cleanly.
  lighting: user_messages.RenderLightingConfig = user_messages.RenderLightingConfig()
  control: user_messages.WorkcellControl = user_messages.WorkcellControl()
  _spec: mujoco.MjSpec | None = None
  _model: mujoco.MjModel | None = None
  _data: mujoco.MjData | None = None
  _ids: dict[str, int] = {}
  _arm_jids: list[int] = []
  _arm_aids: list[int] = []
  _arm_body_ids: list[int] = []
  _robot_body_mask: np.ndarray = np.zeros(0, dtype=bool)
  _pad_geom_mask: np.ndarray = np.zeros(0, dtype=bool)
  _rail2_geom_ids: set[int] = set()
  _tray_bid: int = -1
  _oven_bid: int = -1
  _plan: list[tuple[str, float, np.ndarray, float, float, float]] = []
  _plan_starts: list[float] = []
  _plan_total_s: float = 1.0
  _cycle_t0: float = 0.0
  _last_cycle_idx: int = -1
  _path_points: tuple[tuple[float, float, float], ...] = ()
  _ghost_samples: list[tuple[np.ndarray, np.ndarray, tuple[tuple[float, float, float], ...]]] = []
  _step_counter: int = 0
  _peak_grasp_n: float = 0.0
  _peak_env_n: float = 0.0

  def __init__(self) -> None:
    super().__init__()
    self.lighting = user_messages.RenderLightingConfig()
    self.control = user_messages.WorkcellControl()
    self._ids = {}
    self._arm_jids = []
    self._arm_aids = []
    self._arm_body_ids = []
    self._rail2_geom_ids = set()
    self._plan = []
    self._plan_starts = []
    self._ghost_samples = []

  def _load_current_spec(self, tray_start: str = 'prep_table') -> None:
    cfg = self.lighting
    self._spec = ws.build_workcell_spec(
        for_gauntlet=False,
        pastry_load=cfg.pastry_load,
        tray_start=tray_start,
        exposure=cfg.exposure,
        ibl_intensity=cfg.ibl_intensity,
        bay_intensity=cfg.bay_intensity,
        bloom_enabled=cfg.bloom_enabled,
        bloom_strength=cfg.bloom_strength,
        ssao_enabled=cfg.ssao_enabled,
        tone_mapping=cfg.tone_mapping,
    )
    self.handle.set_model(self._spec)

  def _cache_ids_and_plan(self) -> None:
    m = self._model
    assert m is not None
    self._ids = {
        'door_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'oven/mbco4_door_hinge'),
        'handle_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'oven/mbco4_handle_latch'),
        'fan_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'oven/mbco4_fan_spin'),
        'damper_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'oven/mbco4_damper_hinge'),
        'tray_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'tray/tray_free'),
        'grip_j': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'arm/grip/gripper'),
        'door_a': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'oven_door_act'),
        'handle_a': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'oven_handle_act'),
        'fan_a': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'oven_fan_act'),
        'damper_a': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'oven_damper_act'),
        'grip_a': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'arm/grip/gripper_act'),
        'grasp_s': mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, 'arm/grip/cell_grasp'),
    }
    self._arm_jids = [
        mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, f'arm/fairino-fr10__j{i}')
        for i in range(1, 7)
    ]
    self._arm_aids = [
        mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, f'arm_j{i}_act')
        for i in range(1, 7)
    ]
    self._arm_body_ids = [
        mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, name)
        for name in (
            'arm/fairino-fr10__base_link',
            'arm/fairino-fr10__shoulder_link',
            'arm/fairino-fr10__upperarm_link',
            'arm/fairino-fr10__forearm_link',
            'arm/fairino-fr10__wrist1_link',
            'arm/fairino-fr10__wrist3_link',
        )
    ]
    self._tray_bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, 'tray/mbco4_tray')
    self._oven_bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, 'oven/mbco4_oven')
    self._robot_body_mask = np.array(
        [(mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, b) or '').startswith('arm/') for b in range(m.nbody)],
        dtype=bool,
    )
    pad_bodies = {
        b for b in range(m.nbody)
        if (mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, b) or '') in ('arm/grip/jaw_front', 'arm/grip/jaw_rear')
    }
    self._pad_geom_mask = np.array([int(m.geom_bodyid[g]) in pad_bodies for g in range(m.ngeom)], dtype=bool)
    self._rail2_geom_ids = {
        g for g in range(m.ngeom)
        if 'mbco4_rail_2_' in (mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g) or '')
    }

    self._plan = _build_contact_cycle_plan(m, self._arm_jids, self._ids['grasp_s'])
    t_acc = 0.0
    self._plan_starts = []
    for _, dur, *_ in self._plan:
      self._plan_starts.append(t_acc)
      t_acc += dur
    self._plan_total_s = t_acc

    # Precompute translucent ghost path (Prep -> Lift -> Corridor -> Oven Mouth -> Rail #2)
    kd = mujoco.MjData(m)
    path_pts: list[tuple[float, float, float]] = []
    self._ghost_samples = []
    carry_qs = [self._plan[1][2], self._plan[3][2], self._plan[4][2], self._plan[5][2], self._plan[6][2], self._plan[7][2]]
    n_sub = 8
    for seg in range(len(carry_qs) - 1):
      qa, qb = carry_qs[seg], carry_qs[seg + 1]
      for k in range(n_sub + (1 if seg == len(carry_qs) - 2 else 0)):
        u = k / n_sub
        s = 0.5 * (1.0 - math.cos(math.pi * u))
        qk = (1.0 - s) * qa + s * qb
        for idx, jid in enumerate(self._arm_jids):
          kd.qpos[m.jnt_qposadr[jid]] = qk[idx]
        mujoco.mj_kinematics(m, kd)
        ee_p = kd.site_xpos[self._ids['grasp_s']].copy()
        ee_m = kd.site_xmat[self._ids['grasp_s']].reshape(3, 3).copy()
        joints_xyz = tuple(tuple(float(v) for v in kd.xpos[bid]) for bid in self._arm_body_ids) + (
            tuple(float(v) for v in ee_p),
        )
        path_pts.append(tuple(float(v) for v in ee_p))
        self._ghost_samples.append((ee_p, ee_m, joints_xyz))
    self._path_points = tuple(path_pts)

  def _stage_tray(self, target: str) -> None:
    if self._model is None or self._data is None or 'tray_j' not in self._ids:
      return
    m, d = self._model, self._data
    jadr = int(m.jnt_qposadr[self._ids['tray_j']])
    dadr = int(m.jnt_dofadr[self._ids['tray_j']])
    pos = ws.OVEN_RAIL2_WORLD if target == 'oven_rail2' else ws.PREP_TRAY_WORLD
    d.qpos[jadr : jadr + 3] = list(pos)
    d.qpos[jadr + 3 : jadr + 7] = [1.0, 0.0, 0.0, 0.0]
    d.qvel[dadr : dadr + 6] = 0.0
    self._peak_grasp_n = 0.0
    self._peak_env_n = 0.0
    mujoco.mj_forward(m, d)

  def _init_pose(self) -> None:
    if self._model is None or self._data is None or not self._arm_jids:
      return
    m, d = self._model, self._data
    for idx, jid in enumerate(self._arm_jids):
      val = float(ws.FR10_HOME_Q[idx])
      d.qpos[m.jnt_qposadr[jid]] = val
      d.ctrl[self._arm_aids[idx]] = val
    d.qpos[m.jnt_qposadr[self._ids['grip_j']]] = ws.GRIPPER_OPEN_M
    d.ctrl[self._ids['grip_a']] = ws.GRIPPER_OPEN_M
    d.qpos[m.jnt_qposadr[self._ids['door_j']]] = 1.90
    d.ctrl[self._ids['door_a']] = 1.90
    self._stage_tray('prep_table')
    self._cycle_t0 = float(d.time)
    self._last_cycle_idx = -1

  @messages.handler
  def on_sim_init(self, event: plugin.SimInitEvent) -> None:
    del event
    self._load_current_spec(tray_start='prep_table')

  @messages.handler
  def on_hot_reload(self, event: messages.HotReloadEvent) -> None:
    del event
    import importlib
    importlib.reload(ws)
    self._load_current_spec(tray_start='prep_table')

  @messages.handler
  def on_post_model(self, event: messages.PostModelEvent) -> None:
    self._model = event.model
    self._data = event.data
    self._cache_ids_and_plan()
    self._init_pose()

  @messages.handler
  def on_reset(self, event: messages.ResetEvent) -> None:
    del event
    self._init_pose()

  @messages.handler
  def on_lighting(self, snapshot: user_messages.RenderLightingConfig) -> None:
    self.lighting = snapshot
    self._load_current_spec(tray_start='prep_table')

  @messages.handler
  def on_control(self, snapshot: user_messages.WorkcellControl) -> None:
    prev_mode = self.control.robot_mode
    self.control = snapshot
    if snapshot.robot_mode == 'contact_cycle' and prev_mode != 'contact_cycle':
      self._stage_tray('prep_table')
      self._cycle_t0 = float(self._data.time) if self._data is not None else 0.0
      self._last_cycle_idx = -1

  @messages.handler
  def on_stage_tray(self, event: user_messages.StageTrayEvent) -> None:
    self._stage_tray(event.target)
    if event.target == 'prep_table' and self.control.robot_mode == 'contact_cycle':
      self._cycle_t0 = float(self._data.time) if self._data is not None else 0.0
      self._last_cycle_idx = -1

  @messages.handler
  def on_oven_preset(self, event: user_messages.OvenPresetEvent) -> None:
    if event.preset == 'open_load':
      self.control = user_messages.WorkcellControl(
          door_deg=108.0,
          handle_deg=0.0,
          fan_rad_s=0.0,
          damper_deg=0.0,
          robot_mode='contact_cycle',
          manual_joints_deg=self.control.manual_joints_deg,
          gripper_open_mm=45.0,
          show_ghost_path=self.control.show_ghost_path,
          ghost_progress=self.control.ghost_progress,
      )
      self._stage_tray('prep_table')
      self._cycle_t0 = float(self._data.time) if self._data is not None else 0.0
      self._last_cycle_idx = -1
    else:
      self.control = user_messages.WorkcellControl(
          door_deg=0.0,
          handle_deg=0.0,
          fan_rad_s=155.0,
          damper_deg=32.0,
          robot_mode='home',
          manual_joints_deg=self.control.manual_joints_deg,
          gripper_open_mm=45.0,
          show_ghost_path=self.control.show_ghost_path,
          ghost_progress=self.control.ghost_progress,
      )
      self._stage_tray('oven_rail2')

  @messages.handler
  def on_bake(self, event: user_messages.BakeSceneEvent) -> None:
    del event
    if self._spec is not None:
      out = WORKSPACE_DIR / 'scene.xml'
      out.write_text(self._spec.to_xml())

  def _eval_contact_cycle(self, sim_t: float) -> tuple[str, np.ndarray, float, float, float, float]:
    elapsed = max(0.0, sim_t - self._cycle_t0)
    cyc_idx = int(elapsed // self._plan_total_s)
    if cyc_idx != self._last_cycle_idx:
      self._last_cycle_idx = cyc_idx
      if cyc_idx > 0:
        self._stage_tray('prep_table')
    t_loc = elapsed % self._plan_total_s
    q_prev = ws.FR10_HOME_Q.copy()
    g_prev = ws.GRIPPER_OPEN_M
    d_prev = 1.90
    f_prev = 0.0
    for i, (label, dur, q_tgt, g_tgt, d_tgt, f_tgt) in enumerate(self._plan):
      t0 = self._plan_starts[i]
      if t_loc <= t0 + dur or i == len(self._plan) - 1:
        u = float(np.clip((t_loc - t0) / max(dur, 1e-6), 0.0, 1.0))
        s = 0.5 * (1.0 - math.cos(math.pi * u))
        q_cmd = (1.0 - s) * q_prev + s * q_tgt
        g_cmd = (1.0 - s) * g_prev + s * g_tgt
        d_cmd = (1.0 - s) * d_prev + s * d_tgt
        f_cmd = (1.0 - s) * f_prev + s * f_tgt
        prog = float(np.clip(t_loc / max(1.0, self._plan_starts[8]), 0.0, 1.0))
        return label, q_cmd, g_cmd, d_cmd, f_cmd, prog
      q_prev, g_prev, d_prev, f_prev = q_tgt, g_tgt, d_tgt, f_tgt
    return 'Standby', ws.FR10_HOME_Q.copy(), ws.GRIPPER_OPEN_M, 1.90, 0.0, 0.0

  def _measure_forces(self, m: mujoco.MjModel, d: mujoco.MjData) -> tuple[float, float, float]:
    f6 = np.zeros(6, dtype=np.float64)
    grasp_f = 0.0
    env_f = 0.0
    rail2_f = 0.0
    for i in range(d.ncon):
      c = d.contact[i]
      g1, g2 = int(c.geom1), int(c.geom2)
      b1, b2 = int(m.geom_bodyid[g1]), int(m.geom_bodyid[g2])
      if (g1 in self._rail2_geom_ids and b2 == self._tray_bid) or (
          g2 in self._rail2_geom_ids and b1 == self._tray_bid
      ):
        mujoco.mj_contactForce(m, d, i, f6)
        rail2_f += abs(float(f6[0]))
      r1, r2 = bool(self._robot_body_mask[b1]), bool(self._robot_body_mask[b2])
      if r1 != r2:
        mujoco.mj_contactForce(m, d, i, f6)
        mag = abs(float(f6[0]))
        rob_g, other_b = (g1, b2) if r1 else (g2, b1)
        if other_b == self._tray_bid and self._pad_geom_mask[rob_g]:
          grasp_f = max(grasp_f, mag)
        else:
          env_f = max(env_f, mag)
    return grasp_f, env_f, rail2_f

  @messages.handler
  def on_pre_step(self, event: messages.PreStepEvent) -> None:
    m, d = event.model, event.data
    self._model, self._data = m, d
    if not self._plan:
      return
    c = self.control

    if c.robot_mode == 'contact_cycle':
      phase, q_cmd, g_cmd, door_cmd, fan_cmd, ghost_prog = self._eval_contact_cycle(float(d.time))
      damper_cmd = math.radians(32.0) if door_cmd < 0.1 else 0.0
    else:
      door_cmd = math.radians(c.door_deg)
      fan_cmd = float(c.fan_rad_s)
      damper_cmd = math.radians(c.damper_deg)
      g_cmd = float(np.clip(c.gripper_open_mm * 1e-3, ws.GRIPPER_CLOSE_M, ws.GRIPPER_OPEN_M))
      ghost_prog = float(c.ghost_progress)
      if c.robot_mode == 'home':
        phase, q_cmd = 'Home Standby', ws.FR10_HOME_Q.copy()
      elif c.robot_mode == 'prep_hover':
        phase, q_cmd = 'Prep Table Hover', self._plan[0][2].copy()
      elif c.robot_mode == 'oven_mouth':
        phase, q_cmd = 'Oven Mouth Approach', self._plan[5][2].copy()
      elif c.robot_mode == 'oven_rail2':
        phase, q_cmd = 'Oven Rail #2 Insert', self._plan[6][2].copy()
      else:
        phase = 'Manual Joint Control'
        q_cmd = np.radians(np.asarray(c.manual_joints_deg, dtype=np.float64))

    for idx, aid in enumerate(self._arm_aids):
      d.ctrl[aid] = float(q_cmd[idx])
    d.ctrl[self._ids['grip_a']] = float(g_cmd)
    d.ctrl[self._ids['door_a']] = float(door_cmd)
    d.ctrl[self._ids['handle_a']] = math.radians(c.handle_deg)
    d.ctrl[self._ids['fan_a']] = float(fan_cmd)
    d.ctrl[self._ids['damper_a']] = float(damper_cmd)

    grasp_f, env_f, rail2_f = self._measure_forces(m, d)
    self._peak_grasp_n = max(self._peak_grasp_n * 0.992, grasp_f)
    self._peak_env_n = max(self._peak_env_n * 0.992, env_f)

    self._step_counter += 1
    if self._step_counter % 6 != 0:
      return

    tray_rel = d.xpos[self._tray_bid] - d.xpos[self._oven_bid]
    on_rail2 = (
        abs(float(tray_rel[0]) - ws.OVEN_RAIL2_OFFSET[0]) < 0.025
        and abs(float(tray_rel[1]) - ws.OVEN_RAIL2_OFFSET[1]) < 0.045
        and abs(float(tray_rel[2]) - ws.OVEN_RAIL2_OFFSET[2]) < 0.015
    )

    g_idx = min(len(self._ghost_samples) - 1, int(round(ghost_prog * (len(self._ghost_samples) - 1))))
    g_ee_p, g_ee_m, g_joints = self._ghost_samples[g_idx]

    self.handle.send_to_viewer(
        user_messages.WorkcellTelemetry(
            sim_time=float(d.time),
            phase_label=phase,
            door_deg=math.degrees(float(d.qpos[m.jnt_qposadr[self._ids['door_j']]])),
            handle_deg=math.degrees(float(d.qpos[m.jnt_qposadr[self._ids['handle_j']]])),
            fan_rpm=abs(float(d.qvel[m.jnt_dofadr[self._ids['fan_j']]])) * 60.0 / (2.0 * math.pi),
            damper_deg=math.degrees(float(d.qpos[m.jnt_qposadr[self._ids['damper_j']]])),
            grasp_force_n=float(self._peak_grasp_n),
            env_force_n=float(self._peak_env_n),
            rail2_touch_n=float(rail2_f),
            tray_on_rail2=bool(on_rail2),
            safety_ok=(self._peak_grasp_n <= 35.0 and self._peak_env_n <= 60.0),
            arm_joints_deg=tuple(
                math.degrees(float(d.qpos[m.jnt_qposadr[jid]])) for jid in self._arm_jids
            ),
            ee_pos=tuple(float(v) for v in d.site_xpos[self._ids['grasp_s']]),
            path_points=self._path_points,
            ghost_ee_pos=tuple(float(v) for v in g_ee_p),
            ghost_ee_mat=tuple(float(v) for v in g_ee_m.flatten()),
            ghost_arm_joints=g_joints,
        )
    )
