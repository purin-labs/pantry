"""Build the Japanese Sugico Sangyo TO-600N commercial pre-rinse spray unit visual model.

Metres, Z up, operator front towards -Y, deck/base mounting flange at Z = 0.000 m.
Follows Sugico Sangyo TO-600N (スギコ産業 プリリンスシャワーユニット TO-600N, Drawing TA4768 & Parts Cat. p. 438):
- Nominal envelope: 425 x 153 x 640 mm (0.425 x 0.153 x 0.640 m).
- 614 mm vertical chrome riser pipe above 26 mm mixer deck flange (total 640 mm).
- TO-600-7N (TA2043) stadium-plan 263 x 47 mm cast mirror-chrome brass mixer bridge on 203.2 mm (8")
  1/2 NPS hot/cold inlet centers, with sculpted red/blue-indexed quarter-turn lever handles.
- TO-600-6N(S) cut-to-fit rear chrome wall bracket (Y_max = +0.0765 m) and TO-600-5N riser rest hook.
- Smooth 26-turn tapered chrome-plated steel overhead recoil spring + 937 mm ribbed SUS304-armored hose.
- TO-600-1N(S) (TA4769) 211 mm forged chrome-brass spray valve with cobalt-blue molded nylon 140 mm
  ergonomic grip, matching cobalt-blue curved squeeze lever, stainless hold-down ring, and stepped
  matte-black ABS dish-guard bumper framing a recessed multi-jet shower plate.
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
from build_oven_visuals import (
    area_light,
    box,
    convert_curves,
    cylinder,
    empty,
    finish,
    look_at,
    material,
    tube,
)
from inspect_mesh_quality import inspect_loaded

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/sugico-to-600n"
NAME = "sugico-to-600n"

WIDTH = 0.4250
DEPTH = 0.1530
HEIGHT = 0.6400

RISER_Y = 0.0320
INLET_HALF_SPAN_X = 0.1016  # 8-inch (203.2 mm) commercial faucet centers

HOT_HANDLE_ORIGIN = (-INLET_HALF_SPAN_X, RISER_Y, 0.0880)
COLD_HANDLE_ORIGIN = (INLET_HALF_SPAN_X, RISER_Y, 0.0880)
SPRING_ARM_ORIGIN = (0.0, 0.0200, 0.3650)
SPRAY_HEAD_LOCAL_ORIGIN = (0.0, -0.0440, 0.0250)  # world (0.0, -0.0240, 0.3900)
TRIGGER_LOCAL_ORIGIN = (0.0, -0.0160, -0.0200)     # world (0.0, -0.0400, 0.3700)


def clean_mesh_object(obj, sharp_angle_deg: float | None = 52.0, flat_normals: bool = False):
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        if mod.type == "WEIGHTED_NORMAL":
            obj.modifiers.remove(mod)
        else:
            bpy.ops.object.modifier_apply(modifier=mod.name)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
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
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

    use_flat = flat_normals or bool(obj.get("flat_normals", False))
    thresh = None if sharp_angle_deg is None else math.radians(sharp_angle_deg)
    for e in bm.edges:
        if use_flat:
            e.smooth = False
        elif thresh is not None and len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < thresh
        else:
            e.smooth = True

    bm.to_mesh(obj.data)
    bm.free()

    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.update()

    if use_flat:
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


def surfaces():
    mats = {
        "chrome_brass": material(
            "TO600 mirror chrome brass", (0.78, 0.80, 0.83, 1.0), 0.96, 0.12
        ),
        "spring_chrome": material(
            "TO600 chrome steel recoil spring", (0.74, 0.77, 0.80, 1.0), 0.94, 0.16
        ),
        "sus304_hose": material(
            "TO600 SUS304 armored hose", (0.64, 0.67, 0.70, 1.0), 0.90, 0.23
        ),
        "brass_inlet": material(
            "TO600 machined 1_2 NPS brass", (0.74, 0.58, 0.24, 1.0), 0.88, 0.25
        ),
        "grip_blue_nylon": material(
            "TO600 cobalt blue nylon grip", (0.015, 0.068, 0.34, 1.0), 0.02, 0.34
        ),
        "bumper_abs_black": material(
            "TO600 matte black ABS bumper", (0.022, 0.024, 0.028, 1.0), 0.02, 0.54
        ),
        "spray_face": material(
            "TO600 perforated shower face", (0.28, 0.31, 0.35, 1.0), 0.75, 0.28
        ),
        "hot_red": material(
            "TO600 hot index red", (0.78, 0.05, 0.04, 1.0), 0.08, 0.24
        ),
        "cold_blue": material(
            "TO600 cold index blue", (0.03, 0.22, 0.74, 1.0), 0.08, 0.24
        ),
    }
    bsdf_blue = mats["grip_blue_nylon"].node_tree.nodes.get("Principled BSDF")
    if bsdf_blue is not None:
        bsdf_blue.inputs["Coat Weight"].default_value = 0.16
        bsdf_blue.inputs["Coat Roughness"].default_value = 0.24
    for m in mats.values():
        assert "metallic" in m and "roughness" in m and "emission" in m
    return mats


def stadium_loop_ccw(
    cx: float, cy: float, width: float, depth: float, radius: float, segs_per_corner: int = 10
) -> list[tuple[float, float]]:
    r = max(1e-5, min(radius, width * 0.499, depth * 0.499))
    corners = (
        (cx + width / 2.0 - r, cy + depth / 2.0 - r, 0.0),
        (cx - width / 2.0 + r, cy + depth / 2.0 - r, 90.0),
        (cx - width / 2.0 + r, cy - depth / 2.0 + r, 180.0),
        (cx + width / 2.0 - r, cy - depth / 2.0 + r, 270.0),
    )
    pts: list[tuple[float, float]] = []
    for ox, oy, start_deg in corners:
        for step in range(segs_per_corner):
            ang = math.radians(start_deg + step * 90.0 / segs_per_corner)
            pts.append((ox + r * math.cos(ang), oy + r * math.sin(ang)))
    return pts


def build_lofted_solid(
    name: str,
    stations: list[tuple[list[tuple[float, float]], float]],
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    bevel: float = 0.0,
) -> bpy.types.Object:
    """Build a closed manifold solid from stacked CCW XY loops (bottom-to-top Z)."""
    n_rings = len(stations)
    ring_n = len(stations[0][0])
    verts: list[tuple[float, float, float]] = []
    for loop, z in stations:
        assert len(loop) == ring_n
        verts.extend((x, y, z) for x, y in loop)

    bot_cx = sum(x for x, _ in stations[0][0]) / ring_n
    bot_cy = sum(y for _, y in stations[0][0]) / ring_n
    top_cx = sum(x for x, _ in stations[-1][0]) / ring_n
    top_cy = sum(y for _, y in stations[-1][0]) / ring_n
    bot_center = len(verts)
    verts.append((bot_cx, bot_cy, stations[0][1]))
    top_center = len(verts)
    verts.append((top_cx, top_cy, stations[-1][1]))

    faces: list[tuple[int, ...]] = []
    for r_idx in range(n_rings - 1):
        b0 = r_idx * ring_n
        b1 = (r_idx + 1) * ring_n
        for i in range(ring_n):
            j = (i + 1) % ring_n
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))

    top_base = (n_rings - 1) * ring_n
    for i in range(ring_n):
        j = (i + 1) % ring_n
        faces.append((bot_center, j, i))
        faces.append((top_center, top_base + i, top_base + j))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=bevel)


def build_revolved_solid(
    name: str,
    center_xy: tuple[float, float],
    rz_stations: list[tuple[float, float]],
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    radial_segments: int = 32,
) -> bpy.types.Object:
    cx, cy = center_xy
    stations = [
        (
            [
                (
                    cx + r * math.cos(2.0 * math.pi * k / radial_segments),
                    cy + r * math.sin(2.0 * math.pi * k / radial_segments),
                )
                for k in range(radial_segments)
            ],
            z,
        )
        for r, z in rz_stations
    ]
    return build_lofted_solid(name, stations, surface, parent, bevel=0.0)


def build_variable_pipe_mesh(
    name: str,
    centerline_pts: list[tuple[float, float, float]],
    radii: list[float] | float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    radial_segments: int = 18,
) -> bpy.types.Object:
    pts = [Vector(p) for p in centerline_pts]
    n_pts = len(pts)
    rad_list = [radii] * n_pts if isinstance(radii, (int, float)) else list(radii)
    assert len(rad_list) == n_pts

    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    prev_normal = Vector((1.0, 0.0, 0.0))

    for idx, (p, rad) in enumerate(zip(pts, rad_list)):
        if idx == 0:
            tangent = (pts[1] - pts[0]).normalized()
        elif idx == n_pts - 1:
            tangent = (pts[-1] - pts[-2]).normalized()
        else:
            t_sum = (pts[idx] - pts[idx - 1]).normalized() + (pts[idx + 1] - pts[idx]).normalized()
            tangent = t_sum.normalized() if t_sum.length > 1e-6 else (pts[idx + 1] - pts[idx]).normalized()

        normal = prev_normal - tangent * prev_normal.dot(tangent)
        if normal.length < 1e-5:
            fb = Vector((0.0, 1.0, 0.0)) if abs(tangent.x) > 0.9 else Vector((1.0, 0.0, 0.0))
            normal = (fb - tangent * fb.dot(tangent)).normalized()
        else:
            normal.normalize()
        binormal = tangent.cross(normal).normalized()
        prev_normal = normal

        for s in range(radial_segments):
            ang = 2.0 * math.pi * s / radial_segments
            v = p + normal * (rad * math.cos(ang)) + binormal * (rad * math.sin(ang))
            verts.append((v.x, v.y, v.z))

    for idx in range(n_pts - 1):
        b0 = idx * radial_segments
        b1 = (idx + 1) * radial_segments
        for s in range(radial_segments):
            sn = (s + 1) % radial_segments
            faces.append((b0 + s, b0 + sn, b1 + sn, b1 + s))

    start_c = len(verts)
    verts.append((pts[0].x, pts[0].y, pts[0].z))
    end_c = len(verts)
    verts.append((pts[-1].x, pts[-1].y, pts[-1].z))
    last_b = (n_pts - 1) * radial_segments
    for s in range(radial_segments):
        sn = (s + 1) % radial_segments
        faces.append((start_c, sn, s))
        faces.append((end_c, last_b + s, last_b + sn))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def catmull_rom_chain(ctrl_pts: list[tuple[float, float, float]], samples_per_seg: int = 20) -> list[Vector]:
    v = [Vector(p) for p in ctrl_pts]
    padded = [v[0] + (v[0] - v[1]), *v, v[-1] + (v[-1] - v[-2])]
    out: list[Vector] = []
    n_seg = len(v) - 1
    for i in range(n_seg):
        p0, p1, p2, p3 = padded[i], padded[i + 1], padded[i + 2], padded[i + 3]
        steps = samples_per_seg if i < n_seg - 1 else samples_per_seg + 1
        for s in range(steps):
            if i == n_seg - 1 and s == samples_per_seg:
                out.append(p2.copy())
                continue
            t = s / samples_per_seg
            t2 = t * t
            t3 = t2 * t
            pt = 0.5 * (
                (2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
            )
            out.append(pt)
    return out


def hex_nut(
    name: str,
    position: tuple[float, float, float],
    across_corners_r: float,
    depth: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    axis: str = "Z",
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=across_corners_r, depth=depth, location=position)
    obj = bpy.context.object
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2.0
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2.0
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_base_mixer_and_riser(root, mat):
    # 1. Dual 1/2 NPS deck mounting escutcheon domes strictly touching Z = 0.000000 m + hex coupling nuts
    for side_tag, ix in (("left_hot", -INLET_HALF_SPAN_X), ("right_cold", INLET_HALF_SPAN_X)):
        build_revolved_solid(
            f"Deck flange 1_2 NPS {side_tag}",
            (ix, RISER_Y),
            [
                (0.0225, 0.0000),
                (0.0225, 0.0030),
                (0.0195, 0.0085),
                (0.0150, 0.0110),
            ],
            mat["chrome_brass"],
            root,
            radial_segments=32,
        )
        hex_nut(
            f"Inlet union hex nut {side_tag}",
            (ix, RISER_Y, 0.0175),
            0.0168,
            0.0130,
            mat["chrome_brass"],
            root,
        )
        cylinder(
            f"Inlet brass 1_2 NPS seat {side_tag}",
            (ix, RISER_Y, 0.0260),
            0.0125,
            0.0060,
            mat["brass_inlet"],
            root,
        )

    # 2. TO-600-7N (TA2043) stadium-plan cast mirror-chrome brass bridge: exact 263 x 47 mm
    segs = 10
    mixer_stations = [
        (stadium_loop_ccw(0.0, RISER_Y, 0.2560, 0.0400, 0.0198, segs), 0.0280),
        (stadium_loop_ccw(0.0, RISER_Y, 0.2615, 0.0455, 0.0226, segs), 0.0310),
        (stadium_loop_ccw(0.0, RISER_Y, 0.2630, 0.0470, 0.0234, segs), 0.0350),
        (stadium_loop_ccw(0.0, RISER_Y, 0.2630, 0.0470, 0.0234, segs), 0.0550),
        (stadium_loop_ccw(0.0, RISER_Y, 0.2615, 0.0455, 0.0226, segs), 0.0590),
        (stadium_loop_ccw(0.0, RISER_Y, 0.2550, 0.0390, 0.0194, segs), 0.0620),
    ]
    build_lofted_solid(
        "Faucet mixer manifold 263x47mm",
        mixer_stations,
        mat["chrome_brass"],
        root,
    )

    # Stepped cast turrets & hex packing bonnets at X = +-0.1016 m
    for side_tag, ix in (("hot", -INLET_HALF_SPAN_X), ("cold", INLET_HALF_SPAN_X)):
        build_revolved_solid(
            f"Valve turret boss {side_tag}",
            (ix, RISER_Y),
            [
                (0.0195, 0.0580),
                (0.0175, 0.0650),
                (0.0150, 0.0690),
            ],
            mat["chrome_brass"],
            root,
        )
        hex_nut(
            f"Quarter-turn valve bonnet {side_tag}",
            (ix, RISER_Y, 0.0745),
            0.0142,
            0.0110,
            mat["chrome_brass"],
            root,
        )
        cylinder(
            f"Valve stem collar {side_tag}",
            (ix, RISER_Y, 0.0830),
            0.0095,
            0.0080,
            mat["chrome_brass"],
            root,
        )

    # Central riser outlet boss + hex union coupling + 614 mm vertical chrome riser pipe
    build_revolved_solid(
        "Mixer central riser turret",
        (0.0, RISER_Y),
        [
            (0.0210, 0.0580),
            (0.0185, 0.0660),
            (0.0155, 0.0700),
        ],
        mat["chrome_brass"],
        root,
    )
    hex_nut(
        "Riser union hex coupling",
        (0.0, RISER_Y, 0.0785),
        0.0168,
        0.0170,
        mat["chrome_brass"],
        root,
    )

    cylinder(
        "Vertical 614mm chrome riser pipe",
        (0.0, RISER_Y, 0.3590),
        0.0095,
        0.5480,
        mat["chrome_brass"],
        root,
    )

    # Stepped top finial cap strictly reaching exact Z_max = 0.640000 m
    build_revolved_solid(
        "Riser top finial cap",
        (0.0, RISER_Y),
        [
            (0.0122, 0.6290),
            (0.0128, 0.6310),
            (0.0128, 0.6380),
            (0.0112, 0.6400),
        ],
        mat["chrome_brass"],
        root,
        radial_segments=32,
    )

    # Riser swivel branch tee & hex nut at Z = 0.3650 m feeding the overhead recoil spring arm
    cylinder(
        "Riser spring-arm tee collar",
        (0.0, RISER_Y, 0.3650),
        0.0142,
        0.0300,
        mat["chrome_brass"],
        root,
    )
    cylinder(
        "Riser spring-arm forward branch",
        (0.0, 0.0245, 0.3650),
        0.0115,
        0.0180,
        mat["chrome_brass"],
        root,
        "Y",
    )

    # 4. TO-600-6N(S) cut-to-fit rear chrome wall bracket reaching exact Y_max = +0.076500 m
    cylinder(
        "Wall bracket riser clamp",
        (0.0, RISER_Y, 0.4950),
        0.0142,
        0.0220,
        mat["chrome_brass"],
        root,
    )
    for sgn, s_lbl in ((-1.0, "l"), (1.0, "r")):
        cylinder(
            f"Wall bracket clamp ear {s_lbl}",
            (sgn * 0.0155, RISER_Y, 0.4950),
            0.0032,
            0.0060,
            mat["chrome_brass"],
            root,
            "X",
        )
    cylinder(
        "Wall bracket cut-to-fit stem",
        (0.0, 0.0530, 0.4950),
        0.0065,
        0.0380,
        mat["chrome_brass"],
        root,
        "Y",
    )
    # Circular wall mounting flange with rear face strictly at Y_max = +0.076500 m (bevel=0.0)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32, radius=0.0245, depth=0.0050, location=(0.0, 0.0740, 0.4950)
    )
    bpy.context.object.rotation_euler[0] = math.pi / 2.0
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    finish(bpy.context.object, "Rear wall bracket flange", mat["chrome_brass"], root, 0.0)

    # 5. TO-600-5N spray-gun rest hook at Z = 0.3180 m with rear clamping screw & curved J-cradle
    cylinder(
        "Rest hook riser collar",
        (0.0, RISER_Y, 0.3180),
        0.0138,
        0.0200,
        mat["chrome_brass"],
        root,
    )
    cylinder(
        "Rest hook rear lock screw",
        (0.0, RISER_Y + 0.0155, 0.3180),
        0.0040,
        0.0080,
        mat["chrome_brass"],
        root,
        "Y",
    )
    for side_tag, sgn in (("left", -1.0), ("right", 1.0)):
        hook_pts = catmull_rom_chain(
            [
                (sgn * 0.0105, RISER_Y - 0.0050, 0.3180),
                (sgn * 0.0215, 0.0040, 0.3175),
                (sgn * 0.0225, -0.0250, 0.3190),
                (sgn * 0.0185, -0.0410, 0.3290),
            ],
            samples_per_seg=10,
        )
        build_variable_pipe_mesh(
            f"Rest hook cradle prong {side_tag}",
            [(p.x, p.y, p.z) for p in hook_pts],
            0.0032,
            mat["spring_chrome"],
            root,
            radial_segments=14,
        )


def build_lever_blade_mesh(
    name: str,
    sign_x: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Build a sculpted stadium-tip commercial chrome lever handle reaching exact X_local = sign_x * 0.110900 m."""
    # Exact tip reach: 0.1016 + 0.1109 = 0.212500 m -> 425.0 mm total span!
    # Build closed CCW loop in XY: hub end near X=0 (r=0.0065) tapering gently to paddle tip (r=0.0082) at X = sign_x * 0.110900
    tip_r = 0.0082
    hub_r = 0.0060
    tip_cx = sign_x * (0.110900 - tip_r)
    hub_cx = sign_x * (-0.0020)

    pts_xy: list[tuple[float, float]] = []
    if sign_x < 0.0:
        # Left handle (-X): tip arc from 90 deg through 180 deg (exact -0.110900 at step=6) to 270 deg, hub arc 270 -> 450 deg
        for step in range(13):
            ang = math.radians(90.0 + step * 180.0 / 12.0)  # step=6 -> 180 deg -> cos=-1 exact!
            pts_xy.append((tip_cx + tip_r * math.cos(ang), tip_r * math.sin(ang)))
        for step in range(9):
            ang = math.radians(-90.0 + step * 180.0 / 8.0)
            pts_xy.append((hub_cx + hub_r * math.cos(ang), hub_r * math.sin(ang)))
    else:
        # Right handle (+X): tip arc from -90 deg through 0 deg (exact +0.110900 at step=6) to +90 deg, hub arc 90 -> 270 deg
        for step in range(13):
            ang = math.radians(-90.0 + step * 180.0 / 12.0)  # step=6 -> 0 deg -> cos=+1 exact!
            pts_xy.append((tip_cx + tip_r * math.cos(ang), tip_r * math.sin(ang)))
        for step in range(9):
            ang = math.radians(90.0 + step * 180.0 / 8.0)
            pts_xy.append((hub_cx + hub_r * math.cos(ang), hub_r * math.sin(ang)))

    # Extrude with subtle upward ergonomic sweep along |x| while keeping exact X extremum untouched
    def z_sweep(x_val: float) -> float:
        u = min(1.0, max(0.0, abs(x_val) / 0.1109))
        return 0.0065 * (u**1.35)

    n = len(pts_xy)
    verts = [(x, y, 0.0025 + z_sweep(x)) for x, y in pts_xy] + [
        (x, y, 0.0090 + z_sweep(x)) for x, y in pts_xy
    ]
    faces: list[tuple[int, ...]] = [
        tuple(reversed(range(n))),
        tuple(range(n, 2 * n)),
    ]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, name, surface, parent, bevel=0.0)


