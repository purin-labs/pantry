import { parseCaseScreenObservationsResponse } from "@purin-labs/control-api";
import { ControlApiError } from "../../control-client";
import {
  parseAiBudgetView,
  type AiBudgetLimits,
  type AiBudgetView,
} from "@purin-labs/control-api/portal/ai-budget";
import type {
  AccessControlView,
  AccessExplainResult,
  AccessMutationCommand,
  AccessResult,
  AccessOptionsPage,
  AccessRouteTransport,
} from "@purin-labs/control-api/portal/access-models";
import {
  parseAccessControlResponse,
  parseAccessExplanationResponse,
  parseAccessOptionsResponse,
} from "@purin-labs/control-api/portal/access-boundary";
import { parseDropboxResourcePage, parseGoogleDrivePickerConfig } from "@purin-labs/control-api/portal/file-resources";
import type { GoogleDrivePickedFile, GoogleDrivePickerConfig } from "@purin-labs/control-api/portal/access-models";
import { assertNever } from "@purin-labs/std";
import {
  parseCaseContextCollectionMetadataResponse,
  type CaseContextCollectionReviewCommand,
} from "@purin-labs/control-api";

type ControlRead = (path: string) => Promise<unknown>;
type ControlMutation = (
  path: string,
  method: "POST",
  body: unknown,
  expectedConfigurationVersion?: number,
) => Promise<unknown>;
type GoogleDrivePicker = (
  config: GoogleDrivePickerConfig,
) => Promise<GoogleDrivePickedFile | null>;

export function createAccessRouteTransport(
  read: ControlRead,
  mutate: ControlMutation,
  pickGoogleDrive: GoogleDrivePicker,
): AccessRouteTransport {
  return {
    readCaseContextCollections: readCaseContextCollections.bind(null, read),
    readCaseScreenObservations: readCaseScreenObservations.bind(null, read),
    reviewCaseContextCollection: reviewCaseContextCollection.bind(null, mutate),
    readBudget: readAiBudget.bind(null, read),
    saveBudget: saveAiBudget.bind(null, mutate),
    read: readAccessControl.bind(null, read),
    readOptions: readAccessOptions.bind(null, read),
    mutate: mutateAccessControl.bind(null, mutate),
    explain: explainAccessDecision.bind(null, mutate),
    discoverDropbox: discoverDropboxResources.bind(null, read),
    pickGoogleDrive: pickGoogleDriveResource.bind(null, read, pickGoogleDrive),
  };
}

async function readCaseContextCollections(
  read: ControlRead,
  organisationId: string,
  caseRef: string,
  revision: number,
) {
  const query = new URLSearchParams({
    case_ref: caseRef,
    revision: String(revision),
  });
  return parseCaseContextCollectionMetadataResponse(
    await read(
      `${caseContextCollectionPath(organisationId)}/inspector?${query}`,
    ),
  );
}

async function readCaseScreenObservations(
  read: ControlRead,
  organisationId: string,
  caseRef: string,
  revision: number,
) {
  const query = new URLSearchParams({
    case_ref: caseRef,
    revision: String(revision),
  });
  return parseCaseScreenObservationsResponse(
    await read(
      `${caseContextCollectionPath(organisationId)}/screen-observations?${query}`,
    ),
  );
}

async function reviewCaseContextCollection(
  mutate: ControlMutation,
  organisationId: string,
  caseContextCollectionId: string,
  revision: number,
  decision: Parameters<AccessRouteTransport["reviewCaseContextCollection"]>[3],
): Promise<void> {
  const command: CaseContextCollectionReviewCommand = {
    commandId: `review_${crypto.randomUUID()}`,
    expectedRevision: revision,
    decision,
  };
  await mutate(
    `${caseContextCollectionPath(organisationId)}/caseContextCollections/${encodeURIComponent(caseContextCollectionId)}/review`,
    "POST",
    command,
  );
}

function caseContextCollectionPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/case-context-discovery`;
}

async function readAiBudget(
  read: ControlRead,
  organisationId: string,
): Promise<AiBudgetView> {
  return parseAiBudgetView(
    await read(`${accessControlPath(organisationId)}/ai-budget`),
  );
}

async function saveAiBudget(
  mutate: ControlMutation,
  organisationId: string,
  revision: number,
  limits: AiBudgetLimits,
): Promise<void> {
  await mutate(`${accessControlPath(organisationId)}/ai-budget`, "POST", {
    expectedRevision: revision,
    limits,
  });
}

async function readAccessControl(
  read: ControlRead,
  organisationId: string,
  grantCursor: string | null,
  sourceCursor: string | null,
): Promise<AccessResult<AccessControlView>> {
  const query = new URLSearchParams();
  if (grantCursor !== null) query.set("grants_cursor", grantCursor);
  if (sourceCursor !== null) query.set("sources_cursor", sourceCursor);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  let raw: unknown;
  try {
    raw = await read(`${accessControlPath(organisationId)}${suffix}`);
  } catch (error) {
    return transportFailure(error);
  }
  return parseAccessControlResponse(raw);
}

async function readAccessOptions(
  read: ControlRead,
  organisationId: string,
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  queryText: string,
  cursor: string | null,
  integrationRef: string | null,
): Promise<AccessResult<AccessOptionsPage>> {
  const query = new URLSearchParams({ kind, query: queryText });
  if (cursor !== null) query.set("cursor", cursor);
  if (kind === "resources" && integrationRef !== null)
    query.set("integration_ref", integrationRef);
  let raw: unknown;
  try {
    raw = await read(
      `${accessControlPath(organisationId)}/options?${query.toString()}`,
    );
  } catch (error) {
    return transportFailure(error);
  }
  return parseAccessOptionsResponse(raw);
}

async function mutateAccessControl(
  mutate: ControlMutation,
  organisationId: string,
  command: AccessMutationCommand,
): Promise<AccessResult<void>> {
  const base = accessControlPath(organisationId);
  try {
    switch (command.kind) {
      case "create_grant":
        await mutate(`${base}/grants`, "POST", {
          expectedRevision: command.expectedRevision,
          subjectRef: command.subjectRef,
          target: command.target,
        });
        return { ok: true, value: undefined };
      case "revoke_grant":
        await mutate(
          `${base}/grants/${encodeURIComponent(command.grantId)}/revoke`,
          "POST",
          {
            expectedRevision: command.expectedRevision,
            grantRevision: command.grantRevision,
            reason: command.reason,
          },
        );
        return { ok: true, value: undefined };
      case "change_capability_mode":
        await mutate(
          `${base}/capabilities/${encodeURIComponent(command.capabilityId)}`,
          "POST",
          {
            expectedRevision: command.expectedRevision,
            capabilityRevision: command.capabilityRevision,
            capabilityVersion: command.capabilityVersion,
            mode: command.mode,
          },
        );
        return { ok: true, value: undefined };
      case "apply_defaults":
        await mutate(`${base}/defaults/apply`, "POST", {
          expectedRevision: command.expectedRevision,
        });
        return { ok: true, value: undefined };
      default:
        return assertNever(command, "Unhandled access mutation");
    }
  } catch (error) {
    return transportFailure(error);
  }
}

async function explainAccessDecision(
  mutate: ControlMutation,
  organisationId: string,
  question: Parameters<AccessRouteTransport["explain"]>[1],
): Promise<AccessResult<AccessExplainResult>> {
  let raw: unknown;
  try {
    raw = await mutate(
      `${accessControlPath(organisationId)}/explain`,
      "POST",
      question,
    );
  } catch (error) {
    return transportFailure(error);
  }
  return parseAccessExplanationResponse(raw);
}

function transportFailure(error: unknown): AccessResult<never> {
  if (error instanceof ControlApiError) {
    return {
      ok: false,
      error: {
        kind: "control",
        controlKind: error.kind,
        message: error.message,
      },
    };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: "Access control request failed. Try again.",
      },
    };
  }
  return {
    ok: false,
    error: {
      kind: "internal",
      message:
        "Access control request failed unexpectedly. Refresh the page and try again.",
    },
  };
}

async function discoverDropboxResources(
  read: ControlRead,
  organisationId: string,
  input: Parameters<AccessRouteTransport["discoverDropbox"]>[1],
) {
  const query = new URLSearchParams({ path: input.path, query: input.query });
  if (input.cursor !== null) query.set("cursor", input.cursor);
  return parseDropboxResourcePage(
    await read(
      `${accountPath(organisationId, input.integrationAccountId)}/file-resources?${query.toString()}`,
    ),
  );
}

async function pickGoogleDriveResource(
  read: ControlRead,
  pickGoogleDrive: GoogleDrivePicker,
  organisationId: string,
  integrationAccountId: string,
) {
  const config = parseGoogleDrivePickerConfig(
    await read(
      `${accountPath(organisationId, integrationAccountId)}/google-drive-picker-config`,
    ),
  );
  return pickGoogleDrive(config);
}

function accessControlPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/access-control`;
}

function accountPath(
  organisationId: string,
  integrationAccountId: string,
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(integrationAccountId)}`;
}
