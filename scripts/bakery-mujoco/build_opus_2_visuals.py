"""Build the Fellow Opus 2 Conical Burr Grinder Black visual prototype.

Metres, Z up, front -Y. Published envelope: 130 x 206 x 267 mm (W x D x H),
mass 2.3 kg, 48 mm 6-star conical burrs (400 RPM), stepless side worm-gear
grind adjustment knob driving an upper 1-10 graduated scale ring, 100 g bean
hopper with anti-popcorning dome and dosing lid, front multi-press timer push
button, and magnetic 54/58 mm portafilter-compatible catch cup.
Component wall thicknesses, internal burr flutes, and travel limits are
photo- and specification-derived estimates.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import mesh_object
from build_oven_visuals import (
    area_light,
    box,
    cylinder,
    empty,
    look_at,
    material,
    tube,
)
from inspect_induction import bounds

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/fellow-opus-2"
REFERENCES = REPOSITORY / "docs/equipment/fellow-opus-2/images"

WIDTH, DEPTH, HEIGHT = 0.1300, 0.2060, 0.2670
BARREL_X = -0.0110
BARREL_Y = -0.0360
BARREL_R = 0.0540

CUP_ORIGIN = (BARREL_X, BARREL_Y, 0.0200)
KNOB_ORIGIN = (0.0430, BARREL_Y, 0.1720)
SCALE_RING_ORIGIN = (BARREL_X, BARREL_Y, 0.2185)
HOPPER_ORIGIN = (BARREL_X, BARREL_Y, 0.2280)
LID_ORIGIN = (BARREL_X, BARREL_Y, 0.2610)
BURR_CARRIER_ORIGIN = (BARREL_X, BARREL_Y, 0.1680)
BURR_CONE_ORIGIN = (BARREL_X, BARREL_Y, 0.1620)
POWER_BTN_ORIGIN = (0.0380, -0.1018, 0.0110)


def palette():
    surfaces = {
        "matte_black": material(
            "Opus 2 matte black ABS-PC body",
            (0.010, 0.011, 0.013, 1.0),
            0.05,
            0.42,
        ),
        "gloss_black": material(
            "Opus 2 gloss black column wrap",
            (0.004, 0.005, 0.006, 1.0),
            0.10,
            0.08,
        ),
        "dark_trim": material(
            "Opus 2 dark satin trim",
            (0.022, 0.024, 0.027, 1.0),
            0.15,
            0.32,
        ),
        "carrier_polymer": material(
            "Opus 2 dark grey burr carrier polymer",
            (0.12, 0.13, 0.15, 1.0),
            0.08,
            0.38,
        ),
        "burr_steel": material(
            "Opus 2 48mm 6-star hardened burr steel",
            (0.62, 0.64, 0.67, 1.0),
            0.90,
            0.24,
        ),
        "silver_badge": material(
            "Opus 2 brushed silver badge and markings",
            (0.86, 0.87, 0.89, 1.0),
            0.25,
            0.26,
        ),
        "red_index": material(
            "Opus 2 front red grind index marker",
            (0.82, 0.12, 0.10, 1.0),
            0.05,
            0.30,
        ),
        "rubber": material(
            "Opus 2 silicone anti-slip foot",
            (0.012, 0.013, 0.015, 1.0),
            0.0,
            0.58,
        ),
    }
    return surfaces


def expand_profile_with_support_loops(profile, guard=0.0002, max_span=0.0080):
    """Insert co-linear support loops on straight walls (>4 mm) so smooth normals stay pure."""
    if len(profile) < 2:
        return list(profile)
    expanded = [profile[0]]
    for idx in range(len(profile) - 1):
        r0, z0 = profile[idx]
        r1, z1 = profile[idx + 1]
        dr = r1 - r0
        dz = z1 - z0
        dist = math.hypot(dr, dz)
        if dist > 0.0040:
            t_start = guard / dist
            t_end = 1.0 - (guard / dist)
            expanded.append((r0 + dr * t_start, z0 + dz * t_start))
            inner_dist = dist - 2.0 * guard
            steps = max(1, int(math.ceil(inner_dist / max_span)))
            for s in range(1, steps):
                t = t_start + (t_end - t_start) * (s / steps)
                expanded.append((r0 + dr * t, z0 + dz * t))
            expanded.append((r0 + dr * t_end, z0 + dz * t_end))
        expanded.append((r1, z1))
    return expanded


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
        if len(f.verts) < 3 or f.calc_area() <= 1e-12:
            to_delete.append(f)
            continue
        pts = [tuple(round(v.co[i], 6) for i in range(3)) for v in f.verts]
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
    if recalc_normals:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = not (sharp_z and abs(poly.normal.z) > 0.98)
    return obj


def clean_lathe(name, profile, center, surface, parent, segments=96, sharp_z=True):
    refined = expand_profile_with_support_loops(profile)
    vertices = []
    for radius, z in refined:
        for index in range(segments):
            angle = index * math.tau / segments
            vertices.append(
                (
                    center[0] + radius * math.cos(angle),
                    center[1] + radius * math.sin(angle),
                    center[2] + z,
                )
            )
    faces = []
    for ring in range(len(refined) - 1):
        for index in range(segments):
            following = (index + 1) % segments
            faces.append(
                (
                    ring * segments + index,
                    ring * segments + following,
                    (ring + 1) * segments + following,
                    (ring + 1) * segments + index,
                )
            )
    obj = mesh_object(name, vertices, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=sharp_z, recalc_normals=False)


def rounded_rect_points(x_min, x_max, y_min, y_max, radius, arc_steps=10):
    """Closed 2D rounded rectangle contour in XY (counterclockwise)."""
    pts = []
    corners = [
        (x_max - radius, y_max - radius, 0.0, math.pi / 2),
        (x_min + radius, y_max - radius, math.pi / 2, math.pi),
        (x_min + radius, y_min + radius, math.pi, 1.5 * math.pi),
        (x_max - radius, y_min + radius, 1.5 * math.pi, math.tau),
    ]
    for cx, cy, a0, a1 in corners:
        for i in range(arc_steps):
            a = a0 + (a1 - a0) * (i / arc_steps)
            pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return pts


def extrude_closed_contour(name, contour_rings, surface, parent, sharp_z=True):
    """Build a closed manifold mesh from a sequence of (contour_pts, z) rings."""
    n = len(contour_rings[0][0])
    vertices = []
    for pts, z in contour_rings:
        for x, y in pts:
            vertices.append((x, y, z))
    cx = sum(p[0] for p in contour_rings[0][0]) / n
    cy = sum(p[1] for p in contour_rings[0][0]) / n
    bot_center = len(vertices)
    vertices.append((cx, cy, contour_rings[0][1]))
    top_center = len(vertices)
    vertices.append((cx, cy, contour_rings[-1][1]))

    faces = []
    for r_idx in range(len(contour_rings) - 1):
        a = r_idx * n
        b = (r_idx + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    for i in range(n):
        j = (i + 1) % n
        faces.append((j, i, bot_center))
    last = (len(contour_rings) - 1) * n
    for i in range(n):
        j = (i + 1) % n
        faces.append((last + i, last + j, top_center))

    obj = mesh_object(name, vertices, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=sharp_z, recalc_normals=True)


def build_base_and_column(root, mat):
    """Build the 130 x 206 x 18 mm rectangular base plate, four silicone feet, and rear column."""
    # 1. Rectangular base plate: X in [-0.0650, +0.0650], Y in [-0.1030, +0.1030], Z in [0.0020, 0.0200]
    outer_pts = rounded_rect_points(-0.0650, 0.0650, -0.1030, 0.1030, 0.0018, arc_steps=8)
    bevel_pts = rounded_rect_points(-0.0644, 0.0644, -0.1024, 0.1024, 0.0016, arc_steps=8)
    base_rings = [
        (bevel_pts, 0.0020),
        (outer_pts, 0.0026),
        (outer_pts, 0.0029),
        (outer_pts, 0.0110),
        (outer_pts, 0.0191),
        (outer_pts, 0.0194),
        (bevel_pts, 0.0200),
    ]
    extrude_closed_contour("Matte black base plate", base_rings, mat["matte_black"], root, sharp_z=True)

    # Underside rating label plate & cord wrap oval boss (japan-11.jpg)
    label_pts = rounded_rect_points(-0.0320, 0.0320, -0.0550, 0.0550, 0.0180, arc_steps=10)
    extrude_closed_contour(
        "Underside rating plate",
        [(label_pts, 0.0015), (label_pts, 0.0021)],
        mat["dark_trim"],
        root,
        sharp_z=True,
    )

    # Four circular silicone feet touching Z = 0.0000 m exactly
    for label_name, fx, fy in (
        ("opus_foot_fl", -0.0460, -0.0820),
        ("opus_foot_fr", 0.0460, -0.0820),
        ("opus_foot_rl", -0.0460, 0.0820),
        ("opus_foot_rr", 0.0460, 0.0820),
    ):
        foot = empty(label_name, (fx, fy, 0.0), root)
        pad = cylinder(
            f"Silicone foot pad {label_name}",
            (0.0, 0.0, 0.0010),
            0.0095,
            0.0020,
            mat["rubber"],
            foot,
        )
        clean_mesh_object(pad, sharp_z=True)

    # Magnetic catch-cup centering pad on the front base deck (Z = 0.0198..0.0200 m)
    mag_pad = clean_lathe(
        "Magnetic catch-cup pad",
        [
            (0.0, 0.0196),
            (0.0385, 0.0196),
            (0.0385, 0.0199),
            (0.0210, 0.0199),
            (0.0210, 0.0200),
            (0.0, 0.0200),
        ],
        (BARREL_X, BARREL_Y, 0.0),
        mat["dark_trim"],
        root,
        segments=72,
    )
    clean_mesh_object(mag_pad, sharp_z=True)
    empty("opus_cup_seat", CUP_ORIGIN, root)

    # 2. Rear vertical motor/gear column (Y in [0.0195, 0.0920], X in [-0.0530, +0.0310], Z in [0.0200, 0.2460])
    col_outer = rounded_rect_points(-0.0525, 0.0305, 0.0195, 0.0915, 0.0120, arc_steps=10)
    col_bevel = rounded_rect_points(-0.0518, 0.0298, 0.0202, 0.0908, 0.0115, arc_steps=10)
    col_rings = [
        (col_bevel, 0.0198),
        (col_outer, 0.0205),
        (col_outer, 0.0210),
        (col_outer, 0.1300),
        (col_outer, 0.2448),
        (col_outer, 0.2453),
        (col_bevel, 0.2460),
    ]
    extrude_closed_contour("Rear vertical motor column", col_rings, mat["matte_black"], root, sharp_z=True)

    # Glossy rounded side wrap panels around the rear column (japan-01.jpg, japan-02.jpg, japan-03.jpg)
    wrap_outer = rounded_rect_points(-0.0532, 0.0312, 0.0210, 0.0922, 0.0125, arc_steps=10)
    wrap_bevel = rounded_rect_points(-0.0526, 0.0306, 0.0215, 0.0916, 0.0120, arc_steps=10)
    wrap_rings = [
        (wrap_bevel, 0.0210),
        (wrap_outer, 0.0218),
        (wrap_outer, 0.0222),
        (wrap_outer, 0.1300),
        (wrap_outer, 0.2438),
        (wrap_outer, 0.2442),
        (wrap_bevel, 0.2448),
    ]
    extrude_closed_contour("Glossy column side wrap", wrap_rings, mat["gloss_black"], root, sharp_z=True)

    # Lower structural bridge connecting rear column to outer rear barrel wall (Z in [0.1220, 0.2150])
    neck_pts = rounded_rect_points(-0.0340, 0.0120, 0.0145, 0.0240, 0.0030, arc_steps=6)
    extrude_closed_contour(
        "Barrel support neck",
        [(neck_pts, 0.1220), (neck_pts, 0.1230), (neck_pts, 0.2140), (neck_pts, 0.2150)],
        mat["matte_black"],
        root,
        sharp_z=True,
    )

    # Rear silver FELLOW badge on upper rear column (japan-02.jpg, japan-03.jpg)
    badge = box(
        "Rear FELLOW badge",
        (BARREL_X, 0.0924, 0.1880),
        (0.0260, 0.0012, 0.0095),
        mat["silver_badge"],
        root,
        bevel=0.0010,
    )
    clean_mesh_object(badge, sharp_z=False)


def build_grind_barrel(root, mat):
    """Build the suspended Ø108 mm cylindrical grind barrel with rounded lower bowl taper."""
    # Profile from chute outlet (Z = 0.1040, R = 0.0140) curving out to R = 0.0540 at Z = 0.1240,
    # up to Z = 0.2180, then hollow interior cavity down to chute exit.
    barrel_profile = [(0.0140, 0.1040), (0.0280, 0.1040)]
    bowl_steps = 24
    for s in range(1, bowl_steps + 1):
        theta = (math.pi / 2) * (s / bowl_steps)
        r_val = 0.0280 + (BARREL_R - 0.0280) * math.sin(theta)
        z_val = 0.1040 + 0.0200 * (1.0 - math.cos(theta))
        barrel_profile.append((r_val, z_val))
    barrel_profile.extend(
        [
            (BARREL_R, 0.2174),
            (0.0534, 0.2180),
            (0.0468, 0.2180),
            (0.0465, 0.2174),
            (0.0465, 0.1940),
            (0.0335, 0.1900),
            (0.0335, 0.1650),
            (0.0245, 0.1520),
            (0.0140, 0.1280),
            (0.0140, 0.1040),
        ]
    )
    clean_lathe(
        "Suspended cylindrical grind barrel",
        barrel_profile,
        (BARREL_X, BARREL_Y, 0.0),
        mat["matte_black"],
        root,
        segments=96,
    )

    # Stationary cylindrical boss on +X side of barrel where worm-gear knob mounts
    boss = cylinder(
        "Knob barrel boss",
        (0.0398, BARREL_Y, 0.1720),
        0.0205,
        0.0060,
        mat["dark_trim"],
        root,
        axis="X",
    )
    bpy.context.view_layer.objects.active = boss
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(boss, sharp_z=False)

    # Vertical red index line on front (-Y) of grind barrel (japan-main.jpg, japan-04.jpg)
    red_line = box(
        "Front red grind index line",
        (BARREL_X, BARREL_Y - BARREL_R - 0.0003, 0.2120),
        (0.0012, 0.0006, 0.0095),
        mat["red_index"],
        root,
        bevel=0.0001,
    )
    clean_mesh_object(red_line, sharp_z=False)

    # Anti-static ionizer emitter pins at chute exit (Z = 0.1055 m)
    for sign in (-1.0, 1.0):
        pin = cylinder(
            f"Anti-static ionizer pin {sign:+.0f}",
            (BARREL_X + sign * 0.0125, BARREL_Y - 0.0060, 0.1055),
            0.0009,
            0.0030,
            mat["burr_steel"],
            root,
        )
        clean_mesh_object(pin, sharp_z=False)

    empty("opus_chute_outlet", (BARREL_X, BARREL_Y, 0.1040), root)


def build_controls_and_rings(root, mat):
    """Build the side knurled grind knob, upper 1-10 scale ring, and front base timer button."""
    # 1. Side-mounted knurled worm-gear grind adjustment knob (opus_grind_knob)
    # Origin at (0.0430, -0.0360, 0.1720); body spans X_local in [0.0005, 0.0220] -> X_world in [0.0435, 0.0650]
    knob = empty("opus_grind_knob", KNOB_ORIGIN, root)
    knob["source_part"] = "Stepless side worm-gear grind adjustment knob"
    knob_profile = expand_profile_with_support_loops(
        [
            (0.0, 0.0005),
            (0.0210, 0.0005),
            (0.0216, 0.0012),
            (0.0216, 0.0212),
            (0.0208, 0.0220),
            (0.0, 0.0220),
        ]
    )
    segments = 96
    k_verts = []
    for radius, x_local in knob_profile:
        for idx in range(segments):
            ang = idx * math.tau / segments
            r_mod = radius
            if 0.0015 <= x_local <= 0.0208 and radius > 0.0210:
                # 72 axial knurl flutes baked directly into the revolved knob cylinder
                r_mod = radius + 0.00035 * math.cos(72 * ang)
            k_verts.append((x_local, r_mod * math.cos(ang), r_mod * math.sin(ang)))
    k_faces = []
    for ring in range(len(knob_profile) - 1):
        for idx in range(segments):
            nxt = (idx + 1) % segments
            k_faces.append(
                (
                    ring * segments + idx,
                    ring * segments + nxt,
                    (ring + 1) * segments + nxt,
                    (ring + 1) * segments + idx,
                )
            )
    knob_mesh = mesh_object(
        "Side knurled grind knob", k_verts, k_faces, mat["matte_black"], knob
    )
    clean_mesh_object(knob_mesh, sharp_z=False)

    # 2. Upper graduated scale ring (opus_scale_ring) around barrel at Z = 0.2185..0.2275 m
    scale_ring = empty("opus_scale_ring", SCALE_RING_ORIGIN, root)
    scale_ring["source_part"] = "Upper 1-10 graduated grind scale ring"
    ring_profile = [
        (0.0468, 0.0000),
        (0.0532, 0.0000),
        (0.0536, 0.0005),
        (0.0536, 0.0085),
        (0.0532, 0.0090),
        (0.0468, 0.0090),
        (0.0465, 0.0085),
        (0.0465, 0.0005),
        (0.0468, 0.0000),
    ]
    clean_lathe(
        "Upper graduated scale ring",
        ring_profile,
        (0.0, 0.0, 0.0),
        mat["matte_black"],
        scale_ring,
        segments=96,
    )

    # Graduated scale ticks (41 ticks across front/right arc, 10 major marks 1..10 + 3-dot coarse marker)
    # Ticks protrude to R = 0.05395 m (proud of R = 0.0536 m scale band, strictly inside R <= 0.0540 m)
    for step in range(41):
        ang = -math.pi / 2 + (step - 16) * (math.radians(3.2))
        is_major = step % 4 == 0
        tick_h = 0.0040 if is_major else 0.0022
        tick_w = 0.00085 if is_major else 0.00048
        r_mid = 0.05370
        tick = box(
            f"Scale ring tick {step}",
            (r_mid * math.cos(ang), r_mid * math.sin(ang), 0.0008 + 0.5 * tick_h),
            (0.0005, tick_w, tick_h),
            mat["silver_badge"],
            scale_ring,
            bevel=0.00008,
        )
        tick.rotation_euler.z = ang
        clean_mesh_object(tick, sharp_z=False)

    # 3. Front-right base push button (opus_power_button) at (0.0380, -0.1018, 0.0110)
    # Outer face sits flush with Y = -0.1030 m (-0.1018 - 0.0012 = -0.1030 m)
    power_btn = empty("opus_power_button", POWER_BTN_ORIGIN, root)
    power_btn["source_part"] = "Front multi-press timer push button (30/60/90/120 s)"
    btn_mesh = cylinder(
        "Front timer push button",
        (0.0, -0.0004, 0.0),
        0.0056,
        0.0016,
        mat["dark_trim"],
        power_btn,
        axis="Y",
    )
    bpy.context.view_layer.objects.active = btn_mesh
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(btn_mesh, sharp_z=False)

    return knob, scale_ring, power_btn


def build_burrs(root, mat):
    """Build the removable 48 mm outer ring burr carrier with wire bail handle and 6-star conical burr."""
    # 1. Removable 48 mm outer ring burr carrier (opus_burr_carrier, japan-07.jpg)
    carrier = empty("opus_burr_carrier", BURR_CARRIER_ORIGIN, root)
    carrier["source_part"] = "Removable 48 mm outer ring burr carrier with wire bail handle"
    carrier_profile = [
        (0.0238, 0.0000),
        (0.0290, 0.0000),
        (0.0290, 0.0160),
        (0.0310, 0.0170),
        (0.0310, 0.0215),
        (0.0252, 0.0215),
        (0.0238, 0.0160),
        (0.0238, 0.0000),
    ]
    clean_lathe(
        "Outer 48mm burr carrier",
        carrier_profile,
        (0.0, 0.0, 0.0),
        mat["carrier_polymer"],
        carrier,
        segments=72,
    )
    # 16 internal ring burr cutting flutes
    for idx in range(16):
        ang = idx * math.tau / 16
        tooth = box(
            f"Outer burr flute {idx + 1}",
            (0.0235 * math.cos(ang), 0.0235 * math.sin(ang), 0.0078),
            (0.0012, 0.0022, 0.0125),
            mat["burr_steel"],
            carrier,
            bevel=0.0002,
        )
        tooth.rotation_euler = (0.16, 0.0, ang)
        clean_mesh_object(tooth, sharp_z=False)

    # Folding semicircular stainless-steel wire bail handle on top of carrier (japan-07.jpg)
    bail_pts = []
    for i in range(19):
        a = math.pi * (i / 18)
        bail_pts.append(
            (
                0.0245 * math.cos(a),
                0.0060 * math.sin(a),
                0.0205 + 0.0140 * math.sin(a),
            )
        )
    bail = tube("Burr carrier wire bail", bail_pts, 0.0010, mat["burr_steel"], carrier, smooth=True)
    bpy.context.view_layer.objects.active = bail
    bpy.ops.object.convert(target="MESH")
    clean_mesh_object(bail, sharp_z=False)

    # 2. Driven 48 mm 6-star hardened stainless-steel conical burr (opus_burr_cone, japan-07.jpg)
    cone = empty("opus_burr_cone", BURR_CONE_ORIGIN, root)
    cone["source_part"] = "48 mm 6-star hardened stainless-steel conical burr"
    cone_profile = [
        (0.0045, -0.0120),
        (0.0075, -0.0120),
        (0.0075, 0.0000),
        (0.0205, 0.0000),
        (0.0190, 0.0055),
        (0.0132, 0.0165),
        (0.0085, 0.0185),
        (0.0052, 0.0225),
        (0.0000, 0.0225),
    ]
    clean_lathe(
        "Inner 48mm 6-star conical burr",
        cone_profile,
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        cone,
        segments=72,
    )
    # 6 star pre-breaker flutes (signature Opus 2 6-star burr geometry)
    for idx in range(6):
        ang = idx * math.tau / 6
        fin = box(
            f"Conical 6-star burr flute {idx + 1}",
            (0.0155 * math.cos(ang), 0.0155 * math.sin(ang), 0.0088),
            (0.0020, 0.0016, 0.0145),
            mat["burr_steel"],
            cone,
            bevel=0.0002,
        )
        fin.rotation_euler = (-0.26, -0.20, ang)
        clean_mesh_object(fin, sharp_z=False)

    return carrier, cone


def build_hopper_and_lid(root, mat):
    """Build the removable 100 g bean hopper (with anti-popcorning dome) and top dosing lid."""
    # 1. Removable bean hopper (opus_hopper, Z_world = 0.2280..0.2605 m)
    hopper = empty("opus_hopper", HOPPER_ORIGIN, root)
    hopper["source_part"] = "Removable 100 g bean hopper with central anti-popcorning dome"
    hopper_profile = [
        (0.0445, 0.0000),
        (0.0534, 0.0000),
        (BARREL_R, 0.0005),
        (BARREL_R, 0.0320),
        (0.0534, 0.0325),
        (0.0488, 0.0325),
        (0.0485, 0.0320),
        (0.0485, 0.0220),
        (0.0435, 0.0040),
        (0.0445, 0.0000),
    ]
    clean_lathe(
        "Removable bean hopper",
        hopper_profile,
        (0.0, 0.0, 0.0),
        mat["matte_black"],
        hopper,
        segments=96,
    )

    # Central anti-popcorning dome with Fellow "O" bow-tie relief inside hopper (japan-05.jpg)
    dome_profile = [(0.0, 0.0040), (0.0185, 0.0040), (0.0215, 0.0080)]
    dome_steps = 24
    for s in range(1, dome_steps + 1):
        theta = (math.pi / 2) * (s / dome_steps)
        dome_profile.append(
            (0.0215 * math.cos(theta), 0.0080 + 0.0125 * math.sin(theta))
        )
    clean_lathe(
        "Anti-popcorning center dome",
        dome_profile,
        (0.0, 0.0, 0.0),
        mat["matte_black"],
        hopper,
        segments=72,
        sharp_z=False,
    )
    # Fellow "O" ring relief on top of dome
    clean_lathe(
        "Dome Fellow emblem ring",
        [
            (0.0032, 0.0202),
            (0.0048, 0.0202),
            (0.0048, 0.0208),
            (0.0032, 0.0208),
            (0.0032, 0.0202),
        ],
        (0.0, 0.0, 0.0),
        mat["dark_trim"],
        hopper,
        segments=48,
    )
    for idx in range(3):
        ang = idx * math.tau / 3
        strut = box(
            f"Hopper dome support strut {idx + 1}",
            (0.0320 * math.cos(ang), 0.0320 * math.sin(ang), 0.0070),
            (0.0220, 0.0030, 0.0040),
            mat["matte_black"],
            hopper,
            bevel=0.0004,
        )
        strut.rotation_euler.z = ang
        clean_mesh_object(strut, sharp_z=False)

    # 2. Removable top hopper lid with underside grind guide & dosing divider (opus_hopper_lid, Z_top = 0.2670 m)
    lid = empty("opus_hopper_lid", LID_ORIGIN, root)
    lid["source_part"] = "Removable hopper lid with underside grind guide (0-10)"
    lid_profile = [
        (0.0, 0.0012),
        (0.0455, 0.0012),
        (0.0455, -0.0030),
        (0.0472, -0.0030),
        (0.0472, 0.0008),
        (0.0534, 0.0008),
        (BARREL_R, 0.0013),
        (BARREL_R, 0.0055),
        (0.0534, 0.0060),
        (0.0, 0.0060),
    ]
    clean_lathe(
        "Removable hopper lid",
        lid_profile,
        (0.0, 0.0, 0.0),
        mat["matte_black"],
        lid,
        segments=96,
    )
    # Underside dosing divider rib (japan-12.jpg)
    divider = box(
        "Lid underside dosing divider",
        (0.0, 0.0, -0.0008),
        (0.0880, 0.0024, 0.0032),
        mat["dark_trim"],
        lid,
        bevel=0.0003,
    )
    clean_mesh_object(divider, sharp_z=False)

    return hopper, lid


def build_catch_cup(root, mat):
    """Build the magnetic grounds catch cup with 54/58 mm portafilter step (Z_world = 0.0200..0.1010 m)."""
    cup = empty("opus_catch_cup", CUP_ORIGIN, root)
    cup["source_part"] = "Magnetic grounds catch cup with 54/58 mm portafilter dosing collar"
    # Leave 0.2 mm clearance above Z=0.0200 landing pad at Z_local = 0.0002 m so BVH never overlaps pad
    cup_profile = [
        (0.0, 0.0020),
        (0.0372, 0.0020),
        (0.0380, 0.0028),
        (0.0380, 0.0740),
        (0.0374, 0.0746),
        (0.0292, 0.0746),
        (0.0290, 0.0785),
        (0.0272, 0.0785),
        (0.0270, 0.0805),
        (0.0265, 0.0810),
        (0.0250, 0.0810),
        (0.0246, 0.0804),
        (0.0246, 0.0730),
        (0.0345, 0.0680),
        (0.0345, 0.0065),
        (0.0320, 0.0055),
        (0.0, 0.0055),
    ]
    clean_lathe(
        "Magnetic grounds catch cup",
        cup_profile,
        (0.0, 0.0, 0.0),
        mat["matte_black"],
        cup,
        segments=96,
    )
    clean_lathe(
        "Catch cup magnetic base disc",
        [
            (0.0, 0.0002),
            (0.0365, 0.0002),
            (0.0370, 0.0020),
            (0.0, 0.0020),
        ],
        (0.0, 0.0, 0.0),
        mat["dark_trim"],
        cup,
        segments=72,
    )
    empty("opus_cup_contents", (0.0, 0.0, 0.0350), cup)
    return cup


def build_power_lead(root, mat):
    """Build illustrative stowed power cord and Japanese plug exiting rear base slot (excluded from envelope)."""
    lead = empty("opus_power_lead", (0.0, 0.0, 0.0), root)
    relief = cylinder(
        "Rear cord strain relief",
        (0.0, 0.1040, 0.0070),
        0.0042,
        0.0090,
        mat["dark_trim"],
        lead,
        axis="Y",
    )
    clean_mesh_object(relief, sharp_z=False)
    points = [
        (0.0, 0.106, 0.007),
        (0.024, 0.128, 0.005),
        (0.068, 0.132, 0.004),
        (0.106, 0.095, 0.004),
        (0.114, 0.040, 0.004),
        (0.098, -0.012, 0.006),
    ]
    cable = tube("Stowed power cable", points, 0.0028, mat["dark_trim"], lead, smooth=True)
    bpy.context.view_layer.objects.active = cable
    bpy.ops.object.convert(target="MESH")
    clean_mesh_object(cable, sharp_z=False)

    plug = empty("opus_ac_plug", (0.098, -0.028, 0.010), lead)
    plug_body = box(
        "Plug moulding",
        (0.0, 0.0, 0.0),
        (0.024, 0.030, 0.016),
        mat["dark_trim"],
        plug,
        bevel=0.003,
    )
    clean_mesh_object(plug_body, sharp_z=False)
    for x in (-0.0060, 0.0060):
        pin = box(
            f"Plug flat pin {x:+.3f}",
            (x, -0.022, 0.002),
            (0.0014, 0.015, 0.0055),
            mat["burr_steel"],
            plug,
            bevel=0.0002,
        )
        clean_mesh_object(pin, sharp_z=False)
    gnd = cylinder(
        "Plug ground pin",
        (0.0, -0.022, -0.0035),
        0.0020,
        0.017,
        mat["burr_steel"],
        plug,
        axis="Y",
    )
    clean_mesh_object(gnd, sharp_z=False)
    lead["status"] = "Illustrative stowed power cord; excluded from body envelope check."
    return lead


def export_glb(root, filename):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def organize(root):
    appliance = bpy.data.collections.new("Fellow Opus 2 appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        appliance.objects.link(obj)

    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for index, name in enumerate(
        (
            "japan-main.jpg",
            "japan-01.jpg",
            "japan-03.jpg",
            "japan-05.jpg",
            "japan-07.jpg",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.35
        obj.location = (index * 0.45, 0.8, 0.2)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_render = True
    refs.hide_viewport = True


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    scene.world = bpy.data.worlds.new("Opus 2 neutral studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.72,
        0.74,
        0.77,
        1.0,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.28
    before = set(scene.objects)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(
        material("Opus 2 studio floor", (0.58, 0.60, 0.63, 1.0), roughness=0.85)
    )
    area_light("Key softbox", (0.58, -0.52, 0.65), (0.0, -0.02, 0.14), 55, 0.55)
    area_light("Fill strip", (-0.60, -0.25, 0.52), (0.0, -0.02, 0.14), 35, 0.45)
    area_light("Rim softbox", (-0.15, 0.68, 0.68), (0.0, 0.0, 0.16), 55, 0.50)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(collection)
    for obj in set(scene.objects) - before:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    return camera


def render(camera, name, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)
    bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
    bpy.ops.render.render(write_still=True)


def render_views(camera, lid, hopper, carrier, cup):
    render(camera, "studio-main", (0.52, -0.62, 0.38), (0.0, -0.01, 0.134), 0.36)
    render(camera, "studio-front", (0.0, -1.5, 0.134), (0.0, 0.0, 0.134), 0.34)
    render(camera, "studio-right", (1.5, 0.0, 0.134), (0.0, 0.0, 0.134), 0.34)
    # Remove lid briefly to show anti-popcorning dome inside hopper (as in japan-05.jpg)
    lid.location = (0.160, -0.040, 0.005)
    render(
        camera,
        "studio-hopper",
        (0.12, -0.22, 0.68),
        (BARREL_X, BARREL_Y, 0.242),
        0.18,
    )
    # Tool-less disassembly view (japan-07.jpg, japan-12.jpg, japan-14.jpg)
    hopper.location = (-0.150, -0.085, 0.000)
    lid.location = (-0.150, 0.045, 0.004)
    carrier.location = (0.095, -0.115, 0.000)
    cup.location = (-0.025, -0.175, 0.000)
    render(
        camera,
        "studio-disassembled",
        (0.48, -0.78, 0.52),
        (-0.01, -0.03, 0.115),
        0.48,
    )
    lid.location = LID_ORIGIN
    hopper.location = HOPPER_ORIGIN
    carrier.location = BURR_CARRIER_ORIGIN
    cup.location = CUP_ORIGIN


def animate(lid, hopper, scale_ring, knob, carrier, cone, cup, power_btn):
    scene = bpy.context.scene
    # Frames 1-110: lift lid, twist & lift hopper, lift 48 mm burr carrier, present catch cup, reassemble
    for frame, l_lift, h_lift, c_lift, cup_y, cup_z in (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0),
        (20, 0.075, 0.0, 0.0, 0.0, 0.0),
        (40, 0.120, 0.090, 0.0, 0.0, 0.0),
        (55, 0.120, 0.090, 0.070, -0.095, 0.005),
        (75, 0.120, 0.090, 0.0, 0.0, 0.0),
        (95, 0.075, 0.0, 0.0, 0.0, 0.0),
        (110, 0.0, 0.0, 0.0, 0.0, 0.0),
    ):
        lid.location.z = LID_ORIGIN[2] + l_lift
        hopper.location.z = HOPPER_ORIGIN[2] + h_lift
        carrier.location.z = BURR_CARRIER_ORIGIN[2] + c_lift
        cup.location.y = CUP_ORIGIN[1] + cup_y
        cup.location.z = CUP_ORIGIN[2] + cup_z
        lid.keyframe_insert(data_path="location", frame=frame)
        hopper.keyframe_insert(data_path="location", frame=frame)
        carrier.keyframe_insert(data_path="location", frame=frame)
        cup.keyframe_insert(data_path="location", frame=frame)

    # Frames 115-180: rotate side worm-gear knob & scale ring, press front timer button, spin 48 mm conical burr
    for frame, knob_deg, scale_deg, btn_dy, cone_deg in (
        (1, 0.0, 0.0, 0.0, 0.0),
        (115, 0.0, 0.0, 0.0, 0.0),
        (130, 180.0, -24.0, 0.0, 0.0),
        (136, 180.0, -24.0, 0.0012, 0.0),
        (142, 180.0, -24.0, 0.0, 45.0),
        (180, 180.0, -24.0, 0.0, 360.0),
    ):
        knob.rotation_euler.x = math.radians(knob_deg)
        scale_ring.rotation_euler.z = math.radians(scale_deg)
        power_btn.location.y = POWER_BTN_ORIGIN[1] + btn_dy
        cone.rotation_euler.z = math.radians(cone_deg)
        knob.keyframe_insert(data_path="rotation_euler", frame=frame)
        scale_ring.keyframe_insert(data_path="rotation_euler", frame=frame)
        power_btn.keyframe_insert(data_path="location", frame=frame)
        cone.keyframe_insert(data_path="rotation_euler", frame=frame)

    scene.frame_start = 1
    scene.frame_end = 180
    scene.render.fps = 24
    scene.frame_set(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Fellow Opus 2 Black - visual prototype"
    scene.unit_settings.system = "METRIC"

    root = empty("opus_grinder", (0.0, 0.0, 0.0))
    root["model"] = (
        "Fellow Opus 2 Conical Burr Grinder Black (fs-og2 / OP02AANA, 48 mm 6-star, JP 100 V 300 W)"
    )
    root["dimensions_status"] = "Published 130 x 206 x 267 mm (W x D x H); 2.3 kg"
    root["physics_status"] = (
        "Articulated visual and native MuJoCo mechanical prototype"
    )

    mat = palette()
    build_base_and_column(root, mat)
    build_grind_barrel(root, mat)
    knob, scale_ring, power_btn = build_controls_and_rings(root, mat)
    carrier, cone = build_burrs(root, mat)
    hopper, lid = build_hopper_and_lid(root, mat)
    cup = build_catch_cup(root, mat)
    lead = build_power_lead(root, mat)

    export_glb(root, "fellow-opus-2.glb")

    # Standalone magnetic catch cup export
    cup.parent = None
    cup.location = (0.0, 0.0, 0.0)
    export_glb(cup, "fellow-opus-2-cup.glb")
    cup.parent = root
    cup.location = CUP_ORIGIN

    # Standalone 48 mm outer burr carrier export
    carrier.parent = None
    carrier.location = (0.0, 0.0, 0.0)
    export_glb(carrier, "fellow-opus-2-burr-carrier.glb")
    carrier.parent = root
    carrier.location = BURR_CARRIER_ORIGIN

    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    report = {
        "status": "Uncalibrated visual and mechanical prototype",
        "published_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(val, 6) for val in (high - low)],
        "published_mass_kg": 2.3,
        "burr_set": "48 mm 6-star hardened stainless-steel conical burr (400 RPM)",
        "sources": [
            "BRANDING COFFEE Japan product page (0141coffee.jp/?pid=193720631)",
            "Inter-Christine Japan product page (inter-christine.com/coffee/fs-og2)",
            "Kurasu Kyoto (authorized Fellow Japan distributor) technical breakdown",
            "Fellow Gear Guides and 17 studio reference photographs",
        ],
        "assumptions": [
            "Component diameters, barrel/column offsets, and catch-cup portafilter step derived from orthographic photographs",
            "Internal 6-star conical burr flutes, outer carrier bail handle, and worm-gear ratio are visual reconstructions",
            "Lid lift (120 mm), hopper lift (90 mm), carrier lift (70 mm), and button press (1.2 mm) are preview travels",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "fellow-opus-2.glb").read_bytes()
        ).hexdigest(),
        "cup_glb_sha256": hashlib.sha256(
            (ASSETS / "fellow-opus-2-cup.glb").read_bytes()
        ).hexdigest(),
        "burr_carrier_glb_sha256": hashlib.sha256(
            (ASSETS / "fellow-opus-2-burr-carrier.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")

    organize(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, lid, hopper, carrier, cup)
    animate(lid, hopper, scale_ring, knob, carrier, cone, cup, power_btn)
    camera.location = (0.52, -0.62, 0.38)
    camera.data.ortho_scale = 0.36
    look_at(camera, (0.0, -0.01, 0.134))

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
                area.spaces.active.shading.type = "MATERIAL"
                area.spaces.active.overlay.show_overlays = False
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "fellow-opus-2.blend"))
    print("Saved Fellow Opus 2 visual prototype", ASSETS)


if __name__ == "__main__":
    main()
