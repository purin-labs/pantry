"""Shared MuJoCo 4.0 MJCF physics, native-export, standalone-model, and frame-verification helpers."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[2]
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

# Standardized semi-transparent RGBA palette for collision geoms (group 3) and sites (group 4).
COL_BASE_RGBA = "0.20 0.75 0.35 0.45"
COL_WALL_RGBA = "0.25 0.55 0.90 0.45"
COL_ARTIC_RGBA = "0.95 0.55 0.15 0.50"
COL_ACCESSORY_RGBA = "0.90 0.80 0.15 0.50"
SITE_SUPPORT_RGBA = "0.15 0.80 0.85 0.35"
SITE_GRASP_RGBA = "0.95 0.25 0.25 0.40"


def numbers(values: Iterable[float]) -> str:
    return " ".join(f"{value:.9g}" for value in values)


Y_AXIS_QUAT = numbers((math.cos(math.pi / 4.0), math.sin(math.pi / 4.0), 0.0, 0.0))
X_AXIS_QUAT = numbers((math.cos(math.pi / 4.0), 0.0, math.sin(math.pi / 4.0), 0.0))


def z_rot_quat(angle_rad: float) -> tuple[float, float, float, float]:
    return (math.cos(angle_rad / 2.0), 0.0, 0.0, math.sin(angle_rad / 2.0))


def write_xml(path: Path, element: ET.Element) -> None:
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def add_standard_defaults(
    app: ET.Element,
    *,
    friction: str = "0.60 0.015 0.003",
    solref: str = "0.004 1",
    solimp: str = "0.95 0.99 0.001",
    condim: str = "4",
) -> ET.Element:
    """Attach a MuJoCo <default><geom .../> block meeting 4.0 stability & friction standards."""
    defaults = ET.SubElement(app, "default")
    ET.SubElement(
        defaults,
        "geom",
        condim=condim,
        friction=friction,
        solref=solref,
        solimp=solimp,
    )
    return defaults


def add_adjacent_excludes(
    app: ET.Element,
    pairs: Sequence[tuple[str, str, str]],
) -> ET.Element:
    """Add <contact><exclude> pairs between adjacent or nested articulated bodies."""
    contact = app.find("contact")
    if contact is None:
        contact = ET.SubElement(app, "contact")
    for ex_name, body1, body2 in pairs:
        ET.SubElement(contact, "exclude", name=ex_name, body1=body1, body2=body2)
    return contact


def prepare_blender_assembly(
    source_blend: Path,
    names: Sequence[str],
    assets_dir: Path,
    *,
    clear_all_animations: bool = True,
    default_roughness: float = 0.30,
    clean_stale_meshes: bool = True,
):
    """Open a .blend asset, reparent meshes to named articulated bodies, and export visual OBJ+XML."""
    import bpy

    script_dir = str(Path(__file__).resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    from build_oven_visuals import export_visual_meshes

    bpy.ops.wm.open_mainfile(filepath=str(source_blend))
    bpy.context.scene.frame_set(1)
    if clear_all_animations:
        for obj in list(bpy.data.objects):
            obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in names]
    if not clear_all_animations:
        for root in parts:
            root.animation_data_clear()
            for child in root.children_recursive:
                child.animation_data_clear()
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()

    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every descendant mesh under each named root to its nearest ancestor in `parts`.
    visited = set()
    for root in parts:
        for obj in list(root.children_recursive):
            if obj in visited or obj.type != "MESH":
                continue
            visited.add(obj)
            parent = obj.parent
            while parent is not None and parent not in parts:
                parent = parent.parent
            if parent is None:
                continue
            pose = obj.matrix_world.copy()
            obj.animation_data_clear()
            obj.parent = parent
            obj.matrix_world = pose
            if len(obj.data.vertices) >= 3:
                xs = [v.co.x for v in obj.data.vertices]
                ys = [v.co.y for v in obj.data.vertices]
                zs = [v.co.z for v in obj.data.vertices]
                changed = False
                if max(xs) - min(xs) < 1e-5:
                    obj.data.vertices[0].co.x += 2e-5
                    changed = True
                if max(ys) - min(ys) < 1e-5:
                    obj.data.vertices[0].co.y += 2e-5
                    changed = True
                if max(zs) - min(zs) < 1e-5:
                    obj.data.vertices[0].co.z += 2e-5
                    changed = True
                if changed:
                    obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        bsdf = (
            mat.node_tree.nodes.get("Principled BSDF")
            if (mat.use_nodes and mat.node_tree)
            else None
        )
        if "metallic" not in mat:
            mat["metallic"] = (
                float(bsdf.inputs["Metallic"].default_value)
                if bsdf and "Metallic" in bsdf.inputs
                else 0.0
            )
        if "roughness" not in mat:
            mat["roughness"] = (
                float(bsdf.inputs["Roughness"].default_value)
                if bsdf and "Roughness" in bsdf.inputs
                else default_roughness
            )
        if "emission" not in mat:
            mat["emission"] = (
                float(bsdf.inputs["Emission Strength"].default_value)
                if bsdf and "Emission Strength" in bsdf.inputs
                else 0.0
            )

    mesh_dir = assets_dir / "meshes"
    if clean_stale_meshes and mesh_dir.is_dir():
        for stale_obj in mesh_dir.glob("*.obj"):
            stale_obj.unlink()
    export_visual_meshes(parts, assets_dir)
    return parts, poses


def emit_standalone_models(
    assets_dir: Path,
    *,
    model_name: str,
    defaults: ET.Element,
    asset: ET.Element,
    root_body: ET.Element,
    contact: ET.Element | None = None,
    sensors: ET.Element | None = None,
    exclude_sensors: Iterable[str] = (),
    accessories: Sequence[tuple[str, str, ET.Element]] = (),
) -> None:
    """Emit MjSpec.attach-ready model.xml (pure appliance, no floor/actuators) and accessory models."""
    excluded = set(exclude_sensors)

    standalone = ET.Element("mujoco", model=model_name)
    ET.SubElement(standalone, "compiler", angle="radian")
    standalone.append(copy.deepcopy(defaults))
    standalone.append(copy.deepcopy(asset))
    s_world = ET.SubElement(standalone, "worldbody")
    s_world.append(copy.deepcopy(root_body))
    if contact is not None and len(contact) > 0:
        standalone.append(copy.deepcopy(contact))
    if sensors is not None:
        kept = [
            copy.deepcopy(sensor_el)
            for sensor_el in sensors
            if sensor_el.get("name") not in excluded
        ]
        if kept:
            s_sensors = ET.SubElement(standalone, "sensor")
            for sensor_el in kept:
                s_sensors.append(sensor_el)
    write_xml(assets_dir / "model.xml", standalone)

    for filename, acc_model_name, acc_body in accessories:
        acc = ET.Element("mujoco", model=acc_model_name)
        ET.SubElement(acc, "compiler", angle="radian")
        acc.append(copy.deepcopy(defaults))
        acc.append(copy.deepcopy(asset))
        acc_world = ET.SubElement(acc, "worldbody")
        acc_copy = copy.deepcopy(acc_body)
        acc_copy.set("pos", "0 0 0")
        acc_copy.set("quat", "1 0 0 0")
        for child in list(acc_copy):
            if child.tag == "freejoint":
                acc_copy.remove(child)
        acc_world.append(acc_copy)
        write_xml(assets_dir / filename, acc)


def strip_visual_meshes(root: ET.Element, model) -> None:
    """Remove zero-mass non-colliding visual mesh geoms before writing native.xml."""
    for parent in root.iter():
        for geom in list(parent):
            if geom.tag != "geom" or not geom.get("name"):
                continue
            index = model.geom(geom.get("name")).id
            if (
                model.geom_contype[index] == 0
                and model.geom_conaffinity[index] == 0
                and geom.get("type") == "mesh"
                and geom.get("mass") == "0"
            ):
                parent.remove(geom)


def prune_unused_assets(root: ET.Element) -> None:
    """Drop meshes, materials, and textures no longer referenced by any remaining geom."""
    used_meshes = {geom.get("mesh") for geom in root.iter("geom")}
    used_materials = {geom.get("material") for geom in root.iter("geom")}
    assets = root.find("asset")
    if assets is None:
        return
    used_textures: set[str] = set()
    for item in list(assets):
        if item.tag == "material" and item.get("name") in used_materials:
            if item.get("texture"):
                used_textures.add(item.get("texture"))
            for layer in item.findall("layer"):
                if layer.get("texture"):
                    used_textures.add(layer.get("texture"))
    for item in list(assets):
        if (
            (item.tag == "mesh" and item.get("name") not in used_meshes)
            or (item.tag == "material" and item.get("name") not in used_materials)
            or (item.tag == "texture" and item.get("name") not in used_textures)
        ):
            assets.remove(item)


def export_and_verify_native_xml(
    assets_dir: Path,
    appliance_name: str,
    mujoco,
    np,
    *,
    scene_file: str = "scene.xml",
    spec=None,
    strip_general_input: bool = True,
):
    """Strip visual meshes/materials/textures, write native.xml, and assert dynamics parity."""
    if spec is None:
        spec = mujoco.MjSpec.from_file(str(assets_dir / scene_file))
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    root = ET.fromstring(spec.to_xml())
    strip_visual_meshes(root, model)
    prune_unused_assets(root)
    if strip_general_input:
        for actuator in root.iter("general"):
            actuator.attrib.pop("input", None)
    ET.indent(root, space="  ")
    native_path = assets_dir / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(
            getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9
        ):
            raise RuntimeError(f"Export changed native {field} for {appliance_name}")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError(
            f"Export changed native DOFs for {appliance_name}: "
            f"{(rebuilt.nq, rebuilt.nv)} vs {(model.nq, model.nv)}"
        )
    return model, rebuilt


def verify_frames_and_motions(
    assets_dir: Path,
    appliance_name: str,
    names: Sequence[str],
    visual_motions: Mapping[str, Sequence[float]],
    mujoco,
    evidence_dir: Path,
    *,
    glb_name: str | None = None,
    cleanup_inputs: bool = False,
) -> tuple[dict, dict]:
    """Verify GLB vs native.xml rest poses and 21-sample scalar joint trajectories."""
    native_path = assets_dir / "native.xml"
    glb_path = assets_dir / (glb_name or f"{appliance_name}.glb")
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    native_model = mujoco.MjModel.from_xml_path(str(native_path))
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)

    body_poses = {}
    for bname in names:
        bid = native_model.body(bname).id
        pos = native_data.xpos[bid]
        quat = native_data.xquat[bid]
        body_poses[bname] = [
            float(pos[0]),
            float(pos[1]),
            float(pos[2]),
            float(quat[0]),
            float(quat[1]),
            float(quat[2]),
            float(quat[3]),
        ]

    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                appliance_name: {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "bodies": body_poses,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(frames_in),
            str(frames_out),
        ],
        check=True,
    )
    if cleanup_inputs:
        frames_in.unlink(missing_ok=True)
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    motions = []
    for joint_name, visual_axis in visual_motions.items():
        jid = native_model.joint(joint_name).id
        jtype = int(native_model.jnt_type[jid])
        kind = "hinge" if jtype == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        if native_model.jnt_limited[jid]:
            low, high = native_model.jnt_range[jid]
        else:
            low, high = -math.pi, math.pi
        bid = int(native_model.jnt_bodyid[jid])
        samples = []
        for idx in range(21):
            val = float(low + (high - low) * idx / 20.0)
            mujoco.mj_resetData(native_model, native_data)
            native_data.qpos[native_model.jnt_qposadr[jid]] = val
            mujoco.mj_forward(native_model, native_data)
            samples.append(
                {
                    "value": val,
                    "pose": [
                        *native_data.xpos[bid].tolist(),
                        *native_data.xquat[bid].tolist(),
                    ],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": list(visual_axis),
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                appliance_name: {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "motions": motions,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(motion_in),
            str(motion_out),
            "--motion",
        ],
        check=True,
    )
    if cleanup_inputs:
        motion_in.unlink(missing_ok=True)
    motion_report = json.loads(motion_out.read_text())
    assert motion_report["passed"] is True, motion_report
    return frames_report, motion_report
