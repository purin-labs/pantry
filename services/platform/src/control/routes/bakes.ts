import {
  parseBakeDecisionInput,
  parseBakeStockLevelInput,
} from "@purin-labs/kitchen-control-api";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "../../env";
import { mayDecideBakes } from "../../kitchen/bakes/commands";
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
    | Readonly<{ kind: "decision"; proposalId: string }>;
}>;

const BAKES =
  /^\/v1\/control\/organisations\/([^/]+)\/bakes(?:\/(levels)|\/proposals\/(bake_[a-f0-9]{24})\/decision)?$/u;

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
      target: { kind: "decision", proposalId: match[3] },
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

async function decide(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalId: string,
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
  const input = body.ok ? parseBakeDecisionInput(body.value) : null;
  if (!body.ok || input === null)
    return controlError("bake_decision_invalid", 422);
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/bakes/proposals/${proposalId}/decision`,
    operation: `kitchen.bake_proposal.${input.decision}`,
  });
  if (admitted instanceof Response) return admitted;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const decided = await organisation.runBakeCommand({
    organisationId: authorized.organisationId,
    command: {
      kind: "decide",
      proposalId,
      decision: input.decision,
      reason: input.decision === "reject" ? input.reason : null,
      decider: {
        userId: authorized.authenticated.session.userId,
        role: authorized.membership.role,
        via: "portal",
      },
    },
  });
  if (!decided.ok) {
    const error = decided.error;
    if (!("message" in error)) return controlError(error.code, 503);
    return refusal(
      error.code,
      error.message,
      error.code === "bake_role_insufficient"
        ? 403
        : error.code === "bake_proposal_missing"
          ? 404
          : 409,
    );
  }
  const responseBody = {
    ok: true,
    changed: decided.value.kind !== "unchanged",
    proposal: "proposal" in decided.value ? decided.value.proposal : null,
  };
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 200, body: responseBody },
    Date.now(),
  );
  return controlJson(responseBody);
}
