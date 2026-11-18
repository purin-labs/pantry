"""Render a saved appliance with its existing studio, camera and initial pose."""

import argparse
import sys
from pathlib import Path

import bpy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--opaque", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()))
    scene = bpy.context.scene
    scene.frame_set(1)
    assert scene.camera is not None, "Saved review camera required"
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_percentage = 40
    if args.opaque:
        material = bpy.data.materials.new("Opaque surface diagnostic")
        material.use_nodes = True
        shader = material.node_tree.nodes["Principled BSDF"]
        shader.inputs["Base Color"].default_value = (0.35, 0.35, 0.35, 1)
        shader.inputs["Roughness"].default_value = 0.3
        for layer in scene.view_layers:
            layer.material_override = material
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(args.output.resolve())
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
