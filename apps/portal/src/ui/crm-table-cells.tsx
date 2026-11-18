import React from "react";
import "./crm-table.css";

export function CrmIdentity(props: {
  readonly label: string;
  readonly icon?: React.ReactNode;
}): React.ReactNode {
  return (
    <span className="crm-identity">
      <span className="crm-avatar" aria-hidden="true">
        {props.icon ?? props.label.slice(0, 1).toLocaleUpperCase()}
      </span>
      <span title={props.label}>{props.label}</span>
    </span>
  );
}
export function CrmTag(props: {
  readonly children: React.ReactNode;
  readonly tone?: "neutral" | "positive" | "warning" | "info" | "negative";
}): React.ReactNode {
  return (
    <span className="crm-tag" data-tone={props.tone ?? "neutral"}>
      {props.children}
    </span>
  );
}
export function CrmProgress(props: {
  readonly value: number;
  readonly label: string;
}): React.ReactNode {
  const value = Number.isFinite(props.value)
    ? Math.min(100, Math.max(0, props.value))
    : 0;
  return (
    <span className="crm-progress">
      <progress max={100} value={value} aria-label={props.label} />
      <span>{Math.round(value)}%</span>
    </span>
  );
}
export function CrmSparkline(props: {
  readonly values: readonly number[];
  readonly label: string;
}): React.ReactNode {
  const values = props.values.filter(Number.isFinite);
  if (values.length < 2)
    return <span aria-label={`${props.label}: not enough data`}>—</span>;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const points: string[] = [];
  for (const [index, value] of values.entries())
    points.push(
      `${2 + (index / (values.length - 1)) * 86},${22 - ((value - min) / range) * 20}`,
    );
  return (
    <svg
      className="crm-trend"
      viewBox="0 0 90 24"
      role="img"
      aria-label={props.label}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
