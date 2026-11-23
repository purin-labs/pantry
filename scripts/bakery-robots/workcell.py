"""Inspect fixed FR10 workcell readiness; no transfer trajectory or hardware control."""

import argparse
import json
import time
from enum import StrEnum
from pathlib import Path

import mujoco
import numpy as np
from prepare import ASSETS, ROBOTS, SERVO_KP, SERVO_KV, RobotSpec

CELL = ASSETS.parent / "bakery-mujoco" / "fr10-workcell"
TRAY = ASSETS.parent / "bakery-mujoco" / "maruzen-mbco-5e" / "tray.xml"
DEFAULT_ROBOT = next(robot for robot in ROBOTS if robot.slug == "fairino-fr10")
ARM_JOINTS = tuple(f"fairino-fr10__j{index}" for index in range(1, 7))
TRAY_QUATERNION = (2**-0.5, 0, 0, -(2**-0.5))
GRASP_FROM_TRAY = np.array((-0.25, 0, -0.001))
INSPECTION_POSES = ("source", "lift", "rack")


class BakeryTask(StrEnum):
    RACK = "table-to-rack"
    OVEN = "table-to-oven"
    UNLOAD = "oven-to-table"


def destination_site(task: BakeryTask) -> str:
    match task:
        case BakeryTask.RACK:
            return "rack_tray_center"
        case BakeryTask.OVEN:
            return "mbco_slot_3"
        case BakeryTask.UNLOAD:
            return "source_tray_center"
    raise ValueError(f"Unknown task: {task}")


def add_oven(
    cell: mujoco.MjSpec, closed: bool, combined: bool, robot_spec: RobotSpec
) -> None:
    x, y = (1.50, 0.40) if combined else (1.35, 0.20)
    if combined and robot_spec.slug == "universal-robots-ur5e":
        x, y = 1.35, 0.35
    oven = mujoco.MjSpec.from_file(str(TRAY.parent / "oven.xml"))
    oven.default.name = "oven_defaults"
    for sensor in list(oven.sensors):
        oven.delete(sensor)
    oven.delete(oven.joint("mbco_door_hinge"))
    oven.delete(oven.joint("mbco_handle_turn"))
    angle = 0 if closed else np.deg2rad(100)
    oven.body("mbco_door").quat = [np.cos(angle / 2), 0, 0, -np.sin(angle / 2)]
    frame = cell.worldbody.add_frame(
        pos=[x, y, 0.444], quat=[2**-0.5, 0, 0, -(2**-0.5)]
    )
    cell.attach(oven, frame=frame, prefix="")
    cell.worldbody.add_geom(
        name="oven_stand",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[x, y, 0.222],
        size=[0.40, 0.45, 0.222],
        rgba=[0.55, 0.62, 0.64, 1],
    )


def attach_robot(cell: mujoco.MjSpec, robot_spec: RobotSpec) -> None:
    """Mount the arm with bounded joint servos and a nominal flange site."""
    metadata = json.loads((ASSETS / robot_spec.slug / "joints.json").read_text())
    robot = mujoco.MjSpec.from_file(str(ASSETS / robot_spec.slug / "robot.xml"))
    robot.default.name = "robot_defaults"
    if robot_spec.slug == "fanuc-crx10ial":
        flange = robot.body("fanuc-crx10ial__fanuc_flange")
        offset = [0, 0, 0]
    elif robot_spec.slug == "universal-robots-ur5e":
        flange = robot.body("universal-robots-ur5e__tool0")
        offset = [0, 0, 0]
    elif robot_spec.slug == "dobot-cr10":
        flange = robot.body("dobot-cr10__flange")
        offset = [0, 0, 0]
    else:
        flange = robot.body(metadata["joint_order"][-1]["body"])
        offset = [
            0,
            0,
            {"fairino-fr10": 0.106, "fairino-fr5": 0.1, "ufactory-xarm6": 0.0}[
                robot_spec.slug
            ],
        ]
    flange.add_site(name="cell_nominal_flange", pos=offset, size=[0.008, 0, 0], group=3)
    for index, source in enumerate(metadata["joint_order"]):
        name = source["node"]
        joint = robot.joint(name)
        joint.damping[0] = 1
        joint.armature = 0.02
        servo = robot.add_actuator(name=f"{name}__servo", target=name)
        servo.set_to_position(kp=SERVO_KP[index], kv=SERVO_KV[index])
        servo.trntype = mujoco.mjtTrn.mjTRN_JOINT
        servo.forcelimited = True
        effort = source["source_effort_nm"]
        if robot_spec.slug == "fairino-fr10":
            effort = min(effort, 150 if index < 3 else 28)
        servo.forcerange = [-effort, effort]
    cell.attach(robot, site=cell.site("robot_mount"), prefix="")


