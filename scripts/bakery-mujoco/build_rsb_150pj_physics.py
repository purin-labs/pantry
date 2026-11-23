"""Build and verify the MuJoCo mechanical, combustion, and thermocouple safety model for the Rinnai RSB-150PJ."""

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
    COL_ARTIC_RGBA,
    COL_BASE_RGBA,
    COL_WALL_RGBA,
    ROOT,
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

ASSETS = ROOT / "assets/bakery-mujoco/rinnai-rsb-150pj"

NAMES = (
    "rsb_stove",
    "rsb_trivet",
    "rsb_burner_cap",
    "rsb_control_knob",
    "rsb_hose_end",
    "rsb_flame_crown",
)

# Published unit mass = 2.100 kg (2.1 kg)
MASSES = {
    "rsb_stove": 1.310,
    "rsb_trivet": 0.420,
    "rsb_burner_cap": 0.280,
    "rsb_control_knob": 0.032,
    "rsb_hose_end": 0.056,
    "rsb_flame_crown": 0.002,
}

CENTERS = {
    "rsb_stove": (0.0, 0.0, 0.038),
    "rsb_trivet": (-0.010, 0.0, 0.092),
    "rsb_burner_cap": (-0.010, 0.0, 0.070),
    "rsb_control_knob": (0.0, -0.014, 0.0),
    "rsb_hose_end": (0.0, 0.018, 0.0),
    "rsb_flame_crown": (0.0, 0.0, 0.006),
}

INERTIAS = {
    "rsb_stove": (0.0115, 0.0132, 0.0225),
    "rsb_trivet": (0.0038, 0.0038, 0.0072),
    "rsb_burner_cap": (0.00022, 0.00022, 0.00042),
    "rsb_control_knob": (8.0e-6, 8.0e-6, 8.0e-6),
    "rsb_hose_end": (1.8e-5, 1.2e-5, 1.8e-5),
    "rsb_flame_crown": (2.0e-6, 2.0e-6, 3.5e-6),
}

BURNER_X = -0.0100
BURNER_Y = 0.0000
PAN_REST_Z = 0.1060
PRONG_ANGLES_DEG = (30.0, 90.0, 150.0, 210.0, 270.0, 330.0)

# Official Rinnai RSB-150PJ gas ratings (kW)
GAS_RATINGS_KW = {
    "13A": 5.23,  # 4,500 kcal/h
    "12A": 4.87,  # 4,190 kcal/h
    "LPG": 4.07,  # 0.291 kg/h
}


