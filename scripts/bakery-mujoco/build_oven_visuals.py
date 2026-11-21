"""Build the photo-referenced Maruzen MBCO-5E asset in Blender 5.2.

Run with Blender --background --python this_file.py. Geometry is in metres,
Z-up, with the same body-local frames as oven.xml. Collision/inertia stay in
the hand-authored MJCF; this script produces only visual assets and previews.
"""

import argparse
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy
from mathutils import Vector

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/maruzen-mbco-5e"
REFERENCES = (
    Path(__file__).resolve().parents[2] / "docs/equipment/maruzen-mbco-5e/images"
)
DOOR_ORIGIN = (-0.442, -0.374, 0.381)
HANDLE_ORIGIN = (0.581, -0.034, -0.038)
# Estimated clearance, pending measured rack geometry.
RACK_UPRIGHT_OUTWARD_OFFSET = 0.008


def material(name, color, metallic=0.0, roughness=0.4, emission=0.0):
    surface = bpy.data.materials.new(name)
    surface.diffuse_color = color
    shader = surface.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Alpha"].default_value = color[3]
    if metallic < 0.5:
        shader.inputs["Specular IOR Level"].default_value = 0.2
    if emission:
        shader.inputs["Emission Color"].default_value = color
        shader.inputs["Emission Strength"].default_value = emission
    if color[3] < 1:
        surface.surface_render_method = "BLENDED"
    surface["metallic"] = metallic
    surface["roughness"] = roughness
    surface["emission"] = emission
    return surface


def materials():
    result = {
        "steel": material("brushed_stainless", (0.53, 0.56, 0.58, 1), 0.82, 0.30),
        "chrome": material("polished_trim", (0.67, 0.7, 0.73, 1), 0.92, 0.2),
        "lining": material("chamber_stainless", (0.48, 0.51, 0.54, 1), 0.78, 0.34),
        "ruby": material("ruby_enamel", (0.19, 0.0025, 0.010, 1), 0.08, 0.23),
        "mask": material("ceramic_black", (0.004, 0.006, 0.009, 1), 0.05, 0.25),
        "rubber": material("rubber_and_grip", (0.015, 0.018, 0.021, 1), 0.05, 0.5),
        "glass": material("smoked_glass", (0.17, 0.23, 0.25, 0.16), 0.0, 0.07),
        "white": material("panel_ink", (0.81, 0.83, 0.79, 1), 0.15, 0.5),
        "red": material("red_readout", (0.85, 0.018, 0.008, 1), emission=1.5),
        "green": material("green_readout", (0.48, 0.72, 0.025, 1), emission=1),
        "lamp": material("chamber_light", (1, 0.82, 0.48, 1), emission=2),
        "badge": material("blue_badge", (0.008, 0.045, 0.19, 1), 0.2, 0.3),
    }
    enamel = result["ruby"].node_tree.nodes["Principled BSDF"]
    enamel.inputs["Coat Weight"].default_value = 0.35
    enamel.inputs["Coat Roughness"].default_value = 0.19
    glass = result["glass"].node_tree.nodes["Principled BSDF"]
    glass.inputs["Base Color"].default_value = (0.78, 0.85, 0.88, 1)
    glass.inputs["Alpha"].default_value = 1
    glass.inputs["Transmission Weight"].default_value = 1
    glass.inputs["IOR"].default_value = 1.46
    # MuJoCo uses diffuse alpha; Blender/glTF use optical transmission instead.
    result["glass"]["optics_status"] = "Estimated clear double glazing with mild tint"
    return result


def empty(name, position, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = position
    obj.empty_display_size = 0.025
    return obj


def finish(obj, name, surface, parent, bevel=0.0):
    obj.name = name
    obj.data.materials.append(surface)
    obj.parent = parent
    if bevel:
        modifier = obj.modifiers.new("Machined edge radius", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    if obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        # Clamped bevels and revolved poles can leave coincident vertices.
        # Remove their collapsed faces before normals and GLB triangulation.
        modifier = obj.modifiers.new("Merge coincident surface vertices", "WELD")
        modifier.merge_threshold = 0.0000001
        modifier = obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
        modifier.keep_sharp = True
    return obj


def box(name, position, dimensions, surface, parent, bevel=0.001):
    bpy.ops.mesh.primitive_cube_add(size=1, location=position)
    obj = bpy.context.object
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, surface, parent, bevel)


def cylinder(name, position, radius, depth, surface, parent, axis="Z"):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=24, radius=radius, depth=depth, location=position
    )
    obj = bpy.context.object
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2
    return finish(obj, name, surface, parent, min(0.0008, depth / 4))


def tube(name, points, radius, surface, parent, cyclic=False, smooth=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    curve.use_fill_caps = True
    if smooth:
        curve.resolution_u = 12
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for point, coordinate in zip(spline.bezier_points, points):
            point.co = coordinate
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
    else:
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, coordinate in zip(spline.points, points):
            point.co = (*coordinate, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent)


def rounded_rectangle(width, height, radius, segments=8):
    points = []
    corners = (
        (width / 2 - radius, height / 2 - radius, 0),
        (-width / 2 + radius, height / 2 - radius, 90),
        (-width / 2 + radius, -height / 2 + radius, 180),
        (width / 2 - radius, -height / 2 + radius, 270),
    )
    for x, z, angle in corners:
        for step in range(segments + 1):
            radians = math.radians(angle + step * 90 / segments)
            points.append(
                (x + radius * math.cos(radians), z + radius * math.sin(radians))
            )
    return points


def frame(name, center, outer, inner, depth, surface, parent, inner_offset=0.0):
    """A real opening, with front/back rings and inner/outer wall surfaces."""
    exterior = rounded_rectangle(*outer)
    interior = [(x + inner_offset, z) for x, z in rounded_rectangle(*inner)]
    count = len(exterior)
    vertices = []
    for y in (-depth / 2, depth / 2):
        for contour in (exterior, interior):
            vertices.extend(
                (x + center[0], y + center[1], z + center[2]) for x, z in contour
            )
    faces = []
    for index in range(count):
        following = (index + 1) % count
        faces.extend(
            [
                (index, following, following + count, index + count),
                (
                    index + 2 * count,
                    index + 3 * count,
                    following + 3 * count,
                    following + 2 * count,
                ),
                (index, index + 2 * count, following + 2 * count, following),
                (
                    index + count,
                    following + count,
                    following + 3 * count,
                    index + 3 * count,
                ),
            ]
        )
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, 0.0006)


