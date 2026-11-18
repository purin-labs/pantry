"""Build the Maruzen MIH-02C standard-plate visual model from drawing 03436.

Metres, Z up, front -Y. No heat simulation or calibrated control mechanics.
"""

import argparse
import hashlib
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import mesh_object
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
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-mih-02c"
REFERENCES = ROOT / "docs/equipment/maruzen-mih-02c/images"


def palette():
    mat = {
        "steel": material("MIH No4 stainless", (0.48, 0.51, 0.55, 1), 0.86, 0.28),
        "chrome": material("MIH polished edges", (0.66, 0.69, 0.73, 1), 0.92, 0.20),
        "black": material("MIH black nylon", (0.009, 0.011, 0.014, 1), 0, 0.36),
        "panel": material("MIH black panel", (0.005, 0.006, 0.009, 1), 0, 0.28),
        "rubber": material("MIH rubber feet", (0.018, 0.020, 0.022, 1), 0, 0.64),
        "white": material("MIH printed white", (0.85, 0.87, 0.86, 1), 0, 0.48),
        "red": material("MIH red control field", (0.42, 0.013, 0.020, 1), 0, 0.40),
        "yellow": material("MIH caution yellow", (0.86, 0.65, 0.018, 1), 0, 0.45),
        "green": material("MIH unlit indicator", (0.015, 0.080, 0.03, 1), 0, 0.26),
        "filter": material(
            "MIH dark polyester filter", (0.028, 0.033, 0.036, 1), 0, 0.86
        ),
    }
    ceramic = material("MIH speckled Neoceram", (0.16, 0.16, 0.21, 1), 0.06, 0.31)
    image = bpy.data.images.new("Procedural ceramic granules", width=512, height=512)
    rng = random.Random(3436)
    pixels = []
    for _ in range(512 * 512):
        value = rng.uniform(0.025, 0.14)
        if rng.random() < 0.16:
            value *= 0.30
        pixels.extend((value * 0.88, value * 0.90, value, 1))
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(ASSETS / "ceramic-granules.png")
    image.file_format = "PNG"
    image.save()
    image.pack()
    texture = ceramic.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    ceramic.node_tree.links.new(
        texture.outputs["Color"],
        ceramic.node_tree.nodes["Principled BSDF"].inputs["Base Color"],
    )
    mat["ceramic"] = ceramic
    return mat


def label(name, value, position, size, surface, parent, top=False):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.font = bpy.data.fonts["MIH label font"]
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = 0.000007
    curve.resolution_u = 2
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    if not top:
        obj.rotation_euler.x = math.pi / 2
    return finish(obj, name, surface, parent)


def deck(root, mat):
    box(
        "Front folded deck",
        (0, -0.1875, 0.0995),
        (0.300, 0.075, 0.011),
        mat["steel"],
        root,
        0.002,
    )
    for x in (-0.14375, 0.14375):
        box(
            "Ceramic side surround",
            (x, 0, 0.101),
            (0.0125, 0.300, 0.008),
            mat["steel"],
            root,
            0.001,
        )
    # The rear deck rises 15 mm to the exhaust grille.
    profile = [
        (0.150, 0.097),
        (0.185, 0.112),
        (0.185, 0.120),
        (0.179, 0.120),
        (0.173, 0.111),
        (0.150, 0.105),
    ]
    vertices = [(x, y, z) for x in (-0.150, 0.150) for y, z in profile]
    count = len(profile)
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    mesh_object("Formed rear step", vertices, faces, mat["steel"], root, 0.001)
    box("Plate gasket", (0, 0, 0.100), (0.278, 0.303, 0.004), mat["black"], root, 0.001)
    plate = box(
        "Ceramic cooking plate",
        (0, 0, 0.1025),
        (0.275, 0.300, 0.005),
        mat["ceramic"],
        root,
        0.0006,
    )
    # Map physical X/Y across the full ceramic plate, for consistent GLB grain size.
    uv = plate.data.uv_layers.active
    for polygon in plate.data.polygons:
        for index in polygon.loop_indices:
            coordinate = plate.data.vertices[plate.data.loops[index].vertex_index].co
            uv.data[index].uv = (coordinate.x / 0.275 + 0.5, coordinate.y / 0.300 + 0.5)
    for start in range(0, 360, 30):
        annular_mark(root, mat, 0.094, 0.100, start + 1, start + 29)
    annular_mark(root, mat, 0.077, 0.079, 0, 360)
    zone = empty("mih_cooking_zone", (0, 0, 0.105), root)
    zone["estimated_marking_diameter_m"] = 0.200
    zone["status"] = (
        "Visual placement reference; coil size and usable pan envelope unverified"
    )
    for x in (-0.141, 0.141):
        box(
            "Exhaust end flange",
            (x, 0.205, 0.116),
            (0.018, 0.040, 0.008),
            mat["steel"],
            root,
            0.001,
        )
    box(
        "Exhaust rear flange",
        (0, 0.223, 0.116),
        (0.264, 0.004, 0.008),
        mat["steel"],
        root,
        0.0007,
    )
    box(
        "Exhaust forward flange",
        (0, 0.187, 0.116),
        (0.264, 0.004, 0.008),
        mat["steel"],
        root,
        0.0007,
    )
    for index in range(23):
        x = -0.126 + index * 0.01145
        box(
            "Exhaust grille bridge",
            (x, 0.205, 0.116),
            (0.005, 0.032, 0.008),
            mat["steel"],
            root,
            0.0018,
        )
    box(
        "Exhaust dark interior",
        (0, 0.205, 0.100),
        (0.254, 0.032, 0.002),
        mat["black"],
        root,
    )


