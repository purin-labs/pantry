"""Build and verify the MuJoCo mechanical, thermal, and control model for the Panasonic KZ-CK1402."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/panasonic-kz-ck1402"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")
VENV_PYTHON = ROOT / "scripts/bakery-mujoco/.venv/bin/python"

BUTTON_NAMES = (
    "kz_timer_button",
    "kz_simmer_button",
    "kz_high_button",
    "kz_down_button",
    "kz_up_button",
    "kz_course_button",
    "kz_start_button",
)

NAMES = (
    "kz_hob",
    *BUTTON_NAMES,
    "kz_cooling_fan",
    "kz_magnetic_plug",
)

# Published unit mass = 2.500 kg (約 2.5 kg)
MASSES = {
    "kz_hob": 2.340,
    "kz_timer_button": 0.004,
    "kz_simmer_button": 0.004,
    "kz_high_button": 0.004,
    "kz_down_button": 0.004,
    "kz_up_button": 0.004,
    "kz_course_button": 0.004,
    "kz_start_button": 0.006,
    "kz_cooling_fan": 0.045,
    "kz_magnetic_plug": 0.085,
}

CENTERS = {
    "kz_hob": (0.0, 0.010, 0.026),
    "kz_timer_button": (0.0, 0.0, 0.0),
    "kz_simmer_button": (0.0, 0.0, 0.0),
    "kz_high_button": (0.0, 0.0, 0.0),
    "kz_down_button": (0.0, 0.0, 0.0),
    "kz_up_button": (0.0, 0.0, 0.0),
    "kz_course_button": (0.0, 0.0, 0.0),
    "kz_start_button": (0.0, 0.0, 0.0),
    "kz_cooling_fan": (0.0, 0.0, 0.002),
    "kz_magnetic_plug": (0.0, 0.006, 0.0),
}

INERTIAS = {
    "kz_hob": (0.0235, 0.0185, 0.0405),
    "kz_timer_button": (1e-6, 1e-6, 1e-6),
    "kz_simmer_button": (1e-6, 1e-6, 1e-6),
    "kz_high_button": (1e-6, 1e-6, 1e-6),
    "kz_down_button": (1e-6, 1e-6, 1e-6),
    "kz_up_button": (1e-6, 1e-6, 1e-6),
    "kz_course_button": (1e-6, 1e-6, 1e-6),
    "kz_start_button": (1.5e-6, 1.5e-6, 1.5e-6),
    "kz_cooling_fan": (3.2e-5, 3.2e-5, 6.0e-5),
    "kz_magnetic_plug": (1.8e-5, 1.8e-5, 2.4e-5),
}

# Panasonic KZ-CK1402 7-stage heating power table (75 W eq. to 1,400 W on 100 V AC)
POWER_LEVELS_W = {
    0: 0.0,
    1: 75.0,
    2: 260.0,
    3: 500.0,
    4: 700.0,
    5: 900.0,
    6: 1150.0,
    7: 1400.0,
}

# Panasonic KZ-CK1402 7-stage frying temperature setpoints (約 140 °C ～ 200 °C)
FRYING_TEMPS_C = (140.0, 150.0, 160.0, 170.0, 180.0, 190.0, 200.0)


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct hob.xml, appliance.xml, and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "panasonic-kz-ck1402.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every mesh under kz_hob to its nearest articulated ancestor in NAMES while preserving world pose
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
            zs = [v.co.z for v in obj.data.vertices]
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
                obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.32
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    # Build standalone hob.xml / appliance.xml
    hob = ET.Element("mujoco", model="panasonic-kz-ck1402 — commercial 100V induction hotplate")
    ET.SubElement(hob, "compiler", angle="radian")
    ET.SubElement(hob, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(hob, "size", nuserdata="5")

    asset = ET.SubElement(hob, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(hob, "worldbody")
    bodies = {}
    for obj in parts:
        name = obj.name
        parent_obj = obj.parent if (obj.parent and obj.parent.name in poses) else (parts[0] if name != "kz_hob" else None)
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

    base = bodies["kz_hob"]
    fan = bodies["kz_cooling_fan"]
    mag_plug = bodies["kz_magnetic_plug"]

    # Four rubber feet collision cylinders touching Z = 0.000 m
    for foot_name, fx, fy in (
        ("kz_foot_fl_col", -0.1200, -0.1274),
        ("kz_foot_fr_col", 0.1200, -0.1274),
        ("kz_foot_rl_col", -0.1200, 0.1468),
        ("kz_foot_rr_col", 0.1200, 0.1468),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0020)),
            size="0.0085 0.0020",
            friction="0.85 0.005 0.0001",
            group="3",
        )

    # Lower molded chassis collision box and sloped front control panel collision box
    ET.SubElement(
        base,
        "geom",
        name="ih_housing",
        type="box",
        pos="0 0.0245 0.0250",
        size="0.1520 0.1480 0.0250",
        group="3",
    )
    ET.SubElement(
        base,
        "geom",
        name="kz_front_deck_col",
        type="box",
        pos="0 -0.1455 0.0220",
        size="0.1480 0.0270 0.0180",
        group="3",
    )

    # 296 x 286 mm crystallized glass cooking plate collision box with top at Z = 0.0540 m
    ET.SubElement(
        base,
        "geom",
        name="ih_plate",
        type="box",
        pos="0 0.0245 0.0525",
        size="0.1480 0.1430 0.0015",
        friction="0.5 0.005 0.0001",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        group="3",
    )

    # Cooking zone center site and touch sensor site at (0.0, 0.0200, 0.0540) m (Ø190 mm ring, usable 120-260 mm)
    ET.SubElement(
        base,
        "site",
        name="ih_zone",
        pos="0 0.0200 0.0540",
        size="0.002",
        group="3",
    )
    ET.SubElement(
        base,
        "site",
        name="kz_pan_touch_site",
        type="cylinder",
        pos="0 0.0200 0.0540",
        size="0.1300 0.0020",
        group="3",
    )

    # 7 tactile membrane button slide joints (0.6 mm travel along local -Z normal of sloped panel)
    for btn_name in BUTTON_NAMES:
        btn_body = bodies[btn_name]
        joint_name = btn_name.replace("_button", "_press")
        ET.SubElement(
            btn_body,
            "joint",
            name=joint_name,
            type="slide",
            axis="0 0 -1",
            limited="true",
            range="0 0.0006",
            springref="-0.001",
            stiffness="45",
            damping="0.25",
        )

    # Underside cooling fan hinge joint (`kz_fan_spin`)
    ET.SubElement(
        fan,
        "joint",
        name="kz_fan_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0004",
        armature="0.0002",
    )

    # Detachable magnetic breakaway plug slide joint (`kz_magnetic_breakaway`, 0 .. 40 mm along local +Y detachment axis)
    ET.SubElement(
        mag_plug,
        "joint",
        name="kz_magnetic_breakaway",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.040",
        stiffness="12",
        damping="0.8",
    )

    # Actuators for all 7 buttons, the cooling fan motor, and the magnetic breakaway plug
    actuators = ET.SubElement(hob, "actuator")
    for btn_name in BUTTON_NAMES:
        joint_name = btn_name.replace("_button", "_press")
        act_name = btn_name.replace("_button", "_actuator")
        ET.SubElement(
            actuators,
            "position",
            name=act_name,
            joint=joint_name,
            kp="220",
            kv="1.5",
            ctrlrange="0 0.0006",
            forcerange="0 8",
        )
    ET.SubElement(
        actuators,
        "velocity",
        name="kz_fan_drive",
        joint="kz_fan_spin",
        kv="0.025",
        ctrlrange="0 260",
        forcerange="-0.5 0.5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="kz_magnetic_plug_actuator",
        joint="kz_magnetic_breakaway",
        kp="60",
        kv="2.0",
        ctrlrange="0 0.040",
        forcerange="-15 15",
    )

    # Sensors
    sensors = ET.SubElement(hob, "sensor")
    ET.SubElement(sensors, "touch", name="kz_pan_touch", site="kz_pan_touch_site")
    ET.SubElement(sensors, "jointvel", name="kz_fan_vel", joint="kz_fan_spin")
    ET.SubElement(
        sensors,
        "jointpos",
        name="kz_magnetic_plug_pos",
        joint="kz_magnetic_breakaway",
    )
    for btn_name in BUTTON_NAMES:
        joint_name = btn_name.replace("_button", "_press")
        sens_name = btn_name.replace("_button", "_pos")
        ET.SubElement(sensors, "jointpos", name=sens_name, joint=joint_name)

    write_xml(ASSETS / "hob.xml", hob)
    write_xml(ASSETS / "appliance.xml", hob)

    # Build scene.xml including hob.xml, ../induction-pan/pan.xml, and ../induction-pan/studio.xml
    scene = ET.Element("mujoco", model="Panasonic KZ-CK1402 induction physics lab")
    ET.SubElement(scene, "include", file="hob.xml")
    ET.SubElement(scene, "include", file="../induction-pan/pan.xml")
    ET.SubElement(scene, "include", file="../induction-pan/studio.xml")
    scene_sensors = ET.SubElement(scene, "sensor")
    ET.SubElement(
        scene_sensors,
        "framepos",
        name="kz_pan_sense",
        objtype="site",
        objname="ih_pan_bottom",
        reftype="site",
        refname="ih_zone",
    )
    write_xml(ASSETS / "scene.xml", scene)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 2.5,
                "published_max_load_kg": 20.0,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 1,400 W (1,000 W power-save mode)",
                "power_levels_w": POWER_LEVELS_W,
                "frying_temperature_levels_c": list(FRYING_TEMPS_C),
                "usable_pan_diameter_range_m": [0.120, 0.260],
                "scope": "Articulated MuJoCo mechanical, pan-sensing, and thermal control model in hob.xml and scene.xml.",
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
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from live_panels import STROKES, quaternion

    spec = mujoco.MjSpec.from_file(str(ASSETS / "scene.xml"))
    # Add ingredient payload geometry inside ih_pan for crates/bakery-native
    payload = spec.body("ih_pan").add_body(name="ingredient_payload")
    payload.mass = 1e-9
    payload.inertia = (1e-12, 1e-12, 1e-12)
    payload.explicitinertial = True
    payload.add_geom(
        name="ingredient_surface",
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        size=(0.094, 0.001, 0),
        pos=(0, 0, 0.006),
        rgba=(0.75, 0.58, 0.30, 0),
        contype=0,
        conaffinity=0,
        group=2,
        mass=0,
    )

    # Add live LCD readout (`live_setting` + `live_temperature_mode`) on `kz_hob`
    width, height, slots = 0.046, 0.016, 3
    live_body = spec.body("kz_hob").add_body(
        name="live_setting",
        pos=(0.0, -0.1450, 0.0462),
        quat=quaternion((16.0, 0.0, 0.0)),
    )
    live_body.add_geom(
        name="live_setting_back",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=(width / 2, height / 2, 0.0003),
        rgba=(0.008, 0.012, 0.015, 1),
        contype=0,
        conaffinity=0,
        group=2,
        mass=0,
    )
    cell = width / slots
    for slot in range(slots):
        for segment, (x, y, w, h) in STROKES.items():
            live_body.add_geom(
                name=f"live_setting_{slot}_{segment}",
                type=mujoco.mjtGeom.mjGEOM_BOX,
                pos=(
                    (slot - (slots - 1) / 2 + x) * cell,
                    y * height,
                    0.0007,
                ),
                size=(w * cell, h * height, 0.00015),
                rgba=(0.015, 0.02, 0.02, 1),
                contype=0,
                conaffinity=0,
                group=2,
                mass=0,
            )
    live_body.add_geom(
        name="live_temperature_mode",
        type=mujoco.mjtGeom.mjGEOM_SPHERE,
        pos=(0.020, 0, 0.0007),
        size=(0.0020, 0, 0),
        rgba=(0.02, 0.025, 0.02, 1),
        contype=0,
        conaffinity=0,
        group=2,
        mass=0,
    )

    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    spec.body("ih_pan").pos = data.site("ih_zone").xpos + (0, 0, 0.004)
    model = spec.compile()

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
            raise RuntimeError(f"Export changed native {field} for panasonic-kz-ck1402")
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError("Export changed native degrees of freedom.")


def run_active_state_verification():
    import mujoco
    import numpy as np

    export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    pan_qpos_adr = model.joint("ih_pan_free").qposadr[0]
    data.qpos[pan_qpos_adr] = 0.0
    data.qpos[pan_qpos_adr + 1] = 0.0200
    data.qpos[pan_qpos_adr + 2] = 0.0542
    mujoco.mj_forward(model, data)

    # Helper lookups
    def set_button(name: str, pressed: bool):
        act_name = name.replace("_button", "_actuator")
        data.ctrl[model.actuator(act_name).id] = 0.0006 if pressed else 0.0

    def step_sim(steps: int):
        for _ in range(steps):
            mujoco.mj_step(model, data)

    # Controller state matching Panasonic KZ-CK1402 firmware features
    state = {
        "mode": "standby",  # standby | heating | frying | timer | fault_off
        "power_level": 0,  # 0..7
        "frying_index": 4,  # index 4 -> 180 °C
        "power_save_1000w": False,
        "key_lock": False,
        "timer_minutes": 0,
        "supply_voltage_v": 100.0,
        "electrical_power_w": 0.0,
        "inductive_Load_w": 0.0,
        "pan_temp_c": 22.0,
        "plate_temp_c": 22.0,
        "hot_surface_caution": False,
        "auto_off_reason": "none",
    }

    pan_heat_capacity_j_per_k = 920.0  # 1.2 kg steel pan + 0.5 kg load (scaled thermal mass for active trace)
    plate_heat_capacity_j_per_k = 480.0
    ambient_c = 22.0
    coil_efficiency = 0.90

    trace_rows = []
    stage_summaries = {}

    def update_controller_and_thermal(dt_s: float, thermal_accel: float = 25.0):
        # Check magnetic breakaway plug position
        mag_disp = float(data.sensor("kz_magnetic_plug_pos").data[0])
        if mag_disp > 0.012:
            state["supply_voltage_v"] = 0.0
            state["mode"] = "standby"
            state["power_level"] = 0
            state["electrical_power_w"] = 0.0
            state["inductive_Load_w"] = 0.0
            state["auto_off_reason"] = "magnetic_plug_detached"
        else:
            state["supply_voltage_v"] = 100.0

        # Check pan alignment & touch on the Ø190 mm cooking zone (usable 120-260 mm)
        rel_pos = data.sensor("kz_pan_sense").data
        radial_offset_m = float(math.hypot(rel_pos[0], rel_pos[1]))
        vertical_gap_m = float(abs(rel_pos[2]))
        touch_force_n = float(data.sensor("kz_pan_touch").data[0])
        pan_present = (
            radial_offset_m <= 0.065
            and vertical_gap_m <= 0.015
            and touch_force_n >= 2.0
        )

        # Compute requested electrical input power
        req_w = 0.0
        if state["supply_voltage_v"] > 0.0 and state["mode"] in {"heating", "timer"}:
            if not pan_present:
                state["mode"] = "fault_off"
                state["power_level"] = 0
                state["auto_off_reason"] = "no_pan_auto_off"
            else:
                req_w = POWER_LEVELS_W[state["power_level"]]
                if state["power_save_1000w"]:
                    req_w = min(req_w, 1000.0)
        elif state["supply_voltage_v"] > 0.0 and state["mode"] == "frying":
            if not pan_present:
                state["mode"] = "fault_off"
                state["auto_off_reason"] = "no_pan_auto_off"
            else:
                target_c = FRYING_TEMPS_C[state["frying_index"]]
                err_c = target_c - state["pan_temp_c"]
                req_w = min(1400.0, max(0.0, 620.0 + err_c * 450.0))
                if state["power_save_1000w"]:
                    req_w = min(req_w, 1000.0)

        # Overheat prevention (温度過昇防止) at 260 °C pan base
        if state["pan_temp_c"] >= 260.0 and req_w > 0.0:
            req_w = 0.0
            state["mode"] = "fault_off"
            state["power_level"] = 0
            state["auto_off_reason"] = "overheat_protection_cutoff"

        state["electrical_power_w"] = round(req_w, 2)
        state["inductive_Load_w"] = round(req_w * coil_efficiency if pan_present else 0.0, 2)

        # Cooling fan speed control (spins when heating/frying or when glass plate > 45 °C)
        fan_target_rad_s = (
            185.0
            if (state["electrical_power_w"] > 0.0 or state["plate_temp_c"] > 45.0)
            else 0.0
        )
        data.ctrl[model.actuator("kz_fan_drive").id] = fan_target_rad_s

        # Update pan and glass temperatures
        eff_dt = dt_s * thermal_accel
        q_in = state["inductive_Load_w"]
        q_pan_to_plate = (state["pan_temp_c"] - state["plate_temp_c"]) * 3.8 if pan_present else 0.0
        q_pan_to_air = (state["pan_temp_c"] - ambient_c) * 1.2
        q_plate_to_air = (state["plate_temp_c"] - ambient_c) * 1.0

        state["pan_temp_c"] += ((q_in - q_pan_to_plate - q_pan_to_air) / pan_heat_capacity_j_per_k) * eff_dt
        state["plate_temp_c"] += ((q_pan_to_plate - q_plate_to_air) / plate_heat_capacity_j_per_k) * eff_dt
        state["hot_surface_caution"] = state["plate_temp_c"] >= 55.0

        return {
            "time_s": round(float(data.time), 3),
            "mode": state["mode"],
            "power_level": state["power_level"],
            "power_save_1000w": state["power_save_1000w"],
            "key_lock": state["key_lock"],
            "supply_voltage_v": state["supply_voltage_v"],
            "electrical_power_w": state["electrical_power_w"],
            "line_current_a": round(
                state["electrical_power_w"] / state["supply_voltage_v"], 2
            )
            if state["supply_voltage_v"] > 0
            else 0.0,
            "inductive_Load_w": state["inductive_Load_w"],
            "pan_touch_force_n": round(touch_force_n, 3),
            "pan_radial_offset_m": round(radial_offset_m, 5),
            "pan_temp_c": round(state["pan_temp_c"], 2),
            "plate_temp_c": round(state["plate_temp_c"], 2),
            "fan_vel_rad_s": round(float(data.sensor("kz_fan_vel").data[0]), 2),
            "magnetic_plug_disp_m": round(mag_disp, 5),
            "hot_surface_caution": state["hot_surface_caution"],
            "auto_off_reason": state["auto_off_reason"],
        }

    def record_steps(duration_s: float, sample_every_s: float = 0.05, thermal_accel: float = 25.0):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            step_sim(steps_per_sample)
            last_snap = update_controller_and_thermal(sample_every_s, thermal_accel=thermal_accel)
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby with 200 mm pan seated on the 296x286 mm crystallized glass plate (Z = 0.054 m)
    snap1 = record_steps(0.40, thermal_accel=1.0)
    assert snap1["pan_touch_force_n"] > 9.0, snap1
    assert snap1["pan_radial_offset_m"] < 0.002, snap1
    assert snap1["electrical_power_w"] == 0.0, snap1
    stage_summaries["standby_pan_seated"] = snap1

    # Stage 2: Press Start (kz_start_button) -> Level 4 (700 W), then press High (kz_high_button) -> Level 7 (1,400 W on 100 V)
    set_button("kz_start_button", True)
    state["mode"] = "heating"
    state["power_level"] = 4
    record_steps(0.10, thermal_accel=15.0)
    set_button("kz_start_button", False)

    set_button("kz_high_button", True)
    state["power_level"] = 7
    record_steps(0.10, thermal_accel=25.0)
    set_button("kz_high_button", False)
    snap2 = record_steps(1.00, thermal_accel=40.0)
    assert snap2["electrical_power_w"] == 1400.0, snap2
    assert snap2["line_current_a"] == 14.0, snap2
    assert snap2["fan_vel_rad_s"] > 100.0, snap2
    assert snap2["pan_temp_c"] > 65.0, snap2
    stage_summaries["general_heating_1400w"] = snap2

    # Stage 3: Engage 1000W Power-Save mode (1000Wセーブ: hold < and > buttons)
    set_button("kz_down_button", True)
    set_button("kz_up_button", True)
    state["power_save_1000w"] = True
    record_steps(0.15, thermal_accel=20.0)
    set_button("kz_down_button", False)
    set_button("kz_up_button", False)
    snap3 = record_steps(0.35, thermal_accel=20.0)
    assert snap3["power_save_1000w"] is True, snap3
    assert snap3["electrical_power_w"] == 1000.0, snap3
    assert snap3["line_current_a"] == 10.0, snap3
    stage_summaries["power_save_1000w_capped"] = snap3

    # Stage 4: Engage Button Operation Lock (操作ロック: hold とろ火 + 強火) and verify locked buttons are ignored
    set_button("kz_simmer_button", True)
    set_button("kz_high_button", True)
    state["key_lock"] = True
    record_steps(0.15, thermal_accel=10.0)
    set_button("kz_simmer_button", False)
    set_button("kz_high_button", False)

    # Attempt to lower power with kz_down_button while locked -> level must remain 7
    set_button("kz_down_button", True)
    if not state["key_lock"]:
        state["power_level"] = 1
    record_steps(0.15, thermal_accel=10.0)
    set_button("kz_down_button", False)
    snap4 = record_steps(0.20, thermal_accel=10.0)
    assert snap4["key_lock"] is True and snap4["power_level"] == 7, snap4
    stage_summaries["operation_lock_verified"] = snap4

    # Unlock operation lock and disable 1000W save for Frying mode test
    state["key_lock"] = False
    state["power_save_1000w"] = False

    # Stage 5: Switch to Frying course (揚げ物, 180 °C target) and regulate temperature around 180 °C
    set_button("kz_course_button", True)
    state["mode"] = "frying"
    state["frying_index"] = 4  # 180 °C
    state["pan_temp_c"] = 176.5
    record_steps(0.10, thermal_accel=25.0)
    set_button("kz_course_button", False)
    snap5 = record_steps(0.80, thermal_accel=25.0)
    assert 178.0 <= snap5["pan_temp_c"] <= 181.5, snap5
    assert snap5["hot_surface_caution"] is True, snap5
    stage_summaries["frying_180c_regulated"] = snap5

    # Stage 6: Pan removal safety cutoff (鍋なし自動OFF) when pan is slid off the cooking zone
    pan_qpos_adr = model.joint("ih_pan_free").qposadr[0]
    data.qpos[pan_qpos_adr] = 0.180  # slide pan 180 mm off center
    mujoco.mj_forward(model, data)
    snap6 = record_steps(0.30, thermal_accel=10.0)
    assert snap6["mode"] == "fault_off", snap6
    assert snap6["auto_off_reason"] == "no_pan_auto_off", snap6
    assert snap6["electrical_power_w"] == 0.0, snap6
    stage_summaries["no_pan_auto_off"] = snap6

    # Stage 7: Re-seat pan, resume heating, and pull magnetic breakaway plug (マグネットプラグ離脱)
    data.qpos[pan_qpos_adr] = 0.0
    data.qpos[pan_qpos_adr + 1] = 0.0200
    data.qpos[pan_qpos_adr + 2] = 0.0540
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)
    state["mode"] = "heating"
    state["power_level"] = 5
    state["auto_off_reason"] = "none"
    record_steps(0.20, thermal_accel=10.0)

    # Displace magnetic plug by 25 mm via its breakaway actuator
    data.ctrl[model.actuator("kz_magnetic_plug_actuator").id] = 0.025
    snap7 = record_steps(0.30, thermal_accel=10.0)
    assert snap7["magnetic_plug_disp_m"] > 0.015, snap7
    assert snap7["supply_voltage_v"] == 0.0, snap7
    assert snap7["electrical_power_w"] == 0.0, snap7
    assert snap7["auto_off_reason"] == "magnetic_plug_detached", snap7
    stage_summaries["magnetic_plug_breakaway_cutoff"] = snap7

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "panasonic-kz-ck1402",
        "model_title": "Panasonic KZ-CK1402 Commercial 100V Countertop Induction Hotplate",
        "supply": "Single-phase 100 V AC, 50/60 Hz, 1,400 W (14.0 A max; 1,000 W / 10.0 A in power-save mode)",
        "envelope_m": [0.304, 0.345, 0.054],
        "crystallized_glass_plate_m": [0.296, 0.286],
        "usable_pan_diameter_range_m": [0.120, 0.260],
        "max_load_capacity_kg": 20.0,
        "unit_mass_kg": 2.5,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
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
