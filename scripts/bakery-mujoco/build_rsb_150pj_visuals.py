"""Build the Rinnai RSB-150PJ commercial 1-burner countertop gas stove in Blender 5.2.

Reference sources (archived in docs/equipment/rinnai-rsb-150pj/):
- Official Rinnai 1:5 scale engineering drawing (リンナイ 業務用機器 外観図 RSB-150PJ, 10.09.17(改)):
  - Overall dimensions: W 330 mm × D 325 mm × H 111 mm (0.330 × 0.325 × 0.111 m)
  - Stamped stainless-steel / painted sheet-steel body: W 299 mm × D 279 mm × H 69 mm
    - Rubber feet clearance: 18 mm (Z = 0.000..0.018 m)
    - Lower painted steel chassis: Z = 0.018..0.052 m
    - Stamped SUS430 top plate lip: 17 mm (Z = 0.052..0.069 m)
  - 6-prong porcelain-enameled trivet (ごとく 010-361-000):
    - Horizontal cookware support plane: Z = 0.106 m (106 mm)
    - Outer prong retention tip height: Z = 0.111 m (111 mm)
    - Front-to-rear prong span: 311 mm (16 mm rear overhang)
    - Left-to-right prong span reaches X = -0.1565 m (total width 330 mm with +24 mm right hose barb)
  - Forged brass burner head (バーナーキャップ 151-420-000):
    - Outer diameter: Ø75 mm (radius 37.5 mm) centered at (X = -0.010, Y = 0.000)
      (159.5 mm from right body edge X = +0.1495 m)
    - 4 inward radial bridge lugs (0°, 90°, 180°, 270°) with 8 inner flame ports + 24 outer ring flame ports
  - Thermocouple flame-failure safety sensor (立消え安全装置 炎検知部) + ceramic piezo igniter electrode
  - Push-and-turn piezo ignition / flame control knob (器具栓つまみ 021-650-000):
    - Centered 113.5 mm right of burner centerline (X = +0.1035 m), Z = 0.035 m
    - Projects 30 mm forward of the 279 mm body (Y = -0.1695..-0.1395 m)
  - Right-side swiveling Ø9.5 mm gas rubber hose barb (ホースエンド):
    - Projects 24 mm right of the 299 mm body (X = +0.1495..+0.1735 m), 60 mm rearward barb length
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
from mathutils import Euler, Matrix, Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = REPO_ROOT / "assets" / "bakery-mujoco" / "rinnai-rsb-150pj"
REF_DIR = REPO_ROOT / "docs" / "equipment" / "rinnai-rsb-150pj"

# Exact Rinnai 1:5 engineering drawing dimensions (metres)
OVERALL_W = 0.3300
OVERALL_D = 0.3250
OVERALL_H = 0.1110

BODY_W = 0.2990          # X in [-0.1495, +0.1495]
BODY_D = 0.2790          # Y in [-0.1395, +0.1395]
FOOT_H = 0.0180          # Z in [0.000, 0.018]
CHASSIS_TOP_Z = 0.0520   # Z in [0.018, 0.052]
DECK_TOP_Z = 0.0690      # Z in [0.052, 0.069] (17 mm top lip)
PAN_REST_Z = 0.1060      # Horizontal pan support surface (106 mm)
TRIVET_TIP_Z = 0.1110    # Outer trivet lip top (111 mm)

# Burner center is 159.5 mm from right body edge (+0.1495 - 0.1595 = -0.0100 m)
BURNER_X = -0.0100
BURNER_Y = 0.0000
BURNER_DIAM = 0.0750
BURNER_R = BURNER_DIAM / 2.0

# Knob center is 113.5 mm right of burner center (-0.0100 + 0.1135 = +0.1035 m), Z = 0.035 m
KNOB_X = BURNER_X + 0.1135
KNOB_Z = 0.0350
KNOB_FRONT_Y = -BODY_D / 2.0 - 0.0300  # -0.1695 m (30 mm projection)

# Right-side gas hose nozzle projects 24 mm beyond +0.1495 m -> X_max = +0.1735 m
HOSE_MAX_X = BODY_W / 2.0 + 0.0240     # +0.1735 m
# Leftmost trivet prong tip reaches X_min = +0.1735 - 0.3300 = -0.1565 m (exact 330 mm total width)
TRIVET_MIN_X = HOSE_MAX_X - OVERALL_W  # -0.1565 m
# Rearmost trivet prong tip reaches Y_max = +0.1395 + 0.0160 = +0.1555 m (exact 325 mm total depth)
TRIVET_MAX_Y = BODY_D / 2.0 + 0.0160   # +0.1555 m
TRIVET_MIN_Y = TRIVET_MAX_Y - 0.3110   # -0.1555 m (311 mm span)

# Foot centers from engineering drawing:
# Left-to-right span = 241 mm, with right foot 130.5 mm right of burner center (+0.1205 m)
# and left foot 110.5 mm left of burner center (-0.1205 m).
# Front-to-rear span = 221 mm, with front foot 113 mm in front of burner center (-0.1130 m)
# and rear foot 108 mm behind burner center (+0.1080 m).
FOOT_X_LEFT = BURNER_X - 0.1105        # -0.1205 m
FOOT_X_RIGHT = BURNER_X + 0.1305       # +0.1205 m
FOOT_Y_FRONT = BURNER_Y - 0.1130       # -0.1130 m
FOOT_Y_REAR = BURNER_Y + 0.1080        # +0.1080 m


def clean_mesh_object(obj: bpy.types.Object, recalc_normals: bool = True) -> bpy.types.Object:
    """Triangulate, weld within 1 um, and remove degenerate or duplicate triangles."""
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
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
    if recalc_normals and bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def generate_front_panel_texture(out_path: Path) -> bpy.types.Image:
    """Create a 512x128 procedural front-panel texture in Blender (dark metallic grain + dial arc + stop dot)."""
    width, height = 512, 128
    image = bpy.data.images.new("RSB front silkscreen texture", width=width, height=height)
    pixels = [0.0] * (width * height * 4)

    # Front panel strip spans X in [-0.122, +0.126] (0.248 m), Z in [0.020, 0.050] (0.030 m).
    # Knob center is at X = +0.1035 m -> u_knob = (0.1035 - (-0.122)) / 0.248 = 0.9093, v_knob = 0.50.
    fx0, fx1 = -0.1220, 0.1260
    fz0, fz1 = 0.0200, 0.0500

    for py in range(height):
        v = (py + 0.5) / height
        z_m = fz0 + v * (fz1 - fz0)
        grain = 0.004 * math.sin(py * 1.7)
        for px in range(width):
            u = (px + 0.5) / width
            x_m = fx0 + u * (fx1 - fx0)

            # Base dark charcoal metallic enamel
            r = 0.145 + grain
            g = 0.160 + grain
            b = 0.175 + grain

            # Border framing line near top and bottom of front panel strip
            if abs(z_m - (fz1 - 0.0018)) < 0.0005 or abs(z_m - (fz0 + 0.0018)) < 0.0005:
                r, g, b = 0.28, 0.30, 0.33

            # Dial markings around KNOB_X (+0.1035), KNOB_Z (0.0350)
            dx = x_m - KNOB_X
            dz = z_m - KNOB_Z
            dist = math.hypot(dx, dz)
            ang_deg = math.degrees(math.atan2(dz, dx))  # +90 is top ('止'), 180/-180 is left ('開')

            # Subtle silver dial bezel ring at r = 19.5..21.0 mm
            if 0.0195 <= dist <= 0.0208:
                r, g, b = 0.62, 0.65, 0.68

            # White top '止' registration dot at (dx = 0, dz = +0.0125)
            if math.hypot(dx, dz - 0.0125) <= 0.0015:
                r, g, b = 0.94, 0.95, 0.96

            # Orange-red flame taper arc from top-left (102 deg) counter-clockwise to left-bottom (-165 deg)
            in_ccw_arc = (ang_deg >= 102.0) or (ang_deg <= -165.0)
            if in_ccw_arc and 0.0210 <= dist <= 0.0232:
                r, g, b = 0.92, 0.36, 0.14

            idx = (py * width + px) * 4
            pixels[idx] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b
            pixels[idx + 3] = 1.0

    image.pixels.foreach_set(pixels)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.filepath_raw = str(out_path)
    image.file_format = "PNG"
    image.save()
    image.pack()
    return image


def make_material(
    name: str,
    base_color: tuple[float, float, float, float],
    metallic: float = 0.0,
    roughness: float = 0.4,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    assert bsdf is not None
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def make_textured_material(
    name: str,
    image: bpy.types.Image,
    metallic: float = 0.30,
    roughness: float = 0.42,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def create_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    material: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = Vector(location)
    obj.data.materials.append(material)
    bpy.context.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return clean_mesh_object(obj, recalc_normals=True)


def add_font_label(
    name: str,
    text: str,
    location: tuple[float, float, float],
    rotation_deg: tuple[float, float, float],
    size: float,
    material: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Create a 3D font curve, convert it to a clean mesh, and parent to `parent`."""
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = text
    curve.font = bpy.data.fonts["RSB label font"]
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = 0.00025
    curve.resolution_u = 2
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(location)
    obj.rotation_euler = Euler(tuple(math.radians(d) for d in rotation_deg), "XYZ")
    obj.data.materials.append(material)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    obj.select_set(False)
    obj.parent = parent
    return clean_mesh_object(obj, recalc_normals=True)


