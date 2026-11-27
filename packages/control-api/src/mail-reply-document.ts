import { textLimit } from "@purin-labs/contract-schema";
import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * A formatted email reply that a person writes in the Inbox. The editor sends
 * this document, not HTML, so the server never parses markup from a browser:
 * it checks the document and renders the HTML part and the plain-text part of
 * the message from it with the same rules.
 */

const strict = { additionalProperties: false } as const;

/** The text colours of the editor. Each key renders as one fixed colour. */
export const MAIL_REPLY_COLORS = {
  black: "#202124",
  grey: "#5f6368",
  red: "#c5221f",
  orange: "#e37400",
  green: "#188038",
  blue: "#1a73e8",
  purple: "#8430ce",
} as const;
export type MailReplyColor = keyof typeof MAIL_REPLY_COLORS;

export const MAIL_REPLY_FONTS = {
  sans: "Arial, Helvetica, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', Courier, monospace",
} as const;
export type MailReplyFont = keyof typeof MAIL_REPLY_FONTS;

const MAIL_REPLY_SIZES = {
  small: "12px",
  normal: "14px",
  large: "18px",
  huge: "24px",
} as const;
export type MailReplySize = keyof typeof MAIL_REPLY_SIZES;

/** The deepest indent of a block or a list item. */
export const MAIL_REPLY_MAX_INDENT = 6;
const MAX_BLOCKS = 2_000;
const MAX_RUNS = 400;

function keysOf(record: Readonly<Record<string, string>>) {
  return Type.Union(Object.keys(record).map((key) => Type.Literal(key)));
}

const indentSchema = Type.Integer({
  minimum: 1,
  maximum: MAIL_REPLY_MAX_INDENT,
});

const mailReplyRunSchema = Type.Object(
  {
    text: Type.String({ minLength: 1 }),
    bold: Type.Optional(Type.Literal(true)),
    italic: Type.Optional(Type.Literal(true)),
    underline: Type.Optional(Type.Literal(true)),
    strike: Type.Optional(Type.Literal(true)),
    /** An http, https or mailto address. */
    href: Type.Optional(
      Type.String({ pattern: '^(https?://|mailto:)[^\\s"<>]+$' }),
    ),
    color: Type.Optional(keysOf(MAIL_REPLY_COLORS)),
    font: Type.Optional(keysOf(MAIL_REPLY_FONTS)),
    size: Type.Optional(keysOf(MAIL_REPLY_SIZES)),
  },
  strict,
);
export type MailReplyRun = Readonly<{
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  href?: string;
  color?: MailReplyColor;
  font?: MailReplyFont;
  size?: MailReplySize;
}>;

const runsSchema = Type.Array(mailReplyRunSchema, { maxItems: MAX_RUNS });

const mailReplyBlockSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Union([
        Type.Literal("paragraph"),
        Type.Literal("heading1"),
        Type.Literal("heading2"),
        Type.Literal("quote"),
      ]),
      align: Type.Optional(
        Type.Union([Type.Literal("center"), Type.Literal("right")]),
      ),
      indent: Type.Optional(indentSchema),
      runs: runsSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("list"),
      ordered: Type.Boolean(),
      items: Type.Array(
        Type.Object(
          { indent: Type.Optional(indentSchema), runs: runsSchema },
          strict,
        ),
        { minItems: 1, maxItems: MAX_BLOCKS },
      ),
    },
    strict,
  ),
]);

const mailReplyDocumentSchema = Type.Object(
  {
    blocks: Type.Array(mailReplyBlockSchema, {
      minItems: 1,
      maxItems: MAX_BLOCKS,
    }),
  },
  strict,
);

type MailReplyTextBlock = Readonly<{
  kind: "paragraph" | "heading1" | "heading2" | "quote";
  align?: "center" | "right";
  indent?: number;
  runs: readonly MailReplyRun[];
}>;
export type MailReplyListItem = Readonly<{
  indent?: number;
  runs: readonly MailReplyRun[];
}>;
type MailReplyListBlock = Readonly<{
  kind: "list";
  ordered: boolean;
  items: readonly MailReplyListItem[];
}>;
export type MailReplyBlock = MailReplyTextBlock | MailReplyListBlock;
export type MailReplyDocument = Readonly<{
  blocks: readonly MailReplyBlock[];
}>;

export function parseMailReplyDocument(
  value: unknown,
): MailReplyDocument | null {
  return Value.Check(mailReplyDocumentSchema, value)
    ? (value as MailReplyDocument)
    : null;
}

/** The plain-text part: one line for each block, lists marked as in mail. */
export function renderMailReplyText(document: MailReplyDocument): string {
  const lines: string[] = [];
  for (const block of document.blocks) {
    if (block.kind === "list") {
      const numbers: number[] = [];
      for (const item of block.items) {
        const depth = item.indent ?? 0;
        numbers.length = depth + 1;
        numbers[depth] = (numbers[depth] ?? 0) + 1;
        const pad = "   ".repeat(depth);
        const marker = block.ordered ? `${String(numbers[depth])}. ` : "- ";
        lines.push(
          `${pad}${marker}${runsText(item.runs).replaceAll("\n", `\n${pad}   `)}`,
        );
      }
      continue;
    }
    const pad = "   ".repeat(block.indent ?? 0);
    const prefix = block.kind === "quote" ? "> " : "";
    const text = runsText(block.runs);
    lines.push(
      text
        .split("\n")
        .map((line) => `${pad}${prefix}${line}`)
        .join("\n"),
    );
  }
  return lines.join("\n").replace(/\s+$/u, "");
}