def label(name, value, position, size, surface, parent):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = 0.00008
    curve.resolution_u = 3
    curve.font = bpy.data.fonts["Oven panel font"]
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler[0] = math.pi / 2
    return finish(obj, name, surface, parent)


def screw(name, position, surface, parent):
    cylinder(name, position, 0.004, 0.0016, surface, parent, "Y")


def build_chamber_details(root, mat):
    # Rounded lining corners follow the series photo; the radius is estimated.
    for x, z, start_angle in (
        (-0.305, 0.150, 180),
        (0.105, 0.150, 270),
        (0.105, 0.596, 0),
        (-0.305, 0.596, 90),
    ):
        vertices = []
        for y in (-0.347, 0.319):
            for step in range(13):
                angle = math.radians(start_angle + step * 90 / 12)
                vertices.append(
                    (x + 0.015 * math.cos(angle), y, z + 0.015 * math.sin(angle))
                )
        faces = [(i, i + 1, i + 14, i + 13) for i in range(12)]
        mesh = bpy.data.meshes.new("Formed chamber corner")
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new("Formed chamber corner", mesh)
        bpy.context.scene.collection.objects.link(obj)
        finish(obj, obj.name, mat["lining"], root)
        obj.modifiers.new("Lining sheet thickness", "SOLIDIFY").thickness = 0.0006
    for side in (-0.305, 0.105):
        offset = (
            -RACK_UPRIGHT_OUTWARD_OFFSET if side < 0 else RACK_UPRIGHT_OUTWARD_OFFSET
        )
        upright_x = side + offset
        for y in (-0.258, 0.262):
            for z in (0.159, 0.586):
                cylinder(
                    "Rack retaining stud",
                    (upright_x, y - 0.006, z),
                    0.0038,
                    0.003,
                    mat["chrome"],
                    root,
                    "Y",
                )
    for angle in range(0, 360, 60):
        outline = (
            (0.025, -20),
            (0.095, -10),
            (0.133, 15),
            (0.127, 31),
            (0.083, 11),
            (0.027, 17),
        )
        vertices = []
        for radius, offset in outline:
            radians = math.radians(angle + offset)
            vertices.append(
                (
                    -0.1 + radius * math.cos(radians),
                    0.312,
                    0.391 + radius * math.sin(radians),
                )
            )
        mesh = bpy.data.meshes.new("Swept impeller blade")
        mesh.from_pydata(vertices, [], [tuple(range(len(vertices)))])
        mesh.update()
        blade = bpy.data.objects.new("Convection impeller blade - inferred", mesh)
        bpy.context.scene.collection.objects.link(blade)
        finish(blade, blade.name, mat["steel"], root)
        blade.modifiers.new("Fan blade sheet", "SOLIDIFY").thickness = 0.0006
    cylinder(
        "Chamber drain recess", (-0.100, 0.270, 0.1355), 0.014, 0.001, mat["mask"], root
    )
    cylinder(
        "Chamber drain cover", (-0.100, 0.270, 0.136), 0.010, 0.001, mat["chrome"], root
    )
    for index in range(3):
        box(
            "Drain cover slot",
            (-0.106 + index * 0.006, 0.270, 0.1366),
            (0.0015, 0.012, 0.0004),
            mat["mask"],
            root,
            0.0001,
        )
    for z in (0.108, 0.640):
        for x in (-0.355, 0.161):
            screw("Chamber surround fastener", (x, -0.351, z), mat["chrome"], root)


