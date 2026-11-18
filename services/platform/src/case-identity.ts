import { sha256Hex } from "@seams/std";
import { parseCaseId, type CaseId } from "./ids";

// The Case one stable identity always resolves to, and the digest its session
// and assignment identifiers are built from.
export async function deriveStableCaseId(
  stableIdentity: string,
): Promise<Readonly<{ digest: string; caseId: CaseId }> | null> {
  if (stableIdentity.length === 0) return null;
  const digest = (await sha256Hex(stableIdentity)).slice(0, 32);
  const caseId = parseCaseId(`case_${digest}`);
  return caseId.ok ? { digest, caseId: caseId.value } : null;
}
