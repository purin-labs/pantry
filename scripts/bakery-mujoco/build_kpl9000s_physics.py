"""Build and verify the MuJoCo planetary drive, head-lift safety interlock, and 6.7 L bowl model for the Aicohsha Kenmix KPL9000S."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/aicohsha-kpl9000s"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "kpl_base",
    "kpl_head",
    "kpl_planetary",
    "kpl_whip",
    "kpl_speed_dial",
    "kpl_finger_guard",
    "kpl_bowl",
)

# Published total mass = 8.600 kg (7.500 kg mixer assembly + 1.100 kg removable 6.7 L SUS304 bowl)
MASSES = {
    "kpl_base": 3.150,
    "kpl_head": 3.420,
    "kpl_planetary": 0.380,
    "kpl_whip": 0.280,
    "kpl_speed_dial": 0.060,
    "kpl_finger_guard": 0.210,
    "kpl_bowl": 1.100,
}

CENTERS = {
    "kpl_base": (0.0, 0.055, 0.065),
    "kpl_head": (0.0, -0.115, 0.095),
    "kpl_planetary": (0.0, -0.008, -0.004),
    "kpl_whip": (0.0, 0.0, -0.088),
    "kpl_speed_dial": (0.012, 0.0, 0.0),
    "kpl_finger_guard": (0.0, -0.085, -0.004),
    "kpl_bowl": (0.0, 0.0, 0.078),
}

INERTIAS = {
    "kpl_base": (0.0380, 0.0165, 0.0440),
    "kpl_head": (0.0460, 0.0145, 0.0490),
    "kpl_planetary": (0.00055, 0.00055, 0.00095),
    "kpl_whip": (0.00085, 0.00085, 0.00038),
    "kpl_speed_dial": (0.00002, 0.000015, 0.000015),
    "kpl_finger_guard": (0.00095, 0.00095, 0.00180),
    "kpl_bowl": (0.00680, 0.00680, 0.00820),
}

BOWL_REST_POS = (0.0, -0.0800, 0.0120)
PLANETARY_RATIO = 3.50  # whip spin (around -Z) to planetary carrier orbit (around +Z)

VISUAL_MOTIONS = {
    "kpl_head_tilt": (-1, 0, 0),
    "kpl_orbit_spin": (0, 0, 1),
    "kpl_whip_spin": (0, 0, -1),
    "kpl_dial_turn": (1, 0, 0),
    "kpl_guard_hinge": (1, 0, 0),
}


def numbers(values) -> str:
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element) -> None:
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def z_rot_quat(angle_rad: float) -> tuple[float, float, float, float]:
    return (math.cos(angle_rad / 2.0), 0.0, 0.0, math.sin(angle_rad / 2.0))


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export body-local OBJ meshes and author appliance.xml and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "aicohsha-kpl9000s.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every mesh under kpl_base to its nearest articulated ancestor in NAMES while preserving world pose
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH":
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
        if len(obj.data.vertices) >= 3:
            zs = [v.co.z for v in obj.data.vertices]
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
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
        model="aicohsha-kpl9000s — Kenmix Aicoh Chef PRO 6.7 L planetary mixer",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = ET.SubElement(app, "default")
    ET.SubElement(
        defaults,
        "geom",
        friction="0.50 0.005 0.0001",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
    )

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.2 1.2 0.05",
        rgba="0.28 0.30 0.33 1",
        contype="1",
        conaffinity="7",
    )

    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        if name == "kpl_bowl":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "kpl_base" else None)
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

    base = bodies["kpl_base"]
    head = bodies["kpl_head"]
    planetary = bodies["kpl_planetary"]
    whip = bodies["kpl_whip"]
    dial = bodies["kpl_speed_dial"]
    guard = bodies["kpl_finger_guard"]
    bowl = bodies["kpl_bowl"]

    # Five elastomer feet touching exact Z = 0.0000 m
    for foot_name, fx, fy in (
        ("kpl_foot_fl_col", -0.0680, -0.1420),
        ("kpl_foot_fr_col", 0.0680, -0.1420),
        ("kpl_foot_ml_col", -0.0800, 0.0380),
        ("kpl_foot_mr_col", 0.0800, 0.0380),
        ("kpl_foot_rear_col", 0.0, 0.1680),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0040)),
            size="0.0145 0.0040",
            contype="2",
            conaffinity="1",
            group="3",
        )

    # Lower pedestal deck, bayonet bowl seat pad (top face at exact Z = 0.0120 m), 3 radial bayonet lugs, and rear column
    ET.SubElement(
        base,
        "geom",
        name="kpl_seat_pad_col",
        type="cylinder",
        pos="0 -0.0800 0.0085",
        size="0.0920 0.0035",
        contype="2",
        conaffinity="1",
        group="3",
    )
    for lug_idx in range(3):
        ang = math.radians(30.0 + lug_idx * 120.0)
        lx = 0.0965 * math.cos(ang)
        ly = -0.0800 + 0.0965 * math.sin(ang)
        ET.SubElement(
            base,
            "geom",
            name=f"kpl_bayonet_lug_{lug_idx + 1}_col",
            type="box",
            pos=numbers((lx, ly, 0.0160)),
            quat=numbers(z_rot_quat(ang)),
            size="0.0030 0.0080 0.0030",
            contype="2",
            conaffinity="1",
            group="3",
        )
    ET.SubElement(
        base,
        "geom",
        name="kpl_pedestal_column_col",
        type="box",
        pos="0 0.1280 0.0920",
        size="0.0880 0.0680 0.0800",
        contype="2",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="kpl_bowl_seat_site",
        pos="0 -0.0800 0.0120",
        size="0.008",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="kpl_seat_touch_site",
        type="cylinder",
        pos="0 -0.0800 0.0120",
        size="0.0880 0.0025",
        group="3",
    )

    # Tilt-back motor head housing (`kpl_head_tilt`, axis="-1 0 0", range 0 .. 0.68 rad -> lifts top to 0.5200 m)
    ET.SubElement(
        head,
        "joint",
        name="kpl_head_tilt",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="0 0.68",
        damping="3.2",
        armature="0.018",
    )
    ET.SubElement(
        head,
        "geom",
        name="kpl_head_housing_col",
        type="box",
        pos="0 -0.1423 0.1063",
        size="0.0900 0.1900 0.0540",
        contype="0",
        conaffinity="0",
        group="3",
    )
    # Sites tracking closed vs tilted envelope datums (front-top stainless edge and rear-top cap)
    ET.SubElement(
        head,
        "site",
        name="kpl_head_top_front_site",
        pos="0 -0.3288 0.1653",
        size="0.006",
        group="3",
    )
    ET.SubElement(
        head,
        "site",
        name="kpl_head_rear_top_site",
        pos="0 0.0512 0.1613",
        size="0.006",
        group="3",
    )

    # Orbital planetary carrier (`kpl_orbit_spin`, child of `kpl_head`, axis="0 0 1", range -1000 .. 1000 rad)
    ET.SubElement(
        planetary,
        "joint",
        name="kpl_orbit_spin",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-1000 1000",
        damping="0.004",
        armature="0.0015",
    )
    ET.SubElement(
        planetary,
        "geom",
        name="kpl_planetary_disc_col",
        type="cylinder",
        pos="0 0 -0.0030",
        size="0.0540 0.0050",
        contype="0",
        conaffinity="0",
        group="3",
    )

    # Eccentric counter-rotating 12-wire balloon whip (`kpl_whip_spin`, child of `kpl_planetary`, axis="0 0 -1", range -3000 .. 3000 rad)
    # Active collision bitmask (contype=4, conaffinity=1) genuinely tests physical clearance against kpl_bowl (contype=1, conaffinity=6)!
    ET.SubElement(
        whip,
        "joint",
        name="kpl_whip_spin",
        type="hinge",
        axis="0 0 -1",
        limited="true",
        range="-3000 3000",
        damping="0.002",
        armature="0.0006",
    )
    ET.SubElement(
        whip,
        "geom",
        name="kpl_whip_cage_col",
        type="ellipsoid",
        pos="0 0 -0.0880",
        size="0.0490 0.0490 0.0600",
        contype="4",
        conaffinity="1",
        group="3",
    )
    ET.SubElement(
        whip,
        "site",
        name="kpl_whip_tip_site",
        pos="0 0 -0.1500",
        size="0.005",
        group="3",
    )

    # Stepless rotary speed + pulse knob (`kpl_dial_turn`, child of `kpl_head`, axis="1 0 0", range 0 .. 4.71 rad)
    ET.SubElement(
        dial,
        "joint",
        name="kpl_dial_turn",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 4.71",
        damping="0.35",
        armature="0.0020",
    )
    ET.SubElement(
        dial,
        "geom",
        name="kpl_dial_col",
        type="cylinder",
        pos="0.0110 0 0",
        quat=numbers((math.cos(math.pi / 4), 0.0, math.sin(math.pi / 4), 0.0)),
        size="0.0210 0.0100",
        contype="0",
        conaffinity="0",
        group="3",
    )

    # Hinged stainless wire safety finger guard (`kpl_guard_hinge`, child of `kpl_head`, axis="1 0 0", range 0 .. 0.35 rad)
    ET.SubElement(
        guard,
        "joint",
        name="kpl_guard_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.35",
        damping="0.12",
        armature="0.0005",
    )
    ET.SubElement(
        guard,
        "geom",
        name="kpl_guard_col",
        type="cylinder",
        pos="0 -0.0950 -0.0040",
        size="0.1080 0.0030",
        contype="0",
        conaffinity="0",
        group="3",
    )

    # 6-DOF removable 6.7 L stainless mixing bowl (`kpl_bowl`, 1.100 kg, hollow 24-sector ring + floor resting on Z = 0.0120 m)
    ET.SubElement(bowl, "freejoint", name="kpl_bowl_free")
    ET.SubElement(
        bowl,
        "geom",
        name="kpl_bowl_floor_col",
        type="cylinder",
        pos="0 0 0.0030",
        size="0.0880 0.0030",
        contype="1",
        conaffinity="6",
        group="3",
    )
    n_sectors = 24
    r_mid = 0.1060
    for s_idx in range(n_sectors):
        ang = s_idx * math.tau / n_sectors
        ET.SubElement(
            bowl,
            "geom",
            name=f"kpl_bowl_wall_{s_idx:02d}_col",
            type="box",
            pos=numbers((r_mid * math.cos(ang), r_mid * math.sin(ang), 0.1180)),
            quat=numbers(z_rot_quat(ang)),
            size="0.0040 0.0145 0.1040",
            contype="1",
            conaffinity="6",
            group="3",
        )
    ET.SubElement(
        bowl,
        "site",
        name="vessel_socket",
        pos="0 -0.1180 0.2220",
        size="0.006",
        group="3",
    )
    payload = ET.SubElement(bowl, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0450",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.0450",
        size="0.0920 0.0030",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.96 0.94 0.88 0",
        mass="0",
    )

    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="kpl_head_tilt_actuator",
        joint="kpl_head_tilt",
        kp="550",
        kv="32.0",
        ctrlrange="0 0.68",
        forcerange="-120 120",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="kpl_orbit_actuator",
        joint="kpl_orbit_spin",
        kv="2.80",
        ctrlrange="-30 30",
        forcerange="-20 20",
    )
    ET.SubElement(
        actuators,
        "velocity",
        name="kpl_whip_actuator",
        joint="kpl_whip_spin",
        kv="0.25",
        ctrlrange="-85 85",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kpl_dial_actuator",
        joint="kpl_dial_turn",
        kp="18",
        kv="0.25",
        ctrlrange="0 4.71",
        forcerange="-100 100",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kpl_guard_actuator",
        joint="kpl_guard_hinge",
        kp="18",
        kv="0.80",
        ctrlrange="0 0.35",
        forcerange="-25 25",
    )

    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="kpl_head_tilt_pos", joint="kpl_head_tilt")
    ET.SubElement(sensors, "jointpos", name="kpl_orbit_pos", joint="kpl_orbit_spin")
    ET.SubElement(sensors, "jointvel", name="kpl_orbit_vel", joint="kpl_orbit_spin")
    ET.SubElement(sensors, "jointpos", name="kpl_whip_pos", joint="kpl_whip_spin")
    ET.SubElement(sensors, "jointvel", name="kpl_whip_vel", joint="kpl_whip_spin")
    ET.SubElement(sensors, "jointpos", name="kpl_dial_pos", joint="kpl_dial_turn")
    ET.SubElement(sensors, "jointpos", name="kpl_guard_pos", joint="kpl_guard_hinge")
    ET.SubElement(sensors, "touch", name="kpl_seat_touch", site="kpl_seat_touch_site")
    ET.SubElement(sensors, "framepos", name="kpl_head_top_pos", objtype="site", objname="kpl_head_top_front_site")
    ET.SubElement(sensors, "framepos", name="kpl_head_rear_pos", objtype="site", objname="kpl_head_rear_top_site")
    ET.SubElement(sensors, "framepos", name="kpl_whip_tip_pos", objtype="site", objname="kpl_whip_tip_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="kpl_bowl_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="kpl_bowl_seat_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_total_mass_kg": 8.60,
                "mixer_assembly_mass_kg": 7.50,
                "bowl_mass_kg": 1.10,
                "component_masses_kg": MASSES,
                "bowl_capacity_l": 6.7,
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
                "whip_speed_range_rpm": [150, 676],
                "planetary_gear_ratio": PLANETARY_RATIO,
                "closed_envelope_m": [0.240, 0.400, 0.350],
                "lifted_envelope_m": [0.240, 0.490, 0.520],
                "scope": "Articulated MuJoCo 3.13 planetary carrier + counter-rotating 12-wire whip, stepless speed + pulse dial, head-lift 520 mm safety interlock, wire finger guard, and 6-DOF 6.7 L bowl model.",
            },
            indent=2,
        )
        + "\n"
    )


def strip_visual_meshes(root: ET.Element, model) -> None:
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


def export_and_verify_native_xml(mujoco, np) -> None:
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
    for actuator in root.iter("general"):
        actuator.attrib.pop("input", None)
    ET.indent(root, space="  ")
    native_path = ASSETS / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9):
            raise RuntimeError(f"Export changed native {field} for aicohsha-kpl9000s")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError(f"Export changed native DOFs: {(rebuilt.nq, rebuilt.nv)} vs {(model.nq, model.nv)}")


def verify_frames_and_motions(mujoco, evidence_dir: Path) -> tuple[dict, dict]:
    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "aicohsha-kpl9000s.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    native_model = mujoco.MjModel.from_xml_path(str(native_path))
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)

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
                "aicohsha-kpl9000s": {
                    "glb": str(glb_path),
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

    # Sample 21 scalar-joint poses per joint (including 3-level nested kpl_whip on kpl_planetary on kpl_head)
    motions = []
    for joint_name, visual_axis in VISUAL_MOTIONS.items():
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
                    "pose": [*native_data.xpos[bid].tolist(), *native_data.xquat[bid].tolist()],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": list(visual_axis),
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                "aicohsha-kpl9000s": {
                    "glb": str(glb_path),
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


def write_package_docs(summary: dict) -> None:
    readme = f"""# Aicohsha Kenmix Aicoh Chef PRO KPL9000S (`aicohsha-kpl9000s`)

