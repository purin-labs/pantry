/**
 * The timeout of one outbound request, which ends with the request.
 *
 * A pending timer keeps a Durable Object in memory. `AbortSignal.timeout(n)`
 * runs its timer for the full `n`, so an Actor that used it stays awake for
 * `n` after the request ended. Call `end()` once the response body is read.
 * Expiry aborts with the same `TimeoutError` as `AbortSignal.timeout`.
 */
export class RequestDeadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;

  constructor(timeoutMs: number, callerSignal?: AbortSignal) {
    this.#timer = setTimeout(expire, timeoutMs, this.#controller);
    this.signal =
      callerSignal === undefined
        ? this.#controller.signal
        : AbortSignal.any([callerSignal, this.#controller.signal]);
  }

  /** Whether the deadline itself, not the caller, aborted the request. */
  get expired(): boolean {
    return this.#controller.signal.aborted;
  }

  end(): void {
    clearTimeout(this.#timer);
  }
}

function expire(controller: AbortController): void {
  controller.abort(new DOMException("The request timed out", "TimeoutError"));
}
