"""Import the exported MIH-02C GLB and inspect geometry, texture and access."""

import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Vector

DIRECTORY = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/maruzen-mih-02c"


def bounds(objects):
    points = []
    for obj in objects:
        if obj.type == "MESH":
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return low, high


def near(actual, expected, title):
    assert abs(actual - expected) < 0.001, (title, actual, expected)


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in background Blender")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "maruzen-mih-02c.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["mih_hob"]
    knob = objects["mih_power_knob"]
    button = objects["mih_power_button"]
    intake = objects["mih_filter"]
    lead = objects["mih_power_lead"]
    zone = objects["mih_cooking_zone"]
    plate = objects["Ceramic cooking plate"]
    for obj in (knob, button, intake, lead, zone):
        assert obj.parent == root, obj.name
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    excluded = {lead, knob, *lead.children_recursive, *knob.children_recursive}
    bpy.context.view_layer.update()
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.300, 0.450, 0.120)):
        near(actual, expected, "Body envelope")
    plate_low, plate_high = bounds([plate])
    near(plate_high.x - plate_low.x, 0.275, "Ceramic width")
    near(plate_high.y - plate_low.y, 0.300, "Ceramic depth")
    texture_nodes = [
        node
        for node in plate.active_material.node_tree.nodes
        if node.type == "TEX_IMAGE"
    ]
    assert len(texture_nodes) == 1
    texture = texture_nodes[0].image
    assert tuple(texture.size) == (512, 512)
    assert texture.has_data
    # A 200 mm flat base centered on the marked zone: centre and 16 perimeter rays.
    heights = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    samples = [(0, 0)]
    for index in range(16):
        angle = index * math.tau / 16
        samples.append((0.100 * math.cos(angle), 0.100 * math.sin(angle)))
    for x, y in samples:
        hit, position, normal, _face, obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, Vector((x, y, 0.160)), Vector((0, 0, -1))
        )
        assert hit
        assert obj == plate or obj.name.startswith("Printed cooking zone ring"), (
            obj.name
        )
        near(position.z, 0.105, "Pan support height")
        assert normal.z > 0.99
        heights.append(position.z)
    assert max(heights) - min(heights) < 0.0001
    knob.rotation_euler.y = math.radians(65)
    button.location.y += 0.001
    intake.location.y -= 0.250
    bpy.context.view_layer.update()
    _removed_low, removed_high = bounds(intake.children_recursive)
    assert removed_high.y < -0.170, "The filter moves out from under the chassis"
    near(plate.matrix_world.translation.z, 0.1025, "Plate remains fixed")
    knob.rotation_euler.y = 0
    button.location.y -= 0.001
    intake.location.y += 0.250
    bpy.context.view_layer.update()
    for foot in (obj for obj in objects if obj.name.startswith("mih_foot_")):
        foot_low, _foot_high = bounds(foot.children_recursive)
        near(foot_low.z, 0, "Foot support height")
        assert list(foot["published_adjustment_m"]) == [0, 0.015]
    mesh_count = 0
    triangles = 0
    for obj in root.children_recursive:
        if obj.type == "MESH":
            mesh_count += 1
            obj.data.calc_loop_triangles()
            triangles += len(obj.data.loop_triangles)
            assert obj.data.materials
    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "mesh_count": mesh_count,
        "triangle_count": triangles,
        "body_dimensions_m": list(dimensions),
        "ceramic_dimensions_m": [
            plate_high.x - plate_low.x,
            plate_high.y - plate_low.y,
        ],
        "embedded_texture_pixels": list(texture.size),
        "pan_reference_diameter_m": 0.200,
        "support_samples": len(samples),
        "support_height_range_m": [min(heights), max(heights)],
        "journey": "Import GLB; verify envelope and embedded texture; sample flat pan support; turn knob; press button; remove and restore filter; verify foot plane",
        "scope": "Visual geometry only. Pan support rays do not establish dynamic stability, suitable cookware, heating or control behavior.",
    }
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
