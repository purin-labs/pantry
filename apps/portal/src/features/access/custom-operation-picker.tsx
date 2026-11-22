import { Select } from "@purin-labs/ui/select";
import React from "react";
import { readCustomConnectorCatalog, readCustomConnectorDetail, type CustomConnectorDetail } from "../integrations/custom-connector-api";
import type { CustomConnectorSummary } from "@purin-labs/control-api/portal/custom-connectors";
import { isRecord } from "@purin-labs/std";

export type CustomConnectorAccessHandoff = Readonly<{
  connectorId: string;
  integrationAccountId: string;
  operationId: string | null;
}>;

export type CustomOperationSelection = Readonly<{
  connectorId: string;
  integrationAccountId: string;
  definitionRevision: number;
  definitionDigest: string;
  operationId: string;
  capabilityId: "custom_connector.read" | "custom_connector.write";
  label: string;
}>;

type AccountChoice = Readonly<{
  connectorId: string;
  integrationAccountId: string;
  label: string;
}>;
type CatalogState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; accounts: readonly AccountChoice[] }>;
type OperationState =
  | Readonly<{ kind: "empty" | "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      operations: readonly CustomOperationSelection[];
    }>;

type PickerProps = Readonly<{
  organisationId: string;
  capabilityId: "custom_connector.read" | "custom_connector.write";
  initial: CustomConnectorAccessHandoff | null;
  selection: CustomOperationSelection | null;
  change: (selection: CustomOperationSelection | null) => void;
}>;

export function CustomOperationPicker(props: PickerProps): React.ReactNode {
  const [catalog, setCatalog] = React.useState<CatalogState>({
    kind: "loading",
  });
  const [accountId, setAccountId] = React.useState(
    props.initial?.integrationAccountId ?? "",
  );
  const [operations, setOperations] = React.useState<OperationState>({
    kind: "empty",
  });
  React.useEffect(loadCatalog.bind(null, props.organisationId, setCatalog), [
    props.organisationId,
  ]);
  const account =
    catalog.kind === "ready"
      ? (catalog.accounts.find(matchesAccount.bind(null, accountId)) ?? null)
      : null;
  React.useEffect(loadOperations.bind(null, props, account, setOperations), [
    props.organisationId,
    props.capabilityId,
    account,
    props.change,
    props.initial?.connectorId,
    props.initial?.integrationAccountId,
    props.initial?.operationId,
  ]);
  if (catalog.kind === "loading")
    return <p role="status">Loading connector accounts…</p>;
  if (catalog.kind === "failed") return <p role="alert">{catalog.message}</p>;
  return (
    <div className="access35-dialog-steps">
      <div>
        <label htmlFor="custom-grant-account">3. Connector account</label>
        <Select.Root
          required
          items={catalog.accounts.map(accountItem)}
          value={accountId === "" ? null : accountId}
          onValueChange={chooseAccount.bind(null, setAccountId, props.change)}
        >
          <Select.Trigger id="custom-grant-account">
            <Select.Value placeholder="Select a connected account" />
          </Select.Trigger>
          <Select.Popup>{catalog.accounts.map(renderAccount)}</Select.Popup>
        </Select.Root>
      </div>
      {catalog.accounts.length === 0 ? (
        <p role="status">
          Connect and enable a custom connector account before granting access.
        </p>
      ) : null}
      {operations.kind === "loading" ? (
        <p role="status">Loading reviewed operations…</p>
      ) : null}
      {operations.kind === "failed" ? (
        <p role="alert">{operations.message}</p>
      ) : null}
      {operations.kind === "ready" ? (
        <div>
          <label htmlFor="custom-grant-operation">4. Operation</label>
          <Select.Root
            required
            items={operations.operations.map(operationItem)}
            value={props.selection?.operationId ?? null}
            onValueChange={chooseOperation.bind(
              null,
              operations.operations,
              props.change,
            )}
          >
            <Select.Trigger id="custom-grant-operation">
              <Select.Value placeholder="Select an operation" />
            </Select.Trigger>
            <Select.Popup>
              {operations.operations.map(renderOperation)}
            </Select.Popup>
          </Select.Root>
          {operations.operations.length === 0 ? (
            <p role="status">
              This account has no approved{" "}
              {props.capabilityId === "custom_connector.read"
                ? "read"
                : "write"}{" "}
              operations.
            </p>
          ) : null}
        </div>
      ) : null}
      {props.selection === null ? null : (
        <p className="access35-dialog-review">
          Access covers this operation on this account at version{" "}
          {props.selection.definitionRevision}.
          {props.capabilityId === "custom_connector.write"
            ? " Every write requires approval. The capability must also be enabled in Access policy."
            : " The capability must also be enabled in Access policy."}
        </p>
      )}
    </div>
  );
}

