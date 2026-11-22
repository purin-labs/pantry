/**
 * Spoken confirmation of approval cards (Plan 82 Phase 3). A card that a click
 * can approve also shows a phrase while voice control listens. The Platform
 * checks the words, and then the card's own click runs, with its own authority.
 * A card that needs a step-up or a permission prompt does not use this.
 */
import {
  parseVoiceConfirmation,
  type VoiceConfirmation,
  type VoiceConfirmationTarget,
} from "@purin-labs/control-api";
import { Mic } from "lucide-react";
import React from "react";

import {
  ControlApiError,
  controlWrite,
  readCookie,
} from "../../control-client";
import { voiceIsListening, type VoiceSession } from "./session";
import { WAKE_PHRASE } from "./wake-phrase";

type VoiceApprovalScope = Readonly<{
  session: VoiceSession;
  conversationId: string;
}>;

export const VoiceApprovalContext =
  React.createContext<VoiceApprovalScope | null>(null);

async function readPhrase(
  scope: VoiceApprovalScope,
  target: VoiceConfirmationTarget,
): Promise<VoiceConfirmation | null> {
  // Without a session Pantry refuses the phrase.
  if (readCookie("pantry_csrf") === null) return null;
  try {
    return parseVoiceConfirmation(
      await controlWrite(
        `/v1/control/organisations/${encodeURIComponent(scope.session.organisation)}/voice/confirmations`,
        "POST",
        { conversationId: scope.conversationId, target },
      ),
    );
  } catch (error) {
    if (error instanceof ControlApiError && error.status !== null) return null;
    throw error;
  }
}

export function VoiceApprovalLine(
  props: Readonly<{
    target: VoiceConfirmationTarget;
    approve: () => Promise<string | null>;
  }>,
): React.ReactNode {
  const scope = React.useContext(VoiceApprovalContext);
  return scope === null ? null : <ScopedLine {...props} scope={scope} />;
}

function ScopedLine(
  props: Readonly<{
    scope: VoiceApprovalScope;
    target: VoiceConfirmationTarget;
    approve: () => Promise<string | null>;
  }>,
): React.ReactNode {
  const { scope, target } = props;
  const { session, conversationId } = scope;
  const status = React.useSyncExternalStore(session.subscribe, session.status);
  const epoch = React.useSyncExternalStore(
    session.subscribe,
    session.approvalEpoch,
  );
  const listening = voiceIsListening(status);
  const [confirmation, setConfirmation] =
    React.useState<VoiceConfirmation | null>(null);
  const [reread, setReread] = React.useState(0);
  const announced = React.useRef<string | null>(null);
  const approve = React.useRef(props.approve);
  approve.current = props.approve;

  React.useEffect(() => {
    if (!listening) {
      setConfirmation(null);
      return undefined;
    }
    let current = true;
    void readPhrase(scope, target)
      .catch(() => null)
      .then((read) => {
        if (current) setConfirmation(read);
      });
    return () => {
      current = false;
    };
  }, [
    listening,
    epoch,
    reread,
    session,
    conversationId,
    target.kind,
    target.id,
  ]);

  const phrase = confirmation?.phrase ?? null;
  const expiresAt = confirmation?.expiresAt ?? null;
  React.useEffect(() => {
    if (phrase === null) return undefined;
    if (announced.current !== phrase) {
      announced.current = phrase;
      session.announcePhrase(phrase);
    }
    return session.registerApproval({
      conversationId,
      target,
      phrase,
      approve: () => approve.current(),
    });
  }, [phrase, session, conversationId, target.kind, target.id]);
  React.useEffect(() => {
    if (expiresAt === null) return undefined;
    const timer = window.setTimeout(
      () => setReread((count) => count + 1),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  return phrase === null ? null : (
    <p className="voice-approval-line">
      <Mic aria-hidden="true" size={14} />
      <span>
        Or say "{WAKE_PHRASE}", then <strong>{phrase}</strong>
      </span>
    </p>
  );
}
