/**
 * The permission requests that wait for an owner or admin. Each row names
 * who asked, where and for what; Review opens the same Allow prompt that the
 * request's own link opens. A member who cannot decide sees their own
 * requests and who must decide them.
 */
import React from "react";
import { KeyRound, MessageSquareWarning } from "lucide-react";
import type {
  AgentPermissionRequestList,
  AgentPermissionRequestSummary,
  HeldOutputSummary,
} from "@seams/control-api";
import { usePermissionRequests } from "../../permission-requests-summary";

type Props = Readonly<{
  organisationId: string;
  onReview: (requestId: string) => void;
  onReviewHeld: (requestId: string) => void;
}>;

export function PermissionRequestQueue(props: Props): React.ReactNode {
  const list = usePermissionRequests(props.organisationId);
  if (list === null) return null;
  const count = list.requests.length + list.heldOutputs.length;
  if (count === 0) return null;
  const decides = list.mayDecide || list.heldOutputs.length > 0;
  return (
    <section
      className="access35-section permission-request-queue"
      aria-labelledby="permission-request-queue-title"
    >
      <div className="access35-section-heading">
        <div>
          <h2 id="permission-request-queue-title">
            {decides
              ? `${count} permission ${count === 1 ? "request" : "requests"} waiting`
              : `Your permission ${count === 1 ? "request" : "requests"}`}
          </h2>
          <p>
            {decides
              ? "Agents asked for these items in a chat or a Slack thread. Allow or deny each request here."
              : "An owner or admin of this workspace must allow these requests."}
          </p>
        </div>
      </div>
      <PermissionRequestRows
        list={list}
        onReview={props.onReview}
        onReviewHeld={props.onReviewHeld}
      />
    </section>
  );
}

/** One row for each waiting request; Review opens its Allow prompt. */
export function PermissionRequestRows(
  props: Readonly<{
    list: AgentPermissionRequestList;
    onReview: (requestId: string) => void;
    onReviewHeld: (requestId: string) => void;
  }>,
): React.ReactNode {
  const { list } = props;
  return (
    <ul className="permission-request-queue-list">
      {list.heldOutputs.map((held) => (
        <li key={held.requestId}>
          <span className="permission-request-queue-icon" aria-hidden="true">
            <MessageSquareWarning size={18} />
          </span>
          <div className="permission-request-queue-body">
            <p className="permission-request-queue-items">
              {held.effect === null
                ? `An answer waits to go to ${heldDestinationText(held)}`
                : `A step waits: ${held.effect}`}
            </p>
            <p className="permission-request-queue-meta">
              {heldReasonText(held)} · {ageText(held.createdAt)} ·{" "}
              {expiryText(held.expiresAt)}
            </p>
          </div>
          <button
            type="button"
            className="connection-primary-action"
            onClick={props.onReviewHeld.bind(null, held.requestId)}
          >
            Review
          </button>
        </li>
      ))}
      {list.requests.map((request) => (
        <li key={request.requestId}>
          <span className="permission-request-queue-icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <div className="permission-request-queue-body">
            <p className="permission-request-queue-items">
              {request.itemLabels.join(", ")}
            </p>
            <p className="permission-request-queue-meta">
              {requesterText(request)} · {originText(request)} ·{" "}
              {ageText(request.createdAt)} · {expiryText(request.expiresAt)}
            </p>
          </div>
          <button
            type="button"
            className={list.mayDecide ? "connection-primary-action" : undefined}
            onClick={props.onReview.bind(null, request.requestId)}
          >
            {list.mayDecide ? "Review" : "View"}
          </button>
        </li>
      ))}
    </ul>
  );
}

function heldDestinationText(held: HeldOutputSummary): string {
  return held.destination === null ? "a Slack thread" : `#${held.destination}`;
}

function heldReasonText(held: HeldOutputSummary): string {
  switch (held.reason) {
    case "private_source":
      return "It uses private content";
    case "outside_written":
      return "The conversation read text from outside the workspace";
    case "outside_organisation":
      return "It would reach someone outside the workspace";
  }
}

function requesterText(request: AgentPermissionRequestSummary): string {
  const role = request.requesterRole;
  return request.requesterName === null
    ? `A member with the ${role} role`
    : `${request.requesterName} (${role})`;
}

function originText(request: AgentPermissionRequestSummary): string {
  return request.origin === "slack_thread" ? "Slack thread" : "Portal chat";
}

function ageText(createdAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - createdAt) / 60_000));
  if (minutes < 1) return "asked just now";
  if (minutes < 60) return `asked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `asked ${hours} h ago`;
  return `asked ${Math.round(hours / 24)} d ago`;
}

function expiryText(expiresAt: number): string {
  const days = Math.ceil((expiresAt - Date.now()) / 86_400_000);
  return days <= 1 ? "expires today" : `expires in ${days} days`;
}
