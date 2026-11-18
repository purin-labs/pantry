import {
  type CommerceMutationResultV1,
  type CommerceDiscountV1,
  type CommerceGiftCardBalanceV1,
  type CommerceStoredValueAccountV1,
  type CommerceStoredValueLiabilityV1,
} from "@seams/commerce-client";
import { CustomerFamily } from "./customers.ts";

/**
 * Discounts and stored value: gift cards and store credit.
 */
export abstract class PromotionFamily extends CustomerFamily {
  createDiscount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.discounts.createDiscount(rawCommand);
  }

  deactivateDiscount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.discounts.deactivateDiscount(rawCommand);
  }

  listDiscounts(merchantId: string): readonly CommerceDiscountV1[] {
    return this.discounts.listDiscounts(merchantId);
  }

  issueGiftCard(rawCommand: unknown): CommerceMutationResultV1 {
    return this.storedValue.issueGiftCard(rawCommand);
  }

  creditStoreCredit(rawCommand: unknown): CommerceMutationResultV1 {
    return this.storedValue.creditStoreCredit(rawCommand);
  }

  disableStoredValueAccount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.storedValue.disableAccount(rawCommand);
  }

  listStoredValueAccounts(
    merchantId: string,
  ): readonly CommerceStoredValueAccountV1[] {
    return this.storedValue.listAccounts(merchantId);
  }

  readStoredValueLiability(
    merchantId: string,
    at: string,
  ): CommerceStoredValueLiabilityV1 {
    return this.storedValue.liability(merchantId, at);
  }

  readGiftCardBalance(
    merchantId: string,
    code: string,
  ): CommerceGiftCardBalanceV1 | undefined {
    return this.storedValue.giftCardBalance(merchantId, code, this.now());
  }
}
