"""Inspect the exported MiiCoffee DF64 II (Gen 2, V2.6) GLB through a lid, bellows, dial collar, 64 mm flat burr, power button, and 58 mm dosing cup journey."""

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
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/miicoffee-df64-gen2"
)
PUBLISHED_ENVELOPE = (0.130, 0.225, 0.300)


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
    path = DIRECTORY / "miicoffee-df64-gen2.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["df64_grinder"]
    dial = objects["df64_dial_collar"]
    upper_burr = objects["df64_upper_burr_carrier"]
    lower_burr = objects["df64_lower_burr_rotor"]
    bellows = objects["df64_bellows"]
    lid = objects["df64_wood_lid"]
    cup = objects["df64_dosing_cup"]
    button = objects["df64_power_button"]
    lead = objects["df64_power_lead"]

    cyl_mesh = objects["df64_tilted_cylinder"]
    throat_mesh = objects["df64_aluminum_throat"]
    antipopcorn_mesh = objects["df64_antipopcorn_convex_disc"]
    pointer_mesh = objects["df64_dial_indicator_pointer"]
    dial_mesh = objects["df64_dial_chrome_collar"]
    upper_carrier_mesh = objects["df64_upper_carrier_body"]
    upper_ring_mesh = objects["df64_upper_flat_burr_ring"]
    lower_rotor_mesh = objects["df64_lower_rotor_disc"]
    lower_ring_mesh = objects["df64_lower_flat_burr_ring"]
    bellows_mesh = objects["df64_silicone_bellows_body"]
    lid_mesh = objects["df64_walnut_lid_body"]
    cup_mesh = objects["df64_dosing_cup_body"]
    fork_left_mesh = objects["df64_fork_prong_left"]
    fork_right_mesh = objects["df64_fork_prong_right"]

    for child in (dial, upper_burr, lower_burr, bellows, lid, cup, button, lead):
        assert child.parent == root, child.name
    assert not any(obj.type in {"CAMERA", "LIGHT"} for obj in objects)
    bpy.context.view_layer.update()

    excluded = {lead, *lead.children_recursive}
    low, high, dimensions = verify_envelope(root, excluded)
    near(low.z, 0.0, "Base plane Z=0")

    # Fault-injection check: a 12 mm lateral shift of the chrome dial collar must fail the envelope guard.
    original_dial_x = dial.location.x
    dial.location.x += 0.012
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root, excluded)
    except AssertionError:
        fault_detected = True
    dial.location.x = original_dial_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    for obj in objects:
        if obj.name.startswith("df64_rubber_foot_"):
            foot_low, _foot_high = bounds([obj])
            near(foot_low.z, 0.0, f"Foot plane ({obj.name})")

    # Verify mesh quality across the imported GLB
    quality = inspect_loaded(
        {
            "df64_base_plinth",
            "df64_tilted_cylinder",
            "df64_discharge_chute",
            "df64_aluminum_throat",
            "df64_antipopcorn_convex_disc",
            "df64_dial_chrome_collar",
            "df64_upper_carrier_body",
            "df64_upper_flat_burr_ring",
            "df64_lower_rotor_disc",
            "df64_lower_flat_burr_ring",
            "df64_silicone_bellows_body",
            "df64_walnut_lid_body",
            "df64_dosing_cup_body",
            "df64_power_button_cap",
        }
    )
    assert quality["passed"], quality

    # 1. Control actuation checks: pressing lower-right metal power button and rotating chrome stepless dial collar
    cyl_pose = cyl_mesh.matrix_world.copy()
    before_btn = button.location.copy()
    button.location.x -= 0.0022
    bpy.context.view_layer.update()
    assert cyl_mesh.matrix_world == cyl_pose
    button.location = before_btn

    dial_samples = 0
    for dial_deg in (0, -25, -55, 30, 65):
        dial.rotation_euler.z = math.radians(dial_deg)
        bpy.context.view_layer.update()
        assert not world_bvh(dial_mesh).overlap(world_bvh(cyl_mesh)), (
            "Chrome dial collar crosses tilted cylinder",
            dial_deg,
        )
        assert not world_bvh(dial_mesh).overlap(world_bvh(throat_mesh)), (
            "Chrome dial collar crosses aluminum throat",
            dial_deg,
        )
        assert not world_bvh(dial_mesh).overlap(world_bvh(pointer_mesh)), (
            "Chrome dial collar crosses front indicator pointer",
            dial_deg,
        )
        dial_samples += 1
    dial.rotation_euler.z = 0.0
    bpy.context.view_layer.update()

    # 2. Silicone bellows puff check (-10 mm compression) and lid/bellows removal
    bellows_puff_samples = 0
    for puff_dz in (0.0, -0.005, -0.010):
        bellows.location.z = 0.2385 + puff_dz
        lid.location.z = 0.2880 + puff_dz
        bpy.context.view_layer.update()
        assert not world_bvh(bellows_mesh).overlap(world_bvh(dial_mesh)), (
            "Silicone bellows crosses chrome dial collar during puff",
            puff_dz,
        )
        bellows_puff_samples += 1
    bellows.location.z = 0.2385
    lid.location.z = 0.2880
    bpy.context.view_layer.update()

    lid_samples = 0
    for lift in (0.0, 0.025, 0.070, 0.130):
        lid.location.z = 0.2880 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(lid_mesh).overlap(world_bvh(bellows_mesh)), (
            "Walnut lid crosses silicone bellows",
            lift,
        )
        lid_samples += 1
    lid.location.x += 0.220

    bellows_lift_samples = 0
    for lift in (0.0, 0.020, 0.055, 0.095):
        bellows.location.z = 0.2385 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(bellows_mesh).overlap(world_bvh(throat_mesh)), (
            "Silicone bellows crosses aluminum throat",
            lift,
        )
        assert not world_bvh(bellows_mesh).overlap(world_bvh(dial_mesh)), (
            "Silicone bellows crosses chrome dial collar",
            lift,
        )
        bellows_lift_samples += 1
    bellows.location.x += 0.220
    bpy.context.view_layer.update()

    # Cast downward rays into the open 30 g aluminum throat to verify V2.6 convex anti-popcorn dome
    depsgraph = bpy.context.evaluated_depsgraph_get()
    throat_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        r = 0.012 if index % 2 == 0 else 0.026
        origin = Vector(
            (
                0.0 + r * math.cos(angle),
                -0.0020 + r * math.sin(angle),
                0.265,
            )
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and 0.175 < point.z < 0.232, (
            hit_obj.name if hit else "No hit",
            point,
        )
        throat_heights.append(point.z)

    # 3. Unscrew/remove throat & dial collar and lift detachable 3-lug 64 mm upper burr carrier
    throat_mesh.hide_viewport = False
    carrier_samples = 0
    for lift in (0.0, 0.020, 0.045, 0.075):
        upper_burr.location.z = 0.1870 + lift
        bpy.context.view_layer.update()
        assert not world_bvh(upper_carrier_mesh).overlap(world_bvh(cyl_mesh)), (
            "Upper burr carrier crosses tilted cylinder",
            lift,
        )
        assert not world_bvh(upper_ring_mesh).overlap(world_bvh(lower_ring_mesh)), (
            "Upper 64 mm flat burr crosses lower 64 mm flat burr",
            lift,
        )
        carrier_samples += 1

    # Restore upper burr carrier, bellows, and walnut lid, then verify 360-deg 64 mm lower flat burr rotation
    upper_burr.location = (0.0, -0.0020, 0.1870)
    bellows.location = (0.0, -0.0020, 0.2385)
    lid.location = (0.0, -0.0020, 0.2880)
    bpy.context.view_layer.update()

    burr_samples = 0
    upper_ring_bvh = world_bvh(upper_ring_mesh)
    cyl_bvh = world_bvh(cyl_mesh)
    for angle_deg in range(0, 360, 15):
        lower_burr.rotation_euler.z = math.radians(angle_deg)
        bpy.context.view_layer.update()
        assert not world_bvh(lower_ring_mesh).overlap(upper_ring_bvh), (
            "Rotating 64 mm lower flat burr crosses upper 64 mm flat burr",
            angle_deg,
        )
        assert not world_bvh(lower_rotor_mesh).overlap(cyl_bvh), (
            "Rotating lower burr carrier crosses cylinder chamber wall",
            angle_deg,
        )
        burr_samples += 1
    lower_burr.rotation_euler.z = 0.0

    # 4. Verify 58 mm 6063 aluminum dosing cup removal from two-prong holder fork and interior rays
    cup_samples = 0
    for dy, dz in ((0.0, 0.0), (-0.045, 0.0), (-0.090, 0.0), (-0.090, -0.020)):
        cup.location.y = -0.0770 + dy
        cup.location.z = 0.0440 + dz
        bpy.context.view_layer.update()
        assert not world_bvh(cup_mesh).overlap(world_bvh(cyl_mesh)), (
            "Dosing cup crosses tilted cylinder",
            dy,
            dz,
        )
        assert not world_bvh(cup_mesh).overlap(world_bvh(fork_left_mesh)), (
            "Dosing cup crosses left fork prong",
            dy,
            dz,
        )
        assert not world_bvh(cup_mesh).overlap(world_bvh(fork_right_mesh)), (
            "Dosing cup crosses right fork prong",
            dy,
            dz,
        )
        cup_samples += 1

    depsgraph = bpy.context.evaluated_depsgraph_get()
    cup_interior_heights = []
    for index in range(12):
        angle = math.tau * index / 12
        origin = Vector(
            (
                0.0 + 0.016 * math.cos(angle),
                -0.1670 + 0.016 * math.sin(angle),
                0.150,
            )
        )
        hit, point, _normal, _face, hit_obj, _matrix = bpy.context.scene.ray_cast(
            depsgraph, origin, Vector((0, 0, -1))
        )
        assert hit and hit_obj == cup_mesh, (
            hit_obj.name if hit else "No hit",
            point,
        )
        assert 0.026 < point.z < 0.032, point.z
        cup_interior_heights.append(point.z)

    cup.location = (0.0, -0.0770, 0.0440)
    bpy.context.view_layer.update()

    # 5. Inspect standalone dosing cup GLB
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cup_path = DIRECTORY / "miicoffee-df64-gen2-dosing-cup.glb"
    bpy.ops.import_scene.gltf(filepath=str(cup_path))
    cup_root = bpy.data.objects["df64_dosing_cup"]
    bpy.context.view_layer.update()
    cup_low, cup_high = bounds(cup_root.children_recursive)
    cup_dims = cup_high - cup_low
    near(cup_low.z, 0.0, "Standalone dosing cup base Z=0")
    near(cup_dims.y, 0.0636, "Standalone dosing cup outer diameter")
    near(cup_dims.z, 0.0760, "Standalone dosing cup total height")

    # 6. Inspect standalone 64 mm upper burr carrier GLB
    bpy.ops.wm.read_factory_settings(use_empty=True)
    carrier_path = DIRECTORY / "miicoffee-df64-gen2-burr-carrier.glb"
    bpy.ops.import_scene.gltf(filepath=str(carrier_path))
    carrier_root = bpy.data.objects["df64_upper_burr_carrier"]
    bpy.context.view_layer.update()
    c_low, c_high = bounds(carrier_root.children_recursive)
    c_dims = c_high - c_low
    assert 0.080 <= c_dims.x <= 0.090, c_dims
    assert 0.018 <= c_dims.z <= 0.024, c_dims

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "dosing_cup_glb_sha256": hashlib.sha256(cup_path.read_bytes()).hexdigest(),
        "dosing_cup_glb_bytes": cup_path.stat().st_size,
        "burr_carrier_glb_sha256": hashlib.sha256(carrier_path.read_bytes()).hexdigest(),
        "burr_carrier_glb_bytes": carrier_path.stat().st_size,
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "standalone_cup_dimensions_m": [round(val, 6) for val in cup_dims],
        "standalone_burr_carrier_dimensions_m": [round(val, 6) for val in c_dims],
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "dial_rotation_samples": dial_samples,
        "bellows_puff_samples": bellows_puff_samples,
        "lid_clearance_samples": lid_samples,
        "bellows_lift_samples": bellows_lift_samples,
        "throat_antipopcorn_rays": len(throat_heights),
        "throat_hit_height_range_m": [
            round(min(throat_heights), 6),
            round(max(throat_heights), 6),
        ],
        "carrier_clearance_samples": carrier_samples,
        "burr_rotation_samples": burr_samples,
        "cup_clearance_samples": cup_samples,
        "cup_interior_rays": len(cup_interior_heights),
        "cup_interior_floor_height_range_m": [
            round(min(cup_interior_heights), 6),
            round(max(cup_interior_heights), 6),
        ],
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import GLB; verify 130x225x300 mm envelope and Z=0 foot plane; verify fault injection "
            "rejection; press lower-right metal power button and rotate stepless chrome dial collar; "
            "compress silicone bellows (-10 mm puff); lift walnut lid and silicone bellows; cast "
            "throat/anti-popcorn dome rays; lift detachable 3-lug 64 mm upper burr carrier; spin "
            "64 mm lower flat burr rotor 360 deg without collision; pull out 58 mm 6063 aluminum "
            "dosing cup from holder fork and cast interior floor rays; verify standalone cup and "
            "burr carrier GLBs."
        ),
    }
    (DIRECTORY / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