def build_cabinet(root, mat):
    shells = (
        ("Left insulated shell", (-0.385, 0.026, 0.3755), (0.13, 0.748, 0.651)),
        ("Right service cabinet", (0.285, 0.026, 0.3755), (0.33, 0.748, 0.651)),
        ("Insulated floor", (-0.1, 0.026, 0.0925), (0.44, 0.748, 0.085)),
        ("Insulated roof", (-0.1, 0.026, 0.656), (0.44, 0.748, 0.090)),
        ("Back wall", (-0.1, 0.361, 0.373), (0.44, 0.078, 0.476)),
    )
    for name, position, dimensions in shells:
        box(name, position, dimensions, mat["steel"], root, 0.003)
    box(
        "Top folded sheet", (0, 0.015, 0.703), (0.900, 0.770, 0.004), mat["steel"], root
    )
    box(
        "Lower front plinth",
        (0, -0.367, 0.057),
        (0.896, 0.045, 0.014),
        mat["chrome"],
        root,
        0.002,
    )
    box(
        "Service fascia enamel",
        (0.348, -0.380, 0.381),
        (0.196, 0.030, 0.640),
        mat["ruby"],
        root,
        0.002,
    )
    box(
        "Door strike jamb",
        (0.216, -0.377, 0.381),
        (0.062, 0.035, 0.640),
        mat["chrome"],
        root,
        0.002,
    )
    frame(
        "Chamber seal",
        (-0.1, -0.352, 0.373),
        (0.472, 0.504, 0.025),
        (0.44, 0.476, 0.014),
        0.006,
        mat["rubber"],
        root,
    )
    box(
        "Interior back lining",
        (-0.1, 0.3205, 0.373),
        (0.438, 0.003, 0.474),
        mat["lining"],
        root,
    )
    for x in (-0.36, 0.36):
        for y in (-0.28, 0.35):
            cylinder(
                "Foot mounting washer", (x, y, 0.048), 0.027, 0.004, mat["steel"], root
            )
            cylinder(
                "Black adjustable foot",
                (x, y, 0.025),
                0.024,
                0.050,
                mat["rubber"],
                root,
            )
    for side in (-0.305, 0.105):
        for level in range(5):
            height = 0.177 + level * 0.088
            box(
                f"Shelf {level + 1} folded support",
                (side, -0.013, height),
                (0.03, 0.64, 0.006),
                mat["chrome"],
                root,
                0.001,
            )
            offset = -0.013 if side < 0 else 0.013
            box(
                f"Shelf {level + 1} upstand",
                (side + offset, -0.013, height + 0.012),
                (0.003, 0.632, 0.024),
                mat["lining"],
                root,
            )
        # 414 mm between upright faces gives the 400 mm tray 7 mm per side.
        # Maruzen does not dimension this gap in the available references.
        offset = (
            -RACK_UPRIGHT_OUTWARD_OFFSET if side < 0 else RACK_UPRIGHT_OUTWARD_OFFSET
        )
        upright_x = side + offset
        for y in (-0.258, 0.262):
            box(
                "Rail mounting upright",
                (upright_x, y, 0.373),
                (0.012, 0.008, 0.454),
                mat["chrome"],
                root,
            )
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=96, radius=0.15, depth=0.004, location=(-0.1, 0.315, 0.391)
    )
    cavity = bpy.context.object
    cavity.rotation_euler.x = math.pi / 2
    finish(cavity, "Fan dark cavity", mat["rubber"], root, 0.0008)
    for radius in (0.036, 0.061, 0.087, 0.113, 0.139):
        points = []
        for step in range(64):
            angle = step * math.tau / 64
            points.append(
                (
                    -0.1 + radius * math.cos(angle),
                    0.309,
                    0.391 + radius * math.sin(angle),
                )
            )
        tube("Concentric fan guard", points, 0.0018, mat["chrome"], root, True)
    for step in range(8):
        angle = step * math.tau / 8
        tube(
            "Fan guard spoke",
            [
                (-0.1, 0.308, 0.391),
                (
                    -0.1 + 0.145 * math.cos(angle),
                    0.308,
                    0.391 + 0.145 * math.sin(angle),
                ),
            ],
            0.0015,
            mat["chrome"],
            root,
        )
    cylinder("Fan hub", (-0.1, 0.304, 0.391), 0.025, 0.008, mat["steel"], root, "Y")
    box(
        "Chamber lamp housing",
        (-0.316, -0.243, 0.373),
        (0.006, 0.024, 0.40),
        mat["chrome"],
        root,
    )
    box(
        "Chamber lamp lens",
        (-0.311, -0.243, 0.373),
        (0.003, 0.015, 0.38),
        mat["lamp"],
        root,
    )
    box(
        "Drip gutter",
        (-0.13, -0.374, 0.058),
        (0.630, 0.041, 0.007),
        mat["chrome"],
        root,
    )
    box(
        "Gutter front lip",
        (-0.13, -0.395, 0.060),
        (0.630, 0.003, 0.007),
        mat["chrome"],
        root,
    )
    for z in (0.063, 0.694):
        cylinder(
            "Door hinge knuckle", (-0.442, -0.374, z), 0.008, 0.016, mat["chrome"], root
        )
    box(
        "Top hinge strap",
        (-0.423, -0.367, 0.701),
        (0.045, 0.030, 0.004),
        mat["chrome"],
        root,
    )
    cylinder(
        "Top hinge pin", (-0.440, -0.374, 0.701), 0.005, 0.008, mat["chrome"], root
    )
    for y in (-0.329, 0.376):
        box(
            "Service panel seam",
            (0.450, y, 0.377),
            (0.001, 0.0015, 0.626),
            mat["lining"],
            root,
            0,
        )
    for z in (0.070, 0.686):
        box(
            "Side folded panel edge",
            (0.450, 0.026, z),
            (0.001, 0.730, 0.0015),
            mat["lining"],
            root,
            0,
        )
        for y in (-0.326, -0.20, 0.12, 0.37):
            cylinder(
                "Side panel fastener",
                (0.451, y, z),
                0.003,
                0.001,
                mat["chrome"],
                root,
                "X",
            )
    cylinder(
        "Rear exhaust stub",
        (0.395, 0.415, 0.660),
        0.019,
        0.030,
        mat["steel"],
        root,
        "Y",
    )
    cylinder(
        "Rear power entry",
        (0.380, 0.407, 0.130),
        0.012,
        0.014,
        mat["rubber"],
        root,
        "Y",
    )
    build_chamber_details(root, mat)
    build_wash_hose(root, mat)


def build_wash_hose(root, mat):
    # The catalogue shows a 35 mm right-side valve projection.
    cylinder(
        "Side hand-shower hanger",
        (0.463, -0.237, 0.625),
        0.021,
        0.025,
        mat["chrome"],
        root,
        "X",
    )
    cylinder(
        "Hand spray body", (0.472, -0.269, 0.570), 0.010, 0.098, mat["chrome"], root
    )
    tube(
        "Bent spray head",
        [(0.472, -0.269, 0.612), (0.472, -0.279, 0.630), (0.472, -0.302, 0.623)],
        0.010,
        mat["chrome"],
        root,
        smooth=True,
    )
    cylinder(
        "Spray nozzle", (0.472, -0.308, 0.623), 0.006, 0.014, mat["lining"], root, "Y"
    )
    box(
        "Shower cradle",
        (0.463, -0.269, 0.562),
        (0.024, 0.033, 0.025),
        mat["steel"],
        root,
        0.001,
    )
    box(
        "Shower trigger",
        (0.473, -0.281, 0.57),
        (0.007, 0.007, 0.065),
        mat["chrome"],
        root,
        0.002,
    )
    cylinder(
        "Hose connector", (0.472, -0.269, 0.509), 0.008, 0.025, mat["chrome"], root
    )
    for height in (0.500, 0.505, 0.511, 0.517):
        cylinder(
            "Spray coupling ridge",
            (0.472, -0.269, height),
            0.009,
            0.0015,
            mat["chrome"],
            root,
        )
    for index in range(6):
        box(
            "Trigger grip groove",
            (0.473, -0.285, 0.550 + index * 0.007),
            (0.006, 0.0008, 0.001),
            mat["lining"],
            root,
            0.0002,
        )
    points = [
        (0.472, -0.269, 0.497),
        (0.472, -0.273, 0.40),
        (0.472, -0.280, 0.25),
        (0.472, -0.295, 0.11),
        (0.472, -0.278, 0.066),
        (0.472, -0.238, 0.055),
        (0.472, -0.198, 0.066),
        (0.472, -0.181, 0.11),
        (0.472, -0.181, 0.175),
        (0.472, -0.201, 0.24),
        (0.472, -0.220, 0.25),
        (0.472, -0.235, 0.21),
        (0.472, -0.237, 0.102),
    ]
    tube("Side hanging rinse hose", points, 0.0045, mat["rubber"], root, smooth=True)
    cylinder(
        "Valve hose coupling", (0.472, -0.237, 0.106), 0.007, 0.024, mat["chrome"], root
    )
    cylinder(
        "Hand-shower valve",
        (0.465, -0.237, 0.090),
        0.013,
        0.030,
        mat["chrome"],
        root,
        "X",
    )
    box(
        "White valve cross vertical",
        (0.482, -0.237, 0.090),
        (0.006, 0.008, 0.032),
        mat["white"],
        root,
        0.002,
    )
    box(
        "White valve cross horizontal",
        (0.482, -0.237, 0.090),
        (0.006, 0.032, 0.008),
        mat["white"],
        root,
        0.002,
    )


