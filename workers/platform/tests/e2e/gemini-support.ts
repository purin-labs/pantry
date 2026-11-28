import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";

import { MODEL_EXIT_EGRESS_HEADER } from "./model-exit-network";
import { network } from "./network";

export type GeminiRequest = Readonly<{
  model: string;
  body: Record<string, unknown>;
}>;

/** The parts of the model's answer to one request. */
export type GeminiAnswer = (request: GeminiRequest) => readonly unknown[];

/**
 * A fake Gemini API for the organisation's own key. It records each request
 * and answers with the next prepared answer. Like the Gemini API, it refuses
 * a key that it did not issue, and it refuses each request that did not leave
 * through the model exit Worker: the Gemini API refuses Hong Kong.
 */
export class FakeGemini {
  readonly requests: GeminiRequest[] = [];
  readonly answers: GeminiAnswer[] = [];
  /** The key of each recorded request, in the same order. */
  readonly requestKeys: string[] = [];
  readonly #issued = new Set<string>();

  constructor(apiKey: string) {
    this.#issued.add(apiKey);
  }

  /** Google issues one more key to the organisation. */
  issue(apiKey: string): void {
    this.#issued.add(apiKey);
  }

  install(): void {
    network.use(
      http.post(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+$/,
        this.respond.bind(this),
      ),
    );
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (!request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return geminiError(
        400,
        "FAILED_PRECONDITION",
        "User location is not supported for the API use.",
      );
    const apiKey = request.headers.get("x-goog-api-key") ?? "";
    if (!this.#issued.has(apiKey))
      return geminiError(400, "INVALID_ARGUMENT", "API key not valid.");
    const action = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const [model, method] = action.split(":");
    if (method !== "streamGenerateContent" || model === undefined)
      throw new Error(`Unexpected Gemini call ${action}`);
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Gemini request body is invalid");
    const recorded = { model, body };
    this.requests.push(recorded);
    this.requestKeys.push(apiKey);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("No Gemini answer is prepared");
    const chunk = {
      candidates: [
        {
          content: { role: "model", parts: answer(recorded) },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 40,
        candidatesTokenCount: 6,
        totalTokenCount: 46,
      },
      modelVersion: model,
    };
    return new HttpResponse(`data: ${JSON.stringify(chunk)}\r\n\r\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
}

function geminiError(
  status: number,
  reason: string,
  message: string,
): Response {
  return HttpResponse.json(
    { error: { code: status, message, status: reason } },
    { status },
  );
}
