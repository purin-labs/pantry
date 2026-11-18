"""Build the Square Register (2nd Generation, SPS1-01) visual model in Blender 5.2.

Reference ground truth:
- Square Register 2nd Generation (SPS1-01) official hardware specifications and orthographic CAD
  line drawings:
  - Main Seller Display & Stand (W x D x H): 317.5 x 127.0 x 254.0 mm (13.2 in / 337 mm diagonal),
    1.810 kg, matte space-graphite anodized aluminum unibody with R16 rounded corners, flush edge-to-edge
    black aluminosilicate cover glass, rear glossy Square emblem, concave-curved 174 mm-wide L-stand,
    stepped silicone foot pad, and under-chin 5-port USB / Ethernet hub bay.
  - Customer Payment Display (W x D x H): 174.0 x 174.0 x 44.0 mm (7.0 in / 178 mm diagonal),
    0.550 kg, R18 rounded-square slim sloped unibody with machined aluminum chamfer, tapered rear prop
    bar, raised chrome-rimmed pill EMV chip dip slot at the upper crest, contactless NFC tap zone on
    the lower bezel, and front-edge magstripe slot.
  - Contactless EMV/NFC payment card: ISO/IEC 7810 ID-1 (85.6 x 54.0 x 0.8 mm, R3.18 corners, 0.005 kg)
    resting on a low-profile dark silicone counter mat.

Metres, Z up, cashier front towards -Y, customer side towards +Y.
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
    cylinder,
    empty,
    finish,
    look_at,
    material,
)
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/square-register-2g"
NAME = "square-register-2g"

# Exact published envelopes (m)
MAIN_W = 0.3175
MAIN_D = 0.1270
MAIN_H = 0.2540

CUST_W = 0.1740
CUST_D = 0.1740
CUST_H = 0.0440

# Docked layout centered in Y:
# Main terminal Y in [-0.15050, -0.02350] (depth 0.1270 m)
# Customer display Y in [-0.02350, +0.15050] (depth 0.1740 m)
# Combined docked depth = 0.3010 m, width = 0.3175 m, height = 0.2540 m.
MAIN_Y_MIN = -0.15050
DOCK_SEAM_Y = -0.02350
CUST_Y_MAX = 0.15050

# Exact solved screen tilt geometry so 13.2 in (337 mm diag) operator head spans
# Y in [-0.15050, -0.02350] and Z_max = 0.25400 m with slim 12.0 mm unibody profile.
SCREEN_TILT_DEG = 34.4
SCREEN_THETA = math.radians(SCREEN_TILT_DEG)
SCREEN_T0 = -0.0060
SCREEN_T1 = 0.0060
SCREEN_PIVOT_Z = 0.1500
SCREEN_S1 = (MAIN_H - SCREEN_PIVOT_Z - SCREEN_T1 * math.sin(SCREEN_THETA)) / math.cos(SCREEN_THETA)
SCREEN_PIVOT_Y = DOCK_SEAM_Y - SCREEN_S1 * math.sin(SCREEN_THETA) + SCREEN_T0 * math.cos(SCREEN_THETA)
SCREEN_S0 = (MAIN_Y_MIN - SCREEN_PIVOT_Y + SCREEN_T1 * math.cos(SCREEN_THETA)) / math.sin(SCREEN_THETA)

SCREEN_PIVOT = (0.0, SCREEN_PIVOT_Y, SCREEN_PIVOT_Z)
CUSTOMER_ORIGIN = (0.0, 0.5 * (DOCK_SEAM_Y + CUST_Y_MAX), 0.5 * CUST_H)
# Tactile power/wake button tucked cleanly on right flank of 174 mm base deck
POWER_BTN_ORIGIN = (0.0858, -0.0840, 0.0086)

# Counter card holder mat & 6-DOF payment card tucked inside right-rear quadrant of 0.3175 x 0.3010 m footprint
CARD_W = 0.0540
CARD_L = 0.0856
CARD_H = 0.0008
CARD_PAD_TOP_Z = 0.0040
CARD_REST_POSE = (0.1240, 0.0700, CARD_PAD_TOP_Z + 0.5 * CARD_H)


FONT_5X7: dict[str, tuple[str, ...]] = {
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
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
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "¥": ("10001", "01010", "00100", "11111", "00100", "11111", "00100"),
    "$": ("00100", "01111", "10100", "01110", "00101", "11110", "00100"),
    ",": ("00000", "00000", "00000", "00000", "00110", "00100", "01000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
    ":": ("00000", "00110", "00110", "00000", "00110", "00110", "00000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "/": ("00001", "00010", "00100", "00100", "01000", "10000", "00000"),
    "#": ("01010", "11111", "01010", "01010", "11111", "01010", "00000"),
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    "^": ("00100", "01010", "10001", "00000", "00000", "00000", "00000"),
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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def draw_rect(
    buf: bytearray, w: int, h: int, x0: int, y0: int, x1: int, y1: int, rgba: tuple[int, int, int, int]
) -> None:
    c = bytes(rgba)
    xa, xb = max(0, x0), min(w, x1)
    if xa >= xb:
        return
    row_bytes = c * (xb - xa)
    for y in range(max(0, y0), min(h, y1)):
        off = (y * w + xa) * 4
        buf[off : off + (xb - xa) * 4] = row_bytes


def draw_rounded_rect(
    buf: bytearray,
    w: int,
    h: int,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    radius: int,
    rgba: tuple[int, int, int, int],
) -> None:
    r = max(0, min(radius, (x1 - x0) // 2, (y1 - y0) // 2))
    if r == 0:
        draw_rect(buf, w, h, x0, y0, x1, y1, rgba)
        return
    draw_rect(buf, w, h, x0 + r, y0, x1 - r, y1, rgba)
    draw_rect(buf, w, h, x0, y0 + r, x0 + r, y1 - r, rgba)
    draw_rect(buf, w, h, x1 - r, y0 + r, x1, y1 - r, rgba)
    r2 = r * r
    c = bytes(rgba)
    for dy in range(r):
        dx = int(math.isqrt(max(0, r2 - (r - 1 - dy) * (r - 1 - dy))))
        # top-left & top-right
        ty = y0 + dy
        if 0 <= ty < h:
            lx0, lx1 = max(0, x0 + r - dx), min(w, x0 + r)
            if lx0 < lx1:
                buf[(ty * w + lx0) * 4 : (ty * w + lx1) * 4] = c * (lx1 - lx0)
            rx0, rx1 = max(0, x1 - r), min(w, x1 - r + dx)
            if rx0 < rx1:
                buf[(ty * w + rx0) * 4 : (ty * w + rx1) * 4] = c * (rx1 - rx0)
        # bottom-left & bottom-right
        by = y1 - 1 - dy
        if 0 <= by < h:
            lx0, lx1 = max(0, x0 + r - dx), min(w, x0 + r)
            if lx0 < lx1:
                buf[(by * w + lx0) * 4 : (by * w + lx1) * 4] = c * (lx1 - lx0)
            rx0, rx1 = max(0, x1 - r), min(w, x1 - r + dx)
            if rx0 < rx1:
                buf[(by * w + rx0) * 4 : (by * w + rx1) * 4] = c * (rx1 - rx0)


def draw_circle(
    buf: bytearray, w: int, h: int, cx: int, cy: int, radius: int, rgba: tuple[int, int, int, int]
) -> None:
    r2 = radius * radius
    c = bytes(rgba)
    for y in range(max(0, cy - radius), min(h, cy + radius + 1)):
        dy = y - cy
        dx = int(math.isqrt(max(0, r2 - dy * dy)))
        xa, xb = max(0, cx - dx), min(w, cx + dx + 1)
        if xa < xb:
            buf[(y * w + xa) * 4 : (y * w + xb) * 4] = c * (xb - xa)


def draw_text(
    buf: bytearray,
    w: int,
    h: int,
    text: str,
    x: int,
    y: int,
    scale: int,
    rgba: tuple[int, int, int, int],
    align: str = "left",
    spacing: int = 1,
) -> None:
    step = (5 + spacing) * scale
    total_w = max(0, len(text) * step - spacing * scale)
    if align == "center":
        x0 = x - total_w // 2
    elif align == "right":
        x0 = x - total_w
    else:
        x0 = x
    for idx, ch in enumerate(text):
        rows = FONT_5X7.get(ch.upper(), FONT_5X7[" "])
        gx = x0 + idx * step
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit == "1":
                    draw_rect(
                        buf,
                        w,
                        h,
                        gx + rx * scale,
                        y + ry * scale,
                        gx + (rx + 1) * scale,
                        y + (ry + 1) * scale,
                        rgba,
                    )


def rounded_rect_loop(hx: float, hy: float, radius: float, segs: int = 10) -> list[tuple[float, float]]:
    r = min(radius, hx - 1e-5, hy - 1e-5)
    if r <= 1e-6:
        return [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    pts: list[tuple[float, float]] = []
    corners = (
        (hx - r, hy - r, 0.0, 0.5 * math.pi),
        (-hx + r, hy - r, 0.5 * math.pi, math.pi),
        (-hx + r, -hy + r, math.pi, 1.5 * math.pi),
        (hx - r, -hy + r, 1.5 * math.pi, 2.0 * math.pi),
    )
    for cx, cy, a0, a1 in corners:
        for i in range(segs + 1):
            ang = a0 + (a1 - a0) * (i / segs)
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def build_prism_from_sections(
    name: str,
    sections: list[list[Vector]],
    surf: bpy.types.Material,
    parent: bpy.types.Object,
    sharp_edges: bool = False,
) -> bpy.types.Object:
    bm = bmesh.new()
    rings: list[list[bmesh.types.BMVert]] = []
    for ring in sections:
        rings.append([bm.verts.new(p) for p in ring])
    n = len(rings[0])
    # Bottom cap (outward normal opposite section progression)
    bm.faces.new(list(reversed(rings[0])))
    # Side quads
    for r_i in range(len(rings) - 1):
        ra = rings[r_i]
        rb = rings[r_i + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([ra[i], ra[j], rb[j], rb[i]])
    # Top cap
    bm.faces.new(rings[-1])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(surf)
    obj.parent = parent
    return clean_mesh_object(obj, sharp_edges=sharp_edges)


def clean_mesh_object(obj: bpy.types.Object, sharp_edges: bool = False) -> bpy.types.Object:
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
    bm.to_mesh(obj.data)
    bm.free()
    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = not sharp_edges
    return obj


def make_textured_material(
    name: str,
    image: bpy.types.Image,
    metallic: float = 0.04,
    roughness: float = 0.08,
    emission: float = 0.28,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.diffuse_color = (0.88, 0.90, 0.94, 1.0)
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.16
    bsdf.inputs["Emission Strength"].default_value = emission
    mat["metallic"] = metallic
    mat["roughness"] = roughness
    mat["emission"] = emission
    return mat


def generate_operator_ui_texture(out_path: Path) -> bpy.types.Image:
    """Create a crisp 1024x640 Satyr Kitchen / Square Register POS UI texture matching Square Register."""
    w, h = 1024, 640
    buf = bytearray(w * h * 4)

    # Full light warm-white Square POS background (row 0 = top of image)
    draw_rect(buf, w, h, 0, 0, w, h, (246, 246, 248, 255))

    # Top narrow black Android/Square status bar (y = 0..24)
    draw_rect(buf, w, h, 0, 0, w, 24, (14, 15, 18, 255))
    draw_text(buf, w, h, "12:37", 18, 6, 2, (226, 230, 236, 255))
    draw_text(buf, w, h, "SATYR KITCHEN POS", 512, 6, 2, (168, 174, 184, 255), align="center")
    # Wi-Fi / connected status dots top-right
    draw_rounded_rect(buf, w, h, 964, 7, 1006, 17, 5, (42, 188, 96, 255))

    # Left workspace (x = 0..644) vs Right white order ticket panel (x = 645..1024)
    draw_rect(buf, w, h, 645, 24, w, h, (255, 255, 255, 255))
    draw_rect(buf, w, h, 644, 24, 646, h - 44, (226, 228, 233, 255))

    # Top category tabs in left pane ("KEYPAD   LIBRARY   FAVORITES")
    draw_rect(buf, w, h, 0, 24, 644, 68, (252, 252, 253, 255))
    draw_rect(buf, w, h, 0, 67, 644, 69, (230, 232, 236, 255))
    draw_text(buf, w, h, "KEYPAD", 28, 40, 2, (124, 128, 136, 255))
    draw_text(buf, w, h, "LIBRARY", 122, 40, 2, (124, 128, 136, 255))
    draw_text(buf, w, h, "FAVORITES", 232, 40, 2, (18, 20, 24, 255))
    draw_rect(buf, w, h, 230, 64, 344, 68, (18, 20, 24, 255))
    # Search magnifier icon
    draw_circle(buf, w, h, 598, 46, 7, (90, 94, 104, 255))
    draw_circle(buf, w, h, 598, 46, 4, (252, 252, 253, 255))

    # 5 columns x 4 rows of Square Register photo-style pastry & cafe tiles + 5th brown action row
    items = [
        ("CROISSANT", (206, 138, 62), "pastry"),
        ("PAIN CHOC", (152, 92, 46), "pastry"),
        ("CANELE", (116, 62, 34), "cup"),
        ("KOUIGN", (214, 152, 68), "pastry"),
        ("BERRY TART", (188, 54, 72), "tart"),
        ("FINANCIER", (198, 146, 76), "pastry"),
        ("MADELEINE", (222, 174, 92), "pastry"),
        ("ECLAIR", (104, 64, 42), "pastry"),
        ("PARIS BREST", (184, 132, 74), "tart"),
        ("MILLEFEUILLE", (196, 154, 104), "pastry"),
        ("ESPRESSO", (66, 42, 28), "cup"),
        ("CAFE LATTE", (174, 132, 92), "cup"),
        ("MATCHA", (78, 148, 76), "cup"),
        ("ICED LATTE", (156, 110, 68), "glass"),
        ("EARL GREY", (148, 84, 44), "cup"),
    ]
    margin_x = 24
    gap = 10
    tile_w = 112
    tile_h = 92
    for idx, (label, food_rgb, kind) in enumerate(items):
        col = idx % 5
        row = idx // 5
        tx = margin_x + col * (tile_w + gap)
        ty = 82 + row * (tile_h + gap)
        # Warm studio tabletop card background like Square's official Register UI
        draw_rounded_rect(buf, w, h, tx, ty, tx + tile_w, ty + tile_h, 8, (222, 220, 215, 255))
        # Subtle shadow + white ceramic plate in center
        cx, cy = tx + tile_w // 2, ty + 40
        draw_circle(buf, w, h, cx + 2, cy + 3, 29, (186, 183, 177, 255))
        draw_circle(buf, w, h, cx, cy, 28, (245, 243, 239, 255))
        draw_circle(buf, w, h, cx, cy, 21, (235, 232, 227, 255))
        fr, fg, fb = food_rgb
        if kind == "pastry":
            draw_rounded_rect(buf, w, h, cx - 18, cy - 10, cx + 18, cy + 10, 8, (fr, fg, fb, 255))
            draw_rounded_rect(buf, w, h, cx - 12, cy - 6, cx + 12, cy + 5, 5, (min(255, fr + 28), min(255, fg + 24), min(255, fb + 18), 255))
        elif kind == "tart":
            draw_circle(buf, w, h, cx, cy, 15, (196, 150, 88, 255))
            draw_circle(buf, w, h, cx, cy, 11, (fr, fg, fb, 255))
        elif kind == "glass":
            draw_rounded_rect(buf, w, h, cx - 10, cy - 16, cx + 10, cy + 16, 4, (fr, fg, fb, 255))
            draw_rect(buf, w, h, cx - 8, cy - 14, cx + 8, cy - 6, (238, 232, 224, 255))
        else:
            draw_circle(buf, w, h, cx, cy, 14, (250, 250, 250, 255))
            draw_circle(buf, w, h, cx, cy, 11, (fr, fg, fb, 255))
        # Dark translucent bottom label strip inside tile
        draw_rounded_rect(buf, w, h, tx + 4, ty + tile_h - 20, tx + tile_w - 4, ty + tile_h - 4, 4, (54, 52, 50, 255))
        draw_text(buf, w, h, label[:10], tx + 8, ty + tile_h - 15, 1, (246, 246, 246, 255))

    # Row 4: Square warm-bronze action tiles (DISCOUNT, GIFT BOX, REWARDS, BAG, CUSTOM)
    action_labels = ("DISCOUNT", "GIFT BOX", "REWARDS", "PASTRY BOX", "NOTES")
    ry4 = 82 + 3 * (tile_h + gap)
    for col, alabel in enumerate(action_labels):
        tx = margin_x + col * (tile_w + gap)
        tone = (168, 126, 84, 255) if col < 3 else (210, 213, 218, 255)
        fg_c = (250, 248, 244, 255) if col < 3 else (42, 46, 52, 255)
        draw_rounded_rect(buf, w, h, tx, ry4, tx + tile_w, ry4 + 78, 8, tone)
        draw_text(buf, w, h, alabel, tx + 10, ry4 + 56, 1, fg_c)

    # Right pane: Current sale ("4 ITEMS") + itemized lines + Subtotal/Tax/Total + dark pill Charge CTA
    draw_text(buf, w, h, "4 ITEMS", 672, 40, 2, (20, 22, 26, 255))
    draw_text(buf, w, h, "#204", 996, 40, 2, (132, 136, 146, 255), align="right")
    draw_rect(buf, w, h, 672, 68, 996, 70, (234, 236, 240, 255))

    ticket_lines = (
        ("CROISSANT", "BUTTER", "¥480"),
        ("PAIN AU CHOC", "VALRHONA", "¥540"),
        ("CANELE X 2", "BORDEAUX", "¥680"),
        ("MATCHA LATTE", "OAT MILK", "¥560"),
    )
    for r_i, (t_name, t_sub, t_price) in enumerate(ticket_lines):
        ly = 92 + r_i * 60
        draw_text(buf, w, h, t_name, 672, ly, 2, (24, 26, 32, 255))
        draw_text(buf, w, h, t_sub, 672, ly + 20, 1, (140, 145, 154, 255))
        draw_text(buf, w, h, t_price, 996, ly, 2, (24, 26, 32, 255), align="right")
        draw_rect(buf, w, h, 672, ly + 42, 996, ly + 43, (240, 242, 245, 255))

    # Totals block
    draw_text(buf, w, h, "SUBTOTAL", 672, 356, 2, (96, 102, 112, 255))
    draw_text(buf, w, h, "¥2,093", 996, 356, 2, (96, 102, 112, 255), align="right")
    draw_text(buf, w, h, "TAX 8%", 672, 386, 2, (96, 102, 112, 255))
    draw_text(buf, w, h, "¥167", 996, 386, 2, (96, 102, 112, 255), align="right")
    draw_rect(buf, w, h, 672, 414, 996, 416, (222, 226, 232, 255))
    draw_text(buf, w, h, "TOTAL", 672, 430, 2, (16, 18, 22, 255))
    draw_text(buf, w, h, "¥2,260", 996, 428, 3, (16, 18, 22, 255), align="right")

    # Signature Square Register dark pill Charge button
    draw_rounded_rect(buf, w, h, 672, 492, 996, 548, 26, (26, 28, 32, 255))
    draw_text(buf, w, h, "CHARGE ¥2,260", 834, 513, 2, (250, 251, 253, 255), align="center")

    # Bottom navigation bar across full width (y = 594..640)
    draw_rect(buf, w, h, 0, 594, w, h, (250, 250, 252, 255))
    draw_rect(buf, w, h, 0, 593, w, 595, (226, 228, 234, 255))
    draw_rounded_rect(buf, w, h, 276, 602, 384, 632, 8, (234, 236, 241, 255))
    draw_text(buf, w, h, "CHECKOUT", 330, 613, 1, (20, 22, 26, 255), align="center")
    draw_text(buf, w, h, "TRANSACTIONS", 442, 613, 1, (108, 112, 120, 255), align="center")
    draw_text(buf, w, h, "ORDERS", 548, 613, 1, (108, 112, 120, 255), align="center")
    draw_text(buf, w, h, "MORE", 626, 613, 1, (108, 112, 120, 255), align="center")

    write_rgba_png(out_path, w, h, bytes(buf))
    img = bpy.data.images.load(str(out_path), check_existing=True)
    img.pack()
    return img


def generate_customer_ui_texture(out_path: Path) -> bpy.types.Image:
    """Create a 768x768 full-cover-glass Customer Display texture matching Square Register."""
    s = 768
    buf = bytearray(s * s * 4)

    # Glossy jet-black aluminosilicate cover glass outer field
    draw_rect(buf, s, s, 0, 0, s, s, (8, 9, 12, 255))

    # White chip-card insert icon below the physical raised EMV pill boss (y ~ 112..142)
    draw_rounded_rect(buf, s, s, 366, 110, 402, 140, 4, (196, 202, 210, 255))
    draw_rounded_rect(buf, s, s, 369, 114, 399, 138, 2, (10, 12, 15, 255))
    draw_rect(buf, s, s, 379, 122, 389, 132, (196, 202, 210, 255))

    # Active 7.0-inch (154 x 88 mm inside 170 x 170 mm glass -> x = 52..716, y = 166..556)
    draw_rounded_rect(buf, s, s, 52, 166, 716, 556, 10, (22, 25, 31, 255))

    # Language pill at top-right of active 7.0 in screen ("EN / JP")
    draw_rounded_rect(buf, s, s, 588, 186, 692, 218, 15, (48, 53, 62, 255))
    draw_text(buf, s, s, "EN / JP", 640, 198, 1, (226, 230, 238, 255), align="center")

    # "^ INSERT" prompt pointing up toward physical EMV chip slot
    draw_text(buf, s, s, "^", 384, 188, 2, (182, 190, 202, 255), align="center")
    draw_text(buf, s, s, "INSERT", 384, 208, 2, (228, 232, 240, 255), align="center")

    # Prominent total + Satyr Kitchen order summary
    draw_text(buf, s, s, "SATYR KITCHEN", 384, 276, 2, (132, 140, 154, 255), align="center")
    draw_text(buf, s, s, "¥2,260", 384, 326, 7, (248, 250, 254, 255), align="center")
    draw_text(buf, s, s, "4 ITEMS  TAX INCL.", 384, 404, 2, (148, 156, 170, 255), align="center")

    # "TAP" + downward chevron pointing to NFC contactless zone on lower bezel
    draw_text(buf, s, s, "TAP", 384, 496, 2, (228, 232, 240, 255), align="center")
    draw_rect(buf, s, s, 378, 524, 384, 528, (182, 190, 202, 255))
    draw_rect(buf, s, s, 384, 524, 390, 528, (182, 190, 202, 255))
    draw_rect(buf, s, s, 381, 528, 387, 532, (182, 190, 202, 255))

    # Lower bezel white EMVCo contactless NFC oval + 4 radio wave arcs (centered at 384, 634)
    cx_nfc, cy_nfc = 384, 634
    for py in range(cy_nfc - 36, cy_nfc + 37):
        for px in range(cx_nfc - 52, cx_nfc + 53):
            nx = (px - cx_nfc) / 46.0
            ny = (py - cy_nfc) / 29.0
            d_oval = math.hypot(nx, ny)
            if 0.92 <= d_oval <= 1.00:
                off = (py * s + px) * 4
                buf[off : off + 4] = bytes((210, 215, 224, 255))
            # 4 concentric contactless arcs opening right
            w_dx = px - (cx_nfc - 16)
            w_dy = py - cy_nfc
            w_r = math.hypot(w_dx, w_dy)
            if w_dx > 2 and abs(w_dy) <= w_dx * 0.72:
                for arc_r in (9.0, 16.0, 23.0, 30.0):
                    if abs(w_r - arc_r) <= 1.45:
                        off = (py * s + px) * 4
                        buf[off : off + 4] = bytes((224, 228, 236, 255))

    write_rgba_png(out_path, s, s, bytes(buf))
    img = bpy.data.images.load(str(out_path), check_existing=True)
    img.pack()
    return img


def set_face_uv_planar(
    obj: bpy.types.Object,
    normal_target: Vector,
    u_vec: Vector,
    v_vec: Vector,
    u_span: tuple[float, float],
    v_span: tuple[float, float],
) -> None:
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    u0, u1 = u_span
    v0, v1 = v_span
    for poly in mesh.polygons:
        if poly.normal.dot(normal_target) > 0.72:
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                u = (co.dot(u_vec) - u0) / max(1e-9, (u1 - u0))
                v = (co.dot(v_vec) - v0) / max(1e-9, (v1 - v0))
                uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, v)))
        else:
            for loop_idx in poly.loop_indices:
                uv_layer[loop_idx].uv = (0.01, 0.01)


def surfaces(op_ui_img: bpy.types.Image, cust_ui_img: bpy.types.Image) -> dict[str, bpy.types.Material]:
    glass_bezel = material("SQ aluminosilicate black glass", (0.004, 0.005, 0.007, 1.0), 0.02, 0.14)
    bezel_bsdf = glass_bezel.node_tree.nodes.get("Principled BSDF")
    if bezel_bsdf and "Specular IOR Level" in bezel_bsdf.inputs:
        bezel_bsdf.inputs["Specular IOR Level"].default_value = 0.14
    return {
        # Authentic Square Register Matte Space-Graphite Anodized Aluminum
        "graphite_alu": material("SQ matte graphite anodized aluminum", (0.036, 0.038, 0.044, 1.0), 0.68, 0.36),
        "chamfer_alu": material("SQ diamond-cut aluminum rim", (0.110, 0.116, 0.128, 1.0), 0.86, 0.24),
        "chrome_ring": material("SQ polished EMV bezel chrome", (0.68, 0.71, 0.75, 1.0), 0.94, 0.14),
        "logo_gloss": material("SQ rear obsidian Square emblem", (0.008, 0.009, 0.012, 1.0), 0.10, 0.08),
        "glass_bezel": glass_bezel,
        "rubber": material("SQ matte black silicone foot", (0.012, 0.013, 0.016, 1.0), 0.0, 0.80),
        "port_dark": material("SQ recessed slot & USB cavity", (0.008, 0.009, 0.012, 1.0), 0.08, 0.58),
        "usb_port": material("SQ USB-A metallic port shell", (0.44, 0.46, 0.50, 1.0), 0.86, 0.26),
        "gold_pin": material("SQ EMV gold smartcard pad", (0.82, 0.65, 0.24, 1.0), 0.92, 0.22),
        "card_slate": material("SQ contactless card matte slate", (0.032, 0.044, 0.068, 1.0), 0.22, 0.30),
        "card_silver": material("SQ card contactless foil", (0.76, 0.79, 0.84, 1.0), 0.84, 0.22),
        "operator_ui": make_textured_material(
            "SQ 13.2in Satyr Kitchen POS UI", op_ui_img, metallic=0.0, roughness=0.14, emission=0.52
        ),
        "customer_ui": make_textured_material(
            "SQ 7.0in Customer Display Glass", cust_ui_img, metallic=0.0, roughness=0.12, emission=0.55
        ),
    }


def build_base_and_pedestal(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Build the authentic 174 mm-wide rounded-corner graphite base & concave-curved L-neck."""
    y_front_foot = -0.1340
    y_back_foot = DOCK_SEAM_Y - 0.0040
    foot_cy = 0.5 * (y_front_foot + y_back_foot)
    foot_hy = 0.5 * (y_back_foot - y_front_foot)

    # 1. Stepped inset non-slip black silicone base ring touching Z = 0.0000 m (visible step in CAD front view)
    foot_loop = rounded_rect_loop(0.0780, foot_hy - 0.0040, 0.0140, segs=8)
    rubber_ring = build_prism_from_sections(
        "Non-slip base rubber foot ring",
        [
            [Vector((x, foot_cy + y, 0.0000)) for x, y in foot_loop],
            [Vector((x, foot_cy + y, 0.0036)) for x, y in foot_loop],
        ],
        mat["rubber"],
        root,
        sharp_edges=True,
    )
    assert rubber_ring is not None

    # 2. 174 mm-wide rounded-corner anodized graphite base platform (rear edge flush at DOCK_SEAM_Y = -0.02350 m)
    deck_y0 = -0.1380
    deck_y1 = DOCK_SEAM_Y
    deck_cy = 0.5 * (deck_y0 + deck_y1)
    deck_hy = 0.5 * (deck_y1 - deck_y0)
    loop_b0 = rounded_rect_loop(0.0852, deck_hy - 0.0018, 0.0155, segs=10)
    loop_b1 = rounded_rect_loop(0.0870, deck_hy, 0.0170, segs=10)
    loop_b2 = rounded_rect_loop(0.0862, deck_hy - 0.0008, 0.0162, segs=10)
    base_deck = build_prism_from_sections(
        "Anodized aluminum base deck",
        [
            [Vector((x, deck_cy + y, 0.0032)) for x, y in loop_b0],
            [Vector((x, deck_cy + y, 0.0052)) for x, y in loop_b1],
            [Vector((x, deck_cy + y, 0.0124)) for x, y in loop_b1],
            [Vector((x, deck_cy + y, 0.0142)) for x, y in loop_b2],
        ],
        mat["graphite_alu"],
        root,
    )
    assert base_deck is not None

    # 3. Smooth concave-filleted L-neck sweeping up from base deck into the back of the Seller Display
    rear_hinge_y = SCREEN_PIVOT_Y - (SCREEN_T0 - 0.0035) * math.cos(SCREEN_THETA)
    neck_specs = (
        # (z, half_x, y_front, y_rear, corner_r)
        (0.0130, 0.0835, -0.0980, DOCK_SEAM_Y - 0.0020, 0.0140),
        (0.0185, 0.0825, -0.0800, DOCK_SEAM_Y - 0.0032, 0.0135),
        (0.0270, 0.0815, -0.0685, DOCK_SEAM_Y - 0.0052, 0.0130),
        (0.0420, 0.0805, -0.0620, DOCK_SEAM_Y - 0.0090, 0.0125),
        (0.0680, 0.0792, -0.0615, DOCK_SEAM_Y - 0.0155, 0.0120),
        (0.0980, 0.0780, -0.0660, DOCK_SEAM_Y - 0.0230, 0.0115),
        (0.1280, 0.0768, rear_hinge_y - 0.0160, rear_hinge_y + 0.0105, 0.0110),
        (0.1510, 0.0758, rear_hinge_y - 0.0120, rear_hinge_y + 0.0130, 0.0105),
    )
    neck_rings: list[list[Vector]] = []
    for nz, nhx, ny0, ny1, nr in neck_specs:
        ncy = 0.5 * (ny0 + ny1)
        nhy = 0.5 * (ny1 - ny0)
        lp = rounded_rect_loop(nhx, nhy, min(nr, nhy - 0.001), segs=8)
        neck_rings.append([Vector((x, ncy + y, nz)) for x, y in lp])
    pedestal = build_prism_from_sections(
        "Anodized aluminum wedge pedestal",
        neck_rings,
        mat["graphite_alu"],
        root,
    )
    assert pedestal is not None

    # 4. Integrated 5-port USB / Ethernet hub bay recessed at rear base dock edge
    hub_recess = box(
        "Integrated 5-port USB hub recess",
        (0.0, DOCK_SEAM_Y - 0.0080, 0.0084),
        (0.1180, 0.0140, 0.0064),
        mat["port_dark"],
        root,
        0.0006,
    )
    clean_mesh_object(hub_recess)
    for idx, px in enumerate((-0.042, -0.022, -0.002, 0.018, 0.040)):
        port = box(
            f"Accessory hub port {idx + 1}",
            (px, DOCK_SEAM_Y - 0.0022, 0.0084),
            (0.0110, 0.0036, 0.0042),
            mat["usb_port"],
            root,
            0.0,
        )
        clean_mesh_object(port, sharp_edges=True)

    # Concealed rear friction hinge barrel
    barrel = cylinder(
        "Operator screen friction hinge barrel",
        (0.0, rear_hinge_y + 0.0010, 0.1500),
        0.0065,
        0.1160,
        mat["chamfer_alu"],
        root,
        "X",
    )
    clean_mesh_object(barrel)

    # 5. Flush right-flank wake/power button (`sqreg_power_button`) inside 174 mm base rim
    pwr = empty("sqreg_power_button", POWER_BTN_ORIGIN, root)
    pwr["joint_type"] = "slide"
    pwr["axis_blender"] = "-X"
    pwr["range_m"] = [0.0, 0.002]
    pwr_cap = box(
        "Side power wake button cap",
        (0.0002, 0.0, 0.0),
        (0.0020, 0.0160, 0.0042),
        mat["chamfer_alu"],
        pwr,
        0.0004,
    )
    clean_mesh_object(pwr_cap)

    # 6. Sleek rounded-corner dark silicone counter mat (`sqreg_card_pad`) for 6-DOF payment card
    card_pad = empty("sqreg_card_pad", (CARD_REST_POSE[0], CARD_REST_POSE[1], 0.0), root)
    card_pad["role"] = "Countertop card rest pad; excluded when checking standalone operator-terminal-only bounds"
    pad_loop = rounded_rect_loop(0.0305, 0.0465, 0.0055, segs=6)
    build_prism_from_sections(
        "Counter NFC card rest pad",
        [
            [Vector((x, y, 0.0)) for x, y in pad_loop],
            [Vector((x, y, CARD_PAD_TOP_Z)) for x, y in pad_loop],
        ],
        mat["rubber"],
        card_pad,
        sharp_edges=True,
    )
    return pwr, card_pad


