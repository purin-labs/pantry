"""Multi-body loose baking tins / moulds on the 400x300 mm MBCO-4ME spanner tray (Plan 42B M3).

Replaces the fixed rigid `cold_contents` mass box in `spanner_workcell.py` with
8 independent free-joint tins (125 g each = 1.000 kg total payload) resting on the
smooth stainless tray deck so MuJoCo simulates real sliding, rim collisions, and
tipping under arm acceleration and tilt:

- `financier`: 4x2 grid of 76x48x22 mm financier tins (aspect h/w = 0.46, slide-governed).
- `tall_mould`: 4x2 grid of 36 mm dia x 48 mm tall canele/muffin moulds placed clear of
  the central 50 mm overhead spanner beam (aspect h/d = 1.33, slide + tip-governed).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import mujoco
from prepare import ROBOTS, RobotSpec
from spanner_workcell import (
    FR10_SPEC,
    SPANNER_LAYOUTS,
    _add_mbco4_oven,
    _add_pedestal,
    _build_spanner_gripper_spec,
    _build_spanner_tray_spec,
)
from workcell import attach_robot

import workcell_scene as ws

TinRegime = Literal["financier", "tall_mould"]

# Deck top surface sits at local Z = 0.0030 m inside `mbco4_tray` (`pos=0.0015, half_z=0.0015`)
TRAY_DECK_TOP_Z = 0.0030


@dataclass(frozen=True)
class TinPlacement:
    name: str
    local_xyz: tuple[float, float, float]
    half_height_m: float
    mass_kg: float


def tin_layout(regime: TinRegime) -> list[TinPlacement]:
    """Return the 8 nominal tin centers in `mbco_tray` local coordinates (total 1.000 kg)."""
    if regime == "financier":
        xs = (-0.135, -0.045, 0.045, 0.135)
        ys = (-0.065, 0.065)
        half_h = 0.011
    elif regime == "tall_mould":
        # Inner columns at x = +/-0.065 m keep 47 mm > 25 mm clearance from overhead beam
        xs = (-0.145, -0.065, 0.065, 0.145)
        ys = (-0.070, 0.070)
        half_h = 0.024
    else:
        raise ValueError(f"Unknown tin regime: {regime}")

    placements: list[TinPlacement] = []
    for r, y in enumerate(ys):
        for c, x in enumerate(xs):
            placements.append(
                TinPlacement(
                    name=f"tin_r{r}_c{c}",
                    local_xyz=(x, y, TRAY_DECK_TOP_Z + half_h + 0.0002),
                    half_height_m=half_h,
                    mass_kg=0.125,
                )
            )
    return placements


def compose_loose_tin_spanner_cell(
    *,
    robot_spec: RobotSpec = FR10_SPEC,
    regime: TinRegime = "financier",
    tin_friction: float = 0.25,
) -> tuple[mujoco.MjSpec, list[TinPlacement]]:
    """Build a spanner-oven cell whose tray carries 8 independent free-joint tins."""
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")
    layout = SPANNER_LAYOUTS[robot_spec.slug]

    cell = mujoco.MjSpec()
    cell.modelname = f"{robot_spec.title} Spanner-Oven Loose-Tin Cell ({regime})"
    cell.compiler.degree = False
    cell.compiler.autolimits = True
    cell.option.timestep = 0.002
    cell.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST
    cell.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
    cell.option.impratio = 10.0
    cell.option.noslip_iterations = 4
    cell.option.gravity = [0.0, 0.0, -9.81]
    cell.visual.global_.offwidth = 640
    cell.visual.global_.offheight = 480
    cell.visual.headlight.active = 1
    cell.visual.headlight.ambient = [0.46, 0.46, 0.50]
    cell.visual.headlight.diffuse = [0.68, 0.68, 0.68]

    cell.worldbody.add_light(
        pos=[0.1, -1.2, 2.8], dir=[0.0, 0.25, -0.97], diffuse=[0.85, 0.85, 0.85]
    )
    cell.worldbody.add_camera(
        name="tin_closeup",
        pos=[0.44, -0.78, 1.38],
        xyaxes=[1.0, 0.0, 0.0, 0.0, 0.62, 0.78],
        fovy=46.0,
    )
    cell.worldbody.add_camera(
        name="cell_hero",
        pos=[1.42, -2.42, 1.84],
        xyaxes=[0.84, 0.54, 0.0, -0.18, 0.28, 0.94],
        fovy=48.0,
    )

    cell.worldbody.add_geom(
        name="cell_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[2.5, 2.0, 0.1],
        rgba=[0.18, 0.22, 0.25, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )

    _add_pedestal(
        cell,
        base_pos=layout.base_pos,
        col_half=layout.pedestal_col_half,
        plate_half=layout.pedestal_plate_half,
    )

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
        priority=1,
        solref=[0.004, 1.0],
        solimp=[0.99, 0.999, 0.001, 0.5, 2.0],
    )
    leg_h = (ws.PREP_TABLE_TOP_Z - 2.0 * tsz) * 0.5
    for idx, (lx, ly) in enumerate(
        (
            (-(tsx - 0.04), -(tsy - 0.04)),
            (-(tsx - 0.04), tsy - 0.04),
            (tsx - 0.04, -(tsy - 0.04)),
            (tsx - 0.04, tsy - 0.04),
        ),
        1,
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

    _add_mbco4_oven(cell, door_closed=False, articulated_door=False, blocked=False)
    attach_robot(cell, robot_spec)
    gripper = _build_spanner_gripper_spec()
    gripper.default.name = "gripper_defaults"
    cell.attach(gripper, site=cell.site("cell_nominal_flange"), prefix="")

    # Empty 0.85 kg tray shell (no rigid `cold_contents` box!)
    tray = _build_spanner_tray_spec(include_contents=False)
    # Match tin-on-steel sliding friction on tray deck while keeping high rim pinch friction
    tray.geom("mbco4_tray_deck_col").friction = [tin_friction, 0.005, 0.0005]
    tray.geom("mbco4_tray_deck_col").priority = 1
    cell.attach(tray, frame=cell.worldbody.add_frame(), prefix="")

    # Add 8 independent free-joint pastry tins on the tray deck
    placements = tin_layout(regime)
    base_x, base_y, base_z = layout.tray_pos
    for idx, tin in enumerate(placements):
        body = cell.worldbody.add_body(
            name=tin.name,
            pos=[
                base_x + tin.local_xyz[0],
                base_y + tin.local_xyz[1],
                base_z + tin.local_xyz[2],
            ],
        )
        body.add_freejoint(name=f"{tin.name}_free")
        rgba = (
            [0.82, 0.50, 0.16, 1.0]
            if regime == "financier"
            else [0.58, 0.28, 0.14, 1.0]
        )
        if idx % 2 == 1:
            rgba = [rgba[0] * 0.92, rgba[1] * 0.92, rgba[2] * 0.92, 1.0]
        if regime == "financier":
            body.add_geom(
                name=f"{tin.name}_col",
                type=mujoco.mjtGeom.mjGEOM_BOX,
                size=[0.038, 0.024, tin.half_height_m],
                mass=tin.mass_kg,
                contype=1,
                conaffinity=1,
                condim=4,
                friction=[tin_friction, 0.005, 0.0005],
                solref=[0.004, 1.0],
                solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
                group=3,
                rgba=rgba,
            )
        else:
            body.add_geom(
                name=f"{tin.name}_col",
                type=mujoco.mjtGeom.mjGEOM_CYLINDER,
                size=[0.018, tin.half_height_m, 0.0],
                mass=tin.mass_kg,
                contype=1,
                conaffinity=1,
                condim=4,
                friction=[tin_friction, 0.005, 0.0005],
                solref=[0.004, 1.0],
                solimp=[0.95, 0.99, 0.001, 0.5, 2.0],
                group=3,
                rgba=rgba,
            )

    for geom in cell.geoms:
        if geom.group == 3 and geom.rgba[3] > 0.1:
            geom.rgba[3] = 1.0
    return cell, placements


def robot_spec_by_slug(slug: str) -> RobotSpec:
    return next(robot for robot in ROBOTS if robot.slug == slug)
