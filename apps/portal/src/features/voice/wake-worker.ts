/**
 * Listens on the device (Plan 82). Speech detection runs on all audio, and the wake
 * phrase model runs only near speech. Nothing leaves this worker before a wake.
 */
import * as ort from "onnxruntime-web/wasm";
import ortGlueUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";

import { cachedBytes } from "./model-cache";
import type { VoiceWorkerEvent, VoiceWorkerRequest } from "./worker-protocol";

const CHUNK = 1280;
const CHUNK_MS = 80;
/** openWakeWord's stream: each mel run also reads the last 480 samples. */
const MEL_OVERLAP = 480;
const MEL_BINS = 32;
const MEL_WINDOW = 76;
const EMBEDDING_SIZE = 96;
const EMBEDDING_WINDOW = 16;
const WAKE_THRESHOLD = 0.995;
/** A peak from here up to the threshold counts as a phrase that the model almost heard. */
const NEAR_WAKE_SCORE = 0.9;
/** The ring holds what the wake model needs when speech starts: about 2 s. */
const RING_CHUNKS = 25;
const VAD_WINDOW = 512;
const VAD_CONTEXT = 64;
const VAD_SPEECH = 0.5;
const VAD_SILENCE = 0.35;
const NEAR_SPEECH_MS = 2000;
/** The tail of the wake phrase is not the command. */
const WAKE_TAIL_MS = 320;
const END_SILENCE_MS = 800;
const NO_SPEECH_MS = 4000;
/** The whole chunks under the Mac's and the Platform's 15 s limit. */
const CAPTURE_LIMIT_MS = 14_960;
/** A person starts to speak as the finger goes down, before the worker hears of it. */
const HOLD_LEAD_CHUNKS = 2;
/** A person lets go on the last word, so the capture runs on a little. */
const HOLD_RELEASE_TAIL_MS = 240;
/** A device that cannot keep up drops old audio instead of answering late. */
const QUEUE_LIMIT = 50;

function send(event: VoiceWorkerEvent, transfer: Transferable[] = []): void {
  postMessage(event, { transfer });
}

class SpeechDetector {
  private state: ort.Tensor;
  private readonly rate = new ort.Tensor(
    "int64",
    new BigInt64Array([16_000n]),
    [],
  );
  private buffered = new Float32Array(0);
  private context = new Float32Array(VAD_CONTEXT);

  constructor(private readonly session: ort.InferenceSession) {
    this.state = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
  }

  /** The highest speech probability in this chunk. */
  async run(chunk: Float32Array): Promise<number> {
    const samples = new Float32Array(this.buffered.length + chunk.length);
    samples.set(this.buffered);
    samples.set(chunk, this.buffered.length);
    let at = 0;
    let highest = 0;
    for (; at + VAD_WINDOW <= samples.length; at += VAD_WINDOW) {
      const input = new Float32Array(VAD_CONTEXT + VAD_WINDOW);
      input.set(this.context);
      input.set(samples.subarray(at, at + VAD_WINDOW), VAD_CONTEXT);
      this.context = samples.slice(
        at + VAD_WINDOW - VAD_CONTEXT,
        at + VAD_WINDOW,
      );
      const output = await this.session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: this.state,
        sr: this.rate,
      });
      this.state = output.stateN as ort.Tensor;
      highest = Math.max(
        highest,
        (output.output as ort.Tensor).data[0] as number,
      );
    }
    this.buffered = samples.slice(at);
    return highest;
  }
}

class WakePhrase {
  private melFrames: Float32Array[] = [];
  private embeddings: Float32Array[] = [];
  private previous = new Float32Array(MEL_OVERLAP);

  constructor(
    private readonly mel: ort.InferenceSession,
    private readonly embedding: ort.InferenceSession,
    private readonly classifier: ort.InferenceSession,
  ) {}

  reset(): void {
    this.melFrames = [];
    this.embeddings = [];
    this.previous = new Float32Array(MEL_OVERLAP);
  }

