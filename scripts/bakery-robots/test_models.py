"""Cross-format checks against source frames; no hardware accuracy certification."""

import hashlib
import json
import unittest
import xml.etree.ElementTree as ET

import bpy
from mathutils import Quaternion, Vector
import mujoco
import numpy as np

from inspect_arm import hold_step, load
from prepare import ASSETS, ROBOTS, VENDOR, correct_fairino_inertials, source_robot


# Hand-evaluated COMs from manual 3.9.4's nominal DH frames, in metres.
FAIRINO_EXPECTED_COM = {
    "fairino-fr10": (
        (-0.00010, -0.00404, 0.15388),
        (-0.21973, 0.00001, 0.16468),
        (-0.37478, 0.00011, 0.05421),
        (0.00012, -0.01218, 0.15600),
        (-0.00012, 0.01218, 0.11100),
        (0.00124, 0.00085, 0.08566),
    ),
    "fairino-fr5": (
        (-0.00019, -0.00226, 0.13372),
        (-0.21253, 0, 0.12120),
        (-0.27238, 0.00017, 0.01259),
        (0.00005, -0.01468, 0.09967),
        (-0.00005, 0.01468, 0.09967),
        (0.00093, 0.00081, 0.07995),
    ),
}


def rotation(axis: np.ndarray, angle: float) -> np.ndarray:
    x, y, z = axis / np.linalg.norm(axis)
    skew = np.array(((0, -z, y), (z, 0, -x), (-y, x, 0)))
    return np.eye(3) + np.sin(angle) * skew + (1 - np.cos(angle)) * (skew @ skew)


def source_origin(element: ET.Element) -> np.ndarray:
    transform = np.eye(4)
    origin = element.find("origin")
    if origin is None:
        return transform
    transform[:3, 3] = np.fromstring(origin.get("xyz", "0 0 0"), sep=" ")
    roll, pitch, yaw = np.fromstring(origin.get("rpy", "0 0 0"), sep=" ")
    transform[:3, :3] = (
        rotation(np.array((0, 0, 1)), yaw)
        @ rotation(np.array((0, 1, 0)), pitch)
        @ rotation(np.array((1, 0, 0)), roll)
    )
    return transform


def reference_poses(robot: ET.Element, angles: np.ndarray) -> dict[str, np.ndarray]:
    children = {joint.find("child").attrib["link"] for joint in robot.findall("joint")}
    base = next(
        link.attrib["name"]
        for link in robot.findall("link")
        if link.attrib["name"] not in children
    )
    poses = {base: np.eye(4)}
    moving_angles = iter(angles)
    for joint in robot.findall("joint"):
        parent = joint.find("parent").attrib["link"]
        child = joint.find("child").attrib["link"]
        turn = np.eye(4)
        if joint.attrib["type"] == "revolute":
            axis = np.fromstring(joint.find("axis").attrib["xyz"], sep=" ")
            turn[:3, :3] = rotation(axis, next(moving_angles))
        poses[child] = poses[parent] @ source_origin(joint) @ turn
    return poses


def inertia_tensor(element: ET.Element) -> np.ndarray:
    values = element.find("inertia").attrib
    return np.array(
        (
            (float(values["ixx"]), float(values["ixy"]), float(values["ixz"])),
            (float(values["ixy"]), float(values["iyy"]), float(values["iyz"])),
            (float(values["ixz"]), float(values["iyz"]), float(values["izz"])),
        )
    )


def pose_samples(home: tuple[float, ...]) -> tuple[np.ndarray, ...]:
    return (
        np.zeros(6),
        np.array(home),
        np.array(home) + np.array((0.4, 0.15, -0.2, 0.25, 0.1, -0.3)),
    )


