"""Check the UR5e workcell mass properties against their sources.

Run it before ASSESSED_ASSETS_SHA256 in packages/bakery-model/src/
bakery-load-assessment.ts accepts a new physics asset set. The argument is a
load study directory that ur5e_payload_envelope.py prepared and that
verify-ingredient-loads.mjs completed, so that each case has its run-0
recording. The script prints one JSON report and exits with status 1 when a
model value differs from its source or a gravity torque exceeds its actuator
range.
"""

import argparse
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
import yaml

from ur5e_payload_envelope import SOURCE, build_study_model
from workcell import arm_addresses, initialize_pose, orientation_error

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "assets/bakery-robots/vendor/universal-robots-ur5e/config/ur5e"
ROBOT = ROOT / "assets/bakery-robots/universal-robots-ur5e"
SPANNER_SOURCE = (
    ROOT
    / "assets/bakery-mujoco/fr10-workcell/native/universal-robots-ur5e/spanner-oven-combined-nominal.xml"
)
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow", "wrist_1", "wrist_2", "wrist_3"]
LINKS = ["shoulder", "upper_arm", "forearm", "wrist_1", "wrist_2", "wrist_3"]
# Handbook densities that bound the unmeasured tray material.
ALUMINIUM_KG_M3 = 2700
STEEL_KG_M3 = 7850
# Relative agreement for values copied from a source with fewer digits.
SOURCE_TOLERANCE = 1e-6

yaml.SafeLoader.add_constructor(
    "!degrees", lambda loader, node: math.radians(float(loader.construct_scalar(node)))
)


def rpy_matrix(roll, pitch, yaw):
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    return rz @ ry @ rx


def body_tensor(model, body):
    mat = np.zeros(9)
    mujoco.mju_quat2Mat(mat, model.body_iquat[body])
    rotation = mat.reshape(3, 3)
    return rotation @ np.diag(model.body_inertia[body]) @ rotation.T


def relative(difference, reference):
    return float(np.max(np.abs(difference)) / max(np.max(np.abs(reference)), 1e-12))


def check_links(model):
    """Arm links against the vendor ROS description (physical_parameters.yaml)."""
    params = yaml.safe_load((VENDOR / "physical_parameters.yaml").read_text())[
        "inertia_parameters"
    ]
    rows = []
    for key in LINKS:
        body = model.body(f"universal-robots-ur5e__{key}_link").id
        cog = params["center_of_mass"][f"{key}_cog"]
        cog = np.array([cog["x"], cog["y"], cog["z"]])
        t = params["tensor"][key]
        tensor = np.array(
            [
                [t["ixx"], t["ixy"], t["ixz"]],
                [t["ixy"], t["iyy"], t["iyz"]],
                [t["ixz"], t["iyz"], t["izz"]],
            ]
        )
        rpy = params["rotation"][key]
        rotation = rpy_matrix(rpy["roll"], rpy["pitch"], rpy["yaw"])
        expected = rotation @ tensor @ rotation.T
        rows.append(
            dict(
                link=key,
                sourceMassKg=params[f"{key}_mass"],
                modelMassKg=float(model.body_mass[body]),
                sourceCenterM=cog.tolist(),
                modelCenterM=model.body_ipos[body].tolist(),
                inertiaRelativeDifference=relative(body_tensor(model, body) - expected, expected),
                agrees=bool(
                    abs(model.body_mass[body] - params[f"{key}_mass"]) < 1e-12
                    and np.allclose(model.body_ipos[body], cog, atol=1e-12)
                    and relative(body_tensor(model, body) - expected, expected) < SOURCE_TOLERANCE
                ),
            )
        )
    base = model.body("universal-robots-ur5e__base_link_inertia").id
    radius = params["links"]["base"]["radius"]
    length = params["links"]["base"]["length"]
    mass = params["base_mass"]
    expected = sorted(
        [0.0833333 * mass * (3 * radius**2 + length**2)] * 2 + [0.5 * mass * radius**2]
    )
    rows.insert(
        0,
        dict(
            link="base",
            sourceMassKg=mass,
            modelMassKg=float(model.body_mass[base]),
            sourceNote="The vendor file marks this mass as possibly incorrect. The base is fixed.",
            agrees=bool(
                model.body_mass[base] == mass
                and np.allclose(np.sort(model.body_inertia[base]), expected, rtol=SOURCE_TOLERANCE)
            ),
        ),
    )
    return rows


