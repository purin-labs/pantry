"""Build the Panasonic KZ-CK1402 commercial induction hotplate visual model.

Metres, Z up, front -Y.
Published envelope: 304 x 345 x 54 mm (W x D x H), mass 2.5 kg, load capacity 20 kg.
Electrical supply: Japan single-phase 100 V AC (50/60 Hz shared), 1,400 W (75 W eq. - 1,400 W,
7 stages, plus 1,000 W power-save mode and 140-200 degC 7-stage frying temperature control).
Top plate: 296 x 286 mm black crystallized glass (Z = 0.054 m) with 190 mm cooking zone ring
and usable flat pan bottom diameter 120-260 mm.
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
from build_mixer_visuals import mesh_object
from build_oven_visuals import (
    area_light,
    box,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    tube,
)

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/panasonic-kz-ck1402"
REFERENCES = ROOT / "docs/equipment/panasonic-kz-ck1402/images"

WIDTH = 0.3040
DEPTH = 0.3450
HEIGHT = 0.0540

PLATE_WIDTH = 0.2960
PLATE_DEPTH = 0.2860
PLATE_CENTER_Y = 0.0245
PLATE_TOP_Z = 0.0540
ZONE_CENTER_Y = 0.0200
ZONE_DIAMETER = 0.1900

PANEL_ORIGIN = (0.0, -0.1450, 0.0440)
PANEL_TILT_RAD = math.radians(16.0)

BUTTON_SPECS = (
    ("kz_timer_button", -0.0786, 0.0170, 0.0155, "切タイマー", "dark"),
    ("kz_simmer_button", -0.0566, 0.0170, 0.0155, "とろ火", "dark"),
    ("kz_high_button", -0.0386, 0.0170, 0.0155, "強火", "dark"),
    ("kz_down_button", 0.0395, 0.0170, 0.0155, "＜", "dark"),
    ("kz_up_button", 0.0573, 0.0170, 0.0155, "＞", "dark"),
    ("kz_course_button", 0.0794, 0.0175, 0.0155, "コース", "dark"),
    ("kz_start_button", 0.1045, 0.0250, 0.0155, "スタート", "start"),
)

FOOT_POSITIONS = (
    ("kz_foot_left_front", -0.1200, -0.1274),
    ("kz_foot_right_front", 0.1200, -0.1274),
    ("kz_foot_left_rear", -0.1200, 0.1468),
    ("kz_foot_right_rear", 0.1200, 0.1468),
)


def clean_mesh_object(obj, sharp_z=False, recalc_normals=True):
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    for mod in list(obj.modifiers):
        if mod.type in {"WEIGHTED_NORMAL", "WELD"}:
            obj.modifiers.remove(mod)
        else:
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.loops.layers.float_vector.verify()
    for layer_name in list(bm.loops.layers.float_vector.keys()):
        if "normal" in layer_name.lower():
            bm.loops.layers.float_vector.remove(bm.loops.layers.float_vector[layer_name])
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=list(bm.edges))
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    seen = set()
    to_delete = []
    for f in bm.faces:
        if len(f.verts) < 3:
            to_delete.append(f)
            continue
        w0 = obj.matrix_world @ f.verts[0].co
        w1 = obj.matrix_world @ f.verts[1].co
        w2 = obj.matrix_world @ f.verts[2].co
        if (w1 - w0).cross(w2 - w0).length <= 1e-12:
            to_delete.append(f)
            continue
        pts = [tuple(round((obj.matrix_world @ v.co)[i], 8) for i in range(3)) for v in f.verts]
        if len(set(pts)) < 3:
            to_delete.append(f)
            continue
        key = tuple(sorted(pts))
        if key in seen:
            to_delete.append(f)
        else:
            seen.add(key)
    if to_delete:
        bmesh.ops.delete(bm, geom=to_delete, context="FACES")
    if recalc_normals and bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = not (sharp_z and abs(poly.normal.z) > 0.98)
    return obj


def palette():
    mat = {
        "resin_body": material(
            "KZ black molded resin body", (0.012, 0.013, 0.015, 1.0), 0.04, 0.34
        ),
        "resin_bezel": material(
            "KZ satin black top surround", (0.008, 0.009, 0.011, 1.0), 0.08, 0.22
        ),
        "panel_matte": material(
            "KZ membrane control overlay", (0.016, 0.018, 0.021, 1.0), 0.05, 0.38
        ),
        "button_dark": material(
            "KZ tactile dark membrane key", (0.022, 0.024, 0.028, 1.0), 0.06, 0.32
        ),
        "button_start": material(
            "KZ prominent start-stop key", (0.86, 0.87, 0.89, 1.0), 0.08, 0.26
        ),
        "key_border": material(
            "KZ silver key border", (0.54, 0.56, 0.59, 1.0), 0.35, 0.28
        ),
        "silk_white": material(
            "KZ crisp white legend", (0.90, 0.91, 0.93, 1.0), 0.05, 0.30
        ),
        "silk_silver": material(
            "KZ ceramic silver-grey silkscreen", (0.36, 0.38, 0.41, 1.0), 0.18, 0.28
        ),
        "lcd_bezel": material(
            "KZ gloss black display window frame", (0.005, 0.006, 0.008, 1.0), 0.10, 0.14
        ),
        "lcd_screen": material(
            "KZ reflective grey-green LCD panel", (0.46, 0.49, 0.45, 1.0), 0.12, 0.18
        ),
        "lcd_segment": material(
            "KZ active dark LCD segment", (0.06, 0.08, 0.07, 1.0), 0.05, 0.22
        ),
        "led_red": material(
            "KZ start indicator LED red", (0.82, 0.06, 0.05, 1.0), 0.05, 0.20
        ),
        "rubber": material(
            "KZ non-slip elastomer foot", (0.015, 0.016, 0.018, 1.0), 0.0, 0.68
        ),
        "chrome": material(
            "KZ nickel-plated brass blades and magnet", (0.76, 0.78, 0.82, 1.0), 0.92, 0.18
        ),
        "fan_blade": material(
            "KZ internal impeller resin", (0.025, 0.027, 0.030, 1.0), 0.05, 0.40
        ),
    }

    # 512 x 512 procedural dot-matrix texture for the 296 x 286 mm crystallized glass plate
    ceramic = material(
        "KZ black crystallized glass", (0.014, 0.015, 0.018, 1.0), 0.10, 0.12
    )
    image = bpy.data.images.new(
        "KZ crystallized glass dot matrix", width=512, height=512
    )
    pixels = [0.0] * (512 * 512 * 4)
    # Plate spans X in [-0.148, +0.148] (0.296 m), Y in [-0.1185, +0.1675] (0.286 m), center Y = +0.0245 m
    # Zone ring centered at Y = +0.0200 m -> dy = -0.0045 m relative to plate center, radius = 0.0950 m
    pitch_m = 0.0022
    for py in range(512):
        v = (py + 0.5) / 512.0
        y_m = PLATE_CENTER_Y + (v - 0.5) * PLATE_DEPTH
        for px in range(512):
            u = (px + 0.5) / 512.0
            x_m = (u - 0.5) * PLATE_WIDTH
            dist_zone = math.hypot(x_m, y_m - ZONE_CENTER_Y)

            # Base deep black crystallized glass color
            val = 0.009

            # Outer border margin (5 mm inside glass edge)
            in_margin = (
                abs(x_m) < (PLATE_WIDTH * 0.5 - 0.005)
                and (PLATE_CENTER_Y - PLATE_DEPTH * 0.5 + 0.005)
                < y_m
                < (PLATE_CENTER_Y + PLATE_DEPTH * 0.5 - 0.005)
            )
            # Cutouts for rear warning table and top-of-zone high-temp caution
            in_rear_warning_box = (-0.120 <= x_m <= 0.120) and (0.123 <= y_m <= 0.162)
            in_hot_caution_box = (-0.028 <= x_m <= 0.028) and (0.090 <= y_m <= 0.104)
            in_zone_ring_band = 0.0920 <= dist_zone <= 0.0975

            if in_margin and not in_rear_warning_box and not in_hot_caution_box:
                if abs(dist_zone - 0.0950) <= 0.0011:
                    # Crisp 190 mm cooking zone circle line
                    val = 0.16
                elif not in_zone_ring_band:
                    gx = abs((x_m / pitch_m) - round(x_m / pitch_m))
                    gy = abs((y_m / pitch_m) - round(y_m / pitch_m))
                    if math.hypot(gx, gy) < 0.26:
                        # Subtle silver-grey ceramic dot matrix
                        val = 0.075 if dist_zone < 0.0920 else 0.092

            if in_rear_warning_box:
                # Border around rear caution block
                if (
                    abs(abs(x_m) - 0.119) < 0.0009
                    or abs(y_m - 0.161) < 0.0009
                    or abs(y_m - 0.124) < 0.0009
                    or abs(y_m - 0.154) < 0.0007
                ):
                    val = 0.15

            idx = (py * 512 + px) * 4
            pixels[idx] = val * 0.94
            pixels[idx + 1] = val * 0.96
            pixels[idx + 2] = val
            pixels[idx + 3] = 1.0

    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(ASSETS / "ceramic-dot-matrix.png")
    image.file_format = "PNG"
    image.save()
    image.pack()
    tex_node = ceramic.node_tree.nodes.new("ShaderNodeTexImage")
    tex_node.image = image
    ceramic.node_tree.links.new(
        tex_node.outputs["Color"],
        ceramic.node_tree.nodes["Principled BSDF"].inputs["Base Color"],
    )
    mat["ceramic"] = ceramic
    return mat


def rounded_rect_Loop(half_w, half_d, r_front, r_rear, center_y=0.0, segs_corner=10):
    """Return 2D (x, y) counter-clockwise perimeter points for a rounded rectangle."""
    pts = []
    # Corners:
    # 0: front-right (+half_w - r_front, center_y - half_d + r_front), angles -90..0 deg
    # 1: rear-right (+half_w - r_rear, center_y + half_d - r_rear), angles 0..90 deg
    # 2: rear-left (-half_w + r_rear, center_y + half_d - r_rear), angles 90..180 deg
    # 3: front-left (-half_w + r_front, center_y - half_d + r_front), angles 180..270 deg
    corners = (
        (half_w - r_front, center_y - half_d + r_front, r_front, -math.pi / 2, 0.0),
        (half_w - r_rear, center_y + half_d - r_rear, r_rear, 0.0, math.pi / 2),
        (-half_w + r_rear, center_y + half_d - r_rear, r_rear, math.pi / 2, math.pi),
        (
            -half_w + r_front,
            center_y - half_d + r_front,
            r_front,
            math.pi,
            1.5 * math.pi,
        ),
    )
    for cx, cy, r, a0, a1 in corners:
        for i in range(segs_corner + 1):
            if i == 0 and pts:
                continue
            a = a0 + (a1 - a0) * (i / segs_corner)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    if pts and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1e-6:
        pts.pop()
    return pts


def loft_rounded_shell(name, layers, surface, parent, cap_bottom=True, cap_top=True):
    """Build a watertight lofted shell from a list of (z, loop_2d) rings."""
    n = len(layers[0][1])
    vertices = []
    for z, loop in layers:
        assert len(loop) == n
        for x, y in loop:
            vertices.append((x, y, z))
    faces = []
    for r in range(len(layers) - 1):
        base0 = r * n
        base1 = (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((base0 + i, base0 + j, base1 + j, base1 + i))
    if cap_bottom:
        faces.append(tuple(reversed(range(n))))
    if cap_top:
        top_base = (len(layers) - 1) * n
        faces.append(tuple(top_base + i for i in range(n)))
    obj = mesh_object(name, vertices, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=True)


def label(name, value, position, size, surface, parent, tilt_rad=0.0):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.font = bpy.data.fonts["KZ label font"]
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = 0.0
    curve.resolution_u = 2
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (tilt_rad, 0.0, 0.0)
    return finish(obj, name, surface, parent)


def build_chassis_and_glass_plate(root, mat):
    # Outer chassis body: exact X in [-0.1520, +0.1520] (304 mm), Y in [-0.1725, +0.1725] (345 mm)
    # Lower resin tub tapers from Z = 0.0040 m up to Z = 0.0260 m, then vertical wall to Z = 0.0528 m,
    # with the front control deck sloping from Z = 0.0528 m at Y = -0.1185 m down to Z = 0.0360 m at Y = -0.1725 m.
    loop_bottom = rounded_rect_Loop(0.1380, 0.1585, 0.024, 0.024, center_y=0.0020)
    loop_mid = rounded_rect_Loop(0.1520, 0.1725, 0.028, 0.026, center_y=0.0000)
    loop_upper = rounded_rect_Loop(0.1520, 0.1725, 0.028, 0.026, center_y=0.0000)

    # Modify the front points (y < -0.1185) on the top ring of the chassis so the front control deck slopes down to Z = 0.0365 m
    n = len(loop_upper)
    vertices = []
    for z, loop in ((0.0040, loop_bottom), (0.0180, loop_mid), (0.0340, loop_mid)):
        for x, y in loop:
            vertices.append((x, y, z))
    # Top ring of main body shell
    for x, y in loop_upper:
        if y >= -0.1185:
            z_top = 0.0528
        else:
            # Linear slope from Z = 0.0528 at Y = -0.1185 down to Z = 0.0365 at Y = -0.1725
            t = (-0.1185 - y) / (0.1725 - 0.1185)
            z_top = 0.0528 - t * (0.0528 - 0.0365)
        vertices.append((x, y, z_top))

    faces = [tuple(reversed(range(n)))]
    for r in range(3):
        b0 = r * n
        b1 = (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
    faces.append(tuple(3 * n + i for i in range(n)))
    chassis_obj = mesh_object(
        "Black molded resin chassis", vertices, faces, mat["resin_body"], root
    )
    clean_mesh_object(chassis_obj, sharp_z=False)

    # Top bezel surround framing the 296 x 286 mm crystallized glass plate up to Z = 0.0536 m
    bezel_outer = rounded_rect_Loop(0.1512, 0.1460, 0.008, 0.025, center_y=0.0255)
    bezel_top = rounded_rect_Loop(0.1502, 0.1450, 0.008, 0.024, center_y=0.0255)
    loft_rounded_shell(
        "Top perimeter bezel",
        [(0.0510, bezel_outer), (0.0535, bezel_top)],
        mat["resin_bezel"],
        root,
    )

    # Crystallized glass plate (`Black crystallized cooking plate`):
    # Exact 296 x 286 mm (`X in [-0.1480, +0.1480]`, `Y in [-0.1185, +0.1675]`), top at Z = 0.05395 m
    # with rounded rear corners matching the perimeter bezel.
    plate_loop = rounded_rect_Loop(
        PLATE_WIDTH * 0.5, PLATE_DEPTH * 0.5, 0.004, 0.022, center_y=PLATE_CENTER_Y
    )
    plate = loft_rounded_shell(
        "Black crystallized cooking plate",
        [(0.0510, plate_loop), (0.05395, plate_loop)],
        mat["ceramic"],
        root,
    )

    # Map UVs across the exact 296 x 286 mm top plate so `ceramic-dot-matrix.png` aligns 1:1
    uv_layer = plate.data.uv_layers.active or plate.data.uv_layers.new()
    for poly in plate.data.polygons:
        for loop_idx in poly.loop_indices:
            co = plate.data.vertices[plate.data.loops[loop_idx].vertex_index].co
            u = (co.x / PLATE_WIDTH) + 0.5
            v = ((co.y - PLATE_CENTER_Y) / PLATE_DEPTH) + 0.5
            uv_layer.data[loop_idx].uv = (max(0.0, min(1.0, u)), max(0.0, min(1.0, v)))

    # Cooking zone reference empty and flush silkscreen ring at Z = 0.0540 m
    zone = empty("kz_cooking_zone", (0.0, ZONE_CENTER_Y, PLATE_TOP_Z), root)
    zone["published_marking_diameter_m"] = ZONE_DIAMETER
    zone["usable_pan_diameter_range_m"] = [0.120, 0.260]
    zone["status"] = "190 mm printed target ring; usable flat pan bottom 120-260 mm"

    # Printed cooking zone ring (flush at Z = 0.0540 m so raycasts hit either plate or ring at 0.0540 m)
    segs = 96
    ring_verts = []
    for radius in (0.0942, 0.0958):
        for i in range(segs):
            ang = math.tau * i / segs
            ring_verts.append(
                (
                    radius * math.cos(ang),
                    ZONE_CENTER_Y + radius * math.sin(ang),
                    PLATE_TOP_Z,
                )
            )
    ring_faces = []
    for i in range(segs):
        j = (i + 1) % segs
        ring_faces.append((i, j, segs + j, segs + i))
    ring_obj = mesh_object(
        "Printed cooking zone ring", ring_verts, ring_faces, mat["silk_silver"], root
    )
    clean_mesh_object(ring_obj, sharp_z=True)

    # Flush silkscreen warnings on the glass plate at Z = 0.0540 m
    label(
        "High temp zone caution",
        "△ 高温注意",
        (0.0, 0.0965, PLATE_TOP_Z),
        0.0055,
        mat["silk_silver"],
        root,
    )
    label(
        "Rear warning header",
        "△ 警告",
        (-0.045, 0.1565, PLATE_TOP_Z),
        0.0050,
        mat["silk_silver"],
        root,
    )
    label(
        "Rear caution header",
        "△ 注意",
        (0.055, 0.1565, PLATE_TOP_Z),
        0.0050,
        mat["silk_silver"],
        root,
    )
    return plate, zone


def build_control_panel(root, mat):
    panel = empty("kz_control_panel", PANEL_ORIGIN, root)
    panel["tilt_degrees"] = 16.0

    # Sloped membrane overlay plate sitting on the front sloped deck
    overlay = box(
        "Sloped membrane control panel",
        (0.0, 0.0, 0.0),
        (0.2760, 0.0440, 0.0016),
        mat["panel_matte"],
        panel,
        0.0004,
    )
    overlay.rotation_euler.x = PANEL_TILT_RAD
    clean_mesh_object(overlay, sharp_z=False)

    # Branding on left of control deck (`Panasonic` + `KZ-CK1402`)
    label(
        "Panasonic wordmark",
        "Panasonic",
        (-0.1140, 0.0010, 0.0018),
        0.0072,
        mat["silk_white"],
        panel,
        tilt_rad=PANEL_TILT_RAD,
    )
    label(
        "Model number legend",
        "KZ-CK1402",
        (-0.1140, -0.0080, -0.0008),
        0.0042,
        mat["silk_white"],
        panel,
        tilt_rad=PANEL_TILT_RAD,
    )

    # Secondary hold function legends above button pairs
    label(
        "Operation lock legend",
        "操作ロック 3秒押し",
        (-0.0476, 0.0128, 0.0049),
        0.0036,
        mat["silk_white"],
        panel,
        tilt_rad=PANEL_TILT_RAD,
    )
    label(
        "Power save 1000W legend",
        "1000Wセーブ 3秒押し",
        (0.0484, 0.0128, 0.0049),
        0.0036,
        mat["silk_white"],
        panel,
        tilt_rad=PANEL_TILT_RAD,
    )

    # Central LCD display module (`kz_display`)
    display = empty("kz_display", (0.0, 0.0, 0.0012), panel)
    display.rotation_euler.x = PANEL_TILT_RAD
    bezel = box(
        "Central LCD bezel",
        (0.0, 0.0, 0.0),
        (0.0540, 0.0320, 0.0014),
        mat["lcd_bezel"],
        display,
        0.0003,
    )
    clean_mesh_object(bezel, sharp_z=False)

    window = box(
        "Backlit LCD window",
        (0.0, 0.0005, 0.0006),
        (0.0480, 0.0165, 0.0008),
        mat["lcd_screen"],
        display,
        0.0002,
    )
    clean_mesh_object(window, sharp_z=False)

    # Active LCD readout (`温度 180` + 7-bar power level indicator)
    label(
        "LCD mode readout",
        "温度 180",
        (-0.0020, 0.0022, 0.0012),
        0.0068,
        mat["lcd_segment"],
        display,
    )
    for step in range(7):
        bx = -0.0180 + step * 0.0060
        bh = 0.0012 + step * 0.00035
        bar = box(
            f"LCD power bar {step + 1}",
            (bx, -0.0048, 0.0011),
            (0.0044, bh, 0.0004),
            mat["lcd_segment"],
            display,
            0.0,
        )
        clean_mesh_object(bar, sharp_z=True)

    label(
        "LCD top course indicators",
        "加熱   揚げ物",
        (0.0090, 0.0118, 0.0010),
        0.0034,
        mat["silk_white"],
        display,
    )
    label(
        "LCD bottom level numbers",
        "1  2  3  4  5  6  7",
        (0.0, -0.0105, 0.0010),
        0.0034,
        mat["silk_white"],
        display,
    )
    label(
        "LCD bottom power labels",
        "とろ火  弱    中    強",
        (0.0, -0.0142, 0.0010),
        0.0030,
        mat["silk_white"],
        display,
    )

    # 7 articulated tactile membrane buttons
    buttons = {}
    for name, bx, bw, bh, legend_text, style in BUTTON_SPECS:
        btn = empty(name, (bx, -0.0015, 0.0010), panel)
        btn.rotation_euler.x = PANEL_TILT_RAD
        btn["travel_m"] = 0.0006
        btn["legend"] = legend_text

        border = box(
            f"{name}_border",
            (0.0, 0.0, 0.0),
            (bw, bh, 0.0010),
            mat["key_border"] if style == "dark" else mat["button_start"],
            btn,
            0.0002,
        )
        clean_mesh_object(border, sharp_z=False)

        cap_mat = mat["button_dark"] if style == "dark" else mat["button_start"]
        cap = box(
            f"{name}_cap",
            (0.0, 0.0, 0.0004),
            (bw - 0.0014, bh - 0.0014, 0.0010),
            cap_mat,
            btn,
            0.0002,
        )
        clean_mesh_object(cap, sharp_z=False)

        text_mat = mat["silk_white"] if style == "dark" else mat["resin_bezel"]
        if style == "start":
            # Red LED indicator pip on left of Start/Stop button + split legend `スタート / 切`
            led = box(
                "Start LED indicator",
                (-0.0088, 0.0, 0.0010),
                (0.0022, 0.0022, 0.0006),
                mat["led_red"],
                btn,
                0.0,
            )
            clean_mesh_object(led, sharp_z=True)
            div = box(
                "Start button divider",
                (0.0015, 0.0, 0.0010),
                (0.0160, 0.0006, 0.0004),
                mat["resin_bezel"],
                btn,
                0.0,
            )
            clean_mesh_object(div, sharp_z=True)
            label(
                f"{name}_legend_top",
                "スタート",
                (0.0018, 0.0034, 0.0011),
                0.0038,
                text_mat,
                btn,
            )
            label(
                f"{name}_legend_bottom",
                "切",
                (0.0018, -0.0038, 0.0011),
                0.0040,
                text_mat,
                btn,
            )
        else:
            label(
                f"{name}_legend",
                legend_text,
                (0.0, 0.0, 0.0011),
                0.0038 if len(legend_text) >= 3 else 0.0046,
                text_mat,
                btn,
            )
        buttons[name] = btn

    return panel, display, buttons


def build_underside_feet_and_cooling(root, mat):
    # Four rubber feet touching Z = 0.0000 m at the exact CAD coordinates
    feet = []
    for name, fx, fy in FOOT_POSITIONS:
        foot = empty(name, (fx, fy, 0.0), root)
        boss = cylinder(
            f"{name}_boss",
            (0.0, 0.0, 0.0032),
            0.0095,
            0.0036,
            mat["resin_body"],
            foot,
        )
        clean_mesh_object(boss, sharp_z=True)
        pad = cylinder(
            f"{name}_rubber_pad",
            (0.0, 0.0, 0.0012),
            0.0072,
            0.0024,
            mat["rubber"],
            foot,
        )
        clean_mesh_object(pad, sharp_z=True)
        foot["contact_plane_z_m"] = 0.0
        feet.append(foot)

    # Underside circular cooling fan intake grille & 7-blade impeller (`kz_cooling_fan`)
    # Located on the left underside at X = -0.0680 m, Y = +0.0250 m (`Ø116 mm` guard)
    fan = empty("kz_cooling_fan", (-0.0680, 0.0250, 0.0045), root)
    shroud = cylinder(
        "Underside fan intake shroud",
        (0.0, 0.0, 0.0),
        0.0560,
        0.0016,
        mat["resin_bezel"],
        fan,
    )
    clean_mesh_object(shroud, sharp_z=True)
    hub = cylinder(
        "Cooling fan hub",
        (0.0, 0.0, 0.0020),
        0.0160,
        0.0040,
        mat["fan_blade"],
        fan,
    )
    clean_mesh_object(hub, sharp_z=True)
    for b_idx in range(7):
        ang = math.tau * b_idx / 7.0
        bx = 0.0320 * math.cos(ang)
        by = 0.0320 * math.sin(ang)
        blade = box(
            f"Cooling fan blade {b_idx + 1}",
            (bx, by, 0.0022),
            (0.0280, 0.0085, 0.0018),
            mat["fan_blade"],
            fan,
            0.0002,
        )
        blade.rotation_euler = (math.radians(22.0), 0.0, ang)
        clean_mesh_object(blade, sharp_z=False)
    for spoke_idx in range(8):
        ang = math.tau * spoke_idx / 8.0
        sx = 0.0280 * math.cos(ang)
        sy = 0.0280 * math.sin(ang)
        spoke = box(
            f"Fan guard spoke {spoke_idx + 1}",
            (sx, sy, -0.0006),
            (0.0540, 0.0020, 0.0012),
            mat["resin_body"],
            fan,
            0.0,
        )
        spoke.rotation_euler.z = ang
        clean_mesh_object(spoke, sharp_z=True)

    # Side cooling louver strips on left and right lower flanks (`X = ±0.1495 m`)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        for slot_idx in range(9):
            sy = -0.0150 + slot_idx * 0.0120
            louver = box(
                f"Side cooling louver {side_name} {slot_idx + 1}",
                (side_sign * 0.1485, sy, 0.0230),
                (0.0024, 0.0065, 0.0130),
                mat["lcd_bezel"],
                root,
                0.0002,
            )
            clean_mesh_object(louver, sharp_z=False)

    # Rear exhaust louver grille along `Y = +0.1710 m` (`X in [-0.095, +0.045] m`)
    for slot_idx in range(12):
        rx = -0.0880 + slot_idx * 0.0115
        rear_louver = box(
            f"Rear exhaust louver {slot_idx + 1}",
            (rx, 0.1708, 0.0320),
            (0.0068, 0.0024, 0.0180),
            mat["lcd_bezel"],
            root,
            0.0002,
        )
        clean_mesh_object(rear_louver, sharp_z=False)

    # Underside rating nameplate (`KZ-CK1402 単相100V 1.4kW 50-60Hz`)
    plate_bg = box(
        "Underside rating label plate",
        (0.0550, 0.0100, 0.0036),
        (0.0820, 0.0540, 0.0006),
        mat["silk_white"],
        root,
        0.0,
    )
    clean_mesh_object(plate_bg, sharp_z=True)
    return feet, fan


def build_magnetic_power_cord(root, mat):
    # Detachable magnetic power cord (`kz_power_lead`) exiting rear-right at 45 deg
    # Excluded from the 304 x 345 x 54 mm chassis envelope check, matching maruzen-mih-02c and vollrath-59500p
    lead = empty("kz_power_lead", (0.0, 0.0, 0.0), root)
    lead["published_length_m"] = 1.9
    lead["connector_type"] = "Detachable magnetic breakaway plug (マグネットプラグ)"
    lead["supply_plug"] = "2-pole 15 A 125 V JIS C 8303"
    lead["status"] = "Illustrative stowed route; excluded from body envelope check"

    # Rear-right 45-degree magnetic receptacle boss on the rear corner
    socket_boss = box(
        "Rear magnetic receptacle boss",
        (0.1120, 0.1640, 0.0240),
        (0.0280, 0.0160, 0.0180),
        mat["resin_body"],
        lead,
        0.0015,
    )
    socket_boss.rotation_euler.z = -math.pi / 4.0
    clean_mesh_object(socket_boss, sharp_z=False)

    # Detachable magnetic plug head (`kz_magnetic_plug`)
    mag_plug = empty("kz_magnetic_plug", (0.1240, 0.1760, 0.0240), lead)
    mag_plug.rotation_euler.z = -math.pi / 4.0
    mag_body = box(
        "Magnetic breakaway connector body",
        (0.0, 0.0080, 0.0),
        (0.0260, 0.0320, 0.0160),
        mat["resin_bezel"],
        mag_plug,
        0.0020,
    )
    clean_mesh_object(mag_body, sharp_z=False)
    mag_face = box(
        "Magnetic contact face",
        (0.0, -0.0085, 0.0),
        (0.0200, 0.0020, 0.0120),
        mat["chrome"],
        mag_plug,
        0.0002,
    )
    clean_mesh_object(mag_face, sharp_z=False)

    # Coiled 1.9 m illustrative cord and 2-pole 100 V JIS plug (`kz_jis_plug`)
    points = [
        (0.1320, 0.1840, 0.0240),
        (0.1520, 0.2140, 0.0170),
        (0.1540, 0.2550, 0.0110),
    ]
    for i in range(48):
        ang = 0.0 + i * (math.pi * 1.35) / 47.0
        points.append(
            (
                0.0860 + 0.0680 * math.cos(ang),
                0.2650 + 0.0560 * math.sin(ang),
                0.0095 + i * 0.00008,
            )
        )
    points.extend([(0.0240, 0.3050, 0.0130), (-0.0180, 0.3200, 0.0130)])
    cord_obj = tube(
        "Magnetic power cord", points, 0.0036, mat["resin_body"], lead, smooth=True
    )

    jis_plug = empty("kz_jis_plug", (-0.0280, 0.3200, 0.0130), lead)
    plug_body = box(
        "JIS 100V 15A plug body",
        (0.0, 0.0, 0.0),
        (0.0280, 0.0240, 0.0160),
        mat["resin_bezel"],
        jis_plug,
        0.0020,
    )
    clean_mesh_object(plug_body, sharp_z=False)
    for py in (-0.0063, 0.0063):
        blade = box(
            f"JIS plug blade {'L' if py < 0 else 'N'}",
            (-0.0210, py, 0.0),
            (0.0160, 0.0016, 0.0062),
            mat["chrome"],
            jis_plug,
            0.0002,
        )
        clean_mesh_object(blade, sharp_z=False)
    return lead, mag_plug, jis_plug, cord_obj


def convert_and_clean_all(root):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in list(bpy.context.scene.objects):
        if obj.type in {"CURVE", "FONT"}:
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.convert(target="MESH")
            obj.select_set(False)
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            # Preserve outward normal orientation on flat converted font legends
            is_flat_label = len(obj.data.polygons) > 0 and all(
                abs(v.co.z) < 1e-5 for v in obj.data.vertices
            )
            clean_mesh_object(
                obj,
                sharp_z=not is_flat_label,
                recalc_normals=not is_flat_label,
            )
            if not obj.data.polygons:
                bpy.data.objects.remove(obj, do_unlink=True)


def export_glb(root):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / "panasonic-kz-ck1402.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def attach_references(root):
    appliance = bpy.data.collections.new("KZ-CK1402 appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        appliance.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - toggle visibility")
    bpy.context.scene.collection.children.link(refs)
    for i, name in enumerate(
        (
            "manufacturer-product.jpg",
            "dimensioned-orthographic-sheet.png",
            "orthographic-top.png",
            "orthographic-front.png",
            "orthographic-side.png",
            "orthographic-bottom.png",
        )
    ):
        img_path = REFERENCES / name
        if not img_path.exists():
            continue
        image = bpy.data.images.load(str(img_path))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.5
        obj.location = (i * 0.6, 0.9, 0.25)
        obj.rotation_euler.x = math.pi / 2
        obj["status"] = "Reference only; aligned to labelled dimensions"
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
    scene.view_settings.exposure = -0.25
    scene.world = bpy.data.worlds.new("KZ neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.62,
        0.65,
        0.69,
        1.0,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.42
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(
        material("Studio floor", (0.36, 0.38, 0.41, 1.0), roughness=0.88)
    )
    area_light("Key softbox", (-0.85, -0.95, 1.35), (0.0, 0.0, 0.03), 135, 1.0)
    area_light("Fill stripbox", (0.85, -0.20, 0.95), (0.0, 0.0, 0.03), 95, 0.75)
    area_light("Rim reflection", (-0.20, 0.95, 1.10), (0.0, 0.0, 0.04), 115, 0.80)
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
    return camera, floor


def render_views(camera, floor):
    for name, position, target, scale in (
        ("studio-main", (0.58, -0.78, 0.62), (0.0, 0.02, 0.028), 0.56),
        ("studio-top", (0.0, 0.03, 1.80), (0.0, 0.03, 0.027), 0.54),
        ("studio-front", (0.0, -1.80, 0.032), (0.0, 0.0, 0.028), 0.36),
        ("studio-right", (1.80, 0.02, 0.045), (0.0, 0.02, 0.028), 0.56),
        ("studio-controls", (0.18, -0.68, 0.24), (0.0, -0.142, 0.040), 0.32),
    ):
        camera.location = position
        camera.data.ortho_scale = scale
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(ASSETS / f"{name}.png")
        bpy.ops.render.render(write_still=True)

    # Render underside view showing the 4 rubber feet, Ø116 mm cooling fan guard, and rating label
    floor.hide_render = True
    area_light(
        "Underside inspection light", (0.3, -0.4, -1.2), (0.0, 0.0, 0.01), 120, 0.9
    )
    camera.location = (0.35, -0.55, -0.85)
    camera.data.ortho_scale = 0.54
    look_at(camera, (0.0, 0.02, 0.015))
    bpy.context.scene.render.filepath = str(ASSETS / "studio-underside.png")
    bpy.ops.render.render(write_still=True)
    bottom_light = bpy.data.objects.get("Underside inspection light")
    if bottom_light is not None:
        bpy.data.objects.remove(bottom_light, do_unlink=True)
    floor.hide_render = False


def write_build_report(root, lead):
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    vertices = []
    for obj in root.children_recursive:
        if obj.type == "MESH" and obj not in excluded:
            vertices.extend(
                obj.matrix_world @ Vector(corner) for corner in obj.bound_box
            )
    minimum = [round(min(v[i] for v in vertices), 6) for i in range(3)]
    maximum = [round(max(v[i] for v in vertices), 6) for i in range(3)]
    dimensions = [round(maximum[i] - minimum[i], 6) for i in range(3)]
    for actual, expected in zip(dimensions, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) < 0.001, (dimensions, minimum, maximum)

    data = {
        "status": "Articulated visual and MuJoCo mechanical prototype",
        "model": "Panasonic KZ-CK1402",
        "drawing": "KZ-CK1402-K 1/5 scale engineering drawing ('21/8)",
        "drawing_sha256": hashlib.sha256(
            (REFERENCES.parent / "specifications/dimensioned-drawing.pdf").read_bytes()
        ).hexdigest(),
        "nominal_body_m": [WIDTH, DEPTH, HEIGHT],
        "authored_body_m": dimensions,
        "body_bounds_m": {"min": minimum, "max": maximum},
        "body_bounds_exclusions": ["Detachable magnetic power lead and JIS 100V plug"],
        "crystallized_glass_plate_m": [PLATE_WIDTH, PLATE_DEPTH],
        "cooking_zone_diameter_m": ZONE_DIAMETER,
        "usable_pan_diameter_range_m": [0.120, 0.260],
        "electrical_rating": "Single-phase 100 V AC, 50/60 Hz, 1,400 W (1,000 W power-save mode)",
        "glb_sha256": hashlib.sha256(
            (ASSETS / "panasonic-kz-ck1402.glb").read_bytes()
        ).hexdigest(),
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
    font.name = "KZ label font"

    scene = bpy.context.scene
    scene.name = "Panasonic KZ-CK1402 - commercial 100V induction hotplate"
    scene.unit_settings.system = "METRIC"

    root = empty("kz_hob", (0.0, 0.0, 0.0))
    root["model"] = "Panasonic KZ-CK1402 commercial countertop induction hotplate"
    root["published_supply"] = "Single-phase 100 V AC, 50/60 Hz, 1.4 kW"
    root["published_mass_kg"] = 2.5
    root["published_max_load_kg"] = 20.0
    root["published_usable_pan_diameter_m"] = [0.120, 0.260]

    mat = palette()
    build_chassis_and_glass_plate(root, mat)
    _panel, _display, buttons = build_control_panel(root, mat)
    _feet, fan = build_underside_feet_and_cooling(root, mat)
    lead, mag_plug, _jis_plug, _cord_obj = build_magnetic_power_cord(root, mat)

    convert_and_clean_all(root)
    export_glb(root)
    write_build_report(root, lead)
    attach_references(root)
    camera, floor = studio()
    if not args.skip_renders:
        render_views(camera, floor)

    # Keyframe preview animation: press Start button, step power Up, spin cooling fan, detach/reattach magnetic plug
    start_btn = buttons["kz_start_button"]
    up_btn = buttons["kz_up_button"]
    base_start_z = start_btn.location.z
    base_up_z = up_btn.location.z
    base_mag_loc = mag_plug.location.copy()
    for frame, s_dz, u_dz, fan_deg, mag_d in (
        (1, 0.0, 0.0, 0.0, 0.0),
        (18, -0.0006, 0.0, 45.0, 0.0),
        (26, 0.0, 0.0, 120.0, 0.0),
        (42, 0.0, -0.0006, 260.0, 0.0),
        (50, 0.0, 0.0, 360.0, 0.0),
        (80, 0.0, 0.0, 540.0, 0.025),
        (110, 0.0, 0.0, 720.0, 0.0),
    ):
        start_btn.location.z = base_start_z + s_dz
        up_btn.location.z = base_up_z + u_dz
        fan.rotation_euler.z = math.radians(fan_deg)
        mag_plug.location = Vector(
            (base_mag_loc.x + mag_d * 0.7071, base_mag_loc.y + mag_d * 0.7071, base_mag_loc.z)
        )
        start_btn.keyframe_insert(data_path="location", index=2, frame=frame)
        up_btn.keyframe_insert(data_path="location", index=2, frame=frame)
        fan.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
        mag_plug.keyframe_insert(data_path="location", frame=frame)

    scene.frame_start = 1
    scene.frame_end = 110
    scene.render.fps = 24
    scene.frame_set(1)
    camera.location = (0.58, -0.78, 0.62)
    camera.data.ortho_scale = 0.56
    look_at(camera, (0.0, 0.02, 0.028))

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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "panasonic-kz-ck1402.blend"))
    print("Saved Panasonic KZ-CK1402", ASSETS)


if __name__ == "__main__":
    main()
