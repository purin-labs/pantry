"""Inspect exported Quiet One access, vessel geometry and saved source motion."""

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
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/vitamix-quiet-one"
)


def separated(first, second, stage):
    low, high = bounds([first])
    first_tree = None
    for obj in second:
        other_low, other_high = bounds([obj])
        if any(high[i] < other_low[i] or other_high[i] < low[i] for i in range(3)):
            continue
        if first_tree is None:
            first_tree = world_bvh(first)
        assert not first_tree.overlap(world_bvh(obj)), (stage, first.name, obj.name)


def inspect_cover(shell):
    """Sample the assumed 3 mm wall and outward normals on the exported shell."""
    tree = world_bvh(shell)
    probes = [(Vector((0, -0.123, 0.28)), Vector((0, -1, 0)))]
    for index in range(1, 24):
        angle = math.pi - index * math.pi / 48
        direction = Vector((0, math.cos(angle), math.sin(angle)))
        point = Vector((0, -0.063, 0.4572 - 0.0615)) + direction * 0.060
        probes.append((point, direction))
    probes.append((Vector((0, 0.02, 0.4572 - 0.0015)), Vector((0, 0, 1))))
    thicknesses = []
    for point, outward in probes:
        entry, normal, _face, _distance = tree.ray_cast(
            point + outward * 0.01, -outward, 0.02
        )
        assert entry is not None, ("Cover entry missed", list(point))
        assert normal.dot(outward) > 0.99, ("Cover outside normal", list(point))
        exit_point, normal, _face, _distance = tree.ray_cast(
            entry - outward * 0.00001, -outward, 0.006
        )
        assert exit_point is not None, ("Cover exit missed", list(point))
        assert normal.dot(outward) < -0.99, ("Cover inside normal", list(point))
        thickness = (entry - exit_point).length
        assert abs(thickness - 0.003) < 0.00002, ("Cover wall", thickness)
        thicknesses.append(thickness)
    return {
        "rays": len(probes),
        "range_m": [min(thicknesses), max(thicknesses)],
        "expected_m": 0.003,
        "tolerance_m": 0.00002,
        "authority": "Existing provisional wall assumption; no manufacturer thickness available",
        "surface_normals": "outward exterior and inward interior",
    }


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "vitamix-quiet-one.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["tqo_blender"]
    hood = objects["tqo_enclosure_door"]
    jar = objects["tqo_container"]
    lid = objects["tqo_container_lid"]
    plug = objects["tqo_lid_plug"]
    rotor = objects["tqo_blade"]
    hood.rotation_mode = "XYZ"
    rotor.rotation_mode = "XYZ"
    lead = objects["tqo_power_lead"]
    vessel = objects["Hollow Advance container"]
    assert hood.parent == objects["tqo_enclosure_frame"]
    assert jar.parent == root and lid.parent == jar and plug.parent == lid
    assert rotor.parent == jar
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.2159, 0.27178, 0.4572)):
        near(actual, expected, "Closed envelope")
    for obj in objects:
        if obj.name.startswith("tqo_foot_"):
            bottom, _top = bounds(obj.children_recursive)
            near(bottom.z, 0, "Foot support")
    fixed = [
        objects["Fixed clear rear enclosure"],
        objects["Curved black hinge upright"],
        objects["Curved black hinge upright.001"],
    ]
    moving_shell = [obj for obj in hood.children_recursive if obj.type == "MESH"]
    jar_surfaces = [
        vessel,
        objects["Clear integral container handle"],
        objects["Removable two-piece lid"],
        objects["Clear removable lid plug"],
    ]
    shell = objects["Clear front and roof shell"]
    cover_report = inspect_cover(shell)
    door_samples = 0
    for step in range(211):
        angle = step * 0.5
        hood.rotation_euler.x = math.radians(-angle)
        bpy.context.view_layer.update()
        for obj in moving_shell:
            separated(obj, jar_surfaces, f"Door opening {angle}")
        separated(objects["Clear front and roof shell"], fixed, f"Door/frame {angle}")
        door_samples += 1
    hood.rotation_euler.x = math.radians(-105)
    bpy.context.view_layer.update()
    _, opened_high = bounds(
        obj for obj in root.children_recursive if obj not in excluded
    )
    assert abs(opened_high.z - 0.6223) < 0.004, opened_high.z
    original = jar.location.copy()
    path_samples = 0
    removal_path = [(step * 0.001, 0) for step in range(46)]
    removal_path.extend((0.045, -step * 0.002) for step in range(1, 131))
    for lift, forward in removal_path:
        jar.location = original + Vector((0, forward, lift))
        bpy.context.view_layer.update()
        for obj in jar_surfaces:
            separated(obj, moving_shell + fixed, "Container removal")
        path_samples += 1
    # Remove the lid and plug on the extracted container, then inspect the hollow vessel.
    lid.location.z += 0.12
    lid.location.x += 0.22
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    access_heights = []
    for index in range(12):
        angle = index * math.tau / 12
        origin = jar.matrix_world @ Vector(
            (0.027 * math.cos(angle), 0.027 * math.sin(angle), 0.35)
        )
        hit, point, _normal, _face, hit_object, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and (hit_object == vessel or hit_object.parent == rotor), (
            hit_object.name if hit else "Missing floor"
        )
        local = jar.matrix_world.inverted() @ point
        assert 0.030 < local.z < 0.085, local.z
        access_heights.append(local.z)
    for angle in range(360):
        rotor.rotation_euler.z = math.radians(angle)
        bpy.context.view_layer.update()
        for obj in rotor.children_recursive:
            if obj.name.startswith("Advance two-arm blade"):
                separated(obj, [vessel], f"Blade rotation {angle}")
    rotor.rotation_euler.z = 0
    lid.location.x = 0
    lid.location.z = 0.232
    jar.location = original
    hood.rotation_euler.x = 0
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
        "open_height_m": opened_high.z,
        "mesh_count": len(meshes),
        "triangle_count": triangles,
        "door_clearance_samples": door_samples,
        "container_removal_samples": path_samples,
        "access_rays": 12,
        "blade_rotation_samples": 360,
        "cover_wall": cover_report,
        "access_hit_local_height_range_m": [min(access_heights), max(access_heights)],
        "scope": "Sampled visual geometry. No continuous collision, robot grasp, calibrated volume, liquid blending, thermal or acoustic simulation.",
    }
    bpy.ops.wm.read_factory_settings(use_empty=True)
    accessory = DIRECTORY / "vitamix-advance-container.glb"
    bpy.ops.import_scene.gltf(filepath=str(accessory))
    jar = bpy.data.objects["tqo_container"]
    assert jar.location.length < 0.000001
    assert bpy.data.objects["tqo_blade"].parent == jar
    assert (
        bpy.data.objects["tqo_lid_plug"].parent == bpy.data.objects["tqo_container_lid"]
    )
    bpy.context.view_layer.update()
    accessory_low, accessory_high = bounds(jar.children_recursive)
    report["container_export"] = {
        "sha256": hashlib.sha256(accessory.read_bytes()).hexdigest(),
        "dimensions_m": list(accessory_high - accessory_low),
    }
    source = DIRECTORY / "vitamix-quiet-one.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene
    objects = bpy.data.objects
    ref_collection = bpy.data.collections["Manufacturer references - hidden"]
    packed_references = sum(
        bool(obj.data and getattr(obj.data, "packed_file", None))
        for obj in ref_collection.objects
    )
    assert packed_references == 8, packed_references
    assert all(
        bool(image.packed_file) for image in bpy.data.images if image.users > 0
    )
    scene.frame_set(35)
    near(
        objects["tqo_enclosure_door"].rotation_euler.x,
        math.radians(-105),
        "Saved door opening",
    )
    scene.frame_set(80)
    near(objects["tqo_container"].location.y, -0.257, "Saved container removal")
    scene.frame_set(105)
    near(objects["tqo_container_lid"].location.z, 0.307, "Saved lid removal")
    scene.frame_set(200)
    assert abs(objects["tqo_preset_1"].location.z - 0.0025) < 0.000001
    scene.frame_set(240)
    near(objects["tqo_blade"].rotation_euler.z, math.tau, "Saved blade preview")
    scene.frame_set(1)
    report["saved_source"] = {
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "packed_references": 8,
        "access_animation": "passed",
    }
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
