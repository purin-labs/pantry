import React from "react";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceActivityCaseState,
  CommerceActivityResult,
} from "@purin-labs/commerce-control-api/portal/entity-plane";
import { formatCommerceTimestamp } from "./presentation";
import "./activity-panel.css";

/**
 * The Activity section of a record page: what happened to the record, as one
 * framed list with the time at the end of each row.
 */

export type CommerceActivityRouteState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; result: CommerceActivityResult }>
  | Readonly<{ kind: "unavailable" }>;

export function CommerceActivityPanel(
  props: Readonly<{
    activity: CommerceActivityRouteState;
  }>,
): React.ReactNode {
  return (
    <section
      className="commerce-dossier-section"
      aria-labelledby="commerce-activity-title"
    >
      <h3 id="commerce-activity-title">Activity</h3>
      {renderCommerceActivityContent(props.activity)}
    </section>
  );
}

function renderCommerceActivityContent(
  activity: CommerceActivityRouteState,
): React.ReactNode {
  switch (activity.kind) {
    case "loading":
      return <p className="empty-state commerce-empty">Loading activity…</p>;
    case "unavailable":
      return (
        <p className="empty-state commerce-empty">Activity is unavailable.</p>
      );
    case "ready":
      return (
        <>
          {activity.result.events.length === 0 ? (
            <p className="empty-state commerce-empty">No activity yet.</p>
          ) : (
            <ol className="commerce-activity-list">
              {activity.result.events.map(renderCommerceActivityEvent)}
            </ol>
          )}
          {activity.result.unsupportedSources.length === 0 ? null : (
            <p className="commerce-activity-note">
              Some history could not be loaded, so this list may be incomplete.
            </p>
          )}
        </>
      );
    default:
      return assertNever(activity, "Unhandled commerce graph value");
  }
}

function renderCommerceActivityEvent(
  event: CommerceActivityResult["events"][number],
): React.ReactNode {
  return (
    <li key={commerceActivityEventKey(event)}>
      <strong>{commerceActivityEventLabel(event)}</strong>
      <time dateTime={event.occurredAt}>
        {formatCommerceTimestamp(event.occurredAt)}
      </time>
    </li>
  );
}

function commerceActivityEventKey(
  event: CommerceActivityResult["events"][number],
): string {
  switch (event.kind) {
    case "blotter_history":
      return `${event.kind}:${event.eventId}`;
    case "case":
      return `${event.kind}:${event.caseId}`;
    case "proposal":
      return `${event.kind}:${event.proposalId}`;
    case "approval":
      return `${event.kind}:${event.approvalId}`;
    case "entity_plane_effect":
      return `${event.kind}:${event.effect.receipt.commandId}`;
    case "commerce_observation":
      return `${event.kind}:${event.deliveryId}`;
    case "commerce_receipt":
      return `${event.kind}:${event.receiptId}`;
    case "action_ledger":
      return `${event.kind}:${event.actionNonce}`;
    default:
      return assertNever(event, "Unhandled commerce graph value");
  }
}

/**
 * What happened, said the way an operator would say it. The identifiers and
 * receipts that prove it live in each row's technical details.
 */
function commerceActivityEventLabel(
  event: CommerceActivityResult["events"][number],
): string {
  switch (event.kind) {
    case "blotter_history":
      return "Update received from the connected system";
    case "case":
      return `Conversation ${commerceCaseStateLabel(event.state)}`;
    case "proposal":
      return `Change ${commerceActionStateLabel(event.state)}`;
    case "approval":
      return event.state === "waiting"
        ? "Waiting for approval"
        : "Approval decided";
    case "entity_plane_effect":
      return "Record changed";
    case "commerce_observation":
      return "Change recorded";
    case "commerce_receipt":
      return "Change confirmed";
    case "action_ledger":
      return `Governed change ${commerceActionStateLabel(event.state)}`;
    default:
      return assertNever(event, "Unhandled commerce graph value");
  }
}

function commerceCaseStateLabel(state: CommerceActivityCaseState): string {
  switch (state) {
    case "open":
      return "opened";
    case "waiting":
      return "waiting";
    default:
      return assertNever(state, "Unhandled commerce graph value");
  }
}

function commerceActionStateLabel(state: string): string {
  switch (state) {
    case "proposed":
      return "proposed";
    case "approval_requested":
      return "waiting for approval";
    case "signed":
      return "approved";
    case "executing":
      return "being applied";
    case "confirmed":
      return "applied";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "indeterminate":
      return "needs review";
    default:
      return state;
  }
}