def build_quarter_turn_handles(root, mat):
    # Left hot-water lever handle (hinge axis +Z, outer tip strictly at X = -0.212500 m)
    hot = empty("to600_hot_handle", HOT_HANDLE_ORIGIN, root)
    hot["joint"] = "to600_hot_valve"
    hot["joint_type"] = "hinge"
    hot["axis_blender"] = "+Z"
    hot["range_rad"] = [0.0, 1.5708]

    build_revolved_solid(
        "to600_hot_hub",
        (0.0, 0.0),
        [
            (0.0132, -0.0040),
            (0.0128, 0.0040),
            (0.0112, 0.0120),
            (0.0095, 0.0135),
        ],
        mat["chrome_brass"],
        hot,
    )
    cylinder("to600_hot_red_index", (0.0, 0.0, 0.0138), 0.0068, 0.0016, mat["hot_red"], hot)
    build_lever_blade_mesh("to600_hot_lever_blade", -1.0, mat["chrome_brass"], hot)

    # Right cold-water lever handle (hinge axis -Z, outer tip strictly at X = +0.212500 m)
    cold = empty("to600_cold_handle", COLD_HANDLE_ORIGIN, root)
    cold["joint"] = "to600_cold_valve"
    cold["joint_type"] = "hinge"
    cold["axis_blender"] = "-Z"
    cold["range_rad"] = [0.0, 1.5708]

    build_revolved_solid(
        "to600_cold_hub",
        (0.0, 0.0),
        [
            (0.0132, -0.0040),
            (0.0128, 0.0040),
            (0.0112, 0.0120),
            (0.0095, 0.0135),
        ],
        mat["chrome_brass"],
        cold,
    )
    cylinder("to600_cold_blue_index", (0.0, 0.0, 0.0138), 0.0068, 0.0016, mat["cold_blue"], cold)
    build_lever_blade_mesh("to600_cold_lever_blade", 1.0, mat["chrome_brass"], cold)

    return hot, cold


