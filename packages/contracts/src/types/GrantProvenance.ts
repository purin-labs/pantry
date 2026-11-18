
export type GrantProvenance =
  | { kind: "operator"; userId: string; mutationReceiptId: string }
  | {
      kind: "baseline";
      profile: string;
      profileVersion: number;
      materializationReceiptId: string;
    }
  | {
      kind: "integration_setup";
      integrationAccountId: string;
      setupRevision: number;
      materializationReceiptId: string;
    }
  | { kind: "cutover"; migrationId: string; originalChangedAt: number };
