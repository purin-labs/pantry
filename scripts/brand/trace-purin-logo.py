"""Trace the Purin cat mark from its source image into clean cubic curves.

Run from the repository root:
    python3 scripts/brand/trace-purin-logo.py

Reads   docs/brand/purin-logo/source.jpg  (2000 x 2000, four flat colours)
Writes  docs/brand/purin-logo/paths.json  (units: a 1024 box)

Then run `node scripts/brand/build-purin-logo.mjs` to build the SVG files, the
icon pack and the Portal component data from the curves.

Needs Pillow, numpy, scipy and contourpy.

The image has four flat colours, so three channel thresholds split it:
luminance finds the cat, blue finds the pudding and green finds the caramel.
Each layer becomes a soft mask, contourpy reads its outline below one pixel,
and a Schneider fit turns the outline into a few cubic curves.
"""

import json
import re

import numpy as np
from contourpy import contour_generator
from PIL import Image
from scipy import ndimage as ndi

SOURCE = "docs/brand/purin-logo/source.jpg"
OUTPUT = "docs/brand/purin-logo/paths.json"
BOX = 1024
TOLERANCE = 0.4  # the largest distance from the outline to a curve, in box units


# ---------- Schneider curve fit ----------
def norm(v):
    n = np.hypot(*v)
    return v / n if n > 0 else v


def bezier(b, t):
    mt = 1 - t
    return (
        (mt**3)[:, None] * b[0]
        + (3 * mt * mt * t)[:, None] * b[1]
        + (3 * mt * t * t)[:, None] * b[2]
        + (t**3)[:, None] * b[3]
    )


def chord(pts):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    return d / d[-1]


def generate(pts, u, t1, t2):
    p0, p3 = pts[0], pts[-1]
    mt = 1 - u
    b1, b2 = 3 * mt * mt * u, 3 * mt * u * u
    a1 = t1[None, :] * b1[:, None]
    a2 = t2[None, :] * b2[:, None]
    c = np.array(
        [[np.sum(a1 * a1), np.sum(a1 * a2)], [np.sum(a1 * a2), np.sum(a2 * a2)]]
    )
    rest = pts - ((mt**3 + b1)[:, None] * p0 + (b2 + u**3)[:, None] * p3)
    x = np.array([np.sum(a1 * rest), np.sum(a2 * rest)])
    seg = np.hypot(*(p3 - p0))
    l1 = l2 = 0.0
    if abs(np.linalg.det(c)) > 1e-9:
        l1, l2 = np.linalg.solve(c, x)
    if l1 < seg * 1e-3 or l2 < seg * 1e-3:
        l1 = l2 = seg / 3
    return np.array([p0, p0 + t1 * l1, p3 + t2 * l2, p3])


def max_error(pts, b, u):
    d = np.sum((bezier(b, u) - pts) ** 2, axis=1)
    i = int(np.argmax(d))
    return d[i], i


def reparameterize(pts, b, u):
    d1 = 3 * (b[1:] - b[:-1])
    d2 = 2 * (d1[1:] - d1[:-1])
    out = u.copy()
    for i, t in enumerate(u):
        mt = 1 - t
        q = mt**3 * b[0] + 3 * mt * mt * t * b[1] + 3 * mt * t * t * b[2] + t**3 * b[3]
        q1 = mt * mt * d1[0] + 2 * mt * t * d1[1] + t * t * d1[2]
        q2 = mt * d2[0] + t * d2[1]
        den = np.dot(q1, q1) + np.dot(q - pts[i], q2)
        if abs(den) > 1e-12:
            out[i] = min(1, max(0, t - np.dot(q - pts[i], q1) / den))
    return out


def fit(pts, t1, t2, err):
    if len(pts) == 2:
        d = np.hypot(*(pts[1] - pts[0])) / 3
        return [np.array([pts[0], pts[0] + t1 * d, pts[1] + t2 * d, pts[1]])]
    u = chord(pts)
    b = generate(pts, u, t1, t2)
    e, i = max_error(pts, b, u)
    if e < err:
        return [b]
    if e < err * 9:
        for _ in range(12):
            u = reparameterize(pts, b, u)
            b = generate(pts, u, t1, t2)
            e, i = max_error(pts, b, u)
            if e < err:
                return [b]
    i = min(max(i, 1), len(pts) - 2)
    tc = norm(pts[i - 1] - pts[i + 1])
    return fit(pts[: i + 1], t1, tc, err) + fit(pts[i:], -tc, t2, err)


def resample(p, step=1.0):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.linspace(0, d[-1], max(8, int(d[-1] / step)), endpoint=False)
    return np.c_[np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])]


def corners(p, k=7, threshold=48):
    n = len(p)
    angle = np.zeros(n)
    for i in range(n):
        v1 = p[i] - p[(i - k) % n]
        v2 = p[(i + k) % n] - p[i]
        c = np.dot(v1, v2) / (np.hypot(*v1) * np.hypot(*v2) + 1e-12)
        angle[i] = np.degrees(np.arccos(np.clip(c, -1, 1)))
    return [
        i
        for i in range(n)
        if angle[i] > threshold
        and angle[i] == max(angle[(i + j) % n] for j in range(-k, k + 1))
    ]


