import {
  isUnregisteredActorKind,
  type UnregisteredActorKind,
} from "../../actors/unregistered-actor-erasure";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../../organisation-execution-scope";
import {
  readStringField,
  readOrganisationIdField,
} from "../../boundary";
import type { OrganisationMetaInput } from "../../actors/organisation/types";
import {
  advanceActiveActorRegistrySchema,
  discardQuarantinedActorRegistryEntry,
  listOrganisationActorRegistryEntries,
  parseActorRegistryId,
  type ActiveActorRegistryEntry,
  type ActorActivationIdentity,
  type ActorIdentity,
  type ActorRegistryEntry,
  type ActorRegistryId,
  type ActorRegistrySchemaAdvanceError,
} from "../../actors/actor-registry";
import type {
  ActorActivationInspection,
  ActorActivationSchemaAdvanceError,
} from "../../actors/actor-activation";
import { currentActorSchemaVersion } from "../../actors/current-actor-schema-version";
import { codeModePlatformGovernor } from "../../actors/code-mode-platform-governor-stub";
import type {
  Env,
  OrganisationActorStub,
  SessionActorStub,
} from "../../env";
import {
  inspectOrganisationActorRegistry,
  reconcileOrganisationActorRegistry,
  type ActorRegistryInventoryEntry,
  type ActorRegistryReconciliationError,
} from "../../actors/actor-registry-reconciliation";
import type { CaseSnapshot } from "../../actors/case/types";
import {
  requireActiveOrganisationActorAtPlacement,
  resolveActiveConnectorActor,
  resolveImportedCanonicalSessionActor,
  type ActorNamespaces,
  type ActorResolutionError,
} from "../../actors/actor-router";
import { actorStub } from "../../actors/actor-stubs";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonObject,
} from "../../http";
import {
  newRequestId,
  parseCaseId,
  parseConnectorId,
  parseSessionId,
  parseOrganisationId,
  type CaseId,
  type ConnectorId,
  type SessionId,
  type OrganisationId,
} from "../../ids";
import { releaseSlackInstallationCredentials } from "../../credential-vault/slack-installation-credential";
import { erasePurgedOrganisationRows } from "../../data/organisation-purge";
import { compilePublishAndActivateOrganisationPolicy } from "../../policy-snapshot";
import type { Result } from "../../result";
import {
  inspectRetainedVaultRootClosure,
  type RetainedVaultRootClosureError,
} from "../../credential-vault/root-closure";
import { messageLinkFetchObjectName } from "../../messages/link-egress";
import { customConnectorFetchObjectName } from "../../custom-connectors/egress";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { conversationResidencyStub } from "../../actors/conversation-residency";
import { type QuarantinedCaseActorRegistryEntry, actorResolutionErrorResponse } from "../support";
import { isAuthorizedOrganisationAdminRequest, jsonBodyErrorResponse, readPositiveSafeIntegerField } from "../request-helpers";

type ActorRegistryAdminRequest =
  | {
      readonly command: "bootstrap_organisation";
      readonly organisationId: OrganisationId;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "reconcile_reserved";
      readonly organisationId: OrganisationId;
      readonly staleReservationAgeMs: number;
    }
  | {
      readonly command: "advance_actor_schema";
      readonly organisationId: OrganisationId;
      readonly identity:
        | VariantBy<ActorIdentity, "objectKind", "organisation">
        | VariantBy<ActorIdentity, "objectKind", "connector">;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "interrupt_session";
      readonly organisationId: OrganisationId;
      readonly sessionId: SessionId;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "recover_connector_case_work";
      readonly organisationId: OrganisationId;
      readonly connectorId: ConnectorId;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "discard_quarantined_case";
      readonly organisationId: OrganisationId;
      readonly caseId: CaseId;
      readonly registryId: ActorRegistryId;
      readonly expectedQuarantinedAt: number;
      readonly expectedQuarantineReason: string;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "erase_purged_organisation_rows";
      readonly organisationId: OrganisationId;
      readonly staleReservationAgeMs?: never;
    }
  | {
      readonly command: "erase_unregistered_actor";
      readonly objectKind: UnregisteredActorKind;
      readonly objectId: string;
      readonly organisationId?: never;
      readonly staleReservationAgeMs?: never;
    };

type ActorRegistryAdminRequestError = {
  readonly code: "invalid_actor_registry_request";
  readonly field: string;
};

/**
 * What this admin code may call on a Session that an import brought in. The
 * list is narrow on purpose: a method that is not here needs a decision.
 */
type ImportedCanonicalSessionActorStub = Pick<
  SessionActorStub,
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

type ActorSchemaAdvanceStub = Pick<
  OrganisationActorStub,
  "advanceActivationSchema"
>;

export async function handleAdministerActorRegistry(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  if (request.method === "GET") {
    return inspectOrganisationActorRegistryResponse(request, env);
  }

  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const input = parseActorRegistryAdminRequest(body.value);
  if (!input.ok) {
    return errorResponse(
      input.error.code,
      `Actor registry field ${input.error.field} is invalid.`,
      422,
    );
  }

  switch (input.value.command) {
    case "bootstrap_organisation":
      return bootstrapOrganisationActorRegistryResponse(
        env,
        input.value.organisationId,
      );
    case "reconcile_reserved":
      return reconcileReservedActorRegistryResponse(env, input.value);
    case "advance_actor_schema":
      return advanceActorSchemaResponse(env, input.value);
    case "interrupt_session":
      return interruptActiveSessionResponse(env, input.value);
    case "recover_connector_case_work":
      return recoverConnectorCaseWorkResponse(env, input.value);
    case "discard_quarantined_case":
      return discardQuarantinedCaseResponse(env, input.value);
    case "erase_purged_organisation_rows":
      return erasePurgedOrganisationRowsResponse(
        env,
        input.value.organisationId,
      );
    case "erase_unregistered_actor":
      return eraseUnregisteredActorResponse(env, input.value);
    default:
      return assertNever(input.value);
  }
}

