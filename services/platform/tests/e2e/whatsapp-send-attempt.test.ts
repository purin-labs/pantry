import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { resolveActiveConnectorActor } from "../../src/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import { armConnectorAlarm } from "../../src/actors/connector/alarm";
import {
  latestWhatsAppProposal,
  readWhatsAppRuntime,
} from "../../src/actors/connector-whatsapp";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { ORGANISATION_ID } from "./slack-journey-support";
import {
  installFixture,
  MESSAGE_ID,
  PHONE_NUMBER_ID,
  PROPOSAL_ID,
  recordAgentDraft,
  REPLY,
  type Fixture,
} from "./whatsapp-connector-support";

/**
 * Refactor 15, refactor 13: the WhatsApp reply proposal after its approval.
 * Meta is a fake that records each message and answers it; it holds the
 * first message until the journey releases it, so that the journey can stop
 * the Connector, revoke the proposal or end its approval time during the
 * call. The customer must never get a second reply, and a proposal that
 * another writer ended during the call stays ended.
 */

const NEXT_PROPOSAL_ID = "proposal_p55_whatsapp_next";
const NEXT_REPLY = "Your order is ready, and we added a free cookie.";
const HOUR_MS = 3_600_000;

type Meta = {
  readonly answer: "accepted" | "rejected";
  readonly messages: string[];
  phase: "armed" | "holding" | "released";
};

it(
  "fences a WhatsApp reply whose Connector stopped during the Meta call, and sends no second reply",
  { timeout: 60_000 },
  stoppedConnectorJourney,
);

async function stoppedConnectorJourney({ task }: TestContext): Promise<void> {
  const fixture = await installFixture();
  // The agent's proposal arms the alarm for its approval time.
  await runInDurableObject(fixture.connector, armAlarm);
  const meta: Meta = { answer: "accepted", messages: [], phase: "armed" };
  network.use(
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      answerMeta.bind(null, meta),
    ),
  );
  const approval = await approvalFor(fixture);
  const first = settle(fixture.connector.dispatchWhatsAppReply(approval));
  try {
    await expect
      .poll(metaPhase.bind(null, meta), { timeout: 15_000 })
      .toBe("holding");
    // The Connector stops while Meta holds the message: nobody can say now
    // whether the customer got it.
    await runInDurableObject(fixture.connector, stopInstance).catch(
      ignoreStoppedInstance,
    );
    meta.phase = "released";
    const stopped = await first;
    expect(stopped).not.toMatchObject({ ok: true, value: { kind: "sent" } });
    const connector = await nextConnector(fixture);
    // Two hours pass, so the proposal's approval time has ended.
    await runInDurableObject(connector, ageProposals);
    expect(await runDurableObjectAlarm(connector)).toBe(true);
    const fenced = await runInDurableObject(connector, readConnector);
    expect(fenced.proposalState).toBe("send_indeterminate");
    expect(fenced.processing).toMatchObject({
      kind: "paused",
      reason: { kind: "send_indeterminate", proposalId: PROPOSAL_ID },
    });
    expect(fenced.body).toBeNull();
    // The operator is told once, and only the operator can end the fence.
    expect(fenced.notices).toBe(1);
    // The agent's next draft for the same customer waits for the operator.
    const nextDigest = await runInDurableObject(
      connector,
      recordAgentDraft.bind(null, fixture, NEXT_PROPOSAL_ID, NEXT_REPLY),
    );
    const nextApproval = {
      ...approval,
      proposalId: NEXT_PROPOSAL_ID,
      approvedVersion: 1,
      approvedBodyDigest: nextDigest,
    };
    expect(await connector.dispatchWhatsAppReply(nextApproval)).toMatchObject({
      ok: false,
      error: { code: "connector_whatsapp_case_fenced" },
    });
    expect(await connector.dispatchWhatsAppReply(approval)).toMatchObject({
      ok: false,
      error: { code: "connector_whatsapp_case_fenced" },
    });
    expect(meta.messages).toEqual([REPLY]);
    Object.assign(task.meta, {
      whatsappStoppedSend: {
        proposalState: fenced.proposalState,
        accountFenced: true,
        operatorNotices: fenced.notices,
        messagesToCustomer: meta.messages.length,
        liveProviderAcceptance: false,
      },
    });
  } finally {
    meta.phase = "released";
    await first;
  }
}

it.for(["revoked", "expired"] as const)(
  "keeps a WhatsApp proposal %s during the Meta call, and records no reply over it",
  { timeout: 60_000 },
  movedDuringSendJourney,
);

