import React from "react";
import { registerBakeryWorkspaceReveal } from "./bakery-surface-registry";

type Props = Readonly<{
  organisationId: string;
  currentPageIsBakery: boolean;
  chatOpen: boolean;
  children: React.ReactNode;
  bakery: React.ReactNode;
}>;

type State =
  | Readonly<{ kind: "unmounted"; visibility?: never }>
  | Readonly<{ kind: "mounted"; visibility: "retained" | "revealed" }>;

export class BakeryWorkspaceReveal extends React.Component<Props, State> {
  state: State = { kind: "unmounted" };
  private unregister: (() => void) | null = null;
  private readonly departing = React.createRef<HTMLDivElement>();
  private readonly back = React.createRef<HTMLButtonElement>();
  private previousFocus: HTMLElement | null = null;

  componentDidMount(): void {
    this.unregister = registerBakeryWorkspaceReveal(
      this.props.organisationId,
      this.reveal.bind(this),
    );
    if (this.props.currentPageIsBakery)
      this.setState({ kind: "mounted", visibility: "retained" });
  }

  componentDidUpdate(previous: Props, previousState: State): void {
    if (this.state.kind === "unmounted" && this.props.currentPageIsBakery)
      this.setState({ kind: "mounted", visibility: "retained" });
    if (
      previous.chatOpen &&
      !this.props.chatOpen &&
      this.state.kind === "mounted"
    )
      this.setState({ kind: "mounted", visibility: "retained" });
    if (
      previousState.visibility !== "revealed" &&
      this.state.visibility === "revealed" &&
      this.previousFocus !== null
    )
      this.back.current?.focus();
  }

  componentWillUnmount(): void {
    this.unregister?.();
  }

  private reveal(): Promise<void> {
    if (!this.props.chatOpen)
      return Promise.reject(new Error("The initiating chat is closed."));
    if (this.departing.current?.querySelector("dialog[open]"))
      return Promise.reject(
        new Error(
          "Finish or close the current page's open dialog before loading Kitchen.",
        ),
      );
    const focused = document.activeElement;
    if (this.state.visibility !== "revealed")
      this.previousFocus =
        focused instanceof HTMLElement &&
        this.departing.current?.contains(focused)
          ? focused
          : null;
    return new Promise<void>(this.commitReveal.bind(this));
  }

  private commitReveal(resolve: () => void): void {
    this.setState({ kind: "mounted", visibility: "revealed" }, resolve);
  }

  private close(): void {
    this.setState(
      { kind: "mounted", visibility: "retained" },
      this.restoreFocus.bind(this),
    );
  }

  private restoreFocus(): void {
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }

  render(): React.ReactNode {
    const revealed = this.state.visibility === "revealed";
    const visible = this.props.currentPageIsBakery || revealed;
    return (
      <>
        <div
          ref={this.departing}
          className="bakery-workspace-region"
          hidden={visible}
        >
          {this.props.children}
        </div>
        <div className="bakery-workspace-region" hidden={!visible}>
          {revealed && !this.props.currentPageIsBakery ? (
            <button
              ref={this.back}
              type="button"
              className="button subtle bakery-workspace-return"
              onClick={this.close.bind(this)}
            >
              Return to current page
            </button>
          ) : null}
          {this.state.kind === "mounted" || this.props.currentPageIsBakery
            ? this.props.bakery
            : null}
        </div>
      </>
    );
  }
}
