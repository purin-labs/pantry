import { projectReviewedResponse } from "./response-projection";
import {
  executeCustomConnectorTransport,
  type CustomConnectorFetchNamespace,
} from "./egress";
import type { Result } from "@purin-labs/kernel/result";
import { type CustomConnectorOperation, type JsonValue } from "./definition";
import type {
  CustomConnectorIdentityTestRequest,
  CustomConnectorIdentityTestResult,
} from "./setup";
import { isRecord } from "@purin-labs/std";
import { buildCustomConnectorOperationRequest } from "./execution";
import { executeReviewedConnectorOperation } from "./mcp";

const TEXT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

export function createCustomConnectorIdentityTestExecutor(
  namespace: CustomConnectorFetchNamespace,
): (
  request: CustomConnectorIdentityTestRequest,
) => Promise<
  Result<
    CustomConnectorIdentityTestResult,
    { readonly code: string; readonly correlationId: string }
  >
> {
  return executeCustomConnectorIdentityTest.bind(null, namespace);
}

async function executeCustomConnectorIdentityTest(
  namespace: CustomConnectorFetchNamespace,
  request: CustomConnectorIdentityTestRequest,
): Promise<
  Result<
    CustomConnectorIdentityTestResult,
    { readonly code: string; readonly correlationId: string }
  >
> {
  const correlationId = `custom_connector_test_${crypto.randomUUID()}`;
  const operationRequest = buildCustomConnectorOperationRequest(
    {
      origin: request.origin,
      operation: request.operation,
      limits: request.limits,
    },
    request.arguments,
  );
  if (!operationRequest.ok) {
    return failure("invalid_test_request", correlationId);
  }
  const deadlineAtUnixMs =
    Date.now() +
    Math.min(
      request.limits.attemptTimeoutMs,
      request.limits.invocationTimeoutMs,
    );
  const response = await executeReviewedConnectorOperation({
    namespace,
    transport: executeCustomConnectorTransport,
    attemptTimeoutMs: request.limits.attemptTimeoutMs,
    authorizeCall: authorizeIdentityProbe.bind(null, request),
    request: {
      organisationId: request.organisationId,
      authentication: request.authentication,
      operation: operationRequest.value,
      deadlineAtUnixMs,
      maxWireBytes: request.limits.wireBytes,
      maxDecodedBytes: request.limits.decodedBytes,
    },
  });
  if (!response.ok) return failure(response.error.code, correlationId);
  if (
    !request.operation.response.successStatuses.includes(response.value.status)
  ) {
    return failure("identity_probe_rejected", correlationId);
  }
  if (!isJsonContentType(response.value.contentType)) {
    return failure("response_contract_changed", correlationId);
  }
  const projected = parseProjectedResponse(
    response.value.body,
    request.operation,
  );
  if (projected === null) {
    return failure("response_contract_changed", correlationId);
  }
  const accountValue = readJsonPointer(projected, request.accountIdPointer);
  const accountId =
    typeof accountValue === "number" && Number.isSafeInteger(accountValue)
      ? String(accountValue)
      : accountValue;
  const displayName = readJsonPointer(projected, request.displayNamePointer);
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId.length > 512 ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    displayName.length > 512
  ) {
    return failure("response_contract_changed", correlationId);
  }
  return {
    ok: true,
    value: { providerAccountId: accountId, displayName, preview: projected },
  };
}

async function authorizeIdentityProbe(
  request: CustomConnectorIdentityTestRequest,
): Promise<boolean> {
  return request.operation.effect.kind === "read";
}

function parseProjectedResponse(
  body: Uint8Array,
  operation: CustomConnectorOperation,
): JsonValue | null {
  let raw: unknown;
  try {
    raw = JSON.parse(TEXT_DECODER.decode(body));
  } catch {
    return null;
  }
  const result = readJsonPointer(raw, operation.response.resultPointer);
  const projected = projectReviewedResponse(
    result,
    operation.response.outputSchema,
  );
  return projected.ok ? projected.value : null;
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isJsonContentType(value: string | null): boolean {
  return (
    value !== null && /^(application\/json|[^;]+\+json)(?:;|$)/iu.test(value)
  );
}

function failure(
  code: string,
  correlationId: string,
): Result<never, { readonly code: string; readonly correlationId: string }> {
  return { ok: false, error: { code, correlationId } };
}
