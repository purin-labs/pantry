"""Build the OPTION-O LAGOM casa Conical Burr Grinder visual prototype.

Metres, Z up, front -Y. Published envelope: 90 x 215 x 275 mm (W x D x H),
mass 3.5 kg, Mizen 65CL conical burrs, stepless hopper collar, chute clicker,
side auto-grind button, and magnetic 58 mm-stepped dosing catch cup.
Component wall thicknesses, internal burr flutes, and travel limits are
photo- and manual-derived estimates.
"""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_surface_kit import (
    _write_rgba_png,
    bake_ortho_sheet,
    generate_stainless_hairline_textures,
    project_stainless_uvs,
    setup_softbox_world,
    textured_stainless_material,
)
from build_mixer_visuals import arc_points, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    tube,
)
from inspect_induction import bounds

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/option-o-lagom-casa"
REFERENCES = REPOSITORY / "docs/equipment/option-o-lagom-casa/images"

WIDTH, DEPTH, HEIGHT = 0.0900, 0.2150, 0.2750
GRIND_AXIS_Y = -0.0545
PILLAR_AXIS_Y = 0.0455
MOTOR_AXIS_Z = 0.1520
CUP_ORIGIN = (0.0, GRIND_AXIS_Y, 0.0380)
HOPPER_ORIGIN = (0.0, GRIND_AXIS_Y, 0.2255)
CLICKER_ORIGIN = (0.0, -0.0975, 0.2090)
POWER_BTN_ORIGIN = (-0.0442, -0.0520, 0.0195)
BURR_CARRIER_ORIGIN = (0.0, GRIND_AXIS_Y, 0.1760)
BURR_CONE_ORIGIN = (0.0, GRIND_AXIS_Y, 0.1720)


COLLAR_RADIUS = 0.0400
COLLAR_CIRCUMFERENCE = math.tau * COLLAR_RADIUS
COLLAR_RES_X = 2048
COLLAR_RES_Y = 512
COLLAR_SHEET_H = COLLAR_CIRCUMFERENCE * (COLLAR_RES_Y / COLLAR_RES_X)
# Place UV seam at exact lathe ring vertex index 7 (26.25 deg), safely between digits 4 (18 deg) and 3 (54 deg)
COLLAR_ANG_ORIGIN = 7 * (math.tau / 96)

TEMP_TEXTURE_FILES = (
    "casa-stainless-hl.png",
    "casa-stainless-orm.png",
    "casa-hopper-collar-mask.png",
    "casa-hopper-collar-hl.png",
    "casa-hopper-collar-orm.png",
)


