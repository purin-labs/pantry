import { caseCommercePart } from "../commerce/case-proposals";
import {
  acceptCaseEmailProposal,
  readCaseEmailProposals,
  readCaseMailWork,
  transitionCaseEmailProposal,
} from "./case-inbox/email-proposals";
import { caseInboxPart } from "./case-inbox/part";
import type { CaseInboxRpc } from "./case-inbox/rpc";
import { CaseActor } from "./case/case-actor";
import type { CaseParts } from "./case/parts";

const CASE_PARTS: CaseParts = {
  commerce: caseCommercePart,
  inbox: caseInboxPart,
  portalChat: {
    // The chat application loads on the first resume, as it did before the
    // part, so the Worker start does not load the chat run.
    async resumeExecution(env, scope, execution, caseActor) {
      const { resumeConversationExecution } = await import(
        "../chat/application"
      );
      return resumeConversationExecution(env, scope, execution, caseActor);
    },
  },
};

/**
 * The Case Durable Object class of the Worker. It keeps the deployed class
 * name and the RPC method names. The Case actor holds the logic and names no
 * product area and no surface. This class gives it the parts of the areas,
 * and it registers the modules of the areas: each RPC method of a module
 * calls one function of that module.
 */
export class CaseDO extends CaseActor implements CaseInboxRpc {
  protected areaParts(): CaseParts {
    return CASE_PARTS;
  }

  // The email reply proposals and the mail work (`actors/case-inbox/`).

  async acceptEmailProposal(raw: unknown) {
    return acceptCaseEmailProposal(this.ctx.storage, raw);
  }

  async transitionEmailProposal(raw: unknown) {
    return transitionCaseEmailProposal(this.ctx.storage, raw);
  }

  async readEmailProposals() {
    return readCaseEmailProposals(this.ctx.storage);
  }

  async readMailWork(input: Parameters<CaseInboxRpc["readMailWork"]>[0]) {
    return readCaseMailWork(this.ctx.storage, input);
  }
}

declare module "../env" {
  interface Env {
    CASE: DurableObjectNamespace<CaseDO>;
  }
}
