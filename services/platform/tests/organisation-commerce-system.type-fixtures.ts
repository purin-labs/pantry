import type { CommerceSystem } from "../src/data/organisation-commerce-system";
import type { ActionAuthority } from "../src/actors/action-ledger";
import {
  parseCommerceSystemRevision,
  parseShopifyShopDomain,
} from "../src/data/organisation-commerce-system";
import {
  parseCommerceBindingId,
  parseCommerceEngineMerchantId,
} from "../src/data/commerce-merchant-binding";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";

const organisationId = requireParsed(
  parseOrganisationId("organisation_commerce_type_fixture"),
);
const revision = requireParsed(parseCommerceSystemRevision(1));
const bindingId = requireParsed(
  parseCommerceBindingId("commerce_binding_type_fixture"),
);
const merchantId = requireParsed(
  parseCommerceEngineMerchantId("merchant_type_fixture"),
);
const integrationAccountId = requireParsed(
  parseIntegrationAccountId("integration_shopify_type_fixture"),
);
const shopDomain = requireParsed(
  parseShopifyShopDomain("fixture.myshopify.com"),
);

// @ts-expect-error Commerce action authority requires the exact system identity.
const incompleteActionAuthority: ActionAuthority = {
  kind: "commerce_system",
  revision,
};

// @ts-expect-error Pantry Commerce requires its accepted merchant binding.
const incompletePantryCommerce: CommerceSystem = {
  kind: "builtin_commerce",
  organisationId,
  merchantId,
  revision,
};

const mixedCommerceAuthority: CommerceSystem = {
  kind: "builtin_commerce",
  organisationId,
  bindingId,
  merchantId,
  revision,
  // @ts-expect-error A commerce system cannot carry authority from both branches.
  integrationAccountId,
};

// @ts-expect-error Shopify requires its exact integration-account authority.
const incompleteShopify: CommerceSystem = {
  kind: "shopify",
  organisationId,
  shopDomain,
  revision,
};

void incompletePantryCommerce;
void mixedCommerceAuthority;
void incompleteShopify;
void incompleteActionAuthority;

function requireParsed<TValue>(
  parsed: { ok: true; value: TValue } | { ok: false },
): TValue {
  if (!parsed.ok) throw new Error("fixture boundary parse failed");
  return parsed.value;
}
