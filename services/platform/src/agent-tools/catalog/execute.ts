import type {
  AuthorizedHarnessToolResult,
  HarnessToolOutput,
} from "@purin-labs/contracts";
import { errorMessage, sha256Hex } from "@purin-labs/std";
import type { AnyRegisteredTool } from "../define-tool";
import { ToolRequestError } from "../errors";
import {
  type HarnessPermissionRequestTool,
  PERMISSION_REQUEST_TOOL_NAME,
  parsePermissionRequestArgs,
  requestDeniedRead,
} from "./permission";
import { isSelectedCatalogToolName } from "./selection";
import {
  toolHandler,
  type ToolRegistry,
  type ToolServiceSet,
} from "./tool-registry";
import type {
  HarnessCapabilityClaim,
  HarnessCapabilityName,
  HarnessCodeModeExecutionLease,
  HarnessToolDefinition,
} from "./types";

const MAX_CODE_MODE_OUTPUT_BYTES = 24 * 1024;

const ENCODER = new TextEncoder();

const CAPABILITY_FAILURE_TEXT =
  "The capability could not complete this request. Authoritative data is unavailable; retry once without inferring a broader outage.";

/** A call that the run's tool-call budget refused: retrying cannot help. */
class CapabilityBudgetError extends ToolRequestError {}

const CAPABILITY_BUDGET_TEXT =
  "This conversation used its budget of tool calls, so this call did not run. Do not retry it or guess its result. Tell the person that the conversation reached its tool-call budget, and that an owner or admin can raise the budget under Access in the Portal.";

/**
 * How a tool call reached the catalog: from the model, or from a Code Mode
 * script under the lease of its execution. An edit of a script ends by the
 * deadline that admission set for that execution.
 */
export type CatalogExecutionContext =
  | { readonly kind: "direct"; readonly executionLease?: never }
  | {
      readonly kind: "code_mode";
      readonly executionLease: HarnessCodeModeExecutionLease;
    };

/** What a catalog tool call can use: the dependencies of one turn. */
export type CatalogToolAuthority = {
  readonly registry: ToolRegistry;
  /** The definitions that this turn's catalog selected. */
  readonly definitions: readonly HarnessToolDefinition[];
  /** The tools that this turn adds to the registry's tools. */
  readonly turnTools: readonly AnyRegisteredTool[];
  /** The services of each tool family, by family name. */
  readonly services: ToolServiceSet;
  readonly requestPermission?: HarnessPermissionRequestTool;
  readonly claimCapability: HarnessCapabilityClaim;
};

export function executeNativeCatalogTool(
  authority: CatalogToolAuthority,
  executionLease: HarnessCodeModeExecutionLease,
  name: string,
  inputJson: string,
  callId: string,
): Promise<AuthorizedHarnessToolResult> {
  return executeCatalogTool(
    authority,
    { kind: "code_mode", executionLease },
    name,
    inputJson,
    callId,
  );
}

export async function executeCatalogTool(
  authority: CatalogToolAuthority,
  execution: CatalogExecutionContext,
  name: string,
  inputJson: string,
  callId: string,
): Promise<AuthorizedHarnessToolResult> {
  // A turn tool goes before a registered tool of the same name.
  const tool =
    authority.turnTools.find((turnTool) => turnTool.name === name) ??
    authority.registry.find(name);
  // A tool with its own envelope keeps it for each result, also for a call
  // that this turn's catalog did not select.
  const envelope = authority.registry.find(name)?.result;
  const failed = (detail: string): Promise<AuthorizedHarnessToolResult> =>
    envelope === undefined
      ? authorizedRead(failedToolOutput(detail), "failed")
      : envelope.failure(detail);
  if (
    callId.length === 0 ||
    !isSelectedCatalogToolName(authority.definitions, name)
  ) {
    return failed("Tool request exceeded its accepted boundary");
  }
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return failed("Tool input was not valid JSON");
  }

  let codeModeValue: unknown;
  try {
    codeModeValue = await executeSelectedTool(
      authority,
      tool,
      execution,
      name,
      input,
      callId,
    );
    if (envelope !== undefined) {
      return await envelope.success(codeModeValue);
    }
  } catch (error) {
    logCapabilityFailure(name, callId, error);
    let failure = CAPABILITY_FAILURE_TEXT;
    if (error instanceof ToolRequestError) {
      failure = error.message;
    } else {
      failure = authority.registry.find(name)?.unconfirmedFailure ?? failure;
    }
    if (error instanceof ToolRequestError && error.requestableRead !== null) {
      failure = await requestDeniedRead(
        authority.requestPermission,
        execution,
        error.requestableRead,
        failure,
      );
    }
    return failed(failure);
  }
  const output = JSON.stringify({
    output: boundedOutput(codeModeValue),
    success: true,
    code_mode_value: codeModeValue,
    metadata: null,
    process_trace: null,
  });
  const registered = authority.registry.find(name);
  if (registered?.effect === "surface") {
    return authorizedSurfaceEffect(
      output,
      registered.readReceipt(codeModeValue),
      registered.succeeded?.(codeModeValue) === true ? "succeeded" : "failed",
    );
  }
  if (registered?.effect === "receipt") {
    return authorizedProviderEffect(
      output,
      registered.readReceipt(codeModeValue),
    );
  }
  return authorizedRead(output);
}