def part_properties(part):
    """Mass and inertia at the part centre from shape, size and density."""
    shape, size, detail = part["shape"], part["sizeM"], part.get("detail", {})
    if "assumedMassReason" in detail:
        mass = part["massKg"]
        a, b, c = (2 * s for s in size)
        inertia = np.diag(
            [mass / 12 * (b * b + c * c), mass / 12 * (a * a + c * c), mass / 12 * (a * a + b * b)]
        )
        return mass, inertia, "assumed"
    density = detail["densityKgM3"]
    if shape == "cylinder":
        radius, height, bore = size[0], 2 * size[1], detail["boreRadiusM"]
        mass = density * math.pi * (radius * radius - bore * bore) * height
        axial = 0.5 * mass * (radius * radius + bore * bore)
        transverse = mass / 12 * (3 * (radius * radius + bore * bore) + height * height)
        # The XML turns each cylinder axis onto the body X axis.
        return mass, np.diag([axial, transverse, transverse]), "computed"

    def solid(a, b, c):
        mass = density * a * b * c
        return mass, np.diag(
            [mass / 12 * (b * b + c * c), mass / 12 * (a * a + c * c), mass / 12 * (a * a + b * b)]
        )

    a, b, c = (2 * s for s in size)
    mass, inertia = solid(a, b, c)
    wall = detail["closedSectionWallM"]
    if wall:
        inner_mass, inner_inertia = solid(a - 2 * wall, b - 2 * wall, c - 2 * wall)
        mass, inertia = mass - inner_mass, inertia - inner_inertia
    return mass, inertia, "computed"


def check_tool(model, xml):
    """Tool and jaw: every part from its shape, then each body from its parts."""
    record = json.loads((ROBOT / "tooling/mass-properties.json").read_text())
    geoms = {geom.get("name"): geom for geom in xml.iter("geom")}
    parts, members = [], {"cell_gripper": [], "cell_upper_jaw": []}
    for part in record["parts"]:
        mass, inertia, basis = part_properties(part)
        geom = geoms[part["name"]]
        position = [float(v) for v in geom.get("pos").split()]
        size = [float(v) for v in geom.get("size").split()]
        parts.append(
            dict(
                name=part["name"],
                body=part["body"],
                basis=basis,
                recordMassKg=part["massKg"],
                computedMassKg=mass,
                agrees=bool(
                    abs(mass - part["massKg"]) < 1e-12
                    and np.allclose(inertia, part["inertiaAtCenterKgM2"], atol=1e-12)
                    and np.allclose(position, part["positionM"], atol=1e-12)
                    and np.allclose(size[: len(part["sizeM"])], part["sizeM"], atol=1e-12)
                ),
            )
        )
        members[part["body"]].append((mass, np.array(part["positionM"], float), inertia))
    bodies = []
    for name, key in [("cell_gripper", "tool"), ("cell_upper_jaw", "jaw")]:
        mass = sum(m for m, _, _ in members[name])
        center = sum(m * p for m, p, _ in members[name]) / mass
        inertia = np.zeros((3, 3))
        for m, p, i in members[name]:
            d = p - center
            inertia += i + m * (np.dot(d, d) * np.eye(3) - np.outer(d, d))
        body = model.body(name).id
        expected = record["bodies"][key]
        bodies.append(
            dict(
                body=name,
                computedMassKg=mass,
                recordMassKg=expected["massKg"],
                modelMassKg=float(model.body_mass[body]),
                computedCenterM=center.tolist(),
                modelCenterM=model.body_ipos[body].tolist(),
                agrees=bool(
                    abs(mass - expected["massKg"]) < 1e-12
                    and abs(mass - model.body_mass[body]) < 1e-12
                    and np.allclose(center, model.body_ipos[body], atol=1e-12)
                    and np.allclose(center, expected["centerOfMassM"], atol=1e-12)
                    and np.allclose(inertia, expected["inertiaAtCenterKgM2"], atol=1e-12)
                    and np.allclose(inertia, body_tensor(model, body), atol=1e-12)
                ),
            )
        )
    return parts, bodies


