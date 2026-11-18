"""Build the Japanese Hoshizaki IM-35P undercounter commercial cube ice maker visual model.

Metres, Z up, operator front towards -Y.
Follows official Hoshizaki 1/10 scale engineering drawing D41369 (2025-02-20, IM-35P, R600a)
and predecessor drawing D27883 (2023-08-04, IM-35M-2) plus the manufacturer open-door photograph.
Published cabinet envelope: 500 x 450 x 800 mm (W x D x H), open-door depth 764 mm (+314 mm door swing),
unit mass 37 kg (IM-35M-2: 39 kg), ice production 36/38 kg/day (28 x 28 x 32 mm cubes, 30 cubes / 0.73 kg per cycle),
max bin storage 18 kg (10.5 kg natural fall).
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
)

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/hoshizaki-im-35p"
REFERENCES = ROOT / "docs/equipment/hoshizaki-im-35p"
NAME = "hoshizaki-im-35p"

WIDTH = 0.5000
DEPTH = 0.4500
HEIGHT = 0.8000

DOOR_PIVOT = (0.0, -0.2120, 0.3520)
DOOR_OPEN_RAD = math.radians(52.0)

FILTER_ORIGIN = (0.0950, -0.2175, 0.2680)
WATER_PLATE_PIVOT = (-0.0600, 0.1350, 0.6400)
BIN_SWITCH_PIVOT = (0.1350, 0.0100, 0.6550)
POWER_SWITCH_PIVOT = (-0.1150, -0.2175, 0.0950)
SCOOP_REST_POSE = (-0.0600, -0.1150, 0.5600)

FOOT_POSITIONS = (
    ("im_foot_front_left", -0.2200, -0.1390),
    ("im_foot_front_right", 0.2200, -0.1390),
    ("im_foot_rear_left", -0.2200, 0.1130),
    ("im_foot_rear_right", 0.2200, 0.1130),
)


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
        if len(f.verts) < 3:
            to_delete.append(f)
            continue
        w0 = obj.matrix_world @ f.verts[0].co
        w1 = obj.matrix_world @ f.verts[1].co
        w2 = obj.matrix_world @ f.verts[2].co
        if (w1 - w0).cross(w2 - w0).length <= 1e-12:
            to_delete.append(f)
            continue
        pts = [
            tuple(round((obj.matrix_world @ v.co)[i], 8) for i in range(3))
            for v in f.verts
        ]
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
    if recalc_normals and bm.faces:
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


def surfaces():
    return {
        "steel": material(
            "IM fluorine-precoated stainless exterior",
            (0.55, 0.58, 0.60, 1.0),
            0.84,
            0.29,
        ),
        "worktop": material(
            "IM brushed stainless worktop", (0.61, 0.64, 0.66, 1.0), 0.88, 0.24
        ),
        "galv": material(
            "IM rear galvanized steel", (0.46, 0.49, 0.51, 1.0), 0.72, 0.38
        ),
        "liner": material(
            "IM sanitary white polypropylene liner",
            (0.84, 0.87, 0.90, 1.0),
            0.04,
            0.28,
        ),
        "scoop_resin": material(
            "IM antibacterial white ice scoop resin",
            (0.90, 0.92, 0.95, 1.0),
            0.04,
            0.22,
        ),
        "handle_grey": material(
            "IM top door handle polymer", (0.31, 0.34, 0.36, 1.0), 0.12, 0.36
        ),
        "filter_grey": material(
            "IM Raku-Eco air filter frame", (0.25, 0.28, 0.30, 1.0), 0.08, 0.40
        ),
        "filter_mesh": material(
            "IM Raku-Eco nylon filter mesh", (0.14, 0.16, 0.18, 1.0), 0.05, 0.55
        ),
        "gasket": material(
            "IM antimicrobial door gasket", (0.22, 0.24, 0.25, 1.0), 0.0, 0.60
        ),
        "smoked_lens": material(
            "IM lower status window smoked acrylic",
            (0.025, 0.030, 0.036, 1.0),
            0.15,
            0.16,
        ),
        "recess_black": material(
            "IM louver recess black", (0.010, 0.012, 0.015, 1.0), 0.05, 0.52
        ),
        "copper_cell": material(
            "IM tin-plated copper evaporator cell",
            (0.68, 0.66, 0.62, 1.0),
            0.90,
            0.22,
        ),
        "brass": material(
            "IM rear water and drain brass fitting",
            (0.70, 0.55, 0.24, 1.0),
            0.86,
            0.26,
        ),
        "ice_crystal": material(
            "IM clear cube ice 28x28x32mm", (0.76, 0.88, 0.96, 1.0), 0.08, 0.12
        ),
        "badge_blue": material(
            "IM Hoshizaki penguin emblem blue",
            (0.015, 0.18, 0.44, 1.0),
            0.12,
            0.28,
        ),
        "badge_green": material(
            "IM natural refrigerant R600a green",
            (0.06, 0.48, 0.22, 1.0),
            0.10,
            0.30,
        ),
        "led_green": material(
            "IM active status LED green", (0.12, 0.82, 0.28, 1.0), emission=0.6
        ),
        "ink_white": material(
            "IM white badge lettering", (0.90, 0.92, 0.94, 1.0), 0.05, 0.30
        ),
        "ink_dark": material(
            "IM dark wordmark lettering", (0.08, 0.10, 0.12, 1.0), 0.10, 0.32
        ),
        "foot_resin": material(
            "IM heavy-duty elastomer foot", (0.035, 0.038, 0.042, 1.0), 0.04, 0.58
        ),
    }


def text_label(name, text, position, size, surface, parent, rot_x=math.pi / 2):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.extrude = 0.0
    data.resolution_u = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = rot_x
    return finish(obj, name, surface, parent)


def build_cabinet_and_bin(root, mat):
    # 1. Top stainless worktop: exact 500 x 450 mm (`X in [-0.250, +0.250]`, `Y in [-0.225, +0.225]`), top at Z = 0.8000 m
    worktop = box(
        "Stainless worktop",
        (0.0, 0.0, 0.7890),
        (0.5000, 0.4500, 0.0220),
        mat["worktop"],
        root,
        0.0,
    )
    clean_mesh_object(worktop, sharp_z=True)

    # Upper front stainless fascia panel (`Z = 0.7570 .. 0.7780 m`) above the bin door opening
    fascia = box(
        "Upper front stainless fascia",
        (0.0, -0.2140, 0.7675),
        (0.4996, 0.0160, 0.0210),
        mat["steel"],
        root,
        0.001,
    )
    clean_mesh_object(fascia, sharp_z=False)
    for sx, sname in ((-0.2360, "left"), (0.2360, "right")):
        scr = cylinder(
            f"Upper fascia screw {sname}",
            (sx, -0.2225, 0.7660),
            0.0032,
            0.0020,
            mat["worktop"],
            root,
            "Y",
        )
        clean_mesh_object(scr, sharp_z=False)

    # Left and right exterior stainless side walls (`X = ±0.2380 m`, outer planes at X = ±0.2500 m)
    # Note the lower-rear compressor cutout (`Y > +0.1765 m, Z < 0.2200 m`) per Drawing D41369 side view (`48.5 mm` step)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        wx = side_sign * 0.2380
        upper_wall = box(
            f"Exterior {side_name} upper wall",
            (wx, 0.0040, 0.4990),
            (0.0240, 0.4420, 0.5580),
            mat["steel"],
            root,
            0.001,
        )
        clean_mesh_object(upper_wall, sharp_z=False)
        lower_wall = box(
            f"Exterior {side_name} lower wall",
            (wx, -0.0200, 0.1185),
            (0.0240, 0.3930, 0.2030),
            mat["steel"],
            root,
            0.001,
        )
        clean_mesh_object(lower_wall, sharp_z=False)

        # Side cooling louver slots (`吸排気` / `排気`, 2 rows x 15 vertical slots)
        for row_idx, lz in enumerate((0.0950, 0.1650), 1):
            for slot_idx in range(15):
                ly = -0.1400 + slot_idx * 0.0170
                slot = box(
                    f"Side louver {side_name} r{row_idx}_{slot_idx:02d}",
                    (side_sign * 0.2492, ly, lz),
                    (0.0020, 0.0075, 0.0520),
                    mat["recess_black"],
                    root,
                    0.0003,
                )
                clean_mesh_object(slot, sharp_z=False)

    # Rear upper galvanized insulated wall (`Y = +0.2050 m`, outer face at Y = +0.2250 m, `Z = 0.2200 .. 0.7780 m`)
    rear_upper = box(
        "Rear upper insulated wall",
        (0.0, 0.2050, 0.4990),
        (0.4520, 0.0400, 0.5580),
        mat["galv"],
        root,
        0.001,
    )
    clean_mesh_object(rear_upper, sharp_z=False)

    # Rear top recessed hand pocket shown on Drawing D41369 rear view
    rear_grip = box(
        "Rear top transport grip recess",
        (0.0, 0.2230, 0.7680),
        (0.0540, 0.0025, 0.0120),
        mat["recess_black"],
        root,
        0.0005,
    )
    clean_mesh_object(rear_grip, sharp_z=False)

    # Rear lower stepped service panel (`Y = +0.1765 m`, `48.5 mm` inset from rear face, `Z = 0.0170 .. 0.2200 m`)
    rear_lower = box(
        "Rear lower compressor step panel",
        (0.0, 0.1645, 0.1185),
        (0.4520, 0.0240, 0.2030),
        mat["galv"],
        root,
        0.001,
    )
    clean_mesh_object(rear_lower, sharp_z=False)
    for row_idx, rz in enumerate((0.0820, 0.1520), 1):
        for slot_idx in range(18):
            rx = -0.2150 + slot_idx * 0.0160
            rslot = box(
                f"Rear exhaust louver r{row_idx}_{slot_idx:02d}",
                (rx, 0.1760, rz),
                (0.0075, 0.0020, 0.0520),
                mat["recess_black"],
                root,
                0.0003,
            )
            clean_mesh_object(rslot, sharp_z=False)

    # Bottom galvanized base pan (`Z = 0.0170 .. 0.0350 m`, `17 mm` ground clearance per Drawing D41369)
    base_pan = box(
        "Lower galvanized base frame",
        (0.0, -0.0200, 0.0260),
        (0.4960, 0.3930, 0.0180),
        mat["galv"],
        root,
        0.001,
    )
    clean_mesh_object(base_pan, sharp_z=False)

    # Four `17 mm` feet touching Z = 0.0000 m at `X = ±0.2200 m` (`440 mm`), `Y = -0.1390, +0.1130 m` (`252 mm`)
    for fname, fx, fy in FOOT_POSITIONS:
        foot = empty(fname, (fx, fy, 0.0), root)
        foot["contact_plane_z_m"] = 0.0
        collar = cylinder(
            f"{fname}_collar",
            (0.0, 0.0, 0.0115),
            0.0180,
            0.0110,
            mat["galv"],
            foot,
        )
        clean_mesh_object(collar, sharp_z=True)
        pad = cylinder(
            f"{fname}_pad",
            (0.0, 0.0, 0.0030),
            0.0145,
            0.0060,
            mat["foot_resin"],
            foot,
        )
        clean_mesh_object(pad, sharp_z=True)

    # Lower front fluorine-precoated stainless louver panel (`Z = 0.0170 .. 0.3220 m`, `305 mm` height)
    front_lower = box(
        "Lower front service louver panel",
        (0.0, -0.2075, 0.1695),
        (0.4996, 0.0200, 0.3050),
        mat["steel"],
        root,
        0.0015,
    )
    clean_mesh_object(front_lower, sharp_z=False)

    # Left front exhaust louver column (`排気`, 16 horizontal slots at X = -0.1920 m)
    for idx in range(16):
        lz = 0.0360 + idx * 0.0135
        lslot = box(
            f"Front left exhaust louver {idx:02d}",
            (-0.1920, -0.2172, lz),
            (0.0880, 0.0025, 0.0055),
            mat["recess_black"],
            root,
            0.0004,
        )
        clean_mesh_object(lslot, sharp_z=False)

    # Right front condenser intake louver grid (`吸気`, 2 columns x 16 horizontal slots at X = 0.0320, 0.1580 m)
    for col_idx, cx in enumerate((0.0320, 0.1580), 1):
        for idx in range(16):
            lz = 0.0360 + idx * 0.0135
            rslot = box(
                f"Front right intake louver c{col_idx}_{idx:02d}",
                (cx, -0.2172, lz),
                (0.1120, 0.0025, 0.0055),
                mat["recess_black"],
                root,
                0.0004,
            )
            clean_mesh_object(rslot, sharp_z=False)

    # 22 mm recessed horizontal hinge channel (`Z = 0.3220 .. 0.3440 m`) and left/right lower door hinge brackets
    hinge_channel = box(
        "Front 22mm door hinge recess",
        (0.0, -0.2040, 0.3330),
        (0.4980, 0.0240, 0.0220),
        mat["recess_black"],
        root,
        0.001,
    )
    clean_mesh_object(hinge_channel, sharp_z=False)
    for hx, hside in ((-0.1900, "left"), (0.1900, "right")):
        hbr = box(
            f"Lower door hinge bracket {hside}",
            (hx, -0.2120, 0.3380),
            (0.0480, 0.0160, 0.0120),
            mat["worktop"],
            root,
            0.001,
        )
        clean_mesh_object(hbr, sharp_z=False)

    # Interior food-grade white polypropylene ice storage bin liner (`樹脂成形品`, `X in [-0.210, +0.210]`, `Y in [-0.175, +0.185]`, `Z in [0.355, 0.755]`)
    bin_floor = box(
        "Sanitary bin floor liner",
        (0.0, 0.0050, 0.3480),
        (0.4260, 0.3680, 0.0240),
        mat["liner"],
        root,
        0.002,
    )
    clean_mesh_object(bin_floor, sharp_z=False)
    bin_ceiling = box(
        "Sanitary bin ceiling liner",
        (0.0, 0.0050, 0.7580),
        (0.4260, 0.3680, 0.0120),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(bin_ceiling, sharp_z=False)
    bin_rear = box(
        "Sanitary bin rear liner",
        (0.0, 0.1810, 0.5520),
        (0.4260, 0.0160, 0.4000),
        mat["liner"],
        root,
        0.002,
    )
    clean_mesh_object(bin_rear, sharp_z=False)
    for bx, bside in ((-0.2130, "left"), (0.2130, "right")):
        bwall = box(
            f"Sanitary bin {bside} wall liner",
            (bx, 0.0050, 0.5520),
            (0.0140, 0.3680, 0.4000),
            mat["liner"],
            root,
            0.002,
        )
        clean_mesh_object(bwall, sharp_z=False)

    # Front door aperture surround jambs (`X = ±0.218 m`, `Z = 0.352 .. 0.755 m`)
    for jx, jside in ((-0.2280, "left"), (0.2280, "right")):
        jamb = box(
            f"Bin aperture jamb {jside}",
            (jx, -0.1880, 0.5535),
            (0.0420, 0.0320, 0.4030),
            mat["liner"],
            root,
            0.002,
        )
        clean_mesh_object(jamb, sharp_z=False)

    # Upper-left closed-cell evaporator shroud & sanitary scoop hanger bracket (matching manufacturer-product.jpg!)
    evap_shroud = box(
        "Evaporator freezing chamber shroud",
        (-0.0600, 0.0250, 0.6960),
        (0.2500, 0.2500, 0.0980),
        mat["liner"],
        root,
        0.004,
    )
    clean_mesh_object(evap_shroud, sharp_z=False)

    # 30-cell (`5 x 6` array of `28 x 28 x 32 mm`) tin-plated copper evaporator cell grid inside the shroud (`Z = 0.6750 m`)
    cell_grid = box(
        "Copper evaporator 30-cell grid",
        (-0.0600, 0.0300, 0.6720),
        (0.1880, 0.1580, 0.0320),
        mat["copper_cell"],
        root,
        0.001,
    )
    clean_mesh_object(cell_grid, sharp_z=False)

    # Front molded sanitary scoop bracket on the evaporator shroud (`X = -0.0600 m, Y = -0.1050 m, Z = 0.6750 m`)
    scoop_bracket = box(
        "Sanitary scoop hanger bracket",
        (-0.0600, -0.1060, 0.6760),
        (0.0560, 0.0280, 0.0580),
        mat["liner"],
        root,
        0.002,
    )
    clean_mesh_object(scoop_bracket, sharp_z=False)

    # Stored cube ice bed at the bottom of the bin (`28 x 28 x 32 mm` cubes, top surface around Z = 0.4200 m)
    ice_bed = box(
        "Stored cube ice bed",
        (0.0, 0.0150, 0.3900),
        (0.3960, 0.3100, 0.0600),
        mat["ice_crystal"],
        root,
        0.004,
    )
    clean_mesh_object(ice_bed, sharp_z=False)
    for c_idx, (cx, cy, cz, rz) in enumerate(
        (
            (-0.120, -0.040, 0.432, 0.18),
            (-0.055, -0.025, 0.434, -0.24),
            (0.015, -0.035, 0.433, 0.31),
            (0.085, -0.015, 0.436, -0.15),
            (0.135, 0.035, 0.438, 0.22),
            (-0.095, 0.045, 0.435, -0.12),
            (0.025, 0.055, 0.437, 0.09),
            (0.110, 0.095, 0.440, -0.28),
        ),
        1,
    ):
        cube = box(
            f"Representative Hoshizaki 28x28x32mm ice cube {c_idx:02d}",
            (cx, cy, cz),
            (0.0280, 0.0280, 0.0320),
            mat["ice_crystal"],
            root,
            0.002,
        )
        cube.rotation_euler.z = rz
        clean_mesh_object(cube, sharp_z=False)

    # Named storage site inside the ice bin
    storage_site = empty("im_bin_storage", (0.0, 0.0100, 0.4200), root)
    storage_site["max_stock_kg"] = 18.0
    storage_site["natural_fall_kg"] = 10.5
    storage_site["cube_dimensions_m"] = [0.028, 0.028, 0.032]
    return worktop, storage_site


def build_control_window_and_filter(root, mat):
    # Vertical dark smoked-acrylic status & operation window (`im_control_panel`) at X = -0.1150 m, Z = 0.0250 .. 0.2480 m
    ctrl = empty("im_control_panel", (-0.1150, -0.2170, 0.1365), root)
    bezel = box(
        "Front status window bezel",
        (0.0, 0.0, 0.0),
        (0.0480, 0.0040, 0.2230),
        mat["filter_grey"],
        ctrl,
        0.001,
    )
    clean_mesh_object(bezel, sharp_z=False)
    lens = box(
        "Smoked acrylic status lens",
        (0.0, -0.0012, 0.0450),
        (0.0400, 0.0020, 0.1180),
        mat["smoked_lens"],
        ctrl,
        0.0005,
    )
    clean_mesh_object(lens, sharp_z=False)
    led_pip = box(
        "Ice-making status LED green",
        (-0.0100, -0.0024, 0.0780),
        (0.0060, 0.0010, 0.0060),
        mat["led_green"],
        ctrl,
        0.0,
    )
    clean_mesh_object(led_pip, sharp_z=True)
    text_label(
        "Status window code",
        "35",
        (0.0050, -0.0026, 0.0780),
        0.0110,
        mat["led_green"],
        ctrl,
    )

    # Articulated recessed power/service rocker switch (`im_power_switch`)
    pwr = empty("im_power_switch", POWER_SWITCH_PIVOT, root)
    pwr["joint_type"] = "hinge"
    pwr["axis_blender"] = "+X"
    pwr["range_rad"] = [0.0, 0.28]
    rocker = box(
        "im_power_switch_rocker",
        (0.0, -0.0015, 0.0),
        (0.0260, 0.0050, 0.0360),
        mat["handle_grey"],
        pwr,
        0.0008,
    )
    clean_mesh_object(rocker, sharp_z=False)

    # Articulated pull-out Raku-Eco condenser air filter (`im_air_filter`, `エアフィルタ`) at Z = 0.2680 m
    air_filter = empty("im_air_filter", FILTER_ORIGIN, root)
    air_filter["joint_type"] = "slide"
    air_filter["axis_blender"] = "-Y"
    air_filter["travel_m"] = 0.140
    grip = box(
        "Raku-Eco air filter pull handle",
        (0.0, -0.0020, 0.0),
        (0.2120, 0.0080, 0.0220),
        mat["filter_grey"],
        air_filter,
        0.0015,
    )
    clean_mesh_object(grip, sharp_z=False)
    screen = box(
        "Raku-Eco air filter mesh cartridge",
        (0.0, 0.0100, -0.1050),
        (0.2000, 0.0040, 0.2000),
        mat["filter_mesh"],
        air_filter,
        0.0005,
    )
    clean_mesh_object(screen, sharp_z=False)
    return ctrl, pwr, air_filter


def build_evaporator_water_plate_and_bin_switch(root, mat):
    # Articulated actuator-motor water plate (`im_water_plate`, `アクチュエータモータによる水皿半開`)
    wplate = empty("im_water_plate", WATER_PLATE_PIVOT, root)
    wplate["joint_type"] = "hinge"
    wplate["axis_blender"] = "+X"
    wplate["range_rad"] = [0.0, 0.48]
    wplate["status"] = "Closed (0 rad) during jet-spray freezing; tilts +0.48 rad (27.5 deg) during hot-gas harvest"
    tray = box(
        "Jet-spray water plate tray",
        (0.0, -0.1050, 0.0),
        (0.2100, 0.2100, 0.0140),
        mat["liner"],
        wplate,
        0.002,
    )
    clean_mesh_object(tray, sharp_z=False)
    curtain = box(
        "Water plate front splash curtain",
        (0.0, -0.2060, -0.0180),
        (0.2040, 0.0060, 0.0360),
        mat["scoop_resin"],
        wplate,
        0.001,
    )
    clean_mesh_object(curtain, sharp_z=False)

    # Articulated double-lever bin level switch (`im_bin_switch`, `ダブルレバー検知方式`) on upper right of bin
    bswitch = empty("im_bin_switch", BIN_SWITCH_PIVOT, root)
    bswitch["joint_type"] = "hinge"
    bswitch["axis_blender"] = "+X"
    bswitch["range_rad"] = [0.0, 0.55]
    bracket = box(
        "Bin switch pivot bracket",
        (0.0, 0.0, 0.0120),
        (0.0280, 0.0340, 0.0240),
        mat["worktop"],
        bswitch,
        0.001,
    )
    clean_mesh_object(bracket, sharp_z=False)
    paddle = box(
        "Double-lever ice sensing paddle",
        (0.0, 0.0, -0.0550),
        (0.0120, 0.0780, 0.1100),
        mat["worktop"],
        bswitch,
        0.001,
    )
    clean_mesh_object(paddle, sharp_z=False)
    return wplate, bswitch


def build_bottom_hinged_door(root, mat):
    # Bottom-hinged insulated bin door (`im_door`)
    # Pivot at (0.0, -0.2120, 0.3520) m.
    # Closed (0 rad): door spans Z = 0.3440 .. 0.7570 m (413 mm), front face at Y = -0.2250 m.
    # Open (+53.0 deg about +X): top handle swings forward to Y = -0.5390 m (+314 mm projection, 764 mm total depth) and Z = 0.5330 m!
    door = empty("im_door", DOOR_PIVOT, root)
    door["joint_type"] = "hinge"
    door["axis_blender"] = "+X"
    door["axis_gltf"] = "+X"
    door["preview_opening_degrees"] = 53.0
    door["open_projection_m"] = 0.3140
    door["open_top_height_m"] = 0.5330

    # Fluorine-precoated stainless door outer panel (`500 mm` wide, `385 mm` high below handle)
    outer_panel = box(
        "Door fluorine-precoated stainless panel",
        (0.0, -0.0020, 0.1845),
        (0.4996, 0.0220, 0.3850),
        mat["steel"],
        door,
        0.002,
    )
    clean_mesh_object(outer_panel, sharp_z=False)

    # Full-width top polymer handle bar (`Z_local = 0.3770 .. 0.4050 m` -> world `Z = 0.7290 .. 0.7570 m`, front at `Y = -0.2250 m`)
    handle_bar = box(
        "Door full-width top handle rail",
        (0.0, -0.0030, 0.3910),
        (0.4996, 0.0200, 0.0280),
        mat["handle_grey"],
        door,
        0.002,
    )
    clean_mesh_object(handle_bar, sharp_z=False)
    handle_recess = box(
        "Door top finger grip groove",
        (0.0, -0.0080, 0.3820),
        (0.4600, 0.0060, 0.0080),
        mat["recess_black"],
        door,
        0.001,
    )
    clean_mesh_object(handle_recess, sharp_z=False)

    # Molded white polypropylene inner door liner (`樹脂成形品`) with sloped condensation baffle
    inner_liner = box(
        "Door inner sanitary resin liner",
        (0.0, 0.0180, 0.1920),
        (0.4360, 0.0200, 0.3620),
        mat["liner"],
        door,
        0.003,
    )
    clean_mesh_object(inner_liner, sharp_z=False)

    # Perimeter antimicrobial door gasket (`扉パッキン`)
    gasket = frame(
        "Door perimeter magnetic gasket",
        (0.0, 0.0260, 0.1920),
        (0.4520, 0.3760, 0.0100),
        (0.4280, 0.3520, 0.0090),
        0.004,
        mat["gasket"],
        door,
    )
    clean_mesh_object(gasket, sharp_z=False)

    # HOSHIZAKI center wordmark + circular blue penguin badge + green R600a natural-refrigerant badge
    text_label(
        "Door HOSHIZAKI wordmark",
        "HOSHIZAKI",
        (0.0, -0.0129, 0.3520),
        0.0135,
        mat["ink_dark"],
        door,
    )
    penguin_badge = cylinder(
        "Door Hoshizaki penguin emblem",
        (0.1850, -0.0122, 0.3420),
        0.0140,
        0.0012,
        mat["badge_blue"],
        door,
        "Y",
    )
    clean_mesh_object(penguin_badge, sharp_z=False)
    text_label(
        "Door penguin badge H",
        "H",
        (0.1850, -0.0129, 0.3420),
        0.0140,
        mat["ink_white"],
        door,
    )
    eco_badge = box(
        "Door natural refrigerant R600a badge",
        (0.1850, -0.0122, 0.3120),
        (0.0280, 0.0012, 0.0140),
        mat["badge_green"],
        door,
        0.0004,
    )
    clean_mesh_object(eco_badge, sharp_z=False)
    text_label(
        "Door model IM-35P label",
        "IM-35P",
        (-0.1850, -0.0129, 0.3420),
        0.0095,
        mat["ink_dark"],
        door,
    )
    return door


def build_sanitary_ice_scoop(root, mat):
    # Removable sanitary white polypropylene ice scoop (`im_scoop`, `付属品：スコップ`)
    scoop = empty("im_scoop", SCOOP_REST_POSE, root)
    scoop["accessory_role"] = "Sanitary ice scoop (付属品：スコップ)"
    scoop["stowed_location_m"] = list(SCOOP_REST_POSE)

    # Channeled scoop bowl (lower section)
    bowl = box(
        "im_scoop_bowl",
        (0.0, 0.0, -0.0480),
        (0.0760, 0.0520, 0.0920),
        mat["scoop_resin"],
        scoop,
        0.004,
    )
    clean_mesh_object(bowl, sharp_z=False)

    # Sanitary hand shield flange
    shield = box(
        "im_scoop_hand_shield",
        (0.0, 0.0, 0.0020),
        (0.0820, 0.0580, 0.0080),
        mat["scoop_resin"],
        scoop,
        0.002,
    )
    clean_mesh_object(shield, sharp_z=False)

    # Vertical ergonomic handle with top hanger hook
    handle = cylinder(
        "im_scoop_handle",
        (0.0, 0.0, 0.0560),
        0.0135,
        0.1040,
        mat["scoop_resin"],
        scoop,
    )
    clean_mesh_object(handle, sharp_z=True)
    hook = box(
        "im_scoop_hanger_hook",
        (0.0, 0.0120, 0.1020),
        (0.0240, 0.0180, 0.0140),
        mat["scoop_resin"],
        scoop,
        0.002,
    )
    clean_mesh_object(hook, sharp_z=False)

    # Named grasp socket site for robot/human vessel handling
    socket = empty("vessel_socket", (0.0, 0.0, 0.0560), scoop)
    socket["site_role"] = "Sanitary scoop grasp socket"
    return scoop


def build_rear_utilities(root, mat):
    # Rear utility connections (`im_utilities`) from Drawing D41369 rear view:
    # Excluded from the 500 x 450 x 800 mm cabinet bounding-box check
    util = empty("im_utilities", (0.0, 0.0, 0.0), root)
    util["status"] = "Rear R3/4 drain, R1/2 water inlet, L2800 power cord and L3000 ground wire; excluded from cabinet envelope check"

    # Drain outlet R3/4 (`排水口 R3/4`, 41 mm from right edge -> X = +0.2090 m, Z = 0.1790 m)
    drain_boss = cylinder(
        "Rear drain outlet R3/4 boss",
        (0.2090, 0.1840, 0.1790),
        0.0180,
        0.0240,
        mat["liner"],
        util,
        "Y",
    )
    clean_mesh_object(drain_boss, sharp_z=False)
    drain_nipple = cylinder(
        "Rear drain outlet R3/4 fitting",
        (0.2090, 0.2020, 0.1790),
        0.0130,
        0.0260,
        mat["filter_grey"],
        util,
        "Y",
    )
    clean_mesh_object(drain_nipple, sharp_z=False)

    # Potable water inlet R1/2 (`給水口 R1/2`, 74 mm from right edge -> X = +0.1760 m, Z = 0.0790 m)
    water_plate = box(
        "Rear water inlet mounting plate",
        (0.1760, 0.1780, 0.0880),
        (0.0360, 0.0080, 0.0520),
        mat["worktop"],
        util,
        0.001,
    )
    clean_mesh_object(water_plate, sharp_z=False)
    water_fitting = cylinder(
        "Rear potable water inlet R1/2 brass fitting",
        (0.1760, 0.1940, 0.0790),
        0.0105,
        0.0280,
        mat["brass"],
        util,
        "Y",
    )
    clean_mesh_object(water_fitting, sharp_z=False)

    # Rear power cord (`電源コード 機外L2800 (L形プラグ付)`, 158 mm from right edge -> X = +0.0920 m) & ground lead (`181 mm` -> X = +0.0690 m)
    cord_bushing = box(
        "Rear power cord strain relief bushing",
        (0.0805, 0.1800, 0.0320),
        (0.0420, 0.0140, 0.0220),
        mat["foot_resin"],
        util,
        0.002,
    )
    clean_mesh_object(cord_bushing, sharp_z=False)
    l_plug = box(
        "JIS 100V L-shaped power plug body",
        (0.0920, 0.2120, 0.0240),
        (0.0280, 0.0380, 0.0260),
        mat["foot_resin"],
        util,
        0.002,
    )
    clean_mesh_object(l_plug, sharp_z=False)
    return util


def animate_timeline(door, air_filter, wplate, bswitch, pwr, scoop):
    # Frame 1..20: Closed at rest
    # Frame 55..85: Door open 53 deg (+314 mm swing, Z_top = 533 mm), Raku-Eco filter pulled out 90 mm,
    #               water plate tilted 27.5 deg for harvest inspection, bin switch deflected 20 deg,
    #               ice scoop lifted forward out of the bin
    # Frame 120: Returned to closed rest pose
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0, SCOOP_REST_POSE, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, 0.0, 0.0, SCOOP_REST_POSE, (0.0, 0.0, 0.0)),
        (
            55,
            DOOR_OPEN_RAD,
            -0.090,
            0.480,
            0.350,
            0.220,
            (-0.0400, -0.3400, 0.5900),
            (math.radians(-35.0), 0.0, 0.0),
        ),
        (
            85,
            DOOR_OPEN_RAD,
            -0.090,
            0.480,
            0.350,
            0.220,
            (-0.0400, -0.3400, 0.5900),
            (math.radians(-35.0), 0.0, 0.0),
        ),
        (120, 0.0, 0.0, 0.0, 0.0, 0.0, SCOOP_REST_POSE, (0.0, 0.0, 0.0)),
    )
    for (
        frame_no,
        door_rx,
        filt_dy,
        wp_rx,
        bs_rx,
        pwr_rx,
        scoop_loc,
        scoop_rot,
    ) in keyframes:
        door.rotation_euler = (door_rx, 0.0, 0.0)
        door.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        air_filter.location = (
            FILTER_ORIGIN[0],
            FILTER_ORIGIN[1] + filt_dy,
            FILTER_ORIGIN[2],
        )
        air_filter.keyframe_insert(data_path="location", frame=frame_no)

        wplate.rotation_euler = (-wp_rx, 0.0, 0.0)
        wplate.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        bswitch.rotation_euler = (bs_rx, 0.0, 0.0)
        bswitch.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        pwr.rotation_euler = (pwr_rx, 0.0, 0.0)
        pwr.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        scoop.location = scoop_loc
        scoop.rotation_euler = scoop_rot
        scoop.keyframe_insert(data_path="location", frame=frame_no)
        scoop.keyframe_insert(data_path="rotation_euler", frame=frame_no)


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def setup_references(scene):
    collection = bpy.data.collections.new("Reference drawings - toggle visibility")
    scene.collection.children.link(collection)
    views = (
        ("Front drawing", "orthographic-front.png", (0.0, 0.30, 0.40), (math.pi / 2, 0.0, 0.0)),
        ("Side drawing", "orthographic-side.png", (-0.35, 0.0, 0.40), (math.pi / 2, 0.0, math.pi / 2)),
        ("Top drawing", "orthographic-top.png", (0.0, 0.0, -0.03), (0.0, 0.0, 0.0)),
        ("Rear drawing", "orthographic-rear.png", (0.0, -0.30, 0.40), (math.pi / 2, 0.0, math.pi)),
        ("Complete D41369", "dimensioned-orthographic-sheet.png", (0.0, 0.65, 0.65), (math.pi / 2, 0.0, 0.0)),
    )
    for name, file, position, rotation in views:
        image = bpy.data.images.load(str(REFERENCES / "images" / file))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        collection.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1.1
        obj.location = position
        obj.rotation_euler = rotation
        obj.color[3] = 0.45
        obj.hide_render = True
        obj["reference_status"] = "Unregistered inspection image; use labelled dimensions from D41369"
    collection.hide_viewport = True
    collection.hide_render = True


def setup_studio(scene):
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("IM-35P studio world")
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.55,
        0.60,
        0.68,
        1.0,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.48
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.20
    ground = material("Studio warm grey", (0.29, 0.31, 0.33, 1.0), roughness=0.88)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.001))
    bpy.context.object.name = "Studio ground"
    bpy.context.object.data.materials.append(ground)
    area_light("Left key softbox", (-1.8, -2.2, 2.2), (0.0, 0.0, 0.42), 240, 1.8)
    area_light("Right fill stripbox", (1.9, -0.6, 1.8), (0.0, 0.0, 0.42), 170, 1.5)
    area_light("Rear rim softbox", (0.0, 1.6, 2.1), (0.0, 0.0, 0.45), 180, 1.4)
    area_light("Bin interior fill", (0.0, -2.0, 0.95), (0.0, 0.0, 0.52), 85, 1.2)
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


def export_glb(root, scoop):
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
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
        export_animations=True,
        export_animation_mode="SCENE",
        export_frame_range=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )

    # Also export standalone reusable sanitary ice scoop GLB centered at origin
    saved_parent = scoop.parent
    saved_loc = scoop.location.copy()
    saved_rot = tuple(scoop.rotation_euler)
    scoop.animation_data_clear()
    scoop.parent = None
    scoop.location = (0.0, 0.0, 0.0)
    scoop.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    scoop.select_set(True)
    for obj in scoop.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / f"{NAME}-scoop.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    scoop.parent = saved_parent
    scoop.location = saved_loc
    scoop.rotation_euler = saved_rot
    bpy.context.view_layer.update()


def record_build_report(scene, root):
    scene.frame_set(1)
    bpy.context.view_layer.update()
    worktop = bpy.data.objects["Stainless worktop"]
    report = {
        "asset": NAME,
        "blender_version": bpy.app.version_string,
        "drawing": "D41369 (2025-02-20, IM-35P) and D27883 (2023-08-04, IM-35M-2)",
        "source_sha256": hashlib.sha256(
            (REFERENCES / "specifications/dimensioned-drawing.pdf").read_bytes()
        ).hexdigest(),
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "open_door_depth_m": 0.764,
        "open_door_projection_m": 0.314,
        "open_door_handle_height_m": 0.533,
        "worktop_dimensions_m": [round(v, 6) for v in worktop.dimensions],
        "published_mass_kg": 37.0,
        "ice_production_kg_per_day_50_60hz": [36.0, 38.0],
        "ice_batch_kg": 0.73,
        "ice_cubes_per_batch": 30,
        "cube_dimensions_m": [0.028, 0.028, 0.032],
        "bin_max_stock_kg": 18.0,
        "bin_natural_fall_kg": 10.5,
        "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 175/195 W, R600a",
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Hoshizaki IM-35P - Japan reference"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120
    for marker_name, frame_no in (
        ("Closed", 1),
        ("Open bin & harvest preview", 55),
        ("Inspect interior", 85),
        ("Closed again", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=frame_no)

    root = empty("im_cabinet", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Hoshizaki"
    root["model"] = "IM-35P"
    root["predecessor_models"] = "IM-35M-2, IM-35M-1, IM-35M, IM-35L"
    root["drawing"] = "D41369 / 2025-02-20"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["manufacturer_total_mass_kg"] = 37.0

    mat = surfaces()
    build_cabinet_and_bin(root, mat)
    _ctrl, pwr, air_filter = build_control_window_and_filter(root, mat)
    wplate, bswitch = build_evaporator_water_plate_and_bin_switch(root, mat)
    door = build_bottom_hinged_door(root, mat)
    scoop = build_sanitary_ice_scoop(root, mat)
    build_rear_utilities(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, door, pwr])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, sharp_z=False)

    animate_timeline(door, air_filter, wplate, bswitch, pwr, scoop)
    export_glb(root, scoop)
    animate_timeline(door, air_filter, wplate, bswitch, pwr, scoop)

    appliance = bpy.data.collections.new("IM-35P appliance")
    scene.collection.children.link(appliance)
    move_objects([root, *root.children_recursive], appliance)

    setup_references(scene)
    camera = setup_studio(scene)
    views = (
        ("studio-closed", (1.25, -2.10, 1.25), (0.0, 0.0, 0.40), 1.08, 1),
        ("studio-open", (1.15, -2.25, 1.30), (0.0, -0.08, 0.42), 1.18, 70),
        ("studio-front", (0.0, -2.20, 0.40), (0.0, 0.0, 0.40), 1.02, 1),
        ("studio-interior", (0.0, -2.10, 0.56), (0.0, 0.0, 0.50), 0.92, 70),
        ("studio-right", (2.20, 0.0, 0.40), (0.0, 0.0, 0.40), 1.02, 1),
        ("studio-rear", (-1.15, 2.15, 1.20), (0.0, 0.0, 0.38), 1.08, 1),
    )
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            scene.render.filepath = str(ASSETS / f"{vname}.png")
            bpy.ops.render.render(write_still=True)

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])
    record_build_report(scene, root)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))
    print("Saved editable Hoshizaki IM-35P Blender source, GLBs and renders:", ASSETS)


if __name__ == "__main__":
    main()
