import type { AgentScenarioSaveManifest } from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import type { RunSnapshotSummary } from "@purin-labs/bakery-model/bakery-run-snapshot";
import type { StrictUnion } from "@purin-labs/type-utils";

// The saved Bakery runs and scenarios, as the Kitchen tool services and the
// Kitchen surface result name them. A part of the Kitchen contract.

export type SavedBakeryRunQuery = StrictUnion<
  | Readonly<{ kind: "list"; cursor: string | null }>
  | Readonly<{ kind: "read"; id: string }>
  | Readonly<{ kind: "latest" }>
>;

type SavedBakeryRunContext = Readonly<{
  kind: "saved_bakery_run";
  source: RunSnapshotSummary;
  revision: string;
  observedAt: number;
  evidence: "saved_simulation";
  settings: Readonly<Record<string, number>>;
  trays: number | null;
  operations: number | null;
  recordedOperations: number | null;
  assumptions: readonly string[];
}>;

export type SavedBakeryRunResult =
  | SavedBakeryRunContext
  | Readonly<{
      kind: "saved_bakery_runs";
      snapshots: readonly RunSnapshotSummary[];
      nextCursor: string | null;
      observedAt: number;
    }>
  | Readonly<{ kind: "unavailable"; reason: "missing" | "invalid" }>;

export type AgentRunSaveVerification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "read_failed" }>
  | Readonly<{ kind: "unavailable"; effectId: string }>
  | Readonly<{
      kind: "verified";
      effectId: string;
      snapshot: RunSnapshotSummary;
    }>;

export type AgentScenarioSaveResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "read_failed" }>
  | Readonly<{ kind: "unavailable"; effectId: string }>
  | Readonly<{
      kind: "saved";
      effectId: string;
      manifest: AgentScenarioSaveManifest;
      scenarioId: string;
    }>;
