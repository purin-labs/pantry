// The real shop gateway's device adapters for the E2E journeys (Plan 90
// Phase 5). A journey's simulated socket only carries messages: each task
// message goes to `shop-gateway answer` (crates/shop-gateway), the same code
// that a gateway in a shop runs, with its own journal and a simulated
// printer. The binary decides what prints; the journey only relays.
//
// The printer's files stay in output/e2e/shop-gateway/<home>/printer: the
// StarPRNT bytes and the plain-text rendering of each receipt and drawer task.
//
// A cobot session (Plan 24 S3) lives across requests: the controller
// simulator (`cobot-controller`, crates/bakery-native/controller) and the
// real gateway's `shop-gateway relay`, whose standard input and output carry
// the Platform's messages. The journey's socket only carries them.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Response, type Request } from "miniflare";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUTPUT = join(repository, "output/e2e/shop-gateway");

let binary: string | null = null;

/** Builds the gateway once for this Vitest process. */
function gatewayBinary(): string {
  if (binary !== null) return binary;
  const built = spawnSync("cargo", ["build", "-p", "shop-gateway"], {
    cwd: repository,
    encoding: "utf8",
  });
  if (built.status !== 0)
    throw new Error(`shop-gateway build failed: ${built.stderr}`);
  const target = process.env.CARGO_TARGET_DIR ?? join(repository, "target");
  binary = join(target, "debug/shop-gateway");
  return binary;
}

type SimulatedPrinter = Readonly<{
  sourceKey: string;
  drawer: boolean;
  status: "ready" | "offline" | "paper_out" | "cover_open";
}>;

function homeOf(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-z0-9-]{1,64}$/u.test(raw))
    throw new Error("A gateway home is a short lower-case name.");
  return join(OUTPUT, raw);
}

let controller: string | null = null;

/**
 * The controller simulator: PANTRY_COBOT_CONTROLLER_BINARY, or a release
 * build of the bakery-native crate with MUJOCO_DIR, once for this process.
 */
function controllerBinary(): string {
  if (controller !== null) return controller;
  const given = process.env.PANTRY_COBOT_CONTROLLER_BINARY;
  if (given !== undefined && given !== "") return (controller = given);
  if (!process.env.MUJOCO_DIR)
    throw new Error(
      "Set PANTRY_COBOT_CONTROLLER_BINARY, or MUJOCO_DIR to build cobot-controller.",
    );
  const manifest = join(repository, "crates/bakery-native/Cargo.toml");
  const built = spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifest,
      "--bin",
      "cobot-controller",
    ],
    { cwd: repository, encoding: "utf8" },
  );
  if (built.status !== 0)
    throw new Error(`cobot-controller build failed: ${built.stderr}`);
  controller = join(
    repository,
    "crates/bakery-native/target/release/cobot-controller",
  );
  return controller;
}

type CobotSession = {
  home: string;
  controller: ChildProcess;
  relay: ChildProcess;
  ports: Record<string, number>;
  ready: unknown;
  /** The relay's messages that no drain has taken yet. */
  messages: unknown[];
};

const cobotSessions = new Map<string, CobotSession>();

process.once("exit", () => {
  for (const session of cobotSessions.values()) {
    session.relay.kill("SIGKILL");
    session.controller.kill("SIGKILL");
  }
});

async function startCobotSession(
  home: string,
  timeScale: number,
): Promise<CobotSession> {
  await stopCobotSession(home);
  rmSync(home, { recursive: true, force: true });
  const gatewayHome = join(home, "gateway");
  mkdirSync(gatewayHome, { recursive: true });
  // The system picks the controller's ports; its first line names them.
  const simulator = spawn(
    controllerBinary(),
    [
      "--root",
      repository,
      "--port",
      "0",
      "--time-scale",
      String(timeScale),
      "--state-dir",
      join(home, "controller"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  simulator.stderr?.pipe(createWriteStream(join(home, "controller.log")));
  const line = await new Promise<string>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error("The controller simulator did not start.")),
      60_000,
    );
    simulator.once("exit", () => {
      clearTimeout(timer);
      fail(new Error(`The controller simulator ended: ${home}/controller.log`));
    });
    createInterface({ input: simulator.stdout! }).once("line", (text) => {
      clearTimeout(timer);
      done(text);
    });
  });
  const ready = JSON.parse(line) as { ports: Record<string, number> };
  writeFileSync(
    join(gatewayHome, "cobots.json"),
    JSON.stringify({
      controllers: ["cobot-1", "cobot-2", "oven-1"].map((sourceKey) => ({
        sourceKey,
        host: "127.0.0.1",
        port: ready.ports[sourceKey],
      })),
    }),
  );
  const session: CobotSession = {
    home,
    controller: simulator,
    relay: simulator,
    ports: ready.ports,
    ready,
    messages: [],
  };
  session.relay = startRelay(session);
  cobotSessions.set(home, session);
  return session;
}

