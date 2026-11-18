"""Build the two-group Eagle One visual study in metres, Z-up.

Manufacturer exterior dimensions govern the envelope. Undimensioned interfaces
remain photo-derived; this file does not define a physics controller.
"""

import math
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import (
    box,
    cylinder,
    empty,
    material,
    tube,
    convert_curves,
    look_at,
)
from build_mixer_visuals import lathe
from build_linea_classic_s_visuals import studio, text
from victoria_arduino_kit import (
    control_shield,
    group_cover,
    perforated_plate,
    profile_panel,
    rear_emblem,
)

ROOT = Path(__file__).resolve().parents[2]
NAME = "victoria-arduino-eagle-one-2g"
OUT = ROOT / "assets/bakery-mujoco" / NAME


def brew_group(root, m, x, side):
    group = empty(side + "_brew_group", (x, -0.155, 0.304), root)
    group_cover(side + " sculpted chrome group", group, m["chrome"])
    control_shield(side + " curved control inset", group, m["black"])
    for i in range(3):
        x = (i - 1) * 0.023
        y = -0.050 * math.sqrt(1 - (x / 0.063) ** 2) - 0.004
        key = box(
            side + " dose key " + str(i),
            (x, y, 0.055),
            (0.018, 0.003, 0.012),
            m["black"],
            group,
            0.002,
        )
        key.rotation_euler.z = -x * 6
        tube(
            side + " cup icon " + str(i),
            [
                (x - 0.004, y - 0.002, 0.057),
                (x - 0.003, y - 0.002, 0.053),
                (x + 0.003, y - 0.002, 0.053),
                (x + 0.004, y - 0.002, 0.057),
            ],
            0.0003,
            m["chrome"],
            group,
        )
    text(side + " group timer", "00", (0, -0.0526, 0.075), 0.007, m["display"], group)
    cylinder(side + " brew collar", (0, 0, -0.009), 0.045, 0.023, m["chrome"], group)
    pf = empty(side + "_portafilter", (0, 0, -0.025), group)
    lathe(
        side + " portafilter bowl",
        [
            (0.029, 0.009),
            (0.039, 0.005),
            (0.040, -0.008),
            (0.031, -0.022),
            (0.012, -0.025),
            (0.012, -0.020),
            (0.027, -0.016),
            (0.033, -0.004),
            (0.033, 0.009),
        ],
        (0, 0, 0),
        m["chrome"],
        pf,
        48,
    )
    cylinder(
        side + " handle ferrule",
        (0, -0.048, -0.004),
        0.012,
        0.040,
        m["chrome"],
        pf,
        "Y",
    )
    grip = lathe(
        side + " insulated handle",
        [
            (0.0001, 0),
            (0.010, 0),
            (0.013, 0.015),
            (0.015, 0.090),
            (0.013, 0.107),
            (0.0001, 0.112),
        ],
        (0, 0, 0),
        m["black"],
        pf,
        48,
    )
    grip.location = (0, -0.063, -0.004)
    grip.rotation_euler.x = math.pi / 2
    for sign in (-1, 1):
        tube(
            side + " double spout " + str(sign),
            [
                (0, 0, -0.023),
                (sign * 0.017, -0.005, -0.036),
                (sign * 0.022, -0.015, -0.044),
            ],
            0.005,
            m["chrome"],
            pf,
            smooth=True,
        )
    cylinder(side + " basket screen", (0, 0, 0.006), 0.030, 0.001, m["dark"], pf)
    return pf


def steam(root, m, sign):
    side = "left" if sign < 0 else "right"
    x = sign * 0.306
    cylinder(
        side + " valve escutcheon",
        (x, -0.128, 0.344),
        0.024,
        0.008,
        m["chrome"],
        root,
        "Y",
    )
    lever = empty(side + "_steam_lever", (x, -0.137, 0.347), root)
    box(
        side + " steam paddle",
        (0, -0.005, 0.017),
        (0.027, 0.014, 0.055),
        m["chrome"],
        lever,
        0.009,
    )
    for j in range(6):
        box(
            side + " paddle grip rib " + str(j),
            (0, -0.0125, 0.032 + j * 0.002),
            (0.021, 0.001, 0.0007),
            m["dark"],
            lever,
            0.0002,
        )
    cylinder(
        side + " wand escutcheon",
        (x, -0.128, 0.285),
        0.023,
        0.006,
        m["chrome"],
        root,
        "Y",
    )
    wand = empty(side + "_steam_wand", (x, -0.143, 0.285), root)
    tube(
        side + " cool touch wand",
        [
            (0, 0, 0),
            (sign * 0.018, -0.025, 0.016),
            (sign * 0.023, -0.056, 0.055),
            (sign * 0.014, -0.075, 0.061),
            (0, -0.086, 0.033),
            (-sign * 0.007, -0.089, -0.120),
        ],
        0.004,
        m["chrome"],
        wand,
        smooth=True,
    )
    cylinder(
        side + " steam nozzle",
        (-sign * 0.007, -0.089, -0.123),
        0.0055,
        0.014,
        m["chrome"],
        wand,
    )


