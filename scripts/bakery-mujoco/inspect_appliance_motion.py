"""Compare exported attachment frames across scalar-joint motion, without stepping physics.

The visual axes below follow build_*_visuals.py and the existing visual inspectors.
MuJoCo supplies independent joint axes, pivots and modeled travel limits.
Rust remains the only workflow runner. This script uses forward kinematics only.
"""

import argparse
import copy
import hashlib
import json
import math
import shutil
import struct
import subprocess
from pathlib import Path

import mujoco

from verify_rust_appliances import ROOT

# Axis conventions belong to the authored Blender local frame. GLB export
# converts them to Y-up. Free vessels/tools need recorded handling acceptance.
VISUAL_MOTIONS = {
    "aicoh-ms-30": {
        "mix_lift": (0, 0, 1),
        "mix_guard": (0, 0, 1),
        "mix_orbit": (0, 0, 1),
        "mix_spin": (0, 0, 1),
    },
    "hobart-hl200": {
        "mix_lift": (0, 0, 1),
        "mix_guard": (0, 0, 1),
        "mix_orbit": (0, 0, 1),
        "mix_spin": (0, 0, 1),
    },
    "vitamix-quiet-one": {
        "tqo_door": (1, 0, 0),
        "tqo_lid_lift": (0, 0, 1),
        "tqo_spin": (0, 0, 1),
    },
    "waring-wsg60": {
        "wsg_unlock": (0, 0, 1),
        "wsg_cover_lift": (0, 0, 1),
        "wsg_spin": (0, 0, 1),
    },
    "severin-sm-3587": {"sm3587_lid_lift": (0, 0, 1), "sm3587_stirrer_spin": (0, 0, 1)},
    "maruzen-mbco-5e": {"mbco_door_hinge": (0, 0, -1), "mbco_handle_turn": (0, -1, 0)},
    "hoshizaki-rt-120snj": {"rt_left_hinge": (0, 0, -1), "rt_right_hinge": (0, 0, 1)},
    "winterhalter-uc-l": {"ucl_door_hinge": (1, 0, 0), "ucl_rack_slide": (0, 1, 0)},
}


def sample_appliance(name, joints):
    directory = ROOT / "assets/bakery-mujoco" / name
    native = directory / "native.xml"
    model = mujoco.MjModel.from_xml_path(str(native))
    data = mujoco.MjData(model)
    motions = []
    for joint_name, axis in joints.items():
        joint = model.joint(joint_name).id
        joint_type = int(model.jnt_type[joint])
        kind = "hinge" if joint_type == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        assert joint_type in (
            int(mujoco.mjtJoint.mjJNT_HINGE),
            int(mujoco.mjtJoint.mjJNT_SLIDE),
        )
        low, high = (
            model.jnt_range[joint] if model.jnt_limited[joint] else (0, math.tau)
        )
        body = int(model.jnt_bodyid[joint])
        samples = []
        for index in range(201):
            value = float(low + (high - low) * index / 200)
            mujoco.mj_resetData(model, data)
            data.qpos[model.jnt_qposadr[joint]] = value
            mujoco.mj_forward(model, data)
            samples.append(
                {
                    "value": value,
                    "pose": [*data.xpos[body].tolist(), *data.xquat[body].tolist()],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": model.body(body).name,
                "kind": kind,
                "visual_axis": axis,
                "samples": samples,
            }
        )
    return {
        "glb": str(directory / f"{name}.glb"),
        "native_sha256": hashlib.sha256(native.read_bytes()).hexdigest(),
        "motions": motions,
    }


def run_inspector(references, output, label):
    source = output / f"{label}-poses.json"
    destination = output / f"{label}-report.json"
    source.write_text(json.dumps(references, indent=2) + "\n")
    result = subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(source),
            str(destination),
            "--motion",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    (output / f"{label}.log").write_text(result.stdout + result.stderr)
    report = json.loads(destination.read_text())
    assert (result.returncode == 0) == report["passed"], label
    return report


def faulty_glb(source, destination, fault):
    data = Path(source).read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + length])
    node = next(
        node for node in document["nodes"] if node.get("name") == "tqo_enclosure_door"
    )
    if fault == "missing-body":
        node["name"] = "Injected missing enclosure frame"
    else:
        node.setdefault("translation", [0, 0, 0])[0] += 0.01
    chunk = json.dumps(document, separators=(",", ":")).encode()
    chunk += b" " * (-len(chunk) % 4)
    remainder = data[20 + length :]
    destination.write_bytes(
        struct.pack("<III", 0x46546C67, 2, 20 + len(chunk) + len(remainder))
        + struct.pack("<I", len(chunk))
        + b"JSON"
        + chunk
        + remainder
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    references = {
        name: sample_appliance(name, joints) for name, joints in VISUAL_MOTIONS.items()
    }
    for name, reference in references.items():
        destination = args.output / name / f"{name}.glb"
        destination.parent.mkdir()
        shutil.copy2(reference["glb"], destination)
        reference["glb"] = str(destination.resolve())
    for fault in ("missing-body", "displaced-pivot"):
        reference = copy.deepcopy(references["vitamix-quiet-one"])
        path = args.output / f"{fault}.glb"
        faulty_glb(reference["glb"], path, fault)
        reference["glb"] = str(path.resolve())
        report = run_inspector({"vitamix-quiet-one": reference}, args.output, fault)
        results = report["appliances"]["vitamix-quiet-one"]["motions"]
        failure = next(result for result in results if result["joint"] == "tqo_door")
        assert not failure["passed"], (fault, failure)
        if fault == "missing-body":
            assert failure["error"] == "missing-visual-body"
        else:
            assert failure["position_error_m"] > 0.009
    report = run_inspector(references, args.output, "motion")
    assert report["passed"], "Moved-frame comparison failed; inspect motion-report.json"
    verification = args.output / "verification"
    verification.mkdir()
    shutil.copy2(__file__, verification / Path(__file__).name)
    shutil.copy2(
        ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs", verification
    )
    print("Moved-frame comparison and both injected-fault checks passed.")


if __name__ == "__main__":
    main()
