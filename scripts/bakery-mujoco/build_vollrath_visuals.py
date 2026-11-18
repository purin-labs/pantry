"""Build the Vollrath Mirage Pro 59500P visual prototype.

Uses current archived photographs and L35791 (2022-03-29). Width remains
provisional: webpage 14 inches versus drawing label 14 1/4 inches (35.6 cm).
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import arc_points, mesh_object
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
ASSETS = ROOT / "assets/bakery-mujoco/vollrath-59500p"
REFERENCES = ROOT / "docs/equipment/vollrath-59500p/images"
WIDTH = 0.3556
DEPTH = 0.38735
HEIGHT = 0.0762


def palette():
    surfaces = {
        "steel": material(
            "Mirage brushed stainless", (0.47, 0.50, 0.53, 1), 0.90, 0.27
        ),
        "chrome": material(
            "Mirage machined aluminium", (0.65, 0.68, 0.70, 1), 0.88, 0.22
        ),
        "glass": material(
            "Mirage black ceramic glass", (0.008, 0.010, 0.012, 1), 0.04, 0.22
        ),
        "black": material("Mirage polymer and seam", (0.008, 0.010, 0.012, 1), 0, 0.42),
        "panel": material("Mirage membrane panel", (0.006, 0.008, 0.010, 1), 0, 0.38),
        "white": material("Mirage white panel ink", (0.75, 0.79, 0.78, 1), 0, 0.55),
        "muted": material("Mirage unlit LCD segments", (0.24, 0.28, 0.28, 1), 0, 0.55),
        "display": material("Mirage LCD window", (0.060, 0.073, 0.069, 1), 0, 0.24),
        "blue": material("Mirage blue dial marks", (0.04, 0.24, 0.40, 1), 0, 0.5),
    }
    for name in ("glass", "panel"):
        surfaces[name].node_tree.nodes["Principled BSDF"].inputs[
            "Specular IOR Level"
        ].default_value = 0.06
    return surfaces


def aperture_outline(width, depth, radius, center_y):
    points = []
    for index in range(128):
        angle = index * math.tau / 128
        dx, dy = math.cos(angle), math.sin(angle)
        ax, ay = abs(dx), abs(dy)
        distance = min(width / (2 * max(ax, 1e-9)), depth / (2 * max(ay, 1e-9)))
        cx, cy = width / 2 - radius, depth / 2 - radius
        if distance * ax > cx and distance * ay > cy:
            projection = ax * cx + ay * cy
            distance = projection + math.sqrt(
                max(0, projection**2 - cx**2 - cy**2 + radius**2)
            )
        points.append((distance * dx, center_y + distance * dy))
    return points


def outline(width, depth, center_y=0):
    # Superellipse follows the gently bowed sides of the pressed housing.
    points = []
    for i in range(128):
        angle = math.tau * i / 128
        c = math.cos(angle)
        s = math.sin(angle)
        points.append(
            (
                width / 2 * math.copysign(abs(c) ** 0.22, c),
                center_y + depth / 2 * math.copysign(abs(s) ** 0.22, s),
            )
        )
    return points


def shell(root, mat):
    rings = [
        (0.014, 0.321, 0.346),
        (0.018, 0.335, 0.358),
        (0.030, 0.340, 0.371),
        (0.038, 0.347, 0.379),
        (0.040, WIDTH, DEPTH),
        (0.046, WIDTH, DEPTH),
    ]
    vertices = []
    for z, width, depth in rings:
        vertices.extend((x, y, z) for x, y in outline(width, depth))
    count = 128
    faces = [tuple(reversed(range(count)))]
    for ring in range(len(rings) - 1):
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
    # Top aperture is a rounded rectangle; correspondence follows the perimeter angle.
    inner = []
    for x, y in aperture_outline(0.294, 0.282, 0.006, 0.020):
        inner.append((x, y, HEIGHT - 0.0002))
    vertices.extend(inner)
    for i in range(count):
        j = (i + 1) % count
        faces.append(
            (
                (len(rings) - 1) * count + i,
                (len(rings) - 1) * count + j,
                len(rings) * count + j,
                len(rings) * count + i,
            )
        )
    obj = mesh_object("Pressed stainless housing", vertices, faces, mat["steel"], root)
    obj.modifiers.remove(obj.modifiers["Weighted surface normals"])
    wall = obj.modifiers.new("Estimated sheet thickness", "SOLIDIFY")
    wall.thickness = 0.0012
    wall.offset = -1
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=wall.name)
    tube(
        "Housing gasket seam",
        [(x, y, 0.039) for x, y in outline(WIDTH - 0.0016, DEPTH - 0.0016)],
        0.0008,
        mat["black"],
        root,
        cyclic=True,
    )
    box(
        "Glass bedding gasket",
        (0, 0.020, 0.0739),
        (0.295, 0.283, 0.004),
        mat["black"],
        root,
        0.007,
    )
    box(
        "Black ceramic cooking plate",
        (0, 0.020, 0.0742),
        (0.292, 0.280, 0.004),
        mat["glass"],
        root,
        0.006,
    )
    zone = empty("vp_cooking_zone", (0, 0.020, HEIGHT), root)
    zone["status"] = "Photo-estimated centre; coil diameter unmeasured"
    tube(
        "Printed centre circle",
        arc_points(0.005, HEIGHT + 0.00002, center=(0, 0.020)),
        0.00013,
        mat["muted"],
        root,
        cyclic=True,
    )
    for y, rotation in ((-0.089, 0), (0.130, math.pi)):
        text = flat_label(
            "Glass warning",
            "INDUCTION RANGE IN USE. SURFACE MAY BE HOT",
            (0, y, HEIGHT + 0.00003),
            0.0021,
            mat["muted"],
            root,
        )
        text.rotation_euler.z = rotation
    for x, y in ((0.119, -0.089), (-0.119, 0.130)):
        tube(
            "Printed hot-surface triangle",
            [
                (x - 0.004, y - 0.003, HEIGHT + 0.00003),
                (x + 0.004, y - 0.003, HEIGHT + 0.00003),
                (x, y + 0.004, HEIGHT + 0.00003),
            ],
            0.00018,
            mat["muted"],
            root,
            cyclic=True,
        )
        flat_label(
            "Hot surface symbol",
            "~",
            (x, y, HEIGHT + 0.00004),
            0.004,
            mat["muted"],
            root,
        )
    return zone


def flat_label(name, value, position, size, surface, parent):
    data = bpy.data.curves.new(name, "FONT")
    data.body = value
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.000005
    data.resolution_u = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    return finish(obj, name, surface, parent)


def controls(root, mat):
    panel = empty("vp_control_panel", (0, -0.161, 0.0622), root)
    panel.rotation_euler.x = math.radians(24.4)
    box(
        "Panel silver bezel",
        (0, 0, 0),
        (0.274, 0.044, 0.002),
        mat["chrome"],
        panel,
        0.006,
    )
    box(
        "Black membrane face",
        (0, 0, 0.0013),
        (0.267, 0.038, 0.001),
        mat["panel"],
        panel,
        0.005,
    )
    buttons = []
    for name, x, caption in (
        ("vp_power_button", -0.110, "power"),
        ("vp_mode_button", -0.078, "power level\ntemp"),
        ("vp_timer_button", -0.046, "time"),
    ):
        button = empty(name, (x, 0, 0.002), panel)
        tube(
            "Button printed ring",
            arc_points(0.009, 0),
            0.0003,
            mat["white"],
            button,
            cyclic=True,
        )
        flat_label(
            "Button caption", caption, (x, -0.013, 0.002), 0.0027, mat["white"], panel
        )
        buttons.append(button)
    tube(
        "Power symbol arc",
        arc_points(0.0044, 0.0001, 130, 410),
        0.0005,
        mat["white"],
        buttons[0],
    )
    tube(
        "Power symbol stroke",
        [(0, 0.005, 0.0001), (0, 0, 0.0001)],
        0.0005,
        mat["white"],
        buttons[0],
    )
    points = []
    for i in range(32):
        angle = i * math.tau / 32
        radius = 0.0053 if i % 4 in (0, 1) else 0.0042
        points.append((radius * math.cos(angle), radius * math.sin(angle), 0.0001))
    tube("Mode gear icon", points, 0.0005, mat["white"], buttons[1], cyclic=True)
    tube(
        "Timer icon",
        arc_points(0.0046, 0.0001, 60, 390),
        0.00045,
        mat["white"],
        buttons[2],
    )
    tube(
        "Timer hands",
        [(0, 0.0038, 0.0001), (0, 0, 0.0001), (-0.0025, 0.001, 0.0001)],
        0.0004,
        mat["white"],
        buttons[2],
    )
    box(
        "LCD display window",
        (0.004, 0, 0.002),
        (0.047, 0.020, 0.0006),
        mat["display"],
        panel,
        0.0004,
    )
    for index in range(3):
        digit(panel, mat, -0.011 + index * 0.015)
    flat_label(
        "Vollrath wordmark",
        "VOLLRATH",
        (0.004, 0.014, 0.002),
        0.0042,
        mat["white"],
        panel,
    )
    flat_label(
        "Mirage Pro wordmark",
        "mirage pro",
        (0.004, -0.014, 0.002),
        0.005,
        mat["white"],
        panel,
    )
    for y, legend in ((0.011, "F°"), (0, "C°"), (-0.011, "time")):
        cylinder(
            "Unlit mode indicator",
            (0.049, y, 0.002),
            0.0025,
            0.0006,
            mat["muted"],
            panel,
        )
        flat_label(
            "Mode legend", legend, (0.060, y, 0.002), 0.0025, mat["white"], panel
        )
    knob = empty("vp_encoder_knob", (0.109, 0, 0.002), panel)
    cylinder("Encoder base", (0, 0, 0.001), 0.016, 0.003, mat["black"], knob)
    cylinder("Knurled encoder rim", (0, 0, 0.004), 0.0153, 0.004, mat["chrome"], knob)
    cylinder("Machined dial face", (0, 0, 0.006), 0.015, 0.001, mat["chrome"], knob)
    for i in range(80):
        angle = i * math.tau / 80
        tube(
            "Dial knurl",
            [
                (0.01535 * math.cos(angle), 0.01535 * math.sin(angle), 0.002),
                (0.01535 * math.cos(angle), 0.01535 * math.sin(angle), 0.0055),
            ],
            0.00016,
            mat["steel"],
            knob,
        )
    for i in range(21):
        angle = math.radians(-80 + i * 8)
        tube(
            "Blue adjustment tick",
            [
                (0.109 + r * math.cos(angle), r * math.sin(angle), 0.002)
                for r in (0.018, 0.0195)
            ],
            0.0002,
            mat["blue"],
            panel,
        )
    knob["status"] = (
        "Visual encoder axis; hardware detents and setting mapping unmeasured"
    )
    return panel, knob, buttons


def digit(panel, mat, x):
    for dx, dy, width, depth in (
        (0, 0.007, 0.009, 0.001),
        (0, 0, 0.009, 0.001),
        (0, -0.007, 0.009, 0.001),
        (-0.005, 0.0035, 0.001, 0.006),
        (0.005, 0.0035, 0.001, 0.006),
        (-0.005, -0.0035, 0.001, 0.006),
        (0.005, -0.0035, 0.001, 0.006),
    ):
        bar = box(
            "Unlit LCD segment",
            (x + dx, dy, 0.0025),
            (width, depth, 0.0001),
            mat["muted"],
            panel,
            0.0002,
        )
        bar.rotation_euler.z = -0.03


def underside(root, mat):
    for x in (-0.139, 0.139):
        for y in (-0.147, 0.147):
            foot = empty(
                "vp_foot_"
                + ("left" if x < 0 else "right")
                + "_"
                + ("front" if y < 0 else "rear"),
                (x, y, 0),
                root,
            )
            cylinder("Rubber foot", (0, 0, 0.007), 0.0115, 0.014, mat["black"], foot)
    # Real openings in the front lower tray, made with a boolean cutter array.
    housing = bpy.data.objects["Pressed stainless housing"]
    cutters = []
    for i in range(37):
        cutter = box(
            "Temporary vent cutter",
            (-0.108 + i * 0.006, -0.181, 0.029),
            (0.0027, 0.035, 0.014),
            mat["black"],
            None,
            0.001,
        )
        bpy.context.view_layer.objects.active = cutter
        for modifier in list(cutter.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        cutters.append(cutter)
    bpy.ops.object.select_all(action="DESELECT")
    for cutter in cutters:
        cutter.select_set(True)
    bpy.context.view_layer.objects.active = cutters[0]
    bpy.ops.object.join()
    cutter = bpy.context.object
    modifier = housing.modifiers.new("Front cooling openings", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.object = cutter
    bpy.context.view_layer.objects.active = housing
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    # The vent cut leaves a large coplanar face with collinear slot corners.
    # Resolve it before glTF float precision collapses a triangle at that seam.
    mesh = bmesh.new()
    mesh.from_mesh(housing.data)
    bmesh.ops.triangulate(mesh, faces=list(mesh.faces))
    bmesh.ops.dissolve_degenerate(mesh, edges=list(mesh.edges), dist=0.0000001)
    mesh.to_mesh(housing.data)
    mesh.free()
    housing.data.update()
    # Bottom plate is visual, with the fan opening cut through the housing cap.
    fan = empty("vp_cooling_fan", (0.095, 0.092, 0.0135), root)
    cylinder("Fan dark recess", (0, 0, -0.0003), 0.039, 0.001, mat["black"], fan)
    box(
        "Fan guard frame",
        (0, 0, -0.001),
        (0.084, 0.084, 0.001),
        mat["steel"],
        fan,
        0.006,
    )
    cylinder("Fan opening", (0, 0, -0.0018), 0.037, 0.001, mat["black"], fan)
    for radius in (0.017, 0.026, 0.034):
        tube(
            "Fan guard ring",
            arc_points(radius, -0.0025),
            0.0012,
            mat["steel"],
            fan,
            cyclic=True,
        )
    for i in range(8):
        a = math.tau * i / 8
        tube(
            "Fan guard spoke",
            [(r * math.cos(a), r * math.sin(a), -0.0025) for r in (0.014, 0.039)],
            0.0012,
            mat["steel"],
            fan,
        )
    cylinder("Fan guard centre", (0, 0, -0.0025), 0.014, 0.001, mat["steel"], fan)
    for x in (-0.035, 0.035):
        for y in (-0.035, 0.035):
            cylinder(
                "Fan guard screw", (x, y, -0.003), 0.0024, 0.001, mat["chrome"], fan
            )
    box(
        "Underside pressed stiffener",
        (0, -0.087, 0.012),
        (0.252, 0.016, 0.004),
        mat["steel"],
        root,
        0.007,
    )
    for x in (-0.146, 0.146):
        for y in (-0.120, 0, 0.120):
            cylinder(
                "Housing assembly screw",
                (x, y, 0.013),
                0.0023,
                0.0012,
                mat["chrome"],
                root,
            )
    return fan


def cord(root, mat):
    lead = empty("vp_power_lead", (0, 0, 0), root)
    cylinder(
        "Cable strain relief",
        (-0.110, 0.187, 0.030),
        0.006,
        0.025,
        mat["black"],
        lead,
        "Y",
    )
    points = [(-0.110, 0.195, 0.030), (-0.112, 0.218, 0.016), (-0.100, 0.244, 0.007)]
    for i in range(141):
        angle = -math.pi / 2 + i * math.tau * 2 / 140
        points.append(
            (
                0.095 * math.cos(angle),
                0.278 + 0.034 * math.sin(angle),
                0.007 + i * 0.00005,
            )
        )
    points.extend([(0.035, 0.243, 0.014), (0.106, 0.251, 0.014)])
    tube("Stowed power cord", points, 0.0033, mat["black"], lead, smooth=True)
    plug = empty("vp_nema_5_15p", (0.127, 0.251, 0.014), lead)
    box("Moulded US plug", (0, 0, 0), (0.044, 0.026, 0.022), mat["black"], plug, 0.005)
    for y in (-0.006, 0.006):
        box(
            "NEMA flat blade",
            (0.029, y, 0.003),
            (0.016, 0.0016, 0.006),
            mat["chrome"],
            plug,
            0.0003,
        )
    cylinder(
        "NEMA ground pin", (0.029, 0, -0.006), 0.0021, 0.016, mat["chrome"], plug, "X"
    )
    box(
        "Cord retaining strap",
        (0, 0.248, 0.012),
        (0.016, 0.024, 0.022),
        mat["black"],
        lead,
        0.002,
    )
    lead["status"] = (
        "Illustrative stowed route; cord length and plug internals unmeasured"
    )
    return lead


def organize(root):
    appliance = bpy.data.collections.new("Vollrath 59500P appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        appliance.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - toggle visibility")
    bpy.context.scene.collection.children.link(refs)
    for i, name in enumerate(
        (
            "manufacturer-02.jpg",
            "manufacturer-04.jpg",
            "manufacturer-06.jpg",
            "manufacturer-08.jpg",
            "manufacturer-01.jpg",
            "dimensioned-orthographic-sheet.png",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.6
        obj.location = (i * 0.7, 1, 0.3)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_viewport = True
    refs.hide_render = True


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
    scene.view_settings.exposure = -0.5
    scene.world = bpy.data.worlds.new("Mirage neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.52,
        0.57,
        0.63,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.3
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("Mirage studio floor", (0.28, 0.30, 0.32, 1), roughness=0.9)
    )
    area_light("Left softbox", (-1, -0.4, 1.5), (0, 0, 0.05), 120, 1)
    area_light("Right stripbox", (0.9, 0.3, 0.8), (0, 0, 0.05), 80, 0.6)
    area_light("Rear reflection", (-0.3, 1, 1), (0, 0, 0.05), 110, 0.8)
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


def render_views(camera, root, lead):
    for name, position, target, scale in (
        ("studio-main", (0.60, -0.82, 0.70), (0, 0.025, 0.025), 0.70),
        ("studio-top", (0, 0.01, 2), (0, 0.01, 0), 0.63),
        ("studio-front", (0, -2, 0.13), (0, 0, 0.043), 0.46),
        ("studio-right", (2, 0, 0.09), (0, 0.03, 0.042), 0.63),
        ("studio-controls", (0.25, -0.65, 0.43), (0, -0.152, 0.057), 0.34),
        ("studio-underside", (0.60, -0.85, 0.85), (0, 0, 0.040), 0.62),
    ):
        if name == "studio-underside":
            root.rotation_euler.y = math.pi
            root.location.z = HEIGHT
            for obj in lead.children_recursive:
                obj.hide_render = True
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    root.rotation_euler.y = 0
    root.location.z = 0
    for obj in lead.children_recursive:
        obj.hide_render = False


def record(root, lead):
    bpy.context.view_layer.update()
    points = []
    excluded = {lead, *lead.children_recursive}
    for obj in root.children_recursive:
        if obj.type == "MESH" and obj not in excluded:
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    report = {
        "status": "Provisional visual prototype",
        "selected_width_m": WIDTH,
        "alternative_drawing_width_m": 0.36195,
        "nominal_depth_m": DEPTH,
        "nominal_height_m": HEIGHT,
        "authored_bounds_m": {"min": low, "max": high},
        "width_conflict": "Product page 14 inches; drawing 14 1/4 inches (35.6 cm). CAD geometry uninspected.",
        "sources": [
            "L35791, 2022-03-29",
            "2350060-1, 2019-11-19",
            "Archived manufacturer photographs",
        ],
        "assumptions": [
            "Shell profiles, glass dimensions, control inclination, fan and foot positions inferred from photos",
            "Unlit display shown; control movements are previews",
            "Cord route illustrative; no calibrated physics or thermal behavior",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "vollrath-59500p.glb").read_bytes()
        ).hexdigest(),
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
    scene.name = "Vollrath Mirage Pro 59500P - provisional 14 inch width"
    scene.unit_settings.system = "METRIC"
    root = empty("vp_hob", (0, 0, 0))
    root["model"] = "Vollrath Mirage Pro 59500P US 120 V / 1800 W"
    root["width_status"] = (
        "355.6 mm selected for visual prototype; 361.95 mm drawing alternative unresolved"
    )
    mat = palette()
    shell(root, mat)
    _panel, knob, buttons = controls(root, mat)
    underside(root, mat)
    lead = cord(root, mat)
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / "vollrath-59500p.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    record(root, lead)
    organize(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, root, lead)
    for frame, angle, press in (
        (1, 0, 0),
        (24, 0, -0.0005),
        (32, 0, 0),
        (72, 90, 0),
        (120, 0, 0),
    ):
        knob.rotation_euler.z = math.radians(angle)
        buttons[0].location.z = 0.002 + press
        knob.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
        buttons[0].keyframe_insert(data_path="location", index=2, frame=frame)
    scene.frame_start = 1
    scene.frame_end = 120
    scene.render.fps = 24
    scene.frame_set(1)
    camera.location = (0.60, -0.82, 0.70)
    camera.data.ortho_scale = 0.70
    look_at(camera, (0, 0.025, 0.025))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "vollrath-59500p.blend"))
    print("Saved Vollrath 59500P visual prototype", ASSETS)


if __name__ == "__main__":
    main()
