"""Generate articulated Blender/glTF and MuJoCo assets from local vendor CAD."""

import argparse
import json
import math
import xml.etree.ElementTree as ET
from operator import attrgetter

import bpy
import numpy as np
from mathutils import Euler, Quaternion, Vector
from prepare import (
    ASSETS,
    FAIRINO_DH,
    FANUC_NOTICE,
    ROBOTS,
    SERVO_KP,
    SERVO_KV,
    RobotSpec,
    prepare,
    source_exclusions,
    source_robot,
    write_xml,
)


def numbers(value: str) -> tuple[float, ...]:
    return tuple(float(part) for part in value.split())


def vector_text(values) -> str:
    return " ".join(format(float(value), ".12g") for value in values)


def origin(element: ET.Element) -> tuple[tuple[float, ...], Quaternion]:
    source = element.find("origin")
    if source is None:
        return (0, 0, 0), Quaternion()
    position = numbers(source.get("xyz", "0 0 0"))
    rotation = Euler(numbers(source.get("rpy", "0 0 0")), "XYZ").to_quaternion()
    return position, rotation


def name(spec: RobotSpec, label: str) -> str:
    return f"{spec.slug}__{label}"


def empty(label: str, parent: bpy.types.Object | None) -> bpy.types.Object:
    obj = bpy.data.objects.new(label, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.04
    obj.rotation_mode = "QUATERNION"
    return obj


def material(label: str, rgba: tuple[float, ...]) -> bpy.types.Material:
    value = bpy.data.materials.new(label)
    value.diffuse_color = rgba
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Metallic"].default_value = 0.18
    shader.inputs["Roughness"].default_value = 0.4
    return value


def visual_color(visual: ET.Element, robot: ET.Element) -> tuple[float, ...]:
    source = visual.find("material/color")
    if source is None:
        reference = visual.find("material")
        if reference is not None:
            source = robot.find(f"material[@name='{reference.get('name')}']/color")
    if source is None:
        return (0.8, 0.82, 0.83, 1)
    return numbers(source.attrib["rgba"])


def import_link(
    spec: RobotSpec, robot: ET.Element, link: ET.Element, parent: bpy.types.Object
) -> int:
    visual = link.find("visual")
    if visual is None:
        return 0
    source = visual.find("geometry/mesh")
    path = ASSETS / spec.slug / source.attrib["filename"]
    if path.suffix == ".dae":
        before = set(bpy.data.objects)
        bpy.ops.wm.collada_import(filepath=str(path), import_units=True)
        imported = sorted(set(bpy.data.objects) - before, key=attrgetter("name"))
        if not imported or any(obj.type != "MESH" for obj in imported):
            raise ValueError(f"Expected CAD mesh objects in {path}")
        # Bake every source part into the same URDF link frame before joining.
        bpy.ops.object.select_all(action="DESELECT")
        for part in imported:
            part.data.transform(part.matrix_world)
            part.matrix_world.identity()
            part.select_set(True)
        bpy.context.view_layer.objects.active = imported[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        for mat in obj.data.materials:
            color = tuple(mat.diffuse_color)
            shader = mat.node_tree.nodes.get("Principled BSDF")
            if spec.source_name == "crx10ia_l" and (
                color[1] > color[0] * 1.3 or min(color[:3]) > 0.9
            ):
                color = (0.87, 0.89, 0.88, 1)
            mat.diffuse_color = color
            shader.inputs["Base Color"].default_value = color
            shader.inputs["Metallic"].default_value = 0.0
            shader.inputs["Roughness"].default_value = 0.28
            if link.attrib["name"] == "J6_link":
                shader.inputs["Metallic"].default_value = 0.75
                shader.inputs["Roughness"].default_value = 0.3
        export_visual_parts(spec, link.attrib["name"], obj)
    else:
        bpy.ops.wm.stl_import(
            filepath=str(path), forward_axis="Y", up_axis="Z", use_facet_normal=False
        )
        obj = bpy.context.object
        obj.data.materials.append(
            material(
                name(spec, link.attrib["name"] + "__finish"),
                visual_color(visual, robot),
            )
        )
    obj.name = name(spec, link.attrib["name"] + "__cad")
    obj.parent = parent
    obj.rotation_mode = "QUATERNION"
    obj.location, obj.rotation_quaternion = origin(visual)
    obj.scale = numbers(source.get("scale", "1 1 1"))
    obj.data.set_sharp_from_angle(angle=math.radians(35))
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj["source_mesh"] = source.attrib["filename"]
    obj["geometry_quality"] = "manufacturer CAD; no decimation"
    inertial = link.find("inertial")
    parent["source_mass_kg"] = float(inertial.find("mass").attrib["value"])
    parent["urdf_center_of_mass_m"] = numbers(inertial.find("origin").attrib["xyz"])
    for key, value in inertial.find("inertia").attrib.items():
        parent[f"urdf_{key}_kg_m2"] = float(value)
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def export_visual_parts(spec: RobotSpec, label: str, obj: bpy.types.Object) -> None:
    """Bake CAD material regions to OBJ for MuJoCo visual geometry."""
    directory = ASSETS / spec.slug / "meshes"
    directory.mkdir(exist_ok=True)
    obj.data.calc_loop_triangles()
    vertices = [f"v {vector_text(vertex.co)}" for vertex in obj.data.vertices]
    for index in range(len(obj.data.materials)):
        faces = [
            "f " + " ".join(str(vertex + 1) for vertex in triangle.vertices)
            for triangle in obj.data.loop_triangles
            if triangle.material_index == index
        ]
        (directory / f"{label}__{index}.obj").write_text(
            "# Derived manufacturer CAD; see ../README.md for source and license\n"
            + "\n".join(vertices + faces)
            + "\n"
        )


def animate(
    spec: RobotSpec, robot: ET.Element, pivots: dict[str, bpy.types.Object]
) -> None:
    offsets = (0.3, 0.12, -0.15, 0.2, 0.12, 0.4)
    for index, joint in enumerate(robot.findall("joint[@type='revolute']")):
        pivot = pivots[joint.attrib["name"]]
        axis = Vector(numbers(joint.find("axis").attrib["xyz"]))
        for frame, fraction in ((1, 0), (61, 1), (121, 0)):
            angle = spec.home[index] + offsets[index] * fraction
            pivot.rotation_quaternion = Quaternion(axis, angle)
            pivot.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        pivot.animation_data.action.name = "Inspection"
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 121
    bpy.context.scene.render.fps = 30
    bpy.context.scene.frame_set(1)


def make_blender(spec: RobotSpec, robot: ET.Element) -> tuple[bpy.types.Object, int]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = "Inspection"
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1
    root = empty(spec.slug, None)
    root["model"] = spec.title
    root["source_revision"] = spec.revision
    if spec.source_name == "crx10ia_l":
        root["copyright"] = FANUC_NOTICE
    root["physics_status"] = (
        "prepared inertials; see fidelity.json for corrections and unverified hardware dynamics"
    )
    links = {link.attrib["name"]: link for link in robot.findall("link")}
    children = {joint.find("child").attrib["link"] for joint in robot.findall("joint")}
    base = next(label for label in links if label not in children)
    nodes = {base: empty(name(spec, base), root)}
    pivots = {}
    for joint in robot.findall("joint"):
        label = joint.attrib["name"]
        parent = nodes[joint.find("parent").attrib["link"]]
        frame = empty(name(spec, label + "__frame"), parent)
        frame.location, frame.rotation_quaternion = origin(joint)
        pivot = empty(name(spec, label), frame)
        pivot["joint_name"] = label
        pivot["joint_kind"] = joint.attrib["type"]
        if joint.attrib["type"] == "revolute":
            pivot["lower_rad"] = float(joint.find("limit").attrib["lower"])
            pivot["upper_rad"] = float(joint.find("limit").attrib["upper"])
        child = joint.find("child").attrib["link"]
        nodes[child] = empty(name(spec, child), pivot)
        pivots[label] = pivot
    triangle_count = 0
    for label, link in links.items():
        triangle_count += import_link(spec, robot, link, nodes[label])
    last_link = (
        robot.findall("joint[@type='revolute']")[-1].find("child").attrib["link"]
    )
    mount = empty(name(spec, "end_link_frame"), nodes[last_link])
    mount["frame_basis"] = "source last-link origin; physical flange offset unverified"
    animate(spec, robot, pivots)
    bpy.context.view_layer.update()
    return root, triangle_count


def add_inertial(body: ET.Element, link: ET.Element) -> None:
    source = link.find("inertial")
    if source is None:
        return
    position, _ = origin(source)
    values = source.find("inertia").attrib
    tensor = np.array(
        (
            (float(values["ixx"]), float(values["ixy"]), float(values["ixz"])),
            (float(values["ixy"]), float(values["iyy"]), float(values["iyz"])),
            (float(values["ixz"]), float(values["iyz"]), float(values["izz"])),
        )
    )
    # Use double-precision Euler matrices for the source inertial frame.
    roll, pitch, yaw = numbers(source.find("origin").get("rpy", "0 0 0"))
    cr, cp, cy = np.cos((roll, pitch, yaw))
    sr, sp, sy = np.sin((roll, pitch, yaw))
    axes = np.array(
        (
            (cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr),
            (sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr),
            (-sp, cp * sr, cp * cr),
        )
    )
    tensor = axes @ tensor @ axes.T
    packed = vector_text(
        (
            tensor[0, 0],
            tensor[1, 1],
            tensor[2, 2],
            tensor[0, 1],
            tensor[0, 2],
            tensor[1, 2],
        )
    )
    ET.SubElement(
        body,
        "inertial",
        pos=vector_text(position),
        mass=source.find("mass").attrib["value"],
        fullinertia=packed,
    )


def make_mujoco(spec: RobotSpec, robot: ET.Element) -> None:
    root = ET.Element("mujoco", model=spec.slug)
    if spec.source_name == "crx10ia_l":
        root.append(ET.Comment(FANUC_NOTICE))
    root.append(
        ET.Comment(
            "Manufacturer CAD and joint frames; FAIRINO inertials have a documented DH-to-link correction. Mesh contacts use convex hulls. See ../README.md; no hardware control."
        )
    )
    ET.SubElement(
        root, "compiler", angle="radian", autolimits="true", balanceinertia="false"
    )
    assets = ET.SubElement(root, "asset")
    world = ET.SubElement(root, "worldbody")
    joints = robot.findall("joint")
    joint_by_child = {joint.find("child").attrib["link"]: joint for joint in joints}
    bodies = {}
    for link in robot.findall("link"):
        label = link.attrib["name"]
        joint = joint_by_child.get(label)
        if joint is None:
            parent = world
            position, rotation = (0, 0, 0), Quaternion()
        else:
            parent = bodies[joint.find("parent").attrib["link"]]
            position, rotation = origin(joint)
        body = ET.SubElement(
            parent,
            "body",
            name=name(spec, label),
            pos=vector_text(position),
            quat=vector_text(rotation),
        )
        bodies[label] = body
        add_inertial(body, link)
        if joint is not None and joint.attrib["type"] == "revolute":
            limits = joint.find("limit").attrib
            ET.SubElement(
                body,
                "joint",
                name=name(spec, joint.attrib["name"]),
                type="hinge",
                axis=joint.find("axis").attrib["xyz"],
                range=f"{limits['lower']} {limits['upper']}",
            )
        for kind in ("visual", "collision"):
            element = link.find(kind)
            if element is None:
                continue
            mesh = element.find("geometry/mesh")
            if kind == "visual" and mesh.attrib["filename"].endswith(".dae"):
                node = bpy.data.objects[name(spec, label + "__cad")]
                position, rotation = origin(element)
                for index, mat in enumerate(node.data.materials):
                    mesh_name = name(spec, f"{label}__visual__{index}")
                    ET.SubElement(
                        assets,
                        "mesh",
                        name=mesh_name,
                        file=f"meshes/{label}__{index}.obj",
                    )
                    ET.SubElement(
                        body,
                        "geom",
                        name=mesh_name,
                        type="mesh",
                        mesh=mesh_name,
                        pos=vector_text(position),
                        quat=vector_text(rotation),
                        contype="0",
                        conaffinity="0",
                        group="1",
                        mass="0",
                        rgba=vector_text(mat.diffuse_color),
                    )
                continue
            mesh_name = name(spec, label + "__" + kind)
            ET.SubElement(
                assets,
                "mesh",
                name=mesh_name,
                file=mesh.attrib["filename"],
                scale=mesh.get("scale", "1 1 1"),
            )
            position, rotation = origin(element)
            attributes = {
                "name": mesh_name,
                "type": "mesh",
                "mesh": mesh_name,
                "pos": vector_text(position),
                "quat": vector_text(rotation),
            }
            if kind == "visual":
                attributes.update(
                    contype="0",
                    conaffinity="0",
                    group="1",
                    rgba=vector_text(visual_color(element, robot)),
                    mass="0",
                )
            else:
                attributes.update(
                    group="3",
                    rgba="0.3 0.6 0.9 0",
                    friction="0.7 0.005 0.0001",
                    mass="0",
                )
            ET.SubElement(body, "geom", **attributes)
    moving_joints = robot.findall("joint[@type='revolute']")
    last_link = moving_joints[-1].find("child").attrib["link"]
    ET.SubElement(
        bodies[last_link],
        "site",
        name=name(spec, "end_link_frame"),
        size="0.008",
        rgba="0.9 0.4 0.1 0",
    )
    contacts = ET.SubElement(root, "contact")
    for frame in ("flange", "fanuc_flange", "tool0"):
        if frame in bodies:
            ET.SubElement(
                bodies[frame],
                "site",
                name=name(spec, frame),
                size="0.006",
                rgba="1 0.5 0 0",
            )
    for first, second in sorted(set(source_exclusions(spec))):
        if first in bodies and second in bodies:
            ET.SubElement(
                contacts, "exclude", body1=name(spec, first), body2=name(spec, second)
            )
    write_xml(root, ASSETS / spec.slug / "robot.xml")

    scene = ET.Element("mujoco", model=spec.slug + "-inspection")
    ET.SubElement(scene, "include", file="robot.xml")
    ET.SubElement(
        scene,
        "option",
        timestep="0.002",
        integrator="implicitfast",
        gravity="0 0 -9.81",
    )
    default = ET.SubElement(scene, "default")
    ET.SubElement(default, "joint", damping="1", armature="0.02")
    world = ET.SubElement(scene, "worldbody")
    ET.SubElement(world, "light", pos="1 -2 3", dir="-0.2 0.5 -1")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="2 2 0.1",
        pos="0 0 -0.005",
        rgba="0.83 0.85 0.82 1",
    )
    actuators = ET.SubElement(scene, "actuator")
    for index, joint in enumerate(moving_joints):
        effort = joint.find("limit").attrib["effort"]
        ET.SubElement(
            actuators,
            "position",
            name=name(spec, joint.attrib["name"] + "__servo"),
            joint=name(spec, joint.attrib["name"]),
            kp=str(SERVO_KP[index]),
            kv=str(SERVO_KV[index]),
            forcelimited="true",
            forcerange=f"-{effort} {effort}",
        )
    keys = ET.SubElement(scene, "keyframe")
    ET.SubElement(
        keys,
        "key",
        name="inspection",
        qpos=vector_text(spec.home),
        ctrl=vector_text(spec.home),
    )
    write_xml(scene, ASSETS / spec.slug / "scene.xml")


def inspect_source_geometry(spec: RobotSpec, robot: ET.Element) -> dict:
    meshes = []
    source_issues = []
    prepared_issues = []
    corrections = []
    source = source_robot(spec)
    for link in robot.findall("link"):
        label = link.attrib["name"]
        if link.find("visual") is None:
            continue
        node = bpy.data.objects[name(spec, label + "__cad")]
        points = [node.matrix_local @ vertex.co for vertex in node.data.vertices]
        lower = [min(point[axis] for point in points) for axis in range(3)]
        upper = [max(point[axis] for point in points) for axis in range(3)]
        original = source.find(f"link[@name='{label}']/inertial")
        prepared = link.find("inertial")
        source_center, _ = origin(original)
        center, _ = origin(prepared)
        meshes.append(
            {
                "node": node.name,
                "link_bounds_min_m": lower,
                "link_bounds_max_m": upper,
                "center_of_mass_m": center,
            }
        )
        for point, issues in (
            (source_center, source_issues),
            (center, prepared_issues),
        ):
            if any(
                point[axis] < lower[axis] - 0.001 or point[axis] > upper[axis] + 0.001
                for axis in range(3)
            ):
                issues.append(
                    {
                        "link": label,
                        "issue": "center of mass is outside supplied CAD bounding box",
                        "center_of_mass_m": point,
                    }
                )
        if original.find("origin").attrib != prepared.find("origin").attrib:
            corrections.append(
                {
                    "link": label,
                    "source_center_of_mass_m": source_center,
                    "prepared_center_of_mass_m": center,
                    "source_inertia_kg_m2": {
                        key: float(value)
                        for key, value in original.find("inertia").attrib.items()
                    },
                    "prepared_inertia_kg_m2": {
                        key: float(value)
                        for key, value in prepared.find("inertia").attrib.items()
                    },
                }
            )
    uncertainties = ["convex contacts and demonstration servos are uncalibrated"]
    if spec.source_name == "cr10":
        uncertainties.extend(
            [
                "Official RViz URDF supplies zero effort/velocity placeholders; prepared effort uses the sibling Gazebo 300 Nm simulation cap on all joints, not a measured hardware rating",
                "Source mass totals 24.7946 kg versus published 40 kg; resolve before physical calibration",
                "Speeds use the CR10 product specification: 120 deg/s on J1/J2 and 180 deg/s on J3-J6",
                "J3 is narrowed to the product specification +/-160 deg; other source angle limits remain conservative",
                "Flange alias uses the Link6 CAD end plane at z=0; detailed mounting drawing and bolt clocking remain unverified",
                "Source SRDF collision exclusions are retained; collision meshes use convex hulls",
                "Vendor package has an incomplete license declaration; local educational use only, redistribution permission unresolved",
            ]
        )
    if spec.source_name == "ur5e":
        uncertainties.extend(
            [
                "Nominal UR5e joint frames; serial-specific controller calibration is absent",
                "Source flags the 4 kg base mass as possibly incorrect; masses remain unchanged",
                "Source inertial tensors are rotated from their specified inertial frames into link frames",
                "The adjoining base/shoulder bearing pair is excluded from contact; source collision hulls overlap by 0.5 mm",
                "Source effort limits and assumed PD servos do not reproduce a calibrated UR controller",
            ]
        )
    if spec.source_name == "crx10ia_l":
        uncertainties.extend(
            [
                "Standard CRX-10iA/L CAD and dynamics with food-version appearance; exact food-version seals and inertias unverified",
                "J6 preserves source +/-225 degrees, supported by the 2026 food-series brochure. Earlier individual food sheet gives 380 degrees total; verify installed controller limits",
                "Source masses sum to 38.607 kg; catalogue nominal arm mass is 40 kg. Masses are preserved, not rescaled",
                "URDF effort and velocity limits are source inputs; physical controller, friction and motor performance uncalibrated",
                "Paint color, roughness and metal appearance are visual estimates; flange bolt clocking needs a detailed interface drawing",
            ]
        )
    if spec.source_name in FAIRINO_DH:
        uncertainties.append(
            "COM frame correction uses nominal manual DH data; inertia tensors are assumed to share those DH axes based on the upstream mass update; hardware confirmation required"
        )
        if spec.source_name == "fairino5_v6":
            uncertainties.append(
                "FR5 nominal a3=-395 mm, d4=102 mm, d6=100 mm; pinned ROS a3=-395.01 mm, d4=102.1 mm, wrist CAD end=99 mm; geometry and joint frames preserved"
            )
    return {
        "meshes": meshes,
        "source_issues": source_issues,
        "prepared_issues": prepared_issues,
        "inertial_corrections": corrections,
        "correction_reference": "../README.md#fairino-inertial-frame-correction"
        if corrections
        else None,
        "remaining_uncertainties": uncertainties,
    }


def write_metadata(spec: RobotSpec, robot: ET.Element, triangles: int) -> None:
    joints = []
    for joint in robot.findall("joint[@type='revolute']"):
        label = joint.attrib["name"]
        axis = numbers(joint.find("axis").attrib["xyz"])
        limits = joint.find("limit").attrib
        joints.append(
            {
                "name": label,
                "node": name(spec, label),
                "body": name(spec, joint.find("child").attrib["link"]),
                "axis_gltf": [axis[0], axis[2], -axis[1]],
                "limits_rad": [float(limits["lower"]), float(limits["upper"])],
                "source_effort_nm": float(limits["effort"]),
                "source_velocity_rad_s": float(limits["velocity"]),
            }
        )
    metadata = {
        "model": spec.title,
        "source_revision": spec.revision,
        "units": "metres, kilograms, seconds, radians",
        "blender_mujoco_up": "Z",
        "gltf_up": "Y",
        "physics_to_gltf_xyz": "[x, z, -y]",
        "geometry": "manufacturer CAD, full resolution, no decimation",
        "triangles": triangles,
        "rated_payload_kg": spec.payload_kg,
        "rated_reach_m": spec.reach_m,
        "home_rad": spec.home,
        "joint_order": joints,
        "end_link_frame": name(spec, "end_link_frame"),
        "flange_status": "source last-link frame only; physical flange-face offset needs verification",
        "animation": "Inspection",
        "animation_status": "visual articulation demonstration; no validated robot trajectory",
        "physics_status": "prepared inertials and per-model uncertainties recorded in fidelity.json; hardware dynamics unverified",
    }
    if spec.source_name == "crx10ia_l":
        metadata["flange_status"] = (
            "Both source flange frames preserved; physical mounting face and bolt clocking need verification"
        )
        metadata["flange_frames"] = [name(spec, "flange"), name(spec, "fanuc_flange")]
        metadata["food_version_status"] = (
            "appearance study using standard CRX-10iA/L geometry and dynamics"
        )
    if spec.source_name == "ur5e":
        metadata["flange_status"] = (
            "Official flange and tool0 frames preserved; workcell gripper attaches to tool0 with Z forward"
        )
        metadata["flange_frames"] = [name(spec, "flange"), name(spec, "tool0")]
    if spec.source_name == "cr10":
        metadata["flange_status"] = (
            "Provisional Link6 z=0 CAD end-plane alias; mounting drawing and bolt clocking unverified"
        )
        metadata["flange_frames"] = [name(spec, "flange")]
        metadata["effort_limit_status"] = (
            "300 Nm per joint from vendor Gazebo simulation; physical torque limits are unknown"
        )
    (ASSETS / spec.slug / "joints.json").write_text(
        json.dumps(metadata, indent=2) + "\n"
    )
    (ASSETS / spec.slug / "fidelity.json").write_text(
        json.dumps(inspect_source_geometry(spec, robot), indent=2) + "\n"
    )


def studio(root: bpy.types.Object, reach: float) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 950
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("Studio world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (
        0.82,
        0.85,
        0.88,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.25
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    points = [
        obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box
    ]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    target = (low + high) / 2
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, low.z - 0.004))
    floor = bpy.context.object
    floor.name = "Studio floor — excluded from GLB"
    floor.data.materials.append(material("Slate studio", (0.07, 0.095, 0.12, 1)))
    bpy.ops.object.camera_add(location=target + Vector((1.8, -2.6, 1.35)) * reach)
    camera = bpy.context.object
    camera.rotation_euler = (
        (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(high - low) * 1.65
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=target + Vector((1, -2, 3)) * reach)
    light = bpy.context.object
    light.data.energy = 600 * reach * reach
    light.data.shape = "DISK"
    light.data.size = 2 * reach
    light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_distance = (
                    camera.data.ortho_scale * 1.5
                )
                area.spaces.active.region_3d.view_location = target
                area.spaces.active.region_3d.view_rotation = (
                    camera.rotation_euler.to_quaternion()
                )


def generate(spec: RobotSpec, render: bool) -> None:
    robot = prepare(spec)
    root, triangles = make_blender(spec, robot)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
    destination = ASSETS / spec.slug
    bpy.ops.export_scene.gltf(
        filepath=str(destination / "robot.glb"),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_extras=True,
        export_animations=True,
        export_animation_mode="ACTIVE_ACTIONS",
        export_nla_strips_merged_animation_name="Inspection",
        export_force_sampling=True,
        export_frame_range=True,
        export_cameras=False,
        export_lights=False,
    )
    make_mujoco(spec, robot)
    write_metadata(spec, robot, triangles)
    studio(root, spec.reach_m)
    if spec.source_name == "crx10ia_l":
        bpy.context.scene.cycles.samples = 64
        bpy.context.scene.render.resolution_x = 1600
        bpy.context.scene.render.resolution_y = 1400
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(destination / "robot.blend"))
    if render:
        bpy.context.scene.render.filepath = str(destination / "preview.png")
        bpy.ops.render.render(write_still=True)
    print(f"{spec.title}: {triangles:,} CAD triangles")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--model", choices=[spec.slug for spec in ROBOTS])
    args = parser.parse_args()
    if bpy.app.version[:3] != (4, 5, 3):
        raise RuntimeError("Use the pinned Blender 4.5.3 runtime.")
    for spec in ROBOTS:
        if args.model is None or args.model == spec.slug:
            generate(spec, args.render)


if __name__ == "__main__":
    main()
