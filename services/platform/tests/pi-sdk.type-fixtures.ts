import type {
  HarnessCodeModeSandbox,
  HarnessNativeCodeMode,
} from "../src/actors/embedded-harness";
import type { HarnessCodeModeAdmission } from "../src/agent-tools/catalog/types";

type Enabled = Extract<HarnessNativeCodeMode, { kind: "enabled" }>;

declare const sandbox: HarnessCodeModeSandbox;
declare const admission: HarnessCodeModeAdmission;
declare const executeTool: Enabled["executeTool"];
declare const claimedCapabilities: Enabled["claimedCapabilities"];
declare const authorizeSources: Enabled["authorizeSources"];

const enabled: HarnessNativeCodeMode = {
  kind: "enabled",
  sandbox,
  admission,
  executeTool,
  claimedCapabilities,
  authorizeSources,
};
// A deployment without the sandbox Worker still has governed admission.
const unavailable: HarnessNativeCodeMode = { ...enabled, sandbox: null };
const disabled: HarnessNativeCodeMode = { kind: "disabled" };

// @ts-expect-error A sandbox requires Actor admission.
const ungoverned: HarnessNativeCodeMode = { kind: "enabled", sandbox };

// @ts-expect-error Disabled Code Mode cannot carry a sandbox.
const disabledSandbox: HarnessNativeCodeMode = { kind: "disabled", sandbox };

// @ts-expect-error A spread cannot combine disabled and enabled state.
const invalidSpread: HarnessNativeCodeMode = { ...enabled, kind: "disabled" };

// @ts-expect-error Native calls require the execution-bound tool entry point.
const missingInvocation: HarnessNativeCodeMode = {
  kind: "enabled",
  sandbox,
  admission,
  claimedCapabilities,
  authorizeSources,
};

// @ts-expect-error A replayed result requires a current source decision.
const unauthorizedReplay: HarnessNativeCodeMode = {
  kind: "enabled",
  sandbox,
  admission,
  executeTool,
  claimedCapabilities,
};

// @ts-expect-error Disabled Code Mode cannot carry nested tool authority.
const disabledInvocation: HarnessNativeCodeMode = {
  kind: "disabled",
  executeTool,
};

void [
  enabled,
  unavailable,
  disabled,
  ungoverned,
  disabledSandbox,
  invalidSpread,
  missingInvocation,
  unauthorizedReplay,
  disabledInvocation,
];

// Actor storage and lease checks are required together at construction.
import type { EmbeddedHarnessConstructionInput } from "../src/actors/embedded-harness";
declare const storage: DurableObjectStorage;
declare const checkLease: () => void;
const actorPersistence: EmbeddedHarnessConstructionInput["persistence"] = {
  kind: "actor",
  storage,
  preflight: checkLease,
};
// @ts-expect-error Actor persistence requires a live lease check.
const unfencedPersistence: EmbeddedHarnessConstructionInput["persistence"] = {
  kind: "actor",
  storage,
};
// @ts-expect-error Transient execution cannot acquire Actor storage by spreading.
const mixedPersistence: EmbeddedHarnessConstructionInput["persistence"] = {
  ...actorPersistence,
  kind: "transient",
};
void [actorPersistence, unfencedPersistence, mixedPersistence];
