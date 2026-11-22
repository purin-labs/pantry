import type { StoredMessageAttachment, UserMessage } from "@purin-labs/contracts";

import { attachmentManifestLine } from "../messages/attachment-inspection";
import type { Result } from "@purin-labs/kernel/result";
import {
  readMessageLink,
  type MessageLinkEgress,
} from "../messages/link-reader";
import type { EmbeddedHarnessUserInput } from "./embedded-harness";
import { assertNever } from "@purin-labs/std";

type AttachmentInspectionToolInput = {
  readonly attachments: readonly StoredMessageAttachment[];
  readonly readPreparation: (
    attachment: StoredMessageAttachment,
  ) => Promise<
    Result<readonly EmbeddedHarnessUserInput[], { readonly code: string }>
  >;
  /**
   * Records what the read observed against the session's cumulative
   * information-flow binding. Content pulled out of an attachment is message
   * content, so it has to tighten the same binding the final delivery is
   * checked against; otherwise a file could be read and then echoed to a
   * destination its label forbids.
   */
  readonly recordObservation?: (observed: {
    readonly attachment: StoredMessageAttachment;
  }) => Promise<void>;
};

/**
 * The two message tools, scoped to the message the current turn is answering.
 *
 * Scope is the point. An attachment id or URL the agent supplies is matched
 * against this turn's own message parts, so neither tool can reach a file or a
 * link from another conversation even if the model invents a plausible
 * identifier.
 */

export function createAttachmentInspectionTool(
  input: AttachmentInspectionToolInput,
) {
  return inspectAttachment.bind(null, input);
}

async function inspectAttachment(
  input: AttachmentInspectionToolInput,
  request: { readonly attachmentId: string },
): Promise<Readonly<Record<string, unknown>>> {
  const attachment = input.attachments.find(
    byAttachmentId.bind(null, request.attachmentId),
  );

  if (attachment === undefined) {
    // Not an error the agent can act on by retrying: the file simply is not
    // part of this message.
    return {
      outcome: "attachment_not_in_message",
      attachmentId: request.attachmentId,
      available: input.attachments.map(identifyAttachment),
    };
  }

  const prepared = await input.readPreparation(attachment);

  if (!prepared.ok) {
    return {
      outcome: "unavailable",
      reason: prepared.error.code,
      attachmentId: request.attachmentId,
      manifest: attachmentManifestLine(attachment),
    };
  }

  if (input.recordObservation !== undefined) {
    await input.recordObservation({ attachment });
  }

  return {
    outcome: "inspected",
    result: toolVisiblePreparation(prepared.value),
  };
}

function byAttachmentId(
  attachmentId: string,
  candidate: StoredMessageAttachment,
): boolean {
  return String(candidate.id) === attachmentId;
}

function identifyAttachment(candidate: StoredMessageAttachment): string {
  return String(candidate.id);
}

/**
 * Tool results are text. Native image input is already part of the initial
 * model call, so the inspection result reports image identity and provenance
 * while omitting its data URL.
 */
function toolVisiblePreparation(
  parts: readonly EmbeddedHarnessUserInput[],
): Readonly<Record<string, unknown>> {
  return {
    kind: "prepared_attachment",
    parts: parts.map(describePreparedPart),
  };
}

function describePreparedPart(
  part: EmbeddedHarnessUserInput,
): Readonly<Record<string, unknown>> {
  switch (part.kind) {
    case "text":
    case "project_context":
      return { kind: "text", text: part.text };
    case "image":
      return {
        kind: "image",
        attachmentId: String(part.attachment.id),
        mediaType: imageMediaType(part.dataUrl),
        detail: part.detail,
        includedInInitialNativeModelInput: true,
        note: "image already part of initial native model input",
      };
    case "attachment_manifest":
      return {
        kind: part.kind,
        attachmentId: String(part.attachment.id),
        manifest: part.manifest,
      };
    case "attachment_text":
      return {
        kind: part.kind,
        attachmentId: String(part.attachment.id),
        manifest: part.manifest,
        text: part.text,
        truncated: part.truncated,
      };
    case "attachment_media":
      return {
        kind: part.kind,
        attachmentId: String(part.attachment.id),
        manifest: part.manifest,
        summary: part.summary,
      };
    default:
      return assertNever(part);
  }
}

function imageMediaType(dataUrl: string): string {
  const separator = dataUrl.indexOf(";");
  return separator > "data:".length
    ? dataUrl.slice("data:".length, separator)
    : "image/unknown";
}

export function createMessageLinkTool(input: {
  readonly links: readonly string[];
  readonly egress?: MessageLinkEgress;
}) {
  return async function read(request: {
    readonly url: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (!input.links.includes(request.url)) {
      // Only links the author actually wrote are readable. A URL the model
      // composed is refused rather than fetched.
      return {
        outcome: "link_not_in_message",
        available: input.links,
      };
    }

    const result = await readMessageLink({
      url: request.url,
      egress: input.egress,
    });

    return result.ok
      ? {
          outcome: "read",
          content: result.value.content,
          receipt: result.value.receipt,
        }
      : { outcome: "refused", reason: result.error };
  };
}

/** Every link the message carried, in canonical order. */
export function userMessageLinks(message: UserMessage): readonly string[] {
  const links: string[] = [];

  for (const part of [message.firstPart, ...message.remainingParts]) {
    if (part.kind === "link") {
      links.push(String(part.link.url));
    }
  }

  return links;
}
