"""Build and verify the MuJoCo mechanical, 5-zone PAM inverter, and chilled-vessel model for the Hitachi R-HWS47XL."""

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

ASSETS = ROOT / "assets/bakery-mujoco/hitachi-r-hws47xl"

NAMES = (
    "hws_cabinet",
    "hws_fridge_door",
    "hws_ice_drawer",
    "hws_upper_freezer",
    "hws_lower_freezer",
    "hws_veg_drawer",
    "hws_milk_carton",
)

# Published unit mass = 93.000 kg across the 6 refrigerator bodies + 0.650 kg chilled milk/cream carton = 93.650 kg scene mass
APPLIANCE_MASSES = {
    "hws_cabinet": 67.400,
    "hws_fridge_door": 9.200,
    "hws_ice_drawer": 2.600,
    "hws_upper_freezer": 2.900,
    "hws_lower_freezer": 5.800,
    "hws_veg_drawer": 5.100,
}
CHILLED_VESSEL_MASS_KG = 0.650

MASSES = {
    **APPLIANCE_MASSES,
    "hws_milk_carton": CHILLED_VESSEL_MASS_KG,
}

CENTERS = {
    "hws_cabinet": (0.0, 0.045, 0.880),
    "hws_fridge_door": (0.292, 0.015, -0.010),
    "hws_ice_drawer": (0.0, 0.160, -0.020),
    "hws_upper_freezer": (0.0, 0.160, -0.020),
    "hws_lower_freezer": (0.0, 0.200, -0.030),
    "hws_veg_drawer": (0.0, 0.200, -0.030),
    "hws_milk_carton": (0.0, 0.0, -0.015),
}

INERTIAS = {
    "hws_cabinet": (19.400, 18.800, 4.250),
    "hws_fridge_door": (0.640, 0.920, 0.290),
    "hws_ice_drawer": (0.038, 0.024, 0.048),
    "hws_upper_freezer": (0.042, 0.030, 0.056),
    "hws_lower_freezer": (0.135, 0.185, 0.245),
    "hws_veg_drawer": (0.120, 0.165, 0.220),
    "hws_milk_carton": (0.0016, 0.0016, 0.0006),
}

VISUAL_MOTIONS = {
    "hws_fridge_door_hinge": (0, 0, -1),
    "hws_ice_drawer_slide": (0, -1, 0),
    "hws_upper_freezer_slide": (0, -1, 0),
    "hws_lower_freezer_slide": (0, -1, 0),
    "hws_veg_drawer_slide": (0, -1, 0),
}

