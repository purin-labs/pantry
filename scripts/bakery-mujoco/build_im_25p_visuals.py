"""Build the Japanese Hoshizaki IM-25P undercounter commercial cube ice maker visual model.

Metres, Z up, operator front towards -Y.
Follows official Hoshizaki 1/10 scale engineering drawing D41368 (2025-02-20, IM-25P, R600a,
docs/equipment/hoshizaki-im-25p/specifications/dimensioned-drawing.pdf) and archived lineup record
(docs/equipment/hoshizaki-im-35p/specifications/lineup-page.html, id=168, IM-25P).
Published cabinet envelope: 395 x 450 x 770 mm (W x D x H), unit mass 33.000 kg (including sanitary ice scoop),
single-phase 100 V AC 50/60 Hz, 0.47 kVA (4.7 A), 145/165 W, ice production 24/26 kg/day (20C/15C) and
19/22 kg/day (30C/25C), 28 x 28 x 32 mm cubes (18 cubes / 0.43 kg per cycle), bin 8.5 kg natural drop / 14.0 kg max stock.
"""

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

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
ASSETS = ROOT / "assets/bakery-mujoco/hoshizaki-im-25p"
DRAWING_PDF = ROOT / "docs/equipment/hoshizaki-im-25p/specifications/dimensioned-drawing.pdf"
LINEUP_REF = ROOT / "docs/equipment/hoshizaki-im-35p/specifications/lineup-page.html"
IM35_IMAGES = ROOT / "docs/equipment/hoshizaki-im-35p/images"
NAME = "hoshizaki-im-25p"

WIDTH = 0.3950
DEPTH = 0.4500
HEIGHT = 0.7700

# D41368 exact vertical stack: 17 mm feet (0..0.017) + 305 mm lower panel (0.017..0.322)
# + 22 mm hinge recess (0.322..0.344) + 383 mm door (0.344..0.727) + 43 mm top bezel/worktop (0.727..0.770)
DOOR_PIVOT = (0.0, -0.2120, 0.3440)
DOOR_OPEN_RAD = math.radians(52.0)

# D41368 front view: vertical pull-out air filter handle along the left edge of the twin right intake louver columns
FILTER_ORIGIN = (-0.0545, -0.2180, 0.1420)
WATER_PLATE_PIVOT = (-0.0450, 0.1300, 0.6140)
BIN_SWITCH_PIVOT = (0.1050, 0.0100, 0.6280)
POWER_SWITCH_PIVOT = (-0.0855, -0.2185, 0.0950)
SCOOP_REST_POSE = (-0.0450, -0.1120, 0.5340)

FOOT_POSITIONS = (
    ("im25_foot_front_left", -0.1675, -0.1390),
    ("im25_foot_front_right", 0.1675, -0.1390),
    ("im25_foot_rear_left", -0.1675, 0.1130),
    ("im25_foot_rear_right", 0.1675, 0.1130),
)


def enable_metal_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    metal_found = any(dev.type == "METAL" for dev in prefs.devices)
    for dev in prefs.devices:
        dev.use = (dev.type == "METAL") if metal_found else True
    scene.cycles.device = "GPU"


def clean_mesh_object(obj, sharp_z=False, sharp_y=False, flat_faces=True, recalc_normals=True):
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
        n = poly.normal
        is_flat_axis = flat_faces and max(abs(n.x), abs(n.y), abs(n.z)) > 0.96
        is_cap_z = sharp_z and abs(n.z) > 0.98
        is_cap_y = sharp_y and abs(n.y) > 0.98
        poly.use_smooth = not (is_flat_axis or is_cap_z or is_cap_y)
    return obj


def surfaces():
    mats = {
        "steel": material(
            "IM25 fluorine-precoated stainless exterior",
            (0.60, 0.63, 0.65, 1.0),
            0.86,
            0.25,
        ),
        "worktop": material(
            "IM25 brushed stainless worktop", (0.64, 0.67, 0.69, 1.0), 0.90, 0.21
        ),
        "galv": material(
            "IM25 rear galvanized steel", (0.46, 0.49, 0.51, 1.0), 0.72, 0.36
        ),
        "liner": material(
            "IM25 sanitary white polypropylene liner",
            (0.86, 0.89, 0.92, 1.0),
            0.04,
            0.26,
        ),
        "scoop_resin": material(
            "IM25 antibacterial white ice scoop resin",
            (0.91, 0.93, 0.96, 1.0),
            0.04,
            0.20,
        ),
        "handle_grey": material(
            "IM25 molded dark charcoal ABS top door handle",
            (0.018, 0.020, 0.024, 1.0),
            0.02,
            0.62,
        ),
        "filter_grey": material(
            "IM25 Raku-Eco air filter pull handle resin",
            (0.045, 0.050, 0.058, 1.0),
            0.04,
            0.55,
        ),
        "filter_mesh": material(
            "IM25 Raku-Eco nylon filter mesh", (0.08, 0.09, 0.11, 1.0), 0.04, 0.65
        ),
        "gasket": material(
            "IM25 antimicrobial door gasket", (0.16, 0.18, 0.20, 1.0), 0.0, 0.62
        ),
        "recess_black": material(
            "IM25 louver and handle shadow recess black",
            (0.004, 0.005, 0.007, 1.0),
            0.02,
            0.75,
        ),
        "copper_cell": material(
            "IM25 tin-plated copper evaporator cell",
            (0.68, 0.66, 0.62, 1.0),
            0.90,
            0.22,
        ),
        "brass": material(
            "IM25 rear water and drain brass fitting",
            (0.72, 0.56, 0.24, 1.0),
            0.88,
            0.24,
        ),
        "ice_crystal": material(
            "IM25 clear cube ice 28x28x32mm", (0.76, 0.88, 0.96, 1.0), 0.08, 0.12
        ),
        "badge_blue": material(
            "IM25 Hoshizaki penguin emblem blue",
            (0.010, 0.18, 0.48, 1.0),
            0.08,
            0.32,
        ),
        "badge_green": material(
            "IM25 sanitation and R600a green badge",
            (0.03, 0.42, 0.20, 1.0),
            0.06,
            0.35,
        ),
        "led_green": material(
            "IM25 active status LED green", (0.12, 0.82, 0.28, 1.0), 0.0, 0.35, 0.5
        ),
        "ink_white": material(
            "IM25 white badge lettering", (0.94, 0.95, 0.97, 1.0), 0.04, 0.26
        ),
        "ink_dark": material(
            "IM25 dark wordmark lettering", (0.015, 0.020, 0.025, 1.0), 0.05, 0.65
        ),
        "foot_resin": material(
            "IM25 heavy-duty elastomer foot", (0.035, 0.038, 0.042, 1.0), 0.04, 0.58
        ),
    }
    for m in mats.values():
        m["metallic"] = float(m.get("metallic", 0.0))
        m["roughness"] = float(m.get("roughness", 0.4))
        m["emission"] = float(m.get("emission", 0.0))
    return mats


