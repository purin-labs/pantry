"""Build the standard Winterhalter UC-L from Japanese and manufacturer references.

Metres, Z up, front -Y. Envelope and rack size are published. Internal fits,
panel profiles and articulation axes are photographic estimates.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_milk_mixer_visuals import prepare_meshes
from build_mixer_visuals import lathe, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    cylinder,
    empty,
    frame,
    look_at,
    material,
    rounded_rectangle,
    tube,
)
from build_quiet_one_visuals import text
from inspect_induction import bounds

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/winterhalter-uc-l"
REFERENCES = ROOT / "docs/equipment/winterhalter-uc-l/images"
HINGE = (0, -0.3015, 0.315)
RACK_ORIGIN = (0, 0.002, 0.332)
REFERENCE_FILES = (
    "product-closed.jpg",
    "product-open.jpg",
    "japan-technical.png",
    "manual-overview.png",
    "manual-wash-fields.png",
)


def palette():
    mat = {
        "steel": material(
            "UC brushed stainless exterior", (0.52, 0.55, 0.58, 1), 0.9, 0.29
        ),
        "inside": material("UC satin wash chamber", (0.59, 0.62, 0.65, 1), 0.85, 0.23),
        "trim": material("UC polished folded edges", (0.67, 0.70, 0.72, 1), 0.94, 0.20),
        "black": material("UC dark polymer", (0.008, 0.011, 0.014, 1), 0, 0.44),
        "seal": material("UC door seal", (0.010, 0.012, 0.014, 1), 0, 0.64),
        "screen": material("UC glass control panel", (0.002, 0.005, 0.008, 1), 0, 0.18),
        "display": material("UC dark touch display", (0.018, 0.042, 0.055, 1), 0, 0.4),
        "blue": material("UC cyan accent", (0.001, 0.31, 0.52, 1), emission=0.30),
        "green": material(
            "UC ready button light", (0.11, 0.58, 0.03, 1), emission=0.65
        ),
        "white": material("UC pale printing", (0.83, 0.87, 0.87, 1), 0, 0.42),
        "rack": material("UC pale coated wire", (0.62, 0.67, 0.66, 1), 0.12, 0.34),
        "arm": material("UC spray field polymer", (0.23, 0.25, 0.26, 1), 0.12, 0.33),
        "brass": material("UC inlet brass", (0.42, 0.29, 0.10, 1), 0.82, 0.32),
    }
    for key in ("steel", "inside"):
        tree = mat[key].node_tree
        coords = tree.nodes.new("ShaderNodeTexCoord")
        scale = tree.nodes.new("ShaderNodeVectorMath")
        scale.operation = "MULTIPLY"
        scale.inputs[1].default_value = (3, 3, 1400)
        noise = tree.nodes.new("ShaderNodeTexNoise")
        bump = tree.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.10
        bump.inputs["Distance"].default_value = 0.000018
        tree.links.new(coords.outputs["Generated"], scale.inputs[0])
        tree.links.new(scale.outputs[0], noise.inputs["Vector"])
        tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
        tree.links.new(
            bump.outputs["Normal"], tree.nodes["Principled BSDF"].inputs["Normal"]
        )
    return mat


def screw(name, position, parent, mat, axis="Y"):
    cylinder(name, position, 0.003, 0.001, mat["trim"], parent, axis=axis)
    if axis == "Y":
        box(
            "Screw drive slot",
            (position[0], position[1] - 0.0006, position[2]),
            (0.0035, 0.0002, 0.0006),
            mat["black"],
            parent,
            0.0001,
        )


def cabinet(root, mat):
    parts = (
        ("Top stainless cover", (0, 0, 0.813), (0.600, 0.603, 0.014), "steel", 0.002),
        (
            "Left insulated wall",
            (-0.2905, 0, 0.409),
            (0.019, 0.603, 0.798),
            "steel",
            0.002,
        ),
        (
            "Right insulated wall",
            (0.2905, 0, 0.409),
            (0.019, 0.603, 0.798),
            "steel",
            0.002,
        ),
        (
            "Rear insulated wall",
            (0, 0.2825, 0.411),
            (0.549, 0.030, 0.800),
            "steel",
            0.002,
        ),
        (
            "Lower machinery enclosure",
            (0, 0, 0.115),
            (0.549, 0.567, 0.206),
            "steel",
            0.002,
        ),
        ("Control fascia", (0, -0.3065, 0.781), (0.600, 0.018, 0.066), "steel", 0.0015),
        ("Interior ceiling", (0, 0, 0.799), (0.548, 0.550, 0.014), "inside", 0.004),
        (
            "Wash chamber back",
            (0, 0.266, 0.490),
            (0.545, 0.004, 0.490),
            "inside",
            0.007,
        ),
        (
            "Left inner liner",
            (-0.273, 0, 0.490),
            (0.004, 0.532, 0.490),
            "inside",
            0.001,
        ),
        (
            "Right inner liner",
            (0.273, 0, 0.490),
            (0.004, 0.532, 0.490),
            "inside",
            0.001,
        ),
        ("Wash tank floor", (0, 0, 0.238), (0.540, 0.532, 0.010), "inside", 0.005),
        ("Front tank wall", (0, -0.274, 0.273), (0.541, 0.010, 0.070), "inside", 0.004),
        ("Entry threshold", (0, -0.267, 0.324), (0.546, 0.026, 0.008), "trim", 0.002),
        (
            "Upper opening jamb",
            (0, -0.263, 0.737),
            (0.546, 0.024, 0.010),
            "inside",
            0.001,
        ),
    )
    for name, position, dimensions, surface, bevel in parts:
        box(name, position, dimensions, mat[surface], root, bevel)
    for side in (-1, 1):
        box(
            "Front corner trim",
            (side * 0.291, -0.3135, 0.409),
            (0.018, 0.006, 0.788),
            mat["trim"],
            root,
            0.001,
        )
        box(
            "Inner rack guide",
            (side * 0.246, -0.003, 0.322),
            (0.023, 0.528, 0.012),
            mat["inside"],
            root,
            0.002,
        )
        # Shallow stamped liner ribs are interpreted from the photographs.
        for y in (-0.180, -0.04, 0.10):
            points = [
                (side * 0.2698, y + u, 0.527 + v)
                for u, v in rounded_rectangle(0.075, 0.322, 0.014, 8)
            ]
            tube(
                "Side liner pressed rib", points, 0.0014, mat["trim"], root, cyclic=True
            )
    for x in (-0.180, -0.06, 0.06, 0.18):
        points = [
            (x + u, 0.2628, 0.534 + v)
            for u, v in rounded_rectangle(0.082, 0.333, 0.014, 8)
        ]
        tube("Rear liner pressed rib", points, 0.0015, mat["trim"], root, cyclic=True)
    seal_points = [
        (x, -0.288, 0.530 + z) for x, z in rounded_rectangle(0.548, 0.408, 0.008, 8)
    ]
    tube("Door perimeter seal", seal_points, 0.003, mat["seal"], root, cyclic=True)
    for x in (-0.278, 0.278):
        for y in (-0.276, 0.269):
            foot = empty(f"ucl_foot_{x}_{y}", (x, y, 0), root)
            cylinder(
                "Low levelling foot", (0, 0, 0.005), 0.012, 0.010, mat["black"], foot
            )
            cylinder("Levelling stem", (0, 0, 0.013), 0.006, 0.014, mat["trim"], foot)
    panel = empty("ucl_lower_service_panel", (0, 0, 0), root)
    box(
        "Lower dosing panel",
        (0, -0.3235, 0.156),
        (0.558, 0.024, 0.280),
        mat["steel"],
        panel,
        0.005,
    )
    box(
        "Dosing panel upper lip",
        (0, -0.329, 0.289),
        (0.550, 0.010, 0.010),
        mat["trim"],
        panel,
        0.002,
    )
    box(
        "Base front folded strip",
        (0, -0.317, 0.015),
        (0.575, 0.014, 0.009),
        mat["trim"],
        root,
        0.001,
    )
    # Exposed back panel and service connections. Hose routing stays unmodeled.
    box(
        "Rear removable service panel",
        (0, 0.3005, 0.445),
        (0.548, 0.002, 0.712),
        mat["steel"],
        root,
        0.001,
    )
    for x in (-0.251, 0.251):
        for z in (0.10, 0.40, 0.781):
            cylinder(
                "Rear panel screw",
                (x, 0.3014, z),
                0.003,
                0.0004,
                mat["trim"],
                root,
                axis="Y",
            )
    ports = empty("ucl_service_connections", (0, 0.278, 0.040), root)
    cylinder(
        "Water inlet G3/4 reference",
        (-0.17, 0.013, 0),
        0.0132,
        0.020,
        mat["brass"],
        ports,
        axis="Y",
    )
    cylinder(
        "Drain hose connection",
        (0.226, 0.011, 0),
        0.013,
        0.020,
        mat["black"],
        ports,
        axis="Y",
    )
    cylinder(
        "Cable gland", (-0.10, 0.012, 0), 0.009, 0.020, mat["black"], ports, axis="Y"
    )
    ports["status"] = (
        "Positions and dimensions estimated; rear connections only, no hoses or cable"
    )
    empty("ucl_loading_site", (0, -0.29, 0.328), root)


def door(root, mat):
    part = empty("ucl_door", HINGE, root)
    box(
        "Door outer stainless skin",
        (0, -0.006, 0.2175),
        (0.559, 0.016, 0.427),
        mat["steel"],
        part,
        0.003,
    )
    box(
        "Door inner wash surface",
        (0, 0.008, 0.2175),
        (0.551, 0.010, 0.423),
        mat["inside"],
        part,
        0.004,
    )
    for x in (-0.269, 0.269):
        box(
            "Door folded side channel",
            (x, 0.012, 0.218),
            (0.009, 0.006, 0.419),
            mat["trim"],
            part,
            0.002,
        )
        for z in (0.038, 0.38):
            screw("Inner door screw", (x, 0.016, z), part, mat)
    # The broad bowed handle follows the photographed integrated stainless grip.
    vertices = []
    for index in range(65):
        x = -0.271 + index * 0.542 / 64
        bow = 0.026 * (1 - (x / 0.271) ** 2)
        for y, z in (
            (-0.028 - bow, 0.383),
            (-0.015 - bow, 0.383),
            (-0.015 - bow, 0.415),
            (-0.028 - bow, 0.415),
        ):
            vertices.append((x, y, z))
    faces = [(3, 2, 1, 0)]
    for index in range(64):
        for j in range(4):
            faces.append(
                (
                    index * 4 + j,
                    index * 4 + (j + 1) % 4,
                    (index + 1) * 4 + (j + 1) % 4,
                    (index + 1) * 4 + j,
                )
            )
    faces.append(tuple(64 * 4 + i for i in range(4)))
    mesh_object(
        "Bowed stainless door handle", vertices, faces, mat["steel"], part, 0.001
    )
    for x in (-0.255, 0.255):
        box(
            "Handle end mount",
            (x, -0.021, 0.399),
            (0.020, 0.016, 0.032),
            mat["steel"],
            part,
            0.003,
        )
    label = text(
        "UC Series door lettering",
        "UC Series",
        (-0.231, -0.0142, 0.284),
        0.027,
        mat["black"],
        part,
        front=True,
    )
    label.rotation_euler.y = -math.pi / 2
    for x in (-0.272, 0.272):
        cylinder(
            "Door hinge barrel", (x, 0, 0), 0.008, 0.012, mat["trim"], part, axis="X"
        )
    empty("ucl_handle_site", (0, -0.0535, 0.400), part)
    part["motion"] = "Visual 0–90 degree rotation around local X; axis unmeasured"
    return part


def controls(root, mat):
    panel = empty("ucl_control_panel", (0.035, -0.317, 0.779), root)
    box(
        "Black control fascia",
        (0, 0, 0),
        (0.288, 0.004, 0.060),
        mat["screen"],
        panel,
        0.003,
    )
    logo = text(
        "Winterhalter wordmark",
        "winterhalter",
        (-0.093, -0.0023, 0.010),
        0.0085,
        mat["white"],
        panel,
        front=True,
        bold=True,
    )
    logo.scale.x = 1.7
    box(
        "Winterhalter blue underline",
        (-0.093, -0.0023, 0.002),
        (0.063, 0.0004, 0.007),
        mat["blue"],
        panel,
        0.0001,
    )
    box(
        "Touch display glass",
        (0.006, -0.0023, 0),
        (0.119, 0.0005, 0.046),
        mat["display"],
        panel,
        0.001,
    )
    for index, x in enumerate((-0.029, 0.006, 0.041)):
        frame(
            "Touch program border",
            (x, -0.0028, -0.002),
            (0.028, 0.027, 0.001),
            (0.026, 0.025, 0.0008),
            0.0003,
            mat["blue"] if index == 1 else mat["white"],
            panel,
        )
        for dot in range(index + 1):
            cylinder(
                "Program intensity dot",
                (x + (dot - index / 2) * 0.005, -0.0032, -0.002),
                0.0015,
                0.0003,
                mat["blue"] if index == 1 else mat["white"],
                panel,
                axis="Y",
            )
    text(
        "Touch more symbol",
        "+",
        (0.006, -0.0033, -0.020),
        0.008,
        mat["white"],
        panel,
        front=True,
    )
    start = empty("ucl_start_button", (0.113, -0.003, 0), panel)
    frame(
        "Ready start indicator border",
        (0, 0, 0),
        (0.040, 0.045, 0.0015),
        (0.036, 0.041, 0.001),
        0.0005,
        mat["green"],
        start,
    )
    for a, b in (
        ((-0.011, 0.009), (-0.002, 0.015)),
        ((0.001, 0.012), (0.011, 0.007)),
        ((-0.009, 0.001), (-0.003, -0.011)),
        ((-0.002, 0.004), (0.010, -0.006)),
    ):
        tube(
            "Start spray pictogram",
            [(a[0], -0.0005, a[1]), (b[0], -0.0005, b[1])],
            0.001,
            mat["green"],
            start,
        )
    panel["status"] = "Static ready-screen reconstruction; no wash-cycle logic"
    return start


def rack(root, mat):
    part = empty("ucl_wash_rack", RACK_ORIGIN, root)
    # A generic coated-wire flat rack at the published 500 x 500 envelope.
    for z in (0, 0.032, 0.102):
        points = [(x, y, z) for x, y in rounded_rectangle(0.494, 0.494, 0.011, 8)]
        tube("Rack perimeter wire", points, 0.003, mat["rack"], part, cyclic=True)
    for index in range(19):
        offset = -0.225 + index * 0.025
        tube(
            "Rack base longitudinal wire",
            [(offset, -0.244, 0), (offset, 0.244, 0)],
            0.002,
            mat["rack"],
            part,
        )
        tube(
            "Rack base transverse wire",
            [(-0.244, offset, 0.003), (0.244, offset, 0.003)],
            0.002,
            mat["rack"],
            part,
        )
    for offset in (-0.22, -0.16, -0.10, -0.04, 0.04, 0.10, 0.16, 0.22):
        for side in (-1, 1):
            tube(
                "Rack side upright",
                [(side * 0.247, offset, 0), (side * 0.247, offset, 0.102)],
                0.0025,
                mat["rack"],
                part,
            )
            tube(
                "Rack front rear upright",
                [(offset, side * 0.247, 0), (offset, side * 0.247, 0.102)],
                0.0025,
                mat["rack"],
                part,
            )
    part["status"] = (
        "Generic flat rack; published 500 x 500 size, wire pattern inferred"
    )
    return part


def spray_field(name, position, parent, mat, inverted=False):
    part = empty(name, position, parent)
    if inverted:
        part.rotation_euler.x = math.pi
    # Broad S-shaped spray field with two curved branches.
    contour = [
        (-0.231, -0.044),
        (-0.22, -0.059),
        (-0.14, -0.060),
        (-0.055, -0.027),
        (0.015, -0.026),
        (0.090, 0.012),
        (0.170, 0.031),
        (0.226, 0.022),
        (0.234, 0.041),
        (0.22, 0.058),
        (0.14, 0.058),
        (0.055, 0.027),
        (-0.015, 0.026),
        (-0.090, -0.012),
        (-0.170, -0.031),
        (-0.225, -0.023),
    ]
    vertices = [(x, y, z) for z in (-0.006, 0.006) for x, y in contour]
    count = len(contour)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend(
        (i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)
    )
    mesh_object("S-shaped wash field", vertices, faces, mat["arm"], part, 0.003)
    for direction in (-1, 1):
        for index in range(6):
            x = direction * (0.058 + index * 0.030)
            y = direction * (0.020 + 0.026 * math.sin(index / 5 * math.pi / 2))
            cylinder(
                "Wash nozzle collar", (x, y, 0.007), 0.0044, 0.002, mat["black"], part
            )
            cylinder(
                "Wash jet opening", (x, y, 0.0082), 0.0018, 0.0004, mat["inside"], part
            )
    cylinder("Wash field central hub", (0, 0, 0.006), 0.030, 0.019, mat["arm"], part)
    cylinder("Wash field release cap", (0, 0, 0.019), 0.018, 0.008, mat["white"], part)
    box(
        "Release cap finger grip",
        (0, 0, 0.025),
        (0.026, 0.007, 0.006),
        mat["white"],
        part,
        0.002,
    )
    part["status"] = "Photographic S-shaped field estimate; no fluid model"
    return part


def filters(root, mat):
    part = empty("ucl_filter_screen", (-0.165, -0.015, 0.251), root)
    plate = box(
        "Filter support plate",
        (0, 0, -0.002),
        (0.142, 0.410, 0.004),
        mat["inside"],
        part,
        0.006,
    )
    # Raised perforation pattern is visual only; not a hydraulic pore model.
    for i in range(14):
        for j in range(40):
            box(
                "Filter perforation",
                (-0.060 + i * 0.009, -0.186 + j * 0.0095, 0.0002),
                (0.0025, 0.004, 0.0004),
                mat["black"],
                part,
                0.0008,
            )
    filter_part = empty("ucl_filter_cylinder", (-0.177, -0.177, 0.251), root)
    lathe(
        "Strainer rim",
        [
            (0.026, 0),
            (0.038, 0),
            (0.040, 0.003),
            (0.035, 0.009),
            (0.028, 0.009),
            (0.026, 0),
        ],
        (0, 0, 0),
        mat["white"],
        filter_part,
        96,
    )
    for i in range(28):
        a = i * math.tau / 28
        tube(
            "Strainer basket bar",
            [
                (0.026 * math.cos(a), 0.026 * math.sin(a), -0.025),
                (0.034 * math.cos(a), 0.034 * math.sin(a), 0.003),
            ],
            0.0011,
            mat["white"],
            filter_part,
        )
    plate["status"] = "Surface-only perforation pattern; not actual openings"


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


def pack_references(root):
    collection = bpy.data.collections.new("Winterhalter UC-L appliance")
    bpy.context.scene.collection.children.link(collection)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for index, name in enumerate(REFERENCE_FILES):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1.2
        obj.location = (index * 1.3, 2, 0.7)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_render = True
    refs.hide_viewport = True


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1500
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.45
    scene.world = bpy.data.worlds.new("UC neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.67,
        0.71,
        0.75,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor - excluded from export"
    floor.data.materials.append(
        material("UC studio floor", (0.29, 0.31, 0.33, 1), roughness=0.8)
    )
    area_light("Large key softbox", (-1.6, -2.0, 2.2), (0, 0, 0.4), 450, 1.6)
    area_light("Rim softbox", (1.2, 1.3, 1.9), (0, 0, 0.4), 400, 1.2)
    area_light("Front fill", (1.0, -1.5, 0.9), (0, 0, 0.4), 110, 0.8)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "ORTHO"
    return camera


def render(camera, name, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)
    bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
    bpy.ops.render.render(write_still=True)


def animate(door_part, rack_part, lower, upper):
    for frame_number, angle, slide, lift in (
        (1, 0, 0, 0),
        (30, 0, 0, 0),
        (65, 90, 0, 0),
        (95, 90, -0.46, 0),
        (120, 90, -0.46, 0.14),
        (145, 90, -0.46, 0),
        (175, 90, 0, 0),
        (220, 0, 0, 0),
        (240, 0, 0, 0),
    ):
        door_part.rotation_euler.x = math.radians(angle)
        rack_part.location = (0, RACK_ORIGIN[1] + slide, RACK_ORIGIN[2] + lift)
        door_part.keyframe_insert(data_path="rotation_euler", frame=frame_number)
        rack_part.keyframe_insert(data_path="location", frame=frame_number)
    for frame_number, angle in ((1, 0), (30, math.tau), (240, math.tau)):
        lower.rotation_euler.z = angle
        upper.rotation_euler.z = -angle
        lower.keyframe_insert(data_path="rotation_euler", frame=frame_number)
        upper.keyframe_insert(data_path="rotation_euler", frame=frame_number)
    bpy.context.scene.frame_end = 240
    bpy.context.scene.render.fps = 24
    bpy.context.scene.frame_set(1)


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
    bpy.context.scene.unit_settings.system = "METRIC"
    root = empty("ucl_dishwasher", (0, 0, 0))
    root["model"] = "Winterhalter UC-L standard, Japanese brochure envelope"
    root["status"] = "Visual prototype; no wash process or MuJoCo dynamics"
    root["reference_height_range_m"] = [0.820, 0.855]
    root["cabinet_depth_m"] = 0.603
    mat = palette()
    cabinet(root, mat)
    door_part = door(root, mat)
    controls(root, mat)
    rack_part = rack(root, mat)
    lower = spray_field("ucl_lower_wash_field", (0, 0.015, 0.285), root, mat)
    upper = spray_field(
        "ucl_upper_wash_field", (0, 0.015, 0.765), root, mat, inverted=True
    )
    filters(root, mat)
    prepare_meshes()
    export(root, "winterhalter-uc-l.glb")
    rack_part.parent = None
    rack_part.location = (0, 0, 0)
    export(rack_part, "winterhalter-500-rack.glb")
    rack_part.parent = root
    rack_part.location = RACK_ORIGIN
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    closed_dimensions = list(high - low)
    door_part.rotation_euler.x = math.pi / 2
    bpy.context.view_layer.update()
    open_low, open_high = bounds(root.children_recursive)
    door_part.rotation_euler.x = 0
    report = {
        "status": "Visual prototype",
        "closed_envelope_m": closed_dimensions,
        "published_cabinet_m": [0.600, 0.603, 0.820],
        "published_closed_depth_m": 0.657,
        "open_depth_m": open_high.y - open_low.y,
        "published_open_depth_m": 1.034,
        "rack_m": [0.500, 0.500],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "winterhalter-uc-l.glb").read_bytes()
        ).hexdigest(),
        "limitations": [
            "Hinge axis, internal dimensions and interfaces estimated",
            "Generic 500 mm flat rack; no exact rack SKU",
            "Japanese electrical installation is not represented by the Australian SKU",
            "No fluid, thermal, chemical, interlock or cleaning simulation",
        ],
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    pack_references(root)
    camera = studio()
    if not args.skip_renders:
        render(camera, "studio-closed", (1.3, -1.8, 1.12), (0, -0.02, 0.40), 1.30)
        render(camera, "studio-front", (0, -2, 0.41), (0, 0, 0.41), 0.97)
        door_part.rotation_euler.x = math.pi / 2
        render(camera, "studio-open", (1.2, -1.8, 1.22), (0, -0.18, 0.39), 1.30)
        rack_part.location.y -= 0.46
        render(camera, "studio-rack-out", (1.2, -1.8, 1.28), (0, -0.18, 0.40), 1.35)
        rack_part.hide_render = True
        for obj in rack_part.children_recursive:
            obj.hide_render = True
        render(camera, "studio-interior", (0.64, -1.65, 1.20), (0, 0, 0.47), 0.94)
        rack_part.hide_render = False
        for obj in rack_part.children_recursive:
            obj.hide_render = False
        rack_part.location = RACK_ORIGIN
        door_part.rotation_euler.x = 0
        render(camera, "studio-rear", (-1.3, 1.8, 1.10), (0, 0, 0.40), 1.30)
    animate(door_part, rack_part, lower, upper)
    camera.location = (1.3, -1.8, 1.12)
    camera.data.ortho_scale = 1.30
    look_at(camera, (0, -0.02, 0.40))
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "winterhalter-uc-l.blend"))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
