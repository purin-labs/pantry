import { runtimeFetch } from "../../runtime-fetch";
import type { OrganisationPlacementBindings } from "../../organisation-execution-scope";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { listProviderResourcePage } from "../../data/provider-resource";
import {
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  SLACK_MESSAGE_RESOURCE_SCOPE,
} from "../../authorization/capability-catalogue";
import { discoverAirtableBases } from "../../external-records/records";
import { resolveAirtableAccountToken } from "../../external-records/oauth";
import { readActiveCaseOperations } from "../../actors/case-operations";
import { resolveIntegrationAccount } from "../../data/integration-account";
import type { Env } from "../../env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import { digestCanonical } from "../../policy";
import type { Result } from "../../result";
import { listPublishedCommerceTargets } from "../../commerce/entity-plane/published-resources";
import {
  readAccessControlOrganisationProjection,
  readAccessControlView,
} from "../../access-control/read-model";
import {
  opaqueCaseReference,
  opaqueSubjectReference,
} from "../../access-control/references";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import {
  handleAccessControlMutationRoute,
  type AccessControlMutationRoute,
} from "./access-control-mutations";
import {
  handleAccessControlExplainRoute,
  type AccessControlExplainRoute,
} from "./access-control-explain";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isPositiveInteger } from "@purin-labs/std";
import type { OnboardingControlRole } from "@purin-labs/contracts";
import {
  readIntegrationOptionRows,
  readSubjectOptionRows,
  type IntegrationOptionRow,
  type SubjectOptionRow,
} from "../../data/access-control-options";

const OPTIONS_PAGE_LIMIT = 50;
const OPTIONS_QUERY_LIMIT = 100;
const OPTIONS_CURSOR_LIMIT = 512;

export type AccessControlRoute =
  | Readonly<{ kind: "accessControl"; organisationIdRaw: string }>
  | Readonly<{ kind: "accessControlOptions"; organisationIdRaw: string }>
  | AccessControlExplainRoute
  | AccessControlMutationRoute;

type AggregateCursor = Readonly<{
  kind: "grants" | "sources";
  revision: number;
  offset: number;
}>;

type AggregateReadQuery = Readonly<{
  grantCursor: AggregateCursor | null;
  sourceCursor: AggregateCursor | null;
}>;

type OptionsReadQuery =
  | Readonly<{
      kind: "subjects";
      query: string;
      cursor: string | null;
    }>
  | Readonly<{
      kind: "cases";
      query: string;
      cursor: string | null;
    }>
  | Readonly<{
      kind: "resources";
      query: string;
      cursor: string | null;
      integrationAccountId: null;
    }>
  | Readonly<{
      kind: "resources";
      query: string;
      cursor: string | null;
      integrationAccountId: IntegrationAccountId;
    }>
  | Readonly<{
      kind: "commerce_targets";
      query: string;
      cursor: string | null;
    }>;

type AccessControlOption = Readonly<{
  kind:
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support"
    | "case"
    | "integration_account"
    | "provider_resource"
    | "commerce_target";
  refId: string;
  revision: number | null;
  label: string;
  detail: string;
  availability: "available" | "needs_attention" | "unavailable";
}>;

type OptionsPage = Readonly<{
  items: readonly AccessControlOption[];
  nextCursor: string | null;
}>;

type OptionsError = Readonly<{
  code: "access_control_options_invalid" | "access_control_options_unavailable";
  field: string;
}>;

