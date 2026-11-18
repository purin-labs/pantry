"""Build rigged GLB models for Satyr Kitchen human workers, visitors, and botanical planters.

Run with Blender:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/bakery-robots/build_living_assets.py
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT_DIR / "assets/bakery-living"
HUMAN_GLB = OUT_DIR / "human-patissier.glb"
PLANTS_GLB = OUT_DIR / "botanical-planters.glb"


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(
    name: str,
    color: tuple[float, float, float],
    roughness: float = 0.58,
    metallic: float = 0.02,
    double_sided: bool = False,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def y_up_to_blender(x: float, y: float, z: float) -> Vector:
    """Convert Three.js Y-up (+X right, +Y up, +Z forward) to Blender Z-up."""
    return Vector((x, -z, y))


def create_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    smooth: bool = True,
) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = smooth
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def add_lofted_tube(
    bm: bmesh.types.BMesh,
    rings: list[tuple[Vector, float, float, float]],
    segments: int = 24,
    cap_start: bool = False,
    cap_end: bool = False,
    pleat_amp: float = 0.0,
    pleat_count: int = 0,
) -> None:
    """Loft elliptical cross-sections in Three.js Y-up coords (center, rx, rz, yaw)."""
    ring_verts: list[list[bmesh.types.BMVert]] = []
    for center_yup, rx, rz, yaw in rings:
        verts: list[bmesh.types.BMVert] = []
        cy = math.cos(yaw)
        sy = math.sin(yaw)
        for i in range(segments):
            theta = (2.0 * math.pi * i) / segments
            pleat = (
                1.0 + pleat_amp * math.cos(pleat_count * theta)
                if pleat_amp > 0.0 and pleat_count > 0
                else 1.0
            )
            lx = math.cos(theta) * rx * pleat
            lz = math.sin(theta) * rz * pleat
            wx = center_yup.x + lx * cy + lz * sy
            wz = center_yup.z - lx * sy + lz * cy
            wy = center_yup.y
            verts.append(bm.verts.new(y_up_to_blender(wx, wy, wz)))
        ring_verts.append(verts)

    for r_idx in range(len(ring_verts) - 1):
        r0 = ring_verts[r_idx]
        r1 = ring_verts[r_idx + 1]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))

    if cap_start and ring_verts:
        c0 = rings[0][0]
        vc = bm.verts.new(y_up_to_blender(c0.x, c0.y, c0.z))
        r0 = ring_verts[0]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((vc, r0[j], r0[i]))

    if cap_end and ring_verts:
        c1 = rings[-1][0]
        vc = bm.verts.new(y_up_to_blender(c1.x, c1.y, c1.z))
        r1 = ring_verts[-1]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((r1[i], r1[j], vc))


def add_oriented_limb_tube(
    bm: bmesh.types.BMesh,
    stations: list[tuple[Vector, Vector, Vector, float, float]],
    segments: int = 18,
    cap_start: bool = False,
    cap_end: bool = True,
) -> None:
    """Loft cross-sections along arbitrary 3D curves: (center, axis_u, axis_v, ru, rv) in Y-up."""
    ring_verts: list[list[bmesh.types.BMVert]] = []
    for center, axis_u, axis_v, ru, rv in stations:
        u = axis_u.normalized()
        v = axis_v.normalized()
        verts: list[bmesh.types.BMVert] = []
        for i in range(segments):
            theta = (2.0 * math.pi * i) / segments
            p = center + u * (math.cos(theta) * ru) + v * (math.sin(theta) * rv)
            verts.append(bm.verts.new(y_up_to_blender(p.x, p.y, p.z)))
        ring_verts.append(verts)

    for r_idx in range(len(ring_verts) - 1):
        r0 = ring_verts[r_idx]
        r1 = ring_verts[r_idx + 1]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))

    if cap_start and ring_verts:
        c0 = stations[0][0]
        vc = bm.verts.new(y_up_to_blender(c0.x, c0.y, c0.z))
        r0 = ring_verts[0]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((vc, r0[j], r0[i]))

    if cap_end and ring_verts:
        c1 = stations[-1][0]
        vc = bm.verts.new(y_up_to_blender(c1.x, c1.y, c1.z))
        r1 = ring_verts[-1]
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((r1[i], r1[j], vc))


def add_ellipsoid(
    bm: bmesh.types.BMesh,
    center_yup: Vector,
    radii_yup: tuple[float, float, float],
    u_seg: int = 20,
    v_seg: int = 14,
    rot_euler_yup: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[bmesh.types.BMVert]:
    rx, ry, rz = radii_yup
    rot = Euler(rot_euler_yup, "XYZ").to_matrix()
    created: list[bmesh.types.BMVert] = []
    top = bm.verts.new(
        y_up_to_blender(*(center_yup + rot @ Vector((0.0, ry, 0.0))))
    )
    bottom = bm.verts.new(
        y_up_to_blender(*(center_yup + rot @ Vector((0.0, -ry, 0.0))))
    )
    created.extend((top, bottom))
    rings: list[list[bmesh.types.BMVert]] = []
    for iv in range(1, v_seg):
        phi = (math.pi * iv) / v_seg
        sin_p = math.sin(phi)
        cos_p = math.cos(phi)
        ring: list[bmesh.types.BMVert] = []
        for iu in range(u_seg):
            theta = (2.0 * math.pi * iu) / u_seg
            local = Vector(
                (
                    rx * sin_p * math.cos(theta),
                    ry * cos_p,
                    rz * sin_p * math.sin(theta),
                )
            )
            world = center_yup + rot @ local
            v = bm.verts.new(y_up_to_blender(world.x, world.y, world.z))
            ring.append(v)
            created.append(v)
        rings.append(ring)

    for iu in range(u_seg):
        ju = (iu + 1) % u_seg
        bm.faces.new((top, rings[0][ju], rings[0][iu]))
        bm.faces.new((rings[-1][iu], rings[-1][ju], bottom))

    for r_idx in range(len(rings) - 1):
        r0 = rings[r_idx]
        r1 = rings[r_idx + 1]
        for iu in range(u_seg):
            ju = (iu + 1) % u_seg
            bm.faces.new((r0[iu], r0[ju], r1[ju], r1[iu]))
    return created


def point_segment_dist_sq(p: Vector, a: Vector, b: Vector) -> float:
    ab = b - a
    len_sq = ab.length_squared
    if len_sq < 1e-10:
        return (p - a).length_squared
    t = max(0.0, min(1.0, (p - a).dot(ab) / len_sq))
    proj = a + ab * t
    return (p - proj).length_squared


def bind_skinned_mesh(
    obj: bpy.types.Object,
    armature_obj: bpy.types.Object,
    bone_capsules: list[tuple[str, Vector, Vector, float]],
    smooth_passes: int = 3,
    side_filter: bool = False,
) -> None:
    """Assign smooth, normalized max-4 bone weights and bind Armature modifier."""
    obj.parent = armature_obj
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = armature_obj

    mesh: bpy.types.Mesh = obj.data
    bone_names = [b[0] for b in bone_capsules]
    for bname in bone_names:
        if bname not in obj.vertex_groups:
            obj.vertex_groups.new(name=bname)

    n_verts = len(mesh.vertices)
    weights: list[dict[str, float]] = [{} for _ in range(n_verts)]

    # Convert bone capsules from Y-up to Blender Z-up once
    capsules_bl = [
        (
            bname,
            y_up_to_blender(a.x, a.y, a.z),
            y_up_to_blender(b.x, b.y, b.z),
            sigma,
        )
        for (bname, a, b, sigma) in bone_capsules
    ]

    for idx, v in enumerate(mesh.vertices):
        co = v.co
        raw: dict[str, float] = {}
        for bname, a_bl, b_bl, sigma in capsules_bl:
            if side_filter:
                if bname.startswith("left_") and co.x > 0.025:
                    continue
                if bname.startswith("right_") and co.x < -0.025:
                    continue
            d2 = point_segment_dist_sq(co, a_bl, b_bl)
            w = math.exp(-d2 / (2.0 * sigma * sigma))
            if w > 1e-5:
                raw[bname] = raw.get(bname, 0.0) + w
        if not raw:
            # Fallback to nearest capsule
            best_name = capsules_bl[0][0]
            best_d2 = float("inf")
            for bname, a_bl, b_bl, _ in capsules_bl:
                d2 = point_segment_dist_sq(co, a_bl, b_bl)
                if d2 < best_d2:
                    best_d2 = d2
                    best_name = bname
            raw[best_name] = 1.0
        total = sum(raw.values())
        weights[idx] = {k: val / total for k, val in raw.items()}

    if smooth_passes > 0 and len(mesh.edges) > 0:
        adj: list[list[int]] = [[] for _ in range(n_verts)]
        for edge in mesh.edges:
            v0, v1 = edge.vertices[0], edge.vertices[1]
            adj[v0].append(v1)
            adj[v1].append(v0)

        for _ in range(smooth_passes):
            next_weights: list[dict[str, float]] = [{} for _ in range(n_verts)]
            for idx in range(n_verts):
                nbrs = adj[idx]
                if not nbrs:
                    next_weights[idx] = weights[idx]
                    continue
                acc: dict[str, float] = {}
                for k, val in weights[idx].items():
                    acc[k] = acc.get(k, 0.0) + val * 0.55
                share = 0.45 / len(nbrs)
                for nb in nbrs:
                    for k, val in weights[nb].items():
                        acc[k] = acc.get(k, 0.0) + val * share
                total = sum(acc.values())
                next_weights[idx] = {k: val / total for k, val in acc.items()}
            weights = next_weights

    # Clamp to top 4 influences and normalize cleanly for glTF 2.0 JOINTS_0/WEIGHTS_0
    for idx, wmap in enumerate(weights):
        top4 = sorted(wmap.items(), key=lambda kv: kv[1], reverse=True)[:4]
        total = sum(val for _, val in top4)
        if total <= 0.0:
            continue
        for bname, val in top4:
            norm_val = val / total
            if norm_val > 1e-4:
                obj.vertex_groups[bname].add([idx], norm_val, "REPLACE")


def build_human_patissier_scene() -> None:
    clear_scene()

    # Materials (tagged by semantic name for per-worker tinting in Three.js)
    mat_skin = make_material("mat_skin", (0.91, 0.74, 0.62), roughness=0.50, metallic=0.01)
    mat_hair = make_material("mat_hair", (0.16, 0.11, 0.09), roughness=0.70, metallic=0.02)
    mat_jacket = make_material("mat_jacket", (0.97, 0.98, 0.99), roughness=0.56, metallic=0.02)
    mat_jacket_trim = make_material("mat_jacket_trim", (0.80, 0.84, 0.89), roughness=0.52, metallic=0.05)
    mat_accent = make_material("mat_accent", (0.25, 0.45, 0.69), roughness=0.54, metallic=0.04, double_sided=True)
    mat_trouser = make_material("mat_trouser", (0.15, 0.19, 0.25), roughness=0.66, metallic=0.03)
    mat_shoe = make_material("mat_shoe", (0.09, 0.11, 0.14), roughness=0.40, metallic=0.10)
    mat_sole = make_material("mat_sole", (0.12, 0.15, 0.19), roughness=0.78, metallic=0.04)
    mat_eye_white = make_material("mat_eye_white", (0.99, 0.99, 1.00), roughness=0.18, metallic=0.0)
    mat_eye_iris = make_material("mat_eye_iris", (0.24, 0.17, 0.12), roughness=0.22, metallic=0.02)
    mat_dark = make_material("mat_dark", (0.07, 0.09, 0.12), roughness=0.25, metallic=0.10)
    mat_lip = make_material("mat_lip", (0.76, 0.48, 0.41), roughness=0.48, metallic=0.01)
    mat_steel = make_material("mat_steel", (0.85, 0.88, 0.91), roughness=0.24, metallic=0.86)
    mat_towel = make_material("mat_towel", (0.95, 0.94, 0.90), roughness=0.74, metallic=0.01)
    mat_batter = make_material("mat_batter", (0.85, 0.61, 0.26), roughness=0.30, metallic=0.02)
    mat_ballotin = make_material("mat_ballotin", (0.96, 0.94, 0.89), roughness=0.44, metallic=0.03)
    mat_ribbon = make_material("mat_ribbon", (0.79, 0.58, 0.27), roughness=0.30, metallic=0.38)

    # 1. Build 15-bone Armature in exact Three.js Y-up -> Blender Z-up coordinates
    arm_data = bpy.data.armatures.new("human_armature_data")
    arm_obj = bpy.data.objects.new("human_armature", arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    joint_positions_yup: dict[str, tuple[Vector, str | None]] = {
        "pelvis": (Vector((0.0, 0.84, 0.0)), None),
        "spine": (Vector((0.0, 0.89, 0.0)), "pelvis"),
        "neck": (Vector((0.0, 1.335, 0.004)), "spine"),
        "head": (Vector((0.0, 1.43, 0.008)), "neck"),
        "left_hip": (Vector((-0.086, 0.82, 0.0)), "pelvis"),
        "left_knee": (Vector((-0.086, 0.45, 0.004)), "left_hip"),
        "left_ankle": (Vector((-0.086, 0.085, 0.0)), "left_knee"),
        "right_hip": (Vector((0.086, 0.82, 0.0)), "pelvis"),
        "right_knee": (Vector((0.086, 0.45, 0.004)), "right_hip"),
        "right_ankle": (Vector((0.086, 0.085, 0.0)), "right_knee"),
        "left_shoulder": (Vector((-0.172, 1.275, -0.006)), "spine"),
        "left_elbow": (Vector((-0.180, 1.025, -0.004)), "left_shoulder"),
        "left_wrist": (Vector((-0.182, 0.805, 0.006)), "left_elbow"),
        "right_shoulder": (Vector((0.172, 1.275, -0.006)), "spine"),
        "right_elbow": (Vector((0.180, 1.025, -0.004)), "right_shoulder"),
        "right_wrist": (Vector((0.182, 0.805, 0.006)), "right_elbow"),
    }

    edit_bones: dict[str, bpy.types.EditBone] = {}
    for bname, (pos_yup, parent_name) in joint_positions_yup.items():
        eb = arm_data.edit_bones.new(bname)
        head_bl = y_up_to_blender(pos_yup.x, pos_yup.y, pos_yup.z)
        eb.head = head_bl
        eb.tail = head_bl + Vector((0.0, 0.0, 0.08))
        eb.roll = 0.0
        eb.use_connect = False
        if parent_name is not None:
            eb.parent = edit_bones[parent_name]
        edit_bones[bname] = eb

    bpy.ops.object.mode_set(mode="OBJECT")

    # 2. Tailored Trousers (continuous pelvis saddle + sculpted thighs + knees + calves)
    bm_trousers = bmesh.new()
    add_lofted_tube(
        bm_trousers,
        [
            (Vector((0.0, 0.77, -0.004)), 0.132, 0.098, 0.0),
            (Vector((0.0, 0.815, -0.002)), 0.144, 0.108, 0.0),
            (Vector((0.0, 0.865, 0.0)), 0.138, 0.102, 0.0),
            (Vector((0.0, 0.905, 0.002)), 0.132, 0.096, 0.0),
        ],
        segments=26,
        cap_start=True,
        cap_end=True,
    )
    for side in (-1.0, 1.0):
        lx = side * 0.086
        add_lofted_tube(
            bm_trousers,
            [
                (Vector((lx * 0.94, 0.835, 0.0)), 0.072, 0.080, 0.0),
                (Vector((lx, 0.74, 0.002)), 0.068, 0.074, 0.0),
                (Vector((lx, 0.60, 0.004)), 0.061, 0.065, 0.0),
                (Vector((lx, 0.46, 0.005)), 0.054, 0.057, 0.0),
                (Vector((lx, 0.34, 0.002)), 0.052, 0.055, 0.0),
                (Vector((lx, 0.21, -0.001)), 0.044, 0.046, 0.0),
                (Vector((lx, 0.115, 0.0)), 0.041, 0.043, 0.0),
                (Vector((lx, 0.092, 0.002)), 0.043, 0.045, 0.0),
            ],
            segments=20,
            cap_start=True,
            cap_end=True,
        )
    obj_trousers = create_mesh_object("mesh_trousers", bm_trousers, mat_trouser)
    bind_skinned_mesh(
        obj_trousers,
        arm_obj,
        [
            ("pelvis", Vector((-0.07, 0.84, 0.0)), Vector((0.07, 0.88, 0.0)), 0.10),
            ("left_hip", Vector((-0.086, 0.80, 0.0)), Vector((-0.086, 0.47, 0.004)), 0.09),
            ("left_knee", Vector((-0.086, 0.45, 0.004)), Vector((-0.086, 0.11, 0.0)), 0.085),
            ("left_ankle", Vector((-0.086, 0.10, 0.0)), Vector((-0.086, 0.08, 0.0)), 0.06),
            ("right_hip", Vector((0.086, 0.80, 0.0)), Vector((0.086, 0.47, 0.004)), 0.09),
            ("right_knee", Vector((0.086, 0.45, 0.004)), Vector((0.086, 0.11, 0.0)), 0.085),
            ("right_ankle", Vector((0.086, 0.10, 0.0)), Vector((0.086, 0.08, 0.0)), 0.06),
        ],
        smooth_passes=4,
        side_filter=True,
    )

    # 3. Kitchen Clogs & Non-Slip Soles (skinned cleanly to ankles, flush at Y=0.000)
    bm_shoes = bmesh.new()
    bm_soles = bmesh.new()
    for side in (-1.0, 1.0):
        lx = side * 0.086
        # Sock ankle cuff
        add_lofted_tube(
            bm_shoes,
            [
                (Vector((lx, 0.098, 0.0)), 0.034, 0.036, 0.0),
                (Vector((lx, 0.055, 0.004)), 0.037, 0.042, 0.0),
            ],
            segments=16,
            cap_start=True,
            cap_end=False,
        )
        # Contoured clog upper from heel (z=-0.055) to rounded toe box (z=+0.135)
        add_oriented_limb_tube(
            bm_shoes,
            [
                (Vector((lx, 0.036, -0.052)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.038, 0.024),
                (Vector((lx, 0.044, -0.015)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.044, 0.032),
                (Vector((lx, 0.046, 0.038)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.046, 0.034),
                (Vector((lx, 0.038, 0.092)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.043, 0.026),
                (Vector((lx, 0.026, 0.128)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.032, 0.016),
            ],
            segments=18,
            cap_start=True,
            cap_end=True,
        )
        # Flat non-slip rubber sole flush on Y=0.000..0.018
        add_lofted_tube(
            bm_soles,
            [
                (Vector((lx, 0.001, 0.036)), 0.045, 0.096, 0.0),
                (Vector((lx, 0.010, 0.036)), 0.047, 0.099, 0.0),
                (Vector((lx, 0.019, 0.035)), 0.045, 0.096, 0.0),
            ],
            segments=20,
            cap_start=True,
            cap_end=True,
        )

    obj_shoes = create_mesh_object("mesh_shoes", bm_shoes, mat_shoe)
    obj_soles = create_mesh_object("mesh_shoe_soles", bm_soles, mat_sole)
    ankle_capsules = [
        ("left_ankle", Vector((-0.086, 0.09, -0.05)), Vector((-0.086, 0.01, 0.12)), 0.06),
        ("right_ankle", Vector((0.086, 0.09, -0.05)), Vector((0.086, 0.01, 0.12)), 0.06),
    ]
    bind_skinned_mesh(obj_shoes, arm_obj, ankle_capsules, smooth_passes=0, side_filter=True)
    bind_skinned_mesh(obj_soles, arm_obj, ankle_capsules, smooth_passes=0, side_filter=True)

    # 4. Double-Breasted French Patissier Jacket / Tailored Coat + Sleeves
    bm_jacket = bmesh.new()
    add_lofted_tube(
        bm_jacket,
        [
            (Vector((0.0, 0.79, 0.002)), 0.148, 0.108, 0.0),
            (Vector((0.0, 0.86, 0.003)), 0.143, 0.104, 0.0),
            (Vector((0.0, 0.96, 0.004)), 0.139, 0.102, 0.0),
            (Vector((0.0, 1.08, 0.006)), 0.152, 0.112, 0.0),
            (Vector((0.0, 1.20, 0.004)), 0.168, 0.116, 0.0),
            (Vector((0.0, 1.285, -0.002)), 0.172, 0.106, 0.0),
            (Vector((0.0, 1.328, 0.002)), 0.092, 0.078, 0.0),
            (Vector((0.0, 1.366, 0.005)), 0.064, 0.064, 0.0),
        ],
        segments=28,
        cap_start=True,
        cap_end=True,
    )
    # Tailored sleeves from shoulder cap down to rolled 3/4 pastry-chef forearm cuff
    for side in (-1.0, 1.0):
        sx = side * 0.172
        ex = side * 0.180
        add_lofted_tube(
            bm_jacket,
            [
                (Vector((sx * 0.88, 1.285, -0.005)), 0.056, 0.058, 0.0),
                (Vector((sx, 1.255, -0.006)), 0.053, 0.055, 0.0),
                (Vector((sx * 1.02, 1.15, -0.005)), 0.047, 0.049, 0.0),
                (Vector((ex, 1.03, -0.004)), 0.043, 0.045, 0.0),
                (Vector((ex * 1.005, 0.945, 0.0)), 0.040, 0.042, 0.0),
            ],
            segments=18,
            cap_start=True,
            cap_end=True,
        )
    obj_jacket = create_mesh_object("mesh_jacket", bm_jacket, mat_jacket)
    jacket_capsules = [
        ("pelvis", Vector((0.0, 0.79, 0.0)), Vector((0.0, 0.87, 0.0)), 0.09),
        ("spine", Vector((0.0, 0.89, 0.0)), Vector((0.0, 1.31, 0.0)), 0.12),
        ("neck", Vector((0.0, 1.33, 0.004)), Vector((0.0, 1.37, 0.005)), 0.065),
        ("left_shoulder", Vector((-0.165, 1.275, -0.006)), Vector((-0.180, 1.035, -0.004)), 0.075),
        ("left_elbow", Vector((-0.180, 1.025, -0.004)), Vector((-0.181, 0.93, 0.0)), 0.065),
        ("right_shoulder", Vector((0.165, 1.275, -0.006)), Vector((0.180, 1.035, -0.004)), 0.075),
        ("right_elbow", Vector((0.180, 1.025, -0.004)), Vector((0.181, 0.93, 0.0)), 0.065),
    ]
    bind_skinned_mesh(obj_jacket, arm_obj, jacket_capsules, smooth_passes=4, side_filter=True)

    # Jacket Trim (rolled sleeve cuffs, asymmetric placket overlap, breast pocket)
    bm_trim = bmesh.new()
    for side in (-1.0, 1.0):
        ex = side * 0.181
        add_lofted_tube(
            bm_trim,
            [
                (Vector((ex, 0.936, 0.0)), 0.042, 0.044, 0.0),
                (Vector((ex, 0.962, -0.001)), 0.043, 0.045, 0.0),
            ],
            segments=18,
            cap_start=True,
            cap_end=True,
        )
    # Placket seam & breast welt pocket
    add_lofted_tube(
        bm_trim,
        [
            (Vector((0.048, 0.98, 0.109)), 0.004, 0.004, 0.0),
            (Vector((0.048, 1.27, 0.114)), 0.004, 0.004, 0.0),
        ],
        segments=8,
        cap_start=True,
        cap_end=True,
    )
    add_ellipsoid(bm_trim, Vector((0.082, 1.19, 0.110)), (0.024, 0.026, 0.006), u_seg=12, v_seg=8)
    obj_trim = create_mesh_object("mesh_jacket_trim", bm_trim, mat_jacket_trim)
    bind_skinned_mesh(obj_trim, arm_obj, jacket_capsules, smooth_passes=2, side_filter=True)

    # Chef Jacket Double-Breasted Buttons & Pocket Thermometer (hidden on visitor)
    bm_buttons = bmesh.new()
    for bx in (-0.044, 0.044):
        for row in range(4):
            by = 1.05 + row * 0.056
            bz = 0.108 + (0.006 if row in (1, 2) else 0.002)
            add_ellipsoid(bm_buttons, Vector((bx, by, bz)), (0.007, 0.007, 0.005), u_seg=10, v_seg=8)
    obj_buttons = create_mesh_object("chef_buttons", bm_buttons, mat_dark)
    bind_skinned_mesh(
        obj_buttons,
        arm_obj,
        [("spine", Vector((0.0, 0.95, 0.08)), Vector((0.0, 1.30, 0.08)), 0.14)],
        smooth_passes=0,
    )

    bm_thermo = bmesh.new()
    add_lofted_tube(
        bm_thermo,
        [
            (Vector((0.078, 1.185, 0.114)), 0.0035, 0.0035, 0.0),
            (Vector((0.078, 1.232, 0.116)), 0.004, 0.004, 0.0),
            (Vector((0.078, 1.238, 0.116)), 0.008, 0.005, 0.0),
        ],
        segments=10,
        cap_start=True,
        cap_end=True,
    )
    obj_thermo = create_mesh_object("chef_thermometer", bm_thermo, mat_steel)
    bind_skinned_mesh(
        obj_thermo,
        arm_obj,
        [("spine", Vector((0.0, 1.15, 0.08)), Vector((0.0, 1.26, 0.08)), 0.14)],
        smooth_passes=0,
    )

    # 5. Chef Bistro Bib Apron (skinned across spine, pelvis, left_hip, right_hip so legs never poke through!)
    bm_apron = bmesh.new()
    # Open-back wrap skirt (-104 deg to +104 deg around +Z front, cleanly clearing trouser seat)
    skirt_rings: list[tuple[Vector, float, float, float]] = [
        (Vector((0.0, 0.50, 0.014)), 0.168, 0.128, 0.0),
        (Vector((0.0, 0.62, 0.012)), 0.163, 0.124, 0.0),
        (Vector((0.0, 0.74, 0.010)), 0.159, 0.120, 0.0),
        (Vector((0.0, 0.85, 0.008)), 0.156, 0.117, 0.0),
        (Vector((0.0, 0.945, 0.007)), 0.153, 0.115, 0.0),
    ]
    skirt_seg = 28
    skirt_verts: list[list[bmesh.types.BMVert]] = []
    for c_yup, rx, rz, _ in skirt_rings:
        row_v: list[bmesh.types.BMVert] = []
        for i in range(skirt_seg + 1):
            frac = i / skirt_seg
            ang = (frac - 0.5) * (math.pi * 1.16)
            pleat = 1.0 + 0.015 * math.cos(ang * 9.0) * (1.0 - (c_yup.y - 0.50) / 0.50)
            wx = math.sin(ang) * rx * pleat
            wz = c_yup.z + math.cos(ang) * rz * pleat
            row_v.append(bm_apron.verts.new(y_up_to_blender(wx, c_yup.y, wz)))
        skirt_verts.append(row_v)
    for r_i in range(len(skirt_verts) - 1):
        for i in range(skirt_seg):
            bm_apron.faces.new(
                (
                    skirt_verts[r_i][i],
                    skirt_verts[r_i][i + 1],
                    skirt_verts[r_i + 1][i + 1],
                    skirt_verts[r_i + 1][i],
                )
            )
    # Contoured chest bib curved cleanly outside the jacket front (+Z = 0.127..0.131)
    bib_rows = [
        (0.94, 0.108, 0.123),
        (1.03, 0.102, 0.127),
        (1.12, 0.094, 0.130),
        (1.205, 0.085, 0.130),
    ]
    bib_cols = 10
    bib_grid: list[list[bmesh.types.BMVert]] = []
    for by, half_w, front_z in bib_rows:
        row_v = []
        for ic in range(bib_cols + 1):
            u = (ic / bib_cols) * 2.0 - 1.0
            wx = u * half_w
            wz = front_z * math.cos(u * 0.44)
            row_v.append(bm_apron.verts.new(y_up_to_blender(wx, by, wz)))
        bib_grid.append(row_v)
    for r_i in range(len(bib_grid) - 1):
        for ic in range(bib_cols):
            bm_apron.faces.new(
                (
                    bib_grid[r_i][ic],
                    bib_grid[r_i][ic + 1],
                    bib_grid[r_i + 1][ic + 1],
                    bib_grid[r_i + 1][ic],
                )
            )
    # Neck halter straps from top corners of bib up beside collar
    for side in (-1.0, 1.0):
        add_oriented_limb_tube(
            bm_apron,
            [
                (Vector((side * 0.076, 1.20, 0.118)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.009, 0.003),
                (Vector((side * 0.072, 1.27, 0.088)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.008, 0.003),
                (Vector((side * 0.068, 1.328, 0.032)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.007, 0.003),
            ],
            segments=8,
            cap_start=True,
            cap_end=True,
        )

    obj_apron = create_mesh_object("chef_apron", bm_apron, mat_accent)
    bind_skinned_mesh(
        obj_apron,
        arm_obj,
        [
            ("spine", Vector((0.0, 0.92, 0.05)), Vector((0.0, 1.24, 0.08)), 0.11),
            ("pelvis", Vector((-0.06, 0.84, 0.02)), Vector((0.06, 0.90, 0.02)), 0.10),
            ("left_hip", Vector((-0.086, 0.78, 0.04)), Vector((-0.086, 0.50, 0.04)), 0.105),
            ("right_hip", Vector((0.086, 0.78, 0.04)), Vector((0.086, 0.50, 0.04)), 0.105),
        ],
        smooth_passes=5,
    )

    # Apron Waist Sash + Chef Neckerchief (tour de cou) + Folded Side Towel
    bm_accent_trim = bmesh.new()
    add_lofted_tube(
        bm_accent_trim,
        [
            (Vector((0.0, 0.935, 0.006)), 0.156, 0.118, 0.0),
            (Vector((0.0, 0.956, 0.006)), 0.156, 0.118, 0.0),
        ],
        segments=28,
        cap_start=True,
        cap_end=True,
    )
    # Neckerchief collar roll + front knot
    add_lofted_tube(
        bm_accent_trim,
        [
            (Vector((0.0, 1.328, 0.008)), 0.076, 0.074, 0.0),
            (Vector((0.0, 1.348, 0.008)), 0.072, 0.071, 0.0),
        ],
        segments=22,
        cap_start=True,
        cap_end=True,
    )
    add_ellipsoid(
        bm_accent_trim,
        Vector((0.0, 1.312, 0.084)),
        (0.020, 0.028, 0.016),
        u_seg=12,
        v_seg=8,
        rot_euler_yup=(-0.2, 0.0, 0.0),
    )
    obj_accent_trim = create_mesh_object("chef_accent_trim", bm_accent_trim, mat_accent)
    bind_skinned_mesh(
        obj_accent_trim,
        arm_obj,
        [
            ("spine", Vector((0.0, 0.93, 0.0)), Vector((0.0, 1.35, 0.0)), 0.14),
        ],
        smooth_passes=1,
    )

    bm_towel = bmesh.new()
    add_lofted_tube(
        bm_towel,
        [
            (Vector((-0.138, 0.76, 0.068)), 0.024, 0.009, 0.35),
            (Vector((-0.142, 0.85, 0.066)), 0.022, 0.008, 0.35),
            (Vector((-0.140, 0.938, 0.062)), 0.018, 0.007, 0.35),
        ],
        segments=12,
        cap_start=True,
        cap_end=True,
    )
    obj_towel = create_mesh_object("chef_side_towel", bm_towel, mat_towel)
    bind_skinned_mesh(
        obj_towel,
        arm_obj,
        [
            ("pelvis", Vector((-0.12, 0.84, 0.04)), Vector((-0.12, 0.92, 0.04)), 0.10),
            ("left_hip", Vector((-0.11, 0.78, 0.04)), Vector((-0.11, 0.72, 0.04)), 0.09),
        ],
        smooth_passes=2,
    )

    # Visitor Soft Draped Scarf (hidden on chef, visible on customer-visitor)
    bm_scarf = bmesh.new()
    add_lofted_tube(
        bm_scarf,
        [
            (Vector((0.0, 1.295, 0.018)), 0.096, 0.088, 0.0),
            (Vector((0.0, 1.332, 0.012)), 0.086, 0.082, 0.0),
            (Vector((0.0, 1.362, 0.008)), 0.078, 0.076, 0.0),
        ],
        segments=24,
        cap_start=True,
        cap_end=True,
    )
    # Draped front scarf tail
    add_lofted_tube(
        bm_scarf,
        [
            (Vector((0.022, 1.14, 0.118)), 0.032, 0.009, 0.08),
            (Vector((0.016, 1.23, 0.115)), 0.030, 0.010, 0.05),
            (Vector((0.008, 1.30, 0.098)), 0.026, 0.012, 0.0),
        ],
        segments=12,
        cap_start=True,
        cap_end=True,
    )
    obj_scarf = create_mesh_object("customer_scarf", bm_scarf, mat_accent)
    bind_skinned_mesh(
        obj_scarf,
        arm_obj,
        [
            ("spine", Vector((0.0, 1.14, 0.04)), Vector((0.0, 1.34, 0.02)), 0.12),
            ("neck", Vector((0.0, 1.34, 0.01)), Vector((0.0, 1.37, 0.01)), 0.07),
        ],
        smooth_passes=2,
    )

    # 6. Anatomical Skin: Neck, Sculpted Head, Nose, Ears, Forearms & 5-Fingered Hands
    bm_skin = bmesh.new()
    # Neck column
    add_lofted_tube(
        bm_skin,
        [
            (Vector((0.0, 1.33, 0.002)), 0.048, 0.050, 0.0),
            (Vector((0.0, 1.375, 0.005)), 0.043, 0.045, 0.0),
            (Vector((0.0, 1.415, 0.008)), 0.046, 0.048, 0.0),
        ],
        segments=20,
        cap_start=True,
        cap_end=True,
    )
    # Sculpted Cranium + Cheekbones + Jawline + Chin loft
    add_lofted_tube(
        bm_skin,
        [
            (Vector((0.0, 1.368, 0.026)), 0.036, 0.042, 0.0),  # chin base
            (Vector((0.0, 1.392, 0.016)), 0.064, 0.072, 0.0),  # jawline
            (Vector((0.0, 1.425, 0.008)), 0.079, 0.085, 0.0),  # cheeks
            (Vector((0.0, 1.462, 0.004)), 0.083, 0.088, 0.0),  # eye/temple level
            (Vector((0.0, 1.502, 0.002)), 0.082, 0.089, 0.0),  # forehead
            (Vector((0.0, 1.535, -0.002)), 0.068, 0.074, 0.0), # upper dome
            (Vector((0.0, 1.552, -0.004)), 0.034, 0.038, 0.0), # crown
        ],
        segments=26,
        cap_start=True,
        cap_end=True,
    )
    # Sculpted Nose bridge & tip
    add_oriented_limb_tube(
        bm_skin,
        [
            (Vector((0.0, 1.466, 0.088)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.008, 0.008),
            (Vector((0.0, 1.444, 0.100)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.010, 0.012),
            (Vector((0.0, 1.430, 0.105)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.012, 0.011),
            (Vector((0.0, 1.424, 0.095)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.011, 0.007),
        ],
        segments=12,
        cap_start=True,
        cap_end=True,
    )
    # Ears
    for side in (-1.0, 1.0):
        add_ellipsoid(
            bm_skin,
            Vector((side * 0.084, 1.448, 0.000)),
            (0.010, 0.024, 0.015),
            u_seg=12,
            v_seg=10,
            rot_euler_yup=(-0.12, side * 0.22, 0.0),
        )

    # Continuous seamless Forearm -> Wrist -> Palm tube + Thumb + 4 Sculpted Fingers
    for side in (-1.0, 1.0):
        ex = side * 0.181
        wx = side * 0.182
        add_lofted_tube(
            bm_skin,
            [
                (Vector((ex, 0.955, 0.0)), 0.035, 0.036, 0.0),
                (Vector((ex, 0.895, 0.003)), 0.031, 0.033, 0.0),
                (Vector((wx, 0.835, 0.005)), 0.024, 0.027, 0.0),
                (Vector((wx, 0.805, 0.006)), 0.019, 0.025, 0.0),
                (Vector((wx - side * 0.002, 0.785, 0.009)), 0.016, 0.031, 0.0),
                (Vector((wx - side * 0.004, 0.764, 0.011)), 0.015, 0.033, 0.0),
                (Vector((wx - side * 0.005, 0.752, 0.012)), 0.013, 0.030, 0.0),
            ],
            segments=18,
            cap_start=True,
            cap_end=True,
        )
        # Opposable Thumb (3 stations curving slightly forward +Z and inward)
        add_oriented_limb_tube(
            bm_skin,
            [
                (Vector((wx - side * 0.008, 0.792, 0.028)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.009, 0.010),
                (Vector((wx - side * 0.015, 0.774, 0.042)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.0075, 0.008),
                (Vector((wx - side * 0.019, 0.758, 0.050)), Vector((1, 0, 0)), Vector((0, 0, 1)), 0.006, 0.0065),
            ],
            segments=10,
            cap_start=True,
            cap_end=True,
        )
        # 4 Distinct Gently Curved Fingers (index, middle, ring, little)
        finger_specs = [
            (0.022, 0.046, 0.0062),
            (0.007, 0.050, 0.0064),
            (-0.008, 0.046, 0.0060),
            (-0.022, 0.038, 0.0052),
        ]
        for z_off, f_len, f_rad in finger_specs:
            base_z = 0.012 + z_off
            add_oriented_limb_tube(
                bm_skin,
                [
                    (Vector((wx - side * 0.005, 0.754, base_z)), Vector((1, 0, 0)), Vector((0, 0, 1)), f_rad, f_rad),
                    (Vector((wx - side * 0.009, 0.754 - f_len * 0.52, base_z + 0.005)), Vector((1, 0, 0)), Vector((0, 0, 1)), f_rad * 0.88, f_rad * 0.88),
                    (Vector((wx - side * 0.015, 0.754 - f_len, base_z + 0.012)), Vector((1, 0, 0)), Vector((0, 0, 1)), f_rad * 0.72, f_rad * 0.72),
                ],
                segments=10,
                cap_start=True,
                cap_end=True,
            )

    obj_skin = create_mesh_object("mesh_skin", bm_skin, mat_skin)
    bind_skinned_mesh(
        obj_skin,
        arm_obj,
        [
            ("neck", Vector((0.0, 1.33, 0.004)), Vector((0.0, 1.40, 0.006)), 0.055),
            ("head", Vector((0.0, 1.41, 0.008)), Vector((0.0, 1.55, 0.005)), 0.095),
            ("left_elbow", Vector((-0.180, 0.96, 0.0)), Vector((-0.182, 0.82, 0.005)), 0.055),
            ("left_wrist", Vector((-0.182, 0.805, 0.006)), Vector((-0.195, 0.71, 0.02)), 0.055),
            ("right_elbow", Vector((0.180, 0.96, 0.0)), Vector((0.182, 0.82, 0.005)), 0.055),
            ("right_wrist", Vector((0.182, 0.805, 0.006)), Vector((0.195, 0.71, 0.02)), 0.055),
        ],
        smooth_passes=3,
        side_filter=True,
    )

    # Eyes (Sclera, Iris, Pupil), Brows & Natural Lips (100% bound to head)
    head_only = [("head", Vector((0.0, 1.44, 0.0)), Vector((0.0, 1.55, 0.0)), 0.25)]

    bm_sclera = bmesh.new()
    bm_iris = bmesh.new()
    bm_pupil = bmesh.new()
    bm_brows = bmesh.new()
    for side in (-1.0, 1.0):
        ex = side * 0.030
        add_ellipsoid(bm_sclera, Vector((ex, 1.458, 0.086)), (0.0125, 0.0095, 0.0085), u_seg=14, v_seg=10)
        add_ellipsoid(bm_iris, Vector((ex, 1.458, 0.092)), (0.0070, 0.0070, 0.0040), u_seg=12, v_seg=8)
        add_ellipsoid(bm_pupil, Vector((ex, 1.458, 0.0948)), (0.0038, 0.0038, 0.0028), u_seg=10, v_seg=8)
        add_oriented_limb_tube(
            bm_brows,
            [
                (Vector((side * 0.016, 1.474, 0.091)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0032, 0.0035),
                (Vector((side * 0.031, 1.477, 0.089)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0034, 0.0035),
                (Vector((side * 0.045, 1.473, 0.083)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0024, 0.0030),
            ],
            segments=8,
            cap_start=True,
            cap_end=True,
        )

    bm_lips = bmesh.new()
    add_oriented_limb_tube(
        bm_lips,
        [
            (Vector((-0.016, 1.404, 0.083)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0035, 0.004),
            (Vector((0.0, 1.402, 0.088)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0052, 0.005),
            (Vector((0.016, 1.404, 0.083)), Vector((0, 1, 0)), Vector((0, 0, 1)), 0.0035, 0.004),
        ],
        segments=10,
        cap_start=True,
        cap_end=True,
    )

    for oname, bm_part, m_part in (
        ("mesh_eyes_sclera", bm_sclera, mat_eye_white),
        ("mesh_eyes_iris", bm_iris, mat_eye_iris),
        ("mesh_eyes_pupil", bm_pupil, mat_dark),
        ("mesh_brows", bm_brows, mat_hair),
        ("mesh_lips", bm_lips, mat_lip),
    ):
        obj_p = create_mesh_object(oname, bm_part, m_part)
        bind_skinned_mesh(obj_p, arm_obj, head_only, smooth_passes=0)

    # 7. Hair (neat chef back/side taper + full layered visitor crown) & Pleated Chef Toque
    bm_hair_chef = bmesh.new()
    add_ellipsoid(
        bm_hair_chef,
        Vector((0.0, 1.464, -0.010)),
        (0.088, 0.076, 0.090),
        u_seg=24,
        v_seg=16,
    )
    add_lofted_tube(
        bm_hair_chef,
        [
            (Vector((0.0, 1.390, -0.038)), 0.058, 0.044, 0.0),
            (Vector((0.0, 1.442, -0.026)), 0.080, 0.068, 0.0),
        ],
        segments=20,
        cap_start=True,
        cap_end=True,
    )
    obj_hair_chef = create_mesh_object("mesh_hair_chef", bm_hair_chef, mat_hair)
    bind_skinned_mesh(obj_hair_chef, arm_obj, head_only, smooth_passes=0)

    bm_hair_visitor = bmesh.new()
    add_ellipsoid(
        bm_hair_visitor,
        Vector((0.0, 1.494, -0.006)),
        (0.091, 0.082, 0.096),
        u_seg=24,
        v_seg=16,
        rot_euler_yup=(-0.08, 0.0, 0.04),
    )
    # Soft side-swept fringe & temple layers
    add_ellipsoid(
        bm_hair_visitor,
        Vector((0.022, 1.512, 0.044)),
        (0.068, 0.036, 0.056),
        u_seg=18,
        v_seg=12,
        rot_euler_yup=(0.18, 0.12, -0.14),
    )
    obj_hair_visitor = create_mesh_object("mesh_hair_visitor", bm_hair_visitor, mat_hair)
    bind_skinned_mesh(obj_hair_visitor, arm_obj, head_only, smooth_passes=0)

    # Pleated French Toque Blanche seated snugly over hair & forehead (Y=1.478..1.656)
    bm_toque = bmesh.new()
    add_lofted_tube(
        bm_toque,
        [
            (Vector((0.0, 1.478, -0.002)), 0.090, 0.099, 0.0),
            (Vector((0.0, 1.524, -0.006)), 0.091, 0.100, 0.0),
        ],
        segments=32,
        cap_start=True,
        cap_end=False,
    )
    # Pleated vertical crown + soft gathered dome (top at Y=1.656, below 1.72 label)
    add_lofted_tube(
        bm_toque,
        [
            (Vector((0.0, 1.523, -0.006)), 0.091, 0.100, 0.0),
            (Vector((0.0, 1.572, -0.012)), 0.098, 0.105, 0.0),
            (Vector((0.0, 1.622, -0.017)), 0.101, 0.108, 0.0),
            (Vector((0.0, 1.646, -0.020)), 0.078, 0.084, 0.0),
            (Vector((0.0, 1.656, -0.021)), 0.028, 0.030, 0.0),
        ],
        segments=56,
        cap_start=False,
        cap_end=True,
        pleat_amp=0.022,
        pleat_count=28,
    )
    obj_toque = create_mesh_object("chef_toque", bm_toque, mat_jacket)
    bind_skinned_mesh(obj_toque, arm_obj, head_only, smooth_passes=0)

    bm_piping = bmesh.new()
    add_lofted_tube(
        bm_piping,
        [
            (Vector((0.0, 1.483, -0.003)), 0.092, 0.101, 0.0),
            (Vector((0.0, 1.494, -0.004)), 0.092, 0.101, 0.0),
        ],
        segments=32,
        cap_start=True,
        cap_end=True,
    )
    obj_piping = create_mesh_object("chef_toque_piping", bm_piping, mat_accent)
    bind_skinned_mesh(obj_piping, arm_obj, head_only, smooth_passes=0)

    # 8. Carried Props Root (non-skinned, cloned onto carriedItemGroup)
    props_root = bpy.data.objects.new("carried_props", None)
    bpy.context.collection.objects.link(props_root)

    chef_prop_root = bpy.data.objects.new("prop_chef_vessel", None)
    bpy.context.collection.objects.link(chef_prop_root)
    chef_prop_root.parent = props_root

    bm_bowl = bmesh.new()
    add_lofted_tube(
        bm_bowl,
        [
            (Vector((0.0, -0.038, 0.0)), 0.068, 0.068, 0.0),
            (Vector((0.0, -0.020, 0.0)), 0.088, 0.088, 0.0),
            (Vector((0.0, 0.012, 0.0)), 0.104, 0.104, 0.0),
            (Vector((0.0, 0.038, 0.0)), 0.112, 0.112, 0.0),
            (Vector((0.0, 0.043, 0.0)), 0.118, 0.118, 0.0),
            (Vector((0.0, 0.036, 0.0)), 0.106, 0.106, 0.0),
            (Vector((0.0, 0.002, 0.0)), 0.095, 0.095, 0.0),
        ],
        segments=28,
        cap_start=True,
        cap_end=True,
    )
    create_mesh_object("prop_bowl_steel", bm_bowl, mat_steel, parent=chef_prop_root)

    bm_batter = bmesh.new()
    add_lofted_tube(
        bm_batter,
        [
            (Vector((0.0, 0.004, 0.0)), 0.092, 0.092, 0.0),
            (Vector((0.0, 0.022, 0.0)), 0.098, 0.098, 0.0),
        ],
        segments=24,
        cap_start=True,
        cap_end=True,
    )
    create_mesh_object("prop_bowl_batter", bm_batter, mat_batter, parent=chef_prop_root)

    visitor_prop_root = bpy.data.objects.new("prop_visitor_ballotin", None)
    bpy.context.collection.objects.link(visitor_prop_root)
    visitor_prop_root.parent = props_root

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    box_obj = bpy.context.object
    box_obj.name = "prop_ballotin_box"
    box_obj.scale = (0.18, 0.14, 0.092)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = box_obj.modifiers.new("Bevel", "BEVEL")
    bevel.width = 0.005
    bevel.segments = 2
    bpy.context.view_layer.objects.active = box_obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    for poly in box_obj.data.polygons:
        poly.use_smooth = True
    box_obj.data.materials.append(mat_ballotin)
    box_obj.parent = visitor_prop_root

    bm_ribbon = bmesh.new()
    # Cross ribbons + sculpted bow loops on top (+Z in Blender = +Y in Three.js)
    add_lofted_tube(
        bm_ribbon,
        [
            (Vector((0.0, -0.048, 0.0)), 0.092, 0.012, 0.0),
            (Vector((0.0, 0.048, 0.0)), 0.092, 0.012, 0.0),
        ],
        segments=12,
        cap_start=True,
        cap_end=True,
    )
    add_lofted_tube(
        bm_ribbon,
        [
            (Vector((0.0, -0.048, 0.0)), 0.012, 0.072, 0.0),
            (Vector((0.0, 0.048, 0.0)), 0.012, 0.072, 0.0),
        ],
        segments=12,
        cap_start=True,
        cap_end=True,
    )
    for side in (-1.0, 1.0):
        add_ellipsoid(
            bm_ribbon,
            Vector((side * 0.022, 0.056, 0.0)),
            (0.022, 0.009, 0.014),
            u_seg=12,
            v_seg=8,
            rot_euler_yup=(0.0, 0.0, side * 0.25),
        )
    create_mesh_object("prop_ballotin_ribbon", bm_ribbon, mat_ribbon, parent=visitor_prop_root)


def add_olive_leaf_blade(
    bm: bmesh.types.BMesh,
    origin_yup: Vector,
    direction_yup: Vector,
    up_hint_yup: Vector,
    length: float,
    width: float,
    arch: float = 0.008,
) -> None:
    """Create a curved lance-shaped Olea europaea leaf blade (3 segments, 8 verts)."""
    fwd = direction_yup.normalized()
    side = fwd.cross(up_hint_yup)
    if side.length_squared < 1e-6:
        side = fwd.cross(Vector((1.0, 0.0, 0.0)))
    side.normalize()
    up = side.cross(fwd).normalized()

    p0 = origin_yup
    p1 = origin_yup + fwd * (length * 0.34) + up * (arch * 0.7)
    p2 = origin_yup + fwd * (length * 0.72) + up * arch
    p3 = origin_yup + fwd * length - up * (arch * 0.35)

    v_base = bm.verts.new(y_up_to_blender(p0.x, p0.y, p0.z))
    v_1l = bm.verts.new(y_up_to_blender(*(p1 - side * (width * 0.44))))
    v_1r = bm.verts.new(y_up_to_blender(*(p1 + side * (width * 0.44))))
    v_2l = bm.verts.new(y_up_to_blender(*(p2 - side * (width * 0.50))))
    v_2r = bm.verts.new(y_up_to_blender(*(p2 + side * (width * 0.50))))
    v_tip = bm.verts.new(y_up_to_blender(p3.x, p3.y, p3.z))

    bm.faces.new((v_base, v_1r, v_1l))
    bm.faces.new((v_1l, v_1r, v_2r, v_2l))
    bm.faces.new((v_2l, v_2r, v_tip))


def build_wheel_thrown_pot(
    bm_pot: bmesh.types.BMesh,
    bm_saucer: bmesh.types.BMesh,
    bm_soil: bmesh.types.BMesh,
    bm_pebbles: bmesh.types.BMesh,
    pot_height: float,
    base_radius: float,
    belly_radius: float,
    rim_radius: float,
    saucer_radius: float,
    rng: random.Random,
    pebble_count: int,
) -> None:
    # Spun brass drip saucer with raised curved lip
    add_lofted_tube(
        bm_saucer,
        [
            (Vector((0.0, 0.001, 0.0)), saucer_radius * 0.90, saucer_radius * 0.90, 0.0),
            (Vector((0.0, 0.010, 0.0)), saucer_radius * 0.98, saucer_radius * 0.98, 0.0),
            (Vector((0.0, 0.026, 0.0)), saucer_radius, saucer_radius, 0.0),
            (Vector((0.0, 0.028, 0.0)), saucer_radius * 0.95, saucer_radius * 0.95, 0.0),
            (Vector((0.0, 0.012, 0.0)), saucer_radius * 0.88, saucer_radius * 0.88, 0.0),
        ],
        segments=32,
        cap_start=True,
        cap_end=True,
    )

    # Wheel-thrown ceramic stoneware pot with subtle throwing rings, rolled lip & inner wall
    pot_profile: list[tuple[Vector, float, float, float]] = []
    n_rings = 14
    for i in range(n_rings + 1):
        t = i / n_rings
        y = 0.012 + t * (pot_height - 0.012)
        curve = math.sin(t * math.pi * 0.82)
        r = base_radius + (belly_radius - base_radius) * curve
        if t > 0.86:
            lip_t = (t - 0.86) / 0.14
            r = r * (1.0 - lip_t) + rim_radius * lip_t
        # Subtle wheel-throwing rib modulation
        r += 0.0016 * math.sin(t * math.pi * 9.0)
        pot_profile.append((Vector((0.0, y, 0.0)), r, r, 0.0))

    # Rolled top rim turning inward to soil level
    pot_profile.extend(
        [
            (Vector((0.0, pot_height + 0.010, 0.0)), rim_radius + 0.008, rim_radius + 0.008, 0.0),
            (Vector((0.0, pot_height + 0.004, 0.0)), rim_radius - 0.012, rim_radius - 0.012, 0.0),
            (Vector((0.0, pot_height - 0.032, 0.0)), rim_radius - 0.018, rim_radius - 0.018, 0.0),
        ]
    )
    add_lofted_tube(bm_pot, pot_profile, segments=36, cap_start=True, cap_end=True)

    # Organic mounded potting soil
    soil_y = pot_height - 0.018
    soil_r = rim_radius - 0.015
    add_lofted_tube(
        bm_soil,
        [
            (Vector((0.0, soil_y - 0.016, 0.0)), soil_r * 0.96, soil_r * 0.96, 0.0),
            (Vector((0.0, soil_y, 0.0)), soil_r, soil_r, 0.0),
            (Vector((0.0, soil_y + 0.012, 0.0)), soil_r * 0.52, soil_r * 0.52, 0.0),
        ],
        segments=28,
        cap_start=False,
        cap_end=True,
    )

    # River-pebble mulch around the trunk flare
    for i in range(pebble_count):
        ang = (2.0 * math.pi * i) / pebble_count + rng.uniform(-0.18, 0.18)
        dist = rng.uniform(0.042, soil_r * 0.84)
        px = math.cos(ang) * dist
        pz = math.sin(ang) * dist
        py = soil_y + 0.007 * (1.0 - dist / soil_r)
        add_ellipsoid(
            bm_pebbles,
            Vector((px, py, pz)),
            (rng.uniform(0.013, 0.022), rng.uniform(0.006, 0.010), rng.uniform(0.011, 0.019)),
            u_seg=10,
            v_seg=6,
            rot_euler_yup=(rng.uniform(-0.2, 0.2), rng.uniform(0.0, math.pi), rng.uniform(-0.2, 0.2)),
        )


def build_botanical_planters_scene() -> None:
    clear_scene()
    rng = random.Random(20261105)

    mat_ceramic = make_material("mat_planter_ceramic", (0.93, 0.91, 0.87), roughness=0.38, metallic=0.02)
    mat_brass = make_material("mat_planter_brass", (0.76, 0.60, 0.34), roughness=0.30, metallic=0.82)
    mat_soil = make_material("mat_planter_soil", (0.20, 0.14, 0.10), roughness=0.94, metallic=0.0)
    mat_pebble = make_material("mat_planter_pebbles", (0.54, 0.50, 0.45), roughness=0.68, metallic=0.02)
    mat_bark = make_material("mat_olive_bark", (0.38, 0.29, 0.21), roughness=0.84, metallic=0.01)
    mat_olive_leaf_top = make_material(
        "mat_olive_leaf_deep", (0.33, 0.44, 0.28), roughness=0.52, metallic=0.02, double_sided=True
    )
    mat_olive_leaf_silver = make_material(
        "mat_olive_leaf_silver", (0.48, 0.57, 0.43), roughness=0.48, metallic=0.02, double_sided=True
    )
    mat_olive_fruit = make_material("mat_olive_fruit", (0.36, 0.42, 0.22), roughness=0.36, metallic=0.02)
    mat_shrub_deep = make_material(
        "mat_shrub_deep", (0.29, 0.41, 0.25), roughness=0.55, metallic=0.01, double_sided=True
    )
    mat_shrub_fresh = make_material(
        "mat_shrub_fresh", (0.41, 0.53, 0.34), roughness=0.50, metallic=0.01, double_sided=True
    )

    # =========================================================================
    # MODEL 1: Interior Rigged Olive Tree Planter ("olive_tree_planter")
    # =========================================================================
    olive_root = bpy.data.objects.new("olive_tree_planter", None)
    bpy.context.collection.objects.link(olive_root)

    bm_opot = bmesh.new()
    bm_osaucer = bmesh.new()
    bm_osoil = bmesh.new()
    bm_opebbles = bmesh.new()
    build_wheel_thrown_pot(
        bm_opot,
        bm_osaucer,
        bm_osoil,
        bm_opebbles,
        pot_height=0.42,
        base_radius=0.138,
        belly_radius=0.188,
        rim_radius=0.184,
        saucer_radius=0.160,
        rng=rng,
        pebble_count=22,
    )
    create_mesh_object("olive_pot", bm_opot, mat_ceramic, parent=olive_root)
    create_mesh_object("olive_saucer", bm_osaucer, mat_brass, parent=olive_root)
    create_mesh_object("olive_soil", bm_osoil, mat_soil, parent=olive_root)
    create_mesh_object("olive_pebbles", bm_opebbles, mat_pebble, parent=olive_root)

    # Olive Tree Armature (6 bones for trunk & canopy sway)
    olive_arm_data = bpy.data.armatures.new("olive_armature_data")
    olive_arm = bpy.data.objects.new("olive_armature", olive_arm_data)
    bpy.context.collection.objects.link(olive_arm)
    olive_arm.parent = olive_root
    bpy.context.view_layer.objects.active = olive_arm
    bpy.ops.object.mode_set(mode="EDIT")

    olive_bones_yup = {
        "trunk_base": (Vector((0.0, 0.39, 0.0)), None),
        "trunk_mid": (Vector((0.012, 0.66, -0.008)), "trunk_base"),
        "branch_west": (Vector((-0.055, 0.86, 0.025)), "trunk_mid"),
        "branch_east": (Vector((0.068, 0.89, -0.022)), "trunk_mid"),
        "branch_north": (Vector((-0.012, 0.91, -0.052)), "trunk_mid"),
        "crown_top": (Vector((0.015, 1.02, 0.018)), "trunk_mid"),
    }
    o_ebones: dict[str, bpy.types.EditBone] = {}
    for bname, (pos_yup, pname) in olive_bones_yup.items():
        eb = olive_arm_data.edit_bones.new(bname)
        h = y_up_to_blender(pos_yup.x, pos_yup.y, pos_yup.z)
        eb.head = h
        eb.tail = h + Vector((0.0, 0.0, 0.08))
        eb.roll = 0.0
        if pname is not None:
            eb.parent = o_ebones[pname]
        o_ebones[bname] = eb
    bpy.ops.object.mode_set(mode="OBJECT")

    # Gnarled twisted Mediterranean olive trunk & limbs
    bm_bark = bmesh.new()
    trunk_pts = [
        (Vector((0.0, 0.385, 0.0)), 0.044, 0.040, 0.0),
        (Vector((0.006, 0.46, 0.004)), 0.031, 0.029, 0.3),
        (Vector((-0.008, 0.56, -0.006)), 0.027, 0.025, 0.7),
        (Vector((0.012, 0.67, -0.008)), 0.024, 0.023, 1.1),
        (Vector((0.006, 0.79, 0.004)), 0.021, 0.020, 1.5),
        (Vector((0.014, 0.90, 0.010)), 0.016, 0.015, 1.9),
    ]
    add_lofted_tube(
        bm_bark,
        trunk_pts,
        segments=14,
        cap_start=True,
        cap_end=True,
        pleat_amp=0.08,
        pleat_count=5,
    )

    # Primary limbs + fine leafy shoots
    limb_defs = [
        ("branch_west", Vector((0.008, 0.76, 0.002)), Vector((-0.11, 0.96, 0.055)), Vector((-0.17, 1.07, 0.085))),
        ("branch_east", Vector((0.012, 0.79, -0.004)), Vector((0.115, 0.99, -0.045)), Vector((0.175, 1.10, -0.075))),
        ("branch_north", Vector((0.008, 0.81, -0.002)), Vector((-0.025, 1.01, -0.095)), Vector((-0.045, 1.13, -0.145))),
        ("crown_top", Vector((0.012, 0.86, 0.008)), Vector((0.025, 1.08, 0.035)), Vector((0.015, 1.24, 0.025))),
        ("crown_top", Vector((0.010, 0.85, 0.010)), Vector((-0.035, 1.05, 0.095)), Vector((-0.065, 1.16, 0.135))),
        ("branch_east", Vector((0.065, 0.91, -0.020)), Vector((0.095, 1.04, 0.065)), Vector((0.125, 1.14, 0.105))),
    ]

    shoot_tips: list[tuple[Vector, Vector]] = []
    for _, p_start, p_mid, p_end in limb_defs:
        fwd1 = (p_mid - p_start).normalized()
        u1 = fwd1.cross(Vector((0.0, 0.0, 1.0)))
        if u1.length_squared < 1e-4:
            u1 = Vector((1.0, 0.0, 0.0))
        u1.normalize()
        v1 = fwd1.cross(u1).normalized()
        add_oriented_limb_tube(
            bm_bark,
            [
                (p_start, u1, v1, 0.015, 0.014),
                (p_mid, u1, v1, 0.010, 0.010),
                (p_end, u1, v1, 0.005, 0.005),
            ],
            segments=8,
            cap_start=True,
            cap_end=True,
        )
        shoot_tips.append((p_mid, (p_end - p_start).normalized()))
        shoot_tips.append((p_end, (p_end - p_mid).normalized()))
        # Sub-twigs branching off each limb
        for sub_i in range(3):
            base_p = p_start.lerp(p_end, 0.42 + sub_i * 0.24)
            twig_dir = (
                (p_end - p_start).normalized()
                + Vector((rng.uniform(-0.75, 0.75), rng.uniform(0.25, 0.75), rng.uniform(-0.75, 0.75)))
            ).normalized()
            twig_end = base_p + twig_dir * rng.uniform(0.10, 0.15)
            ut = twig_dir.cross(Vector((0.0, 1.0, 0.0)))
            if ut.length_squared < 1e-4:
                ut = Vector((1.0, 0.0, 0.0))
            ut.normalize()
            vt = twig_dir.cross(ut).normalized()
            add_oriented_limb_tube(
                bm_bark,
                [
                    (base_p, ut, vt, 0.0055, 0.0055),
                    (twig_end, ut, vt, 0.0025, 0.0025),
                ],
                segments=6,
                cap_start=False,
                cap_end=True,
            )
            shoot_tips.append((base_p.lerp(twig_end, 0.55), twig_dir))
            shoot_tips.append((twig_end, twig_dir))

    olive_capsules = [
        ("trunk_base", Vector((0.0, 0.39, 0.0)), Vector((0.01, 0.65, -0.008)), 0.14),
        ("trunk_mid", Vector((0.01, 0.66, -0.008)), Vector((0.01, 0.88, 0.0)), 0.13),
        ("branch_west", Vector((-0.04, 0.84, 0.02)), Vector((-0.19, 1.12, 0.10)), 0.14),
        ("branch_east", Vector((0.05, 0.87, -0.02)), Vector((0.19, 1.15, -0.08)), 0.14),
        ("branch_north", Vector((-0.01, 0.89, -0.04)), Vector((-0.06, 1.16, -0.16)), 0.14),
        ("crown_top", Vector((0.01, 0.96, 0.02)), Vector((0.02, 1.30, 0.05)), 0.16),
    ]

    obj_bark = create_mesh_object("olive_bark", bm_bark, mat_bark)
    bind_skinned_mesh(obj_bark, olive_arm, olive_capsules, smooth_passes=2)

    # Airy phyllotactic sprays of lance-shaped olive leaves (2-tone deep + silver-sage) + olives
    bm_leaves_deep = bmesh.new()
    bm_leaves_silver = bmesh.new()
    bm_olives = bmesh.new()

    for s_idx, (tip_pos, tip_dir) in enumerate(shoot_tips):
        # 8 leaves per shoot arranged in opposite decussate pairs
        ref = Vector((0.0, 1.0, 0.0)) if abs(tip_dir.y) < 0.9 else Vector((1.0, 0.0, 0.0))
        b_u = tip_dir.cross(ref).normalized()
        b_v = tip_dir.cross(b_u).normalized()
        for pair_i in range(5):
            stem_pt = tip_pos - tip_dir * (0.092 - pair_i * 0.022)
            rot_pair = (pair_i * math.pi * 0.5) + s_idx * 0.37
            radial = b_u * math.cos(rot_pair) + b_v * math.sin(rot_pair)
            for sign in (-1.0, 1.0):
                ldir = (tip_dir * 0.54 + radial * (sign * 0.85) + Vector((0.0, rng.uniform(-0.18, 0.22), 0.0))).normalized()
                up_h = Vector((0.0, 1.0, 0.0)) + radial * (sign * 0.25)
                target_bm = bm_leaves_deep if (pair_i + (1 if sign > 0 else 0)) % 2 == 0 else bm_leaves_silver
                add_olive_leaf_blade(
                    target_bm,
                    stem_pt,
                    ldir,
                    up_h,
                    length=rng.uniform(0.058, 0.076),
                    width=rng.uniform(0.016, 0.022),
                    arch=rng.uniform(0.006, 0.011),
                )
        # Terminal leaf at shoot tip
        add_olive_leaf_blade(
            bm_leaves_silver if s_idx % 2 == 0 else bm_leaves_deep,
            tip_pos + tip_dir * 0.006,
            tip_dir,
            Vector((0.0, 1.0, 0.0)),
            length=0.056,
            width=0.015,
            arch=0.007,
        )
        if s_idx % 3 == 0:
            olive_pt = tip_pos - tip_dir * 0.035 - Vector((0.0, 0.012, 0.0))
            add_ellipsoid(bm_olives, olive_pt, (0.0075, 0.0105, 0.0075), u_seg=10, v_seg=8)

    obj_leaves_deep = create_mesh_object("olive_leaves_deep", bm_leaves_deep, mat_olive_leaf_top)
    obj_leaves_silver = create_mesh_object("olive_leaves_silver", bm_leaves_silver, mat_olive_leaf_silver)
    obj_olives = create_mesh_object("olive_fruits", bm_olives, mat_olive_fruit)
    bind_skinned_mesh(obj_leaves_deep, olive_arm, olive_capsules, smooth_passes=0)
    bind_skinned_mesh(obj_leaves_silver, olive_arm, olive_capsules, smooth_passes=0)
    bind_skinned_mesh(obj_olives, olive_arm, olive_capsules, smooth_passes=0)

    # =========================================================================
    # MODEL 2: Exterior Storefront Rigged Boxwood/Herb Planter ("storefront_shrub_planter")
    # =========================================================================
    shrub_root = bpy.data.objects.new("storefront_shrub_planter", None)
    bpy.context.collection.objects.link(shrub_root)
    shrub_root.location = (1.2, 0.0, 0.0)  # offset in authoring scene; reset at export or Zeroed per root!
    shrub_root.location = (0.0, 0.0, 0.0)

    bm_spot = bmesh.new()
    bm_ssaucer = bmesh.new()
    bm_ssoil = bmesh.new()
    bm_spebbles = bmesh.new()
    build_wheel_thrown_pot(
        bm_spot,
        bm_ssaucer,
        bm_ssoil,
        bm_spebbles,
        pot_height=0.29,
        base_radius=0.126,
        belly_radius=0.166,
        rim_radius=0.164,
        saucer_radius=0.146,
        rng=rng,
        pebble_count=15,
    )
    create_mesh_object("shrub_pot", bm_spot, mat_ceramic, parent=shrub_root)
    create_mesh_object("shrub_saucer", bm_ssaucer, mat_brass, parent=shrub_root)
    create_mesh_object("shrub_soil", bm_ssoil, mat_soil, parent=shrub_root)
    create_mesh_object("shrub_pebbles", bm_spebbles, mat_pebble, parent=shrub_root)

    shrub_arm_data = bpy.data.armatures.new("shrub_armature_data")
    shrub_arm = bpy.data.objects.new("shrub_armature", shrub_arm_data)
    bpy.context.collection.objects.link(shrub_arm)
    shrub_arm.parent = shrub_root
    bpy.context.view_layer.objects.active = shrub_arm
    bpy.ops.object.mode_set(mode="EDIT")

    shrub_bones_yup = {
        "shrub_base": (Vector((0.0, 0.27, 0.0)), None),
        "shrub_canopy": (Vector((0.0, 0.42, 0.0)), "shrub_base"),
    }
    s_ebones: dict[str, bpy.types.EditBone] = {}
    for bname, (pos_yup, pname) in shrub_bones_yup.items():
        eb = shrub_arm_data.edit_bones.new(bname)
        h = y_up_to_blender(pos_yup.x, pos_yup.y, pos_yup.z)
        eb.head = h
        eb.tail = h + Vector((0.0, 0.0, 0.07))
        eb.roll = 0.0
        if pname is not None:
            eb.parent = s_ebones[pname]
        s_ebones[bname] = eb
    bpy.ops.object.mode_set(mode="OBJECT")

    bm_swood = bmesh.new()
    for stem_i in range(5):
        ang = (2.0 * math.pi * stem_i) / 5.0 + 0.3
        sx = math.cos(ang) * 0.055
        sz = math.sin(ang) * 0.055
        add_lofted_tube(
            bm_swood,
            [
                (Vector((sx * 0.35, 0.27, sz * 0.35)), 0.012, 0.012, 0.0),
                (Vector((sx, 0.38, sz)), 0.007, 0.007, 0.0),
            ],
            segments=8,
            cap_start=True,
            cap_end=True,
        )

    shrub_capsules = [
        ("shrub_base", Vector((0.0, 0.27, 0.0)), Vector((0.0, 0.35, 0.0)), 0.10),
        ("shrub_canopy", Vector((0.0, 0.36, 0.0)), Vector((0.0, 0.58, 0.0)), 0.16),
    ]
    obj_swood = create_mesh_object("shrub_wood", bm_swood, mat_bark)
    bind_skinned_mesh(obj_swood, shrub_arm, shrub_capsules, smooth_passes=1)

    # Lush organic boxwood dome built from 220 individual outward-fanning leaf blades (no spheres!)
    bm_shrub_deep = bmesh.new()
    bm_shrub_fresh = bmesh.new()
    golden_angle = math.pi * (3.0 - math.sqrt(5.0))
    total_sprigs = 220
    for i in range(total_sprigs):
        t = (i + 0.5) / total_sprigs
        # Upper 75% of an oblate botanical mound centered at Y=0.41
        cos_phi = 1.0 - t * 1.32  # +1 (top) down to -0.32 (lower skirt)
        sin_phi = math.sqrt(max(0.0, 1.0 - cos_phi * cos_phi))
        theta = i * golden_angle
        shell = rng.uniform(0.84, 1.04)
        rx = 0.168 * shell
        ry = 0.145 * shell
        rz = 0.168 * shell
        normal = Vector((sin_phi * math.cos(theta), cos_phi * 1.15, sin_phi * math.sin(theta))).normalized()
        pos = Vector(
            (
                rx * sin_phi * math.cos(theta),
                0.415 + ry * cos_phi,
                rz * sin_phi * math.sin(theta),
            )
        )
        leaf_dir = (
            normal * 0.72
            + Vector((rng.uniform(-0.35, 0.35), rng.uniform(0.15, 0.55), rng.uniform(-0.35, 0.35)))
        ).normalized()
        target_bm = bm_shrub_fresh if (cos_phi > 0.35 and i % 2 == 0) or i % 3 == 0 else bm_shrub_deep
        add_olive_leaf_blade(
            target_bm,
            pos - leaf_dir * 0.014,
            leaf_dir,
            Vector((0.0, 1.0, 0.0)),
            length=rng.uniform(0.036, 0.050),
            width=rng.uniform(0.016, 0.023),
            arch=rng.uniform(0.004, 0.008),
        )

    obj_sdeep = create_mesh_object("shrub_leaves_deep", bm_shrub_deep, mat_shrub_deep)
    obj_sfresh = create_mesh_object("shrub_leaves_fresh", bm_shrub_fresh, mat_shrub_fresh)
    bind_skinned_mesh(obj_sdeep, shrub_arm, shrub_capsules, smooth_passes=0)
    bind_skinned_mesh(obj_sfresh, shrub_arm, shrub_capsules, smooth_passes=0)


def export_glb(filepath: Path) -> None:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_skins=True,
        export_all_influences=False,
        export_def_bones=False,
        export_materials="EXPORT",
        export_normals=True,
    )
    print(f"Exported {filepath} ({filepath.stat().st_size} bytes)")


def main() -> None:
    build_human_patissier_scene()
    export_glb(HUMAN_GLB)
    build_botanical_planters_scene()
    export_glb(PLANTS_GLB)


if __name__ == "__main__":
    main()
