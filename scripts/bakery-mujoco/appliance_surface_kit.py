"""Shared Blender 5.2 surface, UV, orthographic decal-baking, and softbox studio helpers."""

from __future__ import annotations

from pathlib import Path
import struct
from typing import Callable
import zlib

import bpy
import numpy as np


def load_japanese_font() -> bpy.types.VectorFont:
    for candidate in (
        "/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ):
        p = Path(candidate)
        if p.exists():
            return bpy.data.fonts.load(str(p), check_existing=True)
    return bpy.data.fonts[0]


def load_latin_bold_font() -> bpy.types.VectorFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
    ):
        p = Path(candidate)
        if p.exists():
            return bpy.data.fonts.load(str(p), check_existing=True)
    return load_japanese_font()


def _write_rgba_png(filepath: Path, rgba: np.ndarray, colorspace: str = "sRGB") -> bpy.types.Image:
    h, w, _ = rgba.shape
    u8 = np.clip(np.rint(np.clip(rgba, 0.0, 1.0) * 255.0), 0, 255).astype(np.uint8)
    # Flip vertically so row 0 is top of PNG
    rows = [b"\x00" + u8[y].tobytes() for y in range(h)]
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    filepath.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    existing = bpy.data.images.get(filepath.name)
    if existing is not None:
        bpy.data.images.remove(existing)
    img = bpy.data.images.load(str(filepath))
    img.colorspace_settings.name = colorspace
    img.pack()
    return img


def generate_stainless_hairline_textures(
    out_dir: Path,
    prefix: str,
    base_rgb: tuple[float, float, float] = (0.76, 0.78, 0.80),
    streak_amp: float = 0.042,
    rough_base: float = 0.25,
    seed: int = 4201,
) -> tuple[bpy.types.Image, bpy.types.Image]:
    """Generate seamless 512x512 horizontal SUS304 hairline color + glTF ORM roughness PNGs."""
    rng = np.random.default_rng(seed)
    n = 512
    u = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False, dtype=np.float32)
    v = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)

    # Seamless horizontal hairline streaks: high-frequency in V (rows), low-frequency along U (horizontal brush)
    streak = np.zeros((n, n), dtype=np.float32)
    for kv in (19, 37, 61, 97, 149, 211):
        ph_v = float(rng.uniform(0.0, 2.0 * np.pi))
        ku = int(rng.choice((1, 2, 3)))
        ph_u = float(rng.uniform(0.0, 2.0 * np.pi))
        amp = float(rng.uniform(0.14, 0.28))
        streak += amp * np.sin(kv * vv + ph_v) * (0.78 + 0.22 * np.cos(ku * uu + ph_u))
    # Add fine row-periodic micro-grain
    row_grain = rng.normal(0.0, 0.35, size=(n, 1)).astype(np.float32)
    micro = rng.normal(0.0, 0.12, size=(n, n)).astype(np.float32)
    field = 0.65 * (streak / max(float(np.std(streak)), 1e-5)) + 0.25 * row_grain + 0.10 * micro
    field = np.clip(field, -2.5, 2.5) / 2.5

    col = np.ones((n, n, 4), dtype=np.float32)
    for c_idx, c_val in enumerate(base_rgb):
        col[:, :, c_idx] = c_val + streak_amp * field
    col_img = _write_rgba_png(out_dir / f"{prefix}-stainless-hl.png", col, "sRGB")

    orm = np.ones((n, n, 4), dtype=np.float32)
    orm[:, :, 0] = 1.0  # Occlusion
    orm[:, :, 1] = np.clip(rough_base - 0.045 * field, 0.14, 0.42)  # Roughness (G)
    orm[:, :, 2] = 0.90  # Metallic (B)
    orm_img = _write_rgba_png(out_dir / f"{prefix}-stainless-orm.png", orm, "Non-Color")
    return col_img, orm_img


def textured_stainless_material(
    name: str,
    col_img: bpy.types.Image,
    orm_img: bpy.types.Image,
    tint: tuple[float, float, float, float] = (0.74, 0.77, 0.80, 1.0),
    metallic: float = 0.89,
    roughness: float = 0.25,
    coat: float = 0.06,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = tint
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if coat > 0.0:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.18

    tex_c = nt.nodes.new("ShaderNodeTexImage")
    tex_c.image = col_img
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs["B"].default_value = tint
    nt.links.new(tex_c.outputs["Color"], mix.inputs["A"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])

    tex_r = nt.nodes.new("ShaderNodeTexImage")
    tex_r.image = orm_img
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tex_r.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])

    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = 0.0
    return mat


