import type { ArtifactRef } from "./ArtifactRef";
import type { CommerceEntityPlaneProposal } from "@purin-labs/commerce-contracts";
import type { SourceProvenance } from "@purin-labs/commerce-contracts";
import type { UserMessage } from "./UserMessage";

export type CaseContent =
  | { kind: "user_message"; message: UserMessage }
  | {
      kind: "record_message";
      message: UserMessage;
      provenance: SourceProvenance;
    }
  | { kind: "text"; text: string }
  | { kind: "artifact"; artifact: ArtifactRef; preview: string }
  | { kind: "commerce_reference"; provenance: SourceProvenance }
  | { kind: "entity_plane_proposal"; proposal: CommerceEntityPlaneProposal };
