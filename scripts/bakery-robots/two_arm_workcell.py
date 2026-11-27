"""Coupled two-arm FAIRINO FR10 + Maruzen MBCO-4ME bake cell (Plan 24).

Places two 6-DOF FR10 arms (`cobot1_`, `cobot2_`), two overhead tray-rim spanner
grippers, one shared Maruzen MBCO-4ME convection oven, one cold prep table, one
cooling rack, and two independent 400x300 mm baking trays (`tray_fresh_`,
`tray_baked_`) in ONE shared MuJoCo 4.0.0 scene with full inter-arm, arm-to-door,
and tray-to-tray collision detection.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import mujoco
import numpy as np
from spanner_workcell import (
    FR10_SPEC,
    SPANNER_OPEN_M,
    SpannerLayout,
    _add_cooling_rack,
    _add_mbco4_oven,
    _add_pedestal,
    _build_spanner_gripper_spec,
    _build_spanner_tray_spec,
)
from workcell import attach_robot

import workcell_scene as ws

# Calibrated dual-FR10 cell coordinates around canonical MBCO-4ME at (-0.40, 0.14, 0.85):
# - Left-hinged open door (1.90 rad) occupies x in [-1.06, -0.78], y in [-0.92, -0.22].
# - cobot-1 (Loader) mounts right-front (0.14, -1.08, 0.80) serving Cold Table (0.74, -0.20).
# - cobot-2 (Unloader) mounts front-left (-0.66, -1.42, 0.80) serving Cooling Rack (-1.24, -1.26),
#   500 mm behind the open door tip while reaching Rail #2 (-0.49, 0.00, 1.1155) cleanly.
COBOT1_BASE_POS = (0.14, -1.08, 0.80)
COBOT2_BASE_POS = (-0.66, -1.52, 0.80)
COLD_TABLE_POS = (0.74, -0.20, 0.0)
COLD_TABLE_SIZE = (0.38, 0.30, 0.020)
FRESH_TRAY_POS = (0.64, -0.20, ws.PREP_TABLE_TOP_Z + 0.0005)
COOLING_RACK_POS = (-1.38, -1.16)
COOLING_RACK_Z = 0.850
BAKED_TRAY_RAIL2_POS = (
    ws.OVEN_POS[0] + ws.OVEN_RAIL2_OFFSET[0],
    ws.OVEN_POS[1] + ws.OVEN_RAIL2_OFFSET[1],
    ws.OVEN_POS[2] + ws.OVEN_RAIL2_OFFSET[2] + 0.0005,
)

# Closed jaw stroke matches crates/bakery-native/src/native/transfer.rs
SPANNER_CLOSED_M = -0.015
SPANNER_GRASP_OFFSET = np.array([0.0, -0.005, 0.011], dtype=np.float64)


def compose_two_arm_oven_cell(*, door_angle_rad: float = 1.90) -> mujoco.MjSpec:
    """Build the coupled two-FR10 + shared MBCO-4ME MuJoCo 4.0.0 workcell."""
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")

    cell = mujoco.MjSpec()
    cell.modelname = "Plan 24 Coupled Two-Arm FR10 Maruzen MBCO-4ME Bake Cell"
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
        pos=[0.0, -1.4, 3.2], dir=[0.0, 0.25, -0.97], diffuse=[0.85, 0.85, 0.85]
    )
    cell.worldbody.add_camera(
        name="two_arm_hero",
        pos=[0.95, -3.55, 2.45],
        xyaxes=[0.94, 0.34, 0.0, -0.17, 0.47, 0.87],
        fovy=48.0,
    )
    cell.worldbody.add_camera(
        name="two_arm_top",
        pos=[-0.28, -0.82, 3.35],
        xyaxes=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        fovy=52.0,
    )

    cell.worldbody.add_geom(
        name="cell_floor",
        type=mujoco.mjtGeom.mjGEOM_PLANE,
        size=[3.5, 3.0, 0.1],
        rgba=[0.18, 0.22, 0.25, 1.0],
        contype=1,
        conaffinity=1,
        condim=4,
    )

    # Pedestals for cobot-1 (Loader) and cobot-2 (Unloader)
    _add_pedestal(
        cell,
        name="cobot1_pedestal",
        base_pos=COBOT1_BASE_POS,
        col_half=0.10,
        plate_half=0.16,
        mount_site="cobot1_mount",
        geom_prefix="cobot1_",
    )
    # Mount cobot-2 rotated -45 deg about Z (45 deg CCW from cobot-1) so its neutral
    # workspace bisects MBCO-4ME Rail #2 and the left-front cooling rack cleanly.
    c2_yaw = -math.pi / 4.0
    _add_pedestal(
        cell,
        name="cobot2_pedestal",
        base_pos=COBOT2_BASE_POS,
        col_half=0.10,
        plate_half=0.16,
        mount_site="cobot2_mount",
        geom_prefix="cobot2_",
        mount_quat=(math.cos(c2_yaw / 2.0), 0.0, 0.0, math.sin(c2_yaw / 2.0)),
    )

    # Cold Prep Table on right for cobot-1 (`tray_fresh_`)
    tx, ty, _ = COLD_TABLE_POS
    tsx, tsy, tsz = COLD_TABLE_SIZE
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
    cell.worldbody.add_site(
        name="source_tray_center",
        pos=list(FRESH_TRAY_POS),
        size=[0.008, 0.0, 0.0],
        group=3,
    )

    # Cooling Rack on front-left for cobot-2 (`tray_baked_`)
    rack_layout = SpannerLayout(
        base_pos=COBOT2_BASE_POS,
        pedestal_col_half=0.10,
        pedestal_plate_half=0.16,
        table_pos=COLD_TABLE_POS,
        table_size=COLD_TABLE_SIZE,
        tray_pos=FRESH_TRAY_POS,
        rack_pos=COOLING_RACK_POS,
        rack_z=COOLING_RACK_Z,
        home_q=(),
    )
    _add_cooling_rack(
        cell, rack_layout, rack_blocked=False, rack_unreachable=False
    )

    # Shared Maruzen MBCO-4ME convection oven
    _add_mbco4_oven(
        cell, door_closed=False, articulated_door=False, blocked=False, door_angle_rad=door_angle_rad
    )

    # Attach two full FR10 arms + two overhead spanner grippers
    for prefix, mount_site, tint in (
        ("cobot1_", "cobot1_mount", (0.28, 0.54, 0.86, 1.0)),
        ("cobot2_", "cobot2_mount", (0.20, 0.68, 0.56, 1.0)),
    ):
        attach_robot(cell, FR10_SPEC, mount_site=mount_site, prefix=prefix)
        gripper = _build_spanner_gripper_spec()
        gripper.default.name = f"{prefix}gripper_defaults"
        cell.attach(
            gripper,
            site=cell.site(f"{prefix}cell_nominal_flange"),
            prefix=prefix,
        )
        # Distinct tint on arm collision geoms for clear visual differentiation
        for geom in cell.geoms:
            if geom.name.startswith(f"{prefix}fairino-fr10__") and geom.group == 3:
                geom.rgba = list(tint)

    # Two independent 400x300 mm trays:
    # - `tray_fresh_` (1.0 kg unbaked financier batter, bright golden) on Cold Table
    # - `tray_baked_` (1.0 kg baked financier batch, deep amber-brown) on MBCO-4ME Rail #2
    tray_fresh = _build_spanner_tray_spec(
        include_contents=True,
        contents_mass_kg=1.0,
        contents_rgba=(0.92, 0.72, 0.30, 1.0),
        default_name="tray_fresh_defaults",
    )
    cell.attach(tray_fresh, frame=cell.worldbody.add_frame(), prefix="tray_fresh_")

    tray_baked = _build_spanner_tray_spec(
        include_contents=True,
        contents_mass_kg=1.0,
        contents_rgba=(0.64, 0.34, 0.14, 1.0),
        default_name="tray_baked_defaults",
    )
    cell.attach(tray_baked, frame=cell.worldbody.add_frame(), prefix="tray_baked_")

    # Make group-3 collision geoms opaque for crisp visual inspection sheets
    for geom in cell.geoms:
        if geom.group == 3 and geom.rgba[3] > 0.1:
            geom.rgba[3] = 1.0
    return cell


@dataclass
class PhaseLeg:
    label: str
    target_xyz: np.ndarray
    duration_s: float
    closed: bool
    carrying: bool
    wait_for_mouth: bool = False


class CoupledArmRig:
    """6-DOF FR10 arm + spanner gripper bound to one prefix inside the coupled model."""

    def __init__(self, model: mujoco.MjModel, prefix: str) -> None:
        self.model = model
        self.prefix = prefix
        self.ik_data = mujoco.MjData(model)
        self.dyn_data = mujoco.MjData(model)
        self.joint_ids = [
            model.joint(f"{prefix}fairino-fr10__j{i}").id for i in range(1, 7)
        ]
        self.qadrs = np.array([model.jnt_qposadr[j] for j in self.joint_ids], dtype=int)
        self.dadrs = np.array([model.jnt_dofadr[j] for j in self.joint_ids], dtype=int)
        self.act_ids = np.array(
            [model.actuator(f"{prefix}fairino-fr10__j{i}__servo").id for i in range(1, 7)],
            dtype=int,
        )
        self.j_limits = np.array([model.jnt_range[j] for j in self.joint_ids], dtype=np.float64)
        self.kp = np.array([model.actuator_gainprm[a, 0] for a in self.act_ids], dtype=np.float64)
        self.ctrl_range = np.array([model.actuator_ctrlrange[a] for a in self.act_ids], dtype=np.float64)
        self.jaw_jnt = model.joint(f"{prefix}clamp_opening").id
        self.jaw_qadr = int(model.jnt_qposadr[self.jaw_jnt])
        self.jaw_act = model.actuator(f"{prefix}clamp_servo").id
        self.grasp_site = model.site(f"{prefix}cell_grasp").id
        self.tool_body = model.body(f"{prefix}cell_gripper").id
        # Geoms belonging to this arm + its gripper
        self.geom_ids = [
            g
            for g in range(model.ngeom)
            if model.geom(g).name.startswith(prefix)
            and model.geom_contype[g] != 0
        ]

    def fk(self, q: np.ndarray) -> np.ndarray:
        for i, a in enumerate(self.qadrs):
            self.ik_data.qpos[a] = q[i]
        mujoco.mj_kinematics(self.model, self.ik_data)
        return self.ik_data.site_xpos[self.grasp_site].copy()

    def solve_ik(
        self,
        target: np.ndarray,
        seed: np.ndarray,
        *,
        iters: int = 300,
        tol: float = 1e-5,
    ) -> np.ndarray:
        q = np.asarray(seed, dtype=np.float64).copy()
        jp = np.zeros((3, self.model.nv), dtype=np.float64)
        jr = np.zeros((3, self.model.nv), dtype=np.float64)
        quat = np.zeros(4, dtype=np.float64)
        er = np.zeros(3, dtype=np.float64)
        for _ in range(iters):
            for i, a in enumerate(self.qadrs):
                self.ik_data.qpos[a] = q[i]
            mujoco.mj_kinematics(self.model, self.ik_data)
            mujoco.mj_comPos(self.model, self.ik_data)
            ep = target - self.ik_data.site_xpos[self.grasp_site]
            rot = self.ik_data.site_xmat[self.grasp_site].reshape(3, 3)
            # Match workcell.py orientation_error: world Identity target
            mujoco.mju_mat2Quat(quat, rot.T.flatten())
            if quat[0] < 0.0:
                quat *= -1.0
            mujoco.mju_quat2Vel(er, quat, 1.0)
            err = np.concatenate([ep, er])
            if np.linalg.norm(err) < tol:
                return q
            mujoco.mj_jacSite(self.model, self.ik_data, jp, jr, self.grasp_site)
            J = np.vstack([jp[:, self.dadrs], jr[:, self.dadrs]])
            dq = np.linalg.solve(J.T @ J + 1e-4 * np.eye(6), J.T @ err)
            q = np.clip(q + np.clip(dq, -0.15, 0.15), self.j_limits[:, 0], self.j_limits[:, 1])
        raise RuntimeError(
            f"{self.prefix} IK failed for target {target.tolist()} (err={np.linalg.norm(err):.4f})"
        )

    def servo_ctrl(
        self,
        q_meas: np.ndarray,
        q_cmd: np.ndarray,
        carrying: bool,
        *,
        payload_mass_kg: float = 1.85,
    ) -> np.ndarray:
        """Gravity + nominal carried-tray feedforward matching `crates/bakery-native/src/servo.rs`."""
        mujoco.mj_resetData(self.model, self.dyn_data)
        for i, a in enumerate(self.qadrs):
            self.dyn_data.qpos[a] = q_meas[i]
        self.dyn_data.qpos[self.jaw_qadr] = SPANNER_CLOSED_M if carrying else SPANNER_OPEN_M
        mujoco.mj_forward(self.model, self.dyn_data)
        tau = self.dyn_data.qfrc_bias[self.dadrs].copy()
        if carrying:
            site = self.dyn_data.site_xpos[self.grasp_site]
            rot = self.dyn_data.site_xmat[self.grasp_site].reshape(3, 3)
            com_world = site + rot @ np.array([0.0, 0.005, 0.003], dtype=np.float64)
            jp = np.zeros((3, self.model.nv), dtype=np.float64)
            mujoco.mj_jac(self.model, self.dyn_data, jp, None, com_world, self.tool_body)
            # Counteract gravity force [0, 0, -m*g] on payload -> +m*g*J_z^T
            tau += jp[2, self.dadrs] * (payload_mass_kg * 9.81)
        ctrl = q_cmd + tau / self.kp
        return np.clip(ctrl, self.j_limits[:, 0], self.j_limits[:, 1])


class LegRunner:
    """Step-wise quintic Cartesian leg executor for one arm in a coupled loop."""

    def __init__(self, rig: CoupledArmRig, q_start: np.ndarray, legs: Sequence[PhaseLeg], dt: float) -> None:
        self.rig = rig
        self.dt = dt
        self.legs = list(legs)
        self.leg_idx = 0
        self.step_in_leg = 0
        self.q_cmd = q_start.copy()
        self.p_start = rig.fk(q_start)
        self.jaw_start = SPANNER_OPEN_M
        self.jaw_cmd = SPANNER_OPEN_M
        self.carrying = False
        self.done = False
        self.waiting_steps = 0

    @property
    def current_label(self) -> str:
        return "done" if self.done else self.legs[self.leg_idx].label

    def step(self, *, mouth_free: bool) -> tuple[np.ndarray, float, bool]:
        if self.done:
            return self.q_cmd, self.jaw_cmd, False
        leg = self.legs[self.leg_idx]
        if leg.wait_for_mouth and not mouth_free and self.step_in_leg == 0:
            self.waiting_steps += 1
            return self.q_cmd, self.jaw_cmd, self.carrying

        total_steps = max(1, int(round(leg.duration_s / self.dt)))
        frac = min(1.0, (self.step_in_leg + 1) / total_steps)
        blend = (frac**3) * (10.0 - 15.0 * frac + 6.0 * (frac**2))
        target_p = self.p_start + blend * (leg.target_xyz - self.p_start)
        target_jaw = SPANNER_CLOSED_M if leg.closed else SPANNER_OPEN_M
        self.jaw_cmd = self.jaw_start + blend * (target_jaw - self.jaw_start)
        self.q_cmd = self.rig.solve_ik(target_p, self.q_cmd)
        self.carrying = leg.carrying

        self.step_in_leg += 1
        if self.step_in_leg >= total_steps:
            self.p_start = leg.target_xyz.copy()
            self.jaw_start = target_jaw
            self.leg_idx += 1
            self.step_in_leg = 0
            if self.leg_idx >= len(self.legs):
                self.done = True
        return self.q_cmd, self.jaw_cmd, self.carrying