def euler_z_to_quat(deg: float) -> tuple[float, float, float, float]:
    half = math.radians(deg) * 0.5
    return (math.cos(half), 0.0, 0.0, math.sin(half))


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct hob.xml, appliance.xml, model.xml, and scene.xml."""
    import bpy

    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "rinnai-rsb-150pj.blend"
    parts, poses = prepare_blender_assembly(
        source,
        NAMES,
        ASSETS,
        default_roughness=0.32,
    )

    # Sync Blender diffuse_color from Principled BSDF Base Color so MuJoCo visual materials match authored PBR colors.
    for mat in bpy.data.materials:
        bsdf = (
            mat.node_tree.nodes.get("Principled BSDF")
            if (mat.use_nodes and mat.node_tree)
            else None
        )
        if bsdf and "Base Color" in bsdf.inputs and not bsdf.inputs["Base Color"].is_linked:
            bc = bsdf.inputs["Base Color"].default_value
            mat.diffuse_color = (float(bc[0]), float(bc[1]), float(bc[2]), float(bc[3]))
    export_visual_meshes(parts, ASSETS)

    hob = ET.Element("mujoco", model="rinnai-rsb-150pj — commercial 1-burner gas stove")
    ET.SubElement(hob, "compiler", angle="radian")
    ET.SubElement(hob, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(hob, "size", nuserdata="6")

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
    bodies = {}
    for obj in parts:
        name = obj.name
        parent_obj = (
            obj.parent
            if (obj.parent and obj.parent.name in poses)
            else (parts[0] if name != "rsb_stove" else None)
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

    base = bodies["rsb_stove"]
    trivet = bodies["rsb_trivet"]
    burner_cap = bodies["rsb_burner_cap"]
    knob = bodies["rsb_control_knob"]
    hose = bodies["rsb_hose_end"]
    flame = bodies["rsb_flame_crown"]

    # Four rubber feet collision cylinders touching Z = 0.000 m (241 mm x 221 mm span)
    for foot_name, fx, fy in (
        ("rsb_foot_fl_col", -0.1205, -0.1130),
        ("rsb_foot_fr_col", 0.1205, -0.1130),
        ("rsb_foot_rl_col", -0.1205, 0.1080),
        ("rsb_foot_rr_col", 0.1205, 0.1080),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0090)),
            size="0.0145 0.0090",
            friction="0.85 0.015 0.003",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # Lower painted steel chassis (covering front silkscreen panel at Y = -0.1381 m) and stamped SUS430 top deck
    ET.SubElement(
        base,
        "geom",
        name="ih_housing",
        type="box",
        pos="0 0 0.0350",
        size="0.1470 0.1385 0.0170",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )
    ET.SubElement(
        base,
        "geom",
        name="rsb_top_deck_col",
        type="box",
        pos="0 0 0.0605",
        size="0.1495 0.1395 0.0085",
        friction="0.45 0.015 0.003",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_BASE_RGBA,
    )

    # 6-prong trivet horizontal cookware support disc at Z = 0.1060 m (named ih_plate for crates/bakery-native Hob controller)
    ET.SubElement(
        base,
        "geom",
        name="ih_plate",
        type="cylinder",
        pos=numbers((BURNER_X, BURNER_Y, PAN_REST_Z - 0.0015)),
        size="0.0950 0.0015",
        friction="0.50 0.015 0.003",
        solref="0.004 1",
        solimp="0.95 0.99 0.001",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_WALL_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="ih_zone",
        pos=numbers((BURNER_X, BURNER_Y, PAN_REST_Z)),
        size="0.004",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )
    ET.SubElement(
        base,
        "site",
        name="rsb_pan_touch_site",
        type="cylinder",
        pos=numbers((BURNER_X, BURNER_Y, PAN_REST_Z)),
        size="0.1350 0.0025",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # Removable Ø75 mm forged brass burner cap collision cylinder & vertical lift joint
    ET.SubElement(
        burner_cap,
        "joint",
        name="rsb_burner_cap_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.040",
        damping="4.0",
        armature="0.02",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        burner_cap,
        "geom",
        name="rsb_burner_cap_col",
        type="cylinder",
        pos=numbers((BURNER_X, BURNER_Y, 0.0700)),
        size="0.0372 0.0055",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Removable 6-prong porcelain-enameled trivet lift joint + enabled radial prong, lip, and base-ring colliders
    ET.SubElement(
        trivet,
        "joint",
        name="rsb_trivet_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="0 0.060",
        damping="6.0",
        armature="0.02",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    for idx, deg in enumerate(PRONG_ANGLES_DEG):
        ang = math.radians(deg)
        # Upper horizontal prong blade spanning r = 0.044 .. 0.165 m, Z = 0.0955 .. 0.1055 m
        r_mid = 0.1045
        cx = BURNER_X + r_mid * math.cos(ang)
        cy = BURNER_Y + r_mid * math.sin(ang)
        ET.SubElement(
            trivet,
            "geom",
            name=f"rsb_trivet_fin_{idx}",
            type="box",
            pos=numbers((cx, cy, 0.1005)),
            quat=numbers(euler_z_to_quat(deg)),
            size="0.0605 0.0036 0.0050",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        # Vertical riser leg connecting base ring to prong blade (r = 0.080 .. 0.114 m, Z = 0.0735 .. 0.0985 m)
        leg_x = BURNER_X + 0.0970 * math.cos(ang)
        leg_y = BURNER_Y + 0.0970 * math.sin(ang)
        ET.SubElement(
            trivet,
            "geom",
            name=f"rsb_trivet_leg_{idx}",
            type="box",
            pos=numbers((leg_x, leg_y, 0.0860)),
            quat=numbers(euler_z_to_quat(deg)),
            size="0.0170 0.0036 0.0125",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        # Outer pan-stop lip (r = 0.148 .. 0.1675 m, Z = 0.1040 .. 0.1110 m)
        lx = BURNER_X + 0.1578 * math.cos(ang)
        ly = BURNER_Y + 0.1578 * math.sin(ang)
        ET.SubElement(
            trivet,
            "geom",
            name=f"rsb_trivet_lip_{idx}",
            type="box",
            pos=numbers((lx, ly, 0.1075)),
            quat=numbers(euler_z_to_quat(deg)),
            size="0.0098 0.0036 0.0035",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )
        # Lower trivet skirt chord connecting adjacent prongs around the ring (Z = 0.06825 .. 0.07825 m)
        chord_deg = deg + 30.0
        chord_ang = math.radians(chord_deg)
        rx = BURNER_X + 0.1095 * math.cos(chord_ang)
        ry = BURNER_Y + 0.1095 * math.sin(chord_ang)
        ET.SubElement(
            trivet,
            "geom",
            name=f"rsb_trivet_ring_{idx}",
            type="box",
            pos=numbers((rx, ry, 0.07325)),
            quat=numbers(euler_z_to_quat(chord_deg + 90.0)),
            size="0.0660 0.0120 0.0050",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )

    # Push-and-turn piezo ignition / gas valve control knob joints & collider
    ET.SubElement(
        knob,
        "joint",
        name="rsb_knob_push",
        type="slide",
        axis="0 1 0",
        limited="true",
        range="0 0.0040",
        stiffness="25",
        damping="2.5",
        armature="0.01",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        knob,
        "joint",
        name="rsb_knob_turn",
        type="hinge",
        axis="0 -1 0",
        limited="true",
        range="0 1.5707963",
        damping="0.40",
        armature="0.005",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        knob,
        "geom",
        name="rsb_control_knob_col",
        type="cylinder",
        pos="0 -0.0150 0",
        quat=Y_AXIS_QUAT,
        size="0.0205 0.0150",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Right-side swiveling Ø9.5 mm gas hose barb joint (±30 deg = ±0.5236 rad around X) & collider
    ET.SubElement(
        hose,
        "joint",
        name="rsb_hose_swivel",
        type="hinge",
        axis="1 0 0",
        limited="true",
        range="-0.5235988 0.5235988",
        damping="0.35",
        armature="0.005",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        hose,
        "geom",
        name="rsb_hose_end_col",
        type="capsule",
        fromto="-0.0120 0 0 0 0.0520 0",
        size="0.0075",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Blue Bunsen gas flame crown vertical modulation joint (-14 mm retracted OFF to +4 mm High flame) & proxy collider
    ET.SubElement(
        flame,
        "joint",
        name="rsb_flame_lift",
        type="slide",
        axis="0 0 1",
        limited="true",
        range="-0.0140 0.0040",
        damping="1.5",
        armature="0.01",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    ET.SubElement(
        flame,
        "geom",
        name="rsb_flame_crown_col",
        type="cylinder",
        pos="0 0 0.0025",
        size="0.0425 0.0062",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ARTIC_RGBA,
    )

    # Adjacent articulated-body contact exclusions (avoid self-collision while keeping all group-3 colliders enabled)
    contact = add_adjacent_excludes(
        hob,
        (
            ("exclude_stove_trivet", "rsb_stove", "rsb_trivet"),
            ("exclude_stove_burner_cap", "rsb_stove", "rsb_burner_cap"),
            ("exclude_stove_control_knob", "rsb_stove", "rsb_control_knob"),
            ("exclude_stove_hose_end", "rsb_stove", "rsb_hose_end"),
            ("exclude_stove_flame_crown", "rsb_stove", "rsb_flame_crown"),
            ("exclude_trivet_burner_cap", "rsb_trivet", "rsb_burner_cap"),
            ("exclude_trivet_flame_crown", "rsb_trivet", "rsb_flame_crown"),
            ("exclude_burner_cap_flame_crown", "rsb_burner_cap", "rsb_flame_crown"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(hob, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="rsb_knob_push_actuator",
        joint="rsb_knob_push",
        kp="220",
        ctrlrange="0 0.0040",
        forcerange="0 12",
    )
    ET.SubElement(
        actuators,
        "position",
        name="rsb_knob_turn_actuator",
        joint="rsb_knob_turn",
        kp="18",
        ctrlrange="0 1.5707963",
        forcerange="-4 4",
    )
    ET.SubElement(
        actuators,
        "position",
        name="rsb_hose_swivel_actuator",
        joint="rsb_hose_swivel",
        kp="14",
        ctrlrange="-0.5235988 0.5235988",
        forcerange="-4 4",
    )
    ET.SubElement(
        actuators,
        "position",
        name="rsb_flame_lift_actuator",
        joint="rsb_flame_lift",
        kp="60",
        ctrlrange="-0.0140 0.0040",
        forcerange="-5 5",
    )
    ET.SubElement(
        actuators,
        "position",
        name="rsb_trivet_lift_actuator",
        joint="rsb_trivet_lift",
        kp="2500",
        ctrlrange="0 0.060",
        forcerange="-40 40",
    )
    ET.SubElement(
        actuators,
        "position",
        name="rsb_burner_cap_lift_actuator",
        joint="rsb_burner_cap_lift",
        kp="2000",
        ctrlrange="0 0.040",
        forcerange="-25 25",
    )

    # Sensors
    sensors = ET.SubElement(hob, "sensor")
    ET.SubElement(sensors, "touch", name="rsb_pan_touch", site="rsb_pan_touch_site")
    ET.SubElement(sensors, "jointpos", name="rsb_knob_push_pos", joint="rsb_knob_push")
    ET.SubElement(sensors, "jointpos", name="rsb_knob_turn_pos", joint="rsb_knob_turn")
    ET.SubElement(sensors, "jointpos", name="rsb_hose_swivel_pos", joint="rsb_hose_swivel")
    ET.SubElement(sensors, "jointpos", name="rsb_flame_lift_pos", joint="rsb_flame_lift")
    ET.SubElement(sensors, "jointpos", name="rsb_trivet_lift_pos", joint="rsb_trivet_lift")
    ET.SubElement(
        sensors, "jointpos", name="rsb_burner_cap_lift_pos", joint="rsb_burner_cap_lift"
    )

    write_xml(ASSETS / "hob.xml", hob)
    write_xml(ASSETS / "appliance.xml", hob)

    # Emit standalone MjSpec.attach-ready model.xml
    emit_standalone_models(
        ASSETS,
        model_name="rsb_stove",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
    )

    # Build scene.xml including hob.xml, ../induction-pan/pan.xml, and ../induction-pan/studio.xml
    scene = ET.Element("mujoco", model="Rinnai RSB-150PJ commercial gas stove physics lab")
    ET.SubElement(scene, "include", file="hob.xml")
    ET.SubElement(scene, "include", file="../induction-pan/pan.xml")
    ET.SubElement(scene, "include", file="../induction-pan/studio.xml")
    scene_sensors = ET.SubElement(scene, "sensor")
    ET.SubElement(
        scene_sensors,
        "framepos",
        name="rsb_pan_sense",
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
                "published_mass_kg": 2.1,
                "published_max_pan_diameter_m": 0.280,
                "component_masses_kg": MASSES,
                "gas_ratings_kw": GAS_RATINGS_KW,
                "gas_connection": "Swiveling Ø9.5 mm gas rubber hose barb (φ9.5ガス用ゴム管)",
                "ignition_method": "Push-and-turn piezo ignition (圧電点火方式)",
                "safety_device": "Thermocouple flame-failure safety cut-off (立消え安全装置)",
                "trivet_pan_rest_z_m": PAN_REST_Z,
                "scope": "Articulated MuJoCo mechanical, 6-prong trivet pan-support, gas combustion, and thermocouple flame-failure safety model in hob.xml and scene.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from appliance_physics_kit import export_and_verify_native_xml
    from live_panels import STROKES, quaternion

    spec = mujoco.MjSpec.from_file(str(ASSETS / "scene.xml"))
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

    width, height, slots = 0.042, 0.014, 3
    live_body = spec.body("rsb_stove").add_body(
        name="live_setting",
        pos=(-0.055, -0.1402, 0.0350),
        quat=quaternion((90.0, 0.0, 0.0)),
    )
    live_body.add_geom(
        name="live_setting_back",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=(width / 2, height / 2, 0.0003),
        rgba=(0.08, 0.09, 0.11, 1),
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
                rgba=(0.12, 0.14, 0.16, 1),
                contype=0,
                conaffinity=0,
                group=2,
                mass=0,
            )
    live_body.add_geom(
        name="live_temperature_mode",
        type=mujoco.mjtGeom.mjGEOM_SPHERE,
        pos=(0.018, 0, 0.0007),
        size=(0.0020, 0, 0),
        rgba=(0.14, 0.52, 0.98, 1),
        contype=0,
        conaffinity=0,
        group=2,
        mass=0,
    )

    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    spec.body("ih_pan").pos = data.site("ih_zone").xpos + (0, 0, 0.004)
    kit_export_native_xml(
        ASSETS, "rinnai-rsb-150pj", mujoco, np, spec=spec, strip_general_input=False
    )


def write_asset_docs(report: dict):
    readme = f"""# Rinnai RSB-150PJ — Blender & MuJoCo Asset Package

