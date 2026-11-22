import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
  type OrganisationExecutionScopeError,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  activateActorRegistryEntries,
  activateActorRegistryEntry,
  actorActivationRequest,
  readExactActiveActorRegistryEntry,
  reserveActor,
  reserveActorPair,
  type ActorRegistryActivation,
  type ActorIdentity,
  type ActorRegistryEntry,
  type ActorRegistryError,
  type ExactActiveActorRegistryError,
} from "./actor-registry";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "./actor-schema-versions";
import { actorStub, type PlacedActorRpc } from "./actor-stubs";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  CONNECTOR_ACTOR_SCHEMA_VERSION,
  ORGANISATION_ACTOR_SCHEMA_VERSION,
} from "./actor-schema-versions";
import type {
  CaseId,
  ConnectorId,
  SessionId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever } from "@purin-labs/std";
import {
  actorExecutionAdmission,
  type ActorPlacementAdmission,
} from "./actor-placement-admission";

/**
 * The namespaces of the four placed Actors, for code that treats each Actor
 * the same way: relocation, copy, restore and registry repair.
 */
export type ActorNamespaces = {
  readonly organisation: DurableObjectNamespace<PlacedActorRpc>;
  readonly session: DurableObjectNamespace<PlacedActorRpc>;
  readonly case: DurableObjectNamespace<PlacedActorRpc>;
  readonly connector: DurableObjectNamespace<PlacedActorRpc>;
};

export type ActorResolutionError =
  | OrganisationExecutionScopeError
  | ActorRegistryError
  | ExactActiveActorRegistryError
  | { readonly code: "actor_activation_conflict" };

export type SessionActorRoute = {
  readonly physicalObjectName: string;
  readonly placement: OrganisationPlacement;
};

type ActiveCaseSessionActors<
  TCase extends PlacedActorRpc,
  TSession extends PlacedActorRpc,
> = {
  readonly caseActor: DurableObjectStub<TCase>;
  readonly caseRoute: SessionActorRoute;
  readonly sessionActor: DurableObjectStub<TSession>;
  readonly sessionRoute: SessionActorRoute;
  readonly registryActivation: ActorRegistryPublication;
  readonly timing: ActorPairResolutionTiming;
};

/**
 * How long the pair's reservation took, and each activation call as its
 * caller saw it. An activation is null for an Actor that was already active.
 * A new Actor's call includes the start of its Durable Object.
 */
export type ActorPairResolutionTiming = {
  readonly reservationMs: number;
  readonly caseActivationMs: number | null;
  readonly sessionActivationMs: number | null;
};

export type ActorRegistryPublication = {
  readonly admission: ActorPlacementAdmission;
  readonly activations: readonly ActorRegistryActivation[];
  readonly activatedAt: number;
};

class ActorResolutionFailure extends Error {
  constructor(readonly resolutionError: ActorResolutionError) {
    super(`actor resolution failed: ${resolutionError.code}`);
    this.name = "ActorResolutionFailure";
  }
}

export async function requireActiveOrganisationActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly ORGANISATION: DurableObjectNamespace<TActor>;
  };
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<DurableObjectStub<TActor>> {
  const result = await resolveActiveOrganisationActor({
    env: input.env,
    namespace: input.env.ORGANISATION,
    organisationId: input.organisationId,
    now: input.now,
  });
  if (!result.ok) {
    throw new ActorResolutionFailure(result.error);
  }
  return result.value;
}

export async function requireActiveOrganisationActorAtPlacement<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly ORGANISATION: DurableObjectNamespace<TActor>;
  };
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<DurableObjectStub<TActor>> {
  const result = await resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.env.ORGANISATION,
    identity: organisationIdentity(input.organisationId),
    placement: input.placement,
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
  if (!result.ok) {
    throw new ActorResolutionFailure(result.error);
  }
  return result.value;
}

/**
 * The Organisation Actor under a scope the caller already holds. The
 * reservation checks the placement in its own batch, so the directory is not
 * read again.
 */
