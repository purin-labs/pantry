"""Build the TIMEMORE Bricks 01S Black grinder Blender source, GLBs and studio renders."""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_lagom_casa_visuals import (
    clean_mesh_object,
    expand_profile_with_support_loops,
)
from build_mixer_visuals import mesh_object
from build_oven_visuals import (
    area_light,
    empty,
    look_at,
    material,
    tube,
)
from inspect_induction import bounds

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/timemore-bricks-01s"
REFERENCES = ROOT / "docs/equipment/timemore-bricks-01s/images"

# Published TIMEMORE Bricks 01S body envelope: 102 x 150 x 286 mm (W x D x H)
WIDTH = 0.1020
DEPTH = 0.1500
HEIGHT = 0.2860

CHAMBER_AXIS_Y = -0.0020
CHUTE_AXIS_Y = -0.0360

CUP_ORIGIN = (0.0, CHUTE_AXIS_Y, 0.0160)
KNOCKER_ORIGIN = (0.0, CHUTE_AXIS_Y, 0.1320)
POWER_BTN_ORIGIN = (0.0350, 0.0300, 0.0380)
BURR_CONE_ORIGIN = (0.0, CHAMBER_AXIS_Y, 0.1980)
BURR_CARRIER_ORIGIN = (0.0, CHAMBER_AXIS_Y, 0.2050)
HOPPER_ORIGIN = (0.0, CHAMBER_AXIS_Y, 0.2520)
LID_ORIGIN = (0.0, CHAMBER_AXIS_Y, 0.2815)


def palette():
    return {
        "matte_black": material(
            "Bricks anodised matte black",
            (0.055, 0.056, 0.060, 1.0),
            0.35,
            0.42,
        ),
        "dark_trim": material(
            "Bricks dark trim",
            (0.030, 0.031, 0.034, 1.0),
            0.20,
            0.48,
        ),
        "burr_steel": material(
            "Bricks S2C-040-EI SUS420 steel",
            (0.68, 0.70, 0.73, 1.0),
            0.92,
            0.20,
        ),
        "chrome_accent": material(
            "Bricks polished metal",
            (0.80, 0.82, 0.84, 1.0),
            0.90,
            0.18,
        ),
        "white_mark": material(
            "Bricks scale white marking",
            (0.90, 0.91, 0.92, 1.0),
            0.05,
            0.35,
        ),
        "red_index": material(
            "Bricks red index marker",
            (0.82, 0.12, 0.12, 1.0),
            0.10,
            0.30,
        ),
        "decal_bg": material(
            "Bricks brew guide label",
            (0.14, 0.14, 0.15, 1.0),
            0.10,
            0.52,
        ),
        "rubber": material(
            "Bricks silicone pad",
            (0.04, 0.04, 0.045, 1.0),
            0.0,
            0.85,
        ),
        "cord": material(
            "Bricks power cable jacket",
            (0.05, 0.05, 0.055, 1.0),
            0.0,
            0.68,
        ),
        "brass_pin": material(
            "Bricks plug blade",
            (0.76, 0.73, 0.62, 1.0),
            0.92,
            0.22,
        ),
    }


def export_bricks_glb(root_obj, filename):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root_obj, *root_obj.children_recursive):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root_obj
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


def build_lathe(
    name,
    profile,
    surface,
    parent,
    steps=64,
    offset=(0.0, 0.0, 0.0),
    sharp_z=True,
):
    """Revolve a profile (including optional r=0 cap endpoints) around Z without zero-area rings."""
    refined = expand_profile_with_support_loops(profile)
    # Remove duplicate consecutive points
    pts = [refined[0]]
    for p in refined[1:]:
        if math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) > 1e-7:
            pts.append(p)

    has_bot_cap = pts[0][0] <= 1e-6
    has_top_cap = pts[-1][0] <= 1e-6
    ring_pts = pts[1 if has_bot_cap else 0 : -1 if has_top_cap else len(pts)]

    verts = []
    faces = []
    ox, oy, oz = offset

    bot_idx = None
    if has_bot_cap:
        bot_idx = len(verts)
        verts.append((ox, oy, oz + pts[0][1]))

    ring_starts = []
    for r, z in ring_pts:
        start = len(verts)
        ring_starts.append(start)
        for i in range(steps):
            ang = i * math.tau / steps
            verts.append((ox + r * math.cos(ang), oy + r * math.sin(ang), oz + z))

    top_idx = None
    if has_top_cap:
        top_idx = len(verts)
        verts.append((ox, oy, oz + pts[-1][1]))

    if has_bot_cap and ring_starts:
        r0 = ring_starts[0]
        for i in range(steps):
            ni = (i + 1) % steps
            faces.append((bot_idx, r0 + ni, r0 + i))

    for k in range(len(ring_starts) - 1):
        b0 = ring_starts[k]
        b1 = ring_starts[k + 1]
        for i in range(steps):
            ni = (i + 1) % steps
            faces.append((b0 + i, b0 + ni, b1 + ni, b1 + i))

    if has_top_cap and ring_starts:
        rlast = ring_starts[-1]
        for i in range(steps):
            ni = (i + 1) % steps
            faces.append((top_idx, rlast + i, rlast + ni))

    obj = mesh_object(name, verts, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=sharp_z, recalc_normals=False)


