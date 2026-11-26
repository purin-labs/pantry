import { Button, ConfirmInPlace, DecisionButtons } from "@purin-labs/ui/index";
import {
  GOVERNED_ACTION_ALLOW,
  governedActionRefusal,
} from "@purin-labs/area-commerce-contract/ui/features/governed-actions/decision-labels";
import {
  PENDING_APPROVAL_MAX_AGE_MS,
  signInForApproval,
} from "@purin-labs/control/portal/approval-sign-in-popup";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { Select } from "@purin-labs/ui/select";
import React from "react";
import { MessageCircle, FileCode2 } from "lucide-react";
import { useNavigate } from "react-router";
import { ConnectionDialog } from "@purin-labs/area-integrations-contract/ui/features/integrations/connection-dialog";
import { ConnectorAuthoringAssistant } from "./connector-authoring";
import { CustomConnectorSetup } from "./custom-connector-connect";
import {
  customConnectorHref,
  mutationKey,
  readOperationReviews,
  refreshDetail,
  requireRevision,
  runPress,
  sendMutation,
  shownDefinition,
  validateStep,
  type ConnectorDetailProps,
  type Loadable,
  type MutationChain,
  type MutationKeys,
  type PressOwner,
} from "./custom-connector-press";
import {
  IntegrationsOverview,
  type IntegrationDirectoryContent,
} from "./overview";

import {
  customConnectorCollectionPath,
  customConnectorActionPath,
  customConnectorPath,
  customConnectorRevisionPath,
  mutateCustomConnectorAction,
  readCustomConnectorCatalog,
  readCustomConnectorAction,
  readCustomConnectorDetail,
  readCustomConnectorSetup,
  type CustomConnectorDetail,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/custom-connector-api";
import type {
  CustomConnectorAccountView,
  CustomConnectorAction,
  CustomConnectorWritePreview,
  CustomConnectorJsonValue,
  CustomConnectorRevisionView,
  CustomConnectorSetupAttempt,
  CustomConnectorSummary,
} from "@purin-labs/control-api/portal/custom-connectors";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, errorMessage, isRecord } from "@purin-labs/std";

const RECONCILIATION_OUTCOMES = [
  { value: "indeterminate", label: "I can’t confirm yet" },
  { value: "confirmed", label: "The provider confirms the change happened" },
  { value: "failed", label: "The provider confirms no change happened" },
];

export function CustomConnectorsWorkspace(props: {
  readonly organisationId: string;
  readonly configurationVersion: number;
  readonly canManage: boolean;
  readonly query: string;
  readonly basePath: string;
  readonly accessPath: string;
  readonly directory: IntegrationDirectoryContent;
  readonly presentation:
    | { readonly kind: "embedded" }
    | {
        readonly kind: "directory";
        readonly detail: React.ReactNode;
        readonly title: string | null;
        /** The provider mark of the open connection, above its title. */
        readonly tile: React.ReactNode;
        readonly description: string | null;
        readonly close: () => void;
      };
}): React.ReactNode {
  const navigate = useNavigate();
  const selection = readSelection();
  const [catalog, setCatalog] = React.useState<
    Loadable<readonly CustomConnectorSummary[]>
  >({ kind: "loading" });
  const [detail, setDetail] = React.useState<Loadable<CustomConnectorDetail>>({
    kind: "loading",
  });
  const [attempt, setAttempt] =
    React.useState<CustomConnectorSetupAttempt | null>(null);
  const [action, setAction] =
    React.useState<Loadable<CustomConnectorAction> | null>(
      selection.actionNonce === null ? null : { kind: "loading" },
    );
  const [configurationVersion, setConfigurationVersion] = React.useState(
    props.configurationVersion,
  );
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const mutationKeys = React.useRef(new Map<string, string>());
  React.useEffect(
    loadCatalogEffect.bind(null, props.organisationId, setCatalog),
    [props.organisationId],
  );
  React.useEffect(
    loadDetailEffect.bind(
      null,
      props.organisationId,
      selection.connectorId,
      selection.attemptId,
      selection.actionNonce,
      setDetail,
      setAttempt,
      setAction,
    ),
    [
      props.organisationId,
      selection.connectorId,
      selection.attemptId,
      selection.actionNonce,
    ],
  );
  React.useEffect(
    resumeCustomApprovalEffect.bind(null, {
      organisationId: props.organisationId,
      connectorId: selection.connectorId,
      actionNonce: selection.actionNonce,
      mutationKeys,
      setAction,
      setBusy,
      setFeedback,
    }),
    [props.organisationId, selection.connectorId, selection.actionNonce],
  );
  React.useEffect(
    syncConfigurationVersion.bind(
      null,
      props.configurationVersion,
      setConfigurationVersion,
    ),
    [props.configurationVersion],
  );

  let selectedContent: React.ReactNode = null;
  if (selection.connectorId === "new") {
    selectedContent = props.canManage ? (
      <CustomConnectorAuthoring
        key={props.organisationId}
        organisationId={props.organisationId}
        configurationVersion={configurationVersion}
        basePath={props.basePath}
        busy={busy}
        feedback={feedback}
        mutationKeys={mutationKeys}
        setBusy={setBusy}
        setFeedback={setFeedback}
        setConfigurationVersion={setConfigurationVersion}
      />
    ) : (
      <p role="alert">A workspace admin can add custom connectors.</p>
    );
  } else if (selection.connectorId !== null) {
    selectedContent = (
      <CustomConnectorDetailView
        navigate={navigate}
        organisationId={props.organisationId}
        configurationVersion={configurationVersion}
        canManage={props.canManage}
        basePath={props.basePath}
        accessPath={props.accessPath}
        detail={detail}
        attempt={attempt}
        action={action}
        busy={busy}
        feedback={feedback}
        mutationKeys={mutationKeys}
        setBusy={setBusy}
        setFeedback={setFeedback}
        setAttempt={setAttempt}
        setAction={setAction}
        setDetail={setDetail}
        setCatalog={setCatalog}
        setConfigurationVersion={setConfigurationVersion}
      />
    );
  }
  if (props.presentation.kind === "embedded") return selectedContent;
  const title =
    props.presentation.title ??
    (selection.connectorId === "new" ? "Connect another app" : "Another app");
  return (
    <>
      <IntegrationsOverview
        query={props.query}
        content={props.directory}
        customCatalog={catalog}
        basePath={props.basePath}
        canManage={props.canManage}
      />
      <ConnectionDialog
        open={
          props.presentation.title !== null || selection.connectorId !== null
        }
        title={title}
        tile={props.presentation.tile}
        description={props.presentation.description}
        close={props.presentation.close}
      >
        {props.presentation.detail ?? selectedContent}
      </ConnectionDialog>
    </>
  );
}

