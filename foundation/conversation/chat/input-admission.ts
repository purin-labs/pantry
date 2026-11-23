import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { RequestAuthority } from "@purin-labs/contracts";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import {
  ObservationEvidence,
  outsideWrittenFlowLabel,
  type FlowLabel,
  type FlowSource,
} from "@purin-labs/authority/policy/information-flow/index";
import {
  digestContextBundle,
  materializeContextBundle,
  type ContextAssemblyResult,
  type ContextItem,
  type AuthorizedContextRead,
} from "@purin-labs/agent/context/assembly/index";
import type { Result } from "@purin-labs/kernel/result";
import type { PrepareTurnContextError } from "@purin-labs/agent/context/turn-context";
import type { ConversationDocument } from "./conversation";
import { readAdmittedChatInput } from "./turn-access";

/**
 * A public page that a Portal chat read with `read_documentation`, named by
 * its address and the digest of its text. The chat's prompt carries the text.
 */
export type ChatDocumentRead = Pick<ConversationDocument, "url" | "sha256">;

/**
 * Admits the chat's input to the turn's context. The message and the pages
 * that the chat read reach the model in the turn's objective, so their items
 * add no text to the model context: each one only records its observation in
 * the Session before inference.
 *
 * A person outside the Organisation wrote each page, so its item has the
 * message's label with the writer `outside` (Plan 89). An effect with a
 * consequence later in the Session then asks the person who asked.
 */
export async function admitChatInput(
  db: OrganisationDatabase,
  authority: RequestAuthority,
  context: AuthorizedContextRead,
  turnId: string,
  content: unknown,
  now: number,
  documents: readonly ChatDocumentRead[],
): Promise<Result<ContextAssemblyResult, PrepareTurnContextError>> {
  const admitted =
    authority.kind === "control"
      ? await readAdmittedChatInput(db, authority, turnId)
      : null;
  if (admitted !== null && admitted.sessionId !== context.sessionId)
    throw new Error("chat_input_evidence_unavailable");
  // Only a Portal chat reads documentation, and its turn always has an
  // admitted input. A page with no label must not reach a model.
  if (admitted === null && documents.length > 0)
    throw new Error("chat_document_evidence_unavailable");
  const scope =
    admitted?.audience.surface === "workspace_canvas" ? "case" : "workspace";
  const prepared = await context.assemble(scope);
  if (!prepared.ok || admitted === null) return prepared;
  const items = [
    await chatInputItem({
      source: admitted.source,
      sourceRevision: Math.max(1, admitted.audience.conversationRevision),
      contentDigest: await sha256Hex(canonicalJson(content)),
      label: admitted.inputLabel,
      now,
    }),
  ];
  if (documents.length > 0) {
    const pageLabel = await outsideWrittenFlowLabel(admitted.inputLabel);
    for (const document of documents)
      items.push(
        await chatInputItem({
          source: await documentSource(context.caseId, document.url),
          sourceRevision: 1,
          contentDigest: document.sha256,
          label: pageLabel,
          now,
        }),
      );
  }
  const bundle = {
    ...prepared.value.bundle,
    items: [...prepared.value.bundle.items, ...items],
    usage: {
      items: prepared.value.bundle.items.length + items.length,
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

/**
 * The source of a page names its origin and the digest of its address, never
 * the address itself, because a query string can carry a secret.
 */
async function documentSource(
  caseId: string,
  url: string,
): Promise<FlowSource> {
  if (!URL.canParse(url)) throw new Error("chat_document_evidence_unavailable");
  return {
    kind: "case_entry",
    caseId,
    entryId: `chat_documentation:${new URL(url).origin}:${await sha256Hex(url)}`,
  };
}

async function chatInputItem(
  input: Readonly<{
    source: FlowSource;
    sourceRevision: number;
    contentDigest: string;
    label: FlowLabel;
    now: number;
  }>,
): Promise<ContextItem> {
  const evidence = await ObservationEvidence.create({
    source: input.source,
    sourceRevision: input.sourceRevision,
    contentDigest: input.contentDigest,
    inputLabel: input.label,
    observedAt: input.now,
  });
  if (!evidence.ok) throw new Error("chat_input_evidence_unavailable");
  return {
    source: {
      kind: "project_observation",
      source: input.source,
      snapshotDigest: evidence.value.evidenceDigest,
    },
    provenance: { kind: "native_chat_input" },
    sourceRevision: evidence.value.sourceRevision,
    contentDigest: evidence.value.contentDigest,
    boundedExcerpt: "",
    inputLabel: input.label,
    observationEvidence: evidence.value,
    observedAt: input.now,
    freshness: { kind: "fresh" },
    retrievalEvidence: {
      exactPhraseMatch: false,
      tokenOverlapMillionths: 0,
      recencyRank: 0,
    },
  };
}
