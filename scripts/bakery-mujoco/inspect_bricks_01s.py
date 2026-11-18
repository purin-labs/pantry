"""Verify the exported TIMEMORE Bricks 01S GLB and Blender source."""

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_mesh_quality import inspect_loaded

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/timemore-bricks-01s"
GLB = ASSETS / "timemore-bricks-01s.glb"
CUP_GLB = ASSETS / "timemore-bricks-01s-cup.glb"
CARRIER_GLB = ASSETS / "timemore-bricks-01s-burr-carrier.glb"
BLEND = ASSETS / "timemore-bricks-01s.blend"

CHAMBER_AXIS_Y = -0.0020
CHUTE_AXIS_Y = -0.0360


def world_bounds(objects):
    low = Vector((math.inf, math.inf, math.inf))
    high = Vector((-math.inf, -math.inf, -math.inf))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        for vertex in mesh.vertices:
            point = evaluated.matrix_world @ vertex.co
            low.x = min(low.x, point.x)
            low.y = min(low.y, point.y)
            low.z = min(low.z, point.z)
            high.x = max(high.x, point.x)
            high.y = max(high.y, point.y)
            high.z = max(high.z, point.z)
        evaluated.to_mesh_clear()
    return low, high


def tree_for(objects):
    vertices = []
    polygons = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        start = len(vertices)
        for vertex in mesh.vertices:
            vertices.append(evaluated.matrix_world @ vertex.co)
        for triangle in mesh.loop_triangles:
            polygons.append(tuple(start + index for index in triangle.vertices))
        evaluated.to_mesh_clear()
    return BVHTree.FromPolygons(vertices, polygons)


def descendants(node):
    return [node, *node.children_recursive]


