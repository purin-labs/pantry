import {
  parseRelocationMailReceipt,
  reconcileActorRelocationMailReceipt,
  type RelocationMailReceipt,
} from "../../actors/actor-relocation-mail";
import { parseCommerceProviderReceipt } from "../../commerce/action-model";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import {
  readStringField,
  readOrganisationIdField,
} from "../../boundary";
import {
  parseOrganisationPlacementMoveTarget,
  type OrganisationPlacementMoveTarget,
} from "../../data/organisation-placement";
import type { Env } from "../../env";
import {
  inspectActorRelocation,
  parseActorRelocationId,
  resumeActorRelocation,
  waiveActorRelocationRetention,
  abandonActorRelocation,
  reconcileActorRelocationReceipt,
  startActorRelocation,
  type ActorRelocationError,
  type ActorRelocationId,
} from "../../actors/actor-relocation";
import {
  parseActorRestoreManifest,
  prepareActorRestoreManifest,
  type ActorRestoreManifest,
} from "../../actors/actor-restore-manifest";
import {
  abandonActorRestore,
  inspectActorRestore,
  parseActorRestoreId,
  resumeActorRestore,
  startActorRestore,
  type ActorRestoreError,
  type ActorRestoreId,
} from "../../actors/actor-restore";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonObject,
} from "../../http";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { assertNever } from "@purin-labs/std";
import { isAuthorizedOrganisationAdminRequest, jsonBodyErrorResponse } from "../request-helpers";

type ActorRelocationAdminRequest =
  | {
      readonly command: "waive_retention";
      readonly relocationId: ActorRelocationId;
      readonly discardRecoveryCopy: true;
      readonly organisationId?: never;
      readonly target?: never;
      readonly receipt?: never;
    }
  | {
      readonly command: "start";
      readonly organisationId: OrganisationId;
      readonly target: OrganisationPlacementMoveTarget;
      readonly relocationId?: never;
      readonly receipt?: never;
    }
  | {
      readonly command: "resume" | "abandon";
      readonly relocationId: ActorRelocationId;
      readonly organisationId?: never;
      readonly target?: never;
      readonly receipt?: never;
    }
  | {
      readonly command: "reconcile_receipt";
      readonly relocationId: ActorRelocationId;
      readonly receipt: CommerceProviderReceipt;
      readonly organisationId?: never;
      readonly target?: never;
    }
  | {
      readonly command: "reconcile_mail_receipt";
      readonly relocationId: ActorRelocationId;
      readonly receipt: RelocationMailReceipt;
      readonly organisationId?: never;
      readonly target?: never;
    };

type ActorRelocationAdminRequestError = {
  readonly code: "invalid_actor_relocation_request";
  readonly field: string;
};

export async function handleAdministerActorRelocation(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  if (request.method === "GET") {
    return inspectActorRelocationResponse(request, env);
  }

  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const input = parseActorRelocationAdminRequest(body.value);

  if (!input.ok) {
    return errorResponse(
      input.error.code,
      `Actor relocation field ${input.error.field} is invalid.`,
      422,
    );
  }

  const now = Date.now();

  switch (input.value.command) {
    case "start": {
      const started = await startActorRelocation({
        env,
        organisationId: input.value.organisationId,
        target: input.value.target,
        now,
      });

      return started.ok
        ? jsonResponse({ ok: true, relocation: started.value }, 202)
        : actorRelocationErrorResponse(started.error);
    }
    case "abandon": {
      const recovered = await abandonActorRelocation({
        env,
        relocationId: input.value.relocationId,
        now,
      });
      return recovered.ok
        ? jsonResponse({ ok: true, relocation: recovered.value }, 202)
        : actorRelocationErrorResponse(recovered.error);
    }
    case "reconcile_receipt": {
      const settled = await reconcileActorRelocationReceipt({
        env,
        relocationId: input.value.relocationId,
        receipt: input.value.receipt,
        now,
      });
      return settled.ok
        ? jsonResponse({ ok: true })
        : actorRelocationErrorResponse(settled.error);
    }
    case "reconcile_mail_receipt": {
      const settled = await reconcileActorRelocationMailReceipt({
        env,
        relocationId: input.value.relocationId,
        receipt: input.value.receipt,
        now,
      });
      return settled.ok
        ? jsonResponse({ ok: true })
        : actorRelocationErrorResponse(settled.error);
    }
    case "waive_retention": {
      const waived = await waiveActorRelocationRetention({
        env,
        relocationId: input.value.relocationId,
        now,
      });
      return waived.ok
        ? jsonResponse({ ok: true, relocation: waived.value }, 202)
        : actorRelocationErrorResponse(waived.error);
    }
    case "resume": {
      const resumed = await resumeActorRelocation({
        env,
        relocationId: input.value.relocationId,
        now,
      });

      return resumed.ok
        ? jsonResponse({ ok: true, relocation: resumed.value }, 202)
        : actorRelocationErrorResponse(resumed.error);
    }
    default:
      return assertNever(input.value);
  }
}

