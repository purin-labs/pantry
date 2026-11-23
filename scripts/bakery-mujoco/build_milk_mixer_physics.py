"""Build and verify MuJoCo 4.0 contact mechanics for the Severin SM 3587 induction milk frother."""

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
    z_rot_quat,
)

FOLDER = "severin-sm-3587"
ASSETS = ROOT / "assets/bakery-mujoco" / FOLDER
BODY_NAMES = (
    "sm3587_milk_mixer",
    "sm3587_jug",
    "sm3587_lid",
    "sm3587_stirrer",
)
MASSES = {
    "sm3587_milk_mixer": 1.18,
    "sm3587_jug": 0.38,
    "sm3587_lid": 0.045,
    "sm3587_stirrer": 0.025,
}
CENTERS = {
    "sm3587_milk_mixer": (0.0, 0.0, 0.080),
    "sm3587_jug": (0.006, 0.0, 0.030),
    "sm3587_lid": (0.0, 0.0, 0.0),
    "sm3587_stirrer": (0.0, 0.0, 0.006),
}
INERTIAS = {
    "sm3587_milk_mixer": (0.004, 0.004, 0.003),
    "sm3587_jug": (0.0005, 0.0007, 0.0008),
    "sm3587_lid": (0.000045, 0.000045, 0.00009),
    "sm3587_stirrer": (0.000003, 0.000003, 0.000005),
}
VISUAL_MOTIONS = {
    "sm3587_lid_lift": (0, 0, 1),
    "sm3587_stirrer_spin": (0, 0, 1),
}


