import { expect, it } from "vitest";
import { modelContextPrompt } from "../src/actors/model-context-prompt";
import type { ModelContextBundle } from "../src/context/assembly";

it("fits encoded context without truncating the current instruction", function boundedContext() {
  const context: ModelContextBundle = {
    assemblyStrategyVersion: "context_assembly_v1",
    disposition: { kind: "complete" },
    items: [
      {
        sourceKind: "case_conversation",
        provenance: { kind: "case_entry" },
        boundedExcerpt: "First relevant fact",
        observedAt: 1,
        freshness: { kind: "fresh" },
      },
      {
        sourceKind: "case_conversation",
        provenance: { kind: "case_entry" },
        boundedExcerpt: '日本語 "quoted"\\history\n'.repeat(1_000),
        observedAt: 1,
        freshness: { kind: "fresh" },
      },
    ],
  };
  const instruction = 'Prepare the exact email. "Do not send."\n'.repeat(100);
  const budget =
    new TextEncoder().encode(JSON.stringify(instruction)).byteLength + 200;
  const prompt = modelContextPrompt(context, instruction, budget);
  expect(
    new TextEncoder().encode(JSON.stringify(prompt)).byteLength,
  ).toBeLessThanOrEqual(budget);
  expect(prompt).toContain("First relevant fact");
  expect(prompt).not.toContain("日本語");
  expect(prompt.endsWith(instruction)).toBe(true);
  expect(modelContextPrompt(context, instruction, 1)).toBe(instruction);
});
