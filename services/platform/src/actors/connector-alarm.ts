import type { ChannelAlarmDue } from "./connector/channel-adapter";
import { nextConnectorCaseWorkAlarm } from "./connector-case-work";
import { nextWhatsAppSweepAt } from "./connector-whatsapp";
import type { AlarmReconciler } from "./lifecycle/actor-alarm";

/**
 * The Connector's alarm reconcilers: its Case work and the work of each
 * channel. Each reads its own rows. `onCaseWorkRead` receives the number of
 * case work rows read.
 */
export function connectorAlarmReconcilers(
  sql: SqlStorage,
  channels: readonly ChannelAlarmDue[],
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
    ...channels.flatMap((due) => due(sql)),
    { name: "whatsapp_sweep", nextDue: () => nextWhatsAppSweepAt(sql) },
  ];
}