def build_handle_grip(handle, mat):
    # An oval, tapered moulded lever, reconstructed from the supplied unit photo.
    sections = (
        (0.009, -0.027, 0.012, 0.008),
        (-0.008, -0.030, 0.017, 0.012),
        (-0.025, -0.033, 0.015, 0.014),
        (-0.060, -0.033, 0.013, 0.014),
        (-0.115, -0.031, 0.012, 0.013),
        (-0.140, -0.028, 0.013, 0.011),
        (-0.151, -0.026, 0.008, 0.007),
    )
    vertices = []
    steps = 24
    for z, y, width, depth in sections:
        for index in range(steps):
            angle = index * math.tau / steps
            vertices.append((width * math.cos(angle), y + depth * math.sin(angle), z))
    faces = [tuple(range(steps))]
    for ring in range(len(sections) - 1):
        for index in range(steps):
            following = (index + 1) % steps
            faces.append(
                (
                    ring * steps + index,
                    (ring + 1) * steps + index,
                    (ring + 1) * steps + following,
                    ring * steps + following,
                )
            )
    faces.append(
        tuple((len(sections) - 1) * steps + index for index in reversed(range(steps)))
    )
    mesh = bpy.data.meshes.new("Moulded drop grip")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Ergonomic drop handle", mesh)
    bpy.context.scene.collection.objects.link(obj)
    finish(obj, obj.name, mat["rubber"], handle)
    obj.modifiers.new("Moulded grip smoothing", "SUBSURF").levels = 2
    cylinder("Handle hub inset", (0, -0.030, 0), 0.017, 0.002, mat["mask"], handle, "Y")
    points = [
        (
            0.018 * math.cos(i * math.tau / 48),
            -0.0315,
            0.018 * math.sin(i * math.tau / 48),
        )
        for i in range(48)
    ]
    tube("Handle hub mould seam", points, 0.0005, mat["rubber"], handle, cyclic=True)


def build_door(door, handle, mat):
    center = (0.276, -0.004, 0)
    frame(
        "Ruby door surround",
        center,
        (0.562, 0.632, 0.003),
        (0.314, 0.452, 0.017),
        0.042,
        mat["ruby"],
        door,
        inner_offset=0.031,
    )
    frame(
        "Black ceramic window mask",
        (0.307, -0.026, 0),
        (0.414, 0.628, 0.002),
        (0.314, 0.452, 0.017),
        0.0016,
        mat["mask"],
        door,
    )
    frame(
        "Window rim",
        (0.307, -0.0265, 0),
        (0.316, 0.454, 0.018),
        (0.307, 0.445, 0.016),
        0.001,
        mat["rubber"],
        door,
    )
    box(
        "Outer smoked pane",
        (0.307, -0.019, 0),
        (0.310, 0.004, 0.448),
        mat["glass"],
        door,
        0.009,
    )
    box(
        "Inner smoked pane",
        (0.307, 0.012, 0),
        (0.310, 0.004, 0.448),
        mat["glass"],
        door,
        0.009,
    )
    frame(
        "Inner glazing frame",
        (0.307, 0.02, 0),
        (0.472, 0.506, 0.024),
        (0.314, 0.452, 0.019),
        0.006,
        mat["chrome"],
        door,
    )
    box(
        "Door right stainless trim",
        (0.592, -0.004, 0),
        (0.070, 0.044, 0.632),
        mat["chrome"],
        door,
        0.002,
    )
    for start in (0.102, 0.494):
        for stripe in range(4):
            box(
                "Door pinstripe",
                (start + stripe * 0.005, -0.0273, 0),
                (0.0016, 0.0004, 0.626),
                mat["ruby"],
                door,
                0,
            )
    for x in (0.024, 0.531):
        for z in (-0.282, 0.282):
            cylinder(
                "Door face fixing cap",
                (x, -0.028, z),
                0.009,
                0.002,
                mat["chrome"],
                door,
                "Y",
            )
    cylinder("Handle collar", (0, -0.006, 0), 0.025, 0.019, mat["chrome"], handle, "Y")
    cylinder(
        "Handle moulded hub", (0, -0.02, 0), 0.023, 0.017, mat["rubber"], handle, "Y"
    )
    build_handle_grip(handle, mat)
    for x in (0.091, 0.522):
        for z in (-0.236, 0.236):
            screw("Inner glazing retainer", (x, 0.025, z), mat["chrome"], door)
    frame(
        "Glazing spacer channel",
        (0.307, -0.004, 0),
        (0.319, 0.457, 0.018),
        (0.311, 0.449, 0.016),
        0.023,
        mat["mask"],
        door,
    )
    frame(
        "Door perimeter folded edge",
        (0.310, -0.004, 0),
        (0.634, 0.636, 0.004),
        (0.628, 0.630, 0.003),
        0.041,
        mat["chrome"],
        door,
    )
    box(
        "Handle caution label",
        (0.592, -0.0265, -0.287),
        (0.036, 0.0005, 0.022),
        mat["white"],
        door,
        0,
    )
    label("Caution mark", "!", (0.592, -0.027, -0.287), 0.016, mat["mask"], door)