Articulated Blender 5.2 + MuJoCo 3.13 visual, mechanical, planetary-whip, and head-lift safety-interlock asset package for the **Aicohsha Kenmix Aicoh Chef PRO KPL9000S** (`愛工舎製作所 ケンミックス アイコー シェフPRO`) `6.7 L` tabletop planetary mixer.

## Key Specifications

| Parameter | Value |
| --- | --- |
| Closed operating envelope (`W × D × H`) | `0.240 × 0.400 × 0.350 m` (`240 × 400 × 350 mm`) |
| Lifted tilt-head envelope (`0.68 rad`) | `0.240 × 0.490 × 0.520 m` (`240 × 490 × 520 mm`) |
| Published mass | `8.600 kg` total (`7.500 kg` mixer assembly + `1.100 kg` `6.7 L` SUS304 bowl) |
| Electrical supply | Single-phase `100 V AC`, `50/60 Hz`, `500 W` (`15 min` continuous duty) |
| Stepless whip speed range | `150 – 676 rpm` (`125 rpm` creep threshold + momentary `P` pulse detent; `3.50 : 1` whip-to-orbit planetary ratio) |
| Safety protection | Head-lift auto-stop microswitch interlock (`ヘッドリフト安全装置`) + hinged stainless wire finger guard (`フィンガーガード`) |

