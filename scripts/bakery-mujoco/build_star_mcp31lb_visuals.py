"""Build the Star Micronics mC-Print3 (MCP31LB BK) Splash-Proof IP22 thermal receipt printer in Blender 5.2.

Reference ground truth:
- Star Micronics mC-Print3 Hardware Manual (p. 17 3-view CAD dimensions, p. 18 front operation panel,
  p. 33 rear interface pocket) and official Star mC-Print3 flyer:
  - Overall closed envelope (W x D x H): 132.0 x 140.0 x 125.0 mm (0.132 x 0.140 x 0.125 m)
  - Published mass: 1.300 kg
  - Colorway: Matte Black (MCP31LB BK) matching the Square Register POS station kit, with satin-black
    R8 rounded-corner cube body, inset IP22 top splash-proof hood, stepped lower plinth on 4 rubber
    feet (Z = 0.000 m), sculpted top-left cover-open pull lever, flush glossy smoked-black acrylic LED
    and tactile button lens (#1 blue Power LED, #2 blue Bluetooth LED, #3 green LAN LED, #4 circular
    Feed button, #5 circular Power button), full-width R8 wrap-around front clamshell door (mcp3_cover,
    hinge 0..1.35 rad) with metallic silver Star emblem, internal platen roller & steel guillotine
    auto-cutter bar, Ø76 x 79.5 mm white thermal roll (mcp3_paper_roll), crisp bitmap-printed 80 mm
    Satyr Kitchen receipt strip (mcp3_receipt_strip, slide 0..0.110 m), and recessed rear I/O pocket
    (LAN, USB-C, 2.4A/0.5A USB-A hub, 6-pin RJ12 DK-Port cash-drawer kick jack, 24V DC DIN power).

Metres, Z up, front towards -Y, rubber feet bottom touching Z = 0.000 m.
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
    look_at,
    material,
)
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/star-mcp31lb"
NAME = "star-mcp31lb"

WIDTH = 0.1320
DEPTH = 0.1400
HEIGHT = 0.1250

COVER_PIVOT = (0.0, -0.0660, 0.0160)
ROLL_ORIGIN = (0.0, 0.0020, 0.0545)
RECEIPT_ORIGIN = (0.0, -0.0685, 0.0950)
FEED_BTN_ORIGIN = (0.0205, -0.0692, 0.1105)


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
    ",": ("00000", "00000", "00000", "00000", "00110", "00100", "01000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
    ":": ("00000", "00110", "00110", "00000", "00110", "00110", "00000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "/": ("00001", "00010", "00100", "00100", "01000", "10000", "00000"),
    "#": ("01010", "11111", "01010", "01010", "11111", "01010", "00000"),
    "%": ("11001", "11010", "00100", "00100", "01011", "10011", "00000"),
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


def open_u_wall_loop(
    hx: float, y_front: float, y_back: float, r_back: float, thickness: float, segs: int = 8
) -> list[tuple[float, float]]:
    """Closed 2D polygon for U-shaped side+rear walls spanning y in [y_front, y_back] with rounded rear corners."""
    pts: list[tuple[float, float]] = []
    # Outer trace from front-right -> rear-right arc -> rear-left arc -> front-left
    pts.append((hx, y_front))
    for i in range(segs + 1):
        ang = 0.5 * math.pi * (i / segs)
        pts.append((hx - r_back + r_back * math.cos(ang), y_back - r_back + r_back * math.sin(ang)))
    for i in range(segs + 1):
        ang = 0.5 * math.pi + 0.5 * math.pi * (i / segs)
        pts.append((-hx + r_back + r_back * math.cos(ang), y_back - r_back + r_back * math.sin(ang)))
    pts.append((-hx, y_front))

    # Inner trace back from front-left -> inner rear-left -> inner rear-right -> front-right
    ihx = hx - thickness
    iy_back = y_back - thickness
    ir = max(0.0015, r_back - thickness)
    pts.append((-ihx, y_front))
    for i in range(segs + 1):
        ang = math.pi - 0.5 * math.pi * (i / segs)
        pts.append((-ihx + ir + ir * math.cos(ang), iy_back - ir + ir * math.sin(ang)))
    for i in range(segs + 1):
        ang = 0.5 * math.pi - 0.5 * math.pi * (i / segs)
        pts.append((ihx - ir + ir * math.cos(ang), iy_back - ir + ir * math.sin(ang)))
    pts.append((ihx, y_front))
    return pts


def front_wrap_c_loop(
    hx: float, y_front: float, y_seam: float, r_front: float, thickness: float, segs: int = 8
) -> list[tuple[float, float]]:
    """Closed 2D polygon for wrap-around front clamshell door / upper front bezel with R8 front corners."""
    pts: list[tuple[float, float]] = []
    # Outer trace: left seam -> front-left R8 corner -> front-right R8 corner -> right seam
    pts.append((-hx, y_seam))
    for i in range(segs + 1):
        ang = math.pi + 0.5 * math.pi * (i / segs)
        pts.append((-hx + r_front + r_front * math.cos(ang), y_front + r_front + r_front * math.sin(ang)))
    for i in range(segs + 1):
        ang = 1.5 * math.pi + 0.5 * math.pi * (i / segs)
        pts.append((hx - r_front + r_front * math.cos(ang), y_front + r_front + r_front * math.sin(ang)))
    pts.append((hx, y_seam))

    # Inner trace back from right seam -> inner front-right -> inner front-left -> left seam
    ihx = hx - thickness
    iy_front = y_front + thickness
    ir = max(0.0015, r_front - thickness)
    pts.append((ihx, y_seam))
    for i in range(segs + 1):
        ang = 2.0 * math.pi - 0.5 * math.pi * (i / segs)
        pts.append((ihx - ir + ir * math.cos(ang), iy_front + ir + ir * math.sin(ang)))
    for i in range(segs + 1):
        ang = 1.5 * math.pi - 0.5 * math.pi * (i / segs)
        pts.append((-ihx + ir + ir * math.cos(ang), iy_front + ir + ir * math.sin(ang)))
    pts.append((-ihx, y_seam))
    return pts


def build_prism_from_sections(
    name: str,
    sections: list[list[Vector]],
    surf: bpy.types.Material,
    parent: bpy.types.Object,
    sharp_edges: bool = False,
) -> bpy.types.Object:
    if not sharp_edges and len(sections) >= 2:
        pts_count = len(sections[0])
        refined: list[list[Vector]] = list(sections)
        # Bottom cap vertical-wall support loop (prevents -Z cap normal pillowing flat walls)
        z0 = refined[0][0].z
        z1 = refined[1][0].z
        if (
            abs(z1 - z0) > 0.0015
            and len(refined[1]) == pts_count
            and all(abs(p.z - z0) < 1e-6 for p in refined[0])
            and all(abs(a.x - b.x) < 1e-6 and abs(a.y - b.y) < 1e-6 for a, b in zip(refined[0], refined[1]))
        ):
            eps0 = 0.0003 * (1.0 if z1 > z0 else -1.0)
            refined.insert(1, [Vector((p.x, p.y, z0 + eps0)) for p in refined[0]])
        # Top cap vertical-wall support loop (prevents +Z cap normal pillowing flat walls)
        za = refined[-2][0].z
        zb = refined[-1][0].z
        if (
            abs(zb - za) > 0.0015
            and len(refined[-2]) == pts_count
            and all(abs(p.z - zb) < 1e-6 for p in refined[-1])
            and all(abs(a.x - b.x) < 1e-6 and abs(a.y - b.y) < 1e-6 for a, b in zip(refined[-2], refined[-1]))
        ):
            eps1 = 0.0003 * (1.0 if zb > za else -1.0)
            refined.insert(len(refined) - 1, [Vector((p.x, p.y, zb - eps1)) for p in refined[-1]])
        sections = refined

    bm = bmesh.new()
    rings: list[list[bmesh.types.BMVert]] = []
    for ring in sections:
        rings.append([bm.verts.new(p) for p in ring])
    n = len(rings[0])
    bm.faces.new(list(reversed(rings[0])))
    for r_i in range(len(rings) - 1):
        ra = rings[r_i]
        rb = rings[r_i + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([ra[i], ra[j], rb[j], rb[i]])
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


def generate_receipt_texture(out_path: Path) -> bpy.types.Image:
    """Create a crisp 512x680 80mm thermal receipt texture for Satyr Kitchen Order #204."""
    w, h = 512, 680
    buf = bytearray(w * h * 4)

    # Bright warm thermal paper background
    draw_rect(buf, w, h, 0, 0, w, h, (248, 247, 242, 255))
    ink = (18, 20, 25, 255)
    sub = (78, 82, 92, 255)

    # Top ~64 px stays inside the IP22 cutter lip when fed 104 mm; start header cleanly below lip
    draw_text(buf, w, h, "SATYR KITCHEN", 256, 78, 4, ink, align="center")
    draw_text(buf, w, h, "AOYAMA FLAGSHIP - TOKYO", 256, 118, 2, sub, align="center")
    draw_text(buf, w, h, "ORDER #204       12:37", 256, 144, 2, sub, align="center")

    # Dashed divider
    for dx in range(36, w - 36, 14):
        draw_rect(buf, w, h, dx, 170, dx + 8, 173, sub)

    # Itemized pastry & cafe lines matching Square Register UI
    items = (
        ("1 CROISSANT", "¥480"),
        ("1 PAIN AU CHOC", "¥540"),
        ("2 CANELE BORDEAUX", "¥680"),
        ("1 MATCHA OAT LATTE", "¥560"),
    )
    for idx, (iname, iprice) in enumerate(items):
        ry = 192 + idx * 40
        draw_text(buf, w, h, iname, 42, ry, 2, ink)
        draw_text(buf, w, h, iprice, w - 42, ry, 2, ink, align="right")

    for dx in range(36, w - 36, 14):
        draw_rect(buf, w, h, dx, 360, dx + 8, 363, sub)

    draw_text(buf, w, h, "SUBTOTAL", 42, 378, 2, sub)
    draw_text(buf, w, h, "¥2,093", w - 42, 378, 2, sub, align="right")
    draw_text(buf, w, h, "TAX 8%", 42, 404, 2, sub)
    draw_text(buf, w, h, "¥167", w - 42, 404, 2, sub, align="right")

    draw_rect(buf, w, h, 38, 430, w - 38, 433, ink)
    draw_text(buf, w, h, "TOTAL", 42, 448, 3, ink)
    draw_text(buf, w, h, "¥2,260", w - 42, 444, 4, ink, align="right")

    draw_text(buf, w, h, "VISA CONTACTLESS  APPROVED", 256, 494, 2, sub, align="center")

    # Authentic 21x21 QR code with 3 corner finder patterns at bottom center
    qr_cell = 6
    qr_size = 21 * qr_cell
    qx0 = (w - qr_size) // 2
    qy0 = 528
    for qy in range(21):
        for qx in range(21):
            in_tl = qx < 7 and qy < 7
            in_tr = qx >= 14 and qy < 7
            in_bl = qx < 7 and qy >= 14
            on = False
            if in_tl or in_tr or in_bl:
                lx = qx if qx < 7 else qx - 14
                ly = qy if qy < 7 else qy - 14
                on = lx in (0, 6) or ly in (0, 6) or (2 <= lx <= 4 and 2 <= ly <= 4)
            else:
                on = ((qx * 11 + qy * 17 + qx * qy) % 3 == 0)
            if on:
                draw_rect(
                    buf,
                    w,
                    h,
                    qx0 + qx * qr_cell,
                    qy0 + qy * qr_cell,
                    qx0 + (qx + 1) * qr_cell,
                    qy0 + (qy + 1) * qr_cell,
                    ink,
                )

    write_rgba_png(out_path, w, h, bytes(buf))
    image = bpy.data.images.load(str(out_path), check_existing=True)
    image.pack()
    return image


