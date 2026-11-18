import React from "react";
import { Link } from "react-router";
import { controlRead } from "../../control-client";
import {
  parseInventoryReceiptContext,
  type InventoryReceiptContext,
} from "@seams/control-api";

type Props = Readonly<{
  organisationId: string;
  positionId: string;
  purchasingHref: string;
}>;
type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      purchases: InventoryReceiptContext["purchases"];
    }>;

export class InventoryPurchases extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private controller = new AbortController();
  componentDidMount() {
    void this.load();
  }
  componentWillUnmount() {
    this.controller.abort();
  }
  async load() {
    try {
      const context = parseInventoryReceiptContext(
        await controlRead(
          `/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/commerce/inventory/receipts?position=${encodeURIComponent(this.props.positionId)}`,
        ),
      );
      if (!this.controller.signal.aborted)
        this.setState({ kind: "ready", purchases: context.purchases });
    } catch {
      if (!this.controller.signal.aborted)
        this.setState({ kind: "ready", purchases: { kind: "unavailable" } });
    }
  }
  render(): React.ReactNode {
    return (
      <>
        <h3>Incoming purchases</h3>
        {this.state.kind === "loading" ? (
          <p role="status">Loading purchasing…</p>
        ) : this.state.purchases.kind === "unavailable" ? (
          <p>
            Purchasing data is unavailable.{" "}
            <Link to={this.props.purchasingHref}>Open purchasing setup</Link>
          </p>
        ) : this.state.purchases.entries.length === 0 ? (
          <p>No open purchase requests for this item and location.</p>
        ) : (
          <ul className="stock-linked-records">
            {this.state.purchases.entries.map(renderPurchase)}
          </ul>
        )}
      </>
    );
  }
}

function renderPurchase(
  purchase: Extract<
    InventoryReceiptContext["purchases"],
    { kind: "ready" }
  >["entries"][number],
) {
  return (
    <li key={purchase.id}>
      <strong>{purchase.supplier}</strong>
      <span>
        {purchase.received} received of {purchase.required} requested
      </span>
      <small>{purchase.id}</small>
    </li>
  );
}
