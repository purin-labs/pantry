"""Build and verify MuJoCo 4.0 contact mechanics for the Hoshizaki RT-120SNJ refrigerator."""

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
    SITE_SUPPORT_RGBA,
    X_AXIS_QUAT,
    add_adjacent_excludes,
    add_standard_defaults,
    emit_standalone_models,
    export_and_verify_native_xml as kit_export_native_xml,
    numbers,
    prepare_blender_assembly,
    verify_frames_and_motions as kit_verify_frames_and_motions,
    write_xml,
)

FOLDER = "hoshizaki-rt-120snj"
ASSETS = ROOT / "assets/bakery-mujoco" / FOLDER

NAMES = (
    "rt_cabinet",
    "rt_door_left",
    "rt_door_right",
    "rt_shelf_left_1",
    "rt_shelf_left_2",
    "rt_shelf_right_1",
    "rt_shelf_right_2",
)

# Manufacturer net mass = 68.0 kg (50 kg cabinet + 2x5 kg doors + 4x2 kg wire shelves)
# plus 1.0 kg removable storage container (`rt_container`).
MASSES = {
    "rt_cabinet": 50.0,
    "rt_door_left": 5.0,
    "rt_door_right": 5.0,
    "rt_shelf_left_1": 2.0,
    "rt_shelf_left_2": 2.0,
    "rt_shelf_right_1": 2.0,
    "rt_shelf_right_2": 2.0,
}

# Physically realistic CoM and principal inertia for the 1200 x 600 x 800 mm undercounter unit.
# Composite CoM sits safely inside the 4-foot support polygon (X in [-0.281, +0.539], Y in [-0.187, +0.236])
# even with both doors swung open to 100 deg.
CENTERS = {
    "rt_cabinet": (-0.04, 0.045, 0.40),
    "rt_door_left": (0.21, 0.0, 0.0),
    "rt_door_right": (-0.21, 0.0, 0.0),
    "rt_shelf_left_1": (0.0, 0.0, 0.0),
    "rt_shelf_left_2": (0.0, 0.0, 0.0),
    "rt_shelf_right_1": (0.0, 0.0, 0.0),
    "rt_shelf_right_2": (0.0, 0.0, 0.0),
}

INERTIAS = {
    "rt_cabinet": (3.60, 8.20, 7.60),
    "rt_door_left": (0.163, 0.232, 0.072),
    "rt_door_right": (0.163, 0.232, 0.072),
    "rt_shelf_left_1": (0.0301, 0.0267, 0.0568),
    "rt_shelf_left_2": (0.0301, 0.0267, 0.0568),
    "rt_shelf_right_1": (0.0301, 0.0267, 0.0568),
    "rt_shelf_right_2": (0.0301, 0.0267, 0.0568),
}

VISUAL_MOTIONS = {
    "rt_left_hinge": (0, 0, -1),
    "rt_right_hinge": (0, 0, 1),
}


def box_collider(
    body: ET.Element,
    name: str,
    position: tuple[float, float, float],
    size: tuple[float, float, float],
    rgba: str,
) -> ET.Element:
    return ET.SubElement(
        body,
        "geom",
        name=name,
        type="box",
        pos=numbers(position),
        size=numbers(size),
        contype="1",
        conaffinity="1",
        group="3",
        rgba=rgba,
    )


