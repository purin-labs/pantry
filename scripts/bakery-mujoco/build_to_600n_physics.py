"""Build and verify the MuJoCo mechanical, hot/cold mixing valve, recoil spring, and pre-rinse spray jet model for the Sugico Sangyo TO-600N."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/sugico-to-600n"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "to600_base",
    "to600_hot_handle",
    "to600_cold_handle",
    "to600_spring_arm",
    "to600_spray_head",
    "to600_trigger",
)

# Published unit mass = 3.850 kg (exact sum across all 6 retained bodies)
MASSES = {
    "to600_base": 2.180,
    "to600_hot_handle": 0.160,
    "to600_cold_handle": 0.160,
    "to600_spring_arm": 0.780,
    "to600_spray_head": 0.480,
    "to600_trigger": 0.090,
}

CENTERS = {
    "to600_base": (0.0, 0.032, 0.165),
    "to600_hot_handle": (-0.048, 0.0, 0.004),
    "to600_cold_handle": (0.048, 0.0, 0.004),
    "to600_spring_arm": (0.036, 0.018, 0.030),
    "to600_spray_head": (0.0, -0.008, -0.105),
    "to600_trigger": (0.0, -0.004, -0.050),
}

INERTIAS = {
    "to600_base": (0.0580, 0.0720, 0.0185),
    "to600_hot_handle": (1.2e-5, 1.8e-4, 1.8e-4),
    "to600_cold_handle": (1.2e-5, 1.8e-4, 1.8e-4),
    "to600_spring_arm": (0.0115, 0.0125, 0.0042),
    "to600_spray_head": (0.0021, 0.0021, 0.00035),
    "to600_trigger": (9.5e-5, 9.5e-5, 1.2e-5),
}

SCALAR_VISUAL_MOTIONS = {
    "to600_hot_valve": [0, 0, 1],
    "to600_cold_valve": [0, 0, -1],
    "to600_arm_pitch": [1, 0, 0],
    "to600_head_tilt": [1, 0, 0],
    "to600_trigger_squeeze": [1, 0, 0],
}


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "sugico-to-600n.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every mesh under to600_base to its nearest ancestor in NAMES while preserving world pose
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
            continue
        parent = obj.parent
        while parent is not None and parent not in parts:
            parent = parent.parent
        if parent is None:
            continue
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
        if obj.type == "MESH" and len(obj.data.vertices) >= 3:
            for axis_idx in range(3):
                coords = [v.co[axis_idx] for v in obj.data.vertices]
                if max(coords) - min(coords) < 1e-5:
                    obj.data.vertices[0].co[axis_idx] += 2e-5
                    obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.25
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    app = ET.Element(
        "mujoco",
        model="sugico-to-600n — commercial pre-rinse spray unit",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="pedestal_plane",
        type="plane",
        size="1.0 1.0 0.05",
        rgba="0.32 0.34 0.37 1",
        contype="1",
        conaffinity="3",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "to600_base" else None)
        )
        parent_el = bodies.get(parent_obj.name) if parent_obj else None
        transform = (
            poses[name]
            if parent_obj is None
            else poses[parent_obj.name].inverted() @ poses[name]
        )
        body = ET.SubElement(
            world if parent_el is None else parent_el,
            "body",
            name=name,
            pos=numbers(transform.translation),
            quat=numbers(transform.to_quaternion()),
        )
        ET.SubElement(
            body,
            "inertial",
            mass=str(MASSES[name]),
            pos=numbers(CENTERS[name]),
            diaginertia=numbers(INERTIAS[name]),
        )
        ET.SubElement(body, "include", file=f"visual_{name}.xml")
        bodies[name] = body

    base = bodies["to600_base"]
    hot = bodies["to600_hot_handle"]
    cold = bodies["to600_cold_handle"]
    arm = bodies["to600_spring_arm"]
    head = bodies["to600_spray_head"]
    trig = bodies["to600_trigger"]

    # Base mounting flanges on Z = 0, 263x47mm mixer manifold, 614mm riser, and rear wall bracket collision primitives
    for fl_name, fx in (("to600_flange_hot_col", -0.1016), ("to600_flange_cold_col", 0.1016)):
        ET.SubElement(
            base,
            "geom",
            name=fl_name,
            type="cylinder",
            pos=numbers((fx, 0.0320, 0.0120)),
            size="0.0220 0.0120",
            contype="2",
            conaffinity="1",
            group="3",
        )
    ET.SubElement(
        base,
        "geom",
        name="to600_mixer_col",
        type="box",
        pos="0 0.0320 0.0450",
        size="0.1315 0.0235 0.0190",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        base,
        "geom",
        name="to600_riser_col",
        type="cylinder",
        pos="0 0.0320 0.3330",
        size="0.0100 0.3070",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        base,
        "geom",
        name="to600_wall_bracket_col",
        type="box",
        pos="0 0.0540 0.4950",
        size="0.0220 0.0225 0.0180",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="to600_deck_mount_site",
        pos="0 0.0320 0",
        size="0.006",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="to600_rest_hook_site",
        pos="0 -0.0240 0.3200",
        size="0.006",
        group="3",
    )

    # Left red-indexed hot water quarter-turn lever handle (axis 0 0 1, range 0 .. 1.5708 rad)
    ET.SubElement(
        hot,
        "joint",
        name="to600_hot_valve",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="0 1.5708",
        damping="0.35",
        armature="0.002",
    )
    ET.SubElement(
        hot,
        "geom",
        name="to600_hot_handle_col",
        type="box",
        pos="-0.05945 0 0.0040",
        size="0.05145 0.0075 0.0040",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Right blue-indexed cold water quarter-turn lever handle (axis 0 0 -1, range 0 .. 1.5708 rad)
    ET.SubElement(
        cold,
        "joint",
        name="to600_cold_valve",
        type="hinge",
        axis="0 0 -1",
        limited="true",
        range="0 1.5708",
        damping="0.35",
        armature="0.002",
    )
    ET.SubElement(
        cold,
        "geom",
        name="to600_cold_handle_col",
        type="box",
        pos="0.05945 0 0.0040",
        size="0.05145 0.0075 0.0040",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Overhead spring-loaded hose arm (axis 1 0 0, range -0.15 .. 0.55 rad with spring stiffness)
    ET.SubElement(
        arm,
        "joint",
        name="to600_arm_pitch",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.15 0.55",
        stiffness="14.0",
        damping="1.20",
        armature="0.008",
    )
    ET.SubElement(
        arm,
        "geom",
        name="to600_spring_col",
        type="cylinder",
        pos="0 -0.0120 0.1200",
        size="0.0170 0.1050",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Spray head & 140 mm grip swiveling at hose end (child of to600_spring_arm, axis 1 0 0, range -0.45 .. 0.45 rad)
    ET.SubElement(
        head,
        "joint",
        name="to600_head_tilt",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.45 0.45",
        stiffness="2.5",
        damping="0.30",
        armature="0.003",
    )
    ET.SubElement(
        head,
        "geom",
        name="to600_grip_col",
        type="cylinder",
        pos="0 0 -0.0740",
        size="0.0145 0.0660",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        head,
        "geom",
        name="to600_bumper_col",
        type="cylinder",
        pos="0 -0.0225 -0.2035",
        size="0.0300 0.0075",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        head,
        "site",
        name="to600_spray_nozzle_site",
        pos="0 -0.0225 -0.2110",
        size="0.006",
        group="3",
    )

    # Hand-squeeze trigger lever (child of to600_spray_head, axis 1 0 0, range 0 .. 0.42 rad)
    ET.SubElement(
        trig,
        "joint",
        name="to600_trigger_squeeze",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.42",
        stiffness="3.2",
        damping="0.18",
        armature="0.001",
    )
    ET.SubElement(
        trig,
        "geom",
        name="to600_trigger_col",
        type="box",
        pos="0 -0.0060 -0.0540",
        size="0.0075 0.0035 0.0540",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="to600_hot_valve_actuator",
        joint="to600_hot_valve",
        kp="25",
        kv="1.8",
        ctrlrange="0 1.5708",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="to600_cold_valve_actuator",
        joint="to600_cold_valve",
        kp="25",
        kv="1.8",
        ctrlrange="0 1.5708",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="to600_arm_pitch_actuator",
        joint="to600_arm_pitch",
        kp="140",
        kv="8.0",
        ctrlrange="-0.15 0.55",
        forcerange="-35 35",
    )
    ET.SubElement(
        actuators,
        "position",
        name="to600_head_tilt_actuator",
        joint="to600_head_tilt",
        kp="60",
        kv="3.0",
        ctrlrange="-0.45 0.45",
        forcerange="-15 15",
    )
    ET.SubElement(
        actuators,
        "position",
        name="to600_trigger_actuator",
        joint="to600_trigger_squeeze",
        kp="110",
        kv="3.5",
        ctrlrange="0 0.42",
        forcerange="-18 18",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="to600_hot_valve_pos", joint="to600_hot_valve")
    ET.SubElement(sensors, "jointpos", name="to600_cold_valve_pos", joint="to600_cold_valve")
    ET.SubElement(sensors, "jointpos", name="to600_arm_pitch_pos", joint="to600_arm_pitch")
    ET.SubElement(sensors, "jointpos", name="to600_head_tilt_pos", joint="to600_head_tilt")
    ET.SubElement(
        sensors, "jointpos", name="to600_trigger_pos", joint="to600_trigger_squeeze"
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="to600_nozzle_sense",
        objtype="site",
        objname="to600_spray_nozzle_site",
        reftype="site",
        refname="to600_deck_mount_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 3.850,
                "component_masses_kg": MASSES,
                "plumbing_ratings": {
                    "inlet_connections": "1/2 NPS x 2 (203.2 mm centers)",
                    "temperature_range_c": [4.4, 82.2],
                    "pressure_range_psi": [15.0, 125.0],
                    "pressure_range_mpa": [0.10, 0.86],
                    "rated_prerinse_spray_l_min_at_0_35mpa": 4.80,
                },
                "scope": (
                    "Articulated MuJoCo mechanical, hot/cold dual-lever header mixing, overhead "
                    "recoil-spring arm pitch, swiveling 211 mm spray valve, and 140 mm grip squeeze-trigger "
                    "pre-rinse jet model."
                ),
            },
            indent=2,
        )
        + "\n"
    )


def strip_visual_meshes(root: ET.Element, model):
    for parent in root.iter():
        for geom in list(parent):
            if geom.tag != "geom" or not geom.get("name"):
                continue
            index = model.geom(geom.get("name")).id
            if (
                model.geom_contype[index] == 0
                and model.geom_conaffinity[index] == 0
                and geom.get("type") == "mesh"
                and geom.get("mass") == "0"
            ):
                parent.remove(geom)


def export_native_xml(mujoco, np):
    spec = mujoco.MjSpec.from_file(str(ASSETS / "scene.xml"))
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    root = ET.fromstring(spec.to_xml())
    strip_visual_meshes(root, model)
    used_meshes = {geom.get("mesh") for geom in root.iter("geom")}
    used_materials = {geom.get("material") for geom in root.iter("geom")}
    assets = root.find("asset")
    if assets is not None:
        for asset in list(assets):
            if (asset.tag == "mesh" and asset.get("name") not in used_meshes) or (
                asset.tag == "material" and asset.get("name") not in used_materials
            ):
                assets.remove(asset)
    ET.indent(root, space="  ")
    native_path = ASSETS / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(
            getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9
        ):
            raise RuntimeError(f"Export changed native {field} for sugico-to-600n")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError("Export changed native degrees of freedom for sugico-to-600n")
    return rebuilt


def verify_frame_and_motion_alignment(mujoco, native_model, evidence_dir: Path):
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)
    native_sha = hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest()
    glb_str = str(ASSETS / "sugico-to-600n.glb")

    # 1. Rest-frame alignment across all 6 retained bodies in NAMES
    body_poses = {}
    for bname in NAMES:
        bid = native_model.body(bname).id
        pos = native_data.xpos[bid]
        quat = native_data.xquat[bid]
        body_poses[bname] = [
            float(pos[0]),
            float(pos[1]),
            float(pos[2]),
            float(quat[0]),
            float(quat[1]),
            float(quat[2]),
            float(quat[3]),
        ]
    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                "sugico-to-600n": {
                    "glb": glb_str,
                    "native_sha256": native_sha,
                    "bodies": body_poses,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(frames_in),
            str(frames_out),
        ],
        check=True,
    )
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    # 2. Sampled scalar-joint motion alignment (21 samples per scalar joint across all 5 joints)
    motions = []
    for joint_name, axis in SCALAR_VISUAL_MOTIONS.items():
        jid = native_model.joint(joint_name).id
        jtype = int(native_model.jnt_type[jid])
        kind = "hinge" if jtype == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        low, high = native_model.jnt_range[jid]
        bid = int(native_model.jnt_bodyid[jid])
        samples = []
        for idx in range(21):
            val = float(low + (high - low) * idx / 20.0)
            mujoco.mj_resetData(native_model, native_data)
            native_data.qpos[native_model.jnt_qposadr[jid]] = val
            mujoco.mj_forward(native_model, native_data)
            samples.append(
                {
                    "value": val,
                    "pose": [
                        *native_data.xpos[bid].tolist(),
                        *native_data.xquat[bid].tolist(),
                    ],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": axis,
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                "sugico-to-600n": {
                    "glb": glb_str,
                    "native_sha256": native_sha,
                    "motions": motions,
                }
            },
            indent=2,
        )
        + "\n"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/bakery-mujoco/inspect_appliance_frames.mjs"),
            str(motion_in),
            str(motion_out),
            "--motion",
        ],
        check=True,
    )
    motion_report = json.loads(motion_out.read_text())
    assert motion_report["passed"] is True, motion_report
    return frames_report, motion_report


def write_asset_docs(report: dict):
    s = report["stages"]
    readme = f"""# Sugico Sangyo TO-600N — Blender Visual & MuJoCo Physics Package

