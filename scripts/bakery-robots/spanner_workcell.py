"""Compose the Plan 24 FAIRINO FR10 + Maruzen MBCO-4ME overhead spanner-gripper workcell.

Reuses the single-source layout and spanner-gripper geometry constants from
`scripts/bakery-mujoco/studio_workcell/workcell_scene.py`, bound to the canonical
`crates/bakery-native` body/joint/site/actuator contract (`cell_gripper`,
`cell_upper_jaw`, `clamp_opening`, `clamp_servo`, `cell_grasp`, `mbco_tray`,
`mbco_tray_free`, `cold_contents`, `table_top`, `source_tray_center`, `mbco_slot_3`).
"""

from __future__ import annotations

import math
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import mujoco
import numpy as np
from prepare import ROBOTS, RobotSpec
from workcell import attach_robot

ROOT = Path(__file__).resolve().parents[2]
STUDIO_DIR = ROOT / "scripts/bakery-mujoco/studio_workcell"
if str(STUDIO_DIR) not in sys.path:
    sys.path.insert(0, str(STUDIO_DIR))

import workcell_scene as ws  # noqa: E402

MBCO4_DIR = ROOT / "assets/bakery-mujoco/maruzen-mbco-4me"
MBCO4_MODEL_XML = MBCO4_DIR / "model.xml"
MBCO4_TRAY_XML = MBCO4_DIR / "tray_model.xml"
MBCO4_GLB = MBCO4_DIR / "maruzen-mbco-4me.glb"
FR10_SPEC: RobotSpec = next(robot for robot in ROBOTS if robot.slug == "fairino-fr10")
SPANNER_ROBOT_SLUGS = (
    "fairino-fr10",
    "universal-robots-ur5e",
    "fanuc-crx10ial",
)
SPANNER_ROBOTS: tuple[RobotSpec, ...] = tuple(
    next(robot for robot in ROBOTS if robot.slug == slug)
    for slug in SPANNER_ROBOT_SLUGS
)

# Empty 400x300 mm MBCO-4ME tray shell mass split across collision boxes so
# total mass is 0.85 kg with CoM at (0, 0, 0.006 m) AND MuJoCo recomputes mass,
# CoM and inertia automatically when Rust mutates `cold_contents`.
TRAY_SHELL_MASSES = {
    "mbco4_tray_deck_col": 0.4675,
    "mbco4_tray_front_rim_col": 0.11,
    "mbco4_tray_rear_rim_col": 0.11,
    "mbco4_tray_left_rim_col": 0.08125,
    "mbco4_tray_right_rim_col": 0.08125,
}


@dataclass(frozen=True)
class SpannerLayout:
    base_pos: tuple[float, float, float]
    pedestal_col_half: float
    pedestal_plate_half: float
    table_pos: tuple[float, float, float]
    table_size: tuple[float, float, float]
    tray_pos: tuple[float, float, float]
    rack_pos: tuple[float, float]
    rack_z: float
    home_q: tuple[float, ...]


_STANDARD_LAYOUT = SpannerLayout(
    base_pos=ws.ARM_BASE_POS,
    pedestal_col_half=0.10,
    pedestal_plate_half=0.16,
    table_pos=ws.PREP_TABLE_POS,
    table_size=(0.46, 0.34, 0.020),
    tray_pos=ws.PREP_TRAY_WORLD,
    rack_pos=(0.78, -0.86),
    rack_z=0.850,
    home_q=tuple(float(v) for v in ws.FR10_HOME_Q),
)