def add_rounded_rect_prism(
    bm: bmesh.types.BMesh,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    z0: float,
    z1: float,
    radius: float,
    corner_segs: int = 8,
) -> None:
    """Add a closed rounded-corner rectangular prism from z0 to z1."""
    r = min(radius, (x1 - x0) * 0.45, (y1 - y0) * 0.45)
    centers = [
        (x1 - r, y1 - r, 0.0),
        (x0 + r, y1 - r, math.pi * 0.5),
        (x0 + r, y0 + r, math.pi),
        (x1 - r, y0 + r, math.pi * 1.5),
    ]
    ring_bot = []
    ring_top = []
    for cx, cy, a_start in centers:
        for i in range(corner_segs):
            a = a_start + (math.pi * 0.5) * (i / corner_segs)
            px = cx + r * math.cos(a)
            py = cy + r * math.sin(a)
            ring_bot.append(bm.verts.new((px, py, z0)))
            ring_top.append(bm.verts.new((px, py, z1)))
    n = len(ring_bot)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([ring_bot[i], ring_bot[j], ring_top[j], ring_top[i]])
    bm.faces.new(list(reversed(ring_bot)))
    bm.faces.new(ring_top)


def build_stamped_stainless_top_plate(
    mat_sus: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the 299 × 279 mm stamped SUS430 stainless top plate (Z = 0.052..0.069 m) with sunken drip basin."""
    bm = bmesh.new()
    x0, x1 = -BODY_W / 2.0, BODY_W / 2.0
    y0, y1 = -BODY_D / 2.0, BODY_D / 2.0
    z_skirt = CHASSIS_TOP_Z
    z_deck = DECK_TOP_Z
    corner_r = 0.026
    segs_per_corner = 12
    n_ring = segs_per_corner * 4

    centers = [
        (x1 - corner_r, y1 - corner_r, 0.0),
        (x0 + corner_r, y1 - corner_r, math.pi * 0.5),
        (x0 + corner_r, y0 + corner_r, math.pi),
        (x1 - corner_r, y0 + corner_r, math.pi * 1.5),
    ]
    outer_pts: list[tuple[float, float]] = []
    for cx, cy, a0 in centers:
        for i in range(segs_per_corner):
            a = a0 + (math.pi * 0.5) * (i / segs_per_corner)
            outer_pts.append((cx + corner_r * math.cos(a), cy + corner_r * math.sin(a)))

    # Closed sheet profile (top surface + underside return so the mesh is watertight):
    rings: list[list[bmesh.types.BMVert]] = [[] for _ in range(9)]
    for px, py in outer_pts:
        ang = math.atan2(py - BURNER_Y, px - BURNER_X)
        ca, sa = math.cos(ang), math.sin(ang)
        sq_factor = 1.0 + 0.10 * (abs(ca * sa) * 2.0)
        r3 = 0.098 * sq_factor
        r4 = 0.084 * sq_factor
        r5 = 0.058
        r6 = 0.044

        rings[0].append(bm.verts.new((px, py, z_skirt)))
        rings[1].append(bm.verts.new((px * 0.992, py * 0.992, z_deck - 0.0022)))
        rings[2].append(bm.verts.new((px * 0.965, py * 0.965, z_deck)))
        rings[3].append(bm.verts.new((BURNER_X + r3 * ca, BURNER_Y + r3 * sa, z_deck - 0.0008)))
        rings[4].append(bm.verts.new((BURNER_X + r4 * ca, BURNER_Y + r4 * sa, 0.0595)))
        rings[5].append(bm.verts.new((BURNER_X + r5 * ca, BURNER_Y + r5 * sa, 0.0560)))
        rings[6].append(bm.verts.new((BURNER_X + r6 * ca, BURNER_Y + r6 * sa, 0.0615)))
        # Inner underside return to close the stamped sheet
        rings[7].append(bm.verts.new((BURNER_X + r6 * ca, BURNER_Y + r6 * sa, z_skirt)))
        rings[8].append(bm.verts.new((px, py, z_skirt)))

    for r_idx in range(len(rings) - 1):
        r_a = rings[r_idx]
        r_b = rings[r_idx + 1]
        for i in range(n_ring):
            j = (i + 1) % n_ring
            bm.faces.new([r_a[i], r_a[j], r_b[j], r_b[i]])

    return create_mesh_object("rsb_stainless_top_plate", bm, mat_sus, parent=parent)


def build_lower_chassis(
    mat_chassis: bpy.types.Material,
    mat_front_label: bpy.types.Material,
    mat_steel: bpy.types.Material,
    mat_silk: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the dark charcoal painted sheet-steel lower chassis (Z = 0.018..0.0525 m) and front label panel."""
    bm = bmesh.new()
    add_rounded_rect_prism(
        bm,
        x0=-BODY_W / 2.0 + 0.0025,
        x1=BODY_W / 2.0 - 0.0025,
        y0=-BODY_D / 2.0 + 0.0025,
        y1=BODY_D / 2.0 - 0.0025,
        z0=FOOT_H,
        z1=CHASSIS_TOP_Z + 0.001,
        radius=0.023,
        corner_segs=8,
    )
    chassis = create_mesh_object("rsb_lower_chassis", bm, mat_chassis, parent=parent)

    # Front silkscreened face plate with UV mapping for dial markings
    bm_front = bmesh.new()
    fx0, fx1 = -0.1220, 0.1260
    fy0, fy1 = -BODY_D / 2.0 + 0.0014, -BODY_D / 2.0 + 0.0026
    fz0, fz1 = 0.0200, 0.0500
    add_rounded_rect_prism(bm_front, fx0, fx1, fy0, fy1, fz0, fz1, radius=0.0015, corner_segs=3)
    uv_layer = bm_front.loops.layers.uv.new("UVMap")
    for face in bm_front.faces:
        for loop in face.loops:
            co = loop.vert.co
            u = max(0.0, min(1.0, (co.x - fx0) / (fx1 - fx0)))
            v = max(0.0, min(1.0, (co.z - fz0) / (fz1 - fz0)))
            loop[uv_layer].uv = (u, v)
    create_mesh_object("rsb_front_nameplate", bm_front, mat_front_label, parent=parent)

    # Crisp 3D silkscreen typography on front panel: Rinnai, RSB-150PJ, 止 (Stop), 開 (Open)
    fy_text = -BODY_D / 2.0 + 0.0011
    add_font_label(
        "rsb_brand_label",
        "Rinnai  RSB-150PJ",
        (0.0150, fy_text, 0.0320),
        (90.0, 0.0, 0.0),
        0.0072,
        mat_silk,
        parent,
    )
    add_font_label(
        "rsb_dial_stop_label",
        "止",
        (KNOB_X, fy_text, KNOB_Z + 0.0135),
        (90.0, 0.0, 0.0),
        0.0052,
        mat_silk,
        parent,
    )
    add_font_label(
        "rsb_dial_open_label",
        "開",
        (KNOB_X - 0.0245, fy_text, KNOB_Z - 0.0015),
        (90.0, 0.0, 0.0),
        0.0052,
        mat_silk,
        parent,
    )

    # Left-side caution label plate and rear rating plate (銘板) + 3 stainless retaining screw heads
    bm_plates = bmesh.new()
    add_rounded_rect_prism(
        bm_plates,
        x0=-BODY_W / 2.0 + 0.0015,
        x1=-BODY_W / 2.0 + 0.0030,
        y0=-0.065,
        y1=0.045,
        z0=0.023,
        z1=0.047,
        radius=0.002,
        corner_segs=3,
    )
    add_rounded_rect_prism(
        bm_plates,
        x0=-0.055,
        x1=0.055,
        y0=BODY_D / 2.0 - 0.0030,
        y1=BODY_D / 2.0 - 0.0015,
        z0=0.024,
        z1=0.046,
        radius=0.002,
        corner_segs=3,
    )
    for sx, sy, sz in [
        (0.0, -BODY_D / 2.0 + 0.0005, 0.056),
        (-BODY_W / 2.0 + 0.0005, -0.045, 0.057),
        (BODY_W / 2.0 - 0.0005, 0.045, 0.057),
    ]:
        m = Matrix.Translation((sx, sy, sz))
        bmesh.ops.create_uvsphere(bm_plates, u_segments=12, v_segments=8, radius=0.0028, matrix=m)
    create_mesh_object("rsb_rating_and_screws", bm_plates, mat_steel, parent=parent)
    return chassis


def build_rubber_feet(mat_rubber: bpy.types.Material, parent: bpy.types.Object) -> list[bpy.types.Object]:
    """Build the 4 non-slip elastomer feet resting on Z = 0.000..0.018 m."""
    placements = [
        ("rsb_foot_left_front", FOOT_X_LEFT, FOOT_Y_FRONT),
        ("rsb_foot_right_front", FOOT_X_RIGHT, FOOT_Y_FRONT),
        ("rsb_foot_left_rear", FOOT_X_LEFT, FOOT_Y_REAR),
        ("rsb_foot_right_rear", FOOT_X_RIGHT, FOOT_Y_REAR),
    ]
    feet: list[bpy.types.Object] = []
    for name, fx, fy in placements:
        bm = bmesh.new()
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            cap_tris=False,
            segments=24,
            radius1=0.0155,
            radius2=0.0135,
            depth=0.005,
            matrix=Matrix.Translation((0.0, 0.0, 0.0025)),
        )
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            cap_tris=False,
            segments=24,
            radius1=0.0125,
            radius2=0.0145,
            depth=0.014,
            matrix=Matrix.Translation((0.0, 0.0, 0.0115)),
        )
        feet.append(create_mesh_object(name, bm, mat_rubber, parent=parent, location=(fx, fy, 0.0)))
    return feet


