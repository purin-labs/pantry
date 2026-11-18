/**
 * The schema versions of the Actors that hold no harness. This module holds
 * constants only, so a Worker that reads one version loads nothing else.
 * The Session's version lives with its schema.
 */
export const ORGANISATION_ACTOR_SCHEMA_VERSION = 10;
export const CASE_ACTOR_SCHEMA_VERSION = 2;
export const CONNECTOR_ACTOR_SCHEMA_VERSION = 2;