def verify_envelope_bounds(low, high, tol=0.0005):
    size = high - low
    return (
        abs(size.x - 0.102) < tol
        and abs(size.y - 0.150) < tol
        and abs(size.z - 0.286) < tol
        and abs(low.z) < 0.0004
    )


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(GLB))
    bpy.context.view_layer.update()

    required_nodes = (
        "bricks_grinder",
        "bricks_hopper",
        "bricks_hopper_lid",
        "bricks_burr_carrier",
        "bricks_burr_cone",
        "bricks_knocker",
        "bricks_power_button",
        "bricks_dosing_cup",
        "bricks_power_lead",
        "bricks_foot_fl",
        "bricks_foot_fr",
        "bricks_foot_rl",
        "bricks_foot_rr",
    )
    for name in required_nodes:
        assert name in bpy.data.objects, f"Missing required node: {name}"

    required_meshes = (
        "Anodised cantilever base plate",
        "Magnetic catch-cup pad",
        "Vertical support column",
        "Upper cubic chamber housing",
        "Front discharge chute housing",
        "Top red grind index marker",
        "Side brew guide label",
        "Rotary fines knocker ring",
        "Knocker stainless spout rim",
        "Power button chrome bezel",
        "Power push button cap",
        "S2C-040-EI outer burr carrier",
        "Burr carrier wire bail handle",
        "S2C-040-EI conical burr",
        "Rotatable 2-way bean hopper dial",
        "Magnetic hopper top lid",
        "Magnetic dosing catch cup",
        "Dosing cup magnetic base",
        "Stowed power cable",
    )
    for name in required_meshes:
        assert name in bpy.data.objects, f"Missing required mesh: {name}"

    inspect_loaded(set(required_meshes))

    root = bpy.data.objects["bricks_grinder"]
    hopper = bpy.data.objects["bricks_hopper"]
    lid = bpy.data.objects["bricks_hopper_lid"]
    carrier = bpy.data.objects["bricks_burr_carrier"]
    cone = bpy.data.objects["bricks_burr_cone"]
    knocker = bpy.data.objects["bricks_knocker"]
    power_btn = bpy.data.objects["bricks_power_button"]
    cup = bpy.data.objects["bricks_dosing_cup"]
    lead = bpy.data.objects["bricks_power_lead"]

    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    lead_meshes = set(descendants(lead))
    body_meshes = [obj for obj in meshes if obj not in lead_meshes]

    low, high = world_bounds(body_meshes)
    size = high - low
    assert verify_envelope_bounds(low, high), (
        f"Body envelope mismatch: size={tuple(round(v, 5) for v in size)}, low.z={low.z:.5f}"
    )

    # Fault injection check
    faulty_high = Vector((high.x + 0.005, high.y, high.z))
    assert not verify_envelope_bounds(low, faulty_high), (
        "Fault injection check failed to reject perturbed width"
    )

    # Verify all 4 silicone feet touch Z = 0
    for foot_name in (
        "bricks_foot_fl",
        "bricks_foot_fr",
        "bricks_foot_rl",
        "bricks_foot_rr",
    ):
        foot_low, foot_high = world_bounds(descendants(bpy.data.objects[foot_name]))
        assert abs(foot_low.z) < 0.0003, f"{foot_name} does not touch Z=0: {foot_low.z}"
        assert foot_high.z >= 0.0018, f"{foot_name} too thin: {foot_high.z}"

    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangle_count = 0
    for obj in meshes:
        assert obj.data.materials, f"Missing material on {obj.name}"
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangle_count += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()

    chamber_housing_tree = tree_for(
        [
            bpy.data.objects["Upper cubic chamber housing"],
            bpy.data.objects["Front discharge chute housing"],
            bpy.data.objects["Vertical support column"],
            bpy.data.objects["Anodised cantilever base plate"],
        ]
    )

    # 1. Hopper lid lift & hopper dial rotation + vertical removal clearance
    lid_origin = lid.location.copy()
    hopper_origin = hopper.location.copy()
    hopper_samples = 0
    for dz_lid in (0.0, 0.015, 0.045, 0.085):
        lid.location = lid_origin + Vector((0.0, 0.0, dz_lid))
        bpy.context.view_layer.update()
        assert not chamber_housing_tree.overlap(tree_for(descendants(lid))), (
            f"Hopper lid crosses chamber housing at dz={dz_lid}"
        )
    lid.location = lid_origin + Vector((0.0, 0.0, 0.095))
    for angle_deg, dz_hop in (
        (0, 0.0),
        (72, 0.0),
        (180, 0.0),
        (360, 0.0),
        (360, 0.015),
        (360, 0.045),
        (360, 0.085),
    ):
        hopper.rotation_euler = (0.0, 0.0, math.radians(angle_deg))
        hopper.location = hopper_origin + Vector((0.0, 0.0, dz_hop))
        bpy.context.view_layer.update()
        assert not chamber_housing_tree.overlap(tree_for(descendants(hopper))), (
            "Hopper dial crosses chamber housing",
            angle_deg,
            dz_hop,
        )
        hopper_samples += 1

    # 2. Lift upper outer burr carrier while hopper is lifted
    hopper.location = hopper_origin + Vector((0.0, 0.0, 0.090))
    carrier_origin = carrier.location.copy()
    cone_tree = tree_for(descendants(cone))
    carrier_samples = 0
    for dz in (0.0, 0.015, 0.035, 0.065):
        carrier.location = carrier_origin + Vector((0.0, 0.0, dz))
        bpy.context.view_layer.update()
        carrier_tree = tree_for(descendants(carrier))
        assert not chamber_housing_tree.overlap(carrier_tree), (
            f"Burr carrier crosses housing at dz={dz}"
        )
        assert not cone_tree.overlap(carrier_tree), (
            f"Burr carrier crosses conical burr at dz={dz}"
        )
        carrier_samples += 1

    # 3. Cast downward rays into open grind chamber onto S2C-040-EI conical burr
    carrier.location = carrier_origin + Vector((0.0, 0.0, 0.075))
    bpy.context.view_layer.update()
    open_chamber_tree = tree_for(
        [
            bpy.data.objects["Upper cubic chamber housing"],
            *descendants(cone),
        ]
    )
    chamber_hits = []
    for r in (0.004, 0.010, 0.016):
        for deg in (0, 90, 180, 270):
            rad = math.radians(deg)
            origin = Vector(
                (r * math.cos(rad), CHAMBER_AXIS_Y + r * math.sin(rad), 0.250)
            )
            hit, _, _, _ = open_chamber_tree.ray_cast(origin, Vector((0, 0, -1)), 0.12)
            assert hit is not None, f"Missed open grind chamber at r={r}, deg={deg}"
            chamber_hits.append(hit.z)

    carrier.location = carrier_origin
    hopper.location = hopper_origin
    hopper.rotation_euler = (0.0, 0.0, 0.0)
    lid.location = lid_origin
    bpy.context.view_layer.update()

    # 4. Conical burr 360 deg rotation clearance
    carrier_tree_seated = tree_for(descendants(carrier))
    burr_samples = 0
    for step in range(24):
        cone.rotation_euler = (0.0, 0.0, step * math.tau / 24)
        bpy.context.view_layer.update()
        ct = tree_for(descendants(cone))
        assert not carrier_tree_seated.overlap(ct), (
            f"Conical burr hits outer burr carrier at step {step}"
        )
        assert not chamber_housing_tree.overlap(ct), (
            f"Conical burr hits chamber housing at step {step}"
        )
        burr_samples += 1
    cone.rotation_euler = (0.0, 0.0, 0.0)

    # 5. Rotary fines knocker & side power button actuation
    for deg in (-45, 0, 45, 90):
        knocker.rotation_euler = (0.0, 0.0, math.radians(deg))
        bpy.context.view_layer.update()
        assert not chamber_housing_tree.overlap(tree_for(descendants(knocker))), (
            f"Rotary knocker overlaps chute housing at deg={deg}"
        )
    knocker.rotation_euler = (0.0, 0.0, 0.0)

    btn_origin = power_btn.location.copy()
    for dx in (0.0, -0.0007, -0.0014):
        power_btn.location = btn_origin + Vector((dx, 0.0, 0.0))
        bpy.context.view_layer.update()
        assert not chamber_housing_tree.overlap(tree_for(descendants(power_btn))), (
            f"Power button overlaps column at dx={dx}"
        )
    power_btn.location = btn_origin

    # 6. Magnetic dosing catch cup slide-out and interior ray checks
    cup_origin = cup.location.copy()
    knocker_tree = tree_for(descendants(knocker))
    cup_samples = 0
    for dy, dz in ((0.0, 0.0), (-0.025, 0.0), (-0.055, 0.0), (-0.065, 0.015)):
        cup.location = cup_origin + Vector((0.0, dy, dz))
        bpy.context.view_layer.update()
        ct = tree_for(descendants(cup))
        assert not chamber_housing_tree.overlap(ct), (
            "Dosing cup crosses base/column",
            dy,
            dz,
        )
        assert not knocker_tree.overlap(ct), ("Dosing cup crosses knocker", dy, dz)
        cup_samples += 1

    cup_tree = tree_for(descendants(cup))
    cup_floor_hits = []
    for r in (0.0, 0.008, 0.016):
        for deg in (0, 90, 180, 270):
            if r == 0.0 and deg > 0:
                continue
            rad = math.radians(deg)
            origin = Vector(
                (
                    r * math.cos(rad),
                    cup.location.y + r * math.sin(rad),
                    cup.location.z + 0.095,
                )
            )
            hit, _, _, _ = cup_tree.ray_cast(origin, Vector((0, 0, -1)), 0.12)
            assert hit is not None, f"Dosing cup interior ray missed floor at r={r}"
            assert cup.location.z + 0.008 < hit.z < cup.location.z + 0.020, (
                f"Unexpected cup floor hit height: {hit.z}"
            )
            cup_floor_hits.append(hit.z)
    cup.location = cup_origin
    bpy.context.view_layer.update()

    # 7. Standalone accessory GLBs
    accessories = []
    for acc_path, root_name, expected_w in (
        (CUP_GLB, "bricks_dosing_cup", 0.046),
        (CARRIER_GLB, "bricks_burr_carrier", 0.057),
    ):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(acc_path))
        bpy.context.view_layer.update()
        assert root_name in bpy.data.objects, f"Missing root {root_name} in {acc_path.name}"
        alow, ahigh = world_bounds(bpy.context.scene.objects)
        asize = ahigh - alow
        assert abs(asize.x - expected_w) < 0.002, (
            f"Accessory {acc_path.name} width mismatch: {asize.x} vs {expected_w}"
        )
        accessories.append(
            {
                "file": acc_path.name,
                "sha256": hashlib.sha256(acc_path.read_bytes()).hexdigest(),
                "dimensions_m": [round(v, 5) for v in asize],
            }
        )

    # 8. Saved .blend file verification
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
    packed = [img.name for img in bpy.data.images if img.packed_file is not None]
    assert len(packed) >= 5, f"Expected >=5 packed reference images, found {len(packed)}"
    assert bpy.data.objects["bricks_hopper"].animation_data is not None
    assert bpy.data.objects["bricks_burr_cone"].animation_data is not None

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(GLB.read_bytes()).hexdigest(),
        "glb_bytes": GLB.stat().st_size,
        "body_dimensions_m": [round(value, 5) for value in size],
        "mesh_count": len(meshes),
        "triangle_count": triangle_count,
        "hopper_clearance_samples": hopper_samples,
        "carrier_clearance_samples": carrier_samples,
        "chamber_access_rays": len(chamber_hits),
        "chamber_access_hit_height_range_m": [
            round(min(chamber_hits), 6),
            round(max(chamber_hits), 6),
        ],
        "burr_rotation_samples": burr_samples,
        "cup_clearance_samples": cup_samples,
        "cup_interior_rays": len(cup_floor_hits),
        "cup_interior_floor_height_range_m": [
            round(min(cup_floor_hits), 6),
            round(max(cup_floor_hits), 6),
        ],
        "envelope_fault_injection_rejected": True,
        "accessory_exports": accessories,
        "saved_source": {
            "sha256": hashlib.sha256(BLEND.read_bytes()).hexdigest(),
            "packed_references": len(packed),
            "access_animation": "passed",
        },
    }
    (ASSETS / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
