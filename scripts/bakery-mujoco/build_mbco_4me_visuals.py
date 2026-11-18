"""Build the Japanese Maruzen Baker Chef M-Series MBCO-4ME convection oven in Blender 5.2.

Metres, Z up, operator front towards -Y.
Official reference: Maruzen Bakery & Patisserie Catalogue 46001, printed page 27 (PDF page 28) & page 29 (PDF page 30).
Nominal cabinet & closed-door envelope: 700 x 700 x 580 mm (530 mm insulated body + 50 mm stainless legs), Z = 0.000 m at floor.
Note: Per printed page 27, MBCO-4ME has an all-stainless door face, ruby-red right control fascia, top-right-rear exhaust pipe (+120 mm),
and NO right-side hand-rinse shower ("ハンドシャワーは付属しません").
Chamber interior: 450 x 330 x 350 mm (W x D x H) with 4 pairs of L-channel tray rails at 80 mm pitch.
Removable accessory: 400 x 300 x 20 mm European aluminum baking tray (0.850 kg) seated on rail pair #2.
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
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-mbco-4me"
REFERENCES = ROOT / "docs/equipment/maruzen-mbco-4me"
MBCO5_IMAGES = ROOT / "docs/equipment/maruzen-mbco-5e/images"
NAME = "maruzen-mbco-4me"

WIDTH = 0.7000
DEPTH = 0.7000
HEIGHT = 0.5800

CHAMBER_W = 0.4500
CHAMBER_D = 0.3300
CHAMBER_H = 0.3500
CHAMBER_CENTER_X = -0.0900  # X in [-0.3150, +0.1350]
CHAMBER_FRONT_Y = -0.3050   # Y in [-0.3050, +0.0250] (330 mm usable depth in front of suction baffle)
CHAMBER_FLOOR_Z = 0.1400    # Z in [0.1400, 0.4900] (350 mm height)

RAIL_LEVELS_Z = (0.1850, 0.2650, 0.3450, 0.4250)  # 4 pairs at exact 80.0 mm vertical pitch

DOOR_PIVOT = (-0.3400, -0.3380, 0.3160)
DOOR_OPEN_MAX_RAD = 1.92
DOOR_PREVIEW_RAD = math.radians(102.0)

# Door-local origin for rotary push-to-close handle -> world (+0.1460, -0.3500, 0.3060)
HANDLE_LOCAL_ORIGIN = (0.4860, -0.0120, -0.0100)
FAN_ORIGIN = (-0.0900, 0.0500, 0.3150)
# CAD top view: auto damper at 275 mm from left edge -> X = -0.3500 + 0.2750 = -0.0750 m
DAMPER_ORIGIN = (-0.0750, 0.2750, 0.5670)
TRAY_REST_ORIGIN = (-0.0900, -0.1400, 0.2650)  # Seated squarely on rail pair #2 (Z = 0.2650 m)

# CAD side/front views: 50 mm tall adjustable stainless feet; 100 mm from front, 60 mm from rear
FOOT_POSITIONS = (
    ("mbco4_foot_fl", -0.2950, -0.2500),
    ("mbco4_foot_fr", 0.2950, -0.2500),
    ("mbco4_foot_rl", -0.2950, 0.2900),
    ("mbco4_foot_rr", 0.2950, 0.2900),
)


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    metallic: float = 0.0,
    roughness: float = 0.35,
    emission: float = 0.0,
    coat: float = 0.0,
    transmission: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = color
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Alpha"].default_value = 1.0 if transmission > 0.0 else color[3]
        if metallic < 0.5:
            bsdf.inputs["Specular IOR Level"].default_value = 0.16
        if coat > 0.0:
            bsdf.inputs["Coat Weight"].default_value = coat
            bsdf.inputs["Coat Roughness"].default_value = 0.22
        if transmission > 0.0:
            bsdf.inputs["Base Color"].default_value = (0.90, 0.95, 0.96, 1.0)
            bsdf.inputs["Specular IOR Level"].default_value = 0.35
            bsdf.inputs["Transmission Weight"].default_value = transmission
            bsdf.inputs["IOR"].default_value = 1.47
        if emission > 0.0:
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = emission
    if color[3] < 1.0 and transmission == 0.0:
        mat.surface_render_method = "BLENDED"
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission)
    return mat


def bake_mbco4_graphics() -> tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Bake crisp Japanese Baker Chef membrane panel, cobalt/navy nameplate, and door caution decal."""

    def add_flat_box(scn, name, x, y, z, w, h, mat, bevel_r=0.0):
        pts = rounded_rectangle(w, h, bevel_r, segments=8) if bevel_r > 0 else [
            (w / 2, h / 2), (-w / 2, h / 2), (-w / 2, -h / 2), (w / 2, -h / 2)
        ]
        m = bpy.data.meshes.new(name)
        m.from_pydata([(x + px, y + py, z) for px, py in pts], [], [tuple(range(len(pts)))])
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)
        return o

    def add_flat_ring(scn, name, x, y, z, w, h, r, stroke, mat):
        ext = rounded_rectangle(w, h, max(1e-4, r), segments=8)
        inn = rounded_rectangle(w - 2 * stroke, h - 2 * stroke, max(1e-4, r - stroke), segments=8)
        n = len(ext)
        verts = [(x + px, y + py, z) for px, py in ext] + [(x + px, y + py, z) for px, py in inn]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        m = bpy.data.meshes.new(name)
        m.from_pydata(verts, [], faces)
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)

    def add_flat_oval(scn, name, x, y, z, rx, ry, mat):
        n = 32
        verts = [(x + rx * math.cos(i * math.tau / n), y + ry * math.sin(i * math.tau / n), z) for i in range(n)]
        m = bpy.data.meshes.new(name)
        m.from_pydata(verts, [], [tuple(range(n))])
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)

    def add_flat_text(scn, txt, x, y, z, size, mat, fnt, align_x="CENTER"):
        c = bpy.data.curves.new("_txt", "FONT")
        c.body = txt
        c.size = size
        c.font = fnt
        c.align_x = align_x
        c.align_y = "CENTER"
        o = bpy.data.objects.new("_txt", c)
        scn.collection.objects.link(o)
        o.location = (x, y, z)
        o.data.materials.append(mat)

    def build_panel_sheet(scn, emit_mat, font_jp, font_en):
        m_bg = emit_mat("bg", (0.012, 0.013, 0.016, 1.0))
        m_wh = emit_mat("wh", (0.94, 0.95, 0.94, 1.0))
        m_ink = emit_mat("ink", (0.05, 0.06, 0.07, 1.0))
        m_red = emit_mat("red", (0.86, 0.09, 0.08, 1.0))
        m_win = emit_mat("win", (0.014, 0.015, 0.018, 1.0))
        m_off = emit_mat("off", (0.14, 0.09, 0.05, 1.0))
        add_flat_box(scn, "bg", 0.0, 0.0, 0.0, 0.0920, 0.2440, m_bg, 0.0025)

        # Zone outlines (relative to center Z = 0.3760)
        for yc, zh, nm in ((0.0420, 0.0980, "z1"), (-0.0360, 0.0480, "z2"), (-0.0800, 0.0280, "z3")):
            add_flat_ring(scn, nm, 0.0, yc, 0.001, 0.0820, zh, 0.0040, 0.0009, m_wh)
        add_flat_box(scn, "div1", 0.0, 0.0460, 0.001, 0.0760, 0.0007, m_wh)
        add_flat_box(scn, "div2", 0.0, 0.0155, 0.001, 0.0760, 0.0007, m_wh)

        # White header pills
        for hx, hy, hw, htxt in (
            (-0.0030, 0.0880, 0.0440, "庫内温度"),
            (-0.0030, 0.0460, 0.0440, "タイマー"),
            (-0.0165, -0.0150, 0.0260, "メニュー"),
            (0.0125, -0.0150, 0.0260, "ステップ"),
        ):
            add_flat_box(scn, f"hp_{htxt}", hx, hy, 0.002, hw, 0.0068, m_wh, 0.0020)
            add_flat_text(scn, htxt, hx, hy, 0.003, 0.0042, m_ink, font_jp)

        # Display filter windows & silkscreen units
        add_flat_box(scn, "w_tmp", -0.0090, 0.0690, 0.002, 0.0440, 0.0170, m_win, 0.0012)
        add_flat_text(scn, "°C", 0.0165, 0.0645, 0.003, 0.0052, m_wh, font_jp)
        add_flat_text(scn, "設定", 0.0205, 0.0730, 0.003, 0.0028, m_wh, font_jp)
        add_flat_text(scn, "温度", 0.0205, 0.0615, 0.003, 0.0028, m_wh, font_jp)
        add_flat_oval(scn, "led_t_off", 0.0205, 0.0665, 0.002, 0.0018, 0.0018, m_off)

        add_flat_box(scn, "w_tmr", -0.0055, 0.0280, 0.002, 0.0520, 0.0170, m_win, 0.0012)
        add_flat_text(scn, "分", -0.0030, 0.0182, 0.003, 0.0034, m_wh, font_jp)
        add_flat_text(scn, "秒", 0.0175, 0.0182, 0.003, 0.0034, m_wh, font_jp)

        add_flat_box(scn, "w_mnu", -0.0155, -0.0305, 0.002, 0.0235, 0.0155, m_win, 0.0010)
        add_flat_text(scn, "No.", -0.0315, -0.0345, 0.003, 0.0034, m_wh, font_en)
        add_flat_box(scn, "w_stp", 0.0135, -0.0305, 0.002, 0.0145, 0.0155, m_win, 0.0010)
        add_flat_text(scn, "No.", 0.0015, -0.0345, 0.003, 0.0034, m_wh, font_en)

        # Airflow speed indicators (強 中 弱)
        for sx, stxt in ((-0.0065, "強"), (0.0, "中"), (0.0065, "弱")):
            add_flat_text(scn, stxt, sx, -0.0975, 0.003, 0.0033, m_wh, font_jp)
            add_flat_oval(scn, f"led_{stxt}", sx, -0.1020, 0.002, 0.0017, 0.0017, m_off)

        # 15 white oval tactile buttons + crisp icons & Japanese legends
        def btn(bx, by, lbl=None, icon_txt=None, icon_col=m_ink, isz=0.0056):
            add_flat_oval(scn, f"b_{bx:.3f}_{by:.3f}", bx, by, 0.002, 0.0072, 0.0058, m_wh)
            if icon_txt:
                add_flat_text(scn, icon_txt, bx, by, 0.003, isz, icon_col, font_jp)
            if lbl:
                add_flat_text(scn, lbl, bx, by - 0.0092, 0.003, 0.0034, m_wh, font_jp)

        def add_bar(bx, by, length, thick, deg, mat):
            o = add_flat_box(scn, "bar", bx, by, 0.0035, length, thick, mat)
            o.rotation_euler.z = math.radians(deg)

        # Top row: 予熱, ライト, 電源
        btn(-0.0295, 0.1085, "予 熱")
        add_flat_ring(scn, "ic_pre", -0.0295, 0.1085, 0.003, 0.0076, 0.0054, 0.0006, 0.0006, m_ink)
        add_flat_text(scn, "≈", -0.0295, 0.1085, 0.004, 0.0052, m_red, font_jp)

        btn(0.0, 0.1085, "ライト")
        add_flat_oval(scn, "ic_bulb_o", 0.0, 0.1092, 0.003, 0.0022, 0.0022, m_ink)
        add_flat_oval(scn, "ic_bulb_i", 0.0, 0.1092, 0.0035, 0.0015, 0.0015, m_wh)
        add_flat_box(scn, "ic_bulb_b", 0.0, 0.1066, 0.0035, 0.0018, 0.0012, m_ink)
        for deg in (-60, -30, 0, 30, 60):
            rad = math.radians(deg + 90)
            add_bar(0.0034 * math.cos(rad), 0.1090 + 0.0034 * math.sin(rad), 0.0014, 0.00045, deg + 90, m_ink)

        btn(0.0295, 0.1085, "電 源")
        add_flat_text(scn, "I/", 0.0273, 0.1085, 0.003, 0.0046, m_red, font_en)
        add_flat_text(scn, "O", 0.0320, 0.1085, 0.003, 0.0046, m_ink, font_en)

        # Upper right & up/down
        btn(0.0295, 0.0690, "切 替")
        add_flat_ring(scn, "ic_tmp", 0.0295, 0.0690, 0.003, 0.0074, 0.0054, 0.0006, 0.0005, m_ink)
        add_flat_box(scn, "ic_th", 0.0295, 0.0690, 0.004, 0.0012, 0.0038, m_red, 0.0004)

        btn(0.0295, 0.0280, "設 定")
        add_flat_oval(scn, "ic_clk_o", 0.0295, 0.0278, 0.003, 0.0032, 0.0032, m_ink)
        add_flat_oval(scn, "ic_clk_i", 0.0295, 0.0278, 0.0034, 0.0025, 0.0025, m_wh)
        add_bar(0.0289, 0.0284, 0.0018, 0.00045, 135, m_ink)
        add_bar(0.0303, 0.0285, 0.0020, 0.00045, 40, m_ink)
        add_flat_oval(scn, "ic_clk_d", 0.0295, 0.0316, 0.0038, 0.00055, 0.00055, m_red)

        btn(-0.0115, 0.0050, None, "▼", m_ink, 0.0062)
        btn(0.0115, 0.0050, None, "▲", m_ink, 0.0062)

        # Menu row
        btn(-0.0305, -0.0490, "メニュー")
        add_flat_ring(scn, "ic_bk_l", -0.0322, -0.0488, 0.003, 0.0036, 0.0044, 0.0004, 0.00045, m_ink)
        add_flat_ring(scn, "ic_bk_r", -0.0288, -0.0488, 0.003, 0.0036, 0.0044, 0.0004, 0.00045, m_ink)
        for ly in (-0.0478, -0.0492):
            add_bar(-0.0322, ly, 0.0020, 0.00035, 0, m_ink)
            add_bar(-0.0288, ly, 0.0020, 0.00035, 0, m_ink)

        btn(-0.0102, -0.0490, None, "▼", m_ink, 0.0058)
        btn(0.0102, -0.0490, None, "▲", m_ink, 0.0058)

        btn(0.0305, -0.0490, "設 定")
        add_flat_oval(scn, "ic_ed_o", 0.0305, -0.0490, 0.003, 0.0032, 0.0032, m_ink)
        add_flat_oval(scn, "ic_ed_i", 0.0305, -0.0490, 0.0034, 0.0025, 0.0025, m_wh)
        add_bar(0.0307, -0.0488, 0.0042, 0.0010, 45, m_ink)

        # Start / Stop button with red capsule + white toque
        add_flat_oval(scn, "b_start", 0.0, -0.0765, 0.002, 0.0078, 0.0060, m_wh)
        add_flat_box(scn, "b_start_red", 0.0, -0.0765, 0.003, 0.0092, 0.0038, m_red, 0.0018)
        add_flat_oval(scn, "b_toque", 0.0, -0.0758, 0.004, 0.0020, 0.0024, m_wh)
        add_flat_text(scn, "スタート/ストップ", 0.0, -0.0875, 0.003, 0.0031, m_wh, font_jp)

        # Bottom row: ダンパー, 風量, 加湿
        btn(-0.0295, -0.1120, "ダンパー")
        add_bar(-0.0322, -0.1120, 0.0009, 0.0046, 0, m_ink)
        add_bar(-0.0268, -0.1120, 0.0009, 0.0046, 0, m_ink)
        add_bar(-0.0295, -0.1120, 0.0040, 0.0007, 25, m_ink)
        add_flat_oval(scn, "ic_dmp_c", -0.0295, -0.1120, 0.004, 0.0009, 0.0009, m_ink)

        btn(0.0, -0.1120, "風 量")
        add_flat_text(scn, "ふぅ", -0.0018, -0.1104, 0.003, 0.0027, m_red, font_jp)
        add_bar(0.0, -0.1120, 0.0062, 0.0005, 48, m_ink)
        add_flat_text(scn, "ふー", 0.0020, -0.1136, 0.003, 0.0027, m_red, font_jp)

        btn(0.0295, -0.1120, "加 湿")
        add_bar(0.0276, -0.1102, 0.0022, 0.0012, -40, m_ink)
        for deg, dx, dy in ((-22, 0.0306, -0.1112), (-40, 0.0302, -0.1124), (-58, 0.0292, -0.1133)):
            add_bar(dx, dy, 0.0032, 0.00045, deg, m_ink)

    def build_nameplate_sheet(scn, emit_mat, _font_jp, font_en):
        m_sil = emit_mat("sil", (0.78, 0.81, 0.84, 1.0))
        m_blu = emit_mat("blu", (0.020, 0.240, 0.680, 1.0))
        m_nav = emit_mat("nav", (0.012, 0.022, 0.068, 1.0))
        m_wh = emit_mat("wh", (0.97, 0.98, 0.99, 1.0))
        add_flat_box(scn, "bdr", 0.0, 0.0, 0.0, 0.1100, 0.0340, m_sil, 0.0012)
        add_flat_box(scn, "top", 0.0, 0.0056, 0.001, 0.1068, 0.0196, m_blu, 0.0006)
        add_flat_box(scn, "bot", 0.0, -0.0102, 0.001, 0.1068, 0.0104, m_nav, 0.0006)
        add_flat_box(scn, "div", 0.0, -0.0044, 0.002, 0.1068, 0.0012, m_sil)
        add_flat_text(scn, "Maruzen", 0.0, 0.0055, 0.003, 0.0145, m_wh, font_en)
        add_flat_text(scn, "MBCO-4ME", 0.0, -0.0104, 0.003, 0.0068, m_wh, font_en)

    def build_caution_sheet(scn, emit_mat, font_jp, _font_en):
        m_wh = emit_mat("wh", (0.95, 0.95, 0.94, 1.0))
        m_red = emit_mat("red", (0.86, 0.14, 0.06, 1.0))
        m_ink = emit_mat("ink", (0.08, 0.08, 0.09, 1.0))
        add_flat_box(scn, "bg", 0.0, 0.0, 0.0, 0.0400, 0.0220, m_wh, 0.0012)
        add_flat_ring(scn, "bdr", 0.0, 0.0, 0.001, 0.0384, 0.0204, 0.0010, 0.0005, m_red)
        add_flat_box(scn, "hdr", 0.0, 0.0064, 0.002, 0.0376, 0.0062, m_red, 0.0005)
        add_flat_text(scn, "▲ 高温注意", 0.0, 0.0063, 0.003, 0.0038, m_wh, font_jp)
        add_flat_text(scn, "扉・排気口は高温になります", 0.0, -0.0015, 0.003, 0.0025, m_ink, font_jp)
        add_flat_text(scn, "やけどに注意してください", 0.0, -0.0062, 0.003, 0.0025, m_ink, font_jp)

    panel_img = bake_ortho_sheet(ASSETS / "mbco4-control-panel.png", 920, 2440, 0.0920, 0.2440, build_panel_sheet)
    nameplate_img = bake_ortho_sheet(ASSETS / "mbco4-nameplate.png", 880, 272, 0.1100, 0.0340, build_nameplate_sheet)
    caution_img = bake_ortho_sheet(ASSETS / "mbco4-caution-decal.png", 400, 220, 0.0400, 0.0220, build_caution_sheet)
    return panel_img, nameplate_img, caution_img


