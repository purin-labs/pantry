"""Build the Japanese Maruzen HMHS-054 SUS304 wall-mounted commercial hand-wash sink visual model.

Metres, Z up, operator front towards -Y, rear wall mounting plane at Y = +0.235 m.
Follows Maruzen Co., Ltd. Catalogue 48010 CAD & photo specification for HMHS-054 (マルゼン ステンレス製手洗い器 壁掛け式):
- Overall envelope: 500 x 470 x 400 mm (W x D x H; catalog P=380 mm, Y=440 mm, S=280 mm)
  occupying X in [-0.250, +0.250], Y in [-0.235, +0.235], Z in [0.000, +0.400].
- Plan breakdown: W(500) = 60 + P(380) + 60 mm; D(470) = 60 front + S(280) bowl + 100 rear faucet deck + 30 splashback.
- Removable pressed SUS304 HL t1.2 top cap (トップ取外し式, 40 mm apron, R20 rounded front corners, side retention screws),
  deep-drawn 380 x 280 mm sanitary coved bowl, angled H 150 mm integral splashback (Z_top = 0.400 m) with rear keyhole slots,
  and full wrap-around SUS304 No.4 t1.0 cosmetic box skirt (化粧板, R18.4 front corners, sloped side bottom edge to Z = 0.000 m).
- Deck-mounted chrome gooseneck faucet with hygienic wrist/elbow blade lever + aerator, 500 mL spring-return soap dispenser,
  removable perforated stainless drain strainer, and lower chrome 25A S/P-trap sanitary drain assembly.
"""

import argparse
import hashlib
import json
import math
import sys
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
    look_at,
    material,
)
from inspect_induction import bounds as mesh_bounds, near
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-hmhs-054"
DOCS_DIR = ROOT / "docs/equipment/maruzen-hmhs-054"
NAME = "maruzen-hmhs-054"

WIDTH = 0.5000
DEPTH = 0.4700
HEIGHT = 0.4000

BOWL_W = 0.3800  # Catalog P = 380 mm
BOWL_D = 0.2800  # Catalog S = 280 mm
BOWL_CY = -0.0350  # 60 mm front deck (-0.235..-0.175) + 280 mm bowl (-0.175..+0.105) + 100 mm rear deck (+0.105..+0.205)

FAUCET_BASE_XY = (0.0650, 0.1720)
LEVER_PIVOT = (0.0650, 0.1720, 0.2760)
SPOUT_PIVOT = (0.0650, 0.1720, 0.2940)
SOAP_ORIGIN = (-0.1150, 0.1720, 0.3240)
STRAINER_ORIGIN = (0.0000, -0.0200, 0.0680)


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
        "sus304_hl_top": material("sus304_hl_top", (0.68, 0.70, 0.73, 1.0), 0.91, 0.21),
        "sus304_bowl": material("sus304_bowl", (0.63, 0.66, 0.69, 1.0), 0.90, 0.25),
        "sus304_no4_skirt": material("sus304_no4_skirt", (0.64, 0.67, 0.70, 1.0), 0.89, 0.26),
        "sus304_frame": material("sus304_frame", (0.54, 0.57, 0.60, 1.0), 0.84, 0.31),
        "chrome_faucet": material("chrome_faucet", (0.82, 0.84, 0.87, 1.0), 0.97, 0.09),
        "brass_fitting": material("brass_fitting", (0.72, 0.55, 0.24, 1.0), 0.88, 0.25),
        "soap_bottle": material("soap_bottle", (0.88, 0.90, 0.92, 1.0), 0.02, 0.36),
        "gasket_dark": material("gasket_dark", (0.05, 0.055, 0.06, 1.0), 0.04, 0.58),
        "index_blue": material("index_blue", (0.03, 0.26, 0.68, 1.0), 0.10, 0.22),
        "badge_dark": material("badge_dark", (0.10, 0.12, 0.15, 1.0), 0.35, 0.28),
        "ink_silver": material("ink_silver", (0.84, 0.86, 0.89, 1.0), 0.78, 0.22),
    }
    for m in mats.values():
        m["metallic"] = float(m["metallic"])
        m["roughness"] = float(m["roughness"])
        m["emission"] = float(m["emission"])
    return mats


def rounded_rect_loop_ccw(cx, cy, w, d, radius, segs=10):
    r = min(radius, w * 0.48, d * 0.48)
    corners = (
        (cx + w / 2 - r, cy + d / 2 - r, 0.0),
        (cx - w / 2 + r, cy + d / 2 - r, 90.0),
        (cx - w / 2 + r, cy - d / 2 + r, 180.0),
        (cx + w / 2 - r, cy - d / 2 + r, 270.0),
    )
    pts = []
    for ox, oy, start_deg in corners:
        for step in range(segs + 1):
            ang = math.radians(start_deg + step * 90.0 / segs)
            pts.append((ox + r * math.cos(ang), oy + r * math.sin(ang)))
    return pts


