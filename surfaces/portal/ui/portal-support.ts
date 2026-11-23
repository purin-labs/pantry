import {
  controlRead,
  controlMutation,
} from "@purin-labs/control/portal/control-client";
import type { MailboxSetupTransport } from "@purin-labs/area-inbox/ui/features/mail-setup/run";

export const MAILBOX_SETUP_TRANSPORT: MailboxSetupTransport = {
  read: controlRead,
  mutate: controlMutation,
};
