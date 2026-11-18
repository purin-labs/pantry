import React from "react";
import { Attachment, InlineCitations, type CitationSource } from "../../ui";
import type { ChatSource } from "@seams/control-api";
import { Globe, ArrowUpRight } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
} from "../../ui/trace";
/** The citation chip goes inline with the text; file cards go under it. */
export function chatSourceParts(sources: readonly ChatSource[]): {
  readonly citations: React.ReactNode;
  readonly details: React.ReactNode;
} {
  const citations: CitationSource[] = [];
  const attachments: React.ReactNode[] = [];
  for (const source of sources) {
    const href = sourceUrl(source.url);
    if (source.kind === "attachment") {
      attachments.push(
        <Attachment
          key={source.sourceId}
          name={source.label}
          description={source.host}
          state={
            href === null
              ? { kind: "unavailable", reason: "No file link available" }
              : { kind: "ready", href }
          }
        />,
      );
    } else {
      citations.push({
        id: source.sourceId,
        label: source.label,
        description: source.host,
        href,
      });
    }
  }
  return {
    citations:
      citations.length === 0 ? null : <InlineCitations sources={citations} />,
    details:
      sources.length === 0 ? null : (
        <>
          {citations.length === 0 ? null : (
            <Trace className="chat-execution-trace">
              <TraceCollapsible>
                <TraceCollapsibleTrigger>
                  <TraceLine status="completed">
                    <TraceIcon>
                      <Globe />
                    </TraceIcon>
                    <TraceTitle>
                      Used {citations.length} source
                      {citations.length === 1 ? "" : "s"}
                    </TraceTitle>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                  <Trace>{citations.map(renderSourceLine)}</Trace>
                </TraceCollapsibleContent>
              </TraceCollapsible>
            </Trace>
          )}
          {attachments.length === 0 ? null : (
            <aside className="chat-source-links" aria-label="Response files">
              {attachments}
            </aside>
          )}
        </>
      ),
  };
}

export function ChatSources(props: {
  readonly sources: readonly ChatSource[];
}): React.ReactNode {
  const parts = chatSourceParts(props.sources);
  return parts.details;
}

function renderSourceLine(source: CitationSource): React.ReactNode {
  const line = (
    <TraceLine status="completed">
      <TraceTitle>
        {source.label}
        {source.href === null ? null : (
          <span className="agent-ui-sr-only"> (opens in a new tab)</span>
        )}
      </TraceTitle>
      <TraceDescription>{source.description}</TraceDescription>
      {source.href === null ? null : (
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
      )}
    </TraceLine>
  );
  return source.href === null ? (
    <React.Fragment key={source.id}>{line}</React.Fragment>
  ) : (
    <a key={source.id} href={source.href.href} target="_blank" rel="noreferrer">
      {line}
    </a>
  );
}

function sourceUrl(raw: string | null): URL | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
