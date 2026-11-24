// The governed action that installs a merchant plugin in Commerce (Plan 77
// steps 4 and 5). An agent writes the plugin from a merchant's requirement:
// settings, an optional `checkout.validate` function, event handlers and
// actions with the commands that they may submit, up to eight entity types,
// and fields on products, variants and customers. The action path carries the whole definition, so the approval signs
// exactly the code and the settings that Commerce will run, and the version
// and installation revision that the proposal read.
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";
import type {
  CommercePluginActionV1,
  CommercePluginEntityTypeV1,
  CommercePluginFieldV1,
  CommercePluginHandlerV1,
  CommercePluginSettingsV1,
} from "@purin-labs/commerce-client";

import type { Result } from "@purin-labs/kernel/result";
import type {
  InstallMerchantPluginAction,
  MerchantPluginCommand,
  MerchantPluginSettingKind,
  MerchantPluginSettingProposal,
} from "@purin-labs/area-commerce-contract/server/action-requests";

export const MERCHANT_PLUGIN_INSTALL_VERB = "commerce.plugin.install";

/** The commands that a merchant plugin's handlers and actions may submit. */
const MERCHANT_PLUGIN_COMMANDS = [
  "create_discount",
  "set_plugin_field_values",
  "credit_store_credit",
] as const satisfies readonly MerchantPluginCommand[];

/** What the agent writes; the version and revision come from Commerce. */
export type MerchantPluginDraft = Omit<
  InstallMerchantPluginAction,
  "kind" | "version" | "expectedRevision"
>;

type ParseError = Readonly<{ code: "commerce_action_invalid"; field: string }>;

const SETTING_KINDS: readonly MerchantPluginSettingKind[] = [
  "integer",
  "text",
  "boolean",
  "text_list",
];
const MAX_SETTINGS = 20;
const MAX_PARTS = 10;
const MAX_SOURCE_BYTES = 64 * 1024;
const PART_ID = /^[a-z][a-z0-9_]{0,39}$/u;
const EVENT_KIND = /^[a-z_]+\.(\*|[a-z_]+)$/u;
const ACTION_INPUT_KINDS = ["integer", "text", "boolean", "text_list", "order"];
const FIELD_ENTITY_TYPES = ["product", "sellable_variant", "customer"];
const FIELD_KINDS = ["integer", "text", "boolean", "text_list"];
const ATTRIBUTE_KINDS = [
  "short_text",
  "integer",
  "boolean",
  "date",
  "timestamp",
];
const LIMITS = {
  instructionBudget: 100,
  memoryBytes: 8 * 1024 * 1024,
  outputBytes: 16 * 1024,
} as const;

/** Reads the plugin fields of a proposal; other fields must be null or absent. */
export function parseMerchantPluginDraft(
  raw: Readonly<Record<string, unknown>>,
  own: readonly string[] = [],
): Result<MerchantPluginDraft, ParseError> {
  const fields = [
    "pluginId",
    "title",
    "purpose",
    "settings",
    "functionSource",
    "commands",
    "handlers",
    "actions",
    "entityTypes",
    "fields",
  ];
  for (const [key, value] of Object.entries(raw))
    if (
      !fields.includes(key) &&
      !own.includes(key) &&
      value !== null &&
      value !== undefined
    )
      return invalid(key);
  if (
    typeof raw.pluginId !== "string" ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(raw.pluginId)
  )
    return invalid("pluginId");
  if (!boundedText(raw.title, 80)) return invalid("title");
  if (!boundedText(raw.purpose, 280)) return invalid("purpose");
  const functionSource = raw.functionSource ?? null;
  if (functionSource !== null && !boundedSource(functionSource))
    return invalid("functionSource");
  const commands = raw.commands ?? [];
  if (
    !Array.isArray(commands) ||
    !commands.every((command) =>
      (MERCHANT_PLUGIN_COMMANDS as readonly unknown[]).includes(command),
    ) ||
    new Set(commands).size !== commands.length
  )
    return invalid("commands");
  const handlers = parseHandlers(raw.handlers ?? []);
  if (handlers === null) return invalid("handlers");
  const actions = parseActions(raw.actions ?? []);
  if (actions === null) return invalid("actions");
  const entityTypes = parseEntityTypes(raw.entityTypes ?? []);
  if (entityTypes === null) return invalid("entityTypes");
  const pluginFields = parseFields(raw.fields ?? []);
  if (pluginFields === null) return invalid("fields");
  if (functionSource === null && handlers.length + actions.length === 0)
    return invalid("functionSource");
  if (!Array.isArray(raw.settings) || raw.settings.length > MAX_SETTINGS)
    return invalid("settings");
  const settings: MerchantPluginSettingProposal[] = [];
  const keys = new Set<string>();
  for (const setting of raw.settings) {
    const parsed = parseSetting(setting);
    if (parsed === null || keys.has(parsed.key)) return invalid("settings");
    keys.add(parsed.key);
    settings.push(parsed);
  }
  return {
    ok: true,
    value: {
      pluginId: raw.pluginId,
      title: raw.title,
      purpose: raw.purpose,
      settings,
      functionSource,
      commands: commands as MerchantPluginCommand[],
      handlers,
      actions,
      entityTypes,
      fields: pluginFields,
    },
  };
}

