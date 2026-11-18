import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { decodeBase64, encodeBase64Url, isRecord } from "@seams/std";
import {
  resolveActiveCaseActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import { nextEmailCorrectionLearningAt } from "../../src/actors/connector-email";
import { runConnectorEmailEvaluation } from "../../src/actors/connector-email-evaluation";
import { gmailConnectorId } from "../../src/data/email-mailbox";
import {
  parseCaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../src/ids";
import { readVerifiedMessageSender } from "../../src/mail-inbox/verified-sender";
import { resolveOrganisationModelRoute } from "../../src/models/route";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { purchasingFixture } from "./mail-purchasing-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import {
  connectGmailMailbox,
  sendAs,
  setUpMailbox,
} from "./gmail-mailbox-support";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

const ADDRESS = "orders@example.test";
const SENDER = "supplier@example.test";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRAFTED_REPLY = "Thanks. We will change tomorrow's order.";
const CORRECTED_REPLY =
  "We cannot change tomorrow's order: orders for the next day close at noon.";
const LEARNED_FACT =
  "Next-day orders for this supplier close at noon. Changes after noon are refused.";
/** The two suppliers that the purchasing fixture seeds. */
const FIRST_SUPPLIER = { id: "supplier_packaging", name: "Packaging supplier" };
const SECOND_SUPPLIER = { id: "supplier_hidden", name: "Hidden supplier" };

it(
  "links a mail sender to a supplier, so that new mail from the sender teaches Memory",
  { timeout: 240_000 },
  senderSupplierLinkJourney,
);

type Connector = DurableObjectStub<
  import("../../src/actors/connector").ConnectorDO
>;

async function senderSupplierLinkJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    organisation,
    author: owner,
    reviewer: admin,
    viewer,
    outsider,
  } = await installMemoryFixture();
  const gmail = new SupplierMailbox();
  gmail.serve();
  const model = new ScriptedAgent();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.answer.bind(model),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "senderlink",
    address: ADDRESS,
  });
  const base = `/v1/control/organisations/${organisationId}`;
  const mailboxPath = `${base}/agent-mailboxes/${account}`;
  const linksPath = `${mailboxPath}/sender-links`;
  await setUpMailbox(owner, organisationId, account);
  const merchantId = await seedSuppliers(organisationId, owner.userId);
  const on = await sendAs(owner, `${mailboxPath}/policy`, {
    policy: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 200_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
  });
  expect(on).toMatchObject({ status: 200, body: { ok: true } });
  await approveMailboxModel(organisationId);
  const connector = await mailboxConnector(organisationId, account);
  await runDurableObjectAlarm(connector);
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const senderOf = async (threadId: string, messageId: string) => {
    const caseId = parseCaseId(`case_gmail_${account}_${threadId}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const sender = await readVerifiedMessageSender({
      db: scope.database,
      organisationId,
      integrationAccountId: account,
      caseId: caseId.value,
      messageId,
    });
    return sender.kind === "supplier"
      ? {
          kind: sender.kind,
          supplierId: sender.endpoint.target.supplierId,
          revision: sender.endpoint.revision,
        }
      : { kind: sender.kind };
  };
  const admit = async (messageId: string, threadId: string) => {
    gmail.arrive(messageId, threadId);
    const checked = await sendAs(owner, `${mailboxPath}/check`, {});
    const evaluated = await runInDurableObject(
      connector,
      evaluateAt.bind(null, organisationId, scheduledAt(checked)),
    );
    expect(evaluated, JSON.stringify(evaluated)).toMatchObject({
      kind: "evaluated",
      admitted: 1,
    });
  };
  const draftOf = (threadId: string, messageId: string) =>
    `proposal_case_gmail_${account}_${threadId}_${messageId}`;
  /** How the Case settled the learning turn of a mail's first correction. */
  const learningSettlement = async (threadId: string, messageId: string) => {
    const caseId = parseCaseId(`case_gmail_${account}_${threadId}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!caseActor.ok) throw new Error(caseActor.error.code);
    const assignmentId = `assignment_${caseId.value}_${messageId}_learn_2`;
    const lifecycle = await runInDurableObject(
      caseActor.value,
      (_actor: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ lifecycle: string }>(
            "SELECT lifecycle_json AS lifecycle FROM case_assignment WHERE assignment_id = ?",
            assignmentId,
          )
          .toArray()[0]?.lifecycle ?? null,
    );
    if (lifecycle === null) return null;
    const parsed: unknown = JSON.parse(
      lifecycle.replaceAll(account, "<account>"),
    );
    if (!isRecord(parsed) || !isRecord(parsed.disposition)) return null;
    // The settled time differs in each run.
    const { kind, commandId, proposalId } = parsed.disposition;
    return { kind, commandId, proposalId };
  };
  const learnedFrom = async (proposalId: string) => {
    const stored = await organisation.readMemories({ organisationId });
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    return stored.value.filter((memory) =>
      memory.revisions.some(
        (revision) =>
          revision.proposedBy.kind === "agent" &&
          revision.evidence.some(
            (cited) =>
              cited.kind === "proposal_correction" &&
              cited.proposalId === proposalId,
          ),
      ),
    );
  };

  // 1. The sender has no link. Mail from the sender is admitted and bound to
  //    nobody. Its reply draft is corrected, and the learning turn proposes
  //    nothing: no supplier is verified for the message.
  const unlinked = await read(owner, linksPath, SENDER);
  expect(unlinked).toEqual({
    status: 200,
    body: { ok: true, link: { supplier: null, revision: 0 } },
  });
  await admit("before_message", "before_thread");
  expect(await senderOf("before_thread", "before_message")).toEqual({
    kind: "none",
  });
  const beforeDraft = draftOf("before_thread", "before_message");
  await runDueWork(connector);
  await waitForDraft(owner, beforeDraft, connector);
  await correct(owner, beforeDraft);
  await waitForNoLearning(connector);
  expect(await learnedFrom(beforeDraft)).toEqual([]);
  expect(model.learningTurns).toBe(1);
  const beforeLearning = await learningSettlement(
    "before_thread",
    "before_message",
  );
  // The Inbox shows that learning assignment as cancelled.
  expect(beforeLearning?.kind).toBe("cancelled");

  // 2. People who may not link are refused, and so are a supplier that does
  //    not exist, an address that is not one, the mailbox's own address and
  //    a mailbox that is not this Organisation's. Nothing is written.
  const linkBody = (supplierId: string, expectedRevision: number) => ({
    address: SENDER,
    supplierId,
    expectedRevision,
  });
  const refusals = {
    viewer: await sendAs(viewer, linksPath, linkBody(FIRST_SUPPLIER.id, 0)),
    outsider: await sendAs(outsider, linksPath, linkBody(FIRST_SUPPLIER.id, 0)),
    missingSupplier: await sendAs(
      admin,
      linksPath,
      linkBody("supplier_absent", 0),
    ),
    invalidAddress: await sendAs(admin, linksPath, {
      ...linkBody(FIRST_SUPPLIER.id, 0),
      address: "not an address",
    }),
    mailboxAddress: await sendAs(admin, linksPath, {
      ...linkBody(FIRST_SUPPLIER.id, 0),
      address: ADDRESS,
    }),
    unknownMailbox: await sendAs(
      admin,
      `${base}/agent-mailboxes/integration_account_unknown/sender-links`,
      linkBody(FIRST_SUPPLIER.id, 0),
    ),
    outsiderRead: await read(outsider, linksPath, SENDER),
  };
  expect(refusals).toEqual({
    viewer: {
      status: 404,
      body: { ok: false, error: "organisation_role_insufficient" },
    },
    outsider: {
      status: 404,
      body: { ok: false, error: "membership_ineligible" },
    },
    missingSupplier: {
      status: 404,
      body: { ok: false, error: "mailbox_sender_supplier_missing" },
    },
    invalidAddress: {
      status: 422,
      body: { ok: false, error: "mailbox_sender_link_invalid" },
    },
    mailboxAddress: {
      status: 422,
      body: { ok: false, error: "mailbox_sender_link_invalid" },
    },
    unknownMailbox: {
      status: 404,
      body: { ok: false, error: "agent_mailbox_missing" },
    },
    outsiderRead: {
      status: 404,
      body: { ok: false, error: "membership_ineligible" },
    },
  });
  expect(await read(owner, linksPath, SENDER)).toEqual(unlinked);

  // 3. An administrator links the sender to the first supplier. A retry of
  //    the same request answers from its receipt. The owner reads the link.
  const key = crypto.randomUUID();
  const linked = await sendAs(
    admin,
    linksPath,
    linkBody(FIRST_SUPPLIER.id, 0),
    key,
  );
  const firstLink = {
    ok: true,
    link: {
      supplier: { supplierId: FIRST_SUPPLIER.id, name: FIRST_SUPPLIER.name },
      revision: 1,
    },
  };
  expect(linked).toEqual({ status: 200, body: firstLink });
  expect(
    await sendAs(admin, linksPath, linkBody(FIRST_SUPPLIER.id, 0), key),
  ).toEqual(linked);
  expect(await read(owner, linksPath, SENDER.toUpperCase())).toEqual({
    status: 200,
    body: firstLink,
  });
  // A sender is mail content: a member without the mailbox's read grant
  // learns nothing about its link.
  expect(await read(viewer, linksPath, SENDER)).toEqual({
    status: 404,
    body: { ok: false, error: "agent_mailbox_missing" },
  });

  // 4. The link does not reach mail that was admitted before it.
  expect(await senderOf("before_thread", "before_message")).toEqual({
    kind: "none",
  });

  // 5. New mail from the sender is bound to the supplier at admission. The
  //    Collection discovery that each admission queued has not run yet. It
  //    is held here, so the state just after admission can be read.
  await admit("after_message", "after_thread");
  await holdDiscovery(connector);
  const heldDiscovery = await runInDurableObject(connector, pendingDiscovery);
  expect(heldDiscovery).toEqual([
    { caseId: `case_gmail_${account}_after_thread` },
    { caseId: `case_gmail_${account}_before_thread` },
  ]);
  const afterAdmission = {
    after: await senderOf("after_thread", "after_message"),
    before: await senderOf("before_thread", "before_message"),
  };
  expect(afterAdmission).toEqual({
    after: { kind: "supplier", supplierId: FIRST_SUPPLIER.id, revision: 1 },
    before: { kind: "none" },
  });

  // 6. Its reply draft is corrected. The learning turn proposes one Memory
  //    for the linked supplier, which cites the exact correction.
  const afterDraft = draftOf("after_thread", "after_message");
  await runDueWork(connector);
  await waitForDraft(owner, afterDraft, connector);
  await correct(owner, afterDraft);
  await expect
    .poll(async () => (await learnedFrom(afterDraft)).length, {
      timeout: 30_000,
    })
    .toBe(1);
  const learned = (await learnedFrom(afterDraft))[0];
  const candidate = learned?.revisions[0];
  expect(candidate).toMatchObject({
    kind: "candidate",
    statement: LEARNED_FACT,
    applicability: {
      kind: "commerce_entity",
      merchantId,
      entity: { entityId: FIRST_SUPPLIER.id },
    },
    proposedBy: {
      kind: "agent",
      caseId: `case_gmail_${account}_after_thread`,
    },
    evidence: [
      expect.objectContaining({
        kind: "proposal_correction",
        proposalId: afterDraft,
        version: 2,
      }),
    ],
  });
  expect(model.learningTurns).toBe(2);
  const afterLearning = await learningSettlement(
    "after_thread",
    "after_message",
  );
  expect(afterLearning?.kind).toBe("completed");

  // 7. The held Collection discovery runs for both mails. Discovery can bind
  //    earlier mail of a verified sender, but only for a mailbox that is a
  //    ready Collection discovery source. This Organisation has none, so the
  //    earlier mail stays unbound.
  await releaseDiscovery(connector);
  await expect
    .poll(() => runInDurableObject(connector, pendingDiscovery), {
      timeout: 20_000,
    })
    .toEqual([]);
  const afterDiscovery = await senderOf("before_thread", "before_message");
  expect(afterDiscovery).toEqual({ kind: "none" });

  // 8. A link to another supplier is a new revision that replaces the first.
  //    A change that names the old revision is refused. Mail admitted after
  //    the change is bound to the second supplier, and the binding of the
  //    earlier mail no longer stands.
  const stale = await sendAs(admin, linksPath, linkBody(SECOND_SUPPLIER.id, 0));
  expect(stale).toEqual({
    status: 409,
    body: { ok: false, error: "mailbox_sender_link_changed" },
  });
  const relinked = await sendAs(
    owner,
    linksPath,
    linkBody(SECOND_SUPPLIER.id, 1),
  );
  const secondLink = {
    ok: true,
    link: {
      supplier: { supplierId: SECOND_SUPPLIER.id, name: SECOND_SUPPLIER.name },
      revision: 2,
    },
  };
  expect(relinked).toEqual({ status: 200, body: secondLink });
  expect(await read(owner, linksPath, SENDER)).toEqual({
    status: 200,
    body: secondLink,
  });
  await admit("relink_message", "relink_thread");
  await holdDiscovery(connector);
  const afterRelink = {
    relink: await senderOf("relink_thread", "relink_message"),
    after: await senderOf("after_thread", "after_message"),
  };
  expect(afterRelink).toEqual({
    relink: { kind: "supplier", supplierId: SECOND_SUPPLIER.id, revision: 2 },
    after: { kind: "none" },
  });
  // A link to the supplier it names already changes nothing.
  expect(
    await sendAs(admin, linksPath, linkBody(SECOND_SUPPLIER.id, 2)),
  ).toEqual({ status: 200, body: secondLink });
  expect(await read(owner, linksPath, SENDER)).toEqual({
    status: 200,
    body: secondLink,
  });

  // The record names the account by a placeholder, so two runs compare.
  const record = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll(account, "<account>"));
  Object.assign(task.meta, {
    mailboxSenderSupplierLink: {
      route:
        "POST /v1/control/organisations/:organisationId/agent-mailboxes/:integrationAccountId/sender-links[/read]",
      substituted: ["Gmail", "the model provider (OpenRouter)"],
      real: [
        "Platform Worker and Actors",
        "account authority (built account Worker)",
        "Underclerk supplier records",
        "mail admission, reply turn, correction and learning turn",
      ],
      beforeLink: {
        link: unlinked.body,
        sender: { kind: "none" },
        learningTurn: beforeLearning,
      },
      refusals,
      link: { response: linked.body, retryAnsweredFromReceipt: true },
      afterAdmission,
      learned: record({
        statement: candidate?.statement,
        applicability: candidate?.applicability,
        proposedBy: candidate?.proposedBy,
        evidence: candidate?.evidence,
      }),
      afterLearning,
      heldDiscovery: record(heldDiscovery),
      beforeMailAfterCollectionDiscovery: {
        collectionDiscoverySource: "not configured",
        sender: afterDiscovery,
      },
      relink: {
        staleRevision: stale.body,
        response: relinked.body,
        afterRelink,
      },
      modelRequests: {
        replyTurns: model.replyTurns,
        learningTurns: model.learningTurns,
      },
    },
  });
}

