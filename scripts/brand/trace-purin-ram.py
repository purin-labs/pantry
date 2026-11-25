"""Trace the concept Purin ram (docs/brand/purin-ram/reference/) into parts that move.

The ram is drawn with lines. Each part is a fill that reaches the middle of its drawn line,
and the lines are their own shapes, owned by the part in front: the head owns the line
between the head and a horn, the paws own the lines where they hold the food.
Walls cut the body colour into its parts: the ears, the head, the paws.

Three poses share one pipeline; each pose has its own walls, parts and pivots:

- pudding: the logo pose; the ram looks over a pudding that stands on the floor
- hug: the ram hugs a croissant
- eat: the ram eats a croissant

    python3 scripts/brand/trace-purin-ram.py               # writes docs/brand/purin-ram/ram-*.json
    python3 scripts/brand/trace-purin-ram.py --site DIR    # also ram-paths.ts, ram-poses.ts,
                                                           # ram-wordmark.svg and ram-icon.svg

The walls and the pivots are measured on these images; a new image needs new values.
Needs numpy, scipy, Pillow and contourpy.
"""

import json
import re
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull

sys.path.insert(0, str(Path(__file__).parent))
from curve_fit import outlines

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "docs/brand/purin-ram"
SITE = sys.argv[sys.argv.index("--site") + 1] if "--site" in sys.argv else None

# the colour classes; FOOD and FOOD2 are custard and caramel, or the light and the shade of a croissant
GROUND, BODY, HORN, LINE, CREAM, FOOD, FOOD2 = range(7)
TOL = 0.9


def classes(src, seeds, small):
    """Each pixel as one flat colour class. `small` is the largest speck of each class that becomes line."""
    im = np.asarray(Image.open(src).convert("RGB")).astype(float)
    h, w, _ = im.shape
    c = np.array(seeds, float)
    px = im.reshape(-1, 3)
    for _ in range(8):
        d = ((px[:, None, :] - c[None]) ** 2).sum(-1)
        lab = d.argmin(1)
        for k in range(len(c)):
            if (lab == k).any():
                c[k] = px[lab == k].mean(0)
    # clean the image noise: the class with the most weight near each pixel
    lab = lab.reshape(h, w)
    soft = np.stack(
        [ndi.gaussian_filter((lab == k).astype(float), 1.2) for k in range(len(c))]
    )
    lab = soft.argmax(0)
    # specks inside the drawn lines: a small patch of any other colour becomes line
    for k in (GROUND, BODY, HORN, CREAM, FOOD, FOOD2):
        cc, m = ndi.label(lab == k)
        if m:
            area = ndi.sum(lab == k, cc, range(1, m + 1))
            lab[np.isin(cc, 1 + np.nonzero(area < small.get(k, 150))[0])] = LINE
    return lab


def wall(mask, pts, width=3):
    im = Image.fromarray(np.zeros(mask.shape, np.uint8))
    ImageDraw.Draw(im).line(pts, fill=1, width=width)
    return mask & ~np.asarray(im).astype(bool)


def biggest(mask, n=1, min_area=200):
    cc, m = ndi.label(mask)
    areas = ndi.sum(mask, cc, range(1, m + 1))
    keep = [i + 1 for i in np.argsort(-areas)[:n] if areas[i] >= min_area]
    return np.isin(cc, keep)


def paths(mask):
    return "".join(outlines(mask, 1.0, TOL))


# The owner asked for horns a little smaller and more compact than in the images (24 November
# 2026): each horn is drawn this many times its size, about the point where it meets the head.
HORN_SCALE = 0.9


def shrink(mask, root, line=False):
    """`mask` made HORN_SCALE times its size about `root` (x, y). A drawn line keeps its width:
    the soft edge of the smaller line is cut low, so each side of it grows by about half a pixel."""
    k = 1 / HORN_SCALE
    soft = ndi.affine_transform(
        mask.astype(np.float32),
        np.diag([k, k]),
        offset=(root[1] * (1 - k), root[0] * (1 - k)),
        order=1,
    )
    return soft > (0.1 if line else 0.5)


# ---------- the centre lines, for the brushed lines ----------
def thin(img):
    """Zhang-Suen thinning: the mask as lines one pixel wide."""
    img = img.astype(np.uint8)
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:]
            p5, p6, p7 = P[2:, 2:], P[2:, 1:-1], P[2:, :-2]
            p8, p9 = P[1:-1, :-2], P[:-2, :-2]
            n = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            b = sum(x.astype(int) for x in n[:8])
            a = sum(((n[i] == 0) & (n[i + 1] == 1)).astype(int) for i in range(8))
            if step == 0:
                c = ((p2 * p4 * p6) == 0) & ((p4 * p6 * p8) == 0)
            else:
                c = ((p2 * p4 * p8) == 0) & ((p2 * p6 * p8) == 0)
            m = (img == 1) & (b >= 2) & (b <= 6) & (a == 1) & c
            if m.any():
                img[m] = 0
                changed = True
        if not changed:
            return img.astype(bool)


