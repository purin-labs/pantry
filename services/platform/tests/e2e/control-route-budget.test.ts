import { AsyncLocalStorage } from "node:async_hooks";

import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
  type EvalContent,
  type MemoryCommand,
  type MemoryContent,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@seams/commerce-client";

import { SessionDO } from "../../src/actors/agent-session";
import { CaseDO } from "../../src/actors/case";
import { ConnectorDO } from "../../src/actors/connector";
import { ConversationResidencyActor } from "../../src/actors/conversation-residency";
import { OrganisationDO } from "../../src/actors/organisation";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { storeVaultSecret } from "../../src/credential-vault";
import { registerEmailMailboxAccount } from "../../src/data/email-mailbox";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../src/mail/gmail-authorization";
import { parseIntegrationAccountId } from "../../src/ids";
import { requireVaultHandle } from "../test-ids";
import {
  command,
  controlPaths,
  createConversation,
  installMemoryFixture,
  instruct,
  instructionEntry,
  post,
  type Member,
} from "./memory-support";

/**
 * The storage work of one Portal read, from the request to its response.
 *
 * The deployed Worker runs where the request enters. Its databases and its
 * Actors stay in the Organisation's region, so each database round trip and
 * each Actor call that the Worker makes crosses that distance. A round trip is
 * one statement execution or one batch. Round trips that an Actor makes are
 * next to its database and are counted apart.
 *
 * The account authority is another service. Each request that the Worker
 * sends to it is an account call, and it is held like a round trip.
 *
 * A wave starts when the Worker begins a round trip, an Actor call or an
 * account call while none is in flight, so work that runs together counts
 * once. A paced request holds each of them for a fixed time. Its elapsed time
 * over that hold is the number the request waits for one after another, which
 * is what a deployed request pays for.
 *
 * The test databases are one database. A deployed scope resolution that reads
 * the regional fence after the global placement adds one round trip in
 * sequence; `scopeResolutions` counts the places where that read is missing
 * here.
 */
type RouteBudget = {
  readonly route: string;
  readonly status: number;
  readonly workerRoundTrips: number;
  readonly workerStatements: number;
  readonly actorCalls: number;
  /** Requests that the Worker sent to the account authority. */
  readonly accountCalls: number;
  readonly waves: number;
  readonly scopeResolutions: number;
  readonly actorRoundTrips: number;
  readonly unpacedMs: number;
  readonly pacedMs: number;
  /**
   * Round trips, Actor calls and account calls that the paced request waited
   * for in sequence.
   */
  readonly inSequence: number;
  /**
   * Each Worker round trip, Actor call and account call: its wave, what it
   * was, its callers.
   */
  readonly sites: readonly Site[];
  /** The round trips that Actors made, counted by statement. */
  readonly actorSites: Readonly<Record<string, number>>;
};

type Site = readonly [wave: number, operation: string, callers: string];

const PACED_MS = 40;
/**
 * Set while a method of an Actor runs, and in everything that the method
 * waits for. The Worker's own work runs outside it.
 */
const insideActor = new AsyncLocalStorage<true>();
/** The scope resolution that reads the regional fence in a second step. */
const SEQUENTIAL_SCOPE_RESOLUTION = "OrganisationExecutionScope.resolve (";

type Counter = {
  workerRoundTrips: number;
  workerStatements: number;
  actorCalls: number;
  accountCalls: number;
  waves: number;
  scopeResolutions: number;
  actorRoundTrips: number;
  inFlight: number;
  holdMs: number;
  sites: Site[];
  actorSites: Record<string, number>;
};

it(
  "records the database round trips and Actor calls that each Portal read waits for",
  { timeout: 180_000 },
  controlRouteBudgetJourney,
);

