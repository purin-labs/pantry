import {
  parseBakeDecisionInput,
  parseBakeRunActionInput,
  parseBakeStockLevelInput,
  type BakeRunActionInput,
} from "@purin-labs/kitchen-control-api";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "../../env";
import {
  mayDecideBakes,
  type BakeCommand,
  type BakeCommandOutcome,
  type BakeMemberRole,
} from "../../kitchen/bakes/commands";
import { setBakeStockLevel } from "../../kitchen/bakes/levels";
import { roleMayConfigure } from "../../data/control-plane";
import {
  admitControlMutation,
  recordSessionMutationReceipt,
} from "../admission/control-mutation";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";

/**
 * The Bakes page of Kitchen (Plan 24 S1): the stock level of each fresh
 * product and the bake proposals. Every member reads them. An admin or the
 * owner sets a level. A decision goes to the Organisation Actor, which runs the
 * same check as a Slack click: a viewer is refused there, with the reason.
 */
export type BakeControlRoute = Readonly<{
  kind: "bakes";
  organisationIdRaw: string;
  target:
    | Readonly<{ kind: "board" }>
    | Readonly<{ kind: "level" }>
    | Readonly<{ kind: "decision"; proposalId: string }>
    | Readonly<{ kind: "run"; proposalId: string }>;
}>;

const BAKES =
  /^\/v1\/control\/organisations\/([^/]+)\/bakes(?:\/(levels)|\/proposals\/(bake_[a-f0-9]{24})\/(decision|run))?$/u;

export function matchBakeControlRoute(
  pathname: string,
): BakeControlRoute | null {
  const match = BAKES.exec(pathname);
  if (match === null) return null;
  const organisationIdRaw = match[1] ?? "";
  if (match[2] === "levels")
    return { kind: "bakes", organisationIdRaw, target: { kind: "level" } };
  if (match[3] !== undefined)
    return {
      kind: "bakes",
      organisationIdRaw,
      target: {
        kind: match[4] === "run" ? "run" : "decision",
        proposalId: match[3],
      },
    };
  return { kind: "bakes", organisationIdRaw, target: { kind: "board" } };
}

export function handleBakeControlRoute(
  request: Request,
  env: Env,
  route: BakeControlRoute,
): Promise<Response> {
  switch (route.target.kind) {
    case "board":
      return readBoard(request, env, route.organisationIdRaw);
    case "level":
      return putLevel(request, env, route.organisationIdRaw);
    case "decision":
      return decide(
        request,
        env,
        route.organisationIdRaw,
        route.target.proposalId,
      );
    case "run":
      return request.method === "GET"
        ? readRun(
            request,
            env,
            route.organisationIdRaw,
            route.target.proposalId,
          )
        : actOnRun(
            request,
            env,
            route.organisationIdRaw,
            route.target.proposalId,
          );
  }
}

function refusal(code: string, message: string, status: number): Response {
  return controlJson({ ok: false, error: code, message }, status);
}

async function readBoard(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const board = await organisation.readBakeBoard({
    organisationId: authorized.organisationId,
  });
  if (!board.ok) return controlError("bakes_unavailable", 503);
  const role = authorized.membership.role;
  return controlJson({
    ...board.value,
    access: {
      mayEditLevels: roleMayConfigure(role),
      mayDecide: mayDecideBakes(role),
    },
  });
}