def skeleton_paths(sk):
    """The thin lines as pixel paths between ends and real junctions, and closed loops.
    A junction has three or more branches round it (its crossing number), so a stair
    step of a thin line is not a junction."""
    P = np.pad(sk.astype(np.uint8), 1)
    ring = [
        P[:-2, 1:-1],
        P[:-2, 2:],
        P[1:-1, 2:],
        P[2:, 2:],
        P[2:, 1:-1],
        P[2:, :-2],
        P[1:-1, :-2],
        P[:-2, :-2],
    ]
    cn = sum(((ring[i] == 0) & (ring[(i + 1) % 8] == 1)).astype(int) for i in range(8))
    count = sum(r.astype(int) for r in ring)
    pts = set(zip(*np.nonzero(sk), strict=True))
    node = {p for p in pts if cn[p] != 2 or count[p] <= 1}
    steps = [(-1, 0), (0, 1), (1, 0), (0, -1), (-1, -1), (-1, 1), (1, 1), (1, -1)]

    def nb(p):
        return [
            (p[0] + dy, p[1] + dx) for dy, dx in steps if (p[0] + dy, p[1] + dx) in pts
        ]

    def is_end(p):
        return count[p] == 1 or cn[p] == 1

    visited = set()
    out = []

    def walk(path):
        prev = path[-2] if len(path) > 1 else None
        cur = path[-1]
        while True:
            cand = [r for r in nb(cur) if r != prev and r not in visited]
            hit = [
                r
                for r in cand
                if (r in node and r != path[0]) or (r == path[0] and len(path) > 3)
            ]
            if hit:
                path.append(hit[0])
                return path
            cand = [r for r in cand if r not in node]
            if not cand:
                return path
            prev, cur = cur, cand[0]
            visited.add(cur)
            path.append(cur)

    for s0 in node:
        for q in nb(s0):
            if q in visited or q in node:
                continue
            visited.add(q)
            path = walk([s0, q])
            out.append((path, is_end(s0), is_end(path[-1])))
    for p0 in pts:
        if p0 in visited or p0 in node:
            continue
        visited.add(p0)
        path = walk([p0])
        if len(path) > 3:
            out.append(([*path, p0], False, False))
    return out


