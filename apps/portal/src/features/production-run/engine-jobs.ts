import {
  parseApplianceResult,
  type ApplianceRequest,
  type ApplianceResult,
} from "@seams/bakery-model/bakery-appliance-protocol";
import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  parsePhysicsRequest,
  type PhysicsReplay,
  type PhysicsRequest,
} from "@seams/bakery-model/bakery-physics";
import {
  parseNativeContinuation,
  type NativeContinuation,
} from "@seams/production-simulation/recipes/bakery/native-continuation";
import { applianceRuntime } from "@seams/production-simulation/simulator/appliance-runtime";
import type {
  BrowserPhysicsMode,
  BrowserPhysicsOutcome,
  BrowserPhysicsTask,
} from "@seams/production-simulation/simulator/browser-physics-task";
import { errorMessage, isRecord } from "@seams/std";
import { openExecutionWorker, type ExecutionWorker } from "./execution-client";
import type { JobProgress } from "./job-progress";

export type { JobProgress } from "./job-progress";

export type {
  BrowserPhysicsMode,
  BrowserPhysicsOutcome,
  BrowserPhysicsTask,
} from "@seams/production-simulation/simulator/browser-physics-task";

/**
 * The one-shot physics jobs of a page (Refactor 16, step 5): "Run in
 * browser", the agent's simulate_workcell, the robot comparison and the
 * espresso pages. Every job runs in one engine worker, which the page keeps
 * for the next job, so a second job fetches and compiles nothing. A job runs
 * as a host program in bounded calls: it reports its step, and Stop ends it
 * at the next step boundary and keeps the worker.
 */

type BrowserPhysicsHandlers = Readonly<{
  prepared(request: PhysicsRequest): Promise<boolean>;
  completed(outcome: BrowserPhysicsOutcome): void;
  failed(message: string): void;
  progress(progress: JobProgress): void;
}>;

type AppliancePhysicsHandlers = Readonly<{
  prepared(request: ApplianceRequest): Promise<boolean>;
  completed(result: ApplianceResult): void;
  failed(message: string): void;
  progress(progress: JobProgress): void;
}>;

type Active = Readonly<{
  id: string;
  watchdog: number;
  failed(message: string): void;
}> & { worker: ExecutionWorker | null };

const MAX_WALL_MS = 125_000;
/** About 40–80 ms of a transfer in Wasm: progress and Stop stay prompt. */
const STEPS_PER_CALL = 2000;

let shared: Promise<ExecutionWorker> | null = null;

/** The page's engine worker, started by the first job. */
function engineWorker(): Promise<ExecutionWorker> {
  if (shared === null) {
    const opening = openExecutionWorker(null).then((opened) => {
      if (!opened.ok)
        throw new Error(
          `The browser engine did not start (${opened.error.code}).`,
        );
      return opened.value;
    });
    shared = opening;
    // A failed start is tried again by the next job.
    opening.catch(forget.bind(null, opening));
  }
  return shared;
}

function forget(opening: Promise<ExecutionWorker>): void {
  if (shared === opening) shared = null;
}

/** A worker that failed is not used again; the next job starts a new one. */
function drop(worker: ExecutionWorker): void {
  void shared?.then((current) => {
    if (current === worker) shared = null;
  });
  worker.terminate();
}

const JOB_FAILED = "The browser simulation failed.";

class JobFailed extends Error {}

/** A job reply, or the reason the worker gave for its refusal. */
function expect(reply: unknown, kind: string): Record<string, unknown> {
  if (isRecord(reply) && reply.kind === kind) return reply;
  if (isRecord(reply) && reply.kind === "refused")
    throw new JobFailed(
      typeof reply.detail === "string"
        ? reply.detail
        : `The browser job was refused (${String(reply.reason)}).`,
    );
  throw new JobFailed("The browser worker returned an invalid message.");
}

export class EngineJobs {
  private active: Active | null = null;

  get running(): boolean {
    return this.active !== null;
  }

  start(
    request: PhysicsRequest,
    mode: BrowserPhysicsMode,
    handlers: BrowserPhysicsHandlers,
  ): void {
    this.begin({ kind: "request", request, mode }, handlers);
  }

  execute(
    task: BrowserPhysicsTask,
    prepared: BrowserPhysicsHandlers["prepared"],
    progress: BrowserPhysicsHandlers["progress"],
  ): Promise<BrowserPhysicsOutcome> {
    return new Promise(
      startAsyncJob.bind(null, this, task, prepared, progress),
    );
  }

