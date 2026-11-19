import * as React from "react";
import {
  encodeMailboxSetupAgentChoice,
  type MailboxSetupAgentChoice,
  type MailboxSetupPlan,
} from "@purin-labs/control-api";

import type { MailboxSetupState } from "./model";

export type MailboxSetupControl = Readonly<{
  state: MailboxSetupState;
  /**
   * True while a setup is read. The setup on screen can then be the one of
   * an earlier choice, so the page offers no action on it.
   */
  reading: boolean;
  /** The agent the person chose. The setup settles `automatic` by itself. */
  choice: MailboxSetupAgentChoice;
  choose: (choice: MailboxSetupAgentChoice) => void;
  retry: () => void;
}>;

type ReadMailboxSetup = (
  integrationAccountId: string,
  choice: MailboxSetupAgentChoice,
) => Promise<MailboxSetupPlan>;

/**
 * The setup of one mailbox, read again when the person chooses another agent
 * and after each change of the mailbox. `integrationAccountId` is null for a
 * person who cannot change the mailbox: the page then reads nothing.
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
  const [choice, choose] = React.useState<MailboxSetupAgentChoice>({
    kind: "automatic",
  });
  const [state, setState] = React.useState<MailboxSetupState>(
    integrationAccountId === null ? { kind: "absent" } : { kind: "loading" },
  );
  const [reading, setReading] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const latestRead = React.useRef(read);
  latestRead.current = read;
  const chosen = encodeMailboxSetupAgentChoice(choice);
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
    latestRead.current(integrationAccountId, choice).then(
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
    // `chosen` stands for `choice`, which is a new object on each render.
  }, [integrationAccountId, chosen, revision, settled, attempt]);
  const retry = React.useCallback(() => setAttempt(next), []);
  return { state, reading, choice, choose, retry };
}

function keepReady(state: MailboxSetupState): MailboxSetupState {
  return state.kind === "ready" ? state : { kind: "loading" };
}

function next(attempt: number): number {
  return attempt + 1;
}
