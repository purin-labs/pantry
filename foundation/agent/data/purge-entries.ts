/**
 * The purge entries of the tables of the agent (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const AGENT_PURGE_ENTRIES = [
  {
    order: 10,
    table: "file_grant_admission",
    action: "erase",
    statement: "DELETE FROM file_grant_admission",
  },
  {
    order: 20,
    table: "file_grant_sync",
    action: "erase",
    statement: "DELETE FROM file_grant_sync",
  },
  {
    order: 30,
    table: "file_projection_outbox",
    action: "erase",
    statement: "DELETE FROM file_projection_outbox",
  },
  {
    order: 50,
    table: "agent_area_assignment",
    action: "erase",
    statement: "DELETE FROM agent_area_assignment",
    where:
      "installation_id IN (SELECT installation_id FROM agent_installation WHERE organisation_id = ?)",
  },
  {
    order: 60,
    table: "agent_configuration_proposal",
    action: "erase",
    statement: "DELETE FROM agent_configuration_proposal",
  },
  {
    order: 70,
    table: "agent_installation_governance",
    action: "erase",
    statement: "DELETE FROM agent_installation_governance",
  },
  {
    order: 100,
    table: "case_assignment_pin",
    action: "erase",
    statement: "DELETE FROM case_assignment_pin",
  },
  {
    order: 110,
    table: "cue_binding",
    action: "erase",
    statement: "DELETE FROM cue_binding",
  },
  {
    order: 120,
    table: "schedule_dispatch_receipt",
    action: "erase",
    statement: "DELETE FROM schedule_dispatch_receipt",
  },
  {
    order: 130,
    table: "schedule_binding",
    action: "erase",
    statement: "DELETE FROM schedule_binding",
  },
  {
    order: 160,
    table: "agent_installation",
    action: "erase",
    statement: "DELETE FROM agent_installation",
  },
  {
    order: 170,
    table: "agent_definition_revision",
    action: "erase",
    statement: "DELETE FROM agent_definition_revision",
  },
  {
    order: 180,
    table: "agent_definition",
    action: "erase",
    statement: "DELETE FROM agent_definition",
  },
  {
    order: 210,
    table: "agent_responsibility_scope",
    action: "erase",
    statement: "DELETE FROM agent_responsibility_scope",
  },
  {
    order: 460,
    table: "context_projection",
    action: "erase",
    statement: "DELETE FROM context_projection",
  },
  {
    order: 470,
    table: "context_projection_fts",
    action: "erase",
    statement: "DELETE FROM context_projection_fts",
  },
  {
    order: 530,
    table: "cue_log",
    action: "erase",
    statement: "DELETE FROM cue_log",
  },
  {
    order: 540,
    table: "cue_subscription",
    action: "erase",
    statement: "DELETE FROM cue_subscription",
  },
  {
    order: 670,
    table: "file_extraction_budget",
    action: "erase",
    statement: "DELETE FROM file_extraction_budget",
  },
  {
    order: 680,
    table: "file_provider_cursor",
    action: "erase",
    statement: "DELETE FROM file_provider_cursor",
  },
  {
    order: 690,
    table: "file_resource_source",
    action: "erase",
    statement: "DELETE FROM file_resource_source",
  },
  {
    order: 1240,
    table: "operational_area",
    action: "erase",
    statement: "DELETE FROM operational_area",
  },
  {
    order: 1340,
    table: "organisation_claude_authorization",
    action: "erase",
    statement: "DELETE FROM organisation_claude_authorization",
  },
  {
    order: 1350,
    table: "organisation_claude_connection",
    action: "erase",
    statement: "DELETE FROM organisation_claude_connection",
  },
  {
    order: 1360,
    table: "organisation_codex_authorization_attempt",
    action: "erase",
    statement: "DELETE FROM organisation_codex_authorization_attempt",
  },
  {
    order: 1370,
    table: "organisation_codex_connection",
    action: "erase",
    statement: "DELETE FROM organisation_codex_connection",
  },
  {
    order: 1390,
    table: "organisation_default_workspace",
    action: "erase",
    statement: "DELETE FROM organisation_default_workspace",
  },
  {
    order: 1420,
    table: "organisation_inference_selection",
    action: "erase",
    statement: "DELETE FROM organisation_inference_selection",
  },
  {
    order: 1500,
    table: "organisation_slack_reasoning_effort",
    action: "erase",
    statement: "DELETE FROM organisation_slack_reasoning_effort",
  },
  {
    order: 1510,
    table: "organisation_workspace",
    action: "erase",
    statement: "DELETE FROM organisation_workspace",
  },
  {
    order: 1700,
    table: "skill_binding",
    action: "erase",
    statement: "DELETE FROM skill_binding",
  },
  {
    order: 1710,
    table: "skill_revision",
    action: "erase",
    statement: "DELETE FROM skill_revision",
  },
  {
    order: 1720,
    table: "skill",
    action: "erase",
    statement: "DELETE FROM skill",
  },
  {
    order: 1890,
    table: "workspace_revision_receipt",
    action: "erase",
    statement: "DELETE FROM workspace_revision_receipt",
  },
  {
    order: 1900,
    table: "workspace_revision",
    action: "erase",
    statement: "DELETE FROM workspace_revision",
  },
  {
    order: 1910,
    table: "workspace_revision_head",
    action: "erase",
    statement: "DELETE FROM workspace_revision_head",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
