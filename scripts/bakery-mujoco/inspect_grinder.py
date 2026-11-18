"""Inspect the exported WSG60 through a cover, bowl and blade access journey."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_induction import bounds, near

DIRECTORY = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/waring-wsg60"


def world_bvh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    points = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    return BVHTree.FromPolygons(
        points,
        [tuple(face.vertices) for face in mesh.loop_triangles],
        all_triangles=True,
    )


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "waring-wsg60.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["wsg_grinder"]
    bowl = objects["wsg_bowl"]
    cover = objects["wsg_cover"]
    blade = objects["wsg_blade"]
    steel = objects["Hollow stainless grinding bowl"]
    glass = objects["Clear closed-top operating cover"]
    housing = objects["Tapered die-cast motor housing"]
    lead = objects["wsg_power_lead"]
    assert bowl.parent == root and cover.parent == root
    assert blade.parent == bowl
    assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in objects)
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.1651, 0.2159, 0.2921)):
        near(actual, expected, "Provisional drawing envelope")
    for obj in objects:
        if obj.name.startswith("wsg_foot_"):
            bottom, _top = bounds(obj.children_recursive)
            near(bottom.z, 0, "Foot plane")
    housing_pose = housing.matrix_world.copy()
    for name in ("wsg_start_stop_button", "wsg_pulse_button"):
        control = objects[name]
        before = control.location.copy()
        control.location.z -= 0.0005
        bpy.context.view_layer.update()
        assert housing.matrix_world == housing_pose
        control.location = before
    # Unlock counterclockwise, then lift. Only the clear shell/bowl pair is checked.
    cover_samples = 0
    for angle, lift in ((0, 0), (9, 0), (18, 0), (18, 0.05), (18, 0.11), (18, 0.16)):
        cover.rotation_euler.z = math.radians(angle)
        cover.location.z = 0.180 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(glass).overlap(world_bvh(steel)), (
            "Cover crosses steel bowl"
        )
        cover_samples += 1
    cover.location.x += 0.3
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    floor_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (0.026 * math.cos(angle), 0.015 + 0.026 * math.sin(angle), 0.32)
        )
        hit, point, _normal, _face, hit_object, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and point.z < 0.228, (hit_object.name if hit else "No floor", point)
        assert hit_object == steel or hit_object.parent == blade
        floor_heights.append(point.z)
    blade_meshes = [obj for obj in blade.children_recursive if obj.type == "MESH"]
    blade_samples = 0
    for angle in range(0, 360, 15):
        blade.rotation_euler.z = math.radians(angle)
        bpy.context.view_layer.update()
        wall = world_bvh(steel)
        # The shaft penetrates its bowl seal by design; inspect the four blade arms.
        for obj in blade_meshes:
            if obj.name.startswith("Swept grinding blade"):
                assert not world_bvh(obj).overlap(wall), (
                    "Blade crosses bowl",
                    angle,
                    obj.name,
                )
        blade_samples += 1
    blade.rotation_euler.z = 0
    original_bowl = bowl.location.copy()
    for lift in (0, 0.03, 0.06, 0.09):
        bowl.location.z = original_bowl.z + lift
        bpy.context.view_layer.update()
        assert not world_bvh(steel).overlap(world_bvh(housing)), (
            "Steel bowl crosses housing"
        )
        assert housing.matrix_world == housing_pose
    bowl.location = original_bowl
    cover.location = (0, 0.015, 0.180)
    cover.rotation_euler.z = 0
    bpy.context.view_layer.update()
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    triangles = 0
    for obj in meshes:
        assert obj.data.materials
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "body_dimensions_m": list(dimensions),
        "mesh_count": len(meshes),
        "triangle_count": triangles,
        "cover_clearance_samples": cover_samples,
        "bowl_access_rays": len(floor_heights),
        "bowl_access_hit_height_range_m": [min(floor_heights), max(floor_heights)],
        "blade_rotation_samples": blade_samples,
        "journey": "Import GLB; check envelope and feet; press controls; unlock and lift cover; inspect bowl access; rotate blade; remove and replace bowl; restore cover",
        "scope": "Sampled visual geometry only. Bayonet engagement, continuous contacts, electrical interlock, cutting, capacity and recipe performance remain unverified.",
    }
    report["accessory_exports"] = []
    for filename, root_name, required_part in (
        ("waring-wsg60-bowl.glb", "wsg_bowl", "wsg_blade"),
        ("waring-wsg60-storage-lid.glb", "wsg_storage_lid", "Storage lid moulding"),
    ):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        accessory_path = DIRECTORY / filename
        bpy.ops.import_scene.gltf(filepath=str(accessory_path))
        accessory = bpy.data.objects[root_name]
        assert bpy.data.objects[required_part] in accessory.children_recursive
        assert accessory.location.length < 0.000001
        assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in bpy.data.objects)
        bpy.context.view_layer.update()
        accessory_low, accessory_high = bounds(accessory.children_recursive)
        report["accessory_exports"].append(
            {
                "file": filename,
                "sha256": hashlib.sha256(accessory_path.read_bytes()).hexdigest(),
                "dimensions_m": list(accessory_high - accessory_low),
            }
        )
    source_path = DIRECTORY / "waring-wsg60.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source_path))
    scene = bpy.context.scene
    objects = bpy.data.objects
    ref_collection = bpy.data.collections["Manufacturer references - hidden"]
    packed_references = sum(
        bool(obj.data and getattr(obj.data, "packed_file", None))
        for obj in ref_collection.objects
    )
    assert packed_references == 5
    assert all(
        bool(image.packed_file) for image in bpy.data.images if image.users > 0
    )
    scene.frame_set(20)
    near(objects["wsg_cover"].rotation_euler.z, math.radians(18), "Saved unlock angle")
    scene.frame_set(40)
    near(objects["wsg_cover"].location.z, 0.340, "Saved cover lift")
    scene.frame_set(65)
    near(objects["wsg_bowl"].location.z, 0.250, "Saved bowl lift")
    scene.frame_set(125)
    assert abs(objects["wsg_pulse_button"].location.z - 0.1768) < 0.000001
    scene.frame_set(180)
    near(objects["wsg_blade"].rotation_euler.z, math.tau, "Saved blade preview")
    scene.frame_set(1)
    near(objects["wsg_bowl"].location.z, 0.160, "Restored bowl")
    near(objects["wsg_cover"].location.z, 0.180, "Restored cover")
    assert objects["wsg_grinder"].location.length < 0.000001
    assert bpy.data.collections["Storage lid accessory - hidden"].hide_render
    report["saved_source"] = {
        "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "packed_references": packed_references,
        "access_animation": "passed",
    }
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
