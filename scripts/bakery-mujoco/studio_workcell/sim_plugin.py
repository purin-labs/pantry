"""Simulation-side MuJoCo Studio plugin for the Filament PBR Bakery Workcell.

Builds a standalone Omniverse-style bakery workcell in Python using MjSpec:
- Procedural 6-face architectural cubemap IBL + photometric overhead bay lights
- Filament PBR ACES tone mapping, high-quality SSAO, floor reflectance, bloom
- Visual-only kitchen architecture (tiled floor, safety zone tape, subway-tile
  backsplash, exhaust hood, stainless prep table, cooling speed rack)
- Upgraded Maruzen MBCO-4ME convection oven & European baking tray (attached
  from assets/bakery-mujoco/maruzen-mbco-4me/model.xml & tray_model.xml)
- FAIRINO FR10 6-DOF cobot arm with tray fork clamp + planned-path trajectory
  telemetry for translucent ghost overlays in viewer_plugin.py

Offline Studio preview only (Plan 42B keeps production controllers in Rust).
"""

from __future__ import annotations

import math
import os
import pathlib
import struct
import tempfile
import zlib

import messages as user_messages
import mujoco
from mujoco.studio import messages
from mujoco.studio import plugin
import numpy as np

WORKSPACE_DIR = pathlib.Path(os.path.abspath(__file__)).parent
REPO_ROOT = WORKSPACE_DIR.parents[2]
OVEN_DIR = REPO_ROOT / 'assets/bakery-mujoco/maruzen-mbco-4me'
OVEN_MODEL_XML = OVEN_DIR / 'model.xml'
TRAY_MODEL_XML = OVEN_DIR / 'tray_model.xml'
OVEN_VISUAL_ASSETS_XML = OVEN_DIR / 'visual_assets.xml'
FR10_XML = REPO_ROOT / 'assets/bakery-robots/fairino-fr10/robot.xml'
GRIPPER_XML = REPO_ROOT / 'assets/bakery-mujoco/fr10-workcell/gripper.xml'
SCENE_XML = WORKSPACE_DIR / 'scene.xml'

# Workcell layout coordinates (meters, Z-up, oven front faces -Y).
OVEN_POS = (0.58, 0.16, 0.85)
OVEN_RAIL2_WORLD = (OVEN_POS[0] - 0.09, OVEN_POS[1] - 0.14, OVEN_POS[2] + 0.2655)
PREP_TABLE_POS = (-0.88, -0.22, 0.0)
PREP_TRAY_WORLD = (-0.76, -0.26, 0.8505)
ARM_BASE_POS = (-0.08, -0.78, 0.78)
COOLING_RACK_POS = (1.56, 0.14, 0.0)


def _write_rgb_png(path: pathlib.Path, rgb: np.ndarray) -> None:
  """Write an 8-bit RGB PNG using stdlib zlib (zero PIL dependency)."""
  h, w, _ = rgb.shape
  u8 = np.clip(np.rint(np.clip(rgb, 0.0, 1.0) * 255.0), 0, 255).astype(np.uint8)
  raw = b''.join(b'\x00' + u8[y].tobytes() for y in range(h))

  def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack('>I', len(payload))
        + tag
        + payload
        + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )

  ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
  path.write_bytes(
      b'\x89PNG\r\n\x1a\n'
      + chunk(b'IHDR', ihdr)
      + chunk(b'IDAT', zlib.compress(raw, 6))
      + chunk(b'IEND', b'')
  )