async function inspectActorRelocationResponse(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawRelocationId = new URL(request.url).searchParams.get("relocationId");
  const relocationId = parseActorRelocationId(rawRelocationId);

  if (!relocationId.ok) {
    return errorResponse(
      "invalid_actor_relocation_request",
      "Actor relocation field relocationId is invalid.",
      422,
    );
  }

  const inspected = await inspectActorRelocation({
    env,
    relocationId: relocationId.value,
  });

  return inspected.ok
    ? jsonResponse({ ok: true, inspection: inspected.value })
    : actorRelocationErrorResponse(inspected.error);
}

function parseActorRelocationAdminRequest(
  body: JsonObject,
): Result<ActorRelocationAdminRequest, ActorRelocationAdminRequestError> {
  const command = readStringField(body, "command");

  if (!command.ok) {
    return invalidActorRelocationAdminRequest("command");
  }

  if (command.value === "waive_retention") {
    const relocationId = parseActorRelocationId(body.relocationId);
    if (!relocationId.ok)
      return invalidActorRelocationAdminRequest("relocationId");
    if (body.discardRecoveryCopy !== true)
      return invalidActorRelocationAdminRequest("discardRecoveryCopy");
    if ("organisationId" in body || "target" in body || "receipt" in body)
      return invalidActorRelocationAdminRequest("command");
    return {
      ok: true,
      value: {
        command: "waive_retention",
        relocationId: relocationId.value,
        discardRecoveryCopy: true,
      },
    };
  }
  if ("discardRecoveryCopy" in body)
    return invalidActorRelocationAdminRequest("discardRecoveryCopy");
  if (command.value === "reconcile_receipt") {
    if ("organisationId" in body || "target" in body)
      return invalidActorRelocationAdminRequest("receipt");
    const relocationId = parseActorRelocationId(body.relocationId);
    const receipt = parseCommerceProviderReceipt(body.receipt);
    if (!relocationId.ok)
      return invalidActorRelocationAdminRequest("relocationId");
    if (!receipt.ok) return invalidActorRelocationAdminRequest("receipt");
    return {
      ok: true,
      value: {
        command: "reconcile_receipt",
        relocationId: relocationId.value,
        receipt: receipt.value,
      },
    };
  }
  if (command.value === "reconcile_mail_receipt") {
    if ("organisationId" in body || "target" in body)
      return invalidActorRelocationAdminRequest("receipt");
    const relocationId = parseActorRelocationId(body.relocationId);
    const receipt = parseRelocationMailReceipt(body.receipt);
    if (!relocationId.ok)
      return invalidActorRelocationAdminRequest("relocationId");
    if (!receipt.ok) return invalidActorRelocationAdminRequest("receipt");
    return {
      ok: true,
      value: {
        command: "reconcile_mail_receipt",
        relocationId: relocationId.value,
        receipt: receipt.value,
      },
    };
  }
  if ("receipt" in body) return invalidActorRelocationAdminRequest("receipt");
  if (command.value === "start") {
    if ("relocationId" in body) {
      return invalidActorRelocationAdminRequest("relocationId");
    }

    const organisationId = readOrganisationIdField(body);
    const target = parseOrganisationPlacementMoveTarget(body.target);

    if (!organisationId.ok) {
      return invalidActorRelocationAdminRequest("organisationId");
    }

    if (!target.ok) {
      return invalidActorRelocationAdminRequest(target.error.path);
    }

    return {
      ok: true,
      value: {
        command: command.value,
        organisationId: organisationId.value,
        target: target.value,
      },
    };
  }

  if (command.value === "resume" || command.value === "abandon") {
    if ("organisationId" in body || "target" in body) {
      return invalidActorRelocationAdminRequest(
        "organisationId" in body ? "organisationId" : "target",
      );
    }

    const relocationId = parseActorRelocationId(body.relocationId);

    return relocationId.ok
      ? {
          ok: true,
          value: {
            command: command.value,
            relocationId: relocationId.value,
          },
        }
      : invalidActorRelocationAdminRequest("relocationId");
  }

  return invalidActorRelocationAdminRequest("command");
}