/** The HTML part. Every text and address is escaped; styles are fixed. */
export function renderMailReplyHtml(document: MailReplyDocument): string {
  const parts = document.blocks.map(renderBlock);
  return `<div dir="ltr" style="font-family:${MAIL_REPLY_FONTS.sans};font-size:${MAIL_REPLY_SIZES.normal};line-height:1.5;color:${MAIL_REPLY_COLORS.black}">${parts.join("")}</div>`;
}

function renderBlock(block: MailReplyBlock): string {
  if (block.kind === "list") return renderList(block.items, 0, block.ordered);
  const align = block.align === undefined ? "" : `text-align:${block.align};`;
  const content = renderRuns(block.runs);
  switch (block.kind) {
    case "heading1":
      return `<h1${indentStyle(block.indent, `margin:0.4em 0;font-size:26px;${align}`)}>${content}</h1>`;
    case "heading2":
      return `<h2${indentStyle(block.indent, `margin:0.4em 0;font-size:20px;${align}`)}>${content}</h2>`;
    case "quote":
      return `<blockquote${indentStyle(block.indent, `margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;${align}`)}>${content}</blockquote>`;
    case "paragraph":
      return `<div${indentStyle(block.indent, align)}>${content}</div>`;
  }
}

/** A flat list with indents renders as nested lists, each with its numbers. */
function renderList(
  items: readonly MailReplyListItem[],
  level: number,
  ordered: boolean,
): string {
  const tag = ordered ? "ol" : "ul";
  let html = "";
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item === undefined) break;
    const depth = item.indent ?? 0;
    if (depth > level) {
      const nested: MailReplyListItem[] = [];
      while ((items[index]?.indent ?? 0) > level) {
        const next = items[index];
        if (next === undefined) break;
        nested.push(next);
        index += 1;
      }
      html += renderList(nested, level + 1, ordered);
      continue;
    }
    html += `<li>${renderRuns(item.runs)}</li>`;
    index += 1;
  }
  return `<${tag} style="margin:0;padding-left:28px">${html}</${tag}>`;
}

function indentStyle(indent: number | undefined, style: string): string {
  const margin =
    indent === undefined ? "" : `margin-left:${String(indent * 40)}px;`;
  const all = `${style}${margin}`;
  return all === "" ? "" : ` style="${all}"`;
}

function renderRuns(runs: readonly MailReplyRun[]): string {
  if (runs.length === 0) return "<br>";
  return runs.map(renderRun).join("");
}

function renderRun(run: MailReplyRun): string {
  let html = escapeHtml(run.text).replaceAll("\n", "<br>");
  const styles = [
    run.color === undefined ? "" : `color:${MAIL_REPLY_COLORS[run.color]}`,
    run.font === undefined ? "" : `font-family:${MAIL_REPLY_FONTS[run.font]}`,
    run.size === undefined ? "" : `font-size:${MAIL_REPLY_SIZES[run.size]}`,
  ].filter((style) => style !== "");
  if (styles.length > 0)
    html = `<span style="${styles.join(";")}">${html}</span>`;
  if (run.strike === true) html = `<s>${html}</s>`;
  if (run.underline === true) html = `<u>${html}</u>`;
  if (run.italic === true) html = `<i>${html}</i>`;
  if (run.bold === true) html = `<b>${html}</b>`;
  if (run.href !== undefined)
    html = `<a href="${escapeHtml(run.href)}">${html}</a>`;
  return html;
}

function runsText(runs: readonly MailReplyRun[]): string {
  return runs
    .map((run) =>
      run.href === undefined ||
      run.href === `mailto:${run.text}` ||
      run.href === run.text
        ? run.text
        : `${run.text} (${run.href})`,
    )
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The files of a reply together, before base64. */
export const MAIL_REPLY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAIL_REPLY_ATTACHMENT_COUNT = 10;

/** The file types that Gmail refuses to send, by extension. */
const BLOCKED_EXTENSIONS = new Set([
  "ade",
  "adp",
  "apk",
  "appx",
  "appxbundle",
  "bat",
  "cab",
  "chm",
  "cmd",
  "com",
  "cpl",
  "diagcab",
  "diagcfg",
  "diagpack",
  "dll",
  "dmg",
  "ex",
  "ex_",
  "exe",
  "hta",
  "img",
  "ins",
  "iso",
  "isp",
  "jar",
  "jnlp",
  "js",
  "jse",
  "lib",
  "lnk",
  "mde",
  "msc",
  "msi",
  "msix",
  "msixbundle",
  "msp",
  "mst",
  "nsh",
  "pif",
  "ps1",
  "scr",
  "sct",
  "shb",
  "sys",
  "vb",
  "vbe",
  "vbs",
  "vhd",
  "vxd",
  "wsc",
  "wsf",
  "wsh",
  "xll",
]);

/** Gmail refuses a message that carries this file. */
export function mailReplyAttachmentBlocked(name: string): boolean {
  const extension = /\.([^.]+)$/u.exec(name.trim().toLowerCase())?.[1];
  return extension !== undefined && BLOCKED_EXTENSIONS.has(extension);
}

/** One file of a reply. `data` is its standard, padded base64. */
const mailReplyAttachmentSchema = Type.Object(
  {
    name: textLimit(Type.String({ minLength: 1, maxLength: 200 })),
    type: textLimit(
      Type.String({
        maxLength: 120,
        pattern: "^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$",
      }),
    ),
    data: Type.String({ minLength: 1 }),
  },
  strict,
);
export type MailReplyAttachment = Readonly<{
  name: string;
  type: string;
  data: string;
}>;

export function parseMailReplyAttachments(
  value: unknown,
): readonly MailReplyAttachment[] | null {
  if (!Array.isArray(value) || value.length > MAIL_REPLY_ATTACHMENT_COUNT)
    return null;
  for (const item of value) {
    if (!Value.Check(mailReplyAttachmentSchema, item)) return null;
  }
  return value as readonly MailReplyAttachment[];
}
