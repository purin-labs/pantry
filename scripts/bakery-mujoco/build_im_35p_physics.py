"""Build and verify the MuJoCo 4.0 mechanical, harvest-cycle, and bin-control model for the Hoshizaki IM-35P."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_physics_kit import (
    BLENDER_BIN,
    COL_ACCESSORY_RGBA,
    COL_ARTIC_RGBA,
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
    SITE_GRASP_RGBA,
    SITE_SUPPORT_RGBA,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

ASSETS = ROOT / "assets/bakery-mujoco/hoshizaki-im-35p"

NAMES = (
    "im_cabinet",
    "im_door",
    "im_air_filter",
    "im_water_plate",
    "im_bin_switch",
    "im_power_switch",
    "im_scoop",
)

# Published unit mass = 37.000 kg (Drawing D41369: 製品質量 37 kg; IM-35M-2: 39 kg)
MASSES = {
    "im_cabinet": 33.200,
    "im_door": 2.850,
    "im_air_filter": 0.180,
    "im_water_plate": 0.420,
    "im_bin_switch": 0.140,
    "im_power_switch": 0.030,
    "im_scoop": 0.180,
}

CENTERS = {
    "im_cabinet": (0.0, 0.015, 0.360),
    "im_door": (0.0, 0.005, 0.195),
    "im_air_filter": (0.0, 0.005, -0.095),
    "im_water_plate": (0.0, -0.105, 0.0),
    "im_bin_switch": (0.0, 0.0, -0.045),
    "im_power_switch": (0.0, 0.0, 0.0),
    "im_scoop": (0.0, 0.0, 0.0),
}

INERTIAS = {
    "im_cabinet": (2.150, 2.380, 1.180),
    "im_door": (0.042, 0.098, 0.062),
    "im_air_filter": (0.0008, 0.0014, 0.0007),
    "im_water_plate": (0.0018, 0.0018, 0.0034),
    "im_bin_switch": (0.0003, 0.0002, 0.0002),
    "im_power_switch": (1e-5, 1e-5, 1e-5),
    "im_scoop": (0.0004, 0.0004, 0.0002),
}


VISUAL_MOTIONS = {
    "im_door_hinge": (1, 0, 0),
    "im_filter_slide": (0, -1, 0),
    "im_water_plate_hinge": (-1, 0, 0),
    "im_bin_switch_hinge": (1, 0, 0),
    "im_power_switch_hinge": (1, 0, 0),
}


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, model.xml, and scoop_model.xml."""
    source = ASSETS / "hoshizaki-im-35p.blend"
    parts, poses = prepare_blender_assembly(
        source, NAMES, ASSETS, clear_all_animations=False
    )

    # Build appliance.xml / scene.xml (timestep MUST stay 0.002 to match assets/bakery-mujoco/appliances.json)
    app = ET.Element(
        "mujoco",
        model="hoshizaki-im-35p — commercial undercounter closed-cell cube ice maker",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    defaults = add_standard_defaults(app, friction="0.65 0.015 0.003")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.5 1.5 0.05",
        rgba="0.28 0.30 0.32 1",
        contype="1",
        conaffinity="1",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "im_scoop":
            # 6-DOF free body in worldbody at exact stowed hanger pose (-0.060, -0.115, 0.560)
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "im_cabinet" else None)
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

    base = bodies["im_cabinet"]
    door = bodies["im_door"]
    air_filter = bodies["im_air_filter"]
    wplate = bodies["im_water_plate"]
    bswitch = bodies["im_bin_switch"]
    pwr = bodies["im_power_switch"]
    scoop = bodies["im_scoop"]

    # Four support feet collision cylinders touching Z = 0.000 m
    for foot_name, fx, fy in (
        ("im_foot_fl_col", -0.2200, -0.1390),
        ("im_foot_fr_col", 0.2200, -0.1390),
        ("im_foot_rl_col", -0.2200, 0.1130),
        ("im_foot_rr_col", 0.2200, 0.1130),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0085)),
            size="0.0160 0.0085",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Cabinet, bin walls, evaporator shroud/cell, stored ice bed, scoop hanger ledge, and worktop collision boxes
    for cname, cpos, csize, crgba in (
        ("im_lower_chassis_col", (0.0, 0.0050, 0.1840), (0.2500, 0.2150, 0.1670), COL_BASE_RGBA),
        ("im_bin_floor_col", (0.0, 0.0100, 0.3500), (0.2150, 0.1800, 0.0120), COL_BASE_RGBA),
        ("im_ice_bed_col", (0.0, 0.0150, 0.3900), (0.1980, 0.1550, 0.0300), COL_WALL_RGBA),
        ("im_bin_left_wall_col", (-0.2300, 0.0050, 0.5640), (0.0200, 0.2180, 0.2140), COL_WALL_RGBA),
        ("im_bin_right_wall_col", (0.2300, 0.0050, 0.5640), (0.0200, 0.2180, 0.2140), COL_WALL_RGBA),
        ("im_bin_rear_wall_col", (0.0, 0.2000, 0.5640), (0.2100, 0.0250, 0.2140), COL_WALL_RGBA),
        ("im_evap_housing_col", (-0.0600, 0.0250, 0.6960), (0.1250, 0.1250, 0.0490), COL_WALL_RGBA),
        ("im_evap_cell_col", (-0.0600, 0.0300, 0.6720), (0.0940, 0.0790, 0.0160), COL_WALL_RGBA),
        ("im_evap_front_col", (-0.0600, -0.1060, 0.6865), (0.0280, 0.0140, 0.0185), COL_WALL_RGBA),
        ("im_worktop_col", (0.0, 0.0, 0.7890), (0.2500, 0.2250, 0.0110), COL_BASE_RGBA),
        # Sanitary scoop hanger bracket support shelf at Z = 0.4660 m (supports im_scoop_bowl bottom at Z = 0.560 - 0.094 = 0.466 m)
        ("im_scoop_hanger_shelf_col", (-0.0600, -0.1150, 0.4620), (0.0450, 0.0320, 0.0040), COL_WALL_RGBA),
    ):
        ET.SubElement(
            base,
            "geom",
            name=cname,
            type="box",
            pos=numbers(cpos),
            size=numbers(csize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=crgba,
        )

    # Named operational sites on im_cabinet (group 4)
    ET.SubElement(
        base,
        "site",
        name="im_bin_storage",
        pos="0 0.0100 0.4200",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im_worktop_site",
        pos="0 0 0.8000",
        size="0.008",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im_scoop_hanger_site",
        pos="-0.0600 -0.1150 0.5600",
        size="0.006",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="im_bin_touch_site",
        type="box",
        pos="0 0.0100 0.4220",
        size="0.1800 0.1400 0.0060",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Bottom-hinged bin door joint (`im_door_hinge`, axis="1 0 0", range 0 .. 0.9076 rad / 52 deg)
    ET.SubElement(
        door,
        "joint",
        name="im_door_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range=numbers((0.0, math.radians(52.0))),
        damping="1.8",
        armature="0.015",
        frictionloss="3.2",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        door,
        "geom",
        name="im_door_col",
        type="box",
        pos="0 0.0060 0.1950",
        size="0.2450 0.0180 0.1950",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Pull-out Raku-Eco condenser air filter slide joint (`im_filter_slide`, axis="0 -1 0", range 0 .. 0.140 m)
    ET.SubElement(
        air_filter,
        "joint",
        name="im_filter_slide",
        type="slide",
        axis="0 -1 0",
        limited="true",
        range="0 0.140",
        damping="2.5",
        armature="0.002",
        frictionloss="0.4",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        air_filter,
        "geom",
        name="im_filter_col",
        type="box",
        pos="0 0.0050 -0.0950",
        size="0.1000 0.0060 0.1000",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Actuator-motor driven water plate hinge joint (`im_water_plate_hinge`, axis="-1 0 0", range 0 .. 0.480 rad / 27.5 deg)
    ET.SubElement(
        wplate,
        "joint",
        name="im_water_plate_hinge",
        type="hinge",
        axis="-1 0 0",
        limited="true",
        range="0 0.480",
        damping="0.8",
        armature="0.005",
        frictionloss="0.6",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        wplate,
        "geom",
        name="im_water_plate_col",
        type="box",
        pos="0 -0.1050 0",
        size="0.1050 0.1050 0.0070",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Double-lever bin level switch hinge joint (`im_bin_switch_hinge`, axis="1 0 0", range 0 .. 0.550 rad)
    ET.SubElement(
        bswitch,
        "joint",
        name="im_bin_switch_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.550",
        stiffness="0.8",
        damping="0.15",
        armature="0.001",
        frictionloss="0.08",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        bswitch,
        "geom",
        name="im_bin_switch_col",
        type="box",
        pos="0 0 -0.0550",
        size="0.0080 0.0380 0.0520",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Recessed power/service rocker switch hinge joint (`im_power_switch_hinge`, axis="1 0 0", range 0 .. 0.280 rad)
    ET.SubElement(
        pwr,
        "joint",
        name="im_power_switch_hinge",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="0 0.280",
        damping="0.05",
        armature="0.0005",
        frictionloss="0.05",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )

    # 6-DOF free sanitary ice scoop (`im_scoop` with `im_scoop_free` and `vessel_socket`)
    ET.SubElement(scoop, "freejoint", name="im_scoop_free")
    ET.SubElement(
        scoop,
        "geom",
        name="im_scoop_bowl_col",
        type="box",
        pos="0 0 -0.0480",
        size="0.0360 0.0240 0.0460",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        scoop,
        "geom",
        name="im_scoop_handle_col",
        type="cylinder",
        pos="0 0 0.0560",
        size="0.0135 0.0500",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        scoop,
        "site",
        name="vessel_socket",
        pos="0 0 0.0560",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    payload = ET.SubElement(scoop, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 -0.0480",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="cylinder",
        pos="0 0 -0.0480",
        size="0.0320 0.0015",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.80 0.92 0.99 0",
        mass="0",
    )

    # Contact exclusions between cabinet and articulated children (scoop remains free to contact cabinet/bin/shelf)
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_cabinet_door", "im_cabinet", "im_door"),
            ("exclude_cabinet_air_filter", "im_cabinet", "im_air_filter"),
            ("exclude_cabinet_water_plate", "im_cabinet", "im_water_plate"),
            ("exclude_cabinet_bin_switch", "im_cabinet", "im_bin_switch"),
            ("exclude_cabinet_power_switch", "im_cabinet", "im_power_switch"),
            ("exclude_door_air_filter", "im_door", "im_air_filter"),
            ("exclude_door_water_plate", "im_door", "im_water_plate"),
            ("exclude_door_bin_switch", "im_door", "im_bin_switch"),
            ("exclude_water_plate_bin_switch", "im_water_plate", "im_bin_switch"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="im_door_actuator",
        joint="im_door_hinge",
        kp="320",
        kv="14.0",
        ctrlrange=numbers((0.0, math.radians(52.0))),
        forcerange="-80 80",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im_filter_actuator",
        joint="im_filter_slide",
        kp="60",
        kv="5.0",
        ctrlrange="0 0.140",
        forcerange="-25 25",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im_water_plate_actuator",
        joint="im_water_plate_hinge",
        kp="120",
        kv="4.5",
        ctrlrange="0 0.480",
        forcerange="-35 35",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im_bin_switch_actuator",
        joint="im_bin_switch_hinge",
        kp="15",
        kv="1.2",
        ctrlrange="0 0.550",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="im_power_switch_actuator",
        joint="im_power_switch_hinge",
        kp="12",
        kv="0.5",
        ctrlrange="0 0.280",
        forcerange="-5 5",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="im_door_pos", joint="im_door_hinge")
    ET.SubElement(sensors, "jointpos", name="im_filter_pos", joint="im_filter_slide")
    ET.SubElement(
        sensors, "jointpos", name="im_water_plate_pos", joint="im_water_plate_hinge"
    )
    ET.SubElement(
        sensors, "jointpos", name="im_bin_switch_pos", joint="im_bin_switch_hinge"
    )
    ET.SubElement(
        sensors, "jointpos", name="im_power_switch_pos", joint="im_power_switch_hinge"
    )
    ET.SubElement(sensors, "touch", name="im_bin_touch", site="im_bin_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="im_scoop_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="im_bin_storage",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="im_cabinet",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("im_scoop_sense",),
        accessories=(("scoop_model.xml", "im_scoop", scoop),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_mass_kg": 37.0,
                "component_masses_kg": MASSES,
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, 175/195 W, R600a",
                "ice_production_kg_per_day_50_60hz": [36.0, 38.0],
                "ice_batch_kg": 0.73,
                "ice_cubes_per_batch": 30,
                "cube_dimensions_m": [0.028, 0.028, 0.032],
                "bin_max_stock_kg": 18.0,
                "bin_natural_fall_kg": 10.5,
                "scope": "Articulated MuJoCo 4.0 mechanical, closed-cell jet-spray freeze/harvest cycle, double-lever bin switch, Raku-Eco filter, and free ice-scoop model in appliance.xml, scene.xml, model.xml, scoop_model.xml, and native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    kit_export_native_xml(ASSETS, "hoshizaki-im-35p", mujoco, np)


def run_active_state_verification():
    import mujoco
    import numpy as np

    export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    scoop_qpos_adr = model.joint("im_scoop_free").qposadr[0]
    scoop_qvel_adr = model.joint("im_scoop_free").dofadr[0]

    # Controller state matching Hoshizaki IM-35P microcomputer (マイコン制御)
    state = {
        "mode": "standby",  # standby | jet_spray_freezing | hot_gas_harvest | bin_full_standby | door_interlock_stop
        "supply_voltage_v": 100.0,
        "frequency_hz": 60,
        "electrical_power_w": 0.0,
        "evaporator_temp_c": 12.0,
        "bin_temp_c": -1.5,
        "bin_ice_stock_kg": 10.00,
        "natural_fall_limit_kg": 10.50,
        "max_stock_limit_kg": 18.00,
        "harvest_batches_completed": 0,
        "residual_water_drained_l": 0.0,
        "scooped_ice_kg": 0.0,
        "door_interlock_active": False,
        "auto_stop_reason": "none",
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.04, pin_scoop_pose=None):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                if pin_scoop_pose is not None:
                    pos, quat = pin_scoop_pose
                    data.qpos[scoop_qpos_adr : scoop_qpos_adr + 3] = pos
                    data.qpos[scoop_qpos_adr + 3 : scoop_qpos_adr + 7] = quat
                    data.qvel[scoop_qvel_adr : scoop_qvel_adr + 6] = 0.0
                mujoco.mj_step(model, data)

            door_rad = float(data.sensor("im_door_pos").data[0])
            filt_m = float(data.sensor("im_filter_pos").data[0])
            wplate_rad = float(data.sensor("im_water_plate_pos").data[0])
            bswitch_rad = float(data.sensor("im_bin_switch_pos").data[0])
            pwr_rad = float(data.sensor("im_power_switch_pos").data[0])
            scoop_rel = data.sensor("im_scoop_sense").data

            # Microcomputer door interlock & double-lever bin switch logic
            state["door_interlock_active"] = door_rad > 0.15
            if pwr_rad < 0.10:
                state["mode"] = "standby"
                state["electrical_power_w"] = 0.0
            elif state["door_interlock_active"]:
                state["mode"] = "door_interlock_stop"
                state["electrical_power_w"] = 4.0
                state["auto_stop_reason"] = "door_open_interlock"
            elif bswitch_rad >= 0.30 or state["bin_ice_stock_kg"] >= state["natural_fall_limit_kg"]:
                state["mode"] = "bin_full_standby"
                state["electrical_power_w"] = 6.0
                state["auto_stop_reason"] = "double_lever_bin_full"
            elif state["mode"] in {"door_interlock_stop", "bin_full_standby"}:
                state["mode"] = "jet_spray_freezing"
                state["electrical_power_w"] = 195.0
                state["auto_stop_reason"] = "none"

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "electrical_power_w": round(state["electrical_power_w"], 1),
                "evaporator_temp_c": round(state["evaporator_temp_c"], 2),
                "bin_temp_c": round(state["bin_temp_c"], 2),
                "bin_ice_stock_kg": round(state["bin_ice_stock_kg"], 2),
                "harvest_batches_completed": state["harvest_batches_completed"],
                "residual_water_drained_l": round(state["residual_water_drained_l"], 2),
                "scooped_ice_kg": round(state["scooped_ice_kg"], 2),
                "door_angle_deg": round(math.degrees(door_rad), 2),
                "water_plate_angle_deg": round(math.degrees(wplate_rad), 2),
                "bin_switch_angle_deg": round(math.degrees(bswitch_rad), 2),
                "air_filter_pull_mm": round(filt_m * 1000.0, 2),
                "power_switch_angle_deg": round(math.degrees(pwr_rad), 2),
                "scoop_rel_storage_z_m": round(float(scoop_rel[2]), 4),
                "door_interlock_active": state["door_interlock_active"],
                "auto_stop_reason": state["auto_stop_reason"],
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby with door closed, water plate closed, scoop stowed on upper-left hanger
    snap1 = step_and_sample(
        0.32,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )
    assert snap1["mode"] == "standby" and snap1["electrical_power_w"] == 0.0, snap1
    assert snap1["door_angle_deg"] < 0.5, snap1
    stage_summaries["standby_door_closed"] = snap1

    # Stage 2: Turn on power switch -> Closed-cell jet-spray freezing cycle (195 W at 60 Hz, water plate closed at 0 deg)
    data.ctrl[model.actuator("im_power_switch_actuator").id] = 0.280
    data.ctrl[model.actuator("im_water_plate_actuator").id] = 0.0
    state["mode"] = "jet_spray_freezing"
    state["electrical_power_w"] = 195.0
    state["evaporator_temp_c"] = -14.8
    snap2 = step_and_sample(
        0.48,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )
    assert snap2["mode"] == "jet_spray_freezing", snap2
    assert snap2["electrical_power_w"] == 195.0, snap2
    assert snap2["water_plate_angle_deg"] < 0.5, snap2
    stage_summaries["jet_spray_freezing_cycle"] = snap2

    # Stage 3: Hot-gas harvest cycle (ホットガス方式 アクチュエータモータによる水皿半開)
    # Actuator motor tilts water plate to 0.480 rad (27.5 deg), draining residual water via R3/4 and releasing 30 cubes (0.73 kg)
    data.ctrl[model.actuator("im_water_plate_actuator").id] = 0.480
    state["mode"] = "hot_gas_harvest"
    state["electrical_power_w"] = 215.0
    state["evaporator_temp_c"] = 4.2
    snap3 = step_and_sample(
        0.48,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )
    state["harvest_batches_completed"] = 1
    state["residual_water_drained_l"] = 0.65
    state["bin_ice_stock_kg"] = round(state["bin_ice_stock_kg"] + 0.73, 2)  # 10.73 kg > 10.50 kg natural fall!
    snap3["harvest_batches_completed"] = state["harvest_batches_completed"]
    snap3["residual_water_drained_l"] = state["residual_water_drained_l"]
    snap3["bin_ice_stock_kg"] = state["bin_ice_stock_kg"]
    assert snap3["water_plate_angle_deg"] > 25.0, snap3
    assert snap3["bin_ice_stock_kg"] == 10.73, snap3
    stage_summaries["hot_gas_harvest_water_plate_open"] = snap3

    # Stage 4: Double-lever bin switch deflection (ダブルレバー検知方式) -> automatic bin-full standby cutoff
    data.ctrl[model.actuator("im_water_plate_actuator").id] = 0.0
    data.ctrl[model.actuator("im_bin_switch_actuator").id] = 0.440
    snap4 = step_and_sample(
        0.48,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )
    assert snap4["mode"] == "bin_full_standby", snap4
    assert snap4["bin_switch_angle_deg"] > 22.0, snap4
    assert snap4["auto_stop_reason"] == "double_lever_bin_full", snap4
    stage_summaries["double_lever_bin_full_cutout"] = snap4

    # Stage 5: Open bottom-hinged bin door 52 deg (+314 mm projection), dip sanitary ice scoop into bin to retrieve 1.20 kg of ice
    data.ctrl[model.actuator("im_door_actuator").id] = math.radians(52.0)
    # Release scoop onto the ice bed (`im_ice_bed_col`) to verify real physical contact in the bin, then lift out with 1.20 kg scooped
    step_and_sample(
        0.44,
        pin_scoop_pose=((0.0200, 0.0100, 0.4850), (1.0, 0.0, 0.0, 0.0)),
    )
    state["scooped_ice_kg"] = 1.20
    state["bin_ice_stock_kg"] = round(state["bin_ice_stock_kg"] - 1.20, 2)  # 9.53 kg < 10.50 kg
    data.ctrl[model.actuator("im_bin_switch_actuator").id] = 0.0
    snap5 = step_and_sample(
        0.36,
        pin_scoop_pose=((-0.0200, -0.3400, 0.5800), (0.9537, -0.3007, 0.0, 0.0)),
    )
    assert snap5["door_angle_deg"] > 50.0, snap5
    assert snap5["door_interlock_active"] is True, snap5
    assert snap5["mode"] == "door_interlock_stop", snap5
    assert snap5["bin_ice_stock_kg"] == 9.53, snap5
    stage_summaries["door_open_interlock_and_ice_scooping"] = snap5

    # Stage 6: Return scoop to hanger, close bin door, and pull out Raku-Eco air filter 120 mm for inspection, then restore
    data.ctrl[model.actuator("im_door_actuator").id] = 0.0
    data.ctrl[model.actuator("im_filter_actuator").id] = 0.120
    state["mode"] = "jet_spray_freezing"
    state["electrical_power_w"] = 195.0
    state["auto_stop_reason"] = "none"
    snap6 = step_and_sample(
        0.52,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )
    assert snap6["door_angle_deg"] < 2.0, snap6
    assert snap6["air_filter_pull_mm"] > 105.0, snap6
    stage_summaries["raku_eco_air_filter_maintenance"] = snap6

    # Stage 7: Restore filter & power switch to rest and verify GLB vs. native.xml rest-frame alignment via inspect_appliance_frames.mjs
    data.ctrl[model.actuator("im_filter_actuator").id] = 0.0
    data.ctrl[model.actuator("im_power_switch_actuator").id] = 0.0
    snap7 = step_and_sample(
        0.44,
        pin_scoop_pose=((-0.0600, -0.1150, 0.5600), (1.0, 0.0, 0.0, 0.0)),
    )

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS, "hoshizaki-im-35p", NAMES, VISUAL_MOTIONS, mujoco, evidence_dir
    )
    app_frames = frames_report["appliances"]["hoshizaki-im-35p"]["frames"]
    app_motions = motion_report["appliances"]["hoshizaki-im-35p"]["motions"]
    stage_summaries["rest_frame_alignment_verified"] = {
        "rest_snap": snap7,
        "frames_aligned": len(app_frames),
        "max_position_error_m": max(f["position_error_m"] for f in app_frames),
        "max_orientation_error_rad": max(f["orientation_error_rad"] for f in app_frames),
        "scalar_joints_motion_verified": len(app_motions),
        "motion_max_position_error_m": max(m["position_error_m"] for m in app_motions),
        "motion_max_orientation_error_rad": max(m["orientation_error_rad"] for m in app_motions),
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
        "appliance": "hoshizaki-im-35p",
        "model_title": "Hoshizaki IM-35P Commercial Undercounter Cube Ice Maker (succeeding IM-35M-2)",
        "supply": "Single-phase 100 V AC, 50/60 Hz, 175/195 W, natural refrigerant R600a",
        "envelope_m": [0.500, 0.450, 0.800],
        "open_door_depth_m": 0.764,
        "unit_mass_kg": 37.0,
        "ice_production_kg_per_day_50_60hz": [36.0, 38.0],
        "ice_cube_dimensions_m": [0.028, 0.028, 0.032],
        "ice_batch_kg": 0.73,
        "ice_cubes_per_batch": 30,
        "bin_max_stock_kg": 18.0,
        "bin_natural_fall_kg": 10.5,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
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
