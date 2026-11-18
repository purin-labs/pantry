import * as Y from "yjs";

export type TextSelectionDirection = "forward" | "backward" | "none";
export type TextSelectionRange = Readonly<{
  start: number;
  end: number;
  direction: TextSelectionDirection;
}>;
export type TextPresenceSelection = Readonly<{
  start: readonly number[];
  end: readonly number[];
  direction: TextSelectionDirection;
}>;

export class RelativeTextSelection {
  readonly #start: Y.RelativePosition;
  readonly #end: Y.RelativePosition;
  readonly direction: TextSelectionDirection;

  private constructor(
    text: Y.Text,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ) {
    this.#start = Y.createRelativePositionFromTypeIndex(text, clampIndex(text, start));
    this.#end = Y.createRelativePositionFromTypeIndex(text, clampIndex(text, end));
    this.direction = direction;
  }

  static capture(
    text: Y.Text,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): RelativeTextSelection {
    return new RelativeTextSelection(text, start, end, direction);
  }

  resolve(doc: Y.Doc): TextSelectionRange {
    const start = Y.createAbsolutePositionFromRelativePosition(this.#start, doc)?.index ?? 0;
    const end = Y.createAbsolutePositionFromRelativePosition(this.#end, doc)?.index ?? start;
    return { start, end: Math.max(start, end), direction: this.direction };
  }
}

export function captureTextPresenceSelection(
  text: Y.Text,
  start: number,
  end: number,
  direction: TextSelectionDirection,
): TextPresenceSelection {
  const startPosition = Y.createRelativePositionFromTypeIndex(text, clampIndex(text, start));
  const endPosition = Y.createRelativePositionFromTypeIndex(text, clampIndex(text, end));
  return {
    start: Array.from(Y.encodeRelativePosition(startPosition)),
    end: Array.from(Y.encodeRelativePosition(endPosition)),
    direction,
  };
}

export function resolveTextPresenceSelection(
  doc: Y.Doc,
  text: Y.Text,
  selection: TextPresenceSelection,
): TextSelectionRange | null {
  try {
    const start = resolvePosition(doc, selection.start);
    const end = resolvePosition(doc, selection.end);
    if (start === null || end === null || start.type !== text || end.type !== text) {
      return null;
    }
    return {
      start: Math.min(start.index, end.index),
      end: Math.max(start.index, end.index),
      direction: selection.direction,
    };
  } catch {
    return null;
  }
}

function resolvePosition(doc: Y.Doc, bytes: readonly number[]): Y.AbsolutePosition | null {
  return Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Uint8Array.from(bytes)),
    doc,
  );
}

function clampIndex(text: Y.Text, index: number): number {
  return Math.max(0, Math.min(index, text.length));
}
