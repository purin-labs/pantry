import React from "react";
import { createRoot } from "react-dom/client";
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
} from "../features/voice/capture";
import { encodeVoiceWav } from "../features/voice/command";
import type { VoiceWorkerEvent } from "../features/voice/worker-protocol";
import { Select } from "../ui";
import { usePortalTheme } from "../use-portal-theme";
import "../styles.css";
import "./voice-recorder.css";

/**
 * The recorder of real commands (Plan 82C Phase 3). It runs only on this Mac,
 * with `scripts/shop-voice/recorder.vite.config.ts`, and each clip goes to
 * `.cache/human/<session>/`. A held key and the wake phrase go through the
 * Portal's own microphone settings and its own worker, so that a clip is what
 * a command sends. The room sound comes straight from the microphone, because
 * the worker sends nothing without speech.
 */
type PromptSet =
  "command" | "phrase" | "near" | "stop" | "far" | "list" | "room";
type Prompt = Readonly<{
  index: number;
  set: PromptSet;
  kind: string;
  target: string;
  spoken: string;
  seconds?: number;
}>;
/** What one attempt gave: a clip, or the reason that the worker sent none. */
type ClipEvent = "captured" | "no_speech" | "near_wake" | "skipped";

const HOW: Readonly<Record<PromptSet, string>> = {
  command:
    "Hold Space. Say the command as you say it at work. Let go after the last word.",
  phrase: "Hold Space and say the approval phrase. Then let go.",
  near: "Hold Space and say these words exactly. They must not approve anything.",
  stop: "Hold Space, say the word, and let go.",
  far: "Stand about 2 m from the Mac. Say “Hey Satyr”. After the high tone, say the command.",
  list: "Hold Space and say the names as a list. Then let go.",
  room: "Do not speak, and do not read this text aloud. Press Space one time, and step away. After 3 seconds, the page records 30 seconds of the shop's sound.",
};

const ROOM_DELAY_MS = 3000;
/** `?only=room` records the room sound alone, for a session that recorded it somewhere else. */
const ONLY = new URLSearchParams(window.location.search).get("only");

/** The microphone, the Portal's worker, and a second capture for the room sound. */
class Recorder {
  readonly #stream: MediaStream;
  readonly #audio: AudioContext;
  readonly #worker: Worker;
  readonly #room: MessagePort;
  #roomChunks: Float32Array[] | null = null;