  begin(task: BrowserPhysicsTask, handlers: BrowserPhysicsHandlers): void {
    if (
      (task.kind === "request" || task.kind === "prepared-request") &&
      new TextEncoder().encode(JSON.stringify(task.request)).length >
        MAX_REQUEST_BYTES
    )
      throw new Error("The selected request exceeds the browser limit.");
    const job = this.open(handlers.failed);
    handlers.progress({ stage: "loading" });
    void this.runWorkcell(job, task, handlers);
  }

  beginAppliance(
    request: ApplianceRequest,
    handlers: AppliancePhysicsHandlers,
  ): void {
    const job = this.open(handlers.failed);
    handlers.progress({ stage: "loading" });
    void this.runAppliance(job, request, handlers);
  }

  /** Ends the job at its next step boundary. The engine worker stays. */
  stop(): void {
    const job = this.active;
    if (job === null) return;
    this.finish(job);
    void job.worker?.request({ kind: "job-close", job: job.id });
    job.failed("Browser simulation stopped. Completed tasks are preserved.");
  }

  private open(failed: (message: string) => void): Active {
    if (this.active !== null)
      throw new Error("A browser physics job is already active.");
    const id = `job-${crypto.randomUUID()}`;
    const job: Active = {
      id,
      failed,
      worker: null,
      watchdog: window.setTimeout(this.expired.bind(this, id), MAX_WALL_MS),
    };
    this.active = job;
    return job;
  }

  private async attach(job: Active): Promise<ExecutionWorker | null> {
    const worker = await engineWorker();
    if (this.active !== job) return null;
    job.worker = worker;
    return worker;
  }

  private async runWorkcell(
    job: Active,
    task: BrowserPhysicsTask,
    handlers: BrowserPhysicsHandlers,
  ): Promise<void> {
    try {
      const worker = await this.attach(job);
      if (worker === null) return;
      const wire =
        task.kind === "continuation"
          ? {
              kind: "continuation",
              file: task.handoff.file,
              rackCase: task.rackCase,
            }
          : task;
      const opened = expect(
        await worker.request({ kind: "job-open", job: job.id, task: wire }),
        "job-prepared",
      );
      if (this.active !== job) return;
      const parsed = parsePhysicsRequest(JSON.stringify(opened.request));
      if (
        parsed.kind === "rejected" ||
        parsed.request.execution.backend !== "browser"
      )
        throw new JobFailed(
          "The browser worker prepared an invalid build identity.",
        );
      const request = parsed.request;
      const accepted = await handlers.prepared(request);
      if (this.active !== job) return;
      if (!accepted) {
        void worker.request({ kind: "job-close", job: job.id });
        throw new JobFailed(
          "The selected run changed before browser execution.",
        );
      }
      let reply = await worker.request({ kind: "job-start", job: job.id });
      for (;;) {
        if (this.active !== job) return;
        if (!isRecord(reply) || reply.kind !== "job-running") break;
        handlers.progress({
          stage: "running",
          task: String(reply.task),
          step: Number(reply.step),
          planned: Number(reply.planned),
        });
        reply = await worker.request({
          kind: "job-advance",
          job: job.id,
          steps: STEPS_PER_CALL,
        });
      }
      await this.recover(worker, reply);
      const outcome = checkedOutcome(request, expect(reply, "job-completed"));
      if (this.active !== job) return;
      this.finish(job);
      handlers.completed(outcome);
    } catch (error) {
      this.fail(job, error);
    }
  }

  private async runAppliance(
    job: Active,
    request: ApplianceRequest,
    handlers: AppliancePhysicsHandlers,
  ): Promise<void> {
    try {
      const bundle = applianceRuntime(request);
      const worker = await this.attach(job);
      if (worker === null) return;
      const accepted = await handlers.prepared(request);
      if (this.active !== job) return;
      if (!accepted)
        throw new JobFailed(
          "The selected run changed before appliance execution.",
        );
      handlers.progress({
        stage: "running",
        task: "appliance",
        step: 0,
        planned: 0,
      });
      // A saved state continues only on the bundle that saved it (Plan 70B).
      const file =
        bundle.id === worker.manifest.runtime.id
          ? String(
              expect(
                await worker.request({
                  kind: "appliance-run",
                  file: request.file,
                }),
                "appliance-result",
              ).file,
            )
          : await retainedAppliance(bundle, request.file);
      if (this.active !== job) return;
      if (new TextEncoder().encode(file).length > MAX_RECORDING_BYTES)
        throw new JobFailed("Invalid appliance result summary.");
      const result = parseApplianceResult(file, request);
      this.finish(job);
      handlers.completed(result);
    } catch (error) {
      this.fail(job, error);
    }
  }

