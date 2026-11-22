import { DecisionButtons } from "@purin-labs/ui/index";
import {
  GOVERNED_ACTION_ALLOW,
  governedActionRefusal,
} from "@purin-labs/area-commerce/ui/features/governed-actions/decision-labels";
import {
  PENDING_APPROVAL_MAX_AGE_MS,
  signInForApproval,
} from "@purin-labs/control/portal/approval-sign-in-popup";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { Select } from "@purin-labs/ui/select";
import React from "react";
import { MessageCircle, FileCode2 } from "lucide-react";
import { useNavigate, type NavigateFunction } from "react-router";
import { ConnectionDialog } from "./connection-dialog";
import { ConnectorAuthoringAssistant } from "./connector-authoring";
import {
  IntegrationsOverview,
  type IntegrationDirectoryContent,
} from "./overview";

import { customConnectorCollectionPath, customConnectorActionPath, customConnectorPath, customConnectorRevisionPath, customConnectorSetupCollectionPath, customConnectorSetupPath, mutateCustomConnector, mutateCustomConnectorAction, readCustomConnectorCatalog, readCustomConnectorAction, readCustomConnectorDetail, readCustomConnectorSetup, type CustomConnectorDetail, type CustomConnectorRevisionAction } from "./custom-connector-api";
import type { CustomConnectorAccountView, CustomConnectorAction, CustomConnectorWritePreview, CustomConnectorJsonValue, CustomConnectorMutationResult, CustomConnectorRevisionView, CustomConnectorSetupAttempt, CustomConnectorSummary } from "@purin-labs/control-api/portal/custom-connectors";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, errorMessage, isRecord } from "@purin-labs/std";

type Loadable<Value> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: Value }
  | { readonly kind: "failed"; readonly message: string };

type MutationKeys = React.MutableRefObject<Map<string, string>>;

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
        navigate={navigate}
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
    (selection.connectorId === "new"
      ? "Connect another app"
      : "Another app");
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