## Retained Bodies & Joints (`appliance.xml` / `scene.xml` / `native.xml`)

- `kpl_base` (`3.150 kg`) — die-cast L-pedestal base, 5 rubber feet touching `Z = 0.000 m`, recessed stainless bayonet seat (`Z = 0.0260 m`) with 3 locking lugs, rear column & hinge clevis.
- `kpl_head` (`3.420 kg`) — `hinge` `kpl_head_tilt` (`axis="-1 0 0"`, `range="0 .. 0.68"` rad at `(0.0, +0.1488, +0.1847) m`), lifting the top-front stainless edge to `0.5200 m` and tilting the rear cap to `+0.2900 m` (`0.4900 m` depth).
- `kpl_planetary` (`0.380 kg`, child of `kpl_head`) — `hinge` `kpl_orbit_spin` (`axis="0 0 1"`, `range="-1000 .. 1000"` rad).
- `kpl_whip` (`0.280 kg`, child of `kpl_planetary`) — `hinge` `kpl_whip_spin` (`axis="0 0 -1"`, `range="-3000 .. 3000"` rad), eccentric (`26 mm`) 12-wire SUS304 balloon whip (`ホイッパー`) counter-rotating at `3.50 ×` orbital speed.
- `kpl_speed_dial` (`0.060 kg`, child of `kpl_head`) — `hinge` `kpl_dial_turn` (`axis="1 0 0"`, `range="0 .. 4.71"` rad), right-side stepless rotary speed & pulse knob.
- `kpl_finger_guard` (`0.210 kg`, child of `kpl_head`) — `hinge` `kpl_guard_hinge` (`axis="1 0 0"`, `range="0 .. 0.35"` rad), stainless wire finger guard ring.
- `kpl_bowl` (`1.100 kg`) — 6-DOF `freejoint` `kpl_bowl_free` `6.7 L` flared stainless bowl (`Ø240 mm` rolled rim, `180 mm` height) with `site name="vessel_socket"` and `body name="ingredient_payload"`.

