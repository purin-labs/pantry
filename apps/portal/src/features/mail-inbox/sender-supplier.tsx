import { Select } from "../../ui/select";
import React from "react";
import type { MailSenderLink } from "@purin-labs/control-api";
import {
  linkMailSender,
  readMailSenderLink,
  readMailSupplierOptions,
  type MailSupplierOption,
} from "./api";

type Load<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; value: T }>;
type Props = Readonly<{
  organisationId: string;
  accountId: string;
  /** The sender address that the conversation answers. */
  address: string;
  canManage: boolean;
  supplierHref: (supplierId: string) => string;
  suppliersPath: string;
}>;
type State = Readonly<{
  link: Load<MailSenderLink>;
  /** The supplier choice, open only for a person who can manage. */
  /** The suppliers to choose from; null while purchasing is not set up. */
  choice:
    Readonly<{ kind: "closed" }> | Load<readonly MailSupplierOption[] | null>;
  saving: boolean;
  problem: string | null;
  /** The link changed in this view. Its effect is stated one time. */
  linked: boolean;
}>;

/**
 * The supplier that the conversation's sender is linked to. A link makes the
 * sender a verified supplier contact of the mailbox, so a correction of a
 * reply to new mail from the sender can teach Memory about that supplier.
 */
export class MailSenderSupplier extends React.Component<Props, State> {
  state: State = {
    link: { kind: "loading" },
    choice: { kind: "closed" },
    saving: false,
    problem: null,
    linked: false,
  };
  private request: AbortController | null = null;
  private disposed = false;
  private outcome = React.createRef<HTMLParagraphElement>();
  private select = React.createRef<HTMLButtonElement>();
  private trigger = React.createRef<HTMLButtonElement>();
  private choiceNotice = React.createRef<HTMLParagraphElement>();
  private error = React.createRef<HTMLParagraphElement>();
  private choiceRequest = 0;

  componentDidMount(): void {
    this.disposed = false;
    void this.loadLink();
  }
  componentWillUnmount(): void {
    this.disposed = true;
    this.request?.abort();
  }

  private loadLink = async (): Promise<void> => {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({ link: { kind: "loading" } });
    try {
      const value = await readMailSenderLink(
        this.props.organisationId,
        this.props.accountId,
        this.props.address,
        request.signal,
      );
      if (!request.signal.aborted)
        this.setState({ link: { kind: "ready", value } });
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({
          link: { kind: "failed", message: problem(error) },
        });
    }
  };

  private openChoice = async (): Promise<void> => {
    const revision = ++this.choiceRequest;
    this.setState({ choice: { kind: "loading" }, problem: null });
    let choice: State["choice"];
    try {
      choice = {
        kind: "ready",
        value: await readMailSupplierOptions(this.props.organisationId),
      };
    } catch (error) {
      choice = { kind: "failed", message: problem(error) };
    }
    if (!this.disposed && revision === this.choiceRequest)
      this.setState({ choice }, this.focusChoice);
  };

  private closeChoice = (): void => {
    this.choiceRequest += 1;
    this.setState(
      { choice: { kind: "closed" }, problem: null },
      this.focusTrigger,
    );
  };

  private focusTrigger = (): void => {
    this.trigger.current?.focus();
  };