Commercial deck-mounted pre-rinse spray unit (`スギコ産業 プリリンスシャワーユニット TO-600N`), modeled at `425 × 153 × 640 mm` (`0.425 × 0.153 × 0.640 m`, `Z = 0` at deck mounting flange) with a stadium-plan `263 × 47 mm` chrome-plated cast-brass mixer manifold (`TO-600-7N`, `1/2 NPS × 2` hot/cold inlets on `203.2 mm` centers), sculpted quarter-turn red/blue lever handles (`4.4–82.2 °C`, `0.10–0.86 MPa` / `15–125 psi`), `614 mm` chrome riser pipe, cut-to-fit rear wall bracket, chrome-plated steel overhead recoil spring, `937 mm` `SUS304`-armored flexible hose, and `211 mm` spray head (`TO-600-1N(S)`) with `140 mm` cobalt-blue nylon grip, matching cobalt-blue squeeze trigger, and matte-black `ABS` dish-guard bumper (`3.850 kg`).

See the [equipment specification sheet](../../../docs/equipment/sugico-to-600n/README.md) for verified dimensions and plumbing ratings.

![Sugico TO-600N studio main](studio-main.png)
![Sugico TO-600N active state](studio-active.png)

## Files

- [Editable Blender 5.2 source](sugico-to-600n.blend) and [rest-frame GLB](sugico-to-600n.glb).
- Metal GPU Cycles studio renders (`1400 × 1200`, `48` samples): [main](studio-main.png), [front](studio-front.png), [top](studio-top.png), [right](studio-right.png), and [active](studio-active.png).
- Verification manifests: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), and [physics-export.json](physics-export.json).
- MuJoCo 3.13 MJCF packages: [appliance.xml](appliance.xml), [scene.xml](scene.xml), and collision-only [native.xml](native.xml).
- Active-state & frame-alignment evidence: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Retained Physics Bodies

