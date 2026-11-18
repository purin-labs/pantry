import {
  bakeryRunSnapshotPrefix as snapshotPrefix,
  bakeryRunSnapshotSummary as summary,
} from "../../commerce/bakery/saved-runs";
import {
  MAX_RUN_SNAPSHOT_BYTES,
  isRunSnapshotId,
  parseRunSnapshot,
  parseRunSnapshotSummary,
  type RunSnapshotSummary,
} from "@seams/bakery-model/bakery-run-snapshot";
import {
  parseBakerySurfaceEffect,
  parseBakerySurfaceReceipt,
  verifyBakerySurfaceAttachment,
  verifyBakerySurfaceEffect,
  verifyBakerySurfaceReceipt,
} from "@seams/bakery-model/bakery-surface";
import type { Env } from "../../env";
import type { OrganisationId } from "../../ids";
import { authorizeOrganisationRequest } from "../authorization";
import {
  controlError,
  controlHeaders,
  controlJson,
  readBoundedJsonRecord,
} from "../http";
import { hasExactKeys } from "@seams/std";
import { artifactPublicationReady } from "./bakery-run-artifacts";
import {
  insertAgentRunSaveApproval,
  markAgentRunSaved,
  readAgentApproval,
  readSettledAgentSaveProposal,
  type AgentApprovalRow,
} from "../../data/bakery-agent-run-save";
export type BakeryRunRoute = Readonly<{
  kind: "bakeryRuns";
  organisationIdRaw: string;
  id: string | null;
}>;

const MAX_RUN_SAVE_REQUEST_BYTES = MAX_RUN_SNAPSHOT_BYTES + 256;
const AGENT_SAVE_PROPOSAL_TTL_MS = 15 * 60_000;

type AgentSaveOrigin = Readonly<{ kind: "agent_effect"; effectId: string }>;
type RunSaveOrigin = Readonly<{ kind: "manual" }> | AgentSaveOrigin;
export function matchBakeryRunRoute(pathname: string): BakeryRunRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/bakery\/runs(?:\/([a-f0-9]{64}))?$/u.exec(
      pathname,
    );
  if (match?.[1] === undefined) return null;
  return {
    kind: "bakeryRuns",
    organisationIdRaw: decodeURIComponent(match[1]),
    id: match[2] ?? null,
  };
}