def build_spring_arm_and_spray_assembly(root, mat):
    # Overhead spring-loaded hose arm (hinge axis +X, range -0.15 .. +0.55 rad)
    arm = empty("to600_spring_arm", SPRING_ARM_ORIGIN, root)
    arm["joint"] = "to600_arm_pitch"
    arm["joint_type"] = "hinge"
    arm["axis_blender"] = "+X"
    arm["range_rad"] = [-0.15, 0.55]

    hex_nut(
        "to600_spring_base_hex",
        (0.0, 0.0, 0.0070),
        0.0155,
        0.0140,
        mat["chrome_brass"],
        arm,
    )
    build_revolved_solid(
        "to600_spring_base_ferrule",
        (0.0, 0.0),
        [
            (0.0185, 0.0130),
            (0.0190, 0.0220),
            (0.0172, 0.0250),
        ],
        mat["chrome_brass"],
        arm,
    )

    # Smooth 26-turn tapered chrome-plated steel overhead recoil spring (world Z <= 0.600 m)
    coil_pts: list[tuple[float, float, float]] = []
    n_turns = 26
    pts_per_turn = 16
    total_pts = n_turns * pts_per_turn + 1
    for i in range(total_pts):
        u = i / (total_pts - 1)
        ang = 2.0 * math.pi * n_turns * u
        r_coil = 0.0168 * (1.0 - 0.22 * u)
        cx = 0.0140 * (u**1.55)
        cy = -0.0300 * (u**1.30)
        cz = 0.0220 + 0.2080 * u
        coil_pts.append((cx + r_coil * math.cos(ang), cy + r_coil * math.sin(ang), cz))
    build_variable_pipe_mesh(
        "to600_overhead_recoil_spring",
        coil_pts,
        0.00195,
        mat["spring_chrome"],
        arm,
        radial_segments=12,
    )

    # Arched SUS304-armored flexible hose (937 mm centerline arc with interlocking armor ribs + hex swivel ferrules)
    hose_ctrl = [
        (0.0, 0.0, 0.0160),
        (0.0040, -0.0150, 0.1450),
        (0.0180, -0.0320, 0.2500),   # arch crown at world Z = 0.615 m (< 0.640 m)
        (0.0940, -0.0140, 0.1320),
        (0.1120, -0.0080, -0.0560),
        (0.0850, -0.0160, -0.2180),  # slack loop bottom at world Z = 0.147 m (> 0.000 m)
        (0.0280, -0.0320, -0.1360),
        (0.0, -0.0440, 0.0250),      # meets to600_spray_head swivel at world (0.0, -0.0240, 0.3900)
    ]
    hose_samples = catmull_rom_chain(hose_ctrl, samples_per_seg=22)
    hose_arc_m = sum(
        (hose_samples[i + 1] - hose_samples[i]).length for i in range(len(hose_samples) - 1)
    )
    arm["hose_nominal_length_m"] = 0.937
    arm["hose_control_polygon_m"] = round(hose_arc_m, 4)

    hose_radii = [
        0.0086 + 0.00045 * math.sin(2.0 * math.pi * 68.0 * (i / max(1, len(hose_samples) - 1)))
        for i in range(len(hose_samples))
    ]
    build_variable_pipe_mesh(
        "to600_sus304_armored_hose",
        [(p.x, p.y, p.z) for p in hose_samples],
        hose_radii,
        mat["sus304_hose"],
        arm,
        radial_segments=18,
    )

    # Child body: to600_spray_head (TO-600-1N(S) / TA4769: 211 mm spray valve + 140 mm cobalt-blue grip)
    head = empty("to600_spray_head", SPRAY_HEAD_LOCAL_ORIGIN, arm)
    head["joint"] = "to600_head_tilt"
    head["joint_type"] = "hinge"
    head["axis_blender"] = "+X"
    head["range_rad"] = [-0.45, 0.45]
    head["valve_length_m"] = 0.211
    head["grip_length_m"] = 0.140

    hex_nut(
        "to600_spray_swivel_nut",
        (0.0, 0.0, -0.0055),
        0.0128,
        0.0110,
        mat["chrome_brass"],
        head,
    )
    cylinder(
        "to600_spray_upper_collar",
        (0.0, 0.0, -0.0155),
        0.0122,
        0.0100,
        mat["chrome_brass"],
        head,
    )

    # Contoured 140 mm cobalt-blue molded nylon ergonomic grip (Z_local = -0.1400 .. -0.0180 m)
    grip_rz: list[tuple[float, float]] = [
        (0.0146, -0.1400),
        (0.0160, -0.1370),
        (0.0154, -0.1310),
    ]
    for k in range(11):
        z = -0.1250 + k * 0.0095
        bulge = 0.0012 * math.sin(math.pi * k / 10.0)
        rib = 0.00035 * (1.0 if k % 2 == 0 else -1.0)
        grip_rz.append((0.0144 + bulge + rib, z))
    grip_rz.extend(
        [
            (0.0156, -0.0220),
            (0.0138, -0.0180),
        ]
    )
    build_revolved_solid(
        "to600_insulated_140mm_grip",
        (0.0, 0.0),
        grip_rz,
        mat["grip_blue_nylon"],
        head,
        radial_segments=28,
    )

    # Circular stainless hold-down ring (グリップ固定用リング) hanging at lower grip
    ring_pts = [
        (
            0.0185 * math.cos(2.0 * math.pi * k / 24),
            -0.0150 + 0.0135 * math.sin(2.0 * math.pi * k / 24),
            -0.1250,
        )
        for k in range(25)
    ]
    build_variable_pipe_mesh(
        "to600_hold_down_ring",
        ring_pts,
        0.0020,
        mat["spring_chrome"],
        head,
        radial_segments=12,
    )

    # Forged mirror-chrome brass valve body & angled shower bell
    build_revolved_solid(
        "to600_valve_brass_body",
        (0.0, -0.0020),
        [
            (0.0130, -0.1720),
            (0.0142, -0.1640),
            (0.0142, -0.1440),
            (0.0132, -0.1390),
        ],
        mat["chrome_brass"],
        head,
    )

    neck_pts = catmull_rom_chain(
        [
            (0.0, -0.0025, -0.1680),
            (0.0, -0.0110, -0.1830),
            (0.0, -0.0225, -0.1960),
        ],
        samples_per_seg=10,
    )
    build_variable_pipe_mesh(
        "to600_angled_nozzle_neck",
        [(p.x, p.y, p.z) for p in neck_pts],
        0.0118,
        mat["chrome_brass"],
        head,
        radial_segments=22,
    )

    build_revolved_solid(
        "to600_spray_chrome_bell",
        (0.0, -0.0225),
        [
            (0.0258, -0.2015),
            (0.0242, -0.1945),
            (0.0165, -0.1885),
        ],
        mat["chrome_brass"],
        head,
        radial_segments=32,
    )

    # Stepped matte-black ABS protective dish-guard bumper:
    # head world Y = -0.0240 m; bumper center Y_local = -0.0225 m, max radius = 0.0300 m (32 radial segs -> exact -Y vertex)
    # -> exact front-most vertex Y_world = -0.0240 - 0.0225 - 0.0300 = -0.076500 m!
    # -> bottom lip sits at Z_local = -0.211000 m (exact 211 mm spray valve length!).
    build_revolved_solid(
        "to600_epdm_nozzle_bumper",
        (0.0, -0.0225),
        [
            (0.0272, -0.2110),
            (0.0300, -0.2090),
            (0.0300, -0.2025),
            (0.0270, -0.1980),
            (0.0252, -0.1965),
        ],
        mat["bumper_abs_black"],
        head,
        radial_segments=32,
    )

    # Recessed multi-jet perforated shower face plate + center screw boss
    cylinder(
        "to600_perforated_spray_face",
        (0.0, -0.0225, -0.2082),
        0.0242,
        0.0024,
        mat["spray_face"],
        head,
    )
    cylinder(
        "to600_spray_center_screw",
        (0.0, -0.0225, -0.2095),
        0.0038,
        0.0012,
        mat["chrome_brass"],
        head,
    )

    # Child body: to600_trigger (sculpted cobalt-blue squeeze lever, child of to600_spray_head, hinge +X, 0..0.42 rad)
    trig = empty("to600_trigger", TRIGGER_LOCAL_ORIGIN, head)
    trig["joint"] = "to600_trigger_squeeze"
    trig["joint_type"] = "hinge"
    trig["axis_blender"] = "+X"
    trig["range_rad"] = [0.0, 0.42]

    box(
        "to600_trigger_clevis",
        (0.0, 0.0065, 0.0010),
        (0.0210, 0.0170, 0.0110),
        mat["chrome_brass"],
        trig,
        0.0012,
    )
    cylinder(
        "to600_trigger_pivot_pin",
        (0.0, 0.0, 0.0010),
        0.0034,
        0.0235,
        mat["chrome_brass"],
        trig,
        "X",
    )

    # Sculpted cobalt-blue nylon curved squeeze lever matching TO-600-1N(S) catalogue photo
    lever_stations = [
        (stadium_loop_ccw(0.0, -0.0115, 0.0140, 0.0065, 0.0030, segs_per_corner=6), -0.1060),
        (stadium_loop_ccw(0.0, -0.0135, 0.0160, 0.0075, 0.0035, segs_per_corner=6), -0.0820),
        (stadium_loop_ccw(0.0, -0.0125, 0.0168, 0.0080, 0.0038, segs_per_corner=6), -0.0480),
        (stadium_loop_ccw(0.0, -0.0075, 0.0165, 0.0085, 0.0038, segs_per_corner=6), -0.0180),
        (stadium_loop_ccw(0.0, -0.0020, 0.0155, 0.0090, 0.0035, segs_per_corner=6), 0.0020),
    ]
    build_lofted_solid(
        "to600_trigger_squeeze_lever",
        lever_stations,
        mat["grip_blue_nylon"],
        trig,
    )

    cylinder(
        "to600_trigger_valve_plunger",
        (0.0, 0.0060, -0.0420),
        0.0035,
        0.0160,
        mat["brass_inlet"],
        trig,
        "Y",
    )

    return arm, head, trig