def spines(mask, lw, style):
    """The centre lines of a line mask as brush strokes of [x, y, width]. A stroke that meets
    another at a junction goes on past it by half a width, with square ends, so the joined
    strokes read as one line; a free end lands and lifts round, and it may run dry."""
    mask = ndi.gaussian_filter(mask.astype(float), 1.2) > 0.5
    if mask.sum() < 30:
        return []
    dt = ndi.distance_transform_edt(mask)
    res = []
    for path, end_a, end_b in skeleton_paths(thin(mask)):
        p = np.array(path, float)[:, ::-1]
        seg = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
        if seg[-1] < (lw * 1.2 if (end_a or end_b) else 3):
            continue  # a spur of the thinning
        k = 5
        if len(p) > 2 * k:
            kernel = np.ones(k) / k
            sm = np.c_[
                np.convolve(p[:, 0], kernel, "same"),
                np.convolve(p[:, 1], kernel, "same"),
            ]
            sm[: k // 2], sm[-(k // 2) :] = p[: k // 2], p[-(k // 2) :]
            p = sm
            seg = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
        t = np.linspace(0, seg[-1], max(2, int(seg[-1] / 7) + 1))
        xs, ys = list(np.interp(t, seg, p[:, 0])), list(np.interp(t, seg, p[:, 1]))
        h, w_ = dt.shape
        ws = [
            2 * float(dt[min(round(y), h - 1), min(round(x), w_ - 1)])
            for x, y in zip(xs, ys, strict=True)
        ]
        ws = list(np.clip(ws, 2, lw * 1.35))
        joined = not (end_a and end_b)
        if joined:
            for first, free in ((True, end_a), (False, end_b)):
                if free:
                    continue
                i, j = (0, 1) if first else (-1, -2)
                dx, dy = xs[i] - xs[j], ys[i] - ys[j]
                d = (dx * dx + dy * dy) ** 0.5 or 1
                ext = ws[i] * 0.55
                at = 0 if first else len(xs)
                xs.insert(at, xs[i] + dx / d * ext)
                ys.insert(at, ys[i] + dy / d * ext)
                ws.insert(at, ws[i])
        name = style if style == "detail" else ("wet" if joined else "dry")
        res.append(
            {
                "pts": [
                    [round(float(x), 1), round(float(y), 1), round(float(v), 1)]
                    for x, y, v in zip(xs, ys, ws, strict=True)
                ],
                "flat": bool(joined),
                "style": name,
            }
        )
    return res


# The brush of the front page drawings, set for the lines of the ram. A joined line stays wet
# to its ends; a free end may run dry; the eyes, the mouth and the horn ridges keep their line.
BRUSH_STYLES = {
    "wet": {"rough": 0.6, "grain": 0.08, "dry": 0.03, "widen": 1.12},
    "dry": {"rough": 0.6, "grain": 0.1, "dry": 0.3, "widen": 1.12},
    "detail": {
        "rough": 0.35,
        "grain": 0.06,
        "dry": 0.1,
        "widen": 1.1,
        "keepLine": True,
        "round": True,
    },
}
BRUSH_SEED = 20261124
BRUSH_SCALE = 0.8  # device pixels for each unit: it sets how far apart the bristles are
BRUSH_TS = ROOT.parent / "purin-monorepo/apps/seams-site/src/components/h2/ink/brush.ts"
RASTER = 3  # pixels for each unit when the bristle marks are drawn and traced


def brush(states):
    """The lines of each pose painted with the site brush, as SVG paths in the same parts."""
    import base64
    import subprocess
    import tempfile

    items = {}
    for key, (pose, st) in states.items():
        details, lw = st["details"], st["lw"]
        for k, n in enumerate(pose["front"]):
            items[f"{key}/lines/{n}"] = spines(owned(st, k, n), lw, "line")
        for i, m in enumerate(st.get("bites", [])):
            items[f"{key}/bites/{i}"] = spines(m, lw, "line")
        eyes = sorted(details["eyes"], key=lambda m: np.nonzero(m)[1].mean())
        for i, m in enumerate(eyes):
            items[f"{key}/eyes/{i}"] = spines(m, lw, "detail")
        if details["mouth"]:
            items[f"{key}/mouth"] = spines(
                np.any(details["mouth"], axis=0), lw, "detail"
            )
        for side, name in (("ridgeL", "hornL"), ("ridgeR", "hornR")):
            if details[side]:
                items[f"{key}/ridges/{name}"] = spines(
                    np.any(details[side], axis=0), lw, "detail"
                )
        if "hull" in st:
            items[f"{key}/hull"] = spines(st["hull"], lw, "line")
    with tempfile.TemporaryDirectory() as tmp:
        job, marks = Path(tmp, "job.json"), Path(tmp, "marks.json")
        job.write_text(
            json.dumps(
                {
                    "seed": BRUSH_SEED,
                    "scale": BRUSH_SCALE,
                    "styles": BRUSH_STYLES,
                    "items": items,
                }
            )
        )
        subprocess.run(
            [
                "node",
                str(Path(__file__).with_name("brush-purin-ram.mjs")),
                str(job),
                str(marks),
                str(BRUSH_TS),
            ],
            check=True,
        )
        painted = json.loads(marks.read_text())
    out = {
        key: {
            "lines": {},
            "eyes": [],
            "ridges": {"hornL": "", "hornR": ""},
            "mouth": "",
            **({"bites": [""] * len(st["bites"])} if "bites" in st else {}),
        }
        for key, (_, st) in states.items()
    }
    for item, mark in painted.items():
        key, *where = item.split("/")
        h, w = states[key][1]["line"].shape
        im = Image.new("L", (w * RASTER, h * RASTER), 0)
        draw = ImageDraw.Draw(im)
        segs = (
            np.frombuffer(base64.b64decode(mark["segs"]), np.float32).reshape(-1, 4)
            * RASTER
        )
        width = max(1, round(mark["width"] * RASTER))
        for x1, y1, x2, y2 in segs.tolist():
            draw.line([(x1, y1), (x2, y2)], fill=255, width=width)
        d = "".join(outlines(np.asarray(im) > 127, 1 / RASTER, 0.3))
        if where[0] == "lines":
            if d:
                out[key]["lines"][where[1]] = d
        elif where[0] == "eyes":
            out[key]["eyes"].append(d)
        elif where[0] == "ridges":
            out[key]["ridges"][where[1]] = d
        elif where[0] == "bites":
            out[key]["bites"][int(where[1])] = d
        else:
            out[key][where[0]] = d
    return out


def trace(pose):
    """The fills, the owned lines and the face strokes of one pose."""
    lab = classes(
        BRAND / "reference" / pose["image"], pose["seeds"], pose.get("small", {})
    )
    H, W = lab.shape
    body = lab == BODY
    for pts in pose["walls"]:
        body = wall(body, pts)
    cc, _ = ndi.label(body)
    regions = pose["regions"](lab, body, lambda x, y: cc == cc[y, x])
    for a, b in combinations(regions, 2):
        if (regions[a] & regions[b]).any():
            print("OVERLAP", a, b, (regions[a] & regions[b]).sum())
    names = list(regions)
    idx = np.zeros((H, W), np.int16)  # 0 = ground or line, k+1 = region k
    for k, n in enumerate(names):
        idx[regions[n]] = k + 1
    line = lab == LINE
    # every line pixel goes to the nearest pixel that is not a line: a region or the ground
    _, (iy, ix) = ndi.distance_transform_edt(line, return_indices=True)
    near = idx[iy, ix]
    fills = {n: regions[n] | (line & (near == k + 1)) for k, n in enumerate(names)}
    # the cut lines of the walls belong to one part; some fills reach under the part in front,
    # so a part that moves opens no gap
    walls = (lab == BODY) & (idx == 0)
    for part, extra in pose["merge"].items():
        for e in extra:
            fills[part] = fills[part] | (walls if e == "walls" else fills[e])
    for part, under, steps in pose["under"]:
        base = np.zeros((H, W), bool)
        for u in under:
            if u == "walls":
                base |= walls
            elif u.startswith("line:"):
                # the outline of a part, so no gap opens where that part turns away
                base |= line & (near == names.index(u[5:]) + 1)
            else:
                base |= regions[u]
        fills[part] = fills[part] | (
            ndi.binary_dilation(regions[part], iterations=steps) & base
        )
    # the line width
    dt = ndi.distance_transform_edt(line)
    ridge = (dt == ndi.maximum_filter(dt, 5)) & (dt > 1.5)
    lw = 2 * float(np.median(dt[ridge]))
    print(pose["image"], "line width", round(lw, 1))

    # ---------- the lines, owned by the part in front ----------
    front = pose["front"]
    owner = np.full((H, W), -1, np.int16)
    for k in reversed(range(len(front))):
        near_k = ndi.distance_transform_edt(~regions[front[k]]) <= lw * 0.9
        owner[line & near_k] = k
    # small separate strokes: the eyes, the mouth and the ridges of the horns
    lc, lm = ndi.label(line)
    details = {"eyes": [], "mouth": [], "ridgeL": [], "ridgeR": []}
    eye_low, eye_high = pose["eyeRows"]
    mouth_low, mouth_high = pose["mouthRows"]
    for i in range(1, lm + 1):
        s = lc == i
        a = int(s.sum())
        if a > 5000 or a < 60:
            continue
        ys, xs = np.nonzero(s)
        cx, cy = xs.mean(), ys.mean()
        inside = idx[iy[s], ix[s]]
        vals, cnt = np.unique(inside[inside > 0], return_counts=True)
        host = names[vals[cnt.argmax()] - 1] if len(vals) else "none"
        if host == pose["head"] and eye_low < cy < eye_high and a > 800:
            details["eyes"].append(s)
        elif host in pose["face"] and mouth_low < cy < mouth_high:
            details["mouth"].append(s)
        elif host == "hornL":
            details["ridgeL"].append(s)
        elif host == "hornR":
            details["ridgeR"].append(s)
        else:
            print("  stroke left in place", i, a, int(cx), int(cy), host)
            continue
        owner[s] = -2
    print(" ", {k: len(v) for k, v in details.items()})
    claimed = owner >= 0
    _, (oy, ox) = ndi.distance_transform_edt(~claimed, return_indices=True)
    spill = line & (owner == -1)
    owner[spill] = owner[oy[spill], ox[spill]]

    # the frame of the drawing as the images have it, so the frames keep their size
    ys, xs = np.nonzero(np.any([fills[n] for n in names], axis=0) | line)
    extent = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    horns_before = [paths(fills[h]) for h in ("hornL", "hornR")]
    roots, skull = smaller_horns(pose, regions, fills, line, owner, details, lw)

    out = {"size": [W, H], "lineWidth": round(lw, 1)}
    state = {
        "lab": lab,
        "regions": regions,
        "fills": fills,
        "line": line,
        "owner": owner,
        "details": details,
        "lw": lw,
        "names": names,
        "extent": extent,
        "hornsBefore": horns_before,
        "roots": roots,
        "skull": skull,
        "front": front,
        # lines that a part owns besides its share of the drawn lines (see eat_extras)
        "more": {},
    }
    return out, state


def owned(st, k, n):
    """The line mask of the part `n`, at the index `k` of the front list."""
    m = st["line"] & (st["owner"] == k)
    return m | st["more"][n] if n in st["more"] else m


def draw(out, st):
    """The fills, the lines and the face strokes of a traced pose, as SVG paths."""
    line, details = st["line"], st["details"]
    out["fills"] = {n: paths(st["fills"][n]) for n in st["names"] if n in st["fills"]}
    out["lines"] = {}
    for k, n in enumerate(st["front"]):
        msk = owned(st, k, n)
        # overlap the neighbour line pieces by a little, so the seams between owners do not open
        msk = msk | (ndi.binary_dilation(msk, iterations=3) & line)
        if msk.sum() > 30:
            out["lines"][n] = paths(msk)
    out["eyes"] = [
        paths(s) for s in sorted(details["eyes"], key=lambda s: np.nonzero(s)[1].mean())
    ]
    out["mouth"] = paths(np.any(details["mouth"], axis=0)) if details["mouth"] else ""
    out["ridges"] = {
        "hornL": paths(np.any(details["ridgeL"], axis=0)) if details["ridgeL"] else "",
        "hornR": paths(np.any(details["ridgeR"], axis=0)) if details["ridgeR"] else "",
    }


def smaller_horns(pose, regions, fills, line, owner, details, lw):
    """Draw both horns HORN_SCALE times their size, in place; return the roots and the skull.

    The root of a horn is the middle of the band where it meets the head. Both horns get
    smaller about one point, the skull between the two roots, so the tips that touch stay
    together and the horns come closer to the head. A horn is behind the head, so its fill
    first reaches under the head and its outline: the smaller horn still meets the head with no
    gap, and the hidden part stays inside the head. The lines and the ridges of the horns go
    only where no part in front of them is; where a part in front hid an edge of a horn, the
    smaller horn draws that edge itself."""
    host = pose["head"]
    front = pose["front"]
    head = regions[host] | (line & (owner == front.index(host)))
    roots = {}
    for horn in ("hornL", "hornR"):
        band = ndi.binary_dilation(regions[horn], iterations=int(lw)) & regions[host]
        ys, xs = np.nonzero(band if band.any() else regions[horn])
        roots[horn] = (float(xs.mean()), float(ys.mean()))
    skull = tuple((roots["hornL"][i] + roots["hornR"][i]) / 2 for i in (0, 1))
    if HORN_SCALE == 1:
        return roots, skull
    before = {}
    for horn, side in (("hornL", "ridgeL"), ("hornR", "ridgeR")):
        k = front.index(horn)
        under = ndi.binary_dilation(regions[horn], iterations=int(2 * lw)) & head
        own = line & (owner == k)
        before[horn] = (k, side, fills[horn], under, own, details[side])
        gone = own | (np.any(details[side], axis=0) if details[side] else False)
        line &= ~gone
        owner[gone] = -1
    for horn, (k, side, fill, under, own, ridges) in before.items():
        regions[horn] = shrink(regions[horn], skull)
        fills[horn] = shrink(fill, skull) | (shrink(under, skull) & head)
    # where the two horns touch, each fill reaches a little under the other, so no seam shows
    left, right = fills["hornL"], fills["hornR"]
    fills["hornL"] = left | (ndi.binary_dilation(left, iterations=3) & right)
    fills["hornR"] = right | (ndi.binary_dilation(right, iterations=3) & left)
    r = lw / 2
    for horn, (k, side, fill, under, own, ridges) in before.items():
        cover = line & (owner >= 0) & (owner < k)
        for n in front[:k]:
            if n in fills and n not in before:
                cover |= fills[n]
        # An edge that a part in front hid in the image, and that now shows, gets an outline too;
        # not where the two horns touch, which the image draws as one line.
        other = fills["hornR" if horn == "hornL" else "hornL"]
        edge = (
            (ndi.distance_transform_edt(~fills[horn]) <= r)
            & (ndi.distance_transform_edt(fills[horn]) <= r)
            & (ndi.distance_transform_edt(~other) > r)
        )
        new_own = (shrink(own, skull, line=True) | edge) & ~cover
        details[side] = [m for m in (shrink(r, skull, line=True) & ~cover for r in ridges) if m.any()]
        line |= new_own
        owner[new_own] = k
        for m in details[side]:
            line |= m
            owner[m] = -2
    return roots, skull


# ---------- the pudding pose: the logo ----------
def pudding_regions(lab, body, comp_at):
    H, W = lab.shape
    yy, xx = np.mgrid[0:H, 0:W]
    head, ear_l, ear_r = comp_at(512, 350), comp_at(300, 340), comp_at(740, 345)
    return {
        "head": head,
        "earL": ear_l,
        "earR": ear_r,
        "chest": body & ~head & ~ear_l & ~ear_r,
        "hornL": biggest((lab == HORN) & (xx < 512) & (yy < 520), 2),
        "hornR": biggest((lab == HORN) & (xx >= 512) & (yy < 520), 2),
        "muzzle": biggest(lab == CREAM),
        "custard": biggest(lab == FOOD),
        "caramel": biggest(lab == FOOD2, 3, 500),
    }


def pudding_extras(out, st):
    """The pudding alone, the pivots and the ram in one colour."""
    fills, line, owner, lw = st["fills"], st["line"], st["owner"], st["lw"]
    regions, details = st["regions"], st["details"]
    H, W = line.shape
    front = PUDDING["front"]
    # the pudding alone: its hull, with the parts under the paws filled
    pud = (
        fills["custard"]
        | fills["caramel"]
        | (line & np.isin(owner, [front.index("caramel"), front.index("custard")]))
    )
    pys, pxs = np.nonzero(pud)
    hull = ConvexHull(np.c_[pxs, pys])
    hmask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(hmask).polygon(
        [(float(pxs[i]), float(pys[i])) for i in hull.vertices], fill=1
    )
    hmask = np.asarray(hmask).astype(bool)
    inner = ndi.binary_erosion(hmask, iterations=int(lw / 2))
    out["puddingHull"] = paths(inner)
    # a ring one line wide on the hull: the brush paints its outline along the middle of it
    st["hull"] = inner & ~ndi.binary_erosion(inner, iterations=int(lw))
    # The stamp: the ram climbs up behind the pudding, then it puts its paws on it. The rim is
    # the top of the hull in each column; beside the pudding it goes on flat. The body shows
    # only above the rim (`above`), and the paws drop in below it (`below`), where the part of
    # the chest near the arms (`region`) is in front of the pudding.
    cols = np.nonzero(hmask.any(axis=0))[0]
    top = np.where(hmask.any(axis=0), hmask.argmax(axis=0), H).astype(float)
    middle = top[cols[len(cols) // 5] : cols[-len(cols) // 5]]
    corner = float(middle.max()) + 10  # the height of the top corners

    def rim(x):
        return min(float(top[int(np.clip(x, 0, W - 1))]), corner)

    xs = list(range(-400, 1425, 8))
    up, down = lw * 0.5, lw * 0.5 + 2

    def edge(dy):
        return " ".join(f"L{x} {rim(x) + dy:.1f}" for x in xs)

    yy = np.arange(H)[:, None]
    below = yy >= (np.array([rim(x) for x in range(W)])[None, :] - down)
    arm = regions["chest"] & below
    out["grab"] = {
        "above": f"M-400 -400{edge(up)}L1424 -400Z",
        "below": f"M-400 1424{edge(-down)}L1424 1424Z",
        "region": paths(ndi.binary_dilation(arm, iterations=int(lw)) & below),
    }
    cys, cxs = np.nonzero(fills["custard"])
    # The chest is soft: it leans about the tips of the paws on the pudding (`paws`), and it
    # carries the head, which turns about the neck and stays rigid.
    out["pivots"] = {
        "neck": [512, 600],
        "paws": [512, int(np.nonzero(fills["chest"])[0].max())],
        "earL": [350, 318],
        "earR": [682, 332],
        "pudding": [round(float(cxs.mean()), 1), int(cys.max())],
    }
    # one colour: the ram and its pudding as one shape, with the inside lines cut out
    solid = np.zeros((H, W), bool)
    for n in st["names"]:
        solid |= fills[n]
    solid |= line
    groups = {
        "head": "head",
        "earL": "head",
        "earR": "head",
        "muzzle": "head",
        "hornL": "hornL",
        "hornR": "hornR",
        "chest": "chest",
        "caramel": "caramel",
        "custard": "custard",
    }
    near = {g: np.zeros((H, W), bool) for g in set(groups.values())}
    for n, g in groups.items():
        near[g] |= ndi.distance_transform_edt(~regions[n]) <= lw * 1.2
    count = sum(near[g].astype(int) for g in near)
    seams = line & (count >= 2)
    seams = ndi.binary_erosion(seams, iterations=2) | (
        seams & ~ndi.binary_dilation(~line, iterations=3)
    )
    cut = (
        seams
        | regions["muzzle"]
        | ndi.binary_dilation(np.any(details["eyes"], axis=0), iterations=1)
    )
    back = (line & (owner == front.index("muzzle"))) | np.any(details["mouth"], axis=0)
    out["mono"] = paths((solid & ~cut) | back)


PUDDING = {
    "image": "ram-pudding.jpg",
    "json": "ram-paths.json",
    "seeds": [
        (248, 247, 236),
        (88, 72, 60),
        (58, 30, 28),
        (36, 22, 12),
        (248, 234, 216),
        (232, 168, 56),
        (168, 72, 24),
    ],
    "walls": [
        [(350, 342), (351, 290)],  # left ear root
        [(681, 366), (682, 294)],  # right ear root
        [(386, 596), (420, 601), (450, 598)],  # left jaw tip to the muzzle
        [(565, 600), (600, 603), (639, 589)],  # muzzle to the right jaw tip
    ],
    "regions": pudding_regions,
    "merge": {"head": ["walls", "muzzle"]},
    "under": [
        ("earL", ["head", "muzzle", "walls"], 16),
        ("earR", ["head", "muzzle", "walls"], 16),
        ("chest", ["head", "muzzle", "walls", "line:head"], 34),
    ],
    "front": [
        "muzzle",
        "head",
        "earL",
        "earR",
        "hornL",
        "hornR",
        "chest",
        "caramel",
        "custard",
    ],
    "head": "head",
    "face": ["muzzle", "head"],
    "eyeRows": (380, 460),
    "mouthRows": (430, 500),
    "extras": pudding_extras,
}


# ---------- the croissant poses ----------
def croissant_regions(seeds):
    """The parts of a croissant pose. `seeds` names a point in each part of the body colour."""

    def regions(lab, body, comp_at):
        xx = np.mgrid[0 : lab.shape[0], 0 : lab.shape[1]][1]
        parts = {name: comp_at(*at) for name, at in seeds["body"].items()}
        rest = body.copy()
        for p in parts.values():
            rest &= ~p
        food = (lab == FOOD) | (lab == FOOD2)
        croissant = biggest(food, 12, 600)
        out = {
            "hornL": biggest((lab == HORN) & (xx < 512), 2),
            "hornR": biggest((lab == HORN) & (xx >= 512), 2),
            "earL": parts["earL"],
            "earR": parts["earR"],
            "body": biggest(rest, 1),
        }
        for name, at in seeds["cream"].items():
            out[name] = biggest(lab == CREAM) if at is None else _comp(lab == CREAM, at)
        out["bread"] = croissant & (lab == FOOD)
        out["crust"] = croissant & (lab == FOOD2)
        crumbs = biggest(food & ~croissant, 40, 20)
        if crumbs.any():
            out["crumbs"] = crumbs
        for name in seeds["paws"]:
            out[name] = parts[name]
        return out

    return regions


def _comp(mask, at):
    """The part of `mask` at the point `at`, or at the nearest point of `mask`."""
    cc, _ = ndi.label(mask)
    _, (iy, ix) = ndi.distance_transform_edt(~mask, return_indices=True)
    x, y = at
    return cc == cc[iy[y, x], ix[y, x]]


def croissant_extras(pivots):
    def extras(out, st):
        fills = st["fills"]
        ys, xs = np.nonzero(fills["body"])
        out["pivots"] = dict(pivots, feet=[round(float(xs.mean()), 1), int(ys.max())])
        # The horns are hard and sit on one skull: when the soft body squeezes, both horns move
        # with the point between their roots (where each horn meets the head), and they keep
        # their shape. One point for both, so the tips that touch stay together.
        out["pivots"]["horns"] = [round(v, 1) for v in st["skull"]]
        x0, y0, x1, y1 = st["extent"]
        m = 24
        out["box"] = f"{x0 - m} {y0 - m} {x1 - x0 + 2 * m} {y1 - y0 + 2 * m}"

    return extras


def disc_mask(shape, cx, cy, r):
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def bite_mask(shape, cx, cy, radius):
    """A bite: a disc with a ring of tooth marks on its edge, so the edge reads as bitten."""
    tooth = radius * 0.3
    ring = radius - tooth
    out = disc_mask(shape, cx, cy, ring)
    for a in np.linspace(0, 2 * np.pi, 9, endpoint=False):
        out |= disc_mask(shape, cx + ring * np.sin(a), cy + ring * np.cos(a), tooth)
    return out


# The loader: the ram eats the croissant in four bites, one for each step of the bar. Each of the
# first three bites takes a scalloped disc out of the croissant (x, y, radius, in the frame of the
# croissant at rest), and holds the bites before it: the first takes the top of the middle, the
# second leaves half, the third cuts through and leaves the two ends. The fourth takes the rest.
BITES = [(478, 586, 46), (478, 590, 86), (478, 660, 96)]
CLOSE = 90


def eat_extras(out, st):
    """The bites of the croissant, and the parts that the croissant hid, drawn whole."""
    croissant_extras({"earL": [334, 324], "earR": [685, 355]})(out, st)
    fills, line, owner, lw = st["fills"], st["line"], st["owner"], st["lw"]
    front = st["front"]
    food = fills["bread"] | fills["crust"]
    food |= line & np.isin(owner, [front.index("bread"), front.index("crust")])
    r = lw / 2

    def band(mask):
        """A line one line wide along the edge of `mask`, with the edge in its middle."""
        return (ndi.distance_transform_edt(~mask) <= r) & (ndi.distance_transform_edt(mask) <= r)

    # The croissant and the paws hide the middle of the face and of the body, and they go up to
    # the mouth, so the parts behind them show: those parts are whole there. The cream of the
    # muzzle and of the chin is one egg (the image draws no line round it); the chin becomes part
    # of the muzzle. The body is its part of the image closed over the bays that the paws hid
    # (a disc of CLOSE rolls round it), with its outline where the left paw hid its edge. The
    # lines of the body and the muzzle at the edges of the held parts were slivers of their
    # outlines, so they go, and the new outline takes their place.
    held = np.zeros(food.shape, bool)
    for n in ("pawL", "pawR", "bread", "crust"):
        held |= fills[n] | (line & (owner == front.index(n)))
    m, b = front.index("muzzle"), front.index("body")
    owner[line & (owner == front.index("chin"))] = m
    cream = (fills["muzzle"] | fills["chin"]) & ~held
    ys, xs = np.nonzero(cream)
    hull = ConvexHull(np.c_[xs, ys])
    shape = Image.new("L", cream.shape[::-1], 0)
    ImageDraw.Draw(shape).polygon(
        [(float(xs[i]), float(ys[i])) for i in hull.vertices], fill=1
    )
    egg = cream | (np.asarray(shape).astype(bool) & held)
    # no points where the hull meets the edge of the muzzle
    fills["muzzle"] = cream | (ndi.binary_opening(egg, iterations=6) & held)
    del fills["chin"]
    solid = st["regions"]["body"] | (line & (owner == b)) | fills["muzzle"]
    grown = ndi.distance_transform_edt(~solid) <= CLOSE
    whole = ndi.binary_fill_holes(solid | (ndi.distance_transform_edt(grown) > CLOSE))
    near = ndi.binary_dilation(held, iterations=4)
    for k in (b, m):
        owner[line & (owner == k) & near] = -1
    st["more"]["body"] = whole & (ndi.distance_transform_edt(whole) <= lw) & near
    fills["body"] = (fills["body"] & ~(held & ~whole)) | (whole & held)

    # the bites, each with its own edge line where it cuts the croissant
    cuts, edges = [], []
    bitten = np.zeros(food.shape, bool)
    for cx, cy, radius in BITES:
        bitten = bitten | bite_mask(food.shape, cx, cy, radius)
        cuts.append(paths(bitten & ndi.binary_dilation(food, iterations=int(lw))))
        edges.append(band(bitten) & food)
    out["cuts"] = cuts
    out["bites"] = [paths(e) for e in edges]
    st["bites"] = edges
    # the top of the middle of the croissant, where the bites start and the crumbs fly from
    out["pivots"]["bite"] = list(BITES[0][:2])


GREY_SEEDS = [
    (200, 200, 200),
    (76, 76, 76),
    (40, 40, 40),
    (8, 8, 8),
    (248, 248, 248),
    (232, 168, 88),
    (200, 136, 64),
]

HUG = {
    "image": "ram-croissant-hug.png",
    "json": "ram-hug.json",
    "seeds": GREY_SEEDS,
    "small": {FOOD: 40, FOOD2: 40},
    "walls": [
        [(354, 304), (357, 266)],  # left ear root
        [(692, 350), (690, 270)],  # right ear root
    ],
    "regions": croissant_regions(
        {
            "body": {"earL": (305, 315), "earR": (740, 320), "pawL": (288, 638)},
            "cream": {"muzzle": None},
            "paws": ["pawL"],
        }
    ),
    "merge": {"body": ["walls"], "bread": ["crust"]},
    "under": [("earL", ["body", "walls"], 16), ("earR", ["body", "walls"], 16)],
    "front": [
        "pawL",
        "crust",
        "bread",
        "muzzle",
        "body",
        "earL",
        "earR",
        "hornL",
        "hornR",
    ],
    "head": "body",
    "face": ["muzzle"],
    "eyeRows": (370, 445),
    "mouthRows": (380, 520),
    "extras": croissant_extras({"earL": [355, 290], "earR": [691, 312]}),
}

EAT = {
    "image": "ram-croissant-eat.png",
    "json": "ram-eat.json",
    "seeds": GREY_SEEDS,
    "small": {FOOD: 40, FOOD2: 40},
    "walls": [
        [(333, 343), (336, 305)],  # left ear root
        [(685, 393), (684, 316)],  # right ear root
        [(648, 661), (612, 729)],  # the root of the right arm
    ],
    "regions": croissant_regions(
        {
            "body": {
                "earL": (290, 350),
                "earR": (740, 360),
                "pawL": (335, 655),
                "pawR": (595, 690),
            },
            "cream": {"muzzle": None, "chin": (477, 722)},
            "paws": ["pawL", "pawR"],
        }
    ),
    "merge": {"body": ["walls"], "bread": ["crust"]},
    "under": [
        ("earL", ["body", "walls"], 16),
        ("earR", ["body", "walls"], 16),
        # the croissant and the paws move when the ram chews, so the parts behind them go under them
        ("body", ["bread", "crust", "pawL", "pawR"], 22),
        ("muzzle", ["bread", "crust", "pawL", "pawR"], 16),
        ("chin", ["bread", "crust", "pawL", "pawR"], 16),
    ],
    "front": [
        "pawL",
        "pawR",
        "crust",
        "bread",
        "crumbs",
        "muzzle",
        "chin",
        "body",
        "earL",
        "earR",
        "hornL",
        "hornR",
    ],
    "head": "body",
    "face": ["muzzle", "chin", "crumbs"],
    "eyeRows": (430, 510),
    "mouthRows": (460, 780),
    "extras": eat_extras,
}

POSES = {"pudding": PUDDING, "hug": HUG, "eat": EAT}


def main():
    """Trace every pose; with --site, write the files of the concept front page."""
    results, states = {}, {}
    for key, pose in POSES.items():
        out, st = trace(pose)
        pose["extras"](out, st)
        draw(out, st)
        # the drawn parts first, as before the extras
        first = ("size", "lineWidth", "fills", "lines", "eyes", "mouth", "ridges")
        out = {**{k: out[k] for k in first}, **out}
        out["order"] =list(reversed([n for n in pose["front"] if n in out["fills"]]))
        if key == "pudding":
            del out["order"]
        results[key] = out
        states[key] = (pose, st)
    # the second set of lines: the same lines, painted with the brush of the front page
    if BRUSH_TS.exists():
        for key, brushed in brush(states).items():
            results[key]["brush"] = brushed
    else:
        print("no site brush at", BRUSH_TS, "- the ram keeps its solid lines only")
    for key, pose in POSES.items():
        (BRAND / pose["json"]).write_text(json.dumps(results[key]))
        print("wrote", BRAND / pose["json"])
    if SITE is None:
        return

    # ---------- the files of the concept front page ----------
    R = results["pudding"]
    INK, BODY_C, HORN_C, CREAM_C, CUSTARD_C, CARAMEL_C = (
        "#301D17",
        "#9C7A5E",
        "#E2D5BC",
        "#FBF0DC",
        "#F0B141",
        "#B54D1F",
    )

    def nums(d):
        v = [float(t) for t in re.findall(r"-?\d+(?:\.\d+)?", d)]
        return v[0::2], v[1::2]

    def box(*ds):
        xs, ys = [], []
        for d in ds:
            x, y = nums(d)
            xs += x
            ys += y
        return min(xs), min(ys), max(xs), max(ys)

    F, L = R["fills"], R["lines"]
    # the frame of the drawing before the horns were made smaller, so every frame keeps its size
    x0, y0, x1, y1 = box(*F.values(), *states["pudding"][1]["hornsBefore"])
    cx = (x0 + x1) / 2
    side = max(x1 - x0, y1 - y0) + 70
    hx0, hy0, hx1, hy1 = box(R["puddingHull"])
    # the view boxes that the page asks for, as the ram's own frames
    boxes = {
        "67 97 860 860": f"{cx - side / 2:.0f} {(y0 + y1) / 2 - side / 2:.0f} {side:.0f} {side:.0f}",
        "127 120 740 740": f"{cx - 412:.0f} {y0 - 22:.0f} 824 824",
        "167 137 660 668": f"{cx - 415:.0f} {y0 - 22:.0f} 830 660",
        "246 612 480 296": f"{hx0 - 24:.0f} {hy0 - 24:.0f} {hx1 - hx0 + 48:.0f} {hy1 - hy0 + 44:.0f}",
    }
    # the wordmark: the ram in one colour beside the letters of the cat wordmark
    WD = re.search(
        r' d="([^"]+)"', (ROOT / "docs/brand/purin-logo/purin-wordmark.svg").read_text()
    ).group(1)
    letters = "".join(
        "M" + s
        for s in WD.split("M")[1:]
        if float(re.match(r"\s*(-?[\d.]+)", s).group(1)) > 480
    )
    lx0, _, lx1, _ = box(letters)
    mx0, my0, mx1, my1 = box(R["mono"])
    h = 554 * 0.98
    k = h / (my1 - my0)
    wx0 = lx0 - 26 - (mx1 - mx0) * k
    tx, ty = wx0 - mx0 * k, 554 - h - my0 * k
    WW = lx1 - wx0
    Path(SITE, "ram-wordmark.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Purin" viewBox="{wx0:.1f} 0 {WW:.1f} 554"><g fill="#000">'
        f'<path fill-rule="evenodd" transform="translate({tx:.1f} {ty:.1f}) scale({k:.4f})" d="{R["mono"]}"/>'
        f'<path fill-rule="evenodd" d="{letters}"/></g></svg>'
    )

    keys = (
        "fills",
        "lines",
        "eyes",
        "mouth",
        "ridges",
        "puddingHull",
        "pivots",
        "lineWidth",
        "brush",
        "grab",
    )
    data = {k: R[k] for k in keys if k in R}
    data["boxes"] = boxes
    # the width of the wordmark for each unit of its height
    data["wordmarkRatio"] = round(WW / 554, 4)
    HEADER = [
        "   Generated by scripts/brand/trace-purin-ram.py in purin-labs/pantry. Units: the 1024 box of the drawing.",
        "   Each fill reaches the middle of its drawn line; the lines are their own shapes, owned by the part in front. */",
        "",
    ]
    ts = [
        "/* The Purin ram, traced from docs/brand/purin-ram/reference/ram-pudding.jpg (concept, not the logo).",
        *HEADER,
        "export const R = " + json.dumps(data, indent=2) + " as const;",
        "",
    ]
    Path(SITE, "ram-paths.ts").write_text("\n".join(ts))

    pose_keys = (
        "fills",
        "lines",
        "order",
        "eyes",
        "mouth",
        "ridges",
        "pivots",
        "box",
        "lineWidth",
        "brush",
        "cuts",
        "bites",
    )
    ts = [
        "/* The Purin ram with a croissant: it hugs one, and it eats one (concept poses). Traced from",
        "   docs/brand/purin-ram/reference/ram-croissant-hug.png and ram-croissant-eat.png.",
        *HEADER,
        "export const RAM_HUG = "
        + json.dumps(
            {k: results["hug"][k] for k in pose_keys if k in results["hug"]}, indent=2
        )
        + " as const;",
        "",
        "export const RAM_EAT = "
        + json.dumps(
            {k: results["eat"][k] for k in pose_keys if k in results["eat"]}, indent=2
        )
        + " as const;",
        "",
    ]
    Path(SITE, "ram-poses.ts").write_text("\n".join(ts))

    # the icon: the colour ram on the cream tile
    def colour():
        def fill(n, c):
            return f'<path d="{F[n]}" fill="{c}" fill-rule="evenodd"/>'

        def lines(n):
            return (
                f'<path d="{L[n]}" fill="{INK}" fill-rule="evenodd"/>' if n in L else ""
            )

        return (
            fill("custard", CUSTARD_C)
            + fill("caramel", CARAMEL_C)
            + fill("chest", BODY_C)
            + lines("custard")
            + lines("caramel")
            + lines("chest")
            + fill("hornL", HORN_C)
            + fill("hornR", HORN_C)
            + lines("hornL")
            + lines("hornR")
            + f'<path d="{R["ridges"]["hornL"]}{R["ridges"]["hornR"]}" fill="{INK}"/>'
            + fill("earL", BODY_C)
            + lines("earL")
            + fill("earR", BODY_C)
            + lines("earR")
            + fill("head", BODY_C)
            + lines("head")
            + fill("muzzle", CREAM_C)
            + lines("muzzle")
            + f'<path d="{R["mouth"]}" fill="{INK}"/>'
            + "".join(f'<path d="{d}" fill="{INK}"/>' for d in R["eyes"])
        )

    s = 0.82 * 1024 / max(x1 - x0, y1 - y0)
    cy = (y0 + y1) / 2
    Path(SITE, "ram-icon.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>Purin ram</title><rect width="1024" height="1024" rx="228" fill="{CREAM_C}"/>'
        f'<g transform="translate(512 518) scale({s:.4f}) translate({-cx:.1f} {-cy:.1f})">{colour()}</g></svg>'
    )
    print("wordmark ratio", round(WW / 554, 4), boxes)


if __name__ == "__main__":
    main()
