"""Build Blender .blend, exported .glb and Cycles preview renders for the candidate shop floor plans."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "assets" / "bakery-rooms"
MODELS_DIR = REPO_ROOT / "output" / "bakery-assets" / "models"
MUJOCO_DIR = REPO_ROOT / "assets" / "bakery-mujoco"

# Per-room gallery interior presets matching docs & Portal studio renders
PLAN_PRESET_MAP = {
    "asakusabashi-t101940": "kuramae-artisan",
    "kinshicho-61146": "noix-parisien",
    "machiya-sun-reve": "kuramae-artisan",
    "hongo-8257562": "kiyosumi-minimal",
}

WALL_PALETTES = {
    "limewash-hinoki": {
        "exterior": 0xF2ECDD,
        "interior": 0xE9E1CF,
        "wainscot": 0xCBA776,
        "plinth": 0x3B3834,
        "column": 0x9B9689,
        "cap": 0xB89362,
        "roughness": 0.76,
    },
    "parisian-boiserie": {
        "exterior": 0xF7F3E9,
        "interior": 0xEFE9DC,
        "wainscot": 0xE5DECB,
        "plinth": 0x2F3330,
        "column": 0xDCD5C5,
        "cap": 0xB08D4F,
        "roughness": 0.68,
    },
    "board-concrete": {
        "exterior": 0xD5D7D2,
        "interior": 0xC8CBC4,
        "wainscot": 0xB89668,
        "plinth": 0x282B29,
        "column": 0x7E837C,
        "cap": 0x424744,
        "roughness": 0.82,
    },
    "juraku-lattice": {
        "exterior": 0xE3D7C3,
        "interior": 0xD8CAB2,
        "wainscot": 0x7A573D,
        "plinth": 0x2C241E,
        "column": 0x614733,
        "cap": 0x5C422E,
        "roughness": 0.80,
    },
}

FIXTURE_PALETTES = {
    "blackened-steel": {
        "frame": 0x2A2F2D,
        "frame_metal": 0.68,
        "frame_rough": 0.36,
        "brass": 0xC59B52,
        "door": 0x9C7A52,
    },
    "aged-brass": {
        "frame": 0x9E7B42,
        "frame_metal": 0.78,
        "frame_rough": 0.32,
        "brass": 0xD4AD63,
        "door": 0x7C5C3C,
    },
    "natural-oak": {
        "frame": 0xA88254,
        "frame_metal": 0.15,
        "frame_rough": 0.58,
        "brass": 0xC8CFD1,
        "door": 0xB89264,
    },
}

STATION_MODELS = {
    "station-scale": "scale",
    "station-mixer": "mixer",
    "station-sesame-prep": "sesame",
    "station-hob": "hob",
    "station-oven": "oven",
    "station-chiller": "chiller",
    "station-wash": "wash",
    "station-beverage-bar": "beverage",
    "pour-over-cell": "pourover",
}


# Geometry, placements and interior presets come directly from the Portal's TypeScript modules.
def load_floor_plans() -> tuple[list[dict], dict, dict]:
    source = """