SPANNER_LAYOUTS: dict[str, SpannerLayout] = {
    "fairino-fr10": _STANDARD_LAYOUT,
    "fanuc-crx10ial": SpannerLayout(
        base_pos=_STANDARD_LAYOUT.base_pos,
        pedestal_col_half=_STANDARD_LAYOUT.pedestal_col_half,
        pedestal_plate_half=_STANDARD_LAYOUT.pedestal_plate_half,
        table_pos=_STANDARD_LAYOUT.table_pos,
        table_size=_STANDARD_LAYOUT.table_size,
        tray_pos=_STANDARD_LAYOUT.tray_pos,
        rack_pos=_STANDARD_LAYOUT.rack_pos,
        rack_z=_STANDARD_LAYOUT.rack_z,
        home_q=(-0.798, -0.710, 3.389, 0.898, -1.157, 2.675),
    ),
    "universal-robots-ur5e": SpannerLayout(
        base_pos=(-0.06, -0.96, 0.95),
        pedestal_col_half=0.09,
        pedestal_plate_half=0.11,
        table_pos=(0.48, -0.14, 0.0),
        table_size=(0.34, 0.20, 0.020),
        tray_pos=(0.38, -0.22, ws.PREP_TABLE_TOP_Z + 0.0005),
        rack_pos=(0.48, -0.78),
        rack_z=0.760,
        home_q=(-0.6065, -2.2979, -1.5543, -2.431, -2.1773, 1.5708),
    ),
}

# Re-export verified constants for build_native_assets.py
SPANNER_HOME_Q = ws.FR10_HOME_Q
SPANNER_OPEN_M = ws.GRIPPER_OPEN_M
SPANNER_TRAY_WORLD = ws.PREP_TRAY_WORLD
SPANNER_TRAY_QUAT = (1.0, 0.0, 0.0, 0.0)


def spanner_home_q(robot_slug: str) -> tuple[float, ...]:
    return SPANNER_LAYOUTS[robot_slug].home_q


