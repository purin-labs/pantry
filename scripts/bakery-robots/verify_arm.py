"""Prepare arm acceptance fixtures and verify asset conversion; Rust advances physics."""

import hashlib
import json
import os
import sys
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy
import mujoco
import numpy as np
from mathutils import Quaternion, Vector
from prepare import ASSETS, ROBOTS, VENDOR, source_robot, write_xml
from test_models import inertia_tensor, reference_poses, source_origin

SPEC = next(spec for spec in ROBOTS if spec.slug == sys.argv[1])
DIRECTORY = ASSETS / SPEC.slug
EVIDENCE = DIRECTORY / "acceptance"
ROOT = ASSETS.parents[1]


def fixture(case: str, payload: bool, obstacle: list[float]) -> None:
    scene = ET.parse(DIRECTORY / "scene.xml").getroot()
    scene.remove(scene.find("include"))
    robot = ET.parse(DIRECTORY / "robot.xml").getroot()
    for mesh in robot.findall("asset/mesh"):
        mesh.set("file", "../" + mesh.attrib["file"])
    for element in robot:
        scene.append(element)
    if payload:
        flange = scene.find(f".//body[@name='{SPEC.slug}__flange']")
        body = ET.SubElement(flange, "body", name="acceptance_payload", pos="0.06 0 0")
        ET.SubElement(
            body,
            "geom",
            name="payload_visual",
            type="box",
            size="0.05 0.05 0.05",
            mass=str(SPEC.payload_kg),
            rgba="0.9 0.55 0.12 1",
            contype="0",
            conaffinity="0",
        )
    if obstacle:
        ET.SubElement(
            scene.find("worldbody"),
            "geom",
            name="acceptance_obstacle",
            type="sphere",
            size="0.03",
            pos=" ".join(map(str, obstacle)),
            rgba="1 0.2 0.1 1",
        )
    write_xml(scene, EVIDENCE / f"{case}.xml")


def verify_geometry() -> dict:
    source = source_robot(SPEC)
    model = mujoco.MjModel.from_xml_path(str(DIRECTORY / "scene.xml"))
    data = mujoco.MjData(model)
    bpy.ops.wm.open_mainfile(filepath=str(DIRECTORY / "robot.blend"))
    for obj in bpy.data.objects:
        obj.animation_data_clear()
    poses = [
        np.zeros(6),
        np.array(SPEC.home),
        np.array(SPEC.home) + np.array((0.45, -0.15, 0.15, 0.15, 0.3, 0.25)),
    ]
    maximum = 0.0
    reference = []
    for angles in poses:
        data.qpos[:] = angles
        mujoco.mj_forward(model, data)
        assert data.ncon == 0, "Unexpected bare-arm contact"
        for joint, angle in zip(
            source.findall("joint[@type='revolute']"), angles, strict=True
        ):
            pivot = bpy.data.objects[f"{SPEC.slug}__{joint.attrib['name']}"]
            pivot.rotation_quaternion = Quaternion(
                Vector(map(float, joint.find("axis").attrib["xyz"].split())),
                float(angle),
            )
        bpy.context.view_layer.update()
        expected = reference_poses(source, angles)
        reference.append(
            {
                "angles": angles.tolist(),
                "links": {
                    f"{SPEC.slug}__{label}": matrix.tolist()
                    for label, matrix in expected.items()
                },
            }
        )
        for label, matrix in expected.items():
            actual = np.array(bpy.data.objects[f"{SPEC.slug}__{label}"].matrix_world)
            body = data.body(f"{SPEC.slug}__{label}")
            maximum = max(maximum, float(np.max(np.abs(actual - matrix))))
            np.testing.assert_allclose(actual, matrix, atol=1e-6)
            # The asset exporter uses Blender's float32 quaternion transforms.
            np.testing.assert_allclose(body.xpos, matrix[:3, 3], atol=1e-7)
            np.testing.assert_allclose(
                body.xmat.reshape(3, 3), matrix[:3, :3], atol=1e-6
            )
    for link in source.findall("link"):
        visual = link.find("visual")
        if visual is not None:
            node = bpy.data.objects[f"{SPEC.slug}__{link.attrib['name']}__cad"]
            np.testing.assert_allclose(
                np.array(node.matrix_local), source_origin(visual), atol=1e-6
            )
        inertial = link.find("inertial")
        if inertial is None:
            continue
        body = model.body(f"{SPEC.slug}__{link.attrib['name']}")
        np.testing.assert_allclose(
            body.mass, float(inertial.find("mass").attrib["value"]), atol=1e-12
        )
        axes = np.zeros(9)
        mujoco.mju_quat2Mat(axes, body.iquat)
        axes = axes.reshape(3, 3)
        np.testing.assert_allclose(
            axes @ np.diag(body.inertia) @ axes.T,
            source_origin(inertial)[:3, :3]
            @ inertia_tensor(inertial)
            @ source_origin(inertial)[:3, :3].T,
            atol=1e-7,
        )
    for line in (VENDOR / SPEC.slug / "SHA256SUMS").read_text().splitlines():
        digest, path = line.split(maxsplit=1)
        assert (
            hashlib.sha256((VENDOR / SPEC.slug / path).read_bytes()).hexdigest()
            == digest
        )
    (EVIDENCE / "reference-poses.json").write_text(
        json.dumps(reference, indent=2) + "\n"
    )
    return {
        "sampled_poses": len(poses),
        "source_links": len(source.findall("link")),
        "maximum_blender_matrix_error": maximum,
        "source_mass_kg": float(sum(model.body_mass)),
        "source_inertias_preserved": True,
        "vendor_hashes_verified": True,
    }