function loadCatalog(
  organisationId: string,
  setCatalog: React.Dispatch<React.SetStateAction<CatalogState>>,
): () => void {
  const controller = new AbortController();
  setCatalog({ kind: "loading" });
  void readCustomConnectorCatalog(organisationId).then(
    receiveCatalog.bind(null, controller.signal, setCatalog),
    failCatalog.bind(null, controller.signal, setCatalog),
  );
  return controller.abort.bind(controller);
}
function receiveCatalog(
  signal: AbortSignal,
  setCatalog: React.Dispatch<React.SetStateAction<CatalogState>>,
  catalog: readonly CustomConnectorSummary[],
): void {
  if (signal.aborted) return;
  const accounts: AccountChoice[] = [];
  for (const connector of catalog) {
    if (connector.lifecycle !== "active") continue;
    for (const account of connector.accounts) {
      if (account.lifecycle === "active")
        accounts.push({
          connectorId: connector.connectorId,
          integrationAccountId: account.integrationAccountId,
          label: `${account.displayName} · ${connector.name ?? "Custom connector"}`,
        });
    }
  }
  setCatalog({ kind: "ready", accounts });
}
function failCatalog(
  signal: AbortSignal,
  setCatalog: React.Dispatch<React.SetStateAction<CatalogState>>,
): void {
  if (!signal.aborted)
    setCatalog({
      kind: "failed",
      message:
        "Connector accounts could not be loaded. Close this dialog and try again.",
    });
}
function matchesAccount(id: string, account: AccountChoice): boolean {
  return account.integrationAccountId === id;
}
function accountItem(
  account: AccountChoice,
): Readonly<{ value: string; label: string }> {
  return { value: account.integrationAccountId, label: account.label };
}
function renderAccount(account: AccountChoice): React.ReactNode {
  return (
    <Select.Item
      key={account.integrationAccountId}
      value={account.integrationAccountId}
    >
      {account.label}
    </Select.Item>
  );
}
function operationItem(
  operation: CustomOperationSelection,
): Readonly<{ value: string; label: string }> {
  return {
    value: operation.operationId,
    label: `${operation.label} (${operation.operationId})`,
  };
}
function renderOperation(operation: CustomOperationSelection): React.ReactNode {
  return (
    <Select.Item key={operation.operationId} value={operation.operationId}>
      {operation.label} ({operation.operationId})
    </Select.Item>
  );
}
function chooseAccount(
  setAccountId: React.Dispatch<React.SetStateAction<string>>,
  change: PickerProps["change"],
  value: string | null,
): void {
  change(null);
  setAccountId(value ?? "");
}
function chooseOperation(
  operations: readonly CustomOperationSelection[],
  change: PickerProps["change"],
  value: string | null,
): void {
  change(operations.find(matchesOperation.bind(null, value ?? "")) ?? null);
}
function matchesOperation(
  id: string,
  operation: CustomOperationSelection,
): boolean {
  return operation.operationId === id;
}
function loadOperations(
  props: PickerProps,
  account: AccountChoice | null,
  setOperations: React.Dispatch<React.SetStateAction<OperationState>>,
): () => void {
  const controller = new AbortController();
  props.change(null);
  if (account === null) setOperations({ kind: "empty" });
  else {
    setOperations({ kind: "loading" });
    void readCustomConnectorDetail(
      props.organisationId,
      account.connectorId,
    ).then(
      receiveOperations.bind(
        null,
        controller.signal,
        props,
        account,
        setOperations,
      ),
      failOperations.bind(null, controller.signal, setOperations),
    );
  }
  return controller.abort.bind(controller);
}
function receiveOperations(
  signal: AbortSignal,
  props: PickerProps,
  account: AccountChoice,
  setOperations: React.Dispatch<React.SetStateAction<OperationState>>,
  detail: CustomConnectorDetail,
): void {
  if (signal.aborted) return;
  const operations = customOperationChoices(
    detail,
    account.integrationAccountId,
    props.capabilityId,
  );
  setOperations({ kind: "ready", operations });
  if (
    props.initial?.connectorId === account.connectorId &&
    props.initial.integrationAccountId === account.integrationAccountId &&
    props.initial.operationId !== null
  ) {
    props.change(
      operations.find(matchesOperation.bind(null, props.initial.operationId)) ??
        null,
    );
  }
}
function failOperations(
  signal: AbortSignal,
  setOperations: React.Dispatch<React.SetStateAction<OperationState>>,
): void {
  if (!signal.aborted)
    setOperations({
      kind: "failed",
      message:
        "Reviewed operations could not be loaded. Select the account again to retry.",
    });
}

