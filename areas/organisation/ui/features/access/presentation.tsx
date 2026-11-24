import { providerLabel } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import type {
  AccessControlCapabilityView,
  AccessControlGrantView,
} from "@purin-labs/control-api/portal/access-models";

export function riskLabel(
  risk: AccessControlGrantView["capability"]["risk"],
): string {
  switch (risk) {
    case "read":
      return "Reads data";
    case "propose":
      return "Prepares changes";
    case "external_effect":
      return "Acts outside Purin Pantry";
  }
}

export function availabilityLabel(
  value: AccessControlCapabilityView["availability"],
): string {
  return value === "available"
    ? "Available"
    : value === "needs_attention"
      ? "Needs attention"
      : "Unavailable";
}

export function modeLabel(value: AccessControlCapabilityView["mode"]): string {
  return value === "enabled"
    ? "Allowed"
    : value === "approval_required"
      ? "Ask first"
      : "Off";
}

export function categoryLabel(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.length === 0
    ? spaced
    : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function providerDependencyLabel(
  dependency: AccessControlCapabilityView["definition"]["providerDependency"],
): string {
  switch (dependency.kind) {
    case "none":
      return "Purin Pantry";
    case "provider":
      return dependency.providers.map(providerLabel).join(" or ");
    case "commerce_system":
      return dependency.systems.map(commerceSystemLabel).join(" or ");
  }
}

function commerceSystemLabel(system: string): string {
  switch (system) {
    case "builtin_commerce":
      return "Purin Checkout";
    case "shopify":
      return "Shopify";
    default:
      return "Connected commerce system";
  }
}

/** Deep link into the Integrations page, opening the exact provider tile when there is one. */
export function connectIntegrationHref(
  integrationsPath: string,
  dependency: AccessControlCapabilityView["definition"]["providerDependency"],
): string {
  if (dependency.kind === "provider" && dependency.providers.length === 1) {
    return `${integrationsPath}?integration=${dependency.providers[0]}`;
  }
  if (dependency.kind === "commerce_system")
    return `${integrationsPath}?integration=commerce`;
  return integrationsPath;
}
