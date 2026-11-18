import React from "react";
import "./empty-state.css";

export type EmptyStateProps = {
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly icon?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
};

export function EmptyState(props: EmptyStateProps): React.ReactNode {
  const titleId = React.useId();
  return (
    <section
      className={`empty-state-panel ${props.className ?? ""}`}
      aria-labelledby={titleId}
    >
      {props.icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <h3 id={titleId}>{props.title}</h3>
      {props.description && (
        <p className="empty-state-description">{props.description}</p>
      )}
      {props.actions && (
        <div className="empty-state-actions">{props.actions}</div>
      )}
    </section>
  );
}
