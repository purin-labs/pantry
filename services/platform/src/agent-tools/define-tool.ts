import { Type, type Static, type TSchema } from "typebox";
import type { BakerySurfaceToolCommandName } from "@seams/bakery-model/bakery-surface";
import type {
  COSTS_SURFACE,
  CostsViewCommandName,
  KITCHEN_SURFACE,
  PastryBenchViewCommandName,
  REGISTER_SURFACE,
  RegisterViewCommandName,
} from "@seams/control-api";
import { Value } from "typebox/value";
import type {
  CatalogExecutionContext,
  CatalogToolAuthority,
} from "./catalog/execute";
import type {
  HarnessCapabilityName,
  HarnessToolDefinition,
} from "./catalog/types";
import { isRecord } from "@seams/std";

/**
 * A tool argument that the agent can correct: the message names the field and
 * reaches the model as the tool's failure text.
 */
export class ProposalArgumentError extends Error {}

/**
 * What a successful call proves.
 *
 * - `read`: the call changed nothing.
 * - `receipt`: the call changed something, and its value names the receipt
 *   (`receiptId`) of that change.
 * - `proposal`: the call staged a proposal, and a person confirms the change.
 *   The catalog treats it as a read.
 * - `draft`: the call changed a shared draft that people edit in its room;
 *   the room keeps the history. The catalog treats it as a read.
 * - `scheduled`: the call scheduled a later turn for the same person, whose
 *   authority is checked again then. The catalog treats it as a read.
 * - `surface`: the call sent a command to the attached Kitchen surface,
 *   and its value names the surface receipt and the command's outcome.
 */
export type ToolEffect =
  "read" | "receipt" | "proposal" | "draft" | "scheduled" | "surface";

/**
 * Who may run a call again after a lost process left it in flight. The same
 * three values as `ToolRerun` in `actors/pi-tool-replay.ts`.
 */
export type ToolRerun =
  | { readonly kind: "any_caller"; readonly reason: string }
  | { readonly kind: "script"; readonly reason: string }
  | { readonly kind: "none" };

/** A tool that the turn offers by its origin, not by a capability grant. */
type TurnToolFlag = "memoryProposal" | "followUp" | "sideCaseProposal";

/**
 * When a turn offers the tool.
 *
 * - `capability`: when the turn holds the capability. The call claims it.
 * - `turn`: when the turn sets the flag, for example a Portal chat turn for
 *   the Memory proposal. The call claims no capability: its handler checks
 *   the turn's authority again.
 * - `surface`: when the attached Kitchen surface installs the command.
 *   The call claims no capability, as the catalog did before Refactor 10.
 */
export type ToolSelection =
  | {
      readonly kind: "capability";
      readonly capability: HarnessCapabilityName;
    }
  | { readonly kind: "turn"; readonly flag: TurnToolFlag }
  | {
      readonly kind: "surface";
      /** The page whose observation lists the command (Plan 87 phase 3/4). */
      readonly surface: typeof KITCHEN_SURFACE;
      readonly command:
        | BakerySurfaceToolCommandName
        | PastryBenchViewCommandName;
    }
  | {
      readonly kind: "surface";
      /** A Portal page with view commands (Plan 87 phase 4). */
      readonly surface: typeof COSTS_SURFACE;
      readonly command: CostsViewCommandName;
    }
  | {
      readonly kind: "surface";
      /** Café › Register basket staging commands (Plan 90). */
      readonly surface: typeof REGISTER_SURFACE;
      readonly command: RegisterViewCommandName;
    };

/** A command that a surface tool sends: a Kitchen, Pastry Bench, Costs or Register command. */
export type SurfaceToolCommandName =
  | BakerySurfaceToolCommandName
  | CostsViewCommandName
  | PastryBenchViewCommandName
  | RegisterViewCommandName;

/** The identity of one call, for receipts and idempotent writes. */
type ToolCall = {
  readonly callId: string;
  /** Direct call or Code Mode, as the catalog runs it. */
  readonly execution: CatalogExecutionContext;
  /** Names the call across retries, as `logicalToolOperationId` does. */
  readonly operationId: string;
};

type ToolHandler<Request> = (
  request: Request,
  call: ToolCall,
) => Promise<unknown>;

/** The source of one tool: everything that the catalog knows about it. */
type ToolSpec<Name extends string, Input extends TSchema, Request> = {
  readonly name: Name;
  readonly description: string;
  /** The JSON schema that the model sees, and the structural check of a call. */
  readonly input: Input;
  /**
   * The checks that a schema cannot state, and the request that the handler
   * takes. Throw `ProposalArgumentError` for a message that the agent reads.
   */
  readonly decode: (input: Static<Input>) => Request;
  /**
   * Decode is the only check of a call. Give it for a decode that is a full
   * parser with its own messages for the agent. The schema is then only what
   * the model sees: strict mode makes the model send each field, and a Code
   * Mode script may leave out the fields that the parser lets it omit.
   */
  readonly decodeOnly?: true;
  readonly effect: ToolEffect;
  readonly rerun: ToolRerun;
  readonly selection: ToolSelection;
  /**
   * Only the model may call the tool, never a Code Mode script: the call
   * belongs to the turn's message, chat or thread.
   */
  readonly directOnly?: true;
  /** The failure when the turn has no handler, for example outside a shop. */
  readonly unavailable: string;
  readonly handler: (
    authority: CatalogToolAuthority,
  ) => ToolHandler<Request> | undefined;
  /**
   * For a receipt tool: the receipt id in the handler's value. Default:
   * the value's `receiptId`.
   */
  readonly readReceipt?: (value: unknown) => string;
  /**
   * The failure text when the handler fails with no message for the agent,
   * for a tool whose change may have happened all the same.
   */
  readonly unconfirmedFailure?: string;
  /**
   * The model definition lists `strict` before `description`, as the catalog
   * did. It keeps the catalog digest of turns in flight; drop it in a release
   * that may change the digest.
   */
  readonly strictFirst?: true;
};