/**
 * The mailbox agent with a fixed script. A reply turn reads its thread and
 * drafts a reply for approval. A learning turn is the one offered the tool
 * that proposes Memory: it reads the thread and proposes one fact.
 */
class ScriptedAgent {
  replyTurns = 0;
  learningTurns = 0;
  async answer({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.json();
    const text = JSON.stringify(raw);
    const results = toolResults(raw);
    if (text.includes('"propose_memory"')) {
      if (results === 0) {
        this.learningTurns += 1;
        return openRouterToolCall("read_email_case", {}, "learning_case");
      }
      return results === 1
        ? openRouterToolCall(
            "propose_memory",
            { statement: LEARNED_FACT, check: null },
            "learning_propose",
          )
        : openRouterText("Proposed for review.", "learning_done");
    }
    if (results === 0) {
      this.replyTurns += 1;
      return openRouterToolCall("read_email_case", {}, "reply_case");
    }
    return results === 1
      ? openRouterToolCall(
          "email_reply_for_approval",
          { body: DRAFTED_REPLY, sources: null },
          "reply_draft",
        )
      : openRouterText("Prepared for review.", "reply_done");
  }
}

function toolResults(raw: unknown): number {
  return isRecord(raw) && Array.isArray(raw.messages)
    ? raw.messages.filter(
        (message: unknown) => isRecord(message) && message.role === "tool",
      ).length
    : 0;
}

/** Gmail for this mailbox: its Inbox history, its messages and its drafts. */
class SupplierMailbox {
  historyId = 1000;
  arrivals: { id: string; threadId: string; historyId: number }[] = [];
  drafts = new Map<string, { raw: string; threadId: string }>();
  sent = 0;
  unexpected: string[] = [];

