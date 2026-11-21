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
Each layer becomes a mask, and `curve_fit.py` turns its outline into a few
cubic curves.
"""

import json
import re

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from curve_fit import outlines as mask_outlines

SOURCE = "docs/brand/purin-logo/source.jpg"
OUTPUT = "docs/brand/purin-logo/paths.json"
BOX = 1024
TOLERANCE = 0.4  # the largest distance from the outline to a curve, in box units


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
        return mask_outlines(mask, scale, TOLERANCE)

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