class RobotAssetTests(unittest.TestCase):
    def test_sources_have_not_changed(self) -> None:
        for line in (VENDOR / "SHA256SUMS").read_text().splitlines():
            digest, path = line.split(maxsplit=1)
            with self.subTest(path=path):
                self.assertEqual(
                    hashlib.sha256((VENDOR / path).read_bytes()).hexdigest(), digest
                )

    def test_blender_and_mujoco_match_independent_source_kinematics(self) -> None:
        for spec in ROBOTS:
            robot = source_robot(spec)
            model, data = load(spec)
            bpy.ops.wm.open_mainfile(filepath=str(ASSETS / spec.slug / "robot.blend"))
            for obj in bpy.data.objects:
                obj.animation_data_clear()
            for angles in pose_samples(spec.home):
                data.qpos[:] = angles
                mujoco.mj_forward(model, data)
                for joint, angle in zip(
                    robot.findall("joint[@type='revolute']"), angles, strict=True
                ):
                    pivot = bpy.data.objects[f"{spec.slug}__{joint.attrib['name']}"]
                    axis = Vector(
                        tuple(
                            float(value)
                            for value in joint.find("axis").attrib["xyz"].split()
                        )
                    )
                    pivot.rotation_quaternion = Quaternion(axis, float(angle))
                bpy.context.view_layer.update()
                for link, expected in reference_poses(robot, angles).items():
                    with self.subTest(robot=spec.slug, link=link, angles=angles):
                        body = data.body(f"{spec.slug}__{link}")
                        np.testing.assert_allclose(
                            body.xpos, expected[:3, 3], atol=1e-6
                        )
                        np.testing.assert_allclose(
                            body.xmat.reshape(3, 3), expected[:3, :3], atol=1e-6
                        )
                        actual = np.array(
                            bpy.data.objects[f"{spec.slug}__{link}"].matrix_world
                        )
                        np.testing.assert_allclose(actual, expected, atol=1e-6)

    def test_prepared_inertials_and_preserved_mass_axes_and_limits(self) -> None:
        for spec in ROBOTS:
            source = source_robot(spec)
            prepared = ET.parse(ASSETS / spec.slug / "robot.urdf").getroot()
            model, _ = load(spec)
            self.assertEqual((model.nq, model.nv, model.nu), (6, 6, 6))
            for link in source.findall("link"):
                if link.find("inertial") is None:
                    continue
                body = model.body(f"{spec.slug}__{link.attrib['name']}")
                inertial = prepared.find(
                    f"link[@name='{link.attrib['name']}']/inertial"
                )
                with self.subTest(robot=spec.slug, link=link.attrib["name"]):
                    if (
                        spec.slug in ("ufactory-xarm6", "fanuc-crx10ial")
                        or link.attrib["name"] == "base_link"
                    ):
                        np.testing.assert_array_equal(
                            source_origin(inertial),
                            source_origin(link.find("inertial")),
                        )
                        np.testing.assert_array_equal(
                            inertia_tensor(inertial),
                            inertia_tensor(link.find("inertial")),
                        )
                    self.assertAlmostEqual(
                        body.mass[0], float(link.find("inertial/mass").attrib["value"])
                    )
                    np.testing.assert_allclose(
                        body.ipos, source_origin(inertial)[:3, 3], atol=1e-7
                    )
                    axes = np.zeros(9)
                    mujoco.mju_quat2Mat(axes, body.iquat)
                    actual = (
                        axes.reshape(3, 3)
                        @ np.diag(body.inertia)
                        @ axes.reshape(3, 3).T
                    )
                    source_axes = source_origin(inertial)[:3, :3]
                    expected = source_axes @ inertia_tensor(inertial) @ source_axes.T
                    np.testing.assert_allclose(actual, expected, atol=1e-7, rtol=1e-6)
                    self.assertTrue(np.all(body.inertia > 0))
            for index, joint in enumerate(source.findall("joint[@type='revolute']")):
                actual = model.joint(f"{spec.slug}__{joint.attrib['name']}")
                limits = joint.find("limit").attrib
                np.testing.assert_allclose(
                    actual.range, (float(limits["lower"]), float(limits["upper"]))
                )
                np.testing.assert_allclose(
                    actual.axis,
                    np.fromstring(joint.find("axis").attrib["xyz"], sep=" "),
                )
                np.testing.assert_allclose(
                    model.actuator_forcerange[index],
                    (-float(limits["effort"]), float(limits["effort"])),
                )

    def test_fairino_frame_correction_and_gravity_loads(self) -> None:
        positive_twist = np.array(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
        negative_twist = positive_twist.T
        twists = (
            positive_twist,
            np.eye(3),
            np.eye(3),
            positive_twist,
            negative_twist,
            np.eye(3),
        )
        for spec in ROBOTS:
            if spec.slug not in FAIRINO_EXPECTED_COM:
                continue
            source = source_robot(spec)
            converted = source_robot(spec)
            correct_fairino_inertials(spec, converted)
            prepared = ET.parse(ASSETS / spec.slug / "robot.urdf").getroot()
            model, data = load(spec)
            bpy.ops.wm.open_mainfile(filepath=str(ASSETS / spec.slug / "robot.blend"))
            centers = FAIRINO_EXPECTED_COM[spec.slug]
            fidelity = json.loads((ASSETS / spec.slug / "fidelity.json").read_text())
            self.assertEqual(len(fidelity["source_issues"]), 6)
            self.assertEqual(len(fidelity["inertial_corrections"]), 6)
            self.assertEqual(fidelity["prepared_issues"], [])
            for joint, center, axes in zip(
                source.findall("joint"), centers, twists, strict=True
            ):
                label = joint.find("child").attrib["link"]
                path = f"link[@name='{label}']/inertial"
                raw = source.find(path)
                expected_tensor = axes @ inertia_tensor(raw) @ axes.T
                with self.subTest(robot=spec.slug, link=label):
                    for robot in (converted, prepared):
                        actual = robot.find(path)
                        np.testing.assert_allclose(
                            source_origin(actual)[:3, 3], center, atol=1e-12
                        )
                        np.testing.assert_allclose(
                            inertia_tensor(actual), expected_tensor, atol=1e-12
                        )
                        np.testing.assert_allclose(
                            np.linalg.eigvalsh(inertia_tensor(actual)),
                            np.linalg.eigvalsh(inertia_tensor(raw)),
                            atol=1e-12,
                        )
                    node = bpy.data.objects[f"{spec.slug}__{label}"]
                    np.testing.assert_allclose(
                        node["urdf_center_of_mass_m"], center, atol=1e-12
                    )
                    body = model.body(f"{spec.slug}__{label}")
                    np.testing.assert_allclose(body.ipos, center, atol=1e-12)
                    bounds = next(
                        item
                        for item in fidelity["meshes"]
                        if item["node"] == f"{spec.slug}__{label}__cad"
                    )
                    self.assertTrue(
                        np.all(np.array(center) >= bounds["link_bounds_min_m"])
                    )
                    self.assertTrue(
                        np.all(np.array(center) <= bounds["link_bounds_max_m"])
                    )
            # Potential-energy gradients independently check the applied gravity torques.
            for angles in pose_samples(spec.home):
                data.qpos[:] = angles
                data.qvel[:] = 0
                mujoco.mj_forward(model, data)
                expected_gravity = np.zeros(6)
                epsilon = 1e-5
                for axis in range(6):
                    energies = []
                    for sign in (-1, 1):
                        displaced = angles.copy()
                        displaced[axis] += sign * epsilon
                        poses = reference_poses(source, displaced)
                        energy = 0
                        for joint, center in zip(
                            source.findall("joint"), centers, strict=True
                        ):
                            label = joint.find("child").attrib["link"]
                            world_center = poses[label] @ np.array((*center, 1))
                            mass = float(
                                source.find(
                                    f"link[@name='{label}']/inertial/mass"
                                ).attrib["value"]
                            )
                            energy -= mass * model.opt.gravity @ world_center[:3]
                        energies.append(energy)
                    expected_gravity[axis] = (energies[1] - energies[0]) / (2 * epsilon)
                np.testing.assert_allclose(data.qfrc_bias, expected_gravity, atol=2e-5)

    def test_unloaded_hold_recovers_from_each_joint_disturbance(self) -> None:
        for spec in ROBOTS:
            for disturbed in range(6):
                model, data = load(spec)
                target = np.array(spec.home)
                data.qpos[disturbed] += 0.02
                mujoco.mj_forward(model, data)
                peak_force = np.zeros(6)
                peak_contacts = 0
                for _ in range(2500):
                    hold_step(model, data, target)
                    peak_force = np.maximum(peak_force, np.abs(data.actuator_force))
                    peak_contacts = max(peak_contacts, data.ncon)
                with self.subTest(robot=spec.slug, disturbed=disturbed):
                    np.testing.assert_allclose(data.qpos, target, atol=1e-4)
                    np.testing.assert_allclose(data.qvel, 0, atol=1e-4)
                    self.assertEqual(peak_contacts, 0)
                    self.assertTrue(
                        np.all(peak_force <= model.actuator_forcerange[:, 1] + 1e-6)
                    )
                    self.assertEqual(sum(data.warning.number), 0)

    def test_external_obstacle_makes_contact(self) -> None:
        for spec in ROBOTS:
            model, data = load(spec)
            source = source_robot(spec)
            forearm = source.findall("joint")[2].find("child").attrib["link"]
            geometry = data.geom(f"{spec.slug}__{forearm}__collision")
            mesh_id = model.geom_dataid[geometry.id]
            vertex = model.mesh_vert[model.mesh_vertadr[mesh_id]]
            surface = geometry.xpos + geometry.xmat.reshape(3, 3) @ vertex
            model_spec = mujoco.MjSpec.from_file(str(ASSETS / spec.slug / "scene.xml"))
            model_spec.worldbody.add_geom(
                name="test_obstacle",
                type=mujoco.mjtGeom.mjGEOM_SPHERE,
                size=[0.03, 0, 0],
                pos=surface,
            )
            with_obstacle = model_spec.compile()
            obstacle_data = mujoco.MjData(with_obstacle)
            mujoco.mj_resetDataKeyframe(with_obstacle, obstacle_data, 0)
            mujoco.mj_forward(with_obstacle, obstacle_data)
            obstacle_id = with_obstacle.geom("test_obstacle").id
            with self.subTest(robot=spec.slug):
                self.assertTrue(
                    any(
                        obstacle_id in (contact.geom1, contact.geom2)
                        for contact in obstacle_data.contact
                    )
                )

    def test_unactuated_arm_moves_under_gravity(self) -> None:
        for spec in ROBOTS:
            model = mujoco.MjModel.from_xml_path(str(ASSETS / spec.slug / "robot.xml"))
            data = mujoco.MjData(model)
            data.qpos[:] = spec.home
            mujoco.mj_forward(model, data)
            mujoco.mj_step(model, data, nstep=50)
            self.assertGreater(np.linalg.norm(data.qpos - np.array(spec.home)), 0.001)

    def test_all_arms_compose_with_preserved_mesh_paths(self) -> None:
        cell = mujoco.MjSpec()
        for index, spec in enumerate(ROBOTS):
            robot = mujoco.MjSpec.from_file(str(ASSETS / spec.slug / "robot.xml"))
            placement = cell.worldbody.add_frame(pos=[index * 2, 0, 0])
            cell.attach(robot, frame=placement, prefix="")
        model = cell.compile()
        data = mujoco.MjData(model)
        data.qpos[:] = np.concatenate([spec.home for spec in ROBOTS])
        mujoco.mj_forward(model, data)
        self.assertEqual(model.nq, 6 * len(ROBOTS))
        for index, spec in enumerate(ROBOTS):
            last = source_robot(spec).findall("joint")[-1].find("child").attrib["link"]
            expected = reference_poses(source_robot(spec), np.array(spec.home))[last]
            actual = data.body(f"{spec.slug}__{last}")
            np.testing.assert_allclose(
                actual.xpos, expected[:3, 3] + (index * 2, 0, 0), atol=1e-6
            )


def write_cross_format_reference() -> None:
    reference = []
    for spec in ROBOTS:
        source = source_robot(spec)
        samples = []
        for angles in pose_samples(spec.home):
            poses = reference_poses(source, angles)
            samples.append(
                {
                    "angles": angles.tolist(),
                    "links": {
                        f"{spec.slug}__{link}": matrix.tolist()
                        for link, matrix in poses.items()
                    },
                }
            )
        reference.append({"slug": spec.slug, "samples": samples})
    (ASSETS / "reference-poses.json").write_text(json.dumps(reference, indent=2) + "\n")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RobotAssetTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    write_cross_format_reference()
