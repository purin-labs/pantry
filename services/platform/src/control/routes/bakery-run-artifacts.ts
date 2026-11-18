import {
  MAX_ARTIFACT_BYTES,
  MAX_DOCUMENT_BYTES,
  openResumable,
  parseExecutionBundle,
  parseExecutionManifest,
  type ResumableDocument,
  type RetainedFile,
} from "@seams/production-simulation";
import {
  parseRunSnapshot,
  type RunSnapshot,
} from "@seams/bakery-model/bakery-run-snapshot";
import {
  hasExactKeys,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
  sameJson,
} from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import type { Env } from "../../env";
import type { OrganisationId } from "../../ids";
import { bakeryRunSnapshotPrefix } from "../../commerce/bakery/saved-runs";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";

export type BakeryRunArtifactRoute = Readonly<{
  kind: "bakeryRunArtifacts";
  organisationIdRaw: string;
  id: string;
}> &
  StrictUnion<
    | Readonly<{ action: "prepare" }>
    | Readonly<{ action: "staged" | "published"; digest: string }>
  >;

export function matchBakeryRunArtifactRoute(
  pathname: string,
): BakeryRunArtifactRoute | null {
  const prepared =
    /^\/v1\/control\/organisations\/([^/]+)\/bakery\/runs\/prepared\/([a-f0-9]{64})(?:\/artifacts\/([a-f0-9]{64}))?$/u.exec(
      pathname,
    );
  if (prepared?.[1] !== undefined && prepared[2] !== undefined) {
    const organisationIdRaw = decodeURIComponent(prepared[1]);
    if (prepared[3] === undefined)
      return {
        kind: "bakeryRunArtifacts",
        organisationIdRaw,
        id: prepared[2],
        action: "prepare",
      };
    return {
      kind: "bakeryRunArtifacts",
      organisationIdRaw,
      id: prepared[2],
      action: "staged",
      digest: prepared[3],
    };
  }
  const published =
    /^\/v1\/control\/organisations\/([^/]+)\/bakery\/runs\/([a-f0-9]{64})\/artifacts\/([a-f0-9]{64})$/u.exec(
      pathname,
    );
  if (
    published?.[1] === undefined ||
    published[2] === undefined ||
    published[3] === undefined
  )
    return null;
  return {
    kind: "bakeryRunArtifacts",
    organisationIdRaw: decodeURIComponent(published[1]),
    id: published[2],
    action: "published",
    digest: published[3],
  };
}

type PreparedRun = Readonly<{
  snapshot: RunSnapshot;
  document: ResumableDocument;
}>;

// A warm worker can serve hundreds of chunks from one immutable document.
// Keep one small parsed document. Every request still checks current authority,
// the referring object, its ETag, and the requested artifact's own digest.
let lastParsedRun: Readonly<{
  key: string;
  etag: string;
  id: string;
  prepared: PreparedRun;
}> | null = null;
const MAX_CACHED_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** Persistence boundary only. Embedded older snapshots remain readable. */
async function preparedArtifactRun(raw: unknown): Promise<PreparedRun | null> {
  const snapshot = parseRunSnapshot(raw);
  if (snapshot === null || snapshot.kind !== "persistent-production")
    return null;
  const file = parseJsonOrNull(snapshot.file);
  if (
    !isRecord(file) ||
    !isRecord(file.document) ||
    !Array.isArray(file.artifacts) ||
    file.artifacts.length !== 0
  )
    return null;
  const bundle = parseExecutionBundle(file.document.bundle);
  if (bundle === null) return null;
  const document = await openResumable(file.document, bundle.backend, [bundle]);
  return document.ok ? { snapshot, document: document.value } : null;
}

function preparedKey(
  organisationId: OrganisationId,
  userId: string,
  id: string,
): string {
  return `bakery-run-prepared/${encodeURIComponent(organisationId)}/${encodeURIComponent(userId)}/${id}`;
}
function artifactKey(
  organisationId: OrganisationId,
  userId: string,
  id: string,
  digest: string,
): string {
  return `bakery-run-artifacts/${encodeURIComponent(organisationId)}/${encodeURIComponent(userId)}/${id}/${digest}`;
}

async function readPrepared(
  env: Env,
  organisationId: OrganisationId,
  userId: string,
  id: string,
): Promise<PreparedRun | null> {
  const key = preparedKey(organisationId, userId, id);
  const object = await env.ARCHIVE.get(key);
  if (object === null) return null;
  return parseStoredRun(object, key, id);
}

