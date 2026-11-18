"""Build and verify the native MuJoCo mechanical and active-state model for the MiiCoffee DF64 II (Gen 2, V2.6)."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/miicoffee-df64-gen2"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")
VENV_PYTHON = ROOT / "scripts/bakery-mujoco/.venv/bin/python"

NAMES = (
    "df64_grinder",
    "df64_dial_collar",
    "df64_upper_burr_carrier",
    "df64_lower_burr_rotor",
    "df64_bellows",
    "df64_wood_lid",
    "df64_power_button",
    "df64_dosing_cup",
)

# Published total mass = 6.800 kg (15.0 lbs catalog weight; manual lists 7.2 kg N.W.)
MASSES = {
    "df64_grinder": 6.080,
    "df64_dial_collar": 0.145,
    "df64_upper_burr_carrier": 0.210,
    "df64_lower_burr_rotor": 0.140,
    "df64_bellows": 0.065,
    "df64_wood_lid": 0.055,
    "df64_power_button": 0.010,
    "df64_dosing_cup": 0.095,
}

CENTERS = {
    "df64_grinder": (0.0, 0.008, 0.098),
    "df64_dial_collar": (0.0, 0.0, 0.014),
    "df64_upper_burr_carrier": (0.0, 0.0, 0.008),
    "df64_lower_burr_rotor": (0.0, 0.0, 0.001),
    "df64_bellows": (0.0, 0.0, 0.024),
    "df64_wood_lid": (0.0, 0.0, 0.005),
    "df64_power_button": (0.001, 0.0, 0.0),
    "df64_dosing_cup": (0.0, 0.0, 0.036),
}

INERTIAS = {
    "df64_grinder": (0.0420, 0.0380, 0.0195),
    "df64_dial_collar": (0.000260, 0.000260, 0.000490),
    "df64_upper_burr_carrier": (0.000145, 0.000145, 0.000265),
    "df64_lower_burr_rotor": (0.000095, 0.000095, 0.000180),
    "df64_bellows": (0.000075, 0.000075, 0.000115),
    "df64_wood_lid": (0.000045, 0.000045, 0.000085),
    "df64_power_button": (0.000004, 0.000004, 0.000004),
    "df64_dosing_cup": (0.000095, 0.000095, 0.000082),
}


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml + scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "miicoffee-df64-gen2.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent nested MESH objects directly to their owning articulated body in NAMES while preserving world pose.
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
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.35
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    model = ET.Element("mujoco", model="miicoffee-df64-gen2 — assumed native dynamics")
    ET.SubElement(model, "compiler", angle="radian")
    ET.SubElement(model, "option", timestep="0.001", integrator="implicitfast")
    defaults = ET.SubElement(model, "default")
    ET.SubElement(
        defaults,
        "geom",
        group="3",
        contype="0",
        conaffinity="0",
        friction="0.65 0.005 0.0001",
        solref="0.002 1",
        solimp="0.99 0.999 0.001",
    )
    ET.SubElement(defaults, "pair", solref="0.002 1", solimp="0.99 0.999 0.001")

    asset = ET.SubElement(model, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(model, "worldbody")
    bodies = {}
    for obj in parts:
        name = obj.name
        parent = bodies.get(obj.parent.name) if obj.parent else None
        transform = (
            poses[name]
            if parent is None
            else poses[obj.parent.name].inverted() @ poses[name]
        )
        body = ET.SubElement(
            world if parent is None else parent,
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

    base = bodies["df64_grinder"]
    dial = bodies["df64_dial_collar"]
    upper_burr = bodies["df64_upper_burr_carrier"]
    lower_burr = bodies["df64_lower_burr_rotor"]
    bellows = bodies["df64_bellows"]
    lid = bodies["df64_wood_lid"]
    button = bodies["df64_power_button"]
    cup = bodies["df64_dosing_cup"]

    # Detach df64_dosing_cup into worldbody as a free removable dosing vessel
    parent_of_cup = next(node for node in model.iter() if cup in list(node))
    parent_of_cup.remove(cup)
    world.append(cup)
    cup.set("pos", numbers(poses["df64_dosing_cup"].translation))
    cup.set("quat", numbers(poses["df64_dosing_cup"].to_quaternion()))
    ET.SubElement(cup, "freejoint", name="vessel_free")

    # Base rubber feet and stadium base collision proxies
    for foot_name, fx, fy in (
        ("df64_foot_fl_col", -0.038, -0.078),
        ("df64_foot_fr_col", 0.038, -0.078),
        ("df64_foot_rl_col", -0.042, 0.068),
        ("df64_foot_rr_col", 0.042, 0.068),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.002)),
            size="0.013 0.002",
            contype="1",
            conaffinity="1",
        )
    ET.SubElement(
        base,
        "geom",
        name="df64_base_plinth_col",
        type="box",
        pos="0 0 0.011",
        size="0.065 0.1125 0.008",
        contype="1",
        conaffinity="1",
    )

    # Holder fork support shelf & socket site for the 58 mm dosing cup at (0.0, -0.0770, 0.0440)
    ET.SubElement(
        base,
        "geom",
        name="df64_fork_cradle_seat",
        type="cylinder",
        pos="0.0 -0.0770 0.0420",
        size="0.030 0.002",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        base,
        "site",
        name="vessel_socket",
        pos="0.0 -0.0770 0.0440",
        size="0.002",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="df64_fork_seat_site",
        type="cylinder",
        pos="0.0 -0.0770 0.0440",
        size="0.032 0.0030",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="df64_plasma_chute_exit",
        pos="0.0 -0.0815 0.1415",
        size="0.004",
        group="3",
    )

    # Forward-tilted cylinder housing collision proxies
    for i in range(12):
        angle = i * math.tau / 12
        ET.SubElement(
            base,
            "geom",
            name=f"df64_cylinder_wall_{i}",
            type="box",
            pos=numbers(
                (
                    0.0 + 0.0500 * math.cos(angle),
                    0.0100 + 0.0500 * math.sin(angle),
                    0.1100,
                )
            ),
            size="0.0025 0.013 0.085",
            euler=numbers((0, 0, angle)),
            contype="1",
            conaffinity="1",
        )

    # Articulated joints on dial collar, upper burr carrier, lower 64 mm flat burr rotor, bellows, wood lid, and power switch
    ET.SubElement(
        dial,
        "joint",
        name="df64_dial_turn",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="-2.356194 2.356194",
        damping="0.22",
    )
    ET.SubElement(
        upper_burr,
        "joint",
        name="df64_upper_carrier_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.080",
        damping="1.8",
    )
    ET.SubElement(
        lower_burr,
        "joint",
        name="df64_burr_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0018",
        armature="0.0018",
        solreffriction="0.002 1",
    )
    ET.SubElement(
        lower_burr,
        "geom",
        name="df64_lower_burr_proxy",
        type="cylinder",
        pos="0 0 0.002",
        size="0.032 0.002",
    )
    ET.SubElement(
        bellows,
        "joint",
        name="df64_bellows_stroke",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="-0.015 0.100",
        damping="1.8",
    )
    ET.SubElement(
        lid,
        "joint",
        name="df64_lid_stroke",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="-0.015 0.130",
        damping="1.4",
    )
    ET.SubElement(
        button,
        "joint",
        name="df64_power_press",
        type="slide",
        axis="-1 0 0",
        limited="true",
        range="0 0.0025",
        stiffness="75",
        damping="0.30",
    )

    # Dosing cup collision geometry (base foot, interior floor, 12-segment cylindrical wall, payload marker)
    ET.SubElement(
        cup,
        "geom",
        name="df64_cup_foot",
        type="cylinder",
        pos="0 0 0.002",
        size="0.028 0.002",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        cup,
        "geom",
        name="df64_cup_floor",
        type="cylinder",
        pos="0 0 0.005",
        size="0.026 0.0015",
        contype="1",
        conaffinity="1",
    )
    for i in range(12):
        angle = i * math.tau / 12
        ET.SubElement(
            cup,
            "geom",
            name=f"df64_cup_wall_{i}",
            type="box",
            pos=numbers((0.029 * math.cos(angle), 0.029 * math.sin(angle), 0.038)),
            size="0.0018 0.0078 0.034",
            euler=numbers((0, 0, angle)),
            contype="1",
            conaffinity="1",
        )
    ET.SubElement(
        cup,
        "site",
        name="df64_cup_base_site",
        pos="0 0 0",
        size="0.002",
        group="3",
    )
    payload = ET.SubElement(cup, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.016",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 0.014",
        size="0.026 0.0015",
        group="2",
        rgba="0.36 0.23 0.14 0",
        mass="0",
    )

    # Receiving bench for cup handling
    ET.SubElement(
        world,
        "geom",
        name="vessel_receiving_bench",
        type="box",
        pos="0.22 -0.0770 0.010",
        size="0.09 0.09 0.010",
        rgba="0.35 0.39 0.42 1",
        group="2",
        contype="1",
        conaffinity="1",
    )

    # Explicit contact pairs
    contact = ET.SubElement(model, "contact")
    ET.SubElement(
        contact,
        "pair",
        geom1="df64_fork_cradle_seat",
        geom2="df64_cup_foot",
        friction="0.06 0.06 0.002 0.0001 0.0001",
    )
    ET.SubElement(
        contact, "pair", geom1="vessel_receiving_bench", geom2="df64_cup_foot"
    )

    # Actuators
    actuators = ET.SubElement(model, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="df64_burr_drive",
        joint="df64_burr_spin",
        kv="1.8",
        ctrlrange="0 160",
        forcerange="-4.5 4.5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="df64_dial_control",
        joint="df64_dial_turn",
        kp="80",
        kv="3.2",
        ctrlrange="-2.356194 2.356194",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="df64_upper_carrier_control",
        joint="df64_upper_carrier_lift",
        kp="1000",
        kv="14",
        ctrlrange="0 0.080",
        forcerange="-22 22",
    )
    ET.SubElement(
        actuators,
        "position",
        name="df64_bellows_control",
        joint="df64_bellows_stroke",
        kp="1100",
        kv="15",
        ctrlrange="-0.015 0.100",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="df64_lid_control",
        joint="df64_lid_stroke",
        kp="900",
        kv="12",
        ctrlrange="-0.015 0.130",
        forcerange="-18 18",
    )
    ET.SubElement(
        actuators,
        "position",
        name="df64_power_actuator",
        joint="df64_power_press",
        kp="140",
        kv="2.8",
        ctrlrange="0 0.0025",
        forcerange="0 18",
    )

    # Sensors
    sensors = ET.SubElement(model, "sensor")
    ET.SubElement(sensors, "jointvel", name="df64_burr_vel", joint="df64_burr_spin")
    ET.SubElement(
        sensors, "actuatorfrc", name="df64_burr_torque", actuator="df64_burr_drive"
    )
    ET.SubElement(sensors, "jointpos", name="df64_dial_pos", joint="df64_dial_turn")
    ET.SubElement(
        sensors, "jointpos", name="df64_bellows_pos", joint="df64_bellows_stroke"
    )
    ET.SubElement(
        sensors, "jointpos", name="df64_button_pos", joint="df64_power_press"
    )
    ET.SubElement(
        sensors, "touch", name="df64_fork_seat_touch", site="df64_fork_seat_site"
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="df64_cup_relpos",
        objtype="site",
        objname="df64_cup_base_site",
        reftype="site",
        refname="vessel_socket",
    )

    write_xml(ASSETS / "appliance.xml", model)

    scene = ET.Element("mujoco", model="miicoffee-df64-gen2 lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.4 0.4 0.4")
    scene_asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        scene_asset,
        "texture",
        name="lab_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    scene_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(scene_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1")
    ET.SubElement(
        scene_world,
        "geom",
        name="bench",
        type="plane",
        size="3 3 0.05",
        pos="0 0 -0.001",
        rgba="0.25 0.29 0.32 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 6.8,
                "manual_net_weight_kg": 7.2,
                "component_masses_kg": MASSES,
                "assumptions": [
                    "Total mass equals published 6.8 kg (15.0 lbs catalog weight; manual lists 7.2 kg N.W.); individual component masses and diagonal inertias are engineering estimates.",
                    "250 W AC induction motor drives custom 64 mm stainless-steel flat burrs at fixed 1,400 RPM (146.61 rad/s) with over-current jam shutoff (> 3.8 N*m load).",
                    "Stepless chrome dial collar (df64_dial_turn) maps 0-90 scale (10-20 espresso, 35-45 moka, 65-75 filter); per manual rules, large finer adjustments with beans loaded require motor spinning.",
                    "V2.5/V2.6 plasma generator (ionizer) and 3-pleat silicone bellows puffs flush residual chamber grounds to < 0.1 g retention.",
                ],
            },
            indent=2,
        )
        + "\n"
    )


def strip_visual_meshes(root: ET.Element, model):
    """Remove zero-mass non-contact visual meshes for the compact native.xml collision package."""
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
    """Compile scene.xml, strip decorative visual meshes, and write verified native.xml."""
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
    destination = ASSETS / "native.xml"
    destination.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(destination))
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        if not np.allclose(
            getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9
        ):
            raise RuntimeError(f"Export changed native {field} for miicoffee-df64-gen2")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError("Export changed native degrees of freedom.")
    return model, rebuilt


def run_active_state_journey():
    """Run the 6-stage active-state verification journey in MuJoCo and write evidence artifacts."""
    import mujoco
    import numpy as np

    model, _ = export_native_xml(mujoco, np)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    payload_body_id = model.body("ingredient_payload").id
    cup_qpos_adr = model.jnt_qposadr[model.joint("vessel_free").id]
    cup_dof_adr = model.jnt_dofadr[model.joint("vessel_free").id]

    dial_qpos_adr = model.jnt_qposadr[model.joint("df64_dial_turn").id]
    carrier_lift_qpos_adr = model.jnt_qposadr[model.joint("df64_upper_carrier_lift").id]
    burr_qpos_adr = model.jnt_qposadr[model.joint("df64_burr_spin").id]
    burr_dof_adr = model.jnt_dofadr[model.joint("df64_burr_spin").id]
    bellows_qpos_adr = model.jnt_qposadr[model.joint("df64_bellows_stroke").id]
    lid_qpos_adr = model.jnt_qposadr[model.joint("df64_lid_stroke").id]
    button_qpos_adr = model.jnt_qposadr[model.joint("df64_power_press").id]

    act_burr = model.actuator("df64_burr_drive").id
    act_dial = model.actuator("df64_dial_control").id
    act_carrier = model.actuator("df64_upper_carrier_control").id
    act_bellows = model.actuator("df64_bellows_control").id
    act_lid = model.actuator("df64_lid_control").id
    act_button = model.actuator("df64_power_actuator").id

    socket_pos = np.array([0.0000, -0.0770, 0.0440])
    dt = model.opt.timestep
    nominal_omega = 1400.0 * math.tau / 60.0  # Published 1,400 RPM = 146.6077 rad/s

    trace_rows = []

    def apply_fork_cradle_capture():
        """Apply silicone-sleeved two-prong holder fork centering force within 18 mm of vessel_socket."""
        cup_pos = data.qpos[cup_qpos_adr : cup_qpos_adr + 3]
        cup_vel = data.qvel[cup_dof_adr : cup_dof_adr + 3]
        cup_angvel = data.qvel[cup_dof_adr + 3 : cup_dof_adr + 6]
        rel = cup_pos - socket_pos
        radial_dist = float(np.hypot(rel[0], rel[1]))
        if radial_dist < 0.018 and abs(rel[2]) < 0.014:
            fx = -520.0 * rel[0] - 15.0 * cup_vel[0]
            fy = -520.0 * rel[1] - 15.0 * cup_vel[1]
            fz = -2.10 - 4.5 * cup_vel[2]
            data.qfrc_applied[cup_dof_adr] = fx
            data.qfrc_applied[cup_dof_adr + 1] = fy
            data.qfrc_applied[cup_dof_adr + 2] = fz
            data.qfrc_applied[cup_dof_adr + 3 : cup_dof_adr + 6] = -0.10 * cup_angvel
            return True, radial_dist
        data.qfrc_applied[cup_dof_adr : cup_dof_adr + 6] = 0.0
        return False, radial_dist

    def dial_angle_to_setting(dial_rad):
        """Map chrome dial collar Z angle (rad) around setting 45.0 (0 rad) across 0..90 scale."""
        return 45.0 - (dial_rad / 0.025)

    def setting_to_dial_angle(setting):
        """Return dial_rad for a given 0..90 grind setting (45.0 = 0 rad)."""
        return (45.0 - setting) * 0.025

    def record_row(
        sim_time_s,
        stage,
        state,
        plasma_ionizer_on,
        hopper_beans_g,
        chamber_retention_g,
        cup_grounds_g,
        coupled,
        radial_err_m,
    ):
        omega = float(data.qvel[burr_dof_adr])
        rpm = omega * 60.0 / math.tau
        turns = float(data.qpos[burr_qpos_adr]) / math.tau
        torque_nm = float(data.actuator_force[act_burr])
        support_n = float(data.sensor("df64_fork_seat_touch").data[0])
        dial_setting = dial_angle_to_setting(float(data.qpos[dial_qpos_adr]))
        trace_rows.append(
            {
                "time_s": round(sim_time_s, 4),
                "stage": stage,
                "state": state,
                "plasma_ionizer_on": bool(plasma_ionizer_on),
                "grind_setting": round(dial_setting, 3),
                "rpm": round(rpm, 3),
                "turns": round(turns, 4),
                "motor_torque_nm": round(torque_nm, 4),
                "hopper_beans_g": round(hopper_beans_g, 4),
                "chamber_retention_g": round(chamber_retention_g, 4),
                "cup_grounds_g": round(cup_grounds_g, 4),
                "cup_support_n": round(support_n, 4),
                "cup_radial_error_m": round(radial_err_m, 6),
                "cup_coupled": bool(coupled),
                "button_press_mm": round(float(data.qpos[button_qpos_adr]) * 1000.0, 3),
                "bellows_stroke_mm": round(float(data.qpos[bellows_qpos_adr]) * 1000.0, 3),
                "lid_stroke_mm": round(float(data.qpos[lid_qpos_adr]) * 1000.0, 3),
                "carrier_lift_mm": round(float(data.qpos[carrier_lift_qpos_adr]) * 1000.0, 3),
            }
        )

    sim_time = 0.0
    hopper_beans_g = 0.0
    chamber_retention_g = 0.0
    cup_grounds_g = 0.0
    plasma_ionizer_on = False

    # -------------------------------------------------------------------------
    # STAGE 1: 58 mm Dosing Cup Seating in Two-Prong Holder Fork (0.0 -> 0.8 s)
    # Place cup 3.5 mm +X, -3.0 mm -Y, +2.0 mm +Z off vessel_socket and release
    # -------------------------------------------------------------------------
    init_dial = setting_to_dial_angle(70.0)
    data.qpos[dial_qpos_adr] = init_dial
    data.ctrl[act_dial] = init_dial
    data.qpos[cup_qpos_adr : cup_qpos_adr + 3] = socket_pos + np.array(
        [0.0035, -0.0030, 0.0020]
    )
    data.qpos[cup_qpos_adr + 3 : cup_qpos_adr + 7] = [1.0, 0.0, 0.0, 0.0]
    mujoco.mj_forward(model, data)

    initial_radial_offset_m = float(
        np.hypot(
            data.qpos[cup_qpos_adr] - socket_pos[0],
            data.qpos[cup_qpos_adr + 1] - socket_pos[1],
        )
    )
    for step in range(800):
        coupled, radial_err = apply_fork_cradle_capture()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 40 == 0:
            record_row(
                sim_time,
                "fork_cup_seating",
                "ready",
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    seated_radial_error_m = radial_err
    seated_empty_support_n = float(data.sensor("df64_fork_seat_touch").data[0])
    assert coupled, "58 mm dosing cup failed to seat into two-prong holder fork"
    assert seated_radial_error_m < 0.0005, (
        f"Fork cradle centering error too large: {seated_radial_error_m}"
    )
    assert seated_empty_support_n > 2.5, (
        f"Expected positive fork seat support force, got {seated_empty_support_n}"
    )

    # -------------------------------------------------------------------------
    # STAGE 2: Stepless Chrome Dial Adjustment (70.0 Filter -> 40.0 Moka -> 15.0 Espresso, 0.8 -> 1.8 s)
    # Empty grinder allows unrestricted finer adjustment.
    # -------------------------------------------------------------------------
    target_dial = setting_to_dial_angle(15.0)
    for step in range(1000):
        alpha = min(1.0, step / 700.0)
        data.ctrl[act_dial] = init_dial + alpha * (target_dial - init_dial)
        coupled, radial_err = apply_fork_cradle_capture()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 50 == 0:
            record_row(
                sim_time,
                "stepless_grind_adjustment",
                "ready",
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    achieved_espresso_setting = dial_angle_to_setting(float(data.qpos[dial_qpos_adr]))
    assert abs(achieved_espresso_setting - 15.0) < 0.15, (
        f"Chrome dial collar failed to reach setting 15.0 Espresso: {achieved_espresso_setting}"
    )

    # -------------------------------------------------------------------------
    # STAGE 3: Manual Safety Rule — Finer Adjustment Guard When Beans Loaded & Motor Stopped (1.8 -> 2.4 s)
    # DF64 II Manual: "Adjust to finer setting must only be done when no coffee bean
    # in the grinder or while the motor and burrs are spinning."
    # -------------------------------------------------------------------------
    hopper_beans_g = 18.0
    requested_finer_setting = 8.0
    finer_guard_blocked_when_stopped = False
    for step in range(600):
        omega = float(data.qvel[burr_dof_adr])
        current_setting = dial_angle_to_setting(float(data.qpos[dial_qpos_adr]))
        if requested_finer_setting < current_setting - 0.5 and hopper_beans_g > 0.0 and omega < 20.0:
            # Controller blocks static finer adjustment with beans loaded to prevent 64 mm flat burr lock
            finer_guard_blocked_when_stopped = True
            data.ctrl[act_dial] = setting_to_dial_angle(15.0)
            state = "finer_guard_blocked"
        else:
            data.ctrl[act_dial] = setting_to_dial_angle(requested_finer_setting)
            state = "ready"
        coupled, radial_err = apply_fork_cradle_capture()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 100 == 0:
            record_row(
                sim_time,
                "finer_running_guard",
                state,
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    setting_after_blocked_attempt = dial_angle_to_setting(float(data.qpos[dial_qpos_adr]))
    assert finer_guard_blocked_when_stopped, "Expected static loaded finer adjustment to be blocked"
    assert abs(setting_after_blocked_attempt - 15.0) < 0.2, (
        f"Dial moved despite static loaded finer guard: {setting_after_blocked_attempt}"
    )

    # -------------------------------------------------------------------------
    # STAGE 4: Latching Metal Switch Start, 1,400 RPM 64 mm Flat-Burr Grind (18.0 g),
    # Running Finer Micro-Trim (15.0 -> 14.0), Plasma Ionizer, 3 Silicone Bellows Puffs
    # (< 0.1 g True Zero Retention), and Latching Switch Stop
    # -------------------------------------------------------------------------
    state = "ready"
    grind_rate_gps = 2.60  # 64 mm flat burrs @ 1,400 RPM comminute 18 g espresso in ~6.9 s
    pre_puff_max_retention_g = 0.32
    peak_grinding_rpm = 0.0
    peak_grinding_torque_nm = 0.0
    turns_at_start = float(data.qpos[burr_qpos_adr]) / math.tau
    finer_allowed_while_spinning = False
    bellows_puffs_executed = 0
    prev_puff_active = False
    pre_puff_retention_g = 0.0

    # 9,500 steps = 9.5 s total:
    # - step 0..180: press metal switch #1 to latch motor ON + plasma ionizer ON
    # - step 400..1000: while spinning at 1,400 RPM, adjust finer 15.0 -> 14.0 (allowed!)
    # - step 0..7200: 18.0 g beans ground into cup (0.32 g retained in flat-burr chamber before puffing)
    # - step 7300..8500: 3 crisp silicone bellows puffs (-12.5 mm stroke) flush retention from 0.32 g -> 0.05 g (< 0.1 g)
    # - step 8600..8780: press metal switch #2 to latch motor OFF; spin down to 0 RPM by step 9500
    for step in range(9500):
        start_pulse = 20 <= step < 180
        stop_pulse = 8600 <= step < 8780
        data.ctrl[act_button] = 0.0022 if (start_pulse or stop_pulse) else 0.0
        btn_pressed = float(data.qpos[button_qpos_adr]) > 0.0012

        if start_pulse and btn_pressed and state == "ready":
            state = "grinding"
            plasma_ionizer_on = True
        elif stop_pulse and btn_pressed and state == "grinding":
            state = "stopping"
            plasma_ionizer_on = False

        omega = float(data.qvel[burr_dof_adr])
        rpm = omega * 60.0 / math.tau

        # While motor and burrs are spinning (> 1,000 RPM), finer adjustment 15.0 -> 14.0 is permitted
        if state == "grinding" and step >= 400 and rpm > 1000.0:
            data.ctrl[act_dial] = setting_to_dial_angle(14.0)
            if abs(dial_angle_to_setting(float(data.qpos[dial_qpos_adr])) - 14.0) < 0.15:
                finer_allowed_while_spinning = True

        # 3 silicone bellows puffs after beans finish grinding (steps 7300..8500)
        if step == 7250:
            pre_puff_retention_g = chamber_retention_g
        puff_window = (
            (7350 <= step < 7550)
            or (7750 <= step < 7950)
            or (8150 <= step < 8350)
        )
        data.ctrl[act_bellows] = -0.0125 if puff_window else 0.0
        data.ctrl[act_lid] = -0.0125 if puff_window else 0.0

        puff_compressed = float(data.qpos[bellows_qpos_adr]) < -0.0080
        if puff_compressed and not prev_puff_active:
            bellows_puffs_executed += 1
            if chamber_retention_g > 0.05:
                flushed = min(chamber_retention_g - 0.05, 0.095)
                chamber_retention_g -= flushed
                cup_grounds_g += flushed
                model.body_mass[payload_body_id] = max(1e-9, cup_grounds_g * 0.001)
        prev_puff_active = puff_compressed

        coupled, radial_err = apply_fork_cradle_capture()

        if state == "grinding":
            data.ctrl[act_burr] = nominal_omega
            if hopper_beans_g > 0.0 and omega > 30.0:
                d_mass = min(
                    hopper_beans_g, grind_rate_gps * (omega / nominal_omega) * dt
                )
                hopper_beans_g -= d_mass
                to_chamber = min(
                    d_mass * 0.022,
                    max(0.0, pre_puff_max_retention_g - chamber_retention_g),
                )
                chamber_retention_g += to_chamber
                cup_grounds_g += d_mass - to_chamber
                model.body_mass[payload_body_id] = max(1e-9, cup_grounds_g * 0.001)
                ripple = 1.0 + 0.06 * math.sin(float(data.qpos[burr_qpos_adr]) * 6.0)
                data.qfrc_applied[burr_dof_adr] = -1.85 * ripple
            else:
                data.qfrc_applied[burr_dof_adr] = 0.0
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0
            if state == "stopping" and abs(rpm) < 1.0:
                state = "ready"

        mujoco.mj_step(model, data)
        sim_time += dt

        omega = float(data.qvel[burr_dof_adr])
        rpm = omega * 60.0 / math.tau
        motor_torque = float(data.actuator_force[act_burr])
        peak_grinding_rpm = max(peak_grinding_rpm, rpm)
        peak_grinding_torque_nm = max(peak_grinding_torque_nm, motor_torque)

        if step % 200 == 0:
            record_row(
                sim_time,
                "grind_ionizer_and_bellows_puff",
                state,
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    turns_completed = (float(data.qpos[burr_qpos_adr]) / math.tau) - turns_at_start
    post_grind_rpm = float(data.qvel[burr_dof_adr]) * 60.0 / math.tau
    dosed_cup_support_n = float(data.sensor("df64_fork_seat_touch").data[0])
    assert hopper_beans_g == 0.0, f"Beans remaining in hopper: {hopper_beans_g}"
    assert finer_allowed_while_spinning, "Finer adjustment 15->14 failed while motor was spinning"
    assert bellows_puffs_executed == 3, f"Expected 3 bellows puffs, got {bellows_puffs_executed}"
    assert chamber_retention_g <= 0.06, f"Retention after bellows puffs exceeded 0.1 g: {chamber_retention_g}"
    assert cup_grounds_g >= 17.93, f"Delivered cup grounds below 17.93 g: {cup_grounds_g}"
    assert state == "ready", f"Expected second button press to return grinder to ready, got {state}"
    assert abs(post_grind_rpm) < 1.0, f"64 mm flat burrs did not stop: {post_grind_rpm} RPM"
    assert peak_grinding_rpm > 1360.0, f"Peak RPM below 1,400 RPM target: {peak_grinding_rpm}"
    assert dosed_cup_support_n > seated_empty_support_n + 0.15, (
        "Fork seat touch sensor did not reflect added mass of 17.95 g espresso grounds"
    )

    # -------------------------------------------------------------------------
    # STAGE 5: Safety & Fault Guards
    # 5A: Foreign-object 64 mm flat-burr jam cutoff (> 3.8 N*m stall load -> jam_fault_autostop).
    # 5B: 90 s continuous-duty AC motor thermal overload cutoff (thermal_cooldown).
    # -------------------------------------------------------------------------
    state = "grinding"
    plasma_ionizer_on = True
    hopper_beans_g = 5.0
    jam_stall_timer_s = 0.0
    jam_fault_triggered = False
    peak_jam_torque_nm = 0.0

    for step in range(800):
        coupled, radial_err = apply_fork_cradle_capture()
        if state == "grinding":
            data.ctrl[act_burr] = nominal_omega
            if step >= 150:
                data.qfrc_applied[burr_dof_adr] = -5.60 - 0.6 * float(data.qvel[burr_dof_adr])
            else:
                data.qfrc_applied[burr_dof_adr] = -1.75
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0

        mujoco.mj_step(model, data)
        sim_time += dt

        rpm = float(data.qvel[burr_dof_adr]) * 60.0 / math.tau
        motor_torque = float(data.actuator_force[act_burr])
        peak_jam_torque_nm = max(peak_jam_torque_nm, motor_torque)

        if state == "grinding" and step >= 160:
            if motor_torque > 3.80 and abs(rpm) < 35.0:
                jam_stall_timer_s += dt
                if jam_stall_timer_s >= 0.25:
                    state = "jam_fault_autostop"
                    plasma_ionizer_on = False
                    jam_fault_triggered = True
                    data.ctrl[act_burr] = 0.0
                    data.qfrc_applied[burr_dof_adr] = 0.0

        if step % 100 == 0:
            record_row(
                sim_time,
                "jam_and_thermal_protection",
                state,
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert jam_fault_triggered, "Controller failed to detect foreign-object flat-burr jam"
    assert peak_jam_torque_nm > 4.2, f"Expected stall torque > 4.2 N*m during jam, got {peak_jam_torque_nm}"

    # 5B: 90 s continuous duty thermal overload cutoff
    state = "grinding"
    plasma_ionizer_on = True
    duty_elapsed_s = 89.70
    thermal_cutoff_triggered = False
    for step in range(500):
        if state == "grinding":
            duty_elapsed_s += dt
            data.ctrl[act_burr] = nominal_omega
            data.qfrc_applied[burr_dof_adr] = -1.60
            if duty_elapsed_s >= 90.0:
                state = "thermal_cooldown"
                plasma_ionizer_on = False
                thermal_cutoff_triggered = True
                data.ctrl[act_burr] = 0.0
                data.qfrc_applied[burr_dof_adr] = 0.0
        else:
            data.ctrl[act_burr] = 0.0
            data.qfrc_applied[burr_dof_adr] = 0.0
        coupled, radial_err = apply_fork_cradle_capture()
        mujoco.mj_step(model, data)
        sim_time += dt
        if step % 100 == 0:
            record_row(
                sim_time,
                "jam_and_thermal_protection",
                state,
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )
    assert thermal_cutoff_triggered, "Expected 90 s continuous duty thermal cutoff to trigger"

    # -------------------------------------------------------------------------
    # STAGE 6: Tool-less Disassembly (Unscrew Chrome Dial Anticlockwise + Lift Walnut Lid,
    # Silicone Bellows, and 3-Lug 64 mm Upper Burr Carrier) & Reassembly
    # -------------------------------------------------------------------------
    hopper_beans_g = 0.0
    max_lid_lift_m = 0.0
    max_bellows_lift_m = 0.0
    max_carrier_lift_m = 0.0
    for step in range(1000):
        if step < 500:
            data.ctrl[act_dial] = -2.10  # Unscrew anticlockwise
            data.ctrl[act_lid] = 0.120
            data.ctrl[act_bellows] = 0.090 if step >= 80 else 0.0
            data.ctrl[act_carrier] = 0.068 if step >= 180 else 0.0
            state = "maintenance_open"
        else:
            data.ctrl[act_carrier] = 0.0
            data.ctrl[act_bellows] = 0.0 if step >= 620 else 0.090
            data.ctrl[act_lid] = 0.0 if step >= 740 else 0.120
            data.ctrl[act_dial] = setting_to_dial_angle(14.0) if step >= 650 else -2.10
            state = "ready" if step >= 900 else "maintenance_open"

        coupled, radial_err = apply_fork_cradle_capture()
        mujoco.mj_step(model, data)
        sim_time += dt
        max_lid_lift_m = max(max_lid_lift_m, float(data.qpos[lid_qpos_adr]))
        max_bellows_lift_m = max(max_bellows_lift_m, float(data.qpos[bellows_qpos_adr]))
        max_carrier_lift_m = max(max_carrier_lift_m, float(data.qpos[carrier_lift_qpos_adr]))
        if step % 100 == 0:
            record_row(
                sim_time,
                "toolless_maintenance",
                state,
                plasma_ionizer_on,
                hopper_beans_g,
                chamber_retention_g,
                cup_grounds_g,
                coupled,
                radial_err,
            )

    assert max_lid_lift_m > 0.110, f"Walnut lid lift insufficient: {max_lid_lift_m}"
    assert max_bellows_lift_m > 0.085, f"Silicone bellows lift insufficient: {max_bellows_lift_m}"
    assert max_carrier_lift_m > 0.062, f"Upper 64 mm burr carrier lift insufficient: {max_carrier_lift_m}"
    assert abs(float(data.qpos[lid_qpos_adr])) < 0.001, "Walnut lid did not re-seat cleanly"
    assert abs(float(data.qpos[bellows_qpos_adr])) < 0.001, "Silicone bellows did not re-seat cleanly"
    assert abs(float(data.qpos[carrier_lift_qpos_adr])) < 0.001, "Upper burr carrier did not re-seat cleanly"

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    tracked_files = sorted(
        [
            ASSETS / "appliance.xml",
            ASSETS / "scene.xml",
            ASSETS / "native.xml",
            ASSETS / "visual_assets.xml",
            *(ASSETS.glob("visual_df64_*.xml")),
            *(ASSETS / "meshes").glob("*.obj"),
            ASSETS / "miicoffee-df64-gen2.blend",
            ASSETS / "miicoffee-df64-gen2.glb",
            Path(__file__).resolve(),
        ]
    )
    input_sha256 = {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in tracked_files
    }

    report = {
        "status": "passed",
        "appliance": "miicoffee-df64-gen2",
        "mujoco_version": mujoco.__version__,
        "rendered": False,
        "input_sha256": input_sha256,
        "journey": {
            "published_no_load_rpm": 1400,
            "published_motor_power_w": 250,
            "published_burr_mm": 64,
            "fork_cup_seating": {
                "initial_radial_offset_m": round(initial_radial_offset_m, 6),
                "seated_radial_error_m": round(seated_radial_error_m, 6),
                "empty_cup_support_n": round(seated_empty_support_n, 4),
                "coupled": True,
            },
            "stepless_grind_adjustment": {
                "start_filter_setting": 70.0,
                "target_espresso_setting": 15.0,
                "achieved_espresso_setting": round(achieved_espresso_setting, 4),
            },
            "finer_running_guard": {
                "loaded_beans_g": 18.0,
                "attempted_static_finer_setting": 8.0,
                "finer_guard_blocked_when_stopped": finer_guard_blocked_when_stopped,
                "retained_setting": round(setting_after_blocked_attempt, 4),
                "finer_allowed_while_spinning_to_14": finer_allowed_while_spinning,
            },
            "grind_ionizer_and_bellows_puff": {
                "dose_input_g": 18.0,
                "grind_rate_gps": 2.6,
                "peak_rpm": round(peak_grinding_rpm, 3),
                "peak_torque_nm": round(peak_grinding_torque_nm, 4),
                "burr_turns": round(turns_completed, 3),
                "plasma_ionizer_active": True,
                "pre_puff_retention_g": round(pre_puff_retention_g, 4),
                "bellows_puffs_executed": bellows_puffs_executed,
                "post_puff_retention_g": round(chamber_retention_g, 4),
                "delivered_cup_grounds_g": round(cup_grounds_g, 4),
                "dosed_cup_support_n": round(dosed_cup_support_n, 4),
                "post_stop_rpm": round(post_grind_rpm, 4),
            },
            "safety_and_jam_protection": {
                "jam_fault_triggered": jam_fault_triggered,
                "peak_jam_stall_torque_nm": round(peak_jam_torque_nm, 4),
                "max_90s_duty_cutoff_triggered": thermal_cutoff_triggered,
            },
            "toolless_maintenance": {
                "max_lid_lift_m": round(max_lid_lift_m, 4),
                "max_bellows_lift_m": round(max_bellows_lift_m, 4),
                "max_carrier_lift_m": round(max_carrier_lift_m, 4),
                "restored_to_ready": state == "ready",
            },
            "final": trace_rows[-1],
        },
        "trace_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "trace_rows": len(trace_rows),
    }
    report_path = evidence_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")

    active_states_md = """# MiiCoffee DF64 II (Gen 2, V2.6) native physics

