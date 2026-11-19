import type { Result } from "../../result";
import { postSystemOne, type JevError } from "./system-one-client";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";

const PROBE_MODEL = "jev-1.13.0";
const PROBE_BODY = JSON.stringify({
  model: PROBE_MODEL,
  state:
    "This is a synthetic connection test. The sample parcel is in transit.",
  questions: {
    in_transit: {
      type: "noul",
      instructions:
        "Does the supplied text state that the sample parcel is in transit?",
    },
  },
});

/** Probes the provider contract using fixed public text, independently of feature policies. */
export async function probeTypeSafeConnection(input: {
  readonly apiKey: string;
  readonly signal: AbortSignal;
  readonly fetcher: typeof fetch;
}): Promise<Result<null, JevError>> {
  const result = await postSystemOne({
    apiKey: input.apiKey,
    body: PROBE_BODY,
    timeoutMs: 10_000,
    signal: input.signal,
    fetcher: input.fetcher,
  });
  if (!result.ok) return result;
  const raw = result.value;
  if (
    !isRecord(raw) ||
    raw.model !== PROBE_MODEL ||
    !isRecord(raw.answers) ||
    Object.keys(raw.answers).length !== 1 ||
    !isRecord(raw.answers.in_transit) ||
    raw.answers.in_transit.type !== "noul" ||
    typeof raw.answers.in_transit.noul !== "number" ||
    !Number.isFinite(raw.answers.in_transit.noul) ||
    raw.answers.in_transit.noul < 0 ||
    raw.answers.in_transit.noul > 1 ||
    !isRecord(raw.usage) ||
    !isNonNegativeInteger(raw.usage.input_tokens) ||
    !isNonNegativeInteger(raw.usage.output_tokens)
  ) {
    return { ok: false, error: { code: "jev_response_invalid" } };
  }
  return { ok: true, value: null };
}
