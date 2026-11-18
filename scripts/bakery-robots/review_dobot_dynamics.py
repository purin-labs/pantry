"""Audit CR10 source dynamics. This script does not advance physics or fit parameters."""

import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "assets/bakery-robots/vendor/dobot-cr10"
REFERENCES = ROOT / "docs/equipment/dobot-cr10/review-sources"
SOURCES = {
    "pinned_ros2_v3": VENDOR / "dobot_rviz/urdf/cr10_robot.urdf",
    "pinned_gazebo": VENDOR / "cra_description/urdf/cr10_robot.xacro",
    "ros_comparison": REFERENCES / "ros-cr10.urdf",
    "ros2_v4_comparison": REFERENCES / "ros2-v4-cr10.urdf",
}


def inertials(path: Path) -> dict:
    result = {}
    for link in ET.parse(path).getroot().findall("link"):
        inertial = link.find("inertial")
        if inertial is None:
            continue
        values = inertial.find("inertia").attrib
        tensor = np.array(
            [
                [float(values["ixx"]), float(values["ixy"]), float(values["ixz"])],
                [float(values["ixy"]), float(values["iyy"]), float(values["iyz"])],
                [float(values["ixz"]), float(values["iyz"]), float(values["izz"])],
            ]
        )
        moments = np.linalg.eigvalsh(tensor)
        result[link.get("name")] = {
            "massKg": float(inertial.find("mass").get("value")),
            "centerOfMassM": list(
                map(float, inertial.find("origin").get("xyz").split())
            ),
            "inertialFrameRpy": list(
                map(float, inertial.find("origin").get("rpy").split())
            ),
            "tensorKgM2": tensor.tolist(),
            "principalMomentsKgM2": moments.tolist(),
            "positiveDefinite": bool(moments[0] > 0),
            "triangleInequality": bool(moments[2] <= moments[0] + moments[1]),
        }
    return result


def inspect_source(path: Path, reference: dict) -> dict:
    links = inertials(path)
    limits = []
    for joint in ET.parse(path).getroot().findall("joint[@type='revolute']"):
        limits.append({"joint": joint.get("name"), **joint.find("limit").attrib})
    return {
        "path": str(path.relative_to(ROOT)),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "massKg": sum(link["massKg"] for link in links.values()),
        "inertialsExactlyMatchPinnedV3": links == reference,
        "limits": limits,
    }


def main() -> None:
    links = inertials(SOURCES["pinned_ros2_v3"])
    mass = sum(link["massKg"] for link in links.values())
    report = {
        "date": "2026-10-07",
        "scope": "Source consistency and mathematical validity; no hardware validation",
        "sources": {
            name: inspect_source(path, links) for name, path in SOURCES.items()
        },
        "links": links,
        "publishedMassKg": 40,
        "massDifferenceKg": 40 - mass,
        "massDifferencePercentOfPublished": (40 - mass) / 40 * 100,
        "mathematicallyValidInertias": all(
            link["positiveDefinite"] and link["triangleInequality"]
            for link in links.values()
        ),
        "findings": [
            "All compared source packages repeat the same 24.7946 kg inertials; no corrected mass distribution found",
            "Positive moments and triangle inequalities pass, but these checks do not establish physical accuracy",
            "V3 RViz limits contain zero placeholders; Gazebo uses 300 Nm and 100 rad/s on every joint",
            "V4 RViz instead uses 100 Nm and 3.14 rad/s on every joint; V4 is a comparison source for CRA/E6, not verified CR10 hardware authority",
            "The current 300 Nm caps remain simulation assumptions; neither uniform vendor cap is a verified continuous motor rating",
            "The shared controller uses ideal bias compensation, assumed damping, armature and gains; measured tracking/load predictions remain unvalidated",
            "Do not scale source masses uniformly to 40 kg or select a new torque cap without link-level evidence",
        ],
    }
    output = ROOT / "docs/evidence/robot-selection/dobot-dynamics-review.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "output": str(output),
                "massKg": mass,
                "mathematicallyValidInertias": report["mathematicallyValidInertias"],
            }
        )
    )


if __name__ == "__main__":
    main()