def fit_closed(p, err):
    """One closed outline to an SVG path of cubic curves."""
    p = resample(p)
    n = len(p)
    cs = corners(p)
    if not cs:
        t = norm(p[2] - p[-2])
        segs = fit(np.r_[p, p[:1]], t, -t, err)
    else:
        segs = []
        for a, b in zip(cs, cs[1:] + [cs[0] + n]):
            q = np.array([p[j % n] for j in range(a, b + 1)])
            k = min(4, len(q) - 1)
            segs += fit(q, norm(q[k] - q[0]), norm(q[-1 - k] - q[-1]), err)
    f = lambda v: ("%.1f" % v).rstrip("0").rstrip(".")
    d = "M" + f(segs[0][0][0]) + " " + f(segs[0][0][1])
    for s in segs:
        d += "C" + " ".join(f(v) for v in s[1:].ravel())
    return d + "Z"


# ---------- layers ----------
def largest(mask):
    labels, count = ndi.label(mask)
    sizes = ndi.sum(mask, labels, range(1, count + 1))
    return labels == int(np.argmax(sizes)) + 1


def disk(r):
    return np.hypot(*np.mgrid[-r : r + 1, -r : r + 1]) <= r


def main():
    image = np.asarray(Image.open(SOURCE).convert("RGB")).astype(float)
    scale = BOX / image.shape[0]
    soft = ndi.gaussian_filter(image, (1.2, 1.2, 0))
    lum, green, blue = soft.mean(-1), soft[..., 1], soft[..., 2]
    yy, xx = np.mgrid[0 : image.shape[0], 0 : image.shape[1]]

    cat = largest(lum < 135)
    near_cat = ndi.binary_dilation(cat, structure=disk(4))
    pudding = ndi.binary_fill_holes(largest((blue < 140) & ~near_cat))
    caramel = largest((green < 128) & pudding)

    # the eyes and the mouth: the holes in the cat
    holes = ndi.binary_fill_holes(cat) & ~cat
    labels, count = ndi.label(holes)
    face = np.zeros_like(cat)
    for i in range(1, count + 1):
        if (labels == i).sum() > 400:
            face |= labels == i

    ys, xs = np.where(pudding)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cat_bottom = np.where(cat)[0].max()
    row = cat_bottom - 40
    in_pudding = np.flatnonzero(pudding[row])
    in_cat = np.flatnonzero(cat[row])
    halo = int(in_pudding.min() - in_cat[in_cat < in_pudding.min()].max())

    # The pudding hides a part of the cat. Fill that pocket, so the whole cat
    # is one shape behind the pudding.
    pocket = (
        (xx > x0 - halo - 8)
        & (xx < x1 + halo + 8)
        & (yy > y0 - halo - 8)
        & (yy <= cat_bottom)
    )
    cat_full = ndi.binary_fill_holes(cat | pocket)
    # the cream gap: the pocket in the cat, plus a halo round the pudding below the cat
    below = ndi.binary_dilation(pudding, structure=disk(halo)) & (yy >= cat_bottom - 6)
    gap = ndi.binary_fill_holes((pocket & ~cat) | pudding | below)
    # The caramel reaches a little past the rim, sideways and up only, so no
    # custard line shows there. The SVG clips the caramel to the pudding.
    grow = ndi.binary_dilation(caramel, structure=np.ones((1, 15), bool))
    for k in range(1, 8):
        grow[:-k] |= caramel[k:]
    caramel_out = caramel | (grow & ~ndi.binary_erosion(pudding, structure=disk(5)))

    def outlines(mask):
        field = ndi.gaussian_filter(mask.astype(float), 1.6)
        lines = contour_generator(z=field).lines(0.5)
        return [
            fit_closed((ln[:-1] + 0.5) * scale, TOLERANCE**2)
            for ln in sorted(lines, key=len, reverse=True)
            if len(ln) >= 40
        ]

    cys, cxs = np.where(cat)
    unit = lambda v: round(float(v) * scale, 1)
    out = {
        "note": "Traced from source.jpg by scripts/brand/trace-purin-logo.py. Units: a 1024 box.",
        "catPivot": [unit((cxs.min() + cxs.max()) / 2), unit(cat_bottom + 0.5)],
        "puddingPivot": [unit((x0 + x1) / 2), unit(y1 + 0.5)],
        "bbox": [unit(min(cxs.min(), x0)), unit(cys.min()), unit(max(cxs.max(), x1)), unit(y1)],
        "cat": outlines(cat_full)[0],
        "face": outlines(face),
        "pudding": outlines(pudding)[0],
        "caramel": outlines(caramel_out),
        "gap": outlines(gap)[0],
    }
    text = json.dumps(out, indent=2)
    # a list of numbers goes on one line, as Prettier formats it
    text = re.sub(
        r"\[\s+((?:-?[\d.]+,\s+)*-?[\d.]+)\s+\]",
        lambda m: "[" + ", ".join(m.group(1).split()).replace(",,", ",") + "]",
        text,
    )
    with open(OUTPUT, "w") as handle:
        handle.write(text + "\n")
    print("wrote", OUTPUT, {k: len(v) for k, v in out.items() if k in ("face", "caramel")})


if __name__ == "__main__":
    main()
