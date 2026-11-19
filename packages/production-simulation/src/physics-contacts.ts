import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

export type ContactShape = Readonly<{ geometry: string; body: string }>;
export type ContactPair = Readonly<{
  first: ContactShape;
  second: ContactShape;
  normalForceN: number;
  penetrationM: number;
}>;
export type ContactObservation = Readonly<{
  step: number;
  pairs: readonly ContactPair[];
}>;
export type OperationContacts = StrictUnion<
  | Readonly<{ kind: "not-recorded" }>
  | Readonly<{ kind: "dense"; observations: readonly ContactObservation[] }>
>;

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid recorded contact evidence.");
}
function shape(raw: unknown): ContactShape {
  requireValue(
    isRecord(raw) &&
      hasExactKeys(raw, ["geometry", "body"]) &&
      typeof raw.geometry === "string" &&
      raw.geometry.length > 0 &&
      raw.geometry.length <= 256 &&
      typeof raw.body === "string" &&
      raw.body.length > 0 &&
      raw.body.length <= 256,
  );
  return { geometry: raw.geometry, body: raw.body };
}
function shapeId(shape: ContactShape): string {
  return `${shape.geometry}\0${shape.body}`;
}

/** One segment owns contact evidence for each newly executed solver step. */
export function readOperationContacts(
  raw: unknown,
  start: number,
  end: number,
): OperationContacts {
  requireValue(
    isNonNegativeInteger(start) &&
      isNonNegativeInteger(end) &&
      end >= start &&
      end - start <= 32 &&
      isRecord(raw),
  );
  if (raw.kind === "not-recorded") {
    requireValue(hasExactKeys(raw, ["kind"]));
    return { kind: "not-recorded" };
  }
  requireValue(
    raw.kind === "dense" &&
      hasExactKeys(raw, ["kind", "observations"]) &&
      Array.isArray(raw.observations) &&
      raw.observations.length === end - start,
  );
  const observations: ContactObservation[] = [];
  for (const [index, observation] of raw.observations.entries()) {
    requireValue(
      isRecord(observation) &&
        hasExactKeys(observation, ["step", "pairs"]) &&
        observation.step === start + index + 1 &&
        Array.isArray(observation.pairs) &&
        observation.pairs.length <= 1024,
    );
    const pairs: ContactPair[] = [];
    let previous = "";
    for (const rawPair of observation.pairs) {
      requireValue(
        isRecord(rawPair) &&
          hasExactKeys(rawPair, [
            "first",
            "second",
            "normalForceN",
            "penetrationM",
          ]),
      );
      const first = shape(rawPair.first);
      const second = shape(rawPair.second);
      const identity = `${shapeId(first)}\0${shapeId(second)}`;
      requireValue(
        shapeId(first) < shapeId(second) &&
          previous < identity &&
          typeof rawPair.normalForceN === "number" &&
          Number.isFinite(rawPair.normalForceN) &&
          rawPair.normalForceN >= 0 &&
          typeof rawPair.penetrationM === "number" &&
          Number.isFinite(rawPair.penetrationM) &&
          rawPair.penetrationM > 0,
      );
      pairs.push({
        first,
        second,
        normalForceN: rawPair.normalForceN,
        penetrationM: rawPair.penetrationM,
      });
      previous = identity;
    }
    observations.push({ step: observation.step, pairs });
  }
  return { kind: "dense", observations };
}

/** An exact step has evidence only when a recorded observation names it. */
export function contactsAtStep(
  contacts: OperationContacts,
  step: number,
): ContactObservation | null {
  if (contacts.kind === "not-recorded" || contacts.observations.length === 0)
    return null;
  const first = contacts.observations[0];
  if (first === undefined) return null;
  const observation = contacts.observations[step - first.step];
  return observation?.step === step ? observation : null;
}
