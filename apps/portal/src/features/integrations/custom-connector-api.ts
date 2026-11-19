import { controlMutation, controlRead } from "../../control-client";
import { isRecord } from "@purin-labs/std";
import { type CustomConnectorAccountView, type CustomConnectorAction, type CustomConnectorMutationResult, type CustomConnectorRevisionView, type CustomConnectorSetupAttempt, type CustomConnectorSummary, parseAccount, parseAction, parseAttempt, parseMutationResult, parseRevision, parseSummary } from "@purin-labs/control-api/portal/custom-connectors";

export type CustomConnectorDetail = Readonly<{
  summary: CustomConnectorSummary;
  revisions: readonly CustomConnectorRevisionView[];
  accounts: readonly CustomConnectorAccountView[];
}>;

export async function readCustomConnectorCatalog(
  organisationId: string,
): Promise<readonly CustomConnectorSummary[]> {
  const raw = await controlRead(customConnectorCollectionPath(organisationId));
  if (!isRecord(raw) || raw.kind !== "custom_connector_catalog") {
    throw new Error("The server returned an invalid custom connector catalog.");
  }
  if (!Array.isArray(raw.items)) {
    throw new Error("The server returned an invalid custom connector catalog.");
  }
  const items: CustomConnectorSummary[] = [];
  for (const item of raw.items) items.push(parseSummary(item));
  return items;
}

export async function readCustomConnectorDetail(
  organisationId: string,
  connectorId: string,
): Promise<CustomConnectorDetail> {
  const raw = await controlRead(
    customConnectorPath(organisationId, connectorId),
  );
  if (
    !isRecord(raw) ||
    raw.kind !== "custom_connector_detail" ||
    !Array.isArray(raw.revisions) ||
    !Array.isArray(raw.accounts)
  ) {
    throw new Error("The server returned invalid custom connector details.");
  }
  const revisions: CustomConnectorRevisionView[] = [];
  for (const revision of raw.revisions) revisions.push(parseRevision(revision));
  const accounts: CustomConnectorAccountView[] = [];
  for (const account of raw.accounts) accounts.push(parseAccount(account));
  return {
    summary: parseSummary(raw.summary),
    revisions,
    accounts,
  };
}

export async function readCustomConnectorSetup(
  organisationId: string,
  connectorId: string,
  attemptId: string,
): Promise<CustomConnectorSetupAttempt> {
  const raw = await controlRead(
    customConnectorSetupPath(organisationId, connectorId, attemptId),
  );
  if (!isRecord(raw) || raw.kind !== "custom_connector_setup") {
    throw new Error("The server returned an invalid connector setup.");
  }
  return parseAttempt(raw.attempt);
}

export async function readCustomConnectorAction(
  organisationId: string,
  connectorId: string,
  actionNonce: string,
): Promise<CustomConnectorAction> {
  const raw = await controlRead(
    customConnectorActionPath(organisationId, connectorId, actionNonce),
  );
  if (!isRecord(raw) || raw.ok !== true) {
    throw new Error("The server returned an invalid custom connector action.");
  }
  return parseAction(raw.action);
}

export async function mutateCustomConnectorAction(
  path: string,
  body: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
): Promise<CustomConnectorAction> {
  const raw = await controlMutation(path, "POST", body, undefined, {
    kind: "prepared",
    idempotencyKey,
  });
  if (!isRecord(raw) || !isRecord(raw.action)) {
    throw new Error(
      "The server returned an invalid custom connector action update.",
    );
  }
  return parseAction(raw.action);
}

export async function mutateCustomConnector(
  path: string,
  method: "DELETE" | "POST",
  body: Readonly<Record<string, unknown>>,
  configurationVersion: number,
  idempotencyKey: string,
): Promise<CustomConnectorMutationResult> {
  const raw = await controlMutation(path, method, body, configurationVersion, {
    kind: "prepared",
    idempotencyKey,
  });
  return parseMutationResult(raw);
}

export function customConnectorCollectionPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/custom-connectors`;
}

export function customConnectorPath(
  organisationId: string,
  connectorId: string,
): string {
  return `${customConnectorCollectionPath(organisationId)}/${encodeURIComponent(connectorId)}`;
}

export type CustomConnectorRevisionAction =
  "approve" | "reject" | "retire" | "validate";

export function customConnectorRevisionPath(
  organisationId: string,
  connectorId: string,
  revision: number,
  action: CustomConnectorRevisionAction,
): string {
  return `${customConnectorPath(organisationId, connectorId)}/revisions/${revision}/${action}`;
}

export function customConnectorSetupCollectionPath(
  organisationId: string,
  connectorId: string,
): string {
  return `${customConnectorPath(organisationId, connectorId)}/setup-attempts`;
}

export function customConnectorSetupPath(
  organisationId: string,
  connectorId: string,
  attemptId: string,
): string {
  return `${customConnectorSetupCollectionPath(organisationId, connectorId)}/${encodeURIComponent(attemptId)}`;
}

export function customConnectorActionPath(
  organisationId: string,
  connectorId: string,
  actionNonce: string,
): string {
  return `${customConnectorPath(organisationId, connectorId)}/actions/${encodeURIComponent(actionNonce)}`;
}
