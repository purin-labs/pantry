import type {
  CodemodeError,
  CodemodeRemote,
  CodemodeRemoteExchange,
  CodemodeRemoteMessage,
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
  HostToWorkerMessage,
  WorkerToHostMessage,
} from "@earendil-works/pi-codemode/portable";

export type CodeModeExchangeDenial = {
  readonly code:
    | "code_mode_lease_stale"
    | "code_mode_deadline_expired"
    | "code_mode_access_denied"
    | "code_mode_catalog_changed"
    | "code_mode_protocol_invalid"
    | "code_mode_discovery_limit"
    | "code_mode_journal_limit"
    | "code_mode_argument_limit"
    | "code_mode_admission_frozen";
  readonly reason: string;
};

export type CodeModeRemoteCall = Extract<WorkerToHostMessage, { type: "call" }>;
export type CodeModeRemoteResult = Extract<
  HostToWorkerMessage,
  { type: "result" }
>;

/**
 * How the VM of one attempt ended, as the sandbox reported it. Pi turns every
 * ending but a clean one into the same error text, so the session Actor
 * classifies the outcome from this value and from the recorded denial.
 */
export type CodeModeRemoteTerminal =
  /** The script returned, or threw. */
  | { readonly kind: "done"; readonly ok: boolean }
  /** The VM failed outside the script, for example a wasm trap. */
  | { readonly kind: "crash" }
  /** The sandbox ended the VM: its interrupt budget, its memory, or a fault. */
  | { readonly kind: "failure"; readonly error: CodemodeError["kind"] }
  /** The call to the sandbox Worker failed. */
  | { readonly kind: "transport" };

/**
 * The live authority that decides what crosses between the session Actor and
 * the VM of one Code Mode attempt. Each check reads current state: a recorded
 * result is never current authorization. `null` admits; a denial stops the VM.
 */
export type CodeModeExchangeGate = {
  /** Before the VM starts: lease, deadline, catalog, and the initial store. */
  admitStart(
    request: CodemodeRemoteRequest,
  ): Promise<CodeModeExchangeDenial | null>;
  /** Before a call of the script reaches Pi, recorded or new. */
  admitCall(call: CodeModeRemoteCall): Promise<CodeModeExchangeDenial | null>;
  /** Before a result reaches the VM, recorded or new, including an error. */
  admitResult(
    call: CodeModeRemoteCall,
    result: CodeModeRemoteResult,
  ): Promise<CodeModeExchangeDenial | null>;
  /** The first denial of the attempt, recorded once. */
  denied(denial: CodeModeExchangeDenial): void;
  /** How the VM ended, recorded once when the sandbox reports it. */
  ended(terminal: CodeModeRemoteTerminal): void;
};

export type CodeModeExchangeLimits = {
  /** Distinct calls of host globals, such as tool discovery. */
  readonly maxGlobalCalls: number;
  /** UTF-8 bytes of the JSON arguments of one call. */
  readonly maxArgumentBytes: number;
  /**
   * Calls that may reach Pi. Pi's journal gains one entry for each result that
   * it delivers, so this is the bound on journal entries.
   */
  readonly maxJournalEntries: number;
  /**
   * Bytes that the journal may hold. A tool result is stored with its nested
   * call, and the journal holds only its position. The arguments and the
   * outcome of a global are stored in the journal itself.
   */
  readonly maxJournalBytes: number;
};

export const CODE_MODE_EXCHANGE_LIMITS: CodeModeExchangeLimits = {
  maxGlobalCalls: 32,
  maxArgumentBytes: 64 * 1024,
  maxJournalEntries: 40,
  maxJournalBytes: 1024 * 1024,
};

/** An upper estimate of one journal entry without a global's content. */
const JOURNAL_ENTRY_BYTES = 96;

export type GovernedCodeModeRemoteInput = {
  readonly remote: () => CodemodeRemote;
  readonly gate: CodeModeExchangeGate;
  readonly limits?: CodeModeExchangeLimits;
  /** Absolute deadline of the logical execution, in milliseconds. */
  readonly deadlineAt: number;
  readonly now: () => number;
};

