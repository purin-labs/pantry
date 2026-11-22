import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { RequestAuthority } from "@purin-labs/contracts";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import { ObservationEvidence } from "@purin-labs/authority/policy/information-flow/index";
import {
  digestContextBundle,
  materializeContextBundle,
  type ContextAssemblyResult,
  type ContextItem,
  type AuthorizedContextRead,
} from "../context/assembly";
import type { Result } from "@purin-labs/kernel/result";
import type { PrepareTurnContextError } from "../context/turn-context";
import { readAdmittedChatInput } from "./turn-access";

export async function admitChatInput(
  db: OrganisationDatabase,
  authority: RequestAuthority,
  context: AuthorizedContextRead,
  turnId: string,
  content: unknown,
  now: number,
): Promise<Result<ContextAssemblyResult, PrepareTurnContextError>> {
  const admitted =
    authority.kind === "control"
      ? await readAdmittedChatInput(db, authority, turnId)
      : null;
  if (admitted !== null && admitted.sessionId !== context.sessionId)
    throw new Error("chat_input_evidence_unavailable");
  const scope =
    admitted?.audience.surface === "workspace_canvas" ? "case" : "workspace";
  const prepared = await context.assemble(scope);
  if (!prepared.ok || admitted === null) return prepared;
  const source = admitted.source;
  const label = admitted.inputLabel;
  const text = canonicalJson(content);
  const evidence = await ObservationEvidence.create({
    source,
    sourceRevision: Math.max(1, admitted.audience.conversationRevision),
    contentDigest: await sha256Hex(text),
    inputLabel: label,
    observedAt: now,
  });
  if (!evidence.ok) throw new Error("chat_input_evidence_unavailable");
  const item: ContextItem = {
    source: {
      kind: "project_observation",
      source,
      snapshotDigest: evidence.value.evidenceDigest,
    },
    provenance: { kind: "native_chat_input" },
    sourceRevision: evidence.value.sourceRevision,
    contentDigest: evidence.value.contentDigest,
    boundedExcerpt: "",
    inputLabel: label,
    observationEvidence: evidence.value,
    observedAt: now,
    freshness: { kind: "fresh" },
    retrievalEvidence: {
      exactPhraseMatch: false,
      tokenOverlapMillionths: 0,
      recencyRank: 0,
    },
  };
  const bundle = {
    ...prepared.value.bundle,
    items: [...prepared.value.bundle.items, item],
    usage: {
      items: prepared.value.bundle.items.length + 1,
      estimatedTokens: prepared.value.bundle.usage.estimatedTokens,
    },
  };
  return {
    ok: true,
    value: {
      bundle,
      bundleDigest: await digestContextBundle(bundle),
      modelContext: materializeContextBundle(bundle),
    },
  };
}
