"""Viewer-side Dear ImGui & 3D Ghost Planned-Path plugin for Bakery Workcell.

Renders translucent ghost planned-path trajectory overlays via
`self.viewer.extra_geoms` on UpdateEvent and provides aligned Dear ImGui
controls for the upgraded Maruzen MBCO-4ME oven, FAIRINO FR10 preview arm,
and Filament PBR lighting on BuildGuiEvent.
"""

from __future__ import annotations

import os
import pathlib

import messages as user_messages
import mujoco
from mujoco.studio import messages
from mujoco.studio import plugin
from mujoco.studio.app import plugins as app_plugins
import numpy as np

imgui = app_plugins.imgui

WORKSPACE_DIR = pathlib.Path(os.path.abspath(__file__)).parent
ROBOT_MODES = (
    ('auto_demo', 'Auto Demo (Prep <-> Oven)'),
    ('home', 'Home Standby'),
    ('prep_table', 'Prep Table Staging'),
    ('transit', 'Transit Lift'),
    ('oven_mouth', 'Oven Mouth Approach'),
    ('oven_insert', 'Oven Rail #2 Insert'),
    ('manual', 'Manual Joints'),
)
TONE_MAPPINGS = ('aces', 'pbr_neutral', 'filmic')


def _short_path(path: pathlib.Path) -> str:
  home = pathlib.Path.home()
  return (
      '~/' + str(path.relative_to(home))
      if path.is_relative_to(home)
      else str(path)
  )


def _make_sphere(
    pos: np.ndarray, radius: float, rgba: tuple[float, float, float, float]
) -> mujoco.MjvGeom:
  geom = mujoco.MjvGeom()
  mujoco.mjv_initGeom(
      geom,
      int(mujoco.mjtGeom.mjGEOM_SPHERE),
      np.array([radius, 0.0, 0.0], dtype=np.float64),
      np.asarray(pos, dtype=np.float64),
      np.eye(3, dtype=np.float64).flatten(),
      np.array(rgba, dtype=np.float32),
  )
  return geom


def _make_connector(
    geom_type: int,
    width: float,
    p0: np.ndarray,
    p1: np.ndarray,
    rgba: tuple[float, float, float, float],
) -> mujoco.MjvGeom:
  geom = mujoco.MjvGeom()
  mujoco.mjv_initGeom(
      geom,
      geom_type,
      np.zeros(3, dtype=np.float64),
      np.zeros(3, dtype=np.float64),
      np.eye(3, dtype=np.float64).flatten(),
      np.array(rgba, dtype=np.float32),
  )
  mujoco.mjv_connector(
      geom,
      geom_type,
      float(width),
      np.asarray(p0, dtype=np.float64),
      np.asarray(p1, dtype=np.float64),
  )
  return geom


def _make_box(
    pos: np.ndarray,
    mat: np.ndarray,
    size: tuple[float, float, float],
    rgba: tuple[float, float, float, float],
) -> mujoco.MjvGeom:
  geom = mujoco.MjvGeom()
  mujoco.mjv_initGeom(
      geom,
      int(mujoco.mjtGeom.mjGEOM_BOX),
      np.array(size, dtype=np.float64),
      np.asarray(pos, dtype=np.float64),
      np.asarray(mat, dtype=np.float64).flatten(),
      np.array(rgba, dtype=np.float32),
  )
  return geom


