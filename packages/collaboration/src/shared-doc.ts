import * as Y from "yjs";
import {
  createSyncProtocol,
  type SyncBaseExtension,
  type SyncDocumentRevision,
  type SyncProtocolSpec,
  type SyncServerExtension,
} from "./sync-protocol.ts";
import {
  YJS_ENCODING_FAILURE_CODES,
  parseYjsEncoding,
  type ParsedYjsEncoding,
  type YjsEncodingFailure,
  type YjsEncodingKind,
  type YjsEncodingLimits,
} from "./yjs-encoding.ts";

/**
 * The skeleton of one shared document (Refactor 17, step A2.6). A document
 * package gives its schema name, its limits, its roots and its shape check.
 * It gets the checked encodings, the base of its document class and its sync
 * protocol. The package keeps its content: the reads and the operations.
 *
 * The bytes do not depend on this file: an encoding holds the Yjs bytes as
 * they arrived, and a document writes what Yjs encodes.
 */

type EncodingCode = YjsEncodingFailure["code"];

/**
 * The result of a document call. Each package names it with its own codes,
 * for example `MenuDraftCrdtResult<T>`. The two branches are plain object
 * types, so that a generic function over a package's result type infers `T`
 * from the success branch only.
 */
export type SharedDocResult<T, Code extends string> =
  | { readonly ok: true; readonly value: T; readonly error?: never }
  | {
      readonly ok: false;
      readonly error: { readonly code: Code };
      readonly value?: never;
    };

/** The failure of a document: an encoding failure or one of its own codes. */
export type SharedDocError<Own extends string> = Readonly<{
  code: EncodingCode | Own;
}>;

export function sharedDocSuccess<T>(value: T): SharedDocResult<T, never> {
  return { ok: true, value };
}

export function sharedDocFailure<Code extends string>(
  code: Code,
): SharedDocResult<never, Code> {
  return { ok: false, error: { code } };
}

/**
 * A state, an update or a state vector that passed the checks of one schema.
 * Private bytes prevent callers from mutating a parsed value after validation.
 * Only this file makes one, so a value of this type is a checked value.
 */
class Encoding<K extends YjsEncodingKind, Schema extends string> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;
  /** In the type only: an encoding of one schema is not one of another. */
  declare readonly schema?: Schema;

  constructor(encoding: ParsedYjsEncoding<K>) {
    this.#encoding = encoding;
    this.kind = encoding.kind;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }
}

export type SharedDocEncoding<
  K extends YjsEncodingKind,
  Schema extends string,
> = Encoding<K, Schema>;

type SharedEncodingSpec<Schema extends string, Own extends string> = Readonly<{
  /** The schema name. It marks the type of each encoding of the document. */
  schema: Schema;
  limits: YjsEncodingLimits;
  /** Each code of the document's own failures. */
  failures: readonly Own[];
  /**
   * The check of the structs of a state or an update, after the Yjs check.
   * A code refuses the bytes.
   */
  validateEncoded?: (bytes: Uint8Array) => NoInfer<Own> | null;
}>;

/** What a package gives for its sync protocol; the document gives the rest. */
type SharedSyncProtocolSpec<
  Selection,
  Schema extends string,
  Code extends string,
  Room extends string,
  Extension extends SyncServerExtension,
> = Omit<
  SyncProtocolSpec<
    Selection,
    Encoding<"state_vector", Schema>,
    Encoding<"update", Schema>,
    Code | Room,
    Extension
  >,
  "parseStateVector" | "parseUpdate" | "documentFailureCodes"
> &
  Readonly<{
    /** Failures that the room of this document adds to the failure frame. */
    roomFailureCodes?: readonly Room[];
  }>;

/**
 * The checked encodings of one schema and its sync protocol, for a package
 * with its own document class.
 */
export function defineSharedEncoding<
  const Schema extends string,
  const Own extends string,
