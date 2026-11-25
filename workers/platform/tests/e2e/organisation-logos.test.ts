import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord, sha256Hex } from "@purin-labs/std";

import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
} from "./commerce-support";
import { addOrganisationMember } from "./organisation-fixture";

declare module "vitest" {
  interface TaskMeta {
    organisationLogos?: Record<string, unknown>;
  }
}

// Portal round 9. An owner uploads a logo for the organisation and for its
// workspace; every member's session names the logo, and a member reads the
// image. A viewer cannot change a logo, an SVG or a large image is refused,
// a replaced logo leaves one stored image, and a removed logo brings the
// gradient tile back.
it(
  "keeps an owner's logos for the organisation and its workspace",
  logoJourney,
  60_000,
);

async function logoJourney(context: TestContext): Promise<void> {
  const run = crypto.randomUUID();
  const owner = await commerceClient(`logo-owner-${run}`);
  const admin = await commerceClient(`logo-admin-${run}`);
  const viewer = await commerceClient(`logo-viewer-${run}`);
  const organisationId = await commerceWorkspace(owner, "Logo bakery");
  await addOrganisationMember(organisationId, admin, "admin");
  await addOrganisationMember(organisationId, viewer, "viewer");
  const base = `/v1/control/organisations/${organisationId}`;

  // Before any upload, both tiles are gradients.
  const before = await sessionLogos(viewer.session, organisationId);
  expect(before).toEqual({ organisation: null, workspaces: [null] });
  const workspaceId = before.workspaceIds[0];
  if (workspaceId === undefined) throw new Error("The workspace is missing");

  // The owner uploads the organisation's logo.
  const first = png(1);
  const firstDigest = await sha256Hex(first);
  const uploaded = await upload(
    owner.session,
    `${base}/logo`,
    first,
    "image/png",
    "first",
  );
  expect(uploaded.status, uploaded.text).toBe(200);
  expect(uploaded.body).toEqual({ ok: true, logo: firstDigest });

  // The same request again gives the same answer and stores nothing new.
  const repeated = await upload(
    owner.session,
    `${base}/logo`,
    first,
    "image/png",
    "first",
  );
  expect(repeated.body).toEqual(uploaded.body);

  // The viewer's session names it, and the viewer reads the image.
  const afterUpload = await sessionLogos(viewer.session, organisationId);
  expect(afterUpload.organisation).toBe(firstDigest);
  const image = await read(viewer.session, `${base}/logo?v=${firstDigest}`);
  expect(image.status).toBe(200);
  expect(image.contentType).toBe("image/png");
  expect(image.cacheControl).toBe("private, max-age=31536000, immutable");
  expect(image.noSniff).toBe("nosniff");
  expect(await sha256Hex(image.bytes)).toBe(firstDigest);

  // Refused: only the owner changes a logo, as only the owner renames the
  // organisation. An admin and a viewer are refused, and the logo stays.
  // The owner check answers 404, as for a rename, and so says nothing more.
  const adminUpload = await upload(
    admin.session,
    `${base}/logo`,
    png(2),
    "image/png",
    "admin",
  );
  expect(adminUpload.status).toBe(404);
  const viewerUpload = await upload(
    viewer.session,
    `${base}/logo`,
    png(2),
    "image/png",
    "viewer",
  );
  expect(viewerUpload.status).toBe(404);
  const viewerRemoval = await remove(
    viewer.session,
    `${base}/logo`,
    "viewer-remove",
  );
  expect(viewerRemoval.status).toBe(404);
  expect((await sessionLogos(owner.session, organisationId)).organisation).toBe(
    firstDigest,
  );

  // Refused: an SVG, which can carry script, and an image over 1 MB.
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const svgUpload = await upload(
    owner.session,
    `${base}/logo`,
    svg,
    "image/svg+xml",
    "svg",
  );
  expect(svgUpload.status).toBe(422);
  const large = new Uint8Array(1024 * 1024 + 1);
  large.set(png(3));
  const largeUpload = await upload(
    owner.session,
    `${base}/logo`,
    large,
    "image/png",
    "large",
  );
  expect(largeUpload.status).toBe(422);

  // The owner gives the workspace its own logo.
  const workspaceImage = png(4);
  const workspaceDigest = await sha256Hex(workspaceImage);
  const workspaceUpload = await upload(
    owner.session,
    `${base}/workspaces/${workspaceId}/logo`,
    workspaceImage,
    "image/webp",
    "workspace",
  );
  expect(workspaceUpload.status, workspaceUpload.text).toBe(200);
  const withWorkspace = await sessionLogos(viewer.session, organisationId);
  expect(withWorkspace).toEqual({
    organisation: firstDigest,
    workspaces: [workspaceDigest],
  });

  // A new organisation logo replaces the first: its old address is gone,
  // and one image stays in storage.
  const second = png(5);
  const secondDigest = await sha256Hex(second);
  const replaced = await upload(
    owner.session,
    `${base}/logo`,
    second,
    "image/jpeg",
    "second",
  );
  expect(replaced.body).toEqual({ ok: true, logo: secondDigest });
  const stored = await env.ARCHIVE.list({
    prefix: `organisation-logos/${organisationId}/organisation/`,
  });
  expect(stored.objects).toHaveLength(1);
  const secondImage = await read(
    viewer.session,
    `${base}/logo?v=${firstDigest}`,
  );
  expect(secondImage.cacheControl).toBe("private, no-cache");
  expect(await sha256Hex(secondImage.bytes)).toBe(secondDigest);

  // The owner removes the organisation logo: the gradient tile comes back,
  // and the workspace keeps its own logo.
  const removed = await remove(owner.session, `${base}/logo`, "remove");
  expect(removed.status, removed.text).toBe(200);
  expect(removed.body).toEqual({ ok: true, logo: null });
  const afterRemoval = await sessionLogos(viewer.session, organisationId);
  expect(afterRemoval).toEqual({
    organisation: null,
    workspaces: [workspaceDigest],
  });
  expect((await read(viewer.session, `${base}/logo`)).status).toBe(404);
  const leftOver = await env.ARCHIVE.list({
    prefix: `organisation-logos/${organisationId}/organisation/`,
  });
  expect(leftOver.objects).toHaveLength(0);

  context.task.meta.organisationLogos = {
    before,
    upload: uploaded.status,
    repeatSameAnswer: repeated.text === uploaded.text,
    viewerReadsImage: image.status,
    adminUpload: adminUpload.status,
    viewerUpload: viewerUpload.status,
    viewerRemoval: viewerRemoval.status,
    svgUpload: svgUpload.status,
    largeUpload: largeUpload.status,
    workspaceUpload: workspaceUpload.status,
    storedAfterReplace: stored.objects.length,
    oldAddressAfterReplace: secondImage.cacheControl,
    removal: removed.status,
    afterRemoval: {
      organisation: afterRemoval.organisation,
      workspaces: afterRemoval.workspaces,
    },
    storedAfterRemoval: leftOver.objects.length,
  };
}

