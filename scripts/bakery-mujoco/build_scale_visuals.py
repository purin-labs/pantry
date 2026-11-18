"""Build the Japanese OHAUS Ranger 3000 R31PE6 visual prototype.

Metres, Z up, front -Y. Drawing envelope and platform dimensions are known.
Housing contours, internal fittings and control travel are photographic estimates.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import mesh_object
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    look_at,
    material,
    rounded_rectangle,
    tube,
)
from build_quiet_one_visuals import boolean_cut, text
from inspect_induction import bounds

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/ohaus-ranger-3000"
REFERENCES = REPOSITORY / "docs/equipment/ohaus-ranger-3000/images"
PAN_ORIGIN = (0, 0.038, 0.117)
PANEL_ORIGIN = (0, -0.110, 0.071)
FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
REFERENCE_IMAGES = (
    "japan-product.png",
    "japan-controls.png",
    "pan-assembly.png",
    "underside.png",
    "outline-drawing.png",
    "japan-dimensions.png",
)


def palette():
    surfaces = {
        "housing": material("Ranger blue-grey ABS", (0.12, 0.17, 0.21, 1), 0.04, 0.40),
        "base": material("Ranger dark ABS base", (0.022, 0.026, 0.029, 1), 0.02, 0.46),
        "panel": material("Ranger printed fascia", (0.105, 0.137, 0.163, 1), 0, 0.42),
        "white": material("Ranger white printing", (0.88, 0.90, 0.89, 1), 0, 0.5),
        "red": material("OHAUS red polymer", (0.40, 0.002, 0.011, 1), 0, 0.36),
        "steel": material(
            "Ranger brushed stainless", (0.61, 0.64, 0.66, 1), 0.88, 0.28
        ),
        "rubber": material("Ranger rubber contacts", (0.013, 0.016, 0.019, 1), 0, 0.65),
        "screen": material(
            "Ranger smoked LED window", (0.013, 0.002, 0.005, 1), 0.05, 0.22
        ),
        "lit": material(
            "Ranger red LED segments", (0.7, 0.006, 0.001, 1), emission=1.4
        ),
        "dim": material(
            "Ranger dormant LED segments", (0.003, 0.0002, 0.0005, 1), 0, 0.6
        ),
        "green": material("Ranger bubble level fluid", (0.19, 0.39, 0.095, 1), 0, 0.26),
        "amber": material("Ranger low indicator lens", (0.37, 0.20, 0.006, 1), 0, 0.3),
    }
    for key in ("screen", "dim", "red", "panel"):
        shader = surfaces[key].node_tree.nodes["Principled BSDF"]
        shader.inputs["Specular IOR Level"].default_value = 0.15
    return surfaces


def body_shell(name, lower, upper, surface, root):
    # Cross-sections follow the arched side profile seen in the dimensioned drawing.
    sections = (
        (-0.1635, 0.256, 0.012, 0.045),
        (-0.160, 0.294, 0.012, 0.047),
        (-0.148, 0.311, 0.013, 0.053),
        (-0.100, 0.306, 0.019, 0.081),
        (-0.057, 0.299, 0.027, 0.100),
        (0.015, 0.291, 0.033, 0.102),
        (0.085, 0.299, 0.029, 0.102),
        (0.140, 0.311, 0.018, 0.102),
        (0.159, 0.291, 0.016, 0.099),
        (0.1635, 0.249, 0.016, 0.093),
    )
    vertices = []
    for y, width, bottom, top in sections:
        seam = bottom + 0.018
        low = bottom if lower else seam + 0.0006
        high = top if upper else seam
        radius = min(0.006, (high - low) * 0.3)
        for x, z in rounded_rectangle(width, high - low, radius, 10):
            vertices.append((x, y, z + (high + low) / 2))
    count = len(vertices) // len(sections)
    faces = [tuple(reversed(range(count)))]
    for ring in range(len(sections) - 1):
        for i in range(count):
            j = (i + 1) % count
            faces.append(
                (
                    ring * count + i,
                    ring * count + j,
                    (ring + 1) * count + j,
                    (ring + 1) * count + i,
                )
            )
    faces.append(tuple((len(sections) - 1) * count + i for i in range(count)))
    return mesh_object(name, vertices, faces, surface, root, 0.001)


def screw(name, position, parent, mat, axis="Z"):
    part = empty(name, position, parent)
    if axis == "-Z":
        part.rotation_euler.x = math.pi
    cylinder("Recessed cross-head screw", (0, 0, 0), 0.0027, 0.001, mat["steel"], part)
    for angle in (0, math.pi / 2):
        slot = box(
            "Screw drive recess",
            (0, 0, 0.00055),
            (0.0035, 0.0006, 0.0002),
            mat["base"],
            part,
            0.0001,
        )
        slot.rotation_euler.z = angle


def feet(root, mat):
    for index, (x, y) in enumerate(
        ((-0.130, -0.136), (0.130, -0.136), (-0.130, 0.135), (0.130, 0.135))
    ):
        foot = empty(f"ranger_foot_{index + 1}", (x, y, 0), root)
        foot["status"] = "Adjustable levelling foot; thread pitch and range unmeasured"
        cylinder(
            "Rubber foot contact", (0, 0, 0.0015), 0.018, 0.003, mat["rubber"], foot
        )
        cylinder("Red levelling dial", (0, 0, 0.0085), 0.0205, 0.013, mat["red"], foot)
        cylinder("Foot threaded stem", (0, 0, 0.020), 0.005, 0.025, mat["base"], foot)
        for step in range(40):
            angle = step * math.tau / 40
            rib = box(
                "Dial grip flute",
                (0.0202 * math.cos(angle), 0.0202 * math.sin(angle), 0.0085),
                (0.0019, 0.0015, 0.011),
                mat["red"],
                foot,
                0.0005,
            )
            rib.rotation_euler.z = angle
        for z in (0.016, 0.019, 0.022, 0.025):
            cylinder("Stem thread ring", (0, 0, z), 0.0056, 0.0008, mat["base"], foot)


def underside(root, lower, mat):
    cutter = box(
        "Carry recess cutter",
        (0, 0.160, 0.029),
        (0.115, 0.040, 0.029),
        mat["base"],
        None,
        0.007,
    )
    boolean_cut(lower, cutter)
    box(
        "Carry recess shadow",
        (0, 0.148, 0.038),
        (0.106, 0.026, 0.004),
        mat["rubber"],
        root,
        0.004,
    )
    for index in range(5):
        box(
            "Carry grip rib",
            (-0.040 + index * 0.020, 0.149, 0.033),
            (0.005, 0.017, 0.003),
            mat["base"],
            root,
            0.001,
        )
    cover = empty("ranger_interface_cover", (0, -0.060, 0.020), root)
    box(
        "Recessed interface cover",
        (0, 0, 0),
        (0.158, 0.099, 0.006),
        mat["base"],
        cover,
        0.007,
    )
    box(
        "Red service label",
        (0, 0, -0.0032),
        (0.123, 0.065, 0.0004),
        mat["red"],
        cover,
        0.001,
    )
    label = text(
        "Underside model label",
        "OHAUS   R31PE6\n30031769   6 kg / 0.2 g\nVISUAL RECONSTRUCTION",
        (0, 0, -0.0035),
        0.005,
        mat["white"],
        cover,
    )
    label.rotation_euler.x = math.pi
    box(
        "Cover latch",
        (0, -0.119, 0.015),
        (0.024, 0.014, 0.009),
        mat["red"],
        root,
        0.002,
    )
    lock = empty("ranger_menu_lock", (0, -0.132, 0.017), root)
    box("Menu lock slider", (0, 0, 0), (0.020, 0.008, 0.006), mat["red"], lock, 0.001)
    cylinder(
        "Weigh-below blanking plug",
        (0.050, 0.038, 0.031),
        0.010,
        0.002,
        mat["base"],
        root,
    )
    for x, y, z in (
        (-0.113, -0.078, 0.023),
        (0.113, -0.078, 0.023),
        (-0.121, 0.132, 0.018),
        (0.121, 0.132, 0.018),
        (0, 0.126, 0.020),
    ):
        screw("Lower case screw", (x, y, z), root, mat, "-Z")
    socket = empty("ranger_power_inlet", (0.100, 0.158, 0.041), root)
    socket.rotation_euler.x = math.pi / 2
    box(
        "AC inlet surround",
        (0, 0, 0),
        (0.032, 0.021, 0.002),
        mat["base"],
        socket,
        0.003,
    )
    for x in (-0.006, 0.006):
        cylinder("AC inlet well", (x, 0, -0.0015), 0.0057, 0.004, mat["rubber"], socket)
        cylinder("AC inlet pin", (x, 0, -0.0038), 0.0012, 0.002, mat["steel"], socket)
    return cover


def platform(root, mat):
    sub = empty("ranger_subplatform", (0, 0.038, 0.103), root)
    box(
        "Removable ABS subplatform",
        (0, 0, 0.003),
        (0.285, 0.211, 0.006),
        mat["base"],
        sub,
        0.012,
    )
    for x in (-0.108, 0.108):
        for y in (-0.073, 0.073):
            cylinder(
                "Load receiver", (x, 0.038 + y, 0.102), 0.010, 0.010, mat["base"], root
            )
            cylinder(
                "Platform support pad", (x, y, 0.0095), 0.008, 0.007, mat["rubber"], sub
            )
    pan = empty("ranger_weighing_pan", PAN_ORIGIN, root)
    outer = rounded_rectangle(0.300, 0.225, 0.017, 16)
    inner = rounded_rectangle(0.298, 0.223, 0.016, 16)
    vertices = []
    for contour, z in (
        (outer, -0.009),
        (outer, -0.0015),
        (inner, 0),
        (inner, -0.001),
        (inner, -0.009),
    ):
        vertices.extend((x, y, z) for x, y in contour)
    count = len(outer)
    faces = [
        tuple(count * 2 + i for i in range(count)),
        tuple(reversed([count * 3 + i for i in range(count)])),
    ]
    for a, b in ((0, 1), (1, 2), (3, 4), (4, 0)):
        for i in range(count):
            j = (i + 1) % count
            faces.append((a * count + i, a * count + j, b * count + j, b * count + i))
    mesh_object(
        "Folded stainless weighing pan", vertices, faces, mat["steel"], pan, 0.00035
    )
    empty("ranger_load_surface", (0, 0, 0), pan)
    pan["platform_size_m"] = [0.300, 0.225]
    pan["status"] = "Removable pan; underside flange and thickness are estimates"
    return pan, sub


def japanese(name, value, position, size, surface, parent):
    obj = text(name, value, position, size, surface, parent)
    obj.data.font = bpy.data.fonts.load(FONT, check_existing=True)
    return obj


def segment_digit(parent, x, value, mat):
    segments = {
        "a": (0, 0.012, False),
        "b": (0.0065, 0.006, True),
        "c": (0.0065, -0.006, True),
        "d": (0, -0.012, False),
        "e": (-0.0065, -0.006, True),
        "f": (-0.0065, 0.006, True),
        "g": (0, 0, False),
    }
    active = {
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
        " ": " ",
    }
    for key, (sx, sy, vertical) in segments.items():
        contour = [
            (-0.0051, 0),
            (-0.0039, -0.0010),
            (0.0039, -0.0010),
            (0.0051, 0),
            (0.0039, 0.0010),
            (-0.0039, 0.0010),
        ]
        vertices = []
        for u, v in contour:
            if vertical:
                u, v = -v, u
            vertices.append((x + sx + u + (sy + v) * 0.08, sy + v, 0))
        mesh_object(
            "LED segment",
            vertices,
            [tuple(range(6))],
            mat["lit"] if key in active[value] else mat["dim"],
            parent,
        )


def panel(root, mat):
    panel_root = empty("ranger_control_panel", PANEL_ORIGIN, root)
    panel_root.rotation_euler.x = math.radians(29)
    box(
        "Recessed keypad backing",
        (0, 0, -0.001),
        (0.269, 0.093, 0.004),
        mat["base"],
        panel_root,
        0.004,
    )
    box(
        "Printed keypad fascia",
        (0, 0, 0.001),
        (0.264, 0.088, 0.0012),
        mat["panel"],
        panel_root,
        0.003,
    )
    box(
        "White legend band",
        (0, 0.012, 0.0018),
        (0.259, 0.041, 0.0003),
        mat["white"],
        panel_root,
        0.0003,
    )
    box(
        "Red display header",
        (-0.007, 0.036, 0.002),
        (0.144, 0.012, 0.0004),
        mat["red"],
        panel_root,
        0.0001,
    )
    box(
        "Smoked LED display window",
        (-0.007, 0.013, 0.0023),
        (0.144, 0.036, 0.0005),
        mat["screen"],
        panel_root,
        0.0004,
    )
    display = empty("ranger_display", (-0.007, 0.013, 0.0027), panel_root)
    for index, value in enumerate("    00"):
        segment_digit(display, -0.046 + index * 0.018, value, mat)
    cylinder(
        "LED decimal point",
        (0.0345, -0.0145, 0.0001),
        0.001,
        0.0002,
        mat["lit"],
        display,
    )
    text("Gram indicator", "g", (0.064, -0.006, 0.0001), 0.0055, mat["lit"], display)
    text("Stable indicator", "*", (-0.066, -0.010, 0.0001), 0.0045, mat["lit"], display)
    text("Zero indicator", ">0<", (-0.065, 0.007, 0.0001), 0.0035, mat["lit"], display)
    text(
        "OHAUS wordmark",
        "OHAUS",
        (-0.106, 0.003, 0.0021),
        0.0065,
        mat["red"],
        panel_root,
        bold=True,
    )
    logo = empty("OHAUS approximate emblem", (-0.106, 0.017, 0.0021), panel_root)
    ellipse = cylinder("Logo ellipse", (0, 0, 0), 0.009, 0.00015, mat["red"], logo)
    ellipse.scale = (1.3, 0.67, 1)
    ellipse.rotation_euler.z = math.radians(35)
    for sign in (-1, 1):
        mesh_object(
            "Logo corner",
            [
                (sign * 0.012, sign * 0.010, 0),
                (sign * 0.012, -sign * 0.001, 0),
                (-sign * 0.003, sign * 0.010, 0),
            ],
            [(0, 1, 2)],
            mat["red"],
            logo,
        )
    text(
        "Ranger model branding",
        "RANGER3000",
        (0.043, -0.010, 0.0021),
        0.005,
        mat["white"],
        panel_root,
        bold=True,
    )
    japanese(
        "Accumulation label",
        "累積",
        (-0.060, -0.010, 0.0021),
        0.0037,
        mat["white"],
        panel_root,
    )
    for index, color in enumerate(("red", "green", "amber")):
        cylinder(
            "Check weight indicator",
            (-0.085, 0.024 - index * 0.011, 0.0021),
            0.0021,
            0.0003,
            mat[color],
            panel_root,
        )
    level = empty("ranger_bubble_level", (0.106, 0.013, 0.002), panel_root)
    cylinder("Level metal bezel", (0, 0, 0), 0.010, 0.0012, mat["steel"], level)
    cylinder("Level dark well", (0, 0, 0.0007), 0.0085, 0.001, mat["base"], level)
    cylinder("Level fluid window", (0, 0, 0.0013), 0.0075, 0.0003, mat["green"], level)
    tube(
        "Level target ring",
        [
            (
                0.0045 * math.cos(i * math.tau / 64),
                0.0045 * math.sin(i * math.tau / 64),
                0.00155,
            )
            for i in range(64)
        ],
        0.00025,
        mat["white"],
        level,
        cyclic=True,
    )
    cylinder(
        "Centered level bubble", (0, 0, 0.0017), 0.0024, 0.00015, mat["white"], level
    )
    buttons = []
    for index, (name, value, below) in enumerate(
        (
            ("zero", "入/ゼロ\n切", "決定"),
            ("print", "印字\n単位", "次へ"),
            ("function", "機能\nモード", "戻る"),
            ("accumulate", "合計+\nメニュー", "終了"),
            ("tare", "風袋", ""),
        )
    ):
        x = -0.064 + index * 0.039
        y = -0.027 if index < 4 else -0.020
        button = empty("ranger_" + name + "_button", (x, y, 0.0023), panel_root)
        box(
            "Button pale outline",
            (0, 0, 0),
            (0.030, 0.013, 0.0005),
            mat["white"],
            button,
            0.0007,
        )
        box(
            "Button face",
            (0, 0, 0.00035),
            (0.0288, 0.0118, 0.0005),
            mat["panel"],
            button,
            0.0006,
        )
        japanese("Button label", value, (0, 0, 0.00065), 0.0042, mat["white"], button)
        if below:
            japanese(
                "Menu navigation label",
                below,
                (x, y - 0.011, 0.0021),
                0.0034,
                mat["white"],
                panel_root,
            )
        buttons.append(button)
    return buttons


def clean_meshes():
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
        mesh.to_mesh(obj.data)
        mesh.free()


def export(root, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / name),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def references_and_collection(root):
    collection = bpy.data.collections.new("OHAUS Ranger 3000 appliance")
    bpy.context.scene.collection.children.link(collection)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for index, name in enumerate(REFERENCE_IMAGES):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.65
        obj.location = (index * 0.7, 1, 0.4)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_render = True
    refs.hide_viewport = True


def studio():
    scene = bpy.context.scene
    existing = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.45
    scene.world = bpy.data.worlds.new("Scale neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.65,
        0.68,
        0.72,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(
        material("Scale studio floor", (0.30, 0.32, 0.34, 1), roughness=0.8)
    )
    area_light("Large key", (-0.7, -0.7, 1.0), (0, 0, 0.05), 100, 0.7)
    area_light("Rim softbox", (0.4, 0.6, 0.7), (0, 0, 0.08), 90, 0.5)
    area_light("Front fill", (0.6, -0.1, 0.5), (0, 0, 0.06), 35, 0.5)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from export")
    scene.collection.children.link(collection)
    for obj in set(scene.objects) - existing:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    return camera, floor


def render(camera, name, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)
    bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
    bpy.ops.render.render(write_still=True)


def animate(pan, sub, buttons):
    for frame, lift, sub_lift in (
        (1, 0, 0),
        (40, 0.085, 0),
        (75, 0.13, 0.065),
        (105, 0.085, 0),
        (140, 0, 0),
        (180, 0, 0),
    ):
        pan.location.z = PAN_ORIGIN[2] + lift
        sub.location.z = 0.103 + sub_lift
        pan.keyframe_insert(data_path="location", frame=frame)
        sub.keyframe_insert(data_path="location", frame=frame)
    for frame, depth in ((1, 0), (145, 0), (152, -0.00035), (160, 0), (180, 0)):
        buttons[-1].location.z = 0.0023 + depth
        buttons[-1].keyframe_insert(data_path="location", frame=frame)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 180
    scene.render.fps = 24
    scene.frame_set(1)


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
    scene.unit_settings.system = "METRIC"
    root = empty("ranger_scale", (0, 0, 0))
    root["model"] = "OHAUS Ranger 3000 R31PE6, Japanese item 30031769"
    root["capacity_kg"] = 6.0
    root["readability_g"] = 0.2
    root["status"] = "Visual prototype only; no metrology or load-cell simulation"
    mat = palette()
    lower = body_shell("Arched dark lower housing", True, False, mat["base"], root)
    upper = body_shell(
        "Sculpted blue-grey upper housing", False, True, mat["housing"], root
    )
    cutter = box(
        "Keypad recess cutter",
        PANEL_ORIGIN,
        (0.273, 0.097, 0.040),
        mat["base"],
        None,
        0.004,
    )
    cutter.rotation_euler.x = math.radians(29)
    boolean_cut(upper, cutter)
    feet(root, mat)
    underside(root, lower, mat)
    pan, sub = platform(root, mat)
    buttons = panel(root, mat)
    clean_meshes()
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    export(root, "ohaus-r31pe6.glb")
    pan.parent = None
    pan.location = (0, 0, 0)
    export(pan, "ohaus-ranger-weighing-pan.glb")
    pan.parent = root
    pan.location = PAN_ORIGIN
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    report = {
        "status": "Visual prototype",
        "model": "R31PE6 / 30031769 (Japan)",
        "drawing_envelope_m": [0.311, 0.327, 0.117],
        "authored_envelope_m": list(high - low),
        "platform_dimensions_m": [0.300, 0.225],
        "assumptions": [
            "Housing curves, mounting surfaces, feet threads and button travel inferred from drawings/photos",
            "Display is a static zero preview; no weight sensing, tare logic or capacity calibration",
            "Drawing width/depth used; product web specification reverses these axes",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "ohaus-r31pe6.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    references_and_collection(root)
    camera, floor = studio()
    if not args.skip_renders:
        render(camera, "studio-main", (0.52, -0.74, 0.54), (0, 0, 0.045), 0.51)
        render(camera, "studio-front", (0, -1, 0.34), (0, -0.04, 0.05), 0.40)
        render(camera, "studio-top", (0, 0, 1), (0, 0, 0), 0.43)
        pan.location.z += 0.12
        sub.location.z += 0.06
        render(camera, "studio-disassembled", (0.52, -0.74, 0.59), (0, 0, 0.11), 0.54)
        pan.location = PAN_ORIGIN
        sub.location.z = 0.103
        floor.hide_render = True
        render(camera, "studio-underside", (0.45, -0.6, -0.65), (0, 0, 0.05), 0.50)
        floor.hide_render = False
    animate(pan, sub, buttons)
    camera.location = (0.52, -0.74, 0.54)
    camera.data.ortho_scale = 0.51
    look_at(camera, (0, 0, 0.045))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "ohaus-r31pe6.blend"))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
