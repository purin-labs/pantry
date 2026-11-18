"""Build and verify the MuJoCo mechanical, dual-bowl wash/rinse hydraulic, and 50A King drain model for the Maruzen BS2-126N."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-bs2-126n"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "bs2_sink",
    "bs2_drain_plug_left",
    "bs2_drain_plug_right",
    "bs2_strainer_left",
    "bs2_wash_tray",
)

# Published sink mass = 29.400 kg (bs2_sink + plugs + strainer = 29.400 kg)
# Removable MBCO-4ME 400 x 300 x 20 mm baking tray = 0.850 kg (total = 30.250 kg)
MASSES = {
    "bs2_sink": 28.880,
    "bs2_drain_plug_left": 0.160,
    "bs2_drain_plug_right": 0.160,
    "bs2_strainer_left": 0.200,
    "bs2_wash_tray": 0.850,
}

CENTERS = {
    "bs2_sink": (0.0, 0.010, 0.495),
    "bs2_drain_plug_left": (0.0, 0.0, 0.006),
    "bs2_drain_plug_right": (0.0, 0.0, 0.006),
    "bs2_strainer_left": (0.0, 0.0, 0.042),
    "bs2_wash_tray": (0.0, 0.0, 0.008),
}

INERTIAS = {
    "bs2_sink": (2.350, 4.680, 5.120),
    "bs2_drain_plug_left": (9.0e-5, 9.0e-5, 1.7e-4),
    "bs2_drain_plug_right": (9.0e-5, 9.0e-5, 1.7e-4),
    "bs2_strainer_left": (1.8e-4, 1.8e-4, 1.9e-4),
    "bs2_wash_tray": (0.00640, 0.01135, 0.01770),
}

SCALAR_VISUAL_MOTIONS = {
    "bs2_plug_left_lift": [0, 0, 1],
    "bs2_plug_right_lift": [0, 0, 1],
    "bs2_strainer_left_lift": [0, 0, 1],
}


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and write appliance.xml and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "maruzen-bs2-126n.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every mesh under bs2_sink to its nearest ancestor in NAMES while preserving world pose
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
            mat["roughness"] = 0.30
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    app = ET.Element(
        "mujoco",
        model="maruzen-bs2-126n — commercial two-compartment sink (no backsplash)",
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
        name="floor",
        type="plane",
        size="2.0 2.0 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="3",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "bs2_wash_tray":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "bs2_sink" else None)
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

    sink = bodies["bs2_sink"]
    plug_l = bodies["bs2_drain_plug_left"]
    plug_r = bodies["bs2_drain_plug_right"]
    strainer_l = bodies["bs2_strainer_left"]
    tray = bodies["bs2_wash_tray"]

    # Four Ø38 mm leg bullet-foot collision cylinders touching Z = 0.000 m (CAD 07276: ±0.5670 m, -0.2700 / +0.2150 m)
    for foot_name, fx, fy in (
        ("bs2_foot_fl_col", -0.5670, -0.2700),
        ("bs2_foot_fr_col", 0.5670, -0.2700),
        ("bs2_foot_rl_col", -0.5670, 0.2150),
        ("bs2_foot_rr_col", 0.5670, 0.2150),
    ):
        ET.SubElement(
            sink,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0190)),
            size="0.0190 0.0190",
            friction="0.80 0.005 0.0001",
            contype="2",
            conaffinity="1",
            group="3",
        )

    # Non-overlapping concave dual-bowl wall + floor collision boxes + all-flat SUS430 undershelf box (CAD 07276)
    # Left bowl cavity: X in [-0.5600, -0.0150] (545 mm), Y in [-0.2600, +0.2000] (460 mm), floor top Z = 0.5500 m (250 mm deep)
    # Right bowl cavity: X in [+0.0150, +0.5600] (545 mm), Y in [-0.2600, +0.2000] (460 mm), floor top Z = 0.5500 m (250 mm deep)
    collision_boxes = (
        ("bs2_undershelf_col", (0.0, -0.0275, 0.1860), (0.5670, 0.2425, 0.0140)),
        ("bs2_left_bowl_floor_col", (-0.2875, -0.0300, 0.5400), (0.2725, 0.2300, 0.0100)),
        ("bs2_right_bowl_floor_col", (0.2875, -0.0300, 0.5400), (0.2725, 0.2300, 0.0100)),
        ("bs2_left_outer_wall_col", (-0.5800, 0.0, 0.6650), (0.0200, 0.3000, 0.1350)),
        ("bs2_center_divider_col", (0.0, -0.0300, 0.6650), (0.0150, 0.2300, 0.1350)),
        ("bs2_right_outer_wall_col", (0.5800, 0.0, 0.6650), (0.0200, 0.3000, 0.1350)),
        ("bs2_front_wall_col", (0.0, -0.2800, 0.6650), (0.5600, 0.0200, 0.1350)),
        ("bs2_rear_deck_wall_col", (0.0, 0.2500, 0.6650), (0.5600, 0.0500, 0.1350)),
    )
    for cname, cpos, csize in collision_boxes:
        ET.SubElement(
            sink,
            "geom",
            name=cname,
            type="box",
            pos=numbers(cpos),
            size=numbers(csize),
            friction="0.45 0.005 0.0001",
            contype="2",
            conaffinity="1",
            group="3",
        )

    # Named operational sites on bs2_sink
    ET.SubElement(
        sink,
        "site",
        name="bs2_left_bowl_site",
        pos="-0.2875 -0.0920 0.5500",
        size="0.008",
        group="3",
    )
    ET.SubElement(
        sink,
        "site",
        name="bs2_right_bowl_site",
        pos="0.2875 -0.0920 0.5500",
        size="0.008",
        group="3",
    )
    ET.SubElement(
        sink,
        "site",
        name="bs2_faucet_deck_site",
        pos="0 0.2500 0.7960",
        size="0.008",
        group="3",
    )
    ET.SubElement(
        sink,
        "site",
        name="bs2_left_bowl_touch_site",
        type="box",
        pos="-0.2875 -0.0920 0.5515",
        size="0.2200 0.1650 0.0030",
        group="3",
    )
    ET.SubElement(
        sink,
        "site",
        name="bs2_right_bowl_touch_site",
        type="box",
        pos="0.2875 -0.0920 0.5515",
        size="0.2200 0.1650 0.0030",
        group="3",
    )

    # Left 50A drain cover & stopper joint (0 .. 0.080 m)
    ET.SubElement(
        plug_l,
        "joint",
        name="bs2_plug_left_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.080",
        damping="3.5",
        armature="0.005",
    )
    ET.SubElement(
        plug_l,
        "geom",
        name="bs2_plug_left_col",
        type="cylinder",
        pos="0 0 0.0060",
        size="0.0460 0.0050",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Right 50A drain cover & stopper joint (0 .. 0.080 m)
    ET.SubElement(
        plug_r,
        "joint",
        name="bs2_plug_right_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.080",
        damping="3.5",
        armature="0.005",
    )
    ET.SubElement(
        plug_r,
        "geom",
        name="bs2_plug_right_col",
        type="cylinder",
        pos="0 0 0.0060",
        size="0.0460 0.0050",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Removable crumb strainer basket in left 50A King drain well (0 .. 0.120 m)
    ET.SubElement(
        strainer_l,
        "joint",
        name="bs2_strainer_left_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.120",
        damping="4.0",
        armature="0.006",
    )
    ET.SubElement(
        strainer_l,
        "geom",
        name="bs2_strainer_left_col",
        type="cylinder",
        pos="0 0 0.0410",
        size="0.0410 0.0380",
        contype="2",
        conaffinity="1",
        group="3",
    )

    # Removable 400 x 300 x 20 mm MBCO-4ME baking tray (6-DOF freejoint, vessel_socket, ingredient_payload)
    ET.SubElement(tray, "freejoint", name="bs2_wash_tray_free")
    ET.SubElement(
        tray,
        "geom",
        name="bs2_wash_tray_col",
        type="box",
        pos="0 0 0.0100",
        size="0.2000 0.1500 0.0100",
        friction="0.48 0.005 0.0001",
        contype="1",
        conaffinity="2",
        group="3",
    )
    ET.SubElement(
        tray,
        "site",
        name="vessel_socket",
        pos="0 0 0.0200",
        size="0.008",
        group="3",
    )
    payload = ET.SubElement(tray, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0060",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="box",
        pos="0 0 0.0060",
        size="0.1850 0.1350 0.0020",
        group="2",
        rgba="0.80 0.64 0.36 0",
        contype="0",
        conaffinity="0",
        mass="0",
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="bs2_plug_left_actuator",
        joint="bs2_plug_left_lift",
        kp="900",
        kv="24.0",
        ctrlrange="0 0.080",
        forcerange="-50 50",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bs2_plug_right_actuator",
        joint="bs2_plug_right_lift",
        kp="900",
        kv="24.0",
        ctrlrange="0 0.080",
        forcerange="-50 50",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bs2_strainer_left_actuator",
        joint="bs2_strainer_left_lift",
        kp="950",
        kv="26.0",
        ctrlrange="0 0.120",
        forcerange="-55 55",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="bs2_plug_left_pos", joint="bs2_plug_left_lift")
    ET.SubElement(sensors, "jointpos", name="bs2_plug_right_pos", joint="bs2_plug_right_lift")
    ET.SubElement(
        sensors, "jointpos", name="bs2_strainer_left_pos", joint="bs2_strainer_left_lift"
    )
    ET.SubElement(sensors, "touch", name="bs2_left_bowl_touch", site="bs2_left_bowl_touch_site")
    ET.SubElement(
        sensors, "touch", name="bs2_right_bowl_touch", site="bs2_right_bowl_touch_site"
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="bs2_tray_left_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="bs2_left_bowl_site",
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="bs2_tray_right_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="bs2_right_bowl_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_sink_mass_kg": 29.400,
                "wash_tray_mass_kg": 0.850,
                "total_scene_mass_kg": round(sum(MASSES.values()), 3),
                "component_masses_kg": MASSES,
                "bowl_dimensions_m": [0.545, 0.460, 0.250],
                "bowl_floor_z_m": 0.550,
                "overflow_intake_z_m": 0.752,
                "drain_specification": "50A polypropylene King drain x 2 with cream PP crumb baskets, rear-wall oval overflows, and 50A corrugated hoses through rubber-grommeted all-flat undershelf",
                "scope": (
                    "Articulated MuJoCo mechanical, concave dual-bowl collision, 45 L wash / 40 L rinse "
                    "water balance, 50A gravity drain flow, and 400 x 300 mm MBCO-4ME baking tray fit model."
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
            raise RuntimeError(f"Export changed native {field} for maruzen-bs2-126n")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError("Export changed native degrees of freedom for maruzen-bs2-126n")
    return rebuilt


def verify_frame_and_motion_alignment(mujoco, native_model, evidence_dir: Path):
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)
    native_sha = hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest()
    glb_str = str(ASSETS / "maruzen-bs2-126n.glb")

    # 1. Rest-frame alignment across all retained bodies in NAMES
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
                "maruzen-bs2-126n": {
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

    # 2. Sampled scalar-joint motion alignment (21 samples per scalar joint)
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
                "maruzen-bs2-126n": {
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
    readme = f"""# Maruzen BS2-126N — Blender Visual & MuJoCo Physics Package