def front_rounded_u_loop_ccw(w, y_front, y_rear, r_front, r_rear=0.0008, segs=10):
    """CCW plan loop with crisp R0.8 rear wall corners and smooth R20 rounded front corners per Maruzen CAD."""
    rf = min(r_front, w * 0.45, (y_rear - y_front) * 0.45)
    rr = min(r_rear, w * 0.45, (y_rear - y_front) * 0.45)
    corners = (
        (w / 2 - rr, y_rear - rr, rr, 0.0),
        (-w / 2 + rr, y_rear - rr, rr, 90.0),
        (-w / 2 + rf, y_front + rf, rf, 180.0),
        (w / 2 - rf, y_front + rf, rf, 270.0),
    )
    pts = []
    for ox, oy, rad, start_deg in corners:
        for step in range(segs + 1):
            ang = math.radians(start_deg + step * 90.0 / segs)
            pts.append((ox + rad * math.cos(ang), oy + rad * math.sin(ang)))
    return pts


def build_annulus_plate(name, outer_loop, inner_loop, z_bot, z_top, surface, parent, bevel=0.0):
    """Build a watertight plate bridging equal-count CCW outer_loop and inner_loop."""
    n = len(outer_loop)
    assert len(inner_loop) == n
    verts = []
    verts.extend((x, y, z_top) for x, y in outer_loop)
    verts.extend((x, y, z_top) for x, y in inner_loop)
    verts.extend((x, y, z_bot) for x, y in outer_loop)
    verts.extend((x, y, z_bot) for x, y in inner_loop)

    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j))
        faces.append((i, 2 * n + i, 2 * n + j, j))
        faces.append((n + i, n + j, 3 * n + j, 3 * n + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=bevel)


def build_extruded_profile_along_x(name, x0, x1, yz_ccw, surface, parent):
    """Extrude a CCW profile in (Y, Z) from x0 to x1 with outward normals."""
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
    return finish(obj, name, surface, parent, bevel=0.0)


def build_lofted_drawn_bowl(name, surface, parent):
    """Build a solid manifold deep-drawn 380 x 280 mm (P=380, S=280) SUS304 sanitary bowl with circular sump."""
    segs = 10
    rect_stations = (
        (0.0, BOWL_CY, BOWL_W, BOWL_D, 0.0540, 0.2536),
        (0.0, BOWL_CY, 0.3760, 0.2760, 0.0540, 0.2080),
        (0.0, BOWL_CY + 0.0010, 0.3680, 0.2680, 0.0550, 0.1450),
        (0.0, BOWL_CY + 0.0020, 0.3540, 0.2540, 0.0570, 0.1020),
        (0.0, BOWL_CY + 0.0030, 0.3300, 0.2320, 0.0600, 0.0845),
    )
    inner_rings = [
        [(x, y, z) for x, y in rounded_rect_loop_ccw(cx, cy, w, d, r, segs=segs)]
        for cx, cy, w, d, r, z in rect_stations
    ]

    # Ray-matched circular drain throat around STRAINER_ORIGIN = (0.0, -0.0200)
    sx0, sy0, _ = STRAINER_ORIGIN
    floor_angles = [math.atan2(y - sy0, x - sx0) for x, y, _ in inner_rings[-1]]
    for rad, z_lvl in (
        (0.0520, 0.0725),
        (0.0375, 0.0680),
        (0.0285, 0.0520),
    ):
        inner_rings.append(
            [(sx0 + rad * math.cos(a), sy0 + rad * math.sin(a), z_lvl) for a in floor_angles]
        )

    wall_t = 0.0022
    outer_rings = []
    for r_idx, ring in enumerate(inner_rings):
        cx_ref = 0.0
        cy_ref = BOWL_CY if r_idx < len(rect_stations) else sy0
        out_r = []
        for x, y, z in ring:
            dx = x - cx_ref
            dy = y - cy_ref
            ln = math.hypot(dx, dy) or 1.0
            z_out = 0.2520 if r_idx == 0 else z - wall_t
            out_r.append((x + wall_t * dx / ln, y + wall_t * dy / ln, z_out))
        outer_rings.append(out_r)

    n_rings = len(inner_rings)
    ring_len = len(inner_rings[0])
    verts = []
    for ring in inner_rings:
        verts.extend(ring)
    for ring in outer_rings:
        verts.extend(ring)

    faces = []
    for r_idx in range(n_rings - 1):
        b0 = r_idx * ring_len
        b1 = (r_idx + 1) * ring_len
        for i in range(ring_len):
            j = (i + 1) % ring_len
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))

    outer_base = n_rings * ring_len
    for r_idx in range(n_rings - 1):
        b0 = outer_base + r_idx * ring_len
        b1 = outer_base + (r_idx + 1) * ring_len
        for i in range(ring_len):
            j = (i + 1) % ring_len
            faces.append((b0 + i, b1 + i, b1 + j, b0 + j))

    top_in = 0
    top_out = outer_base
    bot_in = (n_rings - 1) * ring_len
    bot_out = outer_base + (n_rings - 1) * ring_len
    for i in range(ring_len):
        j = (i + 1) % ring_len
        faces.append((top_in + i, top_out + i, top_out + j, top_in + j))
        faces.append((bot_in + i, bot_in + j, bot_out + j, bot_out + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_cosmetic_wrap_skirt(name, surface, parent):
    """Build the Maruzen HMHS-054 SUS304 No.4 wrap-around skirt (化粧板): R18.4 front corners + sloped side bottom to Z=0."""
    segs = 10
    outer_xy = front_rounded_u_loop_ccw(0.4968, -0.2334, 0.2350, 0.0184, 0.0008, segs=segs)
    inner_xy = front_rounded_u_loop_ccw(0.4924, -0.2312, 0.2328, 0.0162, 0.0008, segs=segs)
    n = len(outer_xy)
    z_top = 0.2138

    def z_bot_at_y(y_val):
        if y_val <= -0.2150:
            return 0.0820
        if y_val >= 0.2342:
            return 0.0000
        return 0.0820 * (0.2350 - y_val) / (0.2350 - (-0.2150))

    verts = []
    verts.extend((x, y, z_top) for x, y in outer_xy)
    verts.extend((x, y, z_top) for x, y in inner_xy)
    verts.extend((x, y, z_bot_at_y(y)) for x, y in outer_xy)
    verts.extend((x, y, max(0.0020, z_bot_at_y(y) + 0.0015)) for x, y in inner_xy)

    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j))
        faces.append((i, 2 * n + i, 2 * n + j, j))
        faces.append((n + i, n + j, 3 * n + j, 3 * n + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_curved_pipe_mesh(name, centerline_points, radius, surface, parent, radial_segments=28):
    """Build a manifold capped tubular mesh along 3D centerline points with smooth parallel-transport frame."""
    pts = [Vector(p) for p in centerline_points]
    n_pts = len(pts)
    verts = []
    faces = []

    prev_up = Vector((1.0, 0.0, 0.0))
    for idx, p in enumerate(pts):
        if idx == 0:
            tangent = (pts[1] - pts[0]).normalized()
        elif idx == n_pts - 1:
            tangent = (pts[-1] - pts[-2]).normalized()
        else:
            tangent = ((pts[idx] - pts[idx - 1]).normalized() + (pts[idx + 1] - pts[idx]).normalized()).normalized()

        normal = prev_up - tangent * prev_up.dot(tangent)
        if normal.length < 1e-5:
            fallback = Vector((0.0, 1.0, 0.0)) if abs(tangent.x) > 0.9 else Vector((1.0, 0.0, 0.0))
            normal = (fallback - tangent * fallback.dot(tangent)).normalized()
        else:
            normal.normalize()
        binormal = tangent.cross(normal).normalized()
        prev_up = normal

        for s in range(radial_segments):
            ang = 2.0 * math.pi * s / radial_segments
            offset = normal * (radius * math.cos(ang)) + binormal * (radius * math.sin(ang))
            v = p + offset
            verts.append((v.x, v.y, v.z))

    for idx in range(n_pts - 1):
        b0 = idx * radial_segments
        b1 = (idx + 1) * radial_segments
        for s in range(radial_segments):
            sn = (s + 1) % radial_segments
            faces.append((b0 + s, b0 + sn, b1 + sn, b1 + s))

    start_center_idx = len(verts)
    verts.append((pts[0].x, pts[0].y, pts[0].z))
    end_center_idx = len(verts)
    verts.append((pts[-1].x, pts[-1].y, pts[-1].z))
    last_ring = (n_pts - 1) * radial_segments
    for s in range(radial_segments):
        sn = (s + 1) % radial_segments
        faces.append((start_center_idx, sn, s))
        faces.append((end_center_idx, last_ring + s, last_ring + sn))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def hex_nut(name, center, across_flats, height, surface, parent):
    r_circum = (across_flats * 0.5) / math.cos(math.radians(30.0))
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r_circum, depth=height, location=center)
    return finish(bpy.context.object, name, surface, parent, 0.0)


def text_label(name, text, position, size, surface, parent, rot_x=math.pi / 2):
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
    obj.rotation_euler.x = rot_x
    return finish(obj, name, surface, parent, 0.0)


def build_sink_basin_and_drain(root, mat):
    segs = 10
    # 1. Seamless 500 x 470 mm SUS304 HL pressed deck (R20 front corners, framing 380 x 280 mm bowl)
    deck_outer = front_rounded_u_loop_ccw(0.4980, -0.2340, 0.2065, 0.0190, 0.0008, segs=segs)
    deck_inner = rounded_rect_loop_ccw(0.0, BOWL_CY, BOWL_W, BOWL_D, 0.0540, segs=segs)
    build_annulus_plate(
        "hmhs_pressed_deck",
        deck_outer,
        deck_inner,
        0.2515,
        0.2542,
        mat["sus304_hl_top"],
        root,
    )

    # 2. Seamless R20 removable pressed top cap perimeter roll & 40 mm apron (トップ取外し式, Z = 0.2150..0.2550 m)
    lip_outer = front_rounded_u_loop_ccw(WIDTH, -0.2350, 0.2065, 0.0200, 0.0008, segs=segs)
    lip_inner = front_rounded_u_loop_ccw(0.4840, -0.2270, 0.2055, 0.0120, 0.0008, segs=segs)
    build_annulus_plate(
        "hmhs_anti_drip_front_lip",
        lip_outer,
        lip_inner,
        0.2535,
        0.2555,
        mat["sus304_hl_top"],
        root,
        bevel=0.0008,
    )

    apron_outer = front_rounded_u_loop_ccw(WIDTH, -0.2350, 0.2350, 0.0200, 0.0008, segs=segs)
    apron_inner = front_rounded_u_loop_ccw(0.4944, -0.2322, 0.2322, 0.0172, 0.0008, segs=segs)
    build_annulus_plate(
        "hmhs_front_apron",
        apron_outer,
        apron_inner,
        0.2150,
        0.2546,
        mat["sus304_hl_top"],
        root,
        bevel=0.0006,
    )

    # Side retention Phillips screws on the removable 40 mm top cap (2 per side per Maruzen photo & CAD)
    for s_sign, s_tag in ((-1.0, "left"), (1.0, "right")):
        for idx, sy in enumerate((-0.0780, 0.1420), 1):
            bpy.ops.mesh.primitive_cylinder_add(
                vertices=20,
                radius=0.0032,
                depth=0.0012,
                location=(s_sign * 0.2494, sy, 0.2340),
                rotation=(0.0, math.pi / 2, 0.0),
            )
            finish(bpy.context.object, f"hmhs_top_cap_screw_{s_tag}_{idx}", mat["chrome_faucet"], root, 0.0)

    # Subtle authentic metallic/charcoal Maruzen nameplate on upper-right front apron (strictly inside Y >= -0.2350)
    box(
        "hmhs_maruzen_badge",
        (0.1680, -0.2344, 0.2345),
        (0.0420, 0.0006, 0.0105),
        mat["badge_dark"],
        root,
        0.0002,
    )
    text_label(
        "hmhs_maruzen_wordmark",
        "Maruzen",
        (0.1680, -0.2348, 0.2345),
        0.0056,
        mat["ink_silver"],
        root,
    )

    # 3. Full wrap-around SUS304 No.4 t1.0 cosmetic box skirt (化粧板, sloped side bottom reaching exact Z = 0.0000 m)
    build_cosmetic_wrap_skirt("hmhs_cosmetic_skirt", mat["sus304_no4_skirt"], root)

    # Angled left & right bottom belly flanges enclosing under-deck plumbing while framing central 25A chrome trap
    belly_profile_yz = [
        (-0.2150, 0.0825),
        (0.2320, 0.0040),
        (0.2320, 0.0070),
        (-0.2150, 0.0855),
    ]
    build_extruded_profile_along_x("hmhs_belly_pan_left", -0.2460, -0.0480, belly_profile_yz, mat["sus304_frame"], root)
    build_extruded_profile_along_x("hmhs_belly_pan_right", 0.0480, 0.2460, belly_profile_yz, mat["sus304_frame"], root)

    # 4. Deep-drawn 380 x 280 mm sanitary hand-wash bowl (P=380, S=280)
    bowl = build_lofted_drawn_bowl("hmhs_drawn_bowl", mat["sus304_bowl"], root)

    # 5. Integral angled H 150 mm rear splashback (バックガード, 30 mm base depth -> 14 mm top return at Z = 0.4000 m)
    splash_profile_yz = [
        (0.2050, 0.2520),
        (0.2050, 0.2560),
        (0.2208, 0.3992),
        (0.2216, 0.4000),
        (0.2350, 0.4000),
        (0.2350, 0.2520),
    ]
    build_extruded_profile_along_x(
        "hmhs_rear_splashback", -0.2500, 0.2500, splash_profile_yz, mat["sus304_hl_top"], root
    )

    # Concealed rear-face keyhole mounting brackets (Y寸法 = 440 mm -> X = ±0.2200 m) & internal wall channels
    for s_sign, s_name in ((-1.0, "left"), (1.0, "right")):
        kx = s_sign * 0.2200
        box(
            f"hmhs_keyhole_bracket_{s_name}",
            (kx, 0.2325, 0.3650),
            (0.0320, 0.0040, 0.0400),
            mat["sus304_frame"],
            root,
            0.0006,
        )
        box(
            f"hmhs_wall_leg_{s_name}",
            (kx, 0.2260, 0.1260),
            (0.0280, 0.0140, 0.2520),
            mat["sus304_frame"],
            root,
            0.0,
        )

    # 6. Bottom 25A chrome S/P-trap sanitary drain assembly touching exact Z = 0.0000 m
    cylinder(
        "hmhs_drain_cup_housing",
        (0.0, -0.0200, 0.0560),
        0.0390,
        0.0220,
        mat["sus304_frame"],
        root,
    )
    hex_nut(
        "hmhs_drain_brass_locknut",
        (0.0, -0.0200, 0.0415),
        0.0460,
        0.0090,
        mat["brass_fitting"],
        root,
    )

    # Trap cleanout pedestal cap resting strictly on Z = 0.000000 m (bevel=0.0)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32, radius=0.0225, depth=0.0400, location=(0.0, -0.0200, 0.0200)
    )
    finish(bpy.context.object, "hmhs_trap_cleanout_base", mat["chrome_faucet"], root, 0.0)
    hex_nut(
        "hmhs_trap_cleanout_nut",
        (0.0, -0.0200, 0.0040),
        0.0340,
        0.0060,
        mat["chrome_faucet"],
        root,
    )

    build_curved_pipe_mesh(
        "hmhs_trap_25a_p_branch",
        (
            (0.0, -0.0200, 0.0310),
            (0.0, 0.0450, 0.0310),
            (0.0, 0.1450, 0.0310),
            (0.0, 0.2310, 0.0310),
        ),
        0.0155,
        mat["chrome_faucet"],
        root,
        radial_segments=28,
    )

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32,
        radius=0.0275,
        depth=0.0050,
        location=(0.0, 0.2325, 0.0310),
        rotation=(math.pi / 2, 0.0, 0.0),
    )
    finish(bpy.context.object, "hmhs_drain_wall_escutcheon", mat["chrome_faucet"], root, 0.0)

    # Concealed 13A supply riser inside cosmetic skirt
    cylinder(
        "hmhs_water_inlet_13a",
        (0.0650, 0.2140, 0.1650),
        0.0110,
        0.0380,
        mat["brass_fitting"],
        root,
        "Y",
    )
    build_curved_pipe_mesh(
        "hmhs_water_supply_riser",
        (
            (0.0650, 0.1950, 0.1650),
            (0.0650, 0.1720, 0.1950),
            (0.0650, 0.1720, 0.2520),
        ),
        0.0070,
        mat["chrome_faucet"],
        root,
        radial_segments=20,
    )

    return bowl


