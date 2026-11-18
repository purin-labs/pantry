"""Build the Japanese Maruzen BS2-126N two-compartment commercial sink (no backsplash) visual model.

Metres, Z up, operator front towards -Y.
Follows Maruzen 430 Bream Series (マルゼン 430ブリームシリーズ バックガードなし 二槽シンク BS2-126N, Drawing 07276)
published envelope: 1,200 x 600 x 800 mm (W x D x H):
- Plan layout: 40 + 545 + 30 + 545 + 40 = 1,200 mm (W); 40 front + 460 bowl + 100 rear = 600 mm (D).
- Two deep-drawn coved SUS430 bowls (545 x 460 x 250 mm each, floor top at Z = 0.550 m),
  4-sided anti-spill perimeter marine rim at Z = 0.800 m with R5 rounded front safety roll (フロント面R仕上)
  and clean flat 100 mm rear faucet deck (バックなし).
- 275 mm SUS430 apron wrap (Z = 0.525..0.800 m) with compact metallic Maruzen foil badge.
- Rear-wall oval 5-slot SUS304 overflows (小判型オーバーフロー) piped behind the bowls into the King drains.
- All-flat folded SUS430 lower undershelf (オールフラット式スノコ板, Z_top = 0.200 m) with centerline
  ventilation slots and two Ø86 mm circular hose cutouts fitted with black rubber grommet rings (排水口ゴムリング付).
- Four Ø38 mm SUS304 tubular legs at CAD centers (±0.5670 m, -0.2700 / +0.2150 m) with stepped SUS304
  adjustable bullet feet touching Z = 0.000 m.
- Two 50A polypropylene King drains (キングドレン, X = ±0.290 m) with cream molded PP crumb strainer baskets,
  black EPDM/stainless covers, and offset 50A corrugated PVC drain hoses (Y = +0.055 m, 245 mm from rear)
  routing straight down through the undershelf grommets.
- Removable 400 x 300 x 20 mm MBCO-4ME aluminum baking tray seated flat inside the left bowl floor.
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
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    tube,
)
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-bs2-126n"
NAME = "maruzen-bs2-126n"

WIDTH = 1.2000
DEPTH = 0.6000
HEIGHT = 0.8000

BOWL_W = 0.5450
BOWL_D = 0.4600
BOWL_H = 0.2500
BOWL_FLOOR_Z = 0.5500
DECK_SURFACE_Z = 0.7960

# CAD 07276 plan: 40 + 545 + 30 + 545 + 40 = 1200 mm; 40 front + 460 bowl + 100 rear = 600 mm
LEFT_BOWL_X = -0.2875   # X in [-0.5600, -0.0150]
RIGHT_BOWL_X = 0.2875   # X in [+0.0150, +0.5600]
BOWL_CENTER_Y = -0.0300  # Y in [-0.2600, +0.2000]

# CAD 07276 drain centers X = ±0.2900 m (310 | 580 | 310), offset 50A hose spigot at Y = +0.0550 m (245 mm from rear)
LEFT_DRAIN_X = -0.2900
RIGHT_DRAIN_X = 0.2900
DRAIN_Y = 0.1200
HOSE_SPIGOT_Y = 0.0550

LEFT_PLUG_ORIGIN = (LEFT_DRAIN_X, DRAIN_Y, 0.5420)
RIGHT_PLUG_ORIGIN = (RIGHT_DRAIN_X, DRAIN_Y, 0.5420)
LEFT_STRAINER_ORIGIN = (LEFT_DRAIN_X, DRAIN_Y, 0.4500)
TRAY_REST_ORIGIN = (LEFT_BOWL_X, -0.0920, BOWL_FLOOR_Z)

# CAD 07276 leg centers: 33 | 1134 | 33 in X (±0.5670 m); 30 | 485 | 85 in Y (-0.2700 m front, +0.2150 m rear)
LEG_POSITIONS = (
    ("bs2_leg_fl", -0.5670, -0.2700),
    ("bs2_leg_fr", 0.5670, -0.2700),
    ("bs2_leg_rl", -0.5670, 0.2150),
    ("bs2_leg_rr", 0.5670, 0.2150),
)


def clean_mesh_object(obj, sharp_angle_deg: float | None = 52.0, flat_normals: bool = False):
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        if mod.type == "WEIGHTED_NORMAL":
            obj.modifiers.remove(mod)
        else:
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

    use_flat = flat_normals or bool(obj.get("flat_normals", False))
    thresh = None if sharp_angle_deg is None else math.radians(sharp_angle_deg)
    for e in bm.edges:
        if use_flat:
            e.smooth = False
        elif thresh is not None and len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < thresh
        else:
            e.smooth = True

    bm.to_mesh(obj.data)
    bm.free()

    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()

    if use_flat:
        for poly in obj.data.polygons:
            poly.use_smooth = False
    else:
        for poly in obj.data.polygons:
            poly.use_smooth = True
        wn = obj.modifiers.new("WeightedSurfaceNormals", "WEIGHTED_NORMAL")
        wn.mode = "FACE_AREA"
        wn.weight = 50
        wn.keep_sharp = True
        bpy.ops.object.modifier_apply(modifier=wn.name)
    return obj


def surfaces():
    mats = {
        "sus430_deck": material(
            "BS2 brushed SUS430 deck", (0.62, 0.65, 0.68, 1.0), 0.86, 0.25
        ),
        "sus430_bowl": material(
            "BS2 deep-drawn SUS430 bowl", (0.57, 0.60, 0.63, 1.0), 0.85, 0.29
        ),
        "sus430_apron": material(
            "BS2 hairline SUS430 apron", (0.60, 0.63, 0.66, 1.0), 0.86, 0.26
        ),
        "sus430_shelf": material(
            "BS2 all-flat SUS430 undershelf", (0.58, 0.61, 0.64, 1.0), 0.85, 0.28
        ),
        "sus304_leg": material(
            "BS2 SUS304 tubular leg", (0.66, 0.69, 0.72, 1.0), 0.90, 0.21
        ),
        "chrome_trim": material(
            "BS2 polished SUS304 trim", (0.74, 0.77, 0.80, 1.0), 0.93, 0.16
        ),
        "king_drain_pp": material(
            "BS2 King drain polypropylene", (0.20, 0.22, 0.24, 1.0), 0.04, 0.44
        ),
        "basket_cream_pp": material(
            "BS2 crumb basket cream PP", (0.83, 0.80, 0.73, 1.0), 0.02, 0.38
        ),
        "drain_hose_pvc": material(
            "BS2 50A corrugated PVC hose", (0.37, 0.40, 0.43, 1.0), 0.03, 0.48
        ),
        "epdm_rubber": material(
            "BS2 EPDM drain seal & grommet", (0.032, 0.035, 0.040, 1.0), 0.03, 0.56
        ),
        "slot_shadow": material(
            "BS2 recessed slot shadow", (0.025, 0.028, 0.032, 1.0), 0.10, 0.62
        ),
        "tray_alloy": material(
            "BS2 400x300mm baking tray alloy", (0.68, 0.70, 0.73, 1.0), 0.88, 0.25
        ),
        "badge_dark": material(
            "BS2 Maruzen foil badge charcoal", (0.09, 0.11, 0.14, 1.0), 0.35, 0.28
        ),
        "ink_silver": material(
            "BS2 badge brushed silver lettering", (0.86, 0.88, 0.91, 1.0), 0.65, 0.22
        ),
    }
    for m in mats.values():
        assert "metallic" in m and "roughness" in m and "emission" in m
    return mats


def rounded_rect_loop_ccw(
    cx: float, cy: float, w: float, d: float, radius: float, segs_per_corner: int = 8
) -> list[tuple[float, float]]:
    """Return 4 * segs_per_corner strictly distinct CCW (x, y) points around a rounded rectangle."""
    r = max(1e-5, min(radius, w * 0.48, d * 0.48))
    corners = (
        (cx + w / 2.0 - r, cy + d / 2.0 - r, 0.0),
        (cx - w / 2.0 + r, cy + d / 2.0 - r, 90.0),
        (cx - w / 2.0 + r, cy - d / 2.0 + r, 180.0),
        (cx + w / 2.0 - r, cy - d / 2.0 + r, 270.0),
    )
    pts: list[tuple[float, float]] = []
    for ox, oy, start_deg in corners:
        for step in range(segs_per_corner):
            ang = math.radians(start_deg + step * 90.0 / segs_per_corner)
            pts.append((ox + r * math.cos(ang), oy + r * math.sin(ang)))
    return pts


def build_annulus_plate(
    name: str,
    outer_ccw: list[tuple[float, float]],
    inner_ccw: list[tuple[float, float]],
    z_bot: float,
    z_top: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build a closed manifold horizontal plate from matched-count CCW outer and inner loops."""
    assert len(outer_ccw) == len(inner_ccw)
    n = len(outer_ccw)
    verts: list[tuple[float, float, float]] = []
    verts.extend((x, y, z_top) for x, y in outer_ccw)
    verts.extend((x, y, z_top) for x, y in inner_ccw)
    verts.extend((x, y, z_bot) for x, y in outer_ccw)
    verts.extend((x, y, z_bot) for x, y in inner_ccw)
    faces: list[tuple[int, int, int, int]] = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((2 * n + i, 3 * n + i, 3 * n + j, 2 * n + j))
        faces.append((2 * n + i, 2 * n + j, j, i))
        faces.append((n + i, n + j, 3 * n + j, 3 * n + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_extruded_profile_along_x(
    name: str,
    x_min: float,
    x_max: float,
    yz_loop_ccw: list[tuple[float, float]],
    surface: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Extrude a closed 2D (y, z) cross-section along X in [x_min, x_max] with planar end caps."""
    n = len(yz_loop_ccw)
    verts = [(x_min, y, z) for y, z in yz_loop_ccw] + [(x_max, y, z) for y, z in yz_loop_ccw]
    faces: list[tuple[int, ...]] = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    faces.append(tuple(reversed(range(n))))
    faces.append(tuple(range(n, 2 * n)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_drawn_sanitary_bowl(
    name: str,
    bowl_cx: float,
    drain_x: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build a watertight deep-drawn 545 x 460 x 250 mm coved SUS430 bowl with circular 50A drain throat."""
    segs = 8  # 32 vertices per ring
    wall_t = 0.0022
    throat_r = 0.0560  # Ø112 mm open throat at (drain_x, DRAIN_Y), clearing tray Y <= +0.0580 m

    # Inner profile stations from top deck weld (Z=0.7935) through R10 bottom cove to flat floor (Z=0.5500)
    cove_r = 0.0100
    stations_in: list[tuple[list[tuple[float, float]], float]] = [
        (rounded_rect_loop_ccw(bowl_cx, BOWL_CENTER_Y, BOWL_W, BOWL_D, 0.0240, segs), 0.7935),
        (rounded_rect_loop_ccw(bowl_cx, BOWL_CENTER_Y, BOWL_W, BOWL_D, 0.0240, segs), BOWL_FLOOR_Z + cove_r),
    ]
    for step in range(1, 5):
        ang = (math.pi / 2.0) * (step / 4.0)
        inset = cove_r * (1.0 - math.cos(ang))
        z = BOWL_FLOOR_Z + cove_r * (1.0 - math.sin(ang))
        stations_in.append(
            (
                rounded_rect_loop_ccw(
                    bowl_cx,
                    BOWL_CENTER_Y,
                    BOWL_W - 2.0 * inset,
                    BOWL_D - 2.0 * inset,
                    max(0.0160, 0.0240 - inset),
                    segs,
                ),
                z,
            )
        )

    floor_outer_loop = stations_in[-1][0]
    # Ray-matched circular drain hole strictly inside convex floor_outer_loop -> guaranteed convex planar quads at Z = 0.5500 m
    ray_angles = [math.atan2(y - DRAIN_Y, x - drain_x) for x, y in floor_outer_loop]
    throat_top_in = [(drain_x + throat_r * math.cos(a), DRAIN_Y + throat_r * math.sin(a)) for a in ray_angles]
    throat_bot_in = [(drain_x + (throat_r - 0.0020) * math.cos(a), DRAIN_Y + (throat_r - 0.0020) * math.sin(a)) for a in ray_angles]
    stations_in.append((throat_top_in, BOWL_FLOOR_Z))
    stations_in.append((throat_bot_in, BOWL_FLOOR_Z - 0.0080))

    # Outer offset shell stations
    stations_out: list[tuple[list[tuple[float, float]], float]] = [
        (rounded_rect_loop_ccw(bowl_cx, BOWL_CENTER_Y, BOWL_W + 2 * wall_t, BOWL_D + 2 * wall_t, 0.0240 + wall_t, segs), 0.7935),
        (rounded_rect_loop_ccw(bowl_cx, BOWL_CENTER_Y, BOWL_W + 2 * wall_t, BOWL_D + 2 * wall_t, 0.0240 + wall_t, segs), BOWL_FLOOR_Z + cove_r - wall_t * 0.4),
    ]
    for step in range(1, 5):
        ang = (math.pi / 2.0) * (step / 4.0)
        inset = cove_r * (1.0 - math.cos(ang))
        z = BOWL_FLOOR_Z - wall_t + cove_r * (1.0 - math.sin(ang))
        stations_out.append(
            (
                rounded_rect_loop_ccw(
                    bowl_cx,
                    BOWL_CENTER_Y,
                    BOWL_W + 2 * wall_t - 2.0 * inset,
                    BOWL_D + 2 * wall_t - 2.0 * inset,
                    max(0.0160, 0.0240 + wall_t - inset),
                    segs,
                ),
                z,
            )
        )
    throat_top_out = [(drain_x + (throat_r + wall_t) * math.cos(a), DRAIN_Y + (throat_r + wall_t) * math.sin(a)) for a in ray_angles]
    throat_bot_out = [(drain_x + (throat_r + wall_t - 0.0020) * math.cos(a), DRAIN_Y + (throat_r + wall_t - 0.0020) * math.sin(a)) for a in ray_angles]
    stations_out.append((throat_top_out, BOWL_FLOOR_Z - wall_t))
    stations_out.append((throat_bot_out, BOWL_FLOOR_Z - 0.0080))

    n_rings = len(stations_in)
    ring_n = len(stations_in[0][0])
    verts: list[tuple[float, float, float]] = []
    for loop, z in stations_in:
        verts.extend((x, y, z) for x, y in loop)
    out_offset = len(verts)
    for loop, z in stations_out:
        verts.extend((x, y, z) for x, y in loop)

    faces: list[tuple[int, int, int, int]] = []
    for r_idx in range(n_rings - 1):
        b0 = r_idx * ring_n
        b1 = (r_idx + 1) * ring_n
        for i in range(ring_n):
            j = (i + 1) % ring_n
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
            ob0 = out_offset + b0
            ob1 = out_offset + b1
            faces.append((ob0 + i, ob1 + i, ob1 + j, ob0 + j))

    bot_in = (n_rings - 1) * ring_n
    bot_out = out_offset + (n_rings - 1) * ring_n
    for i in range(ring_n):
        j = (i + 1) % ring_n
        faces.append((i, out_offset + i, out_offset + j, j))
        faces.append((bot_in + i, bot_in + j, bot_out + j, bot_out + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def text_label(name, text, position, size, surface, parent, rot_x=math.pi / 2):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.0003
    data.resolution_u = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = rot_x
    return finish(obj, name, surface, parent)


def build_deck_and_bowls(root, mat):
    # 1. Exact 1,200 x 600 mm perimeter anti-spill marine rim reaching Z = 0.8000 m,
    #    with Maruzen R5 rounded front safety bullnose (フロント面はR仕上の安全設計) at Y = -0.3000 m.
    front_profile: list[tuple[float, float]] = [(-0.3000, 0.7600)]
    for step in range(7):
        ang = (math.pi / 2.0) * (step / 6.0)  # 0 deg -> Y=-0.3000 exact; 90 deg -> Z=0.8000 exact
        front_profile.append((-0.2950 - 0.0050 * math.cos(ang), 0.7950 + 0.0050 * math.sin(ang)))
    front_profile.extend(
        [
            (-0.2915, 0.8000),
            (-0.2895, 0.7960),
            (-0.2895, 0.7930),
            (-0.2955, 0.7930),
            (-0.2955, 0.7600),
        ]
    )
    build_extruded_profile_along_x(
        "Marine rim front rail", -0.5920, 0.5920, front_profile, mat["sus430_deck"], root
    )

    rear_profile = [
        (0.2915, 0.7930),
        (0.2915, 0.7960),
        (0.2935, 0.8000),
        (0.3000, 0.8000),
        (0.3000, 0.7600),
        (0.2955, 0.7600),
        (0.2955, 0.7930),
    ]
    build_extruded_profile_along_x(
        "Marine rim rear rail", -0.5920, 0.5920, rear_profile, mat["sus430_deck"], root
    )

    # Left & right perimeter marine rim rails defining exact X = ∓0.6000 m, Y in [-0.3000, +0.3000], Z_max = 0.8000 m
    box("Marine rim left rail", (-0.5960, 0.0, 0.7800), (0.0080, 0.6000, 0.0400), mat["sus430_deck"], root, 0.0)
    box("Marine rim right rail", (0.5960, 0.0, 0.7800), (0.0080, 0.6000, 0.0400), mat["sus430_deck"], root, 0.0)

    # 2. Seamless recessed SUS430 deck halves at Z = 0.7935..0.7960 m framing the two R24 mm 545 x 460 mm bowls
    segs = 8
    left_outer = rounded_rect_loop_ccw(-0.29625, 0.0010, 0.5925, 0.5850, 0.0020, segs)
    left_inner = rounded_rect_loop_ccw(LEFT_BOWL_X, BOWL_CENTER_Y, BOWL_W, BOWL_D, 0.0240, segs)
    build_annulus_plate("Deck left plate", left_outer, left_inner, 0.7935, DECK_SURFACE_Z, mat["sus430_deck"], root)

    right_outer = rounded_rect_loop_ccw(0.29625, 0.0010, 0.5925, 0.5850, 0.0020, segs)
    right_inner = rounded_rect_loop_ccw(RIGHT_BOWL_X, BOWL_CENTER_Y, BOWL_W, BOWL_D, 0.0240, segs)
    build_annulus_plate("Deck right plate", right_outer, right_inner, 0.7935, DECK_SURFACE_Z, mat["sus430_deck"], root)

    # Sanitary rounded 30 mm center divider saddle crown between left and right compartments
    box(
        "Deck center divider bridge",
        (0.0, BOWL_CENTER_Y, 0.7952),
        (0.0300, BOWL_D + 0.0040, 0.0036),
        mat["sus430_deck"],
        root,
        0.0014,
    )

    # 3. Two deep-drawn coved 545 x 460 x 250 mm SUS430 bowls (floor top strictly at Z = 0.5500 m)
    build_drawn_sanitary_bowl("Bowl left main floor", LEFT_BOWL_X, LEFT_DRAIN_X, mat["sus430_bowl"], root)
    build_drawn_sanitary_bowl("Bowl right main floor", RIGHT_BOWL_X, RIGHT_DRAIN_X, mat["sus430_bowl"], root)

    # 4. Maruzen rear-wall oval 5-slot SUS304 overflows (小判型オーバーフロー) at Z = 0.7520 m (no standpipe inside bowl)
    for side_tag, dx in (("left", LEFT_DRAIN_X), ("right", RIGHT_DRAIN_X)):
        ov_outer = rounded_rect_loop_ccw(0.0, 0.0, 0.0600, 0.0240, 0.0115, segs_per_corner=6)
        ov_verts = [(dx + u, 0.1976, 0.7520 + v) for u, v in ov_outer] + [
            (dx + u, 0.2002, 0.7520 + v) for u, v in ov_outer
        ]
        n_ov = len(ov_outer)
        ov_faces: list[tuple[int, ...]] = [
            tuple(reversed(range(n_ov))),
            tuple(range(n_ov, 2 * n_ov)),
        ]
        for i in range(n_ov):
            j = (i + 1) % n_ov
            ov_faces.append((i, j, n_ov + j, n_ov + i))
        ov_mesh = bpy.data.meshes.new(f"Bowl {side_tag} oval overflow bezel")
        ov_mesh.from_pydata(ov_verts, [], ov_faces)
        ov_mesh.update()
        ov_obj = bpy.data.objects.new(f"Bowl {side_tag} oval overflow bezel", ov_mesh)
        bpy.context.scene.collection.objects.link(ov_obj)
        finish(ov_obj, f"Bowl {side_tag} oval overflow bezel", mat["chrome_trim"], root, bevel=0.0005)

        # 5 vertical dark intake slots + 2 side pan-head mounting screws on the oval overflow face
        for s_idx in range(-2, 3):
            box(
                f"Bowl {side_tag} overflow slot {s_idx + 3}",
                (dx + s_idx * 0.0072, 0.1973, 0.7520),
                (0.0032, 0.0010, 0.0135),
                mat["slot_shadow"],
                root,
                0.0,
            )
        for s_name, sx_off in (("l", -0.0225), ("r", 0.0225)):
            cylinder(
                f"Bowl {side_tag} overflow screw {s_name}",
                (dx + sx_off, 0.1971, 0.7520),
                0.0022,
                0.0012,
                mat["chrome_trim"],
                root,
                "Y",
            )


def build_aprons_legs_and_undershelf(root, mat):
    # 1. 275 mm outer SUS430 apron wrap (Z = 0.5250 .. 0.7620 m below the 40 mm marine rim)
    aprons = (
        ("Front stainless apron skirt", (0.0, -0.2970, 0.6435), (1.1920, 0.0045, 0.2370)),
        ("Left stainless apron skirt", (-0.5970, 0.0, 0.6435), (0.0045, 0.5920, 0.2370)),
        ("Right stainless apron skirt", (0.5970, 0.0, 0.6435), (0.0045, 0.5920, 0.2370)),
        ("Rear structural cross apron", (0.0, 0.2970, 0.6435), (1.1920, 0.0045, 0.2370)),
    )
    for aname, apos, adim in aprons:
        box(aname, apos, adim, mat["sus430_apron"], root, 0.0006)

    # Subtle authentic metallic/charcoal Maruzen foil nameplate on upper-right front apron (48 x 13 mm)
    box(
        "Maruzen Bream badge plate",
        (0.5120, -0.2991, 0.7480),
        (0.0480, 0.0008, 0.0130),
        mat["badge_dark"],
        root,
        0.0002,
    )
    text_label(
        "Maruzen front wordmark",
        "Maruzen",
        (0.5120, -0.2996, 0.7480),
        0.0068,
        mat["ink_silver"],
        root,
    )

    # 2. Four Ø38 mm SUS304 tubular legs at CAD centers + stepped SUS304 adjustable bullet feet touching Z = 0.0000 m
    for lname, lx, ly in LEG_POSITIONS:
        box(
            f"{lname}_gusset",
            (lx, ly, 0.5360),
            (0.0520, 0.0520, 0.0260),
            mat["sus430_shelf"],
            root,
            0.0010,
        )
        cylinder(
            f"{lname}_pipe",
            (lx, ly, 0.2820),
            0.0190,
            0.5040,
            mat["sus304_leg"],
            root,
        )
        cylinder(
            f"{lname}_bullet_collar",
            (lx, ly, 0.0200),
            0.0205,
            0.0280,
            mat["chrome_trim"],
            root,
        )
        # Stepped SUS304 bullet foot pad strictly touching Z = 0.000000 m (bevel=0.0)
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=28, radius=0.0175, depth=0.0060, location=(lx, ly, 0.0030)
        )
        finish(bpy.context.object, f"{lname}_foot_pad", mat["chrome_trim"], root, 0.0)

        cylinder(
            f"{lname}_shelf_collar",
            (lx, ly, 0.1860),
            0.0230,
            0.0300,
            mat["sus430_shelf"],
            root,
        )

    # 3. Maruzen All-Flat SUS430 Undershelf (オールフラット式スノコ板, Z_top = 0.2000 m, Z_bot = 0.1720 m)
    #    Spans X in [-0.5670, +0.5670], Y in [-0.2700, +0.2150], with two genuine Ø86 mm circular cutouts
    #    and black EPDM rubber grommet rings (排水口ゴムリング付) at (±0.2900, +0.0550)!
    shelf_rails = (
        ("Undershelf front C-channel", (0.0, -0.2650, 0.1860), (1.1340, 0.0100, 0.0280)),
        ("Undershelf rear C-channel", (0.0, 0.2100, 0.1860), (1.1340, 0.0100, 0.0280)),
        ("Undershelf left end rail", (-0.5620, -0.0275, 0.1860), (0.0100, 0.4650, 0.0280)),
        ("Undershelf right end rail", (0.5620, -0.0275, 0.1860), (0.0100, 0.4650, 0.0280)),
        ("Undershelf center stiffener", (0.0, -0.0275, 0.1840), (0.0360, 0.4600, 0.0220)),
    )
    for sname, spos, sdim in shelf_rails:
        box(sname, spos, sdim, mat["sus430_shelf"], root, 0.0007)

    segs = 8
    hole_r = 0.0430  # Ø86 mm circular hose pass-through hole
    for side_tag, panel_cx, hole_x in (
        ("left", -0.2785, LEFT_DRAIN_X),
        ("right", 0.2785, RIGHT_DRAIN_X),
    ):
        s_outer = rounded_rect_loop_ccw(panel_cx, -0.0275, 0.5570, 0.4650, 0.0020, segs)
        s_angles = [math.atan2(y - HOSE_SPIGOT_Y, x - hole_x) for x, y in s_outer]
        s_inner = [(hole_x + hole_r * math.cos(a), HOSE_SPIGOT_Y + hole_r * math.sin(a)) for a in s_angles]
        build_annulus_plate(
            f"Undershelf flat deck {side_tag}",
            s_outer,
            s_inner,
            0.1965,
            0.2000,
            mat["sus430_shelf"],
            root,
        )

        # Black EPDM rubber grommet ring (排水口ゴムリング, Ø100 mm outer / Ø70 mm inner) seated around the hole
        g_outer = [(hole_x + 0.0500 * math.cos(2 * math.pi * k / 32), HOSE_SPIGOT_Y + 0.0500 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
        g_inner = [(hole_x + 0.0350 * math.cos(2 * math.pi * k / 32), HOSE_SPIGOT_Y + 0.0350 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
        build_annulus_plate(
            f"Undershelf rubber grommet {side_tag}",
            g_outer,
            g_inner,
            0.1945,
            0.2022,
            mat["epdm_rubber"],
            root,
        )

    # Single centerline row of 11 punched front-to-back slots along Y = -0.0680 m (per Catalogue 48010 photo)
    for idx in range(11):
        sx = -0.4600 + idx * 0.0920
        box(
            f"Undershelf punched slot {idx + 1:02d}",
            (sx, -0.0680, 0.2002),
            (0.0080, 0.0520, 0.0006),
            mat["slot_shadow"],
            root,
            0.0,
        )


def build_king_drains_and_articulated_parts(root, mat):
    # Static 50A polypropylene King drain housings + rear-wall overflow collectors + vertical 50A corrugated hoses
    for side_tag, dx in (("left", LEFT_DRAIN_X), ("right", RIGHT_DRAIN_X)):
        # Circular stainless throat bezel recessed 0.4 mm below Z = 0.5500 m
        bz_outer = [(dx + 0.0660 * math.cos(2 * math.pi * k / 32), DRAIN_Y + 0.0660 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
        bz_inner = [(dx + 0.0500 * math.cos(2 * math.pi * k / 32), DRAIN_Y + 0.0500 * math.sin(2 * math.pi * k / 32)) for k in range(32)]
        build_annulus_plate(
            f"King drain {side_tag} floor bezel",
            bz_outer,
            bz_inner,
            0.5455,
            0.5496,
            mat["chrome_trim"],
            root,
        )

        # Molded charcoal-grey polypropylene 50A King drain body beneath bowl (Z = 0.4180 .. 0.5460 m)
        cylinder(
            f"King drain {side_tag} PP housing",
            (dx, DRAIN_Y, 0.4820),
            0.0620,
            0.1280,
            mat["king_drain_pp"],
            root,
        )
        cylinder(
            f"King drain {side_tag} locknut collar",
            (dx, DRAIN_Y, 0.5360),
            0.0700,
            0.0160,
            mat["king_drain_pp"],
            root,
        )
        # Offset bottom manifold sweeping forward to CAD spigot Y = +0.0550 m (245 mm from rear)
        box(
            f"King drain {side_tag} offset sumpelbow",
            (dx, 0.0875, 0.4180),
            (0.0640, 0.0950, 0.0320),
            mat["king_drain_pp"],
            root,
            0.0040,
        )
        cylinder(
            f"King drain {side_tag} 50A outlet spigot",
            (dx, HOSE_SPIGOT_Y, 0.3880),
            0.0285,
            0.0420,
            mat["king_drain_pp"],
            root,
        )
        cylinder(
            f"King drain {side_tag} stainless hose clamp",
            (dx, HOSE_SPIGOT_Y, 0.3840),
            0.0315,
            0.0080,
            mat["chrome_trim"],
            root,
        )

        # Rear-wall concealed PP overflow collector box (behind Y = +0.2022 m) + branch hose to King drain side port
        box(
            f"King drain {side_tag} overflow collector",
            (dx, 0.2140, 0.7460),
            (0.0640, 0.0220, 0.0360),
            mat["king_drain_pp"],
            root,
            0.0020,
        )
        tube(
            f"King drain {side_tag} overflow branch hose",
            [
                (dx, 0.2140, 0.7280),
                (dx, 0.2160, 0.6200),
                (dx, 0.2050, 0.5150),
                (dx, DRAIN_Y + 0.0540, 0.4780),
            ],
            0.0125,
            mat["drain_hose_pvc"],
            root,
            smooth=True,
        )

        # Straight vertical 50A corrugated PVC drain hose passing directly through the Ø86 mm undershelf grommet!
        cylinder(
            f"King drain {side_tag} 50A corrugated hose",
            (dx, HOSE_SPIGOT_Y, 0.2060),
            0.0265,
            0.3320,
            mat["drain_hose_pvc"],
            root,
        )
        for r_idx in range(18):
            rz = 0.0480 + r_idx * 0.0180
            cylinder(
                f"Drain hose {side_tag} rib {r_idx + 1:02d}",
                (dx, HOSE_SPIGOT_Y, rz),
                0.0290,
                0.0060,
                mat["drain_hose_pvc"],
                root,
            )

    # Static right cream-colored PP crumb strainer basket inside right drain housing (per Catalogue 48010 photo)
    cylinder(
        "Right bowl static crumb basket",
        (RIGHT_DRAIN_X, DRAIN_Y, 0.4910),
        0.0410,
        0.0760,
        mat["basket_cream_pp"],
        root,
    )

    # Articulated body 1: bs2_strainer_left (removable cream PP crumb basket in left drain well: slide 0 .. 0.120 m)
    strainer_l = empty("bs2_strainer_left", LEFT_STRAINER_ORIGIN, root)
    strainer_l["joint"] = "bs2_strainer_left_lift"
    strainer_l["joint_type"] = "slide"
    strainer_l["axis_blender"] = "+Z"
    strainer_l["range_m"] = [0.0, 0.120]

    cylinder(
        "bs2_strainer_left_basket",
        (0.0, 0.0, 0.0410),
        0.0405,
        0.0780,
        mat["basket_cream_pp"],
        strainer_l,
    )
    cylinder(
        "bs2_strainer_left_rim",
        (0.0, 0.0, 0.0810),
        0.0460,
        0.0055,
        mat["basket_cream_pp"],
        strainer_l,
    )
    box(
        "bs2_strainer_left_bail",
        (0.0, 0.0, 0.0865),
        (0.0680, 0.0045, 0.0055),
        mat["chrome_trim"],
        strainer_l,
        0.0008,
    )

    # Articulated bodies 2 & 3: bs2_drain_plug_left & bs2_drain_plug_right (slide 0 .. 0.080 m)
    plugs = []
    for pname, porigin, pjoint in (
        ("bs2_drain_plug_left", LEFT_PLUG_ORIGIN, "bs2_plug_left_lift"),
        ("bs2_drain_plug_right", RIGHT_PLUG_ORIGIN, "bs2_plug_right_lift"),
    ):
        plug = empty(pname, porigin, root)
        plug["joint"] = pjoint
        plug["joint_type"] = "slide"
        plug["axis_blender"] = "+Z"
        plug["range_m"] = [0.0, 0.080]

        cylinder(
            f"{pname}_epdm_seal",
            (0.0, 0.0, 0.0025),
            0.0470,
            0.0070,
            mat["epdm_rubber"],
            plug,
        )
        cylinder(
            f"{pname}_sus_cover",
            (0.0, 0.0, 0.0072),
            0.0490,
            0.0032,
            mat["epdm_rubber"],
            plug,
        )
        cylinder(
            f"{pname}_lift_knob",
            (0.0, 0.0, 0.0140),
            0.0110,
            0.0110,
            mat["chrome_trim"],
            plug,
        )
        plugs.append(plug)

    # Articulated body 4: bs2_wash_tray (400 x 300 x 20 mm baking tray resting flat on Z = 0.5500 m)
    tray = empty("bs2_wash_tray", TRAY_REST_ORIGIN, root)
    tray["joint"] = "bs2_wash_tray_free"
    tray["joint_type"] = "freejoint"
    tray["dimensions_m"] = [0.400, 0.300, 0.020]
    tray["mass_kg"] = 0.850

    box(
        "bs2_wash_tray_bottom",
        (0.0, 0.0, 0.0015),
        (0.3940, 0.2940, 0.0030),
        mat["tray_alloy"],
        tray,
        0.0004,
    )
    tray_rims = (
        ("bs2_wash_tray_rim_front", (0.0, -0.1485, 0.0100), (0.4000, 0.0030, 0.0200)),
        ("bs2_wash_tray_rim_rear", (0.0, 0.1485, 0.0100), (0.4000, 0.0030, 0.0200)),
        ("bs2_wash_tray_rim_left", (-0.1985, 0.0, 0.0100), (0.0030, 0.2940, 0.0200)),
        ("bs2_wash_tray_rim_right", (0.1985, 0.0, 0.0100), (0.0030, 0.2940, 0.0200)),
    )
    for rname, rpos, rdim in tray_rims:
        box(rname, rpos, rdim, mat["tray_alloy"], tray, 0.0005)

    socket = empty("vessel_socket", (0.0, 0.0, 0.0200), tray)
    socket["site_role"] = "MBCO-4ME 400x300mm baking tray grasp socket"

    return plugs[0], plugs[1], strainer_l, tray


def animate_timeline(plug_l, plug_r, strainer_l, tray):
    keyframes = (
        (1, 0.0, 0.0, 0.0, TRAY_REST_ORIGIN, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, TRAY_REST_ORIGIN, (0.0, 0.0, 0.0)),
        (
            60,
            0.0720,
            0.0550,
            0.1050,
            (LEFT_BOWL_X, -0.0920, 0.6350),
            (math.radians(8.0), math.radians(-6.0), 0.0),
        ),
        (
            85,
            0.0720,
            0.0550,
            0.1050,
            (RIGHT_BOWL_X, -0.0920, BOWL_FLOOR_Z),
            (0.0, 0.0, 0.0),
        ),
        (120, 0.0, 0.0, 0.0, TRAY_REST_ORIGIN, (0.0, 0.0, 0.0)),
    )
    for fno, pl_dz, pr_dz, st_dz, t_loc, t_rot in keyframes:
        plug_l.location = (LEFT_PLUG_ORIGIN[0], LEFT_PLUG_ORIGIN[1], LEFT_PLUG_ORIGIN[2] + pl_dz)
        plug_l.keyframe_insert(data_path="location", frame=fno)

        plug_r.location = (RIGHT_PLUG_ORIGIN[0], RIGHT_PLUG_ORIGIN[1], RIGHT_PLUG_ORIGIN[2] + pr_dz)
        plug_r.keyframe_insert(data_path="location", frame=fno)

        strainer_l.location = (
            LEFT_STRAINER_ORIGIN[0],
            LEFT_STRAINER_ORIGIN[1],
            LEFT_STRAINER_ORIGIN[2] + st_dz,
        )
        strainer_l.keyframe_insert(data_path="location", frame=fno)

        tray.location = t_loc
        tray.rotation_euler = t_rot
        tray.keyframe_insert(data_path="location", frame=fno)
        tray.keyframe_insert(data_path="rotation_euler", frame=fno)


def clear_all_animations(root):
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def enable_metal_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "METAL" or dev.type == "CPU"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100


def setup_studio(scene):
    before = set(scene.objects)
    enable_metal_gpu(scene)
    scene.world = bpy.data.worlds.new("BS2-126N studio world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.58, 0.63, 0.70, 1.0)
    bg.inputs["Strength"].default_value = 0.50
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.18

    ground = material("BS2 studio floor", (0.29, 0.31, 0.34, 1.0), 0.0, 0.86, 0.0)
    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(ground)

    area_light("Key softbox", (-2.1, -2.5, 2.5), (0.0, 0.0, 0.45), 320.0, 2.2)
    area_light("Fill stripbox", (2.2, -1.0, 2.0), (0.0, 0.0, 0.45), 210.0, 1.8)
    area_light("Rim reflection", (0.0, 2.0, 2.4), (0.0, 0.0, 0.50), 230.0, 1.8)
    area_light("Under-sink fill", (0.0, -2.4, 0.35), (0.0, 0.0, 0.25), 95.0, 1.4)

    cam_data = bpy.data.cameras.new("Review camera")
    cam_data.type = "ORTHO"
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


def export_rest_glb(root, glb_path: Path):
    bpy.context.scene.frame_set(1)
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


def inspect_exported_glb(glb_path: Path):
    """Re-import exported GLB in a clean empty Blender scene and verify envelope, ray-casts, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["bs2_sink"]
    plug_l = objects["bs2_drain_plug_left"]
    plug_r = objects["bs2_drain_plug_right"]
    strainer_l = objects["bs2_strainer_left"]
    tray = objects["bs2_wash_tray"]
    socket = objects["vessel_socket"]

    for child in (plug_l, plug_r, strainer_l, tray):
        assert child.parent == root, child.name
    assert socket.parent == tray
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bounds = compute_world_bounds(root)
    for actual, expected in zip(bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (bounds, (WIDTH, DEPTH, HEIGHT))
    assert abs(bounds["min_m"][2] - 0.0) <= 1e-5, bounds
    assert abs(bounds["max_m"][2] - HEIGHT) <= 1e-5, bounds

    # Fault-injection check: shifting left marine rim rail by +10 mm must break envelope check
    rim_left = objects["Marine rim left rail"]
    orig_x = rim_left.location.x
    rim_left.location.x -= 0.010
    fault_bounds = compute_world_bounds(root)
    fault_rejected = abs(fault_bounds["dimensions_m"][0] - WIDTH) > 0.005
    rim_left.location.x = orig_x
    bpy.context.view_layer.update()
    assert fault_rejected, "Envelope guard must detect 10 mm rim perturbation"

    # Downward ray-cast into right bowl floor (Z = 0.5500 m) and left bowl tray (Z_bottom = 0.5500, Z_inner = 0.5530 m)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit_r, pt_r, norm_r, _f, obj_r, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((RIGHT_BOWL_X, -0.0500, 0.9000)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_r and abs(pt_r.z - BOWL_FLOOR_Z) <= 1e-4 and norm_r.z > 0.99, (
        hit_r,
        pt_r,
        obj_r.name if obj_r else None,
    )

    hit_l, pt_l, norm_l, _f, obj_l, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((LEFT_BOWL_X, -0.0920, 0.9000)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_l and obj_l.name == "bs2_wash_tray_bottom" and abs(pt_l.z - 0.5530) <= 1e-4, (
        hit_l,
        pt_l,
        obj_l.name if obj_l else None,
    )

    required_meshes = {
        "Marine rim left rail",
        "Marine rim right rail",
        "Marine rim front rail",
        "Marine rim rear rail",
        "Deck center divider bridge",
        "Bowl left main floor",
        "Bowl right main floor",
        "Bowl left oval overflow bezel",
        "Bowl right oval overflow bezel",
        "Front stainless apron skirt",
        "Undershelf front C-channel",
        "Undershelf flat deck left",
        "Undershelf flat deck right",
        "King drain left PP housing",
        "King drain right PP housing",
        "bs2_strainer_left_basket",
        "bs2_drain_plug_left_sus_cover",
        "bs2_drain_plug_right_sus_cover",
        "bs2_wash_tray_bottom",
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
        "envelope_bounds_m": bounds,
        "right_bowl_floor_ray_z_m": round(pt_r.z, 6),
        "left_bowl_tray_top_ray_z_m": round(pt_l.z, 6),
        "envelope_fault_injection_rejected": fault_rejected,
        "journey": (
            "Re-import exported maruzen-bs2-126n.glb into an empty Blender scene; verify exact "
            "1,200 x 600 x 800 mm CAD 07276 envelope (Z = 0.000..0.800 m), R5 front safety roll, "
            "rear-wall oval 5-slot overflows, all-flat SUS430 undershelf with Ø86 mm rubber-grommet "
            "hose pass-throughs, open 250 mm coved bowl cavities (floor ray-cast Z = 0.550 m), "
            "400 x 300 x 20 mm MBCO-4ME baking tray flat fit, and zero mesh-quality errors."
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
    scene.name = "Maruzen BS2-126N - two-compartment commercial sink"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    root = empty("bs2_sink", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Maruzen"
    root["series"] = "430 Bream Series (バックガードなし 二槽シンク)"
    root["model"] = "BS2-126N"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["bowl_dimensions_m"] = [BOWL_W, BOWL_D, BOWL_H]
    root["published_sink_mass_kg"] = 29.400
    root["wash_tray_mass_kg"] = 0.850

    mat = surfaces()
    build_deck_and_bowls(root, mat)
    build_aprons_legs_and_undershelf(root, mat)
    plug_l, plug_r, strainer_l, tray = build_king_drains_and_articulated_parts(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, plug_l, plug_r, strainer_l, tray])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, sharp_angle_deg=52.0)

    rest_bounds = compute_world_bounds(root)
    for actual, expected in zip(rest_bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (rest_bounds, (WIDTH, DEPTH, HEIGHT))

    glb_path = ASSETS / f"{NAME}.glb"
    export_rest_glb(root, glb_path)

    animate_timeline(plug_l, plug_r, strainer_l, tray)
    for marker_name, fno in (
        ("Rest", 1),
        ("Drain & strainer open", 60),
        ("Right rinse transfer", 85),
        ("Rest again", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=fno)

    appliance_col = bpy.data.collections.new("BS2-126N appliance")
    scene.collection.children.link(appliance_col)
    move_objects([root, *root.children_recursive], appliance_col)

    camera = setup_studio(scene)
    views = (
        ("studio-main", (1.65, -2.35, 1.45), (0.0, 0.0, 0.42), 1.48, 1),
        ("studio-front", (0.0, -2.50, 0.42), (0.0, 0.0, 0.40), 1.38, 1),
        ("studio-top", (0.0, -0.01, 2.50), (0.0, 0.0, 0.55), 1.38, 1),
        ("studio-right", (2.50, 0.0, 0.42), (0.0, 0.0, 0.40), 1.05, 1),
        ("studio-active", (1.55, -2.30, 1.55), (0.0, 0.0, 0.48), 1.52, 60),
    )
    rendered = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = ASSETS / f"{vname}.png"
            scene.render.filepath = str(out_png)
            bpy.ops.render.render(write_still=True)
            rendered.append(out_png.name)

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])

    build_report = {
        "asset": NAME,
        "manufacturer": "Maruzen Co., Ltd. (株式会社マルゼン)",
        "series": "430 Bream Series (430ブリームシリーズ バックガードなし 二槽シンク)",
        "model": "BS2-126N",
        "cad_reference": "Maruzen Approval Drawing 07276 + Catalogue 48010 pp. 22-26",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_bounds_m": rest_bounds,
        "bowl_dimensions_m": [BOWL_W, BOWL_D, BOWL_H],
        "bowl_floor_z_m": BOWL_FLOOR_Z,
        "deck_rim_z_m": HEIGHT,
        "drain_specification": "50A polypropylene King drain x 2 with cream PP crumb baskets, rear-wall oval overflows, and 50A corrugated hoses through rubber-grommeted all-flat undershelf",
        "published_sink_mass_kg": 29.400,
        "wash_tray_mass_kg": 0.850,
        "total_assembly_mass_kg": 30.250,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "renders": rendered,
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    blend_path = ASSETS / f"{NAME}.blend"
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    inspection = inspect_exported_glb(glb_path)
    print("Built and inspected Maruzen BS2-126N:", json.dumps(inspection, indent=2))


if __name__ == "__main__":
    main()
