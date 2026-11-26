"""Pure C++ MuJoCo 4.0 DeviceLayer + minimal shims for unmodified `robosim_gauntlet`.

Runs the unmodified `robosim_gauntlet` package verbatim against C++ MuJoCo 4.0.1
without requiring `mujoco_playground` or `reaf` wheel installations on macOS.
Offline verification only (Plan 42B keeps production controllers in Rust).
"""

from __future__ import annotations

import enum
import math
import pathlib
import sys
import types
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import dm_env
from dm_env import specs
import mujoco
import numpy as np
import torch

GAUNTLET_SRC = pathlib.Path(
    '/Users/pta/.gemini/config/plugins/robotics/skills/sim2real-gauntlet/src'
)


def install_gauntlet_shims() -> None:
  """Register minimal `mujoco_playground` and `reaf` modules and add `robosim_gauntlet` to sys.path."""
  if str(GAUNTLET_SRC) not in sys.path:
    sys.path.insert(0, str(GAUNTLET_SRC))

  if 'mujoco_playground.wrapper' not in sys.modules:
    mp_pkg = sys.modules.setdefault('mujoco_playground', types.ModuleType('mujoco_playground'))
    mp_wrapper = types.ModuleType('mujoco_playground.wrapper')

    class DeviceLayerWrapper:
      """Base forwarding wrapper matching `mujoco_playground.wrapper.DeviceLayerWrapper`."""

      def __init__(self, device_layer: Any):
        self._device_layer = device_layer

      @property
      def unwrapped(self) -> Any:
        cur = self._device_layer
        while isinstance(cur, DeviceLayerWrapper):
          cur = cur._device_layer
        return cur

      def commands_spec(self) -> Mapping[str, specs.Array]:
        return self._device_layer.commands_spec()

      def measurements_spec(self) -> Mapping[str, specs.Array]:
        return self._device_layer.measurements_spec()

      def begin_stepping(self) -> Mapping[str, Any]:
        return self._device_layer.begin_stepping()

      def step(self, commands: Mapping[str, Any]) -> Mapping[str, Any]:
        return self._device_layer.step(commands)

      def end_stepping(self) -> None:
        return self._device_layer.end_stepping()

      def __getattr__(self, name: str) -> Any:
        return getattr(self._device_layer, name)

    mp_wrapper.DeviceLayerWrapper = DeviceLayerWrapper
    mp_pkg.wrapper = mp_wrapper
    sys.modules['mujoco_playground.wrapper'] = mp_wrapper

    mp_real = types.ModuleType('mujoco_playground.real')

    def _raise_import_error(*_args: Any, **_kwargs: Any) -> Any:
      raise ImportError('Using robosim_gauntlet built-in _FallbackMcapLogger')

    mp_real.create_logger = _raise_import_error
    mp_pkg.real = mp_real
    sys.modules['mujoco_playground.real'] = mp_real

  if 'reaf.simulation.torch' not in sys.modules:
    reaf_pkg = sys.modules.setdefault('reaf', types.ModuleType('reaf'))
    reaf_sim_pkg = sys.modules.setdefault('reaf.simulation', types.ModuleType('reaf.simulation'))
    reaf_torch = types.ModuleType('reaf.simulation.torch')

    class Device:
      def initialize(self, simulator: Any) -> None:
        pass

      def reset(self, simulator: Any, env_mask: Any = None) -> None:
        pass

      def on_begin_stepping(self, simulator: Any, env_mask: Any = None) -> None:
        pass

      def on_substep(self, simulator: Any) -> None:
        pass

      def on_step(self, simulator: Any) -> None:
        pass

      def substep_measurements_spec(self) -> Mapping[str, specs.Array]:
        return {}

      def get_measurements(self, simulator: Any) -> Mapping[str, torch.Tensor]:
        return {}

    class Component:
      def __init__(self, cls: type, *args: Any, **kwargs: Any):
        self.cls = cls
        self.args = args
        self.kwargs = dict(kwargs)
        self.privileged = False

      def mark_privileged(self) -> 'Component':
        self.privileged = True
        return self

    flat_scene = types.SimpleNamespace(Component=Component)
    reaf_torch.Device = Device
    reaf_torch.flat_scene = flat_scene
    reaf_sim_pkg.torch = reaf_torch
    reaf_pkg.simulation = reaf_sim_pkg
    sys.modules['reaf.simulation.torch'] = reaf_torch


