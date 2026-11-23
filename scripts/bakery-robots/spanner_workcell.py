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

# Re-export verified constants for build_native_assets.py
SPANNER_HOME_Q = ws.FR10_HOME_Q
SPANNER_OPEN_M = ws.GRIPPER_OPEN_M
SPANNER_TRAY_WORLD = ws.PREP_TRAY_WORLD
SPANNER_TRAY_QUAT = (1.0, 0.0, 0.0, 0.0)


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


def compose_spanner_oven_cell(*, blocked: bool = False, door_closed: bool = False) -> mujoco.MjSpec:
    """Build the Plan 24 FR10 + Maruzen MBCO-4ME spanner-gripper workcell (MuJoCo 4.0.0)."""
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")

    cell = mujoco.MjSpec()
    cell.modelname = "FR10 Maruzen MBCO-4ME spanner-gripper workcell (Plan 24)"
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

    # FR10 pedestal & mount rotated -90 deg about Z so neutral reach points along +Y
    ped = cell.worldbody.add_body(
        name="cell_pedestal",
        pos=[ws.ARM_BASE_POS[0], ws.ARM_BASE_POS[1], 0.0],
    )
    ped.add_geom(
        name="pedestal_column",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, 0.375],
        size=[0.10, 0.10, 0.375],
        rgba=[0.55, 0.62, 0.64, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )
    ped.add_geom(
        name="pedestal_plate",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, 0.775],
        size=[0.16, 0.16, 0.025],
        rgba=[0.55, 0.62, 0.64, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )
    ped.add_site(
        name="robot_mount",
        pos=[0.0, 0.0, ws.ARM_BASE_POS[2]],
        quat=list(ws.ARM_BASE_QUAT),
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Prep table (stainless tabletop at Z = 0.850 m)
    tx, ty, _ = ws.PREP_TABLE_POS
    tbl = cell.worldbody.add_body(name="cell_table", pos=[tx, ty, 0.0])
    tbl.add_geom(
        name="table_top",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0.0, 0.0, ws.PREP_TABLE_TOP_Z - 0.020],
        size=[0.46, 0.34, 0.020],
        rgba=[0.62, 0.65, 0.68, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
        friction=[0.55, 0.012, 0.003],
    )
    for idx, (lx, ly) in enumerate(
        ((-0.42, -0.30), (-0.42, 0.30), (0.42, -0.30), (0.42, 0.30)), 1
    ):
        tbl.add_geom(
            name=f"table_leg_{idx}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[lx, ly, (ws.PREP_TABLE_TOP_Z - 0.040) * 0.5],
            size=[0.022, 0.022, (ws.PREP_TABLE_TOP_Z - 0.040) * 0.5],
            rgba=[0.55, 0.62, 0.64, 1.0],
            contype=1,
            conaffinity=1,
            condim=4,
        )
    cell.worldbody.add_site(
        name="source_tray_center",
        pos=list(ws.PREP_TRAY_WORLD),
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Left-side Maruzen MBCO-4ME convection oven (left-hinged door swings outward!)
    oven = mujoco.MjSpec.from_file(str(MBCO4_MODEL_XML))
    oven.default.name = "oven_defaults"
    _strip_visuals_from_spec(oven)
    for sensor in list(oven.sensors):
        oven.delete(sensor)
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

    # FAIRINO FR10 arm + overhead spanner gripper
    attach_robot(cell, FR10_SPEC)
    gripper = _build_spanner_gripper_spec()
    gripper.default.name = "gripper_defaults"
    cell.attach(gripper, site=cell.site("cell_nominal_flange"), prefix="")

    # 400x300 mm Maruzen MBCO-4ME baking tray (`mbco_tray` + `mbco_tray_free` + `cold_contents`)
    tray = mujoco.MjSpec.from_file(str(MBCO4_TRAY_XML))
    tray.default.name = "tray_defaults"
    _strip_visuals_from_spec(tray)
    tray_body = tray.body("mbco4_tray")
    tray_body.name = "mbco_tray"
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
    cell.attach(tray, frame=cell.worldbody.add_frame(), prefix="")
    return cell