  /** The score of the wake phrase, or null while the window is not full. */
  async run(chunk: Float32Array): Promise<number | null> {
    // These models read the range of 16-bit samples.
    const input = new Float32Array(MEL_OVERLAP + CHUNK);
    input.set(this.previous);
    for (let index = 0; index < CHUNK; index += 1)
      input[MEL_OVERLAP + index] = (chunk[index] ?? 0) * 32767;
    this.previous = input.slice(CHUNK);
    const mel = await this.mel.run({
      [this.mel.inputNames[0]!]: new ort.Tensor("float32", input, [
        1,
        input.length,
      ]),
    });
    const values = mel[this.mel.outputNames[0]!]!.data as Float32Array;
    for (let at = 0; at < values.length; at += MEL_BINS)
      this.melFrames.push(values.slice(at, at + MEL_BINS).map(scaleMel));
    if (this.melFrames.length > MEL_WINDOW)
      this.melFrames.splice(0, this.melFrames.length - MEL_WINDOW);
    if (this.melFrames.length < MEL_WINDOW) return null;
    const flat = new Float32Array(MEL_WINDOW * MEL_BINS);
    this.melFrames.forEach((row, index) => flat.set(row, index * MEL_BINS));
    const embedded = await this.embedding.run({
      [this.embedding.inputNames[0]!]: new ort.Tensor("float32", flat, [
        1,
        MEL_WINDOW,
        MEL_BINS,
        1,
      ]),
    });
    this.embeddings.push(
      (embedded[this.embedding.outputNames[0]!]!.data as Float32Array).slice(),
    );
    if (this.embeddings.length > EMBEDDING_WINDOW) this.embeddings.shift();
    if (this.embeddings.length < EMBEDDING_WINDOW) return null;
    const features = new Float32Array(EMBEDDING_WINDOW * EMBEDDING_SIZE);
    this.embeddings.forEach((row, index) =>
      features.set(row, index * EMBEDDING_SIZE),
    );
    const scored = await this.classifier.run({
      input: new ort.Tensor("float32", features, [
        1,
        EMBEDDING_WINDOW,
        EMBEDDING_SIZE,
      ]),
    });
    return (scored.score as ort.Tensor).data[0] as number;
  }
}

function scaleMel(value: number): number {
  return value / 10 + 2;
}

type Capture = {
  readonly chunks: Float32Array[];
  elapsedMs: number;
  speechSeen: boolean;
  silenceMs: number;
  /** A held key ends the capture, not silence. */
  hold: boolean;
  releaseAtMs: number | null;
};

type Stage =
  | Readonly<{ kind: "listening" }>
  | Readonly<{ kind: "capturing"; capture: Capture }>
  | Readonly<{ kind: "waiting" }>;

class Listener {
  private stage: Stage = { kind: "listening" };
  private ring: Float32Array[] = [];
  private lastSpeechAgoMs = Number.POSITIVE_INFINITY;
  private wakeActive = false;
  private wakePeak = 0;
  private queue: Float32Array[] = [];
  private draining = false;

  constructor(
    private readonly detector: SpeechDetector,
    private readonly wake: WakePhrase,
  ) {}

  /**
   * The ring keeps what followed the last wake, so that the model has its 2 s
   * again at once, and a wake phrase said during the transcription still counts.
   */
  listen(): void {
    this.stage = { kind: "listening" };
    this.wake.reset();
    this.wakeActive = false;
    this.wakePeak = 0;
  }

  /** A wake can arrive just before the key does. The same capture then becomes the hold. */
  holdStart(): void {
    const stage: Stage = this.stage;
    if (stage.kind === "capturing") {
      stage.capture.hold = true;
      return;
    }
    if (stage.kind === "waiting") return;
    const chunks = this.ring.slice(-HOLD_LEAD_CHUNKS);
    this.ring = [];
    this.wakePeak = 0;
    this.stage = {
      kind: "capturing",
      capture: {
        chunks,
        elapsedMs: chunks.length * CHUNK_MS,
        speechSeen: false,
        silenceMs: 0,
        hold: true,
        releaseAtMs: null,
      },
    };
  }

  holdEnd(): void {
    const stage: Stage = this.stage;
    if (stage.kind === "capturing" && stage.capture.hold)
      stage.capture.releaseAtMs =
        stage.capture.elapsedMs + HOLD_RELEASE_TAIL_MS;
  }

