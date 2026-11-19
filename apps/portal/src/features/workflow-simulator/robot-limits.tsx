import React from "react";
import type { MarginSummary } from "@purin-labs/bakery-model/bakery-margins";
import "./robot-limits.css";

/**
 * One operation's margins against the robot's rated limits (Refactor 16,
 * step 7): the joint with the least speed margin, the longest time at a
 * torque limit, the deepest contact, the grip slip, and one line for each
 * warning or failure. An older engine measured nothing.
 */
export function RobotLimits(
  props: Readonly<{ margins: MarginSummary }>,
): React.ReactNode {
  const margins = props.margins;
  if (margins.kind === "not-measured")
    return <span className="robot-limits-muted">Not measured</span>;
  const joint = margins.tightestJoint;
  const clamp = margins.longestClamp;
  return (
    <div className="robot-limits" data-verdict={margins.verdict}>
      <p>
        Least speed margin: {joint.joint} at{" "}
        {joint.ratedSpeedRadS === null
          ? `${joint.peakSpeedRadS.toFixed(2)} rad/s (no rated value)`
          : `${percent(joint.peakSpeedRadS / joint.ratedSpeedRadS)} of its rated speed (${joint.peakSpeedRadS.toFixed(2)} of ${joint.ratedSpeedRadS.toFixed(2)} rad/s)`}
      </p>
      <p>
        At a torque limit:{" "}
        {clamp.seconds === 0
          ? "never"
          : `${clamp.joint}, ${Math.round(clamp.seconds * 1000)} ms at ${Math.round(clamp.clampNm)} N·m`}
        {clamp.ratedTorqueNm === null &&
          ` (no rated torque; the ${Math.round(clamp.clampNm)} N·m limit is a simulation value)`}
      </p>
      <p>
        Deepest contact: {millimetres(margins.peakPenetrationM)} mm
        {margins.deepestContact !== null &&
          ` (${margins.deepestContact.join(" on ")})`}{" "}
        · Grip slip: {millimetres(margins.peakSlipM)} mm
      </p>
      {margins.lines.length === 0 ? (
        <p className="robot-limits-verdict">Within the robot's limits.</p>
      ) : (
        margins.lines.map(verdictLine)
      )}
    </div>
  );
}

function verdictLine(line: string): React.ReactNode {
  return (
    <p key={line} className="robot-limits-verdict">
      {line}
    </p>
  );
}

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function millimetres(metres: number): string {
  return (metres * 1000).toFixed(1);
}