/**
 * Empties an Actor that no registry names, by its object identifier. An Actor
 * a registry does name is refused here; one whose Organisation still exists
 * refuses itself.
 */
async function eraseUnregisteredActorResponse(
  env: Env,
  input: VariantBy<
    ActorRegistryAdminRequest,
    "command",
    "erase_unregistered_actor"
  >,
): Promise<Response> {
  const registered = new Set<string>();
  for (const database of configuredOrganisationDatabases(env)) {
    const owners = await database
      .prepare(
        "SELECT DISTINCT organisation_id AS organisationId FROM durable_object_registry",
      )
      .all<{ readonly organisationId: string }>();
    for (const owner of owners.results ?? []) {
      const organisationId = parseOrganisationId(owner.organisationId);
      if (!organisationId.ok) continue;
      const entries = await listOrganisationActorRegistryEntries({
        db: database,
        organisationId: organisationId.value,
      });
      if (!entries.ok) {
        return actorRegistryReconciliationErrorResponse(entries.error);
      }
      // What serves a registered Actor's Organisation is in use as well: its
      // custom connector container, the link-fetch Actor of its region and
      // the residency Actor of its Connector.
      registered.add(
        env.CUSTOM_CONNECTOR_FETCH.idFromName(
          customConnectorFetchObjectName(organisationId.value),
        ).toString(),
      );
      for (const entry of entries.value) {
        const objectId = registeredActorObjectId(env, entry);
        if (objectId !== null) registered.add(objectId);
        registered.add(
          env.MESSAGE_LINK_FETCH.idFromName(
            messageLinkFetchObjectName(entry.placement),
          ).toString(),
        );
        if (
          entry.identity.objectKind === "connector" &&
          env.CONVERSATION_RESIDENCY !== undefined
        )
          registered.add(
            conversationResidencyStub(
              env.CONVERSATION_RESIDENCY,
              entry.physicalObjectName,
              entry.placement,
            ).id.toString(),
          );
      }
    }
  }
  // The governor of this build keeps the Code Mode budget of the platform.
  registered.add(codeModePlatformGovernor(env).id.toString());
  if (registered.has(input.objectId)) {
    return errorResponse(
      "actor_registered",
      "A registered Actor is not erased by its object identifier.",
      409,
    );
  }
  const actor = unregisteredActorStub(env, input.objectKind, input.objectId);
  if (actor === null) {
    return errorResponse(
      "actor_not_found",
      "No Actor class of this kind has this object identifier.",
      404,
    );
  }
  const erased = await actor.eraseUnregisteredState();
  if (!erased.ok) {
    return errorResponse(erased.error.code, "The Actor was not erased.", 409);
  }
  return jsonResponse({
    ok: true,
    report: {
      kind: "unregistered_actor_erased",
      objectKind: input.objectKind,
      objectId: input.objectId,
      erasedAt: Date.now(),
    },
  });
}

function registeredActorObjectId(
  env: Env,
  entry: ActorRegistryEntry,
): string | null {
  const name = entry.physicalObjectName;
  switch (entry.identity.objectKind) {
    case "session":
      return actorStub(env.SESSION, name, entry.placement).id.toString();
    case "case":
      return actorStub(env.CASE, name, entry.placement).id.toString();
    case "connector":
      return actorStub(
        env.CONNECTOR,
        name,
        entry.placement,
      ).id.toString();
    case "organisation":
      return actorStub(
        env.ORGANISATION,
        name,
        entry.placement,
      ).id.toString();
    default:
      return null;
  }
}

function unregisteredActorStub(
  env: Env,
  objectKind: UnregisteredActorKind,
  objectId: string,
) {
  switch (objectKind) {
    case "session":
      return env.SESSION.get(env.SESSION.idFromString(objectId));
    case "case":
      return env.CASE.get(env.CASE.idFromString(objectId));
    case "connector":
      return env.CONNECTOR.get(env.CONNECTOR.idFromString(objectId));
    case "organisation":
      return env.ORGANISATION.get(env.ORGANISATION.idFromString(objectId));
    case "conversation_residency":
      return env.CONVERSATION_RESIDENCY === undefined
        ? null
        : env.CONVERSATION_RESIDENCY.get(
            env.CONVERSATION_RESIDENCY.idFromString(objectId),
          );
    case "device_fleet":
      return env.DEVICE_FLEET === undefined
        ? null
        : env.DEVICE_FLEET.get(env.DEVICE_FLEET.idFromString(objectId));
    case "message_link_fetch":
      try {
        return env.MESSAGE_LINK_FETCH.get(
          env.MESSAGE_LINK_FETCH.idFromString(objectId),
        );
      } catch {
        // The identifier is of another class.
        return null;
      }
    case "code_mode_governor":
      try {
        return env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR.get(
          env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR.idFromString(objectId),
        );
      } catch {
        // The identifier is of another class.
        return null;
      }
    case "custom_connector_fetch":
      try {
        return env.CUSTOM_CONNECTOR_FETCH.get(
          env.CUSTOM_CONNECTOR_FETCH.idFromString(objectId),
        );
      } catch {
        // The identifier is of another class.
        return null;
      }
    default:
      return assertNever(objectKind);
  }
}

/**
 * Erases the rows that a purge before the catalogue left of a purged
 * Organisation, after its Slack installations' bot tokens move to an
 * Organisation that still uses them.
 */
