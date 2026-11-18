import type { HarnessToolOutput } from "./HarnessToolOutput";

export type HarnessToolOutcome =
  | { kind: "succeeded"; output: HarnessToolOutput }
  | { kind: "failed"; output: HarnessToolOutput };
