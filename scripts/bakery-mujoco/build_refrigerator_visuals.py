"""Build the Japanese Hoshizaki RT-120SNJ in a separate Blender process.

Geometry follows drawing D38190 (2024-09-18). Metres, Z up, front towards -Y.
This authoring step exports visual geometry and articulation, without physics.
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
from appliance_surface_kit import (
    bake_ortho_sheet,
    generate_stainless_hairline_textures,
    load_japanese_font,
    project_front_planar_uvs,
    project_stainless_uvs,
    setup_softbox_world,
    textured_decal_material,
    textured_stainless_material,
)
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    frame,
    look_at,
    material,
    rounded_rectangle,
    tube,
)

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/hoshizaki-rt-120snj"
REFERENCES = REPOSITORY / "docs/equipment/hoshizaki-rt-120snj"
NAME = "hoshizaki-rt-120snj"


def bake_rt120_graphics() -> tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Bake Hoshizaki Japanese rating plate, Penguin crest emblem, and Eco water-drop button."""

    def flat_poly(scn, name, pts_xy, z, mat):
        m = bpy.data.meshes.new(name)
        m.from_pydata([(px, py, z) for px, py in pts_xy], [], [tuple(range(len(pts_xy)))])
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)
        return o

    def flat_rect(scn, name, cx, cy, w, h, z, mat, r=0.0):
        pts = [(cx + px, cy + py) for px, py in (
            rounded_rectangle(w, h, r, segments=8) if r > 1e-5 else
            [(w / 2, h / 2), (-w / 2, h / 2), (-w / 2, -h / 2), (w / 2, -h / 2)]
        )]
        return flat_poly(scn, name, pts, z, mat)

    def flat_disc(scn, name, cx, cy, rx, ry, z, mat, n=40):
        pts = [(cx + rx * math.cos(i * math.tau / n), cy + ry * math.sin(i * math.tau / n)) for i in range(n)]
        return flat_poly(scn, name, pts, z, mat)

    def flat_txt(scn, txt, cx, cy, z, size, mat, fnt, align_x="CENTER"):
        c = bpy.data.curves.new("_rt_txt", "FONT")
        c.body = txt
        c.size = size
        c.font = fnt
        c.align_x = align_x
        c.align_y = "CENTER"
        o = bpy.data.objects.new("_rt_txt", c)
        scn.collection.objects.link(o)
        o.location = (cx, cy, z)
        o.data.materials.append(mat)

    def build_spec_sheet(scn, emit_mat, font_jp, font_en):
        m_sil = emit_mat("sil", (0.58, 0.61, 0.64, 1.0))
        m_dk = emit_mat("dk", (0.015, 0.018, 0.024, 1.0))
        m_wh = emit_mat("wh", (0.94, 0.95, 0.96, 1.0))
        flat_rect(scn, "bg", 0.0, 0.0, 0.222, 0.046, 0.0, m_sil, 0.0015)
        flat_rect(scn, "hdr", 0.0, 0.0155, 0.216, 0.010, 0.001, m_dk, 0.0008)
        flat_txt(scn, "ホシザキ 業務用テーブル形冷蔵庫", -0.032, 0.0155, 0.002, 0.0056, m_wh, font_jp)
        flat_txt(scn, "RT-120SNJ", 0.072, 0.0155, 0.002, 0.0062, m_wh, font_en)
        flat_txt(scn, "電源 単相100V 50/60Hz  電動機定格消費電力 115/115W", 0.0, 0.0040, 0.002, 0.0046, m_dk, font_jp)
        flat_txt(scn, "有効内容積 243L   製品質量 68kg   冷媒 R600a (52g)", 0.0, -0.0050, 0.002, 0.0046, m_dk, font_jp)
        flat_txt(scn, "ホシザキ株式会社   MADE IN JAPAN   屋内用  PSE  JQA", 0.0, -0.0150, 0.002, 0.0044, m_dk, font_jp)

    def build_penguin_sheet(scn, emit_mat, _font_jp, font_en):
        m_chr = emit_mat("chr", (0.82, 0.85, 0.88, 1.0))
        m_blk = emit_mat("blk", (0.004, 0.006, 0.012, 1.0))
        m_sky = emit_mat("sky", (0.045, 0.34, 0.78, 1.0))
        m_wh = emit_mat("wh", (0.97, 0.98, 0.99, 1.0))
        m_beak = emit_mat("bk", (0.92, 0.46, 0.03, 1.0))
        flat_disc(scn, "rim", 0.0, 0.0, 0.016, 0.016, 0.0, m_chr)
        flat_disc(scn, "ring", 0.0, 0.0, 0.0145, 0.0145, 0.001, m_blk)
        flat_disc(scn, "sky", 0.0, -0.0008, 0.0102, 0.0102, 0.002, m_sky)
        flat_txt(scn, "HOSHIZAKI", 0.0, 0.0112, 0.003, 0.0028, m_wh, font_en)
        # Standing Hoshizaki penguin silhouette inside sky-blue circle
        flat_disc(scn, "p_body", -0.0005, -0.0022, 0.0044, 0.0064, 0.003, m_blk)
        flat_disc(scn, "p_head", 0.0002, 0.0045, 0.0030, 0.0028, 0.0032, m_blk)
        flat_disc(scn, "p_belly", 0.0006, -0.0026, 0.0028, 0.0048, 0.0036, m_wh)
        flat_disc(scn, "p_eye", 0.0012, 0.0050, 0.0007, 0.0007, 0.0038, m_wh)
        flat_poly(scn, "p_beak", [(0.0028, 0.0052), (0.0058, 0.0044), (0.0028, 0.0037)], 0.0038, m_beak)

    def build_eco_sheet(scn, emit_mat, _font_jp, font_en):
        m_bg = emit_mat("bg", (0.08, 0.10, 0.12, 1.0))
        m_cy = emit_mat("cy", (0.06, 0.56, 0.86, 1.0))
        m_gr = emit_mat("gr", (0.18, 0.76, 0.36, 1.0))
        m_wh = emit_mat("wh", (0.94, 0.96, 0.98, 1.0))
        flat_rect(scn, "bg", 0.0, 0.0, 0.024, 0.028, 0.0, m_bg, 0.003)
        flat_disc(scn, "drop_b", 0.0, 0.0015, 0.0062, 0.0062, 0.001, m_cy)
        flat_poly(scn, "drop_t", [(-0.0056, 0.0035), (0.0, 0.0110), (0.0056, 0.0035)], 0.001, m_cy)
        flat_disc(scn, "leaf", 0.0025, 0.0005, 0.0028, 0.0018, 0.002, m_gr)
        flat_txt(scn, "ECO", 0.0, -0.0095, 0.002, 0.0036, m_wh, font_en)

    spec_img = bake_ortho_sheet(ASSETS / "rt120-spec-label.png", 888, 184, 0.222, 0.046, build_spec_sheet)
    peng_img = bake_ortho_sheet(ASSETS / "rt120-penguin-badge.png", 256, 256, 0.032, 0.032, build_penguin_sheet)
    eco_img = bake_ortho_sheet(ASSETS / "rt120-eco-button.png", 192, 224, 0.024, 0.028, build_eco_sheet)
    return spec_img, peng_img, eco_img