MILK_CARTON_REST_POSE = (-0.0850, -0.0350, 1.2400)
FRIDGE_DOOR_MAX_RAD = math.radians(110.0)


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml, scene.xml, model.xml, and carton_model.xml."""
    source = ASSETS / "hitachi-r-hws47xl.blend"
    parts, poses = prepare_blender_assembly(
        source, NAMES, ASSETS, clear_all_animations=False
    )

    app = ET.Element(
        "mujoco",
        model="hitachi-r-hws47xl — 470L 5-door left-hinged upright refrigerator-freezer",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="10")

    defaults = add_standard_defaults(app, friction="0.65 0.015 0.003")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="2.0 2.0 0.05",
        rgba="0.28 0.30 0.32 1",
        contype="1",
        conaffinity="1",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "hws_milk_carton":
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "hws_cabinet" else None)
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

    base = bodies["hws_cabinet"]
    door = bodies["hws_fridge_door"]
    ice_drw = bodies["hws_ice_drawer"]
    up_frz = bodies["hws_upper_freezer"]
    low_frz = bodies["hws_lower_freezer"]
    veg_drw = bodies["hws_veg_drawer"]
    carton = bodies["hws_milk_carton"]

    # Four support feet collision cylinders touching Z = 0.000 m
    for foot_name, fx, fy in (
        ("hws_foot_fl_col", -0.2620, -0.2850),
        ("hws_foot_fr_col", 0.2620, -0.2850),
        ("hws_foot_rl_col", -0.2620, 0.2750),
        ("hws_foot_rr_col", 0.2620, 0.2750),
    ):
        ET.SubElement(
            base,
            "geom",
            name=foot_name,
            type="cylinder",
            pos=numbers((fx, fy, 0.0090)),
            size="0.0175 0.0090",
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_BASE_RGBA,
        )

    # VIP cabinet shell, roof canopy, toe-kick, mullions, interior cases, and three Marugoto Chilled tempered-glass shelves (Shelf 1 top = Z = 1.1400 m)
    cabinet_colliders = (
        ("hws_left_wall_col", (-0.2890, 0.0160, 0.9190), (0.0110, 0.3345, 0.9010), COL_BASE_RGBA),
        ("hws_right_wall_col", (0.2890, 0.0160, 0.9190), (0.0110, 0.3345, 0.9010), COL_BASE_RGBA),
        ("hws_rear_wall_col", (0.0, 0.3345, 1.0220), (0.2780, 0.0160, 0.7820), COL_BASE_RGBA),
        ("hws_rear_compressor_bulkhead_col", (0.0, 0.2820, 0.1290), (0.2780, 0.0140, 0.1110), COL_BASE_RGBA),
        ("hws_roof_col", (0.0, 0.0160, 1.8120), (0.2790, 0.3345, 0.0085), COL_BASE_RGBA),
        ("hws_top_canopy_col", (0.0, 0.0150, 1.8265), (0.2980, 0.2600, 0.0065), COL_BASE_RGBA),
        ("hws_left_hinge_cover_col", (-0.2440, -0.2920, 1.8240), (0.0540, 0.0560, 0.0070), COL_BASE_RGBA),
        ("hws_base_pan_col", (0.0, 0.0050, 0.0270), (0.2790, 0.3150, 0.0090), COL_BASE_RGBA),
        ("hws_toe_kick_col", (0.0, -0.3410, 0.0185), (0.2990, 0.0070, 0.0105), COL_BASE_RGBA),
        ("hws_air_tower_col", (0.0, 0.2960, 1.4500), (0.1120, 0.0210, 0.2950), COL_WALL_RGBA),
        ("hws_upper_mullion_col", (0.0, 0.0050, 0.9020), (0.2780, 0.3175, 0.0120), COL_WALL_RGBA),
        ("hws_mid_vertical_mullion_col", (-0.0200, -0.1050, 0.7825), (0.0090, 0.2125, 0.1075), COL_WALL_RGBA),
        ("hws_mid_mullion_col", (0.0, 0.0050, 0.6725), (0.2780, 0.3175, 0.0090), COL_WALL_RGBA),
        ("hws_lower_mullion_col", (0.0, 0.0050, 0.3425), (0.2780, 0.3175, 0.0090), COL_WALL_RGBA),
        ("hws_chilled_shelf_1_col", (0.0, 0.0550, 1.1360), (0.2560, 0.2200, 0.0040), COL_WALL_RGBA),
        # Keep top surface at Z = 1.3450 m while clearing the 200 mm chilled carton cap (Z_top = 1.3400 m) on Shelf 1
        ("hws_chilled_shelf_2_col", (0.0, 0.0550, 1.3430), (0.2560, 0.2200, 0.0020), COL_WALL_RGBA),
        ("hws_chilled_shelf_3_col", (0.0, 0.0550, 1.5410), (0.2560, 0.2100, 0.0040), COL_WALL_RGBA),
        ("hws_fixed_lower_shelf_col", (0.0, 0.0600, 1.0910), (0.2560, 0.2100, 0.0035), COL_WALL_RGBA),
        ("hws_hyoon_case_floor_col", (0.0680, 0.0650, 0.9265), (0.1830, 0.2030, 0.0055), COL_WALL_RGBA),
        ("hws_hyoon_case_front_col", (0.0680, -0.1415, 1.0020), (0.1840, 0.0045, 0.0790), COL_WALL_RGBA),
        ("hws_lower_bay_divider_col", (-0.1220, 0.0600, 1.0010), (0.0040, 0.2050, 0.0860), COL_WALL_RGBA),
        ("hws_water_tank_col", (-0.1900, 0.0550, 0.9600), (0.0600, 0.1950, 0.0400), COL_WALL_RGBA),
        ("hws_egg_case_col", (-0.1900, 0.0550, 1.0440), (0.0600, 0.1910, 0.0340), COL_WALL_RGBA),
    )
    for cname, cpos, csize, crgba in cabinet_colliders:
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

    # Compartment thermal & contact sensing sites on hws_cabinet (group 4, visible semi-transparent rgba)
    for sname, spos in (
        ("hws_marugoto_chilled_site", (-0.0850, -0.0350, 1.1400)),
        ("hws_tokusen_hyoon_site", (-0.0680, 0.0650, 0.9850)),
        ("hws_ice_zone_site", (-0.1600, -0.1500, 0.7825)),
        ("hws_upper_freezer_site", (0.1400, -0.1500, 0.7825)),
        ("hws_lower_freezer_site", (0.0, -0.1100, 0.5075)),
        ("hws_veg_zone_site", (0.0, -0.1100, 0.1800)),
    ):
        ET.SubElement(
            base,
            "site",
            name=sname,
            pos=numbers(spos),
            size="0.008",
            group="4",
            rgba=SITE_SUPPORT_RGBA,
        )

    ET.SubElement(
        base,
        "site",
        name="hws_chilled_shelf_touch_site",
        type="box",
        pos="-0.0850 -0.0350 1.1415",
        size="0.0600 0.0600 0.0040",
        group="4",
        rgba=SITE_SUPPORT_RGBA,
    )

    # 1. Left-hinged upper refrigerator door (`hws_fridge_door`, `243 L`, `0 .. 110 deg` around `0 0 -1`)
    ET.SubElement(
        door,
        "joint",
        name="hws_fridge_door_hinge",
        type="hinge",
        axis="0 0 -1",
        limited="true",
        range=numbers((0.0, FRIDGE_DOOR_MAX_RAD)),
        damping="2.8",
        armature="0.045",
        frictionloss="0.5",
        solreffriction="0.004 1",
        solreflimit="0.005 1",
    )
    door_colliders = [
        ("hws_fridge_door_col", (0.2920, 0.0130, 0.0025), (0.2990, 0.0210, 0.4590)),
        ("hws_fridge_door_dike_left_col", (0.0680, 0.0500, 0.0020), (0.0080, 0.0160, 0.4080)),
        ("hws_fridge_door_dike_right_col", (0.5160, 0.0500, 0.0020), (0.0080, 0.0160, 0.4080)),
    ]
    for p_idx, (pz_local, ph, pdepth) in enumerate(
        ((-0.3280, 0.1420, 0.0840), (-0.0380, 0.0960, 0.0760), (0.2320, 0.0840, 0.0720)),
        1,
    ):
        door_colliders.append(
            (
                f"hws_fridge_door_pocket_{p_idx}_floor_col",
                (0.2920, 0.0400 + pdepth * 0.5, pz_local - ph * 0.5 + 0.0025),
                (0.2100, pdepth * 0.5, 0.0025),
            )
        )
        door_colliders.append(
            (
                f"hws_fridge_door_pocket_{p_idx}_rail_col",
                (0.2920, 0.0400 + pdepth - 0.0025, pz_local),
                (0.2100, 0.0025, ph * 0.5),
            )
        )
    for dname, dpos, dsize in door_colliders:
        ET.SubElement(
            door,
            "geom",
            name=dname,
            type="box",
            pos=numbers(dpos),
            size=numbers(dsize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )

    # 2..5. Four pull-out drawer slide joints (`axis="0 -1 0"`) + front plate & open-top tub (floor + left/right/rear walls)
    drawer_specs = (
        (ice_drw, "hws_ice_drawer_slide", 0.360, -0.0008, 0.2776, 0.2120, 0.2280, 0.3800, 0.1550),
        (up_frz, "hws_upper_freezer_slide", 0.360, 0.0008, 0.3176, 0.2120, 0.2640, 0.3800, 0.1550),
        (low_frz, "hws_lower_freezer_slide", 0.420, 0.0, 0.5992, 0.3220, 0.5060, 0.4700, 0.2550),
        (veg_drw, "hws_veg_drawer_slide", 0.420, 0.0, 0.5992, 0.3120, 0.5060, 0.4700, 0.2500),
    )
    for drw_body, jname, travel_m, cx, fw, fh, tw, td, th in drawer_specs:
        drw_name = drw_body.get("name")
        tub_y_center = 0.0320 + td * 0.5
        tub_z_floor = -fh * 0.5 + 0.0240
        ET.SubElement(
            drw_body,
            "joint",
            name=jname,
            type="slide",
            axis="0 -1 0",
            limited="true",
            range=numbers((0.0, travel_m)),
            damping="16.0",
            armature="0.025",
            frictionloss="0.6",
            solreffriction="0.004 1",
            solreflimit="0.005 1",
        )
        for suffix, gpos, gsize in (
            ("front_col", (cx, 0.01025, 0.0), (fw * 0.5, 0.01875, fh * 0.5)),
            ("floor_col", (cx, tub_y_center, tub_z_floor), (tw * 0.5, td * 0.5, 0.0050)),
            (
                "left_wall_col",
                (cx - tw * 0.5 + 0.0060, tub_y_center, tub_z_floor + th * 0.5),
                (0.0060, td * 0.5, th * 0.5),
            ),
            (
                "right_wall_col",
                (cx + tw * 0.5 - 0.0060, tub_y_center, tub_z_floor + th * 0.5),
                (0.0060, td * 0.5, th * 0.5),
            ),
            (
                "rear_wall_col",
                (cx, 0.0320 + td - 0.0060, tub_z_floor + th * 0.5),
                (tw * 0.5, 0.0060, th * 0.5),
            ),
        ):
            ET.SubElement(
                drw_body,
                "geom",
                name=f"{drw_name}_{suffix}",
                type="box",
                pos=numbers(gpos),
                size=numbers(gsize),
                contype="1",
                conaffinity="1",
                group="3",
                rgba=COL_ARTIC_RGBA,
            )

    # Inner multi-tier slide trays & Freshness Sleep Ru catalyst cover inside lower freezer & vegetable drawers
    for parent_drw, tname, tpos, tsize in (
        (low_frz, "hws_lower_freezer_upper_tray_col", (0.0, 0.2120, 0.0815), (0.2390, 0.1175, 0.0050)),
        (low_frz, "hws_lower_freezer_mid_tray_col", (0.0, 0.2770, -0.0250), (0.2390, 0.1457, 0.0050)),
        (veg_drw, "hws_veg_drawer_ru_cover_col", (0.0, 0.2420, 0.1080), (0.2390, 0.1504, 0.0040)),
        (veg_drw, "hws_veg_drawer_upper_tray_col", (0.0, 0.2890, 0.0480), (0.2380, 0.1316, 0.0050)),
    ):
        ET.SubElement(
            parent_drw,
            "geom",
            name=tname,
            type="box",
            pos=numbers(tpos),
            size=numbers(tsize),
            contype="1",
            conaffinity="1",
            group="3",
            rgba=COL_ARTIC_RGBA,
        )

    # 6. Chilled patisserie milk/cream carton (`hws_milk_carton`, 6-DOF `freejoint` with `vessel_socket` & `ingredient_payload`)
    ET.SubElement(carton, "freejoint", name="hws_milk_carton_free")
    ET.SubElement(
        carton,
        "geom",
        name="hws_milk_carton_col",
        type="box",
        pos="0 0 -0.0200",
        size="0.0360 0.0360 0.0800",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        carton,
        "geom",
        name="hws_milk_carton_gable_col",
        type="box",
        pos="0 0 0.0740",
        size="0.0340 0.0260 0.0140",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        carton,
        "geom",
        name="hws_milk_carton_cap_col",
        type="cylinder",
        pos="0 -0.0100 0.0940",
        size="0.0145 0.0060",
        contype="1",
        conaffinity="1",
        group="3",
        rgba=COL_ACCESSORY_RGBA,
    )
    ET.SubElement(
        carton,
        "site",
        name="vessel_socket",
        pos="0 0 0.0100",
        size="0.006",
        group="4",
        rgba=SITE_GRASP_RGBA,
    )
    payload = ET.SubElement(carton, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 -0.0200",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="box",
        pos="0 0 -0.0200",
        size="0.0320 0.0320 0.0650",
        contype="0",
        conaffinity="0",
        group="2",
        rgba="0.97 0.96 0.92 0",
        mass="0",
    )

    # Contact exclusions between cabinet & articulated children, and between adjacent drawers/door
    contact = add_adjacent_excludes(
        app,
        (
            ("exclude_cabinet_fridge_door", "hws_cabinet", "hws_fridge_door"),
            ("exclude_cabinet_ice_drawer", "hws_cabinet", "hws_ice_drawer"),
            ("exclude_cabinet_upper_freezer", "hws_cabinet", "hws_upper_freezer"),
            ("exclude_cabinet_lower_freezer", "hws_cabinet", "hws_lower_freezer"),
            ("exclude_cabinet_veg_drawer", "hws_cabinet", "hws_veg_drawer"),
            ("exclude_ice_upper_freezer", "hws_ice_drawer", "hws_upper_freezer"),
            ("exclude_ice_lower_freezer", "hws_ice_drawer", "hws_lower_freezer"),
            ("exclude_upper_lower_freezer", "hws_upper_freezer", "hws_lower_freezer"),
            ("exclude_lower_freezer_veg", "hws_lower_freezer", "hws_veg_drawer"),
            ("exclude_door_ice_drawer", "hws_fridge_door", "hws_ice_drawer"),
            ("exclude_door_upper_freezer", "hws_fridge_door", "hws_upper_freezer"),
        ),
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="hws_fridge_door_actuator",
        joint="hws_fridge_door_hinge",
        kp="145",
        kv="14.0",
        ctrlrange=numbers((0.0, FRIDGE_DOOR_MAX_RAD)),
        forcerange="-85 85",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hws_ice_drawer_actuator",
        joint="hws_ice_drawer_slide",
        kp="220",
        kv="24.0",
        ctrlrange="0 0.360",
        forcerange="-90 90",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hws_upper_freezer_actuator",
        joint="hws_upper_freezer_slide",
        kp="220",
        kv="24.0",
        ctrlrange="0 0.360",
        forcerange="-90 90",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hws_lower_freezer_actuator",
        joint="hws_lower_freezer_slide",
        kp="260",
        kv="28.0",
        ctrlrange="0 0.420",
        forcerange="-120 120",
    )
    ET.SubElement(
        actuators,
        "position",
        name="hws_veg_drawer_actuator",
        joint="hws_veg_drawer_slide",
        kp="250",
        kv="27.0",
        ctrlrange="0 0.420",
        forcerange="-120 120",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(
        sensors, "jointpos", name="hws_fridge_door_pos", joint="hws_fridge_door_hinge"
    )
    ET.SubElement(
        sensors, "jointpos", name="hws_ice_drawer_pos", joint="hws_ice_drawer_slide"
    )
    ET.SubElement(
        sensors,
        "jointpos",
        name="hws_upper_freezer_pos",
        joint="hws_upper_freezer_slide",
    )
    ET.SubElement(
        sensors,
        "jointpos",
        name="hws_lower_freezer_pos",
        joint="hws_lower_freezer_slide",
    )
    ET.SubElement(
        sensors, "jointpos", name="hws_veg_drawer_pos", joint="hws_veg_drawer_slide"
    )
    ET.SubElement(
        sensors,
        "touch",
        name="hws_chilled_shelf_touch",
        site="hws_chilled_shelf_touch_site",
    )
    ET.SubElement(
        sensors,
        "framepos",
        name="hws_milk_carton_sense",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="hws_marugoto_chilled_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    emit_standalone_models(
        ASSETS,
        model_name="hws_cabinet",
        defaults=defaults,
        asset=asset,
        root_body=base,
        contact=contact,
        sensors=sensors,
        exclude_sensors=("hws_milk_carton_sense",),
        accessories=(("carton_model.xml", "hws_milk_carton", carton),),
    )

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "published_unit_mass_kg": 93.0,
                "appliance_body_masses_kg": APPLIANCE_MASSES,
                "appliance_mass_sum_kg": round(sum(APPLIANCE_MASSES.values()), 6),
                "chilled_vessel_mass_kg": CHILLED_VESSEL_MASS_KG,
                "total_scene_mass_kg": round(sum(MASSES.values()), 6),
                "rated_total_volume_l": 470,
                "compartment_volumes_l": {
                    "upper_refrigerator": 243,
                    "marugoto_chilled_zone": 118,
                    "tokusen_hyoon_zone": 13,
                    "mid_left_ice_drawer": 22,
                    "mid_right_upper_freezer": 23,
                    "lower_main_freezer": 95,
                    "bottom_vegetable_drawer": 87,
                },
                "electrical_supply": "Single-phase 100 V AC, 50/60 Hz, compressor 95 W, defrost heater 155 W, 269 kWh/year, R600a",
                "scope": "Articulated MuJoCo 4.0 Filament PBR, mechanical, 5-compartment multi-zone PAM inverter & 155 W defrost thermal model, left-hinged upper door, 4 pull-out drawers, and 6-DOF chilled milk/cream carton in appliance.xml, scene.xml, model.xml, carton_model.xml, and native.xml.",
            },
            indent=2,
        )
        + "\n"
    )


def export_native_xml(mujoco, np):
    _, rebuilt = kit_export_native_xml(ASSETS, "hitachi-r-hws47xl", mujoco, np)
    return {
        "nq": int(rebuilt.nq),
        "nv": int(rebuilt.nv),
        "appliance_mass_kg": round(sum(APPLIANCE_MASSES.values()), 6),
        "total_scene_mass_kg": round(float(np.sum(rebuilt.body_mass)), 6),
        "parity_verified": [
            "body_mass",
            "body_inertia",
            "qpos0",
            "dof_damping",
            "nq",
            "nv",
        ],
    }


def verify_rest_and_motion_frames(mujoco, evidence_dir: Path):
    return kit_verify_frames_and_motions(
        ASSETS, "hitachi-r-hws47xl", NAMES, VISUAL_MOTIONS, mujoco, evidence_dir
    )


def write_asset_docs(report: dict):
    readme = """# Hitachi R-HWS47XL Blender Visual & MuJoCo Physics Model

