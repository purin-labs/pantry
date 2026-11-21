"""The eyes of the Purin cat.

The trace scripts in this folder share this module. The owner asked for eyes
that are a little taller than they are wide (21 November 2026). The source
images have rounder eyes, so each script traces an eye and then stretches its
curve about the middle of the eye.

Needs numpy and scipy.
"""

import re

import numpy as np
from scipy import ndimage as ndi

from curve_fit import number, outlines

# width and height of an eye, as parts of the traced eye
EYE_STRETCH = (0.955, 1.055)


def eye_holes(cat):
    """The two eyes of a cat mask, the left eye first: its two largest holes."""
    labels, count = ndi.label(ndi.binary_fill_holes(cat) & ~cat)
    holes = sorted(
        (labels == i for i in range(1, count + 1)), key=np.sum, reverse=True
    )
    return sorted(holes[:2], key=lambda hole: np.where(hole)[1].min())


def eye_outline(eye, scale, tolerance):
    """The outline of one eye as an SVG path, stretched by `EYE_STRETCH`."""
    ys, xs = np.where(eye)
    middle = (
        (xs.min() + xs.max() + 1) / 2 * scale,
        (ys.min() + ys.max() + 1) / 2 * scale,
    )
    values = iter(range(10**6))

    def move(match):
        axis = next(values) % 2  # a path holds x and y in turn
        value = middle[axis] + (float(match.group()) - middle[axis]) * EYE_STRETCH[axis]
        return number(value)

    return re.sub(r"-?\d+(?:\.\d+)?", move, outlines(eye, scale, tolerance)[0])