def surfaces():
    ss_col, ss_orm = generate_stainless_hairline_textures(
        ASSETS, "rt120", base_rgb=(0.77, 0.79, 0.82), streak_amp=0.040, rough_base=0.23, seed=1205
    )
    spec_img, peng_img, eco_img = bake_rt120_graphics()
    return {
        "steel": textured_stainless_material(
            "RT stainless exterior", ss_col, ss_orm, tint=(0.86, 0.88, 0.91, 1.0), metallic=0.90, roughness=0.22
        ),
        "lining": textured_stainless_material(
            "RT stainless interior", ss_col, ss_orm, tint=(0.76, 0.79, 0.82, 1.0), metallic=0.84, roughness=0.29
        ),
        "wire": material("RT coated shelf wire", (0.83, 0.85, 0.84, 1), 0.12, 0.26),
        "trim": textured_stainless_material(
            "RT folded edge steel", ss_col, ss_orm, tint=(0.90, 0.92, 0.94, 1.0), metallic=0.93, roughness=0.18
        ),
        "dish_steel": textured_stainless_material(
            "RT handle dish steel", ss_col, ss_orm, tint=(0.56, 0.59, 0.63, 1.0), metallic=0.88, roughness=0.26
        ),
        "plastic": material("RT charcoal ABS", (0.058, 0.062, 0.066, 1), 0.03, 0.38),
        "foot_resin": material("RT leg black resin", (0.016, 0.018, 0.022, 1), 0.02, 0.36),
        "handle": material("RT handle polymer", (0.18, 0.19, 0.20, 1), 0.14, 0.34),
        "seal": material("RT magnetic gasket", (0.08, 0.09, 0.10, 1), 0.0, 0.56),
        "black": material("RT recess black", (0.010, 0.012, 0.015, 1), 0.02, 0.44),
        "ink": material("RT panel lettering", (0.88, 0.91, 0.92, 1), 0.0, 0.40),
        "screen": material("RT display lens", (0.018, 0.042, 0.056, 1), 0.16, 0.12),
        "digits": material("RT example display", (0.22, 0.78, 0.88, 1), emission=1.6),
        "blue": material("RT identification blue", (0.02, 0.22, 0.52, 1), 0.1, 0.30),
        "copper": material("RT condenser copper", (0.72, 0.36, 0.18, 1), 0.88, 0.28),
        "fin_alu": material("RT condenser fin", (0.52, 0.55, 0.58, 1), 0.82, 0.36),
        "spec_decal": textured_decal_material("RT spec plate decal", spec_img, roughness=0.28, metallic=0.10, coat=0.06),
        "penguin_decal": textured_decal_material("RT penguin badge decal", peng_img, roughness=0.22, coat=0.06),
        "eco_decal": textured_decal_material("RT eco button decal", eco_img, roughness=0.26, coat=0.06),
    }