async function parseStoredRun(
  object: R2ObjectBody,
  key: string,
  id: string,
): Promise<PreparedRun | null> {
  if (object.size > MAX_DOCUMENT_BYTES + 1024) {
    await object.body.cancel();
    return null;
  }
  const cached = lastParsedRun;
  if (
    cached !== null &&
    cached.key === key &&
    cached.etag === object.etag &&
    cached.id === id
  ) {
    await object.body.cancel();
    return cached.prepared;
  }
  const content = await object.text();
  if ((await sha256Hex(content)) !== id) return null;
  const prepared = await preparedArtifactRun(parseJsonOrNull(content));
  if (prepared !== null && object.size <= MAX_CACHED_DOCUMENT_BYTES)
    lastParsedRun = { key, etag: object.etag, id, prepared };
  return prepared;
}

async function missingArtifacts(
  env: Env,
  organisationId: OrganisationId,
  userId: string,
  id: string,
  prepared: PreparedRun,
): Promise<string[]> {
  const missing = [];
  for (const entry of prepared.document.artifacts) {
    const object = await env.ARCHIVE.head(
      artifactKey(organisationId, userId, id, entry.digest),
    );
    if (
      object === null ||
      object.size !== entry.byteLength ||
      object.customMetadata?.sha256 !== entry.digest
    )
      missing.push(entry.digest);
  }
  return missing;
}

/** Publication checks the exact candidate and the same authenticated principal. */
export async function artifactPublicationReady(
  env: Env,
  organisationId: OrganisationId,
  userId: string,
  id: string,
  snapshot: RunSnapshot,
): Promise<boolean> {
  const prepared = await readPrepared(env, organisationId, userId, id);
  return (
    prepared !== null &&
    prepared.snapshot.content === snapshot.content &&
    (await missingArtifacts(env, organisationId, userId, id, prepared))
      .length === 0 &&
    (await retainedBundleAvailable(env, prepared.document))
  );
}

async function verifyRetainedFile(
  env: Env,
  path: string,
  file: RetainedFile,
): Promise<boolean> {
  const response = await env.ASSETS.fetch(
    new Request(`https://assets.invalid${path}/${file.file}`),
  );
  if (!response.ok) return false;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return (
    bytes.byteLength === file.byteLength &&
    (await sha256Hex(bytes)) === file.sha256
  );
}

async function retainedBundleAvailable(
  env: Env,
  document: ResumableDocument,
): Promise<boolean> {
  const path = `/bakery-physics/executions/${document.bundle.id}`;
  const response = await env.ASSETS.fetch(
    new Request(`https://assets.invalid${path}/execution.json`),
  );
  if (!response.ok) return false;
  const manifest = await parseExecutionManifest(
    parseJsonOrNull(await response.text()),
  );
  if (!manifest.ok || !sameJson(manifest.value.bundle, document.bundle))
    return false;
  if (!(await verifyRetainedFile(env, path, manifest.value.engine)))
    return false;
  for (const file of manifest.value.runtime.files)
    if (
      !(await verifyRetainedFile(
        env,
        `/bakery-physics/bundles/${manifest.value.runtime.id}`,
        file,
      ))
    )
      return false;
  return true;
}

