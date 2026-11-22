/**
 * The entry of the Code Mode sandbox Worker. A Worker's main module may export
 * only handlers and classes: the class is in `sandbox.ts` and the limits are
 * in `limits.ts`.
 */
export { CodeModeSandbox } from "@purin-labs/agent/code-mode-sandbox/sandbox";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
