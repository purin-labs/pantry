"""Build visual GLB meshes for every MuJoCo workcell body and fixture in PhysicsModel.

Run with Blender:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/bakery-robots/build_workcell_visuals.py
"""

import math
from pathlib import Path

import bpy

OUTPUT = (
    Path(__file__).resolve().parents[2]
    / "assets/bakery-mujoco/fr10-workcell/workcell-visuals.glb"
)


def make_material(
    name: str,
    color: tuple[float, float, float],
    metallic: float,
    roughness: float,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def make_root(name: str) -> bpy.types.Object:
    empty = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(empty)
    return empty


def finish_mesh(
    obj: bpy.types.Object,
    name: str,
    parent: bpy.types.Object,
    mat: bpy.types.Material,
    bevel_width: float = 0.0015,
    bevel_segments: int = 2,
) -> bpy.types.Object:
    obj.name = name
    obj.parent = parent
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
    if bevel_width > 0:
        bevel = obj.modifiers.new("Bevel", "BEVEL")
        bevel.width = bevel_width
        bevel.segments = bevel_segments
        bevel.limit_method = "ANGLE"
        bevel.angle_limit = math.radians(32)
        bevel.harden_normals = False
    wn = obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
    wn.keep_sharp = True
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def add_box(
    name: str,
    parent: bpy.types.Object,
    center: tuple[float, float, float],
    half_size: tuple[float, float, float],
    mat: bpy.types.Material,
    bevel_width: float = 0.0015,
    bevel_segments: int = 2,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center, rotation=rotation)
    obj = bpy.context.object
    obj.scale = (half_size[0] * 2.0, half_size[1] * 2.0, half_size[2] * 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    min_dim = min(half_size) * 2.0
    return finish_mesh(
        obj,
        name,
        parent,
        mat,
        min(bevel_width, min_dim * 0.22),
        bevel_segments,
    )


def add_cylinder(
    name: str,
    parent: bpy.types.Object,
    center: tuple[float, float, float],
    radius: float,
    length: float,
    mat: bpy.types.Material,
    axis: str = "Z",
    vertices: int = 36,
    bevel_width: float = 0.001,
) -> bpy.types.Object:
    rot = (0.0, 0.0, 0.0)
    if axis == "X":
        rot = (0.0, math.pi / 2.0, 0.0)
    elif axis == "Y":
        rot = (math.pi / 2.0, 0.0, 0.0)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=length,
        location=center,
        rotation=rot,
    )
    obj = bpy.context.object
    return finish_mesh(
        obj,
        name,
        parent,
        mat,
        min(bevel_width, min(radius, length * 0.5) * 0.25),
        2,
    )


def subtract_cutter(target: bpy.types.Object, cutter: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = target
    mod = target.modifiers.new("Cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def build_standard_tooling(mats: dict[str, bpy.types.Material]) -> None:
    """Matches assets/bakery-mujoco/fr10-workcell/gripper.xml in Z-up frame."""
    gripper = make_root("standard_gripper")
    # ISO flange adapter cylinder at [0.012, 0, 0], r=0.04, halfLen=0.012
    adapter = add_cylinder(
        "std_clamp_adapter",
        gripper,
        (0.012, 0.0, 0.0),
        0.040,
        0.024,
        mats["machined_aluminium"],
        axis="X",
        vertices=48,
        bevel_width=0.0012,
    )
    for idx in range(4):
        ang = math.pi / 4.0 + idx * (math.pi / 2.0)
        by = 0.028 * math.cos(ang)
        bz = 0.028 * math.sin(ang)
        add_cylinder(
            f"std_clamp_bolt_{idx}",
            gripper,
            (0.003, by, bz),
            0.0036,
            0.005,
            mats["dark_steel"],
            axis="X",
            vertices=16,
            bevel_width=0.0004,
        )
    _ = adapter

    # Anodized teal palm body at [0.035, 0, 0.01], half=[0.02, 0.17, 0.035]
    add_box(
        "std_clamp_palm",
        gripper,
        (0.035, 0.0, 0.010),
        (0.020, 0.170, 0.033),
        mats["anodized_teal"],
        bevel_width=0.0022,
    )
    # Compact servo drive housing & guide rods inside palm envelope
    add_box(
        "std_clamp_servo",
        gripper,
        (0.033, 0.0, 0.024),
        (0.021, 0.046, 0.020),
        mats["drive_housing"],
        bevel_width=0.0018,
    )
    for side, sy in (("l", 0.095), ("r", -0.095)):
        add_cylinder(
            f"std_clamp_guide_rod_{side}",
            gripper,
            (0.048, sy, 0.018),
            0.005,
            0.056,
            mats["stainless_bright"],
            axis="Z",
            vertices=20,
            bevel_width=0.0005,
        )

    # Support forks at [0.18, ±0.14, -0.006], half=[0.13, 0.015, 0.006]
    for side, sy in (("left", 0.14), ("right", -0.14)):
        add_box(
            f"std_clamp_fork_{side}",
            gripper,
            (0.180, sy, -0.006),
            (0.130, 0.015, 0.006),
            mats["stainless_bright"],
            bevel_width=0.0014,
        )
        add_box(
            f"std_clamp_fork_root_{side}",
            gripper,
            (0.062, sy, -0.004),
            (0.014, 0.018, 0.010),
            mats["machined_aluminium"],
            bevel_width=0.0012,
        )

    jaw = make_root("standard_upper_jaw")
    # Upper bridge at [0.065, 0, 0.035], half=[0.012, 0.165, 0.01]
    add_box(
        "std_clamp_bridge",
        jaw,
        (0.065, 0.0, 0.035),
        (0.012, 0.165, 0.010),
        mats["anodized_teal"],
        bevel_width=0.0016,
    )
    add_box(
        "std_clamp_carriage",
        jaw,
        (0.058, 0.0, 0.035),
        (0.014, 0.040, 0.011),
        mats["machined_aluminium"],
        bevel_width=0.0014,
    )
    # Fingers at [0.1175, ±0.14, 0.035], half=[0.0525, 0.015, 0.01]
    # Silicone pads at [0.16, ±0.14, 0.0135], half=[0.025, 0.015, 0.0115]
    for side, sy in (("left", 0.14), ("right", -0.14)):
        add_box(
            f"std_clamp_finger_{side}",
            jaw,
            (0.1175, sy, 0.035),
            (0.0525, 0.015, 0.010),
            mats["machined_aluminium"],
            bevel_width=0.0016,
        )
        add_box(
            f"std_clamp_pad_backing_{side}",
            jaw,
            (0.160, sy, 0.022),
            (0.025, 0.0155, 0.003),
            mats["stainless_bright"],
            bevel_width=0.0007,
        )
        add_box(
            f"std_clamp_pad_{side}",
            jaw,
            (0.160, sy, 0.011),
            (0.025, 0.015, 0.009),
            mats["silicone_pad"],
            bevel_width=0.0018,
        )


def build_trays(mats: dict[str, bpy.types.Material]) -> None:
    """Matches maruzen-mbco-5e/tray.xml, cold_contents, and receiving_pan."""
    tray = make_root("tray_mbco")
    # Outer pan shell: 0.40 x 0.60 x 0.02 m (z in [-0.001, 0.019])
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.009))
    pan = bpy.context.object
    pan.scale = (0.400, 0.600, 0.020)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.012))
    cavity = bpy.context.object
    cavity.scale = (0.388, 0.588, 0.020)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    subtract_cutter(pan, cavity)
    finish_mesh(pan, "mbco_sheet_pan", tray, mats["tray_aluminium"], 0.0008, 2)

    # Rolled top wire bead along the 4 edges (within [-0.20, 0.20] x [-0.30, 0.30])
    bead_r = 0.0024
    for name, pos, length, axis in (
        ("mbco_bead_left", (-0.1975, 0.0, 0.0166), 0.596, "Y"),
        ("mbco_bead_right", (0.1975, 0.0, 0.0166), 0.596, "Y"),
        ("mbco_bead_front", (0.0, -0.2975, 0.0166), 0.395, "X"),
        ("mbco_bead_back", (0.0, 0.2975, 0.0166), 0.395, "X"),
    ):
        add_cylinder(
            name,
            tray,
            pos,
            bead_r,
            length,
            mats["stainless_bright"],
            axis=axis,
            vertices=20,
            bevel_width=0.0004,
        )

    # Silicone/parchment Silpat liner inside the sheet pan bed
    add_box(
        "mbco_silpat_mat",
        tray,
        (0.0, 0.0, 0.0024),
        (0.186, 0.286, 0.0007),
        mats["silpat_cream"],
        bevel_width=0.0003,
    )

    # Cold/baked financier mould + 12 golden financier ingots inside [±0.12, ±0.20, 0.005..0.035]
    contents = make_root("tray_cold_contents")
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.010))
    plaque = bpy.context.object
    plaque.scale = (0.240, 0.400, 0.012)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for col in (-0.058, 0.058):
        for row_idx in range(6):
            ry = -0.150 + row_idx * 0.060
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=(col, ry, 0.012))
            well = bpy.context.object
            well.scale = (0.088, 0.044, 0.010)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            subtract_cutter(plaque, well)
    finish_mesh(plaque, "financier_mould_plaque", contents, mats["tinned_mould"], 0.0008, 2)

    for c_idx, col in enumerate((-0.058, 0.058)):
        for row_idx in range(6):
            ry = -0.150 + row_idx * 0.060
            add_box(
                f"financier_ingot_{c_idx}_{row_idx}",
                contents,
                (col, ry, 0.021),
                (0.041, 0.020, 0.012),
                mats["financier_gold"],
                bevel_width=0.0045,
                bevel_segments=3,
            )

    # 200 mm stainless receiving saucepan + handle + 4 carrier-insert blocks
    pan_root = make_root("tray_receiving_pan")
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64, radius=0.100, depth=0.086, location=(0.0, 0.0, 0.047)
    )
    saucepan = bpy.context.object
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64, radius=0.095, depth=0.084, location=(0.0, 0.0, 0.051)
    )
    inner = bpy.context.object
    subtract_cutter(saucepan, inner)
    finish_mesh(
        saucepan,
        "receiving_saucepan_body",
        pan_root,
        mats["stainless_bright"],
        0.0008,
        2,
    )
    # Brushed copper/steel tri-ply base disc
    add_cylinder(
        "receiving_saucepan_base_disc",
        pan_root,
        (0.0, 0.0, 0.0055),
        0.097,
        0.003,
        mats["copper_accent"],
        axis="Z",
        vertices=48,
        bevel_width=0.0006,
    )
    # Stainless tang + insulated phenolic handle along +Y [0.10..0.25] at z=0.070
    add_box(
        "receiving_pan_tang",
        pan_root,
        (0.0, 0.112, 0.070),
        (0.011, 0.016, 0.004),
        mats["stainless_bright"],
        bevel_width=0.001,
    )
    add_cylinder(
        "receiving_pan_grip",
        pan_root,
        (0.0, 0.184, 0.070),
        0.012,
        0.132,
        mats["silicone_pad"],
        axis="Y",
        vertices=28,
        bevel_width=0.0025,
    )
    # 4 CNC carrier-insert blocks at (±0.114, 0, 0.023) and (0, ±0.114, 0.023)
    for idx, (ix, iy) in enumerate(
        ((0.114, 0.0), (-0.114, 0.0), (0.0, 0.114), (0.0, -0.114))
    ):
        add_box(
            f"receiving_pan_insert_block_{idx}",
            pan_root,
            (ix, iy, 0.023),
            (0.013, 0.013, 0.020),
            mats["drive_housing"],
            bevel_width=0.0018,
        )