def check_tray(model, xml):
    """Empty tray mass against the volume of its shell in two plausible metals."""
    body = xml.find(".//body[@name='mbco_tray']")
    shell = [g for g in body.iter("geom") if g.get("name") != "cold_contents"]
    volume = sum(8 * np.prod([float(v) for v in g.get("size").split()]) for g in shell)
    mass = sum(float(g.get("mass")) for g in shell)
    return dict(
        emptyMassKg=mass,
        shellVolumeM3=volume,
        equivalentDensityKgM3=mass / volume,
        aluminiumShellKg=ALUMINIUM_KG_M3 * volume,
        steelShellKg=STEEL_KG_M3 * volume,
        withinMetalRange=bool(ALUMINIUM_KG_M3 * volume <= mass <= STEEL_KG_M3 * volume),
    )


def check_actuators(model):
    joints = json.loads((ROBOT / "joints.json").read_text())["joint_order"]
    limits = yaml.safe_load((VENDOR / "joint_limits.yaml").read_text())["joint_limits"]
    rows = []
    for source in joints:
        actuator = model.actuator(f"{source['node']}__servo").id
        limit = limits[source["name"]]["max_effort"]
        force = model.actuator_forcerange[actuator].tolist()
        rows.append(
            dict(
                joint=source["name"],
                modelForceRangeNm=force,
                sourceMaxEffortNm=limit,
                agrees=force == [-limit, limit],
            )
        )
    return rows


def arm_setup(model):
    names = [f"universal-robots-ur5e__{j}_joint" for j in JOINTS]
    first = model.body("universal-robots-ur5e__shoulder_link").id

    def carried(body):
        while body > 0:
            if body == first:
                return True
            body = model.body_parentid[body]
        return False

    return (
        [model.joint(n).qposadr[0] for n in names],
        [model.joint(n).dofadr[0] for n in names],
        [b for b in range(model.nbody) if model.body_mass[b] > 0 and carried(b)],
    )


def gravity_torque(model, data, dofs, bodies, tray_center):
    """Static joint torque that holds the arm, the tool and a carried tray."""
    tau = np.zeros(6)
    jacobian = np.zeros((3, model.nv))
    for body in bodies:
        jacobian[:] = 0
        mujoco.mj_jac(model, data, jacobian, None, data.xipos[body], body)
        tau -= jacobian[:, dofs].T @ (model.body_mass[body] * model.opt.gravity)
    if tray_center is not None:
        jacobian[:] = 0
        mujoco.mj_jac(model, data, jacobian, None, tray_center, model.body("cell_gripper").id)
        tau -= jacobian[:, dofs].T @ (model.body_mass[model.body("mbco_tray").id] * model.opt.gravity)
    return np.abs(tau)