function invalidActorRelocationAdminRequest(
  field: string,
): Result<never, ActorRelocationAdminRequestError> {
  return {
    ok: false,
    error: { code: "invalid_actor_relocation_request", field },
  };
}

function actorRelocationErrorResponse(error: ActorRelocationError): Response {
  switch (error.code) {
    case "relocation_receipt_rejected":
      return errorResponse(
        error.code,
        "The receipt does not match unresolved source work in this frozen relocation.",
        409,
      );
    case "relocation_provider_work_unresolved":
      return errorResponse(
        error.code,
        `Provider operation ${error.operationId} requires reconciliation before relocation.`,
        409,
      );
    case "placement_move_open":
      return errorResponse(
        error.code,
        `The open ${error.kind} ${error.operationId} holds the placement. Finish or abandon it first.`,
        409,
      );
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
    case "invalid_organisation_placement":
      return errorResponse(
        error.code,
        "Regional placement is unavailable.",
        503,
      );
    case "organisation_placement_missing":
    case "registry_entry_missing":
    case "relocation_missing":
    case "export_missing":
    case "referenced_r2_missing":
      return errorResponse(
        error.code,
        "Actor relocation state was not found.",
        404,
      );
    case "invalid_export_input":
    case "invalid_quarantine_reason":
      return errorResponse(
        error.code,
        "Actor relocation input is invalid.",
        422,
      );
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "actor_not_activated":
    case "actor_fence_mismatch":
    case "export_checksum_mismatch":
    case "referenced_r2_corrupt":
    case "target_not_empty":
    case "target_schema_incompatible":
    case "target_schema_older_than_export":
    case "import_conflict":
    case "relocation_conflict":
    case "relocation_inventory_changed":
    case "actor_activation_failed":
      return errorResponse(
        error.code,
        "Actor relocation conflicts with current state.",
        409,
      );
    case "regional_capacity_insufficient":
      return errorResponse(
        error.code,
        "The target database has insufficient relocation capacity.",
        409,
      );
    case "regional_capacity_unavailable":
      return errorResponse(
        error.code,
        "Target database capacity could not be verified.",
        503,
      );
    case "relocation_quarantined":
      return errorResponse(
        error.code,
        `Actor relocation was quarantined: ${error.reason}.`,
        409,
      );
    case "actor_cleanup_failed":
      return errorResponse(
        error.code,
        "Chat cleanup is unfinished. Retry relocation.",
        503,
      );
    case "organisation_placement_corrupt":
    case "registry_entry_corrupt":
    case "relocation_corrupt":
    case "unsupported_state_value":
    case "export_root_unavailable":
    case "export_root_invalid":
    case "export_manifest_corrupt":
    case "export_write_failed":
    case "export_read_failed":
      return errorResponse(
        error.code,
        "Actor relocation state is invalid.",
        500,
      );
    default:
      return assertNever(error);
  }
}

type ActorRestoreAdminRequest =
  | {
      readonly command: "prepare";
      readonly relocationId: ActorRelocationId;
      readonly manifest?: never;
      readonly target?: never;
      readonly restoreId?: never;
    }
  | {
      readonly command: "start";
      readonly manifest: ActorRestoreManifest;
      readonly target: OrganisationPlacementMoveTarget;
      readonly relocationId?: never;
      readonly restoreId?: never;
    }
  | {
      readonly command: "resume" | "abandon";
      readonly restoreId: ActorRestoreId;
      readonly relocationId?: never;
      readonly manifest?: never;
      readonly target?: never;
    };

