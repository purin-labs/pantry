import type { CodeModePlacement } from "./code-mode-budget";
import { sha256Hex } from "@seams/std";

const CODE_MODE_ROUTER_REVISION = "code-mode-router-v1";

type CodeModeRouteRequest = {
  readonly workloadProfile: "sequential_read";
  readonly invocation: "root";
  readonly effects: "none";
  readonly capability: "available";
  readonly policy: "allowed";
  readonly catalog: "current";
  readonly budget: "feasible";
};

type CodeModeRouteDecision = {
  readonly kind: "selected";
  readonly routerRevision: typeof CODE_MODE_ROUTER_REVISION;
  readonly placement: CodeModePlacement;
};

/**
 * The pinned Pi Code Mode package that the sandbox Worker serves and that
 * the Session Actor calls. Change it with the pin in `package.json`: an
 * execution that another package admitted does not resume.
 */
const SANDBOX_PACKAGE_VERSION = "1.1.0-4270522473e6";

export async function routeCodeModeExecution(
  request: CodeModeRouteRequest,
): Promise<CodeModeRouteDecision> {
  const evidenceDigest = await sha256Hex(JSON.stringify(request));
  return {
    kind: "selected",
    routerRevision: CODE_MODE_ROUTER_REVISION,
    placement: {
      kind: "cloudflare_sandbox_worker",
      adapterRevision: `pi-codemode-sandbox-${SANDBOX_PACKAGE_VERSION}`,
      packageVersion: SANDBOX_PACKAGE_VERSION,
      reason: "generated_javascript_remote_execution",
      evidenceDigest,
    },
  };
}