def prepare_fixtures() -> None:
    fixture("unloaded", False, [])
    fixture("loaded", True, [])
    save_initial_state("loaded")
    save_initial_state("unloaded")
    model = mujoco.MjModel.from_xml_path(str(EVIDENCE / "unloaded.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    third_link = (
        source_robot(SPEC)
        .findall("joint[@type='revolute']")[2]
        .find("child")
        .get("link")
    )
    geom = data.geom(f"{SPEC.slug}__{third_link}__collision")
    mesh = model.geom_dataid[geom.id]
    start = model.mesh_vertadr[mesh]
    vertices = model.mesh_vert[start : start + model.mesh_vertnum[mesh]]
    # Contact the middle of the link, away from adjoining joint bearings.
    longest = int(np.argmax(np.ptp(vertices, axis=0)))
    middle = (vertices[:, longest].min() + vertices[:, longest].max()) / 2
    candidates = vertices[
        np.abs(vertices[:, longest] - middle) < np.ptp(vertices[:, longest]) * 0.2
    ]
    # Some simplified meshes contain only end rings. Use their supplied surface.
    if len(candidates) == 0:
        candidates = vertices
    radial = candidates.copy()
    radial[:, longest] = 0
    index = int(np.argmax(np.linalg.norm(radial, axis=1)))
    vertex = candidates[index]
    outside = vertex + radial[index] / np.linalg.norm(radial[index]) * 0.025
    surface = geom.xpos + geom.xmat.reshape(3, 3) @ outside
    fixture("obstacle", False, surface.tolist())


def save_initial_state(case: str) -> None:
    model = mujoco.MjModel.from_xml_path(str(EVIDENCE / f"{case}.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    signature = mujoco.mjtState.mjSTATE_INTEGRATION
    state = np.empty(mujoco.mj_stateSize(model, signature))
    mujoco.mj_getState(model, data, state, signature)
    (EVIDENCE / f"{case}-initial-state.json").write_text(
        json.dumps(state.tolist()) + "\n"
    )


def main() -> None:
    EVIDENCE.mkdir(exist_ok=True)
    report = verify_geometry()
    prepare_fixtures()
    environment = dict(os.environ)
    environment["MUJOCO_DIR"] = str(Path(mujoco.__file__).parent)
    subprocess.run(
        [
            "cargo",
            "run",
            "--locked",
            "--release",
            "--manifest-path",
            "crates/bakery-native/Cargo.toml",
            "--example",
            "arm_asset_acceptance",
            "--",
            str(EVIDENCE),
        ],
        cwd=ROOT,
        env=environment,
        check=True,
    )
    report["passed"] = True
    artifacts = [
        DIRECTORY / filename
        for filename in (
            "robot.blend",
            "robot.glb",
            "robot.urdf",
            "robot.xml",
            "scene.xml",
        )
    ]
    artifacts.extend(sorted((DIRECTORY / "meshes").glob("*.obj")))
    report["asset_sha256"] = {
        str(path.relative_to(DIRECTORY)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in artifacts
    }
    (EVIDENCE / "geometry-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
