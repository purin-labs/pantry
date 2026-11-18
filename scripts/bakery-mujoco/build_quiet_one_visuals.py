"""Build the US Vitamix Quiet One 36019 with twist-lock enclosure.

Manufacturer overall dimensions constrain a photographic reconstruction.
Metres, Z up, front -Y. Internal fits and motion limits remain estimates.
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
    project_front_planar_uvs,
    project_stainless_uvs,
    setup_softbox_world,
    textured_decal_material,
    textured_stainless_material,
)
from build_mixer_visuals import lathe, loft_z, mesh_object
from build_oven_visuals import (
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
from inspect_induction import bounds

REPOSITORY = Path(__file__).resolve().parents[2]
ASSETS = REPOSITORY / "assets/bakery-mujoco/vitamix-quiet-one"
REFERENCES = REPOSITORY / "docs/equipment/vitamix-quiet-one/images"
WIDTH, DEPTH, HEIGHT = 0.2159, 0.27178, 0.4572
HINGE = (0, 0.086, 0.367)
JAR_ORIGIN = (-0.009, 0.003, 0.173)
OPEN_ANGLE = math.radians(-105)


LCD_GLYPHS_5X7 = {
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
}
LCD_WIDTH_M = 0.066
LCD_HEIGHT_M = 0.013


def lcd_active_dot_centers():
    """Return physical (dx, dz) centers on the 66x13 mm 16x2 dot-matrix LCD."""
    dots = []
    entries = [(0, 5 + i, ch) for i, ch in enumerate("READY")] + [(1, 15, "1")]
    for row, col, ch in entries:
        glyph = LCD_GLYPHS_5X7[ch]
        cx = (col - 7.5) * 0.00372
        cz = 0.00245 if row == 0 else -0.00245
        for dr, line in enumerate(glyph):
            for dc, bit in enumerate(line):
                if bit == "1":
                    dots.append((cx + (dc - 2.0) * 0.00060, cz + (3.0 - dr) * 0.00060))
    return dots


def bake_tqo_lcd_decal():
    """Bake a 512x256 orthographic 16x2 dot-matrix LCD decal for the Quiet One."""
    bake_h = 0.033
    y_scale = bake_h / LCD_HEIGHT_M

    def add_lcd_rect(scn, name, px, pz, w, h, z_layer, mat, radius=0.0):
        pts = (
            rounded_rectangle(w, h, radius, segments=6)
            if radius > 1e-5
            else [(w / 2, h / 2), (-w / 2, h / 2), (-w / 2, -h / 2), (w / 2, -h / 2)]
        )
        m = bpy.data.meshes.new(name)
        m.from_pydata(
            [(px + x, (pz + y) * y_scale, z_layer) for x, y in pts],
            [],
            [tuple(range(len(pts)))],
        )
        m.update()
        o = bpy.data.objects.new(name, m)
        scn.collection.objects.link(o)
        o.data.materials.append(mat)
        return o

    def build_sheet(scn, emit_mat, _font_jp, _font_en):
        m_rim = emit_mat("rim", (0.10, 0.14, 0.17, 1.0))
        m_edge = emit_mat("edge", (0.34, 0.45, 0.52, 1.0))
        m_bg = emit_mat("bg", (0.45, 0.57, 0.64, 1.0))
        m_glow = emit_mat("glow", (0.49, 0.61, 0.68, 1.0))
        m_cell = emit_mat("cell", (0.39, 0.50, 0.57, 1.0))
        m_pix = emit_mat("pix", (0.005, 0.016, 0.068, 1.0))

        add_lcd_rect(scn, "lcd_rim", 0.0, 0.0, LCD_WIDTH_M, LCD_HEIGHT_M, 0.0, m_rim)
        add_lcd_rect(scn, "lcd_edge", 0.0, 0.0, 0.0650, 0.0120, 0.0005, m_edge, 0.0004)
        add_lcd_rect(scn, "lcd_bg", 0.0, 0.0, 0.0642, 0.0114, 0.0010, m_bg, 0.0003)
        add_lcd_rect(scn, "lcd_glow", 0.0, 0.0, 0.0596, 0.0098, 0.0013, m_glow, 0.0008)

        # 16x2 character matrix subtle cell blocks
        for row in (0, 1):
            cz = 0.00245 if row == 0 else -0.00245
            for col in range(16):
                cx = (col - 7.5) * 0.00372
                add_lcd_rect(
                    scn, f"c_{row}_{col}", cx, cz, 0.00308, 0.00428, 0.0018, m_cell
                )

        # Crisp 5x7 active navy-cobalt LCD dots ("READY" + program "1")
        verts = []
        faces = []
        half = 0.000275
        for dx, dz in lcd_active_dot_centers():
            base = len(verts)
            verts.extend(
                [
                    (dx - half, (dz - half) * y_scale, 0.0025),
                    (dx + half, (dz - half) * y_scale, 0.0025),
                    (dx + half, (dz + half) * y_scale, 0.0025),
                    (dx - half, (dz + half) * y_scale, 0.0025),
                ]
            )
            faces.append((base, base + 1, base + 2, base + 3))
        pm = bpy.data.meshes.new("lcd_dots")
        pm.from_pydata(verts, [], faces)
        pm.update()
        po = bpy.data.objects.new("lcd_dots", pm)
        scn.collection.objects.link(po)
        po.data.materials.append(m_pix)

    return bake_ortho_sheet(
        ASSETS / "tqo-lcd-decal.png", 512, 256, LCD_WIDTH_M, bake_h, build_sheet
    )


def palette():
    ss_col, ss_orm = generate_stainless_hairline_textures(
        ASSETS,
        "tqo",
        base_rgb=(0.74, 0.76, 0.79),
        streak_amp=0.045,
        rough_base=0.25,
        seed=36019,
    )
    lcd_img = bake_tqo_lcd_decal()
    lcd_mat = textured_decal_material(
        "TQO pale LCD",
        lcd_img,
        fallback_rgba=(0.56, 0.66, 0.72, 1.0),
        roughness=0.14,
        metallic=0.0,
        coat=0.18,
    )
    lcd_nt = lcd_mat.node_tree
    lcd_bsdf = lcd_nt.nodes["Principled BSDF"]
    lcd_bsdf.inputs["Emission Color"].default_value = (0.56, 0.66, 0.72, 1.0)
    lcd_bsdf.inputs["Emission Strength"].default_value = 0.18
    lcd_tex = next(n for n in lcd_nt.nodes if n.type == "TEX_IMAGE")
    lcd_nt.links.new(lcd_tex.outputs["Color"], lcd_bsdf.inputs["Emission Color"])
    lcd_mat["emission"] = 0.18

    mat = {
        "body": material(
            "TQO textured black housing", (0.009, 0.010, 0.012, 1.0), 0.03, 0.40
        ),
        "frame": material(
            "TQO black enclosure frame", (0.004, 0.005, 0.006, 1.0), 0.08, 0.25
        ),
        "rubber": material(
            "TQO elastomer pad and lid", (0.011, 0.012, 0.014, 1.0), 0.0, 0.54
        ),
        "steel": textured_stainless_material(
            "TQO stainless blade",
            ss_col,
            ss_orm,
            tint=(0.62, 0.65, 0.68, 1.0),
            metallic=0.93,
            roughness=0.20,
            coat=0.04,
        ),
        "silver": textured_stainless_material(
            "TQO satin silver handle",
            ss_col,
            ss_orm,
            tint=(0.58, 0.61, 0.64, 1.0),
            metallic=0.90,
            roughness=0.23,
            coat=0.06,
        ),
        "panel": textured_stainless_material(
            "TQO brushed keypad",
            ss_col,
            ss_orm,
            tint=(0.065, 0.070, 0.076, 1.0),
            metallic=0.82,
            roughness=0.30,
            coat=0.08,
        ),
        "ink": material("TQO dark jug ink", (0.010, 0.012, 0.015, 1.0), 0.0, 0.48),
        "white": material(
            "TQO pale panel printing", (0.78, 0.80, 0.82, 1.0), 0.0, 0.42
        ),
        "lcd": lcd_mat,
        "pixel": material("TQO LCD dark pixels", (0.006, 0.020, 0.075, 1.0), 0.0, 0.25),
        "clear": material(
            "TQO clear enclosure polymer", (0.93, 0.96, 0.99, 1.0), 0.0, 0.032
        ),
        "jar": material(
            "TQO clear container polymer", (0.93, 0.96, 0.99, 1.0), 0.0, 0.032
        ),
    }
    for key, bump_strength in (("panel", 0.18), ("silver", 0.09), ("steel", 0.07)):
        nt = mat[key].node_tree
        bsdf = nt.nodes["Principled BSDF"]
        tex_c = next(
            n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image == ss_col
        )
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_strength
        bump.inputs["Distance"].default_value = 0.00035
        nt.links.new(tex_c.outputs["Color"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    mat["body"].node_tree.nodes["Principled BSDF"].inputs[
        "Specular IOR Level"
    ].default_value = 0.15
    mat["rubber"].node_tree.nodes["Principled BSDF"].inputs[
        "Specular IOR Level"
    ].default_value = 0.12
    frame_bsdf = mat["frame"].node_tree.nodes["Principled BSDF"]
    frame_bsdf.inputs["Specular IOR Level"].default_value = 0.22
    for key in ("clear", "jar"):
        shader = mat[key].node_tree.nodes["Principled BSDF"]
        shader.inputs["Transmission Weight"].default_value = 1.0
        shader.inputs["IOR"].default_value = 1.49
        shader.inputs["Specular IOR Level"].default_value = 0.5
    return mat


def text(name, value, position, size, surface, parent, front=False, bold=False):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.resolution_u = 4
    curve.extrude = 0.000015
    if bold:
        curve.font = bpy.data.fonts.load(
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        )
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    if front:
        obj.rotation_euler.x = math.pi / 2
    return finish(obj, name, surface, parent)


def boolean_cut(obj, cutter):
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new("Authored opening", "BOOLEAN")
    modifier.object = cutter
    modifier.operation = "DIFFERENCE"
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def motor_base(root, mat):
    base = loft_z(
        "Moulded motor housing",
        [
            (0.004, 0, 0, 0.211, 0.244, 0.009),
            (0.065, 0, 0, WIDTH, 0.248, 0.010),
            (0.150, 0, 0, 0.207, 0.244, 0.011),
            (0.164, 0, 0, 0.210, 0.246, 0.008),
        ],
        mat["body"],
        root,
    )
    recess = box(
        "Front lower relief cutter",
        (0, -0.126, 0.016),
        (0.149, 0.023, 0.041),
        mat["body"],
        None,
        0.004,
    )
    boolean_cut(base, recess)
    keypad_cut = box(
        "Keypad cavity cutter",
        (0, -0.127, 0.110),
        (0.165, 0.029, 0.077),
        mat["body"],
        None,
        0.004,
    )
    boolean_cut(base, keypad_cut)
    box(
        "Recessed lower front",
        (0, -0.118, 0.037),
        (0.145, 0.002, 0.055),
        mat["frame"],
        root,
        0.008,
    )
    for x in (-0.086, 0.086):
        for y in (-0.094, 0.094):
            foot = empty(f"tqo_foot_{x}_{y}", (x, y, 0), root)
            box(
                "Rubber foot",
                (0, 0, 0.002),
                (0.026, 0.030, 0.004),
                mat["rubber"],
                foot,
                0.003,
            )
    box(
        "Upper motor adapter plate",
        (0, 0, 0.1635),
        (0.211, 0.247, 0.005),
        mat["frame"],
        root,
        0.008,
    )
    for side in (-1, 1):
        box(
            "Side air intake recess",
            (side * 0.107, 0.055, 0.030),
            (0.001, 0.075, 0.014),
            mat["frame"],
            root,
            0.005,
        )
        for i in range(12):
            box(
                "Intake grille fin",
                (side * 0.1076, 0.022 + i * 0.006, 0.030),
                (0.0006, 0.0015, 0.011),
                mat["body"],
                root,
                0.0004,
            )
    for z in (0.051, 0.057, 0.063, 0.069):
        box(
            "Rear ventilation recess",
            (0, 0.124, z),
            (0.14, 0.0005, 0.003),
            mat["frame"],
            root,
            0.001,
        )
    switch = empty("tqo_power_switch", (0.063, 0.120, 0.112), root)
    box(
        "Rear switch surround",
        (0, 0, 0),
        (0.018, 0.003, 0.024),
        mat["frame"],
        switch,
        0.002,
    )
    box(
        "Rocker switch",
        (0, 0.002, 0),
        (0.013, 0.004, 0.018),
        mat["rubber"],
        switch,
        0.001,
    )
    pad = empty("tqo_centering_pad", JAR_ORIGIN, root)
    box(
        "Removable centering pad",
        (0, 0, -0.003),
        (0.149, 0.158, 0.009),
        mat["rubber"],
        pad,
        0.016,
    )
    for x in (-0.044, 0.044):
        for y in (-0.047, 0.047):
            cylinder("Centering post", (x, y, 0.007), 0.009, 0.019, mat["rubber"], pad)
    drive = empty("tqo_drive_socket", JAR_ORIGIN, root)
    lathe(
        "Drive socket with recess",
        [
            (0.011, 0),
            (0.019, 0),
            (0.020, 0.012),
            (0.011, 0.015),
            (0.009, 0.012),
            (0.009, 0),
        ],
        (0, 0, 0),
        mat["steel"],
        drive,
        96,
    )
    empty("tqo_container_seat", JAR_ORIGIN, root)
    return pad


def control_panel(root, mat):
    panel = empty("tqo_control_panel", (0, -0.117, 0.110), root)
    panel.rotation_euler.x = math.radians(90)
    box(
        "Keypad inset bezel",
        (0, 0, 0),
        (0.161, 0.071, 0.003),
        mat["frame"],
        panel,
        0.006,
    )
    box(
        "Brushed control fascia",
        (0, -0.002, 0.0018),
        (0.151, 0.061, 0.001),
        mat["panel"],
        panel,
        0.002,
    )
    box(
        "Display mask",
        (0, 0.010, 0.0025),
        (0.074, 0.037, 0.0006),
        mat["frame"],
        panel,
        0.001,
    )
    text(
        "Vitamix brand",
        "Vitamix",
        (0.0044, 0.0228, 0.0031),
        0.0076,
        mat["white"],
        panel,
        bold=True,
    )
    text(
        "Commercial label",
        "COMMERCIAL",
        (0.0064, 0.0168, 0.0031),
        0.0025,
        mat["white"],
        panel,
        bold=True,
    )
    box(
        "LCD window",
        (0, 0.0075, 0.003),
        (LCD_WIDTH_M, LCD_HEIGHT_M, 0.0005),
        mat["lcd"],
        panel,
        0.0,
    )
    pix_verts = []
    pix_faces = []
    half = 0.000275
    z0, z1 = 0.00326, 0.00330
    for dx, dz in lcd_active_dot_centers():
        b = len(pix_verts)
        py = 0.0075 + dz
        pix_verts.extend(
            [
                (dx - half, py - half, z0),
                (dx + half, py - half, z0),
                (dx + half, py + half, z0),
                (dx - half, py + half, z0),
                (dx - half, py - half, z1),
                (dx + half, py - half, z1),
                (dx + half, py + half, z1),
                (dx - half, py + half, z1),
            ]
        )
        pix_faces.extend(
            [
                (b + 0, b + 3, b + 2, b + 1),
                (b + 4, b + 5, b + 6, b + 7),
                (b + 0, b + 1, b + 5, b + 4),
                (b + 1, b + 2, b + 6, b + 5),
                (b + 2, b + 3, b + 7, b + 6),
                (b + 3, b + 0, b + 4, b + 7),
            ]
        )
    pix_obj = mesh_object(
        "LCD ready preview", pix_verts, pix_faces, mat["pixel"], panel
    )
    pix_obj.modifiers.clear()
    for poly in pix_obj.data.polygons:
        poly.use_smooth = False
    text(
        "Quiet One label",
        "THE QUIET ONE",
        (0, -0.0038, 0.0031),
        0.0027,
        mat["white"],
        panel,
        bold=True,
    )
    buttons = []
    items = [
        ("start_stop", -0.063, 0.001, ""),
        ("speed_up", -0.049, 0.011, ""),
        ("speed_down", -0.049, -0.007, ""),
        ("pulse_high", 0.056, 0.011, ""),
        ("pulse_low", 0.056, -0.007, ""),
    ]
    items.extend(
        (f"preset_{i + 1}", -0.046 + i * 0.0184, -0.024, str(i + 1)) for i in range(6)
    )
    for name, x, y, value in items:
        button = empty("tqo_" + name, (x, y, 0.003), panel)
        box(
            "Button pale outline",
            (0, 0, 0),
            (0.012, 0.012, 0.0006),
            mat["white"],
            button,
            0.002,
        )
        box(
            "Button black face",
            (0, 0, 0.0003),
            (0.0105, 0.0105, 0.0006),
            mat["frame"],
            button,
            0.0018,
        )
        text("Button legend", value, (0, 0, 0.00065), 0.007, mat["white"], button)
        buttons.append(button)
    for index, direction in ((1, 1), (2, -1)):
        mesh_object(
            "Speed arrow",
            [
                (-0.003, -0.002 * direction, 0.0008),
                (0.003, -0.002 * direction, 0.0008),
                (0, 0.003 * direction, 0.0008),
            ],
            [(0, 1, 2)],
            mat["white"],
            buttons[index],
        )
    for index, height in ((3, 0.003), (4, 0.0015)):
        tube(
            "Pulse waveform",
            [
                (-0.0035, -0.002, 0.0008),
                (-0.0016, -0.002, 0.0008),
                (-0.0016, height, 0.0008),
                (0.0016, height, 0.0008),
                (0.0016, -0.002, 0.0008),
                (0.0035, -0.002, 0.0008),
            ],
            0.00035,
            mat["white"],
            buttons[index],
        )
    start = buttons[0]
    mesh_object(
        "Start triangle",
        [(-0.0025, 0.003, 0.0007), (-0.0025, 0, 0.0007), (0.0025, 0.0015, 0.0007)],
        [(0, 1, 2)],
        mat["white"],
        start,
    )
    box(
        "Stop square",
        (0, -0.0025, 0.0007),
        (0.003, 0.0028, 0.0001),
        mat["white"],
        start,
        0,
    )
    return buttons


def prism_yz(name, outline, x, thickness, surface, parent):
    count = len(outline)
    vertices = [
        (offset, y, z)
        for offset in (x - thickness / 2, x + thickness / 2)
        for y, z in outline
    ]
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, j + count, i + count))
    return mesh_object(name, vertices, faces, surface, parent, 0.001)


def enclosure(root, mat):
    fixed = empty("tqo_enclosure_frame", (0, 0, 0), root)
    fixed["type"] = "Twist-lock frame; base-release motion not calibrated"
    rail = frame(
        "Lower enclosure frame",
        (0, 0, 0),
        (0.210, 0.242, 0.010),
        (0.198, 0.227, 0.007),
        0.006,
        mat["frame"],
        fixed,
    )
    rail.rotation_euler.x = math.pi / 2
    rail.location.z = 0.169
    box(
        "Fixed clear rear enclosure",
        (0, 0.117, 0.304),
        (0.199, 0.0025, 0.263),
        mat["clear"],
        fixed,
        0.003,
    )
    outline = [
        (-0.021, 0.17),
        (-0.014, 0.235),
        (0.002, 0.285),
        (0.027, 0.326),
        (0.066, 0.353),
        (0.065, 0.378),
        (0.085, 0.408),
        (0.112, 0.438),
        (0.120, 0.430),
        (0.108, 0.384),
        (0.105, 0.358),
        (0.079, 0.337),
        (0.036, 0.295),
        (0.018, 0.235),
        (0.007, 0.17),
    ]
    for side in (-1, 1):
        prism_yz(
            "Curved black hinge upright",
            outline,
            side * 0.096,
            0.006,
            mat["frame"],
            fixed,
        )
        cylinder(
            "Fixed hinge boss",
            (side * 0.100, HINGE[1], HINGE[2]),
            0.016,
            0.005,
            mat["frame"],
            fixed,
            "X",
        )
        cylinder(
            "Hinge bearing face",
            (side * 0.103, HINGE[1], HINGE[2]),
            0.0105,
            0.001,
            mat["silver"],
            fixed,
            "X",
        )
    hood = empty("tqo_enclosure_door", HINGE, fixed)
    hood["preview_open_degrees"] = 105
    # Front-to-roof path, ending at the rear roof seam. The inner wall follows
    # the same path, so the sound cover remains a thin shell with an open bottom.
    path = [(-0.123, 0.169), (-0.123, HEIGHT - 0.0615)]
    for index in range(1, 25):
        angle = math.pi - index * math.pi / 48
        path.append(
            (
                -0.063 + 0.060 * math.cos(angle),
                HEIGHT - 0.0615 + 0.060 * math.sin(angle),
            )
        )
    path.append((0.107, HEIGHT - 0.0015))
    vertices = []
    for y, z in path:
        for x in (-0.1045, 0.1045):
            vertices.append((x, y - HINGE[1], z - HINGE[2]))
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(path) - 1)]
    shell = mesh_object(
        "Clear front and roof shell", vertices, faces, mat["clear"], hood
    )
    shell.modifiers.remove(shell.modifiers["Weighted surface normals"])
    for polygon in shell.data.polygons:
        polygon.use_smooth = polygon.index not in (0, len(shell.data.polygons) - 1)
    solid = shell.modifiers.new("Estimated 3 mm cover wall", "SOLIDIFY")
    solid.thickness = 0.003
    solid.offset = 0
    # Door cheek outlines stay outside the fixed uprights, around the hinge axis.
    side_outline = path + [
        (0.109, 0.407),
        (0.106, 0.376),
        (0.092, 0.345),
        (0.067, 0.324),
        (0.03, 0.290),
        (0.005, 0.245),
        (-0.005, 0.169),
    ]
    for side in (-1, 1):
        local = [(y - HINGE[1], z - HINGE[2]) for y, z in side_outline]
        prism_yz(
            "Clear enclosure side cheek",
            local,
            side * 0.1045,
            0.0025,
            mat["clear"],
            hood,
        )
        tube(
            "Moulded door side rim",
            [(side * 0.1045, y - HINGE[1], z - HINGE[2]) for y, z in side_outline],
            0.0012,
            mat["clear"],
            hood,
            cyclic=True,
        )
    handle = empty(
        "tqo_enclosure_handle", (0, -0.139 - HINGE[1], 0.264 - HINGE[2]), hood
    )
    # Gently bowed silver handle, shaped from the photographed front elevation.
    verts = []
    for x in (-0.094, -0.08, -0.045, 0, 0.045, 0.08, 0.094):
        half = 0.015 if abs(x) > 0.07 else 0.010
        y = -0.006 * (1 - (x / 0.094) ** 2)
        verts.extend(
            [
                (x, y - 0.00278, -half),
                (x, y - 0.00278, half),
                (x, y + 0.002, -half),
                (x, y + 0.002, half),
            ]
        )
    faces = []
    for i in range(6):
        a = i * 4
        b = a + 4
        faces.extend(
            [
                (a, b, b + 1, a + 1),
                (a + 2, a + 3, b + 3, b + 2),
                (a, a + 2, b + 2, b),
                (a + 1, b + 1, b + 3, a + 3),
            ]
        )
    faces.extend([(0, 1, 3, 2), (24, 26, 27, 25)])
    mesh_object(
        "Bowed silver enclosure handle", verts, faces, mat["silver"], handle, 0.002
    )
    for x in (-0.084, 0.084):
        box(
            "Handle mounting foot",
            (x, 0.010, 0),
            (0.018, 0.014, 0.017),
            mat["clear"],
            handle,
            0.003,
        )
    return fixed, hood


def container_contour(scale=1):
    corners = [Vector((-0.106, -0.068)), Vector((0.106, -0.068)), Vector((0, 0.117))]
    result = []
    for i, point in enumerate(corners):
        before = point.lerp(corners[(i - 1) % 3], 0.38)
        after = point.lerp(corners[(i + 1) % 3], 0.38)
        for step in range(16):
            t = step / 16
            p = (1 - t) ** 2 * before + 2 * t * (1 - t) * point + t * t * after
            result.append((p.x * scale, p.y * scale))
    return result


def contour_mesh(name, rings, surface, parent, closed=True):
    vertices = []
    for scale, z in rings:
        vertices.extend((x, y, z) for x, y in container_contour(scale))
    count = len(container_contour())
    faces = []
    if closed:
        faces.append(tuple(reversed(range(count))))
    for ring in range(len(rings) - 1):
        for i in range(count):
            j = (i + 1) % count
            faces.append(
                (
                    ring * count + i,
                    ring * count + j,
                    (ring + 1) * count + j,
                    (ring + 1) * count + i,
                )
            )
    if closed:
        faces.append(tuple((len(rings) - 1) * count + i for i in range(count)))
    obj = mesh_object(name, vertices, faces, surface, parent)
    obj.modifiers.remove(obj.modifiers["Weighted surface normals"])
    return obj


def advance_blade(jar, mat):
    rotor = empty("tqo_blade", (0, 0, 0.058), jar)
    cylinder("Blade bearing housing", (0, 0, -0.013), 0.016, 0.024, mat["steel"], rotor)
    cylinder(
        "Blade retaining hex cap", (0, 0, 0.005), 0.0065, 0.009, mat["steel"], rotor
    )
    for index in range(2):
        angle = math.radians(15 + 180 * index)
        points = [
            (0.004, -0.010, 0),
            (0.029, -0.015, 0.001),
            (0.045, -0.010, 0.002),
            (0.050, 0.003, 0.014),
            (0.042, 0.011, 0.014),
            (0.038, 0.008, 0.002),
            (0.030, 0.010, 0.001),
            (0.023, 0.015, 0),
            (0.004, 0.010, 0),
        ]
        verts = []
        for layer in (0, 0.0012):
            verts.extend(
                (
                    0.76 * (x * math.cos(angle) - y * math.sin(angle)),
                    0.76 * (x * math.sin(angle) + y * math.cos(angle)),
                    z + layer,
                )
                for x, y, z in points
            )
        count = len(points)
        faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
        for i in range(count):
            j = (i + 1) % count
            faces.append((i, j, count + j, count + i))
        mesh_object("Advance two-arm blade", verts, faces, mat["steel"], rotor, 0.0003)
    return rotor


def container(root, mat):
    jar = empty("tqo_container", JAR_ORIGIN, root)
    jar["reference"] = (
        "48 oz / 1.4 L Advance, 15978 family; internal dimensions estimated"
    )
    contour_mesh(
        "Clear container seating skirt",
        [(0.71, 0.002), (0.72, 0.022), (0.70, 0.035)],
        mat["jar"],
        jar,
    )
    cylinder(
        "Under-container retaining nut", (0, 0, 0.013), 0.025, 0.018, mat["frame"], jar
    )
    cylinder("Container drive spline", (0, 0, 0.002), 0.006, 0.016, mat["steel"], jar)
    # Outer wall, lip and inner wall form one open vessel with a real floor.
    contour_mesh(
        "Hollow Advance container",
        [
            (0.63, 0.027),
            (0.70, 0.034),
            (0.75, 0.056),
            (0.94, 0.215),
            (1.00, 0.228),
            (1.00, 0.232),
            (0.965, 0.232),
            (0.91, 0.214),
            (0.715, 0.057),
            (0.665, 0.040),
            (0.60, 0.036),
            (0, 0.036),
        ],
        mat["jar"],
        jar,
    )
    tube(
        "Moulded container lip",
        [(x, y, 0.230) for x, y in container_contour(0.99)],
        0.0015,
        mat["jar"],
        jar,
        cyclic=True,
    )
    handle = frame(
        "Clear integral container handle",
        (0.080, -0.028, 0.155),
        (0.060, 0.137, 0.014),
        (0.033, 0.109, 0.010),
        0.016,
        mat["jar"],
        jar,
    )
    # Slight inset keeps the handle inside the sound cover.
    handle.location.x = -0.006
    for z in (0.089, 0.213):
        box(
            "Container handle root",
            (0.053, -0.028, z),
            (0.026, 0.023, 0.020),
            mat["jar"],
            jar,
            0.007,
        )
    for x in (-0.039, 0.039):
        tube(
            "Container interior rib",
            [(x * 0.7, -0.039, 0.041), (x, -0.053, 0.188), (x * 1.08, -0.059, 0.218)],
            0.002,
            mat["jar"],
            jar,
        )
    for i in range(21):
        z = 0.083 + i * 0.0062
        scale = 0.75 + (z - 0.056) * (0.19 / 0.159)
        y = -0.068 * scale - 0.0004
        width = 0.024 if i % 4 == 0 else 0.017
        tube("Ounce graduation", [(0, y, z), (width, y, z)], 0.00022, mat["ink"], jar)
        if i % 4 == 0:
            text(
                "Ounce number",
                str(8 + i * 2),
                (-0.008, y, z),
                0.0035,
                mat["ink"],
                jar,
                True,
            )
    text(
        "Ounces label", "OUNCES", (0.009, -0.0648, 0.216), 0.0035, mat["ink"], jar, True
    )
    text(
        "Capacity label",
        "MAXIMUM CAPACITY",
        (0.009, -0.0640, 0.210),
        0.0021,
        mat["ink"],
        jar,
        True,
    )
    rotor = advance_blade(jar, mat)
    lid = empty("tqo_container_lid", (0, 0, 0.232), jar)
    lidmesh = contour_mesh(
        "Removable two-piece lid",
        [(1.02, -0.001), (1.02, 0.005), (0.87, 0.009), (0.76, 0.023), (0.71, 0.024)],
        mat["rubber"],
        lid,
    )
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64, radius=0.020, depth=0.10, location=(0, 0, 0.02)
    )
    cutter = bpy.context.object
    # Lid geometry is local to its parent; bake the cut in that local frame.
    lid.parent = None
    lid.location = (0, 0, 0)
    boolean_cut(lidmesh, cutter)
    lid.parent = jar
    lid.location = (0, 0, 0.232)
    for x in (-0.042, 0.042):
        box(
            "Flexible lid latch tab",
            (x, -0.057, -0.006),
            (0.018, 0.012, 0.022),
            mat["rubber"],
            lid,
            0.003,
        )
        tube(
            "Lid release ridge",
            [(x, -0.052, 0.006), (x, -0.044, 0.017)],
            0.0025,
            mat["rubber"],
            lid,
        )
    plug = empty("tqo_lid_plug", (0, 0, 0.020), lid)
    lathe(
        "Clear removable lid plug",
        [
            (0, 0),
            (0.018, 0),
            (0.019, 0.004),
            (0.022, 0.005),
            (0.022, 0.0147),
            (0, 0.0147),
        ],
        (0, 0, 0),
        mat["jar"],
        plug,
        96,
    )
    for index in range(24):
        angle = index * math.tau / 24
        box(
            "Plug grip flute",
            (0.021 * math.cos(angle), 0.021 * math.sin(angle), 0.010),
            (0.0014, 0.0014, 0.009),
            mat["jar"],
            plug,
            0.0004,
        )
    empty("tqo_container_contents", (0, 0, 0.13), jar)
    return jar, lid, plug, rotor


def cable(root, mat):
    lead = empty("tqo_power_lead", (0, 0, 0), root)
    tube(
        "Stowed power cable",
        [
            (0.055, 0.12, 0.026),
            (0.07, 0.16, 0.008),
            (0.17, 0.16, 0.004),
            (0.22, 0.10, 0.004),
            (0.20, 0.045, 0.004),
            (0.15, 0.068, 0.004),
            (0.16, 0.145, 0.005),
            (0.23, 0.13, 0.005),
            (0.245, 0.015, 0.009),
        ],
        0.0033,
        mat["frame"],
        lead,
        smooth=True,
    )
    plug = empty("tqo_nema_5_15p", (0.245, -0.005, 0.013), lead)
    box("US plug housing", (0, 0, 0), (0.028, 0.036, 0.020), mat["frame"], plug, 0.006)
    for x in (-0.0064, 0.0064):
        box(
            "Plug flat pin",
            (x, -0.027, 0.003),
            (0.0015, 0.018, 0.006),
            mat["steel"],
            plug,
            0.0004,
        )
    cylinder(
        "Plug ground pin", (0, -0.027, -0.004), 0.0024, 0.018, mat["steel"], plug, "Y"
    )
    lead["status"] = "Illustrative stowed cable route, unmeasured length"
    return lead


def clean_meshes():
    for obj in tuple(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0000001)
        bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        if obj.name.startswith("Clear enclosure side cheek"):
            for face in obj.data.polygons:
                face.use_smooth = False
        if obj.name in {"Hollow Advance container", "Clear removable lid plug"}:
            for face in obj.data.polygons:
                face.use_smooth = abs(face.normal.z) < 0.995


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


def organize(root):
    collection = bpy.data.collections.new("Vitamix Quiet One appliance")
    bpy.context.scene.collection.children.link(collection)
    for obj in (root, *root.children_recursive):
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - hidden")
    bpy.context.scene.collection.children.link(refs)
    for i, name in enumerate(
        (
            "manufacturer-01.jpg",
            "manufacturer-02.jpg",
            "manufacturer-04.jpg",
            "manufacturer-05.jpg",
            "dimensioned-sheet.png",
            "manual-assembly.png",
            "manual-container.png",
            "advance-blade.jpg",
        )
    ):
        image = bpy.data.images.load(str(REFERENCES / name))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.7
        obj.location = (i * 0.8, 1, 0.4)
        obj.rotation_euler.x = math.pi / 2
    refs.hide_render = True
    refs.hide_viewport = True


def append_vitamix_swirl_to_brand():
    """Append the 6-blade curved Vitamix swirl crest into the converted 'Vitamix brand' mesh."""
    brand = bpy.data.objects.get("Vitamix brand")
    if brand is None or brand.type != "MESH":
        return
    cx, cy = -0.0185, 0.0002
    stations = (
        (0.00115, 0.00, 0.00018),
        (0.00205, -0.34, 0.00038),
        (0.00300, -0.70, 0.00056),
        (0.00375, -1.02, 0.00038),
    )
    bm = bmesh.new()
    bm.from_mesh(brand.data)
    z0, z1 = -0.000015, 0.000025
    for k in range(6):
        base_ang = k * math.tau / 6.0 + 0.35
        pts_2d = []
        centers = [
            (cx + r * math.cos(base_ang + dth), cy + r * math.sin(base_ang + dth), w)
            for r, dth, w in stations
        ]
        left_chain = []
        right_chain = []
        for idx, (sx, sy, w) in enumerate(centers):
            if idx == 0:
                tx, ty = centers[1][0] - sx, centers[1][1] - sy
            elif idx == len(centers) - 1:
                tx, ty = sx - centers[idx - 1][0], sy - centers[idx - 1][1]
            else:
                tx = centers[idx + 1][0] - centers[idx - 1][0]
                ty = centers[idx + 1][1] - centers[idx - 1][1]
            tlen = max(math.hypot(tx, ty), 1e-8)
            nx, ny = -ty / tlen, tx / tlen
            left_chain.append((sx + nx * w, sy + ny * w))
            right_chain.append((sx - nx * w, sy - ny * w))
        pts_2d = right_chain + list(reversed(left_chain))
        lo = [bm.verts.new((px, py, z0)) for px, py in pts_2d]
        hi = [bm.verts.new((px, py, z1)) for px, py in pts_2d]
        m = len(stations)
        for seg in range(m - 1):
            a0, a1 = seg, seg + 1
            b1, b0 = 2 * m - 1 - (seg + 1), 2 * m - 1 - seg
            bm.faces.new((lo[a0], lo[b0], lo[b1], lo[a1]))
            bm.faces.new((hi[a0], hi[a1], hi[b1], hi[b0]))
        n = len(pts_2d)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(brand.data)
    bm.free()
    brand.data.update()


def apply_surface_uvs(root, mat):
    """Project world-aligned brushed metal and planar LCD UVs at rest frame 1."""
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    for obj in root.children_recursive:
        if obj.type != "MESH" or not obj.data or not obj.data.materials:
            continue
        m0 = obj.data.materials[0]
        if m0 is None:
            continue
        if obj.name == "Brushed control fascia":
            project_stainless_uvs(obj, scale=5.0)
        elif obj.name == "Bowed silver enclosure handle" or obj.name.startswith(
            "Hinge bearing face"
        ):
            project_stainless_uvs(obj, scale=3.5)
        elif m0.name == mat["steel"].name:
            project_stainless_uvs(obj, scale=4.0)
    lcd_obj = bpy.data.objects["LCD window"]
    lcd_world_center = lcd_obj.matrix_world.translation
    project_front_planar_uvs(
        lcd_obj,
        lcd_world_center.x,
        lcd_world_center.z,
        LCD_WIDTH_M,
        LCD_HEIGHT_M,
        local_space=False,
    )


def rect_softbox(name, position, target, energy, size_x, size_y):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "RECTANGLE"
    data.size = size_x
    data.size_y = size_y
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj, target)
    return obj


def studio():
    scene = bpy.context.scene
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    metal_devs = [d for d in prefs.devices if d.type == "METAL"]
    for dev in prefs.devices:
        dev.use = (dev in metal_devs) if metal_devs else True
    scene.cycles.device = "GPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 20
    scene.cycles.transmission_bounces = 16
    scene.cycles.transparent_max_bounces = 16
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1500
    scene.render.resolution_percentage = 100
    world = setup_softbox_world(
        scene, "TQO neutral studio", camera_bg_rgb=(0.68, 0.71, 0.75)
    )
    # Photographer dark-field flag directly behind front (-Y) camera prevents milky
    # specular veil on the flat clear enclosure front while keeping full rear/side softboxes.
    wnt = world.node_tree
    bg_refl = next(
        n
        for n in wnt.nodes
        if n.type == "BACKGROUND" and abs(n.inputs["Strength"].default_value - 0.92) < 1e-3
    )
    ramp_node = next(n for n in wnt.nodes if n.type == "VALTORGB")
    geo = wnt.nodes.new("ShaderNodeNewGeometry")
    sep_dir = wnt.nodes.new("ShaderNodeSeparateXYZ")
    wnt.links.new(geo.outputs["Position"], sep_dir.inputs["Vector"])
    flag_map = wnt.nodes.new("ShaderNodeMapRange")
    flag_map.clamp = True
    flag_map.inputs["From Min"].default_value = -0.92
    flag_map.inputs["From Max"].default_value = -0.32
    flag_map.inputs["To Min"].default_value = 0.16
    flag_map.inputs["To Max"].default_value = 1.0
    wnt.links.new(sep_dir.outputs["Y"], flag_map.inputs["Value"])
    mul = wnt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    wnt.links.new(ramp_node.outputs["Color"], mul.inputs["A"])
    wnt.links.new(flag_map.outputs["Result"], mul.inputs["B"])
    wnt.links.new(mul.outputs["Result"], bg_refl.inputs["Color"])

    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("TQO floor", (0.44, 0.46, 0.49, 1.0), roughness=0.86)
    )
    rect_softbox("Left softbox", (-0.95, -0.80, 0.74), (0, -0.04, 0.23), 105, 0.52, 1.10)
    rect_softbox("Right strip", (0.95, -0.60, 0.68), (0, -0.04, 0.24), 85, 0.42, 1.05)
    rect_softbox("Rear softbox", (-0.10, 1.15, 1.05), (0, 0, 0.28), 120, 0.95, 0.70)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera
    collection = bpy.data.collections.new("Studio - excluded from export")
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


def render_views(camera, hood, jar, lid, plug, lead):
    render(camera, "studio-closed", (0.65, -1.05, 0.66), (0.025, 0, 0.225), 0.64)
    hood.rotation_euler.x = OPEN_ANGLE
    render(camera, "studio-open", (0.68, -1.12, 0.83), (0.02, 0.03, 0.30), 0.78)
    jar.location = (-0.255, -0.02, 0.012)
    lid.location.z += 0.09
    plug.location.z += 0.045
    render(camera, "studio-disassembled", (0.7, -1.3, 0.86), (-0.07, 0.025, 0.29), 0.83)
    jar.location = JAR_ORIGIN
    lid.location.z = 0.232
    plug.location.z = 0.020
    hood.rotation_euler.x = 0
    for obj in lead.children_recursive:
        obj.hide_render = True
    render(camera, "studio-front", (0, -2, 0.228), (0, 0, 0.228), 0.52)
    render(camera, "studio-right", (2, 0, 0.228), (0, 0, 0.228), 0.52)
    render(camera, "studio-controls", (0.10, -0.70, 0.23), (0, -0.11, 0.115), 0.235)
    for obj in lead.children_recursive:
        obj.hide_render = False


def animate(hood, jar, lid, plug, rotor, buttons):
    for frame_id, angle, lift, forward, lid_lift in (
        (1, 0, 0, 0, 0),
        (35, OPEN_ANGLE, 0, 0, 0),
        (50, OPEN_ANGLE, 0.045, 0, 0),
        (80, OPEN_ANGLE, 0.045, -0.26, 0),
        (105, OPEN_ANGLE, 0.045, -0.26, 0.075),
        (125, OPEN_ANGLE, 0.045, -0.26, 0),
        (150, OPEN_ANGLE, 0.045, 0, 0),
        (165, OPEN_ANGLE, 0, 0, 0),
        (195, 0, 0, 0, 0),
    ):
        hood.rotation_euler.x = angle
        jar.location = (JAR_ORIGIN[0], JAR_ORIGIN[1] + forward, JAR_ORIGIN[2] + lift)
        lid.location.z = 0.232 + lid_lift
        hood.keyframe_insert(data_path="rotation_euler", frame=frame_id)
        jar.keyframe_insert(data_path="location", frame=frame_id)
        lid.keyframe_insert(data_path="location", frame=frame_id)
    for frame_id, angle, press in (
        (1, 0, 0),
        (195, 0, 0),
        (200, 0, -0.0005),
        (206, 0, 0),
        (240, math.tau, 0),
    ):
        rotor.rotation_euler.z = angle
        buttons[5].location.z = 0.003 + press
        rotor.keyframe_insert(data_path="rotation_euler", frame=frame_id)
        buttons[5].keyframe_insert(data_path="location", frame=frame_id)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 240
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
    scene.name = "Vitamix Quiet One 36019 - twist-lock visual prototype"
    scene.unit_settings.system = "METRIC"
    root = empty("tqo_blender", (0, 0, 0))
    root["model"] = "US 36019 / VM0145, 120 V, 50-60 Hz, 15 A"
    root["status"] = (
        "Uncalibrated visual prototype; twist-lock frame and 48 oz Advance container"
    )
    mat = palette()
    motor_base(root, mat)
    buttons = control_panel(root, mat)
    _fixed, hood = enclosure(root, mat)
    jar, lid, plug, rotor = container(root, mat)
    lead = cable(root, mat)
    clean_meshes()
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    append_vitamix_swirl_to_brand()
    apply_surface_uvs(root, mat)
    export(root, "vitamix-quiet-one.glb")
    jar.parent = None
    jar.location = (0, 0, 0)
    export(jar, "vitamix-advance-container.glb")
    jar.parent = root
    jar.location = JAR_ORIGIN
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    hood.rotation_euler.x = OPEN_ANGLE
    bpy.context.view_layer.update()
    _, open_high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    hood.rotation_euler.x = 0
    report = {
        "status": "Visual prototype",
        "nominal_closed_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_closed_envelope_m": list(high - low),
        "authored_open_height_m": open_high.z,
        "nominal_open_height_m": 0.6223,
        "preview_open_degrees": 105,
        "assumptions": [
            "Hinge positions, curved profiles, clear wall thickness and container mating geometry inferred from images",
            "Container outline and graduation spacing are visual estimates, not volume calibration",
            "Brand typeface approximate; cable route illustrative; no acoustic or fluid simulation",
        ],
        "glb_sha256": hashlib.sha256(
            (ASSETS / "vitamix-quiet-one.glb").read_bytes()
        ).hexdigest(),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    organize(root)
    camera = studio()
    if not args.skip_renders:
        render_views(camera, hood, jar, lid, plug, lead)
    animate(hood, jar, lid, plug, rotor, buttons)
    camera.location = (0.65, -1.05, 0.66)
    camera.data.ortho_scale = 0.64
    look_at(camera, (0.025, 0, 0.225))
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
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "vitamix-quiet-one.blend"))
    for temp_name in (
        "tqo-stainless-hl.png",
        "tqo-stainless-orm.png",
        "tqo-lcd-decal.png",
    ):
        temp_path = ASSETS / temp_name
        if temp_path.exists():
            temp_path.unlink()
    print("Saved Vitamix Quiet One", ASSETS)


if __name__ == "__main__":
    main()
