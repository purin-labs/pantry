import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { Croissant } from "lucide-react";
import {
  PermissionRequestCard,
  PermissionRequestDialog,
  PantryMark,
  type PermissionRequestCardProps,
  type PermissionRequestItem,
} from "@purin-labs/ui/index";
import { AGENT_NAME } from "@purin-labs/ui/agent-name";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import "@purin-labs/surface-portal/ui/styles.css";
import "./agent-components-preview.css";
import { ChatAgentPermissionSample } from "./chat-agent-permission-preview";

const items: readonly PermissionRequestItem[] = [
  {
    id: "read-public-link",
    label: "Read a public link from a message",
    description: "Open the page that you shared in this chat.",
    required: true,
  },
  {
    id: "draft-connectors",
    label: "Draft custom connectors",
    description: "Prepare a connector for review. Nothing is installed.",
    required: false,
  },
  {
    id: "read-menu",
    label: "Read the published menu",
    description: null,
    required: false,
  },
  {
    id: "read-orders",
    label: "Read today's online orders",
    description: "Order numbers, items and pickup times. No payment details.",
    required: false,
  },
  {
    id: "draft-slack",
    label: "Draft Slack messages for #kitchen",
    description: "A person sends each message from the chat.",
    required: false,
  },
  {
    id: "read-stock",
    label: "Read stock levels for butter and flour",
    description: null,
    required: false,
  },
  {
    id: "propose-order",
    label: "Prepare a supplier order",
    description: "The order waits for an owner to approve it.",
    required: false,
  },
];

/** The brand README: dark marks for light surfaces, light marks for dark. */
const requester = { name: AGENT_NAME, icon: <PantryMark /> };
const target = { name: "Noix de Beurre", icon: <Croissant size={22} /> };
const signedInAs = {
  name: "Camille Laurent",
  action: { label: "Switch account", onSelect: noop },
};

function usePreviewSelection(): {
  readonly selectedIds: readonly string[];
  readonly onSelectionChange: (ids: readonly string[]) => void;
} {
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([
    "read-public-link",
    "draft-connectors",
  ]);
  return { selectedIds, onSelectionChange: setSelectedIds };
}

function sharedProps(): Omit<
  PermissionRequestCardProps,
  "decision" | "selectedIds" | "onSelectionChange"
> {
  return {
    requester,
    target,
    title: `${AGENT_NAME} would like to read a public link`,
    subtitle: "Only allow this if you trust the request.",
    listHeading: `This will allow ${AGENT_NAME} to:`,
    items,
    footnote: "Remove it later in Access and data flow.",
    signedInAs,
  };
}

function GrantSample(
  props: Readonly<{ onResult: (text: string) => void }>,
): React.ReactNode {
  const selection = usePreviewSelection();
  return (
    <PermissionRequestCard
      {...sharedProps()}
      {...selection}
      decision={{
        kind: "grant",
        pending: null,
        error: null,
        onAllow: (ids) => {
          props.onResult(`Allowed: ${ids.join(", ")}.`);
          return Promise.resolve(true);
        },
        onDeny: props.onResult.bind(null, "Denied."),
      }}
    />
  );
}

function PendingSample(): React.ReactNode {
  const selection = usePreviewSelection();
  const [pending, setPending] = React.useState<"allow" | "deny" | null>(
    "allow",
  );
  return (
    <div>
      <PermissionRequestCard
        {...sharedProps()}
        {...selection}
        signedInAs={null}
        footnote={null}
        decision={{
          kind: "grant",
          pending,
          error: null,
          onAllow: () => {
            setPending("allow");
            return Promise.resolve(true);
          },
          onDeny: setPending.bind(null, "deny"),
        }}
      />
      <div className="agent-preview-controls">
        <button type="button" onClick={setPending.bind(null, null)}>
          Clear pending
        </button>
      </div>
    </div>
  );
}

function ErrorSample(): React.ReactNode {
  const selection = usePreviewSelection();
  return (
    <PermissionRequestCard
      {...sharedProps()}
      {...selection}
      footnote={null}
      decision={{
        kind: "grant",
        allowLabel: "Allow once",
        denyLabel: "Not now",
        pending: null,
        error:
          "Access could not be saved. Check your connection and try again.",
        onAllow: () => Promise.resolve(false),
        onDeny: noop,
      }}
    />
  );
}

function ExplainSample(
  props: Readonly<{ onResult: (text: string) => void }>,
): React.ReactNode {
  const selection = usePreviewSelection();
  const [pending, setPending] = React.useState<"primary" | "secondary" | null>(
    null,
  );
  return (
    <PermissionRequestCard
      {...sharedProps()}
      {...selection}
      subtitle="Your role cannot grant this access."
      footnote={null}
      decision={{
        kind: "explain",
        message: (
          <>
            <p>
              <strong>An owner of Noix de Beurre must allow this.</strong>
            </p>
            <p>
              Ask Hélène Moreau or another owner. The run waits until they
              answer.
            </p>
          </>
        ),
        pending,
        error: null,
        primary: {
          label: "Check again",
          onSelect: checkAgain.bind(null, setPending, props.onResult),
        },
        secondary: {
          label: "Stop run",
          onSelect: props.onResult.bind(null, "Run stopped."),
        },
      }}
    />
  );
}

