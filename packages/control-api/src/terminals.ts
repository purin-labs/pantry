/**
 * What the till should show for one counter sale, and what it may do next.
 *
 * The classification exists so the answer to "can I take this payment again?"
 * is computed in one place from the Checkout and its payment attempt, rather
 * than inferred separately by every surface that asks. Getting it wrong in the
 * permissive direction charges a customer twice.
 */
export type CounterSaleState =
  /** Rung up, nothing presented yet. */
  | "awaiting_collection"
  /** Presented on the terminal; the provider has not answered. */
  | "collecting"
  /**
   * Satyr does not know whether the provider took the money. This is not a
   * failure — it is the absence of an answer, and the only safe response is to
   * reconcile the original attempt rather than start another.
   */
  | "submission_unknown"
  /** The provider declined. A fresh collection is legitimate. */
  | "declined"
  /**
   * Money was taken but the Order has not been placed. The customer has paid;
   * the sale has to be completed or refunded, never re-collected.
   */
  | "captured_unplaced"
  /** Money taken and the Order placed. The sale is done. */
  | "complete"
  /** The quote expired before anything was collected. */
  | "expired";

export type TerminalBlockedReason = "assignment_retired";

export type TerminalConfigurationRequest = Readonly<{
  satyrLocationId: string;
  integrationAccountId: string;
  providerLocationId: string;
  testDeviceId: string;
}>;

/** Asks Square for a code that pairs a physical Terminal (production only). */
export type TerminalPairingRequest = Readonly<{
  satyrLocationId: string;
  integrationAccountId: string;
  providerLocationId: string;
  /** The name that Square shows for the device once it is paired. */
  deviceName: string;
}>;

/**
 * A pairing code as Square has it. The owner types `code` on a signed-out
 * Square Terminal before `pairBy`; a code past `pairBy` is expired.
 */
export type TerminalPairingReadback = Readonly<{
  deviceCodeId: string;
  code: string;
  providerLocationId: string;
  pairBy: string | null;
  status: "open" | "paired" | "expired";
}>;

export type TerminalCounterReadback = Readonly<{
  satyrLocationId: string;
  /** Why this counter cannot collect, or null when it can. */
  blockedReason: TerminalBlockedReason | null;
  assignment: Readonly<{
    assignmentId: string;
    revision: number;
    merchantId: string;
    integrationAccountId: string;
    capabilityRevision: number;
    capabilityCurrent: boolean;
    providerLocationId: string;
    targetKind: "sandbox_simulated" | "paired_physical";
    deviceId: string;
    adapterVersion: string;
    environment: "development" | "production";
    /**
     * False for a Sandbox simulation, which is not a provider device resource
     * and can therefore only ever report unknown health.
     */
    healthIsObservable: boolean;
  }>;
  credentialHealth:
    | "active"
    | "degraded"
    | "reauth_required"
    | "disabled"
    | "revoked"
    | "unavailable";
  webhook:
    | Readonly<{ kind: "unconfigured" }>
    | Readonly<{
        kind: "configured";
        lifecycle: "pending" | "live" | "degraded" | "disabled" | "revoked";
        credentialCurrent: boolean;
        lastVerifiedAt: number | null;
        updatedAt: number;
      }>;
  /**
   * Whether Commerce takes this location's Square Terminal payments: the
   * merchant links the location in Commerce (Plan 80). A counter that is
   * not linked cannot collect, and it is reported, not hidden.
   */
  paymentsLinked: boolean;
}>;
