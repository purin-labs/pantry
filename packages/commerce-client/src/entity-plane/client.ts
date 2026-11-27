import {
  commerceBearerToken,
  type CommerceCredential,
} from "../app-access.ts";
import {
  parseCommerceGraphResponse,
  parseEntityPlaneChanges,
  parseEntityPlaneCommand,
  parseEntityPlaneCommandResult,
  parseEntityPlaneQueryRequest,
  parseEntityPlaneCapabilityMetadataRequest,
  parseEntityPlaneCapabilityMetadataResponse,
  parseEntityPlaneExportPresetPublishRequest,
  parseEntityPlaneExportPresetPublishResponse,
  parseEntityPlanePublishedResourceMetadataRequest,
  parseEntityPlanePublishedResourceMetadataResponse,
  parseEntityPlaneSystemExtensionRequest,
  parseEntityPlaneSystemExtensionResponse,
  parseCommerceGraphQueryPlanRequest,
  parseEntityPlaneRelationshipTraversalStepRequest,
  parseEntityPlaneRelationshipTraversalStepResponse,
  parseCommerceEntityPlanePlannedQueryResponse,
  type CommerceEntityPlaneCommandRequest,
  type CommerceEntityPlaneQueryRequest,
  type CommerceEntityPlanePlannedQueryResponse,
  type CommerceEntityPlaneChanges,
  type CommerceEntityPlaneSystemExtensionRequest,
  type CommerceEntityPlaneSystemExtensionResponse,
  type CommerceEntityPlaneCapabilityMetadataRequest,
  type CommerceEntityPlaneCapabilityMetadataResponse,
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetPublishResponse,
  type CommerceEntityPlanePublishedResourceMetadataRequest,
  type CommerceEntityPlanePublishedResourceMetadataResponse,
} from "./parsers.ts";
import type {
  CommerceCommandResult,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceGraphQueryResult,
  CommerceSnapshotRevision,
} from "@purin-labs/commerce-contracts";
import type {
  CommerceEntityPlaneRelationshipTraversalStepRequest,
  CommerceEntityPlaneRelationshipTraversalStepResponse,
} from "./parsers.ts";
import {
  parsePurchasingPresetPublishRequest,
  parsePurchasingPresetPublishResponse,
  parsePurchasingReconcileRequest,
  parsePurchasingReconcileResponse,
  type CommercePurchasingPresetPublishRequest,
  type CommercePurchasingPresetPublishResponse,
  type CommercePurchasingReconcileRequest,
  type CommercePurchasingReconcileResponse,
} from "./purchasing.ts";
import {
  parseListEntryReadRequest,
  parseListEntryReadResult,
  type CommerceListEntryReadRequest,
  type CommerceListEntryReadResult,
} from "./resources.ts";
import { errorMessage, isNormalizedText, isRecord } from "@purin-labs/std";

export type CommerceEntityPlaneFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CommerceEntityPlaneClientConfig = Readonly<{
  baseUrl: string;
  /** The operator token, an API key, or a token for each merchant. */
  serviceToken: CommerceCredential;
  fetch?: CommerceEntityPlaneFetch;
}>;

type CommerceEntityPlaneClientError =
  | Readonly<{ kind: "cursor_stale"; message: string }>
  | Readonly<{ kind: "network"; message: string }>
  | Readonly<{ kind: "http"; status: number; message: string }>
  | Readonly<{ kind: "invalid_response"; message: string }>;

type CommerceEntityPlaneClientResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: CommerceEntityPlaneClientError }>;

export class CommerceEntityPlaneClient {
  readonly #baseUrl: string;
  readonly #serviceToken: CommerceCredential;
  readonly #fetch: CommerceEntityPlaneFetch;

  constructor(config: CommerceEntityPlaneClientConfig) {
    this.#baseUrl = requireBaseUrl(config.baseUrl);
    this.#serviceToken =
      typeof config.serviceToken === "string"
        ? requireText(config.serviceToken, "serviceToken")
        : config.serviceToken;
    this.#fetch = (config.fetch ?? globalThis.fetch).bind(globalThis);
  }

