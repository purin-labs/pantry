import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import {
  describeOperation,
  holdArchiveOperations,
  isAttachmentOperation,
  longestSequence,
  type ArchiveOperation,
} from "./archive-operation-support";
import { network } from "./network";
import {
  installSlackActorFixture,
  modelSimulator,
  signedSlackRequest,
  slackEnvelope,
  slackFileSimulator,
  slackSimulator,
} from "./slack-journey-support";

/**
 * The files of one message are independent. The Connector stores them
 * together, and the Session prepares them together. Three files then cost
 * each Actor the chain of one file. For the Connector that is the check for
 * a stored copy, then the two writes. For the Session it is the read of the
 * content, then the write of the prepared result.
 */
it("stores and prepares the three files of one Slack message together", async ({
  task,
  onTestFinished,
}) => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const encoder = new TextEncoder();
  const sources = [
    { id: "F0E2EBATCH1", name: "terms.txt", text: "Espresso 3.50 per unit\n" },
    {
      id: "F0E2EBATCH2",
      name: "hours.txt",
      text: "Open from 07:30 to 16:00\n",
    },
    { id: "F0E2EBATCH3", name: "minimum.txt", text: "Minimum 200 units\n" },
  ].map((source) => ({ ...source, bytes: encoder.encode(source.text) }));
  const files = slackFileSimulator(
    sources.map((source) => ({
      id: source.id,
      name: source.name,
      mimetype: "text/plain",
      bytes: source.bytes,
    })),
  );

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );
  const operations = holdArchiveOperations(onTestFinished, 120);

  const rootTs = "1787561000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EBATCH",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> what do these say",
        files: sources.map((source) => ({
          id: source.id,
          name: source.name,
          mimetype: "text/plain",
          size: source.bytes.byteLength,
          timestamp: 1_787_561_000,
        })),
      }),
    ),
  );
  await model.rootStarted.promise;
  model.releaseRoot.resolve(undefined);

  // The model has the words of each file, in the order of the message.
  const request = JSON.stringify(model.requests[0]);
  const positions = sources.map((source) =>
    request.indexOf(source.text.trim()),
  );
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual(positions.toSorted((left, right) => left - right));
  const stored = operations.filter(isConnectorOperation);
  expect(stored).toHaveLength(9);
  expect(longestSequence(stored)).toBe(2);
  const prepared = operations.filter(isSessionOperation);
  expect(prepared).toHaveLength(6);
  expect(longestSequence(prepared)).toBe(2);

  Object.assign(task.meta, {
    slackFileBatchArchiveOperations: {
      connectorOperations: stored.map(describeOperation),
      longestConnectorSequence: longestSequence(stored),
      sessionOperations: prepared.map(describeOperation),
      longestSessionSequence: longestSequence(prepared),
    },
  });
});

/** The Session reads a file's content and writes its prepared result. */
function isSessionOperation(operation: ArchiveOperation): boolean {
  return isAttachmentOperation(operation) && !isConnectorOperation(operation);
}

/** The Connector checks a file's source pointer, then writes content and pointer. */
function isConnectorOperation(operation: ArchiveOperation): boolean {
  return (
    isAttachmentOperation(operation) &&
    (operation.key.includes("/slackref/") ||
      (operation.kind === "put" && operation.key.includes("/slack/")))
  );
}
