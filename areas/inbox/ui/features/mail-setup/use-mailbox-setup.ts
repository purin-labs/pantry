import * as React from "react";
import type { MailboxSetupPlan } from "@purin-labs/control-api";

import type { MailboxSetupState } from "./model";

export type MailboxSetupControl = Readonly<{
  state: MailboxSetupState;
  /**
   * True while a setup is read. The setup on screen can then be an earlier
   * one, so the page offers no action on it.
   */
  reading: boolean;
  retry: () => void;
}>;

/** Reads the setup of one mailbox with the automatic agent choice. */
export type ReadMailboxSetup = (
  integrationAccountId: string,
) => Promise<MailboxSetupPlan>;

/**
 * The setup of one mailbox, read again after each change of the mailbox.
 * `integrationAccountId` is null for a person who cannot change the mailbox:
 * the page then reads nothing.
 *
 * `revision` names the state of the mailbox that the page shows. `settled`
 * is false while a change of the mailbox runs, and the read waits for it.
 */
export function useMailboxSetup(
  read: ReadMailboxSetup,
  integrationAccountId: string | null,
  revision: string,
  settled: boolean,
): MailboxSetupControl {
  const [state, setState] = React.useState<MailboxSetupState>(
    integrationAccountId === null ? { kind: "absent" } : { kind: "loading" },
  );
  const [reading, setReading] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const latestRead = React.useRef(read);
  latestRead.current = read;
  React.useEffect(() => {
    if (integrationAccountId === null) {
      setState({ kind: "absent" });
      return;
    }
    if (!settled) return;
    let current = true;
    // The earlier setup stays on screen while the new one is read.
    setState(keepReady);
    setReading(true);
    latestRead.current(integrationAccountId).then(
      (plan) => {
        if (!current) return;
        setState({ kind: "ready", plan });
        setReading(false);
      },
      () => {
        if (!current) return;
        setState({ kind: "failed" });
        setReading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [integrationAccountId, revision, settled, attempt]);
  const retry = React.useCallback(() => setAttempt(next), []);
  return { state, reading, retry };
}

function keepReady(state: MailboxSetupState): MailboxSetupState {
  return state.kind === "ready" ? state : { kind: "loading" };
}

function next(attempt: number): number {
  return attempt + 1;
}
