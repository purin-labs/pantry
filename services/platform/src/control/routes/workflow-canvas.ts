import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "../http";
import {
  type WorkflowCanvasRoute,
  authorizeWorkflowCanvasRequest,
} from "../admission/workflow-canvas";

export async function handleWorkflowCanvasRoute(
  request: Request,
  env: Env,
  route: WorkflowCanvasRoute,
): Promise<Response> {
  const authorized = await authorizeWorkflowCanvasRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: route.organisationId,
      now: Date.now(),
    });
    return organisation.fetch(request);
  } catch {
    return controlError("workflow_canvas_unavailable", 503);
  }
}