export async function requireActiveOrganisationActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: {
    readonly ORGANISATION: DurableObjectNamespace<TActor>;
  };
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<DurableObjectStub<TActor>> {
  const result = await resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.env.ORGANISATION,
    identity: organisationIdentity(input.scope.organisationId),
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
  if (!result.ok) {
    throw new ActorResolutionFailure(result.error);
  }
  return result.value;
}

export async function requireActiveSessionActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly SESSION: DurableObjectNamespace<TActor>;
  };
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<DurableObjectStub<TActor>> {
  const result = await resolveActiveSessionActor({
    env: input.env,
    namespace: input.env.SESSION,
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    now: input.now,
  });
  if (!result.ok) {
    throw new ActorResolutionFailure(result.error);
  }
  return result.value;
}

export function resolveActiveOrganisationActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: organisationIdentity(input.organisationId),
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveSessionActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: sessionIdentity(input.organisationId, input.sessionId),
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveSessionActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.namespace,
    identity: sessionIdentity(input.scope.organisationId, input.sessionId),
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveConnectorActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly connectorId: ConnectorId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.namespace,
    identity: connectorIdentity(input.scope.organisationId, input.connectorId),
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveCaseActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly caseId: CaseId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.namespace,
    identity: caseIdentity(input.scope.organisationId, input.caseId),
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

/**
 * Address a Case the registry already lists as active at this scope. Nothing
 * is reserved or activated, and the Case admits every call against the
 * directory itself. Null means the caller must resolve the Case through the
 * placement path, which checks the directory before it creates anything.
 */
export async function findActiveCaseActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly caseId: CaseId;
}): Promise<DurableObjectStub<TActor> | null> {
  return (await findActiveCaseRouteAtScope(input))?.actor ?? null;
}

/**
 * {@link findActiveCaseActorAtScope} with the name the registry gives the
 * Case. A Case that started in a warm slot has the slot's name.
 */
export async function findActiveCaseRouteAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly caseId: CaseId;
}): Promise<{
  readonly actor: DurableObjectStub<TActor>;
  readonly route: SessionActorRoute;
} | null> {
  const entry = await readExactActiveActorRegistryEntry({
    db: input.scope.database,
    identity: caseIdentity(input.scope.organisationId, input.caseId),
    placement: input.scope.placement,
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
  });
  if (!entry.ok) return null;
  return {
    actor: actorStub(
      input.namespace,
      entry.value.physicalObjectName,
      entry.value.placement,
    ),
    route: {
      physicalObjectName: entry.value.physicalObjectName,
      placement: entry.value.placement,
    },
  };
}

/**
 * The Organisation counterpart of {@link findActiveCaseActorAtScope}, for a
 * read that must create nothing.
 */
export async function findActiveOrganisationActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
}): Promise<DurableObjectStub<TActor> | null> {
  const entry = await readExactActiveActorRegistryEntry({
    db: input.scope.database,
    identity: organisationIdentity(input.scope.organisationId),
    placement: input.scope.placement,
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
  });
  return entry.ok
    ? actorStub(
        input.namespace,
        entry.value.physicalObjectName,
        entry.value.placement,
      )
    : null;
}

/** The Session counterpart of {@link findActiveCaseActorAtScope}. */
export async function findActiveSessionActorAtScope<
  TActor extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly sessionId: SessionId;
}): Promise<{
  readonly actor: DurableObjectStub<TActor>;
  readonly route: SessionActorRoute;
} | null> {
  const entry = await readExactActiveActorRegistryEntry({
    db: input.scope.database,
    identity: sessionIdentity(input.scope.organisationId, input.sessionId),
    placement: input.scope.placement,
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
  });
  if (!entry.ok) return null;
  return {
    actor: actorStub(
      input.namespace,
      entry.value.physicalObjectName,
      entry.value.placement,
    ),
    route: {
      physicalObjectName: entry.value.physicalObjectName,
      placement: entry.value.placement,
    },
  };
}

export function resolveActiveSessionActorAtPlacement<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.namespace,
    identity: sessionIdentity(input.organisationId, input.sessionId),
    placement: input.placement,
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

