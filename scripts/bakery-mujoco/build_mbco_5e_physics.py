"""Build and verify the MuJoCo 4.0 mechanical, rail-contact, and standalone models for the Maruzen MBCO-5E."""

from __future__ import annotations

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
    Y_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

ASSETS = ROOT / "assets/bakery-mujoco/maruzen-mbco-5e"

NAMES = (
    "mbco_oven",
    "mbco_door",
    "mbco_handle",
)

# Published oven mass = 125.000 kg (112.6 cabinet + 12.0 door + 0.4 handle)
MASSES = {
    "mbco_oven": 112.6,
    "mbco_door": 12.0,
    "mbco_handle": 0.4,
}

CENTERS = {
    "mbco_oven": (0.0, 0.03, 0.3775),
    "mbco_door": (0.311, -0.002, 0.0),
    "mbco_handle": (0.0, -0.027, -0.066),
}

INERTIAS = {
    "mbco_oven": (10.034, 11.629, 13.606),
    "mbco_door": (0.40136, 0.798848, 0.40136),
    "mbco_handle": (0.00105, 0.00105, 0.00006),
}

RAIL_LEVELS_Z = (0.177, 0.265, 0.353, 0.441, 0.529)
SLOT_LEVELS_Z = (0.181, 0.269, 0.357, 0.445, 0.533)

VISUAL_MOTIONS = {
    "mbco_door_hinge": (0, 0, -1),
    "mbco_handle_turn": (0, -1, 0),
}