>(spec: SharedEncodingSpec<Schema, Own>) {
  type Code = EncodingCode | Own;
  type Result<T> = SharedDocResult<T, Code>;
  const failureCodes: readonly Code[] = [
    ...YJS_ENCODING_FAILURE_CODES,
    ...spec.failures,
  ];

  function parse<K extends YjsEncodingKind>(
    kind: K,
    bytes: Uint8Array,
  ): Result<Encoding<K, Schema>> {
    const parsed = parseYjsEncoding(kind, bytes, spec.limits);
    if (!parsed.ok) return parsed;
    if (kind !== "state_vector" && spec.validateEncoded !== undefined) {
      const refused = spec.validateEncoded(parsed.value.encode());
      if (refused !== null) return sharedDocFailure(refused);
    }
    return sharedDocSuccess(new Encoding<K, Schema>(parsed.value));
  }

  function parseState(bytes: Uint8Array): Result<Encoding<"state", Schema>> {
    return parse("state", bytes);
  }

  function parseUpdate(bytes: Uint8Array): Result<Encoding<"update", Schema>> {
    return parse("update", bytes);
  }

  function parseStateVector(
    bytes: Uint8Array,
  ): Result<Encoding<"state_vector", Schema>> {
    return parse("state_vector", bytes);
  }

  /**
   * The sync protocol of the document's room. The failure frame takes each
   * code of the document, so a new document failure cannot be dropped from it.
   */
  function syncProtocol<
    Selection,
    Metadata extends Readonly<Record<string, unknown>> = SyncDocumentRevision,
    Room extends string = never,
    Extension extends SyncServerExtension = SyncBaseExtension,
  >(
    protocol: SharedSyncProtocolSpec<Selection, Schema, Code, Room, Extension>,
  ) {
    const { roomFailureCodes = [], ...rest } = protocol;
    return createSyncProtocol<
      Selection,
      Encoding<"state_vector", Schema>,
      Encoding<"update", Schema>,
      Code | Room,
      Metadata,
      Extension
    >({
      ...rest,
      parseStateVector,
      parseUpdate,
      documentFailureCodes: [...failureCodes, ...roomFailureCodes],
    });
  }

  return {
    schema: spec.schema,
    limits: spec.limits,
    /** `encoding.parse(kind, bytes)`, for a package that exports one parser. */
    encoding: { parse },
    parseState,
    parseUpdate,
    parseStateVector,
    syncProtocol,
  };
}

/** The type of each root of a document, by its name. */
type SharedDocRoots = Readonly<Record<string, "map" | "text">>;

type SharedDocSpec<
  Schema extends string,
  Own extends string,
> = SharedEncodingSpec<Schema, Own> &
  Readonly<{
    /**
     * The roots. Every document defines them before an update arrives, so
     * that Yjs reads their entries with the right type.
     */
    roots: SharedDocRoots;
    /** The failure of a document that holds another root. */
    shapeFailure: NoInfer<Own>;
    /** The check of the content, after the check of the roots. */
    validate: (
      doc: Y.Doc,
    ) => SharedDocResult<null, EncodingCode | NoInfer<Own>>;
    /** The failure of `mutate` when the operation made no Yjs update. */
    unchangedFailure?: NoInfer<Own>;
  }>;

/**
 * The checked encodings, the sync protocol and the base class of one shared
 * document. Every edit and every received update is applied to a copy first,
 * and the copy must pass the checks before it replaces the document.
 */
export function defineSharedDoc<
  const Schema extends string,
  const Own extends string,