/** Reads a stored or submitted installation request. */
export function parseInstallMerchantPluginRequest(
  raw: Readonly<Record<string, unknown>>,
): Result<InstallMerchantPluginAction, ParseError> {
  if (raw.kind !== "install_merchant_plugin") return invalid("kind");
  const version = raw.version;
  const expectedRevision = raw.expectedRevision;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return invalid("version");
  if (
    expectedRevision !== null &&
    (typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1)
  )
    return invalid("expectedRevision");
  const draft = parseMerchantPluginDraft(raw, [
    "kind",
    "version",
    "expectedRevision",
  ]);
  if (!draft.ok) return draft;
  return {
    ok: true,
    value: {
      kind: "install_merchant_plugin",
      version,
      expectedRevision,
      ...draft.value,
    },
  };
}

export function merchantPluginActionPath(
  action: InstallMerchantPluginAction,
): string {
  const params = new URLSearchParams({
    version: String(action.version),
    expected_revision:
      action.expectedRevision === null
        ? "none"
        : String(action.expectedRevision),
    // A plugin with only a checkout function keeps the earlier path, so
    // an action proposed before handlers existed keeps its signed bytes.
    definition: JSON.stringify({
      title: action.title,
      purpose: action.purpose,
      settings: action.settings,
      functionSource: action.functionSource,
      ...(action.commands.length === 0 ? {} : { commands: action.commands }),
      ...(action.handlers.length === 0 ? {} : { handlers: action.handlers }),
      ...(action.actions.length === 0 ? {} : { actions: action.actions }),
      ...(action.entityTypes.length === 0
        ? {}
        : { entityTypes: action.entityTypes }),
      ...(action.fields.length === 0 ? {} : { fields: action.fields }),
    }),
  });
  return `/merchant-plugins/${encodeURIComponent(action.pluginId)}/installation?${params.toString()}`;
}

/**
 * Reads an installation path back, or returns null when the path is not one.
 * A path that names the installation but does not parse is an error.
 */
export function parseMerchantPluginActionPath(
  verb: string,
  url: URL,
): Result<InstallMerchantPluginAction, ParseError> | null {
  const resource = url.pathname.match(
    /^\/merchant-plugins\/([^/]+)\/installation$/u,
  );
  if (resource === null) return null;
  const keys = Array.from(url.searchParams.keys());
  if (
    verb !== MERCHANT_PLUGIN_INSTALL_VERB ||
    keys.length !== 3 ||
    !["version", "expected_revision", "definition"].every(
      (key) => url.searchParams.getAll(key).length === 1,
    )
  )
    return invalid("path");
  const version = positiveInteger(url.searchParams.get("version"));
  const rawRevision = url.searchParams.get("expected_revision");
  const expectedRevision =
    rawRevision === "none" ? null : positiveInteger(rawRevision);
  if (version === null || (rawRevision !== "none" && expectedRevision === null))
    return invalid("path");
  let pluginId: string;
  let definition: unknown;
  try {
    pluginId = decodeURIComponent(resource[1] ?? "");
    definition = JSON.parse(url.searchParams.get("definition") ?? "");
  } catch {
    return invalid("path");
  }
  if (!isRecord(definition)) return invalid("path");
  const draft = parseMerchantPluginDraft({ ...definition, pluginId });
  if (!draft.ok) return draft;
  return {
    ok: true,
    value: {
      kind: "install_merchant_plugin",
      version,
      expectedRevision,
      ...draft.value,
    },
  };
}