def annular_mark(root, mat, inner, outer, start, stop):
    segments = max(4, int((stop - start) / 3))
    vertices = []
    for radius in (inner, outer):
        for i in range(segments + 1):
            angle = math.radians(start + (stop - start) * i / segments)
            vertices.append(
                (radius * math.cos(angle), radius * math.sin(angle), 0.10504)
            )
    count = segments + 1
    faces = [(i, i + 1, count + i + 1, count + i) for i in range(segments)]
    mesh_object("Printed cooking zone ring", vertices, faces, mat["panel"], root)


def chassis(root, mat):
    box(
        "Front stainless fascia",
        (0, -0.214, 0.056),
        (0.298, 0.002, 0.084),
        mat["steel"],
        root,
        0.001,
    )
    box(
        "Rear stainless wall",
        (0, 0.182, 0.056),
        (0.292, 0.002, 0.084),
        mat["steel"],
        root,
        0.001,
    )
    for x in (-0.148, 0.148):
        box(
            "Stainless sidewall",
            (x, -0.016, 0.056),
            (0.002, 0.394, 0.084),
            mat["steel"],
            root,
            0.001,
        )
    box(
        "Chassis underside",
        (0, -0.016, 0.015),
        (0.293, 0.393, 0.002),
        mat["steel"],
        root,
        0.001,
    )
    for x in (-0.133, 0.133):
        for y in (-0.165, 0.160):
            foot = empty(
                "mih_foot_"
                + ("left" if x < 0 else "right")
                + "_"
                + ("front" if y < 0 else "rear"),
                (x, y, 0),
                root,
            )
            cylinder(
                "Foot adjustment stem", (0, 0, 0.012), 0.006, 0.004, mat["chrome"], foot
            )
            cylinder(
                "Rubber adjustable foot",
                (0, 0, 0.005),
                0.012,
                0.010,
                mat["rubber"],
                foot,
            )
            foot["published_adjustment_m"] = [0, 0.015]
    for sign in (-1, 1):
        for y in (-0.185, 0.152):
            cylinder(
                "Sidewall screw",
                (sign * 0.149, y, 0.030),
                0.0024,
                0.0012,
                mat["chrome"],
                root,
                "X",
            )
    intake = empty("mih_filter", (0, -0.035, 0.012), root)
    box(
        "Removable filter frame",
        (0, 0, 0),
        (0.190, 0.215, 0.003),
        mat["black"],
        intake,
        0.002,
    )
    box(
        "Polyester filter insert",
        (0, 0, -0.0018),
        (0.178, 0.203, 0.001),
        mat["filter"],
        intake,
    )
    for index in range(23):
        x = -0.086 + index * 0.0078
        tube(
            "Filter retaining lattice",
            [(x, -0.100, -0.0025), (x, 0.100, -0.0025)],
            0.0005,
            mat["steel"],
            intake,
        )
    for index in range(26):
        y = -0.098 + index * 0.0078
        tube(
            "Filter cross lattice",
            [(-0.088, y, -0.0025), (0.088, y, -0.0025)],
            0.0005,
            mat["steel"],
            intake,
        )
    intake["status"] = "Removable visual group; filter size and attachment inferred"
    return intake