def _build_spanner_gripper_spec() -> mujoco.MjSpec:
    """Build the overhead tray-rim spanner gripper using bakery-native canonical names.

    In `cell_gripper` local frame:
    - Tool +X points forward into the oven (+Y world at yaw=0).
    - Tool +Y points left (-X world at yaw=0).
    - Tool +Z points up (+Z world at yaw=0).
    - `cell_grasp` carries a -90 deg Z rotation so its axes equal world axes
      (`Orientation::World` in `crates/bakery-native/src/ik.rs`) at yaw=0.
    - Every gripper collision geom starts with `clamp_` so `disable_grip()` and
      placement checks in `crates/bakery-native` apply uniformly.
    """
    gs = mujoco.MjSpec()
    gs.modelname = "plan24_bakery_tray_spanner"
    gs.compiler.degree = False
    gs.compiler.autolimits = True

    base = gs.worldbody.add_body(
        name="cell_gripper",
        quat=[0.0, math.sqrt(0.5), 0.0, math.sqrt(0.5)],
    )
    base.mass = 0.85
    base.ipos = [0.16, 0.0, -0.005]
    base.inertia = [0.0045, 0.016, 0.015]
    base.explicitinertial = True

    base.add_geom(
        name="clamp_spanner_flange_col",
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        pos=[0.012, 0.0, 0.0],
        quat=[math.sqrt(0.5), 0.0, math.sqrt(0.5), 0.0],
        size=[0.042, 0.012, 0.0],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.6, 0.015, 0.003],
        solref=[0.004, 1.0],
        solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.65, 0.70, 0.72, 1.0],
    )
    base.add_geom(
        name="clamp_spanner_beam_col",
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
        rgba=[0.18, 0.21, 0.25, 1.0],
    )
    # Rotate site -90 deg about local Z so tool (+X, +Y, +Z) -> world (+Y, -X, +Z)
    # aligns `cell_grasp` axes directly with world (+X, +Y, +Z) for Orientation::World IK.
    base.add_site(
        name="cell_grasp",
        pos=[ws.SPANNER_CENTER_X, 0.0, -ws.SPANNER_DROP_Z + 0.010],
        quat=[math.sqrt(0.5), 0.0, 0.0, -math.sqrt(0.5)],
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Fixed rear blade (`jaw_rear`) mounted directly on `cell_gripper`
    base.add_geom(
        name="clamp_spanner_jaw_rear_stem_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.3975, 0.0, -0.029],
        size=[0.0025, 0.066, 0.020],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.6, 0.015, 0.003],
        solref=[0.004, 1.0],
        solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.72, 0.76, 0.77, 1.0],
    )
    base.add_geom(
        name="clamp_spanner_jaw_rear_pad_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.3975, 0.0, -ws.SPANNER_DROP_Z + 0.015],
        size=[0.0025, 0.068, 0.0065],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[1.50, 0.030, 0.006],
        solref=[0.006, 1.0],
        solimp=[0.94, 0.99, 0.002, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.14, 0.44, 0.48, 1.0],
    )

    # Compact dual-action door-handle pinch anvil tucked behind the flange (`x <= 0.024`),
    # 66 mm clear behind the tray front rim (`x = 0.090`) and clear of `cell_upper_jaw`
    # across the entire `clamp_opening` stroke (`[-0.015, +0.045]`).
    base.add_geom(
        name="clamp_spanner_handle_anvil_stem_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.020, 0.036, -0.0265],
        size=[0.004, 0.026, 0.018],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.6, 0.015, 0.003],
        solref=[0.004, 1.0],
        solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.72, 0.76, 0.77, 1.0],
    )
    base.add_geom(
        name="clamp_spanner_handle_anvil_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.020, 0.054, -0.054],
        size=[0.004, 0.014, 0.009],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[1.50, 0.030, 0.006],
        solref=[0.006, 1.0],
        solimp=[0.94, 0.99, 0.002, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.14, 0.44, 0.48, 1.0],
    )
    base.add_site(
        name="cell_handle_grasp",
        pos=[0.068, 0.054, -0.054],
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Sliding front clamp (`cell_upper_jaw`, joint `clamp_opening`, actuator `clamp_servo`)
    front = base.add_body(name="cell_upper_jaw", pos=[0.0, 0.0, 0.0])
    front.mass = 0.16
    front.ipos = [0.085, 0.0, -0.035]
    front.inertia = [0.0005, 0.0002, 0.0005]
    front.explicitinertial = True
    j = front.add_joint(
        name="clamp_opening",
        type=mujoco.mjtJoint.mjJNT_SLIDE,
        axis=[-1.0, 0.0, 0.0],
        range=[-0.015, ws.GRIPPER_OPEN_M],
        damping=8.0,
        armature=0.002,
        frictionloss=0.15,
    )
    j.limited = True
    front.add_geom(
        name="clamp_spanner_jaw_front_stem_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.085, 0.0, -0.029],
        size=[0.005, 0.066, 0.020],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.6, 0.015, 0.003],
        solref=[0.004, 1.0],
        solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.72, 0.76, 0.77, 1.0],
    )
    front.add_geom(
        name="clamp_spanner_jaw_front_pad_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.085, 0.0, -ws.SPANNER_DROP_Z + 0.015],
        size=[0.005, 0.068, 0.0065],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[1.50, 0.030, 0.006],
        solref=[0.006, 1.0],
        solimp=[0.94, 0.99, 0.002, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.14, 0.44, 0.48, 1.0],
    )
    # Rear-facing silicone handle pinch pad + form-closure pull hook on `cell_upper_jaw`
    front.add_geom(
        name="clamp_spanner_handle_pad_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.079, 0.054, -0.054],
        size=[0.0015, 0.014, 0.009],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[1.50, 0.030, 0.006],
        solref=[0.006, 1.0],
        solimp=[0.94, 0.99, 0.002, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.14, 0.44, 0.48, 1.0],
    )
    front.add_geom(
        name="clamp_spanner_handle_hook_col",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.078, 0.075, -0.0395],
        size=[0.005, 0.0025, 0.006],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[1.50, 0.030, 0.006],
        solref=[0.006, 1.0],
        solimp=[0.94, 0.99, 0.002, 0.5, 2.0],
        mass=0.0,
        group=3,
        rgba=[0.14, 0.44, 0.48, 1.0],
    )

    act = gs.add_actuator(name="clamp_servo", target="clamp_opening")
    act.set_to_position(kp=1650.0, kv=65.0)
    act.trntype = mujoco.mjtTrn.mjTRN_JOINT
    act.forcelimited = True
    act.forcerange = [-15.5, 15.5]
    act.ctrllimited = True
    act.ctrlrange = [-0.015, ws.GRIPPER_OPEN_M]
    return gs


