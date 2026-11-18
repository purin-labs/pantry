/**
 * The output of a `simulate_workcell` surface command: the browser result
 * that the Portal returns to the agent. A Portal before Refactor 16 step 7
 * sends no `margins`; a Portal after it sends the margins of each operation
 * against the robot's rated limits (`bakery-margins.ts`).
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OperationMarginSummaries } from "./bakery-margins.ts";

export const BakerySimulationOutput = Type.Object(
  {
    kind: Type.Literal("simulation"),
    mode: Type.Union([
      Type.Literal("transfer"),
      Type.Literal("oven-cycle"),
      Type.Literal("rack-cycle"),
    ]),
    recordingDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    bytes: Type.Integer({ minimum: 0, maximum: 16 * 1024 * 1024 }),
    elapsedMs: Type.Integer({ minimum: 0, maximum: 125_000 }),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("execution-error"),
    ]),
    margins: Type.Optional(OperationMarginSummaries),
  },
  { additionalProperties: false },
);
export type BakerySimulationOutput = Static<typeof BakerySimulationOutput>;

export function parseSimulationOutput(
  value: unknown,
): BakerySimulationOutput | null {
  return Value.Check(BakerySimulationOutput, value) ? value : null;
}