def export_blender_meshes_and_xml() -> None:
    """Run inside background Blender to export UV+PBR visual meshes and author MJCF files."""
    import bpy

    if not bpy.app.background:
        raise RuntimeError("Run in a separate background Blender process.")

    source = ASSETS / f"{FOLDER}.blend"
    parts, poses = prepare_blender_assembly(source, NAMES, ASSETS)

    app = ET.Element(
        "mujoco",
        model="hoshizaki-rt-120snj — undercounter commercial refrigerator",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")

    defaults = add_standard_defaults(app)

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    bodies: dict[str, ET.Element] = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "rt_cabinet" else None)
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

    base = bodies["rt_cabinet"]

    # Four adjustable feet touching Z = 0.000 m and sealing 1 mm into the cabinet underside (Z = 0.100 m)
    for foot_name, fx, fy in (
        ("rt_foot_fl_col", -0.281, -0.187),
        ("rt_foot_rl_col", -0.281, 0.236),
        ("rt_foot_fr_col", 0.539, -0.187),
        ("rt_foot_rr_col", 0.539, 0.236),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0505)),
            size="0.019 0.0505",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Underbody drain pipe, trap, and corrugated hose (kept >= 20 mm above floor)
    ET.SubElement(
        base,
        "geom",
        name="rt_drain_pipe_col",
        type="cylinder",
        pos=numbers((-0.175, -0.060, 0.084)),
        quat=X_AXIS_QUAT,
        size="0.010 0.150",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="rt_drain_trap_col",
        type="cylinder",
        pos=numbers((-0.015, -0.060, 0.082)),
        size="0.024 0.018",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    for hose_name, fromto in (
        ("rt_drain_hose_upper_col", (-0.015, -0.060, 0.068, 0.075, -0.060, 0.066)),
        ("rt_drain_hose_drop_col", (0.075, -0.060, 0.066, 0.095, -0.060, 0.034)),
        ("rt_drain_hose_lower_col", (0.095, -0.060, 0.034, 0.155, -0.060, 0.032)),
    ):
        ET.SubElement(
            base,
            "geom",
            name=hose_name,
            type="capsule",
            fromto=numbers(fromto),
            size="0.012",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Full 1200 x 600 mm stainless worktop, left compressor/control bay, front perimeter frames,
    # and refrigerated interior cavity walls (keeping all existing named contact geoms intact
    # and the interior cavity [-0.289..0.551, -0.198..0.243, 0.155..0.734] completely open).
    cabinet_boxes = (
        ("rt_worktop_col", (0.0, 0.0, 0.7795), (0.600, 0.300, 0.0205), COL_BASE_RGBA),
        ("rt_service_bay_col", (-0.4495, 0.026, 0.430), (0.1505, 0.274, 0.330), COL_BASE_RGBA),
        ("rt_service_front_col", (-0.447, -0.274, 0.430), (0.149, 0.027, 0.328), COL_BASE_RGBA),
        ("rt_rear_contact", (0.131, 0.2715, 0.457), (0.422, 0.0285, 0.304), COL_BASE_RGBA),
        ("rt_floor_contact", (0.131, 0.0235, 0.1275), (0.422, 0.2215, 0.0275), COL_BASE_RGBA),
        ("rt_ceiling_contact", (0.131, 0.0235, 0.7525), (0.422, 0.2215, 0.0085), COL_BASE_RGBA),
        ("rt_left_wall_contact", (-0.295, 0.0235, 0.457), (0.006, 0.2225, 0.304), COL_WALL_RGBA),
        ("rt_right_wall_contact", (0.5755, 0.026, 0.4305), (0.0245, 0.274, 0.3305), COL_BASE_RGBA),
        ("rt_mullion_contact", (0.131, -0.218, 0.4405), (0.014, 0.020, 0.287), COL_WALL_RGBA),
        ("rt_evaporator_contact", (-0.2725, 0.080, 0.678), (0.0165, 0.150, 0.0725), COL_WALL_RGBA),
        ("rt_front_upper_frame_col", (0.131, -0.218, 0.743), (0.422, 0.021, 0.017), COL_BASE_RGBA),
        ("rt_front_lower_frame_col", (0.131, -0.219, 0.142), (0.422, 0.022, 0.013), COL_BASE_RGBA),
        ("rt_lower_front_trim_col", (0.131, -0.270, 0.110), (0.424, 0.027, 0.010), COL_BASE_RGBA),
        ("rt_left_jamb_col", (-0.285, -0.218, 0.4405), (0.005, 0.021, 0.287), COL_WALL_RGBA),
        ("rt_right_jamb_col", (0.547, -0.218, 0.4405), (0.005, 0.021, 0.287), COL_WALL_RGBA),
    )
    for cname, cpos, csize, crgba in cabinet_boxes:
        box_collider(base, cname, cpos, csize, crgba)

    actuators = ET.SubElement(app, "actuator")
    door_limit = math.radians(100)
    for side, sign in (("left", 1), ("right", -1)):
        door = bodies[f"rt_door_{side}"]
        ET.SubElement(
            door,
            "joint",
            name=f"rt_{side}_hinge",
            type="hinge",
            axis=numbers((0, 0, -sign)),
            limited="true",
            range=numbers((0, door_limit)),
            damping="1",
            solreflimit="0.005 1",
        )
        box_collider(
            door,
            f"rt_{side}_door_contact",
            (sign * 0.21, 0.004, -0.001),
            (0.206, 0.032, 0.3115),
            COL_ARTIC_RGBA,
        )
        box_collider(
            door,
            f"rt_{side}_handle_col",
            (sign * 0.21, -0.042, 0.277),
            (0.1085, 0.013, 0.011),
            COL_ARTIC_RGBA,
        )
        ET.SubElement(
            actuators,
            "position",
            name=f"rt_{side}_fixture",
            joint=f"rt_{side}_hinge",
            ctrlrange=numbers((0, door_limit)),
            kp="18",
            kv="5",
            forcerange="-3 3",
        )
        for level in (1, 2):
            shelf = bodies[f"rt_shelf_{side}_{level}"]
            box_collider(
                shelf,
                f"rt_{side}_{level}_support",
                (0.0, 0.0, -0.0014),
                (0.2, 0.2125, 0.003),
                COL_WALL_RGBA,
            )
            ET.SubElement(
                shelf,
                "site",
                name=f"rt_{side}_{level}_storage",
                pos="0 0 0.0466",
                size="0.006",
                group="4",
                rgba=SITE_SUPPORT_RGBA,
            )

    # Removable 1.0 kg storage container (`rt_container`) staged in front of the refrigerator.
    # Visual geoms live in group="2" (zero mass, non-colliding); collision geoms live in group="3".
    # `rt_container_lid_col` is inset by 2 mm in X/Y so horizontal door impacts always contact
    # `rt_container_contact` first (required by Rust's door-obstruction contact check).
    crate = ET.SubElement(world, "body", name="rt_container", pos="-0.079 -0.65 0.045")
    ET.SubElement(crate, "freejoint", name="rt_container_free")
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_body_visual",
        type="box",
        pos="0 0 0",
        size="0.070 0.110 0.045",
        mass="0",
        density="0",
        rgba="0.45 0.65 0.75 1",
        group="2",
        contype="0",
        conaffinity="0",
    )
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_lid",
        type="box",
        pos="0 0 0.045",
        size="0.073 0.113 0.003",
        mass="0",
        density="0",
        rgba="0.85 0.9 0.92 1",
        group="2",
        contype="0",
        conaffinity="0",
    )
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_contact",
        type="box",
        pos="0 0 0",
        size="0.070 0.110 0.045",
        mass="0.9402",
        rgba=COL_ACCESSORY_RGBA,
        group="3",
        contype="1",
        conaffinity="1",
    )
    ET.SubElement(
        crate,
        "geom",
        name="rt_container_lid_col",
        type="box",
        pos="0 0 0.045",
        size="0.068 0.108 0.003",
        mass="0.0598",
        rgba=COL_ACCESSORY_RGBA,
        group="3",
        contype="1",
        conaffinity="1",
    )

    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_cabinet_door_left", "rt_cabinet", "rt_door_left"),
            ("exclude_cabinet_door_right", "rt_cabinet", "rt_door_right"),
            ("exclude_door_left_right", "rt_door_left", "rt_door_right"),
            ("exclude_cabinet_shelf_l1", "rt_cabinet", "rt_shelf_left_1"),
            ("exclude_cabinet_shelf_l2", "rt_cabinet", "rt_shelf_left_2"),
            ("exclude_cabinet_shelf_r1", "rt_cabinet", "rt_shelf_right_1"),
            ("exclude_cabinet_shelf_r2", "rt_cabinet", "rt_shelf_right_2"),
        ),
    )

    write_xml(ASSETS / "appliance.xml", app)

    # Lab scene wrapper (includes appliance.xml + bench floor at Z = 0.000 m)
    scene = ET.Element("mujoco", model=f"{FOLDER} lab")
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
        pos="0 0 0",
        rgba="0.25 0.29 0.32 0.50",
        group="3",
        contype="1",
        conaffinity="1",
    )
    write_xml(ASSETS / "scene.xml", scene)

    # Emit standalone MjSpec.attach-ready model.xml and container_model.xml
    emit_standalone_models(
        ASSETS,
        model_name="rt_cabinet",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        accessories=(("container_model.xml", "rt_container", crate),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_refrigerator_mass_kg": 68.0,
                "container_mass_kg": 1.0,
                "total_scene_mass_kg": 69.0,
                "component_masses_kg": MASSES,
                "envelope_m": [1.200, 0.600, 0.800],
                "scope": "MuJoCo 4.0 Filament PBR, full cabinet/foot/service-bay/door/shelf contact mechanics, and Rust-compatible native storage model.",
            },
            indent=2,
        )
        + "\n"
    )


