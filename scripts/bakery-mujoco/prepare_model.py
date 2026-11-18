"""Rebuild the pinned FANUC arm with MuJoCo's URDF importer, entirely offline."""

from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET

import mujoco
import xacro


ASSETS = Path(__file__).resolve().parents[2] / "assets" / "bakery-mujoco"
NOTICE = """Modified for CafeOS: collision-only URDF/MJCF conversion.
Derived from FANUC-CORPORATION/fanuc_description at
fb40c9803a826ba68c7c8e28ba904a25efa7fcd2.
SPDX-FileCopyrightText: 2025-2026, FANUC America Corporation
SPDX-FileCopyrightText: 2025-2026, FANUC CORPORATION
SPDX-License-Identifier: Apache-2.0
See vendor/fanuc/Apache-2.0.txt and README.md.
"""


def write_xml(root: ET.Element, destination: Path) -> None:
    root.insert(0, ET.Comment(NOTICE))
    ET.indent(root, space="  ")
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)


def prepare_model() -> None:
    if mujoco.__version__ != "4.0.0":
        raise RuntimeError("Rebuild requires the pinned MuJoCo 4.0.0 environment.")

    expanded = xacro.process_file(str(ASSETS / "crx10ia.xacro"))
    robot = ET.fromstring(expanded.toxml())
    for link in robot.findall("link"):
        for visual in link.findall("visual"):
            link.remove(visual)
    for mesh in robot.findall(".//mesh"):
        mesh.set("filename", Path(mesh.attrib["filename"]).name)

    extension = ET.SubElement(robot, "mujoco")
    ET.SubElement(
        extension,
        "compiler",
        meshdir="vendor/fanuc/collision",
        fusestatic="false",
        discardvisual="true",
        balanceinertia="false",
    )
    write_xml(robot, ASSETS / "crx10ia.urdf")
    model = mujoco.MjModel.from_xml_path(str(ASSETS / "crx10ia.urdf"))
    with tempfile.TemporaryDirectory(prefix="cafeos-mjcf-") as directory:
        converted = Path(directory) / "arm.xml"
        mujoco.mj_saveLastXML(str(converted), model)
        mjcf = ET.parse(converted).getroot()

    compiler = mjcf.find("compiler")
    if compiler is None:
        raise RuntimeError("MuJoCo conversion did not emit a compiler element.")
    compiler.set("meshdir", "vendor/fanuc/collision")
    write_xml(mjcf, ASSETS / "crx10ia.xml")
    print("Rebuilt crx10ia.urdf and crx10ia.xml from the pinned local source.")


if __name__ == "__main__":
    prepare_model()
