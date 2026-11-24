import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { http } from "msw";
import {
  parseBrainSummaryResponse,
  parseMemoryListResponse,
  type BrainSummary,
  type ConversationId,
  type MemoryCommand,
  type MemoryView,
  type UserId,
} from "@purin-labs/control-api";
import type { ModelRoute } from "@purin-labs/contracts";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { Conversation } from "@purin-labs/conversation/chat/conversation";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
} from "@purin-labs/conversation/chat/conversation-actor-identity";
import { readConversation, saveConversation } from "@purin-labs/conversation/chat/store";
import { readActiveOrganisationMembership } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { entityRefOrNull } from "@purin-labs/area-brain/server/memory/store";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import { network } from "./network";
import {
  activateOrganisation,
  addOrganisationMember,
  controlRequest,
  selectModelRoute,
  type OrganisationClient,
} from "./organisation-fixture";
import { openRouterText } from "./slack-journey-support";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";

const CUTOFF_INSTRUCTION =
  "Remember that our primary supplier closes next-day orders at noon Sydney time.";

/** One person of the fixture Organisation, with their control session. */
export type Member = OrganisationClient &
  Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    personId: string;
  }>;

export type MemoryFixture = Readonly<{
  organisationId: OrganisationId;
  organisation: OrganisationActorStub;
  /** The owner. */
  author: Member;
  /** A second administrator. */
  reviewer: Member;
  /** A member whose role carries no context access. */
  viewer: Member;
  /**
   * A person with a valid control session and no role in the Organisation.
   */
  outsider: Member;
  route: ModelRoute;
  paths: ReturnType<typeof controlPaths>;
}>;

export function controlPaths(organisationId: OrganisationId) {
  const base = `/v1/control/organisations/${organisationId}`;
  return {
    organisation: base,
    chat: `${base}/chat`,
    projects: `${base}/projects`,
    memories: `${base}/memories`,
    evals: `${base}/evals`,
    brainSummary: `${base}/brain/summary`,
  } as const;
}

/**
 * An active Organisation with a published policy and a simulated model. Each
 * control request of its people passes Pantry's access check.
 */
export async function installMemoryFixture(): Promise<MemoryFixture> {
  const owner = await commerceClient("memory-owner");
  const organisationId = await commerceWorkspace(owner, "Memory journeys");
  const reviewer = await nativeMember(
    organisationId,
    "memory-reviewer",
    "admin",
  );
  const viewer = await nativeMember(organisationId, "memory-viewer", "viewer");
  const outsider = await commerceClient("memory-outsider");
  const route = await selectModelRoute(organisationId, owner, "pantry_platform");
  await activateOrganisation(organisationId);
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () =>
      openRouterText(
        JSON.stringify({ kind: "reply", text: "Noted the supplier cutoff." }),
        "memory_reply",
      ),
    ),
  );
  return {
    organisationId,
    organisation: await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    }),
    author: await member(organisationId, owner),
    reviewer: await member(organisationId, reviewer),
    viewer: await member(organisationId, viewer),
    outsider: {
      ...outsider,
      organisationId,
      userId: outsider.identity.userId,
      personId: `person_${crypto.randomUUID()}`,
    },
    route,
    paths: controlPaths(organisationId),
  };
}

/** A new member of the fixture's Organisation with this role. */
export async function joinMember(
  organisationId: OrganisationId,
  subject: string,
  role: "admin" | "operator" | "viewer",
): Promise<Member> {
  return member(
    organisationId,
    await nativeMember(organisationId, subject, role),
  );
}

async function nativeMember(
  organisationId: OrganisationId,
  subject: string,
  role: "admin" | "operator" | "viewer",
): Promise<OrganisationClient> {
  const client = await commerceClient(subject);
  await addOrganisationMember(organisationId, client, role);
  return client;
}

async function member(
  organisationId: OrganisationId,
  client: OrganisationClient,
): Promise<Member> {
  const membership = await readActiveOrganisationMembership(
    fixtureDatabase(),
    organisationId,
    client.identity.userId,
  );
  if (membership === null) throw new Error("fixture member has no role");
  return {
    ...client,
    organisationId,
    userId: client.identity.userId,
    personId: membership.personId,
  };
}

/** A control request of one person: a read when `body` is null. */
export function post(
  user: Member,
  path: string,
  body: unknown,
): Promise<Response> {
  return controlRequest(user, path, body);
}

export async function postJson(
  user: Member,
  path: string,
  body: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await post(user, path, body);
  return { status: response.status, body: await response.json() };
}

export async function createConversation(
  user: Member,
  conversationId: ConversationId,
  route: ModelRoute,
): Promise<void> {
  const saved = await saveConversation(
    await requireOrganisationExecutionScope(env, user.organisationId),
    user.userId,
    emptyConversation(conversationId, route),
    0,
  );
  if (saved.kind !== "saved") throw new Error(`conversation ${saved.kind}`);
}

