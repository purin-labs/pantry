import React from "react";
import { ThreadTitle } from "./thread-title";
import { Check } from "lucide-react";
import { DashboardSidebarToggleIcon } from "@purin-labs/ui/dashboard-sidebar-toggle-icon";
import { ChatContextChip } from "./context";
import type { ChatModelOption } from "@purin-labs/control-api/portal/chat";
import type { ChatEffort } from "@purin-labs/control-api";
import {
  chooseSupportedEffort,
  modelOptionHasId,
  selectedModelFromState,
} from "./model-choice";
import type { ChatPage } from "./route";
import { summaryHasConversationId } from "./chat-route-helpers";

export const chatIdentityViews = {
  chooseModel(
    this: ChatPage,
    model: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void {
    if (
      this.isWorking() ||
      this.isArchived() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready" ||
      !this.state.page.data.model.options.some(
        modelOptionHasId.bind(null, model),
      )
    )
      return;
    const option = this.state.page.data.model.options.find(
      modelOptionHasId.bind(null, model),
    );
    if (option === undefined) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    this.pending = null;
    this.setState({
      selectedModel: model,
      selectedEffort: chooseSupportedEffort(
        this.state.selectedEffort,
        option.capabilities.effortOptions,
      ),
      error: null,
    });
  },

  chooseEffort(
    this: ChatPage,
    effort: ChatEffort,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void {
    if (
      this.isWorking() ||
      this.isArchived() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready"
    )
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    const option = this.state.page.data.model.options.find(
      modelOptionHasId.bind(null, model ?? ""),
    );
    if (
      option === undefined ||
      !option.capabilities.effortOptions.includes(effort)
    )
      return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    this.pending = null;
    this.setState({ selectedEffort: effort, error: null });
  },

  renderModelOption(
    this: ChatPage,
    option: ChatModelOption,
  ): React.ReactNode {
    if (this.state.page.kind !== "ready") return null;
    const selected =
      selectedModelFromState(this.state.selectedModel, this.state.page.data) ===
      option.id;
    return (
      <button
        key={option.id}
        type="button"
        className="chat-model-option"
        data-selected={selected ? "true" : "false"}
        aria-pressed={selected}
        disabled={this.isWorking() || this.isArchived()}
        onClick={this.chooseModel.bind(this, option.id)}
      >
        <span>
          {option.name}
          <small>{option.description}</small>
        </span>
        {selected ? <Check size={17} aria-hidden="true" /> : null}
      </button>
    );
  },

  /** The directory already holds the title of the chat that is opening. */
  openingTitle(this: ChatPage): string | null {
    const id = this.state.openingConversationId;
    if (id === null || this.state.page.kind !== "ready") return null;
    const data = this.state.page.data;
    return (
      [...data.conversations, ...data.archivedConversations].find(
        summaryHasConversationId.bind(null, id),
      )?.title ?? null
    );
  },

  renderChatIdentity(this: ChatPage): React.ReactNode {
    const agent =
      this.state.page.kind === "ready" &&
      this.state.page.data.model.kind === "ready"
        ? this.state.page.data.model.agent
        : "AI assistant";
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    return (
      <>
        <div className="chat-underlay-heading">
          <h2>
            <ThreadTitle title={this.openingTitle() ?? conversation?.title ?? agent} />
          </h2>
          <div className="chat-underlay-sidebar-controls">
            <button
              type="button"
              className="dashboard-sidebar-toggle"
              aria-label={
                this.state.threadsExpanded
                  ? "Collapse threads"
                  : "Expand threads"
              }
              aria-expanded={this.state.threadsExpanded}
              aria-controls="chat-threads-content"
              onClick={this.toggleThreads.bind(this)}
            >
              <DashboardSidebarToggleIcon
                expanded={this.state.threadsExpanded}
              />
            </button>
          </div>
        </div>
        <div className="chat-context-workspace">
          <ChatContextChip
            organisationId={this.props.organisationId}
            context={this.props.context}
            projects={
              this.state.page.kind === "ready"
                ? this.state.page.data.projectDirectory
                : null
            }
            conversation={
              this.state.page.kind === "ready"
                ? this.state.page.data.conversation
                : null
            }
          />
        </div>
      </>
    );
  },
};
