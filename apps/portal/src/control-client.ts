import { isRecord } from "@purin-labs/std";
import {
  controlApiProblemMessage,
  parseControlApiProblem,
  type ControlErrorKind,
} from "@purin-labs/control-api/portal/errors";

export type ControlMutationIntent =
  string | Readonly<{ kind: "prepared"; idempotencyKey: string }>;

export class ControlApiError extends Error {
  readonly kind: ControlErrorKind;
  readonly details: unknown;
  /** The HTTP status of the refused response, or null without one. */
  readonly status: number | null;

  constructor(
    message: string,
    kind: ControlErrorKind,
    details: unknown = null,
    status: number | null = null,
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
    this.status = status;
  }
}

/**
 * One read of a path. A read that is in flight serves every caller that asks
 * for its path before it ends. A read that the Portal started early, before
 * the page that needs it was on screen, also serves the callers that ask
 * after it ended: the first of them, and those that mount with it. Every
 * other caller reads again.
 */
type SharedRead = {
  readonly response: Promise<unknown>;
  readonly early: boolean;
  claimed: boolean;
  settled: boolean;
};

const sharedReads = new Map<string, SharedRead>();
/**
 * How long an early response waits for the page that needs it. It is also the
 * greatest age of a response that a page can take.
 */
const EARLY_READ_LIFETIME_MS = 10_000;
/** How long a taken early read serves the callers that mount with the first. */
const SHARED_MOUNT_MS = 2_000;

/** How long a response that the shell offers waits for a page to take it. */
const OFFERED_READ_LIFETIME_MS = 5_000;

/** The last response of each path, for a page to show while it reads again. */
const lastReads = new Map<string, unknown>();
const LAST_READ_LIMIT = 64;

export function controlRead(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  // A read that its caller can cancel is its own: a cancel stops no other caller.
  if (signal !== undefined) return readControlJson(path, signal);
  const shared = sharedReads.get(path);
  if (shared === undefined) return shareControlRead(path, false);
  if (shared.settled && !shared.claimed)
    setTimeout(dropSharedRead, SHARED_MOUNT_MS, path, shared);
  shared.claimed = true;
  return shared.response;
}

/**
 * Starts the read of a page that is not on screen yet. A read of the same
 * path that still waits for its page stands for it.
 */
export function startControlRead(path: string): void {
  if (!sharedReads.has(path)) shareControlRead(path, true).catch(ignore);
}

/**
 * The last response that `controlRead` returned for this path in this tab, or
 * undefined. A page shows it only while its own read of the path runs.
 */
export function lastControlRead(path: string): unknown {
  return lastReads.get(path);
}

const forgetters = new Set<() => void>();

/** Registers what a page keeps from its own reads, to forget with these. */
export function forgetWithControlReads(forget: () => void): void {
  forgetters.add(forget);
}

/** Forgets every response, when the signed-in person changes. */
export function forgetControlReads(): void {
  sharedReads.clear();
  lastReads.clear();
  earlySession = null;
  for (const forget of forgetters) forget();
}

function shareControlRead(path: string, early: boolean): Promise<unknown> {
  const read: SharedRead = {
    response: readControlJson(path),
    early,
    claimed: false,
    settled: false,
  };
  sharedReads.set(path, read);
  const settle = (): void => {
    read.settled = true;
    if (sharedReads.get(path) !== read) return;
    if (!read.early || read.claimed) sharedReads.delete(path);
    else setTimeout(dropSharedRead, EARLY_READ_LIFETIME_MS, path, read);
  };
  read.response.then(
    (value) => {
      // A read that was forgotten while in flight leaves nothing behind.
      if (sharedReads.get(path) === read) rememberLastRead(path, value);
      settle();
    },
    () => {
      lastReads.delete(path);
      settle();
    },
  );
  return read.response;
}

/**
 * Lets one more reader take a response that the shell read a moment ago, so a
 * page that mounts under the shell does not read the same record again.
 */
export function offerControlRead(path: string, value: unknown): void {
  const read: SharedRead = {
    response: Promise.resolve(value),
    early: true,
    claimed: false,
    settled: true,
  };
  sharedReads.set(path, read);
  setTimeout(dropSharedRead, OFFERED_READ_LIFETIME_MS, path, read);
}

function dropSharedRead(path: string, read: SharedRead): void {
  if (sharedReads.get(path) === read) sharedReads.delete(path);
}

function rememberLastRead(path: string, value: unknown): void {
  lastReads.delete(path);
  lastReads.set(path, value);
  const oldest = lastReads.keys().next();
  if (lastReads.size > LAST_READ_LIMIT && oldest.done !== true)
    lastReads.delete(oldest.value);
}

