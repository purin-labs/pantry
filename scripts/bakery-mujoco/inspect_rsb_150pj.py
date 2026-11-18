"""Import the exported Rinnai RSB-150PJ GLB and inspect geometry, texture, controls, and 6-prong trivet pan support."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_induction import bounds, near
from inspect_mesh_quality import inspect_loaded

DIRECTORY = (
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/rinnai-rsb-150pj"
)
PUBLISHED_ENVELOPE = (0.330, 0.325, 0.111)
TOP_PLATE_DIMENSIONS = (0.299, 0.279)
BURNER_CENTER = (-0.010, 0.000)
BURNER_DIAMETER = 0.075
PAN_REST_Z = 0.106
PRONG_ANGLES_DEG = (30.0, 90.0, 150.0, 210.0, 270.0, 330.0)
FOOT_NAMES = (
    "rsb_foot_left_front",
    "rsb_foot_right_front",
    "rsb_foot_left_rear",
    "rsb_foot_right_rear",
)


def verify_envelope(root):
    low, high = bounds(root.children_recursive)
    dimensions = high - low
    for actual, expected in zip(dimensions, PUBLISHED_ENVELOPE):
        near(actual, expected, "Published CAD envelope")
    return low, high, dimensions


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "rinnai-rsb-150pj.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["rsb_stove"]
    top_plate = objects["rsb_stainless_top_plate"]
    chassis = objects["rsb_lower_chassis"]
    nameplate = objects["rsb_front_nameplate"]
    burner_cap = objects["rsb_burner_cap"]
    burner_cap_mesh = objects["rsb_burner_cap_mesh"]
    trivet = objects["rsb_trivet"]
    trivet_mesh = objects["rsb_trivet_mesh"]
    knob = objects["rsb_control_knob"]
    knob_mesh = objects["rsb_control_knob_mesh"]
    knob_dot = objects["rsb_knob_indicator"]
    hose = objects["rsb_hose_end"]
    hose_mesh = objects["rsb_hose_end_mesh"]
    hose_red = objects["rsb_hose_red_line"]
    flame = objects["rsb_flame_crown"]
    flame_mesh = objects["rsb_flame_crown_mesh"]

    for child in (top_plate, chassis, nameplate, burner_cap, trivet, knob, hose, flame):
        assert child.parent == root, child.name
    assert burner_cap_mesh.parent == burner_cap
    assert trivet_mesh.parent == trivet
    assert knob_mesh.parent == knob
    assert knob_dot.parent == knob
    assert hose_mesh.parent == hose
    assert hose_red.parent == hose
    assert flame_mesh.parent == flame
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    bpy.context.view_layer.update()
    low, high, dimensions = verify_envelope(root)
    near(low.z, 0.0, "Foot support plane Z=0")
    near(high.z, 0.111, "Outer trivet retention tip Z=0.111")

    # Fault-injection check: shifting the hose barb laterally by 10 mm must fail the envelope guard
    orig_hose_x = hose.location.x
    hose.location.x += 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root)
    except AssertionError:
        fault_detected = True
    hose.location.x = orig_hose_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    # Verify 299 x 279 mm stamped stainless top plate and Ø75 mm brass burner cap
    plate_low, plate_high = bounds([top_plate])
    near(plate_high.x - plate_low.x, TOP_PLATE_DIMENSIONS[0], "Stamped stainless top plate width")
    near(plate_high.y - plate_low.y, TOP_PLATE_DIMENSIONS[1], "Stamped stainless top plate depth")
    near(plate_high.z, 0.069, "Stamped stainless top plate rim height Z=0.069")

    cap_low, cap_high = bounds([burner_cap_mesh])
    near(cap_high.x - cap_low.x, BURNER_DIAMETER, "Forged brass burner cap diameter X")
    near(cap_high.y - cap_low.y, BURNER_DIAMETER, "Forged brass burner cap diameter Y")

    # Verify embedded 512x128 front silkscreen texture
    texture_nodes = [
        node
        for node in nameplate.active_material.node_tree.nodes
        if node.type == "TEX_IMAGE"
    ]
    assert len(texture_nodes) == 1
    texture = texture_nodes[0].image
    assert tuple(texture.size) == (512, 128), tuple(texture.size)
    assert texture.has_data

    # Cast 36 downward pan-support rays across the 6 trivet prongs at radii from 60 mm to 140 mm
    # (pan diameters 120 mm to 280 mm) centered on the burner head (-0.010, 0.000).
    depsgraph = bpy.context.evaluated_depsgraph_get()
    samples = []
    for radius in (0.060, 0.080, 0.100, 0.115, 0.130, 0.140):
        for deg in PRONG_ANGLES_DEG:
            ang = math.radians(deg)
            samples.append(
                (
                    BURNER_CENTER[0] + radius * math.cos(ang),
                    BURNER_CENTER[1] + radius * math.sin(ang),
                )
            )
    heights = []
    for sx, sy in samples:
        hit, point, normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, Vector((sx, sy, 0.160)), Vector((0.0, 0.0, -1.0))
        )
        assert hit, (sx, sy)
        assert hit_obj == trivet_mesh, hit_obj.name
        near(point.z, PAN_REST_Z, "Trivet pan support plane Z=0.106")
        assert normal.z > 0.99, normal
        heights.append(point.z)
    assert max(heights) - min(heights) < 0.0001

    # Verify push-and-turn knob articulation, gas hose swivel, and flame modulation leave trivet invariant
    initial_trivet_matrix = trivet_mesh.matrix_world.copy()
    orig_knob_loc = knob.location.copy()
    knob.location = orig_knob_loc + Vector((0.0, 0.004, 0.0))
    knob.rotation_euler = Euler((0.0, -math.pi * 0.5, 0.0), "XYZ")
    hose.rotation_euler = Euler((math.radians(15.0), 0.0, 0.0), "XYZ")
    flame.scale = Vector((0.85, 0.85, 0.55))
    bpy.context.view_layer.update()
    assert trivet_mesh.matrix_world == initial_trivet_matrix
    knob.location = orig_knob_loc
    knob.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
    hose.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
    flame.scale = Vector((1.0, 1.0, 1.0))
    bpy.context.view_layer.update()

    # Verify all 4 rubber feet touch Z = 0.000 m
    for foot_name in FOOT_NAMES:
        foot_obj = objects[foot_name]
        foot_low, _foot_high = bounds([foot_obj])
        near(foot_low.z, 0.0, f"Foot contact plane ({foot_name})")

    # Run full mesh-quality inspection across all exported meshes
    required_meshes = {
        "rsb_stainless_top_plate",
        "rsb_lower_chassis",
        "rsb_front_nameplate",
        "rsb_brand_label",
        "rsb_dial_stop_label",
        "rsb_dial_open_label",
        "rsb_rating_and_screws",
        "rsb_burner_venturi",
        "rsb_burner_cap_mesh",
        "rsb_piezo_insulator",
        "rsb_thermocouple_probe",
        "rsb_trivet_mesh",
        "rsb_control_knob_mesh",
        "rsb_knob_indicator",
        "rsb_hose_end_mesh",
        "rsb_hose_red_line",
        "rsb_flame_crown_mesh",
        *FOOT_NAMES,
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "stamped_top_plate_dimensions_m": [
            round(plate_high.x - plate_low.x, 6),
            round(plate_high.y - plate_low.y, 6),
            round(plate_high.z, 6),
        ],
        "burner_cap_diameter_m": round(cap_high.x - cap_low.x, 6),
        "embedded_texture_pixels": list(texture.size),
        "usable_pan_diameter_range_m": [0.120, 0.280],
        "trivet_support_plane_z_m": PAN_REST_Z,
        "support_samples": len(samples),
        "support_height_range_m": [round(min(heights), 6), round(max(heights), 6)],
        "articulated_parts": [
            "rsb_control_knob",
            "rsb_hose_end",
            "rsb_flame_crown",
            "rsb_trivet",
            "rsb_burner_cap",
        ],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import GLB; verify 330x325x111 mm CAD envelope, 299x279x69 mm stamped stainless top plate, "
            "75 mm forged brass burner cap, and 512x128 embedded front silkscreen texture; verify fault "
            "injection rejection; cast 36 downward pan support rays across all 6 trivet prongs from 120 mm "
            "to 280 mm diameter at Z=0.106 m; actuate push-and-turn ignition knob, gas hose swivel, and "
            "blue flame crown; verify Z=0.000 m foot plane across all 4 rubber feet and zero mesh-quality errors."
        ),
    }
    (DIRECTORY / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