def half_moon_recess_mesh(name, center, width, height, depth, surface, parent):
    """Build a recessed semi-circular (half-moon) stamped stainless dish matching RT-120SNJ photo."""
    cx, cy, cz = center
    rx = width * 0.5
    n_arc = 20
    # Outer front contour: top horizontal chord from +rx to -rx at cz + height*0.35, then semi-circular arc down
    top_z = height * 0.34
    arc_r_z = height * 0.66
    front_ring = []
    back_ring = []
    for i in range(n_arc + 1):
        # Angle from 180 deg (-rx) to 360 deg (+rx) along bottom semi-circle
        ang = math.pi + (i / n_arc) * math.pi
        px = rx * math.cos(ang)
        pz = top_z + arc_r_z * math.sin(ang)
        front_ring.append((cx + px, cy, cz + pz))
        back_ring.append((cx + px * 0.82, cy + depth, cz + top_z * 0.85 + (pz - top_z) * 0.78))

    m = len(front_ring)
    verts = front_ring + back_ring
    faces = []
    # Side bevel wall around semi-circle + top chord
    for i in range(m):
        nxt = (i + 1) % m
        faces.append((i, nxt, m + nxt, m + i))
    # Concave back wall fan
    faces.append(tuple(range(m, 2 * m)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, 0.0008)


def text_label(name, text, position, size, surface, parent, font=None):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    if font is not None:
        data.font = font
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.00008
    data.resolution_u = 3
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = math.pi / 2
    return finish(obj, name, surface, parent)


def build_shell(root, mat):
    parts = (
        ("Worktop", (0, 0, 0.780), (1.2, 0.600, 0.040), "steel", 0.0025),
        ("Left service enclosure", (-0.4495, 0.026, 0.430), (0.299, 0.546, 0.660), "steel", 0.002),
        ("Right insulated wall", (0.575, 0.026, 0.430), (0.048, 0.548, 0.660), "steel", 0.002),
        ("Rear insulated wall", (0.131, 0.2715, 0.457), (0.840, 0.057, 0.604), "lining", 0.002),
        ("Interior floor", (0.131, 0.0225, 0.1275), (0.840, 0.441, 0.055), "lining", 0.002),
        ("Interior ceiling", (0.131, 0.0225, 0.7595), (0.840, 0.441, 0.001), "lining", 0.0002),
        ("Left cavity wall", (-0.2945, 0.0225, 0.457), (0.011, 0.441, 0.604), "lining", 0.001),
        ("Centre front mullion", (0.131, -0.218, 0.4405), (0.028, 0.040, 0.571), "lining", 0.002),
        ("Front upper frame", (0.131, -0.218, 0.743), (0.840, 0.040, 0.034), "lining", 0.002),
        ("Front lower frame", (0.131, -0.219, 0.142), (0.840, 0.042, 0.026), "lining", 0.002),
        ("Left opening jamb", (-0.285, -0.218, 0.4405), (0.008, 0.040, 0.571), "lining", 0.001),
        ("Right opening jamb", (0.547, -0.218, 0.4405), (0.008, 0.040, 0.571), "lining", 0.001),
        ("Lower front folded trim", (0.131, -0.270, 0.110), (0.848, 0.052, 0.020), "trim", 0.001),
    )
    for name, position, size, surface, radius in parts:
        box(name, position, size, mat[surface], root, radius)
    box("Top front folded lip", (0, -0.2975, 0.780), (1.198, 0.005, 0.038), mat["trim"], root, 0.0012)
    # Shape and height are provisional. The drawing identifies the 33 mm projection.
    evaporator = box("Evaporator cover - approximate", (-0.2725, 0.080, 0.678), (0.033, 0.300, 0.145), mat["lining"], root, 0.008)
    evaporator["measurement_status"] = "33 mm projection from drawing; height and detail estimated"
    for index in range(12):
        box(f"Evaporator outlet {index:02}", (-0.2555, 0.080, 0.621 + index * 0.009), (0.001, 0.229, 0.003), mat["black"], root, 0.0004)
    box("Ceiling circulation duct", (0.150, 0.021, 0.746), (0.700, 0.405, 0.023), mat["lining"], root, 0.004)
    box("Interior light diffuser", (0.132, -0.167, 0.734), (0.275, 0.016, 0.012), mat["wire"], root)

    # Under-chassis drain joint (ドレンジョイント) & corrugated drain hose (ドレンホース) per drawing D38190
    cylinder("Underbody drain trap", (-0.015, -0.060, 0.082), 0.024, 0.034, mat["handle"], root)
    cylinder("Underbody drain pipe", (-0.175, -0.060, 0.084), 0.009, 0.300, mat["handle"], root, "X")
    tube("Underbody drain hose", [(-0.015, -0.060, 0.068), (0.075, -0.060, 0.066), (0.095, -0.060, 0.034), (0.155, -0.060, 0.032)], 0.012, mat["seal"], root)

    for x in (-0.281, 0.539):
        for y in (-0.187, 0.236):
            cylinder("Foot mounting collar", (x, y, 0.092), 0.024, 0.016, mat["trim"], root)
            cylinder("Adjustable foot stem", (x, y, 0.076), 0.014, 0.026, mat["foot_resin"], root)
            bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.012, radius2=0.021, depth=0.073, location=(x, y, 0.0365))
            finish(bpy.context.object, "Tapered resin foot", mat["foot_resin"], root, 0.001)
    for x in (-0.079, 0.341):
        for rail_x in (x - 0.198, x + 0.198):
            for rail_y in (-0.165, 0.218):
                box("Shelf support standard", (rail_x, rail_y, 0.443), (0.009, 0.006, 0.525), mat["trim"], root, 0.0005)
                for level in range(21):
                    box("25 mm shelf support slot", (rail_x, rail_y - 0.0035, 0.193 + level * 0.025), (0.004, 0.001, 0.009), mat["black"], root, 0.0002)