  async readListEntry(
    request: CommerceListEntryReadRequest,
  ): Promise<CommerceEntityPlaneClientResult<CommerceListEntryReadResult>> {
    const parsed = parseListEntryReadRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(parsed.merchantId)}/entity-plane/list-entry`,
      { method: "POST", body: encodeJson(parsed) },
      parseListEntryReadResult,
    );
  }

  async query(
    merchantId: string,
    query: CommerceGraphQuery,
  ): Promise<CommerceEntityPlaneClientResult<CommerceGraphQueryResult>>;
  async query(
    request: CommerceEntityPlaneQueryRequest,
  ): Promise<CommerceEntityPlaneClientResult<CommerceGraphQueryResult>>;
  async query(
    merchantOrRequest: string | CommerceEntityPlaneQueryRequest,
    query?: CommerceGraphQuery,
  ): Promise<CommerceEntityPlaneClientResult<CommerceGraphQueryResult>> {
    const request =
      typeof merchantOrRequest === "string"
        ? {
            merchantId: requireText(merchantOrRequest, "merchantId"),
            query: query ?? fail("query is required"),
          }
        : parseEntityPlaneQueryRequest(merchantOrRequest);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(request.merchantId, "queryRequest.merchantId"))}/entity-plane/query`,
      { method: "POST", body: encodeJson(request) },
      parseCommerceGraphResponse,
    );
  }

  async capabilityMetadata(
    request: CommerceEntityPlaneCapabilityMetadataRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlaneCapabilityMetadataResponse>
  > {
    const parsed = parseEntityPlaneCapabilityMetadataRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "capabilityMetadataRequest.merchantId"))}/entity-plane/capability-metadata`,
      { method: "POST", body: encodeJson(parsed) },
      parseEntityPlaneCapabilityMetadataResponse,
    );
  }

  async publishedResourceMetadata(
    request: CommerceEntityPlanePublishedResourceMetadataRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlanePublishedResourceMetadataResponse>
  > {
    const parsed = parseEntityPlanePublishedResourceMetadataRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "publishedResourceMetadataRequest.merchantId"))}/entity-plane/published-resources`,
      { method: "POST", body: encodeJson(parsed) },
      parseEntityPlanePublishedResourceMetadataResponse,
    );
  }

  async publishExportPreset(
    request: CommerceEntityPlaneExportPresetPublishRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlaneExportPresetPublishResponse>
  > {
    const parsed = parseEntityPlaneExportPresetPublishRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "exportPresetPublishRequest.merchantId"))}/entity-plane/export-preset`,
      { method: "POST", body: encodeJson(parsed) },
      parseEntityPlaneExportPresetPublishResponse,
    );
  }

  async publishPurchasingPreset(
    request: CommercePurchasingPresetPublishRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommercePurchasingPresetPublishResponse>
  > {
    const parsed = parsePurchasingPresetPublishRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "purchasingPresetPublishRequest.merchantId"))}/entity-plane/purchasing-preset`,
      { method: "POST", body: encodeJson(parsed) },
      parsePurchasingPresetPublishResponse,
    );
  }

  async publishProductionDemandPreset(request: CommercePurchasingPresetPublishRequest): Promise<CommerceEntityPlaneClientResult<CommercePurchasingPresetPublishResponse>> {
    const parsed = parsePurchasingPresetPublishRequest(request);
    return this.#request(`/v1/admin/merchants/${encodeURIComponent(parsed.merchantId)}/entity-plane/production-demand-preset`, { method: "POST", body: encodeJson(parsed) }, parsePurchasingPresetPublishResponse);
  }

  async reconcilePurchasing(
    request: CommercePurchasingReconcileRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommercePurchasingReconcileResponse>
  > {
    const parsed = parsePurchasingReconcileRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "purchasingReconcileRequest.merchantId"))}/entity-plane/purchasing-reconcile`,
      { method: "POST", body: encodeJson(parsed) },
      parsePurchasingReconcileResponse,
    );
  }

  async command(
    command: CommerceEntityPlaneCommandRequest,
  ): Promise<CommerceEntityPlaneClientResult<CommerceCommandResult>> {
    const request = parseEntityPlaneCommand(command);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(request.merchantId, "commandRequest.merchantId"))}/entity-plane/commands`,
      { method: "POST", body: encodeJson(request) },
      parseEntityPlaneCommandResult,
    );
  }

  async queryPlan(
    request: CommerceGraphQueryPlanRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlanePlannedQueryResponse>
  > {
    const parsed = parseCommerceGraphQueryPlanRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "queryPlanRequest.merchantId"))}/entity-plane/query-plan`,
      { method: "POST", body: encodeJson(parsed) },
      parseCommerceEntityPlanePlannedQueryResponse,
    );
  }

  async readRelationshipTraversalStep(
    request: CommerceEntityPlaneRelationshipTraversalStepRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlaneRelationshipTraversalStepResponse>
  > {
    const parsed = parseEntityPlaneRelationshipTraversalStepRequest(request);
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(requireText(parsed.merchantId, "relationshipTraversalStepRequest.merchantId"))}/entity-plane/relationship-step`,
      { method: "POST", body: encodeJson(parsed) },
      parseEntityPlaneRelationshipTraversalStepResponse,
    );
  }

  async changes(
    merchantId: string,
    afterMerchantRevision: CommerceSnapshotRevision,
    limit = 100,
  ): Promise<CommerceEntityPlaneClientResult<CommerceEntityPlaneChanges>> {
    const normalizedMerchantId = requireText(merchantId, "merchantId");
    const cursor = nonNegativeInteger(
      afterMerchantRevision,
      "afterMerchantRevision",
    );
    const pageSize = positiveInteger(limit, "limit");
    if (pageSize > 100) throw new Error("limit must not exceed 100");
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(normalizedMerchantId)}/entity-plane/changes?after=${cursor}&limit=${pageSize}`,
      { method: "GET" },
      parseEntityPlaneChanges,
    );
  }

  async readSystemExtensionSidecars(
    request: CommerceEntityPlaneSystemExtensionRequest,
  ): Promise<
    CommerceEntityPlaneClientResult<CommerceEntityPlaneSystemExtensionResponse>
  > {
    const parsed = parseEntityPlaneSystemExtensionRequest(request);
    const merchantId = requireText(
      parsed.merchantId,
      "systemExtensionRequest.merchantId",
    );
    const organisationId = requireText(
      parsed.organisationId,
      "systemExtensionRequest.organisationId",
    );
    if (parsed.entityRefs.length > 100)
      throw new Error("entityRefs must not exceed 100");
    return this.#request(
      `/v1/internal/merchants/${encodeURIComponent(merchantId)}/entity-plane/system-extensions`,
      { method: "POST", body: encodeJson({ ...parsed, merchantId, organisationId }) },
      parseEntityPlaneSystemExtensionResponse,
    );
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    parser: (value: unknown) => T,
  ): Promise<CommerceEntityPlaneClientResult<T>> {
    let response: Response;
    try {
      const token = await commerceBearerToken(this.#serviceToken, path);
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      return {
        ok: false,
        error: { kind: "network", message: errorMessage(error) },
      };
    }
    const raw = await readJsonResponse(response);
    if (
      response.status === 409 &&
      isRecord(raw) &&
      raw.queryFailure === "cursor_stale"
    )
      return {
        ok: false,
        error: {
          kind: "cursor_stale",
          message: "Commerce cursor watermark is stale",
        },
      };
    if (!response.ok)
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: responseMessage(raw),
        },
      };
    try {
      return { ok: true, value: parser(raw) };
    } catch (error) {
      return {
        ok: false,
        error: { kind: "invalid_response", message: errorMessage(error) },
      };
    }
  }
}

function requireBaseUrl(value: unknown): string {
  const parsed = new URL(requireText(value, "baseUrl"));
  return parsed.toString().replace(/\/$/u, "");
}

function requireText(value: unknown, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${field} must be positive`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be non-negative`);
  return value;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  )
    return value.message;
  return "Commerce entity-plane request failed";
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value, encodeJsonValue);
}

function encodeJsonValue(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const encoded = Number(value);
  if (!Number.isSafeInteger(encoded))
    throw new Error(
      "Commerce integer exceeds the JSON safe-integer boundary",
    );
  return encoded;
}