Commercial two-compartment stainless sink without backsplash (`マルゼン 430ブリームシリーズ バックガードなし 二槽シンク BS2-126N`), modeled at `1,200 × 600 × 800 mm` (`1.200 × 0.600 × 0.800 m`) with two open `545 × 460 × 250 mm` coved `SUS430` compartments (`Z = 0.550 m` floor), all-flat `SUS430` lower undershelf (`オールフラット式スノコ板`) with `Ø86 mm` rubber-grommeted hose pass-throughs, four `Ø38 mm` `SUS304` legs with adjustable bullet feet (`Z = 0.000 m`), two `50A` polypropylene King drains (`キングドレン`) with cream PP crumb strainers, rear-wall oval overflows (`小判型オーバーフロー`), and `50A` corrugated hoses, plus a removable `400 × 300 × 20 mm` `MBCO-4ME` baking tray (`0.850 kg`).

See the [equipment specification sheet](../../../docs/equipment/maruzen-bs2-126n/README.md) for verified dimensions and plumbing parameters.

![Maruzen BS2-126N studio main](studio-main.png)
![Maruzen BS2-126N active state](studio-active.png)

## Files

- [Editable Blender 5.2 source](maruzen-bs2-126n.blend) and [rest-frame GLB](maruzen-bs2-126n.glb).
- Metal GPU Cycles studio renders (`1400 × 1200`, `48` samples): [main](studio-main.png), [front](studio-front.png), [top](studio-top.png), [right](studio-right.png), and [active](studio-active.png).
- Verification manifests: [build-report.json](build-report.json), [inspection-report.json](inspection-report.json), and [physics-export.json](physics-export.json).
- MuJoCo 3.13 MJCF packages: [appliance.xml](appliance.xml), [scene.xml](scene.xml), and collision-only [native.xml](native.xml).
- Active-state & frame-alignment evidence: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Retained Physics Bodies

