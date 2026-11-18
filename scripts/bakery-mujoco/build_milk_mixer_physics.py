"""Export the saved SM 3587 Blender surfaces for the appliance dynamics lab."""

import hashlib
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_oven_visuals import export_visual_meshes

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/severin-sm-3587"
BODY_NAMES = (
    "sm3587_milk_mixer",
    "sm3587_jug",
    "sm3587_lid",
    "sm3587_stirrer",
)


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    source = ASSETS / "severin-sm-3587.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    bodies = tuple(bpy.data.objects[name] for name in BODY_NAMES)
    # Collapse decorative parents into their mechanical body in this export only.
    for obj in list(bodies[0].children_recursive):
        if obj.type != "MESH":
            continue
        if obj.name.startswith("OLED steam line"):
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        parent = obj.parent
        while parent not in bodies:
            parent = parent.parent
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
    bpy.context.view_layer.update()
    # MuJoCo uses alpha transparency rather than Blender's transmission shader.
    bpy.data.materials["Severin transparent lid polymer"].diffuse_color = (
        0.78,
        0.88,
        0.92,
        0.22,
    )
    export_visual_meshes(bodies, ASSETS)
    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "body_names": BODY_NAMES,
        "scope": "Visual surfaces only; collision proxies and inertia are in milk-mixer.xml.",
    }
    (ASSETS / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
