import type {
  CueSource,
  NormalizedCueEvent,
  NormalizedCueEventType,
} from "./engine";
import type { OrganisationId } from "../ids";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";

export type IgnoredCueSample = {
  nativeId: string;
  at: number;
};

export type IgnoredCueAggregate = {
  organisationId: OrganisationId;
  source: CueSource;
  eventType: NormalizedCueEventType;
  hourStartedAt: number;
  count: number;
  samples: readonly IgnoredCueSample[];
  updatedAt: number;
};

export type IgnoredCueKv = {
  get(key: string, type: "json"): Promise<unknown | null>;
  put(
    key: string,
    value: string,
    options: { expirationTtl: number },
  ): Promise<void>;
};

const HOUR_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 3;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function addIgnoredCueToBatch(
  batch: Map<string, IgnoredCueAggregate>,
  event: NormalizedCueEvent,
  now: number,
): void {
  const hourStartedAt = Math.floor(now / HOUR_MS) * HOUR_MS;
  const key = ignoredCueAggregateKey(
    event.organisationId,
    event.source,
    event.eventType,
    hourStartedAt,
  );
  const current = batch.get(key);
  const sample = { nativeId: event.nativeId, at: event.at };

  if (current === undefined) {
    batch.set(key, {
      organisationId: event.organisationId,
      source: event.source,
      eventType: event.eventType,
      hourStartedAt,
      count: 1,
      samples: [sample],
      updatedAt: now,
    });
    return;
  }

  batch.set(key, {
    organisationId: current.organisationId,
    source: current.source,
    eventType: current.eventType,
    hourStartedAt: current.hourStartedAt,
    count: current.count + 1,
    samples: appendBoundedSample(current.samples, sample),
    updatedAt: now,
  });
}

export async function flushIgnoredCueBatch(
  kv: IgnoredCueKv,
  batch: ReadonlyMap<string, IgnoredCueAggregate>,
): Promise<void> {
  for (const [key, aggregate] of batch) {
    const raw = await kv.get(key, "json");
    const existing = parseIgnoredCueAggregate(raw, aggregate);
    const merged = mergeIgnoredCueAggregates(existing, aggregate);
    await kv.put(key, JSON.stringify(merged), {
      expirationTtl: RETENTION_SECONDS,
    });
  }
}

function ignoredCueAggregateKey(
  organisationId: OrganisationId,
  source: CueSource,
  eventType: NormalizedCueEventType,
  hourStartedAt: number,
): string {
  return `cue-ignore:${organisationId}:${source}:${eventType}:${hourStartedAt}`;
}

function parseIgnoredCueAggregate(
  raw: unknown,
  expected: IgnoredCueAggregate,
): IgnoredCueAggregate | null {
  if (
    !isRecord(raw) ||
    raw.organisationId !== expected.organisationId ||
    raw.source !== expected.source ||
    raw.eventType !== expected.eventType ||
    raw.hourStartedAt !== expected.hourStartedAt ||
    !isPositiveInteger(raw.count) ||
    !Array.isArray(raw.samples) ||
    !isNonNegativeInteger(raw.updatedAt)
  ) {
    return null;
  }

  const samples: IgnoredCueSample[] = [];

  for (const value of raw.samples) {
    if (
      !isRecord(value) ||
      typeof value.nativeId !== "string" ||
      !isNonNegativeInteger(value.at)
    ) {
      return null;
    }

    if (samples.length < MAX_SAMPLES) {
      samples.push({ nativeId: value.nativeId, at: value.at });
    }
  }

  return {
    organisationId: expected.organisationId,
    source: expected.source,
    eventType: expected.eventType,
    hourStartedAt: expected.hourStartedAt,
    count: raw.count,
    samples,
    updatedAt: raw.updatedAt,
  };
}

function mergeIgnoredCueAggregates(
  existing: IgnoredCueAggregate | null,
  incoming: IgnoredCueAggregate,
): IgnoredCueAggregate {
  if (existing === null) {
    return incoming;
  }

  let samples = existing.samples;

  for (const sample of incoming.samples) {
    samples = appendBoundedSample(samples, sample);
  }

  return {
    organisationId: incoming.organisationId,
    source: incoming.source,
    eventType: incoming.eventType,
    hourStartedAt: incoming.hourStartedAt,
    count: existing.count + incoming.count,
    samples,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function appendBoundedSample(
  samples: readonly IgnoredCueSample[],
  candidate: IgnoredCueSample,
): readonly IgnoredCueSample[] {
  if (
    samples.length >= MAX_SAMPLES ||
    includesNativeId(samples, candidate.nativeId)
  ) {
    return samples;
  }

  return [...samples, candidate];
}

function includesNativeId(
  samples: readonly IgnoredCueSample[],
  nativeId: string,
): boolean {
  for (const sample of samples) {
    if (sample.nativeId === nativeId) {
      return true;
    }
  }

  return false;
}
