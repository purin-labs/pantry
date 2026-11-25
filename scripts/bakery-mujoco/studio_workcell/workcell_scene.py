"""Shared MuJoCo 4.0 MjSpec builder for the FR10 + Maruzen MBCO-4ME Bakery Workcell.

Single source of truth imported by both MuJoCo Studio (`sim_plugin.py`) and the
`robosim_gauntlet` T0-T4 sim-to-real verification task (`gauntlet/bakery_tray_task.py`).
Offline preview and verification only (Plan 42B keeps production controllers in Rust).
"""

from __future__ import annotations

import math
import pathlib
import struct
import tempfile
import zlib
from typing import Sequence

import mujoco
import numpy as np

WORKSPACE_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = WORKSPACE_DIR.parents[2]
OVEN_DIR = REPO_ROOT / 'assets/bakery-mujoco/maruzen-mbco-4me'
OVEN_MODEL_XML = OVEN_DIR / 'model.xml'
TRAY_MODEL_XML = OVEN_DIR / 'tray_model.xml'
OVEN_VISUAL_ASSETS_XML = OVEN_DIR / 'visual_assets.xml'
FR10_XML = REPO_ROOT / 'assets/bakery-robots/fairino-fr10/robot.xml'

# Workcell layout coordinates (meters, Z-up, oven front faces -Y).
# Maruzen MBCO-4ME is left-hinged, so placing the oven on the left (-X) swings its
# open door cleanly outward away from the robot and prep table!
OVEN_POS = (-0.40, 0.14, 0.85)
OVEN_RAIL2_OFFSET = (-0.0900, -0.1400, 0.2650)
OVEN_RAIL2_WORLD = (
    OVEN_POS[0] + OVEN_RAIL2_OFFSET[0],
    OVEN_POS[1] + OVEN_RAIL2_OFFSET[1],
    OVEN_POS[2] + OVEN_RAIL2_OFFSET[2] + 0.0005,
)
PREP_TABLE_POS = (0.54, -0.18, 0.0)
PREP_TABLE_TOP_Z = 0.850
PREP_TRAY_WORLD = (0.44, -0.18, PREP_TABLE_TOP_Z + 0.0005)
BYSTANDER_POS = (0.86, 0.06, PREP_TABLE_TOP_Z + 0.0355)
ARM_BASE_POS = (0.02, -1.12, 0.80)
COOLING_RACK_POS = (1.56, 0.14, 0.0)

# Spanner gripper geometry (in `arm/grip/spanner_base` local frame).
# Tool +X extends forward from the wrist flange into the oven (+Y world at yaw=0).
# Tool +Z points world UP when horizontal; tray center sits at (SPANNER_CENTER_X, 0, -SPANNER_DROP_Z)
# during descent (5 mm rear clearance), and shifts +5 mm along tool +X when clamped against jaw_rear.
SPANNER_CENTER_X = 0.240
SPANNER_DROP_Z = 0.074  # Beam Z above tray deck (gives wrist2 >23 mm tabletop clearance & >84 mm oven headroom!)
GRIPPER_OPEN_M = 0.045
GRIPPER_CLOSE_M = -0.015

# FR10 joint home pose (base rotated -90 deg about Z so neutral -X reach points along +Y).
# Elbow-up wrist-forward manifold: j2+j3+j4 = 0, j5 = 90 + j1 - yaw, j6 = 90 deg.
# Retracted standby pose putting `cell_grasp` at [+0.1588, -0.4500, +1.1819]:
# >165 mm clear of the MBCO-4ME oven cabinet/fascia (>85 mm even under T2 +/-80 mm dest_xy)
# and >308 mm clear above the prep table/tray, with zero overhead camera occlusion.
FR10_HOME_Q = np.radians([-50.0, -106.0, 136.0, -30.0, 40.0, 90.0])
ARM_BASE_QUAT = (0.7071067811865476, 0.0, 0.0, -0.7071067811865476)
FR10_SERVO_PARAMS = (
    # (kp, kv, forcerange_abs) — critically damped even under T2 damping_scale=0.75 / gain_scale=0.80
    (1200.0, 155.0, 260.0),
    (1400.0, 185.0, 300.0),
    (1000.0, 135.0, 220.0),
    (450.0, 62.0, 100.0),
    (360.0, 48.0, 80.0),
    (260.0, 35.0, 60.0),
)


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


