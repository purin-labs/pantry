import { Select } from "@purin-labs/ui/select";
import React from "react";
import {
  parseMailRelationshipLookup,
  type MailRelationshipLookup,
  type MailRelationshipPreview,
  type MailSupplierCandidate,
} from "@purin-labs/control-api";
import { isRecord, assertNever } from "@purin-labs/std";
import { controlWrite } from "@purin-labs/control/portal/control-client";
import { mailAnswer } from "./api";
import {
  parseRelationshipPreview,
  parseSuppliers,
} from "@purin-labs/control-api/portal/mail-relationship";

// Purchasing facts and unsaved text live only in this mounted conversation.
type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "selecting"; suppliers: readonly MailSupplierCandidate[] }>
  | Readonly<{ kind: "reviewing"; preview: MailRelationshipPreview }>
  | Readonly<{ kind: "saving" }>
  | Readonly<{ kind: "rejecting" }>
  | Readonly<{ kind: "failed"; message: string }>;

type Props = Readonly<{
  organisationId: string;
  proposalId: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
  supplierHref: (supplierId: string) => string;
}>;

export class MailRelationshipCorrection extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private request: AbortController | null = null;
  private root = React.createRef<HTMLDivElement>();

  componentDidMount(): void {
    void this.load({ kind: "suppliers" });
  }

  componentWillUnmount(): void {
    this.request?.abort();
  }
  componentDidUpdate(_props: Props, previous: State): void {
    if (previous.kind === this.state.kind) return;
    if (this.state.kind === "selecting")
      this.root.current
        ?.querySelector<HTMLButtonElement>('.pantry-select-trigger')
        ?.focus();
    if (this.state.kind === "reviewing")
      this.root.current?.querySelector<HTMLElement>("h5")?.focus();
  }
  private load = async (lookup: MailRelationshipLookup): Promise<void> => {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({ kind: "loading" });
    try {
      const raw = await relationshipRequest(
        this.props,
        "relationship",
        lookup,
        request.signal,
      );
      if (request.signal.aborted) return;
      if (raw.kind === "suppliers")
        this.setState({
          kind: "selecting",
          suppliers: parseSuppliers(raw.suppliers),
        });
      else
        this.setState({
          kind: "reviewing",
          preview: parseRelationshipPreview(raw),
        });
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({ kind: "failed", message: problem(error) });
    }
  };
  private close = (): void => {
    this.request?.abort();
    this.props.onClose();
  };
  private select = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lookup = parseMailRelationshipLookup({
      kind: "purchase_request",
      supplierEntryId: form.get("supplier"),
      purchaseRequestId: form.get("purchaseRequestId"),
    });
    if (lookup !== null) void this.load(lookup);
  };
  private save = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (this.state.kind !== "reviewing") return;
    const preview = this.state.preview;
    const body = new FormData(event.currentTarget).get("body");
    if (typeof body !== "string") return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({ kind: "saving" });
    try {
      await relationshipRequest(
        this.props,
        "correct",
        {
          version: preview.version,
          snapshotDigest: preview.snapshotDigest,
          relationshipDigest: preview.relationshipDigest,
          challenge: preview.challenge,
          supplierEntryId: preview.supplierEntryId,
          purchaseRequestId: preview.purchaseRequestId,
          body,
        },
        request.signal,
      );
      if (!request.signal.aborted) await this.props.onChanged();
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({ kind: "failed", message: problem(error) });
    }
  };
  private reject = async (): Promise<void> => {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({ kind: "rejecting" });
    try {
      await relationshipRequest(this.props, "reject", {}, request.signal);
      if (!request.signal.aborted) await this.props.onChanged();
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({ kind: "failed", message: problem(error) });
    }
  };
  render(): React.ReactNode {
    const state = this.state;
    return (
      <div
        className="mail-relationship-correction email-review-edit"
        ref={this.root}
      >
        {state.kind === "loading" ||
        state.kind === "saving" ||
        state.kind === "rejecting" ? (
          <p role="status">{pendingMessage(state.kind)}</p>
        ) : null}
        {state.kind === "loading" ? (
          <button type="button" onClick={this.close}>
            Cancel correction
          </button>
        ) : null}
        {state.kind === "failed" ? (
          <>
            <p role="alert">{state.message}</p>
            <button type="button" onClick={this.reject}>
              Reject proposal
            </button>
            <button type="button" onClick={this.close}>
              Close correction
            </button>
          </>
        ) : null}
        {state.kind === "selecting" ? (
          <form onSubmit={this.select}>
            <h5>Correct purchasing link</h5>
            <p>
              Choose a supplier registered to this sender, then enter its
              purchase request reference. This changes this reply's association.
            </p>
            {state.suppliers.length === 0 ? (
              <p>
                No authorized supplier matches this sender. Update Supplier
                Directory before trying again.
              </p>
            ) : (
              <>
                <label>
                  <span>Supplier record</span>
                  <Select.Root
                    name="supplier"
                    required
                    items={state.suppliers.map(supplierItem)}
                    defaultValue={state.suppliers[0]?.entryId ?? null}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>
                      {state.suppliers.map(renderSupplier)}
                    </Select.Popup>
                  </Select.Root>
                </label>
                <label>
                  <span>Purchase request reference</span>
                  <input
                    name="purchaseRequestId"
                    maxLength={256}
                    required
                    placeholder="PR-A"
                  />
                </label>
                <button className="connection-primary-action" type="submit">
                  Preview purchasing link
                </button>
              </>
            )}
            <button type="button" onClick={this.close}>
              Cancel correction
            </button>
          </form>
        ) : null}
        {state.kind === "reviewing" ? (
          <form onSubmit={this.save}>
            <h5 tabIndex={-1}>Current purchasing evidence</h5>
            <p>
              <a
                href={this.props.supplierHref(state.preview.supplierId)}
                target="_blank"
                rel="noreferrer"
              >
                {state.preview.supplierName}
              </a>{" "}
              · Purchase request {state.preview.purchaseRequestId}
            </p>
            <dl>{state.preview.facts.map(renderFact)}</dl>
            <p>
              Write a replacement reply using these facts. The recipient and
              conversation stay fixed. Saving requires a new review before
              sending.
            </p>
            <label>
              <span>Replacement reply</span>
              <textarea name="body" rows={8} maxLength={20_000} required />
            </label>
            <div className="connection-actions">
              <button className="connection-primary-action" type="submit">
                Save corrected draft
              </button>
              <button type="button" onClick={this.close}>
                Cancel correction
              </button>
            </div>
          </form>
        ) : null}
      </div>
    );
  }
}

