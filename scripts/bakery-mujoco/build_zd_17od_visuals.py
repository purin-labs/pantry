"""Build the WPM ZD-17OD On-Demand Conical Burr Espresso Grinder (Japan 100V SKU) in Blender 5.2.

Metres, Z up, operator front towards -Y, Z = 0.000 m at rubber feet bottom.
Published grinder envelope: 125 x 235 x 410 mm (0.125 x 0.235 x 0.410 m),
grinder mass 3.800 kg (plus detachable 58 mm stainless portafilter 0.480 kg),
single-phase 100 V AC 50/60 Hz 130 W belt-driven 40 mm stainless conical burr,
450 g clear cylindrical-over-conical bean hopper with closure arm, sloped top-front
touch LCD control panel (One Cup / Minus, rectangular LCD, Two Cups / Plus),
recessed front dispensing alcove with conical die-cast grind outlet, screw-slot height
adjustment, circular portafilter tact switch, contoured U-shaped portafilter fork,
and removable front grounds collection tray with WPM badge.
"""

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
NAME = "wpm-zd-17od"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
REFERENCES = ROOT / "docs/equipment" / NAME

WIDTH = 0.1250
DEPTH = 0.2350
HEIGHT = 0.4100

GRIND_X = 0.0000
GRIND_Y = 0.0200

COLLAR_ORIGIN = (GRIND_X, GRIND_Y, 0.2700)
BURR_ORIGIN = (GRIND_X, GRIND_Y, 0.2520)
PF_TRIGGER_ORIGIN = (0.0000, -0.0500, 0.1200)
HOPPER_LID_ORIGIN = (GRIND_X, GRIND_Y, 0.4020)
PF_REST_POSE = (0.0000, -0.0840, 0.1260)

FOOT_POSITIONS = (
    ("zd17_foot_front_left", -0.0450, -0.0880),
    ("zd17_foot_front_right", 0.0450, -0.0880),
    ("zd17_foot_rear_left", -0.0450, 0.0940),
    ("zd17_foot_rear_right", 0.0450, 0.0940),
)


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


def generate_lcd_texture(panel_path: Path, compat_path: Path) -> bpy.types.Image:
    """Generate the official WPM ZD-17OD Control Panel texture (instruction-manual.pdf p. 7 & p. 8).

    Layout from left to right:
    - Left: One Cup / Minus touch icon (single cup outline with left handle, saucer, and '-' sign)
    - Center: Rectangular backlit LCD display screen showing '03.20' in 7-segment digits
    - Right: Two Cups / Plus touch icon (double overlapping cup outline with handles, saucer, and '+' sign)
    """
    width, height = 1024, 384
    buf = bytearray(width * height * 4)

    def blend_px(x: int, y: int, color: tuple[int, int, int], alpha: float = 1.0) -> None:
        if 0 <= x < width and 0 <= y < height and alpha > 0.0:
            idx = (y * width + x) * 4
            a = min(1.0, max(0.0, alpha))
            inv = 1.0 - a
            buf[idx] = int(buf[idx] * inv + color[0] * a)
            buf[idx + 1] = int(buf[idx + 1] * inv + color[1] * a)
            buf[idx + 2] = int(buf[idx + 2] * inv + color[2] * a)
            buf[idx + 3] = 255

    def fill_rect(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        r, g, b = color
        for y in range(max(0, y0), min(height, y1)):
            row_base = y * width * 4
            for x in range(max(0, x0), min(width, x1)):
                idx = row_base + x * 4
                buf[idx] = r
                buf[idx + 1] = g
                buf[idx + 2] = b
                buf[idx + 3] = 255

    def stroke_rect(x0: int, y0: int, x1: int, y1: int, t: int, color: tuple[int, int, int]) -> None:
        fill_rect(x0, y0, x1, y0 + t, color)
        fill_rect(x0, y1 - t, x1, y1, color)
        fill_rect(x0, y0, x0 + t, y1, color)
        fill_rect(x1 - t, y0, x1, y1, color)

    def draw_disc(cx: float, cy: float, radius: float, color: tuple[int, int, int]) -> None:
        r_int = int(math.ceil(radius + 1.5))
        for y in range(int(cy) - r_int, int(cy) + r_int + 1):
            for x in range(int(cx) - r_int, int(cx) + r_int + 1):
                d = math.hypot(x - cx, y - cy)
                if d <= radius + 0.7:
                    blend_px(x, y, color, min(1.0, radius + 0.7 - d))

    def draw_seg_line(x0: float, y0: float, x1: float, y1: float, half_w: float, color: tuple[int, int, int]) -> None:
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        for i in range(steps + 1):
            t = i / max(1, steps)
            draw_disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, half_w, color)

    def draw_arc(cx: float, cy: float, radius: float, a0_deg: float, a1_deg: float, half_w: float, color: tuple[int, int, int]) -> None:
        steps = 96
        for i in range(steps + 1):
            ang = math.radians(a0_deg + (a1_deg - a0_deg) * (i / steps))
            draw_disc(cx + radius * math.cos(ang), cy + radius * math.sin(ang), half_w, color)

    # 1. Dark capacitive control panel fascia with subtle vertical sheen & crisp outer border (p. 7)
    for y in range(height):
        shade = int(24 + 8 * math.sin(math.pi * y / height))
        fill_rect(0, y, width, y + 1, (shade, shade + 3, shade + 8))

    border_col = (146, 158, 172)
    draw_seg_line(28, 22, width - 28, 22, 3.0, border_col)
    draw_seg_line(28, 22, 64, height - 34, 3.0, border_col)
    draw_seg_line(width - 28, 22, width - 64, height - 34, 3.0, border_col)
    draw_seg_line(64, height - 34, width - 64, height - 34, 3.0, border_col)

    # 2. Center rectangular Display Screen (instruction-manual.pdf p. 7 & p. 8)
    lcd_x0, lcd_y0, lcd_x1, lcd_y1 = 342, 78, 682, 306
    fill_rect(lcd_x0 - 8, lcd_y0 - 8, lcd_x1 + 8, lcd_y1 + 8, (12, 15, 20))
    fill_rect(lcd_x0, lcd_y0, lcd_x1, lcd_y1, (18, 52, 94))
    stroke_rect(lcd_x0, lcd_y0, lcd_x1, lcd_y1, 4, (110, 198, 250))

    # Seven-segment '03.20' grind timer readout inside rectangular LCD window
    cyan = (212, 246, 255)
    dim_seg = (26, 72, 122)

    def draw_7seg(digit: str, ox: int, oy: int, w: int = 54, h: int = 116, t: int = 11) -> None:
        active = {
            "0": "abcdef",
            "1": "bc",
            "2": "abdeg",
            "3": "abcdg",
            "8": "abcdefg",
        }.get(digit, "")
        mh = oy + h // 2
        segs = {
            "a": (ox + t, oy, ox + w - t, oy + t),
            "b": (ox + w - t, oy + t, ox + w, mh - 2),
            "c": (ox + w - t, mh + 2, ox + w, oy + h - t),
            "d": (ox + t, oy + h - t, ox + w - t, oy + h),
            "e": (ox, mh + 2, ox + t, oy + h - t),
            "f": (ox, oy + t, ox + t, mh - 2),
            "g": (ox + t, mh - t // 2, ox + w - t, mh + t - t // 2),
        }
        for s_name, rect in segs.items():
            fill_rect(*rect, cyan if s_name in active else dim_seg)

    draw_7seg("0", 374, 134)
    draw_7seg("3", 442, 134)
    fill_rect(505, 238, 517, 250, cyan)  # Decimal point
    draw_7seg("2", 528, 134)
    draw_7seg("0", 596, 134)

    # 3. Left touch icon: One Cup / Minus (p. 7 diagram)
    icon_col = (218, 236, 250)
    icon_glow = (160, 224, 255)

    def draw_cup_outline(cx: float, cy: float, w_top: float, h_cup: float, handle_left: bool = True, handle_right: bool = False, col=icon_col) -> None:
        x_l = cx - w_top / 2
        x_r = cx + w_top / 2
        y_t = cy - h_cup / 2
        y_b = cy + h_cup / 2 - 14
        # Top rim
        draw_seg_line(x_l, y_t, x_r, y_t, 4.2, col)
        # Left & right upper walls
        draw_seg_line(x_l, y_t, x_l + 4, y_b - 12, 4.2, col)
        draw_seg_line(x_r, y_t, x_r - 4, y_b - 12, 4.2, col)
        # Rounded bottom bowl & base
        draw_seg_line(x_l + 4, y_b - 12, x_l + 16, y_b + 6, 4.2, col)
        draw_seg_line(x_r - 4, y_b - 12, x_r - 16, y_b + 6, 4.2, col)
        draw_seg_line(x_l + 16, y_b + 6, x_r - 16, y_b + 6, 4.2, col)
        # Saucer line underneath
        draw_seg_line(x_l - 8, y_b + 16, x_r + 8, y_b + 16, 4.0, col)
        if handle_left:
            draw_arc(x_l - 2, y_t + 20, 13.0, 105.0, 255.0, 3.8, col)
        if handle_right:
            draw_arc(x_r + 2, y_t + 20, 13.0, -75.0, 75.0, 3.8, col)

    # Left: One Cup + '-' sign at bottom-right
    draw_cup_outline(198, 192, 66, 68, handle_left=True, handle_right=False, col=icon_col)
    draw_seg_line(238, 224, 260, 224, 4.2, icon_col)  # Minus '-'

    # 4. Right touch icon: Two Cups / Plus (p. 7 & p. 8 diagram)
    # Primary cup on left + overlapping secondary cup silhouette on right + '+' sign
    draw_cup_outline(792, 192, 62, 68, handle_left=True, handle_right=False, col=icon_glow)
    # Overlapping second cup rim/wall/handle on right
    draw_seg_line(824, 158, 852, 158, 4.0, icon_glow)
    draw_seg_line(852, 158, 848, 200, 4.0, icon_glow)
    draw_seg_line(848, 200, 832, 218, 4.0, icon_glow)
    draw_seg_line(816, 218, 832, 218, 4.0, icon_glow)
    draw_arc(853, 178, 12.0, -75.0, 75.0, 3.6, icon_glow)
    # Plus '+' at bottom-right of Two Cups icon
    draw_seg_line(856, 224, 878, 224, 4.0, icon_glow)
    draw_seg_line(867, 213, 867, 235, 4.0, icon_glow)

    raw_bytes = bytes(buf)
    write_rgba_png(panel_path, width, height, raw_bytes)
    if compat_path != panel_path:
        write_rgba_png(compat_path, width, height, raw_bytes)
    img = bpy.data.images.load(str(panel_path))
    img.pack()
    return img


def textured_material(name: str, img: bpy.types.Image, base_rgba=(0.12, 0.24, 0.40, 1.0), metallic=0.08, roughness=0.16, emission=0.72):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = base_rgba
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Strength"].default_value = emission
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission)
    return mat