async function erasePurgedOrganisationRowsResponse(
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const erased = await erasePurgedOrganisationRows({
    db: execution.value.database,
    directory: env.DB,
    organisationId,
    releaseSharedCredentials: () =>
      releaseSlackInstallationCredentials({
        env,
        directory: env.DB,
        db: execution.value.database,
        organisationId,
        now: Date.now(),
      }),
  });
  if (!erased.ok) {
    switch (erased.error.code) {
      case "organisation_not_purged":
        return errorResponse(
          erased.error.code,
          "The organisation is not purged.",
          409,
        );
      case "shared_credentials_not_released":
        return errorResponse(
          erased.error.code,
          `The Slack bot tokens did not move (${erased.error.reason}). Nothing was erased.`,
          409,
        );
      default:
        return assertNever(erased.error);
    }
  }
  return jsonResponse({
    ok: true,
    report: {
      kind: "purged_organisation_rows_erased",
      organisationId,
      slackInstallationsReleased: erased.value.sharedCredentialsReleased,
      erasedRows: erased.value.erasedRows,
    },
  });
}

async function discardQuarantinedCaseResponse(
  env: Env,
  input: VariantBy<
    ActorRegistryAdminRequest,
    "command",
    "discard_quarantined_case"
  >,
): Promise<Response> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const entries = await listOrganisationActorRegistryEntries({
    db: execution.value.database,
    organisationId: input.organisationId,
  });
  if (!entries.ok) {
    return actorRegistryReconciliationErrorResponse(entries.error);
  }
  const entry = entries.value.find(
    function matchesAuthorizedQuarantinedCase(candidate) {
      return (
        candidate.registryId === input.registryId &&
        candidate.identity.objectKind === "case" &&
        candidate.identity.logicalObjectId === input.caseId
      );
    },
  );
  if (entry === undefined) {
    return errorResponse(
      "registry_entry_missing",
      "Quarantined Case was not found.",
      404,
    );
  }
  if (
    !isQuarantinedCaseRegistryEntry(entry, input.registryId, input.caseId) ||
    entry.quarantinedAt !== input.expectedQuarantinedAt ||
    entry.quarantineReason !== input.expectedQuarantineReason
  ) {
    return errorResponse(
      "registry_quarantine_conflict",
      "Quarantined Case state changed.",
      409,
    );
  }
  const actor = actorStub(
    env.CASE,
    entry.physicalObjectName,
    entry.placement,
  );
  const discardedState = await actor.discardQuarantinedState(
    actorActivationIdentityForQuarantinedEntry(entry, Date.now()),
  );
  if (!discardedState.ok) {
    return errorResponse(
      discardedState.error.code,
      "Quarantined Case identity changed.",
      409,
    );
  }
  const discardedRegistry = await discardQuarantinedActorRegistryEntry({
    db: execution.value.database,
    registryId: entry.registryId,
    expectedFenceToken: entry.fenceToken,
    expectedQuarantinedAt: input.expectedQuarantinedAt,
    expectedQuarantineReason: input.expectedQuarantineReason,
  });
  if (!discardedRegistry.ok) {
    return actorRegistryReconciliationErrorResponse(discardedRegistry.error);
  }
  return jsonResponse({
    ok: true,
    report: {
      kind: "quarantined_case_discarded",
      identity: entry.identity,
      registryId: discardedRegistry.value.registryId,
      actorState: discardedState.value.kind,
      stateVersion: discardedState.value.stateVersion,
      reachableAttachmentCount: discardedState.value.reachableAttachmentCount,
      discardedAt: Date.now(),
    },
  });
}

async function recoverConnectorCaseWorkResponse(
  env: Env,
  input: VariantBy<
    ActorRegistryAdminRequest,
    "command",
    "recover_connector_case_work"
  >,
): Promise<Response> {
  const actor = await resolveActiveConnectorActor({
    env: env,
    namespace: env.CONNECTOR,
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    now: Date.now(),
  });
  if (!actor.ok) {
    return actorResolutionErrorResponse(actor.error);
  }
  const recovered = await actor.value.recoverCaseWork({
    identity: {
      organisationId: input.organisationId,
      connectorId: input.connectorId,
    },
    requestId: newRequestId(),
  });
  return recovered.ok
    ? jsonResponse({ ok: true, result: recovered.value })
    : errorResponse(
        recovered.error.code,
        "Connector Case work recovery failed.",
        409,
      );
}

async function interruptActiveSessionResponse(
  env: Env,
  input: VariantBy<ActorRegistryAdminRequest, "command", "interrupt_session">,
): Promise<Response> {
  const actor: Result<ImportedCanonicalSessionActorStub, ActorResolutionError> =
    await resolveImportedCanonicalSessionActor({
      env: env,
      namespace: env.SESSION,
      organisationId: input.organisationId,
      sessionId: input.sessionId,
    });
  if (!actor.ok) {
    return actorResolutionErrorResponse(actor.error);
  }
  const interrupted = await actor.value.interruptCanonicalEmbeddedHarnessTurn({
    requestId: newRequestId(),
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    interruptedAt: Date.now(),
  });
  return interrupted.ok
    ? jsonResponse({ ok: true, result: interrupted.value })
    : errorResponse(
        interrupted.error.code,
        "Session interruption failed.",
        409,
      );
}

async function bootstrapOrganisationActorRegistryResponse(
  env: Env,
  organisationId: OrganisationId,
): Promise<Response> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;
  const actor = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: scope.placement,
    now: Date.now(),
  });

  const organisation = await readBootstrapOrganisationMeta(
    scope.database,
    organisationId,
  );
  if (organisation === null) {
    return errorResponse(
      "organisation_not_found",
      "Organisation bootstrap state was not found.",
      404,
    );
  }
  await actor.ensureOrganisation(organisation);
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: scope.database,
      kv: env.POLICY_KV,
    },
    organisationId,
    organisation: actor,
    now: Date.now(),
  });
  if (!policy.ok) {
    return errorResponse(
      policy.error.code,
      "Organisation policy bootstrap failed.",
      409,
    );
  }

  const inventory = await inspectOrganisationActorRegistry({
    db: scope.database,
    organisationId,
  });
  return inventory.ok
    ? jsonResponse({
        ok: true,
        report: {
          kind: "organisation_bootstrapped",
          organisationId,
          inventory: inventory.value,
        },
      })
    : actorRegistryReconciliationErrorResponse(inventory.error);
}