def create_clean_cylinder(
    name,
    center,
    radius,
    z0,
    z1,
    surface,
    parent,
    segments=36,
    bevel=0.0003,
):
    b = min(bevel, 0.25 * abs(z1 - z0), 0.25 * radius)
    profile = [
        (0.0, z0),
        (radius - b, z0),
        (radius, z0 + b),
        (radius, z1 - b),
        (radius - b, z1),
        (0.0, z1),
    ]
    return build_lathe(name, profile, surface, parent, steps=segments, offset=center)


def create_extruded_box_with_support_loops(
    name,
    x_bounds,
    y_bounds,
    z_bounds,
    surface,
    parent,
    front_bottom_y_inset=0.0,
    guard=0.0002,
):
    """Build a crisp architectural rectangular block with support loops along X, Y, and Z."""
    x0, x1 = x_bounds
    y0, y1 = y_bounds
    z0, z1 = z_bounds

    xs = [x0, x0 + guard, 0.5 * (x0 + x1), x1 - guard, x1]
    zs = [z0, z0 + guard, 0.5 * (z0 + z1), z1 - guard, z1]

    verts = []
    faces = []
    ring_pts_count = 16
    for z in zs:
        alpha = (z - z0) / max(1e-6, (z1 - z0))
        yf = y0 + (1.0 - alpha) * front_bottom_y_inset
        ys = [yf, yf + guard, 0.5 * (yf + y1), y1 - guard, y1]
        ring = [
            (xs[0], ys[0], z),
            (xs[1], ys[0], z),
            (xs[2], ys[0], z),
            (xs[3], ys[0], z),
            (xs[4], ys[0], z),
            (xs[4], ys[1], z),
            (xs[4], ys[2], z),
            (xs[4], ys[3], z),
            (xs[4], ys[4], z),
            (xs[3], ys[4], z),
            (xs[2], ys[4], z),
            (xs[1], ys[4], z),
            (xs[0], ys[4], z),
            (xs[0], ys[3], z),
            (xs[0], ys[2], z),
            (xs[0], ys[1], z),
        ]
        verts.extend(ring)

    nz = len(zs)
    for rz in range(nz - 1):
        b0 = rz * ring_pts_count
        b1 = (rz + 1) * ring_pts_count
        for i in range(ring_pts_count):
            ni = (i + 1) % ring_pts_count
            faces.append((b0 + i, b0 + ni, b1 + ni, b1 + i))

    bot_center_idx = len(verts)
    verts.append((0.5 * (x0 + x1), 0.5 * (y0 + front_bottom_y_inset + y1), z0))
    for i in range(ring_pts_count):
        ni = (i + 1) % ring_pts_count
        faces.append((bot_center_idx, ni, i))

    top_center_idx = len(verts)
    verts.append((0.5 * (x0 + x1), 0.5 * (y0 + y1), z1))
    top_base = (nz - 1) * ring_pts_count
    for i in range(ring_pts_count):
        ni = (i + 1) % ring_pts_count
        faces.append((top_center_idx, top_base + i, top_base + ni))

    obj = mesh_object(name, verts, faces, surface, parent)
    return clean_mesh_object(obj, sharp_z=True, recalc_normals=False)