def surfaces(lcd_img: bpy.types.Image):
    pal = {
        "steel": material("zd17_stainless_brushed", (0.64, 0.67, 0.70, 1.0), 0.89, 0.23),
        "chrome": material("zd17_polished_chrome", (0.80, 0.83, 0.86, 1.0), 0.95, 0.13),
        "burr_steel": material("zd17_hardened_burr_steel", (0.54, 0.57, 0.60, 1.0), 0.91, 0.23),
        "collar_alloy": material("zd17_knurled_alloy", (0.72, 0.75, 0.78, 1.0), 0.88, 0.24),
        "dark_trim": material("zd17_gunmetal_trim", (0.09, 0.10, 0.12, 1.0), 0.35, 0.34),
        "black_abs": material("zd17_matte_black_polymer", (0.025, 0.028, 0.033, 1.0), 0.04, 0.36),
        "rubber": material("zd17_anti_slip_elastomer", (0.015, 0.017, 0.020, 1.0), 0.0, 0.62),
        "glass_dark": material("zd17_capacitive_black_glass", (0.014, 0.018, 0.024, 1.0), 0.08, 0.10),
        "hopper_clear": material("zd17_clear_hopper_san", (0.82, 0.87, 0.91, 0.20), 0.0, 0.04),
        "lid_tint": material("zd17_smoked_hopper_lid", (0.10, 0.12, 0.15, 0.52), 0.04, 0.10),
        "bean_roast": material("zd17_roasted_arabica", (0.14, 0.075, 0.042, 1.0), 0.02, 0.44),
        "red_index": material("zd17_red_index_anodised", (0.76, 0.06, 0.05, 1.0), 0.20, 0.28),
        "led_warm": material("zd17_chute_task_led", (1.0, 0.95, 0.84, 1.0), 0.0, 0.15, emission=2.0),
        "ink_light": material("zd17_laser_scale_ink", (0.90, 0.92, 0.95, 1.0), 0.05, 0.30),
        "ink_dark": material("zd17_dark_scale_ink", (0.04, 0.05, 0.06, 1.0), 0.08, 0.32),
        "lcd_screen": textured_material("zd17_touch_lcd_display", lcd_img),
    }
    for key, alpha_ior in (("hopper_clear", 1.49), ("lid_tint", 1.49)):
        bsdf = pal[key].node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Transmission Weight"].default_value = 0.90 if key == "hopper_clear" else 0.58
        bsdf.inputs["IOR"].default_value = alpha_ior
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


def rounded_rectangle_isolated(width: float, depth: float, radius: float, segments: int = 16, support: float = 0.0003):
    """2D counter-clockwise rounded rectangle with exact 4*(segments+3) vertices and 0.3 mm tangent-isolation points."""
    r = min(radius, width * 0.42, depth * 0.42)
    hx = width / 2.0 - r
    hy = depth / 2.0 - r
    sx = max(0.0, hx - max(support, 2e-4))
    sy = max(0.0, hy - max(support, 2e-4))

    pts = []
    # Corner 0: top-right (+hx, +hy), arc 0 .. pi/2
    pts.append((hx + r, sy))
    for i in range(segments + 1):
        ang = (math.pi / 2) * (i / segments)
        pts.append((hx + r * math.cos(ang), hy + r * math.sin(ang)))
    pts.append((sx, hy + r))

    # Corner 1: top-left (-hx, +hy), arc pi/2 .. pi
    pts.append((-sx, hy + r))
    for i in range(segments + 1):
        ang = math.pi / 2 + (math.pi / 2) * (i / segments)
        pts.append((-hx + r * math.cos(ang), hy + r * math.sin(ang)))
    pts.append((-hx - r, sy))

    # Corner 2: bottom-left (-hx, -hy), arc pi .. 1.5*pi
    pts.append((-hx - r, -sy))
    for i in range(segments + 1):
        ang = math.pi + (math.pi / 2) * (i / segments)
        pts.append((-hx + r * math.cos(ang), -hy + r * math.sin(ang)))
    pts.append((-sx, -hy - r))

    # Corner 3: bottom-right (+hx, -hy), arc 1.5*pi .. 2*pi
    pts.append((sx, -hy - r))
    for i in range(segments + 1):
        ang = 1.5 * math.pi + (math.pi / 2) * (i / segments)
        pts.append((hx + r * math.cos(ang), -hy + r * math.sin(ang)))
    pts.append((hx + r, -sy))

    return pts


