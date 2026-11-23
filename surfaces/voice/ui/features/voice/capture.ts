/**
 * The microphone, the 16 kHz audio graph and the listening worker of voice
 * control (Plan 82). The session uses them, and so does the Plan 82C recorder
 * of real commands (`voice-recorder.html`), so that a recording passes through
 * the same browser settings and the same capture as a command.
 */
import type { VoiceWorkerEvent } from "./worker-protocol";

export const VOICE_SAMPLE_RATE = 16_000;

/** The microphone as voice control opens it. Noise suppression stays off: it cuts quiet words. */
export function openVoiceMicrophone(
  microphone: string | null,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(microphone === null ? {} : { deviceId: { ideal: microphone } }),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });
}

export function newVoiceAudio(): AudioContext {
  return new AudioContext({
    sampleRate: VOICE_SAMPLE_RATE,
    latencyHint: "interactive",
  });
}

/** The capture node, with the microphone in and a silent path out, so that the graph runs. */
export async function connectVoiceMicrophone(
  audio: AudioContext,
  stream: MediaStream,
): Promise<AudioWorkletNode> {
  await audio.audioWorklet.addModule("/voice/capture-worklet.js");
  const capture = new AudioWorkletNode(audio, "voice-capture", {
    channelCount: 1,
  });
  const silent = audio.createGain();
  silent.gain.value = 0;
  audio.createMediaStreamSource(stream).connect(capture);
  capture.connect(silent).connect(audio.destination);
  return capture;
}

/** Quiet room and near voice, in dBFS: the ends of the meter's 0 to 1. */
const METER_FLOOR_DB = -50;
const METER_TOP_DB = -12;

/**
 * The microphone's loudness now, from 0 to 1, for the wave while a command is
 * heard. It reads the last 32 ms on this device and keeps nothing.
 */
export function voiceLevelMeter(
  audio: AudioContext,
  stream: MediaStream,
): () => number {
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const decibels = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
    const level = (decibels - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB);
    return Math.min(1, Math.max(0, level));
  };
}

export function newVoiceWorker(): Worker {
  return new Worker(new URL("./wake-worker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Waits until the worker has its models, and then gives it the capture's
 * audio. Each later event goes to `accept`.
 */
export async function startVoiceWorker(
  worker: Worker,
  capture: AudioWorkletNode,
  accept: (event: VoiceWorkerEvent) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<VoiceWorkerEvent>) => {
      if (event.data.type === "ready") resolve();
      else if (event.data.type === "failed") reject(new Error("Voice files"));
      else accept(event.data);
    };
    worker.onerror = () => reject(new Error("Voice worker"));
  });
  worker.onmessage = (event: MessageEvent<VoiceWorkerEvent>) => {
    accept(event.data);
  };
  worker.onerror = null;
  const channel = new MessageChannel();
  worker.postMessage({ type: "audio_port", port: channel.port1 }, [
    channel.port1,
  ]);
  capture.port.postMessage({ port: channel.port2 }, [channel.port2]);
}

/** A short beep: 880 Hz when a capture starts, 660 Hz when it ends, 440 Hz twice when nothing goes. */
export function playVoiceTone(
  audio: AudioContext,
  frequency: number,
  repeat = 1,
): void {
  for (let index = 0; index < repeat; index += 1) {
    const start = audio.currentTime + index * 0.18;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.14);
  }
}

export function stopVoiceMicrophone(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export function closeVoiceAudio(audio: AudioContext): void {
  audio.close().catch(() => undefined);
}