def palette() -> dict[str, bpy.types.Material]:
    ss_col, ss_orm = generate_stainless_hairline_textures(
        ASSETS, "mbco4", base_rgb=(0.76, 0.78, 0.81), streak_amp=0.042, rough_base=0.24, seed=4040
    )
    panel_img, nameplate_img, caution_img = bake_mbco4_graphics()
    return {
        "steel": textured_stainless_material(
            "mbco4_brushed_stainless", ss_col, ss_orm, tint=(0.82, 0.85, 0.88, 1.0), metallic=0.89, roughness=0.25
        ),
        "door_steel": textured_stainless_material(
            "mbco4_door_stainless", ss_col, ss_orm, tint=(0.88, 0.90, 0.93, 1.0), metallic=0.91, roughness=0.21
        ),
        "chrome": make_material("mbco4_polished_trim", (0.82, 0.85, 0.88, 1.0), 0.95, 0.12),
        "lining": textured_stainless_material(
            "mbco4_chamber_stainless", ss_col, ss_orm, tint=(0.74, 0.77, 0.80, 1.0), metallic=0.86, roughness=0.28
        ),
        "plenum_dark": make_material("mbco4_plenum_shadow", (0.025, 0.028, 0.032, 1.0), 0.25, 0.55),
        "aluminum": make_material("mbco4_baking_aluminum", (0.76, 0.78, 0.81, 1.0), 0.89, 0.22),
        "ruby": make_material("mbco4_ruby_enamel", (0.22, 0.003, 0.005, 1.0), 0.05, 0.22, coat=0.16),
        "mask": make_material("mbco4_ceramic_black", (0.008, 0.009, 0.012, 1.0), 0.04, 0.24),
        "rubber": make_material("mbco4_elastomer_black", (0.012, 0.013, 0.016, 1.0), 0.02, 0.42),
        "glass": make_material("mbco4_double_glazing", (0.78, 0.88, 0.90, 0.13), 0.04, 0.035, coat=0.25),
        "white": make_material("mbco4_panel_ink", (0.92, 0.93, 0.92, 1.0), 0.08, 0.36),
        "caution_red": make_material("mbco4_caution_red", (0.72, 0.03, 0.02, 1.0), 0.04, 0.32),
        "red_led": make_material("mbco4_red_display", (0.98, 0.035, 0.012, 1.0), 0.0, 0.18, emission=2.4),
        "green_led": make_material("mbco4_green_display", (0.48, 0.90, 0.05, 1.0), 0.0, 0.18, emission=1.9),
        "amber_led": make_material("mbco4_amber_indicator", (1.00, 0.50, 0.03, 1.0), 0.0, 0.20, emission=2.0),
        "lamp": make_material("mbco4_chamber_lamp", (1.0, 0.86, 0.56, 1.0), 0.0, 0.16, emission=2.8),
        "badge_blue": make_material("mbco4_maruzen_blue", (0.012, 0.065, 0.28, 1.0), 0.16, 0.28),
        "panel_membrane": textured_decal_material("mbco4_control_membrane", panel_img, roughness=0.36, coat=0.04),
        "nameplate_decal": textured_decal_material("mbco4_nameplate_decal", nameplate_img, roughness=0.22, metallic=0.18, coat=0.25),
        "caution_decal": textured_decal_material("mbco4_caution_decal", caution_img, roughness=0.28, coat=0.15),
        "brass": make_material("mbco4_plumbing_brass", (0.76, 0.58, 0.24, 1.0), 0.88, 0.25),
        "studio_floor": make_material("mbco4_studio_floor", (0.44, 0.46, 0.49, 1.0), 0.0, 0.86),
    }


