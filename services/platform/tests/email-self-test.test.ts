import { describe, expect, it } from "vitest";
import {
  parseEmailProposalTarget,
  parseOperationalEmailTarget,
} from "@purin-labs/area-inbox/server/data/email-operational";
import {
  EMAIL_SELF_TEST_BODY,
  EMAIL_SELF_TEST_SUBJECT,
  parseEmailSelfTestRequest,
  validEmailSelfTestContent,
} from "@purin-labs/area-inbox/server/data/email-self-test";

describe("email self-test", selfTestSuite);

function selfTestSuite(): void {
  it(
    "separates self-test requests and metadata from business contacts",
    parserTest,
  );
  it("allows only the fixed synthetic message", contentTest);
}

function parserTest(): void {
  const target = { kind: "self_test", selfTestId: "proposal_test" };
  expect(parseEmailProposalTarget(target)).toEqual(target);
  expect(parseOperationalEmailTarget(target)).toBeNull();
  expect(
    parseEmailProposalTarget({ ...target, address: "owner@example.com" }),
  ).toBeNull();
  expect(parseEmailProposalTarget({ ...target, contactId: "fake" })).toBeNull();
  expect(
    parseEmailSelfTestRequest({
      kind: "self_test",
      address: "owner@example.com\r\nBcc: other@example.com",
    }),
  ).toBeNull();
  expect(
    parseEmailSelfTestRequest({
      kind: "self_test",
      address: "owner@example.com",
      contactId: "fake",
    }),
  ).toBeNull();
}

function contentTest(): void {
  const target = { kind: "self_test" as const, selfTestId: "proposal_test" };
  expect(
    validEmailSelfTestContent(
      target,
      EMAIL_SELF_TEST_SUBJECT,
      EMAIL_SELF_TEST_BODY,
    ),
  ).toBe(true);
  expect(
    validEmailSelfTestContent(target, "Customer invoice", EMAIL_SELF_TEST_BODY),
  ).toBe(false);
  expect(
    validEmailSelfTestContent(
      target,
      EMAIL_SELF_TEST_SUBJECT,
      "Confidential content",
    ),
  ).toBe(false);
}