| Body | Parent | Joint | Range | Mass (`kg`) | Role |
| --- | --- | --- | --- | --- | --- |
| `to600_base` | `worldbody` | fixed | — | `2.180` | `263 × 47 mm` chrome brass mixer on `Z = 0` flange, `614 mm` riser, wall bracket & rest hook |
| `to600_hot_handle` | `to600_base` | `to600_hot_valve` (`hinge` `+Z`) | `0 .. 1.5708 rad` | `0.160` | Left red-indexed hot water quarter-turn lever handle |
| `to600_cold_handle` | `to600_base` | `to600_cold_valve` (`hinge` `-Z`) | `0 .. 1.5708 rad` | `0.160` | Right blue-indexed cold water quarter-turn lever handle |
| `to600_spring_arm` | `to600_base` | `to600_arm_pitch` (`hinge` `+X`) | `-0.15 .. 0.55 rad` | `0.780` | Overhead recoil-spring arm & `937 mm` `SUS304`-armored flexible hose |
| `to600_spray_head` | `to600_spring_arm` | `to600_head_tilt` (`hinge` `+X`) | `-0.45 .. 0.45 rad` | `0.480` | `211 mm` spray valve & `140 mm` insulated grip at hose end |
| `to600_trigger` | `to600_spray_head` | `to600_trigger_squeeze` (`hinge` `+X`) | `0 .. 0.42 rad` | `0.090` | Hand-squeeze lever opening the high-velocity pre-rinse jet |

