"""Author appliance geometry for the shared Rust/MuJoCo runtime."""

import xml.etree.ElementTree as ET


def add_vessel_contacts(root, body_name):
    """Add support contacts and a receiving bench to an authored free vessel."""
    world = root.find("worldbody")
    body = root.find(f".//body[@name='{body_name}']")
    for geom in body.findall("geom"):
        geom.set("contype", "1")
        geom.set("conaffinity", "1")
    # Closed cylinder is only the outer jug collision envelope. Contents stay contained.
    if body_name == "sm3587_jug":
        ET.SubElement(
            body,
            "geom",
            name="vessel_outer_wall",
            type="cylinder",
            pos="0 0 .035",
            size=".062 .033",
            contype="1",
            conaffinity="1",
            group="3",
        )
    ET.SubElement(
        world,
        "geom",
        name="vessel_receiving_bench",
        type="box",
        pos=".32 0 .09",
        size=".13 .17 .09",
        rgba=".35 .39 .42 1",
        group="2",
        contype="1",
        conaffinity="1",
    )
    # Native seat contacts remain separate from the receiving bench.
    if body_name == "tqo_container":
        seat = root.find(".//geom[@name='tqo_pad_contact']")
    elif body_name == "wsg_bowl":
        seat = root.find(".//geom[@name='wsg_seat']")
    else:
        seat = root.find(".//geom[@name='sm3587_seat_proxy']")
    seat.set("contype", "1")
    seat.set("conaffinity", "1")
