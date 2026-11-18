"""Author appliance geometry for the shared Rust/MuJoCo runtime."""

import copy
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco

ASSETS = Path(__file__).resolve().parents[2] / "assets/bakery-mujoco/hobart-hl200"
PARTS = ("bowl", "beater")


def add_geometry(spec):
    # Use elliptic friction constraints for the free parts on the moving rack.
    # This is a numerical setting; friction coefficients remain uncalibrated.
    spec.option.cone = mujoco.mjtCone.mjCONE_ELLIPTIC
    spec.option.impratio = 10
    source = ET.fromstring(mujoco.MjSpec.from_file(str(ASSETS / "mixer.xml")).to_xml())
    root = ET.Element("mujoco")
    ET.SubElement(root, "compiler", angle="radian")
    assets = ET.SubElement(root, "asset")
    world = ET.SubElement(root, "worldbody")
    for part in PARTS:
        body = copy.deepcopy(source.find(f".//body[@name='hl_{part}']"))
        body.set("pos", ".70 -.5 .345" if part == "bowl" else ".95 -.7 .355")
        body.set(
            "quat",
            "1 0 0 0" if part == "bowl" else ".7071067811865476 .7071067811865476 0 0",
        )
        world.append(body)
        for geom in body.iter("geom"):
            if geom.get("group") == "3":
                geom.set("contype", "1")
                geom.set("conaffinity", "1")
    meshes = {node.get("mesh") for node in world.iter("geom")}
    materials = {node.get("material") for node in world.iter("geom")}
    for node in source.find("asset"):
        if (node.tag == "mesh" and node.get("name") in meshes) or (
            node.tag == "material" and node.get("name") in materials
        ):
            item = copy.deepcopy(node)
            if item.get("file"):
                item.set("file", str(ASSETS / item.get("file")))
            assets.append(item)
    # Keep source defaults for its explicit visual and collision declarations.
    for node in source.findall("default"):
        root.append(copy.deepcopy(node))
    child = mujoco.MjSpec.from_string(ET.tostring(root, encoding="unicode"))
    spec.attach(child, prefix="wash_", frame=spec.worldbody.add_frame())
    rack = spec.body("ucl_wash_rack")
    for axis in (0, 1):
        for side in (-1, 1):
            position = [0.0, 0.0, 0.035]
            position[axis] = side * 0.244
            size = [0.247, 0.247, 0.035]
            size[axis] = 0.003
            rack.add_geom(
                name=f"wash_rack_wall_{axis}_{side}",
                type=mujoco.mjtGeom.mjGEOM_BOX,
                pos=position,
                size=size,
                mass=0,
                contype=1,
                conaffinity=1,
                group=3,
            )
    actuator = spec.actuator("ucl_rack_fixture")
    actuator.gainprm[0] = 10000
    actuator.biasprm[1] = -10000
    actuator.biasprm[2] = -200
    spec.geom("ucl_rack_floor").contype = 1
    spec.geom("ucl_rack_floor").conaffinity = 1
    spec.worldbody.add_geom(
        name="wash_receiving_bench",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        pos=(0.8, -0.5, 0.31),
        size=(0.3, 0.4, 0.03),
        rgba=(0.3, 0.35, 0.38, 1),
        group=2,
        contype=1,
        conaffinity=1,
    )
