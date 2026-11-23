import { decisionCardBlocks } from "./decision-card";

/**
 * The blocks of a notice card: its fixed text, and a button to the Portal
 * while the card waits and the Portal address is known. The text never holds
 * the link.
 */
export function noticeCardBlocks(
  text: string,
  button: Readonly<{ actionId: string; label: string; url: string }> | null,
): readonly Record<string, unknown>[] {
  return decisionCardBlocks(
    text,
    button === null ? [] : [{ kind: "link", primary: true, ...button }],
  );
}