def _ensure_procedural_textures() -> dict[str, pathlib.Path]:
  """Generate cached architectural cubemap IBL and PBR surface PNGs in TMPDIR."""
  tex_dir = pathlib.Path(tempfile.gettempdir()) / 'seams_pantry_studio_workcell_tex_v2'
  tex_dir.mkdir(parents=True, exist_ok=True)
  paths = {
      'ibl': tex_dir / 'bakery_ibl_cube.png',
      'floor': tex_dir / 'bakery_floor_tiles.png',
      'subway': tex_dir / 'bakery_wall_subway.png',
      'tape': tex_dir / 'zone_tape_hazard.png',
  }

  if not paths['ibl'].is_file():
    # 6 stacked square faces (128x128 each), gridsize="6 1", gridlayout="RLUDFB".
    n = 128
    u = np.linspace(-1.0, 1.0, n, dtype=np.float32)
    v = np.linspace(-1.0, 1.0, n, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)

    def make_wall(base_top, base_bot, softbox_rect=None, softbox_col=None):
      t = np.clip(0.5 - 0.5 * vv, 0.0, 1.0)[..., None]
      img = base_bot * (1.0 - t) + base_top * t
      if softbox_rect is not None and softbox_col is not None:
        u0, u1, v0, v1 = softbox_rect
        du = np.maximum(0.0, np.maximum(u0 - uu, uu - u1))
        dv = np.maximum(0.0, np.maximum(v0 - vv, vv - v1))
        mask = np.exp(-((du * 12.0) ** 2 + (dv * 12.0) ** 2))[..., None]
        img = np.clip(img * (1.0 - 0.85 * mask) + softbox_col * mask, 0.0, 1.0)
      return img

    # Right (+X): warm bakery accent softbox
    face_r = make_wall(
        np.array([0.52, 0.50, 0.48], dtype=np.float32),
        np.array([0.22, 0.23, 0.25], dtype=np.float32),
        (-0.55, 0.55, -0.55, -0.05),
        np.array([1.0, 0.94, 0.84], dtype=np.float32),
    )
    # Left (-X): cool daylight bakery window
    face_l = make_wall(
        np.array([0.58, 0.64, 0.72], dtype=np.float32),
        np.array([0.24, 0.26, 0.30], dtype=np.float32),
        (-0.68, 0.68, -0.62, 0.12),
        np.array([0.92, 0.96, 1.0], dtype=np.float32),
    )
    # Up (+Z): commercial kitchen ceiling with 3 crisp overhead LED light bays
    face_u = np.full((n, n, 3), np.array([0.36, 0.38, 0.41], dtype=np.float32))
    for cy in (-0.56, 0.0, 0.56):
      du = np.maximum(0.0, np.abs(uu) - 0.72)
      dv = np.maximum(0.0, np.abs(vv - cy) - 0.13)
      bay = np.exp(-((du * 18.0) ** 2 + (dv * 22.0) ** 2))[..., None]
      face_u = np.clip(
          face_u + bay * np.array([0.85, 0.84, 0.80], dtype=np.float32),
          0.0,
          1.0,
      )
    # Down (-Z): porcelain tile floor bounce
    face_d = np.full((n, n, 3), np.array([0.30, 0.31, 0.33], dtype=np.float32))
    # Front (+Y) & Back (-Y): studio key/fill reflections for front door glass & steel
    face_f = make_wall(
        np.array([0.48, 0.50, 0.54], dtype=np.float32),
        np.array([0.20, 0.21, 0.23], dtype=np.float32),
        (-0.65, 0.65, -0.60, -0.15),
        np.array([0.96, 0.97, 1.0], dtype=np.float32),
    )
    face_b = make_wall(
        np.array([0.56, 0.58, 0.62], dtype=np.float32),
        np.array([0.24, 0.25, 0.27], dtype=np.float32),
        (-0.75, 0.75, -0.58, 0.05),
        np.array([1.0, 0.98, 0.95], dtype=np.float32),
    )
    cube_strip = np.vstack([face_r, face_l, face_u, face_d, face_f, face_b])
    _write_rgb_png(paths['ibl'], cube_strip)

  if not paths['floor'].is_file():
    # 512x512 seamless 4x4 architectural commercial quarry/porcelain tiles.
    rng = np.random.default_rng(4242)
    n = 512
    tile_px = n // 4
    img = np.zeros((n, n, 3), dtype=np.float32)
    base = np.array([0.64, 0.65, 0.67], dtype=np.float32)
    grout = np.array([0.32, 0.33, 0.35], dtype=np.float32)
    for ty in range(4):
      for tx in range(4):
        shade = float(rng.uniform(-0.025, 0.025))
        y0, y1 = ty * tile_px, (ty + 1) * tile_px
        x0, x1 = tx * tile_px, (tx + 1) * tile_px
        img[y0:y1, x0:x1] = base + shade
    # Subtle stone speckle
    noise = rng.normal(0.0, 0.012, size=(n, n, 1)).astype(np.float32)
    img = np.clip(img + noise, 0.0, 1.0)
    # Clean 4-pixel recessed grout seams
    for k in range(4):
      p = k * tile_px
      img[p : p + 3, :] = grout
      img[:, p : p + 3] = grout
      img[min(p + 3, n - 1), :] *= 0.92
      img[:, min(p + 3, n - 1)] *= 0.92
    _write_rgb_png(paths['floor'], img)

  if not paths['subway'].is_file():
    # 512x512 crisp commercial bakery glossy ceramic subway tile backsplash.
    rng = np.random.default_rng(7711)
    n = 512
    rows, cols = 16, 8
    rh, cw = n // rows, n // cols
    img = np.full((n, n, 3), np.array([0.89, 0.90, 0.89], dtype=np.float32))
    mortar = np.array([0.66, 0.67, 0.68], dtype=np.float32)
    for r in range(rows):
      y0, y1 = r * rh, (r + 1) * rh
      x_shift = (cw // 2) if (r % 2 == 1) else 0
      for c in range(cols + 1):
        shade = float(rng.uniform(-0.018, 0.018))
        x0 = max(0, c * cw - x_shift)
        x1 = min(n, (c + 1) * cw - x_shift)
        if x1 > x0:
          img[y0:y1, x0:x1] = np.clip(
              np.array([0.89, 0.90, 0.89], dtype=np.float32) + shade, 0.0, 1.0
          )
      img[y0 : y0 + 2, :] = mortar
      for c in range(cols + 1):
        xs = (c * cw - x_shift) % n
        img[y0:y1, xs : min(xs + 2, n)] = mortar
    _write_rgb_png(paths['subway'], img)

  if not paths['tape'].is_file():
    # 256x256 diagonal yellow-black robot workcell safety zone tape.
    n = 256
    yy, xx = np.mgrid[0:n, 0:n]
    stripe = (((xx + yy) // 32) % 2) == 0
    yellow = np.array([0.92, 0.72, 0.08], dtype=np.float32)
    charcoal = np.array([0.11, 0.12, 0.13], dtype=np.float32)
    img = np.where(stripe[..., None], yellow, charcoal)
    _write_rgb_png(paths['tape'], img)

  return paths


def _add_pd_actuator(
    spec: mujoco.MjSpec,
    name: str,
    target: str,
    kp: float,
    kv: float,
    forcerange: tuple[float, float],
    ctrlrange: tuple[float, float] | None = None,
) -> None:
  gainprm = [0.0] * 10
  gainprm[0] = kp
  biasprm = [0.0] * 10
  biasprm[1] = -kp
  biasprm[2] = -kv
  kwargs = dict(
      name=name,
      target=target,
      trntype=mujoco.mjtTrn.mjTRN_JOINT,
      gaintype=mujoco.mjtGain.mjGAIN_FIXED,
      biastype=mujoco.mjtBias.mjBIAS_AFFINE,
      gainprm=gainprm,
      biasprm=biasprm,
      forcelimited=True,
      forcerange=list(forcerange),
  )
  if ctrlrange is not None:
    kwargs['ctrllimited'] = True
    kwargs['ctrlrange'] = list(ctrlrange)
  spec.add_actuator(**kwargs)


def _add_vel_actuator(
    spec: mujoco.MjSpec,
    name: str,
    target: str,
    kv: float,
    forcerange: tuple[float, float],
    ctrlrange: tuple[float, float],
) -> None:
  gainprm = [0.0] * 10
  gainprm[0] = kv
  biasprm = [0.0] * 10
  biasprm[2] = -kv
  spec.add_actuator(
      name=name,
      target=target,
      trntype=mujoco.mjtTrn.mjTRN_JOINT,
      gaintype=mujoco.mjtGain.mjGAIN_FIXED,
      biastype=mujoco.mjtBias.mjBIAS_AFFINE,
      gainprm=gainprm,
      biasprm=biasprm,
      ctrllimited=True,
      ctrlrange=list(ctrlrange),
      forcelimited=True,
      forcerange=list(forcerange),
  )


def _add_visual_box(parent, name, pos, size, material, quat=None):
  kwargs = dict(
      name=name,
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=list(pos),
      size=list(size),
      material=material,
      contype=0,
      conaffinity=0,
      density=0.0,
      mass=0.0,
      group=2,
  )
  if quat is not None:
    kwargs['quat'] = list(quat)
  return parent.add_geom(**kwargs)


def _add_visual_cyl(parent, name, pos, size, material, quat=None):
  kwargs = dict(
      name=name,
      type=mujoco.mjtGeom.mjGEOM_CYLINDER,
      pos=list(pos),
      size=list(size),
      material=material,
      contype=0,
      conaffinity=0,
      density=0.0,
      mass=0.0,
      group=2,
  )
  if quat is not None:
    kwargs['quat'] = list(quat)
  return parent.add_geom(**kwargs)


def _add_croissant_cluster(parent, prefix, base_z, mat_pastry, mat_crust):
  """Add 6 decorative golden croissants on a 400x300 mm baking tray (zero mass)."""
  idx = 0
  for rx in (-0.115, 0.0, 0.115):
    for ry in (-0.068, 0.068):
      idx += 1
      # Central golden laminated body + two curved tips
      parent.add_geom(
          name=f'{prefix}_croissant_{idx}_mid',
          type=mujoco.mjtGeom.mjGEOM_ELLIPSOID,
          pos=[rx, ry, base_z + 0.017],
          size=[0.042, 0.024, 0.017],
          material=mat_pastry,
          contype=0,
          conaffinity=0,
          density=0.0,
          mass=0.0,
          group=2,
      )
      for sgn, tag in ((-1.0, 'l'), (1.0, 'r')):
        ang = sgn * 0.42
        parent.add_geom(
            name=f'{prefix}_croissant_{idx}_{tag}',
            type=mujoco.mjtGeom.mjGEOM_ELLIPSOID,
            pos=[rx + sgn * 0.036, ry - 0.010, base_z + 0.012],
            quat=[math.cos(ang / 2), 0.0, 0.0, math.sin(ang / 2)],
            size=[0.022, 0.014, 0.012],
            material=mat_crust,
            contype=0,
            conaffinity=0,
            density=0.0,
            mass=0.0,
            group=2,
        )


def _solve_arm_ik(
    model: mujoco.MjModel,
    joint_ids: list[int],
    site_id: int,
    q_init: np.ndarray,
    target_pos: np.ndarray,
    target_xdir: np.ndarray | None = None,
    iters: int = 80,
) -> np.ndarray:
  """Damped least-squares IK for FR10 preview waypoints (visual demo only)."""
  d = mujoco.MjData(model)
  qpos_adrs = [int(model.jnt_qposadr[j]) for j in joint_ids]
  dof_adrs = [int(model.jnt_dofadr[j]) for j in joint_ids]
  q_low = np.array([model.jnt_range[j, 0] for j in joint_ids], dtype=np.float64)
  q_high = np.array([model.jnt_range[j, 1] for j in joint_ids], dtype=np.float64)

  q = q_init.copy()
  jacp = np.zeros((3, model.nv), dtype=np.float64)
  jacr = np.zeros((3, model.nv), dtype=np.float64)

  for _ in range(iters):
    for k, adr in enumerate(qpos_adrs):
      d.qpos[adr] = q[k]
    mujoco.mj_kinematics(model, d)
    mujoco.mj_comPos(model, d)

    pos_err = target_pos - d.site_xpos[site_id]
    if target_xdir is not None:
      xmat = d.site_xmat[site_id].reshape(3, 3)
      # Align tool +X along target_xdir and tool +Z along world +Z
      cur_x = xmat[:, 0]
      cur_z = xmat[:, 2]
      des_z = np.array([0.0, 0.0, 1.0])
      rot_err = 0.55 * np.cross(cur_x, target_xdir) + 0.55 * np.cross(cur_z, des_z)
      err = np.concatenate([pos_err, rot_err])
    else:
      err = pos_err

    if np.linalg.norm(pos_err) < 2e-3 and (
        target_xdir is None or np.linalg.norm(err[3:]) < 2e-2
    ):
      break

    mujoco.mj_jacSite(model, d, jacp, jacr, site_id)
    if target_xdir is not None:
      J = np.vstack([jacp[:, dof_adrs], jacr[:, dof_adrs]])
    else:
      J = jacp[:, dof_adrs]

    lam = 0.08
    dq = J.T @ np.linalg.solve(J @ J.T + (lam**2) * np.eye(J.shape[0]), err)
    q = np.clip(q + 0.55 * dq, q_low + 0.05, q_high - 0.05)

  return q


class SimPlugin(plugin.SimPlugin):
  """Builds and drives the Omniverse-style Filament PBR Bakery Workcell."""

  # Filament lighting & post-processing parameters (preserved across reloads).
  exposure: float = 0.45
  ibl_intensity: float = 30000.0
  bay_intensity: float = 28000.0
  bloom_enabled: bool = True
  bloom_strength: float = 0.18
  ssao_enabled: bool = True
  tone_mapping: str = 'aces'
  pastry_load: bool = True

  # Live workcell actuator controls.
  door_deg: float = 82.0
  handle_deg: float = 0.0
  fan_rad_s: float = 95.0
  damper_deg: float = 18.0
  robot_mode: str = 'auto_demo'
  manual_joints_deg: tuple[float, ...] = (10.0, -78.0, 96.0, -108.0, -90.0, 0.0)
  clamp_open_mm: float = 28.0
  show_ghost_path: bool = True
  ghost_progress: float = 0.55

  # Cached runtime handles & precomputed planned trajectory (rebuilt on PostModel).
  spec: mujoco.MjSpec | None = None
  _pending_tray_stage: str | None = None
  _arm_jnt_ids: list[int] = []
  _arm_act_ids: list[int] = []
  _arm_body_ids: list[int] = []
  _ee_site_id: int = -1
  _waypoints: dict[str, np.ndarray] = {}
  _planned_qs: list[np.ndarray] = []
  _planned_ee_pts: list[tuple[float, float, float]] = []
  _planned_ee_mats: list[tuple[float, ...]] = []
  _planned_arm_pts: list[list[tuple[float, float, float]]] = []
  _last_telemetry_t: float = -1.0

  def build_spec(self) -> mujoco.MjSpec:
    """Build the Filament PBR Bakery Workcell MjSpec."""
    tex_paths = _ensure_procedural_textures()

    spec = mujoco.MjSpec()
    spec.modelname = 'seams_pantry_bakery_workcell'
    spec.compiler.degree = False
    spec.compiler.autolimits = True
    spec.option.timestep = 0.002
    spec.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST

    # Camera & global visual tuning
    spec.visual.global_.azimuth = -132.0
    spec.visual.global_.elevation = -22.0
    spec.visual.global_.fovy = 42.0
    spec.visual.global_.offwidth = 1280
    spec.visual.global_.offheight = 720
    spec.visual.quality.shadowsize = 2048
    spec.visual.quality.offsamples = 4
    spec.visual.headlight.active = 0  # Disabled under photometric lighting

    # Filament PBR post-processing: ACES tone mapping, high SSAO, subtle bloom
    spec.add_text(name='filament.cg.tone_mapping', data=self.tone_mapping)
    spec.add_numeric(name='filament.cg.exposure', data=[float(self.exposure)])
    spec.add_numeric(name='filament.cg.contrast', data=[1.06])
    spec.add_numeric(name='filament.cg.saturation', data=[1.05])
    spec.add_numeric(
        name='filament.ao.enabled', data=[1.0 if self.ssao_enabled else 0.0]
    )
    spec.add_text(name='filament.ao.quality', data='high')
    spec.add_numeric(name='filament.ao.bent_normals', data=[1.0])
    spec.add_numeric(name='filament.ao.ssct', data=[1.0])
    spec.add_numeric(
        name='filament.bloom.enabled',
        data=[1.0 if self.bloom_enabled else 0.0],
    )
    spec.add_numeric(
        name='filament.bloom.strength', data=[float(self.bloom_strength)]
    )
    spec.add_text(name='filament.bloom.quality', data='medium')
    spec.add_text(name='filament.shadows.type', data='pcf')
    spec.add_numeric(name='filament.shadows.map_size', data=[2048.0])
    spec.add_numeric(name='filament.clear_color', data=[0.74, 0.77, 0.81, 1.0])

    # Architectural skybox + cubemap IBL + PBR surface textures
    spec.add_texture(
        name='bakery_skybox',
        type=mujoco.mjtTexture.mjTEXTURE_SKYBOX,
        builtin=mujoco.mjtBuiltin.mjBUILTIN_GRADIENT,
        rgb1=[0.84, 0.87, 0.91],
        rgb2=[0.54, 0.57, 0.61],
        width=256,
        height=1536,
    )
    spec.add_texture(
        name='bakery_ibl_cube',
        type=mujoco.mjtTexture.mjTEXTURE_CUBE,
        file=str(tex_paths['ibl']),
        gridsize=[6, 1],
        gridlayout='RLUDFB......',
        colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_SRGB,
    )
    spec.add_texture(
        name='bakery_floor_tex',
        type=mujoco.mjtTexture.mjTEXTURE_2D,
        file=str(tex_paths['floor']),
        colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_SRGB,
    )
    spec.add_texture(
        name='bakery_subway_tex',
        type=mujoco.mjtTexture.mjTEXTURE_2D,
        file=str(tex_paths['subway']),
        colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_SRGB,
    )
    spec.add_texture(
        name='zone_tape_tex',
        type=mujoco.mjtTexture.mjTEXTURE_2D,
        file=str(tex_paths['tape']),
        colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_SRGB,
    )
    # Reuse the oven's high-res brushed stainless hairline textures for kitchen tables/racks
    ss_hl = OVEN_DIR / 'mbco4-stainless-hl.png'
    ss_orm = OVEN_DIR / 'mbco4-stainless-orm.png'
    if ss_hl.is_file():
      spec.add_texture(
          name='kitchen_ss_hl',
          type=mujoco.mjtTexture.mjTEXTURE_2D,
          file=str(ss_hl),
          colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_SRGB,
      )
    if ss_orm.is_file():
      spec.add_texture(
          name='kitchen_ss_orm',
          type=mujoco.mjtTexture.mjTEXTURE_2D,
          file=str(ss_orm),
          colorspace=mujoco.mjtColorSpace.mjCOLORSPACE_LINEAR,
      )

    # PBR materials
    mat_floor = spec.add_material(
        name='mat_floor_tile',
        rgba=[1.0, 1.0, 1.0, 1.0],
        metallic=0.0,
        roughness=0.26,
        reflectance=0.14,
        texrepeat=[1.25, 1.25],
        texuniform=True,
    )
    mat_floor.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = 'bakery_floor_tex'

    mat_subway = spec.add_material(
        name='mat_subway_wall',
        rgba=[1.0, 1.0, 1.0, 1.0],
        metallic=0.0,
        roughness=0.18,
        texrepeat=[1.8, 1.8],
        texuniform=True,
    )
    mat_subway.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = 'bakery_subway_tex'

    mat_tape = spec.add_material(
        name='mat_zone_tape',
        rgba=[1.0, 1.0, 1.0, 1.0],
        metallic=0.0,
        roughness=0.38,
        texrepeat=[2.5, 2.5],
        texuniform=True,
    )
    mat_tape.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = 'zone_tape_tex'

    mat_ss = spec.add_material(
        name='mat_kitchen_stainless',
        rgba=[0.84, 0.86, 0.89, 1.0],
        metallic=1.0 if ss_orm.is_file() else 0.88,
        roughness=1.0 if ss_orm.is_file() else 0.24,
        texrepeat=[1.6, 1.6],
        texuniform=True,
    )
    if ss_hl.is_file():
      mat_ss.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = 'kitchen_ss_hl'
    if ss_orm.is_file():
      mat_ss.textures[mujoco.mjtTextureRole.mjTEXROLE_ORM] = 'kitchen_ss_orm'

    spec.add_material(
        name='mat_ss_frame',
        rgba=[0.74, 0.77, 0.80, 1.0],
        metallic=0.90,
        roughness=0.28,
    )
    spec.add_material(
        name='mat_plaster_wall',
        rgba=[0.86, 0.85, 0.82, 1.0],
        metallic=0.0,
        roughness=0.84,
    )
    spec.add_material(
        name='mat_dark_anodized',
        rgba=[0.24, 0.26, 0.29, 1.0],
        metallic=0.62,
        roughness=0.32,
    )
    spec.add_material(
        name='mat_warm_oak',
        rgba=[0.56, 0.39, 0.24, 1.0],
        metallic=0.0,
        roughness=0.52,
    )
    spec.add_material(
        name='mat_led_bay',
        rgba=[1.0, 0.97, 0.91, 1.0],
        metallic=0.0,
        roughness=0.15,
        emission=1.0,
    )
    spec.add_material(
        name='mat_daylight_window',
        rgba=[0.86, 0.93, 1.0, 1.0],
        metallic=0.0,
        roughness=0.10,
        emission=0.85,
    )
    spec.add_material(
        name='mat_pastry_gold',
        rgba=[0.82, 0.52, 0.18, 1.0],
        metallic=0.0,
        roughness=0.46,
    )
    spec.add_material(
        name='mat_pastry_crust',
        rgba=[0.66, 0.36, 0.11, 1.0],
        metallic=0.0,
        roughness=0.52,
    )
    spec.add_material(
        name='mat_aluminum_pan',
        rgba=[0.76, 0.78, 0.81, 1.0],
        metallic=0.88,
        roughness=0.25,
    )
    spec.add_material(
        name='mat_cobot_pearl',
        rgba=[0.91, 0.92, 0.94, 1.0],
        metallic=0.22,
        roughness=0.24,
    )
    spec.add_material(
        name='mat_cobot_accent',
        rgba=[0.14, 0.24, 0.36, 1.0],
        metallic=0.55,
        roughness=0.26,
    )

    world = spec.worldbody

    # --- 1. Photometric Lighting Rig & Cubemap IBL ---
    world.add_light(
        name='env_ibl',
        type=mujoco.mjtLightType.mjLIGHT_IMAGE,
        texture='bakery_ibl_cube',
        intensity=float(self.ibl_intensity),
    )
    world.add_light(
        name='bay_key_center',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[0.10, -0.55, 2.58],
        dir=[0.08, 0.22, -0.97],
        diffuse=[1.0, 0.97, 0.93],
        intensity=float(self.bay_intensity),
        cutoff=60.0,
        exponent=1.6,
        bulbradius=0.14,
        castshadow=True,
    )
    world.add_light(
        name='bay_oven_accent',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[0.68, -0.92, 2.42],
        dir=[-0.04, 0.44, -0.90],
        diffuse=[1.0, 0.95, 0.88],
        intensity=float(self.bay_intensity * 0.78),
        cutoff=50.0,
        exponent=1.8,
        bulbradius=0.10,
        castshadow=True,
    )
    world.add_light(
        name='bay_prep_fill',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[-0.95, -0.70, 2.52],
        dir=[0.05, 0.18, -0.98],
        diffuse=[0.94, 0.97, 1.0],
        intensity=float(self.bay_intensity * 0.62),
        cutoff=58.0,
        exponent=1.5,
        bulbradius=0.12,
        castshadow=False,
    )
    world.add_light(
        name='window_daylight_fill',
        type=mujoco.mjtLightType.mjLIGHT_DIRECTIONAL,
        pos=[-2.1, -0.5, 1.8],
        dir=[0.80, 0.25, -0.54],
        diffuse=[0.88, 0.93, 1.0],
        intensity=float(self.bay_intensity * 0.35),
        castshadow=False,
    )
    world.add_light(
        name='front_studio_fill',
        type=mujoco.mjtLightType.mjLIGHT_DIRECTIONAL,
        pos=[0.3, -3.0, 2.2],
        dir=[-0.05, 0.82, -0.56],
        diffuse=[1.0, 0.98, 0.96],
        intensity=float(self.bay_intensity * 0.25),
        castshadow=False,
    )
    world.add_light(
        name='oven_chamber_halogen',
        type=mujoco.mjtLightType.mjLIGHT_POINT,
        pos=[OVEN_POS[0] - 0.16, OVEN_POS[1] - 0.10, OVEN_POS[2] + 0.38],
        diffuse=[1.0, 0.82, 0.48],
        intensity=320.0,
        range=0.85,
        bulbradius=0.02,
        castshadow=False,
    )

    # --- 2. Named Cameras for Studio Inspection ---
    world.add_camera(
        name='hero_3_4',
        pos=[-1.58, -2.68, 1.86],
        xyaxes=[0.84, -0.54, 0.0, 0.18, 0.28, 0.94],
    )
    world.add_camera(
        name='oven_closeup',
        pos=[0.52, -1.05, 1.24],
        xyaxes=[1.0, 0.0, 0.0, 0.0, 0.12, 0.99],
    )
    world.add_camera(
        name='robot_gripper',
        pos=[-0.92, -1.68, 1.48],
        xyaxes=[0.74, -0.67, 0.0, 0.22, 0.24, 0.95],
    )
    world.add_camera(
        name='overhead_bay',
        pos=[0.18, -0.62, 3.25],
        xyaxes=[1.0, 0.0, 0.0, 0.0, 0.97, 0.24],
    )

    # --- 3. Floor, Safety Zone Tape & Kitchen Architecture (Visual-Only) ---
    world.add_geom(
        name='bakery_floor',
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[6.0, 6.0, 0.05],
        material='mat_floor_tile',
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.7, 0.015, 0.003],
    )

    # Workcell safety zone tape perimeter on floor (Z = 0.001 m, visual-only)
    z_tape = 0.0012
    tape_w = 0.035
    for tname, tpos, tsize in (
        ('zone_tape_front', (0.05, -1.45, z_tape), (1.72, tape_w, 0.0006)),
        ('zone_tape_back', (0.05, 0.88, z_tape), (1.72, tape_w, 0.0006)),
        ('zone_tape_left', (-1.65, -0.285, z_tape), (tape_w, 1.18, 0.0006)),
        ('zone_tape_right', (1.75, -0.285, z_tape), (tape_w, 1.18, 0.0006)),
    ):
      _add_visual_box(world, tname, tpos, tsize, 'mat_zone_tape')

    # Rear kitchen wall (Y = +1.05 m): rotated 90 deg about X so 2D subway tile projects flat onto -Y face!
    rear_quat = (0.70710678, 0.70710678, 0.0, 0.0)
    _add_visual_box(world, 'wall_rear_kick', (0.35, 1.03, 0.06), (3.40, 0.012, 0.06), 'mat_ss_frame')
    _add_visual_box(world, 'wall_rear_subway', (0.35, 1.05, 0.88), (3.40, 0.76, 0.02), 'mat_subway_wall', quat=rear_quat)
    _add_visual_box(world, 'wall_rear_trim', (0.35, 1.035, 1.66), (3.40, 0.018, 0.025), 'mat_warm_oak')
    _add_visual_box(world, 'wall_rear_upper', (0.35, 1.06, 2.34), (3.40, 0.02, 0.66), 'mat_plaster_wall')
    # Right side return wall (X = +3.05 m) to enclose the kitchen bay cleanly
    _add_visual_box(world, 'wall_right_return', (3.05, -0.80, 1.50), (0.03, 2.00, 1.50), 'mat_plaster_wall')

    # Left architectural wall with recessed glowing daylight window (X = -2.15 m)
    _add_visual_box(world, 'wall_left_lower', (-2.15, -0.45, 0.52), (0.03, 1.52, 0.52), 'mat_plaster_wall')
    _add_visual_box(world, 'wall_left_upper', (-2.15, -0.45, 2.45), (0.03, 1.52, 0.35), 'mat_plaster_wall')
    _add_visual_box(world, 'wall_left_pillar_b', (-2.15, 0.72, 1.55), (0.03, 0.36, 0.58), 'mat_plaster_wall')
    _add_visual_box(world, 'wall_left_pillar_f', (-2.15, -1.62, 1.55), (0.03, 0.36, 0.58), 'mat_plaster_wall')
    _add_visual_box(world, 'wall_left_window_pane', (-2.17, -0.45, 1.56), (0.008, 0.84, 0.50), 'mat_daylight_window')
    _add_visual_box(world, 'wall_left_mullion_v', (-2.14, -0.45, 1.56), (0.018, 0.018, 0.52), 'mat_dark_anodized')
    _add_visual_box(world, 'wall_left_mullion_h', (-2.14, -0.45, 1.56), (0.018, 0.86, 0.018), 'mat_dark_anodized')

    # Commercial stainless canopy exhaust hood over the Maruzen oven
    _add_visual_box(world, 'hood_canopy_body', (0.58, 0.38, 2.08), (0.56, 0.44, 0.14), 'mat_kitchen_stainless')
    _add_visual_box(world, 'hood_canopy_lip', (0.58, 0.38, 1.93), (0.57, 0.45, 0.015), 'mat_ss_frame')
    _add_visual_cyl(world, 'hood_duct_riser', (0.58, 0.55, 2.52), (0.11, 0.30), 'mat_ss_frame')

    # Overhead commercial kitchen LED bay fixtures (at Z = 2.68 m)
    for b_idx, (bx, by) in enumerate(((-0.75, -0.35), (0.55, -0.35), (0.05, 0.45)), 1):
      _add_visual_box(world, f'ceiling_bay_housing_{b_idx}', (bx, by, 2.71), (0.52, 0.11, 0.025), 'mat_dark_anodized')
      _add_visual_box(world, f'ceiling_bay_led_{b_idx}', (bx, by, 2.682), (0.48, 0.08, 0.006), 'mat_led_bay')

    # --- 4. Stainless Prep Table (visual + physical tabletop collider at Z=0.85) ---
    px, py, _ = PREP_TABLE_POS
    _add_visual_box(world, 'prep_table_top_vis', (px, py, 0.832), (0.54, 0.36, 0.018), 'mat_kitchen_stainless')
    _add_visual_box(world, 'prep_table_backsplash', (px, py + 0.345, 0.895), (0.54, 0.015, 0.045), 'mat_kitchen_stainless')
    _add_visual_box(world, 'prep_table_undershelf', (px, py, 0.22), (0.49, 0.31, 0.014), 'mat_ss_frame')
    for lx in (-0.49, 0.49):
      for ly in (-0.31, 0.31):
        _add_visual_cyl(world, f'prep_leg_{lx:+.2f}_{ly:+.2f}', (px + lx, py + ly, 0.41), (0.020, 0.41), 'mat_ss_frame')
    # Real tabletop collision surface so tray sits physically on prep table
    world.add_geom(
        name='prep_table_top_col',
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[px, py, 0.832],
        size=[0.54, 0.36, 0.018],
        contype=1,
        conaffinity=1,
        group=3,
        rgba=[0.20, 0.75, 0.35, 0.40],
    )
    # Decorative pastry dough mat & stainless mixing bowl on the left side of prep table
    _add_visual_box(world, 'prep_silicone_mat', (px - 0.24, py - 0.02, 0.8515), (0.20, 0.16, 0.0015), 'mat_warm_oak')
    _add_visual_cyl(world, 'prep_mixing_bowl', (px - 0.34, py + 0.16, 0.91), (0.10, 0.06), 'mat_ss_frame')

    # --- 5. Commercial Stainless Oven Stand (Z_top = 0.85 m) ---
    ox, oy, oz = OVEN_POS
    _add_visual_box(world, 'oven_stand_top_vis', (ox, oy, oz - 0.018), (0.40, 0.40, 0.018), 'mat_kitchen_stainless')
    _add_visual_box(world, 'oven_stand_shelf', (ox, oy, 0.18), (0.36, 0.36, 0.012), 'mat_ss_frame')
    for lx in (-0.36, 0.36):
      for ly in (-0.36, 0.36):
        _add_visual_cyl(world, f'oven_stand_leg_{lx:+.2f}_{ly:+.2f}', (ox + lx, oy + ly, 0.415), (0.022, 0.415), 'mat_ss_frame')
    # Spare aluminum baking sheets tucked on lower oven stand rails
    for s_idx, sz in enumerate((0.36, 0.50, 0.64), 1):
      _add_visual_box(world, f'oven_stand_pan_{s_idx}', (ox, oy - 0.02, sz), (0.20, 0.15, 0.004), 'mat_aluminum_pan')
    world.add_geom(
        name='oven_stand_top_col',
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[ox, oy, oz - 0.018],
        size=[0.40, 0.40, 0.018],
        contype=1,
        conaffinity=1,
        group=3,
        rgba=[0.20, 0.75, 0.35, 0.40],
    )

    # --- 6. Baker's Cooling Speed Rack (visual-only) ---
    rx, ry, _ = COOLING_RACK_POS
    for lx in (-0.24, 0.24):
      for ly in (-0.30, 0.30):
        _add_visual_box(world, f'rack_post_{lx:+.2f}_{ly:+.2f}', (rx + lx, ry + ly, 0.88), (0.014, 0.014, 0.82), 'mat_ss_frame')
        _add_visual_cyl(world, f'rack_caster_{lx:+.2f}_{ly:+.2f}', (rx + lx, ry + ly, 0.032), (0.032, 0.014), 'mat_dark_anodized', quat=[0.7071, 0.0, 0.7071, 0.0])
    _add_visual_box(world, 'rack_top_brace_f', (rx, ry - 0.30, 1.69), (0.25, 0.014, 0.014), 'mat_ss_frame')
    _add_visual_box(world, 'rack_top_brace_b', (rx, ry + 0.30, 1.69), (0.25, 0.014, 0.014), 'mat_ss_frame')
    for lvl in range(10):
      lz = 0.24 + lvl * 0.145
      for sx in (-0.215, 0.215):
        _add_visual_box(world, f'rack_rail_{lvl}_{sx:+.2f}', (rx + sx, ry, lz), (0.014, 0.29, 0.004), 'mat_ss_frame')
      if lvl in (2, 4, 6, 8):
        _add_visual_box(world, f'rack_pan_{lvl}', (rx, ry, lz + 0.008), (0.20, 0.15, 0.004), 'mat_aluminum_pan')
        if self.pastry_load and lvl in (4, 6):
          _add_croissant_cluster(world, f'rack_{lvl}', lz + 0.012, 'mat_pastry_gold', 'mat_pastry_crust')
          # Translate cluster geoms to rack XY
          for g in list(world.geoms):
            if g.name.startswith(f'rack_{lvl}_croissant_'):
              g.pos = [g.pos[0] + rx, g.pos[1] + ry, g.pos[2]]

    # --- 7. Robot Pedestal (dark anodized industrial base) ---
    ax, ay, az = ARM_BASE_POS
    _add_visual_box(world, 'robot_pedestal_base', (ax, ay, 0.025), (0.24, 0.24, 0.025), 'mat_dark_anodized')
    _add_visual_cyl(world, 'robot_pedestal_col', (ax, ay, az * 0.5), (0.12, az * 0.5 - 0.02), 'mat_dark_anodized')
    _add_visual_cyl(world, 'robot_pedestal_top', (ax, ay, az - 0.012), (0.145, 0.012), 'mat_ss_frame')
    world.add_geom(
        name='robot_pedestal_phys',
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        pos=[ax, ay, az * 0.5],
        size=[0.125, az * 0.5],
        contype=1,
        conaffinity=1,
        group=3,
        rgba=[0.25, 0.55, 0.90, 0.40],
    )

    # --- 8. Attach Upgraded Maruzen MBCO-4ME Oven ---
    oven_spec = mujoco.MjSpec.from_file(str(OVEN_MODEL_XML))
    oven_frame = world.add_frame(pos=list(OVEN_POS))
    spec.attach(oven_spec, frame=oven_frame, prefix='oven/')

    # Add oven actuators (door, handle, continuous fan, auto damper)
    _add_pd_actuator(spec, 'oven_door_act', 'oven/mbco4_door_hinge', 180.0, 14.0, (-85.0, 85.0), (0.0, 1.92))
    _add_pd_actuator(spec, 'oven_handle_act', 'oven/mbco4_handle_latch', 25.0, 1.8, (-12.0, 12.0), (-0.52, 0.52))
    _add_vel_actuator(spec, 'oven_fan_act', 'oven/mbco4_fan_spin', 0.45, (-18.0, 18.0), (-190.0, 190.0))
    _add_pd_actuator(spec, 'oven_damper_act', 'oven/mbco4_damper_hinge', 22.0, 2.0, (-10.0, 10.0), (0.0, 0.785))

    # --- 9. Attach Upgraded Removable Baking Tray (freejoint + optional pastries) ---
    tray_spec = mujoco.MjSpec.from_file(str(TRAY_MODEL_XML))
    tray_root = tray_spec.worldbody.first_body()
    tray_root.add_freejoint(name='tray_free')
    if self.pastry_load:
      tray_spec.add_material(
          name='tray_pastry_gold',
          rgba=[0.84, 0.54, 0.19, 1.0],
          metallic=0.0,
          roughness=0.44,
      )
      tray_spec.add_material(
          name='tray_pastry_crust',
          rgba=[0.66, 0.36, 0.11, 1.0],
          metallic=0.0,
          roughness=0.52,
      )
      _add_croissant_cluster(
          tray_root, 'tray', 0.003, 'tray_pastry_gold', 'tray_pastry_crust'
      )
    tray_frame = world.add_frame(pos=list(OVEN_RAIL2_WORLD))
    spec.attach(tray_spec, frame=tray_frame, prefix='tray/')

    # --- 10. Attach FAIRINO FR10 Robot Arm + Tray Fork Clamp ---
    fr10_spec = mujoco.MjSpec.from_file(str(FR10_XML))
    fr10_spec.add_material(
        name='fr10_pearl',
        rgba=[0.91, 0.92, 0.94, 1.0],
        metallic=0.22,
        roughness=0.24,
    )
    fr10_spec.add_material(
        name='fr10_accent',
        rgba=[0.16, 0.24, 0.34, 1.0],
        metallic=0.60,
        roughness=0.26,
    )
    for g in fr10_spec.geoms:
      if g.name.endswith('__visual'):
        g.group = 2
        if 'base_link' in g.name or 'wrist3' in g.name:
          g.material = 'fr10_accent'
        else:
          g.material = 'fr10_pearl'
        g.rgba = [1.0, 1.0, 1.0, 1.0]
      elif g.name.endswith('__collision'):
        g.rgba = [0.25, 0.55, 0.90, 0.40]
    for j in fr10_spec.joints:
      j.damping = [4.0, 0.0, 0.0]
      j.armature = 0.05

    grip_spec = mujoco.MjSpec.from_file(str(GRIPPER_XML))
    for s in grip_spec.sites:
      s.group = 4
      s.rgba = [0.95, 0.25, 0.25, 0.45]
    w3 = fr10_spec.body('fairino-fr10__wrist3_link')
    grip_frame = w3.add_frame(pos=[0.0, 0.0, 0.106])
    fr10_spec.attach(grip_spec, frame=grip_frame, prefix='grip/')

    arm_frame = world.add_frame(pos=list(ARM_BASE_POS))
    spec.attach(fr10_spec, frame=arm_frame, prefix='arm/')

    # Position servos for FR10 j1..j6 (smooth kinematic preview)
    for idx, (kp, kv, fmax) in enumerate(
        (
            (480.0, 55.0, 220.0),
            (520.0, 65.0, 260.0),
            (380.0, 48.0, 180.0),
            (180.0, 22.0, 80.0),
            (140.0, 18.0, 60.0),
            (110.0, 14.0, 45.0),
        ),
        1,
    ):
      _add_pd_actuator(spec, f'arm_j{idx}_act', f'arm/fairino-fr10__j{idx}', kp, kv, (-fmax, fmax))

    return spec

  def _init_kinematics_and_plan(self, model: mujoco.MjModel) -> None:
    """Resolve joint/site IDs and compute smooth IK planned path waypoints."""
    self._arm_jnt_ids = [
        model.joint(f'arm/fairino-fr10__j{i}').id for i in range(1, 7)
    ]
    self._arm_act_ids = [model.actuator(f'arm_j{i}_act').id for i in range(1, 7)]
    self._arm_body_ids = [
        model.body(f'arm/fairino-fr10__{link}').id
        for link in (
            'shoulder_link',
            'upperarm_link',
            'forearm_link',
            'wrist1_link',
            'wrist2_link',
            'wrist3_link',
        )
    ]
    self._ee_site_id = model.site('arm/grip/cell_grasp').id

    q_home = np.radians([12.0, -76.0, 98.0, -112.0, -90.0, 0.0])
    # Solve IK for realistic prep-table -> transit -> oven-mouth -> rail#2 insert poses
    q_prep = _solve_arm_ik(
        model,
        self._arm_jnt_ids,
        self._ee_site_id,
        np.radians([125.0, -72.0, 96.0, -114.0, -90.0, 35.0]),
        np.array([PREP_TRAY_WORLD[0] + 0.14, PREP_TRAY_WORLD[1] - 0.14, 0.94]),
        target_xdir=np.array([-0.55, 0.83, 0.0]),
    )
    q_transit = _solve_arm_ik(
        model,
        self._arm_jnt_ids,
        self._ee_site_id,
        np.radians([68.0, -68.0, 82.0, -104.0, -90.0, -20.0]),
        np.array([0.04, -0.34, 1.24]),
        target_xdir=np.array([0.10, 0.99, 0.0]),
    )
    q_mouth = _solve_arm_ik(
        model,
        self._arm_jnt_ids,
        self._ee_site_id,
        np.radians([22.0, -78.0, 96.0, -108.0, -90.0, -68.0]),
        np.array([OVEN_RAIL2_WORLD[0], OVEN_RAIL2_WORLD[1] - 0.44, OVEN_RAIL2_WORLD[2] + 0.02]),
        target_xdir=np.array([0.0, 1.0, 0.0]),
    )
    q_insert = _solve_arm_ik(
        model,
        self._arm_jnt_ids,
        self._ee_site_id,
        q_mouth,
        np.array([OVEN_RAIL2_WORLD[0], OVEN_RAIL2_WORLD[1] - 0.16, OVEN_RAIL2_WORLD[2] + 0.02]),
        target_xdir=np.array([0.0, 1.0, 0.0]),
    )

    self._waypoints = {
        'home': q_home,
        'prep_table': q_prep,
        'transit': q_transit,
        'oven_mouth': q_mouth,
        'oven_insert': q_insert,
    }

    # Build a smooth 25-sample planned trajectory from Prep Table -> Transit -> Oven Mouth -> Rail #2
    keyframes = [q_prep, q_transit, q_mouth, q_insert]
    qs: list[np.ndarray] = []
    segs = len(keyframes) - 1
    per_seg = 8
    for s in range(segs):
      qa, qb = keyframes[s], keyframes[s + 1]
      for k in range(per_seg):
        u = k / float(per_seg)
        # Smoothstep easing
        su = u * u * (3.0 - 2.0 * u)
        qs.append((1.0 - su) * qa + su * qb)
    qs.append(keyframes[-1].copy())
    self._planned_qs = qs

    # Evaluate FK for every planned trajectory sample to build ghost overlay geometry
    d_fk = mujoco.MjData(model)
    ee_pts: list[tuple[float, float, float]] = []
    ee_mats: list[tuple[float, ...]] = []
    arm_pts: list[list[tuple[float, float, float]]] = []
    for q in qs:
      for k, jid in enumerate(self._arm_jnt_ids):
        d_fk.qpos[int(model.jnt_qposadr[jid])] = q[k]
      mujoco.mj_kinematics(model, d_fk)
      ee_pts.append(tuple(float(v) for v in d_fk.site_xpos[self._ee_site_id]))
      ee_mats.append(tuple(float(v) for v in d_fk.site_xmat[self._ee_site_id]))
      arm_pts.append([
          tuple(float(v) for v in d_fk.xpos[bid]) for bid in self._arm_body_ids
      ] + [ee_pts[-1]])
    self._planned_ee_pts = ee_pts
    self._planned_ee_mats = ee_mats
    self._planned_arm_pts = arm_pts

  def _stage_tray(self, model: mujoco.MjModel, data: mujoco.MjData, target: str) -> None:
    jid = model.joint('tray/tray_free').id
    qadr = int(model.jnt_qposadr[jid])
    dadr = int(model.jnt_dofadr[jid])
    pos = OVEN_RAIL2_WORLD if target == 'oven_rail2' else PREP_TRAY_WORLD
    data.qpos[qadr : qadr + 3] = pos
    data.qpos[qadr + 3 : qadr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[dadr : dadr + 6] = 0.0
    mujoco.mj_forward(model, data)

  @messages.handler
  def on_load_model(self, event: messages.LoadModelEvent) -> bool:
    if event.path:
      return False
    self.spec = self.build_spec()
    watch = [
        str(p)
        for p in (OVEN_MODEL_XML, TRAY_MODEL_XML, OVEN_VISUAL_ASSETS_XML)
        if p.is_file()
    ]
    self.handle.set_model(self.spec, watch=watch)
    return True

  @messages.handler
  def on_post_model(self, event: messages.PostModelEvent) -> None:
    model, data = event.model, event.data
    self._init_kinematics_and_plan(model)
    # Initialize arm near home pose if starting from zeros
    arm_q = [data.qpos[int(model.jnt_qposadr[j])] for j in self._arm_jnt_ids]
    if np.linalg.norm(arm_q) < 1e-4:
      q0 = self._waypoints['home']
      for k, jid in enumerate(self._arm_jnt_ids):
        data.qpos[int(model.jnt_qposadr[jid])] = q0[k]
      data.qpos[int(model.jnt_qposadr[model.joint('oven/mbco4_door_hinge').id])] = math.radians(self.door_deg)
      mujoco.mj_forward(model, data)
    if self._pending_tray_stage:
      self._stage_tray(model, data, self._pending_tray_stage)
      self._pending_tray_stage = None
    self._last_telemetry_t = -1.0

  @messages.handler
  def on_hot_reload(self, event: messages.HotReloadEvent) -> None:
    if self in event.plugins:
      self.handle.reload()

  @messages.handler
  def on_render_config(self, snapshot: user_messages.RenderLightingConfig) -> None:
    self.exposure = snapshot.exposure
    self.ibl_intensity = snapshot.ibl_intensity
    self.bay_intensity = snapshot.bay_intensity
    self.bloom_enabled = snapshot.bloom_enabled
    self.bloom_strength = snapshot.bloom_strength
    self.ssao_enabled = snapshot.ssao_enabled
    self.tone_mapping = snapshot.tone_mapping
    self.pastry_load = snapshot.pastry_load
    self.handle.reload()

  @messages.handler
  def on_workcell_control(self, snapshot: user_messages.WorkcellControl) -> None:
    self.door_deg = snapshot.door_deg
    self.handle_deg = snapshot.handle_deg
    self.fan_rad_s = snapshot.fan_rad_s
    self.damper_deg = snapshot.damper_deg
    self.robot_mode = snapshot.robot_mode
    self.manual_joints_deg = snapshot.manual_joints_deg
    self.clamp_open_mm = snapshot.clamp_open_mm
    self.show_ghost_path = snapshot.show_ghost_path
    self.ghost_progress = snapshot.ghost_progress

  @messages.handler
  def on_stage_tray(self, event: user_messages.StageTrayEvent) -> None:
    self._pending_tray_stage = event.target

  @messages.handler
  def on_oven_preset(self, event: user_messages.OvenPresetEvent) -> None:
    if event.preset == 'open_load':
      self.door_deg = 102.0
      self.handle_deg = 0.0
      self.fan_rad_s = 0.0
      self.damper_deg = 0.0
      self.robot_mode = 'oven_mouth'
    elif event.preset == 'close_bake':
      self.door_deg = 0.0
      self.handle_deg = 0.0
      self.fan_rad_s = 155.0
      self.damper_deg = 32.0
      self.robot_mode = 'home'

  @messages.handler
  def on_bake(self, event: user_messages.BakeSceneEvent) -> None:
    del event
    if self.spec is None:
      return
    SCENE_XML.write_text(self.spec.to_xml(), encoding='utf-8')
    self.handle.dispatch(messages.LoadModelEvent(path=str(SCENE_XML)))

  @messages.handler
  def on_pre_step(self, event: messages.PreStepEvent) -> None:
    model, data = event.model, event.data
    if not self._arm_act_ids:
      return

    if self._pending_tray_stage is not None:
      self._stage_tray(model, data, self._pending_tray_stage)
      self._pending_tray_stage = None

    # Drive Maruzen MBCO-4ME oven actuators
    data.ctrl[model.actuator('oven_door_act').id] = math.radians(self.door_deg)
    data.ctrl[model.actuator('oven_handle_act').id] = math.radians(self.handle_deg)
    data.ctrl[model.actuator('oven_fan_act').id] = float(self.fan_rad_s)
    data.ctrl[model.actuator('oven_damper_act').id] = math.radians(self.damper_deg)
    data.ctrl[model.actuator('arm/grip/clamp_servo').id] = float(
        self.clamp_open_mm / 1000.0
    )

    # Compute smooth FR10 arm joint targets
    if self.robot_mode == 'auto_demo' and self._planned_qs:
      cycle_s = 12.0
      phase = (data.time % cycle_s) / cycle_s
      # Ping-pong smoothly along the planned Prep -> Transit -> Oven Mouth -> Insert trajectory
      u = 2.0 * phase if phase <= 0.5 else 2.0 * (1.0 - phase)
      u = u * u * (3.0 - 2.0 * u)
      f_idx = u * (len(self._planned_qs) - 1)
      i0 = int(math.floor(f_idx))
      i1 = min(i0 + 1, len(self._planned_qs) - 1)
      frac = f_idx - i0
      q_target = (1.0 - frac) * self._planned_qs[i0] + frac * self._planned_qs[i1]
    elif self.robot_mode in self._waypoints:
      q_target = self._waypoints[self.robot_mode]
    else:
      q_target = np.radians(self.manual_joints_deg)

    for k, aid in enumerate(self._arm_act_ids):
      data.ctrl[aid] = float(q_target[k])

  @messages.handler
  def on_post_step(self, event: messages.PostStepEvent) -> None:
    model, data = event.model, event.data
    if not self._arm_jnt_ids:
      return
    # Throttle telemetry snapshots to ~30 Hz
    if self._last_telemetry_t >= 0.0 and abs(data.time - self._last_telemetry_t) < 0.03:
      return
    self._last_telemetry_t = float(data.time)

    door_deg = math.degrees(
        float(data.qpos[int(model.jnt_qposadr[model.joint('oven/mbco4_door_hinge').id])])
    )
    handle_deg = math.degrees(
        float(data.qpos[int(model.jnt_qposadr[model.joint('oven/mbco4_handle_latch').id])])
    )
    fan_rad_s = float(
        data.qvel[int(model.jnt_dofadr[model.joint('oven/mbco4_fan_spin').id])]
    )
    damper_deg = math.degrees(
        float(data.qpos[int(model.jnt_qposadr[model.joint('oven/mbco4_damper_hinge').id])])
    )
    touch_n = float(data.sensor('oven/mbco4_rail2_touch').data[0])
    arm_deg = tuple(
        round(math.degrees(float(data.qpos[int(model.jnt_qposadr[j])])), 1)
        for j in self._arm_jnt_ids
    )
    ee_pos = tuple(float(v) for v in data.site_xpos[self._ee_site_id])

    # Choose ghost preview index along planned trajectory
    if self._planned_ee_pts:
      if self.robot_mode == 'auto_demo':
        # Ghost leads the real arm slightly along the planned cycle
        g_phase = ((data.time + 1.5) % 12.0) / 12.0
        gu = 2.0 * g_phase if g_phase <= 0.5 else 2.0 * (1.0 - g_phase)
      else:
        gu = float(np.clip(self.ghost_progress, 0.0, 1.0))
      g_idx = min(
          len(self._planned_ee_pts) - 1,
          max(0, int(round(gu * (len(self._planned_ee_pts) - 1)))),
      )
      ghost_ee_pos = self._planned_ee_pts[g_idx]
      ghost_ee_mat = self._planned_ee_mats[g_idx]
      ghost_arm_joints = tuple(self._planned_arm_pts[g_idx])
    else:
      ghost_ee_pos = ee_pos
      ghost_ee_mat = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
      ghost_arm_joints = ()

    phase_map = {
        'auto_demo': 'Auto Demo (Prep <-> Oven Rail #2)',
        'home': 'Home Standby',
        'prep_table': 'Prep Table Staging',
        'transit': 'Transit Clearance',
        'oven_mouth': 'Oven Mouth Approach',
        'oven_insert': 'Oven Rail #2 Insertion',
        'manual': 'Manual Joint Control',
    }

    self.handle.send_to_viewer(
        user_messages.WorkcellTelemetry(
            sim_time=float(data.time),
            phase_label=phase_map.get(self.robot_mode, self.robot_mode),
            door_deg=door_deg,
            handle_deg=handle_deg,
            fan_rpm=fan_rad_s * 60.0 / (2.0 * math.pi),
            damper_deg=damper_deg,
            rail2_touch_n=touch_n,
            arm_joints_deg=arm_deg,
            ee_pos=ee_pos,
            path_points=tuple(self._planned_ee_pts) if self.show_ghost_path else (),
            ghost_ee_pos=ghost_ee_pos,
            ghost_ee_mat=ghost_ee_mat,
            ghost_arm_joints=ghost_arm_joints if self.show_ghost_path else (),
        )
    )
