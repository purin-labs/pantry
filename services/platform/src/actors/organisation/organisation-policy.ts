import { runtimeFetch } from "../../runtime-fetch";
import { resolveCaseContextCollectionSelectionVerification } from "../../case-context-discovery/source";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actor-execution-quiescence";
import { newRequestId, parseCaseId, type OrganisationId } from "../../ids";
import { traceLog, traceWarn } from "../../observability";
import {
  isOrganisationPolicyPlacementActive,
  parseOrganisationPolicySnapshot,
} from "../../policy-snapshot";
import type { Result } from "../../result";
import {
  publishCaseContextDiscoveryPolicy,
  repinCaseContextDiscoveryPolicy,
  readCaseContextDiscoveryPolicy,
} from "../../case-context-discovery/evaluation-store";
import {
  commitCaseContextCollectionEffectFence,
  evidenceForCaseContextCollection,
  eraseCaseContextCollectionSource,
  parseCaseContextCollectionEffectAttempt,
  parseCaseContextCollectionEvidenceDependency,
  validateCaseContextCollectionEvidence,
  replayCaseContextCollectionEffectFence,
  invalidateCaseContextCollectionVerification,
} from "../../case-context-discovery/evidence";
import {
  readTypeSafeConnection,
  mutateTypeSafeConnection,
} from "../../integrations/typesafe/connection";
import {
  currentTypeSafeAuthority,
  resolvePantryTypeSafeKey,
  resolveTypeSafeCredential,
  sameTypeSafeAuthority,
} from "../../integrations/typesafe/authority";
import {
  decideCaseContextCollectionRelationship,
  listCaseContextCollectionIdsForCase,
  listMemberCaseContextCollectionIdsForCase,
  parseCaseContextCollectionReviewCommand,
  parseCaseContextCollectionSelection,
  readCaseContextCollection,
  replayCaseContextCollectionRelationshipCommand,
  type CaseContextCollection,
} from "../../case-context-discovery/relationships";
import { evaluateOperationalCaseContextDiscovery } from "../../case-context-discovery/operational-evaluation";
import {
  caseContextDiscoveryReadiness,
  caseContextDiscoveryRoute,
  caseContextDiscoveryRouteAuthority,
  parseCaseContextDiscoveryPolicy,
  type CaseContextDiscoveryPolicy,
  identifier,
  integerIn,
} from "../../case-context-discovery/policy";
import { digestCanonical } from "../../policy/information-flow/digest";
import {
  parseJevFeatureCommand,
  parseJevPaidUseCommand,
  type JevFeaturesView,
} from "@seams/control-api/portal/jev-features";
import {
  disableJevMailClassification,
  enableJevMailClassification,
  jevMailCoverage,
  repinJevMailClassification,
} from "../../jev-features/mail-switch";
import {
  readJevScreenRelevance,
  writeJevScreenRelevance,
} from "../../jev-features/screen-relevance";
import {
  JEV_RELATED_CASES_LIMITS,
  jevAllowanceView,
  jevFreeUseCovers,
} from "../../jev-features/limits";
import {
  ensureJevPaidHold,
  readJevPaidSpendMinor,
  readJevPaidUse,
  writeJevPaidUse,
} from "../../jev-features/paid-use";
import { resolvePantryAccountBinding } from "../../account-platform/binding";
import { listIntegrationAccounts } from "../../data/integration-account";
import { assertNever, errorMessage, isRecord, sha256Hex } from "@seams/std";
import {
  caseContextCollectionReviewDecision,
  caseContextCollectionSourceAccess,
  parseOperationalCaseContextDiscoverySourceRequest,
  unsupportedCaseContextCollectionReplySource,
  verifiedOperationalCaseContextDiscoveryRequest,
} from "./case-context-collection";
import { schemaTransaction } from "./schema";
import {
  existingPolicyActivation,
  organisationPlacementConflict,
  readOrganisationMetaRow,
  readOrganisationPolicyHead,
  validateActionOrganisation,
} from "./support";
import type {
  OrganisationActivatePolicyInput,
  OrganisationPolicyActivation,
  OrganisationPolicyActivationError,
  OrganisationPolicyHead,
} from "./types";
import { OrganisationActorBase } from "./organisation-actor-base";

/**
 * Policy activation, credentials, TypeSafe and Case context discovery for the Organisation.
 */