def build_base_and_column(root, mat):
    # 1. Four silicone anti-slip feet at Z = 0.0000 .. 0.0020
    foot_coords = (
        ("bricks_foot_fl", -0.0380, -0.0580),
        ("bricks_foot_fr", 0.0380, -0.0580),
        ("bricks_foot_rl", -0.0380, 0.0580),
        ("bricks_foot_rr", 0.0380, 0.0580),
    )
    for fname, fx, fy in foot_coords:
        foot_node = empty(fname, (fx, fy, 0.0), root)
        create_clean_cylinder(
            f"Silicone foot pad {fname}",
            (0.0, 0.0, 0.0),
            0.0080,
            0.0000,
            0.0020,
            mat["rubber"],
            foot_node,
            segments=32,
            bevel=0.0003,
        )

    # 2. Cantilever rectangular base plate (102 x 150 mm, Z = 0.0020 .. 0.0160)
    create_extruded_box_with_support_loops(
        "Anodised cantilever base plate",
        (-0.0510, 0.0510),
        (-0.0750, 0.0750),
        (0.0020, 0.0160),
        mat["matte_black"],
        root,
        front_bottom_y_inset=0.0025,
    )

    # 3. Magnetic catch-cup landing pad on base deck
    pad_profile = [
        (0.0000, 0.0156),
        (0.0234, 0.0156),
        (0.0234, 0.0161),
        (0.0226, 0.0161),
        (0.0222, 0.0159),
        (0.0000, 0.0159),
    ]
    build_lathe(
        "Magnetic catch-cup pad",
        pad_profile,
        mat["dark_trim"],
        root,
        steps=64,
        offset=(0.0, CHUTE_AXIS_Y, 0.0),
    )

    # 4. Vertical support column (70 mm wide x 68 mm deep, Z = 0.0160 .. 0.1460)
    create_extruded_box_with_support_loops(
        "Vertical support column",
        (-0.0350, 0.0350),
        (-0.0040, 0.0640),
        (0.0160, 0.1460),
        mat["matte_black"],
        root,
    )


