"""Kinematic oven/tool clearance probes; these do not execute a robot skill."""

import unittest

import mujoco
import numpy as np
from workcell import CELL, TRAY


def load_access_probe() -> tuple[mujoco.MjModel, mujoco.MjData]:
    oven = mujoco.MjSpec.from_file(str(TRAY.parent / "scene.xml"))
    tool = mujoco.MjSpec.from_file(str(CELL / "gripper.xml"))
    tool.body("cell_gripper").quat = [1, 0, 0, 0]
    tool.body("cell_gripper").add_joint(
        name="tool_probe_free", type=mujoco.mjtJoint.mjJNT_FREE
    )
    oven.attach(tool, frame=oven.worldbody.add_frame(), prefix="")
    model = oven.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    return model, data


def probe_path(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    level: int,
    phase: str,
    door_angle: float,
) -> dict[tuple[str, str], float]:
    slot = data.site(f"mbco_slot_{level}").xpos.copy()
    data.joint("mbco_door_hinge").qpos[0] = door_angle
    blocked: dict[tuple[str, str], float] = {}
    for fraction in np.linspace(0, 1, 200):
        tray = slot.copy()
        tool_offset = np.array([0, -0.41, -0.001])
        opening = 0.035
        if phase == "insert":
            tray += [0, -(1 - fraction), 0.012]
            opening = 0
        elif phase == "lower":
            tray[2] += 0.012 * (1 - fraction)
            opening = 0
        elif phase == "release":
            opening = 0.035 * fraction
        elif phase == "clear":
            tool_offset[2] -= 0.006 * fraction
        elif phase == "retract":
            tool_offset += [0, -0.35 * fraction, -0.006]
        else:
            raise ValueError(f"Unknown probe phase: {phase}")
        data.joint("clamp_opening").qpos[0] = opening
        data.joint("mbco_tray_free").qpos[:] = [*tray, 1, 0, 0, 0]
        data.joint("tool_probe_free").qpos[:] = [
            *(tray + tool_offset),
            2**-0.5,
            0,
            0,
            2**-0.5,
        ]
        mujoco.mj_forward(model, data)
        for contact in data.contact:
            names = (model.geom(contact.geom1).name, model.geom(contact.geom2).name)
            moving = any(name.startswith(("clamp_", "mbco_tray_")) for name in names)
            cabinet = any(
                name.startswith("mbco_") and not name.startswith("mbco_tray_")
                for name in names
            )
            if moving and cabinet and contact.dist < -1e-5:
                pair = tuple(sorted(names))
                blocked[pair] = min(blocked.get(pair, 0), float(contact.dist))
    return blocked


class OvenAccessTests(unittest.TestCase):
    def test_lower_four_shelves_clear_the_current_tool_path(self) -> None:
        model, data = load_access_probe()
        for level in range(1, 5):
            for phase in ("insert", "lower", "release", "clear", "retract"):
                with self.subTest(level=level, phase=phase):
                    self.assertEqual(
                        probe_path(model, data, level, phase, np.deg2rad(100)), {}
                    )

    def test_top_shelf_requires_a_different_release_strategy(self) -> None:
        model, data = load_access_probe()
        angle = np.deg2rad(100)
        self.assertEqual(probe_path(model, data, 5, "insert", angle), {})
        blocked = probe_path(model, data, 5, "release", angle)
        self.assertEqual(
            set(blocked),
            {
                ("clamp_bridge", "mbco_top"),
                ("clamp_finger_left", "mbco_top"),
                ("clamp_finger_right", "mbco_top"),
            },
        )
        self.assertAlmostEqual(min(blocked.values()), -0.001, places=6)

    def test_closed_door_obstructs_the_same_insertion_path(self) -> None:
        model, data = load_access_probe()
        blocked = probe_path(model, data, 3, "insert", 0)
        self.assertTrue(blocked)
        self.assertTrue(any("door" in name for pair in blocked for name in pair))


if __name__ == "__main__":
    unittest.main(verbosity=2)