  arrive(id: string, threadId: string): void {
    this.historyId += 5;
    this.arrivals.push({ id, threadId, historyId: this.historyId });
  }

  serve(): void {
    network.use(
      http.get(`${GMAIL}/profile`, () =>
        HttpResponse.json({
          emailAddress: ADDRESS,
          historyId: String(this.historyId),
        }),
      ),
      http.post(`${GMAIL}/watch`, () =>
        HttpResponse.json({
          historyId: String(this.historyId),
          expiration: String(Date.now() + 2 * 86_400_000),
        }),
      ),
      http.post(`${GMAIL}/stop`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${GMAIL}/history`, ({ request }) => {
        const start = Number(
          new URL(request.url).searchParams.get("startHistoryId"),
        );
        return HttpResponse.json({
          historyId: String(this.historyId),
          history: this.arrivals
            .filter((arrival) => arrival.historyId > start)
            .map((arrival) => ({
              id: String(arrival.historyId),
              messages: [{ id: arrival.id, threadId: arrival.threadId }],
              messagesAdded: [
                {
                  message: {
                    id: arrival.id,
                    threadId: arrival.threadId,
                    labelIds: ["INBOX", "UNREAD"],
                  },
                },
              ],
            })),
        });
      }),
      http.get(`${GMAIL}/messages`, () => HttpResponse.json({ messages: [] })),
      http.get(`${GMAIL}/messages/:messageId`, ({ params }) => {
        const arrival = this.arrivals.find(
          (candidate) => candidate.id === params.messageId,
        );
        if (arrival === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        return HttpResponse.json({
          id: arrival.id,
          threadId: arrival.threadId,
          labelIds: ["INBOX", "UNREAD"],
          sizeEstimate: 2_048,
          internalDate: String(Date.now() - 60_000),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: `Supplier <${SENDER}>` },
              { name: "To", value: ADDRESS },
              { name: "Subject", value: "Tomorrow's order" },
              { name: "Message-ID", value: `<${arrival.id}@example.test>` },
            ],
            body: {
              data: encodeBase64Url(
                new TextEncoder().encode(
                  "Can we still add ten cases of butter to tomorrow's order?",
                ),
              ),
            },
          },
        });
      }),
      http.get(`${GMAIL}/drafts`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        const drafts: { id: string }[] = [];
        for (const [id, draft] of this.drafts)
          if (query === `rfc822msgid:${header(draft.raw, "Message-ID")}`)
            drafts.push({ id });
        return HttpResponse.json({ drafts });
      }),
      http.get(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        const id = String(params.draftId);
        const draft = this.drafts.get(id);
        if (draft === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        return HttpResponse.json({
          id,
          message: {
            id: `message_${id}`,
            threadId: draft.threadId,
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: ADDRESS },
                { name: "To", value: header(draft.raw, "To") ?? SENDER },
                {
                  name: "Subject",
                  value: header(draft.raw, "Subject") ?? "Re: Tomorrow's order",
                },
              ],
              body: {
                data: encodeBase64Url(
                  new TextEncoder().encode(draftBody(draft.raw)),
                ),
              },
            },
          },
        });
      }),
      http.post(`${GMAIL}/drafts`, async ({ request }) => {
        const raw: unknown = await request.json();
        if (
          !isRecord(raw) ||
          !isRecord(raw.message) ||
          typeof raw.message.raw !== "string"
        )
          throw new Error("Invalid Gmail draft");
        const id = `draft_${this.drafts.size + 1}`;
        const threadId =
          typeof raw.message.threadId === "string" ? raw.message.threadId : "";
        this.drafts.set(id, { raw: raw.message.raw, threadId });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}`, threadId },
        });
      }),
      http.put(`${GMAIL}/drafts/:draftId`, async ({ request, params }) => {
        const id = String(params.draftId);
        const raw: unknown = await request.json();
        const draft = this.drafts.get(id);
        if (
          draft === undefined ||
          !isRecord(raw) ||
          !isRecord(raw.message) ||
          typeof raw.message.raw !== "string"
        )
          throw new Error("Invalid Gmail draft update");
        this.drafts.set(id, { ...draft, raw: raw.message.raw });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}_${Date.now()}` },
        });
      }),
      http.delete(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        this.drafts.delete(String(params.draftId));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${GMAIL}/messages/send`, async ({ request }) => {
        const raw: unknown = await request.json();
        this.sent += 1;
        return HttpResponse.json({
          id: `sent_${this.sent}`,
          threadId:
            isRecord(raw) && typeof raw.threadId === "string"
              ? raw.threadId
              : "",
        });
      }),
      http.all(`${GMAIL}/*`, ({ request }) => {
        this.unexpected.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }),
    );
  }
}