export function matchAccessControlRoute(
  pathname: string,
): AccessControlRoute | null {
  const explain =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/explain$/u.exec(
      pathname,
    );
  if (explain !== null)
    return { kind: "accessControlExplain", organisationIdRaw: decode(explain[1]) };
  const grantRevoke =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/grants\/([^/]+)\/revoke$/u.exec(
      pathname,
    );
  if (grantRevoke !== null) {
    return {
      kind: "accessControlGrantRevoke",
      organisationIdRaw: decode(grantRevoke[1]),
      grantId: decode(grantRevoke[2]),
    };
  }
  const grants =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/grants$/u.exec(pathname);
  if (grants !== null)
    return { kind: "accessControlGrantCreate", organisationIdRaw: decode(grants[1]) };
  const capability =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/capabilities\/([^/]+)$/u.exec(
      pathname,
    );
  if (capability !== null) {
    return {
      kind: "accessControlCapabilityChange",
      organisationIdRaw: decode(capability[1]),
      capabilityId: decode(capability[2]),
    };
  }
  const defaults =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/defaults\/apply$/u.exec(
      pathname,
    );
  if (defaults !== null)
    return {
      kind: "accessControlDefaultsApply",
      organisationIdRaw: decode(defaults[1]),
    };
  const options =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/options$/u.exec(
      pathname,
    );
  if (options !== null)
    return { kind: "accessControlOptions", organisationIdRaw: decode(options[1]) };
  const budget =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/ai-budget$/u.exec(
      pathname,
    );
  if (budget !== null)
    return { kind: "accessControlBudget", organisationIdRaw: decode(budget[1]) };
  const aggregate = /^\/v1\/control\/organisations\/([^/]+)\/access-control$/u.exec(
    pathname,
  );
  return aggregate === null
    ? null
    : { kind: "accessControl", organisationIdRaw: decode(aggregate[1]) };
}

export async function handleAccessControlRoute(
  request: Request,
  env: Env,
  route: AccessControlRoute,
  url: URL,
): Promise<Response> {
  switch (route.kind) {
    case "accessControlExplain":
      return handleAccessControlExplainRoute(request, env, route);
    case "accessControlGrantCreate":
    case "accessControlBudget":
    case "accessControlGrantRevoke":
    case "accessControlCapabilityChange":
    case "accessControlDefaultsApply":
      return handleAccessControlMutationRoute(request, env, route);
  }
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  switch (route.kind) {
    case "accessControl":
      return handleAggregateRead(
        authorized.executionScope,
        authorized.membership.role,
        url.searchParams,
      );
    case "accessControlOptions":
      return handleOptionsRead(env, authorized.executionScope, url.searchParams);
    default:
      return assertNever(route);
  }
}

async function handleAggregateRead(
  scope: OrganisationExecutionScope,
  requesterRole: OnboardingControlRole,
  searchParams: URLSearchParams,
): Promise<Response> {
  const query = parseAggregateReadQuery(searchParams);
  if (!query.ok) return controlError(query.error, 422);
  const view = await readAccessControlView({
    db: scope.database,
    organisationId: scope.organisationId,
    requesterRole,
    grantOffset: query.value.grantCursor?.offset ?? 0,
    sourcePolicyOffset: query.value.sourceCursor?.offset ?? 0,
  });
  if (!view.ok) return controlError(view.error.code, 503);
  if (
    cursorIsStale(query.value.grantCursor, view.value.revision) ||
    cursorIsStale(query.value.sourceCursor, view.value.revision)
  ) {
    return controlError("access_control_cursor_stale", 409);
  }
  return controlJson({ ok: true, accessControl: view.value });
}

async function handleOptionsRead(
  env: Env,
  scope: OrganisationExecutionScope,
  searchParams: URLSearchParams,
): Promise<Response> {
  const organisationId = scope.organisationId;
  const query = parseOptionsReadQuery(searchParams);
  if (!query.ok) return controlError(query.error.code, 422);
  const organisation = await readAccessControlOrganisationProjection(
    scope.database,
    organisationId,
  );
  if (!organisation.ok) return controlError(organisation.error.code, 503);
  switch (query.value.kind) {
    case "subjects": {
      const page = await readSubjectOptions(
        scope.database,
        organisationId,
        organisation.value.projectionRevision,
        query.value,
      );
      return optionsPageResponse(page);
    }
    case "resources": {
      if (query.value.integrationAccountId === null) {
        const page = await readIntegrationOptions(
          scope.database,
          organisationId,
          organisation.value.projectionRevision,
          query.value,
        );
        return optionsPageResponse(page);
      }
      return readProviderResourceOptions(env, scope, query.value);
    }
    case "cases": {
      const page = await readCaseOptions(
        env,
        organisationId,
        organisation.value.projectionRevision,
        query.value,
      );
      return optionsPageResponse(page);
    }
    case "commerce_targets": {
      const page = await readCommerceTargetOptions(
        env,
        organisationId,
        organisation.value.projectionRevision,
        query.value,
      );
      return optionsPageResponse(page);
    }
    default:
      return assertNever(query.value);
  }
}