  private save = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const link = this.state.link;
    const supplierId = new FormData(event.currentTarget).get("supplier");
    if (link.kind !== "ready" || typeof supplierId !== "string") return;
    this.setState({ saving: true, problem: null });
    try {
      const value = await linkMailSender(
        this.props.organisationId,
        this.props.accountId,
        {
          address: this.props.address,
          supplierId,
          expectedRevision: link.value.revision,
        },
      );
      if (this.disposed) return;
      this.setState(
        {
          link: { kind: "ready", value },
          choice: { kind: "closed" },
          saving: false,
          linked: true,
        },
        this.focusOutcome,
      );
    } catch (error) {
      if (!this.disposed)
        this.setState(
          { saving: false, problem: problem(error) },
          this.focusChoice,
        );
    }
  };

  private focusChoice = (): void => {
    const target =
      this.error.current ?? this.select.current ?? this.choiceNotice.current;
    target?.focus();
  };
  private focusOutcome = (): void => {
    this.outcome.current?.focus();
  };

  private renderChoice(link: MailSenderLink): React.ReactNode {
    const choice = this.state.choice;
    if (!this.props.canManage) return null;
    switch (choice.kind) {
      case "closed":
        return (
          <button type="button" onClick={this.openChoice} ref={this.trigger}>
            {link.supplier === null
              ? "Link sender to a supplier"
              : "Change supplier"}
          </button>
        );
      case "loading":
        return (
          <div>
            <p role="status">Loading suppliers…</p>
            <button type="button" onClick={this.closeChoice}>
              Cancel
            </button>
          </div>
        );
      case "failed":
        return (
          <div className="mail-conversation-problem">
            <p role="alert" ref={this.error} tabIndex={-1}>
              {choice.message}
            </p>
            <button type="button" onClick={this.openChoice}>
              Try again
            </button>
            <button type="button" onClick={this.closeChoice}>
              Cancel
            </button>
          </div>
        );
      case "ready":
        break;
    }
    // Without a supplier to choose, the row says where suppliers come from,
    // and Cancel returns it to the link state.
    if (choice.value === null || choice.value.length === 0)
      return (
        <div className="mail-sender-supplier-empty">
          <p className="mail-inbox-note" ref={this.choiceNotice} tabIndex={-1}>
            {choice.value === null ? (
              <>
                Suppliers come from purchasing, which is not set up yet.{" "}
                <a href={this.props.suppliersPath}>Set up purchasing</a>
              </>
            ) : (
              <>
                No suppliers exist yet.{" "}
                <a href={this.props.suppliersPath}>Add a supplier</a>
              </>
            )}
          </p>
          <button type="button" onClick={this.closeChoice}>
            Cancel
          </button>
        </div>
      );
    const busy = this.state.saving;
    return (
      <form className="mail-sender-supplier-form" onSubmit={this.save}>
        <label>
          <span>Supplier</span>
          <Select.Root
            name="supplier"
            required
            disabled={busy}
            items={choice.value.map(optionItem)}
            defaultValue={
              link.supplier?.supplierId ?? choice.value[0]?.supplierId ?? null
            }
          >
            <Select.Trigger
              ref={this.select}
              aria-describedby="mail-sender-supplier-hint"
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{choice.value.map(renderOption)}</Select.Popup>
          </Select.Root>
        </label>
        <p className="mail-inbox-note" id="mail-sender-supplier-hint">
          New mail from {this.props.address} uses the link.
        </p>
        {this.state.problem === null ? null : (
          <p role="alert" ref={this.error} tabIndex={-1}>
            {this.state.problem}
          </p>
        )}
        <div className="mail-sender-supplier-actions">
          <button
            type="submit"
            className="connection-primary-action"
            disabled={busy}
          >
            {busy ? "Linking…" : "Link sender"}
          </button>
          <button type="button" onClick={this.closeChoice} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  render(): React.ReactNode {
    const link = this.state.link;
    return (
      <section
        className="mail-details-section mail-sender-supplier"
        aria-labelledby="mail-sender-supplier-title"
      >
        <h4 id="mail-sender-supplier-title">Supplier</h4>
        {link.kind === "loading" ? (
          <p role="status" className="mail-inbox-note">
            Reading the supplier link…
          </p>
        ) : null}
        {link.kind === "failed" ? (
          <div className="mail-conversation-problem">
            <p role="alert">{link.message}</p>
            <button type="button" onClick={this.loadLink}>
              Try again
            </button>
          </div>
        ) : null}
        {link.kind === "ready" ? (
          <>
            <p
              className="mail-sender-supplier-state"
              ref={this.outcome}
              tabIndex={-1}
            >
              {link.value.supplier === null ? (
                "Not linked to a supplier."
              ) : (
                <>
                  Linked to{" "}
                  <a
                    href={this.props.supplierHref(
                      link.value.supplier.supplierId,
                    )}
                  >
                    {link.value.supplier.name ?? link.value.supplier.supplierId}
                  </a>
                  .
                </>
              )}
            </p>
            {this.state.linked && this.state.choice.kind === "closed" ? (
              <p className="mail-inbox-note" role="status">
                New mail from this address uses the link.
              </p>
            ) : null}
            {this.renderChoice(link.value)}
          </>
        ) : null}
      </section>
    );
  }
}

function optionItem(
  option: MailSupplierOption,
): Readonly<{ value: string; label: string }> {
  return { value: option.supplierId, label: option.name };
}

function renderOption(option: MailSupplierOption): React.ReactNode {
  return (
    <Select.Item key={option.supplierId} value={option.supplierId}>
      {option.name}
    </Select.Item>
  );
}

function problem(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Pantry could not complete this request. Try again.";
}
