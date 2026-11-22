import {
  parseBakeAuthorityInput,
  parseBakeDecisionInput,
  parseBakeRunActionInput,
  parseBakeStockLevelInput,
  type BakeRunActionInput,
} from "@purin-labs/kitchen-control-api";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import {
  mayDecideBakes,
  type BakeCommand,
  type BakeCommandOutcome,
  type BakeMemberRole,
} from "../../kitchen/bakes/commands";
import { setBakeAuthority } from "../../kitchen/bakes/authority";
import { setBakeStockLevel } from "../../kitchen/bakes/levels";
import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
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
 * An admin or the owner also sets the authority of each kitchen location
 * (Plan 24 S5): shadow mode, the default, or approval mode.
 */
export type BakeControlRoute = Readonly<{
  kind: "bakes";
  organisationIdRaw: string;
  target:
    | Readonly<{ kind: "board" }>
    | Readonly<{ kind: "level" }>
    | Readonly<{ kind: "authority" }>
    | Readonly<{ kind: "decision"; proposalId: string }>
    | Readonly<{ kind: "run"; proposalId: string }>;
}>;

const BAKES =
  /^\/v1\/control\/organisations\/([^/]+)\/bakes(?:\/(levels|authority)|\/proposals\/(bake_[a-f0-9]{24})\/(decision|run))?$/u;

export function matchBakeControlRoute(
  pathname: string,
): BakeControlRoute | null {
  const match = BAKES.exec(pathname);
  if (match === null) return null;
  const organisationIdRaw = match[1] ?? "";
  if (match[2] === "levels")
    return { kind: "bakes", organisationIdRaw, target: { kind: "level" } };
  if (match[2] === "authority")
    return { kind: "bakes", organisationIdRaw, target: { kind: "authority" } };
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
    case "authority":
      return putAuthority(request, env, route.organisationIdRaw);
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

type Authorized = Extract<
  Awaited<ReturnType<typeof authorizeOrganisationRequest>>,
  { ok: true }
>;

type BakeWriteOutcome =
  | Readonly<{ ok: true; body: Record<string, unknown> }>
  | Readonly<{ ok: false; code: string; message: string; status: number }>;

/**
 * One person's write on the Bakes page: it checks the role, parses the body,
 * admits the mutation, writes and keeps its receipt. An admin or the owner
 * sets a stock level or the authority of a kitchen location (Plan 24 S5);
 * every other write is a bake command that the Organisation Actor checks, as
 * it checks a Slack click or the agent's request.
 */
async function bakeWrite<Input>(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  route: Readonly<{
    method: "PUT" | "POST";
    role: "admin" | "viewer";
    path: string;
    parse: (value: Record<string, unknown>) => Input | null;
    invalid: string;
    operation: (input: Input) => string;
    write: (authorized: Authorized, input: Input) => Promise<BakeWriteOutcome>;
  }>,
): Promise<Response> {
  if (request.method !== route.method)
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    route.role,
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
  const written = await route.write(authorized, input);
  if (!written.ok)
    return refusal(written.code, written.message, written.status);
  const responseBody = { ok: true, ...written.body };
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 200, body: responseBody },
    Date.now(),
  );
  return controlJson(responseBody);
}

function putLevel(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  return bakeWrite(request, env, organisationIdRaw, {
    method: "PUT",
    role: "admin",
    path: "levels",
    parse: parseBakeStockLevelInput,
    invalid: "bake_level_invalid",
    operation: () => "kitchen.bake_level.set",
    write: async (authorized, input) => {
      const set = await setBakeStockLevel(
        authorized.executionScope.database,
        authorized.organisationId,
        input,
        authorized.authenticated.session.userId,
        Date.now(),
      );
      return set.ok
        ? { ok: true, body: { level: set.value.level } }
        : {
            ok: false,
            code: set.error.code,
            message: set.error.message,
            status: set.error.code === "bake_level_stale" ? 409 : 422,
          };
    },
  });
}

/** Plan 24 S5: an admin sets a kitchen location's shadow or approval mode. */
function putAuthority(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  return bakeWrite(request, env, organisationIdRaw, {
    method: "PUT",
    role: "admin",
    path: "authority",
    parse: parseBakeAuthorityInput,
    invalid: "bake_authority_invalid",
    operation: (input) => `kitchen.bake_authority.${input.mode}`,
    write: async (authorized, input) => {
      const set = await setBakeAuthority(
        authorized.executionScope.database,
        authorized.organisationId,
        input,
        authorized.authenticated.session.userId,
        Date.now(),
      );
      return set.ok
        ? { ok: true, body: { authority: set.value.authority } }
        : {
            ok: false,
            code: set.error.code,
            message: set.error.message,
            status: 409,
          };
    },
  });
}

/** One person's bake command from the Portal, run by the Organisation Actor. */
function runPortalBakeCommand<Input>(
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
  return bakeWrite(request, env, organisationIdRaw, {
    method: "POST",
    role: "viewer",
    path: route.path,
    parse: route.parse,
    invalid: route.invalid,
    operation: route.operation,
    write: async (authorized, input) => {
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
      if (done.ok) return { ok: true, body: route.answer(done.value) };
      const error = done.error;
      if (!("message" in error))
        return {
          ok: false,
          code: error.code,
          message: "Bakes are not available now. Try again.",
          status: 503,
        };
      return {
        ok: false,
        code: error.code,
        message: error.message,
        status:
          error.code === "bake_role_insufficient"
            ? 403
            : error.code === "bake_proposal_missing" ||
                error.code === "bake_run_missing"
              ? 404
              : 409,
      };
    },
  });
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
        action: {
          kind: "settle",
          decision: input.decision,
          seen: input.seen ?? null,
        },
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