import { BAKERY_FLOOR_PLANS, BAKERY_FLOOR_PLAN_ORDER } from './packages/production-simulation/src/floor/bakery-room.ts';
import { DEFAULT_ROOM_APPLIANCE_LAYOUTS } from './packages/production-simulation/src/floor/appliance-catalogue.ts';
import { splitWallByWindows } from './packages/production-simulation/src/floor/architecture.ts';
import { STORE_INTERIOR_PRESETS } from './apps/portal/src/features/workflow-simulator/store-interior-design.ts';
const plans = [];
for (const id of BAKERY_FLOOR_PLAN_ORDER) {
  if (id === 'reference') continue;
  const spec = BAKERY_FLOOR_PLANS[id];
  const wallSegments = [];
  for (const wall of spec.walls) {
    const subs = splitWallByWindows(wall, spec.windows);
    subs.forEach((segment, subIdx) => {
      wallSegments.push({
        id: `${wall.id}:${subIdx}`,
        wallId: wall.id,
        kind: segment.kind,
        x0: segment.x0,
        z0: segment.z0,
        x1: segment.x1,
        z1: segment.z1,
        thickness: wall.thickness,
        exterior: wall.exterior,
        rawWallHeight: wall.height,
        sillHeight: segment.kind === 'sill' ? segment.sillHeight : null,
        segHeight: segment.kind === 'sill' ? segment.sillHeight : segment.height,
      });
    });
  }
  plans.push({ ...spec, wallSegments });
}
process.stdout.write(JSON.stringify({
  plans,
  placements: DEFAULT_ROOM_APPLIANCE_LAYOUTS,
  presets: STORE_INTERIOR_PRESETS,
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    return data["plans"], data["placements"], data["presets"]


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(hex_val: int, alpha: float = 1.0) -> tuple[float, float, float, float]:
    sr = ((hex_val >> 16) & 0xFF) / 255.0
    sg = ((hex_val >> 8) & 0xFF) / 255.0
    sb = (hex_val & 0xFF) / 255.0
    return (srgb_to_linear(sr), srgb_to_linear(sg), srgb_to_linear(sb), alpha)


def hex_srgb_vec(hex_val: int) -> np.ndarray:
    return np.array(
        [
            ((hex_val >> 16) & 0xFF) / 255.0,
            ((hex_val >> 8) & 0xFF) / 255.0,
            (hex_val & 0xFF) / 255.0,
            1.0,
        ],
        dtype=np.float32,
    )


def create_packed_image(name: str, pixels_rgba: np.ndarray) -> bpy.types.Image:
    h, w, _ = pixels_rgba.shape
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(pixels_rgba.ravel())
    img.pack()
    return img


def make_floor_texture(floor_id: str) -> bpy.types.Image:
    size = 512
    yy, xx = np.mgrid[0:size, 0:size]
    img = np.zeros((size, size, 4), dtype=np.float32)

    if floor_id == "herringbone-oak":
        img[:, :] = hex_srgb_vec(0xC9A474)
        mod = size // 4
        stave = mod // 3
        mr = yy // mod
        mc = xx // mod
        horiz = ((mr + mc) % 2) == 0
        sub_r = (yy % mod) // stave
        sub_c = (xx % mod) // stave
        idx = np.where(horiz, mr * 7 + mc * 3 + sub_r, mr * 5 + mc * 11 + sub_c) % 4
        tones = [
            hex_srgb_vec(0xCFA978),
            hex_srgb_vec(0xC29B6A),
            hex_srgb_vec(0xD6B384),
            hex_srgb_vec(0xBA9260),
        ]
        for k, col in enumerate(tones):
            img[idx == k] = col
        grain = 0.024 * np.sin(np.where(horiz, xx * 0.18, yy * 0.18) + idx * 1.7)
        img[:, :, :3] = np.clip(img[:, :, :3] + grain[..., None], 0.0, 1.0)
        edge_h = horiz & (((yy % stave) < 3) | ((xx % mod) < 3))
        edge_v = (~horiz) & (((xx % stave) < 3) | ((yy % mod) < 3))
        img[edge_h | edge_v] = hex_srgb_vec(0x6E4B28)
    elif floor_id == "limestone-checker":
        img[:, :] = hex_srgb_vec(0xEAE4D5)
        tile = size // 2
        tx = xx % tile
        ty = yy % tile
        grout = (tx < 3) | (ty < 3)
        img[grout] = hex_srgb_vec(0xB8B0A0)
        dx = np.minimum(tx, tile - tx)
        dy = np.minimum(ty, tile - ty)
        cabochon = (dx + dy) < 38
        img[cabochon] = hex_srgb_vec(0x353836)
    elif floor_id == "terrazzo-stone":
        img[:, :] = hex_srgb_vec(0xE3DDD1)
        rng = np.random.default_rng(4201)
        chip_cols = [
            hex_srgb_vec(0x9E9587),
            hex_srgb_vec(0x6F6A63),
            hex_srgb_vec(0xC48768),
            hex_srgb_vec(0xF5F1E9),
            hex_srgb_vec(0x838F82),
            hex_srgb_vec(0xB89F78),
            hex_srgb_vec(0x54504A),
        ]
        for i in range(620):
            cx = int(rng.integers(5, size - 5))
            cy = int(rng.integers(5, size - 5))
            rx = int(rng.integers(2, 7))
            ry = int(rng.integers(2, 6))
            mask = ((xx - cx) ** 2) / max(1, rx * rx) + ((yy - cy) ** 2) / max(1, ry * ry) <= 1.0
            img[mask] = chip_cols[i % len(chip_cols)]
        divider = ((xx % (size // 2)) < 2) | ((yy % (size // 2)) < 2)
        img[divider] = hex_srgb_vec(0xB8A684)
    else:
        img[:, :] = hex_srgb_vec(0xC4B9A5)

    return create_packed_image(f"tex_floor_{floor_id}", img)


def make_zone_tile_texture(zone_kind: str) -> bpy.types.Image:
    size = 256
    yy, xx = np.mgrid[0:size, 0:size]
    base_map = {
        "wet": (0xC9D5D8, 0x8F9DA1, 64),
        "toilet": (0xDDD7CB, 0xACA496, 64),
        "corridor": (0xC7CBC2, 0x969B91, 128),
        "closet": (0xCBBFA9, 0x9C8F79, 128),
    }
    base_hex, grout_hex, step = base_map.get(zone_kind, (0xCCCCCC, 0x999999, 64))
    img = np.broadcast_to(hex_srgb_vec(base_hex), (size, size, 4)).copy()
    grout = ((xx % step) < 3) | ((yy % step) < 3)
    img[grout] = hex_srgb_vec(grout_hex)
    return create_packed_image(f"tex_zone_{zone_kind}", img)


def make_sidewalk_texture() -> bpy.types.Image:
    size = 512
    yy, xx = np.mgrid[0:size, 0:size]
    img = np.broadcast_to(hex_srgb_vec(0xCEC9BF), (size, size, 4)).copy()
    row_h = size // 4
    col_w = size // 2
    row = yy // row_h
    stagger_x = (xx + (row % 2) * (col_w // 2)) % size
    joint = ((yy % row_h) < 5) | ((stagger_x % col_w) < 5)
    img[joint] = hex_srgb_vec(0x8D8980)
    rng = np.random.default_rng(771)
    speck = rng.uniform(-0.025, 0.025, size=(size, size, 1)).astype(np.float32)
    img[:, :, :3] = np.clip(img[:, :, :3] + speck, 0.0, 1.0)
    return create_packed_image("tex_sidewalk_granite", img)


def make_wainscot_texture(wall_material: str, base_hex: int) -> bpy.types.Image:
    size = 256
    yy, xx = np.mgrid[0:size, 0:size]
    img = np.broadcast_to(hex_srgb_vec(base_hex), (size, size, 4)).copy()
    if wall_material == "parisian-boiserie":
        border = (xx < 10) | (xx > size - 11) | (yy < 14) | (yy > size - 15)
        mould = (
            ((xx >= 28) & (xx <= 33) & (yy >= 28) & (yy <= size - 29))
            | ((xx >= size - 34) & (xx <= size - 29) & (yy >= 28) & (yy <= size - 29))
            | ((yy >= 28) & (yy <= 33) & (xx >= 28) & (xx <= size - 29))
            | ((yy >= size - 34) & (yy <= size - 29) & (xx >= 28) & (xx <= size - 29))
        )
        img[border, :3] = np.clip(img[border, :3] * 0.94, 0.0, 1.0)
        img[mould, :3] = np.clip(img[mould, :3] * 0.85, 0.0, 1.0)
    else:
        slat_w = 16
        groove = (xx % slat_w) < 4
        img[groove, :3] = img[groove, :3] * 0.72
    return create_packed_image(f"tex_wainscot_{wall_material}", img)


def make_material(
    name: str,
    rgba: tuple[float, float, float, float],
    roughness: float = 0.7,
    metallic: float = 0.0,
    coat: float = 0.0,
    coat_roughness: float = 0.2,
    alpha: float = 1.0,
    emission_rgba: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
    image: bpy.types.Image | None = None,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_roughness
    if alpha < 1.0:
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = alpha
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
    if emission_rgba is not None and emission_strength > 0.0:
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = emission_rgba
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    if image is not None:
        tex_node = nodes.new("ShaderNodeTexImage")
        tex_node.image = image
        links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def project_box_uvs(
    obj: bpy.types.Object,
    size_three: tuple[float, float, float],
    repeat_uv: tuple[float, float] | None = None,
    world_pos_three: tuple[float, float, float] | None = None,
    world_uv_per_m: float | None = None,
) -> None:
    mesh = obj.data
    if mesh is None or not mesh.uv_layers:
        return
    uv_layer = mesh.uv_layers.active.data
    sx = max(0.01, size_three[0])
    sy = max(0.01, size_three[1])
    sz = max(0.01, size_three[2])
    ru = max(0.25, repeat_uv[0]) if repeat_uv is not None else 1.0
    rv = max(0.25, repeat_uv[1]) if repeat_uv is not None else 1.0

    for poly in mesh.polygons:
        nx, ny, nz = poly.normal.x, poly.normal.y, poly.normal.z
        for loop_idx in poly.loop_indices:
            vert = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            if abs(nz) > 0.7:
                if world_uv_per_m is not None and world_pos_three is not None:
                    uv_layer[loop_idx].uv = (
                        (world_pos_three[0] + vert.x) * world_uv_per_m,
                        (world_pos_three[2] - vert.y) * world_uv_per_m,
                    )
                else:
                    uv_layer[loop_idx].uv = ((vert.x / sx + 0.5) * ru, (vert.y / sz + 0.5) * rv)
            elif abs(ny) >= abs(nx):
                uv_layer[loop_idx].uv = ((vert.x / sx + 0.5) * ru, (vert.z / sy + 0.5) * rv)
            else:
                side_ru = max(0.25, ru * (sz / sx))
                uv_layer[loop_idx].uv = ((vert.y / sz + 0.5) * side_ru, (vert.z / sy + 0.5) * rv)


def create_empty(name: str, tx: float, ty: float, tz: float, rot_y: float = 0.0, parent=None) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(tx, -tz, ty), rotation=(0.0, 0.0, rot_y))
    obj = bpy.context.active_object
    obj.name = name
    if parent is not None:
        obj.parent = parent
    return obj


def attach_local(
    obj: bpy.types.Object,
    parent: bpy.types.Object | None,
    lx: float,
    ly: float,
    lz: float,
    rot_euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (lx, -lz, ly)
    obj.rotation_euler = Euler(rot_euler, "XYZ")
    return obj


def add_three_box(
    name: str,
    size_three: tuple[float, float, float],
    pos_three: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    rot_y: float = 0.0,
    rot_x: float = 0.0,
    rot_z_three: float = 0.0,
    uv_repeat: tuple[float, float] | None = None,
    world_uv_per_m: float | None = None,
) -> bpy.types.Object:
    sx, sy, sz = size_three
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.scale = (max(0.001, sx), max(0.001, sz), max(0.001, sy))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if uv_repeat is not None or world_uv_per_m is not None:
        project_box_uvs(obj, size_three, repeat_uv=uv_repeat, world_pos_three=pos_three, world_uv_per_m=world_uv_per_m)
    obj.data.materials.append(mat)
    attach_local(obj, parent, pos_three[0], pos_three[1], pos_three[2], (rot_x, -rot_z_three, rot_y))
    return obj


def add_three_cylinder(
    name: str,
    r_top: float,
    r_bot: float,
    height: float,
    pos_three: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    vertices: int = 18,
    scale_three: tuple[float, float, float] = (1.0, 1.0, 1.0),
    axis: str = "Y",
    rot_z_three: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=max(0.001, r_bot),
        radius2=max(0.0005, r_top),
        depth=max(0.001, height),
        location=(0.0, 0.0, 0.0),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.scale = (scale_three[0], scale_three[2], scale_three[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    rot_euler = (0.0, -rot_z_three, 0.0)
    if axis == "X":
        rot_euler = (0.0, math.pi * 0.5, 0.0)
    elif axis == "DOWN":
        rot_euler = (math.pi, 0.0, 0.0)
    attach_local(obj, parent, pos_three[0], pos_three[1], pos_three[2], rot_euler)
    return obj


def add_three_sphere(
    name: str,
    radius: float,
    pos_three: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    scale_three: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=20,
        ring_count=14,
        radius=radius,
        location=(0.0, 0.0, 0.0),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.scale = (scale_three[0], scale_three[2], scale_three[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    attach_local(obj, parent, pos_three[0], pos_three[1], pos_three[2])
    return obj


def add_three_torus(
    name: str,
    major_r: float,
    minor_r: float,
    pos_three: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    plane: str = "XZ",
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_r,
        minor_radius=minor_r,
        major_segments=24,
        minor_segments=10,
        location=(0.0, 0.0, 0.0),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.data.materials.append(mat)
    rot_euler = (0.0, 0.0, 0.0) if plane == "XZ" else (0.0, math.pi * 0.5, 0.0)
    attach_local(obj, parent, pos_three[0], pos_three[1], pos_three[2], rot_euler)
    return obj


def import_glb_at(
    filepath: Path,
    parent_empty: bpy.types.Object,
    local_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rot_z: float = 0.0,
    scale_xyz: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> None:
    if not filepath.exists():
        return
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(filepath))
    imported = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in imported if o.parent is None]
    for r in roots:
        r.parent = parent_empty
        r.location = (
            r.location.x * scale_xyz[0] + local_xyz[0],
            r.location.y * scale_xyz[1] + local_xyz[1],
            r.location.z * scale_xyz[2] + local_xyz[2],
        )
        r.rotation_euler = Euler((r.rotation_euler.x, r.rotation_euler.y, r.rotation_euler.z + rot_z), "XYZ")
        r.scale = (r.scale.x * scale_xyz[0], r.scale.y * scale_xyz[1], r.scale.z * scale_xyz[2])


def add_station_assembly(sid: str, skind: str, x: float, z: float, rot_y: float, mats: dict) -> None:
    station_root = create_empty(f"station_{sid}", x, 0.0, z, rot_y)

    counter_z = 0.902
    table_steel = MODELS_DIR / "prep-table-steel.glb"
    table_maple = MODELS_DIR / "prep-table-maple.glb"
    rack_glb = MODELS_DIR / "cooling-rack-16.glb"
    sink_glb = MODELS_DIR / "wash-sink.glb"

    if skind == "scale":
        import_glb_at(table_maple, station_root)
        import_glb_at(MUJOCO_DIR / "ohaus-ranger-3000" / "ohaus-r31pe6.glb", station_root, (-0.36, 0.05, counter_z))
    elif skind == "mixer":
        import_glb_at(table_steel, station_root)
        import_glb_at(MUJOCO_DIR / "aicohsha-kpl9000s" / "aicohsha-kpl9000s.glb", station_root, (0.0, -0.02, counter_z))
    elif skind == "sesame":
        import_glb_at(table_maple, station_root)
        import_glb_at(MUJOCO_DIR / "waring-wsg60" / "waring-wsg60.glb", station_root, (-0.42, 0.06, counter_z))
        import_glb_at(MUJOCO_DIR / "vitamix-quiet-one" / "vitamix-quiet-one.glb", station_root, (0.04, 0.04, counter_z))
    elif skind == "hob":
        import_glb_at(table_steel, station_root)
        import_glb_at(
            MUJOCO_DIR / "maruzen-mih-02c" / "maruzen-mih-02c.glb",
            station_root,
            (-0.36, -0.06, counter_z),
            scale_xyz=(0.82, 0.82, 0.82),
        )
        import_glb_at(MUJOCO_DIR / "vollrath-59500p" / "vollrath-59500p.glb", station_root, (0.02, -0.02, counter_z))
        import_glb_at(MUJOCO_DIR / "rinnai-rsb-150pj" / "rinnai-rsb-150pj.glb", station_root, (0.38, -0.04, counter_z))
    elif skind == "oven":
        import_glb_at(table_steel, station_root, scale_xyz=(1.0, 1.25, 1.0))
        import_glb_at(MUJOCO_DIR / "maruzen-mbco-4me" / "maruzen-mbco-4me.glb", station_root, (0.0, 0.0, counter_z))
    elif skind == "chiller":
        import_glb_at(MUJOCO_DIR / "hitachi-r-hws47xl" / "hitachi-r-hws47xl.glb", station_root, (-0.38, 0.0, 0.0))
        import_glb_at(rack_glb, station_root, (0.38, 0.0, 0.0))
    elif skind == "wash":
        import_glb_at(MUJOCO_DIR / "winterhalter-uc-l" / "winterhalter-uc-l.glb", station_root, (-0.62, 0.0, 0.0))
        import_glb_at(MUJOCO_DIR / "maruzen-bs2-126n" / "maruzen-bs2-126n.glb", station_root, (0.26, 0.0, 0.0))
        import_glb_at(MUJOCO_DIR / "sugico-to-600n" / "sugico-to-600n.glb", station_root, (0.26, 0.22, 0.80))
        import_glb_at(MUJOCO_DIR / "maruzen-bps30-12b" / "maruzen-bps30-12b.glb", station_root, (0.26, 0.15, 1.42))
        import_glb_at(MUJOCO_DIR / "maruzen-hmhs-054" / "maruzen-hmhs-054.glb", station_root, (1.12, 0.06, 0.45))
    elif skind == "beverage":
        import_glb_at(table_maple, station_root)
        import_glb_at(MUJOCO_DIR / "wpm-kd-330x" / "wpm-kd-330x.glb", station_root, (-0.34, -0.02, counter_z))
        import_glb_at(MUJOCO_DIR / "wpm-zd-17od" / "wpm-zd-17od.glb", station_root, (-0.04, -0.04, counter_z))
        import_glb_at(MUJOCO_DIR / "option-o-lagom-casa" / "option-o-lagom-casa.glb", station_root, (0.18, -0.04, counter_z))
        import_glb_at(MUJOCO_DIR / "severin-sm-3587" / "severin-sm-3587.glb", station_root, (0.42, -0.06, counter_z))
        import_glb_at(MUJOCO_DIR / "hoshizaki-im-25p" / "hoshizaki-im-25p.glb", station_root, (0.94, -0.02, 0.0))
        add_three_box(f"{sid}_cobot_base", (0.14, 0.44, 0.14), (-0.26, counter_z + 0.22, 0.0), mats["frame"], parent=station_root)
        add_three_box(f"{sid}_cobot_arm", (0.32, 0.07, 0.07), (-0.16, counter_z + 0.42, 0.0), mats["steel"], parent=station_root)
    elif skind == "pourover":
        import_glb_at(table_maple, station_root, scale_xyz=(0.76, 0.88, 1.0))
        add_three_box(f"{sid}_cobot_base", (0.14, 0.44, 0.14), (-0.22, counter_z + 0.22, 0.0), mats["frame"], parent=station_root)
        add_three_box(f"{sid}_cobot_arm", (0.36, 0.07, 0.07), (0.0, counter_z + 0.42, 0.0), mats["steel"], parent=station_root)


def build_window_opening(win: dict, mats: dict) -> None:
    win_id = win["id"]
    x0, z0, x1, z1 = win["x0"], win["z0"], win["x1"], win["z1"]
    sill = win["sillHeight"]
    head = win["headHeight"]
    panels = max(1, win["panels"])
    dx = x1 - x0
    dz = z1 - z0
    span = math.hypot(dx, dz)
    if span < 1e-3:
        return
    gh = max(0.28, head - sill)
    rot_y = -math.atan2(dz, dx)
    group = create_empty(f"window_{win_id}", (x0 + x1) * 0.5, sill + gh * 0.5, (z0 + z1) * 0.5, rot_y)

    has_transom = gh > 0.95
    transom_y = gh * 0.24 if has_transom else gh * 0.5
    lower_top_y = transom_y - 0.012 if has_transom else gh * 0.5 - 0.016
    lower_bot_y = -gh * 0.5 + 0.016
    sash_h = max(0.18, lower_top_y - lower_bot_y)
    sash_cy = (lower_top_y + lower_bot_y) * 0.5

    for idx, y_off in enumerate((-gh * 0.5, gh * 0.5)):
        add_three_box(f"window_{win_id}_rail_{idx}", (span + 0.03, 0.032, 0.056), (0.0, y_off, 0.0), mats["frame"], parent=group)
    for idx, x_off in enumerate((-span * 0.5, span * 0.5)):
        add_three_box(f"window_{win_id}_jamb_{idx}", (0.032, gh + 0.032, 0.056), (x_off, 0.0, 0.0), mats["frame"], parent=group)

    if has_transom:
        add_three_box(f"window_{win_id}_transom", (span + 0.02, 0.024, 0.05), (0.0, transom_y, 0.0), mats["frame"], parent=group)
        tg_h = max(0.12, gh * 0.5 - transom_y - 0.02)
        add_three_box(
            f"window_{win_id}_transom_glass",
            (span - 0.02, tg_h, 0.014),
            (0.0, transom_y + 0.012 + tg_h * 0.5, 0.0),
            mats["glass"],
            parent=group,
        )

    bay_w = span / panels
    for i in range(panels):
        hinge_left = (i % 2) == 0
        hinge_offset = i * bay_w + 0.014 if hinge_left else (i + 1) * bay_w - 0.014
        sash_w = max(0.14, bay_w - 0.024)
        cx = (hinge_offset - span * 0.5) + (sash_w * 0.5 if hinge_left else -sash_w * 0.5)
        add_three_box(f"window_{win_id}_pane_{i}", (sash_w - 0.036, sash_h - 0.036, 0.014), (cx, sash_cy, 0.0), mats["glass"], parent=group)
        for r_idx, sy in enumerate((-sash_h * 0.5 + 0.012, sash_h * 0.5 - 0.012)):
            add_three_box(f"window_{win_id}_srail_{i}_{r_idx}", (sash_w, 0.024, 0.036), (cx, sash_cy + sy, 0.0), mats["frame"], parent=group)
        for s_idx, sx in enumerate((cx - sash_w * 0.5 + 0.012, cx + sash_w * 0.5 - 0.012)):
            add_three_box(f"window_{win_id}_sstile_{i}_{s_idx}", (0.024, sash_h, 0.036), (sx, sash_cy, 0.0), mats["frame"], parent=group)
        latch_x = cx + sash_w * 0.5 - 0.028 if hinge_left else cx - sash_w * 0.5 + 0.028
        add_three_box(f"window_{win_id}_latch_{i}", (0.012, 0.09, 0.048), (latch_x, sash_cy, 0.0), mats["brass"], parent=group)


def door_closed_angle_three(door: dict) -> float:
    open_ang = math.atan2(door["leafZ"] - door["hingeZ"], door["leafX"] - door["hingeX"])
    return open_ang + door["swingRad"]


def build_door_opening(door: dict, mats: dict) -> None:
    did = door["id"]
    hx, hz = door["hingeX"], door["hingeZ"]
    width = door["width"]
    dh = door["height"]
    closed_three = door_closed_angle_three(door)
    rot_y = -closed_three

    frame_cx = hx + math.cos(closed_three) * width * 0.5
    frame_cz = hz + math.sin(closed_three) * width * 0.5
    frame_group = create_empty(f"door_{did}", frame_cx, dh * 0.5, frame_cz, rot_y)

    for idx, x_sign in enumerate((-1.0, 1.0)):
        add_three_box(f"door_{did}_jamb_{idx}", (0.028, dh + 0.02, 0.072), (x_sign * width * 0.5, 0.0, 0.0), mats["frame"], parent=frame_group)
    add_three_box(f"door_{did}_header", (width + 0.04, 0.032, 0.074), (0.0, dh * 0.5, 0.0), mats["frame"], parent=frame_group)
    add_three_box(f"door_{did}_threshold", (width, 0.008, 0.06), (0.0, -dh * 0.5 + 0.004, 0.0), mats["brass"], parent=frame_group)

    if "toilet" in did:
        add_three_box(f"door_{did}_leaf", (width - 0.012, dh - 0.016, 0.042), (0.0, 0.0, 0.0), mats["door"], parent=frame_group)
        add_three_box(f"door_{did}_lever", (0.09, 0.018, 0.09), (width * 0.36, -0.06, 0.0), mats["brass"], parent=frame_group)
    else:
        stile_w = 0.065
        top_rail_h = 0.065
        bot_rail_h = 0.22
        glass_w = max(0.12, width - stile_w * 2.0)
        glass_h = max(0.2, dh - top_rail_h - bot_rail_h)
        for sign, suffix in ((-1.0, "left"), (1.0, "right")):
            add_three_box(
                f"door_{did}_stile_{suffix}",
                (stile_w, dh - 0.016, 0.044),
                (sign * (width * 0.5 - stile_w * 0.5), 0.0, 0.0),
                mats["frame"],
                parent=frame_group,
            )
        add_three_box(f"door_{did}_rail_top", (glass_w, top_rail_h, 0.044), (0.0, dh * 0.5 - top_rail_h * 0.5, 0.0), mats["frame"], parent=frame_group)
        add_three_box(f"door_{did}_rail_bot", (glass_w, bot_rail_h, 0.044), (0.0, -dh * 0.5 + bot_rail_h * 0.5, 0.0), mats["door"], parent=frame_group)
        add_three_box(
            f"door_{did}_glass",
            (glass_w, glass_h, 0.014),
            (0.0, -dh * 0.5 + bot_rail_h + glass_h * 0.5, 0.0),
            mats["glass"],
            parent=frame_group,
        )
        for z_sign, z_lbl in ((-1.0, "in"), (1.0, "out")):
            add_three_cylinder(
                f"door_{did}_pull_{z_lbl}",
                0.009,
                0.009,
                0.34,
                (width * 0.38, -0.02, z_sign * 0.036),
                mats["brass"],
                parent=frame_group,
                vertices=12,
            )


def build_plumbing_fixture(fix: dict, mats: dict) -> None:
    fid = fix["id"]
    fkind = fix["kind"]
    w = abs(fix["x1"] - fix["x0"])
    d = abs(fix["z1"] - fix["z0"])
    cx = (fix["x0"] + fix["x1"]) * 0.5
    cz = (fix["z0"] + fix["z1"]) * 0.5
    h = fix["height"]

    if fkind == "sink-counter":
        group = create_empty(f"fixture_{fid}", cx, 0.0, cz)
        body_h = max(0.2, h - 0.12)
        add_three_box(f"{fid}_toekick", (w - 0.04, 0.09, d - 0.05), (0.0, 0.045, -0.01), mats["plinth"], parent=group)
        add_three_box(f"{fid}_body", (w, body_h, d - 0.02), (0.0, 0.09 + body_h * 0.5, 0.0), mats["steel"], parent=group)
        add_three_box(f"{fid}_deck", (w + 0.016, 0.036, d + 0.016), (0.0, h - 0.014, 0.0), mats["steel"], parent=group)

        for idx, x_sign in enumerate((-0.24, 0.24)):
            add_three_box(
                f"{fid}_door_{idx}",
                (w * 0.44, body_h - 0.06, 0.012),
                (w * x_sign, 0.09 + body_h * 0.5, d * 0.5 - 0.006),
                mats["steel"],
                parent=group,
            )
            add_three_box(
                f"{fid}_pull_{idx}",
                (0.014, 0.16, 0.022),
                (w * (x_sign * 0.35), 0.09 + body_h * 0.58, d * 0.5 + 0.008),
                mats["brass"],
                parent=group,
            )

        add_three_box(f"{fid}_splash", (w + 0.01, 0.16, 0.028), (0.0, h + 0.08, -d * 0.5 + 0.014), mats["steel"], parent=group)
        add_three_cylinder(
            f"{fid}_utensil_rail",
            0.006,
            0.006,
            w * 0.78,
            (0.0, h + 0.12, -d * 0.5 + 0.042),
            mats["brass"],
            parent=group,
            axis="X",
            vertices=12,
        )

        basin_w = min(w * 0.36, 0.48)
        basin_d = d * 0.64
        for idx, x_sign in enumerate((-0.22, 0.18)):
            add_three_box(f"{fid}_rim_{idx}", (basin_w + 0.03, 0.012, basin_d + 0.03), (w * x_sign, h + 0.006, 0.02), mats["steel"], parent=group)
            add_three_box(f"{fid}_basin_{idx}", (basin_w, 0.016, basin_d), (w * x_sign, h + 0.01, 0.02), mats["basin"], parent=group)
            add_three_cylinder(
                f"{fid}_strainer_{idx}",
                0.028,
                0.028,
                0.018,
                (w * x_sign, h + 0.012, 0.02),
                mats["steel"],
                parent=group,
                vertices=14,
            )

        add_three_cylinder(f"{fid}_faucet_stem", 0.014, 0.018, 0.28, (-w * 0.02, h + 0.14, -d * 0.35), mats["steel"], parent=group)
        add_three_cylinder(f"{fid}_faucet_spring", 0.021, 0.021, 0.13, (-w * 0.02, h + 0.19, -d * 0.35), mats["brass"], parent=group)
        add_three_box(f"{fid}_faucet_arm", (0.022, 0.022, 0.19), (-w * 0.02, h + 0.29, -d * 0.255), mats["steel"], parent=group)
        add_three_cylinder(
            f"{fid}_faucet_nozzle",
            0.004,
            0.022,
            0.055,
            (-w * 0.02, h + 0.25, -d * 0.16),
            mats["brass"],
            parent=group,
            axis="DOWN",
            vertices=14,
        )
        for idx, h_sign in enumerate((-1.0, 1.0)):
            add_three_box(
                f"{fid}_lever_{idx}",
                (0.06, 0.012, 0.016),
                (-w * 0.02 + h_sign * 0.055, h + 0.06, -d * 0.34),
                mats["brass"],
                parent=group,
            )

        drain_w = min(w * 0.62, 0.82)
        add_three_box(f"{fid}_drain", (drain_w, 0.006, 0.16), (0.0, 0.004, d * 0.5 + 0.18), mats["basin"], parent=group)
        add_three_box(
            f"{fid}_wash_water",
            (basin_w * 0.92, 0.006, basin_d * 0.92),
            (-w * 0.22, h + 0.02, 0.02),
            mats["water"],
            parent=group,
        )
        for m in range(3):
            add_three_box(
                f"{fid}_mould_{m}",
                (0.18, 0.007, 0.22),
                (w * 0.34, h + 0.014 + m * 0.012, 0.02),
                mats["basin"],
                parent=group,
                rot_z_three=0.08,
            )

    elif fkind == "toilet":
        facing = fix.get("facing", "south")
        rot_y = (
            math.pi
            if facing == "north"
            else (math.pi * 0.5 if facing == "east" else (-math.pi * 0.5 if facing == "west" else 0.0))
        )
        group = create_empty(f"fixture_{fid}", cx, 0.0, cz, rot_y)
        tank_h = h * 0.82
        add_three_box(f"{fid}_tank", (0.36, tank_h, 0.17), (0.0, tank_h * 0.5, -0.20), mats["ceramic"], parent=group)
        add_three_box(f"{fid}_flush", (0.14, 0.075, 0.012), (0.0, tank_h + 0.12, -0.275), mats["brass"], parent=group)
        add_three_cylinder(
            f"{fid}_bowl",
            0.175,
            0.135,
            0.40,
            (0.0, 0.20, 0.06),
            mats["ceramic"],
            parent=group,
            scale_three=(0.95, 1.0, 1.18),
        )
        add_three_cylinder(
            f"{fid}_lid",
            0.18,
            0.18,
            0.028,
            (0.0, 0.415, 0.06),
            mats["ceramic"],
            parent=group,
            scale_three=(0.95, 1.0, 1.18),
        )
        add_three_cylinder(
            f"{fid}_minisink",
            0.11,
            0.088,
            0.036,
            (0.0, tank_h + 0.016, -0.20),
            mats["ceramic"],
            parent=group,
            scale_three=(1.15, 1.0, 0.68),
        )
        add_three_cylinder(f"{fid}_minifaucet", 0.009, 0.011, 0.085, (0.0, tank_h + 0.058, -0.245), mats["brass"], parent=group, vertices=12)

    elif fkind == "pipe-shaft":
        shaft_h = max(h, 2.25)
        add_three_box(f"fixture_{fid}", (w + 0.004, shaft_h, d + 0.004), (cx, shaft_h * 0.5, cz), mats["column"])
        add_three_box(f"fixture_{fid}_plinth", (w + 0.02, 0.09, d + 0.02), (cx, 0.045, cz), mats["plinth"])
        add_three_box(f"fixture_{fid}_cap", (w + 0.018, 0.024, d + 0.018), (cx, shaft_h + 0.012, cz), mats["cap"])


def build_floor_plan_stair(stair: dict, max_rise: float, mats: dict) -> None:
    sid = stair["id"]
    group = create_empty(f"stair_{sid}", 0.0, 0.0, 0.0)
    total_steps = 10
    total_rise = min(stair["riseHeight"], max_rise)
    step_h = total_rise / total_steps

    lower_count = 4
    lower_span_x = stair["x1"] - stair["turnSplitX"]
    lower_run = lower_span_x / lower_count
    lower_depth_z = stair["z1"] - stair["lowerTopZ"]
    lower_cz = (stair["lowerTopZ"] + stair["z1"]) * 0.5
    for i in range(lower_count):
        h = step_h * (i + 1)
        cx = stair["x1"] - lower_run * (i + 0.5)
        add_three_box(
            f"{sid}_lower_riser_{i}",
            (lower_run - 0.004, h, lower_depth_z - 0.008),
            (cx, h * 0.5, lower_cz),
            mats["column"],
            parent=group,
        )
        add_three_box(
            f"{sid}_lower_tread_{i}",
            (lower_run + 0.012, 0.024, lower_depth_z),
            (cx, h + 0.012, lower_cz),
            mats["wainscot"],
            parent=group,
        )
        add_three_box(
            f"{sid}_lower_nosing_{i}",
            (0.014, 0.01, lower_depth_z - 0.01),
            (cx + lower_run * 0.5 + 0.002, h + 0.02, lower_cz),
            mats["brass"],
            parent=group,
        )

    winder_w = stair["turnSplitX"] - stair["x0"]
    winder_d = stair["z1"] - stair["lowerTopZ"]
    for w_idx in range(3):
        h = step_h * (lower_count + 1 + w_idx)
        z_max = (
            stair["z1"]
            if w_idx == 0
            else (stair["z1"] - winder_d * 0.34 if w_idx == 1 else stair["z1"] - winder_d * 0.66)
        )
        x_max = (
            stair["turnSplitX"]
            if w_idx == 0
            else (stair["x0"] + winder_w * 0.78 if w_idx == 1 else stair["x0"] + winder_w * 0.96)
        )
        tier_w = x_max - stair["x0"]
        tier_d = z_max - stair["lowerTopZ"]
        cx = (stair["x0"] + x_max) * 0.5
        cz = (stair["lowerTopZ"] + z_max) * 0.5
        add_three_box(
            f"{sid}_winder_body_{w_idx}",
            (tier_w - 0.006, h, tier_d - 0.006),
            (cx, h * 0.5, cz),
            mats["column"],
            parent=group,
        )
        add_three_box(
            f"{sid}_winder_cap_{w_idx}",
            (tier_w, 0.024, tier_d),
            (cx, h + 0.012, cz),
            mats["wainscot"],
            parent=group,
        )

    upper_count = 3
    upper_span_z = stair["lowerTopZ"] - stair["z0"]
    upper_run = upper_span_z / upper_count
    upper_cx = (stair["x0"] + stair["turnSplitX"]) * 0.5
    for i in range(upper_count):
        h = step_h * (lower_count + 3 + i + 1)
        cz = stair["lowerTopZ"] - upper_run * (i + 0.5)
        add_three_box(
            f"{sid}_upper_riser_{i}",
            (winder_w - 0.008, h, upper_run - 0.004),
            (upper_cx, h * 0.5, cz),
            mats["column"],
            parent=group,
        )
        add_three_box(
            f"{sid}_upper_tread_{i}",
            (winder_w, 0.024, upper_run + 0.012),
            (upper_cx, h + 0.012, cz),
            mats["wainscot"],
            parent=group,
        )
        add_three_box(
            f"{sid}_upper_nosing_{i}",
            (winder_w - 0.01, 0.01, 0.014),
            (upper_cx, h + 0.02, cz + upper_run * 0.5 + 0.002),
            mats["brass"],
            parent=group,
        )

    rail_h = min(0.86, max_rise * 0.62)
    corner_y = step_h * (lower_count + 2)
    newel_h = corner_y + rail_h
    add_three_cylinder(
        f"{sid}_newel",
        0.02,
        0.022,
        newel_h,
        (stair["turnSplitX"], newel_h * 0.5, stair["lowerTopZ"]),
        mats["frame"],
        parent=group,
        vertices=12,
    )
    end_post_h = total_rise + rail_h
    add_three_cylinder(
        f"{sid}_end_post",
        0.018,
        0.02,
        end_post_h,
        (stair["turnSplitX"], end_post_h * 0.5, stair["z0"] + 0.04),
        mats["frame"],
        parent=group,
        vertices=12,
    )


def build_overhead_and_hood(plan: dict, lighting_style: str, oven_pose: dict, mats: dict) -> None:
    w = plan["width"]
    d = plan["depth"]
    ceiling_h = plan["ceilingHeight"]
    fixture_y = 2.28
    cord_h = max(0.28, ceiling_h - fixture_y)
    main_zones = [z for z in plan["zones"] if z["kind"] == "main"]
    has_voids = bool(plan.get("voids")) and len(main_zones) > 0
    main_min_x = min(min(z["x0"], z["x1"]) for z in main_zones) if has_voids else -w * 0.5
    main_max_x = max(max(z["x0"], z["x1"]) for z in main_zones) if has_voids else w * 0.5
    main_center_x = (main_min_x + main_max_x) * 0.5
    main_span_w = main_max_x - main_min_x
    pendant_positions = [
        (main_center_x - main_span_w * 0.24, -d * 0.08),
        (main_center_x + main_span_w * 0.22, -d * 0.08),
        (main_center_x - main_span_w * 0.22, d * 0.28),
        (main_center_x + main_span_w * 0.18, d * 0.28),
    ]
    for i, (px, pz) in enumerate(pendant_positions):
        lamp = create_empty(f"overhead_lamp_{i}", px, fixture_y, pz)
        add_three_cylinder(f"lamp_{i}_rosette", 0.042, 0.048, 0.018, (0.0, cord_h, 0.0), mats["brass"], parent=lamp)
        add_three_cylinder(f"lamp_{i}_cord", 0.005, 0.005, cord_h, (0.0, cord_h * 0.5, 0.0), mats["frame"], parent=lamp, vertices=8)
        if lighting_style == "atelier-track":
            add_three_box(f"lamp_{i}_bar", (0.72, 0.03, 0.046), (0.0, 0.0, 0.0), mats["frame"], parent=lamp)
            add_three_box(f"lamp_{i}_caps", (0.74, 0.018, 0.052), (0.0, 0.008, 0.0), mats["brass"], parent=lamp)
            add_three_box(f"lamp_{i}_glow", (0.66, 0.014, 0.034), (0.0, -0.017, 0.0), mats["bulb"], parent=lamp)
        else:
            add_three_cylinder(f"lamp_{i}_collar", 0.028, 0.048, 0.07, (0.0, 0.045, 0.0), mats["brass"], parent=lamp)
            add_three_cylinder(f"lamp_{i}_shade", 0.025, 0.17, 0.14, (0.0, -0.02, 0.0), mats["shade_glass"], parent=lamp, vertices=24)
            add_three_torus(f"lamp_{i}_rim", 0.17, 0.006, (0.0, -0.09, 0.0), mats["brass"], parent=lamp, plane="XZ")
            add_three_sphere(f"lamp_{i}_bulb", 0.042, (0.0, -0.045, 0.0), mats["bulb"], parent=lamp)

    hood = create_empty("canopy_exhaust_hood", oven_pose["x"], 2.12, oven_pose["z"], oven_pose["rotY"])
    add_three_box("hood_lower_skirt", (1.60, 0.13, 1.06), (0.0, -0.045, 0.0), mats["steel"], parent=hood)
    add_three_box("hood_upper_plenum", (1.44, 0.13, 0.92), (0.0, 0.08, 0.0), mats["steel"], parent=hood)
    add_three_box("hood_baffle", (1.38, 0.032, 0.36), (0.0, -0.05, -0.20), mats["basin"], parent=hood, rot_x=0.38)
    add_three_box("hood_task_strip", (1.16, 0.016, 0.06), (0.0, -0.105, 0.28), mats["bulb"], parent=hood)
    add_three_cylinder("hood_spiral_duct", 0.18, 0.19, 0.46, (0.0, 0.36, -0.16), mats["steel"], parent=hood, vertices=20)
    for r_idx, ry in enumerate((0.22, 0.38, 0.52)):
        add_three_torus(f"hood_collar_{r_idx}", 0.192, 0.009, (0.0, ry, -0.16), mats["basin"], parent=hood, plane="XZ")
    for rx_i, rx in enumerate((-0.64, 0.64)):
        for rz_i, rz in enumerate((-0.38, 0.38)):
            add_three_cylinder(f"hood_rod_{rx_i}_{rz_i}", 0.008, 0.008, 0.44, (rx, 0.35, rz), mats["frame"], parent=hood, vertices=8)
    add_three_box("hood_brass_trim", (1.62, 0.022, 1.08), (0.0, -0.11, 0.0), mats["brass"], parent=hood)


def build_storefront_furnishings(placements: dict, mats: dict) -> None:
    # 1. Customer bench
    bench_pose = placements["decor-bench"]
    bench = create_empty("decor_bench", bench_pose["x"], 0.0, bench_pose["z"], bench_pose["rotY"])
    add_three_box("bench_deck", (1.12, 0.042, 0.42), (0.0, 0.38, 0.0), mats["wainscot"], parent=bench)
    add_three_box("bench_trim", (1.13, 0.016, 0.43), (0.0, 0.365, 0.0), mats["brass"], parent=bench)
    add_three_box("bench_cushion", (1.06, 0.072, 0.38), (0.0, 0.438, 0.0), mats["leather"], parent=bench)
    for idx, sx in enumerate((-0.34, -0.17, 0.0, 0.17, 0.34)):
        add_three_box(f"bench_seam_{idx}", (0.008, 0.076, 0.384), (sx, 0.438, 0.0), mats["leather_seam"], parent=bench)
    add_three_box("bench_backrest", (1.06, 0.18, 0.045), (0.0, 0.65, 0.175), mats["wainscot"], parent=bench)
    add_three_cylinder("bench_bolster", 0.048, 0.048, 1.02, (0.0, 0.63, 0.135), mats["leather"], parent=bench, axis="X")
    for idx, bx in enumerate((-0.42, 0.42)):
        add_three_cylinder(f"bench_post_{idx}", 0.012, 0.012, 0.24, (bx, 0.52, 0.175), mats["brass"], parent=bench, vertices=10)
    for lx_i, lx in enumerate((-0.48, 0.48)):
        for lz_i, lz in enumerate((-0.16, 0.16)):
            add_three_cylinder(f"bench_leg_{lx_i}_{lz_i}", 0.02, 0.015, 0.36, (lx, 0.18, lz), mats["frame"], parent=bench, vertices=12)
            add_three_cylinder(f"bench_foot_{lx_i}_{lz_i}", 0.016, 0.016, 0.055, (lx, 0.028, lz), mats["brass"], parent=bench, vertices=12)
    add_three_cylinder("bench_stretcher", 0.01, 0.01, 0.96, (0.0, 0.12, 0.0), mats["brass"], parent=bench, axis="X", vertices=10)

    # 2. Pastry vitrine showcase
    vit_pose = placements["decor-vitrine"]
    vitrine = create_empty("decor_vitrine", vit_pose["x"], 0.0, vit_pose["z"], vit_pose["rotY"])
    add_three_box("vitrine_base", (1.12, 0.76, 0.50), (0.0, 0.38, 0.0), mats["wainscot"], parent=vitrine, uv_repeat=(1.5, 1.0))
    add_three_box("vitrine_plinth", (1.135, 0.065, 0.515), (0.0, 0.032, 0.0), mats["brass"], parent=vitrine)
    add_three_box("vitrine_collar", (1.13, 0.018, 0.51), (0.0, 0.752, 0.0), mats["brass"], parent=vitrine)
    add_three_box("vitrine_marble_top", (1.16, 0.038, 0.54), (0.0, 0.779, 0.0), mats["marble"], parent=vitrine)
    add_three_box("vitrine_glass_hood", (1.08, 0.42, 0.45), (0.0, 1.01, 0.0), mats["glass"], parent=vitrine)
    for cx_i, cx in enumerate((-0.54, 0.54)):
        for cz_i, cz in enumerate((-0.225, 0.225)):
            add_three_box(f"vitrine_post_{cx_i}_{cz_i}", (0.016, 0.43, 0.016), (cx, 1.01, cz), mats["brass"], parent=vitrine)
    add_three_box("vitrine_top_frame", (1.11, 0.022, 0.47), (0.0, 1.222, 0.0), mats["brass"], parent=vitrine)
    add_three_box("vitrine_led", (1.02, 0.01, 0.028), (0.0, 1.206, 0.16), mats["bulb"], parent=vitrine)
    add_three_box("vitrine_mid_shelf", (1.04, 0.014, 0.36), (0.0, 0.99, 0.0), mats["marble"], parent=vitrine)

    loose_idx = 0
    for t_idx, tx in enumerate((-0.34, 0.0, 0.34)):
        add_three_box(f"vitrine_tray_{t_idx}", (0.27, 0.012, 0.31), (tx, 0.804, 0.0), mats["brass"], parent=vitrine)
        for pz in (-0.105, -0.035, 0.035, 0.105):
            for px in (-0.072, 0.072):
                if loose_idx < 12:
                    add_three_box(
                        f"vitrine_financier_{loose_idx}",
                        (0.072, 0.026, 0.042),
                        (tx + px, 0.824, pz),
                        mats["pastry_gold"],
                        parent=vitrine,
                    )
                loose_idx += 1

    box_idx = 0
    for bz in (-0.075, 0.075):
        for bx in (-0.36, -0.12, 0.12, 0.36):
            if box_idx < 3:
                add_three_box(f"vitrine_ballotin_{box_idx}", (0.185, 0.072, 0.125), (bx, 1.036, bz), mats["gift_box"], parent=vitrine)
                add_three_box(f"vitrine_ribbon_x_{box_idx}", (0.189, 0.076, 0.018), (bx, 1.036, bz), mats["brass"], parent=vitrine)
                add_three_box(f"vitrine_ribbon_z_{box_idx}", (0.018, 0.076, 0.129), (bx, 1.036, bz), mats["brass"], parent=vitrine)
            box_idx += 1

    import_glb_at(
        MUJOCO_DIR / "square-register-2g" / "square-register-2g.glb",
        vitrine,
        (0.32, -0.02, 1.233),
        scale_xyz=(0.82, 0.82, 0.82),
    )
    import_glb_at(
        MUJOCO_DIR / "star-mcp31lb" / "star-mcp31lb.glb",
        vitrine,
        (0.48, 0.08, 1.233),
        scale_xyz=(0.86, 0.86, 0.86),
    )

    # 3. Interior olive tree planter
    plt_pose = placements["decor-planter"]
    planter = create_empty("decor_planter", plt_pose["x"], 0.0, plt_pose["z"], plt_pose["rotY"])
    add_three_cylinder("planter_saucer", 0.155, 0.15, 0.028, (0.0, 0.014, 0.0), mats["brass"], parent=planter)
    add_three_cylinder("planter_pot", 0.19, 0.142, 0.40, (0.0, 0.22, 0.0), mats["ceramic"], parent=planter, vertices=22)
    add_three_torus("planter_rim", 0.186, 0.016, (0.0, 0.42, 0.0), mats["ceramic"], parent=planter, plane="XZ")
    add_three_cylinder("planter_soil", 0.174, 0.174, 0.02, (0.0, 0.41, 0.0), mats["soil"], parent=planter)
    add_three_cylinder("planter_trunk", 0.022, 0.034, 0.64, (0.0, 0.71, 0.0), mats["trunk"], parent=planter, vertices=12)
    add_three_cylinder("planter_branch_l", 0.012, 0.018, 0.24, (-0.06, 0.88, 0.03), mats["trunk"], parent=planter, rot_z_three=0.48, vertices=10)
    add_three_cylinder("planter_branch_r", 0.012, 0.018, 0.22, (0.065, 0.91, -0.02), mats["trunk"], parent=planter, rot_z_three=-0.45, vertices=10)
    add_three_sphere("planter_crown_main", 0.21, (0.0, 1.10, 0.0), mats["leaf"], parent=planter, scale_three=(1.05, 0.88, 1.05))
    add_three_sphere("planter_crown_l", 0.15, (-0.12, 0.97, 0.06), mats["leaf_silver"], parent=planter)
    add_three_sphere("planter_crown_r", 0.145, (0.125, 1.01, -0.05), mats["leaf_silver"], parent=planter)
    add_three_sphere("planter_crown_top", 0.13, (0.02, 1.24, 0.03), mats["leaf"], parent=planter)


def build_exterior_threshold(plan: dict, mats: dict) -> None:
    w = plan["width"]
    d = plan["depth"]
    front_z = d * 0.5
    has_south_opening = any(abs(dr["hingeZ"] - front_z) < 0.3 for dr in plan["doors"]) or any(
        abs(win["z0"] - front_z) < 0.3 for win in plan["windows"]
    )
    if not has_south_opening:
        foyer_door = next(
            (dr for dr in plan["doors"] if dr["id"] in ("door-storefront-double", "door-front-entry")),
            plan["doors"][0] if plan["doors"] else None,
        )
        foyer_zone = next((z for z in plan["zones"] if z["id"] == "entry-foyer"), None)
        ext_north_z = min(foyer_zone["z0"], foyer_zone["z1"]) if foyer_zone else -d * 0.3
        ext_min_x = 0.47
        ext_max_x = w * 0.5
        ext_center_x = (ext_min_x + ext_max_x) * 0.5
        apron_w = (ext_max_x - ext_min_x) + 0.28
        apron_d = 0.82
        apron_z = ext_north_z - 0.14 - apron_d * 0.5
        group = create_empty("storefront_threshold", 0.0, 0.0, 0.0)
        add_three_box(
            "storefront_sidewalk_apron",
            (apron_w, 0.068, apron_d),
            (ext_center_x, -0.052, apron_z),
            mats["sidewalk"],
            parent=group,
            uv_repeat=(apron_w * 0.9, apron_d * 0.9),
        )
        add_three_box(
            "storefront_street_curb",
            (apron_w + 0.04, 0.076, 0.11),
            (ext_center_x, -0.044, apron_z - apron_d * 0.5 - 0.055),
            mats["curb"],
            parent=group,
        )
        door_w = foyer_door["width"] if foyer_door else 0.74
        mat_cx = (foyer_door["hingeX"] - door_w * 0.5) if foyer_door else 1.16
        mat_z = (foyer_door["hingeZ"] if foyer_door else -1.44) - 0.24
        mat_w = max(0.54, door_w - 0.04)
        mat_d = 0.28
        add_three_box("storefront_mat_frame", (mat_w + 0.024, 0.005, mat_d + 0.024), (mat_cx, 0.005, mat_z), mats["brass"], parent=group)
        add_three_box("storefront_mat_body", (mat_w, 0.007, mat_d), (mat_cx, 0.0065, mat_z), mats["coir_mat"], parent=group)
        menu_board = create_empty(
            "storefront_menu_board",
            ext_max_x - 0.24,
            0.004,
            (foyer_door["hingeZ"] if foyer_door else -1.44) - 0.62,
            -0.35,
            parent=group,
        )
        for idx, z_sign in enumerate((-1.0, 1.0)):
            add_three_box(
                f"menu_panel_{idx}",
                (0.36, 0.54, 0.02),
                (0.0, 0.29, z_sign * 0.085),
                mats["wainscot"],
                parent=menu_board,
                rot_x=z_sign * -0.18,
            )
            add_three_box(
                f"menu_card_{idx}",
                (0.29, 0.39, 0.006),
                (0.0, 0.30, z_sign * 0.098),
                mats["ceramic"],
                parent=menu_board,
                rot_x=z_sign * -0.18,
            )
        return

    front_zones = (
        [z for z in plan["zones"] if abs(max(z["z0"], z["z1"]) - front_z) < 0.05]
        if plan.get("voids")
        else []
    )
    front_min_x = min(min(z["x0"], z["x1"]) for z in front_zones) if front_zones else -w * 0.5
    front_max_x = max(max(z["x0"], z["x1"]) for z in front_zones) if front_zones else w * 0.5
    front_center_x = (front_min_x + front_max_x) * 0.5
    apron_w = (front_max_x - front_min_x) + 0.44
    apron_d = 0.92
    apron_z = front_z + 0.14 + apron_d * 0.5
    curb_z = front_z + 0.14 + apron_d + 0.055

    group = create_empty("storefront_threshold", 0.0, 0.0, 0.0)
    add_three_box(
        "storefront_sidewalk_apron",
        (apron_w, 0.068, apron_d),
        (front_center_x, -0.052, apron_z),
        mats["sidewalk"],
        parent=group,
        uv_repeat=(apron_w * 0.9, apron_d * 0.9),
    )
    add_three_box("storefront_street_curb", (apron_w + 0.04, 0.076, 0.11), (front_center_x, -0.044, curb_z), mats["curb"], parent=group)
    add_three_box("storefront_street_gutter", (apron_w + 0.04, 0.022, 0.14), (front_center_x, -0.078, curb_z + 0.11), mats["plinth"], parent=group)
    add_three_box("storefront_boundary_strip", (apron_w - 0.16, 0.003, 0.016), (front_center_x, -0.0165, front_z + 0.165), mats["brass"], parent=group)

    front_door = next(
        (dr for dr in plan["doors"] if dr["id"] in ("door-storefront-double", "door-front-entry")),
        plan["doors"][0] if plan["doors"] else None,
    )
    door_w = front_door["width"] if front_door else 0.88
    door_center_x = (
        front_door["hingeX"] + math.cos(door_closed_angle_three(front_door)) * (door_w * 0.5)
        if front_door
        else -w * 0.28
    )

    step_w = door_w + 0.26
    step_d = 0.38
    step_z = front_z + 0.26
    add_three_box("storefront_entry_step", (step_w, 0.018, step_d), (door_center_x, -0.011, step_z), mats["curb"], parent=group)
    add_three_box(
        "storefront_step_nosing",
        (step_w + 0.006, 0.006, 0.016),
        (door_center_x, -0.002, step_z + step_d * 0.5 - 0.006),
        mats["brass"],
        parent=group,
    )

    mat_w = max(0.48, door_w - 0.06)
    mat_d = 0.26
    mat_z = step_z - 0.01
    add_three_box("storefront_mat_frame", (mat_w + 0.024, 0.005, mat_d + 0.024), (door_center_x, -0.001, mat_z), mats["brass"], parent=group)
    add_three_box("storefront_mat_body", (mat_w, 0.007, mat_d), (door_center_x, 0.0005, mat_z), mats["coir_mat"], parent=group)
    for idx, r_off in enumerate((-0.08, -0.04, 0.0, 0.04, 0.08)):
        add_three_box(
            f"storefront_mat_rib_{idx}",
            (mat_w - 0.03, 0.002, 0.01),
            (door_center_x, 0.0045, mat_z + r_off),
            mats["plinth"],
            parent=group,
        )

    planter_xs = (
        (front_min_x + 0.28, front_center_x - 0.18)
        if front_zones and door_center_x > front_center_x
        else (
            (min(front_max_x - 0.85, 0.25), front_max_x - 0.22)
            if front_zones
            else ((-w * 0.34, -0.18) if door_center_x > 0 else (0.25, w * 0.36))
        )
    )
    for i, px in enumerate(planter_xs):
        side = "left" if i == 0 else "right"
        p_group = create_empty(f"storefront_planter_{side}", px, -0.018, front_z + 0.33, parent=group)
        add_three_cylinder(f"ext_planter_{side}_ring", 0.145, 0.14, 0.022, (0.0, 0.011, 0.0), mats["brass"], parent=p_group)
        add_three_cylinder(f"ext_planter_{side}_pot", 0.168, 0.132, 0.28, (0.0, 0.155, 0.0), mats["ceramic"], parent=p_group, vertices=20)
        add_three_cylinder(f"ext_planter_{side}_soil", 0.152, 0.152, 0.018, (0.0, 0.288, 0.0), mats["soil"], parent=p_group)
        add_three_sphere(f"ext_planter_{side}_dome", 0.165, (0.0, 0.40, 0.0), mats["leaf"], parent=p_group, scale_three=(1.06, 0.82, 1.06))
        add_three_sphere(f"ext_planter_{side}_top", 0.11, (0.03, 0.50, 0.02), mats["leaf_silver"], parent=p_group)

    menu_x = 0.24 if door_center_x > 0 else -0.45
    menu_rot = 0.24 if door_center_x > 0 else -0.24
    menu_board = create_empty("storefront_menu_board", menu_x, -0.018, front_z + 0.64, menu_rot, parent=group)
    for idx, z_sign in enumerate((-1.0, 1.0)):
        add_three_box(
            f"menu_panel_{idx}",
            (0.38, 0.58, 0.022),
            (0.0, 0.31, z_sign * 0.09),
            mats["wainscot"],
            parent=menu_board,
            rot_x=z_sign * -0.18,
        )
        add_three_box(
            f"menu_card_{idx}",
            (0.31, 0.42, 0.006),
            (0.0, 0.32, z_sign * 0.104),
            mats["ceramic"],
            parent=menu_board,
            rot_x=z_sign * -0.18,
        )
    add_three_cylinder("menu_hinge_rod", 0.01, 0.01, 0.40, (0.0, 0.59, 0.0), mats["brass"], parent=menu_board, axis="X", vertices=12)


def build_plan(plan: dict, placements: dict, presets: dict) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    preset_id = PLAN_PRESET_MAP.get(plan["id"], "kuramae-artisan")
    design = presets[preset_id]["design"]
    wall_pal = WALL_PALETTES[design["wallMaterial"]]
    fix_pal = FIXTURE_PALETTES[design["fixtureFinish"]]
    floor_id = design["floorMaterial"]
    is_stone_floor = floor_id in ("terrazzo-stone", "limestone-checker")

    floor_img = make_floor_texture(floor_id)
    wainscot_img = make_wainscot_texture(design["wallMaterial"], wall_pal["wainscot"])
    sidewalk_img = make_sidewalk_texture()

    mats = {
        "slab": make_material("SubSlab", hex_rgba(wall_pal["plinth"]), roughness=0.85, metallic=0.08),
        "main": make_material(
            "FloorMain",
            (1.0, 1.0, 1.0, 1.0),
            roughness=0.34 if is_stone_floor else 0.48,
            metallic=0.04,
            coat=0.44 if is_stone_floor else 0.34,
            coat_roughness=0.16 if is_stone_floor else 0.26,
            image=floor_img,
        ),
        "wet": make_material("FloorWet", (1.0, 1.0, 1.0, 1.0), roughness=0.44, coat=0.36, image=make_zone_tile_texture("wet")),
        "toilet": make_material("FloorToilet", (1.0, 1.0, 1.0, 1.0), roughness=0.48, coat=0.30, image=make_zone_tile_texture("toilet")),
        "corridor": make_material("FloorCorridor", (1.0, 1.0, 1.0, 1.0), roughness=0.56, coat=0.20, image=make_zone_tile_texture("corridor")),
        "closet": make_material("FloorCloset", (1.0, 1.0, 1.0, 1.0), roughness=0.58, coat=0.18, image=make_zone_tile_texture("closet")),
        "wall_ext": make_material("WallExterior", hex_rgba(wall_pal["exterior"]), roughness=wall_pal["roughness"], metallic=0.02),
        "wall_int": make_material("WallInterior", hex_rgba(wall_pal["interior"]), roughness=wall_pal["roughness"], metallic=0.02),
        "wainscot": make_material(
            "WallWainscot",
            (1.0, 1.0, 1.0, 1.0),
            roughness=0.44,
            metallic=0.05,
            coat=0.28,
            coat_roughness=0.34,
            image=wainscot_img,
        ),
        "plinth": make_material("BaseboardPlinth", hex_rgba(wall_pal["plinth"]), roughness=0.56, metallic=0.20),
        "cap": make_material("WallCapRail", hex_rgba(wall_pal["cap"]), roughness=0.44, metallic=0.16),
        "column": make_material("ColumnRC", hex_rgba(wall_pal["column"]), roughness=0.62, metallic=0.08),
        "frame": make_material("StorefrontFrame", hex_rgba(fix_pal["frame"]), roughness=fix_pal["frame_rough"], metallic=fix_pal["frame_metal"]),
        "brass": make_material("AccentBrass", hex_rgba(fix_pal["brass"]), roughness=0.25, metallic=0.85),
        "glass": make_material("ArchitecturalGlass", hex_rgba(0xDFF3FB, 0.24), roughness=0.04, metallic=0.06, coat=1.0, coat_roughness=0.04, alpha=0.24),
        "door": make_material("DoorLeaf", hex_rgba(fix_pal["door"]), roughness=0.50, metallic=0.12),
        "steel": make_material("BrushedSteel", hex_rgba(0xE4EAEC), roughness=0.24, metallic=0.84, coat=0.22, coat_roughness=0.28),
        "basin": make_material("SinkBasin", hex_rgba(0x6F7B80), roughness=0.28, metallic=0.80),
        "ceramic": make_material("GlazedCeramic", hex_rgba(0xF8F7F2), roughness=0.14, metallic=0.04, coat=0.72, coat_roughness=0.12),
        "marble": make_material("CalacattaMarble", hex_rgba(0xF5F2EB), roughness=0.20, metallic=0.04, coat=0.54, coat_roughness=0.18),
        "water": make_material("WashWater", hex_rgba(0x7DD3FC, 0.72), roughness=0.06, metallic=0.06, coat=0.95, coat_roughness=0.05, alpha=0.72),
        "leather": make_material("CognacLeather", hex_rgba(0x8F5233), roughness=0.40, metallic=0.05, coat=0.18, coat_roughness=0.42),
        "leather_seam": make_material("LeatherSeam", hex_rgba(0x5C321D), roughness=0.55),
        "pastry_gold": make_material("FinancierGold", hex_rgba(0xD8953B), roughness=0.42, metallic=0.06),
        "gift_box": make_material("BallotinBox", hex_rgba(0x22362B), roughness=0.38, metallic=0.08),
        "bulb": make_material(
            "WarmLampBulb",
            hex_rgba(0xFFF5DB),
            roughness=0.18,
            emission_rgba=hex_rgba(0xFFD074),
            emission_strength=2.2,
        ),
        "shade_glass": make_material("HolophaneShade", hex_rgba(0xFCF6E8, 0.68), roughness=0.18, alpha=0.68),
        "soil": make_material("PlanterSoil", hex_rgba(0x3B2C20), roughness=0.90),
        "trunk": make_material("OliveTrunk", hex_rgba(0x6B5038), roughness=0.76),
        "leaf": make_material("OliveFoliage", hex_rgba(0x5C7753), roughness=0.62),
        "leaf_silver": make_material("OliveSilverLeaf", hex_rgba(0x788F6E), roughness=0.58),
        "sidewalk": make_material("GraniteSidewalk", (1.0, 1.0, 1.0, 1.0), roughness=0.68, metallic=0.04, coat=0.12, image=sidewalk_img),
        "curb": make_material("GraniteCurb", hex_rgba(0xA8A39A), roughness=0.56, metallic=0.06, coat=0.14),
        "coir_mat": make_material("WelcomeCoirMat", hex_rgba(0x332E2A), roughness=0.92, metallic=0.02),
    }

    w = plan["width"]
    d = plan["depth"]
    ceiling_h = plan["ceilingHeight"]

    # 1. Sub-slab
    if plan.get("voids"):
        for zone in plan["zones"]:
            zw = abs(zone["x1"] - zone["x0"])
            zd = abs(zone["z1"] - zone["z0"])
            cx = (zone["x0"] + zone["x1"]) * 0.5
            cz = (zone["z0"] + zone["z1"]) * 0.5
            add_three_box(
                f"floor_slab_{zone['id']}",
                (zw + 0.24, 0.08, zd + 0.24),
                (cx, -0.052, cz),
                mats["slab"],
            )
    else:
        add_three_box("floor_slab", (w + 0.28, 0.08, d + 0.28), (0.0, -0.052, 0.0), mats["slab"])

    # 2. Floor zones (including Ebisu northeast alcove) + brass wet threshold strip
    for zone in plan["zones"]:
        zid = zone["id"]
        zkind = zone["kind"]
        zw = abs(zone["x1"] - zone["x0"])
        zd = abs(zone["z1"] - zone["z0"])
        cx = (zone["x0"] + zone["x1"]) * 0.5
        cz = (zone["z0"] + zone["z1"]) * 0.5
        rep = 0.85 if zkind == "main" else 1.25
        add_three_box(
            f"zone_{zid}",
            (zw - 0.008, 0.022, zd - 0.008),
            (cx, -0.006, cz),
            mats[zkind],
            world_uv_per_m=rep,
        )
        if zkind == "wet":
            add_three_box(
                f"zone_{zid}_brass_strip",
                (zw - 0.04, 0.006, 0.022),
                (cx, 0.006, max(zone["z0"], zone["z1"])),
                mats["brass"],
            )

    # 3. Smart-cutaway walls with baseboard plinth, wainscot, brass dado rail & top cap
    for seg in plan["wallSegments"]:
        wid = seg["id"]
        dx = seg["x1"] - seg["x0"]
        dz = seg["z1"] - seg["z0"]
        length = math.hypot(dx, dz)
        if length < 1e-3:
            continue
        is_ext = seg["exterior"]
        sill_only = seg["kind"] == "sill"
        is_ns = abs(dz) > abs(dx)
        is_backdrop = (not is_ext) or (abs(dz) < 0.05 and (seg["z0"] + seg["z1"]) * 0.5 < -1.1)

        h = seg["segHeight"]
        if not sill_only:
            if is_backdrop and seg["rawWallHeight"] >= 1.0:
                h = min(ceiling_h, 2.35)
            elif seg["rawWallHeight"] >= 1.0:
                h = 1.28

        # Tiny 1.5 mm separation on N-S walls prevents Cycles coplanar Z-fighting at corners
        h_adj = h - (0.0015 if is_ns else 0.0)
        thick = seg["thickness"] - (0.0015 if is_ns else 0.0)
        rot_y = -math.atan2(dz, dx)
        w_group = create_empty(f"wall_{wid}", (seg["x0"] + seg["x1"]) * 0.5, 0.0, (seg["z0"] + seg["z1"]) * 0.5, rot_y)

        add_three_box(f"wall_{wid}_body", (length, h_adj, thick), (0.0, h_adj * 0.5, 0.0), mats["wall_ext" if is_ext else "wall_int"], parent=w_group)
        if h_adj >= 0.25:
            add_three_box(f"wall_{wid}_plinth", (length + 0.002, 0.08, thick + 0.012), (0.0, 0.04, 0.0), mats["plinth"], parent=w_group)
        if (not sill_only) and h_adj >= 0.95:
            wh = min(0.76, h_adj - 0.14)
            add_three_box(
                f"wall_{wid}_wainscot",
                (max(0.04, length - 0.024), wh, thick + 0.010),
                (0.0, 0.085 + wh * 0.5, 0.0),
                mats["wainscot"],
                parent=w_group,
                uv_repeat=(length * 1.4, 1.0),
            )
            add_three_box(
                f"wall_{wid}_dado",
                (max(0.04, length - 0.014), 0.018, thick + 0.020),
                (0.0, 0.085 + wh + 0.009, 0.0),
                mats["brass"],
                parent=w_group,
            )
        if h_adj >= 0.12:
            add_three_box(f"wall_{wid}_cap", (length + 0.006, 0.022, thick + 0.016), (0.0, h_adj + 0.011, 0.0), mats["cap"], parent=w_group)

    # 4. Structural RC columns & pilasters with plinth and cap collar
    for col in plan["columns"]:
        cid = col["id"]
        cw = abs(col["x1"] - col["x0"])
        cd = abs(col["z1"] - col["z0"])
        cx = (col["x0"] + col["x1"]) * 0.5
        cz = (col["z0"] + col["z1"]) * 0.5
        col_h = col.get("height", ceiling_h)
        ch = min(col_h, min(ceiling_h, 2.35) if cz < 0 else 2.25) + 0.004
        add_three_box(f"column_{cid}", (cw + 0.004, ch, cd + 0.004), (cx, ch * 0.5, cz), mats["column"])
        add_three_box(f"column_{cid}_plinth", (cw + 0.022, 0.09, cd + 0.022), (cx, 0.045, cz), mats["plinth"])
        add_three_box(f"column_{cid}_cap", (cw + 0.020, 0.024, cd + 0.020), (cx, ch + 0.012, cz), mats["cap"])

    # 5. Windows & doors
    for win in plan["windows"]:
        build_window_opening(win, mats)
    for door in plan["doors"]:
        build_door_opening(door, mats)

    # 6. Plumbing fixtures (sink-counter, toilet, pipe-shaft) & staircases
    for fix in plan["fixtures"]:
        build_plumbing_fixture(fix, mats)
    for stair in plan.get("stairs", []):
        build_floor_plan_stair(stair, 1.72, mats)

    # 7. Exterior storefront sidewalk apron, curb, welcome mat, planters & menu board
    build_exterior_threshold(plan, mats)

    # 8. Overhead lighting & stainless canopy ventilation hood
    build_overhead_and_hood(plan, design["lightingStyle"], placements["station-oven"], mats)

    # 9. Storefront furnishings (customer bench, pastry vitrine, interior olive planter)
    build_storefront_furnishings(placements, mats)

    # 10. Kitchen & café equipment stations
    for station_id, model in STATION_MODELS.items():
        pose = placements[station_id]
        add_station_assembly(station_id, model, pose["x"], pose["z"], pose["rotY"], mats)

    plan_dir = OUTPUT_DIR / plan["id"]
    plan_dir.mkdir(parents=True, exist_ok=True)
    glb_path = plan_dir / f"{plan['id']}.glb"
    blend_path = plan_dir / f"{plan['id']}.blend"

    # Export clean room + equipment GLB before adding Cycles studio lights & cameras
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
    )

    # Warm studio environment & key/fill lighting for Cycles renders
    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = hex_rgba(0xF3F0EA)
    bg.inputs["Strength"].default_value = 1.05

    bpy.ops.object.light_add(type="SUN", location=(4.8, -6.4, 8.8))
    sun = bpy.context.active_object
    sun.name = "KeySun"
    sun.data.energy = 3.4
    sun.data.color = hex_rgba(0xFFF6E8)[:3]
    sun.data.angle = math.radians(4.5)
    sun.rotation_euler = Euler((math.radians(40), math.radians(16), math.radians(-30)), "XYZ")

    bpy.ops.object.light_add(type="AREA", location=(-3.2, -5.8, 5.2))
    fill = bpy.context.active_object
    fill.name = "StorefrontFill"
    fill.data.energy = 140.0
    fill.data.size = 4.5
    fill.data.color = hex_rgba(0xE8F3FF)[:3]
    fill_dir = Vector((0.0, -0.3, 0.8)) - fill.location
    fill.rotation_euler = fill_dir.to_track_quat("-Z", "Y").to_euler()

    bpy.ops.object.camera_add(location=(6.1, -8.3, 6.7))
    iso_cam = bpy.context.active_object
    iso_cam.name = "CameraIso"
    iso_cam.data.lens = 35
    direction = Vector((0.0, -0.45, 0.55)) - iso_cam.location
    iso_cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = iso_cam

    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100

    iso_png = plan_dir / f"{plan['id']}-iso.png"
    scene.render.filepath = str(iso_png)
    bpy.ops.render.render(write_still=True)

    bpy.ops.object.camera_add(location=(0.0, -0.62, 10.5), rotation=(0.0, 0.0, 0.0))
    top_cam = bpy.context.active_object
    top_cam.name = "CameraTop"
    top_cam.data.type = "ORTHO"
    top_cam.data.ortho_scale = max(w + 1.4, (d + 2.1) * (1200.0 / 900.0))
    scene.camera = top_cam

    top_png = plan_dir / f"{plan['id']}-top.png"
    scene.render.filepath = str(top_png)
    bpy.ops.render.render(write_still=True)

    scene.camera = iso_cam
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    mesh_count = sum(1 for o in scene.objects if o.type == "MESH")
    return {
        "id": plan["id"],
        "label": plan["label"],
        "interior_preset": preset_id,
        "area_sqm": plan["areaSqm"],
        "width_m": w,
        "depth_m": d,
        "mesh_count": mesh_count,
        "blend": str(blend_path.relative_to(REPO_ROOT)),
        "glb": str(glb_path.relative_to(REPO_ROOT)),
        "iso_render": str(iso_png.relative_to(REPO_ROOT)),
        "top_render": str(top_png.relative_to(REPO_ROOT)),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    only_ids: set[str] = set()
    i = 0
    while i < len(argv):
        if argv[i] == "--plan" and i + 1 < len(argv):
            only_ids.add(argv[i + 1])
            i += 2
        else:
            i += 1
    plans, placements, presets = load_floor_plans()
    manifest_path = OUTPUT_DIR / "manifest.json"
    existing_by_id: dict[str, dict] = {}
    if only_ids and manifest_path.exists():
        for entry in json.loads(manifest_path.read_text(encoding="utf-8")):
            existing_by_id[entry["id"]] = entry
    built_by_id: dict[str, dict] = dict(existing_by_id)
    for plan in plans:
        if only_ids and plan["id"] not in only_ids:
            continue
        built_by_id[plan["id"]] = build_plan(plan, placements[plan["id"]], presets)
    manifest = [built_by_id[plan["id"]] for plan in plans if plan["id"] in built_by_id]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Built floor plan rooms:", json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