export async function instruct(
  user: Member,
  conversationId: ConversationId,
  requestId: string,
): Promise<void> {
  const stored = await storedConversation(user, conversationId);
  if (stored === null) throw new Error("conversation missing");
  const started = await post(user, controlPaths(user.organisationId).chat, {
    kind: "message",
    conversationId,
    requestId,
    model: stored.conversation.modelRoute.model,
    text: CUTOFF_INSTRUCTION,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, user, conversationId), { timeout: 25_000 })
      .toBe("ready");
  } catch {
    const failed = await storedConversation(user, conversationId);
    throw new Error(
      JSON.stringify({
        work: failed?.conversation.work,
        lastEvent: failed?.conversation.timeline.at(-1),
      }),
    );
  }
}

/** The conversation as its owner's store row holds it. */
export async function storedConversation(
  user: Member,
  conversationId: ConversationId,
) {
  const scope = await requireOrganisationExecutionScope(
    env,
    user.organisationId,
  );
  return readConversation(
    scope.database,
    { organisationId: user.organisationId, userId: user.userId },
    conversationId,
  );
}

/** The accepted Case entry holding the instruction, with its recorded label. */
export function instructionEntry(user: Member, conversationId: ConversationId) {
  return caseEntry(
    user,
    conversationId,
    "closes next-day orders at noon",
    "operator_instruction",
  );
}

export async function caseEntry<
  Kind extends "case_observation" | "operator_instruction",
>(user: Member, conversationId: ConversationId, text: string, kind: Kind) {
  const organisationId = user.organisationId;
  const caseId = await conversationCaseId(
    initialConversationCaseIdentity(
      { organisationId, userId: user.userId },
      conversationId,
    ),
  );
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const entries = await runInDurableObject(caseActor.value, journalEntries);
  const entry = entries.find((candidate) => candidate.payload.includes(text));
  if (entry === undefined)
    throw new Error(`Case entry missing: ${JSON.stringify(entries)}`);
  const metadata = await caseActor.value.readMetadata({
    organisationId,
    caseId,
    entryId: entry.entryId,
  });
  if (!metadata.ok) throw new Error(metadata.error.code);
  return {
    evidence: {
      kind,
      caseId,
      entryId: entry.entryId,
      digest: metadata.value.contentDigest,
    },
    inputLabel: metadata.value.inputLabel,
  } as const;
}

export async function command(
  user: Member,
  body: MemoryCommand,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await post(
    user,
    `${controlPaths(user.organisationId).memories}/commands`,
    body,
  );
  return { status: response.status, body: await response.json() };
}

export async function list(user: Member): Promise<readonly MemoryView[]> {
  const response = await post(
    user,
    controlPaths(user.organisationId).memories,
    null,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return parseMemoryListResponse(await response.json(), entityRefOrNull);
}

/**
 * What waits for one person's decision, with the response as it was sent, so
 * that the answers to two people can be compared whole.
 */
export async function brainSummary(
  user: Member,
): Promise<Readonly<{ text: string; summary: BrainSummary }>> {
  const response = await post(
    user,
    controlPaths(user.organisationId).brainSummary,
    null,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const text = await response.text();
  return { text, summary: parseBrainSummaryResponse(JSON.parse(text)) };
}

export function ids(memories: readonly MemoryView[]): readonly string[] {
  return memories.map((memory) => memory.memoryId).sort();
}

export function receiptMemoryId(body: unknown): string {
  if (
    !isRecord(body) ||
    !isRecord(body.receipt) ||
    typeof body.receipt.memoryId !== "string"
  )
    throw new Error(`receipt missing: ${JSON.stringify(body)}`);
  return body.receipt.memoryId;
}

export async function workKind(
  user: Member,
  id: ConversationId,
): Promise<string | null> {
  return (await storedConversation(user, id))?.conversation.work.kind ?? null;
}

function journalEntries(
  _actor: unknown,
  state: DurableObjectState,
): readonly Readonly<{ entryId: string; payload: string }>[] {
  return state.storage.sql
    .exec<{ entry_id: string; payload: string }>(
      "SELECT entry_id, payload FROM case_journal ORDER BY sequence",
    )
    .toArray()
    .map((row) => ({ entryId: row.entry_id, payload: row.payload }));
}

export function emptyConversation(
  id: ConversationId,
  modelRoute: ModelRoute,
): Conversation {
  return {
    id,
    title: "Supplier cutoff",
    lineage: { kind: "original" },
    historyBindings: [],
    modelRoute,
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs: [],
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: null,
  };
}