async function controlRouteBudgetJourney(test: TestContext): Promise<void> {
  const { operator, conversationId } = await installPortalFixture();
  const mailbox = await installMailbox(operator);
  const organisation = controlPaths(operator.organisationId).organisation;
  const reads: readonly Readonly<{ route: string; path: string }>[] = [
    {
      route: "chat-thread",
      path: `${organisation}/chat?conversation=${conversationId}`,
    },
    { route: "chat-directory", path: `${organisation}/chat` },
    { route: "session", path: "/v1/control/session" },
    { route: "organisation", path: organisation },
    { route: "memories", path: `${organisation}/memories` },
    { route: "evals", path: `${organisation}/evals` },
    { route: "brain-summary", path: `${organisation}/brain/summary` },
    {
      route: "agent-mailbox",
      path: `${organisation}/agent-mailboxes/${mailbox}`,
    },
    { route: "email-reviews", path: `${organisation}/email-reviews` },
    { route: "inbox-conversations", path: `${organisation}/inbox-conversations` },
    { route: "home", path: `${organisation}/home` },
    { route: "inference-codex", path: `${organisation}/inference/codex` },
    {
      route: "preferences-appearance",
      path: "/v1/control/user/preferences/appearance",
    },
  ];

  const counter = emptyCounter();
  test.onTestFinished(observeStorage(counter));
  const budgets: RouteBudget[] = [];
  for (const read of reads) {
    // The first read of a route can write what later reads only check.
    const warm = await post(operator, read.path, null);
    await warm.arrayBuffer();
    await storageQuiet(counter);

    Object.assign(counter, emptyCounter());
    const unpacedStart = Date.now();
    const response = await post(operator, read.path, null);
    const body: unknown = await response.json();
    const unpacedMs = Date.now() - unpacedStart;
    const counted = {
      ...counter,
      sites: [...counter.sites],
      actorSites: { ...counter.actorSites },
    };
    expect(response.status, `${read.route}: ${JSON.stringify(body)}`).toBe(200);
    await storageQuiet(counter);

    counter.holdMs = PACED_MS;
    const pacedStart = Date.now();
    const paced = await post(operator, read.path, null);
    await paced.arrayBuffer();
    const pacedMs = Date.now() - pacedStart;
    counter.holdMs = 0;
    await storageQuiet(counter);

    budgets.push({
      route: read.route,
      status: response.status,
      workerRoundTrips: counted.workerRoundTrips,
      workerStatements: counted.workerStatements,
      actorCalls: counted.actorCalls,
      accountCalls: counted.accountCalls,
      waves: counted.waves,
      scopeResolutions: counted.scopeResolutions,
      actorRoundTrips: counted.actorRoundTrips,
      unpacedMs,
      pacedMs,
      inSequence: Math.round((pacedMs / PACED_MS) * 10) / 10,
      sites: counted.sites,
      actorSites: counted.actorSites,
    });
  }

  const session = await post(operator, "/v1/control/session", null);
  const signedIn: unknown = await session.json();
  expect(isRecord(signedIn) ? signedIn.memberships : null).toHaveLength(1);
  const listed = await post(operator, `${organisation}/memories`, null);
  const memories: unknown = await listed.json();
  expect(isRecord(memories) ? memories.memories : null).toHaveLength(3);
  // The Portal's page-order check replays these responses without a backend.
  const responses: Record<string, { status: number; body: unknown }> = {};
  for (const path of [
    ...reads.map((read) => read.path),
    `${organisation}/inference`,
    `${organisation}/commerce-system`,
    `${organisation}/mail-inbox`,
    `${organisation}/custom-connectors`,
    `${organisation}/integrations/typesafe`,
    "/v1/control/user/preferences/chat",
    "/v1/control/user/preferences/bakeryos",
  ]) {
    const response = await post(operator, path, null);
    responses[`GET ${path}`] = {
      status: response.status,
      body: await response.json(),
    };
  }
  Object.assign(test.task.meta, {
    controlRouteBudget: { pacedMsPerRoundTrip: PACED_MS, routes: budgets },
    controlRouteResponses: responses,
  });
}

/**
 * An active Organisation that the account authority knows. Its operator, an
 * administrator, has three Memories and two Evals to read, each of which
 * cites an accepted Case entry. Each read below passes the real account check.
 */
