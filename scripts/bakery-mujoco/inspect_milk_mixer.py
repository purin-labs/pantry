"""Inspect the actual SM 3587 export through disassembly and jug access."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_grinder import world_bvh
from inspect_induction import bounds, near

DIRECTORY = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/severin-sm-3587"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "severin-sm-3587.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["sm3587_milk_mixer"]
    jug = objects["sm3587_jug"]
    lid = objects["sm3587_lid"]
    insert = objects["sm3587_lid_insert"]
    tool = objects["sm3587_stirrer"]
    cover = objects["sm3587_stirrer_cover"]
    steel = objects["Hollow stainless milk jug"]
    assert jug.parent == root and lid.parent == jug and tool.parent == jug
    assert insert.parent == lid and cover.parent == tool
    assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in objects)
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.195, 0.155, 0.250)):
        near(actual, expected, "Published envelope")
    near(low.z, 0, "Counter support plane")
    # Remove the small ingredient insert vertically, then the entire lid.
    for lift in (0, 0.004, 0.015, 0.050):
        insert.location.z = lift
        bpy.context.view_layer.update()
        assert not world_bvh(
            objects["Transparent twist-out ingredient insert"]
        ).overlap(world_bvh(objects["Clear annular lid"]))
    insert.location.z = 0
    for lift in (0, 0.010, 0.04, 0.080, 0.135):
        lid.location.z = 0.071 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(objects["Clear annular lid"]).overlap(world_bvh(steel))
    lid.location.x = 0.3
    # Both the cover and serrated tool clear the central boss and jug walls.
    for lift in (0, 0.004, 0.012, 0.025):
        cover.location.z = 0.009 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(objects["Heating stirrer cover"]).overlap(world_bvh(steel))
    cover.location.z = 0.009
    for lift in (0, 0.015, 0.040, 0.080, 0.120):
        tool.location.z = 0.0085 + lift
        bpy.context.view_layer.update()
        for mesh in tool.children_recursive:
            if mesh.type == "MESH":
                assert not world_bvh(mesh).overlap(world_bvh(steel)), mesh.name
                assert not world_bvh(mesh).overlap(
                    world_bvh(objects["Jug central locating boss"])
                ), mesh.name
    tool.location.x = 0.3
    tool.location.z = 0.0085
    # Rays enter the uncovered hollow vessel and land on its inner floor.
    hits = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector((0.035 * math.cos(angle), 0.035 * math.sin(angle), 0.30))
        hit, point, normal, _face, obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and obj == steel
        near(point.z, 0.181, "Open jug inner floor")
        assert normal.z > 0.99
        hits.append(list(point))
    tool.location.x = 0
    lid.location.x = 0
    lid.location.z = 0.071
    for lift in (0, 0.005, 0.015, 0.030, 0.070):
        jug.location.z = 0.176 + lift
        bpy.context.view_layer.update()
        for stationary in (
            "Stainless induction collar",
            "Recessed jug seating surface",
            "Tapered black housing",
        ):
            assert not world_bvh(steel).overlap(world_bvh(objects[stationary])), (
                stationary
            )
    jug.location.z = 0.176
    dial = objects["sm3587_selector"]
    screen = objects["sm3587_display_button"]
    bpy.context.view_layer.update()
    screen_pose = screen.matrix_world.copy()
    axis_before = dial.matrix_world.to_3x3() @ Vector((0, 0, 1))
    dial.rotation_mode = "XYZ"
    dial.rotation_euler.z = 0.35
    bpy.context.view_layer.update()
    assert (axis_before - dial.matrix_world.to_3x3() @ Vector((0, 0, 1))).length < 1e-6
    assert screen.matrix_world == screen_pose
    screen.location.y += 0.0006
    bpy.context.view_layer.update()
    travel = (screen.matrix_world.translation - screen_pose.translation).length
    assert abs(travel - 0.0006) < 1e-6
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    triangles = 0
    for obj in meshes:
        assert obj.data.materials
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    report = {
        "status": "passed",
        "glb_sha256": digest(path),
        "body_dimensions_m": list(dimensions),
        "mesh_count": len(meshes),
        "triangle_count": triangles,
        "journey": {
            "insert_lift_samples": 4,
            "lid_lift_samples": 5,
            "stirrer_cover_lift_samples": 4,
            "stirrer_lift_samples": 5,
            "jug_lift_samples": 5,
            "open_jug_floor_rays": hits,
            "selector_axis_and_stationary_display": "passed",
        },
        "scope": "Sampled visual surfaces. No continuous contact certification, dynamics, heat transfer, fluids, food safety or recipe validation.",
    }
    accessory = DIRECTORY / "severin-sm-3587-jug.glb"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(accessory))
    assert bpy.data.objects["sm3587_jug"].location.length < 1e-6
    assert "sm3587_lid" in bpy.data.objects
    assert "sm3587_stirrer" in bpy.data.objects
    report["jug_sha256"] = digest(accessory)
    source = DIRECTORY / "severin-sm-3587.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    assert sum(bool(image.packed_file) for image in bpy.data.images) == 3
    scene = bpy.context.scene
    scene.frame_set(95)
    near(bpy.data.objects["sm3587_jug"].location.z, 0.246, "Saved jug lift")
    near(bpy.data.objects["sm3587_lid"].location.z, 0.206, "Saved lid lift")
    scene.frame_set(180)
    near(bpy.data.objects["sm3587_jug"].location.z, 0.176, "Saved jug return")
    near(bpy.data.objects["sm3587_stirrer"].location.z, 0.0085, "Saved stirrer return")
    report["source_sha256"] = digest(source)
    report["packed_references"] = 3
    report["saved_animation"] = "passed"
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
