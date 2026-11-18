# Bakery motion figures

The ecommerce landing page embeds these three SVG figures through `index.html`.
`embed.js` accepts only the three named studies and supplies the figure host.
The packing loop has a pause control. All figures respect reduced motion.

These JavaScript files are the canonical figure sources. The HTML studies under
`output/plan-65-hairline-svgs/training-bench/` are generated review artifacts.
To rebuild one with the installed Hairline skill, run from the repository root:

```sh
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const { assemble } = await import(process.env.HOME + "/.codex/skills/hairline-create/build.mjs");
const base = "apps/portal/public/ecommerce/motion/";
for (const name of ["demand-terrain", "oven-rack", "packing-slow"]) {
  const source = readFileSync(base + "interaction.js", "utf8") + "\n" + readFileSync(base + name + ".js", "utf8");
  writeFileSync(`output/plan-65-hairline-svgs/training-bench/${name}/index.html`, assemble(source));
}
'
```

`kernel.js` is the unmodified engine distributed with Lucas Markes' Hairline
skill. Its source hash is retained in its header. Each iframe owns its engine,
so disposal, offscreen suspension, and motion preferences stay local.

## Repeatable browser review

1. Run `pnpm --filter @seams/portal dev` and open `/ecommerce` on port 3103.
2. Scroll through all three figures. Confirm that each renders without sliders
   or development controls. Move across the terrain and oven bays.
3. Hover over a packed box after it clears the press. Confirm that the conveyor
   stops, the lid stays open, and the lid closes fully before travel resumes.
4. Pause the packing loop. Confirm that parcel positions stay fixed. Resume
   it and confirm that the conveyor advances again.
5. Repeat at 390px width. Tap a tray, oven, or gift box. The selection stays
   active until a second tap or selection of another item. Scrolling must not
   select an item. Confirm one column and no horizontal overflow.
6. Open `/interaction-review/` on the study server and run the repeatable
   browser checks. These exercise touch pointer events through DOM listeners.
   A physical phone check is still useful for native scrolling behavior.

Desktop and mobile captures are in
`output/plan-65-hairline-svgs/landing-review/`.

`interaction.js` shares touch selection across all three figures. The engine remains
unmodified. Generated studies include this helper before each figure.
