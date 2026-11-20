import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AuthorizedHarnessToolResult } from "@purin-labs/contracts";
import type { CatalogExecutionContext } from "./catalog/execute";
import type {
  HarnessCapabilityName,
  HarnessToolDefinition,
} from "./catalog/types";
import { isRecord } from "@purin-labs/std";
import type { PreparedEffect } from "./tool-effect";

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
 * - `surface`: when the attached page installs the command. The surface and
 *   the command are names that the tool's own area checks. The call claims no
 *   capability, as the catalog did before Refactor 10.
 * - `host`: when the turn runs in the named host. No other host offers it.
 */
export type ToolSelection =
  | {
      readonly kind: "capability";
      readonly capability: HarnessCapabilityName;
    }
  | { readonly kind: "turn"; readonly flag: TurnToolFlag }
  | {
      readonly kind: "surface";
      /** The page whose observation lists the command (Plan 87). */
      readonly surface: string;
      readonly command: string;
    }
  | {
      /**
       * Only the named tool host offers the tool, in the host's own registry:
       * the mailbox agent or the WhatsApp agent. The call claims no
       * capability: the host's turn holds the whole authority of its tools.
       */
      readonly kind: "host";
      readonly host: string;
    };

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

/**
 * The first part of an effect tool: the live checks and the reads. It
 * returns the effect with its exit checks. The executor's host runs them.
 */
type ToolPrepare<Request> = (
  request: Request,
  call: ToolCall,
) => Promise<PreparedEffect>;

/**
 * The result of a tool that keeps its own envelope in the accepted history.
 * The executor uses it for each result of the tool, also for a call that the
 * catalog refuses before the handler runs.
 */
export type ToolResultEnvelope = {
  readonly success: (value: unknown) => Promise<AuthorizedHarnessToolResult>;
  readonly failure: (detail: string) => Promise<AuthorizedHarnessToolResult>;
};

/** The source of one tool: everything that the catalog knows about it. */
type ToolSpec<Name extends string, Input extends TSchema, Request, Services> = {
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
  /**
   * The handler of one turn, from the services that the turn gives to the
   * tool's family. A host may give only a part of them.
   */
  readonly handler?: (
    services: Partial<Services>,
  ) => ToolHandler<Request> | undefined;
  /**
   * For a `draft`, `receipt` or `scheduled` tool, in place of `handler`: the
   * live checks and the reads of one call. The host of the executor reads the
   * label, runs the exit checks that `prepare` returns and calls `run`.
   */
  readonly prepare?: (
    services: Partial<Services>,
  ) => ToolPrepare<Request> | undefined;
  /**
   * For a receipt tool or a surface tool: the receipt id in the handler's
   * value. Default: the value's `receiptId`.
   */
  readonly readReceipt?: (value: unknown) => string;
  /**
   * For a surface tool: true when the page completed the command. The
   * receipt of a command that the page refused has the status `failed`.
   */
  readonly succeeded?: (value: unknown) => boolean;
  /** For a tool that keeps its own result envelope. */
  readonly result?: ToolResultEnvelope;
  /**
   * The failure text when the handler fails with no message for the agent,
   * for a tool whose change may have happened all the same.
   */
  readonly unconfirmedFailure?: string;
  /**
   * A note that the model definition adds after the description, for
   * example how to call the tools of one page.
   */
  readonly guidance?: string;
  /**
   * The parameters exactly as the model sees them, for a definition whose
   * pinned bytes are not the copy that `modelSchema` makes of `input`.
   */
  readonly parameters?: HarnessToolDefinition["parameters"];
  /**
   * The model definition lists `strict` before `description`, as the catalog
   * did. It keeps the catalog digest of turns in flight; drop it in a release
   * that may change the digest.
   */
  readonly strictFirst?: true | "before_type";
};

/**
 * A tool in the registry. `Family` names the services that its handler
 * takes, and `Services` is their type. The executor holds each tool as
 * `AnyRegisteredTool` and gives it the services of its family.
 */
export type RegisteredTool<
  Name extends string = string,
  Family extends string = string,
  Services = never,
