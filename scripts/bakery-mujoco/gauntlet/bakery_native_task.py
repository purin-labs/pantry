"""`robosim_gauntlet` Tasks built directly from the verified production `bakery-native` MJCF fixtures.

Loads the exact compiled production XMLs under `assets/bakery-mujoco/fr10-workcell/native/`
and initializes each task from `bakery-gauntlet --dump-init` so the Gauntlet plant matches
the shipped Rust controller (`crates/bakery-native`) down to geometry, mass, inertia, actuator
limits, and handoff state.
"""

from __future__ import annotations

import dataclasses
import functools
import json
import math
import pathlib
import subprocess
import sys
from collections.abc import Callable, Mapping
from typing import Any

import mujoco
import numpy as np

GAUNTLET_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = GAUNTLET_DIR.parents[2]
if str(GAUNTLET_DIR) not in sys.path:
  sys.path.insert(0, str(GAUNTLET_DIR))

import mujoco_device_layer as mdl  # noqa: E402

mdl.install_gauntlet_shims()

from robosim_gauntlet import task as task_lib  # noqa: E402

DEFAULT_BINARY = REPO_ROOT / 'crates/bakery-native/target/release/bakery-gauntlet'


def _quat_inv(q: np.ndarray) -> np.ndarray:
  return np.array([q[0], -q[1], -q[2], -q[3]], dtype=np.float64)


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
  out = np.zeros(4, dtype=np.float64)
  mujoco.mju_mulQuat(out, np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64))
  return out


def _quat_rot(q: np.ndarray, v: np.ndarray) -> np.ndarray:
  r = np.zeros(9, dtype=np.float64)
  mujoco.mju_quat2Mat(r, np.asarray(q, dtype=np.float64))
  return r.reshape(3, 3) @ np.asarray(v, dtype=np.float64)


@dataclasses.dataclass(frozen=True)
class NativeTaskPreset:
  """One production `bakery-native` cell + robot + transfer task."""

  task_id: str
  robot: str
  cell: str
  task: str
  support_body: str
  prompt: str
  ingredient_mass_kg: float = 1.0
  clamp_force_n: float = 100.0
  control_dt_s: float = 0.02
  episode_s: float = 48.0
  cam_pos: tuple[float, float, float] = (0.02, -0.02, 2.72)
  cam_fovy_deg: float = 56.0
  max_grasp_force_n: float = 35.0
  max_contact_force_n: float = 60.0
  max_impact_force_n: float = 300.0
  max_joint_speed: float = 4.0
  goal_tol_xyz: tuple[float, float, float] = (0.022, 0.045, 0.012)


