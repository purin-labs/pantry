"""`robosim_gauntlet` Task for FR10 contact-based tray pickup & Maruzen MBCO-4ME Rail #2 insertion.

Imports the single-source-of-truth workcell builder from `studio_workcell/workcell_scene.py`
so MuJoCo Studio and `robosim_gauntlet` run the exact same robot, spanner gripper, oven,
and freejoint baking tray geometry and physics.
"""

from __future__ import annotations

import math
import pathlib
import sys
from collections.abc import Callable, Mapping
from typing import Any

import mujoco
import numpy as np

GAUNTLET_DIR = pathlib.Path(__file__).resolve().parent
STUDIO_DIR = GAUNTLET_DIR.parent / 'studio_workcell'
for _p in (str(GAUNTLET_DIR), str(STUDIO_DIR)):
  if _p not in sys.path:
    sys.path.insert(0, _p)

import mujoco_device_layer as mdl  # noqa: E402
import workcell_scene as ws  # noqa: E402

mdl.install_gauntlet_shims()

from robosim_gauntlet import task as task_lib  # noqa: E402


def _quat_inv(q: np.ndarray) -> np.ndarray:
  return np.array([q[0], -q[1], -q[2], -q[3]], dtype=np.float64)


def _quat_rot(q: np.ndarray, v: np.ndarray) -> np.ndarray:
  r = np.zeros(9, dtype=np.float64)
  mujoco.mju_quat2Mat(r, np.asarray(q, dtype=np.float64))
  return r.reshape(3, 3) @ np.asarray(v, dtype=np.float64)


def _place_tray_on_rail2(sim: Any, p0: Mapping[str, np.ndarray] | None = None) -> None:
  """Positive-control goal setter for `preflight.run`: seats tray cleanly on oven Rail #2."""
  del p0
  mjm, d = sim.mj_model, sim.mj_data
  oven_bid = mjm.body('oven/mbco4_oven').id
  tray_bid = mjm.body('tray/mbco4_tray').id
  mujoco.mj_forward(mjm, d)
  oven_pos = np.asarray(d.xpos[oven_bid], dtype=np.float64)
  oven_quat = np.asarray(d.xquat[oven_bid], dtype=np.float64)
  local_goal = np.array(
      [ws.OVEN_RAIL2_OFFSET[0], ws.OVEN_RAIL2_OFFSET[1], ws.OVEN_RAIL2_OFFSET[2] + 0.001],
      dtype=np.float64,
  )
  world_goal = oven_pos + _quat_rot(oven_quat, local_goal)
  jadr = int(mjm.jnt_qposadr[mjm.body_jntadr[tray_bid]])
  dadr = int(mjm.jnt_dofadr[mjm.body_jntadr[tray_bid]])
  d.qpos[jadr : jadr + 3] = world_goal
  d.qpos[jadr + 3 : jadr + 7] = oven_quat
  d.qvel[dadr : dadr + 6] = 0.0
  mujoco.mj_forward(mjm, d)


def _reset_workcell(sim: mdl.MuJoCoSim) -> None:
  """Initialize FR10 at home, gripper open, oven door open at 108 deg, tray resting on prep table."""
  m, d = sim.mj_model, sim.mj_data
  for idx in range(1, 7):
    jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, f'arm/fairino-fr10__j{idx}')
    aid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, f'arm_j{idx}_act')
    val = float(ws.FR10_HOME_Q[idx - 1])
    d.qpos[m.jnt_qposadr[jid]] = val
    d.ctrl[aid] = val

  gjid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'arm/grip/gripper')
  gaid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, 'arm/grip/gripper_act')
  d.qpos[m.jnt_qposadr[gjid]] = ws.GRIPPER_OPEN_M
  d.ctrl[gaid] = ws.GRIPPER_OPEN_M

  door_j = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'oven/mbco4_door_hinge')
  d.qpos[m.jnt_qposadr[door_j]] = 1.90
  d.qvel[:] = 0.0