def controls(root, mat):
    box(
        "Front control panel",
        (0.041, -0.2158, 0.054),
        (0.132, 0.0016, 0.066),
        mat["panel"],
        root,
        0.003,
    )
    box(
        "Red power dial field",
        (0.078, -0.217, 0.053),
        (0.045, 0.0008, 0.052),
        mat["red"],
        root,
        0.001,
    )
    label(
        "Maruzen logotype", "Maruzen", (0.079, -0.218, 0.089), 0.010, mat["white"], root
    )
    knob = empty("mih_power_knob", (0.078, -0.218, 0.053), root)
    cylinder("Power knob bezel", (0, 0, 0), 0.0175, 0.003, mat["black"], knob, "Y")
    cylinder("Nylon power knob", (0, -0.008, 0), 0.015, 0.013, mat["black"], knob, "Y")
    for i in range(18):
        angle = math.tau * i / 18
        cylinder(
            "Knob grip flute",
            (0.014 * math.cos(angle), -0.008, 0.014 * math.sin(angle)),
            0.0015,
            0.012,
            mat["black"],
            knob,
            "Y",
        )
    cylinder(
        "Silver knob centre", (0, -0.015, 0), 0.008, 0.002, mat["chrome"], knob, "Y"
    )
    box(
        "Knob index",
        (0, -0.016, 0.011),
        (0.002, 0.001, 0.004),
        mat["white"],
        knob,
        0.0002,
    )
    for index in range(11):
        angle = math.radians(220 - index * 26)
        label(
            "Power scale",
            str(index),
            (0.078 + 0.020 * math.cos(angle), -0.2178, 0.053 + 0.020 * math.sin(angle)),
            0.0033,
            mat["black"],
            root,
        )
    buttons = []
    for name, x, symbol in (
        ("mih_power_button", 0.030, "I/O"),
        ("mih_hold_button", -0.006, "保温"),
    ):
        button = empty(name, (x, -0.218, 0.054), root)
        box(
            "Membrane button",
            (0, 0, 0),
            (0.012, 0.001, 0.016),
            mat["white"],
            button,
            0.001,
        )
        label(
            "Button legend",
            symbol,
            (0, -0.001, 0.001),
            0.004,
            mat["red"] if x < 0 else mat["black"],
            button,
        )
        cylinder(
            "Unlit status lamp",
            (x, -0.218, 0.069),
            0.0022,
            0.001,
            mat["green"],
            root,
            "Y",
        )
        buttons.append(button)
    label(
        "Control captions",
        "電源    出力設定",
        (0.050, -0.218, 0.027),
        0.003,
        mat["white"],
        root,
    )
    knob["preview_rotation_degrees"] = 65
    knob["status"] = (
        "Estimated visual rotation; hardware stops and power mapping unverified"
    )
    return knob, buttons


