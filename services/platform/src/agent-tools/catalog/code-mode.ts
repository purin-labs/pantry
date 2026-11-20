import type { HarnessCodeModeSandbox } from "../../actors/embedded-harness";
import type { Result } from "../../result";
import { CONTEXT_CASE_READ_SCOPE } from "../../authorization/access-grants/turn-authority";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  SLACK_MESSAGE_RESOURCE_SCOPE,
  WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
} from "../../authorization/capability-catalogue";
import { parseCapabilityKey } from "../../authorization/access-grants/capability-key";
import {
  type CatalogToolAuthority,
  executeCatalogTool,
  executeNativeCatalogTool,
} from "./execute";
import type { HarnessPermissionRequestTool } from "./permission";
import {
  catalogHarnessToolCatalogDigest,
  harnessBaseCapabilities,
  selectCatalogDefinitions,
} from "./selection";
import type { EffectSettle } from "../tool-effect";
import {
  toolAvailable,
  type ToolRegistry,
  type ToolServiceSet,
} from "./tool-registry";
import type {
  HarnessCapabilityClaim,
  HarnessCapabilityClaimInput,
  HarnessCapabilityName,
  HarnessCatalogSelection,
  HarnessCodeModeAdmission,
  HarnessCodeModeAuthority,
  HarnessCodeModeConstructionError,
  HarnessResourceScopeError,
  HarnessSourceAuthorization,
} from "./types";

export const MAX_CODE_MODE_SOURCE_BYTES = 64 * 1024;

