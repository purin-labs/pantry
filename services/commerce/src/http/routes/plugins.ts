import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { errorMessage, isRecord } from "@purin-labs/std";
import { refuseCommandScopes } from "../admission.ts";
import type { HttpRouteContext } from "../context.ts";
import { hasMerchantId, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function listPluginsRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_plugins">,
): Promise<Response> {
  return jsonResponse(200, ctx.authority.listPlugins(route.merchantId));
}

export async function previewPluginChangeRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "preview_plugin_change">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let preview;
  try {
    preview = ctx.authority.previewPluginChange(
      route.merchantId,
      route.pluginId,
      body.value,
    );
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  return preview === undefined
    ? jsonResponse(404, { message: "Plugin not found" })
    : jsonResponse(200, preview);
}

export async function installMerchantPluginRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "install_merchant_plugin">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId))
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  const definition = isRecord(body.value) ? body.value.definition : null;
  const requirements = isRecord(definition) ? definition.requirements : null;
  const scopeRefusal = refuseCommandScopes(
    ctx,
    request,
    route.merchantId,
    isRecord(requirements) && Array.isArray(requirements.commands)
      ? requirements.commands
      : [],
  );
  if (scopeRefusal !== undefined) return scopeRefusal;
  return jsonResponse(200, ctx.authority.installMerchantPlugin(body.value));
}

export async function setPluginFieldValuesRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "set_plugin_field_values">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.pluginId !== route.pluginId ||
    body.value.entityType !== route.entityType ||
    body.value.entityId !== route.entityId
  )
    return jsonResponse(400, {
      message: "The path and the command must name the same record",
    });
  return jsonResponse(200, ctx.authority.setPluginFieldValues(body.value));
}

export async function runPluginActionRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "run_plugin_action">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.pluginId !== route.pluginId ||
    body.value.actionId !== route.actionId
  )
    return jsonResponse(400, {
      message: "The path and the command must name the same action",
    });
  const plugin = ctx.authority
    .listPlugins(route.merchantId)
    .plugins.find((item) => item.pluginId === route.pluginId);
  const scopeRefusal = refuseCommandScopes(
    ctx,
    request,
    route.merchantId,
    plugin?.requirements.commands ?? [],
  );
  if (scopeRefusal !== undefined) return scopeRefusal;
  return jsonResponse(200, ctx.authority.runPluginAction(body.value));
}

export async function listPluginFieldValuesRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_plugin_field_values">,
): Promise<Response> {
  const list = ctx.authority.listPluginFieldValues(
    route.merchantId,
    route.pluginId,
  );
  return list === undefined
    ? jsonResponse(404, { message: "Merchant plugin not found" })
    : jsonResponse(200, list);
}

export async function merchantPluginFunctionRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "run_plugin_function" | "preview_merchant_plugin">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let result;
  try {
    result =
      route.kind === "run_plugin_function"
        ? await ctx.authority.runPluginFunction(body.value)
        : await ctx.authority.previewMerchantPlugin(
            route.merchantId,
            body.value,
          );
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  return "kind" in result && result.kind === "rejected"
    ? jsonResponse(409, { outcome: "rejected", error: result.error })
    : jsonResponse(200, result);
}

export async function pluginStateRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "pause_plugin" | "resume_plugin" | "remove_plugin">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const schemaVersion =
    route.kind === "pause_plugin"
      ? "underclerk.pause-plugin.v1"
      : route.kind === "resume_plugin"
        ? "underclerk.resume-plugin.v1"
        : "underclerk.remove-plugin.v1";
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.pluginId !== route.pluginId ||
    body.value.schemaVersion !== schemaVersion
  )
    return jsonResponse(400, {
      message: "The path and the command must name the same change",
    });
  return jsonResponse(200, ctx.authority.changePlugin(body.value));
}

export async function configurePluginRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "configure_plugin">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.pluginId !== route.pluginId
  )
    return jsonResponse(400, {
      message: "The path and the command must name the same plugin",
    });
  return jsonResponse(200, ctx.authority.configurePlugin(body.value));
}
