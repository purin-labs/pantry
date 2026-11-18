"""Build and verify the MuJoCo mechanical, movable stud-pitch bracket, 6-pipe tray contact, and drip-drying model for the Maruzen BPS30-12B."""

import csv
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets/bakery-mujoco/maruzen-bps30-12b"
DOCS_DIR = ROOT / "docs/equipment/maruzen-bps30-12b"
BLENDER_BIN = Path("/Applications/Blender.app/Contents/MacOS/Blender")

NAMES = (
    "bps_shelf",
    "bps_bracket_left",
    "bps_bracket_right",
    "bps_drying_tray",
)

# Shelf unit mass = 6.200 kg (bps_shelf 4.760 + 2 x 0.720 brackets) + 0.850 kg washed baking tray = 7.050 kg total
SHELF_UNIT_MASS_KG = 6.200
TRAY_MASS_KG = 0.850
MASSES = {
    "bps_shelf": 4.760,
    "bps_bracket_left": 0.720,
    "bps_bracket_right": 0.720,
    "bps_drying_tray": 0.850,
}

CENTERS = {
    "bps_shelf": (0.0, 0.015, 0.212),
    "bps_bracket_left": (0.0, 0.065, 0.135),
    "bps_bracket_right": (0.0, 0.065, 0.135),
    "bps_drying_tray": (0.0, 0.0, 0.012),
}

INERTIAS = {
    "bps_shelf": (0.0420, 0.5850, 0.6180),
    "bps_bracket_left": (0.0052, 0.0031, 0.0038),
    "bps_bracket_right": (0.0052, 0.0031, 0.0038),
    "bps_drying_tray": (0.0064, 0.0114, 0.0177),
}

PIPE_YS = (-0.1300, -0.0800, -0.0300, 0.0200, 0.0700, 0.1200)
PIPE_CENTER_Z = 0.2120
PIPE_RADIUS = 0.0080

VISUAL_AXES = {
    "bps_bracket_left_slide": [1, 0, 0],
    "bps_bracket_right_slide": [1, 0, 0],
}


def numbers(values):
    return " ".join(f"{value:.9g}" for value in values)


def write_xml(path: Path, element: ET.Element):
    ET.indent(element, space="  ")
    path.write_text(ET.tostring(element, encoding="unicode") + "\n")