def build_pedestal(mats: dict[str, bpy.types.Material]) -> None:
    """Matches pedestal_column (0.2x0.2x0.7) + pedestal_plate (0.36x0.36x0.05)."""
    ped = make_root("pedestal")
    # Floor anchor flange inside [±0.175, ±0.175], z in [0.0, 0.022]
    add_box(
        "pedestal_floor_flange",
        ped,
        (0.0, 0.0, 0.011),
        (0.172, 0.172, 0.011),
        mats["dark_steel"],
        bevel_width=0.002,
    )
    for idx, (bx, by) in enumerate(
        ((-0.145, -0.145), (-0.145, 0.145), (0.145, -0.145), (0.145, 0.145))
    ):
        add_cylinder(
            f"pedestal_anchor_bolt_{idx}",
            ped,
            (bx, by, 0.026),
            0.009,
            0.012,
            mats["stainless_bright"],
            axis="Z",
            vertices=16,
            bevel_width=0.001,
        )
    # 4 stiffener ribs
    for idx, (rx, ry, sx, sy) in enumerate(
        (
            (0.125, 0.0, 0.028, 0.008),
            (-0.125, 0.0, 0.028, 0.008),
            (0.0, 0.125, 0.008, 0.028),
            (0.0, -0.125, 0.008, 0.028),
        )
    ):
        add_box(
            f"pedestal_rib_{idx}",
            ped,
            (rx, ry, 0.072),
            (sx, sy, 0.052),
            mats["dark_steel"],
            bevel_width=0.0012,
        )
    # Square structural column: 0.20 x 0.20, z in [0.022, 0.700]
    add_box(
        "pedestal_column_body",
        ped,
        (0.0, 0.0, 0.361),
        (0.100, 0.100, 0.339),
        mats["pedestal_coat"],
        bevel_width=0.003,
    )
    # Brushed inspection cover plate on -X face
    add_box(
        "pedestal_access_cover",
        ped,
        (-0.101, 0.0, 0.380),
        (0.002, 0.062, 0.110),
        mats["machined_aluminium"],
        bevel_width=0.0008,
    )
    # Machined top mounting plate: 0.36 x 0.36 x 0.05, z in [0.700, 0.750]
    add_box(
        "pedestal_top_plate",
        ped,
        (0.0, 0.0, 0.725),
        (0.180, 0.180, 0.025),
        mats["machined_aluminium"],
        bevel_width=0.0025,
    )
    for idx, (bx, by) in enumerate(
        ((-0.145, -0.145), (-0.145, 0.145), (0.145, -0.145), (0.145, 0.145))
    ):
        add_cylinder(
            f"pedestal_top_bolt_{idx}",
            ped,
            (bx, by, 0.748),
            0.007,
            0.004,
            mats["dark_steel"],
            axis="Z",
            vertices=16,
            bevel_width=0.0006,
        )


