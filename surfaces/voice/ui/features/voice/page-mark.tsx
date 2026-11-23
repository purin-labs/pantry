import { Mic, MicOff } from "lucide-react";
import * as React from "react";
import { useLocation, useNavigate } from "react-router";

import { chatRouteState } from "@purin-labs/ui/page-address";
import { workspacePagePath } from "@purin-labs/ui/route";
import {
  attachVoiceChatOpener,
  voiceConversation,
  voiceSessionFor,
} from "./host";
import { voiceIsListening, type VoiceStatus } from "./session";
import "./styles.css";

type Props = Readonly<{
  organisationId: string;
  organisationHandle: string;
  workspaceHandle: string;
  chatOpen: boolean;
}>;

/**
 * Voice control on every page of the workspace (Plan 82). The microphone stays
 * on while the chat is closed, and this mark says so. A spoken command opens
 * the chat beside the page, in the chat of the last spoken command. Leaving
 * the workspace closes the microphone, and the setting stays.
 */
export default function VoicePageMark(props: Props): React.ReactNode {
  const { organisationId, organisationHandle, workspaceHandle } = props;
  const session = voiceSessionFor(organisationId);
  const status = React.useSyncExternalStore(session.subscribe, session.status);
  const navigate = useNavigate();
  const location = useLocation();
  const latest = React.useRef({ location, chatOpen: props.chatOpen });
  latest.current = { location, chatOpen: props.chatOpen };

  const openChat = React.useCallback(() => {
    if (latest.current.chatOpen) return;
    const conversation = voiceConversation(organisationId);
    const chat = workspacePagePath(organisationHandle, workspaceHandle, "chat");
    const { pathname, search } = latest.current.location;
    navigate(
      conversation === null
        ? chat
        : `${chat}?conversation=${encodeURIComponent(conversation)}`,
      { state: chatRouteState(pathname, search) },
    );
  }, [navigate, organisationId, organisationHandle, workspaceHandle]);

  React.useEffect(() => {
    void session.resume();
    return () => session.close();
  }, [session]);
  React.useEffect(
    () => attachVoiceChatOpener(organisationId, openChat),
    [organisationId, openChat],
  );

  const mark = markOf(status);
  if (props.chatOpen || mark === null) return null;
  return (
    <button
      type="button"
      className="voice-page-mark"
      data-state={status.kind}
      aria-label={mark}
      title={mark}
      onClick={
        status.kind === "needs_tap" ? () => void session.tap() : openChat
      }
    >
      {status.kind === "blocked" ? (
        <MicOff aria-hidden="true" size={16} />
      ) : (
        <Mic aria-hidden="true" size={16} />
      )}
      {status.kind === "needs_tap" ? <span>Tap to start voice</span> : null}
    </button>
  );
}

function markOf(status: VoiceStatus): string | null {
  if (voiceIsListening(status))
    return "Voice control is listening. Open the chat";
  if (status.kind === "needs_tap") return "Tap to start voice control";
  if (status.kind === "blocked")
    return "Voice control stopped. Open the chat to see why";
  return null;
}
