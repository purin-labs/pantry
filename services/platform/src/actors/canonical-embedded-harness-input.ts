import type { ProjectSnapshot } from "@purin-labs/control-api";
import type {
  AcceptedInputRef,
  Sha256Digest,
  StoredMessageAttachment,
} from "@purin-labs/contracts";

import type { ModelContextBundle } from "../context/assembly";
import type { StoredContextBundle } from "./actor-journal";

export type CanonicalEmbeddedHarnessInput = {
  readonly projectContext: ProjectSnapshot | null;
  readonly turnId: string;
  readonly inputId: string;
  readonly instruction: string;
  readonly attachments: readonly StoredMessageAttachment[];
  /** Links the message carried, in canonical order. */
  readonly links: readonly string[];
  readonly acceptedInput: AcceptedInputRef;
  readonly contextBundle: StoredContextBundle;
  readonly contextBundleDigest: Sha256Digest;
  readonly modelContext: ModelContextBundle;
};