type BootstrapOrganisationMetaRow = {
  readonly organisationId: unknown;
  readonly name: unknown;
  readonly plan: unknown;
  readonly status: unknown;
  readonly createdAt: unknown;
};

async function readBootstrapOrganisationMeta(
  db: D1Database,
  organisationId: OrganisationId,
): Promise<OrganisationMetaInput | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId, name, plan, status, created_at AS createdAt
     FROM organisation WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<BootstrapOrganisationMetaRow>();
  if (
    row === null ||
    row.organisationId !== organisationId ||
    typeof row.name !== "string" ||
    row.plan !== "beta" ||
    (row.status !== "active" &&
      row.status !== "suspended" &&
      row.status !== "deleted") ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt)
  ) {
    return null;
  }
  return {
    organisationId,
    name: row.name,
    plan: row.plan,
    status: row.status,
    createdAt: row.createdAt,
  };
}

async function advanceActorSchemaResponse(
  env: Env,
  input: VariantBy<
    ActorRegistryAdminRequest,
    "command",
    "advance_actor_schema"
  >,
): Promise<Response> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }

  const inventory = await listOrganisationActorRegistryEntries({
    db: execution.value.database,
    organisationId: input.organisationId,
  });
  if (!inventory.ok) {
    return actorRegistryReconciliationErrorResponse(inventory.error);
  }
  const entry = inventory.value.find(function matchesActorIdentity(candidate) {
    return (
      candidate.lifecycleStatus === "active" &&
      candidate.identity.objectKind === input.identity.objectKind &&
      candidate.identity.logicalObjectId === input.identity.logicalObjectId &&
      candidate.placement.placementEpoch ===
        execution.value.placement.placementEpoch
    );
  });
  if (entry === undefined || entry.lifecycleStatus !== "active") {
    return errorResponse(
      "registry_entry_missing",
      "Active Actor was not found.",
      404,
    );
  }
  const targetSchemaVersion = currentActorSchemaVersion(
    entry.identity.objectKind,
  );
  if (entry.schemaVersion > targetSchemaVersion) {
    return errorResponse(
      "registry_schema_mismatch",
      "Actor schema cannot advance.",
      409,
    );
  }

  const startedAtTarget = entry.schemaVersion === targetSchemaVersion;
  let current = entry;
  while (current.schemaVersion < targetSchemaVersion) {
    const nextSchemaVersion = current.schemaVersion + 1;
    const actor = actorSchemaAdvanceStub(env, current);
    const local = await actor.advanceActivationSchema({
      registryId: current.registryId,
      fenceToken: current.fenceToken,
      sourceSchemaVersion: current.schemaVersion,
      targetSchemaVersion: nextSchemaVersion,
    });
    if (!local.ok) {
      return actorActivationSchemaAdvanceErrorResponse(local.error);
    }
    const advanced = await advanceActiveActorRegistrySchema({
      db: execution.value.database,
      registryId: current.registryId,
      expectedFenceToken: current.fenceToken,
      sourceSchemaVersion: current.schemaVersion,
      targetSchemaVersion: nextSchemaVersion,
      expectedStateVersion: current.stateVersion,
    });
    if (!advanced.ok) {
      return actorRegistrySchemaAdvanceErrorResponse(advanced.error);
    }
    if (advanced.value.stateVersion !== local.value.stateVersion) {
      return errorResponse(
        "registry_schema_advance_conflict",
        "Actor schema state diverged.",
        409,
      );
    }
    if (advanced.value.lifecycleStatus !== "active") {
      return errorResponse(
        "registry_schema_advance_conflict",
        "Actor is no longer active.",
        409,
      );
    }
    current = advanced.value;
  }

  if (startedAtTarget && targetSchemaVersion > 1) {
    const actor = actorSchemaAdvanceStub(env, current);
    const local = await actor.advanceActivationSchema({
      registryId: current.registryId,
      fenceToken: current.fenceToken,
      sourceSchemaVersion: targetSchemaVersion - 1,
      targetSchemaVersion,
    });
    if (!local.ok) {
      return actorActivationSchemaAdvanceErrorResponse(local.error);
    }
    if (local.value.stateVersion !== current.stateVersion) {
      return errorResponse(
        "registry_schema_advance_conflict",
        "Actor schema state diverged.",
        409,
      );
    }
  }

  return jsonResponse({
    ok: true,
    report: {
      kind: "actor_schema_advanced",
      identity: current.identity,
      schemaVersion: current.schemaVersion,
      stateVersion: current.stateVersion,
    },
  });
}

function actorSchemaAdvanceStub(
  env: Env,
  entry: ActiveActorRegistryEntry,
): ActorSchemaAdvanceStub {
  switch (entry.identity.objectKind) {
    case "organisation":
      return actorStub(
        env.ORGANISATION,
        entry.physicalObjectName,
        entry.placement,
      );
    case "connector":
      return actorStub(
        env.CONNECTOR,
        entry.physicalObjectName,
        entry.placement,
      );
    case "session":
    case "case":
      throw new Error(
        `actor_schema_advance_unsupported:${entry.identity.objectKind}`,
      );
    default:
      return assertNever(entry.identity);
  }
}

async function reconcileReservedActorRegistryResponse(
  env: Env,
  input: VariantBy<ActorRegistryAdminRequest, "command", "reconcile_reserved">,
): Promise<Response> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const reconciled = await reconcileOrganisationActorRegistry({
    db: execution.value.database,
    namespaces: actorNamespaces(env),
    organisationId: input.organisationId,
    now: Date.now(),
    staleReservationAgeMs: input.staleReservationAgeMs,
  });

  return reconciled.ok
    ? jsonResponse({ ok: true, report: reconciled.value })
    : actorRegistryReconciliationErrorResponse(reconciled.error);
}