>(spec: SharedDocSpec<Schema, Own>) {
  type Code = EncodingCode | Own;
  type Result<T> = SharedDocResult<T, Code>;
  type State = Encoding<"state", Schema>;
  type Update = Encoding<"update", Schema>;
  type StateVector = Encoding<"state_vector", Schema>;

  const encoding = defineSharedEncoding<Schema, Own>(spec);
  const { parseState, parseUpdate, parseStateVector } = encoding;
  const roots = Object.entries(spec.roots);

  function emptyDocument(): Y.Doc {
    const doc = new Y.Doc();
    for (const [name, type] of roots) {
      if (type === "map") doc.getMap(name);
      else doc.getText(name);
    }
    return doc;
  }

  function copyDocument(source: Y.Doc): Y.Doc {
    const candidate = emptyDocument();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
    // Keep this replica's identity while staging an edit; reject by discarding the clone.
    candidate.clientID = source.clientID;
    return candidate;
  }

  function validate(doc: Y.Doc): Result<null> {
    if (doc.share.size !== roots.length)
      return sharedDocFailure(spec.shapeFailure);
    for (const [name, type] of roots) {
      const root = doc.share.get(name);
      if (!(type === "map" ? root instanceof Y.Map : root instanceof Y.Text))
        return sharedDocFailure(spec.shapeFailure);
    }
    return spec.validate(doc);
  }

  /** The Yjs document of a stored state, for the `restore` of a package. */
  function restore(state: State): Result<Y.Doc> {
    const doc = emptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validate(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return sharedDocSuccess(doc);
    } catch {
      doc.destroy();
      return sharedDocFailure("invalid_state");
    }
  }

  abstract class Doc {
    #doc: Y.Doc;

    protected constructor(doc: Y.Doc) {
      this.#doc = doc;
    }

    /** The Yjs document, for the reads of the package. */
    protected get doc(): Y.Doc {
      return this.#doc;
    }

    state(): Result<State> {
      return parseState(Y.encodeStateAsUpdate(this.#doc));
    }

    stateVector(): Result<StateVector> {
      return parseStateVector(Y.encodeStateVector(this.#doc));
    }

    syncUpdate(remoteStateVector: StateVector): Result<Update> {
      try {
        return parseUpdate(
          Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()),
        );
      } catch {
        return sharedDocFailure("invalid_state_vector");
      }
    }

    apply(update: Update): Result<null> {
      const candidate = copyDocument(this.#doc);
      try {
        Y.applyUpdate(candidate, update.encode());
        const valid = validate(candidate);
        if (!valid.ok) {
          candidate.destroy();
          return valid;
        }
      } catch {
        candidate.destroy();
        return sharedDocFailure("invalid_update");
      }
      this.#replace(candidate);
      return sharedDocSuccess(null);
    }

    destroy(): void {
      this.#doc.destroy();
    }

    /**
     * Runs an operation on a copy and gives the Yjs updates that it made,
     * merged into one. An operation that makes no update fails with the
     * `unchangedFailure` of the document.
     */
    protected mutate(operation: (doc: Y.Doc) => Result<null>): Result<Update> {
      const { candidate, updates, changed } = this.#run(operation);
      if (!changed.ok) {
        candidate.destroy();
        return changed;
      }
      const valid = validate(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
      if (updates.length === 0) {
        candidate.destroy();
        if (spec.unchangedFailure === undefined)
          throw new Error(`${spec.schema} defines no unchangedFailure`);
        return sharedDocFailure(spec.unchangedFailure);
      }
      return this.#accept(candidate, updates);
    }

    /**
     * As `mutate`, for an operation that says if it changed the document.
     * The result is null when it changed nothing.
     */
    protected mutateIfChanged(
      operation: (doc: Y.Doc) => Result<boolean>,
    ): Result<Update | null> {
      const { candidate, updates, changed } = this.#run(operation);
      if (!changed.ok) {
        candidate.destroy();
        return changed;
      }
      if (!changed.value || updates.length === 0) {
        candidate.destroy();
        return sharedDocSuccess(null);
      }
      const valid = validate(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
      return this.#accept(candidate, updates);
    }

    /**
     * Runs a change on a copy and gives the difference between the copy and
     * the document as one update.
     */
    protected stage(change: (candidate: Y.Doc) => void): Result<Update> {
      const candidate = copyDocument(this.#doc);
      let update: Update;
      try {
        change(candidate);
        const valid = validate(candidate);
        if (!valid.ok) {
          candidate.destroy();
          return valid;
        }
        const encoded = parseUpdate(
          Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.#doc)),
        );
        if (!encoded.ok) {
          candidate.destroy();
          return encoded;
        }
        update = encoded.value;
      } catch {
        candidate.destroy();
        return sharedDocFailure("invalid_update");
      }
      this.#replace(candidate);
      return sharedDocSuccess(update);
    }

    #run<T>(operation: (doc: Y.Doc) => Result<T>) {
      const candidate = copyDocument(this.#doc);
      const updates: Uint8Array[] = [];
      const capture = (update: Uint8Array): void => {
        updates.push(update);
      };
      candidate.on("update", capture);
      try {
        return { candidate, updates, changed: operation(candidate) };
      } finally {
        candidate.off("update", capture);
      }
    }

    #accept(candidate: Y.Doc, updates: Uint8Array[]): Result<Update> {
      const update = parseUpdate(Y.mergeUpdates(updates));
      if (!update.ok) {
        candidate.destroy();
        return update;
      }
      this.#replace(candidate);
      return update;
    }

    #replace(candidate: Y.Doc): void {
      this.#doc.destroy();
      this.#doc = candidate;
    }
  }

  return { ...encoding, emptyDocument, restore, Doc };
}

/** The size check at the end of a document's shape check. */
export function checkDocumentSize(
  doc: Y.Doc,
  limits: YjsEncodingLimits,
): SharedDocResult<null, "state_too_large" | "state_vector_too_large"> {
  if (Y.encodeStateAsUpdate(doc).byteLength > limits.state)
    return sharedDocFailure("state_too_large");
  if (Y.encodeStateVector(doc).byteLength > limits.stateVector)
    return sharedDocFailure("state_vector_too_large");
  return sharedDocSuccess(null);
}
