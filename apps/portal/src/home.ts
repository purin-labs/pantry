import { assertNever, isNonBlankString, isRecord } from "@seams/std";
import type { HomeDestination } from "@seams/control-api";
import { isDestinationKind } from "@seams/control-api/portal/home";

export function isHomeDestination(value: unknown): value is HomeDestination {
  if (!isRecord(value) || !isDestinationKind(value.kind)) {
    return false;
  }
  switch (value.kind) {
    case "product":
    case "customer_order":
      return isNonBlankString(value.resourceId);
    case "home":
    case "commerce":
    case "orders":
    case "operations":
    case "integrations":
    case "settings":
      return true;
    default:
      return assertNever(value.kind, "Unhandled Home value");
  }
}
