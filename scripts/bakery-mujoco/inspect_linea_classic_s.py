"""Inspect the actual Linea Classic S GLB and its saved Blender source."""

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

ROOT = Path(__file__).resolve().parents[2]
NAME = "la-marzocco-linea-classic-s-2g"
DIRECTORY = ROOT / "assets/bakery-mujoco" / NAME
REQUIRED = {
    "Cup support wire",
    "Cup symbol",
    "Front brand",
    "Rear brand",
    "Bent stainless steam wand",
    "Pressure gauge dial",
    "Cup tray slot bridge",
    "Portafilter hollow body",
}


def envelope(root, excluded):
    low, high = bounds(o for o in root.children_recursive if o not in excluded)
    return high - low


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = DIRECTORY / (NAME + ".glb")
    bpy.ops.import_scene.gltf(filepath=str(source))
    objects = bpy.data.objects
    root = objects["lcs_machine"]
    bpy.context.view_layer.update()
    excluded = set()
    for side in ("left", "right"):
        pf = objects[f"lcs_{side}_portafilter"]
        excluded.update([pf, *pf.children_recursive])
        assert pf.parent == root
        assert objects[f"lcs_{side}_basket"].parent == pf
        assert objects[f"lcs_{side}_steam_wand"].parent == root
    measured = envelope(root, excluded)
    for actual, expected in zip(measured, (0.693, 0.585, 0.522)):
        near(actual, expected, "Japanese envelope excluding removable portafilters")
    for side in ("left", "right"):
        front = objects[f"lcs_foot_{side}_front"]
        rear = objects[f"lcs_foot_{side}_rear"]
        near(rear.location.y - front.location.y, 0.359, "Foot pitch")
        near(bounds(front.children_recursive)[0].z, 0, "Foot support plane")
    near(
        objects["lcs_foot_right_front"].location.x
        - objects["lcs_foot_left_front"].location.x,
        0.538,
        "Front foot spacing",
    )
    # Slots must remain physically open after export. Probe between top strips.
    graph = bpy.context.evaluated_depsgraph_get()
    hits = []
    for x in (-0.28, -0.20, -0.12, -0.04, 0.04, 0.12, 0.20, 0.28):
        hit, point, normal, index, obj, matrix = bpy.context.scene.ray_cast(
            graph, Vector((x, 0.10, 0.56)), Vector((0, 0, -1))
        )
        assert not hit or point.z < 0.49, (
            "Blocked cup-tray slot",
            x,
            obj.name if hit else None,
        )
        hits.append({"x": x, "hit_z": point.z if hit else None})
    quality = inspect_loaded(REQUIRED)
    report = {
        "status": "passed" if quality["passed"] else "failed",
        "glb_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "body_envelope_m": list(measured),
        "reference_envelope_m": [0.693, 0.585, 0.522],
        "envelope_tolerance_m": 0.001,
        "foot_spacing_m": [0.538, 0.359],
        "top_slot_probes": hits,
        "geometry": quality,
        "scope": "Exported geometry, named parts, external envelope and open slots. No calibrated mechanism or physics qualification.",
    }
    # Validate the envelope check with an isolated 2% width error, then restore.
    original = root.scale.copy()
    root.scale.x *= 1.02
    bpy.context.view_layer.update()
    evidence = ROOT / "output/acceptance/linea-classic-s/20261017"
    evidence.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(evidence / "injected-width-error.blend"))
    report["injected_width_m"] = envelope(root, excluded).x
    try:
        near(envelope(root, excluded).x, 0.693, "Injected width error")
    except AssertionError:
        report["width_fault_detected"] = True
    else:
        raise AssertionError("Width fault was missed")
    root.scale = original
    bpy.context.view_layer.update()
    near(envelope(root, excluded).x, 0.693, "Corrected width")
    bpy.ops.wm.open_mainfile(filepath=str(DIRECTORY / (NAME + ".blend")))
    assert sum(bool(i.packed_file) for i in bpy.data.images) == 5
    bpy.context.scene.frame_set(36)
    near(
        bpy.data.objects["lcs_left_portafilter"].rotation_euler.z,
        math.radians(-35),
        "Saved release preview",
    )
    bpy.context.scene.frame_set(1)
    report["source_sha256"] = hashlib.sha256(
        (DIRECTORY / (NAME + ".blend")).read_bytes()
    ).hexdigest()
    report["packed_references"] = 5
    (DIRECTORY / "inspection-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    if not quality["passed"]:
        print(json.dumps([p for p in quality["parts"] if p["errors"]], indent=2))
        raise RuntimeError("Export geometry inspection failed")
    print(json.dumps({k: v for k, v in report.items() if k != "geometry"}, indent=2))


if __name__ == "__main__":
    main()
