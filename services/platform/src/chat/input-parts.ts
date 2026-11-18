import type { ChatInputMode, SurfaceObservationV2 } from "@seams/control-api";
import type { BakeryBrowserContext } from "@seams/bakery-model/bakery-context";
import type { BakerySurfaceAttachmentV1 } from "@seams/bakery-model/bakery-surface";
import { kitchenAttachment } from "./kitchen-observation";
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

/** The Kitchen view of a queued message, for the Kitchen code. */
export function pendingInputSurfaceContext(
  input: PendingChatInput,
): BakerySurfaceAttachmentV1 | null {
  for (const part of input.parts)
    if (part.kind === "surface_observation")
      return kitchenAttachment(part.observation);
  return null;
}

/** The screen observation of a message, as a field to spread into it. */
export function surfaceObservationField(
  surfaceObservation: SurfaceObservationV2 | undefined,
): Readonly<{ surfaceObservation?: SurfaceObservationV2 }> {
  return surfaceObservation === undefined ? {} : { surfaceObservation };
}