def build():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    root = empty(NAME, (0, 0, 0))
    root["reference_envelope_m"] = [0.758, 0.576, 0.437]
    root["status"] = "Photo-derived exterior study; physics and fit unqualified"
    m = {
        "steel": material("Eagle satin stainless", (0.58, 0.61, 0.64, 1), 0.88, 0.29),
        "chrome": material("Eagle polished chrome", (0.72, 0.75, 0.78, 1), 0.95, 0.14),
        "black": material("Eagle black polymer", (0.012, 0.014, 0.016, 1), 0.05, 0.32),
        "dark": material("Eagle dark recess", (0.035, 0.040, 0.045, 1), 0.7, 0.28),
        "display": material("Eagle idle display", (0.55, 0.62, 0.64, 1), 0.1, 0.4),
    }
    # Sculpted side panel wraps below the chassis. Profile comes from manual p25.
    profile = [(-0.132, 0.430), (0.254, 0.430), (0.288, 0.094)]
    profile.extend(
        (0.246 + 0.042 * math.cos(a), 0.094 + 0.042 * math.sin(a))
        for a in [-(i * math.pi / 2 / 16) for i in range(1, 17)]
    )
    profile.append((-0.111, 0.052))
    profile.extend(
        (-0.111 + 0.042 * math.cos(a), 0.094 + 0.042 * math.sin(a))
        for a in [-math.pi / 2 - i * math.pi / 2 / 16 for i in range(1, 17)]
    )
    for sign in (-1, 1):
        panel = profile_panel(
            ("left" if sign < 0 else "right") + " side skin",
            sign * 0.369 - 0.010,
            sign * 0.369 + 0.010,
            profile,
            m["steel"],
            root,
        )
        # Lean upper panel edges inward, preserving lower overall width.
        for v in panel.data.vertices:
            v.co.x -= sign * 0.027 * max(0, (v.co.z - 0.09) / 0.34)
        for y in (-0.085, 0.232):
            cylinder(
                "Rubber foot", (sign * 0.315, y, 0.009), 0.021, 0.018, m["black"], root
            )
            cylinder(
                "Adjustable foot collar",
                (sign * 0.315, y, 0.022),
                0.019,
                0.008,
                m["steel"],
                root,
            )
            cylinder(
                "Foot stem", (sign * 0.315, y, 0.045), 0.010, 0.039, m["chrome"], root
            )
    box("Underbody", (0, 0.065, 0.073), (0.714, 0.390, 0.036), m["steel"], root, 0.015)
    rear = box(
        "Rear brushed panel",
        (0, 0.266, 0.259),
        (0.697, 0.004, 0.325),
        m["steel"],
        root,
        0.002,
    )
    rear.rotation_euler.x = math.radians(5)
    box("Rear lower seam", (0, 0.280, 0.089), (0.690, 0.003, 0.003), m["black"], root)
    # Low rear cup guard establishes the published 437 mm top.
    box("Rear cup guard", (0, 0.247, 0.427), (0.680, 0.003, 0.020), m["steel"], root)
    box(
        "Sloped control fascia",
        (0, -0.120, 0.353),
        (0.687, 0.006, 0.133),
        m["steel"],
        root,
        0.003,
    )
    box(
        "Lower splash back",
        (0, -0.108, 0.194),
        (0.704, 0.005, 0.184),
        m["chrome"],
        root,
        0.002,
    )
    for sign in (-1, 1):
        tube(
            "Polished front side rail",
            [
                (sign * 0.349, -0.124, 0.422),
                (sign * 0.364, -0.146, 0.105),
                (sign * 0.355, -0.162, 0.082),
            ],
            0.003,
            m["chrome"],
            root,
        )
    lid = empty("cup_warmer", (0, 0.061, 0.416), root)
    perforated_plate(
        "Cup warmer perforated sheet", 0.676, 0.367, 24, 14, 0.004, m["steel"], lid
    )
    tray = empty("drip_tray", (0, -0.198, 0.090), root)
    box("Drip basin", (0, 0, 0), (0.718, 0.180, 0.029), m["steel"], tray, 0.014)
    box("Drain recess", (0, 0, 0.015), (0.681, 0.153, 0.001), m["black"], tray, 0.004)
    grate = empty("drip_grate", (0, 0, 0.017), tray)
    for i in range(98):
        box(
            "Grate longitudinal wire",
            (-0.333 + i * 0.00687, 0, 0),
            (0.0015, 0.147, 0.0015),
            m["steel"],
            grate,
            0.0004,
        )
    for j in range(22):
        box(
            "Grate cross wire",
            (0, -0.070 + j * 0.00667, -0.0008),
            (0.670, 0.0012, 0.0012),
            m["steel"],
            grate,
            0.0004,
        )
    raised = empty("raised_cup_support", (0, -0.157, 0.132), root)
    perforated_plate(
        "Raised two-tier cup shelf", 0.652, 0.065, 72, 8, 0.0026, m["steel"], raised
    )
    for sign in (-1, 1):
        box(
            "Cup shelf support",
            (sign * 0.318, 0, -0.012),
            (0.009, 0.060, 0.024),
            m["steel"],
            raised,
            0.002,
        )
        box(
            "Shelf finger recess",
            (sign * 0.290, -0.004, 0.0008),
            (0.025, 0.015, 0.001),
            m["dark"],
            raised,
            0.005,
        )
    box(
        "Eagle identity plaque",
        (-0.235, -0.111, 0.174),
        (0.127, 0.001, 0.019),
        m["steel"],
        root,
        0.002,
    )
    text(
        "Front Eagle nameplate",
        "E1   E A G L E  O N E",
        (-0.235, -0.112, 0.174),
        0.008,
        m["dark"],
        root,
    )
    rear_emblem(root, m["chrome"])
    for sign in (-1, 1):
        brew_group(root, m, 0.119 * sign + 0.025, "left" if sign < 0 else "right")
        steam(root, m, sign)
    box(
        "Touchscreen bezel",
        (0.025, -0.127, 0.342),
        (0.079, 0.012, 0.060),
        m["black"],
        root,
        0.003,
    )
    box(
        "Touchscreen glass",
        (0.025, -0.134, 0.344),
        (0.062, 0.001, 0.043),
        m["display"],
        root,
        0.001,
    )
    for i in range(3):
        box(
            "System key " + str(i),
            (0.025 + (i - 1) * 0.022, -0.128, 0.300),
            (0.017, 0.009, 0.012),
            m["black"],
            root,
            0.001,
        )
    cylinder(
        "Hot water valve", (-0.218, -0.129, 0.344), 0.023, 0.009, m["chrome"], root, "Y"
    )
    box(
        "Hot water paddle",
        (-0.218, -0.143, 0.366),
        (0.026, 0.015, 0.052),
        m["chrome"],
        root,
        0.008,
    )
    cylinder(
        "Water outlet escutcheon",
        (-0.218, -0.128, 0.285),
        0.023,
        0.008,
        m["chrome"],
        root,
        "Y",
    )
    tube(
        "Hot water curved outlet",
        [(-0.218, -0.139, 0.285), (-0.218, -0.171, 0.283), (-0.218, -0.179, 0.241)],
        0.007,
        m["chrome"],
        root,
        smooth=True,
    )
    cylinder(
        "Hot water nozzle", (-0.218, -0.179, 0.236), 0.010, 0.022, m["chrome"], root
    )
    # Stable articulation frames are shared by the GLB and MJCF export.
    bpy.context.view_layer.update()
    for side in ("left", "right"):
        for suffix in ("portafilter", "steam_lever", "steam_wand", "brew_group"):
            bpy.data.objects[side + "_" + suffix].name = "eo_" + side + "_" + suffix
        for index in range(3):
            key = bpy.data.objects[f"{side} dose key {index}"]
            pivot = empty(
                f"eo_{side}_dose_{index + 1}", key.location.copy(), key.parent
            )
            key.parent = pivot
            key.location = (0, 0, 0)
            bpy.context.view_layer.update()
            icon = bpy.data.objects[f"{side} cup icon {index}"]
            matrix = icon.matrix_world.copy()
            icon.parent = pivot
            icon.matrix_world = matrix
    for mesh_name, frame in [
        ("System key 0", "eo_power_button"),
        ("Hot water paddle", "eo_hot_water_lever"),
    ]:
        obj = bpy.data.objects[mesh_name]
        pivot = empty(frame, obj.location.copy(), root)
        obj.parent = pivot
        obj.location = (0, 0, 0)
    for obj in root.children_recursive:
        if obj.type == "MESH":
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
    convert_curves(tuple(o for o in scene.objects if o.type == "EMPTY"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT / (NAME + ".glb")),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_extras=True,
    )
    camera = studio()
    scene.cycles.samples = 32
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1100
    for view, position, scale in [
        ("studio-front", (0, -2, 0.25), 0.93),
        ("studio-closed", (1, -1.5, 0.85), 1.08),
        ("studio-back", (-1, 1.5, 0.85), 1.08),
        ("studio-right", (2, 0, 0.25), 0.78),
        ("studio-top", (0, 0, 2), 0.90),
    ]:
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, (0, 0, 0.22))
        scene.render.filepath = str(OUT / (view + ".png"))
        bpy.ops.render.render(write_still=True)
    camera.location = (1, -1.5, 0.85)
    camera.data.ortho_scale = 1.08
    look_at(camera, (0, 0, 0.22))
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / (NAME + ".blend")))


if __name__ == "__main__":
    build()
