"""Build the Satyr Kitchen Pastry Bench (pastry-bench) GLB visual and MuJoCo 4.0.0 flexcomp model.

Covers Savoury Pies (docs/recipes/pies.md):
- Pressing & folding 330 g 3D volumetric shortcrust dough blocks (<flexcomp dim="3">)
- Sheeting 3 mm shortcrust pastry (110 g per 12 cm tin, 330 g per 3-pie tray)
- Draping & crimping puff-pastry lids (80 g per 12 cm tin, 240 g per 3-pie tray)
- Real MuJoCo 4.0.0 2D shell (<flexcomp dim="2" elastic2d="both">) & 3D solid (<flexcomp dim="3">)
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = REPO_ROOT / "assets" / "bakery-mujoco" / "pastry-bench"

BENCH_W = 0.640
BENCH_D = 0.460
FOOT_H = 0.012
SLAB_TOP_Z = 0.062

TRAY_Z = 0.062
ROLLER_POS = (-0.115, 0.0, 0.142)
CRIMPER_POS = (0.0, 0.0, 0.165)
DUSTER_POS = (0.220, 0.130, 0.062)
CARRIER_POS = (-0.220, 0.130, 0.064)
DOUGH_PRESS_POS = (-0.264, -0.095, 0.134)


def clean_mesh(obj: bpy.types.Object) -> bpy.types.Object:
    if obj.type != "MESH":
        return obj
    obj.data.name = obj.name
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=list(bm.edges))
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def make_material(
    name: str,
    rgba: tuple[float, float, float, float],
    roughness: float,
    metallic: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if not mat.use_nodes:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def add_box(
    name: str,
    size_xyz: tuple[float, float, float],
    center_xyz: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size_xyz), verts=bm.verts)
    bmesh.ops.bevel(
        bm,
        geom=list(bm.edges),
        offset=min(size_xyz) * 0.08,
        segments=2,
        affect="EDGES",
    )
    bmesh.ops.translate(bm, vec=Vector(center_xyz), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    return clean_mesh(obj)


def add_cylinder(
    name: str,
    radius: float,
    depth: float,
    center_xyz: tuple[float, float, float],
    rot_xyz: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object,
    vertices: int = 36,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=True,
        segments=vertices,
        radius1=radius,
        radius2=radius,
        depth=depth,
    )
    rot = Euler(rot_xyz, "XYZ").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center_xyz), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    return clean_mesh(obj)


def add_fluted_pie_tin(
    name: str,
    cx: float,
    cy: float,
    base_z: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    """Author a 12 cm fluted spun-aluminium pie tin (94 mm base, 122 mm top, 28 mm deep)."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    n_seg = 48
    r_inner_bot = 0.047
    r_inner_top = 0.060
    r_rim_outer = 0.065
    wall_t = 0.0018
    depth = 0.028

    rings_r_z = [
        (0.0, wall_t, False),
        (r_inner_bot, wall_t, True),
        (r_inner_top, wall_t + depth, True),
        (r_rim_outer, wall_t + depth + 0.0012, False),
        (r_rim_outer, wall_t + depth - 0.0022, False),
        (r_inner_top + wall_t, wall_t + depth - 0.0025, True),
        (r_inner_bot + wall_t, 0.0, True),
        (0.0, 0.0, False),
    ]

    ring_verts: list[list[bmesh.types.BMVert]] = []
    for r_nom, z_rel, fluted in rings_r_z:
        if r_nom == 0.0:
            v = bm.verts.new((cx, cy, base_z + z_rel))
            ring_verts.append([v])
        else:
            row = []
            for k in range(n_seg):
                ang = 2.0 * math.pi * k / n_seg
                flute = 0.0014 * math.cos(24.0 * ang) if fluted else 0.0
                rr = r_nom + flute
                row.append(
                    bm.verts.new(
                        (cx + rr * math.cos(ang), cy + rr * math.sin(ang), base_z + z_rel)
                    )
                )
            ring_verts.append(row)

    for idx in range(len(ring_verts) - 1):
        a = ring_verts[idx]
        b = ring_verts[idx + 1]
        if len(a) == 1 and len(b) > 1:
            for k in range(n_seg):
                bm.faces.new((a[0], b[k], b[(k + 1) % n_seg]))
        elif len(a) > 1 and len(b) == 1:
            for k in range(n_seg):
                bm.faces.new((a[(k + 1) % n_seg], a[k], b[0]))
        else:
            for k in range(n_seg):
                k2 = (k + 1) % n_seg
                bm.faces.new((a[k], a[k2], b[k2], b[k]))

    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    return clean_mesh(obj)


