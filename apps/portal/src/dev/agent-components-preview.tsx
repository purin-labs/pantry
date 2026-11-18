import { Select } from "../ui/select";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  Attachment,
  InlineCitations,
  MessageScroller,
  QuestionCard,
  ReasoningSteps,
  questionAnswerText,
  type QuestionAnswer,
  type QuestionSubmitResult,
  type ReasoningStep,
  type QuestionAvailability,
} from "../ui";
import { ActionMenuPreview } from "./action-menu-preview";
import { ResponseActionsPreview } from "./response-actions-preview";
import { TextComponentsPreview } from "./text-components-preview";
import { CrmTablePreview } from "./crm-table-preview";
import { SelectPreview } from "./select-preview";
import { usePortalTheme } from "../use-portal-theme";
import "../styles.css";
import "./agent-components-preview.css";

const MOTIONS = [
  { value: "normal", label: "Normal speed" },
  { value: "slow", label: "10% speed" },
  { value: "reduced", label: "Reduced motion preview" },
];

const sources = [
  {
    id: "orders",
    label: "Order export",
    description:
      "The accepted order snapshot includes tomorrow’s pickup quantities, tray assignments, and ingredient notes for all 38 confirmed orders. Review the production sheet before sharing it with the kitchen.",
    publisher: "Order ledger",
    publishedAt: "24 September 2026",
    href: new URL("https://example.com/orders"),
  },
  {
    id: "menu",
    label: "Bakery menu",
    description: "Published menu · revision 12",
    publisher: "Bakery menu",
    href: new URL("https://example.com/menu"),
  },
  {
    id: "receipt",
    label: "Execution receipt",
    description: "Internal evidence · no public link",
    href: null,
  },
];
const question = {
  id: "export-destination",
  title: "Who should receive the production sheet?",
  description: "Choose a team or describe another destination.",
  allowCustom: true,
  options: [
    {
      id: "kitchen",
      label: "Kitchen team",
      description: "Prepare tomorrow’s baking quantities.",
    },
    {
      id: "counter",
      label: "Counter team",
      description: "Check pickup orders and customer notes.",
    },
  ],
};

function previewQuestion(): typeof question {
  if (
    new URLSearchParams(window.location.search).get("question") !== "free-text"
  )
    return question;
  return {
    id: "delivery-notes",
    title: "What should the delivery team know?",
    description: "Include the receiving entrance and the delivery window.",
    allowCustom: true,
    options: [],
  };
}

function previewQuestionAvailability(): QuestionAvailability | undefined {
  switch (new URLSearchParams(window.location.search).get("availability")) {
    case "paused":
      return {
        kind: "paused",
        message: "Wait for the current response before you answer.",
      };
    case "closed":
      return {
        kind: "closed",
        message: "This question has already been answered.",
      };
    default:
      return undefined;
  }
}

type State = {
  readonly chunks: number;
  readonly completed: boolean;
  readonly response: string;
  readonly request: "idle" | "pending" | "failed" | "accepted";
  readonly reset: number;
};

class AgentComponentsScenario extends React.Component<object, State> {
  state: State = {
    chunks: 0,
    completed: false,
    response: "",
    request: "idle",
    reset: 0,
  };
  private settle: ((result: QuestionSubmitResult) => void) | null = null;

  componentWillUnmount(): void {
    document.documentElement.removeAttribute("data-agent-preview-motion");
    document.documentElement.style.removeProperty("--agent-motion-factor");
  }
  private changeMotion(value: string | null): void {
    if (value === null) return;
    document.documentElement.dataset.agentPreviewMotion = value;
    document.documentElement.style.setProperty(
      "--agent-motion-factor",
      value === "slow" ? "10" : "1",
    );
  }

  private append(): void {
    this.setState(incrementChunks);
  }
  private complete(): void {
    this.setState({ completed: true });
  }
  private reset(): void {
    this.settle?.({ kind: "failed", message: "Preview reset." });
    this.settle = null;
    this.setState(resetScenario);
  }
  private receiveAnswer(answer: QuestionAnswer): Promise<QuestionSubmitResult> {
    this.setState({
      request: "pending",
      response: questionAnswerText(answer),
    });
    return new Promise(this.captureResolver.bind(this));
  }
  private captureResolver(
    resolve: (result: QuestionSubmitResult) => void,
  ): void {
    this.settle = resolve;
  }
  private fail(): void {
    this.setState({ request: "failed" });
    this.settle?.({
      kind: "failed",
      message: "Connection interrupted. Your answer is preserved; try again.",
    });
    this.settle = null;
  }
  private accept(): void {
    this.setState({ request: "accepted" });
    this.settle?.({ kind: "accepted" });
    this.settle = null;
  }

