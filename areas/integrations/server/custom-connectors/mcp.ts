import { RequestDeadline } from "@purin-labs/kernel/request-deadline";
import {
  McpClient,
  StreamableHttpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import { assertNever, isRecord } from "@purin-labs/std";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import type { Result } from "@purin-labs/kernel/result";
import {
  executeCustomConnectorTransport,
  type CustomConnectorOperationRequest,
  type CustomConnectorTransportRequest,
  type CustomConnectorTransportResponse,
  type CustomConnectorTransportError,
  type CustomConnectorFetchNamespace,
} from "./egress";
import type { JsonObject } from "./definition";
import type { Variant } from "@purin-labs/type-utils";

export type ReviewedConnectorOperationRequest =
  | (Variant<CustomConnectorOperationRequest, "get" | "post_json"> & {
      readonly toolName?: never;
      readonly arguments?: never;
      readonly protocolVersion?: never;
      readonly sessionId?: never;
    })
  | {
      readonly kind: "mcp";
      readonly url: URL;
      readonly toolName: string;
      readonly arguments: JsonObject;
      readonly body?: never;
      readonly protocolVersion?: never;
      readonly sessionId?: never;
    };

type OperationInput = {
  readonly namespace: CustomConnectorFetchNamespace;
  readonly request: Omit<CustomConnectorTransportRequest, "operation"> & {
    readonly operation: ReviewedConnectorOperationRequest;
  };
  readonly attemptTimeoutMs: number;
  readonly authorizeCall: () => Promise<boolean>;
  readonly transport: typeof executeCustomConnectorTransport;
};

type DispatchState =
  { readonly kind: "not_dispatched" } | { readonly kind: "dispatch_started" };

export type ReviewedConnectorFailure =
  | {
      readonly kind: "not_dispatched";
      readonly code: CustomConnectorTransportError["code"];
    }
  | {
      readonly kind: "dispatch_started";
      readonly code: CustomConnectorTransportError["code"];
    };

type McpInvocation = {
  readonly input: OperationInput;
  readonly operation: Variant<ReviewedConnectorOperationRequest, "mcp">;
  failure: CustomConnectorTransportError | null;
  dispatch: DispatchState;
  remainingBytes: number;
};

export async function executeReviewedConnectorOperation(
  input: OperationInput,
): Promise<Result<CustomConnectorTransportResponse, ReviewedConnectorFailure>> {
  if (input.request.deadlineAtUnixMs <= Date.now())
    return reviewedFailure({ kind: "not_dispatched" }, "deadline_expired");
  if (!(await input.authorizeCall()))
    return reviewedFailure({ kind: "not_dispatched" }, "authority_expired");
  const remainingMs = input.request.deadlineAtUnixMs - Date.now();
  if (remainingMs <= 0)
    return reviewedFailure({ kind: "not_dispatched" }, "deadline_expired");
  const operation = input.request.operation;
  if (operation.kind !== "mcp") {
    const dispatch: { state: DispatchState } = {
      state: { kind: "not_dispatched" },
    };
    const deadline = new RequestDeadline(remainingMs);
    let response: Awaited<ReturnType<OperationInput["transport"]>>;
    try {
      response = await input.transport({
        namespace: input.namespace,
        signal: deadline.signal,
        authorizeDispatch: input.authorizeCall,
        onDispatch: recordRestDispatch.bind(null, dispatch),
        request: {
          ...input.request,
          operation,
          deadlineAtUnixMs: Math.min(
            input.request.deadlineAtUnixMs,
            Date.now() + input.attemptTimeoutMs,
          ),
        },
      });
    } finally {
      deadline.end();
    }
    return response.ok
      ? response
      : reviewedFailure(dispatch.state, response.error.code);
  }
  const invocation: McpInvocation = {
    input,
    operation,
    failure: null,
    dispatch: { kind: "not_dispatched" },
    remainingBytes: Math.min(
      input.request.maxWireBytes,
      input.request.maxDecodedBytes,
    ),
  };
  const client = new McpClient({
    name: "pantry",
    version: "1",
    requestTimeoutMs: remainingMs,
  });
  const transport = new StreamableHttpTransport({
    url: operation.url,
    fetch: fetchReviewedMcp.bind(null, invocation),
    openGetStream: false,
    maxMessageBytes: invocation.remainingBytes,
    reconnect: { maxRetries: 0 },
  });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    if (!catalog.some(isReviewedTool.bind(null, operation.toolName)))
      return reviewedFailure(invocation.dispatch, "mcp_tool_unavailable");
    // Every invocation reconnects and rechecks the exact Actor-owned operation.
    const result = await client.callTool(operation.toolName, {
      ...operation.arguments,
    });
    if (result.isError)
      return reviewedFailure(invocation.dispatch, "mcp_tool_error");
    const body = new TextEncoder().encode(JSON.stringify(result));
    if (body.byteLength > input.request.maxDecodedBytes)
      return reviewedFailure(invocation.dispatch, "response_too_large");
    return {
      ok: true,
      value: {
        status: 200,
        contentType: "application/json",
        body,
        sessionId: null,
      },
    };
  } catch {
    return reviewedFailure(
      invocation.dispatch,
      invocation.failure?.code ?? "transport_unavailable",
    );
  } finally {
    try {
      await client.close();
    } catch {
      // Session cleanup cannot change the operation's captured outcome.
    }
  }
}

