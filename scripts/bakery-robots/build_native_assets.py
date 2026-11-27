"""Build the versioned native inputs. Python is required only when rebuilding assets."""

import ctypes
import hashlib
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
from prepare import ROBOTS, RobotSpec
from native_asset_snapshot import fixture_snapshot, geometry_snapshot, pose
from pour_over_station import (
    STATION,
    compose_pour_over,
    initialize_ready,
    station_frames,
    station_geometry,
)
from spanner_workcell import (
    MBCO4_DIR,
    MBCO4_GLB,
    SPANNER_OPEN_M,
    SPANNER_ROBOTS,
    SPANNER_TRAY_QUAT,
    compose_spanner_oven_cell,
    spanner_home_q,
)
from workcell import (
    ASSETS,
    TRAY,
    TRAY_QUATERNION,
    BakeryTask,
    compose_cell,
    initialize_pose,
    arm_addresses,
)

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets/bakery-mujoco/fr10-workcell/native"
sys.path.insert(0, str(ROOT / "scripts/bakery-mujoco"))
from export_native_appliances import export, strip_visual_meshes


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def add_receiving_pan(spec: mujoco.MjSpec) -> None:
    """Empty 200 mm pan fixed in a carrier insert; dimensions and mass assumed.

    The insert constrains the pan to the existing clamped tray. This fixture
    does not qualify bare-pan gripping, insert release, or liquid transport.
    """
    tray = spec.body("mbco_tray")
    tray.add_geom(
        name="receiving_pan_base", type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        pos=[0, 0, 0.007], size=[0.1, 0.003, 0], mass=0.35,
        rgba=[0.65, 0.67, 0.69, 1],
    )
    for index in range(24):
        angle = index * math.tau / 24
        tray.add_geom(
            name=f"receiving_pan_wall_{index:02}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[0.098 * math.cos(angle), 0.098 * math.sin(angle), 0.05],
            quat=[math.cos(angle / 2), 0, 0, math.sin(angle / 2)],
            size=[0.002, 0.0132, 0.04], mass=0.45 / 24,
            rgba=[0.65, 0.67, 0.69, 1],
        )
    tray.add_geom(
        name="receiving_pan_handle", type=mujoco.mjtGeom.mjGEOM_CAPSULE,
        fromto=[0, 0.1, 0.07, 0, 0.25, 0.07], size=[0.012, 0, 0],
        mass=0.2, rgba=[0.15, 0.16, 0.17, 1],
    )
    for index, (x, y) in enumerate(((0.114, 0), (-0.114, 0), (0, 0.114), (0, -0.114))):
        tray.add_geom(
            name=f"receiving_pan_insert_{index}",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=[x, y, 0.023], size=[0.013, 0.013, 0.02],
            mass=0.05, rgba=[0.22, 0.24, 0.26, 1],
        )


def export_pour_over(destination: Path, dependencies: set) -> None:
    """Serialize the FR10 pour-over station with its ready state and display geometry."""
    spec = compose_pour_over()
    original = spec.compile()
    xml = ET.fromstring(spec.to_xml())
    strip_visual_meshes(xml, original)
    used_meshes = {geom.get("mesh") for geom in xml.iter("geom")}
    asset = xml.find("asset")
    for mesh in list(asset.findall("mesh")):
        if mesh.get("name") not in used_meshes:
            asset.remove(mesh)
    for mesh in xml.findall("./asset/mesh"):
        source = mesh.get("file")
        if source is None:
            continue
        path = Path(os.path.normpath(ASSETS / "fairino-fr10" / source))
        dependencies.add(path)
        mesh.set("file", os.path.relpath(path, destination))
        mesh.set(
            "content_type",
            "model/stl" if path.suffix.lower() == ".stl" else "model/obj",
        )
    for element in xml.iter():
        attributes = sorted(element.attrib.items())
        element.attrib.clear()
        element.attrib.update(attributes)
    xml_path = destination / "pour-over-station.xml"
    ET.indent(xml)
    xml_path.write_text(ET.tostring(xml, encoding="unicode") + "\n")
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(
            getattr(original, field), getattr(model, field), rtol=1e-10, atol=1e-12
        ):
            raise RuntimeError(f"Pour-over export changed {field}")
    data = mujoco.MjData(model)
    angles = initialize_ready(model, data)
    signature = mujoco.mjtState.mjSTATE_INTEGRATION
    state = np.empty(mujoco.mj_stateSize(model, signature))
    mujoco.mj_getState(model, data, state, signature)
    base = data.body("fairino-fr10__base_link")
    setup_path = destination / "pour-over-station.json"
    write_json(
        setup_path,
        {
            "initialState": state.tolist(),
            "readyAngles": angles.tolist(),
            "robotBase": pose(base.xpos, base.xquat),
            "geometry": station_geometry(model, data),
            "frames": station_frames(model, data),
        },
    )
    dependencies.update(
        (
            xml_path,
            setup_path,
            STATION / "station.xml",
            STATION / "gripper.xml",
        )
    )


