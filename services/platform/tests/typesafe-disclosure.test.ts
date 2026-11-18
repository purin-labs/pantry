import { expect, it, vi } from "vitest";
import { TypeSafeDisclosure } from "../src/integrations/typesafe/disclosure";
import { FlowLabel } from "../src/policy/information-flow/labels";
import type { TypeSafeInferenceSink } from "../src/policy/information-flow/types";
import { buildWorkflowAuthority } from "../src/request-authority";
import { parseOrganisationId } from "../src/ids";
import { JevRelationshipRequest } from "../src/case-context-discovery/jev";

it(
  "pins the exact request, processing authority and connection before asynchronous disclosure",
  pinsDisclosure,
);
it("rejects foreign or unlabelled private inputs", rejectsDisallowedSources);
it("returns judgments with the joined source label", labelsJudgments);

async function labelsJudgments(): Promise<void> {
  const source = await label("organisation_disclosure");
  const prepared = await JevRelationshipRequest.prepare({
    sink: sink(),
    labels: [source],
    comparison: {
      evidence: "Synthetic delivery issue",
      candidates: [
        { candidateId: "candidate", evidence: "Synthetic same delivery issue" },
      ],
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      model: "jev-1.13.0",
      answers: {
        candidate_0: {
          type: "choice",
          choice: "same_issue",
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
  );
  const evaluated = await prepared.value.evaluate({
    credential: {
      provider: "typesafe",
      apiKey: "apikey_public-test-fixture-only",
      authority: { kind: "organisation_byo", connectionRevision: 1 },
    },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetcher,
  });
  if (!evaluated.ok) throw new Error(evaluated.error.code);
  expect(evaluated.value.flowLabel).toEqual(source.toJSON());
}

const BODY = JSON.stringify({
  model: "jev-1.13.0",
  state: { request: "Synthetic status request" },
  questions: {
    status: { type: "noul", instructions: "Is this a status question?" },
  },
});

function sink(): TypeSafeInferenceSink {
  const organisation = parseOrganisationId("organisation_disclosure");
  if (!organisation.ok) throw new Error("invalid fixture organisation");
  return {
    kind: "typesafe_system_one",
    organisationId: organisation.value,
    purpose: "case_context_discovery_relationship",
    funding: { kind: "organisation_byo", connectionRevision: 1 },
    model: "jev-1.13.0",
    processing: {
      kind: "authorized_source",
      authority: buildWorkflowAuthority({
        organisationId: organisation.value,
        workflowId: "workflow_fixture",
        workflowRevision: 1,
      }).requestAuthority,
    },
  };
}

async function label(organisationId: string): Promise<FlowLabel> {
  const created = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId },
      readers: [
        {
          kind: "workflow",
          workflowKind: "cue_subscription",
          workflowId: "workflow_fixture",
          workflowRevision: 1,
        },
      ],
    },
  ]);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

async function pinsDisclosure(): Promise<void> {
  const source = await label("organisation_disclosure");
  const mutable = { ...sink() };
  const promise = TypeSafeDisclosure.authorize({
    sink: mutable,
    labels: [source],
    body: BODY,
  });
  mutable.funding = { kind: "organisation_byo", connectionRevision: 2 };
  const prepared = await promise;
  if (!prepared.ok) throw new Error(prepared.error.code);
  expect(prepared.value.sink.funding).toEqual({
    kind: "organisation_byo",
    connectionRevision: 1,
  });
  expect(prepared.value.flowLabel.digest).toBe(source.digest);
  const changed = await TypeSafeDisclosure.authorize({
    sink: sink(),
    labels: [source],
    body: BODY.replace("status request", "different request"),
  });
  if (!changed.ok) throw new Error(changed.error.code);
  expect(changed.value.decisionDigest).not.toBe(prepared.value.decisionDigest);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ result: "fixture" }));
  const request = {
    credential: {
      provider: "typesafe" as const,
      apiKey: "apikey_public-test-fixture-only",
      authority: { kind: "organisation_byo" as const, connectionRevision: 2 },
    },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetcher,
  };
  expect(await prepared.value.post(request)).toEqual({
    ok: false,
    error: { code: "jev_credential_unavailable" },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (
      await prepared.value.post({
        ...request,
        credential: {
          ...request.credential,
          authority: { kind: "organisation_byo", connectionRevision: 1 },
        },
      })
    ).ok,
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.typesafe.ai/v1/systemone",
    expect.objectContaining({ body: BODY, redirect: "manual" }),
  );
  expect(
    await TypeSafeDisclosure.authorize({
      sink: sink(),
      labels: [source],
      body: BODY.replace("jev-1.13.0", "another-model"),
    }),
  ).toEqual({ ok: false, error: { code: "jev_input_invalid" } });
  const secretBody = BODY.replace(
    "Synthetic status request",
    request.credential.apiKey,
  );
  const secret = await TypeSafeDisclosure.authorize({
    sink: sink(),
    labels: [source],
    body: secretBody,
  });
  if (!secret.ok) throw new Error(secret.error.code);
  fetcher.mockClear();
  expect(
    await secret.value.post({
      ...request,
      credential: {
          ...request.credential,
          authority: { kind: "organisation_byo", connectionRevision: 1 },
        },
    }),
  ).toEqual({ ok: false, error: { code: "jev_input_invalid" } });
  expect(fetcher).not.toHaveBeenCalled();
}

async function rejectsDisallowedSources(): Promise<void> {
  const permitted = await label("organisation_disclosure");
  const foreign = await label("organisation_foreign");
  expect(
    await TypeSafeDisclosure.authorize({
      sink: sink(),
      labels: [permitted, foreign],
      body: BODY,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await TypeSafeDisclosure.authorize({
      sink: sink(),
      labels: [],
      body: BODY,
    }),
  ).toMatchObject({ ok: false });
  const publicSink: TypeSafeInferenceSink = {
    kind: "typesafe_system_one",
    organisationId: "organisation_disclosure",
    purpose: "case_context_discovery_relationship",
    model: "jev-1.13.0",
    funding: { kind: "organisation_byo", connectionRevision: 1 },
    processing: { kind: "public_fixture", fixtureRevision: 1 },
  };
  expect(
    await TypeSafeDisclosure.authorize({
      sink: publicSink,
      labels: [permitted],
      body: BODY,
    }),
  ).toMatchObject({ ok: false });
  expect(
    (
      await TypeSafeDisclosure.authorize({
        sink: publicSink,
        labels: [],
        body: BODY,
      })
    ).ok,
  ).toBe(true);
}