function parseAggregateReadQuery(
  searchParams: URLSearchParams,
): Result<AggregateReadQuery, "access_control_query_invalid"> {
  if (!hasExactSearchKeys(searchParams, ["grants_cursor", "sources_cursor"])) {
    return { ok: false, error: "access_control_query_invalid" };
  }
  const grantCursor = parseAggregateCursor(
    searchParams.get("grants_cursor"),
    "grants",
  );
  const sourceCursor = parseAggregateCursor(
    searchParams.get("sources_cursor"),
    "sources",
  );
  return grantCursor === undefined || sourceCursor === undefined
    ? { ok: false, error: "access_control_query_invalid" }
    : { ok: true, value: { grantCursor, sourceCursor } };
}

function parseAggregateCursor(
  value: string | null,
  expectedKind: AggregateCursor["kind"],
): AggregateCursor | null | undefined {
  if (value === null) return null;
  const match = /^access_(grants|sources)_([1-9][0-9]*)_([1-9][0-9]*)$/u.exec(
    value,
  );
  if (match === null || match[1] !== expectedKind) return undefined;
  const revision = Number(match[2]);
  const offset = Number(match[3]);
  return isPositiveInteger(revision) && isPositiveInteger(offset)
    ? { kind: expectedKind, revision, offset }
    : undefined;
}

function cursorIsStale(
  cursor: AggregateCursor | null,
  revision: number,
): boolean {
  return cursor !== null && cursor.revision !== revision;
}

function parseOptionsReadQuery(
  searchParams: URLSearchParams,
): Result<OptionsReadQuery, OptionsError> {
  const kindValues = searchParams.getAll("kind");
  if (kindValues.length !== 1) return invalidOptions("kind");
  const query = normalizeOptionsQuery(searchParams.get("query"));
  if (query === null) return invalidOptions("query");
  const cursor = optionalBoundedValue(
    searchParams,
    "cursor",
    OPTIONS_CURSOR_LIMIT,
  );
  if (cursor === undefined) return invalidOptions("cursor");
  switch (kindValues[0]) {
    case "subjects":
      return hasExactSearchKeys(searchParams, ["kind", "query", "cursor"])
        ? { ok: true, value: { kind: "subjects", query, cursor } }
        : invalidOptions("query");
    case "cases":
      return hasExactSearchKeys(searchParams, ["kind", "query", "cursor"])
        ? { ok: true, value: { kind: "cases", query, cursor } }
        : invalidOptions("query");
    case "resources": {
      if (
        !hasExactSearchKeys(searchParams, [
          "kind",
          "query",
          "cursor",
          "integration_ref",
        ])
      ) {
        return invalidOptions("query");
      }
      const integrationRef = optionalBoundedValue(
        searchParams,
        "integration_ref",
        300,
      );
      if (integrationRef === undefined)
        return invalidOptions("integration_ref");
      if (integrationRef === null) {
        return {
          ok: true,
          value: {
            kind: "resources",
            query,
            cursor,
            integrationAccountId: null,
          },
        };
      }
      const integrationAccountId = parseIntegrationReference(integrationRef);
      return integrationAccountId === null
        ? invalidOptions("integration_ref")
        : {
            ok: true,
            value: { kind: "resources", query, cursor, integrationAccountId },
          };
    }
    case "commerce_targets":
      return hasExactSearchKeys(searchParams, ["kind", "query", "cursor"])
        ? { ok: true, value: { kind: "commerce_targets", query, cursor } }
        : invalidOptions("query");
    default:
      return invalidOptions("kind");
  }
}

function normalizeOptionsQuery(value: string | null): string | null {
  if (value === null) return "";
  const normalized = value.trim().toLowerCase();
  return normalized.length <= OPTIONS_QUERY_LIMIT ? normalized : null;
}

function optionalBoundedValue(
  searchParams: URLSearchParams,
  key: string,
  limit: number,
): string | null | undefined {
  const values = searchParams.getAll(key);
  if (values.length === 0) return null;
  if (values.length !== 1) return undefined;
  const value = values[0];
  return value !== undefined &&
    value.length > 0 &&
    value.length <= limit &&
    value === value.trim()
    ? value
    : undefined;
}

