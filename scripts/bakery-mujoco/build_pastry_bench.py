"""Build the Seams Pantry Pastry Bench (pastry-bench) GLB visual and MuJoCo 4.0 flexcomp + standalone models.

Covers Savoury Pies (docs/recipes/pies.md):
- Pressing & folding 330 g 3D volumetric shortcrust dough blocks (<flexcomp dim="3">)
- Sheeting 3 mm shortcrust pastry (110 g per 12 cm tin, 330 g per 3-pie tray)
- Draping & crimping puff-pastry lids (80 g per 12 cm tin, 240 g per 3-pie tray)
- Real MuJoCo 4.0 2D shell (<flexcomp dim="2" elastic2d="both">) & 3D solid (<flexcomp dim="3">)
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_physics_kit import (
    BLENDER_BIN,
    COL_ACCESSORY_RGBA,
    COL_ARTIC_RGBA,
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
    SITE_SUPPORT_RGBA,
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    numbers,
    write_xml,
)

REPO_ROOT = ROOT
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

GLB_BODIES = (
    "pb_bench",
    "pb_pie_tray",
    "pb_roller",
    "pb_crimper",
    "pb_flour_duster",
    "pb_dough_carrier",
    "pb_dough_press",
)


def build_glb(glb_path: Path) -> dict[str, str]:
    """Run inside Blender to author and export pastry-bench.glb."""
    import bmesh
    import bpy
    from mathutils import Euler, Vector

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

    def make_empty(
        name: str,
        loc: tuple[float, float, float],
        parent: bpy.types.Object | None = None,
    ) -> bpy.types.Object:
        obj = bpy.data.objects.new(name, None)
        obj.location = Vector(loc)
        bpy.context.collection.objects.link(obj)
        if parent is not None:
            obj.parent = parent
        return obj

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
    meta = {
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "blender_version": bpy.app.version_string,
    }
    (glb_path.parent / ".glb-meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def _add_pbr_materials(asset: ET.Element) -> None:
    """Attach untextured PBR scalar materials for pure-primitive visual geometry."""
    for name, rgba, roughness, metallic in (
        ("pb_mat_maple", "0.78 0.58 0.36 1", "0.42", "0.0"),
        ("pb_mat_beech", "0.82 0.65 0.43 1", "0.36", "0.0"),
        ("pb_mat_walnut", "0.34 0.21 0.13 1", "0.38", "0.0"),
        ("pb_mat_steel", "0.76 0.79 0.82 1", "0.24", "0.90"),
        ("pb_mat_tin", "0.83 0.85 0.88 1", "0.28", "0.86"),
        ("pb_mat_rubber", "0.12 0.13 0.15 1", "0.78", "0.0"),
        ("pb_mat_bezel", "0.11 0.13 0.16 1", "0.32", "0.45"),
        ("pb_mat_lamp", "0.18 0.82 0.42 1", "0.25", "0.0"),
    ):
        ET.SubElement(
            asset,
            "material",
            name=name,
            rgba=rgba,
            roughness=roughness,
            metallic=metallic,
        )


def _add_vis_geom(
    parent: ET.Element,
    name: str,
    gtype: str,
    *,
    material: str,
    size: str | tuple[float, ...],
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    fromto: tuple[float, float, float, float, float, float] | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": gtype,
        "material": material,
        "contype": "0",
        "conaffinity": "0",
        "density": "0",
        "mass": "0",
        "group": "2",
    }
    if fromto is not None:
        attrib["fromto"] = numbers(fromto)
    elif pos is not None:
        attrib["pos"] = numbers(pos)
    if quat is not None:
        attrib["quat"] = quat
    attrib["size"] = size if isinstance(size, str) else numbers(size)
    return ET.SubElement(parent, "geom", **attrib)


def _add_col_geom(
    parent: ET.Element,
    name: str,
    gtype: str,
    *,
    size: str | tuple[float, ...],
    rgba: str,
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    fromto: tuple[float, float, float, float, float, float] | None = None,
    friction: str | None = None,
    solref: str | None = None,
    solimp: str | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": gtype,
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if fromto is not None:
        attrib["fromto"] = numbers(fromto)
    elif pos is not None:
        attrib["pos"] = numbers(pos)
    if quat is not None:
        attrib["quat"] = quat
    attrib["size"] = size if isinstance(size, str) else numbers(size)
    if friction is not None:
        attrib["friction"] = friction
    if solref is not None:
        attrib["solref"] = solref
    if solimp is not None:
        attrib["solimp"] = solimp
    return ET.SubElement(parent, "geom", **attrib)


def _add_pie_tin_capsules(
    parent: ET.Element,
    *,
    include_visuals: bool,
) -> None:
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
        mx0, my0 = r_mid * math.cos(ang0), r_mid * math.sin(ang0)
        mx1, my1 = r_mid * math.cos(ang1), r_mid * math.sin(ang1)
        rim_ft = (x0, y0, z_rim_rel, x1, y1, z_rim_rel)
        wall_ft = (mx0, my0, z_mid_rel, mx1, my1, z_mid_rel)
        _add_col_geom(
            parent,
            f"pb_tin_rim_{i}",
            "capsule",
            size="0.0045",
            fromto=rim_ft,
            rgba=COL_WALL_RGBA,
            friction="0.35 0.015 0.003",
            solref="0.006 1",
            solimp="0.90 0.96 0.001",
        )
        _add_col_geom(
            parent,
            f"pb_tin_wall_{i}",
            "capsule",
            size="0.0045",
            fromto=wall_ft,
            rgba=COL_WALL_RGBA,
            friction="0.35 0.015 0.003",
            solref="0.006 1",
            solimp="0.90 0.96 0.001",
        )
        if include_visuals:
            _add_vis_geom(
                parent,
                f"pb_tin_rim_{i}_vis",
                "capsule",
                material="pb_mat_tin",
                size="0.0045",
                fromto=rim_ft,
            )
            _add_vis_geom(
                parent,
                f"pb_tin_wall_{i}_vis",
                "capsule",
                material="pb_mat_tin",
                size="0.0045",
                fromto=wall_ft,
            )


def build_standalone_models() -> None:
    """Emit MjSpec.attach-ready model.xml (pb_bench) and carrier_model.xml with matched visual & collision primitives."""
    doc = ET.Element("mujoco", model="pb_bench")
    ET.SubElement(doc, "compiler", angle="radian")
    defaults = add_standard_defaults(
        doc,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )
    asset = ET.SubElement(doc, "asset")
    _add_pbr_materials(asset)

    # Single top-level root body pb_bench at (0, 0, 0), quat=(1, 0, 0, 0)
    bench = ET.Element("body", name="pb_bench", pos="0 0 0", quat="1 0 0 0")
    ET.SubElement(
        bench,
        "inertial",
        pos="0 0 0.032",
        mass="14.5",
        diaginertia="0.28 0.52 0.76",
    )

    # Maple slab (Z = 0.012 .. 0.062 m) + four 12 mm rubber feet (Z = 0.000 .. 0.012 m)
    _add_vis_geom(
        bench,
        "pb_maple_slab_vis",
        "box",
        material="pb_mat_maple",
        pos=(0.0, 0.0, 0.037),
        size=(0.32, 0.23, 0.025),
    )
    _add_col_geom(
        bench,
        "pb_slab_col",
        "box",
        pos=(0.0, 0.0, 0.037),
        size=(0.32, 0.23, 0.025),
        rgba=COL_BASE_RGBA,
        friction="0.42 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    for sx, tx in ((-0.27, "l"), (0.27, "r")):
        for sy, ty in ((-0.18, "f"), (0.18, "b")):
            _add_vis_geom(
                bench,
                f"pb_foot_{tx}_{ty}_vis",
                "cylinder",
                material="pb_mat_rubber",
                pos=(sx, sy, 0.006),
                size=(0.022, 0.006),
            )
            _add_col_geom(
                bench,
                f"pb_foot_{tx}_{ty}_col",
                "cylinder",
                pos=(sx, sy, 0.006),
                size=(0.022, 0.006),
                rgba=COL_BASE_RGBA,
            )

    # 3 mm stainless thickness gauge rails along front & rear sheeting lane
    for sy, tag in ((-0.162, "front"), (0.162, "rear")):
        _add_vis_geom(
            bench,
            f"pb_gauge_rail_{tag}_vis",
            "box",
            material="pb_mat_steel",
            pos=(0.0, sy, 0.0635),
            size=(0.21, 0.007, 0.0015),
        )
        _add_col_geom(
            bench,
            f"pb_gauge_rail_{tag}_col",
            "box",
            pos=(0.0, sy, 0.0635),
            size=(0.21, 0.007, 0.0015),
            rgba=COL_BASE_RGBA,
        )

    # Front digital thickness/crimp readout bezel + live gauge
    _add_vis_geom(
        bench,
        "pb_front_bezel_vis",
        "box",
        material="pb_mat_bezel",
        pos=(0.0, -0.230, 0.036),
        size=(0.055, 0.003, 0.013),
    )
    _add_col_geom(
        bench,
        "pb_front_bezel_col",
        "box",
        pos=(0.0, -0.230, 0.036),
        size=(0.055, 0.003, 0.013),
        rgba=COL_BASE_RGBA,
    )
    live_gauge = ET.SubElement(
        bench,
        "body",
        name="live_gauge",
        pos="0 -0.2305 0.036",
        quat=Y_AXIS_QUAT,
    )
    _add_vis_geom(
        live_gauge,
        "live_gauge_back",
        "box",
        material="pb_mat_bezel",
        size=(0.024, 0.008, 0.0004),
    )
    _add_vis_geom(
        live_gauge,
        "live_flour_lamp",
        "sphere",
        material="pb_mat_lamp",
        pos=(0.020, 0.0, 0.0008),
        size="0.0022",
    )

    ET.SubElement(
        bench,
        "site",
        name="vessel_socket",
        pos="-0.22 0.13 0.064",
        size="0.005",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Articulated child 1: Pie tray (horizontal Y slide)
    pie_tray = ET.SubElement(bench, "body", name="pb_pie_tray", pos=numbers((0.0, 0.0, TRAY_Z)))
    ET.SubElement(
        pie_tray,
        "inertial",
        pos="0 0 0.012",
        mass="0.68",
        diaginertia="0.0052 0.0091 0.014",
    )
    ET.SubElement(
        pie_tray,
        "joint",
        name="pb_tray_slide",
        type="slide",
        axis="0 1 0",
        range="-0.08 0.08",
        damping="18",
        armature="0.04",
        frictionloss="0.5",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_vis_geom(
        pie_tray,
        "pb_tray_deck_vis",
        "box",
        material="pb_mat_steel",
        pos=(0.0, 0.0, 0.001),
        size=(0.21, 0.14, 0.001),
    )
    _add_col_geom(
        pie_tray,
        "pb_tray_deck_col",
        "box",
        pos=(0.0, 0.0, 0.001),
        size=(0.21, 0.14, 0.001),
        rgba=COL_WALL_RGBA,
        friction="0.35 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    _add_vis_geom(
        pie_tray,
        "pb_tin_floor_vis",
        "cylinder",
        material="pb_mat_tin",
        pos=(0.0, 0.0, 0.002),
        size=(0.052, 0.002),
    )
    _add_col_geom(
        pie_tray,
        "pb_tin_floor",
        "cylinder",
        pos=(0.0, 0.0, 0.002),
        size=(0.052, 0.002),
        rgba=COL_WALL_RGBA,
        friction="0.35 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    _add_pie_tin_capsules(pie_tray, include_visuals=True)

    # Articulated child 2: Rolling pin (X slide, vertical Z slide with gravity-hold friction, Y spin)
    roller = ET.SubElement(bench, "body", name="pb_roller", pos=numbers(ROLLER_POS))
    ET.SubElement(
        roller,
        "inertial",
        pos="0 0 0",
        mass="0.85",
        diaginertia="0.0042 0.00035 0.0042",
    )
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_x",
        type="slide",
        axis="1 0 0",
        range="-0.14 0.28",
        damping="22",
        armature="0.05",
        frictionloss="0.5",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_z",
        type="slide",
        axis="0 0 1",
        range="-0.048 0.04",
        damping="28",
        armature="0.05",
        frictionloss="12.0",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_spin",
        type="hinge",
        axis="0 1 0",
        range="-31.4 31.4",
        damping="0.35",
        armature="0.004",
        frictionloss="0.05",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_vis_geom(
        roller,
        "pb_roller_barrel_vis",
        "capsule",
        material="pb_mat_beech",
        size="0.022",
        fromto=(0.0, -0.115, 0.0, 0.0, 0.115, 0.0),
    )
    _add_col_geom(
        roller,
        "pb_roller_barrel",
        "capsule",
        size="0.022",
        fromto=(0.0, -0.115, 0.0, 0.0, 0.115, 0.0),
        rgba=COL_ARTIC_RGBA,
        friction="0.28 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    for tag, y0, y1 in (("front", -0.196, -0.128), ("rear", 0.128, 0.196)):
        _add_vis_geom(
            roller,
            f"pb_roller_handle_{tag}_vis",
            "capsule",
            material="pb_mat_walnut",
            size="0.013",
            fromto=(0.0, y0, 0.0, 0.0, y1, 0.0),
        )
        _add_col_geom(
            roller,
            f"pb_roller_handle_{tag}_col",
            "capsule",
            size="0.013",
            fromto=(0.0, y0, 0.0, 0.0, y1, 0.0),
            rgba=COL_ARTIC_RGBA,
        )

    # Articulated child 3: Docker & fluted rim crimper (X slide, vertical Z slide with gravity-hold friction)
    crimper = ET.SubElement(bench, "body", name="pb_crimper", pos=numbers(CRIMPER_POS))
    ET.SubElement(
        crimper,
        "inertial",
        pos="0 0 0",
        mass="0.52",
        diaginertia="0.0008 0.0008 0.0014",
    )
    ET.SubElement(
        crimper,
        "joint",
        name="pb_crimper_x",
        type="slide",
        axis="1 0 0",
        range="-0.14 0.14",
        damping="20",
        armature="0.04",
        frictionloss="0.5",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        crimper,
        "joint",
        name="pb_crimper_z",
        type="slide",
        axis="0 0 1",
        range="-0.090 0.03",
        damping="26",
        armature="0.04",
        frictionloss="8.0",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_vis_geom(
        crimper,
        "pb_crimper_plunger_vis",
        "sphere",
        material="pb_mat_steel",
        pos=(0.0, 0.0, -0.012),
        size="0.036",
    )
    _add_col_geom(
        crimper,
        "pb_crimper_plunger",
        "sphere",
        pos=(0.0, 0.0, -0.012),
        size="0.036",
        rgba=COL_ARTIC_RGBA,
        friction="0.22 0.015 0.003",
        solref="0.007 1",
        solimp="0.88 0.95 0.001",
    )
    _add_vis_geom(
        crimper,
        "pb_crimper_collar_vis",
        "cylinder",
        material="pb_mat_steel",
        pos=(0.0, 0.0, 0.008),
        size=(0.063, 0.004),
    )
    _add_col_geom(
        crimper,
        "pb_crimper_collar",
        "cylinder",
        pos=(0.0, 0.0, 0.008),
        size=(0.063, 0.004),
        rgba=COL_ARTIC_RGBA,
        friction="0.30 0.015 0.003",
        solref="0.007 1",
        solimp="0.88 0.95 0.001",
    )
    _add_vis_geom(
        crimper,
        "pb_crimper_stem_vis",
        "cylinder",
        material="pb_mat_walnut",
        pos=(0.0, 0.0, 0.040),
        size=(0.012, 0.028),
    )
    _add_col_geom(
        crimper,
        "pb_crimper_stem_col",
        "cylinder",
        pos=(0.0, 0.0, 0.040),
        size=(0.012, 0.028),
        rgba=COL_ARTIC_RGBA,
    )

    # Articulated child 4: Flour duster shaker (vertical Z slide with gravity-hold friction, collider enabled!)
    duster = ET.SubElement(bench, "body", name="pb_flour_duster", pos=numbers(DUSTER_POS))
    ET.SubElement(
        duster,
        "inertial",
        pos="0 0 0.04",
        mass="0.24",
        diaginertia="0.0003 0.0003 0.0002",
    )
    ET.SubElement(
        duster,
        "joint",
        name="pb_duster_shake",
        type="slide",
        axis="0 0 1",
        range="0 0.05",
        damping="8",
        armature="0.02",
        frictionloss="4.0",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_vis_geom(
        duster,
        "pb_duster_can_vis",
        "cylinder",
        material="pb_mat_steel",
        pos=(0.0, 0.0, 0.045),
        size=(0.032, 0.045),
    )
    _add_col_geom(
        duster,
        "pb_duster_col",
        "cylinder",
        pos=(0.0, 0.0, 0.045),
        size=(0.032, 0.045),
        rgba=COL_ARTIC_RGBA,
    )

    # Articulated child 5: Dough press platen (X slide, vertical Z slide with gravity-hold friction)
    press = ET.SubElement(bench, "body", name="pb_dough_press", pos=numbers(DOUGH_PRESS_POS))
    ET.SubElement(
        press,
        "inertial",
        pos="0 0 0.012",
        mass="0.64",
        diaginertia="0.0012 0.0012 0.0018",
    )
    ET.SubElement(
        press,
        "joint",
        name="pb_press_x",
        type="slide",
        axis="1 0 0",
        range="-0.035 0.035",
        damping="22",
        armature="0.04",
        frictionloss="0.5",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    ET.SubElement(
        press,
        "joint",
        name="pb_press_z",
        type="slide",
        axis="0 0 1",
        range="-0.042 0.025",
        damping="28",
        armature="0.04",
        frictionloss="9.5",
        limited="true",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_vis_geom(
        press,
        "pb_press_plate_vis",
        "box",
        material="pb_mat_steel",
        pos=(0.0, 0.0, -0.006),
        size=(0.048, 0.048, 0.006),
    )
    _add_col_geom(
        press,
        "pb_press_plate",
        "box",
        pos=(0.0, 0.0, -0.006),
        size=(0.048, 0.048, 0.006),
        rgba=COL_ARTIC_RGBA,
        friction="0.22 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    _add_vis_geom(
        press,
        "pb_press_handle_vis",
        "capsule",
        material="pb_mat_walnut",
        size="0.010",
        fromto=(-0.039, 0.0, 0.032, 0.039, 0.0, 0.032),
    )
    _add_col_geom(
        press,
        "pb_press_handle_col",
        "capsule",
        size="0.010",
        fromto=(-0.039, 0.0, 0.032, 0.039, 0.0, 0.032),
        rgba=COL_ARTIC_RGBA,
    )

    # Removable chilled pastry carrier peel (exported as standalone carrier_model.xml)
    carrier = ET.Element("body", name="pb_dough_carrier", pos=numbers(CARRIER_POS))
    ET.SubElement(
        carrier,
        "inertial",
        pos="0 0 0.015",
        mass="0.35",
        diaginertia="0.0009 0.0009 0.0016",
    )
    ET.SubElement(carrier, "freejoint", name="pb_dough_carrier_free")
    _add_vis_geom(
        carrier,
        "pb_carrier_base_vis",
        "cylinder",
        material="pb_mat_beech",
        pos=(0.0, 0.0, 0.003),
        size=(0.088, 0.003),
    )
    _add_col_geom(
        carrier,
        "pb_carrier_base",
        "cylinder",
        pos=(0.0, 0.0, 0.003),
        size=(0.088, 0.003),
        rgba=COL_ACCESSORY_RGBA,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
    )

    # Exclude bench <-> child tool & tool <-> tool pairs during independent joint sweeps
    tool_bodies = (
        "pb_bench",
        "pb_pie_tray",
        "pb_roller",
        "pb_crimper",
        "pb_flour_duster",
        "pb_dough_press",
    )
    exclude_pairs = [
        (f"exclude_{b1}_{b2}", b1, b2)
        for b1, b2 in itertools.combinations(tool_bodies, 2)
    ]
    contact = add_adjacent_excludes(doc, exclude_pairs)

    emit_standalone_models(
        ASSET_DIR,
        model_name="pb_bench",
        defaults=defaults,
        asset=asset,
        root_body=bench,
        contact=contact,
        accessories=(("carrier_model.xml", "pb_dough_carrier", carrier),),
    )


def build_native_scene_xml() -> ET.Element:
    """Build the MuJoCo 4.0 deformable dough-lab scene (native.xml) preserving Rust runner compatibility."""
    root = ET.Element("mujoco", model="Seams Pantry pastry bench deformable dough lab")
    ET.SubElement(root, "compiler", angle="radian")
    ET.SubElement(
        root,
        "option",
        timestep="0.002",
        solver="Newton",
        tolerance="1e-6",
        iterations="200",
        integrator="discrete",
    )
    ET.SubElement(root, "size", nuserdata="4")
    ET.SubElement(root, "statistic", extent="0.75", center="0 0 0.14")
    vis = ET.SubElement(root, "visual")
    ET.SubElement(vis, "global", offwidth="1280", offheight="960")
    ET.SubElement(vis, "quality", shadowsize="2048")
    ET.SubElement(vis, "headlight", ambient="0.35 0.35 0.35", diffuse="0.7 0.7 0.7")

    add_standard_defaults(
        root,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    world = ET.SubElement(root, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="pb_floor",
        type="plane",
        size="2 2 0.05",
        pos="0 0 -0.001",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        world,
        "light",
        pos="-0.4 -0.5 0.9",
        dir="0.28 0.32 -0.90",
        diffuse="0.8 0.8 0.8",
    )
    ET.SubElement(
        world,
        "light",
        castshadow="false",
        pos="0.4 0.3 0.7",
        dir="-0.28 -0.28 -0.92",
        diffuse="0.45 0.45 0.45",
    )

    # 1. Static bench frame
    bench = ET.SubElement(world, "body", name="pb_bench", pos="0 0 0")
    ET.SubElement(bench, "inertial", pos="0 0 0.032", mass="14.5", diaginertia="0.28 0.52 0.76")
    _add_col_geom(
        bench,
        "pb_slab_col",
        "box",
        size=(0.32, 0.23, 0.031),
        pos=(0.0, 0.0, 0.031),
        rgba=COL_BASE_RGBA,
        friction="0.42 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    ET.SubElement(
        bench,
        "site",
        name="vessel_socket",
        pos="-0.22 0.13 0.064",
        size="0.005",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    live_gauge = ET.SubElement(
        bench,
        "body",
        name="live_gauge",
        pos="0 -0.2305 0.036",
        quat=Y_AXIS_QUAT,
    )
    ET.SubElement(
        live_gauge,
        "geom",
        name="live_gauge_back",
        type="box",
        size="0.024 0.008 0.0004",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.08 0.09 0.11 1",
        mass="0",
    )
    ET.SubElement(
        live_gauge,
        "geom",
        name="live_flour_lamp",
        type="sphere",
        size="0.0022",
        pos="0.020 0 0.0008",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.18 0.82 0.42 1",
        mass="0",
    )

    # 2. Pie tray
    pie_tray = ET.SubElement(world, "body", name="pb_pie_tray", pos=numbers((0.0, 0.0, TRAY_Z)))
    ET.SubElement(pie_tray, "inertial", pos="0 0 0.012", mass="0.68", diaginertia="0.0052 0.0091 0.014")
    ET.SubElement(
        pie_tray,
        "joint",
        name="pb_tray_slide",
        type="slide",
        axis="0 1 0",
        range="-0.08 0.08",
        damping="18",
        armature="0.04",
        limited="true",
        solreflimit="0.005 1",
    )
    _add_col_geom(
        pie_tray,
        "pb_tin_floor",
        "cylinder",
        size=(0.052, 0.002),
        pos=(0.0, 0.0, 0.002),
        rgba=COL_WALL_RGBA,
        friction="0.35 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )
    _add_pie_tin_capsules(pie_tray, include_visuals=False)

    # 3. Rolling pin
    roller = ET.SubElement(world, "body", name="pb_roller", pos=numbers(ROLLER_POS))
    ET.SubElement(roller, "inertial", pos="0 0 0", mass="0.85", diaginertia="0.0042 0.00035 0.0042")
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_x",
        type="slide",
        axis="1 0 0",
        range="-0.14 0.28",
        damping="22",
        armature="0.05",
        limited="true",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_z",
        type="slide",
        axis="0 0 1",
        range="-0.048 0.04",
        damping="28",
        armature="0.05",
        limited="true",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        roller,
        "joint",
        name="pb_roller_spin",
        type="hinge",
        axis="0 1 0",
        range="-31.4 31.4",
        damping="0.35",
        armature="0.004",
        limited="true",
        solreflimit="0.005 1",
    )
    _add_col_geom(
        roller,
        "pb_roller_barrel",
        "capsule",
        size="0.022",
        fromto=(0.0, -0.115, 0.0, 0.0, 0.115, 0.0),
        rgba=COL_ARTIC_RGBA,
        friction="0.28 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )

    # 4. Crimper
    crimper = ET.SubElement(world, "body", name="pb_crimper", pos=numbers(CRIMPER_POS))
    ET.SubElement(crimper, "inertial", pos="0 0 0", mass="0.52", diaginertia="0.0008 0.0008 0.0014")
    ET.SubElement(
        crimper,
        "joint",
        name="pb_crimper_x",
        type="slide",
        axis="1 0 0",
        range="-0.14 0.14",
        damping="20",
        armature="0.04",
        limited="true",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        crimper,
        "joint",
        name="pb_crimper_z",
        type="slide",
        axis="0 0 1",
        range="-0.090 0.03",
        damping="26",
        armature="0.04",
        limited="true",
        solreflimit="0.005 1",
    )
    _add_col_geom(
        crimper,
        "pb_crimper_plunger",
        "sphere",
        size="0.036",
        pos=(0.0, 0.0, -0.012),
        rgba=COL_ARTIC_RGBA,
        friction="0.22 0.015 0.003",
        solref="0.007 1",
        solimp="0.88 0.95 0.001",
    )
    _add_col_geom(
        crimper,
        "pb_crimper_collar",
        "cylinder",
        size=(0.063, 0.004),
        pos=(0.0, 0.0, 0.008),
        rgba=COL_ARTIC_RGBA,
        friction="0.30 0.015 0.003",
        solref="0.007 1",
        solimp="0.88 0.95 0.001",
    )

    # 5. Flour duster (collider enabled with symmetric masks + bench exclude)
    duster = ET.SubElement(world, "body", name="pb_flour_duster", pos=numbers(DUSTER_POS))
    ET.SubElement(duster, "inertial", pos="0 0 0.04", mass="0.24", diaginertia="0.0003 0.0003 0.0002")
    ET.SubElement(
        duster,
        "joint",
        name="pb_duster_shake",
        type="slide",
        axis="0 0 1",
        range="0 0.05",
        damping="8",
        armature="0.02",
        limited="true",
        solreflimit="0.005 1",
    )
    _add_col_geom(
        duster,
        "pb_duster_col",
        "cylinder",
        size=(0.032, 0.045),
        pos=(0.0, 0.0, 0.045),
        rgba=COL_ARTIC_RGBA,
    )

    # 6. Chilled pastry portion carrier peel (6-DOF free vessel)
    carrier = ET.SubElement(world, "body", name="pb_dough_carrier", pos=numbers(CARRIER_POS))
    ET.SubElement(carrier, "inertial", pos="0 0 0.015", mass="0.35", diaginertia="0.0009 0.0009 0.0016")
    ET.SubElement(carrier, "joint", name="pb_dough_carrier_free", type="free")
    _add_col_geom(
        carrier,
        "pb_carrier_base",
        "cylinder",
        size=(0.088, 0.003),
        pos=(0.0, 0.0, 0.003),
        rgba=COL_ACCESSORY_RGBA,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
    )
    payload = ET.SubElement(carrier, "body", name="ingredient_payload")
    ET.SubElement(payload, "inertial", pos="0 0 0", mass="1e-09", diaginertia="1e-12 1e-12 1e-12")
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        size="0.082 0.001",
        pos="0 0 0.006",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.90 0.82 0.64 0",
        mass="0",
    )

    # 7. Dough press platen
    press = ET.SubElement(world, "body", name="pb_dough_press", pos=numbers(DOUGH_PRESS_POS))
    ET.SubElement(press, "inertial", pos="0 0 0.012", mass="0.64", diaginertia="0.0012 0.0012 0.0018")
    ET.SubElement(
        press,
        "joint",
        name="pb_press_x",
        type="slide",
        axis="1 0 0",
        range="-0.035 0.035",
        damping="22",
        armature="0.04",
        limited="true",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        press,
        "joint",
        name="pb_press_z",
        type="slide",
        axis="0 0 1",
        range="-0.042 0.025",
        damping="28",
        armature="0.04",
        limited="true",
        solreflimit="0.005 1",
    )
    _add_col_geom(
        press,
        "pb_press_plate",
        "box",
        size=(0.048, 0.048, 0.006),
        pos=(0.0, 0.0, -0.006),
        rgba=COL_ARTIC_RGBA,
        friction="0.22 0.015 0.003",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
    )

    # Deformable 2D pastry sheet and 3D volumetric dough block
    sheet = ET.SubElement(
        world,
        "flexcomp",
        name="pastry_sheet",
        type="grid",
        dim="2",
        count="9 9 1",
        spacing="0.020 0.020 0.020",
        pos="0 0 0.100",
        radius="0.0025",
        mass="0.110",
    )
    ET.SubElement(
        sheet,
        "contact",
        condim="3",
        priority="1",
        selfcollide="none",
        passive="true",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
        friction="0.32 0.005 0.0001",
    )
    ET.SubElement(
        sheet,
        "elasticity",
        young="12000",
        poisson="0.32",
        thickness="0.003",
        elastic2d="both",
        damping="0.03",
    )

    block = ET.SubElement(
        world,
        "flexcomp",
        name="dough_block",
        type="grid",
        dim="3",
        count="5 5 3",
        spacing="0.017 0.017 0.013",
        pos="-0.264 -0.095 0.079",
        radius="0.0028",
        mass="0.330",
    )
    ET.SubElement(
        block,
        "contact",
        condim="3",
        priority="1",
        selfcollide="none",
        passive="true",
        solref="0.006 1",
        solimp="0.90 0.96 0.001",
        friction="0.26 0.005 0.0001",
    )
    ET.SubElement(
        block,
        "elasticity",
        young="8000",
        poisson="0.35",
        damping="0.05",
    )

    add_adjacent_excludes(
        root,
        (
            ("exclude_bench_tray", "pb_bench", "pb_pie_tray"),
            ("exclude_bench_duster", "pb_bench", "pb_flour_duster"),
            ("exclude_bench_roller", "pb_bench", "pb_roller"),
            ("exclude_bench_crimper", "pb_bench", "pb_crimper"),
            ("exclude_bench_press", "pb_bench", "pb_dough_press"),
        ),
    )

    actuators = ET.SubElement(root, "actuator")
    for aname, jname, crange, frange, gain, bias in (
        ("pb_tray_actuator", "pb_tray_slide", "-0.08 0.08", "-60 60", "450", "0 -450 -30"),
        ("pb_roller_x_actuator", "pb_roller_x", "-0.14 0.28", "-90 90", "650", "0 -650 -40"),
        ("pb_roller_z_actuator", "pb_roller_z", "-0.048 0.04", "-120 120", "900", "0 -900 -55"),
        ("pb_roller_spin_actuator", "pb_roller_spin", "-31.4 31.4", "-12 12", "18", "0 -18 -1.2"),
        ("pb_crimper_x_actuator", "pb_crimper_x", "-0.14 0.14", "-80 80", "550", "0 -550 -35"),
        ("pb_crimper_z_actuator", "pb_crimper_z", "-0.090 0.03", "-140 140", "950", "0 -950 -60"),
        ("pb_duster_actuator", "pb_duster_shake", "0 0.05", "-25 25", "220", "0 -220 -14"),
        ("pb_press_x_actuator", "pb_press_x", "-0.035 0.035", "-80 80", "550", "0 -550 -35"),
        ("pb_press_z_actuator", "pb_press_z", "-0.042 0.025", "-150 150", "980", "0 -980 -60"),
    ):
        ET.SubElement(
            actuators,
            "general",
            name=aname,
            joint=jname,
            ctrlrange=crange,
            forcerange=frange,
            biastype="affine",
            gainprm=gain,
            biasprm=bias,
        )

    return root


def write_xmls_and_verify() -> None:
    """Write model.xml, carrier_model.xml, scene.xml, native.xml, verify dynamics parity & GLB rest frames."""
    import mujoco
    import numpy as np

    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    glb_path = ASSET_DIR / "pastry-bench.glb"
    meta_path = ASSET_DIR / ".glb-meta.json"
    if meta_path.is_file():
        glb_meta = json.loads(meta_path.read_text())
        meta_path.unlink(missing_ok=True)
    else:
        glb_meta = {
            "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
            "blender_version": "unknown",
        }

    # 1. Emit standalone model.xml and carrier_model.xml
    build_standalone_models()

    # 2. Write native.xml directly (MjSpec.to_xml() does not support <flexcomp> round-trip)
    #    and scene.xml including native.xml, then verify dynamics parity & flexcomp stepping.
    native_root = build_native_scene_xml()
    native_path = ASSET_DIR / "native.xml"
    scene_path = ASSET_DIR / "scene.xml"
    write_xml(native_path, native_root)
    scene_path.write_text(
        '<mujoco model="Pastry bench scene">\n  <include file="native.xml" />\n</mujoco>\n',
        encoding="utf-8",
    )

    scene_model = mujoco.MjModel.from_xml_path(str(scene_path))
    native_model = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(
            getattr(scene_model, field), getattr(native_model, field), rtol=1e-5, atol=1e-9
        ):
            raise RuntimeError(f"Parity mismatch in {field} for pastry-bench")
    if (native_model.nq, native_model.nv) != (scene_model.nq, scene_model.nv):
        raise RuntimeError(
            f"Parity mismatch in DOFs for pastry-bench: "
            f"{(native_model.nq, native_model.nv)} vs {(scene_model.nq, scene_model.nv)}"
        )

    # Verify both flexcomp grids survive export and step cleanly without NaNs
    assert native_model.nflex == 2, f"Expected 2 flexcomp bodies, got {native_model.nflex}"
    ndata = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, ndata)
    for _ in range(50):
        mujoco.mj_step(native_model, ndata)
    assert np.all(np.isfinite(ndata.qpos)) and np.all(np.isfinite(ndata.qvel))

    # Verify standalone model.xml and carrier_model.xml compile cleanly
    standalone_model = mujoco.MjModel.from_xml_path(str(ASSET_DIR / "model.xml"))
    carrier_model = mujoco.MjModel.from_xml_path(str(ASSET_DIR / "carrier_model.xml"))
    assert standalone_model.nbody >= 6 and carrier_model.nbody == 2

    # Verify GLB rest poses against native.xml
    mujoco.mj_resetData(native_model, ndata)
    mujoco.mj_forward(native_model, ndata)
    native_sha = hashlib.sha256((ASSET_DIR / "native.xml").read_bytes()).hexdigest()
    frames_in = ASSET_DIR / ".frames-input.json"
    frames_out = ASSET_DIR / ".frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                "pastry-bench": {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "bodies": {
                        bname: [
                            *ndata.xpos[native_model.body(bname).id].tolist(),
                            *ndata.xquat[native_model.body(bname).id].tolist(),
                        ]
                        for bname in GLB_BODIES
                    },
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(frames_in),
            str(frames_out),
        ],
        check=True,
    )
    frames_report = json.loads(frames_out.read_text())
    frames_in.unlink(missing_ok=True)
    frames_out.unlink(missing_ok=True)
    assert frames_report["passed"] is True, frames_report

    readme = (
        "# Pastry Bench (`pastry-bench`)\n\n"
        "End-grain rock-maple pastry bench with 3-tin 12 cm pie tray, French beechwood rolling pin,\n"
        "stainless docker/crimper press, patisserie dough press platen, flour shaker, MuJoCo 4.0 2D shell\n"
        "`<flexcomp dim=\"2\">` pastry sheet, and 3D solid `<flexcomp dim=\"3\">` volumetric dough block.\n"
    )
    (ASSET_DIR / "README.md").write_text(readme, encoding="utf-8")

    report = {
        "model": "Seams Pantry Pastry Bench",
        "id": "pastry-bench",
        "mujoco_version": mujoco.__version__,
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
        "native_nq": int(native_model.nq),
        "native_nv": int(native_model.nv),
        "standalone_mass_kg": round(float(np.sum(standalone_model.body_mass[1:])), 4),
        "frames_passed": frames_report["passed"],
        "glb_sha256": glb_meta["glb_sha256"],
        "native_sha256": native_sha,
        "blender_version": glb_meta["blender_version"],
    }
    (ASSET_DIR / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Built pastry-bench:", json.dumps(report, indent=2))


def main() -> None:
    if "--blender-export" in sys.argv or "bpy" in sys.modules:
        ASSET_DIR.mkdir(parents=True, exist_ok=True)
        build_glb(ASSET_DIR / "pastry-bench.glb")
        return

    subprocess.run(
        [
            str(BLENDER_BIN),
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--blender-export",
        ],
        check=True,
    )
    write_xmls_and_verify()


if __name__ == "__main__":
    main()
