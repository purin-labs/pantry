// The commerce graph reader of the selected commerce system. The provider of
// the system says which sources the reader uses (Refactor 17, step A2.5).
import type { CommerceSystem } from "../../data/organisation-commerce-system";
import type { OrganisationId } from "../../ids";
import { commerceProvider } from "../commerce-providers";
import {
  BlotterSource,
  type BlotterOrganisationReader,
} from "./blotter-source";
import type { CommerceEngineSource } from "./commerce-source";
import { CommerceGraphReader } from "./graph-reader";

export async function createCommerceGraphReader(
  input: Readonly<{
    commerceSystem: CommerceSystem;
    organisationId: OrganisationId;
    merchantId: string;
    commerce: CommerceEngineSource;
    /** The Organisation actor; read only for a provider-backed system. */
    organisation: () => Promise<BlotterOrganisationReader>;
  }>,
): Promise<CommerceGraphReader> {
  const source = commerceProvider(input.commerceSystem.kind).graphSource(
    input.commerceSystem,
  );
  switch (source.kind) {
    case "commerce_engine":
      return new CommerceGraphReader({
        organisationId: String(input.organisationId),
        merchantId: input.merchantId,
        commerce: input.commerce,
      });
    case "provider_backed":
      return new CommerceGraphReader({
        organisationId: String(input.organisationId),
        merchantId: input.merchantId,
        commerce: input.commerce,
        blotter: new BlotterSource({
          organisation: await input.organisation(),
          organisationId: input.organisationId,
          merchantId: input.merchantId,
          integrationAccountId: source.integrationAccountId,
        }),
      });
  }
}
