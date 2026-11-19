import React from "react";
import type { ChatApproval, ChatReceiptReference } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import { Clock, ShieldCheck } from "lucide-react";
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
} from "../../ui/trace";
import "../../ui/operations-trace.css";

export function ChatApprovalTrace({
  approval,
  inherited,
}: {
  readonly approval: ChatApproval;
  readonly inherited: boolean;
}): React.ReactNode {
  return (
    <Trace className="operations-trace" aria-label="Action approval">
      <TraceCollapsible defaultOpen={approval.kind === "requested"}>
        <TraceCollapsibleTrigger>
          <TraceLine status={approvalStatus(approval)}>
            <TraceIcon>
              <Clock />
            </TraceIcon>
            <TraceTitle>
              {approval.kind === "requested"
                ? approval.operation
                : "Approval decision"}
            </TraceTitle>
            <TraceDescription>{approvalLabel(approval)}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          {approval.kind === "requested" ? (
            <>
              <p>
                {approval.effect} · {approval.destination}
              </p>
              <dl className="operations-trace-facts">
                {Object.entries(approval.fields).map(renderField)}
              </dl>
              <p>
                Expires{" "}
                <time dateTime={new Date(approval.expiresAt).toISOString()}>
                  {new Date(approval.expiresAt).toLocaleString()}
                </time>
                .
              </p>
            </>
          ) : (
            <p>
              Decision recorded{" "}
              <time dateTime={new Date(approval.settledAt).toISOString()}>
                {new Date(approval.settledAt).toLocaleString()}
              </time>
              .
            </p>
          )}
          <p>
            {inherited
              ? "Historical approval from the source chat. New actions need their own approval."
              : "Review the current action in its integration review. This entry records the approval event."}
          </p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

export function ChatReceiptTrace({
  receipt,
}: {
  readonly receipt: ChatReceiptReference;
}): React.ReactNode {
  return (
    <Trace className="operations-trace" aria-label="Action receipt">
      <TraceCollapsible
        defaultOpen={
          receipt.state === "failed" ||
          receipt.state === "reconciliation_required"
        }
      >
        <TraceCollapsibleTrigger>
          <TraceLine status={receiptStatus(receipt.state)}>
            <TraceIcon>
              <ShieldCheck />
            </TraceIcon>
            <TraceTitle>{receiptLabel(receipt.state)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <p>{receipt.summary}</p>
          <dl className="operations-trace-facts">
            <dt>Receipt</dt>
            <dd>{receipt.receiptId}</dd>
          </dl>
          {receipt.state === "reconciliation_required" && (
            <p>
              The recorded outcome is unknown. Reconcile this action before
              another attempt.
            </p>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
function renderField(entry: readonly [string, string]): React.ReactNode {
  return (
    <React.Fragment key={entry[0]}>
      <dt>{entry[0]}</dt>
      <dd>{entry[1]}</dd>
    </React.Fragment>
  );
}
function approvalStatus(approval: ChatApproval): TraceStatus {
  if (approval.kind === "requested") return "pending";
  switch (approval.outcome) {
    case "allowed_once":
    case "always_allowed":
      return "completed";
    case "denied":
    case "expired":
      return "pending";
    case "failed":
      return "error";
    default:
      return assertNever(approval.outcome);
  }
}
function approvalLabel(approval: ChatApproval): string {
  if (approval.kind === "requested") return "Approval requested";
  switch (approval.outcome) {
    case "allowed_once":
      return "Approved once";
    case "always_allowed":
      return "Always allowed";
    case "denied":
      return "Declined";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
    default:
      return assertNever(approval.outcome);
  }
}
function receiptStatus(state: ChatReceiptReference["state"]): TraceStatus {
  switch (state) {
    case "pending":
    case "reconciliation_required":
      return "pending";
    case "succeeded":
      return "completed";
    case "failed":
      return "error";
    default:
      return assertNever(state);
  }
}
function receiptLabel(state: ChatReceiptReference["state"]): string {
  switch (state) {
    case "pending":
      return "Receipt pending";
    case "succeeded":
      return "Action receipt recorded";
    case "failed":
      return "Action failed";
    case "reconciliation_required":
      return "Outcome unknown";
    default:
      return assertNever(state);
  }
}