type Attempt = {
  readonly input: GovernedCodeModeRemoteInput;
  readonly limits: CodeModeExchangeLimits;
  readonly exchange: CodemodeRemoteExchange;
  readonly globalCalls: Set<number>;
  readonly calls: Set<number>;
  journalBytes: number;
  readonly expired: Promise<"expired">;
  stopped: boolean;
};

const STOP: CodemodeRemoteReply = { type: "stop" };

/**
 * Places the gate between Pi's host and the sandbox Worker. Pi keeps the
 * journal, the replay, and the tool scheduling. This adapter owns none of them:
 * it forwards every message unchanged, and answers `stop` in place of a message
 * that the gate, a limit, or the deadline does not admit. It never substitutes
 * a value, so a script cannot continue with an altered meaning.
 */
export function governCodeModeRemote(
  input: GovernedCodeModeRemoteInput,
): () => CodemodeRemote {
  return governedRemote.bind(null, input);
}

function governedRemote(input: GovernedCodeModeRemoteInput): CodemodeRemote {
  return { execute: executeGoverned.bind(null, input) };
}

async function executeGoverned(
  input: GovernedCodeModeRemoteInput,
  request: CodemodeRemoteRequest,
  exchange: CodemodeRemoteExchange,
): Promise<void> {
  const remaining = input.deadlineAt - input.now();
  const startDenial =
    remaining <= 0 ? deadlineDenial() : await input.gate.admitStart(request);
  if (startDenial !== null) {
    input.gate.denied(startDenial);
    throw new Error(startDenial.code);
  }
  const timer = Promise.withResolvers<"expired">();
  const timeout = setTimeout(timer.resolve, remaining, "expired");
  const attempt: Attempt = {
    input,
    limits: input.limits ?? CODE_MODE_EXCHANGE_LIMITS,
    exchange,
    globalCalls: new Set(),
    calls: new Set(),
    journalBytes: 0,
    expired: timer.promise,
    stopped: false,
  };
  try {
    await input.remote().execute(request, governExchange.bind(null, attempt));
  } catch (error) {
    if (!attempt.stopped) input.gate.ended({ kind: "transport" });
    throw error;
  } finally {
    clearTimeout(timeout);
    attempt.stopped = true;
  }
}

async function governExchange(
  attempt: Attempt,
  messages: CodemodeRemoteMessage[],
): Promise<CodemodeRemoteReply> {
  if (attempt.stopped) return STOP;
  if (!Array.isArray(messages))
    return stop(attempt, {
      code: "code_mode_protocol_invalid",
      reason: "The sandbox sent a message batch that is not an array",
    });
  observeTerminal(attempt, messages);
  const calls = messages.filter(isCall);
  if (calls.length > 1)
    return stop(attempt, {
      code: "code_mode_protocol_invalid",
      reason: "The sandbox sent more than one call in an exchange",
    });
  const call = calls[0];
  if (call === undefined) return attempt.exchange(messages);
  const callDenial =
    boundCall(attempt, call) ??
    deadline(attempt) ??
    (await attempt.input.gate.admitCall(call));
  if (callDenial !== null) return stop(attempt, callDenial);
  if (attempt.stopped) return STOP;
  const reply = await Promise.race([
    attempt.exchange(messages),
    attempt.expired,
  ]);
  if (attempt.stopped) return STOP;
  if (reply === "expired") return stop(attempt, deadlineDenial());
  if (reply === null || reply.type === "stop") return reply;
  if (reply.type !== "result" || reply.id !== call.id)
    return stop(attempt, {
      code: "code_mode_protocol_invalid",
      reason: "The host answered a call with a result for another call",
    });
  const resultDenial =
    boundResult(attempt, call, reply) ??
    deadline(attempt) ??
    (await attempt.input.gate.admitResult(call, reply));
  if (resultDenial !== null) return stop(attempt, resultDenial);
  if (attempt.stopped) return STOP;
  return reply;
}

