import { hasExactKeys } from "@purin-labs/std";
import {
  isPreferenceArea,
  isUserId,
  MAX_PREFERENCE_BYTES,
  parsePreferenceEdit,
} from "@purin-labs/control-api";
import {
  PreferenceStorageError,
  readUserPreferences,
  updateUserPreferences,
} from "../../data/user-preferences";
import type { Env } from "@purin-labs/kernel/env";
import {
  authenticateControlRead,
  authenticateControlMutation,
} from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";

export type UserPreferencesRoute = Readonly<{
  kind: "userPreferences";
  area: string;
}>;
export function matchUserPreferencesRoute(
  pathname: string,
): UserPreferencesRoute | null {
  const match = /^\/v1\/control\/user\/preferences\/([^/]+)$/u.exec(pathname);
  return match?.[1] === undefined
    ? null
    : { kind: "userPreferences", area: match[1] };
}
export async function handleUserPreferencesRoute(
  request: Request,
  env: Env,
  route: UserPreferencesRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PATCH")
    return controlError("method_not_allowed", 405);
  const authenticated =
    request.method === "PATCH"
      ? await authenticateControlMutation(request, env)
      : await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated.response;
  if (!isPreferenceArea(route.area))
    return controlError("preferences_area_unknown", 404);
  const userId = authenticated.value.session.userId;
  try {
    if (request.method === "GET")
      return controlJson(await readUserPreferences(env.DB, userId, route.area));
    const body = await readBoundedJsonRecord(request, MAX_PREFERENCE_BYTES);
    if (
      body === null ||
      !hasExactKeys(body, ["expectedUserId", "expectedRevision", "command"]) ||
      !isUserId(body.expectedUserId) ||
      typeof body.expectedRevision !== "number" ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 1
    )
      return controlError("preferences_request_invalid", 422);
    const edit = parsePreferenceEdit(route.area, body.command);
    if (edit === null) return controlError("preferences_request_invalid", 422);
    // Another tab can replace the session while this tab retains its owner.
    if (body.expectedUserId !== userId)
      return controlError("preferences_user_changed", 409);
    const result = await updateUserPreferences(
      env.DB,
      userId,
      edit,
      body.expectedRevision,
    );
    return controlJson(result, result.kind === "conflict" ? 409 : 200);
  } catch (error) {
    if (error instanceof PreferenceStorageError)
      return controlError(error.code, 422);
    throw error;
  }
}
