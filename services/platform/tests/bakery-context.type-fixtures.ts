import type {
  BakeryBrowserContext,
  BakeryContextPreparationCommand,
} from "@purin-labs/bakery-model/bakery-context";
import type {
  BakerySurfaceEffectOutcomeV1,
  ExecutableBakerySurfaceEffectV1,
  BakerySurfaceAttachmentV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { EmbeddedHarnessSource } from "../src/actors/embedded-harness";

declare const surface: BakerySurfaceAttachmentV1;
declare const executable: ExecutableBakerySurfaceEffectV1;
const binding = { browserInstanceId: "tab", conversationId: "chat" };
const preparation = {
  schemaVersion: 1,
  kind: "prepare_context",
  binding,
  requiredCommand: "inspect_surface",
} satisfies BakeryContextPreparationCommand;

const targetedPreparation: BakeryContextPreparationCommand = {
  ...preparation,
  // @ts-expect-error Preparation has no executable surface target.
  target: executable.command.target,
};
// @ts-expect-error Readiness requires the exact initiating browser binding.
const unboundReadiness: BakerySurfaceEffectOutcomeV1 = {
  kind: "prepared",
  surface,
};
// @ts-expect-error A failed delivery cannot carry readiness from a broad spread.
const failedReadiness: BakerySurfaceEffectOutcomeV1 = {
  ...{ kind: "prepared" as const, binding, surface },
  kind: "delivery_failed",
  code: "surface_unavailable",
  message: "Unavailable",
};
// @ts-expect-error An unavailable browser cannot retain an executable identity.
const unavailableBrowser: BakeryBrowserContext = {
  kind: "unavailable",
  binding,
};
// @ts-expect-error Resuming an accepted turn requires canonical history and its cursor.
const incompleteContinuation: EmbeddedHarnessSource = { kind: "resume_turn" };

void [
  targetedPreparation,
  unboundReadiness,
  failedReadiness,
  unavailableBrowser,
  incompleteContinuation,
];
