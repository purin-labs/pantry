"""Build the Victoria Arduino E1 PRIMA 1-Group Commercial & Specialty Espresso Machine in Blender 5.2.

Reference ground truth:
- https://victoriaarduino.com/en/products-machines/e1-prima/ (411 W x 510 D x 379 H mm, 37.0 kg empty,
  NEO 0.20 L instant stainless brew boiler + 1.5 L insulated stainless steam boiler, 1.5 L internal tank +
  direct water connection, Steam-by-Wire 2.1 bar Cool-Touch wand, Ghost Display, 3-key volumetric group)
- Official Victoria Arduino E1 PRIMA user manual layout:
  - Right (+X): Steam-by-Wire vertical blade lever + Cool-Touch 360-deg stainless steam wand
  - Left (-X): Programmable 2-dose hot-water vertical blade lever + curved economizer hot-water wand
  - Center (X = 0): Sculpted chrome 58 mm Eagle One brew group, curved black control shield, 3 backlit
    dose buttons, embedded Ghost Display shot timer, and detachable 58 mm double-spout angled portafilter
  - Top (+Z): Diamond-perforated SUS304 cup-warmer deck (Z = 0.3620 m), 379 mm perimeter guard rail, and
    top-rear hinged 1.5 L internal water-reservoir lid
  - Bottom (-Y): Pull-out stainless drip basin + diamond-perforated cup grate (Z = 0.0980 m)
  - Rear (+Y): Vertically ribbed Eagle One architectural back panel + raised chrome 1905 Winged Eagle emblem

Metres, Z up, operator front towards -Y, Z = 0.0000 m at bottom of the four elastomer/stainless feet.
Exact machine envelope (excluding detachable 58 mm portafilter):
  X in [-0.2055, +0.2055] m (411.0 mm)
  Y in [-0.2550, +0.2550] m (510.0 mm)
  Z in [ 0.0000, +0.3790] m (379.0 mm)
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
    project_front_planar_uvs,
    project_stainless_uvs,
    setup_softbox_world,
    textured_decal_material,
    textured_stainless_material,
)
from build_mixer_visuals import lathe, mesh_object
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    look_at,
    rounded_rectangle,
    tube,
)
from inspect_induction import bounds, near
from inspect_mesh_quality import inspect_loaded
from victoria_arduino_kit import (
    control_shield,
    group_cover,
    perforated_plate,
    profile_panel,
    rear_emblem,
)

ROOT = Path(__file__).resolve().parents[2]
NAME = "victoria-arduino-e1-prima"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
REFERENCES = ROOT / "docs/equipment" / NAME

WIDTH = 0.4110
DEPTH = 0.5100
HEIGHT = 0.3790

CUP_DECK_Z = 0.3620
DRIP_GRATE_Z = 0.0980
GROUP_X = 0.0000
GROUP_Y = -0.1560
GROUP_HOOD_Z = 0.2360

# Articulated joint origins (shared 1:1 with build_e1_prima_physics.py and Portal catalog):
# - Right (+X): Cool-Touch steam wand & Steam-by-Wire electronic paddle lever
# - Left (-X): Two-dose hot-water electronic paddle lever
# - Top-rear: Hinged 1.5 L internal water-reservoir access cover
# - Front-bottom: Pull-out stainless drip basin + diamond-perforated grate
# - Center bayonet: Detachable 58 mm double-spout Victoria Arduino angled portafilter
STEAM_WAND_ORIGIN = (0.1340, -0.1320, 0.2560)
STEAM_LEVER_ORIGIN = (0.1340, -0.1280, 0.3080)
HOT_WATER_LEVER_ORIGIN = (-0.1340, -0.1280, 0.3080)
TANK_LID_ORIGIN = (0.0000, 0.2280, CUP_DECK_Z)
DRIP_TRAY_ORIGIN = (0.0000, -0.1750, 0.0680)
PF_REST_POSE = (GROUP_X, GROUP_Y, 0.2140)

FOOT_POSITIONS = (
    ("e1p_foot_front_left", -0.1580, -0.1520),
    ("e1p_foot_front_right", 0.1580, -0.1520),
    ("e1p_foot_rear_left", -0.1640, 0.1860),
    ("e1p_foot_rear_right", 0.1640, 0.1860),
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
            bsdf.inputs["Specular IOR Level"].default_value = 0.18
        if coat > 0.0:
            bsdf.inputs["Coat Weight"].default_value = coat
            bsdf.inputs["Coat Roughness"].default_value = 0.20
        if transmission > 0.0:
            bsdf.inputs["Base Color"].default_value = color
            bsdf.inputs["Specular IOR Level"].default_value = 0.35
            bsdf.inputs["Transmission Weight"].default_value = transmission
            bsdf.inputs["IOR"].default_value = 1.49
        if emission > 0.0:
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = emission
    if color[3] < 1.0 and transmission == 0.0:
        mat.surface_render_method = "BLENDED"
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = float(emission)
    return mat


def bake_e1_prima_decals() -> tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Bake crisp orthographic Ghost Display, front E1 PRIMA plaque, and rear VICTORIA ARDUINO wordmark."""

    def add_flat_box(scn, name, x, y, z, w, h, mat, bevel_r=0.0):
        pts = (
            rounded_rectangle(w, h, bevel_r, segments=8)
            if bevel_r > 0
            else [(w / 2, h / 2), (-w / 2, h / 2), (-w / 2, -h / 2), (w / 2, -h / 2)]
        )
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

    def build_ghost_sheet(scn, emit_mat, _font_jp, font_en):
        m_bg = emit_mat("g_bg", (0.011, 0.013, 0.016, 1.0))
        m_dim = emit_mat("g_dim", (0.14, 0.17, 0.20, 1.0))
        m_ice = emit_mat("g_ice", (0.86, 0.94, 1.00, 1.0))
        m_cyan = emit_mat("g_cyan", (0.42, 0.78, 0.98, 1.0))
        add_flat_box(scn, "g_bg", 0.0, 0.0, 0.0, 0.056, 0.028, m_bg)
        add_flat_ring(scn, "g_frame", 0.0, 0.0, 0.0005, 0.050, 0.022, 0.003, 0.0005, m_dim)
        add_flat_text(scn, "27.4s", -0.006, 0.0015, 0.001, 0.0092, m_ice, font_en)
        add_flat_text(scn, "93.0 C", 0.015, 0.0040, 0.001, 0.0038, m_cyan, font_en)
        add_flat_text(scn, "NEO  BT", 0.015, -0.0042, 0.001, 0.0032, m_dim, font_en)
        add_flat_box(scn, "g_bar_bg", -0.006, -0.0068, 0.001, 0.026, 0.0014, m_dim, 0.0005)
        add_flat_box(scn, "g_bar_fg", -0.009, -0.0068, 0.0012, 0.020, 0.0014, m_cyan, 0.0005)

    def build_front_badge(scn, emit_mat, _font_jp, font_en):
        m_bg = emit_mat("b_bg", (0.022, 0.024, 0.028, 1.0))
        m_silver = emit_mat("b_sil", (0.84, 0.86, 0.89, 1.0))
        m_sub = emit_mat("b_sub", (0.58, 0.61, 0.65, 1.0))
        add_flat_box(scn, "b_bg", 0.0, 0.0, 0.0, 0.096, 0.036, m_bg, 0.002)
        add_flat_ring(scn, "b_rim", 0.0, 0.0, 0.0005, 0.091, 0.031, 0.002, 0.0007, m_sub)
        add_flat_text(scn, "E1  PRIMA", 0.0, 0.0042, 0.001, 0.0096, m_silver, font_en)
        add_flat_text(scn, "VICTORIA ARDUINO  1905", 0.0, -0.0068, 0.001, 0.0042, m_sub, font_en)

    def build_rear_wordmark(scn, emit_mat, _font_jp, font_en):
        m_bg = emit_mat("r_bg", (0.018, 0.020, 0.024, 1.0))
        m_chrome = emit_mat("r_chr", (0.88, 0.90, 0.93, 1.0))
        m_muted = emit_mat("r_mut", (0.55, 0.58, 0.62, 1.0))
        add_flat_box(scn, "r_bg", 0.0, 0.0, 0.0, 0.220, 0.055, m_bg)
        add_flat_text(scn, "V I C T O R I A   A R D U I N O", 0.0, 0.0055, 0.001, 0.0108, m_chrome, font_en)
        add_flat_text(scn, "DAL  1905  -  ITALIA", 0.0, -0.0095, 0.001, 0.0058, m_muted, font_en)

    ghost_img = bake_ortho_sheet(ASSETS / "e1p-ghost-display.png", 512, 256, 0.056, 0.028, build_ghost_sheet)
    badge_img = bake_ortho_sheet(ASSETS / "e1p-front-badge.png", 512, 192, 0.096, 0.036, build_front_badge)
    rear_img = bake_ortho_sheet(ASSETS / "e1p-rear-wordmark.png", 768, 192, 0.220, 0.055, build_rear_wordmark)
    return ghost_img, badge_img, rear_img


