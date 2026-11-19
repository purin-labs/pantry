import {
  StrictObject,
  NonNegativeInteger as generation,
} from "@purin-labs/commerce-contracts/schema";
import { Type, type Static } from "typebox";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

export const modelRouteSchema = Type.Union([
  StrictObject({
    keySource: Type.Literal("platform"),
    provider: Type.Literal("openai-compatible"),
    model: Type.String(),
  }),
  StrictObject({
    keySource: Type.Literal("organisation_byo"),
    provider: Type.Enum(["openai", "anthropic"]),
    model: Type.String(),
    byoKeyRef: Type.String(),
  }),
  StrictObject({
    keySource: Type.Literal("organisation_oauth"),
    provider: Type.Literal("anthropic"),
    model: Type.String(),
    connectionId: Type.String(),
  }),
  StrictObject({
    keySource: Type.Literal("organisation_subscription"),
    provider: Type.Literal("openai"),
    model: Type.String(),
    connectionRevision: generation,
    authProfileGeneration: generation,
  }),
]);

export type ModelRoute = StrictUnion<Static<typeof modelRouteSchema>>;

/** serde writes the tag first, followed by fields in Rust declaration order. */
export function encodeModelRoute(route: ModelRoute): string {
  switch (route.keySource) {
    case "platform":
      return JSON.stringify({
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
      });
    case "organisation_byo":
      return JSON.stringify({
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        byoKeyRef: route.byoKeyRef,
      });
    case "organisation_oauth":
      return JSON.stringify({
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        connectionId: route.connectionId,
      });
    case "organisation_subscription":
      return JSON.stringify({
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        connectionRevision: route.connectionRevision,
        authProfileGeneration: route.authProfileGeneration,
      });
    default:
      return assertNever(route);
  }
}