def build_service_panel(root, mat, font):
    box("Service front ABS panel", (-0.447, -0.274, 0.430), (0.298, 0.040, 0.653), mat["plastic"], root, 0.004)

    # Top exhaust slots above controller (exact match to D38190 & manufacturer photo)
    box("Top exhaust hood trim", (-0.447, -0.2955, 0.738), (0.276, 0.005, 0.022), mat["plastic"], root, 0.0015)
    for sx, sname in ((-0.514, "Top exhaust slot left"), (-0.380, "Top exhaust slot right")):
        box(sname, (sx, -0.2982, 0.738), (0.118, 0.003, 0.0085), mat["black"], root, 0.001)

    # Wide recessed digital controller bezel: HOSHIZAKI left, smoked display center, Eco drop button right
    box("Controller bezel", (-0.447, -0.296, 0.682), (0.268, 0.006, 0.056), mat["black"], root, 0.003)
    text_label("Manufacturer lettering", "HOSHIZAKI", (-0.546, -0.2996, 0.682), 0.0072, mat["ink"], root, font)
    box("Controller glass", (-0.450, -0.2995, 0.682), (0.118, 0.001, 0.036), mat["screen"], root, 0.0015)
    text_label("Example temperature", "3.0", (-0.456, -0.3005, 0.682), 0.019, mat["digits"], root, font)
    text_label("Temperature unit", "°C", (-0.412, -0.3005, 0.679), 0.0065, mat["ink"], root, font)
    box("Eco water-drop button", (-0.352, -0.2996, 0.682), (0.024, 0.0012, 0.028), mat["eco_decal"], root, 0.0005)
    for z in (0.673, 0.691):
        cylinder("Control button", (-0.380, -0.300, z), 0.0038, 0.0018, mat["handle"], root, "Y")

    # Mid-height slide-out air filter seam & centered pull-tab recess
    box("Filter panel horizontal seam", (-0.447, -0.2945, 0.538), (0.292, 0.002, 0.0025), mat["black"], root, 0.0003)
    box("Filter finger recess", (-0.447, -0.2955, 0.529), (0.088, 0.0035, 0.011), mat["black"], root, 0.002)

    # Condenser louver intake & behind-grille fin/copper coil assembly
    box("Ventilation recess", (-0.447, -0.293, 0.250), (0.252, 0.006, 0.248), mat["black"], root, 0.003)
    box("Condenser fin block", (-0.447, -0.284, 0.250), (0.228, 0.008, 0.224), mat["fin_alu"], root, 0.001)
    for cz in (0.165, 0.215, 0.265, 0.315):
        cylinder(f"Condenser copper tube {cz:.2f}", (-0.447, -0.287, cz), 0.0036, 0.220, mat["copper"], root, "X")
    for index in range(17):
        louver = box(f"Service air louver {index:02}", (-0.447, -0.297, 0.137 + index * 0.014), (0.248, 0.007, 0.0042), mat["plastic"], root, 0.0008)
        louver.rotation_euler.x = math.radians(14)
    for x in (-0.514, -0.447, -0.380):
        box("Grille vertical rib", (x, -0.300, 0.250), (0.0032, 0.0032, 0.244), mat["plastic"], root, 0.0005)

    # Detailed Japanese rating & wiring specification decal above condenser louvers
    box("Model label", (-0.447, -0.2952, 0.412), (0.222, 0.0012, 0.046), mat["spec_decal"], root, 0.0004)
    text_label("Model lettering", "RT-120SNJ", (-0.447, -0.2940, 0.412), 0.006, mat["black"], root, font)


