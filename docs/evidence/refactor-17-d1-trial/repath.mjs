// node repath.mjs <root> <plan.json> <file...> : rewrite root-relative path strings of moved files in config files
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, planPath, ...files] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const pairs = Object.entries(plan.moves);
for (const [from, to] of plan.dirs ?? []) pairs.push([from, to]);
pairs.sort((a, b) => b[0].length - a[0].length);
let total = 0;
for (const f of files) {
  let s = readFileSync(join(root, f), "utf8");
  let n = 0;
  for (const [from, to] of pairs) {
    const parts = s.split(from);
    if (parts.length > 1) {
      n += parts.length - 1;
      s = parts.join(to);
    }
  }
  if (n) {
    writeFileSync(join(root, f), s);
    console.log(n, f);
    total += n;
  }
}
console.log("total", total);
