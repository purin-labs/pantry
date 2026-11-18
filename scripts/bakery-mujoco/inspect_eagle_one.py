"""Inspect the exported Eagle One visual study and exercise the dimension checker."""

import hashlib
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_induction import bounds
from inspect_mesh_quality import inspect_loaded
from build_linea_classic_s_visuals import studio
from build_oven_visuals import look_at

ROOT = Path(__file__).resolve().parents[2]
NAME = "victoria-arduino-eagle-one-2g"
OUT = ROOT / "assets/bakery-mujoco" / NAME
REQUIRED = {
    "left sculpted chrome group",
    "right sculpted chrome group",
    "Touchscreen glass",
    "left cool touch wand",
    "right cool touch wand",
    "Drip basin",
    "Rear brushed panel",
    "Cup warmer perforated sheet",
    "Raised two-tier cup shelf",
    "Rear eagle emblem",
}


def check_dimensions(root):
    excluded = set()
    for side in ("left", "right"):
        portafilter = bpy.data.objects["eo_" + side + "_portafilter"]
        excluded.update([portafilter, *portafilter.children_recursive])
    low, high = bounds(obj for obj in root.children_recursive if obj not in excluded)
    measured = list(high - low)
    # Manufacturer current product page, width/depth/height, tolerance 2 mm.
    errors = [
        axis
        for axis, actual, expected in zip("XYZ", measured, (0.758, 0.576, 0.437))
        if abs(actual - expected) > 0.002
    ]
    return measured, errors


def inspect_top_openings():
    graph = bpy.context.evaluated_depsgraph_get()
    probes = []
    for ix, iy in [(5, 6), (12, 8), (19, 10)]:
        x = -0.338 + (ix + 0.5) * 0.676 / 24
        y = 0.061 - 0.367 / 2 + (iy + 0.5) * 0.367 / 14
        hit, point, _, _, obj, _ = bpy.context.scene.ray_cast(
            graph, Vector((x, y, 0.46)), Vector((0, 0, -1))
        )
        clear = not hit or point.z < 0.410
        probes.append(
            {
                "xy": [x, y],
                "clear": clear,
                "hit": obj.name if hit else None,
                "hit_z": point.z if hit else None,
            }
        )
    return probes


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = OUT / (NAME + ".glb")
    bpy.ops.import_scene.gltf(filepath=str(source))
    root = bpy.data.objects[NAME]
    bpy.context.view_layer.update()
    measured, errors = check_dimensions(root)
    quality = inspect_loaded(REQUIRED)
    openings = inspect_top_openings()
    assert all(p["clear"] for p in openings), "Blocked cup-warmer opening"
    x, y = openings[0]["xy"]
    bpy.ops.mesh.primitive_cube_add(size=0.008, location=(x, y, 0.422))
    blocker = bpy.context.object
    bpy.context.view_layer.update()
    assert not inspect_top_openings()[0]["clear"], "Blocked-hole fault was not detected"
    bpy.data.objects.remove(blocker, do_unlink=True)
    bpy.context.view_layer.update()
    assert all(p["clear"] for p in inspect_top_openings())
    original = root.scale.copy()
    root.scale.x *= 1.02
    bpy.context.view_layer.update()
    _, injected = check_dimensions(root)
    assert "X" in injected, "Width fault was not detected"
    root.scale = original
    bpy.context.view_layer.update()
    assert check_dimensions(root)[1] == errors
    report = {
        "passed": not errors and quality["passed"],
        "glb_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "reference_envelope_m": [0.758, 0.576, 0.437],
        "measured_envelope_m": measured,
        "tolerance_m": 0.002,
        "dimension_errors": errors,
        "top_opening_probes": openings,
        "checker_validation": {
            "injected_width_scale": 1.02,
            "detected_axes": injected,
            "restored": True,
            "blocked_top_hole_detected": True,
        },
        "geometry": quality,
        "limits": [
            "Exterior visual study; panel contours and interfaces are photo-derived.",
            "Perforation pitch and panel contours are photo-derived; hole pattern is approximate.",
            "No calibrated joints, collision geometry, hydraulic model or manufacturing qualification.",
            "Depth conflict: older manual 586 mm; current manufacturer page 576 mm selected.",
        ],
    }
    (OUT / "inspection.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "geometry"}, indent=2))
    assert report["passed"], "Export inspection failed; inspect inspection.json"
    camera = studio()
    camera.location = (1, -1.5, 0.85)
    camera.data.ortho_scale = 1.08
    look_at(camera, (0, 0, 0.22))
    scene = bpy.context.scene
    scene.cycles.samples = 24
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 900
    scene.render.filepath = str(OUT / "export-review.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
