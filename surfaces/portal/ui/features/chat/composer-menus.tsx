import React from "react";
import { Circle, ShieldCheck } from "lucide-react";
import type { ChatPageData } from "@purin-labs/control-api/portal/chat";

/** The composer's access menu: the workspace rules apply to this chat. */
export function WorkspaceAccessMenu(props: {
  readonly accessPath: string;
}): React.ReactNode {
  return (
    <details name="composer-menu" className="chat-access-menu">
      <summary aria-label="Workspace access" title="Workspace access">
        <ShieldCheck size={17} aria-hidden="true" />
      </summary>
      <div className="chat-composer-menu">
        <p className="chat-menu-title">Workspace access</p>
        <p>Workspace grants and approval rules apply to this chat.</p>
        <a href={props.accessPath}>Manage access permissions</a>
      </div>
    </details>
  );
}

/** The composer's context menu: an estimate from the visible text only. */
export function ContextEstimateMenu(props: {
  readonly data: ChatPageData;
  readonly draft: string;
}): React.ReactNode {
  return (
    <details name="composer-menu" className="chat-context-menu">
      <summary aria-label="Context usage">
        <Circle size={17} aria-hidden="true" />
      </summary>
      <div className="chat-composer-menu">
        <p className="chat-menu-title">Context estimate</p>
        <strong>
          ~{estimatedContextTokens(props.data, props.draft).toLocaleString()}{" "}
          tokens
        </strong>
        <p>
          Visible conversation and draft. Full model context usage is
          unavailable.
        </p>
      </div>
    </details>
  );
}

function estimatedContextTokens(data: ChatPageData, draft: string): number {
  let characters = draft.length;
  for (const message of data.conversation?.messages ?? [])
    characters += message.text.length;
  return Math.ceil(characters / 4);
}