Compact Japanese commercial 1-burner countertop gas stove (`リンナイ 業務用1口ガスコンロ コンパクト45シリーズ RSB-150PJ`, product code `51-7234`).

## Key Specifications

| Parameter | Value |
| --- | --- |
| Overall envelope (`W × D × H`) | `330 × 325 × 111 mm` (`0.330 × 0.325 × 0.111 m`) |
| Sheet-metal body (`W × D × H`) | `299 × 279 × 69 mm` (`SUS430` top plate + painted steel chassis) |
| Trivet cookware support plane | `Z = 0.106 m` (`106 mm`), 6-prong black porcelain enamel (`010-361-000`) |
| Forged brass burner cap | `Ø75 mm` (`151-420-000`), centered at `X = -0.010 m, Y = 0.000 m` |
| Usable pan diameter | `120 – 280 mm` (`最大鍋径 28 cm`) |
| Unit mass | `2.1 kg` |
| Gas input ratings | City Gas `13A`: `5.23 kW` (`4,500 kcal/h`) / `12A`: `4.87 kW` / `LPG`: `4.07 kW` (`0.291 kg/h`) |
| Gas connection | Right-side swiveling `Ø9.5 mm` gas rubber hose barb (`φ9.5ガス用ゴム管`) |
| Ignition & safety | Push-and-turn piezo ignition (`圧電点火`) + thermocouple flame-failure cut-off (`立消え安全装置`) |

