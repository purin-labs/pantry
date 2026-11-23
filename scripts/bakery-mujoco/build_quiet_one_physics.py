"""Build and verify MuJoCo 4.0 contact mechanics for the Vitamix Quiet One commercial blender."""

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
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

FOLDER = "vitamix-quiet-one"
ASSETS = ROOT / "assets/bakery-mujoco" / FOLDER
NAMES = (
    "tqo_blender",
    "tqo_enclosure_door",
    "tqo_container",
    "tqo_container_lid",
    "tqo_blade",
)
MASSES = {
    "tqo_blender": 8.0,
    "tqo_enclosure_door": 0.40,
    "tqo_container": 0.65,
    "tqo_container_lid": 0.10,
    "tqo_blade": 0.08,
}
CENTERS = {
    "tqo_blender": (0.0, 0.005, 0.095),
    "tqo_enclosure_door": (0.0, -0.105, -0.055),
    "tqo_container": (0.0, 0.0, 0.110),
    "tqo_container_lid": (0.0, 0.0, 0.010),
    "tqo_blade": (0.0, 0.0, 0.0),
}
INERTIAS = {
    "tqo_blender": (0.085, 0.075, 0.055),
    "tqo_enclosure_door": (0.0042, 0.0040, 0.0035),
    "tqo_container": (0.0032, 0.0032, 0.0020),
    "tqo_container_lid": (0.00022, 0.00022, 0.00038),
    "tqo_blade": (0.00002, 0.00002, 0.000035),
}
VISUAL_MOTIONS = {
    "tqo_door": (1, 0, 0),
    "tqo_lid_lift": (0, 0, 1),
    "tqo_spin": (0, 0, 1),
}


