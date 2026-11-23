import { Type } from "typebox";
import { KITCHEN_SURFACE, type PastryBenchViewCommand } from "@purin-labs/control-api";
import {
  bakerySurfaceToolSucceeded,
  readBakerySurfaceReceiptId,
} from "../bakery/surface-result";
import { defineKitchenTool, type KitchenToolServices } from "./services";
import { ProposalArgumentError } from "@purin-labs/agent-tools/errors";

const RERUN = {
  kind: "any_caller",
  reason: "A Pastry Bench view command shows the same bench state when it runs again.",
} as const;

const UNAVAILABLE =
  "Kitchen Pastry Bench commands need a Portal chat whose message carries the Pastry Bench page";

const SCREEN_RULE =
  "Use it only while the person's current message carries the Kitchen Pie Pastry Bench from their screen.";

const pastryBenchConfigure = defineKitchenTool({
  name: "pastry_bench_configure",
  description: `Configure the Kitchen Pie Pastry Bench parameters or camera view on the person's screen (pieType, targetThicknessMm, crimpForceN, faultCheck, cameraPreset) and run the MuJoCo 4.0.0 3D volumetric dough press, 2D deformable flexcomp shell, and Maruzen MBCO-5E oven solver when recipe settings change. ${SCREEN_RULE} It saves nothing.`,
  input: Type.Object(
    {
      pieType: Type.Optional(
        Type.Union([
          Type.Literal("steak-and-pepper"),
          Type.Literal("beef-bourguignon"),
        ]),
      ),
      targetThicknessMm: Type.Optional(
        Type.Union([Type.Literal(2.5), Type.Literal(3.0), Type.Literal(3.5)]),
      ),
      crimpForceN: Type.Optional(
        Type.Union([Type.Literal(36), Type.Literal(42), Type.Literal(52)]),
      ),
      faultCheck: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("unfloured-bench")]),
      ),
      cameraPreset: Type.Optional(
        Type.Union([
          Type.Literal("bench"),
          Type.Literal("dough-block"),
          Type.Literal("tin-cavity"),
          Type.Literal("roller"),
          Type.Literal("overhead"),
          Type.Literal("oven"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
  decode: (input): PastryBenchViewCommand => {
    if (
      input.pieType === undefined &&
      input.targetThicknessMm === undefined &&
      input.crimpForceN === undefined &&
      input.faultCheck === undefined &&
      input.cameraPreset === undefined
    ) {
      throw new ProposalArgumentError(
        "Provide at least one Pastry Bench setting (pieType, targetThicknessMm, crimpForceN, faultCheck, or cameraPreset).",
      );
    }
    return {
      name: "configure_pastry_bench",
      ...(input.pieType === undefined ? {} : { pieType: input.pieType }),
      ...(input.targetThicknessMm === undefined
        ? {}
        : { targetThicknessMm: input.targetThicknessMm }),
      ...(input.crimpForceN === undefined
        ? {}
        : { crimpForceN: input.crimpForceN }),
      ...(input.faultCheck === undefined ? {} : { faultCheck: input.faultCheck }),
      ...(input.cameraPreset === undefined
        ? {}
        : { cameraPreset: input.cameraPreset }),
    };
  },
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "configure_pastry_bench",
  },
  unavailable: UNAVAILABLE,
  handler: pastryBenchViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const pastryBenchPrepare = defineKitchenTool({
  name: "pastry_bench_prepare",
  description: `Re-run the MuJoCo 4.0.0 deformable flexcomp shortcrust sheeting, puff-lid crimping, and Maruzen MBCO-5E oven bake simulation on the Kitchen Pie Pastry Bench on the person's screen and return the updated cavity drape, seal, and oven bake telemetry. ${SCREEN_RULE} It saves nothing.`,
  input: Type.Object({}, { additionalProperties: false }),
  decode: (): PastryBenchViewCommand => ({ name: "prepare_pastry_bench" }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_pastry_bench",
  },
  unavailable: UNAVAILABLE,
  handler: pastryBenchViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

export const PASTRY_BENCH_VIEW_TOOLS = [
  pastryBenchConfigure,
  pastryBenchPrepare,
] as const;

function pastryBenchViewHandler({
  executePageViewCommand,
}: Partial<KitchenToolServices>) {
  return executePageViewCommand === undefined
    ? undefined
    : (command: PastryBenchViewCommand, call: { readonly callId: string }) =>
        executePageViewCommand(command, call.callId);
}
