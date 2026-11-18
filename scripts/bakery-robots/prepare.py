"""Prepare pinned manufacturer descriptions without ROS or hardware."""

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xacro

ASSETS = Path(__file__).resolve().parents[2] / "assets" / "bakery-robots"
VENDOR = ASSETS / "vendor"
FAIRINO_REVISION = "5bed0b0263c8f1e95f51aa45079f904d463c5c50"
UFACTORY_REVISION = "62936f7ea1846a85f7350de2c4c18f39e6d19715"
FANUC_REVISION = "fb40c9803a826ba68c7c8e28ba904a25efa7fcd2"
UR_REVISION = "6662e15f32c23c12ece57d0050aee9a716e4fc41"
DOBOT_REVISION = "34a9fceae35d7a131e8c6b6e96882faab7e80f0a"
FANUC_NOTICE = """Derived from FANUC-CORPORATION/fanuc_description.
SPDX-FileCopyrightText: 2025-2026, FANUC America Corporation
SPDX-FileCopyrightText: 2025-2026, FANUC CORPORATION
SPDX-License-Identifier: Apache-2.0
Source revision: fb40c9803a826ba68c7c8e28ba904a25efa7fcd2
Modified for BakeryOS: Xacro expansion, local mesh paths, Collada-to-OBJ/GLB
conversion, food-appearance materials, joint rig and MuJoCo inspection scene.
Standard-arm geometry and dynamics; food-version equivalence is unverified.
License: ../vendor/fanuc-crx10ial/LICENSES/Apache-2.0.txt
"""
SERVO_KP = (1500, 1500, 1000, 300, 200, 100)
SERVO_KV = (100, 100, 60, 15, 10, 5)

# Official manual 3.9.4, tables 2.4-5 and 2.4-7: a, d (metres), alpha (radians).
# These nominal DH dimensions differ slightly from the pinned FR5 CAD frames.
FAIRINO_DH = {
    "fairino5_v6": (
        (0, 0.152, np.pi / 2),
        (-0.425, 0, 0),
        (-0.395, 0, 0),
        (0, 0.102, np.pi / 2),
        (0, 0.102, -np.pi / 2),
        (0, 0.100, 0),
    ),
    "fairino10_v6": (
        (0, 0.180, np.pi / 2),
        (-0.700, 0, 0),
        (-0.586, 0, 0),
        (0, 0.159, np.pi / 2),
        (0, 0.114, -np.pi / 2),
        (0, 0.106, 0),
    ),
}


@dataclass(frozen=True)
class RobotSpec:
    slug: str
    title: str
    source_name: str
    home: tuple[float, ...]
    payload_kg: float
    reach_m: float
    revision: str


ROBOTS = (
    RobotSpec(
        "dobot-cr10",
        "DOBOT CR10",
        "cr10",
        (0, 0.3296, -1.3436, -0.3643, 1.6134, 0),
        10,
        1.3,
        DOBOT_REVISION,
    ),
    RobotSpec(
        "universal-robots-ur5e",
        "Universal Robots UR5e",
        "ur5e",
        (0, -1.15, 1.65, -2.07, -1.5708, 0),
        5,
        0.85,
        UR_REVISION,
    ),
    RobotSpec(
        "fanuc-crx10ial",
        "FANUC CRX-10iA/L — food appearance study",
        "crx10ia_l",
        (0, 0.3, 0.5, 0, -0.2, 0),
        10,
        1.418,
        FANUC_REVISION,
    ),
    RobotSpec(
        "fairino-fr10",
        "FAIRINO FR10",
        "fairino10_v6",
        (0, -1.15, 1.65, -2.07, -1.5708, 0),
        10,
        1.4,
        FAIRINO_REVISION,
    ),
    RobotSpec(
        "fairino-fr5",
        "FAIRINO FR5",
        "fairino5_v6",
        (0, -1.15, 1.65, -2.07, -1.5708, 0),
        5,
        0.922,
        FAIRINO_REVISION,
    ),
    RobotSpec(
        "ufactory-xarm6",
        "UFACTORY xArm 6",
        "xarm6",
        (0, -0.35, -0.8, 0, 1.15, 0),
        5,
        0.7,
        UFACTORY_REVISION,
    ),
)


