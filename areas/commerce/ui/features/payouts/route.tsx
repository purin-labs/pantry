import React from "react";
import { toast } from "sonner";

import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { formatMoneyMinor } from "@purin-labs/ui/formatting";
import { RecoverableError } from "@purin-labs/ui/page-components";
import { ViewSwitch } from "@purin-labs/ui/index";
import {
  needsOperator,
  payoutGuidance,
  readPayoutExceptions,
  readUnresolvedPayouts,
  supplierPayoutAuditPath,
} from "./api";
import type { PayoutMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/payouts/transport";
import type {
  PayoutAuditEvent,
  SupplierPayout,
} from "@purin-labs/control-api/portal/payouts";
import {
  PayoutReadPermission,
  type PayoutReadAccess,
  type PayoutReadRole,
} from "./read-permission";
import { PayoutTimeline } from "./payout-lanes";
import "./styles.css";

const PAYOUT_VIEWS = [
  { view: "queue", name: "Outstanding" },
  { view: "timeline", name: "Timeline" },
] as const;

type PayoutsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  /** No payout read grant admits this person, so the figures stay hidden. */
  | Readonly<{ kind: "not_permitted" }>
  | Readonly<{
      kind: "ready";
      payouts: readonly SupplierPayout[];
      exceptions: readonly PayoutAuditEvent[];
    }>;

/**
 * Money on its way out of the merchant.
 *
 * The default view is the work queue, not a ledger: everything whose outcome
 * Pantry does not yet know. A settled payout needs nobody's attention, and
 * putting it in the same list as an unresolved one buries the thing that does.
 *
 * No approval or send control lives here. Approving is a separate act by a
 * separate person and belongs on its own surface with the full economics in
 * front of the approver; a one-click approve in a list is how someone
 * authorizes a number they did not read.
 */
export function SupplierPayoutsPanel(props: {
  readonly organisationId: string;
  readonly workspaceName: string;
  /** The role whose payout reads this person may allow, or null. */
  readonly accessRole: PayoutReadRole | null;
  readonly access: PayoutReadAccess;
  readonly mutate: PayoutMutationTransport;
  /** In a tab that names it: the heading is for screen readers only. */
  readonly inTab?: boolean;
  /** Whether this person may read payouts, and how many wait on someone. */
  readonly onStatus?: (
    status: Readonly<{ readable: boolean; attention: number }>,
  ) => void;
}): React.ReactNode {
  const [state, setState] = React.useState<PayoutsState>({ kind: "loading" });
  const { onStatus } = props;
  React.useEffect(() => {
    onStatus?.(payoutPanelStatus(state, props.accessRole !== null));
  }, [onStatus, state, props.accessRole]);
  const [asking, setAsking] = React.useState(false);
  const [reads, setReads] = React.useState(0);
  const [display, setDisplay] = React.useState<"queue" | "timeline">("queue");

  React.useEffect(
    loadPayoutsEffect.bind(null, props.organisationId, setState),
    [props.organisationId, reads],
  );
  const closePrompt = React.useCallback(() => setAsking(false), []);
  const readAgain = React.useCallback(() => {
    setAsking(false);
    setReads((count) => count + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <section className="payout-panel payout-panel-quiet">
        Loading payouts…
      </section>
    );
  }
  if (state.kind === "failed") {
    return (
      <RecoverableError
        message={state.message}
        action={
          <button type="button" onClick={readAgain}>
            Retry payouts
          </button>
        }
      />
    );
  }
  if (state.kind === "not_permitted") {
    // Most people on the Suppliers page never need payouts; only the people
    // who manage access are told why the panel is missing, and may allow it.
    if (props.accessRole === null) return null;
    return (
      <section className="payout-panel payout-panel-quiet payout-panel-hidden">
        <span>
          Supplier payouts are hidden. Your role is not allowed to read them.
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setAsking(true)}
        >
          Allow payout reads
        </button>
        <PayoutReadPermission
          organisationId={props.organisationId}
          workspaceName={props.workspaceName}
          role={props.accessRole}
          access={props.access}
          open={asking}
          onClose={closePrompt}
          onAllowed={readAgain}
        />
      </section>
    );
  }
  const displaySwitch = (
    <ViewSwitch
      label="Show payouts as"
      value={display}
      views={PAYOUT_VIEWS}
      onChange={setDisplay}
    />
  );
  if (
    display === "queue" &&
    state.payouts.length === 0 &&
    state.exceptions.length === 0
  ) {
    return (
      <section className="payout-panel payout-panel-quiet payout-panel-hidden">
        <span>No outstanding supplier payouts.</span>
        {displaySwitch}
      </section>
    );
  }

  const waiting = state.payouts.filter(needsOperator);
  // These stay in both views: a person on the timeline still needs to know.
  const heading = (
    <header className="payout-panel-heading">
      <h2 className={props.inTab === true ? "visually-hidden" : undefined}>
        Supplier payouts
      </h2>
      <div className="payout-panel-badges">
        {displaySwitch}
        {state.exceptions.length === 0 ? null : (
          <span className="payout-badge payout-badge-attention">
            {state.exceptions.length}{" "}
            {state.exceptions.length === 1
              ? "evidence conflict"
              : "evidence conflicts"}
          </span>
        )}
        {waiting.length === 0 ? null : (
          <span className="payout-badge payout-badge-attention">
            {waiting.length} waiting on someone
          </span>
        )}
      </div>
    </header>
  );
  if (display === "timeline") {
    return (
      <section className="payout-panel">
        {heading}
        <PayoutTimeline organisationId={props.organisationId} />
      </section>
    );
  }
  return (
    <section className="payout-panel">
      {heading}
      {state.exceptions.length === 0 ? null : (
        <PayoutExceptions events={state.exceptions} />
      )}
      <ul className="payout-list">
        {state.payouts.map((payout) => (
          <li key={payout.payoutId} className="payout-row">
            <div className="payout-row-identity">
              <span className="payout-row-supplier">{payout.supplierId}</span>
              <span className="payout-row-amount">
                {formatMoneyMinor(payout.recipientAmountMinor, payout.currency)}
              </span>
            </div>
            <p className="payout-row-state">
              <span className={`payout-badge payout-badge-${toneFor(payout)}`}>
                {labelFor(payout)}
              </span>
              {/* "Needs approval" already says that it is not approved. */}
              {payout.approved || payout.state === "approval_pending" ? null : (
                <span className="payout-badge payout-badge-quiet">
                  Not approved
                </span>
              )}
              {payoutGuidance(payout)}
            </p>
            <p className="payout-row-detail">
              {railLabel(payout.rail)} · payable {payout.payableId} ·{" "}
              <a
                href={supplierPayoutAuditPath(
                  props.organisationId,
                  payout.payoutId,
                )}
              >
                Download audit
              </a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PayoutExceptions(props: {
  readonly events: readonly PayoutAuditEvent[];
}): React.ReactNode {
  return (
    <section
      className="payout-exceptions"
      aria-labelledby="payout-exceptions-title"
    >
      <div>
        <h3 id="payout-exceptions-title">Evidence conflicts</h3>
        <p>
          These provider records contradict stored payout evidence. The payable
          stays blocked while they are investigated.
        </p>
      </div>
      <ul className="payout-exception-list">
        {props.events.map(renderPayoutException)}
      </ul>
    </section>
  );
}

function renderPayoutException(event: PayoutAuditEvent): React.ReactNode {
  return (
    <li
      key={`${event.providerEventId}:${event.cursor}`}
      className="payout-exception-row"
    >
      <div className="payout-row-identity">
        <span className="payout-row-supplier">
          {event.observationKind.replaceAll("_", " ")}
        </span>
        <span className="payout-row-amount">
          {formatMoneyMinor(event.amountMinor, event.currency)}
        </span>
      </div>
      <span className="payout-row-detail">
        {event.targetKind} {event.targetId} · {railLabel(event.rail)} ·{" "}
        {formatEventTime(event.occurredAt)}
      </span>
      <span className="payout-row-detail">
        Provider event {event.providerEventId}
      </span>
    </li>
  );
}

function formatEventTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function labelFor(payout: SupplierPayout): string {
  switch (payout.state) {
    case "approval_pending":
      return "Needs approval";
    case "approved":
      return "Ready to send";
    case "submitting":
      return "Sending";
    case "provider_action_required":
      return "Bank action needed";
    case "provider_pending":
      return "With the provider";
    case "settled":
      return "Sent";
    case "return_pending":
      return "Being returned";
    case "returned":
      return "Returned";
    case "reversal_pending":
      return "Being reversed";
    case "reversed":
      return "Reversed";
    case "failed":
      return "Refused";
    case "indeterminate":
      return "Unknown";
    case "cancelled":
      return "Cancelled";
  }
}

function toneFor(
  payout: SupplierPayout,
): "settled" | "moving" | "attention" | "quiet" {
  switch (payout.state) {
    case "settled":
      return "settled";
    case "submitting":
    case "provider_pending":
    case "return_pending":
    case "reversal_pending":
      return "moving";
    case "approval_pending":
    case "provider_action_required":
    case "indeterminate":
    case "failed":
    case "returned":
    case "reversed":
      return "attention";
    case "approved":
    case "cancelled":
      return "quiet";
  }
}

function railLabel(rail: SupplierPayout["rail"]): string {
  return rail === "gmo_aozora_private" ? "GMO Aozora" : "Wise";
}

function loadPayoutsEffect(
  organisationId: string,
  setState: (state: PayoutsState) => void,
): () => void {
  setState({ kind: "loading" });
  let cancelled = false;
  Promise.all([
    readUnresolvedPayouts(organisationId),
    readPayoutExceptions(organisationId),
  ]).then(
    (loaded) => {
      if (!cancelled)
        setState({
          kind: "ready",
          payouts: loaded[0],
          exceptions: loaded[1].events,
        });
    },
    (cause: unknown) => {
      if (cancelled) return;
      if (
        cause instanceof ControlApiError &&
        cause.kind === "supplier_payout_read_unavailable"
      ) {
        setState({ kind: "not_permitted" });
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Payouts are unavailable.";
      setState({ kind: "failed", message });
      toast.error(message);
    },
  );
  return () => {
    cancelled = true;
  };
}

/**
 * A person who may not read payouts and cannot allow the reads has nothing
 * to see in the Payouts tab. A payout waits on someone when it needs an
 * operator, and an evidence conflict always does.
 */
function payoutPanelStatus(
  state: PayoutsState,
  canAllowReads: boolean,
): Readonly<{ readable: boolean; attention: number }> {
  if (state.kind === "not_permitted")
    return { readable: canAllowReads, attention: 0 };
  if (state.kind !== "ready") return { readable: true, attention: 0 };
  return {
    readable: true,
    attention:
      state.payouts.filter(needsOperator).length + state.exceptions.length,
  };
}
