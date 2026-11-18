"""Inspect one unloaded CAD arm in MuJoCo. No network or hardware commands."""

import argparse
import json
import time

import mujoco
import mujoco.viewer
import numpy as np

from prepare import ASSETS, ROBOTS, SERVO_KP, RobotSpec


def load(spec: RobotSpec) -> tuple[mujoco.MjModel, mujoco.MjData]:
    model = mujoco.MjModel.from_xml_path(str(ASSETS / spec.slug / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    return model, data


def hold_step(model: mujoco.MjModel, data: mujoco.MjData, target: np.ndarray) -> None:
    # Native implicit position servos include both PD and this ideal feed-forward
    # contribution within the actuator's total force limit.
    data.ctrl[:] = target + data.qfrc_bias / np.asarray(SERVO_KP)
    mujoco.mj_step(model, data)
    if not np.isfinite(data.qpos).all() or np.any(data.warning.number):
        raise RuntimeError("Non-finite state or MuJoCo engine warning.")


def headless(spec: RobotSpec) -> dict:
    model, data = load(spec)
    target = np.array(spec.home)
    peak_contacts = 0
    for _ in range(2500):
        hold_step(model, data, target)
        peak_contacts = max(peak_contacts, data.ncon)
    error = float(np.max(np.abs(data.qpos - target)))
    if error > 0.005 or peak_contacts:
        raise RuntimeError(
            f"Unloaded hold failed: error={error}, contacts={peak_contacts}"
        )
    return {
        "model": spec.slug,
        "simulated_seconds": data.time,
        "max_final_error_rad": error,
        "peak_contacts": peak_contacts,
        "warnings": int(sum(data.warning.number)),
    }


def view(spec: RobotSpec) -> None:
    model, data = load(spec)
    target = np.array(spec.home)
    with mujoco.viewer.launch_passive(model, data) as viewer:
        viewer.cam.lookat[:] = [0, 0, spec.reach_m * 0.4]
        viewer.cam.distance = spec.reach_m * 2.4
        viewer.cam.azimuth = 135
        viewer.cam.elevation = -25
        viewer.opt.geomgroup[3] = 0
        while viewer.is_running():
            started = time.monotonic()
            with viewer.lock():
                for _ in range(5):
                    hold_step(model, data, target)
            viewer.sync()
            time.sleep(max(0, 0.01 - (time.monotonic() - started)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=[spec.slug for spec in ROBOTS])
    parser.add_argument("--view", action="store_true")
    arguments = parser.parse_args()
    spec = next(spec for spec in ROBOTS if spec.slug == arguments.model)
    if arguments.view:
        view(spec)
    else:
        print(json.dumps(headless(spec), indent=2))


if __name__ == "__main__":
    main()