def check_workflow_torque(study):
    """Largest gravity torque over every recorded pose of every load case."""
    worst, cases = np.zeros(6), []
    for row in json.loads((study / "loads.json").read_text()):
        model = build_study_model(row["contentsKg"], *row["contentsOffsetWorldMm"])
        data = mujoco.MjData(model)
        qpos, dofs, bodies = arm_setup(model)
        tray = model.joint("mbco_tray_free").qposadr[0]
        recording = json.loads((study / f"{row['name']}.run-0.json").read_text())
        largest = np.zeros(6)
        for leg in (recording["loading"], recording["unloading"], recording["racking"]):
            phases = {e["label"]: e["step"] for e in leg["events"] if e["kind"] == "phase"}
            for sample in leg["samples"]:
                data.qpos[qpos] = sample["joints"]
                data.qpos[tray : tray + 7] = sample["tray"]
                mujoco.mj_kinematics(model, data)
                mujoco.mj_comPos(model, data)
                held = phases["lift"] <= sample["step"] < phases["release"]
                center = data.body("mbco_tray").xipos.copy() if held else None
                largest = np.maximum(largest, gravity_torque(model, data, dofs, bodies, center))
        worst = np.maximum(worst, largest)
        cases.append(dict(name=row["name"], maxGravityTorqueNm=largest.round(3).tolist()))
    return worst, cases


def check_any_pose_torque(samples=200000):
    """Sampled bound over all arm poses: 1.5 kg contents 100 mm forward, nominal grasp."""
    model = build_study_model(1.5, 100, 0)
    data = mujoco.MjData(model)
    qpos, dofs, bodies = arm_setup(model)
    initialize_pose(model, data, "source")
    data.joint("clamp_opening").qpos[0] = 0
    data.joint("mbco_tray_free").qpos[:3] = data.site("cell_grasp").xpos + [0.25, 0, 0.001]
    mujoco.mj_forward(model, data)
    gripper = data.body("cell_gripper")
    offset = gripper.xmat.reshape(3, 3).T @ (data.body("mbco_tray").xipos - gripper.xpos)
    rng = np.random.default_rng(20261116)
    bound = np.zeros(6)
    for _ in range(samples):
        data.qpos[qpos] = rng.uniform(-np.pi, np.pi, 6)
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        center = gripper.xpos + gripper.xmat.reshape(3, 3) @ offset
        bound = np.maximum(bound, gravity_torque(model, data, dofs, bodies, center))
    return bound