export async function handleBakeryRunArtifactRoute(
  request: Request,
  env: Env,
  route: BakeryRunArtifactRoute,
): Promise<Response> {
  const mutation = request.method === "POST";
  if (
    (route.action === "published" && mutation) ||
    (request.method !== "GET" && !mutation)
  )
    return controlError("method_not_allowed", 405);
  const role = route.action === "published" ? "viewer" : "admin";
  const access = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    role,
    mutation,
  );
  if (!access.ok) return access.response;
  const organisationId = access.organisationId;
  const userId = access.authenticated.session.userId;
  try {
    if (route.action === "prepare" && mutation) {
      const body = await readBoundedJsonRecord(
        request,
        MAX_DOCUMENT_BYTES + 1024,
      );
      if (
        body === null ||
        !hasExactKeys(body, ["expectedId", "name", "document"]) ||
        body.expectedId !== route.id
      )
        return controlError("bakery_run_invalid", 422);
      const prepared = await preparedArtifactRun({
        name: body.name,
        document: body.document,
      });
      if (
        prepared === null ||
        (await sha256Hex(prepared.snapshot.content)) !== route.id
      )
        return controlError("bakery_run_payload_mismatch", 409);
      if (!(await retainedBundleAvailable(env, prepared.document)))
        return controlError("bakery_run_bundle_unavailable", 409);
      const current = await authorizeOrganisationRequest(
        request,
        env,
        route.organisationIdRaw,
        "admin",
        true,
      );
      if (!current.ok) return current.response;
      await env.ARCHIVE.put(
        preparedKey(organisationId, userId, route.id),
        prepared.snapshot.content,
        {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json" },
        },
      );
      return preparedReply(
        request,
        env,
        route,
        organisationId,
        userId,
        prepared,
      );
    }
    if (route.action === "published") {
      const key = bakeryRunSnapshotPrefix(organisationId) + route.id;
      const object = await env.ARCHIVE.get(key);
      if (object === null) return controlError("bakery_run_not_found", 404);
      const owner = object.customMetadata?.savedBy;
      if (owner === undefined) {
        await object.body.cancel();
        return controlError("bakery_run_invalid", 422);
      }
      const saved = await parseStoredRun(object, key, route.id);
      if (saved === null) return controlError("bakery_run_invalid", 422);
      return readArtifact(
        request,
        env,
        route,
        organisationId,
        owner,
        saved,
        "viewer",
      );
    }
    const prepared = await readPrepared(env, organisationId, userId, route.id);
    if (prepared === null)
      return controlError("bakery_run_preparation_not_found", 404);
    if (route.action === "prepare")
      return preparedReply(
        request,
        env,
        route,
        organisationId,
        userId,
        prepared,
      );
    if (!mutation)
      return readArtifact(
        request,
        env,
        route,
        organisationId,
        userId,
        prepared,
        "admin",
      );
    const entry = artifactEntry(prepared, route.digest);
    if (entry === null)
      return controlError("bakery_run_artifact_not_found", 404);
    const body = await readBoundedJsonRecord(
      request,
      MAX_ARTIFACT_BYTES * 2 + 1024,
    );
    if (
      body === null ||
      !hasExactKeys(body, ["content"]) ||
      typeof body.content !== "string"
    )
      return controlError("bakery_run_artifact_invalid", 422);
    const bytes = new TextEncoder().encode(body.content);
    if (
      bytes.byteLength !== entry.byteLength ||
      (await sha256Hex(bytes)) !== entry.digest
    )
      return controlError("bakery_run_artifact_mismatch", 409);
    const current = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "admin",
      true,
    );
    if (!current.ok) return current.response;
    const key = artifactKey(organisationId, userId, route.id, route.digest);
    await env.ARCHIVE.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: entry.digest },
    });
    const stored = await env.ARCHIVE.head(key);
    if (
      stored?.size !== entry.byteLength ||
      stored.customMetadata?.sha256 !== entry.digest
    )
      return controlError("bakery_run_artifact_mismatch", 409);
    return controlJson({
      ok: true,
      digest: entry.digest,
      byteLength: entry.byteLength,
    });
  } catch {
    return controlError("bakery_runs_unavailable", 503);
  }
}

function artifactEntry(prepared: PreparedRun, digest: string) {
  for (const entry of prepared.document.artifacts)
    if (entry.digest === digest) return entry;
  return null;
}
async function readArtifact(
  request: Request,
  env: Env,
  route: Extract<BakeryRunArtifactRoute, { action: "published" | "staged" }>,
  organisationId: OrganisationId,
  owner: string,
  prepared: PreparedRun,
  role: "admin" | "viewer",
): Promise<Response> {
  const entry = artifactEntry(prepared, route.digest);
  if (entry === null) return controlError("bakery_run_artifact_not_found", 404);
  const object = await env.ARCHIVE.get(
    artifactKey(organisationId, owner, route.id, route.digest),
  );
  if (object === null)
    return controlError("bakery_run_artifact_not_found", 404);
  if (
    object.size !== entry.byteLength ||
    object.customMetadata?.sha256 !== entry.digest
  ) {
    await object.body.cancel();
    return controlError("bakery_run_artifact_mismatch", 409);
  }
  const content = await object.text();
  if ((await sha256Hex(content)) !== entry.digest)
    return controlError("bakery_run_artifact_mismatch", 409);
  const current = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    role,
    false,
  );
  if (!current.ok) return current.response;
  return controlJson({ digest: entry.digest, content });
}

async function preparedReply(
  request: Request,
  env: Env,
  route: BakeryRunArtifactRoute,
  organisationId: OrganisationId,
  userId: string,
  prepared: PreparedRun,
): Promise<Response> {
  const missing = await missingArtifacts(
    env,
    organisationId,
    userId,
    route.id,
    prepared,
  );
  const current = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    request.method === "POST",
  );
  if (!current.ok) return current.response;
  return controlJson({ ok: true, id: route.id, missing });
}