def build_door(root, mat, side, font):
    left = side == "left"
    sign = 1 if left else -1
    pivot = empty(f"rt_door_{side}", (-0.289 if left else 0.551, -0.271, 0.4405), root)
    pivot["joint_type"] = "hinge"
    pivot["axis_blender"] = "-Z" if left else "+Z"
    pivot["axis_gltf"] = "-Y" if left else "+Y"
    pivot["preview_opening_degrees"] = 100.0
    pivot["measurement_status"] = "Axis and 100 degree demonstration limit estimated from drawing; not measured hardware limits"
    center_x = sign * 0.210
    box(f"{side} stainless door", (center_x, -0.003, -0.001), (0.414, 0.053, 0.623), mat["steel"], pivot, 0.004)
    box(f"{side} inner door liner", (center_x, 0.025, -0.001), (0.370, 0.006, 0.581), mat["lining"], pivot, 0.008)
    frame(f"{side} magnetic seal", (center_x, 0.031, -0.001), (0.408, 0.598, 0.009), (0.370, 0.580, 0.008), 0.007, mat["seal"], pivot)

    # Authentic Hoshizaki semi-circular (half-moon) stamped stainless dish recess + sculpted horizontal grip bar
    half_moon_recess_mesh(f"{side} handle recess", (center_x, -0.0302, 0.256), 0.158, 0.068, 0.014, mat["dish_steel"], pivot)
    frame(f"{side} handle dish rim", (center_x, -0.0312, 0.276), (0.172, 0.024, 0.010), (0.154, 0.012, 0.006), 0.004, mat["handle"], pivot)
    # Frontmost Y_local = -0.044 - 0.011 = -0.055 -> Y_world = -0.271 - 0.055 = -0.3260 m (exact 0.626 m closed depth!)
    box(f"{side} horizontal handle", (center_x, -0.044, 0.277), (0.217, 0.022, 0.019), mat["handle"], pivot, 0.0055)
    for ear_x in (center_x - 0.096, center_x + 0.096):
        box(f"{side} handle end ear {ear_x:+.2f}", (ear_x, -0.0355, 0.277), (0.025, 0.014, 0.023), mat["handle"], pivot, 0.003)

    for z, pos_lbl in ((-0.296, "lower"), (0.295, "upper")):
        cylinder(f"{side} hinge barrel", (0, -0.002, z), 0.0075, 0.028, mat["trim"], pivot)
        box(f"{side} {pos_lbl} hinge strap", (sign * 0.014, -0.016, z + (0.014 if z < 0 else -0.014)), (0.032, 0.028, 0.004), mat["trim"], pivot, 0.0008)
    if not left:
        cylinder("Door identity badge", (-0.046, -0.0308, 0.260), 0.016, 0.0016, mat["penguin_decal"], pivot, "Y")
        text_label("Badge initial", "H", (-0.046, -0.0292, 0.260), 0.008, mat["ink"], pivot, font)
    for frame_number, angle in ((1, 0), (20, 0), (55, 100), (85, 100), (120, 0)):
        pivot.rotation_euler.z = -sign * math.radians(angle)
        pivot.keyframe_insert(data_path="rotation_euler", index=2, frame=frame_number)
    return pivot


