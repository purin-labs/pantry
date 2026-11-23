"""Shared message definitions between sim_plugin.py and viewer_plugin.py.

Standalone MuJoCo Studio preview workspace for the upgraded Maruzen MBCO-4ME
convection oven and FAIRINO FR10 bakery workcell (offline visualization only;
production workflow controllers remain in crates/bakery-native per Plan 42B).
"""

from __future__ import annotations

import dataclasses

from mujoco.studio import messages


@dataclasses.dataclass(frozen=True)
class RenderLightingConfig(messages.Snapshot):
  """UI -> sim: Filament PBR lighting & post-processing parameters."""

  exposure: float = 0.45
  ibl_intensity: float = 30000.0
  bay_intensity: float = 28000.0
  bloom_enabled: bool = True
  bloom_strength: float = 0.18
  ssao_enabled: bool = True
  tone_mapping: str = 'aces'
  pastry_load: bool = True


@dataclasses.dataclass(frozen=True)
class WorkcellControl(messages.Snapshot):
  """UI -> sim: live oven actuators, real-contact FR10 cycle mode, and ghost preview."""

  door_deg: float = 108.0
  handle_deg: float = 0.0
  fan_rad_s: float = 0.0
  damper_deg: float = 0.0
  robot_mode: str = 'contact_cycle'
  manual_joints_deg: tuple[float, ...] = (-22.0, -96.0, 124.0, -28.0, 68.0, 90.0)
  gripper_open_mm: float = 45.0
  show_ghost_path: bool = True
  ghost_progress: float = 0.55


@dataclasses.dataclass(frozen=True)
class StageTrayEvent(messages.Event):
  """UI -> sim: reset tray on prep table (or Rail #2) and restart contact cycle if active."""

  target: str = 'prep_table'  # 'prep_table' or 'oven_rail2'


@dataclasses.dataclass(frozen=True)
class OvenPresetEvent(messages.Event):
  """UI -> sim: apply a coordinated oven + robot visual preset."""

  preset: str = 'open_load'  # 'open_load' or 'close_bake'


@dataclasses.dataclass(frozen=True)
class BakeSceneEvent(messages.Event):
  """UI -> sim: bake the current Python MjSpec to scene.xml on user request."""


@dataclasses.dataclass(frozen=True)
class WorkcellTelemetry(messages.Snapshot):
  """sim -> UI: live workcell state, real-contact safety forces & planned trajectory."""

  sim_time: float = 0.0
  phase_label: str = 'Initializing'
  door_deg: float = 0.0
  handle_deg: float = 0.0
  fan_rpm: float = 0.0
  damper_deg: float = 0.0
  grasp_force_n: float = 0.0
  env_force_n: float = 0.0
  rail2_touch_n: float = 0.0
  tray_on_rail2: bool = False
  safety_ok: bool = True
  arm_joints_deg: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
  ee_pos: tuple[float, float, float] = (0.0, 0.0, 0.0)
  path_points: tuple[tuple[float, float, float], ...] = ()
  ghost_ee_pos: tuple[float, float, float] = (-0.49, -0.48, 1.15)
  ghost_ee_mat: tuple[float, ...] = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
  ghost_arm_joints: tuple[tuple[float, float, float], ...] = ()
