import React from "react";
import { createRoot } from "react-dom/client";
import { Package, RotateCcw, Workflow } from "lucide-react";
import { CommerceActionTrace } from "@purin-labs/area-commerce/ui/features/governed-actions/commerce-trace";
import {
  parseCommerceActionExecutionResponse,
  type CommerceActionRecord,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import "@purin-labs/surface-portal/ui/styles.css";
import "./operations-trace-preview.css";

type ExampleState =
  | "approval_requested"
  | "signed"
  | "executing"
  | "indeterminate"
  | "confirmed"
  | "rejected";
type State = { readonly commerce: ExampleState; readonly revision: number };

/** The preview feeds sample records to the same component as the commerce review. */
function sampleAction(state: ExampleState): CommerceActionRecord {
  const receipt = sampleReceipt(state);
  const action = {
    nonce: { value: "action_preview_1048" },
    caseId: "case_preview_1048",
    proposalId: "proposal_preview_1048",
    state,
    verb: "commerce.order.cancel",
    resourceKey: "order:1048",
    amount: { value: 8400, currency: "JPY" },
    commerceSystem: { kind: "commerce_system", system: "shopify", revision: 1 },
    details: {
      kind: "cancel_order",
      resourceId: "1048",
      expectedRevision: 1,
      reason: "customer_requested",
      refund: "full",
      restock: false,
      notifyCustomer: true,
      note: null,
      execution: { kind: "provider_managed" },
    },
    providerResult: receipt === null ? null : JSON.stringify(receipt),
  };
  return parseCommerceActionExecutionResponse(
    state === "indeterminate"
      ? { ok: false, error: "commerce_action_reconciliation_pending", action }
      : { ok: true, action },
  );
}
function sampleReceipt(state: ExampleState): CommerceProviderReceipt | null {
  if (state !== "confirmed" && state !== "indeterminate") return null;
  return {
    kind: "commerce_provider_receipt",
    provider: "shopify",
    receiptId: "receipt_preview_1048",
    effectId: "effect_preview_1048",
    actionNonce: "action_preview_1048",
    eventId: null,
    resourceId: "1048",
    projectionKind: "commerce_order",
    revision: 2,
    status: state === "confirmed" ? "accepted" : "indeterminate",
    jobId: "job_preview_1048",
    jobDone: state === "confirmed" ? true : null,
    errors: [],
    observedAt: "2026-10-16T00:00:00Z",
    flowBindingDigest: "0".repeat(64),
    decisionDigest: "1".repeat(64),
  };
}
class OperationsPreview extends React.Component<object, State> {
  state: State = { commerce: "approval_requested", revision: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  componentWillUnmount(): void {
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
  private reset(): void {
    this.clearTimer();
    this.setState({
      commerce: "approval_requested",
      revision: this.state.revision + 1,
    });
  }
  private approve(): void {
    if (this.state.commerce === "approval_requested")
      this.setState({ commerce: "signed" });
  }
  private reject(): void {
    if (this.state.commerce === "approval_requested")
      this.setState({ commerce: "rejected" });
  }
  private execute(): void {
    if (this.state.commerce !== "signed") return;
    this.setState({ commerce: "executing" });
    this.timer = setTimeout(this.unknown.bind(this), 1600);
  }
  private unknown(): void {
    this.setState({ commerce: "indeterminate" });
  }
  private reconcile(): void {
    if (this.state.commerce === "indeterminate")
      this.setState({ commerce: "confirmed" });
  }
  private controls(): React.ReactNode {
    switch (this.state.commerce) {
      case "approval_requested":
        return (
          <>
            <button className="ops-primary" onClick={this.approve.bind(this)}>
              Approve example
            </button>
            <button className="ops-reset" onClick={this.reject.bind(this)}>
              Decline example
            </button>
          </>
        );
      case "signed":
        return (
          <button className="ops-primary" onClick={this.execute.bind(this)}>
            Apply example
          </button>
        );
      case "indeterminate":
        return (
          <button className="ops-primary" onClick={this.reconcile.bind(this)}>
            Simulate receipt recovery
          </button>
        );
      case "executing":
      case "confirmed":
      case "rejected":
        return null;
    }
  }
  render(): React.ReactNode {
    return (
      <main className="ops-preview">
        <header className="ops-header">
          <div>
            <div className="ops-eyebrow">PURIN PANTRY / OPERATIONS</div>
            <h1>From request to receipt.</h1>
            <p>The production components, with local example data.</p>
          </div>
          <button className="ops-reset" onClick={this.reset.bind(this)}>
            <RotateCcw size={15} />
            Reset examples
          </button>
        </header>
        <p className="ops-mock-note">
          Commerce uses sample records. Robot tasks run in the local simulation
          worker. No external actions occur.
        </p>
        <div className="ops-grid">
          <article className="ops-card">
            <header className="ops-card-header">
              <div className="ops-context">
                <Package size={16} />
                ECOMMERCE<span>Example order #1048</span>
              </div>
              <h2>Cancel and refund an order</h2>
              <p>
                Review the change, approve it, and inspect its recorded outcome.
              </p>
            </header>
            <div className="ops-body">
              <CommerceActionTrace
                key={this.state.revision}
                action={sampleAction(this.state.commerce)}
                controls={this.controls()}
                change={
                  <dl className="operations-trace-facts">
                    <dt>Order</dt>
                    <dd>#1048 · Financier gift boxes</dd>
                    <dt>Refund</dt>
                    <dd>Full refund · ¥8,400</dd>
                    <dt>Restock</dt>
                    <dd>No</dd>
                    <dt>Notification</dt>
                    <dd>Requested from the commerce provider</dd>
                  </dl>
                }
              />
            </div>
            <footer className="ops-footer">
              <p>
                Approval and execution are separate. A provider receipt does not
                prove that a customer notification arrived.
              </p>
            </footer>
          </article>
          <article className="ops-card">
            <header className="ops-card-header">
              <div className="ops-context">
                <Workflow size={16} />
                ROBOT ORCHESTRATION<span>Simulation</span>
              </div>
              <h2>Transfer, interrupt, recover</h2>
              <p>
                Follow two tray transfers, or recover a failed transfer with an
                operator.
              </p>
            </header>
            <RobotSimulationPreview key={this.state.revision} />
          </article>
        </div>
      </main>
    );
  }
}
class RobotSimulationPreview extends React.Component {
  private frame = React.createRef<HTMLIFrameElement>();
  private observer: ResizeObserver | null = null;
  componentWillUnmount(): void {
    this.observer?.disconnect();
  }
  private loaded(): void {
    this.observer?.disconnect();
    const root = this.frame.current?.contentDocument?.getElementById("root");
    if (!root) return;
    this.observer = new ResizeObserver(this.resize.bind(this));
    this.observer.observe(root);
    this.resize();
  }
  private resize(): void {
    const frame = this.frame.current;
    const root = frame?.contentDocument?.getElementById("root");
    if (frame && root)
      frame.style.height = `${Math.ceil(root.getBoundingClientRect().height) + 2}px`;
  }
  render(): React.ReactNode {
    return (
      <iframe
        ref={this.frame}
        className="ops-simulation"
        src="/production-run-preview.html"
        title="Local robot simulation"
        onLoad={this.loaded.bind(this)}
      />
    );
  }
}
function App(): React.ReactNode {
  usePortalTheme();
  return <OperationsPreview />;
}
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Operations preview is development-only.");
createRoot(root).render(<App />);