function CustomConnectorAuthoring(
  props: PressOwner &
    Readonly<{ basePath: string; busy: boolean; feedback: string | null }>,
): React.ReactNode {
  const [method, setMethod] = React.useState<"chat" | "import">("chat");
  const [source, setSource] = React.useState("");
  const [filename, setFilename] = React.useState<string | null>(null);
  return (
    <section
      className="custom-connector-editor"
      aria-label="Custom connector definition"
    >
      <div className="connector-method-tabs" aria-label="Connection method">
        <button
          type="button"
          aria-pressed={method === "chat"}
          onClick={setMethod.bind(null, "chat")}
        >
          <MessageCircle size={18} aria-hidden="true" />
          Build with AI
        </button>
        <button
          type="button"
          aria-pressed={method === "import"}
          onClick={setMethod.bind(null, "import")}
        >
          <FileCode2 size={18} aria-hidden="true" />
          Import JSON
        </button>
      </div>
      <div hidden={method !== "chat"}>
        <ConnectorAuthoringAssistant basePath={props.basePath} />
      </div>
      <div hidden={method !== "import"}>
        <form
          className="stacked-form custom-connector-definition-form"
          onSubmit={submitConnectorDraft.bind(null, props)}
        >
          <label htmlFor="custom-connector-import">Connector definition</label>
          <input
            id="custom-connector-import"
            type="file"
            accept=".json,application/json"
            onChange={importConnectorDefinition.bind(
              null,
              setSource,
              setFilename,
              props.setFeedback,
            )}
            aria-describedby="custom-connector-source-hint custom-connector-feedback"
          />
          {filename === null ? null : <p role="status">Loaded {filename}</p>}
          <label htmlFor="custom-connector-definition">Or paste the JSON</label>
          <textarea
            id="custom-connector-definition"
            name="definition"
            rows={8}
            spellCheck={false}
            placeholder="Paste the complete definition"
            value={source}
            onChange={changeDefinitionSource.bind(null, setSource)}
            aria-describedby="custom-connector-source-hint custom-connector-feedback"
            aria-invalid={props.feedback === null ? undefined : true}
          />
          <p id="custom-connector-source-hint" className="field-hint">
            Keep API keys out of the definition.
          </p>
          <MutationFeedback message={props.feedback} />
          <div className="connector-step-footer">
            <a href={props.basePath}>Cancel</a>
            <Button type="submit" variant="primary" disabled={props.busy}>
              {props.busy ? "Checking definition…" : "Review definition"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

async function importConnectorDefinition(
  setSource: React.Dispatch<React.SetStateAction<string>>,
  setFilename: React.Dispatch<React.SetStateAction<string | null>>,
  setFeedback: React.Dispatch<React.SetStateAction<string | null>>,
  event: React.ChangeEvent<HTMLInputElement>,
): Promise<void> {
  const file = event.currentTarget.files?.[0];
  if (file === undefined) return;
  if (file.size > 1_048_576) {
    setFeedback("Choose a JSON definition smaller than 1 MB.");
    return;
  }
  try {
    const source = await file.text();
    setSource(source);
    setFilename(file.name);
    setFeedback(null);
  } catch {
    setFeedback(
      "Unable to read this file. Choose it again or paste the JSON definition.",
    );
  }
}

function changeDefinitionSource(
  setSource: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLTextAreaElement>,
): void {
  setSource(event.currentTarget.value);
}

function CustomConnectorDetailView(
  props: ConnectorDetailProps,
): React.ReactNode {
  if (props.detail.kind === "loading") {
    return <p role="status">Loading custom connector…</p>;
  }
  if (props.detail.kind === "failed") {
    return (
      <section className="custom-connector-editor">
        <p role="alert">{props.detail.message}</p>
      </section>
    );
  }
  const head = props.detail.value.revisions[0];
  if (head === undefined) {
    return <p role="alert">This connector has no revision to review.</p>;
  }
  return (
    <section
      className="custom-connector-editor"
      aria-labelledby={
        props.action === null
          ? "custom-connector-detail-title"
          : "custom-connector-write-title"
      }
    >
      {props.action === null ? (
        <>
          <CustomConnectorReview detail={props.detail.value} head={head} />
          {props.canManage ? (
            <CustomConnectorSetup
              props={props}
              detail={props.detail.value}
              head={head}
            />
          ) : null}
          {props.canManage && props.attempt === null ? (
            <ConnectorManagement
              props={props}
              detail={props.detail.value}
              head={head}
            />
          ) : null}
        </>
      ) : (
        <CustomConnectorWriteReview props={props} action={props.action} />
      )}
      <MutationFeedback message={props.feedback} />
    </section>
  );
}

/** What the person approves: the destination and each operation. */
function CustomConnectorReview(props: {
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const definition = shownDefinition(props.head);
  const operations = readOperationReviews(definition);
  // The destination of the head revision, which an approval names.
  const origin =
    typeof definition.origin === "string"
      ? definition.origin
      : props.detail.summary.origin;
  return (
    <>
      <header className="custom-connector-review-heading">
        <div>
          <h3 id="custom-connector-detail-title">
            {props.detail.summary.name ?? "Untitled connector"}
          </h3>
          {props.detail.summary.description === null ? null : (
            <p>{props.detail.summary.description}</p>
          )}
        </div>
        <span className="custom-connector-state">
          {reviewStateLabel(props.head.reviewState)}
        </span>
      </header>
      <section
        className="connector-review-content"
        aria-label="Destination and operations"
      >
        {origin === null ? null : (
          <dl className="custom-connector-review-facts">
            <div>
              <dt>API destination</dt>
              <dd>{origin}</dd>
            </div>
          </dl>
        )}
        {operations.length === 0 ? null : (
          <div className="custom-connector-operations">
            <h4>What this connector can do</h4>
            <ul>{operations.map(renderOperationReview)}</ul>
          </div>
        )}
        {props.head.validationFailure === null ? null : (
          <p className="notice notice-danger" role="alert">
            {validationFailureMessage(props.head.validationFailure)}
          </p>
        )}
        {props.head.rejectionReason === null ? null : (
          <p className="notice notice-danger">
            Rejected: {props.head.rejectionReason}
          </p>
        )}
      </section>
    </>
  );
}

/**
 * Edit, retire, resume, disable and remove. The definition is technical, so
 * it stays behind one button. A definition that failed its check opens by
 * itself.
 */
function ConnectorManagement(input: {
  readonly props: ConnectorDetailProps;
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const [editing, setEditing] = React.useState(false);
  const { props, detail, head } = input;
  const connectorName = detail.summary.name ?? "this connector";
  const disabled = detail.summary.lifecycle === "disabled";
  const editorOpen = editing || head.validationFailure !== null;
  return (
    <>
      {editorOpen ? (
        <ConnectorRevisionEditor
          props={props}
          head={head}
          close={setEditing.bind(null, false)}
        />
      ) : null}
      <div className="custom-connector-actions">
        {editorOpen ? null : (
          <Button disabled={props.busy} onClick={setEditing.bind(null, true)}>
            Edit the definition
          </Button>
        )}
        {head.reviewState === "approved" ? (
          <ConfirmInPlace
            label="Retire revision…"
            question={`Retire version ${head.revision}?`}
            consequence="Agents stop using it. Its accounts need a newer reviewed version."
            confirmLabel="Retire revision"
            busy={props.busy}
            onConfirm={retireRevision.bind(null, props, head)}
          />
        ) : null}
        {disabled ? (
          <Button
            disabled={props.busy}
            onClick={runLifecycleAction.bind(null, props, "resume")}
          >
            Resume connector
          </Button>
        ) : null}
        {disabled ? (
          detail.accounts.length === 0 ? (
            <ConfirmInPlace
              label="Remove connector…"
              question={`Remove ${connectorName}?`}
              consequence="Its definition and revisions are deleted. To use this API again, add the connector again."
              confirmLabel="Remove connector"
              busy={props.busy}
              onConfirm={runLifecycleAction.bind(null, props, "remove")}
            />
          ) : null
        ) : (
          <ConfirmInPlace
            label="Disable connector…"
            question={`Disable ${connectorName}?`}
            consequence="Agents stop using it and its accounts at once. Resume it to use it again."
            confirmLabel="Disable connector"
            busy={props.busy}
            onConfirm={runLifecycleAction.bind(null, props, "disable")}
          />
        )}
      </div>
    </>
  );
}

function ConnectorRevisionEditor(input: {
  readonly props: ConnectorDetailProps;
  readonly head: CustomConnectorRevisionView;
  readonly close: () => void;
}): React.ReactNode {
  return (
    <div className="custom-connector-technical connector-revision-editor">
      <form
        className="stacked-form"
        onSubmit={submitConnectorRevision.bind(
          null,
          input.props,
          input.head,
          input.close,
        )}
      >
        <label htmlFor="custom-connector-revision-document">
          Definition JSON
        </label>
        <textarea
          id="custom-connector-revision-document"
          name="definition"
          rows={8}
          defaultValue={JSON.stringify(input.head.authoringDocument, null, 2)}
          key={input.head.revision}
          spellCheck={false}
          required
        />
        <div className="custom-connector-actions">
          <Button type="submit" variant="primary" disabled={input.props.busy}>
            {input.props.busy ? "Checking definition…" : "Save the definition"}
          </Button>
          {input.head.validationFailure === null ? (
            <Button onClick={input.close}>Cancel</Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function CustomConnectorWriteReview(input: {
  readonly props: ConnectorDetailProps;
  readonly action: Loadable<CustomConnectorAction>;
}): React.ReactNode {
  if (input.action.kind === "loading") {
    return <p role="status">Loading write approval…</p>;
  }
  if (input.action.kind === "failed") {
    return <p role="alert">{input.action.message}</p>;
  }
  const action = input.action.value;
  return (
    <section
      className="custom-connector-write-review"
      aria-labelledby="custom-connector-write-title"
    >
      <div className="custom-connector-setup-heading">
        <div>
          <h4 id="custom-connector-write-title">
            {action.preview.kind === "available"
              ? action.preview.operationLabel
              : "Review proposed action"}
          </h4>
          <p>
            {action.effect === "external_record_create"
              ? "Create a record in the connected account."
              : "Update the selected record in the connected account."}
          </p>
        </div>
        <span className="custom-connector-state">
          {actionStateLabel(action.state)}
        </span>
      </div>
      <dl className="custom-connector-review-facts">
        <div>
          <dt>Account</dt>
          <dd>
            {action.preview.kind === "available"
              ? action.preview.accountDisplayName
              : action.integrationAccountId}
          </dd>
        </div>
      </dl>
      <CustomConnectorWriteFields preview={action.preview} />
      {action.providerResult === null ? null : (
        <section className="connector-receipt" aria-label="Action receipt">
          <h4>
            {action.state === "confirmed"
              ? "Action confirmed"
              : "Action result"}
          </h4>
          <p>
            Recorded {new Date(action.updatedAt).toLocaleString()} · Reference{" "}
            {action.providerEffectId}
          </p>
          <div className="custom-connector-technical">
            <pre>{JSON.stringify(action.providerResult, null, 2)}</pre>
          </div>
        </section>
      )}
      {input.props.canManage &&
      (action.state === "proposed" ||
        action.state === "approval_requested" ||
        action.state === "signed") ? (
        <DecisionButtons
          className="custom-connector-actions"
          groupLabel="Decide on this write"
          disabled={input.props.busy}
          allow={
            action.state === "signed"
              ? {
                  label: GOVERNED_ACTION_ALLOW.apply,
                  onSelect: runCustomWriteExecution.bind(
                    null,
                    input.props,
                    action,
                  ),
                  // A write with no preview cannot be approved or applied,
                  // but the refusal needs no preview.
                  disabled: action.preview.kind === "unavailable",
                }
              : {
                  label: GOVERNED_ACTION_ALLOW.approve,
                  onSelect: approveAndApplyCustomWrite.bind(
                    null,
                    input.props,
                    action,
                  ),
                  disabled: action.preview.kind === "unavailable",
                }
          }
          refuse={
            action.state === "signed"
              ? null
              : governedActionRefusal({
                  onSelect: rejectCustomWrite.bind(null, input.props, action),
                })
          }
        />
      ) : null}
      {action.state === "indeterminate" ? (
        <div className="notice notice-warning">
          <strong>Outcome unknown</strong>
          {action.idempotencyHeader === null ? (
            <p>
              Check the provider’s records before recording an outcome. This
              action will stay unresolved until the provider outcome is
              confirmed.
            </p>
          ) : (
            <p>
              A retry sends the same key in the {action.idempotencyHeader}{" "}
              header. The service must apply one write for each key, as the
              reviewed definition states. You can also check the provider’s
              records and record the outcome.
            </p>
          )}
        </div>
      ) : null}
      {input.props.canManage &&
      action.state === "indeterminate" &&
      action.idempotencyHeader !== null ? (
        <div className="custom-connector-actions">
          <Button
            variant="primary"
            disabled={input.props.busy}
            onClick={retryCustomWriteExecution.bind(null, input.props, action)}
          >
            Retry with the same key
          </Button>
        </div>
      ) : null}
      {input.props.canManage && action.state === "indeterminate" ? (
        <form
          className="stacked-form custom-connector-reconciliation-form"
          onSubmit={submitCustomWriteReconciliation.bind(
            null,
            input.props,
            action,
          )}
        >
          <label htmlFor="custom-connector-reconciliation-outcome">
            Provider outcome
          </label>
          <Select.Root
            name="outcome"
            items={RECONCILIATION_OUTCOMES}
            defaultValue="indeterminate"
          >
            <Select.Trigger id="custom-connector-reconciliation-outcome">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {RECONCILIATION_OUTCOMES.map((outcome) => (
                <Select.Item key={outcome.value} value={outcome.value}>
                  {outcome.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
          <label htmlFor="custom-connector-reconciliation-evidence">
            Evidence or provider reference
          </label>
          <textarea
            id="custom-connector-reconciliation-evidence"
            name="evidence"
            rows={4}
            maxLength={2000}
            required
          />
          <Button type="submit" variant="primary" disabled={input.props.busy}>
            Save outcome
          </Button>
        </form>
      ) : null}
    </section>
  );
}

/**
 * Saves a new connector and checks its definition in the same press. A
 * definition that fails its check stays a draft that names the fault.
 */
async function submitConnectorDraft(
  props: Parameters<typeof CustomConnectorAuthoring>[0],
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const source = new FormData(event.currentTarget).get("definition");
  if (typeof source !== "string" || source.trim().length === 0) {
    props.setFeedback(
      "Import a definition JSON file or paste the complete definition.",
    );
    return;
  }
  const document = parseDefinitionSource(source, props.setFeedback);
  if (document === null) return;
  const saved: { connectorId: string | null } = { connectorId: null };
  await runPress(props, async (chain) => {
    const created = await sendMutation(chain, {
      path: customConnectorCollectionPath(props.organisationId),
      method: "POST",
      body: { document },
      intent: `custom-connector-create:${source}`,
    });
    saved.connectorId = created.connectorId;
    if (created.connectorId !== null)
      await validateSavedDraft(chain, created.connectorId, created);
    return "Saved.";
  });
  if (saved.connectorId !== null)
    window.location.assign(
      customConnectorHref(props.basePath, saved.connectorId, null),
    );
}

/** Saves an edit as a new revision and checks it in the same press. */
async function submitConnectorRevision(
  props: ConnectorDetailProps,
  head: CustomConnectorRevisionView,
  close: () => void,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (props.detail.kind !== "ready") return;
  const source = new FormData(event.currentTarget).get("definition");
  if (typeof source !== "string") return;
  const document = parseDefinitionSource(source, props.setFeedback);
  if (document === null) return;
  const connectorId = props.detail.value.summary.connectorId;
  const done = await runPress(props, async (chain) => {
    const created = await sendMutation(chain, {
      path: `${customConnectorPath(props.organisationId, connectorId)}/revisions`,
      method: "POST",
      body: { document, expectedHeadRevision: head.revision },
      intent: `custom-connector-revision-create:${connectorId}:${head.revision}:${source}`,
    });
    await validateSavedDraft(chain, connectorId, created);
    return "Saved.";
  });
  if (!done) return;
  close();
  await refreshDetail(props, connectorId);
}

/**
 * A refused check is not a failed save: Pantry records the fault on the
 * draft, and the drawer shows it. An approval checks a draft again first.
 */
async function validateSavedDraft(
  chain: MutationChain,
  connectorId: string,
  created: Parameters<typeof requireRevision>[0],
): Promise<void> {
  try {
    await sendMutation(
      chain,
      validateStep(
        chain.owner.organisationId,
        connectorId,
        requireRevision(created),
      ),
    );
  } catch {
    // The draft keeps its fault for the drawer.
  }
}

function parseDefinitionSource(
  source: string,
  setFeedback: (message: string) => void,
): Readonly<Record<string, unknown>> | null {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    setFeedback("Use valid JSON for the connector definition.");
    return null;
  }
  if (!isRecord(document)) {
    setFeedback("The connector definition must be a JSON object.");
    return null;
  }
  return document;
}

async function retireRevision(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
): Promise<void> {
  if (props.detail.kind !== "ready" || revision.definitionDigest === null)
    return;
  const detail = props.detail.value;
  const connectorId = detail.summary.connectorId;
  const definitionDigest = revision.definitionDigest;
  const done = await runPress(props, async (chain) => {
    await sendMutation(chain, {
      path: customConnectorRevisionPath(
        props.organisationId,
        connectorId,
        revision.revision,
        "retire",
      ),
      method: "POST",
      body: {
        definitionDigest,
        affectedIntegrationAccountIds: detail.accounts
          .filter(matchesAcceptedRevision.bind(null, revision.revision))
          .map(accountId),
      },
      intent: `custom-connector-revision:${connectorId}:${revision.revision}:retire`,
    });
    return "Revision retired.";
  });
  if (done) await refreshDetail(props, connectorId);
}

async function runLifecycleAction(
  props: ConnectorDetailProps,
  action: "disable" | "remove" | "resume",
): Promise<void> {
  if (props.detail.kind !== "ready") return;
  const summary = props.detail.value.summary;
  const path =
    action === "remove"
      ? customConnectorPath(props.organisationId, summary.connectorId)
      : `${customConnectorPath(props.organisationId, summary.connectorId)}/${action}`;
  const done = await runPress(props, async (chain) => {
    await sendMutation(chain, {
      path,
      method: action === "remove" ? "DELETE" : "POST",
      body: { expectedHeadRevision: summary.headRevision },
      intent: `custom-connector-lifecycle:${summary.connectorId}:${action}:${summary.headRevision}`,
    });
    return "Saved.";
  });
  if (!done) return;
  if (action === "remove") {
    void props.navigate(props.basePath, { preventScrollReset: true });
    return;
  }
  await refreshDetail(props, summary.connectorId);
}

function beginCustomApprovalStepUp(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
): void {
  const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  sessionStorage.setItem(
    "pantry:custom-connector-approval",
    JSON.stringify({
      organisationId: props.organisationId,
      connectorId: action.connectorId,
      actionNonce: action.nonce,
      returnPath,
      createdAt: Date.now(),
    }),
  );
  const query = new URLSearchParams({
    purpose: "approval",
    organisation: props.organisationId,
    action: action.nonce,
    returnTo: returnPath,
  });
  window.location.assign(`/v1/control/auth/google/start?${query.toString()}`);
}

/**
 * Approves a write and applies it in one click, as for a commerce action
 * (Refactor 17, step A2.1). The step-up sign-in opens in a small window and
 * this page stays. A browser that blocks the window signs in on the page
 * instead, and the page applies the write when it comes back.
 */
async function approveAndApplyCustomWrite(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
): Promise<void> {
  // Busy before the sign-in, so that a second click cannot start a second
  // flow while the sign-in window is open.
  props.setBusy(true);
  props.setFeedback(null);
  try {
    const signIn = await signInForApproval(props.organisationId, action.nonce);
    if (signIn === "blocked") {
      beginCustomApprovalStepUp(props, action);
      return;
    }
    const approved = await sendCustomWriteAction(props, action, "approval", {});
    props.setAction({ kind: "ready", value: approved });
    const applied = await sendCustomWriteAction(props, approved, "execute", {});
    props.setAction({ kind: "ready", value: applied });
    props.setFeedback(customWriteFeedback(applied));
  } catch (error) {
    props.setFeedback(
      error instanceof ControlApiError &&
        error.kind === "approval_step_up_required"
        ? "The sign-in did not finish, so nothing changed. Try again."
        : errorMessage(error, "The write could not be approved. Try again."),
    );
  } finally {
    props.setBusy(false);
  }
}

async function rejectCustomWrite(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "rejection", {
    reason: "merchant_declined",
  });
}

async function runCustomWriteExecution(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "execute", {});
}

async function retryCustomWriteExecution(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "retry", {});
}

async function submitCustomWriteReconciliation(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const outcome = form.get("outcome");
  const evidence = form.get("evidence");
  if (
    (outcome !== "confirmed" &&
      outcome !== "failed" &&
      outcome !== "indeterminate") ||
    typeof evidence !== "string" ||
    evidence.trim().length === 0
  ) {
    props.setFeedback("Choose an outcome and enter the provider evidence.");
    return;
  }
  await updateCustomWriteAction(props, action, "reconcile", {
    expectedState: "indeterminate",
    outcome,
    evidence: evidence.trim(),
    providerEffectId: action.providerEffectId,
    definitionDigest: action.definitionDigest,
  });
}

type CustomWriteOperation =
  "approval" | "rejection" | "execute" | "retry" | "reconcile";

/** Sends one operation of a write, with one mutation key for each intent. */
async function sendCustomWriteAction(
  owner: Readonly<{ organisationId: string; mutationKeys: MutationKeys }>,
  action: Readonly<{ connectorId: string; nonce: string }>,
  operation: CustomWriteOperation,
  body: Readonly<Record<string, unknown>>,
): Promise<CustomConnectorAction> {
  const intent = `custom-connector-action:${action.nonce}:${operation}`;
  const key = mutationKey(owner.mutationKeys.current, intent);
  const next = await mutateCustomConnectorAction(
    `${customConnectorActionPath(
      owner.organisationId,
      action.connectorId,
      action.nonce,
    )}/${operation}`,
    body,
    key,
  );
  owner.mutationKeys.current.delete(intent);
  return next;
}

function customWriteFeedback(next: CustomConnectorAction): string {
  if (next.state !== "indeterminate") return "Action updated.";
  return next.idempotencyHeader === null
    ? "The provider outcome is uncertain. Reconcile it before any retry."
    : "The provider outcome is uncertain. Retry with the same key, or reconcile it.";
}

async function updateCustomWriteAction(
  props: ConnectorDetailProps,
  action: CustomConnectorAction,
  operation: CustomWriteOperation,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  props.setBusy(true);
  props.setFeedback(null);
  try {
    const next = await sendCustomWriteAction(props, action, operation, body);
    props.setAction({ kind: "ready", value: next });
    props.setFeedback(customWriteFeedback(next));
  } catch (error) {
    props.setFeedback(
      errorMessage(error, "Unable to load custom connectors. Try again."),
    );
  } finally {
    props.setBusy(false);
  }
}

function resumeCustomApprovalEffect(input: {
  readonly organisationId: string;
  readonly connectorId: string | null;
  readonly actionNonce: string | null;
  readonly mutationKeys: MutationKeys;
  readonly setAction: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorAction> | null>
  >;
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
}): () => void {
  if (input.connectorId === null || input.actionNonce === null) return noop;
  const pending = readPendingCustomApproval();
  if (
    pending === null ||
    pending.organisationId !== input.organisationId ||
    pending.connectorId !== input.connectorId ||
    pending.actionNonce !== input.actionNonce ||
    pending.returnPath !==
      `${window.location.pathname}${window.location.search}${window.location.hash}`
  ) {
    return noop;
  }
  sessionStorage.removeItem("pantry:custom-connector-approval");
  const props = {
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    actionNonce: input.actionNonce,
    mutationKeys: input.mutationKeys,
    setAction: input.setAction,
    setBusy: input.setBusy,
    setFeedback: input.setFeedback,
  };
  void resumeCustomApproval(props);
  return noop;
}

async function resumeCustomApproval(input: {
  readonly organisationId: string;
  readonly connectorId: string;
  readonly actionNonce: string;
  readonly mutationKeys: MutationKeys;
  readonly setAction: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorAction> | null>
  >;
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
}): Promise<void> {
  input.setBusy(true);
  try {
    // The person chose "Approve and apply" before the sign-in page.
    const write = { connectorId: input.connectorId, nonce: input.actionNonce };
    const approved = await sendCustomWriteAction(input, write, "approval", {});
    input.setAction({ kind: "ready", value: approved });
    const applied = await sendCustomWriteAction(input, approved, "execute", {});
    input.setAction({ kind: "ready", value: applied });
    input.setFeedback(customWriteFeedback(applied));
  } catch (error) {
    input.setFeedback(
      errorMessage(error, "Unable to load custom connectors. Try again."),
    );
  } finally {
    input.setBusy(false);
  }
}

function readPendingCustomApproval(): {
  readonly organisationId: string;
  readonly connectorId: string;
  readonly actionNonce: string;
  readonly returnPath: string;
} | null {
  try {
    const raw = sessionStorage.getItem("pantry:custom-connector-approval");
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.organisationId === "string" &&
      typeof value.connectorId === "string" &&
      typeof value.actionNonce === "string" &&
      typeof value.returnPath === "string" &&
      typeof value.createdAt === "number" &&
      Number.isSafeInteger(value.createdAt) &&
      Date.now() - value.createdAt <= PENDING_APPROVAL_MAX_AGE_MS
    ) {
      return {
        organisationId: value.organisationId,
        connectorId: value.connectorId,
        actionNonce: value.actionNonce,
        returnPath: value.returnPath,
      };
    }
    // An old or damaged entry never approves: remove it.
    sessionStorage.removeItem("pantry:custom-connector-approval");
    return null;
  } catch {
    return null;
  }
}

function noop(): void {}

function loadCatalogEffect(
  organisationId: string,
  setCatalog: React.Dispatch<
    React.SetStateAction<Loadable<readonly CustomConnectorSummary[]>>
  >,
): () => void {
  let active = true;
  void readCustomConnectorCatalog(organisationId).then(
    applyCatalogResult.bind(null, setCatalog, () => active),
    applyCatalogFailure.bind(null, setCatalog, () => active),
  );
  return deactivate.bind(null, () => {
    active = false;
  });
}

function loadDetailEffect(
  organisationId: string,
  connectorId: string | null,
  attemptId: string | null,
  actionNonce: string | null,
  setDetail: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorDetail>>
  >,
  setAttempt: React.Dispatch<
    React.SetStateAction<CustomConnectorSetupAttempt | null>
  >,
  setAction: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorAction> | null>
  >,
): () => void {
  let active = true;
  if (connectorId === null || connectorId === "new") {
    return deactivate.bind(null, () => {
      active = false;
    });
  }
  setDetail({ kind: "loading" });
  const detail = readCustomConnectorDetail(organisationId, connectorId);
  const setup =
    attemptId === null
      ? Promise.resolve(null)
      : readCustomConnectorSetup(organisationId, connectorId, attemptId);
  const action =
    actionNonce === null
      ? Promise.resolve(null)
      : readCustomConnectorAction(organisationId, connectorId, actionNonce);
  void Promise.all([detail, setup, action]).then(
    applyDetailResult.bind(
      null,
      setDetail,
      setAttempt,
      setAction,
      () => active,
    ),
    applyDetailFailure.bind(null, setDetail, () => active),
  );
  return deactivate.bind(null, () => {
    active = false;
  });
}

function applyCatalogResult(
  setCatalog: React.Dispatch<
    React.SetStateAction<Loadable<readonly CustomConnectorSummary[]>>
  >,
  active: () => boolean,
  value: readonly CustomConnectorSummary[],
): void {
  if (active()) setCatalog({ kind: "ready", value });
}

function applyCatalogFailure(
  setCatalog: React.Dispatch<
    React.SetStateAction<Loadable<readonly CustomConnectorSummary[]>>
  >,
  active: () => boolean,
  error: unknown,
): void {
  if (active())
    setCatalog({
      kind: "failed",
      message: errorMessage(
        error,
        "Unable to load custom connectors. Try again.",
      ),
    });
}

function applyDetailResult(
  setDetail: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorDetail>>
  >,
  setAttempt: React.Dispatch<
    React.SetStateAction<CustomConnectorSetupAttempt | null>
  >,
  setAction: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorAction> | null>
  >,
  active: () => boolean,
  value: readonly [
    CustomConnectorDetail,
    CustomConnectorSetupAttempt | null,
    CustomConnectorAction | null,
  ],
): void {
  if (!active()) return;
  setDetail({ kind: "ready", value: value[0] });
  setAttempt(value[1]);
  setAction(value[2] === null ? null : { kind: "ready", value: value[2] });
}

function applyDetailFailure(
  setDetail: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorDetail>>
  >,
  active: () => boolean,
  error: unknown,
): void {
  if (active())
    setDetail({
      kind: "failed",
      message: errorMessage(
        error,
        "Unable to load custom connectors. Try again.",
      ),
    });
}

function deactivate(setInactive: () => void): void {
  setInactive();
}

function syncConfigurationVersion(
  value: number,
  setValue: React.Dispatch<React.SetStateAction<number>>,
): void {
  setValue(value);
}

function readSelection(): {
  readonly connectorId: string | null;
  readonly attemptId: string | null;
  readonly actionNonce: string | null;
} {
  if (typeof window === "undefined") {
    return { connectorId: null, attemptId: null, actionNonce: null };
  }
  const parameters = new URLSearchParams(window.location.search);
  return {
    connectorId: parameters.get("customConnector"),
    attemptId: parameters.get("setupAttempt"),
    actionNonce: parameters.get("customAction"),
  };
}

function renderOperationReview(operation: {
  readonly id: string;
  readonly description: string;
  readonly effect: "read" | "external_record_create" | "external_record_update";
  readonly idempotencyHeader: string | null;
}): React.ReactNode {
  return (
    <li key={operation.id}>
      <strong>{operation.description}</strong>
      <span>
        {effectLabel(operation.effect)}
        {operation.idempotencyHeader === null
          ? null
          : ` · can retry with a key in ${operation.idempotencyHeader}`}
      </span>
    </li>
  );
}

function accountId(account: CustomConnectorAccountView): string {
  return account.integrationAccountId;
}

function matchesAcceptedRevision(
  revision: number,
  account: CustomConnectorAccountView,
): boolean {
  return account.acceptedRevision === revision;
}

function effectLabel(
  effect: "read" | "external_record_create" | "external_record_update",
): string {
  switch (effect) {
    case "read":
      return "Reads data";
    case "external_record_create":
      return "Creates records after approval";
    case "external_record_update":
      return "Updates records after approval";
    default:
      return assertNever(effect, "Unexpected custom connector state");
  }
}

function reviewStateLabel(
  state: CustomConnectorSummary["reviewState"],
): string {
  switch (state) {
    case "draft":
      return "Draft";
    case "validated":
      return "Ready for review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "retired":
      return "Retired";
    default:
      return assertNever(state, "Unexpected custom connector state");
  }
}

function actionStateLabel(state: CustomConnectorAction["state"]): string {
  switch (state) {
    case "proposed":
    case "approval_requested":
      return "Approval needed";
    case "signed":
      return "Approved · ready to run";
    case "executing":
      return "Running action";
    case "confirmed":
      return "Confirmed";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Approval expired";
    case "indeterminate":
      return "Outcome unknown";
    default:
      return assertNever(state, "Unexpected custom connector state");
  }
}

function validationFailureMessage(
  failure: Readonly<Record<string, unknown>>,
): string {
  const field =
    typeof failure.field === "string" ? failure.field : "definition";
  const reason =
    typeof failure.reason === "string"
      ? failure.reason
      : "Review the definition and try again.";
  return `${field}: ${reason}`;
}

function MutationFeedback(props: {
  readonly message: string | null;
}): React.ReactNode {
  return (
    <p
      id="custom-connector-feedback"
      className="custom-connector-feedback"
      role="status"
    >
      {props.message ?? ""}
    </p>
  );
}

export function CustomConnectorWriteFields(props: {
  readonly preview: CustomConnectorWritePreview;
}): React.ReactNode {
  if (props.preview.kind === "unavailable") {
    return (
      <p className="notice notice-warning" role="alert">
        {writePreviewUnavailableCopy(props.preview.reason)}
      </p>
    );
  }
  return (
    <section
      className="connector-write-fields"
      aria-labelledby="connector-write-fields-title"
    >
      <h4 id="connector-write-fields-title">What will be sent</h4>
      <p>
        {props.preview.method} {props.preview.origin}
        {props.preview.path}
      </p>
      <dl>{props.preview.fields.map(renderWriteField)}</dl>
      {props.preview.fields.length === 0 ? (
        <p>This request has no query or body fields.</p>
      ) : null}
    </section>
  );
}

function writePreviewUnavailableCopy(
  reason: Variant<CustomConnectorWritePreview, "unavailable">["reason"],
): string {
  switch (reason) {
    case "permission_required":
      return "A workspace admin can review the request values and approve this action.";
    case "definition_unavailable":
      return "The reviewed definition is unavailable. Refresh the connector before approving this action.";
    case "input_invalid":
      return "The proposed request could not be verified. Ask for a new proposal before approving.";
    default:
      return assertNever(reason, "Unexpected custom connector state");
  }
}

function renderWriteField(field: {
  readonly path: string;
  readonly value: CustomConnectorJsonValue;
}): React.ReactNode {
  return (
    <div key={field.path}>
      <dt>{field.path}</dt>
      <dd>
        {typeof field.value === "object" && field.value !== null ? (
          <pre>{JSON.stringify(field.value, null, 2)}</pre>
        ) : (
          <span>{displayWriteValue(field.value)}</span>
        )}
      </dd>
    </div>
  );
}

function displayWriteValue(value: CustomConnectorJsonValue): string {
  if (value === "") return '""';
  if (value === null) return "null";
  return String(value);
}
