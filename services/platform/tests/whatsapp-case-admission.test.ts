import { insertDefaultProject } from "./fixtures/default-project";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { platformEnv } from "./worker-fakes";
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(createMocks);

vi.mock("../src/data/organisation-workspace", () => ({
  ensureOrganisationDefaultWorkspace: mocks.ensureOrganisationDefaultWorkspace,
}));

vi.mock("../src/actors/actor-router", () => ({
  resolveActiveCaseActorAtPlacement: mocks.resolveActiveCaseActorAtPlacement,
}));

import { admitWhatsAppSupportCase } from "../src/actors/whatsapp-case-admission";
import { parseOrganisationId } from "../src/ids";

const META_MESSAGE_ID =
  "wamid.HBgMNjE0MzM2NDE3NzAVAgARGBI3QjQ4RkZGQ0Q0QTQxRDgA==";
const ORGANISATION_ID = "organisation_whatsapp_case_admission";
const CASE_ID = "case_whatsapp_61433641770_1";

describe("WhatsApp Case admission", whatsappCaseAdmissionSuite);

function whatsappCaseAdmissionSuite(): void {
  beforeEach(resetMocks);

  it(
    "derives a queue-safe Case entry identity from a Meta message ID",
    derivesQueueSafeEntryIdentity,
  );
}

async function derivesQueueSafeEntryIdentity(): Promise<void> {
  const db = createMigratedDatabase();
  const identity = parseOrganisationId(ORGANISATION_ID);
  if (!identity.ok) throw new Error(identity.error.code);
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'test-organisation', 'Test organisation', 0)",
    )
    .bind(identity.value)
    .run();
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: identity.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  const environment = platformEnv({
    DB: db,
    ARCHIVE: {},
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const admission = {
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      identity.value,
    ),
    organisationId: ORGANISATION_ID,
    integrationAccountId: "integration_account_whatsapp_case_admission",
    customerWaId: "61433641770",
    caseId: CASE_ID,
    providerMessageIds: [META_MESSAGE_ID],
    supportBindingId: "whatsapp_support_binding",
    bindingRevision: 1,
    policyVersion: 1,
    receivedAt: 1_000,
  };
  // An Organisation with no default Project admits nothing and opens no Case.
  await expect(
    admitWhatsAppSupportCase(environment, admission),
  ).resolves.toEqual({
    ok: false,
    error: { code: "default_project_unavailable" },
  });
  expect(mocks.ensureCase).not.toHaveBeenCalled();
  await insertDefaultProject(db, identity.value);
  const admitted = await admitWhatsAppSupportCase(environment, admission);

  expect(admitted).toEqual({ ok: true, value: { kind: "accepted" } });
  await expect(
    db
      .prepare(
        `SELECT cp.revision, cp.project_id = d.project_id AS inDefaultProject
         FROM case_project cp
         JOIN organisation_default_project d ON d.organisation_id = cp.organisation_id
         WHERE cp.organisation_id = ? AND cp.case_id = ?`,
      )
      .bind(identity.value, CASE_ID)
      .all(),
  ).resolves.toMatchObject({ results: [{ revision: 1, inDefaultProject: 1 }] });
  const expectedTriggerId = `trigger_whatsapp_${createHash("sha256").update(META_MESSAGE_ID).digest("hex")}`;
  expect(mocks.acceptTrigger).toHaveBeenCalledWith(
    expect.objectContaining({
      triggerId: expectedTriggerId,
      content: {
        kind: "text",
        text: expect.stringContaining(META_MESSAGE_ID),
      },
    }),
  );
}

function createMocks() {
  return {
    ensureOrganisationDefaultWorkspace: vi.fn(),
    resolveActiveCaseActorAtPlacement: vi.fn(),
    ensureCase: vi.fn(),
    acceptTrigger: vi.fn(),
    attachBinding: vi.fn(),
  };
}

function resetMocks(): void {
  vi.resetAllMocks();
  mocks.ensureOrganisationDefaultWorkspace.mockResolvedValue({
    ok: true,
    value: { revision: "workspace_revision_whatsapp_case_admission" },
  });
  mocks.ensureCase.mockResolvedValue({
    ok: true,
    value: { kind: "ensured", revision: 1 },
  });
  mocks.acceptTrigger.mockResolvedValue({
    ok: true,
    value: { kind: "accepted", revision: 2 },
  });
  mocks.attachBinding.mockResolvedValue({
    ok: true,
    value: { kind: "attached", revision: 3 },
  });
  mocks.resolveActiveCaseActorAtPlacement.mockResolvedValue({
    ok: true,
    value: {
      ensure: mocks.ensureCase,
      acceptTrigger: mocks.acceptTrigger,
      attachBinding: mocks.attachBinding,
    },
  });
}
