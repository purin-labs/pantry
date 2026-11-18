import {
  MAIL_REPLY_COLORS,
  MAIL_REPLY_MAX_INDENT,
  type MailReplyBlock,
  type MailReplyColor,
  type MailReplyDocument,
  type MailReplyFont,
  type MailReplyListItem,
  type MailReplyRun,
  type MailReplySize,
} from "@seams/control-api";

/**
 * Reads the reply editor's content as a reply document. Only the formats that
 * the toolbar makes count: anything else keeps its text and loses its form.
 */
export function readReplyDocument(root: HTMLElement): MailReplyDocument {
  const blocks: MailReplyBlock[] = [];
  readBlocks(root, NO_CONTEXT, blocks);
  while (blocks.length > 0 && isBlank(blocks[blocks.length - 1])) blocks.pop();
  while (blocks.length > 0 && isBlank(blocks[0])) blocks.shift();
  return { blocks: blocks.length === 0 ? [EMPTY_PARAGRAPH] : blocks };
}

type Context = Readonly<{
  indent: number;
  quote: boolean;
  align: "center" | "right" | null;
}>;

type Marks = Omit<MailReplyRun, "text">;

const NO_CONTEXT: Context = { indent: 0, quote: false, align: null };
const EMPTY_PARAGRAPH: MailReplyBlock = { kind: "paragraph", runs: [] };

const BLOCK_TAGS = new Set([
  "DIV",
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "PRE",
]);

function isBlockElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName);
}

function readBlocks(
  parent: Node,
  context: Context,
  blocks: MailReplyBlock[],
): void {
  let inline: Node[] = [];
  const flush = (): void => {
    if (inline.length === 0) return;
    blocks.push(textBlock("paragraph", inlineRuns(inline), context));
    inline = [];
  };
  for (const child of parent.childNodes) {
    if (!isBlockElement(child)) {
      inline.push(child);
      continue;
    }
    flush();
    readBlock(child, context, blocks);
  }
  flush();
}

function readBlock(
  element: HTMLElement,
  context: Context,
  blocks: MailReplyBlock[],
): void {
  const own = withAlign(element, context);
  switch (element.tagName) {
    case "UL":
    case "OL": {
      const items: MailReplyListItem[] = [];
      readList(element, context.indent, items);
      if (items.length > 0)
        blocks.push({ kind: "list", ordered: element.tagName === "OL", items });
      return;
    }
    case "BLOCKQUOTE":
      // The editor's indent is a borderless blockquote; a quote has a border.
      readBlocks(
        element,
        isIndent(element)
          ? { ...own, indent: own.indent + 1 }
          : { ...own, quote: true },
        blocks,
      );
      return;
    case "H1":
      blocks.push(
        textBlock("heading1", inlineRuns([...element.childNodes]), own),
      );
      return;
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      blocks.push(
        textBlock("heading2", inlineRuns([...element.childNodes]), own),
      );
      return;
    default: {
      const indented = { ...own, indent: own.indent + marginIndent(element) };
      if ([...element.childNodes].some(isBlockElement)) {
        readBlocks(element, indented, blocks);
        return;
      }
      blocks.push(
        textBlock("paragraph", inlineRuns([...element.childNodes]), indented),
      );
    }
  }
}

function readList(
  list: HTMLElement,
  indent: number,
  items: MailReplyListItem[],
): void {
  for (const child of list.childNodes) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.tagName === "UL" || child.tagName === "OL") {
      readList(child, indent + 1, items);
      continue;
    }
    if (child.tagName !== "LI") continue;
    const own: Node[] = [];
    const nested: HTMLElement[] = [];
    for (const node of child.childNodes) {
      if (
        node instanceof HTMLElement &&
        (node.tagName === "UL" || node.tagName === "OL")
      )
        nested.push(node);
      else own.push(node);
    }
    items.push(withIndent({ runs: inlineRuns(own) }, indent));
    for (const sub of nested) readList(sub, indent + 1, items);
  }
}

function withIndent(item: { runs: MailReplyRun[] }, indent: number) {
  const level = Math.min(indent, MAIL_REPLY_MAX_INDENT);
  return level === 0 ? item : { ...item, indent: level };
}

function textBlock(
  kind: "paragraph" | "heading1" | "heading2",
  runs: MailReplyRun[],
  context: Context,
): MailReplyBlock {
  const level = Math.min(context.indent, MAIL_REPLY_MAX_INDENT);
  return {
    kind: context.quote && kind === "paragraph" ? "quote" : kind,
    ...(context.align === null ? {} : { align: context.align }),
    ...(level === 0 ? {} : { indent: level }),
    runs,
  };
}

function withAlign(element: HTMLElement, context: Context): Context {
  const align = element.style.textAlign || element.getAttribute("align");
  if (align === "center" || align === "right") return { ...context, align };
  if (align === "left" || align === "start") return { ...context, align: null };
  return context;
}