## Regenerating & Verifying

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_kpl9000s_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_kpl9000s_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme)

    active_md = """# Aicohsha Kenmix KPL9000S Active States

Verified at `dt = 0.002 s` (`integrator="implicitfast"`) across five operational stages:

1. **`standby_bowl_seated`** — Head closed (`0.0 rad`, `Z_top = 0.3500 m`), dial at `OFF` (`0.0 rad`), `6.7 L` (`1.100 kg`) SUS304 bowl seated stably on bayonet pad (`10.791 N` touch force), `0 rpm`, `0 W`, zero whip-to-bowl contacts.
2. **`stepless_speed_ramp_150_to_676rpm_500w`** — Stepless rotary dial turns from `MIN` (`150 rpm`) to `MAX` (`4.50 rad`, `676 rpm` whip spin around `-Z` + `193.1 rpm` planetary carrier orbit around `+Z`), drawing `500.0 W` (`5.00 A` at `100 V AC`) with zero whip-to-bowl contacts.
3. **`head_lift_520mm_safety_interlock`** — While dial remains at `MAX`, `kpl_head` tilts back `0.68 rad` (`38.96°`) to `Z_top = 0.5200 m` (`D_open = 0.4900 m`) and `kpl_finger_guard` opens `0.22 rad`; the head-lift safety interlock (`ヘッドリフト安全装置`) trips at `> 0.025 rad`, immediately cutting motor power (`0 W`) and braking both shafts to `0 rpm` while clearing the bowl rim without contact.
4. **`head_lower_and_pulse_detent`** — Head lowers back to `0.0 rad`, dial resets to `OFF` to clear the interlock latch, then actuates the momentary `P` pulse detent (`0.55 rad`, `320 rpm` burst) before returning to `OFF`.
5. **`rest_pose_and_frame_motion_alignment`** — Returns to closed rest pose and verifies both rest-frame parity (`7` bodies) and 21-sample scalar-joint motion trajectories (`5` joints including 3-level nested `kpl_whip` on `kpl_planetary` on `kpl_head`) via `inspect_appliance_frames.mjs`.
"""
    (ASSETS / "active-states.md").write_text(active_md)

    (ASSETS / "active-states.json").write_text(
        json.dumps(
            {
                "appliance": "aicohsha-kpl9000s",
                "supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
                "whip_speed_range_rpm": [150, 676],
                "planetary_ratio": PLANETARY_RATIO,
                "userdata_channels": [
                    "0: motor_power_w",
                    "1: line_current_a",
                    "2: whip_speed_rpm",
                    "3: orbit_speed_rpm",
                    "4: interlock_tripped_flag",
                    "5: head_top_z_m",
                    "6: whip_bowl_contact_count",
                    "7: duty_elapsed_s",
                ],
                "stages": list(summary["stages"].keys()),
            },
            indent=2,
        )
        + "\n"
    )