def export_spanner_oven(
    robot_spec: RobotSpec, destination: Path, dependencies: set
) -> None:
    """Serialize the Plan 24 cobot + Maruzen MBCO-4ME spanner-gripper workcell fixtures."""
    variants = [
        ("spanner-oven-nominal", False, False, False, False, False, False),
        ("spanner-oven-closed-door", False, True, False, False, False, False),
        ("spanner-oven-blocked", True, False, False, False, False, False),
        ("spanner-oven-combined-nominal", False, False, False, True, False, False),
        ("spanner-oven-blocked-rack-nominal", False, False, False, True, True, False),
        ("spanner-oven-unreachable-rack-nominal", False, False, False, True, False, True),
    ]
    if robot_spec.slug == "fairino-fr10":
        variants.append(("spanner-oven-door-nominal", False, True, True, False, False, False))
    home_q = spanner_home_q(robot_spec.slug)
    for (
        stem,
        blocked,
        door_closed,
        articulated_door,
        include_rack,
        rack_blocked,
        rack_unreachable,
    ) in variants:
        spec = compose_spanner_oven_cell(
            blocked=blocked,
            door_closed=door_closed,
            articulated_door=articulated_door,
            include_rack=include_rack,
            rack_blocked=rack_blocked,
            rack_unreachable=rack_unreachable,
            robot_spec=robot_spec,
        )
        original = spec.compile()
        xml = ET.fromstring(spec.to_xml())
        strip_visual_meshes(xml, original)
        used_meshes = {geom.get("mesh") for geom in xml.iter("geom")}
        asset = xml.find("asset")
        if asset is not None:
            for item in list(asset):
                if item.tag == "mesh" and item.get("name") not in used_meshes:
                    asset.remove(item)
                elif item.tag in ("material", "texture"):
                    asset.remove(item)
        for geom in xml.iter("geom"):
            geom.attrib.pop("material", None)
        for mesh in xml.findall("./asset/mesh"):
            source = mesh.get("file")
            if source is None:
                continue
            base = (
                ASSETS / robot_spec.slug
                if mesh.get("name", "").startswith(robot_spec.slug + "__")
                else MBCO4_DIR
            )
            path = Path(os.path.normpath(base / source))
            dependencies.add(path)
            mesh.set("file", os.path.relpath(path, destination))
            mesh.set(
                "content_type",
                "model/stl" if path.suffix.lower() == ".stl" else "model/obj",
            )
        for element in xml.iter():
            attributes = sorted(element.attrib.items())
            element.attrib.clear()
            element.attrib.update(attributes)
        xml_path = destination / f"{stem}.xml"
        ET.indent(xml)
        xml_path.write_text(ET.tostring(xml, encoding="unicode") + "\n")
        model = mujoco.MjModel.from_xml_path(str(xml_path))
        for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
            if not np.allclose(
                getattr(original, field), getattr(model, field), rtol=1e-10, atol=1e-12
            ):
                raise RuntimeError(
                    f"Spanner oven export changed {field}: {robot_spec.slug}/{stem}"
                )
        data = mujoco.MjData(model)
        mujoco.mj_resetData(model, data)
        data.qpos[arm_addresses(model)[0]] = home_q
        data.joint("clamp_opening").qpos[0] = SPANNER_OPEN_M
        mujoco.mj_forward(model, data)
        center = data.site("source_tray_center").xpos
        data.joint("mbco_tray_free").qpos[:] = (*center, *SPANNER_TRAY_QUAT)
        mujoco.mj_forward(model, data)
        signature = mujoco.mjtState.mjSTATE_INTEGRATION
        state = np.empty(mujoco.mj_stateSize(model, signature))
        mujoco.mj_getState(model, data, state, signature)
        base = data.body(f"{robot_spec.slug}__base_link")
        setup_path = destination / f"{stem}.json"
        write_json(
            setup_path,
            {
                "initialState": state.tolist(),
                "robotBase": pose(base.xpos, base.xquat),
                "fixture": fixture_snapshot(
                    {
                        "bakeryTaskId": BakeryTask.OVEN,
                        "spanner": True,
                        "combined": include_rack,
                    },
                    model,
                    data,
                ),
                "geometry": geometry_snapshot(model, data),
            },
        )
        dependencies.update((xml_path, setup_path))


