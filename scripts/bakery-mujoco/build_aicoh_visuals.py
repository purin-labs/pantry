"""Build the AICOH MS-30 standard-panel floor mixer from drawing C2-6490A.

Metres, Z up, front -Y. Unlabelled shapes and motion limits are estimates.
Run in background Blender to preserve the user's open scene.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import arc_points, lathe, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    tube,
)

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/aicoh-ms-30"
REFERENCES = ROOT / "docs/equipment/aicoh-ms-30"
BOWL_Y = -0.200
LIFT_TRAVEL = 0.120


def palette():
    return {
        "steel": material("AICOH satin stainless", (0.46, 0.49, 0.52, 1), 0.88, 0.29),
        "polished": material(
            "AICOH polished bowl and wire", (0.66, 0.69, 0.72, 1), 0.95, 0.17
        ),
        "aluminium": material("AICOH cast tool", (0.50, 0.53, 0.55, 1), 0.75, 0.35),
        "black": material("AICOH black polymer", (0.009, 0.013, 0.017, 1), 0, 0.36),
        "panel": material("AICOH membrane panel", (0.28, 0.36, 0.36, 1), 0.18, 0.43),
        "key": material("AICOH blue grey buttons", (0.055, 0.085, 0.12, 1), 0, 0.4),
        "white": material("AICOH white legends", (0.87, 0.89, 0.86, 1), 0, 0.5),
        "red": material("AICOH emergency stop", (0.60, 0.008, 0.014, 1), 0.05, 0.27),
        "yellow": material(
            "AICOH yellow safety surround", (0.95, 0.55, 0.005, 1), 0, 0.4
        ),
        "digits": material("AICOH LED digits", (0.75, 0.012, 0.006, 1), emission=0.6),
        "blue": material("AICOH brand blue", (0.015, 0.04, 0.14, 1), 0, 0.45),
    }


def text_label(name, value, position, size, surface, parent):
    data = bpy.data.curves.new(name, "FONT")
    data.body = value
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.000025
    data.resolution_u = 3
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = math.pi / 2
    return finish(obj, name, surface, parent)


def bolt(name, position, surface, parent, axis="Z"):
    cylinder(name, position, 0.005, 0.003, surface, parent, axis)


def frame(root, mat):
    for x in (-0.220, 0.220):
        for y in (-0.225, 0.335):
            box(
                "Square stainless leg",
                (x, y, 0.1045),
                (0.080, 0.080, 0.197),
                mat["steel"],
                root,
                0.003,
            )
            box(
                "Foot end cap",
                (x, y, 0.003),
                (0.078, 0.078, 0.006),
                mat["black"],
                root,
                0.001,
            )
        box(
            "Base side rail",
            (x, 0.055, 0.239),
            (0.080, 0.640, 0.072),
            mat["steel"],
            root,
            0.002,
        )
    for y in (-0.225, 0.335):
        box(
            "Base cross rail",
            (0, y, 0.239),
            (0.360, 0.080, 0.072),
            mat["steel"],
            root,
            0.002,
        )
    box(
        "Column mounting plate",
        (0, 0.181, 0.283),
        (0.434, 0.375, 0.016),
        mat["steel"],
        root,
        0.002,
    )
    for x in (-0.185, 0.185):
        for y in (0.035, 0.325):
            bolt("Base fixing bolt", (x, y, 0.293), mat["polished"], root)
    box(
        "Lower column enclosure",
        (0, 0.210, 0.562),
        (0.245, 0.285, 0.542),
        mat["steel"],
        root,
        0.002,
    )
    box(
        "Upper column enclosure",
        (0, 0.207, 0.983),
        (0.245, 0.290, 0.300),
        mat["steel"],
        root,
        0.002,
    )
    box(
        "Motor and gearbox housing",
        (0, 0.005, 1.278),
        (0.260, 0.690, 0.314),
        mat["steel"],
        root,
        0.003,
    )
    box(
        "Top cover seam",
        (0, 0.005, 1.435),
        (0.263, 0.693, 0.002),
        mat["black"],
        root,
        0.001,
    )
    box(
        "Top cover folded lip",
        (0, 0.005, 1.440),
        (0.266, 0.696, 0.010),
        mat["steel"],
        root,
        0.002,
    )
    for x in (-0.104, 0.104):
        for y in (-0.302, 0.310):
            bolt("Top cover screw", (x, y, 1.4435), mat["steel"], root)
    for z in (0.317, 0.809, 1.050, 1.400):
        for y in (0.090, 0.326):
            bolt("Side service panel screw", (0.124, y, z), mat["polished"], root, "X")
    box("Lift guide slot", (0, 0.062, 0.538), (0.019, 0.005, 0.488), mat["black"], root)
    for x in (-0.057, 0.057):
        box(
            "Stainless lift guide",
            (x, 0.057, 0.595),
            (0.016, 0.014, 0.600),
            mat["polished"],
            root,
        )
    for z in (1.140, 1.220):
        cylinder(
            "Rear lubrication boss",
            (0.105, 0.367, z),
            0.009,
            0.028,
            mat["steel"],
            root,
            "Y",
        )
        cylinder(
            "Lubrication cup", (0.105, 0.389, z), 0.013, 0.012, mat["black"], root, "Y"
        )
    box(
        "Model data plate",
        (-0.155, -0.267, 0.242),
        (0.088, 0.002, 0.039),
        mat["black"],
        root,
    )
    text_label(
        "Model plate lettering",
        "AICOH  MS-30\n3 PH 200 V",
        (-0.155, -0.269, 0.242),
        0.009,
        mat["white"],
        root,
    )


def controls(root, mat):
    box(
        "Control panel bezel",
        (0, -0.343, 1.272),
        (0.140, 0.006, 0.176),
        mat["steel"],
        root,
        0.006,
    )
    box(
        "Control panel face",
        (0, -0.347, 1.276),
        (0.121, 0.003, 0.155),
        mat["panel"],
        root,
        0.005,
    )
    box(
        "Timer display",
        (0, -0.350, 1.323),
        (0.094, 0.002, 0.029),
        mat["black"],
        root,
        0.002,
    )
    text_label("Timer digits", "00:00", (0, -0.352, 1.323), 0.024, mat["digits"], root)
    text_label(
        "Timer heading", "MIXING TIME", (0, -0.351, 1.344), 0.006, mat["white"], root
    )
    for x in (-0.035, -0.012, 0.012, 0.035):
        box(
            "Time adjustment key",
            (x, -0.351, 1.297),
            (0.018, 0.002, 0.012),
            mat["white"],
            root,
            0.001,
        )
        text_label(
            "Time adjustment legend",
            "+" if x < 0 else "-",
            (x, -0.353, 1.297),
            0.009,
            mat["panel"],
            root,
        )
    for index, x in enumerate((-0.041, -0.014, 0.014, 0.041)):
        box(
            "Speed membrane key",
            (x, -0.351, 1.271),
            (0.023, 0.002, 0.024),
            mat["key"],
            root,
            0.002,
        )
        text_label(
            "Speed key number",
            str(index + 1),
            (x, -0.353, 1.271),
            0.012,
            mat["white"],
            root,
        )
    box(
        "Emergency stop surround",
        (-0.030, -0.351, 1.224),
        (0.051, 0.003, 0.057),
        mat["yellow"],
        root,
        0.002,
    )
    cylinder(
        "Emergency stop base",
        (-0.030, -0.357, 1.224),
        0.020,
        0.010,
        mat["black"],
        root,
        "Y",
    )
    cylinder(
        "Emergency stop mushroom",
        (-0.030, -0.370, 1.224),
        0.019,
        0.016,
        mat["red"],
        root,
        "Y",
    )
    text_label(
        "Emergency stop arrow", "O", (-0.030, -0.379, 1.224), 0.020, mat["white"], root
    )
    for x, z, value, surface in (
        (0.016, 1.239, ">|", "white"),
        (0.043, 1.239, ">", "white"),
        (0.016, 1.211, "TIMER", "key"),
        (0.043, 1.211, "STOP", "yellow"),
    ):
        box(
            "Operating membrane key",
            (x, -0.351, z),
            (0.023, 0.002, 0.022),
            mat[surface],
            root,
            0.001,
        )
        text_label(
            "Operating key legend",
            value,
            (x, -0.353, z),
            0.005 if len(value) > 2 else 0.013,
            mat["black"] if surface != "key" else mat["white"],
            root,
        )
    text_label("AICOH logotype", "AICOH", (0, -0.348, 1.188), 0.012, mat["blue"], root)
    box("Warning label", (0, -0.342, 1.155), (0.050, 0.002, 0.025), mat["white"], root)
    text_label(
        "Warning legend",
        "CAUTION\nMOVING TOOL",
        (0, -0.344, 1.155),
        0.0055,
        mat["red"],
        root,
    )


def bowl_assembly(lift, mat):
    box(
        "Lift carriage",
        (0, 0.043, 0.763),
        (0.205, 0.070, 0.110),
        mat["steel"],
        lift,
        0.003,
    )
    for sign in (-1, 1):
        box(
            "Bowl support arm",
            (sign * 0.201, -0.090, 0.748),
            (0.036, 0.296, 0.065),
            mat["steel"],
            lift,
            0.003,
        )
        box(
            "Bowl locating saddle",
            (sign * 0.204, BOWL_Y, 0.759),
            (0.052, 0.069, 0.055),
            mat["steel"],
            lift,
            0.003,
        )
        cylinder(
            "Bowl locating pin",
            (sign * 0.204, BOWL_Y, 0.794),
            0.007,
            0.025,
            mat["polished"],
            lift,
        )
    bowl = empty("ms_bowl", (0, BOWL_Y, 0.561), lift)
    outer = [
        (0, 0),
        (0.060, 0),
        (0.082, 0.009),
        (0.113, 0.031),
        (0.146, 0.071),
        (0.171, 0.119),
        (0.181, 0.165),
        (0.183, 0.221),
        (0.185, 0.300),
        (0.185, 0.349),
    ]
    inner = [
        (0.182, 0.349),
        (0.182, 0.300),
        (0.180, 0.221),
        (0.178, 0.166),
        (0.168, 0.120),
        (0.143, 0.073),
        (0.110, 0.034),
        (0.080, 0.012),
        (0.059, 0.004),
        (0, 0.004),
    ]
    lathe("Hollow stainless bowl", outer + inner, (0, 0, 0), mat["polished"], bowl, 128)
    tube(
        "Rolled bowl rim",
        arc_points(0.187, 0.350),
        0.003,
        mat["polished"],
        bowl,
        cyclic=True,
    )
    tube(
        "Bowl reinforcing band upper",
        arc_points(0.186, 0.220),
        0.002,
        mat["steel"],
        bowl,
        cyclic=True,
    )
    tube(
        "Bowl reinforcing band lower",
        arc_points(0.184, 0.203),
        0.002,
        mat["steel"],
        bowl,
        cyclic=True,
    )
    for sign in (-1, 1):
        box(
            "Bowl mounting lug",
            (sign * 0.200, 0, 0.209),
            (0.048, 0.053, 0.013),
            mat["steel"],
            bowl,
            0.002,
        )
        tube(
            "Bowl carrying handle",
            [
                (sign * 0.182, -0.052, 0.276),
                (sign * 0.217, -0.052, 0.276),
                (sign * 0.224, -0.040, 0.287),
                (sign * 0.224, 0.040, 0.287),
                (sign * 0.217, 0.052, 0.276),
                (sign * 0.182, 0.052, 0.276),
            ],
            0.004,
            mat["polished"],
            bowl,
            smooth=True,
        )
    bowl["profile_status"] = (
        "Estimated from C2-6490A orthographic silhouette; wall and lug tolerances unmeasured"
    )
    return bowl


def guard_sector(parent, mat, start, stop, title, radial_offset):
    for radius, z in ((0.123, 1.082), (0.124, 1.065), (0.192, 0.924)):
        tube(
            title + " ring",
            arc_points(radius + radial_offset, z, start, stop),
            0.003,
            mat["polished"],
            parent,
        )
    for index in range(25):
        angle = math.radians(start + (stop - start) * index / 24)
        points = [
            (
                (r + radial_offset) * math.cos(angle),
                (r + radial_offset) * math.sin(angle),
                z,
            )
            for r, z in (
                (0.123, 1.082),
                (0.124, 1.059),
                (0.137, 1.034),
                (0.186, 0.941),
                (0.192, 0.924),
            )
        ]
        tube(title + " wire", points, 0.0018, mat["polished"], parent, smooth=True)


def mechanisms(root, mat):
    cylinder(
        "Planetary fixed clutch cover",
        (0, BOWL_Y, 1.109),
        0.123,
        0.030,
        mat["steel"],
        root,
    )
    cylinder(
        "Guard carrier black seal", (0, BOWL_Y, 1.089), 0.130, 0.010, mat["black"], root
    )
    carrier = empty("ms_fixed_guard", (0, BOWL_Y, 0), root)
    guard_sector(carrier, mat, 0, 180, "Fixed rear guard", -0.008)
    guard = empty("ms_guard", (0, BOWL_Y, 0), root)
    guard_sector(guard, mat, 180, 360, "Rotating front guard", 0)
    for z in (1.091, 1.078):
        tube(
            "Guard runner ring",
            arc_points(0.130, z, 175, 365),
            0.004,
            mat["polished"],
            guard,
        )
    tube(
        "Guard handle",
        [
            (0.178, -0.070, 0.938),
            (0.216, -0.085, 0.960),
            (0.179, -0.068, 1.038),
            (0.144, -0.055, 1.018),
        ],
        0.004,
        mat["polished"],
        guard,
        smooth=True,
    )
    orbit = empty("ms_planetary", (0, BOWL_Y, 1.073), root)
    cylinder("Planetary rotating face", (0, 0, 0), 0.087, 0.019, mat["polished"], orbit)
    axis = empty("ms_tool_axis", (0.033, 0, -0.018), orbit)
    cylinder("Tool drive spindle", (0, 0, -0.043), 0.020, 0.090, mat["polished"], axis)
    cylinder("Tool retention collar", (0, 0, -0.074), 0.030, 0.015, mat["steel"], axis)
    wheel = empty("ms_lift_wheel", (0.179, 0.146, 0.898), root)
    cylinder("Lift wheel hub", (0, 0, 0), 0.028, 0.045, mat["steel"], wheel, "X")
    points = [
        (
            0.015,
            0.107 * math.cos(i * math.tau / 96),
            0.107 * math.sin(i * math.tau / 96),
        )
        for i in range(96)
    ]
    tube("Lift handwheel rim", points, 0.007, mat["polished"], wheel, cyclic=True)
    for angle in (90, 210, 330):
        a = math.radians(angle)
        tube(
            "Lift handwheel spoke",
            [(0.015, 0, 0), (0.015, 0.104 * math.cos(a), 0.104 * math.sin(a))],
            0.007,
            mat["steel"],
            wheel,
        )
    cylinder(
        "Handwheel crank spindle",
        (0.042, 0, -0.093),
        0.007,
        0.060,
        mat["steel"],
        wheel,
        "X",
    )
    cylinder(
        "Handwheel crank grip",
        (0.075, 0, -0.093),
        0.013,
        0.062,
        mat["black"],
        wheel,
        "X",
    )
    for sign in (-1, 1):
        box(
            "Fixed bowl stopper bracket",
            (sign * 0.155, 0.034, 0.820),
            (0.027, 0.049, 0.054),
            mat["steel"],
            root,
            0.003,
        )
        cylinder(
            "Bowl stopper threaded shank",
            (sign * 0.155, 0.015, 0.794),
            0.006,
            0.034,
            mat["steel"],
            root,
        )
        cylinder(
            "Bowl stopper contact pad",
            (sign * 0.155, 0.015, 0.775),
            0.012,
            0.006,
            mat["black"],
            root,
        )
    guard["preview_rotation_degrees"] = 180
    wheel["rotation_status"] = "Illustrative gesture; gear ratio unmeasured"
    return guard, axis, wheel


def tools(axis, mat):
    whip = empty("ms_whip", (0, 0, 0), axis)
    cylinder("Whip socket", (0, 0, -0.070), 0.027, 0.071, mat["polished"], whip)
    cylinder("Whip hub", (0, 0, -0.112), 0.043, 0.025, mat["steel"], whip)
    profile = [
        (-0.025, -0.117),
        (-0.063, -0.162),
        (-0.096, -0.255),
        (-0.108, -0.338),
        (-0.085, -0.408),
        (-0.042, -0.447),
        (0, -0.455),
        (0.042, -0.447),
        (0.085, -0.408),
        (0.108, -0.338),
        (0.096, -0.255),
        (0.063, -0.162),
        (0.025, -0.117),
    ]
    for index in range(10):
        angle = index * math.pi / 10
        points = [(r * math.cos(angle), r * math.sin(angle), z) for r, z in profile]
        tube("Whip stainless loop", points, 0.002, mat["polished"], whip, smooth=True)
    beater = empty("ms_beater", (0, 0, 0))
    cylinder("Beater socket", (0, 0, -0.070), 0.027, 0.071, mat["aluminium"], beater)
    outer = [
        (0, -0.099),
        (-0.097, -0.166),
        (-0.113, -0.300),
        (-0.091, -0.388),
        (-0.046, -0.440),
        (0, -0.453),
        (0.046, -0.440),
        (0.091, -0.388),
        (0.113, -0.300),
        (0.097, -0.166),
    ]
    inner = [
        (0, -0.121),
        (-0.080, -0.177),
        (-0.096, -0.298),
        (-0.075, -0.380),
        (-0.037, -0.424),
        (0, -0.436),
        (0.037, -0.424),
        (0.075, -0.380),
        (0.096, -0.298),
        (0.080, -0.177),
    ]
    count = len(outer)
    vertices = [
        (x, y, z)
        for y in (-0.006, 0.006)
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
        "Beater cast perimeter", vertices, faces, mat["aluminium"], beater, 0.003
    )
    for start, end in (
        ((0, 0, -0.118), (0, 0, -0.434)),
        ((-0.101, 0, -0.258), (0.079, 0, -0.369)),
        ((0.101, 0, -0.258), (-0.079, 0, -0.369)),
    ):
        bar = box(
            "Beater web",
            (Vector(start) + Vector(end)) / 2,
            (0.014, 0.012, (Vector(end) - Vector(start)).length),
            mat["aluminium"],
            beater,
            0.002,
        )
        bar.rotation_euler = (
            (Vector(end) - Vector(start)).to_track_quat("Z", "Y").to_euler()
        )
    for tool in (whip, beater):
        tool["geometry_status"] = (
            "Appliance tool silhouette estimate; socket engagement and clearances unmeasured"
        )
        tool["mount_origin"] = "Zero local transform under ms_tool_axis"
    return whip, beater


def export(root, filename):
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


def organize(root, beater):
    for name, objects, hidden in (
        ("MS-30 appliance", (root, *root.children_recursive), False),
        (
            "Alternate beater - toggle visibility",
            (beater, *beater.children_recursive),
            True,
        ),
    ):
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
        for obj in objects:
            for owner in list(obj.users_collection):
                owner.objects.unlink(obj)
            collection.objects.link(obj)
        collection.hide_viewport = hidden
        collection.hide_render = hidden
    references = bpy.data.collections.new("Manufacturer references - toggle visibility")
    bpy.context.scene.collection.children.link(references)
    for index, name in enumerate(
        (
            "manufacturer-product.jpg",
            "orthographic-sheet.png",
            "standard-panel.jpg",
            "without-bowl.jpg",
            "bowl-lowered.jpg",
            "bowl-raised.jpg",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / "images" / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        references.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1.5
        obj.location = (index * 1.5, 1, 1)
        obj.rotation_euler.x = math.pi / 2
        obj["status"] = "Reference image only; align using labelled dimensions"
    references.hide_viewport = True
    references.hide_render = True


def studio():
    scene = bpy.context.scene
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1700
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.45
    scene.world = bpy.data.worlds.new("MS-30 studio world")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.55,
        0.59,
        0.65,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.32
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("Studio floor grey", (0.26, 0.28, 0.30, 1), roughness=0.85)
    )
    area_light("Large left softbox", (-2, -2, 3), (0, 0, 0.8), 500, 2.4)
    area_light("Right reflection strip", (1.5, 0, 2.3), (0, 0, 0.8), 350, 1.3)
    area_light("Rear edge reflection", (-0.8, 2, 2.5), (0, 0, 0.8), 500, 1.5)
    area_light("Front bowl fill", (0.3, -2, 1.2), (0, -0.2, 0.8), 60, 1.2)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(collection)
    for obj in set(scene.objects) - before:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    return camera


def pose(guard, lift, wheel, opened):
    guard.rotation_euler.z = math.pi if opened else 0
    lift.location.z = -LIFT_TRAVEL if opened else 0
    wheel.rotation_euler.x = math.pi * 0.7 if opened else 0
    bpy.context.view_layer.update()


def render_views(camera, guard, lift, wheel):
    for name, position, target, scale, opened in (
        ("studio-closed", (1.8, -2.8, 1.9), (0, 0, 0.74), 1.95, False),
        ("studio-open", (1.6, -2.8, 1.8), (0, -0.015, 0.74), 1.95, True),
        ("studio-front", (0, -4, 0.74), (0, 0, 0.74), 1.70, False),
        ("studio-right", (4, 0, 0.74), (0, 0, 0.74), 1.70, False),
        ("studio-detail", (1.2, -2.0, 1.6), (0, -0.16, 1.03), 0.90, True),
    ):
        pose(guard, lift, wheel, opened)
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    pose(guard, lift, wheel, False)


def animation(guard, lift, wheel):
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for frame, opened in ((1, False), (48, True), (72, True), (120, False)):
        pose(guard, lift, wheel, opened)
        for obj, path in (
            (guard, "rotation_euler"),
            (lift, "location"),
            (wheel, "rotation_euler"),
        ):
            obj.keyframe_insert(data_path=path, frame=frame)
    for title, frame in (
        ("Ready", 1),
        ("Guard open / bowl lowered - estimated travel", 48),
        ("Inspect", 72),
        ("Restored", 120),
    ):
        scene.timeline_markers.new(title, frame=frame)
    scene.frame_set(1)


def record(root):
    bpy.context.view_layer.update()
    vertices = []
    for obj in root.children_recursive:
        if obj.type == "MESH":
            vertices.extend(
                obj.matrix_world @ Vector(corner) for corner in obj.bound_box
            )
    low = [min(point[i] for point in vertices) for i in range(3)]
    high = [max(point[i] for point in vertices) for i in range(3)]
    dimensions = [high[i] - low[i] for i in range(3)]
    expected = [0.545, 0.790, 1.445]
    for actual, nominal in zip(dimensions, expected):
        if abs(actual - nominal) > 0.003:
            raise RuntimeError(f"Envelope mismatch: {dimensions}")
    report = {
        "status": "Visual prototype",
        "drawing": "C2-6490A, 2025-09-04",
        "drawing_sha256": hashlib.sha256(
            (REFERENCES / "specifications/outline-ms-30.pdf").read_bytes()
        ).hexdigest(),
        "nominal_dimensions_m": expected,
        "authored_dimensions_m": dimensions,
        "bounds_m": {"min": low, "max": high},
        "preview_lift_m": LIFT_TRAVEL,
        "guard_preview_degrees": 180,
        "assumptions": [
            "Unlabelled bowl profile, tool shape, sheet thickness and pivots inferred from images",
            "120 mm lift and 180 degree guard motion are preview estimates",
            "Handwheel gearing, tool engagement, interlocks and physics remain uncalibrated",
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
        raise RuntimeError("Run in a separate background Blender process")
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "AICOH Mighty S30 - standard manual lift"
    scene.unit_settings.system = "METRIC"
    root = empty("ms_mixer", (0, 0, 0))
    root["model"] = "AICOH MS-30 standard panel, manual bowl lift"
    root["published_mass_kg"] = 287
    root["published_supply"] = (
        "Three-phase 200 V; 1.9 kW rated input; 1.5 kW mixing motor"
    )
    mat = palette()
    frame(root, mat)
    controls(root, mat)
    lift = empty("ms_bowl_lift", (0, 0, 0), root)
    bowl_assembly(lift, mat)
    guard, axis, wheel = mechanisms(root, mat)
    whip, beater = tools(axis, mat)
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    record(root)
    export(root, "aicoh-ms-30.glb")
    export(beater, "aicoh-ms-30-beater.glb")
    whip.parent = None
    export(whip, "aicoh-ms-30-whip.glb")
    whip.parent = axis
    organize(root, beater)
    beater.location = (0.65, 0, 0.60)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, guard, lift, wheel)
    animation(guard, lift, wheel)
    camera.location = (1.8, -2.8, 1.9)
    camera.data.ortho_scale = 1.95
    look_at(camera, (0, 0, 0.74))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "aicoh-ms-30.blend"))
    print("Saved AICOH MS-30 source and exports", ASSETS)


if __name__ == "__main__":
    main()
