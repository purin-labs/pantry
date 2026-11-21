# Purin logo

The Purin mark is a dark cat that looks at a custard pudding. The owner chose
this image on 19 November 2026. The mark has four flat colours:

| Colour  | Value     | Use                           |
| ------- | --------- | ----------------------------- |
| Cat     | `#301D17` | The cat                       |
| Custard | `#F0B141` | The pudding body              |
| Caramel | `#B54D1F` | The sauce                     |
| Cream   | `#FBF0DC` | Eyes, mouth and the icon tile |

Nothing uses the mark yet. The Portal shows the goat mark until the brand
switch; `apps/portal/public/brand/README.md` describes the goat files.

## Files

| File                      | What it is                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `source.jpg`              | The image that the owner supplied                                                                              |
| `paths.json`              | The traced curves, in a 1024 box                                                                               |
| `purin-mark.svg`          | The mark on a transparent ground                                                                               |
| `purin-mark-animated.svg` | The mark with its motion inside the file                                                                       |
| `purin-icon.svg`          | The mark on its cream tile                                                                                     |
| `purin-icon-animated.svg` | The tile with its motion inside the file                                                                       |
| `icon-pack/`              | Favicons, application icons and PNG marks (see below)                                                          |
| `purin-wordmark.svg`      | The cat and the word PURIN in one colour (`currentColor`), traced from `reference/wordmark-black-on-cream.jpg` |
| `purin-mark-mono.svg`     | The cat of the wordmark alone, in one colour                                                                   |
| `reference/`              | The images that the owner supplied on 21 November 2026: two colour marks and the black wordmark                |
| `preview/`                | A GIF and an MP4 of the motion, recorded from `purin-mark-animated.svg`. The build script does not make them   |

`scripts/brand/trace-purin-wordmark.py` writes the two one-colour files. A page
sets their colour, or uses one as a CSS mask, so they work on a light ground
and on a dark ground. The company site (`purin.io`) shows the wordmark in its
header and footer.

The cat is dark, so the mark belongs on a light ground. On a dark ground, use
the icon: its tile carries its own cream ground.

The cream gap round the pudding is a cut-out in the cat, so the ground shows
through it. The eyes and the mouth are filled with cream on every ground.

## Icon pack

| File                            | Size       | Use                                            |
| ------------------------------- | ---------- | ---------------------------------------------- |
| `favicon.svg`                   | vector     | Browser tab, modern browsers                   |
| `favicon.ico`                   | 16, 32, 48 | Browser tab, old browsers                      |
| `favicon-16.png` … `-48.png`    | 16, 32, 48 | Browser tab, as single files                   |
| `apple-touch-icon.png`          | 180        | iOS home screen. A full square: iOS cuts it    |
| `icon-192.png`, `icon-512.png`  | 192, 512   | Installed web application                      |
| `icon-1024.png`                 | 1024       | Slack and other application icons              |
| `icon-maskable-192.png`, `-512` | 192, 512   | Android. A full square, mark in the middle 80% |
| `mark-64.png` … `mark-1024.png` | 64 to 1024 | The mark on a transparent ground               |
| `site.webmanifest`              |            | The manifest that names the application icons  |

The mark on a favicon is larger than on the application icon, because a
favicon is small. Below 32 px the face and the caramel drips merge.

Put these lines in the page head, with the files at the site root:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/site.webmanifest" />
```

## Components

The Portal has two React components in `apps/portal/src/ui`:

```tsx
import { PurinIcon, PurinMark } from "../../ui";

<PurinIcon size={32} label="Purin" />
<PurinMark animated className="welcome-mark" />
```

`animated` makes the cat sway and the pudding jiggle. `label` gives the
accessible name; without it the mark is decoration. `size` sets the width and
the height in pixels; without it, CSS sets them.

## Motion

The cat is the cause and the pudding is the effect.

- The cat leans left, then right, about the middle of its bottom edge. One
  full sway takes 4.8 seconds.
- Each time the cat turns round, the pudding leans and squashes a little, at
  2.4 Hz, and comes to rest in about 1.7 seconds.
- The cut-out moves with the pudding.
- The less-motion setting of the device stops the motion.

The animated SVG files carry the motion as CSS, so they need no script and
they move as a plain image.

## Rebuild

To use a new image, replace `source.jpg` and trace it. The trace script
expects four flat colours and the same layout: a dark cat, and a pudding that
is lower than the cat.

```bash
python3 scripts/brand/trace-purin-logo.py
node scripts/brand/build-purin-logo.mjs
```

The first command writes `paths.json`. It needs Pillow, numpy, scipy and
contourpy. The second command writes every other file in this folder, and
`purin-mark-paths.ts` and `purin-mark.css` in `apps/portal/src/ui`. To change
a colour, a size or the motion, edit the constants at the top of
`build-purin-logo.mjs` and run it again.