async function readControlJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return responseJson(
    await fetch(path, { headers: { accept: "application/json" }, signal }),
  );
}

function ignore(): void {}

let earlySession: Promise<Response> | null = null;

function fetchControlSession(): Promise<Response> {
  return fetch("/v1/control/session", {
    headers: { accept: "application/json" },
  });
}

/** Starts the session read while the Portal's code still loads. */
export function startControlSessionRead(): void {
  earlySession = fetchControlSession();
  earlySession.catch(ignore);
}

/** The session read, taken one time from the early start when there is one. */
export function readControlSession(): Promise<Response> {
  const early = earlySession;
  earlySession = null;
  return early ?? fetchControlSession();
}

/**
 * A response that Pantry refused with a JSON body: its status and the body, as
 * the route sent them. Null for any other failure: no connection, no session
 * cookie, or a body that is not JSON.
 */
export function controlRefusal(
  error: unknown,
): Readonly<{ status: number; body: unknown }> | null {
  return error instanceof ControlApiError &&
    error.status !== null &&
    error.details !== null
    ? { status: error.status, body: error.details }
    : null;
}

/** The outcome of a control request as a value, for a page that reads it itself. */
export type ControlAnswer = Readonly<{
  /** Pantry accepted the request. */
  ok: boolean;
  /** The status of a refused response; null when accepted or without an answer. */
  status: number | null;
  /** The JSON body that Pantry sent, or null without one. */
  body: unknown;
}>;

/**
 * Waits for a `controlRead` or a `controlMutation` and gives its outcome as a
 * value. A lost connection or a missing session cookie has no status and no body.
 */
export function controlAnswer(
  request: Promise<unknown>,
): Promise<ControlAnswer> {
  return request.then(
    (body) => ({ ok: true, status: null, body }),
    (error: unknown) =>
      error instanceof ControlApiError
        ? { ok: false, status: error.status, body: error.details }
        : { ok: false, status: null, body: null },
  );
}

/**
 * For a write whose page reads a refusal itself: the JSON body of a refused
 * response. Any other failure stays a failure.
 */
export function refusedBody(error: unknown): unknown {
  const refused = controlRefusal(error);
  if (refused === null) throw error;
  return refused.body;
}

export async function responseJson(response: Response): Promise<unknown> {
  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }
  if (!response.ok) {
    const problem = parseControlApiProblem(raw);
    throw new ControlApiError(
      controlApiProblemMessage(problem),
      problem.kind,
      raw,
      response.status,
    );
  }
  if (raw === null) {
    throw new ControlApiError(
      "The server returned an unexpected response.",
      "unknown",
    );
  }
  return raw;
}

/**
 * A read that the record answers with 304 while it has not changed since
 * `etag`. It is not shared with other reads, because its answer depends on
 * the caller's etag.
 */
export async function controlReadIfChanged(
  path: string,
  etag: string,
): Promise<
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "changed"; raw: unknown; etag: string | null }>
> {
  const response = await fetch(path, {
    headers: { accept: "application/json", "if-none-match": etag },
  });
  if (response.status === 304) return { kind: "unchanged" };
  const raw = await responseJson(response);
  return { kind: "changed", raw, etag: response.headers.get("etag") };
}

/**
 * A POST with a raw body, such as a recording. It carries the session's CSRF
 * token when there is one; the answer is JSON.
 */
export async function controlSend(
  path: string,
  body: Blob,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  return responseJson(
    await fetch(path, {
      method: "POST",
      headers: {
        ...headers,
        ...(csrf === null ? {} : { "x-pantry-csrf": csrf }),
      },
      body,
    }),
  );
}

/**
 * A stream of records, one JSON line each. The caller reads the body and
 * reads a refused response itself.
 */
export function controlStream(
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(path, { headers: { accept: "application/x-ndjson" }, signal });
}

/**
 * A POST that changes no record: a presence beat, a view event or a preview.
 * It carries the session's CSRF token when there is one, and no idempotency
 * key, and it leaves the early reads in place.
 */
