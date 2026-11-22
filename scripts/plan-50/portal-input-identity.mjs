import { isChatId } from "../../services/platform/src/chat/conversation.ts";
import { parseUserId } from "../../packages/control-api/src/ids.ts";

// The native deduplication key retains admission metadata. Pi's inbox remains
// the only queue; this creates no second input record or lifecycle.
export function portalInputRequestId(requesterId, input, digest, acceptedAt) {
  return [
    "portal",
    requesterId,
    input.kind,
    input.requestId,
    input.inputId,
    digest,
    acceptedAt,
  ].join(":");
}

export function parsePortalInputIdentity(value) {
  if (typeof value !== "string" || !value.startsWith("portal:")) return null;
  const [
    prefix,
    requesterId,
    mode,
    requestId,
    inputId,
    digest,
    timestamp,
    ...extra
  ] = value.split(":");
  const acceptedAt = Number(timestamp);
  if (
    prefix !== "portal" ||
    extra.length !== 0 ||
    !parseUserId(requesterId).ok ||
    (mode !== "next" && mode !== "steer") ||
    !isChatId(requestId) ||
    !isChatId(inputId) ||
    !/^[a-f0-9]{64}$/u.test(digest ?? "") ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt <= 0
  )
    throw new Error("Invalid persisted Portal input identity");
  return { requesterId, mode, requestId, inputId, digest, acceptedAt };
}
