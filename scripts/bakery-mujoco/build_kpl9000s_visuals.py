"""Build the Japanese Aicohsha Kenmix Aicoh Chef PRO KPL9000S planetary mixer in Blender 5.2.

Metres, Z up, bowl towards -Y operator front, pedestal column towards +Y rear, Z = 0.000 m at rubber feet bottom.
Follows official Aicohsha engineering drawing P-88512D (2022-06-08) and KPL9000S product brochure (pp. 1-2):
- Closed operating envelope: 240 x 400 x 350 mm (0.240 x 0.400 x 0.350 m; 390 mm base length + 10 mm front bowl overhang).
- Tilt-head lifted envelope (0.68 rad / 39.0 deg about -X at (0.0, +0.1488, +0.1847) m): 240 x 490 x 520 mm (0.240 x 0.490 x 0.520 m).
- Removable 6.7 L SUS304 stainless bowl: Ø240 mm rolled rim, 227 mm height, Ø200 mm bayonet base ring seated at Z = 0.0120 m.
- Published mass: 8.600 kg total (7.500 kg mixer assembly + 1.100 kg removable 6.7 L stainless bowl).
"""

from __future__ import annotations

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
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/aicohsha-kpl9000s"
REFERENCES = ROOT / "docs/equipment/aicohsha-kpl9000s"
AICOH_IMAGES = ROOT / "docs/equipment/aicoh-ms-30/images"
NAME = "aicohsha-kpl9000s"

WIDTH = 0.2400
DEPTH = 0.4000
HEIGHT = 0.3500

LIFTED_DEPTH = 0.4900
LIFTED_HEIGHT = 0.5200

BOWL_Y = -0.0800
BOWL_SEAT_Z = 0.0120
BOWL_HEIGHT = 0.2270  # P-88512D: 227 mm bowl height, Ø240 mm rim, Ø200 mm base
BOWL_ORIGIN = (0.0, BOWL_Y, BOWL_SEAT_Z)

# Exact rear-upper pivot solved so 0.68 rad tilt yields H_open = 0.5200 m and D_open = 0.4900 m
HEAD_PIVOT = (0.0, 0.1488, 0.1847)
HEAD_TILT_MAX_RAD = 0.68

# Head-local child pivots
PLANETARY_LOCAL = (0.0, BOWL_Y - HEAD_PIVOT[1], 0.2480 - HEAD_PIVOT[2])   # world (0.0, -0.0800, 0.2480)
WHIP_LOCAL = (0.0, -0.0260, -0.0080)                                      # world (0.0, -0.1060, 0.2400)
DIAL_LOCAL = (0.0940, 0.0850 - HEAD_PIVOT[1], 0.2680 - HEAD_PIVOT[2])     # world (0.0940, +0.0850, 0.2680)
GUARD_LOCAL = (0.0, 0.0150 - HEAD_PIVOT[1], 0.2430 - HEAD_PIVOT[2])       # world (0.0, +0.0150, 0.2430)

FOOT_POSITIONS = (
    ("kpl_foot_fl", -0.0680, -0.1420),
    ("kpl_foot_fr", 0.0680, -0.1420),
    ("kpl_foot_ml", -0.0800, 0.0380),
    ("kpl_foot_mr", 0.0800, 0.0380),
    ("kpl_foot_rear", 0.0, 0.1680),
)


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    metallic: float = 0.0,
    roughness: float = 0.30,
    emission: float = 0.0,
    coat: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Alpha"].default_value = color[3]
        if metallic < 0.5:
            bsdf.inputs["Specular IOR Level"].default_value = 0.28
        if coat > 0.0:
            bsdf.inputs["Coat Weight"].default_value = coat
            bsdf.inputs["Coat Roughness"].default_value = 0.14
        if emission > 0.0:
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = emission
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission)
    return mat


def make_badge_texture_material() -> bpy.types.Material:
    """Create and pack a crisp bitmap texture (`kenmix-side-badge.png`) for the side emblem."""
    w, h = 512, 160
    img = bpy.data.images.new("kenmix_side_badge", width=w, height=h, alpha=True)
    pixels = [0.0] * (w * h * 4)

    for y in range(h):
        v = y / float(h - 1)
        for x in range(w):
            u = x / float(w - 1)
            idx = (y * w + x) * 4
            # Metallic silver outer border (2% margin)
            if u < 0.020 or u > 0.980 or v < 0.050 or v > 0.950:
                r, g, b = 0.72, 0.75, 0.78
            # White separator line between upper crimson banner and lower navy bar
            elif 0.36 <= v <= 0.42:
                r, g, b = 0.90, 0.92, 0.94
            # Upper crimson Kenmix field
            elif v > 0.42:
                r, g, b = 0.68, 0.035, 0.050
            # Lower AICOH navy field
            else:
                r, g, b = 0.030, 0.095, 0.310
            pixels[idx : idx + 4] = [r, g, b, 1.0]

    img.pixels[:] = pixels
    badge_path = ASSETS / "kenmix-side-badge.png"
    img.filepath_raw = str(badge_path)
    img.file_format = "PNG"
    img.save()
    img.pack()

    mat = make_material("kpl_badge_decal", (0.68, 0.04, 0.05, 1.0), metallic=0.10, roughness=0.24, coat=0.25)
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "CLIP"
    if bsdf is not None:
        tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def palette() -> dict[str, bpy.types.Material]:
    return {
        # Pearl Silver-White clean-coat die-cast lower body & L-pedestal (catalogue.pdf p. 1: 汚れがつきにくいボディ)
        "white_coat": make_material("kpl_white_cleancoat", (0.84, 0.85, 0.87, 1.0), 0.16, 0.22, coat=0.38),
        # Satin Silver Metallic / Brushed Stainless upper motor head crown & trim (catalogue.pdf p. 1 two-tone crown)
        "crown_silver": make_material("kpl_satin_crown_silver", (0.62, 0.65, 0.69, 1.0), 0.78, 0.25, coat=0.15),
        "silver_coat": make_material("kpl_silver_diecast", (0.70, 0.73, 0.76, 1.0), 0.56, 0.26, coat=0.25),
        "steel": make_material("kpl_brushed_stainless", (0.64, 0.67, 0.71, 1.0), 0.88, 0.22),
        "polished": make_material("kpl_polished_sus304", (0.77, 0.80, 0.83, 1.0), 0.94, 0.15),
        "dark_trim": make_material("kpl_charcoal_polymer", (0.050, 0.056, 0.064, 1.0), 0.08, 0.32),
        "bezel_grey": make_material("kpl_switch_bezel_grey", (0.28, 0.30, 0.33, 1.0), 0.18, 0.34),
        "rubber": make_material("kpl_elastomer_foot", (0.025, 0.028, 0.032, 1.0), 0.02, 0.62),
        "kenmix_red": make_material("kpl_kenmix_red", (0.68, 0.035, 0.050, 1.0), 0.08, 0.24, coat=0.25),
        "aicoh_navy": make_material("kpl_aicoh_navy", (0.030, 0.095, 0.310, 1.0), 0.12, 0.26, coat=0.25),
        "start_green": make_material("kpl_start_button_green", (0.05, 0.52, 0.18, 1.0), 0.06, 0.24, coat=0.30),
        "stop_red": make_material("kpl_stop_button_red", (0.72, 0.05, 0.05, 1.0), 0.06, 0.24, coat=0.30),
        "ink_white": make_material("kpl_white_legend", (0.95, 0.96, 0.97, 1.0), 0.05, 0.26),
        "badge_decal": make_badge_texture_material(),
        "studio_floor": make_material("kpl_studio_floor", (0.31, 0.33, 0.36, 1.0), 0.0, 0.86),
    }


