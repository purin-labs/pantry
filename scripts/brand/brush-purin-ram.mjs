// node scripts/brand/brush-purin-ram.mjs JOB.json OUT.json BRUSH.ts
//
// Paints the centre lines of the Purin ram with the bristle brush of the company site
// (apps/seams-site/src/components/h2/ink/brush.ts in purin-labs/purin-monorepo), so the
// brushed ram has the same hand as the front page drawings. Each item starts the brush
// noise from the same fixed seed, so a run always paints the same marks. The output is
// the bristle marks as line segments; trace-purin-ram.py draws them and traces them.
import { readFileSync, writeFileSync } from "node:fs";

const [jobPath, outPath, brushPath] = process.argv.slice(2);
const { createNoise, prepareStroke } = await import(brushPath);
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const out = {};
for (const [key, strokes] of Object.entries(job.items)) {
  const noise = createNoise(job.seed);
  const segs = [];
  let width = 0;
  let x0 = 0;
  let y0 = 0;
  // the brush needs only these parts of a canvas: it moves to a point and draws a line on
  const ctx = {
    set globalCompositeOperation(_) {},
    set strokeStyle(_) {},
    set lineCap(_) {},
    set lineWidth(value) {
      width = value;
    },
    beginPath() {},
    moveTo(x, y) {
      x0 = x;
      y0 = y;
    },
    lineTo(x, y) {
      segs.push(x0, y0, x, y);
      x0 = x;
      y0 = y;
    },
    stroke() {},
  };
  for (const stroke of strokes) {
    const style = job.styles[stroke.style];
    const pts = stroke.pts.map(([x, y, w]) => [x, y, w * (style.widen ?? 1)]);
    prepareStroke(
      { ...style, pts, flat: stroke.flat && !style.round },
      job.scale,
      noise,
    ).draw(ctx, 1);
  }
  out[key] = {
    width,
    segs: Buffer.from(new Float32Array(segs).buffer).toString("base64"),
  };
}
writeFileSync(outPath, JSON.stringify(out));
