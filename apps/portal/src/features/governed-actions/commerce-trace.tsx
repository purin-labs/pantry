import type React from "react";
import {
  Check,
  Clock,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { assertNever } from "@purin-labs/std";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  type TraceStatus,
} from "@purin-labs/ui/trace";
import type { CommerceActionRecord } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import "@purin-labs/ui/operations-trace.css";

type Props = Readonly<{
  action: CommerceActionRecord;
  change: React.ReactNode;
  controls: React.ReactNode;
}>;

/** Reuses the governed action's exact state and the owner's existing decision controls. */
export function CommerceActionTrace({
  action,
  change,
  controls,
}: Props): React.ReactNode {
  const status = actionStatus(action.state);
  const Icon = actionIcon(action.state);
  return (
    <Trace className="operations-trace" aria-label="Commerce activity">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status="completed">
            <TraceIcon>
              <Check />
            </TraceIcon>
            <TraceTitle>Proposed change recorded</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>{change}</TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon spinning={status === "running"}>
              <Icon />
            </TraceIcon>
            <TraceTitle>{actionTitle(action.state)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <p>{actionGuidance(action.state)}</p>
          <div className="operations-trace-actions">{controls}</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {action.receipt !== null && (
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine status={receiptStatus(action)}>
              <TraceIcon>
                <ShieldCheck />
              </TraceIcon>
              <TraceTitle>Provider receipt</TraceTitle>
              <TraceDescription>{action.receipt.status}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted>
            <dl className="operations-trace-facts">
              <dt>Provider</dt>
              <dd>{action.receipt.provider}</dd>
              <dt>Receipt</dt>
              <dd>{action.receipt.receiptId}</dd>
              <dt>Recorded</dt>
              <dd>
                <time dateTime={action.receipt.observedAt}>
                  {new Date(action.receipt.observedAt).toLocaleString()}
                </time>
              </dd>
            </dl>
            {action.receipt.provider === "shopify" &&
              action.receipt.jobDone === false && (
                <p>
                  The provider accepted the job. Its completion is still
                  pending.
                </p>
              )}
            {action.receipt.provider === "commerce" &&
              action.receipt.projectionKind === "commerce_order" && (
                <p>
                  Refund attempt {action.receipt.providerResource.id} was
                  recorded. Payment settlement follows the provider’s records.
                </p>
              )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </Trace>
  );
}

function receiptStatus(action: CommerceActionRecord): TraceStatus {
  if (action.state === "indeterminate") return "pending";
  if (action.receipt?.status === "failed") return "error";
  if (action.receipt?.status === "indeterminate") return "pending";
  return "completed";
}
function actionStatus(state: CommerceActionRecord["state"]): TraceStatus {
  switch (state) {
    case "executing":
      return "running";
    case "confirmed":
      return "completed";
    case "failed":
      return "error";
    case "proposed":
    case "approval_requested":
    case "signed":
    case "rejected":
    case "expired":
    case "indeterminate":
      return "pending";
    default:
      return assertNever(state);
  }
}
function actionIcon(state: CommerceActionRecord["state"]): typeof Check {
  switch (state) {
    case "executing":
      return LoaderCircle;
    case "confirmed":
      return Check;
    case "failed":
    case "indeterminate":
      return TriangleAlert;
    case "signed":
      return ShieldCheck;
    case "proposed":
    case "approval_requested":
    case "rejected":
    case "expired":
      return Clock;
    default:
      return assertNever(state);
  }
}
function actionTitle(state: CommerceActionRecord["state"]): string {
  switch (state) {
    case "proposed":
    case "approval_requested":
      return "Awaiting your approval";
    case "signed":
      return "Approved · ready to apply";
    case "executing":
      return "Apply the approved change";
    case "confirmed":
      return "Change accepted by the commerce system";
    case "failed":
      return "Change failed";
    case "rejected":
      return "Change declined";
    case "expired":
      return "Approval expired";
    case "indeterminate":
      return "Outcome unknown";
    default:
      return assertNever(state);
  }
}
function actionGuidance(state: CommerceActionRecord["state"]): string {
  switch (state) {
    case "proposed":
    case "approval_requested":
      return "Review the exact change above. Approval authorizes Purin Pantry to apply it to the connected commerce system.";
    case "signed":
      return "This change is approved and ready to run.";
    case "executing":
      return "The approved change is in progress. Await the recorded outcome.";
    case "confirmed":
      return "The commerce system accepted this change. This state does not confirm a separate customer notification.";
    case "failed":
      return "The recorded action failed. Review its details before you propose another change.";
    case "rejected":
      return "The proposal was declined. This approval does not authorize execution.";
    case "expired":
      return "This approval is no longer valid. Review a new proposal before execution.";
    case "indeterminate":
      return "The provider outcome is unknown. Reconciliation checks the existing action and retries only if the provider confirms no effect occurred.";
    default:
      return assertNever(state);
  }
}
