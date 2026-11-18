"""Author the Japanese Linea Classic S AV, two groups, in metres and Z-up.

Approval drawing revised 2022.9 owns envelope and leg spacing. Photographs
and parts diagrams guide undimensioned surfaces. No calibrated physics.
"""

import argparse
import hashlib
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import (
    area_light,
    box,
    cylinder,
    convert_curves,
    empty,
    finish,
    look_at,
    material,
    tube,
)
from build_mixer_visuals import lathe, mesh_object

ROOT = Path(__file__).resolve().parents[2]
NAME = "la-marzocco-linea-classic-s-2g"
ASSETS = ROOT / "assets/bakery-mujoco" / NAME
REFERENCES = ROOT / "docs/equipment" / NAME / "images"


def palette():
    return {
        "steel": material("Linea brushed stainless", (0.56, 0.59, 0.62, 1), 0.84, 0.30),
        "chrome": material(
            "Linea polished stainless", (0.72, 0.75, 0.78, 1), 0.94, 0.16
        ),
        "black": material("Linea black polymer", (0.012, 0.015, 0.018, 1), 0.03, 0.31),
        "rubber": material("Linea insulated grip", (0.018, 0.022, 0.025, 1), 0, 0.48),
        "dark": material("Linea recessed metal", (0.045, 0.05, 0.055, 1), 0.7, 0.34),
        "white": material("Linea dial and symbols", (0.9, 0.91, 0.89, 1), 0, 0.4),
        "red": material("Linea red identity", (0.65, 0.018, 0.027, 1), 0.08, 0.32),
        "lcd": material("Linea dark amber timer", (0.12, 0.06, 0.018, 1), 0, 0.48),
    }


def text(name, value, position, size, mat, parent, rear=False):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = value
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = 0.00002
    curve.resolution_u = 3
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (math.pi / 2, 0, math.pi if rear else 0)
    return finish(obj, name, mat, parent)