export function harnessCapabilitiesFromCapabilityKeys(
  capabilityKeys: readonly string[],
): Result<readonly HarnessCapabilityName[], HarnessResourceScopeError> {
  const capabilities: HarnessCapabilityName[] = [];
  const seen = new Set<HarnessCapabilityName>();
  const resourceDerived = new Set<HarnessCapabilityName>();
  for (const scope of capabilityKeys) {
    if (
      scope === CONTEXT_CASE_READ_SCOPE ||
      scope === `platform:${CAPABILITY_KEYS.customConnectorDraft}:1`
    ) {
      continue;
    }
    if (scope.startsWith("custom_connector:")) {
      const customCapability = customConnectorCapabilityFromKey(scope);
      if (customCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      if (!seen.has(customCapability)) {
        seen.add(customCapability);
        capabilities.push(customCapability);
      }
      continue;
    }
    if (scope.startsWith("provider:")) {
      const providerCapability = capabilityFromProviderResourceScope(scope);
      if (providerCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      resourceDerived.add(providerCapability);
      if (!seen.has(providerCapability)) {
        seen.add(providerCapability);
        capabilities.push(providerCapability);
      }
      continue;
    }
    if (scope.startsWith("file:")) {
      const fileCapability = capabilityFromFileResourceScope(scope);
      if (fileCapability === null) {
        return {
          ok: false,
          error: { code: "embedded_harness_resource_scope_invalid", scope },
        };
      }
      resourceDerived.add(fileCapability);
      if (!seen.has(fileCapability)) {
        seen.add(fileCapability);
        capabilities.push(fileCapability);
      }
      continue;
    }
    const capability = capabilityFromResourceScope(scope);
    if (
      capability === null ||
      (seen.has(capability) && !resourceDerived.has(capability))
    ) {
      return {
        ok: false,
        error: { code: "embedded_harness_resource_scope_invalid", scope },
      };
    }
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    capabilities.push(capability);
  }
  capabilities.sort(compareCapabilities);
  return { ok: true, value: Object.freeze(capabilities) };
}

export async function createCatalogHarnessCodeMode(input: {
  /** The tools of the Worker, in catalog order. */
  readonly registry: ToolRegistry;
  readonly expectedCatalogDigest: string;
  readonly catalogSelection?: HarnessCatalogSelection;
  /**
   * Absent: this host has no native Code Mode. `null`: it has, and this
   * deployment lacks the sandbox Worker.
   */
  readonly nativeSandbox?: HarnessCodeModeSandbox | null;
  /** Required for native Code Mode. Without it every replayed result is denied. */
  readonly authorizeSources?: HarnessSourceAuthorization;
  /**
   * The services of each tool family, by family name. A tool whose service
   * is absent fails with its `unavailable` text.
   */
  readonly services: ToolServiceSet;
  readonly requestPermission?: HarnessPermissionRequestTool;
  /** Runs the exit checks of an effect tool. A Session gives it. */
  readonly settleEffect?: EffectSettle;
  readonly admission: HarnessCodeModeAdmission;
  readonly claimCapability: HarnessCapabilityClaim;
}): Promise<
  Result<HarnessCodeModeAuthority, HarnessCodeModeConstructionError>
> {
  const catalogSelection = input.catalogSelection ?? {
    allowedCapabilities: harnessBaseCapabilities(input.registry),
  };
  const definitions = selectCatalogDefinitions(
    input.registry,
    catalogSelection,
  );
  const catalogDigest = await catalogHarnessToolCatalogDigest(
    input.registry,
    catalogSelection,
  );
  if (catalogDigest !== input.expectedCatalogDigest) {
    return {
      ok: false,
      error: { code: "embedded_harness_tool_catalog_digest_mismatch" },
    };
  }
  // A catalog that offers a tool with no handler would fail at each call, so
  // the host refuses it here: the read turn tools, then the surface tools,
  // then the other turn tools, as the checks were before Refactor 17.
  const turnTools = (catalogSelection.turnTools ?? []).map(({ tool }) => tool);
  const unavailable = (tool: (typeof turnTools)[number]): boolean =>
    !toolAvailable(tool, input.services);
  if (turnTools.some((tool) => tool.effect === "read" && unavailable(tool))) {
    return {
      ok: false,
      error: { code: "embedded_harness_custom_connector_unavailable" },
    };
  }
  const surfaceCommands = new Set(catalogSelection.bakerySurfaceCommands ?? []);
  if (
    input.registry.tools.some(
      (tool) =>
        tool.selection.kind === "surface" &&
        surfaceCommands.has(tool.selection.command) &&
        unavailable(tool),
    )
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_surface_unavailable" },
    };
  }
  if (turnTools.some(unavailable)) {
    return {
      ok: false,
      error: { code: "embedded_harness_custom_connector_unavailable" },
    };
  }
  const claimedCapabilities: ClaimedCapabilities = new Map();
  const authority: CatalogToolAuthority = {
    registry: input.registry,
    definitions,
    turnTools,
    services: input.services,
    requestPermission: input.requestPermission,
    ...(input.settleEffect === undefined
      ? {}
      : { settleEffect: input.settleEffect }),
    claimCapability: recordCapabilityClaim.bind(
      null,
      claimedCapabilities,
      input.claimCapability,
    ),
  };
  return {
    ok: true,
    value: {
      mode: "hybrid",
      catalogDigest,
      definitions,
      codeMode:
        input.nativeSandbox === undefined
          ? { kind: "disabled" }
          : {
              kind: "enabled",
              sandbox: input.nativeSandbox,
              admission: input.admission,
              executeTool: executeNativeCatalogTool.bind(null, authority),
              claimedCapabilities: readClaimedCapabilities.bind(
                null,
                claimedCapabilities,
              ),
              authorizeSources: authorizeRecordedSources.bind(
                null,
                catalogSelection.allowedCapabilities,
                input.authorizeSources,
              ),
            },
      claimCapability: input.claimCapability,
      executeTool: executeCatalogTool.bind(null, authority, { kind: "direct" }),
    },
  };
}

/** The capabilities that each call of this host claimed, by call ID. */
type ClaimedCapabilities = Map<string, Set<HarnessCapabilityName>>;

async function recordCapabilityClaim(
  claimed: ClaimedCapabilities,
  claimCapability: HarnessCapabilityClaim,
  input: HarnessCapabilityClaimInput,
): ReturnType<HarnessCapabilityClaim> {
  const result = await claimCapability(input);
  if (result.ok) {
    const capabilities = claimed.get(input.callId) ?? new Set();
    capabilities.add(input.capability);
    claimed.set(input.callId, capabilities);
  }
  return result;
}

function readClaimedCapabilities(
  claimed: ClaimedCapabilities,
  callId: string,
): readonly string[] {
  return [...(claimed.get(callId) ?? [])].sort();
}

/**
 * A recorded source is a name from storage. It counts only when this turn's
 * catalog still allows the capability, and current authority still grants it.
 */
async function authorizeRecordedSources(
  allowed: readonly HarnessCapabilityName[],
  authorizeSources: HarnessSourceAuthorization | undefined,
  capabilities: readonly string[],
): Promise<Result<null, { readonly detail: string }>> {
  if (authorizeSources === undefined) {
    return { ok: false, error: { detail: "source_authorization_unavailable" } };
  }
  const sources: HarnessCapabilityName[] = [];
  for (const capability of capabilities) {
    const source = allowed.find(sameCapability.bind(null, capability));
    if (source === undefined) {
      return { ok: false, error: { detail: "source_outside_catalog" } };
    }
    sources.push(source);
  }
  return authorizeSources(sources);
}

function sameCapability(
  name: string,
  capability: HarnessCapabilityName,
): boolean {
  return capability === name;
}

function capabilityFromResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const match = /^platform:(.+):1$/u.exec(scope);
  if (match === null) {
    return null;
  }
  switch (match[1]) {
    case CAPABILITY_KEYS.integrationDiscoveryRead:
    case CAPABILITY_KEYS.commerceEntityPlaneContext:
    case CAPABILITY_KEYS.commerceWorkflowCanvasMove:
    case CAPABILITY_KEYS.commerceProductDescriptionDraftEdit:
    case CAPABILITY_KEYS.commerceMenuDraftRead:
    case CAPABILITY_KEYS.commerceMenuDraftEdit:
    case CAPABILITY_KEYS.commerceProductionPlanEdit:
    case CAPABILITY_KEYS.commerceOrderQueueAdvance:
    case CAPABILITY_KEYS.commerceSoldOutMark:
    case CAPABILITY_KEYS.commerceRecipeSave:
    case CAPABILITY_KEYS.commerceSupplyCostSave:
    case CAPABILITY_KEYS.commerceSupplierCreate:
    case CAPABILITY_KEYS.recipeWorkflowRead:
    case CAPABILITY_KEYS.recipeWorkflowPropose:
    case CAPABILITY_KEYS.deviceRead:
    case CAPABILITY_KEYS.devicePause:
    case CAPABILITY_KEYS.deviceCameraRead:
    case CAPABILITY_KEYS.jevFeaturesRead:
    case CAPABILITY_KEYS.jevFeaturesManage:
    case CAPABILITY_KEYS.bakeRead:
    case CAPABILITY_KEYS.bakePropose:
    case CAPABILITY_KEYS.marketingEmailDraftEdit:
    case CAPABILITY_KEYS.commerceActionPropose:
    case CAPABILITY_KEYS.messageAttachmentInspect:
    case CAPABILITY_KEYS.messageLinkRead:
    case CAPABILITY_KEYS.workspaceQuery:
      return match[1];
    default:
      return null;
  }
}

function capabilityFromProviderResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const providerPrefix = "provider:";
  if (!scope.startsWith(providerPrefix)) {
    return null;
  }
  const capabilityStart = providerPrefix.length;
  const capabilityEnd = scope.indexOf(":", capabilityStart);
  if (capabilityEnd < 0) {
    return null;
  }
  const versionStart = capabilityEnd + 1;
  const versionEnd = scope.indexOf(":", versionStart);
  if (versionEnd < 0) {
    return null;
  }
  const accountStart = versionEnd + 1;
  const accountEnd = scope.indexOf(":", accountStart);
  if (accountEnd < 0) {
    return null;
  }
  const capabilityId = scope.slice(capabilityStart, capabilityEnd);
  const version = scope.slice(versionStart, versionEnd);
  const integrationAccountId = scope.slice(accountStart, accountEnd);
  const resourceScope = scope.slice(accountEnd + 1);
  if (
    version !== "1" ||
    integrationAccountId.length === 0 ||
    resourceScope.length === 0
  ) {
    return null;
  }
  switch (capabilityId) {
    case CAPABILITY_KEYS.airtableApiRead:
    case CAPABILITY_KEYS.airtableApiWrite:
      return /^base:app[A-Za-z0-9]{8,32}$/u.test(resourceScope)
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.commerceEntityPlaneContext:
    case CAPABILITY_KEYS.commerceActionPropose:
    case CAPABILITY_KEYS.fileRead:
    case CAPABILITY_KEYS.workspaceQuery:
      return capabilityId;
    case CAPABILITY_KEYS.whatsappSupportRead:
    case CAPABILITY_KEYS.whatsappSupportReplySend:
      return resourceScope === WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.emailMailboxRead:
    case CAPABILITY_KEYS.emailReplyPropose:
      return resourceScope === EMAIL_MAILBOX_RESOURCE_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.emailOperationalPropose:
      return resourceScope === EMAIL_OPERATIONAL_RESOURCE_SCOPE
        ? capabilityId
        : null;
    case CAPABILITY_KEYS.slackMessagePropose:
      return resourceScope === SLACK_MESSAGE_RESOURCE_SCOPE
        ? capabilityId
        : null;
    default:
      return null;
  }
}

function capabilityFromFileResourceScope(
  scope: string,
): HarnessCapabilityName | null {
  const parsed = parseCapabilityKey(scope);
  return parsed.ok &&
    parsed.value.kind === "file_resource" &&
    parsed.value.capabilityId === CAPABILITY_KEYS.fileRead
    ? CAPABILITY_KEYS.fileRead
    : null;
}

function compareCapabilities(
  left: HarnessCapabilityName,
  right: HarnessCapabilityName,
): number {
  return left.localeCompare(right);
}

function customConnectorCapabilityFromKey(
  scope: string,
):
  | typeof CAPABILITY_KEYS.customConnectorRead
  | typeof CAPABILITY_KEYS.customConnectorWrite
  | null {
  const parsed = parseCapabilityKey(scope);
  if (parsed.ok && parsed.value.kind === "custom_connector_operation") {
    if (parsed.value.capabilityId === CAPABILITY_KEYS.customConnectorRead) {
      return CAPABILITY_KEYS.customConnectorRead;
    }
    if (parsed.value.capabilityId === CAPABILITY_KEYS.customConnectorWrite) {
      return CAPABILITY_KEYS.customConnectorWrite;
    }
  }
  return null;
}
