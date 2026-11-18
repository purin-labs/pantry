"""Build the Japanese Hitachi R-HWS47XL 470L 5-door left-hinged upright refrigerator-freezer visual model.

Metres, Z up, operator front towards -Y.
Slim 600 mm Crystal Champagne (XN) satin hairline steel Japanese 5-door multi-zone refrigerator-freezer:
- Published cabinet envelope: 600 x 701 x 1,833 mm (0.600 x 0.701 x 1.833 m), unit mass 93.000 kg
- Electrical ratings: Single-phase 100 V AC, 50/60 Hz, compressor 95 W, defrost heater 155 W, 269 kWh/year, R600a
- Compartments (470 L total):
  1. Upper left-hinged refrigerator door (243 L, Z = 0.904..1.822 m, hinge on -X left edge, 0..110 deg CCW about -Z)
     with pure Simple Design hairline steel exterior, interior left-jamb touch control panel (操作パネル),
     Marugoto Chilled (+2 C, 118 L), Tokusen Hyo-on (-1 C, 13 L), 14-egg case (小物ケース), and 1.1 L auto-ice tank
  2. Mid-left automatic ice drawer (22 L, Z = 0.684..0.886 m, X = -0.300..-0.022 m, 0..0.360 m slide)
  3. Mid-right upper Delicious Freezing drawer (23 L, Z = 0.684..0.886 m, X = -0.018..+0.300 m, 0..0.360 m slide)
  4. Lower main 3-tier freezer drawer (95 L, Z = 0.354..0.666 m, full 600 mm width, 0..0.420 m slide)
  5. Bottom Freshness Sleep vegetable drawer (87 L, Z = 0.032..0.336 m, full 600 mm width, 0..0.420 m slide)
  + Chilled patisserie milk/cream carton (0.650 kg 6-DOF free body on Marugoto Chilled shelf Z = 1.140 m)
"""

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    frame,
    look_at,
    material,
)

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/hitachi-r-hws47xl"
DOC_README = ROOT / "docs/equipment/hitachi-r-hws47xl/README.md"
NAME = "hitachi-r-hws47xl"
HIRAGINO_FONT_PATH = Path("/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc")

WIDTH = 0.6000
DEPTH = 0.7010
HEIGHT = 1.8330

# Articulated body origins (Metres, Z up, -Y front)
FRIDGE_DOOR_PIVOT = (-0.2920, -0.3420, 1.3600)
FRIDGE_DOOR_MAX_RAD = math.radians(110.0)  # ~1.9198622 rad around axis (0, 0, -1)

ICE_DRAWER_ORIGIN = (-0.1600, -0.3420, 0.7825)
UPPER_FREEZER_ORIGIN = (0.1400, -0.3420, 0.7825)
LOWER_FREEZER_ORIGIN = (0.0, -0.3420, 0.5075)
VEG_DRAWER_ORIGIN = (0.0, -0.3420, 0.1800)

MILK_CARTON_REST_POSE = (-0.0850, -0.0350, 1.2400)

FOOT_POSITIONS = (
    ("hws_foot_front_left", -0.2620, -0.2850),
    ("hws_foot_front_right", 0.2620, -0.2850),
    ("hws_foot_rear_left", -0.2620, 0.2750),
    ("hws_foot_rear_right", 0.2620, 0.2750),
)


def enable_metal_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    metal_found = any(dev.type == "METAL" for dev in prefs.devices)
    for dev in prefs.devices:
        dev.use = (dev.type == "METAL") if metal_found else True
    scene.cycles.device = "GPU"


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
        pts = [
            tuple(round((obj.matrix_world @ v.co)[i], 8) for i in range(3))
            for v in f.verts
        ]
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
        n = poly.normal
        is_cardinal_flat = max(abs(n.x), abs(n.y), abs(n.z)) > 0.9985
        if sharp_z:
            poly.use_smooth = False
        else:
            poly.use_smooth = not is_cardinal_flat
    return obj


