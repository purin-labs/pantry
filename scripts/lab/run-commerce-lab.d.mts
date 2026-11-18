export type CommerceLabScenarioId =
  | "product-listing"
  | "happy-order"
  | "payment-failed"
  | "inventory-shortage"
  | "shipment-delayed"
  | "cancellation-refund";

export const COMMERCE_LAB_SCENARIO_IDS: readonly CommerceLabScenarioId[];

type LabConnection = {
  baseUrl: string;
  organisationId: string;
  token: string;
  signingSecret: string | null;
  outputPath: string | null;
  idempotencyKey: string | null;
  remoteAcknowledged: boolean;
};

export type CommerceLabOptions = LabConnection &
  (
    | {
        command: "scenario";
        scenarioId: CommerceLabScenarioId;
        namespace: string;
      }
    | { command: "reset" | "seed"; scenarioId: null; namespace: string }
    | { command: "verify"; scenarioId: null; namespace: string | null }
  );

export function parseLabOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CommerceLabOptions;

export function runCommerceLab(
  options: CommerceLabOptions,
  fetchImplementation: typeof fetch,
): Promise<unknown>;

export function runCommerceLabWorkflow(
  options: CommerceLabOptions,
  dependencies: {
    fetchImplementation: typeof fetch;
    clock: () => number;
    delay: (milliseconds: number) => Promise<unknown>;
  },
): Promise<unknown>;
