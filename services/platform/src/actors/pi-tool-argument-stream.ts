import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { StreamingJsonParser } from "@earendil-works/pi-ai/utils/streaming-json";
import type { HarnessToolArgumentObserver } from "./embedded-harness";

type StreamingCall = {
  readonly parser: StreamingJsonParser;
  readonly value: Record<string, unknown>;
};

/**
 * Reads the arguments of each tool call in one model stream as the model
 * writes them, for a `HarnessToolArgumentObserver` (Plan 40B phase 7). The
 * parser reports a number only when it ends, so a rect never shows a part
 * of a number. Only the top-level fields are read: the board edits that the
 * canvas draws have no nested ones.
 */
export class PiToolArgumentStream {
  readonly #observer: HarnessToolArgumentObserver;
  readonly #calls = new Map<number, StreamingCall>();

  constructor(observer: HarnessToolArgumentObserver) {
    this.#observer = observer;
  }

  accept(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "toolcall_delta": {
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "toolCall") return;
        let call = this.#calls.get(event.contentIndex);
        if (call === undefined) {
          call = { parser: new StreamingJsonParser(), value: {} };
          this.#calls.set(event.contentIndex, call);
        }
        let changed = false;
        for (const change of call.parser.append(event.delta)) {
          const key = change.path[0];
          if (change.path.length !== 1 || typeof key !== "string") continue;
          const before = call.value[key];
          call.value[key] =
            change.kind === "set"
              ? change.value
              : `${typeof before === "string" ? before : ""}${change.text}`;
          changed = true;
        }
        if (changed && block.id !== "" && block.name !== "")
          this.#observer.observe({
            callId: block.id,
            name: block.name,
            arguments: { ...call.value },
            complete: false,
          });
        return;
      }
      case "toolcall_end":
        this.#calls.delete(event.contentIndex);
        this.#observer.observe({
          callId: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
          complete: true,
        });
        return;
      case "error":
        this.#calls.clear();
        this.#observer.abandon();
        return;
      default:
        return;
    }
  }
}
