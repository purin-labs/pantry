import type { RunSnapshot } from "./bakery-run-snapshot";

// @ts-expect-error Storage requires a bounded parsed envelope.
const raw: RunSnapshot = { name: "Run", file: "{}", content: "{}" };
void raw;