def compose_cell(
    blocked: bool = False,
    task: BakeryTask = BakeryTask.RACK,
    door_closed: bool = False,
    combined: bool = False,
    robot_spec: RobotSpec = DEFAULT_ROBOT,
) -> mujoco.MjSpec:
    if task == BakeryTask.UNLOAD:
        raise ValueError("Unloading continues the existing oven cell.")
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Use the pinned MuJoCo 4.0.0 environment.")
    cell = mujoco.MjSpec.from_file(str(CELL / "fixtures.xml"))
    # Smooth friction cones avoid direction changes while offset trays settle.
    cell.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
    if combined:
        if robot_spec.slug == "universal-robots-ur5e":
            # Preserve the accepted standalone source/oven positions relative to the arm.
            cell.body("cell_pedestal").pos[1] = 0.15
        cell.body("cell_rack").pos = [1.05, -0.90, 0]
        cell.body("cell_table").pos[1] = -0.35
        cell.site("source_tray_center").pos[1] = -0.35
        cell.site("lift_tray_center").pos[1] = -0.35
        for name in ("rack_upper_left", "rack_upper_right", "rack_back_stop"):
            cell.delete(cell.geom(name))
        for index in range(1, 5):
            post = cell.geom(f"rack_post_{index}")
            post.pos[2] = 0.39
            post.size[2] = 0.39
        if robot_spec.slug == "universal-robots-ur5e":
            # A lower nearby shelf permits placement and the full 200 mm fork withdrawal.
            cell.body("cell_rack").pos = [0.50, -0.45, 0]
            for name in ("rack_rail_left", "rack_rail_right"):
                cell.geom(name).pos[2] = 0.59
            for index in range(1, 5):
                post = cell.geom(f"rack_post_{index}")
                post.pos[2] = 0.29
                post.size[2] = 0.29
            cell.site("rack_tray_center").pos[2] = 0.601
        add_oven(cell, door_closed, combined, robot_spec)
    elif task == BakeryTask.OVEN:
        cell.delete(cell.body("cell_rack"))
        add_oven(cell, door_closed, combined, robot_spec)
    if blocked:
        destination = cell.body("mbco_oven" if task == BakeryTask.OVEN else "cell_rack")
        destination.add_geom(
            name="destination_obstruction",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[-0.1, -0.013, 0.39] if task == BakeryTask.OVEN else [0, 0, 0.91],
            size=[0.19, 0.29, 0.035] if task == BakeryTask.OVEN else [0.26, 0.17, 0.10],
            rgba=[0.8, 0.15, 0.1, 1],
        )
    attach_robot(cell, robot_spec)
    gripper_path = CELL / "gripper.xml"
    if robot_spec.slug == "universal-robots-ur5e":
        gripper_path = ASSETS / robot_spec.slug / "tooling/gripper.xml"
    gripper = mujoco.MjSpec.from_file(str(gripper_path))
    gripper.default.name = "gripper_defaults"
    cell.attach(gripper, site=cell.site("cell_nominal_flange"), prefix="")

    tray = mujoco.MjSpec.from_file(str(TRAY))
    tray.default.name = "tray_defaults"
    tray.body("mbco_tray").add_geom(
        name="cold_contents",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=[0, 0, 0.02],
        size=[0.12, 0.20, 0.015],
        mass=1,
        rgba=[0.84, 0.57, 0.22, 1],
        friction=[0.5, 0.005, 0.0001],
    )
    cell.attach(tray, frame=cell.worldbody.add_frame(), prefix="")
    return cell


