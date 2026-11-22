import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { parseScheduleRunsDay, type ScheduleRunsDay } from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import { runAgentOperation } from "@purin-labs/conversation/data/agent-operation-runner";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import type { AgentOperationInput } from "@purin-labs/agent/data/agent-operations";
import { parseUserId } from "@purin-labs/control-api/ids";
import type { IngressQueueMessage } from "../../src/ingress-queue";
import gateway from "../../src/integration-gateway";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { runScheduleDispatch } from "@purin-labs/agent/schedules/dispatch";
import { executionRequest, readCaseTimeline } from "./case-execution-support";
import { commerceClient } from "./commerce-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  createRequiredGrant,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    scheduleRuns?: Record<string, unknown>;
  }
}

/**
 * An agent's schedule runs on the Agents page (Agents › Schedules), and what
 * a run did reaches the members of the schedule's Project (Plan 42J).
 *
 * An administrator installs an agent with an hourly schedule through the
 * agent operations that the Portal sends. The schedule names the default
 * Project as the Project that receives its results. The owner grants the
 * schedule its automation, its Case read and the integration list, as the
 * Access page does, and the Access page shows where that schedule's results
 * go. The window of the hour is due: the dispatcher sends one queue message,
 * and the Worker opens a Case for it. The agent reads the Organisation's
 * integrations under the schedule's own grant, then answers.
 *
 * The administrator, who sits in the default Project, reads the runs of the
 * day: one run of that schedule, titled with the first line of its
 * instruction, finished, with no record withheld, exactly as the
 * administrator's Activity timeline shows that Case. A second
 * administrator, with the same Case read grant and no seat in that Project,
 * reads the same run: a Project groups work and hides none of it from the
 * Organisation's members (Plan 27C). A window longer than a week is refused.
 */
it(
  "shows a schedule's runs to each member who reads the Organisation's Cases",
  scheduleRuns,
  90_000,
);

const HOUR = 3_600_000;

type Person = Readonly<{
  userId: string;
  personId: string;
  session: IssuedControlSession;
}>;

