import { nextMailOrganizationAt } from "../mail-inbox/store";
import { nextConnectorCaseWorkAlarm } from "./connector-case-work";
import {
  nextEmailCaseContextDiscoveryAt,
  nextEmailCorrectionLearningAt,
  nextEmailEvaluationAt,
  nextEmailMaintenanceAt,
  nextEmailReplyTurnAt,
  nextEmailWatchCleanupAt,
} from "./connector-email";
import { nextOperationalEmailMaintenanceAt } from "./connector-email-operational";
import { nextEvalWorkAt } from "./connector-eval";
import { nextWhatsAppSweepAt } from "./connector-whatsapp";
import type { AlarmReconciler } from "./lifecycle/actor-alarm";

/**
 * The Connector's alarm reconcilers, in the order of its alarm. Each reads
 * its own rows. `onCaseWorkRead` receives the number of case work rows read.
 */
export function connectorAlarmReconcilers(
  sql: SqlStorage,
  onCaseWorkRead?: (rowsRead: number) => void,
): readonly AlarmReconciler[] {
  return [
    {
      name: "case_work",
      nextDue: () => {
        const caseWork = nextConnectorCaseWorkAlarm(sql);
        onCaseWorkRead?.(caseWork.rowsRead);
        return caseWork.result;
      },
    },
    { name: "email_evaluation", nextDue: () => nextEmailEvaluationAt(sql) },
    { name: "mail_organization", nextDue: () => nextMailOrganizationAt(sql) },
    {
      name: "email_case_context_discovery",
      nextDue: () => nextEmailCaseContextDiscoveryAt(sql),
    },
    {
      name: "email_correction_learning",
      nextDue: () => nextEmailCorrectionLearningAt(sql),
    },
    { name: "eval_work", nextDue: () => nextEvalWorkAt(sql) },
    { name: "email_reply_turn", nextDue: () => nextEmailReplyTurnAt(sql) },
    {
      name: "email_maintenance",
      nextDue: (now) => nextEmailMaintenanceAt(sql, now),
    },
    {
      name: "email_watch_cleanup",
      nextDue: () => nextEmailWatchCleanupAt(sql),
    },
    {
      name: "operational_email_maintenance",
      nextDue: () => nextOperationalEmailMaintenanceAt(sql),
    },
    { name: "whatsapp_sweep", nextDue: () => nextWhatsAppSweepAt(sql) },
  ];
}
