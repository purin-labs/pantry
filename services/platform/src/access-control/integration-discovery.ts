import type { OrganisationDatabase } from "../database-handles";
import type {
  OrganisationAccess,
  OrganisationUserAuthority,
} from "../organisation-access/access";
import type {
  AuthorityPartition,
  CapabilityDefinition,
  IntegrationDiscoveryAccount,
  IntegrationDiscoveryConnection,
  IntegrationDiscoveryDataClass,
  IntegrationDiscoveryProvider,
  IntegrationDiscoveryView,
  RequestAuthority,
} from "@purin-labs/contracts";

import { selectActiveGrants } from "../authorization/access-grants/compiler";
import { authorizeCapabilityUse } from "../authorization/access-grants/turn-authority";
import type { AccessGrant } from "../authorization/access-grants/types";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
} from "../authorization/capability-catalogue";
import { listAccessGrants } from "../data/access-grants";
import { readOrganisationCapabilityPolicies } from "../data/capability-policy";
import {
  listIntegrationAccounts,
  type IntegrationAccount,
  type IntegrationAccountLifecycle,
} from "../data/integration-account";
import {
  resolveOrganisationCommerceSystem,
  type CommerceSystem,
} from "../data/organisation-commerce-system";
import { resolveCommerceMerchantBindingById } from "../data/commerce-merchant-binding";
import type { CaseId, IntegrationAccountId, OrganisationId } from "../ids";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  digestCanonical,
  ObservationEvidence,
  type FlowLabel,
} from "../policy";
import {
  parseActiveIntegrationProvider,
  PROVIDER_DATA_CLASSES,
  type ActiveIntegrationProvider,
} from "../data/integration-provider-directory";
import type { Result } from "../result";
import {
  assertNever,
  exhaustiveList,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
const DISCOVERY_LIMIT = 50;
const ACCOUNT_REF_PATTERN = /^integration_ref_[0-9a-f]{64}$/u;
export type IntegrationAccountReference = `integration_ref_${string}`;

export function parseIntegrationAccountReference(
  raw: unknown,
): IntegrationAccountReference | null {
  if (typeof raw !== "string" || !ACCOUNT_REF_PATTERN.test(raw)) return null;
  return `integration_ref_${raw.slice("integration_ref_".length)}`;
}

export async function integrationAccountReference(
  organisationId: OrganisationId,
  sourceIntegrationAccountId: IntegrationAccountId,
  kind: "integration_account" | "builtin_commerce",
): Promise<IntegrationAccountReference> {
  return `integration_ref_${await digestCanonical({
    kind,
    organisationId,
    sourceIntegrationAccountId,
  })}`;
}
const EMAIL_DISPLAY_NAME_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATA_CLASS_ORDER = exhaustiveList<IntegrationDiscoveryDataClass>()([
  "commerce",
  "payments",
  "records",
  "files",
  "mail",
  "messaging",
]);
const DISCOVERY_PROVIDERS: Readonly<
  Record<IntegrationDiscoveryProvider, true>
> = {
  builtin_commerce: true,
  airtable: true,
  dropbox: true,
  gmail: true,
  google_drive: true,
  notion: true,
  shopify: true,
  slack: true,
  square: true,
  stripe: true,
  whatsapp: true,
  gmo_aozora: true,
  wise: true,
};

type DiscoveryStage =
  | "authority"
  | "policy"
  | "grants"
  | "accounts"
  | "source_label"
  | "context_admission"
  | "observation";

type IntegrationDiscoveryError = Readonly<{
  code: "integration_discovery_unavailable";
  stage: DiscoveryStage;
}>;

export type IntegrationDiscoveryObservation = Readonly<{
  inputLabel: FlowLabel;
  evidence: ObservationEvidence;
}>;

type DiscoveryCandidate = Readonly<{
  kind: "integration_account" | "builtin_commerce";
  sourceIntegrationAccountId: IntegrationAccountId;
  provider: IntegrationDiscoveryProvider;
  displayName: string;
  connection: IntegrationDiscoveryConnection;
  configuredDataClasses: readonly IntegrationDiscoveryDataClass[];
}>;

type CurrentDiscoveryState = Readonly<{
  selectedGrants: readonly AccessGrant[];
  enabledCapabilities: ReadonlySet<string>;
  commerceSystem: CommerceSystem | null;
}>;

type ProjectedDiscoveryAccount = Readonly<{
  view: IntegrationDiscoveryAccount;
  sourceIntegrationAccountId: IntegrationAccountId;
}>;

export async function readIntegrationDiscovery(
  input: Readonly<{
    db: OrganisationDatabase;
    accountAccess: OrganisationAccess;
    userAuthority: OrganisationUserAuthority;
    organisationId: OrganisationId;
    requestAuthority: RequestAuthority;
    authorityPartition: AuthorityPartition;
    caseId: CaseId;
    observedAt: number;
    observe: (observation: IntegrationDiscoveryObservation) => Promise<void>;
  }>,
): Promise<Result<IntegrationDiscoveryView, IntegrationDiscoveryError>> {
  if (!isNonNegativeInteger(input.observedAt)) return unavailable("authority");
  const authorized = await authorizeDiscovery(input);
  if (!authorized.ok) return authorized;
  const state = await readCurrentDiscoveryState(input);
  if (!state.ok) return state;
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_metadata",
    db: input.db,
    organisationId: input.organisationId,
    grantIds: discoveryGrantIds(state.value.selectedGrants),
  });
  if (!label.ok) return unavailable("source_label");
  const admitted = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: input.requestAuthority,
      caseId: input.caseId,
    },
    inputLabel: label.value,
  });
  if (admitted.kind !== "admit") return unavailable("context_admission");
  const projectionRevision = await readProjectionRevision(
    input.db,
    input.organisationId,
  );
  if (projectionRevision === null) return unavailable("accounts");
  const candidates = await readDiscoveryCandidates(
    input.db,
    input.organisationId,
    state.value.commerceSystem,
  );
  if (!candidates.ok) return candidates;
  const projected = await projectCandidates(
    input.organisationId,
    candidates.value,
    state.value,
  );
  const limited = projected.slice(0, DISCOVERY_LIMIT);
  const view: IntegrationDiscoveryView = {
    observedAt: input.observedAt,
    accounts: [...readProjectedViews(limited)],
    truncated: projected.length > DISCOVERY_LIMIT,
  };
  const parsed = parseIntegrationDiscoveryView(view);
  if (!parsed.ok) return unavailable("accounts");
  for (const account of limited) {
    const evidence = await createDiscoveryEvidence({
      organisationId: input.organisationId,
      account,
      sourceRevision: projectionRevision,
      inputLabel: label.value,
      observedAt: input.observedAt,
    });
    if (!evidence.ok) return evidence;
    try {
      await input.observe({
        inputLabel: label.value,
        evidence: evidence.value,
      });
    } catch {
      return unavailable("observation");
    }
  }
  const stillAuthorized = await authorizeDiscovery(input);
  return stillAuthorized.ok
    ? { ok: true, value: parsed.value }
    : stillAuthorized;
}