export async function handleBakeryRunRoute(
  request: Request,
  env: Env,
  route: BakeryRunRoute,
): Promise<Response> {
  const saving = request.method === "POST" && route.id === null;
  if (!saving && request.method !== "GET")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    saving ? "admin" : "viewer",
    saving,
  );
  if (!authorized.ok) return authorized.response;
  const prefix = snapshotPrefix(authorized.organisationId);
  try {
    if (saving) {
      const body = await readBoundedJsonRecord(
        request,
        MAX_RUN_SAVE_REQUEST_BYTES,
      );
      const origin = parseRunSaveOrigin(body);
      if (body === null || origin === null || !isRunSnapshotId(body.expectedId))
        return controlError("bakery_run_invalid", 422);
      const snapshot = parseRunSnapshot({
        name: body.name,
        document: body.document,
      });
      if (snapshot === null) return controlError("bakery_run_invalid", 422);
      const content = new TextEncoder().encode(snapshot.content);
      const digest = await crypto.subtle.digest("SHA-256", content);
      const id = Array.from(new Uint8Array(digest), hexByte).join("");
      if (id !== body.expectedId)
        return controlError("bakery_run_payload_mismatch", 409);
      if (
        snapshot.kind === "persistent-production" &&
        !(await artifactPublicationReady(
          env,
          authorized.organisationId,
          authorized.authenticated.session.userId,
          id,
          snapshot,
        ))
      )
        return controlError("bakery_run_artifacts_incomplete", 409);
      if (origin.kind === "agent_effect") {
        const approved = await approveAgentRunSave({
          db: authorized.executionScope.database,
          organisationId: authorized.organisationId,
          userId: authorized.authenticated.session.userId,
          origin,
          snapshot: { id, name: snapshot.name, bytes: content.length },
        });
        if (!approved)
          return controlError("bakery_agent_save_approval_invalid", 409);
      }
      const key = prefix + id;
      const current = await authorizeOrganisationRequest(
        request,
        env,
        route.organisationIdRaw,
        "admin",
        true,
      );
      if (!current.ok) return current.response;
      const created = await env.ARCHIVE.put(key, snapshot.content, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          name: snapshot.name,
          kind: snapshot.kind,
          savedBy: authorized.authenticated.session.userId,
        },
      });
      const stored = created ?? (await env.ARCHIVE.head(key));
      if (stored === null) return controlError("bakery_runs_unavailable", 503);
      if (origin.kind === "agent_effect") {
        const readback = await env.ARCHIVE.get(key);
        if (readback === null)
          return controlError("bakery_runs_unavailable", 503);
        if (readback.size > MAX_RUN_SNAPSHOT_BYTES) {
          await readback.body.cancel();
          return controlError("bakery_runs_unavailable", 503);
        }
        if ((await readback.text()) !== snapshot.content)
          return controlError("bakery_run_payload_mismatch", 409);
        const savedSummary = summary(prefix, readback);
        await settleAgentRunSave(
          authorized.executionScope.database,
          origin.effectId,
          authorized.organisationId,
          authorized.authenticated.session.userId,
          savedSummary,
          Date.now(),
        );
        return controlJson(
          { ok: true, snapshot: savedSummary },
          created === null ? 200 : 201,
        );
      }
      return controlJson(
        { ok: true, snapshot: summary(prefix, stored) },
        created === null ? 200 : 201,
      );
    }
    if (route.id !== null) {
      const stored = await env.ARCHIVE.get(prefix + route.id);
      if (stored === null) return controlError("bakery_run_not_found", 404);
      if (stored.size > MAX_RUN_SNAPSHOT_BYTES) {
        await stored.body.cancel();
        return controlError("bakery_run_invalid", 422);
      }
      const current = await authorizeOrganisationRequest(
        request,
        env,
        route.organisationIdRaw,
        "viewer",
        false,
      );
      if (!current.ok) {
        await stored.body.cancel();
        return current.response;
      }
      const headers = controlHeaders();
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("x-content-type-options", "nosniff");
      return new Response(stored.body, { headers });
    }
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && (cursor.length === 0 || cursor.length > 2048))
      return controlError("bakery_run_cursor_invalid", 422);
    const page = await env.ARCHIVE.list({
      prefix,
      limit: 25,
      include: ["customMetadata"],
      ...(cursor === null ? {} : { cursor }),
    });
    const current = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "viewer",
      false,
    );
    if (!current.ok) return current.response;
    return controlJson({
      ok: true,
      snapshots: page.objects.map(summary.bind(null, prefix)),
      nextCursor: page.truncated ? page.cursor : null,
    });
  } catch {
    return controlError("bakery_runs_unavailable", 503);
  }
}

function parseRunSaveOrigin(
  body: Readonly<Record<string, unknown>> | null,
): RunSaveOrigin | null {
  if (body === null) return null;
  if (hasExactKeys(body, ["expectedId", "name", "document"]))
    return { kind: "manual" };
  if (
    hasExactKeys(body, ["expectedId", "name", "document", "agentEffectId"]) &&
    typeof body.agentEffectId === "string" &&
    /^surface_effect_[0-9a-f]{40}$/u.test(body.agentEffectId)
  )
    return { kind: "agent_effect", effectId: body.agentEffectId };
  return null;
}

