// Builds the Purin cat mark from its traced curves.
//
//   node scripts/brand/build-purin-logo.mjs
//
// Reads   docs/brand/purin-logo/paths.json   (from scripts/brand/trace-purin-logo.py)
// Writes  docs/brand/purin-logo/*.svg                  the mark and the app icon, static and animated
//         docs/brand/purin-logo/icon-pack/*            favicons, app icons and PNG marks
//         apps/portal/src/ui/purin-mark-paths.ts       the curves for the PurinMark component
//         apps/portal/src/ui/purin-mark.css            the motion for the PurinMark component
//
// The PNG and ICO files need `sharp`. No package declares it; pnpm hoists it
// for another package. If it is missing, run with --no-png for the other files.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const logoDir = path.join(root, "docs/brand/purin-logo");
const packDir = path.join(logoDir, "icon-pack");
const uiDir = path.join(root, "apps/portal/src/ui");
const withPng = !process.argv.includes("--no-png");

const traced = JSON.parse(
  await readFile(path.join(logoDir, "paths.json"), "utf8"),
);
const PATHS = {
  cat: traced.cat,
  face: traced.face.join(""),
  pudding: traced.pudding,
  caramel: traced.caramel.join(""),
  gap: traced.gap,
};
const COLOURS = {
  cat: "#301D17",
  cream: "#FBF0DC",
  custard: "#F0B141",
  caramel: "#B54D1F",
};
const BOX = 1024;
const MARK_VIEW_BOX = "67 97 860 860";
const CAT_PIVOT = traced.catPivot; // the middle of the cat's bottom edge
const PUDDING_PIVOT = traced.puddingPivot; // the bottom of the pudding
const CENTRE = [
  Math.round((traced.bbox[0] + traced.bbox[2]) / 2),
  Math.round((traced.bbox[1] + traced.bbox[3]) / 2),
];
// How large the mark is on a tile. A favicon is small, so its mark is larger.
// A maskable icon keeps the mark inside the middle 80%.
const TILE_SCALE = { icon: 0.9, favicon: 1.12, touch: 0.88, maskable: 0.78 };
const TILE_RADIUS = 228;

const SWAY = { period: 4.8, lean: 2.6, tilt: 0.5 };
const JIGGLE = {
  lean: 5,
  hz: 2.4,
  fade: 0.55,
  squash: 0.05,
  squashHz: 3.1,
  squashFade: 0.35,
};
const round = (value, digits = 3) => Number(value.toFixed(digits));

/** One burst of jelly wobble at `t` seconds: a lean and a squash that both fade. */
function wobble(t, direction) {
  const lean =
    direction *
    JIGGLE.lean *
    Math.exp(-t / JIGGLE.fade) *
    Math.sin(2 * Math.PI * JIGGLE.hz * t);
  const squash =
    JIGGLE.squash *
    Math.exp(-t / JIGGLE.squashFade) *
    Math.sin(2 * Math.PI * JIGGLE.squashHz * t);
  return `skewX(${round(lean, 2)}deg) scale(${round(1 + 0.6 * squash)},${round(1 - squash)})`;
}

/** The pudding wobbles each time the cat turns round: two bursts in one sway. */
function keyframes(name) {
  const half = SWAY.period / 2;
  const steps = 24;
  let jiggle = "";
  for (let burst = 0; burst < 2; burst += 1) {
    for (let step = 0; step < steps; step += 1) {
      const t = (step * half) / steps;
      const percent = round(((burst * half + t) / SWAY.period) * 100, 2);
      jiggle += `${percent}%{transform:${wobble(t, burst ? -1 : 1)}}`;
    }
  }
  jiggle += `100%{transform:${wobble(0, 1)}}`;
  return (
    `@keyframes ${name}-sway{0%,100%{transform:skewX(${SWAY.lean}deg) rotate(${-SWAY.tilt}deg)}` +
    `50%{transform:skewX(${-SWAY.lean}deg) rotate(${SWAY.tilt}deg)}}` +
    `@keyframes ${name}-jiggle{${jiggle}}`
  );
}

