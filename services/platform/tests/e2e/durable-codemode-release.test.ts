import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { isRecord } from "@seams/std";
import {
  DISCOVER_INTEGRATION_LIST,
  lastToolText,
  messageText,
  readGovernorLedger,
  readOrganisationLedger,
  scriptReply,
  sendThreadMessage,
  startScriptTurn,
} from "./durable-codemode-journey-support";

// Plan 50A, Phase G. The rehearsal of a release that changes the sandbox
// contract. An operator freezes Code Mode admission through the cutover
// route, waits until no execution is live, releases, and opens admission.
// The route, the governor, the Session, and the sandbox Worker are the real
// ones. The model responses are controlled.

const CUTOVER = "https://localhost/v1/admin/code-mode-platform-cutover";
const SCRIPT =
  "const first = JSON.parse(await tools.integration_list({})); const second = JSON.parse(await tools.integration_list({})); text({ reads: 2, accounts: [first.accounts.length, second.accounts.length] });";

const SCRIPT_REPORT = /\{"reads":2,"accounts":\[([1-9]\d*),\1\]\}/;

it("drains Code Mode through the cutover route before a release, and admits scripts again after it", async (test) => {
  // A script of the first turn is running: its first read is in flight.
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeRelease",
    completions: ["held"],
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(SCRIPT),
      { text: "DRAINED" },
      scriptReply(SCRIPT),
      { text: "REFUSED" },
      scriptReply(SCRIPT),
      { text: "ADMITTED" },
    ],
  });
  const before = await inspectCutover();
  expect(before.admission).toMatchObject({ state: "open" });
  expect(before.blockers).toEqual(
    expect.arrayContaining([
      { kind: "admission_open" },
      { kind: "live_root_reservations", count: 1 },
    ]),
  );

  // The operator freezes admission. The running script still holds its
  // reservation, so the release waits.
  expect(await controlCutover("freeze_admission")).toMatchObject({
    state: "frozen",
  });
  const frozen = await inspectCutover();
  expect(frozen.blockers).toContainEqual({
    kind: "live_root_reservations",
    count: 1,
  });
  expect(frozen.blockers).not.toContainEqual({ kind: "admission_open" });

  // The script stops at its next read and settles. No execution is live.
  journey.releaseHeld();
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);
  expect(lastToolText(journey.requests[2])).toContain(
    "Code Mode admission is frozen",
  );
  const drained = await inspectCutover();
  expect(drained.blockers.map(blockerKind)).not.toContain(
    "live_root_reservations",
  );
  // No document of Pi holds the state of a script: a release that changes
  // the sandbox finds nothing to refuse.
  const documents = await runInDurableObject(
    journey.session,
    readScriptDocuments,
  );
  expect(documents.length).toBeGreaterThan(0);
  expect(documents.every(isRetired)).toBe(true);

  // A turn that arrives during the freeze runs. Its script is refused
  // before it reserves anything.
  await sendThreadMessage(
    "message",
    "EvDurableCodemodeReleaseFrozen",
    "1787500000.000003",
    "Read the integration metadata again.",
  );
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(2);
  expect(lastToolText(journey.requests[4])).toContain(
    "code_mode_platform_disabled",
  );
  expect(
    (await runInDurableObject(journey.governor, readGovernorLedger))
      .reservations,
  ).toHaveLength(1);

  // The release is deployed here. The operator opens admission, and the
  // script of the next turn runs and settles.
  expect(await controlCutover("open_admission")).toMatchObject({
    state: "open",
  });
  await sendThreadMessage(
    "message",
    "EvDurableCodemodeReleaseOpen",
    "1787500000.000005",
    "Read the integration metadata one more time.",
  );
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(3);
  expect(lastToolText(journey.requests[6])).toMatch(SCRIPT_REPORT);
  const after = await inspectCutover();
  expect(after.admission).toMatchObject({ state: "open" });
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(governor.reservations).toMatchObject([
    { state: "settled" },
    { state: "settled" },
  ]);
  expect(
    (await readOrganisationLedger(journey.organisation)).reservations,
  ).toMatchObject([{ state: "settled" }, { state: "settled" }]);
  expect(journey.slack.messages.map(messageText)).toEqual([
    "DRAINED",
    "REFUSED",
    "ADMITTED",
  ]);

  Object.assign(test.task.meta, {
    evidence: {
      route: "/v1/admin/code-mode-platform-cutover",
      blockers: {
        before: before.blockers.map(blockerKind),
        frozenWithOneScript: frozen.blockers.map(blockerKind),
        drained: drained.blockers.map(blockerKind),
        opened: after.blockers.map(blockerKind),
      },
      scriptDocumentsRetired: documents.length,
      refusal: "code_mode_platform_disabled",
      reservations: governor.reservations.length,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 120_000);

type Cutover = {
  readonly admission: unknown;
  readonly blockers: readonly { readonly kind: string }[];
};

function blockerKind(blocker: { readonly kind: string }): string {
  return blocker.kind;
}

function isRetired(document: { readonly retired: number }): boolean {
  return document.retired === 1;
}

async function inspectCutover(): Promise<Cutover> {
  const response = await exports.default.fetch(
    new Request(CUTOVER, { headers: adminHeaders() }),
  );
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    body.ok !== true ||
    !isRecord(body.cutover) ||
    !Array.isArray(body.cutover.blockers)
  )
    throw new Error(`Cutover inspection failed: ${JSON.stringify(body)}`);
  return {
    admission: body.cutover.admission,
    blockers: body.cutover.blockers.filter(isBlocker),
  };
}

function isBlocker(value: unknown): value is { readonly kind: string } {
  return isRecord(value) && typeof value.kind === "string";
}

async function controlCutover(
  command: "freeze_admission" | "open_admission",
): Promise<unknown> {
  const response = await exports.default.fetch(
    new Request(CUTOVER, {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        command,
        idempotencyKey: `release-rehearsal-${command}-${crypto.randomUUID()}`,
        reason: "Release that changes the sandbox contract",
      }),
    }),
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || body.ok !== true)
    throw new Error(`Cutover command failed: ${JSON.stringify(body)}`);
  return body.admission;
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}` };
}

/** The documents of Pi that hold the state of an unfinished script. */
function readScriptDocuments(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ kind: string; retired: number }>(
      "SELECT kind, retired_at IS NOT NULL AS retired FROM documents WHERE kind IN (?, ?, ?)",
      JSON.stringify("pi.codemode.journal"),
      JSON.stringify("pi.codemode.run"),
      JSON.stringify("pi.tool.nested-call"),
    )
    .toArray();
}
