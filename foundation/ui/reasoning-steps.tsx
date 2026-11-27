import React from "react";
import { Check, Circle, CircleAlert, Pause, X } from "lucide-react";
import "./agent-components.css";
import { assertNever } from "@purin-labs/std";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "./trace";

export type ReasoningStep = {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly state:
    "pending" | "running" | "completed" | "waiting" | "failed" | "cancelled";
};

type ReasoningStepsProps = {
  readonly steps: readonly ReasoningStep[];
  readonly summary: string;
  readonly defaultOpen?: boolean;
};

export function ResponseIndicator(props: {
  readonly state: "running" | "waiting";
  readonly label: string;
}): React.ReactNode {
  return (
    <div className="response-indicator" role="status" aria-atomic="true">
      <StepIcon state={props.state} />
      <span
        className={props.state === "running" ? "activity-shimmer" : undefined}
      >
        {props.label}
      </span>
    </div>
  );
}

export function ReasoningSteps(props: ReasoningStepsProps): React.ReactNode {
  if (props.steps.length === 0) return null;
  const current =
    props.steps.find(hasStepState.bind(null, "failed")) ??
    props.steps.find(hasStepState.bind(null, "running")) ??
    props.steps.find(hasStepState.bind(null, "waiting")) ??
    props.steps.find(hasStepState.bind(null, "pending")) ??
    props.steps.at(-1);
  return (
    <Trace className="reasoning-steps">
      <TraceCollapsible defaultOpen={props.defaultOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={current ? traceStatus(current.state) : "completed"}
          >
            <TraceIcon>
              {current && <StepIcon state={current.state} />}
            </TraceIcon>
            <TraceTitle>{props.summary}</TraceTitle>
            {current && (
              <span className="agent-ui-sr-only">
                {stepLabel(current.state)}
              </span>
            )}
            <TraceDescription>
              {props.steps.length} {props.steps.length === 1 ? "step" : "steps"}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <Trace>{props.steps.map(renderStep)}</Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function hasStepState(
  state: ReasoningStep["state"],
  step: ReasoningStep,
): boolean {
  return step.state === state;
}

function renderStep(step: ReasoningStep): React.ReactNode {
  const line = (
    <TraceLine status={traceStatus(step.state)}>
      <TraceIcon>
        <StepIcon state={step.state} />
      </TraceIcon>
      <TraceTitle>{step.label}</TraceTitle>
      <span className="agent-ui-sr-only">{stepLabel(step.state)}</span>
    </TraceLine>
  );
  if (!step.detail)
    return <React.Fragment key={step.id}>{line}</React.Fragment>;
  return (
    <TraceCollapsible key={step.id}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <p>{step.detail}</p>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function traceStatus(state: ReasoningStep["state"]): TraceStatus {
  switch (state) {
    case "running":
      return "running";
    case "failed":
      return "error";
    case "completed":
      return "completed";
    case "waiting":
    case "cancelled":
    case "pending":
      return "pending";
    default:
      return assertNever(state, "Unknown step state");
  }
}

function StepIcon(props: {
  readonly state: ReasoningStep["state"];
}): React.ReactNode {
  if (props.state === "running")
    return (
      <span className="reasoning-loader" aria-hidden="true">
        {Array.from({ length: 9 }, renderLoaderDot)}
      </span>
    );
  const Icon = stepIcon(props.state);
  return <Icon size={16} aria-hidden="true" />;
}

function renderLoaderDot(_: unknown, index: number): React.ReactNode {
  return <span key={index} />;
}

function stepIcon(
  state: Exclude<ReasoningStep["state"], "running">,
): typeof Circle {
  switch (state) {
    case "pending":
      return Circle;
    case "completed":
      return Check;
    case "waiting":
      return Pause;
    case "failed":
      return CircleAlert;
    case "cancelled":
      return X;
    default:
      return assertNever(state, "Unknown step state");
  }
}

function stepLabel(state: ReasoningStep["state"]): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "running":
      return "Working";
    case "completed":
      return "Completed";
    case "waiting":
      return "Waiting";
    case "failed":
      return "Needs attention";
    case "cancelled":
      return "Cancelled";
    default:
      return assertNever(state, "Unknown step state");
  }
}