/** A group that turns about `pivot`. It needs no transform-origin in user units. */
const about = (pivot, className, inner) =>
  `<g transform="translate(${pivot[0]} ${pivot[1]})"><g class="${className}">` +
  `<g transform="translate(${-pivot[0]} ${-pivot[1]})">${inner}</g></g></g>`;

/** The drawing with no <svg> wrapper. `id` keeps the mask and clip names apart. */
function artwork(id, animated) {
  const pudding = (inner) =>
    animated ? about(PUDDING_PIVOT, `${id}-pudding`, inner) : inner;
  const cat =
    `<path d="${PATHS.cat}" fill="${COLOURS.cat}"/>` +
    `<path d="${PATHS.face}" fill="${COLOURS.cream}"/>`;
  const style = animated
    ? `<style>.${id}-cat{transform-origin:0 0;animation:${id}-sway ${SWAY.period}s ease-in-out infinite}` +
      `.${id}-pudding{transform-origin:0 0;animation:${id}-jiggle ${SWAY.period}s linear infinite}` +
      keyframes(id) +
      `@media (prefers-reduced-motion:reduce){.${id}-cat,.${id}-pudding{animation:none}}</style>`
    : "";
  return (
    style +
    // The cream gap round the pudding is a cut-out in the cat, so the ground shows through.
    `<defs><mask id="${id}-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="${BOX}" height="${BOX}">` +
    `<rect width="${BOX}" height="${BOX}" fill="#fff"/>${pudding(`<path d="${PATHS.gap}" fill="#000"/>`)}</mask>` +
    `<clipPath id="${id}-rim"><path d="${PATHS.pudding}"/></clipPath></defs>` +
    `<g mask="url(#${id}-gap)">${animated ? about(CAT_PIVOT, `${id}-cat`, cat) : cat}</g>` +
    pudding(
      `<path d="${PATHS.pudding}" fill="${COLOURS.custard}"/>` +
        `<path d="${PATHS.caramel}" fill="${COLOURS.caramel}" fill-rule="evenodd" clip-path="url(#${id}-rim)"/>`,
    )
  );
}

