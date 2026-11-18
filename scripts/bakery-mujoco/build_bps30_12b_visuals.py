"""Build the Japanese Maruzen BPS30-12B SUS430 commercial wall drainer pipe shelf visual model.

Metres, Z up, operator front towards -Y, rear wall mounting plane at Y = +0.150 m.
Follows Maruzen Co., Ltd. 430 Bream Series Drawing No. 06869 & Catalogue 48010 for BPS30-12B (マルゼン ブリームシリーズ パイプ棚):
- Overall envelope: 1,200 x 300 x 240 mm (W x D x H; matching BS2-126N 1,200 mm sink width)
  occupying X in [-0.600, +0.600], Y in [-0.150, +0.150], Z in [0.000, +0.240].
- 6 parallel Ø16 mm (0.016 m) round SUS430 stainless drainer tubes spanning full 1,200 mm width (no end plates)
  with crowned mirror-chrome plated resin end caps (キャップ 樹脂メッキ付) at all 12 tube ends (top tangent Z = 0.220 m).
- 2 movable ADC die-cast aluminum through-pipe wall brackets (アルミ鋳物 可動式ブラケット) with 6 cylindrical pipe collars,
  5 open rectangular cast-web truss windows, curved concave T-ribbed arch gussets, upper/lower wall-anchor ears (Z = 0.000..0.240 m),
  and M4 x 6 hex socket cup-point set screws (700 mm nominal rest pitch; adjustable across 300..940 mm).
- Includes an inverted 400 x 300 x 20 mm washed aluminum baking tray (0.850 kg) with vessel_socket
  resting stably across all 6 Ø16 mm stainless drainer tubes at Z = 0.220..0.240 m.
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
from inspect_induction import bounds as mesh_bounds, near
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-bps30-12b"
DOCS_DIR = ROOT / "docs/equipment/maruzen-bps30-12b"
NAME = "maruzen-bps30-12b"

WIDTH = 1.2000
DEPTH = 0.3000
HEIGHT = 0.2400

PIPE_RADIUS = 0.0080  # Ø16 mm SUS430 round drainer tubes
PIPE_CENTER_Z = 0.2120  # Top tangent plane at exact Z = 0.2200 m
PIPE_YS = (-0.1300, -0.0800, -0.0300, 0.0200, 0.0700, 0.1200)

BRACKET_LEFT_ORIGIN = (-0.3500, 0.0, 0.0)
BRACKET_RIGHT_ORIGIN = (0.3500, 0.0, 0.0)
TRAY_ORIGIN = (0.0, 0.0, 0.2200)


def clean_mesh_object(obj, sharp_angle_deg=52.0):
    """Apply geometry modifiers, clean topology, mark sharp creases >= sharp_angle_deg, and add WEIGHTED_NORMAL."""
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
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

    thresh = math.radians(sharp_angle_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < thresh
        else:
            e.smooth = False

    bm.to_mesh(obj.data)
    bm.free()
    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()

    wn = obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
    wn.mode = "FACE_AREA"
    wn.weight = 50
    wn.keep_sharp = True
    return obj


def surfaces():
    mats = {
        "sus430_pipe": material("sus430_pipe", (0.70, 0.73, 0.76, 1.0), 0.92, 0.20),
        "adc_cast_aluminum": material("adc_cast_aluminum", (0.64, 0.67, 0.70, 1.0), 0.78, 0.36),
        "chrome_cap": material("chrome_cap", (0.83, 0.85, 0.88, 1.0), 0.97, 0.09),
        "aluminum_tray": material("aluminum_tray", (0.72, 0.74, 0.77, 1.0), 0.87, 0.28),
        "badge_dark": material("badge_dark", (0.10, 0.12, 0.15, 1.0), 0.35, 0.28),
        "ink_silver": material("ink_silver", (0.84, 0.86, 0.89, 1.0), 0.78, 0.22),
        "hardware_dark": material("hardware_dark", (0.14, 0.16, 0.18, 1.0), 0.72, 0.38),
    }
    for m in mats.values():
        m["metallic"] = float(m["metallic"])
        m["roughness"] = float(m["roughness"])
        m["emission"] = float(m["emission"])
    return mats


def rounded_rect_loop(cx, cy, w, d, radius, segments=8):
    r = min(radius, w * 0.48, d * 0.48)
    corners = (
        (cx + w / 2 - r, cy + d / 2 - r, 0.0),
        (cx - w / 2 + r, cy + d / 2 - r, 90.0),
        (cx - w / 2 + r, cy - d / 2 + r, 180.0),
        (cx + w / 2 - r, cy - d / 2 + r, 270.0),
    )
    pts = []
    for ox, oy, start_deg in corners:
        for step in range(segments + 1):
            ang = math.radians(start_deg + step * 90.0 / segments)
            pts.append((ox + r * math.cos(ang), oy + r * math.sin(ang)))
    return pts


def build_extruded_profile_along_x(name, x0, x1, yz_ccw, surface, parent, bevel=0.0):
    """Extrude a CCW profile in (Y, Z) from x0 to x1."""
    m = len(yz_ccw)
    verts = [(x0, y, z) for y, z in yz_ccw] + [(x1, y, z) for y, z in yz_ccw]
    faces: list[tuple[int, ...]] = [
        tuple(reversed(range(m))),
        tuple(range(m, 2 * m)),
    ]
    for i in range(m):
        j = (i + 1) % m
        faces.append((i, j, m + j, m + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=bevel)


def build_chrome_pipe_end_cap(name, s_sign, py, pz, surface, parent, radial_segs=28):
    """Build a stepped & crowned mirror-chrome plated resin pipe end cap reaching exact X = s_sign * 0.600000 m."""
    # Profile stations (abs_x, radius) from inner plug shoulder out to domed tip at 0.600000 m
    stations = (
        (0.5915, 0.0068),
        (0.5945, 0.0068),
        (0.5945, 0.0083),
        (0.5982, 0.0083),
        (0.5993, 0.0072),
        (0.5998, 0.0052),
    )
    verts = []
    faces = []
    for ax, rad in stations:
        x_val = s_sign * ax
        for s in range(radial_segs):
            ang = 2.0 * math.pi * s / radial_segs
            verts.append((x_val, py + rad * math.cos(ang), pz + rad * math.sin(ang)))

    in_center = len(verts)
    verts.append((s_sign * stations[0][0], py, pz))
    tip_center = len(verts)
    verts.append((s_sign * 0.600000, py, pz))

    n_rings = len(stations)
    for r_idx in range(n_rings - 1):
        b0 = r_idx * radial_segs
        b1 = (r_idx + 1) * radial_segs
        for s in range(radial_segs):
            sn = (s + 1) % radial_segs
            if s_sign > 0:
                faces.append((b0 + s, b0 + sn, b1 + sn, b1 + s))
            else:
                faces.append((b0 + s, b1 + s, b1 + sn, b0 + sn))

    last_b = (n_rings - 1) * radial_segs
    for s in range(radial_segs):
        sn = (s + 1) % radial_segs
        if s_sign > 0:
            faces.append((in_center, sn, s))
            faces.append((tip_center, last_b + s, last_b + sn))
        else:
            faces.append((in_center, s, sn))
            faces.append((tip_center, last_b + sn, last_b + s))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_inverted_baking_tray_mesh(name, surface, parent):
    """Build a manifold inverted 400 x 300 x 20 mm aluminum baking tray (local Z in [0.000, 0.020] m)."""
    outer_stations = (
        (0.4000, 0.3000, 0.0120, 0.0000),
        (0.4000, 0.3000, 0.0120, 0.0035),
        (0.3860, 0.2860, 0.0140, 0.0045),
        (0.3720, 0.2720, 0.0160, 0.0190),
        (0.3680, 0.2680, 0.0160, 0.0200),
    )
    inner_stations = (
        (0.3880, 0.2880, 0.0110, 0.0000),
        (0.3830, 0.2830, 0.0120, 0.0035),
        (0.3680, 0.2680, 0.0140, 0.0175),
        (0.3640, 0.2640, 0.0140, 0.0180),
    )

    verts = []
    ring_len = None
    for w, d, r, z in outer_stations:
        loop = rounded_rect_loop(0.0, 0.0, w, d, r, segments=8)
        ring_len = len(loop)
        verts.extend((x, y, z) for x, y in loop)
    outer_count = len(outer_stations)

    for w, d, r, z in inner_stations:
        loop = rounded_rect_loop(0.0, 0.0, w, d, r, segments=8)
        verts.extend((x, y, z) for x, y in loop)
    inner_count = len(inner_stations)

    top_center_idx = len(verts)
    verts.append((0.0, 0.0, 0.0200))
    ceil_center_idx = len(verts)
    verts.append((0.0, 0.0, 0.0180))

    faces = []
    for r_idx in range(outer_count - 1):
        b0 = r_idx * ring_len
        b1 = (r_idx + 1) * ring_len
        for i in range(ring_len):
            j = (i + 1) % ring_len
            faces.append((b0 + i, b1 + i, b1 + j, b0 + j))

    top_ring = (outer_count - 1) * ring_len
    for i in range(ring_len):
        j = (i + 1) % ring_len
        faces.append((top_center_idx, top_ring + j, top_ring + i))

    in_base = outer_count * ring_len
    for r_idx in range(inner_count - 1):
        b0 = in_base + r_idx * ring_len
        b1 = in_base + (r_idx + 1) * ring_len
        for i in range(ring_len):
            j = (i + 1) % ring_len
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))

    ceil_ring = in_base + (inner_count - 1) * ring_len
    for i in range(ring_len):
        j = (i + 1) % ring_len
        faces.append((ceil_center_idx, ceil_ring + i, ceil_ring + j))

    for i in range(ring_len):
        j = (i + 1) % ring_len
        faces.append((i, j, in_base + j, in_base + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def text_label(name, text, position, size, surface, parent, rot_euler=(math.pi / 2, 0.0, math.pi / 2)):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.0002
    data.resolution_u = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = rot_euler
    return finish(obj, name, surface, parent, 0.0)


def build_pipe_shelf_rack(root, mat):
    """Build 6 full-width Ø16 mm SUS430 round drainer tubes + 12 crowned chrome resin end caps (X in [-0.600, +0.600])."""
    pipes = []
    for idx, py in enumerate(PIPE_YS, 1):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=36, radius=PIPE_RADIUS, depth=1.1890, location=(0.0, py, PIPE_CENTER_Z)
        )
        pipe = bpy.context.object
        pipe.rotation_euler[1] = math.pi / 2
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        finish(pipe, f"bps_pipe_{idx:02d}", mat["sus430_pipe"], root, bevel=0.0)
        pipes.append(pipe)

        for s_sign, s_name in ((-1.0, "left"), (1.0, "right")):
            build_chrome_pipe_end_cap(
                f"bps_pipe_{idx:02d}_cap_{s_name}",
                s_sign,
                py,
                PIPE_CENTER_Z,
                mat["chrome_cap"],
                root,
            )

    return pipes


def build_movable_wall_bracket(name, origin, slide_range, root, mat, with_badge=False):
    """Build an authentic Maruzen ADC die-cast aluminum movable through-pipe wall bracket (Drawing 06869)."""
    brk = empty(name, origin, root)
    brk["joint_type"] = "slide"
    brk["axis_blender"] = [1.0, 0.0, 0.0]
    brk["range_m"] = list(slide_range)

    # 1. Vertical rear wall flange: stadium profile in (X, Z) with semicircular bottom (Z_min=0.0000) & top ear (Z_max=0.2400)
    #    Rear face strictly flush with wall mounting plane Y = +0.150000 m
    r_ear = 0.0090
    xz_loop = []
    for step in range(13):
        ang = math.radians(0.0 + step * 180.0 / 12.0)
        xz_loop.append((r_ear * math.cos(ang), (HEIGHT - r_ear) + r_ear * math.sin(ang)))
    for step in range(13):
        ang = math.radians(180.0 + step * 180.0 / 12.0)
        xz_loop.append((r_ear * math.cos(ang), r_ear + r_ear * math.sin(ang)))

    m_fl = len(xz_loop)
    fl_verts = [(x, 0.1410, z) for x, z in xz_loop] + [(x, 0.1500, z) for x, z in xz_loop]
    fl_faces: list[tuple[int, ...]] = [
        tuple(range(m_fl)),
        tuple(reversed(range(m_fl, 2 * m_fl))),
    ]
    for i in range(m_fl):
        j = (i + 1) % m_fl
        fl_faces.append((i, m_fl + i, m_fl + j, j))
    fl_mesh = bpy.data.meshes.new(f"{name}_wall_flange")
    fl_mesh.from_pydata(fl_verts, [], fl_faces)
    fl_mesh.update()
    fl_obj = bpy.data.objects.new(f"{name}_wall_flange", fl_mesh)
    bpy.context.scene.collection.objects.link(fl_obj)
    finish(fl_obj, f"{name}_wall_flange", mat["adc_cast_aluminum"], brk, bevel=0.0)

    # Upper (Z=0.2295) & lower (Z=0.0135) countersunk wall-anchor screw bosses
    for b_idx, bz in enumerate((0.2295, 0.0135), 1):
        cylinder(
            f"{name}_anchor_boss_{b_idx}",
            (0.0, 0.1400, bz),
            0.0046,
            0.0024,
            mat["hardware_dark"],
            brk,
            "Y",
        )

    # 2. Horizontal top through-pipe truss arm (Y_min = -0.150000 m exact at rounded front nose, 5 open web windows)
    #    Upper & lower horizontal chord rails + rounded front nose loop around Pipe #1
    nose_r = 0.0108
    nose_cy = -0.1500 + nose_r  # -0.1392 -> front-most tangent at exact Y = -0.150000 m!
    arm_yz = []
    for step in range(13):
        ang = math.radians(90.0 + step * 180.0 / 12.0)  # 90 -> 270 deg: top -> front (-0.1500) -> bottom
        arm_yz.append((nose_cy + nose_r * math.cos(ang), PIPE_CENTER_Z + nose_r * math.sin(ang)))
    arm_yz.extend(
        [
            (0.1420, PIPE_CENTER_Z - nose_r),
            (0.1420, PIPE_CENTER_Z - 0.0072),
            (-0.1300, PIPE_CENTER_Z - 0.0072),
            (-0.1300, PIPE_CENTER_Z + 0.0072),
            (0.1420, PIPE_CENTER_Z + 0.0072),
            (0.1420, PIPE_CENTER_Z + nose_r),
        ]
    )
    # Note: arm_yz traces a U-shaped top+nose+bottom chord leaving an open horizontal slot between Z=0.2048..0.2192,
    # broken into 5 rectangular daylight windows by the 6 cylindrical pipe-collar bosses below!
    build_extruded_profile_along_x(
        f"{name}_support_arm",
        -0.0082,
        0.0082,
        arm_yz,
        mat["adc_cast_aluminum"],
        brk,
    )

    # 6 cylindrical cast-aluminum pipe-collar bosses wrapping 360 deg around all 6 Ø16 mm SUS430 pipes
    for p_idx, py in enumerate(PIPE_YS, 1):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=32,
            radius=0.0112,
            depth=0.0180,
            location=(0.0, py, PIPE_CENTER_Z),
            rotation=(0.0, math.pi / 2, 0.0),
        )
        finish(bpy.context.object, f"{name}_pipe_collar_{p_idx:02d}", mat["adc_cast_aluminum"], brk, bevel=0.0006)

    # Recessed M4 x 6 hex socket cup-point set screws underneath front (#1) and rear (#6) pipe collars
    for s_idx, sy in enumerate((PIPE_YS[0], PIPE_YS[-1]), 1):
        cylinder(
            f"{name}_m4_set_screw_{s_idx}",
            (0.0, sy, PIPE_CENTER_Z - 0.0108),
            0.0028,
            0.0030,
            mat["hardware_dark"],
            brk,
        )

    # 3. Curved concave cast-aluminum arch gusset (T-ribbed: outer curved flange + recessed central web)
    #    Sweeps from (Y = -0.0980, Z = 0.2012) along a concave ellipse to (Y = +0.1410, Z = 0.0220)
    n_arc = 18
    y_start, z_start = -0.0980, 0.2012
    y_end, z_end = 0.1410, 0.0220
    # Concave arch centered at (y_start, z_end) = (-0.0980, 0.0220) with semi-axes Ry = 0.2390, Rz = 0.1792!
    ry = y_end - y_start
    rz = z_start - z_end

    # Recessed central cast web filling between curved front edge and top/rear bracket legs
    web_yz = []
    for k in range(n_arc + 1):
        ang = (math.pi / 2.0) * (1.0 - k / n_arc)  # pi/2 -> 0: (y_start, z_start) -> (y_end, z_end)
        web_yz.append((y_start + ry * math.cos(ang), z_end + rz * math.sin(ang)))
    web_yz.append((0.1420, 0.2025))
    build_extruded_profile_along_x(
        f"{name}_gusset_web",
        -0.0035,
        0.0035,
        web_yz,
        mat["adc_cast_aluminum"],
        brk,
    )

    # Wider 16.4 mm curved front compression flange along the arch (`{name}_diagonal_strut`)
    flange_outer = []
    flange_inner = []
    fl_t = 0.0055
    for k in range(n_arc + 1):
        ang = (math.pi / 2.0) * (1.0 - k / n_arc)
        yk = y_start + ry * math.cos(ang)
        zk = z_end + rz * math.sin(ang)
        # Inward normal toward (+Y, +Z)
        ny = rz * math.cos(ang)
        nz = ry * math.sin(ang)
        ln = math.hypot(ny, nz) or 1.0
        flange_outer.append((yk, zk))
        flange_inner.append((yk + fl_t * ny / ln, zk + fl_t * nz / ln))
    arch_band_yz = flange_outer + list(reversed(flange_inner))
    build_extruded_profile_along_x(
        f"{name}_diagonal_strut",
        -0.0082,
        0.0082,
        arch_band_yz,
        mat["adc_cast_aluminum"],
        brk,
        bevel=0.0005,
    )

    # Discrete side bosses visible in Maruzen CAD front view (Z = 0.184 m)
    for sx_sign, sx_tag in ((-1.0, "in"), (1.0, "out")):
        cylinder(
            f"{name}_cast_pin_boss_{sx_tag}",
            (sx_sign * 0.0088, 0.1280, 0.1840),
            0.0040,
            0.0030,
            mat["adc_cast_aluminum"],
            brk,
            "X",
        )

    if with_badge:
        box(
            "bps_maruzen_badge",
            (0.0093, 0.0450, PIPE_CENTER_Z),
            (0.0006, 0.0360, 0.0085),
            mat["badge_dark"],
            brk,
            0.0002,
        )
        text_label(
            "bps_maruzen_wordmark",
            "Maruzen",
            (0.0097, 0.0450, PIPE_CENTER_Z),
            0.0048,
            mat["ink_silver"],
            brk,
        )

    return brk


def build_drying_baking_tray(root, mat):
    tray = empty("bps_drying_tray", TRAY_ORIGIN, root)
    tray["accessory_role"] = "Inverted 400x300x20 mm washed aluminum baking tray drip-drying across 6 Ø16 mm pipes"
    tray["mass_kg"] = 0.850

    build_inverted_baking_tray_mesh("bps_drying_tray_pan", mat["aluminum_tray"], tray)

    socket = empty("vessel_socket", (0.0, 0.0, 0.0200), tray)
    socket["site_role"] = "Top grasp socket on inverted 400x300 mm baking tray"
    return tray


def compute_world_bounds(root, exclude_objs=()):
    bpy.context.view_layer.update()
    excluded = set(exclude_objs)
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in root.children_recursive:
        if obj.type != "MESH" or obj in excluded:
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
    dims = maxs - mins
    return {
        "min_m": [round(mins.x, 6), round(mins.y, 6), round(mins.z, 6)],
        "max_m": [round(maxs.x, 6), round(maxs.y, 6), round(maxs.z, 6)],
        "dimensions_m": [round(dims.x, 6), round(dims.y, 6), round(dims.z, 6)],
    }


def export_rest_glb(root, glb_path):
    bpy.context.scene.frame_set(1)
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()
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


def animate_timeline(brk_l, brk_r, tray):
    keyframes = (
        (1, 0.0, 0.0, TRAY_ORIGIN),
        (25, 0.0, 0.0, TRAY_ORIGIN),
        # Frame 60: Brackets widened from 700 mm to 900 mm wall-stud spacing, tray shifted along pipe rack
        (60, -0.100, 0.100, (0.0850, 0.0, 0.2200)),
        # Frame 90: Narrow 460 mm pitch (brackets at ±0.230 m clear central 400 mm tray at X=0.0)
        (90, 0.120, -0.120, (0.0, 0.0, 0.2200)),
        (120, 0.0, 0.0, TRAY_ORIGIN),
    )
    for frame_no, dl_x, dr_x, tray_loc in keyframes:
        brk_l.location = (BRACKET_LEFT_ORIGIN[0] + dl_x, BRACKET_LEFT_ORIGIN[1], BRACKET_LEFT_ORIGIN[2])
        brk_l.keyframe_insert(data_path="location", frame=frame_no)

        brk_r.location = (BRACKET_RIGHT_ORIGIN[0] + dr_x, BRACKET_RIGHT_ORIGIN[1], BRACKET_RIGHT_ORIGIN[2])
        brk_r.keyframe_insert(data_path="location", frame=frame_no)

        tray.location = tray_loc
        tray.keyframe_insert(data_path="location", frame=frame_no)


def configure_metal_cycles(scene):
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
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.14


def setup_studio_and_render(scene, skip_renders=False):
    before = set(scene.objects)
    configure_metal_cycles(scene)

    world = bpy.data.worlds.new("BPS30-12B Studio World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.66, 0.70, 0.75, 1.0)
        bg.inputs["Strength"].default_value = 0.55
    scene.world = world

    pedestal_mat = material("studio_pedestal", (0.28, 0.30, 0.33, 1.0), 0.0, 0.86)
    wall_mat = material("studio_tile_wall", (0.35, 0.38, 0.41, 1.0), 0.0, 0.78)
    bpy.ops.mesh.primitive_plane_add(size=120.0, location=(0.0, 0.0, -0.0005))
    ground = bpy.context.object
    ground.name = "Studio ground"
    ground.data.materials.append(pedestal_mat)

    wall = box(
        "Studio mounting wall",
        (0.0, 0.1710, 0.1800),
        (2.0000, 0.0400, 0.8000),
        wall_mat,
        None,
        0.0,
    )

    area_light("Key softbox", (-1.55, -1.85, 1.35), (0.0, 0.0, 0.14), 235.0, 1.6)
    area_light("Fill stripbox", (1.65, -0.75, 1.05), (0.0, 0.0, 0.14), 160.0, 1.3)
    area_light("Rim top softbox", (0.0, 0.95, 1.45), (0.0, 0.0, 0.18), 175.0, 1.4)
    area_light("Under-pipe fill", (0.0, -1.40, 0.05), (0.0, 0.0, 0.16), 80.0, 0.9)

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
        ("studio-main.png", (1.28, -2.05, 0.92), (0.0, 0.0, 0.135), 1.36, 1),
        ("studio-front.png", (0.0, -2.20, 0.125), (0.0, 0.0, 0.125), 1.34, 1),
        ("studio-top.png", (0.0, -0.01, 2.20), (0.0, 0.0, 0.130), 1.34, 1),
        ("studio-right.png", (2.20, 0.0, 0.125), (0.0, 0.0, 0.125), 0.52, 1),
        ("studio-active.png", (1.18, -1.98, 0.96), (0.02, 0.0, 0.135), 1.38, 60),
    )
    rendered = []
    if not skip_renders:
        for fname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            wall.hide_render = fname == "studio-top.png"
            camera.location = Vector(pos)
            camera.data.ortho_scale = scale
            look_at(camera, target)
            scene.render.filepath = str(ASSETS / fname)
            bpy.ops.render.render(write_still=True)
            rendered.append(fname)
        wall.hide_render = False

    scene.frame_set(1)
    camera.location = Vector(views[0][1])
    camera.data.ortho_scale = views[0][3]
    look_at(camera, views[0][2])
    return rendered


def run_glb_inspection(glb_path):
    """Re-import exported GLB into a clean scene and verify 1200x300x240 mm envelope, 6 Ø16 mm pipes, ADC brackets, tray, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["bps_shelf"]
    brk_l = objects["bps_bracket_left"]
    brk_r = objects["bps_bracket_right"]
    tray = objects["bps_drying_tray"]
    socket = objects["vessel_socket"]
    cap_r = objects["bps_pipe_01_cap_right"]

    for child in (brk_l, brk_r, tray):
        assert child.parent == root, child.name
    assert socket.parent == tray
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bpy.context.view_layer.update()
    low, high = mesh_bounds(root.children_recursive)
    dims = high - low
    for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Published Maruzen BPS30-12B 1200x300x240 mm envelope")
    near(low.x, -0.600, "Left chrome pipe cap X=-0.600")
    near(high.x, 0.600, "Right chrome pipe cap X=+0.600")
    near(low.y, -0.150, "Front ADC bracket nose Y=-0.150")
    near(high.y, 0.150, "Rear wall plane Y=+0.150")
    near(low.z, 0.000, "Lower ADC bracket foot Z=0.000")
    near(high.z, 0.240, "Upper ADC bracket wall ear & tray plane Z=0.240")

    shelf_only_objs = [o for o in root.children_recursive if o != tray and o not in set(tray.children_recursive)]
    s_low, s_high = mesh_bounds(shelf_only_objs)
    for actual, expected in zip(s_high - s_low, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Bare shelf 1200x300x240 mm envelope")

    orig_rx = cap_r.location.x
    cap_r.location.x += 0.010
    bpy.context.view_layer.update()
    f_low, f_high = mesh_bounds(root.children_recursive)
    fault_detected = abs((f_high.x - f_low.x) - WIDTH) > 0.005
    cap_r.location.x = orig_rx
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard must detect width perturbation"

    depsgraph = bpy.context.evaluated_depsgraph_get()
    pipe_heights = []
    for idx, py in enumerate(PIPE_YS, 1):
        pipe_obj = objects[f"bps_pipe_{idx:02d}"]
        for sx in (-0.380, 0.380):
            hit, point, normal, _face, hit_obj, _m = bpy.context.scene.ray_cast(
                depsgraph, Vector((sx, py, 0.260)), Vector((0.0, 0.0, -1.0))
            )
            assert hit and hit_obj == pipe_obj, (idx, sx, py, hit_obj.name if hit_obj else None)
            near(point.z, 0.220, f"Pipe {idx} top support plane Z=0.220")
            assert normal.z > 0.98, normal
            pipe_heights.append(round(point.z, 6))

    for gap_y in (-0.105, -0.055, -0.005, 0.045, 0.095):
        hit_gap, _pt, _n, _f, _ho, _m = bpy.context.scene.ray_cast(
            depsgraph, Vector((0.420, gap_y, 0.235)), Vector((0.0, 0.0, -1.0))
        )
        assert not hit_gap, f"Expected open vertical drip gap at Y={gap_y}"

    required_meshes = {
        *(f"bps_pipe_{i:02d}" for i in range(1, 7)),
        *(f"bps_pipe_{i:02d}_cap_left" for i in range(1, 7)),
        *(f"bps_pipe_{i:02d}_cap_right" for i in range(1, 7)),
        "bps_maruzen_badge",
        "bps_bracket_left_wall_flange",
        "bps_bracket_left_support_arm",
        "bps_bracket_left_diagonal_strut",
        "bps_bracket_right_wall_flange",
        "bps_bracket_right_support_arm",
        "bps_bracket_right_diagonal_strut",
        "bps_drying_tray_pan",
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
        "bounds_min_m": [round(v, 6) for v in low],
        "bounds_max_m": [round(v, 6) for v in high],
        "body_dimensions_m": [round(v, 6) for v in dims],
        "pipe_count": 6,
        "pipe_diameter_m": 0.016,
        "pipe_support_plane_z_m": 0.220,
        "pipe_ray_samples": len(pipe_heights),
        "open_drip_gaps_verified": 5,
        "articulated_and_free_bodies": [
            "bps_bracket_left",
            "bps_bracket_right",
            "bps_drying_tray",
        ],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import maruzen-bps30-12b.glb; verify exact 1200x300x240 mm envelope "
            "(X in [-0.600, +0.600], Y in [-0.150, +0.150], Z in [0.000, +0.240]) for both bare shelf "
            "and shelf with inverted 400x300x20 mm drying tray; verify fault-injection rejection; "
            "ray-cast all 6 Ø16 mm SUS430 tubes at Z=0.220 m and verify 5 open vertical drip gaps; "
            "verify ADC die-cast aluminum through-pipe movable brackets and zero mesh-quality errors."
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
        raise RuntimeError("Run in a separate background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Maruzen BPS30-12B - SUS430 wall drainer pipe shelf"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    root = empty("bps_shelf", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Maruzen Co., Ltd."
    root["series"] = "430 Bream Series"
    root["model"] = "BPS30-12B"
    root["japanese_title"] = "マルゼン ブリームシリーズ パイプ棚 BPS30-12B"
    root["material_spec"] = "SUS430 pipes + ADC die-cast aluminum brackets"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["pipe_count"] = 6
    root["pipe_diameter_m"] = 0.016
    root["manufacturer_unit_mass_kg"] = 6.200

    mat = surfaces()
    build_pipe_shelf_rack(root, mat)
    brk_l = build_movable_wall_bracket(
        "bps_bracket_left", BRACKET_LEFT_ORIGIN, (-0.120, 0.200), root, mat, with_badge=False
    )
    brk_r = build_movable_wall_bracket(
        "bps_bracket_right", BRACKET_RIGHT_ORIGIN, (-0.200, 0.120), root, mat, with_badge=True
    )
    tray = build_drying_baking_tray(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, brk_l, brk_r, tray])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, sharp_angle_deg=52.0)

    bounds = compute_world_bounds(root)
    for actual, expected in zip(bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (bounds, (WIDTH, DEPTH, HEIGHT))

    glb_path = ASSETS / f"{NAME}.glb"
    export_rest_glb(root, glb_path)

    animate_timeline(brk_l, brk_r, tray)
    for marker_name, fno in (
        ("Rest 700mm stud pitch", 1),
        ("Adjusted 900mm stud pitch", 60),
        ("Narrow 460mm stud pitch", 90),
        ("Restored", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=fno)

    appliance_col = bpy.data.collections.new("BPS30-12B appliance")
    scene.collection.children.link(appliance_col)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        appliance_col.objects.link(obj)

    renders = setup_studio_and_render(scene, skip_renders=args.skip_renders)

    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    blend_path = ASSETS / f"{NAME}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    build_report = {
        "asset": NAME,
        "manufacturer": "Maruzen Co., Ltd.",
        "series": "430 Bream Series",
        "model": "BPS30-12B",
        "japanese_name": "マルゼン ブリームシリーズ パイプ棚 BPS30-12B",
        "blender_version": bpy.app.version_string,
        "material_grade": "SUS430 pipes + ADC cast-aluminum brackets",
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_bounds_m": bounds,
        "bare_shelf_bounds_m": compute_world_bounds(root, exclude_objs=(tray, *tray.children_recursive)),
        "pipe_spec": {"count": 6, "diameter_m": 0.016, "y_centers_m": list(PIPE_YS), "top_z_m": 0.220},
        "bracket_stud_pitch_m": {"rest": 0.700, "min": 0.300, "max": 0.940},
        "unit_mass_kg": 6.200,
        "drying_tray_mass_kg": 0.850,
        "retained_bodies": [
            "bps_shelf",
            "bps_bracket_left",
            "bps_bracket_right",
            "bps_drying_tray",
        ],
        "renders": renders,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blend_sha256": hashlib.sha256(blend_path.read_bytes()).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    inspection_report = run_glb_inspection(glb_path)
    print(json.dumps({"build": build_report, "inspection": inspection_report}, indent=2))


if __name__ == "__main__":
    main()