type ActorRestoreAdminRequestError = {
  readonly code: "invalid_actor_restore_request";
  readonly field: string;
};

export async function handleAdministerActorRestore(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  if (request.method === "GET") {
    return inspectActorRestoreResponse(request, env);
  }

  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const input = await parseActorRestoreAdminRequest(body.value);

  if (!input.ok) {
    return errorResponse(
      input.error.code,
      `State-object restore field ${input.error.field} is invalid.`,
      422,
    );
  }

  const now = Date.now();

  switch (input.value.command) {
    case "prepare": {
      const prepared = await prepareActorRestoreManifest({
        env,
        relocationId: input.value.relocationId,
        now,
      });

      return prepared.ok
        ? jsonResponse({ ok: true, manifest: prepared.value })
        : actorRestoreErrorResponse(prepared.error);
    }
    case "start": {
      const started = await startActorRestore({
        env,
        manifest: input.value.manifest,
        target: input.value.target,
        now,
      });

      return started.ok
        ? jsonResponse({ ok: true, restore: started.value }, 202)
        : actorRestoreErrorResponse(started.error);
    }
    case "resume": {
      const resumed = await resumeActorRestore({
        env,
        restoreId: input.value.restoreId,
        now,
      });

      return resumed.ok
        ? jsonResponse({ ok: true, restore: resumed.value }, 202)
        : actorRestoreErrorResponse(resumed.error);
    }
    case "abandon": {
      const abandoned = await abandonActorRestore({
        env,
        restoreId: input.value.restoreId,
        now,
      });

      return abandoned.ok
        ? jsonResponse(
            {
              ok: true,
              restore: abandoned.value.restore,
              recovery: abandoned.value.recovery,
            },
            202,
          )
        : actorRestoreErrorResponse(abandoned.error);
    }
    default:
      return assertNever(input.value);
  }
}

async function inspectActorRestoreResponse(
  request: Request,
  env: Env,
): Promise<Response> {
  const restoreId = parseActorRestoreId(
    new URL(request.url).searchParams.get("restoreId"),
  );

  if (!restoreId.ok) {
    return errorResponse(
      "invalid_actor_restore_request",
      "State-object restore field restoreId is invalid.",
      422,
    );
  }

  const inspected = await inspectActorRestore({
    db: env.DB,
    restoreId: restoreId.value,
  });

  return inspected.ok
    ? jsonResponse({ ok: true, inspection: inspected.value })
    : actorRestoreErrorResponse(inspected.error);
}

async function parseActorRestoreAdminRequest(
  body: JsonObject,
): Promise<Result<ActorRestoreAdminRequest, ActorRestoreAdminRequestError>> {
  const command = readStringField(body, "command");

  if (!command.ok) {
    return invalidActorRestoreAdminRequest("command");
  }

  if (command.value === "prepare") {
    if ("manifest" in body || "target" in body || "restoreId" in body) {
      return invalidActorRestoreAdminRequest(
        "manifest" in body
          ? "manifest"
          : "target" in body
            ? "target"
            : "restoreId",
      );
    }

    const relocationId = parseActorRelocationId(body.relocationId);

    return relocationId.ok
      ? {
          ok: true,
          value: { command: command.value, relocationId: relocationId.value },
        }
      : invalidActorRestoreAdminRequest("relocationId");
  }

  if (command.value === "start") {
    if ("relocationId" in body || "restoreId" in body) {
      return invalidActorRestoreAdminRequest(
        "relocationId" in body ? "relocationId" : "restoreId",
      );
    }

    const manifest = await parseActorRestoreManifest(body.manifest);
    const target = parseOrganisationPlacementMoveTarget(body.target);

    if (!manifest.ok) {
      return invalidActorRestoreAdminRequest("manifest");
    }

    if (!target.ok) {
      return invalidActorRestoreAdminRequest(target.error.path);
    }

    return {
      ok: true,
      value: {
        command: command.value,
        manifest: manifest.value,
        target: target.value,
      },
    };
  }

  if (command.value === "resume" || command.value === "abandon") {
    if ("relocationId" in body || "manifest" in body || "target" in body) {
      return invalidActorRestoreAdminRequest(
        "relocationId" in body
          ? "relocationId"
          : "manifest" in body
            ? "manifest"
            : "target",
      );
    }

    const restoreId = parseActorRestoreId(body.restoreId);

    return restoreId.ok
      ? {
          ok: true,
          value: { command: command.value, restoreId: restoreId.value },
        }
      : invalidActorRestoreAdminRequest("restoreId");
  }

  return invalidActorRestoreAdminRequest("command");
}