def build_operator_screen(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Build 13.2 in (337 mm diag) rounded-corner Seller Display matching Square Register."""
    screen = empty("sqreg_operator_screen", SCREEN_PIVOT, root)
    screen["joint_type"] = "hinge"
    screen["axis_blender"] = "+X"
    screen["range_rad"] = [-0.20, 0.35]

    u_up = Vector((0.0, math.sin(SCREEN_THETA), math.cos(SCREEN_THETA)))
    u_front = Vector((0.0, -math.cos(SCREEN_THETA), math.sin(SCREEN_THETA)))
    u_right = Vector((1.0, 0.0, 0.0))

    s_mid = 0.5 * (SCREEN_S0 + SCREEN_S1)
    s_half = 0.5 * (SCREEN_S1 - SCREEN_S0)
    hx = 0.5 * MAIN_W  # 0.15875 m

    # 1. Rounded-corner (R = 16 mm) matte space-graphite unibody housing spanning exact W=0.3175, [S0, S1], [T0, T1-0.0014]
    loop_back_in = rounded_rect_loop(hx - 0.0022, s_half - 0.0022, 0.0142, segs=12)
    loop_outer = rounded_rect_loop(hx, s_half, 0.0160, segs=12)
    unibody = build_prism_from_sections(
        "Operator 13.2in aluminum unibody back",
        [
            # Keep exact SCREEN_T0 at s_half interior while preserving exact S0..S1 and +-hx bounds!
            [x * u_right + (s_mid + s) * u_up + SCREEN_T0 * u_front for x, s in loop_outer],
            [x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0022) * u_front for x, s in loop_outer],
            [x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0012) * u_front for x, s in loop_back_in],
        ],
        mat["graphite_alu"],
        screen,
    )
    assert unibody is not None

    # Bright diamond-cut machined rim ring around front glass perimeter
    rim_outer = rounded_rect_loop(hx, s_half, 0.0160, segs=12)
    rim_inner = rounded_rect_loop(hx - 0.0014, s_half - 0.0014, 0.0148, segs=12)
    bm_rim = bmesh.new()
    ro_b = [bm_rim.verts.new(x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0020) * u_front) for x, s in rim_outer]
    ro_f = [bm_rim.verts.new(x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0002) * u_front) for x, s in rim_outer]
    ri_f = [bm_rim.verts.new(x * u_right + (s_mid + s) * u_up + SCREEN_T1 * u_front) for x, s in rim_inner]
    ri_b = [bm_rim.verts.new(x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0020) * u_front) for x, s in rim_inner]
    n_r = len(rim_outer)
    for i in range(n_r):
        j = (i + 1) % n_r
        bm_rim.faces.new([ro_b[i], ro_b[j], ro_f[j], ro_f[i]])
        bm_rim.faces.new([ro_f[i], ro_f[j], ri_f[j], ri_f[i]])
        bm_rim.faces.new([ri_f[i], ri_f[j], ri_b[j], ri_b[i]])
        bm_rim.faces.new([ri_b[i], ri_b[j], ro_b[j], ro_b[i]])
    rim_m = bpy.data.meshes.new("Operator machined rim chamfer")
    bm_rim.to_mesh(rim_m)
    bm_rim.free()
    rim_obj = bpy.data.objects.new("Operator machined rim chamfer", rim_m)
    bpy.context.scene.collection.objects.link(rim_obj)
    rim_obj.data.materials.append(mat["chamfer_alu"])
    rim_obj.parent = screen
    clean_mesh_object(rim_obj)

    # 2. Flush edge-to-edge black aluminosilicate cover glass frame around active 13.2 in LCD
    # Note: keep exact SCREEN_S0..SCREEN_S1 at SCREEN_T1 via rim_inner + glass outer loop!
    glass_outer = rounded_rect_loop(hx - 0.0014, s_half - 0.0014, 0.0148, segs=12)
    # Also ensure exact SCREEN_S0 and SCREEN_S1 at SCREEN_T1 by placing glass_outer right to s_half, hx - 0.0002
    glass_exact = rounded_rect_loop(hx - 0.0002, s_half, 0.0158, segs=12)
    lcd_hx = 0.1435  # 287 mm wide x 176 mm tall -> 336.6 mm (13.25 in) diagonal!
    lcd_sh = s_half - 0.0135
    lcd_loop = rounded_rect_loop(lcd_hx, lcd_sh, 0.0040, segs=12)

    bm_g = bmesh.new()
    go_f = [bm_g.verts.new(x * u_right + (s_mid + s) * u_up + SCREEN_T1 * u_front) for x, s in glass_exact]
    go_b = [bm_g.verts.new(x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0014) * u_front) for x, s in glass_outer]
    gi_f = [bm_g.verts.new(x * u_right + (s_mid + s) * u_up + SCREEN_T1 * u_front) for x, s in lcd_loop]
    gi_b = [bm_g.verts.new(x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0014) * u_front) for x, s in lcd_loop]
    ng = len(glass_exact)
    for i in range(ng):
        j = (i + 1) % ng
        bm_g.faces.new([go_b[i], go_b[j], go_f[j], go_f[i]])
        bm_g.faces.new([go_f[i], go_f[j], gi_f[j], gi_f[i]])
        bm_g.faces.new([gi_f[i], gi_f[j], gi_b[j], gi_b[i]])
        bm_g.faces.new([gi_b[i], gi_b[j], go_b[j], go_b[i]])
    gm = bpy.data.meshes.new("Operator 13.2in cover glass bezel")
    bm_g.to_mesh(gm)
    bm_g.free()
    g_obj = bpy.data.objects.new("Operator 13.2in cover glass bezel", gm)
    bpy.context.scene.collection.objects.link(g_obj)
    g_obj.data.materials.append(mat["glass_bezel"])
    g_obj.parent = screen
    clean_mesh_object(g_obj, sharp_edges=True)

    # 3. Active 13.2 in Satyr Kitchen / Square POS touchscreen panel
    lcd = build_prism_from_sections(
        "Operator 13.2in CafeOS touchscreen",
        [
            [x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0014) * u_front for x, s in lcd_loop],
            [x * u_right + (s_mid + s) * u_up + (SCREEN_T1 - 0.0001) * u_front for x, s in lcd_loop],
        ],
        mat["operator_ui"],
        screen,
        sharp_edges=True,
    )
    set_face_uv_planar(lcd, u_front, u_right, u_up, (-lcd_hx, lcd_hx), (s_mid - lcd_sh, s_mid + lcd_sh))

    # 4. Under-chin centered accessory cable cover detail + two bottom-right trim slits (per Square CAD front drawing)
    chin_bar = build_prism_from_sections(
        "Operator under-chin accessory cover",
        [
            [
                x * u_right + (SCREEN_S0 + 0.0004) * u_up + t * u_front
                for x, t in rounded_rect_loop(0.0380, 0.0032, 0.0012, segs=4)
            ],
            [
                x * u_right + (SCREEN_S0 + 0.0028) * u_up + t * u_front
                for x, t in rounded_rect_loop(0.0380, 0.0032, 0.0012, segs=4)
            ],
        ],
        mat["chamfer_alu"],
        screen,
        sharp_edges=True,
    )
    assert chin_bar is not None

    # 5. Glossy obsidian Square emblem inlaid on upper-center rear backplate (`sqreg_pricing.png`)
    logo_s = s_mid + 0.0340
    logo_outer = rounded_rect_loop(0.0215, 0.0215, 0.0048, segs=6)
    logo_cut = rounded_rect_loop(0.0135, 0.0135, 0.0026, segs=6)
    bm_l = bmesh.new()
    lo_b = [bm_l.verts.new(x * u_right + (logo_s + s) * u_up + (SCREEN_T0 + 0.0006) * u_front) for x, s in logo_outer]
    lo_r = [bm_l.verts.new(x * u_right + (logo_s + s) * u_up + (SCREEN_T0 - 0.00015) * u_front) for x, s in logo_outer]
    li_r = [bm_l.verts.new(x * u_right + (logo_s + s) * u_up + (SCREEN_T0 - 0.00015) * u_front) for x, s in logo_cut]
    li_b = [bm_l.verts.new(x * u_right + (logo_s + s) * u_up + (SCREEN_T0 + 0.0006) * u_front) for x, s in logo_cut]
    nl = len(logo_outer)
    for i in range(nl):
        j = (i + 1) % nl
        bm_l.faces.new([lo_b[i], lo_b[j], lo_r[j], lo_r[i]])
        bm_l.faces.new([lo_r[i], lo_r[j], li_r[j], li_r[i]])
        bm_l.faces.new([li_r[i], li_r[j], li_b[j], li_b[i]])
        bm_l.faces.new([li_b[i], li_b[j], lo_b[j], lo_b[i]])
    lm = bpy.data.meshes.new("Operator rear Square emblem ring")
    bm_l.to_mesh(lm)
    bm_l.free()
    l_obj = bpy.data.objects.new("Operator rear Square emblem ring", lm)
    bpy.context.scene.collection.objects.link(l_obj)
    l_obj.data.materials.append(mat["logo_gloss"])
    l_obj.parent = screen
    clean_mesh_object(l_obj, sharp_edges=True)

    logo_dot = rounded_rect_loop(0.0058, 0.0058, 0.0012, segs=4)
    build_prism_from_sections(
        "Operator rear Square emblem center",
        [
            [x * u_right + (logo_s + s) * u_up + (SCREEN_T0 - 0.00015) * u_front for x, s in logo_dot],
            [x * u_right + (logo_s + s) * u_up + (SCREEN_T0 + 0.0006) * u_front for x, s in logo_dot],
        ],
        mat["logo_gloss"],
        screen,
        sharp_edges=True,
    )
    return screen


def build_customer_display(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Build 174 x 174 x 44 mm rounded-square Customer Display with slim sloped body, rear prop bar, and raised EMV pill."""
    cust = empty("sqreg_customer_display", CUSTOMER_ORIGIN, root)
    cust["joint_type"] = "slide"
    cust["axis_blender"] = "+Y"
    cust["range_m"] = [0.0, 0.180]

    hx = 0.5 * CUST_W   # 0.0870 m
    hy = 0.5 * CUST_D   # 0.0870 m
    z0 = -0.5 * CUST_H  # -0.0220 m -> world Z = 0.0000 m
    z_top = 0.5 * CUST_H  # +0.0220 m -> world Z = 0.0440 m

    # Slope equation across y in [-hy, +hy]:
    # At y = -hy (elevated crest near seller): top glass z = z_top - 0.0018 (+0.0202 -> world 42.2 mm)
    # At y = +hy (low front lip near customer): top glass z = z0 + 0.0112 (-0.0108 -> world 11.2 mm)
    # Slim 9.8 mm housing thickness so open arch underneath matches Square CAD side view!
    za = z_top - 0.0018
    zb = z0 + 0.0112
    slab_dz = 0.0098

    def z_glass(y_val: float) -> float:
        t = (y_val + hy) / (2.0 * hy)
        return za + t * (zb - za)

    # 1. Rear tapered prop leg + silicone foot pad AND front anti-slip lip touching world Z = 0.0000 m
    prop_loop_bot = rounded_rect_loop(0.0650, 0.0095, 0.0065, segs=6)
    prop_loop_top = rounded_rect_loop(0.0680, 0.0125, 0.0080, segs=6)
    prop_cy = -0.0650
    build_prism_from_sections(
        "Customer display non-slip rubber base",
        [
            [Vector((x, prop_cy + y, z0)) for x, y in prop_loop_bot],
            [Vector((x, prop_cy + y, z0 + 0.0020)) for x, y in prop_loop_bot],
        ],
        mat["rubber"],
        cust,
        sharp_edges=True,
    )
    build_prism_from_sections(
        "Customer display rear prop bar",
        [
            [Vector((x, prop_cy + y, z0 + 0.0018)) for x, y in prop_loop_bot],
            [Vector((x, prop_cy + y, z_glass(prop_cy + y) - slab_dz + 0.0025)) for x, y in prop_loop_top],
        ],
        mat["graphite_alu"],
        cust,
    )

    front_lip_loop = rounded_rect_loop(0.0640, 0.0045, 0.0030, segs=5)
    front_lip_cy = hy - 0.0115
    build_prism_from_sections(
        "Customer display front silicone lip",
        [
            [Vector((x, front_lip_cy + y, z0)) for x, y in front_lip_loop],
            [Vector((x, front_lip_cy + y, z_glass(front_lip_cy + y) - slab_dz + 0.0016)) for x, y in front_lip_loop],
        ],
        mat["rubber"],
        cust,
        sharp_edges=True,
    )

    # 2. Slim R18 rounded-square sloped matte-graphite unibody chassis (exact 174.0 x 174.0 mm planform!)
    c_loop_bot = rounded_rect_loop(hx - 0.0014, hy - 0.0014, 0.0168, segs=12)
    c_loop_out = rounded_rect_loop(hx, hy, 0.0180, segs=12)
    c_loop_rim = rounded_rect_loop(hx - 0.0015, hy - 0.0015, 0.0166, segs=12)
    wedge = build_prism_from_sections(
        "Customer display wedge chassis",
        [
            [Vector((x, y, z_glass(y) - slab_dz)) for x, y in c_loop_bot],
            [Vector((x, y, z_glass(y) - slab_dz + 0.0016)) for x, y in c_loop_out],
            [Vector((x, y, z_glass(y) - 0.0012)) for x, y in c_loop_out],
            [Vector((x, y, z_glass(y) - 0.0003)) for x, y in c_loop_rim],
        ],
        mat["graphite_alu"],
        cust,
    )
    assert wedge is not None

    # Bright diamond-cut machined chamfer around Customer Display cover glass
    bm_cr = bmesh.new()
    cro_b = [bm_cr.verts.new((x, y, z_glass(y) - 0.0013)) for x, y in c_loop_out]
    cro_t = [bm_cr.verts.new((x, y, z_glass(y) - 0.0001)) for x, y in c_loop_out]
    cri_t = [bm_cr.verts.new((x, y, z_glass(y) + 0.00005)) for x, y in c_loop_rim]
    cri_b = [bm_cr.verts.new((x, y, z_glass(y) - 0.0013)) for x, y in c_loop_rim]
    nc = len(c_loop_out)
    for i in range(nc):
        j = (i + 1) % nc
        bm_cr.faces.new([cro_b[i], cro_b[j], cro_t[j], cro_t[i]])
        bm_cr.faces.new([cro_t[i], cro_t[j], cri_t[j], cri_t[i]])
        bm_cr.faces.new([cri_t[i], cri_t[j], cri_b[j], cri_b[i]])
        bm_cr.faces.new([cri_b[i], cri_b[j], cro_b[j], cro_b[i]])
    crm = bpy.data.meshes.new("Customer display machined chamfer")
    bm_cr.to_mesh(crm)
    bm_cr.free()
    cr_obj = bpy.data.objects.new("Customer display machined chamfer", crm)
    bpy.context.scene.collection.objects.link(cr_obj)
    cr_obj.data.materials.append(mat["chamfer_alu"])
    cr_obj.parent = cust
    clean_mesh_object(cr_obj)

    # 3. Flush R16.6 rounded-square cover glass carrying 7.0 in UI + contactless NFC tap emblem
    c_glass_loop = rounded_rect_loop(hx - 0.0015, hy - 0.0015, 0.0166, segs=12)
    c_lcd = build_prism_from_sections(
        "Customer 7.0in touchscreen & NFC tap UI",
        [
            [Vector((x, y, z_glass(y) - 0.0012)) for x, y in c_glass_loop],
            [Vector((x, y, z_glass(y))) for x, y in c_glass_loop],
        ],
        mat["customer_ui"],
        cust,
        sharp_edges=True,
    )
    slope_vec = Vector((0.0, 2.0 * hy, zb - za))
    u_n = Vector((0.0, -(zb - za), 2.0 * hy)).normalized()
    # Customer standing at +Y looks toward -Y: right-hand X in view is -X, upward in view is -Y!
    set_face_uv_planar(
        c_lcd,
        u_n,
        Vector((-1.0, 0.0, 0.0)),
        Vector((0.0, -1.0, 0.0)),
        (-(hx - 0.0015), hx - 0.0015),
        (-(hy - 0.0015), hy - 0.0015),
    )
    assert slope_vec.length > 0.1

    # 4. Raised chrome-rimmed pill EMV chip-card dip boss near -Y crest reaching exact z = z_top (+0.0220 -> world 44.0 mm!)
    emv_cy = -0.0680
    pill_chrome = rounded_rect_loop(0.0320, 0.0062, 0.0060, segs=8)
    pill_boss = rounded_rect_loop(0.0298, 0.0046, 0.0045, segs=8)
    pill_slot = rounded_rect_loop(0.0260, 0.0014, 0.0012, segs=6)

    build_prism_from_sections(
        "Customer EMV chrome bezel ring",
        [
            [Vector((x, emv_cy + y, z_glass(emv_cy + y) - 0.0002)) for x, y in pill_chrome],
            [Vector((x, emv_cy + y, z_glass(emv_cy + y) + 0.0010)) for x, y in pill_chrome],
        ],
        mat["chrome_ring"],
        cust,
    )
    # Raised glossy black pill boss whose top touches exact z_top = +0.02200 m (world Z = 0.04400 m)
    build_prism_from_sections(
        "Customer EMV raised pill boss",
        [
            [Vector((x, emv_cy + y, z_glass(emv_cy + y) + 0.0004)) for x, y in pill_boss],
            [Vector((x, emv_cy + y, z_top)) for x, y in pill_boss],
        ],
        mat["logo_gloss"],
        cust,
        sharp_edges=True,
    )
    emv_slot = build_prism_from_sections(
        "Customer EMV IC chip insertion slot",
        [
            [Vector((x, emv_cy + y, z_top - 0.0014)) for x, y in pill_slot],
            [Vector((x, emv_cy + y, z_top + 0.00002)) for x, y in pill_slot],
        ],
        mat["port_dark"],
        cust,
        sharp_edges=True,
    )
    assert emv_slot is not None

    # 5. Front-edge (+Y) magstripe swipe seam + center vertical tick (visible in `sqreg_specs.png`)
    mag_seam = box(
        "Customer front magstripe slot seam",
        (0.0, hy - 0.0005, 0.5 * ((z_glass(hy) - slab_dz) + z_glass(hy)) - 0.0008),
        (0.1180, 0.0009, 0.0012),
        mat["port_dark"],
        cust,
        0.0,
    )
    clean_mesh_object(mag_seam, sharp_edges=True)
    return cust


def build_payment_card(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Build R3.18 rounded-corner 85.6 x 54.0 x 0.8 mm EMV/NFC contactless payment card."""
    card = empty("sqreg_payment_card", CARD_REST_POSE, root)
    card["accessory_role"] = "ISO/IEC 7810 ID-1 contactless EMV payment card (0.005 kg)"

    c_loop = rounded_rect_loop(0.5 * CARD_W, 0.5 * CARD_L, 0.00318, segs=8)
    build_prism_from_sections(
        "Contactless EMV payment card body",
        [
            [Vector((x, y, -0.00032)) for x, y in c_loop],
            [Vector((x, y, 0.00032)) for x, y in c_loop],
        ],
        mat["card_slate"],
        card,
        sharp_edges=True,
    )

    chip_loop = rounded_rect_loop(0.0058, 0.0048, 0.0012, segs=4)
    build_prism_from_sections(
        "EMV IC gold smartcard chip",
        [
            [Vector((-0.0115 + x, -0.0220 + y, -0.5 * CARD_H)) for x, y in chip_loop],
            [Vector((-0.0115 + x, -0.0220 + y, 0.5 * CARD_H)) for x, y in chip_loop],
        ],
        mat["gold_pin"],
        card,
        sharp_edges=True,
    )

    foil_loop = rounded_rect_loop(0.0085, 0.0052, 0.0012, segs=4)
    build_prism_from_sections(
        "Card metallic foil accent",
        [
            [Vector((0.0135 + x, 0.0265 + y, 0.00010)) for x, y in foil_loop],
            [Vector((0.0135 + x, 0.0265 + y, 0.00038)) for x, y in foil_loop],
        ],
        mat["card_silver"],
        card,
        sharp_edges=True,
    )

    socket = empty("vessel_socket", (0.0, 0.0100, 0.0), card)
    socket["site_role"] = "Payment card grasp & NFC tap socket"
    return card


def animate_timeline(
    screen: bpy.types.Object,
    cust: bpy.types.Object,
    pwr: bpy.types.Object,
    card: bpy.types.Object,
) -> None:
    # Frame 1..20: Docked rest pose, card resting on counter NFC card pad
    # Frame 55..85: Active transaction pose — screen tilted +12 deg, customer display undocked +125 mm rearward,
    #               payment card poised cleanly over the lower-bezel NFC tap emblem parallel to the 10.2 deg slope!
    # Frame 120: Restored to docked rest pose
    tap_pose = (0.0, CUSTOMER_ORIGIN[1] + 0.125 + 0.042, 0.0295)
    keyframes = (
        (1, 0.0, 0.0, 0.0, CARD_REST_POSE, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, CARD_REST_POSE, (0.0, 0.0, 0.0)),
        (55, 0.20, 0.125, -0.0015, tap_pose, (math.radians(-10.2), 0.0, math.radians(14.0))),
        (85, 0.20, 0.125, 0.0, tap_pose, (math.radians(-10.2), 0.0, math.radians(14.0))),
        (120, 0.0, 0.0, 0.0, CARD_REST_POSE, (0.0, 0.0, 0.0)),
    )
    for fno, tilt_rx, undock_dy, pwr_dx, c_loc, c_rot in keyframes:
        screen.rotation_euler = (tilt_rx, 0.0, 0.0)
        screen.keyframe_insert(data_path="rotation_euler", frame=fno)

        cust.location = (CUSTOMER_ORIGIN[0], CUSTOMER_ORIGIN[1] + undock_dy, CUSTOMER_ORIGIN[2])
        cust.keyframe_insert(data_path="location", frame=fno)

        pwr.location = (POWER_BTN_ORIGIN[0] + pwr_dx, POWER_BTN_ORIGIN[1], POWER_BTN_ORIGIN[2])
        pwr.keyframe_insert(data_path="location", frame=fno)

        card.location = c_loc
        card.rotation_euler = c_rot
        card.keyframe_insert(data_path="location", frame=fno)
        card.keyframe_insert(data_path="rotation_euler", frame=fno)


def clear_all_animations(root: bpy.types.Object) -> None:
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()


def export_glb_at_rest(root: bpy.types.Object, glb_path: Path) -> None:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    clear_all_animations(root)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def setup_studio(scene: bpy.types.Scene) -> bpy.types.Object:
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "METAL"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100

    scene.world = bpy.data.worlds.new("Square Register Studio World")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.70, 0.72, 0.76, 1.0)
    bg.inputs["Strength"].default_value = 0.58
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.05

    ground = material("Studio counter porcelain", (0.52, 0.54, 0.57, 1.0), metallic=0.0, roughness=0.82, emission=0.0)
    bpy.ops.mesh.primitive_plane_add(size=100.0, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio ground"
    floor.data.materials.append(ground)

    area_light("Key softbox", (-0.80, -1.05, 1.10), (0.0, -0.02, 0.11), 150.0, 1.05)
    area_light("Fill stripbox", (0.92, -0.42, 0.88), (0.0, 0.0, 0.10), 105.0, 0.90)
    area_light("Customer rim softbox", (0.15, 1.12, 1.05), (0.0, 0.05, 0.08), 135.0, 0.95)

    cam_data = bpy.data.cameras.new("Review camera")
    cam_data.type = "ORTHO"
    camera = bpy.data.objects.new("Review camera", cam_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    studio_col = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(studio_col)
    for obj in set(scene.objects) - before:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        studio_col.objects.link(obj)
    return camera


def compute_mesh_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector, Vector]:
    bpy.context.view_layer.update()
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            wv = mw @ v.co
            for i in range(3):
                mins[i] = min(mins[i], wv[i])
                maxs[i] = max(maxs[i], wv[i])
    return mins, maxs, maxs - mins


def verify_and_write_inspection_report(glb_path: Path) -> dict:
    """Re-import exported GLB into a clean Blender factory scene and run full geometric & mesh-quality checks."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objs = bpy.data.objects

    root = objs["sqreg_base"]
    screen = objs["sqreg_operator_screen"]
    cust = objs["sqreg_customer_display"]
    pwr = objs["sqreg_power_button"]
    card = objs["sqreg_payment_card"]
    card_pad = objs["sqreg_card_pad"]
    socket = objs["vessel_socket"]

    assert screen.parent == root
    assert cust.parent == root
    assert pwr.parent == root
    assert card.parent == root
    assert socket.parent == card
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objs)

    # 1. Verify standalone main operator terminal bounds: 0.3175 x 0.1270 x 0.2540 m
    excl_main = {
        cust,
        *cust.children_recursive,
        card,
        *card.children_recursive,
        card_pad,
        *card_pad.children_recursive,
    }
    main_min, main_max, main_dim = compute_mesh_bounds(
        [o for o in root.children_recursive if o not in excl_main]
    )
    for actual, expected, label in zip(
        main_dim, (MAIN_W, MAIN_D, MAIN_H), ("Main W", "Main D", "Main H")
    ):
        assert abs(actual - expected) < 0.0005, (label, actual, expected)
    assert abs(main_min.z - 0.0) < 0.0002, main_min.z
    assert abs(main_max.z - MAIN_H) < 0.0005, main_max.z

    # 2. Verify customer payment display bounds: 0.1740 x 0.1740 x 0.0440 m
    cust_min, cust_max, cust_dim = compute_mesh_bounds(list(cust.children_recursive))
    for actual, expected, label in zip(
        cust_dim, (CUST_W, CUST_D, CUST_H), ("Cust W", "Cust D", "Cust H")
    ):
        assert abs(actual - expected) < 0.0005, (label, actual, expected)
    assert abs(cust_min.z - 0.0) < 0.0002, cust_min.z
    assert abs(cust_max.z - CUST_H) < 0.0005, cust_max.z

    # 3. Verify payment card bounds: 0.0540 x 0.0856 x 0.0008 m
    _cmin, _cmax, card_dim = compute_mesh_bounds(list(card.children_recursive))
    assert abs(card_dim.x - CARD_W) < 0.0002, card_dim
    assert abs(card_dim.y - CARD_L) < 0.0002, card_dim
    assert abs(card_dim.z - CARD_H) < 0.0002, card_dim

    # 4. Combined docked POS envelope: 0.3175 x 0.3010 x 0.2540 m
    comb_min, comb_max, comb_dim = compute_mesh_bounds(list(root.children_recursive))
    assert abs(comb_dim.x - 0.3175) < 0.0005, comb_dim
    assert abs(comb_dim.y - 0.3010) < 0.0005, comb_dim
    assert abs(comb_dim.z - 0.2540) < 0.0005, comb_dim

    # 5. Fault-injection guard check: perturbing customer display width/location must trip bounds check
    orig_cust_x = cust.location.x
    cust.location.x += 0.095
    bpy.context.view_layer.update()
    _, _, perturbed_dim = compute_mesh_bounds(list(root.children_recursive))
    fault_detected = abs(perturbed_dim.x - 0.3175) > 0.005
    cust.location.x = orig_cust_x
    bpy.context.view_layer.update()
    assert fault_detected

    required_meshes = {
        "Non-slip base rubber foot ring",
        "Anodized aluminum base deck",
        "Integrated 5-port USB hub recess",
        "Anodized aluminum wedge pedestal",
        "Operator 13.2in aluminum unibody back",
        "Operator 13.2in cover glass bezel",
        "Operator 13.2in CafeOS touchscreen",
        "Operator rear Square emblem ring",
        "Customer display non-slip rubber base",
        "Customer display rear prop bar",
        "Customer display wedge chassis",
        "Customer 7.0in touchscreen & NFC tap UI",
        "Customer EMV raised pill boss",
        "Customer EMV IC chip insertion slot",
        "Side power wake button cap",
        "Contactless EMV payment card body",
        "EMV IC gold smartcard chip",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "main_terminal_dimensions_m": [round(v, 6) for v in main_dim],
        "customer_display_dimensions_m": [round(v, 6) for v in cust_dim],
        "combined_docked_dimensions_m": [round(v, 6) for v in comb_dim],
        "combined_bounds_min_m": [round(v, 6) for v in comb_min],
        "combined_bounds_max_m": [round(v, 6) for v in comb_max],
        "payment_card_dimensions_m": [round(v, 6) for v in card_dim],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported square-register-2g.glb; verify 317.5x127.0x254.0 mm main operator terminal "
            "with R16 rounded-corner space-graphite unibody and 174 mm curved stand, 174.0x174.0x44.0 mm "
            "R18 sloped customer display with rear prop bar and raised EMV pill slot, 317.5x301.0x254.0 mm "
            "combined docked footprint on Z=0.000 m, 85.6x54.0x0.8 mm contactless EMV card, embedded "
            "Satyr Kitchen POS UI textures, fault-injection rejection, and zero mesh-quality errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Square Register (2nd Generation, SPS1-01)"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    op_ui_img = generate_operator_ui_texture(ASSETS / "cafeos-order-ui.png")
    cust_ui_img = generate_customer_ui_texture(ASSETS / "customer-tap-ui.png")
    mat = surfaces(op_ui_img, cust_ui_img)

    for m in bpy.data.materials:
        if "metallic" not in m:
            m["metallic"] = 0.0
        if "roughness" not in m:
            m["roughness"] = 0.4
        if "emission" not in m:
            m["emission"] = 0.0

    root = empty("sqreg_base", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Block, Inc. (Square)"
    root["model"] = "Square Register (2nd Generation, SPS1-01)"
    root["main_terminal_dimensions_m"] = [MAIN_W, MAIN_D, MAIN_H]
    root["customer_display_dimensions_m"] = [CUST_W, CUST_D, CUST_H]
    root["published_pos_mass_kg"] = 2.360
    root["payment_card_mass_kg"] = 0.005

    pwr, _card_pad = build_base_and_pedestal(root, mat)
    screen = build_operator_screen(root, mat)
    cust = build_customer_display(root, mat)
    card = build_payment_card(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, screen, cust, pwr, card])

    glb_path = ASSETS / f"{NAME}.glb"
    export_glb_at_rest(root, glb_path)

    animate_timeline(screen, cust, pwr, card)

    appliance_col = bpy.data.collections.new("Square Register 2G")
    scene.collection.children.link(appliance_col)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        appliance_col.objects.link(obj)

    camera = setup_studio(scene)
    for m in bpy.data.materials:
        if "metallic" not in m:
            m["metallic"] = 0.0
        if "roughness" not in m:
            m["roughness"] = 0.82
        if "emission" not in m:
            m["emission"] = 0.0

    views = (
        ("studio-main.png", (0.56, -0.78, 0.46), (0.0, -0.01, 0.115), 0.46, 1),
        ("studio-front.png", (0.0, -0.95, 0.135), (0.0, -0.02, 0.120), 0.41, 1),
        ("studio-right.png", (0.95, 0.01, 0.15), (0.0, 0.01, 0.115), 0.44, 1),
        ("studio-active.png", (-0.52, 0.88, 0.50), (0.0, 0.07, 0.095), 0.52, 70),
    )
    rendered = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            camera.location = pos
            camera.data.ortho_scale = scale
            look_at(camera, target)
            scene.render.filepath = str(ASSETS / vname)
            bpy.ops.render.render(write_still=True)
            rendered.append(vname)

    scene.frame_set(1)
    camera.location = views[0][1]
    camera.data.ortho_scale = views[0][3]
    look_at(camera, views[0][2])

    comb_min, comb_max, comb_dim = compute_mesh_bounds(list(root.children_recursive))
    blend_path = ASSETS / f"{NAME}.blend"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    build_report = {
        "asset": NAME,
        "model": "Square Register (2nd Generation, SPS1-01)",
        "blender_version": bpy.app.version_string,
        "main_terminal_envelope_m": [MAIN_W, MAIN_D, MAIN_H],
        "customer_display_envelope_m": [CUST_W, CUST_D, CUST_H],
        "combined_docked_envelope_m": [round(v, 6) for v in comb_dim],
        "bounds_min_m": [round(v, 6) for v in comb_min],
        "bounds_max_m": [round(v, 6) for v in comb_max],
        "operator_terminal_mass_kg": 1.810,
        "customer_display_mass_kg": 0.550,
        "combined_pos_mass_kg": 2.360,
        "payment_card_mass_kg": 0.005,
        "renders": rendered,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blend_sha256": hashlib.sha256(blend_path.read_bytes()).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    insp = verify_and_write_inspection_report(glb_path)
    print(json.dumps({"build": build_report, "inspection": insp}, indent=2))


if __name__ == "__main__":
    main()
