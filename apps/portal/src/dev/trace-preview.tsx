import { Select } from "../ui/select";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Check,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  FileText,
  FlaskConical,
  FolderSearch,
  Globe,
  ListChecks,
  ListTodo,
  LoaderCircle,
  Route,
  Search,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "../ui/trace";
import { usePortalTheme } from "../use-portal-theme";
import { TraceReferenceReplay } from "./trace-reference-replay";
import { ChatActivityPreview } from "./chat-activity-preview";
import "../styles.css";
import "./trace-preview.css";

type RowProps = {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly status?: TraceStatus;
  readonly description?: string;
};

function Row({
  icon: Icon,
  title,
  status = "completed",
  description,
}: RowProps): React.ReactNode {
  return (
    <TraceLine status={status}>
      <TraceIcon spinning={Icon === LoaderCircle && status === "running"}>
        <Icon />
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {description && <TraceDescription>{description}</TraceDescription>}
    </TraceLine>
  );
}

function Disclosure({
  children,
  defaultOpen = true,
  ...row
}: RowProps & {
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
}): React.ReactNode {
  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>
        <Row {...row} />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>{children}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function Output({ children }: { readonly children: string }): React.ReactNode {
  return (
    <pre className="trace-preview-output">
      <code>{children}</code>
    </pre>
  );
}

function Source({
  title,
  href,
}: {
  readonly title: string;
  readonly href: string;
}): React.ReactNode {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      <TraceLine status="completed">
        <TraceTitle>
          {title}
          <span className="trace-preview-sr"> (opens in a new tab)</span>
        </TraceTitle>
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
      </TraceLine>
    </a>
  );
}

function SourceRows(): React.ReactNode {
  return (
    <Trace>
      <Source
        title="Install Astro | docs.astro.build"
        href="https://docs.astro.build/en/install-and-setup/"
      />
      <Source
        title="create-astro | npmjs.com"
        href="https://www.npmjs.com/package/create-astro"
      />
      <Source title="pnpm create | pnpm.io" href="https://pnpm.io/cli/create" />
    </Trace>
  );
}

function ResearchRows(): React.ReactNode {
  return (
    <Trace>
      <Row icon={Search} title="Searched the code for cacheKey" />
      <Row icon={FileText} title="Read the build log for dpl_8Kx2" />
      <a href="https://vercel.com/docs/builds" target="_blank" rel="noreferrer">
        <TraceLine status="completed">
          <TraceIcon>
            <Globe />
          </TraceIcon>
          <TraceTitle>
            Read vercel.com/docs/builds
            <span className="trace-preview-sr"> (opens in a new tab)</span>
          </TraceTitle>
          <TraceIcon>
            <ArrowUpRight />
          </TraceIcon>
        </TraceLine>
      </a>
    </Trace>
  );
}

function Card({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <section className="trace-preview-example" aria-label={title}>
      <div className="trace-preview-card">
        <div className="trace-preview-card-surface" aria-hidden="true">
          <div className="trace-preview-dots">
            <i />
            <i />
            <i />
          </div>
        </div>
        <Trace>{children}</Trace>
      </div>
      <h2>{title}</h2>
    </section>
  );
}

