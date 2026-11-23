import { VoiceSession, type VoiceCommandSink } from "./session";

/**
 * One voice session for each Organisation in this page (Plan 82). The session
 * outlives the chat panel, so the microphone stays on while a baker works on
 * another page. The open chat takes each command. With the chat closed, a
 * command opens it beside the page, and the chat sends the command when it is
 * ready.
 */
type Command = Parameters<VoiceCommandSink>;
type Waiting = Readonly<{
  command: Command;
  settle: (sentence: string | null) => void;
}>;

/** The chat opens and reads its conversation in this time, or the command is not sent. */
const OPEN_WAIT_MS = 10_000;

class VoiceHost {
  readonly session: VoiceSession;
  private chat: VoiceCommandSink | null = null;
  private opener: (() => void) | null = null;
  private waiting: Waiting | null = null;
  /** The chat of the last spoken command, which a later command continues. */
  conversationId: string | null = null;

  constructor(organisationId: string) {
    this.session = new VoiceSession(organisationId, this.deliver.bind(this));
  }

  attachChat(sink: VoiceCommandSink): () => void {
    this.chat = sink;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting !== null)
      sink(...waiting.command).then(waiting.settle, () =>
        waiting.settle("I could not send that. Look at the screen."),
      );
    return () => {
      if (this.chat === sink) this.chat = null;
    };
  }

  attachOpener(open: () => void): () => void {
    this.opener = open;
    return () => {
      if (this.opener === open) this.opener = null;
    };
  }

  private deliver(...command: Command): Promise<string | null> {
    if (this.chat !== null) return this.chat(...command);
    const open = this.opener;
    if (open === null)
      return Promise.resolve("Open the chat, then say it again.");
    // The session sends one command at a time, so an older wait has ended.
    this.waiting?.settle("Say that again.");
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.waiting !== waiting) return;
        this.waiting = null;
        resolve("The chat did not open. Look at the screen.");
      }, OPEN_WAIT_MS);
      const waiting: Waiting = {
        command,
        settle: (sentence) => {
          window.clearTimeout(timer);
          resolve(sentence);
        },
      };
      this.waiting = waiting;
      open();
    });
  }
}

const hosts = new Map<string, VoiceHost>();

function hostFor(organisationId: string): VoiceHost {
  let host = hosts.get(organisationId);
  if (host === undefined) {
    host = new VoiceHost(organisationId);
    hosts.set(organisationId, host);
  }
  return host;
}

export function voiceSessionFor(organisationId: string): VoiceSession {
  return hostFor(organisationId).session;
}

/** The ready chat takes the commands until it closes. */
export function attachVoiceChat(
  organisationId: string,
  sink: VoiceCommandSink,
): () => void {
  return hostFor(organisationId).attachChat(sink);
}

/** The workspace frame opens the chat for a command that arrives while it is closed. */
export function attachVoiceChatOpener(
  organisationId: string,
  open: () => void,
): () => void {
  return hostFor(organisationId).attachOpener(open);
}

export function noteVoiceConversation(
  organisationId: string,
  conversationId: string,
): void {
  hostFor(organisationId).conversationId = conversationId;
}

/** The chat to open for a command, or null for a new chat. */
export function voiceConversation(organisationId: string): string | null {
  return hosts.get(organisationId)?.conversationId ?? null;
}
