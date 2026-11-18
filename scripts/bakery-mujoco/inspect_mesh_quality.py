"""Inspect actual appliance GLBs in Blender and retain per-part geometry evidence.

Run with -- --output DIRECTORY --baseline-ref COMMIT [--appliance NAME].
Open boundaries are reported, not rejected: decals and sheet parts are intentional.
This inspection does not qualify wall thickness or manufacturing tolerances.
"""

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
from collections import Counter
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_rust_appliances import PROGRAMS, ROOT
from inspect_quiet_one import inspect_cover, separated


def inspect_mesh(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        points = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
        finite = all(math.isfinite(value) for point in points for value in point)
        # glTF splits vertices at UV and normal seams. Weld only for topology
        # inspection, at 10 nm; never modify the production geometry.
        keys = [tuple(round(value, 8) for value in point) for point in points]
        faces = Counter()
        edges = Counter()
        collapsed = []
        for triangle in mesh.loop_triangles:
            indices = tuple(triangle.vertices)
            a, b, c = [points[index] for index in indices]
            if (b - a).cross(c - a).length <= 1e-16:
                collapsed.append(triangle.index)
            vertices = [keys[index] for index in indices]
            faces[tuple(sorted(vertices))] += 1
            for first, second in zip(vertices, vertices[1:] + vertices[:1]):
                edges[tuple(sorted((first, second)))] += 1
        duplicates = sum(count - 1 for count in faces.values() if count > 1)
        errors = []
        if not finite:
            errors.append("nonfinite-coordinate")
        if not mesh.polygons:
            errors.append("empty-mesh")
        if not mesh.materials or any(material is None for material in mesh.materials):
            errors.append("missing-material")
        if collapsed:
            errors.append("zero-area-triangle")
        if duplicates:
            errors.append("duplicate-triangle")
        return {
            "name": obj.name,
            "triangles": len(mesh.loop_triangles),
            "errors": errors,
            "zero_area_triangles": collapsed,
            "duplicate_triangles": duplicates,
            "boundary_edges": sum(count == 1 for count in edges.values()),
            "nonmanifold_edges": sum(count > 2 for count in edges.values()),
        }
    finally:
        evaluated.to_mesh_clear()


def inspect_loaded(required_names):
    bpy.context.view_layer.update()
    parts = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            parts.append(inspect_mesh(obj))
    missing = sorted(required_names - {part["name"] for part in parts})
    return {
        "passed": bool(parts)
        and not missing
        and all(not part["errors"] for part in parts),
        "missing_parts": missing,
        "meshes": len(parts),
        "triangles": sum(part["triangles"] for part in parts),
        "parts": parts,
    }


def inspect_file(source, required_names):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    result = inspect_loaded(required_names)
    result["glb_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    return result


def baseline_parts(revision, source):
    relative = source.relative_to(ROOT).as_posix()
    data = subprocess.run(
        ["git", "show", f"{revision}:{relative}"],
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError(f"Expected a version 2 GLB in {revision}:{relative}")
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + length])
    names = {node["name"] for node in document["nodes"] if "mesh" in node}
    if not names:
        raise ValueError(f"Baseline has no named meshes: {relative}")
    return names, hashlib.sha256(data).hexdigest()


def validate_checker(source, output):
    # Each fault uses the imported real appliance. Restore its mesh after each
    # check. Save the faulty Blender input for independent examination.
    inspect_file(source, set())
    obj = bpy.data.objects["Clear front and roof shell"]
    original = obj.data
    cases = []
    for fault in ("missing-material", "zero-area-triangle", "duplicate-triangle"):
        obj.data = original.copy()
        if fault == "missing-material":
            obj.data.materials.clear()
        else:
            points = [tuple(vertex.co) for vertex in original.vertices]
            faces = [tuple(face.vertices) for face in original.polygons]
            if fault == "zero-area-triangle":
                points.extend([points[0], points[0], points[0]])
                faces.append(tuple(range(len(points) - 3, len(points))))
            else:
                faces.append(faces[0])
            obj.data.clear_geometry()
            obj.data.from_pydata(points, [], faces)
        bpy.context.view_layer.update()
        bpy.ops.wm.save_as_mainfile(filepath=str(output / f"fault-{fault}.blend"))
        result = inspect_mesh(obj)
        assert fault in result["errors"], (fault, result)
        cases.append({"injected": fault, "detected_part": obj.name, "result": result})
        faulty = obj.data
        obj.data = original
        bpy.data.meshes.remove(faulty)
    corrected = inspect_mesh(obj)
    assert not corrected["errors"], corrected
    collections = list(obj.users_collection)
    for collection in collections:
        collection.objects.unlink(obj)
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "fault-missing-part.blend"))
    missing = inspect_loaded({obj.name})
    assert missing["missing_parts"] == [obj.name] and not missing["passed"]
    cases.append({"injected": "missing-part", "detected_part": obj.name})
    for collection in collections:
        collection.objects.link(obj)
    assert not inspect_loaded({obj.name})["missing_parts"]
    interface_cases = validate_cover(obj, output)
    return {"cases": cases, "corrected": corrected, "cover_cases": interface_cases}