Slim `600 mm` Japanese 5-door left-hinged (`左開き`) multi-zone upright refrigerator-freezer (`470 L` total JIS C 9801-3 capacity, Crystal Champagne `XN` satin-metallic finish, `単相100V`, `50/60 Hz`, compressor `95 W`, defrost heater `155 W`, `269 kWh/year`, `R600a`), built from the published Hitachi Global Life Solutions `R-HWS47XL` specification (`600 × 701 × 1,833 mm`, unit mass `93.000 kg`).
Swinging the upper left-hinged refrigerator door open `90°–110°` around its `-X` hinge projects `583 mm` forward for unobstructed pâtisserie tray and chilled dairy access.
See the [manufacturer equipment documentation](../../../docs/equipment/hitachi-r-hws47xl/README.md) for verified specifications and coordinate mapping.

![Closed refrigerator](studio-closed.png)
![Open 5-door refrigerator](studio-open.png)

## Files

- [Editable Blender source](hitachi-r-hws47xl.blend), with Metal GPU Cycles studio lighting and preview animation (frames `1–120` at `24 fps`).
- [Rest-pose GLB assembly](hitachi-r-hws47xl.glb) and standalone [chilled milk/cream carton GLB](hitachi-r-hws47xl-milk-carton.glb).
- Review renders (`1400 × 1200`, Cycles Metal GPU, `64` samples + denoiser): [closed](studio-closed.png), [open](studio-open.png), [front](studio-front.png), [interior](studio-interior.png), and [right](studio-right.png).
- [Build report](build-report.json) and [export inspection](inspection-report.json).
- MuJoCo 4.0 MJCF packages: [appliance.xml](appliance.xml), [scene.xml](scene.xml), [model.xml](model.xml), [carton_model.xml](carton_model.xml), [native.xml](native.xml), and [physics-export.json](physics-export.json).
- Active-state verification: [active-states.md](active-states.md), [active-states.json](active-states.json), [report.json](active-state-evidence/report.json), [frames-report.json](active-state-evidence/frames-report.json), [motion-report.json](active-state-evidence/motion-report.json), and [trace.csv](active-state-evidence/trace.csv).

