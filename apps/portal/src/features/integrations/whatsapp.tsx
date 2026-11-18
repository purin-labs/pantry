import React from "react";
import {
  WhatsAppIntegrationPanel,
  type WhatsAppInstallationOption,
} from "../../pages/whatsapp";
import type { MailboxInstallationOption } from "../../pages/agent-mailbox";

/**
 * The WhatsApp panel with the agents that can be assigned now. The list is
 * read when the panel renders, as the page read it before, and not when the
 * page builds its entries.
 */
export function InstalledAgentsWhatsAppPanel(
  props: Omit<
    React.ComponentProps<typeof WhatsAppIntegrationPanel>,
    "installations"
  > & { readonly agents: readonly MailboxInstallationOption[] },
): React.ReactNode {
  const { agents, ...panel } = props;
  return (
    <WhatsAppIntegrationPanel
      {...panel}
      installations={agents.flatMap(installedAgentOption)}
    />
  );
}

/** The agents that can be assigned now, for a list that names no other. */
export function installedAgentOption(
  option: MailboxInstallationOption,
): readonly WhatsAppInstallationOption[] {
  return option.kind === "ready"
    ? [{ installationId: option.installationId, label: option.label }]
    : [];
}
