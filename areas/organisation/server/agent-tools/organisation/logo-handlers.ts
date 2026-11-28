import type { StoredMessageAttachment } from "@purin-labs/contracts";
import type { StaffPageToolReceipt } from "@purin-labs/agent-tools/catalog/types";
import { requireSessionExecution } from "@purin-labs/agent/actors/session-execution-admission";
import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  removeLogo,
  setLogo,
  type LogoImage,
  type LogoSubject,
} from "@purin-labs/agent/data/organisation-logos";
import { readVerifiedAttachment } from "@purin-labs/agent/messages/attachment-inspection";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { parseWorkspaceId } from "@purin-labs/kernel/ids";
import { sha256Hex } from "@purin-labs/std";
import {
  liveDeviceMember,
  type ToolEffect,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import { LogoRequestError, type LogoChangeRequest } from "./services";

/**
 * The owner's logo change, as the Logos dialog does it: the person who asked
 * must be the owner now, and the image must be a file of this message.
 */
export async function changeLogoForEmbeddedHarness(
  turn: ToolTurnContext,
  request: LogoChangeRequest,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease } = turn;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null || member.role !== "owner")
    throw new LogoRequestError(
      "Only the owner changes a logo, and the person who asked is not the owner now. Nothing changed. Tell the person. Do not ask for a permission or retry.",
    );
  const subject = logoSubject(request);
  const image =
    request.logo === "remove"
      ? null
      : await attachedImage(env.ARCHIVE, turn.attachments);
  const store = {
    db: scope.database,
    archive: env.ARCHIVE,
    organisationId: scope.organisationId,
    subject,
  };
  return {
    kind: "effect",
    label: {
      source: "turn",
      unavailable: "logo change information-flow authority unavailable",
    },
    sink: {
      kind: "tool_effect" as const,
      destinationAuthority: lease.requestAuthority,
      capabilityId: CAPABILITY_KEYS.organisationLogoChange,
      integrationAccountId: "platform",
      resourceScope:
        subject.kind === "organisation"
          ? "logo:organisation"
          : `logo:${subject.workspaceId}`,
      approvalSatisfied: false,
    },
    action: {
      operation:
        image === null ? "organisation.logo.remove" : "organisation.logo.set",
      arguments: {
        subject: request.subject,
        workspaceId: request.workspaceId,
        sha256: image?.sha256 ?? null,
      },
    },
    refusal: (decision) => `Logo change is not authorized: ${decision}`,
    run: async () => {
      if (image === null) {
        const removed = await removeLogo(store);
        if (!removed.ok) throw logoRefusal(removed.error.code);
        return {
          receiptId: `logo_removed_${subject.kind === "organisation" ? "organisation" : subject.workspaceId}`,
          result: removed.value.removed
            ? "The logo is gone. Its tile shows the gradient again."
            : "There was no logo. The tile already shows the gradient.",
        };
      }
      const stored = await setLogo({ ...store, image });
      if (!stored.ok) throw logoRefusal(stored.error.code);
      return {
        receiptId: `logo_${stored.value.sha256}`,
        result:
          "The logo is set. The Organisations page and the workspace switcher show it.",
      };
    },
  };
}

function logoSubject(request: LogoChangeRequest): LogoSubject {
  if (request.workspaceId === null) return { kind: "organisation" };
  const workspaceId = parseWorkspaceId(request.workspaceId);
  if (!workspaceId.ok)
    throw new LogoRequestError(
      "That workspaceId is not a workspace of this organisation. Nothing changed.",
    );
  return { kind: "workspace", workspaceId: workspaceId.value };
}

/**
 * The bytes of the one image of this message, after their digest check. The
 * model sees an image as a picture with no file name, so the tool takes the
 * message's only image and refuses a message with none or with two.
 */
async function attachedImage(
  archive: R2Bucket,
  attachments: readonly StoredMessageAttachment[],
): Promise<LogoImage> {
  const images = attachments.filter(
    (candidate) => candidate.descriptor.kind === "image",
  );
  const [attachment, second] = images;
  if (attachment === undefined || second !== undefined)
    throw new LogoRequestError(
      images.length === 0
        ? "The current message has no image. Ask the person to attach the logo image to the message. Nothing changed."
        : "The current message has more than one image. Ask the person to attach only the logo. Nothing changed.",
    );
  const contentType = LOGO_CONTENT_TYPES.find(
    (type) => type === String(attachment.descriptor.media.mediaType),
  );
  if (contentType === undefined || attachment.byteLength > LOGO_MAX_BYTES)
    throw new LogoRequestError(
      "A logo is a PNG, JPEG or WebP image of 1 MB or less, and this image is not. Nothing changed. Tell the person.",
    );
  const bytes = await readVerifiedAttachment(archive, attachment);
  if (!bytes.ok)
    throw new LogoRequestError(
      "The attached image cannot be read now. Nothing changed. Ask the person to attach it again.",
    );
  return {
    contentType,
    bytes: bytes.value,
    sha256: await sha256Hex(bytes.value),
  };
}

function logoRefusal(code: string): LogoRequestError {
  return new LogoRequestError(
    code === "logo_subject_not_found"
      ? "That workspace is not an active workspace of this organisation. Nothing changed."
      : "Another change of this logo came first. Nothing changed. Ask the person if they still want it.",
  );
}