def empty(name: str, position: tuple[float, float, float], parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = position
    obj.empty_display_size = 0.020
    return obj


def finish(
    obj: bpy.types.Object,
    name: str,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    bevel: float = 0.0,
) -> bpy.types.Object:
    obj.name = name
    if obj.data is not None:
        obj.data.materials.clear()
        obj.data.materials.append(surface)
    obj.parent = parent
    if bevel > 0.0 and obj.type == "MESH":
        mod = obj.modifiers.new("EdgeBevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    if obj.type == "MESH":
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def rounded_rect_loop(
    x_half: float,
    y_min: float,
    y_max: float,
    r_corner: float,
    corner_segs: int = 8,
    support_d: float = 0.0003,
) -> list[tuple[float, float]]:
    """Build a 2D counter-clockwise rounded-rectangle loop with 0.3 mm tangent support points around each corner arc.

    The 0.3 mm coplanar tangent points isolate the flat X/Y side walls from the corner arcs so vertex normals
    on the flat side walls are 100% perpendicular without custom split normals.
    """
    r = min(r_corner, x_half - 0.002, (y_max - y_min) * 0.45)
    sd = min(support_d, x_half - r - 0.0005, (y_max - y_min) * 0.5 - r - 0.0005)
    pts: list[tuple[float, float]] = []

    corners = (
        (x_half - r, y_max - r, 0.0, math.pi * 0.5, (x_half, y_max - r - sd), (x_half - r - sd, y_max)),
        (-x_half + r, y_max - r, math.pi * 0.5, math.pi, (-x_half + r + sd, y_max), (-x_half, y_max - r - sd)),
        (-x_half + r, y_min + r, math.pi, math.pi * 1.5, (-x_half, y_min + r + sd), (-x_half + r + sd, y_min)),
        (x_half - r, y_min + r, math.pi * 1.5, math.tau, (x_half - r - sd, y_min), (x_half, y_min + r + sd)),
    )
    for cx, cy, a0, a1, pre_pt, post_pt in corners:
        if sd > 1e-5:
            pts.append(pre_pt)
        for s in range(corner_segs + 1):
            ang = a0 + (a1 - a0) * s / corner_segs
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        if sd > 1e-5:
            pts.append(post_pt)
    return pts


def pedestal_apron_loop(
    x_half: float = 0.0950,
    y_rear: float = 0.1995,
    bowl_y: float = BOWL_Y,
    r_front: float = 0.1100,
    r_rear: float = 0.0080,
) -> list[tuple[float, float]]:
    """Build the P-88512D 390 mm L-pedestal base planform: Ø220 mm circular front apron + 190 mm wide rear deck."""
    pts: list[tuple[float, float]] = []
    # Rear-right corner (around +x_half, y_rear)
    cx_rr, cy_rr = x_half - r_rear, y_rear - r_rear
    pts.append((x_half, y_rear - r_rear - 0.0003))
    for s in range(7):
        ang = (math.pi * 0.5) * s / 6
        pts.append((cx_rr + r_rear * math.cos(ang), cy_rr + r_rear * math.sin(ang)))
    pts.append((x_half - r_rear - 0.0003, y_rear))

    # Rear-left corner (around -x_half, y_rear)
    cx_rl, cy_rl = -x_half + r_rear, y_rear - r_rear
    pts.append((-x_half + r_rear + 0.0003, y_rear))
    for s in range(7):
        ang = math.pi * 0.5 + (math.pi * 0.5) * s / 6
        pts.append((cx_rl + r_rear * math.cos(ang), cy_rl + r_rear * math.sin(ang)))
    pts.append((-x_half, y_rear - r_rear - 0.0003))

    # Left side wall down to intersection with Ø220 mm front circle (x = -x_half, y = bowl_y + sqrt(r_front^2 - x_half^2))
    dy_join = math.sqrt(max(0.0, r_front * r_front - x_half * x_half))
    y_join = bowl_y + dy_join
    pts.append((-x_half, y_join + 0.0003))

    # Circular front apron arc from left join to right join around (0, bowl_y)
    ang_start = math.atan2(dy_join, -x_half)          # ~2.63 rad (+150 deg)
    ang_end = math.tau + math.atan2(dy_join, x_half)  # ~6.79 rad (+390 deg)
    arc_segs = 36
    for s in range(arc_segs + 1):
        ang = ang_start + (ang_end - ang_start) * s / arc_segs
        pts.append((r_front * math.cos(ang), bowl_y + r_front * math.sin(ang)))

    pts.append((x_half, y_join + 0.0003))
    return pts


def extrude_supported_prism(
    name: str,
    loop_xy: list[tuple[float, float]],
    z_min: float,
    z_max: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    bevel_bot: float = 0.0025,
    bevel_top: float = 0.0025,
    front_rake_y: float = 0.0,
    y_rake_pivot: float = -0.040,
    crown_arch_z: float = 0.0,
    x_half_ref: float = 0.0920,
) -> bpy.types.Object:
    """Extrude a 2D planform loop along Z with 0.3 mm vertical and cap support loops to eliminate vertical pillowing."""
    dz = z_max - z_min
    bb = min(bevel_bot, dz * 0.30)
    bt = min(bevel_top, dz * 0.30)
    sd = 0.0003

    # (z_level, radial_inset)
    levels: list[tuple[float, float]] = [
        (z_min, bb + sd),
        (z_min, bb),
    ]
    if bb > 1e-4:
        levels.append((z_min + bb * 0.35, bb * 0.42))
        levels.append((z_min + bb, 0.0))
    levels.append((z_min + bb + sd, 0.0))
    levels.append((z_max - bt - sd, 0.0))
    if bt > 1e-4:
        levels.append((z_max - bt, 0.0))
        levels.append((z_max - bt * 0.35, bt * 0.42))
    levels.append((z_max, bt))
    levels.append((z_max, bt + sd))

    cx = sum(p[0] for p in loop_xy) / len(loop_xy)
    cy = sum(p[1] for p in loop_xy) / len(loop_xy)
    n_pts = len(loop_xy)

    verts: list[tuple[float, float, float]] = []
    ring_indices: list[list[int]] = []

    for z_val, inset in levels:
        t_z = (z_val - z_min) / max(1e-6, dz)
        row: list[int] = []
        for px, py in loop_xy:
            # Optional front nose rake (for kpl_head sloped front nose)
            y_adj = py
            if front_rake_y != 0.0 and py < y_rake_pivot:
                w_front = min(1.0, (y_rake_pivot - py) / max(1e-6, y_rake_pivot - (-0.195)))
                y_adj = py + front_rake_y * t_z * w_front
            dx = px - cx
            dy = y_adj - cy
            dist = math.hypot(dx, dy)
            scale = max(0.1, (dist - inset) / max(1e-6, dist))
            vx = cx + dx * scale
            vy = cy + dy * scale
            vz = z_val
            if crown_arch_z > 0.0 and z_val >= z_max - bt - 1e-5:
                arch = max(0.0, 1.0 - (vx / max(1e-4, x_half_ref)) ** 2)
                vz += crown_arch_z * arch * ((z_val - (z_max - bt)) / max(1e-5, bt))
            row.append(len(verts))
            verts.append((vx, vy, vz))
        ring_indices.append(row)

    bot_center_idx = len(verts)
    verts.append((cx, cy, z_min))
    top_center_idx = len(verts)
    verts.append((cx, cy, z_max + crown_arch_z))

    faces: list[tuple[int, ...]] = []
    # Bottom cap fan (clockwise viewed from +Z -> downward normal)
    r_bot = ring_indices[0]
    for i in range(n_pts):
        inext = (i + 1) % n_pts
        faces.append((bot_center_idx, r_bot[inext], r_bot[i]))

    # Side & bevel quad strips
    for r_idx in range(len(ring_indices) - 1):
        r0 = ring_indices[r_idx]
        r1 = ring_indices[r_idx + 1]
        for i in range(n_pts):
            inext = (i + 1) % n_pts
            faces.append((r0[i], r0[inext], r1[inext], r1[i]))

    # Top cap fan (counter-clockwise viewed from +Z -> upward normal)
    r_top = ring_indices[-1]
    for i in range(n_pts):
        inext = (i + 1) % n_pts
        faces.append((top_center_idx, r_top[i], r_top[inext]))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    # Auto-generate planar UVs on side walls if using a textured material
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for loop_idx in poly.loop_indices:
            v = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            uv_layer.data[loop_idx].uv = ((v.y + 0.20) * 2.5, (v.z + 0.20) * 2.5)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def box(
    name: str,
    position: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    bevel: float = 0.001,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=position)
    obj = bpy.context.object
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, surface, parent, bevel)


def badge_plate(
    name: str,
    position: tuple[float, float, float],
    width_y: float,
    height_z: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    right_side: bool = True,
) -> bpy.types.Object:
    """Create a thin side badge decal plate with 0..1 UVs mapped cleanly to kenmix-side-badge.png."""
    dx = 0.0004
    hy = width_y * 0.5
    hz = height_z * 0.5
    x_out = dx if right_side else -dx
    verts = [
        (0.0, -hy, -hz),
        (0.0, hy, -hz),
        (0.0, hy, hz),
        (0.0, -hy, hz),
        (x_out, -hy, -hz),
        (x_out, hy, -hz),
        (x_out, hy, hz),
        (x_out, -hy, hz),
    ]
    if right_side:
        faces = [
            (4, 5, 6, 7),
            (0, 3, 2, 1),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ]
        front_uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    else:
        faces = [
            (5, 4, 7, 6),
            (0, 1, 2, 3),
            (0, 4, 5, 1),
            (1, 5, 6, 2),
            (2, 6, 7, 3),
            (3, 7, 4, 0),
        ]
        front_uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for p_idx, poly in enumerate(mesh.polygons):
        for l_i, loop_idx in enumerate(poly.loop_indices):
            uv_layer.data[loop_idx].uv = front_uvs[l_i] if p_idx == 0 else (0.02, 0.02)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    return finish(obj, name, surface, parent, bevel=0.0)


def cylinder(
    name: str,
    position: tuple[float, float, float],
    radius: float,
    depth: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    axis: str = "Z",
    vertices: int = 36,
    bevel: float | None = None,
) -> bpy.types.Object:
    """Build a support-looped cylinder so flat end caps and cylindrical barrel have zero normal bleeding."""
    bev = min(0.0006, depth * 0.18, radius * 0.18) if bevel is None else min(bevel, depth * 0.30, radius * 0.30)
    hz = depth * 0.5
    sd = min(0.00025, (hz - bev) * 0.35, (radius - bev) * 0.25)

    loop_rz: list[tuple[float, float]] = [(0.0, -hz)]
    if radius - bev - sd > 1e-5:
        loop_rz.append((radius - bev - sd, -hz))
    if bev > 1e-5:
        loop_rz.append((radius - bev, -hz))
        loop_rz.append((radius, -hz + bev))
    else:
        loop_rz.append((radius, -hz))
    if sd > 1e-5:
        loop_rz.append((radius, -hz + bev + sd))
        loop_rz.append((radius, hz - bev - sd))
    if bev > 1e-5:
        loop_rz.append((radius, hz - bev))
        loop_rz.append((radius - bev, hz))
    else:
        loop_rz.append((radius, hz))
    if radius - bev - sd > 1e-5:
        loop_rz.append((radius - bev - sd, hz))
    loop_rz.append((0.0, hz))

    obj = lathe_solid(name, loop_rz, surface, parent, segments=vertices)
    obj.location = position
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2.0
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2.0
    return obj


def tube(
    name: str,
    points: list[tuple[float, float, float]],
    radius: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    cyclic: bool = False,
    smooth: bool = False,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    curve.use_fill_caps = True
    if smooth:
        curve.resolution_u = 10
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for pt, coord in zip(spline.bezier_points, points):
            pt.co = coord
            pt.handle_left_type = "AUTO"
            pt.handle_right_type = "AUTO"
    else:
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for pt, coord in zip(spline.points, points):
            pt.co = (*coord, 1.0)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent)


def side_text(
    name: str,
    value: str,
    position: tuple[float, float, float],
    size: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    font: bpy.types.VectorFont,
    right_side: bool = True,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = 0.00020
    curve.resolution_u = 2
    curve.font = font
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0 if right_side else -math.pi / 2.0)
    return finish(obj, name, surface, parent)


def lathe_solid(
    name: str,
    loop_rz: list[tuple[float, float]],
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    segments: int = 64,
) -> bpy.types.Object:
    """Revolve a closed (r >= 0, z) cross-section loop around local Z with 64 segments (divisible by 4)."""
    verts: list[tuple[float, float, float]] = []
    ring_indices: list[list[int]] = []
    for r, z in loop_rz:
        if r <= 1e-7:
            idx = len(verts)
            verts.append((0.0, 0.0, z))
            ring_indices.append([idx] * segments)
        else:
            row = []
            for s in range(segments):
                ang = s * math.tau / segments
                row.append(len(verts))
                verts.append((r * math.cos(ang), r * math.sin(ang), z))
            ring_indices.append(row)

    faces: list[tuple[int, ...]] = []
    n_rings = len(loop_rz)
    for i in range(n_rings):
        r0 = ring_indices[i]
        r1 = ring_indices[(i + 1) % n_rings]
        for s in range(segments):
            sn = (s + 1) % segments
            a, b, c, d = r0[s], r0[sn], r1[sn], r1[s]
            quad = []
            for v_idx in (a, b, c, d):
                if v_idx not in quad:
                    quad.append(v_idx)
            if len(quad) >= 3:
                faces.append(tuple(quad))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def clean_mesh_object(obj: bpy.types.Object, flat_caps: bool = False) -> bpy.types.Object:
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    for mod in list(obj.modifiers):
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=list(bm.edges))
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    seen: set[tuple[tuple[float, float, float], ...]] = set()
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
        poly.use_smooth = not (flat_caps and abs(poly.normal.z) > 0.995)
    return obj