function hasExactSearchKeys(
  searchParams: URLSearchParams,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key) || searchParams.getAll(key).length !== 1)
      return false;
  }
  return true;
}

async function readSubjectOptions(
  db: D1Database,
  organisationId: OrganisationId,
  revision: number,
  query: Variant<OptionsReadQuery, "subjects">,
): Promise<Result<OptionsPage, OptionsError>> {
  const cursor = await optionsCursorOffset(
    query.cursor,
    "subjects",
    revision,
    query.query,
  );
  if (!cursor.ok) return cursor;
  try {
    const rows = await readSubjectOptionRows(db, {
      organisationId,
      query: query.query,
      limit: OPTIONS_PAGE_LIMIT + 1,
      offset: cursor.value,
    });
    const parsed = await parseSubjectOptionRows(organisationId, rows);
    if (!parsed.ok) return parsed;
    return buildOptionsPage(
      parsed.value,
      "subjects",
      revision,
      query.query,
      cursor.value,
    );
  } catch {
    return unavailableOptions("subjects");
  }
}

async function parseSubjectOptionRows(
  organisationId: OrganisationId,
  rows: readonly SubjectOptionRow[],
): Promise<Result<readonly AccessControlOption[], OptionsError>> {
  const options: AccessControlOption[] = [];
  for (const row of rows) {
    const parsed = parseSubjectOptionRow(row);
    if (!parsed.ok) return parsed;
    options.push({
      kind: parsed.value.kind,
      refId: await opaqueSubjectReference(
        organisationId,
        subjectReferenceInput(parsed.value),
      ),
      revision: parsed.value.revision,
      label: parsed.value.label,
      detail: subjectOptionDetail(parsed.value.kind),
      availability: "available",
    });
  }
  return { ok: true, value: options };
}

function subjectReferenceInput(
  value: Readonly<{
    kind:
      | "organisation_role"
      | "person"
      | "conversation"
      | "workflow"
      | "agent_mailbox"
      | "whatsapp_support";
    firstId: string;
    secondId: string | null;
    revision: number;
  }>,
): Readonly<{
  kind:
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support";
  firstId: string;
  secondId: string | null;
  revision: number;
}> {
  return {
    kind: value.kind,
    firstId: value.firstId,
    secondId: value.secondId,
    revision: value.revision,
  };
}

function parseSubjectOptionRow(row: SubjectOptionRow): Result<
  Readonly<{
    kind:
      | "organisation_role"
      | "person"
      | "conversation"
      | "workflow"
      | "agent_mailbox"
      | "whatsapp_support";
    firstId: string;
    secondId: string | null;
    revision: number;
    label: string;
  }>,
  OptionsError
> {
  if (
    !isSubjectOptionKind(row.kind) ||
    !boundedText(row.firstId, 512) ||
    (row.secondId !== null && !boundedText(row.secondId, 512)) ||
    !isPositiveInteger(row.revision) ||
    !boundedText(row.label, 200)
  ) {
    return unavailableOptions("subjects.row");
  }
  if (subjectOptionRequiresSecondId(row.kind) !== (row.secondId !== null)) {
    return unavailableOptions("subjects.row");
  }
  return {
    ok: true,
    value: {
      kind: row.kind,
      firstId: row.firstId,
      secondId: row.secondId,
      revision: row.revision,
      label: row.label,
    },
  };
}

function isSubjectOptionKind(
  value: unknown,
): value is Extract<
  AccessControlOption["kind"],
  | "organisation_role"
  | "person"
  | "conversation"
  | "workflow"
  | "agent_mailbox"
  | "whatsapp_support"
> {
  return (
    value === "organisation_role" ||
    value === "person" ||
    value === "conversation" ||
    value === "workflow" ||
    value === "agent_mailbox" ||
    value === "whatsapp_support"
  );
}

function subjectOptionRequiresSecondId(
  kind: Extract<
    AccessControlOption["kind"],
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support"
  >,
): boolean {
  return (
    kind === "conversation" ||
    kind === "agent_mailbox" ||
    kind === "whatsapp_support"
  );
}