def build_source_table(mats: dict[str, bpy.types.Material]) -> None:
    """Matches cell_table: 0.64 x 0.52 x 0.80 m stainless prep table."""
    tbl = make_root("source_table")
    # Stainless bullnose worktop: z in [0.76, 0.80], half=[0.32, 0.26, 0.02]
    add_box(
        "source_table_top",
        tbl,
        (0.0, 0.0, 0.780),
        (0.320, 0.260, 0.020),
        mats["stainless_brushed"],
        bevel_width=0.0035,
        bevel_segments=3,
    )
    # Recessed apron frame under tabletop
    add_box(
        "source_table_apron",
        tbl,
        (0.0, 0.0, 0.742),
        (0.292, 0.232, 0.018),
        mats["stainless_dark"],
        bevel_width=0.0015,
    )
    # Lower stainless undershelf at z=0.19
    add_box(
        "source_table_undershelf",
        tbl,
        (0.0, 0.0, 0.190),
        (0.292, 0.232, 0.013),
        mats["stainless_brushed"],
        bevel_width=0.0022,
    )
    # 4 tubular stainless legs at (±0.28, ±0.22), z in [0.0, 0.76]
    for idx, (lx, ly) in enumerate(
        ((-0.28, -0.22), (-0.28, 0.22), (0.28, -0.22), (0.28, 0.22))
    ):
        add_cylinder(
            f"source_table_leg_{idx}",
            tbl,
            (lx, ly, 0.392),
            0.021,
            0.736,
            mats["stainless_bright"],
            axis="Z",
            vertices=28,
            bevel_width=0.001,
        )
        add_cylinder(
            f"source_table_foot_{idx}",
            tbl,
            (lx, ly, 0.012),
            0.024,
            0.024,
            mats["dark_steel"],
            axis="Z",
            vertices=24,
            bevel_width=0.0015,
        )