def _strip_visuals_from_spec(spec: mujoco.MjSpec) -> None:
    """Drop visual-only mesh geoms, materials, textures, and unused meshes before empty-prefix attach."""
    for geom in list(spec.geoms):
        if geom.contype == 0 and geom.conaffinity == 0 and geom.type == mujoco.mjtGeom.mjGEOM_MESH:
            spec.delete(geom)
        else:
            geom.material = ""
    used_meshes = {geom.meshname for geom in spec.geoms if geom.meshname}
    for mesh in list(spec.meshes):
        if mesh.name not in used_meshes:
            spec.delete(mesh)
    for mat in list(spec.materials):
        spec.delete(mat)
    for tex in list(spec.textures):
        spec.delete(tex)


def _build_spanner_tray_spec() -> mujoco.MjSpec:
    """Build the 400x300 mm MBCO-4ME tray with geom-derived inertia so ingredient edits take effect."""
    tray_root = ET.parse(MBCO4_TRAY_XML).getroot()
    mbco4_el = tray_root.find(".//body[@name='mbco4_tray']")
    if mbco4_el is None:
        raise RuntimeError("Missing mbco4_tray body in tray_model.xml")
    for tag in ("inertial", "include", "body"):
        for child in list(mbco4_el.findall(tag)):
            mbco4_el.remove(child)
    for asset_el in list(tray_root.findall("asset")):
        tray_root.remove(asset_el)
    tray = mujoco.MjSpec.from_string(ET.tostring(tray_root, encoding="unicode"))
    tray.default.name = "tray_defaults"
    tray_body = tray.body("mbco4_tray")
    tray_body.name = "mbco_tray"
    for gname, gmass in TRAY_SHELL_MASSES.items():
        tray.geom(gname).mass = gmass
    tray_body.add_freejoint(name="mbco_tray_free")
    # Default 0.45 kg dough/pastry load (overridden by Request.ingredients in Rust)
    tray_body.add_geom(
        name="cold_contents",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, 0.019],
        size=[0.14, 0.095, 0.012],
        mass=0.45,
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.5, 0.005, 0.0001],
        rgba=[0.84, 0.57, 0.22, 1.0],
    )
    return tray


def _add_cooling_rack(
    cell: mujoco.MjSpec,
    layout: SpannerLayout,
    *,
    rack_blocked: bool,
    rack_unreachable: bool,
) -> None:
    """Add a 400x300 mm cooling rack supporting the left and right tray rails."""
    rx, ry = layout.rack_pos
    rz = layout.rack_z
    rack = cell.worldbody.add_body(
        name="cell_rack",
        pos=[8.0 if rack_unreachable else rx, ry, 0.0],
    )
    for name, x_off in (("rack_rail_left", -0.185), ("rack_rail_right", 0.185)):
        rack.add_geom(
            name=name,
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[x_off, 0.0, rz - 0.010],
            size=[0.015, 0.165, 0.010],
            rgba=[0.55, 0.62, 0.64, 1.0],
            contype=1,
            conaffinity=1,
            condim=4,
            friction=[0.55, 0.012, 0.003],
        )
    post_h = (rz - 0.020) * 0.5
    for idx, (px, py) in enumerate(
        ((-0.215, -0.175), (-0.215, 0.175), (0.215, -0.175), (0.215, 0.175)), 1
    ):
        rack.add_geom(
            name=f"rack_post_{idx}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[px, py, post_h],
            size=[0.018, 0.018, post_h],
            rgba=[0.55, 0.62, 0.64, 1.0],
            contype=1,
            conaffinity=1,
            condim=4,
        )
    rack.add_site(
        name="rack_tray_center",
        pos=[0.0, 0.0, rz + 0.0005],
        size=[0.008, 0.0, 0.0],
        group=3,
    )
    if rack_blocked:
        rack.add_geom(
            name="destination_obstruction",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[0.0, 0.0, rz + 0.045],
            size=[0.17, 0.12, 0.045],
            contype=1,
            conaffinity=1,
            condim=4,
            rgba=[0.8, 0.15, 0.1, 1.0],
        )


