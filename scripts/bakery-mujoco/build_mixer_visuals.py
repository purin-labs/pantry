"""Author the Japanese countertop Hobart HL200 as an articulated visual asset.

Metres, Z up, front towards -Y. Japanese drawing 2026-05-11 owns dimensions.
Photo-derived surfaces and mechanism travels remain estimates, without physics.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    rounded_rectangle,
    tube,
)

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/hobart-hl200"
REFERENCES = REPOSITORY / "docs/equipment/hobart-hl200"
BOWL_Y = -0.194
NAME = "hobart-hl200"
PREVIEW_LIFT_TRAVEL = 0.020


def materials():
    palette = {
        "paint": material("HL metallic grey enamel", (0.44, 0.47, 0.48, 1), 0.38, 0.30),
        "steel": material("HL satin stainless", (0.57, 0.60, 0.62, 1), 0.88, 0.24),
        "polished": material(
            "HL polished rim and wires", (0.72, 0.75, 0.77, 1), 0.93, 0.18
        ),
        "aluminium": material(
            "HL cast aluminium tool", (0.54, 0.57, 0.59, 1), 0.72, 0.37
        ),
        "black": material(
            "HL moulded black polymer", (0.013, 0.017, 0.018, 1), 0.02, 0.43
        ),
        "panel": material("HL control panel", (0.046, 0.052, 0.055, 1), 0.1, 0.34),
        "ink": material("HL pale lettering", (0.78, 0.81, 0.80, 1), 0, 0.47),
        "red": material("HL stop button", (0.46, 0.006, 0.008, 1), 0, 0.28),
        "display": material("HL timer digits", (0.50, 0.045, 0.023, 1), emission=0.4),
        "amber": material("HL warning band", (0.79, 0.27, 0.009, 1), 0, 0.44),
    }
    shader = palette["paint"].node_tree.nodes["Principled BSDF"]
    shader.inputs["Coat Weight"].default_value = 0.2
    shader.inputs["Coat Roughness"].default_value = 0.27
    return palette


def mesh_object(name, vertices, faces, surface, parent, bevel=0):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel)


def loft_z(name, sections, surface, parent):
    vertices = []
    for z, x, y, width, depth, radius in sections:
        vertices.extend(
            (x + u, y + v, z) for u, v in rounded_rectangle(width, depth, radius)
        )
    count = len(rounded_rectangle(1, 1, 0.1))
    faces = [tuple(reversed(range(count)))]
    for ring in range(len(sections) - 1):
        for index in range(count):
            following = (index + 1) % count
            faces.append(
                (
                    ring * count + index,
                    ring * count + following,
                    (ring + 1) * count + following,
                    (ring + 1) * count + index,
                )
            )
    faces.append(tuple((len(sections) - 1) * count + i for i in range(count)))
    return mesh_object(name, vertices, faces, surface, parent, 0.001)


def foot(name, x, mat, parent):
    sections = (
        (-0.227, 0.012, 0.045, 0.112),
        (-0.217, 0.010, 0.065, 0.119),
        (-0.180, 0.015, 0.090, 0.117),
        (-0.115, 0.058, 0.118, 0.111),
        (0.025, 0.078, 0.145, 0.098),
        (0.145, 0.065, 0.166, 0.103),
        (0.204, 0.010, 0.158, 0.117),
        (0.227, 0.010, 0.140, 0.119),
    )
    vertices = []
    for y, bottom, top, width in sections:
        contour = rounded_rectangle(width, top - bottom, min(0.016, (top - bottom) / 3))
        vertices.extend((x + u, y, (top + bottom) / 2 + v) for u, v in contour)
    count = len(contour)
    faces = [tuple(range(count))]
    for ring in range(len(sections) - 1):
        for index in range(count):
            following = (index + 1) % count
            faces.append(
                (
                    ring * count + index,
                    (ring + 1) * count + index,
                    (ring + 1) * count + following,
                    ring * count + following,
                )
            )
    faces.append(tuple((len(sections) - 1) * count + i for i in reversed(range(count))))
    mesh_object(name, vertices, faces, mat["paint"], parent, 0.002)
    for y in (-0.199, 0.199):
        box(
            "Elastomer foot pad",
            (x, y, 0.005),
            (0.112, 0.054, 0.010),
            mat["black"],
            parent,
            0.004,
        )


def lathe(name, profile, center, surface, parent, segments=96):
    vertices = []
    for radius, z in profile:
        for index in range(segments):
            angle = index * math.tau / segments
            vertices.append(
                (
                    center[0] + radius * math.cos(angle),
                    center[1] + radius * math.sin(angle),
                    center[2] + z,
                )
            )
    faces = []
    for ring in range(len(profile) - 1):
        for index in range(segments):
            following = (index + 1) % segments
            faces.append(
                (
                    ring * segments + index,
                    ring * segments + following,
                    (ring + 1) * segments + following,
                    (ring + 1) * segments + index,
                )
            )
    obj = mesh_object(name, vertices, faces, surface, parent)
    obj.modifiers.remove(obj.modifiers["Weighted surface normals"])
    return obj


def arc_points(radius, z, start=0, stop=360, center=(0, 0), steps=64):
    return [
        (
            center[0]
            + radius * math.cos(math.radians(start + (stop - start) * i / steps)),
            center[1]
            + radius * math.sin(math.radians(start + (stop - start) * i / steps)),
            z,
        )
        for i in range(steps + 1)
    ]


def side_label(name, value, position, size, surface, parent):
    data = bpy.data.curves.new(name, "FONT")
    data.body = value
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.00004
    data.resolution_u = 3
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (math.pi / 2, 0, math.pi / 2)
    return finish(obj, name, surface, parent)


def build_body(root, mat):
    foot("Left cast pedestal leg", -0.150, mat, root)
    foot("Right cast pedestal leg", 0.150, mat, root)
    loft_z(
        "Rear pedestal bridge",
        (
            (0.073, 0, 0.153, 0.300, 0.135, 0.035),
            (0.132, 0, 0.145, 0.316, 0.164, 0.040),
            (0.170, 0, 0.132, 0.260, 0.180, 0.040),
        ),
        mat["paint"],
        root,
    )
    loft_z(
        "Tapered cast column",
        (
            (0.150, 0, 0.113, 0.242, 0.218, 0.025),
            (0.174, 0, 0.109, 0.236, 0.215, 0.025),
            (0.245, 0, 0.098, 0.213, 0.198, 0.028),
            (0.430, 0, 0.064, 0.179, 0.166, 0.027),
            (0.516, 0, 0.036, 0.177, 0.171, 0.030),
            (0.554, 0, 0.022, 0.224, 0.222, 0.033),
            (0.569, 0, 0.011, 0.243, 0.243, 0.035),
        ),
        mat["paint"],
        root,
    )
    loft_z(
        "Rounded motor and gearbox housing",
        (
            (0.568, 0, -0.055, 0.240, 0.435, 0.025),
            (0.581, 0, -0.0575, 0.261, 0.489, 0.030),
            (0.675, 0, -0.0575, 0.266, 0.489, 0.036),
            (0.705, 0, -0.052, 0.258, 0.475, 0.040),
            (0.727, 0, -0.019, 0.237, 0.408, 0.041),
            (0.737, 0, 0.012, 0.167, 0.306, 0.043),
        ),
        mat["paint"],
        root,
    )
    box(
        "Upper casting parting seam",
        (0.131, -0.056, 0.585),
        (0.0008, 0.400, 0.0012),
        mat["panel"],
        root,
        0.0002,
    )
    for x in (-0.072, 0.072):
        box(
            "Bowl lift guide rail",
            (x, -0.011, 0.322),
            (0.012, 0.018, 0.293),
            mat["steel"],
            root,
            0.002,
        )
    for x in (-0.072, 0.072):
        for z in (0.184, 0.459):
            cylinder(
                "Guide retaining screw",
                (x, -0.022, z),
                0.004,
                0.002,
                mat["polished"],
                root,
                "Y",
            )
    for radius, y, depth in (
        (0.047, -0.310, 0.020),
        (0.039, -0.328, 0.022),
        (0.033, -0.342, 0.008),
    ):
        cylinder(
            "Front attachment hub",
            (0, y, 0.630),
            radius,
            depth,
            mat["steel"],
            root,
            "Y",
        )
    cylinder(
        "Attachment hub blank cap",
        (0, -0.347, 0.630),
        0.031,
        0.003,
        mat["paint"],
        root,
        "Y",
    )
    cylinder(
        "Hub clamp stud", (0.038, -0.309, 0.674), 0.006, 0.027, mat["steel"], root, "Y"
    )
    box(
        "Hub clamp knob",
        (0.038, -0.322, 0.679),
        (0.025, 0.013, 0.030),
        mat["black"],
        root,
        0.005,
    )
    cylinder(
        "Planetary fixed neck", (0, BOWL_Y, 0.554), 0.106, 0.032, mat["paint"], root
    )
    cylinder(
        "Planetary neck seam", (0, BOWL_Y, 0.537), 0.108, 0.003, mat["black"], root
    )
    tube(
        "Fixed drip cup lip",
        arc_points(0.120, 0.510, center=(0, BOWL_Y)),
        0.004,
        mat["steel"],
        root,
    )
    box(
        "Rear service cover seam",
        (0, 0.199, 0.268),
        (0.148, 0.001, 0.110),
        mat["panel"],
        root,
        0.008,
    )
    box(
        "Rear service cover",
        (0, 0.200, 0.269),
        (0.145, 0.0015, 0.108),
        mat["paint"],
        root,
        0.007,
    )
    for index in range(7):
        box(
            "Rear ventilation slot",
            (0, 0.201, 0.240 + index * 0.009),
            (0.094, 0.001, 0.002),
            mat["panel"],
            root,
            0.0005,
        )


def build_controls(root, mat):
    box(
        "Control panel bezel",
        (0.137, -0.019, 0.649),
        (0.012, 0.171, 0.104),
        mat["black"],
        root,
        0.008,
    )
    box(
        "Control panel face",
        (0.144, -0.019, 0.649),
        (0.002, 0.164, 0.096),
        mat["panel"],
        root,
        0.004,
    )
    for y, name, value in (
        (-0.030, "Timer selector", "TIME"),
        (0.031, "Speed selector", "SPEED"),
    ):
        cylinder(
            name + " collar", (0.148, y, 0.637), 0.020, 0.004, mat["steel"], root, "X"
        )
        cylinder(name, (0.160, y, 0.637), 0.016, 0.020, mat["black"], root, "X")
        grip = box(
            name + " grip",
            (0.172, y, 0.637),
            (0.010, 0.009, 0.031),
            mat["black"],
            root,
            0.003,
        )
        grip.rotation_euler.x = math.radians(-28)
        side_label(name + " legend", value, (0.146, y, 0.611), 0.005, mat["ink"], root)
    for z, name, surface in ((0.661, "Start", "black"), (0.623, "Stop", "red")):
        cylinder(
            name + " button bezel",
            (0.148, -0.080, z),
            0.012,
            0.004,
            mat["steel"],
            root,
            "X",
        )
        cylinder(
            name + " button", (0.153, -0.080, z), 0.009, 0.009, mat[surface], root, "X"
        )
    side_label("Start legend", "I", (0.158, -0.080, 0.661), 0.009, mat["ink"], root)
    side_label("Stop legend", "O", (0.158, -0.080, 0.623), 0.008, mat["ink"], root)
    box(
        "Timer lens",
        (0.146, -0.027, 0.682),
        (0.001, 0.049, 0.016),
        mat["black"],
        root,
        0.001,
    )
    side_label(
        "Example timer display",
        "00:00",
        (0.147, -0.027, 0.682),
        0.011,
        mat["display"],
        root,
    )
    side_label(
        "Speed positions",
        "STIR  1  2  3",
        (0.147, 0.030, 0.677),
        0.0047,
        mat["ink"],
        root,
    )
    box(
        "Hobart badge",
        (0.137, 0.121, 0.682),
        (0.003, 0.064, 0.024),
        mat["ink"],
        root,
        0.002,
    )
    side_label(
        "Hobart wordmark", "HOBART", (0.139, 0.121, 0.682), 0.014, mat["black"], root
    )
    side_label(
        "Legacy marking", "LEGACY", (0.134, 0.122, 0.641), 0.008, mat["panel"], root
    )
    box(
        "Japan rating plate",
        (0.111, 0.117, 0.228),
        (0.001, 0.103, 0.057),
        mat["steel"],
        root,
        0.001,
    )
    box(
        "Rating warning band",
        (0.112, 0.117, 0.252),
        (0.001, 0.101, 0.009),
        mat["amber"],
        root,
        0.0004,
    )
    side_label(
        "Warning heading", "CAUTION", (0.113, 0.117, 0.252), 0.005, mat["black"], root
    )
    side_label(
        "Japan rating text",
        "HL200   100 V\n50/60 Hz   8.0 A",
        (0.113, 0.117, 0.226),
        0.0055,
        mat["black"],
        root,
    )


def build_support(lift, mat):
    box(
        "Sliding bowl carriage",
        (0, -0.005, 0.287),
        (0.164, 0.037, 0.158),
        mat["paint"],
        lift,
        0.008,
    )
    profile = [
        (0.168, -0.014),
        (0.183, -0.014),
        (0.190, -0.006),
        (0.190, 0.008),
        (0.181, 0.014),
        (0.168, 0.014),
        (0.168, -0.014),
    ]
    vertices = []
    for radius, z in profile:
        vertices.extend(arc_points(radius, 0.244 + z, 0, 180, (0, BOWL_Y), 48))
    faces = []
    count = 49
    for ring in range(len(profile) - 1):
        for i in range(count - 1):
            faces.append(
                (
                    ring * count + i,
                    ring * count + i + 1,
                    (ring + 1) * count + i + 1,
                    (ring + 1) * count + i,
                )
            )
    mesh_object("Curved cast bowl support", vertices, faces, mat["paint"], lift, 0.001)
    for x in (-0.181, 0.181):
        cylinder(
            "Bowl support pin", (x, BOWL_Y, 0.263), 0.006, 0.049, mat["steel"], lift
        )
        cylinder(
            "Support pin shoulder", (x, BOWL_Y, 0.244), 0.012, 0.007, mat["paint"], lift
        )
    box(
        "Bowl locking lever",
        (0.179, BOWL_Y - 0.010, 0.276),
        (0.014, 0.047, 0.006),
        mat["steel"],
        lift,
        0.002,
    )


def build_bowl(swing, mat):
    bowl = empty("hl_bowl", (0.181, 0, -0.159), swing)
    profile = [
        (0.001, 0),
        (0.043, 0),
        (0.065, 0.006),
        (0.090, 0.020),
        (0.115, 0.041),
        (0.137, 0.070),
        (0.150, 0.104),
        (0.155, 0.140),
        (0.156, 0.245),
        (0.157, 0.288),
        (0.157, 0.292),
        (0.155, 0.292),
        (0.155, 0.288),
        (0.154, 0.245),
        (0.153, 0.140),
        (0.148, 0.105),
        (0.135, 0.071),
        (0.113, 0.043),
        (0.088, 0.022),
        (0.063, 0.008),
        (0.042, 0.002),
        (0.001, 0.002),
        (0.001, 0),
    ]
    lathe("Hollow stainless bowl", profile, (0, 0, 0), mat["steel"], bowl, 128)
    tube("Rolled bowl rim", arc_points(0.1573, 0.2888), 0.0032, mat["polished"], bowl)
    for sign in (-1, 1):
        x = sign * 0.156
        for y in (-0.050, 0.050):
            box(
                "Welded bowl handle tab",
                (x, y, 0.238),
                (0.004, 0.016, 0.029),
                mat["steel"],
                bowl,
                0.003,
            )
        points = [
            (x, -0.050, 0.240),
            (sign * 0.181, -0.050, 0.254),
            (sign * 0.186, -0.039, 0.258),
            (sign * 0.186, 0.039, 0.258),
            (sign * 0.181, 0.050, 0.254),
            (x, 0.050, 0.240),
        ]
        tube("Bowl carry handle", points, 0.0035, mat["polished"], bowl, smooth=True)
        box(
            "Bowl mounting lug",
            (sign * 0.167, 0, 0.162),
            (0.029, 0.034, 0.008),
            mat["steel"],
            bowl,
            0.002,
        )
    bowl["nominal_diameter_m"] = 0.321
    bowl["nominal_height_m"] = 0.292
    bowl["profile_status"] = (
        "Envelope from drawing; formed wall profile and 2 mm thickness estimated"
    )
    return bowl


def build_guard(guard, mat):
    rings = (
        (0.1755, 0.394),
        (0.172, 0.419),
        (0.162, 0.445),
        (0.146, 0.472),
        (0.124, 0.498),
    )
    for radius, z in rings:
        tube(
            "Guard horizontal hoop",
            arc_points(radius, z, 165, 375),
            0.0025 if z == 0.394 else 0.0017,
            mat["polished"],
            guard,
        )
    for angle in (165, 190, 220, 250, 280, 310, 340, 375):
        radians = math.radians(angle)
        points = [
            (radius * math.cos(radians), radius * math.sin(radians), z)
            for radius, z in rings
        ]
        tube("Guard vertical rib", points, 0.0022, mat["polished"], guard, smooth=True)
    for angle in (190, 280, 365):
        radians = math.radians(angle)
        box(
            "Guard carrier shoe",
            (0.117 * math.cos(radians), 0.117 * math.sin(radians), 0.505),
            (0.016, 0.015, 0.010),
            mat["black"],
            guard,
            0.003,
        )
    guard["joint_axis_blender"] = "Z"
    guard["preview_open_angle_degrees"] = -120
    guard["motion_status"] = (
        "Leftward opening from family manual; preview angle estimated"
    )


def build_planetary(root, mat):
    orbit = empty("hl_planetary", (0, BOWL_Y, 0.526), root)
    cylinder("Planetary carrier casting", (0, 0, 0), 0.108, 0.025, mat["paint"], orbit)
    cylinder("Carrier lower rim", (0, 0, -0.012), 0.111, 0.005, mat["steel"], orbit)
    axis = empty("hl_tool_axis", (0.030, 0, -0.030), orbit)
    cylinder("Agitator shaft", (0, 0, -0.027), 0.012, 0.065, mat["polished"], axis)
    cylinder(
        "Agitator drive pin", (0, 0, -0.040), 0.003, 0.034, mat["steel"], axis, "X"
    )
    orbit["joint_axis_blender"] = "Z"
    orbit["orbit_offset_m"] = 0.030
    orbit["measurement_status"] = (
        "Orbit offset and gear ratio unmeasured; no motor animation or calibrated gearing"
    )
    return orbit, axis


def build_beater(axis, mat):
    beater = empty("hl_beater", (0, 0, 0), axis)
    cylinder(
        "Beater bayonet socket", (0, 0, -0.036), 0.022, 0.049, mat["aluminium"], beater
    )
    cylinder(
        "Beater retaining plunger",
        (0.024, 0, -0.030),
        0.005,
        0.020,
        mat["steel"],
        beater,
        "X",
    )
    box(
        "Beater central stem",
        (0, 0, -0.103),
        (0.015, 0.014, 0.095),
        mat["aluminium"],
        beater,
        0.003,
    )
    outer = [
        (-0.070, -0.112),
        (-0.103, -0.160),
        (-0.096, -0.266),
        (-0.052, -0.339),
        (0, -0.357),
        (0.052, -0.339),
        (0.096, -0.266),
        (0.103, -0.160),
        (0.070, -0.112),
        (0, -0.084),
    ]
    inner = [
        (-0.059, -0.125),
        (-0.088, -0.165),
        (-0.083, -0.261),
        (-0.045, -0.326),
        (0, -0.341),
        (0.045, -0.326),
        (0.083, -0.261),
        (0.088, -0.165),
        (0.059, -0.125),
        (0, -0.099),
    ]
    count = len(outer)
    vertices = [
        (x, y, z)
        for y in (-0.005, 0.005)
        for contour in (outer, inner)
        for x, z in contour
    ]
    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.extend(
            (
                (i, j, count + j, count + i),
                (2 * count + i, 3 * count + i, 3 * count + j, 2 * count + j),
                (i, 2 * count + i, 2 * count + j, j),
                (count + i, count + j, 3 * count + j, 3 * count + i),
            )
        )
    mesh_object(
        "Flat beater perimeter", vertices, faces, mat["aluminium"], beater, 0.002
    )
    for start, end in (
        ((0, 0, -0.12), (0, 0, -0.34)),
        ((-0.091, 0, -0.18), (0.077, 0, -0.27)),
        ((0.091, 0, -0.18), (-0.077, 0, -0.27)),
    ):
        center = (Vector(start) + Vector(end)) / 2
        bar = box(
            "Beater web",
            center,
            (0.011, 0.010, (Vector(end) - Vector(start)).length),
            mat["aluminium"],
            beater,
            0.002,
        )
        bar.rotation_euler = (
            (Vector(end) - Vector(start)).to_track_quat("Z", "Y").to_euler()
        )
    beater["tool"] = "BBEATER-HL20 visual reference"
    return beater


def build_whip(mat):
    whip = empty("hl_whip", (0, 0, 0))
    cylinder(
        "Whip bayonet socket", (0, 0, -0.036), 0.022, 0.049, mat["aluminium"], whip
    )
    cylinder(
        "Whip retaining plunger",
        (0.024, 0, -0.030),
        0.005,
        0.020,
        mat["steel"],
        whip,
        "X",
    )
    cylinder("Whip wire ferrule", (0, 0, -0.071), 0.024, 0.022, mat["steel"], whip)
    profile = (
        (0.013, -0.079),
        (0.069, -0.123),
        (0.108, -0.213),
        (0.092, -0.292),
        (0.044, -0.340),
        (0, -0.353),
        (-0.044, -0.340),
        (-0.092, -0.292),
        (-0.108, -0.213),
        (-0.069, -0.123),
        (-0.013, -0.079),
    )
    for index in range(8):
        angle = index * math.pi / 8
        points = [(r * math.cos(angle), r * math.sin(angle), z) for r, z in profile]
        tube("Balloon whip loop", points, 0.00165, mat["polished"], whip, smooth=True)
    whip["tool"] = "DWHIP-HL20 visual reference"
    whip["mount_origin"] = "Match hl_beater local transform under hl_tool_axis"
    return whip


def build_lift_lever(root, mat):
    lever = empty("hl_lift_lever", (0.130, 0.070, 0.490), root)
    cylinder("Lift pivot bezel", (0, 0, 0), 0.020, 0.009, mat["black"], lever, "X")
    cylinder("Lift pivot boss", (0.009, 0, 0), 0.014, 0.021, mat["steel"], lever, "X")
    tube(
        "Manual lift lever",
        [
            (0.014, 0, 0),
            (0.036, -0.009, -0.080),
            (0.110, -0.015, -0.175),
            (0.177, -0.015, -0.175),
        ],
        0.006,
        mat["polished"],
        lever,
        smooth=True,
    )
    cylinder(
        "Lift lever end cap",
        (0.1785, -0.015, -0.175),
        0.006,
        0.012,
        mat["steel"],
        lever,
        "X",
    )
    lever["joint_axis_blender"] = "X"
    return lever


def export_glb(root, filename):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def organize(root, whip):
    scene = bpy.context.scene
    appliance = bpy.data.collections.new("HL200 appliance")
    tools = bpy.data.collections.new("Alternate wire whip - toggle visibility")
    references = bpy.data.collections.new("Source references - toggle visibility")
    for collection in (appliance, tools, references):
        scene.collection.children.link(collection)
    for body, collection in ((root, appliance), (whip, tools)):
        for obj in (body, *body.children_recursive):
            for owner in list(obj.users_collection):
                owner.objects.unlink(obj)
            collection.objects.link(obj)
    tools.hide_viewport = True
    tools.hide_render = True
    for index, filename in enumerate(
        (
            "manufacturer-product.jpg",
            "orthographic-front.png",
            "orthographic-side.png",
            "orthographic-top-and-bowl-swing.png",
            "manual-guard-operation.png",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / "images" / filename))
        image.pack()
        obj = bpy.data.objects.new(filename, None)
        references.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1
        obj.location = (index * 0.8, 0.5, 0.4)
        obj.rotation_euler.x = math.pi / 2
        obj["reference_status"] = (
            "Unregistered reference image; use labelled dimensions"
        )
    references.hide_viewport = True
    references.hide_render = True


def studio():
    scene = bpy.context.scene
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1500
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("HL200 neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.57,
        0.61,
        0.68,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.25
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(
        material("HL studio floor", (0.29, 0.31, 0.33, 1), roughness=0.9)
    )
    area_light("Left softbox", (-1.5, -1.5, 2), (0, -0.1, 0.4), 150, 1.6)
    area_light("Right stripbox", (1.2, -0.15, 1.7), (0, -0.1, 0.4), 120, 1.2)
    area_light("Rear reflection", (-0.3, 1.5, 1.5), (0, 0, 0.4), 160, 1.0)
    area_light("Front bowl fill", (0.3, -1.8, 0.8), (0, BOWL_Y, 0.3), 30, 0.9)
    data = bpy.data.cameras.new("Review camera")
    camera = bpy.data.objects.new("Review camera", data)
    scene.collection.objects.link(camera)
    data.type = "ORTHO"
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from exports")
    scene.collection.children.link(collection)
    for obj in set(scene.objects) - before:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    return camera


def set_pose(parts, opened=False, swing_out=False):
    parts["guard"].rotation_euler.z = math.radians(-120 if opened else 0)
    parts["lift"].location.z = -PREVIEW_LIFT_TRAVEL if opened else 0
    parts["lever"].rotation_euler.x = math.radians(-80 if opened else 0)
    parts["swing"].rotation_euler.z = math.radians(-95 if swing_out else 0)
    for obj in parts["beater"].children_recursive:
        obj.hide_render = swing_out
    bpy.context.view_layer.update()


def render_views(camera, parts):
    views = (
        ("studio-closed", (1.1, -1.65, 1.02), (0.015, -0.06, 0.37), 1.04, False, False),
        ("studio-open", (1.0, -1.7, 1.08), (-0.005, -0.10, 0.36), 1.06, True, False),
        (
            "studio-bowl-swing",
            (1.0, -1.7, 1.08),
            (-0.07, -0.15, 0.36),
            1.15,
            True,
            True,
        ),
        ("studio-front", (0, -3, 0.40), (0.045, -0.05, 0.37), 0.90, False, False),
        ("studio-right", (3, 0, 0.40), (0, -0.07, 0.37), 0.90, False, False),
        ("studio-detail", (0.95, -1.6, 1.15), (0.025, -0.15, 0.47), 0.55, True, False),
    )
    for name, position, target, scale, opened, swing_out in views:
        set_pose(parts, opened, swing_out)
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / f"{name}.png")
        bpy.ops.render.render(write_still=True)
    set_pose(parts)
    camera.location = views[0][1]
    camera.data.ortho_scale = views[0][3]
    look_at(camera, views[0][2])


def preview_animation(parts):
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 144
    for frame, opened, lowered in (
        (1, False, False),
        (28, True, False),
        (56, True, True),
        (88, True, True),
        (116, True, False),
        (144, False, False),
    ):
        parts["guard"].rotation_euler.z = math.radians(-120 if opened else 0)
        parts["lift"].location.z = -PREVIEW_LIFT_TRAVEL if lowered else 0
        parts["lever"].rotation_euler.x = math.radians(-80 if lowered else 0)
        parts["guard"].keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
        parts["lift"].keyframe_insert(data_path="location", index=2, frame=frame)
        parts["lever"].keyframe_insert(data_path="rotation_euler", index=0, frame=frame)
    for title, frame in (
        ("Ready", 1),
        ("Guard open", 28),
        ("Bowl lowered", 56),
        ("Inspect", 88),
        ("Bowl raised", 116),
        ("Guard closed", 144),
    ):
        scene.timeline_markers.new(title, frame=frame)
    scene.frame_set(1)


def render_tools(camera, root, beater, whip):
    camera_location = camera.location.copy()
    camera_rotation = camera.rotation_euler.copy()
    camera_scale = camera.data.ortho_scale
    parent = beater.parent
    tool_objects = {beater, *beater.children_recursive}
    hidden = {obj: obj.hide_render for obj in root.children_recursive}
    for obj in root.children_recursive:
        obj.hide_render = obj not in tool_objects
    beater.parent = None
    beater.location = (-0.150, 0, 0.370)
    whip.location = (0.150, 0, 0.370)
    collection = bpy.data.collections["Alternate wire whip - toggle visibility"]
    collection.hide_render = False
    camera.location = (0.65, -1.6, 0.70)
    camera.data.ortho_scale = 0.650
    look_at(camera, (0, 0, 0.195))
    bpy.context.scene.render.filepath = str(ASSETS / "studio-tools.png")
    bpy.ops.render.render(write_still=True)
    beater.parent = parent
    beater.location = (0, 0, 0)
    whip.location = (0, 0, 0)
    collection.hide_render = True
    for obj, value in hidden.items():
        obj.hide_render = value
    camera.location = camera_location
    camera.rotation_euler = camera_rotation
    camera.data.ortho_scale = camera_scale


def count_vertices_inside(objects, obstacle, tree):
    inverse = obstacle.matrix_world.inverted()
    count = 0
    for obj in objects:
        for vertex in obj.data.vertices:
            point = inverse @ obj.matrix_world @ vertex.co
            nearest, normal, _, distance = tree.find_nearest(point)
            if distance > 0.0001 and (point - nearest).dot(normal) < -0.0001:
                count += 1
    return count


def inspect_preview_clearance(parts):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    feet = [
        bpy.data.objects[name]
        for name in ("Left cast pedestal leg", "Right cast pedestal leg")
    ]
    foot_trees = [BVHTree.FromObject(obj, depsgraph) for obj in feet]
    column = bpy.data.objects["Tapered cast column"]
    column_tree = BVHTree.FromObject(column, depsgraph)
    shell = bpy.data.objects["Hollow stainless bowl"]
    wires = [
        obj
        for obj in parts["guard"].children
        if obj.type == "MESH" and obj.name.startswith("Guard horizontal hoop")
    ]
    bowl_hits = 0
    guard_hits = 0
    for index in range(21):
        fraction = index / 20
        parts["guard"].rotation_euler.z = math.radians(-120) * fraction
        parts["lift"].location.z = -PREVIEW_LIFT_TRAVEL * fraction
        bpy.context.view_layer.update()
        for foot, tree in zip(feet, foot_trees):
            bowl_hits += count_vertices_inside([shell], foot, tree)
        guard_hits += count_vertices_inside(wires, column, column_tree)
    for index in range(21):
        parts["swing"].rotation_euler.z = math.radians(-95) * index / 20
        bpy.context.view_layer.update()
        for foot, tree in zip(feet, foot_trees):
            bowl_hits += count_vertices_inside([shell], foot, tree)
    set_pose(parts)
    report = {
        "sampled_lift_poses": 21,
        "sampled_guard_poses": 21,
        "sampled_bowl_swing_poses": 21,
        "bowl_vertices_inside_feet": bowl_hits,
        "guard_vertices_inside_column": guard_hits,
        "preview_lift_travel_m": PREVIEW_LIFT_TRAVEL,
        "scope": "Sampled visual mesh vertices only; tool removed before bowl swing; no continuous collision or mechanical calibration",
    }
    (ASSETS / "clearance-report.json").write_text(json.dumps(report, indent=2) + "\n")
    if bowl_hits or guard_hits:
        raise RuntimeError(f"Preview geometry intersects: {report}")


def record_build(root, bowl):
    bpy.context.view_layer.update()
    vertices = [
        obj.matrix_world @ Vector(corner)
        for obj in root.children_recursive
        if obj.type == "MESH"
        for corner in obj.bound_box
    ]
    minimum = [min(point[axis] for point in vertices) for axis in range(3)]
    maximum = [max(point[axis] for point in vertices) for axis in range(3)]
    report = {
        "asset": NAME,
        "drawing": "Hobart Japan HL200, 2026-05-11",
        "blender_version": bpy.app.version_string,
        "source_sha256": hashlib.sha256(
            (REFERENCES / "specifications/installation-jp.pdf").read_bytes()
        ).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / f"{NAME}.glb").read_bytes()).hexdigest(),
        "nominal_dimensions_m": [0.524, 0.599, 0.737],
        "authored_bounds_m": {"min": minimum, "max": maximum},
        "bowl_diameter_m": bowl["nominal_diameter_m"],
        "bowl_height_m": bowl["nominal_height_m"],
        "status": "Visual prototype; no calibrated physics or executable recipe workflow",
        "assumptions": [
            "Bowl wall, cast profiles, controls and minor details from photographs",
            "20 mm preview lift travel, -120 degree guard opening, -95 degree bowl swing; hardware limits unmeasured",
            "30 mm planetary offset; gearing, inertia and tool engagement unmeasured",
            "US family mechanism illustrations need confirmation against supplied Japanese revision",
        ],
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError(
            "Run in a separate background Blender process to preserve open work."
        )
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Hobart HL200 - Japan countertop reference"
    scene.unit_settings.system = "METRIC"
    root = empty("hl_mixer", (0, 0, 0))
    root["model"] = "Hobart HL200 Japanese countertop configuration"
    root["manufacturer_mass_kg"] = 85.7
    root["rated_supply"] = "100 V, single phase, 50/60 Hz, 8.0 A"
    root["source_status"] = (
        "Dimensioned visual prototype; mechanism parameters estimated"
    )
    mat = materials()
    build_body(root, mat)
    build_controls(root, mat)
    lift = empty("hl_bowl_lift", (0, 0, 0), root)
    lift["preview_travel_m"] = PREVIEW_LIFT_TRAVEL
    build_support(lift, mat)
    swing = empty("hl_bowl_swing", (-0.181, BOWL_Y, 0.250), lift)
    swing["preview_open_angle_degrees"] = -95
    bowl = build_bowl(swing, mat)
    guard = empty("hl_guard", (0, BOWL_Y, 0), root)
    build_guard(guard, mat)
    lever = build_lift_lever(root, mat)
    orbit, axis = build_planetary(root, mat)
    beater = build_beater(axis, mat)
    whip = build_whip(mat)
    convert_curves((root, lift, bowl, guard, lever, orbit, axis, beater, whip))
    bpy.context.view_layer.update()
    export_glb(root, f"{NAME}.glb")
    export_glb(whip, f"{NAME}-whip.glb")
    beater.parent = None
    export_glb(beater, f"{NAME}-beater.glb")
    beater.parent = axis
    organize(root, whip)
    camera = studio()
    parts = {
        "lift": lift,
        "swing": swing,
        "guard": guard,
        "lever": lever,
        "beater": beater,
    }
    inspect_preview_clearance(parts)
    if not args.skip_renders:
        render_views(camera, parts)
        render_tools(camera, root, beater, whip)
    else:
        camera.location = (1.1, -1.65, 1.02)
        camera.data.ortho_scale = 1.04
        look_at(camera, (0.015, -0.06, 0.37))
    whip.location = (0.47, 0, 0.37)
    preview_animation(parts)
    record_build(root, bowl)
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))
    print(
        "Saved editable mixer, main/whip GLBs, references and review renders:", ASSETS
    )


if __name__ == "__main__":
    main()
