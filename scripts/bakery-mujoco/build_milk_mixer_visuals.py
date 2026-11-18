"""Build the Severin SM 3587 visual prototype from manufacturer references.

Metres, Z up, front -Y. The envelope is published. Internal fittings and all
individual part dimensions are estimates from manufacturer photographs.
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
from build_mixer_visuals import lathe, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    look_at,
    material,
    tube,
)
from build_quiet_one_visuals import text
from inspect_induction import bounds

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/severin-sm-3587"
REFERENCES = ROOT / "docs/equipment/severin-sm-3587/images"
JUG_Z = 0.176
LID_Z = 0.247


def palette():
    mat = {
        "black": material("Severin charcoal ABS", (0.007, 0.008, 0.009, 1), 0, 0.40),
        "rubber": material("Severin dark elastomer", (0.007, 0.008, 0.010, 1), 0, 0.58),
        "steel": material(
            "Severin brushed stainless", (0.55, 0.58, 0.60, 1), 0.91, 0.27
        ),
        "chrome": material("Severin polished trim", (0.70, 0.73, 0.76, 1), 0.95, 0.16),
        "ink": material("Severin pale printing", (0.80, 0.83, 0.83, 1), 0, 0.43),
        "screen": material("Severin OLED glass", (0.0015, 0.002, 0.0025, 1), 0, 0.20),
        "pixel": material(
            "Severin OLED ivory pixels", (0.72, 0.79, 0.78, 1), emission=0.5
        ),
        "red": material(
            "Severin red status ring", (0.64, 0.005, 0.001, 1), emission=0.5
        ),
        "clear": material(
            "Severin transparent lid polymer", (0.95, 0.97, 0.99, 1), 0, 0.075
        ),
    }
    mat["black"].node_tree.nodes["Principled BSDF"].inputs[
        "Specular IOR Level"
    ].default_value = 0.25
    shader = mat["clear"].node_tree.nodes["Principled BSDF"]
    shader.inputs["Transmission Weight"].default_value = 1
    shader.inputs["IOR"].default_value = 1.49
    mat["screen"].node_tree.nodes["Principled BSDF"].inputs[
        "Specular IOR Level"
    ].default_value = 0.18
    tree = mat["steel"].node_tree
    coords = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeVectorMath")
    mapping.operation = "MULTIPLY"
    mapping.inputs[1].default_value = (4, 4, 1800)
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.11
    bump.inputs["Distance"].default_value = 0.000012
    tree.links.new(coords.outputs["Generated"], mapping.inputs[0])
    tree.links.new(mapping.outputs[0], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(
        bump.outputs["Normal"], tree.nodes["Principled BSDF"].inputs["Normal"]
    )
    return mat


def turned(name, profile, surface, parent):
    return lathe(name, profile, (0, 0, 0), surface, parent, 160)


def ring(name, inner, outer, low, high, surface, parent):
    return turned(
        name,
        [(inner, low), (outer, low), (outer, high), (inner, high), (inner, low)],
        surface,
        parent,
    )


def base(root, mat):
    turned(
        "Lower base moulding",
        [
            (0, 0),
            (0.059, 0),
            (0.066, 0.001),
            (0.069, 0.004),
            (0.07, 0.010),
            (0.07, 0.012),
            (0, 0.012),
            (0, 0),
        ],
        mat["black"],
        root,
    )
    turned(
        "Tapered black housing",
        [
            (0, 0.0125),
            (0.0699, 0.0125),
            (0.070, 0.018),
            (0.0678, 0.090),
            (0.0645, 0.146),
            (0.064, 0.151),
            (0, 0.151),
            (0, 0.0125),
        ],
        mat["black"],
        root,
    )
    ring("Red 360 degree light ring", 0.060, 0.065, 0.1508, 0.1525, mat["red"], root)
    turned(
        "Stainless induction collar",
        [
            (0.061, 0.1528),
            (0.0648, 0.1528),
            (0.0644, 0.165),
            (0.0635, 0.175),
            (0.0609, 0.175),
            (0.0609, 0.165),
            (0.061, 0.1528),
        ],
        mat["steel"],
        root,
    )
    turned(
        "Recessed jug seating surface",
        [
            (0, 0.166),
            (0.0605, 0.166),
            (0.0605, 0.175),
            (0.059, 0.175),
            (0.057, 0.171),
            (0, 0.171),
            (0, 0.166),
        ],
        mat["black"],
        root,
    )
    # Rear ventilation is visible in the manual. Slot layout is estimated.
    for z in (0.039, 0.045, 0.051):
        for i in range(9):
            angle = math.pi / 2 + (i - 4) * 0.095
            vent = box(
                "Rear ventilation recess",
                (0.069 * math.cos(angle), 0.069 * math.sin(angle), z),
                (0.0042, 0.001, 0.002),
                mat["rubber"],
                root,
                0.0007,
            )
            vent.rotation_euler.z = angle - math.pi / 2
    label = text(
        "Severin wordmark",
        "SEVERIN",
        (0, -0.0664, 0.119),
        0.007,
        mat["ink"],
        root,
        front=True,
        bold=True,
    )
    label.scale.x = 1.55
    label["status"] = "Approximate geometric wordmark"
    tube(
        "Wordmark underline",
        [(-0.0175, -0.0665, 0.1147), (0.0175, -0.0665, 0.1147)],
        0.00025,
        mat["ink"],
        root,
    )
    for angle in (0, 2.094, 4.189):
        cylinder(
            "Underside assembly screw",
            (0.048 * math.cos(angle), 0.048 * math.sin(angle), 0.0007),
            0.0023,
            0.0005,
            mat["steel"],
            root,
        )
    power = empty("sm3587_cord_entry", (0, 0.065, 0.019), root)
    cylinder(
        "Rear cable strain relief",
        (0, 0, 0),
        0.004,
        0.010,
        mat["rubber"],
        power,
        axis="Y",
    )
    power["status"] = (
        "Cord and region-specific plug omitted; cable exit position estimated"
    )


def controls(root, mat):
    mount = empty("sm3587_selector_axis", (0, -0.0685, 0.060), root)
    mount.rotation_euler.x = math.pi / 2
    dial = empty("sm3587_selector", (0, 0, 0), mount)
    ring("Selector shadow gasket", 0.020, 0.026, -0.001, 0.0007, mat["rubber"], dial)
    turned(
        "Knurled selector rim",
        [
            (0.021, 0),
            (0.024, 0),
            (0.0255, 0.004),
            (0.0255, 0.010),
            (0.024, 0.0158),
            (0.022, 0.0165),
            (0.021, 0.014),
            (0.021, 0),
        ],
        mat["chrome"],
        dial,
    )
    for index in range(64):
        angle = index * math.tau / 64
        tube(
            "Selector grip groove",
            [
                (0.02555 * math.cos(angle), 0.02555 * math.sin(angle), 0.002),
                (0.02555 * math.cos(angle), 0.02555 * math.sin(angle), 0.0085),
            ],
            0.00017,
            mat["black"],
            dial,
        )
    # The OLED stays upright while the surrounding selector ring rotates.
    display = empty("sm3587_display_button", (0, -0.0685, 0.060), root)
    display.rotation_euler.x = math.pi / 2
    turned(
        "Circular OLED display",
        [(0, 0.010), (0.0215, 0.010), (0.0215, 0.0157), (0, 0.0157), (0, 0.010)],
        mat["screen"],
        display,
    )
    # Reconstruct the manual's cup-and-steam icon as actual emissive geometry.
    tube(
        "OLED cup outline",
        [
            (-0.008, 0.002, 0.0159),
            (0.008, 0.002, 0.0159),
            (0.008, -0.004, 0.0159),
            (0.005, -0.007, 0.0159),
            (-0.005, -0.007, 0.0159),
            (-0.008, -0.004, 0.0159),
            (-0.008, 0.002, 0.0159),
        ],
        0.00045,
        mat["pixel"],
        display,
    )
    tube(
        "OLED cup handle",
        [
            (0.008, 0.001, 0.0159),
            (0.011, 0.001, 0.0159),
            (0.011, -0.003, 0.0159),
            (0.008, -0.003, 0.0159),
        ],
        0.00045,
        mat["pixel"],
        display,
    )
    for x in (-0.005, 0, 0.005):
        tube(
            "OLED steam line",
            [
                (x + math.sin(i * math.pi / 6) * 0.0008, 0.004 + i * 0.00055, 0.0159)
                for i in range(13)
            ],
            0.00038,
            mat["pixel"],
            display,
        )
    return dial, display


def jug(root, mat):
    part = empty("sm3587_jug", (0, 0, JUG_Z), root)
    profile = [
        (0, 0),
        (0.052, 0),
        (0.058, 0.001),
        (0.061, 0.004),
        (0.062, 0.010),
        (0.064, 0.065),
        (0.065, 0.069),
        (0.065, 0.071),
        (0.0635, 0.071),
        (0.0625, 0.069),
        (0.0618, 0.064),
        (0.0597, 0.010),
        (0.057, 0.005),
        (0, 0.005),
        (0, 0),
    ]
    steel = turned("Hollow stainless milk jug", profile, mat["steel"], part)
    # Deform both walls together into the photographed left-hand pouring lip.
    for vertex in steel.data.vertices:
        x, y, z = vertex.co
        angle = math.atan2(y, x)
        distance = abs(math.atan2(math.sin(angle - math.pi), math.cos(angle - math.pi)))
        flare = max(0, 1 - distance / 0.28) ** 2 * max(0, (z - 0.030) / 0.041)
        vertex.co.x -= 0.010 * flare
    # Open-ended handle: the lower grip does not join the jug wall.
    contour = [
        (0.059, 0.063),
        (0.061, 0.067),
        (0.116, 0.067),
        (0.120, 0.064),
        (0.120, -0.032),
        (0.117, -0.035),
        (0.107, -0.035),
        (0.104, -0.032),
        (0.104, 0.047),
        (0.101, 0.051),
        (0.075, 0.051),
        (0.071, 0.047),
        (0.071, 0.025),
        (0.064, 0.025),
        (0.061, 0.029),
    ]
    vertices = [(x, y, z) for y in (-0.009, 0.009) for x, z in contour]
    count = len(contour)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend(
        (i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)
    )
    mesh_object("Open cool-touch handle", vertices, faces, mat["black"], part, 0.0028)
    box(
        "Handle stainless outer trim",
        (0.1194, 0, 0.0155),
        (0.0012, 0.015, 0.095),
        mat["steel"],
        part,
        0.0005,
    )
    cylinder(
        "Jug central locating boss", (0, 0, 0.012), 0.003, 0.014, mat["steel"], part
    )
    empty("sm3587_pour_site", (-0.075, 0, 0.071), part)
    empty("sm3587_grasp_site", (0.112, 0, 0.005), part)
    part["heating_capacity_ml"] = 700
    part["frothing_capacity_ml"] = 350
    part["minimum_fill_ml"] = 120
    return part


def lid(jug_part, mat):
    lid_part = empty("sm3587_lid", (0, 0, LID_Z - JUG_Z), jug_part)
    turned(
        "Clear annular lid",
        [
            (0.025, -0.001),
            (0.0605, -0.001),
            (0.0605, -0.004),
            (0.0612, -0.004),
            (0.0612, 0.0003),
            (0.0655, 0.0003),
            (0.0655, 0.0015),
            (0.064, 0.003),
            (0.059, 0.003),
            (0.028, 0.0018),
            (0.025, 0.0018),
            (0.025, -0.001),
        ],
        mat["clear"],
        lid_part,
    )
    insert = empty("sm3587_lid_insert", (0, 0, 0), lid_part)
    turned(
        "Transparent twist-out ingredient insert",
        [
            (0, -0.002),
            (0.024, -0.002),
            (0.024, 0.002),
            (0.018, 0.003),
            (0, 0.003),
            (0, -0.002),
        ],
        mat["clear"],
        insert,
    )
    for x in (-0.017, 0.017):
        box(
            "Lid insert grip",
            (x, 0, 0.001),
            (0.003, 0.012, 0.004),
            mat["clear"],
            insert,
            0.001,
        )
    return lid_part, insert


def stirring_tool(jug_part, mat):
    tool = empty("sm3587_stirrer", (0, 0, 0.0085), jug_part)
    ring("Serrated stirrer hub", 0.0037, 0.013, 0, 0.006, mat["black"], tool)
    ring("Serrated stirrer outer ring", 0.012, 0.0185, 0, 0.005, mat["black"], tool)
    for index in range(38):
        angle = index * math.tau / 38
        tooth = box(
            "Stirrer tooth",
            (0.0186 * math.cos(angle), 0.0186 * math.sin(angle), 0.0035),
            (0.0044, 0.0014, 0.007),
            mat["black"],
            tool,
            0.00065,
        )
        tooth.rotation_euler.z = angle
    cover = empty("sm3587_stirrer_cover", (0, 0, 0.009), tool)
    turned(
        "Heating stirrer cover",
        [
            (0.0038, 0),
            (0.022, 0),
            (0.022, 0.0018),
            (0.010, 0.002),
            (0.009, 0.006),
            (0.009, 0.014),
            (0.007, 0.016),
            (0, 0.016),
            (0, 0.011),
            (0.0038, 0.011),
            (0.0038, 0),
        ],
        mat["black"],
        cover,
    )
    return tool, cover


def prepare_meshes():
    convert_curves(
        tuple(obj for obj in bpy.context.scene.objects if obj.type == "EMPTY")
    )
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0000001)
        bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        for face in obj.data.polygons:
            if abs(face.normal.z) > 0.9999:
                face.use_smooth = False


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
    collection = bpy.data.collections.new("Severin SM 3587 appliance")
    bpy.context.scene.collection.children.link(collection)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for index, filename in enumerate(
        ("product.jpg", "detail.jpg", "manual-assembly.png")
    ):
        image = bpy.data.images.load(str(REFERENCES / filename))
        image.pack()
        obj = bpy.data.objects.new(filename, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.5
        obj.location = (index * 0.6, 0.6, 0.25)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_viewport = True
    refs.hide_render = True


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.transmission_bounces = 10
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1500
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.55
    scene.world = bpy.data.worlds.new("Milk mixer studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.68,
        0.71,
        0.76,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor - excluded from export"
    floor.data.materials.append(
        material("Milk mixer studio floor", (0.28, 0.30, 0.32, 1), roughness=0.8)
    )
    area_light("Tall key softbox", (-0.5, -0.6, 0.7), (0, 0, 0.13), 75, 0.5)
    area_light("Rim softbox", (0.3, 0.45, 0.65), (0, 0, 0.15), 80, 0.4)
    area_light("Front fill", (0.5, -0.25, 0.35), (0, 0, 0.15), 20, 0.4)
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


def animate(jug_part, lid_part, tool, cover, dial, display):
    for frame, jug_lift, lid_lift, tool_lift, cap_lift in (
        (1, 0, 0, 0, 0),
        (35, 0, 0.080, 0, 0),
        (65, 0, 0.135, 0.12, 0.025),
        (95, 0.070, 0.135, 0.12, 0.025),
        (125, 0, 0.135, 0.12, 0.025),
        (155, 0, 0.080, 0, 0),
        (180, 0, 0, 0, 0),
    ):
        jug_part.location.z = JUG_Z + jug_lift
        lid_part.location.z = LID_Z - JUG_Z + lid_lift
        tool.location.z = 0.0085 + tool_lift
        cover.location.z = 0.009 + cap_lift
        for obj in (jug_part, lid_part, tool, cover):
            obj.keyframe_insert(data_path="location", frame=frame)
    for frame, angle in ((1, 0), (15, 0.35), (25, 0), (180, 0)):
        dial.rotation_euler.z = angle
        dial.keyframe_insert(data_path="rotation_euler", frame=frame)
    for frame, travel in ((1, 0), (20, 0.0006), (25, 0), (180, 0)):
        display.location.y = -0.0685 + travel
        display.keyframe_insert(data_path="location", frame=frame)
    bpy.context.scene.frame_end = 180
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
    root = empty("sm3587_milk_mixer", (0, 0, 0))
    root["model"] = "Severin SM 3587 Spuma 700 Plus"
    root["status"] = (
        "Visual prototype; no thermal or fluid simulation; Japan supply unverified"
    )
    root["power_w"] = 500
    mat = palette()
    base(root, mat)
    dial, display = controls(root, mat)
    jug_part = jug(root, mat)
    lid_part, _insert = lid(jug_part, mat)
    tool, cover = stirring_tool(jug_part, mat)
    prepare_meshes()
    export(root, "severin-sm-3587.glb")
    jug_part.parent = None
    jug_part.location = (0, 0, 0)
    export(jug_part, "severin-sm-3587-jug.glb")
    jug_part.parent = root
    jug_part.location = (0, 0, JUG_Z)
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    report = {
        "status": "Visual prototype",
        "model": root["model"],
        "published_envelope_m": [0.195, 0.155, 0.250],
        "authored_envelope_m": list(high - low),
        "glb_sha256": hashlib.sha256(
            (ASSETS / "severin-sm-3587.glb").read_bytes()
        ).hexdigest(),
        "limitations": [
            "Part contours and mating clearances estimated from photos",
            "Static hot-milk icon and status light",
            "No MuJoCo dynamics, heat transfer, liquids or recipe validation",
            "European product reference; Japanese supply and 100 V compatibility unverified",
        ],
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    pack_references(root)
    camera = studio()
    if not args.skip_renders:
        render(camera, "studio-main", (0.36, -0.68, 0.40), (0.015, 0, 0.125), 0.36)
        render(camera, "studio-front", (0, -1, 0.125), (0.017, 0, 0.125), 0.32)
        render(camera, "studio-top", (0, 0, 1), (0.015, 0, 0), 0.27)
        lid_part.location.z += 0.115
        tool.location.z += 0.110
        cover.location.z += 0.025
        jug_part.location.z += 0.060
        render(
            camera, "studio-disassembled", (0.42, -0.73, 0.59), (0.015, 0, 0.23), 0.59
        )
        jug_part.location.z = JUG_Z
        lid_part.location.z = LID_Z - JUG_Z
        tool.location.z = 0.0085
        cover.location.z = 0.009
        lid_part.location.x = 0.35
        render(camera, "studio-jug-interior", (0.30, -0.40, 0.70), (0, 0, 0.195), 0.24)
        lid_part.location.x = 0
    animate(jug_part, lid_part, tool, cover, dial, display)
    camera.location = (0.36, -0.68, 0.40)
    camera.data.ortho_scale = 0.36
    look_at(camera, (0.015, 0, 0.125))
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "severin-sm-3587.blend"))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