def build_rack_variant(
    name: str,
    post_top_z: float,
    active_rail_z: float,
    has_upper_frame: bool,
    lower_shelf_zs: tuple[float, ...],
    mats: dict[str, bpy.types.Material],
) -> None:
    """Builds a patisserie rack matching exact MuJoCo post, rail, and clearance bounds."""
    rack = make_root(name)
    base_z = 0.082
    post_bottom = 0.068
    post_half_z = (post_top_z - post_bottom) / 2.0
    post_mid_z = post_bottom + post_half_z

    # 4 corner upright posts at (±0.32, ±0.235) with half=[0.018, 0.018]
    for idx, (px, py) in enumerate(
        ((-0.32, -0.235), (-0.32, 0.235), (0.32, -0.235), (0.32, 0.235))
    ):
        add_box(
            f"{name}_post_{idx}",
            rack,
            (px, py, post_mid_z),
            (0.018, 0.018, post_half_z),
            mats["stainless_brushed"],
            bevel_width=0.002,
        )
        # Swivel caster bracket + dark polyurethane wheel inside z in [0, 0.068] and x in [-0.34, 0.34]
        cx = 0.314 if px > 0 else -0.314
        add_box(
            f"{name}_caster_fork_{idx}",
            rack,
            (cx, py, 0.054),
            (0.020, 0.018, 0.014),
            mats["stainless_dark"],
            bevel_width=0.0012,
        )
        add_cylinder(
            f"{name}_caster_wheel_{idx}",
            rack,
            (cx, py, 0.025),
            0.025,
            0.020,
            mats["silicone_pad"],
            axis="Y",
            vertices=24,
            bevel_width=0.0015,
        )
        add_cylinder(
            f"{name}_caster_hub_{idx}",
            rack,
            (cx, py, 0.025),
            0.011,
            0.022,
            mats["stainless_bright"],
            axis="Y",
            vertices=16,
            bevel_width=0.0008,
        )

    # Base perimeter frame at z = base_z
    for side, sy in (("left", 0.235), ("right", -0.235)):
        add_box(
            f"{name}_base_side_{side}",
            rack,
            (0.0, sy, base_z),
            (0.336, 0.018, 0.014),
            mats["stainless_brushed"],
            bevel_width=0.0015,
        )
    for end, ex in (("front", -0.32), ("rear", 0.32)):
        add_box(
            f"{name}_base_cross_{end}",
            rack,
            (ex, 0.0, base_z),
            (0.016, 0.218, 0.014),
            mats["stainless_brushed"],
            bevel_width=0.0015,
        )

    # Active MuJoCo L-channel tray rails at y = ±0.19, z = active_rail_z (half=[0.32, 0.02, 0.01])
    for side, sy, wall_y in (("left", 0.19, 0.207), ("right", -0.19, -0.207)):
        add_box(
            f"{name}_active_rail_ledge_{side}",
            rack,
            (0.0, sy, active_rail_z - 0.005),
            (0.320, 0.020, 0.004),
            mats["stainless_bright"],
            bevel_width=0.001,
        )
        add_box(
            f"{name}_active_rail_flange_{side}",
            rack,
            (0.0, wall_y, active_rail_z + 0.002),
            (0.320, 0.003, 0.008),
            mats["stainless_bright"],
            bevel_width=0.0006,
        )
        # Stand-off tabs connecting the y=±0.19 rail out to the y=±0.235 upright posts
        tab_y = (sy + (0.235 if sy > 0 else -0.235)) / 2.0
        for end, tx in (("f", -0.305), ("r", 0.305)):
            add_box(
                f"{name}_active_rail_tab_{side}_{end}",
                rack,
                (tx, tab_y, active_rail_z - 0.004),
                (0.015, 0.022, 0.006),
                mats["stainless_dark"],
                bevel_width=0.0008,
            )

    # Lower decorative multi-tier tray runners below the active shelf
    for tier_idx, sz in enumerate(lower_shelf_zs):
        for side, sy, wall_y in (("l", 0.198, 0.215), ("r", -0.198, -0.215)):
            add_box(
                f"{name}_tier_{tier_idx}_{side}",
                rack,
                (0.0, sy, sz),
                (0.318, 0.018, 0.003),
                mats["stainless_brushed"],
                bevel_width=0.0006,
            )
            add_box(
                f"{name}_tier_up_{tier_idx}_{side}",
                rack,
                (0.0, wall_y, sz + 0.006),
                (0.318, 0.003, 0.007),
                mats["stainless_brushed"],
                bevel_width=0.0005,
            )

    if has_upper_frame:
        # Upper side bars at y = ±0.235, z = 1.04 (half=[0.34, 0.02, 0.02]) + rear cross tie + back stop
        for side, sy in (("left", 0.235), ("right", -0.235)):
            add_box(
                f"{name}_upper_{side}",
                rack,
                (0.0, sy, 1.040),
                (0.338, 0.018, 0.018),
                mats["stainless_brushed"],
                bevel_width=0.002,
            )
        add_box(
            f"{name}_upper_rear_tie",
            rack,
            (0.320, 0.0, 1.040),
            (0.018, 0.218, 0.018),
            mats["stainless_brushed"],
            bevel_width=0.002,
        )
        # rack_back_stop at [0.329, 0, 0.83], half=[0.009, 0.21, 0.03]
        add_box(
            f"{name}_back_stop",
            rack,
            (0.329, 0.0, 0.830),
            (0.008, 0.215, 0.028),
            mats["stainless_bright"],
            bevel_width=0.0015,
        )