function parseActorRegistryAdminRequest(
  body: JsonObject,
): Result<ActorRegistryAdminRequest, ActorRegistryAdminRequestError> {
  const command = readStringField(body, "command");
  if (command.ok && command.value === "erase_unregistered_actor") {
    // This one names an object, not an Organisation: the object's is gone.
    const objectKind = readStringField(body, "objectKind");
    const objectId = readStringField(body, "objectId");
    return objectKind.ok &&
      objectId.ok &&
      isUnregisteredActorKind(objectKind.value) &&
      /^[0-9a-f]{64}$/u.test(objectId.value) &&
      Object.keys(body).length === 3
      ? {
          ok: true,
          value: {
            command: command.value,
            objectKind: objectKind.value,
            objectId: objectId.value,
          },
        }
      : invalidActorRegistryAdminRequest("unregisteredActor");
  }
  const organisationId = readOrganisationIdField(body);
  if (!command.ok) {
    return invalidActorRegistryAdminRequest("command");
  }
  if (!organisationId.ok) {
    return invalidActorRegistryAdminRequest("organisationId");
  }

  if (
    command.value === "bootstrap_organisation" ||
    command.value === "erase_purged_organisation_rows"
  ) {
    return Object.keys(body).length === 2
      ? {
          ok: true,
          value: {
            command: command.value,
            organisationId: organisationId.value,
          },
        }
      : invalidActorRegistryAdminRequest("unexpected_field");
  }

  if (command.value === "reconcile_reserved") {
    const staleReservationAgeMs = readPositiveSafeIntegerField(
      body,
      "staleReservationAgeMs",
    );
    return staleReservationAgeMs.ok && Object.keys(body).length === 3
      ? {
          ok: true,
          value: {
            command: command.value,
            organisationId: organisationId.value,
            staleReservationAgeMs: staleReservationAgeMs.value,
          },
        }
      : invalidActorRegistryAdminRequest("staleReservationAgeMs");
  }

  if (command.value === "advance_actor_schema") {
    const objectKind = readStringField(body, "objectKind");
    const logicalObjectId = readStringField(body, "logicalObjectId");
    if (
      !objectKind.ok ||
      !logicalObjectId.ok ||
      Object.keys(body).length !== 4
    ) {
      return invalidActorRegistryAdminRequest("identity");
    }
    if (
      objectKind.value === "organisation" &&
      logicalObjectId.value === organisationId.value
    ) {
      return {
        ok: true,
        value: {
          command: command.value,
          organisationId: organisationId.value,
          identity: {
            objectKind: "organisation",
            organisationId: organisationId.value,
            logicalObjectId: organisationId.value,
          },
        },
      };
    }
    if (objectKind.value === "connector") {
      const connectorId = parseConnectorId(logicalObjectId.value);
      return connectorId.ok
        ? {
            ok: true,
            value: {
              command: command.value,
              organisationId: organisationId.value,
              identity: {
                objectKind: "connector",
                organisationId: organisationId.value,
                logicalObjectId: connectorId.value,
              },
            },
          }
        : invalidActorRegistryAdminRequest("identity");
    }
    return invalidActorRegistryAdminRequest("identity");
  }

  if (command.value === "interrupt_session") {
    const sessionId = readStringField(body, "sessionId");
    if (!sessionId.ok || Object.keys(body).length !== 3) {
      return invalidActorRegistryAdminRequest("sessionId");
    }
    const parsed = parseSessionId(sessionId.value);
    return parsed.ok
      ? {
          ok: true,
          value: {
            command: command.value,
            organisationId: organisationId.value,
            sessionId: parsed.value,
          },
        }
      : invalidActorRegistryAdminRequest("sessionId");
  }

  if (command.value === "recover_connector_case_work") {
    const connectorId = readStringField(body, "connectorId");
    if (!connectorId.ok || Object.keys(body).length !== 3) {
      return invalidActorRegistryAdminRequest("connectorId");
    }
    const parsed = parseConnectorId(connectorId.value);
    return parsed.ok
      ? {
          ok: true,
          value: {
            command: command.value,
            organisationId: organisationId.value,
            connectorId: parsed.value,
          },
        }
      : invalidActorRegistryAdminRequest("connectorId");
  }

  if (command.value === "discard_quarantined_case") {
    const caseId = readStringField(body, "caseId");
    const registryId = readStringField(body, "registryId");
    const expectedQuarantinedAt = readPositiveSafeIntegerField(
      body,
      "expectedQuarantinedAt",
    );
    const expectedQuarantineReason = readStringField(
      body,
      "expectedQuarantineReason",
    );
    if (
      !caseId.ok ||
      !registryId.ok ||
      !expectedQuarantinedAt.ok ||
      !expectedQuarantineReason.ok ||
      Object.keys(body).length !== 6
    ) {
      return invalidActorRegistryAdminRequest("quarantinedCase");
    }
    const parsedCaseId = parseCaseId(caseId.value);
    const parsedRegistryId = parseActorRegistryId(registryId.value);
    return parsedCaseId.ok && parsedRegistryId.ok
      ? {
          ok: true,
          value: {
            command: command.value,
            organisationId: organisationId.value,
            caseId: parsedCaseId.value,
            registryId: parsedRegistryId.value,
            expectedQuarantinedAt: expectedQuarantinedAt.value,
            expectedQuarantineReason: expectedQuarantineReason.value,
          },
        }
      : invalidActorRegistryAdminRequest("quarantinedCase");
  }

  return invalidActorRegistryAdminRequest("command");
}

function invalidActorRegistryAdminRequest(
  field: string,
): Result<never, ActorRegistryAdminRequestError> {
  return {
    ok: false,
    error: { code: "invalid_actor_registry_request", field },
  };
}