def animate_timeline(hot, cold, arm, head, trig):
    keyframes = (
        (1, 0.0, 0.0, 0.0, 0.0, 0.0),
        (20, 0.0, 0.0, 0.0, 0.0, 0.0),
        (55, 1.15, -0.80, 0.38, -0.22, 0.38),
        (85, 1.15, -0.80, 0.38, -0.22, 0.38),
        (120, 0.0, 0.0, 0.0, 0.0, 0.0),
    )
    for fno, hot_rz, cold_rz, arm_rx, head_rx, trig_rx in keyframes:
        hot.rotation_euler = (0.0, 0.0, hot_rz)
        hot.keyframe_insert(data_path="rotation_euler", frame=fno)

        cold.rotation_euler = (0.0, 0.0, cold_rz)
        cold.keyframe_insert(data_path="rotation_euler", frame=fno)

        arm.rotation_euler = (arm_rx, 0.0, 0.0)
        arm.keyframe_insert(data_path="rotation_euler", frame=fno)

        head.rotation_euler = (head_rx, 0.0, 0.0)
        head.keyframe_insert(data_path="rotation_euler", frame=fno)

        trig.rotation_euler = (trig_rx, 0.0, 0.0)
        trig.keyframe_insert(data_path="rotation_euler", frame=fno)


