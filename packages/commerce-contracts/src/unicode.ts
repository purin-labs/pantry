import {
  CASE_FOLDS,
  COMBINING_CLASSES,
  COMPOSITIONS,
  DECOMPOSITIONS,
  DEFAULT_IGNORABLE_RANGES,
} from "./unicode-tables.ts";

export { COMMERCE_UNICODE_VERSION } from "./unicode-tables.ts";

const HANGUL_START = 0xac00;
const LEADING_START = 0x1100;
const VOWEL_START = 0x1161;
const TRAILING_START = 0x11a7;
const VOWEL_COUNT = 21;
const TRAILING_COUNT = 28;
const HANGUL_BLOCK = VOWEL_COUNT * TRAILING_COUNT;
const HANGUL_COUNT = 19 * HANGUL_BLOCK;

/** Commerce Unicode v1: NFKC, full default case fold, remove ignorables, NFKC. */
export function normalizeCommerceUnicodeV1(value: string): string {
  const normalized = normalizeCommerceNfkc(value);
  const folded: number[] = [];
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    for (const part of CASE_FOLDS[codePoint] ?? [codePoint]) {
      if (!isDefaultIgnorable(part)) folded.push(part);
    }
  }
  return normalizeCommerceNfkc(fromCodePoints(folded));
}

/** Unicode 17.0.0 NFKC without host ICU tables. */
export function normalizeCommerceNfkc(value: string): string {
  const decomposed: number[] = [];
  for (const character of value)
    decompose(character.codePointAt(0)!, decomposed);
  reorder(decomposed);
  return fromCodePoints(compose(decomposed));
}

function decompose(codePoint: number, output: number[]): void {
  const syllable = codePoint - HANGUL_START;
  if (syllable >= 0 && syllable < HANGUL_COUNT) {
    output.push(LEADING_START + Math.floor(syllable / HANGUL_BLOCK));
    output.push(
      VOWEL_START + Math.floor((syllable % HANGUL_BLOCK) / TRAILING_COUNT),
    );
    const trailing = syllable % TRAILING_COUNT;
    if (trailing !== 0) output.push(TRAILING_START + trailing);
    return;
  }
  const parts = DECOMPOSITIONS[codePoint];
  if (parts === undefined) {
    output.push(codePoint);
    return;
  }
  for (const part of parts) decompose(part, output);
}

function reorder(codePoints: number[]): void {
  for (let index = 1; index < codePoints.length; index++) {
    const codePoint = codePoints[index]!;
    const currentClass = COMBINING_CLASSES[codePoint] ?? 0;
    if (currentClass === 0) continue;
    let position = index;
    while (
      position > 0 &&
      (COMBINING_CLASSES[codePoints[position - 1]!] ?? 0) > currentClass
    ) {
      codePoints[position] = codePoints[position - 1]!;
      position--;
    }
    codePoints[position] = codePoint;
  }
}

function compose(codePoints: readonly number[]): number[] {
  const output: number[] = [];
  let starterIndex = 0;
  let starter = -1;
  let previousClass = 0;
  for (const codePoint of codePoints) {
    const currentClass = COMBINING_CLASSES[codePoint] ?? 0;
    const composite = composePair(starter, codePoint);
    if (
      composite !== undefined &&
      (previousClass === 0 || previousClass < currentClass)
    ) {
      output[starterIndex] = composite;
      starter = composite;
      continue;
    }
    if (currentClass === 0) {
      starterIndex = output.length;
      starter = codePoint;
    }
    output.push(codePoint);
    previousClass = currentClass;
  }
  return output;
}

function composePair(first: number, second: number): number | undefined {
  const leading = first - LEADING_START;
  const vowel = second - VOWEL_START;
  if (leading >= 0 && leading < 19 && vowel >= 0 && vowel < VOWEL_COUNT) {
    return HANGUL_START + (leading * VOWEL_COUNT + vowel) * TRAILING_COUNT;
  }
  const syllable = first - HANGUL_START;
  const trailing = second - TRAILING_START;
  if (
    syllable >= 0 &&
    syllable < HANGUL_COUNT &&
    syllable % TRAILING_COUNT === 0 &&
    trailing > 0 &&
    trailing < TRAILING_COUNT
  ) {
    return first + trailing;
  }
  return COMPOSITIONS[`${first},${second}`];
}

function isDefaultIgnorable(codePoint: number): boolean {
  for (const [first, last] of DEFAULT_IGNORABLE_RANGES) {
    if (codePoint < first) return false;
    if (codePoint <= last) return true;
  }
  return false;
}

function fromCodePoints(codePoints: readonly number[]): string {
  let text = "";
  for (const codePoint of codePoints) text += String.fromCodePoint(codePoint);
  return text;
}