export async function controlSignal(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  return responseJson(
    await fetch(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(csrf === null ? {} : { "x-pantry-csrf": csrf }),
      },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

type StoredMutationIntent = {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
};

export async function controlMutation(
  path: string,
  method: "DELETE" | "PATCH" | "POST" | "PUT",
  body: unknown,
  expectedConfigurationVersion?: number,
  mutationIntent?: ControlMutationIntent,
  signal?: AbortSignal,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) {
    throw new Error("Your control session expired. Sign in again.");
  }
  const fingerprint = JSON.stringify({
    path,
    method,
    body,
    expectedConfigurationVersion,
  });
  const intentKey =
    typeof mutationIntent === "object"
      ? null
      : (mutationIntent ?? `control:${fingerprint}`);
  const stored =
    intentKey === null
      ? undefined
      : readStoredMutationIntent(intentKey, fingerprint);
  const idempotencyKey =
    typeof mutationIntent === "object"
      ? mutationIntent.idempotencyKey
      : (stored?.idempotencyKey ?? `portal-${crypto.randomUUID()}`);
  if (intentKey !== null && stored === undefined)
    writeStoredMutationIntent(intentKey, { fingerprint, idempotencyKey });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pantry-csrf": csrf,
    "idempotency-key": idempotencyKey,
  };
  if (expectedConfigurationVersion !== undefined) {
    headers["x-pantry-configuration-version"] = String(
      expectedConfigurationVersion,
    );
  }
  const result = await writeThenForgetReads(() =>
    fetch(path, {
      method,
      headers,
      body: JSON.stringify(body),
      signal,
    }),
  );
  if (intentKey !== null) clearStoredMutationIntent(intentKey, idempotencyKey);
  return result;
}

/**
 * A shared read that began before a write or while it ran can hold the old
 * record. No caller after the write takes it: the write forgets every shared
 * read when it starts and again when it ends. Each caller that waits on a
 * forgotten read still gets its answer.
 */
async function writeThenForgetReads(
  write: () => Promise<Response>,
): Promise<unknown> {
  sharedReads.clear();
  try {
    return await responseJson(await write());
  } finally {
    sharedReads.clear();
  }
}

function readStoredMutationIntent(
  intentKey: string,
  fingerprint: string,
): StoredMutationIntent | undefined {
  try {
    const raw = sessionStorage.getItem(`pantry:mutation:${intentKey}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) &&
      parsed.fingerprint === fingerprint &&
      typeof parsed.idempotencyKey === "string"
      ? { fingerprint, idempotencyKey: parsed.idempotencyKey }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredMutationIntent(
  intentKey: string,
  intent: StoredMutationIntent,
): void {
  try {
    sessionStorage.setItem(
      `pantry:mutation:${intentKey}`,
      JSON.stringify(intent),
    );
  } catch {
    return;
  }
}

function clearStoredMutationIntent(
  intentKey: string,
  idempotencyKey: string,
): void {
  try {
    const stored = sessionStorage.getItem(`pantry:mutation:${intentKey}`);
    if (stored === null) return;
    const parsed: unknown = JSON.parse(stored);
    if (isRecord(parsed) && parsed.idempotencyKey === idempotencyKey) {
      sessionStorage.removeItem(`pantry:mutation:${intentKey}`);
    }
  } catch {
    return;
  }
}

export function readCookie(name: string): string | null {
  const browserDocument: unknown = Reflect.get(globalThis, "document");
  if (!isRecord(browserDocument) || typeof browserDocument.cookie !== "string")
    return null;
  for (const part of browserDocument.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

/**
 * Sends a form that carries a file. The browser writes the multipart
 * boundary, so the request names no content type of its own.
 */
export async function controlUpload(
  path: string,
  form: FormData,
  idempotencyKey: string,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) {
    throw new Error("Your control session expired. Sign in again.");
  }
  return writeThenForgetReads(() =>
    fetch(path, {
      method: "POST",
      headers: { "x-pantry-csrf": csrf, "idempotency-key": idempotencyKey },
      body: form,
    }),
  );
}

/**
 * A write whose route keeps no replay record. It sends a fresh idempotency key
 * each time and keeps no copy of the body in the tab, so a draft text or an
 * address stays only in the request.
 */
export function controlWrite(
  path: string,
  method: "DELETE" | "PATCH" | "POST" | "PUT",
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return controlMutation(
    path,
    method,
    body,
    undefined,
    { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
    signal,
  );
}

/**
 * Mutation transport for secret-carrying commands. Unlike controlMutation it
 * never fingerprints the request body into sessionStorage, so the supplied
 * secret exists only inside this request. Each submission gets a fresh
 * idempotency key; retries re-enter the secret, so replay pinning is not
 * needed here.
 */
export async function controlSecretMutation(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  expectedConfigurationVersion?: number,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) {
    throw new Error("Your control session expired. Sign in again.");
  }
  return responseJson(
    await fetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-pantry-csrf": csrf,
        "idempotency-key": `portal-${crypto.randomUUID()}`,
        ...(expectedConfigurationVersion === undefined
          ? {}
          : {
              "x-pantry-configuration-version": String(
                expectedConfigurationVersion,
              ),
            }),
      },
      body: JSON.stringify(body),
    }),
  );
}
