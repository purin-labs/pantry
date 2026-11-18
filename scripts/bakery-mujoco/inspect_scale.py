"""Import the Ranger exports and inspect the placement and access journey."""

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

DIRECTORY = (
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/ohaus-ranger-3000"
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "ohaus-r31pe6.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["ranger_scale"]
    pan = objects["ranger_weighing_pan"]
    surface = objects["Folded stainless weighing pan"]
    sub = objects["ranger_subplatform"]
    body = objects["Sculpted blue-grey upper housing"]
    assert pan.parent == root and sub.parent == root
    assert objects["ranger_load_surface"].parent == pan
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.311, 0.327, 0.117)):
        near(actual, expected, "Drawing envelope")
    pan_low, pan_high = bounds(pan.children_recursive)
    near(pan_high.x - pan_low.x, 0.300, "Pan width")
    near(pan_high.y - pan_low.y, 0.225, "Pan depth")
    access = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for x in (-0.110, 0, 0.110):
        for y in (-0.040, 0.038, 0.116):
            hit, point, normal, _face, obj, _matrix = bpy.context.scene.ray_cast(
                depsgraph, Vector((x, y, 0.3)), Vector((0, 0, -1))
            )
            assert hit and obj == surface, (hit, obj.name if hit else None)
            near(point.z, 0.117, "Horizontal load surface")
            assert normal.z > 0.999, normal
            access.append(list(point))
    pan_start = pan.location.copy()
    for height in (0, 0.01, 0.03, 0.06, 0.09, 0.12):
        pan.location = pan_start + Vector((0, 0, height))
        bpy.context.view_layer.update()
        for stationary in (body, objects["Removable ABS subplatform"]):
            assert not world_bvh(surface).overlap(world_bvh(stationary)), (
                height,
                stationary.name,
            )
    pan.location = pan_start
    sub_start = sub.location.copy()
    pan.location.z += 0.13
    for height in (0, 0.015, 0.03, 0.065):
        sub.location = sub_start + Vector((0, 0, height))
        bpy.context.view_layer.update()
        assert not world_bvh(objects["Removable ABS subplatform"]).overlap(
            world_bvh(body)
        ), height
    sub.location = sub_start
    pan.location = pan_start
    for index in range(1, 5):
        foot = objects[f"ranger_foot_{index}"]
        bottom, _top = bounds(foot.children_recursive)
        near(bottom.z, 0, "Foot support plane")
        foot.rotation_mode = "XYZ"
        foot.rotation_euler.z = math.pi / 4
        bpy.context.view_layer.update()
        near(
            body.matrix_world.translation.length,
            0,
            "Housing stays fixed during dial adjustment",
        )
        foot.rotation_euler.z = 0
    tare = objects["ranger_tare_button"]
    initial = tare.matrix_world.translation.copy()
    tare.location.z -= 0.00035
    bpy.context.view_layer.update()
    assert abs((tare.matrix_world.translation - initial).length - 0.00035) < 1e-6
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
        "platform_contact_rays": access,
        "pan_lift_samples": 6,
        "subplatform_lift_samples": 4,
        "independent_controls": "4 feet and tare button",
        "scope": "Sampled visual surfaces only. No force sensing, calibration, weight computation, stability, tare logic or continuous contact simulation.",
    }
    bpy.ops.wm.read_factory_settings(use_empty=True)
    accessory = DIRECTORY / "ohaus-ranger-weighing-pan.glb"
    bpy.ops.import_scene.gltf(filepath=str(accessory))
    assert bpy.data.objects["ranger_weighing_pan"].location.length < 1e-6
    bpy.context.view_layer.update()
    _low, top = bounds(bpy.data.objects["ranger_weighing_pan"].children_recursive)
    near(top.z, 0, "Standalone pan load-plane origin")
    report["pan_sha256"] = digest(accessory)
    source = DIRECTORY / "ohaus-r31pe6.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene
    assert sum(bool(image.packed_file) for image in bpy.data.images) == 6
    scene.frame_set(75)
    near(bpy.data.objects["ranger_weighing_pan"].location.z, 0.247, "Saved pan lift")
    near(bpy.data.objects["ranger_subplatform"].location.z, 0.168, "Saved support lift")
    scene.frame_set(152)
    assert abs(bpy.data.objects["ranger_tare_button"].location.z - 0.00195) < 1e-6
    scene.frame_set(180)
    near(bpy.data.objects["ranger_weighing_pan"].location.z, 0.117, "Saved pan return")
    report["source_sha256"] = digest(source)
    report["packed_references"] = 6
    report["saved_animation"] = "passed"
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