def load_cell(
    blocked: bool = False, task: BakeryTask = BakeryTask.RACK, door_closed: bool = False
) -> tuple[mujoco.MjModel, mujoco.MjData]:
    model = compose_cell(blocked, task, door_closed).compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    return model, data


def arm_joint_names(model: mujoco.MjModel) -> tuple[str, ...]:
    names = tuple(
        model.joint(index).name
        for index in range(model.njnt)
        if "__" in model.joint(index).name
    )
    if len(names) != 6:
        raise ValueError("A workcell requires exactly six named arm joints")
    return names


def arm_addresses(model: mujoco.MjModel) -> tuple[np.ndarray, np.ndarray]:
    positions = np.array(
        [model.joint(name).qposadr[0] for name in arm_joint_names(model)]
    )
    velocities = np.array(
        [model.joint(name).dofadr[0] for name in arm_joint_names(model)]
    )
    return positions, velocities


def orientation_error(site_rotation: np.ndarray) -> np.ndarray:
    # Targets share world XYZ axes. The inverse current rotation gives world error.
    quaternion = np.zeros(4)
    mujoco.mju_mat2Quat(quaternion, site_rotation.reshape(3, 3).T.flatten())
    if quaternion[0] < 0:
        quaternion *= -1
    error = np.zeros(3)
    mujoco.mju_quat2Vel(error, quaternion, 1)
    return error


def solve_arm(model: mujoco.MjModel, target: np.ndarray, opening: float) -> np.ndarray:
    """Bounded static IK for inspection poses; does not plan a motion path."""
    data = mujoco.MjData(model)
    data.joint("mbco_tray_free").qpos[:3] = [0, 0, -10]
    data.joint("clamp_opening").qpos[0] = opening
    positions, velocities = arm_addresses(model)
    limits = np.array([model.joint(name).range for name in arm_joint_names(model)])
    jacobian_position = np.zeros((3, model.nv))
    jacobian_rotation = np.zeros((3, model.nv))
    seeds = tuple(
        (yaw, -1.5, elbow, -1.5, wrist, -1.57)
        for yaw in (0, 2.5, -2.5)
        for elbow in (-2, 2)
        for wrist in (-1.57, 1.57)
    )
    rejected_contacts = set()
    for seed in seeds:
        data.qpos[positions] = seed
        for _ in range(500):
            mujoco.mj_forward(model, data)
            site = data.site("cell_grasp")
            position_error = target - site.xpos
            rotation_error = orientation_error(site.xmat)
            if (
                np.linalg.norm(position_error) < 1e-5
                and np.linalg.norm(rotation_error) < 1e-5
            ):
                collisions = arm_contacts(model, data)
                if not collisions:
                    return data.qpos[positions].copy()
                rejected_contacts.update(collisions)
                break
            mujoco.mj_jacSite(
                model, data, jacobian_position, jacobian_rotation, site.id
            )
            jacobian = np.vstack(
                (jacobian_position[:, velocities], jacobian_rotation[:, velocities])
            )
            error = np.concatenate((position_error, rotation_error))
            update = jacobian.T @ np.linalg.solve(
                jacobian @ jacobian.T + np.eye(6) * 1e-4, error
            )
            update *= min(1, 0.12 / max(np.linalg.norm(update), 1e-12))
            data.qpos[positions] = np.clip(
                data.qpos[positions] + update, limits[:, 0] + 1e-5, limits[:, 1] - 1e-5
            )
    raise ValueError(
        f"No clear inspection pose found for {target.tolist()}; contacts: {sorted(rejected_contacts)}"
    )