function CustomConnectorAuthoring(props: {
  readonly navigate: NavigateFunction;
  readonly organisationId: string;
  readonly configurationVersion: number;
  readonly basePath: string;
  readonly busy: boolean;
  readonly feedback: string | null;
  readonly mutationKeys: MutationKeys;
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setConfigurationVersion: React.Dispatch<
    React.SetStateAction<number>
  >;
}): React.ReactNode {
  const [method, setMethod] = React.useState<"chat" | "import">("chat");
  const [source, setSource] = React.useState("");
  const [filename, setFilename] = React.useState<string | null>(null);
  return (
    <section
      className="custom-connector-editor"
      aria-label="Custom connector definition"
    >
      <p className="connector-modal-description">
        Connect an app that isn’t on the list.
      </p>
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
            placeholder="Paste your complete definition here"
            value={source}
            onChange={changeDefinitionSource.bind(null, setSource)}
            aria-describedby="custom-connector-source-hint custom-connector-feedback"
            aria-invalid={props.feedback === null ? undefined : true}
          />
          <p id="custom-connector-source-hint" className="field-hint">
            Keep API keys separate. You’ll add a key after reviewing the
            destination and operations.
          </p>
          <MutationFeedback message={props.feedback} />
          <div className="connector-step-footer">
            <a href={props.basePath}>Cancel</a>
            <button type="submit" disabled={props.busy}>
              {props.busy ? "Saving definition…" : "Review definition"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

type ConnectorSetupStep =
  "definition" | "review" | "connect" | "test" | "access";

function ConnectorSetupSteps(props: {
  readonly current: ConnectorSetupStep;
}): React.ReactNode {
  const steps: readonly {
    readonly id: ConnectorSetupStep;
    readonly label: string;
  }[] = [
    { id: "definition", label: "Definition" },
    { id: "review", label: "Review" },
    { id: "connect", label: "Connect" },
    { id: "test", label: "Test" },
    { id: "access", label: "Access" },
  ];
  return (
    <ol className="connector-setup-steps" aria-label="Connector setup progress">
      {steps.map(renderSetupStep.bind(null, props.current))}
    </ol>
  );
}

function renderSetupStep(
  current: ConnectorSetupStep,
  step: { readonly id: ConnectorSetupStep; readonly label: string },
  index: number,
): React.ReactNode {
  return (
    <li key={step.id} aria-current={current === step.id ? "step" : undefined}>
      <span>{index + 1}</span>
      {step.label}
    </li>
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

function CustomConnectorDetailView(props: {
  readonly navigate: NavigateFunction;
  readonly organisationId: string;
  readonly configurationVersion: number;
  readonly canManage: boolean;
  readonly basePath: string;
  readonly accessPath: string;
  readonly detail: Loadable<CustomConnectorDetail>;
  readonly attempt: CustomConnectorSetupAttempt | null;
  readonly action: Loadable<CustomConnectorAction> | null;
  readonly busy: boolean;
  readonly feedback: string | null;
  readonly mutationKeys: MutationKeys;
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setAttempt: React.Dispatch<
    React.SetStateAction<CustomConnectorSetupAttempt | null>
  >;
  readonly setAction: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorAction> | null>
  >;
  readonly setDetail: React.Dispatch<
    React.SetStateAction<Loadable<CustomConnectorDetail>>
  >;
  readonly setCatalog: React.Dispatch<
    React.SetStateAction<Loadable<readonly CustomConnectorSummary[]>>
  >;
  readonly setConfigurationVersion: React.Dispatch<
    React.SetStateAction<number>
  >;
}): React.ReactNode {
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
        <ConnectorSetupSteps
          current={currentSetupStep(
            head,
            props.attempt,
            props.detail.value.accounts.length,
          )}
        />
      ) : null}
      {props.action === null ? (
        <CustomConnectorReview
          detail={props.detail.value}
          head={head}
          canManage={props.canManage}
          busy={props.busy}
          runRevisionAction={runRevisionAction.bind(null, props, head)}
          rejectRevision={runRevisionAction.bind(null, props, head, "reject")}
          runLifecycleAction={runLifecycleAction.bind(null, props)}
        />
      ) : null}
      {props.canManage && props.attempt === null && props.action === null ? (
        <ConnectorRevisionEditor props={props} head={head} />
      ) : null}
      {props.action === null ? null : (
        <CustomConnectorWriteReview props={props} action={props.action} />
      )}
      {props.canManage && props.action === null ? (
        <CustomConnectorSetup
          props={props}
          detail={props.detail.value}
          head={head}
        />
      ) : null}
      <MutationFeedback message={props.feedback} />
    </section>
  );
}

function CustomConnectorReview(props: {
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly runRevisionAction: (
    action: Exclude<CustomConnectorRevisionAction, "reject">,
  ) => void;
  readonly rejectRevision: (reason: string) => void;
  readonly runLifecycleAction: (
    action: "disable" | "remove" | "resume",
  ) => void;
}): React.ReactNode {
  const definition = props.head.definition ?? props.head.authoringDocument;
  const operations = readOperationReviews(definition);
  return (
    <>
      <header className="custom-connector-review-heading">
        <div>
          <p className="eyebrow">Custom connector</p>
          <h3 id="custom-connector-detail-title">
            {props.detail.summary.name ?? "Untitled connector"}
          </h3>
          <p>
            {props.detail.summary.description ??
              "Review this draft before connecting an account."}
          </p>
        </div>
        <span className="custom-connector-state">
          {reviewStateLabel(props.head.reviewState)}
        </span>
      </header>
      <section
        className="connector-review-content"
        aria-label="Destination and operations"
      >
        <dl className="custom-connector-review-facts">
          <div>
            <dt>API destination</dt>
            <dd>{props.detail.summary.origin ?? "Waiting for validation"}</dd>
          </div>
          <div>
            <dt>Connected accounts</dt>
            <dd>{props.detail.accounts.length}</dd>
          </div>
        </dl>
        <div className="custom-connector-operations">
          <h4>What this connector can do</h4>
          {operations.length === 0 ? (
            <p>Validate the draft to see its operations.</p>
          ) : (
            <ul>{operations.map(renderOperationReview)}</ul>
          )}
        </div>
        {props.head.validationFailure === null ? null : (
          <p className="notice notice-danger" role="alert">
            {validationFailureMessage(props.head.validationFailure)}
          </p>
        )}
        {props.head.rejectionReason === null ? null : (
          <p className="notice notice-danger">
            Rejected: {props.head.rejectionReason}. Edit the definition to send
            a new revision for review.
          </p>
        )}
      </section>
      {props.canManage ? (
        <div className="custom-connector-actions">
          {props.head.reviewState === "draft" ? (
            <button
              type="button"
              disabled={props.busy}
              className="connector-primary-action"
              onClick={props.runRevisionAction.bind(null, "validate")}
            >
              Validate definition
            </button>
          ) : null}
          {props.head.reviewState === "validated" ? (
            <button
              type="button"
              disabled={props.busy}
              className="connector-primary-action"
              onClick={props.runRevisionAction.bind(null, "approve")}
            >
              Approve connector access
            </button>
          ) : null}
          {props.head.reviewState === "validated" ? (
            <RejectRevisionForm
              busy={props.busy}
              reject={props.rejectRevision}
            />
          ) : null}
          {props.detail.summary.lifecycle === "disabled" ? (
            <button
              type="button"
              disabled={props.busy}
              onClick={props.runLifecycleAction.bind(null, "resume")}
            >
              Resume connector
            </button>
          ) : null}
          {props.head.reviewState === "approved" ? (
            <button
              type="button"
              className="button-secondary"
              disabled={props.busy}
              onClick={props.runRevisionAction.bind(null, "retire")}
            >
              Retire revision
            </button>
          ) : null}
          {props.detail.summary.lifecycle === "disabled" ? (
            props.detail.accounts.length === 0 ? (
              <button
                type="button"
                className="button-danger"
                disabled={props.busy}
                onClick={props.runLifecycleAction.bind(null, "remove")}
              >
                Remove connector
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className="button-secondary"
              disabled={props.busy}
              onClick={props.runLifecycleAction.bind(null, "disable")}
            >
              Disable connector
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

function CustomConnectorWriteReview(input: {
  readonly props: Parameters<typeof CustomConnectorDetailView>[0];
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
          <button
            type="button"
            disabled={input.props.busy}
            onClick={retryCustomWriteExecution.bind(null, input.props, action)}
          >
            Retry with the same key
          </button>
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
          <button type="submit" disabled={input.props.busy}>
            Save outcome
          </button>
        </form>
      ) : null}
    </section>
  );
}

function CustomConnectorSetup(input: {
  readonly props: Parameters<typeof CustomConnectorDetailView>[0];
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  if (input.props.attempt !== null) {
    const revision = input.detail.revisions.find(
      matchesRevisionNumber.bind(null, input.props.attempt.connectorRevision),
    );
    if (revision === undefined)
      return (
        <p role="alert">
          The definition for this setup is unavailable. Return to apps and
          review the connector.
        </p>
      );
    return (
      <SetupAttemptPanel
        props={input.props}
        detail={input.detail}
        head={revision}
        attempt={input.props.attempt}
      />
    );
  }
  const setupReady = input.head.reviewState === "approved";
  return (
    <section
      className="custom-connector-setup"
      aria-labelledby="custom-connector-setup-title"
    >
      <h4 id="custom-connector-setup-title">Accounts and agent access</h4>
      {input.detail.accounts.length > 0 ? (
        <p>
          Choose which agents and operations can use each connected account.
          Connection setup does not grant agent access.
        </p>
      ) : null}
      {input.detail.accounts.length === 0 ? (
        <p>
          Connect an account, test its API key, then choose the operations
          agents can use.
        </p>
      ) : (
        <div className="custom-connector-account-list">
          {input.detail.accounts.map(
            renderCustomAccount.bind(
              null,
              input.props,
              input.detail,
              input.head,
            ),
          )}
        </div>
      )}
      {setupReady && input.detail.summary.lifecycle !== "disabled" ? (
        <button
          type="button"
          disabled={input.props.busy}
          onClick={startNewAccountSetup.bind(null, input.props, input.head)}
        >
          Connect account
        </button>
      ) : null}
    </section>
  );
}

function SetupAttemptPanel(input: {
  readonly props: Parameters<typeof CustomConnectorDetailView>[0];
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
  readonly attempt: CustomConnectorSetupAttempt;
}): React.ReactNode {
  const attempt = input.attempt;
  return (
    <section
      className="custom-connector-setup"
      aria-labelledby="custom-connector-setup-title"
    >
      <div className="custom-connector-setup-heading">
        <div>
          <h4 id="custom-connector-setup-title">{setupTitle(attempt)}</h4>
          <p>{setupGuidance(attempt)}</p>
        </div>
        <span className="custom-connector-state">
          {setupStateLabel(attempt.lifecycle)}
        </span>
      </div>
      {attempt.lifecycle === "awaiting_credential" ? (
        <form
          className="stacked-form custom-connector-credential-form"
          onSubmit={submitCredential.bind(null, input.props, attempt)}
        >
          <label htmlFor="custom-connector-api-key">API key</label>
          <p id="connector-authentication-hint" className="field-hint">
            {connectorCredentialGuidance(input.head)}
          </p>
          <input
            id="custom-connector-api-key"
            name="credential"
            type="password"
            autoComplete="off"
            aria-describedby="connector-authentication-hint"
            required
          />
          <p className="field-hint">
            Your key is stored encrypted and stays out of agent conversations.
            Create a key in your service’s account settings for the operations
            you reviewed.
          </p>
          <button type="submit" disabled={input.props.busy}>
            {input.props.busy ? "Saving key…" : "Save key and test connection"}
          </button>
        </form>
      ) : null}
      {attempt.lifecycle === "credential_stored" ? (
        <button
          type="button"
          disabled={input.props.busy}
          onClick={runSetupAction.bind(null, input.props, attempt, "test")}
        >
          {input.props.busy ? "Testing connection…" : "Test connection"}
        </button>
      ) : null}
      {attempt.lifecycle === "verified" ? (
        <>
          <dl className="custom-connector-review-facts">
            <div>
              <dt>Verified account</dt>
              <dd>{attempt.verification?.displayName ?? "Verified"}</dd>
            </div>
            <div>
              <dt>Tested</dt>
              <dd>
                {attempt.verification === null
                  ? "Now"
                  : new Date(attempt.verification.testedAt).toLocaleString()}
              </dd>
            </div>
          </dl>
          {input.head.reviewState === "approved" ? (
            <button
              type="button"
              disabled={input.props.busy}
              onClick={runSetupAction.bind(
                null,
                input.props,
                attempt,
                "commit",
              )}
            >
              {input.props.busy ? "Enabling account…" : "Enable account"}
            </button>
          ) : null}
        </>
      ) : null}
      {!isOpenSetup(attempt.lifecycle) ? (
        <div className="custom-connector-actions">
          <button
            type="button"
            disabled={input.props.busy}
            onClick={restartConnectorSetup.bind(
              null,
              input.props,
              input.head,
              attempt,
            )}
          >
            Start setup again
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={returnToConnectorAccounts.bind(null, input.props)}
          >
            Return to accounts
          </button>
        </div>
      ) : null}
      {isOpenSetup(attempt.lifecycle) ? (
        <button
          type="button"
          className="button-secondary"
          disabled={input.props.busy}
          onClick={runSetupAction.bind(null, input.props, attempt, "cancel")}
        >
          Cancel setup
        </button>
      ) : null}
    </section>
  );
}

async function submitConnectorDraft(
  props: Parameters<typeof CustomConnectorAuthoring>[0],
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const source = form.get("definition");
  if (typeof source !== "string" || source.trim().length === 0) {
    props.setFeedback(
      "Import a definition JSON file or paste the complete definition.",
    );
    return;
  }
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    props.setFeedback("Use valid JSON for the connector definition.");
    return;
  }
  if (!isRecord(document)) {
    props.setFeedback("The connector definition must be a JSON object.");
    return;
  }
  const result = await runMutation({
    path: customConnectorCollectionPath(props.organisationId),
    method: "POST",
    body: { document },
    intent: `custom-connector-create:${source}`,
    configurationVersion: props.configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result === null || result.connectorId === null) return;
  props.setConfigurationVersion(result.configurationVersion);
  window.location.assign(
    customConnectorHref(props.basePath, result.connectorId, null),
  );
}

function beginCustomApprovalStepUp(
  props: Parameters<typeof CustomConnectorDetailView>[0],
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
  props: Parameters<typeof CustomConnectorDetailView>[0],
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
  props: Parameters<typeof CustomConnectorDetailView>[0],
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "rejection", {
    reason: "merchant_declined",
  });
}

async function runCustomWriteExecution(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "execute", {});
}

async function retryCustomWriteExecution(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  action: CustomConnectorAction,
): Promise<void> {
  await updateCustomWriteAction(props, action, "retry", {});
}

async function submitCustomWriteReconciliation(
  props: Parameters<typeof CustomConnectorDetailView>[0],
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
  | "approval"
  | "rejection"
  | "execute"
  | "retry"
  | "reconcile";

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
  props: Parameters<typeof CustomConnectorDetailView>[0],
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

function RejectRevisionForm(props: {
  readonly busy: boolean;
  readonly reject: (reason: string) => void;
}): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  if (!open) {
    return (
      <button
        type="button"
        className="button-secondary"
        disabled={props.busy}
        onClick={setOpen.bind(null, true)}
      >
        Reject
      </button>
    );
  }
  return (
    <form
      className="stacked-form custom-connector-rejection-form"
      onSubmit={submitRejection.bind(null, reason, props.reject)}
    >
      <label htmlFor="custom-connector-rejection-reason">
        Reason for the author
      </label>
      <textarea
        id="custom-connector-rejection-reason"
        name="reason"
        rows={3}
        maxLength={500}
        required
        autoFocus
        value={reason}
        onChange={updateRejectionReason.bind(null, setReason)}
      />
      <div className="custom-connector-actions">
        <button
          type="submit"
          className="button-danger"
          disabled={props.busy || reason.trim().length === 0}
        >
          Reject revision
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={closeRejection.bind(null, setOpen, setReason)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function closeRejection(
  setOpen: (value: boolean) => void,
  setReason: (value: string) => void,
): void {
  setOpen(false);
  setReason("");
}

function updateRejectionReason(
  setReason: (value: string) => void,
  event: React.ChangeEvent<HTMLTextAreaElement>,
): void {
  setReason(event.currentTarget.value);
}

function submitRejection(
  reason: string,
  reject: (reason: string) => void,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const trimmed = reason.trim();
  if (trimmed.length > 0) reject(trimmed);
}

async function runRevisionAction(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  revision: CustomConnectorRevisionView,
  action: CustomConnectorRevisionAction,
  reason = "",
): Promise<void> {
  if (props.detail.kind !== "ready") return;
  let body: Readonly<Record<string, unknown>>;
  switch (action) {
    case "validate":
      body = { authoringDigest: revision.authoringDigest };
      break;
    case "approve":
      if (revision.definitionDigest === null || revision.definition === null) {
        props.setFeedback("Validate this definition before approving it.");
        return;
      }
      body = {
        definitionDigest: revision.definitionDigest,
        review: {
          origin: readString(revision.definition.origin),
          effects: readOperationReviews(revision.definition).map(
            operationApproval,
          ),
        },
      };
      break;
    case "reject":
      if (revision.definitionDigest === null) return;
      body = { definitionDigest: revision.definitionDigest, reason };
      break;
    case "retire":
      if (revision.definitionDigest === null) return;
      body = {
        definitionDigest: revision.definitionDigest,
        affectedIntegrationAccountIds: props.detail.value.accounts
          .filter(matchesAcceptedRevision.bind(null, revision.revision))
          .map(accountId),
      };
      break;
    default:
      return assertNever(action, "Unexpected custom connector state");
  }
  const result = await runMutation({
    path: customConnectorRevisionPath(
      props.organisationId,
      props.detail.value.summary.connectorId,
      revision.revision,
      action,
    ),
    method: "POST",
    body,
    intent: `custom-connector-revision:${props.detail.value.summary.connectorId}:${revision.revision}:${action}`,
    configurationVersion: props.configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result === null) return;
  props.setConfigurationVersion(result.configurationVersion);
  await refreshDetail(props, props.detail.value.summary.connectorId);
}

async function runLifecycleAction(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  action: "disable" | "remove" | "resume",
): Promise<void> {
  if (props.detail.kind !== "ready") return;
  const summary = props.detail.value.summary;
  const path =
    action === "remove"
      ? customConnectorPath(props.organisationId, summary.connectorId)
      : `${customConnectorPath(props.organisationId, summary.connectorId)}/${action}`;
  const result = await runMutation({
    path,
    method: action === "remove" ? "DELETE" : "POST",
    body: { expectedHeadRevision: summary.headRevision },
    intent: `custom-connector-lifecycle:${summary.connectorId}:${action}:${summary.headRevision}`,
    configurationVersion: props.configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result === null) return;
  props.setConfigurationVersion(result.configurationVersion);
  if (action === "remove") {
    void props.navigate(props.basePath, { preventScrollReset: true });
    return;
  }
  await refreshDetail(props, summary.connectorId);
}

async function startNewAccountSetup(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  revision: CustomConnectorRevisionView,
): Promise<void> {
  await startSetup(props, revision, {
    kind: "new_account",
    environment: "production",
  });
}

async function startExistingAccountSetup(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  revision: CustomConnectorRevisionView,
  account: CustomConnectorAccountView,
  kind: "resume_account" | "rotate_account" | "upgrade_account",
): Promise<void> {
  await startSetup(props, revision, {
    kind,
    integrationAccountId: account.integrationAccountId,
    expectedBindingRevision: account.bindingRevision,
  });
}

async function startSetup(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  revision: CustomConnectorRevisionView,
  target: CustomConnectorSetupAttempt["target"],
): Promise<void> {
  if (props.detail.kind !== "ready" || revision.definitionDigest === null) {
    props.setFeedback("Validate this revision before setting up an account.");
    return;
  }
  const connectorId = props.detail.value.summary.connectorId;
  const result = await runMutation({
    path: customConnectorSetupCollectionPath(props.organisationId, connectorId),
    method: "POST",
    body: {
      connectorRevision: revision.revision,
      definitionDigest: revision.definitionDigest,
      target,
    },
    intent: `custom-connector-setup:${connectorId}:${JSON.stringify(target)}`,
    configurationVersion: props.configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result === null || result.attempt === null) return;
  props.setConfigurationVersion(result.configurationVersion);
  props.setAttempt(result.attempt);
  replaceCustomConnectorLocation(
    props.navigate,
    props.basePath,
    connectorId,
    result.attempt.attemptId,
  );
}

async function submitCredential(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  attempt: CustomConnectorSetupAttempt,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const credentialValue = form.get("credential");
  if (typeof credentialValue !== "string" || credentialValue.length === 0) {
    props.setFeedback("Enter the API key.");
    return;
  }
  const result = await runSetupMutation(
    props,
    attempt,
    "credential",
    {
      credentialValue,
      expectedAttemptRevision: attempt.attemptRevision,
    },
    props.configurationVersion,
  );
  formElement.reset();
  if (result !== null && result.attempt !== null) {
    props.setAttempt(result.attempt);
    const tested = await runSetupMutation(
      props,
      result.attempt,
      "test",
      {
        expectedAttemptRevision: result.attempt.attemptRevision,
      },
      result.configurationVersion,
    );
    if (tested !== null && tested.attempt !== null)
      props.setAttempt(tested.attempt);
  }
}

async function runSetupAction(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  attempt: CustomConnectorSetupAttempt,
  action: "cancel" | "commit" | "test",
): Promise<void> {
  const result = await runSetupMutation(
    props,
    attempt,
    action,
    {
      expectedAttemptRevision: attempt.attemptRevision,
    },
    props.configurationVersion,
  );
  if (result === null) return;
  if (result.attempt !== null) props.setAttempt(result.attempt);
  if (action === "commit" && props.detail.kind === "ready") {
    props.setAttempt(null);
    replaceCustomConnectorLocation(
      props.navigate,
      props.basePath,
      props.detail.value.summary.connectorId,
      null,
    );
    await refreshDetail(props, props.detail.value.summary.connectorId);
  }
}

async function runSetupMutation(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  attempt: CustomConnectorSetupAttempt,
  action: "cancel" | "commit" | "credential" | "test",
  body: Readonly<Record<string, unknown>>,
  configurationVersion: number,
): Promise<CustomConnectorMutationResult | null> {
  const result = await runMutation({
    path: `${customConnectorSetupPath(
      props.organisationId,
      attempt.connectorId,
      attempt.attemptId,
    )}/${action}`,
    method: "POST",
    body,
    intent: `custom-connector-attempt:${attempt.attemptId}:${attempt.attemptRevision}:${action}`,
    configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result !== null) {
    props.setConfigurationVersion(result.configurationVersion);
  }
  return result;
}

async function runMutation(input: {
  readonly path: string;
  readonly method: "DELETE" | "POST";
  readonly body: Readonly<Record<string, unknown>>;
  readonly intent: string;
  readonly configurationVersion: number;
  readonly mutationKeys: MutationKeys;
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
}): Promise<CustomConnectorMutationResult | null> {
  input.setBusy(true);
  input.setFeedback(null);
  const key = mutationKey(input.mutationKeys.current, input.intent);
  try {
    const result = await mutateCustomConnector(
      input.path,
      input.method,
      input.body,
      input.configurationVersion,
      key,
    );
    input.mutationKeys.current.delete(input.intent);
    input.setFeedback("Saved.");
    return result;
  } catch (error) {
    input.setFeedback(
      error instanceof Error
        ? error.message
        : "Unable to save. Check your connection and try again.",
    );
    return null;
  } finally {
    input.setBusy(false);
  }
}

async function refreshDetail(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  connectorId: string,
): Promise<void> {
  try {
    const [detail, catalog] = await Promise.all([
      readCustomConnectorDetail(props.organisationId, connectorId),
      readCustomConnectorCatalog(props.organisationId),
    ]);
    props.setDetail({ kind: "ready", value: detail });
    props.setCatalog({ kind: "ready", value: catalog });
  } catch (error) {
    props.setFeedback(
      errorMessage(error, "Unable to load custom connectors. Try again."),
    );
  }
}

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

function customConnectorHref(
  basePath: string,
  connectorId: string,
  attemptId: string | null,
): string {
  const origin =
    typeof window === "undefined"
      ? "https://portal.invalid"
      : window.location.origin;
  const url = new URL(basePath, origin);
  url.searchParams.set("customConnector", connectorId);
  if (attemptId !== null) url.searchParams.set("setupAttempt", attemptId);
  return `${url.pathname}${url.search}`;
}

function replaceCustomConnectorLocation(
  navigate: NavigateFunction,
  basePath: string,
  connectorId: string,
  attemptId: string | null,
): void {
  const path = customConnectorHref(basePath, connectorId, attemptId);
  const current = new URLSearchParams(window.location.search);
  const url = new URL(path, window.location.origin);
  const query = current.get("q");
  if (query !== null) url.searchParams.set("q", query);
  void navigate(`${url.pathname}${url.search}`, {
    replace: true,
    preventScrollReset: true,
  });
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

function renderCustomAccount(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  detail: CustomConnectorDetail,
  head: CustomConnectorRevisionView,
  account: CustomConnectorAccountView,
): React.ReactNode {
  const accepted = detail.revisions.find(
    matchesRevisionNumber.bind(null, account.acceptedRevision),
  );
  return (
    <article
      className="custom-connector-account"
      key={account.integrationAccountId}
      id={`custom-account-${account.integrationAccountId}`}
    >
      <div>
        <strong>{account.displayName}</strong>
        <span>{account.lifecycle === "active" ? "Connected" : "Disabled"}</span>
      </div>
      <div className="custom-connector-account-actions">
        {account.lifecycle === "active" ? (
          <a
            className="button-link"
            href={connectorAccessHref(
              props.accessPath,
              detail.summary.connectorId,
              account.integrationAccountId,
            )}
          >
            Manage agent access
          </a>
        ) : null}
        {account.lifecycle === "active" && accepted !== undefined ? (
          <button
            type="button"
            disabled={props.busy}
            onClick={startExistingAccountSetup.bind(
              null,
              props,
              accepted,
              account,
              "rotate_account",
            )}
          >
            Replace API key
          </button>
        ) : null}
        {account.lifecycle === "disabled" && accepted !== undefined ? (
          <button
            type="button"
            disabled={props.busy}
            onClick={startExistingAccountSetup.bind(
              null,
              props,
              accepted,
              account,
              "resume_account",
            )}
          >
            Reconnect account
          </button>
        ) : null}
        {account.lifecycle === "active" &&
        head.reviewState === "approved" &&
        head.revision !== account.acceptedRevision ? (
          <button
            type="button"
            disabled={props.busy}
            onClick={startExistingAccountSetup.bind(
              null,
              props,
              head,
              account,
              "upgrade_account",
            )}
          >
            Use reviewed version {head.revision}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function readOperationReviews(
  definition: Readonly<Record<string, unknown>>,
): readonly {
  readonly id: string;
  readonly description: string;
  readonly effect: "read" | "external_record_create" | "external_record_update";
  readonly idempotencyHeader: string | null;
}[] {
  if (!Array.isArray(definition.operations)) return [];
  const operations: {
    id: string;
    description: string;
    effect: "read" | "external_record_create" | "external_record_update";
    idempotencyHeader: string | null;
  }[] = [];
  for (const raw of definition.operations) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const effect = readEffect(raw.effect);
    if (effect === null) continue;
    operations.push({
      id: raw.id,
      description:
        typeof raw.description === "string" ? raw.description : raw.id,
      effect,
      idempotencyHeader: readIdempotencyHeader(raw.effect),
    });
  }
  return operations;
}

function readEffect(
  raw: unknown,
): "read" | "external_record_create" | "external_record_update" | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (
    raw.kind === "read" ||
    raw.kind === "external_record_create" ||
    raw.kind === "external_record_update"
  ) {
    return raw.kind;
  }
  return null;
}

function readIdempotencyHeader(effect: unknown): string | null {
  return isRecord(effect) &&
    isRecord(effect.retryPolicy) &&
    effect.retryPolicy.kind === "provider_idempotent" &&
    typeof effect.retryPolicy.header === "string"
    ? effect.retryPolicy.header
    : null;
}

function operationApproval(operation: {
  readonly id: string;
  readonly effect: "read" | "external_record_create" | "external_record_update";
}): Readonly<{ operationId: string; effect: string }> {
  return { operationId: operation.id, effect: operation.effect };
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

function matchesRevisionNumber(
  revision: number,
  value: CustomConnectorRevisionView,
): boolean {
  return value.revision === revision;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mutationKey(keys: Map<string, string>, intent: string): string {
  const current = keys.get(intent);
  if (current !== undefined) return current;
  const created = `portal-${crypto.randomUUID()}`;
  keys.set(intent, created);
  return created;
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

function setupStateLabel(
  state: CustomConnectorSetupAttempt["lifecycle"],
): string {
  switch (state) {
    case "awaiting_credential":
      return "API key needed";
    case "credential_stored":
      return "Ready to test";
    case "testing":
      return "Testing connection";
    case "verified":
      return "Connection verified";
    case "committed":
      return "Connected";
    case "failed":
      return "Test failed";
    case "cancelled":
      return "Setup cancelled";
    case "expired":
      return "Setup expired";
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

function connectorCredentialGuidance(
  revision: CustomConnectorRevisionView,
): string {
  const definition = revision.definition;
  const authentication = definition?.authentication;
  if (!isRecord(authentication))
    return "Use the key for the account you want to connect.";
  if (authentication.kind === "basic_api_key")
    return "Paste the API key only. Purin Pantry supplies Basic authentication with an empty password.";
  if (
    authentication.kind === "header" &&
    typeof authentication.name === "string" &&
    authentication.name.toLowerCase() === "authorization"
  )
    return "Paste the complete Authorization header value, including the service’s required prefix.";
  return "Paste the API key only, without a header name or Bearer prefix.";
}

function setupGuidance(attempt: CustomConnectorSetupAttempt): string {
  switch (attempt.lifecycle) {
    case "awaiting_credential":
      return "Add the API key for this destination.";
    case "credential_stored":
      return "Check that this key connects to the expected account before enabling access.";
    case "testing":
      return "Testing the connection…";
    case "verified":
      return "The account identity is verified.";
    case "committed":
      return "This account is connected.";
    case "failed":
      return "The connection test failed. Check the API key and its permissions, then start setup again.";
    case "cancelled":
      return "This setup was cancelled.";
    case "expired":
      return "This setup expired. Start again with a fresh API key.";
    default:
      return assertNever(attempt.lifecycle, "Unexpected custom connector state");
  }
}

function isOpenSetup(
  lifecycle: CustomConnectorSetupAttempt["lifecycle"],
): boolean {
  return (
    lifecycle === "awaiting_credential" ||
    lifecycle === "credential_stored" ||
    lifecycle === "testing" ||
    lifecycle === "verified"
  );
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

function currentSetupStep(
  head: CustomConnectorRevisionView,
  attempt: CustomConnectorSetupAttempt | null,
  accountCount: number,
): ConnectorSetupStep {
  if (attempt !== null) {
    switch (attempt.lifecycle) {
      case "awaiting_credential":
        return "connect";
      case "credential_stored":
      case "testing":
      case "verified":
        return "test";
      case "committed":
        return "access";
      case "failed":
      case "cancelled":
      case "expired":
        return "connect";
      default:
        return assertNever(attempt.lifecycle, "Unexpected custom connector state");
    }
  }
  if (head.reviewState !== "approved") return "review";
  return accountCount > 0 ? "access" : "connect";
}

/**
 * The definition is technical, so it stays out of the way behind one plain
 * button. A definition that failed its check opens by itself.
 */
function ConnectorRevisionEditor(input: {
  readonly props: Parameters<typeof CustomConnectorDetailView>[0];
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const [editing, setEditing] = React.useState(false);
  if (!editing && input.head.validationFailure === null)
    return (
      <div className="custom-connector-actions">
        <button type="button" onClick={setEditing.bind(null, true)}>
          Edit the definition
        </button>
      </div>
    );
  return (
    <div className="custom-connector-technical connector-revision-editor">
      <form
        className="stacked-form"
        onSubmit={submitConnectorRevision.bind(null, input.props, input.head)}
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
        <p className="field-hint">
          Save a new version, review its operations, then update connected
          accounts.
        </p>
        <div className="custom-connector-actions">
          <button type="submit" disabled={input.props.busy}>
            Save the definition
          </button>
          {input.head.validationFailure === null ? (
            <button type="button" onClick={setEditing.bind(null, false)}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

async function submitConnectorRevision(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  head: CustomConnectorRevisionView,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (props.detail.kind !== "ready") return;
  const source = new FormData(event.currentTarget).get("definition");
  if (typeof source !== "string") return;
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    props.setFeedback("Use valid JSON for the connector definition.");
    return;
  }
  if (!isRecord(document)) {
    props.setFeedback("Use a JSON object for the connector definition.");
    return;
  }
  const connectorId = props.detail.value.summary.connectorId;
  const result = await runMutation({
    path: `${customConnectorPath(props.organisationId, connectorId)}/revisions`,
    method: "POST",
    body: { document, expectedHeadRevision: head.revision },
    intent: `custom-connector-revision-create:${connectorId}:${head.revision}:${source}`,
    configurationVersion: props.configurationVersion,
    mutationKeys: props.mutationKeys,
    setBusy: props.setBusy,
    setFeedback: props.setFeedback,
  });
  if (result === null) return;
  props.setConfigurationVersion(result.configurationVersion);
  await refreshDetail(props, connectorId);
}

function returnToConnectorAccounts(
  props: Parameters<typeof CustomConnectorDetailView>[0],
): void {
  if (props.detail.kind !== "ready") return;
  props.setAttempt(null);
  props.setFeedback(null);
  replaceCustomConnectorLocation(
    props.navigate,
    props.basePath,
    props.detail.value.summary.connectorId,
    null,
  );
}

function connectorAccessHref(
  accessPath: string,
  connectorId: string,
  integrationAccountId: string,
): string {
  const query = new URLSearchParams({
    customConnector: connectorId,
    integrationAccount: integrationAccountId,
  });
  return `${accessPath}?${query.toString()}`;
}

function setupTitle(attempt: CustomConnectorSetupAttempt): string {
  switch (attempt.target.kind) {
    case "rotate_account":
      return "Replace API key";
    case "upgrade_account":
      return "Update account connection";
    case "resume_account":
      return "Reconnect account";
    case "new_account":
      return "Connect your account";
    default:
      return assertNever(attempt.target, "Unexpected custom connector state");
  }
}

async function restartConnectorSetup(
  props: Parameters<typeof CustomConnectorDetailView>[0],
  head: CustomConnectorRevisionView,
  attempt: CustomConnectorSetupAttempt,
): Promise<void> {
  if (props.detail.kind !== "ready") return;
  const revision = props.detail.value.revisions.find(
    matchesRevisionNumber.bind(null, attempt.connectorRevision),
  );
  if (revision === undefined) {
    props.setFeedback(
      "This definition is no longer available. Return to accounts to review the current connector.",
    );
    return;
  }
  const target = attempt.target;
  if (target.kind === "new_account") {
    await startSetup(props, revision, {
      kind: "new_account",
      environment: target.environment,
    });
    return;
  }
  const account = props.detail.value.accounts.find(
    matchesCustomAccountId.bind(null, target.integrationAccountId),
  );
  if (account === undefined) {
    props.setFeedback(
      "This account is no longer available. Return to accounts to choose a connection.",
    );
    return;
  }
  await startExistingAccountSetup(props, revision, account, target.kind);
}

function matchesCustomAccountId(
  integrationAccountId: string,
  account: CustomConnectorAccountView,
): boolean {
  return account.integrationAccountId === integrationAccountId;
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
