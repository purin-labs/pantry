import { parseWorkspaceId } from "@purin-labs/kernel/ids";
import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
import {
  admitControlMutation,
  recordSessionMutationReceipt,
} from "@purin-labs/control/worker/admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { controlError, controlJson } from "@purin-labs/control/worker/http";
import { readImageForm } from "@purin-labs/control/worker/image-form";
import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  readLogo,
  removeLogo,
  setLogo,
  type LogoError,
  type LogoSubject,
} from "@purin-labs/agent/data/organisation-logos";

export type OrganisationLogoRoute = Readonly<{
  kind: "organisationLogo";
  organisationIdRaw: string;
  /** Absent for the organisation's own logo. */
  workspaceIdRaw?: string;
}>;

const LOGO_PATH =
  /^\/v1\/control\/organisations\/([^/]+)\/(?:workspaces\/([^/]+)\/)?logo$/u;

export function matchOrganisationLogoRoute(
  pathname: string,
): OrganisationLogoRoute | null {
  const match = LOGO_PATH.exec(pathname);
  if (match?.[1] === undefined) return null;
  return {
    kind: "organisationLogo",
    organisationIdRaw: decodeURIComponent(match[1]),
    ...(match[2] === undefined
      ? {}
      : { workspaceIdRaw: decodeURIComponent(match[2]) }),
  };
}

/**
 * The logo of an organisation or of one of its workspaces. A member reads
 * it; an owner uploads it as a multipart form with the field `logo`, or
 * removes it.
 */
export async function handleOrganisationLogoRoute(
  request: Request,
  env: Env,
  route: OrganisationLogoRoute,
): Promise<Response> {
  const subject = logoSubject(route);
  if (subject === null) return controlError("logo_subject_not_found", 404);
  switch (request.method) {
    case "GET":
      return serveLogo(request, env, route, subject);
    case "POST":
    case "DELETE":
      return changeLogo(request, env, route, subject);
    default:
      return controlError("method_not_allowed", 405);
  }
}

function logoSubject(route: OrganisationLogoRoute): LogoSubject | null {
  if (route.workspaceIdRaw === undefined) return { kind: "organisation" };
  const workspaceId = parseWorkspaceId(route.workspaceIdRaw);
  return workspaceId.ok
    ? { kind: "workspace", workspaceId: workspaceId.value }
    : null;
}

async function serveLogo(
  request: Request,
  env: Env,
  route: OrganisationLogoRoute,
  subject: LogoSubject,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const logo = await readLogo({
    db: authorized.executionScope.database,
    archive: env.ARCHIVE,
    organisationId: authorized.organisationId,
    subject,
  });
  if (!logo.ok) return logoErrorResponse(logo.error);
  // The Portal names the digest in the address, so that address never
  // shows other bytes and the browser may keep it.
  const pinned =
    new URL(request.url).searchParams.get("v") === logo.value.sha256;
  return new Response(logo.value.body, {
    headers: {
      "content-type": logo.value.contentType,
      "cache-control": pinned
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
      etag: `"${logo.value.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function changeLogo(
  request: Request,
  env: Env,
  route: OrganisationLogoRoute,
  subject: LogoSubject,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const store = {
    db: authorized.executionScope.database,
    archive: env.ARCHIVE,
    organisationId: authorized.organisationId,
    subject,
  };
  if (request.method === "DELETE") {
    const admitted = await admitLogoChange(request, authorized, route, {
      remove: true,
    });
    if (admitted instanceof Response) return admitted;
    const removed = await removeLogo(store);
    if (!removed.ok) return logoErrorResponse(removed.error);
    return settle(authorized, admitted, { ok: true, logo: null });
  }
  const read = await readImageForm(request, {
    field: "logo",
    maxBytes: LOGO_MAX_BYTES,
    contentTypes: LOGO_CONTENT_TYPES,
  });
  if (read === null) return controlError("logo_image_invalid", 422);
  const admitted = await admitLogoChange(request, authorized, route, {
    sha256: read.image.sha256,
    contentType: read.image.contentType,
  });
  if (admitted instanceof Response) return admitted;
  const stored = await setLogo({ ...store, image: read.image });
  if (!stored.ok) return logoErrorResponse(stored.error);
  return settle(authorized, admitted, { ok: true, logo: stored.value.sha256 });
}

type AdmittedLogoChange = Exclude<
  Awaited<ReturnType<typeof admitControlMutation<"unversioned">>>,
  Response
>;

function admitLogoChange(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
  route: OrganisationLogoRoute,
  body: Readonly<Record<string, unknown>>,
): Promise<AdmittedLogoChange | Response> {
  const workspace =
    route.workspaceIdRaw === undefined
      ? ""
      : `/workspaces/${route.workspaceIdRaw}`;
  return admitControlMutation({
    request,
    authorized,
    body,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}${workspace}/logo`,
    operation:
      "remove" in body ? "organisation.logo.remove" : "organisation.logo.set",
  });
}

async function settle(
  authorized: AuthorizedOrganisationRequest,
  admitted: AdmittedLogoChange,
  body: Readonly<{ ok: true; logo: string | null }>,
): Promise<Response> {
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 200, body },
    Date.now(),
  );
  return controlJson(body);
}

function logoErrorResponse(error: LogoError): Response {
  switch (error.code) {
    case "logo_subject_not_found":
    case "logo_not_found":
      return controlError(error.code, 404);
    case "logo_changed":
      return controlError(error.code, 409);
    default:
      return assertNever(error, "Unexpected logo error");
  }
}