  private constructor(
    stream: MediaStream,
    audio: AudioContext,
    worker: Worker,
    room: MessagePort,
  ) {
    this.#stream = stream;
    this.#audio = audio;
    this.#worker = worker;
    this.#room = room;
    this.#room.onmessage = (event: MessageEvent<Float32Array>) => {
      this.#roomChunks?.push(event.data);
    };
  }

  static async open(
    microphone: string | null,
    accept: (event: VoiceWorkerEvent) => void,
  ): Promise<Recorder> {
    const stream = await openVoiceMicrophone(microphone);
    const audio = newVoiceAudio();
    const capture = await connectVoiceMicrophone(audio, stream);
    const worker = newVoiceWorker();
    await startVoiceWorker(worker, capture, accept);
    const roomCapture = await connectVoiceMicrophone(audio, stream);
    const channel = new MessageChannel();
    roomCapture.port.postMessage({ port: channel.port2 }, [channel.port2]);
    await audio.resume();
    return new Recorder(stream, audio, worker, channel.port1);
  }

  get microphoneLabel(): string {
    return this.#stream.getAudioTracks()[0]?.label ?? "";
  }

  holdStart(): void {
    this.#worker.postMessage({ type: "hold_start" });
  }

  holdEnd(): void {
    this.#worker.postMessage({ type: "hold_end" });
  }

  /** After each capture, as the session does: the worker waits until it hears this. */
  listen(): void {
    this.#worker.postMessage({ type: "listen" });
  }

  tone(frequency: number, repeat = 1): void {
    playVoiceTone(this.#audio, frequency, repeat);
  }

  /** The recording starts after the key and the person's first step away. */
  async recordRoom(seconds: number): Promise<Float32Array> {
    await new Promise((resolve) => setTimeout(resolve, ROOM_DELAY_MS));
    this.#roomChunks = [];
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const chunks = this.#roomChunks;
    this.#roomChunks = null;
    const pcm = new Float32Array(
      chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let at = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, at);
      at += chunk.length;
    }
    return pcm.subarray(0, seconds * VOICE_SAMPLE_RATE);
  }

  close(): void {
    this.#worker.terminate();
    closeVoiceAudio(this.#audio);
    stopVoiceMicrophone(this.#stream);
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

type Step =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "holding" }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "room"; until: number }>
  | Readonly<{ kind: "saving" }>;

function VoiceRecorder(): React.ReactNode {
  usePortalTheme();
  const [microphones, setMicrophones] = React.useState<MediaDeviceInfo[]>([]);
  const [microphone, setMicrophone] = React.useState("");
  const [session, setSession] = React.useState<{
    name: string;
    prompts: Prompt[];
  } | null>(null);
  const [at, setAt] = React.useState(0);
  const [step, setStep] = React.useState<Step>({ kind: "ready" });
  const [note, setNote] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const recorder = React.useRef<Recorder | null>(null);
  const attempts = React.useRef(new Map<number, number>());
  /** A capture belongs to the prompt only after a held key or a wake on a "far" prompt. */
  const expecting = React.useRef(false);
  const current = React.useRef<{
    session: string;
    prompt: Prompt;
  } | null>(null);

  React.useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) =>
        setMicrophones(
          devices.filter(
            (device) => device.kind === "audioinput" && device.deviceId !== "",
          ),
        ),
      );
  }, [session]);

  const prompt = session?.prompts[at] ?? null;
  current.current =
    session === null || prompt === null
      ? null
      : { session: session.name, prompt };

  const save = React.useCallback(
    async (event: ClipEvent, pcm: Float32Array | null): Promise<void> => {
      const now = current.current;
      if (now === null) return;
      const attempt = (attempts.current.get(now.prompt.index) ?? 0) + 1;
      attempts.current.set(now.prompt.index, attempt);
      setStep({ kind: "saving" });
      try {
        await post("/recorder/clip", {
          session: now.session,
          index: now.prompt.index,
          attempt,
          event,
          wav: pcm === null ? null : await base64(encodeVoiceWav(pcm)),
        });
      } catch (error) {
        setProblem(`The clip was not saved: ${String(error)}`);
        setStep({ kind: "ready" });
        return;
      }
      setStep({ kind: "ready" });
      if (event === "captured" || event === "skipped") {
        setNote(null);
        setAt((index) => index + 1);
      } else
        setNote(
          event === "no_speech"
            ? "The device heard no speech, as in the shop. Say it again."
            : "The device almost heard “Hey Satyr”. Say it again.",
        );
    },
    [],
  );

  const accept = React.useCallback(
    (event: VoiceWorkerEvent) => {
      const live = recorder.current;
      if (live === null) return;
      const far = current.current?.prompt.set === "far";
      switch (event.type) {
        case "wake":
          if (far && !expecting.current) {
            expecting.current = true;
            setNote(null);
            live.tone(880);
            setStep({ kind: "waiting" });
          }
          return;
        case "near_wake":
          if (far && !expecting.current) void save("near_wake", null);
          return;
        case "no_speech":
        case "captured": {
          live.listen();
          // A false wake during another prompt captures too. That audio is not the prompt.
          if (!expecting.current) return;
          expecting.current = false;
          if (event.type === "captured") {
            live.tone(660);
            void save("captured", event.pcm);
          } else {
            live.tone(440, 2);
            void save("no_speech", null);
          }
          return;
        }
        case "ready":
        case "failed":
          return;
      }
    },
    [save],
  );

  React.useEffect(() => {
    const live = recorder.current;
    if (live === null || prompt === null || prompt.set === "far") return;
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      if (step.kind !== "ready") return;
      if (prompt.set === "room") {
        const seconds = prompt.seconds ?? 30;
        setStep({
          kind: "room",
          until: Date.now() + ROOM_DELAY_MS + seconds * 1000,
        });
        void live.recordRoom(seconds).then((pcm) => save("captured", pcm));
        return;
      }
      expecting.current = true;
      setNote(null);
      live.holdStart();
      live.tone(880);
      setStep({ kind: "holding" });
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      if (step.kind !== "holding") return;
      live.holdEnd();
      setStep({ kind: "waiting" });
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [prompt, step, save]);

  React.useEffect(() => () => recorder.current?.close(), []);

  const start = async () => {
    setStarting(true);
    setProblem(null);
    try {
      const live = await Recorder.open(
        microphone === "" ? null : microphone,
        (event) => accept(event),
      );
      recorder.current = live;
      const started = await post<{ session: string; prompts: Prompt[] }>(
        "/recorder/start",
        {
          microphone: live.microphoneLabel,
          userAgent: navigator.userAgent,
          only: ONLY,
        },
      );
      setSession({ name: started.session, prompts: started.prompts });
    } catch (error) {
      setProblem(`The recorder could not start: ${String(error)}`);
    } finally {
      setStarting(false);
    }
  };

  if (session === null) {
    const items = [
      { value: "", label: "Default microphone" },
      ...microphones.map((device) => ({
        value: device.deviceId,
        label: device.label || "Microphone",
      })),
    ];
    return (
      <main className="voice-recorder">
        <h1>
          {ONLY === "room"
            ? "Record the shop's sound"
            : "Record your voice commands"}
        </h1>
        <p>
          {ONLY === "room"
            ? "The page records 30 seconds of each of 4 sounds of the shop, with nobody speaking to the Mac. It takes about 3 minutes."
            : "You say about 55 short commands, phrases and words, and the page records 2 minutes of the shop's sound. It takes about 10 minutes."}{" "}
          The recordings stay on this Mac, in <code>.cache/human/</code>. Both
          speech engines then hear the same recordings.
        </p>
        <p>
          Record in the shop, with the microphone that voice control uses, and
          at the distance where you usually speak.
        </p>
        <div className="voice-recorder-row">
          <span>Microphone</span>
          <Select.Root
            items={items}
            value={microphone}
            onValueChange={(value) => setMicrophone(value ?? "")}
          >
            <Select.Trigger size="sm" aria-label="Microphone">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {items.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </div>
        <button
          type="button"
          className="voice-recorder-start"
          disabled={starting}
          onClick={() => void start()}
        >
          {starting ? "Loading the voice files…" : "Start"}
        </button>
        {problem === null ? null : <p role="alert">{problem}</p>}
      </main>
    );
  }

  if (prompt === null)
    return (
      <main className="voice-recorder">
        <h1>All prompts are recorded</h1>
        <p>
          The session is <code data-recorder-session="">{session.name}</code>.
          Tell Claude this name. You can close this page.
        </p>
      </main>
    );

  return (
    <main className="voice-recorder">
      <p className="voice-recorder-count">
        {at + 1} of {session.prompts.length}
      </p>
      <p className="voice-recorder-how">{HOW[prompt.set]}</p>
      <p
        className="voice-recorder-say"
        data-recorder-prompt={prompt.index}
        data-recorder-set={prompt.set}
        data-recorder-spoken={prompt.spoken}
      >
        {prompt.set === "room"
          ? `When ${prompt.kind}`
          : prompt.set === "far"
            ? `Hey Satyr… ${prompt.spoken}`
            : prompt.spoken}
      </p>
      <p className="voice-recorder-step" aria-live="polite">
        <StepText step={step} />
      </p>
      {note === null ? null : (
        <p className="voice-recorder-note" role="status">
          {note}
        </p>
      )}
      {problem === null ? null : <p role="alert">{problem}</p>}
      <div className="voice-recorder-row">
        <button
          type="button"
          disabled={at === 0 || step.kind !== "ready"}
          onClick={() => {
            setNote(null);
            setAt((index) => index - 1);
          }}
        >
          Record the last one again
        </button>
        {prompt.set === "far" ? (
          <button
            type="button"
            disabled={step.kind !== "ready"}
            onClick={() => void save("skipped", null)}
          >
            Skip this one
          </button>
        ) : null}
      </div>
    </main>
  );
}

function StepText(props: Readonly<{ step: Step }>): React.ReactNode {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (props.step.kind !== "room") return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [props.step]);
  switch (props.step.kind) {
    case "ready":
      return "Ready.";
    case "holding":
      return "Recording. Let go after the last word.";
    case "waiting":
      return "Listening…";
    case "room":
      return `Recording the room: ${Math.max(0, Math.ceil((props.step.until - Date.now()) / 1000))} s left.`;
    case "saving":
      return "Saving…";
  }
}

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<VoiceRecorder />);