def build_oven_stand(mats: dict[str, bpy.types.Material]) -> None:
    """Matches oven_stand: 0.80 x 0.90 x 0.444 m commercial Maruzen stand."""
    stand = make_root("oven_stand")
    # Heavy stainless top deck: z in [0.408, 0.444], half=[0.40, 0.45, 0.018]
    add_box(
        "oven_stand_top",
        stand,
        (0.0, 0.0, 0.426),
        (0.400, 0.450, 0.018),
        mats["stainless_brushed"],
        bevel_width=0.003,
        bevel_segments=3,
    )
    # Lower storage undershelf at z = 0.115
    add_box(
        "oven_stand_undershelf",
        stand,
        (0.0, 0.0, 0.115),
        (0.368, 0.418, 0.014),
        mats["stainless_brushed"],
        bevel_width=0.0022,
    )
    # Under-oven sheet pan runner pair at z = 0.275
    for side, sy in (("left", 0.205), ("right", -0.205)):
        add_box(
            f"oven_stand_pan_slide_{side}",
            stand,
            (0.0, sy, 0.275),
            (0.355, 0.018, 0.005),
            mats["stainless_bright"],
            bevel_width=0.0008,
        )
    # 4 square stainless legs at (±0.362, ±0.412), z in [0.020, 0.408]
    for idx, (lx, ly) in enumerate(
        ((-0.362, -0.412), (-0.362, 0.412), (0.362, -0.412), (0.362, 0.412))
    ):
        add_box(
            f"oven_stand_leg_{idx}",
            stand,
            (lx, ly, 0.214),
            (0.024, 0.024, 0.194),
            mats["stainless_bright"],
            bevel_width=0.002,
        )
        add_cylinder(
            f"oven_stand_foot_{idx}",
            stand,
            (lx, ly, 0.010),
            0.025,
            0.020,
            mats["dark_steel"],
            axis="Z",
            vertices=24,
            bevel_width=0.0015,
        )