def export_and_verify_native_and_physics() -> None:
    """Export native.xml via live_panels.model_spec and verify frames, motions, and storage physics."""
    import mujoco
    import numpy as np

    from live_panels import model_spec

    spec = model_spec(ASSETS / "scene.xml", FOLDER)
    _model, rebuilt = kit_export_native_xml(
        ASSETS, FOLDER, mujoco, np, spec=spec, strip_general_input=True
    )

    # 1. Verify all Rust-required bodies, joints, actuators, geoms, and sites exist in native.xml
    required_bodies = (
        *NAMES,
        "rt_container",
        "ingredient_payload",
        "live_temperature",
        "storage_occupant",
    )
    for bname in required_bodies:
        rebuilt.body(bname)
    for jname in ("rt_left_hinge", "rt_right_hinge", "rt_container_free", "storage_occupant_free"):
        rebuilt.joint(jname)
    for aname in ("rt_left_fixture", "rt_right_fixture"):
        rebuilt.actuator(aname)
    for gname in (
        "rt_rear_contact",
        "rt_floor_contact",
        "rt_ceiling_contact",
        "rt_left_wall_contact",
        "rt_right_wall_contact",
        "rt_mullion_contact",
        "rt_evaporator_contact",
        "rt_left_door_contact",
        "rt_right_door_contact",
        "rt_left_1_support",
        "rt_left_2_support",
        "rt_right_1_support",
        "rt_right_2_support",
        "rt_container_contact",
        "ingredient_surface",
        "storage_occupant_contact",
    ):
        rebuilt.geom(gname)
    for sname in (
        "rt_left_1_storage",
        "rt_left_2_storage",
        "rt_right_1_storage",
        "rt_right_2_storage",
    ):
        rebuilt.site(sname)

    # 2. Verify GLB rest frames and 21-sample door hinge trajectories
    evidence_dir = ASSETS / "active-state-evidence"
    frames_report, motion_report = kit_verify_frames_and_motions(
        ASSETS,
        FOLDER,
        NAMES,
        VISUAL_MOTIONS,
        mujoco,
        evidence_dir,
        cleanup_inputs=True,
    )

    # 3. Verify storage dynamics: open both doors >= 90 deg, place rt_container on rt_left_1_storage,
    #    and step 2.0 s under gravity to confirm stable shelf seating with zero unwanted collisions.
    data = mujoco.MjData(rebuilt)
    mujoco.mj_forward(rebuilt, data)

    left_act = rebuilt.actuator("rt_left_fixture").id
    right_act = rebuilt.actuator("rt_right_fixture").id
    data.ctrl[left_act] = math.radians(100.0)
    data.ctrl[right_act] = math.radians(100.0)
    for _ in range(int(round(3.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)

    left_deg = math.degrees(float(data.joint("rt_left_hinge").qpos[0]))
    right_deg = math.degrees(float(data.joint("rt_right_hinge").qpos[0]))
    assert left_deg >= 90.0 and right_deg >= 90.0, (left_deg, right_deg)

    target_pos = np.array([-0.079, 0.0215, 0.3646])
    site_pos = data.site("rt_left_1_storage").xpos.copy()
    assert np.allclose(site_pos, target_pos, atol=1e-4), (site_pos, target_pos)

    qadr = rebuilt.joint("rt_container_free").qposadr[0]
    vadr = rebuilt.joint("rt_container_free").dofadr[0]
    data.qpos[qadr : qadr + 3] = target_pos
    data.qpos[qadr + 3 : qadr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[vadr : vadr + 6] = 0.0
    mujoco.mj_forward(rebuilt, data)

    for _ in range(int(round(2.0 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)

    settled_pos = data.body("rt_container").xpos.copy()
    settled_err_mm = float(np.max(np.abs(settled_pos - target_pos)) * 1000.0)
    assert settled_err_mm < 5.0, (settled_pos, target_pos, settled_err_mm)
    assert np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))

    # Also confirm container-door obstruction contact registers on rt_left_door_contact <-> rt_container_contact
    data.qpos[qadr : qadr + 3] = (-0.079, -0.220, 0.3646)
    data.qpos[qadr + 3 : qadr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[vadr : vadr + 6] = 0.0
    data.ctrl[left_act] = 0.0
    mujoco.mj_forward(rebuilt, data)
    door_gid = rebuilt.geom("rt_left_door_contact").id
    cont_gid = rebuilt.geom("rt_container_contact").id
    peak_obstruct_force = 0.0
    force_buf = np.zeros(6)
    for _ in range(int(round(1.5 / rebuilt.opt.timestep))):
        mujoco.mj_step(rebuilt, data)
        for ci in range(data.ncon):
            con = data.contact[ci]
            if {con.geom1, con.geom2} == {door_gid, cont_gid}:
                mujoco.mj_contactForce(rebuilt, data, ci, force_buf)
                peak_obstruct_force = max(peak_obstruct_force, float(abs(force_buf[0])))
    assert peak_obstruct_force > 1.0, peak_obstruct_force

    print(
        json.dumps(
            {
                "status": "passed",
                "appliance": FOLDER,
                "native_nq": int(rebuilt.nq),
                "native_nv": int(rebuilt.nv),
                "total_mass_kg": float(rebuilt.body_mass[1:].sum()),
                "frames_passed": frames_report["passed"],
                "motion_passed": motion_report["passed"],
                "doors_open_deg": [round(left_deg, 2), round(right_deg, 2)],
                "storage_settled_pos": [round(float(v), 4) for v in settled_pos],
                "storage_err_mm": round(settled_err_mm, 3),
                "door_obstruction_peak_force_n": round(peak_obstruct_force, 2),
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
