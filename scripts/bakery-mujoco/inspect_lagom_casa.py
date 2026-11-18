"""Inspect the exported Option-O Lagom Casa GLB through a hopper, burr, clicker, power button, and dosing cup journey."""

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
from inspect_mesh_quality import inspect_loaded

DIRECTORY = (
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/option-o-lagom-casa"
)
PUBLISHED_ENVELOPE = (0.090, 0.215, 0.275)


def world_bvh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    points = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    return BVHTree.FromPolygons(
        points,
        [tuple(face.vertices) for face in mesh.loop_triangles],
        all_triangles=True,
    )


def verify_envelope(root, excluded):
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, PUBLISHED_ENVELOPE):
        near(actual, expected, "Published drawing envelope")
    return low, high, dimensions


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "option-o-lagom-casa.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["casa_grinder"]
    hopper = objects["casa_hopper"]
    carrier = objects["casa_burr_carrier"]
    cone = objects["casa_burr_cone"]
    clicker = objects["casa_clicker"]
    button = objects["casa_power_button"]
    cup = objects["casa_dosing_cup"]
    lead = objects["casa_power_lead"]

    chamber_mesh = objects["Vertical grind chamber housing"]
    hopper_mesh = objects["Rotatable bean hopper collar"]
    carrier_mesh = objects["Mizen 65CL outer burr carrier"]
    outer_burr_mesh = objects["Mizen 65CL outer burr carrier"]
    cone_mesh = objects["Mizen 65CL conical burr"]
    cup_shell = objects["Magnetic dosing catch cup"]
    cup_pad = objects["Magnetic catch-cup pad"]
    clicker_knob = objects["Chute knocker button"]
    button_cap = objects["Auto-grind switch button"]

    for child in (hopper, carrier, cone, clicker, button, cup, lead):
        assert child.parent == root, child.name
    assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in objects)
    bpy.context.view_layer.update()

    excluded = {lead, *lead.children_recursive}
    low, high, dimensions = verify_envelope(root, excluded)
    near(low.z, 0.0, "Base plane Z=0")

    # Fault-injection check: a 2 mm lateral shift of the dosing cup must fail the envelope guard.
    original_cup_x = cup.location.x
    cup.location.x += 0.015
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root, excluded)
    except AssertionError:
        fault_detected = True
    cup.location.x = original_cup_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    for obj in objects:
        if obj.name.startswith("casa_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot plane ({obj.name})")

    # Verify mesh quality across the imported GLB
    quality = inspect_loaded(
        {
            "Anodised stadium base",
            "Vertical support pillar",
            "Horizontal motor housing",
            "Vertical grind chamber housing",
            "Anti-popcorning center dome",
            "Rotatable bean hopper collar",
            "Mizen 65CL outer burr carrier",
            "Mizen 65CL conical burr",
            "Magnetic dosing catch cup",
            "Chute knocker button",
            "Auto-grind switch button",
        }
    )
    assert quality["passed"], quality

    # Control actuation checks: pressing power button and snapping chute clicker do not move chamber
    chamber_pose = chamber_mesh.matrix_world.copy()
    before_btn = button.location.copy()
    button.location.x += 0.0012
    bpy.context.view_layer.update()
    assert chamber_mesh.matrix_world == chamber_pose
    button.location = before_btn

    before_clicker = clicker.location.copy()
    clicker.location.z -= 0.0060
    bpy.context.view_layer.update()
    assert chamber_mesh.matrix_world == chamber_pose
    assert not world_bvh(clicker_knob).overlap(world_bvh(chamber_mesh)), (
        "Clicker knob crosses chamber housing"
    )
    clicker.location = before_clicker
    bpy.context.view_layer.update()

    # Grind adjustment dial rotation and tool-less hopper lift clearance
    hopper_samples = 0
    for angle_deg, lift in (
        (0, 0.0),
        (-36, 0.0),
        (54, 0.0),
        (180, 0.004),
        (360, 0.015),
        (360, 0.045),
        (360, 0.075),
    ):
        hopper.rotation_euler.z = math.radians(angle_deg)
        hopper.location.z = 0.2255 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(hopper_mesh).overlap(world_bvh(chamber_mesh)), (
            "Hopper collar crosses grind chamber",
            angle_deg,
            lift,
        )
        assert not world_bvh(hopper_mesh).overlap(world_bvh(carrier_mesh)), (
            "Hopper collar crosses upper burr carrier",
            angle_deg,
            lift,
        )
        hopper_samples += 1

    # Disassemble hopper and upper burr carrier to inspect internal burr chamber access from above
    hopper.location.x += 0.200
    carrier_samples = 0
    for lift in (0.0, 0.015, 0.035, 0.060):
        carrier.location.z = 0.1760 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(carrier_mesh).overlap(world_bvh(chamber_mesh)), (
            "Burr carrier crosses grind chamber",
            lift,
        )
        assert not world_bvh(outer_burr_mesh).overlap(world_bvh(cone_mesh)), (
            "Outer ring burr crosses inner conical burr",
            lift,
        )
        carrier_samples += 1

    carrier.location.x += 0.200
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    chamber_access_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (0.022 * math.cos(angle), -0.0545 + 0.022 * math.sin(angle), 0.260)
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and 0.130 < point.z < 0.220, (
            hit_obj.name if hit else "No hit",
            point,
        )
        chamber_access_heights.append(point.z)

    # Restore carrier and hopper, then verify 360 degree inner conical burr rotation clearance
    carrier.location = (0.0, -0.0545, 0.1760)
    hopper.location = (0.0, -0.0545, 0.2255)
    hopper.rotation_euler.z = 0.0
    bpy.context.view_layer.update()

    burr_samples = 0
    outer_bvh = world_bvh(outer_burr_mesh)
    for angle_deg in range(0, 360, 15):
        cone.rotation_euler.z = math.radians(angle_deg)
        bpy.context.view_layer.update()
        assert not world_bvh(cone_mesh).overlap(outer_bvh), (
            "Inner conical burr crosses outer ring burr",
            angle_deg,
        )
        burr_samples += 1
    cone.rotation_euler.z = 0.0

    # Verify magnetic dosing cup slide-out, lift, and downward interior access rays
    cup_samples = 0
    for dy, dz in ((0.0, 0.0), (-0.040, 0.0), (-0.085, 0.0), (-0.085, 0.015)):
        cup.location.y = -0.0545 + dy
        cup.location.z = 0.0380 + dz
        bpy.context.view_layer.update()
        assert not world_bvh(cup_shell).overlap(world_bvh(chamber_mesh)), (
            "Dosing cup crosses chamber",
            dy,
            dz,
        )
        assert not world_bvh(cup_shell).overlap(world_bvh(cup_pad)), (
            "Dosing cup crosses magnetic landing pad",
            dy,
            dz,
        )
        cup_samples += 1

    # Cast downward rays into the pulled-out dosing cup interior
    depsgraph = bpy.context.evaluated_depsgraph_get()
    cup_interior_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (0.018 * math.cos(angle), -0.1395 + 0.018 * math.sin(angle), 0.160)
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and hit_obj == cup_shell, (
            hit_obj.name if hit else "No hit",
            point,
        )
        assert 0.052 < point.z < 0.062, point.z
        cup_interior_heights.append(point.z)

    cup.location = (0.0, -0.0545, 0.0380)
    bpy.context.view_layer.update()

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "hopper_clearance_samples": hopper_samples,
        "carrier_clearance_samples": carrier_samples,
        "chamber_access_rays": len(chamber_access_heights),
        "chamber_access_hit_height_range_m": [
            round(min(chamber_access_heights), 6),
            round(max(chamber_access_heights), 6),
        ],
        "burr_rotation_samples": burr_samples,
        "cup_clearance_samples": cup_samples,
        "cup_interior_rays": len(cup_interior_heights),
        "cup_interior_floor_height_range_m": [
            round(min(cup_interior_heights), 6),
            round(max(cup_interior_heights), 6),
        ],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import GLB; verify 90x215x275 mm envelope and Z=0 foot plane; verify fault injection "
            "rejection; press side auto-grind button and snap front chute clicker; rotate grind dial "
            "and unscrew hopper; lift upper Mizen 65CL burr carrier and cast chamber access rays; "
            "rotate conical burr 360 deg; slide out magnetic catch cup and cast cup interior rays"
        ),
        "scope": (
            "Sampled visual geometry only. Thread pitch engagement, magnetic self-centering force curve, "
            "brushless planetary motor torque sensing, and bean particle comminution remain in physics/calibration scope."
        ),
        "accessory_exports": [],
    }

    for filename, root_name, required_part in (
        (
            "option-o-lagom-casa-cup.glb",
            "casa_dosing_cup",
            "Magnetic dosing catch cup",
        ),
        (
            "option-o-lagom-casa-burr-carrier.glb",
            "casa_burr_carrier",
            "Mizen 65CL outer burr carrier",
        ),
    ):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        accessory_path = DIRECTORY / filename
        bpy.ops.import_scene.gltf(filepath=str(accessory_path))
        accessory = bpy.data.objects[root_name]
        assert bpy.data.objects[required_part] in accessory.children_recursive
        assert accessory.location.length < 0.000001
        assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in bpy.data.objects)
        bpy.context.view_layer.update()
        acc_low, acc_high = bounds(accessory.children_recursive)
        report["accessory_exports"].append(
            {
                "file": filename,
                "sha256": hashlib.sha256(accessory_path.read_bytes()).hexdigest(),
                "dimensions_m": [round(val, 6) for val in (acc_high - acc_low)],
            }
        )

    source_path = DIRECTORY / "option-o-lagom-casa.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source_path))
    scene = bpy.context.scene
    objects = bpy.data.objects
    ref_collection = bpy.data.collections["Manufacturer references - hidden"]
    packed_references = sum(
        bool(obj.data and getattr(obj.data, "packed_file", None))
        for obj in ref_collection.objects
    )
    assert packed_references == 5, packed_references
    unpacked_active_images = [
        image.name
        for image in bpy.data.images
        if image.users > 0 and not bool(image.packed_file)
    ]
    assert not unpacked_active_images, unpacked_active_images

    scene.frame_set(20)
    near(
        objects["casa_hopper"].rotation_euler.z,
        math.radians(45),
        "Saved dial coarser/unscrew angle",
    )
    scene.frame_set(40)
    near(objects["casa_hopper"].location.z, 0.3205, "Saved tool-less hopper lift")
    scene.frame_set(55)
    near(
        objects["casa_burr_carrier"].location.z,
        0.2410,
        "Saved upper burr carrier lift",
    )
    near(
        objects["casa_dosing_cup"].location.y,
        -0.1495,
        "Saved magnetic catch cup forward presentation",
    )
    scene.frame_set(120)
    near(
        objects["casa_power_button"].location.x,
        -0.0430,
        "Saved side power button press",
    )
    scene.frame_set(168)
    near(
        objects["casa_clicker"].location.z,
        0.2030,
        "Saved front chute clicker downward snap",
    )
    scene.frame_set(180)
    near(objects["casa_hopper"].location.z, 0.2255, "Restored hopper Z")
    near(objects["casa_dosing_cup"].location.y, -0.0545, "Restored dosing cup Y")
    near(
        objects["casa_burr_cone"].rotation_euler.z,
        math.tau,
        "Saved conical burr 360 deg spin",
    )
    assert objects["casa_grinder"].location.length < 0.000001

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
