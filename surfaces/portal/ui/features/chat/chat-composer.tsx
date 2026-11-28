import { DEFAULT_GOAL_TOKEN_BUDGET } from "./goal";
import {
  newConversationId,
  sideCaseHereRequestId,
  type ChatSideCaseView,
} from "@purin-labs/control-api";
import {
  MESSAGE_ATTACHMENT_POLICY,
  type ConversationId,
} from "@purin-labs/control-api";
import {
  clearSubmittedDraft,
  removeAcceptedQueue,
  restoreQueuedDraft,
  withoutOutgoing,
} from "./submission";
import {
  questionAnswerText,
  type QuestionAnswer,
  type QuestionAvailability,
  type QuestionSubmitResult,
} from "@purin-labs/ui/index";
import React from "react";
import { holdSendForScreenQuestion } from "./screen-chip";
import { updateSavedDraft } from "./page-state";
import {
  cancelChat,
  ChatDraftConflictError,
  ChatNotRunningError,
  saveChatDraft,
} from "./api";
import { sendChat } from "./screen-send";
import { bakerySurfaceForOrganisation } from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import { errorMessage } from "@purin-labs/std";
import {
  selectedEffortFromState,
  selectedModelFromState,
} from "./model-choice";
import type { ChatPage } from "./route";
import {
  STOP_RETRY_AFTER_MS,
  chatAttachmentLimits,
  chatWorkIsRetryable,
  invalidChatFile,
  keepSelectedFile,
  latestConversationMessage,
  timelineEventHasId,
  totalFileBytes,
} from "./chat-route-helpers";

