"""Build the WPM KD-330X 1-Group Commercial Espresso Machine (Japan 200V SKU) in Blender 5.2.

Reference ground truth:
- docs/equipment/wpm-kd-330x/specifications/instruction-manual-2023.pdf (cover CAD, p. 3 parts 1-14,
  p. 4 panel buttons & round LCD modes, p. 5 2.5 L top-load tank, pp. 6-8 steam/hot-water/brew operation,
  pp. 9-11 PID/steam/pressure settings)
- Official WPM KD-330X studio photography (320 W x 460 D x 480 H mm, 22.8 kg)

Metres, Z up, operator front towards -Y, Z = 0.000 m at bottom of the four adjustable feet.
Exact machine envelope (excluding detachable 58 mm portafilter):
  X in [-0.1600, +0.1600] m (320.0 mm)
  Y in [-0.2300, +0.2300] m (460.0 mm)
  Z in [ 0.0000, +0.4800] m (480.0 mm)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    empty,
    finish,
    look_at,
    material,
)
from inspect_induction import bounds, near
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
NAME = "wpm-kd-330x"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
REFERENCES = ROOT / "docs/equipment" / NAME

WIDTH = 0.3200
DEPTH = 0.4600
HEIGHT = 0.4800

FRONT_PANEL_Y = -0.1050
GROUP_X = 0.0000
GROUP_Y = -0.1600

# Authentic WPM KD-330X articulated joint origins (manual p. 3 callouts 1-14):
# - #5 Steam wand on LEFT below #4 Steam control knob
# - #10 E61-style Manual control brew lever on RIGHT side of #9/#11 Group head
# - #1 Top-rear 2.5 L water tank cover panel
# - #6 Pull-out stainless drip tray with wire cup grate & WPM WELHOME PRO badge
# - #13 Lower-right round 0-16 bar pressure gauge pointer
STEAM_WAND_ORIGIN = (-0.1040, -0.1280, 0.2980)
STEAM_LEVER_ORIGIN = (0.0610, -0.1520, 0.2820)
TANK_LID_ORIGIN = (0.0000, 0.2080, 0.4500)
DRIP_TRAY_ORIGIN = (0.0000, -0.1440, 0.0840)
GAUGE_ORIGIN = (0.0420, -0.1084, 0.1680)
LCD_CENTER = (-0.0520, FRONT_PANEL_Y, 0.3450)
PF_REST_POSE = (GROUP_X, GROUP_Y, 0.2440)

FOOT_POSITIONS = (
    ("kd330_foot_front_left", -0.1060, -0.1680),
    ("kd330_foot_front_right", 0.1060, -0.1680),
    ("kd330_foot_rear_left", -0.1140, 0.1780),
    ("kd330_foot_rear_right", 0.1140, 0.1780),
)


# 5x7 bitmap font for procedural gauge & round-LCD textures
FONT_5X7: dict[str, tuple[str, ...]] = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00110", "01000", "10000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11100", "10010", "10001", "10001", "10001", "10010", "11100"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
}


def write_rgba_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 4
    for row in range(height):
        raw.append(0)
        raw.extend(pixels[row * stride : (row + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def draw_pixel_rect(
    buf: bytearray, size_w: int, size_h: int, x0: int, y0: int, x1: int, y1: int, rgba: tuple[int, int, int, int]
) -> None:
    c = bytes(rgba)
    for y in range(max(0, y0), min(size_h, y1)):
        row_off = y * size_w * 4
        for x in range(max(0, x0), min(size_w, x1)):
            idx = row_off + x * 4
            buf[idx : idx + 4] = c


def draw_bitmap_text(
    buf: bytearray,
    size_w: int,
    size_h: int,
    text: str,
    cx: int,
    cy: int,
    scale: int,
    rgba: tuple[int, int, int, int],
    spacing: int = 1,
) -> None:
    glyph_w = 5 * scale
    glyph_h = 7 * scale
    step = (5 + spacing) * scale
    total_w = len(text) * step - spacing * scale
    x_start = cx - total_w // 2
    y_start = cy - glyph_h // 2
    for ch_i, ch in enumerate(text):
        rows = FONT_5X7.get(ch.upper())
        if rows is None:
            continue
        gx = x_start + ch_i * step
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit == "1":
                    draw_pixel_rect(
                        buf,
                        size_w,
                        size_h,
                        gx + rx * scale,
                        y_start + ry * scale,
                        gx + (rx + 1) * scale,
                        y_start + (ry + 1) * scale,
                        rgba,
                    )


def generate_gauge_texture(path: Path) -> bpy.types.Image:
    """Authentic black-dial WPM 0-16 bar commercial pressure gauge (kd330_WH.jpg #13)."""
    size = 768
    cx = cy = size // 2
    buf = bytearray(size * size * 4)

    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = cy - y
            r = math.hypot(dx, dy)
            idx = (y * size + x) * 4
            if r > 372:
                buf[idx : idx + 4] = bytes((18, 20, 24, 255))
            elif r > 348:
                buf[idx : idx + 4] = bytes((165, 172, 180, 255))
            else:
                shade = max(16, int(30 - 0.025 * r))
                buf[idx : idx + 4] = bytes((shade, shade + 2, shade + 5, 255))

    # Zero bar = -125 deg from +Y_img (top), sweeping clockwise +217.7 deg (3.80 rad) across 0..16 bar
    start_deg = -125.0
    sweep_deg = math.degrees(3.80)
    for step in range(960):
        bar = 16.0 * step / 959.0
        ang = math.radians(start_deg + sweep_deg * (bar / 16.0))
        sx = math.sin(ang)
        sy = math.cos(ang)
        if 8.0 <= bar <= 12.0:
            col = (46, 188, 104, 255)
            r_lo, r_hi = 276, 300
        elif bar > 12.0:
            col = (224, 52, 46, 255)
            r_lo, r_hi = 276, 300
        else:
            col = (196, 204, 214, 255)
            r_lo, r_hi = 290, 300
        for rr in range(r_lo, r_hi):
            px = int(round(cx + rr * sx))
            py = int(round(cy - rr * sy))
            if 0 <= px < size and 0 <= py < size:
                idx = (py * size + px) * 4
                buf[idx : idx + 4] = bytes(col)

    # Major ticks every 2 bar (0..16) and minor ticks every 0.5 bar
    for half_bar in range(33):
        bar_v = half_bar * 0.5
        ang = math.radians(start_deg + sweep_deg * (bar_v / 16.0))
        sx = math.sin(ang)
        sy = math.cos(ang)
        is_major = (half_bar % 4) == 0
        is_mid = (half_bar % 2) == 0
        r_in = 248 if is_major else (264 if is_mid else 276)
        thick = 3 if is_major else 1
        col = (242, 245, 250, 255) if bar_v <= 12.0 else (238, 72, 66, 255)
        for rr in range(r_in, 298):
            px = int(round(cx + rr * sx))
            py = int(round(cy - rr * sy))
            draw_pixel_rect(buf, size, size, px - thick, py - thick, px + thick + 1, py + thick + 1, col)

        if is_major:
            label = str(int(bar_v))
            tx = int(round(cx + 210 * sx))
            ty = int(round(cy - 210 * sy))
            draw_bitmap_text(buf, size, size, label, tx, ty, scale=4, rgba=(238, 242, 248, 255))

    # "WPM" above center spindle and "BAR" below center spindle
    draw_bitmap_text(buf, size, size, "WPM", cx, cy - 86, scale=6, rgba=(244, 246, 250, 255), spacing=2)
    draw_bitmap_text(buf, size, size, "BAR", cx, cy + 108, scale=4, rgba=(198, 206, 216, 255), spacing=2)

    # Two tiny dial mounting screws flanking bottom
    for sx_off in (-44, 44):
        for yy in range(cy + 146 - 7, cy + 146 + 8):
            for xx in range(cx + sx_off - 7, cx + sx_off + 8):
                if math.hypot(xx - (cx + sx_off), yy - (cy + 146)) <= 7.0:
                    idx = (yy * size + xx) * 4
                    buf[idx : idx + 4] = bytes((172, 178, 186, 255))

    write_rgba_png(path, size, size, bytes(buf))
    img = bpy.data.images.load(str(path))
    img.pack()
    return img


def generate_kd330_lcd_texture(path: Path) -> bpy.types.Image:
    """Authentic round segmented LCD display (manual pp. 4, 9, 11: CO / CLOCK / 27s / P5)."""
    size = 768
    cx = cy = size // 2
    buf = bytearray(size * size * 4)

    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = cy - y
            r = math.hypot(dx, dy)
            idx = (y * size + x) * 4
            if r > 362:
                buf[idx : idx + 4] = bytes((14, 16, 20, 255))
            elif r > 338:
                buf[idx : idx + 4] = bytes((52, 62, 76, 255))
            elif r > 328:
                buf[idx : idx + 4] = bytes((132, 182, 218, 255))
            else:
                # Deep backlit LCD navy-charcoal circle
                shade_b = max(24, int(48 - 0.05 * r))
                buf[idx : idx + 4] = bytes((12, 22, shade_b, 255))

    seg_lit = (218, 246, 255, 255)
    seg_sub = (156, 218, 248, 255)

    def draw_7seg(digit: str, ox: int, oy: int, w: int, h: int, t: int, col=seg_lit) -> None:
        segs = {
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
            "P": "abefg",
            "S": "acdfg",
        }.get(digit, "")
        mh = oy + h // 2
        if "a" in segs:
            draw_pixel_rect(buf, size, size, ox + t, oy, ox + w - t, oy + t, col)
        if "b" in segs:
            draw_pixel_rect(buf, size, size, ox + w - t, oy + t, ox + w, mh - t // 2, col)
        if "c" in segs:
            draw_pixel_rect(buf, size, size, ox + w - t, mh + t // 2, ox + w, oy + h - t, col)
        if "d" in segs:
            draw_pixel_rect(buf, size, size, ox + t, oy + h - t, ox + w - t, oy + h, col)
        if "e" in segs:
            draw_pixel_rect(buf, size, size, ox, mh + t // 2, ox + t, oy + h - t, col)
        if "f" in segs:
            draw_pixel_rect(buf, size, size, ox, oy + t, ox + t, mh - t // 2, col)
        if "g" in segs:
            draw_pixel_rect(buf, size, size, ox + t, mh - t // 2, ox + w - t, mh + (t + 1) // 2, col)

    # Row 1: "CO"
    draw_bitmap_text(buf, size, size, "CO", cx, 168, scale=8, rgba=seg_sub, spacing=2)
    # Row 2: "CLOCK"
    draw_bitmap_text(buf, size, size, "CLOCK", cx, 248, scale=7, rgba=seg_sub, spacing=2)
    # Row 3: Large 7-segment "27" + small "S" (manual p. 11: "05s" / "27s")
    draw_7seg("2", cx - 108, 308, 86, 152, 15, seg_lit)
    draw_7seg("7", cx - 4, 308, 86, 152, 15, seg_lit)
    draw_7seg("S", cx + 102, 376, 46, 84, 10, seg_sub)
    # Row 4: Pressure stage "P5"
    draw_7seg("P", cx - 54, 496, 48, 86, 10, seg_lit)
    draw_7seg("5", cx + 8, 496, 48, 86, 10, seg_lit)

    write_rgba_png(path, size, size, bytes(buf))
    img = bpy.data.images.load(str(path))
    img.pack()
    return img


def textured_material(
    name: str,
    img: bpy.types.Image,
    base_rgba=(0.8, 0.82, 0.84, 1.0),
    metallic=0.04,
    roughness=0.18,
    emission=0.0,
):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = base_rgba
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if emission > 0.0:
        links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission)
    return mat


def surfaces(gauge_img: bpy.types.Image, lcd_img: bpy.types.Image):
    pal = {
        "steel": material("kd330_stainless_brushed", (0.62, 0.64, 0.67, 1.0), 0.90, 0.24),
        "chrome": material("kd330_mirror_chrome", (0.84, 0.86, 0.89, 1.0), 0.97, 0.07),
        "dark_metal": material("kd330_gunmetal_chassis", (0.06, 0.07, 0.09, 1.0), 0.68, 0.38),
        "black_abs": material("kd330_matte_black_polymer", (0.008, 0.009, 0.012, 1.0), 0.03, 0.25),
        "rubber": material("kd330_epdm_elastomer", (0.006, 0.007, 0.009, 1.0), 0.0, 0.52),
        "button_lit": material("kd330_backlit_keycap", (0.86, 0.89, 0.93, 1.0), 0.04, 0.22, emission=0.28),
        "badge_white": material("kd330_badge_silkscreen", (0.92, 0.94, 0.96, 1.0), 0.05, 0.24),
        "tank_blue": material("kd330_reservoir_san_blue", (0.34, 0.60, 0.80, 0.36), 0.0, 0.06),
        "glass_clear": material("kd330_gauge_crystal", (0.92, 0.95, 0.98, 0.10), 0.0, 0.02),
        "red_accent": material("kd330_red_pointer_enamel", (0.82, 0.05, 0.04, 1.0), 0.12, 0.24),
        "ink_dark": material("kd330_badge_ink_dark", (0.05, 0.06, 0.08, 1.0), 0.06, 0.34),
        "gauge_face": textured_material(
            "kd330_pressure_gauge_dial", gauge_img, (0.10, 0.11, 0.13, 1.0), 0.04, 0.22, 0.04
        ),
        "lcd_face": textured_material(
            "kd330_round_lcd_panel", lcd_img, (0.06, 0.14, 0.28, 1.0), 0.02, 0.10, 0.62
        ),
    }
    for key, tr in (("tank_blue", 0.76), ("glass_clear", 0.96)):
        bsdf = pal[key].node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Transmission Weight"].default_value = tr
        bsdf.inputs["IOR"].default_value = 1.49
    for m in pal.values():
        m["metallic"] = float(m.get("metallic", 0.0))
        m["roughness"] = float(m.get("roughness", 0.35))
        m["emission"] = float(m.get("emission", 0.0))
    return pal


def mesh_from_pydata(name, vertices, faces, surface, parent, bevel=0.0):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel)


def lathe_solid(name, profile, center, surface, parent, segments=64, axis="Z"):
    vertices = []
    for r, h in profile:
        for idx in range(segments):
            ang = idx * math.tau / segments
            c, s = math.cos(ang), math.sin(ang)
            if axis == "Z":
                vertices.append((center[0] + r * c, center[1] + r * s, center[2] + h))
            elif axis == "Y":
                vertices.append((center[0] + r * c, center[1] + h, center[2] + r * s))
            elif axis == "X":
                vertices.append((center[0] + h, center[1] + r * c, center[2] + r * s))
    faces = []
    n_rings = len(profile)
    for ring in range(n_rings):
        nxt = (ring + 1) % n_rings
        r0, h0 = profile[ring]
        r1, h1 = profile[nxt]
        if abs(r0 - r1) < 1e-8 and abs(h0 - h1) < 1e-8:
            continue
        for idx in range(segments):
            foll = (idx + 1) % segments
            faces.append(
                (
                    ring * segments + idx,
                    ring * segments + foll,
                    nxt * segments + foll,
                    nxt * segments + idx,
                )
            )
    return mesh_from_pydata(name, vertices, faces, surface, parent, bevel=0.0)


def clean_cylinder(name, position, radius, depth, surface, parent, axis="Z", vertices=48, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=position)
    obj = bpy.context.object
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, surface, parent, bevel)


def stadium_prism(name, center, width, height, depth_y, radius, surface, parent, segs_corner=12):
    """Build a rounded-stadium prism along Y (front/back faces in XZ plane) with crisp capped faces."""
    cx, cy, cz = center
    hx = max(radius + 1e-5, width * 0.5)
    hz = max(radius + 1e-5, height * 0.5)
    r = min(radius, hx - 1e-5, hz - 1e-5)
    hy = depth_y * 0.5

    corners = (
        (hx - r, hz - r, 0.0, math.pi * 0.5),
        (-hx + r, hz - r, math.pi * 0.5, math.pi),
        (-hx + r, -hz + r, math.pi, math.pi * 1.5),
        (hx - r, -hz + r, math.pi * 1.5, math.tau),
    )
    ring_2d = []
    for ox, oz, a0, a1 in corners:
        for i in range(segs_corner):
            ang = a0 + (a1 - a0) * (i / segs_corner)
            ring_2d.append((ox + r * math.cos(ang), oz + r * math.sin(ang)))

    n = len(ring_2d)
    verts = []
    # Front ring (y = cy - hy) and back ring (y = cy + hy)
    for x2, z2 in ring_2d:
        verts.append((cx + x2, cy - hy, cz + z2))
    for x2, z2 in ring_2d:
        verts.append((cx + x2, cy + hy, cz + z2))
    # Center vertices for clean fan triangulation
    verts.append((cx, cy - hy, cz))
    verts.append((cx, cy + hy, cz))
    c_front = 2 * n
    c_back = 2 * n + 1

    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((c_front, j, i))
        faces.append((c_back, n + i, n + j))
        faces.append((i, j, n + j, n + i))
    return mesh_from_pydata(name, verts, faces, surface, parent, bevel=0.0)


def pipe_segments(name, points, radius, surface, parent, bevel_res=5, res_u=14):
    """Build a smooth round tube along 3D polyline points with capped ends."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = bevel_res
    curve.use_fill_caps = True
    curve.resolution_u = res_u
    spline = curve.splines.new("BEZIER" if len(points) >= 3 else "POLY")
    if spline.type == "BEZIER":
        spline.bezier_points.add(len(points) - 1)
        for idx, (bp, co) in enumerate(zip(spline.bezier_points, points)):
            v = Vector(co)
            bp.co = v
            prev_v = Vector(points[max(0, idx - 1)])
            next_v = Vector(points[min(len(points) - 1, idx + 1)])
            tangent = (next_v - prev_v) * 0.22
            bp.handle_left_type = "FREE"
            bp.handle_right_type = "FREE"
            bp.handle_left = v - tangent
            bp.handle_right = v + tangent
    else:
        spline.points.add(len(points) - 1)
        for pt, co in zip(spline.points, points):
            pt.co = (*co, 1.0)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent)


def bent_hoop_rail(name, x_const, y_front, y_rear, z_deck, z_top, radius, surface, parent, plane="YZ"):
    """Smooth inverted-U tubular stainless guard rail with 90-degree bent corners."""
    bend_r = min(0.0160, abs(z_top - z_deck) * 0.65, abs(y_rear - y_front) * 0.25)
    z_center = z_top - radius
    pts = []
    if plane == "YZ":
        pts.append((x_const, y_front, z_deck))
        for i in range(9):
            ang = math.pi - (math.pi * 0.5) * (i / 8.0)
            pts.append(
                (
                    x_const,
                    y_front + bend_r + bend_r * math.cos(ang),
                    (z_center - bend_r) + bend_r * math.sin(ang),
                )
            )
        for i in range(9):
            ang = (math.pi * 0.5) - (math.pi * 0.5) * (i / 8.0)
            pts.append(
                (
                    x_const,
                    y_rear - bend_r + bend_r * math.cos(ang),
                    (z_center - bend_r) + bend_r * math.sin(ang),
                )
            )
        pts.append((x_const, y_rear, z_deck))
    else:
        # XZ plane at y_const = x_const, spanning x in [y_front, y_rear]
        y_c = x_const
        x_lo, x_hi = y_front, y_rear
        pts.append((x_lo, y_c, z_deck))
        for i in range(9):
            ang = math.pi - (math.pi * 0.5) * (i / 8.0)
            pts.append(
                (
                    x_lo + bend_r + bend_r * math.cos(ang),
                    y_c,
                    (z_center - bend_r) + bend_r * math.sin(ang),
                )
            )
        for i in range(9):
            ang = (math.pi * 0.5) - (math.pi * 0.5) * (i / 8.0)
            pts.append(
                (
                    x_hi - bend_r + bend_r * math.cos(ang),
                    y_c,
                    (z_center - bend_r) + bend_r * math.sin(ang),
                )
            )
        pts.append((x_hi, y_c, z_deck))

    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 5
    curve.use_fill_caps = True
    curve.resolution_u = 4
    spline = curve.splines.new("POLY")
    spline.points.add(len(pts) - 1)
    for pt, co in zip(spline.points, pts):
        pt.co = (*co, 1.0)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent)


def build_scalloped_knob(name, center, r_base, lobes, lobe_amp, depth_y, surface, parent):
    """10-lobe scalloped commercial matte-black rotary valve knob (kd330_WH.jpg #4 & #8)."""
    cx, cy, cz = center
    segs = 120
    # Rings along Y (front towards -Y): back collar -> scalloped body -> front chamfer -> dish rim -> recessed dish
    rings = (
        (0.56, +depth_y * 0.50, 0.0),
        (0.56, +depth_y * 0.18, 0.0),
        (0.94, +depth_y * 0.14, 0.85),
        (1.00, +depth_y * 0.04, 1.00),
        (1.00, -depth_y * 0.34, 1.00),
        (0.90, -depth_y * 0.48, 0.70),
        (0.56, -depth_y * 0.50, 0.0),
        (0.50, -depth_y * 0.36, 0.0),
    )
    verts = []
    for r_scale, y_off, fluting in rings:
        for i in range(segs):
            ang = i * math.tau / segs
            rr = r_base * r_scale + (lobe_amp * fluting) * math.cos(lobes * ang)
            verts.append((cx + rr * math.cos(ang), cy + y_off, cz + rr * math.sin(ang)))

    n_r = len(rings)
    c_back = len(verts)
    verts.append((cx, cy + depth_y * 0.50, cz))
    c_front = len(verts)
    verts.append((cx, cy - depth_y * 0.36, cz))

    faces = []
    for ri in range(n_r - 1):
        for i in range(segs):
            j = (i + 1) % segs
            faces.append((ri * segs + i, ri * segs + j, (ri + 1) * segs + j, (ri + 1) * segs + i))
    for i in range(segs):
        j = (i + 1) % segs
        faces.append((c_back, i, j))
        last = (n_r - 1) * segs
        faces.append((c_front, last + j, last + i))

    return mesh_from_pydata(name, verts, faces, surface, parent, bevel=0.0)


def build_pinch_burn_guard(name, center, side_sign, surface, parent):
    """Sculpted triangular winged rubber anti-scald finger grip on steam/hot-water wands."""
    cx, cy, cz = center
    # Sleeve around wand + pinched triangular wing pointing outward-forward
    sleeve = clean_cylinder(
        f"{name}_sleeve",
        (cx, cy, cz),
        0.0076,
        0.0300,
        surface,
        parent,
        vertices=28,
        bevel=0.0015,
    )
    sleeve.rotation_euler.x = math.radians(-10.0)
    bpy.context.view_layer.objects.active = sleeve
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    wing = stadium_prism(
        f"{name}_wing",
        (cx + side_sign * 0.0095, cy - 0.0055, cz + 0.0020),
        0.0200,
        0.0240,
        0.0080,
        0.0065,
        surface,
        parent,
    )
    wing.rotation_euler = (math.radians(-10.0), 0.0, side_sign * math.radians(-28.0))
    bpy.context.view_layer.objects.active = wing
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return sleeve


def text_3d(name, value, position, size, surface, parent, rot=(math.pi / 2, 0.0, 0.0), extrude=0.00035):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = extrude
    curve.resolution_u = 2
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = rot
    return finish(obj, name, surface, parent)


def add_planar_xz_uv(obj):
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    xs = [v.co.x for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    x0, x1 = min(xs), max(xs)
    z0, z1 = min(zs), max(zs)
    dx = max(1e-6, x1 - x0)
    dz = max(1e-6, z1 - z0)
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            uv_layer[li].uv = ((co.x - x0) / dx, (co.z - z0) / dz)


def clean_mesh_object(obj, crease_deg: float = 32.0):
    """Sanitize topology, mark sharp creases (> crease_deg), and attach FACE_AREA WEIGHTED_NORMAL."""
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

    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.normal_update()
        thresh = math.radians(crease_deg)
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            if len(e.link_faces) != 2:
                e.smooth = False
            else:
                n0 = e.link_faces[0].normal
                n1 = e.link_faces[1].normal
                if n0.length < 1e-9 or n1.length < 1e-9:
                    e.smooth = False
                else:
                    e.smooth = n0.angle(n1) <= thresh

    bm.to_mesh(obj.data)
    bm.free()

    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()

    wn = obj.modifiers.new(name="WeightedNormal", type="WEIGHTED_NORMAL")
    wn.mode = "FACE_AREA"
    wn.weight = 50
    wn.keep_sharp = True
    return obj


def build_punched_cup_warmer_deck(name, root, mat):
    """Build solid stainless cup-warmer tray at Z = 0.4500 m with recessed stamped louver slots."""
    deck = box(
        name,
        (0.0, -0.0100, 0.4470),
        (0.2560, 0.1640, 0.0060),
        mat["steel"],
        root,
        0.0006,
    )
    # Recessed dark shadow slots on a stepped inset plate (Z_top = 0.4494 m, 0.6 mm below Z=0.4500 m)
    # Note: center strip around X=0.0, Y=-0.010 is solid stainless so raycast hits Z = 0.4500 m cleanly!
    for col_x in (-0.0840, -0.0300, 0.0300, 0.0840):
        for row_i in range(7):
            sy = -0.0660 + row_i * 0.0185
            box(
                f"kd330_cup_warmer_slot_{col_x:+.3f}_{row_i}",
                (col_x, sy, 0.4496),
                (0.0380, 0.0065, 0.0014),
                mat["dark_metal"],
                root,
                0.0002,
            )
    return deck


def build_control_pods(root, mat):
    """Build the authentic 4-button left pod and 3-button right pod (manual p. 4)."""
    pod_z = 0.4020
    # Left pod: Power, Minus, Program, Plus
    stadium_prism(
        "kd330_left_button_pod",
        (-0.0620, FRONT_PANEL_Y - 0.0012, pod_z),
        0.0880,
        0.0280,
        0.0036,
        0.0110,
        mat["black_abs"],
        root,
    )
    left_xs = (-0.0915, -0.0720, -0.0525, -0.0330)
    left_names = ("power", "minus", "program", "plus")
    for bx, bname in zip(left_xs, left_names):
        stadium_prism(
            f"kd330_btn_cap_{bname}",
            (bx, FRONT_PANEL_Y - 0.0028, pod_z),
            0.0146,
            0.0196,
            0.0020,
            0.0046,
            mat["button_lit"],
            root,
        )

    # Crisp vector icons on each button (+0.6 mm proud of keycap at Y = FRONT_PANEL_Y - 0.0042)
    icon_y = FRONT_PANEL_Y - 0.0042
    # 1. Power icon (ring + vertical bar)
    lathe_solid(
        "kd330_icon_power_ring",
        [(0.0028, -0.0003), (0.0038, -0.0003), (0.0038, 0.0003), (0.0028, 0.0003)],
        (left_xs[0], icon_y, pod_z - 0.0006),
        mat["ink_dark"],
        root,
        segments=28,
        axis="Y",
    )
    box("kd330_icon_power_stem", (left_xs[0], icon_y, pod_z + 0.0024), (0.0011, 0.0007, 0.0044), mat["ink_dark"], root)
    # 2. Minus icon
    box("kd330_icon_minus", (left_xs[1], icon_y, pod_z), (0.0068, 0.0007, 0.0012), mat["ink_dark"], root)
    # 3. Program list icon (3 dots + 3 bars)
    for r_i, rz in enumerate((0.0028, 0.0, -0.0028)):
        box(
            f"kd330_icon_prog_dot_{r_i}",
            (left_xs[2] - 0.0030, icon_y, pod_z + rz),
            (0.0012, 0.0007, 0.0012),
            mat["ink_dark"],
            root,
        )
        box(
            f"kd330_icon_prog_bar_{r_i}",
            (left_xs[2] + 0.0014, icon_y, pod_z + rz),
            (0.0052, 0.0007, 0.0011),
            mat["ink_dark"],
            root,
        )
    # 4. Plus icon
    box("kd330_icon_plus_h", (left_xs[3], icon_y, pod_z), (0.0068, 0.0007, 0.0012), mat["ink_dark"], root)
    box("kd330_icon_plus_v", (left_xs[3], icon_y, pod_z), (0.0012, 0.0007, 0.0068), mat["ink_dark"], root)

    # Right pod: One Cup, Two Cups, Cleaning
    stadium_prism(
        "kd330_right_button_pod",
        (0.0680, FRONT_PANEL_Y - 0.0012, pod_z),
        0.0680,
        0.0280,
        0.0036,
        0.0110,
        mat["black_abs"],
        root,
    )
    right_xs = (0.0485, 0.0680, 0.0875)
    right_names = ("1cup", "2cup", "clean")
    for bx, bname in zip(right_xs, right_names):
        stadium_prism(
            f"kd330_btn_cap_{bname}",
            (bx, FRONT_PANEL_Y - 0.0028, pod_z),
            0.0146,
            0.0196,
            0.0020,
            0.0046,
            mat["button_lit"],
            root,
        )

    # Cup icons (outlined cup + handle + saucer) & clean cycle ring
    for c_idx, bx in enumerate(right_xs[:2]):
        cx_cup = bx - 0.0008
        # Left wall, right wall, rim, and base of espresso cup outline
        box(f"kd330_icon_cup_l_{c_idx}", (cx_cup - 0.0024, icon_y, pod_z + 0.0010), (0.0009, 0.0007, 0.0044), mat["ink_dark"], root)
        box(f"kd330_icon_cup_r_{c_idx}", (cx_cup + 0.0024, icon_y, pod_z + 0.0010), (0.0009, 0.0007, 0.0044), mat["ink_dark"], root)
        box(f"kd330_icon_cup_top_{c_idx}", (cx_cup, icon_y, pod_z + 0.0028), (0.0056, 0.0007, 0.0008), mat["ink_dark"], root)
        box(f"kd330_icon_cup_bot_{c_idx}", (cx_cup, icon_y, pod_z - 0.0008), (0.0048, 0.0007, 0.0009), mat["ink_dark"], root)
        box(f"kd330_icon_cup_ear_{c_idx}", (cx_cup + 0.0036, icon_y, pod_z + 0.0012), (0.0016, 0.0007, 0.0024), mat["ink_dark"], root)
        box(
            f"kd330_icon_cup_saucer_{c_idx}",
            (cx_cup, icon_y, pod_z - 0.0026),
            (0.0074, 0.0007, 0.0009),
            mat["ink_dark"],
            root,
        )
        if c_idx == 1:
            text_3d("kd330_icon_2x", "2x", (bx + 0.0022, icon_y - 0.0002, pod_z - 0.0046), 0.0030, mat["ink_dark"], root)

    lathe_solid(
        "kd330_icon_clean_ring",
        [(0.0030, -0.0003), (0.0040, -0.0003), (0.0040, 0.0003), (0.0030, 0.0003)],
        (right_xs[2], icon_y, pod_z),
        mat["ink_dark"],
        root,
        segments=28,
        axis="Y",
    )
    box("kd330_icon_clean_drop", (right_xs[2], icon_y, pod_z), (0.0022, 0.0007, 0.0034), mat["ink_dark"], root)


def build_group_head(root, mat):
    """Sculpted mirror-chrome E61-style group head cowling (#9) and 58 mm bayonet collar (#11)."""
    # Planar-quad tapered chrome hood (#9) seated cleanly inside the group bridge (Z = 0.296 .. 0.376 m)
    hood_verts = [
        # Bottom loop at Z = 0.2960 (nested inside group bridge Z_top = 0.3060)
        (-0.0410, FRONT_PANEL_Y + 0.0020, 0.2960),
        (0.0410, FRONT_PANEL_Y + 0.0020, 0.2960),
        (0.0360, -0.1500, 0.2960),
        (0.0200, -0.1710, 0.2960),
        (-0.0200, -0.1710, 0.2960),
        (-0.0360, -0.1500, 0.2960),
        # Uniformly scaled top loop around (0.0, -0.1280) at Z = 0.3760 -> every side quad is strictly planar!
        (-0.0246, FRONT_PANEL_Y + 0.0020, 0.3760),
        (0.0246, FRONT_PANEL_Y + 0.0020, 0.3760),
        (0.0216, -0.1368, 0.3760),
        (0.0120, -0.1494, 0.3760),
        (-0.0120, -0.1494, 0.3760),
        (-0.0216, -0.1368, 0.3760),
    ]
    hood_faces = [
        (0, 6, 7, 1),
        (1, 7, 8, 2),
        (2, 8, 9, 3),
        (3, 9, 10, 4),
        (4, 10, 11, 5),
        (5, 11, 6, 0),
        (6, 11, 10, 9, 8, 7),
        (0, 1, 2, 3, 4, 5),
    ]
    mesh_from_pydata("kd330_group_upper_hood", hood_verts, hood_faces, mat["chrome"], root, bevel=0.0018)

    # Stepped horizontal chrome trim collar at base of hood (Z = 0.3055 m, kd330_WH.jpg)
    lathe_solid(
        "kd330_group_hood_collar",
        [
            (0.0000, 0.3035),
            (0.0498, 0.3035),
            (0.0508, 0.3055),
            (0.0468, 0.3085),
            (0.0000, 0.3085),
        ],
        (GROUP_X, GROUP_Y, 0.0),
        mat["chrome"],
        root,
        segments=72,
    )

    # Top hex chrome cap nut on group hood
    clean_cylinder(
        "kd330_group_top_hex_nut",
        (0.0, -0.1340, 0.3805),
        0.0115,
        0.0090,
        mat["chrome"],
        root,
        vertices=6,
        bevel=0.0008,
    )

    # Red triangle hot-surface warning emblem on front nose slope (Y at Z=0.335 is ~ -0.160)
    tri_verts = [
        (0.0, -0.1592, 0.3430),
        (-0.0072, -0.1630, 0.3285),
        (0.0072, -0.1630, 0.3285),
        (0.0, -0.1584, 0.3430),
        (-0.0072, -0.1622, 0.3285),
        (0.0072, -0.1622, 0.3285),
    ]
    tri_faces = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    mesh_from_pydata("kd330_group_hot_caution", tri_verts, tri_faces, mat["red_accent"], root, bevel=0.0)

    # Lower horizontal D-bridge connecting front panel to cylindrical 58 mm group bell
    box(
        "kd330_group_bridge",
        (0.0, -0.1320, 0.2840),
        (0.0980, 0.0560, 0.0440),
        mat["chrome"],
        root,
        0.0025,
    )

    # Cylindrical 58 mm mirror-chrome group head bell (#11) centered at (0.0, -0.1600)
    lathe_solid(
        "kd330_group_head_58mm",
        [
            (0.0310, 0.2550),
            (0.0430, 0.2550),
            (0.0450, 0.2620),
            (0.0450, 0.2680),
            (0.0495, 0.2700),
            (0.0495, 0.3010),
            (0.0465, 0.3060),
            (0.0000, 0.3060),
            (0.0000, 0.2580),
            (0.0310, 0.2580),
        ],
        (GROUP_X, GROUP_Y, 0.0),
        mat["chrome"],
        root,
        segments=72,
    )

    clean_cylinder(
        "kd330_group_dispersion_screen",
        (GROUP_X, GROUP_Y, 0.2575),
        0.0288,
        0.0020,
        mat["steel"],
        root,
        vertices=48,
    )

    # Right-side manual brew valve boss supporting kd330_steam_lever (#10 Manual control)
    box(
        "kd330_manual_valve_block",
        (0.0550, -0.1520, 0.2820),
        (0.0180, 0.0240, 0.0260),
        mat["chrome"],
        root,
        0.0015,
    )


def build_machine_body(root, mat):
    # 1. Four tall commercial brushed-stainless legs + fluted black rubber pads touching Z = 0.0000 m
    for fname, fx, fy in FOOT_POSITIONS:
        foot = empty(fname, (fx, fy, 0.0), root)
        foot["contact_plane_z_m"] = 0.0
        # Fluted rubber base pad: Z = 0.0000 .. 0.0080 m
        lathe_solid(
            f"{fname}_pad",
            [
                (0.0000, 0.0000),
                (0.0235, 0.0000),
                (0.0245, 0.0025),
                (0.0245, 0.0080),
                (0.0215, 0.0085),
                (0.0000, 0.0085),
            ],
            (0.0, 0.0, 0.0),
            mat["rubber"],
            foot,
            segments=44,
        )
        # Tall cylindrical brushed-stainless leg column: Z = 0.0080 .. 0.0540 m
        clean_cylinder(
            f"{fname}_collar",
            (0.0, 0.0, 0.0310),
            0.0220,
            0.0460,
            mat["chrome"],
            foot,
            vertices=48,
        )

    # Under-chassis sump box & front drip-tray support U-brackets (page-01.png & kd330_WH.jpg)
    box(
        "kd330_under_sump_box",
        (0.0, 0.0200, 0.0340),
        (0.1240, 0.2200, 0.0380),
        mat["dark_metal"],
        root,
        0.0012,
    )
    for side_s, s_lbl in ((-1.0, "left"), (1.0, "right")):
        box(
            f"kd330_front_support_rail_{s_lbl}",
            (side_s * 0.0880, -0.1440, 0.0500),
            (0.0560, 0.1400, 0.0070),
            mat["steel"],
            root,
            0.0008,
        )

    # 2. Main stainless body core, front flat stainless bulkhead, rear wall, and side cheeks
    # Side cheeks span Y in [-0.1050, +0.2240] so they butt cleanly against rear_panel Y in [+0.2240, +0.2300]
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        box(
            f"kd330_side_cheek_{side_name}",
            (side_sign * 0.1545, 0.0595, 0.2420),
            (0.0060, 0.3290, 0.3800),
            mat["steel"],
            root,
            0.0006,
        )
        # 4 signature cylindrical chrome side-panel fasteners per side -> exact outer X = +-0.160000 m!
        for bz_i, bz in enumerate((0.0820, 0.4020)):
            for by_i, by in enumerate((-0.0550, 0.1800)):
                clean_cylinder(
                    f"kd330_side_bolt_{side_name}_{bz_i}_{by_i}",
                    (side_sign * 0.1585, by, bz),
                    0.0062,
                    0.0030,
                    mat["chrome"],
                    root,
                    axis="X",
                    vertices=28,
                )

    # Flat vertical stainless front face (Y = -0.1050 m, Z = 0.0520 .. 0.4320 m)
    box(
        "kd330_front_panel",
        (0.0, FRONT_PANEL_Y + 0.0030, 0.2420),
        (0.3030, 0.0060, 0.3800),
        mat["steel"],
        root,
        0.0005,
    )

    # Rear stainless wall defining exact Y_max = +0.230000 m
    box(
        "kd330_rear_panel",
        (0.0, 0.2270, 0.2420),
        (0.3150, 0.0060, 0.3800),
        mat["steel"],
        root,
        0.0005,
    )
    # Recessed rear lower 200V AC power switch & cord entry pocket (stays <= +0.2295 m)
    box(
        "kd330_rear_power_inlet",
        (0.0880, 0.2268, 0.0860),
        (0.0520, 0.0040, 0.0360),
        mat["rubber"],
        root,
        0.0008,
    )
    box(
        "kd330_rear_rating_plate",
        (-0.0680, 0.2288, 0.1020),
        (0.0940, 0.0012, 0.0480),
        mat["dark_metal"],
        root,
        0.0003,
    )

    # Internal chassis block recessed 2 mm inside outer panels so no faces overlap
    box(
        "kd330_boiler_pump_core",
        (0.0, 0.0620, 0.2400),
        (0.2980, 0.3180, 0.3720),
        mat["steel"],
        root,
        0.0008,
    )

    # Folded top stainless crown cap (Z = 0.4320 .. 0.4480 m) overhanging front & sides slightly
    # Front lip + left/right deck rails + rear rail framing the cup warmer and water reservoir well
    box(
        "kd330_top_crown_front",
        (0.0, -0.0995, 0.4400),
        (0.3150, 0.0150, 0.0160),
        mat["steel"],
        root,
        0.0008,
    )
    box(
        "kd330_top_crown_rear",
        (0.0, 0.2190, 0.4400),
        (0.3150, 0.0220, 0.0160),
        mat["steel"],
        root,
        0.0008,
    )
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        box(
            f"kd330_top_crown_{side_name}",
            (side_sign * 0.1435, 0.0600, 0.4400),
            (0.0280, 0.3040, 0.0160),
            mat["steel"],
            root,
            0.0008,
        )
    box(
        "kd330_top_crown_divider",
        (0.0, 0.0770, 0.4400),
        (0.2590, 0.0120, 0.0160),
        mat["steel"],
        root,
        0.0006,
    )

    # 3. Cup warmer perforated stainless tray (#2, Z = 0.4500 m) + internal 2.5 L water tank (#1)
    build_punched_cup_warmer_deck("kd330_cup_warmer_deck", root, mat)

    box(
        "kd330_water_reservoir_2_5l",
        (0.0, 0.1450, 0.3960),
        (0.2440, 0.1180, 0.0920),
        mat["tank_blue"],
        root,
        0.0020,
    )
    # Folded black carry handle inside 2.5 L water tank (manual p. 5)
    box(
        "kd330_water_tank_handle",
        (0.0, 0.1450, 0.4435),
        (0.1560, 0.0120, 0.0040),
        mat["black_abs"],
        root,
        0.0008,
    )

    # 4. Tubular stainless cup-warmer guard hoops topping at exact Z = +0.480000 m!
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        bent_hoop_rail(
            f"kd330_top_rail_{side_name}",
            side_sign * 0.1435,
            -0.0860,
            0.1980,
            0.4480,
            0.4800,
            0.0040,
            mat["chrome"],
            root,
            plane="YZ",
        )
    bent_hoop_rail(
        "kd330_top_rail_rear",
        0.2180,
        -0.1140,
        0.1140,
        0.4480,
        0.4800,
        0.0040,
        mat["chrome"],
        root,
        plane="XZ",
    )

    # 5. Upper front 4-button + 3-button control pods (#7)
    build_control_pods(root, mat)

    # 6. Round chrome-bezeled segmented LCD display (#3) at (-0.0520, FRONT_PANEL_Y, 0.3450)
    lathe_solid(
        "kd330_lcd_chrome_bezel",
        [
            (0.0195, -0.0062),
            (0.0255, -0.0062),
            (0.0268, -0.0035),
            (0.0268, 0.0010),
            (0.0195, 0.0010),
        ],
        LCD_CENTER,
        mat["chrome"],
        root,
        segments=56,
        axis="Y",
    )
    lcd_panel = clean_cylinder(
        "kd330_lcd_screen",
        (LCD_CENTER[0], FRONT_PANEL_Y - 0.0022, LCD_CENTER[2]),
        0.0202,
        0.0012,
        mat["lcd_face"],
        root,
        axis="Y",
        vertices=56,
    )
    add_planar_xz_uv(lcd_panel)
    clean_cylinder(
        "kd330_lcd_glass_lens",
        (LCD_CENTER[0], FRONT_PANEL_Y - 0.0046, LCD_CENTER[2]),
        0.0200,
        0.0008,
        mat["glass_clear"],
        root,
        axis="Y",
        vertices=56,
    )

    # 7. Left Steam Valve & 10-Lobe Scalloped Black Knob (#4) + Right Hot-Water Valve & Knob (#8)
    for side_sign, v_name, label_txt in (
        (-1.0, "steam", "STEAM"),
        (1.0, "hot_water", "HOT WATER"),
    ):
        vx = side_sign * 0.1040
        vz = 0.3420
        # Chrome panel escutcheon flange
        lathe_solid(
            f"kd330_{v_name}_flange",
            [
                (0.0120, -0.0120),
                (0.0205, -0.0050),
                (0.0205, 0.0010),
                (0.0120, 0.0010),
            ],
            (vx, FRONT_PANEL_Y, vz),
            mat["chrome"],
            root,
            segments=44,
            axis="Y",
        )
        # Forward-angled chrome valve body + downward hex nut boss to wand
        clean_cylinder(
            f"kd330_{v_name}_valve_body",
            (vx, -0.1240, vz - 0.0040),
            0.0115,
            0.0360,
            mat["chrome"],
            root,
            axis="Y",
            vertices=36,
        )
        clean_cylinder(
            f"kd330_{v_name}_hex_collar",
            (vx, -0.1280, 0.3120),
            0.0128,
            0.0180,
            mat["chrome"],
            root,
            vertices=6,
            bevel=0.0008,
        )
        # 10-lobe scalloped matte-black commercial rotary knob
        build_scalloped_knob(
            f"kd330_{v_name}_scalloped_knob",
            (vx, -0.1500, vz - 0.0040),
            r_base=0.0265,
            lobes=10,
            lobe_amp=0.0028,
            depth_y=0.0220,
            surface=mat["black_abs"],
            parent=root,
        )
        # Crisp silkscreen label above valve escutcheon
        text_3d(
            f"kd330_{v_name}_panel_label",
            label_txt,
            (vx - 0.0060, FRONT_PANEL_Y - 0.0008, vz + 0.0255),
            0.0042,
            mat["ink_dark"],
            root,
        )

    # 8. Sculpted mirror-chrome E61-style group head (#9, #11)
    build_group_head(root, mat)

    # 9. Right-side Hot Water Wand (#12) with winged rubber pinch grip & flared chrome aerator tip
    hw_wand = pipe_segments(
        "kd330_hot_water_spout",
        [
            (0.1040, -0.1280, 0.3040),
            (0.1040, -0.1300, 0.2680),
            (0.1000, -0.1460, 0.2420),
            (0.0980, -0.1500, 0.2140),
        ],
        0.0046,
        mat["chrome"],
        root,
    )
    build_pinch_burn_guard(
        "kd330_hot_water_burn_guard",
        (0.1020, -0.1380, 0.2560),
        side_sign=1.0,
        surface=mat["rubber"],
        parent=root,
    )
    lathe_solid(
        "kd330_hot_water_nozzle",
        [
            (0.0000, 0.2030),
            (0.0086, 0.2030),
            (0.0086, 0.2120),
            (0.0062, 0.2145),
            (0.0062, 0.2210),
            (0.0000, 0.2210),
        ],
        (0.0980, -0.1500, 0.0),
        mat["chrome"],
        root,
        segments=36,
    )

    # 10. Lower-right round chrome 0-16 bar Pressure Gauge (#13) at (0.0420, FRONT_PANEL_Y, 0.1680)
    gx, _, gz = GAUGE_ORIGIN
    lathe_solid(
        "kd330_gauge_chrome_bezel",
        [
            (0.0225, -0.0072),
            (0.0278, -0.0072),
            (0.0290, -0.0040),
            (0.0290, 0.0010),
            (0.0225, 0.0010),
        ],
        (gx, FRONT_PANEL_Y, gz),
        mat["chrome"],
        root,
        segments=64,
        axis="Y",
    )
    gauge_dial = clean_cylinder(
        "kd330_gauge_dial_disk",
        (gx, FRONT_PANEL_Y - 0.0014, gz),
        0.0232,
        0.0010,
        mat["gauge_face"],
        root,
        axis="Y",
        vertices=64,
    )
    add_planar_xz_uv(gauge_dial)
    clean_cylinder(
        "kd330_gauge_crystal_lens",
        (gx, FRONT_PANEL_Y - 0.0058, gz),
        0.0228,
        0.0008,
        mat["glass_clear"],
        root,
        axis="Y",
        vertices=64,
    )
    return hw_wand


def build_steam_wand(root, mat):
    """Left-side 360-deg articulated stainless steam wand (#5) with winged pinch guard & 3-hole tip."""
    wand = empty("kd330_steam_wand", STEAM_WAND_ORIGIN, root)
    wand["joint_type"] = "hinge"
    wand["joint_name"] = "kd330_steam_wand_swing"
    wand["axis_blender"] = "+X"
    wand["range_rad"] = [-0.35, 0.55]

    clean_cylinder(
        "kd330_steam_swivel_nut",
        (0.0, 0.0, 0.0060),
        0.0096,
        0.0140,
        mat["chrome"],
        wand,
        vertices=32,
        bevel=0.0008,
    )

    pipe_segments(
        "kd330_steam_wand_tube",
        [
            (0.0, 0.0, 0.0020),
            (0.0010, -0.0020, -0.0360),
            (0.0060, -0.0150, -0.0680),
            (0.0100, -0.0240, -0.1420),
        ],
        0.0044,
        mat["chrome"],
        wand,
    )

    build_pinch_burn_guard(
        "kd330_steam_burn_guard",
        (0.0035, -0.0085, -0.0500),
        side_sign=-1.0,
        surface=mat["rubber"],
        parent=wand,
    )

    # Authentic tapered bulbous 3-hole stainless steam nozzle tip
    lathe_solid(
        "kd330_steam_3hole_tip",
        [
            (0.0000, -0.1560),
            (0.0042, -0.1560),
            (0.0068, -0.1500),
            (0.0064, -0.1420),
            (0.0046, -0.1380),
            (0.0000, -0.1380),
        ],
        (0.0100, -0.0245, 0.0),
        mat["chrome"],
        wand,
        segments=36,
    )
    return wand


def build_steam_lever(root, mat):
    """E61-style manual brew lever (#10 Manual control) on right side of group head."""
    lever = empty("kd330_steam_lever", STEAM_LEVER_ORIGIN, root)
    lever["joint_type"] = "hinge"
    lever["joint_name"] = "kd330_steam_lever_hinge"
    lever["axis_blender"] = "-X"
    lever["range_rad"] = [0.0, 0.85]

    clean_cylinder(
        "kd330_steam_lever_hub",
        (0.0020, 0.0, 0.0),
        0.0095,
        0.0120,
        mat["chrome"],
        lever,
        axis="X",
        vertices=32,
        bevel=0.0008,
    )

    pipe_segments(
        "kd330_steam_lever_stalk",
        [
            (0.0050, 0.0, 0.0),
            (0.0075, -0.0100, -0.0360),
            (0.0095, -0.0200, -0.0720),
        ],
        0.0038,
        mat["chrome"],
        lever,
    )

    # Sculpted teardrop black phenolic knob (kd330_WH.jpg #10)
    knob = lathe_solid(
        "kd330_steam_lever_grip",
        [
            (0.0000, -0.0280),
            (0.0085, -0.0265),
            (0.0112, -0.0190),
            (0.0100, -0.0100),
            (0.0062, 0.0020),
            (0.0000, 0.0020),
        ],
        (0.0, 0.0, 0.0),
        mat["black_abs"],
        lever,
        segments=36,
    )
    knob.rotation_euler.x = math.radians(-15.5)
    knob.location = (0.0095, -0.0200, -0.0700)
    bpy.context.view_layer.objects.active = knob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return lever


def build_tank_lid(root, mat):
    """Top rear 2.5 L water reservoir cover panel (#1) hinged at Y = 0.2080 m."""
    lid = empty("kd330_tank_lid", TANK_LID_ORIGIN, root)
    lid["joint_type"] = "hinge"
    lid["joint_name"] = "kd330_tank_lid_hinge"
    lid["axis_blender"] = "-X"
    lid["range_rad"] = [0.0, 1.05]

    box(
        "kd330_tank_lid_plate",
        (0.0, -0.0620, -0.0020),
        (0.2560, 0.1240, 0.0050),
        mat["steel"],
        lid,
        0.0006,
    )
    # Recessed left/right finger notches (manual p. 5)
    for sx, s_lbl in ((-0.1020, "left"), (0.1020, "right")):
        box(
            f"kd330_tank_lid_notch_{s_lbl}",
            (sx, -0.1140, 0.0010),
            (0.0280, 0.0100, 0.0016),
            mat["dark_metal"],
            lid,
            0.0003,
        )
    return lid


def build_drip_tray(root, mat):
    """Pull-out stainless drip tray (#6) with welded wire-rod grate & riveted WPM WELHOME PRO badge."""
    tray = empty("kd330_drip_tray", DRIP_TRAY_ORIGIN, root)
    tray["joint_type"] = "slide"
    tray["joint_name"] = "kd330_drip_tray_slide"
    tray["axis_blender"] = "-Y"
    tray["range_m"] = [0.0, 0.160]

    # Hollow-walled stainless drip tray pan so wire grate reveals deep dark catch basin without overlap!
    # Tray outer X in [-0.1570, +0.1570], local Y in [-0.0840, +0.0840] (world Y in [-0.2280, -0.0600]),
    # local Z in [-0.0300, +0.0300] (world Z in [0.0540, 0.1140])
    box("kd330_drip_tray_pan", (0.0, -0.0770, 0.0), (0.3140, 0.0140, 0.0600), mat["steel"], tray, 0.0008)
    box("kd330_drip_tray_rear_wall", (0.0, 0.0770, 0.0), (0.3140, 0.0140, 0.0600), mat["steel"], tray, 0.0006)
    for sx, s_lbl in ((-0.1480, "left"), (0.1480, "right")):
        box(f"kd330_drip_tray_wall_{s_lbl}", (sx, 0.0, 0.0), (0.0180, 0.1400, 0.0600), mat["steel"], tray, 0.0008)
    box("kd330_drip_tray_floor", (0.0, 0.0, -0.0250), (0.2780, 0.1400, 0.0100), mat["dark_metal"], tray, 0.0004)

    # Welded commercial stainless wire-bar cup grate at exact world Z_top = 0.1120 m (local Z_top = +0.0280 m)
    # Build as one unified multi-bar mesh `kd330_drip_tray_grate` so raycasts hit cleanly!
    grate_parts = []
    # Perimeter rectangular wire rim
    for rx, ry, rw, rd in (
        (0.0, -0.0660, 0.2720, 0.0036),
        (0.0, 0.0380, 0.2720, 0.0036),
        (-0.1342, -0.0140, 0.0036, 0.1040),
        (0.1342, -0.0140, 0.0036, 0.1040),
        # 3 longitudinal underside support bars
        (-0.0720, -0.0140, 0.0030, 0.1020),
        (0.0000, -0.0140, 0.0030, 0.1020),
        (0.0720, -0.0140, 0.0030, 0.1020),
    ):
        grate_parts.append(
            box(f"_grate_tmp_{len(grate_parts)}", (rx, ry, 0.0260), (rw, rd, 0.0032), mat["chrome"], tray, 0.0003)
        )
    # 19 transverse stainless wire bars spanning X (spacing 5.2 mm along Y, top at exact local Z = +0.0280 -> world Z = 0.1120 m!)
    for w_i in range(19):
        wy = -0.0608 + w_i * 0.0052
        grate_parts.append(
            box(f"_grate_wire_{w_i}", (0.0, wy, 0.0269), (0.2680, 0.0022, 0.0022), mat["chrome"], tray, 0.0004)
        )

    bpy.ops.object.select_all(action="DESELECT")
    for gp in grate_parts:
        for mod in list(gp.modifiers):
            bpy.context.view_layer.objects.active = gp
            bpy.ops.object.modifier_apply(modifier=mod.name)
        gp.select_set(True)
    bpy.context.view_layer.objects.active = grate_parts[0]
    bpy.ops.object.join()
    grate = bpy.context.object
    grate.name = "kd330_drip_tray_grate"
    grate.data.name = "kd330_drip_tray_grate"

    # Signature front stadium badge: "WPM / WELHOME PRO" + 2 silver rivets -> exact world Y_min = -0.230000 m!
    # Tray front face is at local Y = -0.0840 (world -0.2280)
    stadium_prism(
        "kd330_drip_badge_rim",
        (0.0, -0.0844, -0.0020),
        0.0920,
        0.0320,
        0.0008,
        0.0105,
        mat["chrome"],
        tray,
    )
    stadium_prism(
        "kd330_drip_badge_plate",
        (0.0, -0.0851, -0.0020),
        0.0884,
        0.0286,
        0.0006,
        0.0092,
        mat["black_abs"],
        tray,
    )
    for rx_s, r_lbl in ((-0.0375, "left"), (0.0375, "right")):
        clean_cylinder(
            f"kd330_drip_badge_rivet_{r_lbl}",
            (rx_s, -0.0857, -0.0020),
            0.0022,
            0.0006,
            mat["chrome"],
            tray,
            axis="Y",
            vertices=20,
        )
    text_3d(
        "kd330_drip_badge_wpm",
        "WPM",
        (0.0, -0.0855, 0.0018),
        0.0115,
        mat["badge_white"],
        tray,
        extrude=0.0005,
    )
    text_3d(
        "kd330_drip_badge_sub",
        "WELHOME PRO",
        (0.0, -0.0855, -0.0085),
        0.0044,
        mat["badge_white"],
        tray,
        extrude=0.0004,
    )
    return tray


def build_gauge_needle(root, mat):
    needle = empty("kd330_gauge_needle", GAUGE_ORIGIN, root)
    needle["joint_type"] = "hinge"
    needle["joint_name"] = "kd330_gauge_hinge"
    needle["axis_blender"] = "+Y"
    needle["range_rad"] = [0.0, 3.80]

    clean_cylinder(
        "kd330_gauge_pointer_cap",
        (0.0, -0.0009, 0.0),
        0.0032,
        0.0010,
        mat["chrome"],
        needle,
        axis="Y",
        vertices=24,
        bevel=0.0002,
    )

    ptr = box(
        "kd330_gauge_pointer_blade",
        (0.0, -0.0002, 0.0075),
        (0.0015, 0.0006, 0.0180),
        mat["red_accent"],
        needle,
        0.0,
    )
    ang = math.radians(-125.0)
    for v in ptr.data.vertices:
        x0, z0 = v.co.x, v.co.z + 0.0075
        v.co.x = x0 * math.cos(ang) + z0 * math.sin(ang)
        v.co.z = -x0 * math.sin(ang) + z0 * math.cos(ang)
    ptr.location = (0.0, 0.0, 0.0)
    ptr.data.update()
    return needle


def build_portafilter(root, mat):
    """58 mm commercial mirror-chrome double-spout portafilter with slanted WPM chrome pommel."""
    pf = empty("kd330_portafilter", PF_REST_POSE, root)
    pf["accessory_role"] = "58 mm commercial stainless double-spout portafilter"
    pf["mass_kg"] = 0.520

    lathe_solid(
        "kd330_pf_basket_head",
        [
            (0.0290, 0.0140),
            (0.0355, 0.0140),
            (0.0355, 0.0085),
            (0.0338, 0.0085),
            (0.0328, -0.0140),
            (0.0215, -0.0140),
            (0.0215, -0.0105),
            (0.0286, -0.0085),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome"],
        pf,
        segments=64,
    )

    clean_cylinder(
        "kd330_pf_filter_basket",
        (0.0, 0.0, -0.0085),
        0.0286,
        0.0020,
        mat["steel"],
        pf,
        vertices=48,
    )

    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        box(
            f"kd330_pf_bayonet_lug_{side_name}",
            (side_sign * 0.0370, 0.0, 0.0105),
            (0.0065, 0.0190, 0.0050),
            mat["chrome"],
            pf,
            0.0006,
        )

    # Curved commercial double-spout manifold underneath basket
    box(
        "kd330_pf_spout_block",
        (0.0, 0.0, -0.0185),
        (0.0260, 0.0160, 0.0090),
        mat["chrome"],
        pf,
        0.0012,
    )
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        pipe_segments(
            f"kd330_pf_spout_{side_name}",
            [
                (side_sign * 0.0080, 0.0, -0.0210),
                (side_sign * 0.0190, 0.0, -0.0245),
                (side_sign * 0.0255, 0.0, -0.0315),
            ],
            0.0042,
            mat["chrome"],
            pf,
        )

    # Angled chrome neck + tapered black handle + large mirror-chrome WPM end pommel (kd330_WH.jpg)
    tilt = math.radians(-10.0)
    neck = clean_cylinder(
        "kd330_pf_handle_neck",
        (0.0, -0.0440, -0.0025),
        0.0092,
        0.0260,
        mat["chrome"],
        pf,
        axis="Y",
        vertices=36,
        bevel=0.0006,
    )
    neck.rotation_euler.x = tilt
    bpy.context.view_layer.objects.active = neck
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    grip = lathe_solid(
        "kd330_pf_ergonomic_handle",
        [
            (0.0000, 0.0520),
            (0.0112, 0.0520),
            (0.0128, 0.0220),
            (0.0154, -0.0260),
            (0.0168, -0.0500),
            (0.0000, -0.0500),
        ],
        (0.0, 0.0, 0.0),
        mat["black_abs"],
        pf,
        segments=44,
        axis="Y",
    )
    grip.rotation_euler.x = tilt
    grip.location = (0.0, -0.1040, -0.0130)
    bpy.context.view_layer.objects.active = grip
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    pommel = lathe_solid(
        "kd330_pf_handle_pommel",
        [
            (0.0000, 0.0110),
            (0.0168, 0.0110),
            (0.0172, -0.0060),
            (0.0156, -0.0110),
            (0.0000, -0.0110),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome"],
        pf,
        segments=44,
        axis="Y",
    )
    pommel.rotation_euler.x = tilt
    pommel.location = (0.0, -0.1630, -0.0234)
    bpy.context.view_layer.objects.active = pommel
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    wpm_cap = text_3d(
        "kd330_pf_pommel_wpm",
        "WPM",
        (0.0, -0.1742, -0.0254),
        0.0068,
        mat["ink_dark"],
        pf,
        rot=(math.pi / 2 + tilt, 0.0, 0.0),
        extrude=0.0004,
    )
    _ = wpm_cap

    socket = empty("vessel_socket", (0.0, -0.1080, -0.0135), pf)
    socket["site_role"] = "58 mm commercial portafilter handle grasp socket"
    return pf


def clear_all_animations(root):
    root.animation_data_clear()
    for obj in root.children_recursive:
        obj.animation_data_clear()


def export_glbs(root, pf):
    bpy.context.scene.frame_set(1)
    clear_all_animations(root)
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

    saved_parent = pf.parent
    saved_loc = pf.location.copy()
    saved_rot = tuple(pf.rotation_euler)
    pf.parent = None
    pf.location = (0.0, 0.0, 0.0)
    pf.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action="DESELECT")
    pf.select_set(True)
    for obj in pf.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-portafilter.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )

    pf.parent = saved_parent
    pf.location = saved_loc
    pf.rotation_euler = saved_rot
    bpy.context.view_layer.update()


def animate_timeline(wand, lever, tank_lid, drip_tray, gauge, pf):
    keyframes = (
        # Frame 1..20: Rest pose
        (1, 0.0, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
        # Frame 55: Open service pose (top 2.5L water tank lid open 52 deg, drip tray slid out 120 mm, portafilter on wire grate)
        (55, -0.22, 0.0, -0.90, -0.120, 0.0, (0.0, -0.2400, 0.1265), (0.0, 0.0, math.radians(16.0))),
        # Frame 85: Active 9.0 bar extraction + super-steam (gauge at 2.14 rad = 9 bar, E61 brew lever lifted -0.72 rad, wand swung out)
        (85, -0.28, -0.72, 0.0, 0.0, 2.14, PF_REST_POSE, (0.0, 0.0, 0.0)),
        # Frame 120: Rest pose restored
        (120, 0.0, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
    )
    for fno, wand_rx, lev_rx, lid_rx, tray_dy, gauge_ry, pf_loc, pf_rot in keyframes:
        wand.rotation_euler = (wand_rx, 0.0, 0.0)
        wand.keyframe_insert(data_path="rotation_euler", frame=fno)

        lever.rotation_euler = (lev_rx, 0.0, 0.0)
        lever.keyframe_insert(data_path="rotation_euler", frame=fno)

        tank_lid.rotation_euler = (lid_rx, 0.0, 0.0)
        tank_lid.keyframe_insert(data_path="rotation_euler", frame=fno)

        drip_tray.location = (DRIP_TRAY_ORIGIN[0], DRIP_TRAY_ORIGIN[1] + tray_dy, DRIP_TRAY_ORIGIN[2])
        drip_tray.keyframe_insert(data_path="location", frame=fno)

        gauge.rotation_euler = (0.0, gauge_ry, 0.0)
        gauge.keyframe_insert(data_path="rotation_euler", frame=fno)

        pf.location = pf_loc
        pf.rotation_euler = pf_rot
        pf.keyframe_insert(data_path="location", frame=fno)
        pf.keyframe_insert(data_path="rotation_euler", frame=fno)


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def setup_studio(scene):
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = "GPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100

    scene.world = bpy.data.worlds.new("KD330X_studio_world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.60, 0.65, 0.72, 1.0)
    bg.inputs["Strength"].default_value = 0.55
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.12

    ground = material("kd330_studio_ground", (0.28, 0.30, 0.33, 1.0), 0.0, 0.86)
    bpy.ops.mesh.primitive_plane_add(size=160.0, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio ground"
    floor.data.materials.append(ground)

    area_light("Left key softbox", (-1.40, -1.75, 1.65), (0.0, -0.05, 0.24), 195.0, 1.50)
    area_light("Right fill stripbox", (1.45, -0.75, 1.35), (0.0, -0.04, 0.24), 135.0, 1.25)
    area_light("Rear rim softbox", (-0.10, 1.55, 1.60), (0.0, 0.02, 0.28), 150.0, 1.30)
    area_light("Front reflection card", (-0.85, -1.65, 0.92), (0.0, -0.14, 0.25), 42.0, 1.10)

    cam_data = bpy.data.cameras.new("Review camera")
    cam_data.type = "ORTHO"
    cam_data.lens = 50
    camera = bpy.data.objects.new("Review camera", cam_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    studio_col = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(studio_col)
    move_objects(set(scene.objects) - before, studio_col)
    return camera


def set_camera(camera, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)


def compute_machine_bounds(root, pf):
    bpy.context.view_layer.update()
    excluded = {pf, *pf.children_recursive}
    machine_meshes = [o for o in root.children_recursive if o.type == "MESH" and o not in excluded]
    all_meshes = [o for o in root.children_recursive if o.type == "MESH"]
    m_low, m_high = bounds(machine_meshes)
    a_low, a_high = bounds(all_meshes)
    return m_low, m_high, m_high - m_low, a_low, a_high, a_high - a_low


def inspect_exported_glb():
    """Re-import exported GLB in a clean Blender factory scene and write inspection-report.json."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb_path = ASSETS / f"{NAME}.glb"
    pf_glb_path = ASSETS / f"{NAME}-portafilter.glb"
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["kd330_body"]
    wand = objects["kd330_steam_wand"]
    lever = objects["kd330_steam_lever"]
    tank_lid = objects["kd330_tank_lid"]
    drip_tray = objects["kd330_drip_tray"]
    gauge = objects["kd330_gauge_needle"]
    pf = objects["kd330_portafilter"]
    socket = objects["vessel_socket"]
    left_cheek = objects["kd330_side_cheek_left"]
    cup_deck = objects["kd330_cup_warmer_deck"]
    front_panel = objects["kd330_front_panel"]
    left_pod = objects["kd330_left_button_pod"]

    for child in (wand, lever, tank_lid, drip_tray, gauge, pf):
        assert child.parent == root, child.name
    assert socket.parent == pf
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objects)

    bpy.context.view_layer.update()
    excluded = {pf, *pf.children_recursive}
    m_low, m_high = bounds(o for o in root.children_recursive if o not in excluded)
    dims = m_high - m_low
    for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Published WPM KD-330X envelope")
    near(m_low.z, 0.0, "Machine foot contact plane Z=0.000")
    near(m_high.z, HEIGHT, "Cup-warmer guard rail Z=0.480")

    # Anti-z-fighting step check between front stainless panel and button pod
    fp_low, _ = bounds([front_panel])
    pod_low, _ = bounds([left_pod])
    front_pod_step_mm = round((fp_low.y - pod_low.y) * 1000.0, 2)
    assert front_pod_step_mm >= 1.5, f"Button pod front step too small: {front_pod_step_mm} mm"

    # Fault-injection guard: shifting side cheek outward by -10 mm must fail envelope check
    orig_x = left_cheek.location.x
    left_cheek.location.x -= 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        fl, fh = bounds(o for o in root.children_recursive if o not in excluded)
        near((fh - fl).x, WIDTH, "Fault check")
    except AssertionError:
        fault_detected = True
    left_cheek.location.x = orig_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope fault-injection guard failed"

    # Verify all 4 feet touch Z = 0.000 m
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("kd330_foot_"):
            fl, _ = bounds(obj.children_recursive)
            near(fl.z, 0.0, f"Foot contact plane {obj.name}")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Raycast downward onto cup-warmer top deck (Z = 0.450 m) and drip-tray wire grate (Z = 0.112 m)
    orig_pf_loc = pf.location.copy()
    pf.location = Vector((0.0, -0.55, 0.24))
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    hit_cw, pt_cw, nrm_cw, _f, obj_cw, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, -0.010, 0.520)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_cw and obj_cw == cup_deck, obj_cw
    near(pt_cw.z, 0.4500, "Cup-warmer deck Z=0.4500")
    assert nrm_cw.z > 0.99

    # Wire bar #9 sits at local Y = -0.0608 + 9*0.0052 = -0.0140 -> world Y = -0.1580
    hit_dt, pt_dt, nrm_dt, _f, obj_dt, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, -0.1580, 0.1950)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_dt and obj_dt is not None and "drip" in obj_dt.name, obj_dt
    near(pt_dt.z, 0.1120, "Drip-tray wire grate Z=0.1120")
    assert nrm_dt.z > 0.95

    pf.location = orig_pf_loc
    bpy.context.view_layer.update()

    required_meshes = {
        "kd330_side_cheek_left",
        "kd330_side_cheek_right",
        "kd330_front_panel",
        "kd330_rear_panel",
        "kd330_cup_warmer_deck",
        "kd330_water_reservoir_2_5l",
        "kd330_group_upper_hood",
        "kd330_group_head_58mm",
        "kd330_steam_scalloped_knob",
        "kd330_hot_water_scalloped_knob",
        "kd330_gauge_dial_disk",
        "kd330_lcd_screen",
        "kd330_steam_wand_tube",
        "kd330_steam_lever_grip",
        "kd330_tank_lid_plate",
        "kd330_drip_tray_pan",
        "kd330_drip_tray_grate",
        "kd330_gauge_pointer_blade",
        "kd330_pf_basket_head",
        "kd330_pf_ergonomic_handle",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "portafilter_glb_sha256": hashlib.sha256(pf_glb_path.read_bytes()).hexdigest(),
        "portafilter_glb_bytes": pf_glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "machine_bounds_min_m": [round(v, 6) for v in m_low],
        "machine_bounds_max_m": [round(v, 6) for v in m_high],
        "machine_dimensions_m": [round(v, 6) for v in dims],
        "cup_warmer_plane_z_m": round(pt_cw.z, 6),
        "drip_grate_plane_z_m": round(pt_dt.z, 6),
        "front_pod_step_mm": front_pod_step_mm,
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported wpm-kd-330x.glb; verify exact 320x460x480 mm machine envelope, Z=0.000 m "
            "feet plane, Z=0.480 m cup-warmer rail height, Z=0.450 m cup-warmer deck, Z=0.112 m wire drip grate, "
            "front-panel anti-z-fighting step, fault-injection width guard, articulated body hierarchy, and zero mesh-quality defects."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    if not bpy.app.background:
        raise RuntimeError("Run in a background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene
    scene.name = "WPM KD-330X - Japan 200V 1-Group Espresso Machine"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for m_name, f_no in (
        ("Rest", 1),
        ("Water reservoir & drip tray open", 55),
        ("Active 9 bar brew & super-steam", 85),
        ("Rest restored", 120),
    ):
        scene.timeline_markers.new(m_name, frame=f_no)

    gauge_img = generate_gauge_texture(ASSETS / "kd330-gauge-dial.png")
    lcd_img = generate_kd330_lcd_texture(ASSETS / "kd330-lcd-screen.png")
    mat = surfaces(gauge_img, lcd_img)

    root = empty("kd330_body", (0.0, 0.0, 0.0))
    root["manufacturer"] = "WPM (Welhome Pro)"
    root["model"] = "KD-330X"
    root["sku_region"] = "Japan 200V AC 50/60Hz 1850W"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_machine_mass_kg"] = 22.800
    root["portafilter_mass_kg"] = 0.520

    build_machine_body(root, mat)
    wand = build_steam_wand(root, mat)
    lever = build_steam_lever(root, mat)
    tank_lid = build_tank_lid(root, mat)
    drip_tray = build_drip_tray(root, mat)
    gauge = build_gauge_needle(root, mat)
    pf = build_portafilter(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, wand, lever, tank_lid, drip_tray, gauge, pf])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, crease_deg=32.0)

    m_low, m_high, m_dims, a_low, a_high, a_dims = compute_machine_bounds(root, pf)
    for actual, expected in zip(m_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 2e-4, (m_low, m_high, m_dims, (WIDTH, DEPTH, HEIGHT))
    assert abs(m_low.z - 0.0) <= 1e-5, m_low

    # Export static rest-pose GLBs at frame 1 with animation data cleared
    export_glbs(root, pf)

    # Re-apply timeline animation for .blend authoring and studio renders
    animate_timeline(wand, lever, tank_lid, drip_tray, gauge, pf)

    appliance_col = bpy.data.collections.new("WPM KD-330X appliance")
    scene.collection.children.link(appliance_col)
    move_objects([root, *root.children_recursive], appliance_col)

    camera = setup_studio(scene)
    views = (
        ("studio-main", (-1.02, -1.76, 0.78), (0.0, -0.04, 0.24), 0.76, 1),
        ("studio-front", (0.0, -1.95, 0.24), (0.0, -0.02, 0.24), 0.66, 1),
        ("studio-right", (1.95, -0.03, 0.24), (0.0, -0.03, 0.24), 0.78, 1),
        ("studio-open", (-1.12, -1.80, 0.96), (0.0, -0.06, 0.27), 0.92, 55),
        ("studio-active", (-0.72, -1.52, 0.54), (-0.01, -0.12, 0.26), 0.56, 85),
    )
    rendered_files = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = ASSETS / f"{vname}.png"
            scene.render.filepath = str(out_png)
            bpy.ops.render.render(write_still=True)
            rendered_files.append(f"{vname}.png")

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])

    for m in bpy.data.materials:
        m["metallic"] = float(m.get("metallic", 0.0))
        m["roughness"] = float(m.get("roughness", 0.35))
        m["emission"] = float(m.get("emission", 0.0))

    build_report = {
        "asset": NAME,
        "title": "WPM KD-330X 1-Group Commercial Espresso Machine (Japan SKU)",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "machine_bounds_min_m": [round(v, 6) for v in m_low],
        "machine_bounds_max_m": [round(v, 6) for v in m_high],
        "machine_dimensions_m": [round(v, 6) for v in m_dims],
        "with_portafilter_bounds_min_m": [round(v, 6) for v in a_low],
        "with_portafilter_bounds_max_m": [round(v, 6) for v in a_high],
        "with_portafilter_dimensions_m": [round(v, 6) for v in a_dims],
        "published_machine_mass_kg": 22.800,
        "detachable_portafilter_mass_kg": 0.520,
        "electrical_supply": "Single-phase 200 V AC, 50/60 Hz, 1,850 W",
        "hydraulic_system": "7-stage gear pump + 0.8 L brew boiler + 86-98 C PID brew thermoblock + 7-level super-steam thermoblock",
        "water_reservoir_l": 2.5,
        "glb_sha256": hashlib.sha256((ASSETS / f"{NAME}.glb").read_bytes()).hexdigest(),
        "portafilter_glb_sha256": hashlib.sha256((ASSETS / f"{NAME}-portafilter.glb").read_bytes()).hexdigest(),
        "renders": rendered_files,
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))

    inspection = inspect_exported_glb()
    print(json.dumps({"build": build_report, "inspection": inspection["status"]}, indent=2))


if __name__ == "__main__":
    main()