class _SimImpl(enum.Enum):
  CPP = 'cpp'


class _ModelFieldProxy:
  """Maps `sim.model.<field>[0, idx]` torch-style batched reads/writes onto `mj_model.<field>[idx]`."""

  def __init__(self, arr: np.ndarray):
    self._arr = arr

  def __getitem__(self, key: Any) -> torch.Tensor:
    if isinstance(key, tuple):
      assert key[0] == 0
      sub = self._arr[key[1:]] if len(key) > 2 else self._arr[key[1]]
    else:
      assert key == 0
      sub = self._arr
    return torch.as_tensor(np.array(sub, copy=True))

  def __setitem__(self, key: Any, value: Any) -> None:
    val = value.detach().cpu().numpy() if isinstance(value, torch.Tensor) else np.asarray(value)
    if isinstance(key, tuple):
      assert key[0] == 0
      if len(key) > 2:
        self._arr[key[1:]] = val
      else:
        self._arr[key[1]] = val
    else:
      assert key == 0
      self._arr[:] = val


class _ModelProxy:
  """Batched-view proxy over `mujoco.MjModel` for `robosim_gauntlet.perturb.apply_static`."""

  def __init__(self, mj_model: mujoco.MjModel):
    self._mjm = mj_model

  def __getattr__(self, name: str) -> _ModelFieldProxy:
    return _ModelFieldProxy(getattr(self._mjm, name))


class MuJoCoSim:
  """Minimal simulator handle matching the `raw.sim` surface used by `robosim_gauntlet`."""

  def __init__(self, spec: mujoco.MjSpec):
    self.impl = _SimImpl.CPP
    self.mj_spec = spec
    self.mj_model = spec.compile()
    self.mj_data = mujoco.MjData(self.mj_model)
    self.model = _ModelProxy(self.mj_model)

  def set_const(self) -> None:
    qpos = self.mj_data.qpos.copy()
    qvel = self.mj_data.qvel.copy()
    ctrl = self.mj_data.ctrl.copy()
    mujoco.mj_setConst(self.mj_model, self.mj_data)
    self.mj_data.qpos[:] = qpos
    self.mj_data.qvel[:] = qvel
    self.mj_data.ctrl[:] = ctrl
    mujoco.mj_forward(self.mj_model, self.mj_data)


