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
 * cannot hold the session Actor's thread.
 *
 * A Worker's main module may export only handlers and classes. The limits
 * live in `limits.ts`.
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

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
