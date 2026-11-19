import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  parseIngredientLoad,
  parsePhysicsReplay,
  parsePhysicsRequest,
  physicsCellOf,
  type PhysicsReplay,
  type PhysicsRequest,
} from "@purin-labs/bakery-model/bakery-physics";
import { parseRobotModel } from "@purin-labs/bakery-model/bakery-robots";
import { parseNativeContinuation } from "@purin-labs/production-simulation/recipes/bakery/native-continuation";
import { isRecord, sha256Hex } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The one-shot jobs of the engine worker (Refactor 16, step 5): a robot
 * comparison, a workcell transfer, an oven loading or cycle, and a
 * continuation from a handoff. Each one is a host program in the persistent
 * module, advanced in bounded calls, so the job reports its step and stops
 * at a step boundary. The worker and its module stay for the next job.
 *
 * This code runs inside the execution worker. It prepares a job as the
 * earlier one-shot worker did, so each job keeps its requests and results.
 */

export type JobMode =
  "transfer" | "oven-cycle" | "rack-cycle" | "loading" | "oven-handoff";

export type JobTask =
  | Readonly<{
      kind: "selection";
      robot: unknown;
      ingredients: unknown;
      task: "table-to-rack" | "table-to-oven";
      scenario: "nominal" | "blocked" | "unreachable";
    }>
  | Readonly<{
      kind: "request" | "prepared-request";
      mode: JobMode;
      request: unknown;
    }>
  | Readonly<{
      kind: "continuation";
      file: string;
      rackCase: "nominal" | "slip";
    }>;

/** The host protocol as text, and the module's file system. */
export type ProgramHost = Readonly<{
  exchange(command: string): Promise<string>;
  readFile(path: string): Uint8Array;
}>;

type Program = Readonly<Record<string, unknown>>;

type Job = {
  /** The request the job's first recording must carry. */
  request: PhysicsRequest;
  /** Waits for `start`; null after it. */
  program: Program | null;
  /** A reply that arrived with the opening (a comparison opens at once). */
  opened: unknown;
  startedAt: number;
};

export type JobReply =
  | Readonly<{ kind: "job-prepared"; job: string; request: PhysicsRequest }>
  | Readonly<{
      kind: "job-running";
      job: string;
      task: string;
      step: number;
      planned: number;
    }>
  | Readonly<{
      kind: "job-completed";
      job: string;
      attemptId: string;
      /**
       * The recording as parsePhysicsReplay accepted it in this worker, so
       * the page neither hashes nor parses it (Refactor 16, step 11). A
       * handoff job sends the handoff file instead: its parsed form carries
       * a brand that a structured clone drops, so the page parses it.
       */
      recording: PhysicsReplay | null;
      handoffText: string | null;
      recordingDigest: string;
      bytes: number;
      elapsedMs: number;
    }>
  | Readonly<{ kind: "job-closed"; job: string }>
  | Readonly<{ kind: "refused"; reason: string; detail: unknown }>;

const MANIFEST = "/assets/bakery-mujoco/fr10-workcell/native/assets.json";

function refused(reason: string, detail: unknown): JobReply {
  return { kind: "refused", reason, detail };
}

/** The module itself failed (a Wasm trap). Its worlds can be damaged. */
class HostFault extends Error {}

/** A refusal; after a host fault the page starts a new module. */
function refusal(error: unknown): JobReply {
  return error instanceof HostFault
    ? refused("host_fault", error.message)
    : refused("job_failed", message(error));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The browser job failed.";
}

export class EnginePrograms {
  private readonly host: ProgramHost;
  private readonly jobs = new Map<string, Job>();
  private manifestHash: string | null = null;

  constructor(host: ProgramHost) {
    this.host = host;
  }

