import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { BakeProposalView } from "@purin-labs/kitchen-control-api";
import { isRecord } from "@purin-labs/std";

import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "@purin-labs/control-api/ids";
import { fixtureDatabase } from "./organisation-database";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  USER_ID,
} from "./slack-journey-support";

/**
 * Plan 24: the Slack side of the bake journeys, in the Slack actor fixture's
 * operations channel. A proposal's card is the root of a thread that resolves
 * to its Case; its bake run posts its own card and the over-bake message in
 * that thread (S6). A click is signed as Slack signs it.
 */

export async function sessionOf(userId: string): Promise<IssuedControlSession> {
  const parsed = parseUserId(userId);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return issueControlSession({
    db: env.DB,
    userId: parsed.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
}

/** The Slack actor's role: the same linked Slack user as a viewer or operator. */
export async function setActorRole(role: "operator" | "viewer"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(role, ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .run();
}

export function buttonsOf(message: Record<string, string>): string[] {
  const blocks: unknown = JSON.parse(message.blocks ?? "[]");
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: unknown) =>
    isRecord(block) && block.type === "actions" && Array.isArray(block.elements)
      ? block.elements.flatMap((element: unknown) =>
          isRecord(element) ? [String(element.action_id)] : [],
        )
      : [],
  );
}

/** The card whose thread resolves to the proposal's Case. */
export async function cardOf(
  cards: readonly Record<string, string>[],
  proposal: Pick<BakeProposalView, "caseId">,
): Promise<Record<string, string>> {
  for (const card of cards)
    if ((await threadCase(String(card.ts))) === proposal.caseId) return card;
  throw new Error("No card for the proposal");
}

/** The Case that the thread of a card's message resolves to. */
export async function threadCase(ts: string): Promise<string | null> {
  const pin = await env.DB.prepare(
    "SELECT case_id AS caseId FROM slack_thread_case_pin WHERE channel_id = ? AND root_message_ts = ?",
  )
    .bind(CHANNEL_ID, ts)
    .first<{ caseId: string }>();
  return pin?.caseId ?? null;
}

/**
 * A click on the card, as Slack signs it, with the text of its reason field.
 * A card in a thread, such as a bake run's, names the thread's root.
 */
export async function clickCard(
  card: Record<string, string>,
  actionId: string,
  proposal: Pick<BakeProposalView, "proposalId">,
  reason: string | null,
  threadTs: string | null = null,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedButtonClick({
      actionId,
      value: proposal.proposalId,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs,
      proposalTs: String(card.ts),
      state: {
        bake_proposal_reason: {
          bake_proposal_reason_text: {
            type: "plain_text_input",
            value: reason,
          },
        },
      },
    }),
  );
  expect(response.status).toBe(200);
}
