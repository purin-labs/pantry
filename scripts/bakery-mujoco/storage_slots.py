"""Author appliance geometry for the shared Rust/MuJoCo runtime."""

import mujoco


SLOTS = {
    "maruzen-mbco-5e": tuple(f"mbco_slot_{index}" for index in range(1, 6)),
    "hoshizaki-rt-120snj": tuple(
        f"rt_{side}_{level}_storage" for side in ("left", "right") for level in (1, 2)
    ),
}


def add_geometry(spec, name):
    if name not in SLOTS:
        return
    oven = name == "maruzen-mbco-5e"
    # A second empty carrier occupies a slot. It has native mass and contacts.
    position = (-0.1, -0.013, 0.271) if oven else (0.341, 0.0215, 0.566)
    body = spec.worldbody.add_body(name="storage_occupant", pos=position)
    body.add_freejoint(name="storage_occupant_free")
    body.add_geom(
        name="storage_occupant_contact",
        type=mujoco.mjtGeom.mjGEOM_BOX,
        size=(0.2, 0.3, 0.01) if oven else (0.07, 0.11, 0.045),
        pos=(0, 0, 0.009) if oven else (0, 0, 0),
        mass=2 if oven else 1,
        rgba=(0.48, 0.53, 0.55, 1),
        group=2,
        contype=1,
        conaffinity=3,
        friction=(0.6, 0.005, 0.0001),
        solref=(0.004, 1),
        solimp=(0.95, 0.99, 0.001, 0.5, 2),
    )
    if not oven:
        spec.geom("rt_container_contact").conaffinity = 3
