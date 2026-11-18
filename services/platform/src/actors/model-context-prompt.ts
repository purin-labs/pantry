import type { ModelContextBundle } from "../context/assembly";

const ENCODER = new TextEncoder();

/**
 * Shown whenever accepted Memory was withheld: by a size limit, by a failed or
 * late read, or by this prompt's own byte budget. It names no Memory.
 */
export const MEMORY_LIMITATION_NOTICE =
  "Some accepted organizational memory could not be loaded for this request. " +
  "Establish any fact it might cover from current records, or ask for review, before acting on it.";

/** The heading of the accepted Memory that a turn is shown. */
export const MEMORY_HEADING =
  "Accepted organizational memory (reviewed facts and preferences):";

type MemoryRef = Readonly<{ memoryId: string; revision: number }>;

export type RenderedModelContext = Readonly<{
  text: string;
  /** The Memory revisions that reached the prompt. */
  memory: readonly MemoryRef[];
  /** Whether this prompt's byte budget withheld an admitted Memory revision. */
  memoryOmittedForBytes: boolean;
}>;

export function modelContextPrompt(
  context: ModelContextBundle,
  instruction: string,
  maxEncodedBytes: number,
): string {
  return renderModelContext(context, instruction, maxEncodedBytes).text;
}

/**
 * Renders accepted Memory first, then ranked evidence, then the request. The
 * request and the limitation notice always render; Memory and evidence are
 * added only while the encoded prompt stays within `maxEncodedBytes`. With
 * `memoryReferences`, each Memory line names the reference by which a mail
 * reply cites it as a source.
 */
export function renderModelContext(
  context: ModelContextBundle,
  instruction: string,
  maxEncodedBytes: number,
  options: Readonly<{ memoryReferences?: boolean }> = {},
): RenderedModelContext {
  const fits = (
    memory: readonly string[],
    limited: boolean,
    excerpts: readonly string[],
  ): boolean =>
    ENCODER.encode(
      JSON.stringify(composePrompt(memory, limited, excerpts, instruction)),
    ).byteLength <= maxEncodedBytes;
  const memory: string[] = [];
  const rendered: MemoryRef[] = [];
  let memoryOmittedForBytes = false;
  for (const item of context.items) {
    if (item.provenance.kind !== "memory") continue;
    const line =
      options.memoryReferences === true
        ? `- [memory:${item.provenance.memoryId}] ${item.boundedExcerpt}`
        : `- ${item.boundedExcerpt}`;
    // Reserve the notice while fitting, so omitting a later revision can
    // never push out one already shown.
    if (memoryOmittedForBytes || !fits([...memory, line], true, [])) {
      memoryOmittedForBytes = true;
      continue;
    }
    memory.push(line);
    rendered.push({
      memoryId: item.provenance.memoryId,
      revision: item.provenance.revision,
    });
  }
  const limited =
    context.memoryLimitation !== undefined || memoryOmittedForBytes;
  const excerpts: string[] = [];
  for (const item of context.items) {
    if (item.provenance.kind === "memory") continue;
    const excerpt = readModelContextExcerpt(item);
    if (!fits(memory, limited, [...excerpts, excerpt])) break;
    excerpts.push(excerpt);
  }
  // Preserve the current instruction verbatim; context is optional, ranked evidence.
  return {
    text: composePrompt(memory, limited, excerpts, instruction),
    memory: rendered,
    memoryOmittedForBytes,
  };
}

function composePrompt(
  memory: readonly string[],
  memoryLimited: boolean,
  excerpts: readonly string[],
  instruction: string,
): string {
  if (memory.length === 0 && !memoryLimited && excerpts.length === 0)
    return instruction;
  const sections: string[] = [];
  if (memory.length > 0) sections.push(MEMORY_HEADING, ...memory);
  if (memoryLimited) sections.push(MEMORY_LIMITATION_NOTICE);
  if (excerpts.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push(
      "Accepted organizational context (bounded selection):",
      ...excerpts,
    );
  }
  return [...sections, "", "Current request:", instruction].join("\n");
}

function readModelContextExcerpt(
  item: ModelContextBundle["items"][number],
): string {
  switch (item.provenance.kind) {
    case "memory":
    case "native_chat_input":
    case "project_context":
    case "case_entry":
      return `- ${item.boundedExcerpt}`;
    case "integration_file":
      return `- [${item.provenance.displayName}](${item.provenance.deepLink}) (${item.provenance.displayPath}): ${item.boundedExcerpt}`;
  }
}