def make_empty(name: str, loc: tuple[float, float, float], parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.location = Vector(loc)
    bpy.context.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def build_glb(glb_path: Path) -> dict[str, str]:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    mat_maple = make_material("RockMapleBlock", (0.78, 0.58, 0.36, 1.0), roughness=0.42)
    mat_beech = make_material("FrenchBeechwood", (0.82, 0.65, 0.43, 1.0), roughness=0.36)
    mat_walnut = make_material("TurnedWalnut", (0.34, 0.21, 0.13, 1.0), roughness=0.38)
    mat_steel = make_material("BrushedSUS304", (0.76, 0.79, 0.82, 1.0), roughness=0.24, metallic=0.90)
    mat_tin = make_material("SpunAluminiumTin", (0.83, 0.85, 0.88, 1.0), roughness=0.28, metallic=0.86)
    mat_rubber = make_material("NitrileFoot", (0.12, 0.13, 0.15, 1.0), roughness=0.78)
    mat_bezel = make_material("ControlBezel", (0.11, 0.13, 0.16, 1.0), roughness=0.32, metallic=0.45)

    root = make_empty("pastry_bench_root", (0.0, 0.0, 0.0))

    # 1. Static bench frame (pb_bench at 0,0,0)
    pb_bench = make_empty("pb_bench", (0.0, 0.0, 0.0), root)
    add_box(
        "pb_maple_slab",
        (BENCH_W, BENCH_D, SLAB_TOP_Z - FOOT_H),
        (0.0, 0.0, FOOT_H + 0.5 * (SLAB_TOP_Z - FOOT_H)),
        mat_maple,
        pb_bench,
    )
    for sx in (-0.27, 0.27):
        for sy in (-0.18, 0.18):
            add_cylinder(
                f"pb_foot_{'l' if sx < 0 else 'r'}_{'f' if sy < 0 else 'b'}",
                0.022,
                FOOT_H,
                (sx, sy, 0.5 * FOOT_H),
                (0.0, 0.0, 0.0),
                mat_rubber,
                pb_bench,
            )
    # 3 mm stainless thickness gauge bars along front & rear sheeting lane
    for sy, tag in ((-0.162, "front"), (0.162, "rear")):
        add_box(
            f"pb_gauge_rail_{tag}",
            (0.42, 0.014, 0.003),
            (0.0, sy, SLAB_TOP_Z + 0.0015),
            mat_steel,
            pb_bench,
        )
    # Front digital thickness/crimp readout bezel
    add_box(
        "pb_front_bezel",
        (0.11, 0.006, 0.026),
        (0.0, -0.230, 0.036),
        mat_bezel,
        pb_bench,
    )

    # 2. 3-pie tray + three 12 cm fluted pie tins (pb_pie_tray at 0, 0, 0.062)
    pb_pie_tray = make_empty("pb_pie_tray", (0.0, 0.0, TRAY_Z), root)
    add_box(
        "pb_tray_deck",
        (0.420, 0.280, 0.002),
        (0.0, 0.0, 0.001),
        mat_steel,
        pb_pie_tray,
    )
    for idx, tx in enumerate((-0.136, 0.0, 0.136)):
        add_fluted_pie_tin(f"pb_pie_tin_{idx}", tx, 0.0, 0.002, mat_tin, pb_pie_tray)

    # 3. French beechwood rolling pin (pb_roller at -0.115, 0, 0.142)
    pb_roller = make_empty("pb_roller", ROLLER_POS, root)
    add_cylinder(
        "pb_roller_barrel_mesh",
        0.022,
        0.230,
        (0.0, 0.0, 0.0),
        (math.pi * 0.5, 0.0, 0.0),
        mat_beech,
        pb_roller,
    )
    for sy, tag in ((-0.122, "front"), (0.122, "rear")):
        add_cylinder(
            f"pb_roller_collar_{tag}",
            0.010,
            0.014,
            (0.0, sy, 0.0),
            (math.pi * 0.5, 0.0, 0.0),
            mat_steel,
            pb_roller,
        )
    for sy, tag in ((-0.162, "front"), (0.162, "rear")):
        add_cylinder(
            f"pb_roller_handle_{tag}",
            0.013,
            0.068,
            (0.0, sy, 0.0),
            (math.pi * 0.5, 0.0, 0.0),
            mat_walnut,
            pb_roller,
        )

    # 4. Stainless docker & fluted rim crimper (pb_crimper at 0, 0, 0.165)
    pb_crimper = make_empty("pb_crimper", CRIMPER_POS, root)
    add_cylinder(
        "pb_crimper_plunger_mesh",
        0.036,
        0.022,
        (0.0, 0.0, -0.014),
        (0.0, 0.0, 0.0),
        mat_steel,
        pb_crimper,
    )
    add_cylinder(
        "pb_crimper_collar_mesh",
        0.063,
        0.008,
        (0.0, 0.0, 0.008),
        (0.0, 0.0, 0.0),
        mat_steel,
        pb_crimper,
    )
    add_cylinder(
        "pb_crimper_stem_mesh",
        0.012,
        0.056,
        (0.0, 0.0, 0.040),
        (0.0, 0.0, 0.0),
        mat_walnut,
        pb_crimper,
    )

    # 5. Stainless bench-flour duster shaker (pb_flour_duster at 0.22, 0.13, 0.062)
    pb_duster = make_empty("pb_flour_duster", DUSTER_POS, root)
    add_cylinder(
        "pb_duster_can",
        0.031,
        0.086,
        (0.0, 0.0, 0.043),
        (0.0, 0.0, 0.0),
        mat_steel,
        pb_duster,
    )
    add_cylinder(
        "pb_duster_cap",
        0.033,
        0.010,
        (0.0, 0.0, 0.088),
        (0.0, 0.0, 0.0),
        mat_tin,
        pb_duster,
    )

    # 6. Chilled pastry portion carrier peel (pb_dough_carrier at -0.22, 0.13, 0.064)
    pb_carrier = make_empty("pb_dough_carrier", CARRIER_POS, root)
    add_cylinder(
        "pb_carrier_disc",
        0.088,
        0.006,
        (0.0, 0.0, 0.003),
        (0.0, 0.0, 0.0),
        mat_beech,
        pb_carrier,
    )

    # 7. Patisserie stainless dough press / coupe-pate platen (pb_dough_press at -0.264, -0.095, 0.134)
    pb_dough_press = make_empty("pb_dough_press", DOUGH_PRESS_POS, root)
    add_box(
        "pb_press_plate_mesh",
        (0.092, 0.092, 0.010),
        (0.0, 0.0, -0.006),
        mat_steel,
        pb_dough_press,
    )
    for sx, tag in ((-0.026, "left"), (0.026, "right")):
        add_cylinder(
            f"pb_press_post_{tag}",
            0.0055,
            0.032,
            (sx, 0.0, 0.014),
            (0.0, 0.0, 0.0),
            mat_steel,
            pb_dough_press,
        )
    add_cylinder(
        "pb_press_handle_mesh",
        0.010,
        0.078,
        (0.0, 0.0, 0.032),
        (0.0, math.pi * 0.5, 0.0),
        mat_walnut,
        pb_dough_press,
    )

    bpy.context.view_layer.update()
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
    )
    return {
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blender_version": bpy.app.version_string,
    }


