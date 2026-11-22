import {
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
  type OrganisationExecutionScopeError,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  activateActorRegistryEntry,
  quarantineActorRegistryEntry,
  actorActivationRequest,
  reserveActor,
  type ActorRegistryEntry,
  type ActorRegistryError,
  type ActorIdentity,
} from "./actor-registry";
import type { ActorExportError, ActorExportRef } from "./actor-export";
import { currentActorSchemaVersion } from "./current-actor-schema-version";
import {
  actorPlacementDirectoryAdmits,
  type ActorPlacementAdmission,
} from "./actor-placement-admission";
import type { Result } from "@purin-labs/kernel/result";
import {
  actorStubForRegistryEntry,
  type ActorNamespaces,
} from "./actor-router";
import type { VariantBy } from "@purin-labs/type-utils";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";

export type ActorCopyError =
  | OrganisationExecutionScopeError
  | ActorRegistryError
  | ActorExportError
  | { readonly code: "actor_activation_failed" }
  | { readonly code: "target_schema_older_than_export" };

export async function importActorCopyTarget(input: {
  readonly env: OrganisationPlacementBindings;
  readonly namespaces: ActorNamespaces;
  readonly identity: ActorIdentity;
  readonly sourceSchemaVersion: number;
  readonly admission: VariantBy<
    ActorPlacementAdmission,
    "kind",
    "relocation" | "restore"
  >;
  readonly exportRef: ActorExportRef;
  readonly now: number;
}): Promise<
  Result<
    VariantBy<ActorRegistryEntry, "lifecycleStatus", "active">,
    ActorCopyError
  >
> {
  const schemaVersion = currentActorSchemaVersion(input.identity.objectKind);

  if (schemaVersion < input.sourceSchemaVersion) {
    return { ok: false, error: { code: "target_schema_older_than_export" } };
  }

  const selected = selectOrganisationPlacementDatabase(
    input.env,
    input.identity.organisationId,
    input.admission.placement,
  );
  if (!selected.ok) return selected;
  if (!(await actorPlacementDirectoryAdmits(input.env.DB, input.admission))) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  const target = await reserveActor({
    db: selected.value,
    identity: input.identity,
    admission: input.admission,
    schemaVersion,
    now: input.now,
  });

  if (!target.ok) {
    return target;
  }

  if (
    target.value.lifecycleStatus !== "reserved" &&
    target.value.lifecycleStatus !== "active"
  ) {
    return { ok: false, error: { code: "registry_entry_not_activatable" } };
  }

  const targetObject = actorStubForRegistryEntry({
    namespaces: input.namespaces,
    entry: target.value,
  });
  const requestId = newRequestId();
  const startedAt = Date.now();
  traceLog("actor.copy_activation_started", {
    requestId,
    export_id: input.exportRef.exportId,
    object_kind: input.identity.objectKind,
  });
  const activated = await targetObject.activate(
    actorActivationRequest(target.value, input.now, input.admission),
  );

  if (!activated.ok) {
    return {
      ok: false,
      error: {
        code:
          activated.error.code === "activation_placement_conflict"
            ? "registry_placement_conflict"
            : "actor_activation_failed",
      },
    };
  }

  if (!(await actorPlacementDirectoryAdmits(input.env.DB, input.admission))) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  traceLog("actor.copy_import_started", {
    requestId,
    export_id: input.exportRef.exportId,
    object_kind: input.identity.objectKind,
    elapsed_ms: Date.now() - startedAt,
  });
  const imported = await targetObject.importPlacementState({
    expectedTargetFenceToken: target.value.fenceToken,
    exportRef: input.exportRef,
    requestedAt: input.now,
  });
  traceLog("actor.copy_import_finished", {
    requestId,
    export_id: input.exportRef.exportId,
    object_kind: input.identity.objectKind,
    elapsed_ms: Date.now() - startedAt,
    result: imported.ok ? "ok" : imported.error.code,
  });

  if (!imported.ok) {
    if (definitiveActorImportFailure(imported.error)) {
      await quarantineActorRegistryEntry({
        db: selected.value,
        registryId: target.value.registryId,
        expectedFenceToken: target.value.fenceToken,
        reason: imported.error.code,
        now: input.now,
      });
    }

    return imported;
  }

  if (!(await actorPlacementDirectoryAdmits(input.env.DB, input.admission))) {
    return { ok: false, error: { code: "registry_placement_conflict" } };
  }
  const published = await activateActorRegistryEntry({
    db: selected.value,
    admission: input.admission,
    registryId: target.value.registryId,
    activationToken: target.value.activationToken,
    stateVersion: imported.value.stateVersion,
    now: input.now,
  });

  return published.ok && published.value.lifecycleStatus === "active"
    ? { ok: true, value: published.value }
    : published.ok
      ? { ok: false, error: { code: "registry_activation_conflict" } }
      : published;
}

export function definitiveActorImportFailure(error: ActorCopyError): boolean {
  switch (error.code) {
    case "actor_not_activated":
    case "actor_fence_mismatch":
    case "unsupported_state_value":
    case "export_manifest_corrupt":
    case "export_checksum_mismatch":
    case "referenced_r2_corrupt":
    case "target_not_empty":
    case "target_schema_incompatible":
    case "import_conflict":
    case "registry_entry_corrupt":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "invalid_quarantine_reason":
    case "actor_activation_failed":
    case "target_schema_older_than_export":
      return true;
    case "organisation_placement_conflict":
    case "organisation_placement_missing":
    case "organisation_placement_corrupt":
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "organisation_cell_unavailable":
    case "invalid_organisation_placement":
    case "invalid_export_input":
    case "export_root_unavailable":
    case "export_root_invalid":
    case "export_write_failed":
    case "export_read_failed":
    case "actor_cleanup_failed":
    case "export_missing":
    case "referenced_r2_missing":
    case "registry_entry_missing":
    case "registry_placement_conflict":
      return false;
  }
}