/**
 * A short request opens as the compact sheet; the full one as the split card.
 * After a decision the dialog resizes to the result card.
 */
function DialogSample(
  props: Readonly<{ onResult: (text: string) => void; compact: boolean }>,
): React.ReactNode {
  const selection = usePreviewSelection();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<"allow" | "deny" | null>(null);
  const [decided, setDecided] = React.useState<"allow" | "deny" | null>(null);
  const timer = React.useRef(0);
  React.useEffect(clearTimerOnUnmount.bind(null, timer), []);
  const decide = (
    choice: "allow" | "deny",
    ids: readonly string[],
  ): Promise<boolean> => {
    setPending(choice);
    return new Promise((resolve) => {
      timer.current = window.setTimeout(() => {
        setPending(null);
        setDecided(choice);
        props.onResult(
          choice === "allow"
            ? `Allowed from the dialog: ${ids.join(", ")}.`
            : "Denied from the dialog.",
        );
        resolve(true);
      }, 1200);
    });
  };
  const close = (): void => {
    setOpen(false);
    setDecided(null);
  };
  return (
    <>
      <button type="button" onClick={setOpen.bind(null, true)}>
        {props.compact ? "Open compact dialog" : "Open permission dialog"}
      </button>
      <PermissionRequestDialog
        {...sharedProps()}
        {...(props.compact ? { items: items.slice(0, 2) } : {})}
        {...selection}
        open={open}
        onClose={close}
        decision={
          decided === null
            ? {
                kind: "grant",
                pending,
                error: null,
                onAllow: decide.bind(null, "allow"),
                onDeny: () => void decide("deny", []),
              }
            : {
                kind: "result",
                tone: decided === "allow" ? "allowed" : "denied",
                title:
                  decided === "allow" ? "Request allowed" : "Request denied",
                message:
                  decided === "allow"
                    ? `${AGENT_NAME} can now read the public link. The agent continues in the chat.`
                    : "The agent stopped the request.",
                pending: null,
                error: null,
                primary: { label: "Close", onSelect: close },
                secondary: null,
              }
        }
      />
    </>
  );
}

function PermissionRequestPreview(): React.ReactNode {
  const { theme, toggleTheme } = usePortalTheme();
  const [result, setResult] = React.useState("No decision yet.");
  return (
    <main className="agent-preview">
      <Toaster position="bottom-right" offset={16} gap={10} />
      <header>
        <div>
          <p className="agent-preview-eyebrow">
            Purin Pantry · Component preview
          </p>
          <h1>Permission requests</h1>
        </div>
        <button type="button" onClick={toggleTheme}>
          Use {theme === "light" ? "dark" : "light"} theme
        </button>
      </header>
      <p>
        A consent card for agent permission requests. The caller owns the
        selection, the pending state, and the decision.
      </p>
      <div className="agent-preview-controls">
        <DialogSample onResult={setResult} compact={false} />
        <DialogSample onResult={setResult} compact={true} />
      </div>
      <p role="status">{result}</p>
      <div style={previewGrid}>
        <section aria-label="Grant mode" style={previewColumn}>
          <h2>Grant</h2>
          <GrantSample onResult={setResult} />
        </section>
        <section aria-label="Pending state" style={previewColumn}>
          <h2>Pending</h2>
          <PendingSample />
        </section>
        <section aria-label="Error state" style={previewColumn}>
          <h2>Error</h2>
          <ErrorSample />
        </section>
        <section aria-label="Explain mode" style={previewColumn}>
          <h2>Explain</h2>
          <ExplainSample onResult={setResult} />
        </section>
        <section aria-label="Portal chat agent request" style={previewColumn}>
          <h2>Portal chat agent request</h2>
          <ChatAgentPermissionSample role="owner" />
          <ChatAgentPermissionSample role="member" />
        </section>
      </div>
    </main>
  );
}

const previewGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 400px), 1fr))",
  gap: 32,
  alignItems: "start",
};
const previewColumn: React.CSSProperties = { minWidth: 0 };

function checkAgain(
  setPending: (pending: "primary" | "secondary" | null) => void,
  onResult: (text: string) => void,
): void {
  setPending("primary");
  window.setTimeout(() => {
    setPending(null);
    onResult("Checked again. An owner has not answered yet.");
  }, 1200);
}

function clearTimerOnUnmount(timer: React.RefObject<number>): () => void {
  return () => window.clearTimeout(timer.current);
}

function noop(): void {}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Permission request preview is development-only.");
createRoot(root).render(<PermissionRequestPreview />);