class BakeryTrayRail2Task:
  """FR10 contact-based tray pickup from prep table and insertion into Maruzen MBCO-4ME Rail #2."""

  name: str = 'fr10_mbco4_rail2_insert'
  task_id: str = 'fr10_mbco4_rail2_insert'
  prompt: str = (
      'Pick up the 400x300 mm croissant baking tray from the stainless prep table '
      'using the FR10 spanner gripper and slide it gently onto Rail #2 of the '
      'Maruzen MBCO-4ME convection oven, then release and return home.'
  )
  control_dt_s: float = 0.02
  episode_s: float = 34.0
  horizon_s: float = 34.0
  target_body: str = 'tray/mbco4_tray'
  support_body: str = 'oven/mbco4_oven'
  bystander_bodies: tuple[str, ...] = ('bystander_dish',)
  robot_pattern: str = r'^arm/'
  pad_pattern: str = r'^arm/grip/jaw_(front|rear)$'
  camera_keys: tuple[str, ...] = ('overhead_cam',)

  def __init__(self, *, camera_hw: tuple[int, int] = (240, 320)):
    self._camera_hw = camera_hw
    self.safety = task_lib.SafetyLimits(
        max_grasp_force_n=35.0,
        max_contact_force_n=60.0,
        max_impact_force_n=300.0,
        max_self_contact_force_n=20.0,
        max_joint_speed=4.0,
        joint_limit_margin=0.02,
        max_command_step_frac=0.25,
        bystander_tol_m=0.02,
        drop_z_tol_m=0.05,
        require_release=True,
        goal_setter=_place_tray_on_rail2,
    )

  def build_device_layer(
      self, mode: str, *, extra_devices: Mapping[str, Any] | None = None
  ) -> tuple[Any, Callable[[], None], Callable[[], None]]:
    if mode != 'sim':
      raise ValueError(f'Only sim mode is supported for offline verification, got {mode!r}.')
    spec = ws.build_workcell_spec(for_gauntlet=True, pastry_load=True, tray_start='prep_table')
    dl = mdl.MuJoCoDeviceLayer(
        spec,
        control_dt_s=self.control_dt_s,
        arm_joint_names=[f'arm/fairino-fr10__j{i}' for i in range(1, 7)],
        arm_actuator_names=[f'arm_j{i}_act' for i in range(1, 7)],
        gripper_joint_name='arm/grip/gripper',
        gripper_actuator_name='arm/grip/gripper_act',
        camera_names=('overhead_cam',),
        depth_cameras=('overhead_cam',),
        camera_hw=self._camera_hw,
        extra_devices=extra_devices,
        reset_fn=_reset_workcell,
    )
    return dl, dl.reset, dl.close

  def deployment_keys(self) -> tuple[frozenset[str], frozenset[str]]:
    meas_keys = frozenset({
        *(f'joint_position/j{i}' for i in range(1, 7)),
        'joint_position/gripper',
        'overhead_cam',
        'overhead_cam_depth',
    })
    cmd_keys = frozenset({
        *(f'goal_position/j{i}' for i in range(1, 7)),
        'goal_position/gripper',
    })
    return meas_keys, cmd_keys

  def success(
      self, poses: Mapping[str, np.ndarray], poses0: Mapping[str, np.ndarray]
  ) -> bool:
    del poses0
    tray_p = np.asarray(poses[self.target_body], dtype=np.float64)
    oven_p = np.asarray(poses[self.support_body], dtype=np.float64)
    rel_world = tray_p[:3] - oven_p[:3]
    local_xyz = _quat_rot(_quat_inv(oven_p[3:7]), rel_world)
    dx = abs(float(local_xyz[0]) - ws.OVEN_RAIL2_OFFSET[0])
    dy = abs(float(local_xyz[1]) - ws.OVEN_RAIL2_OFFSET[1])
    dz = abs(float(local_xyz[2]) - ws.OVEN_RAIL2_OFFSET[2])
    tray_up = _quat_rot(tray_p[3:7], np.array([0.0, 0.0, 1.0]))
    oven_up = _quat_rot(oven_p[3:7], np.array([0.0, 0.0, 1.0]))
    level_cos = float(np.dot(tray_up, oven_up))
    return dx < 0.022 and dy < 0.045 and dz < 0.012 and level_cos > math.cos(math.radians(5.0))


if __name__ == '__main__':
  from robosim_gauntlet import preflight

  task = BakeryTrayRail2Task()
  issues = preflight.run(task)
  print('PREFLIGHT ISSUES:', issues)
  if issues:
    raise SystemExit(1)
  print('PREFLIGHT PASSED WITH ZERO ISSUES!')