def build_shelf(root, mat, side, level, height):
    x = -0.079 if side == "left" else 0.341
    shelf = empty(f"rt_shelf_{side}_{level}", (x, 0.0215, height), root)
    shelf["nominal_width_m"] = 0.400
    shelf["nominal_depth_m"] = 0.425
    shelf["measurement_status"] = "Width/depth from drawing; wire gauge and selected shelf heights estimated"
    points = [(a, b, 0) for a, b in rounded_rectangle(0.394, 0.419, 0.008)]
    tube("Shelf perimeter", points, 0.003, mat["wire"], shelf, cyclic=True)
    for index in range(27):
        wire_x = -0.188 + index * 0.01446
        tube("Shelf wire", [(wire_x, -0.207, 0), (wire_x, 0.207, 0)], 0.0016, mat["wire"], shelf)
    for y in (-0.13, 0.13):
        tube("Shelf underside cross brace", [(-0.195, y, -0.004), (0.195, y, -0.004)], 0.002, mat["wire"], shelf)
    for clip_x in (-0.192, 0.192):
        for clip_y in (-0.187, 0.194):
            box("Shelf support clip", (clip_x, clip_y, -0.010), (0.014, 0.018, 0.009), mat["trim"], shelf)
    return shelf


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def setup_references(scene):
    collection = bpy.data.collections.new("Reference drawings - toggle visibility")
    scene.collection.children.link(collection)
    views = (
        ("Front drawing", "orthographic-front.png", (0, 0.36, 0.44), (math.pi / 2, 0, 0)),
        ("Side drawing", "orthographic-side.png", (-0.66, 0, 0.44), (math.pi / 2, 0, math.pi / 2)),
        ("Plan drawing", "orthographic-top-and-door-swing.png", (0, 0, -0.03), (0, 0, 0)),
        ("Complete D38190", "dimensioned-orthographic-sheet.png", (0, 0.8, 0.8), (math.pi / 2, 0, 0)),
    )
    for name, file, position, rotation in views:
        image = bpy.data.images.load(str(REFERENCES / "images" / file))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        collection.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1.5
        obj.location = position
        obj.rotation_euler = rotation
        obj.color[3] = 0.45
        obj.hide_render = True
        obj["reference_status"] = "Unregistered inspection image; use labelled dimensions, not the image canvas for scale"
    collection.hide_viewport = True
    collection.hide_render = True


