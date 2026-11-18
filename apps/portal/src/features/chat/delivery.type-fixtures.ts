import type { ChatStreamState } from "./delivery";

// @ts-expect-error Active streams must explicitly carry a progress label or null.
export const missingProgress: ChatStreamState = {
  kind: "active",
  requestId: "request",
  afterSequence: 0,
  text: "",
};
const retainedText = { text: "response", progress: "Read orders" };
// @ts-expect-error Failed stream state must carry the failure, not active-stream fields.
export const missingFailure: ChatStreamState = {
  ...retainedText,
  kind: "failed",
  requestId: "request",
};