def build_native_xml() -> str:
    rim_geoms: list[str] = []
    n_rim = 16
    r_rim = 0.062
    z_rim_rel = 0.028  # relative to pb_pie_tray at Z=0.062 -> world Z=0.090 (crest at 0.0945)
    r_mid = 0.054
    z_mid_rel = 0.014  # relative to pb_pie_tray at Z=0.062 -> world Z=0.076
    for i in range(n_rim):
        ang0 = 2.0 * math.pi * i / n_rim
        ang1 = 2.0 * math.pi * (i + 1) / n_rim
        x0, y0 = r_rim * math.cos(ang0), r_rim * math.sin(ang0)
        x1, y1 = r_rim * math.cos(ang1), r_rim * math.sin(ang1)
        rim_geoms.append(
            f'      <geom name="pb_tin_rim_{i}" type="capsule" size="0.0045" '
            f'fromto="{x0:.6f} {y0:.6f} {z_rim_rel:.6f} {x1:.6f} {y1:.6f} {z_rim_rel:.6f}" '
            f'group="3" friction="0.35 0.005 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />'
        )
        mx0, my0 = r_mid * math.cos(ang0), r_mid * math.sin(ang0)
        mx1, my1 = r_mid * math.cos(ang1), r_mid * math.sin(ang1)
        rim_geoms.append(
            f'      <geom name="pb_tin_wall_{i}" type="capsule" size="0.0045" '
            f'fromto="{mx0:.6f} {my0:.6f} {z_mid_rel:.6f} {mx1:.6f} {my1:.6f} {z_mid_rel:.6f}" '
            f'group="3" friction="0.35 0.005 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />'
        )
    rim_block = "\n".join(rim_geoms)
    return f"""<mujoco model="Satyr Kitchen pastry bench deformable dough lab">
  <compiler angle="radian" />
  <option timestep="0.002" solver="Newton" tolerance="1e-6" iterations="200" integrator="discrete" />
  <size nuserdata="4" />
  <statistic extent="0.75" center="0 0 0.14" />
  <visual>
    <global offwidth="1280" offheight="960" />
    <quality shadowsize="2048" />
    <headlight ambient="0.35 0.35 0.35" diffuse="0.7 0.7 0.7" />
  </visual>
  <worldbody>
    <geom name="pb_floor" type="plane" size="2 2 0.05" pos="0 0 -0.001" rgba="0.28 0.30 0.33 1" />
    <light pos="-0.4 -0.5 0.9" dir="0.28 0.32 -0.90" diffuse="0.8 0.8 0.8" />
    <light castshadow="false" pos="0.4 0.3 0.7" dir="-0.28 -0.28 -0.92" diffuse="0.45 0.45 0.45" />
    <body name="pb_bench" pos="0 0 0">
      <inertial pos="0 0 0.032" mass="14.5" diaginertia="0.28 0.52 0.76" />
      <geom name="pb_slab_col" type="box" size="0.32 0.23 0.031" pos="0 0 0.031" group="3" friction="0.42 0.005 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />
      <site name="vessel_socket" pos="-0.22 0.13 0.064" size="0.003" group="3" />
      <body name="live_gauge" pos="0 -0.2305 0.036" quat="0.707107 0.707107 0 0">
        <geom name="live_gauge_back" type="box" size="0.024 0.008 0.0004" contype="0" conaffinity="0" group="2" rgba="0.08 0.09 0.11 1" mass="0" />
        <geom name="live_flour_lamp" type="sphere" size="0.0022" pos="0.020 0 0.0008" contype="0" conaffinity="0" group="2" rgba="0.18 0.82 0.42 1" mass="0" />
      </body>
    </body>
    <body name="pb_pie_tray" pos="0 0 0.062">
      <inertial pos="0 0 0.012" mass="0.68" diaginertia="0.0052 0.0091 0.014" />
      <joint name="pb_tray_slide" type="slide" axis="0 1 0" range="-0.08 0.08" damping="18" armature="0.04" limited="true" />
      <geom name="pb_tin_floor" type="cylinder" size="0.052 0.002" pos="0 0 0.002" group="3" friction="0.35 0.005 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />
{rim_block}
    </body>
    <body name="pb_roller" pos="-0.115 0 0.142">
      <inertial pos="0 0 0" mass="0.85" diaginertia="0.0042 0.00035 0.0042" />
      <joint name="pb_roller_x" type="slide" axis="1 0 0" range="-0.14 0.28" damping="22" armature="0.05" limited="true" />
      <joint name="pb_roller_z" type="slide" axis="0 0 1" range="-0.048 0.04" damping="28" armature="0.05" limited="true" />
      <joint name="pb_roller_spin" type="hinge" axis="0 1 0" range="-31.4 31.4" damping="0.35" armature="0.004" limited="true" />
      <geom name="pb_roller_barrel" type="capsule" size="0.022" fromto="0 -0.115 0 0 0.115 0" group="3" friction="0.28 0.003 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />
    </body>
    <body name="pb_crimper" pos="0 0 0.165">
      <inertial pos="0 0 0" mass="0.52" diaginertia="0.0008 0.0008 0.0014" />
      <joint name="pb_crimper_x" type="slide" axis="1 0 0" range="-0.14 0.14" damping="20" armature="0.04" limited="true" />
      <joint name="pb_crimper_z" type="slide" axis="0 0 1" range="-0.090 0.03" damping="26" armature="0.04" limited="true" />
      <geom name="pb_crimper_plunger" type="sphere" size="0.036" pos="0 0 -0.012" group="3" friction="0.22 0.003 0.0001" solref="0.007 1" solimp="0.88 0.95 0.001" />
      <geom name="pb_crimper_collar" type="cylinder" size="0.063 0.004" pos="0 0 0.008" group="3" friction="0.30 0.003 0.0001" solref="0.007 1" solimp="0.88 0.95 0.001" />
    </body>
    <body name="pb_flour_duster" pos="0.22 0.13 0.062">
      <inertial pos="0 0 0.04" mass="0.24" diaginertia="0.0003 0.0003 0.0002" />
      <joint name="pb_duster_shake" type="slide" axis="0 0 1" range="0 0.05" damping="8" armature="0.02" limited="true" />
      <geom name="pb_duster_col" type="cylinder" size="0.032 0.045" pos="0 0 0.045" contype="0" conaffinity="0" group="3" />
    </body>
    <body name="pb_dough_carrier" pos="-0.22 0.13 0.064">
      <inertial pos="0 0 0.015" mass="0.35" diaginertia="0.0009 0.0009 0.0016" />
      <joint name="pb_dough_carrier_free" type="free" />
      <geom name="pb_carrier_base" type="cylinder" size="0.088 0.003" pos="0 0 0.003" group="3" friction="0.6" solref="0.004 1" solimp="0.95 0.99 0.001" />
      <body name="ingredient_payload">
        <inertial pos="0 0 0" mass="1e-09" diaginertia="1e-12 1e-12 1e-12" />
        <geom name="ingredient_surface" type="cylinder" size="0.082 0.001" pos="0 0 0.006" contype="0" conaffinity="0" group="2" rgba="0.90 0.82 0.64 0" mass="0" />
      </body>
    </body>
    <body name="pb_dough_press" pos="-0.264 -0.095 0.134">
      <inertial pos="0 0 0.012" mass="0.64" diaginertia="0.0012 0.0012 0.0018" />
      <joint name="pb_press_x" type="slide" axis="1 0 0" range="-0.035 0.035" damping="22" armature="0.04" limited="true" />
      <joint name="pb_press_z" type="slide" axis="0 0 1" range="-0.042 0.025" damping="28" armature="0.04" limited="true" />
      <geom name="pb_press_plate" type="box" size="0.048 0.048 0.006" pos="0 0 -0.006" group="3" friction="0.22 0.003 0.0001" solref="0.006 1" solimp="0.90 0.96 0.001" />
    </body>
    <flexcomp name="pastry_sheet" type="grid" dim="2" count="9 9 1" spacing="0.020 0.020 0.020" pos="0 0 0.100" radius="0.0025" mass="0.110">
      <contact condim="3" selfcollide="none" passive="true" solref="0.006 1" solimp="0.90 0.96 0.001" friction="0.32 0.005 0.0001" />
      <elasticity young="12000" poisson="0.32" thickness="0.003" elastic2d="both" damping="0.03" />
    </flexcomp>
    <flexcomp name="dough_block" type="grid" dim="3" count="5 5 3" spacing="0.017 0.017 0.013" pos="-0.264 -0.095 0.079" radius="0.0028" mass="0.330">
      <contact condim="3" selfcollide="none" passive="true" solref="0.006 1" solimp="0.90 0.96 0.001" friction="0.26 0.005 0.0001" />
      <elasticity young="8000" poisson="0.35" damping="0.05" />
    </flexcomp>
  </worldbody>
  <actuator>
    <general name="pb_tray_actuator" joint="pb_tray_slide" ctrlrange="-0.08 0.08" forcerange="-60 60" biastype="affine" gainprm="450" biasprm="0 -450 -30" />
    <general name="pb_roller_x_actuator" joint="pb_roller_x" ctrlrange="-0.14 0.28" forcerange="-90 90" biastype="affine" gainprm="650" biasprm="0 -650 -40" />
    <general name="pb_roller_z_actuator" joint="pb_roller_z" ctrlrange="-0.048 0.04" forcerange="-120 120" biastype="affine" gainprm="900" biasprm="0 -900 -55" />
    <general name="pb_roller_spin_actuator" joint="pb_roller_spin" ctrlrange="-31.4 31.4" forcerange="-12 12" biastype="affine" gainprm="18" biasprm="0 -18 -1.2" />
    <general name="pb_crimper_x_actuator" joint="pb_crimper_x" ctrlrange="-0.14 0.14" forcerange="-80 80" biastype="affine" gainprm="550" biasprm="0 -550 -35" />
    <general name="pb_crimper_z_actuator" joint="pb_crimper_z" ctrlrange="-0.090 0.03" forcerange="-140 140" biastype="affine" gainprm="950" biasprm="0 -950 -60" />
    <general name="pb_duster_actuator" joint="pb_duster_shake" ctrlrange="0 0.05" forcerange="-25 25" biastype="affine" gainprm="220" biasprm="0 -220 -14" />
    <general name="pb_press_x_actuator" joint="pb_press_x" ctrlrange="-0.035 0.035" forcerange="-80 80" biastype="affine" gainprm="550" biasprm="0 -550 -35" />
    <general name="pb_press_z_actuator" joint="pb_press_z" ctrlrange="-0.042 0.025" forcerange="-150 150" biastype="affine" gainprm="980" biasprm="0 -980 -60" />
  </actuator>
</mujoco>
"""


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    glb_path = ASSET_DIR / "pastry-bench.glb"
    native_path = ASSET_DIR / "native.xml"
    scene_path = ASSET_DIR / "scene.xml"

    glb_meta = build_glb(glb_path)
    native_xml = build_native_xml()
    native_path.write_text(native_xml, encoding="utf-8")
    scene_path.write_text('<mujoco model="Pastry bench scene">\n  <include file="native.xml" />\n</mujoco>\n', encoding="utf-8")

    readme = (
        "# Pastry Bench (`pastry-bench`)\n\n"
        "End-grain rock-maple pastry bench with 3-tin 12 cm pie tray, French beechwood rolling pin,\n"
        "stainless docker/crimper press, patisserie dough press platen, flour shaker, MuJoCo 4.0.0 2D shell\n"
        "`<flexcomp dim=\"2\">` pastry sheet, and 3D solid `<flexcomp dim=\"3\">` volumetric dough block.\n"
    )
    (ASSET_DIR / "README.md").write_text(readme, encoding="utf-8")

    report = {
        "model": "Satyr Kitchen Pastry Bench",
        "id": "pastry-bench",
        "mujoco_version": "4.0.0",
        "flexcomp": {
            "name": "pastry_sheet",
            "dim": 2,
            "grid_count": [9, 9, 1],
            "vertices": 81,
            "triangles": 128,
            "thickness_m": 0.003,
            "integrator": "discrete",
            "solver": "Newton",
        },
        "dough_block_flexcomp": {
            "name": "dough_block",
            "dim": 3,
            "grid_count": [5, 5, 3],
            "vertices": 75,
            "tetrahedra": 192,
            "boundary_triangles": 128,
            "mass_kg": 0.33,
            "young_pa": 8000,
            "poisson": 0.35,
            "integrator": "discrete",
            "solver": "Newton",
        },
        "glb_sha256": glb_meta["glb_sha256"],
        "native_sha256": hashlib.sha256(native_path.read_bytes()).hexdigest(),
        "blender_version": glb_meta["blender_version"],
    }
    (ASSET_DIR / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Built pastry-bench:", json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