def surfaces(
    col_img: bpy.types.Image,
    orm_img: bpy.types.Image,
    ghost_img: bpy.types.Image,
    badge_img: bpy.types.Image,
    rear_img: bpy.types.Image,
) -> dict[str, bpy.types.Material]:
    ghost_mat = textured_decal_material(
        "E1P Ghost Display glass",
        ghost_img,
        fallback_rgba=(0.02, 0.03, 0.04, 1.0),
        roughness=0.14,
        metallic=0.05,
        coat=0.35,
    )
    bsdf_g = ghost_mat.node_tree.nodes["Principled BSDF"]
    tex_g = next(n for n in ghost_mat.node_tree.nodes if n.type == "TEX_IMAGE")
    ghost_mat.node_tree.links.new(tex_g.outputs["Color"], bsdf_g.inputs["Emission Color"])
    bsdf_g.inputs["Emission Strength"].default_value = 0.85
    ghost_mat["emission"] = 0.85

    return {
        "stainless": textured_stainless_material(
            "E1P SUS304 satin hairline",
            col_img,
            orm_img,
            tint=(0.76, 0.78, 0.81, 1.0),
            metallic=0.90,
            roughness=0.24,
            coat=0.06,
        ),
        "stainless_dark": textured_stainless_material(
            "E1P recessed brushed steel",
            col_img,
            orm_img,
            tint=(0.54, 0.57, 0.60, 1.0),
            metallic=0.88,
            roughness=0.30,
            coat=0.04,
        ),
        "matte_black": make_material(
            "E1P matte architectural black",
            (0.018, 0.020, 0.024, 1.0),
            metallic=0.18,
            roughness=0.36,
            coat=0.12,
        ),
        "chrome": make_material(
            "E1P mirror chrome",
            (0.84, 0.86, 0.89, 1.0),
            metallic=0.97,
            roughness=0.09,
        ),
        "rubber": make_material(
            "E1P soft-touch elastomer",
            (0.014, 0.015, 0.017, 1.0),
            metallic=0.02,
            roughness=0.52,
        ),
        "dark_recess": make_material(
            "E1P shadow gap charcoal",
            (0.028, 0.031, 0.036, 1.0),
            metallic=0.45,
            roughness=0.42,
        ),
        "brass": make_material(
            "E1P hydraulic brass fitting",
            (0.72, 0.56, 0.24, 1.0),
            metallic=0.92,
            roughness=0.24,
        ),
        "insulation": make_material(
            "E1P NEO thermal jacket",
            (0.16, 0.18, 0.21, 1.0),
            metallic=0.08,
            roughness=0.62,
        ),
        "tank_poly": make_material(
            "E1P smoked SAN 1.5L reservoir",
            (0.76, 0.84, 0.89, 1.0),
            metallic=0.0,
            roughness=0.10,
            transmission=0.78,
        ),
        "water": make_material(
            "E1P potable water level",
            (0.58, 0.80, 0.94, 1.0),
            metallic=0.0,
            roughness=0.06,
            transmission=0.86,
        ),
        "tank_handle": make_material(
            "E1P reservoir sky-blue bail",
            (0.12, 0.42, 0.68, 1.0),
            metallic=0.05,
            roughness=0.32,
        ),
        "led_white": make_material(
            "E1P backlit key ring",
            (0.88, 0.94, 1.00, 1.0),
            metallic=0.05,
            roughness=0.20,
            emission=1.10,
        ),
        "ghost_display": ghost_mat,
        "front_badge": textured_decal_material(
            "E1P front identity plaque",
            badge_img,
            fallback_rgba=(0.03, 0.03, 0.04, 1.0),
            roughness=0.26,
            metallic=0.18,
            coat=0.18,
        ),
        "rear_wordmark": textured_decal_material(
            "E1P rear heritage wordmark",
            rear_img,
            fallback_rgba=(0.02, 0.02, 0.03, 1.0),
            roughness=0.28,
            metallic=0.14,
            coat=0.12,
        ),
        "studio_floor": make_material(
            "E1P studio matte cyclorama",
            (0.58, 0.61, 0.65, 1.0),
            metallic=0.0,
            roughness=0.82,
        ),
    }


def project_rear_planar_uvs(
    obj: bpy.types.Object,
    center_x: float,
    center_z: float,
    width: float,
    height: float,
) -> None:
    """Map rear (+Y facing) decal faces cleanly so lettering reads left-to-right when viewed from +Y."""
    if obj.type != "MESH" or obj.data is None:
        return
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    for poly in mesh.polygons:
        n_y = (mw.to_3x3() @ poly.normal).y
        is_rear = n_y > 0.45
        for loop_idx in poly.loop_indices:
            pt = mw @ mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            if is_rear:
                # Looking toward -Y from +Y: +X is on the viewer's left, so mirror U across center_x.
                u = ((center_x + width * 0.5) - pt.x) / max(width, 1e-6)
                v = (pt.z - (center_z - height * 0.5)) / max(height, 1e-6)
                uv_layer.data[loop_idx].uv = (min(max(u, 0.002), 0.998), min(max(v, 0.002), 0.998))
            else:
                uv_layer.data[loop_idx].uv = (0.01, 0.01)


