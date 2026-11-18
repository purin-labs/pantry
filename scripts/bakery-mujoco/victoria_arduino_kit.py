"""Shared Victoria Arduino Eagle-family sculpted geometry builders for Blender 5.2.

Used by both:
- scripts/bakery-mujoco/build_eagle_one_visuals.py (Eagle One 2-Group)
- scripts/bakery-mujoco/build_e1_prima_visuals.py (E1 PRIMA 1-Group)
"""

from __future__ import annotations

import math

import bmesh
import bpy

from build_mixer_visuals import mesh_object


def profile_panel(
    name: str,
    x0: float,
    x1: float,
    profile: list[tuple[float, float]],
    mat: bpy.types.Material,
    parent: bpy.types.Object,
    bevel: float = 0.003,
) -> bpy.types.Object:
    """Extrude a closed 2D (y, z) side-cheek profile across [x0, x1]."""
    vertices = [(x, y, z) for x in (x0, x1) for y, z in profile]
    count = len(profile)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend(
        (i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)
    )
    return mesh_object(name, vertices, faces, mat, parent, bevel)


def group_cover(
    name: str,
    parent: bpy.types.Object,
    mat: bpy.types.Material,
    scale_xy: float = 1.0,
    scale_z: float = 1.0,
    bevel: float = 0.001,
) -> bpy.types.Object:
    """Sculpted Victoria Arduino Eagle-family trapezoidal chrome brew-group hood."""
    sections = [
        (0.000, 0.065, 0.048),
        (0.004, 0.066, 0.049),
        (0.014, 0.066, 0.050),
        (0.040, 0.064, 0.049),
        (0.068, 0.061, 0.046),
        (0.084, 0.058, 0.043),
        (0.091, 0.054, 0.039),
        (0.094, 0.048, 0.035),
    ]
    vertices: list[tuple[float, float, float]] = []
    count = 96
    for z, rx, ry in sections:
        sx = rx * scale_xy
        sy = ry * scale_xy
        sz = z * scale_z
        for i in range(count):
            angle = i * math.tau / count
            vertices.append((sx * math.cos(angle), sy * math.sin(angle), sz))
    faces: list[tuple[int, ...]] = [tuple(reversed(range(count)))]
    for row in range(len(sections) - 1):
        for i in range(count):
            following = (i + 1) % count
            faces.append(
                (
                    row * count + i,
                    row * count + following,
                    (row + 1) * count + following,
                    (row + 1) * count + i,
                )
            )
    faces.append(tuple(range((len(sections) - 1) * count, len(sections) * count)))
    return mesh_object(name, vertices, faces, mat, parent, bevel)


def control_shield(
    name: str,
    parent: bpy.types.Object,
    mat: bpy.types.Material,
    scale_xy: float = 1.0,
    scale_z: float = 1.0,
    thickness: float = 0.0008,
) -> bpy.types.Object:
    """Curved tapered black architectural control inset on the forward face of the Eagle brew group."""
    vertices: list[tuple[float, float, float]] = []
    columns = 32
    rows = 12
    for shell_sign in (0.0, -thickness):
        for row in range(rows + 1):
            t = row / rows
            half_width = (0.018 + 0.033 * math.sin(t * math.pi / 2)) * scale_xy
            for column in range(columns + 1):
                u = 2 * column / columns - 1
                x = u * half_width
                z_base = 0.040 + t * 0.045 + 0.005 * (1 - u * u)
                if z_base <= 0.068:
                    blend = (z_base - 0.040) / 0.028
                    rx = (0.064 - 0.003 * blend) * scale_xy
                    ry = (0.049 - 0.003 * blend) * scale_xy
                elif z_base <= 0.084:
                    blend = (z_base - 0.068) / 0.016
                    rx = (0.061 - 0.003 * blend) * scale_xy
                    ry = (0.046 - 0.003 * blend) * scale_xy
                else:
                    blend = (z_base - 0.084) / 0.007
                    rx = (0.058 - 0.004 * blend) * scale_xy
                    ry = (0.043 - 0.004 * blend) * scale_xy
                y = -ry * math.sqrt(max(0.01, 1 - (x / rx) ** 2)) - 0.0015 + shell_sign
                vertices.append((x, y, z_base * scale_z))

    ring_stride = (rows + 1) * (columns + 1)
    faces: list[tuple[int, ...]] = []
    for row in range(rows):
        for column in range(columns):
            f0 = row * (columns + 1) + column
            # Front shell (facing -Y)
            faces.append((f0, f0 + columns + 1, f0 + columns + 2, f0 + 1))
            # Back shell (facing +Y)
            b0 = ring_stride + f0
            faces.append((b0, b0 + 1, b0 + columns + 2, b0 + columns + 1))

    # Stitch perimeter rim between front and back shells
    for column in range(columns):
        # Bottom edge (row = 0)
        a, b = column, column + 1
        faces.append((a, b, ring_stride + b, ring_stride + a))
        # Top edge (row = rows)
        ta = rows * (columns + 1) + column
        tb = ta + 1
        faces.append((tb, ta, ring_stride + ta, ring_stride + tb))
    for row in range(rows):
        # Left edge (column = 0)
        la = row * (columns + 1)
        lb = (row + 1) * (columns + 1)
        faces.append((lb, la, ring_stride + la, ring_stride + lb))
        # Right edge (column = columns)
        ra = row * (columns + 1) + columns
        rb = (row + 1) * (columns + 1) + columns
        faces.append((ra, rb, ring_stride + rb, ring_stride + ra))

    return mesh_object(name, vertices, faces, mat, parent)