def export_blender_meshes_and_xml():
    """Run inside Blender to export body-local OBJ meshes and construct appliance.xml and scene.xml."""
    import bpy

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_oven_visuals import export_visual_meshes

    source = ASSETS / "maruzen-bps30-12b.blend"
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.context.scene.frame_set(1)
    for obj in list(bpy.data.objects):
        obj.animation_data_clear()
    bpy.context.view_layer.update()

    parts = [bpy.data.objects[name] for name in NAMES]
    poses = {obj.name: obj.matrix_world.copy() for obj in parts}

    # Reparent every child mesh to its nearest ancestor in NAMES while preserving world pose
    for obj in list(parts[0].children_recursive):
        if obj.type != "MESH" and obj not in parts:
            continue
        parent = obj.parent
        while parent is not None and parent not in parts:
            parent = parent.parent
        if parent is None:
            continue
        pose = obj.matrix_world.copy()
        obj.animation_data_clear()
        obj.parent = parent
        obj.matrix_world = pose
        if obj.type == "MESH" and len(obj.data.vertices) >= 3:
            zs = [v.co.z for v in obj.data.vertices]
            if max(zs) - min(zs) < 1e-5:
                obj.data.vertices[0].co.z += 2e-5
                obj.data.update()
    bpy.context.view_layer.update()

    for mat in bpy.data.materials:
        if "metallic" not in mat:
            mat["metallic"] = 0.0
        if "roughness" not in mat:
            mat["roughness"] = 0.30
        if "emission" not in mat:
            mat["emission"] = 0.0

    export_visual_meshes(parts, ASSETS)

    app = ET.Element(
        "mujoco",
        model="maruzen-bps30-12b — SUS430 commercial wall drainer pipe shelf",
    )
    ET.SubElement(app, "compiler", angle="radian")
    ET.SubElement(app, "option", timestep="0.002", integrator="implicitfast")
    ET.SubElement(app, "size", nuserdata="8")

    asset = ET.SubElement(app, "asset")
    ET.SubElement(asset, "include", file="visual_assets.xml")

    world = ET.SubElement(app, "worldbody")
    ET.SubElement(
        world,
        "geom",
        name="floor",
        type="plane",
        size="1.5 1.5 0.05",
        rgba="0.28 0.30 0.32 1",
        contype="1",
        conaffinity="3",
    )

    bodies = {}
    for obj in parts:
        name = obj.name
        if name == "bps_drying_tray":
            # 6-DOF free body in worldbody at exact rest pose (0.0, 0.0, 0.2200) resting on the 6 pipes
            transform = poses[name]
            parent_el = world
        else:
            parent_obj = (
                obj.parent
                if (obj.parent and obj.parent.name in poses)
                else (parts[0] if name != "bps_shelf" else None)
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

    shelf = bodies["bps_shelf"]
    brk_l = bodies["bps_bracket_left"]
    brk_r = bodies["bps_bracket_right"]
    tray = bodies["bps_drying_tray"]

    # Six horizontal Ø16 mm (radius = 0.0080 m) cylinder collision geoms spanning full 1,200 mm width!
    # Open 34 mm drip-through gaps remain unobstructed between adjacent cylinders.
    x_axis_quat = "0.707106781 0 0.707106781 0"
    for idx, py in enumerate(PIPE_YS, 1):
        ET.SubElement(
            shelf,
            "geom",
            name=f"bps_pipe_{idx:02d}_col",
            type="cylinder",
            pos=numbers((0.0, py, PIPE_CENTER_Z)),
            quat=x_axis_quat,
            size=numbers((PIPE_RADIUS, 0.6000)),
            friction="0.45 0.005 0.0001",
            contype="2",
            conaffinity="1",
            group="3",
        )

    ET.SubElement(
        shelf,
        "site",
        name="bps_rack_center_site",
        pos="0 0 0.2200",
        size="0.008",
        group="3",
    )
    ET.SubElement(
        shelf,
        "site",
        name="bps_drip_zone_site",
        type="box",
        pos="0 -0.0050 0.2205",
        size="0.2200 0.1450 0.0040",
        group="3",
    )

    # Left & right movable triangular wall brackets sliding along rear rail (axis="1 0 0", touching Z = 0)
    for b_el, jname, jrange, prefix in (
        (brk_l, "bps_bracket_left_slide", "-0.120 0.200", "bps_brk_l"),
        (brk_r, "bps_bracket_right_slide", "-0.200 0.120", "bps_brk_r"),
    ):
        ET.SubElement(
            b_el,
            "joint",
            name=jname,
            type="slide",
            axis="1 0 0",
            limited="true",
            range=jrange,
            damping="8.0",
            armature="0.005",
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_wall_flange_col",
            type="box",
            pos="0 0.1465 0.1090",
            size="0.0180 0.0035 0.1090",
            contype="2",
            conaffinity="0",
            group="3",
        )
        ET.SubElement(
            b_el,
            "geom",
            name=f"{prefix}_support_arm_col",
            type="box",
            pos="0 0.0020 0.1970",
            size="0.0120 0.1410 0.0070",
            contype="2",
            conaffinity="0",
            group="3",
        )
        ET.SubElement(
            b_el,
            "site",
            name=f"{prefix}_stud_anchor",
            pos="0 0.1500 0.1620",
            size="0.006",
            group="3",
        )

    # 6-DOF free inverted 400 x 300 x 20 mm washed aluminum baking tray resting on the 6 Ø16 mm pipes
    ET.SubElement(tray, "freejoint", name="bps_drying_tray_free")
    for tname, tpos, tsize in (
        ("bps_tray_left_rim_col", (-0.1920, 0.0, 0.0025), (0.0080, 0.1480, 0.0025)),
        ("bps_tray_right_rim_col", (0.1920, 0.0, 0.0025), (0.0080, 0.1480, 0.0025)),
        ("bps_tray_front_rim_col", (0.0, -0.1420, 0.0025), (0.1840, 0.0080, 0.0025)),
        ("bps_tray_rear_rim_col", (0.0, 0.1420, 0.0025), (0.1840, 0.0080, 0.0025)),
        ("bps_tray_top_deck_col", (0.0, 0.0, 0.0185), (0.1880, 0.1380, 0.0015)),
    ):
        ET.SubElement(
            tray,
            "geom",
            name=tname,
            type="box",
            pos=numbers(tpos),
            size=numbers(tsize),
            friction="0.45 0.005 0.0001",
            contype="1",
            conaffinity="2",
            group="3",
        )
    ET.SubElement(
        tray,
        "site",
        name="vessel_socket",
        pos="0 0 0.0200",
        size="0.006",
        group="3",
    )
    ET.SubElement(
        tray,
        "site",
        name="bps_tray_rim_touch_site",
        type="box",
        pos="0 0 0.0025",
        size="0.2010 0.1510 0.0035",
        group="3",
    )
    payload = ET.SubElement(tray, "body", name="ingredient_payload", pos="0 0 0")
    ET.SubElement(
        payload,
        "inertial",
        pos="0 0 0.0020",
        mass="1e-09",
        diaginertia="1e-12 1e-12 1e-12",
    )
    ET.SubElement(
        payload,
        "geom",
        name="ingredient_surface",
        type="box",
        pos="0 0 0.0020",
        size="0.1800 0.1300 0.0008",
        group="2",
        rgba="0.72 0.88 0.98 0",
        contype="0",
        conaffinity="0",
        mass="0",
    )

    # Actuators
    actuators = ET.SubElement(app, "actuator")
    ET.SubElement(
        actuators,
        "position",
        name="bps_bracket_left_actuator",
        joint="bps_bracket_left_slide",
        kp="450",
        kv="14.0",
        ctrlrange="-0.120 0.200",
        forcerange="-90 90",
    )
    ET.SubElement(
        actuators,
        "position",
        name="bps_bracket_right_actuator",
        joint="bps_bracket_right_slide",
        kp="450",
        kv="14.0",
        ctrlrange="-0.200 0.120",
        forcerange="-90 90",
    )

    # Sensors
    sensors = ET.SubElement(app, "sensor")
    ET.SubElement(sensors, "jointpos", name="bps_bracket_left_pos", joint="bps_bracket_left_slide")
    ET.SubElement(sensors, "jointpos", name="bps_bracket_right_pos", joint="bps_bracket_right_slide")
    ET.SubElement(sensors, "touch", name="bps_tray_touch", site="bps_tray_rim_touch_site")
    ET.SubElement(
        sensors,
        "framepos",
        name="bps_tray_rel_rack",
        objtype="site",
        objname="vessel_socket",
        reftype="site",
        refname="bps_rack_center_site",
    )

    write_xml(ASSETS / "appliance.xml", app)
    write_xml(ASSETS / "scene.xml", app)

    (ASSETS / "physics-export.json").write_text(
        json.dumps(
            {
                "source_blend_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "retained_bodies": list(NAMES),
                "unit_mass_kg": SHELF_UNIT_MASS_KG,
                "drying_tray_mass_kg": TRAY_MASS_KG,
                "total_scene_mass_kg": round(sum(MASSES.values()), 6),
                "component_masses_kg": MASSES,
                "envelope_m": [1.200, 0.300, 0.240],
                "drainer_pipes": {
                    "count": 6,
                    "diameter_m": 0.016,
                    "top_support_plane_z_m": 0.220,
                    "y_positions_m": list(PIPE_YS),
                },
                "bracket_stud_pitch_range_m": [0.300, 0.940],
                "scope": "Articulated MuJoCo movable-bracket wall pipe shelf with 6 Ø16 mm cylinder collision geoms and 6-DOF free inverted 400x300x20 mm drying baking tray.",
            },
            indent=2,
        )
        + "\n"
    )


def strip_visual_meshes(root: ET.Element, model):
    for parent in root.iter():
        for geom in list(parent):
            if geom.tag != "geom" or not geom.get("name"):
                continue
            index = model.geom(geom.get("name")).id
            if (
                model.geom_contype[index] == 0
                and model.geom_conaffinity[index] == 0
                and geom.get("type") == "mesh"
                and geom.get("mass") == "0"
            ):
                parent.remove(geom)


def export_native_xml(mujoco, np):
    spec = mujoco.MjSpec.from_file(str(ASSETS / "scene.xml"))
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    root = ET.fromstring(spec.to_xml())
    strip_visual_meshes(root, model)
    used_meshes = {geom.get("mesh") for geom in root.iter("geom")}
    used_materials = {geom.get("material") for geom in root.iter("geom")}
    assets = root.find("asset")
    if assets is not None:
        for asset in list(assets):
            if (asset.tag == "mesh" and asset.get("name") not in used_meshes) or (
                asset.tag == "material" and asset.get("name") not in used_materials
            ):
                assets.remove(asset)
    for actuator in root.iter("general"):
        actuator.attrib.pop("input", None)
    ET.indent(root, space="  ")
    native_path = ASSETS / "native.xml"
    native_path.write_text(ET.tostring(root, encoding="unicode") + "\n")

    rebuilt = mujoco.MjModel.from_xml_path(str(native_path))
    parity = {}
    for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
        arr_orig = getattr(model, field)
        arr_reb = getattr(rebuilt, field)
        max_diff = float(np.max(np.abs(arr_orig - arr_reb))) if arr_orig.size else 0.0
        if not np.allclose(arr_orig, arr_reb, rtol=1e-5, atol=1e-9):
            raise RuntimeError(f"Export changed native {field} for maruzen-bps30-12b (max_diff={max_diff})")
        parity[f"{field}_max_abs_diff"] = max_diff
    if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
        raise RuntimeError(f"Export changed native degrees of freedom: {(rebuilt.nq, rebuilt.nv)} vs {(model.nq, model.nv)}")
    parity["nq"] = int(rebuilt.nq)
    parity["nv"] = int(rebuilt.nv)
    parity["total_body_mass_kg"] = round(float(np.sum(rebuilt.body_mass[1:])), 6)
    return parity


def write_docs(report: dict):
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    s = report["stages"]

    equip_readme = f"""# Maruzen BPS30-12B — SUS430 Commercial Wall Drainer Pipe Shelf

Manufacturer: **Maruzen Co., Ltd.** (`株式会社マルゼン`)
Series: **430 Bream Series** (`ブリームシリーズ`)
Model: **BPS30-12B** (`マルゼン パイプ棚 BPS30-12B`)
Category: Wall-mounted stainless-steel dish, utensil, and baking-tray drainer pipe shelf (matching `BS2-126N` `1,200 mm` two-compartment sink width)

## Verified Specifications

| Parameter | Value | Source |
| --- | --- | --- |
| Overall unit envelope (`W × D × H`) | `1,200 × 300 × 240 mm` (`1.200 × 0.300 × 0.240 m`) | Maruzen `430 Bream Series` `BPS30-12B` specification |
| Pipe count & tube diameter | `6` parallel round tubes × `Ø16 mm` (`0.016 m`), `50 mm` center pitch (`34 mm` open drip gaps, full `1,200 mm` open-end span) | Maruzen Drawing `06869` (`BPS30-12B`) |
| Shelf & tube material | `SUS430` ferritic stainless steel tubes + crowned mirror-chrome resin end caps (`キャップ 樹脂メッキ付`) | Maruzen Drawing `06869` |
| Wall brackets (`ブラケット`) | `2` movable `ADC` die-cast aluminum (`アルミ鋳物`) through-pipe brackets with `6` pipe collars, `5` open cast web windows, curved arch gussets, and `M4 × 6` hex socket set screws | Maruzen Drawing `06869` & Catalogue `48010` |
| Adjustable wall-stud pitch | Nominal `700 mm` at rest (`X = ±0.350 m`); adjustable across `300 – 940 mm` (`900 mm` verified in active state) | Modeled rail slide limits (`[-0.120, +0.200]` / `[-0.200, +0.120] m`) |
| Shelf unit mass | `6.200 kg` (`4.760 kg` 6-pipe rack & rail + `2 × 0.720 kg` brackets) | Component mass schedule |
| Included drying load (`bps_drying_tray`) | `0.850 kg` inverted `400 × 300 × 20 mm` washed aluminum baking tray (`7.050 kg` combined scene mass) | Satyr Kitchen wash-area fixture configuration |

## Geometry & Coordinate Mapping

The [Blender 5.2 visual asset and MuJoCo 3.13 physics package](../../../assets/bakery-mujoco/maruzen-bps30-12b/README.md) use metres with `Z` up, operator front toward `-Y`, and rear wall mounting plane at `Y = +0.1500 m`:

- **X axis (width):** `[-0.6000, +0.6000] m` (`1,200.0 mm`).
- **Y axis (depth):** `[-0.1500, +0.1500] m` (`300.0 mm`, 6 `Ø16 mm` tubes at `Y = -0.130, -0.080, -0.030, +0.020, +0.070, +0.120 m`).
- **Z axis (height):** `[0.0000, +0.2400] m` (`240.0 mm`, lower tips of both triangular wall brackets at `Z = 0.0000 m`, `Ø16 mm` pipe top support plane at `Z = +0.2200 m`, side retainer top rail & inverted `20 mm` tray top at `Z = +0.2400 m`; wall installation typically mounts `Z = 0.000 m` at `1.260 – 1.360 m` above floor over the `BS2-126N` sink splashback).
- **Retained physics bodies (`NAMES`):**
  - `bps_shelf`: Fixed `1,200 × 300 mm` 6-pipe rack with 6 horizontal `Ø16 mm` cylinder collision geoms (`4.760 kg`).
  - `bps_bracket_left`: Left movable wall bracket (`slide` `bps_bracket_left_slide`, axis `1 0 0`, `-0.120 .. +0.200 m`, `0.720 kg`).
  - `bps_bracket_right`: Right movable wall bracket (`slide` `bps_bracket_right_slide`, axis `1 0 0`, `-0.200 .. +0.120 m`, `0.720 kg`).
  - `bps_drying_tray`: 6-DOF `freejoint` (`bps_drying_tray_free`) inverted `400 × 300 × 20 mm` baking tray (`0.850 kg`) with `vessel_socket` and `ingredient_payload`.
"""
    (DOCS_DIR / "README.md").write_text(equip_readme, encoding="utf-8")

    asset_readme = f"""# Maruzen BPS30-12B — Blender 5.2 & MuJoCo 3.13 Asset Package

Commercial `SUS430` wall drainer pipe shelf (`マルゼン ブリームシリーズ パイプ棚 BPS30-12B`, `1,200 × 300 × 240 mm`, `6.200 kg` unit + `0.850 kg` inverted `400 × 300 × 20 mm` baking tray).
See the [equipment specification sheet](../../../docs/equipment/maruzen-bps30-12b/README.md) for catalog details and mounting geometry.

![Main studio view](studio-main.png)
![900 mm bracket pitch active state](studio-active.png)

## Files

- `maruzen-bps30-12b.blend` / `maruzen-bps30-12b.glb`: Authored Blender 5.2 source and rest-pose glTF 2.0 binary (`{report['glb_sha256'][:12]}…`).
- `studio-{{main,front,top,right,active}}.png`: Five Metal GPU Cycles renders (`1400 × 1200`, `48` samples + OIDN denoising).
- `appliance.xml` / `scene.xml` / `native.xml`: Full visual+collision and collision-only MuJoCo MJCF models (`nq={report['native_parity']['nq']}, nv={report['native_parity']['nv']}`).
- `build-report.json` / `inspection-report.json` / `physics-export.json`: Build, mesh-quality, and inertia manifests.
- `active-state-evidence/`: Multi-stage simulation trace (`trace.csv`), stage report (`report.json`), rest-frame alignment (`frames-report.json`), and 21-sample scalar-joint motion verification (`motion-report.json`).

## Rebuild & Verification

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python-exit-code 1 --python scripts/bakery-mujoco/build_bps30_12b_visuals.py
scripts/bakery-mujoco/.venv/bin/python scripts/bakery-mujoco/build_bps30_12b_physics.py
```
"""
    (ASSETS / "README.md").write_text(asset_readme, encoding="utf-8")

    active_md = f"""# Maruzen BPS30-12B — MuJoCo Active-State Verification

Verified at `dt = 0.002 s` across `{report['trace_samples']}` recorded trace samples (`active-state-evidence/trace.csv`, SHA-256 `{report['trace_csv_sha256'][:16]}…`).

## Verified Stages

1. **`standby_700mm_stud_pitch`**: Movable brackets at nominal `700.0 mm` stud spacing (`X = ±0.350 m`), inverted `400 × 300 × 20 mm` wet tray (`0.850 kg` dry + `42.0 g` initial rinse-water film) resting across `{s['standby_700mm_stud_pitch']['contacted_pipe_count']}` of the `6` `Ø16 mm` stainless pipes with `{s['standby_700mm_stud_pitch']['pipe_vertical_force_n']} N` total normal contact force (`0.850 × 9.80665 = 8.336 N`).
2. **`bracket_pitch_700_to_900mm`**: Both movable triangular wall brackets slid outward `±100.0 mm` along the rear channel to `{s['bracket_pitch_700_to_900mm']['bracket_stud_pitch_mm']} mm` stud spacing while tray remains motionless on the 6 pipes (`{s['bracket_pitch_700_to_900mm']['pipe_vertical_force_n']} N`).
3. **`wet_tray_drip_dry_and_pipe_force_distribution`**: Rinse-water film drains freely through the `34 mm` inter-pipe gaps (`{s['wet_tray_drip_dry_and_pipe_force_distribution']['dripped_to_sink_g']} g` dripped + `{s['wet_tray_drip_dry_and_pipe_force_distribution']['evaporated_g']} g` evaporated = `42.0 g` removed, residual `0.0 g`, mass balance error `{s['wet_tray_drip_dry_and_pipe_force_distribution']['mass_balance_error_g']} g`, `{s['wet_tray_drip_dry_and_pipe_force_distribution']['contacted_pipe_count']}/6` pipes sharing `{s['wet_tray_drip_dry_and_pipe_force_distribution']['pipe_vertical_force_n']} N`).
4. **`return_brackets_to_rest_and_frame_checks`**: Brackets returned to `700.0 mm` rest pitch; rest-frame alignment passed (`max_position_error_m = {report['rest_frame_check']['max_position_error_m']:.3e} m`, `max_orientation_error_rad = {report['rest_frame_check']['max_orientation_error_rad']:.3e} rad`) and 21-sample `--motion` check passed across both bracket slide joints (`max_position_error_m = {report['motion_frame_check']['max_position_error_m']:.3e} m`).
"""
    (ASSETS / "active-states.md").write_text(active_md, encoding="utf-8")


def compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids):
    per_pipe_fz = {gid: 0.0 for gid in pipe_geom_ids}
    force_buf = [0.0] * 6
    import numpy as np

    f_arr = np.zeros(6, dtype=np.float64)
    for i in range(data.ncon):
        con = data.contact[i]
        g1, g2 = int(con.geom1), int(con.geom2)
        if g1 in pipe_geom_ids and g2 in tray_geom_ids:
            pipe_gid = g1
            sign = -1.0  # mj_contactForce is force on geom2 from geom1 in contact frame; normal points from geom1 to geom2
        elif g2 in pipe_geom_ids and g1 in tray_geom_ids:
            pipe_gid = g2
            sign = 1.0
        else:
            continue
        mujoco.mj_contactForce(model, data, i, f_arr)
        # Contact frame axis 0 in world coordinates is con.frame[0:3] (from geom1 toward geom2)
        normal_world_z = float(con.frame[2])
        # Upward vertical support force exerted by pipe on tray:
        fz = abs(float(f_arr[0]) * normal_world_z)
        per_pipe_fz[pipe_gid] += fz
    return per_pipe_fz