/** The Commerce definition and settings that the approved action installs. */
export function merchantPluginInstallation(
  action: InstallMerchantPluginAction,
): Readonly<{
  definition: PluginDefinition;
  settings: CommercePluginSettingsV1;
}> {
  return {
    definition: {
      pluginId: action.pluginId,
      version: action.version,
      kind: "merchant",
      title: action.title,
      purpose: action.purpose,
      requirements: {
        hookPoints: action.functionSource === null ? [] : ["checkout.validate"],
        reads: [],
        commands: [...action.commands],
        dependsOn: [],
      },
      contributions: {
        routes: [],
        pipelineSteps: [],
        entityTypes: action.entityTypes.map((type) => type.typeId),
        settings: action.settings.map((setting) => ({
          key: setting.key,
          valueKind: setting.valueKind,
          description: setting.description,
        })),
        functions:
          action.functionSource === null
            ? []
            : [
                {
                  functionId: "check_checkout",
                  hookPoint: "checkout.validate",
                  required: false,
                  source: action.functionSource,
                },
              ],
      },
      limits: LIMITS,
    },
    settings: Object.fromEntries(
      action.settings.map((setting) => [setting.key, setting.value]),
    ),
  };
}

/**
 * The handlers, actions, entity types and fields that the installation sends
 * with the definition. Each list replaces the plugin's earlier one; a version
 * with no entity type or no field keeps the ones that the plugin had before.
 */
export function merchantPluginParts(
  action: InstallMerchantPluginAction,
): Readonly<{
  handlers: readonly CommercePluginHandlerV1[];
  actions: readonly CommercePluginActionV1[];
  entityTypes?: readonly CommercePluginEntityTypeV1[];
  fields?: readonly CommercePluginFieldV1[];
}> {
  return {
    handlers: action.handlers,
    actions: action.actions,
    ...(action.entityTypes.length === 0
      ? {}
      : { entityTypes: action.entityTypes }),
    ...(action.fields.length === 0 ? {} : { fields: action.fields }),
  };
}

/**
 * Up to 20 fields, each entity type and key once, or null. A customer field
 * holds an integer or a boolean, so a plugin keeps no free text about a
 * person.
 */
function parseFields(
  value: unknown,
): readonly CommercePluginFieldV1[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const fields: CommercePluginFieldV1[] = [];
  for (const raw of value) {
    if (
      !exactKeys(raw, ["entityType", "key", "valueKind", "description"]) ||
      !FIELD_ENTITY_TYPES.includes(raw.entityType as string) ||
      typeof raw.key !== "string" ||
      !PART_ID.test(raw.key) ||
      !FIELD_KINDS.includes(raw.valueKind as string) ||
      (raw.entityType === "customer" &&
        raw.valueKind !== "integer" &&
        raw.valueKind !== "boolean") ||
      !boundedText(raw.description, 200) ||
      fields.some(
        (field) => field.entityType === raw.entityType && field.key === raw.key,
      )
    )
      return null;
    fields.push({
      entityType: raw.entityType as CommercePluginFieldV1["entityType"],
      key: raw.key,
      valueKind: raw.valueKind as CommercePluginFieldV1["valueKind"],
      description: raw.description,
    });
  }
  return fields;
}

function boundedSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= MAX_SOURCE_BYTES
  );
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

function parseHandlers(value: unknown): CommercePluginHandlerV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTS) return null;
  const handlers: CommercePluginHandlerV1[] = [];
  for (const raw of value) {
    if (
      !exactKeys(raw, ["handlerId", "eventKinds", "source"]) ||
      typeof raw.handlerId !== "string" ||
      !PART_ID.test(raw.handlerId) ||
      !Array.isArray(raw.eventKinds) ||
      raw.eventKinds.length === 0 ||
      raw.eventKinds.length > 10 ||
      !raw.eventKinds.every(
        (kind: unknown) => typeof kind === "string" && EVENT_KIND.test(kind),
      ) ||
      !boundedSource(raw.source) ||
      handlers.some((handler) => handler.handlerId === raw.handlerId)
    )
      return null;
    handlers.push({
      handlerId: raw.handlerId,
      eventKinds: raw.eventKinds as string[],
      source: raw.source,
    });
  }
  return handlers;
}