def _box_col(
    body: ET.Element,
    name: str,
    pos: tuple[float, float, float],
    size: tuple[float, float, float],
    rgba: str,
    *,
    quat: str | None = None,
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
    return ET.SubElement(body, "geom", **attrib)


def _cyl_col(
    body: ET.Element,
    name: str,
    pos: tuple[float, float, float],
    size: tuple[float, float],
    rgba: str,
    *,
    quat: str | None = None,
    friction: str | None = None,
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
    if friction is not None:
        attrib["friction"] = friction
    return ET.SubElement(body, "geom", **attrib)


def _patch_translucent_materials() -> None:
    path = ASSETS / "visual_assets.xml"
    root = ET.parse(path).getroot()
    for mat in root.findall("material"):
        if mat.get("name") == "visual_Severin transparent lid polymer":
            mat.set("rgba", "0.78 0.88 0.92 0.22")
    write_xml(path, root)


def export_blender_meshes_and_xml() -> None:
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    source = ASSETS / "severin-sm-3587.blend"
    parts, poses = prepare_blender_assembly(
        source, BODY_NAMES, ASSETS, default_roughness=0.35
    )
    _patch_translucent_materials()

    app = ET.Element("mujoco", model="severin-sm-3587 — induction milk frother")
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="5")

    defaults = add_standard_defaults(
        app,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )
    ET.SubElement(defaults, "joint", damping="0.2", solreflimit="0.005 1")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        if name == "sm3587_jug":
            parent_el = world
            pose = poses[name]
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "sm3587_milk_mixer" else None)
            )
            parent_el = bodies.get(parent_obj.name) if parent_obj else None
            pose = (
                poses[name]
                if parent_obj is None
                else poses[parent_obj.name].inverted() @ poses[name]
            )
        body = ET.SubElement(
            world if parent_el is None else parent_el,
            "body",
            name=name,
            pos=numbers(pose.translation),
            quat=numbers(pose.to_quaternion()),
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

    base = bodies["sm3587_milk_mixer"]
    jug = bodies["sm3587_jug"]
    lid = bodies["sm3587_lid"]
    stirrer = bodies["sm3587_stirrer"]

    # 1. Base induction body (Z = 0.000 .. 0.175 m, jug seat top at exact Z = 0.176 m)
    _cyl_col(
        base,
        "sm3587_base_foot_col",
        (0.0, 0.0, 0.009),
        (0.070, 0.009),
        COL_BASE_RGBA,
        friction="0.80 0.015 0.003",
    )
    _cyl_col(base, "sm3587_base_proxy", (0.0, 0.0, 0.084), (0.0685, 0.068), COL_BASE_RGBA)
    _cyl_col(base, "sm3587_collar_col", (0.0, 0.0, 0.163), (0.0645, 0.0115), COL_WALL_RGBA)
    _cyl_col(base, "sm3587_seat_proxy", (0.0, 0.0, 0.171), (0.054, 0.005), COL_WALL_RGBA)
    _cyl_col(
        base,
        "sm3587_dial_col",
        (0.0, -0.0765, 0.060),
        (0.0255, 0.0085),
        COL_WALL_RGBA,
        quat=Y_AXIS_QUAT,
    )
    ET.SubElement(
        base,
        "site",
        name="sm3587_seat",
        pos="0 0 0.176",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="vessel_socket",
        pos="0 0 0.176",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 2. Detachable stainless milk jug (freejoint vessel_free)
    ET.SubElement(jug, "freejoint", name="vessel_free")
    _cyl_col(jug, "sm3587_jug_floor", (0.0, 0.0, 0.0025), (0.058, 0.0025), COL_ACCESSORY_RGBA)
    # 16 hollow jug wall staves (inner r = 0.0605, outer r = 0.0655, Z = 0.005..0.071)
    for idx in range(16):
        ang = idx * math.tau / 16.0
        _box_col(
            jug,
            f"sm3587_jug_wall_{idx}_col",
            (0.063 * math.cos(ang), 0.063 * math.sin(ang), 0.038),
            (0.0025, 0.0128, 0.033),
            COL_ACCESSORY_RGBA,
            quat=numbers(z_rot_quat(ang)),
        )
    # Open-ended cool-touch handle kept >= 4 mm above jug floor so jug rests squarely on sm3587_jug_floor
    _box_col(jug, "sm3587_jug_handle_top_col", (0.091, 0.0, 0.059), (0.029, 0.009, 0.008), COL_ACCESSORY_RGBA)
    _box_col(jug, "sm3587_jug_handle_grip_col", (0.112, 0.0, 0.030), (0.008, 0.009, 0.026), COL_ACCESSORY_RGBA)
    ET.SubElement(
        jug,
        "site",
        name="sm3587_jug_seated",
        pos="0 0 0",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        jug,
        "site",
        name="sm3587_jug_grasp_site",
        type="box",
        pos="0.112 0 0.025",
        size="0.009 0.010 0.025",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # 3. Magnetic stirrer inside jug
    ET.SubElement(
        stirrer,
        "joint",
        name="sm3587_stirrer_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0002",
        armature="0.00001",
        solreffriction="0.004 1",
        solimpfriction="0.9999 0.9999 0.001",
    )
    _cyl_col(stirrer, "sm3587_stirrer_proxy", (0.0, 0.0, 0.0125), (0.022, 0.0125), COL_ARTIC_RGBA)
    ET.SubElement(
        stirrer,
        "geom",
        name="sm3587_rotation_marker",
        type="capsule",
        fromto="0.005 0 0.012 0.021 0 0.012",
        size="0.0015",
        rgba="1 0.65 0.05 1",
        contype="0",
        conaffinity="0",
        mass="0",
        group="2",
    )

    # 4. Transparent jug lid (slide along +Z)
    # Gravity load = 0.045 * 9.81 = 0.441 N -> frictionloss = 0.60 N holds cleanly against gravity
    # while sm3587_lid_fixture (kp=300, forcerange=+-3 N) closes within < 0.6 mm (< 3 mm interlock).
    ET.SubElement(
        lid,
        "joint",
        name="sm3587_lid_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.13",
        damping="0.3",
        armature="0.001",
        frictionloss="0.60",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    _cyl_col(lid, "sm3587_lid_proxy", (0.0, 0.0, -0.0005), (0.065, 0.0035), COL_ARTIC_RGBA)

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

    # Internal jug excludes (keep sm3587_milk_mixer <-> sm3587_jug enabled so jug rests on seat!)
    jug_excludes = (
        ("exclude_jug_lid", "sm3587_jug", "sm3587_lid"),
        ("exclude_jug_stirrer", "sm3587_jug", "sm3587_stirrer"),
        ("exclude_lid_stirrer", "sm3587_lid", "sm3587_stirrer"),
    )
    add_adjacent_excludes(app, jug_excludes)

    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "velocity",
        name="sm3587_mix_drive",
        joint="sm3587_stirrer_spin",
        kv="0.002",
        ctrlrange="0 80",
        forcerange="-0.035 0.035",
    )
    ET.SubElement(
        actuators,
        "position",
        name="sm3587_lid_fixture",
        joint="sm3587_lid_lift",
        kp="300",
        kv="3",
        ctrlrange="0 0.12",
        forcerange="-3 3",
    )

    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="sm3587_angle", joint="sm3587_stirrer_spin")
    ET.SubElement(sensors, "jointvel", name="sm3587_speed", joint="sm3587_stirrer_spin")
    ET.SubElement(sensors, "actuatorfrc", name="sm3587_torque", actuator="sm3587_mix_drive")
    ET.SubElement(sensors, "jointpos", name="sm3587_lid_position", joint="sm3587_lid_lift")

    write_xml(ASSETS / "milk-mixer.xml", app)

    scene = ET.Element("mujoco", model="SM 3587 active-state lab")
    ET.SubElement(scene, "include", file="milk-mixer.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "quality", shadowsize="2048")
    ET.SubElement(visual, "headlight", ambient="0.3 0.3 0.3", diffuse="0.7 0.7 0.7")
    ET.SubElement(scene, "statistic", center="0.015 0 0.13", extent="0.4")
    s_asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        s_asset,
        "texture",
        name="sm3587_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.22 0.27 0.32",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    s_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(s_world, "light", pos="-0.5 -0.6 1", dir="0.3 0.3 -1", diffuse="0.8 0.8 0.8")
    ET.SubElement(s_world, "light", pos="0.4 0.3 0.7", dir="-0.3 -0.3 -1", diffuse="0.5 0.5 0.5", castshadow="false")
    ET.SubElement(
        s_world,
        "geom",
        name="sm3587_bench",
        type="plane",
        pos="0 0 0",
        size="1 1 0.05",
        rgba="0.30 0.34 0.38 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    emit_standalone_models(
        ASSETS,
        model_name="sm3587_milk_mixer",
        defaults=defaults,
        asset=asset,
        root_body=base,
        accessories=(("jug_model.xml", "sm3587_jug", jug),),
    )
    jug_xml = ET.parse(ASSETS / "jug_model.xml").getroot()
    add_adjacent_excludes(jug_xml, jug_excludes)
    write_xml(ASSETS / "jug_model.xml", jug_xml)

    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "body_names": list(BODY_NAMES),
        "total_mass_kg": sum(MASSES.values()),
        "component_masses_kg": MASSES,
        "scope": "MuJoCo 4.0 UV+PBR visuals, full base/jug/lid/stirrer colliders, standalone model.xml + jug_model.xml, and Rust-compatible native.xml.",
    }
    (ASSETS / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    spec = model_spec(ASSETS / "scene.xml", FOLDER)
    _model, rebuilt = kit_export_native_xml(
        ASSETS, FOLDER, mujoco, np, spec=spec, strip_general_input=True
    )
    assert abs(float(rebuilt.opt.timestep) - 0.002) < 1e-9, rebuilt.opt.timestep

    for bname in (*BODY_NAMES, "ingredient_payload", "live_temperature"):
        rebuilt.body(bname)
    for jname in ("sm3587_lid_lift", "sm3587_stirrer_spin", "vessel_free"):
        rebuilt.joint(jname)
    for aname in ("sm3587_mix_drive", "sm3587_lid_fixture"):
        rebuilt.actuator(aname)
    for gname in ("sm3587_base_proxy", "sm3587_seat_proxy", "sm3587_jug_floor", "vessel_receiving_bench"):
        rebuilt.geom(gname)
    for sname in ("sm3587_seat", "vessel_socket", "sm3587_jug_seated"):
        rebuilt.site(sname)

    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        FOLDER,
        BODY_NAMES,
        VISUAL_MOTIONS,
        mujoco,
        ASSETS / "active-state-evidence",
        cleanup_inputs=True,
    )

    data = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, data)
    lid_act = rebuilt.actuator("sm3587_lid_fixture").id
    drive_act = rebuilt.actuator("sm3587_mix_drive").id

    # Open lid to 0.08 m
    data.ctrl[lid_act] = 0.08
    for _ in range(500):
        mujoco.mj_step(rebuilt, data)
    lid_open_m = float(data.joint("sm3587_lid_lift").qpos[0])
    assert abs(lid_open_m - 0.08) < 0.005, lid_open_m

    # Close lid and spin stirrer
    data.ctrl[lid_act] = 0.0
    data.ctrl[drive_act] = 60.0
    for _ in range(600):
        mujoco.mj_step(rebuilt, data)
    lid_closed_m = float(data.joint("sm3587_lid_lift").qpos[0])
    stirrer_vel = float(data.joint("sm3587_stirrer_spin").qvel[0])
    jug_pos = data.body("sm3587_jug").xpos
    socket_pos = data.site("vessel_socket").xpos
    seat_err_m = float(np.linalg.norm(jug_pos - socket_pos))
    assert lid_closed_m <= 0.0025, lid_closed_m
    assert stirrer_vel > 40.0, stirrer_vel
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
                "lid_open_m": round(lid_open_m, 4),
                "lid_closed_m": round(lid_closed_m, 5),
                "stirrer_vel_rad_s": round(stirrer_vel, 2),
                "jug_seat_err_mm": round(seat_err_m * 1000.0, 3),
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
