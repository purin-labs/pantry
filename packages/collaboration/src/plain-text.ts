import type { Text } from "yjs";

export type TextInputRange = Readonly<{ start: number; end: number }>;

export function normalizePlainText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function hasValidPlainTextShape(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
    !value.includes("\r");
}

export function splicePlainText(
  text: Text,
  before: string,
  after: string,
  inputRange: TextInputRange | undefined,
): void {
  if (inputRange !== undefined && matchesInputRange(before, after, inputRange)) {
    const inserted = after.slice(inputRange.start, after.length - (before.length - inputRange.end));
    if (inputRange.end > inputRange.start) {
      text.delete(inputRange.start, inputRange.end - inputRange.start);
    }
    if (inserted.length > 0) {
      text.insert(inputRange.start, inserted);
    }
    return;
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  if (splitsSurrogate(before, prefix) || splitsSurrogate(after, prefix)) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix++;
  }
  if (
    splitsSurrogate(before, before.length - suffix) ||
    splitsSurrogate(after, after.length - suffix)
  ) {
    suffix--;
  }
  const removed = before.length - prefix - suffix;
  const inserted = after.slice(prefix, after.length - suffix);
  if (removed > 0) {
    text.delete(prefix, removed);
  }
  if (inserted.length > 0) {
    text.insert(prefix, inserted);
  }
}

function matchesInputRange(before: string, after: string, range: TextInputRange): boolean {
  return Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= before.length &&
    !splitsSurrogate(before, range.start) &&
    !splitsSurrogate(before, range.end) &&
    after.length >= range.start + before.length - range.end &&
    after.startsWith(before.slice(0, range.start)) &&
    after.endsWith(before.slice(range.end));
}

function splitsSurrogate(value: string, index: number): boolean {
  const previous = value.charCodeAt(index - 1);
  const current = value.charCodeAt(index);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff;
}
