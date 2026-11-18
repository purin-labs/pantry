import type { ActorIdentity } from "./actor-registry";
import { assertNever } from "@seams/std";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "./agent-session-schema";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  CONNECTOR_ACTOR_SCHEMA_VERSION,
  ORGANISATION_ACTOR_SCHEMA_VERSION,
} from "./actor-schema-versions";

export function currentActorSchemaVersion(
  objectKind: ActorIdentity["objectKind"],
): number {
  switch (objectKind) {
    case "organisation":
      return ORGANISATION_ACTOR_SCHEMA_VERSION;
    case "session":
      return CANONICAL_SESSION_SCHEMA_VERSION;
    case "case":
      return CASE_ACTOR_SCHEMA_VERSION;
    case "connector":
      return CONNECTOR_ACTOR_SCHEMA_VERSION;
    default:
      return assertNever(objectKind);
  }
}
