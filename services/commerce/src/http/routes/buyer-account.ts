import { createHash } from "node:crypto";
import {
  parseRequestCustomerSignInCommand,
  parseSaveCustomerAddressCommand,
  parseVerifyCustomerSignInCommand,
} from "@seams/commerce-client";
import { CommerceAuthority } from "../../commerce-authority.ts";
import type { BuyerRoute } from "../../http-routes.ts";
import { BuyerSessionAuthority } from "../../buyer-session.ts";
import {
  type BuyerAccountIdentity,
  type BuyerAccountGateway,
  savedAddressForShipping,
} from "../../buyer-account.ts";
import { ShippingAddressValidationService } from "../../shipping-address-validation.ts";
import { errorMessage } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { bearerToken, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";

/**
 * The storefront's organisation, when its active checkout profile lets
 * buyers sign in.
 */
export function customerContext(
  ctx: HttpRouteContext,
  route: Readonly<{ merchantId: string; storefrontId: string }>,
): Readonly<{ organisationId: string }> | undefined {
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  const profile = ctx.authority.readActiveCheckoutProfile(
    route.merchantId,
    route.storefrontId,
  );
  return context === undefined ||
    profile?.profile.configuration.buyerPolicy.kind !== "guest_or_account"
    ? undefined
    : { organisationId: context.organisationId };
}

export async function requestCustomerSignInRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<BuyerRoute, { kind: "request_customer_sign_in" }>,
): Promise<Response> {
  const context = customerContext(ctx, route);
  if (context === undefined)
    return jsonResponse(409, {
      message: "Customer accounts are disabled for this storefront",
    });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseRequestCustomerSignInCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const challenge = ctx.authority.requestCustomerSignIn(
    route.merchantId,
    route.storefrontId,
    command.email,
  );
  return challenge === undefined
    ? jsonResponse(409, { message: "Customer accounts are disabled" })
    : jsonResponse(200, {
        schemaVersion: "underclerk.customer-sign-in-challenge.v1",
        ...challenge,
      });
}

export async function verifyCustomerSignInRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<BuyerRoute, { kind: "verify_customer_sign_in" }>,
): Promise<Response> {
  const context = customerContext(ctx, route);
  if (context === undefined)
    return jsonResponse(409, {
      message: "Customer accounts are disabled for this storefront",
    });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseVerifyCustomerSignInCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const verified = ctx.authority.verifyCustomerSignIn(
    route.merchantId,
    route.storefrontId,
    route.challengeId,
    command.code,
  );
  if (verified.kind === "rejected")
    return jsonResponse(409, {
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: `customerSignIn.${verified.reason}`,
      },
    });
  const access = ctx.buyerSessions.issueCustomerAccess({
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    customerId: verified.customerId,
  });
  return jsonResponse(200, {
    schemaVersion: "underclerk.customer-access.v1",
    customerAccessToken: access.token,
    expiresAt: access.claims.expiresAt,
  });
}

export async function buyerCustomerRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    BuyerRoute,
    { kind: "read_buyer_customer" | "save_customer_address" }
  >,
): Promise<Response> {
  const context = customerContext(ctx, route);
  const token = bearerToken(request);
  const access =
    context === undefined || token === undefined
      ? { ok: false as const }
      : ctx.buyerSessions.verifyCustomerAccess(token, {
          merchantId: route.merchantId,
          storefrontId: route.storefrontId,
        });
  if (!access.ok) return jsonResponse(401, { message: "Unauthorized" });
  if (route.kind === "read_buyer_customer") {
    const customer = ctx.authority.readBuyerCustomer(
      route.merchantId,
      access.claims.customerId,
    );
    return customer === undefined
      ? jsonResponse(401, { message: "Unauthorized" })
      : jsonResponse(200, customer);
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseSaveCustomerAddressCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const saved = ctx.authority.saveCustomerAddress(
    route.merchantId,
    access.claims.customerId,
    command.address,
  );
  return saved === undefined
    ? jsonResponse(401, { message: "Unauthorized" })
    : jsonResponse(200, saved);
}

// A signed-in customer's access token identifies the buyer of a new buyer
// session. A saved address reaches checkout only after the same address
// validation a typed address passes; one that needs a correction, or that
// Commerce cannot ship to, is typed again.
export function customerBuyerAccountGateway(
  authority: CommerceAuthority,
  buyerSessions: BuyerSessionAuthority,
  addressValidations: ShippingAddressValidationService | undefined,
): BuyerAccountGateway {
  return {
    identify: async (input) => {
      const access = buyerSessions.verifyCustomerAccess(
        input.customerAccessToken,
        input,
      );
      if (!access.ok) return { kind: "unavailable" };
      const customer = authority.identifyCustomer(
        input.merchantId,
        access.claims.customerId,
      );
      return customer === undefined
        ? { kind: "unavailable" }
        : {
            kind: "resolved",
            value: {
              protectedCustomerReference: access.claims.customerId,
              protectedCustomerSessionReference: access.claims.accessId,
              contact: { kind: "email", email: customer.email },
            },
          };
    },
    resolveSavedAddress: async (input) => {
      const saved = authority.readCustomerSavedAddress(
        input.merchantId,
        input.protectedCustomerReference,
        input.savedAddressReference,
      );
      const address =
        saved === undefined ? undefined : savedAddressForShipping(saved);
      if (address === undefined || addressValidations === undefined)
        return { kind: "unavailable" };
      const validation = await addressValidations.validate({
        merchantId: input.merchantId,
        storefrontId: input.storefrontId,
        buyerSessionDigest: input.buyerSessionDigest,
        // The same saved address in one session reuses its validation.
        idempotencyKey: `saved_address:${input.savedAddressReference}:${createHash(
          "sha256",
        )
          .update(JSON.stringify(address))
          .digest("hex")
          .slice(0, 32)}`,
        address,
      });
      return validation.kind === "resolved" &&
        validation.value.state === "accepted"
        ? {
            kind: "resolved",
            value: {
              address: validation.value.address,
              addressValidationReference: validation.value.validationReference,
            },
          }
        : { kind: "unavailable" };
    },
  };
}

export async function identifyBuyerAccount(
  gateway: BuyerAccountGateway,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    storefrontId: string;
    customerAccessToken: string;
  }>,
): Promise<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "identified_customer";
      protectedCustomerReference: string;
      protectedCustomerSessionReference: string;
      contact: BuyerAccountIdentity["contact"];
    }>
> {
  const result = await gateway.identify(input);
  return result.kind === "unavailable"
    ? result
    : {
        kind: "identified_customer",
        protectedCustomerReference: result.value.protectedCustomerReference,
        protectedCustomerSessionReference:
          result.value.protectedCustomerSessionReference,
        contact: result.value.contact,
      };
}
