// The real shop gateway's device adapters for the E2E journeys (Plan 90
// Phase 5). A journey's simulated socket only carries messages: each task
// message goes to `shop-gateway answer` (crates/shop-gateway), the same code
// that a gateway in a shop runs, with its own journal and a simulated
// printer. The binary decides what prints; the journey only relays.
//
// The printer's files stay in output/e2e/shop-gateway/<home>/printer: the
// StarPRNT bytes and the plain-text rendering of each receipt and drawer task.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/**
 * `POST /reset {home}` starts an empty gateway folder. `POST /answer {home,
 * printers, message}` answers one task message and returns the gateway's
 * messages. `POST /printed {home, sourceKey}` returns what the printer wrote.
 */
export async function shopGatewayAdapters(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const home = homeOf(body.home);
  switch (new URL(request.url).pathname) {
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