def check_spanner_model():
    """Verify UR5e MBCO-4ME spanner-gripper mass, CoM, and flange load formula."""
    xml = ET.parse(SPANNER_SOURCE)
    for mesh in xml.findall("./asset/mesh"):
        mesh.set("file", str((SPANNER_SOURCE.parent / mesh.get("file")).resolve()))
    checks = []
    for mass, fwd_mm, lat_mm in (
        (0.0, 0, 0),
        (1.0, 0, 0),
        (1.0, 100, 60),
        (1.5, -100, -60),
    ):
        root_copy = ET.fromstring(ET.tostring(xml.getroot(), encoding="unicode"))
        contents = root_copy.find(".//geom[@name='cold_contents']")
        contents.set("mass", str(mass))
        contents.set("pos", f"{-lat_mm / 1000.0} {fwd_mm / 1000.0} 0.019")
        model = mujoco.MjModel.from_xml_string(ET.tostring(root_copy, encoding="unicode"))
        data = mujoco.MjData(model)
        pos_adr, vel_adr = arm_addresses(model)
        limits = np.array(
            [
                model.joint(model.joint(i).name).range
                for i in range(model.njnt)
                if "__" in model.joint(i).name
            ]
        )
        data.qpos[pos_adr] = [-0.6065, -2.2979, -1.5543, -2.431, -2.1773, 1.5708]
        data.joint("clamp_opening").qpos[0] = 0.0
        target = np.array([0.38, -0.22, 1.01])
        jp = np.zeros((3, model.nv))
        jr = np.zeros((3, model.nv))
        for _ in range(350):
            mujoco.mj_forward(model, data)
            site = data.site("cell_grasp")
            ep = target - site.xpos
            er = orientation_error(site.xmat)
            if np.linalg.norm(ep) < 1e-10 and np.linalg.norm(er) < 1e-10:
                break
            mujoco.mj_jacSite(model, data, jp, jr, site.id)
            jac = np.vstack((jp[:, vel_adr], jr[:, vel_adr]))
            dq = jac.T @ np.linalg.solve(jac @ jac.T + np.eye(6) * 1e-6, np.concatenate((ep, er)))
            data.qpos[pos_adr] = np.clip(data.qpos[pos_adr] + dq, limits[:, 0] + 1e-5, limits[:, 1] - 1e-5)
        mujoco.mj_forward(model, data)
        data.joint("mbco_tray_free").qpos[:3] = data.site("cell_grasp").xpos + [0.0, 0.005, -0.011]
        data.joint("mbco_tray_free").qpos[3:] = [1.0, 0.0, 0.0, 0.0]
        mujoco.mj_forward(model, data)
        flange = data.site("cell_nominal_flange")
        masses = [float(model.body(n).mass[0]) for n in ("cell_gripper", "cell_upper_jaw", "mbco_tray")]
        centers = [data.body(n).xipos.copy() for n in ("cell_gripper", "cell_upper_jaw", "mbco_tray")]
        total = sum(masses)
        rel = flange.xmat.reshape(3, 3).T @ (np.average(centers, axis=0, weights=masses) - flange.xpos)
        expected_total = 0.85 + 0.16 + 0.85 + mass
        expected_rel = np.array(
            [
                (0.85 * -0.005 + 0.16 * -0.035 + 0.85 * -0.069 + mass * -0.056) / expected_total,
                (-mass * lat_mm / 1000.0) / expected_total,
                (0.85 * 0.16 + 0.16 * 0.085 + 0.85 * 0.245 + mass * (0.245 + fwd_mm / 1000.0))
                / expected_total,
            ]
        )
        checks.append(
            dict(
                contentsKg=mass,
                forwardMm=fwd_mm,
                lateralMm=lat_mm,
                totalMassKg=total,
                flangeCenterOfMassM=rel.tolist(),
                centerOfMassDistanceMm=float(np.linalg.norm(rel) * 1000.0),
                maxComponentErrorM=float(np.max(np.abs(rel - expected_rel))),
                agrees=bool(
                    abs(total - expected_total) < 1e-12
                    and np.allclose(rel, expected_rel, atol=1e-9)
                ),
            )
        )
    return checks


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("study", type=Path)
    args = parser.parse_args()
    model = mujoco.MjModel.from_xml_path(str(SOURCE))
    xml = ET.parse(SOURCE)
    links = check_links(model)
    parts, bodies = check_tool(model, xml)
    tray = check_tray(model, xml)
    actuators = check_actuators(model)
    spanner_loads = check_spanner_model()
    force = np.array([a["modelForceRangeNm"][1] for a in actuators])
    workflow, cases = check_workflow_torque(args.study)
    any_pose = check_any_pose_torque()
    report = dict(
        mujoco=mujoco.__version__,
        gravity=model.opt.gravity.tolist(),
        assetsSha256=hashlib.sha256(
            (ROOT / "assets/bakery-mujoco/fr10-workcell/native/assets.json").read_bytes()
        ).hexdigest(),
        links=links,
        armMovingMassKg=sum(l["modelMassKg"] for l in links[1:]),
        armModelMassKg=sum(l["modelMassKg"] for l in links),
        toolParts=parts,
        toolBodies=bodies,
        toolMassKg=sum(b["modelMassKg"] for b in bodies),
        tray=tray,
        actuators=actuators,
        spannerLoads=spanner_loads,
        joints=JOINTS,
        workflowMaxGravityTorqueNm=workflow.round(3).tolist(),
        workflowShareOfRange=(workflow / force).round(3).tolist(),
        anyPoseGravityTorqueBoundNm=any_pose.round(3).tolist(),
        anyPoseShareOfRange=(any_pose / force).round(3).tolist(),
        cases=cases,
    )
    passed = (
        all(row["agrees"] for row in links + parts + bodies + actuators + spanner_loads)
        and tray["withinMetalRange"]
        and bool(np.all(workflow < force))
    )
    report["passed"] = passed
    print(json.dumps(report, indent=2))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
