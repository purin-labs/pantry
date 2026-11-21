"""Turn a pixel mask into clean cubic curves.

The trace scripts in this folder share this module. contourpy reads the outline
of a soft mask below one pixel, and a Schneider fit turns the outline into a
few cubic curves.

Needs numpy, scipy and contourpy.
"""

import numpy as np
from contourpy import contour_generator
from scipy import ndimage as ndi


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


def number(v):
    """A coordinate of an SVG path: one decimal place, with no zero at the end."""
    return ("%.1f" % v).rstrip("0").rstrip(".")


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
    d = "M" + number(segs[0][0][0]) + " " + number(segs[0][0][1])
    for s in segs:
        d += "C" + " ".join(number(v) for v in s[1:].ravel())
    return d + "Z"


def outlines(mask, scale, tolerance):
    """The closed outlines of a mask as SVG paths, the longest first.

    `scale` turns pixels into output units. `tolerance` is the largest distance
    from the outline to a curve, in output units.
    """
    field = ndi.gaussian_filter(mask.astype(float), 1.6)
    lines = contour_generator(z=field).lines(0.5)
    return [
        fit_closed((ln[:-1] + 0.5) * scale, tolerance**2)
        for ln in sorted(lines, key=len, reverse=True)
        if len(ln) >= 40
    ]