def extrude_isolated_prism(name: str, contour_2d: list[tuple[float, float]], z0: float, z1: float, surface, parent, offset_xy=(0.0, 0.0), z_loop: float = 0.0003):
    """Extrude a 2D closed contour from z0 to z1 with 0.3 mm vertical support loops & flat-shaded caps."""
    ox, oy = offset_xy
    if z1 - z0 > 4.0 * z_loop:
        z_rings = (z0, z0 + z_loop, z1 - z_loop, z1)
    else:
        z_rings = (z0, z1)
    n = len(contour_2d)
    verts = []
    for zv in z_rings:
        for x, y in contour_2d:
            verts.append((ox + x, oy + y, zv))
    faces = []
    # Bottom cap (reversed winding -> normal -Z)
    faces.append(tuple(reversed(range(n))))
    # Side bands
    for r in range(len(z_rings) - 1):
        b0 = r * n
        b1 = (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
    # Top cap (normal +Z)
    top_base = (len(z_rings) - 1) * n
    faces.append(tuple(range(top_base, top_base + n)))
    obj = mesh_from_pydata(name, verts, faces, surface, parent, bevel=0.0)
    return clean_mesh_object(obj, sharp_z=True)


def build_stainless_housing_shell(root, mat):
    """Build the brushed stainless WPM ZD-17OD main housing (p. 1, p. 4, p. 5) with:
    - Continuous left, rear, and right brushed stainless walls (Y = -0.0540 .. +0.1175 m)
    - Deep recessed front dispensing alcove (X = -0.0430 .. +0.0430 m, Y = -0.0540 .. -0.0260 m)
    - 0.3 mm tangent-isolation and Z-support loops so vertical walls are 100% pillow-free.
    """
    r_rear = 0.0120
    r_front = 0.0065
    hx_out = 0.0615
    y_back = 0.1175
    y_front = -0.0540
    hx_alc = 0.0430
    y_alc = -0.0260
    s = 0.0003
    seg = 14

    pts = []

    def add_pt(px: float, py: float):
        if not pts or math.hypot(px - pts[-1][0], py - pts[-1][1]) > 1e-5:
            pts.append((px, py))

    # Counter-clockwise perimeter in (X, Y):
    # 1. Rear wall (+Y = 0.1175) from right (+X) to left (-X)
    add_pt(hx_out - r_rear - s, y_back)
    add_pt(-(hx_out - r_rear - s), y_back)
    # 2. Rear-left corner arc (center: -(hx_out - r_rear), y_back - r_rear), angle pi/2 .. pi
    for i in range(seg + 1):
        ang = math.pi / 2 + (math.pi / 2) * (i / seg)
        add_pt(-(hx_out - r_rear) + r_rear * math.cos(ang), (y_back - r_rear) + r_rear * math.sin(ang))
    # 3. Left outer wall (X = -hx_out) going forward to y_front
    add_pt(-hx_out, y_back - r_rear - s)
    add_pt(-hx_out, y_front + r_front + s)
    # 4. Front-left outer corner arc (center: -(hx_out - r_front), y_front + r_front), angle pi .. 1.5*pi
    for i in range(seg + 1):
        ang = math.pi + (math.pi / 2) * (i / seg)
        add_pt(-(hx_out - r_front) + r_front * math.cos(ang), (y_front + r_front) + r_front * math.sin(ang))
    # 5. Left front pilaster face (Y = y_front) from -hx_out+r_front to -hx_alc
    add_pt(-(hx_out - r_front) + s, y_front)
    add_pt(-hx_alc - s, y_front)
    add_pt(-hx_alc, y_front)
    # 6. Alcove left inner cheek (X = -hx_alc) going back to y_alc
    add_pt(-hx_alc, y_front + s)
    add_pt(-hx_alc, y_alc - s)
    add_pt(-hx_alc, y_alc)
    # 7. Alcove rear wall (Y = y_alc) from -hx_alc to +hx_alc
    add_pt(-hx_alc + s, y_alc)
    add_pt(hx_alc - s, y_alc)
    add_pt(hx_alc, y_alc)
    # 8. Alcove right inner cheek (X = +hx_alc) going forward to y_front
    add_pt(hx_alc, y_alc - s)
    add_pt(hx_alc, y_front + s)
    add_pt(hx_alc, y_front)
    # 9. Right front pilaster face (Y = y_front) from +hx_alc to +hx_out-r_front
    add_pt(hx_alc + s, y_front)
    add_pt((hx_out - r_front) - s, y_front)
    # 10. Front-right outer corner arc (center: +(hx_out - r_front), y_front + r_front), angle 1.5*pi .. 2*pi
    for i in range(seg + 1):
        ang = 1.5 * math.pi + (math.pi / 2) * (i / seg)
        add_pt((hx_out - r_front) + r_front * math.cos(ang), (y_front + r_front) + r_front * math.sin(ang))
    # 11. Right outer wall (X = +hx_out) going back to y_back
    add_pt(hx_out, y_front + r_front + s)
    add_pt(hx_out, y_back - r_rear - s)
    # 12. Rear-right corner arc (center: +(hx_out - r_rear), y_back - r_rear), angle 0 .. pi/2
    for i in range(seg + 1):
        ang = 0.0 + (math.pi / 2) * (i / seg)
        add_pt((hx_out - r_rear) + r_rear * math.cos(ang), (y_back - r_rear) + r_rear * math.sin(ang))

    return extrude_isolated_prism("zd17_stainless_tower", pts, 0.0250, 0.2120, mat["steel"], root)


def build_sloped_control_crown(root, mat):
    """Build the upper stainless head (Z = 0.2120 .. 0.2560 m) with sloped front control face (p. 1, p. 4, p. 5)
    and exact flush rear/side walls matching build_stainless_housing_shell."""
    r_rear = 0.0120
    r_front = 0.0065
    hx_out = 0.0615
    y_back = 0.1175
    s = 0.0003
    seg = 14

    def crown_ring(yf: float):
        pts = []

        def add_pt(px: float, py: float):
            pts.append((px, py))

        # 1. Rear wall (+Y = 0.1175) from right (+X) to left (-X)
        add_pt(hx_out - r_rear - s, y_back)
        add_pt(-(hx_out - r_rear - s), y_back)
        # 2. Rear-left corner arc (angle pi/2 .. pi)
        for i in range(seg + 1):
            ang = math.pi / 2 + (math.pi / 2) * (i / seg)
            add_pt(-(hx_out - r_rear) + r_rear * math.cos(ang), (y_back - r_rear) + r_rear * math.sin(ang))
        # 3. Left outer wall (X = -hx_out) going forward to yf
        add_pt(-hx_out, y_back - r_rear - s)
        add_pt(-hx_out, yf + r_front + s)
        # 4. Front-left corner arc (angle pi .. 1.5*pi)
        for i in range(seg + 1):
            ang = math.pi + (math.pi / 2) * (i / seg)
            add_pt(-(hx_out - r_front) + r_front * math.cos(ang), (yf + r_front) + r_front * math.sin(ang))
        # 5. Front sloped face (Y = yf) from left to right
        add_pt(-(hx_out - r_front) + s, yf)
        add_pt((hx_out - r_front) - s, yf)
        # 6. Front-right corner arc (angle 1.5*pi .. 2*pi)
        for i in range(seg + 1):
            ang = 1.5 * math.pi + (math.pi / 2) * (i / seg)
            add_pt((hx_out - r_front) + r_front * math.cos(ang), (yf + r_front) + r_front * math.sin(ang))
        # 7. Right outer wall (X = +hx_out) going back to y_back
        add_pt(hx_out, yf + r_front + s)
        add_pt(hx_out, y_back - r_rear - s)
        # 8. Rear-right corner arc (angle 0 .. pi/2)
        for i in range(seg + 1):
            ang = (math.pi / 2) * (i / seg)
            add_pt((hx_out - r_rear) + r_rear * math.cos(ang), (y_back - r_rear) + r_rear * math.sin(ang))
        return pts

    z_levels = (0.2120, 0.2123, 0.2557, 0.2560)
    rings = []
    for zv in z_levels:
        t = (zv - 0.2120) / (0.2560 - 0.2120)
        yf = -0.0540 + t * (-0.0160 - (-0.0540))
        rings.append((zv, crown_ring(yf)))

    n = len(rings[0][1])
    verts = []
    for zv, rpts in rings:
        for ux, uy in rpts:
            verts.append((ux, uy, zv))

    faces = [tuple(reversed(range(n)))]
    for r in range(len(z_levels) - 1):
        b0 = r * n
        b1 = (r + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
    top_base = (len(z_levels) - 1) * n
    faces.append(tuple(range(top_base, top_base + n)))
    obj = mesh_from_pydata("zd17_upper_control_crown", verts, faces, mat["steel"], root, bevel=0.0)
    clean_mesh_object(obj, sharp_z=True)
    for poly in obj.data.polygons:
        if poly.normal.y < -0.45 and poly.normal.z > 0.45:
            poly.use_smooth = False
    return obj


def build_rounded_frame_xz(name: str, outer_w: float, outer_h: float, inner_w: float, inner_h: float, r_out: float, r_in: float, y0: float, y1: float, center_xz: tuple[float, float], surface, parent, segments: int = 12):
    """Build a rounded-rectangle picture-frame liner in the X-Z front plane extruded from y0 to y1."""
    cx, cz = center_xz
    outer_pts = rounded_rectangle_isolated(outer_w, outer_h, r_out, segments=segments, support=0.0002)
    inner_pts = rounded_rectangle_isolated(inner_w, inner_h, r_in, segments=segments, support=0.0002)
    n = len(outer_pts)
    assert len(inner_pts) == n

    y_rings = (y0, y0 + 0.0002, y1 - 0.0002, y1) if (y1 - y0) > 0.001 else (y0, y1)
    verts = []
    for yv in y_rings:
        for ux, uz in outer_pts:
            verts.append((cx + ux, yv, cz + uz))
        for ux, uz in inner_pts:
            verts.append((cx + ux, yv, cz + uz))

    faces = []
    stride = 2 * n
    last_base = (len(y_rings) - 1) * stride
    for i in range(n):
        j = (i + 1) % n
        # Front cap at y0 (outward normal -Y)
        faces.append((i, j, n + j, n + i))
        # Back cap at y1 (outward normal +Y)
        faces.append((last_base + i, last_base + n + i, last_base + n + j, last_base + j))

    # Outer and inner perimeter walls along Y
    for r in range(len(y_rings) - 1):
        b0 = r * stride
        b1 = (r + 1) * stride
        for i in range(n):
            j = (i + 1) % n
            # Outer wall (outward normal away from center)
            faces.append((b0 + i, b1 + i, b1 + j, b0 + j))
            # Inner cavity wall (outward normal toward alcove center)
            faces.append((b0 + n + i, b0 + n + j, b1 + n + j, b1 + n + i))

    obj = mesh_from_pydata(name, verts, faces, surface, parent, bevel=0.0)
    clean_mesh_object(obj, sharp_z=False, recalc_normals=False)
    for poly in obj.data.polygons:
        poly.use_smooth = abs(poly.normal.y) < 0.95
    return obj


def lathe_solid(name, profile, center, surface, parent, segments=64, sharp_z=True):
    """Build a closed revolved solid from an (r, z) closed contour with optional 0.25 mm Z support rings."""
    expanded = []
    n_raw = len(profile)
    for idx in range(n_raw):
        r0, z0 = profile[idx]
        r1, z1 = profile[(idx + 1) % n_raw]
        expanded.append((r0, z0))
        dz = z1 - z0
        dr = r1 - r0
        length = math.hypot(dr, dz)
        if length > 0.0040 and abs(dz) > 0.0020:
            s = 0.00025 / length
            expanded.append((r0 + dr * s, z0 + dz * s))
            expanded.append((r1 - dr * s, z1 - dz * s))

    vertices = []
    for r, z in expanded:
        for idx in range(segments):
            ang = idx * math.tau / segments
            vertices.append(
                (
                    center[0] + r * math.cos(ang),
                    center[1] + r * math.sin(ang),
                    center[2] + z,
                )
            )
    faces = []
    n_rings = len(expanded)
    for ring in range(n_rings):
        nxt = (ring + 1) % n_rings
        r0, z0 = expanded[ring]
        r1, z1 = expanded[nxt]
        if abs(r0 - r1) < 1e-8 and abs(z0 - z1) < 1e-8:
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
    obj = mesh_from_pydata(name, vertices, faces, surface, parent, bevel=0.0)
    return clean_mesh_object(obj, sharp_z=sharp_z)


def clean_cylinder(name, position, radius, depth, surface, parent, axis="Z", vertices=48, bevel=0.0, sharp_z=True):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=position
    )
    obj = bpy.context.object
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj = finish(obj, name, surface, parent, bevel)
    return clean_mesh_object(obj, sharp_z=sharp_z)


def text_3d(name, value, position, size, surface, parent, rot=(math.pi / 2, 0.0, 0.0), extrude=0.0005):
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
        # Keep horizontal caps flat-shaded when sharp_z=True so cap normals never bleed into vertical walls
        poly.use_smooth = not (sharp_z and abs(poly.normal.z) > 0.96)
    return obj


def add_planar_uv(obj):
    """Map local X and Z (before tilting) upright onto [0, 1] UV space (top of mesh = v=1 = row 0 of PNG)."""
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    xs = [v.co.x for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    span_z = max(zs) - min(zs)
    span_y = max(ys) - min(ys)
    x0, x1 = min(xs), max(xs)
    dx = max(1e-6, x1 - x0)
    if span_z >= span_y:
        v0, v1 = min(zs), max(zs)
        dv = max(1e-6, v1 - v0)
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                co = mesh.vertices[mesh.loops[li].vertex_index].co
                uv_layer[li].uv = ((co.x - x0) / dx, (co.z - v0) / dv)
    else:
        v0, v1 = min(ys), max(ys)
        dv = max(1e-6, v1 - v0)
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                co = mesh.vertices[mesh.loops[li].vertex_index].co
                uv_layer[li].uv = ((co.x - x0) / dx, (co.y - v0) / dv)


def build_grinder_body(root, mat):
    # 1. Exact 125 x 235 mm base plinth (Z = 0.0055 .. 0.0205 m) defining exact X and Y outer bounds
    plinth_contour = rounded_rectangle_isolated(WIDTH, DEPTH, 0.0150, segments=16, support=0.0003)
    extrude_isolated_prism("zd17_base_plinth", plinth_contour, 0.0055, 0.0205, mat["black_abs"], root)

    # Lower brushed stainless base wrap step (Z = 0.0205 .. 0.0255 m, p. 4 & p. 5)
    deck_contour = rounded_rectangle_isolated(0.1230, 0.2320, 0.0140, segments=16, support=0.0003)
    extrude_isolated_prism("zd17_base_stainless_deck", deck_contour, 0.0205, 0.0255, mat["steel"], root, offset_xy=(0.0, 0.0010))

    # Four anti-vibration elastomer feet touching exact Z = 0.0000 m
    for fname, fx, fy in FOOT_POSITIONS:
        foot = empty(fname, (fx, fy, 0.0), root)
        foot["contact_plane_z_m"] = 0.0
        clean_cylinder(
            f"{fname}_pad",
            (0.0, 0.0, 0.0030),
            0.0110,
            0.0060,
            mat["rubber"],
            foot,
            vertices=36,
            bevel=0.0,
            sharp_z=True,
        )
        clean_cylinder(
            f"{fname}_washer",
            (0.0, 0.0, 0.0050),
            0.0125,
            0.0020,
            mat["chrome"],
            foot,
            vertices=36,
            bevel=0.0,
            sharp_z=True,
        )

    # 2. Removable Collection Tray on forward base extension with 'WPM' front logo (p. 1, p. 4, p. 9 Figs. 5 & 8)
    tray_outer = rounded_rectangle_isolated(0.1060, 0.0680, 0.0140, segments=16, support=0.0003)
    extrude_isolated_prism(
        "zd17_grounds_catch_tray",
        tray_outer,
        0.0245,
        0.0555,
        mat["steel"],
        root,
        offset_xy=(0.0, -0.0820),
    )

    # Molded black dished collection tray top rim & recessed catch basin (p. 1 & p. 4)
    tray_basin_floor = extrude_isolated_prism(
        "zd17_grounds_catch_grate",
        rounded_rectangle_isolated(0.1050, 0.0670, 0.0135, segments=16, support=0.0003),
        0.0535,
        0.0575,
        mat["black_abs"],
        root,
        offset_xy=(0.0, -0.0820),
    )
    _ = tray_basin_floor
    # Raised rounded inner/outer lip around top of Removable Collection Tray
    tray_rim_outer = rounded_rectangle_isolated(0.1050, 0.0670, 0.0135, segments=16, support=0.0002)
    tray_rim_inner = rounded_rectangle_isolated(0.0920, 0.0540, 0.0095, segments=16, support=0.0002)
    n_tr = len(tray_rim_outer)
    rim_verts = []
    for zv in (0.0570, 0.0572, 0.0618, 0.0620):
        for ux, uy in tray_rim_outer:
            rim_verts.append((ux, -0.0820 + uy, zv))
        for ux, uy in tray_rim_inner:
            rim_verts.append((ux, -0.0820 + uy, zv))
    rim_faces = []
    stride_tr = 2 * n_tr
    top_b = 3 * stride_tr
    for i in range(n_tr):
        j = (i + 1) % n_tr
        rim_faces.append((top_b + i, top_b + j, top_b + n_tr + j, top_b + n_tr + i))
    for r in range(3):
        b0 = r * stride_tr
        b1 = (r + 1) * stride_tr
        for i in range(n_tr):
            j = (i + 1) % n_tr
            rim_faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
            rim_faces.append((b0 + n_tr + j, b0 + n_tr + i, b1 + n_tr + i, b1 + n_tr + j))
    tray_lip = mesh_from_pydata("zd17_grounds_catch_rim", rim_verts, rim_faces, mat["black_abs"], root, bevel=0.0)
    clean_mesh_object(tray_lip, sharp_z=True)

    # Bold 'WPM' logo on front apron of Removable Collection Tray (p. 1 & p. 4)
    badge_plate = box(
        "zd17_wpm_brand_plaque",
        (0.0, -0.1160, 0.0395),
        (0.0380, 0.0008, 0.0120),
        mat["steel"],
        root,
        0.0,
    )
    clean_mesh_object(badge_plate, sharp_z=True)
    text_3d("zd17_wpm_wordmark", "WPM", (0.0, -0.1163, 0.0395), 0.0096, mat["ink_dark"], root, extrude=0.0005)

    # 3. Main brushed stainless-steel housing shell + sloped upper control crown (p. 1, p. 4, p. 5)
    build_stainless_housing_shell(root, mat)
    build_sloped_control_crown(root, mat)

    # Alcove lower sill & ceiling closure inside the stainless tower
    alcove_sill = box(
        "zd17_alcove_lower_sill",
        (0.0, -0.0400, 0.0395),
        (0.0880, 0.0280, 0.0290),
        mat["black_abs"],
        root,
        0.0,
    )
    clean_mesh_object(alcove_sill, sharp_z=True)

    alcove_ceiling = box(
        "zd17_alcove_upper_ceiling",
        (0.0, -0.0400, 0.2035),
        (0.0880, 0.0280, 0.0170),
        mat["black_abs"],
        root,
        0.0,
    )
    clean_mesh_object(alcove_ceiling, sharp_z=True)

    # Rounded-rectangle black inner alcove frame & liner (instruction-manual.pdf p. 1 & p. 4)
    build_rounded_frame_xz(
        "zd17_alcove_outer_surround",
        0.0940,
        0.1560,
        0.0840,
        0.1440,
        0.0125,
        0.0090,
        -0.0548,
        -0.0258,
        (0.0, 0.1260),
        mat["dark_trim"],
        root,
    )
    build_rounded_frame_xz(
        "zd17_alcove_inner_bezel",
        0.0844,
        0.1444,
        0.0760,
        0.1360,
        0.0090,
        0.0065,
        -0.0542,
        -0.0258,
        (0.0, 0.1260),
        mat["black_abs"],
        root,
    )

    # Alcove rear wall liner plate (p. 1, p. 4 inset, p. 9 Fig. 6)
    alcove_back = box(
        "zd17_alcove_rear_panel",
        (0.0, -0.0272, 0.1260),
        (0.0780, 0.0024, 0.1380),
        mat["steel"],
        root,
        0.0,
    )
    clean_mesh_object(alcove_back, sharp_z=True)

    # Circular Main Power Button with bezel ring on lower-rear right wall (p. 1, p. 5, p. 9 Figs. 5 & 8)
    pwr_bezel = clean_cylinder(
        "zd17_main_power_bezel",
        (0.0612, 0.0620, 0.0520),
        0.0110,
        0.0022,
        mat["dark_trim"],
        root,
        axis="X",
        vertices=36,
        bevel=0.0004,
        sharp_z=False,
    )
    _ = pwr_bezel
    pwr_ring = clean_cylinder(
        "zd17_main_power_ring",
        (0.0616, 0.0620, 0.0520),
        0.0085,
        0.0016,
        mat["chrome"],
        root,
        axis="X",
        vertices=36,
        bevel=0.0003,
        sharp_z=False,
    )
    _ = pwr_ring
    pwr_btn = clean_cylinder(
        "zd17_main_power_button",
        (0.0619, 0.0620, 0.0520),
        0.0058,
        0.0012,
        mat["steel"],
        root,
        axis="X",
        vertices=36,
        bevel=0.0003,
        sharp_z=False,
    )
    _ = pwr_btn

    # Recessed rear 100V AC cord strain-relief grommet (strictly inside Y <= +0.1175 m)
    rear_cord_pocket = box(
        "zd17_rear_cord_inlet",
        (0.0, 0.1155, 0.0420),
        (0.0260, 0.0036, 0.0200),
        mat["rubber"],
        root,
        0.0006,
    )
    clean_mesh_object(rear_cord_pocket, sharp_z=False)

    # 4. Top-deck Grind Cartridge Seat, Alignment Arrow & Upper Burr Release Button (p. 5, p. 6 Fig. 1, p. 10 Fig. 10)
    collar_seat = lathe_solid(
        "zd17_upper_collar_seat",
        [
            (0.0360, 0.2555),
            (0.0485, 0.2555),
            (0.0485, 0.2615),
            (0.0465, 0.2630),
            (0.0360, 0.2630),
        ],
        (GRIND_X, GRIND_Y, 0.0),
        mat["dark_trim"],
        root,
        segments=64,
        sharp_z=True,
    )
    _ = collar_seat

    # Upper Burr Release Button on top-right of housing deck (p. 5 & p. 10 Fig. 10)
    rel_bezel = clean_cylinder(
        "zd17_burr_release_bezel",
        (0.0430, 0.0520, 0.2568),
        0.0068,
        0.0018,
        mat["dark_trim"],
        root,
        vertices=32,
        bevel=0.0003,
        sharp_z=True,
    )
    _ = rel_bezel
    rel_btn = clean_cylinder(
        "zd17_burr_release_button",
        (0.0430, 0.0520, 0.2584),
        0.0048,
        0.0028,
        mat["red_index"],
        root,
        vertices=32,
        bevel=0.0005,
        sharp_z=True,
    )
    _ = rel_btn

    # 5. Sloped Top-Front Control Panel ('Touch Key and Display Screen', p. 1, p. 4, p. 7)
    # Sloped crown face goes from (Y=-0.0540, Z=0.2120) to (Y=-0.0160, Z=0.2560):
    # Midpoint is (Y=-0.0350, Z=0.2340); tangent along slope has dy=+0.0380, dz=+0.0440 -> tilt from vertical is atan2(0.0380, 0.0440) = 40.815 deg
    panel_tilt_rad = -math.atan2(0.0380, 0.0440)

    lcd_pod = box(
        "zd17_lcd_bezel_housing",
        (0.0, -0.0352, 0.2340),
        (0.1020, 0.0032, 0.0480),
        mat["dark_trim"],
        root,
        0.0008,
    )
    lcd_pod.rotation_euler.x = panel_tilt_rad
    bpy.context.view_layer.objects.active = lcd_pod
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(lcd_pod, sharp_z=False)

    lcd_glass = box(
        "zd17_lcd_touch_glass",
        (0.0, -0.0362, 0.2348),
        (0.0980, 0.0018, 0.0440),
        mat["glass_dark"],
        root,
        0.0004,
    )
    lcd_glass.rotation_euler.x = panel_tilt_rad
    bpy.context.view_layer.objects.active = lcd_glass
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(lcd_glass, sharp_z=False)

    lcd_screen = box(
        "zd17_lcd_active_panel",
        (0.0, -0.0371, 0.2355),
        (0.0950, 0.0010, 0.0415),
        mat["lcd_screen"],
        root,
        0.0,
    )
    add_planar_uv(lcd_screen)
    lcd_screen.rotation_euler.x = panel_tilt_rad
    bpy.context.view_layer.objects.active = lcd_screen
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(lcd_screen, sharp_z=False)

    # 6. Sculpted Bowl-Shaped Die-Cast 'Grind Outlet' at top of Dispensing Alcove (p. 1 & p. 4)
    bowl_profile = [(0.0000, 0.1940), (0.0270, 0.1940)]
    for i in range(11):
        ang = -0.25 + 1.35 * (i / 10.0)
        r_b = 0.0170 + 0.0115 * math.cos(ang)
        z_b = 0.1815 - 0.0145 * math.sin(ang)
        bowl_profile.append((r_b, z_b))
    bowl_profile.append((0.0000, bowl_profile[-1][1]))
    chute_bowl = lathe_solid(
        "zd17_antistatic_grounds_chute",
        bowl_profile,
        (0.0, -0.0560, 0.0),
        mat["steel"],
        root,
        segments=64,
        sharp_z=True,
    )
    _ = chute_bowl

    # Lower grounds exit nozzle with anti-static declumper teeth (p. 4 inset) & task LED
    chute_spout = lathe_solid(
        "zd17_chute_exit_nozzle",
        [
            (0.0110, 0.1590),
            (0.0165, 0.1590),
            (0.0175, 0.1675),
            (0.0110, 0.1675),
        ],
        (0.0, -0.0560, 0.0),
        mat["black_abs"],
        root,
        segments=48,
        sharp_z=True,
    )
    _ = chute_spout

    chute_led = clean_cylinder(
        "zd17_chute_task_lamp",
        (0.0, -0.0400, 0.1925),
        0.0045,
        0.0018,
        mat["led_warm"],
        root,
        vertices=24,
        bevel=0.0,
        sharp_z=True,
    )
    _ = chute_led

    # 7. Rear Alcove Rectangular Pocket, Tact Switch Bezel, and Vertical Screw Slot (p. 1, p. 4 inset, p. 9 Fig. 6)
    upper_slot_frame = box(
        "zd17_alcove_upper_pocket",
        (0.0, -0.0288, 0.1460),
        (0.0240, 0.0024, 0.0095),
        mat["black_abs"],
        root,
        0.0004,
    )
    clean_mesh_object(upper_slot_frame, sharp_z=True)
    upper_slot_bar = box(
        "zd17_alcove_upper_latch",
        (0.0, -0.0298, 0.1460),
        (0.0180, 0.0016, 0.0040),
        mat["chrome"],
        root,
        0.0003,
    )
    clean_mesh_object(upper_slot_bar, sharp_z=True)

    # Vertical oval fork-height adjustment slot & Phillips lock screw (p. 1, p. 4 inset, p. 9 Fig. 6)
    fork_slot_recess = box(
        "zd17_fork_adjust_slot",
        (0.0, -0.0285, 0.0860),
        (0.0120, 0.0020, 0.0320),
        mat["black_abs"],
        root,
        0.0006,
    )
    clean_mesh_object(fork_slot_recess, sharp_z=True)
    fork_screw = clean_cylinder(
        "zd17_fork_height_knob",
        (0.0, -0.0300, 0.0960),
        0.0048,
        0.0030,
        mat["chrome"],
        root,
        axis="Y",
        vertices=28,
        bevel=0.0004,
        sharp_z=False,
    )
    _ = fork_screw

    # 8. Contoured U-Shaped Stainless 'Portafilter Fork' (p. 1, p. 4, p. 6 Fig. 3, p. 9 Figs. 6-7)
    fork_block = box(
        "zd17_fork_mount_block",
        (0.0, -0.0385, 0.1075),
        (0.0720, 0.0210, 0.0070),
        mat["chrome"],
        root,
        0.0008,
    )
    clean_mesh_object(fork_block, sharp_z=True)

    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        # Horizontal stainless fork arm supporting portafilter head
        arm = box(
            f"zd17_fork_arm_{side_name}",
            (side_sign * 0.0320, -0.0760, 0.1075),
            (0.0120, 0.0680, 0.0068),
            mat["chrome"],
            root,
            0.0,
        )
        clean_mesh_object(arm, sharp_z=True)
        # Flat support pad topping out at exact Z = 0.1120 m (for raycast at (±0.032, -0.084))
        arm_pad = box(
            f"zd17_fork_pad_{side_name}",
            (side_sign * 0.0320, -0.0800, 0.1112),
            (0.0105, 0.0560, 0.0016),
            mat["rubber"],
            root,
            0.0,
        )
        clean_mesh_object(arm_pad, sharp_z=True)
        # Upturned outer guide flange shown on Portafilter Fork in p. 1 & p. 4
        wing = box(
            f"zd17_fork_wing_{side_name}",
            (side_sign * 0.0392, -0.0760, 0.1125),
            (0.0032, 0.0640, 0.0085),
            mat["chrome"],
            root,
            0.0005,
        )
        clean_mesh_object(wing, sharp_z=True)

    # 9. Cylindrical-over-Conical 450 g Bean Hopper & Hopper Closure Arm (p. 1, p. 4, p. 5, p. 6, p. 10)
    # Throat collar with downward alignment triangle ▼ on front (p. 1, p. 4, p. 6 Fig. 1)
    hopper_neck = lathe_solid(
        "zd17_hopper_throat_collar",
        [
            (0.0260, 0.2760),
            (0.0385, 0.2760),
            (0.0390, 0.2855),
            (0.0260, 0.2855),
        ],
        (GRIND_X, GRIND_Y, 0.0),
        mat["steel"],
        root,
        segments=64,
        sharp_z=True,
    )
    _ = hopper_neck

    align_marker = box(
        "zd17_grind_index_pointer",
        (0.0, GRIND_Y - 0.0392, 0.2810),
        (0.0036, 0.0012, 0.0042),
        mat["ink_dark"],
        root,
        0.0,
    )
    clean_mesh_object(align_marker, sharp_z=True)

    # 'Hopper closure arm' extending to the right (+X) at base of hopper cone (p. 5 & p. 6 Fig. 2)
    closure_plate = box(
        "zd17_hopper_closure_arm",
        (0.0395, GRIND_Y, 0.2855),
        (0.0360, 0.0280, 0.0032),
        mat["black_abs"],
        root,
        0.0006,
    )
    clean_mesh_object(closure_plate, sharp_z=True)
    closure_lip = box(
        "zd17_hopper_closure_handle",
        (0.0575, GRIND_Y, 0.2885),
        (0.0040, 0.0260, 0.0070),
        mat["black_abs"],
        root,
        0.0008,
    )
    clean_mesh_object(closure_lip, sharp_z=True)

    # Cylindrical upper Bean Hopper (Z = 0.3140 .. 0.4020 m) tapering via conical lower funnel (Z = 0.2850 .. 0.3140 m)
    hopper_profile = [
        (0.0345, 0.2845),
        (0.0380, 0.2845),
        (0.0592, 0.3140),
        (0.0596, 0.4020),
        (0.0572, 0.4020),
        (0.0568, 0.3145),
        (0.0345, 0.2860),
    ]
    hopper = lathe_solid(
        "zd17_clear_bean_hopper",
        hopper_profile,
        (GRIND_X, GRIND_Y, 0.0),
        mat["hopper_clear"],
        root,
        segments=64,
        sharp_z=True,
    )
    _ = hopper

    # Annular ring of roasted espresso beans inside lower hopper funnel leaving central throat open to view burr
    bean_ring_profile = [
        (0.0235, 0.2920),
        (0.0375, 0.2920),
        (0.0550, 0.3320),
        (0.0310, 0.3280),
    ]
    beans = lathe_solid(
        "zd17_hopper_bean_charge",
        bean_ring_profile,
        (GRIND_X, GRIND_Y, 0.0),
        mat["bean_roast"],
        root,
        segments=48,
        sharp_z=True,
    )
    _ = beans


def build_collar(root, mat):
    collar = empty("zd17_collar", COLLAR_ORIGIN, root)
    collar["joint_type"] = "hinge"
    collar["joint_name"] = "zd17_collar_dial"
    collar["axis_blender"] = "+Z"
    collar["range_rad"] = [0.0, 5.236]

    # Stepped stainless/alloy Grind Adjustment Collar (p. 1, p. 4, p. 5, p. 10 Fig. 10)
    ring = lathe_solid(
        "zd17_collar_ring",
        [
            (0.0355, -0.0120),
            (0.0478, -0.0120),
            (0.0472, -0.0020),
            (0.0445, -0.0010),
            (0.0445, 0.0065),
            (0.0355, 0.0065),
        ],
        (0.0, 0.0, 0.0),
        mat["collar_alloy"],
        collar,
        segments=64,
        sharp_z=True,
    )
    _ = ring

    # Dark grind-scale band + 36 knurled grip ribs
    scale_band = lathe_solid(
        "zd17_collar_scale_band",
        [
            (0.0442, 0.0005),
            (0.0450, 0.0005),
            (0.0450, 0.0055),
            (0.0442, 0.0055),
        ],
        (0.0, 0.0, 0.0),
        mat["black_abs"],
        collar,
        segments=64,
        sharp_z=True,
    )
    _ = scale_band

    for idx in range(36):
        ang = idx * math.tau / 36
        rx = 0.0474 * math.cos(ang)
        ry = 0.0474 * math.sin(ang)
        rib = box(
            f"zd17_collar_knurl_{idx:02d}",
            (rx, ry, -0.0070),
            (0.0014, 0.0014, 0.0080),
            mat["chrome"],
            collar,
            0.0,
        )
        rib.rotation_euler.z = ang
        bpy.context.view_layer.objects.active = rib
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        clean_mesh_object(rib, sharp_z=True)

    # Twin collar grip tabs (p. 10 Fig. 10)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        tab = box(
            f"zd17_collar_grip_tab_{side_name}",
            (side_sign * 0.0485, 0.0, -0.0055),
            (0.0035, 0.0160, 0.0090),
            mat["chrome"],
            collar,
            0.0006,
        )
        clean_mesh_object(tab, sharp_z=True)

    # 'Scale Lock Switch' (Lock <-> Unlock) on front-right of collar skirt (p. 5 & p. 10 Fig. 10)
    lock_ang = math.radians(-52.0)
    lx = 0.0476 * math.cos(lock_ang)
    ly = 0.0476 * math.sin(lock_ang)
    lock_frame = box(
        "zd17_scale_lock_bezel",
        (lx, ly, -0.0065),
        (0.0024, 0.0120, 0.0068),
        mat["black_abs"],
        collar,
        0.0003,
    )
    lock_frame.rotation_euler.z = lock_ang
    bpy.context.view_layer.objects.active = lock_frame
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(lock_frame, sharp_z=True)

    lock_slider = box(
        "zd17_collar_dial_lever",
        (1.02 * lx, 1.02 * ly, -0.0065),
        (0.0022, 0.0052, 0.0048),
        mat["chrome"],
        collar,
        0.0003,
    )
    lock_slider.rotation_euler.z = lock_ang
    bpy.context.view_layer.objects.active = lock_slider
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(lock_slider, sharp_z=True)
    return collar


def build_burr_rotor(root, mat):
    burr = empty("zd17_burr_rotor", BURR_ORIGIN, root)
    burr["joint_type"] = "hinge"
    burr["joint_name"] = "zd17_burr_spin"
    burr["axis_blender"] = "+Z"
    burr["range_rad"] = [-1000.0, 1000.0]

    # 40 mm (radius 0.020 m) hardened stainless conical burr core
    cone = lathe_solid(
        "zd17_conical_burr_40mm",
        [
            (0.0050, -0.0080),
            (0.0200, -0.0080),
            (0.0195, -0.0020),
            (0.0115, 0.0150),
            (0.0050, 0.0150),
        ],
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        burr,
        segments=48,
        sharp_z=True,
    )
    _ = cone

    # 7 helical/angled pre-breaker cutting flutes visible down hopper throat
    for idx in range(7):
        ang = idx * math.tau / 7
        fx = 0.0135 * math.cos(ang)
        fy = 0.0135 * math.sin(ang)
        flute = box(
            f"zd17_burr_flute_{idx}",
            (fx, fy, 0.0035),
            (0.0090, 0.0022, 0.0180),
            mat["chrome"],
            burr,
            0.0003,
        )
        flute.rotation_euler = (math.radians(18.0), math.radians(-24.0), ang)
        bpy.context.view_layer.objects.active = flute
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        clean_mesh_object(flute, sharp_z=False)

    clean_cylinder(
        "zd17_burr_spindle_nut",
        (0.0, 0.0, 0.0185),
        0.0068,
        0.0070,
        mat["chrome"],
        burr,
        vertices=6,
        bevel=0.0006,
        sharp_z=True,
    )
    return burr


def build_pf_trigger(root, mat):
    trig = empty("zd17_pf_trigger", PF_TRIGGER_ORIGIN, root)
    trig["joint_type"] = "slide"
    trig["joint_name"] = "zd17_trigger_press"
    trig["axis_blender"] = "+Y"
    trig["range_m"] = [0.0, 0.006]

    # Circular portafilter tact switch on rear alcove wall (p. 1, p. 4 inset, p. 8)
    clean_cylinder(
        "zd17_microswitch_plunger",
        (0.0, 0.0160, 0.0080),
        0.0052,
        0.0180,
        mat["chrome"],
        trig,
        axis="Y",
        vertices=32,
        bevel=0.0005,
        sharp_z=False,
    )
    clean_cylinder(
        "zd17_microswitch_cap",
        (0.0, 0.0065, 0.0080),
        0.0058,
        0.0024,
        mat["black_abs"],
        trig,
        axis="Y",
        vertices=32,
        bevel=0.0004,
        sharp_z=False,
    )
    return trig


def build_hopper_lid(root, mat):
    lid = empty("zd17_hopper_lid", HOPPER_LID_ORIGIN, root)
    lid["joint_type"] = "slide"
    lid["joint_name"] = "zd17_lid_lift"
    lid["axis_blender"] = "+Z"
    lid["range_m"] = [0.0, 0.060]

    # Gently domed clear/tinted lid matching p. 1, p. 4, p. 5; top crown hits exact Z_local = +0.0080 m -> world Z = 0.4100 m
    lathe_solid(
        "zd17_hopper_lid_disk",
        [
            (0.0545, -0.0050),
            (0.0568, -0.0050),
            (0.0568, 0.0000),
            (0.0600, 0.0000),
            (0.0600, 0.0042),
            (0.0520, 0.0060),
            (0.0320, 0.0074),
            (0.0120, 0.0080),
            (0.0000, 0.0080),
            (0.0000, -0.0012),
            (0.0545, -0.0012),
        ],
        (0.0, 0.0, 0.0),
        mat["lid_tint"],
        lid,
        segments=64,
        sharp_z=True,
    )
    return lid


def build_portafilter(root, mat):
    pf = empty("zd17_portafilter", PF_REST_POSE, root)
    pf["accessory_role"] = "58 mm stainless double-spout espresso portafilter"
    pf["mass_kg"] = 0.480

    # Forged 58 mm stainless basket head (Z_local = -0.0140 .. +0.0140 m -> world Z = 0.1120 .. 0.1400 m)
    lathe_solid(
        "zd17_pf_basket_head",
        [
            (0.0290, 0.0140),
            (0.0350, 0.0140),
            (0.0350, 0.0085),
            (0.0332, 0.0085),
            (0.0322, -0.0140),
            (0.0220, -0.0140),
            (0.0220, -0.0105),
            (0.0286, -0.0085),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome"],
        pf,
        segments=56,
        sharp_z=True,
    )

    clean_cylinder(
        "zd17_pf_filter_basket_floor",
        (0.0, 0.0, -0.0085),
        0.0286,
        0.0020,
        mat["steel"],
        pf,
        vertices=48,
        bevel=0.0,
        sharp_z=True,
    )

    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        ear = box(
            f"zd17_pf_bayonet_ear_{side_name}",
            (side_sign * 0.0365, 0.0, 0.0105),
            (0.0060, 0.0180, 0.0048),
            mat["chrome"],
            pf,
            0.0006,
        )
        clean_mesh_object(ear, sharp_z=True)

    spout_manifold = box(
        "zd17_pf_spout_manifold",
        (0.0, 0.0, -0.0175),
        (0.0320, 0.0140, 0.0070),
        mat["chrome"],
        pf,
        0.0010,
    )
    clean_mesh_object(spout_manifold, sharp_z=False)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        clean_cylinder(
            f"zd17_pf_spout_{side_name}",
            (side_sign * 0.0125, -0.0020, -0.0235),
            0.0048,
            0.0090,
            mat["chrome"],
            pf,
            vertices=24,
            bevel=0.0004,
            sharp_z=True,
        )

    clean_cylinder(
        "zd17_pf_handle_neck",
        (0.0, -0.0440, 0.0010),
        0.0085,
        0.0240,
        mat["chrome"],
        pf,
        axis="Y",
        vertices=32,
        bevel=0.0006,
        sharp_z=False,
    )

    clean_cylinder(
        "zd17_pf_ergonomic_handle",
        (0.0, -0.1080, 0.0000),
        0.0135,
        0.1060,
        mat["black_abs"],
        pf,
        axis="Y",
        vertices=36,
        bevel=0.0020,
        sharp_z=False,
    )

    clean_cylinder(
        "zd17_pf_handle_pommel",
        (0.0, -0.1635, 0.0000),
        0.0132,
        0.0060,
        mat["chrome"],
        pf,
        axis="Y",
        vertices=36,
        bevel=0.0010,
        sharp_z=False,
    )

    socket = empty("vessel_socket", (0.0, -0.1080, 0.0000), pf)
    socket["site_role"] = "58 mm portafilter handle grasp socket"
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


def animate_timeline(collar, burr, trig, lid, pf):
    keyframes = (
        # Frame 1..20: Rest pose
        (1, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
        # Frame 55: Open inspection pose (hopper lid lifted +48 mm, collar dialed, portafilter pulled forward exposing alcove/fork/tact switch)
        (55, 1.85, 3.14, 0.0, 0.048, (0.0, -0.1650, 0.1220), (math.radians(-6.0), 0.0, 0.0)),
        # Frame 85: Active grinding pose (lid seated, portafilter pressed in depressing tact switch +5.5 mm, burr spinning)
        (85, 1.85, 25.13, 0.0055, 0.0, (0.0, -0.0785, 0.1260), (0.0, 0.0, 0.0)),
        # Frame 120: Rest pose restored
        (120, 0.0, 0.0, 0.0, 0.0, PF_REST_POSE, (0.0, 0.0, 0.0)),
    )
    for fno, col_rz, burr_rz, trig_dy, lid_dz, pf_loc, pf_rot in keyframes:
        collar.rotation_euler = (0.0, 0.0, col_rz)
        collar.keyframe_insert(data_path="rotation_euler", frame=fno)

        burr.rotation_euler = (0.0, 0.0, burr_rz)
        burr.keyframe_insert(data_path="rotation_euler", frame=fno)

        trig.location = (PF_TRIGGER_ORIGIN[0], PF_TRIGGER_ORIGIN[1] + trig_dy, PF_TRIGGER_ORIGIN[2])
        trig.keyframe_insert(data_path="location", frame=fno)

        lid.location = (HOPPER_LID_ORIGIN[0], HOPPER_LID_ORIGIN[1], HOPPER_LID_ORIGIN[2] + lid_dz)
        lid.keyframe_insert(data_path="location", frame=fno)

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
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100

    scene.world = bpy.data.worlds.new("ZD17OD_studio_world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.58, 0.63, 0.70, 1.0)
    bg.inputs["Strength"].default_value = 0.52
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.15

    ground = material("zd17_studio_ground", (0.29, 0.31, 0.34, 1.0), 0.0, 0.86)
    bpy.ops.mesh.primitive_plane_add(size=120.0, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio ground"
    floor.data.materials.append(ground)

    area_light("Left key softbox", (-0.95, -1.25, 1.25), (0.0, -0.03, 0.21), 135.0, 1.10)
    area_light("Right fill stripbox", (1.05, -0.45, 0.95), (0.0, -0.02, 0.21), 90.0, 0.90)
    area_light("Rear rim softbox", (-0.10, 1.10, 1.15), (0.0, 0.0, 0.24), 105.0, 0.95)
    area_light("Front chute fill", (0.0, -1.20, 0.36), (0.0, -0.06, 0.18), 42.0, 0.65)

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


def compute_grinder_bounds(root, pf):
    bpy.context.view_layer.update()
    excluded = {pf, *pf.children_recursive}
    grinder_meshes = [o for o in root.children_recursive if o.type == "MESH" and o not in excluded]
    all_meshes = [o for o in root.children_recursive if o.type == "MESH"]
    g_low, g_high = bounds(grinder_meshes)
    a_low, a_high = bounds(all_meshes)
    return g_low, g_high, g_high - g_low, a_low, a_high, a_high - a_low


def inspect_exported_glb():
    """Re-import exported GLB in a clean Blender factory scene and write inspection-report.json."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb_path = ASSETS / f"{NAME}.glb"
    pf_glb_path = ASSETS / f"{NAME}-portafilter.glb"
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["zd17_grinder"]
    collar = objects["zd17_collar"]
    burr = objects["zd17_burr_rotor"]
    trig = objects["zd17_pf_trigger"]
    lid = objects["zd17_hopper_lid"]
    pf = objects["zd17_portafilter"]
    socket = objects["vessel_socket"]
    plinth = objects["zd17_base_plinth"]

    for child in (collar, burr, trig, lid, pf):
        assert child.parent == root, child.name
    assert socket.parent == pf
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objects)

    bpy.context.view_layer.update()
    excluded = {pf, *pf.children_recursive}
    g_low, g_high = bounds(o for o in root.children_recursive if o not in excluded)
    dims = g_high - g_low
    for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Published WPM ZD-17OD envelope")
    near(g_low.z, 0.0, "Rubber foot contact plane Z=0.000")
    near(g_high.z, HEIGHT, "Hopper lid crown Z=0.410")

    # Fault-injection guard: shifting plinth by +8 mm in X must fail envelope check
    orig_x = plinth.location.x
    plinth.location.x += 0.008
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        fl, fh = bounds(o for o in root.children_recursive if o not in excluded)
        near((fh - fl).x, WIDTH, "Fault check")
    except AssertionError:
        fault_detected = True
    plinth.location.x = orig_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope fault-injection guard failed"

    # Verify all 4 feet touch Z = 0.000 m
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("zd17_foot_"):
            fl, _ = bounds(obj.children_recursive)
            near(fl.z, 0.0, f"Foot contact plane {obj.name}")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Raycast downward onto fork support pads (with portafilter moved aside)
    orig_pf_loc = pf.location.copy()
    pf.location = Vector((0.0, -0.30, 0.12))
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    fork_hits = []
    for sx in (-0.032, 0.032):
        hit, pt, nrm, _f, hobj, _m = bpy.context.scene.ray_cast(
            depsgraph, Vector((sx, -0.084, 0.145)), Vector((0.0, 0.0, -1.0))
        )
        assert hit and hobj is not None and "fork" in hobj.name, (sx, hobj)
        near(pt.z, 0.1120, "Fork support pad Z=0.1120")
        assert nrm.z > 0.99, nrm
        fork_hits.append(pt.z)
    pf.location = orig_pf_loc
    bpy.context.view_layer.update()

    required_meshes = {
        "zd17_base_plinth",
        "zd17_stainless_tower",
        "zd17_upper_control_crown",
        "zd17_lcd_active_panel",
        "zd17_antistatic_grounds_chute",
        "zd17_fork_arm_left",
        "zd17_fork_arm_right",
        "zd17_grounds_catch_tray",
        "zd17_clear_bean_hopper",
        "zd17_hopper_closure_arm",
        "zd17_collar_ring",
        "zd17_conical_burr_40mm",
        "zd17_microswitch_plunger",
        "zd17_hopper_lid_disk",
        "zd17_pf_basket_head",
        "zd17_pf_ergonomic_handle",
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
        "grinder_bounds_min_m": [round(v, 6) for v in g_low],
        "grinder_bounds_max_m": [round(v, 6) for v in g_high],
        "grinder_dimensions_m": [round(v, 6) for v in dims],
        "fork_support_plane_z_m": [round(v, 6) for v in fork_hits],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported wpm-zd-17od.glb; verify exact 125x235x410 mm grinder envelope, Z=0.000 m "
            "rubber feet plane, Z=0.410 m hopper lid crown, Z=0.1120 m hands-free portafilter fork plane, "
            "fault-injection width guard, articulated body hierarchy, and zero mesh-quality defects."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene
    scene.name = "WPM ZD-17OD - Japan 100V Espresso Grinder"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for m_name, f_no in (
        ("Rest", 1),
        ("Hopper & collar inspection", 55),
        ("Active portafilter grind", 85),
        ("Rest restored", 120),
    ):
        scene.timeline_markers.new(m_name, frame=f_no)

    lcd_img = generate_lcd_texture(ASSETS / "zd17-lcd-panel.png", ASSETS / "zd17-lcd-screen.png")
    mat = surfaces(lcd_img)

    root = empty("zd17_grinder", (0.0, 0.0, 0.0))
    root["manufacturer"] = "WPM (Welhome Pro)"
    root["model"] = "ZD-17OD"
    root["sku_region"] = "Japan 100V AC 50/60Hz 130W"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_grinder_mass_kg"] = 3.800
    root["portafilter_mass_kg"] = 0.480

    build_grinder_body(root, mat)
    collar = build_collar(root, mat)
    burr = build_burr_rotor(root, mat)
    trig = build_pf_trigger(root, mat)
    lid = build_hopper_lid(root, mat)
    pf = build_portafilter(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    # Convert only FONT/CURVE objects (such as 'WPM' wordmark) and clean them without clobbering sharp_z on other meshes
    curve_names = {
        o.name for o in root.children_recursive if o.type in {"CURVE", "FONT"}
    }
    convert_curves([root, collar, burr, trig, lid, pf])
    for cname in curve_names:
        if cname in bpy.data.objects and bpy.data.objects[cname].type == "MESH":
            clean_mesh_object(bpy.data.objects[cname], sharp_z=True)

    g_low, g_high, g_dims, a_low, a_high, a_dims = compute_grinder_bounds(root, pf)
    for actual, expected in zip(g_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 2e-4, (g_dims, (WIDTH, DEPTH, HEIGHT))
    assert abs(g_low.z - 0.0) <= 1e-5, g_low

    # Export static rest-pose GLBs at frame 1 with animation data cleared
    export_glbs(root, pf)

    # Re-apply timeline animation for .blend authoring and studio renders
    animate_timeline(collar, burr, trig, lid, pf)

    appliance_col = bpy.data.collections.new("WPM ZD-17OD appliance")
    scene.collection.children.link(appliance_col)
    move_objects([root, *root.children_recursive], appliance_col)

    camera = setup_studio(scene)
    views = (
        ("studio-main", (0.72, -1.18, 0.62), (0.0, -0.04, 0.205), 0.56, 1),
        ("studio-front", (0.0, -1.35, 0.205), (0.0, 0.0, 0.205), 0.50, 1),
        ("studio-right", (1.35, -0.04, 0.205), (0.0, -0.04, 0.205), 0.54, 1),
        ("studio-open", (0.76, -1.22, 0.68), (0.0, -0.05, 0.235), 0.62, 55),
        ("studio-active", (0.58, -1.05, 0.44), (0.0, -0.06, 0.175), 0.40, 85),
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
        "title": "WPM ZD-17OD On-Demand Conical Burr Espresso Grinder (Japan SKU)",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "grinder_bounds_min_m": [round(v, 6) for v in g_low],
        "grinder_bounds_max_m": [round(v, 6) for v in g_high],
        "grinder_dimensions_m": [round(v, 6) for v in g_dims],
        "with_portafilter_bounds_min_m": [round(v, 6) for v in a_low],
        "with_portafilter_bounds_max_m": [round(v, 6) for v in a_high],
        "with_portafilter_dimensions_m": [round(v, 6) for v in a_dims],
        "published_grinder_mass_kg": 3.800,
        "detachable_portafilter_mass_kg": 0.480,
        "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 130 W",
        "burr_spec": "40 mm hardened stainless-steel conical burr, belt-driven dual-bearing spindle",
        "hopper_capacity_g": 450,
        "grind_rate_g_per_s": [1.5, 2.0],
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