def ensure_procedural_textures() -> dict[str, pathlib.Path]:
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

    face_r = make_wall(
        np.array([0.52, 0.50, 0.48], dtype=np.float32),
        np.array([0.22, 0.23, 0.25], dtype=np.float32),
        (-0.55, 0.55, -0.55, -0.05),
        np.array([1.0, 0.94, 0.84], dtype=np.float32),
    )
    face_l = make_wall(
        np.array([0.58, 0.64, 0.72], dtype=np.float32),
        np.array([0.24, 0.26, 0.30], dtype=np.float32),
        (-0.68, 0.68, -0.62, 0.12),
        np.array([0.92, 0.96, 1.0], dtype=np.float32),
    )
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
    face_d = np.full((n, n, 3), np.array([0.30, 0.31, 0.33], dtype=np.float32))
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
    _write_rgb_png(paths['ibl'], np.vstack([face_r, face_l, face_u, face_d, face_f, face_b]))

  if not paths['floor'].is_file():
    rng = np.random.default_rng(4242)
    n = 512
    tile_px = n // 4
    img = np.zeros((n, n, 3), dtype=np.float32)
    base = np.array([0.64, 0.65, 0.67], dtype=np.float32)
    grout = np.array([0.32, 0.33, 0.35], dtype=np.float32)
    for ty in range(4):
      for tx in range(4):
        shade = float(rng.uniform(-0.025, 0.025))
        img[ty * tile_px : (ty + 1) * tile_px, tx * tile_px : (tx + 1) * tile_px] = base + shade
    img = np.clip(img + rng.normal(0.0, 0.012, size=(n, n, 1)).astype(np.float32), 0.0, 1.0)
    for k in range(4):
      p = k * tile_px
      img[p : p + 3, :] = grout
      img[:, p : p + 3] = grout
      img[min(p + 3, n - 1), :] *= 0.92
      img[:, min(p + 3, n - 1)] *= 0.92
    _write_rgb_png(paths['floor'], img)

  if not paths['subway'].is_file():
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
    n = 256
    yy, xx = np.mgrid[0:n, 0:n]
    stripe = (((xx + yy) // 32) % 2) == 0
    yellow = np.array([0.92, 0.72, 0.08], dtype=np.float32)
    charcoal = np.array([0.11, 0.12, 0.13], dtype=np.float32)
    _write_rgb_png(paths['tape'], np.where(stripe[..., None], yellow, charcoal))

  return paths


def add_pd_actuator(
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


def add_vel_actuator(
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


def _build_spanner_gripper_spec() -> mujoco.MjSpec:
  """Build the low-profile overhead tray-rim spanner gripper (FR10 end-effector).

  Frame convention:
  - Root `spanner_base` sits on wrist3 flange (`pos=[0, 0, 0.106]` on wrist3).
  - Tool +X points forward into the oven (+Y world when inserting).
  - Tool +Y points left (-X world when inserting).
  - Tool +Z points UP (+Z world when inserting).
  - Tray center sits at `(SPANNER_CENTER_X, 0.0, -SPANNER_DROP_Z)` in `spanner_base` frame:
    - Fixed rear blade (`jaw_rear`) hooks behind tray rear rim (`X = 0.240 + 0.150 = 0.390 m`).
    - Sliding front clamp (`jaw_front`, joint `gripper`, axis `-1 0 0`, range `0..0.045 m`)
      pinches tray front rim (`X = 0.240 - 0.150 = 0.090 m`) toward `jaw_rear`.
    - Both pad bottoms stop at `Z = -SPANNER_DROP_Z + 0.004 m` (`4 mm` above tabletop!).
    - Width along Y is `140 mm` (`±0.070 m`), leaving `116 mm` clearance to oven Rail #3 on each side!
  """
  gs = mujoco.MjSpec()
  gs.modelname = 'bakery_tray_spanner'
  gs.compiler.degree = False
  gs.compiler.autolimits = True

  gs.add_material(name='grip_anodized', rgba=[0.18, 0.21, 0.25, 1.0], metallic=0.68, roughness=0.28)
  gs.add_material(name='grip_steel', rgba=[0.78, 0.80, 0.83, 1.0], metallic=0.88, roughness=0.24)
  gs.add_material(name='grip_silicone', rgba=[0.14, 0.44, 0.48, 1.0], metallic=0.0, roughness=0.72)

  # Rotate +90 deg about Y so wrist3 +Z aligns with tool +X (horizontal forward reach)
  # Wait: when wrist3 +Z points along world +Y (horizontal into oven),
  # quat=(0, 0.70710678, 0, 0.70710678) maps local +X -> parent +Z, local +Z -> parent +X, local +Y -> parent -Y
  # matching gripper.xml's exact flange convention!
  base = gs.worldbody.add_body(
      name='spanner_base',
      quat=[0.0, 0.7071067811865476, 0.0, 0.7071067811865476],
  )
  base.mass = 0.85
  base.ipos = [0.16, 0.0, -0.005]
  base.inertia = [0.0045, 0.016, 0.015]
  base.explicitinertial = True

  # Flange mounting collar (tool X = 0.00..0.024)
  base.add_geom(
      name='spanner_flange_vis',
      type=mujoco.mjtGeom.mjGEOM_CYLINDER,
      pos=[0.012, 0.0, 0.0],
      quat=[0.70710678, 0.0, 0.70710678, 0.0],
      size=[0.042, 0.012, 0.0],
      material='grip_steel',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  # Overhead horizontal spanner beam (tool X = 0.024..0.400, Z = -0.009..+0.009)
  # Clears tray rim top (Z = -0.032) by 23 mm and oven chamber roof by >160 mm!
  base.add_geom(
      name='spanner_beam_vis',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.212, 0.0, 0.0],
      size=[0.188, 0.026, 0.009],
      material='grip_anodized',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  base.add_geom(
      name='spanner_beam_col',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.212, 0.0, 0.0],
      size=[0.186, 0.025, 0.0085],
      contype=1,
      conaffinity=1,
      condim=4,
      friction=[0.6, 0.015, 0.003],
      solref=[0.004, 1.0],
      solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
      mass=0.0,
      group=3,
      rgba=[0.25, 0.55, 0.90, 0.40],
  )
  # Grasp center reference site (right at tray center during open descent)
  base.add_site(
      name='cell_grasp',
      pos=[SPANNER_CENTER_X, 0.0, -SPANNER_DROP_Z + 0.010],
      size=[0.008, 0.0, 0.0],
      group=4,
      rgba=[0.95, 0.25, 0.25, 0.50],
  )
  # Wrist camera angled down toward tray center for visual inspection
  base.add_camera(
      name='wrist_cam',
      pos=[0.06, 0.0, 0.065],
      xyaxes=[0.0, -1.0, 0.0, 0.35, 0.0, 0.94],
      fovy=62.0,
  )

  # --- Fixed Rear Jaw (`jaw_rear`) ---
  # Inner silicone face at X = SPANNER_CENTER_X + 0.155 = 0.395 m (5.0 mm clear behind tray
  # rear rim during descent!) and outer back at X = 0.400 m (5 mm slim blade -> clears oven
  # rear baffle with 4.5 mm margin!).
  rear = base.add_body(name='jaw_rear', pos=[0.0, 0.0, 0.0])
  rear.mass = 0.14
  rear.ipos = [0.3975, 0.0, -0.042]
  rear.inertia = [0.0005, 0.0002, 0.0005]
  rear.explicitinertial = True
  rear.add_geom(
      name='jaw_rear_stem_vis',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.3975, 0.0, -0.029],
      size=[0.0025, 0.068, 0.021],
      material='grip_steel',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  rear.add_geom(
      name='jaw_rear_pad_vis',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.3975, 0.0, -SPANNER_DROP_Z + 0.015],
      size=[0.0025, 0.068, 0.0065],
      material='grip_silicone',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  rear.add_geom(
      name='jaw_rear_pad_col',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.3975, 0.0, -SPANNER_DROP_Z + 0.015],
      size=[0.0025, 0.068, 0.0065],
      contype=1,
      conaffinity=1,
      condim=4,
      friction=[1.8, 0.04, 0.008],
      solref=[0.008, 1.0],
      solimp=[0.92, 0.98, 0.001, 0.5, 2.0],
      mass=0.0,
      group=3,
      rgba=[0.15, 0.85, 0.60, 0.55],
  )

  # --- Sliding Front Jaw (`jaw_front`) ---
  # Slide joint `gripper`: axis="-1 0 0", range="-0.015 0.045".
  # At gripper = +0.045: inner face at X = 0.0445 m (45 mm clear in front of tray front rim!).
  # At gripper = -0.0055: inner face at X = 0.0950 m (clamps 300 mm tray firmly against jaw_rear at 0.395 m!).
  front = base.add_body(name='jaw_front', pos=[0.0, 0.0, 0.0])
  front.mass = 0.16
  front.ipos = [0.084, 0.0, -0.042]
  front.inertia = [0.0006, 0.00025, 0.0006]
  front.explicitinertial = True
  front.add_joint(
      name='gripper',
      type=mujoco.mjtJoint.mjJNT_SLIDE,
      axis=[-1.0, 0.0, 0.0],
      limited=True,
      range=[GRIPPER_CLOSE_M, GRIPPER_OPEN_M],
      damping=12.0,
      armature=0.01,
      frictionloss=0.15,
      solref_limit=[0.005, 1.0],
  )
  front.add_geom(
      name='jaw_front_carriage_vis',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.083, 0.0, -0.025],
      size=[0.006, 0.068, 0.025],
      material='grip_steel',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  front.add_geom(
      name='jaw_front_pad_vis',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.085, 0.0, -SPANNER_DROP_Z + 0.015],
      size=[0.0045, 0.068, 0.0065],
      material='grip_silicone',
      contype=0,
      conaffinity=0,
      mass=0.0,
      group=2,
  )
  front.add_geom(
      name='jaw_front_pad_col',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[0.085, 0.0, -SPANNER_DROP_Z + 0.015],
      size=[0.0045, 0.068, 0.0065],
      contype=1,
      conaffinity=1,
      condim=4,
      friction=[1.8, 0.04, 0.008],
      solref=[0.008, 1.0],
      solimp=[0.92, 0.98, 0.001, 0.5, 2.0],
      mass=0.0,
      group=3,
      rgba=[0.15, 0.85, 0.60, 0.55],
  )

  # Exclude beam <-> sliding front jaw self-contact
  gs.add_exclude(name='ex_beam_front', bodyname1='spanner_base', bodyname2='jaw_front')
  gs.add_exclude(name='ex_beam_rear', bodyname1='spanner_base', bodyname2='jaw_rear')

  # Force-capped compliant servo: max 15.5 N pinch force (<< 35 N SafetyLimits.max_grasp_force_n!)
  # With mu = 1.8 on both pads -> holds up to 2 * 15.5 * 1.8 = 55.8 N (>6.5 g!) with zero crush!
  add_pd_actuator(
      gs,
      'gripper_act',
      'gripper',
      kp=1650.0,
      kv=65.0,
      forcerange=(-15.5, 15.5),
      ctrlrange=(GRIPPER_CLOSE_M, GRIPPER_OPEN_M),
  )
  return gs


def build_workcell_spec(
    *,
    for_gauntlet: bool = False,
    pastry_load: bool = True,
    tray_start: str = 'prep_table',
    exposure: float = 0.45,
    ibl_intensity: float = 30000.0,
    bay_intensity: float = 28000.0,
    bloom_enabled: bool = True,
    bloom_strength: float = 0.18,
    ssao_enabled: bool = True,
    tone_mapping: str = 'aces',
) -> mujoco.MjSpec:
  """Build the shared FR10 + Maruzen MBCO-4ME Bakery Workcell MjSpec.

  Args:
    for_gauntlet: When True, omits non-robot oven actuators (per robosim_gauntlet
      preflight invariant) and fixes the oven door pre-opened at 102 deg for tray
      insertion testing. When False (Studio interactive mode), retains live oven
      door/handle/fan/damper actuators and architectural Filament PBR polish.
    pastry_load: Include decorative zero-mass croissants on the baking tray.
    tray_start: `'prep_table'` (default for pickup+insert) or `'oven_rail2'`.
  """
  tex_paths = ensure_procedural_textures()

  spec = mujoco.MjSpec()
  spec.modelname = 'seams_pantry_bakery_workcell'
  spec.compiler.degree = False
  spec.compiler.autolimits = True
  spec.option.timestep = 0.002
  spec.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST
  spec.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
  spec.option.impratio = 10.0
  spec.option.noslip_iterations = 4

  spec.visual.global_.azimuth = -132.0
  spec.visual.global_.elevation = -22.0
  spec.visual.global_.fovy = 42.0
  spec.visual.global_.offwidth = 1280 if not for_gauntlet else 320
  spec.visual.global_.offheight = 720 if not for_gauntlet else 240
  spec.visual.quality.shadowsize = 2048 if not for_gauntlet else 1024
  spec.visual.quality.offsamples = 4 if not for_gauntlet else 0
  if not for_gauntlet:
    spec.visual.headlight.active = 0
  else:
    spec.visual.headlight.active = 1
    spec.visual.headlight.ambient = [0.48, 0.48, 0.50]
    spec.visual.headlight.diffuse = [0.65, 0.65, 0.65]

  if not for_gauntlet:
    spec.add_text(name='filament.cg.tone_mapping', data=tone_mapping)
    spec.add_numeric(name='filament.cg.exposure', data=[float(exposure)])
    spec.add_numeric(name='filament.cg.contrast', data=[1.06])
    spec.add_numeric(name='filament.cg.saturation', data=[1.05])
    spec.add_numeric(name='filament.ao.enabled', data=[1.0 if ssao_enabled else 0.0])
    spec.add_text(name='filament.ao.quality', data='high')
    spec.add_numeric(name='filament.ao.bent_normals', data=[1.0])
    spec.add_numeric(name='filament.ao.ssct', data=[1.0])
    spec.add_numeric(name='filament.bloom.enabled', data=[1.0 if bloom_enabled else 0.0])
    spec.add_numeric(name='filament.bloom.strength', data=[float(bloom_strength)])
    spec.add_text(name='filament.bloom.quality', data='medium')
    spec.add_text(name='filament.shadows.type', data='pcf')
    spec.add_numeric(name='filament.shadows.map_size', data=[2048.0])
    spec.add_numeric(name='filament.clear_color', data=[0.74, 0.77, 0.81, 1.0])

  # Textures
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

  # Materials
  mat_floor = spec.add_material(
      name='mat_floor_tile',
      rgba=[1.0, 1.0, 1.0, 1.0],
      metallic=0.0,
      roughness=0.26,
      reflectance=0.14 if not for_gauntlet else 0.0,
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

  spec.add_material(name='mat_ss_frame', rgba=[0.74, 0.77, 0.80, 1.0], metallic=0.90, roughness=0.28)
  spec.add_material(name='mat_plaster_wall', rgba=[0.86, 0.85, 0.82, 1.0], metallic=0.0, roughness=0.84)
  spec.add_material(name='mat_dark_anodized', rgba=[0.24, 0.26, 0.29, 1.0], metallic=0.62, roughness=0.32)
  spec.add_material(name='mat_warm_oak', rgba=[0.56, 0.39, 0.24, 1.0], metallic=0.0, roughness=0.52)
  spec.add_material(name='mat_led_bay', rgba=[1.0, 0.97, 0.91, 1.0], metallic=0.0, roughness=0.15, emission=1.0)
  spec.add_material(name='mat_daylight_window', rgba=[0.86, 0.93, 1.0, 1.0], metallic=0.0, roughness=0.10, emission=0.85)
  spec.add_material(name='mat_pastry_gold', rgba=[0.86, 0.56, 0.16, 1.0], metallic=0.0, roughness=0.44)
  spec.add_material(name='mat_pastry_crust', rgba=[0.66, 0.36, 0.11, 1.0], metallic=0.0, roughness=0.52)
  spec.add_material(name='mat_aluminum_pan', rgba=[0.76, 0.78, 0.81, 1.0], metallic=0.88, roughness=0.25)
  spec.add_material(name='mat_bystander_ceramic', rgba=[0.22, 0.44, 0.72, 1.0], metallic=0.05, roughness=0.25)

  world = spec.worldbody

  # --- 1. Lighting ---
  if not for_gauntlet:
    world.add_light(
        name='env_ibl',
        type=mujoco.mjtLightType.mjLIGHT_IMAGE,
        texture='bakery_ibl_cube',
        intensity=float(ibl_intensity),
    )
    world.add_light(
        name='bay_key_center',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[0.10, -0.55, 2.58],
        dir=[0.08, 0.22, -0.97],
        diffuse=[1.0, 0.97, 0.93],
        intensity=float(bay_intensity),
        cutoff=60.0,
        exponent=1.6,
        bulbradius=0.14,
        castshadow=True,
    )
    world.add_light(
        name='bay_oven_accent',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[OVEN_POS[0] - 0.10, -0.90, 2.42],
        dir=[0.04, 0.44, -0.90],
        diffuse=[1.0, 0.95, 0.88],
        intensity=float(bay_intensity * 0.78),
        cutoff=50.0,
        exponent=1.8,
        bulbradius=0.10,
        castshadow=True,
    )
    world.add_light(
        name='bay_prep_fill',
        type=mujoco.mjtLightType.mjLIGHT_SPOT,
        pos=[PREP_TABLE_POS[0] + 0.08, -0.70, 2.52],
        dir=[-0.05, 0.18, -0.98],
        diffuse=[0.94, 0.97, 1.0],
        intensity=float(bay_intensity * 0.65),
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
        intensity=float(bay_intensity * 0.35),
        castshadow=False,
    )
    world.add_light(
        name='front_studio_fill',
        type=mujoco.mjtLightType.mjLIGHT_DIRECTIONAL,
        pos=[0.3, -3.0, 2.2],
        dir=[-0.05, 0.82, -0.56],
        diffuse=[1.0, 0.98, 0.96],
        intensity=float(bay_intensity * 0.25),
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
  else:
    world.add_light(pos=[0.0, -1.2, 2.6], dir=[0.0, 0.35, -0.94], diffuse=[0.85, 0.85, 0.85])
    world.add_light(pos=[-0.8, 0.3, 2.4], dir=[0.25, -0.2, -0.95], diffuse=[0.45, 0.45, 0.45])

  # --- 2. Cameras ---
  # Unprivileged overhead RGB-D camera looking straight down over prep table & oven!
  world.add_camera(
      name='overhead_cam',
      pos=[0.02, -0.02, 2.72],
      xyaxes=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
      fovy=56.0,
  )
  world.add_camera(
      name='hero_3_4',
      pos=[1.48, -2.52, 1.84],
      xyaxes=[0.84, 0.54, 0.0, -0.18, 0.28, 0.94],
  )
  world.add_camera(
      name='oven_closeup',
      pos=[OVEN_RAIL2_WORLD[0], -1.08, 1.24],
      xyaxes=[1.0, 0.0, 0.0, 0.0, 0.12, 0.99],
  )
  world.add_camera(
      name='robot_gripper',
      pos=[0.86, -1.68, 1.50],
      xyaxes=[0.74, 0.67, 0.0, -0.22, 0.24, 0.95],
  )

  # --- 3. Floor & Kitchen Architecture ---
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
  z_tape = 0.0012
  tape_w = 0.035
  for tname, tpos, tsize in (
      ('zone_tape_front', (0.05, -1.45, z_tape), (1.72, tape_w, 0.0006)),
      ('zone_tape_back', (0.05, 0.88, z_tape), (1.72, tape_w, 0.0006)),
      ('zone_tape_left', (-1.65, -0.285, z_tape), (tape_w, 1.18, 0.0006)),
      ('zone_tape_right', (1.75, -0.285, z_tape), (tape_w, 1.18, 0.0006)),
  ):
    _add_visual_box(world, tname, tpos, tsize, 'mat_zone_tape')

  rear_quat = (0.70710678, 0.70710678, 0.0, 0.0)
  _add_visual_box(world, 'wall_rear_kick', (0.35, 1.03, 0.06), (3.40, 0.012, 0.06), 'mat_ss_frame')
  _add_visual_box(world, 'wall_rear_subway', (0.35, 1.05, 0.88), (3.40, 0.76, 0.02), 'mat_subway_wall', quat=rear_quat)
  _add_visual_box(world, 'wall_rear_trim', (0.35, 1.035, 1.66), (3.40, 0.018, 0.025), 'mat_warm_oak')
  _add_visual_box(world, 'wall_rear_upper', (0.35, 1.06, 2.34), (3.40, 0.02, 0.66), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_right_return', (3.05, -0.80, 1.50), (0.03, 2.00, 1.50), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_left_lower', (-2.15, -0.45, 0.52), (0.03, 1.52, 0.52), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_left_upper', (-2.15, -0.45, 2.45), (0.03, 1.52, 0.35), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_left_pillar_b', (-2.15, 0.72, 1.55), (0.03, 0.36, 0.58), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_left_pillar_f', (-2.15, -1.62, 1.55), (0.03, 0.36, 0.58), 'mat_plaster_wall')
  _add_visual_box(world, 'wall_left_window_pane', (-2.17, -0.45, 1.56), (0.008, 0.84, 0.50), 'mat_daylight_window')
  _add_visual_box(world, 'wall_left_mullion_v', (-2.14, -0.45, 1.56), (0.018, 0.018, 0.52), 'mat_dark_anodized')
  _add_visual_box(world, 'wall_left_mullion_h', (-2.14, -0.45, 1.56), (0.018, 0.86, 0.018), 'mat_dark_anodized')

  if not for_gauntlet:
    # Exhaust hood & ceiling bays (omitted in gauntlet so overhead_cam has an unobstructed FOV!)
    _add_visual_box(world, 'hood_canopy_body', (OVEN_POS[0], 0.36, 2.16), (0.56, 0.44, 0.14), 'mat_kitchen_stainless')
    _add_visual_box(world, 'hood_canopy_lip', (OVEN_POS[0], 0.36, 2.01), (0.57, 0.45, 0.015), 'mat_ss_frame')
    _add_visual_cyl(world, 'hood_duct_riser', (OVEN_POS[0], 0.53, 2.58), (0.11, 0.28), 'mat_ss_frame')
    for b_idx, (bx, by) in enumerate(((-0.75, -0.35), (0.55, -0.35), (0.05, 0.45)), 1):
      _add_visual_box(world, f'ceiling_bay_housing_{b_idx}', (bx, by, 2.71), (0.52, 0.11, 0.025), 'mat_dark_anodized')
      _add_visual_box(world, f'ceiling_bay_led_{b_idx}', (bx, by, 2.682), (0.48, 0.08, 0.006), 'mat_led_bay')

  # --- 4. Stainless Prep Table (flat top at Z = 0.850 m, sized for ±6 cm / ±60 deg T2 tray shifts) ---
  px, py, _ = PREP_TABLE_POS
  _add_visual_box(world, 'prep_table_top_vis', (px, py, 0.832), (0.52, 0.38, 0.018), 'mat_kitchen_stainless')
  _add_visual_box(world, 'prep_table_backsplash', (px, py + 0.365, 0.895), (0.52, 0.015, 0.045), 'mat_kitchen_stainless')
  _add_visual_box(world, 'prep_table_undershelf', (px, py, 0.22), (0.47, 0.33, 0.014), 'mat_ss_frame')
  for lx in (-0.47, 0.47):
    for ly in (-0.33, 0.33):
      _add_visual_cyl(world, f'prep_leg_{lx:+.2f}_{ly:+.2f}', (px + lx, py + ly, 0.41), (0.020, 0.41), 'mat_ss_frame')
  world.add_geom(
      name='prep_table_top_col',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[px, py, 0.832],
      size=[0.52, 0.38, 0.018],
      contype=1,
      conaffinity=1,
      condim=4,
      friction=[0.65, 0.015, 0.003],
      solref=[0.004, 1.0],
      solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
      group=3,
      rgba=[0.20, 0.75, 0.35, 0.40],
  )

  # Freejoint ceramic bystander prep dish on far-left corner of prep table (for safety grading)
  bystander = world.add_body(name='bystander_dish', pos=list(BYSTANDER_POS))
  bystander.add_freejoint(name='bystander_dish_free')
  bystander.add_geom(
      name='bystander_dish_geom',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      size=[0.038, 0.038, 0.035],
      mass=0.22,
      material='mat_bystander_ceramic',
      contype=1,
      conaffinity=1,
      condim=4,
      friction=[0.85, 0.015, 0.003],
      solref=[0.006, 1.0],
      solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
      group=2,
  )

  # --- 5. Commercial Stainless Oven Stand (Z_top = 0.850 m) ---
  ox, oy, oz = OVEN_POS
  _add_visual_box(world, 'oven_stand_top_vis', (ox, oy, oz - 0.018), (0.44, 0.44, 0.018), 'mat_kitchen_stainless')
  _add_visual_box(world, 'oven_stand_shelf', (ox, oy, 0.18), (0.38, 0.38, 0.012), 'mat_ss_frame')
  for lx in (-0.38, 0.38):
    for ly in (-0.38, 0.38):
      _add_visual_cyl(world, f'oven_stand_leg_{lx:+.2f}_{ly:+.2f}', (ox + lx, oy + ly, 0.415), (0.022, 0.415), 'mat_ss_frame')
  for s_idx, sz in enumerate((0.36, 0.50, 0.64), 1):
    _add_visual_box(world, f'oven_stand_pan_{s_idx}', (ox, oy - 0.02, sz), (0.20, 0.15, 0.004), 'mat_aluminum_pan')
  world.add_geom(
      name='oven_stand_top_col',
      type=mujoco.mjtGeom.mjGEOM_BOX,
      pos=[ox, oy, oz - 0.018],
      size=[0.44, 0.44, 0.018],
      contype=1,
      conaffinity=1,
      condim=4,
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
      if pastry_load and lvl in (4, 6):
        _add_croissant_cluster(world, f'rack_{lvl}', lz + 0.012, 'mat_pastry_gold', 'mat_pastry_crust')
        for g in list(world.geoms):
          if g.name.startswith(f'rack_{lvl}_croissant_'):
            g.pos = [g.pos[0] + rx, g.pos[1] + ry, g.pos[2]]

  # --- 7. Robot Pedestal ---
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
      condim=4,
      group=3,
      rgba=[0.25, 0.55, 0.90, 0.40],
  )

  # --- 8. Attach Upgraded Maruzen MBCO-4ME Oven ---
  oven_spec = mujoco.MjSpec.from_file(str(OVEN_MODEL_XML))
  if for_gauntlet:
    # Keep door pre-opened at 102 deg passively with high hinge damping/frictionloss
    # and omit non-robot oven actuators (per robosim_gauntlet preflight invariant).
    for j in oven_spec.joints:
      if j.name == 'mbco4_door_hinge':
        j.damping = [60.0, 0.0, 0.0]
        j.frictionloss = 40.0
  oven_frame = world.add_frame(pos=list(OVEN_POS))
  spec.attach(oven_spec, frame=oven_frame, prefix='oven/')

  if not for_gauntlet:
    add_pd_actuator(spec, 'oven_door_act', 'oven/mbco4_door_hinge', 180.0, 14.0, (-85.0, 85.0), (0.0, 1.92))
    add_pd_actuator(spec, 'oven_handle_act', 'oven/mbco4_handle_latch', 25.0, 1.8, (-12.0, 12.0), (-0.52, 0.52))
    add_vel_actuator(spec, 'oven_fan_act', 'oven/mbco4_fan_spin', 0.45, (-18.0, 18.0), (-190.0, 190.0))
    add_pd_actuator(spec, 'oven_damper_act', 'oven/mbco4_damper_hinge', 22.0, 2.0, (-10.0, 10.0), (0.0, 0.785))

  # --- 9. Attach Upgraded Removable Baking Tray (freejoint, real contact) ---
  tray_spec = mujoco.MjSpec.from_file(str(TRAY_MODEL_XML))
  tray_root = tray_spec.worldbody.first_body()
  tray_root.add_freejoint(name='tray_free')
  # Give the tray rims high silicone-friendly friction so gentle <28 N clamping never slips!
  for g in tray_spec.geoms:
    if g.name.endswith('_rim_col'):
      g.friction = [1.2, 0.03, 0.005]
      g.solref = [0.006, 1.0]
    elif g.name.endswith('_deck_col'):
      g.friction = [0.65, 0.015, 0.003]
  if pastry_load:
    tray_spec.add_material(name='tray_pastry_gold', rgba=[0.88, 0.56, 0.14, 1.0], metallic=0.0, roughness=0.44)
    tray_spec.add_material(name='tray_pastry_crust', rgba=[0.68, 0.36, 0.09, 1.0], metallic=0.0, roughness=0.52)
    _add_croissant_cluster(tray_root, 'tray', 0.003, 'tray_pastry_gold', 'tray_pastry_crust')
  tray_pos = PREP_TRAY_WORLD if tray_start == 'prep_table' else OVEN_RAIL2_WORLD
  tray_frame = world.add_frame(pos=list(tray_pos))
  spec.attach(tray_spec, frame=tray_frame, prefix='tray/')

  # --- 10. Attach Upgraded FAIRINO FR10 Cobot + Overhead Tray-Spanner Gripper ---
  fr10_spec = mujoco.MjSpec.from_file(str(FR10_XML))
  fr10_spec.add_material(name='fr10_pearl', rgba=[0.91, 0.92, 0.94, 1.0], metallic=0.22, roughness=0.24)
  fr10_spec.add_material(name='fr10_accent', rgba=[0.16, 0.24, 0.34, 1.0], metallic=0.60, roughness=0.26)
  for g in fr10_spec.geoms:
    if g.name.endswith('__visual'):
      g.group = 2
      g.material = 'fr10_accent' if ('base_link' in g.name or 'wrist3' in g.name) else 'fr10_pearl'
      g.rgba = [1.0, 1.0, 1.0, 1.0]
    elif g.name.endswith('__collision'):
      g.rgba = [0.25, 0.55, 0.90, 0.40]
  # Enable native gravity compensation on FR10 arm links (matches real cobot controller & allows T4 gravcomp_delta!)
  for b in fr10_spec.bodies:
    if b.name and b.name != 'world':
      b.gravcomp = 1.0
  for j in fr10_spec.joints:
    j.damping = [6.0, 0.0, 0.0]
    j.armature = 0.06

  grip_spec = _build_spanner_gripper_spec()
  for b in grip_spec.bodies:
    if b.name and b.name != 'world':
      b.gravcomp = 1.0
  w3 = fr10_spec.body('fairino-fr10__wrist3_link')
  grip_frame = w3.add_frame(pos=[0.0, 0.0, 0.106])
  fr10_spec.attach(grip_spec, frame=grip_frame, prefix='grip/')
  # Exclude wrist3 <-> gripper base self-contact
  fr10_spec.add_exclude(name='ex_w3_grip', bodyname1='fairino-fr10__wrist3_link', bodyname2='grip/spanner_base')
  fr10_spec.add_exclude(name='ex_w2_grip', bodyname1='fairino-fr10__wrist2_link', bodyname2='grip/spanner_base')

  arm_frame = world.add_frame(pos=list(ARM_BASE_POS), quat=list(ARM_BASE_QUAT))
  spec.attach(fr10_spec, frame=arm_frame, prefix='arm/')
  # Exclude robot base <-> pedestal contact (bolted mount)
  spec.add_exclude(name='ex_base_world', bodyname1='world', bodyname2='arm/fairino-fr10__base_link')

  for idx, (kp, kv, fmax) in enumerate(FR10_SERVO_PARAMS, 1):
    jname = f'arm/fairino-fr10__j{idx}'
    j_el = spec.joint(jname)
    ctrl_rng = (float(j_el.range[0]), float(j_el.range[1]))
    add_pd_actuator(spec, f'arm_j{idx}_act', jname, kp, kv, (-fmax, fmax), ctrl_rng)

  return spec


def _solve_spanner_ik_single(
    model: mujoco.MjModel,
    d: mujoco.MjData,
    qpos_adrs: Sequence[int],
    dof_adrs: Sequence[int],
    q_low: np.ndarray,
    q_high: np.ndarray,
    site_id: int,
    q_seed: np.ndarray,
    target_pos: np.ndarray,
    des_x: np.ndarray,
    des_z: np.ndarray,
    iters: int,
) -> tuple[np.ndarray, float, float]:
  q = np.clip(np.asarray(q_seed, dtype=np.float64).copy(), q_low + 0.04, q_high - 0.04)
  jacp = np.zeros((3, model.nv), dtype=np.float64)
  jacr = np.zeros((3, model.nv), dtype=np.float64)
  pos_norm = 999.0
  rot_norm = 999.0
  for _ in range(iters):
    for k, adr in enumerate(qpos_adrs):
      d.qpos[adr] = q[k]
    mujoco.mj_kinematics(model, d)
    mujoco.mj_comPos(model, d)

    pos_err = target_pos - d.site_xpos[site_id]
    xmat = d.site_xmat[site_id].reshape(3, 3)
    rot_err = 0.65 * np.cross(xmat[:, 0], des_x) + 0.65 * np.cross(xmat[:, 2], des_z)
    pos_norm = float(np.linalg.norm(pos_err))
    rot_norm = float(np.linalg.norm(rot_err))
    if pos_norm < 3e-4 and rot_norm < 2e-3:
      break

    mujoco.mj_jacSite(model, d, jacp, jacr, site_id)
    J = np.vstack([jacp[:, dof_adrs], jacr[:, dof_adrs]])
    err = np.concatenate([pos_err, rot_err])
    lam = 0.035 if pos_norm < 0.08 else 0.08
    dq = J.T @ np.linalg.solve(J @ J.T + (lam**2) * np.eye(6), err)
    step = 0.72 if pos_norm < 0.12 else 0.55
    q = np.clip(q + step * dq, q_low + 0.04, q_high - 0.04)
  return q, pos_norm, rot_norm


def solve_spanner_ik(
    model: mujoco.MjModel,
    joint_ids: Sequence[int],
    site_id: int,
    q_init: np.ndarray,
    target_pos: np.ndarray,
    target_yaw_rad: float = 0.0,
    iters: int = 120,
) -> tuple[np.ndarray, float, float]:
  """Solve 6-DOF DLS IK for `arm/grip/cell_grasp` with level tool (+Z up) and yaw around Z.

  At `target_yaw_rad = 0.0`:
  - Tool +X points along world +Y (straight into the Maruzen oven!).
  - Tool +Z points along world +Z (horizontal level tray!).
  """
  d = mujoco.MjData(model)
  qpos_adrs = [int(model.jnt_qposadr[j]) for j in joint_ids]
  dof_adrs = [int(model.jnt_dofadr[j]) for j in joint_ids]
  q_low = np.array([model.jnt_range[j, 0] for j in joint_ids], dtype=np.float64)
  q_high = np.array([model.jnt_range[j, 1] for j in joint_ids], dtype=np.float64)

  des_x = np.array([-math.sin(target_yaw_rad), math.cos(target_yaw_rad), 0.0], dtype=np.float64)
  des_z = np.array([0.0, 0.0, 1.0], dtype=np.float64)

  def _branch_ok(q_vec: np.ndarray) -> bool:
    return (
        -2.20 <= q_vec[1] <= -0.35
        and 0.35 <= q_vec[2] <= 2.65
        and abs(q_vec[5] - math.pi / 2.0) < 0.35
    )

  best_q, best_p, best_r = _solve_spanner_ik_single(
      model, d, qpos_adrs, dof_adrs, q_low, q_high, site_id,
      q_init, target_pos, des_x, des_z, iters,
  )
  if best_p < 1e-3 and best_r < 5e-3 and _branch_ok(best_q):
    return best_q, best_p, best_r

  # Multi-seed fallback on the clean elbow-up wrist-forward manifold:
  # j2 + j3 + j4 = 0, j5 = pi/2 + j1 - target_yaw_rad, j6 = pi/2.
  wrist_est = target_pos - SPANNER_CENTER_X * des_x
  dx = float(wrist_est[0] - ARM_BASE_POS[0])
  dy = float(wrist_est[1] - ARM_BASE_POS[1])
  # Neutral j1=0 points along +Y; +j1 rotates CCW toward -X -> j1 ≈ atan2(-dx, dy)
  j1_est = math.atan2(-dx, max(dy, 0.05))
  j5_est = math.pi / 2.0 + j1_est - target_yaw_rad
  best_score = (0.0 if _branch_ok(best_q) else 10.0) + best_p + 0.1 * best_r
  for elbow_seed in (
      np.array([j1_est, -1.15, 2.00, -0.85, j5_est, math.pi / 2.0]),
      np.array([j1_est, -0.85, 1.55, -0.70, j5_est, math.pi / 2.0]),
      np.array([j1_est, -1.45, 2.25, -0.80, j5_est, math.pi / 2.0]),
      FR10_HOME_Q.copy(),
  ):
    q_cand, p_cand, r_cand = _solve_spanner_ik_single(
        model, d, qpos_adrs, dof_adrs, q_low, q_high, site_id,
        elbow_seed, target_pos, des_x, des_z, iters + 40,
    )
    score = (0.0 if _branch_ok(q_cand) else 10.0) + p_cand + 0.1 * r_cand
    if score < best_score:
      best_q, best_p, best_r, best_score = q_cand, p_cand, r_cand, score
      if best_p < 5e-4 and best_r < 3e-3 and _branch_ok(best_q):
        break

  return best_q, best_p, best_r
