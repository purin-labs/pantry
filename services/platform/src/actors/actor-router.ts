import type { OrganisationDatabase } from "../database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
  type OrganisationExecutionScopeError,
} from "../organisation-execution-scope";
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
import { CANONICAL_SESSION_SCHEMA_VERSION } from "./agent-session-schema";
import {
  actorStub,
  caseActorStub,
  connectorActorStub,
  organisationActorStub,
  sessionActorStub,
  type ActorClass,
} from "./actor-stubs";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  CONNECTOR_ACTOR_SCHEMA_VERSION,
  ORGANISATION_ACTOR_SCHEMA_VERSION,
} from "./actor-schema-versions";
import type { SessionDO } from "./agent-session";
import type { CaseDO } from "./case";
import type { ConnectorDO } from "./connector";
import type { OrganisationDO } from "./organisation";
import type { CaseId, ConnectorId, SessionId, OrganisationId } from "../ids";
import type { OrganisationPlacement } from "../placement";
import type { Result } from "../result";
import { assertNever } from "@purin-labs/std";
import {
  actorExecutionAdmission,
  type ActorPlacementAdmission,
} from "./actor-placement-admission";

export {
  caseActorStub,
  connectorActorStub,
  organisationActorStub,
  sessionActorStub,
};

type ActorStub =
  | DurableObjectStub<OrganisationDO>
  | DurableObjectStub<SessionDO>
  | DurableObjectStub<CaseDO>
  | DurableObjectStub<ConnectorDO>;

export type ImportedCanonicalSessionActorStub = Pick<
  DurableObjectStub<SessionDO>,
  | "inspectImportedCanonicalSession"
  | "initializeCanonicalSession"
  | "acceptCanonicalInput"
  | "activateCanonicalRuntime"
  | "acceptCanonicalHarnessEvent"
  | "commitCanonicalHarnessCheckpoint"
  | "cancelCanonicalEmbeddedHarnessTurn"
  | "interruptCanonicalEmbeddedHarnessTurn"
  | "startCanonicalEmbeddedHarnessTextTurn"
  | "prepareSessionInformationFlow"
  | "readSessionTurnFlowBinding"
  | "inspectCutoverQuiescence"
  | "inspectCanonicalSessionState"
>;