PRESETS: dict[str, NativeTaskPreset] = {
    'fr10_spanner_oven_load': NativeTaskPreset(
        task_id='fr10_spanner_oven_load',
        robot='fairino-fr10',
        cell='spanner-oven',
        task='table-to-oven',
        support_body='mbco4_oven',
        prompt=(
            'Load the 400x300 mm tray from the prep table onto Rail #2 of the '
            'Maruzen MBCO-4ME convection oven using the FR10 spanner gripper.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=44.0,
        cam_pos=(0.02, -0.02, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=35.0,
        max_contact_force_n=60.0,
        goal_tol_xyz=(0.022, 0.045, 0.012),
    ),
    'fr10_spanner_oven_unload': NativeTaskPreset(
        task_id='fr10_spanner_oven_unload',
        robot='fairino-fr10',
        cell='spanner-oven',
        task='oven-to-table',
        support_body='cell_table',
        prompt=(
            'Retrieve the 400x300 mm tray from Rail #2 of the Maruzen MBCO-4ME '
            'convection oven and place it on the stainless prep table.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=44.0,
        cam_pos=(0.02, -0.02, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=35.0,
        max_contact_force_n=60.0,
        goal_tol_xyz=(0.035, 0.035, 0.015),
    ),
    'ur5e_combined_oven_load': NativeTaskPreset(
        task_id='ur5e_combined_oven_load',
        robot='universal-robots-ur5e',
        cell='combined',
        task='table-to-oven',
        support_body='mbco_oven',
        prompt=(
            'Load the 600x400 mm tray from the prep table into slot 3 of the '
            'Maruzen MBCO-5E oven in the UR5e combined cell.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=52.0,
        cam_pos=(1.05, 0.0, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.030, 0.035, 0.015),
    ),
    'ur5e_combined_oven_unload': NativeTaskPreset(
        task_id='ur5e_combined_oven_unload',
        robot='universal-robots-ur5e',
        cell='combined',
        task='oven-to-table',
        support_body='cell_table',
        prompt=(
            'Retrieve the 600x400 mm tray from slot 3 of the Maruzen MBCO-5E '
            'oven back onto the prep table in the UR5e combined cell.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=54.0,
        cam_pos=(1.05, 0.0, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.035, 0.035, 0.015),
    ),
    'ur5e_combined_rack': NativeTaskPreset(
        task_id='ur5e_combined_rack',
        robot='universal-robots-ur5e',
        cell='combined',
        task='table-to-rack',
        support_body='cell_rack',
        prompt=(
            'Transfer the retrieved 600x400 mm tray from the prep table onto '
            'the receiving cooling rack in the UR5e combined cell.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=50.0,
        cam_pos=(1.05, -0.15, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.035, 0.035, 0.015),
    ),
    'crx10_combined_oven_load': NativeTaskPreset(
        task_id='crx10_combined_oven_load',
        robot='fanuc-crx10ial',
        cell='combined',
        task='table-to-oven',
        support_body='mbco_oven',
        prompt=(
            'Load the 600x400 mm tray from the prep table into slot 3 of the '
            'Maruzen MBCO-5E oven in the FANUC CRX-10iA/L combined cell.'
        ),
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=52.0,
        cam_pos=(1.15, -0.05, 2.85),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.030, 0.035, 0.015),
    ),
    'fr10_table_to_rack': NativeTaskPreset(
        task_id='fr10_table_to_rack',
        robot='fairino-fr10',
        cell='separate',
        task='table-to-rack',
        support_body='cell_rack',
        prompt='Transfer the loaded 600x400 mm tray from the prep table onto the cooling rack.',
        ingredient_mass_kg=1.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=46.0,
        cam_pos=(1.05, 0.0, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.035, 0.035, 0.015),
    ),
    'fr10_pan_staging': NativeTaskPreset(
        task_id='fr10_pan_staging',
        robot='fairino-fr10',
        cell='pan-staging',
        task='table-to-rack',
        support_body='cell_rack',
        prompt='Transfer the empty 4-cavity baking pan from the prep table onto the staging rack.',
        ingredient_mass_kg=0.0,
        clamp_force_n=100.0,
        control_dt_s=0.02,
        episode_s=46.0,
        cam_pos=(1.05, 0.0, 2.72),
        cam_fovy_deg=56.0,
        max_grasp_force_n=155.0,
        max_contact_force_n=125.0,
        goal_tol_xyz=(0.035, 0.035, 0.015),
    ),
}


@functools.lru_cache(maxsize=32)
def dump_native_init(
    binary: str,
    robot: str,
    cell: str,
    task: str,
    ingredient_mass_kg: float,
    clamp_force_n: float,
) -> dict[str, Any]:
  """Query `bakery-gauntlet --dump-init` for the exact production initial state."""
  cmd = [
      binary,
      '--root',
      str(REPO_ROOT),
      '--robot',
      robot,
      '--cell',
      cell,
      '--task',
      task,
      '--ingredient-mass-kg',
      f'{ingredient_mass_kg}',
      '--clamp-force-n',
      f'{clamp_force_n}',
      '--dump-init',
  ]
  out = subprocess.check_output(cmd, cwd=str(REPO_ROOT), text=True)
  return json.loads(out)


class BakeryNativeTask:
  """`robosim_gauntlet.task.Task` backed directly by a production `bakery-native` MJCF."""

  def __init__(
      self,
      preset: NativeTaskPreset,
      *,
      binary: pathlib.Path = DEFAULT_BINARY,
      camera_hw: tuple[int, int] = (240, 320),
      include_cameras: bool = True,
      plant_ingredient_mass_kg: float | None = None,
      plant_ingredient_forward_mm: float = 0.0,
      plant_ingredient_lateral_mm: float = 0.0,
      plant_pad_friction_scale: float = 1.0,
  ):
    self.preset = preset
    self.binary = pathlib.Path(binary)
    self.name = preset.task_id
    self.task_id = preset.task_id
    self.prompt = preset.prompt
    self.control_dt_s = preset.control_dt_s
    self.episode_s = preset.episode_s
    self.horizon_s = preset.episode_s
    self.target_body = 'mbco_tray'
    self.support_body = preset.support_body
    self.bystander_bodies = ('bystander_dish',)
    self.robot_pattern = rf'^({preset.robot}__|cell_gripper|cell_upper_jaw)'
    self.pad_pattern = r'^(cell_gripper|cell_upper_jaw)$'
    self._include_cameras = bool(include_cameras)
    self.camera_keys = ('overhead_cam',) if self._include_cameras else ()
    self._camera_hw = camera_hw
    self._plant_mass = (
        preset.ingredient_mass_kg
        if plant_ingredient_mass_kg is None
        else float(plant_ingredient_mass_kg)
    )
    self._plant_fwd_mm = float(plant_ingredient_forward_mm)
    self._plant_lat_mm = float(plant_ingredient_lateral_mm)
    self._plant_pad_friction_scale = float(plant_pad_friction_scale)

    self.init_info = dump_native_init(
        str(self.binary),
        preset.robot,
        preset.cell,
        preset.task,
        preset.ingredient_mass_kg,
        preset.clamp_force_n,
    )
    self._dest_site_world = np.array(self.init_info['destSite'], dtype=np.float64)
    self._is_spanner = bool(self.init_info['isSpanner'])
    self._nominal_tray_quat = (
        np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
        if self._is_spanner
        else np.array([math.sqrt(0.5), 0.0, 0.0, -math.sqrt(0.5)], dtype=np.float64)
    )
    # Compute destination offset in `support_body` local frame once on nominal XML
    m_nom = mujoco.MjModel.from_xml_path(str(REPO_ROOT / self.init_info['xmlPath']))
    d_nom = mujoco.MjData(m_nom)
    mujoco.mj_forward(m_nom, d_nom)
    sup_bid = m_nom.body(self.support_body).id
    sup_pos = np.asarray(d_nom.xpos[sup_bid], dtype=np.float64)
    sup_quat = np.asarray(d_nom.xquat[sup_bid], dtype=np.float64)
    self._dest_local_pos = _quat_rot(_quat_inv(sup_quat), self._dest_site_world - sup_pos)
    self._dest_local_quat = _quat_mul(_quat_inv(sup_quat), self._nominal_tray_quat)
    self._orig_nq = int(m_nom.nq)
    self._orig_nv = int(m_nom.nv)

    # Compute bystander position cleanly at the far back corner of `table_top`
    tbl_gid = mujoco.mj_name2id(m_nom, mujoco.mjtObj.mjOBJ_GEOM, 'table_top')
    tbl_pos = np.asarray(d_nom.geom_xpos[tbl_gid], dtype=np.float64)
    tbl_sz = np.asarray(m_nom.geom_size[tbl_gid], dtype=np.float64)
    self._bystander_pos = np.array(
        [
            tbl_pos[0] + tbl_sz[0] - 0.08,
            tbl_pos[1] + tbl_sz[1] - 0.08,
            tbl_pos[2] + tbl_sz[2] + 0.0355,
        ],
        dtype=np.float64,
    )

    init_state = np.asarray(self.init_info['integrationState'], dtype=np.float64)
    tray_jnt = m_nom.joint('mbco_tray_free').id
    tray_qadr = int(m_nom.jnt_qposadr[tray_jnt])
    start_tray_z = float(init_state[1 + tray_qadr + 2])
    drop_z_tol_m = max(
        0.05, max(0.0, start_tray_z - float(self._dest_site_world[2])) + 0.05
    )

    self.safety = task_lib.SafetyLimits(
        max_grasp_force_n=preset.max_grasp_force_n,
        max_contact_force_n=preset.max_contact_force_n,
        max_impact_force_n=preset.max_impact_force_n,
        max_self_contact_force_n=25.0,
        max_joint_speed=preset.max_joint_speed,
        joint_limit_margin=0.02,
        max_command_step_frac=0.25,
        bystander_tol_m=0.02,
        drop_z_tol_m=drop_z_tol_m,
        require_release=True,
        goal_setter=self._place_tray_at_goal,
    )

  def controller_cmd(self, mode: str) -> list[str]:
    """Return the out-of-process CLI invocation for `bakery-gauntlet`."""
    cx, cy, cz = self.preset.cam_pos
    return [
        str(self.binary),
        '--root',
        str(REPO_ROOT),
        '--robot',
        self.preset.robot,
        '--cell',
        self.preset.cell,
        '--task',
        self.preset.task,
        '--ingredient-mass-kg',
        f'{self.preset.ingredient_mass_kg}',
        '--clamp-force-n',
        f'{self.preset.clamp_force_n}',
        '--control-dt-s',
        f'{self.control_dt_s}',
        '--mode',
        mode,
        '--cam-pos',
        f'{cx},{cy},{cz}',
        '--cam-fovy-deg',
        f'{self.preset.cam_fovy_deg}',
    ]

  def _build_spec(self) -> mujoco.MjSpec:
    xml_path = REPO_ROOT / self.init_info['xmlPath']
    spec = mujoco.MjSpec.from_file(str(xml_path))
    spec.visual.global_.offwidth = self._camera_hw[1]
    spec.visual.global_.offheight = self._camera_hw[0]
    spec.visual.quality.offsamples = 0
    spec.visual.headlight.active = 1
    spec.visual.headlight.ambient = [0.48, 0.48, 0.50]
    spec.visual.headlight.diffuse = [0.65, 0.65, 0.65]

    # Mirror `crates/bakery-native/src/native/transfer.rs` compile() mutations verbatim
    try:
      contents = spec.geom('cold_contents')
      contents.mass = self._plant_mass
      if self._plant_mass == 0.0:
        contents.contype = 0
        contents.conaffinity = 0
      # Tray local Y points forward; local X points toward negative lateral (transfer.rs:98)
      contents.pos[0] = -self._plant_lat_mm / 1000.0
      contents.pos[1] = self._plant_fwd_mm / 1000.0
    except Exception:
      pass

    tbl = spec.geom('table_top')
    tbl.priority = 1
    tbl.solref = [0.004, 1.0]
    tbl.solimp = [0.99, 0.999, 0.001, 0.5, 2.0]

    # Match `Engine::configure_clamp` force cap
    clamp_act = spec.actuator('clamp_servo')
    limit = min(self.preset.clamp_force_n, 15.5) if self._is_spanner else self.preset.clamp_force_n
    clamp_act.forcerange = [-limit, limit]

    # Remove the non-colliding, invisible, 1e-9 kg `ingredient_payload` placeholder
    # body so `MonitorDevice`'s `gauntlet/poses` stays <= 9 non-robot bodies (63 <= 64)
    # for unmodified `robosim_gauntlet.wrappers.Recorder(max_size=64)`.
    try:
      ip_body = spec.body('ingredient_payload')
      if ip_body is not None:
        spec.delete(ip_body)
    except Exception:
      pass

    # Make visible collision geoms (`group == 3`) opaque so MuJoCo's OpenGL depth
    # buffer renders solid steel trays, ovens, racks, and arms accurately without
    # altering any physics parameter.
    for g in spec.geoms:
      if g.group == 3 and g.rgba[3] > 0.1:
        g.rgba[3] = 1.0

    if self._plant_pad_friction_scale != 1.0:
      for g in spec.geoms:
        if g.name.startswith('clamp_'):
          g.friction[0] *= self._plant_pad_friction_scale

    # Add overhead RGB-D camera + scene lights (zero physical contact impact)
    spec.worldbody.add_light(
        pos=[self.preset.cam_pos[0], self.preset.cam_pos[1] - 0.8, 2.6],
        dir=[0.0, 0.30, -0.95],
        diffuse=[0.85, 0.85, 0.85],
    )
    spec.worldbody.add_camera(
        name='overhead_cam',
        pos=list(self.preset.cam_pos),
        xyaxes=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        fovy=self.preset.cam_fovy_deg,
    )
    if self._is_spanner:
      spec.worldbody.add_camera(
          name='hero_3_4',
          pos=[1.48, -2.52, 1.84],
          xyaxes=[0.84, 0.54, 0.0, -0.18, 0.28, 0.94],
      )
      spec.worldbody.add_camera(
          name='oven_closeup',
          pos=[-0.49, -1.08, 1.24],
          xyaxes=[1.0, 0.0, 0.0, 0.0, 0.12, 0.99],
      )
    else:
      spec.worldbody.add_camera(
          name='hero_3_4',
          pos=[-0.55, -1.75, 1.85],
          xyaxes=[0.78, -0.62, 0.0, 0.24, 0.30, 0.92],
      )
      spec.worldbody.add_camera(
          name='oven_closeup',
          pos=[0.72, -0.05, 1.12],
          xyaxes=[0.64, -0.77, 0.0, 0.28, 0.23, 0.93],
      )

    # Free bystander dish on far corner of prep table (for Gauntlet bystander_moved check)
    byst = spec.worldbody.add_body(name='bystander_dish', pos=list(self._bystander_pos))
    byst.add_freejoint(name='bystander_dish_free')
    byst.add_geom(
        name='bystander_dish_col',
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        size=[0.042, 0.035, 0.0],
        mass=0.25,
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.7, 0.015, 0.003],
        rgba=[0.22, 0.44, 0.72, 1.0],
    )
    return spec

  def _reset_workcell(self, sim: mdl.MuJoCoSim) -> None:
    m, d = sim.mj_model, sim.mj_data
    init_state = np.asarray(self.init_info['integrationState'], dtype=np.float64)
    # Restore exact production `qpos` (arm + jaw + tray + passive hinges) from `bakery-native`
    d.qpos[: self._orig_nq] = init_state[1 : 1 + self._orig_nq]
    d.qvel[:] = 0.0
    # Place bystander cleanly on prep table corner
    b_bid = m.body('bystander_dish').id
    b_jnt = int(m.body_jntadr[b_bid])
    b_adr = int(m.jnt_qposadr[b_jnt])
    d.qpos[b_adr : b_adr + 3] = self._bystander_pos
    d.qpos[b_adr + 3 : b_adr + 7] = [1.0, 0.0, 0.0, 0.0]

    # Set initial actuator ctrl to exact start joint angles + jaw opening
    for aname, val in zip(
        self.init_info['armActuatorNames'], self.init_info['startAngles']
    ):
      aid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, aname)
      d.ctrl[aid] = float(val)
    gaid = mujoco.mj_name2id(
        m, mujoco.mjtObj.mjOBJ_ACTUATOR, self.init_info['gripperActuatorName']
    )
    d.ctrl[gaid] = float(self.init_info['startJaw'])
    mujoco.mj_forward(m, d)

  def _place_tray_at_goal(
      self, sim: Any, p0: Mapping[str, np.ndarray] | None = None
  ) -> None:
    """Positive-control goal setter for `robosim_gauntlet.preflight.run`."""
    del p0
    m, d = sim.mj_model, sim.mj_data
    mujoco.mj_forward(m, d)
    sup_bid = m.body(self.support_body).id
    tray_bid = m.body(self.target_body).id
    sup_pos = np.asarray(d.xpos[sup_bid], dtype=np.float64)
    sup_quat = np.asarray(d.xquat[sup_bid], dtype=np.float64)
    world_goal = sup_pos + _quat_rot(sup_quat, self._dest_local_pos) + np.array([0.0, 0.0, 0.001])
    world_quat = _quat_mul(sup_quat, self._dest_local_quat)
    jnt = int(m.body_jntadr[tray_bid])
    jadr = int(m.jnt_qposadr[jnt])
    dadr = int(m.jnt_dofadr[jnt])
    d.qpos[jadr : jadr + 3] = world_goal
    d.qpos[jadr + 3 : jadr + 7] = world_quat
    d.qvel[dadr : dadr + 6] = 0.0
    mujoco.mj_forward(m, d)

  def build_device_layer(
      self, mode: str, *, extra_devices: Mapping[str, Any] | None = None
  ) -> tuple[Any, Callable[[], None], Callable[[], None]]:
    if mode != 'sim':
      raise ValueError(f'Only sim mode is supported for offline verification, got {mode!r}.')
    spec = self._build_spec()
    cams = ('overhead_cam',) if self._include_cameras else ()
    dl = mdl.MuJoCoDeviceLayer(
        spec,
        control_dt_s=self.control_dt_s,
        arm_joint_names=self.init_info['armJointNames'],
        arm_actuator_names=self.init_info['armActuatorNames'],
        gripper_joint_name=self.init_info['gripperJointName'],
        gripper_actuator_name=self.init_info['gripperActuatorName'],
        camera_names=cams,
        depth_cameras=cams,
        camera_hw=self._camera_hw,
        render_geomgroup_3=True,
        extra_devices=extra_devices,
        reset_fn=self._reset_workcell,
    )
    return dl, dl.reset, dl.close

  def deployment_keys(self) -> tuple[frozenset[str], frozenset[str]]:
    meas_keys = {
        *(f'joint_position/j{i}' for i in range(1, 7)),
        'joint_position/gripper',
    }
    if self._include_cameras:
      meas_keys.update({'overhead_cam', 'overhead_cam_depth'})
    cmd_keys = frozenset({
        *(f'goal_position/j{i}' for i in range(1, 7)),
        'goal_position/gripper',
    })
    return frozenset(meas_keys), cmd_keys

  def placement_error(
      self, poses: Mapping[str, np.ndarray]
  ) -> dict[str, float]:
    tray_p = np.asarray(poses[self.target_body], dtype=np.float64)
    sup_p = np.asarray(poses[self.support_body], dtype=np.float64)
    local_xyz = _quat_rot(_quat_inv(sup_p[3:7]), tray_p[:3] - sup_p[:3])
    diff = local_xyz - self._dest_local_pos
    tray_up = _quat_rot(tray_p[3:7], np.array([0.0, 0.0, 1.0]))
    sup_up = _quat_rot(sup_p[3:7], np.array([0.0, 0.0, 1.0]))
    tilt_deg = math.degrees(math.acos(float(np.clip(np.dot(tray_up, sup_up), -1.0, 1.0))))
    return {
        'dx_m': float(diff[0]),
        'dy_m': float(diff[1]),
        'dz_m': float(diff[2]),
        'pos_err_m': float(np.linalg.norm(diff)),
        'tilt_deg': float(tilt_deg),
    }

  def success(
      self, poses: Mapping[str, np.ndarray], poses0: Mapping[str, np.ndarray]
  ) -> bool:
    del poses0
    err = self.placement_error(poses)
    tx, ty, tz = self.preset.goal_tol_xyz
    return (
        abs(err['dx_m']) < tx
        and abs(err['dy_m']) < ty
        and abs(err['dz_m']) < tz
        and err['tilt_deg'] < 5.0
    )


def make_task(task_id: str, **kwargs: Any) -> BakeryNativeTask:
  if task_id not in PRESETS:
    raise KeyError(f'Unknown task_id {task_id!r}; choose from {sorted(PRESETS)}')
  return BakeryNativeTask(PRESETS[task_id], **kwargs)