function decodeRaw(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(encoded.replaceAll("-", "+").replaceAll("_", "/")) ??
      new Uint8Array(),
  );
}

function header(encoded: string, name: string): string | null {
  const head = decodeRaw(encoded).split("\r\n\r\n")[0] ?? "";
  return (
    head
      .split("\r\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? null
  );
}

function draftBody(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(
      (decodeRaw(encoded).split("\r\n\r\n")[1] ?? "").replaceAll(/\s+/gu, ""),
    ) ?? new Uint8Array(),
  );
}

/** Makes the Connector's held work due now and wakes it. */
async function runDueWork(connector: Connector): Promise<void> {
  await runInDurableObject(
    connector,
    async (_actor: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE connector_email_reply_turn SET available_at = 0",
      );
      await state.storage.setAlarm(Date.now());
    },
  );
  await runDurableObjectAlarm(connector);
}

/** Moves the Collection discovery that waits a day ahead. */
async function holdDiscovery(connector: Connector): Promise<void> {
  await runInDurableObject(
    connector,
    (_actor: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE connector_email_case_context_discovery SET available_at = ?",
        Date.now() + 86_400_000,
      );
    },
  );
}

async function releaseDiscovery(connector: Connector): Promise<void> {
  await runInDurableObject(
    connector,
    async (_actor: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE connector_email_case_context_discovery SET available_at = 0",
      );
      await state.storage.setAlarm(Date.now());
    },
  );
  await runDurableObjectAlarm(connector);
}

