"""Draw the Paper theme's dot fields: packages/frontend-themes/paper-dots-N.png.

A dithered cloud on a fixed dot grid, in the manner of intercom.com: dark
dots fill a ragged mass, and faint dots scatter in blocks around it. The
image is a mask: only its alpha counts, and the theme sets the dot colour.
It is drawn at 2x, so one CSS pixel is two image pixels. Each variant has
its own seed and cloud shape; the Portal picks one on each page load.

    python3 scripts/frontend-themes/paper-dots.py
"""

import math
import random
from pathlib import Path

from PIL import Image

WIDTH, HEIGHT = 1000, 750  # CSS px
SCALE = 2
STEP = 7  # grid pitch, CSS px
OUT_DIR = Path(__file__).resolve().parents[2] / "packages/frontend-themes"
# Seed, and the cloud's half-width and half-height as parts of the image.
VARIANTS = [
    (20261103, 0.44, 0.44),
    (5150, 0.54, 0.4),
    (31337, 0.42, 0.4),
]

rng = random.Random()
LATTICES = []


def lattice(size):
    return [[rng.random() for _ in range(size)] for _ in range(size)]


def value_noise(x, y, lat):
    x0, y0 = math.floor(x), math.floor(y)
    fx, fy = x - x0, y - y0
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    n = len(lat)
    a = lat[y0 % n][x0 % n]
    b = lat[y0 % n][(x0 + 1) % n]
    c = lat[(y0 + 1) % n][x0 % n]
    d = lat[(y0 + 1) % n][(x0 + 1) % n]
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy


def fbm(x, y):
    total, amp, norm = 0.0, 1.0, 0.0
    for octave, lat in enumerate(LATTICES):
        f = 2**octave / 200
        total += amp * value_noise(x * f, y * f, lat)
        norm += amp
        amp *= 0.55
    return total / norm


def envelope(x, y, rx, ry):
    # 1 at the centre, 0 at the ellipse edge, smooth between.
    d = math.hypot((x - WIDTH / 2) / rx, (y - HEIGHT / 2) / ry)
    t = max(0.0, min(1.0, 1 - d))
    return t * t * (3 - 2 * t)


def draw(seed, rx, ry, out):
    rng.seed(seed)
    LATTICES[:] = [lattice(64) for _ in range(4)]
    image = Image.new("LA", (WIDTH * SCALE, HEIGHT * SCALE), (0, 0))
    px = image.load()
    cols, rows = WIDTH // STEP, HEIGHT // STEP
    off_x = (WIDTH - (cols - 1) * STEP) / 2
    off_y = (HEIGHT - (rows - 1) * STEP) / 2
    for j in range(rows):
        for i in range(cols):
            x, y = off_x + i * STEP, off_y + j * STEP
            # Sample the noise on blocks of 2x2 cells, so holes and edges
            # break along the grid, as in a coarse dither.
            bx, by = (i // 2) * 2 * STEP, (j // 2) * 2 * STEP
            n = fbm(bx, by)
            mass = envelope(x, y, WIDTH * rx, HEIGHT * ry) + 1.6 * (n - 0.5)
            # A soft edge band, filled by chance: the cloud frays into
            # single dots and pairs instead of a clean outline.
            fill = max(0.0, min(1.0, (mass - 0.3) / 0.22))
            hole = fbm(bx * 2 + 400, by * 2 + 400) < 0.3
            halo = envelope(x, y, WIDTH * 0.7, HEIGHT * 0.7)
            # The image does not tile, so every dot fades out before the edge.
            edge = min(x, y, WIDTH - x, HEIGHT - y) / 120
            edge = max(0.0, min(1.0, edge))
            fill *= edge
            fx, fy = (i // 3) * 3 * STEP, (j // 3) * 3 * STEP
            if rng.random() < fill and not hole:
                alpha, size = 200, 3
            elif (
                fbm(fx + 900, fy + 900) > 0.5 - 0.25 * halo
                and rng.random() < 0.85 * edge * edge
            ):
                alpha, size = 60, 2
            else:
                continue
            cx, cy = round(x * SCALE), round(y * SCALE)
            for dy in range(size):
                for dx in range(size):
                    px[cx - size // 2 + dx, cy - size // 2 + dy] = (0, alpha)
    image.save(out, optimize=True)
    print(f"{out} {out.stat().st_size} bytes")


def main():
    for number, (seed, rx, ry) in enumerate(VARIANTS, start=1):
        draw(seed, rx, ry, OUT_DIR / f"paper-dots-{number}.png")


if __name__ == "__main__":
    main()