/**
 * The Session that the registry lists as active, with nothing reserved or
 * activated. The caller names the methods that it needs through the type of
 * the namespace.
 */
export async function resolveImportedCanonicalSessionActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) return scope;
  const entry = await readExactActiveActorRegistryEntry({
    db: scope.value.database,
    identity: sessionIdentity(input.organisationId, input.sessionId),
    placement: scope.value.placement,
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
  });
  return entry.ok
    ? {
        ok: true,
        value: actorStub(
          input.namespace,
          entry.value.physicalObjectName,
          entry.value.placement,
        ),
      }
    : entry;
}

export function resolveActiveCaseActor<TActor extends PlacedActorRpc>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: caseIdentity(input.organisationId, input.caseId),
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveConnectorActor<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly connectorId: ConnectorId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: connectorIdentity(input.organisationId, input.connectorId),
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export async function resolveActiveConnectorActorAtPlacement<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly connectorId: ConnectorId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  const identity = connectorIdentity(input.organisationId, input.connectorId);
  return resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.namespace,
    identity,
    placement: input.placement,
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveCaseActorAtPlacement<
  TActor extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TActor>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TActor>, ActorResolutionError>> {
  return resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.namespace,
    identity: caseIdentity(input.organisationId, input.caseId),
    placement: input.placement,
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export async function resolveActiveCaseSessionActorsAtPlacement<
  TCase extends PlacedActorRpc,
  TSession extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly caseNamespace: DurableObjectNamespace<TCase>;
  readonly sessionNamespace: DurableObjectNamespace<TSession>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly sessionId: SessionId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<
  Result<ActiveCaseSessionActors<TCase, TSession>, ActorResolutionError>
> {
  const scope = await OrganisationExecutionScope.resolveAtPlacement(
    input.env,
    input.organisationId,
    input.placement,
  );
  if (!scope.ok) return scope;
  return resolveActiveCaseSessionActorsAtScope({
    scope: scope.value,
    caseNamespace: input.caseNamespace,
    sessionNamespace: input.sessionNamespace,
    caseId: input.caseId,
    sessionId: input.sessionId,
    now: input.now,
  });
}

export async function resolveActiveCaseSessionActorsAtScope<
  TCase extends PlacedActorRpc,
  TSession extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly caseNamespace: DurableObjectNamespace<TCase>;
  readonly sessionNamespace: DurableObjectNamespace<TSession>;
  readonly caseId: CaseId;
  readonly sessionId: SessionId;
  readonly now: number;
  /**
   * Warm slots that a new Case and a new Session may take. An Actor whose row
   * exists keeps its own name.
   */
  readonly warmSlots?: { readonly case: string; readonly session: string };
}): Promise<
  Result<ActiveCaseSessionActors<TCase, TSession>, ActorResolutionError>
> {
  const admission = actorExecutionAdmission(input.scope);
  const reservationStartedAt = Date.now();
  const reserved = await reserveActorPair({
    db: input.scope.database,
    reservations: [
      {
        identity: caseIdentity(input.scope.organisationId, input.caseId),
        admission: admission,
        schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
        now: input.now,
        warmSlotName: input.warmSlots?.case,
      },
      {
        identity: sessionIdentity(input.scope.organisationId, input.sessionId),
        admission: admission,
        schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
        now: input.now,
        warmSlotName: input.warmSlots?.session,
      },
    ],
  });
  if (!reserved.ok) {
    return reserved;
  }
  const reservationMs = Date.now() - reservationStartedAt;
  const [caseEntry, sessionEntry] = reserved.value;
  if (
    caseEntry.identity.objectKind !== "case" ||
    sessionEntry.identity.objectKind !== "session"
  ) {
    return { ok: false, error: { code: "registry_entry_corrupt" } };
  }
  const caseActor = actorStub(
    input.caseNamespace,
    caseEntry.physicalObjectName,
    caseEntry.placement,
  );
  const sessionActor = actorStub(
    input.sessionNamespace,
    sessionEntry.physicalObjectName,
    sessionEntry.placement,
  );
  // Both activations start now, so two new Actors start at the same time.
  const activated = await Promise.all([
    timedActivation(caseActor, caseEntry, input.now, admission),
    timedActivation(sessionActor, sessionEntry, input.now, admission),
  ]);
  const activations: ActorRegistryActivation[] = [];
  for (const { result } of activated) {
    if (!result.ok) {
      return result;
    }
    if (result.value !== null) {
      activations.push(result.value);
    }
  }
  return {
    ok: true,
    value: {
      caseActor,
      caseRoute: {
        physicalObjectName: caseEntry.physicalObjectName,
        placement: caseEntry.placement,
      },
      sessionActor,
      sessionRoute: {
        physicalObjectName: sessionEntry.physicalObjectName,
        placement: sessionEntry.placement,
      },
      registryActivation: {
        admission: admission,
        activations,
        activatedAt: input.now,
      },
      timing: {
        reservationMs,
        caseActivationMs: activated[0].elapsedMs,
        sessionActivationMs: activated[1].elapsedMs,
      },
    },
  };
}