Total published unit mass: `{report['unit_mass_kg']:.3f} kg`.
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Sugico Sangyo TO-600N — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded samples (`trace.csv` SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`valves_closed_standby`**: Both hot and cold quarter-turn valves closed (`0.0°`), header depressurized (`0.00 MPa`), spray discharge `0.00 L/min`.
2. **`mixed_header_42c_zero_spray`**: Hot (`60.0 °C` supply, `{s['mixed_header_42c_zero_spray']['hot_valve_deg']}°`) and cold (`15.0 °C` supply, `{s['mixed_header_42c_zero_spray']['cold_valve_deg']}°`) valves opened to pressurize the mixed riser/hose header at `{s['mixed_header_42c_zero_spray']['mixed_header_temp_c']} °C` and `{s['mixed_header_42c_zero_spray']['header_pressure_mpa']} MPa`, maintaining `0.00 L/min` spray while the trigger remains released (`0.0°`).
3. **`pull_arm_and_squeeze_prerinse_jet`**: Overhead recoil spring arm pulled forward/down (`{s['pull_arm_and_squeeze_prerinse_jet']['arm_pitch_deg']}°`), `211 mm` spray head angled (`{s['pull_arm_and_squeeze_prerinse_jet']['head_tilt_deg']}°`), and hand trigger squeezed (`{s['pull_arm_and_squeeze_prerinse_jet']['trigger_squeeze_deg']}°`) to deliver `{s['pull_arm_and_squeeze_prerinse_jet']['spray_flow_l_min']} L/min` at `{s['pull_arm_and_squeeze_prerinse_jet']['mixed_header_temp_c']} °C` (`jet_thrust = {s['pull_arm_and_squeeze_prerinse_jet']['jet_reaction_n']} N`).
4. **`release_trigger_and_spring_return`**: Trigger released (`{s['release_trigger_and_spring_return']['trigger_squeeze_deg']}°` -> immediate `0.00 L/min` shutoff under `0.35 MPa` static header) and overhead recoil spring returns the hose arm into its riser rest hook (`{s['release_trigger_and_spring_return']['arm_pitch_deg']}°`).
5. **`close_valves_and_rest_frame_verified`**: Hot and cold valves closed (`0.00 MPa`), passing `inspect_appliance_frames.mjs` at rest (`max_pos_err = {s['close_valves_and_rest_frame_verified']['rest_max_position_error_m']:.2e} m`) and across 21-sample `--motion` sweeps for all 5 scalar joints (`max_pos_err = {s['close_valves_and_rest_frame_verified']['motion_max_position_error_m']:.2e} m`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    native_model = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    supply_pressure_mpa = 0.35
    hot_supply_c = 60.0
    cold_supply_c = 15.0

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, mode_label: str = "standby"):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            hot_rad = float(data.sensor("to600_hot_valve_pos").data[0])
            cold_rad = float(data.sensor("to600_cold_valve_pos").data[0])
            arm_rad = float(data.sensor("to600_arm_pitch_pos").data[0])
            head_rad = float(data.sensor("to600_head_tilt_pos").data[0])
            trig_rad = float(data.sensor("to600_trigger_pos").data[0])
            noz_rel = data.sensor("to600_nozzle_sense").data

            # Quarter-turn ceramic cartridge conductance (linear above 0.05 rad deadband)
            g_hot = max(0.0, min(1.0, (hot_rad - 0.05) / (1.5708 - 0.05)))
            g_cold = max(0.0, min(1.0, (cold_rad - 0.05) / (1.5708 - 0.05)))
            g_total = g_hot + g_cold

            if g_total > 1e-4:
                mixed_temp_c = (g_hot * hot_supply_c + g_cold * cold_supply_c) / g_total
                static_header_mpa = supply_pressure_mpa * min(1.0, g_total / 0.35)
            else:
                mixed_temp_c = 22.0
                static_header_mpa = 0.0

            trig_frac = max(0.0, min(1.0, (trig_rad - 0.03) / (0.38 - 0.03)))
            if static_header_mpa > 0.0 and trig_frac > 0.0:
                dyn_mpa = static_header_mpa * (1.0 - 0.11 * trig_frac)
                # Rated 4.80 L/min pre-rinse spray jet at 0.35 MPa static supply & full trigger squeeze
                spray_l_min = 4.80 * trig_frac * math.sqrt(static_header_mpa / 0.35)
                jet_vel_m_s = 22.5 * math.sqrt(dyn_mpa / 0.31)
                jet_thrust_n = (spray_l_min / 60.0) * jet_vel_m_s
            else:
                dyn_mpa = static_header_mpa
                spray_l_min = 0.0
                jet_thrust_n = 0.0

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": mode_label,
                "hot_valve_deg": round(math.degrees(hot_rad), 2),
                "cold_valve_deg": round(math.degrees(cold_rad), 2),
                "mixed_header_temp_c": round(mixed_temp_c, 2),
                "header_pressure_mpa": round(dyn_mpa, 3),
                "arm_pitch_deg": round(math.degrees(arm_rad), 2),
                "head_tilt_deg": round(math.degrees(head_rad), 2),
                "trigger_squeeze_deg": round(math.degrees(trig_rad), 2),
                "spray_flow_l_min": round(spray_l_min, 2),
                "jet_reaction_n": round(jet_thrust_n, 2),
                "nozzle_rel_y_m": round(float(noz_rel[1]), 4),
                "nozzle_rel_z_m": round(float(noz_rel[2]), 4),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Valves closed (0 L/min, 0 MPa)
    snap1 = step_and_sample(0.36, mode_label="valves_closed_standby")
    assert snap1["spray_flow_l_min"] == 0.0 and snap1["header_pressure_mpa"] == 0.0, snap1
    assert abs(snap1["arm_pitch_deg"]) < 0.8, snap1
    stage_summaries["valves_closed_standby"] = snap1

    # Stage 2: Open hot (60 °C) & cold (15 °C) valves in 60:40 conductance ratio -> 42.0 °C mixed header at 0.35 MPa, zero spray while trigger released
    # g_hot = 0.72 -> hot_rad = 0.05 + 0.72 * 1.5208 = 1.1450 rad
    # g_cold = 0.48 -> cold_rad = 0.05 + 0.48 * 1.5208 = 0.7800 rad  (0.72 : 0.48 = 60 : 40 -> exact 42.0 °C!)
    data.ctrl[model.actuator("to600_hot_valve_actuator").id] = 1.1450
    data.ctrl[model.actuator("to600_cold_valve_actuator").id] = 0.7800
    snap2 = step_and_sample(0.48, mode_label="mixed_header_pressurized_zero_spray")
    assert abs(snap2["mixed_header_temp_c"] - 42.0) <= 0.4, snap2
    assert abs(snap2["header_pressure_mpa"] - 0.350) <= 0.005, snap2
    assert snap2["spray_flow_l_min"] == 0.0, snap2
    stage_summaries["mixed_header_42c_zero_spray"] = snap2

    # Stage 3: Pull overhead recoil spring arm forward/down, aim spray head, and squeeze trigger -> 4.80 L/min high-velocity pre-rinse jet
    data.ctrl[model.actuator("to600_arm_pitch_actuator").id] = 0.480
    data.ctrl[model.actuator("to600_head_tilt_actuator").id] = -0.440
    data.ctrl[model.actuator("to600_trigger_actuator").id] = 0.415
    snap3 = step_and_sample(0.56, mode_label="prerinse_high_velocity_spray_active")
    assert snap3["arm_pitch_deg"] > 22.0, snap3
    assert snap3["trigger_squeeze_deg"] > 21.0, snap3
    assert abs(snap3["spray_flow_l_min"] - 4.80) <= 0.05, snap3
    assert snap3["nozzle_rel_y_m"] < -0.079 and snap3["nozzle_rel_z_m"] < 0.165, snap3
    stage_summaries["pull_arm_and_squeeze_prerinse_jet"] = snap3

    # Stage 4: Release squeeze trigger (instant shutoff) & release overhead spring arm to recoil back into rest hook
    data.ctrl[model.actuator("to600_trigger_actuator").id] = 0.0
    data.ctrl[model.actuator("to600_head_tilt_actuator").id] = 0.0
    data.ctrl[model.actuator("to600_arm_pitch_actuator").id] = 0.0
    snap4 = step_and_sample(0.56, mode_label="trigger_shutoff_and_spring_return")
    assert snap4["spray_flow_l_min"] == 0.0, snap4
    assert snap4["header_pressure_mpa"] == 0.350, snap4
    assert abs(snap4["arm_pitch_deg"]) < 1.0, snap4
    stage_summaries["release_trigger_and_spring_return"] = snap4

    # Stage 5: Close hot & cold quarter-turn valves & verify rest + 21-sample motion frame alignment
    data.ctrl[model.actuator("to600_hot_valve_actuator").id] = 0.0
    data.ctrl[model.actuator("to600_cold_valve_actuator").id] = 0.0
    snap5 = step_and_sample(0.48, mode_label="rest_closed")
    assert snap5["hot_valve_deg"] < 0.8 and snap5["cold_valve_deg"] < 0.8, snap5
    assert snap5["header_pressure_mpa"] == 0.0 and snap5["spray_flow_l_min"] == 0.0, snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frame_and_motion_alignment(
        mujoco, native_model, evidence_dir
    )

    stage_summaries["close_valves_and_rest_frame_verified"] = {
        "rest_snap": snap5,
        "frames_aligned": len(frames_report["appliances"]["sugico-to-600n"]["frames"]),
        "rest_max_position_error_m": max(
            f["position_error_m"]
            for f in frames_report["appliances"]["sugico-to-600n"]["frames"]
        ),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"]
            for f in frames_report["appliances"]["sugico-to-600n"]["frames"]
        ),
        "scalar_joints_motion_verified": len(
            motion_report["appliances"]["sugico-to-600n"]["motions"]
        ),
        "motion_max_position_error_m": max(
            m["position_error_m"]
            for m in motion_report["appliances"]["sugico-to-600n"]["motions"]
        ),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"]
            for m in motion_report["appliances"]["sugico-to-600n"]["motions"]
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "sugico-to-600n",
        "model_title": "Sugico Sangyo TO-600N Commercial Pre-Rinse Spray Unit",
        "envelope_m": [0.425, 0.153, 0.640],
        "unit_mass_kg": round(sum(MASSES.values()), 3),
        "plumbing_ratings": "1/2 NPS x 2, 4.4–82.2 °C, 15–125 psi (0.10–0.86 MPa)",
        "rated_spray_flow_l_min": 4.80,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_asset_docs(report)
    print(json.dumps(report, indent=2))


def main():
    if "--blender-export" in sys.argv:
        export_blender_meshes_and_xml()
        return

    subprocess.run(
        [
            str(BLENDER_BIN),
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).resolve()),
            "--",
            "--blender-export",
        ],
        check=True,
    )
    run_active_state_verification()


if __name__ == "__main__":
    main()