  private async program(command: Program): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await this.host.exchange(
        JSON.stringify({ op: "program", command }),
      );
    } catch (error) {
      throw new HostFault(message(error));
    }
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) throw new Error("The host returned an invalid reply.");
    if (raw.kind === "failed")
      throw new Error(
        typeof raw.message === "string" ? raw.message : "The program failed.",
      );
    if (raw.kind !== "program" || !isRecord(raw.reply))
      throw new Error("The host returned an invalid program reply.");
    return raw.reply;
  }

  /** Prepares a job. Its request goes to the page before any step runs. */
  async open(job: string, input: unknown): Promise<JobReply> {
    if (this.jobs.has(job)) return refused("job_open", null);
    try {
      const prepared = await this.prepare(job, parseTask(input));
      this.jobs.set(job, prepared);
      return { kind: "job-prepared", job, request: prepared.request };
    } catch (error) {
      await this.program({ op: "close", job }).catch(discard);
      return refusal(error);
    }
  }

  /** Runs the job's first call after the page accepted its request. */
  async start(job: string): Promise<JobReply> {
    const found = this.jobs.get(job);
    if (found === undefined) return refused("unknown_job", null);
    found.startedAt = performance.now();
    if (found.program === null) return this.answer(job, found, found.opened);
    const program = found.program;
    found.program = null;
    return this.answer(
      job,
      found,
      await this.program({ op: "open", job, program }).catch(fault),
    );
  }

  async advance(job: string, steps: number): Promise<JobReply> {
    const found = this.jobs.get(job);
    if (found === undefined || found.program !== null)
      return refused("unknown_job", null);
    return this.answer(
      job,
      found,
      await this.program({ op: "advance", job, steps }).catch(fault),
    );
  }

  /** Ends a job at its present step boundary. The module stays. */
  async close(job: string): Promise<JobReply> {
    this.jobs.delete(job);
    await this.program({ op: "close", job }).catch(discard);
    return { kind: "job-closed", job };
  }

  private async answer(
    job: string,
    found: Job,
    reply: unknown,
  ): Promise<JobReply> {
    try {
      if (reply instanceof HostFault) throw reply;
      if (!isRecord(reply)) throw new Error("Invalid program reply.");
      if (reply.kind === "failed") throw new Error(String(reply.message));
      if (reply.kind === "running") {
        if (
          !isRecord(reply.request) ||
          typeof reply.request.bakeryTaskId !== "string" ||
          typeof reply.step !== "number" ||
          typeof reply.planned !== "number"
        )
          throw new Error("Invalid program progress.");
        return {
          kind: "job-running",
          job,
          task: reply.request.bakeryTaskId,
          step: reply.step,
          planned: reply.planned,
        };
      }
      if (reply.kind !== "finished" || typeof reply.output !== "string")
        throw new Error("Invalid program reply.");
      this.jobs.delete(job);
      return await completed(job, found, reply.output);
    } catch (error) {
      await this.close(job);
      return refusal(error);
    }
  }

  private async prepare(job: string, task: JobTask): Promise<Job> {
    if (task.kind === "selection") return this.selection(job, task);
    if (task.kind === "continuation") return continuation(task);
    const parsed = parsePhysicsRequest(JSON.stringify(task.request));
    if (parsed.kind === "rejected") throw new Error(parsed.message);
    const source = parsed.request;
    if (
      task.mode !== "transfer" &&
      (source.bakeryTaskId !== "table-to-oven" || source.case !== "nominal")
    )
      throw new Error("A browser cycle requires nominal oven loading.");
    if (JSON.stringify(task.request).length > MAX_REQUEST_BYTES)
      throw new Error("The selected request exceeds the browser limit.");
    const cell = await this.cellFor(source);
    if (task.mode === "rack-cycle" && cell === "separate")
      throw new Error("A rack cycle requires a combined cell.");
    const generated = await this.program({
      op: "prepare",
      preparation: {
        robot: source.robot,
        ingredientMassKg: source.ingredients.massKg,
        ingredientForwardMm: source.ingredients.forwardMm,
        ingredientLateralMm: source.ingredients.lateralMm,
        clampForceN: source.clampForceN,
        task: source.bakeryTaskId,
        cell,
        case: source.case,
        timestep: source.timestep,
        rackXMm: source.layout.kind === "fixed" ? 0 : source.layout.xMm,
        rackYMm: source.layout.kind === "fixed" ? 0 : source.layout.yMm,
      },
    });
    if (generated.kind !== "prepared" || !isRecord(generated.request))
      throw new Error("The browser controller returned an invalid request.");
    // A cross-cell human boundary already binds this request to accepted evidence.
    const executable = {
      ...generated.request,
      runId: source.runId,
      attemptId:
        task.kind === "prepared-request"
          ? source.attemptId
          : `attempt-${crypto.randomUUID()}`,
    };
    const selected = parsePhysicsRequest(JSON.stringify(executable));
    if (
      selected.kind === "rejected" ||
      selected.request.execution.backend !== "browser"
    )
      throw new Error("The browser build identity is invalid.");
    return {
      request: selected.request,
      program: programFor(task.mode, executable),
      opened: null,
      startedAt: 0,
    };
  }

  /** A comparison opens its cell at once: the cell builds the request. */
  private async selection(
    job: string,
    task: Variant<JobTask, "selection">,
  ): Promise<Job> {
    const robot = parseRobotModel(task.robot);
    const ingredients = parseIngredientLoad(task.ingredients);
    const reply = await this.program({
      op: "open",
      job,
      program: {
        kind: "comparison",
        robot,
        task: task.task,
        case: task.scenario,
        ingredients,
      },
    });
    let request: unknown = reply.request;
    if (reply.kind === "finished" && typeof reply.output === "string") {
      const recording: unknown = JSON.parse(reply.output);
      request = isRecord(recording) ? recording.request : null;
    }
    const parsed = parsePhysicsRequest(JSON.stringify(request));
    if (
      parsed.kind === "rejected" ||
      parsed.request.robot !== robot ||
      parsed.request.execution.backend !== "browser"
    )
      throw new Error("Prepared robot selection differs from this job.");
    return {
      request: parsed.request,
      program: null,
      opened: reply,
      startedAt: 0,
    };
  }

  /**
   * The cell that the controller prepares, from the model that the request
   * names in the assets of this bundle. The browser has no pan staging cell.
   */
  private async cellFor(source: PhysicsRequest): Promise<string> {
    this.manifestHash ??= await sha256Hex(this.host.readFile(MANIFEST));
    const cell = await physicsCellOf(source, this.manifestHash);
    if (cell === null && source.layout.kind !== "fixed")
      throw new Error("The rack placement does not match its model identity.");
    if (cell === null || cell === "pan-staging")
      throw new Error(
        "The request model does not match the pinned browser assets.",
      );
    // The controller names the fault cells without their "combined-" stem.
    return cell.replace(/^combined-/u, "");
  }
}

