import {
  OUTAGE_WORKCELL_RESOURCES,
  handlingTaskId,
  type OutageResource,
} from "@purin-labs/production-simulation/recipes/bakery/run-faults";

// The fault inputs of the production workspace: an absent resource, a failed
// handling task and a time in whole seconds, read from their form values.

export function outageChoice(value: string): OutageResource | null {
  if (/^human-[1-9][0-9]*$/.test(value))
    return `human-${Number(value.slice(6))}`;
  for (const resource of OUTAGE_WORKCELL_RESOURCES)
    if (resource === value) return resource;
  return null;
}
export function handlingChoice(
  value: string,
): ReturnType<typeof handlingTaskId> | null {
  const match = /^batch:([A-P]):handoff:([0-9]+)-(stage|clear|transfer)$/.exec(
    value,
  );
  if (match === null) return null;
  return handlingTaskId(
    match[1] ?? "",
    Number(match[2]),
    match[3] === "transfer"
      ? "transfer"
      : match[3] === "stage"
        ? "stage"
        : "clear",
  );
}
export function wholeSeconds(value: string): number | null {
  const seconds = Number(value);
  return value.trim() !== "" && Number.isInteger(seconds) && seconds >= 0
    ? seconds
    : null;
}