/**
 * One call of a selected tool. A missing handler fails first, then the
 * arguments, then the capability claim, so a refused call claims nothing.
 */
async function executeSelectedTool(
  authority: CatalogToolAuthority,
  tool: AnyRegisteredTool | undefined,
  execution: CatalogExecutionContext,
  name: string,
  input: unknown,
  callId: string,
): Promise<unknown> {
  if (tool === undefined) {
    if (name !== PERMISSION_REQUEST_TOOL_NAME) {
      throw new Error("Tool request exceeded its accepted boundary");
    }
    // A request belongs to the turn's thread, so only the model calls it.
    if (execution.kind !== "direct") {
      throw new TypeError("request_permission requires a direct call");
    }
    if (authority.requestPermission === undefined) {
      throw new Error("Permission requests are unavailable");
    }
    return authority.requestPermission(parsePermissionRequestArgs(input));
  }
  if (tool.directOnly && execution.kind !== "direct") {
    throw new TypeError(`${tool.name} requires a direct call`);
  }
  const handler = toolHandler(tool, authority.services);
  if (handler === undefined) {
    throw new Error(tool.unavailable);
  }
  const request = tool.parse(input);
  if (tool.selection.kind === "capability") {
    await claimDirectCapability(
      authority.claimCapability,
      callId,
      tool.selection.capability,
    );
  }
  return handler(request, {
    callId,
    execution,
    operationId: logicalToolOperationId(execution, callId),
  });
}

async function claimDirectCapability(
  claimCapability: HarnessCapabilityClaim,
  callId: string,
  capability: HarnessCapabilityName,
): Promise<null> {
  const claimed = await claimCapability({
    callId,
    capability,
    boundary: "direct_tool",
  });
  if (!claimed.ok) {
    throw claimed.error.detail === "budget_exhausted"
      ? new CapabilityBudgetError(CAPABILITY_BUDGET_TEXT)
      : new Error(claimed.error.detail);
  }
  return null;
}

function failedToolOutput(detail: string): string {
  return JSON.stringify({
    output: boundedText(detail),
    success: false,
    code_mode_value: null,
    metadata: null,
    process_trace: null,
  });
}

async function authorizedRead(
  output: string,
  status: "succeeded" | "failed" = "succeeded",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "read",
    output: value,
    authority: { kind: "read", resultDigest: value.digest },
    status,
  };
}

async function authorizedProviderEffect(
  output: string,
  receiptId: string,
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "provider_effect",
    output: value,
    authority: {
      kind: "provider_effect",
      receiptId,
      resultDigest: value.digest,
    },
    status: "succeeded",
  };
}

async function authorizedSurfaceEffect(
  output: string,
  receiptId: string,
  status: "succeeded" | "failed",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "surface_effect",
    output: value,
    authority: {
      kind: "surface_effect",
      receiptId,
      resultDigest: value.digest,
    },
    status,
  };
}

async function inlineToolOutput(output: string): Promise<HarnessToolOutput> {
  return {
    kind: "inline",
    content: [{ kind: "text", text: output }],
    digest: await sha256Hex(output),
  };
}

function logicalToolOperationId(
  execution: CatalogExecutionContext,
  callId: string,
): string {
  return JSON.stringify([
    execution.kind === "code_mode" ? "code_mode" : "direct_tool",
    callId,
  ]);
}

function boundedOutput(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "Code Mode returned a non-serializable result";
  }
  return boundedText(serialized ?? "null");
}

function boundedText(value: string): string {
  const bytes = ENCODER.encode(value);
  if (bytes.byteLength <= MAX_CODE_MODE_OUTPUT_BYTES) {
    return value;
  }
  const prefix = new TextDecoder().decode(
    bytes.slice(0, MAX_CODE_MODE_OUTPUT_BYTES),
  );
  return `${prefix}\n[output truncated from ${bytes.byteLength} bytes]`;
}

function logCapabilityFailure(
  tool: HarnessToolDefinition["name"],
  callId: string,
  error: unknown,
): void {
  console.warn("embedded_harness.capability_failed", {
    tool,
    callId,
    detail: errorMessage(error),
  });
}
