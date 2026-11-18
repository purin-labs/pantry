"""Build the Hario Syphon Technica TCA-3 + BGS-400 Beam Heater visual prototype.

Metres, Z up, front -Y. Published dimensions:
- Hario Technica TCA-3 assembled siphon: 160 x 95 x 333 mm
  - Upper bowl BU-TCA-3: Ø87 x 245 mm (bowl + 140 mm glass downstem)
  - Lower bowl BL-TCA-3: Ø100 x 113 mm (spherical bulb R = 50 mm, neck Ø38 mm)
  - Cloth filter F-103S: Ø62 mm disc + spring + chain + hook
- Hario Beam Heater BGS-400: 200 x 220 x 140 mm (top plate Z = 0.140 m)
- Hario Bamboo Paddle BA-15: 243 x 25 x 8 mm
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
from build_mixer_visuals import lathe
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
from inspect_induction import bounds

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/hario-tca-3"
HEATER_TOP_Z = 0.140
LOWER_BOWL_Z = HEATER_TOP_Z + 0.002
UPPER_BOWL_SEATED_Z = LOWER_BOWL_Z + 0.095


def palette():
    mat = {
        "black": material("Hario matte phenolic black", (0.018, 0.019, 0.022, 1), 0.05, 0.38),
        "rubber": material("Hario silicone gasket", (0.03, 0.032, 0.036, 1), 0.0, 0.55),
        "steel": material("Hario brushed stainless", (0.62, 0.64, 0.67, 1), 0.90, 0.25),
        "chrome": material("Hario chrome stand rod", (0.78, 0.80, 0.83, 1), 0.96, 0.14),
        "brass": material("Hario brass fastener", (0.76, 0.58, 0.26, 1), 0.88, 0.22),
        "glass": material("Hario borosilicate glass", (0.96, 0.98, 0.99, 1), 0.0, 0.05),
        "quartz": material("BGS-400 ceramic quartz top", (0.04, 0.02, 0.025, 1), 0.1, 0.18),
        "halogen": material("BGS-400 halogen glow", (0.98, 0.36, 0.06, 1), emission=2.2),
        "cloth": material("F-103S flannel filter cloth", (0.86, 0.79, 0.66, 1), 0.0, 0.82),
        "bamboo": material("BA-15 natural bamboo", (0.72, 0.54, 0.32, 1), 0.0, 0.48),
    }
    shader = mat["glass"].node_tree.nodes["Principled BSDF"]
    shader.inputs["Transmission Weight"].default_value = 0.92
    shader.inputs["IOR"].default_value = 1.47
    return mat


def turned(name, profile, surface, parent, segments=96):
    return lathe(name, profile, (0, 0, 0), surface, parent, segments)


def build_beam_heater(root, mat):
    """Hario BGS-400 Beam Heater: 200 x 220 x 140 mm."""
    heater = empty("bgs400_heater", (0, 0, 0), root)
    # Rubber feet
    for x in (-0.078, 0.078):
        for y in (-0.085, 0.085):
            cylinder(
                f"Heater foot {x:.2f} {y:.2f}",
                (x, y, 0.004),
                0.012,
                0.008,
                mat["rubber"],
                heater,
            )
    # Main stainless & black body (200 x 220 x 132 mm above 8 mm feet)
    box(
        "BGS-400 lower chassis",
        (0, 0, 0.070),
        (0.196, 0.214, 0.124),
        mat["steel"],
        heater,
        bevel=0.006,
    )
    box(
        "BGS-400 front control panel",
        (0, -0.106, 0.066),
        (0.148, 0.008, 0.096),
        mat["black"],
        heater,
        bevel=0.003,
    )
    # Rotary power dial on the front panel (-Y)
    dial = cylinder(
        "BGS-400 heat dial",
        (0, -0.114, 0.064),
        0.021,
        0.014,
        mat["chrome"],
        heater,
    )
    dial.rotation_euler = (math.pi / 2, 0, 0)
    # Top bezel and glowing halogen quartz window at Z = 0.140 m
    turned(
        "BGS-400 top bezel",
        [
            (0.064, 0.132),
            (0.092, 0.132),
            (0.090, 0.140),
            (0.062, 0.140),
            (0.064, 0.132),
        ],
        mat["black"],
        heater,
    )
    cylinder(
        "BGS-400 quartz heating plate",
        (0, 0, 0.1375),
        0.063,
        0.004,
        mat["quartz"],
        heater,
    )
    cylinder(
        "BGS-400 halogen emitter ring",
        (0, 0, 0.1345),
        0.036,
        0.002,
        mat["halogen"],
        heater,
    )
    return heater, dial


def build_tca3_stand_and_lower_bowl(root, mat):
    """Hario TCA-3 stand + BL-TCA-3 lower glass bulb (Ø100 x 113 mm)."""
    siphon_base = empty("tca3_lower_assembly", (0, 0, LOWER_BOWL_Z), root)

    # Lower glass bulb BL-TCA-3: flat bottom Ø52 mm, spherical belly R = 50 mm, neck Ø38 mm at Z = 113 mm
    lower_profile = [
        (0.0, 0.0),
        (0.026, 0.0),
        (0.039, 0.010),
        (0.048, 0.028),
        (0.050, 0.048),
        (0.047, 0.068),
        (0.036, 0.086),
        (0.021, 0.098),
        (0.0195, 0.111),
        (0.0225, 0.113),
        (0.0195, 0.113),
        (0.0175, 0.110),
        (0.0185, 0.097),
        (0.0335, 0.085),
        (0.0445, 0.067),
        (0.0475, 0.048),
        (0.0455, 0.028),
        (0.0365, 0.011),
        (0.024, 0.0025),
        (0.0, 0.0025),
        (0.0, 0.0),
    ]
    turned("BL-TCA-3 lower glass bowl", lower_profile, mat["glass"], siphon_base)

    # Stainless neck clamp at Z = 0.101 m gripping the lower bowl neck
    turned(
        "TCA-3 stainless neck clamp",
        [
            (0.0192, 0.096),
            (0.0222, 0.096),
            (0.0222, 0.106),
            (0.0192, 0.106),
            (0.0192, 0.096),
        ],
        mat["steel"],
        siphon_base,
    )

    # Stand vertical riser rod (+X side) and matte-black phenolic grip handle
    tube(
        "TCA-3 chrome stand frame",
        [
            (0.022, 0.0, 0.101),
            (0.058, 0.0, 0.101),
            (0.068, 0.0, 0.088),
            (0.068, 0.0, 0.015),
            (0.052, 0.0, 0.002),
        ],
        0.0038,
        mat["chrome"],
        siphon_base,
    )
    turned(
        "TCA-3 phenolic side handle",
        [
            (0.004, 0.022),
            (0.0115, 0.024),
            (0.013, 0.052),
            (0.0115, 0.082),
            (0.004, 0.084),
            (0.004, 0.022),
        ],
        mat["black"],
        empty("tca3_handle_mount", (0.068, 0, 0), siphon_base),
    )
    thumbscrew = cylinder(
        "TCA-3 clamp thumbscrew",
        (0.036, -0.012, 0.101),
        0.005,
        0.012,
        mat["brass"],
        siphon_base,
    )
    thumbscrew.rotation_euler = (math.pi / 2, 0, 0)
    return siphon_base


def build_upper_bowl(root, mat):
    """Hario BU-TCA-3 upper glass bowl (Ø87 x 245 mm) + F-103S cloth filter."""
    upper = empty("tca3_upper_bowl", (0, 0, UPPER_BOWL_SEATED_Z), root)

    # Black silicone neck gasket sealing around the upper bowl stem at Z = 0..0.024 m
    turned(
        "BU-TCA-3 silicone gasket",
        [
            (0.0065, -0.004),
            (0.0185, -0.002),
            (0.0195, 0.018),
            (0.0175, 0.022),
            (0.0065, 0.022),
            (0.0065, -0.004),
        ],
        mat["rubber"],
        upper,
    )

    # Glass funnel bowl (Z = 0.018 to 0.125 m, Ø87 mm mouth) + downstem (Z = -0.082 to 0.018 m)
    upper_profile = [
        (0.0042, -0.082),
        (0.0062, -0.082),
        (0.0065, 0.018),
        (0.024, 0.026),
        (0.039, 0.044),
        (0.0435, 0.072),
        (0.0435, 0.122),
        (0.0448, 0.1245),
        (0.0422, 0.125),
        (0.0410, 0.122),
        (0.0410, 0.072),
        (0.0365, 0.045),
        (0.0215, 0.028),
        (0.0042, 0.020),
        (0.0042, -0.082),
    ]
    turned("BU-TCA-3 upper glass bowl", upper_profile, mat["glass"], upper)

    # F-103S cloth filter disc sitting at the base of the upper bowl (Z = 0.026 m) + pull chain
    cylinder(
        "F-103S cloth filter disc",
        (0, 0, 0.027),
        0.028,
        0.005,
        mat["cloth"],
        upper,
    )
    cylinder(
        "F-103S filter chain",
        (0, 0, -0.028),
        0.0014,
        0.108,
        mat["steel"],
        upper,
    )
    return upper


def build_paddle_and_stand(root, mat):
    """Hario BA-15 bamboo stirring paddle (243 x 25 x 8 mm) and lid stand."""
    paddle = empty("ba15_bamboo_paddle", (0.145, -0.04, 0.125), root)
    box(
        "BA-15 bamboo paddle blade",
        (0, 0, -0.065),
        (0.024, 0.004, 0.095),
        mat["bamboo"],
        paddle,
        bevel=0.0015,
    )
    box(
        "BA-15 bamboo paddle handle",
        (0, 0, 0.055),
        (0.014, 0.006, 0.145),
        mat["bamboo"],
        paddle,
        bevel=0.002,
    )
    box(
        "BA-15 robot grasp collar",
        (0, 0, 0.085),
        (0.018, 0.018, 0.048),
        mat["black"],
        paddle,
        bevel=0.002,
    )

    lid_stand = empty("tca3_lid_stand", (-0.145, -0.02, 0.0), root)
    turned(
        "TCA-3 upper bowl stand",
        [
            (0.0, 0.0),
            (0.036, 0.0),
            (0.034, 0.004),
            (0.024, 0.028),
            (0.046, 0.048),
            (0.046, 0.052),
            (0.043, 0.052),
            (0.021, 0.028),
            (0.0, 0.026),
            (0.0, 0.0),
        ],
        mat["black"],
        lid_stand,
    )
    return paddle, lid_stand


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


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.cycles.transmission_bounces = 8
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1200
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    scene.world = bpy.data.worlds.new("Siphon studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.74,
        0.73,
        0.70,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor - excluded from export"
    floor.data.materials.append(
        material("Siphon studio floor", (0.34, 0.32, 0.30, 1), roughness=0.82)
    )
    area_light("Key softbox", (-0.55, -0.75, 0.85), (0, 0, 0.22), 85, 0.55)
    area_light("Rim softbox", (0.45, 0.55, 0.78), (0, 0, 0.24), 90, 0.45)
    area_light("Front fill", (0.55, -0.35, 0.42), (0, 0, 0.20), 28, 0.45)
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
    root = empty("hario_tca3_station", (0, 0, 0))
    root["model"] = "Hario Syphon Technica TCA-3 + BGS-400 Beam Heater"
    root["status"] = "Articulated visual and MuJoCo station reference"
    mat = palette()
    _heater, _dial = build_beam_heater(root, mat)
    _lower = build_tca3_stand_and_lower_bowl(root, mat)
    upper = build_upper_bowl(root, mat)
    paddle, _lid_stand = build_paddle_and_stand(root, mat)
    prepare_meshes()
    export(root, "hario-tca-3.glb")

    upper.parent = None
    upper.location = (0, 0, 0)
    export(upper, "hario-tca-3-upper-bowl.glb")
    upper.parent = root
    upper.location = (0, 0, UPPER_BOWL_SEATED_Z)

    paddle.parent = None
    paddle.location = (0, 0, 0)
    export(paddle, "hario-tca-3-paddle.glb")
    paddle.parent = root
    paddle.location = (0.145, -0.04, 0.125)

    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    report = {
        "status": "Visual and station prototype",
        "model": root["model"],
        "published_siphon_envelope_m": [0.160, 0.095, 0.333],
        "published_heater_envelope_m": [0.200, 0.220, 0.140],
        "authored_station_envelope_m": [round(float(x), 4) for x in (high - low)],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "hario-tca-3.glb").read_bytes()
        ).hexdigest(),
        "upper_bowl_glb_sha256": hashlib.sha256(
            (ASSETS / "hario-tca-3-upper-bowl.glb").read_bytes()
        ).hexdigest(),
        "paddle_glb_sha256": hashlib.sha256(
            (ASSETS / "hario-tca-3-paddle.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    camera = studio()
    if not args.skip_renders:
        render(camera, "studio-main", (0.52, -0.82, 0.48), (0.0, 0, 0.19), 0.52)
        render(camera, "studio-front", (0, -1.0, 0.19), (0.0, 0, 0.19), 0.48)
        upper.location.z = UPPER_BOWL_SEATED_Z + 0.115
        paddle.location.z = 0.225
        render(camera, "studio-disassembled", (0.56, -0.88, 0.56), (0.0, 0, 0.24), 0.62)
        upper.location.z = UPPER_BOWL_SEATED_Z
        paddle.location.z = 0.125
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "hario-tca-3.blend"))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
