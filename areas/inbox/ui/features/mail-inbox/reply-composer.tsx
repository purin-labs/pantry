import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ALargeSmall,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Heading,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  Paperclip,
  X,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  RemoveFormatting,
  Reply,
  Strikethrough,
  TextQuote,
  Trash2,
  Underline,
} from "lucide-react";
import { encodeBase64 } from "@purin-labs/std";
import {
  MAIL_REPLY_ATTACHMENT_BYTES,
  MAIL_REPLY_ATTACHMENT_COUNT,
  MAIL_REPLY_COLORS,
  MAIL_REPLY_FONTS,
  mailReplyAttachmentBlocked,
  type MailReplyAttachment,
  renderMailReplyText,
  type MailReplyColor,
  type MailReplyDocument,
} from "@purin-labs/control-api";
import { GlideHighlight } from "@purin-labs/ui/glide-highlight";
import { HoverLabel } from "@purin-labs/ui/hover-label";
import "@purin-labs/ui/action-menu.css";
import { readReplyDocument } from "./reply-document";

type Props = Readonly<{
  recipient: Readonly<{ name: string; address: string }>;
  subject: string;
  hidden: boolean;
  sending: boolean;
  /** The reply takes the whole pane. */
  expanded: boolean;
  problem: React.ReactNode;
  onText: (text: string) => void;
  onToggleExpanded: () => void;
  onClose: () => void;
  onDiscard: () => void;
  /** Resolves true when the reply went, and the editor then empties. */
  onSend: (
    document: MailReplyDocument,
    text: string,
    attachments: readonly MailReplyAttachment[],
  ) => Promise<boolean>;
}>;

type Active = Readonly<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  ordered: boolean;
  bulleted: boolean;
}>;

const NOTHING_ACTIVE: Active = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  ordered: false,
  bulleted: false,
};

const FONT_CHOICES = [
  { label: "Sans Serif", value: MAIL_REPLY_FONTS.sans },
  { label: "Serif", value: MAIL_REPLY_FONTS.serif },
  { label: "Fixed width", value: MAIL_REPLY_FONTS.mono },
] as const;

/** The editor's font sizes, as `fontSize` takes them. */
const SIZE_CHOICES = [
  { label: "Small", value: "2" },
  { label: "Normal", value: "3" },
  { label: "Large", value: "5" },
  { label: "Huge", value: "6" },
] as const;

const STYLE_CHOICES = [
  { label: "Normal text", value: "div" },
  { label: "Heading 1", value: "h1" },
  { label: "Heading 2", value: "h2" },
] as const;

const SHORTCUTS: Readonly<Record<string, string>> = {
  b: "bold",
  i: "italic",
  u: "underline",
};

