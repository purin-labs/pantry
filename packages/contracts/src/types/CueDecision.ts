
export type CueDecision =
  | { kind: "ignore"; organisationId: string; cueId: string; reason: string }
  | {
      kind: "store_only";
      organisationId: string;
      cueId: string;
      memoryRef: string;
    }
  | {
      kind: "triage";
      organisationId: string;
      cueId: string;
      valency: number;
      reason: string;
    }
  | {
      kind: "respond";
      organisationId: string;
      cueId: string;
      valency: number;
      sessionId: string;
    };
