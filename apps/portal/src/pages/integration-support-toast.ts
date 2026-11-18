import { toast } from "sonner";

import { providerLabel } from "../integration-catalogue";
import type { SupportDiagnostics } from "@seams/control-api/portal/settings";

/**
 * Every integration dialog reads the organisation's newest open support
 * reference, whichever provider it belongs to. A provider's failure is news
 * only in that provider's own dialog: an old Stripe Connect failure must not
 * appear when the owner opens the AI account. An activation failure has no
 * provider and belongs to every dialog.
 */
export function ownSupportDiagnostics(
  diagnostics: SupportDiagnostics | null,
  active: { readonly id: string } | null,
): SupportDiagnostics | null {
  if (diagnostics === null || diagnostics.provider === null) return diagnostics;
  return active?.id === diagnostics.provider ? diagnostics : null;
}

/**
 * Activation failures are support material, not page furniture: the full fact
 * sheet goes to the console for a bug report, and the toast carries the one
 * thing worth retyping: the support reference.
 */
export function announceSupportDiagnostics(
  diagnostics: SupportDiagnostics | null,
): void {
  if (diagnostics === null) return;
  console.error("[activation] Support diagnostics", {
    reference: diagnostics.supportReference,
    provider: diagnostics.provider,
    account: diagnostics.displayAccount,
    reason: diagnostics.reasonCode,
    occurredAt: new Date(diagnostics.occurredAt).toISOString(),
    retry: diagnostics.retryStatus,
    lastSuccessfulPhase: diagnostics.lastSuccessfulPhase,
    webhooks: diagnostics.webhookHealth,
    projectionRevision: diagnostics.projectionRevision,
  });
  toast.error(
    diagnostics.provider === null
      ? `Activation needs support. Quote reference ${diagnostics.supportReference} — it stays visible above the setup checklist.`
      : `${providerLabel(diagnostics.provider)} could not be connected. Support reference ${diagnostics.supportReference}.`,
  );
}
