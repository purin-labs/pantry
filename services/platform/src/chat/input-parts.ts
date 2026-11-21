import type { ChatInputMode, SurfaceObservationV2 } from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import { surfaceStateOf, type ChatSurfaceState } from "./surface-registry";
import type {
  ChatAttachmentPart,
  ChatInputPart,
  PendingChatInput,
} from "./timeline";

/**
 * The content of one user message, from a command or a stored message. The
 * Kitchen view travels inside `surfaceObservation` (Plan 87 phase 2).
 */
type ChatInputContent = Readonly<{
  text: string;
  browserContext: BakeryBrowserContext;
  attachments: readonly ChatAttachmentPart[];
  inputMode?: ChatInputMode;
  surfaceObservation?: SurfaceObservationV2;
}>;

export function chatInputParts(
  content: ChatInputContent,
): readonly ChatInputPart[] {
  const parts: ChatInputPart[] = [{ kind: "text", text: content.text }];
  if (content.inputMode !== undefined) parts.push({ ...content.inputMode });
  if (content.surfaceObservation !== undefined)
    parts.push({
      kind: "surface_observation",
      observation: content.surfaceObservation,
    });
  parts.push({ kind: "browser", context: content.browserContext });
  parts.push(...content.attachments);
  return parts;
}

/** The page state of a queued message, for the code of its area. */
export function pendingInputSurfaceContext(
  input: PendingChatInput,
): ChatSurfaceState | null {
  for (const part of input.parts)
    if (part.kind === "surface_observation")
      return surfaceStateOf(part.observation);
  return null;
}