export function parseIntegrationDiscoveryView(
  raw: unknown,
): Result<IntegrationDiscoveryView, IntegrationDiscoveryError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["observedAt", "accounts", "truncated"]) ||
    !isNonNegativeInteger(raw.observedAt) ||
    !Array.isArray(raw.accounts) ||
    typeof raw.truncated !== "boolean" ||
    raw.accounts.length > DISCOVERY_LIMIT ||
    (raw.truncated && raw.accounts.length !== DISCOVERY_LIMIT)
  ) {
    return unavailable("accounts");
  }
  const accounts: IntegrationDiscoveryAccount[] = [];
  const refs = new Set<string>();
  for (const candidate of raw.accounts) {
    const account = parseDiscoveryAccount(candidate);
    if (account === null || refs.has(account.accountRef))
      return unavailable("accounts");
    refs.add(account.accountRef);
    accounts.push(account);
  }
  for (let index = 1; index < accounts.length; index += 1) {
    const previous = accounts[index - 1];
    const current = accounts[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareDiscoveryAccounts(previous, current) > 0
    ) {
      return unavailable("accounts");
    }
  }
  return {
    ok: true,
    value: {
      observedAt: raw.observedAt,
      accounts,
      truncated: raw.truncated,
    },
  };
}

async function authorizeDiscovery(
  input: Readonly<{
    db: OrganisationDatabase;
    accountAccess: OrganisationAccess;
    userAuthority: OrganisationUserAuthority;
    organisationId: OrganisationId;
    requestAuthority: RequestAuthority;
    authorityPartition: AuthorityPartition;
  }>,
): Promise<Result<true, IntegrationDiscoveryError>> {
  const authorized = await authorizeCapabilityUse({
    db: input.db,
    accountAccess: input.accountAccess,
    userAuthority: input.userAuthority,
    action: "execute",
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    authorityPartition: input.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
          capabilityVersion: 1,
        },
      ],
    },
  });
  return authorized.ok ? { ok: true, value: true } : unavailable("authority");
}

