// The owner asks the Portal chat agent what waits for them. The agent reads
// the decisions through the Portal's one read, as the owner's own sign-in, and
// lists what the owner's Portal shows: a step of the owner's private chat that
// waits for the owner. An administrator asks the same and gets the list that
// their own Portal shows, without that step, which only the owner may see.
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { enableCapability, pendingDecisionsOf } from "./access-route-support";
import { answers, ask } from "./chat-permission-support";
import {
  createConversation,
  installMemoryFixture,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentPendingDecisions?: Record<string, unknown>;
  }
}

const MENU_EDIT = "commerce.menu_draft.edit";
const QUESTION = "What waits for me?";

type Step = (body: Record<string, unknown>) => Response;

it(
  "lists what waits for the person who asks, as their own Portal shows it",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, reviewer, route, paths } = await installMemoryFixture();
    await allowMenuEdits(author);
    const steps: Step[] = [];
    const outputs: string[] = [];
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        nextStep.bind(null, steps),
      ),
    );
    const settle = async (person: Member, chat: ConversationId) => {
      await expect.poll(() => steps.length, { timeout: 60_000 }).toBe(0);
      await expect
        .poll(workKind.bind(null, person, chat), { timeout: 60_000 })
        .toMatch(/^(ready|awaiting_permission)$/u);
    };
    const record = (text: string): Step => {
      return (body) => {
        outputs.push(lastToolText(body));
        return openRouterText(text, `answer_${String(outputs.length)}`);
      };
    };
    const readDecisions = (id: string): Step[] => [
      () =>
        openRouterToolCall(
          "tool_search",
          { query: "pending_decisions_read", limit: 1 },
          `search_${id}`,
        ),
      () => openRouterToolCall("pending_decisions_read", {}, `read_${id}`),
      record("Here is what waits for you."),
    ];

    // 1. In a private chat, the owner asks the agent to rename the shared
    //    menu. Every member reads the menu, so the owner's private words wait
    //    for the owner before they enter it.
    const privateChat = newConversationId();
    await createConversation(author, privateChat, route);
    steps.push(
      () =>
        openRouterToolCall(
          "tool_search",
          { query: "menu_draft_edit", limit: 1 },
          "search_menu",
        ),
      () =>
        openRouterToolCall(
          "menu_draft_edit",
          {
            kind: "rename_menu",
            itemId: null,
            sectionId: null,
            productId: null,
            title: "Secret menu",
            description: null,
            order: null,
          },
          "edit_menu",
        ),
      record("I asked first."),
    );
    await ask(
      author,
      paths.chat,
      privateChat,
      route.model,
      "Call the menu Secret menu.",
      "menu",
    );
    await settle(author, privateChat);
    expect(outputs.at(-1)).toContain("Purin Pantry stopped this step");
    const ownerPortal = await pendingDecisionsOf(
      author.organisationId,
      author.session,
    );
    const held = ownerPortal.filter((item) => item.kind === "held_output");
    expect(held).toHaveLength(1);
    const heldId = held[0]?.id ?? "";
    const adminPortal = await pendingDecisionsOf(
      reviewer.organisationId,
      reviewer.session,
    );
    expect(adminPortal.map((item) => item.id)).not.toContain(heldId);

    // 2. The owner asks what waits for them. The agent lists each decision
    //    of the owner's Portal, the held step with it.
    const ownerChat = newConversationId();
    await createConversation(author, ownerChat, route);
    steps.push(...readDecisions("owner"));
    await ask(author, paths.chat, ownerChat, route.model, QUESTION, "owner");
    await settle(author, ownerChat);
    const ownerList = decisionsIn(outputs.at(-1) ?? "");
    expect(ownerList).toEqual(ownerPortal);
    expect(ownerList.map((item) => item.id)).toContain(heldId);
    expect(await answers(author, ownerChat)).toEqual([
      "Here is what waits for you.",
    ]);

    // 3. The administrator asks the same. Their list is their own Portal's:
    //    the owner's held step is not in it.
    const adminChat = newConversationId();
    await createConversation(reviewer, adminChat, route);
    steps.push(...readDecisions("admin"));
    await ask(reviewer, paths.chat, adminChat, route.model, QUESTION, "admin");
    await settle(reviewer, adminChat);
    const adminList = decisionsIn(outputs.at(-1) ?? "");
    expect(adminList).toEqual(adminPortal);
    expect(adminList.map((item) => item.id)).not.toContain(heldId);

    task.meta.chatAgentPendingDecisions = {
      heldId,
      ownerList,
      adminList,
    };
  },
);

/** The owner and the administrator may edit the shared menu. */
async function allowMenuEdits(owner: Member): Promise<void> {
  await enableCapability(owner.organisationId, owner.session, MENU_EDIT);
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  for (const role of ["owner", "admin"] as const) {
    const granted = await createAccessGrant({
      db: scope.database,
      organisationId: owner.organisationId,
      grantId: `grant_pending_decisions_${role}`,
      subject: { kind: "organisation_role", role },
      target: {
        kind: "platform_capability",
        capabilityId: MENU_EDIT,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_pending_decisions_${role}`,
      },
      now: Date.now(),
    });
    if (!granted.ok) throw new Error(granted.error.code);
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: owner.organisationId,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisation,
    organisationId: owner.organisationId,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
}

async function nextStep(
  steps: Step[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const step = steps.shift();
  if (step === undefined) throw new Error("Unexpected model request");
  return step(body);
}

/** The text of the latest tool message that the model got. */
function lastToolText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content))
      return message.content
        .map((part: unknown) =>
          isRecord(part) && typeof part.text === "string" ? part.text : "",
        )
        .join("");
  }
  throw new Error("No tool message");
}

/** The kind and the id of each decision in the read that the model got. */
function decisionsIn(
  output: string,
): readonly Readonly<{ kind: string; id: string }>[] {
  const found = findDecisions(JSON.parse(output));
  if (found === null) throw new Error(`No decisions in ${output}`);
  return found.filter(isRecord).map((decision) => ({
    kind: String(decision.kind),
    id: String(decision.id),
  }));
}

function findDecisions(value: unknown): readonly unknown[] | null {
  if (typeof value === "string") {
    try {
      return findDecisions(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value.decisions)) return value.decisions;
  for (const nested of Object.values(value)) {
    const found = findDecisions(nested);
    if (found !== null) return found;
  }
  return null;
}
