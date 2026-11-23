"""Build and verify MuJoCo 4.0 models for Waring WSG60 spice grinder and OHAUS Ranger 3000 scale.

Note: winterhalter-uc-l has its own dedicated builder in build_winterhalter_uc_l_physics.py
and is intentionally NOT touched by this script.
"""

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
    z_rot_quat,
)

ASSETS = ROOT / "assets/bakery-mujoco"

WSG_NAMES = ("wsg_grinder", "wsg_bowl", "wsg_cover", "wsg_blade")
WSG_MASSES = {
    "wsg_grinder": 2.55,
    "wsg_bowl": 0.50,
    "wsg_cover": 0.14,
    "wsg_blade": 0.08,
}
WSG_CENTERS = {
    "wsg_grinder": (0.004, 0.005, 0.082),
    "wsg_bowl": (0.0, 0.0, 0.064),
    "wsg_cover": (0.0, 0.0, 0.062),
    "wsg_blade": (0.0, 0.0, 0.002),
}
WSG_INERTIAS = {
    "wsg_grinder": (0.0155, 0.0125, 0.0135),
    "wsg_bowl": (0.0012, 0.0012, 0.0016),
    "wsg_cover": (0.00048, 0.00048, 0.00072),
    "wsg_blade": (0.000035, 0.000035, 0.000065),
}
WSG_VISUAL_MOTIONS = {
    "wsg_unlock": (0, 0, 1),
    "wsg_cover_lift": (0, 0, 1),
    "wsg_spin": (0, 0, 1),
}

RANGER_NAMES = ("ranger_scale", "ranger_weighing_pan")
RANGER_MASSES = {
    "ranger_scale": 3.80,
    "ranger_weighing_pan": 0.40,
}
RANGER_CENTERS = {
    "ranger_scale": (0.0, 0.008, 0.054),
    "ranger_weighing_pan": (0.0, 0.0, -0.004),
}
RANGER_INERTIAS = {
    "ranger_scale": (0.036, 0.034, 0.062),
    "ranger_weighing_pan": (0.0017, 0.0030, 0.0047),
}
RANGER_VISUAL_MOTIONS = {
    "ranger_cell": (0, 0, 1),
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


def _patch_translucent_materials(assets_dir: Path, overrides: dict[str, str]) -> None:
    path = assets_dir / "visual_assets.xml"
    root = ET.parse(path).getroot()
    changed = False
    for mat in root.findall("material"):
        name = mat.get("name")
        if name in overrides:
            mat.set("rgba", overrides[name])
            changed = True
    if changed:
        write_xml(path, root)


def _append_excludes(xml_path: Path, pairs: tuple[tuple[str, str, str], ...]) -> None:
    root = ET.parse(xml_path).getroot()
    add_adjacent_excludes(root, pairs)
    write_xml(xml_path, root)


def _write_lab_scene(directory: Path, folder: str, *, bench_z: float = 0.0) -> None:
    scene = ET.Element("mujoco", model=f"{folder} lab")
    ET.SubElement(scene, "include", file="appliance.xml")
    visual = ET.SubElement(scene, "visual")
    ET.SubElement(visual, "global", offwidth="1280", offheight="960")
    ET.SubElement(visual, "headlight", ambient="0.4 0.4 0.4")
    s_asset = ET.SubElement(scene, "asset")
    ET.SubElement(
        s_asset,
        "texture",
        name="lab_sky",
        type="skybox",
        builtin="gradient",
        rgb1="0.25 0.30 0.34",
        rgb2="0.07 0.09 0.12",
        width="256",
        height="1536",
    )
    s_world = ET.SubElement(scene, "worldbody")
    ET.SubElement(s_world, "light", pos="-1 -2 3", dir="0.3 0.5 -1")
    ET.SubElement(
        s_world,
        "geom",
        name="bench",
        type="plane",
        size="3 3 0.05",
        pos=numbers((0.0, 0.0, bench_z)),
        rgba="0.25 0.29 0.32 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    write_xml(directory / "scene.xml", scene)


def _build_body_tree(
    world: ET.Element,
    parts,
    poses,
    masses: dict[str, float],
    centers: dict[str, tuple[float, float, float]],
    inertias: dict[str, tuple[float, float, float]],
) -> dict[str, ET.Element]:
    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != parts[0].name else None)
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
            mass=str(masses[name]),
            pos=numbers(centers[name]),
            diaginertia=numbers(inertias[name]),
        )
        ET.SubElement(body, "include", file=f"visual_{name}.xml")
        bodies[name] = body
    return bodies