def source_robot(spec: RobotSpec) -> ET.Element:
    if spec.source_name == "cr10":
        return ET.parse(VENDOR / "dobot-cr10/dobot_rviz/urdf/cr10_robot.urdf").getroot()
    if spec.source_name == "ur5e":
        directory = VENDOR / "universal-robots-ur5e"
        # Expand package paths in memory; preserve the archived manufacturer files.
        macro = (
            (directory / "urdf/ur_macro.xacro")
            .read_text()
            .replace("$(find ur_description)", str(directory))
        )
        source = ET.fromstring(macro)
        namespace = "{http://wiki.ros.org/xacro}"
        ET.register_namespace("xacro", "http://wiki.ros.org/xacro")
        parameters = {
            "name": "ur5e",
            "tf_prefix": "",
            "parent": "world",
            "joint_limits_parameters_file": str(
                directory / "config/ur5e/joint_limits.yaml"
            ),
            "kinematics_parameters_file": str(
                directory / "config/ur5e/default_kinematics.yaml"
            ),
            "physical_parameters_file": str(
                directory / "config/ur5e/physical_parameters.yaml"
            ),
            "visual_parameters_file": str(
                directory / "config/ur5e/visual_parameters.yaml"
            ),
        }
        invocation = ET.SubElement(source, namespace + "ur_robot", parameters)
        ET.SubElement(invocation, "origin", xyz="0 0 0", rpy="0 0 0")
        document = xacro.parse(ET.tostring(source, encoding="unicode"))
        xacro.process_doc(document)
        robot = ET.fromstring(document.toxml())
        robot.remove(robot.find("joint[@name='base_joint']"))
        return robot
    if spec.source_name == "crx10ia_l":
        macro = (
            VENDOR
            / "fanuc-crx10ial/fanuc_crx_description/urdf/crx10ia_l_urdf_macro.xacro"
        )
        wrapper = f'''<robot name="crx10ia_l" xmlns:xacro="http://www.ros.org/wiki/xacro">
          <xacro:include filename="{macro}"/>
          <xacro:crx10ia_l parent="world" child="tool">
            <origin xyz="0 0 0" rpy="0 0 0"/>
          </xacro:crx10ia_l>
        </robot>'''
        document = xacro.parse(wrapper)
        xacro.process_doc(document)
        robot = ET.fromstring(document.toxml())
        # External attachment joints belong to the workcell, not the bare arm.
        for label in ("base_joint", "child_joint"):
            robot.remove(robot.find(f"joint[@name='{label}']"))
        return robot
    if spec.source_name != "xarm6":
        return ET.parse(
            VENDOR / "fairino" / "urdf" / f"{spec.source_name}.urdf"
        ).getroot()

    directory = VENDOR / "ufactory"
    ET.register_namespace("xacro", "http://ros.org/wiki/xacro")
    source = ET.Element("robot", {"name": "ufactory_xarm6"})
    namespace = "{http://ros.org/wiki/xacro}"
    properties = {
        "mesh_suffix": "stl",
        "mesh_path": "package://xarm_description/meshes",
        "use_xacro_load_yaml": "true",
    }
    for name, value in properties.items():
        ET.SubElement(source, namespace + "property", name=name, value=value)
    for filename in ("common.link.xacro", "common.material.xacro", "xarm6.urdf.xacro"):
        source.extend(ET.parse(directory / "urdf" / filename).getroot())
    ET.SubElement(source, namespace + "common_material", prefix="")
    ET.SubElement(
        source,
        namespace + "xarm6_urdf",
        prefix="",
        model_num="1305",
        kinematics_params_filename=str(
            directory / "config" / "xarm6_default_kinematics.yaml"
        ),
    )

    # Resolve the ROS package lookup once, without modifying vendored source.
    text = ET.tostring(source, encoding="unicode").replace(
        "$(find xarm_description)/config/link_inertial", str(directory / "config")
    )
    document = xacro.parse(text)
    xacro.process_doc(document)
    return ET.fromstring(document.toxml())


def source_exclusions(spec: RobotSpec) -> list[tuple[str, str]]:
    if spec.source_name == "cr10":
        root = ET.parse(
            VENDOR / "dobot-cr10/cr10_moveit/config/cr10_robot.srdf"
        ).getroot()
        return [
            (element.get("link1"), element.get("link2"))
            for element in root.iter("disable_collisions")
        ]
    if spec.source_name == "ur5e":
        # The fixed base welds to the world, so MuJoCo's parent filter does not
        # remove the 0.5 mm overlap at the adjoining shoulder bearing.
        return [("base_link_inertia", "shoulder_link")]
    if spec.source_name == "crx10ia_l":
        # No upstream SRDF was supplied. MuJoCo filters adjacent links itself.
        return []
    if spec.source_name == "xarm6":
        root = ET.parse(
            VENDOR / "ufactory" / "urdf" / "_xarm6_macro.srdf.xacro"
        ).getroot()
    else:
        root = ET.parse(
            VENDOR / "fairino" / "srdf" / f"{spec.source_name}_robot.srdf"
        ).getroot()
    pairs = []
    for element in root.iter("disable_collisions"):
        first = element.attrib["link1"].replace("${prefix}", "")
        second = element.attrib["link2"].replace("${prefix}", "")
        pairs.append((first, second))
    return pairs


