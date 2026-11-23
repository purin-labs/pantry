"""Export collision models for the shared Rust/Wasm runner; execute no workflow."""

import hashlib
import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
from live_panels import READOUTS, model_spec

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "assets/bakery-mujoco/fr10-workcell/native/assets.json"


def strip_visual_meshes(root, model):
    # Three.js owns the detailed visuals. Zero-mass, noncontact meshes do not
    # belong in the Wasm package. Keep collision proxies and payload markers.
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


def export():
    files = {}
    for name in READOUTS:
        directory = ROOT / "assets/bakery-mujoco" / name
        spec = model_spec(directory / "scene.xml", name)
        model = spec.compile()
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        if name in ("maruzen-mih-02c", "vollrath-59500p"):
            spec.body("ih_pan").pos = data.site("ih_zone").xpos + (0, 0, 0.004)
            model = spec.compile()
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
                    continue
                filename = asset.get("file")
                if filename:
                    source = (directory / filename).resolve()
                    asset.set("file", os.path.relpath(source, directory))
                    files[str(source.relative_to(ROOT))] = hashlib.sha256(
                        source.read_bytes()
                    ).hexdigest()
        ET.indent(root, space="  ")
        destination = directory / "native.xml"
        destination.write_text(ET.tostring(root, encoding="unicode") + "\n")
        rebuilt = mujoco.MjModel.from_xml_path(str(destination))
        for field in ("body_mass", "body_inertia", "qpos0", "dof_damping"):
            if not np.allclose(
                getattr(model, field), getattr(rebuilt, field), rtol=1e-5, atol=1e-9
            ):
                raise RuntimeError(f"Export changed native {field}: {name}")
        if (rebuilt.nq, rebuilt.nv) != (model.nq, model.nv):
            raise RuntimeError("Export changed the native degrees of freedom.")
        files[str(destination.relative_to(ROOT))] = hashlib.sha256(
            destination.read_bytes()
        ).hexdigest()
        print(name, rebuilt.nq, rebuilt.nv)
    return files


def main():
    files = json.loads(MANIFEST.read_text())
    files.update(export())
    MANIFEST.write_text(json.dumps(dict(sorted(files.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