function discard(): void {}

/** A failed program call, as a reply: a fault stays a fault. */
function fault(error: unknown): unknown {
  return error instanceof HostFault
    ? error
    : { kind: "failed", message: message(error) };
}

function parseTask(raw: unknown): JobTask {
  if (!isRecord(raw)) throw new Error("Invalid browser job.");
  if (
    raw.kind === "selection" &&
    (raw.task === "table-to-rack" || raw.task === "table-to-oven") &&
    (raw.scenario === "nominal" ||
      raw.scenario === "blocked" ||
      raw.scenario === "unreachable")
  )
    return {
      kind: "selection",
      robot: raw.robot,
      ingredients: raw.ingredients,
      task: raw.task,
      scenario: raw.scenario,
    };
  if (
    (raw.kind === "request" || raw.kind === "prepared-request") &&
    (raw.mode === "transfer" ||
      raw.mode === "oven-cycle" ||
      raw.mode === "rack-cycle" ||
      raw.mode === "loading" ||
      raw.mode === "oven-handoff")
  )
    return { kind: raw.kind, mode: raw.mode, request: raw.request };
  if (
    raw.kind === "continuation" &&
    typeof raw.file === "string" &&
    (raw.rackCase === "nominal" || raw.rackCase === "slip")
  )
    return { kind: "continuation", file: raw.file, rackCase: raw.rackCase };
  throw new Error("Invalid browser job.");
}

function programFor(mode: JobMode, request: unknown): Program {
  switch (mode) {
    case "transfer":
      return { kind: "run", request };
    case "loading":
      return { kind: "load", request };
    case "oven-cycle":
      return { kind: "cycle", request, toRack: false };
    case "rack-cycle":
      return { kind: "cycle", request, toRack: true };
    case "oven-handoff":
      return { kind: "oven-handoff", request };
  }
}

function continuation(task: Variant<JobTask, "continuation">): Job {
  const handoff = parseNativeContinuation(task.file);
  const request =
    handoff.predecessor.kind === "bakery-physics-recording"
      ? handoff.predecessor.request
      : handoff.predecessor.loading.request;
  if (request.execution.backend !== "browser")
    throw new Error(
      "This handoff belongs to the native build. Start a new browser run to execute here.",
    );
  return {
    request,
    program:
      handoff.kind === "unload"
        ? {
            kind: "unload",
            file: task.file,
            forRack: handoff.predecessor.fixture.kind === "oven-and-rack",
          }
        : { kind: "rack", file: task.file, case: task.rackCase },
    opened: null,
    startedAt: 0,
  };
}

/** The checked result of a finished program, as the page reads it. */
async function completed(
  job: string,
  found: Job,
  output: string,
): Promise<JobReply> {
  if (new TextEncoder().encode(output).length > MAX_RECORDING_BYTES)
    throw new Error("The browser result exceeds the 16 MiB limit.");
  const raw: unknown = JSON.parse(output);
  let recordingText = output;
  let handoffText: string | null = null;
  if (
    isRecord(raw) &&
    (raw.kind === "bakery-physics-handoff" ||
      raw.kind === "bakery-native-rack-handoff")
  ) {
    const handoff = parseNativeContinuation(output);
    recordingText = JSON.stringify(handoff.predecessor);
    handoffText = output;
  }
  const bytes = new TextEncoder().encode(recordingText);
  if (bytes.length > MAX_RECORDING_BYTES)
    throw new Error("The browser recording exceeds the 16 MiB limit.");
  const parsed = parsePhysicsReplay(recordingText);
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  const first =
    parsed.recording.kind === "bakery-physics-recording"
      ? parsed.recording
      : parsed.recording.loading;
  if (JSON.stringify(first.request) !== JSON.stringify(found.request))
    throw new Error("The browser result does not match the prepared request.");
  return {
    kind: "job-completed",
    job,
    attemptId: found.request.attemptId,
    recording: handoffText === null ? parsed.recording : null,
    handoffText,
    recordingDigest: await sha256Hex(bytes),
    bytes: bytes.length,
    elapsedMs: Math.round(performance.now() - found.startedAt),
  };
}