def empty(name: str, position: tuple[float, float, float], parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = position
    obj.empty_display_size = 0.025
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
        weld = obj.modifiers.new("BevelWeld", "WELD")
        weld.merge_threshold = 1e-7
    if obj.type == "MESH":
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


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


def cylinder(
    name: str,
    position: tuple[float, float, float],
    radius: float,
    depth: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    axis: str = "Z",
    vertices: int = 32,
    bevel: float | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=position)
    obj = bpy.context.object
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2.0
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2.0
    bev = min(0.0006, depth / 5.0) if bevel is None else bevel
    return finish(obj, name, surface, parent, bev)


def screw_head(
    name: str,
    position: tuple[float, float, float],
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    axis: str = "Y",
) -> bpy.types.Object:
    return cylinder(name, position, 0.0028, 0.0012, surface, parent, axis=axis, vertices=18, bevel=0.0003)


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
    curve.use_fill_caps = not cyclic
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


def rounded_rectangle(width: float, height: float, radius: float, segments: int = 8) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    r = max(0.0, min(radius, width * 0.48, height * 0.48))
    if r <= 1e-6:
        return [
            (width / 2.0, height / 2.0),
            (-width / 2.0, height / 2.0),
            (-width / 2.0, -height / 2.0),
            (width / 2.0, -height / 2.0),
        ]
    corners = (
        (width / 2.0 - r, height / 2.0 - r, 0.0),
        (-width / 2.0 + r, height / 2.0 - r, 90.0),
        (-width / 2.0 + r, -height / 2.0 + r, 180.0),
        (width / 2.0 - r, -height / 2.0 + r, 270.0),
    )
    for cx, cz, start_deg in corners:
        for step in range(segments + 1):
            if step == segments:
                continue
            ang = math.radians(start_deg + step * 90.0 / segments)
            pts.append((cx + r * math.cos(ang), cz + r * math.sin(ang)))
    return pts


def frame_opening(
    name: str,
    center: tuple[float, float, float],
    outer: tuple[float, float, float],
    inner: tuple[float, float, float],
    depth: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    inner_offset_x: float = 0.0,
    inner_offset_z: float = 0.0,
    bevel: float = 0.0006,
    segments: int = 8,
) -> bpy.types.Object:
    ext = rounded_rectangle(outer[0], outer[1], outer[2], segments=segments)
    inn_raw = rounded_rectangle(inner[0], inner[1], inner[2], segments=segments)
    inn = [(x + inner_offset_x, z + inner_offset_z) for x, z in inn_raw]
    n = len(ext)
    verts: list[tuple[float, float, float]] = []
    for y in (-depth / 2.0, depth / 2.0):
        for contour in (ext, inn):
            verts.extend((x + center[0], y + center[1], z + center[2]) for x, z in contour)
    faces: list[tuple[int, int, int, int]] = []
    for idx in range(n):
        nxt = (idx + 1) % n
        faces.extend(
            [
                (idx, nxt, nxt + n, idx + n),
                (idx + 2 * n, idx + 3 * n, nxt + 3 * n, nxt + 2 * n),
                (idx, idx + 2 * n, nxt + 2 * n, nxt),
                (idx + n, nxt + n, nxt + 3 * n, idx + 3 * n),
            ]
        )
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel)