function Gallery(): React.ReactNode {
  return (
    <div className="trace-preview-gallery">
      <Card title="Chain of Thought">
        <Disclosure icon={CircleCheck} title="Researched in 3 steps">
          <ResearchRows />
        </Disclosure>
      </Card>
      <Card title="Plan">
        <Disclosure
          icon={Route}
          title="Plan: migrate to Base UI"
          description="2/5"
        >
          <Trace>
            <Row icon={CircleCheck} title="Install @base-ui/react" />
            <Row icon={CircleCheck} title="Replace the Radix imports" />
            <Row
              icon={CircleDot}
              title="Rename asChild to render"
              status="running"
            />
            <Row
              icon={Circle}
              title="Update the data-state selectors"
              status="pending"
            />
            <Row icon={Circle} title="Run the type checker" status="pending" />
          </Trace>
        </Disclosure>
      </Card>
      <Card title="Queue">
        <Disclosure icon={ListTodo} title="3 to do">
          <Trace>
            <Row
              icon={Circle}
              title="Fix the focus ring on the select trigger"
            />
            <Row icon={Circle} title="Add tests for the combobox" />
            <Row icon={Circle} title="Write the migration guide" />
          </Trace>
        </Disclosure>
        <Disclosure icon={ListChecks} title="2 completed" defaultOpen={false}>
          <Trace>
            <Row icon={Check} title="Install Base UI" />
            <Row icon={Check} title="Replace the imports" />
          </Trace>
        </Disclosure>
      </Card>
      <Card title="Reasoning">
        <Disclosure icon={CircleCheck} title="Thought for 5s">
          <p>
            CI installs with a frozen lockfile, so the install stops when
            package.json and pnpm-lock.yaml disagree. I should check what the
            last commit changed, then reproduce the install.
          </p>
        </Disclosure>
      </Card>
      <Card title="Sources">
        <Disclosure icon={Globe} title="Used 3 sources">
          <SourceRows />
        </Disclosure>
      </Card>
      <Card title="Stack Trace">
        <Disclosure
          icon={CircleX}
          title="Failed: Cannot read properties of undefined"
          status="error"
        >
          <Output>
            {
              "TypeError: Cannot read properties of undefined\n  at UserList (app/components/user-list.tsx:15:23)\n  at renderWithHooks (react-dom.development.js:14985)\n  at beginWork (react-dom.development.js:19049:16)\n  at workLoopSync (react-dom.development.js:22707:5)"
            }
          </Output>
        </Disclosure>
      </Card>
      <Card title="Subagent">
        <Disclosure icon={CircleCheck} title="Ran the research agent">
          <Trace>
            <Row icon={Search} title="Searched for cacheKey" />
            <Row icon={FileText} title="Read scripts/build.ts" />
            <Disclosure icon={Terminal} title="Ran grep -rn cacheKey scripts">
              <Output>
                {
                  "scripts/build.ts:42: const cacheKey = hash()\nscripts/cache.ts:8: export function cacheKey()\nscripts/cache.ts:19: return cacheKey(env)"
                }
              </Output>
            </Disclosure>
          </Trace>
        </Disclosure>
      </Card>
      <Card title="Task">
        <Disclosure icon={FolderSearch} title="Found the project files">
          <Trace>
            <Row icon={Search} title="Searched for app/page.tsx" />
            <Row
              icon={FileText}
              title="Read app/layout.tsx"
              description="24 lines"
            />
            <Row
              icon={FileText}
              title="Read app/page.tsx"
              description="61 lines"
            />
            <Row
              icon={LoaderCircle}
              title="Scanning 52 files"
              status="running"
            />
          </Trace>
        </Disclosure>
      </Card>
      <Card title="Terminal">
        <Disclosure icon={Terminal} title="Ran pnpm build">
          <pre className="trace-preview-output">
            <code>{terminalLines.map(renderTerminalLine)}</code>
          </pre>
        </Disclosure>
      </Card>
      <Card title="Test Results">
        <Disclosure
          icon={FlaskConical}
          title="Ran 5 tests, 1 failed"
          status="error"
        >
          <Trace>
            <Row icon={Check} title="formats a price in USD" />
            <Row icon={Check} title="formats a price in EUR" />
            <Disclosure
              icon={X}
              title="rejects a negative price"
              status="error"
            >
              <Output>{"Expected: RangeError\nReceived: 0"}</Output>
            </Disclosure>
            <Row icon={Check} title="formats zero as free" />
          </Trace>
        </Disclosure>
      </Card>
      <Card title="Tool">
        <Disclosure icon={Terminal} title="Ran git status --short">
          <Output>{'{ "command": "git status --short" }'}</Output>
          <Output>
            {" M app/page.tsx\n M components/nav.tsx\n?? lib/cache.ts"}
          </Output>
        </Disclosure>
      </Card>
      <Card title="Trace">
        <Disclosure
          icon={CircleCheck}
          title="Thought for 4s"
          defaultOpen={false}
        >
          <p>
            Check the Node version and the package release age before the
            install.
          </p>
        </Disclosure>
        <Row icon={Search} title="Searched for minimumReleaseAge" />
        <Disclosure icon={Terminal} title="Ran node --version">
          <Output>v24.18.0</Output>
        </Disclosure>
      </Card>
    </div>
  );
}

