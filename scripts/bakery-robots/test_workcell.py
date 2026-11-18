"""Fixed-cell acceptance tests; no continuous manipulation or hardware certification."""

import json
import unittest

import mujoco
import numpy as np

from prepare import ASSETS
from workcell import (
    ARM_JOINTS,
    GRASP_FROM_TRAY,
    INSPECTION_POSES,
    TRAY_QUATERNION,
    arm_addresses,
    arm_contacts,
    contact_pairs,
    fixture_clearance,
    hold_cell,
    initialize_pose,
    load_cell,
    orientation_error,
    solve_arm,
)


def settle(
    model: mujoco.MjModel, data: mujoco.MjData, target: np.ndarray, closed: bool
) -> np.ndarray:
    peak = np.zeros(model.nu)
    for _ in range(2500):
        hold_cell(model, data, target, closed)
        peak = np.maximum(peak, np.abs(data.actuator_force))
        if any(
            name.startswith("fairino-fr10__")
            for pair in contact_pairs(model, data)
            for name in pair
        ):
            raise AssertionError("Arm collision during stationary hold")
    return peak


class WorkcellTests(unittest.TestCase):
    def test_nominal_flange_and_mass_properties(self) -> None:
        model, data = load_cell()
        initialize_pose(model, data, "lift")
        wrist = data.body("fairino-fr10__wrist3_link")
        flange = data.site("cell_nominal_flange")
        expected = wrist.xpos + wrist.xmat.reshape(3, 3) @ [0, 0, 0.106]
        np.testing.assert_allclose(flange.xpos, expected, atol=1e-12)
        np.testing.assert_allclose(flange.xmat, wrist.xmat, atol=1e-12)
        fidelity = json.loads((ASSETS / "fairino-fr10/fidelity.json").read_text())
        last_mesh = next(
            mesh
            for mesh in fidelity["meshes"]
            if mesh["node"].endswith("wrist3_link__cad")
        )
        self.assertAlmostEqual(last_mesh["link_bounds_max_m"][2], 0.106, places=6)
        self.assertAlmostEqual(model.body("mbco_tray").mass[0], 3)
        self.assertAlmostEqual(
            model.body("cell_gripper").mass[0] + model.body("cell_upper_jaw").mass[0],
            1.5,
        )
        # Sheet: 1.6 kg at z=0; rims: 0.4 kg at z=.01; contents: 1 kg at z=.02.
        np.testing.assert_allclose(
            model.body("mbco_tray").ipos, [0, 0, 0.008], atol=1e-12
        )
        self.assertEqual(
            model.joint("mbco_tray_free").type[0], mujoco.mjtJoint.mjJNT_FREE
        )
        self.assertEqual(model.neq, 0)
        for body_name in ("mbco_tray", "cell_gripper", "cell_upper_jaw"):
            inertia = model.body(body_name).inertia
            self.assertTrue(np.all(inertia > 0))
            self.assertLessEqual(2 * max(inertia), sum(inertia))

    def test_reachable_poses_and_accessible_grasp_targets(self) -> None:
        model, data = load_cell()
        positions, _ = arm_addresses(model)
        for pose in INSPECTION_POSES:
            with self.subTest(pose=pose):
                initialize_pose(model, data, pose)
                center = data.site(f"{pose}_tray_center").xpos.copy()
                target = center + GRASP_FROM_TRAY
                angles = solve_arm(model, target, 0.035)
                data.qpos[positions] = angles
                data.joint("clamp_opening").qpos[0] = 0.035
                data.joint("mbco_tray_free").qpos[:] = (*center, *TRAY_QUATERNION)
                mujoco.mj_forward(model, data)
                np.testing.assert_allclose(
                    data.site("cell_grasp").xpos, target, atol=1e-5
                )
                self.assertLess(
                    np.linalg.norm(orientation_error(data.site("cell_grasp").xmat)),
                    1e-5,
                )
                self.assertGreater(fixture_clearance(model, data), 0.005)
                for angle, name in zip(angles, ARM_JOINTS, strict=True):
                    self.assertTrue(
                        model.joint(name).range[0] < angle < model.joint(name).range[1]
                    )
                for first, second in arm_contacts(model, data):
                    self.assertTrue(
                        first.startswith("clamp_fork_")
                        and second == "mbco_tray_bottom",
                        (first, second),
                    )

    def test_table_and_rack_support_a_settled_free_tray(self) -> None:
        for pose, supports in (
            ("source", {"table_top"}),
            ("rack", {"rack_rail_left", "rack_rail_right"}),
        ):
            with self.subTest(pose=pose):
                model, data = load_cell()
                target = initialize_pose(model, data, pose)
                initial = data.body("mbco_tray").xpos.copy()
                settle(model, data, target, False)
                np.testing.assert_allclose(
                    data.body("mbco_tray").xpos, initial, atol=0.001
                )
                self.assertLess(np.linalg.norm(data.joint("mbco_tray_free").qvel), 1e-4)
                self.assertEqual(arm_contacts(model, data), [])
                pairs = contact_pairs(model, data)
                touched = {name for pair in pairs for name in pair}
                self.assertTrue(supports <= touched)
                self.assertEqual(sum(data.warning.number), 0)

    def test_free_tray_loaded_grip_remains_stable_with_bounded_actuators(self) -> None:
        model, data = load_cell()
        target = initialize_pose(model, data, "lift")
        initial = data.body("mbco_tray").xpos.copy()
        peak = settle(model, data, target, True)
        np.testing.assert_allclose(data.body("mbco_tray").xpos, initial, atol=0.001)
        positions, _ = arm_addresses(model)
        np.testing.assert_allclose(data.qpos[positions], target, atol=0.001)
        self.assertLess(np.linalg.norm(data.joint("mbco_tray_free").qvel), 1e-4)
        self.assertTrue(np.all(peak <= model.actuator_forcerange[:, 1] + 1e-9))
        touched = {name for pair in contact_pairs(model, data) for name in pair}
        self.assertEqual(
            touched,
            {
                "clamp_fork_left",
                "clamp_fork_right",
                "clamp_pad_left",
                "clamp_pad_right",
                "mbco_tray_bottom",
            },
        )
        np.testing.assert_array_equal(data.xfrc_applied, 0)
        self.assertEqual(model.neq, 0)
        self.assertEqual(sum(data.warning.number), 0)

    def test_disabling_tool_contact_allows_the_tray_to_fall(self) -> None:
        model, data = load_cell()
        target = initialize_pose(model, data, "lift")
        initial_height = data.body("mbco_tray").xpos[2]
        for index in range(model.ngeom):
            if model.geom(index).name.startswith("clamp_"):
                model.geom_contype[index] = 0
                model.geom_conaffinity[index] = 0
        for _ in range(250):
            hold_cell(model, data, target, True)
        self.assertLess(data.body("mbco_tray").xpos[2], initial_height - 0.1)

    def test_out_of_reach_target_is_rejected(self) -> None:
        model, _ = load_cell()
        with self.assertRaisesRegex(ValueError, "No clear inspection pose"):
            solve_arm(model, np.array([8, 0, 2]), 0.035)


if __name__ == "__main__":
    unittest.main(verbosity=2)