/** `shop-gateway relay` on the session's gateway folder. Its journal stays. */
function startRelay(session: CobotSession): ChildProcess {
  const relay = spawn(gatewayBinary(), ["relay"], {
    env: { ...process.env, PANTRY_GATEWAY_HOME: join(session.home, "gateway") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  relay.stderr?.pipe(
    createWriteStream(join(session.home, "relay.log"), { flags: "a" }),
  );
  createInterface({ input: relay.stdout! }).on("line", (line) =>
    session.messages.push(JSON.parse(line) as unknown),
  );
  return relay;
}

async function stopCobotSession(home: string): Promise<void> {
  const session = cobotSessions.get(home);
  if (session === undefined) return;
  cobotSessions.delete(home);
  for (const child of [session.relay, session.controller])
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
}

/** One line to the controller's control port, and its one-line answer. */
async function controlLine(port: number, line: unknown): Promise<unknown> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`${JSON.stringify(line)}\n`);
  const [answer] = await once(createInterface({ input: socket }), "line");
  socket.destroy();
  return JSON.parse(String(answer)) as unknown;
}

function cobotSession(home: string): CobotSession {
  const session = cobotSessions.get(home);
  if (session === undefined) throw new Error(`No cobot session in ${home}`);
  return session;
}

/** `POST /cobot/...`: the long-lived cobot session of one home. */
async function cobotRequest(
  path: string,
  home: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (path) {
    case "/cobot/start": {
      const session = await startCobotSession(
        home,
        Number(body.timeScale ?? 1),
      );
      return Response.json({
        ok: true,
        ports: session.ports,
        ready: session.ready,
      });
    }
    case "/cobot/send": {
      cobotSession(home).relay.stdin?.write(
        `${JSON.stringify(body.message)}\n`,
      );
      return Response.json({ ok: true });
    }
    case "/cobot/drain": {
      await delay(Math.min(Number(body.waitMs ?? 0), 2_000));
      const session = cobotSession(home);
      const messages = session.messages.splice(0);
      return Response.json({ ok: true, messages });
    }
    case "/cobot/control": {
      const answer = await controlLine(
        cobotSession(home).ports.control!,
        body.line,
      );
      return Response.json({ ok: true, answer });
    }
    case "/cobot/restart-relay": {
      const session = cobotSession(home);
      session.relay.kill("SIGKILL");
      if (session.relay.exitCode === null) await once(session.relay, "exit");
      session.relay = startRelay(session);
      return Response.json({ ok: true });
    }
    case "/cobot/artifact": {
      const name = String(body.name);
      if (!/^[a-z0-9-]{1,64}$/u.test(name))
        throw new Error("An artifact name is a short lower-case name.");
      const folder = join(repository, "output/plan-24");
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `${name}.json`);
      writeFileSync(file, `${JSON.stringify(body.artifact, null, 2)}\n`);
      return Response.json({ ok: true, file });
    }
    case "/cobot/stop":
      await stopCobotSession(home);
      return Response.json({ ok: true });
    default:
      return new Response(null, { status: 404 });
  }
}

/**
 * `POST /reset {home}` starts an empty gateway folder. `POST /answer {home,
 * printers, message}` answers one task message and returns the gateway's
 * messages. `POST /printed {home, sourceKey}` returns what the printer wrote.
 * `POST /cobot/start {home, timeScale}` starts a cobot session; `/cobot/send
 * {home, message}` gives the relay one Platform message; `/cobot/drain {home,
 * waitMs}` takes the relay's messages; `/cobot/control {home, line}` asks the
 * controller's control port; `/cobot/restart-relay`, `/cobot/artifact {name,
 * artifact}` and `/cobot/stop` end the list.
 */
export async function shopGatewayAdapters(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const home = homeOf(body.home);
  const path = new URL(request.url).pathname;
  if (path.startsWith("/cobot/")) return cobotRequest(path, home, body);
  switch (path) {
    case "/reset":
      rmSync(home, { recursive: true, force: true });
      mkdirSync(join(home, "gateway"), { recursive: true });
      return Response.json({ ok: true, home });
    case "/answer": {
      const printers = (body.printers ?? []) as readonly SimulatedPrinter[];
      const simulation = join(home, "simulation.json");
      writeFileSync(
        simulation,
        JSON.stringify({
          printers: printers.map((printer) => ({
            ...printer,
            outputDir: join(home, "printer"),
          })),
        }),
      );
      const answered = spawnSync(
        gatewayBinary(),
        ["answer", "--simulate", simulation],
        {
          input: JSON.stringify(body.message),
          encoding: "utf8",
          env: { ...process.env, PANTRY_GATEWAY_HOME: join(home, "gateway") },
        },
      );
      if (answered.status !== 0)
        return Response.json(
          { ok: false, error: answered.stderr },
          { status: 500 },
        );
      const answers = answered.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
      return Response.json({ ok: true, answers });
    }
    case "/printed": {
      const sourceKey = String(body.sourceKey);
      const text = join(home, "printer", `${sourceKey}.txt`);
      const bytes = join(home, "printer", `${sourceKey}.starprnt`);
      return Response.json({
        ok: true,
        textFile: text,
        text: existsSync(text) ? readFileSync(text, "utf8") : "",
        bytes: existsSync(bytes) ? readFileSync(bytes).toString("hex") : "",
      });
    }
    default:
      return new Response(null, { status: 404 });
  }
}
