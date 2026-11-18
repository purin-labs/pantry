import type { ConversationId } from "@seams/control-api";
import { readChatStatus } from "./api";
import type { ChatWork } from "@seams/control-api/portal/chat";
import { readChatStream, type ChatStreamRecord } from "./stream";

export type ChatStreamState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "active" | "reconnecting";
      readonly requestId: string;
      readonly afterSequence: number;
      readonly text: string;
      readonly progress: string | null;
    }
  | {
      readonly kind: "failed";
      readonly requestId: string;
      readonly message: string;
    }
  | { readonly kind: "paused"; readonly requestId: string };

export type DeliveryIdentity = {
  readonly organisationId: string;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly generation: number;
};

type PendingWork = Exclude<
  ChatWork,
  { kind: "ready" | "failed" | "awaiting_permission" }
>;
type DeliveryObserver = {
  readonly changed: (
    identity: DeliveryIdentity,
    state: ChatStreamState,
  ) => void;
  readonly refresh: (identity: DeliveryIdentity) => Promise<void>;
  /** While the page's signal socket is live, a signal replaces the status poll. */
  readonly signalsLive: () => boolean;
};

export class ChatDelivery {
  readonly #lifetime = new AbortController();
  #reader: { kind: "idle" } | { kind: "reading"; abort: AbortController } = {
    kind: "idle",
  };
  #timer: number | null = null;
  #state: ChatStreamState = { kind: "idle" };
  #revision: number;

  constructor(
    readonly identity: DeliveryIdentity,
    revision: number,
    private readonly observer: DeliveryObserver,
  ) {
    this.#revision = revision;
  }

  matches(identity: DeliveryIdentity): boolean {
    return (
      !this.#lifetime.signal.aborted &&
      this.identity.organisationId === identity.organisationId &&
      this.identity.conversationId === identity.conversationId &&
      this.identity.requestId === identity.requestId &&
      this.identity.generation === identity.generation
    );
  }

  observe(revision: number, work: PendingWork): void {
    if (this.#lifetime.signal.aborted) return;
    this.#revision = revision;
    this.scheduleObservation();
    if (work.expiresAt <= Date.now()) {
      if (this.#reader.kind === "reading") this.#reader.abort.abort();
      return;
    }
    if (this.#reader.kind === "reading" || this.#state.kind === "failed")
      return;
    if (
      this.#state.kind === "idle" ||
      this.#state.kind === "paused" ||
      this.#state.kind === "reconnecting"
    )
      void this.follow();
  }

  dispose(): void {
    this.#lifetime.abort();
    if (this.#reader.kind === "reading") this.#reader.abort.abort();
    this.#reader = { kind: "idle" };
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  private publish(state: ChatStreamState): void {
    if (this.#lifetime.signal.aborted) return;
    this.#state = state;
    this.observer.changed(this.identity, state);
  }

  private accept(record: ChatStreamRecord): void {
    const current = this.#state;
    if (current.kind !== "active" && current.kind !== "reconnecting") return;
    if (record.sequence <= current.afterSequence) return;
    const requestId = this.identity.requestId;
    switch (record.kind) {
      case "failed":
        this.publish({ kind: "failed", requestId, message: record.message });
        return;
      case "paused":
        this.publish({ kind: "paused", requestId });
        return;
      case "assistant_text_delta":
        this.publish({
          kind: "active",
          requestId,
          afterSequence: record.sequence,
          text: current.text + record.text,
          progress: null,
        });
        return;
      case "run_state":
      case "progress":
      case "usage":
      case "complete":
        this.publish({
          kind: "active",
          requestId,
          afterSequence: record.sequence,
          text: current.text,
          progress:
            record.kind === "progress" ? record.label : current.progress,
        });
        return;
    }
  }

  private async follow(): Promise<void> {
    const abort = new AbortController();
    this.#reader = { kind: "reading", abort };
    const previous = this.#state;
    this.publish({
      kind: "active",
      requestId: this.identity.requestId,
      afterSequence:
        previous.kind === "reconnecting" ? previous.afterSequence : -1,
      text: previous.kind === "reconnecting" ? previous.text : "",
      progress: previous.kind === "reconnecting" ? previous.progress : null,
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = this.#state;
        if (
          abort.signal.aborted ||
          (current.kind !== "active" && current.kind !== "reconnecting")
        )
          return;
        try {
          await readChatStream({
            ...this.identity,
            afterSequence: current.afterSequence,
            signal: abort.signal,
            accept: this.accept.bind(this),
          });
          if (!abort.signal.aborted) await this.observer.refresh(this.identity);
          return;
        } catch {
          if (abort.signal.aborted || this.#lifetime.signal.aborted) return;
          if (
            this.#state.kind === "active" ||
            this.#state.kind === "reconnecting"
          ) {
            this.publish({
              kind: "reconnecting",
              requestId: this.identity.requestId,
              afterSequence: this.#state.afterSequence,
              text: this.#state.text,
              progress: this.#state.progress,
            });
          }
          if (attempt === 2) await this.observer.refresh(this.identity);
        }
      }
    } finally {
      if (this.#reader.kind === "reading" && this.#reader.abort === abort)
        this.#reader = { kind: "idle" };
    }
  }

  private scheduleObservation(): void {
    if (this.#timer === null && !this.#lifetime.signal.aborted)
      this.#timer = window.setTimeout(this.observeStatus.bind(this), 5000);
  }

  private async observeStatus(): Promise<void> {
    this.#timer = null;
    if (this.observer.signalsLive()) {
      this.scheduleObservation();
      return;
    }
    try {
      const status = await readChatStatus(
        this.identity.organisationId,
        this.identity.conversationId,
        this.#lifetime.signal,
      );
      if (this.#lifetime.signal.aborted) return;
      if (
        status.revision !== this.#revision ||
        status.work.kind === "ready" ||
        status.work.kind === "failed" ||
        status.work.kind === "awaiting_permission"
      )
        await this.observer.refresh(this.identity);
      else this.observe(status.revision, status.work);
    } catch {
      // An observation outage does not establish the durable turn's outcome.
    } finally {
      this.scheduleObservation();
    }
  }
}
