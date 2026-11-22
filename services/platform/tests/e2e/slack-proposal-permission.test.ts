import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { network } from "./network";
import {
  allowAsPortal,
  decide,
  givePortalHandles,
  readPendingRequests,
  readRequest,
  requestIdIn,
} from "./permission-request-support";
import {
  ACCOUNT,
  ListingProvider,
  OWNER,
  effectEvidence,
  installEffectAuthority,
  listingNonce,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  cardButtons,
  installSlackActorFixture,
  isApprovalCard,
  openRouterText,
  openRouterToolCall,
  receiptsOfMessage,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackProposalPermission?: Record<string, unknown>;
  }
}

/**
 * An agent asks for the permission to propose a commerce change, instead of
 * answering that it has no tool (Plan 27B, Plan 56).
 *
 * The shop is connected and its records are readable in the channel, but
 * nobody may propose a commerce change. An owner asks the Slack agent to
 * publish a listing. The agent asks for proposals, and the thread gets the
 * permission notice with its Portal link; the request waits in the pending
 * list. The owner allows it as the Portal prompt does: proposals are turned
 * on and granted to owners for the whole shop. The request continues in the
 * thread, the agent proposes the listing, and its approval card carries the
 * Approve button. Nothing changes in the shop until the owner clicks it.
 */
it(
  "lets a Slack agent ask for commerce proposals and continues to an approval card after an owner allows it",
  { timeout: 180_000 },
  proposalPermissionJourney,
);

const QUESTION =
  "<@U0PANTRY> Publish the prepared cookie box listing for approval.";
const ASKED = "I asked an owner to let me propose commerce changes.";
const ALLOWED_NOTICE =
  "An owner or admin allowed the permission. Sous Chef continues the request now.";

/**
 * An owner denies the request from its card, with no visit to the Portal. An
 * operator's click on Deny is refused, to that member only. The one card then
 * says that the request stopped, and the agent does not run again.
 */
it(
  "denies a permission request from its Slack card for an owner and refuses an operator",
  { timeout: 120_000 },
  async function proposalPermissionDenied(): Promise<void> {
    const fixture = await installSlackActorFixture();
    await givePortalHandles(ORGANISATION_ID);
    const owner = await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "listing",
      false,
    );
    const model = new AskThenPropose("See the card above.");
    const slack = slackSimulator();
    const answers: Record<string, unknown>[] = [];
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        model.respond.bind(model),
      ),
      http.post(
        "https://hooks.slack.com/actions/:team/:id/:token",
        async function recordAnswer({ request }) {
          const body: unknown = await request.json();
          if (!isRecord(body)) throw new Error("Invalid click answer");
          answers.push(body);
          return HttpResponse.text("ok");
        },
      ),
    );
    await sendListingMessage(
      "app_mention",
      "EvProposalDeny",
      ROOT_TS,
      QUESTION,
    );
    await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
    const card = slack.messages[0];
    // The answer settles on the card's message, so its turn has ended.
    await expect
      .poll(receiptsOfMessage.bind(null, fixture.connectorId, card?.ts ?? ""), {
        timeout: 30_000,
      })
      .toBe(2);
    expect(slack.visibleMessageCount()).toBe(1);
    const requestId = requestIdIn(slack.messages);
    expect(cardButtons(card)).toEqual([
      "permission_request_review",
      "permission_request_deny",
    ]);
    const clickDeny = async (): Promise<void> => {
      const click = await exports.default.fetch(
        await signedButtonClick({
          actionId: "permission_request_deny",
          value: requestId,
          user: USER_ID,
          channel: CHANNEL_ID,
          threadTs: ROOT_TS,
          proposalTs: card?.ts ?? "",
        }),
      );
      expect(click.status).toBe(200);
    };

    await fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, OWNER)
      .run();
    await clickDeny();
    await expect.poll(() => answers.length, { timeout: 15_000 }).toBe(1);
    expect(answers[0]).toMatchObject({ response_type: "ephemeral" });
    expect(String(answers[0]?.text)).toContain("Only an owner or admin");

    await fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, OWNER)
      .run();
    await clickDeny();
    await expect
      .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
      .toBe(
        "An owner or admin denied the permission. Sous Chef stopped this request.",
      );
    expect(cardButtons(slack.messages[0])).toEqual([]);
    expect(slack.visibleMessageCount()).toBe(1);
    expect(await effectEvidence()).toMatchObject({ mutations: 0 });
    const late = await decide(ORGANISATION_ID, owner, requestId, "allow");
    expect(late.status).toBe(409);
  },
);

