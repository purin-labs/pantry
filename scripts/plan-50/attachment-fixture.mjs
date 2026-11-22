import { sha256Hex } from "../../packages/std/src/index.ts";
import { parseStoredAttachment } from "../../foundation/agent/messages/stored-attachment.ts";

export const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=";

export async function imageInput(organisationId) {
  const binary = Uint8Array.from(atob(imageBase64), byteValue);
  const digest = await sha256Hex(binary);
  const attachment = parseStoredAttachment({
    id: `att_${digest.slice(0, 32)}`,
    displayName: "inventory.png",
    extensionHint: { kind: "named", value: "png" },
    descriptor: {
      kind: "image",
      media: {
        kind: "signature_verified",
        mediaType: "image/png",
        method: "magic_bytes",
      },
    },
    byteLength: binary.byteLength,
    sha256: digest,
    objectKey: `attachments/${organisationId}/slack/${digest}`,
    source: {
      kind: "slack",
      integrationAccountId: "integration_plan50_draft",
      workspaceId: "workspace_plan50_seams",
      channelId: "channel_plan50_seams",
      messageTs: "1700000000.000100",
      fileId: "file_plan50_image",
      revision: "1",
    },
    retention: "session",
    storedAt: 1700000000,
  });
  if (!attachment.ok) throw new Error(attachment.error.code);
  return {
    kind: "image",
    dataUrl: `data:image/png;base64,${imageBase64}`,
    detail: "original",
    attachment: attachment.value,
  };
}
function byteValue(character) {
  return character.charCodeAt(0);
}
