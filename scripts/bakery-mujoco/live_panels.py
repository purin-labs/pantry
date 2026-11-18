"""Author appliance geometry for the shared Rust/MuJoCo runtime."""

from dataclasses import dataclass


import mujoco


import numpy as np


from ingredient_loads import add_payload_geometry


from rack_cleaning import add_geometry as add_cleaning_geometry


from storage_slots import add_geometry as add_storage_geometry


@dataclass(frozen=True)
class Readout:
    name: str
    body: str
    origin: tuple
    angles: tuple
    width: float
    height: float
    slots: int


READOUTS = {
    "victoria-arduino-eagle-one-2g": (),
    "la-marzocco-linea-classic-s-2g": (
        Readout("left_timer", "lcs_machine", (-0.12, -0.239, 0.470), (90,0,0), 0.031, 0.016, 2),
        Readout("right_timer", "lcs_machine", (0.12, -0.239, 0.470), (90,0,0), 0.031, 0.016, 2),
    ),
    "maruzen-mbco-5e": (
        Readout(
            "temperature",
            "mbco_oven",
            (0.343, -0.401, 0.573),
            (90, 0, 0),
            0.052,
            0.015,
            3,
        ),
        Readout(
            "timer", "mbco_oven", (0.343, -0.401, 0.535), (90, 0, 0), 0.052, 0.015, 5
        ),
        Readout(
            "program", "mbco_oven", (0.343, -0.401, 0.474), (90, 0, 0), 0.052, 0.015, 4
        ),
    ),
    "aicoh-ms-30": (
        Readout("timer", "ms_mixer", (0, -0.354, 1.323), (90, 0, 0), 0.094, 0.030, 5),
    ),
    "hobart-hl200": (
        Readout(
            "timer", "hl_mixer", (0.149, -0.027, 0.682), (90, 0, 90), 0.049, 0.016, 5
        ),
    ),
    "hoshizaki-rt-120snj": (
        Readout(
            "temperature",
            "rt_cabinet",
            (-0.466, -0.302, 0.683),
            (90, 0, 0),
            0.058,
            0.024,
            4,
        ),
    ),
    "vitamix-quiet-one": (
        Readout(
            "timer", "tqo_blender", (0, -0.1215, 0.1175), (90, 0, 0), 0.065, 0.013, 5
        ),
    ),
    "severin-sm-3587": (
        Readout(
            "temperature",
            "sm3587_milk_mixer",
            (0, -0.0855, 0.060),
            (90, 0, 0),
            0.026,
            0.018,
            3,
        ),
    ),
    "vollrath-59500p": (
        Readout(
            "setting", "vp_hob", (0.004, -0.1625, 0.0655), (24.4, 0, 0), 0.047, 0.020, 3
        ),
    ),
    "ohaus-ranger-3000": (
        Readout(
            "weight",
            "ranger_scale",
            (-0.007, -0.1005, 0.081),
            (29, 0, 0),
            0.120,
            0.027,
            7,
        ),
        Readout(
            "zero",
            "ranger_scale",
            (-0.072, -0.0944, 0.0840),
            (29, 0, 0),
            0.006,
            0.005,
            1,
        ),
        Readout(
            "unit",
            "ranger_scale",
            (0.057, -0.1057, 0.0782),
            (29, 0, 0),
            0.004,
            0.005,
            1,
        ),
    ),
    "winterhalter-uc-l": (
        Readout(
            "temperature",
            "ucl_dishwasher",
            (0.041, -0.321, 0.779),
            (90, 0, 0),
            0.117,
            0.044,
            7,
        ),
    ),
    "maruzen-mih-02c": (),
    # The WSG60 reference has buttons, with no electronic readout or status lamp.
    "waring-wsg60": (),
}