function reviewedFailure(
  dispatch: DispatchState,
  code: CustomConnectorTransportError["code"],
): Result<never, ReviewedConnectorFailure> {
  switch (dispatch.kind) {
    case "not_dispatched":
      return { ok: false, error: { kind: "not_dispatched", code } };
    case "dispatch_started":
      return { ok: false, error: { kind: "dispatch_started", code } };
    default:
      return assertNever(dispatch);
  }
}

function isReviewedTool(name: string, tool: Tool): boolean {
  return tool.name === name;
}

async function fetchReviewedMcp(
  invocation: McpInvocation,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (init.signal !== undefined && init.signal !== null)
    return fetchReviewedMcpWithin(invocation, url, init, init.signal);
  // The fallback deadline ends with the request, so it keeps no Actor awake.
  const deadline = new RequestDeadline(
    Math.max(1, invocation.input.request.deadlineAtUnixMs - Date.now()),
  );
  try {
    return await fetchReviewedMcpWithin(invocation, url, init, deadline.signal);
  } finally {
    deadline.end();
  }
}

async function fetchReviewedMcpWithin(
  invocation: McpInvocation,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const { input, operation } = invocation;
  if (new URL(url).href !== operation.url.href)
    return failMcpFetch(invocation, "invalid_request");
  if (signal.aborted) return failMcpFetch(invocation, "execution_aborted");
  const headers = new Headers(init.headers);
  const metadata = {
    protocolVersion: headers.get("mcp-protocol-version"),
    sessionId: headers.get("mcp-session-id"),
  };
  let request: CustomConnectorOperationRequest;
  let dispatch: DispatchState = { kind: "not_dispatched" };
  let authorizeDispatch = input.authorizeCall;
  if (init.method === "DELETE") {
    authorizeDispatch = authorizeReviewedCleanup;
    request = { kind: "mcp_delete", url: operation.url, ...metadata };
  } else if (init.method === "POST" && typeof init.body === "string") {
    const message: unknown = JSON.parse(init.body);
    if (!isRecord(message)) return failMcpFetch(invocation, "invalid_request");
    switch (message.method) {
      case "initialize":
      case "notifications/initialized":
      case "tools/list":
        if (!(await input.authorizeCall()))
          return failMcpFetch(invocation, "authority_expired");
        break;
      case "notifications/cancelled":
        authorizeDispatch = authorizeReviewedCleanup;
        break;
      case "tools/call":
        if (
          !isRecord(message.params) ||
          message.params.name !== operation.toolName ||
          (await digestCanonical(message.params.arguments)) !==
            (await digestCanonical(operation.arguments)) ||
          !(await input.authorizeCall())
        )
          return failMcpFetch(invocation, "authority_expired");
        dispatch = { kind: "dispatch_started" };
        break;
      default:
        return failMcpFetch(invocation, "invalid_request");
    }
    request = {
      kind: "mcp_post",
      url: operation.url,
      body: new TextEncoder().encode(init.body),
      ...metadata,
    };
  } else {
    return failMcpFetch(invocation, "invalid_request");
  }
  if (invocation.remainingBytes <= 0)
    return failMcpFetch(invocation, "response_too_large");
  if (signal.aborted) return failMcpFetch(invocation, "execution_aborted");
  const response = await input.transport({
    namespace: input.namespace,
    signal,
    authorizeDispatch,
    onDispatch: recordMcpDispatch.bind(null, invocation, dispatch),
    request: {
      ...input.request,
      operation: request,
      deadlineAtUnixMs: Math.min(
        input.request.deadlineAtUnixMs,
        Date.now() + input.attemptTimeoutMs,
      ),
      maxWireBytes: invocation.remainingBytes,
      maxDecodedBytes: invocation.remainingBytes,
    },
  });
  if (!response.ok) return failMcpFetch(invocation, response.error.code);
  if (response.value.status === 401 || response.value.status === 403)
    return failMcpFetch(invocation, "mcp_auth_required");
  invocation.remainingBytes -= response.value.body.byteLength;
  if (signal.aborted) return failMcpFetch(invocation, "execution_aborted");
  const responseHeaders = new Headers();
  if (response.value.contentType !== null)
    responseHeaders.set("content-type", response.value.contentType);
  if (response.value.sessionId !== null)
    responseHeaders.set("mcp-session-id", response.value.sessionId);
  return new Response(
    response.value.body.byteLength === 0 ? null : response.value.body,
    { status: response.value.status, headers: responseHeaders },
  );
}

async function authorizeReviewedCleanup(): Promise<boolean> {
  // The validated endpoint can close an already-open MCP session after revocation.
  return true;
}

function failMcpFetch(
  invocation: McpInvocation,
  code: CustomConnectorTransportError["code"],
): never {
  invocation.failure = { code };
  throw new Error(code);
}

function recordRestDispatch(dispatch: { state: DispatchState }): void {
  dispatch.state = { kind: "dispatch_started" };
}

function recordMcpDispatch(
  invocation: McpInvocation,
  dispatch: DispatchState,
): void {
  if (dispatch.kind === "dispatch_started") invocation.dispatch = dispatch;
}