def build_brass_burner_and_sensors(
    mat_brass: bpy.types.Material,
    mat_cast_iron: bpy.types.Material,
    mat_ceramic: bpy.types.Material,
    mat_steel: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the Ø75 mm forged brass burner cap (151-420-000), venturi body, piezo igniter, and thermocouple."""
    bm_body = bmesh.new()
    bmesh.ops.create_cone(
        bm_body,
        cap_ends=True,
        cap_tris=False,
        segments=36,
        radius1=0.033,
        radius2=0.036,
        depth=0.028,
        matrix=Matrix.Translation((BURNER_X, BURNER_Y, 0.052)),
    )
    rot_venturi = Euler((0.0, math.radians(86.0), math.radians(-38.0)), "XYZ").to_matrix().to_4x4()
    rot_venturi.translation = Vector((BURNER_X + 0.048, BURNER_Y - 0.058, 0.038))
    bmesh.ops.create_cone(
        bm_body,
        cap_ends=True,
        cap_tris=False,
        segments=20,
        radius1=0.014,
        radius2=0.018,
        depth=0.115,
        matrix=rot_venturi,
    )
    create_mesh_object("rsb_burner_venturi", bm_body, mat_cast_iron, parent=parent)

    # Forged brass burner cap (Ø75 mm = radius 0.0375 m, with central bore and 4 inward radial bridge lugs)
    bm_cap = bmesh.new()
    n_seg = 48
    r_outer_bot = 0.0360
    r_outer_top = BURNER_R  # 0.0375 m (Ø75 mm)
    r_inner_top = 0.0185
    r_inner_bot = 0.0175
    z_bot = 0.0645
    z_mid = 0.0695
    z_top = 0.0755

    ring_ob = []
    ring_om = []
    ring_ot = []
    ring_it = []
    ring_ib = []
    for i in range(n_seg):
        a = 2.0 * math.pi * i / n_seg
        ca, sa = math.cos(a), math.sin(a)
        serr = 0.0012 if (i % 2 == 0) else 0.0
        ring_ob.append(bm_cap.verts.new((BURNER_X + (r_outer_bot - serr) * ca, BURNER_Y + (r_outer_bot - serr) * sa, z_bot)))
        ring_om.append(bm_cap.verts.new((BURNER_X + (r_outer_top - serr * 0.6) * ca, BURNER_Y + (r_outer_top - serr * 0.6) * sa, z_mid)))
        ring_ot.append(bm_cap.verts.new((BURNER_X + (r_outer_top - 0.0012) * ca, BURNER_Y + (r_outer_top - 0.0012) * sa, z_top)))
        ring_it.append(bm_cap.verts.new((BURNER_X + r_inner_top * ca, BURNER_Y + r_inner_top * sa, z_top - 0.0010)))
        ring_ib.append(bm_cap.verts.new((BURNER_X + r_inner_bot * ca, BURNER_Y + r_inner_bot * sa, z_bot)))

    for r1, r2 in [(ring_ob, ring_om), (ring_om, ring_ot), (ring_ot, ring_it), (ring_it, ring_ib), (ring_ib, ring_ob)]:
        for i in range(n_seg):
            j = (i + 1) % n_seg
            bm_cap.faces.new([r1[i], r1[j], r2[j], r2[i]])

    # 4 inward radial bridge lugs (at 0°, 90°, 180°, 270°) matching part 151-420-000 diagram
    for lug_deg in (0.0, 90.0, 180.0, 270.0):
        rot = Matrix.Rotation(math.radians(lug_deg), 4, "Z")
        trans = Matrix.Translation((BURNER_X, BURNER_Y, 0.0715)) @ rot @ Matrix.Translation((0.0225, 0.0, 0.0))
        bmesh.ops.create_cube(bm_cap, size=1.0, matrix=trans @ Matrix.Diagonal((0.013, 0.011, 0.007, 1.0)))

    burner_cap = bpy.data.objects.new("rsb_burner_cap", None)
    bpy.context.collection.objects.link(burner_cap)
    burner_cap.parent = parent
    create_mesh_object("rsb_burner_cap_mesh", bm_cap, mat_brass, parent=burner_cap)

    # White alumina ceramic piezo igniter insulator
    bm_cer = bmesh.new()
    bmesh.ops.create_cone(
        bm_cer,
        cap_ends=True,
        cap_tris=False,
        segments=16,
        radius1=0.0042,
        radius2=0.0036,
        depth=0.018,
        matrix=Matrix.Translation((BURNER_X - 0.039, BURNER_Y + 0.015, 0.065)),
    )
    create_mesh_object("rsb_piezo_insulator", bm_cer, mat_ceramic, parent=parent)

    # Thermocouple flame-failure sensor probe (立消え安全装置 炎検知部) + spark electrode wire tip
    bm_probe = bmesh.new()
    bmesh.ops.create_cone(
        bm_probe,
        cap_ends=True,
        cap_tris=False,
        segments=16,
        radius1=0.0032,
        radius2=0.0016,
        depth=0.022,
        matrix=Matrix.Translation((BURNER_X + 0.038, BURNER_Y - 0.016, 0.068)),
    )
    bmesh.ops.create_cone(
        bm_probe,
        cap_ends=True,
        cap_tris=False,
        segments=12,
        radius1=0.0015,
        radius2=0.0012,
        depth=0.008,
        matrix=Matrix.Translation((BURNER_X - 0.038, BURNER_Y + 0.015, 0.075)),
    )
    create_mesh_object("rsb_thermocouple_probe", bm_probe, mat_steel, parent=parent)
    return burner_cap


def build_six_prong_trivet(
    mat_trivet: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the removable 6-prong black porcelain-enameled trivet (ごとく 010-361-000).

    - Rounded-square base ring sits on the top plate recess at Z = 0.069..0.075 m
    - 6 radial pot-support fins:
      - Front center (-Y) and Rear center (+Y), spanning 311 mm (Y in [-0.1555, +0.1555] m)
      - 2 left-angled fins reaching exact X = -0.1565 m (total width with +0.1735 m hose barb is 0.3300 m)
      - 2 right-angled fins symmetric around the burner center
    - Horizontal cookware bearing plane at Z = 0.1060 m (106 mm) across r = 0.056..0.145 m
    - Outer vertical retention lip tips at Z = 0.1110 m (111 mm)
    """
    bm = bmesh.new()

    frame_half_x = 0.105
    frame_half_y = 0.105
    frame_w = 0.016
    corner_r = 0.028
    segs = 8
    centers = [
        (BURNER_X + frame_half_x - corner_r, BURNER_Y + frame_half_y - corner_r, 0.0),
        (BURNER_X - frame_half_x + corner_r, BURNER_Y + frame_half_y - corner_r, math.pi * 0.5),
        (BURNER_X - frame_half_x + corner_r, BURNER_Y - frame_half_y + corner_r, math.pi),
        (BURNER_X + frame_half_x - corner_r, BURNER_Y - frame_half_y + corner_r, math.pi * 1.5),
    ]
    ob_ring, ot_ring, it_ring, ib_ring = [], [], [], []
    for cx, cy, a0 in centers:
        for i in range(segs):
            a = a0 + (math.pi * 0.5) * (i / segs)
            ca, sa = math.cos(a), math.sin(a)
            ox = cx + corner_r * ca
            oy = cy + corner_r * sa
            ix = cx + (corner_r - frame_w) * ca
            iy = cy + (corner_r - frame_w) * sa
            ob_ring.append(bm.verts.new((ox, oy, 0.0685)))
            ot_ring.append(bm.verts.new((ox, oy, 0.0750)))
            it_ring.append(bm.verts.new((ix, iy, 0.0755)))
            ib_ring.append(bm.verts.new((ix, iy, 0.0685)))
    n = len(ob_ring)
    for r1, r2 in [(ob_ring, ot_ring), (ring_a := ot_ring, it_ring), (it_ring, ib_ring), (ib_ring, ob_ring)]:
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([r1[i], r1[j], r2[j], r2[i]])

    half_thick = 0.0032
    # Account for perpendicular fin half-thickness at 150°/210° so outermost vertex lands at exact TRIVET_MIN_X (-0.1565 m)
    r_left = (BURNER_X - TRIVET_MIN_X - half_thick * math.sin(math.radians(30.0))) / math.cos(math.radians(30.0))
    fin_specs = [
        (90.0, TRIVET_MAX_Y - BURNER_Y),
        (270.0, BURNER_Y - TRIVET_MIN_Y),
        (150.0, r_left),
        (210.0, r_left),
        (30.0, 0.1620),
        (330.0, 0.1620),
    ]
    r_inner_tip = 0.0440
    r_ped_inner = 0.0820
    r_ped_outer = 0.1060

    for deg, r_outer in fin_specs:
        ang = math.radians(deg)
        ca, sa = math.cos(ang), math.sin(ang)
        na_x, na_y = -sa, ca

        profile_rz = [
            (r_ped_inner, 0.0735),
            (r_ped_outer, 0.0735),
            (r_ped_outer + 0.004, 0.0970),
            (r_outer, 0.0985),
            (r_outer, TRIVET_TIP_Z),            # Outer retention lip top at Z = 0.1110 m (111 mm)
            (r_outer - 0.0070, TRIVET_TIP_Z),
            (r_outer - 0.0080, PAN_REST_Z),     # Horizontal pan support step at Z = 0.1060 m (106 mm)
            (0.0550, PAN_REST_Z),               # Continuous flat pan rest from r = 55 mm to r_outer - 8 mm
            (r_inner_tip, 0.1025),              # Sloped inner nose toward burner center
            (r_inner_tip, 0.0955),
            (r_ped_inner - 0.0020, 0.0955),
        ]
        left_verts = []
        right_verts = []
        for r_val, z_val in profile_rz:
            bx = BURNER_X + r_val * ca
            by = BURNER_Y + r_val * sa
            left_verts.append(bm.verts.new((bx + half_thick * na_x, by + half_thick * na_y, z_val)))
            right_verts.append(bm.verts.new((bx - half_thick * na_x, by - half_thick * na_y, z_val)))
        m_cnt = len(profile_rz)
        for i in range(m_cnt):
            j = (i + 1) % m_cnt
            bm.faces.new([left_verts[i], left_verts[j], right_verts[j], right_verts[i]])
        bm.faces.new(left_verts)
        bm.faces.new(list(reversed(right_verts)))

    trivet = bpy.data.objects.new("rsb_trivet", None)
    bpy.context.collection.objects.link(trivet)
    trivet.parent = parent
    create_mesh_object("rsb_trivet_mesh", bm, mat_trivet, parent=trivet)
    return trivet


def build_control_knob(
    mat_knob: bpy.types.Material,
    mat_white: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the front-right push-and-turn ignition/flame control knob (器具栓つまみ 021-650-000).

    Local origin is placed at the valve shaft center (KNOB_X = +0.1035, Y = -0.1395, KNOB_Z = 0.0350).
    Protrudes 30 mm forward to Y = -0.1695 m.
    """
    shaft_y = -BODY_D / 2.0  # -0.1395 m
    bm = bmesh.new()

    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=28,
        radius1=0.0205,
        radius2=0.0185,
        depth=0.008,
        matrix=Matrix.Translation((0.0, -0.004, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
    )
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=28,
        radius1=0.0180,
        radius2=0.0135,
        depth=0.012,
        matrix=Matrix.Translation((0.0, -0.013, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
    )
    add_rounded_rect_prism(
        bm,
        x0=-0.0048,
        x1=0.0048,
        y0=-0.0300,
        y1=-0.0100,
        z0=-0.0195,
        z1=0.0195,
        radius=0.0022,
        corner_segs=4,
    )
    knob = bpy.data.objects.new("rsb_control_knob", None)
    knob.location = Vector((KNOB_X, shaft_y, KNOB_Z))
    bpy.context.collection.objects.link(knob)
    knob.parent = parent
    create_mesh_object("rsb_control_knob_mesh", bm, mat_knob, parent=knob)

    bm_dot = bmesh.new()
    bmesh.ops.create_cone(
        bm_dot,
        cap_ends=True,
        cap_tris=False,
        segments=16,
        radius1=0.0024,
        radius2=0.0024,
        depth=0.0016,
        matrix=Matrix.Translation((0.0, -0.0290, 0.0105)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
    )
    create_mesh_object("rsb_knob_indicator", bm_dot, mat_white, parent=knob)
    return knob


def build_gas_hose_end(
    mat_brass_fitting: bpy.types.Material,
    mat_red_line: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the right-side swiveling Ø9.5 mm gas rubber hose barb (ホースエンド).

    Protrudes 24 mm to the right of the 299 mm body (X_max = +0.1735 m) and extends 60 mm rearward (+Y).
    """
    elbow_x = BODY_W / 2.0 + 0.0165  # +0.1660 m
    elbow_y = -0.0250
    elbow_z = KNOB_Z                 # 0.0350 m

    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=24,
        radius1=0.0072,
        radius2=0.0072,
        depth=0.0255,
        matrix=Matrix.Translation((-0.00525, 0.0, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "Y"),
    )
    bmesh.ops.create_uvsphere(
        bm,
        u_segments=20,
        v_segments=14,
        radius=0.0075,
        matrix=Matrix.Translation((0.0, 0.0, 0.0)),
    )
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=24,
        radius1=0.0052,
        radius2=0.0048,
        depth=0.056,
        matrix=Matrix.Translation((0.0, 0.030, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
    )
    for dy in (0.042, 0.050):
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            cap_tris=False,
            segments=24,
            radius1=0.0058,
            radius2=0.0049,
            depth=0.005,
            matrix=Matrix.Translation((0.0, dy, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
        )
    hose_end = bpy.data.objects.new("rsb_hose_end", None)
    hose_end.location = Vector((elbow_x, elbow_y, elbow_z))
    bpy.context.collection.objects.link(hose_end)
    hose_end.parent = parent
    create_mesh_object("rsb_hose_end_mesh", bm, mat_brass_fitting, parent=hose_end)

    bm_red = bmesh.new()
    bmesh.ops.create_cone(
        bm_red,
        cap_ends=True,
        cap_tris=False,
        segments=24,
        radius1=0.0056,
        radius2=0.0056,
        depth=0.0035,
        matrix=Matrix.Translation((0.0, 0.016, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "X"),
    )
    create_mesh_object("rsb_hose_red_line", bm_red, mat_red_line, parent=hose_end)
    return hose_end


def build_blue_gas_flame_crown(
    mat_flame: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build the dual-ring blue Bunsen gas flame crown (outer 24-jet ring + 8 inner bridge jets)."""
    bm = bmesh.new()
    for i in range(24):
        a = 2.0 * math.pi * i / 24.0
        rot = Matrix.Rotation(a, 4, "Z") @ Matrix.Translation((0.0385, 0.0, 0.003)) @ Matrix.Rotation(math.radians(32.0), 4, "Y")
        bmesh.ops.create_cone(
            bm,
            cap_ends=True,
            cap_tris=False,
            segments=10,
            radius1=0.0024,
            radius2=0.0004,
            depth=0.013,
            matrix=rot,
        )
    for lug_deg in (0.0, 90.0, 180.0, 270.0):
        for offset_deg in (-12.0, 12.0):
            a = math.radians(lug_deg + offset_deg)
            rot = Matrix.Rotation(a, 4, "Z") @ Matrix.Translation((0.0195, 0.0, 0.003)) @ Matrix.Rotation(math.radians(-18.0), 4, "Y")
            bmesh.ops.create_cone(
                bm,
                cap_ends=True,
                cap_tris=False,
                segments=10,
                radius1=0.0020,
                radius2=0.0003,
                depth=0.010,
                matrix=rot,
            )
    flame = bpy.data.objects.new("rsb_flame_crown", None)
    flame.location = Vector((BURNER_X, BURNER_Y, 0.0730))
    bpy.context.collection.objects.link(flame)
    flame.parent = parent
    create_mesh_object("rsb_flame_crown_mesh", bm, mat_flame, parent=flame)
    return flame


def attach_references(root: bpy.types.Object) -> None:
    """Attach manufacturer photos and orthographic drawings in a hidden reference collection."""
    appliance = bpy.data.collections.new("RSB-150PJ appliance")
    bpy.context.scene.collection.children.link(appliance)
    for obj in (root, *root.children_recursive):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        appliance.objects.link(obj)
    refs = bpy.data.collections.new("Manufacturer references - toggle visibility")
    bpy.context.scene.collection.children.link(refs)
    for i, name in enumerate(
        (
            "manufacturer-product.jpg",
            "dimensioned-orthographic-sheet.png",
            "orthographic-top.png",
            "orthographic-front.png",
            "orthographic-side.png",
            "part-burner-cap-151-420-000.jpg",
            "part-trivet-010-361-000.jpg",
            "part-knob-021-650-000.jpg",
        )
    ):
        img_path = REF_DIR / "images" / name
        if not img_path.exists():
            continue
        image = bpy.data.images.load(str(img_path))
        image.pack()
        obj = bpy.data.objects.new(name, None)
        refs.objects.link(obj)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 0.5
        obj.location = (i * 0.55, 0.85, 0.25)
        obj.rotation_euler.x = math.pi / 2
        obj["status"] = "Reference only; aligned to labelled dimensions"
    refs.hide_viewport = True
    refs.hide_render = True


def setup_studio_and_render(mat_floor: bpy.types.Material) -> list[str]:
    """Render 6 Cycles studio views of the Rinnai RSB-150PJ."""
    scene = bpy.context.scene
    before = set(scene.objects)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.15

    world = bpy.data.worlds.new("RSB neutral studio")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.68, 0.71, 0.75, 1.0)
        bg.inputs["Strength"].default_value = 0.48
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, -0.0005))
    floor = bpy.context.object
    floor.name = "Studio floor"
    floor.data.materials.append(mat_floor)

    def add_area_light(name: str, loc: tuple[float, float, float], target: tuple[float, float, float], energy: float, size: float) -> bpy.types.Object:
        ldata = bpy.data.lights.new(name=name, type="AREA")
        ldata.energy = energy
        ldata.size = size
        lobj = bpy.data.objects.new(name, ldata)
        scene.collection.objects.link(lobj)
        lobj.location = Vector(loc)
        lobj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return lobj

    add_area_light("Key softbox", (-0.85, -0.95, 1.35), (0.0, 0.0, 0.05), 145.0, 1.0)
    add_area_light("Fill stripbox", (0.85, -0.25, 0.95), (0.0, 0.0, 0.05), 98.0, 0.80)
    add_area_light("Rim reflection", (-0.20, 0.95, 1.15), (0.0, 0.0, 0.06), 115.0, 0.85)

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

    def aim_camera(pos: tuple[float, float, float], target: tuple[float, float, float], scale: float) -> None:
        camera.location = Vector(pos)
        camera.data.ortho_scale = scale
        camera.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()

    rendered: list[str] = []
    for name, position, target, scale in (
        ("studio-main.png", (0.58, -0.78, 0.62), (0.008, -0.005, 0.052), 0.52),
        ("studio-top.png", (0.008, -0.005, 1.80), (0.008, -0.005, 0.055), 0.50),
        ("studio-front.png", (0.008, -1.80, 0.055), (0.008, 0.0, 0.055), 0.42),
        ("studio-right.png", (1.80, -0.005, 0.060), (0.0, -0.005, 0.055), 0.48),
        ("studio-burner.png", (0.24, -0.52, 0.36), (-0.010, 0.0, 0.072), 0.28),
    ):
        aim_camera(position, target, scale)
        scene.render.filepath = str(ASSET_DIR / name)
        bpy.ops.render.render(write_still=True)
        rendered.append(name)

    floor.hide_render = True
    under_light = add_area_light("Underside inspection light", (0.32, -0.45, -1.15), (0.0, 0.0, 0.025), 125.0, 0.90)
    aim_camera((0.36, -0.58, -0.82), (0.008, -0.005, 0.035), 0.50)
    scene.render.filepath = str(ASSET_DIR / "studio-underside.png")
    bpy.ops.render.render(write_still=True)
    rendered.append("studio-underside.png")
    bpy.data.objects.remove(under_light, do_unlink=True)
    floor.hide_render = False
    return rendered


def compute_world_bounds(root: bpy.types.Object) -> dict[str, list[float]]:
    bpy.context.view_layer.update()
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in root.children_recursive:
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
    dims = maxs - mins
    return {
        "min_m": [round(mins.x, 6), round(mins.y, 6), round(mins.z, 6)],
        "max_m": [round(maxs.x, 6), round(maxs.y, 6), round(maxs.z, 6)],
        "dimensions_m": [round(dims.x, 6), round(dims.y, 6), round(dims.z, 6)],
        "dimensions_mm": [round(dims.x * 1000.0, 2), round(dims.y * 1000.0, 2), round(dims.z * 1000.0, 2)],
    }


def export_glb(root: bpy.types.Object, glb_path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-renders", action="store_true")
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")

    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    font = bpy.data.fonts.load("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
    font.name = "RSB label font"

    scene = bpy.context.scene
    scene.name = "Rinnai RSB-150PJ - compact commercial 1-burner gas stove"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    badge_png = ASSET_DIR / "front-panel-silkscreen.png"
    badge_img = generate_front_panel_texture(badge_png)

    mat_sus = make_material("RSB brushed stainless SUS430", (0.78, 0.80, 0.83, 1.0), metallic=0.90, roughness=0.22)
    mat_chassis = make_material("RSB dark charcoal painted steel", (0.14, 0.16, 0.18, 1.0), metallic=0.30, roughness=0.42)
    mat_front_label = make_textured_material("RSB front silkscreen panel", badge_img, metallic=0.28, roughness=0.40)
    mat_silk = make_material("RSB white silkscreen legend", (0.92, 0.93, 0.95, 1.0), metallic=0.05, roughness=0.28)
    mat_trivet = make_material("RSB black porcelain enamel trivet", (0.03, 0.035, 0.04, 1.0), metallic=0.16, roughness=0.15)
    mat_brass = make_material("RSB forged brass burner head", (0.83, 0.64, 0.28, 1.0), metallic=0.88, roughness=0.26)
    mat_cast_iron = make_material("RSB cast iron venturi", (0.22, 0.24, 0.26, 1.0), metallic=0.65, roughness=0.50)
    mat_ceramic = make_material("RSB alumina piezo insulator", (0.95, 0.94, 0.91, 1.0), metallic=0.0, roughness=0.24)
    mat_steel = make_material("RSB stainless probe and hardware", (0.76, 0.78, 0.80, 1.0), metallic=0.88, roughness=0.24)
    mat_knob = make_material("RSB black phenolic control knob", (0.05, 0.055, 0.06, 1.0), metallic=0.06, roughness=0.30)
    mat_white = make_material("RSB white indicator dot", (0.96, 0.97, 0.98, 1.0), metallic=0.0, roughness=0.22)
    mat_brass_fitting = make_material("RSB plated gas hose barb", (0.72, 0.73, 0.70, 1.0), metallic=0.84, roughness=0.28)
    mat_red_line = make_material("RSB red hose insertion ring", (0.84, 0.14, 0.12, 1.0), metallic=0.05, roughness=0.34)
    mat_rubber = make_material("RSB non-slip rubber foot", (0.04, 0.04, 0.045, 1.0), metallic=0.0, roughness=0.72)
    mat_flame = make_material(
        "RSB blue gas flame",
        (0.14, 0.52, 0.98, 1.0),
        metallic=0.0,
        roughness=0.15,
        emission=(0.18, 0.62, 1.0, 1.0),
        emission_strength=3.2,
    )
    mat_floor = make_material("Studio floor", (0.36, 0.38, 0.41, 1.0), metallic=0.0, roughness=0.88)

    root = bpy.data.objects.new("rsb_stove", None)
    bpy.context.collection.objects.link(root)
    root["model"] = "Rinnai RSB-150PJ commercial 1-burner countertop gas stove"
    root["product_code"] = "51-7234"
    root["published_gas_input_13a_kw"] = 5.23
    root["published_gas_input_lpg_kw"] = 4.07
    root["published_mass_kg"] = 2.1
    root["published_max_pan_diameter_m"] = 0.280

    build_stamped_stainless_top_plate(mat_sus, root)
    build_lower_chassis(mat_chassis, mat_front_label, mat_steel, mat_silk, root)
    build_rubber_feet(mat_rubber, root)
    build_brass_burner_and_sensors(mat_brass, mat_cast_iron, mat_ceramic, mat_steel, root)
    build_six_prong_trivet(mat_trivet, root)
    knob = build_control_knob(mat_knob, mat_white, root)
    hose = build_gas_hose_end(mat_brass_fitting, mat_red_line, root)
    flame = build_blue_gas_flame_crown(mat_flame, root)

    bounds = compute_world_bounds(root)
    for actual, expected in zip(bounds["dimensions_m"], (OVERALL_W, OVERALL_D, OVERALL_H)):
        assert abs(actual - expected) < 0.001, (bounds, (OVERALL_W, OVERALL_D, OVERALL_H))

    glb_path = ASSET_DIR / "rinnai-rsb-150pj.glb"
    export_glb(root, glb_path)
    attach_references(root)
    default_renders = [
        "studio-main.png",
        "studio-top.png",
        "studio-front.png",
        "studio-right.png",
        "studio-burner.png",
        "studio-underside.png",
    ]
    renders = (
        [r for r in default_renders if (ASSET_DIR / r).exists()]
        if args.skip_renders
        else setup_studio_and_render(mat_floor)
    )

    # Keyframe preview animation: push-and-turn knob ignition, flame modulation, hose swivel
    base_knob_loc = knob.location.copy()
    for frame, push_dy, turn_deg, flame_sz, hose_deg in (
        (1, 0.0, 0.0, 1.0, 0.0),
        (20, 0.004, 0.0, 0.2, 0.0),
        (45, 0.004, -90.0, 1.0, 0.0),
        (60, 0.0, -90.0, 1.0, 12.0),
        (90, 0.0, -52.0, 0.55, -12.0),
        (120, 0.0, 0.0, 1.0, 0.0),
    ):
        knob.location = base_knob_loc + Vector((0.0, push_dy, 0.0))
        knob.rotation_euler = Euler((0.0, math.radians(turn_deg), 0.0), "XYZ")
        flame.scale = Vector((1.0, 1.0, flame_sz))
        hose.rotation_euler = Euler((math.radians(hose_deg), 0.0, 0.0), "XYZ")
        knob.keyframe_insert(data_path="location", frame=frame)
        knob.keyframe_insert(data_path="rotation_euler", frame=frame)
        flame.keyframe_insert(data_path="scale", frame=frame)
        hose.keyframe_insert(data_path="rotation_euler", frame=frame)

    scene.frame_start = 1
    scene.frame_end = 120
    scene.render.fps = 24
    scene.frame_set(1)

    blend_path = ASSET_DIR / "rinnai-rsb-150pj.blend"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    report = {
        "status": "Articulated visual and MuJoCo mechanical prototype",
        "model": "Rinnai RSB-150PJ",
        "product_code": "51-7234",
        "drawing": "リンナイ 業務用機器 外観図 RSB-150PJ 1/5 scale engineering drawing (10.09.17(改))",
        "drawing_sha256": hashlib.sha256(
            (REF_DIR / "specifications" / "dimensioned-drawing.pdf").read_bytes()
        ).hexdigest(),
        "blender_version": bpy.app.version_string,
        "nominal_body_m": [OVERALL_W, OVERALL_D, OVERALL_H],
        "authored_body_m": bounds["dimensions_m"],
        "body_bounds_m": {"min": bounds["min_m"], "max": bounds["max_m"]},
        "stamped_sheet_body_m": [BODY_W, BODY_D, DECK_TOP_Z],
        "burner_center_m": [BURNER_X, BURNER_Y, DECK_TOP_Z],
        "burner_cap_diameter_m": BURNER_DIAM,
        "trivet_pan_rest_z_m": PAN_REST_Z,
        "gas_ratings": {
            "city_gas_13A_kw": 5.23,
            "city_gas_12A_kw": 4.87,
            "lp_gas_kw": 4.07,
        },
        "renders": renders,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
    }
    (ASSET_DIR / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Built Rinnai RSB-150PJ:", json.dumps(bounds, indent=2))


if __name__ == "__main__":
    main()
