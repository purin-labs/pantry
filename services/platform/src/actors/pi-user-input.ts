import type { HarnessHistoryContent } from "@seams/contracts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { assertNever } from "@seams/std";
import type { Result } from "../result";
import type {
  EmbeddedHarnessUserInput,
  EmbeddedHarnessTurnError,
} from "./embedded-harness";

export function toPiPrompt(
  input: readonly EmbeddedHarnessUserInput[],
): Result<
  { readonly text: string; readonly images: ImageContent[] },
  EmbeddedHarnessTurnError
> {
  if (input.length === 0) {
    return { ok: false, error: { code: "embedded_harness_input_unsupported" } };
  }
  const images: ImageContent[] = [];
  const manifests: string[] = [];

  for (const item of input) {
    switch (item.kind) {
      case "image": {
        const encoded =
          /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
            item.dataUrl,
          );
        if (encoded === null) {
          return {
            ok: false,
            error: { code: "embedded_harness_input_unsupported" },
          };
        }
        images.push({
          type: "image",
          data: encoded[2]!,
          mimeType: encoded[1]!,
        });
        break;
      }
      case "attachment_manifest":
        // A file Pi cannot see natively is described instead, so the agent
        // knows it exists and knows its contents were not read.
        manifests.push(item.manifest);
        break;
      case "attachment_text":
        manifests.push(
          `${item.manifest}\n${item.text}${item.truncated ? "\n[truncated]" : ""}`,
        );
        break;
      case "attachment_media":
        manifests.push(`${item.manifest}\n${item.summary}`);
        break;
      case "project_context":
      case "text":
        manifests.push(item.text);
        break;
      default:
        return assertNever(item);
    }
  }

  const text = manifests.join("\n");

  return { ok: true, value: { text, images } };
}

export function toHistoryContent(
  input: EmbeddedHarnessUserInput,
): HarnessHistoryContent {
  switch (input.kind) {
    case "project_context":
      return {
        kind: "project_context",
        snapshotDigest: input.snapshotDigest,
        text: input.text,
      };
    case "text":
      return { kind: "text", text: input.text };
    case "image":
    case "attachment_manifest":
    case "attachment_text":
    case "attachment_media":
      return { kind: "attachment", attachment: input.attachment };
    default:
      return assertNever(input);
  }
}