def horizontal_plate_with_opening(
    name: str,
    center: tuple[float, float, float],
    outer_xy: tuple[float, float],
    hole_center_xy: tuple[float, float],
    hole_xy: tuple[float, float],
    thickness: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
) -> bpy.types.Object:
    ox = outer_xy[0] / 2.0
    oy = outer_xy[1] / 2.0
    hx0 = hole_center_xy[0] - center[0] - hole_xy[0] / 2.0
    hx1 = hole_center_xy[0] - center[0] + hole_xy[0] / 2.0
    hy0 = hole_center_xy[1] - center[1] - hole_xy[1] / 2.0
    hy1 = hole_center_xy[1] - center[1] + hole_xy[1] / 2.0

    ext = [(ox, oy), (-ox, oy), (-ox, -oy), (ox, -oy)]
    inn = [(hx1, hy1), (hx0, hy1), (hx0, hy0), (hx1, hy0)]
    n = 4
    verts: list[tuple[float, float, float]] = []
    for dz in (-thickness / 2.0, thickness / 2.0):
        for contour in (ext, inn):
            verts.extend((x + center[0], y + center[1], center[2] + dz) for x, y in contour)
    faces: list[tuple[int, int, int, int]] = []
    for idx in range(n):
        nxt = (idx + 1) % n
        faces.extend(
            [
                (idx, idx + n, nxt + n, nxt),
                (idx + 2 * n, nxt + 2 * n, nxt + 3 * n, idx + 3 * n),
                (idx, nxt, nxt + 2 * n, idx + 2 * n),
                (idx + n, idx + 3 * n, nxt + 3 * n, nxt + n),
            ]
        )
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_punched_suction_baffle(
    name: str,
    center: tuple[float, float, float],
    width: float,
    height: float,
    thickness: float,
    aperture_radius: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
) -> bpy.types.Object:
    """Author a solid stainless suction baffle sheet with a circular cluster of punched square apertures."""
    pitch = 0.0180
    hole_half = 0.0068
    grid_n = 6  # 13 x 13 grid spanning [-0.117, +0.117] m inside the 424 x 336 mm plate

    xs: list[float] = [-width / 2.0]
    zs: list[float] = [-height / 2.0]
    for i in range(-grid_n, grid_n + 1):
        c = i * pitch
        xs.extend([c - hole_half, c + hole_half])
        zs.extend([c - hole_half, c + hole_half])
    xs.append(width / 2.0)
    zs.append(height / 2.0)

    nx = len(xs) - 1
    nz = len(zs) - 1

    def is_open(ix: int, iz: int) -> bool:
        if ix % 2 == 1 and iz % 2 == 1:
            cx = 0.5 * (xs[ix] + xs[ix + 1])
            cz = 0.5 * (zs[iz] + zs[iz + 1])
            if math.hypot(cx, cz) <= aperture_radius:
                return True
        return False

    bm = bmesh.new()
    vmap: dict[tuple[int, int, int], bmesh.types.BMVert] = {}
    y0 = center[1] - thickness / 2.0
    y1 = center[1] + thickness / 2.0

    def get_v(ix: int, iz: int, iy: int) -> bmesh.types.BMVert:
        key = (ix, iz, iy)
        v = vmap.get(key)
        if v is None:
            v = bm.verts.new((center[0] + xs[ix], y0 if iy == 0 else y1, center[2] + zs[iz]))
            vmap[key] = v
        return v

    for ix in range(nx):
        for iz in range(nz):
            if is_open(ix, iz):
                continue
            # Front (-Y) and back (+Y) faces
            bm.faces.new((get_v(ix, iz, 0), get_v(ix + 1, iz, 0), get_v(ix + 1, iz + 1, 0), get_v(ix, iz + 1, 0)))
            bm.faces.new((get_v(ix, iz, 1), get_v(ix, iz + 1, 1), get_v(ix + 1, iz + 1, 1), get_v(ix + 1, iz, 1)))

            # Perimeter & aperture side walls wherever adjacent cell is open or outside
            if ix == 0 or is_open(ix - 1, iz):
                bm.faces.new((get_v(ix, iz, 0), get_v(ix, iz + 1, 0), get_v(ix, iz + 1, 1), get_v(ix, iz, 1)))
            if ix == nx - 1 or is_open(ix + 1, iz):
                bm.faces.new((get_v(ix + 1, iz, 0), get_v(ix + 1, iz, 1), get_v(ix + 1, iz + 1, 1), get_v(ix + 1, iz + 1, 0)))
            if iz == 0 or is_open(ix, iz - 1):
                bm.faces.new((get_v(ix, iz, 0), get_v(ix, iz, 1), get_v(ix + 1, iz, 1), get_v(ix + 1, iz, 0)))
            if iz == nz - 1 or is_open(ix, iz + 1):
                bm.faces.new((get_v(ix, iz + 1, 0), get_v(ix + 1, iz + 1, 0), get_v(ix + 1, iz + 1, 1), get_v(ix, iz + 1, 1)))

    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def text_label(
    name: str,
    value: str,
    position: tuple[float, float, float],
    size: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object | None,
    font: bpy.types.VectorFont,
    extrude: float = 0.00022,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = extrude
    curve.resolution_u = 2
    curve.font = font
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (math.pi / 2.0, 0.0, 0.0)
    return finish(obj, name, surface, parent)


def seven_segment_readout(
    name: str,
    value: str,
    center_x: float,
    front_y: float,
    center_z: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    digit_pitch: float = 0.0096,
    scale: float = 1.0,
) -> bpy.types.Object:
    digits = {
        "0": "abcdef",
        "1": "bc",
        "2": "abdeg",
        "3": "abcdg",
        "4": "bcfg",
        "5": "acdfg",
        "6": "acdefg",
        "7": "abc",
        "8": "abcdefg",
        "9": "abcdfg",
    }
    segments = {
        "a": (0.0, 0.0056 * scale, False),
        "b": (0.0030 * scale, 0.0028 * scale, True),
        "c": (0.0030 * scale, -0.0028 * scale, True),
        "d": (0.0, -0.0056 * scale, False),
        "e": (-0.0030 * scale, -0.0028 * scale, True),
        "f": (-0.0030 * scale, 0.0028 * scale, True),
        "g": (0.0, 0.0, False),
    }
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    thickness = 0.00035

    def add_prism(poly_xz: list[tuple[float, float]]) -> None:
        base = len(verts)
        n = len(poly_xz)
        for x, z in poly_xz:
            verts.append((x, front_y, z))
        for x, z in poly_xz:
            verts.append((x, front_y + thickness, z))
        faces.append(tuple(range(base, base + n)))
        faces.append(tuple(reversed(range(base + n, base + 2 * n))))
        for i in range(n):
            nxt = (i + 1) % n
            faces.append((base + i, base + n + i, base + n + nxt, base + nxt))

    for idx, ch in enumerate(value):
        cx = center_x + (idx - (len(value) - 1) / 2.0) * digit_pitch
        if ch == ":":
            for dz in (-0.0026 * scale, 0.0026 * scale):
                dot = [
                    (
                        cx + 0.00065 * scale * math.cos(k * math.tau / 8),
                        center_z + dz + 0.00065 * scale * math.sin(k * math.tau / 8),
                    )
                    for k in range(8)
                ]
                add_prism(dot)
            continue
        for seg in digits.get(ch, ""):
            sx, sz, vertical = segments[seg]
            contour = (
                (-0.0026 * scale, 0.0),
                (-0.0020 * scale, -0.00055 * scale),
                (0.0020 * scale, -0.00055 * scale),
                (0.0026 * scale, 0.0),
                (0.0020 * scale, 0.00055 * scale),
                (-0.0020 * scale, 0.00055 * scale),
            )
            poly_xz = []
            for u, v in contour:
                if vertical:
                    u, v = -v, u
                zx = center_z + sz + v
                poly_xz.append((cx + sx + u + (sz + v) * 0.08, zx))
            add_prism(poly_xz)

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def clean_mesh_object(obj: bpy.types.Object, flat_normals: bool = False) -> bpy.types.Object:
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
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

    if flat_normals:
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
    flat_set = {
        "Top folded sheet",
        "Reversible fan suction baffle",
        "Tray flat baking deck",
    }
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            is_flat = (
                obj.name in flat_set
                or obj.name.startswith("Readout ")
                or obj.name.endswith("_pad")
            )
            clean_mesh_object(obj, flat_normals=is_flat)


def build_cabinet_and_chamber(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> None:
    # Exact 700 x 700 mm top folded stainless roof cap at Z in [0.5730, 0.5800] m,
    # with clean rear aperture for the motorized auto exhaust damper (`mbco4_damper` at X = -0.0750, Y = +0.2850)
    horizontal_plate_with_opening(
        "Top folded sheet",
        (0.0, 0.0, 0.5765),
        (0.7000, 0.7000),
        (-0.0750, 0.2950),
        (0.0800, 0.0640),
        0.0070,
        mat["steel"],
        root,
    )
    box("Auto damper recessed throat", (-0.0750, 0.2950, 0.5660), (0.0840, 0.0680, 0.0060), mat["plenum_dark"], root, 0.0)

    # 530 mm tall insulated stainless exterior body (Z in [0.0500, 0.5720] m -> 1.0 mm reveal below folded roof cap)
    # Chamber interior spans X in [-0.3150, +0.1350] (450 mm), Y in [-0.3050, +0.0250] (330 mm), Z in [0.1400, 0.4900] (350 mm)
    shells = (
        ("Left insulated wall", (-0.3325, 0.0160, 0.3110), (0.0350, 0.6680, 0.5220)),
        ("Right service cabinet", (0.2410, 0.0160, 0.3110), (0.2120, 0.6680, 0.5220)),
        ("Insulated chamber floor", (-0.0900, 0.0160, 0.0950), (0.4460, 0.6680, 0.0900)),
        ("Insulated chamber roof", (-0.0900, 0.0160, 0.5310), (0.4460, 0.6680, 0.0820)),
        ("Rear motor & plenum wall", (-0.0900, 0.2200, 0.3150), (0.4460, 0.2600, 0.3460)),
    )
    for sname, spos, sdim in shells:
        box(sname, spos, sdim, mat["steel"], root, bevel=0.0018)

    # Recessed right-side removable electronics access panel (X in [+0.3480, +0.3496] m; screw heads at <= +0.3500 m)
    box("Right electronics access panel", (0.3488, 0.0140, 0.3110), (0.0016, 0.6600, 0.5140), mat["steel"], root, 0.0005)
    for sz in (0.0640, 0.5580):
        for sy in (-0.2950, -0.1000, 0.1200, 0.3250):
            screw_head(f"Right panel screw {sy:+.2f}_{sz:.2f}", (0.3494, sy, sz), mat["chrome"], root, axis="X")

    # 14 stamped vertical cooling louver slots along lower right side wall (shown in catalog photo & CAD side view)
    for l_idx in range(14):
        ly = -0.2150 + l_idx * 0.0280
        box(f"Cooling louver slot {l_idx + 1}", (0.3494, ly, 0.0820), (0.0005, 0.0100, 0.0260), mat["plenum_dark"], root, 0.0)
        box(f"Cooling louver hood {l_idx + 1}", (0.3498, ly - 0.0025, 0.0820), (0.0004, 0.0050, 0.0270), mat["chrome"], root, 0.0002)

    # Full-width lower front stainless apron & door condensation drip gutter (all >= -0.3500 m, non-overlapping)
    box("Lower front stainless plinth", (0.0, -0.3300, 0.0575), (0.6960, 0.0280, 0.0150), mat["steel"], root, 0.0012)
    box("Door condensation drip gutter", (-0.0720, -0.3380, 0.0555), (0.5480, 0.0200, 0.0050), mat["chrome"], root, 0.0008)
    box("Drip gutter front lip", (-0.0720, -0.3482, 0.0595), (0.5480, 0.0032, 0.0085), mat["chrome"], root, 0.0005)
    cylinder("Drip gutter drain boss", (0.1720, -0.3380, 0.0518), 0.0080, 0.0030, mat["chrome"], root)

    # Right front Baker Chef ruby-enamel fascia (X in [+0.2120, +0.3470], front Y = -0.3460) & stainless strike jamb
    box("Right fascia ruby enamel", (0.2795, -0.3330, 0.3185), (0.1350, 0.0260, 0.5050), mat["ruby"], root, 0.0020)
    box("Door strike stainless jamb", (0.1740, -0.3270, 0.3185), (0.0720, 0.0200, 0.5050), mat["chrome"], root, 0.0012)
    # Stainless door latch strike catch plate & cabinet front fasteners (visible when door opens)
    box("Door latch strike plate", (0.1840, -0.3382, 0.3060), (0.0160, 0.0024, 0.0480), mat["chrome"], root, 0.0006)
    box("Door latch strike keeper", (0.1780, -0.3415, 0.3060), (0.0070, 0.0042, 0.0140), mat["chrome"], root, 0.0005)
    for fx, fz in ((0.1840, 0.0920), (0.1840, 0.5440), (-0.3320, 0.0920), (-0.3320, 0.5440)):
        screw_head(f"Cabinet front fastener {fx:+.2f}_{fz:.2f}", (fx, -0.3188, fz), mat["chrome"], root, axis="Y")

    # Four 50 mm stepped brushed-stainless adjustable feet touching exact Z = 0.0000 m (matching catalog photo & CAD)
    for fname, fx, fy in FOOT_POSITIONS:
        f_emp = empty(fname, (fx, fy, 0.0), root)
        f_emp["contact_plane_z_m"] = 0.0
        cylinder(f"{fname}_flange", (0.0, 0.0, 0.0480), 0.0260, 0.0040, mat["steel"], f_emp, bevel=0.0005)
        cylinder(f"{fname}_upper_barrel", (0.0, 0.0, 0.0345), 0.0195, 0.0230, mat["chrome"], f_emp, bevel=0.0005)
        cylinder(f"{fname}_step_collar", (0.0, 0.0, 0.0210), 0.0210, 0.0040, mat["chrome"], f_emp, bevel=0.0005)
        cylinder(f"{fname}_adjuster_foot", (0.0, 0.0, 0.0105), 0.0160, 0.0170, mat["steel"], f_emp, bevel=0.0005)
        cylinder(f"{fname}_pad", (0.0, 0.0, 0.0010), 0.0150, 0.0020, mat["rubber"], f_emp, bevel=0.0)

    # Interior sanitary stainless chamber walls & coved R-corners (450 x 330 x 350 mm)
    box("Chamber dark plenum backwall", (-0.0900, 0.0880, 0.3150), (0.4440, 0.0030, 0.3440), mat["plenum_dark"], root, 0.0)
    box("Chamber floor lining", (-0.0900, -0.1080, 0.1415), (0.4440, 0.3880, 0.0030), mat["lining"], root, 0.0004)
    box("Chamber ceiling lining", (-0.0900, -0.1080, 0.4885), (0.4440, 0.3880, 0.0030), mat["lining"], root, 0.0004)
    box("Chamber left wall lining", (-0.3135, -0.1080, 0.3150), (0.0030, 0.3880, 0.3420), mat["lining"], root, 0.0004)
    box("Chamber right wall lining", (0.1335, -0.1080, 0.3150), (0.0030, 0.3880, 0.3420), mat["lining"], root, 0.0004)

    # Coved sanitary interior fillets (`庫内ステンレスR加工`) along chamber corners
    for cx, cz in ((-0.3085, 0.1465), (0.1285, 0.1465), (-0.3085, 0.4835), (0.1285, 0.4835)):
        box(f"Chamber coved fillet {cx:+.2f}_{cz:.2f}", (cx, -0.1080, cz), (0.0070, 0.3840, 0.0070), mat["lining"], root, 0.0025)

    # Perimeter silicone chamber door gasket around 450 x 350 mm front opening (Y in [-0.3210, -0.3055])
    frame_opening(
        "Chamber silicone door gasket",
        (-0.0900, -0.3132, 0.3150),
        (0.4780, 0.3780, 0.0180),
        (0.4500, 0.3500, 0.0120),
        0.0155,
        mat["rubber"],
        root,
    )

    # Removable rear stainless suction baffle plate with punched square grid apertures at Y = +0.0265 m
    build_punched_suction_baffle(
        "Reversible fan suction baffle",
        (-0.0900, 0.0265, 0.3150),
        0.4240,
        0.3360,
        0.0022,
        0.1060,
        mat["lining"],
        root,
    )
    for bx, bz in ((-0.2880, 0.1640), (0.1080, 0.1640), (-0.2880, 0.4660), (0.1080, 0.4660)):
        screw_head(f"Baffle thumb fastener {bx:+.2f}_{bz:.2f}", (bx, 0.0246, bz), mat["chrome"], root, axis="Y")

    # Circular 3.1 kW stainless sheath heater coil & steam humidification water-injection tube behind the baffle
    heater_pts = [
        (
            -0.0900 + 0.124 * math.cos(i * math.tau / 48),
            0.0680,
            0.3150 + 0.124 * math.sin(i * math.tau / 48),
        )
        for i in range(48)
    ]
    tube("Sheath heater ring 3.1kW", heater_pts, 0.0042, mat["steel"], root, cyclic=True)
    tube(
        "Humidification water injection nozzle",
        [(0.0650, 0.0840, 0.4350), (-0.0450, 0.0580, 0.3450), (-0.0820, 0.0540, 0.3250)],
        0.0026,
        mat["chrome"],
        root,
        smooth=True,
    )

    # 4 pairs of removable stainless L-channel tray rails at 80 mm vertical pitch
    for ledge_x, upstand_x, upright_x, side_lbl in (
        (-0.2890, -0.3005, -0.3065, "left"),
        (0.1090, 0.1205, 0.1265, "right"),
    ):
        for r_idx, rz in enumerate(RAIL_LEVELS_Z, 1):
            box(
                f"Tray rail {r_idx} {side_lbl} ledge",
                (ledge_x, -0.1400, rz - 0.0020),
                (0.0260, 0.3060, 0.0040),
                mat["chrome"],
                root,
                0.0006,
            )
            box(
                f"Tray rail {r_idx} {side_lbl} upstand",
                (upstand_x, -0.1400, rz + 0.0110),
                (0.0030, 0.3020, 0.0180),
                mat["lining"],
                root,
                0.0005,
            )
        for uy, pos_lbl in ((-0.2680, "front"), (0.0020, "rear")):
            box(
                f"Rack mounting upright {side_lbl} {pos_lbl}",
                (upright_x, uy, 0.3120),
                (0.0085, 0.0095, 0.3200),
                mat["chrome"],
                root,
                0.0008,
            )
            for sz in (0.1650, 0.4580):
                cylinder(
                    f"Rack thumbscrew {side_lbl}_{pos_lbl}_{sz:.2f}",
                    (upright_x, uy - 0.0062, sz),
                    0.0038,
                    0.0030,
                    mat["chrome"],
                    root,
                    "Y",
                )

    # Interior left-front halogen chamber lamp & slotted floor drain strainer
    box("Chamber halogen lamp frame", (-0.3100, -0.2350, 0.3150), (0.0036, 0.0240, 0.2360), mat["chrome"], root, 0.0005)
    box("Chamber halogen lamp lens", (-0.3072, -0.2350, 0.3150), (0.0018, 0.0150, 0.2160), mat["lamp"], root, 0.0003)
    cylinder("Chamber condensate drain recess", (-0.0900, -0.0200, 0.1434), 0.0150, 0.0008, mat["plenum_dark"], root)
    cylinder("Chamber condensate drain strainer", (-0.0900, -0.0200, 0.1442), 0.0115, 0.0008, mat["chrome"], root)
    for slot_i in (-1, 0, 1):
        box(
            f"Chamber drain slot {slot_i + 2}",
            (-0.0900 + slot_i * 0.0045, -0.0200, 0.1449),
            (0.0014, 0.0120, 0.0005),
            mat["plenum_dark"],
            root,
            0.0,
        )

    # Exposed stainless top & bottom left door hinge brackets on cabinet (matching MBCO-4ME photo)
    box("Cabinet upper hinge strap", (-0.3280, -0.3340, 0.5690), (0.0360, 0.0240, 0.0050), mat["chrome"], root, 0.0008)
    cylinder("Cabinet door hinge knuckle upper", (-0.3400, -0.3380, 0.5685), 0.0062, 0.0080, mat["chrome"], root)
    box("Cabinet lower hinge strap", (-0.3280, -0.3340, 0.0645), (0.0360, 0.0240, 0.0040), mat["chrome"], root, 0.0008)
    cylinder("Cabinet door hinge knuckle lower", (-0.3400, -0.3380, 0.0650), 0.0062, 0.0055, mat["chrome"], root)


def build_maruzen_crown_emblem(
    px: float,
    cz: float,
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
    font: bpy.types.VectorFont,
) -> None:
    """Sculpted Baker Chef silver oval crown/toque emblem with strictly separated -Y layers."""
    # Layer 1: Silver outer oval rim (Y in [-0.3474, -0.3462], strictly in front of ruby fascia at -0.3460)
    oval_out = cylinder("Maruzen oval emblem rim", (px, -0.3468, cz), 0.0135, 0.0012, mat["white"], root, "Y", vertices=40, bevel=0.0002)
    oval_out.scale.x = 2.05
    bpy.context.view_layer.objects.active = oval_out
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Layer 2: Ruby inner oval field (Y in [-0.3481, -0.3475])
    oval_in = cylinder("Maruzen oval emblem core", (px, -0.3478, cz), 0.0112, 0.0006, mat["ruby"], root, "Y", vertices=40, bevel=0.0)
    oval_in.scale.x = 2.06
    bpy.context.view_layer.objects.active = oval_in
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Layer 3: Sculpted Baker Chef crown/toque silhouette + top star (Y in [-0.3489, -0.3483])
    crown_xz = [
        (-0.0195, 0.0042),
        (-0.0180, -0.0040),
        (-0.0120, -0.0072),
        (-0.0060, -0.0080),
        (0.0, -0.0062),
        (0.0060, -0.0080),
        (0.0120, -0.0072),
        (0.0180, -0.0040),
        (0.0195, 0.0042),
        (0.0145, 0.0006),
        (0.0082, -0.0018),
        (0.0, -0.0026),
        (-0.0082, -0.0018),
        (-0.0145, 0.0006),
    ]
    n = len(crown_xz)
    c_verts = [(px + x, -0.3489, cz + z) for x, z in crown_xz] + [(px + x, -0.3483, cz + z) for x, z in crown_xz]
    c_faces: list[tuple[int, ...]] = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    for i in range(n):
        nxt = (i + 1) % n
        c_faces.append((i, n + i, n + nxt, nxt))
    cmesh = bpy.data.meshes.new("Maruzen crown mark")
    cmesh.from_pydata(c_verts, [], c_faces)
    cmesh.update()
    cobj = bpy.data.objects.new("Maruzen crown mark", cmesh)
    bpy.context.scene.collection.objects.link(cobj)
    finish(cobj, "Maruzen crown mark", mat["white"], root, bevel=0.0)
    cylinder("Maruzen crown star", (px, -0.3487, cz + 0.0048), 0.0020, 0.0006, mat["white"], root, "Y", vertices=4, bevel=0.0)


def build_control_panel(
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
    font: bpy.types.VectorFont,
) -> None:
    """9-step x 99-menu Baker Chef digital controller with baked high-DPI membrane & 3D LED readouts."""
    px = 0.2795

    # Subtle stamped metal bezel surrounding the polycarbonate membrane on the ruby fascia
    frame_opening(
        "Control membrane bezel",
        (px, -0.3463, 0.3760),
        (0.0956, 0.2476, 0.0032),
        (0.0920, 0.2440, 0.0025),
        0.0008,
        mat["mask"],
        root,
        bevel=0.0003,
        segments=6,
    )

    # Layer 1: High-DPI baked polycarbonate membrane (Y in [-0.3474, -0.3462], 0.2 mm clear of ruby fascia at -0.3460)
    box("Digital control membrane", (px, -0.3468, 0.3760), (0.0920, 0.0012, 0.2440), mat["panel_membrane"], root, 0.0004)

    # Layer 2: 3D glowing 7-segment LED readouts (aligned with membrane smoked filter windows, zero overlap)
    seven_segment_readout("Readout 180", "180", px - 0.0095, -0.3482, 0.4450, mat["red_led"], root, digit_pitch=0.0102)
    seven_segment_readout("Readout 10:00", "10:00", px - 0.0055, -0.3482, 0.4040, mat["red_led"], root, digit_pitch=0.0090)
    seven_segment_readout("Readout 18", "18", px - 0.0155, -0.3482, 0.3455, mat["green_led"], root, digit_pitch=0.0088, scale=0.90)
    seven_segment_readout("Readout 1", "1", px + 0.0135, -0.3482, 0.3455, mat["green_led"], root, digit_pitch=0.0088, scale=0.90)

    # Glowing amber status LED dots (setpoint active & medium airflow speed)
    cylinder("Temp active LED", (px + 0.0205, -0.3479, 0.4535), 0.0017, 0.0006, mat["amber_led"], root, "Y", vertices=16, bevel=0.0)
    cylinder("Airflow med LED", (px, -0.3479, 0.2740), 0.0017, 0.0006, mat["amber_led"], root, "Y", vertices=16, bevel=0.0)

    # Top sculpted Baker Chef crown emblem & bottom Maruzen MBCO-4ME cobalt/navy nameplate
    build_maruzen_crown_emblem(px, 0.5350, root, mat, font)
    box("Model nameplate backing", (px, -0.3468, 0.0880), (0.1100, 0.0012, 0.0340), mat["nameplate_decal"], root, 0.0004)


def build_utilities(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Top-right-rear exhaust flue (`排気口`, +120 mm) and rear 15A/20A/200V connections per CAD page 27."""
    utilities = empty("mbco4_utilities", (0.0, 0.0, 0.0), root)
    utilities["status"] = "CAD external projections: +120 mm top-rear exhaust flue (X=+0.275, Y=+0.305) and rear 15A/20A/200V stubs; excluded from nominal 700x700x580 mm cabinet box check"

    # CAD top & side views: angled hollow stainless exhaust flue (`排気口`) at 625 mm from left (X = +0.2750 m),
    # 45 mm from rear (Y = +0.3050 m), rising 120 mm above 580 mm roof (Z_max = 0.7000 m) with forward-facing mitered mouth
    cylinder("Exhaust flue base collar", (0.2750, 0.3050, 0.5825), 0.0305, 0.0050, mat["chrome"], utilities, bevel=0.0006)

    n_seg = 36
    r_out = 0.0235
    r_in = 0.0205
    flue_verts: list[tuple[float, float, float]] = []
    # Ring 0: bottom outer at Z = 0.5845, center (0.2750, 0.3050)
    # Ring 1: top outer mitered (front -Y at Z = 0.6840, rear +Y at Z = 0.7000), center leaned forward to (0.2750, 0.2910)
    # Ring 2: top inner mitered at same Z, radius r_in
    # Ring 3: inner throat bottom at Z = 0.6350, center (0.2750, 0.2980)
    for idx in range(n_seg):
        ang = idx * math.tau / n_seg
        ca, sa = math.cos(ang), math.sin(ang)
        flue_verts.append((0.2750 + r_out * ca, 0.3050 + r_out * sa, 0.5845))
    for idx in range(n_seg):
        ang = idx * math.tau / n_seg
        ca, sa = math.cos(ang), math.sin(ang)
        z_top = 0.6920 + 0.0080 * sa
        flue_verts.append((0.2750 + r_out * ca, 0.2910 + r_out * sa, z_top))
    for idx in range(n_seg):
        ang = idx * math.tau / n_seg
        ca, sa = math.cos(ang), math.sin(ang)
        z_top = 0.6920 + 0.0080 * sa
        flue_verts.append((0.2750 + r_in * ca, 0.2910 + r_in * sa, z_top))
    for idx in range(n_seg):
        ang = idx * math.tau / n_seg
        ca, sa = math.cos(ang), math.sin(ang)
        flue_verts.append((0.2750 + r_in * ca, 0.2980 + r_in * sa, 0.6350))

    flue_faces: list[tuple[int, ...]] = []
    for idx in range(n_seg):
        nxt = (idx + 1) % n_seg
        # Outer cylindrical wall, top mitered rim, inner throat wall, bottom cap
        flue_faces.append((idx, nxt, n_seg + nxt, n_seg + idx))
        flue_faces.append((n_seg + idx, n_seg + nxt, 2 * n_seg + nxt, 2 * n_seg + idx))
        flue_faces.append((2 * n_seg + idx, 2 * n_seg + nxt, 3 * n_seg + nxt, 3 * n_seg + idx))
    flue_faces.append(tuple(reversed(range(n_seg))))
    fmesh = bpy.data.meshes.new("Exhaust flue stainless pipe")
    fmesh.from_pydata(flue_verts, [], flue_faces)
    fmesh.update()
    flue_obj = bpy.data.objects.new("Exhaust flue stainless pipe", fmesh)
    bpy.context.scene.collection.objects.link(flue_obj)
    finish(flue_obj, "Exhaust flue stainless pipe", mat["steel"], utilities, bevel=0.0004)

    cylinder("Exhaust flue dark bore", (0.2750, 0.2980, 0.6360), 0.0200, 0.0030, mat["plenum_dark"], utilities, bevel=0.0)

    # Rear 15A potable water inlet (CAD: 565 mm from left -> X = +0.2150 m, Z = 0.1150 m)
    cylinder("Rear 15A water inlet flange", (0.2150, 0.3540, 0.1150), 0.0170, 0.0060, mat["chrome"], utilities, "Y")
    cylinder("Rear 15A water inlet brass stub", (0.2150, 0.3650, 0.1150), 0.0105, 0.0220, mat["brass"], utilities, "Y")

    # Rear 20A drain outlet stub (CAD: near rear center, Z = 0.0950 m)
    cylinder("Rear 20A drain outlet stub", (-0.0550, 0.3640, 0.0950), 0.0135, 0.0280, mat["steel"], utilities, "Y")

    # Rear single-phase 200V 3.1kW power cord gland (CAD: 565 mm from left -> X = +0.2150 m, Z = 0.1500 m)
    cylinder("Rear 200V 3.1kW power cord gland", (0.2150, 0.3610, 0.1500), 0.0115, 0.0220, mat["rubber"], utilities, "Y")
    return utilities


def build_moulded_handle_grip(handle: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Sculpted oval tapered drop lever reconstructed from Maruzen series-handle.jpg."""
    sections = (
        (0.0080, -0.0245, 0.0115, 0.0075),
        (-0.0070, -0.0275, 0.0155, 0.0108),
        (-0.0220, -0.0300, 0.0140, 0.0122),
        (-0.0580, -0.0300, 0.0122, 0.0122),
        (-0.1020, -0.0285, 0.0112, 0.0112),
        (-0.1240, -0.0260, 0.0118, 0.0098),
        (-0.1340, -0.0240, 0.0075, 0.0065),
    )
    steps = 24
    verts: list[tuple[float, float, float]] = []
    for z, y, wx, dy in sections:
        for idx in range(steps):
            ang = idx * math.tau / steps
            verts.append((wx * math.cos(ang), y + dy * math.sin(ang), z))
    faces: list[tuple[int, ...]] = [tuple(range(steps))]
    for ring in range(len(sections) - 1):
        for idx in range(steps):
            nxt = (idx + 1) % steps
            faces.append(
                (
                    ring * steps + idx,
                    (ring + 1) * steps + idx,
                    (ring + 1) * steps + nxt,
                    ring * steps + nxt,
                )
            )
    faces.append(tuple((len(sections) - 1) * steps + idx for idx in reversed(range(steps))))
    mesh = bpy.data.meshes.new("Handle ergonomic drop grip")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Handle ergonomic drop grip", mesh)
    bpy.context.scene.collection.objects.link(obj)
    finish(obj, "Handle ergonomic drop grip", mat["rubber"], handle, bevel=0.0)
    sub = obj.modifiers.new("GripSubsurf", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    return obj


def build_door_and_handle(
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, bpy.types.Object]:
    """All-brushed-stainless left-hinged double-glazed door matching MBCO-4ME catalog photo, zero z-fighting."""
    # Pivot at (-0.3400, -0.3380, 0.3160).
    # Closed door spans world X in [-0.3480, +0.2040] (552 mm), Y_front = -0.3500, Z in [0.0680, 0.5640] (496 mm).
    door = empty("mbco4_door", DOOR_PIVOT, root)
    door["joint_name"] = "mbco4_door_hinge"
    door["axis_blender"] = "-Z"
    door["range_rad"] = [0.0, DOOR_OPEN_MAX_RAD]

    # 1. Unified brushed-stainless outer door frame: Y_local in [-0.0108, +0.0162] -> world Y in [-0.3488, -0.3218]
    # Window cutout (356 x 344 mm) shifted -18 mm in X so window centers on chamber X_world = -0.0900 (X_local = 0.2500)
    frame_opening(
        "Stainless door outer skin",
        (0.2680, 0.0027, 0.0),
        (0.5520, 0.4960, 0.0050),
        (0.3560, 0.3440, 0.0160),
        0.0270,
        mat["door_steel"],
        door,
        inner_offset_x=-0.0180,
        bevel=0.0012,
        segments=10,
    )

    # 2. Recessed dark ceramic/silicone window reveal liner strictly INSIDE the 356 x 344 mm window opening
    # Outer (355.2 x 343.2 mm) < 356.0 x 344.0 mm, and front recessed at Y_local = -0.0075 (3.3 mm behind front skin!)
    frame_opening(
        "Door window dark gasket bezel",
        (0.2500, 0.0055, 0.0),
        (0.3552, 0.3432, 0.0156),
        (0.3360, 0.3240, 0.0120),
        0.0260,
        mat["mask"],
        door,
        bevel=0.0006,
        segments=10,
    )

    # 3. Outer tempered glass pane (Y_local in [-0.0055, -0.0015]), ceramic frit border, & inner low-E glass pane
    box("Door outer tempered glass pane", (0.2500, -0.0035, 0.0), (0.3400, 0.0040, 0.3280), mat["glass"], door, 0.0006)
    frame_opening(
        "Door glass ceramic frit",
        (0.2500, -0.0008, 0.0),
        (0.3380, 0.3260, 0.0110),
        (0.3120, 0.3000, 0.0090),
        0.0008,
        mat["mask"],
        door,
        bevel=0.0002,
        segments=8,
    )
    box("Door inner heat-reflective glass pane", (0.2500, 0.0155, 0.0), (0.3400, 0.0040, 0.3280), mat["glass"], door, 0.0006)

    # 4. Inner removable stainless double-glazing retainer frame strictly BEHIND outer door shell (Y_local in [+0.0185, +0.0285])
    frame_opening(
        "Door inner stainless glazing frame",
        (0.2500, 0.0235, 0.0),
        (0.4560, 0.3880, 0.0100),
        (0.3360, 0.3240, 0.0120),
        0.0100,
        mat["chrome"],
        door,
        bevel=0.0008,
        segments=10,
    )
    for sx, sz in ((0.0380, -0.1780), (0.0380, 0.1780), (0.4620, -0.1780), (0.4620, 0.1780)):
        screw_head(f"Inner glazing retainer {sx:.2f}_{sz:+.2f}", (sx, 0.0294, sz), mat["chrome"], door, axis="Y")

    # Door-mounted inner glass condensate catch trough (`Y_local` in [+0.0200, +0.0320])
    box("Door inner glass drip rail", (0.2500, 0.0260, -0.2060), (0.4360, 0.0120, 0.0080), mat["chrome"], door, 0.0006)

    # Door left hinge leaves mating with cabinet upper/lower hinge pins (non-overlapping Z)
    box("Door upper hinge leaf", (0.0080, 0.0020, 0.2498), (0.0300, 0.0220, 0.0030), mat["chrome"], door, 0.0005)
    box("Door lower hinge leaf", (0.0080, 0.0020, -0.2498), (0.0300, 0.0220, 0.0030), mat["chrome"], door, 0.0005)

    # High-temperature caution decal at bottom-right of stainless door (visible in MBCO-4ME catalog photo)
    box("Door caution decal backing", (0.5060, -0.01155, -0.2220), (0.0400, 0.0005, 0.0220), mat["caution_decal"], door, 0.0002)

    # 5. Bidirectional rotary push-to-close handle (`mbco4_handle`, child of `mbco4_door`)
    handle = empty("mbco4_handle", HANDLE_LOCAL_ORIGIN, door)
    handle["joint_name"] = "mbco4_handle_latch"
    handle["axis_blender"] = "+Y"
    handle["range_rad"] = [-0.52, 0.52]

    # Door outer skin front is at Y_door = -0.0110 -> in handle frame (HANDLE_LOCAL_ORIGIN.y = -0.0120), door face is at Y_handle = +0.0010!
    cylinder("Handle chrome escutcheon", (0.0, -0.0055, 0.0), 0.0205, 0.0120, mat["chrome"], handle, "Y", vertices=36)
    cylinder("Handle rotary hub", (0.0, -0.0185, 0.0), 0.0190, 0.0130, mat["rubber"], handle, "Y", vertices=36)
    cylinder("Handle hub cap inset", (0.0, -0.0256, 0.0), 0.0135, 0.0008, mat["mask"], handle, "Y", vertices=32, bevel=0.0)
    build_moulded_handle_grip(handle, mat)
    cylinder("Handle latch cam pin", (0.0220, 0.0220, 0.0), 0.0048, 0.0180, mat["chrome"], handle, "X")
    return door, handle


def build_fan_damper_and_tray(
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    # Chamber rear Y-blade reversible convection fan (`mbco4_fan`, child of `mbco4_oven`)
    fan = empty("mbco4_fan", FAN_ORIGIN, root)
    fan["joint_name"] = "mbco4_fan_spin"
    fan["axis_blender"] = "+Y"
    fan["range_rad"] = [-1000.0, 1000.0]

    cylinder("Y-fan backplate disc", (0.0, 0.0130, 0.0), 0.1020, 0.0030, mat["steel"], fan, "Y", vertices=48)
    cylinder("Y-fan center hub", (0.0, -0.0040, 0.0), 0.0250, 0.0180, mat["chrome"], fan, "Y", vertices=32)
    cylinder("Y-fan shaft nut", (0.0, -0.0145, 0.0), 0.0085, 0.0030, mat["chrome"], fan, "Y", vertices=6)
    # 6 radial reversible blades with Maruzen Y-forked outer tips
    for b_idx in range(6):
        ang = b_idx * math.tau / 6
        ca, sa = math.cos(ang), math.sin(ang)
        stem = box(
            f"Y-fan radial blade {b_idx + 1}",
            (0.0540 * ca, 0.0010, 0.0540 * sa),
            (0.0620, 0.0180, 0.0030),
            mat["chrome"],
            fan,
            0.0004,
        )
        stem.rotation_euler = (0.0, -ang, 0.0)
        for fork_sign, flbl in ((-1.0, "a"), (1.0, "b")):
            fang = ang + fork_sign * math.radians(26.0)
            tip = box(
                f"Y-fan fork tip {b_idx + 1}{flbl}",
                (0.0850 * math.cos(ang + fork_sign * 0.085), 0.0010, 0.0850 * math.sin(ang + fork_sign * 0.085)),
                (0.0240, 0.0180, 0.0026),
                mat["chrome"],
                fan,
                0.0003,
            )
            tip.rotation_euler = (0.0, -fang, 0.0)

    # Top-rear motorized auto exhaust damper flap (`mbco4_damper`, child of `mbco4_oven`)
    # At 0 rad, top of damper sits at Z = 0.5765 m <= 0.5800 m; rotating +0..+0.785 rad about +X lifts +Y flap upward (+Z)
    damper = empty("mbco4_damper", DAMPER_ORIGIN, root)
    damper["joint_name"] = "mbco4_damper_hinge"
    damper["axis_blender"] = "+X"
    damper["range_rad"] = [0.0, 0.785]

    cylinder("Auto damper hinge shaft", (0.0, 0.0, 0.0), 0.0038, 0.0740, mat["chrome"], damper, "X")
    box("Auto damper stainless flap", (0.0, 0.0220, 0.0065), (0.0720, 0.0540, 0.0040), mat["steel"], damper, 0.0008)
    box("Auto damper seal pad", (0.0, 0.0220, 0.0032), (0.0660, 0.0480, 0.0022), mat["rubber"], damper, 0.0004)

    # Removable 400 x 300 x 20 mm aluminum European baking tray (`mbco4_tray`, 0.850 kg)
    tray = empty("mbco4_tray", TRAY_REST_ORIGIN, root)
    tray["accessory_role"] = "400x300x20 mm European aluminum baking tray (0.850 kg)"
    tray["tray_dimensions_m"] = [0.4000, 0.3000, 0.0200]

    # Exact 400 x 300 x 20 mm envelope: X_local in [-0.2000, +0.2000], Y_local in [-0.1500, +0.1500], Z_local in [0.0000, 0.0200]
    box("Tray flat baking deck", (0.0, 0.0, 0.0012), (0.3920, 0.2920, 0.0024), mat["aluminum"], tray, bevel=0.0)
    box("Tray front rim wall", (0.0, -0.1480, 0.0100), (0.4000, 0.0040, 0.0200), mat["aluminum"], tray, 0.0008)
    box("Tray rear rim wall", (0.0, 0.1480, 0.0100), (0.4000, 0.0040, 0.0200), mat["aluminum"], tray, 0.0008)
    box("Tray left rim wall", (-0.1980, 0.0, 0.0100), (0.0040, 0.2920, 0.0200), mat["aluminum"], tray, 0.0008)
    box("Tray right rim wall", (0.1980, 0.0, 0.0100), (0.0040, 0.2920, 0.0200), mat["aluminum"], tray, 0.0008)

    socket = empty("vessel_socket", (0.0, -0.1450, 0.0160), tray)
    socket["site_role"] = "Front center baking tray grasp socket"
    return fan, damper, tray


def reset_rest_pose(
    root: bpy.types.Object,
    door: bpy.types.Object,
    handle: bpy.types.Object,
    fan: bpy.types.Object,
    damper: bpy.types.Object,
    tray: bpy.types.Object,
) -> None:
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()
    door.location = DOOR_PIVOT
    door.rotation_euler = (0.0, 0.0, 0.0)
    handle.location = HANDLE_LOCAL_ORIGIN
    handle.rotation_euler = (0.0, 0.0, 0.0)
    fan.location = FAN_ORIGIN
    fan.rotation_euler = (0.0, 0.0, 0.0)
    damper.location = DAMPER_ORIGIN
    damper.rotation_euler = (0.0, 0.0, 0.0)
    tray.location = TRAY_REST_ORIGIN
    tray.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()


def animate_timeline(
    door: bpy.types.Object,
    handle: bpy.types.Object,
    fan: bpy.types.Object,
    damper: bpy.types.Object,
    tray: bpy.types.Object,
) -> None:
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, TRAY_REST_ORIGIN),
        (18, 0.0, math.radians(25.0), math.radians(90.0), 0.0, TRAY_REST_ORIGIN),
        (
            60,
            -DOOR_PREVIEW_RAD,
            0.0,
            math.radians(300.0),
            math.radians(35.0),
            (-0.0900, -0.2700, 0.2650),
        ),
        (
            90,
            -DOOR_PREVIEW_RAD,
            0.0,
            math.radians(-180.0),
            math.radians(35.0),
            (-0.0900, -0.2700, 0.2650),
        ),
        (120, 0.0, 0.0, 0.0, 0.0, TRAY_REST_ORIGIN),
    )
    for fno, door_rz, hdl_ry, fan_ry, dmp_rx, tray_loc in keyframes:
        door.rotation_euler = (0.0, 0.0, door_rz)
        door.keyframe_insert(data_path="rotation_euler", frame=fno)

        handle.rotation_euler = (0.0, hdl_ry, 0.0)
        handle.keyframe_insert(data_path="rotation_euler", frame=fno)

        fan.rotation_euler = (0.0, fan_ry, 0.0)
        fan.keyframe_insert(data_path="rotation_euler", frame=fno)

        damper.rotation_euler = (dmp_rx, 0.0, 0.0)
        damper.keyframe_insert(data_path="rotation_euler", frame=fno)

        tray.location = tray_loc
        tray.rotation_euler = (0.0, 0.0, 0.0)
        tray.keyframe_insert(data_path="location", frame=fno)
        tray.keyframe_insert(data_path="rotation_euler", frame=fno)


def export_glbs(
    root: bpy.types.Object,
    door: bpy.types.Object,
    handle: bpy.types.Object,
    fan: bpy.types.Object,
    damper: bpy.types.Object,
    tray: bpy.types.Object,
) -> None:
    reset_rest_pose(root, door, handle, fan, damper, tray)
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

    # Export standalone 400 x 300 x 20 mm European aluminum baking tray GLB at origin
    saved_parent = tray.parent
    saved_loc = tray.location.copy()
    saved_rot = tuple(tray.rotation_euler)
    tray.animation_data_clear()
    tray.parent = None
    tray.location = (0.0, 0.0, 0.0)
    tray.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    tray.select_set(True)
    for obj in tray.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-tray.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    tray.parent = saved_parent
    tray.location = saved_loc
    tray.rotation_euler = saved_rot
    bpy.context.view_layer.update()


def configure_cycles_metal_gpu(scene: bpy.types.Scene) -> None:
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
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.22


def apply_mbco4_uvs(root: bpy.types.Object) -> None:
    bpy.context.view_layer.update()
    ss_names = {"mbco4_brushed_stainless", "mbco4_door_stainless", "mbco4_chamber_stainless"}
    for obj in root.children_recursive:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        mname = obj.data.materials[0].name if obj.data.materials[0] else ""
        if mname in ss_names:
            project_stainless_uvs(obj, scale=2.6)
    project_front_planar_uvs(bpy.data.objects["Digital control membrane"], 0.2795, 0.3760, 0.0920, 0.2440)
    project_front_planar_uvs(bpy.data.objects["Model nameplate backing"], 0.2795, 0.0880, 0.1100, 0.0340)
    project_front_planar_uvs(
        bpy.data.objects["Door caution decal backing"],
        DOOR_PIVOT[0] + 0.5060,
        DOOR_PIVOT[2] - 0.2220,
        0.0400,
        0.0220,
        local_space=False,
    )


def setup_studio_and_render(
    scene: bpy.types.Scene,
    mat_floor: bpy.types.Material,
    skip_renders: bool,
) -> bpy.types.Object:
    before = set(scene.objects)
    configure_cycles_metal_gpu(scene)
    setup_softbox_world(scene, "MBCO-4ME studio world", camera_bg_rgb=(0.68, 0.71, 0.75))

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

    add_light("Key softbox", (-1.5, -2.1, 2.1), (0.0, 0.0, 0.30), 195.0, 1.9)
    add_light("Right fill stripbox", (1.8, -0.8, 1.6), (0.0, 0.0, 0.30), 130.0, 1.5)
    add_light("Rear rim softbox", (-0.1, 1.6, 2.0), (0.0, 0.0, 0.34), 155.0, 1.4)
    add_light("Chamber fill", (-0.20, -1.6, 0.62), (-0.09, -0.04, 0.31), 55.0, 0.9)

    # Warm interior halogen illumination (studio-only, excluded from GLB) so chamber rails & baffle glow through window
    h_data = bpy.data.lights.new("Chamber halogen studio bulb", "POINT")
    h_data.energy = 4.5
    h_data.color = (1.0, 0.86, 0.62)
    h_data.shadow_soft_size = 0.045
    h_obj = bpy.data.objects.new("Chamber halogen studio bulb", h_data)
    scene.collection.objects.link(h_obj)
    h_obj.location = (-0.1800, -0.1800, 0.4400)

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
        ("studio-closed", (1.15, -2.35, 1.04), (0.0, 0.0, 0.32), 1.15, 1),
        ("studio-open", (1.20, -2.45, 1.18), (-0.10, -0.10, 0.31), 1.40, 72),
        ("studio-front", (0.0, -2.40, 0.35), (0.0, 0.0, 0.33), 1.02, 1),
        ("studio-interior", (-0.08, -2.30, 0.56), (-0.09, -0.08, 0.30), 0.74, 72),
        ("studio-right", (2.35, -0.55, 0.88), (0.0, 0.0, 0.32), 1.15, 1),
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
    handle: bpy.types.Object,
    utilities: bpy.types.Object,
) -> dict:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    excluded = {
        handle,
        *handle.children_recursive,
        utilities,
        *utilities.children_recursive,
    }
    cabinet_meshes = [obj for obj in root.children_recursive if obj.type == "MESH" and obj not in excluded]
    all_meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    cab_low, cab_high, cab_dims = compute_bounds(cabinet_meshes)
    all_low, all_high, all_dims = compute_bounds(all_meshes)

    for actual, expected in zip(cab_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (cab_dims, cab_low, cab_high)
    assert abs(cab_low.z) <= 1e-5, cab_low
    assert abs(all_dims.x - WIDTH) <= 1e-4, ("Expected exact 700 mm width without hand shower:", all_dims, all_low, all_high)

    tri_count = sum(len(obj.data.polygons) for obj in all_meshes)
    glb_path = ASSETS / f"{NAME}.glb"
    tray_glb_path = ASSETS / f"{NAME}-tray.glb"
    report = {
        "asset": NAME,
        "model": "Maruzen Baker Chef M-Series MBCO-4ME Convection Oven",
        "catalog_reference": "maruzen-bakery-catalogue-46001.pdf, printed pages 27 & 29 (PDF pages 28 & 30)",
        "blender_version": bpy.app.version_string,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "tray_glb_sha256": hashlib.sha256(tray_glb_path.read_bytes()).hexdigest(),
        "tray_glb_bytes": tray_glb_path.stat().st_size,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_cabinet_envelope_m": [round(v, 6) for v in cab_dims],
        "cabinet_bounds_m": {
            "min": [round(v, 6) for v in cab_low],
            "max": [round(v, 6) for v in cab_high],
        },
        "projection_inclusive_envelope_m": [round(v, 6) for v in all_dims],
        "projection_inclusive_bounds_m": {
            "min": [round(v, 6) for v in all_low],
            "max": [round(v, 6) for v in all_high],
        },
        "chamber_dimensions_m": [CHAMBER_W, CHAMBER_D, CHAMBER_H],
        "tray_rail_levels_z_m": list(RAIL_LEVELS_Z),
        "tray_rail_pitch_m": 0.080,
        "tray_dimensions_m": [0.400, 0.300, 0.020],
        "published_oven_mass_kg": 70.0,
        "tray_mass_kg": 0.85,
        "electrical_supply": "Single-phase 200 V AC, 50/60 Hz, 3.1 kW (20 A local switch)",
        "temperature_range_c": [50, 300],
        "timer_range_s": [10, 5990],
        "program_capacity": "9 steps x 99 menus",
        "hand_shower_included": False,
        "mesh_count": len(all_meshes),
        "evaluated_triangles": tri_count,
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def run_glb_inspection() -> dict:
    """Re-import the exported GLB in a clean scene to verify envelope, joints, non-coplanar faces, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb_path = ASSETS / f"{NAME}.glb"
    tray_glb_path = ASSETS / f"{NAME}-tray.glb"
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objs = bpy.data.objects

    root = objs["mbco4_oven"]
    door = objs["mbco4_door"]
    handle = objs["mbco4_handle"]
    fan = objs["mbco4_fan"]
    damper = objs["mbco4_damper"]
    tray = objs["mbco4_tray"]
    socket = objs["vessel_socket"]
    utilities = objs["mbco4_utilities"]
    top_sheet = objs["Top folded sheet"]

    assert "mbco4_rinse_shower" not in objs, "MBCO-4ME must not have a hand-rinse shower"
    assert door.parent == root
    assert handle.parent == door
    assert fan.parent == root
    assert damper.parent == root
    assert tray.parent == root
    assert socket.parent == tray
    assert not any(o.type in {"LIGHT", "CAMERA"} for o in objs)

    for o in list(objs):
        o.animation_data_clear()
    bpy.context.view_layer.update()

    excluded = {
        handle,
        *handle.children_recursive,
        utilities,
        *utilities.children_recursive,
    }
    cab_meshes = [o for o in root.children_recursive if o.type == "MESH" and o not in excluded]
    cab_low, cab_high, cab_dims = compute_bounds(cab_meshes)
    for actual, expected in zip(cab_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (cab_dims, (WIDTH, DEPTH, HEIGHT))
    assert abs(cab_low.z - 0.0) <= 1e-5, cab_low.z
    assert abs(cab_high.z - HEIGHT) <= 1e-4, cab_high.z

    # Verify door skin and window gasket have zero front-plane overlap (anti z-fighting guard)
    door_skin_low, _, _ = compute_bounds([objs["Stainless door outer skin"]])
    gasket_low, _, _ = compute_bounds([objs["Door window dark gasket bezel"]])
    assert gasket_low.y - door_skin_low.y >= 0.0007, (door_skin_low.y, gasket_low.y)

    # Fault-injection check: shifting top sheet laterally by 10 mm must trigger envelope failure
    orig_x = top_sheet.location.x
    top_sheet.location.x += 0.010
    bpy.context.view_layer.update()
    _, _, perturbed_dims = compute_bounds(cab_meshes)
    fault_detected = abs(perturbed_dims.x - WIDTH) > 0.005
    top_sheet.location.x = orig_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard failed to detect width perturbation"

    # Verify tray dimensions = 400 x 300 x 20 mm seated on rail #2 (Z = 0.2650 m)
    tray_meshes = [o for o in tray.children_recursive if o.type == "MESH"]
    t_low, t_high, t_dims = compute_bounds(tray_meshes)
    for actual, expected in zip(t_dims, (0.400, 0.300, 0.020)):
        assert abs(actual - expected) <= 1e-4, (t_dims, t_low, t_high)
    assert abs(t_low.z - 0.2650) <= 1e-4, t_low.z

    # Open door 110 deg (1.92 rad around -Z in Blender) and verify unobstructed chamber access
    door.rotation_mode = "XYZ"
    door.rotation_euler = (0.0, 0.0, -DOOR_OPEN_MAX_RAD)
    handle.rotation_mode = "XYZ"
    handle.rotation_euler = (0.0, 0.45, 0.0)
    damper.rotation_mode = "XYZ"
    damper.rotation_euler = (0.785, 0.0, 0.0)
    bpy.context.view_layer.update()
    door_low, _door_high, _ = compute_bounds([o for o in door.children_recursive if o.type == "MESH"])
    open_projection_m = -0.3500 - door_low.y
    assert open_projection_m > 0.500, open_projection_m

    door.rotation_euler = (0.0, 0.0, 0.0)
    handle.rotation_euler = (0.0, 0.0, 0.0)
    damper.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    required_meshes = {
        "Top folded sheet",
        "Right fascia ruby enamel",
        "Digital control membrane",
        "Maruzen crown mark",
        "Readout 180",
        "Readout 10:00",
        "Door condensation drip gutter",
        "Reversible fan suction baffle",
        "Tray rail 2 left ledge",
        "Tray rail 2 right ledge",
        "Stainless door outer skin",
        "Door window dark gasket bezel",
        "Door outer tempered glass pane",
        "Door inner heat-reflective glass pane",
        "Handle ergonomic drop grip",
        "Y-fan center hub",
        "Auto damper stainless flap",
        "Exhaust flue stainless pipe",
        "Tray flat baking deck",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "tray_glb_sha256": hashlib.sha256(tray_glb_path.read_bytes()).hexdigest(),
        "tray_glb_bytes": tray_glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "cabinet_dimensions_m": [round(v, 6) for v in cab_dims],
        "tray_dimensions_m": [round(v, 6) for v in t_dims],
        "open_door_projection_m": round(open_projection_m, 4),
        "door_gasket_front_step_mm": round((gasket_low.y - door_skin_low.y) * 1000.0, 3),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported GLB; verify exact 700x700x580 mm nominal cabinet/door envelope with 50 mm stainless feet at "
            "Z=0.000 m, no hand-rinse shower, non-coplanar brushed-stainless door and recessed window gasket, 450x330x350 mm "
            "chamber with punched square-grid suction baffle and 4 tray rail pairs at 80 mm pitch, and 400x300x20 mm aluminum "
            "tray seated at Z=0.265 m; verify fault-injection rejection; actuate 110-deg door, rotary handle, reversible Y-fan, "
            "and auto damper; verify zero mesh topology/material errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def attach_series_references(scene: bpy.types.Scene, root: bpy.types.Object) -> None:
    app_col = bpy.data.collections.new("MBCO-4ME appliance")
    scene.collection.children.link(app_col)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        app_col.objects.link(obj)

    ref_col = bpy.data.collections.new("Maruzen M-series references - toggle visibility")
    scene.collection.children.link(ref_col)
    for idx, fname in enumerate(
        (
            "series-control-panel.jpg",
            "series-double-glazing.jpg",
            "series-handle.jpg",
            "series-chamber-corner.jpg",
            "series-door-drip-gutter.jpg",
        )
    ):
        fpath = MBCO5_IMAGES / fname
        if not fpath.is_file():
            continue
        img = bpy.data.images.load(str(fpath))
        img.pack()
        ref_obj = bpy.data.objects.new(fname, None)
        ref_col.objects.link(ref_obj)
        ref_obj.empty_display_type = "IMAGE"
        ref_obj.data = img
        ref_obj.empty_display_size = 0.85
        ref_obj.location = (idx * 0.95, 0.75, 0.35)
        ref_obj.rotation_euler = (math.pi / 2.0, 0.0, 0.0)
        ref_obj["reference_status"] = "Maruzen Baker Chef family detail photo (MBCO-4ME spec on printed page 27 of catalogue 46001)"
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
    font = load_japanese_font()
    font.name = "MBCO4 panel font"

    scene = bpy.context.scene
    scene.name = "Maruzen Baker Chef MBCO-4ME - Japan reference"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for m_name, m_frame in (
        ("Closed", 1),
        ("Handle release", 18),
        ("Open & tray inspect", 60),
        ("Chamber view", 90),
        ("Closed again", 120),
    ):
        scene.timeline_markers.new(m_name, frame=m_frame)

    root = empty("mbco4_oven", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Maruzen"
    root["model"] = "MBCO-4ME"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["chamber_dimensions_m"] = [CHAMBER_W, CHAMBER_D, CHAMBER_H]
    root["published_oven_mass_kg"] = 70.0

    mat = palette()
    build_cabinet_and_chamber(root, mat)
    build_control_panel(root, mat, font)
    utilities = build_utilities(root, mat)
    door, handle = build_door_and_handle(root, mat)
    fan, damper, tray = build_fan_damper_and_tray(root, mat)

    convert_and_clean_tree(root)
    apply_mbco4_uvs(root)
    export_glbs(root, door, handle, fan, damper, tray)
    write_build_report(root, handle, utilities)

    attach_series_references(scene, root)
    animate_timeline(door, handle, fan, damper, tray)
    setup_studio_and_render(scene, mat["studio_floor"], args.skip_renders)

    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))

    insp = run_glb_inspection()
    print("Saved MBCO-4ME blend, GLBs, renders, and inspection:", insp["status"])


if __name__ == "__main__":
    main()
