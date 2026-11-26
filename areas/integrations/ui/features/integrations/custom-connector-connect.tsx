import React from "react";
import { Button } from "@purin-labs/ui/index";
import {
  customConnectorRevisionPath,
  customConnectorSetupCollectionPath,
  customConnectorSetupPath,
  readCustomConnectorSetup,
  type CustomConnectorDetail,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/custom-connector-api";
import type {
  CustomConnectorAccountView,
  CustomConnectorRevisionView,
  CustomConnectorSetupAttempt,
} from "@purin-labs/control-api/portal/custom-connectors";
import { assertNever, isRecord } from "@purin-labs/std";
import {
  approvalReview,
  matchesRevisionNumber,
  refreshDetail,
  replaceCustomConnectorLocation,
  requireAttempt,
  requireRevision,
  runPress,
  sendMutation,
  validateStep,
  type ConnectorDetailProps,
  type MutationChain,
} from "./custom-connector-press";

type SetupTarget = CustomConnectorSetupAttempt["target"];
type ExistingAccountTarget = Exclude<SetupTarget["kind"], "new_account">;

/** The setup of a press, while it is open. A committed setup is null. */
type SetupProgress = { attempt: CustomConnectorSetupAttempt | null };

/**
 * The approval and the accounts of a connector. One press approves the
 * revision and, with a key, connects the first account: the validation of a
 * draft, the approval, the setup, the key, the identity test and the commit
 * run in order. Each step keeps its own server check.
 */
export function CustomConnectorSetup(input: {
  readonly props: ConnectorDetailProps;
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const attempt = input.props.attempt;
  if (attempt !== null) {
    const revision = input.detail.revisions.find(
      matchesRevisionNumber.bind(null, attempt.connectorRevision),
    );
    if (revision === undefined)
      return (
        <p role="alert">
          The definition of this setup is no longer available. Close it and open
          the connector again.
        </p>
      );
    return (
      <SetupAttemptPanel
        props={input.props}
        revision={revision}
        attempt={attempt}
      />
    );
  }
  const waiting =
    input.head.reviewState === "draft" ||
    input.head.reviewState === "validated";
  return (
    <>
      {waiting ? (
        <ConnectorApproval
          props={input.props}
          detail={input.detail}
          head={input.head}
        />
      ) : null}
      <ConnectorAccounts
        props={input.props}
        detail={input.detail}
        head={input.head}
      />
    </>
  );
}

function ConnectorApproval(input: {
  readonly props: ConnectorDetailProps;
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const formId = React.useId();
  const [hasKey, setHasKey] = React.useState(false);
  const connectable = input.detail.summary.lifecycle !== "disabled";
  let label = hasKey ? "Approve and connect" : "Approve";
  if (input.props.busy) label = hasKey ? "Connecting…" : "Approving…";
  return (
    <section className="custom-connector-setup" aria-label="Approval">
      <form
        id={formId}
        className="stacked-form custom-connector-credential-form"
        hidden={!connectable}
        onSubmit={submitApproval.bind(null, input.props, input.head)}
        onReset={setHasKey.bind(null, false)}
      >
        <ApiKeyField
          revision={input.head}
          required={false}
          onPresence={setHasKey}
        />
      </form>
      <div className="custom-connector-actions">
        <Button
          type="submit"
          form={formId}
          variant="primary"
          disabled={input.props.busy}
        >
          {label}
        </Button>
        {input.head.reviewState === "validated" ? (
          <RejectRevisionForm
            busy={input.props.busy}
            reject={rejectRevision.bind(null, input.props, input.head)}
          />
        ) : null}
      </div>
    </section>
  );
}

function ConnectorAccounts(input: {
  readonly props: ConnectorDetailProps;
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
}): React.ReactNode {
  const titleId = React.useId();
  const [adding, setAdding] = React.useState(false);
  const accounts = input.detail.accounts;
  const connectable =
    input.head.reviewState === "approved" &&
    input.detail.summary.lifecycle !== "disabled";
  if (accounts.length === 0 && !connectable) return null;
  return (
    <section className="custom-connector-setup" aria-labelledby={titleId}>
      <h4 id={titleId}>Accounts</h4>
      {accounts.length === 0 ? null : (
        <div className="custom-connector-account-list">
          {accounts.map((account) => (
            <CustomAccountRow
              key={account.integrationAccountId}
              props={input.props}
              detail={input.detail}
              head={input.head}
              account={account}
            />
          ))}
        </div>
      )}
      {connectable && (accounts.length === 0 || adding) ? (
        <ConnectForm
          revision={input.head}
          submitLabel="Connect"
          busy={input.props.busy}
          cancel={accounts.length === 0 ? null : setAdding.bind(null, false)}
          submit={connectAndClose.bind(
            null,
            connectNewAccount.bind(null, input.props, input.head),
            setAdding.bind(null, false),
          )}
        />
      ) : null}
      {connectable && accounts.length > 0 && !adding ? (
        <div className="custom-connector-actions">
          <Button
            disabled={input.props.busy}
            onClick={setAdding.bind(null, true)}
          >
            Connect another account
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CustomAccountRow(input: {
  readonly props: ConnectorDetailProps;
  readonly detail: CustomConnectorDetail;
  readonly head: CustomConnectorRevisionView;
  readonly account: CustomConnectorAccountView;
}): React.ReactNode {
  const [keyFor, setKeyFor] = React.useState<ExistingAccountTarget | null>(
    null,
  );
  const account = input.account;
  const accepted = input.detail.revisions.find(
    matchesRevisionNumber.bind(null, account.acceptedRevision),
  );
  const active = account.lifecycle === "active";
  const upgradable =
    active &&
    input.head.reviewState === "approved" &&
    input.head.revision !== account.acceptedRevision;
  const revision = keyFor === "upgrade_account" ? input.head : accepted;
  return (
    <article
      className="custom-connector-account"
      id={`custom-account-${account.integrationAccountId}`}
    >
      <div>
        <strong>{account.displayName}</strong>
        <span>{active ? "Connected" : "Disabled"}</span>
      </div>
      {keyFor !== null && revision !== undefined ? (
        <ConnectForm
          revision={revision}
          submitLabel={existingAccountLabel(keyFor)}
          busy={input.props.busy}
          cancel={setKeyFor.bind(null, null)}
          submit={connectAndClose.bind(
            null,
            connectExistingAccount.bind(
              null,
              input.props,
              revision,
              account,
              keyFor,
            ),
            setKeyFor.bind(null, null),
          )}
        />
      ) : (
        <div className="custom-connector-account-actions">
          {active ? (
            <a
              className="button-link"
              href={connectorAccessHref(
                input.props.accessPath,
                input.detail.summary.connectorId,
                account.integrationAccountId,
              )}
            >
              Manage agent access
            </a>
          ) : null}
          {active && accepted !== undefined ? (
            <Button
              disabled={input.props.busy}
              onClick={setKeyFor.bind(null, "rotate_account")}
            >
              Replace API key
            </Button>
          ) : null}
          {!active && accepted !== undefined ? (
            <Button
              disabled={input.props.busy}
              onClick={setKeyFor.bind(null, "resume_account")}
            >
              Reconnect account
            </Button>
          ) : null}
          {upgradable ? (
            <Button
              disabled={input.props.busy}
              onClick={setKeyFor.bind(null, "upgrade_account")}
            >
              Use reviewed version {input.head.revision}
            </Button>
          ) : null}
        </div>
      )}
    </article>
  );
}

/**
 * A setup that one press did not finish, as the address names it. Its own
 * press runs the steps that are left.
 */
function SetupAttemptPanel(input: {
  readonly props: ConnectorDetailProps;
  readonly revision: CustomConnectorRevisionView;
  readonly attempt: CustomConnectorSetupAttempt;
}): React.ReactNode {
  const titleId = React.useId();
  const attempt = input.attempt;
  const open = isOpenSetup(attempt.lifecycle);
  const guidance = setupGuidance(attempt);
  return (
    <section className="custom-connector-setup" aria-labelledby={titleId}>
      <div className="custom-connector-setup-heading">
        <div>
          <h4 id={titleId}>{setupTitle(attempt)}</h4>
          {guidance === null ? null : <p>{guidance}</p>}
        </div>
        <span className="custom-connector-state">
          {setupStateLabel(attempt.lifecycle)}
        </span>
      </div>
      {attempt.lifecycle === "verified" ? (
        <dl className="custom-connector-review-facts">
          <div>
            <dt>Account</dt>
            <dd>{attempt.verification?.displayName ?? "Verified"}</dd>
          </div>
        </dl>
      ) : null}
      {attempt.lifecycle === "awaiting_credential" || !open ? (
        <ConnectForm
          revision={input.revision}
          submitLabel={open ? "Connect" : "Try again"}
          busy={input.props.busy}
          cancel={null}
          submit={
            open
              ? continueSetup.bind(null, input.props, attempt)
              : restartSetup.bind(null, input.props, input.revision, attempt)
          }
        />
      ) : null}
      <div className="custom-connector-actions">
        {attempt.lifecycle === "credential_stored" ||
        (attempt.lifecycle === "verified" &&
          input.revision.reviewState === "approved") ? (
          <Button
            variant="primary"
            disabled={input.props.busy}
            onClick={continueSetup.bind(null, input.props, attempt, null)}
          >
            {input.props.busy ? "Connecting…" : "Connect"}
          </Button>
        ) : null}
        {open ? (
          <Button
            disabled={input.props.busy}
            onClick={cancelSetup.bind(null, input.props, attempt)}
          >
            Cancel setup
          </Button>
        ) : (
          <Button
            variant="link"
            disabled={input.props.busy}
            onClick={closeSetup.bind(null, input.props)}
          >
            Back to accounts
          </Button>
        )}
      </div>
    </section>
  );
}

function ConnectForm(input: {
  readonly revision: CustomConnectorRevisionView;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly cancel: (() => void) | null;
  readonly submit: (credential: string) => Promise<void>;
}): React.ReactNode {
  return (
    <form
      className="stacked-form custom-connector-credential-form"
      onSubmit={submitConnectForm.bind(null, input.submit)}
    >
      <ApiKeyField revision={input.revision} required />
      <div className="custom-connector-actions">
        <Button type="submit" variant="primary" disabled={input.busy}>
          {input.busy ? "Connecting…" : input.submitLabel}
        </Button>
        {input.cancel === null ? null : (
          <Button disabled={input.busy} onClick={input.cancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The key field. The key goes only to the setup route, never to chat. */
function ApiKeyField(props: {
  readonly revision: CustomConnectorRevisionView;
  readonly required: boolean;
  readonly onPresence?: (present: boolean) => void;
}): React.ReactNode {
  const id = React.useId();
  return (
    <>
      <label htmlFor={`${id}-key`}>API key</label>
      <input
        id={`${id}-key`}
        name="credential"
        type="password"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        required={props.required}
        onChange={
          props.onPresence === undefined
            ? undefined
            : reportKeyPresence.bind(null, props.onPresence)
        }
      />
      <p id={`${id}-hint`} className="field-hint">
        {connectorCredentialGuidance(props.revision)} Pantry stores it
        encrypted, and agents never see it.
      </p>
    </>
  );
}

function RejectRevisionForm(props: {
  readonly busy: boolean;
  readonly reject: (reason: string) => void;
}): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  if (!open) {
    return (
      <Button disabled={props.busy} onClick={setOpen.bind(null, true)}>
        Reject
      </Button>
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
        <Button
          type="submit"
          variant="danger"
          disabled={props.busy || reason.trim().length === 0}
        >
          Reject revision
        </Button>
        <Button onClick={closeRejection.bind(null, setOpen, setReason)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function reportKeyPresence(
  onPresence: (present: boolean) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  onPresence(event.currentTarget.value.length > 0);
}

async function submitConnectForm(
  submit: (credential: string) => Promise<void>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  const credential = readCredential(form);
  form.reset();
  if (credential !== null) await submit(credential);
}

async function submitApproval(
  props: ConnectorDetailProps,
  head: CustomConnectorRevisionView,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  const credential = readCredential(form);
  form.reset();
  if (props.detail.kind !== "ready") return;
  const connectorId = props.detail.value.summary.connectorId;
  const progress: SetupProgress = { attempt: null };
  await runPress(props, async (chain) => {
    const approved = await approveRevision(chain, connectorId, head);
    if (credential === null) return "Approved.";
    await startAndFinishSetup(
      chain,
      connectorId,
      approved,
      { kind: "new_account", environment: "production" },
      credential,
      progress,
    );
    return "Approved and connected.";
  });
  await settleSetup(props, connectorId, progress);
}

/**
 * The validation of a draft, then the approval of what the drawer showed:
 * the destination and the effects of each operation.
 */
async function approveRevision(
  chain: MutationChain,
  connectorId: string,
  head: CustomConnectorRevisionView,
): Promise<CustomConnectorRevisionView> {
  const review = approvalReview(head);
  const organisationId = chain.owner.organisationId;
  const revision =
    head.reviewState === "draft"
      ? requireRevision(
          await sendMutation(
            chain,
            validateStep(organisationId, connectorId, head),
          ),
        )
      : head;
  if (revision.definitionDigest === null)
    throw new Error("This definition is not valid yet. Edit it, then approve.");
  return requireRevision(
    await sendMutation(chain, {
      path: customConnectorRevisionPath(
        organisationId,
        connectorId,
        revision.revision,
        "approve",
      ),
      method: "POST",
      body: { definitionDigest: revision.definitionDigest, review },
      intent: `custom-connector-revision:${connectorId}:${revision.revision}:approve`,
    }),
  );
}

async function rejectRevision(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
  reason: string,
): Promise<void> {
  if (props.detail.kind !== "ready" || revision.definitionDigest === null)
    return;
  const connectorId = props.detail.value.summary.connectorId;
  const definitionDigest = revision.definitionDigest;
  const done = await runPress(props, async (chain) => {
    await sendMutation(chain, {
      path: customConnectorRevisionPath(
        props.organisationId,
        connectorId,
        revision.revision,
        "reject",
      ),
      method: "POST",
      body: { definitionDigest, reason },
      intent: `custom-connector-revision:${connectorId}:${revision.revision}:reject`,
    });
    return "Rejected.";
  });
  if (done) await refreshDetail(props, connectorId);
}

/** Closes the key form of a press that connected the account. */
async function connectAndClose(
  connect: (credential: string) => Promise<boolean>,
  close: () => void,
  credential: string,
): Promise<void> {
  if (await connect(credential)) close();
}

async function connectNewAccount(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
  credential: string,
): Promise<boolean> {
  return connectAccount(
    props,
    revision,
    { kind: "new_account", environment: "production" },
    credential,
  );
}

async function connectExistingAccount(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
  account: CustomConnectorAccountView,
  kind: ExistingAccountTarget,
  credential: string,
): Promise<boolean> {
  return connectAccount(
    props,
    revision,
    {
      kind,
      integrationAccountId: account.integrationAccountId,
      expectedBindingRevision: account.bindingRevision,
    },
    credential,
  );
}

async function connectAccount(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
  target: SetupTarget,
  credential: string,
): Promise<boolean> {
  if (props.detail.kind !== "ready") return false;
  const connectorId = props.detail.value.summary.connectorId;
  const progress: SetupProgress = { attempt: null };
  const done = await runPress(props, async (chain) => {
    await startAndFinishSetup(
      chain,
      connectorId,
      revision,
      target,
      credential,
      progress,
    );
    return "Connected.";
  });
  await settleSetup(props, connectorId, progress);
  return done;
}

async function continueSetup(
  props: ConnectorDetailProps,
  attempt: CustomConnectorSetupAttempt,
  credential: string | null,
): Promise<void> {
  const progress: SetupProgress = { attempt };
  await runPress(props, async (chain) => {
    await finishSetup(chain, progress, credential);
    return "Connected.";
  });
  await settleSetup(props, attempt.connectorId, progress);
}

/** A setup that failed, was cancelled or expired starts again for the same target. */
async function restartSetup(
  props: ConnectorDetailProps,
  revision: CustomConnectorRevisionView,
  attempt: CustomConnectorSetupAttempt,
  credential: string,
): Promise<void> {
  if (props.detail.kind !== "ready") return;
  const target = attempt.target;
  if (target.kind === "new_account") {
    await connectAccount(props, revision, target, credential);
    return;
  }
  const account = props.detail.value.accounts.find(
    matchesAccountId.bind(null, target.integrationAccountId),
  );
  if (account === undefined) {
    props.setFeedback(
      "This account is no longer connected. Go back to accounts.",
    );
    return;
  }
  await connectExistingAccount(
    props,
    revision,
    account,
    target.kind,
    credential,
  );
}

async function cancelSetup(
  props: ConnectorDetailProps,
  attempt: CustomConnectorSetupAttempt,
): Promise<void> {
  const done = await runPress(props, async (chain) => {
    await sendMutation(chain, setupStep(chain, attempt, "cancel", {}));
    return "Setup cancelled.";
  });
  if (done) closeSetup(props);
}

function closeSetup(props: ConnectorDetailProps): void {
  if (props.detail.kind !== "ready") return;
  props.setAttempt(null);
  replaceCustomConnectorLocation(
    props.navigate,
    props.basePath,
    props.detail.value.summary.connectorId,
    null,
  );
}

async function startAndFinishSetup(
  chain: MutationChain,
  connectorId: string,
  revision: CustomConnectorRevisionView,
  target: SetupTarget,
  credential: string,
  progress: SetupProgress,
): Promise<void> {
  if (revision.definitionDigest === null)
    throw new Error("Approve this definition before you connect an account.");
  progress.attempt = requireAttempt(
    await sendMutation(chain, {
      path: customConnectorSetupCollectionPath(
        chain.owner.organisationId,
        connectorId,
      ),
      method: "POST",
      body: {
        connectorRevision: revision.revision,
        definitionDigest: revision.definitionDigest,
        target,
      },
      intent: `custom-connector-setup:${connectorId}:${JSON.stringify(target)}`,
    }),
  );
  await finishSetup(chain, progress, credential);
}

/**
 * The steps of a setup that are left: the key, the identity test, then the
 * commit. Commit makes no grant: agents get access on the Access page only.
 */
async function finishSetup(
  chain: MutationChain,
  progress: SetupProgress,
  credential: string | null,
): Promise<void> {
  let attempt = progress.attempt;
  if (attempt === null) return;
  if (attempt.lifecycle === "awaiting_credential") {
    if (credential === null) throw new Error("Enter the API key.");
    attempt = requireAttempt(
      await sendMutation(
        chain,
        setupStep(chain, attempt, "credential", {
          credentialValue: credential,
        }),
      ),
    );
    progress.attempt = attempt;
  }
  if (attempt.lifecycle === "credential_stored") {
    attempt = requireAttempt(
      await sendMutation(chain, setupStep(chain, attempt, "test", {})),
    );
    progress.attempt = attempt;
  }
  if (attempt.lifecycle !== "verified")
    throw new Error(setupGuidance(attempt) ?? "Try the setup again.");
  await sendMutation(chain, setupStep(chain, attempt, "commit", {}));
  progress.attempt = null;
}

function setupStep(
  chain: MutationChain,
  attempt: CustomConnectorSetupAttempt,
  action: "cancel" | "commit" | "credential" | "test",
  body: Readonly<Record<string, unknown>>,
) {
  return {
    path: `${customConnectorSetupPath(
      chain.owner.organisationId,
      attempt.connectorId,
      attempt.attemptId,
    )}/${action}`,
    method: "POST" as const,
    body: { ...body, expectedAttemptRevision: attempt.attemptRevision },
    intent: `custom-connector-attempt:${attempt.attemptId}:${attempt.attemptRevision}:${action}`,
  };
}

/**
 * After a press: a committed setup leaves the address, and the drawer shows
 * the new account. A setup that stopped stays in the address with its state
 * as the server holds it, so a reload or the next press continues it.
 */
async function settleSetup(
  props: ConnectorDetailProps,
  connectorId: string,
  progress: SetupProgress,
): Promise<void> {
  let attempt = progress.attempt;
  if (attempt !== null) {
    try {
      attempt = await readCustomConnectorSetup(
        props.organisationId,
        connectorId,
        attempt.attemptId,
      );
    } catch {
      // The setup state from the last step stays.
    }
    // The setup names its own fault, so the general refusal goes.
    if (!isOpenSetup(attempt.lifecycle)) props.setFeedback(null);
  }
  props.setAttempt(attempt);
  const address = new URLSearchParams(window.location.search).get(
    "setupAttempt",
  );
  const attemptId = attempt === null ? null : attempt.attemptId;
  if (address !== attemptId)
    replaceCustomConnectorLocation(
      props.navigate,
      props.basePath,
      connectorId,
      attemptId,
    );
  await refreshDetail(props, connectorId);
}

function readCredential(form: HTMLFormElement): string | null {
  const value = new FormData(form).get("credential");
  return typeof value === "string" && value.length > 0 ? value : null;
}

function matchesAccountId(
  integrationAccountId: string,
  account: CustomConnectorAccountView,
): boolean {
  return account.integrationAccountId === integrationAccountId;
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

function existingAccountLabel(kind: ExistingAccountTarget): string {
  switch (kind) {
    case "rotate_account":
      return "Save key";
    case "resume_account":
      return "Reconnect";
    case "upgrade_account":
      return "Update";
    default:
      return assertNever(kind, "Unexpected custom connector setup");
  }
}

function connectorCredentialGuidance(
  revision: CustomConnectorRevisionView,
): string {
  const authentication = revision.definition?.authentication;
  if (!isRecord(authentication))
    return "Use the key of the account that you connect.";
  if (authentication.kind === "basic_api_key")
    return "Paste the API key only. Pantry sends it with Basic authentication and an empty password.";
  if (
    authentication.kind === "header" &&
    typeof authentication.name === "string" &&
    authentication.name.toLowerCase() === "authorization"
  )
    return "Paste the complete Authorization header value, with the prefix that the service needs.";
  return "Paste the API key only, without a header name or a Bearer prefix.";
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

function setupStateLabel(
  state: CustomConnectorSetupAttempt["lifecycle"],
): string {
  switch (state) {
    case "awaiting_credential":
      return "API key needed";
    case "credential_stored":
      return "Ready to test";
    case "testing":
      return "Testing";
    case "verified":
      return "Verified";
    case "committed":
      return "Connected";
    case "failed":
      return "Test failed";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    default:
      return assertNever(state, "Unexpected custom connector state");
  }
}

/** One sentence when the state needs one, or null. */
function setupGuidance(attempt: CustomConnectorSetupAttempt): string | null {
  switch (attempt.lifecycle) {
    case "awaiting_credential":
    case "credential_stored":
    case "verified":
    case "committed":
      return null;
    case "testing":
      return "The connection test is still running. Try again in a moment.";
    case "failed":
      return "The test failed. Check the API key and its permissions.";
    case "cancelled":
      return "This setup was cancelled.";
    case "expired":
      return "This setup expired.";
    default:
      return assertNever(
        attempt.lifecycle,
        "Unexpected custom connector state",
      );
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
