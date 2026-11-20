import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import {
  ScheduleLanes,
  type ScheduledAgent,
  type ScheduleRun,
} from "../features/agent-schedules/schedule-lanes";
import {
  PaymentLanes,
  type PaymentStep,
} from "../features/payments/payment-lanes";
import { nowIn, startOfDay, usePeriod, useWiderWhenEmpty } from "../ui";
import type { CaseTimelineCase, ScheduleRunsDay } from "@purin-labs/control-api";
import { EMPTY_AGENT_OPERATIONS_SNAPSHOT, type AgentOperationsTransport } from "../agent-operations";
import type {
  AgentOperationsSnapshot,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { AgentSchedulesPanel } from "../features/agent-schedules/route";
import type { BrainTransport } from "../features/brain/api";

// Two timelines that reuse TimeLanes, with the sample café's Friday:
// `?view=schedules` (Agents › Schedules) and `?view=payments` (Payments).
// `?theme=dark` shows the dark theme. All of it is sample data. `?view=agents` runs the Agents page's Schedules tab itself
// on sample answers of its two reads, the agents and the day's runs, for
// today in this browser's time.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Time lanes preview is development-only.");
const search = new URL(window.location.href).searchParams;
if (search.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";
const view = search.get("view") ?? "schedules";

const DAY = startOfDay(new Date(2026, 9, 30, 12).getTime());
const at = (hour: number, minute = 0): number =>
  DAY + (hour * 60 + minute) * 60_000;
const NOW = at(13, 10);

const AGENTS: readonly ScheduledAgent[] = [
  { agentId: "urk", name: "Sous Chef", role: "coordinator" },
  { agentId: "mailroom", name: "Mailroom", role: "research" },
  { agentId: "pricing", name: "Pricing", role: "specialist" },
];

const stockChecks: ScheduleRun[] = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map(
  (hour) => {
    const past = at(hour, 30) < NOW;
    const failed = hour === 11;
    return {
      runId: `stock-${String(hour)}`,
      agentId: "urk",
      schedule: "Every hour at :30",
      title: "Stock check",
      at: at(hour, 30),
      endedAt: past ? at(hour, failed ? 31 : 33) : null,
      state: past ? (failed ? "failed" : "done") : "planned",
      waitsSince: null,
      startedBy: null,
      caseId: past ? `case_stock_${String(hour)}` : null,
    };
  },
);

const RUNS: readonly ScheduleRun[] = [
  {
    runId: "brief",
    agentId: "urk",
    schedule: "Daily at 07:00",
    title: "Morning brief",
    at: at(7),
    endedAt: at(7, 6),
    state: "done",
    waitsSince: null,
    startedBy: null,
    caseId: "case_brief",
  },
  {
    runId: "butter",
    agentId: "urk",
    schedule: "Side Case",
    title: "Reorder Hokkaido butter",
    at: at(7, 5),
    endedAt: null,
    state: "waiting",
    waitsSince: at(7, 9),
    startedBy: "brief",
    caseId: "case_butter",
  },
  ...stockChecks,
  {
    runId: "sweep-9",
    agentId: "mailroom",
    schedule: "Daily at 09:00",
    title: "Inbox sweep",
    at: at(9),
    endedAt: at(9, 12),
    state: "done",
    waitsSince: null,
    startedBy: null,
    caseId: "case_sweep_9",
  },
  {
    runId: "sweep-13",
    agentId: "mailroom",
    schedule: "Daily at 13:00",
    title: "Inbox sweep",
    at: at(13),
    endedAt: null,
    state: "running",
    waitsSince: null,
    startedBy: null,
    caseId: "case_sweep_13",
  },
  {
    runId: "sweep-17",
    agentId: "mailroom",
    schedule: "Daily at 17:00",
    title: "Inbox sweep",
    at: at(17),
    endedAt: null,
    state: "planned",
    waitsSince: null,
    startedBy: null,
    caseId: null,
  },
  {
    runId: "prices",
    agentId: "pricing",
    schedule: "Fridays at 10:00",
    title: "Weekend price review",
    at: at(10),
    endedAt: at(10, 26),
    state: "done",
    waitsSince: null,
    startedBy: null,
    caseId: "case_prices",
  },
];

const PAYMENTS: readonly PaymentStep[] = [
  {
    stepId: "sencha-1",
    bought: "Sencha tin × 2",
    channel: "online",
    amount: "¥4,320",
    at: at(9, 12),
    state: "declined",
    reason: "the bank declined the card",
    orderCode: null,
    follows: null,
  },
  {
    stepId: "sencha-2",
    bought: "Sencha tin × 2",
    channel: "online",
    amount: "¥4,320",
    at: at(9, 20),
    state: "declined",
    reason: "the bank declined the card",
    orderCode: null,
    follows: "sencha-1",
  },
  {
    stepId: "gift-1",
    bought: "Gift box + 2 more",
    channel: "online",
    amount: "¥9,800",
    at: at(10, 40),
    state: "declined",
    reason: "the card was refused",
    orderCode: null,
    follows: null,
  },
  {
    stepId: "gift-2",
    bought: "Gift box + 2 more",
    channel: "online",
    amount: "¥9,800",
    at: at(10, 52),
    state: "paid",
    reason: null,
    orderCode: "F-062",
    follows: "gift-1",
  },
  {
    stepId: "cake-1",
    bought: "Chestnut cake × 1",
    channel: "counter",
    amount: "¥1,200",
    at: at(11, 30),
    state: "paid",
    reason: null,
    orderCode: null,
    follows: null,
  },
  {
    stepId: "latte-1",
    bought: "Caffè latte × 1",
    channel: "counter",
    amount: "¥600",
    at: at(11, 5),
    state: "declined",
    reason: "the payment was cancelled",
    orderCode: null,
    follows: null,
  },
];

/* ---------- the Schedules tab on sample reads ---------- */

const TODAY = startOfDay(Date.now());

const SNAPSHOT: AgentOperationsSnapshot = {
  ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
  definitions: [
    ["agent_urk", "Sous Chef", "coordinator"],
    ["agent_mailroom", "Mailroom", "research"],
  ].map(([agentDefinitionId, displayName, role]) => ({
    agentDefinitionId: agentDefinitionId ?? "",
    displayName: displayName ?? "",
    role: role ?? "coordinator",
    purpose: "Sample agent.",
    lifecycle: "active" as const,
    currentRevision: {
      revision: 1,
      instructions: "Sample instructions.",
      requestedCapabilities: [],
      skillRefs: [],
      contentDigest: "sample",
    },
  })),
  installations: ["urk", "mailroom"].map((name) => ({
    installationId: `installation_${name}`,
    agentDefinitionId: `agent_${name}`,
    definitionRevision: 1,
    policyRevision: 1,
    grantedCapabilities: [],
    lifecycle: "active" as const,
    areaAssignments: [],
  })),
  scheduleBindings: [
    {
      bindingId: "schedule_brief",
      areaId: "area_cafe",
      scopeIds: [],
      installationId: "installation_urk",
      spec: {
        cadence: "daily",
        timeOfDay: "07:00",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      enabled: true,
      instructionBody: "Morning brief\nList late orders and failed payments.",
      revision: 1,
    },
    {
      bindingId: "schedule_stock",
      areaId: "area_cafe",
      scopeIds: [],
      installationId: "installation_urk",
      spec: { cadence: "hourly", minuteOfHour: 30 },
      enabled: true,
      instructionBody: "Stock check",
      revision: 1,
    },
    {
      bindingId: "schedule_sweep",
      areaId: "area_cafe",
      scopeIds: [],
      installationId: "installation_mailroom",
      spec: {
        cadence: "daily",
        timeOfDay: "17:00",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      enabled: true,
      instructionBody: "Inbox sweep",
      revision: 1,
    },
  ],
};

function sampleCase(
  caseId: string,
  at: number,
  outcome: CaseTimelineCase["outcome"],
  withheld: number,
): CaseTimelineCase {
  return {
    caseId,
    origin: "direct",
    title: null,
    startedAt: at,
    source: { at, trigger: outcome === null ? null : "cue" },
    agent:
      outcome === null ? null : { at, role: "coordinator", state: "completed" },
    context: null,
    spans: [],
    outcome,
    receipt: false,
    withheld,
    sideCaseOf: null,
  };
}

/** The day's runs that the route gives: some readable, one withheld. */
function sampleRuns(
  window: Readonly<{ from: number; to: number }>,
): ScheduleRunsDay {
  // Each :30 of today that has passed ran the stock check, and each run is
  // done, withheld from the reader or failed in turn.
  const runs: ScheduleRunsDay["runs"][number][] = [];
  if (window.from === TODAY)
    for (let at = TODAY + 30 * 60_000; at < Date.now(); at += 3_600_000) {
      const turn = runs.length % 3;
      const outcome: CaseTimelineCase["outcome"] =
        turn === 0
          ? { kind: "done", at: at + 3 * 60_000 }
          : turn === 2
            ? { kind: "failed", at: at + 60_000 }
            : null;
      runs.push({
        bindingId: "schedule_stock",
        installationId: "installation_urk",
        windowKey: `schedule_stock@${String(at)}`,
        dispatchedAt: at,
        case: sampleCase(
          `case_stock_${String(at)}`,
          at,
          outcome,
          outcome === null ? 5 : 0,
        ),
      });
    }
  return {
    from: window.from,
    to: window.to,
    runs,
    withheld: window.from === TODAY ? 1 : 0,
    truncated: false,
  };
}

const SAMPLE_OPERATIONS: AgentOperationsTransport = {
  read: () => Promise.resolve({ ok: true, operations: SNAPSHOT }),
  mutate: () => Promise.reject(new Error("The sample changes nothing.")),
  readRevisions: () => Promise.resolve({ ok: true, revisions: [] }),
};

const SAMPLE_RUNS: BrainTransport = {
  read: (path) => {
    const query = new URL(path, "https://example.invalid").searchParams;
    return Promise.resolve({
      ok: true,
      schedule: sampleRuns({
        from: Number(query.get("from")),
        to: Number(query.get("to")),
      }),
    });
  },
  mutate: () => Promise.reject(new Error("The sample changes nothing.")),
};

/** The days before the sample's Friday that hold the same work again. */
const EARLIER_DAYS = [1, 3, 9];
/** With `quiet=1` the sample's Friday holds nothing, so the week opens. */
const QUIET_TODAY = search.get("quiet") === "1";

/** The sample day and its earlier copies, inside the period in view. */
function across<Item>(
  items: readonly Item[],
  period: Readonly<{ from: number; to: number }>,
  time: (item: Item) => number,
  copy: (item: Item, by: number, days: number) => Item,
): readonly Item[] {
  const all = [
    ...(QUIET_TODAY ? [] : items),
    ...EARLIER_DAYS.flatMap((days) =>
      items.map((item) => copy(item, -days * 86_400_000, days)),
    ),
  ];
  return all.filter((item) => {
    const at = time(item);
    return at >= period.from && at < period.to;
  });
}

const later = (at: number | null, by: number): number | null =>
  at === null ? null : at + by;

function Preview(): React.ReactNode {
  const control = usePeriod(NOW);
  const { period } = control;
  const now = nowIn(period, NOW);
  const payments = across(
    PAYMENTS,
    period,
    (step) => step.at,
    (step, by, days) => ({
      ...step,
      stepId: `${step.stepId}-${String(days)}`,
      at: step.at + by,
      follows: step.follows === null ? null : `${step.follows}-${String(days)}`,
    }),
  );
  const runs = across(
    RUNS,
    period,
    (run) => run.at,
    (run, by, days) => ({
      ...run,
      runId: `${run.runId}-${String(days)}`,
      at: run.at + by,
      // An earlier day's run has finished.
      state: (run.state === "failed" || run.state === "ran"
        ? run.state
        : "done") as ScheduleRun["state"],
      endedAt: later(run.endedAt ?? run.at + 600_000, by),
      waitsSince: null,
      startedBy:
        run.startedBy === null ? null : `${run.startedBy}-${String(days)}`,
    }),
  );
  const shown = view === "payments" ? payments : runs;
  useWiderWhenEmpty(
    control,
    view === "agents" ? null : period,
    shown.length === 0,
  );
  if (view === "agents")
    return (
      <main className="portal-main" style={{ padding: "28px" }}>
        <div className="portal-main-inner">
          <header className="portal-heading">
            <h1>Agents</h1>
            <p>Schedules, on sample reads of the agents and their runs.</p>
          </header>
          <AgentSchedulesPanel
            organisationId="organisation_preview"
            operations={SAMPLE_OPERATIONS}
            transport={SAMPLE_RUNS}
            onOpenCase={() => undefined}
          />
        </div>
      </main>
    );
  const heading =
    view === "payments"
      ? ["Payments", "Card payments, and how each declined one recovers."]
      : [
          "Schedules",
          "Each agent's scheduled runs today, and the runs still to come.",
        ];
  return (
    <main className="portal-main" style={{ padding: "28px" }}>
      <div className="portal-main-inner">
        <header className="portal-heading">
          <h1>{heading[0]}</h1>
          <p>{heading[1]}</p>
        </header>
        {view === "payments" ? (
          <PaymentLanes
            control={control}
            now={now}
            steps={payments}
            taken="¥11,000"
          />
        ) : (
          <ScheduleLanes
            control={control}
            now={now}
            agents={AGENTS}
            runs={runs}
            onOpenCase={() => undefined}
          />
        )}
      </div>
    </main>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