def write_xml(root: ET.Element, path: Path) -> None:
    ET.indent(root, space="  ")
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def correct_fairino_inertials(spec: RobotSpec, robot: ET.Element) -> None:
    """Express the supplied DH-frame inertials in the CAD's joint-local frames."""
    for joint, (a, d, alpha) in zip(
        robot.findall("joint"), FAIRINO_DH[spec.source_name], strict=True
    ):
        child = joint.find("child").attrib["link"]
        inertial = robot.find(f"link[@name='{child}']/inertial")
        origin = inertial.find("origin")
        if origin.attrib["rpy"] != "0 0 0":
            raise ValueError(f"Unexpected source inertial rotation: {child}")
        center = np.fromstring(origin.attrib["xyz"], sep=" ")
        sine, cosine = np.sin(alpha), np.cos(alpha)
        axes = np.array(((1, 0, 0), (0, cosine, -sine), (0, sine, cosine)))
        center = axes @ center + (a, 0, d)
        origin.set("xyz", " ".join(format(value, ".12g") for value in center))

        inertia = inertial.find("inertia")
        values = inertia.attrib
        tensor = np.array(
            (
                (float(values["ixx"]), float(values["ixy"]), float(values["ixz"])),
                (float(values["ixy"]), float(values["iyy"]), float(values["iyz"])),
                (float(values["ixz"]), float(values["iyz"]), float(values["izz"])),
            )
        )
        # The tensor stays at the COM: rotate its basis without a parallel-axis shift.
        tensor = axes @ tensor @ axes.T
        for key, row, column in (
            ("ixx", 0, 0),
            ("iyy", 1, 1),
            ("izz", 2, 2),
            ("ixy", 0, 1),
            ("ixz", 0, 2),
            ("iyz", 1, 2),
        ):
            inertia.set(key, format(tensor[row, column], ".12g"))


def prepare(spec: RobotSpec) -> ET.Element:
    destination = ASSETS / spec.slug
    destination.mkdir(parents=True, exist_ok=True)
    robot = source_robot(spec)
    if spec.source_name == "cr10":
        # RViz limits are zero placeholders. The sibling Gazebo model supplies
        # a 300 Nm simulation cap. Speeds use the CR10 product specification.
        for index, joint in enumerate(robot.findall("joint[@type='revolute']")):
            limit = joint.find("limit")
            limit.set("effort", "300")
            limit.set("velocity", str(np.deg2rad(120 if index < 2 else 180)))
            if index == 2:
                limit.set("lower", str(-np.deg2rad(160)))
                limit.set("upper", str(np.deg2rad(160)))
        # CAD terminates at Link6 z=0. The alias is a provisional mounting frame.
        ET.SubElement(robot, "link", name="flange")
        joint = ET.SubElement(robot, "joint", name="tool_mount", type="fixed")
        ET.SubElement(joint, "parent", link="Link6")
        ET.SubElement(joint, "child", link="flange")
    if spec.source_name == "crx10ia_l":
        robot.insert(0, ET.Comment(FANUC_NOTICE))
        (destination / "NOTICE").write_text(FANUC_NOTICE)
    if spec.source_name in FAIRINO_DH:
        correct_fairino_inertials(spec, robot)
    for mesh in robot.findall(".//mesh"):
        original = mesh.attrib["filename"]
        original = original.replace(
            "package://fairino_description/", "../vendor/fairino/"
        )
        original = original.replace(
            "package://xarm_description/", "../vendor/ufactory/"
        )
        original = original.replace(
            "package://fanuc_crx_description/",
            "../vendor/fanuc-crx10ial/fanuc_crx_description/",
        )
        original = original.replace(
            "package://ur_description/", "../vendor/universal-robots-ur5e/"
        )
        original = original.replace(
            "package://dobot_rviz/", "../vendor/dobot-cr10/dobot_rviz/"
        )
        mesh.set("filename", original)
        if not (destination / original).is_file():
            raise FileNotFoundError(original)
    robot.insert(
        0,
        ET.Comment(
            f"Prepared from source revision {spec.revision}: local mesh paths and expanded Xacro. FAIRINO alone receives the documented inertial correction. See README documentation for uncertainties."
        ),
    )
    write_xml(robot, destination / "robot.urdf")
    return robot


if __name__ == "__main__":
    for robot_spec in ROBOTS:
        prepare(robot_spec)
        print(f"Prepared {robot_spec.title}")