def _add_col_geom(
    parent: ET.Element,
    name: str,
    gtype: str,
    *,
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    fromto: tuple[float, float, float, float, float, float] | None = None,
    size: str | tuple[float, ...],
    rgba: str = COL_BASE_RGBA,
    mass: float | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": gtype,
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if fromto is not None:
        attrib["fromto"] = numbers(fromto)
    elif pos is not None:
        attrib["pos"] = numbers(pos)
    if quat is not None:
        attrib["quat"] = quat
    attrib["size"] = size if isinstance(size, str) else numbers(size)
    if mass is not None:
        attrib["mass"] = numbers((mass,))
    return ET.SubElement(parent, "geom", **attrib)


def _add_site(
    parent: ET.Element,
    name: str,
    pos: tuple[float, float, float],
    *,
    size: str = "0.005",
    rgba: str = SITE_SUPPORT_RGBA,
) -> ET.Element:
    return ET.SubElement(
        parent,
        "site",
        name=name,
        pos=numbers(pos),
        size=size,
        group="4",
        rgba=rgba,
    )


def _build_tray_body() -> ET.Element:
    """Build the 600 x 400 x 20 mm cold baking tray (2.0 kg) used in scene.xml and tray_model.xml."""
    tray = ET.Element("body", name="mbco_tray", pos="-0.1 -0.013 0.359")
    ET.SubElement(tray, "freejoint", name="mbco_tray_free")
    _add_col_geom(
        tray,
        "mbco_tray_bottom",
        "box",
        pos=(0.0, 0.0, 0.0),
        size=(0.2, 0.3, 0.001),
        rgba=COL_ACCESSORY_RGBA,
        mass=1.6,
    )
    _add_col_geom(
        tray,
        "mbco_tray_left",
        "box",
        pos=(-0.199, 0.0, 0.010),
        size=(0.001, 0.3, 0.009),
        rgba=COL_ACCESSORY_RGBA,
        mass=0.1,
    )
    _add_col_geom(
        tray,
        "mbco_tray_right",
        "box",
        pos=(0.199, 0.0, 0.010),
        size=(0.001, 0.3, 0.009),
        rgba=COL_ACCESSORY_RGBA,
        mass=0.1,
    )
    _add_col_geom(
        tray,
        "mbco_tray_front",
        "box",
        pos=(0.0, -0.299, 0.010),
        size=(0.198, 0.001, 0.009),
        rgba=COL_ACCESSORY_RGBA,
        mass=0.1,
    )
    _add_col_geom(
        tray,
        "mbco_tray_back",
        "box",
        pos=(0.0, 0.299, 0.010),
        size=(0.198, 0.001, 0.009),
        rgba=COL_ACCESSORY_RGBA,
        mass=0.1,
    )
    _add_site(
        tray,
        "mbco_tray_grasp",
        (0.0, -0.3, 0.01),
        size="0.005",
        rgba=SITE_GRASP_RGBA,
    )
    return tray


def export_blender_meshes_and_xml() -> None:
    """Run inside Blender to export UV-mapped visual OBJs and write oven.xml, tray.xml, scene.xml, and standalone models."""
    source = ASSETS / "maruzen-mbco-5e.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    oven_doc = ET.Element("mujoco", model="maruzen_mbco_5e")
    ET.SubElement(oven_doc, "compiler", angle="radian")
    defaults = add_standard_defaults(
        oven_doc,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(oven_doc, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(oven_doc, "worldbody")

    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "mbco_oven" else None)
        )
        parent_el = bodies.get(parent_obj.name) if parent_obj else None
        transform = (
            poses[name]
            if parent_obj is None
            else poses[parent_obj.name].inverted() @ poses[name]
        )
        attrib = {"name": name}
        if parent_el is None:
            attrib["pos"] = "0 0 0"
            attrib["quat"] = "1 0 0 0"
        else:
            attrib["pos"] = numbers(transform.translation)
            quat = transform.to_quaternion()
            if abs(quat.w - 1.0) > 1e-6 or abs(quat.x) > 1e-6 or abs(quat.y) > 1e-6 or abs(quat.z) > 1e-6:
                attrib["quat"] = numbers(quat)
        body = ET.SubElement(world if parent_el is None else parent_el, "body", **attrib)
        ET.SubElement(
            body,
            "inertial",
            pos=numbers(CENTERS[name]),
            mass=numbers((MASSES[name],)),
            diaginertia=numbers(INERTIAS[name]),
        )
        ET.SubElement(body, "include", file=f"visual_{name}.xml")
        bodies[name] = body

    oven = bodies["mbco_oven"]
    door = bodies["mbco_door"]
    handle = bodies["mbco_handle"]

    # Cabinet structural shells (preserving exact chamber opening X in [-0.320, 0.120], Z in [0.135, 0.611])
    for cname, cpos, csize in (
        ("mbco_left_wall", (-0.385, 0.026, 0.3775), (0.065, 0.374, 0.3275)),
        ("mbco_right_wall", (0.285, 0.026, 0.3775), (0.165, 0.374, 0.3275)),
        ("mbco_bottom", (-0.1, 0.026, 0.0925), (0.22, 0.374, 0.0425)),
        ("mbco_top", (-0.1, 0.026, 0.658), (0.22, 0.374, 0.047)),
        ("mbco_back", (-0.1, 0.361, 0.373), (0.22, 0.039, 0.238)),
        # Front exterior trim outside chamber opening (fascia, strike jamb, top lip, lower plinth/gutter)
        ("mbco_top_front_cap_col", (0.0, -0.359, 0.703), (0.450, 0.011, 0.002)),
        ("mbco_front_fascia_col", (0.348, -0.373, 0.381), (0.098, 0.025, 0.320)),
        ("mbco_strike_jamb_col", (0.216, -0.372, 0.381), (0.031, 0.024, 0.320)),
        ("mbco_front_plinth_col", (0.0, -0.3715, 0.057), (0.448, 0.0235, 0.007)),
    ):
        _add_col_geom(oven, cname, "box", pos=cpos, size=csize, rgba=COL_BASE_RGBA)

    # Four 50 mm adjustable rubber feet touching Z = 0.0000 m
    for fname, fx, fy in (
        ("mbco_foot_fl", -0.36, -0.28),
        ("mbco_foot_fr", 0.36, -0.28),
        ("mbco_foot_bl", -0.36, 0.35),
        ("mbco_foot_br", 0.36, 0.35),
    ):
        _add_col_geom(
            oven,
            fname,
            "cylinder",
            pos=(fx, fy, 0.025),
            size=(0.024, 0.025),
            rgba=COL_BASE_RGBA,
        )

    # Rear exhaust stub and power entry fitting
    _add_col_geom(
        oven,
        "mbco_rear_exhaust_col",
        "cylinder",
        pos=(0.395, 0.415, 0.660),
        quat=Y_AXIS_QUAT,
        size=(0.019, 0.015),
        rgba=COL_BASE_RGBA,
    )
    _add_col_geom(
        oven,
        "mbco_rear_power_col",
        "cylinder",
        pos=(0.380, 0.407, 0.130),
        quat=Y_AXIS_QUAT,
        size=(0.012, 0.007),
        rgba=COL_BASE_RGBA,
    )

    # Right-side hand-shower hanger, hose loop, and valve assembly (+35 mm side projection)
    for sname, spos, ssize in (
        ("mbco_shower_head_col", (0.467, -0.265, 0.568), (0.017, 0.048, 0.070)),
        ("mbco_shower_hose_col", (0.472, -0.238, 0.275), (0.008, 0.060, 0.220)),
        ("mbco_shower_valve_col", (0.468, -0.237, 0.090), (0.017, 0.016, 0.016)),
    ):
        _add_col_geom(oven, sname, "box", pos=spos, size=ssize, rgba=COL_WALL_RGBA)

    # 5 pairs of tray support rails at published 88 mm pitch (Z = 0.177 .. 0.529 m)
    for level, rz in enumerate(RAIL_LEVELS_Z, 1):
        _add_col_geom(
            oven,
            f"mbco_rail_{level}_left",
            "box",
            pos=(-0.305, -0.013, rz),
            size=(0.015, 0.32, 0.003),
            rgba=COL_WALL_RGBA,
        )
        _add_col_geom(
            oven,
            f"mbco_rail_{level}_right",
            "box",
            pos=(0.105, -0.013, rz),
            size=(0.015, 0.32, 0.003),
            rgba=COL_WALL_RGBA,
        )

    # Rack mounting uprights, retaining studs, and rail upstands (exact 414 mm gap)
    for side, ux, upstand_x in (("left", -0.313, -0.318), ("right", 0.113, 0.118)):
        for end, uy, stud_y in (("front", -0.258, -0.264), ("rear", 0.262, 0.256)):
            _add_col_geom(
                oven,
                f"mbco_rack_upright_{side}_{end}",
                "box",
                pos=(ux, uy, 0.373),
                size=(0.006, 0.004, 0.227),
                rgba=COL_WALL_RGBA,
            )
            for tier, sz in (("lower", 0.159), ("upper", 0.586)):
                _add_col_geom(
                    oven,
                    f"mbco_rack_stud_{side}_{end}_{tier}",
                    "cylinder",
                    pos=(ux, stud_y, sz),
                    quat=Y_AXIS_QUAT,
                    size=(0.0038, 0.0015),
                    rgba=COL_WALL_RGBA,
                )
        for level, rz in enumerate(RAIL_LEVELS_Z, 1):
            _add_col_geom(
                oven,
                f"mbco_rail_{level}_{side}_upstand",
                "box",
                pos=(upstand_x, -0.013, rz + 0.012),
                size=(0.0015, 0.316, 0.012),
                rgba=COL_WALL_RGBA,
            )

    # Operational tray-slot and chamber sites (group 4, visible)
    for level, sz in enumerate(SLOT_LEVELS_Z, 1):
        _add_site(oven, f"mbco_slot_{level}", (-0.1, -0.013, sz))
    _add_site(oven, "mbco_chamber", (-0.1, -0.013, 0.373))

    # Control-panel interaction sites on child body mbco_panel (group 4, visible)
    panel = ET.SubElement(oven, "body", name="mbco_panel")
    for sname, spos in (
        ("mbco_light_button", (0.348, -0.401, 0.608)),
        ("mbco_power_button", (0.379, -0.401, 0.608)),
        ("mbco_start_stop_button", (0.348, -0.401, 0.428)),
        ("mbco_temperature_readout", (0.343, -0.400, 0.573)),
        ("mbco_timer_readout", (0.343, -0.400, 0.535)),
    ):
        _add_site(panel, sname, spos, size="0.004", rgba=SITE_SUPPORT_RGBA)

    # Left-hinged double-glazed door (mbco_door_hinge, axis="0 0 -1", range 0 .. 110 deg)
    ET.SubElement(
        door,
        "joint",
        name="mbco_door_hinge",
        type="hinge",
        axis="0 0 -1",
        limited="true",
        range="0 1.919862",
        damping="1.5",
        frictionloss="0.3",
        armature="0.025",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    for dname, dpos, dsize in (
        ("mbco_door_left", (0.034, -0.004, 0.0), (0.039, 0.022, 0.316)),
        ("mbco_door_right", (0.590, -0.004, 0.0), (0.037, 0.022, 0.316)),
        ("mbco_door_top", (0.313, -0.004, 0.282), (0.24, 0.022, 0.034)),
        ("mbco_door_bottom", (0.313, -0.004, -0.282), (0.24, 0.022, 0.034)),
        ("mbco_door_glass", (0.313, -0.004, 0.0), (0.24, 0.020, 0.248)),
    ):
        _add_col_geom(door, dname, "box", pos=dpos, size=dsize, rgba=COL_ARTIC_RGBA)
    _add_site(door, "mbco_door_edge", (0.627, -0.026, 0.0))

    # Drop handle (mbco_handle_turn, axis="0 -1 0", range -30 .. +30 deg)
    ET.SubElement(
        handle,
        "joint",
        name="mbco_handle_turn",
        type="hinge",
        axis="0 -1 0",
        limited="true",
        range="-0.523599 0.523599",
        stiffness="0.8",
        damping="0.08",
        frictionloss="0.02",
        armature="0.001",
        solreflimit="0.005 1",
        solreffriction="0.004 1",
    )
    _add_col_geom(
        handle,
        "mbco_handle_hub",
        "cylinder",
        pos=(0.0, -0.013, 0.0),
        quat=Y_AXIS_QUAT,
        size=(0.025, 0.014),
        rgba=COL_ARTIC_RGBA,
    )
    _add_col_geom(
        handle,
        "mbco_handle_lever",
        "capsule",
        fromto=(0.0, -0.033, -0.01, 0.0, -0.033, -0.145),
        size="0.014",
        rgba=COL_ARTIC_RGBA,
    )
    _add_site(
        handle,
        "mbco_handle_grasp",
        (0.0, -0.033, -0.105),
        size="0.007",
        rgba=SITE_GRASP_RGBA,
    )

    # Adjacent articulated-body collision exclusions
    contact = add_adjacent_excludes(
        oven_doc,
        (
            ("exclude_oven_door", "mbco_oven", "mbco_door"),
            ("exclude_door_handle", "mbco_door", "mbco_handle"),
            ("exclude_oven_handle", "mbco_oven", "mbco_handle"),
        ),
    )

    sensors = ET.SubElement(oven_doc, "sensor")
    ET.SubElement(sensors, "jointpos", name="mbco_door_angle", joint="mbco_door_hinge")
    ET.SubElement(sensors, "jointvel", name="mbco_door_speed", joint="mbco_door_hinge")
    ET.SubElement(sensors, "jointpos", name="mbco_handle_angle", joint="mbco_handle_turn")

    # 1. Write oven.xml (included by scene.xml and downstream workcells)
    write_xml(ASSETS / "oven.xml", oven_doc)

    # 2. Write tray.xml (included by scene.xml)
    tray_body = _build_tray_body()
    tray_doc = ET.Element("mujoco", model="mbco_tray_scene")
    add_standard_defaults(
        tray_doc,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )
    tray_world = ET.SubElement(tray_doc, "worldbody")
    tray_world.append(tray_body)
    write_xml(ASSETS / "tray.xml", tray_doc)

    # 3. Write standalone model.xml and tray_model.xml (MjSpec.attach-ready, no floor/actuators)
    emit_standalone_models(
        ASSETS,
        model_name="mbco_oven",
        defaults=defaults,
        asset=asset,
        root_body=oven,
        contact=contact,
        sensors=sensors,
        accessories=(("tray_model.xml", "mbco_tray", tray_body),),
    )

    # 4. Write scene.xml (preserving exact Rust runner actuators, floor, visual/statistic)
    scene_doc = ET.Element("mujoco", model="maruzen_mbco_5e_scene")
    ET.SubElement(scene_doc, "include", file="oven.xml")
    ET.SubElement(scene_doc, "include", file="tray.xml")
    opt = ET.SubElement(
        scene_doc,
        "option",
        timestep="0.002",
        integrator="implicitfast",
        gravity="0 0 -9.81",
    )
    ET.SubElement(opt, "flag", filterparent="disable")
    vis = ET.SubElement(scene_doc, "visual")
    ET.SubElement(
        vis,
        "global",
        azimuth="115",
        elevation="-18",
        offwidth="1440",
        offheight="1080",
    )
    ET.SubElement(vis, "quality", shadowsize="2048")
    ET.SubElement(vis, "headlight", ambient="0.35 0.35 0.35", diffuse="0.7 0.7 0.7")
    ET.SubElement(scene_doc, "statistic", center="0 -0.05 0.35", extent="1.4")
    s_world = ET.SubElement(scene_doc, "worldbody")
    ET.SubElement(s_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1", diffuse="0.8 0.8 0.8")
    ET.SubElement(
        s_world,
        "light",
        pos="2 1 2",
        dir="-1 -0.5 -1",
        diffuse="0.5 0.5 0.5",
        castshadow="false",
    )
    ET.SubElement(
        s_world,
        "geom",
        name="mbco_lab_floor",
        type="plane",
        pos="0 0 -0.001",
        size="2 2 0.05",
        rgba="0.19 0.23 0.23 1",
        contype="1",
        conaffinity="1",
    )
    actuators = ET.SubElement(scene_doc, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="mbco_door_demo",
        joint="mbco_door_hinge",
        kp="35",
        kv="12",
        ctrlrange="0 1.919862",
        forcerange="-8 8",
    )
    ET.SubElement(
        actuators,
        "position",
        name="mbco_handle_demo",
        joint="mbco_handle_turn",
        kp="4",
        kv="0.3",
        ctrlrange="-0.523599 0.523599",
        forcerange="-0.4 0.4",
    )
    write_xml(ASSETS / "scene.xml", scene_doc)


def export_and_verify_native_and_physics() -> None:
    """Export native.xml via live_panels.model_spec, verify parity, frames/motions, and tray clearances."""
    import mujoco
    import numpy as np
    from live_panels import model_spec

    # 1. Verify standalone model.xml compiles and preserves exact 125.0 kg mass budget
    standalone_model = mujoco.MjModel.from_xml_path(str(ASSETS / "model.xml"))
    total_mass = float(np.sum(standalone_model.body_mass[1:]))
    if not math.isclose(total_mass, 125.0, abs_tol=1e-6):
        raise RuntimeError(f"Expected 125.0 kg oven mass, got {total_mass:.6f} kg")

    tray_model = mujoco.MjModel.from_xml_path(str(ASSETS / "tray_model.xml"))
    tray_mass = float(np.sum(tray_model.body_mass[1:]))
    if not math.isclose(tray_mass, 2.0, abs_tol=1e-6):
        raise RuntimeError(f"Expected 2.0 kg tray mass, got {tray_mass:.6f} kg")

    # 2. Export native.xml with live_panels overlays (receiving bench, storage occupant, payload, LEDs)
    spec = model_spec(ASSETS / "scene.xml", "maruzen-mbco-5e")
    _full_model, native_model = kit_export_native_xml(
        ASSETS,
        "maruzen-mbco-5e",
        mujoco,
        np,
        spec=spec,
        strip_general_input=False,
    )

    # 3. Verify GLB vs native.xml rest poses & 21-sample door/handle joint motions
    evidence_dir = ASSETS / "active-state-evidence"
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        "maruzen-mbco-5e",
        NAMES,
        VISUAL_MOTIONS,
        mujoco,
        evidence_dir,
        cleanup_inputs=True,
    )

    # 4. Verify 5-level tray insertion contact clearance (aligned clear, offsets/closed obstructed)
    scene_model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    scene_data = mujoco.MjData(scene_model)
    mujoco.mj_forward(scene_model, scene_data)

    def _tray_obstructed(level: int, x_off: float, door_deg: float) -> bool:
        slot = scene_data.site(f"mbco_slot_{level}").xpos.copy()
        for frac in np.linspace(0.0, 1.0, 51):
            scene_data.joint("mbco_door_hinge").qpos[0] = math.radians(door_deg)
            scene_data.joint("mbco_tray_free").qpos[:] = [
                slot[0] + x_off,
                slot[1] - (1.0 - frac),
                slot[2] + 0.012,
                1.0,
                0.0,
                0.0,
                0.0,
            ]
            mujoco.mj_forward(scene_model, scene_data)
            for ci in range(scene_data.ncon):
                con = scene_data.contact[ci]
                if con.dist >= -1e-5:
                    continue
                g1 = scene_model.geom(con.geom1).name
                g2 = scene_model.geom(con.geom2).name
                if g1.startswith("mbco_tray_") or g2.startswith("mbco_tray_"):
                    return True
        return False

    for level in range(1, 6):
        assert not _tray_obstructed(level, 0.0, 100.0), f"Aligned tray obstructed at level {level}"
        assert _tray_obstructed(level, -0.010, 100.0), f"Left-10mm tray not obstructed at level {level}"
        assert _tray_obstructed(level, 0.010, 100.0), f"Right-10mm tray not obstructed at level {level}"
        assert _tray_obstructed(level, 0.0, 0.0), f"Closed door not obstructing tray at level {level}"

    # 5. Record physics-export.json
    source_blend = ASSETS / "maruzen-mbco-5e.blend"
    export_report = {
        "asset": "maruzen-mbco-5e",
        "source_blend_sha256": hashlib.sha256(source_blend.read_bytes()).hexdigest(),
        "native_sha256": hashlib.sha256((ASSETS / "native.xml").read_bytes()).hexdigest(),
        "retained_bodies": list(NAMES),
        "published_oven_mass_kg": 125.0,
        "tray_mass_kg": 2.0,
        "component_masses_kg": MASSES,
        "rail_levels_z_m": list(RAIL_LEVELS_Z),
        "slot_levels_z_m": list(SLOT_LEVELS_Z),
        "native_nq": int(native_model.nq),
        "native_nv": int(native_model.nv),
        "frames_passed": frames_report["passed"],
        "motion_passed": motion_report["passed"],
        "tray_clearance_levels_verified": 5,
    }
    (ASSETS / "physics-export.json").write_text(json.dumps(export_report, indent=2) + "\n")
    print(json.dumps(export_report, indent=2))


def main() -> None:
    if "--blender-export" in sys.argv or "bpy" in sys.modules:
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
    export_and_verify_native_and_physics()


if __name__ == "__main__":
    main()
