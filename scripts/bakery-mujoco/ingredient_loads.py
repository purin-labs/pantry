"""Author appliance geometry for the shared Rust/MuJoCo runtime."""

from dataclasses import dataclass


import mujoco


@dataclass(frozen=True)
class Port:
    vessel: str
    radius_m: float
    bottom_m: float


PORTS = {
    "victoria-arduino-eagle-one-2g": Port("eo_left_portafilter", 0.025, -0.008),
    "victoria-arduino-e1-prima": Port("e1p_portafilter", 0.0288, 0.005),
    "la-marzocco-linea-classic-s-2g": Port("lcs_left_portafilter", 0.025, -0.008),
    "aicoh-ms-30": Port("ms_bowl", 0.059, 0.004),
    "hobart-hl200": Port("hl_bowl", 0.042, 0.002),
    "maruzen-mbco-5e": Port("mbco_tray", 0.15, 0.012),
    "hoshizaki-rt-120snj": Port("rt_container", 0.07, -0.04),
    "winterhalter-uc-l": Port("ucl_wash_rack", 0.2, 0.02),
    "ohaus-ranger-3000": Port("ranger_weighing_pan", 0.08, 0.005),
    "waring-wsg60": Port("wsg_bowl", 0.045, 0.035),
    "vitamix-quiet-one": Port("tqo_container", 0.05, 0.045),
    "severin-sm-3587": Port("sm3587_jug", 0.06, 0.005),
    "maruzen-mih-02c": Port("ih_pan", 0.094, 0.006),
    "vollrath-59500p": Port("ih_pan", 0.094, 0.006),
}


def add_payload_geometry(spec, name):
    port = PORTS[name]
    body = spec.body(port.vessel).add_body(name="ingredient_payload")
    body.mass = 1e-9
    body.inertia = (1e-12, 1e-12, 1e-12)
    body.explicitinertial = True
    body.add_geom(
        name="ingredient_surface",
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        size=(port.radius_m, 0.001, 0),
        pos=(0, 0, port.bottom_m),
        rgba=(0.75, 0.58, 0.30, 0),
        contype=0,
        conaffinity=0,
        group=2,
        mass=0,
    )