async function installPortalFixture(): Promise<{
  operator: Member;
  conversationId: ConversationId;
}> {
  const {
    organisationId,
    organisation,
    reviewer: operator,
    route,
  } = await installMemoryFixture();
  // The fixture names an activation receipt; the Organisation read needs it.
  const activatedAt = Date.now();
  const activation = await fixtureDatabase().prepare(
    "SELECT activation_receipt_id AS receiptId FROM organisation_onboarding WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ receiptId: string | null }>();
  if (typeof activation?.receiptId !== "string")
    throw new Error("fixture names no activation receipt");
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      `INSERT INTO organisation_activation_attempt (
         activation_attempt_id, organisation_id, readiness_version,
         readiness_hash, status, started_at, updated_at, completed_at
       ) VALUES ('attempt_control_budget', ?, 1, 'hash_control_budget',
         'completed', ?, ?, ?)`,
    ).bind(organisationId, activatedAt, activatedAt, activatedAt),
    fixtureDatabase().prepare(
      `INSERT INTO organisation_activation_receipt (
         activation_receipt_id, activation_attempt_id, organisation_id,
         readiness_hash, policy_snapshot_id, cue_snapshot_id,
         capability_profile, activated_at
       ) VALUES (?, 'attempt_control_budget', ?,
         'hash_control_budget', 'policy_control_budget', 'cue_control_budget',
         'read_and_propose', ?)`,
    ).bind(activation.receiptId, organisationId, activatedAt),
  ]);
  const conversationId = newConversationId();
  await createConversation(operator, conversationId, route);
  await instruct(operator, conversationId, "control_budget_instruction");
  const entry = await instructionEntry(operator, conversationId);
  const content: MemoryContent = {
    memoryKind: "fact",
    statement: "Next-day orders for the primary supplier close at noon.",
    applicability: {
      kind: "commerce_entity",
      merchantId: "merchant_e2e",
      entity: parseEntityRef({
        origin: "custom",
        typeId: SUPPLIER_ENTITY_TYPE_ID,
        entityId: "supplier_primary",
      }),
    },
    validity: {
      timezone: "Australia/Sydney",
      effectiveFrom: "2026-10-01",
      effectiveUntil: null,
      dependsOn: [entry.evidence],
    },
    evidence: [entry.evidence],
    sourceCaseId: entry.evidence.caseId,
  };
  for (const index of [1, 2, 3]) {
    const propose: MemoryCommand = {
      commandId: `control_budget_memory_${String(index)}`,
      expectedRevision: 0,
      kind: "propose",
      memoryId: null,
      submission: "own_input",
      content: {
        ...content,
        statement: `${content.statement} Note ${String(index)}.`,
      },
    };
    const proposed = await command(operator, propose);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  }
  for (const index of [1, 2]) {
    const evalContent: EvalContent = {
      title: `Next-day order cutoff ${String(index)}`,
      subject: {
        kind: "mailbox_reply",
        integrationAccountId: "integration_account_control_budget",
      },
      scenarios: [
        {
          scenarioId: "late_change",
          role: "target",
          title: "Order change after the cutoff",
          sender: {
            verificationId: "verification_primary_supplier",
            revision: 1,
          },
          message: {
            subject: "Change to tomorrow's order",
            body: "Please add ten cases of butter to tomorrow's delivery.",
            receivedAt: Date.UTC(2026, 9, 12, 4, 30),
            timezone: "Australia/Sydney",
          },
          criteria: [
            {
              criterionId: "escalates",
              kind: "outcome",
              expected: "approval_required",
            },
          ],
        },
      ],
      evidence: [entry.evidence],
      sourceCaseId: entry.evidence.caseId,
    };
    const proposed = await organisation.commandEval({
      organisationId,
      principal: {
        kind: "agent",
        caseId: entry.evidence.caseId,
        assignmentId: "assignment_control_budget",
        sessionId: "session_control_budget",
      },
      body: {
        commandId: `control_budget_eval_${String(index)}`,
        content: evalContent,
      },
      flowLabel: entry.inputLabel,
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
  }
  return { operator, conversationId };
}

async function installMailbox(operator: Member): Promise<string> {
  const organisationId = operator.organisationId;
  const now = Date.now();
  const handle = requireVaultHandle(
    `vault:${organisationId.toLowerCase()}:gmail:budget:oauth:g1`,
  );
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle,
    now,
    secret: {
      kind: "oauth_tokens",
      accessToken: "control-budget-token",
      refreshToken: "control-budget-refresh",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: "budget",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: operator.userId,
    providerAccountId: "budget",
    accountKind: "mailbox",
    displayName: "budget",
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const accountId = parseIntegrationAccountId(
    connected.account.integrationAccountId,
  );
  if (!accountId.ok) throw new Error(accountId.error.code);
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId.value,
    environment: "development",
    googleSubject: "budget",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return accountId.value;
}

function emptyCounter(): Counter {
  return {
    workerRoundTrips: 0,
    workerStatements: 0,
    actorCalls: 0,
    accountCalls: 0,
    waves: 0,
    scopeResolutions: 0,
    actorRoundTrips: 0,
    inFlight: 0,
    holdMs: 0,
    sites: [],
    actorSites: {},
  };
}

/** Work that follows a response belongs to the read that caused it. */
async function storageQuiet(counter: Counter): Promise<void> {
  let seen = -1;
  let quietChecks = 0;
  while (quietChecks < 3) {
    await scheduler.wait(50);
    const total = counter.workerRoundTrips + counter.actorRoundTrips;
    quietChecks =
      counter.inFlight === 0 && total === seen ? quietChecks + 1 : 0;
    seen = total;
  }
}

/**
 * Count D1 work and Actor calls on the binding classes themselves. The Worker
 * and every Actor in this runtime share them, so one patch observes all of
 * them. The Actor mark tells the Worker's own work from an Actor's.
 */
function observeStorage(counter: Counter): () => void {
  const database = Object.getPrototypeOf(env.DB) as Record<string, unknown>;
  const session = Object.getPrototypeOf(env.DB.withSession()) as Record<
    string,
    unknown
  >;
  const statement = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as Record<
    string,
    unknown
  >;
  const namespace = Object.getPrototypeOf(env.ORGANISATION) as Record<
    string,
    unknown
  >;
  const sql = new WeakMap<object, string>();
  // A database hands its batch to a session, which must not count it again.
  const countedBatches = new WeakSet<object>();
  const restores: (() => void)[] = [];
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  restores.push(() => {
    Error.stackTraceLimit = stackLimit;
  });
  for (const prototype of new Set([database, session]))
    restores.push(
      replaceMethod(prototype, "prepare", (original, self, args) => {
        const prepared: unknown = Reflect.apply(original, self, args);
        if (isObject(prepared) && typeof args[0] === "string")
          sql.set(prepared, args[0]);
        return prepared;
      }),
      replaceMethod(prototype, "batch", (original, self, args) => {
        const statements: unknown[] = Array.isArray(args[0]) ? args[0] : [];
        if (countedBatches.has(statements))
          return Reflect.apply(original, self, args);
        countedBatches.add(statements);
        const first: unknown = statements[0];
        const label = `batch of ${String(statements.length)}: ${sqlLabel(
          isObject(first) ? sql.get(first) : undefined,
        )}`;
        return observeRoundTrip(counter, label, statements.length, () =>
          Reflect.apply(original, self, [statements]),
        );
      }),
    );
  restores.push(
    replaceMethod(statement, "bind", (original, self, args) => {
      const bound: unknown = Reflect.apply(original, self, args);
      const text = isObject(self) ? sql.get(self) : undefined;
      if (isObject(bound) && text !== undefined) sql.set(bound, text);
      return bound;
    }),
  );
  for (const method of ["first", "run", "all", "raw"])
    restores.push(
      replaceMethod(statement, method, (original, self, args) =>
        observeRoundTrip(
          counter,
          sqlLabel(isObject(self) ? sql.get(self) : undefined),
          1,
          () => Reflect.apply(original, self, args),
        ),
      ),
    );
  for (const actorClass of [
    OrganisationDO,
    SessionDO,
    CaseDO,
    ConnectorDO,
    ConversationResidencyActor,
  ])
    restores.push(...markActorMethods(actorClass.prototype));
  restores.push(
    replaceMethod(namespace, "get", (original, self, args) => {
      const stub: unknown = Reflect.apply(original, self, args);
      return isObject(stub) ? observedStub(counter, stub) : stub;
    }),
  );
  const accountOrigin = env.TEST_ACCOUNT_PLATFORM_BASE_URL;
  if (env.ACCOUNT_PLATFORM && accountOrigin)
    restores.push(
      replaceMethod(
        Object.getPrototypeOf(env.ACCOUNT_PLATFORM) as Record<string, unknown>,
        "fetch",
        (original, self, args) => {
          const target: unknown = args[0];
          const url = target instanceof Request ? target.url : String(target);
          const call = (): unknown => Reflect.apply(original, self, args);
          // The journey's own requests to the Worker use the same class.
          if (!url.startsWith(accountOrigin)) return call();
          const label = `Account ${new URL(url).pathname.split("/").at(-1) ?? ""}`;
          if (insideActor.getStore() === true) {
            counter.actorSites[label] = (counter.actorSites[label] ?? 0) + 1;
            return call();
          }
          counter.accountCalls += 1;
          return observeFarOperation(
            counter,
            label,
            new Error().stack ?? "",
            call,
          );
        },
      ),
    );
  return function restoreStorage(): void {
    for (const restore of restores) restore();
  };
}

/** Runs every method of an Actor class inside the Actor mark. */
function markActorMethods(prototype: object): (() => void)[] {
  const methods = prototype as Record<string, unknown>;
  const restores: (() => void)[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (name === "constructor" || typeof descriptor?.value !== "function")
      continue;
    restores.push(
      replaceMethod(methods, name, (original, self, args) =>
        insideActor.run(true, () => Reflect.apply(original, self, args)),
      ),
    );
  }
  return restores;
}

function observeRoundTrip(
  counter: Counter,
  label: string,
  statements: number,
  run: () => unknown,
): unknown {
  const stack = new Error().stack ?? "";
  if (insideActor.getStore() === true) {
    counter.actorRoundTrips += 1;
    counter.actorSites[label] = (counter.actorSites[label] ?? 0) + 1;
    return run();
  }
  counter.workerRoundTrips += 1;
  counter.workerStatements += statements;
  if (stack.includes(SEQUENTIAL_SCOPE_RESOLUTION))
    counter.scopeResolutions += 1;
  return observeFarOperation(counter, label, stack, run);
}

/** A stub whose calls from the Worker are counted and held like a round trip. */
function observedStub(counter: Counter, stub: object): object {
  return new Proxy(stub, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (
        typeof property !== "string" ||
        typeof value !== "function" ||
        property === "then"
      )
        return value;
      return function observedActorCall(...args: unknown[]): unknown {
        const stack = new Error().stack ?? "";
        const call = (): unknown => Reflect.apply(value, target, args);
        if (insideActor.getStore() === true) return call();
        counter.actorCalls += 1;
        return observeFarOperation(
          counter,
          `Actor call ${property}`,
          stack,
          call,
        );
      };
    },
  });
}