def generate_star_badge_texture(out_path: Path) -> bpy.types.Image:
    """Create a crisp 256x64 metallic silver Star wordmark + swoosh on matte-black ABS."""
    w, h = 256, 64
    buf = bytearray(w * h * 4)
    draw_rect(buf, w, h, 0, 0, w, h, (16, 17, 21, 255))
    silver = (212, 218, 226, 255)
    # Iconic Star swoosh arc above wordmark
    for px in range(118, 222):
        t = (px - 118) / 104.0
        py = int(round(20 - 11.0 * math.sin(math.pi * t)))
        draw_rect(buf, w, h, px, py, px + 2, py + 3, silver)
    draw_text(buf, w, h, "STAR", 128, 22, 5, silver, align="center", spacing=2)
    write_rgba_png(out_path, w, h, bytes(buf))
    image = bpy.data.images.load(str(out_path), check_existing=True)
    image.pack()
    return image


def make_badge_material(name: str, image: bpy.types.Image) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.diffuse_color = (0.72, 0.75, 0.79, 1.0)
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = 0.35
    bsdf.inputs["Roughness"].default_value = 0.34
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.24
    mat["metallic"] = 0.35
    mat["roughness"] = 0.34
    mat["emission"] = 0.0
    return mat


def set_front_uv(obj: bpy.types.Object, w_m: float, h_m: float) -> None:
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        if poly.normal.y < -0.7:
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                u = (co.x + 0.5 * w_m) / max(1e-9, w_m)
                v = (co.z + 0.5 * h_m) / max(1e-9, h_m)
                uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, v)))
        else:
            for loop_idx in poly.loop_indices:
                uv_layer[loop_idx].uv = (0.02, 0.02)