function isIndent(element: HTMLElement): boolean {
  return (
    element.style.borderStyle === "none" ||
    element.style.border === "none" ||
    element.getAttribute("style")?.includes("border: none") === true
  );
}

function marginIndent(element: HTMLElement): number {
  const margin = Number.parseFloat(element.style.marginLeft);
  return Number.isFinite(margin) && margin > 0 ? Math.round(margin / 40) : 0;
}

/** The text of inline content, with the marks that its elements give. */
function inlineRuns(nodes: readonly Node[]): MailReplyRun[] {
  const runs: MailReplyRun[] = [];
  for (const node of nodes) readInline(node, {}, runs);
  // A last line break only holds an empty line open in the editor.
  const last = runs[runs.length - 1];
  if (last !== undefined && last.text.endsWith("\n")) {
    const text = last.text.slice(0, -1);
    if (text === "") runs.pop();
    else runs[runs.length - 1] = { ...last, text };
  }
  return runs;
}

function readInline(node: Node, marks: Marks, runs: MailReplyRun[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replaceAll(" ", " ");
    if (text !== "") pushRun(runs, { ...marks, text });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.tagName === "BR") {
    pushRun(runs, { ...marks, text: "\n" });
    return;
  }
  if (isBlockElement(node)) {
    // A block inside a line, such as a pasted one, keeps its own line.
    if (runs.length > 0) pushRun(runs, { ...marks, text: "\n" });
  }
  const own = elementMarks(node, marks);
  for (const child of node.childNodes) readInline(child, own, runs);
}

function elementMarks(element: HTMLElement, marks: Marks): Marks {
  const next: { -readonly [K in keyof Marks]: Marks[K] } = { ...marks };
  switch (element.tagName) {
    case "B":
    case "STRONG":
      next.bold = true;
      break;
    case "I":
    case "EM":
      next.italic = true;
      break;
    case "U":
      next.underline = true;
      break;
    case "S":
    case "STRIKE":
    case "DEL":
      next.strike = true;
      break;
    case "A": {
      const href = element.getAttribute("href") ?? "";
      if (/^(https?:\/\/|mailto:)[^\s"<>]+$/u.test(href)) next.href = href;
      break;
    }
    case "FONT": {
      const color = colorKey(element.getAttribute("color"));
      if (color !== null) next.color = color;
      const font = fontKey(element.getAttribute("face"));
      if (font !== null) next.font = font;
      const size = sizeKey(element.getAttribute("size"));
      if (size !== null) next.size = size;
      break;
    }
  }
  const style = element.style;
  if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600)
    next.bold = true;
  if (style.fontStyle === "italic") next.italic = true;
  if (style.textDecorationLine.includes("underline")) next.underline = true;
  if (style.textDecorationLine.includes("line-through")) next.strike = true;
  const color = colorKey(style.color);
  if (color !== null) next.color = color;
  const font = fontKey(style.fontFamily);
  if (font !== null) next.font = font;
  if (next.size === "normal") delete next.size;
  if (next.font === "sans") delete next.font;
  if (next.color === "black") delete next.color;
  return next;
}

function pushRun(runs: MailReplyRun[], run: MailReplyRun): void {
  const last = runs[runs.length - 1];
  if (last !== undefined && sameMarks(last, run)) {
    runs[runs.length - 1] = { ...last, text: last.text + run.text };
    return;
  }
  runs.push(run);
}

const MARK_KEYS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "href",
  "color",
  "font",
  "size",
] as const;

function sameMarks(left: MailReplyRun, right: MailReplyRun): boolean {
  return MARK_KEYS.every((key) => left[key] === right[key]);
}

function colorKey(value: string | null): MailReplyColor | null {
  if (value === null || value === "") return null;
  const hex = toHex(value);
  for (const [key, color] of Object.entries(MAIL_REPLY_COLORS)) {
    if (color === hex) return key as MailReplyColor;
  }
  return null;
}

function toHex(value: string): string {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(value.trim());
  if (rgb === null) return value.trim().toLowerCase();
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

function fontKey(value: string | null): MailReplyFont | null {
  if (value === null || value === "") return null;
  const face = value.toLowerCase();
  if (face.includes("courier") || face.includes("mono")) return "mono";
  if (face.includes("georgia") || face.includes("times") || face === "serif")
    return "serif";
  if (face.includes("arial") || face.includes("sans")) return "sans";
  return null;
}

/** The editor's font sizes: 2 small, 3 normal, 5 large, 6 huge. */
function sizeKey(value: string | null): MailReplySize | null {
  if (value === null || value.trim() === "") return null;
  const size = Number(value);
  if (!Number.isInteger(size)) return null;
  if (size <= 2) return "small";
  if (size === 3) return "normal";
  if (size <= 5) return "large";
  return "huge";
}

function isBlank(block: MailReplyBlock | undefined): boolean {
  return (
    block !== undefined &&
    block.kind !== "list" &&
    block.runs.every((run) => run.text.trim() === "")
  );
}