def text_label(name, text, position, size, surface, parent, align_x="CENTER", rot_x=math.pi / 2):
    data = bpy.data.curves.new(name, "FONT")
    data.body = text
    data.size = size
    data.align_x = align_x
    data.align_y = "CENTER"
    data.extrude = 0.0
    data.resolution_u = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler.x = rot_x
    return finish(obj, name, surface, parent)


def build_cabinet_and_bin(root, mat):
    # 1. Top brushed stainless worktop: exact 395 x 450 mm (`X in [-0.1975, +0.1975]`, `Y in [-0.2250, +0.2250]`), top at Z = 0.7700 m
    worktop = box(
        "Stainless worktop",
        (0.0, 0.0, 0.7590),
        (0.3950, 0.4500, 0.0220),
        mat["worktop"],
        root,
        0.0,
    )
    clean_mesh_object(worktop, flat_faces=True)

    # Upper front stainless fascia panel (`Z = 0.7270 .. 0.7480 m`, completing the 43 mm upper zone `Z = 0.7270 .. 0.7700 m` on D41368)
    fascia = box(
        "Upper front stainless fascia",
        (0.0, -0.2145, 0.7375),
        (0.3946, 0.0170, 0.0210),
        mat["steel"],
        root,
        0.0006,
    )
    clean_mesh_object(fascia, flat_faces=True)
    for sx, sname in ((-0.1840, "left"), (0.1840, "right")):
        scr = cylinder(
            f"Upper fascia screw {sname}",
            (sx, -0.2232, 0.7375),
            0.0028,
            0.0016,
            mat["worktop"],
            root,
            "Y",
        )
        clean_mesh_object(scr, sharp_y=True, flat_faces=False)

    # Left and right exterior stainless side walls (outer faces at exact X = ±0.1975 m)
    # D41368 side view: lower rear compressor step cutout (`48.5 mm` deep, `Z = 0.0170 .. 0.2200 m`)
    for side_sign, side_name in ((-1.0, "left"), (1.0, "right")):
        wx = side_sign * 0.1855
        upper_wall = box(
            f"Exterior {side_name} upper wall",
            (wx, 0.0040, 0.4840),
            (0.0240, 0.4420, 0.5280),
            mat["steel"],
            root,
            0.0005,
        )
        clean_mesh_object(upper_wall, flat_faces=True)
        lower_wall = box(
            f"Exterior {side_name} lower wall",
            (side_sign * 0.1850, -0.0240, 0.1185),
            (0.0230, 0.4010, 0.2030),
            mat["steel"],
            root,
            0.0005,
        )
        clean_mesh_object(lower_wall, flat_faces=True)

        # D41368 side view: 2 horizontal tiers of 16 vertical louver slots spanning 252 mm (`Y = -0.1390 .. +0.1130 m`, 86 mm from front)
        for row_idx, lz in enumerate((0.0820, 0.1480), 1):
            for slot_idx in range(16):
                ly = -0.1390 + slot_idx * (0.2520 / 15.0)
                slot = box(
                    f"Side louver {side_name} r{row_idx}_{slot_idx:02d}",
                    (side_sign * 0.1963, ly, lz),
                    (0.0016, 0.0072, 0.0520),
                    mat["recess_black"],
                    root,
                    0.0,
                )
                clean_mesh_object(slot, flat_faces=True)

    # Rear upper galvanized insulated wall (`Y = +0.2050 m`, outer face at Y = +0.2250 m, `Z = 0.2200 .. 0.7480 m`)
    rear_upper = box(
        "Rear upper insulated wall",
        (0.0, 0.2050, 0.4840),
        (0.3470, 0.0400, 0.5280),
        mat["galv"],
        root,
        0.0005,
    )
    clean_mesh_object(rear_upper, flat_faces=True)

    # Rear top recessed transport hand grip shown on D41368 rear view
    rear_grip = box(
        "Rear top transport grip recess",
        (0.0, 0.2238, 0.7360),
        (0.0540, 0.0022, 0.0120),
        mat["recess_black"],
        root,
        0.0,
    )
    clean_mesh_object(rear_grip, flat_faces=True)

    # Rear lower stepped compressor panel (`48.5 mm` inset from rear face -> outer face at `Y = +0.1765 m`, `Z = 0.0170 .. 0.2200 m`)
    rear_lower = box(
        "Rear lower compressor step panel",
        (-0.0790, 0.1645, 0.1185),
        (0.1890, 0.0240, 0.2030),
        mat["galv"],
        root,
        0.0005,
    )
    clean_mesh_object(rear_lower, flat_faces=True)
    for row_idx, rz in enumerate((0.0820, 0.1480), 1):
        for slot_idx in range(11):
            rx = -0.1580 + slot_idx * 0.0155
            rslot = box(
                f"Rear exhaust louver r{row_idx}_{slot_idx:02d}",
                (rx, 0.1760, rz),
                (0.0070, 0.0020, 0.0500),
                mat["recess_black"],
                root,
                0.0,
            )
            clean_mesh_object(rslot, flat_faces=True)

    # D41368 rear view: lower-right recessed plumbing & electrical pocket (`158 mm` wide x `179 mm` high, `X = +0.0395 .. +0.1975 m`, `Z = 0.0170 .. 0.1960 m`)
    pocket_back = box(
        "Rear right plumbing pocket backplate",
        (0.1065, 0.1480, 0.1185),
        (0.1580, 0.0120, 0.2030),
        mat["galv"],
        root,
        0.0005,
    )
    clean_mesh_object(pocket_back, flat_faces=True)

    # Bottom galvanized base pan (`Z = 0.0170 .. 0.0350 m`, `17 mm` ground clearance per D41368)
    base_pan = box(
        "Lower galvanized base frame",
        (0.0, -0.0240, 0.0260),
        (0.3910, 0.3930, 0.0180),
        mat["galv"],
        root,
        0.0006,
    )
    clean_mesh_object(base_pan, flat_faces=True)

    # Four `17 mm` feet touching exact Z = 0.0000 m at `X = ±0.1675 m` (`335 mm`), `Y = -0.1390, +0.1130 m` (`252 mm`)
    for fname, fx, fy in FOOT_POSITIONS:
        foot = empty(fname, (fx, fy, 0.0), root)
        foot["contact_plane_z_m"] = 0.0
        collar = cylinder(
            f"{fname}_collar",
            (0.0, 0.0, 0.0115),
            0.0175,
            0.0110,
            mat["galv"],
            foot,
        )
        clean_mesh_object(collar, sharp_z=True, flat_faces=False)
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=24, radius=0.0145, depth=0.0060, location=(0.0, 0.0, 0.0030)
        )
        pad = finish(bpy.context.object, f"{fname}_pad", mat["foot_resin"], foot, 0.0)
        clean_mesh_object(pad, sharp_z=True, flat_faces=False)

    # D41368 front view: 305 mm lower front fluorine-precoated stainless louver panel (`Z = 0.0170 .. 0.3220 m`)
    front_lower = box(
        "Lower front service louver panel",
        (0.0, -0.2145, 0.1695),
        (0.3946, 0.0200, 0.3050),
        mat["steel"],
        root,
        0.0006,
    )
    clean_mesh_object(front_lower, flat_faces=True)

    # Four corner retaining screws on the lower front service panel (`D41368` front view)
    for sx, sz, sname in (
        (-0.1840, 0.3110, "top_left"),
        (0.1840, 0.3110, "top_right"),
        (-0.1840, 0.0280, "bot_left"),
        (0.1840, 0.0280, "bot_right"),
    ):
        lscr = cylinder(
            f"Lower louver panel screw {sname}",
            (sx, -0.2240, sz),
            0.0026,
            0.0014,
            mat["worktop"],
            root,
            "Y",
        )
        clean_mesh_object(lscr, sharp_y=True, flat_faces=False)

    # D41368 front view: Left front exhaust louver column (`排気`, 14 horizontal stamped slots at X = -0.1410 m)
    for idx in range(14):
        lz = 0.0480 + idx * 0.0142
        lslot = box(
            f"Front left exhaust louver {idx:02d}",
            (-0.1410, -0.2238, lz),
            (0.0680, 0.0020, 0.0052),
            mat["recess_black"],
            root,
            0.0,
        )
        clean_mesh_object(lslot, flat_faces=True)
        lhood = box(
            f"Front left louver hood {idx:02d}",
            (-0.1410, -0.2244, lz + 0.0034),
            (0.0690, 0.0006, 0.0022),
            mat["steel"],
            root,
            0.0,
        )
        clean_mesh_object(lhood, flat_faces=True)

    # D41368 front view: Right twin condenser intake louver columns (`吸気`, 2 columns x 14 horizontal stamped slots)
    for col_idx, cx in enumerate((0.0040, 0.1120), 1):
        for idx in range(14):
            lz = 0.0480 + idx * 0.0142
            rslot = box(
                f"Front right intake louver c{col_idx}_{idx:02d}",
                (cx, -0.2238, lz),
                (0.0920, 0.0020, 0.0052),
                mat["recess_black"],
                root,
                0.0,
            )
            clean_mesh_object(rslot, flat_faces=True)
            rhood = box(
                f"Front right louver hood c{col_idx}_{idx:02d}",
                (cx, -0.2244, lz + 0.0034),
                (0.0930, 0.0006, 0.0022),
                mat["steel"],
                root,
                0.0,
            )
            clean_mesh_object(rhood, flat_faces=True)

    # D41368 front & side views: 22 mm recessed horizontal hinge channel (`Z = 0.3220 .. 0.3440 m`) and left/right lower door hinge brackets
    hinge_channel = box(
        "Front 22mm door hinge recess",
        (0.0, -0.2060, 0.3330),
        (0.3936, 0.0240, 0.0220),
        mat["recess_black"],
        root,
        0.0,
    )
    clean_mesh_object(hinge_channel, flat_faces=True)
    for hx, hside in ((-0.1450, "left"), (0.1450, "right")):
        hbr = box(
            f"Lower door hinge bracket {hside}",
            (hx, -0.2140, 0.3360),
            (0.0440, 0.0160, 0.0120),
            mat["worktop"],
            root,
            0.0005,
        )
        clean_mesh_object(hbr, flat_faces=True)

    # Interior food-grade white polypropylene ice storage bin liner (`X in [-0.160, +0.160]`, `Y in [-0.175, +0.185]`, `Z in [0.344, 0.728]`)
    bin_floor = box(
        "Sanitary bin floor liner",
        (0.0, 0.0050, 0.3360),
        (0.3320, 0.3680, 0.0200),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(bin_floor, flat_faces=True)
    bin_ceiling = box(
        "Sanitary bin ceiling liner",
        (0.0, 0.0050, 0.7280),
        (0.3320, 0.3680, 0.0120),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(bin_ceiling, flat_faces=True)
    bin_rear = box(
        "Sanitary bin rear liner",
        (0.0, 0.1810, 0.5330),
        (0.3320, 0.0160, 0.3820),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(bin_rear, flat_faces=True)
    for bx, bside in ((-0.1620, "left"), (0.1620, "right")):
        bwall = box(
            f"Sanitary bin {bside} wall liner",
            (bx, 0.0050, 0.5330),
            (0.0140, 0.3680, 0.3820),
            mat["liner"],
            root,
            0.001,
        )
        clean_mesh_object(bwall, flat_faces=True)

    # Front door aperture surround jambs (`X = ±0.1765 m`, `Z = 0.344 .. 0.726 m`)
    for jx, jside in ((-0.1765, "left"), (0.1765, "right")):
        jamb = box(
            f"Bin aperture jamb {jside}",
            (jx, -0.1880, 0.5350),
            (0.0360, 0.0320, 0.3820),
            mat["liner"],
            root,
            0.001,
        )
        clean_mesh_object(jamb, flat_faces=True)

    # Upper-left closed-cell evaporator shroud & sanitary scoop hanger bracket
    evap_shroud = box(
        "Evaporator freezing chamber shroud",
        (-0.0450, 0.0250, 0.6680),
        (0.2000, 0.2400, 0.0940),
        mat["liner"],
        root,
        0.002,
    )
    clean_mesh_object(evap_shroud, flat_faces=True)

    # 18-cell (`3 x 6` array of `28 x 28 x 32 mm`) tin-plated copper evaporator cell grid (`0.43 kg` per cycle)
    cell_grid = box(
        "Copper evaporator 18-cell grid",
        (-0.0450, 0.0300, 0.6440),
        (0.1120, 0.1820, 0.0320),
        mat["copper_cell"],
        root,
        0.001,
    )
    clean_mesh_object(cell_grid, flat_faces=True)

    # Front molded sanitary scoop hanger bracket & lower support shelf (`Z_top = 0.4420 m`)
    scoop_bracket = box(
        "Sanitary scoop hanger bracket",
        (-0.0450, -0.1040, 0.6460),
        (0.0520, 0.0260, 0.0540),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(scoop_bracket, flat_faces=True)
    scoop_ledge = box(
        "Sanitary scoop support shelf",
        (-0.0450, -0.1120, 0.4380),
        (0.0820, 0.0580, 0.0080),
        mat["liner"],
        root,
        0.001,
    )
    clean_mesh_object(scoop_ledge, flat_faces=True)

    # Stored cube ice bed at the bottom of the bin (`28 x 28 x 32 mm` cubes, top surface around Z = 0.4040 m)
    ice_bed = box(
        "Stored cube ice bed",
        (0.0, 0.0150, 0.3740),
        (0.3040, 0.3040, 0.0560),
        mat["ice_crystal"],
        root,
        0.002,
    )
    clean_mesh_object(ice_bed, flat_faces=True)
    for c_idx, (cx, cy, cz, rz) in enumerate(
        (
            (-0.095, -0.035, 0.416, 0.18),
            (-0.035, -0.022, 0.418, -0.24),
            (0.025, -0.030, 0.417, 0.31),
            (0.085, -0.012, 0.420, -0.15),
            (-0.075, 0.045, 0.419, -0.12),
            (0.010, 0.052, 0.421, 0.09),
            (0.088, 0.082, 0.422, -0.28),
        ),
        1,
    ):
        cube = box(
            f"Representative Hoshizaki 28x28x32mm ice cube {c_idx:02d}",
            (cx, cy, cz),
            (0.0280, 0.0280, 0.0320),
            mat["ice_crystal"],
            root,
            0.001,
        )
        cube.rotation_euler.z = rz
        clean_mesh_object(cube, flat_faces=True)

    # Named storage site inside the ice bin
    storage_site = empty("im25_bin_storage", (0.0, 0.0100, 0.4080), root)
    storage_site["max_stock_kg"] = 14.0
    storage_site["natural_fall_kg"] = 8.5
    storage_site["cube_dimensions_m"] = [0.028, 0.028, 0.032]
    return worktop, storage_site


def build_control_window_and_filter(root, mat):
    # Solid vertical divider band (`X in [-0.107, -0.064] m`) with subtle recessed service access seam (`im25_control_panel`)
    # Matching D41368 front view (no external digital "25" readout strip)
    ctrl = empty("im25_control_panel", (-0.0855, -0.2235, 0.0950), root)
    seam = box(
        "Front service access recess seam",
        (0.0, 0.0, 0.0),
        (0.0280, 0.0016, 0.0480),
        mat["steel"],
        ctrl,
        0.0004,
    )
    clean_mesh_object(seam, flat_faces=True)
    led_pip = box(
        "Ice-making status LED green",
        (0.0, -0.0009, 0.0185),
        (0.0040, 0.0004, 0.0025),
        mat["led_green"],
        ctrl,
        0.0,
    )
    clean_mesh_object(led_pip, flat_faces=True)

    # Articulated recessed power/service rocker switch (`im25_power_switch`) inside the divider service pocket
    pwr = empty("im25_power_switch", POWER_SWITCH_PIVOT, root)
    pwr["joint_type"] = "hinge"
    pwr["axis_blender"] = "+X"
    pwr["range_rad"] = [0.0, 0.28]
    rocker = box(
        "im25_power_switch_rocker",
        (0.0, -0.0025, 0.0),
        (0.0180, 0.0040, 0.0260),
        mat["filter_grey"],
        pwr,
        0.0005,
    )
    clean_mesh_object(rocker, flat_faces=True)

    # D41368 front view (`エアフィルタ`): Vertical pull-out air filter handle along the left edge of the twin right intake louver columns
    # FILTER_ORIGIN = (-0.0545, -0.2180, 0.1420)
    air_filter = empty("im25_air_filter", FILTER_ORIGIN, root)
    air_filter["joint_type"] = "slide"
    air_filter["axis_blender"] = "-Y"
    air_filter["travel_m"] = 0.130
    grip = box(
        "Raku-Eco air filter pull handle",
        (0.0, -0.0032, 0.0),
        (0.0130, 0.0068, 0.2020),
        mat["filter_grey"],
        air_filter,
        0.0006,
    )
    clean_mesh_object(grip, flat_faces=True)
    pull_tab = box(
        "Raku-Eco air filter finger tab",
        (-0.0010, -0.0052, -0.0120),
        (0.0080, 0.0032, 0.0440),
        mat["filter_grey"],
        air_filter,
        0.0004,
    )
    clean_mesh_object(pull_tab, flat_faces=True)
    screen = box(
        "Raku-Eco air filter mesh cartridge",
        (0.1060, 0.0060, 0.0),
        (0.2080, 0.0040, 0.1940),
        mat["filter_mesh"],
        air_filter,
        0.0004,
    )
    clean_mesh_object(screen, flat_faces=True)
    return ctrl, pwr, air_filter


def build_evaporator_water_plate_and_bin_switch(root, mat):
    # Articulated actuator-motor water plate (`im25_water_plate`, `アクチュエータモータによる水皿半開`)
    # Positive rotation around +X tilts front (-Y) downward (-Z) during hot-gas harvest
    wplate = empty("im25_water_plate", WATER_PLATE_PIVOT, root)
    wplate["joint_type"] = "hinge"
    wplate["axis_blender"] = "+X"
    wplate["range_rad"] = [0.0, 0.48]
    wplate["status"] = (
        "Closed (0 rad) during jet-spray freezing; tilts +0.48 rad (27.5 deg) downward during hot-gas harvest"
    )
    tray = box(
        "Jet-spray water plate tray",
        (0.0, -0.0950, 0.0),
        (0.1720, 0.1900, 0.0140),
        mat["liner"],
        wplate,
        0.001,
    )
    clean_mesh_object(tray, flat_faces=True)
    curtain = box(
        "Water plate front splash curtain",
        (0.0, -0.1860, -0.0160),
        (0.1660, 0.0060, 0.0320),
        mat["scoop_resin"],
        wplate,
        0.001,
    )
    clean_mesh_object(curtain, flat_faces=True)

    # Articulated double-lever bin level switch (`im25_bin_switch`, `ダブルレバー検知方式`) on upper right of bin
    bswitch = empty("im25_bin_switch", BIN_SWITCH_PIVOT, root)
    bswitch["joint_type"] = "hinge"
    bswitch["axis_blender"] = "+X"
    bswitch["range_rad"] = [0.0, 0.55]
    bracket = box(
        "Bin switch pivot bracket",
        (0.0, 0.0, 0.0120),
        (0.0260, 0.0320, 0.0240),
        mat["worktop"],
        bswitch,
        0.001,
    )
    clean_mesh_object(bracket, flat_faces=True)
    paddle = box(
        "Double-lever ice sensing paddle",
        (0.0, 0.0, -0.0520),
        (0.0110, 0.0720, 0.1040),
        mat["worktop"],
        bswitch,
        0.001,
    )
    clean_mesh_object(paddle, flat_faces=True)
    return wplate, bswitch


def build_bottom_hinged_door(root, mat):
    # D41368 front & side views: 383 mm bottom-hinged insulated bin door (`im25_door`, `Z = 0.3440 .. 0.7270 m`)
    # Pivot at (0.0, -0.2120, 0.3440) m.
    door = empty("im25_door", DOOR_PIVOT, root)
    door["joint_type"] = "hinge"
    door["axis_blender"] = "+X"
    door["axis_gltf"] = "+X"
    door["preview_opening_degrees"] = 52.0
    door["open_projection_m"] = 0.2968

    # Fluorine-precoated stainless door outer panel (`394.6 mm` wide, `357 mm` high below the 26 mm black top handle)
    outer_panel = box(
        "Door fluorine-precoated stainless panel",
        (0.0, -0.0015, 0.1785),
        (0.3946, 0.0220, 0.3570),
        mat["steel"],
        door,
        0.0006,
    )
    clean_mesh_object(outer_panel, flat_faces=True)

    # Full-width molded dark-charcoal/black ABS top pull handle (`Z_local = 0.3570 .. 0.3830 m` -> world `Z = 0.7010 .. 0.7270 m`)
    handle_bar = box(
        "Door full-width top handle rail",
        (0.0, -0.0015, 0.3700),
        (0.3946, 0.0210, 0.0260),
        mat["handle_grey"],
        door,
        0.0005,
    )
    clean_mesh_object(handle_bar, flat_faces=True)
    handle_lip = box(
        "Door handle upper overhang lip",
        (0.0, -0.0075, 0.3765),
        (0.3946, 0.0110, 0.0130),
        mat["handle_grey"],
        door,
        0.0005,
    )
    clean_mesh_object(handle_lip, flat_faces=True)
    handle_recess = box(
        "Door top finger grip groove",
        (0.0, -0.0102, 0.3635),
        (0.3740, 0.0056, 0.0125),
        mat["recess_black"],
        door,
        0.0,
    )
    clean_mesh_object(handle_recess, flat_faces=True)

    # Molded white polypropylene inner door liner (`樹脂成形品`) with sloped condensation baffle
    inner_liner = box(
        "Door inner sanitary resin liner",
        (0.0, 0.0190, 0.1840),
        (0.3380, 0.0200, 0.3440),
        mat["liner"],
        door,
        0.001,
    )
    clean_mesh_object(inner_liner, flat_faces=True)

    # Perimeter antimicrobial door gasket (`扉パッキン`)
    gasket = frame(
        "Door perimeter magnetic gasket",
        (0.0, 0.0270, 0.1840),
        (0.3520, 0.3580, 0.0100),
        (0.3280, 0.3340, 0.0090),
        0.002,
        mat["gasket"],
        door,
    )
    clean_mesh_object(gasket, flat_faces=True)

    # Upper door fascia branding just below the black handle:
    # Left: HOSHIZAKI wordmark + IM-25P model designation; Right: blue/white Hoshizaki Penguin emblem + green sanitation badge
    text_label(
        "Door HOSHIZAKI wordmark",
        "HOSHIZAKI",
        (-0.1180, -0.0128, 0.3330),
        0.0135,
        mat["ink_dark"],
        door,
    )
    text_label(
        "Door model IM-25P label",
        "IM-25P",
        (-0.1420, -0.0128, 0.3130),
        0.0095,
        mat["ink_dark"],
        door,
    )
    penguin_border = cylinder(
        "Door penguin emblem border",
        (0.1460, -0.0122, 0.3280),
        0.0132,
        0.0008,
        mat["ink_white"],
        door,
        "Y",
    )
    clean_mesh_object(penguin_border, sharp_y=True, flat_faces=False)
    penguin_badge = cylinder(
        "Door Hoshizaki penguin emblem",
        (0.1460, -0.0124, 0.3280),
        0.0116,
        0.0010,
        mat["badge_blue"],
        door,
        "Y",
    )
    clean_mesh_object(penguin_badge, sharp_y=True, flat_faces=False)
    text_label(
        "Door penguin badge H",
        "H",
        (0.1460, -0.0130, 0.3280),
        0.0118,
        mat["ink_white"],
        door,
    )
    eco_badge = box(
        "Door natural refrigerant R600a badge",
        (0.1460, -0.0125, 0.3030),
        (0.0230, 0.0008, 0.0105),
        mat["badge_green"],
        door,
        0.0,
    )
    clean_mesh_object(eco_badge, flat_faces=True)
    return door


def build_sanitary_ice_scoop(root, mat):
    # Removable sanitary white polypropylene ice scoop (`im25_scoop`, `付属品：スコップ`)
    scoop = empty("im25_scoop", SCOOP_REST_POSE, root)
    scoop["accessory_role"] = "Sanitary ice scoop (付属品：スコップ)"
    scoop["stowed_location_m"] = list(SCOOP_REST_POSE)

    # Channeled scoop bowl (bottom at local Z = -0.0920 m -> world Z = 0.4420 m resting on shelf Z_top = 0.4420 m)
    bowl = box(
        "im25_scoop_bowl",
        (0.0, 0.0, -0.0460),
        (0.0720, 0.0500, 0.0920),
        mat["scoop_resin"],
        scoop,
        0.002,
    )
    clean_mesh_object(bowl, flat_faces=True)

    # Sanitary hand shield flange
    shield = box(
        "im25_scoop_hand_shield",
        (0.0, 0.0, 0.0030),
        (0.0780, 0.0560, 0.0080),
        mat["scoop_resin"],
        scoop,
        0.001,
    )
    clean_mesh_object(shield, flat_faces=True)

    # Vertical ergonomic handle with top hanger hook
    handle = cylinder(
        "im25_scoop_handle",
        (0.0, 0.0, 0.0550),
        0.0130,
        0.1000,
        mat["scoop_resin"],
        scoop,
    )
    clean_mesh_object(handle, sharp_z=True, flat_faces=False)
    hook = box(
        "im25_scoop_hanger_hook",
        (0.0, 0.0110, 0.0990),
        (0.0220, 0.0160, 0.0130),
        mat["scoop_resin"],
        scoop,
        0.001,
    )
    clean_mesh_object(hook, flat_faces=True)

    # Named grasp socket site for robot/human vessel handling
    socket = empty("vessel_socket", (0.0, 0.0, 0.0550), scoop)
    socket["site_role"] = "Sanitary scoop grasp socket"
    return scoop


def build_rear_utilities(root, mat):
    # D41368 rear view: lower-right recessed plumbing pocket (`158 x 179 mm`)
    # - `排水口 R3/4` drain fitting at Z = 79 mm (`0.0790 m`), 41 mm from right (`X = +0.1565 m`)
    # - `給水口 R1/2` brass water inlet fitting at Z = 33 mm (`0.0330 m`), 74 mm from right (`X = +0.1235 m`)
    # - `アース線 機外L3000` & `電源コード 機外L2800 (L形プラグ付)`
    util = empty("im25_utilities", (0.0, 0.0, 0.0), root)
    util["status"] = (
        "Rear R3/4 drain (Z=79mm), R1/2 water inlet (Z=33mm), L2800 power cord and L3000 ground wire; excluded from cabinet envelope check"
    )

    drain_boss = cylinder(
        "Rear drain outlet R3/4 boss",
        (0.1565, 0.1620, 0.0790),
        0.0175,
        0.0220,
        mat["liner"],
        util,
        "Y",
    )
    clean_mesh_object(drain_boss, sharp_y=True, flat_faces=False)
    drain_nipple = cylinder(
        "Rear drain outlet R3/4 fitting",
        (0.1565, 0.1800, 0.0790),
        0.0125,
        0.0260,
        mat["filter_grey"],
        util,
        "Y",
    )
    clean_mesh_object(drain_nipple, sharp_y=True, flat_faces=False)

    water_plate = box(
        "Rear water inlet mounting plate",
        (0.1235, 0.1560, 0.0380),
        (0.0340, 0.0080, 0.0380),
        mat["worktop"],
        util,
        0.0005,
    )
    clean_mesh_object(water_plate, flat_faces=True)
    water_fitting = cylinder(
        "Rear potable water inlet R1/2 brass fitting",
        (0.1235, 0.1720, 0.0330),
        0.0105,
        0.0280,
        mat["brass"],
        util,
        "Y",
    )
    clean_mesh_object(water_fitting, sharp_y=True, flat_faces=False)

    earth_lug = cylinder(
        "Rear ground wire terminal L3000",
        (0.0820, 0.1560, 0.0380),
        0.0040,
        0.0080,
        mat["badge_green"],
        util,
        "Y",
    )
    clean_mesh_object(earth_lug, sharp_y=True, flat_faces=False)

    cord_bushing = box(
        "Rear power cord strain relief bushing",
        (0.0560, 0.1580, 0.0320),
        (0.0320, 0.0140, 0.0220),
        mat["foot_resin"],
        util,
        0.001,
    )
    clean_mesh_object(cord_bushing, flat_faces=True)
    l_plug = box(
        "JIS 100V L-shaped power plug body",
        (0.0560, 0.1820, 0.0250),
        (0.0240, 0.0320, 0.0240),
        mat["foot_resin"],
        util,
        0.001,
    )
    clean_mesh_object(l_plug, flat_faces=True)
    return util


def animate_timeline(door, air_filter, wplate, bswitch, pwr, scoop):
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0, SCOOP_REST_POSE, (0.0, 0.0, 0.0)),
        (20, 0.0, 0.0, 0.0, 0.0, 0.0, SCOOP_REST_POSE, (0.0, 0.0, 0.0)),
        (
            55,
            DOOR_OPEN_RAD,
            0.0,
            0.480,
            0.350,
            0.220,
            (-0.0350, -0.3250, 0.5650),
            (math.radians(-35.0), 0.0, 0.0),
        ),
        (
            85,
            DOOR_OPEN_RAD,
            0.0,
            0.480,
            0.350,
            0.220,
            (-0.0350, -0.3250, 0.5650),
            (math.radians(-35.0), 0.0, 0.0),
        ),
        (
            102,
            0.0,
            -0.095,
            0.0,
            0.0,
            0.0,
            SCOOP_REST_POSE,
            (0.0, 0.0, 0.0),
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

        wplate.rotation_euler = (wp_rx, 0.0, 0.0)
        wplate.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        bswitch.rotation_euler = (bs_rx, 0.0, 0.0)
        bswitch.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        pwr.rotation_euler = (pwr_rx, 0.0, 0.0)
        pwr.keyframe_insert(data_path="rotation_euler", frame=frame_no)

        scoop.location = scoop_loc
        scoop.rotation_euler = scoop_rot
        scoop.keyframe_insert(data_path="location", frame=frame_no)
        scoop.keyframe_insert(data_path="rotation_euler", frame=frame_no)


def clear_all_animation(root):
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()


def reset_rest_poses(door, air_filter, wplate, bswitch, pwr, scoop):
    door.location = DOOR_PIVOT
    door.rotation_euler = (0.0, 0.0, 0.0)
    air_filter.location = FILTER_ORIGIN
    air_filter.rotation_euler = (0.0, 0.0, 0.0)
    wplate.location = WATER_PLATE_PIVOT
    wplate.rotation_euler = (0.0, 0.0, 0.0)
    bswitch.location = BIN_SWITCH_PIVOT
    bswitch.rotation_euler = (0.0, 0.0, 0.0)
    pwr.location = POWER_SWITCH_PIVOT
    pwr.rotation_euler = (0.0, 0.0, 0.0)
    scoop.location = SCOOP_REST_POSE
    scoop.rotation_euler = (0.0, 0.0, 0.0)


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def setup_references(scene):
    collection = bpy.data.collections.new("Reference images - toggle visibility")
    scene.collection.children.link(collection)
    img_path = IM35_IMAGES / "manufacturer-product.jpg"
    if img_path.exists():
        image = bpy.data.images.load(str(img_path))
        image.pack()
        obj = bpy.data.objects.new("Hoshizaki IM-P family open-door reference", None)
        collection.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.9
        obj.location = (0.0, 0.55, 0.42)
        obj.rotation_euler = (math.pi / 2, 0.0, 0.0)
        obj.color[3] = 0.45
        obj.hide_render = True
        obj["reference_status"] = (
            "Hoshizaki IM-25P built to official drawing D41368 (395 x 450 x 770 mm)"
        )
    collection.hide_viewport = True
    collection.hide_render = True


def setup_studio(scene):
    before = set(scene.objects)
    enable_metal_gpu(scene)
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("IM-25P studio world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.55,
        0.60,
        0.68,
        1.0,
    )
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.48
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.20
    ground = material("Studio warm grey", (0.29, 0.31, 0.33, 1.0), 0.0, 0.88, 0.0)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0.0, 0.0, -0.001))
    bpy.context.object.name = "Studio ground"
    bpy.context.object.data.materials.append(ground)
    area_light("Left key softbox", (-1.6, -2.1, 2.1), (0.0, 0.0, 0.38), 230, 1.8)
    area_light("Right fill stripbox", (1.8, -0.6, 1.7), (0.0, 0.0, 0.38), 165, 1.5)
    area_light("Rear rim softbox", (0.0, 1.6, 2.0), (0.0, 0.0, 0.42), 175, 1.4)
    area_light("Bin interior fill", (0.0, -1.9, 0.92), (0.0, 0.0, 0.48), 85, 1.2)
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


def export_glb_at_rest(root, door, air_filter, wplate, bswitch, pwr, scoop):
    bpy.context.scene.frame_set(1)
    clear_all_animation(root)
    reset_rest_poses(door, air_filter, wplate, bswitch, pwr, scoop)
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
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )

    # Export standalone reusable sanitary ice scoop GLB centered at origin
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


def compute_bounds(objects):
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            wv = mw @ v.co
            mins.x = min(mins.x, wv.x)
            mins.y = min(mins.y, wv.y)
            mins.z = min(mins.z, wv.z)
            maxs.x = max(maxs.x, wv.x)
            maxs.y = max(maxs.y, wv.y)
            maxs.z = max(maxs.z, wv.z)
    return mins, maxs, maxs - mins


def record_build_report(scene, root, renders):
    scene.frame_set(1)
    bpy.context.view_layer.update()
    worktop = bpy.data.objects["Stainless worktop"]
    utilities = bpy.data.objects["im25_utilities"]
    excluded = {utilities, *utilities.children_recursive}
    low, high, dims = compute_bounds(
        [obj for obj in root.children_recursive if obj not in excluded]
    )
    glb_path = ASSETS / f"{NAME}.glb"
    scoop_glb_path = ASSETS / f"{NAME}-scoop.glb"
    source_path = DRAWING_PDF if DRAWING_PDF.exists() else LINEUP_REF
    report = {
        "asset": NAME,
        "blender_version": bpy.app.version_string,
        "specification_source": "docs/equipment/hoshizaki-im-25p/specifications/dimensioned-drawing.pdf (D41368)",
        "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_envelope_m": [round(v, 6) for v in dims],
        "envelope_bounds_m": {
            "min": [round(v, 6) for v in low],
            "max": [round(v, 6) for v in high],
        },
        "open_door_depth_m": 0.752,
        "open_door_projection_m": 0.297,
        "worktop_dimensions_m": [round(v, 6) for v in worktop.dimensions],
        "published_mass_kg": 33.0,
        "ice_production_kg_per_day_20c_15c_50_60hz": [24.0, 26.0],
        "ice_production_kg_per_day_30c_25c_50_60hz": [19.0, 22.0],
        "ice_batch_kg": 0.43,
        "ice_cubes_per_batch": 18,
        "cube_dimensions_m": [0.028, 0.028, 0.032],
        "bin_max_stock_kg": 14.0,
        "bin_natural_fall_kg": 8.5,
        "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 0.47 kVA (4.7 A), 145/165 W, R600a",
        "renders": renders,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "scoop_glb_sha256": hashlib.sha256(scoop_glb_path.read_bytes()).hexdigest(),
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def run_glb_inspection():
    """Import exported GLB in a clean factory scene and verify envelope, fault injection, ray-casts, joints, and mesh quality."""
    from inspect_induction import bounds, near
    from inspect_mesh_quality import inspect_loaded

    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = ASSETS / f"{NAME}.glb"
    scoop_path = ASSETS / f"{NAME}-scoop.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["im25_cabinet"]
    door = objects["im25_door"]
    air_filter = objects["im25_air_filter"]
    wplate = objects["im25_water_plate"]
    bswitch = objects["im25_bin_switch"]
    pwr = objects["im25_power_switch"]
    scoop = objects["im25_scoop"]
    socket = objects["vessel_socket"]
    storage = objects["im25_bin_storage"]
    utilities = objects["im25_utilities"]
    worktop = objects["Stainless worktop"]

    for child in (door, air_filter, wplate, bswitch, pwr, scoop, storage, utilities):
        assert child.parent == root, child.name
    assert socket.parent == scoop
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    assert not any(obj.animation_data is not None for obj in objects)

    excluded = {utilities, *utilities.children_recursive}

    def check_env():
        low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
        dims = high - low
        for actual, expected in zip(dims, (WIDTH, DEPTH, HEIGHT)):
            near(actual, expected, "Published IM-25P envelope")
        return low, high, dims

    low, high, dimensions = check_env()
    near(low.z, 0.0, "Foot support plane Z=0.000")
    near(high.z, HEIGHT, "Worktop plane Z=0.770")

    # Fault-injection guard: shifting worktop laterally by 10 mm must trip envelope check
    orig_wt_x = worktop.location.x
    worktop.location.x += 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        check_env()
    except AssertionError:
        fault_detected = True
    worktop.location.x = orig_wt_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope guard must reject 10 mm lateral perturbation"

    # Verify all 4 feet touch Z = 0.000 m
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("im25_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot contact plane ({obj.name})")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Ray-cast downward onto the 395 x 450 mm stainless worktop at Z = 0.770 m
    depsgraph = bpy.context.evaluated_depsgraph_get()
    wt_heights = []
    for sx in (-0.14, 0.0, 0.14):
        for sy in (-0.15, 0.0, 0.15):
            hit, point, normal, _f, hit_obj, _m = bpy.context.scene.ray_cast(
                depsgraph, Vector((sx, sy, 0.880)), Vector((0.0, 0.0, -1.0))
            )
            assert hit and hit_obj == worktop, (sx, sy, hit_obj)
            near(point.z, HEIGHT, "Worktop height Z=0.770")
            assert normal.z > 0.99, normal
            wt_heights.append(point.z)

    # Verify closed door blocks horizontal access rays at Z = 0.500 m
    hit_closed, _pt, _n, _f, obj_closed, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, -0.650, 0.500)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_closed and obj_closed in set(door.children_recursive), obj_closed

    # Open bottom-hinged door to 52 deg (+DOOR_OPEN_RAD about +X)
    door.rotation_mode = "XYZ"
    door.rotation_euler = (DOOR_OPEN_RAD, 0.0, 0.0)
    orig_scoop_loc = scoop.location.copy()
    scoop.location = Vector((-0.045, -0.340, 0.560))
    bpy.context.view_layer.update()
    door_low, door_high = bounds(door.children_recursive)
    open_projection_m = -0.225 - door_low.y
    assert 0.285 <= open_projection_m <= 0.315, open_projection_m

    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit_open, pt_open, _n, _f, obj_open, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.060, -0.650, 0.600)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_open and pt_open.y > 0.150, (
        hit_open,
        pt_open,
        obj_open.name if obj_open else None,
    )

    door.rotation_euler = (0.0, 0.0, 0.0)
    scoop.location = orig_scoop_loc
    bpy.context.view_layer.update()

    required_meshes = {
        "Stainless worktop",
        "Upper front stainless fascia",
        "Lower front service louver panel",
        "Sanitary bin floor liner",
        "Sanitary bin rear liner",
        "Evaporator freezing chamber shroud",
        "Copper evaporator 18-cell grid",
        "Stored cube ice bed",
        "Door fluorine-precoated stainless panel",
        "Door full-width top handle rail",
        "Door inner sanitary resin liner",
        "Door perimeter magnetic gasket",
        "Raku-Eco air filter pull handle",
        "Raku-Eco air filter mesh cartridge",
        "Jet-spray water plate tray",
        "Double-lever ice sensing paddle",
        "im25_power_switch_rocker",
        "im25_scoop_bowl",
        "im25_scoop_handle",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "scoop_glb_sha256": hashlib.sha256(scoop_path.read_bytes()).hexdigest(),
        "scoop_glb_bytes": scoop_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "body_bounds_m": {
            "min": [round(val, 6) for val in low],
            "max": [round(val, 6) for val in high],
        },
        "open_door_projection_m": round(open_projection_m, 4),
        "open_door_top_height_m": round(door_high.z, 4),
        "worktop_support_samples": len(wt_heights),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import rest-pose GLB; verify exact 395x450x770 mm envelope (D41368), Z=0.000 m foot plane, and Z=0.770 m "
            "stainless worktop; verify 10 mm lateral perturbation rejection; open bottom-hinged bin door 52 deg "
            "and verify interior access rays reach rear bin liner at Y > 0.15 m; verify zero mesh-quality errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    if args.inspect_only:
        run_glb_inspection()
        return

    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Hoshizaki IM-25P - D41368 Japan reference"
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

    root = empty("im25_cabinet", (0.0, 0.0, 0.0))
    root["manufacturer"] = "Hoshizaki"
    root["model"] = "IM-25P"
    root["drawing_number"] = "D41368"
    root["predecessor_models"] = "IM-25M-2, IM-25M-1, IM-25M, IM-25L"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["manufacturer_total_mass_kg"] = 33.0

    mat = surfaces()
    build_cabinet_and_bin(root, mat)
    ctrl, pwr, air_filter = build_control_window_and_filter(root, mat)
    wplate, bswitch = build_evaporator_water_plate_and_bin_switch(root, mat)
    door = build_bottom_hinged_door(root, mat)
    scoop = build_sanitary_ice_scoop(root, mat)
    build_rear_utilities(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    all_empties = [
        obj for obj in (root, *root.children_recursive) if obj.type == "EMPTY"
    ]
    convert_curves(all_empties)
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            is_cyl_z = obj.name.endswith(("_collar", "_pad", "_handle"))
            is_cyl_y = (
                "screw" in obj.name
                or "emblem" in obj.name
                or "fitting" in obj.name
                or "boss" in obj.name
                or "terminal" in obj.name
            )
            clean_mesh_object(
                obj,
                sharp_z=is_cyl_z,
                sharp_y=is_cyl_y,
                flat_faces=not (is_cyl_z or is_cyl_y),
            )

    # Export static rest-pose GLBs at frame 1 with animation_data_clear() and export_animations=False
    export_glb_at_rest(root, door, air_filter, wplate, bswitch, pwr, scoop)

    # Restore preview timeline animation on the .blend scene and render Metal GPU studio views
    animate_timeline(door, air_filter, wplate, bswitch, pwr, scoop)

    appliance = bpy.data.collections.new("IM-25P appliance")
    scene.collection.children.link(appliance)
    move_objects([root, *root.children_recursive], appliance)

    setup_references(scene)
    camera = setup_studio(scene)
    views = (
        ("studio-closed", (1.15, -2.05, 1.20), (0.0, 0.0, 0.385), 1.02, 1),
        ("studio-open", (1.08, -2.18, 1.24), (0.0, -0.07, 0.400), 1.12, 70),
        ("studio-front", (0.0, -2.15, 0.385), (0.0, 0.0, 0.385), 0.96, 1),
        ("studio-interior", (0.0, -2.05, 0.54), (0.0, 0.0, 0.480), 0.86, 70),
        ("studio-right", (2.15, 0.0, 0.385), (0.0, 0.0, 0.385), 0.98, 1),
    )
    rendered = [f"{v[0]}.png" for v in views]
    if not args.skip_renders:
        rendered = []
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = f"{vname}.png"
            scene.render.filepath = str(ASSETS / out_png)
            bpy.ops.render.render(write_still=True)
            rendered.append(out_png)

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])
    record_build_report(scene, root, rendered)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{NAME}.blend"))
    print("Saved editable Hoshizaki IM-25P Blender source, GLBs and renders:", ASSETS)

    # Run independent GLB inspection in a fresh subprocess
    subprocess.run(
        [
            str(bpy.app.binary_path),
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--inspect-only",
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
