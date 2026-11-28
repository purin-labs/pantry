// Plan 88 phase 3, journey J5: the Portal chat agent reads the Jev settings
// and turns a switch off through an approval card, through the person's own
// prompts, role check and receipts. The model answers from a script and only
// chooses the tool call; product code reads the settings, stages the card,
// refuses the lower role and writes the switch.
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  parseJevFeaturesView,
  type JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { isRecord } from "@purin-labs/std";

import { commerceHeaders } from "./commerce-support";
import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import {
  installMemoryFixture,
  postJson,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { memberMutation } from "./organisation-fixture";
import { draftAction, onlyDraft } from "./chat-journey-support";
import {
  installScriptedModel,
  lastScriptedOutput,
  scriptedChat,
  type ScriptedTools,
} from "./scripted-agent-support";

const SCRIPTS: ScriptedTools = {
  READJEV: {
    tool: "jev_features_read",
    args: {},
    ask: ["jev.features.read"],
  },
  SCREENOFF: {
    tool: "jev_features_manage",
    args: { feature: "screen_relevance", enabled: false, mode: null },
    ask: ["jev.features.manage"],
  },
  SCREENON: {
    tool: "jev_features_manage",
    args: { feature: "screen_relevance", enabled: true, mode: null },
    ask: ["jev.features.manage"],
  },
};

it(
  "J5: the agent reads the Jev settings, turns screen relevance off after the admin approves the card, and a member who is not an admin changes nothing",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, reviewer, organisationId } = fixture;
    const journey = installScriptedModel(SCRIPTS);

    // The owner turns screen relevance on, on Settings › Jev.
    const on = await change(fixture, author, {
      feature: "screen_relevance",
      enabled: true,
    });
    expect(on.screenRelevance.enabled).toBe(true);

    // 1. The read asks first. After the allow, the agent gets the same view
    //    that the page shows.
    await scriptedChat(fixture, author, "READJEV");
    const read = toolValue(lastScriptedOutput(journey, "READJEV"));
    expect(read).toEqual(await features(fixture, author));
    expect(read).toMatchObject({
      funding: "pantry_platform",
      keyAvailable: true,
      screenRelevance: { enabled: true },
    });

    // 2. A change is a card. Nothing changes until the admin approves it.
    const off = await scriptedChat(fixture, author, "SCREENOFF");
    expect(lastScriptedOutput(journey, "SCREENOFF")).toContain("configuration_drafted");
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      true,
    );
    const offCard = await onlyDraft(fixture, author, off);
    expect(offCard).toMatchObject({
      summary: "Turn off Screen relevance in Settings › Jev.",
      actionLabel: "Turn off Screen relevance",
      state: "pending",
    });
    const approved = await draftAction(
      fixture,
      author,
      off,
      offCard,
      "confirm",
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await approved.json()).toMatchObject({
      draft: { state: "settled", receiptCode: "accepted" },
    });
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      false,
    );

    // 3. A second admin asks to turn it on again, and then loses the admin
    //    role. The card refuses that person, and the switch stays off.
    const onAgain = await scriptedChat(fixture, reviewer, "SCREENON");
    const onCard = await onlyDraft(fixture, reviewer, onAgain);
    expect(onCard.summary).toBe("Turn on Screen relevance in Settings › Jev.");
    const demoted = await memberMutation(
      organisationId,
      author,
      reviewer,
      "PATCH",
      { role: "operator" },
    );
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    const refused = await draftAction(
      fixture,
      reviewer,
      onAgain,
      onCard,
      "confirm",
    );
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "organisation_role_insufficient",
    });
    // The page refuses the same change from that person, as every admin route.
    const direct = await controlFetch(fixture, reviewer, "jev-features", {
      feature: "screen_relevance",
      enabled: true,
    });
    expect(direct.status).toBe(404);
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      false,
    );
    // A Portal chat is for an owner or an admin, so that person can no longer
    // open the chat and its card.
    const chatRead = await postJson(
      reviewer,
      `${fixture.paths.chat}?${new URLSearchParams({ conversation: onAgain })}`,
      null,
    );
    expect(chatRead.body).toMatchObject({
      error: "organisation_role_insufficient",
    });

    // No tool lets the agent change a switch without a card.
    for (const name of journey.offered)
      expect(name).not.toMatch(/^jev_features_(set|write|enable|disable)/u);
  },
);

/** The tool's value, which the model receives as JSON inside JSON. */
function toolValue(raw: string): JevFeaturesView {
  const message = JSON.parse(JSON.parse(raw) as string) as { output: string };
  return parseJevFeaturesView(JSON.parse(message.output));
}

async function features(
  fixture: MemoryFixture,
  person: Member,
): Promise<JevFeaturesView> {
  const response = await controlFetch(fixture, person, "jev-features", null);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

async function change(
  fixture: MemoryFixture,
  person: Member,
  body: unknown,
): Promise<JevFeaturesView> {
  const response = await controlFetch(fixture, person, "jev-features", body);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

function controlFetch(
  fixture: MemoryFixture,
  person: Member,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", crypto.randomUUID());
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}${fixture.paths.organisation}/${path}`,
    {
      method: body === null ? "GET" : "POST",
      headers,
      body: body === null ? null : JSON.stringify(body),
    },
  );
}