def panel_button(root, mat, name, x, z, marking):
    cylinder(name, (x, -0.400, z), 0.0062, 0.0008, mat["white"], root, "Y")
    if marking == "◷":
        points = [
            (
                x + 0.0035 * math.cos(i * math.tau / 32),
                -0.4007,
                z + 0.0035 * math.sin(i * math.tau / 32),
            )
            for i in range(32)
        ]
        tube(name + " clock face", points, 0.00025, mat["mask"], root, cyclic=True)
        tube(
            name + " clock hands",
            [
                (x - 0.0018, -0.4008, z + 0.0018),
                (x, -0.4008, z),
                (x + 0.0018, -0.4008, z + 0.0025),
            ],
            0.0003,
            mat["mask"],
            root,
        )
    else:
        size = 0.009 if marking in ("▼", "▲") else 0.006
        label(name + " icon", marking, (x, -0.4006, z), size, mat["mask"], root)


def seven_segment_readout(root, mat, value, x, z, color):
    digits = {
        "0": "abcdef",
        "1": "bc",
        "2": "abdeg",
        "3": "abcdg",
        "4": "bcfg",
        "5": "acdfg",
        "6": "acdefg",
        "7": "abc",
        "8": "abcdefg",
        "9": "abcdfg",
    }
    segments = {
        "a": (0, 0.006, False),
        "b": (0.0032, 0.003, True),
        "c": (0.0032, -0.003, True),
        "d": (0, -0.006, False),
        "e": (-0.0032, -0.003, True),
        "f": (-0.0032, 0.003, True),
        "g": (0, 0, False),
    }
    vertices = []
    faces = []
    for index, digit in enumerate(value):
        center = x + (index - (len(value) - 1) / 2) * 0.010
        if digit == ":":
            for offset in (-0.003, 0.003):
                cylinder(
                    "Timer separator",
                    (center, -0.4002, z + offset),
                    0.0007,
                    0.0002,
                    mat[color],
                    root,
                    "Y",
                )
            continue
        for segment in digits.get(digit, ""):
            sx, sz, vertical = segments[segment]
            contour = (
                (-0.0029, 0),
                (-0.0022, -0.0006),
                (0.0022, -0.0006),
                (0.0029, 0),
                (0.0022, 0.0006),
                (-0.0022, 0.0006),
            )
            first = len(vertices)
            for u, v in contour:
                if vertical:
                    u, v = -v, u
                vertices.append(
                    (center + sx + u + (sz + v) * 0.09, -0.4002, z + sz + v)
                )
            faces.append(tuple(range(first, first + len(contour))))
    mesh = bpy.data.meshes.new("Seven segment " + value)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Readout " + value, mesh)
    bpy.context.scene.collection.objects.link(obj)
    finish(obj, obj.name, mat[color], root)
    obj.modifiers.new("Display segment depth", "SOLIDIFY").thickness = 0.0002


def panel_outline(root, mat, z, height):
    contour = rounded_rectangle(0.083, height, 0.004)
    points = [(0.348 + x, -0.399, z + vertical) for x, vertical in contour]
    tube("Printed control enclosure", points, 0.00045, mat["white"], root, True)


def build_emblem(root, mat):
    outer = cylinder(
        "Maruzen oval emblem",
        (0.348, -0.397, 0.657),
        0.017,
        0.001,
        mat["white"],
        root,
        "Y",
    )
    outer.scale.x = 2.1
    inner = cylinder(
        "Maruzen emblem centre",
        (0.348, -0.398, 0.657),
        0.0145,
        0.001,
        mat["ruby"],
        root,
        "Y",
    )
    inner.scale.x = 2.15
    crown = [
        (-0.026, 0.006),
        (-0.024, -0.005),
        (-0.016, -0.009),
        (-0.008, -0.010),
        (0, -0.007),
        (0.008, -0.010),
        (0.016, -0.009),
        (0.024, -0.005),
        (0.026, 0.006),
        (0.020, 0.001),
        (0.011, -0.002),
        (0, -0.003),
        (-0.011, -0.002),
        (-0.020, 0.001),
    ]
    mesh = bpy.data.meshes.new("Crown silhouette")
    mesh.from_pydata(
        [(0.348 + x, -0.399, 0.657 + z) for x, z in crown],
        [],
        [tuple(range(len(crown)))],
    )
    obj = bpy.data.objects.new("Maruzen crown emblem", mesh)
    bpy.context.scene.collection.objects.link(obj)
    finish(obj, obj.name, mat["white"], root)
    label("Emblem star", "✦", (0.348, -0.3992, 0.664), 0.009, mat["white"], root)