async function putLevel(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const input = body.ok ? parseBakeStockLevelInput(body.value) : null;
  if (!body.ok || input === null)
    return controlError("bake_level_invalid", 422);
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/bakes/levels`,
    operation: "kitchen.bake_level.set",
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const set = await setBakeStockLevel(
    authorized.executionScope.database,
    authorized.organisationId,
    input,
    authorized.authenticated.session.userId,
    now,
  );
  if (!set.ok)
    return refusal(
      set.error.code,
      set.error.message,
      set.error.code === "bake_level_stale" ? 409 : 422,
    );
  const responseBody = { ok: true, level: set.value.level };
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 200, body: responseBody },
    now,
  );
  return controlJson(responseBody);
}

/**
 * One person's bake command from the Portal: it parses the body, admits the
 * mutation, runs the command in the Organisation Actor and keeps its receipt.
 * The Actor runs the same check as a Slack click or the agent's request.
 */
async function runPortalBakeCommand<Input>(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  route: Readonly<{
    path: string;
    parse: (value: Record<string, unknown>) => Input | null;
    invalid: string;
    operation: (input: Input) => string;
    command: (
      input: Input,
      requester: Readonly<{ userId: string; role: BakeMemberRole }>,
    ) => BakeCommand;
    answer: (outcome: BakeCommandOutcome) => Record<string, unknown>;
  }>,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const input = body.ok ? route.parse(body.value) : null;
  if (!body.ok || input === null) return controlError(route.invalid, 422);
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/bakes/${route.path}`,
    operation: route.operation(input),
  });
  if (admitted instanceof Response) return admitted;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const done = await organisation.runBakeCommand({
    organisationId: authorized.organisationId,
    command: route.command(input, {
      userId: authorized.authenticated.session.userId,
      role: authorized.membership.role,
    }),
  });
  if (!done.ok) {
    const error = done.error;
    if (!("message" in error)) return controlError(error.code, 503);
    return refusal(
      error.code,
      error.message,
      error.code === "bake_role_insufficient"
        ? 403
        : error.code === "bake_proposal_missing" ||
            error.code === "bake_run_missing"
          ? 404
          : 409,
    );
  }
  const responseBody = { ok: true, ...route.answer(done.value) };
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 200, body: responseBody },
    Date.now(),
  );
  return controlJson(responseBody);
}

function decide(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalId: string,
): Promise<Response> {
  return runPortalBakeCommand(request, env, organisationIdRaw, {
    path: `proposals/${proposalId}/decision`,
    parse: parseBakeDecisionInput,
    invalid: "bake_decision_invalid",
    operation: (input) => `kitchen.bake_proposal.${input.decision}`,
    command: (input, requester) => ({
      kind: "decide",
      proposalId,
      decision: input.decision,
      reason: input.decision === "reject" ? input.reason : null,
      decider: { ...requester, via: "portal" },
    }),
    answer: (outcome) => ({
      changed: outcome.kind !== "unchanged",
      proposal: "proposal" in outcome ? outcome.proposal : null,
    }),
  });
}

/**
 * Plan 24 S4: the one read of a proposal's bake run. The canvas, the
 * timeline and the positions of the run drawer all show this object.
 */
async function readRun(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalId: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const run = await organisation.readBakeRun({
    organisationId: authorized.organisationId,
    proposalId,
  });
  if (!run.ok) return controlError("bakes_unavailable", 503);
  if (run.value === null) return controlError("bake_run_missing", 404);
  return controlJson({
    ok: true,
    run: run.value,
    access: { mayOperate: mayDecideBakes(authorized.membership.role) },
  });
}

function runCommand(
  proposalId: string,
  input: BakeRunActionInput,
  requester: Readonly<{ userId: string; role: BakeMemberRole }>,
): BakeCommand {
  switch (input.action) {
    case "start":
      return { kind: "start_run", proposalId, requester };
    case "check":
      return {
        kind: "check_run",
        proposalId,
        goodPieces: input.goodPieces,
        checker: requester,
      };
    case "settle":
      return {
        kind: "run_action",
        proposalId,
        action: { kind: "settle", decision: input.decision },
        requester: { ...requester, via: "person" },
      };
    default:
      return {
        kind: "run_action",
        proposalId,
        action: { kind: input.action },
        requester: { ...requester, via: "person" },
      };
  }
}

/**
 * A person's start, pause, resume, stop, settle or check of a run. The
 * Organisation Actor runs the same check for the agent's pause request.
 */
function actOnRun(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalId: string,
): Promise<Response> {
  return runPortalBakeCommand(request, env, organisationIdRaw, {
    path: `proposals/${proposalId}/run`,
    parse: parseBakeRunActionInput,
    invalid: "bake_run_action_invalid",
    operation: (input) => `kitchen.bake_run.${input.action}`,
    command: (input, requester) => runCommand(proposalId, input, requester),
    answer: (outcome) =>
      outcome.kind === "run_checked"
        ? { receiptId: outcome.receiptId, goodPieces: outcome.goodPieces }
        : {},
  });
}