function subjectOptionDetail(
  kind: Extract<
    AccessControlOption["kind"],
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support"
  >,
): string {
  switch (kind) {
    case "organisation_role":
      return "Workspace role";
    case "person":
      return "Workspace member";
    case "conversation":
      return "Conversation";
    case "workflow":
      return "Automation";
    case "agent_mailbox":
      return "Agent mailbox";
    case "whatsapp_support":
      return "WhatsApp support";
    default:
      return assertNever(kind);
  }
}

async function readIntegrationOptions(
  db: D1Database,
  organisationId: OrganisationId,
  revision: number,
  query: Extract<
    OptionsReadQuery,
    { kind: "resources"; integrationAccountId: null }
  >,
): Promise<Result<OptionsPage, OptionsError>> {
  const cursor = await optionsCursorOffset(
    query.cursor,
    "resources",
    revision,
    query.query,
  );
  if (!cursor.ok) return cursor;
  try {
    const rows = await readIntegrationOptionRows(db, {
      organisationId,
      query: query.query,
      limit: OPTIONS_PAGE_LIMIT + 1,
      offset: cursor.value,
    });
    const parsed = parseIntegrationOptionRows(rows);
    if (!parsed.ok) return parsed;
    return buildOptionsPage(
      parsed.value,
      "resources",
      revision,
      query.query,
      cursor.value,
    );
  } catch {
    return unavailableOptions("resources");
  }
}

async function readCaseOptions(
  env: OrganisationPlacementBindings & Pick<Env, "CASE">,
  organisationId: OrganisationId,
  revision: number,
  query: Variant<OptionsReadQuery, "cases">,
): Promise<Result<OptionsPage, OptionsError>> {
  const cursor = await optionsCursorOffset(
    query.cursor,
    "cases",
    revision,
    query.query,
  );
  if (!cursor.ok) return cursor;
  const currentCases = await readActiveCaseOperations({
    env,
    organisationId,
    now: Date.now(),
  });
  if (!currentCases.ok) return unavailableOptions("cases");
  const options: AccessControlOption[] = [];
  for (const currentCase of currentCases.value) {
    const caseId = parseCaseId(currentCase.caseId);
    if (!caseId.ok) return unavailableOptions("cases.row");
    const refId = await opaqueCaseReference(organisationId, caseId.value);
    const label = caseOptionLabel(refId);
    if (query.query.length > 0 && !label.toLowerCase().includes(query.query))
      continue;
    options.push({
      kind: "case",
      refId,
      revision: currentCase.revision,
      label,
      detail: `Current Case · ${currentCase.lifecycle.replaceAll("_", " ")}`,
      availability: "available",
    });
  }
  return buildOptionsPage(
    options.slice(cursor.value),
    "cases",
    revision,
    query.query,
    cursor.value,
  );
}

async function readCommerceTargetOptions(
  env: Env,
  organisationId: OrganisationId,
  revision: number,
  query: Variant<OptionsReadQuery, "commerce_targets">,
): Promise<Result<OptionsPage, OptionsError>> {
  const cursor = await optionsCursorOffset(
    query.cursor,
    "commerce_targets",
    revision,
    query.query,
  );
  if (!cursor.ok) return cursor;
  const targets = await listPublishedCommerceTargets({
    env,
    organisationId,
  });
  if (!targets.ok) return unavailableOptions("commerce_targets");
  const options: AccessControlOption[] = [];
  for (const target of targets.value) {
    if (
      query.query.length > 0 &&
      !target.label.toLowerCase().includes(query.query)
    )
      continue;
    options.push({
      kind: "commerce_target",
      refId: target.targetRef.targetRefId,
      revision: target.targetRef.revision,
      label: target.label,
      detail: target.detail,
      availability: "available",
    });
  }
  return buildOptionsPage(
    options,
    "commerce_targets",
    revision,
    query.query,
    cursor.value,
  );
}

function caseOptionLabel(caseRefId: string): string {
  return `Current Case ${caseRefId.slice(-6).toUpperCase()}`;
}

