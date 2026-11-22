import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const med = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const steps = [...new Set(rows.map((r) => r.step))];
const fields = [
  "ms",
  "bundleMs",
  "viteMs",
  "durationMs",
  "transformMs",
  "setupMs",
  "testsMs",
  "toFirstTestMs",
  "bytes",
  "uploadKiB",
  "gzipKiB",
  "errors",
];
for (const step of steps) {
  for (const field of fields) {
    const line = ["0", "F", "P"].map((v) => {
      const rs = rows.filter(
        (r) => r.step === step && r.variant === v && r[field] !== undefined,
      );
      if (!rs.length) return `${v}: -`;
      return `${v}: ${med(rs.map((r) => r[field]))} [${rs.map((r) => r[field]).join(", ")}]`;
    });
    if (line.some((l) => !l.endsWith("-")))
      console.log(`${step} | ${field} | ${line.join(" | ")}`);
  }
  const codes = ["0", "F", "P"].map(
    (v) =>
      `${v}: ${rows
        .filter((r) => r.step === step && r.variant === v)
        .map((r) => r.code)
        .join(",")}`,
  );
  console.log(`${step} | exit | ${codes.join(" | ")}`);
  const loads = ["0", "F", "P"].map(
    (v) =>
      `${v}: ${rows
        .filter((r) => r.step === step && r.variant === v)
        .map((r) => r.load.split(" ")[0])
        .join(",")}`,
  );
  console.log(`${step} | load1 | ${loads.join(" | ")}`);
}