def build() -> None:
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Asset serialization is pinned to MuJoCo 4.0.0.")
    library = next(Path(mujoco.__file__).parent.glob("libmujoco.*"))
    native = ctypes.CDLL(str(library))
    # The MuJoCo 4.0.0 XML writer defaults to six digits. Its exported test hook
    # preserves full doubles here; this hook is never used by the native runner.
    native._mjPRIVATE__set_xml_precision.argtypes = [ctypes.c_int]
    native._mjPRIVATE__set_xml_precision.restype = None
    native._mjPRIVATE__set_xml_precision(17)
    OUTPUT.mkdir(exist_ok=True)
    dependencies = set()
    for robot_spec in ROBOTS:
        destination = OUTPUT / robot_spec.slug
        destination.mkdir(exist_ok=True)
        dependencies.add(ASSETS / robot_spec.slug / "robot.glb")
        for task, cell in (
            (BakeryTask.RACK, "separate"),
            (BakeryTask.OVEN, "separate"),
            (BakeryTask.OVEN, "combined"),
            (BakeryTask.OVEN, "combined-blocked-rack"),
            (BakeryTask.OVEN, "combined-unreachable-rack"),
            (BakeryTask.RACK, "pan-staging"),
        ):
            if cell == "pan-staging" and robot_spec.slug != "fairino-fr10":
                continue
            combined = cell.startswith("combined")
            cases = ["nominal", "blocked", "unreachable"]
            if task == BakeryTask.OVEN:
                cases.append("closed-door")
            if cell in ("combined-blocked-rack", "combined-unreachable-rack"):
                cases = ["nominal"]
            for case in cases:
                spec = compose_cell(
                    case == "blocked", task, case == "closed-door", combined, robot_spec
                )
                if cell == "pan-staging":
                    add_receiving_pan(spec)
                if case == "unreachable":
                    spec.body(
                        "cell_rack" if task == BakeryTask.RACK else "mbco_oven"
                    ).pos[0] = 8
                if cell == "combined-blocked-rack":
                    spec.body("cell_rack").add_geom(
                        name="destination_obstruction",
                        type=mujoco.mjtGeom.mjGEOM_BOX,
                        pos=[0, 0, spec.site("rack_tray_center").pos[2] + 0.039],
                        size=[0.26, 0.17, 0.04],
                        rgba=[0.8, 0.15, 0.1, 1],
                    )
                elif cell == "combined-unreachable-rack":
                    spec.body("cell_rack").pos[0] = 8
                original = spec.compile()
                xml = ET.fromstring(spec.to_xml())
                strip_visual_meshes(xml, original)
                used_meshes = {geom.get("mesh") for geom in xml.iter("geom")}
                asset = xml.find("asset")
                for mesh in list(asset.findall("mesh")):
                    if mesh.get("name") not in used_meshes:
                        asset.remove(mesh)
                for mesh in xml.findall("./asset/mesh"):
                    source = mesh.get("file")
                    if source is None:
                        continue
                    base = (
                        ASSETS / robot_spec.slug
                        if mesh.get("name", "").startswith(robot_spec.slug + "__")
                        else TRAY.parent
                    )
                    path = Path(os.path.normpath(base / source))
                    dependencies.add(path)
                    mesh.set("file", os.path.relpath(path, destination))
                    mesh.set(
                        "content_type",
                        "model/stl" if path.suffix.lower() == ".stl" else "model/obj",
                    )
                stem = f"{task}-{case}" if cell == "separate" else f"{cell}-{case}"
                for element in xml.iter():
                    attributes = sorted(element.attrib.items())
                    element.attrib.clear()
                    element.attrib.update(attributes)
                xml_path = destination / f"{stem}.xml"
                ET.indent(xml)
                xml_path.write_text(ET.tostring(xml, encoding="unicode") + "\n")
                # Initialize the serialized model itself so the saved state has exactly its layout.
                model = mujoco.MjModel.from_xml_path(str(xml_path))
                for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
                    if not np.allclose(
                        getattr(original, field), getattr(model, field),
                        rtol=1e-10, atol=1e-12,
                    ):
                        raise RuntimeError(
                            f"Workcell export changed {field}: {robot_spec.slug}"
                        )
                data = mujoco.MjData(model)
                try:
                    initialize_pose(model, data, "source")
                except ValueError:
                    # Preserve a valid home state when the common source is unreachable.
                    # The shared Rust planner records the failed approach during execution.
                    mujoco.mj_resetData(model, data)
                    data.qpos[arm_addresses(model)[0]] = robot_spec.home
                    data.joint("clamp_opening").qpos[0] = 0.035
                    mujoco.mj_forward(model, data)
                    center = data.site("source_tray_center").xpos
                    data.joint("mbco_tray_free").qpos[:] = (*center, *TRAY_QUATERNION)
                    mujoco.mj_forward(model, data)
                signature = mujoco.mjtState.mjSTATE_INTEGRATION
                state = np.empty(mujoco.mj_stateSize(model, signature))
                mujoco.mj_getState(model, data, state, signature)
                base = data.body(
                    robot_spec.slug + "__base_link"
                    if robot_spec.slug != "ufactory-xarm6"
                    else "ufactory-xarm6__link_base"
                )
                setup_path = destination / f"{stem}.json"
                write_json(
                    setup_path,
                    {
                        "initialState": state.tolist(),
                        "robotBase": pose(base.xpos, base.xquat),
                        "fixture": fixture_snapshot(
                            {"bakeryTaskId": task, "combined": combined}, model, data
                        ),
                        "geometry": geometry_snapshot(model, data),
                    },
                )
                dependencies.update((xml_path, setup_path))
    export_pour_over(OUTPUT / "fairino-fr10", dependencies)
    for robot_spec in SPANNER_ROBOTS:
        export_spanner_oven(robot_spec, OUTPUT / robot_spec.slug, dependencies)
    dependencies.add(TRAY.parent / "maruzen-mbco-5e.glb")
    dependencies.add(MBCO4_GLB)
    linea_glb = (
        ROOT
        / "assets/bakery-mujoco/la-marzocco-linea-classic-s-2g/la-marzocco-linea-classic-s-2g.glb"
    )
    dependencies.add(linea_glb)
    eagle_glb = ROOT / "assets/bakery-mujoco/victoria-arduino-eagle-one-2g/victoria-arduino-eagle-one-2g.glb"
    dependencies.add(eagle_glb)
    files = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(dependencies)
    }
    files.update(export())
    write_json(OUTPUT / "assets.json", dict(sorted(files.items())))
    # Keep browser identity checks bound to this exact generated asset set.
    contract = ROOT / "packages/bakery-model/src/bakery-physics.ts"
    text = contract.read_text()
    for name, path in (
        ("PHYSICS_ASSETS_SHA256", OUTPUT / "assets.json"),
        ("MARUZEN_GLB_SHA256", TRAY.parent / "maruzen-mbco-5e.glb"),
        ("LINEA_GLB_SHA256", linea_glb),
        ("EAGLE_GLB_SHA256", eagle_glb),
    ):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        text, count = re.subn(
            rf'(export const {name} =\s*)"[a-f0-9]{{64}}"',
            rf'\g<1>"{digest}"',
            text,
        )
        if count != 1:
            raise RuntimeError(f"Missing browser asset identity: {name}")
    contract.write_text(text)


if __name__ == "__main__":
    build()
