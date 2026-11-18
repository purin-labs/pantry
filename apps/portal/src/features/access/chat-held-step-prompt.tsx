/**
 * Opens the permission prompt of a step that the exit check stopped in this
 * chat (Plan 27C), so that the person decides in place instead of in the
 * account menu. The request also stays under Permission requests.
 */
import React from "react";

import {
  refreshPermissionRequests,
  usePermissionRequests,
} from "../../permission-requests-summary";
import { HeldOutputPrompt } from "./held-output-prompt";

type Props = Readonly<{
  organisationId: string;
  conversationId: string;
  workspaceName: string;
  /** Changes when a turn of the chat starts or ends, to read the list again. */
  workKey: string;
}>;

export function ChatHeldStepPrompt(props: Props): React.ReactNode {
  const { organisationId, conversationId, workKey } = props;
  const list = usePermissionRequests(organisationId);
  const [open, setOpen] = React.useState<string | null>(null);
  const [closed, setClosed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  React.useEffect(() => {
    void refreshPermissionRequests(organisationId);
  }, [organisationId, conversationId, workKey]);
  const waiting =
    [...(list?.heldOutputs ?? [])]
      .reverse()
      .find(
        (held) =>
          held.conversationId === conversationId && !closed.has(held.requestId),
      ) ?? null;
  const waitingId = waiting?.requestId ?? null;
  React.useEffect(() => {
    if (open === null && waitingId !== null) setOpen(waitingId);
  }, [open, waitingId]);
  if (open === null) return null;
  const close = (): void => {
    setClosed((previous) => new Set(previous).add(open));
    setOpen(null);
  };
  return (
    <HeldOutputPrompt
      key={open}
      organisationId={organisationId}
      requestId={open}
      workspaceName={props.workspaceName}
      onClose={close}
      onDecided={() => refreshPermissionRequests(organisationId)}
    />
  );
}