def build_faucet_and_soap_dispenser(root, mat):
    # Fixed chrome faucet escutcheon & stepped valve body on rear 100 mm deck
    fx, fy = FAUCET_BASE_XY
    cylinder(
        "hmhs_faucet_deck_gasket",
        (fx, fy, 0.2548),
        0.0255,
        0.0016,
        mat["gasket_dark"],
        root,
    )
    cylinder(
        "hmhs_faucet_deck_flange",
        (fx, fy, 0.2582),
        0.0245,
        0.0055,
        mat["chrome_faucet"],
        root,
    )
    cylinder(
        "hmhs_faucet_valve_body",
        (fx, fy, 0.2775),
        0.0175,
        0.0335,
        mat["chrome_faucet"],
        root,
    )
    # Discrete recessed blue cold-water index dot on front face of chrome valve body
    cylinder(
        "hmhs_faucet_cold_index",
        (fx, fy - 0.0172, 0.2675),
        0.0026,
        0.0014,
        mat["index_blue"],
        root,
        "Y",
    )

    # Articulated hygienic wrist/elbow blade lever (hmhs_faucet_lever)
    # Hinge hmhs_faucet_valve: axis (0, 0, 1), range 0 .. 1.5708 rad
    lever = empty("hmhs_faucet_lever", LEVER_PIVOT, root)
    lever["joint_name"] = "hmhs_faucet_valve"
    lever["joint_type"] = "hinge"
    lever["axis_blender"] = [0.0, 0.0, 1.0]
    lever["range_rad"] = [0.0, 1.5708]

    cylinder(
        "hmhs_faucet_lever_hub",
        (0.0, 0.0, 0.0),
        0.0185,
        0.0135,
        mat["chrome_faucet"],
        lever,
    )
    build_curved_pipe_mesh(
        "hmhs_faucet_lever_arm",
        (
            (-0.0140, 0.0, 0.0010),
            (-0.0420, 0.0, 0.0035),
            (-0.0760, 0.0, 0.0075),
        ),
        0.0042,
        mat["chrome_faucet"],
        lever,
        radial_segments=20,
    )

    # Sculpted rounded-end hygienic wrist blade paddle
    paddle_loop = rounded_rect_loop_ccw(-0.0980, 0.0, 0.0520, 0.0200, 0.0095, segs=8)
    p_verts = [(x, y, 0.0055) for x, y in paddle_loop] + [(x, y, 0.0100) for x, y in paddle_loop]
    np_v = len(paddle_loop)
    p_faces: list[tuple[int, ...]] = [
        tuple(reversed(range(np_v))),
        tuple(range(np_v, 2 * np_v)),
    ]
    for i in range(np_v):
        j = (i + 1) % np_v
        p_faces.append((i, j, np_v + j, np_v + i))
    p_mesh = bpy.data.meshes.new("hmhs_faucet_wrist_blade")
    p_mesh.from_pydata(p_verts, [], p_faces)
    p_mesh.update()
    p_obj = bpy.data.objects.new("hmhs_faucet_wrist_blade", p_mesh)
    bpy.context.scene.collection.objects.link(p_obj)
    finish(p_obj, "hmhs_faucet_wrist_blade", mat["chrome_faucet"], lever, bevel=0.0012)

    # Articulated chrome gooseneck spout + aerator (hmhs_spout_swivel)
    # Hinge hmhs_spout_turn: axis (0, 0, 1), range -0.785 .. +0.785 rad
    spout = empty("hmhs_spout_swivel", SPOUT_PIVOT, root)
    spout["joint_name"] = "hmhs_spout_turn"
    spout["joint_type"] = "hinge"
    spout["axis_blender"] = [0.0, 0.0, 1.0]
    spout["range_rad"] = [-0.785, 0.785]

    hex_nut(
        "hmhs_spout_swivel_nut",
        (0.0, 0.0, 0.0045),
        0.0260,
        0.0080,
        mat["chrome_faucet"],
        spout,
    )
    cylinder(
        "hmhs_spout_swivel_collar",
        (0.0, 0.0, 0.0125),
        0.0130,
        0.0100,
        mat["chrome_faucet"],
        spout,
    )

    arch_pts = [(0.0, 0.0, 0.0140), (0.0, 0.0, 0.0380)]
    arch_radius = 0.0760
    arch_cy = -0.0760
    arch_cz = 0.0180
    for step in range(1, 25):
        ang = math.pi * step / 24.0
        ay = arch_cy + arch_radius * math.cos(ang)
        az = arch_cz + arch_radius * math.sin(ang)
        arch_pts.append((0.0, ay, az))
    arch_pts.append((0.0, -0.1520, 0.0075))
    build_curved_pipe_mesh(
        "hmhs_spout_gooseneck_tube",
        arch_pts,
        0.0088,
        mat["chrome_faucet"],
        spout,
        radial_segments=32,
    )

    cylinder(
        "hmhs_spout_aerator",
        (0.0, -0.1520, 0.0038),
        0.0118,
        0.0110,
        mat["chrome_faucet"],
        spout,
    )
    cylinder(
        "hmhs_spout_aerator_screen",
        (0.0, -0.1520, -0.0018),
        0.0092,
        0.0014,
        mat["gasket_dark"],
        spout,
    )

    # Concealed under-deck 500 mL soap reservoir bottle (inside wrap-around skirt) & chrome deck collar
    sx, sy, _sz = SOAP_ORIGIN
    cylinder(
        "hmhs_soap_reservoir_bottle",
        (sx, sy, 0.1760),
        0.0300,
        0.1240,
        mat["soap_bottle"],
        root,
    )
    cylinder(
        "hmhs_soap_deck_rosette",
        (sx, sy, 0.2565),
        0.0220,
        0.0045,
        mat["chrome_faucet"],
        root,
    )
    cylinder(
        "hmhs_soap_deck_collar",
        (sx, sy, 0.2780),
        0.0155,
        0.0400,
        mat["chrome_faucet"],
        root,
    )

    # Spring-return soap plunger head (hmhs_soap_plunger)
    # Slide hmhs_soap_press: axis (0, 0, -1), range 0 .. 0.022 m
    plunger = empty("hmhs_soap_plunger", SOAP_ORIGIN, root)
    plunger["joint_name"] = "hmhs_soap_press"
    plunger["joint_type"] = "slide"
    plunger["axis_blender"] = [0.0, 0.0, -1.0]
    plunger["range_m"] = [0.0, 0.022]

    cylinder(
        "hmhs_soap_plunger_stem",
        (0.0, 0.0, -0.0150),
        0.0052,
        0.0320,
        mat["chrome_faucet"],
        plunger,
    )
    cylinder(
        "hmhs_soap_plunger_cap",
        (0.0, 0.0, 0.0055),
        0.0148,
        0.0130,
        mat["chrome_faucet"],
        plunger,
    )
    build_curved_pipe_mesh(
        "hmhs_soap_nozzle_spout",
        (
            (0.0, -0.0080, 0.0045),
            (0.0, -0.0440, 0.0020),
            (0.0, -0.0720, -0.0080),
        ),
        0.0042,
        mat["chrome_faucet"],
        plunger,
        radial_segments=20,
    )

    # Removable perforated stainless drain strainer cup (hmhs_drain_strainer)
    # Slide hmhs_strainer_lift: axis (0, 0, 1), range 0 .. 0.060 m
    strainer = empty("hmhs_drain_strainer", STRAINER_ORIGIN, root)
    strainer["joint_name"] = "hmhs_strainer_lift"
    strainer["joint_type"] = "slide"
    strainer["axis_blender"] = [0.0, 0.0, 1.0]
    strainer["range_m"] = [0.0, 0.060]

    fl_outer = [(0.0365 * math.cos(2 * math.pi * k / 32), 0.0365 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
    fl_inner = [(0.0245 * math.cos(2 * math.pi * k / 32), 0.0245 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
    build_annulus_plate(
        "hmhs_strainer_flange",
        fl_outer,
        fl_inner,
        0.0002,
        0.0028,
        mat["chrome_faucet"],
        strainer,
        bevel=0.0004,
    )
    cylinder(
        "hmhs_strainer_basket",
        (0.0, 0.0, -0.0085),
        0.0265,
        0.0170,
        mat["sus304_bowl"],
        strainer,
    )
    cylinder(
        "hmhs_strainer_perforation_plate",
        (0.0, 0.0, 0.0012),
        0.0242,
        0.0012,
        mat["sus304_hl_top"],
        strainer,
    )
    for k in range(8):
        ang = 2.0 * math.pi * k / 8.0
        cylinder(
            f"hmhs_strainer_slot_{k + 1}",
            (0.0145 * math.cos(ang), 0.0145 * math.sin(ang), 0.0016),
            0.0026,
            0.0008,
            mat["gasket_dark"],
            strainer,
        )
    cylinder(
        "hmhs_strainer_lift_pin",
        (0.0, 0.0, 0.0115),
        0.0030,
        0.0180,
        mat["chrome_faucet"],
        strainer,
    )
    cylinder(
        "hmhs_strainer_lift_knob",
        (0.0, 0.0, 0.0210),
        0.0080,
        0.0032,
        mat["chrome_faucet"],
        strainer,
    )

    return lever, spout, plunger, strainer


def compute_world_bounds(root):
    bpy.context.view_layer.update()
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in root.children_recursive:
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


def animate_timeline(lever, spout, plunger, strainer):
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0),
        (20, 0.0, 0.0, 0.022, 0.0),
        (35, 0.0, 0.0, 0.0, 0.0),
        (60, 1.15, -0.42, 0.016, 0.042),
        (85, 1.45, 0.42, 0.0, 0.052),
        (120, 0.0, 0.0, 0.0, 0.0),
    )
    for frame_no, lev_rz, sp_rz, soap_dz, str_dz in keyframes:
        lever.rotation_euler = Euler((0.0, 0.0, lev_rz), "XYZ")
        lever.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        spout.rotation_euler = Euler((0.0, 0.0, sp_rz), "XYZ")
        spout.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        plunger.location = (SOAP_ORIGIN[0], SOAP_ORIGIN[1], SOAP_ORIGIN[2] - soap_dz)
        plunger.keyframe_insert(data_path="location", frame=frame_no)

        strainer.location = (STRAINER_ORIGIN[0], STRAINER_ORIGIN[1], STRAINER_ORIGIN[2] + str_dz)
        strainer.keyframe_insert(data_path="location", frame=frame_no)


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

    world = bpy.data.worlds.new("HMHS-054 Studio World")
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
        (0.0, 0.2560, 0.2800),
        (1.6000, 0.0400, 0.9000),
        wall_mat,
        None,
        0.0,
    )

    area_light("Key softbox", (-1.15, -1.45, 1.25), (0.0, 0.0, 0.22), 190.0, 1.35)
    area_light("Fill stripbox", (1.25, -0.55, 0.95), (0.0, 0.0, 0.22), 130.0, 1.15)
    area_light("Rim top softbox", (0.0, 0.85, 1.35), (0.0, 0.0, 0.26), 145.0, 1.15)
    area_light("Bowl interior fill", (0.0, -1.10, 0.68), (0.0, -0.02, 0.16), 60.0, 0.75)

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
        ("studio-main.png", (0.92, -1.38, 0.78), (0.0, 0.0, 0.205), 0.68, 1),
        ("studio-front.png", (0.0, -1.60, 0.200), (0.0, 0.0, 0.200), 0.62, 1),
        ("studio-top.png", (0.0, -0.01, 1.65), (0.0, 0.0, 0.200), 0.64, 1),
        ("studio-right.png", (1.60, 0.0, 0.200), (0.0, 0.0, 0.200), 0.62, 1),
        ("studio-active.png", (0.86, -1.34, 0.82), (0.0, 0.0, 0.215), 0.70, 60),
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
    """Re-import exported GLB into a clean scene and verify envelope, concavity, joints, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["hmhs_basin"]
    lever = objects["hmhs_faucet_lever"]
    spout = objects["hmhs_spout_swivel"]
    plunger = objects["hmhs_soap_plunger"]
    strainer = objects["hmhs_drain_strainer"]
    bowl = objects["hmhs_drawn_bowl"]
    splashback = objects["hmhs_rear_splashback"]

    for child in (lever, spout, plunger, strainer):
        assert child.parent == root, child.name
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bpy.context.view_layer.update()
    low, high = mesh_bounds(root.children_recursive)
    dims = high - low
    for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Published Maruzen HMHS-054 500x470x400 mm envelope")
    near(low.x, -0.250, "Left rim X=-0.250")
    near(high.x, 0.250, "Right rim X=+0.250")
    near(low.y, -0.235, "Front R20 sanitary rim Y=-0.235")
    near(high.y, 0.235, "Rear wall plane Y=+0.235")
    near(low.z, 0.000, "Lower sloped skirt & 25A trap reference Z=0.000")
    near(high.z, 0.400, "Rear splashback top edge Z=0.400")

    orig_z = splashback.location.z
    splashback.location.z += 0.008
    bpy.context.view_layer.update()
    fault_low, fault_high = mesh_bounds(root.children_recursive)
    fault_detected = abs((fault_high.z - fault_low.z) - HEIGHT) > 0.004
    splashback.location.z = orig_z
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard must detect Z perturbation"

    depsgraph = bpy.context.evaluated_depsgraph_get()
    concave_depths = []
    for sx, sy in ((-0.12, -0.10), (0.12, -0.10), (-0.12, 0.05), (0.12, 0.05), (-0.08, -0.02)):
        hit, point, normal, _face, hit_obj, _m = bpy.context.scene.ray_cast(
            depsgraph, Vector((sx, sy, 0.250)), Vector((0.0, 0.0, -1.0))
        )
        assert hit and hit_obj == bowl, (sx, sy, hit_obj.name if hit_obj else None)
        assert 0.070 <= point.z <= 0.110, (sx, sy, point.z)
        assert normal.z > 0.50, normal
        concave_depths.append(round(0.255 - point.z, 4))

    required_meshes = {
        "hmhs_pressed_deck",
        "hmhs_anti_drip_front_lip",
        "hmhs_front_apron",
        "hmhs_cosmetic_skirt",
        "hmhs_drawn_bowl",
        "hmhs_rear_splashback",
        "hmhs_trap_cleanout_base",
        "hmhs_trap_25a_p_branch",
        "hmhs_faucet_valve_body",
        "hmhs_faucet_wrist_blade",
        "hmhs_spout_gooseneck_tube",
        "hmhs_spout_aerator",
        "hmhs_soap_reservoir_bottle",
        "hmhs_soap_plunger_cap",
        "hmhs_soap_nozzle_spout",
        "hmhs_strainer_basket",
        "hmhs_strainer_flange",
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
        "bowl_concave_depth_samples_m": concave_depths,
        "articulated_bodies": [
            "hmhs_faucet_lever",
            "hmhs_spout_swivel",
            "hmhs_soap_plunger",
            "hmhs_drain_strainer",
        ],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import maruzen-hmhs-054.glb; verify exact 500x470x400 mm SUS304 envelope "
            "(X in [-0.250, +0.250], Y in [-0.235, +0.235], Z in [0.000, +0.400]); "
            "verify R20 removable top cap, wrap-around sloped SUS304 No.4 cosmetic skirt, and angled splashback; "
            "ray-cast 5 interior points into the 380x280 mm (P=380, S=280) deep-drawn bowl; "
            "verify articulated wrist lever, gooseneck spout, soap plunger, and strainer with zero mesh errors."
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
    scene.name = "Maruzen HMHS-054 - SUS304 wall-mounted hand-wash sink"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    root = empty("hmhs_basin", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Maruzen Co., Ltd."
    root["model"] = "HMHS-054"
    root["japanese_title"] = "マルゼン ステンレス製手洗い器 壁掛け式 HMHS-054"
    root["material_spec"] = "SUS304 HL t1.2 top / SUS304 No.4 t1.0 skirt"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["catalog_subdimensions_mm"] = {"P": 380, "Y": 440, "S": 280}
    root["wall_mount_z0_elevation_m"] = 0.400
    root["manufacturer_unit_mass_kg"] = 8.500

    mat = surfaces()
    build_sink_basin_and_drain(root, mat)
    lever, spout, plunger, strainer = build_faucet_and_soap_dispenser(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, lever, spout, plunger, strainer])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, sharp_angle_deg=52.0)

    bounds = compute_world_bounds(root)
    for actual, expected in zip(bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (bounds, (WIDTH, DEPTH, HEIGHT))

    glb_path = ASSETS / f"{NAME}.glb"
    export_rest_glb(root, glb_path)

    animate_timeline(lever, spout, plunger, strainer)
    for marker_name, fno in (
        ("Rest standby", 1),
        ("Soap dose press", 20),
        ("Hand-wash water flow & strainer check", 60),
        ("Restored", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=fno)

    appliance_col = bpy.data.collections.new("HMHS-054 appliance")
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
        "model": "HMHS-054",
        "japanese_name": "マルゼン ステンレス製手洗い器 壁掛け式 HMHS-054",
        "blender_version": bpy.app.version_string,
        "material_grade": "SUS304 HL t1.2 / SUS304 No.4 t1.0",
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_bounds_m": bounds,
        "internal_bowl_m": [BOWL_W, BOWL_D, 0.185],
        "catalog_mounting_plumbing_mm": {"P": 380, "Y": 440, "S": 280, "drain": "25A"},
        "wall_installation_note": "Model Z=0 sits at bottom-rear corner of the sloped SUS304 cosmetic skirt and 25A trap base so unit spans Z in [0.000, 0.400] m; wall installation mounts Z=0 at 0.400 m above floor (top edge 0.800 m) or 0.545 m above floor (basin rim 0.800 m).",
        "unit_mass_kg": 8.500,
        "retained_bodies": [
            "hmhs_basin",
            "hmhs_faucet_lever",
            "hmhs_spout_swivel",
            "hmhs_soap_plunger",
            "hmhs_drain_strainer",
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