def initialize_pose(
    model: mujoco.MjModel, data: mujoco.MjData, pose: str
) -> np.ndarray:
    if pose not in INSPECTION_POSES:
        raise ValueError(f"Unknown inspection pose: {pose}")
    mujoco.mj_resetData(model, data)
    mujoco.mj_forward(model, data)
    tray_center = data.site(f"{pose}_tray_center").xpos.copy()
    target = tray_center + GRASP_FROM_TRAY
    if pose != "lift":
        target += (-0.25, 0, 0.025)
    opening = 0 if pose == "lift" else 0.035
    angles = solve_arm(model, target, opening)
    positions, _ = arm_addresses(model)
    data.qpos[positions] = angles
    data.joint("clamp_opening").qpos[0] = opening
    data.joint("mbco_tray_free").qpos[:] = (*tray_center, *TRAY_QUATERNION)
    mujoco.mj_forward(model, data)
    return angles


def hold_cell(
    model: mujoco.MjModel, data: mujoco.MjData, target: np.ndarray, closed: bool
) -> None:
    step_cell(model, data, target, closed, -0.005 if closed else 0.035)


def step_cell(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    target: np.ndarray,
    compensate_payload: bool,
    jaw_target: float,
) -> None:
    _, velocities = arm_addresses(model)
    feed_forward = data.qfrc_bias[velocities].copy()
    if compensate_payload:
        # Ideal known-payload gravity compensation acts only through bounded arm servos.
        jacobian = np.zeros((3, model.nv))
        mujoco.mj_jac(
            model,
            data,
            jacobian,
            None,
            data.body("mbco_tray").xipos,
            model.body("cell_gripper").id,
        )
        weight = model.body("mbco_tray").mass[0] * model.opt.gravity
        feed_forward -= jacobian[:, velocities].T @ weight
    for index, name in enumerate(arm_joint_names(model)):
        data.actuator(f"{name}__servo").ctrl[0] = (
            target[index] + feed_forward[index] / SERVO_KP[index]
        )
    data.actuator("clamp_servo").ctrl[0] = jaw_target
    mujoco.mj_step(model, data)
    if (
        not np.isfinite(data.qpos).all()
        or not np.isfinite(data.qvel).all()
        or np.any(data.warning.number)
    ):
        raise RuntimeError("Non-finite state or MuJoCo warning in workcell hold.")


def contact_pairs(model: mujoco.MjModel, data: mujoco.MjData) -> list[tuple[str, str]]:
    return [
        (model.geom(contact.geom1).name, model.geom(contact.geom2).name)
        for contact in data.contact
        if contact.dist < 0
    ]


def arm_contacts(model: mujoco.MjModel, data: mujoco.MjData) -> list[tuple[str, str]]:
    return [
        pair
        for pair in contact_pairs(model, data)
        if any(name.startswith("clamp_") or "__" in name for name in pair)
    ]


def fixture_clearance(model: mujoco.MjModel, data: mujoco.MjData) -> float:
    """Return moving-arm/tool clearance from table/rack, capped at 100 mm."""
    moving = []
    fixtures = []
    for index in range(model.ngeom):
        geometry = model.geom(index)
        if geometry.name.startswith(("table_", "rack_")):
            fixtures.append(index)
        elif not geometry.name.endswith("__base_link__collision") and (
            geometry.name.startswith("clamp_") or geometry.name.endswith("__collision")
        ):
            moving.append(index)
    distance = 0.1
    for first in moving:
        for second in fixtures:
            distance = min(
                distance, mujoco.mj_geomDistance(model, data, first, second, 0.1, None)
            )
    return distance