> = {
  readonly name: Name;
  readonly family: Family;
  readonly description: string;
  readonly input: TSchema;
  readonly effect: ToolEffect;
  readonly rerun: ToolRerun;
  readonly selection: ToolSelection;
  readonly directOnly: boolean;
  readonly unavailable: string;
  /** Checks the schema, then decodes. Throws before any capability claim. */
  readonly parse: (input: unknown) => unknown;
  readonly handler: (services: Services) => ToolHandler<unknown> | undefined;
  readonly prepare?: (services: Services) => ToolPrepare<unknown> | undefined;
  readonly readReceipt: (value: unknown) => string;
  readonly succeeded?: (value: unknown) => boolean;
  readonly result?: ToolResultEnvelope;
  readonly unconfirmedFailure?: string;
  readonly guidance?: string;
  readonly parameters?: HarnessToolDefinition["parameters"];
  readonly strictFirst: boolean | "before_type";
};

/** A tool of any family, as the registry and the executor hold it. */
export type AnyRegisteredTool = RegisteredTool<string, string, never>;

/**
 * Returns `defineTool` for one family of tools. A family is the set of tools
 * that take the same services, for example the Kitchen tools. The area
 * declares the services type, and the turn's host gives the services under
 * the family's name.
 */
export function defineToolFamily<Services>() {
  return <const Family extends string>(family: Family) =>
    <const Name extends string, Input extends TSchema, Request>(
      spec: ToolSpec<Name, Input, Request, Services>,
    ): RegisteredTool<Name, Family, Services> => {
      if ((spec.handler === undefined) === (spec.prepare === undefined)) {
        throw new Error(
          `${spec.name} needs a handler or prepare, and not both`,
        );
      }
      if (
        (spec.effect === "draft" ||
          spec.effect === "receipt" ||
          spec.effect === "scheduled") &&
        spec.prepare === undefined
      ) {
        throw new Error(`${spec.name} has an effect, so it needs prepare`);
      }
      if (spec.effect === "surface" && spec.succeeded === undefined) {
        throw new Error(
          `${spec.name} is a surface tool with no outcome reader`,
        );
      }
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
        family,
        description: spec.description,
        input: spec.input,
        effect: spec.effect,
        rerun: spec.rerun,
        selection: spec.selection,
        directOnly: spec.directOnly === true,
        unavailable: spec.unavailable,
        parse,
        // The executor calls a handler only with the request that this tool's
        // own parse returned, so the erased request type is safe here.
        handler: (spec.handler ?? noHandler) as RegisteredTool<
          Name,
          Family,
          Services
        >["handler"],
        ...(spec.prepare === undefined
          ? {}
          : {
              prepare: spec.prepare as NonNullable<
                RegisteredTool<Name, Family, Services>["prepare"]
              >,
            }),
        readReceipt: spec.readReceipt ?? readReceiptId,
        ...(spec.succeeded === undefined ? {} : { succeeded: spec.succeeded }),
        ...(spec.result === undefined ? {} : { result: spec.result }),
        ...(spec.unconfirmedFailure === undefined
          ? {}
          : { unconfirmedFailure: spec.unconfirmedFailure }),
        ...(spec.guidance === undefined ? {} : { guidance: spec.guidance }),
        ...(spec.parameters === undefined
          ? {}
          : { parameters: spec.parameters }),
        strictFirst: spec.strictFirst ?? false,
      };
    };
}

/**
 * A schema written as JSON, as the model sees it. The schema check runs on it
 * like on any TypeBox schema; decode gives the request its type.
 */
export function jsonSchema(schema: Readonly<Record<string, unknown>>) {
  return Type.Unsafe<unknown>(schema);
}

function noHandler(): undefined {
  return undefined;
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
  tool: RegisteredTool<Name, string, never>,
): HarnessToolDefinition & { readonly name: Name } {
  const parameters =
    tool.parameters ??
    (modelSchema(tool.input) as HarnessToolDefinition["parameters"]);
  const description =
    tool.guidance === undefined
      ? tool.description
      : `${tool.description} ${tool.guidance}`;
  if (tool.strictFirst === "before_type") {
    // One mailbox definition was written with `strict` first.
    return {
      strict: true,
      type: "function",
      name: tool.name,
      description,
      parameters,
    };
  }
  return tool.strictFirst
    ? {
        type: "function",
        name: tool.name,
        strict: true,
        description,
        parameters,
      }
    : {
        type: "function",
        name: tool.name,
        description,
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