def build_upper_chamber_block(root, mat):
    """Build the 102 x 108 x 106 mm upper cubic block with an open cylindrical grind chamber bore."""
    x0, x1 = -0.0510, 0.0510
    y0, y1 = -0.0440, 0.0640
    z0, z1 = 0.1460, 0.2520
    bore_r = 0.0330
    bore_step_r = 0.0230
    bore_bottom_z = 0.1750

    verts = []
    faces = []

    guard = 0.0003
    xs = [
        x0,
        x0 + guard,
        *[x0 + (x1 - x0) * i / 14 for i in range(1, 14)],
        x1 - guard,
        x1,
    ]
    ys = [
        y0,
        y0 + guard,
        *[y0 + (y1 - y0) * i / 14 for i in range(1, 14)],
        y1 - guard,
        y1,
    ]
    rect_ring_xy = (
        [(x, y0) for x in xs[:-1]]
        + [(x1, y) for y in ys[:-1]]
        + [(x, y1) for x in reversed(xs[1:])]
        + [(x0, y) for y in reversed(ys[1:])]
    )
    n_ring = len(rect_ring_xy)

    circle_angles = [
        math.atan2(py - CHAMBER_AXIS_Y, px) for (px, py) in rect_ring_xy
    ]

    def add_rect_ring(z, scale_inset=0.0):
        for px, py in rect_ring_xy:
            sx = px - math.copysign(scale_inset, px) if abs(px) > 1e-4 else px
            sy = (
                py - math.copysign(scale_inset, py - CHAMBER_AXIS_Y)
                if abs(py - CHAMBER_AXIS_Y) > 1e-4
                else py
            )
            verts.append((sx, sy, z))

    def add_circle_ring(r, z):
        for a in circle_angles:
            verts.append((r * math.cos(a), CHAMBER_AXIS_Y + r * math.sin(a), z))

    bot_center_idx = 0
    verts.append((0.0, CHAMBER_AXIS_Y, z0))

    rings = []

    def push_rect(z, inset=0.0):
        start = len(verts)
        add_rect_ring(z, inset)
        rings.append(start)

    def push_circ(r, z):
        start = len(verts)
        add_circle_ring(r, z)
        rings.append(start)

    push_rect(z0, inset=0.0004)
    push_rect(z0, inset=0.0)
    push_rect(z0 + guard, inset=0.0)
    push_rect(0.5 * (z0 + z1), inset=0.0)
    push_rect(z1 - guard, inset=0.0)
    push_rect(z1, inset=0.0)
    push_rect(z1, inset=0.0004)

    push_circ(bore_r + 0.0006, z1)
    push_circ(bore_r, z1 - 0.0004)
    push_circ(bore_r, z1 - 0.0008)
    push_circ(bore_r, 0.2035)
    push_circ(bore_r, 0.2030)
    push_circ(bore_step_r + 0.0003, 0.2030)
    push_circ(bore_step_r, 0.2027)
    push_circ(bore_step_r, bore_bottom_z + 0.0003)
    push_circ(bore_step_r, bore_bottom_z)
    push_circ(0.0040, bore_bottom_z)

    bore_center_idx = len(verts)
    verts.append((0.0, CHAMBER_AXIS_Y, bore_bottom_z))

    r0 = rings[0]
    for i in range(n_ring):
        ni = (i + 1) % n_ring
        faces.append((bot_center_idx, r0 + ni, r0 + i))

    for k in range(len(rings) - 1):
        b0 = rings[k]
        b1 = rings[k + 1]
        for i in range(n_ring):
            ni = (i + 1) % n_ring
            faces.append((b0 + i, b0 + ni, b1 + ni, b1 + i))

    rlast = rings[-1]
    for i in range(n_ring):
        ni = (i + 1) % n_ring
        faces.append((bore_center_idx, rlast + i, rlast + ni))

    obj = mesh_object(
        "Upper cubic chamber housing",
        verts,
        faces,
        mat["matte_black"],
        root,
    )
    clean_mesh_object(obj, sharp_z=True, recalc_normals=False)

    # Front Cylindrical Discharge Chute
    chute_profile = [
        (0.0140, 0.1400),
        (0.0206, 0.1400),
        (0.0210, 0.1404),
        (0.0210, 0.1452),
        (0.0205, 0.1456),
        (0.0140, 0.1456),
        (0.0140, 0.1400),
    ]
    build_lathe(
        "Front discharge chute housing",
        chute_profile,
        mat["matte_black"],
        root,
        steps=64,
        offset=(0.0, CHUTE_AXIS_Y, 0.0),
    )

    # TIMEMORE front wordmark badge bars
    for idx in range(8):
        bx = 0.0180 + idx * 0.0032
        create_extruded_box_with_support_loops(
            f"Front TIMEMORE badge glyph {idx + 1}",
            (bx - 0.0009, bx + 0.0009),
            (-0.0443, -0.0439),
            (0.2425, 0.2455),
            mat["white_mark"],
            root,
            guard=0.00005,
        )

    # Top deck diagonal red grind-index line
    idx_verts = [
        (-0.0245, CHAMBER_AXIS_Y - 0.0235, 0.2519),
        (-0.0235, CHAMBER_AXIS_Y - 0.0245, 0.2519),
        (-0.0345, CHAMBER_AXIS_Y - 0.0355, 0.2519),
        (-0.0355, CHAMBER_AXIS_Y - 0.0345, 0.2519),
        (-0.0245, CHAMBER_AXIS_Y - 0.0235, 0.2524),
        (-0.0235, CHAMBER_AXIS_Y - 0.0245, 0.2524),
        (-0.0345, CHAMBER_AXIS_Y - 0.0355, 0.2524),
        (-0.0355, CHAMBER_AXIS_Y - 0.0345, 0.2524),
    ]
    idx_faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    idx_obj = mesh_object(
        "Top red grind index marker",
        idx_verts,
        idx_faces,
        mat["red_index"],
        root,
    )
    clean_mesh_object(idx_obj, sharp_z=True, recalc_normals=True)

    # Right side (+X) brew-guide label plaque (flush at X <= 0.0510)
    create_extruded_box_with_support_loops(
        "Side brew guide label",
        (0.0504, 0.0509),
        (CHAMBER_AXIS_Y - 0.0110, CHAMBER_AXIS_Y + 0.0110),
        (0.2220, 0.2515),
        mat["decal_bg"],
        root,
        guard=0.00005,
    )
    for i, gy in enumerate((-0.0065, 0.0, 0.0065)):
        create_extruded_box_with_support_loops(
            f"Side brew guide icon {i + 1}",
            (0.0508, 0.0510),
            (CHAMBER_AXIS_Y + gy - 0.0018, CHAMBER_AXIS_Y + gy + 0.0018),
            (0.2280, 0.2335),
            mat["white_mark"],
            root,
            guard=0.00005,
        )


