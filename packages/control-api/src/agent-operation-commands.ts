import type { AgentSkillRef } from "./agents.ts";
import type { ScheduleSpec } from "./schedule.ts";

// The agent operation commands. The scope of `publish_responsibility_scope`
// names commerce entity types, so the commerce control API gives its type
// (`AgentOperationCommand` of `@purin-labs/commerce-control-api/portal/agent-operations`).

export type Skill = {
  readonly skillId: string;
  readonly title: string;
  readonly sensitivity: "ordinary" | "sensitive";
  readonly lifecycle: "published" | "archived";
  readonly currentRevision: {
    readonly revision: number;
    readonly markdownBody: string;
    readonly contentDigest: string;
  };
};

export type SkillBinding = {
  readonly bindingId: string;
  readonly targetKind: "area";
  readonly targetId: string;
  readonly skillId: string;
  readonly skillRevision: number;
};

type AgentOperationBaseCommand =
  | {
      readonly kind: "create_area";
      readonly name: string;
      readonly purpose: string;
    }
  | {
      readonly kind: "create_skill";
      readonly title: string;
      readonly sensitivity: Skill["sensitivity"];
      readonly markdownBody: string;
    }
  | {
      readonly kind: "publish_skill_revision";
      readonly skillId: string;
      readonly expectedRevision: number;
      readonly markdownBody: string;
    }
  | {
      readonly kind: "create_agent_definition";
      readonly displayName: string;
      readonly role: string;
      readonly purpose: string;
      readonly instructions: string;
      readonly requestedCapabilities: readonly string[];
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "publish_agent_definition_revision";
      readonly agentDefinitionId: string;
      readonly expectedRevision: number;
      readonly instructions: string;
      readonly requestedCapabilities: readonly string[];
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "install_agent";
      readonly agentDefinitionId: string;
      readonly definitionRevision: number;
      readonly areaId: string;
      readonly responsibility: string;
      readonly scopeIds: readonly string[];
      readonly policyRevision: number;
      readonly grantedCapabilities: readonly string[];
    }
  | {
      readonly kind: "bind_skill";
      readonly targetKind: SkillBinding["targetKind"];
      readonly targetId: string;
      readonly skillId: string;
      readonly skillRevision: number;
    }
  | {
      readonly kind: "configure_cue_binding";
      readonly areaId: string;
      readonly scopeIds: readonly string[];
      readonly installationId: string;
      readonly cueSource: string;
      readonly cueEventType: string;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "configure_schedule_binding";
      readonly areaId: string;
      readonly scopeIds: readonly string[];
      readonly installationId: string;
      readonly spec: ScheduleSpec;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "update_cue_binding";
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "update_schedule_binding";
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "configure_installation_governance";
      readonly installationId: string;
      readonly maxSessionBudgetTokens: number;
    }
  | {
      readonly kind: "accept_configuration_proposal";
      readonly proposalId: string;
    }
  | {
      readonly kind: "dismiss_configuration_proposal";
      readonly proposalId: string;
    }
  | {
      /**
       * Adopts a published definition revision for one installation.
       *
       * Publication records what an agent may run; activation decides what it
       * does run. New Cases pin the activated revision; Cases already assigned
       * keep the revision they recorded.
       */
      readonly kind: "activate_agent_definition_revision";
      readonly installationId: string;
      readonly expectedDefinitionRevision: number;
      readonly definitionRevision: number;
      /**
       * The ordered skill set the operator is activating. It must equal the
       * chosen revision's set exactly, so the confirmation names what will run
       * rather than trusting whatever the definition holds at execution.
       */
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "dispatch_manual_run";
      readonly installationId: string;
      readonly instructionBody: string;
    };

export type AgentOperationCommandOf<Scope = unknown> =
  | AgentOperationBaseCommand
  | {
      readonly kind: "publish_responsibility_scope";
      readonly areaId: string;
      readonly scope: Scope;
    };