  /** After a Wasm trap the module can be damaged: start a new one. */
  private async recover(
    worker: ExecutionWorker,
    reply: unknown,
  ): Promise<void> {
    if (!isRecord(reply) || reply.reason !== "host_fault") return;
    const reset = await worker.request({ kind: "reset" }).catch(() => null);
    if (!isRecord(reset) || reset.kind !== "reset") drop(worker);
  }

  private expired(id: string): void {
    const job = this.active;
    if (job === null || job.id !== id) return;
    void job.worker?.request({ kind: "job-close", job: job.id });
    this.fail(
      job,
      new JobFailed("The browser simulation exceeded its 125-second limit."),
    );
  }

  private fail(job: Active, error: unknown): void {
    if (this.active !== job) return;
    this.finish(job);
    // Only a refusal leaves the worker sound; any other error ends it.
    if (!(error instanceof JobFailed) && job.worker !== null) drop(job.worker);
    job.failed(errorMessage(error, JOB_FAILED));
  }

  private finish(job: Active): void {
    window.clearTimeout(job.watchdog);
    if (this.active === job) this.active = null;
  }
}

/**
 * The worker's result. The worker checked the recording's digest and parsed
 * it (Refactor 16, step 11), so the page takes the parsed recording and
 * checks only that it belongs to this attempt. A handoff job brings its
 * handoff file, which the page parses once: the parsed recording is its
 * predecessor.
 */
function checkedOutcome(
  request: PhysicsRequest,
  raw: Record<string, unknown>,
): BrowserPhysicsOutcome {
  if (
    raw.attemptId !== request.attemptId ||
    typeof raw.recordingDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.recordingDigest) ||
    typeof raw.bytes !== "number" ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 0 ||
    raw.bytes > MAX_RECORDING_BYTES ||
    typeof raw.elapsedMs !== "number" ||
    !Number.isFinite(raw.elapsedMs) ||
    raw.elapsedMs < 0 ||
    raw.elapsedMs > MAX_WALL_MS
  )
    throw new JobFailed(
      "The browser worker returned an invalid result summary.",
    );
  let handoff: NativeContinuation | null = null;
  let recording: PhysicsReplay;
  if (typeof raw.handoffText === "string") {
    handoff = parseNativeContinuation(raw.handoffText);
    recording = handoff.predecessor;
  } else recording = workerReplay(raw.recording);
  const first =
    recording.kind === "bakery-physics-recording"
      ? recording
      : recording.loading;
  if (JSON.stringify(first.request) !== JSON.stringify(request))
    throw new JobFailed("The browser recording targeted another attempt.");
  return {
    request,
    recording,
    handoff,
    recordingDigest: raw.recordingDigest,
    bytes: raw.bytes,
    elapsedMs: raw.elapsedMs,
  };
}

/**
 * A recording that this page's engine worker parsed with parsePhysicsReplay.
 * The structured clone keeps every field and drops only the symbol brand of
 * the parsed type, which no code reads at run time.
 */
function workerReplay(value: unknown): PhysicsReplay {
  if (
    !isRecord(value) ||
    (value.kind !== "bakery-physics-recording" &&
      value.kind !== "bakery-physics-sequence" &&
      value.kind !== "bakery-physics-rack-sequence")
  )
    throw new JobFailed("The browser worker returned no recording.");
  return value as unknown as PhysicsReplay;
}

/** One request on an older retained bundle, in a worker of its own. */
function retainedAppliance(
  bundle: ReturnType<typeof applianceRuntime>,
  file: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./retained-appliance-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate();
      const reply = event.data;
      if (
        isRecord(reply) &&
        reply.kind === "appliance-result" &&
        typeof reply.file === "string"
      )
        resolve(reply.file);
      else
        reject(
          new JobFailed(
            isRecord(reply) && typeof reply.message === "string"
              ? reply.message
              : "The appliance job failed.",
          ),
        );
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      reject(new JobFailed("The browser simulation worker crashed."));
    };
    worker.postMessage({ bundle, file });
  });
}

function startAsyncJob(
  jobs: EngineJobs,
  task: BrowserPhysicsTask,
  prepared: BrowserPhysicsHandlers["prepared"],
  progress: BrowserPhysicsHandlers["progress"],
  resolve: (outcome: BrowserPhysicsOutcome) => void,
  reject: (error: Error) => void,
): void {
  jobs.begin(task, {
    prepared,
    progress,
    completed: resolve,
    failed: rejectJob.bind(null, reject),
  });
}

function rejectJob(reject: (error: Error) => void, message: string): void {
  reject(new Error(message));
}