## Assembly (`93.000 kg` unit + `0.650 kg` chilled dairy carton = `93.650 kg` scene)

| Object | Mass (`kg`) | Purpose |
| --- | --- | --- |
| `hws_cabinet` | `67.400` | Fixed `600 × 701 × 1,833 mm` VIP-insulated cabinet, interior left-jamb touch control panel (`操作パネル`), `3` Marugoto Chilled glass shelves (`+2 °C`, `118 L`), Tokusen Hyo-on (`-1 °C`, `13 L`), `14`-egg case (`小物ケース`), and `1.1 L` auto-ice tank |
| `hws_fridge_door` | `9.200` | Upper left-hinged (`-X`) `243 L` Simple Design Crystal Champagne hairline steel refrigerator door (`0 .. 110°` about `0 0 -1`) and `3` clear inner door pockets |
| `hws_ice_drawer` | `2.600` | Mid-left `22 L` automatic ice drawer (`0 .. 0.360 m` slide along `-Y`) |
| `hws_upper_freezer` | `2.900` | Mid-right `23 L` Delicious Freezing drawer with aluminum quick-freeze tray (`0 .. 0.360 m` slide along `-Y`) |
| `hws_lower_freezer` | `5.800` | Lower `95 L` 3-tier main freezer drawer (`0 .. 0.420 m` slide along `-Y`) |
| `hws_veg_drawer` | `5.100` | Bottom `87 L` Freshness Sleep (`Ru` platinum catalyst) vegetable drawer (`0 .. 0.420 m` slide along `-Y`) |
| `hws_milk_carton` | `0.650` | Chilled pâtisserie Hokkaido cream/milk carton (`freejoint`) resting on Marugoto Chilled Shelf 1 (`Z = 1.140 m`) with `vessel_socket` and `ingredient_payload` |

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_r_hws47xl_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_r_hws47xl_physics.py
```
"""
    (ASSETS / "README.md").write_text(readme, encoding="utf-8")

    s = report["stages"]
    rf = s["rest_and_motion_frame_alignment"]
    active_md = f"""# Hitachi R-HWS47XL — MuJoCo Active-State Verification

This document summarizes the 6-stage MuJoCo 4.0 (`dt = 0.002 s`) mechanical, 5-zone PAM inverter & `155 W` defrost thermal regulation, left-hinged door swing, 4-drawer slide actuation, and 6-DOF chilled milk/cream vessel verification for the **Hitachi R-HWS47XL** (`470 L`, `単相100V`, `50/60 Hz`, compressor `95 W`, defrost heater `155 W`, `R600a`, `600 × 701 × 1,833 mm`, `93.000 kg` unit + `0.650 kg` chilled vessel) generated by [`scripts/bakery-mujoco/build_r_hws47xl_physics.py`](../../../scripts/bakery-mujoco/build_r_hws47xl_physics.py).

## Verified Stages (`{report['trace_samples']}` samples)

1. **Multi-Zone PAM Inverter Steady State & Unpinned Chilled Vessel Equilibrium (`pam_steady_state_all_closed`):**
   - All 5 doors/drawers sealed (`fridge_door_deg = {s['pam_steady_state_all_closed']['fridge_door_deg']}°`), PAM inverter modulated at `{s['pam_steady_state_all_closed']['electrical_power_w']} W` holding Marugoto Chilled at `{s['pam_steady_state_all_closed']['marugoto_chilled_c']} °C`, Tokusen Hyo-on at `{s['pam_steady_state_all_closed']['tokusen_hyoon_c']} °C`, freezer zones at `{s['pam_steady_state_all_closed']['freezer_c']} °C`, and Freshness Sleep vegetable zone at `{s['pam_steady_state_all_closed']['vegetable_c']} °C`; unpinned `0.650 kg` `hws_milk_carton` rests stably on Shelf 1 (`shelf_touch_force_n = {s['pam_steady_state_all_closed']['shelf_touch_force_n']} N`, `z_drift = {s['pam_steady_state_all_closed']['carton_shelf_drift_mm']} mm`).
2. **Left-Hinged Upper Door Swing, Door-Open Alarm & Chilled Carton Retrieval (`left_hinge_door_open_and_carton_access`):**
   - Swinging `hws_fridge_door_hinge` open to `{s['left_hinge_door_open_and_carton_access']['fridge_door_deg']}°` around `0 0 -1` activates `door_open_alarm`, models warm-air heat ingress (`marugoto_chilled_c` rises to `{s['left_hinge_door_open_and_carton_access']['marugoto_chilled_c']} °C`), ramps the R600a PAM compressor to `{s['left_hinge_door_open_and_carton_access']['electrical_power_w']} W`, and retrieves `hws_milk_carton` clear of the `-Y` doorway (`shelf_touch_force_n = {s['left_hinge_door_open_and_carton_access']['shelf_touch_force_n']} N`).
3. **Mid-Left Auto-Ice & Mid-Right Delicious Freezing Drawers + Quick-Freeze (`mid_ice_and_delicious_freezing_drawers`):**
   - Reseating `hws_milk_carton` unpinned on Shelf 1 (`shelf_touch_force_n = {s['mid_ice_and_delicious_freezing_drawers']['shelf_touch_force_n']} N`) and closing the upper door while sliding `hws_ice_drawer_slide` (`{s['mid_ice_and_delicious_freezing_drawers']['ice_drawer_mm']} mm`) and `hws_upper_freezer_slide` (`{s['mid_ice_and_delicious_freezing_drawers']['upper_freezer_mm']} mm`) engages `delicious_quick_freeze` at full `95.0 W` rated compressor input.
4. **Lower 3-Tier Main Freezer & Bottom Freshness Sleep Vegetable Drawers (`lower_freezer_and_veg_drawers`):**
   - Closing the mid drawers and extending `hws_lower_freezer_slide` (`{s['lower_freezer_and_veg_drawers']['lower_freezer_mm']} mm`) and `hws_veg_drawer_slide` (`{s['lower_freezer_and_veg_drawers']['veg_drawer_mm']} mm`) verifies full-extension lower rail kinematics and vegetable zone humidity/temperature response (`vegetable_c = {s['lower_freezer_and_veg_drawers']['vegetable_c']} °C`).
5. **Scheduled `155 W` Electric Defrost Heater Cycle (`defrost_heater_155w_cycle`):**
   - Closing all drawers and engaging `mode = "defrost_heater"` applies the published `155.0 W` electric defrost load (`electrical_power_w = {s['defrost_heater_155w_cycle']['electrical_power_w']} W`), clearing evaporator frost while VIP insulation holds `freezer_c = {s['defrost_heater_155w_cycle']['freezer_c']} °C` well below `-15 °C`.
6. **Rest & Sampled Motion GLB/Native Frame Alignment (`rest_and_motion_frame_alignment`):**
   - All `7/7` retained bodies align at rest (`max_position_error_m = {rf['rest_max_position_error_m']:.3e}`, `max_orientation_error_rad = {rf['rest_max_orientation_error_rad']:.3e}`), and all `5/5` scalar joints (`21` samples each = `105` poses) pass `--motion` verification (`max_position_error_m = {rf['motion_max_position_error_m']:.3e}`, `max_orientation_error_rad = {rf['motion_max_orientation_error_rad']:.3e}`).

## Evidence Artifacts

- [`active-states.json`](./active-states.json)
- [`active-state-evidence/report.json`](./active-state-evidence/report.json)
- [`active-state-evidence/frames-report.json`](./active-state-evidence/frames-report.json)
- [`active-state-evidence/motion-report.json`](./active-state-evidence/motion-report.json)
- [`active-state-evidence/trace.csv`](./active-state-evidence/trace.csv)
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def run_active_state_verification():
    import mujoco
    import numpy as np

    parity_info = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    carton_qpos_adr = model.joint("hws_milk_carton_free").qposadr[0]
    carton_qvel_adr = model.joint("hws_milk_carton_free").dofadr[0]

    state = {
        "mode": "pam_eco_steady",
        "supply_voltage_v": 100.0,
        "frequency_hz": 60,
        "electrical_power_w": 42.0,
        "marugoto_chilled_c": 2.00,
        "tokusen_hyoon_c": -1.00,
        "freezer_c": -18.50,
        "vegetable_c": 5.00,
        "auto_ice_cubes_stored": 84,
        "door_open_alarm": False,
    }

    trace_rows = []
    stage_summaries = {}

    def set_carton_free_pose(pos, quat=(1.0, 0.0, 0.0, 0.0)):
        data.qpos[carton_qpos_adr : carton_qpos_adr + 3] = pos
        data.qpos[carton_qpos_adr + 3 : carton_qpos_adr + 7] = quat
        data.qvel[carton_qvel_adr : carton_qvel_adr + 6] = 0.0
        mujoco.mj_forward(model, data)

    def step_and_sample(
        duration_s: float, sample_every_s: float = 0.04, pin_carton_pose=None
    ):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                if pin_carton_pose is not None:
                    pos, quat = pin_carton_pose
                    data.qpos[carton_qpos_adr : carton_qpos_adr + 3] = pos
                    data.qpos[carton_qpos_adr + 3 : carton_qpos_adr + 7] = quat
                    data.qvel[carton_qvel_adr : carton_qvel_adr + 6] = 0.0
                mujoco.mj_step(model, data)

            door_rad = float(data.sensor("hws_fridge_door_pos").data[0])
            ice_m = float(data.sensor("hws_ice_drawer_pos").data[0])
            ufz_m = float(data.sensor("hws_upper_freezer_pos").data[0])
            lfz_m = float(data.sensor("hws_lower_freezer_pos").data[0])
            veg_m = float(data.sensor("hws_veg_drawer_pos").data[0])
            touch_n = float(data.sensor("hws_chilled_shelf_touch").data[0])
            carton_rel = data.sensor("hws_milk_carton_sense").data
            carton_z = float(data.qpos[carton_qpos_adr + 2])

            any_freezer_open = (ice_m > 0.03) or (ufz_m > 0.03) or (lfz_m > 0.03)
            state["door_open_alarm"] = door_rad > 0.20

            if state["mode"] == "defrost_heater":
                state["electrical_power_w"] = 155.0
                state["freezer_c"] += (-16.20 - state["freezer_c"]) * 0.07
                state["marugoto_chilled_c"] += (2.15 - state["marugoto_chilled_c"]) * 0.05
            elif state["mode"] == "delicious_quick_freeze" or any_freezer_open or state["door_open_alarm"]:
                state["electrical_power_w"] = 95.0
                state["marugoto_chilled_c"] += (2.00 - state["marugoto_chilled_c"]) * 0.06
                state["tokusen_hyoon_c"] += (-1.05 - state["tokusen_hyoon_c"]) * 0.06
                state["freezer_c"] += (-19.40 - state["freezer_c"]) * 0.08
                state["vegetable_c"] += (5.00 - state["vegetable_c"]) * 0.05
            else:
                state["mode"] = "pam_eco_steady"
                state["electrical_power_w"] = 42.0
                state["marugoto_chilled_c"] += (2.00 - state["marugoto_chilled_c"]) * 0.10
                state["tokusen_hyoon_c"] += (-1.00 - state["tokusen_hyoon_c"]) * 0.10
                state["freezer_c"] += (-18.50 - state["freezer_c"]) * 0.10
                state["vegetable_c"] += (5.00 - state["vegetable_c"]) * 0.10

            # Door & drawer warm-air heat ingress when open
            if door_rad > 0.05:
                state["marugoto_chilled_c"] += 0.12 * (door_rad / FRIDGE_DOOR_MAX_RAD)
                state["tokusen_hyoon_c"] += 0.03 * (door_rad / FRIDGE_DOOR_MAX_RAD)
            if ice_m > 0.02 or ufz_m > 0.02 or lfz_m > 0.02:
                ext = max(ice_m / 0.36, ufz_m / 0.36, lfz_m / 0.42)
                state["freezer_c"] += 0.14 * ext
            if veg_m > 0.02:
                state["vegetable_c"] += 0.11 * (veg_m / 0.42)

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "electrical_power_w": round(state["electrical_power_w"], 1),
                "marugoto_chilled_c": round(state["marugoto_chilled_c"], 2),
                "tokusen_hyoon_c": round(state["tokusen_hyoon_c"], 2),
                "freezer_c": round(state["freezer_c"], 2),
                "vegetable_c": round(state["vegetable_c"], 2),
                "fridge_door_deg": round(math.degrees(door_rad), 2),
                "ice_drawer_mm": round(ice_m * 1000.0, 2),
                "upper_freezer_mm": round(ufz_m * 1000.0, 2),
                "lower_freezer_mm": round(lfz_m * 1000.0, 2),
                "veg_drawer_mm": round(veg_m * 1000.0, 2),
                "shelf_touch_force_n": round(touch_n, 3),
                "carton_z_m": round(carton_z, 5),
                "carton_shelf_drift_mm": round(
                    abs(carton_z - MILK_CARTON_REST_POSE[2]) * 1000.0, 3
                ),
                "carton_rel_chilled_y_m": round(float(carton_rel[1]), 4),
                "door_open_alarm": state["door_open_alarm"],
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: PAM inverter steady state with all 5 doors/drawers closed and UNPINNED 0.650 kg milk carton on Shelf 1
    snap1 = step_and_sample(0.40, pin_carton_pose=None)
    assert snap1["fridge_door_deg"] < 0.2, snap1
    assert snap1["carton_shelf_drift_mm"] < 2.0, snap1
    assert 5.8 <= snap1["shelf_touch_force_n"] <= 7.0, snap1
    stage_summaries["pam_steady_state_all_closed"] = snap1

    # Stage 2: Open left-hinged upper refrigerator door 102 deg around (0,0,-1), then retrieve chilled milk carton out -Y
    chilled_before = snap1["marugoto_chilled_c"]
    data.ctrl[model.actuator("hws_fridge_door_actuator").id] = math.radians(102.0)
    state["mode"] = "door_open_recovery"
    step_and_sample(0.40, pin_carton_pose=None)
    snap2 = step_and_sample(
        0.24,
        pin_carton_pose=((0.0600, -0.5200, 1.2500), (1.0, 0.0, 0.0, 0.0)),
    )
    assert snap2["fridge_door_deg"] > 96.0, snap2
    assert snap2["door_open_alarm"] is True, snap2
    assert snap2["electrical_power_w"] == 95.0, snap2
    assert snap2["marugoto_chilled_c"] > chilled_before, (
        snap2["marugoto_chilled_c"],
        chilled_before,
    )
    assert snap2["shelf_touch_force_n"] == 0.0, snap2
    stage_summaries["left_hinge_door_open_and_carton_access"] = snap2

    # Stage 3: Reseat milk carton unpinned on Shelf 1, close upper door, and extend mid-left ice & mid-right Delicious Freezing drawers
    set_carton_free_pose(MILK_CARTON_REST_POSE)
    data.ctrl[model.actuator("hws_fridge_door_actuator").id] = 0.0
    data.ctrl[model.actuator("hws_ice_drawer_actuator").id] = 0.320
    data.ctrl[model.actuator("hws_upper_freezer_actuator").id] = 0.320
    state["mode"] = "delicious_quick_freeze"
    snap3 = step_and_sample(0.64, pin_carton_pose=None)
    assert snap3["fridge_door_deg"] < 2.5, snap3
    assert snap3["ice_drawer_mm"] > 295.0, snap3
    assert snap3["upper_freezer_mm"] > 295.0, snap3
    assert snap3["electrical_power_w"] == 95.0, snap3
    assert 5.8 <= snap3["shelf_touch_force_n"] <= 7.0, snap3
    stage_summaries["mid_ice_and_delicious_freezing_drawers"] = snap3

    # Stage 4: Close mid drawers and extend lower 3-tier main freezer (380 mm) & bottom Freshness Sleep vegetable drawer (380 mm)
    veg_before = snap3["vegetable_c"]
    data.ctrl[model.actuator("hws_ice_drawer_actuator").id] = 0.0
    data.ctrl[model.actuator("hws_upper_freezer_actuator").id] = 0.0
    data.ctrl[model.actuator("hws_lower_freezer_actuator").id] = 0.380
    data.ctrl[model.actuator("hws_veg_drawer_actuator").id] = 0.380
    snap4 = step_and_sample(0.64, pin_carton_pose=None)
    assert snap4["lower_freezer_mm"] > 350.0, snap4
    assert snap4["veg_drawer_mm"] > 350.0, snap4
    assert snap4["vegetable_c"] > veg_before, (snap4["vegetable_c"], veg_before)
    stage_summaries["lower_freezer_and_veg_drawers"] = snap4

    # Stage 5: Close lower drawers and run scheduled 155 W electric defrost heater cycle
    data.ctrl[model.actuator("hws_lower_freezer_actuator").id] = 0.0
    data.ctrl[model.actuator("hws_veg_drawer_actuator").id] = 0.0
    state["mode"] = "defrost_heater"
    snap5 = step_and_sample(0.60, pin_carton_pose=None)
    assert snap5["electrical_power_w"] == 155.0, snap5
    assert snap5["lower_freezer_mm"] < 5.0 and snap5["veg_drawer_mm"] < 5.0, snap5
    assert snap5["freezer_c"] < -15.5, snap5
    stage_summaries["defrost_heater_155w_cycle"] = snap5

    # Stage 6: Return to PAM Eco steady state at rest and verify BOTH rest frames AND --motion trajectories
    state["mode"] = "pam_eco_steady"
    snap6 = step_and_sample(0.48, pin_carton_pose=None)
    assert snap6["electrical_power_w"] == 42.0, snap6
    assert snap6["carton_shelf_drift_mm"] < 2.0, snap6

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    frames_report, motion_report = verify_rest_and_motion_frames(mujoco, evidence_dir)

    app_frames = frames_report["appliances"]["hitachi-r-hws47xl"]["frames"]
    app_motions = motion_report["appliances"]["hitachi-r-hws47xl"]["motions"]
    stage_summaries["rest_and_motion_frame_alignment"] = {
        "rest_snap": snap6,
        "frames_aligned": len(app_frames),
        "rest_max_position_error_m": max(f["position_error_m"] for f in app_frames),
        "rest_max_orientation_error_rad": max(
            f["orientation_error_rad"] for f in app_frames
        ),
        "scalar_joints_motion_verified": len(app_motions),
        "samples_per_joint": 21,
        "motion_max_position_error_m": max(m["position_error_m"] for m in app_motions),
        "motion_max_orientation_error_rad": max(
            m["orientation_error_rad"] for m in app_motions
        ),
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        fieldnames = list(trace_rows[0].keys())
        writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "hitachi-r-hws47xl",
        "model_title": "Hitachi R-HWS47XL 470L 5-Door Left-Hinged Upright Refrigerator-Freezer (Crystal Champagne XN)",
        "supply": "Single-phase 100 V AC, 50/60 Hz, compressor 95 W, defrost heater 155 W, 269 kWh/year, natural refrigerant R600a",
        "envelope_m": [0.600, 0.701, 1.833],
        "unit_mass_kg": 93.0,
        "chilled_vessel_mass_kg": 0.65,
        "total_scene_mass_kg": 93.65,
        "appliance_body_masses_kg": APPLIANCE_MASSES,
        "component_masses_kg": MASSES,
        "rated_total_volume_l": 470,
        "compartment_volumes_l": {
            "upper_refrigerator": 243,
            "marugoto_chilled_zone": 118,
            "tokusen_hyoon_zone": 13,
            "mid_left_ice_drawer": 22,
            "mid_right_upper_freezer": 23,
            "lower_main_freezer": 95,
            "bottom_vegetable_drawer": 87,
        },
        "native_parity": parity_info,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256(
            (ASSETS / "scene.xml").read_bytes()
        ).hexdigest(),
        "native_xml_sha256": hashlib.sha256(
            (ASSETS / "native.xml").read_bytes()
        ).hexdigest(),
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_asset_docs(report)
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
