import {
  parseEntityPlaneSystemExtensionRequest,
  parseEntityPlaneRelationshipTraversalStepRequest,
  parseCommerceGraphQueryPlanRequest,
  parseEntityPlaneCapabilityMetadataRequest,
  parseEntityPlanePublishedResourceMetadataRequest,
  parseEntityPlaneExportPresetPublishRequest,
  parsePurchasingPresetPublishRequest,
  parsePurchasingReconcileRequest,
} from "@seams/commerce-client";
import type { CommerceRoute } from "../../http-routes.ts";
import {
  parseEntityPlaneQueryRequest,
  parseSnapshotRevision,
} from "../../entity-plane/parsers.ts";
import type { Variant } from "@seams/type-utils";
import { errorMessage } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import {
  hasMerchantId,
  parseNonNegativeQueryNumber,
  parsePositiveQueryNumber,
  readJsonBody,
} from "../request-body.ts";
import { entityPlaneErrorResponse, jsonResponse } from "../responses.ts";

export async function handleEntityPlane(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    CommerceRoute,
    | "entity_plane_list_entry"
    | "entity_plane_query"
    | "entity_plane_query_plan"
    | "entity_plane_capability_metadata"
    | "entity_plane_published_resource_metadata"
    | "entity_plane_export_preset"
    | "entity_plane_purchasing_preset"
    | "entity_plane_purchasing_reconcile"
    | "entity_plane_relationship_step"
    | "entity_plane_command"
    | "entity_plane_changes"
    | "entity_plane_system_extensions"
  >,
): Promise<Response> {
  if (ctx.entityPlane === undefined)
    return jsonResponse(503, { message: "Entity plane is unavailable" });
  if (route.kind === "entity_plane_changes") {
    const url = new URL(request.url);
    let afterMerchantRevision: number;
    let limit: number;
    try {
      afterMerchantRevision = parseNonNegativeQueryNumber(
        url.searchParams.get("after"),
        "after",
      );
      limit = parsePositiveQueryNumber(url.searchParams.get("limit"), "limit");
      if (limit > 500) throw new Error("limit is out of bounds");
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    try {
      return jsonResponse(
        200,
        ctx.entityPlane.readChanges({
          merchantId: route.merchantId,
          afterMerchantRevision: parseSnapshotRevision(
            afterMerchantRevision,
            "after",
          ),
          limit,
        }),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId)) {
    return jsonResponse(400, {
      message: "Merchant path and entity-plane request must match",
    });
  }
  if (route.kind === "entity_plane_capability_metadata") {
    let parsed: ReturnType<typeof parseEntityPlaneCapabilityMetadataRequest>;
    try {
      parsed = parseEntityPlaneCapabilityMetadataRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId)
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    try {
      return jsonResponse(200, ctx.entityPlane.readCapabilityMetadata(parsed));
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_published_resource_metadata") {
    let parsed: ReturnType<
      typeof parseEntityPlanePublishedResourceMetadataRequest
    >;
    try {
      parsed = parseEntityPlanePublishedResourceMetadataRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId)
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    try {
      return jsonResponse(
        200,
        ctx.entityPlane.readPublishedResourceMetadata(parsed),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_export_preset") {
    let parsed: ReturnType<typeof parseEntityPlaneExportPresetPublishRequest>;
    try {
      parsed = parseEntityPlaneExportPresetPublishRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId)
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    try {
      return jsonResponse(
        200,
        await ctx.entityPlane.publishEntityPlaneExportPreset(parsed),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_purchasing_preset") {
    let parsed: ReturnType<typeof parsePurchasingPresetPublishRequest>;
    try {
      parsed = parsePurchasingPresetPublishRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId)
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    try {
      return jsonResponse(
        200,
        await ctx.entityPlane.publishPurchasingPreset(parsed),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_purchasing_reconcile") {
    let parsed: ReturnType<typeof parsePurchasingReconcileRequest>;
    try {
      parsed = parsePurchasingReconcileRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId)
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    try {
      return jsonResponse(
        200,
        await ctx.entityPlane.reconcilePurchasing(parsed),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_relationship_step") {
    let parsed: ReturnType<
      typeof parseEntityPlaneRelationshipTraversalStepRequest
    >;
    try {
      parsed = parseEntityPlaneRelationshipTraversalStepRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId) {
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    }
    try {
      return jsonResponse(
        200,
        ctx.entityPlane.readValidatedRelationshipTraversalStep(parsed),
      );
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_query_plan") {
    let parsed: ReturnType<typeof parseCommerceGraphQueryPlanRequest>;
    try {
      parsed = parseCommerceGraphQueryPlanRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    if (parsed.merchantId !== route.merchantId) {
      return jsonResponse(400, {
        message: "Merchant path and entity-plane request must match",
      });
    }
    try {
      const result = ctx.entityPlane.executePlannedQuery(parsed);
      return jsonResponse(200, result);
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_list_entry") {
    try {
      return jsonResponse(200, ctx.entityPlane.readListEntry(body.value));
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
  }
  if (route.kind === "entity_plane_query") {
    let parsed: ReturnType<typeof parseEntityPlaneQueryRequest>;
    try {
      parsed = parseEntityPlaneQueryRequest(body.value);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    try {
      const result = ctx.entityPlane.readQuery(parsed);
      return jsonResponse(200, result);
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      throw error;
    }
  }
  if (route.kind === "entity_plane_command") {
    try {
      return jsonResponse(200, ctx.entityPlane.command(body.value));
    } catch (error) {
      const response = entityPlaneErrorResponse(error);
      if (response !== undefined) return response;
      if (error instanceof Error)
        return jsonResponse(400, { message: error.message });
      throw error;
    }
  }
  let parsed: ReturnType<typeof parseEntityPlaneSystemExtensionRequest>;
  try {
    parsed = parseEntityPlaneSystemExtensionRequest(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  try {
    return jsonResponse(
      200,
      ctx.entityPlane.readSystemExtensionSidecars(parsed),
    );
  } catch (error) {
    const response = entityPlaneErrorResponse(error);
    if (response !== undefined) return response;
    throw error;
  }
}
