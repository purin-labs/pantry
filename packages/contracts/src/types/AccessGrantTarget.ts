import type { CommerceAuthorityScope } from "@seams/commerce-contracts";
import type { CommerceMutationTarget } from "@seams/commerce-contracts";
import type { CommerceReadGrantScope } from "./CommerceReadGrantScope";
import type { FileResourceScope } from "./FileResourceScope";

export type AccessGrantTarget =
  | {
      kind: "platform_capability";
      capabilityId: string;
      capabilityVersion: number;
    }
  | {
      kind: "provider_resource";
      capabilityId: string;
      capabilityVersion: number;
      integrationAccountId: string;
      resourceScope: string;
    }
  | {
      kind: "file_resource";
      capabilityId: string;
      capabilityVersion: number;
      integrationAccountId: string;
      scope: FileResourceScope;
    }
  | {
      kind: "custom_connector_operation";
      capabilityId: string;
      capabilityVersion: number;
      integrationAccountId: string;
      connectorId: string;
      definitionRevision: number;
      definitionDigest: string;
      operationId: string;
    }
  | {
      kind: "commerce_read";
      capabilityId: string;
      capabilityVersion: number;
      scope: CommerceReadGrantScope;
    }
  | {
      kind: "commerce_command";
      capabilityId: string;
      capabilityVersion: number;
      scope: CommerceAuthorityScope;
      target: CommerceMutationTarget;
    };