def export_waring_wsg60() -> None:
    folder = "waring-wsg60"
    directory = ASSETS / folder
    source = directory / "waring-wsg60.blend"
    parts, poses = prepare_blender_assembly(
        source, WSG_NAMES, directory, default_roughness=0.30
    )
    _patch_translucent_materials(
        directory,
        {"visual_WSG clear operating cover": "0.8 0.9 0.96 0.2"},
    )

    app = ET.Element("mujoco", model="waring-wsg60 — commercial spice grinder")
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.001", integrator="implicitfast")
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
    bodies = _build_body_tree(world, parts, poses, WSG_MASSES, WSG_CENTERS, WSG_INERTIAS)

    base = bodies["wsg_grinder"]
    bowl = bodies["wsg_bowl"]
    cover = bodies["wsg_cover"]
    blade = bodies["wsg_blade"]

    # 1. Four rubber feet touching Z = 0.000 m (exact match to visual rubber feet)
    for label, fx, fy in (
        ("fl", -0.061, -0.073),
        ("fr", 0.061, -0.073),
        ("rl", -0.061, 0.078),
        ("rr", 0.061, 0.078),
    ):
        _cyl_col(
            base,
            f"wsg_foot_{label}_col",
            (fx, fy, 0.0045),
            (0.009, 0.0045),
            COL_BASE_RGBA,
            friction="0.85 0.015 0.003",
        )

    # 2. Tapered die-cast motor housing + black base moulding (leaving bowl well open at Z >= 0.150)
    _box_col(base, "wsg_base_plinth_col", (0.0, 0.0, 0.0165), (0.0815, 0.1065, 0.0085), COL_BASE_RGBA)
    _box_col(base, "wsg_housing_lo_col", (0.0, 0.001, 0.0595), (0.080, 0.103, 0.0345), COL_BASE_RGBA)
    _box_col(base, "wsg_housing_hi_col", (0.0, 0.0025, 0.122), (0.0765, 0.095, 0.028), COL_BASE_RGBA)

    # Upper deck flanking the recessed bowl well (well center (0, 0.015), radius 0.050, Z = 0.150..0.177)
    _box_col(base, "wsg_deck_front_col", (0.0, -0.064, 0.1635), (0.073, 0.026, 0.0135), COL_WALL_RGBA)
    _box_col(base, "wsg_deck_rear_col", (0.0, 0.081, 0.1635), (0.073, 0.014, 0.0135), COL_WALL_RGBA)
    _box_col(base, "wsg_deck_left_col", (-0.0635, 0.015, 0.1635), (0.0115, 0.052, 0.0135), COL_WALL_RGBA)
    _box_col(base, "wsg_deck_right_col", (0.0635, 0.015, 0.1635), (0.0115, 0.052, 0.0135), COL_WALL_RGBA)

    # Raised upper bowl seat ring (8 arc boxes around r = 0.0634, Z = 0.176..0.184)
    for idx in range(8):
        ang = idx * math.tau / 8.0
        _box_col(
            base,
            f"wsg_seat_ring_{idx}_col",
            (0.0634 * math.cos(ang), 0.015 + 0.0634 * math.sin(ang), 0.180),
            (0.0114, 0.024, 0.004),
            COL_WALL_RGBA,
            quat=numbers(z_rot_quat(ang)),
        )

    # Recessed bowl drive seat (top at exact Z = 0.160 m to support wsg_bowl at Z = 0.160 m)
    _cyl_col(base, "wsg_seat", (0.0, 0.015, 0.158), (0.042, 0.002), COL_WALL_RGBA)

    # Stowed rear power cord and NEMA 5-15P plug (kept >= 1.5 mm above floor so feet carry load)
    _capsule_col(base, "wsg_cord_strain_col", (0.023, 0.100, 0.047, 0.032, 0.148, 0.018), 0.006, COL_WALL_RGBA)
    _cyl_col(base, "wsg_cord_coil_col", (0.132, 0.125, 0.0055), (0.066, 0.004), COL_WALL_RGBA)
    _box_col(base, "wsg_plug_col", (0.210, 0.038, 0.011), (0.0135, 0.023, 0.009), COL_WALL_RGBA)

    # Detach wsg_bowl as free vessel in appliance.xml (exact Rust runtime protocol)
    parent = next(node for node in app.iter() if bowl in list(node))
    parent.remove(bowl)
    world.append(bowl)
    ET.SubElement(bowl, "freejoint", name="vessel_free")
    ET.SubElement(
        parent,
        "site",
        name="vessel_socket",
        pos=bowl.get("pos"),
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 3. Articulated clear operating cover (bayonet unlock + vertical lift)
    # Gravity load = 0.14 * 9.81 = 1.373 N -> frictionloss = 1.85 N holds cleanly against gravity
    # while wsg_cover_fixture (kp=1200, forcerange=+-20 N) closes within < 0.5 mm (< 3 mm interlock).
    ET.SubElement(
        cover,
        "joint",
        name="wsg_unlock",
        type="hinge",
        axis="0 0 1",
        limited="true",
        range="0 0.32",
        damping="0.1",
        armature="0.001",
        frictionloss="0.12",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        cover,
        "joint",
        name="wsg_cover_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.18",
        damping="2.0",
        armature="0.002",
        frictionloss="1.85",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    # Hollow operating cover dome: 12 vertical staves (inner r = 0.0705 > bowl r = 0.0665) + top cap
    for idx in range(12):
        ang = idx * math.tau / 12.0
        _box_col(
            cover,
            f"wsg_cover_wall_{idx}_col",
            (0.073 * math.cos(ang), 0.073 * math.sin(ang), 0.053),
            (0.0025, 0.0195, 0.053),
            COL_ARTIC_RGBA,
            quat=numbers(z_rot_quat(ang)),
        )
    _cyl_col(cover, "wsg_cover_top_col", (0.0, 0.0, 0.109), (0.071, 0.003), COL_ARTIC_RGBA)
    ET.SubElement(
        cover,
        "site",
        name="wsg_cover_grasp_site",
        type="box",
        pos="0 0 0.112",
        size="0.030 0.030 0.004",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )

    # 4. Detachable stainless grinding bowl + spinning blade
    _cyl_col(bowl, "wsg_foot", (0.0, 0.0, 0.002), (0.040, 0.002), COL_ACCESSORY_RGBA)
    _cyl_col(bowl, "wsg_pedestal_col", (0.0, 0.0, 0.0175), (0.043, 0.0135), COL_ACCESSORY_RGBA)
    _cyl_col(bowl, "wsg_floor", (0.0, 0.0, 0.033), (0.056, 0.002), COL_ACCESSORY_RGBA)
    for i in range(24):
        angle = i * math.tau / 24.0
        _box_col(
            bowl,
            f"wsg_wall_{i}",
            (0.0615 * math.cos(angle), 0.0615 * math.sin(angle), 0.0785),
            (0.004, 0.0085, 0.0425),
            COL_ACCESSORY_RGBA,
            euler=numbers((0.0, 0.0, angle)),
        )

    ET.SubElement(
        blade,
        "joint",
        name="wsg_spin",
        type="hinge",
        axis="0 0 1",
        limited="false",
        damping="0.0002",
        armature="0.00001",
        solreffriction="0.004 1",
    )
    _cyl_col(blade, "wsg_blade_proxy", (0.0, 0.0, 0.004), (0.041, 0.006), COL_ARTIC_RGBA)

    # Receiving bench for vessel-handling tests in Rust/native lab
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

    # Adjacent body excludes (keep wsg_grinder <-> wsg_bowl enabled so bowl rests on wsg_seat!)
    model_excludes = (("exclude_grinder_cover", "wsg_grinder", "wsg_cover"),)
    app_excludes = (
        *model_excludes,
        ("exclude_bowl_blade", "wsg_bowl", "wsg_blade"),
        ("exclude_cover_bowl", "wsg_cover", "wsg_bowl"),
        ("exclude_cover_blade", "wsg_cover", "wsg_blade"),
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
        name="wsg_drive",
        joint="wsg_spin",
        kv="0.02",
        ctrlrange="0 2200",
        forcerange="-0.6 0.6",
    )
    ET.SubElement(
        actuators,
        "position",
        name="wsg_unlock_fixture",
        joint="wsg_unlock",
        ctrlrange="0 0.32",
        kp="15",
        kv="1.5",
        forcerange="-5 5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="wsg_cover_fixture",
        joint="wsg_cover_lift",
        ctrlrange="0 0.17",
        kp="1200",
        kv="18",
        forcerange="-20 20",
    )

    write_xml(directory / "appliance.xml", app)
    _write_lab_scene(directory, folder, bench_z=0.0)

    emit_standalone_models(
        directory,
        model_name="wsg_grinder",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=model_contact,
        accessories=(("bowl_model.xml", "wsg_bowl", bowl),),
    )
    _append_excludes(
        directory / "bowl_model.xml",
        (("exclude_bowl_blade", "wsg_bowl", "wsg_blade"),),
    )

    (directory / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(WSG_NAMES),
                "total_mass_kg": sum(WSG_MASSES.values()),
                "component_masses_kg": WSG_MASSES,
                "scope": "MuJoCo 4.0 UV+PBR visuals, full housing/foot/cover/bowl colliders, standalone model.xml + bowl_model.xml, and Rust-compatible native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_ohaus_ranger_3000() -> None:
    folder = "ohaus-ranger-3000"
    directory = ASSETS / folder
    source = directory / "ohaus-r31pe6.blend"
    parts, poses = prepare_blender_assembly(
        source, RANGER_NAMES, directory, default_roughness=0.36
    )

    app = ET.Element("mujoco", model="ohaus-ranger-3000 — benchtop weighing scale")
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.001", integrator="implicitfast")
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
    bodies = _build_body_tree(
        world, parts, poses, RANGER_MASSES, RANGER_CENTERS, RANGER_INERTIAS
    )

    base = bodies["ranger_scale"]
    pan = bodies["ranger_weighing_pan"]

    # 1. Four adjustable rubber levelling feet touching exact Z = 0.000 m and meeting lower case
    for label, fx, fy in (
        ("fl", -0.130, -0.136),
        ("fr", 0.130, -0.136),
        ("rl", -0.130, 0.135),
        ("rr", 0.130, 0.135),
    ):
        _cyl_col(
            base,
            f"ranger_foot_{label}_col",
            (fx, fy, 0.0095),
            (0.0205, 0.0095),
            COL_BASE_RGBA,
            friction="0.85 0.015 0.003",
        )

    # 2. Sculpted ABS housing following the arched profile, underside cover, and 29 deg display wedge
    _box_col(base, "ranger_front_lip_col", (0.0, -0.154, 0.031), (0.148, 0.0095, 0.019), COL_BASE_RGBA)
    _box_col(base, "ranger_front_under_col", (0.0, -0.103, 0.035), (0.155, 0.046, 0.021), COL_BASE_RGBA)
    _box_col(base, "ranger_front_wedge_fill_col", (0.0, -0.078, 0.064), (0.153, 0.026, 0.023), COL_BASE_RGBA)
    _box_col(base, "ranger_interface_cover_col", (0.0, -0.060, 0.023), (0.080, 0.052, 0.007), COL_BASE_RGBA)
    panel_angle = math.radians(29.0)
    panel_quat = numbers((math.cos(panel_angle / 2.0), math.sin(panel_angle / 2.0), 0.0, 0.0))
    _box_col(
        base,
        "ranger_front_fascia_col",
        (0.0, -0.106, 0.063),
        (0.152, 0.052, 0.015),
        COL_WALL_RGBA,
        quat=panel_quat,
    )
    _box_col(base, "ranger_housing_mid_col", (0.0, 0.014, 0.065), (0.151, 0.072, 0.037), COL_BASE_RGBA)
    _box_col(base, "ranger_housing_rear_col", (0.0, 0.122, 0.059), (0.155, 0.037, 0.043), COL_BASE_RGBA)
    _box_col(base, "ranger_housing_tail_col", (0.0, 0.159, 0.056), (0.132, 0.0045, 0.037), COL_BASE_RGBA)
    _box_col(base, "ranger_subplatform_col", (0.0, 0.038, 0.1075), (0.1425, 0.1055, 0.0055), COL_WALL_RGBA)

    # 3. Spring-loaded stainless weighing pan (MUST keep stiffness=20000, mass=0.4, zero frictionloss
    # for exact Rust Scale::step calibration: raw = -stiffness * qpos / 9.81 - 0.4)
    ET.SubElement(
        pan,
        "joint",
        name="ranger_cell",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="-0.008 0.002",
        stiffness="20000",
        damping="300",
        armature="0.001",
        solreflimit="0.005 1",
    )
    _box_col(pan, "ranger_pan_contact", (0.0, 0.0, -0.0045), (0.150, 0.1125, 0.0045), COL_ARTIC_RGBA)
    ET.SubElement(
        pan,
        "site",
        name="ranger_load_surface_site",
        type="box",
        pos="0 0 0",
        size="0.140 0.102 0.002",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Exclude internal contact between scale body and spring-loaded pan
    contact = add_adjacent_excludes(
        app,
        (("exclude_scale_pan", "ranger_scale", "ranger_weighing_pan"),),
    )

    # Inspection test weights (lab scene only; omitted from standalone model.xml)
    for name, mass, size, pos, color in (
        ("vessel", 0.5, (0.065, 0.05, 0.02), (-0.3, 0.04, 0.021), "0.3 0.6 0.8 1"),
        ("sample", 1.25, (0.04, 0.035, 0.018), (0.3, 0.04, 0.019), "0.85 0.65 0.25 1"),
        ("overload", 5.0, (0.035, 0.03, 0.025), (0.3, 0.2, 0.026), "0.7 0.3 0.3 1"),
    ):
        body = ET.SubElement(world, "body", name=name, pos=numbers(pos))
        ET.SubElement(body, "freejoint", name=name + "_free")
        ET.SubElement(
            body,
            "geom",
            name=name + "_contact",
            type="box",
            size=numbers(size),
            mass=str(mass),
            rgba=color,
            group="2",
            contype="1",
            conaffinity="1",
        )

    write_xml(directory / "appliance.xml", app)
    _write_lab_scene(directory, folder, bench_z=0.0)

    emit_standalone_models(
        directory,
        model_name="ranger_scale",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
    )

    (directory / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(RANGER_NAMES),
                "total_mass_kg": sum(RANGER_MASSES.values()),
                "component_masses_kg": RANGER_MASSES,
                "scope": "MuJoCo 4.0 UV+PBR visuals, full foot/housing/pan colliders, standalone model.xml, and Rust-compatible native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_blender_meshes_and_xml() -> None:
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    export_waring_wsg60()
    export_ohaus_ranger_3000()


def verify_waring_wsg60() -> dict:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    folder = "waring-wsg60"
    directory = ASSETS / folder
    spec = model_spec(directory / "scene.xml", folder)
    _model, rebuilt = kit_export_native_xml(
        directory, folder, mujoco, np, spec=spec, strip_general_input=True
    )
    assert abs(float(rebuilt.opt.timestep) - 0.001) < 1e-9, rebuilt.opt.timestep

    for bname in (*WSG_NAMES, "ingredient_payload"):
        rebuilt.body(bname)
    for jname in ("wsg_unlock", "wsg_cover_lift", "wsg_spin", "vessel_free"):
        rebuilt.joint(jname)
    for aname in ("wsg_drive", "wsg_unlock_fixture", "wsg_cover_fixture"):
        rebuilt.actuator(aname)
    for gname in ("wsg_seat", "wsg_foot", "wsg_floor", "vessel_receiving_bench"):
        rebuilt.geom(gname)
    rebuilt.site("vessel_socket")

    frames_report, motion_report = kit_verify_frames_and_motions(
        directory,
        folder,
        WSG_NAMES,
        WSG_VISUAL_MOTIONS,
        mujoco,
        directory / "active-state-evidence",
        cleanup_inputs=True,
    )

    # Verify bowl seats cleanly, cover unlocks/lifts/closes within Rust interlock, and blade spins
    data = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, data)
    unlock_act = rebuilt.actuator("wsg_unlock_fixture").id
    lift_act = rebuilt.actuator("wsg_cover_fixture").id
    drive_act = rebuilt.actuator("wsg_drive").id

    # Open cover
    data.ctrl[unlock_act] = 0.32
    data.ctrl[lift_act] = 0.16
    for _ in range(1000):
        mujoco.mj_step(rebuilt, data)
    cover_open_m = float(data.joint("wsg_cover_lift").qpos[0])
    assert cover_open_m >= 0.145, cover_open_m

    # Close cover and spin blade
    data.ctrl[unlock_act] = 0.0
    data.ctrl[lift_act] = 0.0
    data.ctrl[drive_act] = 400.0
    for _ in range(1500):
        mujoco.mj_step(rebuilt, data)
    cover_closed_m = float(data.joint("wsg_cover_lift").qpos[0])
    unlock_closed_deg = math.degrees(abs(float(data.joint("wsg_unlock").qpos[0])))
    blade_vel = float(data.joint("wsg_spin").qvel[0])
    bowl_pos = data.body("wsg_bowl").xpos
    socket_pos = data.site("vessel_socket").xpos
    seat_err_m = float(np.linalg.norm(bowl_pos - socket_pos))
    assert cover_closed_m <= 0.0025, cover_closed_m
    assert unlock_closed_deg <= 1.5, unlock_closed_deg
    assert blade_vel > 100.0, blade_vel
    assert seat_err_m <= 0.003, seat_err_m
    assert np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))

    return {
        "appliance": folder,
        "status": "passed",
        "timestep": float(rebuilt.opt.timestep),
        "native_nq": int(rebuilt.nq),
        "native_nv": int(rebuilt.nv),
        "frames_passed": frames_report["passed"],
        "motion_passed": motion_report["passed"],
        "cover_open_m": round(cover_open_m, 4),
        "cover_closed_m": round(cover_closed_m, 5),
        "unlock_closed_deg": round(unlock_closed_deg, 3),
        "blade_vel_rad_s": round(blade_vel, 1),
        "bowl_seat_err_mm": round(seat_err_m * 1000.0, 3),
    }


def verify_ohaus_ranger_3000() -> dict:
    import mujoco
    import numpy as np
    from live_panels import model_spec

    folder = "ohaus-ranger-3000"
    directory = ASSETS / folder
    spec = model_spec(directory / "scene.xml", folder)
    _model, rebuilt = kit_export_native_xml(
        directory, folder, mujoco, np, spec=spec, strip_general_input=True
    )
    assert abs(float(rebuilt.opt.timestep) - 0.001) < 1e-9, rebuilt.opt.timestep

    for bname in (*RANGER_NAMES, "ingredient_payload", "live_weight", "live_zero", "live_unit", "live_stable"):
        rebuilt.body(bname)
    rebuilt.joint("ranger_cell")
    rebuilt.geom("ranger_pan_contact")
    rebuilt.site("ranger_load_surface_site")

    frames_report, motion_report = kit_verify_frames_and_motions(
        directory,
        folder,
        RANGER_NAMES,
        RANGER_VISUAL_MOTIONS,
        mujoco,
        directory / "active-state-evidence",
        glb_name="ohaus-r31pe6.glb",
        cleanup_inputs=True,
    )

    # Verify Rust Scale::step zero reading (~0.0000 kg) and sample load reading (1.25 kg)
    data = mujoco.MjData(rebuilt)
    for _ in range(500):
        mujoco.mj_step(rebuilt, data)
    stiffness = float(rebuilt.jnt_stiffness[rebuilt.joint("ranger_cell").id])
    zero_kg = -stiffness * float(data.joint("ranger_cell").qpos[0]) / 9.81 - 0.4
    assert abs(zero_kg) < 0.001, zero_kg

    # Place 1.25 kg sample block onto the weighing pan center
    sample_qadr = rebuilt.jnt_qposadr[rebuilt.joint("sample_free").id]
    data.qpos[sample_qadr : sample_qadr + 3] = [0.0, 0.038, 0.137]
    data.qpos[sample_qadr + 3 : sample_qadr + 7] = [1.0, 0.0, 0.0, 0.0]
    data.qvel[:] = 0.0
    for _ in range(800):
        mujoco.mj_step(rebuilt, data)
    sample_kg = -stiffness * float(data.joint("ranger_cell").qpos[0]) / 9.81 - 0.4
    assert abs(sample_kg - 1.25) < 0.005, sample_kg
    assert np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))

    return {
        "appliance": folder,
        "status": "passed",
        "timestep": float(rebuilt.opt.timestep),
        "native_nq": int(rebuilt.nq),
        "native_nv": int(rebuilt.nv),
        "frames_passed": frames_report["passed"],
        "motion_passed": motion_report["passed"],
        "zero_reading_kg": round(zero_kg, 5),
        "sample_reading_kg": round(sample_kg, 4),
    }


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
    summary = [verify_waring_wsg60(), verify_ohaus_ranger_3000()]
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
