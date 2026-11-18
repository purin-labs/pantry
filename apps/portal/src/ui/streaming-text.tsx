import React from "react";
import { TaskList, type TaskListItem } from "./task-list";
import "./streaming-text.css";
import { StreamingRun } from "./streaming-run";

export type StreamingTextProps = {
  readonly text: string;
  readonly streaming?: boolean;
  readonly className?: string;
  /** Inline content placed at the end of the last paragraph, such as citations. */
  readonly trailing?: React.ReactNode;
};

type MarkdownBlock =
  | { readonly kind: "paragraph" | "quote"; readonly text: string }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3;
      readonly text: string;
    }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "tasks"; readonly items: readonly TaskListItem[] }
  | { readonly kind: "code"; readonly language: string; readonly text: string }
  | { readonly kind: "rule" }
  | {
      readonly kind: "table";
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export function StreamingText(props: StreamingTextProps): React.ReactNode {
  return (
    <div
      className={`streaming-text ${props.className ?? ""}`}
      data-streaming={props.streaming ?? false}
    >
      {renderMarkdownBlocks(
        parseMarkdownBlocks(props.text, props.streaming ?? false),
        props.streaming ?? false,
        props.trailing ?? null,
      )}
    </div>
  );
}

function renderMarkdownBlocks(
  blocks: readonly MarkdownBlock[],
  streaming: boolean,
  trailing: React.ReactNode,
): React.ReactNode {
  const rendered = blocks.map(renderMarkdownBlock.bind(null, streaming));
  if (trailing === null) return rendered;
  const last = blocks.at(-1);
  if (last?.kind !== "paragraph")
    return [...rendered, <p key="trailing">{trailing}</p>];
  return [
    ...rendered.slice(0, -1),
    <p key={blocks.length - 1}>
      {renderInlineMarkdown(last.text, streaming)} {trailing}
    </p>,
  ];
}

function parseMarkdownBlocks(
  text: string,
  streaming: boolean,
): readonly MarkdownBlock[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (
      streaming &&
      index === lines.length - 1 &&
      /^(?:#{1,3}|`{1,2}|[-*]|\d+\.|[-*]\s+\[[ xX]?\]?)\s*$/u.test(line.trim())
    )
      break;
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith("```")
      ) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line.trim());
    if (heading !== null) {
      const [, marks = "", text = ""] = heading;
      blocks.push({
        kind: "heading",
        level: markdownHeadingLevel(marks),
        text,
      });
      index += 1;
      continue;
    }
    if (/^(?:---+|\*\*\*+)$/.test(line.trim())) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX]\]\s+/u.test(line)) {
      const items: TaskListItem[] = [];
      while (index < lines.length) {
        const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u.exec(lines[index] ?? "");
        if (task === null) break;
        const [, mark = "", label = ""] = task;
        items.push({
          id: `task-${index}`,
          label,
          state: {
            kind: mark.toLowerCase() === "x" ? "completed" : "pending",
          },
        });
        index += 1;
      }
      if (items.length > 0) {
        blocks.push({ kind: "tasks", items });
        continue;
      }
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/u.test(line)) {
      const items: string[] = [];
      while (
        index < lines.length &&
        /^\s*(?:[-*]|\d+\.)\s+/u.test(lines[index] ?? "") &&
        !/^\s*[-*]\s+\[[ xX]\]\s+.+/u.test(lines[index] ?? "")
      ) {
        items.push((lines[index] ?? "").replace(/^\s*(?:[-*]|\d+\.)\s+/u, ""));
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim().startsWith(">")) {
      const quote: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith(">")
      ) {
        quote.push((lines[index] ?? "").trim().slice(1).trim());
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const next = lines[index + 1] ?? "";
    if (
      (line.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(next)) ||
      (streaming && line.trim().startsWith("|"))
    ) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 1;
      if (/^[\s|:\-]+$/u.test(lines[index] ?? "")) index += 1;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !startsMarkdownBlock(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function startsMarkdownBlock(line: string): boolean {
  return /^\s*(?:#{1,3}\s|```|>|[-*]\s|\d+\.\s|---+$|\*\*\*+$)/u.test(line);
}

function markdownHeadingLevel(raw: string): 1 | 2 | 3 {
  switch (raw.length) {
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      return 3;
  }
}

function renderMarkdownBlock(
  streaming: boolean,
  block: MarkdownBlock,
  index: number,
): React.ReactNode {
  switch (block.kind) {
    case "heading":
      return React.createElement(
        `h${block.level}`,
        { key: index },
        renderInlineMarkdown(block.text, streaming),
      );
    case "paragraph":
      return <p key={index}>{renderInlineMarkdown(block.text, streaming)}</p>;
    case "quote":
      return (
        <blockquote key={index}>
          {renderInlineMarkdown(block.text, streaming)}
        </blockquote>
      );
    case "list":
      return (
        <ul key={index}>
          {block.items.map(renderMarkdownListItem.bind(null, streaming))}
        </ul>
      );
    case "tasks":
      return <TaskList key={index} items={block.items} />;
    case "code":
      return (
        <pre key={index} data-language={block.language}>
          <code>
            <StreamingRun text={block.text} streaming={streaming} />
          </code>
        </pre>
      );
    case "rule":
      return <hr key={index} />;
    case "table":
      return (
        <div
          className="streaming-table-scroll"
          key={index}
          tabIndex={0}
          role="region"
          aria-label="Response table"
        >
          <table>
            <thead>
              <tr>
                {block.headers.map(renderTableHeader.bind(null, streaming))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map(renderTableRow.bind(null, streaming))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderMarkdownListItem(
  streaming: boolean,
  item: string,
  index: number,
): React.ReactNode {
  return <li key={index}>{renderInlineMarkdown(item, streaming)}</li>;
}

function renderTableHeader(
  streaming: boolean,
  value: string,
  index: number,
): React.ReactNode {
  return (
    <th scope="col" key={index}>
      {renderInlineMarkdown(value, streaming)}
    </th>
  );
}

function renderTableRow(
  streaming: boolean,
  row: readonly string[],
  index: number,
): React.ReactNode {
  return <tr key={index}>{row.map(renderTableCell.bind(null, streaming))}</tr>;
}

function renderTableCell(
  streaming: boolean,
  value: string,
  index: number,
): React.ReactNode {
  return <td key={index}>{renderInlineMarkdown(value, streaming)}</td>;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map(trimTableCell);
}

function trimTableCell(value: string): string {
  return value.trim();
}

function renderInlineMarkdown(
  text: string,
  streaming: boolean,
): React.ReactNode {
  if (streaming) text = completeInlineTail(text);
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|https:\/\/[^\s)]+)/gu);
  return parts.map(renderInlinePart.bind(null, streaming));
}

// Keep an arriving emphasis/code run in its final element as its closing marker arrives.
function completeInlineTail(text: string): string {
  const markers = text.match(/\*\*|`/gu) ?? [];
  let open: "**" | "`" | null = null;
  for (const marker of markers) {
    if (marker === open) open = null;
    else if (open === null) open = marker === "`" ? "`" : "**";
  }
  if (open === null) return text;
  if (text.endsWith(open)) return text.slice(0, -open.length);
  if (open === "**" && text.endsWith("*")) return `${text}*`;
  return `${text}${open}`;
}

function renderInlinePart(
  streaming: boolean,
  part: string,
  index: number,
): React.ReactNode {
  if (part.startsWith("**") && part.endsWith("**"))
    return (
      <strong key={index}>
        <StreamingRun text={part.slice(2, -2)} streaming={streaming} />
      </strong>
    );
  if (part.startsWith("`") && part.endsWith("`"))
    return (
      <code key={index}>
        <StreamingRun text={part.slice(1, -1)} streaming={streaming} />
      </code>
    );
  if (part.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      return <StreamingRun key={index} text={part} streaming={streaming} />;
    }
    return (
      <a key={index} href={url.href} target="_blank" rel="noreferrer">
        <StreamingRun text={part} streaming={streaming} />
      </a>
    );
  }
  return <StreamingRun key={index} text={part} streaming={streaming} />;
}