def labels(root, mat):
    for x in (-0.092, 0.004):
        box(
            "Top warning decal",
            (x, -0.182, 0.1052),
            (0.087, 0.045, 0.00025),
            mat["white"],
            root,
            0.0003,
        )
        box(
            "Warning yellow heading",
            (x, -0.164, 0.1054),
            (0.085, 0.007, 0.00015),
            mat["yellow"],
            root,
        )
        label(
            "Caution heading",
            "△ 注意",
            (x, -0.164, 0.10555),
            0.005,
            mat["black"],
            root,
            True,
        )
    label(
        "Hot surface text",
        "使用後もトッププレートは高温です。\nやけどに注意してください。",
        (-0.092, -0.176, 0.1056),
        0.0030,
        mat["black"],
        root,
        True,
    )
    label(
        "Pan placement text",
        "鍋は中央に置いてください。\n使用後は電源を切ってください。",
        (0.004, -0.176, 0.1056),
        0.0030,
        mat["black"],
        root,
        True,
    )
    for x in (-0.023, 0.028):
        tube(
            "Prohibition slash",
            [(x - 0.008, -0.192, 0.1056), (x + 0.008, -0.203, 0.1056)],
            0.001,
            mat["black"],
            root,
        )
        tube(
            "Prohibition cross",
            [(x - 0.008, -0.203, 0.1056), (x + 0.008, -0.192, 0.1056)],
            0.001,
            mat["black"],
            root,
        )
    for i in range(5):
        box(
            "Small caution text line",
            (-0.092, -0.188 - i * 0.0026, 0.1055),
            (0.072 - i * 0.003, 0.0006, 0.0001),
            mat["black"],
            root,
            0,
        )
    label(
        "Ceramic caution",
        "△ 高温注意",
        (0.074, -0.136, 0.1053),
        0.0045,
        mat["white"],
        root,
        True,
    )
    label("Front badge", "Maruzen", (-0.105, -0.216, 0.088), 0.007, mat["red"], root)
    for x, width in ((-0.104, 0.066), (-0.051, 0.035)):
        box(
            "Front information label",
            (x, -0.216, 0.049),
            (width, 0.0005, 0.047),
            mat["white"],
            root,
            0.0005,
        )
    box(
        "Front caution band",
        (-0.104, -0.2165, 0.067),
        (0.064, 0.0002, 0.008),
        mat["yellow"],
        root,
    )
    label(
        "Front caution heading",
        "△ 注意",
        (-0.104, -0.217, 0.067),
        0.0043,
        mat["black"],
        root,
    )
    label(
        "Front caution text",
        "高温注意\n電源を切って清掃\nIHクリーンコンロ",
        (-0.104, -0.217, 0.047),
        0.0030,
        mat["black"],
        root,
    )
    label(
        "Nameplate",
        "MIH-02C\n単相 200V\n50/60Hz\n2.0kW",
        (-0.051, -0.217, 0.050),
        0.0036,
        mat["black"],
        root,
    )


def cord(root, mat):
    lead = empty("mih_power_lead", (0, 0, 0), root)
    cylinder(
        "Rear cable gland", (0.085, 0.186, 0.034), 0.007, 0.015, mat["black"], lead, "Y"
    )
    points = [(0.085, 0.192, 0.034), (0.086, 0.239, 0.026), (0.116, 0.283, 0.008)]
    for i in range(101):
        angle = -math.pi / 2 + i * math.tau * 1.8 / 100
        points.append(
            (
                0.10 + 0.075 * math.cos(angle),
                0.36 + 0.075 * math.sin(angle),
                0.007 + i * 0.00007,
            )
        )
    points.extend([(0.041, 0.399, 0.018), (-0.003, 0.405, 0.018)])
    tube("Illustrative coiled cable", points, 0.0034, mat["black"], lead, smooth=True)
    plug = empty("mih_plug", (-0.018, 0.405, 0.018), lead)
    cylinder("Plug body", (0, 0, 0), 0.014, 0.034, mat["black"], plug, "X")
    for z in (-0.006, 0.006):
        box(
            "Plug blade",
            (-0.023, 0, z),
            (0.016, 0.0018, 0.006),
            mat["chrome"],
            plug,
            0.0003,
        )
    cylinder("Earth pin", (-0.023, 0.007, 0), 0.002, 0.016, mat["chrome"], plug, "X")
    lead["published_length_m"] = 2.0
    lead["status"] = (
        "Illustrative stowed route and plug; modeled length is not calibrated"
    )
    return lead