function parseIntegrationOptionRows(
  rows: readonly IntegrationOptionRow[],
): Result<readonly AccessControlOption[], OptionsError> {
  const options: AccessControlOption[] = [];
  for (const row of rows) {
    if (
      !boundedText(row.integrationAccountId, 256) ||
      !boundedText(row.label, 200) ||
      !boundedText(row.provider, 100) ||
      !isIntegrationLifecycle(row.lifecycle)
    ) {
      return unavailableOptions("resources.row");
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    if (!integrationAccountId.ok) return unavailableOptions("resources.row");
    options.push({
      kind: "integration_account",
      refId: integrationReference(integrationAccountId.value),
      revision: null,
      label: row.label,
      detail: providerLabel(row.provider),
      availability: optionIntegrationAvailability(row.lifecycle),
    });
  }
  return { ok: true, value: options };
}

async function readProviderResourceOptions(
  env: Env,
  scope: OrganisationExecutionScope,
  query: Extract<
    OptionsReadQuery,
    { kind: "resources"; integrationAccountId: IntegrationAccountId }
  >,
): Promise<Response> {
  const organisationId = scope.organisationId;
  const account = await resolveIntegrationAccount({
    db: scope.database,
    organisationId,
    integrationAccountId: query.integrationAccountId,
  });
  if (!account.ok) return controlError("access_control_option_not_found", 404);
  if (account.value.lifecycle.kind !== "active")
    return controlError("access_control_option_unavailable", 409);
  if (account.value.provider === "airtable") {
    try {
      const credential = await resolveAirtableAccountToken(
        env,
        organisationId,
        query.integrationAccountId,
        "read",
      );
      const bases = await discoverAirtableBases(credential, runtimeFetch);
      if (!bases.ok) return controlError(bases.error.code, 503);
      const items: AccessControlOption[] = [];
      for (const base of bases.value) {
        if (
          query.query.length > 0 &&
          !base.label.toLowerCase().includes(query.query)
        )
          continue;
        items.push({
          kind: "provider_resource",
          refId: `provider_resource:${base.scope}`,
          revision: null,
          label: base.label,
          detail: "Airtable base · includes new tables",
          availability: "available",
        });
      }
      return controlJson({ ok: true, options: { items, nextCursor: null } });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "airtable.discovery_failed",
          organisationId,
          integrationAccountId: query.integrationAccountId,
          errorType: error instanceof Error ? error.name : "unknown",
          frames:
            error instanceof Error ? error.stack?.split("\n").slice(1, 4) : [],
        }),
      );
      return controlError("access_control_option_unavailable", 503);
    }
  }
  const page = await listProviderResourcePage({
    db: scope.database,
    organisationId,
    integrationAccountId: query.integrationAccountId,
    query: query.query,
    cursor: query.cursor,
    now: Date.now(),
  });
  if (!page.ok) {
    return controlError(
      page.error.code,
      page.error.code === "provider_resource_query_invalid" ? 422 : 404,
    );
  }
  const items: AccessControlOption[] = [];
  for (const resource of page.value.resources) {
    items.push({
      kind: "provider_resource",
      refId: `provider_resource:${resource.canonical_resource_id}`,
      revision: null,
      label: resource.display_label,
      detail: resource.resource_kind,
      availability:
        resource.access_state === "accessible" ? "available" : "unavailable",
    });
  }
  if (
    account.value.provider === "slack" &&
    query.cursor === null &&
    (query.query.length === 0 ||
      "slack message drafts connected channels".includes(query.query))
  ) {
    items.push({
      kind: "provider_resource",
      refId: `provider_resource:${SLACK_MESSAGE_RESOURCE_SCOPE}`,
      revision: null,
      label: "Slack message drafts",
      detail: "Connected channels · a person sends each message",
      availability: "available",
    });
  }
  if (
    account.value.provider === "gmail" &&
    query.cursor === null &&
    (query.query.length === 0 ||
      "operational email proposals".includes(query.query))
  ) {
    items.push({
      kind: "provider_resource",
      refId: `provider_resource:${EMAIL_OPERATIONAL_RESOURCE_SCOPE}`,
      revision: null,
      label: "Operational email proposals",
      detail: "Approval required before sending",
      availability: "available",
    });
  }
  return controlJson({
    ok: true,
    options: {
      items,
      nextCursor:
        page.value.next_cursor === "end" ? null : page.value.next_cursor,
    },
  });
}

