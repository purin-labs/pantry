"""Import the 59500P GLB and inspect controls, ventilation and pan support."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_induction import bounds, near

DIRECTORY = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/vollrath-59500p"


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "vollrath-59500p.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects
    root = objects["vp_hob"]
    lead = objects["vp_power_lead"]
    panel = objects["vp_control_panel"]
    knob = objects["vp_encoder_knob"]
    plate = objects["Black ceramic cooking plate"]
    assert knob.parent == panel
    assert panel.parent == root
    assert objects["vp_cooking_zone"].parent == root
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)
    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, (0.3556, 0.38735, 0.0762)):
        near(actual, expected, "Provisional envelope")
    plate_low, plate_high = bounds([plate])
    near(plate_high.x - plate_low.x, 0.292, "Photo-estimated plate width")
    near(plate_high.y - plate_low.y, 0.280, "Photo-estimated plate depth")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    heights = []
    samples = [(0, 0.020)]
    for i in range(24):
        angle = i * math.tau / 24
        samples.append((0.130 * math.cos(angle), 0.020 + 0.130 * math.sin(angle)))
    for x, y in samples:
        hit, point, normal, _face, obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, Vector((x, y, 0.15)), Vector((0, 0, -1))
        )
        assert hit and obj == plate, obj.name if hit else "No surface"
        near(point.z, 0.0762, "Pan reference support")
        assert normal.z > 0.99
        heights.append(point.z)
    initial_plate = plate.matrix_world.copy()
    knob.rotation_euler.z = math.pi / 2
    for name in ("vp_power_button", "vp_mode_button", "vp_timer_button"):
        button = objects[name]
        assert button.parent == panel
        button.location.z -= 0.0005
        bpy.context.view_layer.update()
        assert plate.matrix_world == initial_plate
        button.location.z += 0.0005
    knob.rotation_euler.z = 0
    bpy.context.view_layer.update()
    for foot in (obj for obj in objects if obj.name.startswith("vp_foot_")):
        foot_low, _foot_high = bounds(foot.children_recursive)
        near(foot_low.z, 0, "Foot support plane")
    hole_hit = bpy.context.scene.ray_cast(
        depsgraph, Vector((-0.108, -0.25, 0.029)), Vector((0, 1, 0))
    )
    bridge_hit = bpy.context.scene.ray_cast(
        depsgraph, Vector((-0.105, -0.25, 0.029)), Vector((0, 1, 0))
    )
    assert not hole_hit[0] or hole_hit[1].y > -0.10, "Front cooling slot must be open"
    assert bridge_hit[0] and bridge_hit[1].y < -0.15, (
        "Steel bridge must remain between slots"
    )
    count = 0
    triangles = 0
    for obj in root.children_recursive:
        if obj.type == "MESH":
            count += 1
            obj.data.calc_loop_triangles()
            triangles += len(obj.data.loop_triangles)
            assert obj.data.materials
    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "mesh_count": count,
        "triangle_count": triangles,
        "body_dimensions_m": list(dimensions),
        "width_status": "355.6 mm visual choice; drawing alternative 361.95 mm unresolved",
        "glass_dimensions_m": [plate_high.x - plate_low.x, plate_high.y - plate_low.y],
        "pan_reference_diameter_m": 0.260,
        "support_samples": len(samples),
        "support_height_range_m": [min(heights), max(heights)],
        "front_vent_opening_check": "passed",
        "journey": "Import GLB; inspect provisional envelope; sample pan support; rotate encoder; press and restore all buttons; check foot plane and open ventilation slot",
        "scope": "Visual inspection only. No thermal behavior, calibrated cookware fit, continuous collision or motor simulation.",
    }
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