async function readCurrentDiscoveryState(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    requestAuthority: RequestAuthority;
  }>,
): Promise<Result<CurrentDiscoveryState, IntegrationDiscoveryError>> {
  const grants = await listAccessGrants({
    db: input.db,
    organisationId: input.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) return unavailable("grants");
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) return unavailable("grants");
  const policies = await readOrganisationCapabilityPolicies({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!policies.ok) return unavailable("policy");
  const enabledCapabilities = new Set<string>();
  for (const policy of policies.value) {
    if (policy.mode === "enabled") enabledCapabilities.add(policy.capabilityId);
  }
  const selectedCommerce = await resolveOrganisationCommerceSystem({
    db: input.db,
    organisationId: input.organisationId,
  });
  return {
    ok: true,
    value: {
      selectedGrants: selected.value,
      enabledCapabilities,
      commerceSystem: selectedCommerce.ok ? selectedCommerce.value : null,
    },
  };
}

function discoveryGrantIds(grants: readonly AccessGrant[]): readonly string[] {
  const grantIds: string[] = [];
  for (const grant of grants) {
    if (
      grant.target.kind === "platform_capability" &&
      grant.target.capabilityId === CAPABILITY_KEYS.integrationDiscoveryRead &&
      grant.target.capabilityVersion === 1
    ) {
      grantIds.push(grant.grantId);
    }
  }
  grantIds.sort();
  return grantIds;
}

async function readProjectionRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `SELECT projection_revision AS projectionRevision
         FROM organisation_onboarding
        WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<{ readonly projectionRevision: unknown }>();
    return isPositiveInteger(row?.projectionRevision)
      ? row.projectionRevision
      : null;
  } catch {
    return null;
  }
}

async function readDiscoveryCandidates(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  commerceSystem: CommerceSystem | null,
): Promise<Result<readonly DiscoveryCandidate[], IntegrationDiscoveryError>> {
  let accounts: readonly IntegrationAccount[];
  try {
    accounts = await listIntegrationAccounts({ db, organisationId });
  } catch {
    return unavailable("accounts");
  }
  const candidates: DiscoveryCandidate[] = [];
  for (const account of accounts) {
    const provider = parseActiveIntegrationProvider(account.provider);
    if (provider === null || account.lifecycle.kind === "revoked") continue;
    candidates.push(candidateForIntegrationAccount(account, provider));
  }
  if (commerceSystem?.kind === "builtin_commerce") {
    const binding = await resolveCommerceMerchantBindingById({
      db,
      organisationId,
      bindingId: commerceSystem.bindingId,
    });
    if (binding.ok) {
      candidates.push({
        kind: "builtin_commerce",
        sourceIntegrationAccountId: binding.value.integrationAccountId,
        provider: "builtin_commerce",
        displayName: "Purin Checkout",
        connection: "available",
        configuredDataClasses: ["commerce"],
      });
    }
  }
  return { ok: true, value: candidates };
}

function candidateForIntegrationAccount(
  account: IntegrationAccount,
  provider: ActiveIntegrationProvider,
): DiscoveryCandidate {
  return {
    kind: "integration_account",
    sourceIntegrationAccountId: account.integrationAccountId,
    provider: discoveryProvider(provider),
    displayName: discoveryDisplayName(provider, account.displayName),
    connection: discoveryConnection(account.lifecycle),
    configuredDataClasses: PROVIDER_DATA_CLASSES[provider],
  };
}

function discoveryProvider(
  provider: ActiveIntegrationProvider,
): IntegrationDiscoveryProvider {
  switch (provider) {
    case "airtable":
    case "dropbox":
    case "gmail":
    case "google_drive":
    case "notion":
    case "shopify":
    case "slack":
    case "square":
    case "stripe":
    case "whatsapp":
      return provider;
    default:
      return assertNever(provider);
  }
}

function discoveryConnection(
  lifecycle: IntegrationAccountLifecycle,
): IntegrationDiscoveryConnection {
  switch (lifecycle.kind) {
    case "active":
      return "available";
    case "connecting":
    case "pending_activation":
    case "degraded":
    case "reauth_required":
      return "attention_required";
    case "disabled":
    case "revoked":
      return "unavailable";
    default:
      return assertNever(lifecycle);
  }
}

async function projectCandidates(
  organisationId: OrganisationId,
  candidates: readonly DiscoveryCandidate[],
  state: CurrentDiscoveryState,
): Promise<readonly ProjectedDiscoveryAccount[]> {
  const projected: ProjectedDiscoveryAccount[] = [];
  for (const candidate of candidates) {
    const accountRef = await integrationAccountReference(
      organisationId,
      candidate.sourceIntegrationAccountId,
      candidate.kind,
    );
    projected.push({
      sourceIntegrationAccountId: candidate.sourceIntegrationAccountId,
      view: {
        accountRef,
        provider: candidate.provider,
        displayName: candidate.displayName,
        connection: candidate.connection,
        configuredDataClasses: [
          ...orderedDataClasses(candidate.configuredDataClasses),
        ],
        readableDataClasses: [...readableDataClasses(candidate, state)],
      },
    });
  }
  projected.sort(compareProjectedAccounts);
  return projected;
}

function readableDataClasses(
  candidate: DiscoveryCandidate,
  state: CurrentDiscoveryState,
): readonly IntegrationDiscoveryDataClass[] {
  if (candidate.connection !== "available") return [];
  const readable = new Set<IntegrationDiscoveryDataClass>();
  for (const grant of state.selectedGrants) {
    const dataClass = readableProviderGrantDataClass(
      grant,
      candidate,
      state.enabledCapabilities,
    );
    if (dataClass !== null) readable.add(dataClass);
  }
  if (commerceReadable(candidate, state)) readable.add("commerce");
  return orderedDataClasses(readable);
}

function readableProviderGrantDataClass(
  grant: AccessGrant,
  candidate: DiscoveryCandidate,
  enabledCapabilities: ReadonlySet<string>,
): IntegrationDiscoveryDataClass | null {
  if (!enabledCapabilities.has(grant.target.capabilityId)) return null;
  if (
    grant.target.kind !== "provider_resource" &&
    grant.target.kind !== "file_resource"
  )
    return null;
  if (
    grant.target.integrationAccountId !== candidate.sourceIntegrationAccountId
  )
    return null;
  const definition = capabilityDefinition(
    grant.target.capabilityId,
    grant.target.capabilityVersion,
  );
  if (
    definition === null ||
    definition.risk !== "read" ||
    definition.providerDependency.kind !== "provider" ||
    !providerDependencyIncludes(definition, candidate.provider)
  )
    return null;
  if (grant.target.kind === "file_resource") return "files";
  return dataClassForProviderRead(definition, candidate.configuredDataClasses);
}

function providerDependencyIncludes(
  definition: CapabilityDefinition,
  provider: IntegrationDiscoveryProvider,
): boolean {
  if (
    definition.providerDependency.kind !== "provider" ||
    provider === "builtin_commerce"
  )
    return false;
  for (const allowed of definition.providerDependency.providers) {
    if (allowed === provider) return true;
  }
  return false;
}

function dataClassForProviderRead(
  definition: CapabilityDefinition,
  configured: readonly IntegrationDiscoveryDataClass[],
): IntegrationDiscoveryDataClass | null {
  switch (definition.category) {
    case "commerce":
      return configured.includes("commerce") ? "commerce" : null;
    case "payments":
      return configured.includes("payments") ? "payments" : null;
    case "customer_data":
      return configured.length === 1 ? (configured[0] ?? null) : null;
    case "context":
    case "agent_operations":
    // External reads have no connected provider and no organisation data class to
    // discover; they are governed by their own capability, not by discovery.
    case "external_data":
      return null;
    default:
      return assertNever(definition.category);
  }
}

function commerceReadable(
  candidate: DiscoveryCandidate,
  state: CurrentDiscoveryState,
): boolean {
  if (
    !state.enabledCapabilities.has(
      CAPABILITY_KEYS.commerceEntityPlaneContext,
    ) ||
    !state.enabledCapabilities.has(CAPABILITY_KEYS.commerceEntityRead) ||
    !hasSelectedGrant(
      state.selectedGrants,
      "platform_capability",
      CAPABILITY_KEYS.commerceEntityPlaneContext,
    ) ||
    !hasSelectedGrant(
      state.selectedGrants,
      "commerce_read",
      CAPABILITY_KEYS.commerceEntityRead,
    ) ||
    state.commerceSystem === null
  )
    return false;
  if (candidate.kind === "builtin_commerce") {
    return state.commerceSystem.kind === "builtin_commerce";
  }
  return (
    candidate.provider === "shopify" &&
    state.commerceSystem.kind === "shopify" &&
    state.commerceSystem.integrationAccountId ===
      candidate.sourceIntegrationAccountId
  );
}

function hasSelectedGrant(
  grants: readonly AccessGrant[],
  kind: "platform_capability" | "commerce_read",
  capabilityId: string,
): boolean {
  for (const grant of grants) {
    if (
      grant.target.kind === kind &&
      grant.target.capabilityId === capabilityId &&
      grant.target.capabilityVersion === 1
    )
      return true;
  }
  return false;
}

function capabilityDefinition(
  capabilityId: string,
  capabilityVersion: number,
): CapabilityDefinition | null {
  for (const definition of CAPABILITY_CATALOGUE) {
    if (
      definition.capabilityId === capabilityId &&
      definition.capabilityVersion === capabilityVersion
    ) {
      return definition;
    }
  }
  return null;
}

async function createDiscoveryEvidence(
  input: Readonly<{
    organisationId: OrganisationId;
    account: ProjectedDiscoveryAccount;
    sourceRevision: number;
    inputLabel: FlowLabel;
    observedAt: number;
  }>,
): Promise<Result<ObservationEvidence, IntegrationDiscoveryError>> {
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: input.organisationId,
      integrationAccountId: input.account.sourceIntegrationAccountId,
      resourceScope: `integration_metadata:${input.account.view.accountRef}`,
    },
    sourceRevision: input.sourceRevision,
    contentDigest: await digestCanonical(input.account.view),
    inputLabel: input.inputLabel,
    observedAt: input.observedAt,
  });
  return evidence.ok ? evidence : unavailable("observation");
}

function readProjectedViews(
  accounts: readonly ProjectedDiscoveryAccount[],
): readonly IntegrationDiscoveryAccount[] {
  const views: IntegrationDiscoveryAccount[] = [];
  for (const account of accounts) views.push(account.view);
  return views;
}

function parseDiscoveryAccount(
  raw: unknown,
): IntegrationDiscoveryAccount | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "accountRef",
      "provider",
      "displayName",
      "connection",
      "configuredDataClasses",
      "readableDataClasses",
    ]) ||
    typeof raw.accountRef !== "string" ||
    !ACCOUNT_REF_PATTERN.test(raw.accountRef) ||
    !isDiscoveryProvider(raw.provider) ||
    !boundedText(raw.displayName, 160) ||
    !isDiscoveryConnection(raw.connection)
  )
    return null;
  const configured = parseDataClasses(raw.configuredDataClasses, false);
  const readable = parseDataClasses(raw.readableDataClasses, true);
  if (configured === null || readable === null) return null;
  for (const dataClass of readable) {
    if (!configured.includes(dataClass)) return null;
  }
  return {
    accountRef: raw.accountRef,
    provider: raw.provider,
    displayName: raw.displayName,
    connection: raw.connection,
    configuredDataClasses: [...configured],
    readableDataClasses: [...readable],
  };
}

function parseDataClasses(
  raw: unknown,
  allowEmpty: boolean,
): readonly IntegrationDiscoveryDataClass[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length > DATA_CLASS_ORDER.length ||
    (!allowEmpty && raw.length === 0)
  ) {
    return null;
  }
  const parsed: IntegrationDiscoveryDataClass[] = [];
  for (const value of raw) {
    if (!isDataClass(value) || parsed.includes(value)) return null;
    parsed.push(value);
  }
  const ordered = orderedDataClasses(parsed);
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== ordered[index]) return null;
  }
  return parsed;
}

function orderedDataClasses(
  values: Iterable<IntegrationDiscoveryDataClass>,
): readonly IntegrationDiscoveryDataClass[] {
  const present = new Set(values);
  const ordered: IntegrationDiscoveryDataClass[] = [];
  for (const value of DATA_CLASS_ORDER) {
    if (present.has(value)) ordered.push(value);
  }
  return ordered;
}

function compareProjectedAccounts(
  left: ProjectedDiscoveryAccount,
  right: ProjectedDiscoveryAccount,
): number {
  return compareDiscoveryAccounts(left.view, right.view);
}

function compareDiscoveryAccounts(
  left: IntegrationDiscoveryAccount,
  right: IntegrationDiscoveryAccount,
): number {
  const provider = left.provider.localeCompare(right.provider);
  if (provider !== 0) return provider;
  const displayName = left.displayName.localeCompare(right.displayName);
  return displayName !== 0
    ? displayName
    : left.accountRef.localeCompare(right.accountRef);
}

function boundedDisplayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 160);
}

function discoveryDisplayName(
  provider: ActiveIntegrationProvider,
  value: string,
): string {
  const displayName = boundedDisplayName(value);
  return EMAIL_DISPLAY_NAME_PATTERN.test(displayName)
    ? discoveryProviderDisplayName(provider)
    : displayName;
}

function discoveryProviderDisplayName(
  provider: ActiveIntegrationProvider,
): string {
  switch (provider) {
    case "airtable":
      return "Airtable";
    case "dropbox":
      return "Dropbox";
    case "gmail":
      return "Gmail";
    case "google_drive":
      return "Google Drive";
    case "notion":
      return "Notion";
    case "shopify":
      return "Shopify";
    case "slack":
      return "Slack";
    case "square":
      return "Square";
    case "stripe":
      return "Stripe";
    case "whatsapp":
      return "WhatsApp";
    default:
      return assertNever(provider);
  }
}

function isDiscoveryProvider(
  value: unknown,
): value is IntegrationDiscoveryProvider {
  return typeof value === "string" && Object.hasOwn(DISCOVERY_PROVIDERS, value);
}

function isDiscoveryConnection(
  value: unknown,
): value is IntegrationDiscoveryConnection {
  return (
    value === "available" ||
    value === "attention_required" ||
    value === "unavailable"
  );
}

function isDataClass(value: unknown): value is IntegrationDiscoveryDataClass {
  return (
    value === "commerce" ||
    value === "payments" ||
    value === "records" ||
    value === "files" ||
    value === "mail" ||
    value === "messaging"
  );
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function unavailable(
  stage: DiscoveryStage,
): Result<never, IntegrationDiscoveryError> {
  return {
    ok: false,
    error: { code: "integration_discovery_unavailable", stage },
  };
}
