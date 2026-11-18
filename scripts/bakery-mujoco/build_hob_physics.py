"""Export both saved induction hobs and a standard 200 mm pan for MuJoCo."""

import hashlib
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_mixer_visuals import lathe
from build_oven_visuals import (
    convert_curves,
    empty,
    export_visual_meshes,
    material,
    tube,
)

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco"


def export_hob(directory, root_name):
    source = directory / (directory.name + ".blend")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    root = bpy.data.objects[root_name]
    for obj in list(root.children_recursive):
        if obj.type != "MESH":
            continue
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = root
        obj.matrix_world = pose
    bpy.context.view_layer.update()
    export_visual_meshes((root,), directory)
    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "scope": "Saved visual surfaces. Provisional contact geometry and physical parameters are in hob.xml.",
    }
    (directory / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def export_pan():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root = empty("ih_pan", (0, 0, 0))
    steel = material("ih_pan_steel", (0.55, 0.59, 0.61, 1), 0.8, 0.27)
    black = material("ih_pan_grip", (0.028, 0.030, 0.035, 1), 0, 0.6)
    lathe(
        "Standard pan vessel",
        [
            (0, 0),
            (0.100, 0),
            (0.100, 0.006),
            (0.106, 0.078),
            (0.105, 0.082),
            (0.103, 0.082),
            (0.103, 0.078),
            (0.097, 0.006),
            (0, 0.006),
            (0, 0),
        ],
        (0, 0, 0),
        steel,
        root,
        128,
    )
    tube(
        "Pan handle bracket",
        [(0.104, 0, 0.055), (0.135, 0, 0.065), (0.155, 0, 0.068)],
        0.006,
        steel,
        root,
    )
    tube(
        "Pan insulated handle",
        [(0.148, 0, 0.068), (0.265, 0, 0.085)],
        0.012,
        black,
        root,
    )
    convert_curves((root,))
    directory = ASSETS / "induction-pan"
    directory.mkdir(exist_ok=True)
    export_visual_meshes((root,), directory)
    (directory / "visual_assets.xml").replace(directory / "pan_assets.xml")


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    export_hob(ASSETS / "maruzen-mih-02c", "mih_hob")
    export_hob(ASSETS / "vollrath-59500p", "vp_hob")
    export_pan()


if __name__ == "__main__":
    main()