def build_side_profile() -> list[tuple[float, float]]:
    """Eagle One Prima sloped architectural side-panel silhouette within Y in [-0.1860, +0.2550], Z in [0.0340, 0.3720]."""
    pts: list[tuple[float, float]] = [(-0.1180, 0.3720), (0.2280, 0.3720), (0.2550, 0.0700)]
    # Rounded lower-rear corner: center (0.2190, 0.0700), R = 0.0360 -> Y_max = 0.2550, Z_min = 0.0340
    pts.extend(
        (0.2190 + 0.0360 * math.cos(a), 0.0700 + 0.0360 * math.sin(a))
        for a in [-(i * math.pi / 2 / 14) for i in range(1, 15)]
    )
    pts.append((-0.1500, 0.0340))
    # Rounded lower-front corner: center (-0.1500, 0.0700), R = 0.0360 -> Y_min = -0.1860
    pts.extend(
        (-0.1500 + 0.0360 * math.cos(a), 0.0700 + 0.0360 * math.sin(a))
        for a in [-math.pi / 2 - i * math.pi / 2 / 14 for i in range(1, 15)]
    )
    return pts


def build_machine_body(
    root: bpy.types.Object, mat: dict[str, bpy.types.Material]
) -> dict[str, bpy.types.Object]:
    refs: dict[str, bpy.types.Object] = {}
    side_prof = build_side_profile()

    # 1. Sculpted matte-black Eagle One Prima side skins (exact X in [-0.2055, +0.2055])
    for sign, tag in ((-1, "left"), (1, "right")):
        x_outer = sign * (WIDTH * 0.5)
        x_inner = sign * (WIDTH * 0.5 - 0.0120)
        x0, x1 = (x_outer, x_inner) if sign < 0 else (x_inner, x_outer)
        skin = profile_panel(
            f"e1p_side_skin_{tag}",
            x0,
            x1,
            side_prof,
            mat["matte_black"],
            root,
            bevel=0.0014,
        )
        # Pure linear inward cant across full panel height keeps the side skin 100% planar (zero N-gon crease)
        for v in skin.data.vertices:
            v.co.x -= sign * 0.0150 * ((v.co.z - 0.0340) / (0.3720 - 0.0340))
        skin.data.update()
        refs[f"side_skin_{tag}"] = skin

        # Polished chrome perimeter trim rail along front edge of each side cheek
        rail = tube(
            f"e1p_front_rail_{tag}",
            [
                (sign * 0.1895, -0.1190, 0.3660),
                (sign * 0.2015, -0.1845, 0.0740),
                (sign * 0.1960, -0.1740, 0.0420),
            ],
            0.0024,
            mat["chrome"],
            root,
            smooth=True,
        )
        refs[f"front_rail_{tag}"] = rail

    # 2. Four cylindrical stainless/elastomer feet touching exact Z = 0.0000 m
    for fname, fx, fy in FOOT_POSITIONS:
        f_emp = empty(fname, (fx, fy, 0.0), root)
        cylinder(f"{fname}_pad", (0.0, 0.0, 0.0060), 0.0185, 0.0120, mat["rubber"], f_emp)
        cylinder(f"{fname}_collar", (0.0, 0.0, 0.0185), 0.0170, 0.0130, mat["stainless"], f_emp)
        cylinder(f"{fname}_stem", (0.0, 0.0, 0.0320), 0.0095, 0.0160, mat["chrome"], f_emp)

    # 3. Structural underbody & internal boiler/reservoir service bay
    box(
        "e1p_underbody_chassis",
        (0.0, 0.0360, 0.0520),
        (0.3840, 0.3780, 0.0340),
        mat["stainless_dark"],
        root,
        0.004,
    )
    box(
        "e1p_internal_deck_bulkhead",
        (0.0, 0.0520, 0.2100),
        (0.3720, 0.3360, 0.2820),
        mat["dark_recess"],
        root,
        0.002,
    )

    # Top-rear internal 1.5 L removable water reservoir bay (visible when e1p_tank_lid opens)
    box(
        "e1p_tank_well_liner",
        (0.0, 0.1720, 0.2680),
        (0.2860, 0.1080, 0.1780),
        mat["dark_recess"],
        root,
        0.002,
    )
    reservoir = box(
        "e1p_water_reservoir_1_5l",
        (0.0, 0.1720, 0.2740),
        (0.2440, 0.0880, 0.1560),
        mat["tank_poly"],
        root,
        0.004,
    )
    refs["reservoir"] = reservoir
    box(
        "e1p_reservoir_water_level",
        (0.0, 0.1720, 0.2580),
        (0.2360, 0.0800, 0.1120),
        mat["water"],
        root,
        0.002,
    )
    tube(
        "e1p_reservoir_carry_bail",
        [
            (-0.0880, 0.1720, 0.3460),
            (-0.0880, 0.1520, 0.3530),
            (0.0880, 0.1520, 0.3530),
            (0.0880, 0.1720, 0.3460),
        ],
        0.0026,
        mat["tank_handle"],
        root,
        smooth=True,
    )
    # NEO 1.5 L insulated stainless steam boiler + 0.20 L instant brew boiler inside chassis
    cylinder(
        "e1p_steam_boiler_1_5l",
        (0.0720, 0.0480, 0.2050),
        0.0560,
        0.1680,
        mat["insulation"],
        root,
        "X",
    )
    cylinder(
        "e1p_neo_brew_boiler_0_2l",
        (-0.0680, -0.0280, 0.2360),
        0.0310,
        0.1120,
        mat["insulation"],
        root,
        "Z",
    )

    # 4. Top diamond-perforated SUS304 cup-warmer deck (Z = 0.3620 m) + exact Z = 0.3790 m guard rail
    cup_deck = perforated_plate(
        "e1p_cup_warmer_deck",
        0.3580,
        0.2240,
        18,
        11,
        0.0034,
        mat["stainless"],
        root,
        half_thickness=0.0012,
    )
    cup_deck.location = (0.0, 0.0020, CUP_DECK_Z)
    refs["cup_deck"] = cup_deck

    # Low brushed-stainless perimeter cup-warmer guard rails reaching exact Z = 0.3790 m
    box(
        "e1p_cup_rail_rear",
        (0.0, 0.2360, 0.3705),
        (0.3660, 0.0040, 0.0170),
        mat["stainless"],
        root,
        0.0008,
    )
    for sign, tag in ((-1, "left"), (1, "right")):
        box(
            f"e1p_cup_rail_{tag}",
            (sign * 0.1810, 0.0680, 0.3705),
            (0.0040, 0.3360, 0.0170),
            mat["stainless"],
            root,
            0.0008,
        )

    # 5. Front sloped SUS304 hairline control fascia + mirror-chrome lower splash back
    front_fascia = box(
        "e1p_front_control_fascia",
        (0.0, -0.1200, 0.3000),
        (0.3720, 0.0060, 0.1160),
        mat["stainless"],
        root,
        0.0018,
    )
    front_fascia.rotation_euler.x = math.radians(-8.0)
    refs["front_fascia"] = front_fascia

    splash = box(
        "e1p_lower_splash_back",
        (0.0, -0.1090, 0.1680),
        (0.3820, 0.0060, 0.1480),
        mat["stainless_dark"],
        root,
        0.0015,
    )
    refs["splash"] = splash

    # Non-coplanar front E1 PRIMA plaque with chrome bezel stepped forward of lower splash back
    box(
        "e1p_front_identity_bezel",
        (-0.1180, -0.1130, 0.1460),
        (0.0870, 0.0024, 0.0345),
        mat["chrome"],
        root,
        0.0008,
    )
    front_plaque = box(
        "e1p_front_identity_plaque",
        (-0.1180, -0.1148, 0.1460),
        (0.0840, 0.0022, 0.0315),
        mat["front_badge"],
        root,
        0.0006,
    )
    refs["front_plaque"] = front_plaque

    # 6. Rear vertically ribbed architectural back panel + raised 3D chrome 1905 Eagle emblem
    rear_panel = box(
        "e1p_rear_ribbed_panel",
        (0.0, 0.2380, 0.2140),
        (0.3740, 0.0050, 0.3120),
        mat["matte_black"],
        root,
        0.0015,
    )
    rear_panel.rotation_euler.x = math.radians(4.0)
    for rib_idx in range(15):
        rx = -0.1610 + rib_idx * 0.0230
        if abs(rx) < 0.0880:
            # Below central medallion field: z_center = 0.1420 -> outer surface y = 0.2405 - (-0.072)*sin(4) = 0.2455
            rib_h = 0.1360
            rib_z = 0.1420
            rib_y = 0.2462
        else:
            # Full-height flank ribs: z_center = 0.2140 -> outer surface y = 0.2405
            rib_h = 0.2920
            rib_z = 0.2140
            rib_y = 0.2412
        rib = box(
            f"e1p_rear_flute_{rib_idx:02d}",
            (rx, rib_y, rib_z),
            (0.0050, 0.0036, rib_h),
            mat["stainless_dark"],
            root,
            0.0008,
        )
        rib.rotation_euler.x = math.radians(4.0)

    emblem = rear_emblem(
        root,
        mat["chrome"],
        name="e1p_rear_eagle_emblem",
        width_scale=1.18,
        z_center=0.3120,
        y_plane=0.2395,
        z_ref=0.2140,
        rake_deg=4.0,
        thickness=0.0026,
        bevel=0.0005,
    )
    refs["rear_emblem"] = emblem

    rear_badge = box(
        "e1p_rear_wordmark_plaque",
        (0.0, 0.2378, 0.2640),
        (0.1680, 0.0028, 0.0420),
        mat["rear_wordmark"],
        root,
        0.0006,
    )
    rear_badge.rotation_euler.x = math.radians(4.0)
    refs["rear_badge"] = rear_badge

    # Recessed lower-rear utility bay (power rocker, cord relief, 3/8" BSP direct-plumb brass inlet)
    box(
        "e1p_rear_utility_recess",
        (0.0, 0.2380, 0.0620),
        (0.2400, 0.0120, 0.0360),
        mat["dark_recess"],
        root,
        0.0015,
    )
    cylinder("e1p_direct_water_inlet_bsp", (-0.0680, 0.2420, 0.0620), 0.0085, 0.0140, mat["brass"], root, "Y")
    cylinder("e1p_rear_cord_relief", (0.0740, 0.2420, 0.0620), 0.0095, 0.0140, mat["rubber"], root, "Y")
    box("e1p_rear_main_switch", (0.0120, 0.2430, 0.0620), (0.0180, 0.0060, 0.0220), mat["rubber"], root, 0.001)

    # 7. Central sculpted chrome 58 mm Eagle One brew group + curved control shield + Ghost Display + 3 keys
    grp = empty("e1p_brew_group_mount", (GROUP_X, GROUP_Y, GROUP_HOOD_Z), root)
    hood = group_cover(
        "e1p_group_chrome_hood",
        grp,
        mat["chrome"],
        scale_xy=0.94,
        scale_z=0.96,
        bevel=0.001,
    )
    refs["group_hood"] = hood
    shield = control_shield(
        "e1p_group_control_shield",
        grp,
        mat["matte_black"],
        scale_xy=0.94,
        scale_z=0.96,
        thickness=0.0012,
    )
    refs["control_shield"] = shield

    # Ghost Display window flush-stepped in front of upper curved control shield
    ghost_win = box(
        "e1p_ghost_display_window",
        (0.0, -0.0442, 0.0715),
        (0.0440, 0.0022, 0.0220),
        mat["ghost_display"],
        grp,
        0.0006,
    )
    ghost_win.rotation_euler.x = math.radians(-10.0)
    refs["ghost_win"] = ghost_win

    # Three backlit volumetric brew buttons (Dose 1, Dose 2, Continuous/Purge)
    for idx, kname in enumerate(("e1p_dose_key_1", "e1p_dose_key_2", "e1p_purge_key")):
        kx = (idx - 1) * 0.0215
        ky = -0.0470 * math.sqrt(max(0.1, 1.0 - (kx / 0.0590) ** 2)) - 0.0032
        bezel = box(
            f"{kname}_led_ring",
            (kx, ky + 0.0008, 0.0495),
            (0.0172, 0.0024, 0.0124),
            mat["led_white"],
            grp,
            0.0018,
        )
        bezel.rotation_euler.z = -kx * 5.6
        cap = box(
            kname,
            (kx, ky - 0.0008, 0.0495),
            (0.0150, 0.0026, 0.0102),
            mat["matte_black"],
            grp,
            0.0014,
        )
        cap.rotation_euler.z = -kx * 5.6

    # 58 mm chrome bayonet group ring, EPDM portafilter gasket, and stainless dispersion screen
    cylinder("e1p_group_head_58mm", (0.0, 0.0, -0.0160), 0.0435, 0.0320, mat["chrome"], grp)
    cylinder("e1p_group_bayonet_ring", (0.0, 0.0, -0.0285), 0.0410, 0.0070, mat["stainless_dark"], grp)
    cylinder("e1p_group_gasket_epdm", (0.0, 0.0, -0.0260), 0.0345, 0.0040, mat["rubber"], grp)
    cylinder("e1p_group_shower_screen", (0.0, 0.0, -0.0250), 0.0285, 0.0025, mat["stainless"], grp)

    # 8. Right (+X) Steam-by-Wire & wand escutcheons + Left (-X) Hot-Water escutcheons & economizer wand
    for sign, prefix in ((1, "steam"), (-1, "hot_water")):
        vx = sign * 0.1340
        cylinder(
            f"e1p_{prefix}_lever_escutcheon",
            (vx, -0.1235, 0.3080),
            0.0210,
            0.0090,
            mat["chrome"],
            root,
            "Y",
        )
        cylinder(
            f"e1p_{prefix}_wand_escutcheon",
            (vx, -0.1205, 0.2560),
            0.0200,
            0.0090,
            mat["chrome"],
            root,
            "Y",
        )

    # Left-side (-X) curved economizer hot-water outlet wand & anti-splash diffuser nozzle
    tube(
        "e1p_hot_water_wand_tube",
        [
            (-0.1340, -0.1250, 0.2560),
            (-0.1340, -0.1620, 0.2520),
            (-0.1340, -0.1740, 0.2280),
            (-0.1340, -0.1760, 0.1980),
        ],
        0.0058,
        mat["chrome"],
        root,
        smooth=True,
    )
    cylinder(
        "e1p_hot_water_nozzle",
        (-0.1340, -0.1760, 0.1910),
        0.0088,
        0.0180,
        mat["chrome"],
        root,
    )

    return refs


