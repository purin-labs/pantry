import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type {
  CodemodeRemoteExchange,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import {
  CODE_MODE_SANDBOX_INTERRUPT_BUDGET,
  CODE_MODE_SANDBOX_MEMORY_BYTES,
} from "./limits";

/**
 * Runs the QuickJS VM of one Code Mode script. This Worker holds no provider
 * credential, database, or storage. A script reaches a capability only through
 * the exchange that the session Actor passes in, and the Actor decides each
 * reply. The class lives in its own Worker so that a script that computes
 * cannot hold the session Actor's thread. `worker.ts` is the entry of that
 * Worker. This file holds the class and its `Env` key beside the code of the
 * session Actor that reads the binding.
 *
 * @public `services/platform/src/code-mode-sandbox/worker.ts` exports it for
 * the binding SANDBOX of `wrangler.code-mode-sandbox.jsonc`.
 */
export class CodeModeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = CODE_MODE_SANDBOX_INTERRUPT_BUDGET;
  protected override maxMemoryLimitBytes = CODE_MODE_SANDBOX_MEMORY_BYTES;

  /**
   * The exchange arrives as an RPC stub of the session Actor. Pi does not
   * release it, so this class does when the execution ends.
   */
  override async execute(
    request: CodemodeRemoteRequest,
    exchange: CodemodeRemoteExchange,
  ): Promise<void> {
    try {
      await super.execute(request, exchange);
    } finally {
      releaseStub(exchange);
    }
  }
}

function releaseStub(value: object): void {
  if (isDisposable(value)) value[Symbol.dispose]();
}

function isDisposable(value: object): value is Disposable {
  return Symbol.dispose in value && typeof value[Symbol.dispose] === "function";
}

declare module "@purin-labs/kernel/env" {
  interface Env {
    /**
     * The sandbox Worker that runs the VM of a Pi Code Mode script. Absent in a
     * deployment without that Worker: Pi Code Mode admission then fails.
     */
    CODE_MODE_SANDBOX?: DurableObjectNamespace<CodeModeSandbox>;
  }
}