const COLOR_LABELS: Readonly<Record<MailReplyColor, string>> = {
  black: "Black",
  grey: "Grey",
  red: "Red",
  orange: "Orange",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

/**
 * The reply as an email: the recipient, the text and one formatting toolbar
 * that the "Aa" button shows or hides, as in Gmail. The editor keeps its
 * selection while a toolbar control has the focus, so each control acts on
 * the text that the person chose.
 */
export function MailReplyComposer(props: Props): React.ReactNode {
  const editor = React.useRef<HTMLDivElement>(null);
  const range = React.useRef<Range | null>(null);
  const [active, setActive] = React.useState<Active>(NOTHING_ACTIVE);
  const [empty, setEmpty] = React.useState(true);
  const [toolbar, setToolbar] = React.useState(true);
  const [link, setLink] = React.useState<string | null>(null);
  const linkInput = React.useRef<HTMLInputElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [files, setFiles] = React.useState<readonly File[]>([]);
  const [fileProblem, setFileProblem] = React.useState<string | null>(null);
  React.useEffect(bindSelection.bind(null, editor, range, setActive), []);
  const shown = React.useRef(!props.hidden);
  React.useEffect(focusWhenShown.bind(null, editor, shown, props.hidden), [
    props.hidden,
  ]);
  React.useEffect(focusLinkInput.bind(null, linkInput, link !== null), [
    link !== null,
  ]);

  const run = (command: string, value?: string): void => {
    const element = editor.current;
    if (element === null) return;
    restoreSelection(element, range);
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, value);
    saveSelection(element, range);
    setActive(readActive());
    changed();
  };
  const changed = (): void => {
    const element = editor.current;
    if (element === null) return;
    const text = renderMailReplyText(readReplyDocument(element));
    setEmpty(text.trim() === "");
    props.onText(text);
  };
  // Set before the first await, so that a second click while the files
  // are read sends nothing.
  const sendingNow = React.useRef(false);
  const send = async (): Promise<void> => {
    const element = editor.current;
    if (element === null || props.sending || sendingNow.current) return;
    const document = readReplyDocument(element);
    const text = renderMailReplyText(document);
    if (text.trim() === "") return;
    sendingNow.current = true;
    try {
      const attachments = await Promise.all(files.map(readAttachment));
      if (await props.onSend(document, text, attachments)) {
        element.replaceChildren();
        setEmpty(true);
        setFiles([]);
        setFileProblem(null);
      }
    } finally {
      sendingNow.current = false;
    }
  };
  const addFiles = (added: readonly File[]): void => {
    const result = acceptFiles(files, added);
    setFiles(result.files);
    setFileProblem(result.problem);
  };
  const chooseFiles = (event: React.ChangeEvent<HTMLInputElement>): void => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };
  const removeFile = (file: File): void => {
    setFiles((current) => current.filter((other) => other !== file));
    setFileProblem(null);
  };
  const dragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event: React.DragEvent<HTMLElement>): void => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  };
  const discard = (): void => {
    editor.current?.replaceChildren();
    setEmpty(true);
    setLink(null);
    setFiles([]);
    setFileProblem(null);
    props.onDiscard();
  };
  const applyLink = (event: React.FormEvent): void => {
    event.preventDefault();
    const element = editor.current;
    const href = linkHref(link ?? "");
    setLink(null);
    if (element === null || href === null) return;
    restoreSelection(element, range);
    const selection = window.getSelection();
    const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (current === null) return;
    if (current.collapsed) {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.textContent = href.replace(/^mailto:/u, "");
      current.insertNode(anchor);
      current.setStartAfter(anchor);
      current.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(current);
    } else {
      document.execCommand("createLink", false, href);
    }
    saveSelection(element, range);
    changed();
  };
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void send();
      return;
    }
    // The shortcuts run the toolbar's own commands, so they toggle the same.
    const command = SHORTCUTS[event.key.toLowerCase()];
    if (command === undefined || event.shiftKey) return;
    event.preventDefault();
    run(command);
  };
  // A paste keeps its text only, so no foreign markup enters the reply.
  const paste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    document.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
  };
  const keepSelection = (event: React.MouseEvent): void => {
    event.preventDefault();
  };
  const returnFocus = (event: Event): void => {
    event.preventDefault();
    editor.current?.focus();
  };

  const tool = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    pressed?: boolean,
  ): React.ReactNode => (
    <HoverLabel label={label}>
      <button
        type="button"
        className="mail-reply-tool"
        aria-label={label}
        aria-pressed={pressed}
        onMouseDown={keepSelection}
        onClick={action}
        disabled={props.sending}
      >
        {icon}
      </button>
    </HoverLabel>
  );
  const menu = (
    label: string,
    trigger: React.ReactNode,
    items: React.ReactNode,
    wide = false,
  ): React.ReactNode => (
    <Menu.Root modal={false}>
      <HoverLabel label={label}>
        <Menu.Trigger asChild>
          <button
            type="button"
            className="mail-reply-tool"
            data-wide={wide ? "" : undefined}
            aria-label={label}
            onMouseDown={keepSelection}
            disabled={props.sending}
          >
            {trigger}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Menu.Trigger>
      </HoverLabel>
      <Menu.Portal>
        <Menu.Content
          className="action-menu mail-reply-menu"
          aria-label={label}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={returnFocus}
        >
          <GlideHighlight target="[data-highlighted]" />
          {items}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
  const choice = (
    key: string,
    label: React.ReactNode,
    action: () => void,
  ): React.ReactNode => (
    <Menu.Item key={key} className="action-menu-item" onSelect={action}>
      {label}
    </Menu.Item>
  );

  return (
    <section
      className="mail-reply"
      aria-labelledby="mail-reply-to"
      hidden={props.hidden}
      onKeyDown={keepEscape}
      onDragOver={dragOver}
      onDrop={drop}
    >
      <header className="mail-reply-head">
        <Reply size={18} aria-hidden="true" />
        <p id="mail-reply-to" className="mail-reply-to">
          <span className="visually-hidden">Reply to </span>
          {props.recipient.name === props.recipient.address ? (
            props.recipient.address
          ) : (
            <>
              {props.recipient.name}{" "}
              <span className="mail-reply-address">
                {props.recipient.address}
              </span>
            </>
          )}
          <span className="visually-hidden">. Subject: {props.subject}</span>
        </p>
        <HoverLabel
          label={
            props.expanded ? "Show the conversation" : "Use the whole pane"
          }
        >
          <button
            type="button"
            className="mail-icon-button"
            aria-label={
              props.expanded ? "Show the conversation" : "Use the whole pane"
            }
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? (
              <Minimize2 size={16} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" />
            )}
          </button>
        </HoverLabel>
        <HoverLabel label="Close the reply">
          <button
            type="button"
            className="mail-icon-button"
            aria-label="Close the reply"
            onClick={props.onClose}
          >
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        </HoverLabel>
      </header>
      <div
        ref={editor}
        className="mail-reply-editor"
        contentEditable={!props.sending}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Your reply"
        data-placeholder="Write your reply"
        data-empty={empty ? "" : undefined}
        onInput={changed}
        onKeyDown={keyDown}
        onPaste={paste}
      />
      {files.length === 0 ? null : (
        <ul className="mail-reply-files" aria-label="Attachments">
          {files.map((file, index) => (
            <li key={`${file.name}:${String(index)}`}>
              <Paperclip size={14} aria-hidden="true" />
              <span className="mail-reply-file-name">{file.name}</span>
              <span className="mail-reply-file-size">
                {formatBytes(file.size)}
              </span>
              <button
                type="button"
                className="mail-icon-button"
                aria-label={`Remove ${file.name}`}
                onClick={() => removeFile(file)}
                disabled={props.sending}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {fileProblem === null ? null : (
        <p role="alert" className="mail-reply-problem">
          {fileProblem}
        </p>
      )}
      {props.problem}
      {link === null ? null : (
        <form className="mail-reply-link" onSubmit={applyLink}>
          <label>
            Link address
            <input
              ref={linkInput}
              type="text"
              inputMode="url"
              value={link}
              placeholder="https://example.com"
              onChange={(event) => setLink(event.target.value)}
            />
          </label>
          <button type="submit" disabled={linkHref(link) === null}>
            Add link
          </button>
          <button type="button" onClick={() => setLink(null)}>
            Cancel
          </button>
        </form>
      )}
      {toolbar ? (
        <div
          className="mail-reply-toolbar"
          role="toolbar"
          aria-label="Formatting"
        >
          {menu(
            "Font",
            <span className="mail-reply-tool-text">Sans Serif</span>,
            FONT_CHOICES.map((font) =>
              choice(
                font.label,
                <span style={{ fontFamily: font.value }}>{font.label}</span>,
                () => run("fontName", font.value),
              ),
            ),
            true,
          )}
          {menu(
            "Text style",
            <Heading size={18} aria-hidden="true" />,
            STYLE_CHOICES.map((style) =>
              choice(style.label, style.label, () =>
                run("formatBlock", style.value),
              ),
            ),
          )}
          {menu(
            "Size",
            <ALargeSmall size={18} aria-hidden="true" />,
            SIZE_CHOICES.map((size) =>
              choice(size.label, size.label, () => run("fontSize", size.value)),
            ),
          )}
          <span className="mail-reply-rule" aria-hidden="true" />
          {tool("Bold", <Bold size={18} />, () => run("bold"), active.bold)}
          {tool(
            "Italic",
            <Italic size={18} />,
            () => run("italic"),
            active.italic,
          )}
          {tool(
            "Underline",
            <Underline size={18} />,
            () => run("underline"),
            active.underline,
          )}
          {menu(
            "Text colour",
            <Baseline size={18} aria-hidden="true" />,
            (Object.keys(MAIL_REPLY_COLORS) as MailReplyColor[]).map((key) =>
              choice(
                key,
                <>
                  <span
                    className="mail-reply-swatch"
                    style={{ background: MAIL_REPLY_COLORS[key] }}
                    aria-hidden="true"
                  />
                  {COLOR_LABELS[key]}
                </>,
                () => run("foreColor", MAIL_REPLY_COLORS[key]),
              ),
            ),
          )}
          <span className="mail-reply-rule" aria-hidden="true" />
          {menu("Align", <AlignLeft size={18} aria-hidden="true" />, [
            choice("left", alignLabel(AlignLeft, "Left"), () =>
              run("justifyLeft"),
            ),
            choice("center", alignLabel(AlignCenter, "Centre"), () =>
              run("justifyCenter"),
            ),
            choice("right", alignLabel(AlignRight, "Right"), () =>
              run("justifyRight"),
            ),
          ])}
          {tool(
            "Numbered list",
            <ListOrdered size={18} />,
            () => run("insertOrderedList"),
            active.ordered,
          )}
          {tool(
            "Bulleted list",
            <List size={18} />,
            () => run("insertUnorderedList"),
            active.bulleted,
          )}
          {tool("Indent less", <IndentDecrease size={18} />, () =>
            run("outdent"),
          )}
          {tool("Indent more", <IndentIncrease size={18} />, () =>
            run("indent"),
          )}
          {tool("Quote", <TextQuote size={18} />, () =>
            run("formatBlock", "blockquote"),
          )}
          <span className="mail-reply-rule" aria-hidden="true" />
          {tool(
            "Strikethrough",
            <Strikethrough size={18} />,
            () => run("strikeThrough"),
            active.strike,
          )}
          <span className="mail-reply-rule" aria-hidden="true" />
          {tool("Remove formatting", <RemoveFormatting size={18} />, () =>
            run("removeFormat"),
          )}
        </div>
      ) : null}
      <footer className="mail-reply-foot">
        <button
          type="button"
          className="mail-reply-send"
          disabled={props.sending || empty}
          onClick={() => void send()}
        >
          {props.sending ? "Sending…" : "Send"}
        </button>
        <HoverLabel label="Formatting options">
          <button
            type="button"
            className="mail-reply-tool"
            aria-label="Formatting options"
            aria-pressed={toolbar}
            onMouseDown={keepSelection}
            onClick={() => setToolbar((shown) => !shown)}
          >
            <span className="mail-reply-aa" aria-hidden="true">
              Aa
            </span>
          </button>
        </HoverLabel>
        {tool("Attach files", <Paperclip size={18} />, () =>
          fileInput.current?.click(),
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={chooseFiles}
          aria-label="Attach files"
          tabIndex={-1}
        />
        {tool("Insert link", <Link size={18} />, () => {
          const element = editor.current;
          if (element !== null) saveSelection(element, range);
          setLink("");
        })}
        <span className="mail-reply-spacer" />
        <HoverLabel label="Discard the reply">
          <button
            type="button"
            className="mail-icon-button"
            aria-label="Discard the reply"
            onClick={discard}
            disabled={props.sending}
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
        </HoverLabel>
      </footer>
    </section>
  );
}

/**
 * Adds files up to Gmail's rules and the reply's limits. A file that does not
 * fit stays out, and the problem says why.
 */
function acceptFiles(
  current: readonly File[],
  added: readonly File[],
): Readonly<{ files: readonly File[]; problem: string | null }> {
  const files = [...current];
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let problem: string | null = null;
  for (const file of added) {
    if (mailReplyAttachmentBlocked(file.name)) {
      problem = `Gmail does not send this type of file: ${file.name}.`;
      continue;
    }
    if (file.size === 0) {
      problem = `${file.name} is empty.`;
      continue;
    }
    if (files.length >= MAIL_REPLY_ATTACHMENT_COUNT) {
      problem = `A reply holds at most ${String(MAIL_REPLY_ATTACHMENT_COUNT)} files.`;
      continue;
    }
    if (total + file.size > MAIL_REPLY_ATTACHMENT_BYTES) {
      problem = `The files of a reply can be ${formatBytes(MAIL_REPLY_ATTACHMENT_BYTES)} together at most.`;
      continue;
    }
    files.push(file);
    total += file.size;
  }
  return { files, problem };
}

async function readAttachment(file: File): Promise<MailReplyAttachment> {
  const type = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(file.type)
    ? file.type
    : "application/octet-stream";
  return {
    name: file.name.slice(0, 200),
    type,
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
}

/** Escape in the reply never closes the conversation and its reply. */
function keepEscape(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key === "Escape") event.stopPropagation();
}

function alignLabel(Icon: typeof AlignLeft, label: string): React.ReactNode {
  return (
    <>
      <span className="action-menu-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      {label}
    </>
  );
}

/** An http, https or mailto address, with https added to a bare host. */
function linkHref(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  const href = /^(https?:\/\/|mailto:)/iu.test(text)
    ? text
    : /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/u.test(text)
      ? `mailto:${text}`
      : `https://${text}`;
  return /^(https?:\/\/|mailto:)[^\s"<>]+$/u.test(href) ? href : null;
}

/** The editor remembers its selection, so a toolbar control can use it. */
function bindSelection(
  editor: React.RefObject<HTMLDivElement | null>,
  range: React.RefObject<Range | null>,
  setActive: React.Dispatch<React.SetStateAction<Active>>,
): () => void {
  const changed = (): void => {
    const element = editor.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.rangeCount === 0 ||
      !element.contains(selection.anchorNode)
    )
      return;
    saveSelection(element, range);
    setActive(readActive());
  };
  document.addEventListener("selectionchange", changed);
  return document.removeEventListener.bind(
    document,
    "selectionchange",
    changed,
  );
}

function saveSelection(
  element: HTMLElement,
  range: React.RefObject<Range | null>,
): void {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const current = selection.getRangeAt(0);
  if (element.contains(current.commonAncestorContainer))
    range.current = current.cloneRange();
}

function restoreSelection(
  element: HTMLElement,
  range: React.RefObject<Range | null>,
): void {
  element.focus();
  const saved = range.current;
  const selection = window.getSelection();
  if (saved === null || selection === null) return;
  if (!element.contains(saved.commonAncestorContainer)) return;
  selection.removeAllRanges();
  selection.addRange(saved);
}

function readActive(): Active {
  return {
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    strike: document.queryCommandState("strikeThrough"),
    ordered: document.queryCommandState("insertOrderedList"),
    bulleted: document.queryCommandState("insertUnorderedList"),
  };
}

/** The editor takes focus when the person opens it, not when it loads open. */
function focusWhenShown(
  editor: React.RefObject<HTMLDivElement | null>,
  shown: React.RefObject<boolean>,
  hidden: boolean,
): void {
  const opened = !hidden && !shown.current;
  shown.current = !hidden;
  if (!opened) return;
  const element = editor.current;
  if (element === null) return;
  element.focus();
  const selection = window.getSelection();
  if (selection === null) return;
  selection.selectAllChildren(element);
  selection.collapseToEnd();
}

function focusLinkInput(
  input: React.RefObject<HTMLInputElement | null>,
  open: boolean,
): void {
  if (open) input.current?.focus();
}
