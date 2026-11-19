import { RequestDeadline } from "./request-deadline";

/**
 * The Cloudflare location that runs this isolate, for trace records.
 *
 * A Durable Object does not know where it runs, and the time of each database
 * and archive operation depends on it. Cloudflare answers the question for an
 * outgoing request: its trace endpoint names the location that sent the
 * request. The answer is read one time for each isolate and added to every
 * trace record, so each timing record says where it was measured.
 */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const READ_TIMEOUT_MS = 3_000;
/**
 * How long a caller waits for a read that another request started. The
 * runtime cancels a read whose request ended without `waitUntil`, and a
 * cancelled read never settles (Refactor 11, F4).
 */
const WAIT_LIMIT_MS = READ_TIMEOUT_MS + 500;

let location: string | null = null;
let reading: Promise<void> | null = null;

/** The location code of this isolate, or null until it is read. */
export function isolateLocation(): string | null {
  return location;
}

/**
 * Start the read of this isolate's location for a deployed Worker.
 * A local or test runtime runs at no Cloudflare location.
 */
export function startIsolateLocationRead(
  env: { readonly PANTRY_DEPLOYMENT_PROFILE?: string },
  context: { waitUntil(work: Promise<unknown>): void },
): void {
  if (
    location !== null ||
    reading !== null ||
    env.PANTRY_DEPLOYMENT_PROFILE !== "production"
  ) {
    return;
  }

  reading = readLocation();
  context.waitUntil(reading);
}

/**
 * The location code of this isolate, after its read ends. For a caller that
 * needs the answer in its own reply. Null in a local or test runtime, and
 * when Cloudflare gave no answer.
 */
export async function readIsolateLocation(env: {
  readonly PANTRY_DEPLOYMENT_PROFILE?: string;
}): Promise<string | null> {
  if (
    location === null &&
    env.PANTRY_DEPLOYMENT_PROFILE === "production"
  ) {
    const current = (reading ??= readLocation());
    if (!(await settlesWithin(current, WAIT_LIMIT_MS)) && reading === current) {
      // The next caller starts a new read.
      reading = null;
    }
  }

  return location;
}

/** Whether `work` settles before `limitMs` passes. */
async function settlesWithin(
  work: Promise<void>,
  limitMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<false>((done) => {
    timer = setTimeout(done, limitMs, false);
  });
  try {
    return await Promise.race([work.then(() => true as const), limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLocation(): Promise<void> {
  const deadline = new RequestDeadline(READ_TIMEOUT_MS);
  try {
    const response = await fetch(TRACE_URL, { signal: deadline.signal });

    if (response.ok) {
      location = locationCode(await response.text());
    }
  } catch {
    // The trace records stay without a location.
  } finally {
    deadline.end();
    // A later Actor of this isolate reads again when this read gave nothing.
    reading = null;
  }
}

/** The value of the `colo` line of a trace response. */
function locationCode(trace: string): string | null {
  return /^colo=([A-Z0-9]{3,8})$/mu.exec(trace)?.[1] ?? null;
}