function observeFarOperation(
  counter: Counter,
  label: string,
  stack: string,
  run: () => unknown,
): unknown {
  if (counter.inFlight === 0) counter.waves += 1;
  counter.sites.push([counter.waves, label, callerChain(stack)]);
  counter.inFlight += 1;
  const settle = (): void => {
    counter.inFlight -= 1;
  };
  let result: unknown;
  try {
    result =
      counter.holdMs === 0 ? run() : scheduler.wait(counter.holdMs).then(run);
  } catch (error) {
    settle();
    throw error;
  }
  if (isThenable(result)) void Promise.resolve(result).then(settle, settle);
  else settle();
  return result;
}

function replaceMethod(
  prototype: Record<string, unknown>,
  method: string,
  replacement: (
    original: (...args: unknown[]) => unknown,
    self: unknown,
    args: unknown[],
  ) => unknown,
): () => void {
  const original = prototype[method];
  if (typeof original !== "function")
    throw new Error(`Binding has no ${method} method`);
  const call = original as (...args: unknown[]) => unknown;
  prototype[method] = function observed(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    return replacement(call, this, args);
  };
  return function restore(): void {
    prototype[method] = original;
  };
}

/** The statement's verb and its first table. */
function sqlLabel(text: string | undefined): string {
  if (text === undefined) return "statement";
  const verb = /^\s*(\w+)/u.exec(text)?.[1]?.toUpperCase() ?? "SQL";
  const table = /\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_]+)/u.exec(text)?.[1];
  return table === undefined ? verb : `${verb} ${table}`;
}

/** The nearest named application callers of an operation, innermost first. */
function callerChain(stack: string): string {
  const names: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const name = /^\s*at (?:async )?([\w$.<>]+) \(/u.exec(line)?.[1];
    if (
      name === undefined ||
      name.startsWith("D1") ||
      name.startsWith("observe") ||
      name.startsWith("Object.") ||
      name === "Proxy.observed"
    )
      continue;
    if (names.at(-1) !== name) names.push(name);
    if (names.length === 6) break;
  }
  return names.join(" < ");
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}