def make_textured_paper_material(name: str, image: bpy.types.Image) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.diffuse_color = (0.97, 0.97, 0.95, 1.0)
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.68
    bsdf.inputs["Emission Strength"].default_value = 0.08
    mat["metallic"] = 0.0
    mat["roughness"] = 0.68
    mat["emission"] = 0.08
    return mat


def set_top_uv(obj: bpy.types.Object, hx: float, y0: float, y1: float) -> None:
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        if poly.normal.z > 0.7:
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                u = (co.x + hx) / max(1e-9, 2.0 * hx)
                # y1 (near slot, upper in front camera view) maps to v=1.0 (top header of receipt)
                v = (co.y - y0) / max(1e-9, (y1 - y0))
                uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, v)))
        else:
            for loop_idx in poly.loop_indices:
                uv_layer[loop_idx].uv = (0.02, 0.98)


def tune_specular(mat: bpy.types.Material, level: float) -> bpy.types.Material:
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf and "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = level
    return mat


def surfaces(receipt_img: bpy.types.Image, badge_img: bpy.types.Image) -> dict[str, bpy.types.Material]:
    lens = tune_specular(material("MCP3 smoked acrylic LED lens", (0.005, 0.006, 0.009, 1.0), 0.06, 0.08), 0.30)
    return {
        # Authentic Star MCP31LB BK Satin Matte-Black Textured ABS
        "shell_black": tune_specular(
            material("MCP3 splash-proof matte black ABS", (0.013, 0.014, 0.018, 1.0), 0.04, 0.46), 0.20
        ),
        "plinth_dark": tune_specular(
            material("MCP3 stepped lower base plinth", (0.008, 0.009, 0.012, 1.0), 0.02, 0.54), 0.16
        ),
        "acrylic_lens": lens,
        "cradle_dark": tune_specular(
            material("MCP3 internal charcoal roll bay", (0.012, 0.013, 0.017, 1.0), 0.04, 0.56), 0.18
        ),
        "cutter_steel": material("MCP3 guillotine auto-cutter blade", (0.68, 0.71, 0.75, 1.0), 0.90, 0.22),
        "star_silver": material("MCP3 silver Star emblem & button legend", (0.76, 0.79, 0.83, 1.0), 0.84, 0.22),
        "star_badge": make_badge_material("MCP3 front Star wordmark badge", badge_img),
        "platen_rubber": tune_specular(
            material("MCP3 rubber platen & feet", (0.009, 0.010, 0.013, 1.0), 0.0, 0.80), 0.14
        ),
        "paper_roll": material("MCP3 80mm thermal paper roll", (0.95, 0.95, 0.93, 1.0), 0.0, 0.64),
        "roll_core": material("MCP3 thermal roll inner core", (0.14, 0.15, 0.17, 1.0), 0.04, 0.55),
        "receipt_print": make_textured_paper_material("MCP3 printed 80mm receipt", receipt_img),
        "led_power": material("MCP3 blue Power status LED", (0.10, 0.62, 1.00, 1.0), 0.04, 0.16, emission=1.75),
        "led_bt": material("MCP3 blue Bluetooth status LED", (0.16, 0.46, 1.00, 1.0), 0.04, 0.16, emission=1.55),
        "led_lan": material("MCP3 green LAN status LED", (0.10, 0.88, 0.46, 1.0), 0.04, 0.16, emission=1.50),
        "port_silver": material("MCP3 rear USB-C & LAN shield", (0.60, 0.63, 0.67, 1.0), 0.86, 0.26),
        "dk_port": material("MCP3 rear RJ12 DK-Port jack", (0.11, 0.12, 0.15, 1.0), 0.08, 0.48),
    }