function pendingMessage(
  kind: "loading" | "saving" | "rejecting",
): string {
  switch (kind) {
    case "loading":
      return "Reading current purchasing records…";
    case "saving":
      return "Saving the corrected reply…";
    case "rejecting":
      return "Rejecting the proposal…";
    default:
      return assertNever(kind);
  }
}

function supplierItem(
  supplier: MailSupplierCandidate,
): Readonly<{ value: string; label: string }> {
  return { value: supplier.entryId, label: supplier.displayName };
}

function renderSupplier(
  supplier: MailSupplierCandidate,
): React.ReactNode {
  return (
    <Select.Item key={supplier.entryId} value={supplier.entryId}>
      {supplier.displayName}
    </Select.Item>
  );
}

function renderFact(
  fact: Readonly<{ label: string; value: string }>,
): React.ReactNode {
  return (
    <div key={fact.label}>
      <dt>{fact.label}</dt>
      <dd>{fact.value}</dd>
    </div>
  );
}

async function relationshipRequest(
  props: Props,
  action: "relationship" | "correct" | "reject",
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!document.cookie.split("; ").some(isCsrfCookie))
    throw new Error("Your control session expired. Sign in again.");
  const response = await mailAnswer(
    controlWrite(
      `/v1/control/organisations/${encodeURIComponent(props.organisationId)}/email-replies/${encodeURIComponent(props.proposalId)}/${action}`,
      "POST",
      body,
      signal,
    ),
  );
  const raw = response.raw;
  if (!isRecord(raw))
    throw new Error("Could not read the purchasing response.");
  if (!response.ok) throw new Error(relationshipProblem(raw.error));
  return raw;
}

function isCsrfCookie(value: string): boolean {
  return value.startsWith("pantry_csrf=");
}

function relationshipProblem(code: unknown): string {
  if (code === "email_relationship_save_unconfirmed")
    return "Gmail did not confirm this correction. The earlier reply is blocked from sending. Check Gmail, then reject this proposal.";
  if (
    code === "email_reply_edit_stale" ||
    code === "email_reply_challenge_stale"
  )
    return "The draft or purchasing records changed. Preview the link again before saving.";
  if (code === "email_relationship_reply_required")
    return "Write a replacement reply for the corrected purchasing evidence.";
  if (code === "email_supplier_needs_review")
    return "Choose a supplier registered to this sender and one of its current purchase requests.";
  return "Purchasing correction is unavailable. Check mailbox access, purchasing access, and the proposal's state, then refresh work.";
}

function problem(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Purchasing correction failed. Select Refresh, then try again.";
}
