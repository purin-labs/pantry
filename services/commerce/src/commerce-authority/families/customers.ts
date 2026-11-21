import {
  type CommerceMutationResultV1,
  type CommerceBuyerCustomerV1,
  type CommerceCustomerAddressV1,
  type CommerceCustomerAddressInputV1,
  type CommerceCustomerExportV1,
  type CommerceCustomerV1,
  type CommerceNotificationV1,
  type CommerceMarketV1,
  type CommerceCompanyV1,
} from "@purin-labs/commerce-client";
import {
  CustomerAuthority,
  type SignInVerification,
} from "../../plugins/customers/index.ts";
import type { NotificationGateway } from "../../notification-gateway.ts";
import { CatalogFamily } from "./catalog.ts";

/**
 * Customer commands and reads, notifications, markets and companies.
 */
export abstract class CustomerFamily extends CatalogFamily {
  createMarket(rawCommand: unknown): CommerceMutationResultV1 {
    return this.markets.createMarket(rawCommand);
  }

  updateMarket(rawCommand: unknown): CommerceMutationResultV1 {
    return this.markets.updateMarket(rawCommand);
  }

  listMarkets(merchantId: string): readonly CommerceMarketV1[] {
    return this.markets.listMarkets(merchantId);
  }

  createCompany(rawCommand: unknown): CommerceMutationResultV1 {
    return this.companies.createCompany(rawCommand);
  }

  updateCompany(rawCommand: unknown): CommerceMutationResultV1 {
    return this.companies.updateCompany(rawCommand);
  }

  listCompanies(merchantId: string): readonly CommerceCompanyV1[] {
    return this.companies.listCompanies(merchantId);
  }

  createCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.customers.createCustomer(rawCommand);
  }

  updateCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.customers.updateCustomer(rawCommand);
  }

  eraseCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.customers.eraseCustomer(rawCommand);
  }

  readCustomer(
    merchantId: string,
    customerId: string,
  ): CommerceCustomerV1 | undefined {
    return this.customers.readCustomer(merchantId, customerId);
  }

  exportCustomer(
    merchantId: string,
    customerId: string,
  ): CommerceCustomerExportV1 | undefined {
    const customer = this.customers.readCustomer(merchantId, customerId);
    return customer === undefined
      ? undefined
      : {
          schemaVersion: "commerce.customer-export.v1",
          customer,
          exportedAt: this.now(),
        };
  }

  requestCustomerSignIn(
    merchantId: string,
    storefrontId: string,
    email: string,
  ): ReturnType<CustomerAuthority["requestSignIn"]> {
    return this.customers.requestSignIn(merchantId, storefrontId, email);
  }

  verifyCustomerSignIn(
    merchantId: string,
    storefrontId: string,
    challengeId: string,
    code: string,
  ): SignInVerification {
    return this.customers.verifySignIn(
      merchantId,
      storefrontId,
      challengeId,
      code,
    );
  }

  identifyCustomer(
    merchantId: string,
    customerId: string,
  ): Readonly<{ email: string }> | undefined {
    return this.customers.identifyCustomer(merchantId, customerId);
  }

  readCustomerSavedAddress(
    merchantId: string,
    customerId: string,
    addressId: string,
  ): CommerceCustomerAddressV1 | undefined {
    return this.customers.savedAddress(merchantId, customerId, addressId);
  }

  readBuyerCustomer(
    merchantId: string,
    customerId: string,
  ): CommerceBuyerCustomerV1 | undefined {
    return this.customers.buyerCustomer(merchantId, customerId);
  }

  saveCustomerAddress(
    merchantId: string,
    customerId: string,
    address: CommerceCustomerAddressInputV1,
  ): CommerceBuyerCustomerV1 | undefined {
    return this.customers.saveAddress(merchantId, customerId, address);
  }

  listNotifications(merchantId: string): readonly CommerceNotificationV1[] {
    return this.customers.listNotifications(merchantId);
  }

  /** Sends waiting notifications; run after a command commits. */
  deliverNotifications(gateway: NotificationGateway): Promise<number> {
    return this.customers.deliverNotifications(gateway);
  }
}