async function inspectOrganisationActorRegistryResponse(
  request: Request,
  env: Env,
): Promise<Response> {
  const query = parseActorRegistryInspectionQuery(new URL(request.url));
  if (!query.ok) {
    return errorResponse("invalid_field", query.error.message, 422);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    query.value.organisationId,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const inventory = await inspectOrganisationActorRegistry({
    db: execution.value.database,
    organisationId: query.value.organisationId,
  });

  if (!inventory.ok) {
    return actorRegistryReconciliationErrorResponse(inventory.error);
  }

  if (query.value.kind === "case") {
    const entry = findInspectableCaseInventoryEntry(
      inventory.value,
      query.value.caseId,
    );
    if (entry === undefined) {
      return errorResponse(
        "actor_not_found",
        "Active or quarantined Case was not found.",
        404,
      );
    }
    if (entry.lifecycleStatus === "quarantined") {
      const exactEntries = await listOrganisationActorRegistryEntries({
        db: execution.value.database,
        organisationId: query.value.organisationId,
      });
      if (!exactEntries.ok) {
        return actorRegistryReconciliationErrorResponse(exactEntries.error);
      }
      const exactEntry = findQuarantinedCaseRegistryEntry(
        exactEntries.value,
        entry.registryId,
        query.value.caseId,
      );
      if (exactEntry === undefined) {
        return errorResponse(
          "registry_entry_conflict",
          "Case registry state changed during inspection.",
          409,
        );
      }
      let activation: ActorActivationInspection;
      try {
        activation = await actorStub(
          env.CASE,
          exactEntry.physicalObjectName,
          exactEntry.placement,
        ).inspectActivation(
          actorActivationIdentityForQuarantinedEntry(exactEntry, Date.now()),
        );
      } catch {
        return errorResponse(
          "actor_inspection_unavailable",
          "Case activation inspection was unavailable.",
          503,
        );
      }
      return jsonResponse({
        ok: true,
        organisationId: query.value.organisationId,
        caseActivation: {
          registryId: exactEntry.registryId,
          identity: exactEntry.identity,
          lifecycleStatus: exactEntry.lifecycleStatus,
          registrySchemaVersion: exactEntry.schemaVersion,
          registryStateVersion: exactEntry.stateVersion,
          quarantinedAt: exactEntry.quarantinedAt,
          quarantineReason: exactEntry.quarantineReason,
          activationVerification: activation,
        },
      });
    }
    try {
      const inspected = await actorStub(
        env.CASE,
        entry.physicalObjectName,
        entry.placement,
      ).inspect();
      if (inspected.ok !== true) {
        return errorResponse(
          "actor_inspection_failed",
          "Case inspection failed.",
          409,
        );
      }
      return jsonResponse({
        ok: true,
        organisationId: query.value.organisationId,
        case: sanitizeCaseBudgetActivationInspection(inspected.value),
      });
    } catch {
      return errorResponse(
        "actor_inspection_unavailable",
        "Case inspection was unavailable.",
        503,
      );
    }
  }

  if (query.value.kind === "session") {
    const entry = findActiveSessionInventoryEntry(
      inventory.value,
      query.value.sessionId,
    );
    if (entry === undefined) {
      return errorResponse(
        "actor_not_found",
        "Active Session was not found.",
        404,
      );
    }
    const sessions = await inspectActiveSessionRegistryEntries({
      env,
      organisationId: query.value.organisationId,
      inventory: [entry],
    });
    return jsonResponse({
      ok: true,
      organisationId: query.value.organisationId,
      sessions,
    });
  }

  const sessions = await inspectActiveSessionRegistryEntries({
    env,
    organisationId: query.value.organisationId,
    inventory: inventory.value,
  });
  return jsonResponse({
    ok: true,
    organisationId: query.value.organisationId,
    inventory: inventory.value,
    sessions,
  });
}

type ActorRegistryInspectionQuery =
  | {
      readonly kind: "organisation";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly kind: "case";
      readonly organisationId: OrganisationId;
      readonly caseId: CaseId;
    }
  | {
      readonly kind: "session";
      readonly organisationId: OrganisationId;
      readonly sessionId: SessionId;
    };

type ActorRegistryInspectionQueryError = {
  readonly message: string;
};

function parseActorRegistryInspectionQuery(
  url: URL,
): Result<ActorRegistryInspectionQuery, ActorRegistryInspectionQueryError> {
  const organisationId = parseOrganisationId(
    url.searchParams.get("organisationId") ?? "",
  );
  if (!organisationId.ok) {
    return { ok: false, error: { message: "organisationId is invalid." } };
  }

  const rawCaseId = url.searchParams.get("caseId");
  const rawSessionId = url.searchParams.get("sessionId");
  if (rawCaseId !== null && rawSessionId !== null) {
    return {
      ok: false,
      error: { message: "caseId and sessionId cannot be used together." },
    };
  }

  if (rawCaseId !== null) {
    const caseId = parseCaseId(rawCaseId);
    return caseId.ok
      ? {
          ok: true,
          value: {
            kind: "case",
            organisationId: organisationId.value,
            caseId: caseId.value,
          },
        }
      : { ok: false, error: { message: "caseId is invalid." } };
  }

  if (rawSessionId !== null) {
    const sessionId = parseSessionId(rawSessionId);
    return sessionId.ok
      ? {
          ok: true,
          value: {
            kind: "session",
            organisationId: organisationId.value,
            sessionId: sessionId.value,
          },
        }
      : { ok: false, error: { message: "sessionId is invalid." } };
  }

  return {
    ok: true,
    value: { kind: "organisation", organisationId: organisationId.value },
  };
}

function actorActivationIdentityForQuarantinedEntry(
  entry: QuarantinedCaseActorRegistryEntry,
  requestedAt: number,
): ActorActivationIdentity {
  return {
    registryId: entry.registryId,
    activationToken: entry.activationToken,
    identity: entry.identity,
    physicalObjectName: entry.physicalObjectName,
    placement: entry.placement,
    schemaVersion: entry.schemaVersion,
    fenceToken: entry.fenceToken,
    requestedAt,
  };
}

function findInspectableCaseInventoryEntry(
  inventory: readonly ActorRegistryInventoryEntry[],
  caseId: CaseId,
): ActorRegistryInventoryEntry | undefined {
  for (const candidate of inventory) {
    if (
      candidate.identity.objectKind === "case" &&
      candidate.identity.logicalObjectId === caseId &&
      (candidate.lifecycleStatus === "active" ||
        candidate.lifecycleStatus === "quarantined")
    ) {
      return candidate;
    }
  }
  return undefined;
}

function findQuarantinedCaseRegistryEntry(
  entries: readonly ActorRegistryEntry[],
  registryId: ActorRegistryId,
  caseId: CaseId,
): QuarantinedCaseActorRegistryEntry | undefined {
  for (const candidate of entries) {
    if (isQuarantinedCaseRegistryEntry(candidate, registryId, caseId)) {
      return candidate;
    }
  }
  return undefined;
}

function isQuarantinedCaseRegistryEntry(
  candidate: ActorRegistryEntry,
  registryId: ActorRegistryId,
  caseId: CaseId,
): candidate is QuarantinedCaseActorRegistryEntry {
  return (
    candidate.registryId === registryId &&
    candidate.lifecycleStatus === "quarantined" &&
    candidate.identity.objectKind === "case" &&
    candidate.identity.logicalObjectId === caseId
  );
}

function sanitizeCaseBudgetActivationInspection(snapshot: CaseSnapshot) {
  return {
    identity: snapshot.identity,
    revision: snapshot.revision,
    assignments: snapshot.assignmentLifecycles.map((lifecycle) => {
      const assignment = {
        assignmentId: lifecycle.assignment.assignmentId,
        sessionId: lifecycle.assignment.sessionId,
        caseRevision: lifecycle.assignment.caseRevision,
      };
      switch (lifecycle.kind) {
        case "assigned":
          return { kind: lifecycle.kind, assignment };
        case "running":
          return {
            kind: lifecycle.kind,
            assignment,
            startId: lifecycle.start.startId,
          };
        case "settled":
          return {
            kind: lifecycle.kind,
            assignment,
            startId: lifecycle.start.startId,
            disposition: lifecycle.disposition,
          };
        default:
          return assertNever(lifecycle);
      }
    }),
    outputs: snapshot.outputs.map((lifecycle) => {
      const output = {
        outputId: lifecycle.output.outputId,
        source: lifecycle.output.source,
        deliveryId: lifecycle.output.delivery.deliveryId,
        idempotencyKey: lifecycle.output.delivery.idempotencyKey,
      };
      switch (lifecycle.kind) {
        case "pending":
          return { kind: lifecycle.kind, output };
        case "settled":
          return {
            kind: lifecycle.kind,
            output,
            receipt: {
              nativeReceiptId: lifecycle.receipt.nativeReceiptId,
              deliveredAt: lifecycle.receipt.deliveredAt,
            },
          };
        case "dropped":
          return { kind: lifecycle.kind, output, reason: lifecycle.reason };
        case "held":
          return { kind: lifecycle.kind, output, requestId: lifecycle.requestId };
        case "rejected":
          return { kind: lifecycle.kind, output, reason: lifecycle.reason };
        default:
          return assertNever(lifecycle);
      }
    }),
  };
}

type ActiveSessionRegistryInspection =
  | {
      readonly kind: "inspected";
      readonly identity: VariantBy<
        ActorRegistryInventoryEntry["identity"],
        "objectKind",
        "session"
      >;
      readonly schemaVersion: number;
      readonly lifecycleKind: RpcSessionInspection["lifecycleKind"];
      readonly quiescence: RpcSessionInspection["quiescence"];
      readonly checkpoint: RpcSessionInspection["checkpoint"];
      readonly budget: RpcSessionInspection["budget"];
      readonly reservation: RpcSessionInspection["reservation"];
      readonly preparation: RpcSessionInspection["preparation"];
      readonly latestMessageLinkReceipt: RpcSessionInspection["latestMessageLinkReceipt"];
    }
  | {
      readonly kind: "unavailable";
      readonly identity: VariantBy<
        ActorRegistryInventoryEntry["identity"],
        "objectKind",
        "session"
      >;
      readonly schemaVersion: number;
      readonly error: { readonly code: string };
    };

type ActiveSessionInventoryEntry = VariantBy<
  ActorRegistryInventoryEntry,
  "lifecycleStatus",
  "active"
> & {
  readonly identity: VariantBy<
    ActorRegistryInventoryEntry["identity"],
    "objectKind",
    "session"
  >;
};

type RpcSessionInspectionResult = Awaited<
  ReturnType<ImportedCanonicalSessionActorStub["inspectCanonicalSessionState"]>
>;

type RpcSessionInspection = VariantBy<
  RpcSessionInspectionResult,
  "ok",
  true
>["value"];

async function inspectActiveSessionRegistryEntries(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly inventory: readonly ActorRegistryInventoryEntry[];
}): Promise<readonly ActiveSessionRegistryInspection[]> {
  const inspections: ActiveSessionRegistryInspection[] = [];
  for (const entry of input.inventory) {
    if (!isActiveSessionInventoryEntry(entry)) {
      continue;
    }
    inspections.push(
      await inspectActiveSessionRegistryEntry({
        env: input.env,
        organisationId: input.organisationId,
        entry,
      }),
    );
  }
  return inspections;
}