def build_steam_wand(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Right-side (+X) 360-deg articulated Cool-Touch stainless steam wand."""
    wand = empty("e1p_steam_wand", STEAM_WAND_ORIGIN, root)
    cylinder("e1p_steam_ball_nut", (0.0, 0.0020, 0.0), 0.0125, 0.0140, mat["chrome"], wand, "Y")
    tube(
        "e1p_steam_wand_tube",
        [
            (0.0, 0.0, 0.0),
            (0.0140, -0.0220, 0.0110),
            (0.0180, -0.0480, 0.0280),
            (0.0100, -0.0640, 0.0220),
            (0.0020, -0.0710, -0.0180),
            (-0.0040, -0.0740, -0.1060),
        ],
        0.0046,
        mat["chrome"],
        wand,
        smooth=True,
    )
    # Anti-burn elastomer pinch sleeve on upper vertical drop
    tube(
        "e1p_steam_cool_grip",
        [
            (0.0010, -0.0716, -0.0260),
            (-0.0014, -0.0728, -0.0640),
        ],
        0.0068,
        mat["rubber"],
        wand,
        smooth=True,
    )
    cylinder(
        "e1p_steam_nozzle_tip",
        (-0.0040, -0.0740, -0.1120),
        0.0062,
        0.0150,
        mat["stainless"],
        wand,
    )
    return wand


def build_paddle_lever(
    name: str,
    prefix: str,
    origin: tuple[float, float, float],
    root: bpy.types.Object,
    mat: dict[str, bpy.types.Material],
) -> bpy.types.Object:
    """Ergonomic Victoria Arduino vertical blade paddle lever (Steam-by-Wire & Hot Water)."""
    lever = empty(name, origin, root)
    cylinder(f"{prefix}_pivot_hub", (0.0, -0.0020, 0.0), 0.0105, 0.0140, mat["chrome"], lever, "X")
    box(
        f"{prefix}_blade_paddle",
        (0.0, -0.0085, 0.0230),
        (0.0240, 0.0125, 0.0480),
        mat["chrome"],
        lever,
        0.0055,
    )
    for rib_i in range(5):
        box(
            f"{prefix}_grip_rib_{rib_i}",
            (0.0, -0.0152, 0.0260 + rib_i * 0.0032),
            (0.0175, 0.0016, 0.0012),
            mat["rubber"],
            lever,
            0.0003,
        )
    return lever


def build_tank_lid(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Top-rear hinged SUS304 cover over the internal 1.5 L removable water reservoir."""
    lid = empty("e1p_tank_lid", TANK_LID_ORIGIN, root)
    box(
        "e1p_tank_lid_plate",
        (0.0, -0.0560, 0.0002),
        (0.3540, 0.1120, 0.0032),
        mat["stainless"],
        lid,
        0.0008,
    )
    # Recessed front finger-pull slot
    box(
        "e1p_tank_lid_finger_pull",
        (0.0, -0.0980, 0.0016),
        (0.0640, 0.0140, 0.0016),
        mat["dark_recess"],
        lid,
        0.0030,
    )
    for sign, tag in ((-1, "left"), (1, "right")):
        cylinder(
            f"e1p_tank_hinge_knuckle_{tag}",
            (sign * 0.1320, 0.0, 0.0),
            0.0042,
            0.0220,
            mat["chrome"],
            lid,
            "X",
        )
    return lid


def build_drip_tray(
    root: bpy.types.Object, mat: dict[str, bpy.types.Material]
) -> tuple[bpy.types.Object, dict[str, bpy.types.Object]]:
    """Pull-out stainless drip basin + diamond-perforated stainless cup grate (Z = 0.0980 m)."""
    tray = empty("e1p_drip_tray", DRIP_TRAY_ORIGIN, root)
    # Basin depth 0.1600 m centered at Y = -0.1750 -> front face at exact Y = -0.2550 m
    pan = box(
        "e1p_drip_tray_pan",
        (0.0, 0.0, -0.0020),
        (0.3760, 0.1600, 0.0560),
        mat["stainless"],
        tray,
        0.0030,
    )
    # Interior dark sump recess
    box(
        "e1p_drip_sump_cavity",
        (0.0, 0.0030, 0.0255),
        (0.3540, 0.1380, 0.0030),
        mat["dark_recess"],
        tray,
        0.0020,
    )
    # Watertight diamond-perforated stainless grate with top surface at exact Z = 0.0980 m
    # DRIP_TRAY_ORIGIN.z = 0.0680 -> local Z = +0.0288 + half_thickness 0.0012 = +0.0300 -> world Z = 0.0980 m
    grate = perforated_plate(
        "e1p_drip_tray_grate",
        0.3520,
        0.1360,
        22,
        9,
        0.0032,
        mat["stainless"],
        tray,
        half_thickness=0.0012,
    )
    grate.location = (0.0, 0.0030, 0.0288)

    # Front brushed nameplate bezel on drip-tray apron (kept strictly >= -0.2550 m)
    apron_badge = box(
        "e1p_drip_tray_badge",
        (0.0, -0.0782, -0.0040),
        (0.0820, 0.0026, 0.0260),
        mat["front_badge"],
        tray,
        0.0006,
    )
    return tray, {"pan": pan, "grate": grate, "badge": apron_badge}


def build_portafilter(root: bpy.types.Object, mat: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Detachable 58 mm stainless double-spout Victoria Arduino angled ergonomic portafilter."""
    pf = empty("e1p_portafilter", PF_REST_POSE, root)
    lathe(
        "e1p_pf_basket_head",
        [
            (0.0295, 0.0110),
            (0.0385, 0.0070),
            (0.0395, -0.0090),
            (0.0310, -0.0220),
            (0.0125, -0.0255),
            (0.0125, -0.0205),
            (0.0275, -0.0165),
            (0.0325, -0.0045),
            (0.0325, 0.0110),
        ],
        (0.0, 0.0, 0.0),
        mat["chrome"],
        pf,
        48,
    )
    # Two opposing bayonet locking ears whose underside sits at local Z = -0.0100 (world Z = 0.2040 m)
    for sign, tag in ((-1, "left"), (1, "right")):
        box(
            f"e1p_pf_bayonet_ear_{tag}",
            (sign * 0.0395, 0.0, -0.0065),
            (0.0075, 0.0220, 0.0070),
            mat["chrome"],
            pf,
            0.0010,
        )
    cylinder("e1p_pf_filter_basket_18g", (0.0, 0.0, 0.0075), 0.0298, 0.0024, mat["stainless"], pf)

    # Angled chrome neck ferrule + 7-deg downward ergonomic soft-touch handle + flush chrome Victoria Arduino end cap
    neck = cylinder("e1p_pf_handle_ferrule", (0.0, -0.0510, -0.0055), 0.0115, 0.0380, mat["chrome"], pf, "Y")
    neck.rotation_euler.x = math.radians(7.0)

    grip = lathe(
        "e1p_pf_ergonomic_handle",
        [
            (0.0002, 0.0000),
            (0.0108, 0.0000),
            (0.0132, 0.0180),
            (0.0156, 0.0980),
            (0.0142, 0.1220),
            (0.0140, 0.1255),
            (0.0002, 0.1260),
        ],
        (0.0, 0.0, 0.0),
        mat["rubber"],
        pf,
        48,
    )
    grip.location = (0.0, -0.0680, -0.0076)
    grip.rotation_euler.x = math.radians(97.0)

    # End of grip at s = 0.1260 along (0, -cos 7 deg, -sin 7 deg) = (0, -0.1931, -0.0230)
    pommel = cylinder("e1p_pf_chrome_pommel", (0.0, -0.1965, -0.0234), 0.0142, 0.0085, mat["chrome"], pf, "Y")
    pommel.rotation_euler.x = math.radians(7.0)

    # Symmetric commercial stainless double spouts
    cylinder("e1p_pf_spout_manifold", (0.0, 0.0, -0.0270), 0.0115, 0.0100, mat["chrome"], pf)
    for sign, tag in ((-1, "left"), (1, "right")):
        tube(
            f"e1p_pf_spout_{tag}",
            [
                (0.0, 0.0, -0.0290),
                (sign * 0.0175, -0.0040, -0.0365),
                (sign * 0.0230, -0.0120, -0.0420),
            ],
            0.0048,
            mat["chrome"],
            pf,
            smooth=True,
        )
    return pf


def clean_mesh_object(obj: bpy.types.Object) -> None:
    """Apply modifiers in-place and remove degenerate/duplicate faces while keeping crisp normals."""
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        if mod.type == "BEVEL":
            mod.use_clamp_overlap = True
        bpy.ops.object.modifier_apply(modifier=mod.name)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=list(bm.edges))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def apply_e1p_uvs(
    root: bpy.types.Object,
    body_refs: dict[str, bpy.types.Object],
    tray_refs: dict[str, bpy.types.Object],
    mat: dict[str, bpy.types.Material],
) -> None:
    bpy.context.view_layer.update()
    stainless_mats = {mat["stainless"], mat["stainless_dark"]}
    for obj in root.children_recursive:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        m0 = obj.data.materials[0]
        if m0 in stainless_mats:
            project_stainless_uvs(obj, scale=2.4)

    project_front_planar_uvs(body_refs["ghost_win"], 0.0, 0.3075, 0.0440, 0.0220, local_space=False)
    project_front_planar_uvs(body_refs["front_plaque"], -0.1180, 0.1460, 0.0840, 0.0315, local_space=False)
    project_front_planar_uvs(tray_refs["badge"], 0.0, 0.0640, 0.0820, 0.0260, local_space=False)
    project_rear_planar_uvs(body_refs["rear_badge"], 0.0, 0.2640, 0.1680, 0.0420)


def enforce_exact_machine_envelope(
    root: bpy.types.Object,
    pf: bpy.types.Object,
) -> tuple[Vector, Vector, Vector, Vector, Vector, Vector]:
    """Clamp sub-millimetre bevel rounding at outer boundary planes and verify exact 411x510x379 mm."""
    bpy.context.view_layer.update()
    excluded = {pf, *pf.children_recursive}
    machine_meshes = [
        o for o in root.children_recursive if o.type == "MESH" and o not in excluded
    ]
    half_w = WIDTH * 0.5
    half_d = DEPTH * 0.5
    for obj in machine_meshes:
        mw = obj.matrix_world
        inv = mw.inverted()
        changed = False
        for v in obj.data.vertices:
            wpt = mw @ v.co
            nx = min(max(wpt.x, -half_w), half_w)
            ny = min(max(wpt.y, -half_d), half_d)
            nz = min(max(wpt.z, 0.0), HEIGHT)
            if abs(nx - wpt.x) > 1e-9 or abs(ny - wpt.y) > 1e-9 or abs(nz - wpt.z) > 1e-9:
                v.co = inv @ Vector((nx, ny, nz))
                changed = True
        if changed:
            obj.data.update()

    bpy.context.view_layer.update()
    m_low, m_high = bounds(machine_meshes)
    a_low, a_high = bounds([o for o in root.children_recursive if o.type == "MESH"])
    return m_low, m_high, (m_high - m_low), a_low, a_high, (a_high - a_low)


def export_glbs(root: bpy.types.Object, pf: bpy.types.Object) -> None:
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    # Main single-package GLB (contains e1p_body + all moving nodes including e1p_portafilter)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_yup=True,
        export_animations=False,
    )

    # Companion detachable portafilter GLB centered at its own local origin
    orig_parent = pf.parent
    orig_loc = pf.location.copy()
    orig_rot = pf.rotation_euler.copy()
    pf.parent = None
    pf.location = (0.0, 0.0, 0.0)
    pf.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action="DESELECT")
    for obj in (pf, *pf.children_recursive):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = pf
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-portafilter.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_yup=True,
        export_animations=False,
    )

    pf.parent = orig_parent
    pf.location = orig_loc
    pf.rotation_euler = orig_rot
    bpy.context.view_layer.update()


def animate_timeline(
    wand: bpy.types.Object,
    steam_lever: bpy.types.Object,
    hw_lever: bpy.types.Object,
    tank_lid: bpy.types.Object,
    drip_tray: bpy.types.Object,
    pf: bpy.types.Object,
) -> None:
    """Keyframe 4 studio showcase poses: 1=Rest, 55=Service Open, 85=Active 9-bar & 2.1-bar Steam, 120=Rest."""
    rest_tray = Vector(DRIP_TRAY_ORIGIN)
    rest_pf = Vector(PF_REST_POSE)

    poses = (
        # frame, wand_rx, steam_lev_rx, hw_lev_rx, lid_rx, tray_loc, pf_loc, pf_rz
        (1, 0.0, 0.0, 0.0, 0.0, rest_tray, rest_pf, 0.0),
        (
            55,
            -0.32,
            0.0,
            0.0,
            -0.92,
            rest_tray + Vector((0.0, -0.145, 0.0)),
            Vector((0.085, -0.255, DRIP_GRATE_Z + 0.042)),
            0.35,
        ),
        (
            85,
            -0.46,
            0.42,
            0.28,
            0.0,
            rest_tray,
            rest_pf,
            0.0,
        ),
        (120, 0.0, 0.0, 0.0, 0.0, rest_tray, rest_pf, 0.0),
    )

    for fno, w_rx, sl_rx, hwl_rx, lid_rx, t_loc, p_loc, p_rz in poses:
        bpy.context.scene.frame_set(fno)
        wand.rotation_euler = (w_rx, 0.0, 0.0)
        steam_lever.rotation_euler = (sl_rx, 0.0, 0.0)
        hw_lever.rotation_euler = (hwl_rx, 0.0, 0.0)
        tank_lid.rotation_euler = (lid_rx, 0.0, 0.0)
        drip_tray.location = t_loc
        pf.location = p_loc
        pf.rotation_euler = (0.0, 0.0, p_rz)

        wand.keyframe_insert(data_path="rotation_euler", frame=fno)
        steam_lever.keyframe_insert(data_path="rotation_euler", frame=fno)
        hw_lever.keyframe_insert(data_path="rotation_euler", frame=fno)
        tank_lid.keyframe_insert(data_path="rotation_euler", frame=fno)
        drip_tray.keyframe_insert(data_path="location", frame=fno)
        pf.keyframe_insert(data_path="location", frame=fno)
        pf.keyframe_insert(data_path="rotation_euler", frame=fno)


def setup_studio(scene: bpy.types.Scene, floor_mat: bpy.types.Material) -> bpy.types.Object:
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
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    setup_softbox_world(scene, "E1PrimaSoftboxWorld", camera_bg_rgb=(0.72, 0.75, 0.79))

    studio_col = bpy.data.collections.new("Studio lighting & camera")
    scene.collection.children.link(studio_col)

    floor = box("Studio floor", (0.0, 0.0, -0.0020), (4.0, 4.0, 0.0040), floor_mat, None)
    for c in list(floor.users_collection):
        c.objects.unlink(floor)
    studio_col.objects.link(floor)

    for lname, lpos, ltgt, lenergy, lsize in (
        ("Key softbox", (-1.15, -1.55, 1.32), (0.0, -0.05, 0.22), 52.0, 1.15),
        ("Fill softbox", (1.28, -1.25, 0.92), (0.0, -0.05, 0.20), 28.0, 1.25),
        ("Top rim strip", (0.0, 0.35, 1.48), (0.0, 0.0, 0.26), 34.0, 1.35),
        ("Back accent", (0.65, 1.40, 0.78), (0.0, 0.12, 0.24), 22.0, 0.95),
    ):
        area_light(lname, lpos, ltgt, lenergy, lsize)
        lgt = bpy.data.objects.get(lname)
        if lgt is not None:
            for c in list(lgt.users_collection):
                c.objects.unlink(lgt)
            studio_col.objects.link(lgt)

    cam_data = bpy.data.cameras.new("StudioCamera")
    cam_data.type = "ORTHO"
    cam_obj = bpy.data.objects.new("StudioCamera", cam_data)
    studio_col.objects.link(cam_obj)
    scene.camera = cam_obj
    return cam_obj


def set_camera(
    cam: bpy.types.Object,
    pos: tuple[float, float, float],
    target: tuple[float, float, float],
    ortho_scale: float,
) -> None:
    cam.location = pos
    cam.data.ortho_scale = ortho_scale
    look_at(cam, target)


def inspect_exported_glb() -> dict:
    """Re-import exported GLB in a clean Blender factory scene and run full envelope + raycast + topology checks."""
    glb_path = ASSETS / f"{NAME}.glb"
    pf_glb_path = ASSETS / f"{NAME}-portafilter.glb"

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    bpy.context.view_layer.update()

    root = bpy.data.objects["e1p_body"]
    pf = bpy.data.objects["e1p_portafilter"]
    left_skin = bpy.data.objects["e1p_side_skin_left"]
    splash = bpy.data.objects["e1p_lower_splash_back"]
    plaque = bpy.data.objects["e1p_front_identity_plaque"]
    cup_deck = bpy.data.objects["e1p_cup_warmer_deck"]

    excluded = {pf, *pf.children_recursive}
    m_low, m_high = bounds(o for o in root.children_recursive if o not in excluded)
    dims = m_high - m_low
    for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
        near(actual, expected, "Published Victoria Arduino E1 PRIMA envelope")
    near(m_low.z, 0.0, "Machine foot contact plane Z=0.000")
    near(m_high.z, HEIGHT, "Cup-warmer perimeter guard rail Z=0.379")

    # Anti-z-fighting step check between splash back and front identity plaque
    sp_low, _ = bounds([splash])
    pq_low, _ = bounds([plaque])
    front_plaque_step_mm = round((sp_low.y - pq_low.y) * 1000.0, 2)
    assert front_plaque_step_mm >= 1.5, f"Front plaque step too small: {front_plaque_step_mm} mm"

    # Fault-injection guard: shifting side skin outward by -10 mm must fail width check
    orig_x = left_skin.location.x
    left_skin.location.x -= 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        fl, fh = bounds(o for o in root.children_recursive if o not in excluded)
        near((fh - fl).x, WIDTH, "Fault check")
    except AssertionError:
        fault_detected = True
    left_skin.location.x = orig_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope fault-injection guard failed"

    # Verify all 4 feet touch Z = 0.000 m
    foot_count = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "EMPTY" and obj.name.startswith("e1p_foot_"):
            fl, _ = bounds(obj.children_recursive)
            near(fl.z, 0.0, f"Foot contact plane {obj.name}")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Raycast downward onto diamond-perforated cup-warmer deck (Z = 0.3620 m, solid tile web between diamonds)
    # and diamond-perforated drip-tray grate (Z = 0.0980 m, solid tile web seam at X = 0.0, Y = -0.1720 m)
    orig_pf_loc = pf.location.copy()
    pf.location = Vector((0.0, -0.55, 0.22))
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    # Tile seam X = 0.0 (nx=18 is even, so X=0.0 is a solid web seam between diamond openings!)
    hit_cw, pt_cw, nrm_cw, _f, obj_cw, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, 0.0020, 0.4400)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_cw and obj_cw == cup_deck, obj_cw
    near(pt_cw.z, CUP_DECK_Z + 0.0012, "Cup-warmer deck top surface")
    assert nrm_cw.z > 0.99

    # Drip grate nx=22 (even -> X=0.0 is a solid web seam between diamond openings!)
    hit_dt, pt_dt, nrm_dt, _f, obj_dt, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, -0.1720, 0.1750)), Vector((0.0, 0.0, -1.0))
    )
    assert hit_dt and obj_dt is not None and "drip_tray_grate" in obj_dt.name, obj_dt
    near(pt_dt.z, DRIP_GRATE_Z, "Drip-tray diamond grate Z=0.0980")
    assert nrm_dt.z > 0.95

    pf.location = orig_pf_loc
    bpy.context.view_layer.update()

    required_meshes = {
        "e1p_side_skin_left",
        "e1p_side_skin_right",
        "e1p_front_control_fascia",
        "e1p_lower_splash_back",
        "e1p_front_identity_plaque",
        "e1p_rear_ribbed_panel",
        "e1p_rear_eagle_emblem",
        "e1p_rear_wordmark_plaque",
        "e1p_cup_warmer_deck",
        "e1p_water_reservoir_1_5l",
        "e1p_steam_boiler_1_5l",
        "e1p_neo_brew_boiler_0_2l",
        "e1p_group_chrome_hood",
        "e1p_group_control_shield",
        "e1p_ghost_display_window",
        "e1p_group_head_58mm",
        "e1p_hot_water_wand_tube",
        "e1p_steam_wand_tube",
        "e1p_steam_blade_paddle",
        "e1p_hot_water_blade_paddle",
        "e1p_tank_lid_plate",
        "e1p_drip_tray_pan",
        "e1p_drip_tray_grate",
        "e1p_pf_basket_head",
        "e1p_pf_ergonomic_handle",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "portafilter_glb_sha256": hashlib.sha256(pf_glb_path.read_bytes()).hexdigest(),
        "portafilter_glb_bytes": pf_glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "machine_bounds_min_m": [round(v, 6) for v in m_low],
        "machine_bounds_max_m": [round(v, 6) for v in m_high],
        "machine_dimensions_m": [round(v, 6) for v in dims],
        "cup_warmer_plane_z_m": round(pt_cw.z, 6),
        "drip_grate_plane_z_m": round(pt_dt.z, 6),
        "front_plaque_step_mm": front_plaque_step_mm,
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import exported victoria-arduino-e1-prima.glb; verify exact 411x510x379 mm machine envelope, "
            "Z=0.000 m feet plane, Z=0.379 m cup-warmer guard rail, diamond-perforated cup-warmer deck and "
            "Z=0.098 m drip grate, right Steam-by-Wire lever + Cool-Touch wand, left hot-water lever + wand, "
            "Ghost Display shot timer, rear 1905 Eagle emblem, fault-injection width guard, and zero mesh defects."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def move_objects(objs: list[bpy.types.Object], target_col: bpy.types.Collection) -> None:
    for obj in objs:
        for col in list(obj.users_collection):
            col.objects.unlink(obj)
        target_col.objects.link(obj)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    if not bpy.app.background:
        raise RuntimeError("Run in a background Blender process.")

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    col_img, orm_img = generate_stainless_hairline_textures(
        ASSETS,
        "e1p",
        base_rgb=(0.76, 0.78, 0.81),
        streak_amp=0.040,
        rough_base=0.24,
        seed=6105,
    )
    ghost_img, badge_img, rear_img = bake_e1_prima_decals()

    scene = bpy.context.scene
    scene.name = "Victoria Arduino E1 PRIMA - 1-Group Espresso Machine"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for m_name, f_no in (
        ("Rest", 1),
        ("1.5L reservoir & diamond drip tray open", 55),
        ("Active 9 bar NEO extraction & 2.1 bar Steam-by-Wire", 85),
        ("Rest restored", 120),
    ):
        scene.timeline_markers.new(m_name, frame=f_no)

    mat = surfaces(col_img, orm_img, ghost_img, badge_img, rear_img)

    root = empty("e1p_body", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Victoria Arduino (Simonelli Group)"
    root["model"] = "E1 PRIMA"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_machine_mass_kg"] = 37.000
    root["portafilter_mass_kg"] = 0.540

    body_refs = build_machine_body(root, mat)
    wand = build_steam_wand(root, mat)
    steam_lever = build_paddle_lever("e1p_steam_lever", "e1p_steam", STEAM_LEVER_ORIGIN, root, mat)
    hw_lever = build_paddle_lever("e1p_hot_water_lever", "e1p_hot_water", HOT_WATER_LEVER_ORIGIN, root, mat)
    tank_lid = build_tank_lid(root, mat)
    drip_tray, tray_refs = build_drip_tray(root, mat)
    pf = build_portafilter(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, wand, steam_lever, hw_lever, tank_lid, drip_tray, pf])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj)

    m_low, m_high, m_dims, a_low, a_high, a_dims = enforce_exact_machine_envelope(root, pf)
    for actual, expected in zip(m_dims, (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 2e-4, (m_low, m_high, m_dims, (WIDTH, DEPTH, HEIGHT))
    assert abs(m_low.z - 0.0) <= 1e-5, m_low

    apply_e1p_uvs(root, body_refs, tray_refs, mat)

    # Export static rest-pose GLBs at frame 1 with animation data cleared
    export_glbs(root, pf)

    # Keyframe timeline for .blend authoring and Cycles studio showcase renders
    animate_timeline(wand, steam_lever, hw_lever, tank_lid, drip_tray, pf)

    appliance_col = bpy.data.collections.new("Victoria Arduino E1 PRIMA appliance")
    scene.collection.children.link(appliance_col)
    move_objects([root, *root.children_recursive], appliance_col)

    camera = setup_studio(scene, mat["studio_floor"])
    views = (
        ("studio-main", (1.06, -1.72, 0.74), (0.0, -0.04, 0.20), 0.74, 1),
        ("studio-front", (0.0, -1.95, 0.20), (0.0, -0.03, 0.20), 0.66, 1),
        ("studio-right", (1.95, -0.02, 0.20), (0.0, -0.02, 0.20), 0.76, 1),
        ("studio-rear", (-0.98, 1.76, 0.68), (0.0, 0.04, 0.20), 0.72, 1),
        ("studio-open", (-1.08, -1.78, 0.88), (0.01, -0.05, 0.22), 0.86, 55),
        ("studio-active", (0.78, -1.48, 0.50), (0.01, -0.11, 0.22), 0.58, 85),
    )
    rendered_files: list[str] = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = ASSETS / f"{vname}.png"
            scene.render.filepath = str(out_png)
            bpy.ops.render.render(write_still=True)
            rendered_files.append(f"{vname}.png")

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])

    for m in bpy.data.materials:
        m["metallic"] = float(m.get("metallic", 0.0))
        m["roughness"] = float(m.get("roughness", 0.35))
        m["emission"] = float(m.get("emission", 0.0))

    build_report = {
        "asset": NAME,
        "title": "Victoria Arduino E1 PRIMA 1-Group Espresso Machine",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "machine_bounds_min_m": [round(v, 6) for v in m_low],
        "machine_bounds_max_m": [round(v, 6) for v in m_high],
        "machine_dimensions_m": [round(v, 6) for v in m_dims],
        "with_portafilter_bounds_min_m": [round(v, 6) for v in a_low],
        "with_portafilter_bounds_max_m": [round(v, 6) for v in a_high],
        "with_portafilter_dimensions_m": [round(v, 6) for v in a_dims],
        "published_machine_mass_kg": 37.000,
        "detachable_portafilter_mass_kg": 0.540,
        "electrical_supply": "Single-phase 220-240 V / 110-120 V / JP 200 V AC, 50/60 Hz, 1,600-2,600 W",
        "hydraulic_system": "NEO 0.20 L instant stainless brew boiler + 1.5 L insulated stainless steam boiler (2.1 bar Steam-by-Wire)",
        "water_reservoir_l": 1.5,
        "glb_sha256": hashlib.sha256((ASSETS / f"{NAME}.glb").read_bytes()).hexdigest(),
        "portafilter_glb_sha256": hashlib.sha256((ASSETS / f"{NAME}-portafilter.glb").read_bytes()).hexdigest(),
        "renders": rendered_files,
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))

    inspection = inspect_exported_glb()
    print(json.dumps({"build": build_report, "inspection": inspection["status"]}, indent=2))


if __name__ == "__main__":
    main()
