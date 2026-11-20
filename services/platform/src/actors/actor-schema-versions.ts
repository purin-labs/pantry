/**
 * The schema versions of the four Actors. This module holds constants only,
 * so a Worker that reads one version loads nothing else, and the Actor router
 * needs no import of the Session schema.
 */
export const ORGANISATION_ACTOR_SCHEMA_VERSION = 10;
export const CASE_ACTOR_SCHEMA_VERSION = 2;
export const CONNECTOR_ACTOR_SCHEMA_VERSION = 2;
/** The Session schema is in agent-session-schema.ts: change both together. */
export const CANONICAL_SESSION_SCHEMA_VERSION = 33;