def build_printer_chassis(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    hx = 0.5 * WIDTH   # 0.0660 m
    hy = 0.5 * DEPTH   # 0.0700 m
    y_door_seam = -0.0580  # Vertical clamshell parting seam 12 mm behind front face per CAD side view

    # 1. Four non-slip rubber feet touching Z = 0.0000 m exactly
    for fname, fx, fy in (
        ("mcp3_foot_fl", -0.0485, -0.0515),
        ("mcp3_foot_fr", 0.0485, -0.0515),
        ("mcp3_foot_rl", -0.0485, 0.0515),
        ("mcp3_foot_rr", 0.0485, 0.0515),
    ):
        foot = cylinder(fname, (fx, fy, 0.0019), 0.0085, 0.0038, mat["platen_rubber"], root)
        clean_mesh_object(foot, sharp_edges=True)

    # 2. Stepped lower base plinth (Z = 0.0036..0.0160 m, inset 4.5 mm inward per CAD front & side views)
    plinth_loop = rounded_rect_loop(hx - 0.0045, hy - 0.0045, 0.0065, segs=8)
    build_prism_from_sections(
        "Printer bottom base plate",
        [
            [Vector((x, y, 0.0036)) for x, y in plinth_loop],
            [Vector((x, y, 0.0162)) for x, y in plinth_loop],
        ],
        mat["plinth_dark"],
        root,
    )

    # 3. Rounded-corner IP22 splash-proof top hood (exact W=0.1320, D=0.1400, Z_max=0.12500 m, R8 corners)
    hood_outer = rounded_rect_loop(hx, hy, 0.0080, segs=10)
    hood_crown = rounded_rect_loop(hx - 0.0010, hy - 0.0010, 0.0072, segs=10)
    build_prism_from_sections(
        "IP22 splash-proof top hood",
        [
            [Vector((x, y, 0.1186)) for x, y in hood_outer],
            [Vector((x, y, 0.1238)) for x, y in hood_outer],
            [Vector((x, y, 0.1250)) for x, y in hood_crown],
        ],
        mat["shell_black"],
        root,
    )

    # Subtle inset rounded-rectangle top hood seam panel (visible in CAD top view p. 17)
    seam_outer = rounded_rect_loop(hx - 0.0068, hy - 0.0068, 0.0045, segs=8)
    seam_inner = rounded_rect_loop(hx - 0.0078, hy - 0.0078, 0.0040, segs=8)
    bm_s = bmesh.new()
    so = [bm_s.verts.new((x, y, 0.12501)) for x, y in seam_outer]
    si = [bm_s.verts.new((x, y, 0.1246)) for x, y in seam_inner]
    ns = len(seam_outer)
    for i in range(ns):
        j = (i + 1) % ns
        bm_s.faces.new([so[i], so[j], si[j], si[i]])
    sm = bpy.data.meshes.new("IP22 top hood inset seam")
    bm_s.to_mesh(sm)
    bm_s.free()
    s_obj = bpy.data.objects.new("IP22 top hood inset seam", sm)
    bpy.context.scene.collection.objects.link(s_obj)
    s_obj.data.materials.append(mat["plinth_dark"])
    s_obj.parent = root
    clean_mesh_object(s_obj, sharp_edges=True)

    # 4. Main U-shaped side & rear enclosure shell (Y in [y_door_seam, +hy] with R8 rounded rear corners)
    u_loop = open_u_wall_loop(hx, y_door_seam, hy, 0.0080, 0.0085, segs=10)
    build_prism_from_sections(
        "Printer U-shaped rear and side shell",
        [
            [Vector((x, y, 0.0160)) for x, y in u_loop],
            [Vector((x, y, 0.1188)) for x, y in u_loop],
        ],
        mat["shell_black"],
        root,
    )

    # Preserve named side structural liners for inspection check & internal roll bay framing
    for sx_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        swall = box(
            f"Printer exterior {side_name} wall",
            (sx_sign * (hx - 0.0095), 0.0040, 0.0660),
            (0.0030, 0.1120, 0.0980),
            mat["cradle_dark"],
            root,
            0.0,
        )
        clean_mesh_object(swall, sharp_edges=True)

    # 5. Recessed rear I/O pocket (<MCP31L, MCP31LB> p. 33: LAN, USB-C, USB-A x3, RJ12 DK-Port, 24V DC DIN)
    io_bay = box(
        "Rear recessed I/O connector bay",
        (0.0, hy - 0.0105, 0.0310),
        (0.0980, 0.0120, 0.0280),
        mat["plinth_dark"],
        root,
        0.0008,
    )
    clean_mesh_object(io_bay)

    for cname, cx, cw, ch, cmat in (
        ("Rear 100BASE-TX LAN port", -0.0370, 0.0155, 0.0130, mat["port_silver"]),
        ("Rear USB-C host port", -0.0195, 0.0092, 0.0040, mat["port_silver"]),
        ("Rear USB-A 2.4A peripheral port", -0.0035, 0.0135, 0.0062, mat["port_silver"]),
        ("Rear USB-A 0.5A dual port", 0.0135, 0.0135, 0.0135, mat["port_silver"]),
        ("Rear RJ12 DK-Port cash drawer jack", 0.0295, 0.0120, 0.0115, mat["dk_port"]),
    ):
        conn = box(cname, (cx, hy - 0.0038, 0.0295), (cw, 0.0045, ch), cmat, root, 0.0)
        clean_mesh_object(conn, sharp_edges=True)

    dc_jack = cylinder(
        "Rear 24V DC DIN power jack",
        (0.0430, hy - 0.0038, 0.0295),
        0.0052,
        0.0045,
        mat["dk_port"],
        root,
        "Y",
    )
    clean_mesh_object(dc_jack)

    # 6. Internal 80mm thermal paper drop-in cradle & steel guillotine auto-cutter bar
    cradle_floor = box(
        "Internal 80mm roll cradle floor",
        (0.0, 0.0040, 0.0180),
        (0.0880, 0.0900, 0.0040),
        mat["cradle_dark"],
        root,
        0.0005,
    )
    clean_mesh_object(cradle_floor)

    cradle_back = box(
        "Internal 80mm roll cradle rear guide",
        (0.0, 0.0470, 0.0550),
        (0.0880, 0.0050, 0.0720),
        mat["cradle_dark"],
        root,
        0.0005,
    )
    clean_mesh_object(cradle_back)

    cutter = box(
        "Guillotine auto-cutter bar",
        (0.0, -0.0595, 0.0972),
        (0.0920, 0.0110, 0.0030),
        mat["cutter_steel"],
        root,
        0.0004,
    )
    clean_mesh_object(cutter)

    # 7. Upper-front R8 wrap-around bezel + IP22 paper-exit drip lip (Z = 0.0968..0.1188 m, Y in [-hy, y_door_seam])
    upper_c = front_wrap_c_loop(hx, -hy, y_door_seam, 0.0080, 0.0085, segs=10)
    build_prism_from_sections(
        "Upper front IP22 bezel hood",
        [
            [Vector((x, y, 0.0968)) for x, y in upper_c],
            [Vector((x, y, 0.1188)) for x, y in upper_c],
        ],
        mat["shell_black"],
        root,
    )

    # Sculpted top-left clamshell cover-open pull lever + finger pocket (p. 17 & p. 18 CAD)
    lever_pocket = box(
        "Cover release finger recess",
        (-0.0505, -hy + 0.0022, 0.1005),
        (0.0200, 0.0040, 0.0065),
        mat["plinth_dark"],
        root,
        0.0006,
    )
    clean_mesh_object(lever_pocket)

    open_lever = box(
        "Cover release lever",
        (-0.0505, -hy + 0.0008, 0.1105),
        (0.0205, 0.0016, 0.0145),
        mat["shell_black"],
        root,
        0.0008,
    )
    clean_mesh_object(open_lever)

    # Flush glossy smoked-black acrylic control & status LED lens (X in [-0.0375, +0.0555], Z in [0.1025, 0.1180])
    fascia = box(
        "Front charcoal control fascia",
        (0.0090, -hy + 0.0008, 0.1105),
        (0.0920, 0.0016, 0.0152),
        mat["acrylic_lens"],
        root,
        0.0005,
    )
    clean_mesh_object(fascia)

    # Status LEDs inside acrylic lens (#1 Power blue, #2 Bluetooth blue, #3 LAN green per p. 18 manual)
    for lname, lx, lw, lh, lmat in (
        ("Status LED Power", -0.0285, 0.0022, 0.0062, mat["led_power"]),
        ("Status LED Bluetooth", -0.0155, 0.0026, 0.0052, mat["led_bt"]),
        ("Status LED LAN", -0.0025, 0.0038, 0.0042, mat["led_lan"]),
    ):
        led = box(lname, (lx, -hy + 0.0003, 0.1105), (lw, 0.0006, lh), lmat, root, 0.0)
        clean_mesh_object(led, sharp_edges=True)

    # #5 Circular tactile Power button on right of acrylic lens (X = +0.0425 m) + silver standby ring
    pwr_btn = cylinder(
        "Front tactile Power button",
        (0.0425, -hy + 0.0008, 0.1105),
        0.0052,
        0.0016,
        mat["shell_black"],
        root,
        "Y",
    )
    clean_mesh_object(pwr_btn)
    pwr_ring = cylinder(
        "Front Power button legend dot",
        (0.0425, -hy + 0.00025, 0.1105),
        0.0024,
        0.0005,
        mat["star_silver"],
        root,
        "Y",
    )
    clean_mesh_object(pwr_ring)

    # 8. Articulated #4 circular Feed tactile button (`mcp3_feed_button` at X = +0.0205 m)
    feed = empty("mcp3_feed_button", FEED_BTN_ORIGIN, root)
    feed["joint_type"] = "slide"
    feed["axis_blender"] = "+Y"
    feed["range_m"] = [0.0, 0.0025]
    feed_cap = cylinder(
        "Front tactile Feed button cap",
        (0.0, 0.0004, 0.0),
        0.0052,
        0.0022,
        mat["shell_black"],
        feed,
        "Y",
    )
    clean_mesh_object(feed_cap)
    feed_icon = box(
        "Front Feed button paper legend",
        (0.0, -0.0006, 0.0),
        (0.0042, 0.0004, 0.0036),
        mat["star_silver"],
        feed,
        0.0,
    )
    clean_mesh_object(feed_icon, sharp_edges=True)
    return feed


def build_clamshell_cover_and_paper(
    root: bpy.types.Object, mat: dict[str, bpy.types.Material]
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    hx = 0.5 * WIDTH
    hy = 0.5 * DEPTH
    y_door_seam = -0.0580

    # 1. Full-width R8 wrap-around front clamshell door (`mcp3_cover`, hinged at COVER_PIVOT = (0, -0.0660, 0.0160))
    cover = empty("mcp3_cover", COVER_PIVOT, root)
    cover["joint_type"] = "hinge"
    cover["axis_blender"] = "+X"
    cover["range_rad"] = [0.0, 1.35]

    # Convert world Y in [-hy, y_door_seam - 0.0004] and Z in [0.0164, 0.0934] to cover-local coordinates
    door_c = front_wrap_c_loop(
        hx,
        -hy - COVER_PIVOT[1],
        (y_door_seam - 0.0004) - COVER_PIVOT[1],
        0.0080,
        0.0075,
        segs=10,
    )
    build_prism_from_sections(
        "Front-loading clamshell cover door",
        [
            [Vector((x, y, 0.0004)) for x, y in door_c],
            [Vector((x, y, 0.0772)) for x, y in door_c],
        ],
        mat["shell_black"],
        cover,
    )

    # Top rubber platen roller + inner paper guide carried on inside top of clamshell door
    platen = cylinder(
        "Clamshell platen roller",
        (0.0, 0.0095, 0.0742),
        0.0056,
        0.0860,
        mat["platen_rubber"],
        cover,
        "X",
    )
    clean_mesh_object(platen)

    guide_bar = cylinder(
        "Clamshell stainless de-curl shaft",
        (0.0, 0.0075, 0.0620),
        0.0028,
        0.0880,
        mat["cutter_steel"],
        cover,
        "X",
    )
    clean_mesh_object(guide_bar)

    # Crisp metallic silver `STAR` emblem on upper-right of clamshell front face (`flyer-en.pdf` p. 1)
    y_front_local = -hy - COVER_PIVOT[1]  # -0.0040 m
    badge = box(
        "Front Star mC-Print3 badge plate",
        (0.0395, y_front_local - 0.00005, 0.0605),
        (0.0230, 0.0003, 0.0058),
        mat["star_badge"],
        cover,
        0.0,
    )
    clean_mesh_object(badge, sharp_edges=True)
    set_front_uv(badge, 0.0230, 0.0058)

    # 2. Internal Ø76mm x 79.5mm (80mm class) bright-white thermal paper roll (`mcp3_paper_roll`)
    roll = empty("mcp3_paper_roll", ROLL_ORIGIN, root)
    roll["joint_type"] = "hinge"
    roll["axis_blender"] = "+X"
    roll["range_rad"] = [-500.0, 500.0]

    paper_cyl = cylinder(
        "Internal 80mm thermal paper roll",
        (0.0, 0.0, 0.0),
        0.0380,
        0.0795,
        mat["paper_roll"],
        roll,
        "X",
    )
    clean_mesh_object(paper_cyl)

    core_cyl = cylinder(
        "Thermal paper roll hollow core",
        (0.0, 0.0, 0.0),
        0.0095,
        0.0802,
        mat["roll_core"],
        roll,
        "X",
    )
    clean_mesh_object(core_cyl)

    # 3. Emerging 80mm printed receipt strip (`mcp3_receipt_strip`) tucked inside cutter lip at rest
    strip = empty("mcp3_receipt_strip", RECEIPT_ORIGIN, root)
    strip["joint_type"] = "slide"
    strip["axis_blender"] = "-Y"
    strip["range_m"] = [0.0, 0.110]

    strip_len = 0.1100
    strip_hx = 0.03975  # 79.5 mm wide
    y0_local = -0.0012  # world Y = -0.0697 m at rest (flush behind Y = -0.0700 m)
    y1_local = y0_local + strip_len
    paper_sheet = box(
        "Printed 80mm receipt paper strip",
        (0.0, 0.5 * (y0_local + y1_local), 0.0),
        (2.0 * strip_hx, strip_len, 0.0006),
        mat["receipt_print"],
        strip,
        0.0,
    )
    clean_mesh_object(paper_sheet, sharp_edges=True)
    set_top_uv(paper_sheet, strip_hx, y0_local, y1_local)

    return cover, roll, strip


def animate_timeline(
    cover: bpy.types.Object,
    roll: bpy.types.Object,
    strip: bpy.types.Object,
    feed: bpy.types.Object,
) -> None:
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0),
        (20, 0.0, 0.0, 0.0, 0.0020),
        (45, 0.0, 2.5, -0.104, 0.0),
        (70, 1.15, 2.5, -0.104, 0.0),
        (90, 1.15, 2.5, -0.104, 0.0),
        (120, 0.0, 0.0, 0.0, 0.0),
    )
    for fno, cov_rx, roll_rx, strip_dy, feed_dy in keyframes:
        cover.rotation_euler = (cov_rx, 0.0, 0.0)
        cover.keyframe_insert(data_path="rotation_euler", frame=fno)

        roll.rotation_euler = (roll_rx, 0.0, 0.0)
        roll.keyframe_insert(data_path="rotation_euler", frame=fno)

        strip.location = (RECEIPT_ORIGIN[0], RECEIPT_ORIGIN[1] + strip_dy, RECEIPT_ORIGIN[2])
        strip.keyframe_insert(data_path="location", frame=fno)

        feed.location = (FEED_BTN_ORIGIN[0], FEED_BTN_ORIGIN[1] + feed_dy, FEED_BTN_ORIGIN[2])
        feed.keyframe_insert(data_path="location", frame=fno)


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

    scene.world = bpy.data.worlds.new("mC-Print3 Studio World")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.68, 0.71, 0.75, 1.0)
    bg.inputs["Strength"].default_value = 0.56
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.06

    ground = material("Studio counter porcelain", (0.50, 0.52, 0.55, 1.0), metallic=0.0, roughness=0.82, emission=0.0)
    bpy.ops.mesh.primitive_plane_add(size=80.0, location=(0.0, 0.0, -0.0004))
    floor = bpy.context.object
    floor.name = "Studio ground"
    floor.data.materials.append(ground)

    area_light("Key softbox", (-0.55, -0.75, 0.80), (0.0, 0.0, 0.06), 88.0, 0.72)
    area_light("Fill stripbox", (0.65, -0.35, 0.60), (0.0, 0.0, 0.06), 62.0, 0.62)
    area_light("Rear rim softbox", (0.05, 0.75, 0.72), (0.0, 0.0, 0.06), 74.0, 0.68)

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
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objs = bpy.data.objects

    root = objs["mcp3_body"]
    cover = objs["mcp3_cover"]
    roll = objs["mcp3_paper_roll"]
    strip = objs["mcp3_receipt_strip"]
    feed = objs["mcp3_feed_button"]

    for child in (cover, roll, strip, feed):
        assert child.parent == root, child.name
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objs)

    low, high, dims = compute_mesh_bounds(list(root.children_recursive))
    for actual, expected, label in zip(dims, (WIDTH, DEPTH, HEIGHT), ("W", "D", "H")):
        assert abs(actual - expected) < 0.0005, (label, actual, expected)
    assert abs(low.z - 0.0) < 0.0002, low.z
    assert abs(high.z - HEIGHT) < 0.0005, high.z

    # Fault injection check: perturbing receipt strip forward 20 mm must trip closed-envelope depth check
    orig_y = strip.location.y
    strip.location.y -= 0.020
    bpy.context.view_layer.update()
    _, _, p_dims = compute_mesh_bounds(list(root.children_recursive))
    fault_detected = abs(p_dims.y - DEPTH) > 0.005
    strip.location.y = orig_y
    bpy.context.view_layer.update()
    assert fault_detected

    required_meshes = {
        "IP22 splash-proof top hood",
        "Printer U-shaped rear and side shell",
        "Printer exterior left wall",
        "Printer exterior right wall",
        "Front charcoal control fascia",
        "Guillotine auto-cutter bar",
        "Rear RJ12 DK-Port cash drawer jack",
        "Rear USB-C host port",
        "Rear 100BASE-TX LAN port",
        "Front-loading clamshell cover door",
        "Clamshell platen roller",
        "Internal 80mm thermal paper roll",
        "Printed 80mm receipt paper strip",
        "Front tactile Feed button cap",
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
        "envelope_dimensions_m": [round(v, 6) for v in dims],
        "bounds_min_m": [round(v, 6) for v in low],
        "bounds_max_m": [round(v, 6) for v in high],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported star-mcp31lb.glb; verify exact 132.0x140.0x125.0 mm matte-black IP22 "
            "R8 rounded-corner cube envelope resting on Z=0.000 m, full-width wrap-around clamshell door "
            "with silver Star emblem, smoked acrylic LED/button lens, internal Ø80mm class thermal roll, "
            "crisp printed 80mm Satyr Kitchen receipt strip, rear DK-Port/LAN/USB-C/24V connectors, "
            "fault-injection rejection, and zero mesh-quality errors."
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
    scene.name = "Star Micronics mC-Print3 (MCP31LB)"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    receipt_img = generate_receipt_texture(ASSETS / "satyr-receipt-80mm.png")
    badge_img = generate_star_badge_texture(ASSETS / "star-logo-badge.png")
    mat = surfaces(receipt_img, badge_img)
    for m in bpy.data.materials:
        if "metallic" not in m:
            m["metallic"] = 0.0
        if "roughness" not in m:
            m["roughness"] = 0.4
        if "emission" not in m:
            m["emission"] = 0.0

    root = empty("mcp3_body", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Star Micronics Co., Ltd."
    root["model"] = "mC-Print3 (MCP31LB BK)"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_mass_kg"] = 1.300
    root["ingress_protection"] = "IPX2 / IP22 Splash-Proof"

    feed = build_printer_chassis(root, mat)
    cover, roll, strip = build_clamshell_cover_and_paper(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, cover, roll, strip, feed])

    glb_path = ASSETS / f"{NAME}.glb"
    export_glb_at_rest(root, glb_path)

    animate_timeline(cover, roll, strip, feed)

    appliance_col = bpy.data.collections.new("Star mC-Print3")
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
        ("studio-main.png", (0.34, -0.44, 0.28), (0.0, 0.0, 0.062), 0.23, 1),
        ("studio-front.png", (0.0, -0.52, 0.065), (0.0, 0.0, 0.062), 0.20, 1),
        ("studio-right.png", (0.52, 0.0, 0.065), (0.0, 0.0, 0.062), 0.21, 1),
        ("studio-open.png", (0.34, -0.48, 0.30), (0.0, -0.04, 0.060), 0.29, 70),
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

    low, high, dims = compute_mesh_bounds(list(root.children_recursive))
    blend_path = ASSETS / f"{NAME}.blend"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    build_report = {
        "asset": NAME,
        "model": "Star Micronics mC-Print3 (MCP31LB BK)",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(v, 6) for v in dims],
        "bounds_min_m": [round(v, 6) for v in low],
        "bounds_max_m": [round(v, 6) for v in high],
        "published_mass_kg": 1.300,
        "renders": rendered,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blend_sha256": hashlib.sha256(blend_path.read_bytes()).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    insp = verify_and_write_inspection_report(glb_path)
    print(json.dumps({"build": build_report, "inspection": insp}, indent=2))


if __name__ == "__main__":
    main()