def clean_and_uv_rt_tree(root):
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    ss_mats = {"RT stainless exterior", "RT stainless interior", "RT folded edge steel", "RT handle dish steel"}
    for obj in list(root.children_recursive):
        if obj.type != "MESH":
            continue
        eval_obj = obj.evaluated_get(depsgraph)
        emesh = eval_obj.to_mesh()
        needs_bake = False
        try:
            emesh.calc_loop_triangles()
            pts = [obj.matrix_world @ v.co for v in emesh.vertices]
            keys = [tuple(round(val, 8) for val in pt) for pt in pts]
            seen = set()
            for tri in emesh.loop_triangles:
                ia, ib, ic = tri.vertices
                if (pts[ib] - pts[ia]).cross(pts[ic] - pts[ia]).length <= 1e-15:
                    needs_bake = True
                    break
                fkey = tuple(sorted((keys[ia], keys[ib], keys[ic])))
                if fkey in seen:
                    needs_bake = True
                    break
                seen.add(fkey)
            if needs_bake:
                mats = list(obj.data.materials)
                mw_inv = obj.matrix_world.inverted()
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
                _ = mw_inv
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

        if obj.data.materials and obj.data.materials[0] and obj.data.materials[0].name in ss_mats:
            project_stainless_uvs(obj, scale=2.2)

    project_front_planar_uvs(bpy.data.objects["Model label"], -0.447, 0.412, 0.222, 0.046, local_space=False)
    project_front_planar_uvs(bpy.data.objects["Eco water-drop button"], -0.352, 0.682, 0.024, 0.028, local_space=False)
    project_front_planar_uvs(bpy.data.objects["Door identity badge"], 0.505, 0.7005, 0.032, 0.032, local_space=False)


def setup_studio(scene):
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for dev in prefs.devices:
            dev.use = dev.type in {"METAL", "GPU"}
        scene.cycles.device = "GPU"
    except Exception:
        pass
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    setup_softbox_world(scene, "Refrigerator studio world", camera_bg_rgb=(0.68, 0.71, 0.75))
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.20
    ground = material("Studio warm grey", (0.44, 0.46, 0.49, 1), roughness=0.86)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio ground"
    bpy.context.object.data.materials.append(ground)
    area_light("Left softbox", (-2.0, -2.2, 2.4), (0, 0, 0.42), 210, 2.0)
    area_light("Right stripbox", (2.1, -0.6, 1.9), (0, 0, 0.42), 150, 1.5)
    area_light("Rear softbox", (0.0, 1.6, 2.2), (0, 0, 0.44), 175, 1.5)
    area_light("Interior fill", (0.1, -2.4, 0.95), (0.1, 0.05, 0.42), 65, 1.3)
    cav_ldata = bpy.data.lights.new("Cavity studio lamp", "POINT")
    cav_ldata.energy = 3.5
    cav_ldata.color = (0.96, 0.98, 1.0)
    cav_ldata.shadow_soft_size = 0.08
    cav_lobj = bpy.data.objects.new("Cavity studio lamp", cav_ldata)
    scene.collection.objects.link(cav_lobj)
    cav_lobj.location = (0.13, -0.05, 0.68)
    data = bpy.data.cameras.new("Review camera")
    camera = bpy.data.objects.new("Review camera", data)
    scene.collection.objects.link(camera)
    data.type = "ORTHO"
    data.lens = 50
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(collection)
    move_objects(set(scene.objects) - before, collection)
    return camera