def _box_col(
    body: ET.Element,
    name: str,
    pos: tuple[float, float, float],
    size: tuple[float, float, float],
    rgba: str,
    *,
    quat: str | None = None,
    euler: str | None = None,
    friction: str | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": "box",
        "pos": numbers(pos),
        "size": numbers(size),
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if quat is not None:
        attrib["quat"] = quat
    if euler is not None:
        attrib["euler"] = euler
    if friction is not None:
        attrib["friction"] = friction
    return ET.SubElement(body, "geom", **attrib)


def _cyl_col(
    body: ET.Element,
    name: str,
    pos: tuple[float, float, float],
    size: tuple[float, float],
    rgba: str,
    *,
    quat: str | None = None,
) -> ET.Element:
    attrib: dict[str, str] = {
        "name": name,
        "type": "cylinder",
        "pos": numbers(pos),
        "size": numbers(size),
        "contype": "1",
        "conaffinity": "1",
        "group": "3",
        "rgba": rgba,
    }
    if quat is not None:
        attrib["quat"] = quat
    return ET.SubElement(body, "geom", **attrib)


def _capsule_col(
    body: ET.Element,
    name: str,
    fromto: tuple[float, float, float, float, float, float],
    radius: float,
    rgba: str,
) -> ET.Element:
    return ET.SubElement(
        body,
        "geom",
        name=name,
        type="capsule",
        fromto=numbers(fromto),
        size=f"{radius:.9g}",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=rgba,
    )


def _patch_translucent_materials() -> None:
    path = ASSETS / "visual_assets.xml"
    root = ET.parse(path).getroot()
    for mat in root.findall("material"):
        if mat.get("name") in (
            "visual_TQO clear enclosure polymer",
            "visual_TQO clear container polymer",
        ):
            mat.set("rgba", "0.8 0.9 0.96 0.18")
    write_xml(path, root)


def export_blender_meshes_and_xml() -> None:
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    source = ASSETS / "vitamix-quiet-one.blend"
    parts, poses = prepare_blender_assembly(
        source, NAMES, ASSETS, default_roughness=0.30
    )
    _patch_translucent_materials()

    app = ET.Element("mujoco", model="vitamix-quiet-one — sound-enclosed commercial blender")
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.0005", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="4")

    defaults = add_standard_defaults(
        app,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "tqo_blender" else None)
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

    base = bodies["tqo_blender"]
    door = bodies["tqo_enclosure_door"]
    jar = bodies["tqo_container"]
    lid = bodies["tqo_container_lid"]
    blade = bodies["tqo_blade"]

    # 1. Four rubber feet touching exact Z = 0.000 m
    for label, fx, fy in (
        ("fl", -0.086, -0.094),
        ("fr", 0.086, -0.094),
        ("rl", -0.086, 0.094),
        ("rr", 0.086, 0.094),
    ):
        _box_col(
            base,
            f"tqo_foot_{label}_col",
            (fx, fy, 0.002),
            (0.013, 0.015, 0.002),
            COL_BASE_RGBA,
            friction="0.85 0.015 0.003",
        )

    # 2. Motor housing + centering pad (top at exact Z = 0.1745 m for tqo_jar_foot)
    _box_col(base, "tqo_motor_base_col", (0.0, 0.0, 0.085), (0.108, 0.124, 0.081), COL_BASE_RGBA)
    _box_col(base, "tqo_pad_contact", (-0.009, 0.003, 0.170), (0.067, 0.068, 0.0045), COL_WALL_RGBA)

    # Fixed sound-enclosure rear clear wall + curved black left/right hinge uprights
    _box_col(base, "tqo_rear_wall_col", (0.0, 0.117, 0.304), (0.0995, 0.0035, 0.132), COL_WALL_RGBA)
    for side_lbl, sx in (("l", -0.096), ("r", 0.096)):
        _box_col(base, f"tqo_upright_{side_lbl}_lo_col", (sx, 0.000, 0.232), (0.004, 0.017, 0.062), COL_WALL_RGBA)
        _box_col(base, f"tqo_upright_{side_lbl}_mid_col", (sx, 0.044, 0.318), (0.004, 0.032, 0.044), COL_WALL_RGBA)
        _box_col(base, f"tqo_upright_{side_lbl}_hi_col", (sx, 0.093, 0.390), (0.006, 0.022, 0.048), COL_WALL_RGBA)
    # Lower enclosure frame rim outside the centering pad
    _box_col(base, "tqo_rim_front_col", (0.0, -0.118, 0.169), (0.105, 0.005, 0.003), COL_WALL_RGBA)
    _box_col(base, "tqo_rim_left_col", (-0.102, 0.0, 0.169), (0.005, 0.118, 0.003), COL_WALL_RGBA)
    _box_col(base, "tqo_rim_right_col", (0.102, 0.0, 0.169), (0.005, 0.118, 0.003), COL_WALL_RGBA)

    # Stowed power cord & NEMA plug (kept >= 2 mm above floor so feet carry load cleanly)
    _capsule_col(base, "tqo_cord_exit_col", (0.055, 0.120, 0.026, 0.088, 0.158, 0.009), 0.005, COL_WALL_RGBA)
    _cyl_col(base, "tqo_cord_coil_col", (0.185, 0.106, 0.006), (0.064, 0.004), COL_WALL_RGBA)
    _box_col(base, "tqo_plug_col", (0.245, -0.010, 0.013), (0.014, 0.024, 0.010), COL_WALL_RGBA)

    # 3. Articulated sound-enclosure door (hinge around +X, -105 deg..0 deg)
    # Gravity torque at mid-pose ~0.55 N*m -> frictionloss=1.2 N*m holds cleanly against gravity
    # while tqo_door_fixture (kp=100, forcerange=+-20 N*m) closes within < 0.7 deg (< 2 deg interlock).
    ET.SubElement(
        door,
        "joint",
        name="tqo_door",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range=numbers((-math.radians(105.0), 0.0)),
        damping="0.4",
        armature="0.005",
        frictionloss="1.2",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    # Hollow hood shell (front panel, curved top-front chamfer, roof, left/right side cheeks, handle)
    _box_col(door, "tqo_door_front_col", (0.0, -0.209, -0.082), (0.105, 0.0035, 0.116), COL_ARTIC_RGBA)
    chamfer_q = numbers((math.cos(-math.pi / 8.0), math.sin(-math.pi / 8.0), 0.0, 0.0))
    _box_col(door, "tqo_door_chamfer_col", (0.0, -0.184, 0.060), (0.105, 0.040, 0.0045), COL_ARTIC_RGBA, quat=chamfer_q)
    _box_col(door, "tqo_door_roof_col", (0.0, -0.064, 0.088), (0.105, 0.088, 0.0035), COL_ARTIC_RGBA)
    for side_lbl, sx in (("l", -0.1045), ("r", 0.1045)):
        _box_col(door, f"tqo_door_cheek_{side_lbl}_lo_col", (sx, -0.145, -0.082), (0.003, 0.065, 0.116), COL_ARTIC_RGBA)
        _box_col(door, f"tqo_door_cheek_{side_lbl}_hi_col", (sx, -0.095, 0.036), (0.003, 0.115, 0.053), COL_ARTIC_RGBA)
    _box_col(door, "tqo_door_handle_mt_l_col", (-0.084, -0.217, -0.103), (0.009, 0.009, 0.009), COL_ARTIC_RGBA)
    _box_col(door, "tqo_door_handle_mt_r_col", (0.084, -0.217, -0.103), (0.009, 0.009, 0.009), COL_ARTIC_RGBA)
    _box_col(door, "tqo_door_handle_col", (0.0, -0.228, -0.103), (0.094, 0.006, 0.013), COL_ARTIC_RGBA)
    ET.SubElement(
        door,
        "site",
        name="tqo_door_handle_site",
        type="box",
        pos="0 -0.228 -0.103",
        size="0.060 0.008 0.012",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # 4. Detach tqo_container as free vessel in blender.xml
    parent = next(node for node in app.iter() if jar in list(node))
    parent.remove(jar)
    world.append(jar)
    ET.SubElement(jar, "freejoint", name="vessel_free")
    ET.SubElement(
        parent,
        "site",
        name="vessel_socket",
        pos=jar.get("pos"),
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Container colliders (tqo_jar_foot carries 100% of weight on tqo_pad_contact & bench)
    _box_col(jar, "tqo_jar_foot", (0.0, 0.0, 0.004), (0.050, 0.050, 0.002), COL_ACCESSORY_RGBA)
    _cyl_col(jar, "tqo_inner_floor", (0.0, 0.0, 0.034), (0.052, 0.002), COL_ACCESSORY_RGBA)
    for i in range(24):
        angle = math.tau * i / 24.0
        _box_col(
            jar,
            f"tqo_wall_{i}",
            (0.062 * math.cos(angle), 0.062 * math.sin(angle), 0.133),
            (0.0035, 0.0085, 0.097),
            COL_ACCESSORY_RGBA,
            euler=numbers((0.0, 0.0, angle)),
        )
    # Integral container handle on +X side (preserving open grasp loop)
    _box_col(jar, "tqo_handle_top_col", (0.072, -0.028, 0.214), (0.026, 0.011, 0.010), COL_ACCESSORY_RGBA)
    _box_col(jar, "tqo_handle_bot_col", (0.072, -0.028, 0.094), (0.026, 0.011, 0.010), COL_ACCESSORY_RGBA)
    _box_col(jar, "tqo_handle_grip_col", (0.096, -0.028, 0.154), (0.008, 0.009, 0.062), COL_ACCESSORY_RGBA)

    # 5. Container lid (vertical slide)
    # Gravity load = 0.10 * 9.81 = 0.981 N -> frictionloss = 1.30 N holds cleanly against gravity
    # while tqo_lid_fixture (kp=1000, forcerange=+-10 N) closes within < 0.4 mm (< 4 mm interlock).
    ET.SubElement(
        lid,
        "joint",
        name="tqo_lid_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.10",
        damping="1.0",
        armature="0.002",
        frictionloss="1.30",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    _cyl_col(lid, "tqo_lid_main_col", (0.0, 0.006, 0.0115), (0.072, 0.0125), COL_ARTIC_RGBA)
    _cyl_col(lid, "tqo_lid_plug_col", (0.0, 0.0, 0.029), (0.022, 0.006), COL_ARTIC_RGBA)

    # 6. High-speed Advance blade (symmetric contype=1 conaffinity=1 + contact exclude!)
    ET.SubElement(
        blade,
        "joint",
        name="tqo_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0002",
        armature="0.00001",
        solreffriction="0.004 1",
        solimpfriction="0.9999 0.9999 0.001",
    )
    _cyl_col(blade, "tqo_blade_envelope", (0.0, 0.0, 0.006), (0.038, 0.009), COL_ARTIC_RGBA)

    # Receiving bench for vessel handling
    ET.SubElement(
        world,
        "geom",
        name="vessel_receiving_bench",
        type="box",
        pos="0.32 0 0.09",
        size="0.13 0.17 0.09",
        rgba="0.35 0.39 0.42 1",
        group="2",
        contype="1",
        conaffinity="1",
    )

    # Contact excludes (keep tqo_blender <-> tqo_container enabled so container rests on tqo_pad_contact!)
    model_excludes = (("exclude_blender_door", "tqo_blender", "tqo_enclosure_door"),)
    container_excludes = (
        ("exclude_container_lid", "tqo_container", "tqo_container_lid"),
        ("exclude_container_blade", "tqo_container", "tqo_blade"),
        ("exclude_lid_blade", "tqo_container_lid", "tqo_blade"),
    )
    app_excludes = (
        *model_excludes,
        *container_excludes,
        ("exclude_door_container", "tqo_enclosure_door", "tqo_container"),
        ("exclude_door_lid", "tqo_enclosure_door", "tqo_container_lid"),
        ("exclude_door_blade", "tqo_enclosure_door", "tqo_blade"),
    )
    add_adjacent_excludes(app, app_excludes)

    model_contact = ET.Element("contact")
    for ex_name, b1, b2 in model_excludes:
        ET.SubElement(model_contact, "exclude", name=ex_name, body1=b1, body2=b2)

    # Actuators preserving exact Rust names
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="tqo_drive",
        joint="tqo_spin",
        kv="0.02",
        forcerange="-1.2 1.2",
        ctrlrange="0 2514",
    )
    ET.SubElement(
        actuators,
        "position",
        name="tqo_door_fixture",
        joint="tqo_door",
        kp="100",
        kv="8",
        ctrlrange=numbers((-math.radians(105.0), 0.0)),
        forcerange="-20 20",
    )
    ET.SubElement(
        actuators,
        "position",
        name="tqo_lid_fixture",
        joint="tqo_lid_lift",
        kp="1000",
        kv="10",
        ctrlrange="0 0.09",
        forcerange="-10 10",
    )

    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointvel", name="tqo_blade_velocity", joint="tqo_spin")
    ET.SubElement(sensors, "actuatorfrc", name="tqo_motor_torque", actuator="tqo_drive")

    write_xml(ASSETS / "blender.xml", app)

    scene = ET.Element("mujoco", model="Quiet One native lab")
    ET.SubElement(scene, "include", file="blender.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.4 0.4 0.4")
    s_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(s_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1")
    ET.SubElement(
        s_world,
        "geom",
        name="tqo_bench",
        type="plane",
        size="2 2 0.05",
        pos="0 0 0",
        rgba="0.25 0.29 0.32 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="tqo_blender",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=model_contact,
        accessories=(("container_model.xml", "tqo_container", jar),),
    )
    acc_xml = ET.parse(ASSETS / "container_model.xml").getroot()
    add_adjacent_excludes(acc_xml, container_excludes)
    write_xml(ASSETS / "container_model.xml", acc_xml)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "total_mass_kg": sum(MASSES.values()),
                "component_masses_kg": MASSES,
                "scope": "MuJoCo 4.0 UV+PBR visuals, full housing/enclosure/door/container/lid/blade colliders, standalone model.xml + container_model.xml, and Rust-compatible native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    spec = model_spec(ASSETS / "scene.xml", FOLDER)
    _model, rebuilt = kit_export_native_xml(
        ASSETS, FOLDER, mujoco, np, spec=spec, strip_general_input=True
    )
    assert abs(float(rebuilt.opt.timestep) - 0.0005) < 1e-9, rebuilt.opt.timestep

    for bname in (*NAMES, "ingredient_payload", "live_timer"):
        rebuilt.body(bname)
    for jname in ("tqo_door", "tqo_lid_lift", "tqo_spin", "vessel_free"):
        rebuilt.joint(jname)
    for aname in ("tqo_drive", "tqo_door_fixture", "tqo_lid_fixture"):
        rebuilt.actuator(aname)
    for gname in ("tqo_pad_contact", "tqo_jar_foot", "tqo_inner_floor", "tqo_blade_envelope", "vessel_receiving_bench"):
        rebuilt.geom(gname)
    for sname in ("vessel_socket", "tqo_door_handle_site"):
        rebuilt.site(sname)

    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        FOLDER,
        NAMES,
        VISUAL_MOTIONS,
        mujoco,
        ASSETS / "active-state-evidence",
        cleanup_inputs=True,
    )

    data = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, data)
    door_act = rebuilt.actuator("tqo_door_fixture").id
    lid_act = rebuilt.actuator("tqo_lid_fixture").id
    drive_act = rebuilt.actuator("tqo_drive").id

    # Open door (-105 deg) and lift lid (0.075 m)
    data.ctrl[door_act] = -math.radians(105.0)
    data.ctrl[lid_act] = 0.075
    for _ in range(2000):
        mujoco.mj_step(rebuilt, data)
    door_open_deg = math.degrees(float(data.joint("tqo_door").qpos[0]))
    lid_open_m = float(data.joint("tqo_lid_lift").qpos[0])
    assert door_open_deg <= -95.0, door_open_deg
    assert lid_open_m >= 0.070, lid_open_m

    # Close door and lid, spin blade
    data.ctrl[door_act] = 0.0
    data.ctrl[lid_act] = 0.0
    data.ctrl[drive_act] = 600.0
    for _ in range(3000):
        mujoco.mj_step(rebuilt, data)
    door_closed_deg = math.degrees(abs(float(data.joint("tqo_door").qpos[0])))
    lid_closed_m = float(data.joint("tqo_lid_lift").qpos[0])
    blade_vel = float(data.joint("tqo_spin").qvel[0])
    jar_pos = data.body("tqo_container").xpos
    socket_pos = data.site("vessel_socket").xpos
    seat_err_m = float(np.linalg.norm(jar_pos - socket_pos))
    assert door_closed_deg <= 1.5, door_closed_deg
    assert lid_closed_m <= 0.003, lid_closed_m
    assert blade_vel > 200.0, blade_vel
    assert seat_err_m <= 0.003, seat_err_m
    assert np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))

    print(
        json.dumps(
            {
                "appliance": FOLDER,
                "status": "passed",
                "timestep": float(rebuilt.opt.timestep),
                "native_nq": int(rebuilt.nq),
                "native_nv": int(rebuilt.nv),
                "frames_passed": frames_report["passed"],
                "motion_passed": motion_report["passed"],
                "door_open_deg": round(door_open_deg, 2),
                "door_closed_deg": round(door_closed_deg, 3),
                "lid_open_m": round(lid_open_m, 4),
                "lid_closed_m": round(lid_closed_m, 5),
                "blade_vel_rad_s": round(blade_vel, 1),
                "jar_seat_err_mm": round(seat_err_m * 1000.0, 3),
            },
            indent=2,
        )
    )


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