function isActiveSessionInventoryEntry(
  entry: ActorRegistryInventoryEntry,
): entry is ActiveSessionInventoryEntry {
  return (
    entry.lifecycleStatus === "active" &&
    entry.identity.objectKind === "session"
  );
}

function findActiveSessionInventoryEntry(
  inventory: readonly ActorRegistryInventoryEntry[],
  sessionId: SessionId,
): ActiveSessionInventoryEntry | undefined {
  for (const entry of inventory) {
    if (
      isActiveSessionInventoryEntry(entry) &&
      entry.identity.logicalObjectId === sessionId
    ) {
      return entry;
    }
  }
  return undefined;
}

async function inspectActiveSessionRegistryEntry(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly entry: ActiveSessionInventoryEntry;
}): Promise<ActiveSessionRegistryInspection> {
  const unavailable = unavailableSessionInspection.bind(null, input.entry);
  let actor: ImportedCanonicalSessionActorStub;
  try {
    actor = actorStub(
      input.env.SESSION,
      input.entry.physicalObjectName,
      input.entry.placement,
    );
  } catch {
    return unavailable({ code: "actor_unreachable" });
  }

  let inspected: Awaited<
    ReturnType<
      ImportedCanonicalSessionActorStub["inspectCanonicalSessionState"]
    >
  >;
  try {
    inspected = await actor.inspectCanonicalSessionState({
      organisationId: input.organisationId,
      sessionId: input.entry.identity.logicalObjectId,
    });
  } catch {
    return unavailable({ code: "actor_unreachable" });
  }
  if (!inspected.ok) {
    return unavailable(inspected.error);
  }
  if (
    !sessionInspectionIdentityMatches(inspected.value, input.entry.identity)
  ) {
    return unavailable({ code: "session_identity_mismatch" });
  }

  return {
    kind: "inspected",
    identity: input.entry.identity,
    schemaVersion: input.entry.schemaVersion,
    lifecycleKind: inspected.value.lifecycleKind,
    quiescence: inspected.value.quiescence,
    checkpoint: inspected.value.checkpoint,
    budget: inspected.value.budget,
    reservation: inspected.value.reservation,
    preparation: inspected.value.preparation,
    latestMessageLinkReceipt: inspected.value.latestMessageLinkReceipt,
  };
}