def validate_cover(shell, output):
    original = shell.data
    original_position = shell.location.copy()
    cases = []
    for fault in ("reversed-normal", "thick-wall", "blocked-removal"):
        shell.data = original.copy()
        if fault == "reversed-normal":
            shell.data.flip_normals()
            expected = "Cover outside normal"
        elif fault == "thick-wall":
            moved = 0
            for vertex in shell.data.vertices:
                world = shell.matrix_world @ vertex.co
                if abs(world.y + 0.1215) < 0.000001:
                    world.y += 0.001
                    vertex.co = shell.matrix_world.inverted() @ world
                    moved += 1
            assert moved > 0, "Expected inner front wall vertices"
            expected = "Cover wall"
        else:
            shell.location.y += 0.08
            expected = "Injected blocked removal"
        shell.data.update()
        bpy.context.view_layer.update()
        bpy.ops.wm.save_as_mainfile(filepath=str(output / f"fault-{fault}.blend"))
        try:
            if fault == "blocked-removal":
                separated(
                    shell, [bpy.data.objects["Hollow Advance container"]], expected
                )
            else:
                inspect_cover(shell)
        except AssertionError as error:
            assert expected in str(error), (fault, str(error))
            cases.append(
                {"injected": fault, "part": shell.name, "diagnostic": str(error)}
            )
        else:
            raise AssertionError(f"Checker missed {fault}")
        faulty = shell.data
        shell.data = original
        shell.location = original_position
        bpy.data.meshes.remove(faulty)
        bpy.context.view_layer.update()
        inspect_cover(shell)
        separated(
            shell, [bpy.data.objects["Hollow Advance container"]], "Corrected removal"
        )
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--appliance", choices=tuple(PROGRAMS))
    parser.add_argument("--baseline-ref", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    args.output.mkdir(parents=True, exist_ok=True)
    sources = ROOT / "assets/bakery-mujoco"
    revision = subprocess.run(
        [
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            args.baseline_ref + "^{commit}",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    validation = validate_checker(
        sources / "vitamix-quiet-one/vitamix-quiet-one.glb", args.output
    )
    reports = {}
    for name in [args.appliance] if args.appliance else PROGRAMS:
        filename = "ohaus-r31pe6" if name == "ohaus-ranger-3000" else name
        source = sources / name / f"{filename}.glb"
        required_names, baseline_digest = baseline_parts(revision, source)
        reports[name] = inspect_file(source, required_names)
        reports[name]["baseline_glb_sha256"] = baseline_digest
    result = {
        "passed": all(report["passed"] for report in reports.values()),
        "scope": "Evaluated exported meshes; topology counts are advisory for sheets and decals. No continuous collision or manufacture qualification.",
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cover_checker_sha256": hashlib.sha256(
            Path(__file__).with_name("inspect_quiet_one.py").read_bytes()
        ).hexdigest(),
        "baseline_commit": revision,
        "validation": validation,
        "appliances": reports,
    }
    (args.output / "mesh-quality.json").write_text(json.dumps(result, indent=2) + "\n")
    for name, report in reports.items():
        print(name, report["passed"], report["meshes"], report["triangles"])
        for part in report["parts"]:
            if part["errors"]:
                print(" ", part["name"], part["errors"])
    if not result["passed"]:
        raise RuntimeError("Mesh inspection failed; inspect mesh-quality.json")


if __name__ == "__main__":
    main()
