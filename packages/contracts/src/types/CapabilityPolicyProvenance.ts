
export type CapabilityPolicyProvenance =
  | {
      kind: "baseline";
      profile: string;
      profileVersion: number;
      materializationReceiptId: string;
    }
  | { kind: "operator"; userId: string; mutationReceiptId: string }
  | {
      kind: "integration_setup";
      integrationAccountId: string;
      setupRevision: number;
      materializationReceiptId: string;
    }
  | { kind: "cutover_enabled"; migrationId: string; previousEnabledAt: number }
  | { kind: "cutover_disabled"; migrationId: string };