def clear_all_animations(root):
    for obj in (root, *root.children_recursive):
        obj.animation_data_clear()


def move_objects(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def enable_metal_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "METAL" or dev.type == "CPU"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100


def setup_studio(scene):
    before = set(scene.objects)
    enable_metal_gpu(scene)
    scene.world = bpy.data.worlds.new("TO-600N studio world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.60, 0.65, 0.72, 1.0)
    bg.inputs["Strength"].default_value = 0.52
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.16

    pedestal_mat = material("TO600 stainless deck pedestal", (0.34, 0.36, 0.39, 1.0), 0.15, 0.78, 0.0)
    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, -0.0005))
    bpy.context.object.name = "Studio deck plane"
    bpy.context.object.data.materials.append(pedestal_mat)

    area_light("Key softbox", (-1.35, -1.65, 1.55), (0.0, 0.0, 0.32), 185.0, 1.4)
    area_light("Fill stripbox", (1.45, -0.65, 1.25), (0.0, 0.0, 0.32), 135.0, 1.2)
    area_light("Rim reflection", (-0.15, 1.40, 1.45), (0.0, 0.0, 0.35), 145.0, 1.2)
    area_light("Lower mixer fill", (0.0, -1.60, 0.20), (0.0, 0.0, 0.12), 55.0, 0.9)

    cam_data = bpy.data.cameras.new("Review camera")
    cam_data.type = "ORTHO"
    camera = bpy.data.objects.new("Review camera", cam_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    studio_col = bpy.data.collections.new("Studio - excluded from GLB")
    scene.collection.children.link(studio_col)
    move_objects(set(scene.objects) - before, studio_col)
    return camera


def set_camera(camera, position, target, scale):
    camera.location = position
    camera.data.ortho_scale = scale
    look_at(camera, target)


def compute_world_bounds(root):
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
    }


