/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import { describe, expect, it } from "vitest";

import {
  handleAccessControlExplainRoute,
  parseAccessDecisionQuestion,
} from "../src/control/routes/access-control-explain";

const SUBJECT_REF = "subject_0123456789abcdef0123456789abcdef";
const SOURCE_REF = "source_0123456789abcdef0123456789abcdef";
const TARGET_REF = "target_0123456789abcdef0123456789abcdef";
const CASE_REF = "case_0123456789abcdef0123456789abcdef";

describe("access-control explain route", function accessControlExplainRouteSuite() {
  it("parses each exact explanation question branch", testExactBranches);
  it(
    "rejects caller-supplied authority and extra nested fields",
    testAuthorityInjection,
  );
  it("rejects duplicate and excessive source references", testSourceBounds);
  it(
    "fails closed before parsing for an unauthenticated viewer",
    testUnauthorized,
  );
});

function testExactBranches(): void {
  expect(
    parseAccessDecisionQuestion({
      kind: "capability",
      authoritySubjectRef: subjectRef(),
      capabilityRef: capabilityRef(),
      targetRef: targetRef(),
    }).ok,
  ).toBe(true);
  expect(
    parseAccessDecisionQuestion({
      kind: "context_read",
      authoritySubjectRef: subjectRef(),
      caseRef: { caseRefId: CASE_REF, revision: 1 },
      sourceRef: sourceRef(),
    }).ok,
  ).toBe(true);
  expect(
    parseAccessDecisionQuestion({
      kind: "conversation_delivery",
      authoritySubjectRef: subjectRef(),
      sourceRefs: [sourceRef()],
      destination: {
        kind: "conversation",
        conversationRefId: SUBJECT_REF,
        revision: 1,
      },
    }).ok,
  ).toBe(true);
  expect(
    parseAccessDecisionQuestion({
      kind: "tool_effect",
      authoritySubjectRef: subjectRef(),
      sourceRefs: [sourceRef()],
      capabilityRef: capabilityRef(),
      targetRef: targetRef(),
      approvalState: {
        kind: "pending",
        approvalRequestId: "approval_access_1",
      },
    }).ok,
  ).toBe(true);
}

function testAuthorityInjection(): void {
  expect(
    parseAccessDecisionQuestion({
      kind: "capability",
      authoritySubjectRef: {
        ...subjectRef(),
        requestAuthority: {
          kind: "control",
          organisationId: "organisation_other",
        },
      },
      capabilityRef: capabilityRef(),
      targetRef: targetRef(),
    }),
  ).toEqual({ ok: false, error: "access_control_explanation_invalid" });
  expect(
    parseAccessDecisionQuestion({
      kind: "capability",
      authoritySubjectRef: subjectRef(),
      capabilityRef: { ...capabilityRef(), rawPredicate: "secret" },
      targetRef: targetRef(),
    }),
  ).toEqual({ ok: false, error: "access_control_explanation_invalid" });
  expect(
    parseAccessDecisionQuestion({
      kind: "context_read",
      authoritySubjectRef: subjectRef(),
      caseRef: { caseId: "case_access_1", revision: 1 },
      sourceRef: sourceRef(),
    }),
  ).toEqual({ ok: false, error: "access_control_explanation_invalid" });
}

function testSourceBounds(): void {
  const question = {
    kind: "conversation_delivery",
    authoritySubjectRef: subjectRef(),
    destination: { kind: "workflow", workflowRefId: SUBJECT_REF, revision: 1 },
  };
  expect(
    parseAccessDecisionQuestion({
      ...question,
      sourceRefs: [sourceRef(), sourceRef()],
    }).ok,
  ).toBe(false);
  const manySources: unknown[] = [];
  for (let index = 0; index < 21; index += 1) {
    manySources.push({
      sourceRefId: `source_${index.toString(16).padStart(32, "0")}`,
      revision: 1,
    });
  }
  expect(
    parseAccessDecisionQuestion({ ...question, sourceRefs: manySources }).ok,
  ).toBe(false);
}

async function testUnauthorized(): Promise<void> {
  const request = new Request(
    "https://pantry.example/v1/control/organisations/organisation_1/access-control/explain",
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  const response = await handleAccessControlExplainRoute(
    request,
    {} as UnitTestEnv,
    {
      kind: "accessControlExplain",
      organisationIdRaw: "organisation_1",
    },
  );
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: "control_session_missing",
  });
}

function subjectRef() {
  return { subjectRefId: SUBJECT_REF, revision: 1 };
}

function sourceRef() {
  return { sourceRefId: SOURCE_REF, revision: 1 };
}

function targetRef() {
  return { targetRefId: TARGET_REF, revision: 1 };
}

function capabilityRef() {
  return { capabilityId: "context.case.read", capabilityVersion: 1 };
}
