// Runs merchant plugin functions in QuickJS (Plan 77 step 4). A VM starts
// asynchronously, so a request prepares clean VMs before it plans a checkout;
// the synchronous planner takes one VM for each run and disposes it, so no
// run sees another run's state. The clock is the request time and the random
// source is fixed, so the same code and input give the same output.
import { AsyncLocalStorage } from "node:async_hooks";
import { QuickJS } from "quickjs-wasi";

import type { PluginLimits } from "@purin-labs/commerce-contracts";

export type FunctionFailureReason =
  "threw" | "budget" | "memory" | "invalid_output" | "unavailable";

export type FunctionRunOutcome =
  | Readonly<{ kind: "returned"; output: unknown; polls: number }>
  | Readonly<{
      kind: "failed";
      reason: FunctionFailureReason;
      message: string;
      polls: number;
    }>;

/** The caps of every run; a plugin's own limits must be within them. */
export const FUNCTION_CAPS = {
  instructionBudget: 1_000,
  memoryBytes: 16 * 1024 * 1024,
  outputBytes: 64 * 1024,
  sourceBytes: 64 * 1024,
} as const;

type RunState = { polls: number; budget: number; clockNanos: bigint };
type PreparedVm = Readonly<{ vm: QuickJS; state: RunState }>;

/** Clean VMs that one request may run functions in. */
export class PreparedFunctionVms {
  #vms: PreparedVm[];

  constructor(vms: PreparedVm[]) {
    this.#vms = vms;
  }

  /**
   * Runs the `run(input)` function that `source` defines, in a clean VM.
   * With no VM left, the run fails as unavailable.
   */
  run(
    source: string,
    input: unknown,
    limits: PluginLimits,
    at: string,
  ): FunctionRunOutcome {
    const prepared = this.#vms.shift();
    if (prepared === undefined)
      return {
        kind: "failed",
        reason: "unavailable",
        message: "No function VM was prepared for this request",
        polls: 0,
      };
    try {
      return runIn(prepared, source, input, limits, at);
    } finally {
      prepared.vm.dispose();
    }
  }

  dispose(): void {
    for (const prepared of this.#vms) prepared.vm.dispose();
    this.#vms = [];
  }
}

/** The VMs of the request in progress, for the synchronous planners. */
export const functionScope = new AsyncLocalStorage<PreparedFunctionVms>();

export class QuickJsFunctionRuntime {
  readonly #module: WebAssembly.Module;

  constructor(module: WebAssembly.Module) {
    this.#module = module;
  }

  async prepare(count: number): Promise<PreparedFunctionVms> {
    const vms: PreparedVm[] = [];
    for (let index = 0; index < count; index += 1) {
      const state: RunState = { polls: 0, budget: 0, clockNanos: 0n };
      const vm = await QuickJS.create({
        wasm: this.#module,
        memoryLimit: FUNCTION_CAPS.memoryBytes,
        interruptHandler: () => (state.polls += 1) > state.budget,
        timezoneOffset: 0,
        wasi: (memory) => ({
          clock_time_get: (_id: number, _precision: bigint, out: number) => {
            new DataView(memory.buffer).setBigUint64(
              out,
              state.clockNanos,
              true,
            );
            return 0;
          },
          random_get: (pointer: number, length: number) => {
            new Uint8Array(memory.buffer, pointer, length).fill(7);
            return 0;
          },
        }),
      });
      vms.push({ vm, state });
    }
    return new PreparedFunctionVms(vms);
  }
}

function runIn(
  prepared: PreparedVm,
  source: string,
  input: unknown,
  limits: PluginLimits,
  at: string,
): FunctionRunOutcome {
  const { vm, state } = prepared;
  state.polls = 0;
  state.budget = Math.min(
    limits.instructionBudget,
    FUNCTION_CAPS.instructionBudget,
  );
  state.clockNanos = BigInt(Date.parse(at)) * 1_000_000n;
  try {
    vm.evalCode(source, "plugin.js").dispose();
    const kind = vm
      .evalCode("typeof run")
      .consume((handle) => handle.toString());
    if (kind !== "function")
      return failed("invalid_output", "The source defines no run function", 0);
    const run = vm.global.getProp("run");
    const argument = vm.hostToHandle(input);
    let json: string | undefined;
    try {
      const result = vm.callFunction(run, vm.undefined, argument);
      json = JSON.stringify(result.consume((handle) => vm.dump(handle)));
    } finally {
      argument.dispose();
      run.dispose();
    }
    if (
      json === undefined ||
      json.length > Math.min(limits.outputBytes, FUNCTION_CAPS.outputBytes)
    )
      return failed(
        "invalid_output",
        "The output is not JSON or is too large",
        state.polls,
      );
    return {
      kind: "returned",
      output: JSON.parse(json) as unknown,
      polls: state.polls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(
      state.polls > state.budget
        ? "budget"
        : /out of memory/iu.test(message)
          ? "memory"
          : "threw",
      message.slice(0, 500),
      Math.min(state.polls, state.budget),
    );
  }
}

function failed(
  reason: FunctionFailureReason,
  message: string,
  polls: number,
): FunctionRunOutcome {
  return { kind: "failed", reason, message, polls };
}
