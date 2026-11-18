import {
  CLOUD_VOICE_ENGINE,
  DEFAULT_MAC_VOICE_ENGINE,
  parseVoiceGrant,
  parseVoiceMacHealth,
  parseVoiceMacRefusal,
  parseVoiceTranscription,
  parseVoiceVocabulary,
  VOICE_DEVICE_HEADER,
  voiceMacDeadlineMs,
  type ChatTranscriptionPath,
  type VoiceEngineId,
  type VoiceGrant,
  type VoiceHeard,
  type VoiceRefusalCode,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  controlAnswer,
  ControlApiError,
  controlRead,
  controlSend,
  controlWrite,
  readCookie,
} from "../../control-client";

/** The Portal checks the Mac this often while voice control is on (Plan 82 D1b). */
const CHECK_MS = 30_000;
const CHECK_WHILE_LOADING_MS = 3_000;
const CHECK_TIMEOUT_MS = 3_000;
/** The Portal asks for a new grant this long before the old one ends. */
const GRANT_MARGIN_MS = 2 * 60_000;
/** The wait for the Mac's voice before the browser's voice. */
const SPEECH_DEADLINE_MS = 5_000;
const VOCABULARY_TIMEOUT_MS = 3_000;

type MacGrant = NonNullable<VoiceGrant["mac"]>;

type TranscribeResult =
  | Readonly<{ kind: "text"; text: string; heard: VoiceHeard }>
  | Readonly<{ kind: "refused"; code: VoiceRefusalCode }>;

type GrantRead = "ok" | "voice_disabled" | "unavailable";

