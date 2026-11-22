import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { http } from "msw";
import { isRecord } from "@purin-labs/std";
import { network } from "./network";
import { ORGANISATION_ID, openRouterText } from "./slack-journey-support";
import { commerceHeaders } from "./commerce-support";
import {
  requireActiveOrganisationActor,
  requireActiveSessionActor,
} from "../../src/actors/actor-router";
import { parseSessionId } from "@purin-labs/kernel/ids";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import type { UserId } from "@purin-labs/control-api/ids";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

type Counter = {
  calls: number;
  restore: (() => void)[];
  targets: WeakSet<object>;
};
const probes = new WeakMap<object, { counter: Counter; method: Function }>();
type Viewer = { session: IssuedControlSession; cursor: string };
export async function measureCanvasRefresh(
  session: IssuedControlSession,
  documentId: string,
  conversationId: string,
  viewerUserId: UserId,
) {
  const url = `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/chat`;
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", longReply),
  );
  for (let turn = 0; turn < 12; turn += 1) {
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?canvas=${encodeURIComponent(documentId)}`,
      {
        method: "POST",
        headers: commerceHeaders(session),
        body: JSON.stringify({
          kind: "message",
          conversationId,
          requestId: `refresh_${turn}`,
          model: PLATFORM_DEFAULT_PI_MODEL,
          text: `Explain recipe checkpoint ${turn}`,
          browserContext: { kind: "unavailable" },
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await expect
      .poll(read.bind(null, session, url), { timeout: 20_000 })
      .toMatchObject({
        kind: "ready",
        conversation: { work: { kind: "ready" } },
      });
  }
  const sessions: IssuedControlSession[] = [];
  for (let index = 0; index < 4; index += 1) {
    sessions.push(
      await issueControlSession({
        db: env.DB,
        userId: viewerUserId,
        now: Date.now(),
        ttlMs: 1_800_000,
      }),
    );
  }
  const history: Counter = {
    calls: 0,
    restore: [],
    targets: new WeakSet<object>(),
  };
  const archive: Counter = {
    calls: 0,
    restore: [],
    targets: new WeakSet<object>(),
  };
  const rows = await fixtureDatabase()
    .prepare(
      "SELECT logical_object_id AS object_id FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .all<{ object_id: string }>();
  for (const row of rows.results) {
    const id = parseSessionId(row.object_id);
    if (!id.ok) throw new Error(id.error.code);
    const actor = await requireActiveSessionActor({
      env,
      organisationId: ORGANISATION_ID,
      sessionId: id.value,
      now: Date.now(),
    });
    await runInDurableObject(actor, instrumentHistory.bind(null, history));
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  await runInDurableObject(organisation, instrumentArchive.bind(null, archive));
  try {
    const viewers: Viewer[] = [];
    let fullBytes = 0;
    const fullStart = Date.now();
    for (const peer of sessions) {
      const page = await read(peer, url);
      if (
        !isRecord(page) ||
        page.kind !== "ready" ||
        typeof page.cursor !== "string"
      )
        throw new Error(
          `Missing initial viewer projection: ${JSON.stringify(page)}`,
        );
      viewers.push({ session: peer, cursor: page.cursor });
      fullBytes += new TextEncoder().encode(JSON.stringify(page)).length;
    }
    const fullMs = Date.now() - fullStart;
    const fullHistoryReads = history.calls;
    expect(fullHistoryReads).toBeGreaterThan(0);
    history.calls = 0;
    archive.calls = 0;
    const durations: number[] = [];
    let refreshBytes = 0;
    for (let round = 0; round < 10; round += 1) {
      const results = await Promise.all(
        viewers.map(timedRefresh.bind(null, url)),
      );
      for (const result of results) {
        durations.push(result.ms);
        refreshBytes += result.bytes;
      }
    }
    expect(history.calls).toBe(0);
    expect(archive.calls).toBe(0);
    durations.sort(compareNumber);
    const evidence = {
      viewerSessions: viewers.length,
      viewerIdentities: 1,
      completedExtraTurns: 12,
      fullReads: {
        requests: viewers.length,
        ms: fullMs,
        bytes: fullBytes,
        historyCalls: fullHistoryReads,
      },
      unchanged: {
        requests: durations.length,
        bytes: refreshBytes,
        medianMs: durations[Math.floor(durations.length / 2)],
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        historyCalls: history.calls,
        archiveGets: archive.calls,
      },
    };
    console.log("CANVAS_REFRESH_EVIDENCE", JSON.stringify(evidence));
    return evidence;
  } finally {
    for (const restore of [...history.restore, ...archive.restore].reverse())
      restore();
  }
}
function longReply(): Response {
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text: "Keep the accepted recipe checkpoints and ingredient custody in view. ".repeat(
        40,
      ),
    }),
    "refresh_reply",
  );
}
async function read(
  session: IssuedControlSession,
  url: string,
): Promise<unknown> {
  const response = await exports.default.fetch(url, {
    headers: commerceHeaders(session),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function timedRefresh(url: string, viewer: Viewer) {
  const start = Date.now();
  const result = await read(viewer.session, `${url}?after=${viewer.cursor}`);
  expect(result).toEqual({ kind: "unchanged" });
  return {
    ms: Date.now() - start,
    bytes: new TextEncoder().encode(JSON.stringify(result)).length,
  };
}
function compareNumber(a: number, b: number): number {
  return a - b;
}
function instrumentHistory(counter: Counter, actor: object): void {
  instrument(counter, Object.getPrototypeOf(actor), "readCompletedChatHistory");
}
function instrumentArchive(counter: Counter, actor: object): void {
  instrument(counter, Reflect.get(Reflect.get(actor, "env"), "ARCHIVE"), "get");
}
function instrument(counter: Counter, target: object, key: string): void {
  if (counter.targets.has(target)) return;
  counter.targets.add(target);
  const method: unknown = Reflect.get(target, key);
  if (typeof method !== "function") throw new Error(`Missing ${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  probes.set(target, { counter, method });
  Object.defineProperty(target, key, { configurable: true, value: counted });
  counter.restore.push(restoreMethod.bind(null, target, key, descriptor));
}
function counted(this: object, ...args: unknown[]): unknown {
  const probe = probes.get(this) ?? probes.get(Object.getPrototypeOf(this));
  if (probe === undefined) throw new Error("Missing method probe");
  probe.counter.calls += 1;
  return Reflect.apply(probe.method, this, args);
}
function restoreMethod(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  probes.delete(target);
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}