STROKES = {
    "a": (0, 0.40, 0.32, 0.055),
    "b": (0.34, 0.21, 0.055, 0.18),
    "c": (0.34, -0.21, 0.055, 0.18),
    "d": (0, -0.40, 0.32, 0.055),
    "e": (-0.34, -0.21, 0.055, 0.18),
    "f": (-0.34, 0.21, 0.055, 0.18),
    "g": (0, 0, 0.32, 0.055),
    "h": (0, -0.30, 0.055, 0.055),
    "i": (0, 0.25, 0.055, 0.055),
}


def quaternion(angles):
    result = np.zeros(4)
    mujoco.mju_euler2Quat(result, np.radians(angles), "XYZ")
    return result


def model_spec(path, appliance):
    spec = mujoco.MjSpec.from_file(str(path))
    add_payload_geometry(spec, appliance)
    add_storage_geometry(spec, appliance)
    if appliance == "winterhalter-uc-l":
        add_cleaning_geometry(spec)
    if appliance == "maruzen-mbco-5e":
        spec.worldbody.add_geom(
            name="mbco_receiving_bench",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            pos=(1.2, -0.9, 0.30),
            size=(0.35, 0.45, 0.03),
            rgba=(0.3, 0.35, 0.38, 1),
            contype=1,
            conaffinity=1,
        )
    for field in READOUTS[appliance]:
        body = spec.body(field.body).add_body(
            name=f"live_{field.name}", pos=field.origin, quat=quaternion(field.angles)
        )
        body.add_geom(
            name=f"live_{field.name}_back",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            size=(field.width / 2, field.height / 2, 0.0003),
            rgba=(0.008, 0.012, 0.015, 1),
            contype=0,
            conaffinity=0,
            group=2,
            mass=0,
        )
        cell = field.width / field.slots
        for slot in range(field.slots):
            for segment, (x, y, w, h) in STROKES.items():
                body.add_geom(
                    name=f"live_{field.name}_{slot}_{segment}",
                    type=mujoco.mjtGeom.mjGEOM_BOX,
                    pos=(
                        (slot - (field.slots - 1) / 2 + x) * cell,
                        y * field.height,
                        0.0007,
                    ),
                    size=(w * cell, h * field.height, 0.00015),
                    rgba=(0.015, 0.02, 0.02, 1),
                    contype=0,
                    conaffinity=0,
                    group=2,
                    mass=0,
                )
    if appliance == "maruzen-mih-02c":
        spec.material("visual_MIH unlit indicator").rgba = (0, 0, 0, 0)
        for name, x in (("power", 0.030), ("hold", -0.006)):
            spec.body("mih_hob").add_geom(
                name="live_" + name + "_lamp",
                type=mujoco.mjtGeom.mjGEOM_SPHERE,
                pos=(x, -0.2192, 0.069),
                size=(0.0022, 0, 0),
                rgba=(0.005, 0.025, 0.008, 1),
                contype=0,
                conaffinity=0,
                group=2,
                mass=0,
            )
    elif appliance == "ohaus-ranger-3000":
        spec.material("visual_Ranger red LED segments").rgba = (0, 0, 0, 0)
        indicator = spec.body("ranger_scale").add_body(
            name="live_stable",
            pos=(-0.073, -0.1092, 0.0758),
            quat=quaternion((29, 0, 0)),
        )
        for index, angle in enumerate((0, 60, 120)):
            indicator.add_geom(
                name=f"live_stable_{index}",
                type=mujoco.mjtGeom.mjGEOM_BOX,
                size=(0.002, 0.0003, 0.00015),
                quat=quaternion((0, 0, angle)),
                rgba=(0.02, 0.01, 0.01, 1),
                contype=0,
                conaffinity=0,
                group=2,
                mass=0,
            )
    elif appliance == "vollrath-59500p":
        spec.body("live_setting").add_geom(
            name="live_temperature_mode",
            type=mujoco.mjtGeom.mjGEOM_SPHERE,
            pos=(0.045, 0, 0.0007),
            size=(0.0025, 0, 0),
            rgba=(0.02, 0.025, 0.02, 1),
            contype=0,
            conaffinity=0,
            group=2,
            mass=0,
        )
    return spec