function customOperationChoices(
  detail: CustomConnectorDetail,
  accountId: string,
  capabilityId: PickerProps["capabilityId"],
): readonly CustomOperationSelection[] {
  if (detail.summary.lifecycle !== "active") return [];
  const account = detail.accounts.find(matchesAccountId.bind(null, accountId));
  if (account === undefined || account.lifecycle !== "active") return [];
  const revision = detail.revisions.find(
    matchesRevision.bind(null, account.acceptedRevision),
  );
  if (
    revision === undefined ||
    revision.reviewState !== "approved" ||
    revision.definitionDigest === null ||
    revision.definition === null ||
    !Array.isArray(revision.definition.operations)
  )
    return [];
  const operations: CustomOperationSelection[] = [];
  for (const raw of revision.definition.operations) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.description !== "string" ||
      !isRecord(raw.effect)
    )
      continue;
    const operationCapability = operationCapabilityId(raw.effect.kind);
    if (operationCapability !== capabilityId) continue;
    operations.push({
      connectorId: detail.summary.connectorId,
      integrationAccountId: accountId,
      definitionRevision: revision.revision,
      definitionDigest: revision.definitionDigest,
      operationId: raw.id,
      capabilityId,
      label: raw.description,
    });
  }
  return operations;
}
function matchesAccountId(
  id: string,
  account: CustomConnectorDetail["accounts"][number],
): boolean {
  return account.integrationAccountId === id;
}
function matchesRevision(
  revision: number,
  entry: CustomConnectorDetail["revisions"][number],
): boolean {
  return entry.revision === revision;
}
export function readCustomConnectorAccessHandoff(
  search: string,
): CustomConnectorAccessHandoff | null {
  const query = new URLSearchParams(search);
  const connectorId = query.get("customConnector");
  const integrationAccountId = query.get("integrationAccount");
  const operationId = query.get("operationId");
  if (
    connectorId === null ||
    connectorId.length === 0 ||
    integrationAccountId === null ||
    integrationAccountId.length === 0
  )
    return null;
  return { connectorId, integrationAccountId, operationId };
}

function operationCapabilityId(
  effect: unknown,
): CustomOperationSelection["capabilityId"] | null {
  switch (effect) {
    case "read":
      return "custom_connector.read";
    case "external_record_create":
    case "external_record_update":
      return "custom_connector.write";
    default:
      return null;
  }
}