def build_panel(root, mat):
    x = 0.348
    box(
        "Compact control membrane",
        (x, -0.397, 0.503),
        (0.094, 0.002, 0.230),
        mat["mask"],
        root,
        0.003,
    )
    for z, height in ((0.543, 0.099), (0.467, 0.048), (0.424, 0.030)):
        panel_outline(root, mat, z, height)
    for z, word in (
        (0.588, "庫内温度"),
        (0.552, "タイマー"),
        (0.488, "メニュー　ステップ"),
    ):
        label(
            "Panel heading " + word, word, (x, -0.3995, z), 0.0045, mat["white"], root
        )
    for z, value, color in (
        (0.573, "180", "red"),
        (0.535, "10:00", "red"),
        (0.474, "18  1", "green"),
    ):
        box(
            "Recessed display lens",
            (x - 0.005, -0.399, z),
            (0.052, 0.0005, 0.016),
            mat["rubber"],
            root,
        )
        seven_segment_readout(root, mat, value, x - 0.005, z, color)
    label(
        "Temperature unit", "°C", (x + 0.018, -0.4001, 0.566), 0.005, mat["white"], root
    )
    for z in (0.581, 0.542, 0.437):
        cylinder(
            "Panel indicator bezel",
            (x + 0.019, -0.3995, z),
            0.002,
            0.0005,
            mat["rubber"],
            root,
            "Y",
        )
    for index, (name, icon) in enumerate(
        (("予熱", "≈"), ("ライト", "☼"), ("電源", "I/O"))
    ):
        button_x = x - 0.031 + 0.031 * index
        panel_button(root, mat, name, button_x, 0.608, icon)
        label(
            name + " label",
            name,
            (button_x, -0.3995, 0.598),
            0.0035,
            mat["white"],
            root,
        )
    panel_button(root, mat, "Temperature switch", x + 0.031, 0.573, "温")
    panel_button(root, mat, "Timer set", x + 0.031, 0.535, "◷")
    for offset, icon in ((-0.012, "▼"), (0.012, "▲")):
        panel_button(root, mat, "Time selection", x + offset, 0.506, icon)
    for offset, icon in ((-0.033, "▤"), (-0.011, "▼"), (0.011, "▲"), (0.033, "▣")):
        panel_button(root, mat, "Menu selection", x + offset, 0.453, icon)
    panel_button(root, mat, "Start stop", x, 0.428, "✣")
    label(
        "Start stop label",
        "スタート/ストップ",
        (x, -0.400, 0.417),
        0.0035,
        mat["white"],
        root,
    )
    for index, (name, icon) in enumerate(
        (("ダンパー", "I-I"), ("風量", "✣"), ("加湿", "⋰"))
    ):
        button_x = x - 0.031 + 0.031 * index
        panel_button(root, mat, name, button_x, 0.400, icon)
        label(
            name + " label",
            name,
            (button_x, -0.3995, 0.391),
            0.0032,
            mat["white"],
            root,
        )
    box(
        "Model badge backing",
        (x, -0.396, 0.086),
        (0.119, 0.001, 0.035),
        mat["badge"],
        root,
    )
    label("Maker wordmark", "Maruzen", (x, -0.397, 0.092), 0.022, mat["white"], root)
    label(
        "Model marking",
        "MBCO-5E",
        (x, -0.397, 0.077),
        0.010,
        mat["white"],
        root,
    )
    build_emblem(root, mat)


def objects_for_body(body):
    return [
        obj
        for obj in bpy.context.scene.objects
        if obj.parent == body and obj.type in {"MESH", "CURVE", "FONT"}
    ]


def convert_curves(bodies):
    """Keep labels and hoses in both OBJ and glTF exports."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for body in bodies:
        for obj in objects_for_body(body):
            if obj.type == "MESH":
                continue
            mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
            replacement = bpy.data.objects.new(obj.name + " mesh", mesh)
            bpy.context.scene.collection.objects.link(replacement)
            replacement.parent = body
            replacement.matrix_basis = obj.matrix_basis.copy()
            name = obj.name
            bpy.data.objects.remove(obj, do_unlink=True)
            replacement.name = name


def _sanitize_xml_id(stem):
    return "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in stem)


def _extract_material_pbr_layers(surface, directory):
    """Inspect a Blender material's node tree for local PNG textures to wire as Filament PBR layers."""
    layers = []
    rgba_override = None
    has_orm = False
    has_roughness_map = False
    has_metallic_map = False
    if not surface.node_tree:
        return layers, rgba_override, has_orm, has_roughness_map, has_metallic_map

    def resolve_local_png(image):
        if image is None:
            return None
        for candidate in (Path(image.filepath).name if image.filepath else "", image.name):
            if candidate and (directory / candidate).is_file():
                return candidate
        return None

    seen_roles = set()
    for node in surface.node_tree.nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        fname = resolve_local_png(node.image)
        if not fname:
            continue
        targets = [
            (link.to_node.type, link.to_socket.name)
            for out in node.outputs
            for link in out.links
        ]
        colorspace = (
            "linear"
            if node.image.colorspace_settings.name in {"Non-Color", "Linear", "Raw"}
            else "sRGB"
        )
        role = None
        if any(t_node == "BSDF_PRINCIPLED" and t_sock == "Base Color" for t_node, t_sock in targets):
            role = "rgb"
            colorspace = "sRGB"
            rgba_override = (1.0, 1.0, 1.0, 1.0)
        elif any(t_node == "MIX" for t_node, _ in targets):
            role = "rgb"
            colorspace = "sRGB"
        elif any(t_node == "SEPARATE_COLOR" for t_node, _ in targets) or "orm" in fname.lower():
            role = "orm"
            colorspace = "linear"
            has_orm = True
        elif any(t_node == "NORMAL_MAP" for t_node, _ in targets) or "normal" in fname.lower():
            role = "normal"
            colorspace = "linear"
        elif any(t_node == "BSDF_PRINCIPLED" and t_sock == "Roughness" for t_node, t_sock in targets):
            role = "roughness"
            colorspace = "linear"
            has_roughness_map = True
        elif any(t_node == "BSDF_PRINCIPLED" and t_sock == "Metallic" for t_node, t_sock in targets):
            role = "metallic"
            colorspace = "linear"
            has_metallic_map = True
        if role and role not in seen_roles:
            seen_roles.add(role)
            tex_name = "tex_" + _sanitize_xml_id(Path(fname).stem)
            layers.append((tex_name, fname, colorspace, role))
    return layers, rgba_override, has_orm, has_roughness_map, has_metallic_map