export type ActorNamespaces = {
  readonly organisation: DurableObjectNamespace<OrganisationDO>;
  readonly session: DurableObjectNamespace<SessionDO>;
  readonly case: DurableObjectNamespace<CaseDO>;
  readonly connector: DurableObjectNamespace<ConnectorDO>;
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

type ActiveCaseSessionActors = {
  readonly caseActor: DurableObjectStub<CaseDO>;
  readonly caseRoute: SessionActorRoute;
  readonly sessionActor: DurableObjectStub<SessionDO>;
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

export async function requireActiveOrganisationActor(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly ORGANISATION: DurableObjectNamespace<OrganisationDO>;
  };
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<DurableObjectStub<OrganisationDO>> {
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

export async function requireActiveOrganisationActorAtPlacement(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly ORGANISATION: DurableObjectNamespace<OrganisationDO>;
  };
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<DurableObjectStub<OrganisationDO>> {
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
export async function requireActiveOrganisationActorAtScope(input: {
  readonly env: {
    readonly ORGANISATION: DurableObjectNamespace<OrganisationDO>;
  };
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<DurableObjectStub<OrganisationDO>> {
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

export async function requireActiveSessionActor(input: {
  readonly env: OrganisationPlacementBindings & {
    readonly SESSION: DurableObjectNamespace<SessionDO>;
  };
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<DurableObjectStub<SessionDO>> {
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

export function resolveActiveOrganisationActor(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<OrganisationDO>;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<OrganisationDO>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: organisationIdentity(input.organisationId),
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveSessionActor(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<SessionDO>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: sessionIdentity(input.organisationId, input.sessionId),
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveSessionActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly sessionId: SessionId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<SessionDO>, ActorResolutionError>> {
  return resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.namespace,
    identity: sessionIdentity(input.scope.organisationId, input.sessionId),
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveConnectorActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<ConnectorDO>;
  readonly connectorId: ConnectorId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<ConnectorDO>, ActorResolutionError>> {
  return resolveActiveActorAtScope({
    scope: input.scope,
    namespace: input.namespace,
    identity: connectorIdentity(input.scope.organisationId, input.connectorId),
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveCaseActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<CaseDO>;
  readonly caseId: CaseId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<CaseDO>, ActorResolutionError>> {
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
export async function findActiveCaseActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<CaseDO>;
  readonly caseId: CaseId;
}): Promise<DurableObjectStub<CaseDO> | null> {
  return (await findActiveCaseRouteAtScope(input))?.actor ?? null;
}

/**
 * {@link findActiveCaseActorAtScope} with the name the registry gives the
 * Case. A Case that started in a warm slot has the slot's name.
 */
export async function findActiveCaseRouteAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<CaseDO>;
  readonly caseId: CaseId;
}): Promise<{
  readonly actor: DurableObjectStub<CaseDO>;
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
    actor: caseActorStub(
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
export async function findActiveOrganisationActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<OrganisationDO>;
}): Promise<DurableObjectStub<OrganisationDO> | null> {
  const entry = await readExactActiveActorRegistryEntry({
    db: input.scope.database,
    identity: organisationIdentity(input.scope.organisationId),
    placement: input.scope.placement,
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
  });
  return entry.ok
    ? organisationActorStub(
        input.namespace,
        entry.value.physicalObjectName,
        entry.value.placement,
      )
    : null;
}

/** The Session counterpart of {@link findActiveCaseActorAtScope}. */
export async function findActiveSessionActorAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly sessionId: SessionId;
}): Promise<{
  readonly actor: DurableObjectStub<SessionDO>;
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
    actor: sessionActorStub(
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

export function resolveActiveSessionActorAtPlacement(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<SessionDO>, ActorResolutionError>> {
  return resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.namespace,
    identity: sessionIdentity(input.organisationId, input.sessionId),
    placement: input.placement,
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: input.now,
  });
}

export async function resolveImportedCanonicalSessionActor(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
}): Promise<Result<ImportedCanonicalSessionActorStub, ActorResolutionError>> {
  const scope = await OrganisationExecutionScope.resolve(input.env, input.organisationId);
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
        value: sessionActorStub(
          input.namespace,
          entry.value.physicalObjectName,
          entry.value.placement,
        ),
      }
    : entry;
}

export function importedCanonicalSessionActorStub(input: {
  readonly namespace: DurableObjectNamespace<SessionDO>;
  readonly physicalObjectName: string;
  readonly placement: OrganisationPlacement;
}): ImportedCanonicalSessionActorStub {
  return sessionActorStub(
    input.namespace,
    input.physicalObjectName,
    input.placement,
  );
}

export function resolveActiveCaseActor(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<CaseDO>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<CaseDO>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: caseIdentity(input.organisationId, input.caseId),
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export function resolveActiveConnectorActor(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<ConnectorDO>;
  readonly organisationId: OrganisationId;
  readonly connectorId: ConnectorId;
  readonly now: number;
}): Promise<Result<DurableObjectStub<ConnectorDO>, ActorResolutionError>> {
  return resolveActiveActor({
    env: input.env,
    namespace: input.namespace,
    identity: connectorIdentity(input.organisationId, input.connectorId),
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export async function resolveActiveConnectorActorAtPlacement(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<ConnectorDO>;
  readonly organisationId: OrganisationId;
  readonly connectorId: ConnectorId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<ConnectorDO>, ActorResolutionError>> {
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

export function resolveActiveCaseActorAtPlacement(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespace: DurableObjectNamespace<CaseDO>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<DurableObjectStub<CaseDO>, ActorResolutionError>> {
  return resolveActiveActorAtPlacement({
    env: input.env,
    namespace: input.namespace,
    identity: caseIdentity(input.organisationId, input.caseId),
    placement: input.placement,
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    now: input.now,
  });
}

export async function resolveActiveCaseSessionActorsAtPlacement(input: {
  readonly env: OrganisationPlacementBindings;
  readonly caseNamespace: DurableObjectNamespace<CaseDO>;
  readonly sessionNamespace: DurableObjectNamespace<SessionDO>;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly sessionId: SessionId;
  readonly placement: OrganisationPlacement;
  readonly now: number;
}): Promise<Result<ActiveCaseSessionActors, ActorResolutionError>> {
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

export async function resolveActiveCaseSessionActorsAtScope(input: {
  readonly scope: OrganisationExecutionScope;
  readonly caseNamespace: DurableObjectNamespace<CaseDO>;
  readonly sessionNamespace: DurableObjectNamespace<SessionDO>;
  readonly caseId: CaseId;
  readonly sessionId: SessionId;
  readonly now: number;
  /**
   * Warm slots that a new Case and a new Session may take. An Actor whose row
   * exists keeps its own name.
   */
  readonly warmSlots?: { readonly case: string; readonly session: string };
}): Promise<Result<ActiveCaseSessionActors, ActorResolutionError>> {
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
  const caseActor = caseActorStub(
    input.caseNamespace,
    caseEntry.physicalObjectName,
    caseEntry.placement,
  );
  const sessionActor = sessionActorStub(
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

async function timedActivation<TObject extends ActorClass>(
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
}): ActorStub {
  switch (input.entry.identity.objectKind) {
    case "organisation":
      return organisationActorStub(
        input.namespaces.organisation,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "session":
      return sessionActorStub(
        input.namespaces.session,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "case":
      return caseActorStub(
        input.namespaces.case,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    case "connector":
      return connectorActorStub(
        input.namespaces.connector,
        input.entry.physicalObjectName,
        input.entry.placement,
      );
    default:
      return assertNever(input.entry.identity);
  }
}

async function resolveActiveActor<TObject extends ActorClass>(input: {
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
  TObject extends ActorClass,
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

async function resolveActiveActorAtScope<TObject extends ActorClass>(input: {
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

async function activateReservedActor<TObject extends ActorClass>(
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
  return { objectKind: "organisation", organisationId, logicalObjectId: organisationId };
}

function sessionIdentity(
  organisationId: OrganisationId,
  sessionId: SessionId,
): ActorIdentity {
  return { objectKind: "session", organisationId, logicalObjectId: sessionId };
}

function caseIdentity(organisationId: OrganisationId, caseId: CaseId): ActorIdentity {
  return { objectKind: "case", organisationId, logicalObjectId: caseId };
}

function connectorIdentity(
  organisationId: OrganisationId,
  connectorId: ConnectorId,
): ActorIdentity {
  return { objectKind: "connector", organisationId, logicalObjectId: connectorId };
}