def textured_decal_material(
    name: str,
    img: bpy.types.Image,
    fallback_rgba: tuple[float, float, float, float] = (0.12, 0.13, 0.15, 1.0),
    roughness: float = 0.30,
    metallic: float = 0.04,
    coat: float = 0.14,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = fallback_rgba
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = 0.22
    if coat > 0.0:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.16
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "CLIP"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    mat["metallic"] = float(metallic)
    mat["roughness"] = float(roughness)
    mat["emission"] = 0.0
    return mat


def project_stainless_uvs(obj: bpy.types.Object, scale: float = 2.4) -> None:
    """Assign world-aligned horizontal hairline UVs without altering geometry."""
    if obj.type != "MESH" or obj.data is None or not obj.data.polygons:
        return
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    rot = mw.to_3x3()
    for poly in mesh.polygons:
        wn = (rot @ poly.normal).normalized()
        ax, ay, az = abs(wn.x), abs(wn.y), abs(wn.z)
        for loop_idx in poly.loop_indices:
            wv = mw @ mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            if ax > ay and ax > az:
                # Left/right side panels: horizontal grain runs front-to-back (Y), vertical is Z
                u, v = wv.y * scale, wv.z * scale
            elif az > ay:
                # Top worktop / floor: horizontal grain runs left-to-right (X), depth is Y
                u, v = wv.x * scale, wv.y * scale
            else:
                # Front / rear panels & doors: horizontal grain runs left-to-right (X), vertical is Z
                u, v = wv.x * scale, wv.z * scale
            uv_layer.data[loop_idx].uv = (u, v)


def project_front_planar_uvs(
    obj: bpy.types.Object,
    center_x: float,
    center_z: float,
    width: float,
    height: float,
    local_space: bool = False,
) -> None:
    """Map X in [cx - w/2, cx + w/2], Z in [cz - h/2, cz + h/2] to UV [0, 1] x [0, 1]."""
    if obj.type != "MESH" or obj.data is None:
        return
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    for poly in mesh.polygons:
        n_y = poly.normal.y if local_space else (mw.to_3x3() @ poly.normal).y
        is_front = n_y < -0.45
        for loop_idx in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_idx].vertex_index].co
            pt = co if local_space else (mw @ co)
            if is_front:
                u = (pt.x - (center_x - width * 0.5)) / max(width, 1e-6)
                v = (pt.z - (center_z - height * 0.5)) / max(height, 1e-6)
                uv_layer.data[loop_idx].uv = (min(max(u, 0.002), 0.998), min(max(v, 0.002), 0.998))
            else:
                uv_layer.data[loop_idx].uv = (0.01, 0.01)


def bake_ortho_sheet(
    filepath: Path,
    res_x: int,
    res_y: int,
    width_m: float,
    height_m: float,
    build_fn: Callable[
        [
            bpy.types.Scene,
            Callable[[str, tuple[float, float, float, float]], bpy.types.Material],
            bpy.types.VectorFont,
            bpy.types.VectorFont,
        ],
        None,
    ],
) -> bpy.types.Image:
    """Render an orthographic emission graphic sheet in an isolated temporary scene and pack it."""
    bake_scene = bpy.data.scenes.new("_OrthoBakeScene")

    created_mats: list[bpy.types.Material] = []

    def emit_mat(mname: str, rgba: tuple[float, float, float, float]) -> bpy.types.Material:
        m = bpy.data.materials.new(f"_bake_{mname}")
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = rgba
        em.inputs["Strength"].default_value = 1.0
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        created_mats.append(m)
        return m

    bake_scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    bake_scene.cycles.device = "GPU"
    bake_scene.cycles.samples = 16
    bake_scene.cycles.use_denoising = False
    bake_scene.render.resolution_x = res_x
    bake_scene.render.resolution_y = res_y
    bake_scene.render.resolution_percentage = 100
    bake_scene.render.image_settings.file_format = "PNG"
    bake_scene.render.image_settings.color_mode = "RGBA"
    bake_scene.view_settings.view_transform = "Standard"
    bake_scene.view_settings.look = "None"
    bake_scene.view_settings.exposure = 0.0

    world = bpy.data.worlds.new("_BakeWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    bake_scene.world = world

    font_jp = load_japanese_font()
    font_en = load_latin_bold_font()
    build_fn(bake_scene, emit_mat, font_jp, font_en)

    cam_data = bpy.data.cameras.new("_BakeCam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(width_m, height_m)
    cam_obj = bpy.data.objects.new("_BakeCam", cam_data)
    bake_scene.collection.objects.link(cam_obj)
    cam_obj.location = (0.0, 0.0, 1.0)
    cam_obj.rotation_euler = (0.0, 0.0, 0.0)
    bake_scene.camera = cam_obj

    bake_scene.render.filepath = str(filepath)
    bpy.ops.render.render(scene=bake_scene.name, write_still=True)

    # Clean up temporary scene and datablocks
    objs_to_remove = list(bake_scene.objects)
    bpy.data.scenes.remove(bake_scene)
    for o in objs_to_remove:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Curve):
                bpy.data.curves.remove(data)
            elif isinstance(data, bpy.types.Camera):
                bpy.data.cameras.remove(data)
    bpy.data.worlds.remove(world)
    for m in created_mats:
        if m.users == 0:
            bpy.data.materials.remove(m)

    existing = bpy.data.images.get(filepath.name)
    if existing is not None:
        bpy.data.images.remove(existing)
    img = bpy.data.images.load(str(filepath))
    img.pack()
    return img


def setup_softbox_world(
    scene: bpy.types.Scene,
    world_name: str,
    camera_bg_rgb: tuple[float, float, float] = (0.70, 0.73, 0.77),
) -> bpy.types.World:
    """Create a studio world where cameras see neutral grey and metals reflect bright softbox bands."""
    world = bpy.data.worlds.new(world_name)
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    lp = nt.nodes.new("ShaderNodeLightPath")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.interpolation = "EASE"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.34, 0.35, 0.37, 1.0)
    cr.elements[1].position = 0.50
    cr.elements[1].color = (0.94, 0.96, 1.00, 1.0)
    top_el = cr.elements.new(0.82)
    top_el.color = (1.18, 1.20, 1.25, 1.0)
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])

    bg_refl = nt.nodes.new("ShaderNodeBackground")
    bg_refl.inputs["Strength"].default_value = 0.92
    nt.links.new(ramp.outputs["Color"], bg_refl.inputs["Color"])

    bg_cam = nt.nodes.new("ShaderNodeBackground")
    bg_cam.inputs["Color"].default_value = (*camera_bg_rgb, 1.0)
    bg_cam.inputs["Strength"].default_value = 0.85

    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg_refl.outputs["Background"], mix.inputs[1])
    nt.links.new(bg_cam.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    scene.world = world
    return world
