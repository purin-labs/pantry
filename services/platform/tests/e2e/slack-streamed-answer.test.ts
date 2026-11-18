import { expect, it } from "vitest";

import { network } from "./network";
import {
  installSlackActorFixture,
  settledReceiptIdentities,
} from "./slack-journey-support";
import {
  ANSWER,
  ANSWER_PARTS,
  SLOW_PART_GAP_MS,
  askInSlack,
  caseSnapshot,
  grantOperatorOneMoreCapability,
  slackStreamSimulator,
  slowModel,
} from "./slack-streamed-answer-support";

it(
  "streams a long Slack answer in parts and settles the Case output with the streamed message",
  streamsWholeAnswer,
);
it(
  "never sends again a part whose append result was lost, and posts the full answer instead",
  postsFullAnswerAfterLostAppend,
);
it(
  'never releases a token whose "Bearer" reached the thread in an earlier part',
  holdsTokenAfterReleasedBearer,
);
it(
  "keeps the partial answer when the person stops the stream, and posts nothing more",
  keepsPartialAnswerAfterStop,
);
// Last: a refused delivery leaves a retry alarm pending at teardown. A second
// such case in this file crashes the runtime, so the case that withholds the
// whole answer has its own file.
it(
  "stops a streamed answer with a notice when the requester's authority changes mid-answer",
  withholdsRestAfterMidAnswerChange,
  60_000,
);

async function streamsWholeAnswer(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator();
  const model = slowModel(ANSWER_PARTS);
  network.use(model.handler, slack.handler);
  await askInSlack("Ev57STREAMWHOLE");

  // The thread shows the first part while the model still writes.
  await expect
    .poll(() => slack.methods().includes("chat.startStream"), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(model.done()).toBe(false);

  await expect
    .poll(() => slack.methods().includes("chat.stopStream"), {
      timeout: 20_000,
    })
    .toBe(true);
  const methods = slack.methods();
  expect(methods[0]).toBe("chat.startStream");
  expect(
    methods.filter((method) => method === "chat.appendStream").length,
  ).toBeGreaterThanOrEqual(1);
  expect(methods.at(-1)).toBe("chat.stopStream");
  expect(methods).not.toContain("chat.postMessage");
  expect(slack.streamedText()).toBe(ANSWER);
  const stop = slack.calls.find((call) => call.method === "chat.stopStream");
  expect(stop?.body.markdown_text).toBeUndefined();

  const streamTs = slack.streamTs();
  await expect
    .poll(
      async () =>
        settledReceiptIdentities(await caseSnapshot(fixture.connectorId)).map(
          (receipt) => receipt.nativeReceiptId,
        ),
      { timeout: 10_000 },
    )
    .toEqual([streamTs]);
}

async function withholdsRestAfterMidAnswerChange(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator();
  const model = slowModel(ANSWER_PARTS, SLOW_PART_GAP_MS);
  network.use(model.handler, slack.handler);
  await askInSlack("Ev57STREAMMIDWITHHELD");

  await expect
    .poll(() => slack.methods().includes("chat.startStream"), {
      timeout: 20_000,
    })
    .toBe(true);
  await grantOperatorOneMoreCapability("grant_e2e_stream_mid_change");
  await expect
    .poll(() => slack.methods().includes("chat.stopStream"), {
      timeout: 30_000,
    })
    .toBe(true);

  // The thread keeps the parts released before the change, then a notice.
  // The rest of the answer never reaches Slack.
  const shown = slack.streamedText();
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(ANSWER.length);
  expect(ANSWER.startsWith(shown)).toBe(true);
  const stop = slack.calls.find((call) => call.method === "chat.stopStream");
  expect(String(stop?.body.markdown_text)).toContain("cannot share the rest");
  expect(slack.methods()).not.toContain("chat.postMessage");
  await model.finished.promise;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(slack.methods().filter((m) => m === "chat.stopStream")).toHaveLength(
    1,
  );
  const outputs = (await caseSnapshot(fixture.connectorId)).outputs;
  expect(outputs.filter((output) => output.kind === "settled")).toEqual([]);
}

async function postsFullAnswerAfterLostAppend(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator({ loseFirstAppend: true });
  network.use(slowModel(ANSWER_PARTS).handler, slack.handler);
  await askInSlack("Ev57STREAMLOST");

  await expect
    .poll(() => slack.methods().includes("chat.postMessage"), {
      timeout: 20_000,
    })
    .toBe(true);
  const methods = slack.methods();
  const appends = methods.filter((method) => method === "chat.appendStream");
  // The append whose answer was lost is the only one. Its text is not sent
  // again in the stream.
  expect(appends).toHaveLength(1);
  const stop = slack.calls.find((call) => call.method === "chat.stopStream");
  expect(String(stop?.body.markdown_text)).toContain("could not finish");
  const posted = slack.calls.find((call) => call.method === "chat.postMessage");
  expect(posted?.body.markdown_text).toBe(ANSWER);
  await expect
    .poll(
      async () =>
        settledReceiptIdentities(await caseSnapshot(fixture.connectorId))
          .length,
      { timeout: 10_000 },
    )
    .toBe(1);
}

async function holdsTokenAfterReleasedBearer(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator();
  // The first part is long enough to leave at once and ends with "Bearer".
  // The token comes in the next part.
  const token = "eyJhbGciOiJIUzI1NiJ9AbCdEfGhIjKlMnOp";
  const model = slowModel([
    `${ANSWER_PARTS.slice(0, 4).join("")}Send this header with the request: Authorization: Bearer\n`,
    `${token} and keep it out of the shared notes. `,
    ANSWER_PARTS[4] ?? "",
  ]);
  network.use(model.handler, slack.handler);
  await askInSlack("Ev57STREAMBEARER");

  await expect
    .poll(() => slack.methods().includes("chat.stopStream"), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(slack.methods()[0]).toBe("chat.startStream");
  expect(JSON.stringify(slack.calls)).not.toContain(token);
  const stop = slack.calls.find((call) => call.method === "chat.stopStream");
  expect(String(stop?.body.markdown_text)).toContain("held the rest");
  expect(slack.methods()).not.toContain("chat.postMessage");
  await expect
    .poll(
      async () =>
        settledReceiptIdentities(await caseSnapshot(fixture.connectorId)).map(
          (receipt) => receipt.nativeReceiptId,
        ),
      { timeout: 10_000 },
    )
    .toEqual([slack.streamTs()]);
}

async function keepsPartialAnswerAfterStop(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator({ stopAtFirstAppend: true });
  network.use(slowModel(ANSWER_PARTS).handler, slack.handler);
  await askInSlack("Ev57STREAMSTOP");

  await expect
    .poll(
      async () =>
        settledReceiptIdentities(await caseSnapshot(fixture.connectorId)).map(
          (receipt) => receipt.nativeReceiptId,
        ),
      { timeout: 20_000 },
    )
    .toEqual([slack.streamTs()]);
  // The refused append is the last call: no stop, no notice, no full post.
  expect(slack.methods()).toEqual(["chat.startStream", "chat.appendStream"]);
}
