import { runtimeFetch } from "../../runtime-fetch";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actor-execution-quiescence";
import { newRequestId, type OrganisationId } from "../../ids";
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
  readTypeSafeConnection,
  mutateTypeSafeConnection,
} from "../../integrations/typesafe/connection";
import {
  currentTypeSafeAuthority,
  resolvePantryTypeSafeKey,
  resolveTypeSafeCredential,
  sameTypeSafeAuthority,
  type TypeSafeAuthority,
} from "../../integrations/typesafe/authority";
import { evaluateOperationalCaseContextDiscovery } from "../../case-context-discovery/operational-evaluation";
import {
  caseContextDiscoveryReadiness,
  caseContextDiscoveryRouteAuthority,
  parseCaseContextDiscoveryPolicy,
  identifier,
  integerIn,
} from "../../case-context-discovery/policy";
import { digestCanonical } from "../../policy/information-flow/digest";
import { errorMessage, isRecord, sha256Hex } from "@purin-labs/std";
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
} from "./policy-types";
import { OrganisationActorBase } from "./organisation-actor-base";
import type { Env } from "../../env";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { FlowLabel } from "../../policy/information-flow";
import type {
  OperationalCaseContextDiscoveryRequest,
  OperationalCaseContextDiscoverySourceRequest,
} from "../../case-context-discovery/operational-evaluation";

/**
 * Policy activation, credentials, TypeSafe and Case context discovery for the Organisation.
 */
/**
 * What the policy needs from the Jev features of the integrations area. The
 * class of the Worker gives it.
 */
export type PolicyJevPort = Readonly<{
  /** Keeps each mailbox that was on, on, under a new TypeSafe authority. */
  repinMailClassification(
    input: Readonly<{
      db: OrganisationExecutionScope["database"];
      organisationId: OrganisationId;
      from: TypeSafeAuthority;
      to: TypeSafeAuthority;
      now: number;
    }>,
  ): Promise<unknown>;
  /**
   * Holds the paid use of one Jev purpose when the free use does not cover
   * the reservation.
   */
  ensurePaidHold(
    input: Readonly<{
      sql: SqlStorage;
      env: Env;
      organisationId: OrganisationId;
      purpose: "case_context_discovery_relationship";
      reservationMicrousd: number;
      now: number;
    }>,
  ): Promise<unknown>;
}>;

/**
 * What the Case context discovery commands of the policy need from the
 * source of a collection. The Inbox owns the source, a Gmail mailbox, and
 * the class of the Worker gives these functions.
 */
export type PolicyCaseContextSourcePort = Readonly<{
  /** True for a source that cannot hold the reply of a party. */
  unsupportedReplySource(source: Readonly<{ source: string }>): boolean;
  /** The authority and the label under which the source is read. */
  sourceAccess(
    scope: OrganisationExecutionScope,
    sql: SqlStorage,
    accountId: string,
  ): Promise<
    Result<
      Readonly<{ authority: RequestAuthority; label: FlowLabel }>,
      Readonly<{
        code:
          | "case_context_collection_relationship_invalid"
          | "case_context_collection_relationship_unavailable"
          | "organisation_placement_conflict";
      }>
    >
  >;
  parseSourceRequest(
    raw: unknown,
  ): OperationalCaseContextDiscoverySourceRequest | null;
  /** Checks the request against the verified contact of its anchor. */
  verifiedRequest(
    input: Readonly<{
      scope: OrganisationExecutionScope;
      sql: SqlStorage;
      request: OperationalCaseContextDiscoverySourceRequest;
    }>,
  ): Promise<
    Result<
      OperationalCaseContextDiscoveryRequest,
      Readonly<{
        code:
          | "case_context_collection_relationship_invalid"
          | "case_context_collection_relationship_unavailable"
          | "case_context_collection_relationship_conflict"
          | "organisation_placement_conflict";
      }>
    >
  >;
}>;

export abstract class OrganisationPolicy extends OrganisationActorBase {
  /** The Jev parts that two policy commands call. */
  protected abstract jevForPolicy(): PolicyJevPort;

  /** The source of a Case context collection, for the discovery commands. */
  protected abstract caseContextSourceForPolicy(): PolicyCaseContextSourcePort;

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
          await this.jevForPolicy().repinMailClassification({
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
      policy.value.sources.some(
        this.caseContextSourceForPolicy().unsupportedReplySource,
      )
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
          const access = await this.caseContextSourceForPolicy().sourceAccess(
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
    const request = this.caseContextSourceForPolicy().parseSourceRequest(
      input.request,
    );
    if (request === null) {
      return {
        ok: false as const,
        error: { code: "case_context_discovery_evaluation_invalid" as const },
      };
    }
    const scoped = await this.caseContextSourceForPolicy().verifiedRequest({
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
    const sourceAccess = await this.caseContextSourceForPolicy().sourceAccess(
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
      await this.jevForPolicy().ensurePaidHold({
        sql: this.ctx.storage.sql,
        env: this.env,
        organisationId: scope.organisationId,
        purpose: "case_context_discovery_relationship",
        reservationMicrousd: discovery.limits.reservationMicrousd,
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
