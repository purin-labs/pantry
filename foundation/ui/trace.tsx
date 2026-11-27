import React from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { joinClasses, withClass } from "./class-name";
import "./trace.css";

/** Presentation states. Callers map accepted domain events into these states. */
export type TraceStatus = "completed" | "running" | "error" | "pending";

// Trace rows for agent activity, built from Base UI Collapsible. Each part has
// a Portal class (pantry-trace, pantry-trace-line, ...) that trace.css styles.

export function Trace({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactNode {
  return <div {...props} className={joinClasses("pantry-trace", className)} />;
}

export function TraceLine({
  status,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  readonly status: TraceStatus;
}): React.ReactNode {
  return (
    <span
      {...props}
      className={joinClasses("pantry-trace-line", className)}
      data-status={status}
    />
  );
}

export function TraceIcon({
  spinning = false,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  readonly spinning?: boolean;
}): React.ReactNode {
  return (
    <span
      {...props}
      className={joinClasses("pantry-trace-icon", className)}
      data-spinning={spinning || undefined}
      aria-hidden="true"
    />
  );
}

export function TraceTitle({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactNode {
  return (
    <span {...props} className={joinClasses("pantry-trace-title", className)} />
  );
}

export function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactNode {
  return (
    <span
      {...props}
      className={joinClasses("pantry-trace-description", className)}
    />
  );
}

type TraceCollapsibleProps = Omit<
  Collapsible.Root.Props,
  "open" | "defaultOpen" | "onOpenChange"
> &
  (
    | {
        readonly open: boolean;
        readonly onOpenChange: NonNullable<
          Collapsible.Root.Props["onOpenChange"]
        >;
        readonly defaultOpen?: never;
      }
    | {
        readonly open?: never;
        readonly defaultOpen?: boolean;
        readonly onOpenChange?: Collapsible.Root.Props["onOpenChange"];
      }
  );

export function TraceCollapsible({
  className,
  ...props
}: TraceCollapsibleProps): React.ReactNode {
  return (
    <Collapsible.Root
      {...(props as Collapsible.Root.Props)}
      className={withClass("pantry-trace-collapsible", className)}
    />
  );
}

export function TraceCollapsibleTrigger({
  children,
  className,
  ...props
}: Collapsible.Trigger.Props): React.ReactNode {
  return (
    <Collapsible.Trigger
      {...props}
      className={withClass("pantry-trace-collapsible-trigger", className)}
    >
      {children}
      <TraceIcon data-trace-chevron="">
        <ChevronRight />
      </TraceIcon>
    </Collapsible.Trigger>
  );
}

export function TraceCollapsibleContent({
  children,
  className,
  ...props
}: Collapsible.Panel.Props): React.ReactNode {
  return (
    <Collapsible.Panel
      {...props}
      className={withClass("pantry-trace-collapsible-content", className)}
    >
      <div className="pantry-trace-collapsible-content-inner">{children}</div>
    </Collapsible.Panel>
  );
}
