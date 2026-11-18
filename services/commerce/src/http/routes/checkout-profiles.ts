import {
  parseActivateCheckoutProfileCommand,
  parseCreateCheckoutProfileDraftCommand,
  parsePublishCheckoutProfileCommand,
  parsePublishPointOfSaleConfigurationCommand,
  parseReplaceCheckoutProfileDraftCommand,
  parseRetireCheckoutProfileCommand,
  type PublishCommercePointOfSaleConfigurationV1,
} from "@seams/commerce-client";
import { CommerceAuthority } from "../../commerce-authority.ts";
import type {
  CheckoutProfileRoute,
  PointOfSaleConfigurationRoute,
} from "../../http-routes.ts";
import type { CheckoutProfileCommandResult } from "../../checkout-profile-service.ts";
import { assertNever, errorMessage } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";

/**
 * The policy a counter sells under.
 *
 * Reads are by Pantry location rather than by configuration id: an operator
 * standing at a till knows where they are, not which revision is in force.
 */
export async function handlePointOfSaleConfiguration(
  ctx: HttpRouteContext,
  request: Request,
  route: PointOfSaleConfigurationRoute,
): Promise<Response> {
  if (route.kind === "list_point_of_sale_configurations") {
    return jsonResponse(
      200,
      ctx.authority.listPointOfSaleConfigurations(route.merchantId),
    );
  }
  if (route.kind === "read_point_of_sale_configuration") {
    const configuration = ctx.authority.readPublishedPointOfSaleConfiguration(
      route.merchantId,
      route.satyrLocationId,
    );
    return configuration === undefined
      ? jsonResponse(404, {
          message: "Point of sale configuration not found",
        })
      : jsonResponse(200, configuration);
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command: PublishCommercePointOfSaleConfigurationV1;
  try {
    command = parsePublishPointOfSaleConfigurationCommand(body.value);
  } catch (cause) {
    return jsonResponse(400, {
      message: cause instanceof Error ? cause.message : "Command is invalid",
    });
  }
  if (command.merchantId !== route.merchantId) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  const published = ctx.authority.publishPointOfSaleConfiguration({
    merchantId: command.merchantId,
    expectedRevision: command.expectedRevision,
    publishedAt: command.publishedAt,
    publishedBy: command.publishedBy,
    configuration: command.configuration,
  });
  return published.ok
    ? jsonResponse(200, published.value)
    : jsonResponse(
        published.error.code === "merchant_not_found" ? 404 : 409,
        published.error,
      );
}

export async function handleCheckoutProfile(
  ctx: HttpRouteContext,
  request: Request,
  route: CheckoutProfileRoute,
): Promise<Response> {
  switch (route.kind) {
    case "list_checkout_profiles":
      return jsonResponse(
        200,
        ctx.authority.listCheckoutProfiles(route.merchantId),
      );
    case "list_checkout_profile_activations":
      return jsonResponse(
        200,
        ctx.authority.listCheckoutProfileActivations(route.merchantId),
      );
    case "list_storefronts":
      return jsonResponse(
        200,
        ctx.authority.listStorefrontIds(route.merchantId),
      );
    case "read_storefront": {
      const storefront = ctx.authority.readStorefront(
        route.merchantId,
        route.storefrontId,
      );
      return storefront === undefined
        ? jsonResponse(404, { message: "Storefront not found" })
        : jsonResponse(200, storefront);
    }
    case "read_checkout_profile": {
      const profile = ctx.authority.readCheckoutProfile(
        route.merchantId,
        route.checkoutProfileId,
        route.revision,
      );
      return profile === undefined
        ? jsonResponse(404, { message: "Checkout profile not found" })
        : jsonResponse(200, profile);
    }
    case "read_active_checkout_profile": {
      const active = ctx.authority.readActiveCheckoutProfile(
        route.merchantId,
        route.storefrontId,
      );
      return active === undefined
        ? jsonResponse(404, { message: "Active checkout profile not found" })
        : jsonResponse(200, active);
    }
    case "create_checkout_profile":
    case "replace_checkout_profile_draft":
    case "publish_checkout_profile":
    case "retire_checkout_profile":
    case "activate_checkout_profile": {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      try {
        return checkoutProfileCommandResponse(
          executeCheckoutProfileCommand(ctx.authority, route, body.value),
        );
      } catch (error) {
        return jsonResponse(400, { message: errorMessage(error) });
      }
    }
  }
}

function executeCheckoutProfileCommand(
  authority: CommerceAuthority,
  route: Exclude<
    CheckoutProfileRoute,
    | Readonly<{ kind: "list_checkout_profiles"; merchantId: string }>
    | Readonly<{
        kind: "list_checkout_profile_activations";
        merchantId: string;
      }>
    | Readonly<{
        kind: "list_storefronts";
        merchantId: string;
      }>
    | Readonly<{
        kind: "read_storefront";
        merchantId: string;
        storefrontId: string;
      }>
    | Readonly<{
        kind: "read_checkout_profile";
        merchantId: string;
        checkoutProfileId: string;
        revision: number;
      }>
    | Readonly<{
        kind: "read_active_checkout_profile";
        merchantId: string;
        storefrontId: string;
      }>
  >,
  raw: unknown,
): CheckoutProfileCommandResult<unknown> {
  switch (route.kind) {
    case "create_checkout_profile": {
      const command = parseCreateCheckoutProfileDraftCommand(raw);
      requireProfilePath(command.merchantId === route.merchantId);
      return authority.createCheckoutProfileDraft(command);
    }
    case "replace_checkout_profile_draft": {
      const command = parseReplaceCheckoutProfileDraftCommand(raw);
      requireProfilePath(
        command.merchantId === route.merchantId &&
          command.checkoutProfileId === route.checkoutProfileId,
      );
      return authority.replaceCheckoutProfileDraft(command);
    }
    case "publish_checkout_profile": {
      const command = parsePublishCheckoutProfileCommand(raw);
      requireProfilePath(
        command.merchantId === route.merchantId &&
          command.checkoutProfileId === route.checkoutProfileId,
      );
      return authority.publishCheckoutProfile(command);
    }
    case "retire_checkout_profile": {
      const command = parseRetireCheckoutProfileCommand(raw);
      requireProfilePath(
        command.merchantId === route.merchantId &&
          command.checkoutProfileId === route.checkoutProfileId,
      );
      return authority.retireCheckoutProfile(command);
    }
    case "activate_checkout_profile": {
      const command = parseActivateCheckoutProfileCommand(raw);
      requireProfilePath(
        command.merchantId === route.merchantId &&
          command.storefrontId === route.storefrontId,
      );
      return authority.activateCheckoutProfile(command);
    }
  }
}

function checkoutProfileCommandResponse(
  result: CheckoutProfileCommandResult<unknown>,
): Response {
  if (result.ok) return jsonResponse(200, result.value);
  switch (result.error.code) {
    case "invalid_profile":
      return jsonResponse(400, result);
    case "merchant_not_found":
    case "profile_not_found":
    case "storefront_not_found":
      return jsonResponse(404, result);
    case "profile_exists":
    case "revision_conflict":
    case "invalid_lifecycle":
    case "profile_active":
      return jsonResponse(409, result);
    default:
      return assertNever(
        result.error,
        "Unsupported buyer shipping destination",
      );
  }
}

function requireProfilePath(matches: boolean): void {
  if (!matches) throw new Error("Checkout profile path and command must match");
}
