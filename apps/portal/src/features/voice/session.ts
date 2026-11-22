import {
  parseVoiceConfirmationCheck,
  type ChatTranscriptionPath,
  type VoiceConfirmationTarget,
  type VoiceHeard,
} from "@purin-labs/control-api";

import { controlAnswer, controlWrite } from "../../control-client";
import {
  encodeVoiceWav,
  isVoiceConfirmationAttempt,
  readVoiceCommand,
  refusalSentence,
  type VoiceCommand,
} from "./command";
import {
  closeVoiceAudio,
  connectVoiceMicrophone,
  newVoiceAudio,
  newVoiceWorker,
  openVoiceMicrophone,
  playVoiceTone,
  startVoiceWorker,
  stopVoiceMicrophone,
  VOICE_SAMPLE_RATE,
} from "./capture";
import { addVoiceCount, addVoiceHeard } from "./counts";
import { deleteVoiceModels } from "./model-cache";
import {
  readStored,
  rememberVoiceControl,
  voiceControlIsOn,
  writeStored,
} from "./setting";
import { StartAttempt } from "./start-attempt";
import { VoiceTransport } from "./transport";
import { WAKE_PHRASE } from "./wake-phrase";
import type { VoiceWorkerEvent } from "./worker-protocol";

const LOCK_NAME = "pantry-voice-control";
const DEVICE_KEY = "pantry.voice.device";
const MICROPHONE_KEY = "pantry.voice.microphone";
/** Safari leaves resume() open until a tap, so the start cannot wait on it. */
const RESUME_WAIT_MS = 1000;
const SPEAKER_RESUME_WAIT_MS = 300;
/** A shorter press is a slip or the start of a shortcut, and it makes no sound. */
const HOLD_MINIMUM_MS = 180;

export type VoiceStatus =
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "starting" }>
  | Readonly<{ kind: "listening"; path: ChatTranscriptionPath }>
  | Readonly<{
      kind: "capturing";
      path: ChatTranscriptionPath;
      hold: boolean;
    }>
  | Readonly<{ kind: "transcribing"; path: ChatTranscriptionPath }>
  /** The browser wants one tap before it opens audio. */
  | Readonly<{ kind: "needs_tap" }>
  | Readonly<{
      kind: "blocked";
      reason: "other_tab" | "microphone" | "voice_disabled" | "failed";
    }>;

/** The click on an approval card. It returns a sentence when it fails. */
type VoiceApproval = Readonly<{
  conversationId: string;
  target: VoiceConfirmationTarget;
  phrase: string;
  approve: () => Promise<string | null>;
}>;

export function voiceIsListening(status: VoiceStatus): boolean {
  return (
    status.kind === "listening" ||
    status.kind === "capturing" ||
    status.kind === "transcribing"
  );
}

/** The chat's existing send and stop functions, with the transcript as the text. */
export type VoiceCommandSink = (
  command: Exclude<VoiceCommand, Readonly<{ kind: "empty" }>>,
  heard: VoiceHeard,
) => Promise<string | null>;

function deviceId(): string {
  const stored = readStored(DEVICE_KEY);
  if (stored !== null) return stored;
  const created = crypto.randomUUID().replaceAll("-", "");
  writeStored(DEVICE_KEY, created);
  return created;
}

export { voiceControlIsOn } from "./setting";

export function chosenMicrophone(): string | null {
  return readStored(MICROPHONE_KEY);
}

/** Right Option alone types nothing. Fn counts on a browser that reports it. */
function isTalkKey(event: KeyboardEvent): boolean {
  return event.code === "AltRight" || event.code === "Fn" || event.key === "Fn";
}

/** The name to show, or null on a device with no keyboard to speak of. */
export function voiceTalkKeyName(): string | null {
  if (!matchMedia("(pointer: fine)").matches) return null;
  return /Mac/u.test(navigator.userAgent) ? "Right Option" : "Right Alt";
}

/**
 * Owns the open microphone. Audio stays in the worker until the wake phrase, and
 * a command's audio is dropped when its transcript returns (Plan 82 D4).
 */
