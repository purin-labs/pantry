import type { Result } from "../result";

declare const sessionTurnInputDigestBrand: unique symbol;

export type SessionTurnInputDigest = string & {
  readonly [sessionTurnInputDigestBrand]: "SessionTurnInputDigest";
};

type SessionTurnInputDigestError = { code: "invalid_input_digest" };

const SESSION_TURN_INPUT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function parseSessionTurnInputDigest(
  value: unknown,
): Result<SessionTurnInputDigest, SessionTurnInputDigestError> {
  return typeof value === "string" &&
    SESSION_TURN_INPUT_DIGEST_PATTERN.test(value)
    ? { ok: true, value: value as SessionTurnInputDigest }
    : { ok: false, error: { code: "invalid_input_digest" } };
}