async function buildOptionsPage(
  items: readonly AccessControlOption[],
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  revision: number,
  query: string,
  offset: number,
): Promise<Result<OptionsPage, OptionsError>> {
  const hasMore = items.length > OPTIONS_PAGE_LIMIT;
  const pageItems = hasMore ? items.slice(0, OPTIONS_PAGE_LIMIT) : items;
  return {
    ok: true,
    value: {
      items: pageItems,
      nextCursor: hasMore
        ? await createOptionsCursor(
            kind,
            revision,
            offset + OPTIONS_PAGE_LIMIT,
            query,
          )
        : null,
    },
  };
}

async function optionsCursorOffset(
  cursor: string | null,
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  revision: number,
  query: string,
): Promise<Result<number, OptionsError>> {
  if (cursor === null) return { ok: true, value: 0 };
  const match =
    /^access_options_(subjects|resources|cases|commerce_targets)_([1-9][0-9]*)_([1-9][0-9]*)_([a-f0-9]{16})$/u.exec(
      cursor,
    );
  if (match === null || match[1] !== kind) return invalidOptions("cursor");
  const cursorRevision = Number(match[2]);
  const offset = Number(match[3]);
  if (!isPositiveInteger(cursorRevision) || !isPositiveInteger(offset))
    return invalidOptions("cursor");
  const expectedDigest = await optionsQueryDigest(kind, query);
  return cursorRevision === revision && match[4] === expectedDigest
    ? { ok: true, value: offset }
    : invalidOptions("cursor");
}

async function createOptionsCursor(
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  revision: number,
  offset: number,
  query: string,
): Promise<string> {
  return `access_options_${kind}_${revision}_${offset}_${await optionsQueryDigest(kind, query)}`;
}

async function optionsQueryDigest(
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  query: string,
): Promise<string> {
  return (await digestCanonical({ kind, query })).slice(0, 16);
}

function optionsPageResponse(
  page: Result<OptionsPage, OptionsError>,
): Response {
  return page.ok
    ? controlJson({ ok: true, options: page.value })
    : controlError(
        page.error.code,
        page.error.code === "access_control_options_invalid" ? 422 : 503,
      );
}

function integrationReference(integrationAccountId: string): string {
  return `integration:${integrationAccountId}`;
}

function parseIntegrationReference(value: string): IntegrationAccountId | null {
  if (!value.startsWith("integration:")) return null;
  const parsed = parseIntegrationAccountId(value.slice("integration:".length));
  return parsed.ok ? parsed.value : null;
}

function isIntegrationLifecycle(
  value: unknown,
): value is
  | "connecting"
  | "pending_activation"
  | "active"
  | "degraded"
  | "reauth_required"
  | "disabled"
  | "revoked" {
  return (
    value === "connecting" ||
    value === "pending_activation" ||
    value === "active" ||
    value === "degraded" ||
    value === "reauth_required" ||
    value === "disabled" ||
    value === "revoked"
  );
}

function optionIntegrationAvailability(
  lifecycle:
    | "connecting"
    | "pending_activation"
    | "active"
    | "degraded"
    | "reauth_required"
    | "disabled"
    | "revoked",
): AccessControlOption["availability"] {
  switch (lifecycle) {
    case "active":
      return "available";
    case "connecting":
    case "pending_activation":
    case "degraded":
    case "reauth_required":
      return "needs_attention";
    case "disabled":
    case "revoked":
      return "unavailable";
    default:
      return assertNever(lifecycle);
  }
}

function providerLabel(provider: string): string {
  return provider.split("_").join(" ");
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    value === value.trim()
  );
}

function invalidOptions(field: string): Result<never, OptionsError> {
  return {
    ok: false,
    error: { code: "access_control_options_invalid", field },
  };
}

function unavailableOptions(field: string): Result<never, OptionsError> {
  return {
    ok: false,
    error: { code: "access_control_options_unavailable", field },
  };
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Access-control route capture is missing");
  return decodeURIComponent(value);
}