function invalidActorRestoreAdminRequest(
  field: string,
): Result<never, ActorRestoreAdminRequestError> {
  return {
    ok: false,
    error: { code: "invalid_actor_restore_request", field },
  };
}

function actorRestoreErrorResponse(error: ActorRestoreError): Response {
  switch (error.code) {
    case "relocation_receipt_rejected":
      return errorResponse(
        error.code,
        "The receipt does not match unresolved source work in this frozen relocation.",
        409,
      );
    case "relocation_provider_work_unresolved":
      return errorResponse(
        error.code,
        `Provider operation ${error.operationId} requires reconciliation before relocation.`,
        409,
      );
    case "placement_move_open":
      return errorResponse(
        error.code,
        `The open ${error.kind} ${error.operationId} holds the placement. Finish or abandon it first.`,
        409,
      );
    case "organisation_placement_conflict":
    case "organisation_cell_unavailable":
    case "invalid_organisation_placement":
      return errorResponse(
        error.code,
        "Regional placement is unavailable.",
        503,
      );
    case "organisation_placement_missing":
    case "registry_entry_missing":
    case "relocation_missing":
    case "restore_missing":
    case "export_missing":
    case "referenced_r2_missing":
      return errorResponse(
        error.code,
        "State-object restore state was not found.",
        404,
      );
    case "invalid_export_input":
    case "invalid_quarantine_reason":
    case "invalid_restore_manifest":
      return errorResponse(
        error.code,
        "State-object restore input is invalid.",
        422,
      );
    case "organisation_placement_immutable":
    case "organisation_placement_move_conflict":
    case "registry_placement_conflict":
    case "registry_entry_conflict":
    case "registry_entry_not_activatable":
    case "registry_activation_conflict":
    case "registry_export_conflict":
    case "registry_retirement_conflict":
    case "registry_quarantine_conflict":
    case "actor_not_activated":
    case "actor_fence_mismatch":
    case "export_checksum_mismatch":
    case "referenced_r2_corrupt":
    case "target_not_empty":
    case "target_schema_incompatible":
    case "target_schema_older_than_export":
    case "import_conflict":
    case "relocation_conflict":
    case "relocation_inventory_changed":
    case "actor_activation_failed":
    case "restore_manifest_checksum_mismatch":
    case "restore_manifest_source_mismatch":
    case "restore_conflict":
    case "restore_target_not_clean":
    case "restore_inventory_changed":
      return errorResponse(
        error.code,
        "State-object restore conflicts with current state.",
        409,
      );
    case "regional_capacity_insufficient":
      return errorResponse(
        error.code,
        "The target database has insufficient relocation capacity.",
        409,
      );
    case "regional_capacity_unavailable":
      return errorResponse(
        error.code,
        "Target database capacity could not be verified.",
        503,
      );
    case "relocation_quarantined":
    case "restore_quarantined":
      return errorResponse(
        error.code,
        `State-object operation was quarantined: ${error.reason}.`,
        409,
      );
    case "organisation_placement_corrupt":
    case "registry_entry_corrupt":
    case "relocation_corrupt":
    case "restore_corrupt":
    case "unsupported_state_value":
    case "export_root_unavailable":
    case "export_root_invalid":
    case "export_manifest_corrupt":
    case "export_write_failed":
    case "export_read_failed":
      return errorResponse(
        error.code,
        "State-object restore state is invalid.",
        500,
      );
    case "actor_cleanup_failed":
      return errorResponse(
        error.code,
        "Chat cleanup is unfinished. Retry restore.",
        503,
      );
    default:
      return assertNever(error);
  }
}