  render(): React.ReactNode {
    const steps: ReasoningStep[] = [
      {
        id: "orders",
        label: "Read tomorrow’s pickup orders",
        detail: "38 confirmed orders from the accepted snapshot.",
        state: "completed",
      },
      {
        id: "menu",
        label: "Check the bakery menu",
        detail: "Matched product names and allergens.",
        state: "completed",
      },
      {
        id: "export",
        label: "Prepare the production sheet",
        detail: this.state.completed
          ? "Export receipt received."
          : "Waiting for the export tool to return.",
        state: this.state.completed ? "completed" : "running",
      },
    ];
    return (
      <main className="agent-preview">
        <header>
          <div>
            <p className="agent-preview-eyebrow">
              Seams Pantry · Component preview
            </p>
            <h1>A bakery export, from request to handoff</h1>
          </div>
          <ThemeToggle />
        </header>
        <p>
          Independent React components using the portal’s CSS tokens and
          existing icons.
        </p>
        <div className="agent-preview-controls" aria-label="Scenario controls">
          <label>
            Motion{" "}
            <Select.Root
              items={MOTIONS}
              defaultValue="normal"
              onValueChange={this.changeMotion.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {MOTIONS.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <button type="button" onClick={this.append.bind(this)}>
            Receive response chunk
          </button>
          <button
            type="button"
            onClick={this.complete.bind(this)}
            disabled={this.state.completed}
          >
            Receive export receipt
          </button>
          <button type="button" onClick={this.reset.bind(this)}>
            Reset scenario
          </button>
        </div>
        <SelectPreview />
        <TextComponentsPreview />
        <CrmTablePreview />
        <div className="agent-preview-grid">
          <section
            className="agent-preview-conversation"
            aria-label="Conversation preview"
          >
            <h2>Conversation</h2>
            <MessageScroller
              key={this.state.reset}
              label="Preview messages"
              className="agent-preview-scroller"
            >
              {Array.from({ length: 12 }, renderEarlierMessage)}
              <ReasoningSteps
                summary={
                  this.state.completed
                    ? "Production sheet prepared"
                    : "Preparing the production sheet"
                }
                steps={steps}
              />
              <p>
                The confirmed orders include 24 plain financiers and 14
                chocolate financiers. <InlineCitations sources={sources} />
              </p>
              {Array.from({ length: this.state.chunks }, renderChunk)}
              <Attachment
                name="tomorrow-production.csv"
                description="38 orders · CSV · 4 KB"
                state={
                  this.state.completed
                    ? {
                        kind: "ready",
                        href: new URL(
                          "/src/dev/agent-components-preview.csv",
                          window.location.origin,
                        ),
                      }
                    : { kind: "uploading", progress: 65 }
                }
              />
              <Attachment
                name="supplier-notes.pdf"
                description="Supplier document · PDF"
                state={{
                  kind: "unavailable",
                  reason: "Reconnect the source to open this file.",
                }}
              />
            </MessageScroller>
          </section>
          <section
            className="agent-preview-question"
            aria-label="Question preview"
          >
            <h2>Clarification</h2>
            <QuestionCard
              key={this.state.reset}
              question={previewQuestion()}
              availability={previewQuestionAvailability()}
              position={{ current: 1, total: 1 }}
              onSubmit={this.receiveAnswer.bind(this)}
            />
            <div className="agent-preview-controls">
              <button
                type="button"
                onClick={this.fail.bind(this)}
                disabled={this.state.request !== "pending"}
              >
                Simulate failed delivery
              </button>
              <button
                type="button"
                onClick={this.accept.bind(this)}
                disabled={this.state.request !== "pending"}
              >
                Accept answer
              </button>
            </div>
            <p role="status">
              {this.state.request === "idle"
                ? "No answer sent."
                : `Delivery: ${this.state.request}. Answer: ${this.state.response}`}
            </p>
            <ResponseActionsPreview key={`actions-${this.state.reset}`} />
            <ActionMenuPreview key={`menu-${this.state.reset}`} />
          </section>
        </div>
      </main>
    );
  }
}

function ThemeToggle(): React.ReactNode {
  const { theme, toggleTheme } = usePortalTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      Use {theme === "light" ? "dark" : "light"} theme
    </button>
  );
}

function incrementChunks(state: State): Pick<State, "chunks"> {
  return { chunks: state.chunks + 1 };
}
function resetScenario(state: State): State {
  return {
    chunks: 0,
    completed: false,
    response: "",
    request: "idle",
    reset: state.reset + 1,
  };
}
function renderEarlierMessage(_value: unknown, index: number): React.ReactNode {
  return (
    <article key={`earlier-${index}`} className="agent-preview-message">
      <strong>Order review {index + 1}</strong>
      <p>
        Checked quantities, pickup windows, and ingredient notes for the morning
        production run. The operator can keep reading this history while new
        results arrive.
      </p>
    </article>
  );
}
function renderChunk(_value: unknown, index: number): React.ReactNode {
  return (
    <p key={`chunk-${index}`}>
      Response chunk {index + 1}: The production sheet includes the accepted
      quantities, tray assignments, and pickup windows. Review the export before
      sharing it with the team.
    </p>
  );
}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Agent component preview is development-only.");
createRoot(root).render(<AgentComponentsScenario />);
