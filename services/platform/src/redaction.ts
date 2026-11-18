import type { ChannelId } from "./ids";

export type SensitiveEntityKind = "email" | "payment_card" | "credential";

export type SensitiveEntity = {
  kind: SensitiveEntityKind;
  value: string;
  start: number;
  end: number;
};

export type OutputScreenDecision =
  | { action: "allow" }
  | { action: "hold"; entities: readonly SensitiveEntity[] };

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const CREDENTIAL_PATTERN =
  /\b(?:xox[abprs]-[A-Za-z0-9-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{20,}|apikey_[a-f0-9]{32}_[a-f0-9]{64}|Bearer\s+[A-Za-z0-9._-]{20,})\b/gu;
const PAYMENT_CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/gu;
const INTERNAL_MODEL_PROTOCOL_MARKERS = [
  "<|open|>",
  "<|sep|>",
  "<|close|>",
] as const;

export function detectSensitiveEntities(
  text: string,
): readonly SensitiveEntity[] {
  const detected: SensitiveEntity[] = [];

  collectPatternEntities(detected, text, EMAIL_PATTERN, "email");
  collectPatternEntities(detected, text, CREDENTIAL_PATTERN, "credential");
  collectPaymentCardEntities(detected, text);

  return removeOverlappingEntities(detected);
}

export function screenTextForSurface(input: {
  text: string;
  channelId: ChannelId;
}): OutputScreenDecision {
  if (containsInternalModelProtocol(input.text)) {
    return { action: "hold", entities: [] };
  }
  const entities = detectSensitiveEntities(input.text);

  if (entities.length === 0 || isSlackDirectMessage(input.channelId)) {
    return { action: "allow" };
  }

  return { action: "hold", entities };
}

export function containsInternalModelProtocol(text: string): boolean {
  return INTERNAL_MODEL_PROTOCOL_MARKERS.some((marker) =>
    text.includes(marker),
  );
}

/** Where a marker of the internal model protocol may start at the text's end. */
export function trailingInternalModelProtocolStart(text: string): number {
  let candidateStart = text.length;

  for (const marker of INTERNAL_MODEL_PROTOCOL_MARKERS) {
    for (let length = 1; length < marker.length; length += 1) {
      if (text.endsWith(marker.slice(0, length))) {
        candidateStart = Math.min(candidateStart, text.length - length);
      }
    }
  }

  return candidateStart;
}

function collectPatternEntities(
  output: SensitiveEntity[],
  text: string,
  pattern: RegExp,
  kind: SensitiveEntityKind,
): void {
  pattern.lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const index = match.index;

    if (index === undefined || value.length === 0) {
      continue;
    }

    output.push({ kind, value, start: index, end: index + value.length });
  }
}

function collectPaymentCardEntities(
  output: SensitiveEntity[],
  text: string,
): void {
  PAYMENT_CARD_CANDIDATE_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(PAYMENT_CARD_CANDIDATE_PATTERN)) {
    const value = match[0];
    const index = match.index;

    if (index === undefined) {
      continue;
    }

    const digits = value.replace(/\D/gu, "");

    if (!isLikelyPaymentCard(digits)) {
      continue;
    }

    output.push({
      kind: "payment_card",
      value,
      start: index,
      end: index + value.length,
    });
  }
}

function removeOverlappingEntities(
  entities: readonly SensitiveEntity[],
): readonly SensitiveEntity[] {
  const sorted = [...entities].sort(compareEntityPosition);
  const selected: SensitiveEntity[] = [];

  for (const entity of sorted) {
    const previous = selected[selected.length - 1];

    if (previous !== undefined && entity.start < previous.end) {
      continue;
    }

    selected.push(entity);
  }

  return selected;
}

function compareEntityPosition(
  left: SensitiveEntity,
  right: SensitiveEntity,
): number {
  if (left.start !== right.start) {
    return left.start - right.start;
  }

  return right.end - left.end;
}

/** A direct message with one person; sensitive values may reach its owner. */
export function isSlackDirectMessage(channelId: ChannelId): boolean {
  return channelId.startsWith("D");
}

function isLikelyPaymentCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  return luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number.parseInt(digits[index] ?? "", 10);

    if (!Number.isInteger(digit)) {
      return false;
    }

    if (doubleDigit) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }

    doubleDigit = !doubleDigit;
  }

  return sum % 10 === 0;
}