function boundCall(
  attempt: Attempt,
  call: CodeModeRemoteCall,
): CodeModeExchangeDenial | null {
  if (
    !Number.isSafeInteger(call.id) ||
    typeof call.name !== "string" ||
    (call.target !== "tool" && call.target !== "global") ||
    (call.args !== undefined && typeof call.args !== "string")
  )
    return {
      code: "code_mode_protocol_invalid",
      reason: "The sandbox sent a call with an invalid shape",
    };
  const argumentBytes = utf8Bytes(call.args);
  if (argumentBytes > attempt.limits.maxArgumentBytes)
    return {
      code: "code_mode_argument_limit",
      reason: `The arguments of ${call.name} exceed their limit`,
    };
  if (call.target === "global") {
    attempt.globalCalls.add(call.id);
    if (attempt.globalCalls.size > attempt.limits.maxGlobalCalls)
      return {
        code: "code_mode_discovery_limit",
        reason: "The script exceeded its allowance of discovery calls",
      };
  }
  // A replay issues the recorded calls again under the same call IDs, so a
  // later attempt counts the journal that it finds without reading it.
  if (!attempt.calls.has(call.id)) {
    attempt.calls.add(call.id);
    attempt.journalBytes +=
      JOURNAL_ENTRY_BYTES + (call.target === "global" ? argumentBytes : 0);
  }
  if (attempt.calls.size > attempt.limits.maxJournalEntries)
    return journalDenial("entries");
  if (attempt.journalBytes > attempt.limits.maxJournalBytes)
    return journalDenial("bytes");
  return null;
}

/**
 * Pi has recorded the outcome of a global before it answers the exchange, so
 * this check stops the script after the entry that crossed the limit. The
 * journal can exceed its byte limit by one outcome, and by no more.
 */
function boundResult(
  attempt: Attempt,
  call: CodeModeRemoteCall,
  result: CodeModeRemoteResult,
): CodeModeExchangeDenial | null {
  if (call.target !== "global") return null;
  attempt.journalBytes +=
    utf8Bytes(result.payload) + utf8Bytes(result.properties);
  return attempt.journalBytes > attempt.limits.maxJournalBytes
    ? journalDenial("bytes")
    : null;
}

function journalDenial(limit: "entries" | "bytes"): CodeModeExchangeDenial {
  return {
    code: "code_mode_journal_limit",
    reason: `The script exceeded the journal limit of its execution (${limit})`,
  };
}

function utf8Bytes(text: string | undefined): number {
  return text === undefined ? 0 : new TextEncoder().encode(text).byteLength;
}

function deadline(attempt: Attempt): CodeModeExchangeDenial | null {
  return attempt.input.now() >= attempt.input.deadlineAt
    ? deadlineDenial()
    : null;
}

function deadlineDenial(): CodeModeExchangeDenial {
  return {
    code: "code_mode_deadline_expired",
    reason: "The admitted deadline of the execution passed",
  };
}

function stop(
  attempt: Attempt,
  denial: CodeModeExchangeDenial,
): CodemodeRemoteReply {
  if (!attempt.stopped) {
    attempt.stopped = true;
    attempt.input.gate.denied(denial);
  }
  return STOP;
}

function observeTerminal(
  attempt: Attempt,
  messages: readonly CodemodeRemoteMessage[],
): void {
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    switch (message.type) {
      case "done":
        attempt.input.gate.ended({ kind: "done", ok: message.ok });
        break;
      case "crash":
        attempt.input.gate.ended({ kind: "crash" });
        break;
      case "failure":
        attempt.input.gate.ended({
          kind: "failure",
          error: message.error.kind,
        });
        break;
      case "call":
      case "output":
      case "started":
      case "idle":
        break;
      default:
        message satisfies never;
    }
  }
}

function isCall(message: CodemodeRemoteMessage): message is CodeModeRemoteCall {
  return (
    typeof message === "object" && message !== null && message.type === "call"
  );
}