def export(root):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / "maruzen-mih-02c.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def references(root):
    appliance = bpy.data.collections.new("MIH-02C appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        appliance.objects.link(obj)
    collection = bpy.data.collections.new("Manufacturer references - toggle visibility")
    bpy.context.scene.collection.children.link(collection)
    for i, name in enumerate(
        (
            "manufacturer-product.jpg",
            "dimensioned-orthographic-sheet.png",
            "orthographic-top.png",
            "orthographic-front.png",
            "orthographic-side.png",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        collection.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.6
        obj.location = (i * 0.7, 1, 0.3)
        obj.rotation_euler.x = math.pi / 2
        obj["status"] = "Reference only; align to labelled dimensions"
    collection.hide_viewport = True
    collection.hide_render = True


def studio():
    scene = bpy.context.scene
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.4
    scene.world = bpy.data.worlds.new("MIH neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.56,
        0.60,
        0.65,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("Studio floor", (0.29, 0.31, 0.33, 1), roughness=0.9)
    )
    area_light("Left softbox", (-1, -1, 1.6), (0, 0, 0.05), 130, 1.1)
    area_light("Right stripbox", (0.8, 0.1, 1), (0, 0, 0.05), 90, 0.7)
    area_light("Rear reflection", (-0.3, 1, 1.2), (0, 0, 0.05), 110, 0.7)
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


def render_views(camera):
    for name, position, target, scale in (
        ("studio-main", (0.65, -0.85, 0.75), (0, 0.06, 0.045), 0.76),
        ("studio-top", (0, 0.01, 2), (0, 0.01, 0), 0.72),
        ("studio-front", (0, -2, 0.065), (0, 0, 0.065), 0.42),
        ("studio-right", (2, 0, 0.09), (0, 0.03, 0.065), 0.77),
        ("studio-controls", (0.35, -0.75, 0.30), (0.012, -0.17, 0.068), 0.34),
    ):
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
        bpy.ops.render.render(write_still=True)


def report(root, lead, knob):
    bpy.context.view_layer.update()
    excluded = (
        set(lead.children_recursive) | {lead} | set(knob.children_recursive) | {knob}
    )
    vertices = []
    for obj in root.children_recursive:
        if obj.type == "MESH" and obj not in excluded:
            vertices.extend(
                obj.matrix_world @ Vector(corner) for corner in obj.bound_box
            )
    minimum = [min(v[i] for v in vertices) for i in range(3)]
    maximum = [max(v[i] for v in vertices) for i in range(3)]
    dimensions = [maximum[i] - minimum[i] for i in range(3)]
    for actual, expected in zip(dimensions, (0.300, 0.450, 0.120)):
        assert abs(actual - expected) < 0.002, (dimensions, minimum, maximum)
    data = {
        "status": "Visual prototype",
        "drawing": "03436, marked 2026.7",
        "drawing_sha256": hashlib.sha256(
            (REFERENCES.parent / "specifications/dimensioned-drawing.pdf").read_bytes()
        ).hexdigest(),
        "nominal_body_m": [0.300, 0.450, 0.120],
        "authored_body_m": dimensions,
        "body_bounds_m": {"min": minimum, "max": maximum},
        "body_bounds_exclusions": ["Power lead and plug", "Projecting output knob"],
        "ceramic_plate_m": [0.275, 0.300],
        "assumptions": [
            "Cooking mark diameter, control angles, filter details and minor profiles inferred",
            "Cord routing and plug geometry illustrative",
            "Warnings reconstructed for visual reference; not operating instructions",
        ],
        "physics": "No MJCF, thermal behavior, interlocks or calibrated contacts",
    }
    (ASSETS / "build-report.json").write_text(json.dumps(data, indent=2) + "\n")


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
    font = bpy.data.fonts.load("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
    font.name = "MIH label font"
    scene = bpy.context.scene
    scene.name = "Maruzen MIH-02C - Japanese standard plate"
    scene.unit_settings.system = "METRIC"
    root = empty("mih_hob", (0, 0, 0))
    root["model"] = "Maruzen MIH-02C standard ceramic plate"
    root["published_supply"] = "Single-phase 200 V, 50/60 Hz, 2.0 kW"
    root["published_mass_kg"] = 10.5
    mat = palette()
    deck(root, mat)
    chassis(root, mat)
    knob, buttons = controls(root, mat)
    labels(root, mat)
    lead = cord(root, mat)
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    report(root, lead, knob)
    export(root)
    references(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera)
    for frame, angle, press in (
        (1, 0, 0),
        (24, 0, 0.001),
        (32, 0, 0),
        (72, 65, 0),
        (120, 0, 0),
    ):
        knob.rotation_euler.y = math.radians(angle)
        buttons[0].location.y = -0.218 + press
        knob.keyframe_insert(data_path="rotation_euler", index=1, frame=frame)
        buttons[0].keyframe_insert(data_path="location", index=1, frame=frame)
    scene.frame_start = 1
    scene.frame_end = 120
    scene.render.fps = 24
    scene.frame_set(1)
    camera.location = (0.65, -0.85, 0.75)
    camera.data.ortho_scale = 0.76
    look_at(camera, (0, 0.06, 0.045))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "maruzen-mih-02c.blend"))
    print("Saved Maruzen MIH-02C", ASSETS)


if __name__ == "__main__":
    main()