async function proposalPermissionJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  await givePortalHandles(ORGANISATION_ID);
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
    false,
  );
  const model = new AskThenPropose();
  const slack = slackSimulator();
  const answers: string[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.post(
      "https://hooks.slack.com/actions/:team/:id/:token",
      async function recordAnswer({ request }) {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid click answer");
        answers.push(String(body.text));
        return HttpResponse.text("ok");
      },
    ),
  );

  // 1. The agent asks for proposals and says so; nothing is proposed.
  await sendListingMessage("app_mention", "EvProposalAsk", ROOT_TS, QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(model.offeredProposal).toBe(true);
  expect(slack.messages.map(textOf)).toEqual([
    expect.stringContaining(
      "Sous Chef needs permission to propose governed commerce actions",
    ),
    ASKED,
  ]);
  const requestId = requestIdIn(slack.messages);
  expect(await readPendingRequests(ORGANISATION_ID, owner)).toMatchObject({
    mayDecide: true,
    requests: [
      {
        requestId,
        origin: "slack_thread",
        itemLabels: ["Propose governed commerce actions"],
      },
    ],
  });
  const asked = await readRequest(ORGANISATION_ID, owner, requestId);
  expect(asked).toMatchObject({
    status: "pending",
    requesterRole: "owner",
    items: [
      {
        capabilityId: "commerce.action.propose",
        granted: false,
        description: expect.stringContaining(
          "Purin Pantry makes no change until an owner or admin approves it",
        ),
        grant: {
          subjectLabel: "Owners",
          target: {
            kind: "provider_resource",
            integrationRef: `integration:${ACCOUNT}`,
            resourceRef: "provider_resource:*",
          },
        },
      },
    ],
  });

  // 2. The owner allows it as the Portal prompt does.
  const allowed = await allowAsPortal(ORGANISATION_ID, owner, requestId);
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect(await readRequest(ORGANISATION_ID, owner, requestId)).toMatchObject({
    status: "allowed",
    items: [{ mode: "enabled", granted: true }],
  });
  expect(await readPendingRequests(ORGANISATION_ID, owner)).toMatchObject({
    requests: [],
  });
  const grant = await proposalGrant();

  // 3. The request continues: the agent proposes, and the card waits for a
  //    click. The shop is unchanged.
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(4);
  const texts = slack.messages.map(textOf);
  expect(texts[0]).toBe(ALLOWED_NOTICE);
  expect(texts.slice(2)).toEqual([
    expect.stringContaining(
      "Nothing changes until an owner or admin approves it",
    ),
    "PI_LISTING_AWAITING_APPROVAL",
  ]);
  const nonce = listingNonce(model.listing.requests);
  const card = slack.messages.find(isApprovalCard);
  const blocks: unknown = JSON.parse(card?.blocks ?? "[]");
  expect(blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "actions",
        elements: expect.arrayContaining([
          expect.objectContaining({
            action_id: "commerce_action_approve",
            value: nonce,
          }),
        ]),
      }),
    ]),
  );
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });

  // 4. The owner's click approves the change, and the card says so.
  const click = await exports.default.fetch(
    await signedButtonClick({
      actionId: "commerce_action_approve",
      value: nonce,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: ROOT_TS,
      proposalTs: card?.ts ?? "",
    }),
  );
  expect(click.status).toBe(200);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
  expect(answers[0]).toContain(`Approved by <@${USER_ID}>`);
  expect(await effectEvidence()).toMatchObject({ mutations: 1 });

  task.meta.slackProposalPermission = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (signed events, interaction payloads and response URLs)",
      "commerce provider (Commerce test merchant)",
    ],
    requestId,
    request: asked,
    grant,
    slackMessages: texts,
    nonce,
    clickAnswers: answers,
    provider: await effectEvidence(),
  };
}

/**
 * The model asks for proposals first. After the allow, the continued turn
 * reads the listing and proposes it, as the listing journeys do.
 */
class AskThenPropose {
  readonly listing = new ListingProvider();
  offeredProposal = false;
  private asked = 0;

  constructor(private readonly reply: string = ASKED) {}

  async respond(info: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (this.asked === 2) return this.listing.respond(info);
    this.asked += 1;
    const body: unknown = await info.request.json();
    if (!isRecord(body)) throw new Error("Invalid model request");
    if (this.asked === 1) {
      this.offeredProposal = requestableIds(body).includes(
        "commerce.action.propose",
      );
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: ["commerce.action.propose"], entityTypeReads: [] },
        "call_permission_propose",
      );
    }
    expect(requireLastToolOutput(body)).toContain("permission_requested");
    return openRouterText(this.reply, "permission_propose_asked");
  }
}

/** The capabilities that the request tool of one model request offers. */
function requestableIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  for (const tool of body.tools) {
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      tool.function.name === "request_permission" &&
      isRecord(tool.function.parameters) &&
      isRecord(tool.function.parameters.properties) &&
      isRecord(tool.function.parameters.properties.capabilityIds) &&
      isRecord(tool.function.parameters.properties.capabilityIds.items) &&
      Array.isArray(
        tool.function.parameters.properties.capabilityIds.items.enum,
      )
    )
      return tool.function.parameters.properties.capabilityIds.items.enum.map(
        String,
      );
  }
  return [];
}

/** The one proposal grant that the allow added. */
async function proposalGrant(): Promise<unknown> {
  const scope = await OrganisationExecutionScope.resolve(env, ORGANISATION_ID);
  if (!scope.ok) throw new Error("E2E organisation scope missing");
  const grants = await listAccessGrants({
    db: scope.value.database,
    organisationId: ORGANISATION_ID,
    lifecycle: "active",
  });
  if (!grants.ok) throw new Error(grants.error.code);
  const proposals = grants.value.filter(
    (grant) => grant.target.capabilityId === "commerce.action.propose",
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "provider_resource",
      integrationAccountId: ACCOUNT,
      resourceScope: "*",
    },
  });
  return proposals[0];
}

function textOf(message: Record<string, string>): string {
  return message.text ?? "";
}
