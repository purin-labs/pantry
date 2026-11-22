/**
 * Every permission request that waits in this workspace, from the account
 * menu on any page. Review opens the same Allow prompt as the request's own
 * link, so a person never has to find the setting on the Access page.
 */
import React from "react";
import { X } from "lucide-react";

import {
  refreshPermissionRequests,
  usePermissionRequests,
} from "./permission-requests-summary";
import { AgentPermissionRequestPrompt } from "./agent-permission-request";
import { HeldOutputPrompt } from "./held-output-prompt";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import { PermissionRequestRows } from "./permission-request-queue";
import "./permission-requests-drawer.css";

type Props = Readonly<{
  organisationId: string;
  workspaceName: string;
  access: Pick<AccessRouteTransport, "read" | "mutate">;
  onClose: () => void;
}>;

export default function PermissionRequestsDrawer(
  props: Props,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const headingId = React.useId();
  const [reviewed, setReviewed] = React.useState<string | null>(null);
  const [reviewedHeld, setReviewedHeld] = React.useState<string | null>(null);
  const list = usePermissionRequests(props.organisationId);
  React.useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);
  return (
    <>
      <dialog
        ref={dialog}
        className="permission-requests-drawer"
        aria-labelledby={headingId}
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
        onCancel={(event) => {
          event.preventDefault();
          props.onClose();
        }}
      >
        <header className="permission-requests-drawer-header">
          <h2 id={headingId}>Permission requests</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={props.onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="permission-requests-drawer-body">
          {list === null ? (
            <p className="permission-requests-drawer-note">Loading requests…</p>
          ) : list.requests.length + list.heldOutputs.length === 0 ? (
            <p className="permission-requests-drawer-note">
              No permission requests wait. When an agent needs a permission, its
              request shows here and in the chat or Slack thread where it asked.
            </p>
          ) : (
            <>
              <p className="permission-requests-drawer-note">
                {list.mayDecide || list.heldOutputs.length > 0
                  ? "Agents asked for these items in a chat or a Slack thread. Review each request to allow or deny it."
                  : "An owner or admin of this workspace must allow these requests."}
              </p>
              <PermissionRequestRows
                list={list}
                onReview={setReviewed}
                onReviewHeld={setReviewedHeld}
              />
            </>
          )}
        </div>
      </dialog>
      {reviewed === null ? null : (
        <AgentPermissionRequestPrompt
          key={reviewed}
          organisationId={props.organisationId}
          requestId={reviewed}
          workspaceName={props.workspaceName}
          access={props.access}
          onClose={setReviewed.bind(null, null)}
          onDecided={() => refreshPermissionRequests(props.organisationId)}
        />
      )}
      {reviewedHeld === null ? null : (
        <HeldOutputPrompt
          key={reviewedHeld}
          organisationId={props.organisationId}
          requestId={reviewedHeld}
          workspaceName={props.workspaceName}
          onClose={setReviewedHeld.bind(null, null)}
          onDecided={() => refreshPermissionRequests(props.organisationId)}
        />
      )}
    </>
  );
}