def export_visual_meshes(bodies, directory):
    """Export body-local OBJ groups with UVs and Filament PBR textures; visual surfaces supply no inertia."""
    mesh_directory = directory / "meshes"
    mesh_directory.mkdir(exist_ok=True)
    assets = ET.Element("mujocoinclude")
    written_textures = set()
    written_materials = set()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for body in bodies:
        groups = {}
        for obj in objects_for_body(body):
            surface = obj.data.materials[0]
            groups.setdefault(surface.name, []).append(obj)
        geoms = ET.Element("mujocoinclude")
        for surface_name, objects in sorted(groups.items()):
            name = body.name + "_" + surface_name
            lines = ["# Body-local visual mesh; decorative surfaces supply no inertia"]
            offset = 0
            uv_offset = 0
            normal_offset = 0
            has_uvs = any(
                obj.type == "MESH" and obj.data.uv_layers.active is not None
                for obj in objects
            )
            for obj in objects:
                evaluated = obj.evaluated_get(depsgraph)
                mesh = evaluated.to_mesh()
                mesh.calc_loop_triangles()
                transform = body.matrix_world.inverted() @ obj.matrix_world
                normal_transform = transform.to_3x3().inverted().transposed()
                for vertex in mesh.vertices:
                    coordinate = transform @ vertex.co
                    lines.append(
                        "v " + " ".join(f"{value:.9f}" for value in coordinate)
                    )
                if has_uvs:
                    uv_layer = mesh.uv_layers.active
                    if uv_layer is not None and len(uv_layer.data) == len(mesh.loops):
                        for uv_item in uv_layer.data:
                            lines.append(
                                f"vt {uv_item.uv.x:.6f} {uv_item.uv.y:.6f}"
                            )
                    else:
                        for _ in range(len(mesh.loops)):
                            lines.append("vt 0.000000 0.000000")
                for normal in mesh.corner_normals:
                    direction = (normal_transform @ normal.vector).normalized()
                    lines.append(
                        "vn " + " ".join(f"{value:.9f}" for value in direction)
                    )
                for polygon in mesh.loop_triangles:
                    face = []
                    for vertex, loop in zip(polygon.vertices, polygon.loops):
                        if has_uvs:
                            face.append(
                                f"{offset + vertex + 1}/{uv_offset + loop + 1}/{normal_offset + loop + 1}"
                            )
                        else:
                            face.append(
                                f"{offset + vertex + 1}//{normal_offset + loop + 1}"
                            )
                    lines.append("f " + " ".join(face))
                offset += len(mesh.vertices)
                if has_uvs:
                    uv_offset += len(mesh.loops)
                normal_offset += len(mesh.loops)
                evaluated.to_mesh_clear()
            (mesh_directory / f"{name}.obj").write_text("\n".join(lines) + "\n")
            ET.SubElement(
                assets,
                "mesh",
                name=name,
                file=f"meshes/{name}.obj",
                inertia="shell",
                smoothnormal="true",
            )
            if surface_name not in written_materials:
                surface = bpy.data.materials[surface_name]
                layers, rgba_override, has_orm, has_roughness_map, has_metallic_map = (
                    _extract_material_pbr_layers(surface, directory)
                )
                for tex_name, fname, colorspace, _role in layers:
                    if tex_name not in written_textures:
                        ET.SubElement(
                            assets,
                            "texture",
                            name=tex_name,
                            type="2d",
                            file=fname,
                            colorspace=colorspace,
                        )
                        written_textures.add(tex_name)
                rgba_vals = rgba_override if rgba_override is not None else surface.diffuse_color
                metallic_val = 1.0 if (has_orm or has_metallic_map) else float(surface["metallic"])
                roughness_val = 1.0 if (has_orm or has_roughness_map) else float(surface["roughness"])
                mat_el = ET.SubElement(
                    assets,
                    "material",
                    name="visual_" + surface_name,
                    rgba=" ".join(str(value) for value in rgba_vals),
                    metallic=str(metallic_val),
                    roughness=str(roughness_val),
                    specular="0.5",
                    shininess=str(1 - float(surface["roughness"])),
                    emission=str(min(1, surface["emission"])),
                )
                for tex_name, _fname, _colorspace, role in layers:
                    ET.SubElement(mat_el, "layer", texture=tex_name, role=role)
                written_materials.add(surface_name)
            ET.SubElement(
                geoms,
                "geom",
                name="visual_" + name,
                type="mesh",
                mesh=name,
                material="visual_" + surface_name,
                contype="0",
                conaffinity="0",
                density="0",
                mass="0",
                group="2",
            )
        write_xml(directory / f"visual_{body.name}.xml", geoms)
    write_xml(directory / "visual_assets.xml", assets)


def write_xml(path, element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_glb(bodies):
    bpy.ops.object.select_all(action="DESELECT")
    for body in bodies:
        body.select_set(True)
        for obj in objects_for_body(body):
            obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / "maruzen-mbco-5e.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def look_at(obj, target):
    obj.rotation_euler = (
        (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    )


def area_light(name, position, target, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj, target)


def setup_studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1500
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("Neutral studio world")
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.6, 0.65, 0.72, 1)
    background.inputs["Strength"].default_value = 0.45
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.25
    backdrop = material("studio_floor", (0.29, 0.31, 0.33, 1), roughness=0.85)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.003))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(backdrop)
    area_light("Large left softbox", (-1.7, -2.0, 2.5), (0, 0, 0.35), 200, 2)
    area_light("Right stripbox", (1.8, -0.4, 1.7), (0, 0, 0.35), 130, 1.4)
    area_light("Back rim softbox", (-0.1, 1.6, 2.2), (0, 0, 0.35), 220, 1.5)
    area_light("Front fill", (0, -2, 0.6), (0, 0, 0.35), 30, 1.5)
    area_light(
        "Chamber inspection fill", (-0.35, -1.3, 0.6), (-0.1, 0.3, 0.35), 12, 0.45
    )
    camera_data = bpy.data.cameras.new("Product camera")
    camera = bpy.data.objects.new("Product camera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera.location = (1.25, -2.8, 1.12)
    camera_data.ortho_scale = 1.37
    look_at(camera, (0, 0, 0.34))
    scene.camera = camera
    return camera


def render_studio(camera, door):
    views = (
        ("studio-closed", (1.25, -2.8, 1.12), (0, 0, 0.34), 1.37, 0),
        ("studio-front", (0, -3, 0.42), (0, 0, 0.36), 1.24, 0),
        ("studio-open", (1.3, -2.8, 1.4), (-0.14, -0.12, 0.34), 1.7, -100),
        ("studio-right", (2.4, -0.8, 1.0), (0, 0, 0.35), 1.4, 0),
        ("studio-interior", (-0.08, -3, 0.75), (-0.1, 0.1, 0.36), 0.85, -100),
        ("studio-detail-panel", (0.85, -2.8, 0.86), (0.34, -0.39, 0.50), 0.39, 0),
    )
    for name, position, target, scale, angle in views:
        door.rotation_euler.z = math.radians(angle)
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / f"{name}.png")
        bpy.ops.render.render(write_still=True)
    door.rotation_euler.z = 0
    camera.location = views[0][1]
    camera.data.ortho_scale = views[0][3]
    look_at(camera, views[0][2])