## Files

- `rinnai-rsb-150pj.blend` / `rinnai-rsb-150pj.glb`: Authored Blender 5.2 scene and exported glTF 2.0 binary (`{report['glb_sha256'][:12]}…`).
- `front-panel-silkscreen.png`: Embedded `512 × 128` front panel silkscreen texture.
- `studio-{{main,top,front,right,burner,underside}}.png`: Six Cycles studio renders (`1600 × 1400`).
- `hob.xml` / `appliance.xml` / `scene.xml` / `native.xml`: MuJoCo mechanical, pan-support, combustion, and thermocouple safety models.
- `build-report.json` / `inspection-report.json` / `physics-export.json`: Automated verification manifests.
- `active-state-evidence/report.json` & `trace.csv`: 7-stage MuJoCo active-state simulation evidence.
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    s = report["stages"]
    active_md = f"""# Rinnai RSB-150PJ — MuJoCo Active-State Verification

Verified across `{report['trace_samples']}` simulation samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`standby_pan_seated`**: `200 mm` stainless saucepan seated on the 6-prong porcelain-enameled trivet at `Z = 0.106 m` with `{s['standby_pan_seated']['pan_touch_force_n']} N` contact force (`radial_offset = {s['standby_pan_seated']['pan_radial_offset_m']} m`, `0.0 kW`).
2. **`piezo_push_turn_ignition_13a_high`**: Push-and-turn piezo ignition (`押し回し` `4.0 mm` push + `90°` CCW turn) lights the `Ø75 mm` dual-ring brass burner on City Gas `13A` at `{s['piezo_push_turn_ignition_13a_high']['gas_input_kw']} kW` (`{s['piezo_push_turn_ignition_13a_high']['effective_pan_heat_w']} W` delivered to pan, thermocouple `{s['piezo_push_turn_ignition_13a_high']['thermocouple_mv']} mV` holding magnet valve open, pan heated to `{s['piezo_push_turn_ignition_13a_high']['pan_temp_c']} °C`).
3. **`flame_modulation_medium_and_simmer`**: Intermediate detent modulation from Medium (`中火` `2.80 kW`) to Simmer (`とろ火` `{s['flame_modulation_medium_and_simmer']['gas_input_kw']} kW`, `{s['flame_modulation_medium_and_simmer']['knob_turn_deg']}°`) with stable inner-bridge flame retention.
4. **`lpg_4070w_operating_mode`**: LP Gas (`LPG`) full-power operation at `{s['lpg_4070w_operating_mode']['gas_input_kw']} kW` (`{s['lpg_4070w_operating_mode']['lpg_mass_flow_kg_h']} kg/h`, `{s['lpg_4070w_operating_mode']['effective_pan_heat_w']} W` delivered to pan).
5. **`boilover_flameout_thermocouple_safety_cutoff`**: Simulated boil-over extinguishes the flame while the knob remains at `90°`; thermocouple cooling below `8.0 mV` (`{s['boilover_flameout_thermocouple_safety_cutoff']['thermocouple_mv']} mV`) trips the electromagnetic safety valve closed (`gas_input_kw = 0.0`, `reason = {s['boilover_flameout_thermocouple_safety_cutoff']['safety_cutoff_reason']}`).
6. **`trivet_and_burner_cap_maintenance_lift`**: Tool-free vertical lift of the 6-prong trivet (`{s['trivet_and_burner_cap_maintenance_lift']['trivet_lift_m']} m`) and `Ø75 mm` forged brass burner cap (`{s['trivet_and_burner_cap_maintenance_lift']['burner_cap_lift_m']} m`) for commercial cleaning.
7. **`swivel_hose_end_positioning`**: Right-side `Ø9.5 mm` gas hose barb swiveled (`{s['swivel_hose_end_positioning']['hose_swivel_deg']}°`) while maintaining stable pan support (`{s['swivel_hose_end_positioning']['pan_touch_force_n']} N`) on the `Z = 0.106 m` trivet plane.
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    export_native_xml(mujoco, np)

    # Verify GLB rest frames and 21-sample scalar joint trajectories
    visual_motions = {
        "rsb_trivet_lift": [0.0, 0.0, 1.0],
        "rsb_burner_cap_lift": [0.0, 0.0, 1.0],
        "rsb_knob_push": [0.0, 1.0, 0.0],
        "rsb_knob_turn": [0.0, -1.0, 0.0],
        "rsb_hose_swivel": [1.0, 0.0, 0.0],
        "rsb_flame_lift": [0.0, 0.0, 1.0],
    }
    kit_verify_frames_and_motions(
        ASSETS,
        "rinnai-rsb-150pj",
        NAMES,
        visual_motions,
        mujoco,
        ASSETS / "active-state-evidence",
        cleanup_inputs=True,
    )

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    pan_qpos_adr = model.joint("ih_pan_free").qposadr[0]
    data.qpos[pan_qpos_adr] = BURNER_X
    data.qpos[pan_qpos_adr + 1] = BURNER_Y
    data.qpos[pan_qpos_adr + 2] = PAN_REST_Z + 0.0002
    # Start with flame retracted (-14 mm) in Standby
    flame_qpos_adr = model.joint("rsb_flame_lift").qposadr[0]
    data.qpos[flame_qpos_adr] = -0.0140
    data.ctrl[model.actuator("rsb_flame_lift_actuator").id] = -0.0140
    mujoco.mj_forward(model, data)

    def step_sim(steps: int):
        for _ in range(steps):
            mujoco.mj_step(model, data)

    state = {
        "gas_type": "13A",              # "13A" (5.23 kW) | "12A" (4.87 kW) | "LPG" (4.07 kW)
        "flame_lit": False,
        "piezo_spark_fired": False,
        "magnet_valve_open": False,
        "thermocouple_temp_c": 22.0,
        "thermocouple_mv": 0.0,
        "gas_input_kw": 0.0,
        "effective_pan_heat_w": 0.0,
        "lpg_mass_flow_kg_h": 0.0,
        "pan_temp_c": 22.0,
        "drip_pan_temp_c": 22.0,
        "safety_cutoff_reason": "none",
    }

    ambient_c = 22.0
    open_flame_efficiency = 0.55
    pan_heat_capacity_j_per_k = 920.0
    drip_heat_capacity_j_per_k = 420.0

    trace_rows = []
    stage_summaries = {}

    def valve_fraction_from_turn(turn_rad: float) -> float:
        deg = math.degrees(turn_rad)
        if deg < 8.0:
            return 0.0
        # 90 deg = Full High (1.0), 48 deg = Medium (0.5354 -> 2.80 kW on 13A), 24 deg = Simmer (0.1816 -> 0.95 kW on 13A)
        if deg >= 85.0:
            return 1.0
        elif deg >= 48.0:
            return 0.535373 + (deg - 48.0) / (85.0 - 48.0) * (1.0 - 0.535373)
        else:
            return 0.181644 * (deg / 24.0) if deg <= 24.0 else 0.181644 + (deg - 24.0) / 24.0 * (0.535373 - 0.181644)

    def update_combustion_and_safety(dt_s: float, thermal_accel: float = 20.0):
        push_m = float(data.sensor("rsb_knob_push_pos").data[0])
        turn_rad = float(data.sensor("rsb_knob_turn_pos").data[0])
        turn_deg = math.degrees(turn_rad)
        hose_deg = math.degrees(float(data.sensor("rsb_hose_swivel_pos").data[0]))
        trivet_lift_m = float(data.sensor("rsb_trivet_lift_pos").data[0])
        cap_lift_m = float(data.sensor("rsb_burner_cap_lift_pos").data[0])

        rel_pos = data.sensor("rsb_pan_sense").data
        radial_offset_m = float(math.hypot(rel_pos[0], rel_pos[1]))
        vertical_gap_m = float(abs(rel_pos[2]))
        touch_force_n = float(data.sensor("rsb_pan_touch").data[0])
        pan_present = (
            radial_offset_m <= 0.075
            and vertical_gap_m <= 0.015
            and touch_force_n >= 2.0
            and trivet_lift_m < 0.005
        )

        valve_frac = valve_fraction_from_turn(turn_rad)
        manual_push_hold = push_m >= 0.0025

        # Push-and-turn piezo spark triggers when pushed >= 2.0 mm and turned >= 75 deg
        if manual_push_hold and turn_deg >= 75.0 and cap_lift_m < 0.002:
            state["piezo_spark_fired"] = True
            if state["safety_cutoff_reason"] == "none":
                state["flame_lit"] = True
                state["ever_lit_this_cycle"] = True

        # Thermocouple EMF model (立消え安全装置):
        # Heated by inner/outer burner flame jets; cools rapidly on flame-out
        if state["flame_lit"] and valve_frac > 0.0:
            target_tc_c = 280.0 + 260.0 * valve_frac
            state["thermocouple_temp_c"] += (target_tc_c - state["thermocouple_temp_c"]) * min(1.0, dt_s * 6.5)
        else:
            state["thermocouple_temp_c"] += (ambient_c - state["thermocouple_temp_c"]) * min(1.0, dt_s * 5.5)

        state["thermocouple_mv"] = round(
            max(0.0, (state["thermocouple_temp_c"] - ambient_c) * 0.055), 2
        )

        # Electromagnetic safety valve (マグネット安全弁) stays open while manually pushed OR while thermocouple >= 8.0 mV
        if valve_frac == 0.0:
            state["flame_lit"] = False
            state["ever_lit_this_cycle"] = False
            state["magnet_valve_open"] = False
            state["piezo_spark_fired"] = False
            state["safety_cutoff_reason"] = "none"
        elif manual_push_hold or state["thermocouple_mv"] >= 8.0:
            state["magnet_valve_open"] = True
        else:
            state["magnet_valve_open"] = False
            state["flame_lit"] = False
            if state.get("ever_lit_this_cycle", False) and turn_deg >= 10.0:
                state["safety_cutoff_reason"] = "thermocouple_flame_failure_cutoff"

        rated_kw = GAS_RATINGS_KW[state["gas_type"]]
        if state["magnet_valve_open"] and state["flame_lit"] and valve_frac > 0.0:
            gas_kw = round(rated_kw * valve_frac, 2)
        else:
            gas_kw = 0.0

        state["gas_input_kw"] = gas_kw
        state["effective_pan_heat_w"] = round(
            gas_kw * 1000.0 * open_flame_efficiency if pan_present else 0.0, 1
        )
        state["lpg_mass_flow_kg_h"] = (
            round(0.291 * (gas_kw / 4.07), 4) if state["gas_type"] == "LPG" and gas_kw > 0.0 else 0.0
        )

        # Position blue flame crown proportional to gas_kw
        if gas_kw > 0.0:
            flame_target_z = -0.0020 + 0.0050 * (gas_kw / 5.23)
        else:
            flame_target_z = -0.0140
        data.ctrl[model.actuator("rsb_flame_lift_actuator").id] = flame_target_z

        # Thermal integration
        eff_dt = dt_s * thermal_accel
        q_pan = state["effective_pan_heat_w"]
        q_drip = gas_kw * 1000.0 * 0.06
        q_pan_loss = (state["pan_temp_c"] - ambient_c) * 1.4
        q_drip_loss = (state["drip_pan_temp_c"] - ambient_c) * 1.1

        state["pan_temp_c"] += ((q_pan - q_pan_loss) / pan_heat_capacity_j_per_k) * eff_dt
        state["drip_pan_temp_c"] += ((q_drip - q_drip_loss) / drip_heat_capacity_j_per_k) * eff_dt

        return {
            "time_s": round(float(data.time), 3),
            "gas_type": state["gas_type"],
            "knob_push_m": round(push_m, 5),
            "knob_turn_deg": round(turn_deg, 2),
            "piezo_spark_fired": state["piezo_spark_fired"],
            "flame_lit": state["flame_lit"],
            "thermocouple_mv": state["thermocouple_mv"],
            "magnet_valve_open": state["magnet_valve_open"],
            "gas_input_kw": state["gas_input_kw"],
            "lpg_mass_flow_kg_h": state["lpg_mass_flow_kg_h"],
            "effective_pan_heat_w": state["effective_pan_heat_w"],
            "flame_lift_m": round(float(data.sensor("rsb_flame_lift_pos").data[0]), 5),
            "pan_touch_force_n": round(touch_force_n, 3),
            "pan_radial_offset_m": round(radial_offset_m, 5),
            "pan_temp_c": round(state["pan_temp_c"], 2),
            "drip_pan_temp_c": round(state["drip_pan_temp_c"], 2),
            "trivet_lift_m": round(trivet_lift_m, 4),
            "burner_cap_lift_m": round(cap_lift_m, 4),
            "hose_swivel_deg": round(hose_deg, 2),
            "safety_cutoff_reason": state["safety_cutoff_reason"],
        }

    def record_steps(duration_s: float, sample_every_s: float = 0.05, thermal_accel: float = 20.0):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            step_sim(steps_per_sample)
            last_snap = update_combustion_and_safety(sample_every_s, thermal_accel=thermal_accel)
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby with 200 mm pan seated on the 6-prong trivet at Z = 0.1060 m
    snap1 = record_steps(0.40, thermal_accel=1.0)
    assert snap1["pan_touch_force_n"] > 9.0, snap1
    assert snap1["pan_radial_offset_m"] < 0.002, snap1
    assert snap1["gas_input_kw"] == 0.0, snap1
    assert snap1["magnet_valve_open"] is False, snap1
    stage_summaries["standby_pan_seated"] = snap1

    # Stage 2: Push-and-turn piezo ignition (押し回し) to City Gas 13A High flame (強火 5.23 kW)
    data.ctrl[model.actuator("rsb_knob_push_actuator").id] = 0.0040
    data.ctrl[model.actuator("rsb_knob_turn_actuator").id] = math.pi * 0.5
    record_steps(0.35, thermal_accel=18.0)
    # Release push after thermocouple heats above hold threshold
    data.ctrl[model.actuator("rsb_knob_push_actuator").id] = 0.0
    snap2 = record_steps(0.75, thermal_accel=25.0)
    assert snap2["piezo_spark_fired"] is True, snap2
    assert snap2["flame_lit"] is True, snap2
    assert snap2["magnet_valve_open"] is True, snap2
    assert snap2["thermocouple_mv"] >= 12.0, snap2
    assert snap2["gas_input_kw"] == 5.23, snap2
    assert snap2["effective_pan_heat_w"] == 2876.5, snap2
    assert snap2["pan_temp_c"] > 80.0, snap2
    stage_summaries["piezo_push_turn_ignition_13a_high"] = snap2

    # Stage 3: Intermediate detent modulation (中火 48 deg -> 2.80 kW, then とろ火 24 deg -> 0.95 kW)
    data.ctrl[model.actuator("rsb_knob_turn_actuator").id] = math.radians(48.0)
    snap3_med = record_steps(0.35, thermal_accel=15.0)
    assert abs(snap3_med["gas_input_kw"] - 2.80) <= 0.05, snap3_med

    data.ctrl[model.actuator("rsb_knob_turn_actuator").id] = math.radians(24.0)
    snap3 = record_steps(0.40, thermal_accel=15.0)
    assert abs(snap3["gas_input_kw"] - 0.95) <= 0.05, snap3
    assert snap3["magnet_valve_open"] is True, snap3
    stage_summaries["flame_modulation_medium_and_simmer"] = snap3

    # Stage 4: LP Gas (LPG 4.07 kW / 0.291 kg/h) full-power operating mode
    state["gas_type"] = "LPG"
    data.ctrl[model.actuator("rsb_knob_turn_actuator").id] = math.pi * 0.5
    snap4 = record_steps(0.45, thermal_accel=15.0)
    assert snap4["gas_type"] == "LPG", snap4
    assert snap4["gas_input_kw"] == 4.07, snap4
    assert abs(snap4["lpg_mass_flow_kg_h"] - 0.291) <= 0.002, snap4
    assert snap4["effective_pan_heat_w"] == 2238.5, snap4
    stage_summaries["lpg_4070w_operating_mode"] = snap4

    # Stage 5: Boil-over / draft flame-out -> thermocouple flame-failure safety cut-off (立消え安全装置)
    state["gas_type"] = "13A"
    state["flame_lit"] = False  # Boil-over extinguishes flame while knob stays at 90 deg
    snap5 = record_steps(0.65, thermal_accel=10.0)
    assert snap5["flame_lit"] is False, snap5
    assert snap5["thermocouple_mv"] < 8.0, snap5
    assert snap5["magnet_valve_open"] is False, snap5
    assert snap5["gas_input_kw"] == 0.0, snap5
    assert snap5["safety_cutoff_reason"] == "thermocouple_flame_failure_cutoff", snap5
    stage_summaries["boilover_flameout_thermocouple_safety_cutoff"] = snap5

    # Stage 6: Return knob to OFF (止), lift removable 6-prong trivet & Ø75 mm brass burner cap for cleaning
    data.ctrl[model.actuator("rsb_knob_turn_actuator").id] = 0.0
    data.qpos[pan_qpos_adr] = 0.400  # Place pan on bench beside stove during trivet/cap lift
    data.qpos[pan_qpos_adr + 1] = 0.0
    data.qpos[pan_qpos_adr + 2] = 0.002
    data.qpos[pan_qpos_adr + 3 : pan_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)
    data.ctrl[model.actuator("rsb_trivet_lift_actuator").id] = 0.035
    data.ctrl[model.actuator("rsb_burner_cap_lift_actuator").id] = 0.020
    snap6 = record_steps(0.40, thermal_accel=5.0)
    assert snap6["trivet_lift_m"] > 0.030, snap6
    assert snap6["burner_cap_lift_m"] > 0.016, snap6
    assert snap6["gas_input_kw"] == 0.0, snap6
    stage_summaries["trivet_and_burner_cap_maintenance_lift"] = snap6

    # Stage 7: Re-seat trivet, burner cap, and pan; verify right-side Ø9.5 mm gas hose barb swivel
    data.ctrl[model.actuator("rsb_trivet_lift_actuator").id] = 0.0
    data.ctrl[model.actuator("rsb_burner_cap_lift_actuator").id] = 0.0
    record_steps(0.30, thermal_accel=5.0)
    data.qpos[pan_qpos_adr] = BURNER_X
    data.qpos[pan_qpos_adr + 1] = BURNER_Y
    data.qpos[pan_qpos_adr + 2] = PAN_REST_Z + 0.0002
    data.qpos[pan_qpos_adr + 3 : pan_qpos_adr + 7] = (1.0, 0.0, 0.0, 0.0)
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)
    data.ctrl[model.actuator("rsb_hose_swivel_actuator").id] = math.radians(20.0)
    snap7 = record_steps(0.40, thermal_accel=5.0)
    assert abs(snap7["hose_swivel_deg"] - 20.0) < 1.5, snap7
    assert snap7["pan_touch_force_n"] > 9.0, snap7
    stage_summaries["swivel_hose_end_positioning"] = snap7

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "rinnai-rsb-150pj",
        "product_code": "51-7234",
        "model_title": "Rinnai RSB-150PJ Commercial 1-Burner Countertop Gas Stove",
        "gas_ratings_kw": GAS_RATINGS_KW,
        "envelope_m": [0.330, 0.325, 0.111],
        "stamped_sheet_body_m": [0.299, 0.279, 0.069],
        "burner_cap_diameter_m": 0.075,
        "trivet_pan_rest_z_m": PAN_REST_Z,
        "usable_pan_diameter_range_m": [0.120, 0.280],
        "unit_mass_kg": 2.1,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256(
            (ASSETS / "rinnai-rsb-150pj.glb").read_bytes()
        ).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": hashlib.sha256(
            (ASSETS / "native.xml").read_bytes()
        ).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    write_asset_docs(report)
    print(json.dumps(report, indent=2))


def main():
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
    run_active_state_verification()


if __name__ == "__main__":
    main()