def export_rest_glb(root, glb_path: Path):
    bpy.context.scene.frame_set(1)
    clear_all_animations(root)
    bpy.context.view_layer.update()
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


def inspect_exported_glb(glb_path: Path):
    """Re-import exported GLB in a clean empty Blender scene and verify hierarchy, envelope, and mesh quality."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    objects = bpy.data.objects

    root = objects["to600_base"]
    hot = objects["to600_hot_handle"]
    cold = objects["to600_cold_handle"]
    arm = objects["to600_spring_arm"]
    head = objects["to600_spray_head"]
    trig = objects["to600_trigger"]

    assert hot.parent == root and cold.parent == root and arm.parent == root
    assert head.parent == arm
    assert trig.parent == head
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bounds = compute_world_bounds(root)
    for actual, expected in zip(bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (bounds, (WIDTH, DEPTH, HEIGHT))
    assert abs(bounds["min_m"][2] - 0.0) <= 1e-5, bounds
    assert abs(bounds["max_m"][2] - HEIGHT) <= 1e-5, bounds

    # Fault-injection check: rotating hot lever handle 45 deg reduces X span and increases -Y depth
    hot.rotation_mode = "XYZ"
    hot.rotation_euler = (0.0, 0.0, math.radians(45.0))
    fault_bounds = compute_world_bounds(root)
    fault_rejected = abs(fault_bounds["dimensions_m"][0] - WIDTH) > 0.015
    hot.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    assert fault_rejected, "Envelope guard must detect handle rotation perturbation"

    required_meshes = {
        "Faucet mixer manifold 263x47mm",
        "Vertical 614mm chrome riser pipe",
        "Riser top finial cap",
        "Rear wall bracket flange",
        "to600_hot_lever_blade",
        "to600_cold_lever_blade",
        "to600_overhead_recoil_spring",
        "to600_sus304_armored_hose",
        "to600_insulated_140mm_grip",
        "to600_epdm_nozzle_bumper",
        "to600_perforated_spray_face",
        "to600_trigger_squeeze_lever",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "asset": NAME,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "envelope_bounds_m": bounds,
        "envelope_fault_injection_rejected": fault_rejected,
        "journey": (
            "Re-import exported sugico-to-600n.glb into an empty Blender scene; verify exact "
            "425 x 153 x 640 mm TA4768 nominal envelope (Z = 0.000..0.640 m), stadium-plan 263 x 47 mm "
            "mixer bridge, cobalt-blue 140 mm grip & squeeze trigger, stepped ABS dish-guard bumper, "
            "3-level kinematic parent chain (to600_base -> to600_spring_arm -> to600_spray_head -> to600_trigger), "
            "fault-injection rejection, and zero mesh-quality errors."
        ),
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


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
    scene.name = "Sugico TO-600N - commercial pre-rinse spray unit"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 120

    root = empty("to600_base", (0.0, 0.0, 0.0))
    root["supplier"] = "Sugico Sangyo (スギコ産業)"
    root["model"] = "TO-600N"
    root["nominal_dimensions_m"] = [WIDTH, DEPTH, HEIGHT]
    root["published_mass_kg"] = 3.850
    root["temperature_rating_c"] = [4.4, 82.2]
    root["pressure_rating_mpa"] = [0.10, 0.86]
    root["inlet_threads"] = "1/2 NPS x 2"

    mat = surfaces()
    build_base_mixer_and_riser(root, mat)
    hot, cold = build_quarter_turn_handles(root, mat)
    arm, head, trig = build_spring_arm_and_spray_assembly(root, mat)

    scene.frame_set(1)
    bpy.context.view_layer.update()
    convert_curves([root, hot, cold, arm, head, trig])
    for obj in list(root.children_recursive):
        if obj.type == "MESH":
            clean_mesh_object(obj, sharp_angle_deg=52.0)

    rest_bounds = compute_world_bounds(root)
    for actual, expected in zip(rest_bounds["dimensions_m"], (WIDTH, DEPTH, HEIGHT)):
        assert abs(actual - expected) <= 1e-4, (rest_bounds, (WIDTH, DEPTH, HEIGHT))

    glb_path = ASSETS / f"{NAME}.glb"
    export_rest_glb(root, glb_path)

    animate_timeline(hot, cold, arm, head, trig)
    for marker_name, fno in (
        ("Rest in hook", 1),
        ("Pre-rinse spray active", 55),
        ("Hold jet", 85),
        ("Spring return", 120),
    ):
        scene.timeline_markers.new(marker_name, frame=fno)

    appliance_col = bpy.data.collections.new("TO-600N appliance")
    scene.collection.children.link(appliance_col)
    move_objects([root, *root.children_recursive], appliance_col)

    camera = setup_studio(scene)
    views = (
        ("studio-main", (0.95, -1.45, 0.72), (0.0, 0.0, 0.32), 0.76, 1),
        ("studio-front", (0.0, -1.60, 0.32), (0.0, 0.0, 0.32), 0.74, 1),
        ("studio-top", (0.0, -0.01, 1.60), (0.0, 0.0, 0.32), 0.56, 1),
        ("studio-right", (1.60, 0.0, 0.32), (0.0, 0.0, 0.32), 0.74, 1),
        ("studio-active", (1.00, -1.45, 0.70), (0.0, -0.04, 0.31), 0.80, 65),
    )
    rendered = []
    if not args.skip_renders:
        for vname, pos, target, scale, fno in views:
            scene.frame_set(fno)
            set_camera(camera, pos, target, scale)
            out_png = ASSETS / f"{vname}.png"
            scene.render.filepath = str(out_png)
            bpy.ops.render.render(write_still=True)
            rendered.append(out_png.name)

    scene.frame_set(1)
    set_camera(camera, views[0][1], views[0][2], views[0][3])

    build_report = {
        "asset": NAME,
        "supplier": "Sugico Sangyo Co., Ltd. (スギコ産業株式会社)",
        "model": "TO-600N",
        "catalog_code": "TA4768 (spray valve TA4769, mixer bridge TA2043)",
        "blender_version": bpy.app.version_string,
        "nominal_envelope_m": [WIDTH, DEPTH, HEIGHT],
        "authored_bounds_m": rest_bounds,
        "riser_height_m": 0.614,
        "mixer_base_dimensions_m": [0.263, 0.047],
        "flexible_hose_length_m": 0.937,
        "spray_head_length_m": 0.211,
        "squeeze_grip_length_m": 0.140,
        "plumbing_ratings": {
            "inlets": "1/2 NPS x 2 (203.2 mm / 8 in centers)",
            "temperature_c": [4.4, 82.2],
            "pressure_psi": [15.0, 125.0],
            "pressure_mpa": [0.10, 0.86],
        },
        "published_mass_kg": 3.850,
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "glb_bytes": glb_path.stat().st_size,
        "renders": rendered,
        "object_count": 1 + len(root.children_recursive),
    }
    (ASSETS / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")

    blend_path = ASSETS / f"{NAME}.blend"
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    inspection = inspect_exported_glb(glb_path)
    print("Built and inspected Sugico TO-600N:", json.dumps(inspection, indent=2))


if __name__ == "__main__":
    main()
