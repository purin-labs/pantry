/**
 * One start of voice control and the resources that it opened: the tab lock,
 * the transport, the microphone stream, the AudioContext, the worker and the
 * page listeners. A start waits on the person (the permission prompt) and on
 * the network, so voice can turn off while it waits.
 *
 * `open` hands each resource to the attempt as soon as it exists. After
 * `cancel`, the attempt holds nothing: it closed each resource that it had,
 * and it closes at once each resource that arrives later. The start then
 * stops at its next step.
 */
export class StartAttempt {
  #state: "open" | "cancelled" = "open";
  readonly #closers: (() => void)[] = [];

  get cancelled(): boolean {
    return this.#state === "cancelled";
  }

  /**
   * Gives a resource to this attempt. Returns false, and closes the resource,
   * when the attempt was cancelled before the resource arrived.
   */
  open(close: () => void): boolean {
    if (this.#state === "cancelled") {
      closeQuietly(close);
      return false;
    }
    this.#closers.push(close);
    return true;
  }

  /** Closes each resource, the last one first. A second call does nothing. */
  cancel(): void {
    if (this.#state === "cancelled") return;
    this.#state = "cancelled";
    for (const close of this.#closers.splice(0).reverse()) closeQuietly(close);
  }
}

function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // A resource that is already closed has nothing more to release.
  }
}