async function movedDuringSendJourney(
  move: "revoked" | "expired",
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  // A revoke races a message that Meta takes; an expiry races a message that
  // Meta refuses, which would otherwise wait for approval again.
  const meta: Meta = {
    answer: move === "revoked" ? "accepted" : "rejected",
    messages: [],
    phase: "armed",
  };
  network.use(
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      answerMeta.bind(null, meta),
    ),
  );
  const approval = await approvalFor(fixture);
  const sending = settle(fixture.connector.dispatchWhatsAppReply(approval));
  try {
    await expect
      .poll(metaPhase.bind(null, meta), { timeout: 15_000 })
      .toBe("holding");
    if (move === "revoked") {
      // The operator disables the number: every body and envelope goes.
      expect(
        await fixture.connector.disableWhatsAppProcessing({
          identity: fixture.identity,
          now: Date.now(),
        }),
      ).toMatchObject({ ok: true });
    } else {
      // The approval time ends during the call, and the alarm runs.
      await runInDurableObject(
        fixture.connector,
        endApprovalTime.bind(null, fixture.now),
      );
      // An alarm that is due at once can run before this call; then the call
      // finds no alarm, and the sweep has run all the same.
      await runInDurableObject(fixture.connector, armAlarm);
      await runDurableObjectAlarm(fixture.connector);
    }
    meta.phase = "released";
    const settled = await sending;
    expect(settled).not.toMatchObject({ ok: true, value: { kind: "sent" } });
    expect(settled).not.toMatchObject({
      ok: true,
      value: { kind: "rejected" },
    });
    const after = await runInDurableObject(fixture.connector, readConnector);
    expect(after.proposalState).toBe(move);
    expect(after.body).toBeNull();
    expect(after.sentMessageId).toBeNull();
    expect(after.outboundEnvelope).toBe(0);
    expect(await outboundReceipts()).toBe(0);
    // A second approval of the same version sends nothing.
    const again = await fixture.connector.dispatchWhatsAppReply(approval);
    expect(again).not.toMatchObject({ ok: true, value: { kind: "sent" } });
    expect(meta.messages).toEqual([REPLY]);
    Object.assign(task.meta, {
      whatsappMovedDuringSend: {
        move,
        metaAnswer: meta.answer,
        proposalState: after.proposalState,
        outboundEnvelopeEntries: after.outboundEnvelope,
        messagesToCustomer: meta.messages.length,
        liveProviderAcceptance: false,
      },
    });
  } finally {
    meta.phase = "released";
    await sending;
  }
}

async function approvalFor(fixture: Fixture) {
  const preview = await fixture.connector.previewWhatsAppProposal({
    identity: fixture.identity,
    proposalId: PROPOSAL_ID,
    now: fixture.now,
  });
  if (!preview.ok || preview.value.kind !== "current")
    throw new Error(JSON.stringify(preview));
  return {
    origin: { kind: "operator" } as const,
    identity: fixture.identity,
    proposalId: PROPOSAL_ID,
    approvedVersion: preview.value.preview.version,
    approvedBodyDigest: preview.value.preview.bodyDigest,
    approvedBy: "operator:p55_whatsapp",
    now: fixture.now,
  };
}

/** A settled call: a call to a stopped Actor rejects, and that is an outcome. */
function settle(work: Promise<unknown>): Promise<unknown> {
  return work.catch(threw);
}
function threw(): { ok: "threw" } {
  return { ok: "threw" };
}

async function answerMeta(
  meta: Meta,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  const text =
    isRecord(body) && isRecord(body.text) && typeof body.text.body === "string"
      ? body.text.body
      : "";
  meta.messages.push(text);
  if (meta.phase === "armed") {
    meta.phase = "holding";
    while (meta.phase === "holding") await scheduler.wait(5);
  }
  return meta.answer === "accepted"
    ? HttpResponse.json({ messages: [{ id: MESSAGE_ID }] })
    : HttpResponse.json(
        {
          error: {
            message: "Recipient phone number not in allowed list",
            code: 131030,
          },
        },
        { status: 400 },
      );
}

function metaPhase(meta: Meta): Meta["phase"] {
  return meta.phase;
}

function stopInstance(_actor: unknown, state: DurableObjectState): void {
  state.abort("The Connector stopped during the Meta call");
}

function ignoreStoppedInstance(): void {}

/** The stopped instance broke its stub; a new stub reaches the next one. */
async function nextConnector(
  fixture: Fixture,
): Promise<DurableObjectStub<ConnectorDO>> {
  const next = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: ORGANISATION_ID,
    connectorId: fixture.identity.connectorId,
    now: Date.now(),
  });
  if (!next.ok) throw new Error(next.error.code);
  return next.value;
}

async function armAlarm(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await armConnectorAlarm(state.storage);
}

/** Moves every stored time of the proposals two hours into the past. */
function ageProposals(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    `UPDATE connector_whatsapp_proposal
        SET created_at = created_at - ?, updated_at = updated_at - ?,
            expires_at = expires_at - ?`,
    2 * HOUR_MS,
    2 * HOUR_MS,
    2 * HOUR_MS,
  );
}

/**
 * The proposal's approval time ends; nothing else of it moves. The approval
 * carries the clock of its request (`approvedAt`), so the end moves before
 * that clock: the answer from Meta then comes after the approval time.
 */
function endApprovalTime(
  approvedAt: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_whatsapp_proposal SET expires_at = ? WHERE proposal_id = ?",
    approvedAt - 1,
    PROPOSAL_ID,
  );
}

function readConnector(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  const proposal = latestWhatsAppProposal(sql, PROPOSAL_ID);
  return {
    proposalState: proposal?.state ?? null,
    body: proposal?.ciphertextB64 ?? null,
    sentMessageId: proposal?.sentMessageId ?? null,
    processing: readWhatsAppRuntime(sql)?.processing ?? null,
    outboundEnvelope: sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM connector_whatsapp_envelope WHERE direction = 'outbound'",
      )
      .one().total,
    notices: sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM connector_whatsapp_operator_notice",
      )
      .one().total,
  };
}

async function outboundReceipts(): Promise<number> {
  const receipts = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS total FROM whatsapp_message_receipt WHERE direction = 'outbound'",
    )
    .first<{ total: number }>();
  return receipts?.total ?? 0;
}