def setup_authoring_scene(root, door, handle):
    scene = bpy.context.scene
    appliance = bpy.data.collections.new("MBCO-5E appliance")
    studio = bpy.data.collections.new("Studio - excluded from exports")
    references = bpy.data.collections.new("Source references - toggle visibility")
    for collection in (appliance, studio, references):
        scene.collection.children.link(collection)
    parts = {root, *root.children_recursive}
    for obj in list(scene.objects):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        (appliance if obj in parts else studio).objects.link(obj)
    for index, filename in enumerate(
        (
            "user-mbco-5e-unit.png",
            "user-mbco-drawing.png",
            "series-control-panel.jpg",
            "series-chamber-corner.jpg",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / filename))
        image.pack()
        obj = bpy.data.objects.new(filename, None)
        references.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.location = (index * 1.2, 0.6, 0.4)
        obj.rotation_euler.x = math.pi / 2
        obj.empty_display_size = 1
        obj["reference_status"] = (
            "Inspection reference; use labelled dimensions for scale"
        )
    references.hide_viewport = True
    references.hide_render = True
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 144
    for number, door_angle, handle_angle in (
        (1, 0, 0),
        (18, 0, 20),
        (60, -100, 0),
        (96, -100, 0),
        (132, 0, 0),
        (144, 0, 0),
    ):
        door.rotation_euler.z = math.radians(door_angle)
        handle.rotation_euler.y = -math.radians(handle_angle)
        door.keyframe_insert(data_path="rotation_euler", index=2, frame=number)
        handle.keyframe_insert(data_path="rotation_euler", index=1, frame=number)
    for name, number in (
        ("Closed", 1),
        ("Release gesture", 18),
        ("Open", 60),
        ("Inspect chamber", 96),
        ("Closed again", 144),
    ):
        scene.timeline_markers.new(name, frame=number)
    scene.frame_set(1)


def record_build(root):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangle_count = 0
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangle_count += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    report = {
        "asset": "maruzen-mbco-5e",
        "revision": "2026-10-07 rack upright clearance correction",
        "blender_version": bpy.app.version_string,
        "glb_sha256": hashlib.sha256(
            (ASSETS / "maruzen-mbco-5e.glb").read_bytes()
        ).hexdigest(),
        "mesh_count": len(meshes),
        "evaluated_triangles": triangle_count,
        "glb_bytes": (ASSETS / "maruzen-mbco-5e.glb").stat().st_size,
        "nominal_dimensions_m": [0.9, 0.8, 0.705],
        "chamber_dimensions_m": [0.44, 0.67, 0.476],
        "physics": "Rack upright, upstand and stud contacts match authored profiles; joint frames, inertia and demo drives remain uncalibrated",
        "assumptions": [
            "Minor surface profiles and optical properties from photographs",
            "Fan, drain and hidden fittings inferred",
            "Rack upright gap is an estimated 414 mm, giving a 400 mm tray 7 mm clearance per side",
            "Existing uncalibrated mechanism parameters retained",
        ],
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    parser.add_argument(
        "--label-font",
        type=Path,
        default=Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    )
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError(
            "Build in a separate background Blender process to preserve open work."
        )
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if not args.label_font.is_file():
        raise RuntimeError("Pass --label-font with a Japanese-capable TTF font.")
    panel_font = bpy.data.fonts.load(str(args.label_font))
    panel_font.name = "Oven panel font"
    scene = bpy.context.scene
    scene.name = "Maruzen MBCO-5E — visual reference"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    root = empty("mbco_oven", (0, 0, 0))
    door = empty("mbco_door", DOOR_ORIGIN, root)
    handle = empty("mbco_handle", HANDLE_ORIGIN, door)
    root["source_status"] = (
        "MBCO-5E-badged user photo and catalogue; hidden mechanics unverified; uncalibrated"
    )
    door["joint"] = "mbco_door_hinge"
    door["opening_axis_blender"] = "-Z"
    door["opening_axis_gltf"] = "-Y"
    door["range_radians"] = [0.0, 1.919862]
    handle["joint"] = "mbco_handle_turn"
    handle["rotation_axis_blender"] = "-Y"
    handle["rotation_axis_gltf"] = "+Z"
    handle["range_radians"] = [-0.523599, 0.523599]
    mat = materials()
    build_cabinet(root, mat)
    build_door(door, handle, mat)
    build_panel(root, mat)
    bpy.context.view_layer.update()
    convert_curves((root, door, handle))
    bpy.context.view_layer.update()
    export_visual_meshes((root, door, handle), ASSETS)
    export_glb((root, door, handle))
    camera = setup_studio()
    if not args.skip_renders:
        render_studio(camera, door)
    setup_authoring_scene(root, door, handle)
    record_build(root)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
                area.spaces.active.shading.type = "MATERIAL"
                area.spaces.active.overlay.show_overlays = False
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "maruzen-mbco-5e.blend"))
    print("Saved Blender scene, articulated GLB and MuJoCo visual meshes:", ASSETS)


if __name__ == "__main__":
    main()
