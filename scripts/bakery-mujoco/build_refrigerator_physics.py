"""Build RT-120SNJ contact mechanics from its saved Blender reconstruction."""

import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_service_physics import export_model, finish, fixture, numbers

FOLDER = "hoshizaki-rt-120snj"


def collider(body, name, position, size):
    ET.SubElement(
        body,
        "geom",
        name=name,
        type="box",
        pos=numbers(position),
        size=numbers(size),
        contype="2",
        conaffinity="1",
    )


def main():
    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    names = (
        "rt_cabinet",
        "rt_door_left",
        "rt_door_right",
        "rt_shelf_left_1",
        "rt_shelf_left_2",
        "rt_shelf_right_1",
        "rt_shelf_right_2",
    )
    model, bodies, world = export_model(
        FOLDER, FOLDER + ".blend", names, (50, 5, 5, 2, 2, 2, 2)
    )
    model.find("option").set("timestep", ".002")
    base = bodies["rt_cabinet"]
    for name, pos, size in (
        ("rear", (0.131, 0.2715, 0.457), (0.420, 0.0285, 0.302)),
        ("floor", (0.131, 0.0225, 0.1275), (0.420, 0.2205, 0.0275)),
        ("ceiling", (0.131, 0.0225, 0.752), (0.420, 0.2205, 0.007)),
        ("left_wall", (-0.2945, 0.0225, 0.457), (0.0055, 0.2205, 0.302)),
        ("right_wall", (0.575, 0.026, 0.430), (0.024, 0.274, 0.330)),
        ("mullion", (0.131, -0.218, 0.4405), (0.014, 0.020, 0.2855)),
        ("evaporator", (-0.2725, 0.080, 0.678), (0.0165, 0.150, 0.0725)),
    ):
        collider(base, "rt_" + name + "_contact", pos, size)
    actuators = ET.SubElement(model, "actuator")
    for side, sign in (("left", 1), ("right", -1)):
        door = bodies["rt_door_" + side]
        door.find("inertial").set("pos", numbers((sign * 0.21, 0, 0)))
        door.find("inertial").set("diaginertia", ".163 .232 .072")
        ET.SubElement(
            door,
            "joint",
            name="rt_" + side + "_hinge",
            type="hinge",
            axis=numbers((0, 0, -sign)),
            range=numbers((0, math.radians(100))),
            damping="1",
        )
        collider(
            door,
            "rt_" + side + "_door_contact",
            (sign * 0.21, 0.004, -0.001),
            (0.206, 0.032, 0.3115),
        )
        fixture(
            actuators,
            "rt_" + side + "_fixture",
            "rt_" + side + "_hinge",
            numbers((0, math.radians(100))),
            18,
            5,
            3,
        )
        for level in (1, 2):
            shelf = bodies[f"rt_shelf_{side}_{level}"]
            collider(
                shelf,
                f"rt_{side}_{level}_support",
                (0, 0, -0.0014),
                (0.2, 0.2125, 0.003),
            )
            ET.SubElement(
                shelf,
                "site",
                name=f"rt_{side}_{level}_storage",
                pos="0 0 .0466",
                size=".006",
                group="3",
            )
    crate = ET.SubElement(world, "body", name="rt_container", pos="-.079 -.65 .046")
    ET.SubElement(crate, "freejoint", name="rt_container_free")
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_contact",
        type="box",
        size=".070 .110 .045",
        mass="1",
        rgba=".45 .65 .75 1",
        group="2",
        contype="1",
        conaffinity="2",
    )
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_lid",
        type="box",
        pos="0 0 .045",
        size=".073 .113 .003",
        mass="0",
        rgba=".85 .9 .92 1",
        group="2",
        contype="0",
        conaffinity="0",
    )
    finish(FOLDER, model)


if __name__ == "__main__":
    main()