async function timedActivation<TObject extends PlacedActorRpc>(
  object: DurableObjectStub<TObject>,
  entry: ActorRegistryEntry,
  now: number,
  admission: ActorPlacementAdmission,
): Promise<{
  readonly result: Awaited<ReturnType<typeof activateReservedActor>>;
  readonly elapsedMs: number | null;
}> {
  const startedAt = Date.now();
  const result = await activateReservedActor(object, entry, now, admission);
  return {
    result,
    elapsedMs:
      entry.lifecycleStatus === "reserved" ? Date.now() - startedAt : null,
  };
}

export async function publishActorRegistryActivation(input: {
  readonly env: OrganisationPlacementBindings;
  readonly publication: ActorRegistryPublication;
}): Promise<Result<null, ActorResolutionError>> {
  const scope = await OrganisationExecutionScope.resolveAtPlacement(
    input.env,
    input.publication.admission.organisationId,
    input.publication.admission.placement,
  );
  if (!scope.ok) return scope;
  return publishActorActivations(
    scope.value.database,
    input.publication.admission,
    input.publication.activations,
    input.publication.activatedAt,
  );
}

export function actorStubForRegistryEntry(input: {
  readonly namespaces: ActorNamespaces;
  readonly entry: ActorRegistryEntry;
}): DurableObjectStub<PlacedActorRpc> {
  switch (input.entry.identity.objectKind) {
    case "organisation":
      return actorStub(
        input.namespaces.organisation,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "session":
      return actorStub(
        input.namespaces.session,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "case":
      return actorStub(
        input.namespaces.case,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "connector":
      return actorStub(
        input.namespaces.connector,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    default:
      return assertNever(input.entry.identity);
  }
}

async function resolveActiveActor<TObject extends PlacedActorRpc>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TObject>;
  readonly identity: ActorIdentity;
  readonly schemaVersion: number;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TObject>, ActorResolutionError>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.identity.organisationId,
  );
  if (!scope.ok) return scope;
  return resolveActiveActorAtScope({
    scope: scope.value,
    namespace: input.namespace,
    identity: input.identity,
    schemaVersion: input.schemaVersion,
    now: input.now,
  });
}

async function resolveActiveActorAtPlacement<
  TObject extends PlacedActorRpc,
>(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<TObject>;
  readonly identity: ActorIdentity;
  readonly placement: OrganisationPlacement;
  readonly schemaVersion: number;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TObject>, ActorResolutionError>> {
  const scope = await OrganisationExecutionScope.resolveAtPlacement(
    input.env,
    input.identity.organisationId,
    input.placement,
  );
  if (!scope.ok) return scope;
  return resolveActiveActorAtScope({
    scope: scope.value,
    namespace: input.namespace,
    identity: input.identity,
    schemaVersion: input.schemaVersion,
    now: input.now,
  });
}

async function resolveActiveActorAtScope<
  TObject extends PlacedActorRpc,
>(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<TObject>;
  readonly identity: ActorIdentity;
  readonly schemaVersion: number;
  readonly now: number;
}): Promise<Result<DurableObjectStub<TObject>, ActorResolutionError>> {
  const admission = actorExecutionAdmission(input.scope);
  const entry = await reserveActor({
    db: input.scope.database,
    identity: input.identity,
    admission: admission,
    schemaVersion: input.schemaVersion,
    now: input.now,
  });
  if (!entry.ok) {
    return entry;
  }
  const object = actorStub(
    input.namespace,
    entry.value.physicalObjectName,
    input.scope.placement,
  );
  if (entry.value.lifecycleStatus === "active") {
    return { ok: true, value: object };
  }
  if (entry.value.lifecycleStatus !== "reserved") {
    return { ok: false, error: { code: "registry_entry_not_activatable" } };
  }
  const activationStartedAt = Date.now();
  const activated = await object.activate(
    actorActivationRequest(entry.value, input.now, admission),
  );
  traceActorResolution(input.identity, "activation", activationStartedAt);
  if (!activated.ok) {
    return {
      ok: false,
      error: {
        code:
          activated.error.code === "activation_placement_conflict"
            ? "registry_placement_conflict"
            : "actor_activation_conflict",
      },
    };
  }
  const publicationStartedAt = Date.now();
  const published = await activateActorRegistryEntry({
    db: input.scope.database,
    admission: admission,
    registryId: entry.value.registryId,
    activationToken: entry.value.activationToken,
    stateVersion: activated.value.stateVersion,
    now: input.now,
  });
  traceActorResolution(input.identity, "publication", publicationStartedAt);
  return published.ok ? { ok: true, value: object } : published;
}

function traceActorResolution(
  identity: ActorIdentity,
  phase: "activation" | "publication",
  startedAt: number,
): void {
  if (identity.objectKind !== "case") return;
  console.log(
    JSON.stringify({
      event: "case.actor_resolution_timing",
      organisation_id: identity.organisationId,
      case_id: identity.logicalObjectId,
      phase,
      started_at: startedAt,
      duration_ms: Date.now() - startedAt,
    }),
  );
}

async function activateReservedActor<TObject extends PlacedActorRpc>(
  object: DurableObjectStub<TObject>,
  entry: ActorRegistryEntry,
  now: number,
  admission: ActorPlacementAdmission,
): Promise<Result<ActorRegistryActivation | null, ActorResolutionError>> {
  switch (entry.lifecycleStatus) {
    case "active":
      return { ok: true, value: null };
    case "reserved": {
      const activated = await object.activate(
        actorActivationRequest(entry, now, admission),
      );
      return activated.ok
        ? {
            ok: true,
            value: { entry, stateVersion: activated.value.stateVersion },
          }
        : {
            ok: false,
            error: {
              code:
                activated.error.code === "activation_placement_conflict"
                  ? "registry_placement_conflict"
                  : "actor_activation_conflict",
            },
          };
    }
    case "exporting":
    case "retired":
    case "quarantined":
      return { ok: false, error: { code: "registry_entry_not_activatable" } };
    default:
      return assertNever(entry);
  }
}

async function publishActorActivations(
  db: OrganisationDatabase,
  admission: ActorPlacementAdmission,
  activations: readonly ActorRegistryActivation[],
  now: number,
): Promise<Result<null, ActorResolutionError>> {
  const published = await activateActorRegistryEntries({
    db,
    admission,
    activations,
    now,
  });
  return published.ok ? { ok: true, value: null } : published;
}

function organisationIdentity(organisationId: OrganisationId): ActorIdentity {
  return {
    objectKind: "organisation",
    organisationId,
    logicalObjectId: organisationId,
  };
}

function sessionIdentity(
  organisationId: OrganisationId,
  sessionId: SessionId,
): ActorIdentity {
  return { objectKind: "session", organisationId, logicalObjectId: sessionId };
}

function caseIdentity(
  organisationId: OrganisationId,
  caseId: CaseId,
): ActorIdentity {
  return { objectKind: "case", organisationId, logicalObjectId: caseId };
}

function connectorIdentity(
  organisationId: OrganisationId,
  connectorId: ConnectorId,
): ActorIdentity {
  return {
    objectKind: "connector",
    organisationId,
    logicalObjectId: connectorId,
  };
}
