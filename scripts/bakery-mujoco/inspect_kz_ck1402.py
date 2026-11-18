"""Import the exported Panasonic KZ-CK1402 GLB and inspect geometry, texture, controls, and pan support."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_induction import bounds, near
from inspect_mesh_quality import inspect_loaded

DIRECTORY = (
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/panasonic-kz-ck1402"
)
PUBLISHED_ENVELOPE = (0.304, 0.345, 0.054)
PLATE_DIMENSIONS = (0.296, 0.286)
BUTTON_NAMES = (
    "kz_timer_button",
    "kz_simmer_button",
    "kz_high_button",
    "kz_down_button",
    "kz_up_button",
    "kz_course_button",
    "kz_start_button",
)


def verify_envelope(root, excluded):
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, PUBLISHED_ENVELOPE):
        near(actual, expected, "Published CAD envelope")
    return low, high, dimensions


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "panasonic-kz-ck1402.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["kz_hob"]
    panel = objects["kz_control_panel"]
    display = objects["kz_display"]
    zone = objects["kz_cooking_zone"]
    fan = objects["kz_cooling_fan"]
    lead = objects["kz_power_lead"]
    mag_plug = objects["kz_magnetic_plug"]
    jis_plug = objects["kz_jis_plug"]
    plate = objects["Black crystallized cooking plate"]

    for child in (panel, zone, fan, lead):
        assert child.parent == root, child.name
    assert display.parent == panel
    assert mag_plug.parent == lead
    assert jis_plug.parent == lead
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bpy.context.view_layer.update()
    excluded = {lead, *lead.children_recursive}
    low, high, dimensions = verify_envelope(root, excluded)
    near(low.z, 0.0, "Foot support plane Z=0")
    near(high.z, 0.054, "Top crystallized glass plane Z=0.054")

    # Fault-injection check: shifting the chassis laterally by 10 mm must fail the envelope guard
    chassis = objects["Black molded resin chassis"]
    orig_chassis_x = chassis.location.x
    chassis.location.x += 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root, excluded)
    except AssertionError:
        fault_detected = True
    chassis.location.x = orig_chassis_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    # Verify 296 x 286 mm crystallized glass plate dimensions and 512x512 embedded dot-matrix texture
    plate_low, plate_high = bounds([plate])
    near(plate_high.x - plate_low.x, PLATE_DIMENSIONS[0], "Crystallized glass width")
    near(plate_high.y - plate_low.y, PLATE_DIMENSIONS[1], "Crystallized glass depth")

    texture_nodes = [
        node
        for node in plate.active_material.node_tree.nodes
        if node.type == "TEX_IMAGE"
    ]
    assert len(texture_nodes) == 1
    texture = texture_nodes[0].image
    assert tuple(texture.size) == (512, 512)
    assert texture.has_data

    # Cast downward pan-support rays across minimum (120 mm) and maximum (260 mm) usable pan diameters
    # as well as the 190 mm printed cooking zone ring centered at (0.0, +0.020, 0.054) m.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    samples = [(0.0, 0.020)]
    for radius in (0.060, 0.095, 0.130):
        for idx in range(16):
            ang = math.tau * idx / 16.0
            samples.append((radius * math.cos(ang), 0.020 + radius * math.sin(ang)))
    heights = []
    for sx, sy in samples:
        hit, point, normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, Vector((sx, sy, 0.120)), Vector((0.0, 0.0, -1.0))
        )
        assert hit, (sx, sy)
        assert hit_obj in {
            plate,
            objects["Printed cooking zone ring"],
            objects.get("High temp zone caution"),
        }, hit_obj.name
        near(point.z, 0.054, "Pan support plane Z=0.054")
        assert normal.z > 0.99, normal
        heights.append(point.z)
    assert max(heights) - min(heights) < 0.0001

    # Verify all 7 tactile membrane buttons actuate by 0.6 mm without moving the cooking plate
    initial_plate_matrix = plate.matrix_world.copy()
    for name in BUTTON_NAMES:
        btn = objects[name]
        assert btn.parent == panel, name
        orig_z = btn.location.z
        btn.location.z -= 0.0006
        bpy.context.view_layer.update()
        assert plate.matrix_world == initial_plate_matrix
        btn.location.z = orig_z

    # Verify cooling fan 360-degree rotation and magnetic breakaway plug detachment
    for deg in (0, 90, 180, 270):
        fan.rotation_euler.z = math.radians(deg)
        bpy.context.view_layer.update()
        assert plate.matrix_world == initial_plate_matrix
    fan.rotation_euler.z = 0.0

    orig_mag_loc = mag_plug.location.copy()
    mag_plug.location = Vector(
        (orig_mag_loc.x + 0.020, orig_mag_loc.y + 0.020, orig_mag_loc.z)
    )
    bpy.context.view_layer.update()
    assert plate.matrix_world == initial_plate_matrix
    mag_plug.location = orig_mag_loc
    bpy.context.view_layer.update()

    # Verify all 4 rubber feet touch Z = 0.000 m
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("kz_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot contact plane ({obj.name})")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Run full mesh-quality inspection across all exported meshes
    required_meshes = {
        "Black molded resin chassis",
        "Top perimeter bezel",
        "Black crystallized cooking plate",
        "Printed cooking zone ring",
        "Sloped membrane control panel",
        "Central LCD bezel",
        "Backlit LCD window",
        "Underside fan intake shroud",
        "Cooling fan hub",
        "Magnetic breakaway connector body",
        "Magnetic power cord",
        "JIS 100V 15A plug body",
    } | {f"{name}_cap" for name in BUTTON_NAMES}
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "crystallized_glass_dimensions_m": [
            round(plate_high.x - plate_low.x, 6),
            round(plate_high.y - plate_low.y, 6),
        ],
        "embedded_texture_pixels": list(texture.size),
        "usable_pan_diameter_range_m": [0.120, 0.260],
        "cooking_zone_ring_diameter_m": 0.190,
        "support_samples": len(samples),
        "support_height_range_m": [round(min(heights), 6), round(max(heights), 6)],
        "articulated_buttons": list(BUTTON_NAMES),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import GLB; verify 304x345x54 mm CAD envelope, 296x286 mm crystallized glass plate, "
            "and 512x512 embedded dot-matrix texture; verify fault injection rejection; cast 49 "
            "downward pan support rays across 120 mm, 190 mm, and 260 mm diameters at Z=0.054 m; "
            "actuate all 7 membrane buttons; spin underside cooling fan 360 deg; detach and "
            "restore magnetic breakaway plug; verify Z=0.000 m foot plane and zero mesh-quality errors."
        ),
    }
    (DIRECTORY / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