export const chatComposerMethods = {
  changeDraft(
    this: ChatPage,
    event: React.ChangeEvent<HTMLTextAreaElement>,
  ): void {
    this.draftDirty = true;
    this.setState({ draft: event.currentTarget.value });
    this.scheduleDraftSave();
  },

  scheduleDraftSave(this: ChatPage): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(this.saveDraft.bind(this), 500);
  },

  async saveDraft(this: ChatPage): Promise<void> {
    this.draftSaveTimer = null;
    if (this.draftSavePromise !== null) {
      await this.draftSavePromise;
      if (this.draftDirty) await this.saveDraft();
      return;
    }
    const save = this.persistDraft();
    this.draftSavePromise = save;
    try {
      await save;
    } finally {
      if (this.draftSavePromise === save) this.draftSavePromise = null;
    }
  },

  async persistDraft(this: ChatPage): Promise<void> {
    if (
      !this.draftDirty ||
      this.conversationId === null ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.conversation === null
    )
      return;
    const conversation = this.state.page.data.conversation;
    let expectedUpdatedAt = conversation.draft.updatedAt;
    try {
      while (this.draftDirty && this.conversationId === conversation.id) {
        const draft = this.state.draft;
        const saved = await saveChatDraft(
          this.props.organisationId,
          conversation.id,
          draft,
          expectedUpdatedAt,
        );
        expectedUpdatedAt = saved.updatedAt;
        if (this.conversationId !== conversation.id) return;
        if (this.state.draft === draft) this.draftDirty = false;
        if (this.mounted) {
          this.setState(updateSavedDraft.bind(null, saved, conversation.id));
          this.setState({ draftConflictNotice: null });
        }
      }
    } catch (error) {
      if (!this.mounted) return;
      if (error instanceof ChatDraftConflictError) {
        this.draftDirty = true;
        this.setState({
          draftConflictNotice: { conversationId: conversation.id },
        });
        return;
      }
      this.setState({
        error: errorMessage(error, "Something went wrong. Try again."),
      });
    }
  },

  cancelDraftSave(this: ChatPage): void {
    if (this.draftSaveTimer === null) return;
    window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
  },

  dismissDraftConflict(this: ChatPage): void {
    this.setState({ draftConflictNotice: null });
  },

  async flushDraftSave(this: ChatPage): Promise<void> {
    this.cancelDraftSave();
    await this.saveDraft();
  },

  choosePrompt(this: ChatPage, text: string): void {
    this.draftDirty = true;
    this.setState({ draft: text });
    this.scheduleDraftSave();
    this.composer.current?.focus();
  },

  submit(this: ChatPage, event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    this.submitDraft(false);
  },

  composerKeyDown(
    this: ChatPage,
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    this.submitDraft(event.ctrlKey);
  },

  submitDraft(this: ChatPage, steer: boolean): void {
    const text = this.state.draft.trim();
    if (!text || text.length > 8000 || this.state.steering || this.isArchived())
      return;
    const goalCommand = /^\/goal(?:\s+([\s\S]+))?$/.exec(text);
    if (goalCommand !== null) {
      void this.runGoalCommand(goalCommand[1]?.trim() ?? null);
      return;
    }
    if (holdSendForScreenQuestion(text)) return;
    if (this.isWorking()) {
      if (steer) {
        void this.steer(text);
        return;
      }
      void this.enqueue(text);
      return;
    }
    void this.send(text, null);
  },

  /** "New chat from this page": the draft leaves this chat for a new one. */
  async moveDraftToNewChat(this: ChatPage, text: string): Promise<void> {
    await new Promise<void>((done) => this.setState({ draft: "" }, done));
    this.draftDirty = true;
    await this.selectThread(null, true);
    this.draftDirty = true;
    this.setState({ draft: text });
  },

  clearDraft(this: ChatPage): void {
    this.draftDirty = true;
    this.setState({ draft: "" });
    this.scheduleDraftSave();
  },

  /** `/goal` opens the goal drawer; `/goal <objective>` sets it and starts. */
  async runGoalCommand(
    this: ChatPage,
    objective: string | null,
  ): Promise<void> {
    const goal = this.goal.current;
    if (goal === null) {
      // A new chat has no goal to edit yet. `/goal <objective>` starts the chat
      // with the message as its goal; the server sets it before the turn runs.
      if (objective === null) {
        this.setState({ error: "Type /goal followed by what you want done." });
        return;
      }
      this.draftDirty = true;
      this.setState({ draft: objective, error: null }, () => {
        void this.send(objective, null, DEFAULT_GOAL_TOKEN_BUDGET);
      });
      return;
    }
    if (objective === null) {
      this.clearDraft();
      goal.openEditor();
      return;
    }
    if (!(await goal.startGoal(objective))) return;
    this.draftDirty = true;
    this.setState({ draft: objective, error: null }, () => {
      void this.send(objective, null);
    });
  },

  async enqueue(this: ChatPage, text: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null || this.state.page.kind !== "ready")
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const conversationId = this.conversationId;
    const ticket = this.submissions.begin(conversationId, "queue", text);
    if (ticket === null) return;
    try {
      if (
        this.pendingQueueAdmission === null ||
        this.pendingQueueAdmission.text !== text ||
        this.pendingQueueAdmission.model !== model ||
        this.pendingQueueAdmission.effort !== effort ||
        this.pendingQueueAdmission.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (!this.mounted || selectionVersion !== this.selectionVersion) return;
        if (capture.kind === "failed") {
          this.setState({ error: capture.message });
          return;
        }
        this.pendingQueueAdmission = {
          inputId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          model,
          text,
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
        };
      }
      const pending = this.pendingQueueAdmission;
      await this.prepareComposerSubmission(text, selectionVersion);
      this.cancelDraftSave();
      this.draftDirty = false;
      this.setState(clearSubmittedDraft.bind(null, text));
      this.setState({ error: null, draftConflictNotice: null });
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "next",
          conversationId,
          requestId: pending.requestId,
          inputId: pending.inputId,
          model: pending.model,
          text: pending.text,
          browserContext: pending.browserContext,
          effort: pending.effort,
        },
        pending.files,
      );
      this.clearSubmittedFiles(conversationId, pending.files);
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.pendingQueueAdmission = null;
        this.acceptConversation(conversation);
      }
    } catch (error) {
      if (!this.mounted || selectionVersion !== this.selectionVersion) return;
      if (error instanceof ChatNotRunningError) {
        this.sendAfterFinishedTurn(text);
        return;
      }
      this.setState(
        restoreQueuedDraft.bind(
          null,
          text,
          errorMessage(error, "Something went wrong. Try again."),
        ),
      );
    } finally {
      this.submissions.settle(ticket);
    }
  },

  /**
   * The server finished the turn while the Portal still showed it. The message
   * starts the next turn, with its files, and the person does nothing.
   */
  sendAfterFinishedTurn(this: ChatPage, text: string): void {
    this.pendingQueueAdmission = null;
    this.pendingSteering = null;
    this.setState(
      restoreQueuedDraft.bind(null, text, null),
      this.sendRestoredDraft.bind(this, text),
    );
  },

  sendRestoredDraft(this: ChatPage, text: string): void {
    void this.send(text, null);
  },

  removeQueued(this: ChatPage, id: string): void {
    void this.withdrawQueued(id);
  },

  async withdrawQueued(this: ChatPage, inputId: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null) return;
    try {
      const conversation = await sendChat(this.props.organisationId, {
        kind: "withdraw",
        conversationId: this.conversationId,
        inputId,
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(conversation);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    }
  },

  /** The message stays in the queue until the server has moved it. */
  async steerQueued(this: ChatPage, inputId: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.conversationId === null)
      return;
    const conversation = this.state.page.data.conversation;
    if (conversation === null || this.state.steeringQueuedId !== null) return;
    this.setState({ steeringQueuedId: inputId, error: null });
    try {
      const steered = await sendChat(this.props.organisationId, {
        kind: "steer_queued",
        conversationId: this.conversationId,
        inputId,
        cancellationId: crypto.randomUUID(),
        model: conversation.model,
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(steered);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ steeringQueuedId: null });
    }
  },

  /** A stop and a steer settle in seconds, so Retry stop waits for a stuck one. */
  watchStopRetry(this: ChatPage): void {
    const work =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation?.work
        : undefined;
    const cancellation =
      work?.kind === "cancelling" ? work.cancellationId : null;
    if (cancellation === this.watchedCancellation) return;
    this.watchedCancellation = cancellation;
    if (this.stopRetryTimer !== null) window.clearTimeout(this.stopRetryTimer);
    this.stopRetryTimer =
      cancellation === null
        ? null
        : window.setTimeout(
            this.offerStopRetry.bind(this, cancellation),
            STOP_RETRY_AFTER_MS,
          );
  },

  offerStopRetry(this: ChatPage, cancellation: string): void {
    this.stopRetryTimer = null;
    this.setState({ stopRetryDueFor: cancellation });
  },

  async stop(this: ChatPage): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.conversationId === null)
      return;
    const conversation = this.state.page.data.conversation;
    if (
      conversation === null ||
      (conversation.work.kind !== "running" &&
        conversation.work.kind !== "cancelling")
    )
      return;
    const work = conversation.work;
    this.stopStream();
    this.setState({ sending: true, error: null });
    try {
      const stopped = await cancelChat(this.props.organisationId, {
        conversationId: conversation.id,
        requestId: work.requestId,
        sessionId: work.sessionId,
        turnId: work.turnId,
        cancellationId:
          work.kind === "cancelling"
            ? work.cancellationId
            : crypto.randomUUID(),
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(stopped);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
        await this.refresh();
      }
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  },

  async steer(this: ChatPage, text: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null || this.state.page.kind !== "ready")
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const conversationId = this.conversationId;
    const ticket = this.submissions.begin(conversationId, "steer", text);
    if (ticket === null) return;
    try {
      if (
        this.pendingSteering === null ||
        this.pendingSteering.text !== text ||
        this.pendingSteering.model !== model ||
        this.pendingSteering.effort !== effort ||
        this.pendingSteering.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (!this.mounted || selectionVersion !== this.selectionVersion) return;
        if (capture.kind === "failed") {
          this.setState({ error: capture.message });
          return;
        }
        this.pendingSteering = {
          inputId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          cancellationId: crypto.randomUUID(),
          model,
          text,
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
        };
      }
      const pending = this.pendingSteering;
      this.setState({ steering: true, error: null });
      await this.prepareComposerSubmission(text, selectionVersion);
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "steer",
          conversationId,
          requestId: pending.requestId,
          inputId: pending.inputId,
          cancellationId: pending.cancellationId,
          model: pending.model,
          text: pending.text,
          browserContext: pending.browserContext,
          effort: pending.effort,
        },
        pending.files,
      );
      this.clearSubmittedFiles(conversationId, pending.files);
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.pendingSteering = null;
        this.acceptConversation(conversation);
        this.draftDirty = false;
        this.setState(clearSubmittedDraft.bind(null, text));
      }
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion) {
        if (error instanceof ChatNotRunningError) {
          this.sendAfterFinishedTurn(text);
          return;
        }
        if (this.state.draft.trim() === text.trim()) this.draftDirty = true;
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
      }
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ steering: false });
    }
  },

  async attachBakeryFile(
    this: ChatPage,
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const surface = bakerySurfaceForOrganisation(this.props.organisationId);
    if (file === undefined || surface === null) return;
    const selectionVersion = this.selectionVersion;
    try {
      const attached = await surface.attachFile(file);
      if (!this.mounted || selectionVersion !== this.selectionVersion) return;
      const draft = `${this.state.draft}\nAttached Kitchen file: ${JSON.stringify(attached.name)}; SHA-256: ${attached.digest}; bytes: ${attached.bytes}. Prepare this file for review.`;
      if (draft.length > 8000)
        throw new Error("Shorten the message before attaching a file.");
      this.draftDirty = true;
      this.setState({ draft, error: null });
      this.scheduleDraftSave();
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(
            error,
            "Unable to attach the Kitchen file.",
          ),
        });
    }
  },

  attachFiles(
    this: ChatPage,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    this.addFiles(files);
  },

  addFiles(this: ChatPage, added: readonly File[]): void {
    if (added.length === 0 || !this.canAttachFiles()) return;
    const files = [...this.state.files, ...added];
    if (
      files.length > MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage ||
      files.some(invalidChatFile) ||
      files.reduce(totalFileBytes, 0) > MESSAGE_ATTACHMENT_POLICY.maxBatchBytes
    ) {
      this.setState({ error: chatAttachmentLimits() });
      return;
    }
    this.threadFiles.set(this.conversationId ?? "draft", files);
    this.setState({ files, error: null });
  },

  canAttachFiles(this: ChatPage): boolean {
    if (
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready" ||
      this.state.sending ||
      this.state.steering ||
      chatWorkIsRetryable(this.state.page.data.conversation?.work)
    )
      return false;
    const conversation = this.state.page.data.conversation;
    return (
      conversation?.lifecycle !== "archived" &&
      conversation?.sharing?.role !== "viewer" &&
      conversation?.work.kind !== "cancelling"
    );
  },

  dragFiles(this: ChatPage, event: React.DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = this.canAttachFiles() ? "copy" : "none";
  },

  dropFiles(this: ChatPage, event: React.DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    this.addFiles(Array.from(event.dataTransfer.files));
  },

  pasteFiles(
    this: ChatPage,
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    this.addFiles(files);
    if (event.clipboardData.getData("text/plain").length === 0)
      event.preventDefault();
  },

  removeFile(this: ChatPage, file: File): void {
    const files = this.state.files.filter(keepSelectedFile.bind(null, file));
    this.threadFiles.set(this.conversationId ?? "draft", files);
    this.setState({ files });
  },

  clearSubmittedFiles(
    this: ChatPage,
    conversationId: ConversationId,
    files: readonly File[],
  ): void {
    if (this.threadFiles.get(conversationId) === files)
      this.threadFiles.delete(conversationId);
    if (
      this.mounted &&
      this.conversationId === conversationId &&
      this.state.files === files
    )
      this.setState({ files: [] });
  },

  async prepareComposerSubmission(
    this: ChatPage,
    text: string,
    selectionVersion: number,
  ): Promise<void> {
    await this.flushDraftSave();
    if (!this.mounted || selectionVersion !== this.selectionVersion)
      throw new Error("The selected conversation changed.");
    if (
      this.state.page.kind === "ready" &&
      this.state.page.data.conversation !== null &&
      this.draftDirty
    )
      throw new Error("Your draft could not be saved. Try again.");
    // Navigation must not autosave accepted text back into the composer.
    if (this.state.draft.trim() === text.trim()) {
      this.cancelDraftSave();
      this.draftDirty = false;
    }
  },

  async answerQuestion(
    this: ChatPage,
    eventId: string,
    title: string,
    answer: QuestionAnswer,
  ): Promise<QuestionSubmitResult> {
    const availability = this.questionAvailability(eventId);
    if (availability !== undefined)
      return { kind: "failed", message: availability.message };
    const text = questionAnswerText(answer);
    return this.send(`${title}\n\n${text}`, null);
  },

  questionAvailability(
    this: ChatPage,
    eventId: string,
  ): QuestionAvailability | undefined {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    if (
      conversation === null ||
      conversation.lifecycle === "archived" ||
      (conversation.sharing?.visibility === "shared" &&
        conversation.sharing.role === "viewer")
    )
      return { kind: "closed", message: "This conversation is read-only." };
    const selected = conversation.timeline.find(
      timelineEventHasId.bind(null, eventId),
    );
    if (
      conversation.lineage.kind === "fork" &&
      selected !== undefined &&
      selected.sequence <= conversation.lineage.throughSequence
    )
      return {
        kind: "closed",
        message: "Inherited question from the source chat.",
      };
    const latestMessage = latestConversationMessage(conversation.timeline);
    if (latestMessage?.eventId !== eventId)
      return {
        kind: "closed",
        message: "Continued below in the conversation.",
      };
    if (
      this.isWorking() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready"
    )
      return {
        kind: "paused",
        message: "Wait until the assistant is ready to receive your answer.",
      };
    return undefined;
  },

  async send(
    this: ChatPage,
    text: string,
    queuedId: string | null,
    goalTokenBudget: number | null = null,
  ): Promise<QuestionSubmitResult> {
    const selectionVersion = this.selectionVersion;
    if (
      text.trim().length === 0 ||
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      this.state.page.kind !== "ready"
    ) {
      const message = "Wait for the current message to finish sending.";
      if (text.trim().length > 0) this.setState({ error: message });
      return { kind: "failed", message };
    }
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null)
      return {
        kind: "failed",
        message: "Connect an AI before sending your answer.",
      };
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const started = this.startConversation();
    const ticket = this.submissions.begin(started, "send", text);
    this.setState({ sending: true, error: null });
    try {
      // The thread shows the message before the context capture, the draft
      // save and the send finish; the composer shows it as sent.
      this.setState(
        { outgoing: { conversationId: started, text: text.trim() } },
        this.scrollToLatest.bind(this),
      );
      if (
        this.pending === null ||
        this.pending.text !== text.trim() ||
        this.pending.model !== model ||
        this.pending.effort !== effort ||
        this.pending.goalTokenBudget !== goalTokenBudget ||
        this.pending.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (capture.kind === "failed") throw new Error(capture.message);
        if (!this.mounted || selectionVersion !== this.selectionVersion)
          return {
            kind: "failed",
            message: "The selected conversation changed.",
          };
        this.pending = {
          requestId: crypto.randomUUID(),
          model,
          text: text.trim(),
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
          goalTokenBudget,
        };
      }
      await this.prepareComposerSubmission(text, selectionVersion);
      const submittedFiles = this.pending.files;
      const conversationId = started;
      this.scrollToLatest();
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "message",
          conversationId,
          requestId: this.pending.requestId,
          model: this.pending.model,
          text: this.pending.text,
          browserContext: this.pending.browserContext,
          effort: this.pending.effort,
          ...(this.pending.goalTokenBudget === null
            ? {}
            : { goalTokenBudget: this.pending.goalTokenBudget }),
        },
        this.pending.files,
      );
      this.clearSubmittedFiles(conversationId, submittedFiles);
      if (!this.mounted || selectionVersion !== this.selectionVersion)
        return { kind: "accepted" };
      this.pending = null;
      if (queuedId !== null)
        this.setState(removeAcceptedQueue.bind(null, queuedId));
      this.acceptConversation(conversation);
      if (this.state.draft.trim() === text.trim()) this.draftDirty = false;
      this.setState(clearSubmittedDraft.bind(null, text));
      this.setState({ outgoing: null });
      return { kind: "accepted" };
    } catch (error) {
      const message = errorMessage(error, "Something went wrong. Try again.");
      if (this.mounted && selectionVersion === this.selectionVersion) {
        // A failed message goes back to the composer, unless the person
        // typed a new one while it was sending.
        if (this.state.draft.trim() === "") this.setState({ draft: text });
        if (this.state.draft.trim() === text.trim()) this.draftDirty = true;
        this.setState({ error: message, outgoing: null });
        await this.refresh();
      }
      return { kind: "failed", message };
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted) this.setState(withoutOutgoing.bind(null, started));
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  },

  /** The selected conversation, or a new one for the first message of a new chat. */
  startConversation(this: ChatPage): ConversationId {
    if (this.conversationId !== null) return this.conversationId;
    this.conversationId = newConversationId();
    this.threadFiles.delete("draft");
    this.threadFiles.set(this.conversationId, this.state.files);
    this.updateLocation(false);
    return this.conversationId;
  },

  /** The sent message that this thread shows before the server accepts it. */
  outgoingText(this: ChatPage): string | null {
    const outgoing = this.state.outgoing;
    return outgoing !== null && outgoing.conversationId === this.conversationId
      ? outgoing.text
      : null;
  },

  /** "Do it here" on a side Case card: the brief is the next message. */
  async sendSideCaseHere(
    this: ChatPage,
    card: ChatSideCaseView,
  ): Promise<void> {
    if (this.isArchived())
      throw new Error("Restore this chat to do the work here.");
    if (this.isWorking())
      throw new Error(
        "Wait for the current answer to finish, then choose Do it here.",
      );
    if (
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      this.state.page.kind !== "ready" ||
      this.conversationId === null
    )
      throw new Error("Wait for the current message to finish sending.");
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null)
      throw new Error("Connect an AI before sending your answer.");
    const selectionVersion = this.selectionVersion;
    const ticket = this.submissions.begin(
      this.conversationId,
      "send",
      card.brief,
    );
    this.setState({ sending: true, error: null });
    try {
      // A proposal is a complete brief. Keep its retry payload independent of
      // the browser session, the current composer draft and selected files.
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "message",
          conversationId: this.conversationId,
          requestId: sideCaseHereRequestId(card.proposalId),
          model,
          effort: selectedEffortFromState(
            this.state.selectedEffort,
            this.state.page.data,
          ),
          text: card.brief,
          browserContext: { kind: "unavailable" },
        },
        [],
      );
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.acceptConversation(conversation);
        this.scrollToLatest();
      }
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  },

  async retry(this: ChatPage): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.state.sending) return;
    const conversation = this.state.page.data.conversation;
    if (conversation === null || !chatWorkIsRetryable(conversation.work))
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    this.setState({ sending: true, error: null });
    try {
      const result = await sendChat(this.props.organisationId, {
        kind: "retry",
        conversationId: conversation.id,
        requestId: conversation.work.requestId,
        model,
        effort,
      });
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.stopStream();
        this.setState(
          { stream: { kind: "idle" } },
          this.acceptConversation.bind(this, result),
        );
      }
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  },
};
