import type { Env } from "../env";
import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import type { HarnessCodeModeSandbox } from "./embedded-harness";
import type { OrganisationId } from "../ids";
import type { RequestableCapability } from "../authorization/requestable-capabilities";
import { createCatalogHarnessCodeMode, harnessCapabilitiesFromCapabilityKeys } from "../agent-tools/catalog/code-mode";
import { catalogHarnessToolCatalogDigest, harnessBaseCapabilities } from "../agent-tools/catalog/selection";
import type {
  HarnessCapabilityClaim,
  HarnessCapabilityName,
  HarnessSourceAuthorization,
} from "../agent-tools/catalog/types";
import { type HarnessPermissionRequest, type HarnessPermissionRequestResult, type HarnessPermissionRequestTool, missingRequestableCapabilities } from "../agent-tools/catalog/permission";
import { TOOL_REGISTRY, type ToolServices } from "../agent-tools/registry";
import { createHarnessCodeModeAdmission } from "./code-mode-admission";
import type { HarnessToolHost } from "./embedded-harness";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  customConnectorTurnTool,
  type CustomConnectorCatalogEntry,
} from "../custom-connectors";

export type HarnessToolHostConstructionError =
  | {
      readonly code: "embedded_harness_tool_catalog_digest_mismatch";
    }
  | {
      readonly code: "embedded_harness_resource_scope_invalid";
    }
  | {
      readonly code: "embedded_harness_custom_connector_unavailable";
    }
  | {
      readonly code: "embedded_harness_surface_unavailable";
    };

export function harnessToolCatalogDigest(
  allowedCapabilities: readonly HarnessCapabilityName[] = harnessBaseCapabilities(
    TOOL_REGISTRY,
  ),
  customConnectorOperations: readonly CustomConnectorCatalogEntry[] = [],
  bakerySurfaceCommands: readonly string[] = [],
  memoryProposal = false,
  followUp = false,
  permissionRequest = false,
  sideCaseProposal = false,
): Promise<string> {
  return catalogHarnessToolCatalogDigest(TOOL_REGISTRY, {
    allowedCapabilities,
    turnTools: customConnectorOperations.map(customConnectorTurnTool),
    bakerySurfaceCommands,
    memoryProposal,
    followUp,
    permissionRequest,
    sideCaseProposal,
  });
}

export async function createCatalogHarnessToolHost(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly expectedCatalogDigest: string;
  readonly capabilityKeys: readonly string[];
  readonly customConnectorOperations: readonly CustomConnectorCatalogEntry[];
  readonly bakerySurfaceCommands: readonly string[];
  /** True when the turn's authority may propose a Memory. */
  readonly memoryProposal: boolean;
  /** True for a Slack thread turn, which may schedule a follow-up. */
  readonly followUp: boolean;
  /** True for a Slack thread or Portal chat turn, which may ask a person. */
  readonly permissionRequest: boolean;
  /** True for a Portal chat or Slack thread turn, which may propose a side Case. */
  readonly sideCaseProposal: boolean;
  /**
   * The services of each tool family for this turn. The type names each
   * service that a family needs, so a tool that the model sees has a handler.
   */
  readonly services: ToolServices;
  /**
   * Records a permission request of a Slack thread turn. The host passes only
   * capabilities that this turn lacks.
   */
  readonly requestPermission: HarnessPermissionRequestTool;
  readonly claimCapability: HarnessCapabilityClaim;
  readonly authorizeSources: HarnessSourceAuthorization;
}): Promise<
  | { readonly ok: true; readonly value: HarnessToolHost }
  | { readonly ok: false; readonly error: HarnessToolHostConstructionError }
> {
  const capabilities = harnessCapabilitiesFromCapabilityKeys(
    input.capabilityKeys,
  );
  if (!capabilities.ok) {
    return {
      ok: false,
      error: { code: "embedded_harness_resource_scope_invalid" },
    };
  }
  const authority = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: input.expectedCatalogDigest,
    catalogSelection: {
      allowedCapabilities: capabilities.value,
      turnTools: input.customConnectorOperations.map(customConnectorTurnTool),
      bakerySurfaceCommands: input.bakerySurfaceCommands,
      memoryProposal: input.memoryProposal,
      followUp: input.followUp,
      permissionRequest: input.permissionRequest,
      sideCaseProposal: input.sideCaseProposal,
    },
    nativeSandbox: codeModeSandbox(input.env),
    authorizeSources: input.authorizeSources,
    admission: createHarnessCodeModeAdmission({
      env: input.env,
      storage: input.storage,
      organisationId: input.organisationId,
      lease: input.lease,
      catalogDigest: input.expectedCatalogDigest,
    }),
    services: input.services,
    requestPermission: requestOnlyMissingCapabilities.bind(
      null,
      input.requestPermission,
      missingRequestableCapabilities(capabilities.value),
    ),
    claimCapability: input.claimCapability,
  });
  return authority;
}

/**
 * A turn asks only for what it lacks. The tool lists only those capabilities,
 * so another name means a call that the catalogue did not offer.
 */
function requestOnlyMissingCapabilities(
  request: HarnessPermissionRequestTool,
  missing: readonly RequestableCapability[],
  input: HarnessPermissionRequest,
): Promise<HarnessPermissionRequestResult> {
  for (const capability of input.capabilityIds)
    if (!missing.includes(capability))
      throw new TypeError(
        "request_permission names a capability this turn holds",
      );
  return request(input);
}

/**
 * One sandbox object for each execution, named by the stable execution
 * identity. Every attempt of an execution reaches the same object, and the
 * scripts of other executions do not share its thread.
 */
export function codeModeSandbox(env: Env): HarnessCodeModeSandbox | null {
  const namespace = env.CODE_MODE_SANDBOX;
  return namespace === undefined
    ? null
    : codeModeSandboxRemote.bind(null, namespace);
}

function codeModeSandboxRemote(
  namespace: NonNullable<Env["CODE_MODE_SANDBOX"]>,
  executionId: string,
): CodemodeRemote {
  const sandbox = namespace.getByName(executionId);
  return {
    async execute(request, exchange) {
      await sandbox.execute(request, exchange);
    },
  };
}
