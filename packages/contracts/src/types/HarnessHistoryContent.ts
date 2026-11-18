import type { MessageLink } from "./MessageLink";
import type { Sha256Digest } from "./Sha256Digest";
import type { StoredMessageAttachment } from "./StoredMessageAttachment";

export type HarnessHistoryContent =
  | { kind: "text"; text: string }
  | { kind: "project_context"; snapshotDigest: Sha256Digest; text: string }
  | { kind: "link"; link: MessageLink }
  | { kind: "attachment"; attachment: StoredMessageAttachment };