function pendingDiscovery(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ caseId: string }>(
      "SELECT case_id AS caseId FROM connector_email_case_context_discovery ORDER BY case_id",
    )
    .toArray();
}

async function waitForDraft(
  person: Member,
  proposalId: string,
  connector: Connector,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await review(person, proposalId, null, {});
        if (response.status !== 200) {
          await runDueWork(connector);
          return response.status;
        }
        const body: unknown = await response.json();
        return isRecord(body) ? body.kind : null;
      },
      { timeout: 60_000, interval: 500 },
    )
    .toBe("current");
}

/** The person edits the draft in review, which records a correction. */
async function correct(person: Member, proposalId: string): Promise<void> {
  const preview: unknown = await (
    await review(person, proposalId, null, {})
  ).json();
  if (
    !isRecord(preview) ||
    !isRecord(preview.proposal) ||
    typeof preview.proposal.version !== "number" ||
    typeof preview.proposal.snapshot_digest !== "string" ||
    typeof preview.challenge !== "string"
  )
    throw new Error(`No draft to correct: ${JSON.stringify(preview)}`);
  const edited = await review(person, proposalId, "edit", {
    version: preview.proposal.version,
    snapshotDigest: preview.proposal.snapshot_digest,
    challenge: preview.challenge,
    body: CORRECTED_REPLY,
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
}

async function waitForNoLearning(connector: Connector): Promise<void> {
  await expect
    .poll(
      () =>
        runInDurableObject(
          connector,
          (_actor: unknown, state: DurableObjectState) =>
            nextEmailCorrectionLearningAt(state.storage.sql),
        ),
      { timeout: 30_000, interval: 500 },
    )
    .toBeNull();
}

function review(
  person: Member,
  proposalId: string,
  action: "edit" | null,
  body: unknown,
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", crypto.randomUUID());
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${person.organisationId}/email-replies/${proposalId}${action === null ? "" : `/${action}`}`,
    action === null
      ? { headers }
      : { method: "POST", headers, body: JSON.stringify(body) },
  );
}

/** One person's read of the link of one address. */
async function read(
  person: Member,
  path: string,
  address: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers = commerceHeaders(person.session);
  headers.set("content-type", "application/json");
  const response = await exports.default.fetch(
    `https://localhost${path}/read`,
    { method: "POST", headers, body: JSON.stringify({ address }) },
  );
  return { status: response.status, body: await response.json() };
}

/**
 * Pantry's operator approves the workspace's model for mailbox content. The
 * setup never writes this record.
 */
async function approveMailboxModel(
  organisationId: OrganisationId,
): Promise<void> {
  const now = Date.now();
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now,
  });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase()
    .prepare(
      "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'synthetic-sender-link-e2e', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
    )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now,
      now + 3_600_000,
      now,
    )
    .run();
}