class MuJoCoDeviceLayer:
  """Numpy `DeviceLayer` backed by C++ MuJoCo 4.0 + offscreen RGB-D cameras.

  Exposes:
  - Joint measurements: `joint_position/j1..j6`, `joint_position/gripper`
  - Joint commands: `goal_position/j1..j6`, `goal_position/gripper`
  - Camera measurements: `overhead_cam` (RGB uint8), `overhead_cam_depth` (metric meters float32),
    `wrist_cam` (RGB uint8)
  - Any `extra_devices` merged by `robosim_gauntlet` (`MonitorDevice`, `DisturbanceDevice`).
  """

  def __init__(
      self,
      spec: mujoco.MjSpec,
      *,
      control_dt_s: float = 0.02,
      arm_joint_names: Sequence[str],
      arm_actuator_names: Sequence[str],
      gripper_joint_name: str,
      gripper_actuator_name: str,
      camera_names: Sequence[str] = ('overhead_cam',),
      depth_cameras: Sequence[str] = ('overhead_cam',),
      camera_hw: tuple[int, int] = (240, 320),
      render_geomgroup_3: bool = False,
      extra_devices: Mapping[str, Any] | None = None,
      reset_fn: Callable[[MuJoCoSim], None] | None = None,
  ):
    self.sim = MuJoCoSim(spec)
    self._control_dt_s = float(control_dt_s)
    self._substeps = max(1, round(self._control_dt_s / float(self.sim.mj_model.opt.timestep)))
    self._reset_fn = reset_fn
    self._camera_names = tuple(camera_names)
    self._depth_cameras = frozenset(depth_cameras)
    self._cam_h, self._cam_w = int(camera_hw[0]), int(camera_hw[1])
    self._render_geomgroup_3 = bool(render_geomgroup_3)
    self._scene_option: mujoco.MjvOption | None = None
    if self._render_geomgroup_3:
      self._scene_option = mujoco.MjvOption()
      self._scene_option.geomgroup[3] = 1
    self._renderers: dict[tuple[int, int], mujoco.Renderer] = {}
    self._frame_cache_time: float = -1.0
    self._frame_cache: dict[str, np.ndarray] = {}

    m = self.sim.mj_model
    self._joint_keys: list[tuple[str, int, int]] = []
    self._cmd_keys: list[tuple[str, int, tuple[float, float]]] = []
    for idx, (jn, an) in enumerate(zip(arm_joint_names, arm_actuator_names), 1):
      jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, jn)
      aid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, an)
      assert jid >= 0 and aid >= 0, f'Missing joint/actuator {jn}/{an}'
      lo, hi = float(m.jnt_range[jid, 0]), float(m.jnt_range[jid, 1])
      self._joint_keys.append((f'joint_position/j{idx}', int(m.jnt_qposadr[jid]), jid))
      self._cmd_keys.append((f'goal_position/j{idx}', aid, (lo, hi)))

    gjid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, gripper_joint_name)
    gaid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, gripper_actuator_name)
    assert gjid >= 0 and gaid >= 0, f'Missing gripper {gripper_joint_name}/{gripper_actuator_name}'
    if bool(m.actuator_ctrllimited[gaid]):
      glo, ghi = float(m.actuator_ctrlrange[gaid, 0]), float(m.actuator_ctrlrange[gaid, 1])
    else:
      glo, ghi = float(m.jnt_range[gjid, 0]), float(m.jnt_range[gjid, 1])
    self._joint_keys.append(('joint_position/gripper', int(m.jnt_qposadr[gjid]), gjid))
    self._cmd_keys.append(('goal_position/gripper', gaid, (glo, ghi)))

    self._cmd_map = {k: (aid, bounds) for k, aid, bounds in self._cmd_keys}
    self._cam_ids = {
        cname: mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_CAMERA, cname)
        for cname in self._camera_names
    }
    for cname, cid in self._cam_ids.items():
      assert cid >= 0, f'Missing camera {cname}'

    # Instantiate extra devices (`MonitorDevice`, `DisturbanceDevice`)
    self.devices: dict[str, Any] = {}
    for dname, comp in (extra_devices or {}).items():
      dev = comp.cls(*getattr(comp, 'args', ()), **comp.kwargs)
      dev.initialize(self.sim)
      self.devices[dname] = dev

    self._build_specs()
    self.reset()

  def _build_specs(self) -> None:
    m = self.sim.mj_model
    self._cmd_spec: dict[str, specs.BoundedArray] = {}
    for k, _, (lo, hi) in self._cmd_keys:
      self._cmd_spec[k] = specs.BoundedArray((), np.float32, minimum=lo, maximum=hi, name=k)

    self._meas_spec: dict[str, specs.Array] = {}
    for k, _, jid in self._joint_keys:
      lo, hi = float(m.jnt_range[jid, 0]), float(m.jnt_range[jid, 1])
      self._meas_spec[k] = specs.BoundedArray((), np.float32, minimum=lo, maximum=hi, name=k)

    for cname in self._camera_names:
      self._meas_spec[cname] = specs.BoundedArray(
          (self._cam_h, self._cam_w, 3), np.uint8, minimum=0, maximum=255, name=cname
      )
      if cname in self._depth_cameras:
        self._meas_spec[f'{cname}_depth'] = specs.Array(
            (self._cam_h, self._cam_w), np.float32, name=f'{cname}_depth'
        )

    for dev in self.devices.values():
      for k, sp in dev.substep_measurements_spec().items():
        self._meas_spec[k] = sp

  def _get_renderer(self) -> mujoco.Renderer:
    key = (self._cam_h, self._cam_w)
    if key not in self._renderers:
      self._renderers[key] = mujoco.Renderer(self.sim.mj_model, height=self._cam_h, width=self._cam_w)
    return self._renderers[key]

  def reset(self) -> None:
    mujoco.mj_resetData(self.sim.mj_model, self.sim.mj_data)
    if self._reset_fn is not None:
      self._reset_fn(self.sim)
    mujoco.mj_forward(self.sim.mj_model, self.sim.mj_data)
    for dev in self.devices.values():
      dev.reset(self.sim)
      dev.on_begin_stepping(self.sim)
    self._frame_cache_time = -1.0
    self._frame_cache.clear()

  def get_device(self, name: str) -> Any:
    return self.devices[name]

  def forward(self) -> None:
    mujoco.mj_forward(self.sim.mj_model, self.sim.mj_data)

  def close(self) -> None:
    for r in self._renderers.values():
      try:
        r.close()
      except Exception:
        pass
    self._renderers.clear()

  def commands_spec(self) -> Mapping[str, specs.Array]:
    return dict(self._cmd_spec)

  def measurements_spec(self) -> Mapping[str, specs.Array]:
    return dict(self._meas_spec)

  def begin_stepping(self) -> dict[str, np.ndarray]:
    mujoco.mj_forward(self.sim.mj_model, self.sim.mj_data)
    for dev in self.devices.values():
      dev.on_begin_stepping(self.sim)
    self._frame_cache_time = -1.0
    self._frame_cache.clear()
    return self._read_all_measurements()

  def end_stepping(self) -> None:
    pass

  def step(self, commands: Mapping[str, Any] | None = None) -> dict[str, np.ndarray]:
    if commands:
      for k, val in commands.items():
        if k in self._cmd_map:
          aid, (lo, hi) = self._cmd_map[k]
          self.sim.mj_data.ctrl[aid] = float(np.clip(float(np.asarray(val).reshape(())), lo, hi))
    m, d = self.sim.mj_model, self.sim.mj_data
    for _ in range(self._substeps):
      mujoco.mj_step(m, d)
      for dev in self.devices.values():
        dev.on_substep(self.sim)
    for dev in self.devices.values():
      dev.on_step(self.sim)
    self._frame_cache_time = -1.0
    self._frame_cache.clear()
    return self._read_all_measurements()

  def _render_camera(self, cname: str, depth: bool) -> np.ndarray:
    cache_key = f'{cname}_depth' if depth else cname
    t_now = float(self.sim.mj_data.time)
    if self._frame_cache_time == t_now and cache_key in self._frame_cache:
      return self._frame_cache[cache_key]
    r = self._get_renderer()
    if depth:
      r.enable_depth_rendering()
    else:
      r.disable_depth_rendering()
    if self._scene_option is not None:
      r.update_scene(self.sim.mj_data, camera=self._cam_ids[cname], scene_option=self._scene_option)
    else:
      r.update_scene(self.sim.mj_data, camera=self._cam_ids[cname])
    img = r.render().copy()
    if depth:
      r.disable_depth_rendering()
      img = img.astype(np.float32)
    else:
      img = img.astype(np.uint8)
    self._frame_cache_time = t_now
    self._frame_cache[cache_key] = img
    return img

  def _read_all_measurements(self, keys: Sequence[str] | None = None) -> dict[str, np.ndarray]:
    wanted = set(self._meas_spec.keys()) if keys is None else set(keys)
    out: dict[str, np.ndarray] = {}
    d = self.sim.mj_data

    for k, qadr, _ in self._joint_keys:
      if k in wanted:
        out[k] = np.array(d.qpos[qadr], dtype=np.float32)

    for cname in self._camera_names:
      if cname in wanted:
        out[cname] = self._render_camera(cname, depth=False)
      dk = f'{cname}_depth'
      if cname in self._depth_cameras and dk in wanted:
        out[dk] = self._render_camera(cname, depth=True)

    for dev in self.devices.values():
      dev_keys = dev.substep_measurements_spec().keys()
      if any(k in wanted for k in dev_keys):
        for k, tensor in dev.get_measurements(self.sim).items():
          if k in wanted:
            arr = tensor.detach().cpu().numpy()
            if arr.ndim > 0 and arr.shape[0] == 1:
              arr = arr[0]
            out[k] = arr

    return out