function parseActions(value: unknown): CommercePluginActionV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTS) return null;
  const actions: CommercePluginActionV1[] = [];
  for (const raw of value) {
    if (
      !exactKeys(raw, ["actionId", "title", "inputs", "source"]) ||
      typeof raw.actionId !== "string" ||
      !PART_ID.test(raw.actionId) ||
      !boundedText(raw.title, 80) ||
      !Array.isArray(raw.inputs) ||
      raw.inputs.length > 10 ||
      !boundedSource(raw.source) ||
      actions.some((action) => action.actionId === raw.actionId)
    )
      return null;
    const inputs: CommercePluginActionV1["inputs"][number][] = [];
    for (const input of raw.inputs) {
      if (
        !exactKeys(input, ["key", "valueKind", "description"]) ||
        typeof input.key !== "string" ||
        !PART_ID.test(input.key) ||
        !ACTION_INPUT_KINDS.includes(input.valueKind as string) ||
        !boundedText(input.description, 200) ||
        inputs.some((item) => item.key === input.key)
      )
        return null;
      inputs.push({
        key: input.key,
        valueKind:
          input.valueKind as CommercePluginActionV1["inputs"][number]["valueKind"],
        description: input.description,
      });
    }
    actions.push({
      actionId: raw.actionId,
      title: raw.title,
      inputs,
      source: raw.source,
    });
  }
  return actions;
}

/** Up to eight entity types with different type ids, or null. */
function parseEntityTypes(
  value: unknown,
): readonly CommercePluginEntityTypeV1[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const types: CommercePluginEntityTypeV1[] = [];
  for (const raw of value) {
    const type = parseEntityType(raw);
    if (type === undefined || types.some((item) => item.typeId === type.typeId))
      return null;
    types.push(type);
  }
  return types;
}

/** One entity type, or undefined when it has no valid shape. */
function parseEntityType(
  value: unknown,
): CommercePluginEntityTypeV1 | undefined {
  if (
    !exactKeys(value, ["typeId", "label", "description", "attributes"]) ||
    typeof value.typeId !== "string" ||
    !/^[a-z][a-z0-9_]{1,63}$/u.test(value.typeId) ||
    !boundedText(value.label, 120) ||
    !boundedText(value.description, 1000) ||
    !Array.isArray(value.attributes) ||
    value.attributes.length === 0 ||
    value.attributes.length > 20
  )
    return undefined;
  const attributes: CommercePluginEntityTypeV1["attributes"][number][] = [];
  for (const attribute of value.attributes) {
    if (
      !exactKeys(attribute, ["key", "label", "valueKind", "required"]) ||
      typeof attribute.key !== "string" ||
      !PART_ID.test(attribute.key) ||
      !boundedText(attribute.label, 120) ||
      !ATTRIBUTE_KINDS.includes(attribute.valueKind as string) ||
      typeof attribute.required !== "boolean" ||
      attributes.some((item) => item.key === attribute.key)
    )
      return undefined;
    attributes.push({
      key: attribute.key,
      label: attribute.label,
      valueKind:
        attribute.valueKind as CommercePluginEntityTypeV1["attributes"][number]["valueKind"],
      required: attribute.required,
    });
  }
  return {
    typeId: value.typeId,
    label: value.label,
    description: value.description,
    attributes,
  };
}

function parseSetting(value: unknown): MerchantPluginSettingProposal | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["key", "valueKind", "description", "value"].includes(key),
    ) ||
    typeof value.key !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(value.key) ||
    !boundedText(value.description, 200) ||
    !SETTING_KINDS.includes(value.valueKind as MerchantPluginSettingKind)
  )
    return null;
  const valueKind = value.valueKind as MerchantPluginSettingKind;
  const setting = value.value;
  switch (valueKind) {
    case "integer":
      if (typeof setting !== "number" || !Number.isSafeInteger(setting))
        return null;
      break;
    case "text":
      if (typeof setting !== "string" || setting.length > 1_000) return null;
      break;
    case "boolean":
      if (typeof setting !== "boolean") return null;
      break;
    case "text_list":
      if (
        !Array.isArray(setting) ||
        setting.length > 100 ||
        !setting.every((item) => typeof item === "string" && item.length <= 256)
      )
        return null;
      break;
  }
  return {
    key: value.key,
    valueKind,
    description: value.description as string,
    value: setting as MerchantPluginSettingProposal["value"],
  };
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalid(field: string): Result<never, ParseError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}