def inspect_pose(pose: str) -> dict:
    model, data = load_cell()
    target = initialize_pose(model, data, pose)
    initial_tray = data.body("mbco_tray").xpos.copy()
    positions, _ = arm_addresses(model)
    peak_force = np.zeros(model.nu)
    for _ in range(2500):
        hold_cell(model, data, target, pose == "lift")
        peak_force = np.maximum(peak_force, np.abs(data.actuator_force))
    report = {
        "pose": pose,
        "scope": "stationary readiness check; no pickup or transfer executed",
        "joint_angles_rad": target.tolist(),
        "simulated_seconds": data.time,
        "tray_displacement_m": float(
            np.linalg.norm(data.body("mbco_tray").xpos - initial_tray)
        ),
        "arm_error_rad": float(np.max(np.abs(data.qpos[positions] - target))),
        "tray_speed": data.joint("mbco_tray_free").qvel.tolist(),
        "peak_arm_torque_nm": {
            name: float(peak_force[model.actuator(f"{name}__servo").id])
            for name in arm_joint_names(model)
        },
        "peak_clamp_force_n": float(peak_force[model.actuator("clamp_servo").id]),
        "contacts": sorted(set(contact_pairs(model, data))),
        "warnings": int(sum(data.warning.number)),
        "fixture_clearance_capped_at_0_1_m": fixture_clearance(model, data),
    }
    if report["tray_displacement_m"] > 0.003 or report["arm_error_rad"] > 0.003:
        raise RuntimeError(f"Stationary hold exceeded pose tolerance: {report}")
    if np.linalg.norm(data.joint("mbco_tray_free").qvel) > 0.005:
        raise RuntimeError(f"Tray did not settle: {report}")
    if any("__" in name for pair in report["contacts"] for name in pair):
        raise RuntimeError(f"Unexpected arm collision: {report}")
    return report


def camera_setup(camera: mujoco.MjvCamera) -> None:
    camera.lookat[:] = [0.55, 0, 0.8]
    camera.distance = 2.8
    camera.azimuth = 140
    camera.elevation = -25


def view_pose(pose: str, collision: bool) -> None:
    import mujoco.viewer

    model, data = load_cell()
    target = initialize_pose(model, data, pose)
    if collision:
        model.geom_rgba[model.geom_group == 3] = [0.3, 0.6, 0.9, 0.6]
    with mujoco.viewer.launch_passive(model, data) as viewer:
        camera_setup(viewer.cam)
        viewer.opt.geomgroup[3] = int(collision)
        viewer.opt.geomgroup[1] = int(not collision)
        viewer.opt.geomgroup[2] = int(not collision)
        viewer.opt.sitegroup[3] = 0
        viewer.opt.sitegroup[4] = 0
        while viewer.is_running():
            started = time.monotonic()
            with viewer.lock():
                for _ in range(5):
                    hold_cell(model, data, target, pose == "lift")
            viewer.sync()
            time.sleep(max(0, 0.01 - (time.monotonic() - started)))


def render_views(directory: Path) -> None:
    model, data = load_cell()
    camera = mujoco.MjvCamera()
    camera_setup(camera)
    options = mujoco.MjvOption()
    options.geomgroup[3] = 0
    options.sitegroup[3] = 0
    options.sitegroup[4] = 0
    directory.mkdir(parents=True, exist_ok=True)
    with mujoco.Renderer(model, height=1080, width=1440) as renderer:
        for pose in INSPECTION_POSES:
            target = initialize_pose(model, data, pose)
            for _ in range(2500):
                hold_cell(model, data, target, pose == "lift")
            renderer.update_scene(data, camera=camera, scene_option=options)
            pixels = renderer.render()
            path = directory / f"{pose}.ppm"
            path.write_bytes(b"P6\n1440 1080\n255\n" + pixels.tobytes())
            print(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pose", choices=INSPECTION_POSES, default="source")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--view", action="store_true")
    mode.add_argument("--render-dir", type=Path)
    parser.add_argument("--collision", action="store_true")
    args = parser.parse_args()
    if args.view:
        view_pose(args.pose, args.collision)
    elif args.render_dir is not None:
        render_views(args.render_dir)
    else:
        print(json.dumps(inspect_pose(args.pose), indent=2))


if __name__ == "__main__":
    main()