def open_top_bin(
    name: str,
    position: tuple[float, float, float],
    outer_dims: tuple[float, float, float],
    wall_t: float,
    floor_t: float,
    surface,
    parent,
    sharp: bool = True,
):
    """Build a closed 2-manifold hollow open-top rectangular bin (16 verts, 14 quads)."""
    hx, hy, hz = outer_dims[0] * 0.5, outer_dims[1] * 0.5, outer_dims[2] * 0.5
    ix = max(0.002, hx - wall_t)
    iy = max(0.002, hy - wall_t)
    iz_bot = min(hz - 0.002, -hz + floor_t)
    verts = [
        (-hx, -hy, -hz),
        (hx, -hy, -hz),
        (hx, hy, -hz),
        (-hx, hy, -hz),
        (-hx, -hy, hz),
        (hx, -hy, hz),
        (hx, hy, hz),
        (-hx, hy, hz),
        (-ix, -iy, iz_bot),
        (ix, -iy, iz_bot),
        (ix, iy, iz_bot),
        (-ix, iy, iz_bot),
        (-ix, -iy, hz),
        (ix, -iy, hz),
        (ix, iy, hz),
        (-ix, iy, hz),
    ]
    faces = [
        (0, 3, 2, 1),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
        (8, 9, 10, 11),
        (12, 13, 9, 8),
        (13, 14, 10, 9),
        (14, 15, 11, 10),
        (15, 12, 8, 11),
        (4, 5, 13, 12),
        (5, 6, 14, 13),
        (6, 7, 15, 14),
        (7, 4, 12, 15),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    finish(obj, name, surface, parent, 0.0)
    return clean_mesh_object(obj, sharp_z=sharp)


def write_rgba_png(path: Path, width: int, height: int, buf: bytearray) -> Path:
    rows = []
    stride = width * 4
    for y in range(height):
        rows.append(b"\x00" + bytes(buf[y * stride : (y + 1) * stride]))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return path


def linear_to_srgb_byte(val: float) -> int:
    v = max(0.0, min(1.0, val))
    s = 12.92 * v if v <= 0.0031308 else 1.055 * (v ** (1.0 / 2.4)) - 0.055
    return max(0, min(255, int(round(s * 255.0))))


def ensure_champagne_hairline_pngs() -> tuple[Path, Path]:
    """Generate seamless Crystal Champagne (XN) satin brushed hairline steel baseColor & ORM PNGs."""
    albedo_path = ASSETS / "hws-champagne-hairline.png"
    orm_path = ASSETS / "hws-champagne-orm.png"
    w, h = 512, 512
    albedo_buf = bytearray(w * h * 4)
    orm_buf = bytearray(w * h * 4)

    # Warm champagne-gold metallic base color (~ linear 0.67, 0.60, 0.50)
    base_r, base_g, base_b = 0.675, 0.602, 0.508

    # Deterministic multi-frequency horizontal brushed stainless hairline profile
    row_grain = []
    for y in range(h):
        h1 = (((y * 2654435761) & 0xFFFFFFFF) / 4294967295.0) - 0.5
        h2 = (((((y // 2) + 73) * 2246822519) & 0xFFFFFFFF) / 4294967295.0) - 0.5
        wave = 0.35 * math.sin(2.0 * math.pi * y / 32.0) + 0.25 * math.cos(2.0 * math.pi * y / 11.0)
        row_grain.append(0.55 * h1 + 0.30 * h2 + 0.15 * wave)

    for y in range(h):
        rg = row_grain[y]
        v_norm = y / h
        # Gentle vertical rolled-steel luster gradient (tileable via cos 2pi)
        sheet_sheen = 0.026 * math.cos(2.0 * math.pi * (v_norm - 0.28))
        for x in range(w):
            u_norm = x / w
            # Long horizontal brush pass modulation (tileable in X)
            brush_long = (
                0.60 * math.sin(2.0 * math.pi * u_norm * 2.0 + y * 0.37)
                + 0.40 * math.cos(2.0 * math.pi * u_norm * 5.0 - y * 0.81)
            )
            diag_luster = 0.022 * math.cos(2.0 * math.pi * (u_norm * 0.5 + v_norm * 0.5 - 0.32))
            streak = rg * (0.72 + 0.28 * brush_long)

            lum_delta = 0.058 * streak + sheet_sheen + diag_luster
            lr = base_r + lum_delta * 1.04
            lg = base_g + lum_delta * 0.98
            lb = base_b + lum_delta * 0.88

            idx = (y * w + x) * 4
            albedo_buf[idx] = linear_to_srgb_byte(lr)
            albedo_buf[idx + 1] = linear_to_srgb_byte(lg)
            albedo_buf[idx + 2] = linear_to_srgb_byte(lb)
            albedo_buf[idx + 3] = 255

            # glTF ORM: R = Occlusion (1.0), G = Roughness (0.22..0.30), B = Metallic (0.78)
            rough = max(0.22, min(0.30, 0.258 - 0.036 * streak))
            orm_buf[idx] = 255
            orm_buf[idx + 1] = int(round(rough * 255.0))
            orm_buf[idx + 2] = int(round(0.78 * 255.0))
            orm_buf[idx + 3] = 255

    return (
        write_rgba_png(albedo_path, w, h, albedo_buf),
        write_rgba_png(orm_path, w, h, orm_buf),
    )


def bake_ortho_card(
    out_path: Path,
    width_px: int,
    height_px: int,
    card_w: float,
    build_fn,
) -> Path:
    """Bake a crisp 2D graphic texture in a clean Blender orthographic Standard-view scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    enable_metal_gpu(scene)
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.resolution_x = width_px
    scene.render.resolution_y = height_px
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0

    world = bpy.data.worlds.new("BakeWorld")
    scene.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bg.inputs["Strength"].default_value = 0.0

    font = (
        bpy.data.fonts.load(str(HIRAGINO_FONT_PATH))
        if HIRAGINO_FONT_PATH.exists()
        else bpy.data.fonts[0]
    )
    card_h = card_w * (height_px / width_px)
    mat_cache = {}

    def em_mat(key: str, rgba: tuple[float, float, float, float]):
        if key in mat_cache:
            return mat_cache[key]
        m = bpy.data.materials.new(key)
        m.use_nodes = True
        nodes = m.node_tree.nodes
        links = m.node_tree.links
        nodes.clear()
        em = nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = rgba
        em.inputs["Strength"].default_value = 1.0
        out = nodes.new("ShaderNodeOutputMaterial")
        links.new(em.outputs["Emission"], out.inputs["Surface"])
        mat_cache[key] = m
        return m

    def rect(cx: float, cy: float, rw: float, rh: float, z: float, m):
        hw, hh = rw * 0.5, rh * 0.5
        mesh = bpy.data.meshes.new("rect")
        mesh.from_pydata(
            [
                (cx - hw, cy - hh, z),
                (cx + hw, cy - hh, z),
                (cx + hw, cy + hh, z),
                (cx - hw, cy + hh, z),
            ],
            [],
            [(0, 1, 2, 3)],
        )
        mesh.update()
        obj = bpy.data.objects.new("rect", mesh)
        obj.data.materials.append(m)
        scene.collection.objects.link(obj)
        return obj

    def stroke(cx: float, cy: float, rw: float, rh: float, t: float, z: float, m):
        rect(cx, cy + (rh - t) * 0.5, rw, t, z, m)
        rect(cx, cy - (rh - t) * 0.5, rw, t, z, m)
        rect(cx - (rw - t) * 0.5, cy, t, rh, z, m)
        rect(cx + (rw - t) * 0.5, cy, t, rh, z, m)

    def txt(
        body: str,
        x: float,
        y: float,
        z: float,
        size: float,
        m,
        align_x: str = "CENTER",
        align_y: str = "CENTER",
    ):
        curve = bpy.data.curves.new("txt", "FONT")
        curve.font = font
        curve.body = body
        curve.size = size
        curve.align_x = align_x
        curve.align_y = align_y
        curve.resolution_u = 4
        obj = bpy.data.objects.new("txt", curve)
        obj.location = (x, y, z)
        obj.data.materials.append(m)
        scene.collection.objects.link(obj)
        return obj

    build_fn(card_w, card_h, em_mat, rect, stroke, txt)

    cam_data = bpy.data.cameras.new("BakeCam")
    cam_data.type = "ORTHO"
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.ortho_scale = card_w
    cam = bpy.data.objects.new("BakeCam", cam_data)
    cam.location = (0.0, 0.0, 1.0)
    cam.rotation_euler = (0.0, 0.0, 0.0)
    scene.collection.objects.link(cam)
    scene.camera = cam

    out_path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)
    return out_path


def bake_japanese_ui_textures() -> tuple[Path, Path, Path]:
    """Bake crisp Hiragino Japanese PNGs for R-HWS47XL jamb panel, Marugoto badge, and milk carton."""
    touch_path = ASSETS / "hws-touch-panel.png"
    badge_path = ASSETS / "hws-marugoto-badge.png"
    carton_path = ASSETS / "hokkaido-milk-carton.png"

    # 1. Interior Jamb Touch Control Panel (`操作パネル`, `240 x 1080`, `hws-man-08.png`)
    def build_touch_panel(cw, ch, em_mat, rect, stroke, txt):
        m_border = em_mat("border", (0.16, 0.18, 0.22, 1.0))
        m_card = em_mat("card", (0.66, 0.69, 0.73, 1.0))
        m_sub = em_mat("sub", (0.82, 0.84, 0.87, 1.0))
        m_frame = em_mat("frame", (0.14, 0.16, 0.20, 1.0))
        m_btn = em_mat("btn", (0.52, 0.56, 0.61, 1.0))
        m_btn_edge = em_mat("btn_edge", (0.04, 0.05, 0.07, 1.0))
        m_ink = em_mat("ink", (0.008, 0.010, 0.015, 1.0))
        m_muted = em_mat("muted", (0.08, 0.10, 0.13, 1.0))
        m_led_on = em_mat("led_on", (0.01, 0.78, 0.16, 1.0))
        m_led_amber = em_mat("led_amber", (0.85, 0.42, 0.02, 1.0))
        m_led_off = em_mat("led_off", (0.38, 0.41, 0.45, 1.0))
        m_pill = em_mat("pill", (0.025, 0.09, 0.26, 1.0))
        m_white = em_mat("white", (0.96, 0.98, 1.0, 1.0))

        rect(0.0, 0.0, cw, ch, 0.000, m_border)
        rect(0.0, 0.0, cw - 0.012, ch - 0.012, 0.001, m_card)
        stroke(0.0, 0.0, cw - 0.018, ch - 0.018, 0.0025, 0.002, m_frame)

        txt("操作パネル", 0.0, 0.504, 0.004, 0.022, m_ink)
        rect(0.0, 0.484, 0.196, 0.002, 0.003, m_frame)

        def led_row(ly: float, label_str: str, active: bool, amber: bool = False, sz: float = 0.020):
            led_m = (m_led_amber if amber else m_led_on) if active else m_led_off
            rect(-0.076, ly, 0.018, 0.011, 0.004, led_m)
            stroke(-0.076, ly, 0.018, 0.011, 0.0015, 0.0045, m_frame)
            txt(label_str, -0.056, ly, 0.004, sz, m_ink if active else m_muted, align_x="LEFT")

        def tact_btn(by: float, label_str: str, sz: float = 0.024):
            rect(0.0, by, 0.178, 0.042, 0.004, m_btn)
            stroke(0.0, by, 0.178, 0.042, 0.0024, 0.0045, m_btn_edge)
            txt(label_str, 0.0, by, 0.005, sz, m_ink)

        # 1. 製氷 (`急速製氷 / 製氷 / 製氷停止` + `[製氷]` button)
        rect(0.0, 0.388, 0.204, 0.174, 0.002, m_sub)
        stroke(0.0, 0.388, 0.204, 0.174, 0.002, 0.003, m_frame)
        led_row(0.452, "急速製氷", False)
        led_row(0.422, "製氷", True)
        led_row(0.392, "製氷停止", False)
        tact_btn(0.344, "製氷")
        txt("おそうじ (5秒押し)", 0.0, 0.312, 0.004, 0.0135, m_muted)

        # 2. 冷却モード (`急冷凍 / クイック冷却` + `[冷却モード]` button)
        rect(0.0, 0.214, 0.204, 0.148, 0.002, m_sub)
        stroke(0.0, 0.214, 0.204, 0.148, 0.002, 0.003, m_frame)
        led_row(0.264, "急冷凍", True, amber=True)
        led_row(0.232, "クイック冷却", False, sz=0.0185)
        tact_btn(0.172, "冷却モード", sz=0.0215)

        # 3. 節電 (`節電` green LED + `[節電]` button)
        rect(0.0, 0.072, 0.204, 0.112, 0.002, m_sub)
        stroke(0.0, 0.072, 0.204, 0.112, 0.002, 0.003, m_frame)
        led_row(0.105, "節電", True, sz=0.021)
        tact_btn(0.046, "節電")

        # 4. 冷凍 (`強・中・弱` + `[冷凍]` button)
        rect(0.0, -0.092, 0.204, 0.188, 0.002, m_sub)
        stroke(0.0, -0.092, 0.204, 0.188, 0.002, 0.003, m_frame)
        led_row(-0.022, "強  (強め)", False, sz=0.019)
        led_row(-0.054, "中  (標準)", True, sz=0.019)
        led_row(-0.086, "弱  (弱め)", False, sz=0.019)
        tact_btn(-0.146, "冷凍")

        # 5. 冷蔵 / まるごとチルド (`チルド / 強・中・弱` + `[冷蔵]` button)
        rect(0.0, -0.334, 0.204, 0.268, 0.002, m_sub)
        stroke(0.0, -0.334, 0.204, 0.268, 0.002, 0.003, m_frame)
        rect(0.0, -0.224, 0.182, 0.028, 0.004, m_pill)
        txt("まるごとチルド", 0.0, -0.224, 0.005, 0.0185, m_white)
        led_row(-0.262, "チルド", True, sz=0.0195)
        led_row(-0.294, "強  (強め)", False, sz=0.0185)
        led_row(-0.326, "中  (標準)", True, sz=0.0185)
        led_row(-0.358, "弱  (弱め)", False, sz=0.0185)
        tact_btn(-0.422, "冷蔵")

        txt("HITACHI  R-HWS47XL", 0.0, -0.502, 0.004, 0.0155, m_muted)

    bake_ortho_card(touch_path, 240, 1080, 0.240, build_touch_panel)

    # 2. Marugoto Chilled & Triple Power Deodorizer rear tower badge (`640 x 180`)
    def build_marugoto_badge(cw, ch, em_mat, rect, stroke, txt):
        m_plate = em_mat("plate", (0.14, 0.17, 0.22, 1.0))
        m_edge = em_mat("edge", (0.45, 0.47, 0.50, 1.0))
        m_gold = em_mat("gold", (0.68, 0.52, 0.26, 1.0))
        m_navy = em_mat("navy", (0.95, 0.97, 0.99, 1.0))
        m_sub = em_mat("sub", (0.76, 0.82, 0.88, 1.0))

        rect(0.0, 0.0, cw, ch, 0.000, m_edge)
        rect(0.0, 0.0, cw - 0.014, ch - 0.014, 0.001, m_plate)
        stroke(0.0, 0.0, cw - 0.024, ch - 0.024, 0.0030, 0.002, m_gold)
        txt("まるごとチルド", 0.0, 0.028, 0.004, 0.046, m_navy)
        rect(0.0, -0.006, 0.520, 0.0030, 0.003, m_gold)
        txt("トリプルパワー脱臭  |  約+2℃ 低温うるおい冷気", 0.0, -0.040, 0.004, 0.023, m_sub)

    bake_ortho_card(badge_path, 640, 180, 0.640, build_marugoto_badge)

    # 3. Hokkaido Patisserie Milk/Cream Carton 4-face wrap (`1024 x 512`)
    def build_milk_carton_wrap(cw, ch, em_mat, rect, stroke, txt):
        m_ivory = em_mat("ivory", (0.86, 0.84, 0.77, 1.0))
        m_cobalt = em_mat("cobalt", (0.008, 0.032, 0.18, 1.0))
        m_sky = em_mat("sky", (0.05, 0.20, 0.54, 1.0))
        m_gold = em_mat("gold", (0.74, 0.48, 0.08, 1.0))
        m_white = em_mat("white", (0.97, 0.98, 1.0, 1.0))
        m_pale = em_mat("pale", (0.78, 0.88, 0.99, 1.0))

        rect(0.0, 0.0, cw, ch, 0.000, m_ivory)
        rect(0.0, 0.036, cw, 0.276, 0.001, m_cobalt)
        rect(0.0, 0.178, cw, 0.010, 0.002, m_sky)
        rect(0.0, -0.106, cw, 0.010, 0.002, m_gold)
        rect(0.0, -0.214, cw, 0.018, 0.001, m_cobalt)

        for idx in range(4):
            cx = -0.384 + idx * 0.256
            stroke(cx, 0.036, 0.226, 0.244, 0.0035, 0.003, m_white)
            stroke(cx, 0.036, 0.212, 0.230, 0.0018, 0.003, m_gold)
            txt("北海道", cx, 0.122, 0.004, 0.030, m_gold)
            txt("特選牛乳 3.7", cx, 0.068, 0.004, 0.030, m_white)
            txt("生クリーム・パティスリー用", cx, 0.016, 0.004, 0.0155, m_pale)
            txt("1000ml", cx, -0.040, 0.004, 0.028, m_white)
            txt("要冷蔵 2℃", cx, -0.158, 0.004, 0.025, m_cobalt)

    bake_ortho_card(carton_path, 1024, 512, 1.024, build_milk_carton_wrap)
    return touch_path, badge_path, carton_path


def hairline_champagne_material(name: str, albedo_png: Path, orm_png: Path):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (0.68, 0.61, 0.52, 1.0)
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = 0.78
    bsdf.inputs["Roughness"].default_value = 0.25
    bsdf.inputs["Coat Weight"].default_value = 0.15
    bsdf.inputs["Coat Roughness"].default_value = 0.16

    tex_c = nodes.new("ShaderNodeTexImage")
    img_c = bpy.data.images.load(str(albedo_png), check_existing=True)
    img_c.pack()
    tex_c.image = img_c
    links.new(tex_c.outputs["Color"], bsdf.inputs["Base Color"])

    tex_orm = nodes.new("ShaderNodeTexImage")
    img_orm = bpy.data.images.load(str(orm_png), check_existing=True)
    img_orm.colorspace_settings.name = "Non-Color"
    img_orm.pack()
    tex_orm.image = img_orm

    sep = nodes.new("ShaderNodeSeparateColor")
    sep.mode = "RGB"
    links.new(tex_orm.outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    mat["metallic"] = 0.78
    mat["roughness"] = 0.25
    mat["emission"] = 0.0
    return mat


def textured_material(
    name: str,
    png_path: Path,
    roughness: float = 0.20,
    metallic: float = 0.10,
    emission_strength: float = 0.0,
    diffuse_rgba: tuple[float, float, float, float] = (0.85, 0.86, 0.88, 1.0),
):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = diffuse_rgba
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    tex = nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(str(png_path), check_existing=True)
    img.pack()
    tex.image = img
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if emission_strength > 0.0:
        links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission_strength)
    return mat


def translucent_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float = 0.06,
    ior: float = 1.51,
    coat: float = 0.28,
):
    """Translucent dielectric PBR material that transmits light in both Cycles and Three.js glTF."""
    mat = material(name, color, 0.0, roughness, 0.0)
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = False
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Alpha"].default_value = color[3]
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["IOR"].default_value = ior
    bsdf.inputs["Specular IOR Level"].default_value = 0.58
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = 0.04
    return mat


def apply_planar_uv_y(obj, physical_scale: tuple[float, float] | None = None):
    """Map front (-Y) faces cleanly onto UV space using local X/Z vertex bounds or physical metre tile."""
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    xs = [v.co.x for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    u_min, u_max = min(xs), max(xs)
    v_min, v_max = min(zs), max(zs)
    du = max(1e-6, u_max - u_min)
    dv = max(1e-6, v_max - v_min)
    for poly in mesh.polygons:
        for loop_idx in poly.loop_indices:
            v = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            if physical_scale is not None:
                u = (v.x - u_min) / physical_scale[0]
                vv = (v.z - v_min) / physical_scale[1]
                uv_layer[loop_idx].uv = (u, vv)
            else:
                u = (v.x - u_min) / du
                vv = (v.z - v_min) / dv
                uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, vv)))


def apply_box_perimeter_uv(obj):
    """Wrap a 4-sided carton band cleanly around X/Y perimeter in [0, 1] UV space using vertex bounds."""
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    z_min, z_max = min(zs), max(zs)
    dx = max(1e-6, x_max - x_min)
    dy = max(1e-6, y_max - y_min)
    dz = max(1e-6, z_max - z_min)
    for poly in mesh.polygons:
        n = poly.normal
        for loop_idx in poly.loop_indices:
            v = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            vv = (v.z - z_min) / dz
            if abs(n.y) >= abs(n.x):
                t = (v.x - x_min) / dx
                u = 0.25 * t if n.y < 0 else 0.50 + 0.25 * (1.0 - t)
            else:
                t = (v.y - y_min) / dy
                u = 0.25 + 0.25 * t if n.x > 0 else 0.75 + 0.25 * (1.0 - t)
            uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, vv)))


def surfaces(
    albedo_png: Path,
    orm_png: Path,
    touch_png: Path,
    badge_png: Path,
    carton_png: Path,
):
    mats = {
        "champagne_glass": hairline_champagne_material(
            "HWS Crystal Champagne satin front fascia",
            albedo_png,
            orm_png,
        ),
        "champagne_bevel": material(
            "HWS Crystal Champagne perimeter bevel trim",
            (0.45, 0.38, 0.30, 1.0),
            0.82,
            0.22,
        ),
        "champagne_side": material(
            "HWS satin metallic champagne side steel",
            (0.55, 0.49, 0.42, 1.0),
            0.72,
            0.30,
        ),
        "trim_platinum": material(
            "HWS anodized platinum shelf and handle trim",
            (0.81, 0.80, 0.78, 1.0),
            0.90,
            0.16,
        ),
        "galv_rear": material(
            "HWS rear VIP galvanized steel",
            (0.45, 0.48, 0.50, 1.0),
            0.70,
            0.38,
        ),
        "liner_white": material(
            "HWS antibacterial white polystyrene liner",
            (0.81, 0.83, 0.85, 1.0),
            0.02,
            0.24,
        ),
        "drawer_tub": material(
            "HWS frosted polypropylene drawer bin",
            (0.78, 0.82, 0.86, 1.0),
            0.03,
            0.24,
        ),
        "shelf_glass": translucent_material(
            "HWS tempered Marugoto Chilled shelf glass",
            (0.54, 0.82, 0.86, 0.24),
            roughness=0.05,
            ior=1.52,
            coat=0.32,
        ),
        "clear_pocket": translucent_material(
            "HWS crystal SAN door pocket and egg case",
            (0.68, 0.85, 0.96, 0.24),
            roughness=0.05,
            ior=1.54,
            coat=0.34,
        ),
        "hyoon_case": translucent_material(
            "HWS Tokusen Hyo-on minus-1C smoked blue resin",
            (0.42, 0.68, 0.88, 0.36),
            roughness=0.07,
            ior=1.52,
            coat=0.30,
        ),
        "slide_tray_clear": translucent_material(
            "HWS translucent upper slide case resin",
            (0.58, 0.78, 0.92, 0.32),
            roughness=0.08,
            ior=1.50,
            coat=0.24,
        ),
        "water_tank": translucent_material(
            "HWS 1.1L auto-ice water supply tank",
            (0.58, 0.82, 0.95, 0.26),
            roughness=0.05,
            ior=1.52,
            coat=0.30,
        ),
        "potable_water": translucent_material(
            "HWS chilled potable water level",
            (0.18, 0.62, 0.92, 0.40),
            roughness=0.04,
            ior=1.333,
            coat=0.20,
        ),
        "water_tank_lid": material(
            "HWS auto-ice water tank blue lid",
            (0.10, 0.34, 0.68, 1.0),
            0.06,
            0.18,
        ),
        "delicious_alu": material(
            "HWS Delicious Freezing anodized aluminum tray",
            (0.76, 0.79, 0.83, 1.0),
            0.92,
            0.19,
        ),
        "platinum_cat": translucent_material(
            "HWS Ru platinum catalyst freshness cover",
            (0.32, 0.70, 0.68, 0.38),
            roughness=0.10,
            ior=1.50,
            coat=0.24,
        ),
        "egg_shell": material(
            "Patisserie fresh ivory egg shell",
            (0.92, 0.86, 0.76, 1.0),
            0.0,
            0.34,
        ),
        "gasket": material(
            "HWS magnetic antimicrobial door gasket",
            (0.72, 0.74, 0.76, 1.0),
            0.0,
            0.55,
        ),
        "toe_grille_dark": material(
            "HWS lower front toe-kick grille charcoal",
            (0.062, 0.065, 0.070, 1.0),
            0.12,
            0.40,
        ),
        "recess_dark": material(
            "HWS recessed shadow gap charcoal",
            (0.024, 0.026, 0.029, 1.0),
            0.10,
            0.50,
        ),
        "touch_bezel": textured_material(
            "HWS interior jamb capacitive touch control panel",
            touch_png,
            roughness=0.18,
            metallic=0.06,
            emission_strength=0.02,
            diffuse_rgba=(0.82, 0.84, 0.87, 1.0),
        ),
        "marugoto_badge": textured_material(
            "HWS Marugoto Chilled metallic emblem",
            badge_png,
            roughness=0.22,
            metallic=0.52,
            emission_strength=0.0,
            diffuse_rgba=(0.70, 0.71, 0.73, 1.0),
        ),
        "led_warm": material(
            "HWS ceiling and side wide LED illumination",
            (1.0, 0.90, 0.72, 1.0),
            0.0,
            0.18,
            1.15,
        ),
        "ice_crystal": translucent_material(
            "HWS automatic clear ice cubes",
            (0.55, 0.82, 0.98, 0.38),
            roughness=0.05,
            ior=1.31,
            coat=0.30,
        ),
        "wordmark_ink": material(
            "HWS satin bronze wordmark lettering",
            (0.22, 0.18, 0.14, 1.0),
            0.58,
            0.22,
        ),
        "foot_resin": material(
            "HWS base leveling foot elastomer",
            (0.035, 0.037, 0.042, 1.0),
            0.04,
            0.62,
        ),
        "carton_white": material(
            "Patisserie Hokkaido fresh cream carton board",
            (0.96, 0.95, 0.91, 1.0),
            0.02,
            0.30,
        ),
        "carton_blue": textured_material(
            "Patisserie Hokkaido milk carton cobalt accent",
            carton_png,
            roughness=0.24,
            metallic=0.03,
            emission_strength=0.0,
            diffuse_rgba=(0.14, 0.32, 0.62, 1.0),
        ),
        "carton_cap": material(
            "Patisserie carton hygienic polyethylene cap",
            (0.94, 0.95, 0.97, 1.0),
            0.04,
            0.22,
        ),
    }
    for m in mats.values():
        m["metallic"] = float(m.get("metallic", 0.0))
        m["roughness"] = float(m.get("roughness", 0.4))
        m["emission"] = float(m.get("emission", 0.0))
    return mats


def text_label(name, text, position, size, surface, parent, rot_x=math.pi / 2):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.00012
    data.resolution_u = 3
    if HIRAGINO_FONT_PATH.exists():
        data.font = bpy.data.fonts.load(str(HIRAGINO_FONT_PATH), check_existing=True)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = rot_x
    return finish(obj, name, surface, parent)


def build_cabinet_and_interior(root, mat):
    # 1. Left & right VIP insulated side walls: exact X in [-0.3000, +0.3000], Y in [-0.3185, +0.3505], Z in [0.0180, 1.8200]
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        side_wall = box(
            f"Cabinet VIP {side_name} side wall",
            (side_sign * 0.2890, 0.0160, 0.9190),
            (0.0220, 0.6690, 1.8020),
            mat["champagne_side"],
            root,
            0.0,
        )
        clean_mesh_object(side_wall, sharp_z=True)

    # 2. Top main cabinet roof (`Z = 1.8040 .. 1.8200 m`) + sleek recessed inverter/hinge cover reaching exact Z = +1.8330 m
    roof_main = box(
        "Cabinet top insulated roof",
        (0.0, 0.0160, 1.8120),
        (0.5560, 0.6690, 0.0160),
        mat["champagne_side"],
        root,
        0.0,
    )
    clean_mesh_object(roof_main, sharp_z=True)

    # Top inverter & hinge housing reaching exact Z = +1.8330 m (`hws-man-01.png` / `hws-man-06.png`)
    top_canopy = box(
        "Top hinge and inverter cover",
        (0.0, 0.0150, 1.8265),
        (0.5960, 0.5200, 0.0130),
        mat["champagne_side"],
        root,
        0.0,
    )
    clean_mesh_object(top_canopy, sharp_z=True)

    left_hinge_bracket = box(
        "Upper left zero-clearance hinge cover",
        (-0.2440, -0.2920, 1.8240),
        (0.1080, 0.1120, 0.0140),
        mat["champagne_side"],
        root,
        0.001,
    )
    clean_mesh_object(left_hinge_bracket, sharp_z=False)

    # 3. Rear VIP insulated back panel (`Y_max = +0.3505 m`, `Z = 0.2400 .. 1.8040 m`) & lower R600a compressor bay
    rear_wall = box(
        "Cabinet rear VIP back panel",
        (0.0, 0.3345, 1.0220),
        (0.5560, 0.0320, 1.5640),
        mat["galv_rear"],
        root,
        0.0,
    )
    clean_mesh_object(rear_wall, sharp_z=False)

    comp_step = box(
        "Rear lower PAM inverter compressor bulkhead",
        (0.0, 0.2820, 0.1290),
        (0.5560, 0.0280, 0.2220),
        mat["galv_rear"],
        root,
        0.001,
    )
    clean_mesh_object(comp_step, sharp_z=False)
    for idx in range(14):
        rx = -0.2100 + idx * 0.0320
        slot = box(
            f"Rear compressor louver {idx:02d}",
            (rx, 0.3485, 0.0950),
            (0.0180, 0.0030, 0.0920),
            mat["recess_dark"],
            root,
            0.0003,
        )
        clean_mesh_object(slot, sharp_z=False)

    # Base frame & sculpted louvered lower front `脚カバー` toe-kick grille (`hws-man-06.png`, `hws-man-08.png`)
    base_frame = box(
        "Lower chassis base pan",
        (0.0, 0.0050, 0.0270),
        (0.5560, 0.6300, 0.0180),
        mat["galv_rear"],
        root,
        0.001,
    )
    clean_mesh_object(base_frame, sharp_z=False)

    toe_grille = box(
        "Front lower toe kick grille",
        (0.0, -0.3410, 0.0185),
        (0.5980, 0.0140, 0.0210),
        mat["toe_grille_dark"],
        root,
        0.001,
    )
    clean_mesh_object(toe_grille, sharp_z=False)
    for l_idx, lz in enumerate((0.0135, 0.0205), 1):
        slat = box(
            f"Front toe kick louver slot {l_idx}",
            (0.0, -0.3478, lz),
            (0.5680, 0.0030, 0.0032),
            mat["recess_dark"],
            root,
            0.0,
        )
        clean_mesh_object(slat, sharp_z=True)
    for s_sign, s_tag in ((-1.0, "L"), (1.0, "R")):
        clip_notch = box(
            f"Toe kick leg-cover clip recess {s_tag}",
            (s_sign * 0.2580, -0.3475, 0.0175),
            (0.0280, 0.0035, 0.0120),
            mat["recess_dark"],
            root,
            0.0,
        )
        clean_mesh_object(clip_notch, sharp_z=True)

    # Four leveling feet / base rollers touching exact Z = 0.0000 m
    for fname, fx, fy in FOOT_POSITIONS:
        foot = empty(fname, (fx, fy, 0.0), root)
        foot["contact_plane_z_m"] = 0.0
        collar = cylinder(
            f"{fname}_collar",
            (0.0, 0.0, 0.0120),
            0.0210,
            0.0120,
            mat["galv_rear"],
            foot,
        )
        clean_mesh_object(collar, sharp_z=True)
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=24, radius=0.0175, depth=0.0060, location=(0.0, 0.0, 0.0030)
        )
        pad = finish(bpy.context.object, f"{fname}_pad", mat["foot_resin"], foot, 0.0)
        clean_mesh_object(pad, sharp_z=True)

    # Horizontal & vertical insulated compartment mullions
    for mname, mpos, mdims in (
        ("Upper-to-mid insulated mullion", (0.0, 0.0050, 0.9020), (0.5560, 0.6350, 0.0240)),
        ("Mid ice-freezer vertical mullion", (-0.0200, -0.1050, 0.7825), (0.0180, 0.4250, 0.2150)),
        ("Mid-to-lower freezer mullion", (0.0, 0.0050, 0.6725), (0.5560, 0.6350, 0.0180)),
        ("Freezer-to-vegetable insulated mullion", (0.0, 0.0050, 0.3425), (0.5560, 0.6350, 0.0180)),
    ):
        mul = box(mname, mpos, mdims, mat["liner_white"], root, 0.0015)
        clean_mesh_object(mul, sharp_z=False)

    # Deep sculpted dark shadow channels behind the horizontal hand-grip gaps (`ハンドル`) and mid vertical split
    for cname, cpos, cdims in (
        ("Upper-to-mid recessed grip channel", (0.0, -0.3300, 0.8950), (0.5970, 0.0360, 0.0260)),
        ("Mid vertical drawer gap shadow strip", (-0.0200, -0.3360, 0.7825), (0.0140, 0.0240, 0.2120)),
        ("Mid-to-lower recessed grip channel", (0.0, -0.3300, 0.6750), (0.5970, 0.0360, 0.0240)),
        ("Lower-to-veg recessed grip channel", (0.0, -0.3300, 0.3450), (0.5970, 0.0360, 0.0240)),
    ):
        ch = box(cname, cpos, cdims, mat["recess_dark"], root, 0.0)
        clean_mesh_object(ch, sharp_z=True)

    # Upper Refrigerator (`冷蔵室 243 L`) cavity white liner walls (`Z = 0.9140 .. 1.8020 m`)
    cavity_rear = box(
        "Refrigerator cavity rear liner",
        (0.0, 0.3080, 1.3580),
        (0.5240, 0.0160, 0.8880),
        mat["liner_white"],
        root,
        0.002,
    )
    clean_mesh_object(cavity_rear, sharp_z=False)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        cwall = box(
            f"Refrigerator cavity {side_name} liner",
            (side_sign * 0.2680, 0.0050, 1.3580),
            (0.0180, 0.6100, 0.8880),
            mat["liner_white"],
            root,
            0.002,
        )
        clean_mesh_object(cwall, sharp_z=False)
        # Molded shelf support rails (`高さかわるん棚` adjustable support ribs on left/right liner walls)
        for rz in (1.1340, 1.2650, 1.3390, 1.4650, 1.5390, 1.6350):
            rail = box(
                f"Cavity {side_name} shelf support rail {int(rz*1000)}",
                (side_sign * 0.2565, 0.0550, rz),
                (0.0050, 0.4200, 0.0070),
                mat["liner_white"],
                root,
                0.001,
            )
            clean_mesh_object(rail, sharp_z=False)
        # Flush vertical warm-white cavity side LED diffuser bar + platinum frame
        side_led_frame = box(
            f"Refrigerator {side_name} LED bezel",
            (side_sign * 0.2582, -0.1880, 1.4450),
            (0.0030, 0.0180, 0.5200),
            mat["trim_platinum"],
            root,
            0.0004,
        )
        clean_mesh_object(side_led_frame, sharp_z=False)
        side_led = box(
            f"Refrigerator {side_name} LED diffuser strip",
            (side_sign * 0.2572, -0.1880, 1.4450),
            (0.0020, 0.0110, 0.5040),
            mat["led_warm"],
            root,
            0.0003,
        )
        clean_mesh_object(side_led, sharp_z=False)

    # Interior Left-Jamb Capacitive Touch Control Panel (`操作パネル`, `hws-man-08.png`)
    # Positioned at Z = 1.1885 m (in the exact 171 mm vertical gap between Door Pocket 1 and Door Pocket 2!)
    jamb_housing = box(
        "Interior jamb control housing",
        (-0.2512, -0.2490, 1.1885),
        (0.0440, 0.0160, 0.1740),
        mat["liner_white"],
        root,
        0.002,
    )
    jamb_housing.rotation_euler = Euler((0.0, 0.0, math.radians(54.0)), "XYZ")
    clean_mesh_object(jamb_housing, sharp_z=False)

    jamb_bezel = box(
        "Interior jamb control platinum bezel",
        (-0.2439, -0.2544, 1.1885),
        (0.0410, 0.0050, 0.1710),
        mat["trim_platinum"],
        root,
        0.0008,
    )
    jamb_bezel.rotation_euler = Euler((0.0, 0.0, math.radians(54.0)), "XYZ")
    clean_mesh_object(jamb_bezel, sharp_z=False)

    jamb_panel = box(
        "Interior jamb touch control panel",
        (-0.2418, -0.2560, 1.1885),
        (0.0370, 0.0016, 0.1665),
        mat["touch_bezel"],
        root,
        0.0,
    )
    jamb_panel.rotation_euler = Euler((0.0, 0.0, math.radians(54.0)), "XYZ")
    clean_mesh_object(jamb_panel, sharp_z=True)

    # Multi-flow Marugoto Chilled rear duct + brushed platinum accent strips + baked metallic badge + louvers
    air_tower_outer = box(
        "Marugoto Chilled rear multi-flow outer cheek",
        (0.0, 0.2950, 1.4500),
        (0.2240, 0.0140, 0.5900),
        mat["liner_white"],
        root,
        0.002,
    )
    clean_mesh_object(air_tower_outer, sharp_z=False)
    air_tower = box(
        "Marugoto Chilled rear multi-flow duct",
        (0.0, 0.2870, 1.4500),
        (0.1860, 0.0180, 0.5760),
        mat["liner_white"],
        root,
        0.003,
    )
    clean_mesh_object(air_tower, sharp_z=False)
    for side_sign, s_tag in ((-1.0, "L"), (1.0, "R")):
        tower_trim = box(
            f"Marugoto Chilled duct platinum trim {s_tag}",
            (side_sign * 0.0900, 0.2775, 1.4500),
            (0.0065, 0.0030, 0.5620),
            mat["trim_platinum"],
            root,
            0.0005,
        )
        clean_mesh_object(tower_trim, sharp_z=False)

    # Crisp baked metallic badge (`まるごとチルド / トリプルパワー脱臭`) & deodorizer intake grille
    deod_badge = box(
        "Triple Power Deodorizer rear intake",
        (0.0, 0.2770, 1.4820),
        (0.1460, 0.0030, 0.0420),
        mat["trim_platinum"],
        root,
        0.0006,
    )
    clean_mesh_object(deod_badge, sharp_z=False)

    emblem_plate = box(
        "Marugoto Chilled emblem plate",
        (0.0, 0.2752, 1.4820),
        (0.1420, 0.0012, 0.0400),
        mat["marugoto_badge"],
        root,
        0.0,
    )
    clean_mesh_object(emblem_plate, sharp_z=True)

    for vent_z in (1.2050, 1.2850, 1.3950, 1.5850, 1.6850):
        for vx in (-0.0560, 0.0560):
            tag = f"{int(vent_z*1000)}_{'L' if vx < 0 else 'R'}"
            vent = box(
                f"Chilled air louver {tag}",
                (vx, 0.2775, vent_z),
                (0.0460, 0.0035, 0.0150),
                mat["recess_dark"],
                root,
                0.0004,
            )
            clean_mesh_object(vent, sharp_z=False)
            vane = box(
                f"Chilled air louver vane {tag}",
                (vx, 0.2762, vent_z),
                (0.0440, 0.0020, 0.0024),
                mat["trim_platinum"],
                root,
                0.0,
            )
            clean_mesh_object(vane, sharp_z=True)

    # Flush ceiling wide warm-white LED diffuser bar (`LED 庫内灯`, `hws-man-10.png`)
    led_bezel = box(
        "Refrigerator ceiling LED platinum bezel",
        (0.0, -0.1150, 1.7985),
        (0.3560, 0.0480, 0.0060),
        mat["trim_platinum"],
        root,
        0.0008,
    )
    clean_mesh_object(led_bezel, sharp_z=False)
    led_lamp = box(
        "Refrigerator ceiling wide LED bar",
        (0.0, -0.1150, 1.7965),
        (0.3360, 0.0360, 0.0060),
        mat["led_warm"],
        root,
        0.0008,
    )
    clean_mesh_object(led_lamp, sharp_z=False)

    # Three Tempered-Glass Marugoto Chilled Shelves (`+2 °C`, `118 L`):
    # Shelf 1 top at exact Z = 1.1400 m (supports 6-DOF hws_milk_carton!)
    for idx, (sz_top, sdepth) in enumerate(
        ((1.1400, 0.4400), (1.3450, 0.4400), (1.5450, 0.4200)), 1
    ):
        glass_plate = box(
            f"Marugoto Chilled glass shelf {idx}",
            (0.0, 0.0550, sz_top - 0.0040),
            (0.5120, sdepth, 0.0080),
            mat["shelf_glass"],
            root,
            0.0,
        )
        clean_mesh_object(glass_plate, sharp_z=True)
        front_trim = box(
            f"Marugoto Chilled shelf {idx} platinum trim",
            (0.0, 0.0550 - sdepth * 0.5 - 0.0050, sz_top - 0.0040),
            (0.5140, 0.0100, 0.0110),
            mat["trim_platinum"],
            root,
            0.001,
        )
        clean_mesh_object(front_trim, sharp_z=False)
        rear_trim = box(
            f"Marugoto Chilled shelf {idx} rear gasket bar",
            (0.0, 0.0550 + sdepth * 0.5 + 0.0030, sz_top - 0.0040),
            (0.5120, 0.0060, 0.0095),
            mat["liner_white"],
            root,
            0.001,
        )
        clean_mesh_object(rear_trim, sharp_z=False)

    # Fixed lower partition shelf (`固定棚`, `hws-man-10.png`) above Hyo-on, egg case & water tank (`Z_top = 1.0945 m`)
    fixed_shelf = box(
        "Refrigerator lower fixed partition shelf",
        (0.0, 0.0600, 1.0910),
        (0.5120, 0.4200, 0.0070),
        mat["shelf_glass"],
        root,
        0.0,
    )
    clean_mesh_object(fixed_shelf, sharp_z=True)
    fixed_shelf_trim = box(
        "Refrigerator lower fixed shelf front trim",
        (0.0, -0.1530, 1.0910),
        (0.5140, 0.0090, 0.0100),
        mat["trim_platinum"],
        root,
        0.001,
    )
    clean_mesh_object(fixed_shelf_trim, sharp_z=False)

    # Vertical bay divider separating left `給水タンク + 小物ケース` bay (`X < -0.122`) from wide `特鮮氷温ルーム` (`hws-man-08.png`, `hws-man-10.png`)
    lower_bay_div = box(
        "Lower refrigerator Hyo-on and tank bay divider",
        (-0.1220, 0.0600, 1.0010),
        (0.0080, 0.4100, 0.1720),
        mat["liner_white"],
        root,
        0.001,
    )
    clean_mesh_object(lower_bay_div, sharp_z=False)
    egg_bay_shelf = box(
        "Lower left water-tank and egg-case shelf",
        (-0.1900, 0.0600, 1.0050),
        (0.1280, 0.4050, 0.0060),
        mat["liner_white"],
        root,
        0.001,
    )
    clean_mesh_object(egg_bay_shelf, sharp_z=False)

    # Tokusen Hyo-on (`特鮮氷温ルーム`, `-1 °C`, `13 L`) indirect-cooled case (`X in [-0.116, +0.252]`, center `+0.0680`)
    # Covers `hws_tokusen_hyoon_site` at `(-0.0680, 0.0650, 0.9850)`!
    hyoon_box = open_top_bin(
        "Tokusen Hyo-on minus-1C preservation case",
        (0.0680, 0.0650, 0.9960),
        (0.3660, 0.4060, 0.1500),
        wall_t=0.0045,
        floor_t=0.0050,
        surface=mat["hyoon_case"],
        parent=root,
        sharp=True,
    )
    hyoon_front_window = box(
        "Tokusen Hyo-on front smoked window",
        (0.0680, -0.1415, 1.0020),
        (0.3680, 0.0050, 0.1580),
        mat["hyoon_case"],
        root,
        0.0,
    )
    clean_mesh_object(hyoon_front_window, sharp_z=True)
    hyoon_handle = box(
        "Tokusen Hyo-on front pull handle bar",
        (0.0680, -0.1480, 1.0440),
        (0.3540, 0.0110, 0.0150),
        mat["trim_platinum"],
        root,
        0.0015,
    )
    clean_mesh_object(hyoon_handle, sharp_z=False)
    hyoon_tray = box(
        "Tokusen Hyo-on aluminum thermal plate",
        (0.0680, 0.0650, 0.9295),
        (0.3460, 0.3860, 0.0050),
        mat["delicious_alu"],
        root,
        0.0005,
    )
    clean_mesh_object(hyoon_tray, sharp_z=True)

    # Automatic Ice Water Supply Tank (`給水タンク`, `1.1 L`) on lower-left above `製氷室` (`hws-man-08.png`, `hws-man-10.png`)
    water_tank = open_top_bin(
        "Auto-ice 1.1L potable water supply tank",
        (-0.1900, 0.0550, 0.9550),
        (0.1180, 0.3860, 0.0700),
        wall_t=0.0040,
        floor_t=0.0045,
        surface=mat["water_tank"],
        parent=root,
        sharp=True,
    )
    water_level = box(
        "Auto-ice tank internal water level",
        (-0.1900, 0.0550, 0.9460),
        (0.1060, 0.3720, 0.0440),
        mat["potable_water"],
        root,
        0.0,
    )
    clean_mesh_object(water_level, sharp_z=True)
    tank_lid = box(
        "Auto-ice water tank removable blue lid",
        (-0.1900, 0.0550, 0.9935),
        (0.1210, 0.3900, 0.0070),
        mat["water_tank_lid"],
        root,
        0.0015,
    )
    clean_mesh_object(tank_lid, sharp_z=False)
    pump_cap = cylinder(
        "Auto-ice water tank feed pump cap",
        (-0.1900, -0.0650, 0.9990),
        0.0210,
        0.0060,
        mat["water_tank_lid"],
        root,
    )
    clean_mesh_object(pump_cap, sharp_z=True)
    suction_straw = cylinder(
        "Auto-ice tank feed suction straw",
        (-0.1900, -0.0650, 0.9580),
        0.0055,
        0.0620,
        mat["liner_white"],
        root,
    )
    clean_mesh_object(suction_straw, sharp_z=False)
    tank_grip = box(
        "Auto-ice water tank front carry handle",
        (-0.1900, -0.1415, 0.9760),
        (0.0720, 0.0070, 0.0110),
        mat["water_tank_lid"],
        root,
        0.0015,
    )
    clean_mesh_object(tank_grip, sharp_z=False)

    # Crystal-clear `小物ケース` (`14-egg tray`, `hws-man-08.png`, `hws-man-10.png`, `hws-man-12.png`) right above water tank
    egg_case = open_top_bin(
        "Refrigerator 14-egg and accessory case",
        (-0.1900, 0.0550, 1.0440),
        (0.1180, 0.3820, 0.0680),
        wall_t=0.0035,
        floor_t=0.0040,
        surface=mat["clear_pocket"],
        parent=root,
        sharp=True,
    )
    egg_stand = box(
        "Refrigerator 14-egg stand insert",
        (-0.1900, 0.0450, 1.0220),
        (0.1060, 0.3560, 0.0140),
        mat["liner_white"],
        root,
        0.0015,
    )
    clean_mesh_object(egg_stand, sharp_z=False)
    # Sculpted patisserie eggs visible through the crystal-clear front/side wall of `小物ケース`
    for e_idx, (ex, ey) in enumerate(
        (
            (-0.2140, -0.0950),
            (-0.1660, -0.0950),
            (-0.2140, -0.0420),
            (-0.1660, -0.0420),
            (-0.2140, 0.0110),
            (-0.1660, 0.0110),
            (-0.2140, 0.0640),
            (-0.1660, 0.0640),
        ),
        1,
    ):
        bpy.ops.mesh.primitive_uv_sphere_add(
            segments=16, ring_count=10, radius=0.0205, location=(ex, ey, 1.0440)
        )
        egg = bpy.context.object
        egg.scale = (0.94, 0.94, 1.24)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish(egg, f"Patisserie chilled egg {e_idx:02d}", mat["egg_shell"], root, 0.0)
        clean_mesh_object(egg, sharp_z=False)

    # Named compartment thermal zone sites
    chilled_site = empty("hws_marugoto_chilled_site", (-0.0850, -0.0350, 1.1400), root)
    chilled_site["zone_temp_c"] = 2.0
    chilled_site["volume_l"] = 118.0
    hyoon_site = empty("hws_tokusen_hyoon_site", (-0.0680, 0.0650, 0.9850), root)
    hyoon_site["zone_temp_c"] = -1.0
    hyoon_site["volume_l"] = 13.0

    # Rear lower power cord & R600a compressor cylinder (`hws_utilities`, strictly inside envelope)
    util = empty("hws_utilities", (0.0, 0.0, 0.0), root)
    util["status"] = "Rear R600a PAM inverter compressor & 100V AC cord inside rear service bay"
    comp_dome = cylinder(
        "R600a PAM inverter hermetic compressor",
        (-0.0950, 0.3120, 0.1150),
        0.0320,
        0.1350,
        mat["recess_dark"],
        util,
    )
    clean_mesh_object(comp_dome, sharp_z=False)
    plug = box(
        "Rear JIS 100V power cord bushing",
        (0.1850, 0.3260, 0.1850),
        (0.0320, 0.0260, 0.0380),
        mat["foot_resin"],
        util,
        0.002,
    )
    clean_mesh_object(plug, sharp_z=False)
    return top_canopy, chilled_site, jamb_panel, emblem_plate, egg_case, water_tank, hyoon_box


def build_left_hinged_fridge_door(root, mat):
    # Left-hinged upper refrigerator door (`hws_fridge_door`, `左開き`, `243 L`)
    # Pivot on -X left front edge: (-0.2920, -0.3420, 1.3600) m.
    door = empty("hws_fridge_door", FRIDGE_DOOR_PIVOT, root)
    door["joint_type"] = "hinge"
    door["axis_blender"] = "-Z"
    door["axis_gltf"] = "-Y"
    door["range_rad"] = [0.0, round(FRIDGE_DOOR_MAX_RAD, 7)]
    door["hinge_side"] = "left (-X, XL model)"

    # Pure uninterrupted Simple Design (`シンプルデザイン`) Crystal Champagne hairline steel fascia
    # `Z_world = 0.9050 .. 1.8210 m` (`z_local center = +0.0030, height = 0.9160`), `Y_front = -0.3499 m`
    front_glass = box(
        "Fridge door Crystal Champagne front fascia",
        (0.2920, -0.0064, 0.0030),
        (0.5984, 0.0030, 0.9160),
        mat["champagne_glass"],
        door,
        0.0,
    )
    clean_mesh_object(front_glass, sharp_z=True)

    # Darker warm champagne-bronze chamfered perimeter frame behind front sheet
    door_bevel_frame = box(
        "Fridge door perimeter chamfer trim",
        (0.2920, -0.0042, 0.0030),
        (0.5994, 0.0030, 0.9180),
        mat["champagne_bevel"],
        door,
        0.0,
    )
    clean_mesh_object(door_bevel_frame, sharp_z=True)

    # Insulated door chassis behind front fascia
    door_core = box(
        "Fridge door VIP insulated core",
        (0.2920, 0.0125, 0.0030),
        (0.5960, 0.0330, 0.9120),
        mat["champagne_side"],
        door,
        0.002,
    )
    clean_mesh_object(door_core, sharp_z=False)

    # Right-edge & bottom ergonomic recessed hand grip channels (`ハンドル`, `hws-man-08.png`)
    right_pocket = box(
        "Fridge door right-side grip pocket",
        (0.5855, 0.0080, -0.0650),
        (0.0130, 0.0200, 0.4200),
        mat["recess_dark"],
        door,
        0.001,
    )
    clean_mesh_object(right_pocket, sharp_z=False)
    bottom_grip = box(
        "Fridge door lower finger pull groove",
        (0.2920, 0.0040, -0.4510),
        (0.5760, 0.0200, 0.0140),
        mat["recess_dark"],
        door,
        0.001,
    )
    clean_mesh_object(bottom_grip, sharp_z=False)
    bottom_trim = box(
        "Fridge door lower bevel pull lip",
        (0.2920, -0.0038, -0.4555),
        (0.5988, 0.0045, 0.0035),
        mat["champagne_bevel"],
        door,
        0.0,
    )
    clean_mesh_object(bottom_trim, sharp_z=True)

    # White antibacterial inner liner + left/right pocket support dikes + perimeter magnetic gasket
    inner_liner = box(
        "Fridge door inner white liner",
        (0.2920, 0.0340, 0.0020),
        (0.5100, 0.0120, 0.8640),
        mat["liner_white"],
        door,
        0.002,
    )
    clean_mesh_object(inner_liner, sharp_z=False)
    for sx, s_tag in ((0.0680, "left"), (0.5160, "right")):
        dike = box(
            f"Fridge door inner {s_tag} pocket support dike",
            (sx, 0.0520, 0.0020),
            (0.0160, 0.0280, 0.8160),
            mat["liner_white"],
            door,
            0.002,
        )
        clean_mesh_object(dike, sharp_z=False)

    gasket = frame(
        "Fridge door magnetic perimeter gasket",
        (0.2920, 0.0420, 0.0020),
        (0.5340, 0.8800, 0.0100),
        (0.5060, 0.8520, 0.0090),
        0.006,
        mat["gasket"],
        door,
    )
    clean_mesh_object(gasket, sharp_z=False)

    # Three hollow crystal-clear SAN resin door pockets (`hws-man-10.png`:
    # 1: lower deep 2-row `ダブルポケット` with bottle divider, 2: mid `ポケット`, 3: upper `高さかわるポケット`)
    for p_idx, (pz_local, ph, pdepth) in enumerate(
        ((-0.3280, 0.1420, 0.0840), (-0.0380, 0.0960, 0.0760), (0.2320, 0.0840, 0.0720)),
        1,
    ):
        open_top_bin(
            f"Fridge door clear bottle pocket {p_idx}",
            (0.2920, 0.0400 + pdepth * 0.5, pz_local),
            (0.4200, pdepth, ph),
            wall_t=0.0035,
            floor_t=0.0040,
            surface=mat["clear_pocket"],
            parent=door,
            sharp=True,
        )
        ptrim = box(
            f"Fridge door pocket {p_idx} top rail",
            (0.2920, 0.0400 + pdepth - 0.0018, pz_local + ph * 0.5 + 0.0020),
            (0.4210, 0.0055, 0.0060),
            mat["trim_platinum"],
            door,
            0.0006,
        )
        clean_mesh_object(ptrim, sharp_z=False)

    # Lower 2-row `ダブルポケット` internal bottle divider rail (`hws-man-10.png`)
    bottle_div = box(
        "Fridge door lower 2L bottle divider rail",
        (0.2920, 0.0790, -0.3120),
        (0.4100, 0.0035, 0.0880),
        mat["clear_pocket"],
        door,
        0.0,
    )
    clean_mesh_object(bottle_div, sharp_z=True)
    bottle_div_cap = box(
        "Fridge door lower 2L divider platinum cap",
        (0.2920, 0.0790, -0.2660),
        (0.4110, 0.0048, 0.0050),
        mat["trim_platinum"],
        door,
        0.0005,
    )
    clean_mesh_object(bottle_div_cap, sharp_z=False)

    # Refined subtle `HITACHI` wordmark at upper-left (`hws-man-01.png`), strictly inside Y >= -0.3505 m
    text_label(
        "Fridge door HITACHI wordmark",
        "HITACHI",
        (0.0740, -0.00805, 0.4140),
        0.0112,
        mat["wordmark_ink"],
        door,
    )
    return door, front_glass


def build_pull_drawer(
    root,
    mat,
    body_name,
    origin,
    travel_m,
    front_center_x_local,
    front_width,
    front_height,
    tub_width,
    tub_depth,
    tub_height,
    special_kind=None,
):
    drawer = empty(body_name, origin, root)
    drawer["joint_type"] = "slide"
    drawer["axis_blender"] = "-Y"
    drawer["travel_m"] = travel_m

    # Satin Crystal Champagne front plate with front face at exact Y = -0.350500 m
    # Sculpted 12 mm top recessed finger-pull channel (`ハンドル`, `hws-man-01.png` / `hws-man-08.png`)
    fascia_h = front_height - 0.0120
    fascia_z = -0.0050
    front_plate = box(
        f"{body_name}_front_fascia",
        (front_center_x_local, -0.0070, fascia_z),
        (front_width - 0.0012, 0.0030, fascia_h),
        mat["champagne_glass"],
        drawer,
        0.0,
    )
    clean_mesh_object(front_plate, sharp_z=True)

    # Darker champagne-bronze chamfered perimeter frame & bevelled top finger-pull bar
    bevel_trim = box(
        f"{body_name}_perimeter_bevel",
        (front_center_x_local, -0.0046, fascia_z),
        (front_width, 0.0024, fascia_h + 0.0022),
        mat["champagne_bevel"],
        drawer,
        0.0,
    )
    clean_mesh_object(bevel_trim, sharp_z=True)

    top_handle_cap = box(
        f"{body_name}_top_handle_trim",
        (front_center_x_local, -0.0035, fascia_z + fascia_h * 0.5 + 0.0020),
        (front_width, 0.0065, 0.0035),
        mat["champagne_bevel"],
        drawer,
        0.0,
    )
    clean_mesh_object(top_handle_cap, sharp_z=True)

    front_core = box(
        f"{body_name}_insulated_door_core",
        (front_center_x_local, 0.0125, -0.0030),
        (front_width - 0.0030, 0.0330, front_height - 0.0100),
        mat["champagne_side"],
        drawer,
        0.002,
    )
    clean_mesh_object(front_core, sharp_z=False)

    # Deep recessed top finger pull groove along drawer upper edge (`ハンドル`)
    pull_groove = box(
        f"{body_name}_top_pull_groove",
        (front_center_x_local, 0.0025, front_height * 0.5 - 0.0055),
        (front_width - 0.0060, 0.0190, 0.0130),
        mat["recess_dark"],
        drawer,
        0.0,
    )
    clean_mesh_object(pull_groove, sharp_z=True)

    # Inner frosted drawer tub (floor + left/right/rear walls + steel slide rails)
    tub_y_center = 0.0320 + tub_depth * 0.5
    tub_z_floor = -front_height * 0.5 + 0.0240
    floor_box = box(
        f"{body_name}_bin_floor",
        (front_center_x_local, tub_y_center, tub_z_floor),
        (tub_width, tub_depth, 0.0100),
        mat["drawer_tub"],
        drawer,
        0.0015,
    )
    clean_mesh_object(floor_box, sharp_z=False)
    rear_box = box(
        f"{body_name}_bin_rear_wall",
        (front_center_x_local, 0.0320 + tub_depth - 0.0060, tub_z_floor + tub_height * 0.5),
        (tub_width, 0.0120, tub_height),
        mat["drawer_tub"],
        drawer,
        0.0015,
    )
    clean_mesh_object(rear_box, sharp_z=False)
    for sx, sname in ((-1.0, "left"), (1.0, "right")):
        swall = box(
            f"{body_name}_bin_{sname}_wall",
            (
                front_center_x_local + sx * (tub_width * 0.5 - 0.0060),
                tub_y_center,
                tub_z_floor + tub_height * 0.5,
            ),
            (0.0120, tub_depth, tub_height),
            mat["drawer_tub"],
            drawer,
            0.0015,
        )
        clean_mesh_object(swall, sharp_z=False)
        srail = box(
            f"{body_name}_{sname}_slide_rail",
            (
                front_center_x_local + sx * (tub_width * 0.5 + 0.0030),
                tub_y_center,
                tub_z_floor + tub_height * 0.58,
            ),
            (0.0050, tub_depth - 0.0160, 0.0180),
            mat["trim_platinum"],
            drawer,
            0.0008,
        )
        clean_mesh_object(srail, sharp_z=False)

    if special_kind == "ice":
        # Front ice scoop tray divider (`アイスコップ` holder, `instruction-manual.pdf` p. 14)
        scoop_div = box(
            "Ice drawer front scoop partition",
            (front_center_x_local, 0.1050, tub_z_floor + 0.0420),
            (tub_width - 0.0240, 0.0050, 0.0720),
            mat["slide_tray_clear"],
            drawer,
            0.0,
        )
        clean_mesh_object(scoop_div, sharp_z=True)
        scoop = box(
            "Ice drawer sanitary scoop",
            (front_center_x_local + 0.0150, 0.0720, tub_z_floor + 0.0180),
            (0.0920, 0.0420, 0.0200),
            mat["liner_white"],
            drawer,
            0.002,
        )
        clean_mesh_object(scoop, sharp_z=False)
        for i_idx, (ix, iy, rz) in enumerate(
            (
                (-0.048, 0.140, 0.22),
                (0.008, 0.155, -0.31),
                (0.050, 0.135, 0.16),
                (-0.024, 0.195, -0.18),
                (0.036, 0.215, 0.28),
                (-0.054, 0.240, 0.42),
                (0.006, 0.250, -0.12),
                (0.052, 0.268, 0.34),
                (-0.018, 0.285, -0.25),
            ),
            1,
        ):
            icube = box(
                f"hws_auto_ice_cube_{i_idx:02d}",
                (front_center_x_local + ix, iy, tub_z_floor + 0.0210),
                (0.0260, 0.0260, 0.0250),
                mat["ice_crystal"],
                drawer,
                0.0025,
            )
            icube.rotation_euler.z = rz
            clean_mesh_object(icube, sharp_z=False)
    elif special_kind == "delicious_freezing":
        alu_tray = box(
            "Delicious Freezing anodized aluminum tray",
            (front_center_x_local, tub_y_center - 0.0150, tub_z_floor + 0.0140),
            (tub_width - 0.0320, tub_depth - 0.0400, 0.0060),
            mat["delicious_alu"],
            drawer,
            0.001,
        )
        clean_mesh_object(alu_tray, sharp_z=True)
        for r_idx in range(5):
            rx = front_center_x_local - 0.0720 + r_idx * 0.0360
            rib = box(
                f"Delicious Freezing tray rib {r_idx:02d}",
                (rx, tub_y_center - 0.0150, tub_z_floor + 0.0180),
                (0.0060, tub_depth - 0.0640, 0.0025),
                mat["trim_platinum"],
                drawer,
                0.0005,
            )
            clean_mesh_object(rib, sharp_z=True)
    elif special_kind == "lower_freezer":
        # Hollow translucent 3-tier freezer cases (`薄物ケース` top tray + aluminum plate + `小物ケース` mid tray)
        open_top_bin(
            "Lower freezer 3-tier upper slide tray",
            (front_center_x_local, tub_y_center - 0.0550, tub_z_floor + tub_height - 0.0240),
            (tub_width - 0.0280, tub_depth * 0.50, 0.0380),
            wall_t=0.0040,
            floor_t=0.0045,
            surface=mat["slide_tray_clear"],
            parent=drawer,
            sharp=True,
        )
        upper_alu = box(
            "Lower freezer quick-freeze aluminum plate",
            (front_center_x_local - 0.1100, tub_y_center - 0.0550, tub_z_floor + tub_height - 0.0365),
            (0.2100, tub_depth * 0.44, 0.0040),
            mat["delicious_alu"],
            drawer,
            0.0005,
        )
        clean_mesh_object(upper_alu, sharp_z=True)
        open_top_bin(
            "Lower freezer 3-tier middle slide case",
            (front_center_x_local, tub_y_center + 0.0100, tub_z_floor + tub_height * 0.52),
            (tub_width - 0.0280, tub_depth * 0.62, 0.0560),
            wall_t=0.0045,
            floor_t=0.0050,
            surface=mat["drawer_tub"],
            parent=drawer,
            sharp=True,
        )
    elif special_kind == "vegetable":
        # Translucent `プラチナ触媒` cover + hollow translucent `上段ケース` + front `たて収納スペース` bottle partition
        ru_lid = box(
            "Freshness Sleep Ru platinum-catalyst moisture cover",
            (front_center_x_local, tub_y_center - 0.0250, tub_z_floor + tub_height - 0.0100),
            (tub_width - 0.0280, tub_depth * 0.64, 0.0065),
            mat["platinum_cat"],
            drawer,
            0.0,
        )
        clean_mesh_object(ru_lid, sharp_z=True)
        open_top_bin(
            "Vegetable drawer upper slide tray",
            (front_center_x_local, tub_y_center + 0.0220, tub_z_floor + tub_height - 0.0480),
            (tub_width - 0.0300, tub_depth * 0.56, 0.0520),
            wall_t=0.0040,
            floor_t=0.0045,
            surface=mat["slide_tray_clear"],
            parent=drawer,
            sharp=True,
        )
        bottle_part = box(
            "Vegetable drawer front tall-bottle partition",
            (front_center_x_local, 0.1450, tub_z_floor + 0.0880),
            (tub_width - 0.0280, 0.0080, 0.1550),
            mat["drawer_tub"],
            drawer,
            0.0015,
        )
        clean_mesh_object(bottle_part, sharp_z=False)

    return drawer, front_plate


def build_chilled_milk_carton(root, mat):
    # Chilled patisserie Hokkaido fresh cream/milk carton (`hws_milk_carton`, `0.650 kg` 6-DOF freejoint)
    # Rest pose (-0.0850, -0.0350, 1.2400) -> flat bottom at local Z = -0.1000 m -> world Z = 1.1400 m on Shelf 1!
    carton = empty("hws_milk_carton", MILK_CARTON_REST_POSE, root)
    carton["accessory_role"] = "Chilled patisserie Hokkaido fresh cream/milk carton (0.650 kg)"
    carton["stowed_location_m"] = list(MILK_CARTON_REST_POSE)

    body = box(
        "hws_milk_carton_body",
        (0.0, 0.0, -0.0200),
        (0.0720, 0.0720, 0.1600),
        mat["carton_white"],
        carton,
        0.0,
    )
    clean_mesh_object(body, sharp_z=True)

    band = box(
        "hws_milk_carton_label_band",
        (0.0, 0.0, -0.0150),
        (0.0728, 0.0728, 0.1120),
        mat["carton_blue"],
        carton,
        0.0,
    )
    clean_mesh_object(band, sharp_z=True)

    gable = box(
        "hws_milk_carton_gable_shoulder",
        (0.0, 0.0, 0.0740),
        (0.0680, 0.0520, 0.0280),
        mat["carton_white"],
        carton,
        0.003,
    )
    clean_mesh_object(gable, sharp_z=False)

    cap = cylinder(
        "hws_milk_carton_screw_cap",
        (0.0, -0.0100, 0.0940),
        0.0145,
        0.0120,
        mat["carton_cap"],
        carton,
    )
    clean_mesh_object(cap, sharp_z=True)

    socket = empty("vessel_socket", (0.0, 0.0, 0.0100), carton)
    socket["site_role"] = "Chilled milk/cream carton grasp socket"
    return carton


def animate_timeline(door, ice_drw, up_frz, low_frz, veg_drw, carton):
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0),
        (20, 0.0, 0.0, 0.0, 0.0, 0.0),
        (55, math.radians(108.0), -0.260, -0.200, -0.320, -0.240),
        (85, math.radians(108.0), -0.260, -0.200, -0.320, -0.240),
        (120, 0.0, 0.0, 0.0, 0.0, 0.0),
    )
    for fno, door_rad, ice_dy, ufz_dy, lfz_dy, veg_dy in keyframes:
        door.rotation_euler = (0.0, 0.0, -door_rad)
        door.keyframe_insert(data_path="rotation_euler", frame=fno)

        ice_drw.location = (
            ICE_DRAWER_ORIGIN[0],
            ICE_DRAWER_ORIGIN[1] + ice_dy,
            ICE_DRAWER_ORIGIN[2],
        )
        ice_drw.keyframe_insert(data_path="location", frame=fno)

        up_frz.location = (
            UPPER_FREEZER_ORIGIN[0],
            UPPER_FREEZER_ORIGIN[1] + ufz_dy,
            UPPER_FREEZER_ORIGIN[2],
        )
        up_frz.keyframe_insert(data_path="location", frame=fno)

        low_frz.location = (
            LOWER_FREEZER_ORIGIN[0],
            LOWER_FREEZER_ORIGIN[1] + lfz_dy,
            LOWER_FREEZER_ORIGIN[2],
        )
        low_frz.keyframe_insert(data_path="location", frame=fno)

        veg_drw.location = (
            VEG_DRAWER_ORIGIN[0],
            VEG_DRAWER_ORIGIN[1] + veg_dy,
            VEG_DRAWER_ORIGIN[2],
        )
        veg_drw.keyframe_insert(data_path="location", frame=fno)

        carton.location = MILK_CARTON_REST_POSE
        carton.rotation_euler = (0.0, 0.0, 0.0)
        carton.keyframe_insert(data_path="location", frame=fno)
        carton.keyframe_insert(data_path="rotation_euler", frame=fno)


def clear_all_animation(root):
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()


def reset_rest_poses(door, ice_drw, up_frz, low_frz, veg_drw, carton):
    door.location = FRIDGE_DOOR_PIVOT
    door.rotation_euler = (0.0, 0.0, 0.0)
    ice_drw.location = ICE_DRAWER_ORIGIN
    ice_drw.rotation_euler = (0.0, 0.0, 0.0)
    up_frz.location = UPPER_FREEZER_ORIGIN
    up_frz.rotation_euler = (0.0, 0.0, 0.0)
    low_frz.location = LOWER_FREEZER_ORIGIN
    low_frz.rotation_euler = (0.0, 0.0, 0.0)
    veg_drw.location = VEG_DRAWER_ORIGIN
    veg_drw.rotation_euler = (0.0, 0.0, 0.0)
    carton.location = MILK_CARTON_REST_POSE
    carton.rotation_euler = (0.0, 0.0, 0.0)


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def colored_area_light(name, position, target, energy, size, color, shape="RECTANGLE", size_y=None):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = shape
    data.size = size
    if shape == "RECTANGLE" and size_y is not None:
        data.size_y = size_y
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj, target)
    return obj


def colored_point_light(name, position, energy, radius, color):
    data = bpy.data.lights.new(name, "POINT")
    data.energy = energy
    data.shadow_soft_size = radius
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    return obj


def setup_studio(scene):
    before = set(scene.objects)
    enable_metal_gpu(scene)
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.transparent_max_bounces = 12
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("R-HWS47XL studio world")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.46,
        0.49,
        0.54,
        1.0,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.30
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.28

    ground = material("Studio dark slate", (0.21, 0.22, 0.24, 1.0), 0.0, 0.84, 0.0)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.001))
    bpy.context.object.name = "Studio ground"
    bpy.context.object.data.materials.append(ground)

    # Asymmetric studio softboxes sculpted to showcase warm Crystal Champagne satin gradients
    # and crisp recessed drawer pull shadows without washing out to white.
    colored_area_light(
        "Upper left key softbox",
        (-2.25, -2.85, 2.85),
        (-0.08, -0.35, 1.18),
        255.0,
        2.2,
        (1.0, 0.97, 0.92),
        size_y=2.8,
    )
    colored_area_light(
        "Right side satin stripbox",
        (2.65, -1.35, 1.55),
        (0.15, -0.25, 0.90),
        145.0,
        1.1,
        (0.96, 0.97, 1.0),
        size_y=2.6,
    )
    area_light("Rear crown rim softbox", (-0.30, 2.35, 2.90), (0.0, 0.0, 1.15), 210.0, 1.9)

    # Warm interior cavity studio lights (balanced so translucent glass, milk carton & jamb UI stay crisp!)
    open_only_lights = [
        colored_area_light(
            "Fridge ceiling warm LED fill",
            (0.0, -0.04, 1.775),
            (0.0, 0.06, 1.10),
            2.6,
            0.34,
            (1.0, 0.90, 0.74),
            size_y=0.22,
        ),
        colored_point_light(
            "Marugoto Chilled mid cavity glow",
            (0.02, -0.08, 1.38),
            1.4,
            0.16,
            (1.0, 0.92, 0.78),
        ),
        colored_point_light(
            "Tokusen Hyo-on & tank lower glow",
            (-0.02, -0.08, 1.06),
            1.6,
            0.14,
            (1.0, 0.94, 0.84),
        ),
        colored_area_light(
            "Open door pocket & jamb fill",
            (0.35, -1.55, 1.42),
            (-0.18, -0.26, 1.25),
            9.5,
            0.95,
            (1.0, 0.96, 0.90),
            size_y=1.10,
        ),
        colored_area_light(
            "Extended lower drawers top fill",
            (0.10, -1.25, 1.15),
            (-0.04, -0.48, 0.52),
            22.0,
            0.85,
            (0.98, 0.98, 1.0),
            size_y=0.65,
        ),
    ]

    data = bpy.data.cameras.new("Review camera")
    camera = bpy.data.objects.new("Review camera", data)
    scene.collection.objects.link(camera)
    data.type = "ORTHO"
    data.lens = 50
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(collection)
    move_objects(set(scene.objects) - before, collection)
    return camera, open_only_lights


def set_camera(camera, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)


def export_glb_at_rest(root, door, ice_drw, up_frz, low_frz, veg_drw, carton):
    bpy.context.scene.frame_set(1)
    clear_all_animation(root)
    reset_rest_poses(door, ice_drw, up_frz, low_frz, veg_drw, carton)
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )

    # Export standalone chilled patisserie milk/cream carton GLB centered at origin
    saved_parent = carton.parent
    saved_loc = carton.location.copy()
    saved_rot = tuple(carton.rotation_euler)
    carton.animation_data_clear()
    carton.parent = None
    carton.location = (0.0, 0.0, 0.0)
    carton.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    carton.select_set(True)
    for obj in carton.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-milk-carton.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    carton.parent = saved_parent
    carton.location = saved_loc
    carton.rotation_euler = saved_rot
    bpy.context.view_layer.update()


def compute_bounds(objects):
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            wv = mw @ v.co
            mins.x = min(mins.x, wv.x)
            mins.y = min(mins.y, wv.y)
            mins.z = min(mins.z, wv.z)
            maxs.x = max(maxs.x, wv.x)
            maxs.y = max(maxs.y, wv.y)
            maxs.z = max(maxs.z, wv.z)
    return mins, maxs, maxs - mins


def record_build_report(scene, root, renders):
    scene.frame_set(1)
    bpy.context.view_layer.update()
    utilities = bpy.data.objects["hws_utilities"]
    excluded = {utilities, *utilities.children_recursive}
    low, high, dims = compute_bounds(
        [obj for obj in root.children_recursive if obj not in excluded]
    )
    glb_path = ASSETS / f"{NAME}.glb"
    carton_glb_path = ASSETS / f"{NAME}-milk-carton.glb"
    report = {
        "asset": NAME,
        "blender_version": bpy.app.version_string,
        "specification_source": "docs/equipment/hitachi-r-hws47xl/README.md",
        "source_sha256": hashlib.sha256(DOC_README.read_bytes()).hexdigest(),
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(v, 6) for v in dims],
        "envelope_bounds_m": {
            "min": [round(v, 6) for v in low],
            "max": [round(v, 6) for v in high],
        },
        "published_unit_mass_kg": 93.0,
        "chilled_load_mass_kg": 0.65,
        "rated_total_volume_l": 470,
        "compartment_volumes_l": {
            "upper_refrigerator": 243,
            "marugoto_chilled_zone": 118,
            "tokusen_hyoon_zone": 13,
            "mid_left_ice_drawer": 22,
            "mid_right_upper_freezer": 23,
            "lower_main_freezer": 95,
            "bottom_vegetable_drawer": 87,
        },
        "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, compressor 95 W, defrost heater 155 W, 269 kWh/year, R600a",
        "renders": renders,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "milk_carton_glb_sha256": hashlib.sha256(carton_glb_path.read_bytes()).hexdigest(),
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def run_glb_inspection():
    """Import exported GLB in a clean factory scene and verify envelope, left-hinge swing, drawer slides, ray-casts, and mesh quality."""
    from inspect_induction import bounds, near
    from inspect_mesh_quality import inspect_loaded

    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = ASSETS / f"{NAME}.glb"
    carton_path = ASSETS / f"{NAME}-milk-carton.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["hws_cabinet"]
    door = objects["hws_fridge_door"]
    ice_drw = objects["hws_ice_drawer"]
    up_frz = objects["hws_upper_freezer"]
    low_frz = objects["hws_lower_freezer"]
    veg_drw = objects["hws_veg_drawer"]
    carton = objects["hws_milk_carton"]
    socket = objects["vessel_socket"]
    utilities = objects["hws_utilities"]
    top_canopy = objects["Top hinge and inverter cover"]
    shelf1 = objects["Marugoto Chilled glass shelf 1"]

    for child in (door, ice_drw, up_frz, low_frz, veg_drw, carton, utilities):
        assert child.parent == root, child.name
    assert socket.parent == carton
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    assert not any(obj.animation_data is not None for obj in objects)

    excluded = {utilities, *utilities.children_recursive}

    def check_env():
        low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
        dims = high - low
        for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
            near(actual, expected, "Published R-HWS47XL envelope")
        return low, high, dims

    low, high, dimensions = check_env()
    near(low.z, 0.0, "Foot support plane Z=0.000")
    near(high.z, HEIGHT, "Top canopy plane Z=1.833")

    # Fault-injection guard: shifting top canopy upward by 10 mm must trip height check
    orig_z = top_canopy.location.z
    top_canopy.location.z += 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        check_env()
    except AssertionError:
        fault_detected = True
    top_canopy.location.z = orig_z
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard must reject 10 mm height perturbation"

    # Verify all 4 feet touch Z = 0.000 m
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("hws_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot contact plane ({obj.name})")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Closed door blocks horizontal access ray into Marugoto Chilled shelf at Z = 1.250 m
    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit_closed, _pt, _n, _f, obj_closed, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.08, -1.10, 1.25)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_closed and obj_closed in set(door.children_recursive), obj_closed

    # Open LEFT-HINGED door by 90 deg CCW from top view (around axis 0 0 -1 -> rotation_euler.z = -pi/2)
    door.rotation_mode = "XYZ"
    door.rotation_euler = (0.0, 0.0, -math.pi / 2.0)
    bpy.context.view_layer.update()
    door_low, _door_high = bounds(door.children_recursive)
    open_projection_m = -0.3505 - door_low.y
    assert 0.56 <= open_projection_m <= 0.61, open_projection_m

    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit_open, pt_open, _n, _f, obj_open, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.12, -1.10, 1.25)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_open and pt_open.y > 0.25, (
        hit_open,
        pt_open,
        obj_open.name if obj_open else None,
    )

    # Verify downward ray onto Marugoto Chilled glass shelf 1 hits Z = 1.140 m
    hit_sh, pt_sh, norm_sh, _f, obj_sh, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.12, 0.02, 1.28)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_sh and obj_sh == shelf1, obj_sh
    near(pt_sh.z, 1.140, "Marugoto Chilled shelf 1 top Z=1.140")
    assert norm_sh.z > 0.99, norm_sh

    door.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    required_meshes = {
        "Cabinet VIP left side wall",
        "Cabinet VIP right side wall",
        "Top hinge and inverter cover",
        "Marugoto Chilled glass shelf 1",
        "Marugoto Chilled glass shelf 2",
        "Marugoto Chilled glass shelf 3",
        "Tokusen Hyo-on minus-1C preservation case",
        "Auto-ice 1.1L potable water supply tank",
        "Refrigerator 14-egg and accessory case",
        "Fridge door Crystal Champagne front fascia",
        "Interior jamb touch control panel",
        "Fridge door magnetic perimeter gasket",
        "hws_ice_drawer_front_fascia",
        "hws_upper_freezer_front_fascia",
        "Delicious Freezing anodized aluminum tray",
        "hws_lower_freezer_front_fascia",
        "hws_veg_drawer_front_fascia",
        "Freshness Sleep Ru platinum-catalyst moisture cover",
        "hws_milk_carton_body",
        "hws_milk_carton_screw_cap",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "milk_carton_glb_sha256": hashlib.sha256(carton_path.read_bytes()).hexdigest(),
        "milk_carton_glb_bytes": carton_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "body_bounds_m": {
            "min": [round(val, 6) for val in low],
            "max": [round(val, 6) for val in high],
        },
        "left_hinge_90deg_projection_m": round(open_projection_m, 4),
        "marugoto_shelf_1_z_m": round(pt_sh.z, 4),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import rest-pose GLB; verify exact 600x701x1833 mm envelope, Z=0.000 m foot plane, and Z=1.833 m "
            "top canopy; verify 10 mm height perturbation rejection; swing left-hinged refrigerator door 90 deg "
            "CCW around -Z to verify forward -Y projection on -X side and clear interior access to rear liner "
            "and Z=1.140 m Marugoto Chilled shelf; verify interior jamb touch control panel and zero mesh-quality errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    if args.inspect_only:
        run_glb_inspection()
        return

    ASSETS.mkdir(parents=True, exist_ok=True)
    albedo_png, orm_png = ensure_champagne_hairline_pngs()
    touch_png, badge_png, carton_png = bake_japanese_ui_textures()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Hitachi R-HWS47XL - 470L 5-door left-hinged refrigerator"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for marker_name, frame_no in (
        ("Closed", 1),
        ("Open 5 compartments", 55),
        ("Inspect Marugoto Chilled", 85),
        ("Closed again", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=frame_no)

    root = empty("hws_cabinet", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Hitachi Global Life Solutions"
    root["model"] = "R-HWS47XL"
    root["hinge_orientation"] = "Left-hinged (XL / 左開き)"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["manufacturer_unit_mass_kg"] = 93.0
    root["rated_volume_l"] = 470

    mat = surfaces(albedo_png, orm_png, touch_png, badge_png, carton_png)
    build_cabinet_and_interior(root, mat)
    door, door_fascia = build_left_hinged_fridge_door(root, mat)

    # Mid-left automatic ice drawer (`22 L`, `X in [-0.2996, -0.0220]`, `Z in [0.6750, 0.8900]`)
    ice_drw, ice_fascia = build_pull_drawer(
        root,
        mat,
        "hws_ice_drawer",
        ICE_DRAWER_ORIGIN,
        0.360,
        -0.0008,
        0.2776,
        0.2120,
        0.2280,
        0.3800,
        0.1550,
        special_kind="ice",
    )

    # Mid-right upper Delicious Freezing drawer (`23 L`, `X in [-0.0180, +0.2996]`, `Z in [0.6750, 0.8900]`)
    up_frz, up_frz_fascia = build_pull_drawer(
        root,
        mat,
        "hws_upper_freezer",
        UPPER_FREEZER_ORIGIN,
        0.360,
        0.0008,
        0.3176,
        0.2120,
        0.2640,
        0.3800,
        0.1550,
        special_kind="delicious_freezing",
    )

    # Lower main 3-tier freezer drawer (`95 L`, `X in [-0.2996, +0.2996]`, `Z in [0.3450, 0.6700]`)
    low_frz, low_frz_fascia = build_pull_drawer(
        root,
        mat,
        "hws_lower_freezer",
        LOWER_FREEZER_ORIGIN,
        0.420,
        0.0,
        0.5992,
        0.3220,
        0.5060,
        0.4700,
        0.2550,
        special_kind="lower_freezer",
    )

    # Bottom Freshness Sleep vegetable drawer (`87 L`, `X in [-0.2996, +0.2996]`, `Z in [0.0220, 0.3400]`)
    veg_drw, veg_fascia = build_pull_drawer(
        root,
        mat,
        "hws_veg_drawer",
        VEG_DRAWER_ORIGIN,
        0.420,
        0.0,
        0.5992,
        0.3120,
        0.5060,
        0.4700,
        0.2500,
        special_kind="vegetable",
    )

    carton = build_chilled_milk_carton(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    all_empties = [
        obj for obj in (root, *root.children_recursive) if obj.type == "EMPTY"
    ]
    convert_curves(all_empties)
    sharp_prefixes = (
        "Cabinet VIP ",
        "Cabinet top ",
        "Top hinge and inverter cover",
        "Marugoto Chilled glass shelf ",
        "Refrigerator lower fixed partition shelf",
        "Fridge door Crystal Champagne front fascia",
        "Fridge door perimeter chamfer trim",
        "Fridge door clear bottle pocket ",
        "Interior jamb touch control panel",
        "Marugoto Chilled emblem plate",
        "Tokusen Hyo-on minus-1C preservation case",
        "Tokusen Hyo-on front smoked window",
        "Auto-ice 1.1L potable water supply tank",
        "Auto-ice tank internal water level",
        "Refrigerator 14-egg and accessory case",
        "Lower freezer 3-tier ",
        "Vegetable drawer upper slide tray",
    )
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            is_sharp = (
                any(obj.name.startswith(p) for p in sharp_prefixes)
                or obj.name.endswith("_front_fascia")
                or obj.name.endswith("_perimeter_bevel")
                or obj.name.endswith("_top_handle_trim")
                or obj.name.endswith("_top_pull_groove")
                or obj.name.endswith("_pad")
                or obj.name in {"hws_milk_carton_body", "hws_milk_carton_label_band"}
            )
            clean_mesh_object(obj, sharp_z=is_sharp)

    # Apply uniform physical-scale horizontal hairline UVs across all 5 front steel fascias
    for fascia_obj in (door_fascia, ice_fascia, up_frz_fascia, low_frz_fascia, veg_fascia):
        apply_planar_uv_y(fascia_obj, physical_scale=(0.600, 0.450))

    apply_planar_uv_y(bpy.data.objects["Interior jamb touch control panel"])
    apply_planar_uv_y(bpy.data.objects["Marugoto Chilled emblem plate"])
    apply_box_perimeter_uv(bpy.data.objects["hws_milk_carton_label_band"])

    # Export static rest-pose GLBs at frame 1 with animation_data_clear() and export_animations=False
    export_glb_at_rest(root, door, ice_drw, up_frz, low_frz, veg_drw, carton)

    # Restore preview timeline animation and render 5 Metal GPU studio PNGs
    animate_timeline(door, ice_drw, up_frz, low_frz, veg_drw, carton)

    appliance = bpy.data.collections.new("R-HWS47XL appliance")
    scene.collection.children.link(appliance)
    move_objects([root, *root.children_recursive], appliance)

    camera, open_only_lights = setup_studio(scene)
    views = (
        ("studio-closed", (2.35, -3.65, 1.95), (0.0, 0.0, 0.916), 2.52, 1),
        ("studio-open", (2.45, -3.80, 2.02), (-0.08, -0.14, 0.920), 2.68, 70),
        ("studio-front", (0.0, -3.80, 0.916), (0.0, 0.0, 0.916), 2.52, 1),
        ("studio-interior", (0.26, -3.20, 1.36), (-0.05, -0.02, 1.335), 1.18, 70),
        ("studio-right", (3.80, 0.0, 0.916), (0.0, 0.0, 0.916), 2.52, 1),
    )
    rendered = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            is_open_view = fno > 1
            for lgt in open_only_lights:
                lgt.hide_render = not is_open_view
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = f"{vname}.png"
            scene.render.filepath = str(ASSETS / out_png)
            bpy.ops.render.render(write_still=True)
            rendered.append(out_png)

    for lgt in open_only_lights:
        lgt.hide_render = False
    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])
    record_build_report(scene, root, rendered)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))
    print("Saved editable Hitachi R-HWS47XL Blender source, GLBs and renders:", ASSETS)

    subprocess.run(
        [
            str(bpy.app.binary_path),
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--inspect-only",
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