def convert_and_clean_tree(root: bpy.types.Object) -> None:
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in list(root.children_recursive):
        if obj.type in {"CURVE", "FONT"}:
            mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
            repl = bpy.data.objects.new(obj.name + "_tmp", mesh)
            bpy.context.scene.collection.objects.link(repl)
            repl.parent = obj.parent
            repl.matrix_basis = obj.matrix_basis.copy()
            orig_name = obj.name
            bpy.data.objects.remove(obj, do_unlink=True)
            repl.name = orig_name
    bpy.context.view_layer.update()
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            flat = obj.name in {"Rear base rating plate", "Motor head rear vent plate"} or obj.name.endswith("_pad")
            clean_mesh_object(obj, flat_caps=flat)


def build_base_and_pedestal(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    # Five non-slip rubber feet touching exact Z = 0.0000 m (Z in [0.0000, 0.0080])
    for fname, fx, fy in FOOT_POSITIONS:
        f_emp = empty(fname, (fx, fy, 0.0), root)
        f_emp["contact_plane_z_m"] = 0.0
        cylinder(f"{fname}_pad", (0.0, 0.0, 0.0040), 0.0145, 0.0080, mat["rubber"], f_emp, bevel=0.0008)

    # Sculpted 390 mm L-pedestal base deck (`Lower die-cast pedestal deck`, Y in [-0.1900, +0.1995], Z in [0.0070, 0.0290])
    apron_xy = pedestal_apron_loop(x_half=0.0950, y_rear=0.1995, bowl_y=BOWL_Y, r_front=0.1100, r_rear=0.0090)
    extrude_supported_prism(
        "Lower die-cast pedestal deck",
        apron_xy,
        0.0070,
        0.0290,
        mat["white_coat"],
        root,
        bevel_bot=0.0020,
        bevel_top=0.0030,
    )

    # Raised satin-silver bowl recess collar ring (`Ø206 mm` outer, `Ø192 mm` inner around bayonet seat)
    seat_collar_rz = [
        (0.0950, 0.0250),
        (0.1030, 0.0250),
        (0.1030, 0.0315),
        (0.1005, 0.0330),
        (0.0965, 0.0330),
        (0.0950, 0.0310),
    ]
    collar_obj = lathe_solid("Front rounded bowl apron", seat_collar_rz, mat["silver_coat"], root, segments=48)
    collar_obj.location = (0.0, BOWL_Y, 0.0)

    # Recessed stainless bayonet bowl locking pad at exact Z_top = 0.0120 m (so 227 mm bowl sits at Z = 0.0120..0.2390 m!)
    cylinder("Bayonet bowl seat pad", (0.0, BOWL_Y, 0.0085), 0.0920, 0.0070, mat["steel"], root, vertices=48, bevel=0.0004)
    for lug_idx in range(3):
        ang = math.radians(30.0 + lug_idx * 120.0)
        lx = 0.0955 * math.cos(ang)
        ly = BOWL_Y + 0.0955 * math.sin(ang)
        lug = box(f"Bayonet locking lug {lug_idx + 1}", (lx, ly, 0.0160), (0.0060, 0.0180, 0.0060), mat["polished"], root, 0.0008)
        lug.rotation_euler.z = ang

    # Rear vertical column rising to meet the tilt-head parting line (with 0.3 mm support loops for zero vertical banding!)
    col_lower_xy = rounded_rect_loop(x_half=0.0940, y_min=0.0480, y_max=0.1995, r_corner=0.0110)
    extrude_supported_prism(
        "Rear column lower body",
        col_lower_xy,
        0.0270,
        0.1380,
        mat["white_coat"],
        root,
        bevel_bot=0.0020,
        bevel_top=0.0025,
    )

    col_neck_xy = rounded_rect_loop(x_half=0.0920, y_min=0.0520, y_max=0.1840, r_corner=0.0100)
    extrude_supported_prism(
        "Rear column upper neck",
        col_neck_xy,
        0.1360,
        0.1880,
        mat["white_coat"],
        root,
        bevel_bot=0.0015,
        bevel_top=0.0025,
    )

    # Exact rear datum trim plate at Y_max = +0.200000 m
    box("Rear base rating plate", (0.0, 0.1980, 0.0780), (0.1180, 0.0040, 0.0820), mat["steel"], root, bevel=0.0)

    # Rear upper hinge clevis ears around HEAD_PIVOT (0.0, +0.1488, +0.1847)
    for sx, slbl in ((-0.0660, "left"), (0.0660, "right")):
        cylinder(f"Rear hinge clevis {slbl}", (sx, HEAD_PIVOT[1], HEAD_PIVOT[2]), 0.0155, 0.0240, mat["silver_coat"], root, "X")
    cylinder("Rear hinge pivot pin", (0.0, HEAD_PIVOT[1], HEAD_PIVOT[2]), 0.0065, 0.1640, mat["polished"], root, "X")

    # Right-side sculpted chromed head-release lever (`リリースレバー`, P-88512D & catalogue.pdf p. 1)
    cylinder("Head release lever boss", (0.0925, 0.0760, 0.1620), 0.0095, 0.0080, mat["bezel_grey"], root, "X")
    box("Head release lever paddle", (0.0990, 0.0760, 0.1620), (0.0110, 0.0220, 0.0095), mat["polished"], root, 0.0020)

    # Commercial right-side push-button switches (`スタートボタン（緑）` & `ストップボタン（赤）`, P-88512D & catalogue.pdf p. 1)
    # Front-right green Start button at Y = +0.0920, Z = 0.0680; Rear-right red Stop button at Y = +0.1280, Z = 0.0680
    cylinder("Start button grey bezel", (0.0950, 0.0920, 0.0680), 0.0125, 0.0050, mat["bezel_grey"], root, "X")
    cylinder("Start push button green", (0.0982, 0.0920, 0.0680), 0.0082, 0.0055, mat["start_green"], root, "X")

    cylinder("Stop button grey bezel", (0.0950, 0.1280, 0.0680), 0.0125, 0.0050, mat["bezel_grey"], root, "X")
    cylinder("Stop push button red", (0.0985, 0.1280, 0.0680), 0.0085, 0.0060, mat["stop_red"], root, "X")

    # Rear power cord bushing (excluded from nominal 240x400x350 mm cabinet envelope check)
    utilities = empty("kpl_utilities", (0.0, 0.0, 0.0), root)
    utilities["status"] = "Rear 100V 500W power cord strain relief; excluded from nominal 240x400x350 mm envelope check"
    cylinder("Rear 100V cord strain relief", (0.0480, 0.2070, 0.0260), 0.0085, 0.0160, mat["rubber"], utilities, "Y")
    return utilities


def build_tilt_head_and_controls(
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
    font: bpy.types.VectorFont,
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    # Tilt-back upper motor head (`kpl_head`, pivot at (0.0, +0.1488, +0.1847), axis="-1 0 0", range 0 .. 0.68 rad)
    head = empty("kpl_head", HEAD_PIVOT, root)
    head["joint_name"] = "kpl_head_tilt"
    head["axis_blender"] = "-X"
    head["range_rad"] = [0.0, HEAD_TILT_MAX_RAD]

    def hloc(wx: float, wy: float, wz: float) -> tuple[float, float, float]:
        return (wx - HEAD_PIVOT[0], wy - HEAD_PIVOT[1], wz - HEAD_PIVOT[2])

    # 1. Lower Pearl Silver-White motor head casting (`Motor head main upper casting`, world Z = 0.2460 .. 0.3060)
    # Front nose slopes backward from Y = -0.1945 at Z = 0.2460 to Y = -0.1890 at Z = 0.3060
    head_lower_xy = rounded_rect_loop(
        x_half=0.0920,
        y_min=-0.1945 - HEAD_PIVOT[1],
        y_max=0.1995 - HEAD_PIVOT[1],
        r_corner=0.0130,
    )
    extrude_supported_prism(
        "Motor head main upper casting",
        head_lower_xy,
        0.2460 - HEAD_PIVOT[2],
        0.3060 - HEAD_PIVOT[2],
        mat["white_coat"],
        head,
        bevel_bot=0.0035,
        bevel_top=0.0012,
        front_rake_y=0.0055,
        y_rake_pivot=-0.0400 - HEAD_PIVOT[1],
    )

    # 2. Upper Brushed-Stainless / Satin-Silver Metallic Crown Cap (`Head brushed stainless top deck`, world Z = 0.3062 .. 0.3500)
    # Exact top-front edge after 5 mm rake + 4 mm top bevel lands at world Y = -0.1800, Z = 0.3500 -> exact Z_max(0.68 rad) = 0.5200 m!
    head_crown_xy = rounded_rect_loop(
        x_half=0.0920,
        y_min=-0.1890 - HEAD_PIVOT[1],
        y_max=0.1995 - HEAD_PIVOT[1],
        r_corner=0.0130,
    )
    extrude_supported_prism(
        "Head brushed stainless top deck",
        head_crown_xy,
        0.3062 - HEAD_PIVOT[2],
        0.3500 - HEAD_PIVOT[2],
        mat["crown_silver"],
        head,
        bevel_bot=0.0010,
        bevel_top=0.0040,
        front_rake_y=0.0050,
        y_rake_pivot=-0.0400 - HEAD_PIVOT[1],
    )

    # Lower rear gearbox cheek over column (world Y in [+0.0500, +0.1995], Z in [0.1890, 0.2470])
    skirt_xy = rounded_rect_loop(
        x_half=0.0920,
        y_min=0.0500 - HEAD_PIVOT[1],
        y_max=0.1995 - HEAD_PIVOT[1],
        r_corner=0.0110,
    )
    extrude_supported_prism(
        "Motor head rear gearbox skirt",
        skirt_xy,
        0.1890 - HEAD_PIVOT[2],
        0.2470 - HEAD_PIVOT[2],
        mat["white_coat"],
        head,
        bevel_bot=0.0025,
        bevel_top=0.0015,
    )

    # Exact rear-top vertical cap at world Y = +0.2000, Z = 0.3460 -> hits exact Y_max = +0.2900 m (D_open = 0.4900 m) at 0.68 rad!
    box("Motor head rear vent plate", hloc(0.0, 0.1980, 0.2960), (0.1480, 0.0040, 0.1000), mat["crown_silver"], head, bevel=0.0)

    # Sloped front slow-speed attachment hub cover (`Ø62 mm` chromed bezel + stepped brushed-silver cap, tilted 6 deg with nose)
    hub_bezel = cylinder("Front slow-speed hub bezel", hloc(0.0, -0.1885, 0.2880), 0.0310, 0.0080, mat["polished"], head, "Y")
    hub_bezel.rotation_euler[0] = math.pi / 2.0 - 0.095
    hub_cap = cylinder("Front slow-speed hub cap", hloc(0.0, -0.1930, 0.2885), 0.0250, 0.0060, mat["crown_silver"], head, "Y")
    hub_cap.rotation_euler[0] = math.pi / 2.0 - 0.095

    # Tapered under-nose planetary gearbox turret above bowl center (0.0, -0.0800, 0.2480)
    turret_rz = [
        (0.0560, 0.2450 - HEAD_PIVOT[2]),
        (0.0680, 0.2520 - HEAD_PIVOT[2]),
        (0.0680, 0.2560 - HEAD_PIVOT[2]),
        (0.0, 0.2560 - HEAD_PIVOT[2]),
        (0.0, 0.2450 - HEAD_PIVOT[2]),
    ]
    turret = lathe_solid("Planetary nose collar", turret_rz, mat["silver_coat"], head, segments=40)
    turret.location = (0.0, BOWL_Y - HEAD_PIVOT[1], 0.0)

    # Head-lift safety microswitch plunger (`ヘッドリフト安全装置`) near rear column contact face
    cylinder("Head-lift safety interlock plunger", hloc(0.0420, 0.0780, 0.1880), 0.0040, 0.0080, mat["kenmix_red"], head)

    # Side cooling ventilation louvers + sleek authentic Kenmix / AICOH KPL9000S bitmap-textured badge
    for sgn, slbl, is_right in ((1.0, "right", True), (-1.0, "left", False)):
        for v_idx in range(6):
            vy = 0.1250 + v_idx * 0.0095
            box(f"Head cooling louver {slbl}_{v_idx + 1}", hloc(sgn * 0.0916, vy, 0.2740), (0.0020, 0.0042, 0.0360), mat["dark_trim"], head, 0.0003)

        # Compact bitmap-textured decal badge (`68 x 18 mm`) on the pearl-white cheek below the silver crown
        badge_plate(
            f"Kenmix red badge {slbl}",
            hloc(sgn * 0.0921, -0.0550, 0.2780),
            0.0680,
            0.0180,
            mat["badge_decal"],
            head,
            right_side=is_right,
        )
        box(f"AICOH navy plaque {slbl}", hloc(sgn * 0.0920, -0.0550, 0.2780), (0.0004, 0.0690, 0.0190), mat["silver_coat"], head, 0.0002)
        side_text(f"Kenmix wordmark {slbl}", "Kenmix", hloc(sgn * 0.0927, -0.0550, 0.2815), 0.0102, mat["ink_white"], head, font, right_side=is_right)
        side_text(f"AICOH KPL9000S text {slbl}", "AICOH  KPL9000S", hloc(sgn * 0.0927, -0.0550, 0.2718), 0.0048, mat["ink_white"], head, font, right_side=is_right)

    # Dial scale ring on right side of head around world (0.0925, 0.0850, 0.2680)
    cylinder("Speed dial scale bezel", hloc(0.0924, 0.0850, 0.2680), 0.0255, 0.0025, mat["steel"], head, "X")
    side_text("Speed dial P MIN MAX legend", "OFF · P · MIN · 1-6 · MAX", hloc(0.0938, 0.0850, 0.2975), 0.0044, mat["dark_trim"], head, font, right_side=True)

    # Sculpted black-collar + brushed-silver rotary speed dial (`kpl_speed_dial`, child of `kpl_head`, axis="1 0 0", range 0 .. 4.71 rad)
    # Stays inside X <= +0.1190 m (within ±0.1200 m width!)
    dial = empty("kpl_speed_dial", DIAL_LOCAL, head)
    dial["joint_name"] = "kpl_dial_turn"
    dial["axis_blender"] = "+X"
    dial["range_rad"] = [0.0, 4.71]

    cylinder("Speed dial knurled drum", (0.0055, 0.0, 0.0), 0.0220, 0.0100, mat["dark_trim"], dial, "X", bevel=0.0012)
    cylinder("Speed dial silver cap", (0.0155, 0.0, 0.0), 0.0195, 0.0120, mat["crown_silver"], dial, "X", bevel=0.0015)
    box("Speed dial pointer bar", (0.0218, 0.0, 0.0085), (0.0024, 0.0032, 0.0145), mat["dark_trim"], dial, 0.0004)

    # Commercial stainless wire safety finger guard (`kpl_finger_guard`, child of `kpl_head`, axis="1 0 0", range 0 .. 0.35 rad)
    # Pivot at world (0.0, +0.0150, 0.2430); bowl center is dy = -0.0950 m from guard pivot
    guard = empty("kpl_finger_guard", GUARD_LOCAL, head)
    guard["joint_name"] = "kpl_guard_hinge"
    guard["axis_blender"] = "+X"
    guard["range_rad"] = [0.0, 0.35]

    gy = BOWL_Y - 0.0150  # -0.0950 m (centered directly over bowl!)
    for r_idx, (rg, zg) in enumerate(((0.1090, -0.0020), (0.0910, 0.0020)), 1):
        pts = [
            (rg * math.cos(i * math.tau / 48), gy + rg * math.sin(i * math.tau / 48), zg)
            for i in range(48)
        ]
        tube(f"Finger guard wire ring {r_idx}", pts, 0.0017, mat["polished"], guard, cyclic=True)

    for s_idx in range(6):
        ang = math.radians(30.0 + s_idx * 60.0)
        tube(
            f"Finger guard radial strut {s_idx + 1}",
            [
                (0.0620 * math.cos(ang), gy + 0.0620 * math.sin(ang), 0.0040),
                (0.1090 * math.cos(ang), gy + 0.1090 * math.sin(ang), -0.0020),
            ],
            0.0015,
            mat["polished"],
            guard,
        )
    for cx, clbl in ((-0.0260, "left"), (0.0260, "right")):
        box(f"Finger guard hinge clip {clbl}", (cx, 0.0, 0.0020), (0.0100, 0.0180, 0.0070), mat["steel"], guard, 0.001)

    return head, dial, guard


def build_planetary_whip_and_bowl(
    root: bpy.types.Object,
    head: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    # Orbital planetary carrier (`kpl_planetary`, child of `kpl_head`, axis="0 0 1", range -1000 .. 1000 rad)
    planetary = empty("kpl_planetary", PLANETARY_LOCAL, head)
    planetary["joint_name"] = "kpl_orbit_spin"
    planetary["axis_blender"] = "+Z"
    planetary["range_rad"] = [-1000.0, 1000.0]

    cylinder("Planetary carrier disc", (0.0, 0.0, -0.0020), 0.0520, 0.0080, mat["silver_coat"], planetary, vertices=40, bevel=0.0012)
    cylinder("Planetary drip shield ring", (0.0, 0.0, 0.0010), 0.0550, 0.0030, mat["steel"], planetary, vertices=40, bevel=0.0005)
    cylinder("Planetary eccentric socket boss", (0.0, -0.0260, -0.0080), 0.0155, 0.0100, mat["polished"], planetary, vertices=28)

    # Offset eccentric 12-wire stainless balloon whip (`kpl_whip`, child of `kpl_planetary`, axis="0 0 -1", range -3000 .. 3000 rad)
    # World origin: (0.0, -0.1060, 0.2400); bottom crown at z_local = -0.1620 -> world Z = 0.0780 m (lifts to Z = 0.2620 m > 0.2390 + 0.020 m!)
    whip = empty("kpl_whip", WHIP_LOCAL, planetary)
    whip["joint_name"] = "kpl_whip_spin"
    whip["axis_blender"] = "-Z"
    whip["range_rad"] = [-3000.0, 3000.0]

    cylinder("Whip bayonet drive shaft", (0.0, 0.0, -0.0070), 0.0085, 0.0200, mat["polished"], whip)
    cylinder("Whip stainless wire collar", (0.0, 0.0, -0.0210), 0.0190, 0.0150, mat["steel"], whip, bevel=0.0015)
    cylinder("Whip sanitary bottom tip", (0.0, 0.0, -0.1495), 0.0090, 0.0050, mat["polished"], whip, bevel=0.0008)

    whip_stations = (
        (0.0145, -0.0250),
        (0.0355, -0.0460),
        (0.0495, -0.0720),
        (0.0525, -0.0980),
        (0.0445, -0.1230),
        (0.0265, -0.1410),
        (0.0075, -0.1500),
    )
    for loop_idx in range(6):
        ang = loop_idx * math.pi / 6.0
        ca, sa = math.cos(ang), math.sin(ang)
        pts = [(r * ca, r * sa, z) for r, z in whip_stations] + [
            (-r * ca, -r * sa, z) for r, z in reversed(whip_stations)
        ]
        tube(f"Balloon whip stainless wire loop {loop_idx + 1}", pts, 0.0012, mat["polished"], whip, smooth=True)

    # Removable 6.7 L flared SUS304 stainless mixing bowl (`kpl_bowl`, 1.100 kg, seated at (0.0, -0.0800, 0.0120))
    # Matches P-88512D: Ø240 mm rolled rim (R = 0.120000 m), 227 mm total height (0.2270 m), Ø200 mm stepped base ring
    bowl = empty("kpl_bowl", BOWL_ORIGIN, root)
    bowl["accessory_role"] = "6.7 L flared SUS304 stainless mixing bowl (1.100 kg)"
    bowl["capacity_litres"] = 6.7

    bowl_loop_rz = [
        (0.0, 0.0000),      # bottom center resting on Z_world = 0.0120 m bayonet pad
        (0.0910, 0.0000),   # bottom flat support loop
        (0.0915, 0.0000),   # bayonet base foot outer edge
        (0.0915, 0.0160),   # stepped lower bayonet skirt
        (0.1000, 0.0185),   # P-88512D Ø200 mm bayonet locking ring step
        (0.1000, 0.0250),   # top of Ø200 mm base step
        (0.0955, 0.0285),   # lower bowl waist above bayonet ring
        (0.1015, 0.0560),   # curved lower belly
        (0.1085, 0.1020),   # lower-mid flared wall
        (0.1135, 0.1550),   # upper-mid flared wall
        (0.1162, 0.1980),   # upper cylindrical/flared wall
        (0.1175, 0.2205),   # neck under rolled lip
        (0.1200, 0.2232),   # exact Ø240.0 mm rolled outer rim lower equator
        (0.1200, 0.2258),   # exact Ø240.0 mm rolled outer rim upper equator
        (0.1168, 0.2270),   # exact 227.0 mm top rim crest (Z_world = 0.2390 m)
        (0.1145, 0.2230),   # inner top rim
        (0.1132, 0.1980),   # inner upper wall
        (0.1105, 0.1550),   # inner upper-mid wall
        (0.1055, 0.1020),   # inner lower-mid wall
        (0.0985, 0.0560),   # inner lower belly
        (0.0880, 0.0220),   # inner bottom cove
        (0.0720, 0.0065),   # inner floor corner
        (0.0, 0.0060),      # inner floor center (Z_world = 0.0180 m)
    ]
    lathe_solid("Bowl 6.7L flared stainless shell", bowl_loop_rz, mat["polished"], bowl, segments=64)

    socket = empty("vessel_socket", (0.0, -0.1180, 0.2220), bowl)
    socket["site_role"] = "Front rolled rim grasp socket"
    return planetary, whip, bowl


def reset_rest_pose(
    root: bpy.types.Object,
    head: bpy.types.Object,
    planetary: bpy.types.Object,
    whip: bpy.types.Object,
    dial: bpy.types.Object,
    guard: bpy.types.Object,
    bowl: bpy.types.Object,
) -> None:
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()
    head.location = HEAD_PIVOT
    head.rotation_euler = (0.0, 0.0, 0.0)
    planetary.location = PLANETARY_LOCAL
    planetary.rotation_euler = (0.0, 0.0, 0.0)
    whip.location = WHIP_LOCAL
    whip.rotation_euler = (0.0, 0.0, 0.0)
    dial.location = DIAL_LOCAL
    dial.rotation_euler = (0.0, 0.0, 0.0)
    guard.location = GUARD_LOCAL
    guard.rotation_euler = (0.0, 0.0, 0.0)
    bowl.location = BOWL_ORIGIN
    bowl.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()


def animate_timeline(
    head: bpy.types.Object,
    planetary: bpy.types.Object,
    whip: bpy.types.Object,
    dial: bpy.types.Object,
    guard: bpy.types.Object,
    bowl: bpy.types.Object,
) -> None:
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0, BOWL_ORIGIN),
        (40, 0.0, math.pi, -3.5 * math.pi, math.pi, 0.0, BOWL_ORIGIN),
        (
            72,
            -HEAD_TILT_MAX_RAD,
            0.0,
            -3.5 * math.pi,
            0.0,
            0.18,
            BOWL_ORIGIN,
        ),
        (
            92,
            -HEAD_TILT_MAX_RAD,
            0.0,
            -3.5 * math.pi,
            0.0,
            0.18,
            BOWL_ORIGIN,
        ),
        (120, 0.0, 0.0, 0.0, 0.0, 0.0, BOWL_ORIGIN),
    )
    for fno, head_rx, orb_rz, whip_rz, dial_rx, grd_rx, b_loc in keyframes:
        head.rotation_euler = (head_rx, 0.0, 0.0)
        head.keyframe_insert(data_path="rotation_euler", frame=fno)

        planetary.rotation_euler = (0.0, 0.0, orb_rz)
        planetary.keyframe_insert(data_path="rotation_euler", frame=fno)

        whip.rotation_euler = (0.0, 0.0, whip_rz)
        whip.keyframe_insert(data_path="rotation_euler", frame=fno)

        dial.rotation_euler = (dial_rx, 0.0, 0.0)
        dial.keyframe_insert(data_path="rotation_euler", frame=fno)

        guard.rotation_euler = (grd_rx, 0.0, 0.0)
        guard.keyframe_insert(data_path="rotation_euler", frame=fno)

        bowl.location = b_loc
        bowl.rotation_euler = (0.0, 0.0, 0.0)
        bowl.keyframe_insert(data_path="location", frame=fno)
        bowl.keyframe_insert(data_path="rotation_euler", frame=fno)


def export_glbs(
    root: bpy.types.Object,
    head: bpy.types.Object,
    planetary: bpy.types.Object,
    whip: bpy.types.Object,
    dial: bpy.types.Object,
    guard: bpy.types.Object,
    bowl: bpy.types.Object,
) -> None:
    reset_rest_pose(root, head, planetary, whip, dial, guard, bowl)
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

    saved_parent = bowl.parent
    saved_loc = bowl.location.copy()
    saved_rot = tuple(bowl.rotation_euler)
    bowl.animation_data_clear()
    bowl.parent = None
    bowl.location = (0.0, 0.0, 0.0)
    bowl.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    bowl.select_set(True)
    for obj in bowl.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-bowl.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    bowl.parent = saved_parent
    bowl.location = saved_loc
    bowl.rotation_euler = saved_rot
    bpy.context.view_layer.update()


def configure_cycles_metal_gpu(scene: bpy.types.Scene) -> None:
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
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.15


def setup_studio_and_render(
    scene: bpy.types.Scene,
    mat_floor: bpy.types.Material,
    skip_renders: bool,
) -> bpy.types.Object:
    before = set(scene.objects)
    configure_cycles_metal_gpu(scene)

    world = bpy.data.worlds.new("KPL9000S studio world")
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.60, 0.65, 0.72, 1.0)
        bg.inputs["Strength"].default_value = 0.46
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, -0.001))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(mat_floor)

    def add_light(name: str, loc: tuple[float, float, float], target: tuple[float, float, float], energy: float, size: float) -> None:
        ldata = bpy.data.lights.new(name, "AREA")
        ldata.energy = energy
        ldata.shape = "DISK"
        ldata.size = size
        lobj = bpy.data.objects.new(name, ldata)
        scene.collection.objects.link(lobj)
        lobj.location = Vector(loc)
        lobj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    add_light("Key softbox", (-1.1, -1.4, 1.5), (0.0, 0.0, 0.20), 150.0, 1.2)
    add_light("Right fill stripbox", (1.3, -0.5, 1.2), (0.0, 0.0, 0.20), 110.0, 1.0)
    add_light("Rear rim softbox", (-0.2, 1.3, 1.5), (0.0, 0.0, 0.22), 130.0, 1.1)
    add_light("Bowl whip highlight", (0.2, -1.3, 0.45), (0.0, -0.08, 0.16), 45.0, 0.7)

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

    views = (
        ("studio-closed", (0.92, -1.35, 0.72), (0.0, 0.0, 0.18), 0.56, 1),
        ("studio-open", (0.98, -1.45, 0.86), (0.0, 0.02, 0.25), 0.72, 80),
        ("studio-front", (0.0, -1.50, 0.19), (0.0, 0.0, 0.18), 0.48, 1),
        ("studio-detail", (0.72, -1.08, 0.48), (0.0, -0.04, 0.24), 0.38, 72),
        ("studio-right", (1.55, 0.0, 0.20), (0.0, 0.0, 0.18), 0.56, 1),
    )
    if not skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            bpy.context.view_layer.update()
            camera.location = Vector(pos)
            camera.data.ortho_scale = scale
            camera.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(ASSETS / f"{vname}.png")
            bpy.ops.render.render(write_still=True)

    scene.frame_set(1)
    camera.location = Vector(views[0][1])
    camera.data.ortho_scale = views[0][3]
    camera.rotation_euler = (Vector(views[0][2]) - Vector(views[0][1])).to_track_quat("-Z", "Y").to_euler()
    return camera


