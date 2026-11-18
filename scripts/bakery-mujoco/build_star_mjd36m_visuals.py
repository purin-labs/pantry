"""Build the Star Micronics mJ-Drawer (MJD36M BK) printer-driven steel cash drawer in Blender 5.2.

Reference ground truth:
- Star Micronics Japan mCollection Hardware Catalogue (p. 30 `mJ-Drawer` `MJD36M BK` / `MJD36M WT`):
  - Overall closed envelope (W x D x H): 330.0 x 355.0 x 104.0 mm (0.330 x 0.355 x 0.104 m)
  - Published mass: 5.400 kg
  - Industrial design: mCollection satin matte-black powder-coated cold-rolled steel casing with R12
    rounded front-left and front-right vertical corners (matching mC-Print3), overhanging 14 mm top
    load deck at Z = 0.104 m above a deep 3.8 mm architectural shadow-gap reveal, full-width R12
    wrap-around curved steel drawer fascia (mjd_drawer, slide 0..0.210 m along -Y) with left-center
    beveled media slip slot and lower-right stepped chrome 3-position security key cylinder lock
    (mjd_key_lock), galvanized telescopic ball-bearing side rails, rear 6-pin RJ12 DK-Port jack and
    24V kick-out solenoid, and authentic `3札6コイン` molded charcoal-black ABS cash till (6 narrow
    side-by-side scooped coin troughs in one front row + 3 rear JPY banknote bays with hairpin-U
    chromed steel wire hold-down clips `mjd_bill_clip_1..3`).

Metres, Z up, operator front towards -Y, rubber feet bottom touching Z = 0.000 m.
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
ASSETS = ROOT / "assets/bakery-mujoco/star-mjd36m"
NAME = "star-mjd36m"

WIDTH = 0.3300
DEPTH = 0.3550
HEIGHT = 0.1040

DRAWER_ORIGIN = (0.0, 0.0, 0.0520)
CLIP_LOCAL_ORIGINS = (
    ("mjd_bill_clip_1", (-0.0955, -0.0140, 0.0210)),
    ("mjd_bill_clip_2", (0.0000, -0.0140, 0.0210)),
    ("mjd_bill_clip_3", (0.0955, -0.0140, 0.0210)),
)
# Authentic lower-right key cylinder lock location per Star MJD36M catalogue photo
LOCK_LOCAL_ORIGIN = (0.0980, -0.1755, -0.0200)


FONT_5X7: dict[str, tuple[str, ...]] = {
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "¥": ("10001", "01010", "00100", "11111", "00100", "11111", "00100"),
    ",": ("00000", "00000", "00000", "00000", "00110", "00100", "01000"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
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
    buf: bytearray, w: int, h: int, text: str, x: int, y: int, scale: int, rgba: tuple[int, int, int, int]
) -> None:
    step = 6 * scale
    for idx, ch in enumerate(text):
        rows = FONT_5X7.get(ch.upper(), FONT_5X7[" "])
        gx = x + idx * step
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


def generate_banknote_atlas(out_path: Path) -> bpy.types.Image:
    """Create a 384x256 3-column JPY banknote atlas (10,000 / 5,000 / 1,000 yen)."""
    w, h = 384, 256
    buf = bytearray(w * h * 4)
    specs = (
        (0, (226, 214, 194, 255), (146, 112, 74, 255), "¥10,000"),
        (128, (220, 212, 226, 255), (112, 86, 134, 255), "¥5,000"),
        (256, (208, 222, 232, 255), (68, 112, 146, 255), "¥1,000"),
    )
    for x0, paper_c, ink_c, label in specs:
        draw_rect(buf, w, h, x0, 0, x0 + 128, h, paper_c)
        # Ornate guilloche border frame
        draw_rect(buf, w, h, x0 + 8, 10, x0 + 120, 14, ink_c)
        draw_rect(buf, w, h, x0 + 8, h - 14, x0 + 120, h - 10, ink_c)
        draw_rect(buf, w, h, x0 + 8, 10, x0 + 12, h - 10, ink_c)
        draw_rect(buf, w, h, x0 + 116, 10, x0 + 120, h - 10, ink_c)
        # Hologram strip + watermark oval + portrait medallion
        draw_rect(buf, w, h, x0 + 18, 16, x0 + 30, h - 16, (186, 192, 198, 255))
        draw_circle(buf, w, h, x0 + 64, 96, 26, (242, 239, 232, 255))
        draw_circle(buf, w, h, x0 + 64, 174, 28, ink_c)
        draw_circle(buf, w, h, x0 + 64, 174, 22, paper_c)
        draw_circle(buf, w, h, x0 + 64, 170, 11, ink_c)
        draw_text(buf, w, h, label, x0 + 34, 26, 2, ink_c)
        draw_text(buf, w, h, "NIPPON", x0 + 40, h - 32, 1, ink_c)

    write_rgba_png(out_path, w, h, bytes(buf))
    img = bpy.data.images.load(str(out_path), check_existing=True)
    img.pack()
    return img


def make_note_material(name: str, image: bpy.types.Image) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.diffuse_color = (0.86, 0.82, 0.76, 1.0)
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.70
    bsdf.inputs["Emission Strength"].default_value = 0.06
    mat["metallic"] = 0.0
    mat["roughness"] = 0.70
    mat["emission"] = 0.06
    return mat


def set_note_uv(obj: bpy.types.Object, hx: float, hy: float, u0: float, u1: float) -> None:
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        if poly.normal.z > 0.7:
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                tx = (co.x + hx) / max(1e-9, 2.0 * hx)
                ty = (co.y + hy) / max(1e-9, 2.0 * hy)
                u = u0 + tx * (u1 - u0)
                uv_layer[loop_idx].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, ty)))
        else:
            for loop_idx in poly.loop_indices:
                uv_layer[loop_idx].uv = (0.5 * (u0 + u1), 0.03)


def asym_rounded_rect_loop(
    hx: float, hy: float, r_front: float, r_rear: float, segs: int = 10
) -> list[tuple[float, float]]:
    """Closed 2D loop with `r_front` at -Y (front) corners and `r_rear` at +Y (rear) corners."""
    rf = min(r_front, hx - 1e-5, hy - 1e-5)
    rr = min(r_rear, hx - 1e-5, hy - 1e-5)
    pts: list[tuple[float, float]] = []
    corners = (
        (hx - rr, hy - rr, rr, 0.0, 0.5 * math.pi),
        (-hx + rr, hy - rr, rr, 0.5 * math.pi, math.pi),
        (-hx + rf, -hy + rf, rf, math.pi, 1.5 * math.pi),
        (hx - rf, -hy + rf, rf, 1.5 * math.pi, 2.0 * math.pi),
    )
    for cx, cy, rad, a0, a1 in corners:
        steps = segs if rad > 0.004 else 3
        for i in range(steps + 1):
            ang = a0 + (a1 - a0) * (i / steps)
            pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def open_u_wall_loop(
    hx: float, y_front: float, y_back: float, r_back: float, thickness: float, segs: int = 4
) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    pts.append((hx, y_front))
    for i in range(segs + 1):
        ang = 0.5 * math.pi * (i / segs)
        pts.append((hx - r_back + r_back * math.cos(ang), y_back - r_back + r_back * math.sin(ang)))
    for i in range(segs + 1):
        ang = 0.5 * math.pi + 0.5 * math.pi * (i / segs)
        pts.append((-hx + r_back + r_back * math.cos(ang), y_back - r_back + r_back * math.sin(ang)))
    pts.append((-hx, y_front))

    ihx = hx - thickness
    iy_back = y_back - thickness
    ir = max(0.0010, r_back - thickness)
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
    hx: float, y_front: float, y_seam: float, r_front: float, thickness: float, segs: int = 10
) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    pts.append((-hx, y_seam))
    for i in range(segs + 1):
        ang = math.pi + 0.5 * math.pi * (i / segs)
        pts.append((-hx + r_front + r_front * math.cos(ang), y_front + r_front + r_front * math.sin(ang)))
    for i in range(segs + 1):
        ang = 1.5 * math.pi + 0.5 * math.pi * (i / segs)
        pts.append((hx - r_front + r_front * math.cos(ang), y_front + r_front + r_front * math.sin(ang)))
    pts.append((hx, y_seam))

    ihx = hx - thickness
    iy_front = y_front + thickness
    ir = max(0.0020, r_front - thickness)
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
        # Bottom cap vertical-wall support loop (prevents -Z cap normal pillowing flat steel walls)
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
        # Top cap vertical-wall support loop (prevents +Z cap normal pillowing flat steel walls)
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


def tune_specular(mat: bpy.types.Material, level: float) -> bpy.types.Material:
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf and "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = level
    return mat


def surfaces(note_img: bpy.types.Image) -> dict[str, bpy.types.Material]:
    return {
        # Authentic Star MJD36M BK Satin Matte-Black Powder-Coated Steel
        "steel_black": tune_specular(
            material("MJD matte-black powder-coated steel", (0.014, 0.015, 0.019, 1.0), 0.16, 0.45), 0.22
        ),
        "shadow_gap": tune_specular(
            material("MJD recessed shadow reveal", (0.005, 0.006, 0.008, 1.0), 0.04, 0.68), 0.12
        ),
        "chrome": material("MJD chromed steel wire and lock", (0.78, 0.81, 0.85, 1.0), 0.94, 0.14),
        "rail_galv": material("MJD telescopic ball-bearing rail", (0.58, 0.61, 0.65, 1.0), 0.86, 0.26),
        "abs_tray": tune_specular(
            material("MJD molded charcoal ABS cash till", (0.018, 0.020, 0.025, 1.0), 0.04, 0.46), 0.20
        ),
        "rubber": tune_specular(
            material("MJD heavy-duty elastomer foot", (0.009, 0.010, 0.013, 1.0), 0.0, 0.80), 0.14
        ),
        "dk_port": tune_specular(
            material("MJD rear RJ12 DK-Port & slot", (0.012, 0.013, 0.017, 1.0), 0.06, 0.52), 0.18
        ),
        "solenoid_brass": material("MJD 24V solenoid latch coil", (0.76, 0.58, 0.22, 1.0), 0.85, 0.28),
        "notes_jpy": make_note_material("MJD printed JPY banknotes", note_img),
        "coin_brass": material("MJD JPY 500 and 5 yen brass coin", (0.82, 0.69, 0.34, 1.0), 0.88, 0.24),
        "coin_silver": material("MJD JPY 100 50 and 1 yen silver coin", (0.76, 0.78, 0.82, 1.0), 0.88, 0.22),
        "coin_bronze": material("MJD JPY 10 yen bronze coin", (0.68, 0.40, 0.22, 1.0), 0.86, 0.26),
    }


def build_outer_steel_casing(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> None:
    hx = 0.5 * WIDTH   # 0.1650 m
    hy = 0.5 * DEPTH   # 0.1775 m
    y_front_seam = -0.1615  # R12 curved drawer front wraps back 16 mm into side seam

    # 1. Four heavy-duty non-slip rubber feet touching Z = 0.0000 m
    for fn, fx, fy in (
        ("mjd_foot_fl", -0.1380, -0.1480),
        ("mjd_foot_fr", 0.1380, -0.1480),
        ("mjd_foot_rl", -0.1380, 0.1480),
        ("mjd_foot_rr", 0.1380, 0.1480),
    ):
        foot = cylinder(fn, (fx, fy, 0.0034), 0.0155, 0.0068, mat["rubber"], root)
        clean_mesh_object(foot, sharp_edges=True)

    # 2. Overhanging 14 mm reinforced steel top load deck (Z = 0.0900..0.10400 m, R12 front corners, R2 rear corners)
    deck_outer = asym_rounded_rect_loop(hx, hy, 0.0120, 0.0022, segs=12)
    deck_crown = asym_rounded_rect_loop(hx - 0.0008, hy - 0.0008, 0.0112, 0.0018, segs=12)
    build_prism_from_sections(
        "Reinforced steel top load deck",
        [
            [Vector((x, y, 0.0900)) for x, y in deck_outer],
            [Vector((x, y, 0.1032)) for x, y in deck_outer],
            [Vector((x, y, 0.1040)) for x, y in deck_crown],
        ],
        mat["steel_black"],
        root,
    )

    # Recessed 3.8 mm architectural shadow-gap collar beneath overhanging top hood (Z = 0.0860..0.0902 m)
    collar_loop = asym_rounded_rect_loop(hx - 0.0036, hy - 0.0036, 0.0090, 0.0018, segs=10)
    build_prism_from_sections(
        "Top hood recessed shadow reveal",
        [
            [Vector((x, y, 0.0860)) for x, y in collar_loop],
            [Vector((x, y, 0.0902)) for x, y in collar_loop],
        ],
        mat["shadow_gap"],
        root,
        sharp_edges=True,
    )

    # 3. Main U-shaped cold-rolled steel side & rear enclosure (Y in [y_front_seam, +hy], Z = 0.0068..0.0902 m)
    u_shell = open_u_wall_loop(hx, y_front_seam, hy, 0.0022, 0.0065, segs=4)
    build_prism_from_sections(
        "Outer U-shaped steel casing",
        [
            [Vector((x, y, 0.0068)) for x, y in u_shell],
            [Vector((x, y, 0.0902)) for x, y in u_shell],
        ],
        mat["steel_black"],
        root,
    )

    # Named structural inner side & rear liners + telescopic ball-bearing outer rail channels
    for sx_sign, sname in ((-1.0, "left"), (1.0, "right")):
        wall = box(
            f"Outer steel {sname} wall",
            (sx_sign * (hx - 0.0072), 0.0080, 0.0480),
            (0.0020, DEPTH - 0.0200, 0.0800),
            mat["steel_black"],
            root,
            0.0,
        )
        clean_mesh_object(wall, sharp_edges=True)

        rail = box(
            f"Telescopic ball-bearing rail {sname}",
            (sx_sign * (hx - 0.0108), 0.0060, 0.0450),
            (0.0052, DEPTH - 0.0380, 0.0220),
            mat["rail_galv"],
            root,
            0.0005,
        )
        clean_mesh_object(rail)

    # 4. Bottom steel pan (Z in [0.0068, 0.0118])
    bottom_loop = asym_rounded_rect_loop(hx - 0.0030, hy - 0.0030, 0.0095, 0.0020, segs=10)
    build_prism_from_sections(
        "Outer steel bottom pan",
        [
            [Vector((x, y, 0.0068)) for x, y in bottom_loop],
            [Vector((x, y, 0.0118)) for x, y in bottom_loop],
        ],
        mat["steel_black"],
        root,
    )

    # 5. Rear structural liner + recessed 6-pin RJ12 DK-Port jack + internal 24V kick-out solenoid
    rear_wall = box(
        "Outer steel rear wall",
        (0.0, hy - 0.0072, 0.0485),
        (WIDTH - 0.0160, 0.0020, 0.0800),
        mat["steel_black"],
        root,
        0.0,
    )
    clean_mesh_object(rear_wall, sharp_edges=True)

    dk_jack = box(
        "Rear 6-pin RJ12 DK-Port cable jack",
        (-0.0850, hy - 0.0018, 0.0260),
        (0.0180, 0.0032, 0.0155),
        mat["dk_port"],
        root,
        0.0,
    )
    clean_mesh_object(dk_jack, sharp_edges=True)

    solenoid = box(
        "Internal 24V kick-out solenoid latch",
        (0.0, hy - 0.0250, 0.0300),
        (0.0560, 0.0260, 0.0260),
        mat["solenoid_brass"],
        root,
        0.001,
    )
    clean_mesh_object(solenoid)


def build_sliding_drawer_and_till(
    root: bpy.types.Object, mat: dict[str, bpy.types.Material]
) -> tuple[bpy.types.Object, list[bpy.types.Object], bpy.types.Object]:
    drawer = empty("mjd_drawer", DRAWER_ORIGIN, root)
    drawer["joint_type"] = "slide"
    drawer["axis_blender"] = "-Y"
    drawer["range_m"] = [0.0, 0.210]

    hx = 0.5 * WIDTH   # 0.1650 m
    hy = 0.5 * DEPTH   # 0.1775 m
    y_front_seam = -0.1620

    # 1. Full-width R12 wrap-around curved steel drawer fascia (Z_world = 0.0075..0.0860 m -> z_local = -0.0445..+0.0340 m)
    fascia_c = front_wrap_c_loop(hx, -hy, y_front_seam, 0.0120, 0.0090, segs=12)
    build_prism_from_sections(
        "Drawer steel front fascia",
        [
            [Vector((x, y, -0.0445)) for x, y in fascia_c],
            [Vector((x, y, 0.0340)) for x, y in fascia_c],
        ],
        mat["steel_black"],
        drawer,
    )

    # Inner galvanized steel drawer slide runners along left & right flanks (visible when drawer opens!)
    for sx_sign, sname in ((-1.0, "left"), (1.0, "right")):
        runner = box(
            f"Drawer telescopic inner runner {sname}",
            (sx_sign * (hx - 0.0135), -0.0060, -0.0070),
            (0.0038, 0.3080, 0.0155),
            mat["rail_galv"],
            drawer,
            0.0004,
        )
        clean_mesh_object(runner)

    # Authentic MJD36M single wide beveled media/voucher slip slot on LEFT-CENTER (`mj_drawer_300-16.png`)
    slot_bezel = box(
        "Front media slot beveled surround",
        (-0.0520, -hy + 0.0006, -0.0030),
        (0.1420, 0.0012, 0.0092),
        mat["abs_tray"],
        drawer,
        0.0004,
    )
    clean_mesh_object(slot_bezel)

    media_slot = box(
        "Front media & voucher slip slot",
        (-0.0520, -hy + 0.0003, -0.0030),
        (0.1340, 0.0008, 0.0042),
        mat["shadow_gap"],
        drawer,
        0.0,
    )
    clean_mesh_object(media_slot, sharp_edges=True)

    # Stepped bright-chrome circular escutcheon ring around lower-right key lock (`mj_drawer_300-16.png`)
    escutcheon = cylinder(
        "Front key lock chrome escutcheon",
        (LOCK_LOCAL_ORIGIN[0], -hy + 0.0009, LOCK_LOCAL_ORIGIN[2]),
        0.0118,
        0.0018,
        mat["chrome"],
        drawer,
        "Y",
    )
    clean_mesh_object(escutcheon)

    escutcheon_recess = cylinder(
        "Front key lock dark collar",
        (LOCK_LOCAL_ORIGIN[0], -hy + 0.0008, LOCK_LOCAL_ORIGIN[2]),
        0.0086,
        0.0010,
        mat["shadow_gap"],
        drawer,
        "Y",
    )
    clean_mesh_object(escutcheon_recess)

    # 2. Authentic `3札6コイン` Molded Charcoal-Black ABS Cash Till (`mj_drawer_300-16.png` middle photo)
    till_floor = box(
        "ABS 3-bill 6-coin till floor",
        (0.0, -0.0060, -0.0360),
        (0.2980, 0.3120, 0.0055),
        mat["abs_tray"],
        drawer,
        0.0005,
    )
    clean_mesh_object(till_floor)

    # Outer perimeter walls & central bill-vs-coin bridge wall
    for tname, tpos, tdim in (
        ("ABS till left wall", (-0.1460, -0.0060, -0.0040), (0.0060, 0.3120, 0.0580)),
        ("ABS till right wall", (0.1460, -0.0060, -0.0040), (0.0060, 0.3120, 0.0580)),
        ("ABS till rear wall", (0.0, 0.1470, -0.0040), (0.2980, 0.0060, 0.0580)),
        ("ABS till front rim", (0.0, -0.1590, -0.0050), (0.2980, 0.0060, 0.0560)),
        ("ABS till center bill-coin divider", (0.0, -0.0150, -0.0010), (0.2900, 0.0070, 0.0620)),
        ("ABS 6-coin transverse divider", (0.0, -0.0220, -0.0240), (0.2860, 0.0090, 0.0180)),
    ):
        tw = box(tname, tpos, tdim, mat["abs_tray"], drawer, 0.0008)
        clean_mesh_object(tw)

    # FRONT HALF (`6コイン`): 5 longitudinal dividers creating ONE single row of 6 side-by-side coin troughs!
    for idx, cx_div in enumerate((-0.0955, -0.0478, 0.0000, 0.0478, 0.0955), 1):
        c_rib = box(
            f"ABS 6-coin slot divider {idx}",
            (cx_div, -0.0870, -0.0080),
            (0.0042, 0.1380, 0.0480),
            mat["abs_tray"],
            drawer,
            0.0008,
        )
        clean_mesh_object(c_rib)

    # Curved front finger-scoop ramp across all 6 coin troughs so coins slide smoothly upward at the front
    for step_i, (sy, sz, sdz) in enumerate(
        (
            (-0.1510, -0.0170, 0.0320),
            (-0.1410, -0.0245, 0.0170),
            (-0.1300, -0.0295, 0.0075),
        )
    ):
        scoop_name = "ABS coin scoop front ramp" if step_i == 0 else f"ABS coin scoop step {step_i}"
        sr = box(scoop_name, (0.0, sy, sz), (0.2860, 0.0130, sdz), mat["abs_tray"], drawer, 0.0015)
        clean_mesh_object(sr)

    # Metallic JPY coin stacks inside the 6 side-by-side front coin troughs (¥500, ¥100, ¥50, ¥10, ¥5, ¥1)
    coin_specs = (
        ("JPY 500 coin stack", -0.1195, -0.0880, 0.0132, mat["coin_brass"]),
        ("JPY 100 coin stack", -0.0716, -0.0820, 0.0113, mat["coin_silver"]),
        ("JPY 50 coin stack", -0.0239, -0.0900, 0.0105, mat["coin_silver"]),
        ("JPY 10 coin stack", 0.0239, -0.0840, 0.0118, mat["coin_bronze"]),
        ("JPY 5 coin stack", 0.0716, -0.0910, 0.0110, mat["coin_brass"]),
        ("JPY 1 coin stack", 0.1195, -0.0860, 0.0100, mat["coin_silver"]),
    )
    for cname, cx, cy, crad, cmat in coin_specs:
        cstack = cylinder(cname, (cx, cy, -0.0275), crad, 0.0105, cmat, drawer)
        clean_mesh_object(cstack)

    # REAR HALF (`3札`): 2 longitudinal walls creating 3 wide banknote compartments
    for idx, bx_div in enumerate((-0.0478, 0.0478), 1):
        bdiv = box(
            f"ABS 3-bill longitudinal divider {idx}",
            (bx_div, 0.0660, -0.0050),
            (0.0052, 0.1560, 0.0560),
            mat["abs_tray"],
            drawer,
            0.0008,
        )
        clean_mesh_object(bdiv)

    # Textured JPY banknote stacks (¥10,000, ¥5,000, ¥1,000) in the 3 rear slots
    for bname, bx, bw, u0, u1 in (
        ("JPY 10000 banknote stack", -0.0955, 0.0760, 0.0, 1.0 / 3.0),
        ("JPY 5000 banknote stack", 0.0000, 0.0760, 1.0 / 3.0, 2.0 / 3.0),
        ("JPY 1000 banknote stack", 0.0955, 0.0760, 2.0 / 3.0, 1.0),
    ):
        notes = box(bname, (bx, 0.0650, -0.0285), (bw, 0.1440, 0.0080), mat["notes_jpy"], drawer, 0.0004)
        clean_mesh_object(notes, sharp_edges=True)
        set_note_uv(notes, 0.5 * bw, 0.0720, u0, u1)

    # 3. Three sculpted hairpin-U chromed steel wire bill hold-down clips (`mjd_bill_clip_1..3`)
    clips = []
    for idx, (clip_name, clip_loc) in enumerate(CLIP_LOCAL_ORIGINS, 1):
        clip = empty(clip_name, clip_loc, drawer)
        clip["joint_type"] = "hinge"
        clip["axis_blender"] = "+X"
        clip["range_rad"] = [0.0, 0.55]

        hub = cylinder(
            f"Bill clip {idx} spring hinge barrel",
            (0.0, 0.0, 0.0),
            0.0042,
            0.0380,
            mat["chrome"],
            clip,
            "X",
        )
        clean_mesh_object(hub)

        # Twin long chromed wire arms sloping down onto the banknote stack + U-tip crossbar (`mj_drawer_300-16.png`)
        for side_s, side_l in ((-1.0, "L"), (1.0, "R")):
            arm = box(
                f"Bill clip {idx} wire arm {side_l}",
                (side_s * 0.0105, 0.0480, -0.0210),
                (0.0024, 0.0980, 0.0024),
                mat["chrome"],
                clip,
                0.0006,
            )
            arm.rotation_euler.x = math.radians(-23.0)
            clean_mesh_object(arm)

        u_tip = cylinder(
            f"Bill clip {idx} wire tip loop",
            (0.0, 0.0925, -0.0400),
            0.0022,
            0.0230,
            mat["chrome"],
            clip,
            "X",
        )
        clean_mesh_object(u_tip)
        clips.append(clip)

    # 4. Lower-right 3-position security key lock cylinder (`mjd_key_lock`), child of `mjd_drawer`
    lock = empty("mjd_key_lock", LOCK_LOCAL_ORIGIN, drawer)
    lock["joint_type"] = "hinge"
    lock["axis_blender"] = "+Y"
    lock["range_rad"] = [-1.5708, 1.5708]

    # Front of chrome lock rotor & vertical keyway slot visible inside dark collar (`y_world = -0.17755 m`)
    lock_cyl = cylinder(
        "Front security key lock cylinder",
        (0.0, 0.00095, 0.0),
        0.0066,
        0.0060,
        mat["chrome"],
        lock,
        "Y",
    )
    clean_mesh_object(lock_cyl, sharp_edges=True)

    keyway = box(
        "Key lock slot indicator",
        (0.0, -0.00165, 0.0),
        (0.0018, 0.0009, 0.0094),
        mat["shadow_gap"],
        lock,
        0.0,
    )
    clean_mesh_object(keyway, sharp_edges=True)

    return drawer, clips, lock


def animate_timeline(
    drawer: bpy.types.Object,
    clips: list[bpy.types.Object],
    lock: bpy.types.Object,
) -> None:
    keyframes = (
        (1, 0.0, (0.0, 0.0, 0.0), 0.0),
        (20, 0.0, (0.0, 0.0, 0.0), 0.0),
        (55, -0.200, (0.42, 0.20, 0.06), 0.0),
        (85, -0.200, (0.42, 0.20, 0.06), 0.785),
        (120, 0.0, (0.0, 0.0, 0.0), 0.0),
    )
    for fno, slide_dy, clip_rxs, lock_ry in keyframes:
        drawer.location = (DRAWER_ORIGIN[0], DRAWER_ORIGIN[1] + slide_dy, DRAWER_ORIGIN[2])
        drawer.keyframe_insert(data_path="location", frame=fno)

        for clip, crx in zip(clips, clip_rxs):
            clip.rotation_euler = (crx, 0.0, 0.0)
            clip.keyframe_insert(data_path="rotation_euler", frame=fno)

        lock.rotation_euler = (0.0, lock_ry, 0.0)
        lock.keyframe_insert(data_path="rotation_euler", frame=fno)


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

    scene.world = bpy.data.worlds.new("mJ-Drawer Studio World")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.68, 0.71, 0.75, 1.0)
    bg.inputs["Strength"].default_value = 0.56
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.06

    ground = material("Studio counter porcelain", (0.50, 0.52, 0.55, 1.0), metallic=0.0, roughness=0.82, emission=0.0)
    bpy.ops.mesh.primitive_plane_add(size=100.0, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio ground"
    floor.data.materials.append(ground)

    area_light("Key softbox", (-0.85, -1.15, 1.15), (0.0, -0.05, 0.05), 155.0, 1.05)
    area_light("Fill stripbox", (0.95, -0.45, 0.90), (0.0, -0.04, 0.05), 105.0, 0.85)
    area_light("Rear rim softbox", (0.10, 1.10, 0.98), (0.0, 0.0, 0.05), 125.0, 0.90)

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

    root = objs["mjd_casing"]
    drawer = objs["mjd_drawer"]
    c1 = objs["mjd_bill_clip_1"]
    c2 = objs["mjd_bill_clip_2"]
    c3 = objs["mjd_bill_clip_3"]
    lock = objs["mjd_key_lock"]

    assert drawer.parent == root
    for child in (c1, c2, c3, lock):
        assert child.parent == drawer, child.name
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objs)

    low, high, dims = compute_mesh_bounds(list(root.children_recursive))
    for actual, expected, label in zip(dims, (WIDTH, DEPTH, HEIGHT), ("W", "D", "H")):
        assert abs(actual - expected) < 0.0005, (label, actual, expected)
    assert abs(low.z - 0.0) < 0.0002, low.z
    assert abs(high.z - HEIGHT) < 0.0005, high.z

    # Fault-injection check: sliding drawer 25 mm open must fail closed-depth envelope check
    orig_y = drawer.location.y
    drawer.location.y -= 0.025
    bpy.context.view_layer.update()
    _, _, p_dims = compute_mesh_bounds(list(root.children_recursive))
    fault_detected = abs(p_dims.y - DEPTH) > 0.010
    drawer.location.y = orig_y
    bpy.context.view_layer.update()
    assert fault_detected

    required_meshes = {
        "Reinforced steel top load deck",
        "Outer U-shaped steel casing",
        "Outer steel left wall",
        "Outer steel right wall",
        "Outer steel rear wall",
        "Rear 6-pin RJ12 DK-Port cable jack",
        "Internal 24V kick-out solenoid latch",
        "Drawer steel front fascia",
        "Front media & voucher slip slot",
        "ABS 3-bill 6-coin till floor",
        "ABS till center bill-coin divider",
        "ABS 6-coin transverse divider",
        "Bill clip 1 spring hinge barrel",
        "Bill clip 2 spring hinge barrel",
        "Bill clip 3 spring hinge barrel",
        "Front security key lock cylinder",
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
            "Import exported star-mjd36m.glb; verify exact 330.0x355.0x104.0 mm R12 rounded-front "
            "matte-black steel casing resting on Z=0.000 m with overhanging Z=0.104 m top load deck, "
            "recessed shadow reveal, left-center media slip slot, lower-right chrome key cylinder lock, "
            "authentic 1-row 6-coin / 3-bill cash till with printed JPY banknotes and 3 hairpin-U wire "
            "bill clips, fault-injection rejection, and zero mesh-quality errors."
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
    scene.name = "Star Micronics mJ-Drawer (MJD36M)"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    note_img = generate_banknote_atlas(ASSETS / "jpy-banknotes.png")
    mat = surfaces(note_img)
    for m in bpy.data.materials:
        if "metallic" not in m:
            m["metallic"] = 0.0
        if "roughness" not in m:
            m["roughness"] = 0.4
        if "emission" not in m:
            m["emission"] = 0.0

    root = empty("mjd_casing", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Star Micronics Co., Ltd."
    root["model"] = "mJ-Drawer (MJD36M BK)"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_mass_kg"] = 5.400
    root["till_layout"] = "3-bill / 6-coin (3札6硬貨)"

    build_outer_steel_casing(root, mat)
    drawer, clips, lock = build_sliding_drawer_and_till(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, drawer, *clips, lock])

    glb_path = ASSETS / f"{NAME}.glb"
    export_glb_at_rest(root, glb_path)

    animate_timeline(drawer, clips, lock)

    appliance_col = bpy.data.collections.new("Star mJ-Drawer MJD36M")
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
        ("studio-main.png", (0.64, -0.82, 0.50), (0.0, 0.0, 0.052), 0.50, 1),
        ("studio-front.png", (0.0, -0.95, 0.058), (0.0, 0.0, 0.052), 0.42, 1),
        ("studio-right.png", (0.95, 0.0, 0.058), (0.0, 0.0, 0.052), 0.46, 1),
        ("studio-open.png", (0.54, -0.90, 0.74), (0.0, -0.09, 0.048), 0.62, 55),
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
        "model": "Star Micronics mJ-Drawer (MJD36M BK)",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(v, 6) for v in dims],
        "bounds_min_m": [round(v, 6) for v in low],
        "bounds_max_m": [round(v, 6) for v in high],
        "published_mass_kg": 5.400,
        "till_layout": "3-bill / 6-coin (3札6硬貨)",
        "renders": rendered,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blend_sha256": hashlib.sha256(blend_path.read_bytes()).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    insp = verify_and_write_inspection_report(glb_path)
    print(json.dumps({"build": build_report, "inspection": insp}, indent=2))


if __name__ == "__main__":
    main()
