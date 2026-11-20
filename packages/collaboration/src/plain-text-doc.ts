import * as Y from "yjs";
import {
  hasValidPlainTextShape,
  normalizePlainText,
  splicePlainText,
  type TextInputRange,
} from "./plain-text.ts";
import {
  defineSharedDoc,
  sharedDocFailure,
  sharedDocSuccess,
  type SharedDocEncoding,
  type SharedDocResult,
} from "./shared-doc.ts";
import {
  RelativeTextSelection,
  captureTextPresenceSelection,
  resolveTextPresenceSelection,
  type TextPresenceSelection,
  type TextSelectionDirection,
  type TextSelectionRange,
} from "./text-selection.ts";
import type { YjsEncodingFailure, YjsEncodingLimits } from "./yjs-encoding.ts";

/**
 * A shared document of one plain text, such as a product description or a
 * mail reply (Refactor 17, step A2.6). The root name is also the name of the
 * text in a change.
 */

/** What a listener gets: the text after a change, and the update of a local one. */
export type PlainTextChange<Root extends string, Update> = Readonly<
  Record<Root, string>
> &
  (
    | Readonly<{ origin: "local"; update: Update }>
    | Readonly<{ origin: "remote"; update?: never }>
  );

export type PlainTextDocError<TooLong extends string> = Readonly<{
  code: YjsEncodingFailure["code"] | "invalid_document_shape" | TooLong;
}>;

type PlainTextDocSpec<
  Schema extends string,
  Root extends string,
  TooLong extends string,
> = Readonly<{
  schema: Schema;
  /** The name of the one text root. */
  root: Root;
  limits: YjsEncodingLimits;
  /** The most UTF-16 code units of the text. */
  textLimit: number;
  /** The failure of a text over the limit. */
  tooLongFailure: TooLong;
}>;

/**
 * True when each struct of a state or an update is plain text in one of the
 * roots: no format, no embed, no map entry and no nested type.
 */
export function hasOnlyPlainTextStructs(
  bytes: Uint8Array,
  roots: readonly string[],
): boolean {
  try {
    for (const struct of Y.decodeUpdate(bytes).structs) {
      if (!(struct instanceof Y.Item)) continue;
      if (
        (typeof struct.parent === "string" && !roots.includes(struct.parent)) ||
        struct.parentSub !== null ||
        !(
          struct.content instanceof Y.ContentString ||
          struct.content instanceof Y.ContentDeleted
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function definePlainTextDoc<
  const Schema extends string,
  const Root extends string,
  const TooLong extends string,
>(spec: PlainTextDocSpec<Schema, Root, TooLong>) {
  type Own = "invalid_document_shape" | TooLong;
  type Result<T> = SharedDocResult<T, PlainTextDocError<TooLong>["code"]>;
  type State = SharedDocEncoding<"state", Schema>;
  type Update = SharedDocEncoding<"update", Schema>;
  type Change = PlainTextChange<Root, Update>;
  const { root } = spec;

  const definition = defineSharedDoc<Schema, Own>({
    schema: spec.schema,
    limits: spec.limits,
    failures: ["invalid_document_shape", spec.tooLongFailure],
    roots: { [root]: "text" },
    shapeFailure: "invalid_document_shape",
    validateEncoded: (bytes) =>
      hasOnlyPlainTextStructs(bytes, [root]) ? null : "invalid_document_shape",
    validate: validateDocument,
  });

  function validateText(value: string): Result<null> {
    if (value.length > spec.textLimit)
      return sharedDocFailure(spec.tooLongFailure);
    if (!hasValidPlainTextShape(value))
      return sharedDocFailure("invalid_document_shape");
    return sharedDocSuccess(null);
  }

  function validateDocument(doc: Y.Doc): Result<null> {
    const text = doc.getText(root);
    if (Object.keys(text.getAttributes()).length !== 0)
      return sharedDocFailure("invalid_document_shape");
    for (const part of text.toDelta()) {
      if (
        typeof part.insert !== "string" ||
        (part.attributes && Object.keys(part.attributes).length !== 0)
      )
        return sharedDocFailure("invalid_document_shape");
    }
    const validText = validateText(text.toString());
    if (!validText.ok) return validText;
    if (Y.encodeStateVector(doc).byteLength > spec.limits.stateVector)
      return sharedDocFailure("state_vector_too_large");
    const state = definition.parseState(Y.encodeStateAsUpdate(doc));
    return state.ok ? sharedDocSuccess(null) : state;
  }

  /** The text under the name of the root, as a change carries it. */
  function named(text: string): Record<Root, string> {
    return { [root]: text } as Record<Root, string>;
  }

  class PlainTextDoc extends definition.Doc {
    readonly #listeners = new Set<(change: Change) => void>();

    static create(initialText: string): Result<PlainTextDoc> {
      const text = normalizePlainText(initialText);
      const valid = validateText(text);
      if (!valid.ok) return valid;
      const doc = definition.emptyDocument();
      doc.getText(root).insert(0, text);
      return sharedDocSuccess(new PlainTextDoc(doc));
    }

    static restore(state: State): Result<PlainTextDoc> {
      const doc = definition.restore(state);
      return doc.ok ? sharedDocSuccess(new PlainTextDoc(doc.value)) : doc;
    }

    read(): string {
      return this.doc.getText(root).toString();
    }

    override apply(update: Update): Result<null> {
      const applied = super.apply(update);
      if (applied.ok) this.#notify({ origin: "remote", ...named(this.read()) });
      return applied;
    }

    edit(nextValue: string, inputRange?: TextInputRange): Result<Update> {
      const next = normalizePlainText(nextValue);
      const validText = validateText(next);
      if (!validText.ok) return validText;
      const staged = this.stage((candidate) =>
        candidate.transact(
          splicePlainText.bind(
            null,
            candidate.getText(root),
            this.read(),
            next,
            inputRange,
          ),
        ),
      );
      if (staged.ok)
        this.#notify({ origin: "local", ...named(next), update: staged.value });
      return staged;
    }

    captureSelection(
      start: number,
      end: number,
      direction: TextSelectionDirection,
    ): RelativeTextSelection {
      return RelativeTextSelection.capture(
        this.doc.getText(root),
        start,
        end,
        direction,
      );
    }

    resolveSelection(selection: RelativeTextSelection): TextSelectionRange {
      return selection.resolve(this.doc);
    }

    capturePresenceSelection(
      start: number,
      end: number,
      direction: TextSelectionDirection,
    ): TextPresenceSelection {
      return captureTextPresenceSelection(
        this.doc.getText(root),
        start,
        end,
        direction,
      );
    }

    resolvePresenceSelection(
      selection: TextPresenceSelection,
    ): TextSelectionRange | null {
      return resolveTextPresenceSelection(
        this.doc,
        this.doc.getText(root),
        selection,
      );
    }

    subscribe(listener: (change: Change) => void): void {
      this.#listeners.add(listener);
    }

    unsubscribe(listener: (change: Change) => void): void {
      this.#listeners.delete(listener);
    }

    override destroy(): void {
      this.#listeners.clear();
      super.destroy();
    }

    #notify(change: Change): void {
      for (const listener of this.#listeners) listener(change);
    }
  }

  return { ...definition, Doc: PlainTextDoc };
}