def brand(name, position, width, mat, parent, rear=False):
    """Use the photographed wordmark outline, retaining its connected lettering."""
    document = ET.parse(REFERENCES / "wordmark-traced.svg").getroot()
    _, _, image_width, image_height = map(float, document.attrib["viewBox"].split())
    path = document.find("{http://www.w3.org/2000/svg}path").attrib["d"]
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "2D"
    curve.fill_mode = "BOTH"
    curve.extrude = 0.00003
    scale = width / image_width
    for contour in path.split("M")[1:]:
        coordinates = list(map(float, re.findall(r"-?\d+(?:\.\d+)?", contour)))
        spline = curve.splines.new("POLY")
        spline.points.add(len(coordinates) // 2 - 1)
        for index, point in enumerate(spline.points):
            point.co = (
                (coordinates[index * 2] - image_width / 2) * scale,
                (image_height / 2 - coordinates[index * 2 + 1]) * scale,
                0,
                1,
            )
        spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (math.pi / 2, 0, math.pi if rear else 0)
    return finish(obj, name, mat, parent)


def yz_panel(name, outline, x, thickness, mat, parent):
    vertices = [
        (x + offset, y, z)
        for offset in (-thickness / 2, thickness / 2)
        for y, z in outline
    ]
    count = len(outline)
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    faces.extend(
        (i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)
    )
    return mesh_object(name, vertices, faces, mat, parent, 0.0007)


def screw(name, x, y, z, mat, parent, top=False):
    cylinder(name, (x, y, z), 0.003, 0.001, mat["chrome"], parent, "Z" if top else "Y")
    box(
        name + " slot",
        (x, y if top else y - 0.0006, z + 0.0006 if top else z),
        (0.0034, 0.0007 if top else 0.0002, 0.0002 if top else 0.0007),
        mat["dark"],
        parent,
        0.0001,
    )


def cabinet(root, m):
    box(
        "Black lower chassis",
        (0, 0.012, 0.143),
        (0.657, 0.492, 0.088),
        m["black"],
        root,
        0.006,
    )
    # Rearward-sloping lower panels and the raised cup-warmer side cheeks.
    for side in (-1, 1):
        yz_panel(
            "Lower side service panel",
            [(-0.092, 0.188), (0.235, 0.188), (0.270, 0.357), (-0.092, 0.357)],
            side * 0.318,
            0.002,
            m["steel"],
            root,
        )
        yz_panel(
            "Upper side wrap",
            [(-0.100, 0.342), (0.269, 0.363), (0.2925, 0.522), (-0.100, 0.522)],
            side * 0.3455,
            0.002,
            m["steel"],
            root,
        )
        box(
            "Top side rail",
            (side * 0.335, 0.094, 0.5205),
            (0.022, 0.397, 0.003),
            m["chrome"],
            root,
            0.0007,
        )
        for y in (-0.075, 0.07, 0.245):
            screw("Cup rail screw", side * 0.335, y, 0.522, m, root, True)
        for z in (0.355, 0.508):
            screw("Front corner screw", side * 0.337, -0.1008, z, m, root)
    rear = empty("lcs_rear_panel", (0, 0.2815, 0.440), root)
    box(
        "Rear upper stainless skin",
        (0, 0, 0),
        (0.687, 0.002, 0.156),
        m["steel"],
        rear,
        0.001,
    )
    brand(
        "Rear brand",
        (-0.105, 0.0015, 0.012),
        0.235,
        m["red"],
        rear,
        True,
    )
    yz_panel(
        "Rear lower folded panel",
        [(0.235, 0.189), (0.237, 0.189), (0.271, 0.360), (0.269, 0.360)],
        0,
        0.634,
        m["steel"],
        root,
    )
    box(
        "Reflective splash panel",
        (0, -0.084, 0.273),
        (0.626, 0.002, 0.173),
        m["chrome"],
        root,
        0.001,
    )
    box(
        "Front control housing",
        (0, -0.167, 0.430),
        (0.638, 0.134, 0.114),
        m["steel"],
        root,
        0.002,
    )
    box(
        "Front fascia skin",
        (0, -0.235, 0.430),
        (0.637, 0.002, 0.112),
        m["steel"],
        root,
        0.001,
    )
    box(
        "Front shoulder top",
        (0, -0.166, 0.488),
        (0.638, 0.136, 0.002),
        m["steel"],
        root,
        0.0006,
    )
    for side in (-1, 1):
        for y in (-0.1535, 0.2055):
            leg = empty(
                "lcs_foot_"
                + ("left" if side < 0 else "right")
                + ("_front" if y < 0 else "_rear"),
                (side * 0.269, y, 0),
                root,
            )
            lathe(
                "Tapered adjustable foot",
                [
                    (0, 0),
                    (0.024, 0),
                    (0.025, 0.003),
                    (0.018, 0.009),
                    (0.013, 0.012),
                    (0.013, 0.031),
                    (0.019, 0.033),
                    (0.027, 0.099),
                    (0, 0.099),
                ],
                (0, 0, 0),
                m["chrome"],
                leg,
                48,
            )
            cylinder(
                "Foot adjustment collar", (0, 0, 0.026), 0.014, 0.006, m["steel"], leg
            )
    # Connection markers from the approval drawing; hose routes remain unspecified.
    for name, pos in [
        ("water", (0.2675, -0.1425, 0.10)),
        ("drain", (-0.047, -0.1425, 0.10)),
        ("power", (-0.1875, 0.0, 0.10)),
    ]:
        connector = empty("lcs_" + name + "_connection", pos, root)
        cylinder(
            name + " connection collar", (0, 0, 0), 0.009, 0.012, m["chrome"], connector
        )
    return rear


def tray(root, m):
    part = empty("lcs_drip_tray", (0, -0.172, 0.145), root)
    box(
        "Drip basin floor",
        (0, 0, -0.036),
        (0.654, 0.184, 0.002),
        m["steel"],
        part,
        0.0007,
    )
    box(
        "Tray front fascia",
        (0, -0.092, 0),
        (0.660, 0.002, 0.082),
        m["steel"],
        part,
        0.001,
    )
    for side in (-1, 1):
        box(
            "Tray side wall",
            (side * 0.328, 0, 0),
            (0.002, 0.184, 0.080),
            m["steel"],
            part,
            0.0007,
        )
    box(
        "Tray rear wall", (0, 0.092, 0), (0.656, 0.002, 0.080), m["steel"], part, 0.0007
    )
    brand("Front brand", (-0.18, -0.0935, 0.004), 0.120, m["red"], part)
    grate = empty("lcs_drip_grate", (0, 0, 0.043), part)
    for y in (-0.087, 0.087):
        tube(
            "Grate end rail", [(-0.322, y, 0), (0.322, y, 0)], 0.002, m["chrome"], grate
        )
    for i in range(81):
        x = -0.32 + i * 0.008
        tube(
            "Cup support wire",
            [(x, -0.087, 0), (x, 0.087, 0)],
            0.00095,
            m["chrome"],
            grate,
        )
    for y in (-0.056, 0, 0.056):
        tube(
            "Grate cross brace",
            [(-0.32, y, -0.0018), (0.32, y, -0.0018)],
            0.001,
            m["chrome"],
            grate,
        )
    return part, grate


def cup_tray(root, m):
    box(
        "Cup tray front upstand",
        (0, -0.099, 0.500),
        (0.645, 0.002, 0.023),
        m["steel"],
        root,
        0.0006,
    )
    box(
        "Cup tray rear rail",
        (0, 0.285, 0.5205),
        (0.648, 0.015, 0.003),
        m["chrome"],
        root,
        0.0006,
    )
    lid = empty("lcs_cup_tray", (0, 0.095, 0.509), root)
    # Build actual openings from strips, rather than painted dark slots.
    for y in (-0.181, 0.181):
        box(
            "Cup tray end strip",
            (0, y, 0),
            (0.645, 0.009, 0.002),
            m["steel"],
            lid,
            0.0004,
        )
    for i in range(9):
        box(
            "Cup tray column",
            (-0.32 + i * 0.08, 0, 0),
            (0.009, 0.365, 0.002),
            m["steel"],
            lid,
            0.0004,
        )
    for i in range(37):
        box(
            "Cup tray slot bridge",
            (0, -0.175 + i * 0.00972, 0),
            (0.636, 0.003, 0.002),
            m["steel"],
            lid,
            0.0004,
        )
    for x in (-0.32, 0, 0.32):
        for y in (-0.18, 0.18):
            screw("Cup tray screw", x, y, 0.0015, m, lid, True)
    return lid


def dial(root, m):
    cylinder(
        "Pressure gauge bezel", (0, -0.239, 0.430), 0.027, 0.009, m["chrome"], root, "Y"
    )
    cylinder(
        "Pressure gauge dial", (0, -0.244, 0.430), 0.023, 0.001, m["white"], root, "Y"
    )
    for index in range(41):
        angle = math.radians(-140 + index * 7)
        r = 0.020
        x = r * math.sin(angle)
        z = r * math.cos(angle)
        tick = box(
            "Pressure tick",
            (x, -0.245, 0.430 + z),
            (0.0004, 0.0002, 0.002 if index % 5 == 0 else 0.001),
            m["black"],
            root,
            0.00005,
        )
        tick.rotation_euler.y = angle
    for value, angle in [(0, -135), (3, -65), (6, 0), (9, 65), (12, 135)]:
        a = math.radians(angle)
        text(
            "Dial number",
            str(value),
            (0.015 * math.sin(a), -0.2454, 0.430 + 0.015 * math.cos(a)),
            0.0038,
            m["black"],
            root,
        )
    coffee_needle = empty("lcs_coffee_pressure_needle", (0, -0.246, 0.430), root)
    tube(
        "Gauge coffee needle",
        [(0, 0, 0), (-0.016, 0, 0.005)],
        0.00055,
        m["black"],
        coffee_needle,
    )
    steam_needle = empty("lcs_steam_pressure_needle", (0, -0.2465, 0.430), root)
    tube(
        "Gauge steam needle",
        [(0, 0, 0), (0.008, 0, -0.011)],
        0.00045,
        m["red"],
        steam_needle,
    )
    cylinder(
        "Gauge central pin", (0, -0.247, 0.430), 0.002, 0.002, m["chrome"], root, "Y"
    )
    text("Gauge legend", "bar", (0, -0.2455, 0.436), 0.003, m["black"], root)


def cup_icon(parent, m, double=False):
    for offset in (-0.003, 0.003) if double else (0,):
        tube(
            "Cup symbol",
            [
                (offset - 0.0025, -0.0055, 0.002),
                (offset - 0.002, -0.0055, -0.002),
                (offset + 0.002, -0.0055, -0.002),
                (offset + 0.0025, -0.0055, 0.002),
            ],
            0.0003,
            m["white"],
            parent,
        )
        tube(
            "Cup saucer",
            [
                (offset - 0.003, -0.0055, -0.003),
                (offset + 0.003, -0.0055, -0.003),
            ],
            0.00025,
            m["white"],
            parent,
        )


def controls(root, m):
    dial(root, m)
    for center in (-0.12, 0.12):
        side = "left" if center < 0 else "right"
        for index in range(3):
            x = center + (index - 1) * 0.040
            button = empty(f"lcs_{side}_dose_{index + 1}", (x, -0.238, 0.430), root)
            box(
                "Rectangular button bezel",
                (0, 0, 0),
                (0.028, 0.003, 0.034),
                m["black"],
                button,
                0.001,
            )
            box(
                "Button silver inner rim",
                (0, -0.002, 0),
                (0.023, 0.001, 0.029),
                m["chrome"],
                button,
                0.0006,
            )
            box(
                "Dose button cap",
                (0, -0.003, 0),
                (0.020, 0.002, 0.026),
                m["dark"],
                button,
                0.0007,
            )
            if index < 2:
                cup_icon(button, m, index == 1)
            else:
                text(
                    "Continuous dose symbol",
                    "O",
                    (0, -0.005, 0),
                    0.009,
                    m["white"],
                    button,
                )
        box(
            "Timer black bezel",
            (center, -0.237, 0.470),
            (0.034, 0.002, 0.020),
            m["black"],
            root,
            0.001,
        )
        text(
            "Inactive shot timer",
            "8.8.8",
            (center, -0.2385, 0.470),
            0.010,
            m["lcd"],
            root,
        )
    for x in (-0.215, 0.215):
        button = empty(
            "lcs_hot_water_button" if x > 0 else "lcs_left_aux_button",
            (x, -0.238, 0.43),
            root,
        )
        box(
            "Auxiliary rocker",
            (0, 0, 0),
            (0.027, 0.004, 0.033),
            m["black"],
            button,
            0.001,
        )
        text("Auxiliary symbol", "~", (0, -0.0025, 0), 0.014, m["red"], button)
    box(
        "Main switch mounting plate",
        (-0.275, -0.086, 0.300),
        (0.043, 0.003, 0.049),
        m["black"],
        root,
        0.003,
    )
    switch = empty("lcs_power_switch", (-0.275, -0.09, 0.300), root)
    cylinder("Power selector", (0, 0, 0), 0.013, 0.009, m["black"], switch, "Y")
    box(
        "Power selector lever",
        (0, -0.006, 0),
        (0.006, 0.010, 0.022),
        m["black"],
        switch,
        0.002,
    )
    text("Power off mark", "0", (-0.275, -0.093, 0.318), 0.006, m["white"], root)
    text("Power on mark", "1", (-0.259, -0.093, 0.305), 0.006, m["white"], root)


def steam(root, m, side):
    label = "left" if side < 0 else "right"
    valve = empty("lcs_" + label + "_steam_valve", (side * 0.282, -0.240, 0.430), root)
    cylinder(
        "Steam valve chrome mount", (0, 0, 0), 0.026, 0.009, m["chrome"], valve, "Y"
    )
    knob = empty("lcs_" + label + "_steam_knob", (0, -0.027, 0), valve)
    vertices = []
    for y, r in [(0.018, 0.022), (0.012, 0.026), (-0.015, 0.025), (-0.0245, 0.020)]:
        for i in range(72):
            a = math.tau * i / 72
            radius = r * (1 + 0.10 * math.cos(6 * a))
            vertices.append((radius * math.cos(a), y, radius * math.sin(a)))
    faces = [tuple(reversed(range(72))), tuple(range(216, 288))]
    faces.extend(
        (
            j * 72 + i,
            j * 72 + (i + 1) % 72,
            (j + 1) * 72 + (i + 1) % 72,
            (j + 1) * 72 + i,
        )
        for j in range(3)
        for i in range(72)
    )
    mesh_object("Six-lobe steam knob", vertices, faces, m["black"], knob, 0.0007)
    cylinder("Steam knob center", (0, -0.025, 0), 0.012, 0.001, m["chrome"], knob, "Y")
    cylinder("Steam knob inset", (0, -0.0257, 0), 0.0105, 0.0003, m["dark"], knob, "Y")
    text("Steam knob maker", "MARZOCCO", (0, -0.026, 0.005), 0.0024, m["white"], knob)
    for sign in (-1, 1):
        points = []
        for index in range(17):
            angle = math.radians(index * 8 + 20 + (180 if sign < 0 else 0))
            points.append(
                (0.0055 * math.cos(angle), -0.026, 0.0055 * math.sin(angle) - 0.001)
            )
        tube("Steam direction arc", points, 0.00035, m["white"], knob)
    pivot = empty("lcs_" + label + "_steam_wand", (side * 0.282, -0.186, 0.365), root)
    cylinder("Steam wand swivel", (0, 0, 0), 0.010, 0.020, m["chrome"], pivot)
    path = [
        (0, 0, 0),
        (side * 0.006, -0.008, -0.027),
        (side * 0.027, -0.037, -0.049),
        (side * 0.039, -0.049, -0.063),
        (side * 0.041, -0.053, -0.144),
    ]
    tube("Bent stainless steam wand", path, 0.0042, m["chrome"], pivot, smooth=True)
    tube(
        "Steam wand insulated grip",
        [(side * 0.028, -0.039, -0.052), (side * 0.038, -0.047, -0.067)],
        0.007,
        m["rubber"],
        pivot,
        smooth=True,
    )
    for i in range(7):
        start = Vector((side * 0.028, -0.039, -0.052))
        end = Vector((side * 0.038, -0.047, -0.067))
        rib = cylinder(
            "Steam grip rib",
            start.lerp(end, (i + 0.5) / 7),
            0.0072,
            0.0007,
            m["rubber"],
            pivot,
        )
        rib.rotation_euler = (end - start).to_track_quat("Z", "Y").to_euler()
    lathe(
        "Steam nozzle",
        [(0.004, -0.148), (0.005, -0.145), (0.005, -0.138), (0.004, -0.135)],
        (side * 0.041, -0.053, 0),
        m["chrome"],
        pivot,
        32,
    )
    return knob, pivot


def group(root, m, x, label):
    unit = empty("lcs_" + label + "_group", (x, -0.177, 0.357), root)
    lathe(
        "Saturated brew group",
        [
            (0, 0),
            (0.037, 0),
            (0.045, -0.005),
            (0.048, -0.015),
            (0.047, -0.022),
            (0.041, -0.025),
            (0.040, -0.033),
            (0.032, -0.036),
            (0, -0.036),
        ],
        (0, 0, 0),
        m["chrome"],
        unit,
        64,
    )
    cylinder("Group gasket", (0, 0, -0.036), 0.029, 0.002, m["black"], unit)
    cylinder("Shower screen", (0, 0, -0.037), 0.027, 0.0008, m["steel"], unit)
    pf = empty("lcs_" + label + "_portafilter", (x, -0.177, 0.318), root)
    # Hollow cup with a separately removable basket. Bayonet geometry estimated.
    lathe(
        "Portafilter hollow body",
        [
            (0, -0.020),
            (0.025, -0.020),
            (0.033, -0.011),
            (0.035, 0),
            (0.035, 0.009),
            (0.030, 0.009),
            (0.030, -0.008),
            (0.025, -0.016),
            (0, -0.016),
        ],
        (0, 0, 0),
        m["chrome"],
        pf,
        64,
    )
    for side in (-1, 1):
        box(
            "Portafilter locking lug",
            (side * 0.036, 0, 0.004),
            (0.011, 0.011, 0.005),
            m["chrome"],
            pf,
            0.001,
        )
    basket = empty("lcs_" + label + "_basket", (0, 0, 0.0095), pf)
    lathe(
        "Filter basket",
        [
            (0.031, 0),
            (0.0315, 0.001),
            (0.032, 0.0015),
            (0.032, 0.002),
            (0.0285, 0.002),
            (0.0285, -0.016),
            (0.023, -0.021),
            (0, -0.021),
            (0, -0.022),
            (0.024, -0.022),
            (0.030, -0.017),
            (0.031, 0),
        ],
        (0, 0, 0),
        m["steel"],
        basket,
        64,
    )
    tube(
        "Portafilter handle shank",
        [(0, -0.03, -0.004), (0, -0.055, -0.008)],
        0.008,
        m["chrome"],
        pf,
    )
    grip = lathe(
        "Portafilter moulded handle",
        [
            (0, 0),
            (0.010, 0),
            (0.012, 0.012),
            (0.012, 0.03),
            (0.014, 0.06),
            (0.0135, 0.085),
            (0.010, 0.102),
            (0, 0.108),
        ],
        (0, 0, 0),
        m["rubber"],
        pf,
        48,
    )
    grip.location = (0, -0.05, -0.008)
    grip.rotation_euler.x = math.radians(96)
    for side in (-1, 1):
        tube(
            "Double spout branch",
            [
                (0, 0, -0.02),
                (side * 0.014, -0.008, -0.032),
                (side * 0.018, -0.010, -0.040),
            ],
            0.005,
            m["chrome"],
            pf,
            smooth=True,
        )
        cylinder(
            "Open spout exit",
            (side * 0.018, -0.010, -0.041),
            0.0034,
            0.0004,
            m["dark"],
            pf,
        )
    return pf, basket


def references():
    collection = bpy.data.collections.new("Reference images — hidden")
    bpy.context.scene.collection.children.link(collection)
    for index, filename in enumerate(
        [
            "japan-dimensioned.png",
            "manufacturer-front.png",
            "manufacturer-dx.png",
            "manufacturer-back.png",
            "manufacturer-front_3-4.png",
        ]
    ):
        image = bpy.data.images.load(str(REFERENCES / filename))
        image.pack()
        obj = bpy.data.objects.new("Reference " + filename, None)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.location = (2 + index, 0, 0)
        collection.objects.link(obj)
    collection.hide_render = True
    collection.hide_viewport = True


def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1300
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.35
    scene.world = bpy.data.worlds.new("Linea studio")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.65,
        0.68,
        0.72,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(
        material("Studio grey", (0.27, 0.29, 0.31, 1), 0, 0.8)
    )
    area_light("Key softbox", (-1, -1.3, 1.7), (0, 0, 0.25), 300, 1.2)
    area_light("Right strip", (1.2, -0.2, 1.1), (0, 0, 0.3), 200, 0.8)
    area_light("Rear softbox", (0.0, 1.2, 1.4), (0, 0, 0.3), 320, 1)
    camera = bpy.data.objects.new(
        "Review camera", bpy.data.cameras.new("Review camera")
    )
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera
    return camera


def render(camera, name, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)
    bpy.context.scene.render.filepath = str(ASSETS / (name + ".png"))
    bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    root = empty("lcs_machine", (0, 0, 0))
    root["identity"] = "Linea Classic S AV 2 groups, Japanese reference 851514"
    root["reference_envelope_m"] = [0.693, 0.585, 0.522]
    m = palette()
    cabinet(root, m)
    drip, grate = tray(root, m)
    lid = cup_tray(root, m)
    controls(root, m)
    left_knob, left_wand = steam(root, m, -1)
    right_knob, right_wand = steam(root, m, 1)
    left_pf, left_basket = group(root, m, -0.12, "left")
    right_pf, right_basket = group(root, m, 0.12, "right")
    cylinder(
        "Hot water outlet neck", (0.215, -0.180, 0.354), 0.007, 0.035, m["chrome"], root
    )
    lathe(
        "Hot water nozzle",
        [(0.007, -0.030), (0.010, -0.025), (0.010, -0.006), (0.007, 0)],
        (0.215, -0.180, 0.338),
        m["chrome"],
        root,
        40,
    )
    # Resolve authored normals before evaluating bevels and exported curves.
    for obj in list(scene.objects):
        if obj.type == "MESH":
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            if obj.name.startswith(
                (
                    "Tapered adjustable foot",
                    "Saturated brew group",
                    "Portafilter hollow body",
                    "Filter basket",
                    "Steam nozzle",
                    "Hot water nozzle",
                )
            ):
                bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.0000001)
                bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
                for face in bm.faces:
                    face.smooth = abs(face.normal.z) < 0.99
                for edge in bm.edges:
                    if len(edge.link_faces) == 2:
                        edge.smooth = edge.calc_face_angle() < math.radians(35)
            bm.to_mesh(obj.data)
            bm.free()
    convert_curves(tuple(obj for obj in scene.objects if obj.type == "EMPTY"))
    # The traced wordmark contains collinear pixel-outline corners. Resolve
    # its planar caps before glTF triangulation creates collapsed triangles.
    for name in ("Front brand", "Rear brand"):
        obj = bpy.data.objects[name]
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.0000001)
        bmesh.ops.dissolve_degenerate(mesh, edges=list(mesh.edges), dist=0.0000001)
        bmesh.ops.triangulate(mesh, faces=list(mesh.faces))
        # The smallest intended pixel-scale cap is about 5e-8 m². Smaller
        # numerical slivers collapse when glTF stores float32 positions.
        collapsed = [face for face in mesh.faces if face.calc_area() < 1e-10]
        bmesh.ops.delete(mesh, geom=collapsed, context="FACES_ONLY")
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / (NAME + ".glb")),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_extras=True,
    )
    references()
    camera = studio()
    if not args.skip_renders:
        render(camera, "studio-closed", (1, -1.5, 0.95), (0, -0.025, 0.265), 1.05)
        render(camera, "studio-front", (0, -2, 0.27), (0, 0, 0.27), 0.87)
        render(camera, "studio-right", (2, 0, 0.27), (0, 0, 0.27), 0.82)
        render(camera, "studio-back", (-0.9, 1.4, 0.9), (0, 0.02, 0.27), 1.0)
        left_pf.location.x -= 0.10
        left_pf.location.y -= 0.22
        left_pf.location.z = 0.10
        left_pf.rotation_euler.z = math.radians(-35)
        left_basket.location.z += 0.08
        grate.location.z += 0.09
        lid.location.z += 0.14
        render(camera, "studio-service", (1, -1.5, 1.1), (0, -0.035, 0.32), 1.20)
        left_pf.location = (-0.12, -0.177, 0.318)
        left_pf.rotation_euler.z = 0
        left_basket.location.z = 0.0095
        grate.location.z = 0.043
        lid.location.z = 0.509
    for frame, value in [
        (1, 0),
        (36, math.radians(-35)),
        (72, math.radians(-35)),
        (108, 0),
    ]:
        left_pf.rotation_euler.z = value
        left_pf.keyframe_insert(data_path="rotation_euler", frame=frame)
    scene.frame_start = 1
    scene.frame_end = 108
    scene.frame_set(1)
    camera.location = (1, -1.5, 0.95)
    camera.data.ortho_scale = 1.05
    look_at(camera, (0, -0.025, 0.265))
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / (NAME + ".blend")))
    report = {
        "model": NAME,
        "units": "metres",
        "reference_envelope_m": [0.693, 0.585, 0.522],
        "glb_sha256": hashlib.sha256(
            (ASSETS / (NAME + ".glb")).read_bytes()
        ).hexdigest(),
        "assumptions": [
            "Undimensioned panel profiles, group centres, portafilter fit and wand swivel limits follow photographs",
            "Wordmark traced from the manufacturer rear photograph; small control symbols remain approximate",
            "No hidden boiler geometry, hydraulic simulation or calibrated physical properties",
        ],
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
