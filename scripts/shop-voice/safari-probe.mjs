// The Safari half of the voice journey (Plan 82). The iPhone simulator's Safari has no
// automation API here, so this Vite plugin adds one script to the page. The script runs what
// run-safari-journey.py sends, and plays speech as the page's microphone stream. A real tap on
// the simulator stays the only source of a user gesture.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_SCRIPT = String.raw`(() => {
  const nativeFetch = window.fetch.bind(window);
  const post = (path, body) =>
    nativeFetch(path, { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);
  const log = (kind, text) => post("/__probe/log", { kind, text: String(text).slice(0, 600) });
  addEventListener("error", (event) => log("error", event.message));
  addEventListener("unhandledrejection", (event) => log("rejection", event.reason));
  const consoleError = console.error.bind(console);
  console.error = (...parts) => {
    log("console", parts.join(" "));
    consoleError(...parts);
  };

  // The Mac's name needs public DNS and port 443. Here it is the journey's service on this Mac.
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const mac = /^https:\/\/[^/]+\.voice\.shop-voice\.test(\/.*)$/u.exec(url);
    if (mac === null) return nativeFetch(input, init);
    probe.macCalls.push(mac[1]);
    return nativeFetch("https://localhost:" + MAC_PORT + mac[1], init);
  };

  // The stream comes from a context at the device's own rate, as a real microphone does.
  const audio = new AudioContext();
  const output = audio.createMediaStreamDestination();
  const probe = (window.__probe = {
    audioRate: audio.sampleRate,
    macCalls: [],
    microphoneCalls: 0,
    spoken: [],
    speechEvents: [],
    workerEvents: [],
    contexts: [],
  });
  // Safari ignores this assignment on the instance, and then opens the real microphone.
  MediaDevices.prototype.getUserMedia = async () => {
    probe.microphoneCalls += 1;
    return output.stream;
  };
  for (const name of ["touchend", "click"])
    document.addEventListener(name, () => void audio.resume(), true);
  window.__play = async (voice, text) => {
    await audio.resume();
    const response = await nativeFetch(
      "/__probe/speech?voice=" + encodeURIComponent(voice) + "&text=" + encodeURIComponent(text),
    );
    const buffer = await audio.decodeAudioData(await response.arrayBuffer());
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
    return audio.state;
  };

  // The Mac's voice plays through its own context, not through the page's microphone stream.
  probe.macVoice = [];
  const startSource = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...parts) {
    if (this.context !== audio)
      probe.macVoice.push({ seconds: this.buffer.duration, state: this.context.state, rate: this.context.sampleRate });
    return startSource.apply(this, parts);
  };

  const speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (utterance) => {
    probe.spoken.push(utterance.text);
    for (const name of ["start", "end", "error"])
      utterance.addEventListener(name, (event) =>
        probe.speechEvents.push(name + (event.error ? ":" + event.error : "")),
      );
    speak(utterance);
  };

  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...parts) {
      super(...parts);
      this.addEventListener("message", (event) => {
        if (event.data?.type) probe.workerEvents.push(event.data.type);
      });
      this.addEventListener("error", (event) => {
        probe.workerEvents.push("error:" + event.message);
        log("worker", event.message);
      });
    }
  };
  const NativeContext = window.AudioContext;
  window.AudioContext = class extends NativeContext {
    constructor(...parts) {
      super(...parts);
      probe.contexts.push(this);
    }
  };

  (async () => {
    for (;;) {
      const response = await nativeFetch("/__probe/next").catch(() => null);
      if (response === null) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (response.status !== 200) continue;
      const { id, code } = await response.json();
      let outcome;
      try {
        outcome = { value: await (0, eval)("(async () => {" + code + "})()") };
      } catch (error) {
        outcome = { error: String(error) };
      }
      await post("/__probe/result", { id, ...outcome });
    }
  })();
  log("page", "probe " + navigator.userAgent);
})();`;

function readBody(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => resolve(Buffer.concat(parts).toString()));
  });
}

export function safariProbe({ macPort }) {
  const queue = [];
  const waiting = new Set();
  const pending = new Map();
  const logs = [];
  let cookies = [];
  const deliver = () => {
    while (queue.length > 0 && waiting.size > 0) {
      const [next] = waiting;
      waiting.delete(next);
      next.end(JSON.stringify(queue.shift()));
    }
  };
  return {
    name: "shop-voice-safari-probe",
    transformIndexHtml: () => [
      {
        tag: "script",
        attrs: { src: "/__probe/probe.js" },
        injectTo: "head-prepend",
      },
    ],
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, "http://probe");
        if (!url.pathname.startsWith("/__probe/")) return next();
        switch (url.pathname) {
          case "/__probe/probe.js":
            response.setHeader("content-type", "text/javascript");
            response.end(`const MAC_PORT = ${macPort};\n${PAGE_SCRIPT}`);
            return;
          case "/__probe/cookies":
            cookies = JSON.parse(await readBody(request));
            response.end("{}");
            return;
          // The page under test gets the member's session, as a sign-in does.
          case "/__probe/open":
            response.setHeader(
              "set-cookie",
              cookies.map((cookie) => `${cookie}; Path=/; Max-Age=86400`),
            );
            response.statusCode = 302;
            response.setHeader("location", url.searchParams.get("to"));
            response.end();
            return;
          case "/__probe/next":
            waiting.add(response);
            deliver();
            setTimeout(() => {
              if (waiting.delete(response)) {
                response.statusCode = 204;
                response.end();
              }
            }, 20_000);
            return;
          case "/__probe/result": {
            const result = JSON.parse(await readBody(request));
            pending.get(result.id)?.end(JSON.stringify(result));
            pending.delete(result.id);
            response.end("{}");
            return;
          }
          case "/__probe/run": {
            const id = randomUUID();
            queue.push({ id, code: await readBody(request) });
            pending.set(id, response);
            deliver();
            return;
          }
          case "/__probe/log":
            logs.push({
              at: Date.now(),
              ...JSON.parse(await readBody(request)),
            });
            response.end("{}");
            return;
          case "/__probe/logs":
            response.end(JSON.stringify(logs));
            return;
          case "/__probe/speech": {
            const file = join(tmpdir(), `shop-voice-${randomUUID()}.wav`);
            execFileSync(
              "say",
              [
                "-v",
                url.searchParams.get("voice"),
                "-o",
                file,
                "--data-format=LEI16@16000",
                url.searchParams.get("text"),
              ],
              { timeout: 60_000 },
            );
            response.setHeader("content-type", "audio/wav");
            response.end(readFileSync(file));
            rmSync(file);
            return;
          }
          default:
            response.statusCode = 404;
            response.end();
        }
      });
    },
  };
}
