"""Prepare canonical ingredient requests and calculate independent MuJoCo mass properties."""

import argparse
import json
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np

from workcell import initialize_pose

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (
    ROOT
    / "assets/bakery-mujoco/fr10-workcell/native/universal-robots-ur5e/combined-nominal.xml"
)


def load_properties(model, data):
    # Put the jaw at its nominal gripping opening for the mass-property calculation.
    data.joint("clamp_opening").qpos[0] = 0
    data.joint("mbco_tray_free").qpos[:3] = data.site("cell_grasp").xpos + [
        0.25,
        0,
        0.001,
    ]
    mujoco.mj_forward(model, data)
    flange = data.site("cell_nominal_flange")
    masses = []
    centers = []
    for name in ["cell_gripper", "cell_upper_jaw", "mbco_tray"]:
        body = model.body(name)
        masses.append(float(body.mass[0]))
        centers.append(data.body(name).xipos.copy())
    total = sum(masses)
    center = np.average(centers, axis=0, weights=masses)
    relative = flange.xmat.reshape(3, 3).T @ (center - flange.xpos)
    distance = float(np.linalg.norm(relative))
    return dict(
        totalCarriedMassKg=total,
        flangeCenterOfMassM=relative.tolist(),
        centerOfMassDistanceMm=distance * 1000,
    )


def build_study_model(mass, x, y):
    """Compile the nominal cell with the contents mass and its tray offset in mm."""
    xml = ET.parse(SOURCE)
    for mesh in xml.findall("./asset/mesh"):
        mesh.set("file", str((SOURCE.parent / mesh.get("file")).resolve()))
    contents = xml.find(".//geom[@name='cold_contents']")
    contents.set("mass", str(mass))
    # Tray local Y points along world X; local X points along world -Y.
    contents.set("pos", f"{-y / 1000} {x / 1000} .02")
    return mujoco.MjModel.from_xml_string(ET.tostring(xml.getroot(), encoding="unicode"))


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=False)
    cases = [(mass, 0, 0) for mass in [0, 0.5, 0.75, 1, 1.1, 1.25, 1.5]]
    cases += [
        (mass, x, y)
        for mass in [0.5, 0.75, 1]
        for x, y in [
            (100, 0),
            (-100, 0),
            (0, 60),
            (0, -60),
            (100, 60),
            (100, -60),
            (-100, 60),
            (-100, -60),
        ]
    ]
    rows = []
    for mass, x, y in cases:
        name = f"contents-{mass}-x{x}-y{y}"
        request = directory / f"{name}.request.json"
        subprocess.run(
            [
                str(ROOT / "crates/bakery-native/target/release/bakery-native"),
                "--output",
                str(request),
                "prepare",
                "--robot",
                "universal-robots-ur5e",
                "--cell",
                "combined",
                "--task",
                "table-to-oven",
                "--ingredient-mass-kg",
                str(mass),
                "--ingredient-forward-mm",
                str(x),
                "--ingredient-lateral-mm",
                str(y),
            ],
            check=True,
        )
        model = build_study_model(mass, x, y)
        data = mujoco.MjData(model)
        initialize_pose(model, data, "source")
        rows.append(
            dict(
                name=name,
                contentsKg=mass,
                contentsOffsetWorldMm=[x, y],
                **load_properties(model, data),
            )
        )
    (directory / "loads.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    prepare(args.directory)