/** A tool in the registry. `defineTool` keeps its input and request types. */
export type RegisteredTool<Name extends string = string> = {
  readonly name: Name;
  readonly description: string;
  readonly input: TSchema;
  readonly effect: ToolEffect;
  readonly rerun: ToolRerun;
  readonly selection: ToolSelection;
  readonly directOnly: boolean;
  readonly unavailable: string;
  /** Checks the schema, then decodes. Throws before any capability claim. */
  readonly parse: (input: unknown) => unknown;
  readonly handler: (
    authority: CatalogToolAuthority,
  ) => ToolHandler<unknown> | undefined;
  readonly readReceipt: (value: unknown) => string;
  readonly unconfirmedFailure?: string;
  readonly strictFirst: boolean;
};

export function defineTool<
  const Name extends string,
  Input extends TSchema,
  Request,
>(spec: ToolSpec<Name, Input, Request>): RegisteredTool<Name> {
  const parse = (input: unknown): Request => {
    // The schema of a decode-only tool is a JSON schema: decode takes unknown.
    if (spec.decodeOnly === true) {
      return spec.decode(input as Static<Input>);
    }
    if (!Value.Check(spec.input, input)) {
      throw new TypeError(`${spec.name} arguments are invalid`);
    }
    return spec.decode(input);
  };
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    effect: spec.effect,
    rerun: spec.rerun,
    selection: spec.selection,
    directOnly: spec.directOnly === true,
    unavailable: spec.unavailable,
    parse,
    // The registry calls a handler only with the request that this tool's own
    // parse returned, so the erased request type is safe here.
    handler: spec.handler as RegisteredTool<Name>["handler"],
    readReceipt: spec.readReceipt ?? readReceiptId,
    ...(spec.unconfirmedFailure === undefined
      ? {}
      : { unconfirmedFailure: spec.unconfirmedFailure }),
    strictFirst: spec.strictFirst === true,
  };
}

/**
 * A schema written as JSON, as the model sees it. The schema check runs on it
 * like on any TypeBox schema; decode gives the request its type.
 */
export function jsonSchema(schema: Readonly<Record<string, unknown>>) {
  return Type.Unsafe<unknown>(schema);
}

function readReceiptId(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { receiptId?: unknown }).receiptId !== "string"
  ) {
    throw new Error("Order queue receipt missing");
  }
  return (value as { receiptId: string }).receiptId;
}

/** A string enum in the JSON shape `{ type: "string", enum: [...] }`. */
export function stringEnum<const Values extends readonly string[]>(
  values: Values,
) {
  return Type.Unsafe<Values[number]>({ type: "string", enum: values });
}

/** An object with no properties, in the shape that strict mode needs. */
export function noArguments() {
  return Type.Object({}, { additionalProperties: false });
}

/**
 * The definition that the model sees. The key order is fixed, because the
 * session pins the SHA-256 of these definitions (`toolCatalogDigest`).
 */
export function modelToolDefinition<Name extends string>(
  tool: RegisteredTool<Name>,
): HarnessToolDefinition & { readonly name: Name } {
  const parameters = modelSchema(
    tool.input,
  ) as HarnessToolDefinition["parameters"];
  return tool.strictFirst
    ? {
        type: "function",
        name: tool.name,
        strict: true,
        description: tool.description,
        parameters,
      }
    : {
        type: "function",
        name: tool.name,
        description: tool.description,
        strict: true,
        parameters,
      };
}

const LEADING_KEYS = ["type", "properties", "required"] as const;
const TRAILING_KEYS = ["additionalProperties"] as const;

/**
 * A plain JSON copy of a schema: `type`, `properties` and `required` first,
 * `additionalProperties` last, the other keys in their own order. An object
 * schema always names `required`, as strict mode needs.
 */
function modelSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(modelSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const source = schema as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  for (const key of LEADING_KEYS) {
    if (key === "properties" && isRecord(source[key])) {
      copy[key] = Object.fromEntries(
        Object.entries(source[key]).map(([name, value]) => [
          name,
          modelSchema(value),
        ]),
      );
    } else if (key in source) {
      copy[key] = modelSchema(source[key]);
    } else if (key === "required" && source.type === "object") {
      copy[key] = [];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      !(LEADING_KEYS as readonly string[]).includes(key) &&
      !(TRAILING_KEYS as readonly string[]).includes(key)
    ) {
      copy[key] = modelSchema(value);
    }
  }
  for (const key of TRAILING_KEYS) {
    if (key in source) {
      copy[key] = modelSchema(source[key]);
    }
  }
  return copy;
}