function voicePath(organisationId: string, route: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/voice/${route}`;
}

function errorCode(body: unknown): string | null {
  return isRecord(body) && typeof body.error === "string" ? body.error : null;
}

/**
 * The path of one command (Plan 82 D1b). The Mac comes first. The fallback runs only
 * after the Mac fails, so that audio leaves the shop only when it must.
 */
export class VoiceTransport {
  private grant: MacGrant | null = null;
  private macAnswers = false;
  /** The engine that the Mac reported in its last check. */
  private macEngine: VoiceEngineId = DEFAULT_MAC_VOICE_ENGINE;
  private vocabulary: readonly string[] = [];
  /** A Mac on an older service version has no voice, until the next session. */
  private macHasVoice = true;
  private timer: number | null = null;
  private stopped = false;

  constructor(
    private readonly organisationId: string,
    private readonly deviceId: string,
    private readonly onChange: () => void,
  ) {}

  /**
   * The shop vocabulary that the engines read, for the text check (Plan 82C
   * D1). It is empty until the first read, and a failed read keeps the last.
   */
  get names(): readonly string[] {
    return this.vocabulary;
  }

  /** The path that the next command will use, for the "Cloud" mark. */
  get nextPath(): ChatTranscriptionPath {
    return this.grant !== null && this.macAnswers ? "shop_mac" : "workers_ai";
  }

  async start(): Promise<GrantRead> {
    const read = await this.refreshGrant();
    if (read === "voice_disabled") return read;
    await this.checkMac();
    return read;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.checkMac(), ms);
  }

  private async refreshGrant(): Promise<GrantRead> {
    try {
      // Without a session Pantry refuses the grant.
      if (readCookie("satyr_control_csrf") === null) return "unavailable";
      let ok = true;
      let body: unknown;
      try {
        body = await controlWrite(
          voicePath(this.organisationId, "grants"),
          "POST",
          {
            deviceId: this.deviceId,
          },
        );
      } catch (error) {
        // No answer, or one that is not JSON, reads as unavailable.
        if (!(error instanceof ControlApiError) || error.details === null)
          return "unavailable";
        ok = false;
        body = error.details;
      }
      if (errorCode(body) === "voice_disabled") {
        this.grant = null;
        return "voice_disabled";
      }
      const parsed = ok ? parseVoiceGrant(body) : null;
      if (parsed === null) return "unavailable";
      this.grant = parsed.mac;
      void this.readVocabulary();
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  private async readVocabulary(): Promise<void> {
    try {
      const vocabulary = parseVoiceVocabulary(
        await controlRead(
          voicePath(this.organisationId, "vocabulary"),
          AbortSignal.timeout(VOCABULARY_TIMEOUT_MS),
        ),
      );
      if (vocabulary !== null) this.vocabulary = vocabulary.terms;
    } catch {
      // The check keeps the last list, and the next grant reads it again.
    }
  }

  private async checkMac(): Promise<void> {
    let next = CHECK_MS;
    const before = this.nextPath;
    if (
      this.grant === null ||
      this.grant.expiresAt - Date.now() < GRANT_MARGIN_MS
    )
      await this.refreshGrant();
    const grant = this.grant;
    if (grant === null) {
      this.macAnswers = false;
    } else {
      try {
        const response = await fetch(`${grant.origin}/health`, {
          headers: { authorization: `Bearer ${grant.grant}` },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        const health = parseVoiceMacHealth(await response.json());
        this.macAnswers =
          response.ok && health?.modelState === "loaded" && !health.busy;
        if (health !== null)
          this.macEngine = health.engine ?? DEFAULT_MAC_VOICE_ENGINE;
        if (health !== null && health.modelState === "loading")
          next = CHECK_WHILE_LOADING_MS;
        if (response.status === 401) this.grant = null;
      } catch {
        this.macAnswers = false;
      }
    }
    if (this.nextPath !== before) this.onChange();
    this.schedule(next);
  }

  /** The answer in the Mac's voice as a WAV file. Null means the browser's voice. */
  async speak(text: string): Promise<ArrayBuffer | null> {
    const grant = this.grant;
    if (grant === null || !this.macAnswers || !this.macHasVoice) return null;
    try {
      const response = await fetch(`${grant.origin}/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.grant}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SPEECH_DEADLINE_MS),
      });
      if (response.status === 404) this.macHasVoice = false;
      return response.ok ? await response.arrayBuffer() : null;
    } catch {
      return null;
    }
  }

  async transcribe(wav: Blob, audioSeconds: number): Promise<TranscribeResult> {
    if (this.grant !== null && this.macAnswers) {
      const answer = await this.transcribeOnMac(this.grant, wav, audioSeconds);
      if (answer !== null) return answer;
      this.macAnswers = false;
      this.onChange();
      this.schedule(0);
    }
    return this.transcribeOnPlatform(wav);
  }

  /** Null means that the Mac failed. Its late answer is dropped with the request. */
  private async transcribeOnMac(
    grant: MacGrant,
    wav: Blob,
    audioSeconds: number,
  ): Promise<TranscribeResult | null> {
    try {
      const response = await fetch(`${grant.origin}/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.grant}`,
          "content-type": "audio/wav",
        },
        body: wav,
        signal: AbortSignal.timeout(
          voiceMacDeadlineMs(this.macEngine, audioSeconds),
        ),
      });
      const body: unknown = await response.json();
      const transcription = response.ok ? parseVoiceTranscription(body) : null;
      if (transcription !== null)
        return {
          kind: "text",
          text: transcription.text,
          heard: {
            path: "shop_mac",
            engine: transcription.engine ?? this.macEngine,
          },
        };
      switch (parseVoiceMacRefusal(body)?.error) {
        case "rate_limited":
          return { kind: "refused", code: "rate_limited" };
        case "too_long":
          return { kind: "refused", code: "too_long" };
        case "grant_refused":
          this.grant = null;
          return null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private async transcribeOnPlatform(wav: Blob): Promise<TranscribeResult> {
    try {
      const answer = await controlAnswer(
        controlSend(voicePath(this.organisationId, "transcriptions"), wav, {
          "content-type": "audio/wav",
          [VOICE_DEVICE_HEADER]: this.deviceId,
        }),
      );
      const body = answer.body;
      const transcription = answer.ok ? parseVoiceTranscription(body) : null;
      if (transcription !== null)
        return {
          kind: "text",
          text: transcription.text,
          heard: { path: "workers_ai", engine: CLOUD_VOICE_ENGINE },
        };
      const code = errorCode(body);
      return {
        kind: "refused",
        code:
          code === "voice_disabled" ||
          code === "too_long" ||
          code === "rate_limited"
            ? code
            : "transcription_unavailable",
      };
    } catch {
      return { kind: "refused", code: "transcription_unavailable" };
    }
  }
}
