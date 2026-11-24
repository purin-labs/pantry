// A release removes the model that a mailbox's replies ran on (Plan 96 step
// A4, FND-04). Gmail mail goes only to a model whose data terms an owner or
// admin accepted (Google's Limited Use rules, INB-01), so new mail waits: the
// mailbox setup asks for the terms of the new default model, and a reply turn
// that comes due drafts nothing and asks no model. After the owner accepts,
// the waiting mail gets its draft from the new default: each reply turn runs
// in a Session of its own, on the Organisation's route at the time of the
// turn.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http } from "msw";
import {
  encodeMailboxSetupAgentChoice,
  mailboxModelConsentRequest,
} from "@purin-labs/control-api";
import { PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS } from "@purin-labs/agent/actors/pi-embedded-adapter";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";
import { setUpMailbox } from "@purin-labs/area-inbox/ui/features/mail-setup/turn-on";
import { installMemoryFixture } from "./memory-support";
import { network } from "./network";
import {
  acceptMailboxModel,
  arriveAndEvaluate,
  connectGmailMailbox,
  DraftingAgent,
  FakeGmailMailbox,
  finishReplyTurns,
  mailboxConnector,
  portalSetupTransport,
  readPlan,
  readReplyTurns,
  reviewOf,
  runDueMailWork,
  sendAs,
} from "./gmail-mailbox-support";

const ADDRESS = "model-change@example.test";
const DRAFT = "Thank you. Your tart order is ready on Friday.";
/** A reviewed model that the release removes. */
const REMOVED_MODEL = "moonshotai/kimi-k3";

it(
  "holds new mail after the mailbox's model left the list until the owner accepts the new default, then drafts it on the default",
  { timeout: 240_000 },
  mailboxModelChangeJourney,
);

async function mailboxModelChangeJourney({
  task,
  onTestFinished,
}: TestContext): Promise<void> {
  env.PANTRY_PLATFORM_PI_MODEL = REMOVED_MODEL;
  const adapters: Record<string, unknown> =
    PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS;
  const removedAdapter = adapters[REMOVED_MODEL];
  onTestFinished(() => {
    delete env.PANTRY_PLATFORM_PI_MODEL;
    adapters[REMOVED_MODEL] = removedAdapter;
  });
  const {
    organisationId,
    author: owner,
    viewer,
  } = await installMemoryFixture();
  const gmail = new FakeGmailMailbox({
    address: ADDRESS,
    sender: "Customer <customer@example.test>",
    subject: "A tart order",
    text: "Is my tart order ready for Friday?",
  });
  gmail.serve();
  const model = new DraftingAgent(DRAFT);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.answer.bind(model),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "modelchange",
    address: ADDRESS,
  });
  const mailboxPath = `/v1/control/organisations/${organisationId}/agent-mailboxes/${account}`;
  const plan = () =>
    readPlan(
      owner,
      `${mailboxPath}/setup?agent=${encodeURIComponent(encodeMailboxSetupAgentChoice({ kind: "automatic" }))}`,
    );
  await acceptMailboxModel(organisationId, owner);
  await setUpMailbox(
    portalSetupTransport(owner),
    { organisationId, integrationAccountId: account },
    { kind: "automatic" },
    true,
    null,
  );
  const connector = await mailboxConnector(organisationId, account);
  await runDueMailWork(connector);
  const arrive = (thread: string) =>
    arriveAndEvaluate(gmail, owner, organisationId, mailboxPath, connector, [
      thread,
    ]);

  // 1. The first thread gets its draft from the accepted model.
  expect(await arrive("before_release")).toMatchObject({
    kind: "evaluated",
    admitted: 1,
  });
  await finishReplyTurns(connector);
  expect(gmail.drafts.size).toBe(1);
  expect(new Set(model.models)).toEqual(new Set([REMOVED_MODEL]));
  const callsBefore = model.models.length;

  // 2. The release: the model has no adapter any more, and the route runs
  //    the code default. The mailbox setup asks for the terms of the new
  //    default model.
  delete adapters[REMOVED_MODEL];
  delete env.PANTRY_PLATFORM_PI_MODEL;
  const changed = await plan();
  expect(changed.plan?.model).toMatchObject({
    kind: "consent_needed",
    review: { model: PLATFORM_DEFAULT_PI_MODEL, name: "Gemini 4 Hydrogen" },
  });

  // 3. New mail waits: its reply turn drafts nothing, asks no model, and
  //    stays queued for the next attempt.
  expect(await arrive("after_release")).toMatchObject({
    kind: "evaluated",
    admitted: 1,
  });
  await runDueMailWork(connector);
  expect(gmail.drafts.size).toBe(1);
  expect(model.models).toHaveLength(callsBefore);
  expect(await runInDurableObject(connector, readReplyTurns)).toHaveLength(1);

  // 4. A member without the right cannot accept. The owner accepts the new
  //    default's terms, and the waiting thread gets its draft from it.
  const review = reviewOf(changed.plan);
  expect(
    await sendAs(
      viewer,
      `${mailboxPath}/model-consent`,
      mailboxModelConsentRequest(review),
    ),
  ).toMatchObject({ status: 404 });
  const accepted = await sendAs(
    owner,
    `${mailboxPath}/model-consent`,
    mailboxModelConsentRequest(review),
  );
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: 200 });
  await finishReplyTurns(connector);
  expect(gmail.drafts.size).toBe(2);
  expect(new Set(model.models.slice(callsBefore))).toEqual(
    new Set([PLATFORM_DEFAULT_PI_MODEL]),
  );
  expect(gmail.unexpected).toEqual([]);

  Object.assign(task.meta, {
    mailboxModelChange: {
      removedModel: REMOVED_MODEL,
      setupAfterRelease: changed.plan?.model,
      draftsWhileWaiting: 1,
      ownerAcceptance: accepted.status,
      draftsAfterAcceptance: gmail.drafts.size,
      requestedModels: model.models,
    },
  });
}
