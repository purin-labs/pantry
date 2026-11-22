import { parseRequestId, type RequestId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VariantBy } from "@purin-labs/type-utils";
import { isNonNegativeInteger } from "@purin-labs/std";

const ONBOARDING_ACTIVATION_ACCEPTANCE_FAULT_KEY =
  "acceptance:onboarding-activation-fault:v1";

export type OnboardingActivationAcceptanceFaultStorage = {
  readonly get: (key: string) => Promise<unknown | undefined>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
};

export type OnboardingActivationAcceptanceFaultInput = {
  readonly requestId: RequestId;
  readonly phase: "placement";
  readonly armedAt: number;
};

export type OnboardingActivationAcceptanceFaultRecord =
  | {
      readonly state: "armed";
      readonly requestId: RequestId;
      readonly phase: "placement";
      readonly armedAt: number;
    }
  | {
      readonly state: "consumed";
      readonly requestId: RequestId;
      readonly phase: "placement";
      readonly armedAt: number;
      readonly consumedAt: number;
    };

export type OnboardingActivationAcceptanceFaultInspection =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly fault: OnboardingActivationAcceptanceFaultRecord;
    };

type OnboardingActivationAcceptanceFaultConsumption =
  | { readonly kind: "inactive" }
  | {
      readonly kind: "consumed";
      readonly fault: VariantBy<
        OnboardingActivationAcceptanceFaultRecord,
        "state",
        "consumed"
      >;
    };

export type OnboardingActivationAcceptanceFaultError = {
  readonly code: "invalid_onboarding_activation_acceptance_fault";
};

export async function armOnboardingActivationAcceptanceFault(
  storage: OnboardingActivationAcceptanceFaultStorage,
  input: OnboardingActivationAcceptanceFaultInput,
): Promise<
  Result<
    OnboardingActivationAcceptanceFaultRecord,
    OnboardingActivationAcceptanceFaultError
  >
> {
  const record: OnboardingActivationAcceptanceFaultRecord = {
    state: "armed",
    requestId: input.requestId,
    phase: input.phase,
    armedAt: input.armedAt,
  };
  await storage.put(ONBOARDING_ACTIVATION_ACCEPTANCE_FAULT_KEY, record);
  return { ok: true, value: record };
}

export async function inspectOnboardingActivationAcceptanceFault(
  storage: OnboardingActivationAcceptanceFaultStorage,
): Promise<
  Result<
    OnboardingActivationAcceptanceFaultInspection,
    OnboardingActivationAcceptanceFaultError
  >
> {
  const raw = await storage.get(ONBOARDING_ACTIVATION_ACCEPTANCE_FAULT_KEY);
  if (raw === undefined) {
    return { ok: true, value: { kind: "absent" } };
  }
  const parsed = parseOnboardingActivationAcceptanceFaultRecord(raw);
  return parsed.ok
    ? { ok: true, value: { kind: "present", fault: parsed.value } }
    : parsed;
}

export async function consumeOnboardingActivationAcceptanceFault(
  storage: OnboardingActivationAcceptanceFaultStorage,
  consumedAt: number,
): Promise<
  Result<
    OnboardingActivationAcceptanceFaultConsumption,
    OnboardingActivationAcceptanceFaultError
  >
> {
  const inspected = await inspectOnboardingActivationAcceptanceFault(storage);
  if (!inspected.ok) {
    return inspected;
  }
  if (
    inspected.value.kind === "absent" ||
    inspected.value.fault.state === "consumed"
  ) {
    return { ok: true, value: { kind: "inactive" } };
  }
  const consumed: VariantBy<
    OnboardingActivationAcceptanceFaultRecord,
    "state",
    "consumed"
  > = {
    state: "consumed",
    requestId: inspected.value.fault.requestId,
    phase: inspected.value.fault.phase,
    armedAt: inspected.value.fault.armedAt,
    consumedAt,
  };
  await storage.put(ONBOARDING_ACTIVATION_ACCEPTANCE_FAULT_KEY, consumed);
  return { ok: true, value: { kind: "consumed", fault: consumed } };
}

export async function clearOnboardingActivationAcceptanceFault(
  storage: OnboardingActivationAcceptanceFaultStorage,
): Promise<void> {
  await storage.delete(ONBOARDING_ACTIVATION_ACCEPTANCE_FAULT_KEY);
}

function parseOnboardingActivationAcceptanceFaultRecord(
  raw: unknown,
): Result<
  OnboardingActivationAcceptanceFaultRecord,
  OnboardingActivationAcceptanceFaultError
> {
  const record = readObject(raw);
  if (
    record === null ||
    typeof record.requestId !== "string" ||
    record.phase !== "placement" ||
    !isNonNegativeInteger(record.armedAt)
  ) {
    return invalidFault();
  }
  const requestId = parseRequestId(record.requestId);
  if (!requestId.ok) {
    return invalidFault();
  }
  if (record.state === "armed") {
    return {
      ok: true,
      value: {
        state: "armed",
        requestId: requestId.value,
        phase: record.phase,
        armedAt: record.armedAt,
      },
    };
  }
  if (record.state === "consumed" && isNonNegativeInteger(record.consumedAt)) {
    return {
      ok: true,
      value: {
        state: "consumed",
        requestId: requestId.value,
        phase: record.phase,
        armedAt: record.armedAt,
        consumedAt: record.consumedAt,
      },
    };
  }
  return invalidFault();
}

function readObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : null;
}

function invalidFault(): Result<
  never,
  OnboardingActivationAcceptanceFaultError
> {
  return {
    ok: false,
    error: { code: "invalid_onboarding_activation_acceptance_fault" },
  };
}