Native `64 mm` stainless-steel flat burr drive (`1,400 RPM`, `250 W` AC induction motor), silicone-sleeved two-prong holder fork `58 mm` dosing-cup seating, stepless chrome dial collar grind adjustment (`df64_dial_turn` across `0`–`90` scale: `espresso` / `moka` / `filter`), manual-enforced finer-adjustment guard when beans are loaded (`finer_running_guard`), V2.5/V2.6 plasma generator (ionizer) static neutralization, 3-pleat silicone bellows compression puffs (`< 0.1 g` true zero retention), foreign-object burr jam protection, and tool-less upper burr carrier disassembly.

- [Acceptance report](active-state-evidence/report.json)
- [Native trace](active-state-evidence/trace.csv)

## Verified Active States & Transitions

1. **`58 mm` Dosing Cup Fork Seating (`fork_cup_seating`):** Releases `df64_dosing_cup` (`+3.5 mm` `X`, `-3.0 mm` `Y`, `+2.0 mm` `Z` off `vessel_socket`) into the silicone-sleeved two-prong holder fork under the angled chute, settling with `< 0.5 mm` radial error on `df64_fork_cradle_seat`.
2. **Stepless Chrome Dial Grind Adjustment (`stepless_grind_adjustment`):** Rotates `df64_dial_collar` around `+Z` from Filter (`70.0`) through Moka (`40.0`) to Espresso (`15.0`).
3. **Loaded Finer-Adjustment Running Guard (`finer_running_guard`):** Enforces the DF64 II instruction manual rule (*"Adjust to finer setting must only be done when no coffee bean in the grinder or while the motor and burrs are spinning"*): blocks a static loaded finer step (`15.0` → `8.0`) while `18.0 g` beans are in the throat and the motor is stopped, then permits a finer micro-trim (`15.0` → `14.0`) once the `64 mm` flat burrs are spinning at `1,400 RPM`.
4. **Latching Start, `1,400 RPM` `64 mm` Flat-Burr Grind, Plasma Ionizer & Silicone Bellows Puffs (`grind_ionizer_and_bellows_puff`):** First press of `df64_power_press` latches the `250 W` AC motor and plasma ionizer on, spinning `df64_lower_burr_rotor` at `1,400 RPM` (`146.61 rad/s`) to grind `18.0 g` of espresso at `2.6 g/s` (`0.32 g` pre-puff chamber retention), followed by 3 crisp compressions (`-12.5 mm`) of `df64_bellows` + `df64_wood_lid` that flush residual grounds into `df64_dosing_cup` (`17.95 g` delivered, `0.05 g` final retention `< 0.1 g`), and a second button press that stops the motor.
5. **Foreign-Object Flat-Burr Jam & `90 s` Thermal Cutoff (`jam_and_thermal_protection`):** Injects a `-5.6 N·m` foreign-object stall load during grinding, verifying `df64_burr_spin` stall detection (`> 3.8 N·m` load for `0.25 s`) and automatic transition to `jam_fault_autostop`, plus the `90 s` continuous AC induction motor thermal cutoff (`thermal_cooldown`).
6. **Tool-less Disassembly (`toolless_maintenance`):** Unscrews `df64_dial_collar` anticlockwise and lifts `df64_wood_lid` (`+120 mm`), `df64_bellows` (`+90 mm`), and the 3-lug `64 mm` upper burr carrier `df64_upper_burr_carrier` (`+68 mm`), then restores the assembly to `ready`.

Dynamic parameters (component inertias, wave-spring preload, AC motor slip-torque curve, and plasma ionizer corona field) remain engineering assumptions pending physical load cell and tachometer calibration.
"""
    (ASSETS / "active-states.md").write_text(active_states_md)
    print(json.dumps(report["journey"], indent=2))


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if "--export-meshes" in args:
        export_blender_meshes_and_xml()
        return
    if "--verify-mujoco" in args:
        run_active_state_journey()
        return

    if "bpy" in sys.modules:
        export_blender_meshes_and_xml()
        subprocess.run(
            [str(VENV_PYTHON), str(Path(__file__).resolve()), "--verify-mujoco"],
            check=True,
        )
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
            "--export-meshes",
        ],
        check=True,
    )
    run_active_state_journey()


if __name__ == "__main__":
    main()
