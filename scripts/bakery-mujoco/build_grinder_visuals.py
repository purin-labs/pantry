"""Build the Waring WSG60 visual prototype from manufacturer references.

Metres, Z up, front -Y. Drawing dimensions are provisional because the product
page swaps width and depth. Motion and mating geometry are visual estimates.
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
from mathutils.geometry import tessellate_polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_surface_kit import (
    bake_ortho_sheet,
    generate_stainless_hairline_textures,
    load_latin_bold_font,
    project_front_planar_uvs,
    project_stainless_uvs,
    setup_softbox_world,
    textured_decal_material,
    textured_stainless_material,
)
from build_mixer_visuals import arc_points, lathe, loft_z, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    rounded_rectangle,
    tube,
)
from inspect_induction import bounds

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/waring-wsg60"
REFERENCES = REPOSITORY / "docs/equipment/waring-wsg60/images"
WIDTH, DEPTH, HEIGHT = 0.1651, 0.2159, 0.2921
BOWL_ORIGIN = (0, 0.015, 0.160)
COVER_ORIGIN = (0, 0.015, 0.180)
BADGE_INSERT_W, BADGE_INSERT_H = 0.0768, 0.0256
TEMP_TEXTURE_FILES = (
    "wsg60-stainless-hl.png",
    "wsg60-stainless-orm.png",
    "wsg60-badge-decal.png",
)


def waring_logo_components(scale=1.0):
    """Return 2D (x, z) polygon components [outer_ccw, *holes_cw] for WARING with swept R leg."""
    z0, z1 = -0.0038, 0.0052

    w_outer = [
        (-0.0306, z1),
        (-0.0281, z0),
        (-0.0258, z0),
        (-0.0240, 0.0019),
        (-0.0222, z0),
        (-0.0199, z0),
        (-0.0174, z1),
        (-0.0196, z1),
        (-0.0211, -0.0005),
        (-0.0229, z1),
        (-0.0251, z1),
        (-0.0269, -0.0005),
        (-0.0284, z1),
    ]

    a_outer = [
        (-0.0170, z0),
        (-0.0147, z0),
        (-0.0139, -0.0017),
        (-0.0097, -0.0017),
        (-0.0089, z0),
        (-0.0066, z0),
        (-0.0105, z1),
        (-0.0131, z1),
    ]
    a_hole = [
        (-0.0131, 0.0001),
        (-0.0118, 0.0033),
        (-0.0105, 0.0001),
    ]

    r_bowl_arc = [
        (
            0.0008 + 0.0030 * math.cos(math.radians(deg)),
            0.00265 + 0.00255 * math.sin(math.radians(deg)),
        )
        for deg in (-68, -48, -24, 0, 24, 48, 70, 90)
    ]
    r_outer = [
        (-0.0054, z0),
        (-0.0032, z0),
        (-0.0032, -0.0002),
        (-0.0011, -0.0002),
        (0.0038, -0.0078),
        (0.0064, -0.0078),
        (0.0015, 0.0001),
        *r_bowl_arc,
        (-0.0054, z1),
    ]
    r_hole = [
        (-0.0032, 0.0015),
        (-0.0032, 0.0035),
        *(
            (
                0.0004 + 0.0013 * math.cos(math.radians(deg)),
                0.0025 + 0.0010 * math.sin(math.radians(deg)),
            )
            for deg in (90, 55, 20, -20, -55, -90)
        ),
    ]

    i_outer = [
        (0.0053, z0),
        (0.0075, z0),
        (0.0075, z1),
        (0.0053, z1),
    ]

    n_outer = [
        (0.0094, z0),
        (0.0115, z0),
        (0.0115, 0.0018),
        (0.0164, z0),
        (0.0186, z0),
        (0.0186, z1),
        (0.0165, z1),
        (0.0165, -0.0004),
        (0.0116, z1),
        (0.0094, z1),
    ]

    g_outer = []
    for cx, cz, degs in (
        (0.0274, 0.0022, (16, 40, 65, 90)),
        (0.0234, 0.0022, (90, 120, 150, 180)),
        (0.0234, -0.0008, (180, 210, 240, 270)),
        (0.0274, -0.0008, (270, 300, 330, 360)),
    ):
        for idx, deg in enumerate(degs):
            if idx == 0 and g_outer:
                continue
            rad = math.radians(deg)
            g_outer.append((cx + 0.0030 * math.cos(rad), cz + 0.0030 * math.sin(rad)))
    g_outer.extend(
        [
            (0.0304, 0.0012),
            (0.0254, 0.0012),
            (0.0254, -0.0006),
            (0.0283, -0.0006),
        ]
    )
    for cx, cz, degs in (
        (0.0271, -0.0006, (340, 305, 270)),
        (0.0237, -0.0006, (270, 225, 180)),
        (0.0237, 0.0020, (180, 135, 90)),
        (0.0271, 0.0020, (90, 50, 14)),
    ):
        for idx, deg in enumerate(degs):
            if idx == 0 and deg in (270, 180, 90):
                continue
            rad = math.radians(deg)
            g_outer.append((cx + 0.0012 * math.cos(rad), cz + 0.0012 * math.sin(rad)))

    raw = [
        [w_outer],
        [a_outer, a_hole],
        [r_outer, r_hole],
        [i_outer],
        [n_outer],
        [g_outer],
    ]
    if scale == 1.0:
        return raw
    return [[[(x * scale, z * scale) for x, z in loop] for loop in comp] for comp in raw]


def arched_stadium_points(half_w, mid_half_h, end_half_h, arc_steps=16, span_steps=24):
    """Return CCW 2D points for the Waring arched stadium badge window."""
    r = end_half_h
    straight_hw = max(half_w - r, 1e-5)
    pts = []
    # Right end cap (-90 deg to +90 deg)
    for i in range(arc_steps + 1):
        ang = -0.5 * math.pi + math.pi * i / arc_steps
        pts.append((straight_hw + r * math.cos(ang), r * math.sin(ang)))
    # Top arch (+straight_hw -> -straight_hw)
    for i in range(1, span_steps):
        x = straight_hw - 2.0 * straight_hw * i / span_steps
        arch = (mid_half_h - end_half_h) * math.cos(0.5 * math.pi * x / straight_hw)
        pts.append((x, end_half_h + arch))
    # Left end cap (+90 deg to +270 deg)
    for i in range(arc_steps + 1):
        ang = 0.5 * math.pi + math.pi * i / arc_steps
        pts.append((-straight_hw + r * math.cos(ang), r * math.sin(ang)))
    # Bottom arch (-straight_hw -> +straight_hw)
    for i in range(1, span_steps):
        x = -straight_hw + 2.0 * straight_hw * i / span_steps
        arch = (mid_half_h - end_half_h) * math.cos(0.5 * math.pi * x / straight_hw)
        pts.append((x, -(end_half_h + arch)))
    return pts


def bake_wsg60_badge() -> bpy.types.Image:
    """Bake 768x256 diamond-knurled Waring front badge decal."""

    def add_Bake_comp(scn, name, loops, z, mat):
        vec_loops = [[Vector((u, v)) for u, v in lp] for lp in loops]
        tris = tessellate_polygon(vec_loops)
        flat_pts = [(u, v, z) for lp in loops for u, v in lp]
        m = bpy.data.meshes.new(name)
        m.from_pydata(flat_pts, [], tris)
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)
        return o

    def build_badge_sheet(scn, emit_mat, _font_jp, _font_en):
        m_chrome = emit_mat("chrome_rim", (0.30, 0.32, 0.35, 1.0))
        m_hi = emit_mat("silver_hi", (0.62, 0.65, 0.69, 1.0))
        m_sh = emit_mat("bevel_sh", (0.04, 0.045, 0.055, 1.0))
        m_bg = emit_mat("mesh_bg", (0.004, 0.005, 0.006, 1.0))
        m_knurl = emit_mat("mesh_knurl", (0.022, 0.025, 0.030, 1.0))
        m_moat = emit_mat("logo_moat", (0.003, 0.004, 0.005, 1.0))
        m_logo = emit_mat("logo_face", (0.72, 0.75, 0.79, 1.0))

        hw, hh = BADGE_INSERT_W * 0.5 + 0.001, BADGE_INSERT_H * 0.5 + 0.001
        outer_box = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]

        # Base dark field + diamond crosshatch lines behind arched cutout mask
        add_Bake_comp(scn, "bg_dark", [outer_box], 0.0005, m_bg)

        pitch = 0.0021
        half_bar = 0.00019
        span = 0.048
        for sign in (-1.0, 1.0):
            ang = math.radians(40.0 * sign)
            ca, sa = math.cos(ang), math.sin(ang)
            nx, ny = -sa, ca
            for idx in range(-28, 29):
                c = idx * pitch
                cx, cy = nx * c, ny * c
                pts = [
                    (cx - ca * span - nx * half_bar, cy - sa * span - ny * half_bar),
                    (cx + ca * span - nx * half_bar, cy + sa * span - ny * half_bar),
                    (cx + ca * span + nx * half_bar, cy + sa * span + ny * half_bar),
                    (cx - ca * span + nx * half_bar, cy - sa * span + ny * half_bar),
                ]
                add_Bake_comp(scn, f"kn_{sign}_{idx}", [pts], 0.0010, m_knurl)

        # Arched stadium cutout mask: satin silver corners outside the curved window
        inner_field = arched_stadium_points(0.0340, 0.0096, 0.0070)
        bevel_ring = arched_stadium_points(0.0346, 0.0102, 0.0076)
        silver_ring = arched_stadium_points(0.0358, 0.0113, 0.0087)

        add_Bake_comp(
            scn, "outer_chrome_mask", [outer_box, list(reversed(silver_ring))], 0.0020, m_chrome
        )
        add_Bake_comp(
            scn, "inner_silver_rim", [silver_ring, list(reversed(bevel_ring))], 0.0022, m_hi
        )
        add_Bake_comp(
            scn, "inner_dark_bevel", [bevel_ring, list(reversed(inner_field))], 0.0024, m_sh
        )

        # Smooth dark moat framing the WARING logotype & swept R tail
        moat_band = rounded_rectangle(0.0642, 0.0114, 0.0026, segments=8)
        moat_shifted = [(x, y + 0.0007) for x, y in moat_band]
        add_Bake_comp(scn, "wordmark_moat", [moat_shifted], 0.0028, m_moat)
        r_tail_moat = [
            (-0.0022, 0.0002),
            (0.0033, -0.0086),
            (0.0074, -0.0086),
            (0.0026, 0.0002),
        ]
        add_Bake_comp(scn, "r_tail_moat", [r_tail_moat], 0.0029, m_moat)

        for idx, comp in enumerate(waring_logo_components(1.0)):
            add_Bake_comp(scn, f"waring_glyph_{idx}", comp, 0.0035, m_logo)

    return bake_ortho_sheet(
        ASSETS / "wsg60-badge-decal.png",
        768,
        256,
        BADGE_INSERT_W,
        BADGE_INSERT_H,
        build_badge_sheet,
    )


def extrude_2d_components(
    name,
    components,
    thickness,
    position,
    surface,
    parent,
    plane="XZ",
    bevel=0.0,
):
    """Build a manifold extruded 3D mesh from 2D [outer_ccw, *holes_cw] components."""
    bm = bmesh.new()
    half_t = thickness * 0.5

    def to_3d(u, v, sign):
        if plane == "XZ":
            return (u, sign * half_t, v)
        return (u, v, sign * half_t)

    for comp in components:
        vec_loops = [[Vector((u, v)) for u, v in lp] for lp in comp]
        tris = tessellate_polygon(vec_loops)
        flat_uv = [(u, v) for lp in comp for u, v in lp]
        front_verts = [bm.verts.new(to_3d(u, v, -1.0)) for u, v in flat_uv]
        back_verts = [bm.verts.new(to_3d(u, v, 1.0)) for u, v in flat_uv]

        for ia, ib, ic in tris:
            if ia != ib and ib != ic and ia != ic:
                bm.faces.new((front_verts[ia], front_verts[ic], front_verts[ib]))
                bm.faces.new((back_verts[ia], back_verts[ib], back_verts[ic]))

        offset = 0
        for lp in comp:
            m = len(lp)
            for i in range(m):
                j = (i + 1) % m
                bm.faces.new(
                    (
                        front_verts[offset + i],
                        front_verts[offset + j],
                        back_verts[offset + j],
                        back_verts[offset + i],
                    )
                )
            offset += m

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = bpy.data.objects.new("_plate", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj = finish(obj, name, surface, parent, bevel)
    if not bevel:
        for poly in obj.data.polygons:
            if plane == "XZ":
                poly.use_smooth = abs(poly.normal.y) < 0.85
            else:
                poly.use_smooth = abs(poly.normal.z) < 0.85
    return obj


def rounded_plate(name, position, dimensions, corner_radius, surface, parent, plane="XZ", bevel=0.0003):
    if plane == "XZ":
        w, t, h = dimensions
    else:
        w, h, t = dimensions
    pts = list(reversed(rounded_rectangle(w, h, corner_radius, segments=8)))
    # Deduplicate seam vertices from rounded_rectangle corner endpoints
    dedup = []
    for pt in pts:
        if not dedup or math.hypot(pt[0] - dedup[-1][0], pt[1] - dedup[-1][1]) > 1e-6:
            dedup.append(pt)
    if len(dedup) > 1 and math.hypot(dedup[0][0] - dedup[-1][0], dedup[0][1] - dedup[-1][1]) <= 1e-6:
        dedup.pop()
    return extrude_2d_components(name, [[dedup]], t, position, surface, parent, plane=plane, bevel=bevel)


def curved_sleeve_pad(name, width_arc, height_z, z_center, r_in_offset, r_out_offset, surface, parent):
    """Build a dense curved quad-grid pad on the tapered sleeve so chords never dip inside ribs."""
    bm = bmesh.new()
    nu, nv = 28, 8

    def sleeve_pt(u_arc, v_z, radial_offset):
        z = z_center + v_z
        r = 0.0616 + (z - 0.047) * 0.059 + radial_offset
        phi = u_arc / max(r, 1e-4)
        return (r * math.sin(phi), -r * math.cos(phi), z)

    outer_grid = {}
    inner_grid = {}
    hw, hh = width_arc * 0.5, height_z * 0.5
    cr = 0.0020
    for iv in range(nv + 1):
        v = -hh + height_z * iv / nv
        for iu in range(nu + 1):
            u = -hw + width_arc * iu / nu
            # Softly round the 4 outer corners in (u, v)
            du = max(abs(u) - (hw - cr), 0.0)
            dv = max(abs(v) - (hh - cr), 0.0)
            dist = math.hypot(du, dv)
            if dist > cr and dist > 1e-8:
                u = math.copysign(hw - cr + du * cr / dist, u)
                v = math.copysign(hh - cr + dv * cr / dist, v)
            outer_grid[(iu, iv)] = bm.verts.new(sleeve_pt(u, v, r_out_offset))
            inner_grid[(iu, iv)] = bm.verts.new(sleeve_pt(u, v, r_in_offset))

    for iv in range(nv):
        for iu in range(nu):
            bm.faces.new(
                (
                    outer_grid[(iu, iv)],
                    outer_grid[(iu + 1, iv)],
                    outer_grid[(iu + 1, iv + 1)],
                    outer_grid[(iu, iv + 1)],
                )
            )
            bm.faces.new(
                (
                    inner_grid[(iu, iv)],
                    inner_grid[(iu, iv + 1)],
                    inner_grid[(iu + 1, iv + 1)],
                    inner_grid[(iu + 1, iv)],
                )
            )

    perim = (
        [(iu, 0) for iu in range(nu)]
        + [(nu, iv) for iv in range(nv)]
        + [(iu, nv) for iu in range(nu, 0, -1)]
        + [(0, iv) for iv in range(nv, 0, -1)]
    )
    for idx in range(len(perim)):
        k0 = perim[idx]
        k1 = perim[(idx + 1) % len(perim)]
        bm.faces.new((outer_grid[k0], inner_grid[k0], inner_grid[k1], outer_grid[k1]))

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = bpy.data.objects.new("_pad", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj = finish(obj, name, surface, parent, bevel=0.00018)
    return obj


def curved_sleeve_components(name, components, z_center, r_in_offset, r_out_offset, surface, parent):
    """Wrap 2D (x_arc, z_rel) components onto the tapered cool-touch sleeve cylinder."""
    bm = bmesh.new()

    def subdivide_loop(lp, max_step=0.0014):
        out = []
        m = len(lp)
        for i in range(m):
            u0, v0 = lp[i]
            u1, v1 = lp[(i + 1) % m]
            steps = max(1, math.ceil(math.hypot(u1 - u0, v1 - v0) / max_step))
            for s in range(steps):
                t = s / steps
                out.append((u0 + (u1 - u0) * t, v0 + (v1 - v0) * t))
        return out

    def sleeve_pt(u_arc, v_z, radial_offset):
        z = z_center + v_z
        r = 0.0616 + (z - 0.047) * 0.059 + radial_offset
        phi = u_arc / max(r, 1e-4)
        return (r * math.sin(phi), -r * math.cos(phi), z)

    for raw_comp in components:
        comp = [subdivide_loop(lp) for lp in raw_comp]
        vec_loops = [[Vector((u, v)) for u, v in lp] for lp in comp]
        tris = tessellate_polygon(vec_loops)
        flat_uv = [(u, v) for lp in comp for u, v in lp]
        outer_verts = [bm.verts.new(sleeve_pt(u, v, r_out_offset)) for u, v in flat_uv]
        inner_verts = [bm.verts.new(sleeve_pt(u, v, r_in_offset)) for u, v in flat_uv]

        for ia, ib, ic in tris:
            if ia != ib and ib != ic and ia != ic:
                bm.faces.new((outer_verts[ia], outer_verts[ic], outer_verts[ib]))
                bm.faces.new((inner_verts[ia], inner_verts[ib], inner_verts[ic]))

        offset = 0
        for lp in comp:
            m = len(lp)
            for i in range(m):
                j = (i + 1) % m
                bm.faces.new(
                    (
                        outer_verts[offset + i],
                        outer_verts[offset + j],
                        inner_verts[offset + j],
                        inner_verts[offset + i],
                    )
                )
            offset += m

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = bpy.data.objects.new("_curved", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj = finish(obj, name, surface, parent, bevel=0.0)
    for poly in obj.data.polygons:
        poly.use_smooth = abs(poly.normal.z) < 0.75
    return obj


def palette():
    ss_col, ss_orm = generate_stainless_hairline_textures(
        ASSETS,
        "wsg60",
        base_rgb=(0.74, 0.76, 0.79),
        streak_amp=0.045,
        rough_base=0.26,
        seed=6001,
    )
    badge_img = bake_wsg60_badge()
    surfaces = {
        "housing": textured_stainless_material(
            "WSG die-cast silver finish",
            ss_col,
            ss_orm,
            tint=(0.46, 0.48, 0.51, 1.0),
            metallic=0.89,
            roughness=0.27,
            coat=0.05,
        ),
        "steel": textured_stainless_material(
            "WSG satin stainless bowl",
            ss_col,
            ss_orm,
            tint=(0.60, 0.63, 0.66, 1.0),
            metallic=0.92,
            roughness=0.22,
            coat=0.06,
        ),
        "chrome": material("WSG polished edges", (0.76, 0.79, 0.82, 1.0), 0.95, 0.14),
        "black": material("WSG moulded polymer", (0.005, 0.006, 0.007, 1.0), 0.0, 0.32),
        "rubber": material(
            "WSG cool-touch sleeve", (0.009, 0.010, 0.012, 1.0), 0.0, 0.52
        ),
        "ink": material("WSG dark lettering", (0.003, 0.0035, 0.004, 1.0), 0.0, 0.42),
        "silver": material("WSG control face", (0.66, 0.68, 0.71, 1.0), 0.36, 0.28),
        "badge_decal": textured_decal_material(
            "WSG badge decal",
            badge_img,
            fallback_rgba=(0.008, 0.010, 0.012, 1.0),
            roughness=0.34,
            metallic=0.06,
            coat=0.05,
        ),
        "clear": material(
            "WSG clear operating cover", (0.92, 0.95, 0.97, 1.0), 0.0, 0.032
        ),
    }
    shader = surfaces["clear"].node_tree.nodes["Principled BSDF"]
    shader.inputs["Transmission Weight"].default_value = 1
    shader.inputs["IOR"].default_value = 1.49
    shader.inputs["Specular IOR Level"].default_value = 0.5
    surfaces["clear"]["status"] = "Estimated clear polymer optics, 2 mm visual wall"
    return surfaces


def label(name, value, position, size, surface, parent, front=False, extrude=0.00008):
    data = bpy.data.curves.new(name, "FONT")
    data.body = value
    data.font = load_latin_bold_font()
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = extrude
    data.resolution_u = 4
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    if front:
        obj.rotation_euler.x = math.pi / 2
    return finish(obj, name, surface, parent)


def ring(name, inner, outer, bottom, top, surface, parent, center=(0, 0, 0)):
    return lathe(
        name,
        [(inner, bottom), (outer, bottom), (outer, top), (inner, top), (inner, bottom)],
        center,
        surface,
        parent,
        128,
    )


def cut_well(housing):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=128, radius=0.052, depth=0.064, location=(0, BOWL_ORIGIN[1], 0.181)
    )
    cutter = bpy.context.object
    bpy.context.view_layer.objects.active = housing
    modifier = housing.modifiers.new("Removable bowl seating well", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.solver = "EXACT"
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def body(root, mat):
    loft_z(
        "Black base moulding",
        [
            (0.008, 0, 0, WIDTH - 0.003, DEPTH - 0.003, 0.033),
            (0.012, 0, 0, WIDTH, DEPTH, 0.034),
            (0.024, 0, 0, WIDTH, DEPTH, 0.034),
        ],
        mat["black"],
        root,
    )
    housing = loft_z(
        "Tapered die-cast motor housing",
        [
            (0.023, 0, 0, WIDTH, DEPTH, 0.034),
            (0.029, 0, 0, WIDTH, DEPTH, 0.034),
            (0.166, 0, 0.003, 0.153, 0.188, 0.037),
            (0.177, 0, 0.004, 0.151, 0.184, 0.038),
        ],
        mat["housing"],
        root,
    )
    cut_well(housing)
    ring(
        "Upper bowl seat",
        0.052,
        0.0748,
        0.176,
        0.184,
        mat["housing"],
        root,
        (0, BOWL_ORIGIN[1], 0),
    )
    ring(
        "Well liner",
        0.0498,
        0.0515,
        0.150,
        0.177,
        mat["black"],
        root,
        (0, BOWL_ORIGIN[1], 0),
    )
    cylinder(
        "Drive well floor", (0, BOWL_ORIGIN[1], 0.151), 0.050, 0.003, mat["black"], root
    )
    drive = empty("wsg_motor_coupling", (0, BOWL_ORIGIN[1], 0.155), root)
    cylinder("Motor coupling hub", (0, 0, 0), 0.017, 0.006, mat["black"], drive)
    for index in range(6):
        angle = index * math.tau / 6
        tooth = box(
            "Drive coupling tooth",
            (0.013 * math.cos(angle), 0.013 * math.sin(angle), 0.004),
            (0.007, 0.006, 0.006),
            mat["black"],
            drive,
            0.001,
        )
        tooth.rotation_euler.z = angle
    # The two photographed latch recesses are visual interface references.
    for x in (-0.056, 0.056):
        pocket = box(
            "Cover latch recess",
            (x, -0.036, 0.180),
            (0.007, 0.014, 0.002),
            mat["black"],
            root,
            0.002,
        )
        pocket.rotation_euler.z = math.copysign(-0.55, x)
    for x in (-0.061, 0.061):
        for y in (-0.073, 0.078):
            foot = empty(f"wsg_foot_{x}_{y}", (x, y, 0), root)
            cylinder("Rubber foot", (0, 0, 0.0045), 0.009, 0.009, mat["rubber"], foot)
    # Photo-derived lower ventilation recesses. Internal airflow is unmodeled.
    for x in (-0.082, 0.082):
        for index in range(7):
            box(
                "Lower ventilation recess",
                (x, -0.047 + index * 0.014, 0.014),
                (0.0008, 0.0045, 0.010),
                mat["ink"],
                root,
                0.001,
            )
    box(
        "Front base relief",
        (0, -0.10705, 0.018),
        (0.063, 0.002, 0.019),
        mat["black"],
        root,
        0.0015,
    )
    badge = empty("wsg_front_badge", (0, -0.0968, 0.132), root)
    badge.rotation_euler.x = math.radians(-7)
    rounded_plate(
        "Chrome badge border",
        (0, 0, 0),
        (0.083, 0.0025, 0.032),
        0.0046,
        mat["chrome"],
        badge,
        plane="XZ",
        bevel=0.0004,
    )
    rounded_plate(
        "Black badge insert",
        (0, -0.00115, 0),
        (BADGE_INSERT_W, 0.0008, BADGE_INSERT_H),
        0.0036,
        mat["badge_decal"],
        badge,
        plane="XZ",
        bevel=0.00018,
    )
    extrude_2d_components(
        "Waring motor badge",
        waring_logo_components(1.0),
        0.00036,
        (0, -0.00168, 0),
        mat["chrome"],
        badge,
        plane="XZ",
        bevel=0.0,
    )
    empty("wsg_bowl_seat", BOWL_ORIGIN, root)
    return drive


def controls(root, mat):
    buttons = []
    for name, value, x, angle, text_size in (
        ("wsg_start_stop_button", "START/STOP", -0.050, -0.35, 0.0037),
        ("wsg_pulse_button", "PULSE", 0.050, 0.35, 0.0041),
    ):
        control = empty(name, (x, -0.068, 0.1773), root)
        control.rotation_euler.z = angle
        rounded_plate(
            "Button outline",
            (0, 0, 0),
            (0.038, 0.013, 0.0012),
            0.0038,
            mat["black"],
            control,
            plane="XY",
            bevel=0.00022,
        )
        rounded_plate(
            "Membrane button face",
            (0, 0, 0.00035),
            (0.0346, 0.0096, 0.0010),
            0.0028,
            mat["silver"],
            control,
            plane="XY",
            bevel=0.00018,
        )
        label(
            value + " lettering",
            value,
            (0, 0, 0.00095),
            text_size,
            mat["ink"],
            control,
            extrude=0.00008,
        )
        buttons.append(control)
    return buttons


def blade(bowl, mat):
    rotor = empty("wsg_blade", (0, 0, 0.047), bowl)
    cylinder("Blade shaft", (0, 0, -0.012), 0.004, 0.027, mat["chrome"], rotor)
    cylinder("Blade centre boss", (0, 0, 0), 0.011, 0.005, mat["chrome"], rotor)
    cylinder("Blade retaining cap", (0, 0, 0.003), 0.006, 0.002, mat["steel"], rotor)
    for index in range(4):
        angle = math.radians(25 + index * 90)
        # Four swept blade arms, with two raised ends, follow the parts drawing.
        rise = 0.018 if index % 2 == 0 else -0.007
        plan = [
            (0.007, -0.004, 0),
            (0.032, -0.003, 0.001),
            (0.049, 0.008, rise),
            (0.047, 0.014, rise + 0.001),
            (0.028, 0.005, 0.003),
            (0.007, 0.005, 0.002),
        ]
        vertices = []
        for layer in (0, 0.0011):
            for x, y, z in plan:
                vertices.append(
                    (
                        x * math.cos(angle) - y * math.sin(angle),
                        x * math.sin(angle) + y * math.cos(angle),
                        z + layer,
                    )
                )
        count = len(plan)
        faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
        for i in range(count):
            j = (i + 1) % count
            faces.append((i, j, count + j, count + i))
        mesh_object(
            "Swept grinding blade", vertices, faces, mat["steel"], rotor, 0.0003
        )
    rotor["status"] = (
        "Photo-estimated blade shape; no cutting or calibrated RPM simulation"
    )
    return rotor


def bowl_assembly(root, mat):
    bowl = empty("wsg_bowl", BOWL_ORIGIN, root)
    bowl["source_part"] = "035138 assembly / 037365 bowl / 037362 blade"
    ring("Bowl pedestal", 0.024, 0.044, 0.001, 0.033, mat["black"], bowl)
    cylinder("Bowl coupling", (0, 0, 0.005), 0.020, 0.009, mat["black"], bowl)
    profile = [
        (0, 0.028),
        (0.036, 0.028),
        (0.044, 0.031),
        (0.052, 0.035),
        (0.058, 0.042),
        (0.060, 0.053),
        (0.064, 0.111),
        (0.066, 0.118),
        (0.0665, 0.120),
        (0.066, 0.122),
        (0.064, 0.122),
        (0.063, 0.118),
        (0.062, 0.110),
        (0.058, 0.054),
        (0.055, 0.045),
        (0.049, 0.039),
        (0.040, 0.035),
        (0, 0.035),
    ]
    lathe("Hollow stainless grinding bowl", profile, (0, 0, 0), mat["steel"], bowl, 160)
    tube(
        "Rolled stainless rim",
        arc_points(0.0652, 0.121),
        0.001,
        mat["chrome"],
        bowl,
        cyclic=True,
    )
    lathe(
        "Cool-touch sleeve",
        [
            (0.058, 0.047),
            (0.0615, 0.047),
            (0.065, 0.104),
            (0.063, 0.106),
            (0.058, 0.047),
        ],
        (0, 0, 0),
        mat["rubber"],
        bowl,
        160,
    )
    for i in range(25):
        z = 0.049 + i * 0.0022
        radius = 0.0616 + (z - 0.047) * 0.059
        tube(
            "Sleeve grip rib",
            arc_points(radius, z),
            0.00055,
            mat["rubber"],
            bowl,
            cyclic=True,
        )
    curved_sleeve_pad(
        "Sleeve wordmark pad",
        0.044,
        0.0132,
        0.0778,
        -0.0004,
        0.00070,
        mat["rubber"],
        bowl,
    )
    curved_sleeve_components(
        "Sleeve embossed wordmark",
        waring_logo_components(0.62),
        0.0778,
        0.00062,
        0.00118,
        mat["black"],
        bowl,
    )
    for i in range(3):
        angle = i * math.tau / 3
        tab = box(
            "Bowl locking tab",
            (0.044 * math.cos(angle), 0.044 * math.sin(angle), 0.009),
            (0.006, 0.011, 0.003),
            mat["black"],
            bowl,
            0.001,
        )
        tab.rotation_euler.z = angle
    empty("wsg_bowl_contents", (0, 0, 0.07), bowl)
    rotor = blade(bowl, mat)
    return bowl, rotor


def cover_assembly(root, mat):
    cover = empty("wsg_cover", COVER_ORIGIN, root)
    cover["source_part"] = "035137 cover and 037898 O-ring"
    cover["preview_unlock_degrees"] = 18
    profile = [
        (0.071, 0),
        (0.0755, 0),
        (0.0755, 0.007),
        (0.0735, 0.010),
        (0.0715, 0.102),
        (0.071, 0.108),
        (0.068, 0.111),
        (0.058, 0.1121),
        (0, 0.1121),
        (0, 0.1101),
        (0.057, 0.1101),
        (0.0665, 0.109),
        (0.069, 0.106),
        (0.0695, 0.101),
        (0.0715, 0.010),
        (0.071, 0.007),
        (0.071, 0),
    ]
    lathe(
        "Clear closed-top operating cover", profile, (0, 0, 0), mat["clear"], cover, 160
    )
    tube(
        "Cover moulded upper rim",
        arc_points(0.070, 0.108),
        0.0014,
        mat["clear"],
        cover,
        cyclic=True,
    )
    tube(
        "Cover O-ring",
        arc_points(0.0715, 0.003),
        0.001,
        mat["rubber"],
        cover,
        cyclic=True,
    )
    for x in (-0.055, 0.055):
        tab = box(
            "Cover bayonet tab",
            (x, -0.044, 0.001),
            (0.007, 0.010, 0.003),
            mat["clear"],
            cover,
            0.001,
        )
        tab.rotation_euler.z = math.copysign(-0.55, x)
    label(
        "Cover lock marking",
        "LOCK  <-->  UNLOCK",
        (0, -0.0757, 0.0042),
        0.0037,
        mat["ink"],
        cover,
        True,
    )
    return cover


def storage_lid(mat):
    lid = empty("wsg_storage_lid", (0, 0, 0))
    lid["source_part"] = "035139 storage lid; remove before operation"
    lathe(
        "Storage lid moulding",
        [
            (0, 0.003),
            (0.061, 0.003),
            (0.061, 0),
            (0.067, 0),
            (0.068, 0.002),
            (0.068, 0.007),
            (0.067, 0.009),
            (0.061, 0.009),
            (0.057, 0.006),
            (0, 0.006),
        ],
        (0, 0, 0),
        mat["black"],
        lid,
        128,
    )
    extrude_2d_components(
        "Storage lid embossed wordmark",
        waring_logo_components(0.72),
        0.00045,
        (0, 0, 0.00615),
        mat["rubber"],
        lid,
        plane="XY",
        bevel=0.0,
    )
    return lid


def power_lead(root, mat):
    lead = empty("wsg_power_lead", (0, 0, 0), root)
    cylinder(
        "Cord strain relief",
        (0.023, 0.102, 0.047),
        0.006,
        0.023,
        mat["black"],
        lead,
        "Y",
    )
    points = [
        (0.023, 0.11, 0.047),
        (0.025, 0.14, 0.025),
        (0.05, 0.16, 0.004),
        (0.15, 0.17, 0.004),
        (0.18, 0.13, 0.004),
        (0.16, 0.075, 0.004),
        (0.11, 0.085, 0.004),
        (0.10, 0.145, 0.005),
        (0.16, 0.165, 0.005),
        (0.20, 0.12, 0.005),
        (0.21, 0.06, 0.008),
    ]
    tube("Stowed power cable", points, 0.003, mat["black"], lead, smooth=True)
    plug = empty("wsg_nema_5_15p", (0.21, 0.045, 0.011), lead)
    box("Plug moulding", (0, 0, 0), (0.027, 0.033, 0.018), mat["black"], plug, 0.005)
    for x in (-0.0064, 0.0064):
        box(
            "Plug flat pin",
            (x, -0.024, 0.003),
            (0.0015, 0.017, 0.006),
            mat["steel"],
            plug,
            0.0003,
        )
    cylinder(
        "Plug ground pin", (0, -0.024, -0.004), 0.0024, 0.019, mat["steel"], plug, "Y"
    )
    lead["status"] = (
        "Illustrative shortened stowed route. Published cord length is 5 ft."
    )
    return lead


def finish_revolved_surfaces():
    for name in (
        "Clear closed-top operating cover",
        "Hollow stainless grinding bowl",
        "Storage lid moulding",
    ):
        obj = bpy.data.objects[name]
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0000001)
        bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        for face in obj.data.polygons:
            face.use_smooth = abs(face.normal.z) < 0.995


def finalize_meshes_and_uvs(scene, root, lid):
    """Apply bevel/weld modifiers on UV-mapped meshes, verify clean triangles, and project UVs."""
    scene.frame_set(1)
    bpy.context.view_layer.update()
    stainless_mats = {"WSG die-cast silver finish", "WSG satin stainless bowl"}
    all_objs = [
        obj
        for obj in (*root.children_recursive, *lid.children_recursive)
        if obj.type == "MESH"
    ]

    for obj in all_objs:
        mat_name = obj.data.materials[0].name if obj.data.materials and obj.data.materials[0] else ""
        if mat_name in stainless_mats or obj.name == "Black badge insert":
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            for mod in list(obj.modifiers):
                if mod.type in {"BEVEL", "WELD"}:
                    bpy.ops.object.modifier_apply(modifier=mod.name)

    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in all_objs:
        eval_obj = obj.evaluated_get(depsgraph)
        emesh = eval_obj.to_mesh()
        needs_clean = False
        try:
            emesh.calc_loop_triangles()
            pts = [obj.matrix_world @ v.co for v in emesh.vertices]
            keys = [tuple(round(val, 8) for val in pt) for pt in pts]
            seen = set()
            for tri in emesh.loop_triangles:
                ia, ib, ic = tri.vertices
                if (pts[ib] - pts[ia]).cross(pts[ic] - pts[ia]).length <= 1e-15:
                    needs_clean = True
                    break
                fkey = tuple(sorted((keys[ia], keys[ib], keys[ic])))
                if fkey in seen or len({keys[ia], keys[ib], keys[ic]}) < 3:
                    needs_clean = True
                    break
                seen.add(fkey)
            if needs_clean:
                mats = list(obj.data.materials)
                clean_verts = [tuple(v.co) for v in emesh.vertices]
                clean_faces = []
                seen_faces = set()
                for tri in emesh.loop_triangles:
                    ia, ib, ic = tri.vertices
                    if (pts[ib] - pts[ia]).cross(pts[ic] - pts[ia]).length <= 1e-15:
                        continue
                    fkey = tuple(sorted((keys[ia], keys[ib], keys[ic])))
                    if fkey in seen_faces or len({keys[ia], keys[ib], keys[ic]}) < 3:
                        continue
                    seen_faces.add(fkey)
                    clean_faces.append((ia, ib, ic))
                if clean_faces:
                    obj.modifiers.clear()
                    new_mesh = bpy.data.meshes.new(obj.name)
                    new_mesh.from_pydata(clean_verts, [], clean_faces)
                    for m in mats:
                        new_mesh.materials.append(m)
                    for poly in new_mesh.polygons:
                        poly.use_smooth = True
                    new_mesh.update()
                    old_mesh = obj.data
                    obj.data = new_mesh
                    if old_mesh.users == 0:
                        bpy.data.meshes.remove(old_mesh)
        finally:
            eval_obj.to_mesh_clear()

    bpy.context.view_layer.update()
    for obj in all_objs:
        mat_name = obj.data.materials[0].name if obj.data.materials and obj.data.materials[0] else ""
        if mat_name in stainless_mats:
            project_stainless_uvs(obj, scale=3.2)

    project_front_planar_uvs(
        bpy.data.objects["Black badge insert"],
        0.0,
        0.0,
        BADGE_INSERT_W,
        BADGE_INSERT_H,
        local_space=True,
    )


def export(root, filename):
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


def organize(root, lid):
    for name, objects in (
        ("WSG60 appliance", (root, *root.children_recursive)),
        ("Storage lid accessory - hidden", (lid, *lid.children_recursive)),
    ):
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
        for obj in objects:
            for owner in list(obj.users_collection):
                owner.objects.unlink(obj)
            collection.objects.link(obj)
        if name.startswith("Storage"):
            collection.hide_render = True
            collection.hide_viewport = True
    collection = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(collection)
    for index, name in enumerate(
        (
            "manufacturer-01.jpg",
            "manufacturer-05.webp",
            "manufacturer-06.webp",
            "dimensioned-sheet.png",
            "parts-diagram.png",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        collection.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.5
        obj.location = (index * 0.6, 1, 0.3)
        obj.rotation_euler.x = math.pi / 2
    collection.hide_render = True
    collection.hide_viewport = True


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for dev in prefs.devices:
            dev.use = dev.type in {"METAL", "GPU"}
        scene.cycles.device = "GPU"
    except Exception:
        pass
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.transmission_bounces = 12
    scene.cycles.transparent_max_bounces = 12
    scene.cycles.glossy_bounces = 8
    scene.cycles.max_bounces = 16
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1500
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    setup_softbox_world(scene, "WSG neutral studio", camera_bg_rgb=(0.68, 0.71, 0.75))
    before = set(scene.objects)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("WSG studio floor", (0.24, 0.26, 0.28, 1.0), roughness=0.86)
    )
    area_light("Left softbox", (-0.82, -0.32, 0.74), (0, 0, 0.16), 62, 0.58)
    area_light("Right edge strip", (0.82, -0.22, 0.60), (0, 0, 0.16), 48, 0.40)
    area_light("Rear softbox", (-0.10, 0.80, 0.84), (0, 0, 0.17), 56, 0.58)
    area_light("Front fill softbox", (0.0, -0.95, 0.30), (0, 0, 0.14), 16, 0.55)
    bpy.data.objects["Front fill softbox"].visible_glossy = False
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


def render_views(camera, bowl, cover, lid):
    render(camera, "studio-main", (0.48, -0.72, 0.46), (0.035, 0.014, 0.144), 0.49)
    render(camera, "studio-front", (0, -2, 0.146), (0, 0, 0.146), 0.35)
    render(camera, "studio-right", (2, 0, 0.145), (0, 0, 0.145), 0.36)
    cover.location.x += 0.4
    render(camera, "studio-bowl", (0.16, -0.24, 0.72), (0, 0.008, 0.225), 0.25)
    cover.rotation_euler.z = math.radians(18)
    cover.location = (0.185, -0.12, 0.002)
    bowl.location = (-0.16, -0.025, 0.002)
    accessories = bpy.data.collections["Storage lid accessory - hidden"]
    accessories.hide_render = False
    accessories.hide_viewport = False
    lid.location = (-0.13, -0.16, 0.002)
    render(camera, "studio-disassembled", (0.58, -0.95, 0.69), (0, -0.035, 0.105), 0.64)
    accessories.hide_render = True
    accessories.hide_viewport = True
    lid.location = (0, 0, 0)
    cover.location = COVER_ORIGIN
    cover.rotation_euler.z = 0
    bowl.location = BOWL_ORIGIN


def animate(bowl, cover, rotor, buttons):
    scene = bpy.context.scene
    for frame, unlock, cover_lift, bowl_lift in (
        (1, 0, 0, 0),
        (20, 18, 0, 0),
        (40, 18, 0.16, 0),
        (65, 18, 0.16, 0.09),
        (85, 18, 0.16, 0),
        (105, 18, 0, 0),
        (120, 0, 0, 0),
    ):
        cover.rotation_euler.z = math.radians(unlock)
        cover.location.z = COVER_ORIGIN[2] + cover_lift
        bowl.location.z = BOWL_ORIGIN[2] + bowl_lift
        cover.keyframe_insert(data_path="rotation_euler", frame=frame)
        cover.keyframe_insert(data_path="location", frame=frame)
        bowl.keyframe_insert(data_path="location", frame=frame)
    for frame, angle, press in (
        (1, 0, 0),
        (120, 0, 0),
        (125, 0, -0.0005),
        (130, 0, 0),
        (155, 180, 0),
        (180, 360, 0),
    ):
        rotor.rotation_euler.z = math.radians(angle)
        buttons[1].location.z = 0.1773 + press
        rotor.keyframe_insert(data_path="rotation_euler", frame=frame)
        buttons[1].keyframe_insert(data_path="location", frame=frame)
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
    scene.name = "Waring WSG60 - drawing-based visual prototype"
    scene.unit_settings.system = "METRIC"
    root = empty("wsg_grinder", (0, 0, 0))
    root["model"] = "Waring WSG60, US 120 V / 60 Hz / 750 W"
    root["dimensions_status"] = (
        "Drawing 165.1 x 215.9 x 292.1 mm; webpage swaps width/depth"
    )
    root["physics_status"] = (
        "Visual prototype only; interlocks and grinding process pending"
    )
    mat = palette()
    body(root, mat)
    buttons = controls(root, mat)
    bowl, rotor = bowl_assembly(root, mat)
    cover = cover_assembly(root, mat)
    lid = storage_lid(mat)
    lead = power_lead(root, mat)
    finish_revolved_surfaces()
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    finalize_meshes_and_uvs(scene, root, lid)
    export(root, "waring-wsg60.glb")
    bowl.parent = None
    bowl.location = (0, 0, 0)
    export(bowl, "waring-wsg60-bowl.glb")
    bowl.parent = root
    bowl.location = BOWL_ORIGIN
    export(lid, "waring-wsg60-storage-lid.glb")
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    report = {
        "status": "Studio-polished visual prototype",
        "drawing_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": list(high - low),
        "dimension_conflict": "Product page and 2025 graphic swap drawing width/depth",
        "sources": [
            "Specification 19WC061076 REV 04/19",
            "Parts REV01 12/30/25",
            "Manufacturer 2025 photographs",
        ],
        "assumptions": [
            "Bowl profile, blade shape, couplings and latches inferred from images",
            "18 degree cover unlock and 90 mm bowl lift are visual previews",
            "Glass optics, sheet thickness, controls and cord route are estimates",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "waring-wsg60.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    organize(root, lid)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, bowl, cover, lid)
    animate(bowl, cover, rotor, buttons)
    camera.location = (0.48, -0.72, 0.46)
    camera.data.ortho_scale = 0.49
    look_at(camera, (0.035, 0.014, 0.144))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "waring-wsg60.blend"))
    for temp_name in TEMP_TEXTURE_FILES:
        (ASSETS / temp_name).unlink(missing_ok=True)
    print("Saved Waring WSG60 visual prototype", ASSETS)


if __name__ == "__main__":
    main()
