import { expect, it } from "vitest";

import { network } from "./network";
import { installSlackActorFixture } from "./slack-journey-support";
import {
  ANSWER_PARTS,
  askInSlack,
  caseSnapshot,
  grantOperatorOneMoreCapability,
  slackStreamSimulator,
  slowModel,
} from "./slack-streamed-answer-support";

// The refused delivery leaves a retry alarm pending at teardown, so this case
// has its own file.
it(
  "releases no part of an answer once the requester's authority changes during the turn",
  withholdsAfterAuthorityChange,
);

async function withholdsAfterAuthorityChange(): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackStreamSimulator();
  const model = slowModel(ANSWER_PARTS);
  network.use(model.handler, slack.handler);
  await askInSlack("Ev57STREAMWITHHELD");

  await model.started.promise;
  // An administrator grants the operator role one more capability while the
  // model writes. The requester's authority partition changes before any part
  // of the answer is released.
  await grantOperatorOneMoreCapability("grant_e2e_stream_change");
  await model.finished.promise;
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  // No part of the answer reaches the thread, and nothing is delivered.
  expect(slack.methods()).toEqual([]);
  const outputs = (await caseSnapshot(fixture.connectorId)).outputs;
  expect(outputs.filter((output) => output.kind === "settled")).toEqual([]);
}