async function scheduleRuns({ task }: TestContext): Promise<void> {
  const joining = [await joiner(), await joiner()] as const;
  await installSlackActorFixture();
  const reader = await admin(joining[0], "Schedule reader", true);
  const outsider = await admin(joining[1], "Outside reader", false);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_schedule_runs', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    ORGANISATION_ID,
  );
  if (!resolved.ok) throw new Error("Organisation scope missing");
  const scope = resolved.value;

  // The agent and its schedule, as the Portal's agent operations make them.
  const operate = async (
    operationId: string,
    operation: AgentOperationInput,
    now: number = Date.now(),
  ): Promise<void> => {
    const userId = parseUserId(reader.userId);
    if (!userId.ok) throw new Error("User missing");
    const done = await runAgentOperation({
      env,
      scope,
      operation,
      operationId,
      now,
      actor: {
        userId: userId.value,
        personId: reader.personId,
        role: "admin",
        origin: {
          kind: "control_session",
          controlSessionId: reader.session.session.controlSessionId,
        },
      },
    });
    if (!done.ok) throw new Error(`${operationId}: ${JSON.stringify(done)}`);
  };
  await operate("area_schedule_runs", {
    kind: "create_area",
    name: "Stock",
    purpose: "Check stock each hour.",
  });
  await operate("agent_schedule_runs", {
    kind: "create_agent_definition",
    displayName: "Stock checker",
    role: "coordinator",
    purpose: "Check stock.",
    instructions: "Report the items that run low.",
    requestedCapabilities: [CAPABILITY_KEYS.integrationDiscoveryRead],
    skillRefs: [],
  });
  await operate("installation_schedule_runs", {
    kind: "install_agent",
    agentDefinitionId: "agent_schedule_runs",
    definitionRevision: 1,
    areaId: "area_schedule_runs",
    responsibility: "Check stock each hour.",
    scopeIds: [],
    policyRevision: 1,
    grantedCapabilities: [CAPABILITY_KEYS.integrationDiscoveryRead],
  });
  await operate("governance_schedule_runs", {
    kind: "configure_installation_governance",
    installationId: "installation_schedule_runs",
    maxSessionBudgetTokens: 25_000,
  });
  await operate(
    "schedule_stock_hourly",
    {
      kind: "configure_schedule_binding",
      areaId: "area_schedule_runs",
      installationId: "installation_schedule_runs",
      scopeIds: [],
      spec: { cadence: "hourly", minuteOfHour: 0 },
      enabled: true,
      instructionBody:
        "Check stock\nCount the flour and butter left for tomorrow's bake.",
    },
    // Set up two hours ago, so the window of this hour is due now.
    Date.now() - 2 * HOUR,
  );

  // The owner lets the schedule read its Case and list the Organisation's
  // integrations, as the Access page's grants do.
  await createRequiredGrant({
    grantId: "grant_schedule_runs_case_read",
    subject: {
      kind: "workflow",
      workflowKind: "cue_subscription",
      workflowId: "schedule_stock_hourly",
      workflowRevision: 1,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  await createRequiredGrant({
    grantId: "grant_schedule_runs_discovery",
    subject: {
      kind: "workflow",
      workflowKind: "cue_subscription",
      workflowId: "schedule_stock_hourly",
      workflowRevision: 1,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  // The window is due: one queue message, which the Worker turns into a
  // Case that the agent finishes.
  const queued: IngressQueueMessage[] = [];
  const dispatched = await runScheduleDispatch({
    env,
    queue: {
      send: async (message: IngressQueueMessage) => {
        queued.push(message);
      },
      sendBatch: async () => {
        throw new Error("unused");
      },
    } as unknown as Queue<IngressQueueMessage>,
    now: Date.now(),
  });
  expect(dispatched.dispatched).toBe(1);
  expect(queued).toHaveLength(1);
  const model = scheduledModel();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", model.reply),
  );
  await deliver(queued[0]);

  const window = { from: Date.now() - HOUR, to: Date.now() + HOUR };
  // The run's Case is the one the reader's Activity timeline shows: the
  // same records, with the instruction, the integration read and the answer
  // all open.
  let run: ScheduleRunsDay["runs"][number] | undefined;
  await expect
    .poll(
      async () => {
        const day = await runsOf(reader, window);
        run = day.runs[0];
        const timeline = await readCaseTimeline(
          ORGANISATION_ID,
          reader.session,
          window,
        );
        const event = timeline.timeline?.cases.find(
          (item) => item.caseId === run?.case.caseId,
        );
        return (
          day.runs.length === 1 &&
          day.withheld === 0 &&
          run?.case.outcome?.kind === "done" &&
          event !== undefined &&
          JSON.stringify(event) === JSON.stringify(run?.case)
        );
      },
      { timeout: 45_000, interval: 500 },
    )
    .toBe(true);
  expect(model.calls()).toBe(2);
  expect(run).toMatchObject({
    bindingId: "schedule_stock_hourly",
    installationId: "installation_schedule_runs",
    case: {
      origin: "direct",
      title: "Check stock",
      outcome: { kind: "done" },
      withheld: 0,
    },
  });
  expect(run?.windowKey).toMatch(/\/hourly$/u);

  const elsewhere = await runsOf(outsider, window);
  expect(elsewhere).toMatchObject({ withheld: 0, truncated: false });
  expect(elsewhere.runs).toEqual([run]);

  // A month holds the same run, and a longer window is refused.
  const month = await runsOf(reader, {
    from: window.from - 30 * 24 * HOUR,
    to: window.to,
  });
  expect(month.runs).toEqual([run]);

  const tooLong = await executionRequest(
    ORGANISATION_ID,
    reader.session,
    `/case-executions/schedule-runs?from=0&to=${String(33 * 24 * HOUR)}`,
  );
  expect(tooLong.status).toBe(400);

  task.meta.scheduleRuns = {
    run: {
      bindingId: run?.bindingId,
      windowKey: run?.windowKey,
      caseId: run?.case.caseId,
      title: run?.case.title,
      outcome: run?.case.outcome?.kind,
      withheld: run?.case.withheld,
    },
    outsider: elsewhere,
  };
}

async function runsOf(
  person: Person,
  window: Readonly<{ from: number; to: number }>,
): Promise<ScheduleRunsDay> {
  const read = await executionRequest(
    ORGANISATION_ID,
    person.session,
    `/case-executions/schedule-runs?from=${String(window.from)}&to=${String(window.to)}`,
  );
  expect(read.status).toBe(200);
  const body = read.body as { schedule?: unknown };
  const day = parseScheduleRunsDay(body.schedule);
  if (day === null) throw new Error(JSON.stringify(read.body));
  return day;
}

/** Delivers one queue message to the Worker, as the queue would. */
async function deliver(body: unknown): Promise<void> {
  let retried = false;
  const message: Message<unknown> = {
    id: "schedule-runs-queue",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => undefined,
    retry: () => {
      retried = true;
    },
  };
  await gateway.queue(
    {
      queue: "pantry-events",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
      messages: [message],
      ackAll: () => undefined,
      retryAll: () => {
        retried = true;
      },
    } as unknown as MessageBatch<unknown>,
    env,
  );
  expect(retried).toBe(false);
}

/**
 * The scheduled agent's model: it lists the Organisation's integrations, then
 * answers from what the list returned.
 */
function scheduledModel(): Readonly<{
  reply: HttpResponseResolver;
  calls: () => number;
}> {
  let calls = 0;
  return {
    calls: () => calls,
    reply: async ({ request }) => {
      const body = JSON.stringify(await request.json());
      calls += 1;
      if (calls === 1) {
        expect(body).toContain("integration_list");
        return openRouterToolCall(
          "integration_list",
          {},
          "tool_schedule_runs_integrations",
        );
      }
      expect(body).toContain("integration_ref_");
      return openRouterText(
        "Stock is fine; Slack is connected.",
        "chatcmpl_schedule_runs",
      );
    },
  };
}

async function joiner() {
  const client = await commerceClient(`schedule-runs-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  return { client, personId, slot: { client, laterPersonId: personId } };
}

/**
 * An administrator with the Case read grant, with or without a seat in the
 * default Project, where a scheduled run files its Case.
 */
async function admin(
  joining: Awaited<ReturnType<typeof joiner>>,
  displayName: string,
  seated: boolean,
): Promise<Person> {
  const userId = joining.client.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(ORGANISATION_ID, joining.personId, displayName),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      )
      .bind(ORGANISATION_ID, userId, joining.personId, Date.now()),
    ...(seated
      ? [
          fixtureDatabase()
            .prepare(
              `INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
             SELECT organisation_id, project_id, ?, 'editor'
             FROM organisation_default_project WHERE organisation_id = ?`,
            )
            .bind(userId, ORGANISATION_ID),
        ]
      : []),
  ]);
  const granted = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: `grant_${userId}`,
    subject: { kind: "person", personId: joining.personId },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_schedule_runs",
    },
    now: Date.now(),
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return {
    userId,
    personId: joining.personId,
    session: joining.client.session,
  };
}
