"""Inspect the exported UC-L through door opening, rack transfer and arm rotation."""

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
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/winterhalter-uc-l"
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clear(moving, stationary, context):
    for part in moving:
        if part.type != "MESH":
            continue
        tree = world_bvh(part)
        for other in stationary:
            assert not tree.overlap(world_bvh(other)), (context, part.name, other.name)


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "winterhalter-uc-l.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    obj = bpy.data.objects
    root = obj["ucl_dishwasher"]
    door = obj["ucl_door"]
    rack = obj["ucl_wash_rack"]
    assert door.parent == root and rack.parent == root
    assert obj["ucl_handle_site"].parent == door
    assert not any(part.type in {"CAMERA", "LIGHT"} for part in obj)
    bpy.context.view_layer.update()
    low, high = bounds(root.children_recursive)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.600, 0.657, 0.820)):
        near(actual, expected, "Published closed envelope")
    near(low.z, 0, "Floor plane")
    rack_low, rack_high = bounds(rack.children_recursive)
    near(rack_high.x - rack_low.x, 0.500, "Rack width")
    near(rack_high.y - rack_low.y, 0.500, "Rack depth")
    _threshold_low, threshold_high = bounds([obj["Entry threshold"]])
    jamb_low, _jamb_high = bounds([obj["Upper opening jamb"]])
    near(jamb_low.z - threshold_high.z, 0.404, "Published clear entry height")
    stationary = [
        obj[name]
        for name in (
            "Left insulated wall",
            "Right insulated wall",
            "Control fascia",
            "Lower dosing panel",
            "Entry threshold",
            "Front tank wall",
            "Upper opening jamb",
        )
    ]
    stationary.extend(part for part in obj if part.name.startswith("Front corner trim"))
    clear(
        [obj["Rear removable service panel"]],
        [obj["Rear insulated wall"]],
        "Rear panel separation",
    )
    for degrees in (0, 5, 15, 30, 45, 60, 75, 90):
        door.rotation_mode = "XYZ"
        door.rotation_euler.x = math.radians(degrees)
        bpy.context.view_layer.update()
        clear(door.children_recursive, stationary, f"Door {degrees} degrees")
        clear(
            door.children_recursive,
            [mesh for mesh in rack.children_recursive if mesh.type == "MESH"],
            f"Door/rack {degrees} degrees",
        )
    low_open, high_open = bounds(root.children_recursive)
    near(high_open.y - low_open.y, 1.034, "Published open depth")
    support = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for x in (-0.20, 0, 0.20):
        hit, point, normal, _face, part, _matrix = bpy.context.scene.ray_cast(
            depsgraph, Vector((x, -0.62, 0.6)), Vector((0, 0, -1))
        )
        assert hit and part == obj["Door inner wash surface"], (
            part.name if hit else None
        )
        near(point.z, 0.328, "Open door support surface")
        assert normal.z > 0.999
        support.append(list(point))
    rack_obstacles = stationary + [
        obj[name]
        for name in (
            "Wash chamber back",
            "Left inner liner",
            "Right inner liner",
            "Door inner wash surface",
            "Door outer stainless skin",
        )
    ]
    for slide in (0, -0.06, -0.15, -0.25, -0.36, -0.46):
        rack.location.y = 0.002 + slide
        bpy.context.view_layer.update()
        clear(rack.children_recursive, rack_obstacles, f"Rack slide {slide}")
    for lift in (0.005, 0.04, 0.10, 0.14):
        rack.location.z = 0.332 + lift
        bpy.context.view_layer.update()
        clear(rack.children_recursive, rack_obstacles, f"Rack lift {lift}")
    rack.location = (0, 0.002, 0.332)
    chamber = [
        obj[name]
        for name in (
            "Wash chamber back",
            "Left inner liner",
            "Right inner liner",
            "Wash tank floor",
            "Front tank wall",
            "Upper opening jamb",
            "Interior ceiling",
        )
    ]
    rack_meshes = [mesh for mesh in rack.children_recursive if mesh.type == "MESH"]
    for name in ("ucl_lower_wash_field", "ucl_upper_wash_field"):
        arm = obj[name]
        arm.rotation_mode = "XYZ"
        for degrees in range(0, 360, 30):
            arm.rotation_euler.z = math.radians(degrees)
            bpy.context.view_layer.update()
            clear(arm.children_recursive, chamber + rack_meshes, f"{name} {degrees}")
    meshes = [part for part in root.children_recursive if part.type == "MESH"]
    triangles = 0
    for part in meshes:
        assert part.data.materials
        part.data.calc_loop_triangles()
        triangles += len(part.data.loop_triangles)
    report = {
        "status": "passed",
        "glb_sha256": digest(path),
        "closed_dimensions_m": list(dimensions),
        "open_depth_m": high_open.y - low_open.y,
        "rack_dimensions_m": list(rack_high - rack_low),
        "mesh_count": len(meshes),
        "triangle_count": triangles,
        "journey": {
            "door_angles": 8,
            "rack_slide_samples": 6,
            "rack_lift_samples": 4,
            "spray_field_angles_each": 12,
            "open_door_support_rays": support,
        },
        "scope": "Selected visual surfaces and sampled poses. No continuous collision, dynamics, plumbing, washing, chemicals, heat transfer or safety interlock verification.",
    }
    bpy.ops.wm.read_factory_settings(use_empty=True)
    accessory = DIRECTORY / "winterhalter-500-rack.glb"
    bpy.ops.import_scene.gltf(filepath=str(accessory))
    assert bpy.data.objects["ucl_wash_rack"].location.length < 1e-6
    report["rack_sha256"] = digest(accessory)
    source = DIRECTORY / "winterhalter-uc-l.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene
    assert sum(bool(image.packed_file) for image in bpy.data.images) == 5
    scene.frame_set(120)
    near(bpy.data.objects["ucl_door"].rotation_euler.x, math.pi / 2, "Saved open door")
    near(bpy.data.objects["ucl_wash_rack"].location.y, -0.458, "Saved rack removal")
    near(bpy.data.objects["ucl_wash_rack"].location.z, 0.472, "Saved rack lift")
    scene.frame_set(240)
    near(bpy.data.objects["ucl_door"].rotation_euler.x, 0, "Saved closed door")
    near(bpy.data.objects["ucl_wash_rack"].location.y, 0.002, "Saved rack return")
    report["source_sha256"] = digest(source)
    report["packed_references"] = 5
    report["saved_animation"] = "passed"
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
