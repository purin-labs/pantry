import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", mockContainers);

import {
  dispatchWorkspaceExecution,
  parseWorkspaceExecutorResponse,
  type WorkspaceExecutorRequest,
  type WorkspaceExecutorTransport,
} from "../src/workspace-executor-container";
import { isRecord } from "@seams/std";

describe("workspace executor response boundary", function workspaceExecutorBoundarySuite() {
  it("accepts the exact execution identity and bounded overlay", function acceptsResponse() {
    const request = requestFixture();
    const parsed = parseWorkspaceExecutorResponse(
      JSON.stringify(responseFixture(request)),
      request,
    );

    expect(parsed).toEqual({
      ok: true,
      value: responseFixture(request),
    });
  });

  it("rejects a response from another execution", function rejectsExecutionMismatch() {
    const request = requestFixture();
    const response = responseFixture(request);
    response.executionId = "execution_other";

    expect(
      parseWorkspaceExecutorResponse(JSON.stringify(response), request),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "executionId" },
    });
  });

  it("rejects additional replacement files", function rejectsExpandedOverlay() {
    const request = requestFixture();
    const response = responseFixture(request);
    const operation = requireRecord(response.operation);
    const overlay = requireRecord(operation.replacementOverlay);
    overlay.workspaceYaml = { path: "workspace.yaml", utf8: "forged" };

    expect(
      parseWorkspaceExecutorResponse(JSON.stringify(response), request),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        field: "operation.replacementOverlay",
      },
    });
  });

  it("bounds execution by the request deadline", async function enforcesDeadline() {
    const request = { ...requestFixture(), deadlineAtUnixMs: Date.now() - 1 };

    const result = await dispatchWorkspaceExecution(
      abortingTransport(),
      request,
    );

    expect(result).toEqual({
      kind: "failed",
      error: { kind: "deadline_exceeded" },
      usage: {
        requestBytes: new TextEncoder().encode(JSON.stringify(request))
          .byteLength,
        responseBytes: 0,
        gatewayDurationMs: expect.any(Number),
      },
    });
  });

  it("normalizes a Container process failure after response headers", async function normalizesProcessFailure() {
    const request = requestFixture();

    const result = await dispatchWorkspaceExecution(
      responseTransport(new Response(failingBodyStream())),
      request,
    );

    expect(result).toEqual({
      kind: "failed",
      error: {
        kind: "container_unavailable",
        reason: "executor process terminated",
      },
      usage: {
        requestBytes: new TextEncoder().encode(JSON.stringify(request))
          .byteLength,
        responseBytes: 0,
        gatewayDurationMs: expect.any(Number),
      },
    });
  });

  it("rejects invalid UTF-8 as a typed response failure", async function rejectsInvalidUtf8() {
    const request = requestFixture();
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);

    const result = await dispatchWorkspaceExecution(
      responseTransport(new Response(invalidUtf8)),
      request,
    );

    expect(result).toEqual({
      kind: "failed",
      error: { kind: "invalid_response", field: "bodyEncoding" },
      usage: {
        requestBytes: new TextEncoder().encode(JSON.stringify(request))
          .byteLength,
        responseBytes: invalidUtf8.byteLength,
        gatewayDurationMs: expect.any(Number),
      },
    });
  });
});

function responseTransport(response: Response): WorkspaceExecutorTransport {
  return { containerFetch: resolveResponse.bind(null, response) };
}

function resolveResponse(response: Response): Promise<Response> {
  return Promise.resolve(response);
}

function failingBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: rejectBodyRead });
}

function rejectBodyRead(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.error(new Error("executor process terminated"));
}

function abortingTransport(): WorkspaceExecutorTransport {
  return { containerFetch: rejectOnAbort };
}

function rejectOnAbort(_input: string, init: RequestInit): Promise<Response> {
  const signal = init.signal;
  if (signal === null || signal === undefined) {
    return Promise.reject(new Error("missing abort signal"));
  }
  return new Promise<Response>(registerAbortRejection.bind(null, signal));
}

function registerAbortRejection(
  signal: AbortSignal,
  _resolve: (value: Response | PromiseLike<Response>) => void,
  reject: (reason?: unknown) => void,
): void {
  if (signal.aborted) {
    reject(signal.reason);
    return;
  }
  signal.addEventListener(
    "abort",
    rejectWithSignalReason.bind(null, signal, reject),
    {
      once: true,
    },
  );
}

function rejectWithSignalReason(
  signal: AbortSignal,
  reject: (reason?: unknown) => void,
): void {
  reject(signal.reason);
}

function requestFixture(): WorkspaceExecutorRequest {
  return {
    schemaVersion: "workspace_executor_request.v1",
    executionId: "execution_123",
    executionReceiptId: "receipt-execution_123",
    deadlineAtUnixMs: 1_800_000_000_000,
    baseRevision: "workspace_revision_42",
    baseCanonicalHead:
      "8cf934c40388c5b902ee1fd48bd60aeb7eb21bbad135a362db30ae4dbb1e4f31",
    baseManifestDigest:
      "7e58973e38c083cd0d7bf2762b44a952f39bbad0b321d7ac539bb9b5cd9fd9a0",
    operation: {
      kind: "product_folder_candidate",
      productRoot: "products/product_field_watch",
      workspaceYaml: "schemaVersion: satyr.workspace.v1\n",
      base: {
        productMarkdown: "# Field Watch\n",
        variantsYaml: "schemaVersion: satyr.variants.v1\n",
      },
      candidate: {
        productMarkdown: "# Field Watch II\n",
        variantsYaml: "schemaVersion: satyr.variants.v1\n",
      },
      claimedChangeset: {
        schemaVersion: "satyr.product-folder-changeset.v1",
        organisationId: "organisation_demo",
        workspaceId: "workspace_demo",
        baseRevision: "workspace_revision_42",
        resultingSemanticHash:
          "108a99770a914bed69a04ed62d87d87bed46056960df035e71d4df69631ad9a4",
        diff: {
          productId: "product_field_watch",
          fields: ["title"],
          variantIds: [],
        },
        changesetDigest:
          "3f15b9c12663615cd4f4d73360529602e2b2af67e69b71b53c0ad39abac14754",
      },
    },
  };
}

function responseFixture(
  request: WorkspaceExecutorRequest,
): Record<string, unknown> {
  return {
    schemaVersion: "workspace_executor_response.v1",
    executionId: request.executionId,
    executionReceiptId: request.executionReceiptId,
    baseRevision: request.baseRevision,
    baseCanonicalHead: request.baseCanonicalHead,
    baseManifestDigest: request.baseManifestDigest,
    operation: {
      kind: "validated_product_folder_changeset",
      productRoot: request.operation.productRoot,
      replacementOverlay: {
        productMarkdown: {
          path: `${request.operation.productRoot}/product.md`,
          utf8: request.operation.candidate.productMarkdown,
        },
        variantsYaml: {
          path: `${request.operation.productRoot}/variants.yaml`,
          utf8: request.operation.candidate.variantsYaml,
        },
      },
      validatedChangeset: request.operation.claimedChangeset,
    },
    inputBytes: 1024,
    outputBytes: 512,
    durationMs: 12,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected record fixture");
  }
  return value;
}

function mockContainers(): { Container: new () => MockContainer } {
  class Container {}
  return { Container };
}

class MockContainer {}