/**
 * The Organisation's commerce data in Commerce, with the two suppliers of
 * the purchasing fixture. The mailbox agent gets no commerce grant.
 */
async function seedSuppliers(
  organisationId: OrganisationId,
  userId: string,
): Promise<string> {
  const merchantId = `merchant_mail_purchasing_${crypto.randomUUID()}`;
  const connectionId = `provider_connection_${crypto.randomUUID()}`;
  const accountId = `integration_${crypto.randomUUID()}`;
  const bindingId = `underclerk_binding_${crypto.randomUUID()}`;
  const now = Date.now();
  const provision = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer underclerk-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: organisationId,
        merchantId,
        createdAt: new Date(now).toISOString(),
      }),
    },
  );
  expect(provision.status, await provision.text()).toBe(200);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, provider_application, application_credential_generation, asset_grant_revision, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id) VALUES (?, ?, 'underclerk', 'api_key', 'connection_credential', 1, 'vault:mail:senderlink:e2e', NULL, NULL, NULL, 'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`,
      )
      .bind(connectionId, organisationId, userId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code, capability_set, audience_policy, retention_policy, created_at, updated_at, disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider) VALUES (?, ?, ?, 'underclerk', ?, 'merchant', 'Sender link acceptance', 'active', NULL, '[]', '{}', '{}', ?, ?, NULL, NULL, NULL, 'development', 0)`,
      )
      .bind(accountId, organisationId, connectionId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO underclerk_merchant_binding (binding_id, organisation_id, integration_account_id, merchant_id, environment, delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'development', 'key_mail_e2e', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?)`,
      )
      .bind(bindingId, organisationId, accountId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_commerce_system (organisation_id, system_kind, underclerk_binding_id, shopify_integration_account_id, revision, selected_at, selected_by_user_id) VALUES (?, 'satyr_commerce', ?, NULL, 1, ?, ?)`,
      )
      .bind(organisationId, bindingId, now, userId),
  ]);
  const seeded = await purchasingFixture(organisationId, merchantId, "seed");
  expect(seeded.status, await seeded.text()).toBe(200);
  return merchantId;
}

function scheduledAt(
  checked: Readonly<{ status: number; body: unknown }>,
): number {
  const body = checked.body;
  if (
    checked.status !== 200 ||
    !isRecord(body) ||
    body.kind !== "scheduled" ||
    typeof body.at !== "number"
  )
    throw new Error(`Not a scheduled check: ${JSON.stringify(checked)}`);
  return body.at;
}

async function mailboxConnector(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<Connector> {
  const connectorId = gmailConnectorId(account);
  if (!connectorId.ok) throw new Error("Invalid connector");
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  return connector.value;
}

/** The Connector's own evaluation, on a clock at the given time. */
async function evaluateAt(
  organisationId: OrganisationId,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
) {
  return runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    env,
    storage: state.storage,
    now,
    fetcher: fetch,
  });
}
