"""Trace the Purin wordmark from its reference image into two SVG files.

Run from the repository root:
    python3 scripts/brand/trace-purin-wordmark.py

Reads   docs/brand/purin-logo/reference/wordmark-black-on-cream.jpg
Writes  docs/brand/purin-logo/purin-wordmark.svg   the cat and the word PURIN
        docs/brand/purin-logo/purin-mark-mono.svg  the cat alone

Needs Pillow, numpy, scipy and contourpy.

The image has one ink colour on a light ground, so one luminance threshold
finds the ink. The first empty column after the cat splits the cat from the
word. Both files use `currentColor`, so the page sets the colour, and a page
can use either file as a CSS mask.
"""

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from curve_fit import outlines

SOURCE = "docs/brand/purin-logo/reference/wordmark-black-on-cream.jpg"
FOLDER = "docs/brand/purin-logo"
# One SVG unit is one image pixel. A smaller scale breaks the cat's mouth, and
# a smaller tolerance makes the curves follow the JPEG noise.
TOLERANCE = 0.8  # the largest distance from the outline to a curve, in pixels
MARGIN = 4  # clear space round the ink, in pixels


def svg(mask, label):
    """The ink of a mask as one SVG file, cropped to the ink plus a margin."""
    ys, xs = np.where(mask)
    x0, y0 = xs.min() - MARGIN, ys.min() - MARGIN
    crop = mask[y0 : ys.max() + 1 + MARGIN, x0 : xs.max() + 1 + MARGIN]
    height, width = crop.shape
    # An outline of ink and an outline of a hole both go into one path; the
    # even-odd rule then leaves each hole open.
    path = "".join(outlines(crop, 1, TOLERANCE))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{label}" '
        f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<path fill="currentColor" fill-rule="evenodd" d="{path}"/></svg>\n'
    ), (width, height)


def main():
    image = np.asarray(Image.open(SOURCE).convert("L")).astype(float)
    ink = ndi.gaussian_filter(image, 1.2) < 128

    # the cat ends at the first empty column after the first ink column
    columns = ink.any(axis=0)
    first = int(np.argmax(columns))
    gap = first + int(np.argmin(columns[first:]))
    cat = ink.copy()
    cat[:, gap:] = False

    for name, mask, label in (
        ("purin-wordmark.svg", ink, "Purin"),
        ("purin-mark-mono.svg", cat, "Purin"),
    ):
        text, size = svg(mask, label)
        with open(f"{FOLDER}/{name}", "w") as handle:
            handle.write(text)
        print("wrote", name, size, len(text), "bytes")


if __name__ == "__main__":
    main()
