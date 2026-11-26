"""Snapshot verified asset geometry for the native build; no execution controller."""

import hashlib

import mujoco
import numpy as np
from workcell import TRAY, BakeryTask

BODY_NAMES = {"tool": "cell_gripper", "jaw": "cell_upper_jaw", "tray": "mbco_tray"}


def pose(position: np.ndarray, quaternion: np.ndarray) -> list[float]:
    return [*position.tolist(), *quaternion.tolist()]


def fixture_snapshot(request: dict, model: mujoco.MjModel, data: mujoco.MjData) -> dict:
    if request["bakeryTaskId"] == BakeryTask.RACK:
        return {"kind": "rack"}
    if request.get("spanner", False):
        oven = data.body("mbco4_oven")
        door = model.body("mbco4_door").quat
        glb_path = TRAY.parent.parent / "maruzen-mbco-4me" / "maruzen-mbco-4me.glb"
        return {
            "kind": "oven-and-rack" if request.get("combined", False) else "maruzen-oven",
            "pose": pose(oven.xpos, oven.xquat),
            "doorAngle": 2 * float(np.arctan2(-door[3], door[0])),
            "glbSha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        }
    oven = data.body("mbco_oven")
    door = model.body("mbco_door").quat
    return {
        "kind": "oven-and-rack" if request.get("combined", False) else "maruzen-oven",
        "pose": pose(oven.xpos, oven.xquat),
        "doorAngle": 2 * float(np.arctan2(-door[3], door[0])),
        "glbSha256": hashlib.sha256(
            (TRAY.parent / "maruzen-mbco-5e.glb").read_bytes()
        ).hexdigest(),
    }


def geometry_snapshot(model: mujoco.MjModel, data: mujoco.MjData) -> list[dict]:
    bodies = {model.body(name).id: key for key, name in BODY_NAMES.items()}
    geometry = []
    for index in range(model.ngeom):
        item = model.geom(index)
        if "__" in item.name or item.name == "cell_floor":
            continue
        if item.contype[0] == 0 and item.conaffinity[0] == 0:
            continue
        shape = {
            int(mujoco.mjtGeom.mjGEOM_BOX): "box",
            int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
            int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
        }.get(int(item.type[0]))
        if shape is None:
            raise ValueError(f"Unsupported replay geometry: {item.name}")
        body = bodies.get(int(item.bodyid[0]), "world")
        if body == "world":
            quaternion = np.zeros(4)
            mujoco.mju_mat2Quat(quaternion, data.geom_xmat[index])
            transform = pose(data.geom_xpos[index], quaternion)
        else:
            transform = pose(item.pos, item.quat)
        geometry.append(
            {
                "name": item.name,
                "body": body,
                "shape": shape,
                "size": item.size.tolist(),
                "pose": transform,
                "rgba": item.rgba.tolist(),
            }
        )
    return geometry
