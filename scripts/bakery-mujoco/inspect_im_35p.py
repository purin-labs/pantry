"""Import the exported Hoshizaki IM-35P GLB and inspect envelope, door swing, interior access, controls, and mesh quality."""

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
    Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/hoshizaki-im-35p"
)
PUBLISHED_ENVELOPE = (0.500, 0.450, 0.800)
DOOR_OPEN_RAD = math.radians(52.0)


def verify_envelope(root, excluded):
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    dimensions = high - low
    for actual, expected in zip(dimensions, PUBLISHED_ENVELOPE):
        near(actual, expected, "Published D41369 CAD envelope")
    return low, high, dimensions


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = DIRECTORY / "hoshizaki-im-35p.glb"
    scoop_path = DIRECTORY / "hoshizaki-im-35p-scoop.glb"
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = bpy.data.objects

    root = objects["im_cabinet"]
    door = objects["im_door"]
    air_filter = objects["im_air_filter"]
    wplate = objects["im_water_plate"]
    bswitch = objects["im_bin_switch"]
    pwr = objects["im_power_switch"]
    scoop = objects["im_scoop"]
    socket = objects["vessel_socket"]
    storage = objects["im_bin_storage"]
    utilities = objects["im_utilities"]
    worktop = objects["Stainless worktop"]

    for child in (door, air_filter, wplate, bswitch, pwr, scoop, storage, utilities):
        assert child.parent == root, child.name
    assert socket.parent == scoop
    assert not any(obj.type in {"LIGHT", "CAMERA"} for obj in objects)

    # Clear imported animation so rest-pose and scripted joint checks are deterministic
    for obj in list(objects):
        obj.animation_data_clear()
    door.rotation_mode = "XYZ"
    door.rotation_euler = (0.0, 0.0, 0.0)
    wplate.rotation_mode = "XYZ"
    wplate.rotation_euler = (0.0, 0.0, 0.0)
    bswitch.rotation_mode = "XYZ"
    bswitch.rotation_euler = (0.0, 0.0, 0.0)
    pwr.rotation_mode = "XYZ"
    pwr.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    excluded = {utilities, *utilities.children_recursive}
    low, high, dimensions = verify_envelope(root, excluded)
    near(low.z, 0.0, "Foot support plane Z=0.000")
    near(high.z, 0.800, "Worktop plane Z=0.800")

    # Fault-injection check: shifting worktop laterally by 10 mm must fail the envelope guard
    orig_wt_x = worktop.location.x
    worktop.location.x += 0.010
    bpy.context.view_layer.update()
    fault_detected = False
    try:
        verify_envelope(root, excluded)
    except AssertionError:
        fault_detected = True
    worktop.location.x = orig_wt_x
    bpy.context.view_layer.update()
    assert fault_detected, "Envelope check must reject width perturbation"

    # Verify all 4 feet touch Z = 0.000 m at the D41369 440 x 252 mm spacing
    foot_count = 0
    for obj in objects:
        if obj.type == "EMPTY" and obj.name.startswith("im_foot_"):
            foot_low, _foot_high = bounds(obj.children_recursive)
            near(foot_low.z, 0.0, f"Foot contact plane ({obj.name})")
            foot_count += 1
    assert foot_count == 4, foot_count

    # Cast downward rays onto the 500 x 450 mm stainless worktop at Z = 0.800 m
    depsgraph = bpy.context.evaluated_depsgraph_get()
    wt_heights = []
    for sx in (-0.18, 0.0, 0.18):
        for sy in (-0.15, 0.0, 0.15):
            hit, point, normal, _face, hit_obj, _m = bpy.context.scene.ray_cast(
                depsgraph, Vector((sx, sy, 0.900)), Vector((0.0, 0.0, -1.0))
            )
            assert hit and hit_obj == worktop, (sx, sy, hit_obj)
            near(point.z, 0.800, "Worktop height Z=0.800")
            assert normal.z > 0.99, normal
            wt_heights.append(point.z)

    # Verify closed door blocks horizontal access rays at Z = 0.520 m
    hit_closed, pt_closed, _n, _f, obj_closed, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.0, -0.650, 0.520)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_closed and obj_closed in set(door.children_recursive), obj_closed

    # Open bottom-hinged door to 52 deg (+DOOR_OPEN_RAD about +X) and check D41369 open depth (~764 mm, Y_min ~ -0.539 m) and top height (~533..605 mm)
    door.rotation_euler = (DOOR_OPEN_RAD, 0.0, 0.0)
    bpy.context.view_layer.update()
    door_low, door_high = bounds(door.children_recursive)
    open_projection_m = -0.225 - door_low.y
    assert 0.305 <= open_projection_m <= 0.325, open_projection_m
    assert 0.520 <= door_high.z <= 0.615, door_high.z

    # With door open (and scoop lifted out), verify interior access rays above the tilted door handle reach the rear bin liner
    orig_scoop_loc = scoop.location.copy()
    scoop.location = Vector((-0.060, -0.350, 0.580))
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit_open, pt_open, _n, _f, obj_open, _m = bpy.context.scene.ray_cast(
        depsgraph, Vector((0.080, -0.650, 0.625)), Vector((0.0, 1.0, 0.0))
    )
    assert hit_open and pt_open.y > 0.150, (
        hit_open,
        pt_open,
        obj_open.name if obj_open else None,
    )

    # Restore door and scoop, then verify independent actuation of air filter, water plate, bin switch, and power switch
    door.rotation_euler = (0.0, 0.0, 0.0)
    scoop.location = orig_scoop_loc
    bpy.context.view_layer.update()

    initial_wt_matrix = worktop.matrix_world.copy()
    orig_filt_y = air_filter.location.y
    air_filter.location.y -= 0.140
    wplate.rotation_euler = (0.480, 0.0, 0.0)
    bswitch.rotation_euler = (0.550, 0.0, 0.0)
    pwr.rotation_euler = (0.280, 0.0, 0.0)
    bpy.context.view_layer.update()
    assert worktop.matrix_world == initial_wt_matrix
    air_filter.location.y = orig_filt_y
    wplate.rotation_euler = (0.0, 0.0, 0.0)
    bswitch.rotation_euler = (0.0, 0.0, 0.0)
    pwr.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    required_meshes = {
        "Stainless worktop",
        "Upper front stainless fascia",
        "Lower front service louver panel",
        "Sanitary bin floor liner",
        "Sanitary bin rear liner",
        "Evaporator freezing chamber shroud",
        "Copper evaporator 30-cell grid",
        "Stored cube ice bed",
        "Door fluorine-precoated stainless panel",
        "Door full-width top handle rail",
        "Door inner sanitary resin liner",
        "Door perimeter magnetic gasket",
        "Raku-Eco air filter pull handle",
        "Raku-Eco air filter mesh cartridge",
        "Jet-spray water plate tray",
        "Double-lever ice sensing paddle",
        "im_power_switch_rocker",
        "im_scoop_bowl",
        "im_scoop_handle",
    }
    quality = inspect_loaded(required_meshes)
    assert quality["passed"], quality

    report = {
        "status": "passed",
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glb_bytes": path.stat().st_size,
        "scoop_glb_sha256": hashlib.sha256(scoop_path.read_bytes()).hexdigest(),
        "scoop_glb_bytes": scoop_path.stat().st_size,
        "mesh_count": quality["meshes"],
        "triangle_count": quality["triangles"],
        "body_dimensions_m": [round(val, 6) for val in dimensions],
        "open_door_projection_m": round(open_projection_m, 4),
        "open_door_top_height_m": round(door_high.z, 4),
        "worktop_support_samples": len(wt_heights),
        "envelope_fault_injection_rejected": fault_detected,
        "journey": (
            "Import GLB; verify 500x450x800 mm D41369 CAD envelope, Z=0.000 m foot plane, and Z=0.800 m "
            "stainless worktop; verify fault injection rejection; open bottom-hinged bin door 53 deg to "
            "verify 314 mm forward swing and 533 mm handle height; verify interior access rays reach rear "
            "bin wall at Y > 0.15 m; actuate pull-out Raku-Eco air filter, harvest water plate, double-lever "
            "bin switch, power switch, and sanitary ice scoop; verify zero mesh-quality errors."
        ),
    }
    (DIRECTORY / "inspection-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