const terminalLines = [
  "> next build",
  "  ▲ Next.js 16.0.0",
  "  Creating an optimized production build ...",
  "✓ Compiled successfully in 4.2s",
  "✓ Collecting page data",
  "✓ Generating static pages (12/12)",
];

function renderTerminalLine(line: string, index: number): React.ReactNode {
  return (
    <span className="trace-preview-terminal-line" key={line}>
      {line}
      {index < terminalLines.length - 1 ? "\n" : ""}
    </span>
  );
}

type ReplayState =
  | { readonly kind: "paused" | "playing"; readonly frame: number }
  | { readonly kind: "complete"; readonly frame?: never };
type TurnState = {
  readonly replay: ReplayState;
  readonly reasoningOpen: boolean | null;
};

class LiveTurn extends React.Component<object, TurnState> {
  state: TurnState = {
    replay: { kind: "paused", frame: 0 },
    reasoningOpen: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  componentWillUnmount(): void {
    this.stopTimer();
  }
  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  private advance(): void {
    this.setState(advanceReplay);
  }
  componentDidUpdate(): void {
    if (this.state.replay.kind === "complete") this.stopTimer();
  }
  private play(): void {
    this.stopTimer();
    this.setState(startReplay);
    this.timer = setInterval(this.advance.bind(this), 1200);
  }
  private pause(): void {
    this.stopTimer();
    this.setState(pauseReplay);
  }
  private reset(): void {
    this.stopTimer();
    this.setState({
      replay: { kind: "paused", frame: 0 },
      reasoningOpen: null,
    });
  }
  private changeReasoningOpen(open: boolean): void {
    this.setState({ reasoningOpen: open });
  }

  render(): React.ReactNode {
    const { replay, reasoningOpen } = this.state;
    const frame = replay.kind === "complete" ? 6 : replay.frame;
    const thinking = frame < 3;
    const running = replay.kind === "playing";
    return (
      <section className="trace-preview-live" aria-label="Live turn">
        <div className="trace-preview-live-heading">
          <div>
            <h2>A complete turn</h2>
            <p>Replay simulated events. Open any step to inspect its detail.</p>
          </div>
          <div className="trace-preview-controls">
            <button
              type="button"
              onClick={running ? this.pause.bind(this) : this.play.bind(this)}
            >
              {running ? "Pause" : "Replay"}
            </button>
            <button
              type="button"
              onClick={this.advance.bind(this)}
              disabled={running || replay.kind === "complete"}
            >
              Next event
            </button>
            <button type="button" onClick={this.reset.bind(this)}>
              Reset
            </button>
          </div>
        </div>
        <div className="trace-preview-turn">
          <p className="trace-preview-prompt">
            Why does pnpm install fail in CI?
          </p>
          <Trace aria-label="Agent activity">
            <TraceCollapsible
              open={reasoningOpen ?? thinking}
              onOpenChange={this.changeReasoningOpen.bind(this)}
            >
              <TraceCollapsibleTrigger>
                <Row
                  icon={thinking ? CircleDot : CircleCheck}
                  title={thinking ? "Thinking" : "Thought for 5s"}
                  status={thinking ? "running" : "completed"}
                />
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent keepMounted>
                <p>{reasoningText(frame)}</p>
              </TraceCollapsibleContent>
            </TraceCollapsible>
            {frame >= 3 && (
              <Disclosure
                icon={Terminal}
                title="Ran pnpm --version"
                defaultOpen={false}
              >
                <Output>10.18.0</Output>
              </Disclosure>
            )}
            {frame >= 4 && (
              <Disclosure
                icon={Terminal}
                title="Ran git diff --stat HEAD~1 -- package.json pnpm-lock.yaml"
              >
                <Output>
                  {
                    " package.json | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)"
                  }
                </Output>
              </Disclosure>
            )}
            {frame === 4 && (
              <Row
                icon={Terminal}
                title="Running pnpm install --frozen-lockfile"
                status="running"
              />
            )}
            {frame >= 5 && (
              <Disclosure
                icon={CircleX}
                title="Failed to run pnpm install --frozen-lockfile"
                status="error"
              >
                <Output>
                  {
                    "ERR_PNPM_OUTDATED_LOCKFILE\nCannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with package.json."
                  }
                </Output>
              </Disclosure>
            )}
            {frame >= 6 && (
              <Disclosure
                icon={Globe}
                title="Used 2 sources"
                defaultOpen={false}
              >
                <Trace>
                  <Source
                    title="pnpm install | pnpm.io"
                    href="https://pnpm.io/cli/install"
                  />
                  <Source
                    title="Builds | vercel.com"
                    href="https://vercel.com/docs/builds"
                  />
                </Trace>
              </Disclosure>
            )}
          </Trace>
          {frame >= 6 && (
            <p className="trace-preview-answer">
              The last commit changed package.json without an update to
              pnpm-lock.yaml. Run <code>pnpm install</code> locally and commit
              the lockfile.
            </p>
          )}
          <p className="trace-preview-progress" role="status">
            {replay.kind === "complete"
              ? "Replay complete"
              : `Event ${frame + 1} of 7 · ${replay.kind}`}
          </p>
        </div>
      </section>
    );
  }
}

function advanceReplay(state: TurnState): Pick<TurnState, "replay"> {
  const replay = state.replay;
  if (replay.kind === "complete" || replay.frame >= 5)
    return { replay: { kind: "complete" } };
  return { replay: { kind: replay.kind, frame: replay.frame + 1 } };
}
function startReplay(state: TurnState): TurnState {
  if (state.replay.kind === "complete")
    return { replay: { kind: "playing", frame: 0 }, reasoningOpen: null };
  return {
    replay: { kind: "playing", frame: state.replay.frame },
    reasoningOpen: state.reasoningOpen,
  };
}
function pauseReplay(state: TurnState): Pick<TurnState, "replay"> {
  if (state.replay.kind === "complete") return { replay: state.replay };
  return { replay: { kind: "paused", frame: state.replay.frame } };
}
function reasoningText(frame: number): string {
  if (frame === 0) return "CI installs with a frozen lockfile.";
  if (frame === 1)
    return "CI installs with a frozen lockfile, so the install stops when package.json and pnpm-lock.yaml disagree.";
  return "CI installs with a frozen lockfile, so the install stops when package.json and pnpm-lock.yaml disagree. I should check what the last commit changed, then reproduce the install.";
}

const MOTIONS = [
  { value: "normal", label: "Normal" },
  { value: "slow", label: "20% speed" },
  { value: "reduced", label: "Reduced" },
];

function changeMotion(value: string | null): void {
  if (value === null) return;
  document.documentElement.dataset.agentPreviewMotion = value;
  document.documentElement.style.setProperty(
    "--agent-motion-factor",
    value === "slow" ? "5" : "1",
  );
}

function TracePreview(): React.ReactNode {
  const { theme, toggleTheme } = usePortalTheme();
  return (
    <main className="trace-preview">
      <header className="trace-preview-header">
        <div>
          <p className="trace-preview-eyebrow">PURIN PANTRY / COMPONENTS</p>
          <h1>Trace</h1>
          <p>One composition for the work an agent does.</p>
        </div>
        <div className="trace-preview-controls">
          <label>
            Motion{" "}
            <Select.Root
              items={MOTIONS}
              onValueChange={changeMotion}
              defaultValue="normal"
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
          <button type="button" onClick={toggleTheme}>
            Use {theme === "light" ? "dark" : "light"} theme
          </button>
        </div>
      </header>
      <ChatActivityPreview />
      <TraceReferenceReplay>
        <Gallery />
      </TraceReferenceReplay>
      <LiveTurn />
      <footer>Gallery content and replay events are examples.</footer>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Trace preview is development-only.");
createRoot(root).render(<TracePreview />);
