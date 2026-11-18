"""Build the MiiCoffee DF64 II (Gen 2, V2.6) Single Dose Coffee Grinder visual prototype.

Metres, Z up, front -Y. Published envelope: 130 x 225 x 300 mm (W x D x H),
mass 6.8 kg (15 lbs catalog / 7.2 kg manual N.W.), custom 64 mm stainless-steel
flat burrs (1,400 RPM, 250 W AC induction motor), stepless thread-mounted chrome
grind adjustment collar (0-90 scale: espresso / moka / filter), 30 g aluminum
throat with V2.6 convex anti-popcorn disc, 50-80 g black silicone accordion
bellows with turned walnut wood lid, angled front chute with plasma generator
(ionizer), silicone-sleeved two-prong holder fork with 58 mm 6063 black anodized
aluminum dosing cup, and lower-right brushed stainless-steel latching power
button.
Component wall thicknesses, internal flat-burr tooth profiles, and travel limits
are photo- and specification-derived estimates.
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
ASSETS = REPOSITORY / "assets/bakery-mujoco/miicoffee-df64-gen2"
REFERENCES = REPOSITORY / "docs/equipment/miicoffee-df64-gen2/images"

WIDTH, DEPTH, HEIGHT = 0.1300, 0.2250, 0.3000
HEAD_X = 0.0000
HEAD_Y = -0.0020
BASE_CYL_Y = 0.0240
CYL_R = 0.0545

DIAL_ORIGIN = (HEAD_X, HEAD_Y, 0.2005)
UPPER_BURR_ORIGIN = (HEAD_X, HEAD_Y, 0.1870)
LOWER_BURR_ORIGIN = (HEAD_X, HEAD_Y, 0.1780)
BELLOWS_ORIGIN = (HEAD_X, HEAD_Y, 0.2385)
LID_ORIGIN = (HEAD_X, HEAD_Y, 0.2880)
CUP_ORIGIN = (0.0000, -0.0770, 0.0440)
POWER_BTN_ORIGIN = (0.0530, 0.0160, 0.0480)


def palette():
    surfaces = {
        "matte_black": material(
            "DF64 II matte black powder-coated aluminum",
            (0.006, 0.006, 0.007, 1.0),
            0.06,
            0.38,
        ),
        "anodized_black": material(
            "DF64 II 6063 anodized black aluminum dosing cup",
            (0.010, 0.011, 0.013, 1.0),
            0.62,
            0.26,
        ),
        "chrome_ring": material(
            "DF64 II polished chrome stepless dial collar",
            (0.84, 0.86, 0.89, 1.0),
            0.96,
            0.12,
        ),
        "brushed_alu": material(
            "DF64 II machined aluminum carrier and throat",
            (0.74, 0.76, 0.79, 1.0),
            0.88,
            0.24,
        ),
        "burr_steel": material(
            "DF64 II 64mm hardened stainless flat burr steel",
            (0.64, 0.66, 0.70, 1.0),
            0.92,
            0.22,
        ),
        "walnut_wood": material(
            "DF64 II turned American walnut hopper lid",
            (0.085, 0.038, 0.016, 1.0),
            0.02,
            0.34,
        ),
        "silicone_bellows": material(
            "DF64 II matte black silicone accordion bellows",
            (0.007, 0.007, 0.009, 1.0),
            0.0,
            0.54,
        ),
        "dial_band": material(
            "DF64 II matte black dial scale ring",
            (0.008, 0.009, 0.011, 1.0),
            0.08,
            0.32,
        ),
        "scale_white": material(
            "DF64 II white 0-90 grind scale markings",
            (0.92, 0.93, 0.95, 1.0),
            0.10,
            0.24,
        ),
        "zero_red": material(
            "DF64 II zero-point warning accent",
            (0.82, 0.12, 0.10, 1.0),
            0.08,
            0.28,
        ),
        "brass_spring": material(
            "DF64 II upper carrier wave spring bronze",
            (0.72, 0.54, 0.24, 1.0),
            0.85,
            0.28,
        ),
        "rubber": material(
            "DF64 II anti-slip foot and cup rubber adapter",
            (0.008, 0.008, 0.010, 1.0),
            0.0,
            0.60,
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


def rounded_rect_points(x_min, x_max, y_min, y_max, radius, arc_steps=12):
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
        faces.append((bot_center, j, i))
        top_row = (len(contour_rings) - 1) * n
        faces.append((top_center, top_row + i, top_row + j))
    obj = mesh_object(name, vertices, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=sharp_z, recalc_normals=True)


def cyl_center_y(z):
    """Forward-tilted centerline Y(z) of the DF64 II main cylinder (~8.2 deg forward lean)."""
    z0, z1 = 0.0180, 0.1995
    t = max(0.0, min(1.0, (z - z0) / (z1 - z0)))
    return BASE_CYL_Y + (HEAD_Y - BASE_CYL_Y) * t


def build_base_and_tilted_body(root, mat):
    """Build 4 rubber feet, 130x225 mm contoured stadium base, and 8.2-deg forward-leaning cylinder."""
    # 1. Four anti-slip rubber feet touching Z = 0.0000
    foot_coords = (
        (-0.0380, -0.0780),
        (0.0380, -0.0780),
        (-0.0420, 0.0680),
        (0.0420, 0.0680),
    )
    for idx, (fx, fy) in enumerate(foot_coords, start=1):
        clean_lathe(
            f"df64_rubber_foot_{idx}",
            [
                (0.0000, 0.0000),
                (0.0125, 0.0000),
                (0.0135, 0.0010),
                (0.0135, 0.0045),
                (0.0000, 0.0045),
            ],
            (fx, fy, 0.0),
            mat["rubber"],
            root,
            segments=40,
        )

    # 2. Contoured cast-aluminum stadium base defining exact 130.0 x 225.0 mm footprint
    c_bot = rounded_rect_points(-0.0630, 0.0630, -0.1105, 0.1105, 0.0520, arc_steps=14)
    c_Full = rounded_rect_points(-0.0650, 0.0650, -0.1125, 0.1125, 0.0540, arc_steps=14)
    c_top = rounded_rect_points(-0.0638, 0.0638, -0.1112, 0.1112, 0.0530, arc_steps=14)
    c_in = rounded_rect_points(-0.0580, 0.0580, -0.1050, 0.1050, 0.0480, arc_steps=14)
    extrude_closed_contour(
        "df64_base_plinth",
        [
            (c_bot, 0.0030),
            (c_Full, 0.0050),
            (c_Full, 0.0155),
            (c_top, 0.0175),
            (c_in, 0.0190),
        ],
        mat["matte_black"],
        root,
    )

    # Recessed front catch-cup rest pad on the base deck
    clean_lathe(
        "df64_base_cup_pad",
        [
            (0.0000, 0.0185),
            (0.0320, 0.0185),
            (0.0330, 0.0200),
            (0.0315, 0.0205),
            (0.0000, 0.0205),
        ],
        (0.0, CUP_ORIGIN[1], 0.0),
        mat["rubber"],
        root,
        segments=64,
    )

    # Stepped lower pedestal ring around the cylinder base (as seen in miicoffee-01.jpg)
    clean_lathe(
        "df64_pedestal_collar",
        [
            (0.0000, 0.0175),
            (0.0585, 0.0175),
            (0.0595, 0.0195),
            (0.0585, 0.0265),
            (0.0555, 0.0295),
            (0.0000, 0.0295),
        ],
        (0.0, BASE_CYL_Y, 0.0),
        mat["matte_black"],
        root,
        segments=80,
    )

    # 3. Forward-leaning main cylinder housing (8.2 deg forward lean from Z=0.018 to Z=0.1995)
    # Includes internal 64 mm flat-burr chamber cavity (Z=0.169 to Z=0.1995, R=0.0460)
    segments = 96
    outer_z_levels = [
        (0.0180, 0.0540),
        (0.0220, CYL_R),
        (0.0600, CYL_R),
        (0.1000, CYL_R),
        (0.1400, CYL_R),
        (0.1700, CYL_R),
        (0.1975, CYL_R),
        (0.1995, 0.0535),
    ]
    inner_profile = [
        (0.0535, 0.1995),
        (0.0462, 0.1995),
        (0.0460, 0.1985),
        (0.0460, 0.1840),
        (0.0460, 0.1705),
        (0.0450, 0.1695),
        (0.0000, 0.1695),
    ]

    verts = []
    bot_center_idx = 0
    verts.append((HEAD_X, cyl_center_y(0.0180), 0.0180))

    ring_indices = []
    for z, r in outer_z_levels:
        cy = cyl_center_y(z)
        start = len(verts)
        for i in range(segments):
            ang = i * math.tau / segments
            verts.append((HEAD_X + r * math.cos(ang), cy + r * math.sin(ang), z))
        ring_indices.append(start)

    for r, z in inner_profile[1:-1]:
        start = len(verts)
        for i in range(segments):
            ang = i * math.tau / segments
            verts.append((HEAD_X + r * math.cos(ang), HEAD_Y + r * math.sin(ang), z))
        ring_indices.append(start)

    inner_floor_idx = len(verts)
    verts.append((HEAD_X, HEAD_Y, 0.1695))

    faces = []
    r0 = ring_indices[0]
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((bot_center_idx, r0 + j, r0 + i))

    for k in range(len(ring_indices) - 1):
        a = ring_indices[k]
        b = ring_indices[k + 1]
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((a + i, a + j, b + j, b + i))

    r_last = ring_indices[-1]
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((inner_floor_idx, r_last + i, r_last + j))

    cyl_obj = mesh_object("df64_tilted_cylinder", verts, faces, mat["matte_black"], root)
    clean_mesh_object(cyl_obj, sharp_z=True, recalc_normals=True)

    # Central motor drive spindle inside the burr chamber floor
    clean_lathe(
        "df64_motor_spindle",
        [
            (0.0000, 0.1690),
            (0.0085, 0.1690),
            (0.0085, 0.1745),
            (0.0055, 0.1755),
            (0.0000, 0.1755),
        ],
        (HEAD_X, HEAD_Y, 0.0),
        mat["burr_steel"],
        root,
        segments=48,
    )

    # Three upper-burr-carrier alignment slots/bosses around the chamber wall (miicoffee-04.jpg)
    for k in range(3):
        ang = math.radians(60.0 + k * 120.0)
        bx = HEAD_X + 0.0472 * math.cos(ang)
        by = HEAD_Y + 0.0472 * math.sin(ang)
        slot_boss = box(
            f"df64_chamber_guide_{k + 1}",
            (bx, by, 0.1910),
            (0.0050, 0.0070, 0.0120),
            mat["brushed_alu"],
            root,
            bevel=0.0005,
        )
        slot_boss.rotation_euler.z = ang
        clean_mesh_object(slot_boss, sharp_z=False)


def build_chute_fork_and_throat(root, mat):
    """Build the angled front discharge chute, plasma ionizer probes, holder fork, dial pointer, and aluminum throat."""
    # 1. Angled front rectangular discharge chute (from burr chamber down toward dosing cup)
    chute = box(
        "df64_discharge_chute",
        (0.0, -0.0640, 0.1560),
        (0.0250, 0.0460, 0.0220),
        mat["matte_black"],
        root,
        bevel=0.0012,
    )
    chute.rotation_euler.x = math.radians(40.0)
    clean_mesh_object(chute, sharp_z=False)

    # Chute exit trim bezel
    chute_lip = box(
        "df64_chute_exit_bezel",
        (0.0, -0.0815, 0.1415),
        (0.0264, 0.0060, 0.0234),
        mat["anodized_black"],
        root,
        bevel=0.0008,
    )
    chute_lip.rotation_euler.x = math.radians(40.0)
    clean_mesh_object(chute_lip, sharp_z=False)

    # V2.5/V2.6 Wrapped Plasma Generator (ionizer) dual probes inside chute exit
    for side, sx in (("left", -0.0055), ("right", 0.0055)):
        probe = cylinder(
            f"df64_plasma_ionizer_{side}",
            (sx, -0.0800, 0.1395),
            0.0014,
            0.0090,
            mat["chrome_ring"],
            root,
            axis="Y",
        )
        probe.rotation_euler.x = math.radians(40.0)
        clean_mesh_object(probe, sharp_z=False)

    # 2. Front two-prong dosing-cup holder fork (miicoffee-01.jpg, miicoffee-06.jpg)
    fork_mount = box(
        "df64_fork_mount_block",
        (0.0, -0.0410, 0.0965),
        (0.0360, 0.0120, 0.0180),
        mat["matte_black"],
        root,
        bevel=0.0010,
    )
    clean_mesh_object(fork_mount, sharp_z=False)

    # Rubber backrest bumper pad for the dosing cup wall (clears cup at Y=-0.0455 by 2.5 mm)
    bumper = box(
        "df64_fork_rubber_bumper",
        (0.0, -0.0410, 0.0820),
        (0.0260, 0.0040, 0.0180),
        mat["rubber"],
        root,
        bevel=0.0006,
    )
    clean_mesh_object(bumper, sharp_z=False)

    # Two silicone-sleeved fork prongs at X = +/- 0.0365 cradling the cup side lugs (Z=0.094..0.099, below lugs at Z=0.102..0.107)
    for side, sx in (("left", -0.0365), ("right", 0.0365)):
        arm_bridge = box(
            f"df64_fork_bridge_{side}",
            (sx * 0.68, -0.0480, 0.0965),
            (0.0220, 0.0100, 0.0060),
            mat["chrome_ring"],
            root,
            bevel=0.0006,
        )
        clean_mesh_object(arm_bridge, sharp_z=False)

        prong = box(
            f"df64_fork_prong_{side}",
            (sx, -0.0740, 0.0965),
            (0.0060, 0.0380, 0.0050),
            mat["rubber"],
            root,
            bevel=0.0008,
        )
        clean_mesh_object(prong, sharp_z=False)

    # 3. Front silver triangular grind-scale indicator pointer (miicoffee-02.jpg)
    ptr_verts = [
        (-0.0048, -0.0600, 0.1930),
        (0.0048, -0.0600, 0.1930),
        (0.0000, -0.0625, 0.2000),
        (-0.0048, -0.0560, 0.1930),
        (0.0048, -0.0560, 0.1930),
        (0.0000, -0.0585, 0.2000),
    ]
    ptr_faces = [
        (0, 1, 2),
        (3, 5, 4),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ]
    ptr_obj = mesh_object("df64_dial_indicator_pointer", ptr_verts, ptr_faces, mat["chrome_ring"], root)
    clean_mesh_object(ptr_obj, sharp_z=False)

    # 4. Machined aluminum upper throat collar (30 g capacity without bellows) + V2.6 convex anti-popcorn disc
    clean_lathe(
        "df64_aluminum_throat",
        [
            (0.0310, 0.2060),
            (0.0380, 0.2060),
            (0.0385, 0.2070),
            (0.0385, 0.2370),
            (0.0378, 0.2380),
            (0.0320, 0.2380),
            (0.0315, 0.2370),
            (0.0315, 0.2140),
            (0.0295, 0.2075),
            (0.0310, 0.2060),
        ],
        (HEAD_X, HEAD_Y, 0.0),
        mat["brushed_alu"],
        root,
        segments=80,
    )

    # V2.6 convex metal anti-popcorn blocker dome + central hex socket screw (miicoffee-05.jpg)
    clean_lathe(
        "df64_antipopcorn_convex_disc",
        [
            (0.0000, 0.2160),
            (0.0215, 0.2160),
            (0.0220, 0.2185),
            (0.0180, 0.2225),
            (0.0110, 0.2255),
            (0.0045, 0.2270),
            (0.0045, 0.2305),
            (0.0000, 0.2305),
        ],
        (HEAD_X, HEAD_Y, 0.0),
        mat["brushed_alu"],
        root,
        segments=64,
    )
    for k in range(3):
        ang = math.radians(30.0 + k * 120.0)
        sx = HEAD_X + 0.0255 * math.cos(ang)
        sy = HEAD_Y + 0.0255 * math.sin(ang)
        strut = box(
            f"df64_antipopcorn_strut_{k + 1}",
            (sx, sy, 0.2175),
            (0.0130, 0.0036, 0.0040),
            mat["brushed_alu"],
            root,
            bevel=0.0004,
        )
        strut.rotation_euler.z = ang
        clean_mesh_object(strut, sharp_z=False)


def build_dial_collar_and_switch(root, mat):
    """Build the chrome stepless adjustment collar (0-90 scale) and lower-right metal power button."""
    # 1. Chrome-wrapped stepless grind adjustment collar (df64_dial_collar)
    dial = empty("df64_dial_collar", DIAL_ORIGIN)
    dial.parent = root

    clean_lathe(
        "df64_dial_chrome_collar",
        [
            (0.0398, 0.0000),
            (0.0592, 0.0000),
            (0.0600, 0.0018),
            (0.0600, 0.0245),
            (0.0585, 0.0272),
            (0.0398, 0.0272),
            (0.0395, 0.0255),
            (0.0395, 0.0015),
            (0.0398, 0.0000),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome_ring"],
        dial,
        segments=96,
    )

    # Matte black top scale ring inset on the chrome collar (miicoffee-02.jpg)
    clean_lathe(
        "df64_dial_scale_band",
        [
            (0.0405, 0.0268),
            (0.0575, 0.0268),
            (0.0575, 0.0276),
            (0.0405, 0.0276),
            (0.0405, 0.0268),
        ],
        (0.0, 0.0, 0.0),
        mat["dial_band"],
        dial,
        segments=96,
    )

    # 37 raised graduation tick marks covering the 0-90 scale around the front/side arc
    for i in range(37):
        ang = math.radians(-90.0 + (i - 18) * 7.5)
        is_major = i % 4 == 0
        r_mid = 0.0512 if is_major else 0.0525
        len_r = 0.0075 if is_major else 0.0045
        w_t = 0.0016 if is_major else 0.0010
        tx = r_mid * math.cos(ang)
        ty = r_mid * math.sin(ang)
        tick_mat = mat["zero_red"] if i == 0 else mat["scale_white"]
        tick = box(
            f"df64_dial_tick_{i:02d}",
            (tx, ty, 0.0278),
            (len_r, w_t, 0.0008),
            tick_mat,
            dial,
            bevel=0.0001,
        )
        tick.rotation_euler.z = ang
        clean_mesh_object(tick, sharp_z=False)

    # Three brew-method arc range bars (espresso 10-20, moka 35-45, filter 65-75)
    for label, deg_center in (("espresso", -155.0), ("moka", -90.0), ("filter", -25.0)):
        ang = math.radians(deg_center)
        bx = 0.0445 * math.cos(ang)
        by = 0.0445 * math.sin(ang)
        bar = box(
            f"df64_dial_range_{label}",
            (bx, by, 0.0278),
            (0.0024, 0.0140, 0.0008),
            mat["scale_white"],
            dial,
            bevel=0.0001,
        )
        bar.rotation_euler.z = ang
        clean_mesh_object(bar, sharp_z=False)

    # 2. Lower-right V2.3/V2.6 brushed stainless-steel latching push button (miicoffee-01.jpg)
    bezel = cylinder(
        "df64_power_switch_bezel",
        (0.0505, POWER_BTN_ORIGIN[1], POWER_BTN_ORIGIN[2]),
        0.0105,
        0.0050,
        mat["chrome_ring"],
        root,
        axis="X",
    )
    clean_mesh_object(bezel, sharp_z=False)

    power_btn = empty("df64_power_button", POWER_BTN_ORIGIN)
    power_btn.parent = root
    btn_cap = cylinder(
        "df64_power_button_cap",
        (0.0015, 0.0, 0.0),
        0.0072,
        0.0050,
        mat["brushed_alu"],
        power_btn,
        axis="X",
    )
    clean_mesh_object(btn_cap, sharp_z=False)

    return dial, power_btn


def build_flat_burrs(root, mat):
    """Build detachable 3-lug upper burr carrier + 64 mm upper flat burr and rotating 64 mm lower flat burr rotor."""
    # 1. Detachable 3-lug upper burr carrier + 64 mm upper flat burr (df64_upper_burr_carrier)
    upper = empty("df64_upper_burr_carrier", UPPER_BURR_ORIGIN)
    upper.parent = root

    # Machined aluminum upper carrier body (Z_local = 0.001..0.017, so world Z = 0.188..0.204)
    clean_lathe(
        "df64_upper_carrier_body",
        [
            (0.0195, 0.0010),
            (0.0365, 0.0010),
            (0.0375, 0.0025),
            (0.0375, 0.0155),
            (0.0360, 0.0170),
            (0.0215, 0.0170),
            (0.0205, 0.0155),
            (0.0195, 0.0010),
        ],
        (0.0, 0.0, 0.0),
        mat["brushed_alu"],
        upper,
        segments=72,
    )

    # Three radial alignment lugs + bronze wave spring rings
    for k in range(3):
        ang = math.radians(k * 120.0)
        lx = 0.0392 * math.cos(ang)
        ly = 0.0392 * math.sin(ang)
        lug = box(
            f"df64_upper_carrier_lug_{k + 1}",
            (lx, ly, 0.0105),
            (0.0070, 0.0085, 0.0080),
            mat["brushed_alu"],
            upper,
            bevel=0.0005,
        )
        lug.rotation_euler.z = ang
        clean_mesh_object(lug, sharp_z=False)

    clean_lathe(
        "df64_upper_wave_spring",
        [
            (0.0355, 0.0045),
            (0.0410, 0.0045),
            (0.0410, 0.0062),
            (0.0355, 0.0062),
            (0.0355, 0.0045),
        ],
        (0.0, 0.0, 0.0),
        mat["brass_spring"],
        upper,
        segments=64,
    )

    # 64 mm stainless-steel upper flat burr ring (R_outer = 0.0320 m = Ø64 mm, Z_local = -0.0025..0.0010 -> world Z = 0.1845..0.1880)
    clean_lathe(
        "df64_upper_flat_burr_ring",
        [
            (0.0185, -0.0025),
            (0.0320, -0.0025),
            (0.0320, 0.0010),
            (0.0185, 0.0010),
            (0.0185, -0.0025),
        ],
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        upper,
        segments=72,
    )
    for t in range(18):
        ang = t * math.tau / 18
        tx = 0.0252 * math.cos(ang)
        ty = 0.0252 * math.sin(ang)
        tooth = box(
            f"df64_upper_burr_tooth_{t + 1:02d}",
            (tx, ty, -0.0028),
            (0.0095, 0.0018, 0.0012),
            mat["burr_steel"],
            upper,
            bevel=0.0002,
        )
        tooth.rotation_euler.z = ang + math.radians(22.0)
        clean_mesh_object(tooth, sharp_z=False)

    # 2. Rotating 64 mm lower flat burr rotor + 3 sweeper blades (df64_lower_burr_rotor)
    # World Z = 0.1730..0.1825 (clears upper burr at Z >= 0.1845 by 2.0 mm, chamber floor at Z = 0.1695 by 3.5 mm)
    lower = empty("df64_lower_burr_rotor", LOWER_BURR_ORIGIN)
    lower.parent = root

    # Rotating lower carrier disc (Z_local = -0.0035..0.0005 -> world Z = 0.1745..0.1785)
    clean_lathe(
        "df64_lower_rotor_disc",
        [
            (0.0090, -0.0035),
            (0.0385, -0.0035),
            (0.0395, -0.0015),
            (0.0385, 0.0005),
            (0.0090, 0.0005),
            (0.0090, -0.0035),
        ],
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        lower,
        segments=72,
    )

    # Three radial grounds-sweeper impeller blades (R_max = 0.0435 m, clearing R=0.0460 chamber wall by 2.5 mm)
    for k in range(3):
        ang = math.radians(k * 120.0)
        sx = 0.0405 * math.cos(ang)
        sy = 0.0405 * math.sin(ang)
        blade = box(
            f"df64_lower_sweeper_blade_{k + 1}",
            (sx, sy, -0.0012),
            (0.0055, 0.0032, 0.0045),
            mat["burr_steel"],
            lower,
            bevel=0.0003,
        )
        blade.rotation_euler.z = ang
        clean_mesh_object(blade, sharp_z=False)

    # 64 mm stainless-steel lower flat burr ring (R_outer = 0.0320 m = Ø64 mm, Z_local = 0.0005..0.0035 -> world Z = 0.1785..0.1815)
    clean_lathe(
        "df64_lower_flat_burr_ring",
        [
            (0.0185, 0.0005),
            (0.0320, 0.0005),
            (0.0320, 0.0035),
            (0.0185, 0.0035),
            (0.0185, 0.0005),
        ],
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        lower,
        segments=72,
    )
    for t in range(18):
        ang = t * math.tau / 18
        tx = 0.0252 * math.cos(ang)
        ty = 0.0252 * math.sin(ang)
        tooth = box(
            f"df64_lower_burr_tooth_{t + 1:02d}",
            (tx, ty, 0.0038),
            (0.0095, 0.0018, 0.0010),
            mat["burr_steel"],
            lower,
            bevel=0.0002,
        )
        tooth.rotation_euler.z = ang - math.radians(22.0)
        clean_mesh_object(tooth, sharp_z=False)

    # Central tri-wing locking nut (miicoffee-04.jpg)
    clean_lathe(
        "df64_lower_triwing_hub",
        [
            (0.0000, 0.0005),
            (0.0115, 0.0005),
            (0.0110, 0.0042),
            (0.0000, 0.0042),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome_ring"],
        lower,
        segments=48,
    )

    return upper, lower


def build_bellows_and_wood_lid(root, mat):
    """Build the 3-pleat black silicone accordion bellows and turned walnut wood top lid (to Z = 0.3000 m)."""
    # 1. Black 3-pleat silicone accordion single-dose bellows (df64_bellows, world Z = 0.2385..0.2875)
    bellows = empty("df64_bellows", BELLOWS_ORIGIN)
    bellows.parent = root

    clean_lathe(
        "df64_silicone_bellows_body",
        [
            (0.0360, 0.0000),
            (0.0430, 0.0000),
            (0.0435, 0.0050),
            (0.0405, 0.0105),
            (0.0445, 0.0165),
            (0.0405, 0.0225),
            (0.0445, 0.0285),
            (0.0405, 0.0345),
            (0.0445, 0.0405),
            (0.0435, 0.0485),
            (0.0355, 0.0485),
            (0.0350, 0.0405),
            (0.0365, 0.0345),
            (0.0350, 0.0285),
            (0.0365, 0.0225),
            (0.0350, 0.0165),
            (0.0365, 0.0105),
            (0.0355, 0.0010),
            (0.0360, 0.0000),
        ],
        (0.0, 0.0, 0.0),
        mat["silicone_bellows"],
        bellows,
        segments=80,
    )

    # 2. Turned American walnut wood top lid (df64_wood_lid, origin Z = 0.2880, top at exact Z = 0.3000)
    lid = empty("df64_wood_lid", LID_ORIGIN)
    lid.parent = root

    clean_lathe(
        "df64_walnut_lid_body",
        [
            (0.0000, -0.0045),
            (0.0335, -0.0045),
            (0.0345, -0.0010),
            (0.0442, 0.0000),
            (0.0450, 0.0015),
            (0.0450, 0.0095),
            (0.0432, 0.0112),
            (0.0240, 0.0118),
            (0.0000, 0.0120),
        ],
        (0.0, 0.0, 0.0),
        mat["walnut_wood"],
        lid,
        segments=80,
    )

    return bellows, lid


def build_dosing_cup(root, mat):
    """Build the 58 mm 6063 black anodized aluminum dosing cup with side mounting lugs and rubber adapter."""
    cup = empty("df64_dosing_cup", CUP_ORIGIN)
    cup.parent = root

    # Main 6063 anodized black aluminum cup body (Z_local = 0.000..0.066, floor at Z_local = 0.004)
    clean_lathe(
        "df64_dosing_cup_body",
        [
            (0.0000, 0.0000),
            (0.0275, 0.0000),
            (0.0290, 0.0020),
            (0.0298, 0.0440),
            (0.0310, 0.0520),
            (0.0310, 0.0655),
            (0.0282, 0.0655),
            (0.0280, 0.0520),
            (0.0265, 0.0045),
            (0.0000, 0.0040),
        ],
        (0.0, 0.0, 0.0),
        mat["anodized_black"],
        cup,
        segments=80,
    )

    # Top black rubber/silicone 58 mm portafilter dosing adapter sleeve (miicoffee-06.jpg)
    clean_lathe(
        "df64_dosing_cup_rubber_collar",
        [
            (0.0282, 0.0656),
            (0.0316, 0.0656),
            (0.0318, 0.0745),
            (0.0310, 0.0760),
            (0.0282, 0.0760),
            (0.0282, 0.0656),
        ],
        (0.0, 0.0, 0.0),
        mat["rubber"],
        cup,
        segments=80,
    )

    # Two side mounting lugs at X = +/- 0.0355 that rest above the holder fork prongs (Z_local = 0.058..0.063 -> world Z = 0.102..0.107)
    for side, sx in (("left", -0.0355), ("right", 0.0355)):
        lug = box(
            f"df64_dosing_cup_lug_{side}",
            (sx, 0.0, 0.0605),
            (0.0065, 0.0110, 0.0050),
            mat["anodized_black"],
            cup,
            bevel=0.0006,
        )
        clean_mesh_object(lug, sharp_z=False)

    return cup


def build_power_lead(root, mat):
    """Build rear power cord strain relief and stowed AC mains lead (excluded from body envelope check)."""
    lead = empty("df64_power_lead", (0.0, 0.1080, 0.0110))
    lead.parent = root
    grommet = cylinder(
        "df64_cord_grommet",
        (0.0, 0.0020, 0.0),
        0.0062,
        0.0100,
        mat["rubber"],
        lead,
        axis="Y",
    )
    clean_mesh_object(grommet, sharp_z=False)

    cable = tube(
        "df64_power_cable",
        [
            (0.000, 0.004, 0.000),
            (0.015, 0.028, -0.005),
            (0.042, 0.040, -0.007),
            (0.072, 0.022, -0.007),
        ],
        0.0034,
        mat["rubber"],
        lead,
    )
    clean_mesh_object(cable, sharp_z=False)

    plug = box(
        "df64_power_plug",
        (0.078, 0.008, -0.002),
        (0.022, 0.032, 0.016),
        mat["rubber"],
        lead,
        bevel=0.0015,
    )
    clean_mesh_object(plug, sharp_z=False)
    for side in (-0.0045, 0.0045):
        blade = box(
            f"df64_plug_blade_{'l' if side < 0 else 'r'}",
            (side, -0.022, 0.0015),
            (0.0015, 0.0140, 0.0060),
            mat["burr_steel"],
            plug,
            bevel=0.0002,
        )
        clean_mesh_object(blade, sharp_z=False)
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
    appliance = bpy.data.collections.new("MiiCoffee DF64 II appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        appliance.objects.link(obj)

    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for index, name in enumerate(
        (
            "miicoffee-01.jpg",
            "miicoffee-02.jpg",
            "miicoffee-04.jpg",
            "miicoffee-05.jpg",
            "miicoffee-06.jpg",
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
    scene.world = bpy.data.worlds.new("DF64 II neutral studio")
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
        material("DF64 II studio floor", (0.58, 0.60, 0.63, 1.0), roughness=0.85)
    )
    area_light("Key softbox", (0.60, -0.55, 0.70), (0.0, -0.02, 0.15), 58, 0.55)
    area_light("Fill strip", (-0.62, -0.28, 0.55), (0.0, -0.02, 0.15), 36, 0.45)
    area_light("Rim softbox", (-0.15, 0.72, 0.72), (0.0, 0.0, 0.17), 56, 0.50)
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


def render_views(camera, lid, bellows, upper_burr, cup):
    render(camera, "studio-main", (0.56, -0.66, 0.42), (0.0, -0.01, 0.150), 0.38)
    render(camera, "studio-front", (0.0, -1.5, 0.150), (0.0, 0.0, 0.150), 0.36)
    render(camera, "studio-right", (1.5, 0.0, 0.150), (0.0, 0.0, 0.150), 0.36)
    # Remove walnut lid and bellows to show V2.6 convex anti-popcorn disc and chrome 0-90 dial (as in miicoffee-02.jpg & miicoffee-05.jpg)
    lid.location = (0.160, -0.050, 0.005)
    bellows.location = (-0.155, -0.050, 0.000)
    render(
        camera,
        "studio-hopper",
        (0.10, -0.26, 0.72),
        (HEAD_X, HEAD_Y, 0.220),
        0.20,
    )
    # Tool-less disassembly view (wood lid, silicone bellows, 64 mm upper burr carrier, and 58 mm dosing cup removed)
    lid.location = (-0.155, 0.045, 0.005)
    bellows.location = (-0.155, -0.075, 0.000)
    upper_burr.location = (0.115, -0.095, 0.003)
    cup.location = (0.000, -0.178, 0.000)
    render(
        camera,
        "studio-disassembled",
        (0.52, -0.82, 0.56),
        (0.0, -0.03, 0.125),
        0.50,
    )
    lid.location = LID_ORIGIN
    bellows.location = BELLOWS_ORIGIN
    upper_burr.location = UPPER_BURR_ORIGIN
    cup.location = CUP_ORIGIN


def animate(lid, bellows, dial, upper_burr, lower_burr, cup, power_btn):
    scene = bpy.context.scene
    # Frames 1-110: lift walnut lid, remove silicone bellows, lift 64 mm upper burr carrier, present dosing cup, reassemble
    for frame, l_lift, b_lift, u_lift, cup_y, cup_z in (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0),
        (20, 0.080, 0.0, 0.0, 0.0, 0.0),
        (40, 0.130, 0.095, 0.0, 0.0, 0.0),
        (55, 0.130, 0.095, 0.075, -0.090, -0.020),
        (75, 0.130, 0.095, 0.0, 0.0, 0.0),
        (95, 0.080, 0.0, 0.0, 0.0, 0.0),
        (110, 0.0, 0.0, 0.0, 0.0, 0.0),
    ):
        lid.location.z = LID_ORIGIN[2] + l_lift
        bellows.location.z = BELLOWS_ORIGIN[2] + b_lift
        upper_burr.location.z = UPPER_BURR_ORIGIN[2] + u_lift
        cup.location.y = CUP_ORIGIN[1] + cup_y
        cup.location.z = CUP_ORIGIN[2] + cup_z
        lid.keyframe_insert(data_path="location", frame=frame)
        bellows.keyframe_insert(data_path="location", frame=frame)
        upper_burr.keyframe_insert(data_path="location", frame=frame)
        cup.keyframe_insert(data_path="location", frame=frame)

    # Frames 115-180: rotate stepless chrome dial collar, press side metal power button, spin 64 mm flat burr, puff bellows
    for frame, dial_deg, btn_dx, burr_deg, puff_dz in (
        (1, 0.0, 0.0, 0.0, 0.0),
        (115, 0.0, 0.0, 0.0, 0.0),
        (130, -35.0, 0.0, 0.0, 0.0),
        (136, -35.0, -0.0022, 0.0, 0.0),
        (142, -35.0, 0.0, 60.0, 0.0),
        (162, -35.0, 0.0, 240.0, -0.012),
        (180, -35.0, 0.0, 360.0, 0.0),
    ):
        dial.rotation_euler.z = math.radians(dial_deg)
        power_btn.location.x = POWER_BTN_ORIGIN[0] + btn_dx
        lower_burr.rotation_euler.z = math.radians(burr_deg)
        if frame >= 115:
            bellows.location.z = BELLOWS_ORIGIN[2] + puff_dz
            lid.location.z = LID_ORIGIN[2] + puff_dz
            bellows.keyframe_insert(data_path="location", frame=frame)
            lid.keyframe_insert(data_path="location", frame=frame)
        dial.keyframe_insert(data_path="rotation_euler", frame=frame)
        power_btn.keyframe_insert(data_path="location", frame=frame)
        lower_burr.keyframe_insert(data_path="rotation_euler", frame=frame)

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
    scene.name = "MiiCoffee DF64 II Black - visual prototype"
    scene.unit_settings.system = "METRIC"

    root = empty("df64_grinder", (0.0, 0.0, 0.0))
    root["model"] = (
        "MiiCoffee DF64 II Single Dose Coffee Grinder (Gen 2 V2.6, Mii-DF64ii-Black, 64 mm flat burrs, 1400 RPM 250 W)"
    )
    root["dimensions_status"] = "Published 130 x 225 x 300 mm (W x D x H); 6.8 kg (7.2 kg manual N.W.)"
    root["physics_status"] = (
        "Articulated visual and native MuJoCo mechanical prototype"
    )

    mat = palette()
    build_base_and_tilted_body(root, mat)
    build_chute_fork_and_throat(root, mat)
    dial, power_btn = build_dial_collar_and_switch(root, mat)
    upper_burr, lower_burr = build_flat_burrs(root, mat)
    bellows, lid = build_bellows_and_wood_lid(root, mat)
    cup = build_dosing_cup(root, mat)
    lead = build_power_lead(root, mat)

    export_glb(root, "miicoffee-df64-gen2.glb")

    # Standalone 58 mm 6063 aluminum dosing cup export
    cup.parent = None
    cup.location = (0.0, 0.0, 0.0)
    export_glb(cup, "miicoffee-df64-gen2-dosing-cup.glb")
    cup.parent = root
    cup.location = CUP_ORIGIN

    # Standalone 64 mm upper flat burr carrier export
    upper_burr.parent = None
    upper_burr.location = (0.0, 0.0, 0.0)
    export_glb(upper_burr, "miicoffee-df64-gen2-burr-carrier.glb")
    upper_burr.parent = root
    upper_burr.location = UPPER_BURR_ORIGIN

    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    report = {
        "status": "Uncalibrated visual and mechanical prototype",
        "published_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(val, 6) for val in (high - low)],
        "published_mass_kg": 6.8,
        "manual_net_weight_kg": 7.2,
        "burr_set": "Custom 64 mm stainless-steel flat burrs (1,400 RPM, 250 W AC motor)",
        "sources": [
            "MiiCoffee official product page (miicoffee.shop/products/mii-df64-single-dosing-coffee-grinder)",
            "Official DF64 II instruction manual (df64ii-use-manual.pdf, 2 pages)",
            "MiiCoffee FAQ and 12 studio reference photographs",
        ],
        "assumptions": [
            "Forward-tilted cylinder centerline (~8.2 deg), chute angle (40 deg), and holder fork geometry derived from studio photographs",
            "Internal 64 mm flat burr tooth geometry, V2.6 convex anti-popcorn dome, and plasma generator probes are visual reconstructions",
            "Lid lift (130 mm), bellows lift (95 mm), upper carrier lift (75 mm), bellows puff (12 mm), and button press (2.2 mm) are preview travels",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "miicoffee-df64-gen2.glb").read_bytes()
        ).hexdigest(),
        "dosing_cup_glb_sha256": hashlib.sha256(
            (ASSETS / "miicoffee-df64-gen2-dosing-cup.glb").read_bytes()
        ).hexdigest(),
        "burr_carrier_glb_sha256": hashlib.sha256(
            (ASSETS / "miicoffee-df64-gen2-burr-carrier.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")

    organize(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, lid, bellows, upper_burr, cup)
    animate(lid, bellows, dial, upper_burr, lower_burr, cup, power_btn)
    camera.location = (0.56, -0.66, 0.42)
    camera.data.ortho_scale = 0.38
    look_at(camera, (0.0, -0.01, 0.150))

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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "miicoffee-df64-gen2.blend"))
    print("Saved MiiCoffee DF64 II visual prototype", ASSETS)


if __name__ == "__main__":
    main()
