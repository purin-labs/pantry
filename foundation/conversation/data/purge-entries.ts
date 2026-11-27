/**
 * The purge entries of the tables of the conversation (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const CONVERSATION_PURGE_ENTRIES = [
  {
    order: 370,
    table: "portal_conversation_user",
    action: "erase",
    statement: "DELETE FROM portal_conversation_user",
  },
  {
    order: 380,
    table: "session_turn_access",
    action: "erase",
    statement: "DELETE FROM session_turn_access",
  },
  {
    order: 390,
    table: "portal_conversation",
    action: "erase",
    statement: "DELETE FROM portal_conversation",
  },
  {
    order: 400,
    table: "case_project",
    action: "erase",
    statement: "DELETE FROM case_project",
  },
  {
    order: 1380,
    table: "organisation_default_project",
    action: "erase",
    statement: "DELETE FROM organisation_default_project",
  },
  {
    order: 1540,
    table: "project_member",
    action: "erase",
    statement: "DELETE FROM project_member",
  },
  {
    order: 1590,
    table: "portal_chat_conversation_access_operation",
    action: "erase",
    statement: "DELETE FROM portal_chat_conversation_access_operation",
  },
  {
    order: 1600,
    table: "portal_chat_deletion",
    action: "erase",
    statement: "DELETE FROM portal_chat_deletion",
  },
  {
    order: 1610,
    table: "portal_chat_directory_operation",
    action: "erase",
    statement: "DELETE FROM portal_chat_directory_operation",
  },
  {
    order: 1620,
    table: "portal_chat_directory",
    action: "erase",
    statement: "DELETE FROM portal_chat_directory",
  },
  {
    order: 1630,
    table: "portal_chat_directory_project",
    action: "erase",
    statement: "DELETE FROM portal_chat_directory_project",
  },
  {
    order: 1640,
    table: "portal_chat_fork",
    action: "erase",
    statement: "DELETE FROM portal_chat_fork",
  },
  {
    order: 1650,
    table: "project_access_operation",
    action: "erase",
    statement: "DELETE FROM project_access_operation",
  },
  {
    order: 1660,
    table: "project",
    action: "erase",
    statement: "DELETE FROM project",
  },
  {
    order: 1670,
    table: "project_operation",
    action: "erase",
    statement: "DELETE FROM project_operation",
  },
  {
    order: 1690,
    table: "side_case_proposal",
    action: "erase",
    statement: "DELETE FROM side_case_proposal",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
