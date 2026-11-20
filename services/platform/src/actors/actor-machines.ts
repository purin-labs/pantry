import type { MachineDefinition } from "@purin-labs/std/state-machine";

import { CASE_APPROVAL_WAIT_MACHINE } from "./case/approval-wait.machine";
import { CASE_ASSIGNMENT_MACHINE } from "./case/assignment.machine";
import { CASE_OUTPUT_MACHINE } from "./case/output.machine";
import { CUE_DELIVERY_MACHINE } from "./cue-delivery.machine";
import { DEVICE_COMMAND_MACHINE } from "./device-command.machine";
import { STEERING_INPUT_MACHINE } from "./steering-input.machine";
import { WHATSAPP_REPLY_PROPOSAL_MACHINE } from "./whatsapp-reply-proposal.machine";
import { EMAIL_REPLY_PROPOSAL_MACHINE } from "../data/email-reply-proposal.machine";

/**
 * The machines whose state lives in an Actor's SQLite (Refactor 15, S5).
 * The census of each Actor reads the machines whose table it holds. Each
 * module owns its machine, and the Worker joins them in this one list.
 */
export const ACTOR_MACHINES: readonly MachineDefinition[] = [
  CASE_APPROVAL_WAIT_MACHINE,
  CASE_ASSIGNMENT_MACHINE,
  CASE_OUTPUT_MACHINE,
  CUE_DELIVERY_MACHINE,
  DEVICE_COMMAND_MACHINE,
  STEERING_INPUT_MACHINE,
  EMAIL_REPLY_PROPOSAL_MACHINE,
  WHATSAPP_REPLY_PROPOSAL_MACHINE,
];
