"""Export and verify MuJoCo 4.0 MJCF + native models for Maruzen MIH-02C and Vollrath 59500P induction hobs."""

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
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
    SITE_SUPPORT_RGBA,
    Y_AXIS_QUAT,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    write_xml,
)

ASSETS = ROOT / "assets/bakery-mujoco"


def _add_geom(
    body: ET.Element,
    name: str,
    gtype: str,
    *,
    pos: tuple[float, float, float] | None = None,
    quat: str | None = None,
    size: str | tuple[float, ...],
    fromto: tuple[float, float, float, float, float, float] | None = None,
    rgba: str = COL_BASE_RGBA,
    friction: str | None = None,
    solref: str | None = None,
    solimp: str | None = None,
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
    if friction is not None:
        attrib["friction"] = friction
    if solref is not None:
        attrib["solref"] = solref
    if solimp is not None:
        attrib["solimp"] = solimp
    return ET.SubElement(body, "geom", **attrib)


def _export_maruzen_mih_02c() -> None:
    directory = ASSETS / "maruzen-mih-02c"
    source = directory / "maruzen-mih-02c.blend"
    prepare_blender_assembly(source, ("mih_hob",), directory, default_roughness=0.30)

    hob = ET.Element("mujoco", model="Maruzen MIH-02C — commercial induction hob")
    ET.SubElement(hob, "compiler", angle="radian")
    ET.SubElement(hob, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(hob, "size", nuserdata="5")

    defaults = add_standard_defaults(
        hob,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(hob, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(hob, "worldbody")
    base = ET.SubElement(world, "body", name="mih_hob", pos="0 0 0", quat="1 0 0 0")
    ET.SubElement(
        base,
        "inertial",
        mass="10.5",
        pos="0 0 0.06",
        diaginertia="0.19 0.09 0.26",
    )
    ET.SubElement(base, "include", file="visual_mih_hob.xml")

    # Four rubber feet touching Z = 0.000 m up to stainless underside at Z = 0.014 m
    for foot_name, fx, fy in (
        ("mih_foot_fl_col", -0.1330, -0.1650),
        ("mih_foot_fr_col", 0.1330, -0.1650),
        ("mih_foot_rl_col", -0.1330, 0.1600),
        ("mih_foot_rr_col", 0.1330, 0.1600),
    ):
        _add_geom(
            base,
            foot_name,
            "cylinder",
            pos=(fx, fy, 0.0070),
            size="0.0120 0.0070",
            friction="0.85 0.015 0.003",
            rgba=COL_BASE_RGBA,
        )

    # Underbody air filter frame (Z = 0.0090 .. 0.0140 m, clear of floor)
    _add_geom(
        base,
        "mih_filter_col",
        "box",
        pos=(0.0, -0.0350, 0.0115),
        size=(0.0950, 0.1075, 0.0025),
        rgba=COL_BASE_RGBA,
    )

    # Stainless steel housing (Z = 0.0140 .. 0.1000 m), rear upstand step (Z = 0.1000 .. 0.1200 m),
    # and Neoceram cooking plate (Z = 0.1000 .. 0.1050 m)
    _add_geom(
        base,
        "ih_housing",
        "box",
        pos=(0.0, 0.0, 0.0570),
        size=(0.1500, 0.2250, 0.0430),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "ih_rear_step",
        "box",
        pos=(0.0, 0.1950, 0.1100),
        size=(0.1500, 0.0300, 0.0100),
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "ih_plate",
        "box",
        pos=(0.0, 0.0, 0.1025),
        size=(0.1375, 0.1500, 0.0025),
        friction="0.50 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        rgba=COL_WALL_RGBA,
    )

    # Front rotary power dial
    _add_geom(
        base,
        "mih_power_knob_col",
        "cylinder",
        pos=(0.0780, -0.2255, 0.0530),
        quat=Y_AXIS_QUAT,
        size="0.0175 0.0090",
        rgba=COL_WALL_RGBA,
    )

    # Rear cable gland, coiled power cord, and molded plug (kept >= 4 mm above floor)
    _add_geom(
        base,
        "mih_cord_gland_col",
        "capsule",
        fromto=(0.0850, 0.1860, 0.0340, 0.0950, 0.2550, 0.0220),
        size="0.0070",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "mih_cord_coil_col",
        "cylinder",
        pos=(0.0920, 0.3460, 0.0125),
        size="0.0880 0.0085",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "mih_plug_col",
        "box",
        pos=(-0.0250, 0.4050, 0.0180),
        size=(0.0240, 0.0140, 0.0140),
        rgba=COL_WALL_RGBA,
    )

    # Cooking zone center site (group 4, visible semi-transparent rgba)
    ET.SubElement(
        base,
        "site",
        name="ih_zone",
        pos="0 0 0.105",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    write_xml(directory / "hob.xml", hob)

    scene = ET.Element("mujoco", model="Maruzen induction physics lab")
    ET.SubElement(scene, "include", file="hob.xml")
    ET.SubElement(scene, "include", file="../induction-pan/pan.xml")
    ET.SubElement(scene, "include", file="../induction-pan/studio.xml")
    write_xml(directory / "scene.xml", scene)

    emit_standalone_models(
        directory,
        model_name="mih_hob",
        defaults=defaults,
        asset=asset,
        root_body=base,
    )

    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "retained_bodies": ["mih_hob"],
        "published_mass_kg": 10.5,
        "envelope_m": [0.300, 0.450, 0.120],
        "cooking_plate_top_z_m": 0.105,
        "scope": "MuJoCo 4.0 visual, contact, and native model in hob.xml, model.xml, scene.xml, and native.xml.",
    }
    (directory / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def _export_vollrath_59500p() -> None:
    directory = ASSETS / "vollrath-59500p"
    source = directory / "vollrath-59500p.blend"
    prepare_blender_assembly(source, ("vp_hob",), directory, default_roughness=0.27)

    hob = ET.Element("mujoco", model="Vollrath Mirage Pro 59500P — commercial induction hob")
    ET.SubElement(hob, "compiler", angle="radian")
    ET.SubElement(hob, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(hob, "size", nuserdata="5")

    defaults = add_standard_defaults(
        hob,
        friction="0.60 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        condim="4",
    )

    asset = ET.SubElement(hob, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(hob, "worldbody")
    base = ET.SubElement(world, "body", name="vp_hob", pos="0 0 0", quat="1 0 0 0")
    ET.SubElement(
        base,
        "inertial",
        mass="5.8",
        pos="0 0 0.04",
        diaginertia="0.075 0.062 0.134",
    )
    ET.SubElement(base, "include", file="visual_vp_hob.xml")

    # Four rubber feet touching Z = 0.000 m up to pressed stainless underside at Z = 0.014 m
    for foot_name, fx, fy in (
        ("vp_foot_fl_col", -0.1390, -0.1470),
        ("vp_foot_fr_col", 0.1390, -0.1470),
        ("vp_foot_rl_col", -0.1390, 0.1470),
        ("vp_foot_rr_col", 0.1390, 0.1470),
    ):
        _add_geom(
            base,
            foot_name,
            "cylinder",
            pos=(fx, fy, 0.0070),
            size="0.0115 0.0070",
            friction="0.85 0.015 0.003",
            rgba=COL_BASE_RGBA,
        )

    # Underside cooling fan shroud and pressed stiffener bar (kept >= 10 mm above floor)
    _add_geom(
        base,
        "vp_cooling_fan_col",
        "cylinder",
        pos=(0.0950, 0.0920, 0.0119),
        size="0.0420 0.0021",
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_stiffener_col",
        "box",
        pos=(0.0, -0.0870, 0.0120),
        size=(0.1260, 0.0085, 0.0020),
        rgba=COL_BASE_RGBA,
    )

    # Tapered rounded-corner stainless housing frustum (Z = 0.014 .. 0.0722 m) + 24.4-deg sloped front control bezel
    _add_geom(
        base,
        "ih_housing",
        "box",
        pos=(0.0, 0.0, 0.0310),
        size=(0.1600, 0.1750, 0.0170),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_waist_lr_col",
        "box",
        pos=(0.0, 0.0, 0.0370),
        size=(0.1778, 0.1560, 0.0110),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_waist_fb_col",
        "box",
        pos=(0.0, 0.0, 0.0370),
        size=(0.1420, 0.1937, 0.0110),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_mid_frustum_col",
        "box",
        pos=(0.0, 0.0120, 0.0540),
        size=(0.1600, 0.1580, 0.0060),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_upper_housing_col",
        "box",
        pos=(0.0, 0.0200, 0.0661),
        size=(0.1470, 0.1410, 0.0061),
        rgba=COL_BASE_RGBA,
    )
    bevel_half_rad = math.radians(24.4) * 0.5
    bevel_quat = numbers((math.cos(bevel_half_rad), math.sin(bevel_half_rad), 0.0, 0.0))
    _add_geom(
        base,
        "vp_front_bevel_col",
        "box",
        pos=(0.0, -0.1570, 0.0560),
        quat=bevel_quat,
        size=(0.1480, 0.0280, 0.0075),
        rgba=COL_BASE_RGBA,
    )
    _add_geom(
        base,
        "vp_encoder_knob_col",
        "cylinder",
        pos=(0.1090, -0.1618, 0.0665),
        quat=bevel_quat,
        size="0.0160 0.0085",
        rgba=COL_WALL_RGBA,
    )

    # Ceramic glass cooking plate (top at Z = 0.0762 m)
    _add_geom(
        base,
        "ih_plate",
        "box",
        pos=(0.0, 0.0200, 0.0742),
        size=(0.1460, 0.1400, 0.0020),
        friction="0.50 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        rgba=COL_WALL_RGBA,
    )

    # Stowed rear power cord capsules (kept >= 1 mm above floor, no hollow-loop bridging) and NEMA 5-15P plug
    _add_geom(
        base,
        "vp_cord_lead_col",
        "capsule",
        fromto=(-0.1100, 0.1880, 0.0280, -0.1060, 0.2480, 0.0095),
        size="0.0070",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_cord_front_col",
        "capsule",
        fromto=(-0.1000, 0.2480, 0.0095, 0.1000, 0.2480, 0.0095),
        size="0.0085",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_cord_mid_col",
        "capsule",
        fromto=(-0.0900, 0.2760, 0.0100, 0.0900, 0.2760, 0.0100),
        size="0.0085",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_cord_rear_col",
        "capsule",
        fromto=(-0.0900, 0.3050, 0.0110, 0.0900, 0.3050, 0.0110),
        size="0.0075",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_cord_left_col",
        "capsule",
        fromto=(-0.1000, 0.2500, 0.0100, -0.0900, 0.3020, 0.0110),
        size="0.0085",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_cord_right_col",
        "capsule",
        fromto=(0.1000, 0.2500, 0.0100, 0.0900, 0.3020, 0.0110),
        size="0.0085",
        rgba=COL_WALL_RGBA,
    )
    _add_geom(
        base,
        "vp_plug_col",
        "box",
        pos=(0.1345, 0.2510, 0.0140),
        size=(0.0295, 0.0130, 0.0110),
        rgba=COL_WALL_RGBA,
    )

    # Cooking zone center site (group 4, visible semi-transparent rgba)
    ET.SubElement(
        base,
        "site",
        name="ih_zone",
        pos="0 0.020 0.0762",
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    write_xml(directory / "hob.xml", hob)

    scene = ET.Element("mujoco", model="Vollrath induction physics lab")
    ET.SubElement(scene, "include", file="hob.xml")
    ET.SubElement(scene, "include", file="../induction-pan/pan.xml")
    ET.SubElement(scene, "include", file="../induction-pan/studio.xml")
    write_xml(directory / "scene.xml", scene)

    emit_standalone_models(
        directory,
        model_name="vp_hob",
        defaults=defaults,
        asset=asset,
        root_body=base,
    )

    report = {
        "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "retained_bodies": ["vp_hob"],
        "published_mass_kg": 5.8,
        "envelope_m": [0.3556, 0.38735, 0.07641],
        "cooking_plate_top_z_m": 0.0762,
        "scope": "MuJoCo 4.0 visual, contact, and native model in hob.xml, model.xml, scene.xml, and native.xml.",
    }
    (directory / "physics-export.json").write_text(json.dumps(report, indent=2) + "\n")


def export_pan() -> None:
    """Optional helper to rebuild assets/bakery-mujoco/induction-pan when --export-pan is passed."""
    import bpy

    from build_mixer_visuals import lathe
    from build_oven_visuals import (
        convert_curves,
        empty,
        export_visual_meshes,
        material,
        tube,
    )

    bpy.ops.wm.read_factory_settings(use_empty=True)
    root = empty("ih_pan", (0, 0, 0))
    steel = material("ih_pan_steel", (0.55, 0.59, 0.61, 1), 0.8, 0.27)
    black = material("ih_pan_grip", (0.028, 0.030, 0.035, 1), 0, 0.6)
    lathe(
        "Standard pan vessel",
        [
            (0, 0),
            (0.100, 0),
            (0.100, 0.006),
            (0.106, 0.078),
            (0.105, 0.082),
            (0.103, 0.082),
            (0.103, 0.078),
            (0.097, 0.006),
            (0, 0.006),
            (0, 0),
        ],
        (0, 0, 0),
        steel,
        root,
        128,
    )
    tube(
        "Pan handle bracket",
        [(0.104, 0, 0.055), (0.135, 0, 0.065), (0.155, 0, 0.068)],
        0.006,
        steel,
        root,
    )
    tube(
        "Pan insulated handle",
        [(0.148, 0, 0.068), (0.265, 0, 0.085)],
        0.012,
        black,
        root,
    )
    convert_curves((root,))
    directory = ASSETS / "induction-pan"
    directory.mkdir(exist_ok=True)
    export_visual_meshes((root,), directory)
    (directory / "visual_assets.xml").replace(directory / "pan_assets.xml")


def export_blender_meshes_and_xml() -> None:
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")
    _export_maruzen_mih_02c()
    _export_vollrath_59500p()
    if "--export-pan" in sys.argv:
        export_pan()


def _verify_hob(
    folder_name: str,
    root_body_name: str,
    required_geoms: tuple[str, ...],
    mujoco,
    np,
) -> dict:
    from live_panels import model_spec

    directory = ASSETS / folder_name
    spec = model_spec(directory / "scene.xml", folder_name)
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    spec.body("ih_pan").pos = data.site("ih_zone").xpos + (0, 0, 0.004)
    _model, rebuilt = kit_export_native_xml(
        directory, folder_name, mujoco, np, spec=spec, strip_general_input=False
    )

    rebuilt.body(root_body_name)
    rebuilt.body("ih_pan")
    rebuilt.body("ingredient_payload")
    rebuilt.site("ih_zone")
    for gname in required_geoms:
        rebuilt.geom(gname)

    # Verify GLB rest frame alignment against native.xml
    native_path = directory / "native.xml"
    glb_path = directory / f"{folder_name}.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()
    rdata = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, rdata)
    bid = rebuilt.body(root_body_name).id
    evidence_dir = directory / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                folder_name: {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "bodies": {
                        root_body_name: [
                            *rdata.xpos[bid].tolist(),
                            *rdata.xquat[bid].tolist(),
                        ]
                    },
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
    frames_in.unlink(missing_ok=True)
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"] is True, frames_report

    # Verify pan seating and stable ih_plate <-> ih_pan_base contact force
    plate_gid = rebuilt.geom("ih_plate").id
    pan_gid = rebuilt.geom("ih_pan_base").id
    for _ in range(int(round(0.6 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, rdata)

    normal_force = 0.0
    force_buf = np.zeros(6)
    for ci in range(rdata.ncon):
        con = rdata.contact[ci]
        if {con.geom1, con.geom2} == {plate_gid, pan_gid}:
            mujoco.mj_contactForce(rebuilt, rdata, ci, force_buf)
            normal_force += float(abs(force_buf[0]))
    assert normal_force > 9.0, (folder_name, normal_force)
    assert np.all(np.isfinite(rdata.qpos)) and np.all(np.isfinite(rdata.qvel))

    return {
        "appliance": folder_name,
        "status": "passed",
        "native_nq": int(rebuilt.nq),
        "native_nv": int(rebuilt.nv),
        "frames_passed": frames_report["passed"],
        "pan_plate_contact_force_n": round(normal_force, 3),
    }


def export_and_verify_native_and_physics() -> None:
    import mujoco
    import numpy as np

    results = [
        _verify_hob(
            "maruzen-mih-02c",
            "mih_hob",
            ("ih_housing", "ih_rear_step", "ih_plate", "live_power_lamp", "live_hold_lamp", "ingredient_surface"),
            mujoco,
            np,
        ),
        _verify_hob(
            "vollrath-59500p",
            "vp_hob",
            ("ih_housing", "ih_plate", "live_setting_back", "live_temperature_mode", "ingredient_surface"),
            mujoco,
            np,
        ),
    ]
    print(json.dumps(results, indent=2))


def main() -> None:
    if "--blender-export" in sys.argv or "bpy" in sys.modules:
        export_blender_meshes_and_xml()
        return

    extra = ["--export-pan"] if "--export-pan" in sys.argv else []
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
            *extra,
        ],
        check=True,
    )
    export_and_verify_native_and_physics()


if __name__ == "__main__":
    main()
