import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationAccess } from "../../organisation-access/access";
import { definePort } from "@purin-labs/kernel/port";
import type { FlowLabel } from "../../policy/information-flow";
import type { NativeChatAudience } from "../../policy/information-flow/native-audience";

/**
 * The readers of a native chat turn now, for a context candidate under
 * `label`. The conversation owns the Project and conversation access that
 * give them, and the Worker registers the implementation
 * (`worker-ports.ts`). Null refuses the candidate.
 */
export type ResolveNativeChatAudience = (
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  authority: Variant<RequestAuthority, "control">,
  label: FlowLabel,
) => Promise<NativeChatAudience | null>;

export const nativeChatAudience = definePort<ResolveNativeChatAudience>(
  "native_chat_audience",
);