def build_controls_and_knocker(root, mat):
    knocker = empty("bricks_knocker", KNOCKER_ORIGIN, root)
    knocker["joint"] = "bricks_knocker_turn"
    knocker["axis"] = "0 0 1"

    knocker_profile = [
        (0.0135, -0.0090),
        (0.0165, -0.0090),
        (0.0195, -0.0055),
        (0.0208, -0.0050),
        (0.0208, 0.0072),
        (0.0204, 0.0075),
        (0.0140, 0.0075),
        (0.0135, -0.0090),
    ]
    build_lathe(
        "Rotary fines knocker ring",
        knocker_profile,
        mat["matte_black"],
        knocker,
        steps=64,
    )
    for i in range(36):
        ang = i * math.tau / 36
        rx = 0.0207 * math.cos(ang)
        ry = 0.0207 * math.sin(ang)
        create_clean_cylinder(
            f"Knocker grip rib {i + 1}",
            (rx, ry, 0.0),
            0.00045,
            -0.0046,
            0.0070,
            mat["dark_trim"],
            knocker,
            segments=8,
            bevel=0.0001,
        )

    spout_profile = [
        (0.0125, -0.0092),
        (0.0162, -0.0092),
        (0.0185, -0.0060),
        (0.0135, -0.0060),
        (0.0125, -0.0092),
    ]
    build_lathe(
        "Knocker stainless spout rim",
        spout_profile,
        mat["chrome_accent"],
        knocker,
        steps=48,
    )

    power_btn = empty("bricks_power_button", POWER_BTN_ORIGIN, root)
    power_btn["joint"] = "bricks_power_press"
    power_btn["axis"] = "-1 0 0"

    bezel = create_clean_cylinder(
        "Power button chrome bezel",
        (0.0, 0.0, 0.0),
        0.0090,
        0.0001,
        0.0014,
        mat["chrome_accent"],
        root,
        segments=40,
        bevel=0.0003,
    )
    bezel.rotation_euler = (0.0, math.pi / 2, 0.0)
    bezel.location = POWER_BTN_ORIGIN

    btn_cap = create_clean_cylinder(
        "Power push button cap",
        (0.0, 0.0, 0.0),
        0.0064,
        0.0015,
        0.0032,
        mat["chrome_accent"],
        power_btn,
        segments=40,
        bevel=0.0004,
    )
    btn_cap.rotation_euler = (0.0, math.pi / 2, 0.0)

    return power_btn, knocker


def build_burrs(root, mat):
    carrier = empty("bricks_burr_carrier", BURR_CARRIER_ORIGIN, root)
    carrier["joint"] = "bricks_carrier_lift"
    carrier["axis"] = "0 0 1"

    carrier_profile = [
        (0.0175, 0.0000),
        (0.0278, 0.0000),
        (0.0285, 0.0007),
        (0.0285, 0.0172),
        (0.0278, 0.0180),
        (0.0240, 0.0180),
        (0.0240, 0.0145),
        (0.0210, 0.0080),
        (0.0175, 0.0000),
    ]
    build_lathe(
        "S2C-040-EI outer burr carrier",
        carrier_profile,
        mat["burr_steel"],
        carrier,
        steps=64,
    )

    for i in range(16):
        ang = i * math.tau / 16
        rx = 0.0195 * math.cos(ang)
        ry = 0.0195 * math.sin(ang)
        create_clean_cylinder(
            f"Outer burr cutting tooth {i + 1}",
            (rx, ry, 0.0),
            0.0014,
            0.0005,
            0.0125,
            mat["burr_steel"],
            carrier,
            segments=10,
            bevel=0.0002,
        )

    bail_pts = [
        (
            0.0245 * math.cos(t),
            0.0245 * math.sin(t),
            0.0185 + 0.0020 * math.sin(t),
        )
        for t in [math.pi * i / 16 for i in range(17)]
    ]
    bail = tube(
        "Burr carrier wire bail handle",
        bail_pts,
        0.0008,
        mat["chrome_accent"],
        carrier,
    )
    clean_mesh_object(bail, recalc_normals=True)

    cone = empty("bricks_burr_cone", BURR_CONE_ORIGIN, root)
    cone["joint"] = "bricks_burr_spin"
    cone["axis"] = "0 0 1"

    cone_profile = [
        (0.0000, -0.0160),
        (0.0195, -0.0160),
        (0.0192, -0.0110),
        (0.0145, -0.0030),
        (0.0110, 0.0010),
        (0.0095, 0.0035),
        (0.0068, 0.0040),
        (0.0068, 0.0095),
        (0.0052, 0.0125),
        (0.0000, 0.0135),
    ]
    build_lathe(
        "S2C-040-EI conical burr",
        cone_profile,
        mat["burr_steel"],
        cone,
        steps=56,
    )

    for i in range(7):
        ang = i * math.tau / 7
        rx = 0.0142 * math.cos(ang)
        ry = 0.0142 * math.sin(ang)
        create_clean_cylinder(
            f"S2C spike tooth {i + 1}",
            (rx, ry, 0.0),
            0.0018,
            -0.0145,
            -0.0015,
            mat["burr_steel"],
            cone,
            segments=10,
            bevel=0.0002,
        )

    return carrier, cone


