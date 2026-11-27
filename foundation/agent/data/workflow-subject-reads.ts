import type { WorkflowSubjectReads } from "@purin-labs/authority/access-control/subject-reads";

// The reads of the cue subscriptions and the schedule bindings that an
// access decision of the authority module makes (Refactor 17). The Worker
// registers them (`worker-ports.ts`). Each one is one D1 read and writes
// nothing.

type PresentRow = { readonly present: 1 };

export const WORKFLOW_SUBJECT_READS: WorkflowSubjectReads = {
  async cueSubscriptionAuthorityIsLive(db, authority) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN cue_subscription AS subscription
         ON subscription.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND subscription.subscription_id = ?
         AND subscription.version = ?
         AND subscription.enabled = 1
       LIMIT 1`,
      )
      .bind(
        authority.organisationId,
        authority.workflowId,
        authority.workflowRevision,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },

  async scheduleBindingAuthorityIsLive(db, authority) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN schedule_binding AS binding
         ON binding.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND binding.binding_id = ?
         AND binding.revision = ?
         AND binding.enabled = 1
       LIMIT 1`,
      )
      .bind(
        authority.organisationId,
        authority.workflowId,
        authority.workflowRevision,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },

  async cueSubscriptionIsCurrent(db, organisationId, subject) {
    const row = await db
      .prepare(
        `SELECT 1 AS present FROM cue_subscription
      WHERE organisation_id = ? AND subscription_id = ? AND version = ? AND enabled = 1 LIMIT 1`,
      )
      .bind(organisationId, subject.workflowId, subject.workflowRevision)
      .first<PresentRow>();
    return row?.present === 1;
  },

  async scheduleBindingIsCurrent(db, organisationId, subject) {
    const row = await db
      .prepare(
        `SELECT 1 AS present FROM schedule_binding
      WHERE organisation_id = ? AND binding_id = ? AND revision = ? AND enabled = 1 LIMIT 1`,
      )
      .bind(organisationId, subject.workflowId, subject.workflowRevision)
      .first<PresentRow>();
    return row?.present === 1;
  },
};