async function approveAgentRunSave(
  input: Readonly<{
    db: D1Database;
    organisationId: OrganisationId;
    userId: string;
    origin: AgentSaveOrigin;
    snapshot: Readonly<{ id: string; name: string; bytes: number }>;
  }>,
): Promise<boolean> {
  const existing = await readAgentApproval(input.db, input.origin.effectId);
  if (existing !== null) return agentApprovalMatches(existing, input);
  const proposal = await readSettledAgentSaveProposal(input.db, {
    effectId: input.origin.effectId,
    organisationId: input.organisationId,
    userId: input.userId,
  });
  if (proposal === null) return false;
  const effect = parseBakerySurfaceEffect(JSON.parse(proposal.effectJson));
  const receipt = parseBakerySurfaceReceipt(JSON.parse(proposal.receiptJson));
  if (
    effect.kind !== "valid" ||
    receipt.kind !== "valid" ||
    !(await verifyBakerySurfaceEffect(effect.value)) ||
    !(await verifyBakerySurfaceReceipt(receipt.value)) ||
    effect.value.effectId !== input.origin.effectId ||
    effect.value.command.kind !== "prepare_run_save" ||
    receipt.value.effectId !== effect.value.effectId ||
    receipt.value.dispatchId !== effect.value.dispatchId ||
    receipt.value.commandDigest !== effect.value.commandDigest ||
    receipt.value.outcome.kind !== "completed" ||
    receipt.value.outcome.result.kind !== "succeeded" ||
    receipt.value.outcome.result.surface.context.surfaceSessionId !==
      effect.value.command.target.surfaceSessionId ||
    receipt.value.outcome.result.surface.context.surfaceEpoch !==
      effect.value.command.target.surfaceEpoch ||
    receipt.value.outcome.result.command !== "prepare_run_save" ||
    receipt.value.outcome.result.output.kind !== "run_save_proposal" ||
    !(await verifyBakerySurfaceAttachment(
      receipt.value.outcome.result.surface,
    )) ||
    receipt.value.outcome.result.surface.context.active.kind !== "rehearsal"
  )
    return false;
  const manifest = receipt.value.outcome.result.output.manifest;
  const active = receipt.value.outcome.result.surface.context.active;
  if (
    effect.value.command.name !== manifest.name ||
    manifest.id !== input.snapshot.id ||
    manifest.name !== input.snapshot.name ||
    manifest.bytes !== input.snapshot.bytes ||
    active.kind !== "rehearsal" ||
    active.runSaveProposal === null ||
    active.runSaveProposal.id !== manifest.id ||
    active.runSaveProposal.name !== manifest.name ||
    active.runSaveProposal.bytes !== manifest.bytes
  )
    return false;
  const approvedAt = Date.now();
  if (approvedAt > proposal.updatedAt + AGENT_SAVE_PROPOSAL_TTL_MS)
    return false;
  await insertAgentRunSaveApproval(input.db, {
    effectId: input.origin.effectId,
    organisationId: input.organisationId,
    userId: input.userId,
    contentId: input.snapshot.id,
    name: input.snapshot.name,
    approvedAt,
  });
  const approval = await readAgentApproval(input.db, input.origin.effectId);
  return approval !== null && agentApprovalMatches(approval, input);
}

function agentApprovalMatches(
  approval: AgentApprovalRow,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: string;
    snapshot: Readonly<{ id: string; name: string }>;
  }>,
): boolean {
  return (
    approval.organisationId === input.organisationId &&
    approval.userId === input.userId &&
    approval.contentId === input.snapshot.id &&
    approval.name === input.snapshot.name
  );
}

async function settleAgentRunSave(
  db: D1Database,
  effectId: string,
  organisationId: OrganisationId,
  userId: string,
  saved: RunSnapshotSummary,
  now: number,
): Promise<void> {
  await markAgentRunSaved(db, {
    effectId,
    organisationId,
    userId,
    contentId: saved.id,
    name: saved.name,
    summaryJson: JSON.stringify(saved),
    now,
  });
  const approval = await readAgentApproval(db, effectId);
  if (
    approval === null ||
    approval.stateKind !== "saved" ||
    approval.organisationId !== organisationId ||
    approval.userId !== userId ||
    approval.contentId !== saved.id ||
    approval.name !== saved.name ||
    !sameRunSnapshotSummary(
      parseRunSnapshotSummary(JSON.parse(approval.summaryJson ?? "null")),
      saved,
    )
  )
    throw new Error("The agent save receipt is unavailable.");
}

function sameRunSnapshotSummary(
  actual: RunSnapshotSummary | null,
  expected: RunSnapshotSummary,
): boolean {
  return (
    actual !== null &&
    actual.id === expected.id &&
    actual.name === expected.name &&
    actual.kind === expected.kind &&
    actual.bytes === expected.bytes &&
    actual.savedAt === expected.savedAt
  );
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