def build_hopper_and_lid(root, mat):
    hopper = empty("bricks_hopper", HOPPER_ORIGIN, root)
    hopper["joint"] = "bricks_hopper_dial"
    hopper["lift_joint"] = "bricks_hopper_lift"

    hopper_profile = [
        (0.0265, -0.0160),
        (0.0312, -0.0160),
        (0.0315, -0.0155),
        (0.0315, 0.0005),
        (0.0365, 0.0020),
        (0.0415, 0.0055),
        (0.0420, 0.0062),
        (0.0420, 0.0288),
        (0.0414, 0.0295),
        (0.0368, 0.0295),
        (0.0365, 0.0288),
        (0.0365, 0.0180),
        (0.0265, 0.0020),
        (0.0265, -0.0160),
    ]
    build_lathe(
        "Rotatable 2-way bean hopper dial",
        hopper_profile,
        mat["matte_black"],
        hopper,
        steps=72,
    )

    for i in range(50):
        ang = i * math.tau / 50
        is_major = i % 5 == 0
        dot_r = 0.00095 if is_major else 0.00048
        dot_z = 0.0092
        dx = 0.0420 * math.cos(ang)
        dy = 0.0420 * math.sin(ang)
        dot = create_clean_cylinder(
            f"Hopper click dot {i}",
            (0.0, 0.0, 0.0),
            dot_r,
            -0.0003,
            0.00025,
            mat["white_mark"],
            hopper,
            segments=12,
            bevel=0.00008,
        )
        dot.rotation_euler = (0.0, math.pi / 2, ang)
        dot.location = (dx, dy, dot_z)

    lid = empty("bricks_hopper_lid", LID_ORIGIN, root)
    lid["joint"] = "bricks_lid_lift"
    lid["axis"] = "0 0 1"

    lid_profile = [
        (0.0000, -0.0020),
        (0.0352, -0.0020),
        (0.0355, 0.0005),
        (0.0415, 0.0005),
        (0.0420, 0.0010),
        (0.0420, 0.0040),
        (0.0414, 0.0045),
        (0.0068, 0.0045),
        (0.0064, 0.0038),
        (0.0000, 0.0038),
    ]
    build_lathe(
        "Magnetic hopper top lid",
        lid_profile,
        mat["matte_black"],
        lid,
        steps=72,
    )

    return hopper, lid


def build_dosing_cup(root, mat):
    cup = empty("bricks_dosing_cup", CUP_ORIGIN, root)
    cup["body"] = "bricks_dosing_cup"

    cup_profile = [
        (0.0000, 0.0035),
        (0.0226, 0.0035),
        (0.0230, 0.0040),
        (0.0230, 0.1014),
        (0.0225, 0.1020),
        (0.0208, 0.1020),
        (0.0204, 0.1014),
        (0.0204, 0.0135),
        (0.0185, 0.0120),
        (0.0000, 0.0120),
    ]
    build_lathe(
        "Magnetic dosing catch cup",
        cup_profile,
        mat["matte_black"],
        cup,
        steps=64,
    )

    base_profile = [
        (0.0000, 0.0005),
        (0.0222, 0.0005),
        (0.0226, 0.0010),
        (0.0226, 0.0035),
        (0.0000, 0.0035),
    ]
    build_lathe(
        "Dosing cup magnetic base",
        base_profile,
        mat["dark_trim"],
        cup,
        steps=64,
    )
    return cup


def build_power_lead(root, mat):
    lead = empty("bricks_power_lead", (0.0, 0.0, 0.0), root)
    lead["note"] = "Stowed power cord; excluded from body envelope check"

    relief = create_clean_cylinder(
        "Rear cord strain relief",
        (0.0, 0.0, 0.0),
        0.0050,
        0.0,
        0.010,
        mat["rubber"],
        lead,
        segments=20,
        bevel=0.0008,
    )
    relief.rotation_euler = (-math.pi / 2, 0.0, 0.0)
    relief.location = (0.0, 0.0640, 0.0240)

    cable = tube(
        "Stowed power cable",
        [
            (0.0, 0.070, 0.024),
            (0.018, 0.102, 0.012),
            (0.048, 0.095, 0.004),
            (0.068, 0.055, 0.004),
            (0.068, 0.018, 0.007),
        ],
        0.0032,
        mat["cord"],
        lead,
    )
    clean_mesh_object(cable, recalc_normals=True)

    plug = create_clean_cylinder(
        "Japanese AC plug body",
        (0.068, 0.006, 0.009),
        0.010,
        -0.007,
        0.007,
        mat["rubber"],
        lead,
        segments=24,
        bevel=0.0015,
    )
    plug.rotation_euler = (math.pi / 2, 0.0, 0.0)

    for px in (-0.0055, 0.0055):
        blade = create_clean_cylinder(
            f"Plug blade {px:+.4f}",
            (0.068 + px, -0.008, 0.009),
            0.0012,
            -0.007,
            0.007,
            mat["brass_pin"],
            lead,
            segments=12,
            bevel=0.0002,
        )
        blade.rotation_euler = (math.pi / 2, 0.0, 0.0)

    return lead