def _load_collar_digit_font(fallback_font: bpy.types.VectorFont) -> bpy.types.VectorFont:
    for candidate in (
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        p = Path(candidate)
        if p.exists():
            return bpy.data.fonts.load(str(p), check_existing=True)
    return fallback_font


def bake_hopper_collar_textures(
    col_img: bpy.types.Image,
    orm_img: bpy.types.Image,
) -> tuple[bpy.types.Image, bpy.types.Image]:
    """Bake laser-etched 0-9 grind scale numerals onto seamless bead-blasted 6061 collar maps."""
    mask_path = ASSETS / "casa-hopper-collar-mask.png"

    def build_collar_mask(bake_scene, emit_mat, _font_jp, font_en):
        m_white = emit_mat("collar_bg_white", (1.0, 1.0, 1.0, 1.0))
        m_black = emit_mat("collar_fg_black", (0.0, 0.0, 0.0, 1.0))

        bg_mesh = bpy.data.meshes.new("_collar_mask_bg")
        hw = COLLAR_CIRCUMFERENCE * 0.55
        hh = COLLAR_SHEET_H * 0.55
        bg_mesh.from_pydata(
            [(-hw, -hh, -0.002), (hw, -hh, -0.002), (hw, hh, -0.002), (-hw, hh, -0.002)],
            [],
            [(0, 1, 2, 3)],
        )
        bg_mesh.update()
        bg_obj = bpy.data.objects.new("_collar_mask_bg", bg_mesh)
        bg_obj.data.materials.append(m_white)
        bake_scene.collection.objects.link(bg_obj)

        digit_font = _load_collar_digit_font(font_en)
        # Major dots sit at z_local = 0.0028 m (top edge 0.0039 m).
        # Place digit baseline at z_local = 0.0052 m with ~3.3 mm cap height (centered at z_local = 0.0068 m).
        y_baseline = -0.5 * COLLAR_SHEET_H + 0.0052
        for step in range(0, 50, 5):
            ang = -math.pi / 2 + (step - 35) * (math.tau / 50)
            # Matches manufacturer-01.webp (9, 8, 7 across -X to -Y), manufacturer-02.webp (8, 7, 6),
            # and japan-main.jpg (6, 5, 4, 3 across +X from -Y to +Y), with clockwise = finer.
            digit = (14 - step // 5) % 10
            u = ((ang - COLLAR_ANG_ORIGIN) % math.tau) / math.tau
            x_pos = (u - 0.5) * COLLAR_CIRCUMFERENCE

            curve = bpy.data.curves.new(f"_collar_digit_{digit}", "FONT")
            curve.body = str(digit)
            curve.font = digit_font
            curve.size = 0.0047
            curve.offset = 0.000055
            curve.align_x = "CENTER"
            curve.align_y = "BOTTOM_BASELINE"
            txt_obj = bpy.data.objects.new(f"_collar_digit_{digit}", curve)
            txt_obj.location = (x_pos, y_baseline, 0.001)
            txt_obj.data.materials.append(m_black)
            bake_scene.collection.objects.link(txt_obj)

    mask_img = bake_ortho_sheet(
        mask_path,
        COLLAR_RES_X,
        COLLAR_RES_Y,
        COLLAR_CIRCUMFERENCE,
        COLLAR_SHEET_H,
        build_collar_mask,
    )
    mask_img.colorspace_settings.name = "Non-Color"
    mask_topdown = np.array(mask_img.pixels[:], dtype=np.float32).reshape(
        (COLLAR_RES_Y, COLLAR_RES_X, 4)
    )[::-1, :, 0]
    etch = np.clip(1.0 - mask_topdown, 0.0, 1.0)[:, :, None]
    bpy.data.images.remove(mask_img)
    mask_path.unlink(missing_ok=True)

    # Sample the 512x512 seamless anodized grain at matching 1:1 physical scale across 251.3 x 62.8 mm
    col_img.colorspace_settings.name = "Non-Color"
    base_col_topdown = np.array(col_img.pixels[:], dtype=np.float32).reshape((512, 512, 4))[::-1, :, :]
    col_img.colorspace_settings.name = "sRGB"
    base_orm_topdown = np.array(orm_img.pixels[:], dtype=np.float32).reshape((512, 512, 4))[::-1, :, :]

    xs = np.linspace(0.0, 512.0, COLLAR_RES_X, endpoint=False, dtype=np.float32)
    ys = np.linspace(0.0, 128.0, COLLAR_RES_Y, endpoint=False, dtype=np.float32)
    x0 = np.floor(xs).astype(np.int32) % 512
    x1 = (x0 + 1) % 512
    wx = (xs - np.floor(xs))[None, :, None]
    y0 = np.floor(ys).astype(np.int32) % 512
    y1 = (y0 + 1) % 512
    wy = (ys - np.floor(ys))[:, None, None]

    collar_col = (
        (1.0 - wy) * ((1.0 - wx) * base_col_topdown[y0][:, x0] + wx * base_col_topdown[y0][:, x1])
        + wy * ((1.0 - wx) * base_col_topdown[y1][:, x0] + wx * base_col_topdown[y1][:, x1])
    )
    collar_orm = (
        (1.0 - wy) * ((1.0 - wx) * base_orm_topdown[y0][:, x0] + wx * base_orm_topdown[y0][:, x1])
        + wy * ((1.0 - wx) * base_orm_topdown[y1][:, x0] + wx * base_orm_topdown[y1][:, x1])
    )

    # Darken Base Color and roughen laser-etched numerals while keeping un-etched silver 100% identical
    etch_rgb = np.array([0.025, 0.026, 0.028], dtype=np.float32)[None, None, :]
    collar_col[:, :, :3] = collar_col[:, :, :3] * (1.0 - etch) + etch_rgb * etch
    collar_col[:, :, 3] = 1.0
    collar_orm[:, :, 1] = np.clip(collar_orm[:, :, 1] * (1.0 - etch[:, :, 0]) + 0.58 * etch[:, :, 0], 0.14, 0.62)

    col_collar_img = _write_rgba_png(ASSETS / "casa-hopper-collar-hl.png", collar_col, "sRGB")
    orm_collar_img = _write_rgba_png(ASSETS / "casa-hopper-collar-orm.png", collar_orm, "Non-Color")
    return col_collar_img, orm_collar_img


def project_hopper_collar_uvs(obj: bpy.types.Object) -> None:
    """Assign seam-safe cylindrical UVs on the R=40 mm outer wall and un-etched grain UVs elsewhere."""
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        is_outer_wall = (
            abs(poly.normal.z) < 0.35
            and all(
                math.hypot(mesh.vertices[vi].co.x, mesh.vertices[vi].co.y) > 0.0396
                for vi in poly.vertices
            )
        )
        if is_outer_wall:
            c = poly.center
            ang_poly = math.atan2(c.y, c.x)
            u_poly = ((ang_poly - COLLAR_ANG_ORIGIN) % math.tau) / math.tau
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                ang_v = math.atan2(co.y, co.x)
                d_ang = math.atan2(math.sin(ang_v - ang_poly), math.cos(ang_v - ang_poly))
                u = u_poly + d_ang / math.tau
                v = co.z / COLLAR_SHEET_H
                uv_layer.data[loop_idx].uv = (u, v)
        else:
            for loop_idx in poly.loop_indices:
                co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
                u = (0.5 + co.x * 3.6) % 1.0
                v = 0.84 + 0.12 * ((0.5 + co.y * 3.6) % 1.0)
                uv_layer.data[loop_idx].uv = (u, v)


def palette():
    col_img, orm_img = generate_stainless_hairline_textures(
        ASSETS,
        "casa",
        base_rgb=(0.72, 0.72, 0.73),
        streak_amp=0.009,
        rough_base=0.29,
        seed=6501,
    )
    col_collar_img, orm_collar_img = bake_hopper_collar_textures(col_img, orm_img)
    surfaces = {
        "anodised_silver": textured_stainless_material(
            "Casa space-grade 6061 anodised silver",
            col_img,
            orm_img,
            tint=(0.45, 0.44, 0.42, 1.0),
            metallic=0.88,
            roughness=0.29,
            coat=0.05,
        ),
        "hopper_collar": textured_stainless_material(
            "Casa laser-etched hopper collar",
            col_collar_img,
            orm_collar_img,
            tint=(0.45, 0.44, 0.42, 1.0),
            metallic=0.88,
            roughness=0.29,
            coat=0.05,
        ),
        "machined_alloy": textured_stainless_material(
            "Casa CNC satin aluminium",
            col_img,
            orm_img,
            tint=(0.53, 0.52, 0.50, 1.0),
            metallic=0.92,
            roughness=0.21,
            coat=0.06,
        ),
        "burr_steel": textured_stainless_material(
            "Mizen 65CL hardened burr steel",
            col_img,
            orm_img,
            tint=(0.35, 0.35, 0.36, 1.0),
            metallic=0.93,
            roughness=0.23,
            coat=0.04,
        ),
        "dark_anodised": material(
            "Casa dark anodised trim",
            (0.010, 0.011, 0.013, 1.0),
            0.45,
            0.38,
        ),
        "ink": material(
            "Casa laser-etched dial markings",
            (0.005, 0.006, 0.007, 1.0),
            0.05,
            0.40,
        ),
        "rubber": material(
            "Casa silicone anti-slip base pad",
            (0.018, 0.020, 0.022, 1.0),
            0.0,
            0.55,
        ),
    }
    return surfaces


def expand_profile_with_support_loops(profile, guard=0.0002, max_span=0.0080):
    """Insert co-linear support loops near corners so smooth vertex normals stay pure on walls."""
    if len(profile) < 2:
        return list(profile)
    expanded = [profile[0]]
    for idx in range(len(profile) - 1):
        r0, z0 = profile[idx]
        r1, z1 = profile[idx + 1]
        dr = r1 - r0
        dz = z1 - z0
        dist = math.hypot(dr, dz)
        if dist > 4.0 * guard:
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
    # Remove any zero-area or duplicate faces
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


def stadium_points(half_width, y_front_center, y_rear_center, arc_steps=36, side_steps=16):
    """Closed 2D stadium contour in XY with evenly spaced straight sides and arcs."""
    pts = []
    # Rear semicircle (+Y) from angle 0 to pi
    for i in range(arc_steps):
        a = math.pi * i / arc_steps
        pts.append((half_width * math.cos(a), y_rear_center + half_width * math.sin(a)))
    # Left straight side (-X) from y_rear_center to y_front_center
    # Slightly recess the straight -X wall around y=-0.052 by 0.6 mm so the side button bezel sits proud without z-fighting
    for i in range(side_steps):
        t = i / side_steps
        y_val = y_rear_center + (y_front_center - y_rear_center) * t
        recess = 0.0006 if (half_width >= 0.0440 and -0.062 <= y_val <= -0.042) else 0.0
        pts.append((-half_width + recess, y_val))
    # Front semicircle (-Y) from angle pi to 2*pi
    for i in range(arc_steps):
        a = math.pi + math.pi * i / arc_steps
        pts.append((half_width * math.cos(a), y_front_center + half_width * math.sin(a)))
    # Right straight side (+X) from y_front_center to y_rear_center
    for i in range(side_steps):
        t = i / side_steps
        pts.append((half_width, y_front_center + (y_rear_center - y_front_center) * t))
    return pts


def build_stadium_base(root, mat):
    """Build the 90 x 182 x 39.5 mm stadium base with recessed top deck and cup well."""
    y_front = -0.1075 + 0.0450  # -0.0625
    y_rear = 0.0745 - 0.0450  # +0.0295
    outer_45 = stadium_points(0.0450, y_front, y_rear, arc_steps=36, side_steps=16)
    outer_bevel = stadium_points(0.0442, y_front, y_rear, arc_steps=36, side_steps=16)
    inner_rim = stadium_points(0.0422, y_front, y_rear, arc_steps=36, side_steps=16)
    n = len(outer_45)

    # Profile rings from bottom of aluminum body (z=0.002) to recessed deck (z=0.0380)
    # Include vertical support loops at z=0.0033 and z=0.0385 so side normals stay 100% horizontal
    rings = [
        (0.0, outer_bevel, 0.0020),
        (0.0, outer_45, 0.0030),
        (0.0, outer_45, 0.0033),
        (0.0, outer_45, 0.0150),
        (0.0, outer_45, 0.0270),
        (0.0, outer_45, 0.0385),
        (0.0, outer_45, 0.0388),
        (0.0, outer_bevel, 0.0395),
        (0.0, inner_rim, 0.0395),
        (0.0, inner_rim, 0.0393),
        (0.0, inner_rim, 0.0382),
        (0.0, inner_rim, 0.0380),
    ]
    vertices = []
    for _, contour, z in rings:
        for x, y in contour:
            vertices.append((x, y, z))
    # Add bottom center and top deck center to close caps cleanly
    bot_center_idx = len(vertices)
    vertices.append((0.0, 0.5 * (y_front + y_rear), 0.0020))
    top_center_idx = len(vertices)
    vertices.append((0.0, 0.5 * (y_front + y_rear), 0.0380))

    faces = []
    for r_idx in range(len(rings) - 1):
        base_a = r_idx * n
        base_b = (r_idx + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((base_a + i, base_a + j, base_b + j, base_b + i))
    # Bottom cap
    for i in range(n):
        j = (i + 1) % n
        faces.append((j, i, bot_center_idx))
    # Top recessed deck cap
    last_base = (len(rings) - 1) * n
    for i in range(n):
        j = (i + 1) % n
        faces.append((last_base + i, last_base + j, top_center_idx))

    base_obj = mesh_object(
        "Anodised stadium base", vertices, faces, mat["anodised_silver"], root
    )
    clean_mesh_object(base_obj, sharp_z=True)

    # Dark anodized bottom inset plate (Z = 0.0012..0.0022 m)
    plate_pts = stadium_points(0.0415, y_front, y_rear, arc_steps=28)
    np_pts = len(plate_pts)
    p_verts = [(x, y, 0.0012) for x, y in plate_pts] + [
        (x, y, 0.0022) for x, y in plate_pts
    ]
    p_bot = len(p_verts)
    p_verts.append((0.0, 0.5 * (y_front + y_rear), 0.0012))
    p_top = len(p_verts)
    p_verts.append((0.0, 0.5 * (y_front + y_rear), 0.0022))
    p_faces = []
    for i in range(np_pts):
        j = (i + 1) % np_pts
        p_faces.append((i, j, np_pts + j, np_pts + i))
        p_faces.append((j, i, p_bot))
        p_faces.append((np_pts + i, np_pts + j, p_top))
    plate_obj = mesh_object(
        "Base underside plate", p_verts, p_faces, mat["dark_anodised"], root
    )
    clean_mesh_object(plate_obj, sharp_z=True)

    # Four rubber feet touching Z = 0.0000 m exactly
    for label_name, x, y in (
        ("casa_foot_fl", -0.026, -0.068),
        ("casa_foot_fr", 0.026, -0.068),
        ("casa_foot_rl", -0.026, 0.036),
        ("casa_foot_rr", 0.026, 0.036),
    ):
        foot = empty(label_name, (x, y, 0.0), root)
        pad = cylinder(
            f"Silicone foot pad {label_name}",
            (0.0, 0.0, 0.0008),
            0.0085,
            0.0016,
            mat["rubber"],
            foot,
        )
        clean_mesh_object(pad, sharp_z=True)

    # Magnetic catch-cup centering pad on the front deck
    mag_pad = clean_lathe(
        "Magnetic catch-cup pad",
        [
            (0.0, 0.0378),
            (0.0355, 0.0378),
            (0.0355, 0.0383),
            (0.0180, 0.0383),
            (0.0180, 0.0385),
            (0.0, 0.0385),
        ],
        (0.0, GRIND_AXIS_Y, 0.0),
        mat["dark_anodised"],
        root,
        segments=72,
    )
    clean_mesh_object(mag_pad, sharp_z=True)
    empty("casa_cup_seat", CUP_ORIGIN, root)


def build_frame_and_grind_housing(root, mat):
    """Build the vertical support pillar, horizontal motor cylinder, and grind housing."""
    # 1. Vertical support pillar (Ø28 mm at Y = +0.0455 m, Z = 0.0375..0.138 m)
    clean_lathe(
        "Vertical support pillar",
        [
            (0.0, 0.0375),
            (0.0148, 0.0375),
            (0.0142, 0.0395),
            (0.0140, 0.0420),
            (0.0140, 0.1360),
            (0.0, 0.1360),
        ],
        (0.0, PILLAR_AXIS_Y, 0.0),
        mat["anodised_silver"],
        root,
        segments=72,
    )

    # 2. Horizontal motor and planetary gearbox cylinder (Ø50 mm along Y, Z = 0.152 m)
    # Spans from Y = -0.045 m (inside grind chamber) to Y = +0.1075 m (rear cap)
    motor_profile = expand_profile_with_support_loops(
        [
            (0.0, -0.0450),
            (0.0250, -0.0450),
            (0.0250, 0.1045),
            (0.0242, 0.1055),
            (0.0, 0.1055),
        ]
    )
    # Build revolved cylinder along Y
    segments = 80
    m_verts = []
    for radius, y_coord in motor_profile:
        for idx in range(segments):
            ang = idx * math.tau / segments
            m_verts.append(
                (
                    radius * math.cos(ang),
                    y_coord,
                    MOTOR_AXIS_Z + radius * math.sin(ang),
                )
            )
    m_faces = []
    for ring in range(len(motor_profile) - 1):
        for idx in range(segments):
            nxt = (idx + 1) % segments
            m_faces.append(
                (
                    ring * segments + idx,
                    (ring + 1) * segments + idx,
                    (ring + 1) * segments + nxt,
                    ring * segments + nxt,
                )
            )
    motor_obj = mesh_object(
        "Horizontal motor housing", m_verts, m_faces, mat["anodised_silver"], root
    )
    clean_mesh_object(motor_obj, sharp_z=False)

    # Rear recessed motor endcap reaching exact Y = +0.1075 m
    cap_profile = expand_profile_with_support_loops(
        [
            (0.0, 0.1050),
            (0.0240, 0.1050),
            (0.0242, 0.1068),
            (0.0235, 0.1075),
            (0.0, 0.1075),
        ]
    )
    c_verts = []
    for radius, y_coord in cap_profile:
        for idx in range(segments):
            ang = idx * math.tau / segments
            c_verts.append(
                (
                    radius * math.cos(ang),
                    y_coord,
                    MOTOR_AXIS_Z + radius * math.sin(ang),
                )
            )
    c_faces = []
    for ring in range(len(cap_profile) - 1):
        for idx in range(segments):
            nxt = (idx + 1) % segments
            c_faces.append(
                (
                    ring * segments + idx,
                    (ring + 1) * segments + idx,
                    (ring + 1) * segments + nxt,
                    ring * segments + nxt,
                )
            )
    cap_obj = mesh_object(
        "Motor rear endcap", c_verts, c_faces, mat["machined_alloy"], root
    )
    clean_mesh_object(cap_obj, sharp_z=False)

    # 3. Vertical grind chamber housing (Ø86 mm, R = 0.0430 m at Y = -0.0545 m, Z = 0.1225..0.2255 m)
    # Hollow interior bore so Hopper removal and Burr carrier access have real open cavity
    chamber_profile = [
        (0.0110, 0.1225),
        (0.0422, 0.1225),
        (0.0430, 0.1233),
        (0.0430, 0.2248),
        (0.0422, 0.2255),
        (0.0365, 0.2255),
        (0.0365, 0.1910),
        (0.0340, 0.1890),
        (0.0340, 0.1720),
        (0.0240, 0.1560),
        (0.0110, 0.1380),
        (0.0110, 0.1225),
    ]
    clean_lathe(
        "Vertical grind chamber housing",
        chamber_profile,
        (0.0, GRIND_AXIS_Y, 0.0),
        mat["anodised_silver"],
        root,
        segments=96,
    )

    # Bottom chute plate with open Ø20 mm discharge chute bore and 4 screw recesses
    clean_lathe(
        "Chute bottom plate",
        [
            (0.0100, 0.1225),
            (0.0405, 0.1225),
            (0.0405, 0.1238),
            (0.0100, 0.1238),
            (0.0100, 0.1225),
        ],
        (0.0, GRIND_AXIS_Y, 0.0),
        mat["dark_anodised"],
        root,
        segments=72,
    )
    for idx in range(4):
        ang = math.radians(45 + idx * 90)
        sx = 0.028 * math.cos(ang)
        sy = GRIND_AXIS_Y + 0.028 * math.sin(ang)
        screw = cylinder(
            f"Bottom plate screw {idx + 1}",
            (sx, sy, 0.1227),
            0.0022,
            0.0006,
            mat["burr_steel"],
            root,
        )
        clean_mesh_object(screw, sharp_z=True)

    # Front grind-setting index marker dot at (0, -0.0976, 0.2220)
    marker = cylinder(
        "Grind index marker",
        (0.0, GRIND_AXIS_Y - 0.0430, 0.2220),
        0.0012,
        0.0006,
        mat["ink"],
        root,
        axis="Y",
    )
    clean_mesh_object(marker, sharp_z=False)

    # Signature CNC-machined spherical anti-popcorning center dome inside the chamber
    # Visible from top view (manufacturer-03.webp & manufacturer-09.webp)
    dome_profile = [(0.0, 0.1900), (0.0060, 0.1900), (0.0060, 0.2240)]
    steps = 18
    r_dome = 0.0185
    z_dome_base = 0.2260
    for s in range(steps + 1):
        theta = (math.pi / 2) * (s / steps)
        dome_profile.append(
            (r_dome * math.cos(theta), z_dome_base + 0.0165 * math.sin(theta))
        )
    clean_lathe(
        "Anti-popcorning center dome",
        dome_profile,
        (0.0, GRIND_AXIS_Y, 0.0),
        mat["machined_alloy"],
        root,
        segments=72,
        sharp_z=False,
    )
    for idx in range(3):
        ang = idx * math.tau / 3
        strut = box(
            f"Center dome support strut {idx + 1}",
            (
                0.024 * math.cos(ang),
                GRIND_AXIS_Y + 0.024 * math.sin(ang),
                0.2020,
            ),
            (0.018, 0.0032, 0.0045),
            mat["machined_alloy"],
            root,
            bevel=0.0005,
        )
        strut.rotation_euler.z = ang
        clean_mesh_object(strut, sharp_z=False)

    empty("casa_chute_outlet", (0.0, GRIND_AXIS_Y, 0.1225), root)


def build_controls(root, mat):
    """Build the side auto-grind push button and the front chute clicker/knocker."""
    # 1. Side auto-grind switch on -X wall of stadium base (button cap flush with X = -0.0450 m)
    bezel = clean_lathe(
        "Power button bezel",
        [
            (0.0056, -0.0008),
            (0.0072, -0.0008),
            (0.0072, 0.0005),
            (0.0056, 0.0005),
            (0.0056, -0.0008),
        ],
        (0.0, 0.0, 0.0),
        mat["dark_anodised"],
        root,
        segments=48,
    )
    bezel.location = POWER_BTN_ORIGIN
    bezel.rotation_euler.y = -math.pi / 2
    bpy.context.view_layer.objects.active = bezel
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    clean_mesh_object(bezel, sharp_z=False, recalc_normals=False)

    power_btn = empty("casa_power_button", POWER_BTN_ORIGIN, root)
    btn_mesh = cylinder(
        "Auto-grind switch button",
        (0.0, 0.0, 0.0),
        0.0054,
        0.0016,
        mat["anodised_silver"],
        power_btn,
        axis="X",
    )
    bpy.context.view_layer.objects.active = btn_mesh
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(btn_mesh, sharp_z=False)

    # 2. Front chute clicker / knocker on -Y wall of grind chamber (protrudes to Y = -0.1075 m)
    clicker = empty("casa_clicker", CLICKER_ORIGIN, root)
    stem = cylinder(
        "Clicker stem",
        (0.0, -0.0035, 0.0),
        0.0065,
        0.0070,
        mat["machined_alloy"],
        clicker,
        axis="Y",
    )
    bpy.context.view_layer.objects.active = stem
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(stem, sharp_z=False)
    knob = cylinder(
        "Chute knocker button",
        (0.0, -0.0075, 0.0),
        0.0090,
        0.0050,
        mat["anodised_silver"],
        clicker,
        axis="Y",
    )
    bpy.context.view_layer.objects.active = knob
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    clean_mesh_object(knob, sharp_z=False)
    return power_btn, clicker


def build_burrs(root, mat):
    """Build the removable Mizen 65CL outer ring burr carrier and driven inner conical burr."""
    # 1. Removable outer ring burr carrier (casa_burr_carrier)
    carrier = empty("casa_burr_carrier", BURR_CARRIER_ORIGIN, root)
    carrier["source_part"] = "Mizen 65CL outer ring burr and tool-less carrier"
    carrier_profile = [
        (0.0255, 0.0000),
        (0.0325, 0.0000),
        (0.0325, 0.0155),
        (0.0355, 0.0165),
        (0.0355, 0.0205),
        (0.0265, 0.0205),
        (0.0245, 0.0150),
        (0.0255, 0.0000),
    ]
    clean_lathe(
        "Mizen 65CL outer burr carrier",
        carrier_profile,
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        carrier,
        segments=72,
    )
    # Internal ring burr cutting flutes (18 angled ribs inside the ring)
    for idx in range(18):
        ang = idx * math.tau / 18
        tooth = box(
            f"Outer burr flute {idx + 1}",
            (0.0246 * math.cos(ang), 0.0246 * math.sin(ang), 0.0080),
            (0.0014, 0.0024, 0.0130),
            mat["burr_steel"],
            carrier,
            bevel=0.0002,
        )
        tooth.rotation_euler = (0.18, 0.0, ang)
        clean_mesh_object(tooth, sharp_z=False)

    # 2. Driven inner conical burr (casa_burr_cone)
    cone = empty("casa_burr_cone", BURR_CONE_ORIGIN, root)
    cone["source_part"] = "Mizen 65CL 65 mm omni-purpose conical burr"
    cone_profile = [
        (0.0055, -0.0140),
        (0.0085, -0.0140),
        (0.0085, 0.0000),
        (0.0215, 0.0000),
        (0.0200, 0.0060),
        (0.0145, 0.0185),
        (0.0105, 0.0200),
        (0.0055, 0.0200),
        (0.0055, -0.0140),
    ]
    clean_lathe(
        "Mizen 65CL conical burr",
        cone_profile,
        (0.0, 0.0, 0.0),
        mat["burr_steel"],
        cone,
        segments=72,
    )
    # 7 primary spiral pre-breaker blades on the cone
    for idx in range(7):
        ang = idx * math.tau / 7
        fin = box(
            f"Conical burr pre-breaker flute {idx + 1}",
            (0.0168 * math.cos(ang), 0.0168 * math.sin(ang), 0.0095),
            (0.0022, 0.0016, 0.0155),
            mat["burr_steel"],
            cone,
            bevel=0.0002,
        )
        fin.rotation_euler = (-0.28, -0.22, ang)
        clean_mesh_object(fin, sharp_z=False)

    return carrier, cone


def build_hopper(root, mat):
    """Build the rotatable stepless grind adjustment collar & bean hopper (Z = 0.2255..0.2750 m)."""
    hopper = empty("casa_hopper", HOPPER_ORIGIN, root)
    hopper["source_part"] = "Stepless grind adjustment collar and 30-40 g bean funnel"
    # Outer diameter 80 mm (R = 0.0400 m), height 49.5 mm -> top at exact Z = 0.2750 m
    hopper_profile = [
        (0.0342, -0.0080),
        (0.0358, -0.0080),
        (0.0358, 0.0004),
        (0.0400, 0.0008),
        (0.0400, 0.0490),
        (0.0394, 0.0495),
        (0.0322, 0.0495),
        (0.0318, 0.0488),
        (0.0318, 0.0340),
        (0.0275, 0.0140),
        (0.0268, 0.0000),
        (0.0342, -0.0080),
    ]
    clean_lathe(
        "Rotatable bean hopper collar",
        hopper_profile,
        (0.0, 0.0, 0.0),
        mat["hopper_collar"],
        hopper,
        segments=96,
    )

    # Stepless grind scale markings around the lower rim: 10 major dots + 40 minor dots
    for step in range(50):
        # Align setting 7 towards front (-Y = -pi/2) as in manufacturer-02.webp
        ang = -math.pi / 2 + (step - 35) * (math.tau / 50)
        is_major = step % 5 == 0
        dot_r = 0.0011 if is_major else 0.00055
        dot_z = 0.0028
        dot = cylinder(
            f"Grind scale {'major' if is_major else 'subdivision'} dot {step}",
            (0.0400 * math.cos(ang), 0.0400 * math.sin(ang), dot_z),
            dot_r,
            0.0005,
            mat["ink"],
            hopper,
            axis="Y",
        )
        dot.rotation_euler = (math.pi / 2, 0.0, ang + math.pi / 2)
        clean_mesh_object(dot, sharp_z=False)

    return hopper


def build_dosing_cup(root, mat):
    """Build the magnetic 58 mm-stepped dosing catch cup (40-50 g capacity)."""
    cup = empty("casa_dosing_cup", CUP_ORIGIN, root)
    cup["source_part"] = "Magnetic dosing catch cup with 58 mm portafilter step"
    # Outer cylinder Ø70 mm (R = 0.0350 m) up to Z_local = 0.0750 m,
    # stepped 58 mm lip (R = 0.0290 m outer, R = 0.0265 m inner) up to Z_local = 0.0810 m
    # (world Z = 0.0380 + 0.0810 = 0.1190 m, leaving 3.5 mm clearance below Z = 0.1225 m chute)
    cup_profile = [
        (0.0, 0.0020),
        (0.0342, 0.0020),
        (0.0350, 0.0028),
        (0.0350, 0.0744),
        (0.0344, 0.0750),
        (0.0292, 0.0750),
        (0.0290, 0.0805),
        (0.0285, 0.0810),
        (0.0268, 0.0810),
        (0.0265, 0.0804),
        (0.0265, 0.0735),
        (0.0318, 0.0680),
        (0.0318, 0.0060),
        (0.0295, 0.0045),
        (0.0, 0.0045),
    ]
    clean_lathe(
        "Magnetic dosing catch cup",
        cup_profile,
        (0.0, 0.0, 0.0),
        mat["anodised_silver"],
        cup,
        segments=96,
    )
    clean_lathe(
        "Dosing cup magnetic base",
        [
            (0.0, 0.0000),
            (0.0338, 0.0000),
            (0.0342, 0.0020),
            (0.0, 0.0020),
        ],
        (0.0, 0.0, 0.0),
        mat["dark_anodised"],
        cup,
        segments=72,
    )
    empty("casa_cup_contents", (0.0, 0.0, 0.0350), cup)
    return cup


def build_power_lead(root, mat):
    """Build illustrative stowed power cord and plug (excluded from body envelope)."""
    lead = empty("casa_power_lead", (0.0, 0.0, 0.0), root)
    relief = cylinder(
        "Rear cord strain relief",
        (0.0, 0.0760, 0.0140),
        0.0050,
        0.0100,
        mat["dark_anodised"],
        lead,
        axis="Y",
    )
    clean_mesh_object(relief, sharp_z=False)
    points = [
        (0.0, 0.080, 0.014),
        (0.018, 0.102, 0.008),
        (0.058, 0.106, 0.004),
        (0.095, 0.082, 0.004),
        (0.105, 0.035, 0.004),
        (0.088, -0.010, 0.006),
    ]
    cable = tube("Stowed power cable", points, 0.0028, mat["dark_anodised"], lead, smooth=True)
    bpy.context.view_layer.objects.active = cable
    bpy.ops.object.convert(target="MESH")
    clean_mesh_object(cable, sharp_z=False)

    plug = empty("casa_ac_plug", (0.088, -0.026, 0.010), lead)
    plug_body = box(
        "Plug moulding",
        (0.0, 0.0, 0.0),
        (0.024, 0.030, 0.016),
        mat["dark_anodised"],
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
    appliance = bpy.data.collections.new("LAGOM casa appliance")
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
            "manufacturer-01.webp",
            "manufacturer-02.webp",
            "manufacturer-03.webp",
            "manual-grind-adjustment.png",
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
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = "GPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    setup_softbox_world(scene, "Casa neutral studio", camera_bg_rgb=(0.64, 0.67, 0.71))
    before = set(scene.objects)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(
        material("Casa studio floor", (0.26, 0.28, 0.30, 1.0), roughness=0.85)
    )
    area_light("Key softbox", (-0.55, -0.50, 0.65), (0.0, -0.02, 0.14), 60, 0.55)
    area_light("Fill strip", (0.60, -0.20, 0.50), (0.0, -0.02, 0.14), 40, 0.42)
    area_light("Rim softbox", (0.15, 0.65, 0.65), (0.0, 0.0, 0.16), 62, 0.50)
    area_light("Overhead hopper softbox", (-0.06, -0.08, 0.85), (0.0, GRIND_AXIS_Y, 0.22), 28, 0.38)
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


def render_views(camera, hopper, carrier, cup):
    render(camera, "studio-main", (-0.48, -0.62, 0.38), (0.0, -0.01, 0.138), 0.36)
    render(camera, "studio-front", (0.0, -1.5, 0.138), (0.0, 0.0, 0.138), 0.33)
    render(camera, "studio-right", (-1.5, 0.0, 0.138), (0.0, 0.0, 0.138), 0.33)
    render(
        camera,
        "studio-hopper",
        (-0.14, -0.22, 0.68),
        (0.0, GRIND_AXIS_Y, 0.245),
        0.16,
    )
    # Tool-less disassembly view (Safety Manual page 5)
    hopper.location = (0.115, -0.045, 0.008)
    carrier.location = (0.115, 0.045, 0.000)
    cup.location = (-0.110, -0.040, 0.000)
    render(
        camera,
        "studio-disassembled",
        (-0.48, -0.78, 0.52),
        (0.01, -0.01, 0.115),
        0.44,
    )
    hopper.location = HOPPER_ORIGIN
    carrier.location = BURR_CARRIER_ORIGIN
    cup.location = CUP_ORIGIN


def animate(hopper, carrier, cone, cup, power_btn, clicker):
    scene = bpy.context.scene
    # Frames 1-90: tool-less hopper unscrew & lift, burr carrier lift, cup removal & return
    for frame, h_rot, h_lift, c_lift, cup_y, cup_z in (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0),
        (20, 45.0, 0.004, 0.0, 0.0, 0.0),
        (40, 45.0, 0.095, 0.0, 0.0, 0.0),
        (55, 45.0, 0.095, 0.065, -0.095, 0.005),
        (75, 45.0, 0.095, 0.0, 0.0, 0.0),
        (95, 45.0, 0.004, 0.0, 0.0, 0.0),
        (110, 0.0, 0.0, 0.0, 0.0, 0.0),
    ):
        hopper.rotation_euler.z = math.radians(h_rot)
        hopper.location.z = HOPPER_ORIGIN[2] + h_lift
        carrier.location.z = BURR_CARRIER_ORIGIN[2] + c_lift
        cup.location.y = CUP_ORIGIN[1] + cup_y
        cup.location.z = CUP_ORIGIN[2] + cup_z
        hopper.keyframe_insert(data_path="rotation_euler", frame=frame)
        hopper.keyframe_insert(data_path="location", frame=frame)
        carrier.keyframe_insert(data_path="location", frame=frame)
        cup.keyframe_insert(data_path="location", frame=frame)

    # Frames 115-180: press side auto-grind button, spin Mizen 65CL conical burr, snap clicker
    for frame, btn_dx, cone_deg, click_dz in (
        (1, 0.0, 0.0, 0.0),
        (115, 0.0, 0.0, 0.0),
        (120, 0.0012, 0.0, 0.0),
        (125, 0.0, 45.0, 0.0),
        (160, 0.0, 360.0, 0.0),
        (168, 0.0, 360.0, -0.0060),
        (174, 0.0, 360.0, 0.0),
        (180, 0.0, 360.0, 0.0),
    ):
        power_btn.location.x = POWER_BTN_ORIGIN[0] + btn_dx
        cone.rotation_euler.z = math.radians(cone_deg)
        clicker.location.z = CLICKER_ORIGIN[2] + click_dz
        power_btn.keyframe_insert(data_path="location", frame=frame)
        cone.keyframe_insert(data_path="rotation_euler", frame=frame)
        clicker.keyframe_insert(data_path="location", frame=frame)

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
    scene.name = "OPTION-O LAGOM casa - visual prototype"
    scene.unit_settings.system = "METRIC"

    root = empty("casa_grinder", (0.0, 0.0, 0.0))
    root["model"] = (
        "OPTION-O LAGOM casa Conical Burr Grinder (Mizen 65CL, 100-240 V / JP 100 V 200 W)"
    )
    root["dimensions_status"] = "Published 90 x 215 x 275 mm (W x D x H); 3.5 kg"
    root["physics_status"] = (
        "Articulated visual and native MuJoCo mechanical prototype"
    )

    mat = palette()
    build_stadium_base(root, mat)
    build_frame_and_grind_housing(root, mat)
    power_btn, clicker = build_controls(root, mat)
    carrier, cone = build_burrs(root, mat)
    hopper = build_hopper(root, mat)
    cup = build_dosing_cup(root, mat)
    lead = build_power_lead(root, mat)

    bpy.context.view_layer.update()
    textured_metals = {
        mat["anodised_silver"],
        mat["machined_alloy"],
        mat["burr_steel"],
    }
    for obj in root.children_recursive:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        if obj.name == "Rotatable bean hopper collar":
            project_hopper_collar_uvs(obj)
        elif obj.data.materials[0] in textured_metals:
            project_stainless_uvs(obj, scale=3.6)

    export_glb(root, "option-o-lagom-casa.glb")

    # Standalone magnetic dosing cup export
    cup.parent = None
    cup.location = (0.0, 0.0, 0.0)
    export_glb(cup, "option-o-lagom-casa-cup.glb")
    cup.parent = root
    cup.location = CUP_ORIGIN

    # Standalone Mizen 65CL outer burr carrier export
    carrier.parent = None
    carrier.location = (0.0, 0.0, 0.0)
    export_glb(carrier, "option-o-lagom-casa-burr-carrier.glb")
    carrier.parent = root
    carrier.location = BURR_CARRIER_ORIGIN

    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    report = {
        "status": "Uncalibrated visual and mechanical prototype",
        "published_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(val, 6) for val in (high - low)],
        "published_mass_kg": 3.5,
        "burr_set": "Mizen 65CL 65 mm conical burrs (optional 48MS 48 mm)",
        "sources": [
            "Inter-Christine Japan product page (SKU 000000000405 / lagom-casa)",
            "OPTION-O LAGOM casa Quick Start Guide (16 pages)",
            "OPTION-O LAGOM casa Safety Manual (14 pages)",
            "OPTION-O official product page and studio photographs",
        ],
        "assumptions": [
            "Component diameters, pillar/motor offsets, and cup step derived from orthographic photographs",
            "Internal burr flutes, wall thicknesses, and shaft bearings are visual reconstructions",
            "Hopper lift (95 mm), clicker stroke (6 mm), and button press (1.2 mm) are preview travels",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "option-o-lagom-casa.glb").read_bytes()
        ).hexdigest(),
        "cup_glb_sha256": hashlib.sha256(
            (ASSETS / "option-o-lagom-casa-cup.glb").read_bytes()
        ).hexdigest(),
        "burr_carrier_glb_sha256": hashlib.sha256(
            (ASSETS / "option-o-lagom-casa-burr-carrier.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")

    organize(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, hopper, carrier, cup)
    animate(hopper, carrier, cone, cup, power_btn, clicker)
    camera.location = (-0.48, -0.62, 0.38)
    camera.data.ortho_scale = 0.36
    look_at(camera, (0.0, -0.01, 0.138))

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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "option-o-lagom-casa.blend"))
    for temp_name in TEMP_TEXTURE_FILES:
        (ASSETS / temp_name).unlink(missing_ok=True)
    print("Saved OPTION-O LAGOM casa visual prototype", ASSETS)


if __name__ == "__main__":
    main()