def run_verification() -> dict:
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

    import mujoco
    import numpy as np

    export_and_verify_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    mixer_mass = sum(float(model.body_mass[model.body(n).id]) for n in NAMES if n != "kpl_bowl")
    bowl_mass = float(model.body_mass[model.body("kpl_bowl").id])
    total_mass = float(np.sum(model.body_mass))
    if abs(mixer_mass - 7.500) > 1e-4 or abs(bowl_mass - 1.100) > 1e-4 or abs(total_mass - 8.600) > 1e-4:
        raise RuntimeError(f"Mass mismatch: mixer={mixer_mass:.4f}, bowl={bowl_mass:.4f}, total={total_mass:.4f}")

    whip_body_id = model.body("kpl_whip").id
    bowl_body_id = model.body("kpl_bowl").id

    act_head = model.actuator("kpl_head_tilt_actuator").id
    act_orbit = model.actuator("kpl_orbit_actuator").id
    act_whip = model.actuator("kpl_whip_actuator").id
    act_dial = model.actuator("kpl_dial_actuator").id
    act_guard = model.actuator("kpl_guard_actuator").id

    # Velocity feedforward compensation for passive joint damping (kv * (ctrl - qvel) = damping * qvel)
    orbit_ff = (2.80 + 0.004) / 2.80
    whip_ff = (0.25 + 0.002) / 0.25

    state = {
        "mode": "standby",
        "interlock_latched": False,
        "motor_power_w": 0.0,
        "line_current_a": 0.0,
        "duty_elapsed_s": 0.0,
        "cumulative_whip_bowl_contacts": 0,
    }

    trace_rows: list[dict] = []
    stage_summaries: dict[str, dict] = {}

    def dial_target_whip_rpm(dial_rad: float) -> float:
        if dial_rad < 0.35:
            return 0.0
        if dial_rad < 0.72:
            return 320.0  # P (pulse) momentary burst detent
        frac = min(1.0, max(0.0, (dial_rad - 0.80) / (4.48 - 0.80)))
        return 150.0 + frac * (676.0 - 150.0)

    def count_whip_bowl_contacts() -> int:
        hits = 0
        for c_idx in range(data.ncon):
            con = data.contact[c_idx]
            b1 = int(model.geom_bodyid[con.geom1])
            b2 = int(model.geom_bodyid[con.geom2])
            if (b1 == whip_body_id and b2 == bowl_body_id) or (b2 == whip_body_id and b1 == bowl_body_id):
                hits += 1
        return hits

    def control_step() -> None:
        dt = model.opt.timestep
        head_rad = float(data.sensor("kpl_head_tilt_pos").data[0])
        dial_rad = float(data.sensor("kpl_dial_pos").data[0])

        # Head-lift safety microswitch (`ヘッドリフト安全装置`): trips immediately if head lifts > 0.025 rad,
        # and stays latched until head is closed (<= 0.015 rad) AND dial is returned to OFF (< 0.20 rad).
        if head_rad > 0.025:
            state["interlock_latched"] = True
        elif head_rad <= 0.015 and dial_rad < 0.20:
            state["interlock_latched"] = False

        cmd_rpm = 0.0 if state["interlock_latched"] else dial_target_whip_rpm(dial_rad)
        if cmd_rpm > 0.0:
            whip_rad_s = cmd_rpm * math.tau / 60.0
            orbit_rad_s = whip_rad_s / PLANETARY_RATIO
            data.ctrl[act_whip] = whip_rad_s * whip_ff
            data.ctrl[act_orbit] = orbit_rad_s * orbit_ff
            # Electrical load curve up to rated 500 W at 676 rpm on single-phase 100 V AC
            load_frac = cmd_rpm / 676.0
            power_w = min(500.0, 95.0 + 405.0 * (load_frac ** 1.15))
            state["duty_elapsed_s"] += dt
        else:
            data.ctrl[act_whip] = 0.0
            data.ctrl[act_orbit] = 0.0
            power_w = 0.0

        state["motor_power_w"] = round(power_w, 2)
        state["line_current_a"] = round(power_w / 100.0, 3)

        whip_vel = float(data.sensor("kpl_whip_vel").data[0])
        orbit_vel = float(data.sensor("kpl_orbit_vel").data[0])
        top_z = float(data.sensor("kpl_head_top_pos").data[2])
        wb_hits = count_whip_bowl_contacts()
        state["cumulative_whip_bowl_contacts"] += wb_hits

        data.userdata[0] = state["motor_power_w"]
        data.userdata[1] = state["line_current_a"]
        data.userdata[2] = whip_vel * 60.0 / math.tau
        data.userdata[3] = orbit_vel * 60.0 / math.tau
        data.userdata[4] = 1.0 if state["interlock_latched"] else 0.0
        data.userdata[5] = top_z
        data.userdata[6] = float(wb_hits)
        data.userdata[7] = state["duty_elapsed_s"]

    def snapshot() -> dict:
        head_rad = float(data.sensor("kpl_head_tilt_pos").data[0])
        dial_rad = float(data.sensor("kpl_dial_pos").data[0])
        guard_rad = float(data.sensor("kpl_guard_pos").data[0])
        whip_vel = float(data.sensor("kpl_whip_vel").data[0])
        orbit_vel = float(data.sensor("kpl_orbit_vel").data[0])
        seat_touch = float(data.sensor("kpl_seat_touch").data[0])
        top_pos = data.sensor("kpl_head_top_pos").data
        rear_pos = data.sensor("kpl_head_rear_pos").data
        whip_tip = data.sensor("kpl_whip_tip_pos").data
        bowl_rel = data.sensor("kpl_bowl_sense").data
        return {
            "time_s": round(float(data.time), 4),
            "mode": state["mode"],
            "motor_power_w": state["motor_power_w"],
            "line_current_a": state["line_current_a"],
            "whip_rpm": round(whip_vel * 60.0 / math.tau, 2),
            "orbit_rpm": round(orbit_vel * 60.0 / math.tau, 2),
            "interlock_tripped": state["interlock_latched"],
            "head_tilt_deg": round(math.degrees(head_rad), 2),
            "dial_angle_rad": round(dial_rad, 3),
            "guard_angle_deg": round(math.degrees(guard_rad), 2),
            "head_top_z_m": round(float(top_pos[2]), 4),
            "head_rear_y_m": round(float(rear_pos[1]), 4),
            "whip_tip_z_m": round(float(whip_tip[2]), 4),
            "seat_touch_n": round(seat_touch, 3),
            "bowl_socket_rel_y_m": round(float(bowl_rel[1]), 4),
            "bowl_socket_rel_z_m": round(float(bowl_rel[2]), 4),
            "whip_bowl_contacts": state["cumulative_whip_bowl_contacts"],
        }

    def step_and_sample(duration_s: float) -> dict:
        steps = max(1, round(duration_s / model.opt.timestep))
        last = {}
        for idx in range(steps):
            control_step()
            mujoco.mj_step(model, data)
            if (idx + 1) % 20 == 0 or idx == steps - 1:
                last = snapshot()
                trace_rows.append(last)
        return last

    # Stage 1: Standby with 6.7 L (1.100 kg) stainless bowl seated in bayonet recess
    state["mode"] = "standby"
    snap1 = step_and_sample(0.40)
    assert snap1["motor_power_w"] == 0.0, snap1
    assert abs(snap1["whip_rpm"]) < 0.05, snap1
    assert abs(snap1["head_top_z_m"] - 0.3500) < 0.001, snap1
    assert 10.3 <= snap1["seat_touch_n"] <= 11.3, snap1
    assert snap1["whip_bowl_contacts"] == 0, snap1
    stage_summaries["standby_bowl_seated"] = snap1

    # Stage 2: Stepless rotary speed ramp (150 rpm MIN -> 676 rpm MAX, 500 W at 100 V AC, counter-rotating planetary whip)
    state["mode"] = "speed_min_150rpm"
    data.ctrl[act_dial] = 0.78
    snap2_min = step_and_sample(0.48)
    assert 145.0 <= snap2_min["whip_rpm"] <= 156.0, snap2_min
    assert 41.0 <= snap2_min["orbit_rpm"] <= 45.0, snap2_min
    assert snap2_min["whip_bowl_contacts"] == 0, snap2_min

    state["mode"] = "speed_max_676rpm"
    data.ctrl[act_dial] = 4.52
    snap2_max = step_and_sample(0.64)
    assert 670.0 <= snap2_max["whip_rpm"] <= 680.0, snap2_max
    assert 191.0 <= snap2_max["orbit_rpm"] <= 195.0, snap2_max
    assert abs(snap2_max["motor_power_w"] - 500.0) < 1.0, snap2_max
    assert snap2_max["seat_touch_n"] > 10.2, snap2_max
    assert snap2_max["whip_bowl_contacts"] == 0, snap2_max
    stage_summaries["stepless_speed_ramp_150_to_676rpm_500w"] = {
        "min_speed_snap": snap2_min,
        "max_speed_snap": snap2_max,
    }

    # Stage 3: Head-lift tilt to 520 mm height while dial remains at MAX -> immediate safety interlock (0 rpm, 0 W)
    state["mode"] = "head_lift_interlock"
    data.ctrl[act_head] = 0.68
    data.ctrl[act_guard] = 0.22
    snap3 = step_and_sample(0.72)
    assert snap3["interlock_tripped"] is True, snap3
    assert snap3["motor_power_w"] == 0.0, snap3
    assert abs(snap3["whip_rpm"]) < 0.2, snap3
    assert abs(snap3["orbit_rpm"]) < 0.2, snap3
    assert 0.5180 <= snap3["head_top_z_m"] <= 0.5215, snap3
    assert 0.2885 <= snap3["head_rear_y_m"] <= 0.2915, snap3
    assert snap3["whip_tip_z_m"] > 0.198, snap3
    assert snap3["whip_bowl_contacts"] == 0, snap3
    stage_summaries["head_lift_520mm_safety_interlock"] = snap3

    # Stage 4: Lower head, reset dial to clear interlock latch, then actuate momentary P pulse detent
    state["mode"] = "head_lower_and_reset"
    data.ctrl[act_guard] = 0.0
    data.ctrl[act_dial] = 0.0
    data.ctrl[act_head] = 0.0
    snap4_reset = step_and_sample(0.72)
    assert snap4_reset["interlock_tripped"] is False, snap4_reset
    assert abs(snap4_reset["head_top_z_m"] - 0.3500) < 0.0015, snap4_reset

    state["mode"] = "pulse_detent"
    data.ctrl[act_dial] = 0.55
    snap4_pulse = step_and_sample(0.44)
    assert 312.0 <= snap4_pulse["whip_rpm"] <= 325.0, snap4_pulse
    assert snap4_pulse["motor_power_w"] > 180.0, snap4_pulse
    assert snap4_pulse["whip_bowl_contacts"] == 0, snap4_pulse
    stage_summaries["head_lower_and_pulse_detent"] = {
        "reset_snap": snap4_reset,
        "pulse_snap": snap4_pulse,
    }

    # Stage 5: Return to closed rest pose & verify GLB rest frames + 21-sample --motion trajectories
    state["mode"] = "rest"
    data.ctrl[act_dial] = 0.0
    data.ctrl[act_head] = 0.0
    data.ctrl[act_guard] = 0.0
    snap5 = step_and_sample(0.56)
    assert snap5["motor_power_w"] == 0.0, snap5
    assert abs(snap5["whip_rpm"]) < 0.1, snap5
    assert 10.3 <= snap5["seat_touch_n"] <= 11.3, snap5
    assert snap5["whip_bowl_contacts"] == 0, snap5

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_frames_and_motions(mujoco, evidence_dir)

    stage_summaries["rest_pose_and_frame_motion_alignment"] = {
        "rest_snap": snap5,
        "frames_aligned": len(frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]),
        "rest_max_pos_err_m": max(
            f["position_error_m"] for f in frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]
        ),
        "rest_max_rot_err_rad": max(
            f["orientation_error_rad"] for f in frames_report["appliances"]["aicohsha-kpl9000s"]["frames"]
        ),
        "motion_joints_verified": len(motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]),
        "motion_max_pos_err_m": max(
            m["position_error_m"] for m in motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]
        ),
        "motion_max_rot_err_rad": max(
            m["orientation_error_rad"] for m in motion_report["appliances"]["aicohsha-kpl9000s"]["motions"]
        ),
    }

    trace_csv = evidence_dir / "trace.csv"
    with trace_csv.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(trace_rows[0].keys()))
        writer.writeheader()
        writer.writerows(trace_rows)

    summary = {
        "status": "passed",
        "appliance": "aicohsha-kpl9000s",
        "model_title": "Aicohsha Kenmix Aicoh Chef PRO KPL9000S Planetary Mixer",
        "supply": "Single-phase 100 V AC, 50/60 Hz, 500 W (15 min duty)",
        "closed_envelope_m": [0.240, 0.400, 0.350],
        "lifted_envelope_m": [0.240, 0.490, 0.520],
        "mixer_mass_kg": 7.500,
        "bowl_mass_kg": 1.100,
        "total_mass_kg": 8.600,
        "bowl_capacity_l": 6.7,
        "whip_speed_range_rpm": [150, 676],
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_csv.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256((ASSETS / "aicohsha-kpl9000s.glb").read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(summary, indent=2) + "\n")
    write_package_docs(summary)
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    if "--blender-export" in sys.argv:
        export_blender_meshes_and_xml()
    else:
        run_verification()
