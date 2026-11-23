import {
  runOngoingCaseTurn,
  type AdmittedCaseTurn,
  type OngoingCaseTurnInput,
} from "@purin-labs/conversation/actors/case-walking-path";
import type { CaseSnapshot } from "@purin-labs/conversation/actors/case/types";

declare const snapshot: CaseSnapshot;
declare const input: OngoingCaseTurnInput;

// @ts-expect-error A snapshot alone does not establish trigger admission.
const forged: AdmittedCaseTurn = { snapshot, ingressId: "ingress" };

const { admittedCase, ...unadmitted } = input;
// @ts-expect-error Execution requires the result of durable admission.
void runOngoingCaseTurn(unadmitted);
// @ts-expect-error Broad input composition cannot substitute a raw snapshot.
void runOngoingCaseTurn({ ...input, admittedCase: snapshot });

void forged;
void admittedCase;