export class VoiceSession {
  private current: VoiceStatus = { kind: "off" };
  private readonly listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  /** The capture runs at 16 kHz, which would cut the top of the Mac's voice. */
  private speaker: AudioContext | null = null;
  private answerSound: AudioBufferSourceNode | null = null;
  private speechTurn = 0;
  private speechQueue: Promise<void> = Promise.resolve();
  private worker: Worker | null = null;
  private transport: VoiceTransport | null = null;
  /** The start that opened the microphone, or the start that runs now. */
  private attempt: StartAttempt | null = null;
  private screenLock: WakeLockSentinel | null = null;
  private generation = 0;
  private speechUnlocked = false;
  private readonly approvals = new Map<string, VoiceApproval>();
  private epoch = 0;
  private holdingAnnouncements = false;
  private announcements: string[] = [];
  /** The talk key is down, and this press has not ended or been given up. */
  private talkKeyDown = false;
  private hold: { timer: number; started: boolean } | null = null;
  private lastStart: "wake" | "hold" = "wake";
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!isTalkKey(event)) {
      // A shortcut or a character such as é, not a command.
      if (this.talkKeyDown) this.giveUpHold();
      return;
    }
    if (event.repeat || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    this.talkKeyDown = true;
    this.startHold();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (!isTalkKey(event) || !this.talkKeyDown) return;
    if (this.hold?.started !== true) {
      this.giveUpHold();
      return;
    }
    // Windows would open the browser's menu on the release of Alt.
    event.preventDefault();
    this.talkKeyDown = false;
    this.clearHold();
    this.worker?.postMessage({ type: "hold_end" });
    this.set({ kind: "transcribing", path: this.path() });
  };
  /** The key's release goes to the app in front, so this page never sees it. */
  private readonly onBlur = () => {
    if (this.talkKeyDown) this.giveUpHold();
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === "visible" && this.stream !== null)
      void this.holdScreen();
  };
  /** iOS plays speech only after one speak() inside a tap. Any tap on the page counts. */
  readonly unlockSpeech = () => {
    document.removeEventListener("click", this.unlockSpeech);
    if (this.speechUnlocked) return;
    this.speechUnlocked = true;
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    speechSynthesis.speak(silent);
    this.speaker ??= new AudioContext();
    void this.speaker.resume().catch(() => undefined);
  };
  /** The device stops audio for a call or a locked screen, and a tap starts it. */
  private readonly onAudioState = () => {
    const audio = this.audio;
    if (audio === null) return;
    if (audio.state === "running") {
      if (this.current.kind === "needs_tap") this.listenAgain();
    } else if (voiceIsListening(this.current)) {
      this.talkKeyDown = false;
      this.clearHold();
      this.set({ kind: "needs_tap" });
    }
  };

  constructor(
    private readonly organisationId: string,
    private readonly sink: VoiceCommandSink,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly status = (): VoiceStatus => this.current;

  /** Changes when a card should read its phrase again, after a refusal. */
  readonly approvalEpoch = (): number => this.epoch;

  get organisation(): string {
    return this.organisationId;
  }

  /** A card that a phrase can confirm, for as long as it stays open. */
  registerApproval(approval: VoiceApproval): () => void {
    const key = `${approval.target.kind}:${approval.target.id}`;
    this.approvals.set(key, approval);
    return () => {
      if (this.approvals.get(key) === approval) this.approvals.delete(key);
    };
  }

  /** A new phrase is spoken with the answer that goes with it, not over it. */
  holdAnnouncements(): void {
    this.holdingAnnouncements = true;
  }

  releaseAnnouncements(): void {
    this.holdingAnnouncements = false;
    for (const text of this.announcements.splice(0)) this.utter(text);
  }

  announcePhrase(phrase: string): void {
    const text = `To confirm, say ${WAKE_PHRASE}, ${phrase}.`;
    if (this.holdingAnnouncements) this.announcements.push(text);
    else this.utter(text);
  }

  private utter(sentence: string): void {
    if (this.stream === null || sentence.length === 0) return;
    const turn = this.speechTurn;
    this.speechQueue = this.speechQueue.then(() =>
      this.sayInOrder(sentence, turn).catch(() => undefined),
    );
  }

  /** The Mac's voice first, and the browser's voice when the Mac has no answer. */
  private async sayInOrder(sentence: string, turn: number): Promise<void> {
    if (turn !== this.speechTurn) return;
    const wav = (await this.transport?.speak(sentence)) ?? null;
    if (turn !== this.speechTurn) return;
    if (wav !== null && (await this.playOnSpeaker(wav, turn))) return;
    if (turn !== this.speechTurn) return;
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.lang = "en";
    speechSynthesis.speak(utterance);
  }

  /** False when the device has not opened audio. It ends when the sound ends. */
  private async playOnSpeaker(
    wav: ArrayBuffer,
    turn: number,
  ): Promise<boolean> {
    this.speaker ??= new AudioContext();
    const speaker = this.speaker;
    if (speaker.state !== "running")
      await Promise.race([
        speaker.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, SPEAKER_RESUME_WAIT_MS)),
      ]);
    if (speaker.state !== "running") return false;
    const buffer = await speaker.decodeAudioData(wav).catch(() => null);
    if (buffer === null) return false;
    if (turn !== this.speechTurn) return true;
    const sound = speaker.createBufferSource();
    sound.buffer = buffer;
    sound.connect(speaker.destination);
    this.answerSound = sound;
    await new Promise<void>((resolve) => {
      sound.onended = () => resolve();
      sound.start();
    });
    if (this.answerSound === sound) this.answerSound = null;
    return true;
  }

  private cancelSpeech(): void {
    this.speechTurn += 1;
    speechSynthesis.cancel();
    try {
      this.answerSound?.stop();
    } catch {
      // The sound had not started.
    }
    this.answerSound = null;
  }

  private async confirmSpoken(
    transcript: string,
    heard: VoiceHeard,
  ): Promise<string> {
    const conversationId = [...this.approvals.values()][0]?.conversationId;
    if (conversationId === undefined) return "That card is gone.";
    try {
      // The check reads its answer, accepted or refused, as one body.
      const answer = await controlAnswer(
        controlWrite(
          `/v1/control/organisations/${encodeURIComponent(this.organisationId)}/voice/confirmations/check`,
          "POST",
          {
            conversationId,
            transcript,
            transcriptionPath: heard.path,
            transcriptionEngine: heard.engine,
          },
        ),
      );
      const check = parseVoiceConfirmationCheck(answer.body);
      if (check === null) return refusalSentence("transcription_unavailable");
      if (check.outcome === "refused") {
        this.epoch += 1;
        for (const listener of this.listeners) listener();
        return "That did not match. The card stays open.";
      }
      const approval = this.approvals.get(
        `${check.target.kind}:${check.target.id}`,
      );
      if (approval === undefined) return "That card is gone.";
      // The phrase is spent. A card that stays open needs a new one.
      const problem = await approval
        .approve()
        .catch(() => "That did not work. The card stays open.");
      if (problem === null) return "Done.";
      this.epoch += 1;
      for (const listener of this.listeners) listener();
      return problem;
    } catch {
      return refusalSentence("transcription_unavailable");
    }
  }

  private set(status: VoiceStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener();
  }

  private path(): ChatTranscriptionPath {
    return this.transport?.nextPath ?? "workers_ai";
  }

  /** Turns voice on from a person's choice, and remembers it on this device. */
  async turnOn(microphone: string | null): Promise<void> {
    rememberVoiceControl(this.organisationId, true);
    writeStored(MICROPHONE_KEY, microphone);
    await this.start();
  }

  /** Off closes the microphone and deletes the voice files. */
  async turnOff(): Promise<void> {
    rememberVoiceControl(this.organisationId, false);
    this.shutDown();
    this.set({ kind: "off" });
    await deleteVoiceModels();
  }

  /** The page closes or changes workspace. The setting stays. */
  close(): void {
    this.shutDown();
  }

  /** After a reload, the setting starts the session with no new choice. */
  async resume(): Promise<void> {
    // The page mark and the chat both resume one session. A second start while
    // the first runs would find the first start's lock and read as another tab.
    if (voiceControlIsOn(this.organisationId) && this.attempt === null)
      await this.start();
  }

  /** The tap that the browser wants before it opens audio. */
  async tap(): Promise<void> {
    await this.audio?.resume();
  }

  /** The release of the device's listening lock, or null while another tab holds it. */
  private async takeLock(): Promise<(() => void) | null> {
    if (navigator.locks === undefined) return ignore;
    return new Promise((resolve) => {
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        // The lock lasts until its release runs.
        return new Promise<void>((release) => resolve(() => release()));
      });
    });
  }

  private async holdScreen(): Promise<void> {
    try {
      const screenLock = (await navigator.wakeLock?.request("screen")) ?? null;
      // Voice turned off while the browser answered.
      if (this.stream === null) void screenLock?.release();
      else this.screenLock = screenLock;
    } catch {
      this.screenLock = null;
    }
  }

  /**
   * Each resource belongs to this start's attempt from the moment it exists.
   * When voice turns off during a wait, such as the microphone prompt, the
   * attempt closes what it holds and each resource that arrives later.
   */
  private async start(): Promise<void> {
    this.attempt?.cancel();
    const attempt = new StartAttempt();
    this.attempt = attempt;
    this.generation += 1;
    this.set({ kind: "starting" });
    if (!this.speechUnlocked)
      document.addEventListener("click", this.unlockSpeech);
    // One device listens once, so that one command gives one message.
    const releaseLock = await this.takeLock();
    if (releaseLock === null) {
      if (!attempt.cancelled)
        this.set({ kind: "blocked", reason: "other_tab" });
      return;
    }
    if (!attempt.open(releaseLock)) return;
    const transport = new VoiceTransport(
      this.organisationId,
      deviceId(),
      () => {
        this.refreshPath();
      },
    );
    const grant = await transport.start();
    if (!attempt.open(transport.stop.bind(transport))) return;
    this.transport = transport;
    if (grant === "voice_disabled") {
      this.shutDown();
      this.set({ kind: "blocked", reason: "voice_disabled" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await openVoiceMicrophone(chosenMicrophone());
    } catch {
      if (attempt.cancelled) return;
      this.shutDown();
      this.set({ kind: "blocked", reason: "microphone" });
      return;
    }
    if (!attempt.open(stopVoiceMicrophone.bind(null, stream))) return;
    this.stream = stream;
    try {
      await this.connect(attempt, stream);
    } catch {
      if (attempt.cancelled) return;
      this.shutDown();
      this.set({ kind: "blocked", reason: "failed" });
    }
  }

  private async connect(
    attempt: StartAttempt,
    stream: MediaStream,
  ): Promise<void> {
    const audio = newVoiceAudio();
    if (!attempt.open(closeVoiceAudio.bind(null, audio))) return;
    this.audio = audio;
    const capture = await connectVoiceMicrophone(audio, stream);
    if (attempt.cancelled) return;
    const worker = newVoiceWorker();
    if (!attempt.open(worker.terminate.bind(worker))) return;
    this.worker = worker;
    await startVoiceWorker(worker, capture, (event) => {
      void this.acceptWorker(event);
    });
    if (attempt.cancelled) return;
    document.addEventListener("visibilitychange", this.onVisibility);
    // The capture phase, so that a page's own key handler cannot hide the release.
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    void this.holdScreen();
    if (audio.state !== "running")
      await Promise.race([
        audio.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
      ]);
    if (attempt.cancelled) return;
    audio.addEventListener("statechange", this.onAudioState);
    this.set(
      audio.state === "running"
        ? { kind: "listening", path: this.path() }
        : { kind: "needs_tap" },
    );
  }

  private shutDown(): void {
    this.generation += 1;
    // The lock, the transport, the stream, the AudioContext and the worker.
    this.attempt?.cancel();
    this.attempt = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.removeEventListener("click", this.unlockSpeech);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.talkKeyDown = false;
    this.clearHold();
    this.transport = null;
    this.worker = null;
    this.stream = null;
    this.audio?.removeEventListener("statechange", this.onAudioState);
    this.audio = null;
    void this.screenLock?.release();
    this.screenLock = null;
    this.cancelSpeech();
    void this.speaker?.close();
    this.speaker = null;
    this.speechUnlocked = false;
  }

  private refreshPath(): void {
    const status = this.current;
    if (
      status.kind === "listening" ||
      status.kind === "capturing" ||
      status.kind === "transcribing"
    )
      this.set({ ...status, path: this.path() });
  }

  private tone(frequency: number, repeat = 1): void {
    if (this.audio !== null) playVoiceTone(this.audio, frequency, repeat);
  }

  private listenAgain(): void {
    this.worker?.postMessage({ type: "listen" });
    if (this.stream === null) return;
    this.set(
      this.audio?.state === "running"
        ? { kind: "listening", path: this.path() }
        : { kind: "needs_tap" },
    );
    // The key went down during the last command. Its tone says when to speak.
    this.startHold();
  }

  /** The audio counts from the press, and the tone and the status wait for a real hold. */
  private startHold(): void {
    if (
      !this.talkKeyDown ||
      this.hold !== null ||
      this.current.kind !== "listening"
    )
      return;
    this.worker?.postMessage({ type: "hold_start" });
    this.hold = {
      started: false,
      timer: window.setTimeout(() => {
        if (this.hold !== null) this.hold.started = true;
        addVoiceCount("holds");
        this.lastStart = "hold";
        this.cancelSpeech();
        this.tone(880);
        this.set({ kind: "capturing", path: this.path(), hold: true });
      }, HOLD_MINIMUM_MS),
    };
  }

  private clearHold(): void {
    if (this.hold !== null) window.clearTimeout(this.hold.timer);
    this.hold = null;
  }

  /** This press sends nothing. Its audio stays in the worker and goes. */
  private giveUpHold(): void {
    this.talkKeyDown = false;
    if (this.hold === null) return;
    if (this.hold.started) this.tone(440, 2);
    this.clearHold();
    this.listenAgain();
  }

  /** The worker ended the capture at its time limit, with the key still down. */
  private spendHold(): void {
    if (this.hold === null) return;
    this.talkKeyDown = false;
    this.clearHold();
  }

  private async acceptWorker(event: VoiceWorkerEvent): Promise<void> {
    switch (event.type) {
      case "wake":
        if (this.hold !== null) return;
        addVoiceCount("wakes");
        this.lastStart = "wake";
        this.cancelSpeech();
        this.tone(880);
        this.set({ kind: "capturing", path: this.path(), hold: false });
        return;
      case "near_wake":
        addVoiceCount("nearWakes");
        return;
      case "no_speech":
        this.spendHold();
        // A wake with no command is probably a false wake. A silent hold says nothing.
        if (this.lastStart === "wake") addVoiceCount("noCommand");
        this.tone(440, 2);
        this.listenAgain();
        return;
      case "captured":
        this.spendHold();
        this.tone(660);
        await this.transcribe(event.pcm);
        return;
      case "failed":
        this.shutDown();
        this.set({ kind: "blocked", reason: "failed" });
        return;
      case "ready":
        return;
    }
  }

  private async transcribe(pcm: Float32Array): Promise<void> {
    const transport = this.transport;
    if (transport === null) return;
    const generation = this.generation;
    this.set({ kind: "transcribing", path: this.path() });
    const result = await transport.transcribe(
      encodeVoiceWav(pcm),
      pcm.length / VOICE_SAMPLE_RATE,
    );
    if (generation !== this.generation) return;
    if (result.kind === "refused") {
      this.speak(refusalSentence(result.code));
      if (result.code === "voice_disabled") {
        this.shutDown();
        this.set({ kind: "blocked", reason: "voice_disabled" });
        return;
      }
    } else {
      const command = readVoiceCommand(result.text, transport.names);
      addVoiceHeard(result.heard, command.kind !== "empty");
      if (command.kind === "empty") {
        this.tone(440, 2);
      } else {
        const phrases = [...this.approvals.values()].map(
          (approval) => approval.phrase,
        );
        if (
          command.kind !== "stop" &&
          isVoiceConfirmationAttempt(command.text, phrases)
        ) {
          const sentence = await this.confirmSpoken(command.text, result.heard);
          if (generation !== this.generation) return;
          this.speak(sentence);
        } else {
          const problem = await this.sink(command, result.heard);
          if (generation !== this.generation) return;
          if (problem !== null) this.speak(problem);
        }
      }
    }
    this.listenAgain();
  }

  /** A short sentence in the Mac's voice, or on the device's own speech synthesis. */
  speak(sentence: string): void {
    if (this.stream !== null) this.cancelSpeech();
    this.utter(sentence);
    this.releaseAnnouncements();
  }

  /** A finished sentence of an answer that is still coming. False while the person speaks. */
  speakPart(sentence: string): boolean {
    if (
      this.stream === null ||
      this.hold !== null ||
      this.current.kind === "capturing" ||
      this.current.kind === "transcribing"
    )
      return false;
    this.utter(sentence);
    return true;
  }

  /** The end of an answer that has started: it plays after the sentences before it. */
  finishSpeech(sentence: string): void {
    this.utter(sentence);
    this.releaseAnnouncements();
  }
}

function ignore(): void {}