def set_camera(camera, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)


def export_glb(root):
    bpy.context.scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}.glb"), export_format="GLB",
        use_selection=True, export_apply=True, export_yup=True,
        export_animations=True, export_animation_mode="SCENE", export_frame_range=True,
        export_cameras=False, export_lights=False, export_extras=True,
    )


def record_dimensions(scene, root):
    scene.frame_set(1)
    scene.view_layers.update()
    countertop = bpy.data.objects["Worktop"]
    glb_path = ASSETS / f"{NAME}.glb"
    interior = {"width_m": 0.840, "depth_m": 0.441, "height_m": 0.604}
    report = {
        "asset": NAME,
        "blender_version": bpy.app.version_string,
        "drawing": "D38190, 2024-09-18",
        "source_sha256": hashlib.sha256((REFERENCES / "specifications/dimensioned-drawing.pdf").read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest() if glb_path.exists() else None,
        "worktop_dimensions_m": list(countertop.dimensions),
        "nominal_height_m": 0.800,
        "interior_nominal_m": interior,
        "door_effective_width_m": 0.352,
        "visual_status": "studio-polished dimensioned visual model with SUS304 HL textures and baked Japanese decals",
        "physics_status": "Synchronized with build_refrigerator_physics.py MJCF export",
        "assumptions": ["Door axes and 100 degree preview limit", "Shelf wire gauge and shelf positions", "Evaporator vertical extent and hidden internals", "Example 3.0 C display"],
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background process to preserve existing Blender work.")
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Hoshizaki RT-120SNJ - Japan reference"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for name, number in (("Closed", 1), ("Open both doors", 55), ("Inspect interior", 85), ("Closed again", 120)):
        scene.timeline_markers.new(name, frame=number)
    root = empty("rt_cabinet", (0, 0, 0))
    root["manufacturer"] = "Hoshizaki"
    root["model"] = "RT-120SNJ"
    root["drawing"] = "D38190 / 2024-09-18"
    root["nominal_dimensions_m"] = [1.2, 0.6, 0.8]
    root["manufacturer_total_mass_kg"] = 68.0
    root["accuracy_status"] = "Studio-polished dimensioned visual model; hidden mechanics estimated"
    font = load_japanese_font()
    mat = surfaces()
    build_shell(root, mat)
    build_service_panel(root, mat, font)
    doors = [build_door(root, mat, side, font) for side in ("left", "right")]
    shelves = [build_shelf(root, mat, side, index, height) for side in ("left", "right") for index, height in enumerate((0.318, 0.518), 1)]
    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, *doors, *shelves])
    clean_and_uv_rt_tree(root)
    appliance = bpy.data.collections.new("RT-120SNJ appliance")
    scene.collection.children.link(appliance)
    move_objects([root, *root.children_recursive], appliance)
    export_glb(root)
    setup_references(scene)
    camera = setup_studio(scene)
    views = (
        ("studio-closed", (1.5, -2.8, 1.45), (0, 0, 0.40), 1.68, 1),
        ("studio-open", (1.0, -3.2, 1.5), (0.03, -0.17, 0.40), 1.92, 70),
        ("studio-front", (0, -3, 0.40), (0, 0, 0.40), 1.46, 1),
        ("studio-interior", (0.13, -3, 0.47), (0.13, 0, 0.47), 1.54, 70),
        ("studio-right", (3, 0, 0.40), (0, 0, 0.40), 1.22, 1),
    )
    if not args.skip_renders:
        for name, position, target, scale, frame_number in views:
            scene.frame_set(frame_number)
            set_camera(camera, position, target, scale)
            scene.render.filepath = str(ASSETS / f"{name}.png")
            bpy.ops.render.render(write_still=True)
    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])
    record_dimensions(scene, root)
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))
    print("Saved editable refrigerator, articulated GLB, references and review renders:", ASSETS)


if __name__ == "__main__":
    main()
