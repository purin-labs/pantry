"""Fast static MuJoCo 4.0 hygiene and readiness audit across all bakery appliances and robots."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APPLIANCES_DIR = ROOT / "assets/bakery-mujoco"
ROBOTS_DIR = ROOT / "assets/bakery-robots"

RENDER_PREFIXES = (
    "studio-",
    "preview-",
    "contact-sheet",
    "reference-",
    "audit-",
    "turntable-",
    "export-review",
)


def is_texture_png(path: Path) -> bool:
    name = path.name.lower()
    if path.suffix.lower() != ".png":
        return False
    return not any(name.startswith(prefix) for prefix in RENDER_PREFIXES)


def collect_included_xmls(entry: Path) -> list[ET.Element]:
    roots: list[ET.Element] = []
    seen: set[Path] = set()

    def visit(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            return
        seen.add(resolved)
        try:
            root = ET.parse(resolved).getroot()
        except ET.ParseError:
            return
        roots.append(root)
        for inc in root.iter("include"):
            rel = inc.get("file")
            if rel:
                visit(resolved.parent / rel)

    visit(entry)
    return roots


def parse_rgba(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    parts = raw.split()
    if len(parts) != 4:
        return None
    try:
        vals = tuple(float(p) for p in parts)
        return vals  # type: ignore[return-value]
    except ValueError:
        return None


def audit_appliance(folder: Path, mujoco) -> dict | None:
    entry = None
    for candidate in ("model.xml", "appliance.xml", "scene.xml"):
        if (folder / candidate).is_file():
            entry = folder / candidate
            break
    if entry is None:
        return None

    has_model_xml = (folder / "model.xml").is_file()
    has_blend = any(folder.glob("*.blend"))
    has_native = (folder / "native.xml").is_file()

    # Check UV presence across exported visual OBJ meshes
    mesh_dir = folder / "meshes"
    obj_files = sorted(mesh_dir.glob("*.obj")) if mesh_dir.is_dir() else []
    uv_obj_count = 0
    for obj_path in obj_files:
        text = obj_path.read_text(errors="ignore")
        if "\nvt " in text or text.startswith("vt "):
            uv_obj_count += 1

    # Check authored PNG texture files vs wired <texture> tags
    png_textures = sorted(p.name for p in folder.iterdir() if p.is_file() and is_texture_png(p))
    xml_roots = collect_included_xmls(folder / "appliance.xml" if (folder / "appliance.xml").is_file() else entry)
    wired_textures: set[str] = set()
    for root in xml_roots:
        for tex in root.iter("texture"):
            fname = tex.get("file")
            if fname:
                wired_textures.add(Path(fname).name)
    wired_hashes = {
        hashlib.sha256((folder / name).read_bytes()).hexdigest()
        for name in wired_textures
        if (folder / name).is_file()
    }
    unwired_textures = [
        p
        for p in png_textures
        if p not in wired_textures
        and hashlib.sha256((folder / p).read_bytes()).hexdigest() not in wired_hashes
    ]

    # Parse solver / default / collider / site / joint hygiene
    dt = 0.002
    default_condim = None
    default_solref = None
    default_contype = None
    default_conaffinity = None
    for root in xml_roots:
        opt = root.find("option")
        if opt is not None and opt.get("timestep"):
            try:
                dt = float(opt.get("timestep"))
            except ValueError:
                pass
        for dflt in root.findall("default"):
            if dflt.get("class"):
                continue
            g = dflt.find("geom")
            if g is not None:
                default_condim = g.get("condim", default_condim)
                default_solref = g.get("solref", default_solref)
                default_contype = g.get("contype", default_contype)
                default_conaffinity = g.get("conaffinity", default_conaffinity)

    solref_too_stiff = False
    if default_solref:
        try:
            tc = float(default_solref.split()[0])
            if tc > 0 and tc < 2.0 * dt - 1e-9:
                solref_too_stiff = True
        except (ValueError, IndexError):
            pass

    collider_count = 0
    colliders_missing_rgba = 0
    asymmetric_masks = 0
    disabled_group3_colliders = 0
    bad_site_groups = 0
    invisible_sites = 0
    huge_spin_limits = 0

    for root in xml_roots:
        world = root.find("worldbody")
        geom_scope = world.iter("geom") if world is not None else root.iter("geom")
        for geom in geom_scope:
            name = geom.get("name", "")
            if not name or name in ("floor", "bench", "ingredient_surface"):
                continue
            group = geom.get("group")
            gtype = geom.get("type", "sphere")
            ct = geom.get("contype", default_contype or "1")
            ca = geom.get("conaffinity", default_conaffinity or "1")
            if group == "3" or (gtype != "mesh" and (ct != "0" or ca != "0")):
                if gtype == "mesh" and ct == "0" and ca == "0":
                    continue
                collider_count += 1
                if ct == "0" and ca == "0":
                    disabled_group3_colliders += 1
                elif ct != ca or ct not in ("1",):
                    asymmetric_masks += 1
                rgba = parse_rgba(geom.get("rgba"))
                if rgba is None or rgba[3] <= 0.0:
                    colliders_missing_rgba += 1

        for site in root.iter("site"):
            if site.get("group") != "4":
                bad_site_groups += 1
            rgba = parse_rgba(site.get("rgba"))
            if rgba is None or rgba[3] <= 0.0:
                invisible_sites += 1

        for joint in root.iter("joint"):
            jrange = joint.get("range")
            if jrange and joint.get("limited", "true") != "false":
                try:
                    lo, hi = (float(x) for x in jrange.split()[:2])
                    if abs(lo) >= 100.0 or abs(hi) >= 100.0:
                        huge_spin_limits += 1
                except ValueError:
                    pass

    # Check native.xml loadability and orphan textures
    native_ok = None
    native_orphan_textures = 0
    if has_native:
        native_path = folder / "native.xml"
        try:
            native_root = ET.parse(native_path).getroot()
            assets_el = native_root.find("asset")
            if assets_el is not None:
                native_orphan_textures = sum(
                    1
                    for item in assets_el
                    if item.tag == "texture" and item.get("file") is not None
                )
            mujoco.MjModel.from_xml_path(str(native_path))
            native_ok = True
        except Exception:
            native_ok = False

    issues = []
    if not has_model_xml:
        issues.append("missing_model_xml")
    if obj_files and uv_obj_count == 0:
        issues.append("no_obj_uvs")
    if unwired_textures:
        issues.append(f"unwired_pngs({len(unwired_textures)})")
    if default_condim != "4":
        issues.append("condim_not_4")
    if solref_too_stiff:
        issues.append("solref_below_2dt")
    if colliders_missing_rgba:
        issues.append(f"colliders_no_rgba({colliders_missing_rgba})")
    if asymmetric_masks:
        issues.append(f"asymmetric_masks({asymmetric_masks})")
    if disabled_group3_colliders:
        issues.append(f"disabled_colliders({disabled_group3_colliders})")
    if bad_site_groups:
        issues.append(f"bad_site_groups({bad_site_groups})")
    if invisible_sites:
        issues.append(f"invisible_sites({invisible_sites})")
    if huge_spin_limits:
        issues.append(f"huge_spin_limits({huge_spin_limits})")
    if native_orphan_textures:
        issues.append(f"native_orphan_tex({native_orphan_textures})")
    if native_ok is False:
        issues.append("native_load_error")

    return {
        "name": folder.name,
        "kind": "appliance",
        "has_model_xml": has_model_xml,
        "has_blend": has_blend,
        "has_native": has_native,
        "native_ok": native_ok,
        "obj_count": len(obj_files),
        "uv_obj_count": uv_obj_count,
        "png_textures": png_textures,
        "unwired_textures": unwired_textures,
        "collider_count": collider_count,
        "issues": issues,
        "ready": len(issues) == 0,
    }


def audit_robot(folder: Path, mujoco) -> dict | None:
    xmls = sorted(p for p in folder.glob("*.xml") if p.name != "scene.xml")
    if not xmls:
        return None
    entry = folder / "model.xml" if (folder / "model.xml").is_file() else xmls[0]
    xml_roots = collect_included_xmls(entry)
    vis_bad_group = 0
    invisible_colliders = 0
    bad_sites = 0
    zero_damping_joints = 0
    for root in xml_roots:
        for geom in root.iter("geom"):
            gclass = geom.get("class", "")
            group = geom.get("group")
            if gclass == "visual" or (geom.get("contype") == "0" and geom.get("conaffinity") == "0"):
                if group != "2":
                    vis_bad_group += 1
            elif gclass == "collision" or group == "3":
                rgba = parse_rgba(geom.get("rgba"))
                if rgba is None or rgba[3] <= 0.0:
                    invisible_colliders += 1
        for site in root.iter("site"):
            rgba = parse_rgba(site.get("rgba"))
            if site.get("group") != "4" or rgba is None or rgba[3] <= 0.0:
                bad_sites += 1
        for joint in root.iter("joint"):
            if joint.get("damping") in (None, "0", "0.0"):
                zero_damping_joints += 1

    issues = []
    if vis_bad_group:
        issues.append(f"visual_not_group2({vis_bad_group})")
    if invisible_colliders:
        issues.append(f"colliders_no_rgba({invisible_colliders})")
    if bad_sites:
        issues.append(f"bad_sites({bad_sites})")
    if zero_damping_joints:
        issues.append(f"zero_damping_joints({zero_damping_joints})")

    return {
        "name": folder.name,
        "kind": "robot",
        "entry": entry.name,
        "issues": issues,
        "ready": len(issues) == 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", dest="json_out", type=Path, default=None)
    args = parser.parse_args()

    import mujoco

    results = []
    for folder in sorted(APPLIANCES_DIR.iterdir()):
        if not folder.is_dir():
            continue
        item = audit_appliance(folder, mujoco)
        if item is not None:
            results.append(item)
    if ROBOTS_DIR.is_dir():
        for folder in sorted(ROBOTS_DIR.iterdir()):
            if not folder.is_dir():
                continue
            item = audit_robot(folder, mujoco)
            if item is not None:
                results.append(item)

    ready = [r for r in results if r["ready"]]
    not_ready = [r for r in results if not r["ready"]]
    print(f"Fleet audit: {len(ready)}/{len(results)} assets fully clean")
    print("-" * 88)
    for r in results:
        mark = "PASS" if r["ready"] else "TODO"
        tag = "[robot]" if r["kind"] == "robot" else "[app]  "
        detail = ", ".join(r["issues"]) if r["issues"] else "clean"
        print(f"{mark} {tag} {r['name']:32s} {detail}")

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(
            json.dumps(
                {
                    "summary": {
                        "total": len(results),
                        "ready": len(ready),
                        "todo": len(not_ready),
                    },
                    "assets": results,
                },
                indent=2,
            )
            + "\n"
        )


if __name__ == "__main__":
    main()