  accept(chunk: Float32Array): void {
    this.queue.push(chunk);
    if (this.queue.length > QUEUE_LIMIT) this.queue.shift();
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      for (;;) {
        const chunk = this.queue.shift();
        if (chunk === undefined) break;
        await this.handle(chunk);
      }
    } catch {
      send({ type: "failed" });
    } finally {
      this.draining = false;
    }
  }

  private async handle(chunk: Float32Array): Promise<void> {
    const speech = await this.detector.run(chunk);
    this.ring.push(chunk);
    if (this.ring.length > RING_CHUNKS) this.ring.shift();
    this.lastSpeechAgoMs =
      speech >= VAD_SPEECH ? 0 : this.lastSpeechAgoMs + CHUNK_MS;
    // The stage can change while the detector runs, so read it after that.
    const stage: Stage = this.stage;
    if (stage.kind === "waiting") return;
    if (stage.kind === "capturing") {
      this.capture(stage.capture, chunk, speech);
      return;
    }
    if (this.lastSpeechAgoMs >= NEAR_SPEECH_MS) {
      if (this.wakeActive) this.wake.reset();
      this.wakeActive = false;
      if (this.wakePeak >= NEAR_WAKE_SCORE) send({ type: "near_wake" });
      this.wakePeak = 0;
      return;
    }
    // Speech has started: the model first reads the seconds before it.
    const chunks = this.wakeActive ? [chunk] : this.ring;
    this.wakeActive = true;
    for (const part of chunks) {
      const score = await this.wake.run(part);
      this.wakePeak = Math.max(this.wakePeak, score ?? 0);
      if (score !== null && score >= WAKE_THRESHOLD) {
        // The phrase itself must not count again after this command.
        this.ring = [];
        this.wakePeak = 0;
        this.stage = {
          kind: "capturing",
          capture: {
            chunks: [],
            elapsedMs: 0,
            speechSeen: false,
            silenceMs: 0,
            hold: false,
            releaseAtMs: null,
          },
        };
        send({ type: "wake" });
        return;
      }
    }
  }

  private capture(capture: Capture, chunk: Float32Array, speech: number): void {
    capture.chunks.push(chunk);
    capture.elapsedMs += CHUNK_MS;
    if (capture.hold || capture.elapsedMs > WAKE_TAIL_MS) {
      if (speech >= VAD_SPEECH) {
        capture.speechSeen = true;
        capture.silenceMs = 0;
      } else if (capture.speechSeen && speech < VAD_SILENCE) {
        capture.silenceMs += CHUNK_MS;
      }
    }
    const finished =
      capture.elapsedMs >= CAPTURE_LIMIT_MS ||
      (capture.hold
        ? capture.releaseAtMs !== null &&
          capture.elapsedMs >= capture.releaseAtMs
        : capture.silenceMs >= END_SILENCE_MS);
    const waitedTooLong = !capture.hold && capture.elapsedMs >= NO_SPEECH_MS;
    if (!capture.speechSeen && (finished || waitedTooLong)) {
      this.stage = { kind: "waiting" };
      send({ type: "no_speech" });
    } else if (finished) {
      this.stage = { kind: "waiting" };
      const pcm = new Float32Array(capture.chunks.length * CHUNK);
      capture.chunks.forEach((part, index) => pcm.set(part, index * CHUNK));
      send({ type: "captured", pcm }, [pcm.buffer]);
    }
  }
}

async function start(): Promise<Listener> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { mjs: ortGlueUrl, wasm: ortWasmUrl };
  ort.env.wasm.wasmBinary = await cachedBytes(ortWasmUrl);
  const [vad, mel, embedding, classifier] = await Promise.all(
    ["silero_vad", "melspectrogram", "embedding_model", "hey_satyr"].map(
      async (name) =>
        ort.InferenceSession.create(
          new Uint8Array(await cachedBytes(`/voice/${name}.onnx`)),
          { executionProviders: ["wasm"] },
        ),
    ),
  );
  return new Listener(
    new SpeechDetector(vad!),
    new WakePhrase(mel!, embedding!, classifier!),
  );
}

const starting = start();
starting.then(
  () => send({ type: "ready" }),
  (error: unknown) => {
    console.error("Voice files could not start", error);
    send({ type: "failed" });
  },
);

addEventListener("message", (event: MessageEvent<VoiceWorkerRequest>) => {
  const request = event.data;
  void starting.then((listener) => {
    switch (request.type) {
      case "listen":
        listener.listen();
        return;
      case "hold_start":
        listener.holdStart();
        return;
      case "hold_end":
        listener.holdEnd();
        return;
      case "audio_port":
        request.port.onmessage = (audio: MessageEvent<Float32Array>) => {
          listener.accept(audio.data);
        };
        return;
    }
  });
});