def build_obstruction_tote(
    name: str,
    half_size: tuple[float, float, float],
    mats: dict[str, bpy.types.Material],
) -> None:
    """Builds a recessed terracotta kitchen tote / forgotten pan inside exact MuJoCo half_size."""
    root = make_root(name)
    hx, hy, hz = half_size
    wall = 0.010
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    tote = bpy.context.object
    tote.scale = (hx * 2.0 - 0.006, hy * 2.0 - 0.006, hz * 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, wall * 0.6))
    cavity = bpy.context.object
    cavity.scale = (
        hx * 2.0 - wall * 2.6,
        hy * 2.0 - wall * 2.6,
        hz * 2.0 - wall * 1.2,
    )
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    subtract_cutter(tote, cavity)
    finish_mesh(tote, f"{name}_body", root, mats["hazard_terracotta"], 0.0025, 2)

    # Top rim flange at exact outer half_size X/Y
    bpy.ops.mesh.primitive_cube_add(
        size=1.0, location=(0.0, 0.0, hz - min(0.008, hz * 0.22))
    )
    rim = bpy.context.object
    rim_h = min(0.016, hz * 0.44)
    rim.scale = (hx * 2.0, hy * 2.0, rim_h)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.mesh.primitive_cube_add(
        size=1.0, location=(0.0, 0.0, hz - min(0.008, hz * 0.22))
    )
    rim_cut = bpy.context.object
    rim_cut.scale = (hx * 2.0 - 0.024, hy * 2.0 - 0.024, rim_h + 0.006)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    subtract_cutter(rim, rim_cut)
    finish_mesh(rim, f"{name}_rim", root, mats["hazard_terracotta"], 0.0018, 2)


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {
        "stainless_brushed": make_material(
            "Brushed Stainless", (0.69, 0.72, 0.74), 0.86, 0.31
        ),
        "stainless_bright": make_material(
            "Bright Stainless", (0.76, 0.79, 0.81), 0.92, 0.22
        ),
        "stainless_dark": make_material(
            "Structural Stainless", (0.48, 0.52, 0.55), 0.82, 0.38
        ),
        "machined_aluminium": make_material(
            "Machined Aluminium", (0.60, 0.64, 0.68), 0.82, 0.27
        ),
        "tray_aluminium": make_material(
            "Baking Sheet Aluminium", (0.66, 0.69, 0.71), 0.78, 0.33
        ),
        "anodized_teal": make_material(
            "Anodized Teal Housing", (0.12, 0.34, 0.37), 0.68, 0.30
        ),
        "drive_housing": make_material(
            "Actuator Polymer", (0.17, 0.20, 0.24), 0.38, 0.40
        ),
        "pedestal_coat": make_material(
            "Powdercoat Charcoal", (0.18, 0.21, 0.23), 0.28, 0.48
        ),
        "dark_steel": make_material(
            "Black Oxide Steel", (0.11, 0.13, 0.14), 0.72, 0.36
        ),
        "silicone_pad": make_material(
            "Food Silicone Dark", (0.09, 0.10, 0.11), 0.02, 0.72
        ),
        "silpat_cream": make_material(
            "Silpat Baking Liner", (0.85, 0.80, 0.70), 0.0, 0.62
        ),
        "tinned_mould": make_material(
            "Matsunaga Tinned Mould", (0.28, 0.30, 0.32), 0.84, 0.34
        ),
        "financier_gold": make_material(
            "Baked Financier Gold", (0.76, 0.48, 0.18), 0.0, 0.56
        ),
        "copper_accent": make_material(
            "Tri-Ply Copper Ring", (0.78, 0.44, 0.28), 0.88, 0.26
        ),
        "hazard_terracotta": make_material(
            "Obstruction Tote Terracotta", (0.74, 0.22, 0.14), 0.08, 0.44
        ),
    }

    build_standard_tooling(mats)
    build_trays(mats)
    build_pedestal(mats)
    build_source_table(mats)
    build_rack_variant(
        "rack_full",
        post_top_z=1.06,
        active_rail_z=0.79,
        has_upper_frame=True,
        lower_shelf_zs=(0.23, 0.37, 0.51, 0.65),
        mats=mats,
    )
    build_rack_variant(
        "rack_combined",
        post_top_z=0.78,
        active_rail_z=0.79,
        has_upper_frame=False,
        lower_shelf_zs=(0.25, 0.43, 0.61),
        mats=mats,
    )
    build_rack_variant(
        "rack_ur5e",
        post_top_z=0.58,
        active_rail_z=0.59,
        has_upper_frame=False,
        lower_shelf_zs=(0.23, 0.41),
        mats=mats,
    )
    build_oven_stand(mats)
    build_obstruction_tote("obstruction_rack_tall", (0.26, 0.17, 0.10), mats)
    build_obstruction_tote("obstruction_rack_low", (0.26, 0.17, 0.04), mats)
    build_obstruction_tote("obstruction_oven_pan", (0.19, 0.29, 0.035), mats)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
    )
    print(f"Exported {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