class ViewerPlugin(plugin.ViewerPlugin):
  """Bakery Workcell Inspector: Filament PBR lighting, oven, robot & ghost path."""

  # Class-level defaults survive --hot_reload swaps without losing live state.
  window_open: bool = True

  # Filament PBR lighting settings
  exposure: float = 0.45
  ibl_intensity: float = 30000.0
  bay_intensity: float = 28000.0
  bloom_enabled: bool = True
  bloom_strength: float = 0.18
  ssao_enabled: bool = True
  tone_mapping_idx: int = 0
  pastry_load: bool = True

  # Oven & robot live control settings
  door_deg: float = 82.0
  handle_deg: float = 0.0
  fan_rad_s: float = 95.0
  damper_deg: float = 18.0
  robot_mode_idx: int = 0
  manual_j1: float = 10.0
  manual_j2: float = -78.0
  manual_j3: float = 96.0
  manual_j4: float = -108.0
  manual_j5: float = -90.0
  manual_j6: float = 0.0
  clamp_open_mm: float = 28.0

  # Ghost planned-path overlay settings
  show_ghost_path: bool = True
  ghost_opacity: float = 0.42
  ghost_progress: float = 0.55

  telemetry: user_messages.WorkcellTelemetry = user_messages.WorkcellTelemetry()

  @messages.handler
  def on_telemetry(self, snapshot: user_messages.WorkcellTelemetry) -> None:
    self.telemetry = snapshot

  def _send_lighting(self) -> None:
    self.viewer.send_to_sim(
        user_messages.RenderLightingConfig(
            exposure=self.exposure,
            ibl_intensity=self.ibl_intensity,
            bay_intensity=self.bay_intensity,
            bloom_enabled=self.bloom_enabled,
            bloom_strength=self.bloom_strength,
            ssao_enabled=self.ssao_enabled,
            tone_mapping=TONE_MAPPINGS[self.tone_mapping_idx],
            pastry_load=self.pastry_load,
        )
    )

  def _send_control(self) -> None:
    self.viewer.send_to_sim(
        user_messages.WorkcellControl(
            door_deg=self.door_deg,
            handle_deg=self.handle_deg,
            fan_rad_s=self.fan_rad_s,
            damper_deg=self.damper_deg,
            robot_mode=ROBOT_MODES[self.robot_mode_idx][0],
            manual_joints_deg=(
                self.manual_j1,
                self.manual_j2,
                self.manual_j3,
                self.manual_j4,
                self.manual_j5,
                self.manual_j6,
            ),
            clamp_open_mm=self.clamp_open_mm,
            show_ghost_path=self.show_ghost_path,
            ghost_progress=self.ghost_progress,
        )
    )

  @messages.handler
  def on_update(self, event: messages.UpdateEvent) -> None:
    """Populate translucent ghost planned-path and ghost-arm extra_geoms."""
    del event
    self.viewer.extra_geoms.clear()
    if not self.show_ghost_path or self.viewer.data is None:
      return

    t = self.telemetry
    pts = t.path_points
    if len(pts) < 2:
      return

    alpha = float(np.clip(self.ghost_opacity, 0.08, 0.90))
    # 1. Translucent planned trajectory ribbon (cyan -> emerald gradient)
    n_seg = len(pts) - 1
    for i in range(n_seg):
      frac = i / max(1, n_seg - 1)
      rgba = (0.10 + 0.12 * frac, 0.78 + 0.16 * frac, 0.95 - 0.35 * frac, alpha * 0.85)
      self.viewer.extra_geoms.append(
          _make_connector(
              int(mujoco.mjtGeom.mjGEOM_CAPSULE),
              0.0075,
              np.array(pts[i]),
              np.array(pts[i + 1]),
              rgba,
          )
      )

    # 2. Keyframe waypoint beacon spheres (Prep, Transit, Oven Mouth, Rail #2)
    key_indices = sorted({0, n_seg // 3, (2 * n_seg) // 3, n_seg})
    for idx in key_indices:
      is_goal = idx == n_seg
      rgba = (0.15, 0.96, 0.58, min(0.92, alpha * 1.4)) if is_goal else (0.18, 0.82, 0.98, min(0.85, alpha * 1.25))
      self.viewer.extra_geoms.append(
          _make_sphere(np.array(pts[idx]), 0.019 if is_goal else 0.014, rgba)
      )

    # 3. Translucent ghost robot arm skeleton at preview progress along path
    g_joints = t.ghost_arm_joints
    if len(g_joints) >= 2:
      link_radii = (0.044, 0.036, 0.030, 0.024, 0.022, 0.016)
      for i in range(len(g_joints) - 1):
        p0 = np.array(g_joints[i])
        p1 = np.array(g_joints[i + 1])
        if np.linalg.norm(p1 - p0) < 1e-4:
          continue
        r = link_radii[min(i, len(link_radii) - 1)]
        self.viewer.extra_geoms.append(
            _make_connector(
                int(mujoco.mjtGeom.mjGEOM_CAPSULE),
                r,
                p0,
                p1,
                (0.16, 0.84, 0.96, alpha * 0.52),
            )
        )
        self.viewer.extra_geoms.append(
            _make_sphere(p0, r * 1.12, (0.28, 0.90, 1.0, alpha * 0.62))
        )

    # 4. Translucent ghost tray + directional heading arrow at planned end-effector pose
    g_pos = np.array(t.ghost_ee_pos, dtype=np.float64)
    g_mat = np.array(t.ghost_ee_mat, dtype=np.float64).reshape(3, 3)
    fwd = g_mat[:, 0]
    self.viewer.extra_geoms.append(
        _make_box(
            g_pos + 0.14 * fwd,
            g_mat,
            (0.15, 0.20, 0.010),
            (0.20, 0.92, 0.68, alpha * 0.45),
        )
    )
    self.viewer.extra_geoms.append(
        _make_connector(
            int(mujoco.mjtGeom.mjGEOM_ARROW),
            0.010,
            g_pos,
            g_pos + 0.18 * fwd,
            (0.18, 0.96, 0.62, min(0.95, alpha * 1.5)),
        )
    )

  def _begin_form_table(self, table_id: str) -> bool:
    flags = int(imgui.TableFlags.SizingStretchProp) | int(imgui.TableFlags.NoPadOuterX)
    if not imgui.BeginTable(table_id, 2, flags):
      return False
    imgui.TableSetupColumn('Label', int(imgui.TableColumnFlags.WidthFixed))
    imgui.TableSetupColumn('Control', int(imgui.TableColumnFlags.WidthStretch), 1.0)
    return True

  def _row_label(self, text: str) -> None:
    imgui.TableNextRow()
    imgui.TableNextColumn()
    imgui.AlignTextToFramePadding()
    imgui.TextUnformatted(text)
    imgui.TableNextColumn()
    imgui.SetNextItemWidth(-1)

  @messages.handler
  def on_build_gui(self, event: messages.BuildGuiEvent) -> None:
    """Build the aligned Dear ImGui control panel for the Bakery Workcell."""
    del event
    if not self.window_open:
      return
    expanded, self.window_open = imgui.Begin(
        'Seams Pantry Workcell###BakeryWorkcellWindow', self.window_open
    )
    try:
      if not expanded:
        return
      imgui.TextUnformatted(f'Workspace: {_short_path(WORKSPACE_DIR)}')
      imgui.SetItemTooltip(
          'Edit messages.py, sim_plugin.py,\n'
          'or viewer_plugin.py to hot-reload live.'
      )
      imgui.Separator()

      # --- Section 1: Robot Arm & Translucent Ghost Planned Path ---
      if imgui.CollapsingHeader(
          'Robot & Planned Path###RobotHeader',
          int(imgui.TreeNodeFlags.DefaultOpen),
      ):
        ctrl_changed = False
        if self._begin_form_table('##robot_tbl'):
          self._row_label('Arm Mode:')
          c, self.robot_mode_idx = imgui.Combo(
              '##robot_mode',
              self.robot_mode_idx,
              [lbl for _, lbl in ROBOT_MODES],
          )
          ctrl_changed |= c

          self._row_label('Fork Clamp (mm):')
          c, self.clamp_open_mm = imgui.SliderFloat(
              '##clamp_mm', self.clamp_open_mm, 0.0, 40.0, '%.1f'
          )
          ctrl_changed |= c

          self._row_label('Ghost Path:')
          c, self.show_ghost_path = imgui.Checkbox(
              'Show planned overlay##ghost_chk', self.show_ghost_path
          )
          ctrl_changed |= c

          self._row_label('Ghost Opacity:')
          _, self.ghost_opacity = imgui.SliderFloat(
              '##ghost_alpha', self.ghost_opacity, 0.10, 0.85, '%.2f'
          )

          if ROBOT_MODES[self.robot_mode_idx][0] != 'auto_demo':
            self._row_label('Ghost Scrub:')
            c, self.ghost_progress = imgui.SliderFloat(
                '##ghost_prog', self.ghost_progress, 0.0, 1.0, '%.2f'
            )
            ctrl_changed |= c

          if ROBOT_MODES[self.robot_mode_idx][0] == 'manual':
            for attr, lbl, lo, hi in (
                ('manual_j1', 'Joint 1 (deg):', -160.0, 160.0),
                ('manual_j2', 'Joint 2 (deg):', -170.0, 40.0),
                ('manual_j3', 'Joint 3 (deg):', -140.0, 140.0),
                ('manual_j4', 'Joint 4 (deg):', -180.0, 40.0),
                ('manual_j5', 'Joint 5 (deg):', -160.0, 160.0),
                ('manual_j6', 'Joint 6 (deg):', -160.0, 160.0),
            ):
              self._row_label(lbl)
              c, val = imgui.SliderFloat(
                  f'##{attr}', getattr(self, attr), lo, hi, '%.1f'
              )
              if c:
                setattr(self, attr, val)
                ctrl_changed = True
          imgui.EndTable()

        if ctrl_changed:
          self._send_control()

      # --- Section 2: Maruzen MBCO-4ME Convection Oven ---
      if imgui.CollapsingHeader(
          'Maruzen MBCO-4ME Oven###OvenHeader',
          int(imgui.TreeNodeFlags.DefaultOpen),
      ):
        oven_changed = False
        if self._begin_form_table('##oven_tbl'):
          self._row_label('Door Angle (deg):')
          c, self.door_deg = imgui.SliderFloat(
              '##door_deg', self.door_deg, 0.0, 110.0, '%.1f'
          )
          oven_changed |= c

          self._row_label('Latch Handle (deg):')
          c, self.handle_deg = imgui.SliderFloat(
              '##handle_deg', self.handle_deg, -29.0, 29.0, '%.1f'
          )
          oven_changed |= c

          self._row_label('Y-Fan (rad/s):')
          c, self.fan_rad_s = imgui.SliderFloat(
              '##fan_rad_s', self.fan_rad_s, -190.0, 190.0, '%.0f'
          )
          oven_changed |= c

          self._row_label('Auto Damper (deg):')
          c, self.damper_deg = imgui.SliderFloat(
              '##damper_deg', self.damper_deg, 0.0, 45.0, '%.1f'
          )
          oven_changed |= c
          imgui.EndTable()

        if oven_changed:
          self._send_control()

        if imgui.Button('Open & Load##preset_open'):
          self.door_deg = 102.0
          self.fan_rad_s = 0.0
          self.damper_deg = 0.0
          self.robot_mode_idx = 4
          self.viewer.send_to_sim(user_messages.OvenPresetEvent(preset='open_load'))
        imgui.SameLine()
        if imgui.Button('Close & Bake##preset_bake'):
          self.door_deg = 0.0
          self.fan_rad_s = 155.0
          self.damper_deg = 32.0
          self.robot_mode_idx = 1
          self.viewer.send_to_sim(user_messages.OvenPresetEvent(preset='close_bake'))

        if imgui.Button('Tray -> Rail #2##stage_rail'):
          self.viewer.send_to_sim(user_messages.StageTrayEvent(target='oven_rail2'))
        imgui.SameLine()
        if imgui.Button('Tray -> Prep Table##stage_table'):
          self.viewer.send_to_sim(user_messages.StageTrayEvent(target='prep_table'))

      # --- Section 3: Filament PBR Lighting & Look ---
      if imgui.CollapsingHeader('Filament PBR Lighting###LightHeader'):
        light_changed = False
        if self._begin_form_table('##light_tbl'):
          self._row_label('Tone Mapping:')
          c, self.tone_mapping_idx = imgui.Combo(
              '##tone_map', self.tone_mapping_idx, list(TONE_MAPPINGS)
          )
          light_changed |= c

          self._row_label('Exposure (EV):')
          c, self.exposure = imgui.SliderFloat(
              '##exposure', self.exposure, -1.0, 1.0, '%.2f'
          )
          light_changed |= c

          self._row_label('IBL Cubemap:')
          c, self.ibl_intensity = imgui.SliderFloat(
              '##ibl_int', self.ibl_intensity, 4000.0, 45000.0, '%.0f'
          )
          light_changed |= c

          self._row_label('Bay Lights (cd):')
          c, self.bay_intensity = imgui.SliderFloat(
              '##bay_int', self.bay_intensity, 4000.0, 45000.0, '%.0f'
          )
          light_changed |= c

          self._row_label('Bloom Strength:')
          c, self.bloom_strength = imgui.SliderFloat(
              '##bloom_str', self.bloom_strength, 0.0, 0.60, '%.2f'
          )
          light_changed |= c

          self._row_label('Post Effects:')
          c1, self.bloom_enabled = imgui.Checkbox('Bloom##bloom_chk', self.bloom_enabled)
          imgui.SameLine()
          c2, self.ssao_enabled = imgui.Checkbox('SSAO##ssao_chk', self.ssao_enabled)
          light_changed |= c1 or c2

          self._row_label('Pastry Load:')
          c, self.pastry_load = imgui.Checkbox('Show croissants##pastry_chk', self.pastry_load)
          light_changed |= c
          imgui.EndTable()

        if light_changed:
          self._send_lighting()

      # --- Section 4: Live Telemetry ---
      imgui.Separator()
      t = self.telemetry
      imgui.TextUnformatted(f'Time: {t.sim_time:6.2f} s  |  {t.phase_label}')
      imgui.TextUnformatted(
          f'Oven: Door {t.door_deg:5.1f} deg | Damper {t.damper_deg:4.1f} deg | '
          f'Fan {t.fan_rpm:6.0f} RPM'
      )
      imgui.TextUnformatted(
          f'Rail #2 Touch: {t.rail2_touch_n:5.2f} N  |  '
          f'EE: ({t.ee_pos[0]:+.2f}, {t.ee_pos[1]:+.2f}, {t.ee_pos[2]:+.2f}) m'
      )

      imgui.Separator()
      if imgui.Button('Bake to scene.xml###BakeBtn'):
        self.viewer.send_to_sim(user_messages.BakeSceneEvent())
      imgui.SetItemTooltip(
          'Export the Python workcell spec\n'
          'to scene.xml in this workspace.'
      )
    finally:
      imgui.End()
