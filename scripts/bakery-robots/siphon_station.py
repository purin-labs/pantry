"""Compose the FR10 Hario TCA-3 siphon coffee station."""

from pathlib import Path

import mujoco
import numpy as np
from native_asset_snapshot import pose
from workcell import (
    DEFAULT_ROBOT,
    arm_addresses,
    arm_joint_names,
    attach_robot,
    orientation_error,
)

SIPHON_STATION = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/siphon-station"
POUR_OVER_STATION = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/pour-over-station"

READY_FROM_HANDLE = np.array((-0.22, 0.0, 0.10))
READY_SEED = (0, -1.5, -1.5, -1.5, -1.57, 0)
FINGER_OPEN = 0.016

DISPLAY_BODIES = (
    "si_lower_bowl",
    "si_upper_bowl",
    "si_paddle",
    "po_gripper",
    "po_finger_left",
    "po_finger_right",
)


def compose_siphon() -> mujoco.MjSpec:
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")
    cell = mujoco.MjSpec.from_file(str(SIPHON_STATION / "station.xml"))
    attach_robot(cell, DEFAULT_ROBOT)
    gripper = mujoco.MjSpec.from_file(str(POUR_OVER_STATION / "gripper.xml"))
    gripper.default.name = "si_gripper_defaults"
    cell.attach(gripper, site=cell.site("cell_nominal_flange"), prefix="")
    return cell


def solve_tool(model: mujoco.MjModel, target: np.ndarray, seed: tuple[float, ...]) -> np.ndarray:
    """Bounded static IK for the tool site with world-aligned axes."""
    data = mujoco.MjData(model)
    positions, velocities = arm_addresses(model)
    limits = np.array([model.joint(name).range for name in arm_joint_names(model)])
    site = model.site("po_tool_grasp").id
    jacobian_position = np.zeros((3, model.nv))
    jacobian_rotation = np.zeros((3, model.nv))
    data.qpos[positions] = seed
    for _ in range(500):
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        position_error = target - data.site_xpos[site]
        rotation_error = orientation_error(data.site_xmat[site])
        error = np.concatenate((position_error, rotation_error))
        if np.linalg.norm(error) < 1e-9:
            return data.qpos[positions].copy()
        mujoco.mj_jacSite(model, data, jacobian_position, jacobian_rotation, site)
        jacobian = np.vstack(
            (jacobian_position[:, velocities], jacobian_rotation[:, velocities])
        )
        update = jacobian.T @ np.linalg.solve(jacobian @ jacobian.T + np.eye(6) * 1e-6, error)
        update *= min(1, 0.05 / max(np.linalg.norm(update), 1e-12))
        data.qpos[positions] = np.clip(
            data.qpos[positions] + update, limits[:, 0] + 1e-4, limits[:, 1] - 1e-4
        )
    raise ValueError(f"No ready pose reaches {target.tolist()}")


def initialize_siphon_ready(model: mujoco.MjModel, data: mujoco.MjData) -> np.ndarray:
    mujoco.mj_resetData(model, data)
    mujoco.mj_forward(model, data)
    target = data.site("si_paddle_grasp").xpos + READY_FROM_HANDLE
    angles = solve_tool(model, target, READY_SEED)
    positions, _ = arm_addresses(model)
    data.qpos[positions] = angles
    for side in ("left", "right"):
        data.joint(f"po_finger_{side}_slide").qpos[0] = FINGER_OPEN
    # Upper bowl starts unseated (+14 mm above sealed position) while lower bulb heats.
    data.joint("si_upper_seal").qpos[0] = 0.014
    mujoco.mj_forward(model, data)
    contacts = [
        (model.geom(c.geom1).name, model.geom(c.geom2).name)
        for c in data.contact[: data.ncon]
        if c.dist < 0
    ]
    if contacts:
        raise ValueError(f"The siphon ready pose touches the station: {contacts}")
    return angles


def siphon_station_geometry(model: mujoco.MjModel, data: mujoco.MjData) -> list[dict]:
    shapes = {
        int(mujoco.mjtGeom.mjGEOM_BOX): "box",
        int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
        int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
    }
    geometry = []
    for index in range(model.ngeom):
        item = model.geom(index)
        if "__" in item.name or item.name == "cell_floor":
            continue
        shape = shapes.get(int(item.type[0]))
        if shape is None:
            raise ValueError(f"Unsupported display geometry: {item.name}")
        body = model.body(int(item.bodyid[0])).name
        if body in DISPLAY_BODIES:
            transform = pose(item.pos, item.quat)
        else:
            quaternion = np.zeros(4)
            mujoco.mju_mat2Quat(quaternion, data.geom_xmat[index])
            transform = pose(data.geom_xpos[index], quaternion)
            body = "world"
        geometry.append(
            {
                "name": item.name,
                "body": body,
                "shape": shape,
                "size": item.size.tolist(),
                "pose": transform,
                "rgba": item.rgba.tolist(),
                "collides": bool(item.contype[0] or item.conaffinity[0]),
            }
        )
    return geometry


def siphon_station_frames(model: mujoco.MjModel, data: mujoco.MjData) -> dict:
    fingers = {}
    for side in ("left", "right"):
        body = model.body(f"po_finger_{side}")
        joint = model.joint(f"po_finger_{side}_slide")
        fingers[side] = {
            "pose": pose(body.pos, body.quat),
            "axis": joint.axis.tolist(),
        }
    return {
        "fingers": fingers,
        "upperCentre": data.site("si_upper_centre").xpos.tolist(),
        "upperRadius": 0.0435,
        "lowerRadius": 0.050,
    }