def compose_spanner_oven_cell(
    *,
    blocked: bool = False,
    door_closed: bool = False,
    articulated_door: bool = False,
    include_rack: bool = False,
    rack_blocked: bool = False,
    rack_unreachable: bool = False,
    robot_spec: RobotSpec = FR10_SPEC,
) -> mujoco.MjSpec:
    """Build the Plan 24 cobot + Maruzen MBCO-4ME spanner-gripper workcell (MuJoCo 4.0.0)."""
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")
    layout = SPANNER_LAYOUTS[robot_spec.slug]

    cell = mujoco.MjSpec()
    cell.modelname = (
        f"{robot_spec.title} Maruzen MBCO-4ME spanner-gripper workcell (Plan 24)"
    )
    cell.compiler.degree = False
    cell.compiler.autolimits = True
    cell.option.timestep = 0.002
    cell.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST
    cell.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
    cell.option.impratio = 10.0
    cell.option.noslip_iterations = 4
    cell.option.gravity = [0.0, 0.0, -9.81]

    cell.worldbody.add_geom(
        name="cell_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[2.5, 2.0, 0.1],
        rgba=[0.18, 0.22, 0.25, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )

    # Robot pedestal & mount rotated -90 deg about Z so neutral reach points along +Y
    bx, by, bz = layout.base_pos
    ped = cell.worldbody.add_body(
        name="cell_pedestal",
        pos=[bx, by, 0.0],
    )
    col_h = (bz - 0.050) * 0.5
    ped.add_geom(
        name="pedestal_column",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, col_h],
        size=[layout.pedestal_col_half, layout.pedestal_col_half, col_h],
        rgba=[0.55, 0.62, 0.64, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )
    ped.add_geom(
        name="pedestal_plate",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, bz - 0.025],
        size=[layout.pedestal_plate_half, layout.pedestal_plate_half, 0.025],
        rgba=[0.55, 0.62, 0.64, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )
    ped.add_site(
        name="robot_mount",
        pos=[0.0, 0.0, bz],
        quat=list(ws.ARM_BASE_QUAT),
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Prep table (stainless tabletop at Z = 0.850 m)
    tx, ty, _ = layout.table_pos
    tsx, tsy, tsz = layout.table_size
    tbl = cell.worldbody.add_body(name="cell_table", pos=[tx, ty, 0.0])
    tbl.add_geom(
        name="table_top",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, ws.PREP_TABLE_TOP_Z - tsz],
        size=[tsx, tsy, tsz],
        rgba=[0.62, 0.65, 0.68, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.55, 0.012, 0.003],
    )
    lx_off = tsx - 0.04
    ly_off = tsy - 0.04
    leg_h = (ws.PREP_TABLE_TOP_Z - 2.0 * tsz) * 0.5
    for idx, (lx, ly) in enumerate(
        ((-lx_off, -ly_off), (-lx_off, ly_off), (lx_off, -ly_off), (lx_off, ly_off)), 1
    ):
        tbl.add_geom(
            name=f"table_leg_{idx}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[lx, ly, leg_h],
            size=[0.022, 0.022, leg_h],
            rgba=[0.55, 0.62, 0.64, 1.0],
            contype=1,
            conaffinity=1,
            condim=4,
        )
    cell.worldbody.add_site(
        name="source_tray_center",
        pos=list(layout.tray_pos),
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    if include_rack:
        _add_cooling_rack(
            cell,
            layout,
            rack_blocked=rack_blocked,
            rack_unreachable=rack_unreachable,
        )

    # Left-side Maruzen MBCO-4ME convection oven (left-hinged door swings outward!)
    oven = mujoco.MjSpec.from_file(str(MBCO4_MODEL_XML))
    oven.default.name = "oven_defaults"
    _strip_visuals_from_spec(oven)
    for sensor in list(oven.sensors):
        oven.delete(sensor)
    if articulated_door:
        # Keep `mbco4_door_hinge` and `mbco4_handle_latch` live and model a physical
        # one-way rotary cam latch (`contype=2, conaffinity=2` pawl on `mbco4_handle`
        # colliding strictly with the strike catch on `mbco4_oven`).
        for jname in ("mbco4_fan_spin", "mbco4_damper_hinge"):
            try:
                oven.delete(oven.joint(jname))
            except Exception:
                pass
        for exc in list(oven.excludes):
            if exc.name == "exclude_oven_handle":
                oven.delete(exc)
        oven.joint("mbco4_door_hinge").frictionloss = 0.35
        oven.body("mbco4_handle").add_geom(
            name="mbco4_latch_pawl_col",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[0.0, 0.025, 0.055],
            size=[0.008, 0.006, 0.008],
            contype=2,
            conaffinity=2,
            condim=3,
            friction=[0.15, 0.005, 0.001],
            solref=[0.004, 1.0],
            solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
            mass=0.0,
            group=3,
            rgba=[0.85, 0.22, 0.18, 1.0],
        )
        oven.body("mbco4_oven").add_geom(
            name="mbco4_latch_catch_col",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[0.157, -0.340, 0.361],
            size=[0.015, 0.006, 0.012],
            contype=2,
            conaffinity=2,
            condim=3,
            friction=[0.15, 0.005, 0.001],
            solref=[0.004, 1.0],
            solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
            mass=0.0,
            group=3,
            rgba=[0.18, 0.32, 0.85, 1.0],
        )
    else:
        # Lock oven joints to clean static poses for the transfer workcell (matches add_oven)
        for jname in (
            "mbco4_door_hinge",
            "mbco4_handle_turn",
            "mbco4_fan_spin",
            "mbco4_damper_slide",
        ):
            try:
                oven.delete(oven.joint(jname))
            except Exception:
                pass
        door_angle = 0.0 if door_closed else 1.90
        oven.body("mbco4_door").quat = [
            math.cos(door_angle / 2.0),
            0.0,
            0.0,
            -math.sin(door_angle / 2.0),
        ]
    # Add canonical destination site `mbco_slot_3` right at Rail #2 center
    oven.body("mbco4_oven").add_site(
        name="mbco_slot_3",
        pos=[
            ws.OVEN_RAIL2_OFFSET[0],
            ws.OVEN_RAIL2_OFFSET[1],
            ws.OVEN_RAIL2_OFFSET[2] + 0.0005,
        ],
        size=[0.008, 0.0, 0.0],
        group=3,
    )
    if blocked:
        oven.body("mbco4_oven").add_geom(
            name="destination_obstruction",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[
                ws.OVEN_RAIL2_OFFSET[0],
                ws.OVEN_RAIL2_OFFSET[1],
                ws.OVEN_RAIL2_OFFSET[2] + 0.045,
            ],
            size=[0.17, 0.12, 0.035],
            contype=1,
            conaffinity=1,
            condim=4,
            rgba=[0.8, 0.15, 0.1, 1.0],
        )
    oven_frame = cell.worldbody.add_frame(pos=list(ws.OVEN_POS))
    cell.attach(oven, frame=oven_frame, prefix="")
    cell.worldbody.add_geom(
        name="oven_stand",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[ws.OVEN_POS[0], ws.OVEN_POS[1], ws.OVEN_POS[2] * 0.5],
        size=[0.37, 0.34, ws.OVEN_POS[2] * 0.5],
        rgba=[0.55, 0.62, 0.64, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )

    # Cobot arm + overhead spanner gripper
    attach_robot(cell, robot_spec)
    gripper = _build_spanner_gripper_spec()
    gripper.default.name = "gripper_defaults"
    cell.attach(gripper, site=cell.site("cell_nominal_flange"), prefix="")

    # 400x300 mm Maruzen MBCO-4ME baking tray (`mbco_tray` + `mbco_tray_free` + `cold_contents`)
    cell.attach(_build_spanner_tray_spec(), frame=cell.worldbody.add_frame(), prefix="")
    return cell
