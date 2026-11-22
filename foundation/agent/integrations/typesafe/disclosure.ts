import {
  FlowLabel,
  emptyFlowLabel,
  joinFlowLabels,
} from "@purin-labs/authority/policy/information-flow/labels";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import { evaluateFlowLabelSink } from "@purin-labs/authority/policy/information-flow/sinks";
import type {
  FlowLabelDecision,
  TypeSafeInferenceSink,
} from "@purin-labs/authority/policy/information-flow/types";
import type { Result } from "@purin-labs/kernel/result";
import type { TypeSafeCredential } from "./credential";
import { sameTypeSafeAuthority } from "./authority";
import {
  postSystemOne,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
  type JevError,
} from "./system-one-client";
import { parseSystemOneJson } from "./response-json";
import { isRecord } from "@purin-labs/std";
export type TypeSafeDisclosureDenied = Readonly<{
  code: "typesafe_disclosure_denied";
  decision: Exclude<FlowLabelDecision, { kind: "allow" }>;
  decisionDigest: string;
}>;

/** Transient exact request, authorized before reservation and never persisted as content. */
export class TypeSafeDisclosure {
  readonly #body: string;
  private constructor(
    readonly sink: TypeSafeInferenceSink,
    readonly flowLabel: FlowLabel,
    readonly decisionDigest: string,
    readonly requestDigest: string,
    body: string,
  ) {
    this.#body = body;
    if (sink.processing.kind === "authorized_source")
      Object.freeze(sink.processing.authority);
    Object.freeze(sink.processing);
    Object.freeze(sink);
    Object.freeze(this);
  }

  static async authorize(
    input: Readonly<{
      sink: TypeSafeInferenceSink;
      labels: readonly FlowLabel[];
      body: string;
    }>,
  ): Promise<Result<TypeSafeDisclosure, TypeSafeDisclosureDenied | JevError>> {
    const sink = structuredClone(input.sink);
    const body = input.body;
    if (
      new TextEncoder().encode(body).byteLength > SYSTEM_ONE_MAX_REQUEST_BYTES
    )
      return { ok: false, error: { code: "jev_input_invalid" } };
    const labels = [...input.labels];
    try {
      const request = parseSystemOneJson(body);
      if (!isRecord(request) || request.model !== sink.model)
        return { ok: false, error: { code: "jev_input_invalid" } };
    } catch {
      return { ok: false, error: { code: "jev_input_invalid" } };
    }
    let label = await emptyFlowLabel();
    for (const source of labels) {
      const joined = await joinFlowLabels(label, source);
      if (!joined.ok) throw new Error(joined.error.code);
      label = joined.value;
    }
    const decision = evaluateFlowLabelSink({
      flowLabel: label,
      sink,
      organisationAuthz: null,
    });
    const requestDigest = await digestCanonical(body);
    const decisionDigest = await digestCanonical({
      sink,
      labelDigest: label.digest,
      requestDigest,
      decision,
    });
    if (decision.kind !== "allow")
      return {
        ok: false,
        error: { code: "typesafe_disclosure_denied", decision, decisionDigest },
      };
    return {
      ok: true,
      value: new TypeSafeDisclosure(
        sink,
        label,
        decisionDigest,
        requestDigest,
        body,
      ),
    };
  }

  async post(
    input: Readonly<{
      credential: TypeSafeCredential;
      timeoutMs: number;
      signal: AbortSignal;
      fetcher: typeof fetch;
    }>,
  ): Promise<Result<unknown, JevError>> {
    if (!sameTypeSafeAuthority(input.credential.authority, this.sink.funding))
      return { ok: false, error: { code: "jev_credential_unavailable" } };
    const credentialValue = input.credential.apiKey.trim();
    if (credentialValue.length > 0 && this.#body.includes(credentialValue))
      return { ok: false, error: { code: "jev_input_invalid" } };
    return postSystemOne({
      apiKey: input.credential.apiKey,
      body: this.#body,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      fetcher: input.fetcher,
    });
  }
}
