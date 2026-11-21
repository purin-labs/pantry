import type { ArtifactRef } from "./ArtifactRef";
import type { ContractCommercePart } from "../commerce-parts.ts";
import type { UserMessage } from "./UserMessage";

export type CaseContent =
  | { kind: "user_message"; message: UserMessage }
  | {
      kind: "record_message";
      message: UserMessage;
      provenance: ContractCommercePart<"sourceProvenance">;
    }
  | { kind: "text"; text: string }
  | { kind: "artifact"; artifact: ArtifactRef; preview: string }
  | {
      kind: "commerce_reference";
      provenance: ContractCommercePart<"sourceProvenance">;
    }
  | {
      kind: "entity_plane_proposal";
      proposal: ContractCommercePart<"entityPlaneProposal">;
    };
