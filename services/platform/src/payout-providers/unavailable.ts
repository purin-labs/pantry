import type { PayoutRecoveryProvider } from "../payouts/recovery";

/** No provider contract is certified. This adapter supplies no delivery evidence. */
class UnavailableSupplierPayoutProvider implements PayoutRecoveryProvider {
  readonly rail: string;

  constructor(rail: string) {
    this.rail = rail;
  }

  async createTransfer() {
    return { kind: "rejected" as const, reason: `${this.rail}_unavailable` };
  }

  async fundTransfer() {
    return { kind: "rejected" as const, reason: `${this.rail}_unavailable` };
  }

  async inquireTransfer() {
    return { kind: "unknown" as const };
  }

  async inquireStatus() {
    return null;
  }

  async inquireFunding() {
    return { kind: "unknown" as const };
  }
}

export function resolveSupplierPayoutProvider(
  rail: "gmo_aozora_private" | "wise_enterprise_payouts",
): PayoutRecoveryProvider {
  return new UnavailableSupplierPayoutProvider(rail);
}
