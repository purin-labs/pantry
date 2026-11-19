import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import portalConfig from "../../apps/portal/vite.config";

// The recorder of real commands (Plan 82C Phase 3): the Portal's voice capture
// from source, on 127.0.0.1 only. Each session goes to .cache/human/<session>/,
// which git ignores, and the recordings leave this Mac in no other way.
//
//   pnpm --filter @purin-labs/portal exec vite --config ../../scripts/shop-voice/recorder.vite.config.ts
//   open http://127.0.0.1:3185/voice-recorder.html
//
// The prompts come from `phrase-bench.py prompts`, which the bench reads too.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SESSIONS = join(ROOT, ".cache/human");
const PYTHON =
  process.env.SHOP_VOICE_PYTHON ??
  join(homedir(), ".satyr-voice/venv/bin/python");
const EVENTS = new Set(["captured", "no_speech", "near_wake", "skipped"]);

type Prompt = { index: number; set: string; kind: string; target: string };
type Session = { name: string; folder: string; prompts: Prompt[] };

function readPrompts(): Prompt[] {
  const answer = spawnSync(
    PYTHON,
    [join(ROOT, "scripts/shop-voice/phrase-bench.py"), "prompts"],
    { encoding: "utf8" },
  );
  if (answer.status !== 0) throw new Error(answer.stderr);
  return JSON.parse(answer.stdout) as Prompt[];
}

/** The local time, as a folder name: 2026-11-16-0142. */
function sessionName(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function answer(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function recorder() {
  const sessions = new Map<string, Session>();
  return {
    name: "satyr-voice-recorder",
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          handle: (request: IncomingMessage, response: ServerResponse) => void,
        ) => void;
      };
    }) {
      server.middlewares.use("/recorder", (request, response) => {
        void (async () => {
          if (request.method !== "POST")
            return answer(response, 405, { error: "POST only" });
          const body = (await readJson(request)) as Record<string, unknown>;
          if (request.url === "/start") {
            const name = sessionName(new Date());
            const folder = join(SESSIONS, name);
            mkdirSync(folder, { recursive: true });
            // `only` keeps one set, with the prompts' own numbers, such as the room sound alone.
            const prompts = readPrompts().filter(
              (prompt) =>
                typeof body.only !== "string" || prompt.set === body.only,
            );
            if (prompts.length === 0)
              return answer(response, 400, { error: "no such set" });
            sessions.set(name, { name, folder, prompts });
            writeFileSync(
              join(folder, "session.json"),
              `${JSON.stringify(
                {
                  startedAt: new Date().toISOString(),
                  microphone: body.microphone,
                  userAgent: body.userAgent,
                  prompts,
                },
                null,
                1,
              )}\n`,
            );
            return answer(response, 200, { session: name, prompts });
          }
          if (request.url === "/clip") {
            const session = sessions.get(String(body.session));
            const prompt = session?.prompts.find(
              (each) => each.index === Number(body.index),
            );
            const event = String(body.event);
            const attempt = Number(body.attempt);
            if (
              session === undefined ||
              prompt === undefined ||
              !EVENTS.has(event) ||
              !Number.isInteger(attempt)
            )
              return answer(response, 400, { error: "unknown clip" });
            const file =
              event === "captured" && typeof body.wav === "string"
                ? `${String(prompt.index).padStart(3, "0")}-${prompt.set}-${attempt}.wav`
                : null;
            if (file !== null)
              writeFileSync(
                join(session.folder, file),
                Buffer.from(body.wav as string, "base64"),
              );
            appendFileSync(
              join(session.folder, "clips.jsonl"),
              `${JSON.stringify({ ...prompt, attempt, event, file, at: new Date().toISOString() })}\n`,
            );
            return answer(response, 200, { file });
          }
          return answer(response, 404, { error: "unknown route" });
        })().catch((error: unknown) =>
          answer(response, 500, { error: String(error) }),
        );
      });
    },
  };
}

export default {
  ...portalConfig,
  plugins: [...(portalConfig.plugins ?? []), recorder()],
  root: fileURLToPath(new URL("../../apps/portal", import.meta.url)),
  server: {
    ...portalConfig.server,
    host: "127.0.0.1",
    port: 3185,
    strictPort: true,
    hmr: false,
    proxy: {},
  },
};