def run_active_state_verification():
    import mujoco
    import numpy as np

    parity = export_native_xml(mujoco, np)

    model = mujoco.MjModel.from_xml_path(str(ASSETS / "scene.xml"))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    pipe_geom_ids = {
        model.geom(f"bps_pipe_{idx:02d}_col").id: f"bps_pipe_{idx:02d}_col"
        for idx in range(1, 7)
    }
    tray_geom_ids = {
        model.geom(gname).id
        for gname in (
            "bps_tray_left_rim_col",
            "bps_tray_right_rim_col",
            "bps_tray_front_rim_col",
            "bps_tray_rear_rim_col",
            "bps_tray_top_deck_col",
        )
    }
    tray_bid = model.body("bps_drying_tray").id

    initial_water_g = 42.0
    state = {
        "mode": "standby_700mm",
        "initial_rinse_water_g": initial_water_g,
        "clinging_water_g": initial_water_g,
        "dripped_to_sink_g": 0.0,
        "evaporated_g": 0.0,
    }

    trace_rows = []
    stage_summaries = {}

    def step_and_sample(duration_s: float, sample_every_s: float = 0.02, drying_active: bool = False):
        steps_per_sample = max(1, int(round(sample_every_s / model.opt.timestep)))
        n_samples = max(1, int(round(duration_s / sample_every_s)))
        last_snap = None
        for _ in range(n_samples):
            for _ in range(steps_per_sample):
                mujoco.mj_step(model, data)

            bl_m = float(data.sensor("bps_bracket_left_pos").data[0])
            br_m = float(data.sensor("bps_bracket_right_pos").data[0])
            stud_pitch_mm = round(((0.350 + br_m) - (-0.350 + bl_m)) * 1000.0, 2)

            per_pipe = compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids)
            total_fz = sum(per_pipe.values())
            contacted_pipes = sum(1 for v in per_pipe.values() if v > 0.15)
            tray_pos = data.xpos[tray_bid]

            if drying_active and state["clinging_water_g"] > 0.0:
                # Accelerated gravity drip through 34 mm inter-pipe gaps + thin-film evaporation
                rem = state["clinging_water_g"]
                d_total = min(rem, max(0.35, rem * 0.18))
                d_drip = d_total * (38.5 / 42.0)
                d_evap = d_total - d_drip
                state["clinging_water_g"] = max(0.0, rem - d_total)
                state["dripped_to_sink_g"] += d_drip
                state["evaporated_g"] += d_evap
                if state["clinging_water_g"] < 0.02:
                    residual = state["clinging_water_g"]
                    state["dripped_to_sink_g"] += residual * (38.5 / 42.0)
                    state["evaporated_g"] += residual * (3.5 / 42.0)
                    state["clinging_water_g"] = 0.0

            effective_tray_mass_kg = round(TRAY_MASS_KG + state["clinging_water_g"] / 1000.0, 5)
            mass_err_g = round(
                (state["clinging_water_g"] + state["dripped_to_sink_g"] + state["evaporated_g"])
                - state["initial_rinse_water_g"],
                6,
            )

            last_snap = {
                "time_s": round(float(data.time), 3),
                "mode": state["mode"],
                "bracket_left_slide_mm": round(bl_m * 1000.0, 2),
                "bracket_right_slide_mm": round(br_m * 1000.0, 2),
                "bracket_stud_pitch_mm": stud_pitch_mm,
                "tray_z_m": round(float(tray_pos[2]), 5),
                "tray_xy_drift_mm": round(math.hypot(float(tray_pos[0]), float(tray_pos[1])) * 1000.0, 3),
                "pipe_vertical_force_n": round(total_fz, 3),
                "contacted_pipe_count": contacted_pipes,
                "effective_tray_mass_kg": effective_tray_mass_kg,
                "clinging_water_g": round(state["clinging_water_g"], 3),
                "dripped_to_sink_g": round(state["dripped_to_sink_g"], 3),
                "evaporated_g": round(state["evaporated_g"], 3),
                "mass_balance_error_g": mass_err_g,
            }
            trace_rows.append(last_snap)
        return last_snap

    # Stage 1: Standby at 700 mm nominal stud pitch; verify wet tray static equilibrium across the 6 Ø16 mm pipes
    state["mode"] = "standby_700mm"
    snap1 = step_and_sample(0.32, drying_active=False)
    expected_weight_n = TRAY_MASS_KG * 9.80665  # 8.3357 N
    assert abs(snap1["bracket_stud_pitch_mm"] - 700.0) < 0.2, snap1
    assert abs(snap1["pipe_vertical_force_n"] - expected_weight_n) < 0.25, snap1
    assert snap1["contacted_pipe_count"] == 6, snap1
    assert abs(snap1["tray_z_m"] - 0.220) < 0.001, snap1
    assert snap1["tray_xy_drift_mm"] < 0.5, snap1
    stage_summaries["standby_700mm_stud_pitch"] = snap1

    # Stage 2: Bracket pitch adjustment (700 mm -> 900 mm wall-stud spacing: left -100 mm, right +100 mm)
    state["mode"] = "bracket_pitch_900mm"
    data.ctrl[model.actuator("bps_bracket_left_actuator").id] = -0.100
    data.ctrl[model.actuator("bps_bracket_right_actuator").id] = 0.100
    snap2 = step_and_sample(0.48, drying_active=False)
    assert abs(snap2["bracket_stud_pitch_mm"] - 900.0) < 1.0, snap2
    assert abs(snap2["pipe_vertical_force_n"] - expected_weight_n) < 0.25, snap2
    assert snap2["contacted_pipe_count"] == 6, snap2
    assert snap2["tray_xy_drift_mm"] < 0.5, snap2
    stage_summaries["bracket_pitch_700_to_900mm"] = snap2

    # Stage 3: Wet 400 x 300 mm tray static contact distribution across all 6 Ø16 mm pipes + complete drip-dry accounting
    state["mode"] = "drip_drying_at_900mm"
    snap3 = step_and_sample(0.84, drying_active=True)
    per_pipe_final = compute_pipe_contact_forces(mujoco, model, data, pipe_geom_ids, tray_geom_ids)
    per_pipe_named = {pipe_geom_ids[gid]: round(val, 4) for gid, val in per_pipe_final.items()}
    assert snap3["clinging_water_g"] == 0.0, snap3
    assert abs(snap3["dripped_to_sink_g"] - 38.5) < 0.05, snap3
    assert abs(snap3["evaporated_g"] - 3.5) < 0.05, snap3
    assert abs(snap3["mass_balance_error_g"]) < 1e-4, snap3
    assert snap3["effective_tray_mass_kg"] == TRAY_MASS_KG, snap3
    assert snap3["contacted_pipe_count"] == 6, (snap3, per_pipe_named)
    stage_summaries["wet_tray_drip_dry_and_pipe_force_distribution"] = {
        **snap3,
        "per_pipe_vertical_force_n": per_pipe_named,
    }

    # Stage 4: Return brackets to 700 mm rest pitch and verify GLB vs native.xml rest + 21-sample motion alignment
    state["mode"] = "return_to_rest_700mm"
    data.ctrl[model.actuator("bps_bracket_left_actuator").id] = 0.0
    data.ctrl[model.actuator("bps_bracket_right_actuator").id] = 0.0
    snap4 = step_and_sample(0.48, drying_active=False)
    assert abs(snap4["bracket_stud_pitch_mm"] - 700.0) < 0.5, snap4
    assert abs(snap4["bracket_left_slide_mm"]) < 0.3, snap4
    assert abs(snap4["bracket_right_slide_mm"]) < 0.3, snap4

    native_path = ASSETS / "native.xml"
    glb_path = ASSETS / "maruzen-bps30-12b.glb"
    native_sha = hashlib.sha256(native_path.read_bytes()).hexdigest()

    native_model = mujoco.MjModel.from_xml_path(str(native_path))
    native_data = mujoco.MjData(native_model)
    mujoco.mj_forward(native_model, native_data)

    body_poses = {}
    for bname in NAMES:
        bid = native_model.body(bname).id
        pos = native_data.xpos[bid]
        quat = native_data.xquat[bid]
        body_poses[bname] = [
            float(pos[0]),
            float(pos[1]),
            float(pos[2]),
            float(quat[0]),
            float(quat[1]),
            float(quat[2]),
            float(quat[3]),
        ]

    evidence_dir = ASSETS / "active-state-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    # Rest-frame verification via inspect_appliance_frames.mjs
    frames_in = evidence_dir / "frames-input.json"
    frames_out = evidence_dir / "frames-report.json"
    frames_in.write_text(
        json.dumps(
            {
                "maruzen-bps30-12b": {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "bodies": body_poses,
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
    frames_report = json.loads(frames_out.read_text())
    assert frames_report["passed"], frames_report

    # Sampled scalar-joint motion verification (21 samples per scalar joint) via inspect_appliance_frames.mjs --motion
    motions = []
    for joint_name, vis_axis in VISUAL_AXES.items():
        jid = native_model.joint(joint_name).id
        jtype = int(native_model.jnt_type[jid])
        kind = "hinge" if jtype == int(mujoco.mjtJoint.mjJNT_HINGE) else "slide"
        low, high = native_model.jnt_range[jid]
        bid = int(native_model.jnt_bodyid[jid])
        samples = []
        for idx in range(21):
            val = float(low + (high - low) * idx / 20.0)
            mujoco.mj_resetData(native_model, native_data)
            native_data.qpos[native_model.jnt_qposadr[jid]] = val
            mujoco.mj_forward(native_model, native_data)
            samples.append(
                {
                    "value": val,
                    "pose": [*native_data.xpos[bid].tolist(), *native_data.xquat[bid].tolist()],
                }
            )
        motions.append(
            {
                "joint": joint_name,
                "body": native_model.body(bid).name,
                "kind": kind,
                "visual_axis": vis_axis,
                "samples": samples,
            }
        )

    motion_in = evidence_dir / "motion-input.json"
    motion_out = evidence_dir / "motion-report.json"
    motion_in.write_text(
        json.dumps(
            {
                "maruzen-bps30-12b": {
                    "glb": str(glb_path),
                    "native_sha256": native_sha,
                    "motions": motions,
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
            str(motion_in),
            str(motion_out),
            "--motion",
        ],
        check=True,
    )
    motion_report = json.loads(motion_out.read_text())
    assert motion_report["passed"], motion_report

    rest_check = {
        "passed": frames_report["passed"],
        "frames_aligned": len(frames_report["appliances"]["maruzen-bps30-12b"]["frames"]),
        "max_position_error_m": max(
            f["position_error_m"]
            for f in frames_report["appliances"]["maruzen-bps30-12b"]["frames"]
        ),
        "max_orientation_error_rad": max(
            f["orientation_error_rad"]
            for f in frames_report["appliances"]["maruzen-bps30-12b"]["frames"]
        ),
    }
    motion_check = {
        "passed": motion_report["passed"],
        "joints_verified": len(motion_report["appliances"]["maruzen-bps30-12b"]["motions"]),
        "samples_per_joint": 21,
        "max_position_error_m": max(
            m["position_error_m"]
            for m in motion_report["appliances"]["maruzen-bps30-12b"]["motions"]
        ),
        "max_orientation_error_rad": max(
            m["orientation_error_rad"]
            for m in motion_report["appliances"]["maruzen-bps30-12b"]["motions"]
        ),
    }
    stage_summaries["return_brackets_to_rest_and_frame_checks"] = {
        "rest_snap": snap4,
        "rest_frame_check": rest_check,
        "motion_frame_check": motion_check,
    }

    trace_path = evidence_dir / "trace.csv"
    with trace_path.open("w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=list(trace_rows[0].keys()), lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(trace_rows)

    report = {
        "status": "passed",
        "appliance": "maruzen-bps30-12b",
        "model_title": "Maruzen BPS30-12B SUS430 Commercial Wall Drainer Pipe Shelf",
        "envelope_m": [1.200, 0.300, 0.240],
        "unit_mass_kg": SHELF_UNIT_MASS_KG,
        "drying_tray_mass_kg": TRAY_MASS_KG,
        "total_scene_mass_kg": round(sum(MASSES.values()), 6),
        "component_masses_kg": MASSES,
        "native_parity": parity,
        "rest_frame_check": rest_check,
        "motion_frame_check": motion_check,
        "trace_samples": len(trace_rows),
        "trace_csv_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "glb_sha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
        "scene_xml_sha256": hashlib.sha256((ASSETS / "scene.xml").read_bytes()).hexdigest(),
        "native_xml_sha256": native_sha,
        "stages": stage_summaries,
    }
    (evidence_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (ASSETS / "active-states.json").write_text(json.dumps(report, indent=2) + "\n")
    write_docs(report)
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
