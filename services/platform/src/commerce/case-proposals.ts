import {
  commerceSystemSource,
  type CommerceSystemKind,
} from "@purin-labs/contracts";
import {
  commerceSystemAuthoritySchema,
  integrationAccountAuthoritySchema,
} from "@purin-labs/contracts/case-rpc";
import { checked } from "@purin-labs/contracts/connector-rpc";
import type { SourceProvenance } from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";
import type { CaseCommercePart } from "@purin-labs/conversation/actors/case/parts";
import { parseSourceProvenance } from "@purin-labs/conversation/actors/case/source-provenance";
import type { CaseCommerceProposal } from "@purin-labs/conversation/actors/case/types";
import { parseIntegrationAccountId, type IntegrationAccountId } from "@purin-labs/kernel/ids";
import {
  parseCommerceSystemRevision,
  type CommerceSystemRevision,
} from "@purin-labs/connections/data/organisation-commerce-system";
import {
  parseCommerceActionRequest,
  parseCommerceProviderReceipt,
  type CommerceActionRequest,
} from "./action-model";
import { parseCommerceEntityPlaneProposal } from "./entity-plane/proposals";

/**
 * The commerce part of the Case (Refactor 17, step A1.6 for the Case). The
 * Case stores a commerce proposal and reads its envelope; this part checks
 * the action, the authority and the source record of its body.
 */
export const caseCommercePart: CaseCommercePart = {
  parseProposalBody: parseCommerceCaseProposalBody,
  parseEntityPlaneCommand: parseCommerceEntityPlaneProposal,
  parseProviderReceipt(value) {
    const receipt = parseCommerceProviderReceipt(value);
    return receipt.ok ? receipt.value : null;
  },
};

type CommerceCaseAuthority =
  | Readonly<{ kind: "lab" }>
  | Readonly<{
      kind: "commerce_system";
      system: CommerceSystemKind;
      revision: CommerceSystemRevision;
      integrationAccountId: IntegrationAccountId;
    }>;

/** The body of a commerce proposal: the authority that the action needs. */
type CommerceCaseProposalBody =
  | Readonly<{
      action: Exclude<
        CommerceActionRequest,
        {
          kind:
            | "install_merchant_plugin"
            | "publish_cafe_menu"
            | "change_menu_price"
            | "refund_order"
            | "stock_operation"
            | "submit_supplier_payout"
            | "resume_supplier_payout_funding";
        }
      >;
      authority: CommerceCaseAuthority;
      provenance: SourceProvenance;
    }>
  | Readonly<{
      // A merchant plugin is configuration, not a projection: the commerce
      // system is the authority, and no source record is its provenance.
      action: Variant<
        CommerceActionRequest,
        | "install_merchant_plugin"
        | "publish_cafe_menu"
        | "change_menu_price"
        | "refund_order"
        | "stock_operation"
      >;
      authority: CommerceCaseAuthority;
      provenance: null;
    }>
  | Readonly<{
      action: Variant<
        CommerceActionRequest,
        "submit_supplier_payout" | "resume_supplier_payout_funding"
      >;
      authority: Readonly<{
        kind: "integration_account";
        integrationAccountId: IntegrationAccountId;
      }>;
      provenance: null;
    }>;

/** A commerce proposal of a Case, with the precise types of its body. */
export type CommerceCaseProposal = Omit<
  CaseCommerceProposal,
  "action" | "authority" | "provenance"
> &
  CommerceCaseProposalBody;

function parseCommerceCaseProposalBody(
  value: Readonly<{ action: unknown; authority: unknown; provenance: unknown }>,
): CommerceCaseProposalBody | null {
  const parsed = parseCommerceActionRequest(value.action);
  if (!parsed.ok) return null;
  const action = parsed.value;
  if (
    action.kind === "submit_supplier_payout" ||
    action.kind === "resume_supplier_payout_funding"
  ) {
    const authority = checked(
      integrationAccountAuthoritySchema,
      value.authority,
    );
    if (value.provenance !== null || authority === null) return null;
    const account = parseIntegrationAccountId(authority.integrationAccountId);
    if (!account.ok) return null;
    return {
      action,
      authority: {
        kind: "integration_account",
        integrationAccountId: account.value,
      },
      provenance: null,
    };
  }
  if (
    action.kind === "install_merchant_plugin" ||
    action.kind === "publish_cafe_menu" ||
    action.kind === "change_menu_price" ||
    action.kind === "refund_order" ||
    action.kind === "stock_operation"
  ) {
    const authority = parsePluginCaseAuthority(value.authority);
    if (value.provenance !== null || authority === null) return null;
    return { action, authority, provenance: null };
  }
  const provenance = parseSourceProvenance(value.provenance);
  const authority =
    provenance === null
      ? null
      : parseCommerceCaseAuthority(value.authority, provenance);
  return provenance === null || authority === null
    ? null
    : { action, authority, provenance };
}

// A merchant plugin lives in Pantry Commerce (Commerce); no source record
// names its integration account, so the authority stands on its own.
function parsePluginCaseAuthority(
  value: unknown,
): CommerceCaseAuthority | null {
  const authority = checked(commerceSystemAuthoritySchema, value);
  if (authority === null || authority.system !== "builtin_commerce") return null;
  const revision = parseCommerceSystemRevision(authority.revision);
  const integrationAccountId = parseIntegrationAccountId(
    authority.integrationAccountId,
  );
  return revision.ok && integrationAccountId.ok
    ? {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: revision.value,
        integrationAccountId: integrationAccountId.value,
      }
    : null;
}

function parseCommerceCaseAuthority(
  value: unknown,
  provenance: SourceProvenance,
): CommerceCaseAuthority | null {
  if (!isRecord(value)) return null;
  if (value.kind === "lab") {
    return provenance.source === "lab" ? { kind: "lab" } : null;
  }
  const authority = checked(commerceSystemAuthoritySchema, value);
  if (authority === null) return null;
  const revision = parseCommerceSystemRevision(authority.revision);
  const integrationAccountId = parseIntegrationAccountId(
    authority.integrationAccountId,
  );
  if (
    !revision.ok ||
    !integrationAccountId.ok ||
    integrationAccountId.value !== provenance.integrationAccountId ||
    provenance.source !== commerceSystemSource(authority.system)
  ) {
    return null;
  }
  return {
    kind: "commerce_system",
    system: authority.system,
    revision: revision.value,
    integrationAccountId: integrationAccountId.value,
  };
}
