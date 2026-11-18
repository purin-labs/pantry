import type { ScenarioCopy } from "./bakery-scenario.ts";
import type { ProductionScenario } from "./bakery-production-scenario.ts";

export type AgentScenarioSavePayload =
  | Readonly<{ kind: "scenario"; copy: ScenarioCopy }>
  | Readonly<{
      kind: "production-scenario";
      copy: ProductionScenario;
    }>;

export type AgentScenarioSaveManifest = Readonly<{
  kind: AgentScenarioSavePayload["kind"];
  id: string;
  name: string;
  sourceFingerprint: string;
  digest: string;
  bytes: number;
}>;

export async function agentScenarioSaveManifest(
  payload: AgentScenarioSavePayload,
): Promise<AgentScenarioSaveManifest> {
  const content = JSON.stringify(payload.copy);
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = Array.from(new Uint8Array(hash), hexByte).join("");
  return {
    kind: payload.kind,
    id: payload.copy.id,
    name: payload.copy.name,
    sourceFingerprint:
      payload.kind === "scenario"
        ? payload.copy.fingerprint
        : payload.copy.sourceFingerprint,
    digest,
    bytes: bytes.length,
  };
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