function unavailableSessionInspection(
  entry: ActiveSessionInventoryEntry,
  error: { readonly code: string },
): ActiveSessionRegistryInspection {
  return {
    kind: "unavailable",
    identity: entry.identity,
    schemaVersion: entry.schemaVersion,
    error: { code: error.code },
  };
}

function sessionInspectionIdentityMatches(
  inspection: RpcSessionInspection,
  identity: VariantBy<
    ActorRegistryInventoryEntry["identity"],
    "objectKind",
    "session"
  >,
): boolean {
  return (
    inspection.identity.organisationId === identity.organisationId &&
    inspection.identity.sessionId === identity.logicalObjectId
  );
}

export async function handleInspectRetainedVaultRootClosure(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const closure = await inspectRetainedVaultRootClosure({
    databases: configuredOrganisationDatabases(env),
    keys: env,
  });
  return closure.ok
    ? jsonResponse({ ok: true, closure: closure.value })
    : retainedVaultRootClosureErrorResponse(closure.error);
}

function actorNamespaces(env: Env): ActorNamespaces {
  return {
    organisation: env.ORGANISATION,
    session: env.SESSION,
    case: env.CASE,
    connector: env.CONNECTOR,
  };
}

function actorRegistryReconciliationErrorResponse(
  error: ActorRegistryReconciliationError,
): Response {
  switch (error.code) {
    case "registry_entry_missing":
      return errorResponse(
        error.code,
        "Actor registry entry was not found.",
        404,
      );
    case "invalid_quarantine_reason":
      return errorResponse(
        error.code,
        "Actor quarantine reason is invalid.",
        422,
      );
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
      return errorResponse(
        error.code,
        "Actor registry conflicts with current state.",
        409,
      );
    case "registry_activation_unreachable":
      return errorResponse(
        error.code,
        `Actor ${error.registryId} could not be reached for reconciliation.`,
        503,
      );
    case "registry_entry_corrupt":
      return errorResponse(error.code, "Actor registry state is invalid.", 500);
    default:
      return assertNever(error);
  }
}

function actorActivationSchemaAdvanceErrorResponse(
  error: ActorActivationSchemaAdvanceError,
): Response {
  switch (error.code) {
    case "activation_missing":
      return errorResponse(
        error.code,
        "Organisation Actor activation was not found.",
        404,
      );
    case "activation_fence_mismatch":
    case "activation_schema_mismatch":
      return errorResponse(
        error.code,
        "Organisation Actor activation schema conflicted.",
        409,
      );
    default:
      return assertNever(error);
  }
}

function actorRegistrySchemaAdvanceErrorResponse(
  error: ActorRegistrySchemaAdvanceError,
): Response {
  switch (error.code) {
    case "registry_entry_missing":
      return errorResponse(
        error.code,
        "Organisation Actor registry entry was not found.",
        404,
      );
    case "invalid_registry_schema_transition":
      return errorResponse(
        error.code,
        "Organisation Actor schema transition is invalid.",
        422,
      );
    case "registry_schema_advance_conflict":
      return errorResponse(
        error.code,
        "Organisation Actor registry schema conflicted.",
        409,
      );
    case "registry_entry_corrupt":
      return errorResponse(
        error.code,
        "Organisation Actor registry entry is invalid.",
        500,
      );
    default:
      return assertNever(error);
  }
}

function retainedVaultRootClosureErrorResponse(
  error: RetainedVaultRootClosureError,
): Response {
  switch (error.code) {
    case "retained_vault_root_inventory_exceeded":
      return errorResponse(
        error.code,
        "Retained Vault inventory exceeds the bounded audit.",
        409,
      );
    case "vault_active_key_version_invalid":
    case "vault_root_key_version_invalid":
    case "vault_root_binding_invalid":
    case "vault_root_version_duplicate":
    case "vault_active_root_unavailable":
    case "vault_root_unavailable":
    case "vault_root_invalid":
    case "retained_vault_root_data_invalid":
    case "retained_vault_root_persistence_failed":
      return errorResponse(
        error.code,
        "Retained Vault root evidence is unavailable.",
        500,
      );
    default:
      return assertNever(error);
  }
}
