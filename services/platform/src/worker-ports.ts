// The Worker registers each port of a lower module here, once, when its
// entry module loads (Refactor 17). A port reads its implementation at the
// call, so each part names its function when it runs.
import { listVerifiedContactEndpoints } from "./data/contact-verification";
import {
  readEmailMailboxIdentityClaimant,
  registerEmailMailboxAccount,
} from "./data/email-mailbox";
import {
  readEmailSenderIdentityClaimant,
  registerEmailSenderAccount,
} from "./data/email-operational";
import {
  registerWhatsAppPhoneNumberAccount,
  setWhatsAppProviderHealth,
} from "./data/whatsapp";
import { proposeEvalFromCorrection } from "./evals/access";
import { connectionParts } from "./integrations/contract/connection-parts";
import { tearDownAgentMailboxForRemoval } from "./mail-inbox/agent-mailbox-teardown";
import { verifiedContacts } from "./mail-inbox/contract/verified-contacts";
import {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "./memory/access";
import { memoryService } from "./memory/contract/memory-service";
import { slackDmSelection } from "./slack/installation-store";
import {
  prepareRevokedDmSelectionRelease,
  selectSlackDmOrganisation,
} from "./slack/organisation-routing";

memoryService.register({
  readMemoryViews: (...input) => readMemoryViews(...input),
  readShownMemoryStanding: (...input) => readShownMemoryStanding(...input),
  createTurnMemoryReader: (...input) => createTurnMemoryReader(...input),
  proposeMemoryFromCorrection: (...input) =>
    proposeMemoryFromCorrection(...input),
  proposeEvalFromCorrection: (...input) => proposeEvalFromCorrection(...input),
});

verifiedContacts.register({
  listVerifiedContactEndpoints: (...input) =>
    listVerifiedContactEndpoints(...input),
});

connectionParts.register({
  mailbox: {
    readEmailSenderIdentityClaimant: (...input) =>
      readEmailSenderIdentityClaimant(...input),
    readEmailMailboxIdentityClaimant: (...input) =>
      readEmailMailboxIdentityClaimant(...input),
    registerEmailSenderAccount: (...input) =>
      registerEmailSenderAccount(...input),
    registerEmailMailboxAccount: (...input) =>
      registerEmailMailboxAccount(...input),
    tearDownAgentMailboxForRemoval: (...input) =>
      tearDownAgentMailboxForRemoval(...input),
  },
  whatsapp: {
    registerWhatsAppPhoneNumberAccount: (...input) =>
      registerWhatsAppPhoneNumberAccount(...input),
    setWhatsAppProviderHealth: (...input) =>
      setWhatsAppProviderHealth(...input),
  },
});

slackDmSelection.register({
  prepareRevokedSelectionRelease: (...input) =>
    prepareRevokedDmSelectionRelease(...input),
  selectOrganisation: (...input) => selectSlackDmOrganisation(...input),
});
