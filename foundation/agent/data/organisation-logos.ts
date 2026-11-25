import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationId, WorkspaceId } from "@purin-labs/kernel/ids";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";
import {
  prepareOrganisationLogoDigest,
  readOrganisationLogoDigest,
} from "@purin-labs/tenancy/data/organisation-logo-row";

/**
 * The logo of an organisation or of one of its workspaces. The bytes are in
 * R2 under their SHA-256, and the row keeps only the digest, so a logo
 * address with the digest in it never changes its bytes. SVG is refused:
 * it can carry script.
 */
export const LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** The largest logo: 1 MB, more than a 512px square image needs. */
export const LOGO_MAX_BYTES = 1024 * 1024;

export type LogoSubject =
  | Readonly<{ kind: "organisation" }>
  | Readonly<{ kind: "workspace"; workspaceId: WorkspaceId }>;

export type LogoImage = Readonly<{
  contentType: LogoContentType;
  bytes: Uint8Array;
  sha256: string;
}>;

export type LogoError =
  /** The workspace is not an active workspace of the organisation. */
  | Readonly<{ code: "logo_subject_not_found" }>
  /** The subject has no logo, or its bytes are gone. */
  | Readonly<{ code: "logo_not_found" }>
  /** Another request changed the logo between the read and the write. */
  | Readonly<{ code: "logo_changed" }>;

type LogoStore = Readonly<{
  db: OrganisationQuerySource;
  archive: R2Bucket;
  organisationId: OrganisationId;
  subject: LogoSubject;
}>;

export type StoredLogo = Readonly<{
  sha256: string;
  contentType: string;
  body: ReadableStream;
}>;

/** The bytes of the current logo of the subject. */
export async function readLogo(
  input: LogoStore,
): Promise<Result<StoredLogo, LogoError>> {
  const current = await readLogoDigest(input);
  if (!current.ok) return current;
  if (current.value === null)
    return { ok: false, error: { code: "logo_not_found" } };
  const object = await input.archive.get(logoObjectKey(input, current.value));
  if (object === null) return { ok: false, error: { code: "logo_not_found" } };
  return {
    ok: true,
    value: {
      sha256: current.value,
      contentType:
        object.httpMetadata?.contentType ?? "application/octet-stream",
      body: object.body,
    },
  };
}

/**
 * Makes `image` the subject's logo. The same image again writes nothing.
 * The bytes go to R2 before the row names them, and the old bytes go only
 * after the row stops naming them.
 */
export async function setLogo(
  input: LogoStore & Readonly<{ image: LogoImage }>,
): Promise<Result<Readonly<{ sha256: string }>, LogoError>> {
  const current = await readLogoDigest(input);
  if (!current.ok) return current;
  if (current.value === input.image.sha256)
    return { ok: true, value: { sha256: input.image.sha256 } };
  await input.archive.put(
    logoObjectKey(input, input.image.sha256),
    input.image.bytes,
    { httpMetadata: { contentType: input.image.contentType } },
  );
  const changed = await writeLogoDigest(
    input,
    current.value,
    input.image.sha256,
  );
  if (!changed) return { ok: false, error: { code: "logo_changed" } };
  if (current.value !== null)
    await input.archive.delete(logoObjectKey(input, current.value));
  return { ok: true, value: { sha256: input.image.sha256 } };
}

/** Takes the subject's logo away, so its tile shows the gradient again. */
export async function removeLogo(
  input: LogoStore,
): Promise<Result<Readonly<{ removed: boolean }>, LogoError>> {
  const current = await readLogoDigest(input);
  if (!current.ok) return current;
  if (current.value === null) return { ok: true, value: { removed: false } };
  const changed = await writeLogoDigest(input, current.value, null);
  if (!changed) return { ok: false, error: { code: "logo_changed" } };
  await input.archive.delete(logoObjectKey(input, current.value));
  return { ok: true, value: { removed: true } };
}

function logoObjectKey(
  input: Pick<LogoStore, "organisationId" | "subject">,
  sha256: string,
): string {
  const base = `organisation-logos/${input.organisationId}`;
  return input.subject.kind === "organisation"
    ? `${base}/organisation/${sha256}`
    : `${base}/workspace/${input.subject.workspaceId}/${sha256}`;
}

async function readLogoDigest(
  input: LogoStore,
): Promise<Result<string | null, LogoError>> {
  if (input.subject.kind === "organisation") {
    const digest = await readOrganisationLogoDigest(
      input.db,
      input.organisationId,
    );
    return digest === undefined
      ? { ok: false, error: { code: "logo_subject_not_found" } }
      : { ok: true, value: digest };
  }
  const row = await input.db
    .prepare(
      `SELECT logo_sha256 AS sha256 FROM organisation_workspace
       WHERE organisation_id = ? AND workspace_id = ? AND status = 'active'`,
    )
    .bind(input.organisationId, input.subject.workspaceId)
    .first<{ sha256: unknown }>();
  if (row === null)
    return { ok: false, error: { code: "logo_subject_not_found" } };
  return {
    ok: true,
    value: typeof row.sha256 === "string" ? row.sha256 : null,
  };
}

/** Moves the digest from `from` to `to`; false when another write came first. */
async function writeLogoDigest(
  input: LogoStore,
  from: string | null,
  to: string | null,
): Promise<boolean> {
  const statement =
    input.subject.kind === "organisation"
      ? prepareOrganisationLogoDigest(input.db, {
          organisationId: input.organisationId,
          from,
          to,
          now: Date.now(),
        })
      : input.db
          .prepare(
            `UPDATE organisation_workspace SET logo_sha256 = ?
             WHERE organisation_id = ? AND workspace_id = ? AND status = 'active'
               AND logo_sha256 IS ?`,
          )
          .bind(to, input.organisationId, input.subject.workspaceId, from);
  const result = await statement.run();
  return result.meta.changes === 1;
}
