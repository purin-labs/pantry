import type {
  EmbeddedHarnessAdapter,
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessManifest,
  EmbeddedHarnessRuntime,
  EmbeddedHarnessUserInput,
} from "../src/actors/embedded-harness";

declare const manifest: EmbeddedHarnessManifest;
declare const runtime: EmbeddedHarnessRuntime;

const asynchronousConstruction = {
  manifest,
  // @ts-expect-error Construction must return the runtime before asynchronous work starts.
  async construct(_input: EmbeddedHarnessConstructionInput) {
    return { ok: true as const, value: runtime };
  },
} satisfies EmbeddedHarnessAdapter;

const unownedStartPromise = {
  // @ts-expect-error Startup must return a cancellable task synchronously.
  async startTurn(_input: readonly EmbeddedHarnessUserInput[]) {
    return {
      ok: false as const,
      error: { code: "embedded_harness_input_unsupported" as const },
    };
  },
  close: closeRuntime,
} satisfies EmbeddedHarnessRuntime;

function closeRuntime(): void {}

void asynchronousConstruction;
void unownedStartPromise;