def setup_studio_and_renders(
    root, hopper, lid, carrier, cone, knocker, power_btn, cup, skip_renders=False
):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1600
    scene.render.film_transparent = False

    world = bpy.data.worlds.new("Bricks Studio World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.80, 0.82, 0.85, 1.0)
    bg.inputs[1].default_value = 0.90
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.0

    studio = bpy.data.collections.new("Studio")
    scene.collection.children.link(studio)

    floor_mat = material(
        "Studio cyclorama floor",
        (0.84, 0.85, 0.87, 1.0),
        0.0,
        0.88,
    )
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 0.0, 0.0))
    floor = bpy.context.active_object
    floor.name = "Studio floor"
    floor.data.materials.append(floor_mat)

    area_light("Key softbox", (-0.65, -0.85, 0.82), (0.0, -0.01, 0.15), 48.0, 0.90)
    key = bpy.data.objects["Key softbox"]
    area_light("Right fill", (0.78, -0.55, 0.48), (0.0, -0.01, 0.14), 28.0, 0.80)
    fill = bpy.data.objects["Right fill"]
    area_light("Top rim", (0.05, 0.65, 0.92), (0.0, -0.01, 0.18), 38.0, 0.70)
    rim = bpy.data.objects["Top rim"]

    cam_data = bpy.data.cameras.new("Studio Camera")
    cam_data.lens = 68
    camera = bpy.data.objects.new("Studio Camera", cam_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    for obj in (floor, key, fill, rim, camera):
        for col in list(obj.users_collection):
            col.objects.unlink(obj)
        studio.objects.link(obj)

    views = [
        ("studio-main.png", (0.36, -0.52, 0.28), (-0.005, -0.010, 0.145), "PERSP", 68),
        ("studio-front.png", (0.0, -0.72, 0.145), (0.0, -0.010, 0.145), "ORTHO", 0.34),
        ("studio-right.png", (0.72, -0.010, 0.145), (0.0, -0.010, 0.145), "ORTHO", 0.34),
        ("studio-hopper.png", (0.20, -0.30, 0.44), (0.0, -0.002, 0.255), "PERSP", 82),
    ]

    if not skip_renders:
        for filename, loc, target, ctype, lens_or_scale in views:
            if filename == "studio-hopper.png":
                lid.location = (0.105, -0.010, 0.0020)
            else:
                lid.location = LID_ORIGIN
            cam_data.type = ctype
            if ctype == "ORTHO":
                cam_data.ortho_scale = lens_or_scale
            else:
                cam_data.lens = lens_or_scale
            camera.location = loc
            look_at(camera, target)
            scene.render.filepath = str(ASSETS / filename)
            bpy.ops.render.render(write_still=True)

        # Disassembled maintenance view
        lid.location = (0.115, 0.045, 0.0020)
        hopper.location = (0.105, -0.035, 0.0160)
        carrier.location = (-0.095, 0.025, 0.0000)
        cup.location = (-0.095, -0.055, 0.0000)
        cam_data.type = "PERSP"
        cam_data.lens = 62
        camera.location = (0.44, -0.60, 0.34)
        look_at(camera, (0.005, -0.010, 0.125))
        scene.render.filepath = str(ASSETS / "studio-disassembled.png")
        bpy.ops.render.render(write_still=True)

        # Restore rest poses
        lid.location = LID_ORIGIN
        hopper.location = HOPPER_ORIGIN
        carrier.location = BURR_CARRIER_ORIGIN
        cup.location = CUP_ORIGIN

    cam_data.type = "PERSP"
    cam_data.lens = 68
    camera.location = (0.36, -0.52, 0.28)
    look_at(camera, (-0.005, -0.010, 0.145))

    ref_col = bpy.data.collections.new("References")
    scene.collection.children.link(ref_col)
    ref_col.hide_viewport = True
    ref_col.hide_render = True
    for idx, ref_name in enumerate(
        (
            "manufacturer-01.jpg",
            "komameya-01.jpg",
            "komameya-04.jpg",
            "komameya-06.jpg",
            "komameya-07.jpg",
        )
    ):
        ref_path = REFERENCES / ref_name
        if ref_path.exists():
            img = bpy.data.images.load(str(ref_path))
            img.pack()
            plane = bpy.data.objects.new(f"ref_{ref_name}", None)
            plane.empty_display_type = "IMAGE"
            plane.data = img
            plane.location = (-0.30 - idx * 0.16, 0.22, 0.15)
            ref_col.objects.link(plane)

    scene.frame_start = 1
    scene.frame_end = 180
    keyframes = [
        (1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        (25, 0.0, 0.0, 0.0, 0.0, 0.0, -0.0014, 0.0, 0.0),
        (50, 0.0, 0.0, 0.0, math.tau * 2, 0.0, 0.0, 0.0, 0.0),
        (75, 0.0, 0.0, 0.0, math.tau * 2, 0.65, 0.0, 0.0, 0.0),
        (100, 0.045, 0.75, 0.0, math.tau * 2, 0.0, 0.0, 0.0, 0.0),
        (135, 0.095, 1.25, 0.065, math.tau * 2, 0.0, 0.0, -0.065, 0.048),
        (180, 0.0, 0.0, 0.0, math.tau * 2, 0.0, 0.0, 0.0, 0.0),
    ]
    for (
        frame,
        lid_dz,
        dial_rz,
        hop_dz,
        cone_rz,
        knock_rz,
        btn_dx,
        cup_dy,
        car_dz,
    ) in keyframes:
        scene.frame_set(frame)
        lid.location = (LID_ORIGIN[0], LID_ORIGIN[1], LID_ORIGIN[2] + lid_dz)
        hopper.rotation_euler = (0.0, 0.0, dial_rz)
        hopper.location = (HOPPER_ORIGIN[0], HOPPER_ORIGIN[1], HOPPER_ORIGIN[2] + hop_dz)
        carrier.location = (
            BURR_CARRIER_ORIGIN[0],
            BURR_CARRIER_ORIGIN[1],
            BURR_CARRIER_ORIGIN[2] + car_dz,
        )
        cone.rotation_euler = (0.0, 0.0, cone_rz)
        knocker.rotation_euler = (0.0, 0.0, knock_rz)
        power_btn.location = (
            POWER_BTN_ORIGIN[0] + btn_dx,
            POWER_BTN_ORIGIN[1],
            POWER_BTN_ORIGIN[2],
        )
        cup.location = (CUP_ORIGIN[0], CUP_ORIGIN[1] + cup_dy, CUP_ORIGIN[2])

        for obj in (lid, hopper, carrier, cone, knocker, power_btn, cup):
            obj.keyframe_insert(data_path="location", frame=frame)
            obj.keyframe_insert(data_path="rotation_euler", frame=frame)

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
    scene.name = "TIMEMORE Bricks 01S - visual prototype"
    scene.unit_settings.system = "METRIC"

    root = empty("bricks_grinder", (0.0, 0.0, 0.0))
    root["model"] = (
        "TIMEMORE Bricks 01S Electric Coffee Grinder Black (S2C-040-EI 40 mm, JP 100 V 150 W)"
    )
    root["dimensions_status"] = "Published 102 x 150 x 286 mm (W x D x H); 2.6 kg"

    mat = palette()
    build_base_and_column(root, mat)
    build_upper_chamber_block(root, mat)
    power_btn, knocker = build_controls_and_knocker(root, mat)
    carrier, cone = build_burrs(root, mat)
    hopper, lid = build_hopper_and_lid(root, mat)
    cup = build_dosing_cup(root, mat)
    lead = build_power_lead(root, mat)

    export_bricks_glb(root, "timemore-bricks-01s.glb")

    cup.parent = None
    cup.location = (0.0, 0.0, 0.0)
    export_bricks_glb(cup, "timemore-bricks-01s-cup.glb")
    cup.parent = root
    cup.location = CUP_ORIGIN

    carrier.parent = None
    carrier.location = (0.0, 0.0, 0.0)
    export_bricks_glb(carrier, "timemore-bricks-01s-burr-carrier.glb")
    carrier.parent = root
    carrier.location = BURR_CARRIER_ORIGIN

    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    report = {
        "status": "Uncalibrated visual and mechanical prototype",
        "published_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(val, 6) for val in (high - low)],
        "published_mass_kg": 2.6,
        "burr_set": "TIMEMORE S2C-040-EI 40 mm SUS420 stainless-steel conical burrs",
        "sources": [
            "COFFEE LAB KOMAMEYA Japan listing (timemore-bricks-01s-black)",
            "TIMEMORE Japan official product page (SKU IF11120316)",
            "TIMEMORE Global official product page",
        ],
        "exports": {},
    }
    for filename in (
        "timemore-bricks-01s.glb",
        "timemore-bricks-01s-cup.glb",
        "timemore-bricks-01s-burr-carrier.glb",
    ):
        path = ASSETS / filename
        report["exports"][filename] = {
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")

    setup_studio_and_renders(
        root,
        hopper,
        lid,
        carrier,
        cone,
        knocker,
        power_btn,
        cup,
        skip_renders=args.skip_renders,
    )
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "timemore-bricks-01s.blend"))


if __name__ == "__main__":
    main()
