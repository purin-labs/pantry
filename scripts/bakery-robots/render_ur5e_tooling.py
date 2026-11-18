"""Build the tooling visual from the same dimensions used for MuJoCo inertia."""

import json
import math
from pathlib import Path

import bpy
from mathutils import Vector

DIRECTORY = (
    Path(__file__).resolve().parents[2]
    / "assets/bakery-robots/universal-robots-ur5e/tooling"
)


def material(name, color, metallic):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.28
    return result


def cylinder(position, radius, length):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=96,
        radius=radius,
        depth=length,
        location=position,
        rotation=(0, math.pi / 2, 0),
    )
    return bpy.context.object


def subtract(obj, cutter):
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new("Machined opening", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    aluminium = material("Machined aluminium", (0.57, 0.62, 0.66), 0.8)
    pad = material("Grip pad prototype", (0.075, 0.085, 0.09), 0)
    drive = material("Unselected drive envelope", (0.15, 0.19, 0.24), 0.45)
    report = json.loads((DIRECTORY / "mass-properties.json").read_text())
    parents = {}
    for name in ["cell_gripper", "cell_upper_jaw"]:
        parent = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(parent)
        parents[name] = parent
    parents["cell_upper_jaw"].parent = parents["cell_gripper"]
    for part in report["parts"]:
        size = part["sizeM"]
        if part["shape"] == "cylinder":
            obj = cylinder(part["positionM"], size[0], size[1] * 2)
            bore = part["detail"]["boreRadiusM"]
            if bore:
                subtract(obj, cylinder(part["positionM"], bore, size[1] * 2 + 0.002))
            if part["name"] in ["clamp_mount_base", "clamp_mount_end", "clamp_adapter"]:
                for index in range(4):
                    angle = math.pi / 4 + index * math.pi / 2
                    position = [
                        part["positionM"][0],
                        0.025 * math.cos(angle),
                        0.025 * math.sin(angle),
                    ]
                    subtract(obj, cylinder(position, 0.0033, 0.012))
        else:
            bpy.ops.mesh.primitive_cube_add(size=1, location=part["positionM"])
            obj = bpy.context.object
            obj.dimensions = [value * 2 for value in size]
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            wall = part["detail"].get("closedSectionWallM", 0)
            if wall:
                bpy.ops.mesh.primitive_cube_add(size=1, location=part["positionM"])
                cutter = bpy.context.object
                cutter.dimensions = [value * 2 - wall * 2 for value in size]
                bpy.ops.object.transform_apply(
                    location=False, rotation=False, scale=True
                )
                subtract(obj, cutter)
        obj.name = part["name"]
        obj.parent = parents[part["body"]]
        obj["calculated_mass_kg"] = part["massKg"]
        obj["design_status"] = (
            "Simulation prototype; mounting joint and actuator unvalidated"
        )
        obj.data.materials.append(
            pad if "pad" in obj.name else drive if "actuator" in obj.name else aluminium
        )
        bevel = obj.modifiers.new("Edge breaks", "BEVEL")
        bevel.width = 0.0006
        bevel.segments = 3
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(DIRECTORY / "tooling.glb"), export_format="GLB", use_selection=True
    )
    bpy.ops.object.camera_add(location=(-0.55, -0.72, 0.50))
    camera = bpy.context.object
    camera.rotation_euler = (
        (Vector((0.08, 0, 0.015)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 0.65
    scene = bpy.context.scene
    scene.camera = camera
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.22, 0.25, 0.28, 1)
    scene.world = world
    for position, energy, size in [
        ((-0.3, -0.4, 1), 50, 0.6),
        ((0.5, 0.4, 0.5), 35, 0.5),
    ]:
        bpy.ops.object.light_add(type="AREA", location=position)
        light = bpy.context.object
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.rotation_euler = (
            (Vector((0.08, 0, 0)) - light.location).to_track_quat("-Z", "Y").to_euler()
        )
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(DIRECTORY / "preview.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(DIRECTORY / "tooling.blend"))
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