def compute_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector, Vector]:
    bpy.context.view_layer.update()
    low = Vector((1e9, 1e9, 1e9))
    high = Vector((-1e9, -1e9, -1e9))
    for obj in meshes:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            wv = mw @ v.co
            low.x = min(low.x, wv.x)
            low.y = min(low.y, wv.y)
            low.z = min(low.z, wv.z)
            high.x = max(high.x, wv.x)
            high.y = max(high.y, wv.y)
            high.z = max(high.z, wv.z)
    return low, high, high - low


def write_build_report(
    root: bpy.types.Object,
    head: bpy.types.Object,
    utilities: bpy.types.Object,
) -> dict:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    excluded = {utilities, *utilities.children_recursive}
    body_meshes = [obj for obj in root.children_recursive if obj.type == "MESH" and obj not in excluded]
    all_meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]

    closed_low, closed_high, closed_dims = compute_bounds(body_meshes)
    for actual, expected in zip(closed_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 2e-4, (closed_dims, closed_low, closed_high)
    assert abs(closed_low.z) <= 1e-5, closed_low

    head.rotation_euler = (-HEAD_TILT_MAX_RAD, 0.0, 0.0)
    bpy.context.view_layer.update()
    lift_low, lift_high, lift_dims = compute_bounds(body_meshes)
    head.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    assert abs(lift_dims.x - WIDTH) <= 2e-4, lift_dims
    assert abs(lift_dims.y - LIFTED_DEPTH) <= 0.002, (lift_dims, lift_low, lift_high)
    assert abs(lift_dims.z - LIFTED_HEIGHT) <= 0.002, (lift_dims, lift_low, lift_high)

    tri_count = sum(len(obj.data.polygons) for obj in all_meshes)
    glb_path = ASSETS / f"{NAME}.glb"
    bowl_glb_path = ASSETS / f"{NAME}-bowl.glb"
    report = {
        "asset": NAME,
        "model": "Aicohsha Kenmix Aicoh Chef PRO KPL9000S Planetary Mixer",
        "blender_version": bpy.app.version_string,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "bowl_glb_sha256": hashlib.sha256(bowl_glb_path.read_bytes()).hexdigest(),
        "bowl_glb_bytes": bowl_glb_path.stat().st_size,
        "nominal_closed_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_closed_envelope_m": [round(v, 6) for v in closed_dims],
        "closed_bounds_m": {
            "min": [round(v, 6) for v in closed_low],
            "max": [round(v, 6) for v in closed_high],
        },
        "nominal_lifted_envelope_m": [WIDTH, LIFTED_DEPTH, LIFTED_HEIGHT],
        "authored_lifted_envelope_m": [round(v, 6) for v in lift_dims],
        "lifted_bounds_m": {
            "min": [round(v, 6) for v in lift_low],
            "max": [round(v, 6) for v in lift_high],
        },
        "published_total_mass_kg": 8.6,
        "mixer_mass_kg": 7.5,
        "bowl_mass_kg": 1.1,
        "bowl_capacity_l": 6.7,
        "bowl_dimensions_m": [0.240, 0.240, BOWL_HEIGHT],
        "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
        "whip_speed_range_rpm": [150, 676],
        "mesh_count": len(all_meshes),
        "evaluated_triangles": tri_count,
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def run_glb_inspection() -> dict:
    """Re-import exported GLB in a clean scene to verify closed & tilted envelopes, nested planetary joints, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb_path = ASSETS / f"{NAME}.glb"
    bowl_glb_path = ASSETS / f"{NAME}-bowl.glb"
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objs = bpy.data.objects

    root = objs["kpl_base"]
    head = objs["kpl_head"]
    planetary = objs["kpl_planetary"]
    whip = objs["kpl_whip"]
    dial = objs["kpl_speed_dial"]
    guard = objs["kpl_finger_guard"]
    bowl = objs["kpl_bowl"]
    socket = objs["vessel_socket"]
    utilities = objs["kpl_utilities"]
    top_deck = objs["Head brushed stainless top deck"]

    assert head.parent == root
    assert planetary.parent == head
    assert whip.parent == planetary
    assert dial.parent == head
    assert guard.parent == head
    assert bowl.parent == root
    assert socket.parent == bowl
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objs)

    for o in list(objs):
        o.animation_data_clear()
    bpy.context.view_layer.update()

    excluded = {utilities, *utilities.children_recursive}
    body_meshes = [o for o in root.children_recursive if o.type == "MESH" and o not in excluded]
    c_low, c_high, c_dims = compute_bounds(body_meshes)
    for actual, expected in zip(c_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 2e-4, (c_dims, c_low, c_high)
    assert abs(c_low.z - 0.0) <= 1e-5, c_low.z
    assert abs(c_high.z - HEIGHT) <= 1e-4, c_high.z

    # Fault-injection check: displacing top deck upward by 8 mm must reject closed height
    orig_z = top_deck.location.z
    top_deck.location.z += 0.008
    bpy.context.view_layer.update()
    _, _, pert_dims = compute_bounds(body_meshes)
    fault_detected = abs(pert_dims.z - HEIGHT) > 0.004
    top_deck.location.z = orig_z
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard failed to detect height perturbation"

    # Tilt head back 0.68 rad around -X and verify lifted ~240 x 490 x 520 mm clearance AND whip tip above bowl rim
    head.rotation_mode = "XYZ"
    head.rotation_euler = (-HEAD_TILT_MAX_RAD, 0.0, 0.0)
    bpy.context.view_layer.update()
    l_low, l_high, l_dims = compute_bounds(body_meshes)
    assert abs(l_dims.y - LIFTED_DEPTH) <= 0.002, l_dims
    assert abs(l_dims.z - LIFTED_HEIGHT) <= 0.002, l_dims

    whip_low, _, _ = compute_bounds([o for o in whip.children_recursive if o.type == "MESH"])
    _, bowl_high, _ = compute_bounds([o for o in bowl.children_recursive if o.type == "MESH"])
    assert whip_low.z > bowl_high.z + 0.020, (whip_low.z, bowl_high.z)

    head.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    required_meshes = {
        "Lower die-cast pedestal deck",
        "Bayonet bowl seat pad",
        "Head brushed stainless top deck",
        "Motor head main upper casting",
        "Planetary carrier disc",
        "Whip bayonet drive shaft",
        "Balloon whip stainless wire loop 1",
        "Balloon whip stainless wire loop 6",
        "Speed dial knurled drum",
        "Finger guard wire ring 1",
        "Bowl 6.7L flared stainless shell",
        "Start push button green",
        "Stop push button red",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "bowl_glb_sha256": hashlib.sha256(bowl_glb_path.read_bytes()).hexdigest(),
        "bowl_glb_bytes": bowl_glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "closed_dimensions_m": [round(v, 6) for v in c_dims],
        "lifted_dimensions_m": [round(v, 6) for v in l_dims],
        "lifted_whip_clearance_above_bowl_m": round(whip_low.z - bowl_high.z, 4),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported GLB; verify exact 240x400x350 mm closed envelope with rubber feet at Z=0.000 m and "
            "6.7 L 227 mm stainless bowl seated at Z=0.012 m; verify fault-injection rejection; tilt upper motor head "
            "0.68 rad around rear hinge to verify 240x490x520 mm lifted clearance and >20 mm whip-to-bowl-rim "
            "extraction clearance; verify nested planetary + 12-wire whip hierarchy and zero mesh errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def attach_aicoh_references(scene: bpy.types.Scene, root: bpy.types.Object) -> None:
    app_col = bpy.data.collections.new("KPL9000S appliance")
    scene.collection.children.link(app_col)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        app_col.objects.link(obj)

    ref_col = bpy.data.collections.new("AICOH family references - toggle visibility")
    scene.collection.children.link(ref_col)
    for idx, fname in enumerate(("manufacturer-product.jpg", "without-bowl.jpg")):
        fpath = AICOH_IMAGES / fname
        if not fpath.is_file():
            continue
        img = bpy.data.images.load(str(fpath))
        img.pack()
        ref_obj = bpy.data.objects.new(fname, None)
        ref_col.objects.link(ref_obj)
        ref_obj.empty_display_type = "IMAGE"
        ref_obj.data = img
        ref_obj.empty_display_size = 0.55
        ref_obj.location = (idx * 0.65, 0.55, 0.25)
        ref_obj.rotation_euler = (math.pi / 2.0, 0.0, 0.0)
        ref_obj["reference_status"] = "AICOH planetary mixer family reference; dimensions from KPL9000S P-88512D"
    ref_col.hide_viewport = True
    ref_col.hide_render = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    parser.add_argument(
        "--label-font",
        type=Path,
        default=Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    )
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    font = bpy.data.fonts.load(str(args.label_font))
    font.name = "KPL9000S label font"

    scene = bpy.context.scene
    scene.name = "Aicohsha Kenmix KPL9000S - Japan reference"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for m_name, m_frame in (
        ("Closed standby", 1),
        ("Planetary whipping", 40),
        ("Head lifted 520mm & bowl inspect", 72),
        ("Closed again", 120),
    ):
        scene.timeline_markers.new(m_name, frame=m_frame)

    root = empty("kpl_base", (0.0, 0.0, 0.0))
    root["manufacturer"] = "AICOHSHA MFG. CO., LTD."
    root["model"] = "Kenmix Aicoh Chef PRO KPL9000S"
    root["closed_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["lifted_dimensions_m"] = [WIDTH, LIFTED_DEPTH, LIFTED_HEIGHT]
    root["published_total_mass_kg"] = 8.6

    mat = palette()
    utilities = build_base_and_pedestal(root, mat)
    head, dial, guard = build_tilt_head_and_controls(root, mat, font)
    planetary, whip, bowl = build_planetary_whip_and_bowl(root, head, mat)

    convert_and_clean_tree(root)
    export_glbs(root, head, planetary, whip, dial, guard, bowl)
    write_build_report(root, head, utilities)

    attach_aicoh_references(scene, root)
    animate_timeline(head, planetary, whip, dial, guard, bowl)
    setup_studio_and_render(scene, mat["studio_floor"], args.skip_renders)

    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))

    insp = run_glb_inspection()
    print("Saved KPL9000S blend, GLBs, renders, and inspection:", insp["status"])


if __name__ == "__main__":
    main()