const svg = (viewBox, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>Purin</title>${inner}</svg>\n`;
const tileTransform = (scale) =>
  `translate(${BOX / 2} ${BOX / 2}) scale(${scale}) translate(${-CENTRE[0]} ${-CENTRE[1]})`;
const mark = (id, animated = false) =>
  svg(MARK_VIEW_BOX, artwork(id, animated));
/** The mark on a cream tile. `radius` 0 gives a full square for the systems that cut their own shape. */
const tile = (id, scale, { radius = TILE_RADIUS, animated = false } = {}) =>
  svg(
    `0 0 ${BOX} ${BOX}`,
    `<rect width="${BOX}" height="${BOX}"${radius ? ` rx="${radius}"` : ""} fill="${COLOURS.cream}"/>` +
      `<g transform="${tileTransform(scale)}">${artwork(id, animated)}</g>`,
  );

async function loadSharp() {
  try {
    return createRequire(path.join(root, "node_modules/.pnpm/node_modules/_"))(
      "sharp",
    );
  } catch {
    throw new Error(
      "sharp is not installed. Run `pnpm install`, or pass --no-png.",
    );
  }
}

/** An ICO file that holds PNG images. Each entry is at most 256 px wide. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const written = [];
async function save(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  written.push(path.relative(root, file));
}

/* ---------- SVG files ---------- */
const sources = {
  mark: mark("purin"),
  icon: tile("purin", TILE_SCALE.icon),
  favicon: tile("purin", TILE_SCALE.favicon),
  touch: tile("purin", TILE_SCALE.touch, { radius: 0 }),
  maskable: tile("purin", TILE_SCALE.maskable, { radius: 0 }),
};
await save(path.join(logoDir, "purin-mark.svg"), sources.mark);
await save(
  path.join(logoDir, "purin-mark-animated.svg"),
  mark("purin-live", true),
);
await save(path.join(logoDir, "purin-icon.svg"), sources.icon);
await save(
  path.join(logoDir, "purin-icon-animated.svg"),
  tile("purin-live", TILE_SCALE.icon, { animated: true }),
);

/* ---------- icon pack ---------- */
await rm(packDir, { recursive: true, force: true });
await save(path.join(packDir, "favicon.svg"), sources.favicon);
const manifest = {
  name: "Purin",
  short_name: "Purin",
  icons: [
    {
      src: "icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icon-maskable-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
  theme_color: COLOURS.cream,
  background_color: COLOURS.cream,
  display: "standalone",
};
await save(
  path.join(packDir, "site.webmanifest"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
if (withPng) {
  const sharp = await loadSharp();
  const png = (source, size) =>
    sharp(Buffer.from(source), { density: Math.max(72, (72 * size * 2) / BOX) })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer();
  const faviconSizes = [16, 32, 48];
  const favicons = await Promise.all(
    faviconSizes.map(async (size) => ({
      size,
      png: await png(sources.favicon, size),
    })),
  );
  for (const { size, png: data } of favicons)
    await save(path.join(packDir, `favicon-${size}.png`), data);
  await save(path.join(packDir, "favicon.ico"), ico(favicons));
  await save(
    path.join(packDir, "apple-touch-icon.png"),
    await png(sources.touch, 180),
  );
  for (const size of [192, 512, 1024])
    await save(
      path.join(packDir, `icon-${size}.png`),
      await png(sources.icon, size),
    );
  for (const size of [192, 512])
    await save(
      path.join(packDir, `icon-maskable-${size}.png`),
      await png(sources.maskable, size),
    );
  for (const size of [64, 128, 256, 512, 1024])
    await save(
      path.join(packDir, `mark-${size}.png`),
      await png(sources.mark, size),
    );
}

/* ---------- Portal component data ---------- */
const generated =
  "Generated by scripts/brand/build-purin-logo.mjs. Do not edit: change the script, then run it.";
const data = `// ${generated}

/** The traced curves of the Purin cat mark, in a 1024 box. */
export const PURIN_MARK = ${JSON.stringify(
  {
    markViewBox: MARK_VIEW_BOX,
    iconViewBox: `0 0 ${BOX} ${BOX}`,
    iconTransform: tileTransform(TILE_SCALE.icon),
    iconRadius: TILE_RADIUS,
    box: BOX,
    catPivot: CAT_PIVOT,
    puddingPivot: PUDDING_PIVOT,
    colours: COLOURS,
    paths: PATHS,
  },
  null,
  2,
)} as const;
`;
const css = `/* ${generated} */

.purin-mark-cat,
.purin-mark-pudding {
  transform-origin: 0 0;
}

/* The cat sways. Each time it turns round, the pudding jiggles. */
.purin-mark[data-animated] .purin-mark-cat {
  animation: purin-mark-sway ${SWAY.period}s ease-in-out infinite;
}

.purin-mark[data-animated] .purin-mark-pudding {
  animation: purin-mark-jiggle ${SWAY.period}s linear infinite;
}

${keyframes("purin-mark")}

@media (prefers-reduced-motion: reduce) {
  .purin-mark[data-animated] .purin-mark-cat,
  .purin-mark[data-animated] .purin-mark-pudding {
    animation: none;
  }
}
`;
const options =
  (await prettier.resolveConfig(path.join(uiDir, "purin-mark.css"))) ?? {};
await save(
  path.join(uiDir, "purin-mark-paths.ts"),
  await prettier.format(data, { ...options, parser: "typescript" }),
);
await save(
  path.join(uiDir, "purin-mark.css"),
  await prettier.format(css, { ...options, parser: "css" }),
);

console.log(written.join("\n"));