export abstract class OrganisationPolicy extends OrganisationActorBase {
  async readCaseContextDiscoveryConfiguration(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCaseContextDiscoveryConfiguration.bind(this),
    );
  }

  protected async admittedReadCaseContextDiscoveryConfiguration(
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const head = readCaseContextDiscoveryPolicy(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    return {
      ok: true as const,
      value: {
        revision: head.revision,
        policy: head.policy,
        rollout: "operational_shadow_and_admin_metadata_review" as const,
      },
    };
  }

  async readTypeSafeConnectionConfiguration(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadTypeSafeConnectionConfiguration.bind(this),
    );
  }

  protected async admittedReadTypeSafeConnectionConfiguration(
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const credential = await resolveTypeSafeCredential({
      sql: this.ctx.storage.sql,
      db: scope.database,
      keys: this.env,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const connection = readTypeSafeConnection(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    const authority = currentTypeSafeAuthority(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    const resolved =
      credential !== null &&
      sameTypeSafeAuthority(credential.authority, authority);
    return {
      ok: true as const,
      value: {
        connection,
        credentialConfigured:
          connection.kind === "connected" &&
          resolved &&
          authority.kind === "organisation_byo",
        /** The authority that a new Jev call uses, or null when its key is missing. */
        authority: resolved ? authority : null,
      },
    };
  }

  async manageTypeSafeConnection(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedManageTypeSafeConnection.bind(this, input),
    );
  }

  protected async admittedManageTypeSafeConnection(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const before = currentTypeSafeAuthority(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    try {
      return await mutateTypeSafeConnection({
        sql: this.ctx.storage.sql,
        transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
        keys: this.env,
        scope,
        actorId: input.actorId,
        body: input.body,
        fetcher: runtimeFetch,
        now: Date.now,
      });
    } finally {
      const head = readCaseContextDiscoveryPolicy(
        this.ctx.storage.sql,
        scope.organisationId,
      );
      const authority = currentTypeSafeAuthority(
        this.ctx.storage.sql,
        scope.organisationId,
      );
      if (
        head.policy.mode !== "disabled" &&
        !sameTypeSafeAuthority(
          authority,
          caseContextDiscoveryRouteAuthority(head.policy.route),
        )
      ) {
        this.ctx.storage.transactionSync(
          repinCaseContextDiscoveryPolicy.bind(
            null,
            this.ctx.storage.sql,
            scope.organisationId,
            head.revision,
            authority,
            Date.now(),
          ),
        );
      }
      if (!sameTypeSafeAuthority(before, authority)) {
        // Each mailbox that was on stays on under the new authority.
        try {
          await repinJevMailClassification({
            db: scope.database,
            organisationId: scope.organisationId,
            from: before,
            to: authority,
            now: Date.now(),
          });
        } catch (error) {
          traceWarn("organisation.jev_mail_repin_failed", {
            requestId: newRequestId(),
            organisationId: scope.organisationId,
            detail: errorMessage(error),
          });
        }
      }
      await this.rearm();
    }
  }

  /** Settings › AI features › Jev (Plan 88 section 2). */
  async readJevFeatures(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadJevFeatures.bind(this),
    );
  }

  protected async admittedReadJevFeatures(
    scope: OrganisationExecutionScope,
  ): Promise<Result<JevFeaturesView, { code: string }>> {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const sql = this.ctx.storage.sql;
    const authority = currentTypeSafeAuthority(sql, scope.organisationId);
    const credential = await resolveTypeSafeCredential({
      sql,
      db: scope.database,
      keys: this.env,
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
      this.env,
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
          spentMinor: readJevPaidSpendMinor(sql, scope.organisationId, Date.now()),
          priced,
        },
      },
    };
  }

  /** Paid use above the free use (Plan 88 section 4). The route admits only the owner. */
  async manageJevPaidUse(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedManageJevPaidUse.bind(this, input),
    );
  }

  protected async admittedManageJevPaidUse(
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
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    this.ctx.storage.transactionSync(
      writeJevPaidUse.bind(null, this.ctx.storage.sql, {
        organisationId: scope.organisationId,
        enabled: command.enabled,
        spendingLimitMinor: command.spendingLimitMinor,
        actorId: input.actorId,
        now: Date.now(),
      }),
    );
    return this.admittedReadJevFeatures(scope);
  }

  async manageJevFeature(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedManageJevFeature.bind(this, input),
    );
  }

  protected async admittedManageJevFeature(
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
    const sql = this.ctx.storage.sql;
    const authority = currentTypeSafeAuthority(sql, scope.organisationId);
    if (command.enabled) {
      const credential = await resolveTypeSafeCredential({
        sql,
        db: scope.database,
        keys: this.env,
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
          return { ok: false, error: { code: "jev_feature_source_unavailable" } };
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
              account.provider === "gmail" &&
              account.lifecycle.kind === "active",
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
        const published =
          await this.admittedPublishCaseContextDiscoveryConfiguration(
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
        this.ctx.storage.transactionSync(
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
    return this.admittedReadJevFeatures(scope);
  }

  async readCaseContextDiscoverySourceReadiness(
    input: Readonly<{
      organisationId: OrganisationId;
      source: "gmail" | "whatsapp" | "commerce";
      integrationAccountId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCaseContextDiscoverySourceReadiness.bind(this, input),
    );
  }

  protected async admittedReadCaseContextDiscoverySourceReadiness(
    input: Readonly<{
      organisationId: OrganisationId;
      source: "gmail" | "whatsapp" | "commerce";
      integrationAccountId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const credential = await resolveTypeSafeCredential({
      sql: this.ctx.storage.sql,
      db: scope.database,
      keys: this.env,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const readiness = caseContextDiscoveryReadiness({
      policy: readCaseContextDiscoveryPolicy(
        this.ctx.storage.sql,
        scope.organisationId,
      ).policy,
      credential,
      source: input.source,
      integrationAccountId: input.integrationAccountId,
    });
    return {
      ok: true as const,
      value: readiness,
    };
  }

  async publishCaseContextDiscoveryConfiguration(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedPublishCaseContextDiscoveryConfiguration.bind(this, input),
    );
  }

  protected async admittedPublishCaseContextDiscoveryConfiguration(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const body = input.body;
    if (
      !isRecord(body) ||
      Object.keys(body).length !== 3 ||
      !identifier(body.commandId) ||
      !integerIn(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
    ) {
      return {
        ok: false as const,
        error: { code: "case_context_discovery_policy_invalid" as const },
      };
    }
    const policy = parseCaseContextDiscoveryPolicy(body.policy);
    if (!policy.ok) return policy;
    if (
      policy.value.mode === "party_context" &&
      policy.value.sources.some(unsupportedCaseContextCollectionReplySource)
    ) {
      return {
        ok: false as const,
        error: {
          code: "case_context_discovery_activation_unavailable" as const,
        },
      };
    }
    const requestDigest = await digestCanonical({
      actorId: input.actorId,
      expectedRevision: body.expectedRevision,
      policy: policy.value,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    if (policy.value.mode !== "disabled") {
      const authority = currentTypeSafeAuthority(
        this.ctx.storage.sql,
        scope.organisationId,
      );
      if (
        !sameTypeSafeAuthority(
          authority,
          caseContextDiscoveryRouteAuthority(policy.value.route),
        ) ||
        (authority.kind === "satyr_platform" &&
          resolvePantryTypeSafeKey(this.env) === null)
      ) {
        return {
          ok: false as const,
          error: {
            code: "case_context_discovery_activation_unavailable" as const,
          },
        };
      }
      if (policy.value.mode === "party_context") {
        for (const source of policy.value.sources) {
          const access = await caseContextCollectionSourceAccess(
            scope,
            this.ctx.storage.sql,
            source.integrationAccountId,
          );
          if (
            !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
          )
            return organisationPlacementConflict();
          if (!access.ok)
            return {
              ok: false as const,
              error: {
                code: "case_context_discovery_activation_unavailable" as const,
              },
            };
        }
      }
    }
    const result = publishCaseContextDiscoveryPolicy({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      commandId: body.commandId,
      requestDigest,
      expectedRevision: body.expectedRevision,
      policy: policy.value,
      actorId: input.actorId,
      now: Date.now(),
    });
    await this.rearm();
    return result;
  }

  async evaluateCaseContextDiscovery(
    input: Readonly<{
      organisationId: OrganisationId;
      request: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedEvaluateCaseContextDiscovery.bind(this, input),
    );
  }

  protected async admittedEvaluateCaseContextDiscovery(
    input: Readonly<{ organisationId: OrganisationId; request: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const request = parseOperationalCaseContextDiscoverySourceRequest(
      input.request,
    );
    if (request === null) {
      return {
        ok: false as const,
        error: { code: "case_context_discovery_evaluation_invalid" as const },
      };
    }
    const scoped = await verifiedOperationalCaseContextDiscoveryRequest({
      scope,
      sql: this.ctx.storage.sql,
      request,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return {
        ok: false as const,
        error: { code: "organisation_placement_conflict" as const },
      };
    if (!scoped.ok) return scoped;
    const sourceAccess = await caseContextCollectionSourceAccess(
      scope,
      this.ctx.storage.sql,
      scoped.value.anchor.selection.integrationAccountId,
    );
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return {
        ok: false as const,
        error: { code: "organisation_placement_conflict" as const },
      };
    if (!sourceAccess.ok) return sourceAccess;
    const credential = await resolveTypeSafeCredential({
      sql: this.ctx.storage.sql,
      db: scope.database,
      keys: this.env,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return {
        ok: false as const,
        error: { code: "organisation_placement_conflict" as const },
      };
    const discovery = readCaseContextDiscoveryPolicy(
      this.ctx.storage.sql,
      scope.organisationId,
    ).policy;
    if (discovery.mode !== "disabled")
      await ensureJevPaidHold({
        sql: this.ctx.storage.sql,
        env: this.env,
        organisationId: scope.organisationId,
        purpose: "case_context_discovery_relationship",
        freeUseCovers: jevFreeUseCovers(
          this.ctx.storage.sql,
          scope.organisationId,
          discovery.limits.reservationMicrousd,
          Date.now(),
        ),
        now: Date.now(),
      });
    const result = await evaluateOperationalCaseContextDiscovery({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      credential,
      scope,
      request: scoped.value,
      sourceAccess: sourceAccess.value,
      signal: new AbortController().signal,
      fetcher: runtimeFetch,
      now: Date.now,
    });
    await this.rearm();
    return result;
  }

  async prepareCaseContextCollectionEvidence(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
      integrationAccountId: string;
      triggeringMessageId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedPrepareCaseContextCollectionEvidence.bind(this, input),
    );
  }

  protected async admittedPrepareCaseContextCollectionEvidence(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
      integrationAccountId: string;
      triggeringMessageId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (
      !identifier(input.caseId) ||
      !identifier(input.integrationAccountId) ||
      !identifier(input.triggeringMessageId)
    )
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_invalid" as const },
      };
    const policy = readCaseContextDiscoveryPolicy(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (policy.policy.mode !== "party_context")
      return { ok: true as const, value: { kind: "source_only" as const } };
    const ids = listMemberCaseContextCollectionIdsForCase(
      this.ctx.storage.sql,
      scope.organisationId,
      input.caseId,
    );
    if (ids.length !== 1)
      return { ok: true as const, value: { kind: "source_only" as const } };
    const caseContextCollection = readCaseContextCollection(
      this.ctx.storage.sql,
      scope.organisationId,
      ids[0]!,
    );
    if (
      caseContextCollection === null ||
      caseContextCollection.lifecycle !== "open"
    )
      return { ok: true as const, value: { kind: "source_only" as const } };
    const verified = await resolveCaseContextCollectionSelectionVerification(
      scope.database,
      scope.organisationId,
      caseContextCollection.anchorSelection,
    );
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    if (
      !verified.ok ||
      verified.value.endpoint.channel !== "gmail" ||
      verified.value.integrationAccountId !== input.integrationAccountId
    )
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_stale" as const },
      };
    const target = verified.value.target;
    if (target.kind !== "supplier_contact")
      return { ok: true as const, value: { kind: "source_only" as const } };
    const recipient = {
      organisationId: scope.organisationId,
      merchantId: verified.value.merchantId,
      integrationAccountId: input.integrationAccountId,
      partyKind: "supplier" as const,
      partyId: target.supplierId,
      contactId: target.contactId,
      contactRevision: target.contactRevision,
      verificationId: verified.value.verificationId,
      verificationRevision: verified.value.revision,
      endpointDigest: await digestCanonical(verified.value.endpoint.address),
      purpose: "supplier_reply" as const,
    };
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const dependency = evidenceForCaseContextCollection(
      caseContextCollection,
      policy.revision,
      recipient,
      Date.now(),
    );
    if (dependency === null)
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_stale" as const },
      };
    const receipt = await scope.database
      .prepare(
        `SELECT admitted_at FROM email_message_receipt WHERE organisation_id = ? AND integration_account_id = ? AND provider_message_id = ? AND case_id = ? AND contact_verification_id = ? AND contact_verification_revision = ?`,
      )
      .bind(
        scope.organisationId,
        input.integrationAccountId,
        input.triggeringMessageId,
        input.caseId,
        recipient.verificationId,
        recipient.verificationRevision,
      )
      .first<{ admitted_at: number }>();
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    if (receipt === null)
      return { ok: true as const, value: { kind: "source_only" as const } };
    const valid = await this.admittedValidateCaseContextCollectionEvidence(
      {
        organisationId: scope.organisationId,
        dependency,
      },
      scope,
    );
    return valid.ok ? { ok: true as const, value: dependency } : valid;
  }

  async validateCaseContextCollectionEvidence(
    input: Readonly<{ organisationId: OrganisationId; dependency: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedValidateCaseContextCollectionEvidence.bind(this, input),
    );
  }

  protected async admittedValidateCaseContextCollectionEvidence(
    input: Readonly<{ organisationId: OrganisationId; dependency: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const dependency = parseCaseContextCollectionEvidenceDependency(
      input.dependency,
    );
    if (dependency?.kind !== "case_context_collection_evidence")
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_invalid" as const },
      };
    const source = await caseContextCollectionSourceAccess(
      scope,
      this.ctx.storage.sql,
      dependency.recipient.integrationAccountId,
    );
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const credential = await resolveTypeSafeCredential({
      sql: this.ctx.storage.sql,
      db: scope.database,
      keys: this.env,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const policy = readCaseContextDiscoveryPolicy(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (
      !source.ok ||
      policy.policy.mode !== "party_context" ||
      credential === null ||
      !sameTypeSafeAuthority(
        credential.authority,
        caseContextDiscoveryRouteAuthority(policy.policy.route),
      )
    )
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_stale" as const },
      };
    for (const selection of dependency.selections) {
      const verified = await resolveCaseContextCollectionSelectionVerification(
        scope.database,
        scope.organisationId,
        selection.source,
      );
      if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
        return organisationPlacementConflict();
      if (
        !verified.ok ||
        verified.value.endpoint.channel !== "gmail" ||
        verified.value.target.contactId !== dependency.recipient.contactId ||
        verified.value.target.contactRevision !==
          dependency.recipient.contactRevision
      )
        return {
          ok: false as const,
          error: { code: "case_context_collection_evidence_stale" as const },
        };
      const endpointDigest = await digestCanonical(
        verified.value.endpoint.address,
      );
      if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
        return organisationPlacementConflict();
      if (endpointDigest !== dependency.recipient.endpointDigest)
        return {
          ok: false as const,
          error: { code: "case_context_collection_evidence_stale" as const },
        };
    }
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return validateCaseContextCollectionEvidence({
      sql: this.ctx.storage.sql,
      organisationId: scope.organisationId,
      dependency,
      now: Date.now(),
    });
  }

  async commitCaseContextCollectionEffectFence(
    input: Readonly<{ organisationId: OrganisationId; attempt: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedCommitCaseContextCollectionEffectFence.bind(this, input),
    );
  }

  protected async admittedCommitCaseContextCollectionEffectFence(
    input: Readonly<{ organisationId: OrganisationId; attempt: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const attempt = parseCaseContextCollectionEffectAttempt(input.attempt);
    if (attempt === null)
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_invalid" as const },
      };
    const replay = await replayCaseContextCollectionEffectFence({
      sql: this.ctx.storage.sql,
      scope,
      attempt,
      now: Date.now,
    });
    if (!replay.ok) return replay;
    if (replay.value !== null)
      return { ok: true as const, value: replay.value };
    const valid = await this.admittedValidateCaseContextCollectionEvidence(
      {
        organisationId: scope.organisationId,
        dependency: attempt.dependency,
      },
      scope,
    );
    if (!valid.ok) return valid;
    return commitCaseContextCollectionEffectFence({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      scope,
      attempt,
      now: Date.now,
    });
  }

  async invalidateCaseContextCollectionVerification(
    input: Readonly<{
      organisationId: OrganisationId;
      verificationId: string;
      revision: number;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedInvalidateCaseContextCollectionVerification.bind(
        this,
        input,
      ),
    );
  }

  protected async admittedInvalidateCaseContextCollectionVerification(
    input: Readonly<{
      organisationId: OrganisationId;
      verificationId: string;
      revision: number;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (
      !identifier(input.verificationId) ||
      !integerIn(input.revision, 1, Number.MAX_SAFE_INTEGER)
    )
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_invalid" as const },
      };
    this.ctx.storage.transactionSync(
      invalidateCaseContextCollectionVerification.bind(null, {
        sql: this.ctx.storage.sql,
        organisationId: scope.organisationId,
        verificationId: input.verificationId,
        revision: input.revision,
      }),
    );
    await this.rearm();
    return { ok: true as const, value: null };
  }

  async eraseCaseContextCollectionSource(
    input: Readonly<{ organisationId: OrganisationId; selection: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedEraseCaseContextCollectionSource.bind(this, input),
    );
  }

  protected async admittedEraseCaseContextCollectionSource(
    input: Readonly<{ organisationId: OrganisationId; selection: unknown }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const selection = parseCaseContextCollectionSelection(input.selection);
    if (selection === null)
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_invalid" as const },
      };
    eraseCaseContextCollectionSource({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      selection,
      now: Date.now(),
    });
    await this.rearm();
    return { ok: true as const, value: null };
  }

  async readCaseContextCollection(
    input: Readonly<{
      organisationId: OrganisationId;
      caseContextCollectionId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCaseContextCollection.bind(this, input),
    );
  }

  protected async admittedReadCaseContextCollection(
    input: Readonly<{
      organisationId: OrganisationId;
      caseContextCollectionId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    if (!identifier(input.caseContextCollectionId)) {
      return {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_invalid" as const,
        },
      };
    }
    const caseContextCollection = readCaseContextCollection(
      this.ctx.storage.sql,
      scope.organisationId,
      input.caseContextCollectionId,
    );
    return caseContextCollection === null
      ? {
          ok: false as const,
          error: {
            code: "case_context_collection_relationship_unavailable" as const,
          },
        }
      : { ok: true as const, value: caseContextCollection };
  }

  async readCaseContextCollectionsForCase(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCaseContextCollectionsForCase.bind(this, input),
    );
  }

  protected async admittedReadCaseContextCollectionsForCase(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const caseId = parseCaseId(input.caseId);
    if (!caseId.ok) {
      return {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_invalid" as const,
        },
      };
    }
    const caseContextCollectionIds = listCaseContextCollectionIdsForCase(
      this.ctx.storage.sql,
      scope.organisationId,
      caseId.value,
      Date.now(),
    );
    const caseContextCollections: CaseContextCollection[] = [];
    for (const caseContextCollectionId of caseContextCollectionIds) {
      const caseContextCollection = readCaseContextCollection(
        this.ctx.storage.sql,
        scope.organisationId,
        caseContextCollectionId,
      );
      if (caseContextCollection === null) {
        return {
          ok: false as const,
          error: {
            code: "case_context_collection_relationship_unavailable" as const,
          },
        };
      }
      caseContextCollections.push(caseContextCollection);
    }
    return {
      ok: true as const,
      value: { caseId: caseId.value, caseContextCollections },
    };
  }

  async reviewCaseContextCollectionRelationship(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      caseContextCollectionId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReviewCaseContextCollectionRelationship.bind(this, input),
    );
  }

  protected async admittedReviewCaseContextCollectionRelationship(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      caseContextCollectionId: string;
      body: unknown;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    const command = parseCaseContextCollectionReviewCommand(input.body);
    if (
      !identifier(input.caseContextCollectionId) ||
      !identifier(input.actorId) ||
      command === null
    ) {
      return {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_invalid" as const,
        },
      };
    }
    const requestDigest = await digestCanonical({
      actorId: input.actorId,
      caseContextCollectionId: input.caseContextCollectionId,
      command,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const replayed = replayCaseContextCollectionRelationshipCommand({
      sql: this.ctx.storage.sql,
      organisationId: scope.organisationId,
      commandId: command.commandId,
      requestDigest,
    });
    if (!replayed.ok || replayed.value !== null) return replayed;
    const caseContextCollection = readCaseContextCollection(
      this.ctx.storage.sql,
      scope.organisationId,
      input.caseContextCollectionId,
    );
    if (caseContextCollection === null) {
      return {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_unavailable" as const,
        },
      };
    }
    const decision = await caseContextCollectionReviewDecision({
      db: scope.database,
      organisationId: scope.organisationId,
      caseContextCollection,
      command: command.decision,
    });
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    if (!decision.ok) return decision;
    const result = decideCaseContextCollectionRelationship({
      sql: this.ctx.storage.sql,
      transaction: schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      organisationId: scope.organisationId,
      commandId: command.commandId,
      requestDigest,
      caseContextCollectionId: input.caseContextCollectionId,
      expectedRevision: command.expectedRevision,
      actorId: input.actorId,
      now: Date.now(),
      decision: decision.value,
    });
    await this.rearm();
    return result;
  }

  async activatePolicy(
    input: OrganisationActivatePolicyInput,
  ): Promise<
    Result<OrganisationPolicyActivation, OrganisationPolicyActivationError>
  > {
    const organisation = readOrganisationMetaRow(this.ctx.storage.sql);

    if (organisation === undefined) {
      return { ok: false, error: { code: "organisation_not_initialized" } };
    }

    if (organisation.organisation_id !== input.organisationId) {
      return { ok: false, error: { code: "organisation_mismatch" } };
    }

    const parsed = parseOrganisationPolicySnapshot(input.snapshot);

    if (!parsed.ok) {
      return { ok: false, error: { code: "invalid_policy_snapshot" } };
    }

    const body = JSON.stringify(parsed.value);
    const digest = await sha256Hex(body);
    if (
      !(await isOrganisationPolicyPlacementActive(
        this.env.DB,
        input.organisationId,
        input.placement,
      ))
    ) {
      return { ok: false, error: { code: "policy_placement_conflict" } };
    }
    const localPlacement = this.ctx.storage.sql
      .exec(
        `SELECT 1 FROM state_object_activation WHERE singleton = 1 AND organisation_id = ?
       AND placement_epoch = ? AND placement_cell_id = ?
       AND NOT EXISTS (SELECT 1 FROM state_object_policy_export_barrier)`,
        input.organisationId,
        input.placement.placement.placementEpoch,
        input.placement.placement.placementCellId,
      )
      .toArray()[0];
    if (localPlacement === undefined) {
      return { ok: false, error: { code: "policy_placement_conflict" } };
    }
    // No await separates the local export barrier check and the head mutation.
    const current = readOrganisationPolicyHead(this.ctx.storage.sql);

    if (
      current !== undefined &&
      parsed.value.version < current.active_version
    ) {
      return {
        ok: false,
        error: {
          code: "policy_version_stale",
          activeVersion: current.active_version,
          receivedVersion: parsed.value.version,
        },
      };
    }

    if (
      current !== undefined &&
      parsed.value.version === current.active_version
    ) {
      return current.digest === digest
        ? existingPolicyActivation(this.ctx.storage.sql, current)
        : {
            ok: false,
            error: {
              code: "policy_version_conflict",
              version: parsed.value.version,
            },
          };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO organisation_policy_head (
         organisation_id, active_version, restriction_version, digest, body, activated_at
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         active_version = excluded.active_version,
         restriction_version = excluded.restriction_version,
         digest = excluded.digest,
         body = excluded.body,
         activated_at = excluded.activated_at`,
      input.organisationId,
      parsed.value.version,
      parsed.value.version,
      digest,
      body,
      input.activatedAt,
    );
    const head: OrganisationPolicyHead = {
      activeVersion: parsed.value.version,
      restrictionVersion: parsed.value.version,
      digest,
      activatedAt: input.activatedAt,
    };
    traceLog("organisation.policy_activated", {
      requestId: input.requestId,
      organisation_id: input.organisationId,
      active_version: head.activeVersion,
      restriction_version: head.restrictionVersion,
      consumers: 0,
      delivered: 0,
      pending: 0,
    });
    return {
      ok: true,
      value: { head, consumers: 0, delivered: 0, pending: 0 },
    };
  }
}
