import type { HarnessCodeExecutionAuthority } from "./HarnessCodeExecutionAuthority";
import type { HarnessProviderEffectAuthority } from "./HarnessProviderEffectAuthority";
import type { HarnessReadAuthority } from "./HarnessReadAuthority";
import type { HarnessSurfaceEffectAuthority } from "./HarnessSurfaceEffectAuthority";
import type { HarnessToolOutput } from "./HarnessToolOutput";
import type { HarnessToolResultStatus } from "./HarnessToolResultStatus";
import type { HarnessWorkspaceRevisionAuthority } from "./HarnessWorkspaceRevisionAuthority";

export type AuthorizedHarnessToolResult =
  | {
      kind: "read";
      output: HarnessToolOutput;
      authority: HarnessReadAuthority;
      status: HarnessToolResultStatus;
    }
  | {
      kind: "provider_effect";
      output: HarnessToolOutput;
      authority: HarnessProviderEffectAuthority;
      status: HarnessToolResultStatus;
    }
  | {
      kind: "surface_effect";
      output: HarnessToolOutput;
      authority: HarnessSurfaceEffectAuthority;
      status: HarnessToolResultStatus;
    }
  | {
      kind: "code_execution";
      output: HarnessToolOutput;
      authority: HarnessCodeExecutionAuthority;
      status: HarnessToolResultStatus;
    }
  | {
      kind: "workspace_revision";
      output: HarnessToolOutput;
      authority: HarnessWorkspaceRevisionAuthority;
      status: HarnessToolResultStatus;
    };