/** A small, valid PNG whose last pixel byte is `seed`. */
function png(seed: number): Uint8Array {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (character) => character.charCodeAt(0),
  );
  // The bytes after the IEND chunk change the digest and not the image.
  return Uint8Array.from([...bytes, seed]);
}

type LogoAnswer = Readonly<{ status: number; text: string; body: unknown }>;

async function upload(
  session: IssuedControlSession,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  key: string,
): Promise<LogoAnswer> {
  const form = new FormData();
  form.set("logo", new File([bytes], "logo", { type: contentType }));
  const headers = commerceHeaders(session);
  headers.delete("content-type");
  headers.set("idempotency-key", `logo-${key}-${session.token.slice(0, 8)}`);
  return answer(
    await exports.default.fetch(`https://localhost${path}`, {
      method: "POST",
      headers,
      body: form,
    }),
  );
}

async function remove(
  session: IssuedControlSession,
  path: string,
  key: string,
): Promise<LogoAnswer> {
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", `logo-${key}-${session.token.slice(0, 8)}`);
  return answer(
    await exports.default.fetch(`https://localhost${path}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ remove: true }),
    }),
  );
}

async function answer(response: Response): Promise<LogoAnswer> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, text, body };
}

async function read(
  session: IssuedControlSession,
  path: string,
): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
  readonly noSniff: string | null;
  readonly bytes: Uint8Array;
}> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    headers: commerceHeaders(session),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    noSniff: response.headers.get("x-content-type-options"),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** The logo digests that the person's session gives for the organisation. */
async function sessionLogos(
  session: IssuedControlSession,
  organisationId: string,
): Promise<{
  readonly organisation: string | null;
  readonly workspaces: readonly (string | null)[];
  readonly workspaceIds: readonly string[];
}> {
  const response = await exports.default.fetch(
    "https://localhost/v1/control/session",
    { headers: commerceHeaders(session) },
  );
  const body: unknown = await response.json();
  const memberships =
    isRecord(body) && Array.isArray(body.memberships) ? body.memberships : [];
  const membership = memberships.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.organisationId === organisationId,
  );
  if (membership === undefined || !Array.isArray(membership.workspaces))
    throw new Error(`The session has no membership: ${response.status}`);
  const workspaces = membership.workspaces.filter(isRecord);
  const result = {
    organisation:
      typeof membership.organisationLogo === "string"
        ? membership.organisationLogo
        : null,
    workspaces: workspaces.map((workspace) =>
      typeof workspace.logo === "string" ? workspace.logo : null,
    ),
    workspaceIds: workspaces.map((workspace) => String(workspace.workspaceId)),
  };
  // `toEqual` compares the logos only.
  Object.defineProperty(result, "workspaceIds", { enumerable: false });
  return result;
}
