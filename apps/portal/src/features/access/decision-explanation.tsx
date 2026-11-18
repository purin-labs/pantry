import React from "react";
import { CircleAlert, CircleCheck, ShieldAlert, X } from "lucide-react";

import type { AccessExplainResult } from "@seams/control-api/portal/access-models";
import { modeLabel } from "./presentation";

export function ExplanationPanel(
  props: Readonly<{
    explanation: AccessExplainResult | null;
    close: () => void;
  }>,
): React.ReactNode {
  if (props.explanation === null) return null;
  const presentation = explanationPresentation(props.explanation);
  return (
    <aside
      className={`access35-explanation ${props.explanation.kind}`}
      aria-labelledby="access35-explanation-title"
    >
      <div className="access35-explanation-heading">
        <div className="access35-card-lead">
          {presentation.icon}
          <div>
            <p className="eyebrow">Decision</p>
            <h2 id="access35-explanation-title">{presentation.title}</h2>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close explanation"
          onClick={props.close}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <p>{presentation.reason}</p>
      {presentation.remediation === null ? null : (
        <p>
          <strong>Next step:</strong> {presentation.remediation}
        </p>
      )}
      <ol
        className="access35-decision-chain"
        aria-label="Ordered decision path"
      >
        {decisionChain(props.explanation).map(renderDecisionStep)}
      </ol>
      {props.explanation.kind === "allowed" ||
      props.explanation.kind === "approval_required" ? (
        <dl className="access35-card-facts">
          <div>
            <dt>Policy mode</dt>
            <dd>{modeLabel(props.explanation.policyMode)}</dd>
          </div>
          <div>
            <dt>Effective grants</dt>
            <dd>{props.explanation.effectiveGrants.length}</dd>
          </div>
        </dl>
      ) : null}
    </aside>
  );
}

function explanationPresentation(explanation: AccessExplainResult): Readonly<{
  title: string;
  reason: string;
  remediation: string | null;
  icon: React.ReactNode;
}> {
  switch (explanation.kind) {
    case "allowed":
      return {
        title: "Delivery allowed",
        reason:
          "The current grants and every selected source policy allow this destination.",
        remediation: null,
        icon: <CircleCheck aria-hidden="true" size={22} />,
      };
    case "approval_required":
      return {
        title: "Approval required",
        reason: explanation.reason,
        remediation:
          "Request approval before delivering or applying this information.",
        icon: <CircleAlert aria-hidden="true" size={22} />,
      };
    case "denied":
      return {
        title: "Delivery denied",
        reason: explanation.reason,
        remediation: explanation.remediation,
        icon: <ShieldAlert aria-hidden="true" size={22} />,
      };
    case "unavailable":
      return {
        title: "Decision unavailable",
        reason: explanation.reason,
        remediation: explanation.remediation,
        icon: <CircleAlert aria-hidden="true" size={22} />,
      };
  }
}

type DecisionStep = Readonly<{
  stage: string;
  label: string;
  status: "passed" | "decision" | "not_reached";
}>;

const DECISION_STAGES = [
  ["membership", "Current membership"],
  ["grant_selection", "Matching grants"],
  ["organisation_policy", "Organisation capability policy"],
  ["assignment", "Case assignment"],
  ["resource_lifecycle", "Connected resource"],
  ["context_admission", "Context admission"],
  ["flow_sink", "Destination policy"],
  ["approval", "Required approval"],
  ["credential_admission", "Credential admission"],
] as const;

function decisionChain(
  explanation: AccessExplainResult,
): readonly DecisionStep[] {
  const outcomeStage =
    explanation.kind === "denied" || explanation.kind === "unavailable"
      ? explanation.stage
      : explanation.kind === "approval_required"
        ? "approval"
        : null;
  const steps: DecisionStep[] = [];
  let reachedOutcome = false;
  for (const [stage, label] of DECISION_STAGES) {
    const status =
      outcomeStage === null
        ? "passed"
        : reachedOutcome
          ? "not_reached"
          : stage === outcomeStage
            ? "decision"
            : "passed";
    steps.push({ stage, label, status });
    if (stage === outcomeStage) reachedOutcome = true;
  }
  return steps;
}

function renderDecisionStep(step: DecisionStep): React.ReactNode {
  const status =
    step.status === "passed"
      ? "Satisfied or not required"
      : step.status === "decision"
        ? "Decision here"
        : "Not reached";
  return (
    <li key={step.stage}>
      <span>{step.label}</span>
      <small>{status}</small>
    </li>
  );
}