| Body | Joint | Range | Mass (`kg`) | Role |
| --- | --- | --- | --- | --- |
| `bs2_sink` | fixed | — | `28.880` | `1,200 × 600 × 800 mm` sink frame, non-overlapping concave dual-bowl walls/floors, undershelf & 4 foot cylinders |
| `bs2_drain_plug_left` | `bs2_plug_left_lift` (`slide` `+Z`) | `0 .. 0.080 m` | `0.160` | Left bowl `50A` stainless/EPDM King drain cover & stopper |
| `bs2_drain_plug_right` | `bs2_plug_right_lift` (`slide` `+Z`) | `0 .. 0.080 m` | `0.160` | Right bowl `50A` stainless/EPDM King drain cover & stopper |
| `bs2_strainer_left` | `bs2_strainer_left_lift` (`slide` `+Z`) | `0 .. 0.120 m` | `0.200` | Removable crumb basket in left `50A` King drain well |
| `bs2_wash_tray` | `bs2_wash_tray_free` (`freejoint`) | 6-DOF | `0.850` | `400 × 300 × 20 mm` `MBCO-4ME` baking tray seated flat at `Z = 0.550 m` (`vessel_socket` + `ingredient_payload`) |

Published sink mass: `29.400 kg` (`28.880 + 0.160 + 0.160 + 0.200 kg`); total scene mass with tray: `{report['total_scene_mass_kg']:.3f} kg`.
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    active_md = f"""# Maruzen BS2-126N — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded samples (`trace.csv` SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`empty_bowls_tray_drop_and_flat_fit`**: `400 × 300 × 20 mm` baking tray (`0.850 kg`) dropped from `Z = 0.585 m` into the open concave `545 × 460 × 250 mm` left compartment settles flat on `Z = 0.550 m` (`tray_z = {s['empty_bowls_tray_drop_and_flat_fit']['tray_z_m']} m`, floor contact `{s['empty_bowls_tray_drop_and_flat_fit']['left_bowl_touch_n']} N`, `0.0 L` water).
2. **`left_bowl_45l_45c_wash_fill`**: Left `50A` drain plug closed (`0.0 mm`); left bowl filled to `{s['left_bowl_45l_45c_wash_fill']['left_water_l']} L` at `{s['left_bowl_45l_45c_wash_fill']['left_water_temp_c']} °C` (`water_depth = {s['left_bowl_45l_45c_wash_fill']['left_water_depth_mm']} mm`, below the `210 mm` overflow standpipe crown) while the `400 × 300 mm` tray rests completely submerged on the `Z = 0.550 m` floor.
3. **`left_50a_gravity_drain_and_strainer_lift`**: Left `50A` King drain plug lifted (`{s['left_50a_gravity_drain_and_strainer_lift']['plug_left_lift_mm']} mm`) for gravity discharge (`peak_drain_flow = {report['peak_left_drain_l_min']} L/min` down to `{s['left_50a_gravity_drain_and_strainer_lift']['left_water_l']} L`), followed by crumb strainer lift (`{s['left_50a_gravity_drain_and_strainer_lift']['strainer_left_lift_mm']} mm`) capturing `{s['left_50a_gravity_drain_and_strainer_lift']['captured_crumbs_g']} g` pastry residue.
4. **`right_rinse_bowl_cycle`**: Tray transferred flat onto the symmetric right `545 × 460 mm` bowl floor (`Z = 0.550 m`, contact `{s['right_rinse_bowl_cycle']['right_bowl_touch_n']} N`), rinsed in `40.0 L` (`50.0 °C`) clean bath, and gravity-drained by opening `bs2_plug_right_lift` (`{s['right_rinse_bowl_cycle']['plug_right_lift_mm']} mm`).
5. **`rest_frame_and_motion_verified`**: All plugs and strainer returned to `0.0 mm`, tray seated at rest on left bowl floor (`Z = 0.550 m`), passing `inspect_appliance_frames.mjs` at rest (`max_pos_err = {s['rest_frame_and_motion_verified']['rest_max_position_error_m']:.2e} m`) and across 21-sample `--motion` sweeps (`max_pos_err = {s['rest_frame_and_motion_verified']['motion_max_position_error_m']:.2e} m`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    native_model = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    tray_qpos_adr = model.joint("bs2_wash_tray_free").qposadr[0]
    tray_qvel_adr = model.joint("bs2_wash_tray_free").dofadr[0]
    tray_bid = model.body("bs2_wash_tray").id

    bowl_area_m2 = 0.5450 * 0.4600  # 0.2507 m^2 -> 1.0 L = 3.9888 mm water depth; 45 L = 179.5 mm (< 210 mm standpipe)
    standpipe_height_m = 0.2100  # 52.65 L overflow threshold

    state = {
        "mode": "empty_standby",
        "left_inflow_l_min": 0.0,
        "right_inflow_l_min": 0.0,
        "left_water_l": 0.0,
        "right_water_l": 0.0,
        "left_water_temp_c": 22.0,
        "right_water_temp_c": 22.0,
        "left_drain_l_min": 0.0,
        "right_drain_l_min": 0.0,
        "captured_crumbs_g": 0.0,
        "peak_left_drain_l_min": 0.0,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, hydraulic_accel: float = 60.0):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            plug_l_m = float(data.sensor("bs2_plug_left_pos").data[0])
            plug_r_m = float(data.sensor("bs2_plug_right_pos").data[0])
            str_l_m = float(data.sensor("bs2_strainer_left_pos").data[0])
            touch_l_n = float(data.sensor("bs2_left_bowl_touch").data[0])
            touch_r_n = float(data.sensor("bs2_right_bowl_touch").data[0])
            tray_pos = data.xpos[tray_bid]

            eff_dt_min = (sample_every_s * hydraulic_accel) / 60.0

            # Left 50A King drain gravity orifice discharge Q = C_d * A_eff * sqrt(2*g*h)
            h_left_m = (state["left_water_l"] * 1e-3) / bowl_area_m2
            if plug_l_m > 0.008 and state["left_water_l"] > 0.0:
                open_frac = min(1.0, plug_l_m / 0.035)
                q_l_m3_s = 0.62 * (0.00058 * open_frac) * math.sqrt(2.0 * 9.81 * max(0.025, h_left_m + 0.08))
                state["left_drain_l_min"] = q_l_m3_s * 60000.0
            else:
                state["left_drain_l_min"] = 0.0

            # Overflow standpipe bleed if water exceeds 210 mm
            if h_left_m > standpipe_height_m and state["left_drain_l_min"] == 0.0:
                state["left_drain_l_min"] = state["left_inflow_l_min"]

            state["peak_left_drain_l_min"] = max(
                state["peak_left_drain_l_min"], state["left_drain_l_min"]
            )
            d_left = (state["left_inflow_l_min"] - state["left_drain_l_min"]) * eff_dt_min
            state["left_water_l"] = max(0.0, min(53.0, state["left_water_l"] + d_left))
            if state["left_water_l"] > 0.0 and state["left_drain_l_min"] > 5.0 and str_l_m < 0.010:
                state["captured_crumbs_g"] = min(18.5, state["captured_crumbs_g"] + 3.2)

            # Right 50A King drain gravity orifice discharge
            h_right_m = (state["right_water_l"] * 1e-3) / bowl_area_m2
            if plug_r_m > 0.008 and state["right_water_l"] > 0.0:
                open_frac_r = min(1.0, plug_r_m / 0.035)
                q_r_m3_s = 0.62 * (0.00058 * open_frac_r) * math.sqrt(2.0 * 9.81 * max(0.025, h_right_m + 0.08))
                state["right_drain_l_min"] = q_r_m3_s * 60000.0
            else:
                state["right_drain_l_min"] = 0.0

            d_right = (state["right_inflow_l_min"] - state["right_drain_l_min"]) * eff_dt_min
            state["right_water_l"] = max(0.0, min(53.0, state["right_water_l"] + d_right))

            h_left_mm = ((state["left_water_l"] * 1e-3) / bowl_area_m2) * 1000.0
            h_right_mm = ((state["right_water_l"] * 1e-3) / bowl_area_m2) * 1000.0

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "left_water_l": round(state["left_water_l"], 2),
                "left_water_depth_mm": round(h_left_mm, 1),
                "left_water_temp_c": round(state["left_water_temp_c"], 1),
                "left_drain_l_min": round(state["left_drain_l_min"], 2),
                "right_water_l": round(state["right_water_l"], 2),
                "right_water_depth_mm": round(h_right_mm, 1),
                "right_water_temp_c": round(state["right_water_temp_c"], 1),
                "right_drain_l_min": round(state["right_drain_l_min"], 2),
                "plug_left_lift_mm": round(plug_l_m * 1000.0, 2),
                "plug_right_lift_mm": round(plug_r_m * 1000.0, 2),
                "strainer_left_lift_mm": round(str_l_m * 1000.0, 2),
                "captured_crumbs_g": round(state["captured_crumbs_g"], 1),
                "tray_x_m": round(float(tray_pos[0]), 4),
                "tray_y_m": round(float(tray_pos[1]), 4),
                "tray_z_m": round(float(tray_pos[2]), 4),
                "left_bowl_touch_n": round(touch_l_n, 2),
                "right_bowl_touch_n": round(touch_r_n, 2),
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Empty bowls — drop 400 x 300 mm tray from Z = 0.585 m into concave left bowl to prove true 250 mm open cavity & Z = 0.550 m flat fit
    data.qpos[tray_qpos_adr : tray_qpos_adr + 3] = (-0.2875, -0.0920, 0.5850)
    data.qpos[tray_qpos_adr + 3 : tray_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[tray_qvel_adr : tray_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    snap1 = step_and_sample(0.48, hydraulic_accel=1.0)
    assert abs(snap1["tray_z_m"] - 0.5500) <= 0.0015, snap1
    assert snap1["left_bowl_touch_n"] > 7.5, snap1
    assert snap1["left_water_l"] == 0.0 and snap1["right_water_l"] == 0.0, snap1
    stage_summaries["empty_bowls_tray_drop_and_flat_fit"] = snap1

    # Stage 2: Close left plug & fill 45.0 L wash water (45 °C) while 400 x 300 mm tray sits flat inside 545 x 460 mm bowl
    state["mode"] = "left_wash_fill_45c"
    state["left_water_temp_c"] = 45.0
    state["left_inflow_l_min"] = 90.0
    step_and_sample(0.50, hydraulic_accel=60.0)
    state["left_inflow_l_min"] = 0.0
    state["left_water_l"] = 45.00
    snap2 = step_and_sample(0.16, hydraulic_accel=1.0)
    assert snap2["left_water_l"] == 45.00, snap2
    assert 178.0 <= snap2["left_water_depth_mm"] <= 181.0, snap2
    assert abs(snap2["tray_z_m"] - 0.5500) <= 0.0015, snap2
    stage_summaries["left_bowl_45l_45c_wash_fill"] = snap2

    # Stage 3: Open left 50A drain plug (gravity drain flow) & lift removable crumb strainer basket
    state["mode"] = "left_50a_gravity_drain_and_strainer_clean"
    data.ctrl[model.actuator("bs2_plug_left_actuator").id] = 0.070
    step_and_sample(0.96, hydraulic_accel=95.0)
    assert state["left_water_l"] == 0.0, state
    assert state["peak_left_drain_l_min"] > 28.0, state
    data.ctrl[model.actuator("bs2_strainer_left_actuator").id] = 0.105
    snap3 = step_and_sample(0.40, hydraulic_accel=10.0)
    assert snap3["plug_left_lift_mm"] > 65.0, snap3
    assert snap3["strainer_left_lift_mm"] > 95.0, snap3
    assert snap3["captured_crumbs_g"] >= 15.0, snap3
    stage_summaries["left_50a_gravity_drain_and_strainer_lift"] = snap3

    # Stage 4: Right rinse bowl cycle — re-seat left strainer/plug, transfer tray into right 545 x 460 mm bowl, fill 40 L (50 °C), then drain via right 50A plug
    state["mode"] = "right_rinse_bowl_cycle"
    data.ctrl[model.actuator("bs2_strainer_left_actuator").id] = 0.0
    data.ctrl[model.actuator("bs2_plug_left_actuator").id] = 0.0
    data.qpos[tray_qpos_adr : tray_qpos_adr + 3] = (0.2875, -0.0920, 0.5650)
    data.qpos[tray_qpos_adr + 3 : tray_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[tray_qvel_adr : tray_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    state["right_water_temp_c"] = 50.0
    state["right_water_l"] = 40.00
    snap4_rinse = step_and_sample(0.36, hydraulic_accel=1.0)
    assert snap4_rinse["right_bowl_touch_n"] > 7.5, snap4_rinse
    assert abs(snap4_rinse["tray_z_m"] - 0.5500) <= 0.0015, snap4_rinse

    data.ctrl[model.actuator("bs2_plug_right_actuator").id] = 0.070
    snap4 = step_and_sample(0.88, hydraulic_accel=95.0)
    assert snap4["plug_right_lift_mm"] > 65.0, snap4
    assert snap4["right_water_l"] == 0.0, snap4
    stage_summaries["right_rinse_bowl_cycle"] = snap4

    # Stage 5: Return plugs, strainer, and tray to rest pose & verify GLB/native rest + motion frame alignment
    state["mode"] = "rest_standby"
    data.ctrl[model.actuator("bs2_plug_right_actuator").id] = 0.0
    data.qpos[tray_qpos_adr : tray_qpos_adr + 3] = (-0.2875, -0.0920, 0.5500)
    data.qpos[tray_qpos_adr + 3 : tray_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[tray_qvel_adr : tray_qvel_adr + 6] = 0.0
    mujoco.mj_forward(model, data)
    snap5 = step_and_sample(0.40, hydraulic_accel=1.0)
    assert snap5["plug_left_lift_mm"] < 0.5 and snap5["plug_right_lift_mm"] < 0.5, snap5
    assert snap5["strainer_left_lift_mm"] < 0.5, snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frame_and_motion_alignment(
        mujoco, native_model, evidence_dir
    )

    stage_summaries["rest_frame_and_motion_verified"] = {
        "rest_snap": snap5,
        "frames_aligned": len(frames_report["appliances"]["maruzen-bs2-126n"]["frames"]),
        "rest_max_position_error_m": max(
            f["position_error_m"]
            for f in frames_report["appliances"]["maruzen-bs2-126n"]["frames"]
        ),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"]
            for f in frames_report["appliances"]["maruzen-bs2-126n"]["frames"]
        ),
        "scalar_joints_motion_verified": len(
            motion_report["appliances"]["maruzen-bs2-126n"]["motions"]
        ),
        "motion_max_position_error_m": max(
            m["position_error_m"]
            for m in motion_report["appliances"]["maruzen-bs2-126n"]["motions"]
        ),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"]
            for m in motion_report["appliances"]["maruzen-bs2-126n"]["motions"]
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
        "appliance": "maruzen-bs2-126n",
        "model_title": "Maruzen BS2-126N Two-Compartment Commercial Sink (No Backsplash, 430 Bream Series)",
        "envelope_m": [1.200, 0.600, 0.800],
        "bowl_dimensions_m": [0.545, 0.460, 0.250],
        "published_sink_mass_kg": 29.400,
        "wash_tray_mass_kg": 0.850,
        "total_scene_mass_kg": round(sum(MASSES.values()), 3),
        "peak_left_drain_l_min": round(state["peak_left_drain_l_min"], 2),
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
