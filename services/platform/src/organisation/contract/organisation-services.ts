import type { removeIntegrationAccount } from "../../data/account-removal";
import type {
  cancelOperatorConfigurationDraft,
  confirmOperatorConfigurationDraft,
  previewCode,
  readOperatorDraft,
} from "../../data/operator-configuration-draft";
import { definePort } from "../../port";

/**
 * The Organisation records that other areas use: the removal of an
 * integration account, and the configuration drafts that a Kitchen
 * workflow change waits on. The Organisation area owns them, and the Worker
 * registers the implementation (`worker-ports.ts`).
 */
export type OrganisationServices = Readonly<{
  removeIntegrationAccount: typeof removeIntegrationAccount;
  readOperatorDraft: typeof readOperatorDraft;
  cancelOperatorConfigurationDraft: typeof cancelOperatorConfigurationDraft;
  confirmOperatorConfigurationDraft: typeof confirmOperatorConfigurationDraft;
  /** The short code that a person compares before a confirmation. */
  previewCode: typeof previewCode;
}>;

export const organisationServices = definePort<OrganisationServices>(
  "organisation_services",
);