def perforated_plate(
    name: str,
    width: float,
    depth: float,
    nx: int,
    ny: int,
    radius: float,
    surface: bpy.types.Material,
    parent: bpy.types.Object,
    half_thickness: float = 0.0006,
) -> bpy.types.Object:
    """Watertight stainless sheet with real diamond-cutout openings and welded tile seams."""
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    dx, dy = width / nx, depth / ny
    for ix in range(nx):
        for iy in range(ny):
            cx = -width / 2 + (ix + 0.5) * dx
            cy = -depth / 2 + (iy + 0.5) * dy
            outer = [
                (-dx / 2, -dy / 2),
                (dx / 2, -dy / 2),
                (dx / 2, dy / 2),
                (-dx / 2, dy / 2),
            ]
            inner = [(0.0, -radius), (radius, 0.0), (0.0, radius), (-radius, 0.0)]
            start = len(vertices)
            for z in (-half_thickness, half_thickness):
                vertices.extend((cx + x, cy + y, z) for x, y in outer + inner)
            for i in range(4):
                n = (i + 1) % 4
                faces.extend(
                    [
                        (start + i, start + n, start + 4 + n, start + 4 + i),
                        (start + 8 + i, start + 12 + i, start + 12 + n, start + 8 + n),
                        (start + 4 + i, start + 4 + n, start + 12 + n, start + 12 + i),
                    ]
                )
                boundary = (
                    (i == 0 and iy == 0)
                    or (i == 1 and ix == nx - 1)
                    or (i == 2 and iy == ny - 1)
                    or (i == 3 and ix == 0)
                )
                if boundary:
                    faces.append((start + i, start + 8 + i, start + 8 + n, start + n))

    obj = mesh_object(name, vertices, faces, surface, parent)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def rear_emblem(
    root: bpy.types.Object,
    surface: bpy.types.Material,
    name: str = "Rear eagle emblem",
    width_scale: float = 1.0,
    z_center: float = 0.302,
    y_plane: float = 0.266,
    z_ref: float = 0.259,
    rake_deg: float = 5.0,
    thickness: float = 0.0012,
    bevel: float = 0.0004,
) -> bpy.types.Object:
    """Stylized raised Victoria Arduino 1905 outstretched-wing Eagle emblem on a raked rear panel."""
    base_outline = [
        (-0.060, 0.008),
        (-0.036, 0.007),
        (-0.009, 0.005),
        (0.000, 0.002),
        (0.009, 0.005),
        (0.036, 0.007),
        (0.060, 0.008),
        (0.054, 0.004),
        (0.030, 0.002),
        (0.009, -0.001),
        (0.003, -0.010),
        (-0.003, -0.010),
        (-0.009, -0.001),
        (-0.030, 0.002),
        (-0.054, 0.004),
    ]
    outline = [(dx * width_scale, z_center + dz * width_scale) for dx, dz in base_outline]
    tan_rake = math.tan(math.radians(rake_deg))
    vertices = [
        (x, y_plane - tan_rake * (z - z_ref) + 0.003 + offset, z)
        for offset in (0.0, thickness)
        for x, z in outline
    ]
    n = len(outline)
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    return mesh_object(name, vertices, faces, surface, root, bevel)
