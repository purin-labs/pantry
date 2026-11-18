"""Inspect the exported Fellow Opus 2 GLB through a lid, hopper, burr, scale ring, knob, timer button, and catch cup journey."""

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
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/fellow-opus-2"
)
PUBLISHED_ENVELOPE = (0.130, 0.206, 0.267)


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
    path = DIRECTORY / "fellow-opus-2.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["opus_grinder"]
    knob = objects["opus_grind_knob"]
    scale_ring = objects["opus_scale_ring"]
    hopper = objects["opus_hopper"]
    lid = objects["opus_hopper_lid"]
    carrier = objects["opus_burr_carrier"]
    cone = objects["opus_burr_cone"]
    button = objects["opus_power_button"]
    cup = objects["opus_catch_cup"]
    lead = objects["opus_power_lead"]

    barrel_mesh = objects["Suspended cylindrical grind barrel"]
    column_mesh = objects["Rear vertical motor column"]
    knob_mesh = objects["Side knurled grind knob"]
    ring_mesh = objects["Upper graduated scale ring"]
    hopper_mesh = objects["Removable bean hopper"]
    lid_mesh = objects["Removable hopper lid"]
    carrier_mesh = objects["Outer 48mm burr carrier"]
    cone_mesh = objects["Inner 48mm 6-star conical burr"]
    cup_shell = objects["Magnetic grounds catch cup"]
    cup_pad = objects["Magnetic catch-cup pad"]

    for child in (knob, scale_ring, hopper, lid, carrier, cone, button, cup, lead):
        assert child.parent == root, child.name
    assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in objects)
    bpy.context.view_layer.update()

    excluded = {lead, *lead.children_recursive}
    low, high, dimensions = verify_envelope(root, excluded)
    near(low.z, 0.0, "Base plane Z=0")

    # Fault-injection check: a 12 mm lateral shift of the side grind knob must fail the envelope guard.
    original_knob_x = knob.location.x
    knob.location.x += 0.012
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root, excluded)
    except AssertionError:
        fault_detected = True
    knob.location.x = original_knob_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    for obj in objects:
        if obj.name.startswith("opus_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot plane ({obj.name})")

    # Verify mesh quality across the imported GLB
    quality = inspect_loaded(
        {
            "Matte black base plate",
            "Rear vertical motor column",
            "Glossy column side wrap",
            "Suspended cylindrical grind barrel",
            "Side knurled grind knob",
            "Upper graduated scale ring",
            "Removable bean hopper",
            "Anti-popcorning center dome",
            "Removable hopper lid",
            "Outer 48mm burr carrier",
            "Inner 48mm 6-star conical burr",
            "Magnetic grounds catch cup",
            "Front timer push button",
        }
    )
    assert quality["passed"], quality

    # Control actuation checks: pressing front timer button and turning side knob + scale ring
    barrel_pose = barrel_mesh.matrix_world.copy()
    before_btn = button.location.copy()
    button.location.y += 0.0012
    bpy.context.view_layer.update()
    assert barrel_mesh.matrix_world == barrel_pose
    button.location = before_btn

    knob_samples = 0
    for k_deg, s_deg in ((0, 0), (90, -12), (180, -24), (-90, 12)):
        knob.rotation_euler.x = math.radians(k_deg)
        scale_ring.rotation_euler.z = math.radians(s_deg)
        bpy.context.view_layer.update()
        assert not world_bvh(knob_mesh).overlap(world_bvh(barrel_mesh)), (
            "Side grind knob crosses barrel",
            k_deg,
        )
        assert not world_bvh(ring_mesh).overlap(world_bvh(barrel_mesh)), (
            "Scale ring crosses barrel",
            s_deg,
        )
        assert not world_bvh(ring_mesh).overlap(world_bvh(column_mesh)), (
            "Scale ring crosses rear column",
            s_deg,
        )
        knob_samples += 1
    knob.rotation_euler.x = 0.0
    scale_ring.rotation_euler.z = 0.0
    bpy.context.view_layer.update()

    # Lid lift and hopper removal clearance checks
    lid_samples = 0
    for lift in (0.0, 0.025, 0.065, 0.120):
        lid.location.z = 0.2610 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(lid_mesh).overlap(world_bvh(hopper_mesh)), (
            "Hopper lid crosses bean hopper",
            lift,
        )
        assert not world_bvh(lid_mesh).overlap(world_bvh(column_mesh)), (
            "Hopper lid crosses rear column",
            lift,
        )
        lid_samples += 1
    lid.location.x += 0.220

    hopper_samples = 0
    for angle_deg, lift in (
        (0, 0.0),
        (15, 0.004),
        (15, 0.025),
        (15, 0.060),
        (15, 0.090),
    ):
        hopper.rotation_euler.z = math.radians(angle_deg)
        hopper.location.z = 0.2280 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(hopper_mesh).overlap(world_bvh(barrel_mesh)), (
            "Bean hopper crosses grind barrel",
            angle_deg,
            lift,
        )
        assert not world_bvh(hopper_mesh).overlap(world_bvh(ring_mesh)), (
            "Bean hopper crosses scale ring",
            angle_deg,
            lift,
        )
        assert not world_bvh(hopper_mesh).overlap(world_bvh(carrier_mesh)), (
            "Bean hopper crosses upper burr carrier",
            angle_deg,
            lift,
        )
        hopper_samples += 1

    # Disassemble hopper and upper 48 mm burr carrier to inspect internal burr chamber access from above
    hopper.location.x += 0.220
    carrier_samples = 0
    for lift in (0.0, 0.015, 0.040, 0.070):
        carrier.location.z = 0.1680 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(carrier_mesh).overlap(world_bvh(barrel_mesh)), (
            "Burr carrier crosses grind barrel",
            lift,
        )
        assert not world_bvh(carrier_mesh).overlap(world_bvh(cone_mesh)), (
            "Outer ring burr carrier crosses inner conical burr",
            lift,
        )
        carrier_samples += 1

    carrier.location.x += 0.220
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    chamber_access_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (
                -0.0110 + 0.022 * math.cos(angle),
                -0.0360 + 0.022 * math.sin(angle),
                0.255,
            )
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and 0.115 < point.z < 0.215, (
            hit_obj.name if hit else "No hit",
            point,
        )
        chamber_access_heights.append(point.z)

    # Restore carrier, hopper, and lid, then verify 360 degree inner conical burr rotation clearance
    carrier.location = (-0.0110, -0.0360, 0.1680)
    hopper.location = (-0.0110, -0.0360, 0.2280)
    hopper.rotation_euler.z = 0.0
    lid.location = (-0.0110, -0.0360, 0.2610)
    bpy.context.view_layer.update()

    burr_samples = 0
    outer_bvh = world_bvh(carrier_mesh)
    for angle_deg in range(0, 360, 15):
        cone.rotation_euler.z = math.radians(angle_deg)
        bpy.context.view_layer.update()
        assert not world_bvh(cone_mesh).overlap(outer_bvh), (
            "Inner 6-star conical burr crosses outer ring burr carrier",
            angle_deg,
        )
        burr_samples += 1
    cone.rotation_euler.z = 0.0

    # Verify magnetic catch cup slide-out, lift, and downward interior access rays
    cup_samples = 0
    for dy, dz in ((0.0, 0.0), (-0.045, 0.0), (-0.095, 0.0), (-0.095, 0.015)):
        cup.location.y = -0.0360 + dy
        cup.location.z = 0.0200 + dz
        bpy.context.view_layer.update()
        assert not world_bvh(cup_shell).overlap(world_bvh(barrel_mesh)), (
            "Catch cup crosses grind barrel",
            dy,
            dz,
        )
        assert not world_bvh(cup_shell).overlap(world_bvh(cup_pad)), (
            "Catch cup crosses magnetic landing pad",
            dy,
            dz,
        )
        cup_samples += 1

    # Cast downward rays into the pulled-out catch cup interior
    depsgraph = bpy.context.evaluated_depsgraph_get()
    cup_interior_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (
                -0.0110 + 0.016 * math.cos(angle),
                -0.1310 + 0.016 * math.sin(angle),
                0.150,
            )
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and hit_obj == cup_shell, (
            hit_obj.name if hit else "No hit",
            point,
        )
        assert 0.038 < point.z < 0.045, point.z
        cup_interior_heights.append(point.z)

    cup.location = (-0.0110, -0.0360, 0.0200)
    bpy.context.view_layer.update()

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "knob_scale_samples": knob_samples,
        "lid_clearance_samples": lid_samples,
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
            "Import GLB; verify 130x206x267 mm envelope and Z=0 foot plane; verify fault injection "
            "rejection; press front timer push button and rotate side knurled knob + upper scale ring; "
            "lift hopper lid and bean hopper; lift upper 48 mm burr carrier and cast chamber access rays; "
            "rotate 6-star conical burr 360 deg; slide out magnetic catch cup and cast cup interior rays"
        ),
        "scope": (
            "Sampled visual geometry only. Worm-gear reduction ratio, magnetic self-centering force curve, "
            "400 RPM gearmotor torque/jam sensing, and bean particle comminution remain in physics/calibration scope."
        ),
        "accessory_exports": [],
    }

    for filename, root_name, required_part in (
        (
            "fellow-opus-2-cup.glb",
            "opus_catch_cup",
            "Magnetic grounds catch cup",
        ),
        (
            "fellow-opus-2-burr-carrier.glb",
            "opus_burr_carrier",
            "Outer 48mm burr carrier",
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

    source_path = DIRECTORY / "fellow-opus-2.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source_path))
    scene = bpy.context.scene
    objects = bpy.data.objects
    packed_references = sum(bool(image.packed_file) for image in bpy.data.images)
    assert packed_references == 5, packed_references

    scene.frame_set(20)
    near(
        objects["opus_hopper_lid"].location.z,
        0.3360,
        "Saved hopper lid lift",
    )
    scene.frame_set(40)
    near(objects["opus_hopper"].location.z, 0.3180, "Saved bean hopper lift")
    scene.frame_set(55)
    near(
        objects["opus_burr_carrier"].location.z,
        0.2380,
        "Saved upper 48 mm burr carrier lift",
    )
    near(
        objects["opus_catch_cup"].location.y,
        -0.1310,
        "Saved magnetic catch cup forward presentation",
    )
    scene.frame_set(130)
    near(
        objects["opus_grind_knob"].rotation_euler.x,
        math.pi,
        "Saved side grind knob 180 deg turn",
    )
    near(
        objects["opus_scale_ring"].rotation_euler.z,
        math.radians(-24.0),
        "Saved upper scale ring coupled rotation",
    )
    scene.frame_set(136)
    near(
        objects["opus_power_button"].location.y,
        -0.1006,
        "Saved front timer button inward press",
    )
    scene.frame_set(180)
    near(objects["opus_hopper"].location.z, 0.2280, "Restored hopper Z")
    near(objects["opus_catch_cup"].location.y, -0.0360, "Restored catch cup Y")
    near(
        objects["opus_burr_cone"].rotation_euler.z,
        math.tau,
        "Saved 6-star conical burr 360 deg spin",
    )
    assert objects["opus_grinder"].location.length < 0.000001

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
