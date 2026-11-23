/** The messages between the voice session and its worker. No audio leaves the worker before a wake. */
export type VoiceWorkerRequest =
  | Readonly<{ type: "audio_port"; port: MessagePort }>
  /** Listen for the wake phrase again, after a command is finished. */
  | Readonly<{ type: "listen" }>
  /** A person holds the talk key: capture with no wake phrase, until the release. */
  | Readonly<{ type: "hold_start" }>
  | Readonly<{ type: "hold_end" }>;

export type VoiceWorkerEvent =
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "failed" }>
  | Readonly<{ type: "wake" }>
  /** Speech that almost matched the wake phrase. It carries no audio and no score. */
  | Readonly<{ type: "near_wake" }>
  /** No speech followed the wake phrase, or came during a held key. */
  | Readonly<{ type: "no_speech" }>
  /** The command's audio: 16 kHz mono, as values from -1 to 1. */
  | Readonly<{ type: "captured"; pcm: Float32Array }>;
