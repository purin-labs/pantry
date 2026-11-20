import {
  parseJevFeatureCommand,
  parseJevPaidUseCommand,
  type JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { assertNever } from "@purin-labs/std";
import { resolvePantryAccountBinding } from "../account-platform/binding";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import { readCaseContextDiscoveryPolicy } from "../case-context-discovery/evaluation-store";
import {
  caseContextDiscoveryRoute,
  type CaseContextDiscoveryPolicy,
} from "../case-context-discovery/policy";
import { listIntegrationAccounts } from "../data/integration-account";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import {
  currentTypeSafeAuthority,
  resolveTypeSafeCredential,
  sameTypeSafeAuthority,
} from "../integrations/typesafe/authority";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import type { PolicyJevPort } from "../actors/organisation/organisation-policy";
import {
  JEV_RELATED_CASES_LIMITS,
  jevAllowanceView,
  jevFreeUseCovers,
} from "./limits";
import {
  disableJevMailClassification,
  enableJevMailClassification,
  jevMailCoverage,
  repinJevMailClassification,
} from "./mail-switch";
import {
  ensureJevPaidHold,
  readJevPaidSpendMinor,
  readJevPaidUse,
  writeJevPaidUse,
} from "./paid-use";
import {
  readJevScreenRelevance,
  writeJevScreenRelevance,
} from "./screen-relevance";

type JevCommandInput = Readonly<{
  organisationId: OrganisationId;
  actorId: string;
  body: unknown;
}>;

/**
 * The RPC methods of the Jev settings on the Organisation actor (Plan 88).
 * The class of the Worker implements them: each method calls one function of
 * this module inside a command of the Organisation.
 */
export interface OrganisationJevRpc {
  /** Settings › AI features › Jev (Plan 88 section 2). */
  readJevFeatures(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<unknown>;
  /** Paid use above the free use (Plan 88 section 4). The route admits only the owner. */
  manageJevPaidUse(input: JevCommandInput): Promise<unknown>;
  manageJevFeature(input: JevCommandInput): Promise<unknown>;
}

/** What the Organisation actor gives to the Jev settings. */
export type OrganisationJevHost = Readonly<{
  env: Env;
  storage: DurableObjectStorage;
  /** Checks the Organisation record of this actor. */
  validateOrganisation(
    organisationId: OrganisationId,
  ): Result<unknown, { code: string }>;
  /** Publishes a Case context discovery policy, as the policy command does. */
  publishCaseContextDiscoveryConfiguration(
    input: JevCommandInput,
    scope: OrganisationExecutionScope,
  ): Promise<Result<unknown, { code: string }>>;
}>;

export async function readJevFeaturesForOrganisation(
  host: OrganisationJevHost,
  scope: OrganisationExecutionScope,
): Promise<Result<JevFeaturesView, { code: string }>> {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const sql = host.storage.sql;
  const authority = currentTypeSafeAuthority(sql, scope.organisationId);
  const credential = await resolveTypeSafeCredential({
    sql,
    db: scope.database,
    keys: host.env,
    organisationId: scope.organisationId,
  });
  const mailboxes = await jevMailCoverage({
    db: scope.database,
    organisationId: scope.organisationId,
    authority,
    now: Date.now(),
  });
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  const discovery = readCaseContextDiscoveryPolicy(
    sql,
    scope.organisationId,
  ).policy;
  const binding = await resolvePantryAccountBinding(
    host.env,
    scope.organisationId,
  );
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  // The owner approved the Jev price for every account (D9).
  const priced = binding.ok ? true : null;
  return {
    ok: true,
    value: {
      funding: authority.kind,
      keyAvailable:
        credential !== null &&
        sameTypeSafeAuthority(credential.authority, authority),
      mailClassification: {
        enabled: mailboxes.some((mailbox) => mailbox.covered),
        mailboxes: mailboxes.map((mailbox) => ({
          integrationAccountId: mailbox.integrationAccountId,
          displayName: mailbox.displayName,
          covered: mailbox.covered,
        })),
      },
      relatedCases: {
        enabled: discovery.mode !== "disabled",
        mode: discovery.mode === "disabled" ? null : discovery.mode,
        sourceCount:
          discovery.mode === "disabled" ? 0 : discovery.sources.length,
      },
      screenRelevance: {
        enabled: readJevScreenRelevance(sql, scope.organisationId),
      },
      allowance:
        authority.kind === "satyr_platform"
          ? jevAllowanceView(sql, scope.organisationId, Date.now())
          : null,
      paidUse: {
        ...readJevPaidUse(sql, scope.organisationId),
        spentMinor: readJevPaidSpendMinor(
          sql,
          scope.organisationId,
          Date.now(),
        ),
        priced,
      },
    },
  };
}

export async function manageJevPaidUseForOrganisation(
  host: OrganisationJevHost,
  input: Readonly<{
    organisationId: OrganisationId;
    actorId: string;
    body: unknown;
  }>,
  scope: OrganisationExecutionScope,
): Promise<Result<JevFeaturesView, { code: string }>> {
  const command = parseJevPaidUseCommand(input.body);
  if (command === null)
    return { ok: false, error: { code: "jev_paid_use_invalid" } };
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  host.storage.transactionSync(
    writeJevPaidUse.bind(null, host.storage.sql, {
      organisationId: scope.organisationId,
      enabled: command.enabled,
      spendingLimitMinor: command.spendingLimitMinor,
      actorId: input.actorId,
      now: Date.now(),
    }),
  );
  return readJevFeaturesForOrganisation(host, scope);
}

export async function manageJevFeatureForOrganisation(
  host: OrganisationJevHost,
  input: Readonly<{
    organisationId: OrganisationId;
    actorId: string;
    body: unknown;
  }>,
  scope: OrganisationExecutionScope,
): Promise<Result<JevFeaturesView, { code: string }>> {
  const command = parseJevFeatureCommand(input.body);
  if (command === null)
    return { ok: false, error: { code: "jev_feature_invalid" } };
  const sql = host.storage.sql;
  const authority = currentTypeSafeAuthority(sql, scope.organisationId);
  if (command.enabled) {
    const credential = await resolveTypeSafeCredential({
      sql,
      db: scope.database,
      keys: host.env,
      organisationId: scope.organisationId,
    });
    if (
      credential === null ||
      !sameTypeSafeAuthority(credential.authority, authority)
    )
      return { ok: false, error: { code: "jev_key_unavailable" } };
  }
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  const now = Date.now();
  switch (command.feature) {
    case "mail_classification":
      if (!command.enabled) {
        await disableJevMailClassification({
          db: scope.database,
          organisationId: scope.organisationId,
          now,
        });
        break;
      }
      if (
        (await enableJevMailClassification({
          db: scope.database,
          organisationId: scope.organisationId,
          authority,
          actorId: input.actorId,
          now,
        })) === 0
      )
        return {
          ok: false,
          error: { code: "jev_feature_source_unavailable" },
        };
      break;
    case "related_cases": {
      const head = readCaseContextDiscoveryPolicy(sql, scope.organisationId);
      let policy: CaseContextDiscoveryPolicy = { mode: "disabled" };
      if (command.enabled) {
        const sources = (
          await listIntegrationAccounts({
            db: scope.database,
            organisationId: scope.organisationId,
          })
        ).filter(
          (account) =>
            account.provider === "gmail" && account.lifecycle.kind === "active",
        );
        if (sources.length === 0)
          return {
            ok: false,
            error: { code: "jev_feature_source_unavailable" },
          };
        policy = {
          mode:
            command.mode ??
            (head.policy.mode === "shadow" ? "shadow" : "metadata_only"),
          route: caseContextDiscoveryRoute(authority),
          sources: sources.slice(0, 20).map((account) => ({
            source: "gmail" as const,
            integrationAccountId: account.integrationAccountId,
          })),
          limits: JEV_RELATED_CASES_LIMITS,
        };
      }
      const published = await host.publishCaseContextDiscoveryConfiguration(
        {
          organisationId: input.organisationId,
          actorId: input.actorId,
          body: {
            commandId: `jev-settings-${crypto.randomUUID()}`,
            expectedRevision: head.revision,
            policy,
          },
        },
        scope,
      );
      if (!published.ok) return published;
      break;
    }
    case "screen_relevance":
      host.storage.transactionSync(
        writeJevScreenRelevance.bind(null, sql, {
          organisationId: scope.organisationId,
          enabled: command.enabled,
          actorId: input.actorId,
          now,
        }),
      );
      break;
    default:
      assertNever(command);
  }
  return readJevFeaturesForOrganisation(host, scope);
}

/**
 * The Jev parts that two policy commands of the Organisation call: the repin
 * of mail classification after a change of the TypeSafe authority, and the
 * paid hold before a relationship evaluation.
 */
export const JEV_FOR_POLICY: PolicyJevPort = {
  repinMailClassification: repinJevMailClassification,
  ensurePaidHold: (input) =>
    ensureJevPaidHold({
      sql: input.sql,
      env: input.env,
      organisationId: input.organisationId,
      purpose: input.purpose,
      freeUseCovers: jevFreeUseCovers(
        input.sql,
        input.organisationId,
        input.reservationMicrousd,
        input.now,
      ),
      now: input.now,
    }),
};

function organisationPlacementConflict(): Result<
  never,
  { readonly code: "organisation_placement_conflict" }
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}
