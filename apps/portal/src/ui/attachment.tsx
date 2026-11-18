import React from "react";
import {
  ExternalLink,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  CircleAlert,
} from "lucide-react";
import "./agent-components.css";
import { assertNever } from "@seams/std";

export type AttachmentState =
  | {
      readonly kind: "ready";
      readonly href: URL;
      readonly progress?: never;
      readonly reason?: never;
    }
  | {
      readonly kind: "uploading";
      readonly progress: number;
      readonly href?: never;
      readonly reason?: never;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly href?: never;
      readonly progress?: never;
    };

export type AttachmentProps = {
  readonly name: string;
  readonly description: string;
  readonly state: AttachmentState;
};

export function Attachment(props: AttachmentProps): React.ReactNode {
  const Icon = attachmentIcon(props.name);
  const content = (
    <>
      <span className="attachment-icon-tile">
        <Icon size={20} aria-hidden="true" />
      </span>
      <span className="attachment-copy">
        <span className="attachment-name">{props.name}</span>
        <small>{props.description}</small>
      </span>
    </>
  );
  if (props.state.kind === "ready") {
    return (
      <a
        className="agent-attachment"
        href={props.state.href.href}
        target="_blank"
        rel="noreferrer"
      >
        {content}
        <ExternalLink size={16} aria-hidden="true" />
      </a>
    );
  }
  return (
    <div className="agent-attachment" data-state={props.state.kind}>
      {content}
      {props.state.kind === "uploading" ? (
        <svg
          className="attachment-loader"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="attachment-loader-track"
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle
            className="agent-ui-spin attachment-loader-arc"
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="18 39"
          />
        </svg>
      ) : (
        <CircleAlert size={16} aria-hidden="true" />
      )}
      <AttachmentStatus state={props.state} />
    </div>
  );
}

function AttachmentStatus(props: {
  readonly state: AttachmentState;
}): React.ReactNode {
  switch (props.state.kind) {
    case "ready":
      return null;
    case "uploading":
      return (
        <span className="attachment-progress">
          <progress
            max={100}
            value={props.state.progress}
            aria-label="Upload progress"
          />
          <span>Uploading · {props.state.progress}%</span>
        </span>
      );
    case "unavailable":
      return (
        <span className="attachment-unavailable">{props.state.reason}</span>
      );
    default:
      return assertNever(props.state, "Unknown attachment state");
  }
}

function attachmentIcon(name: string): typeof File {
  const extension = name.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
      return FileImage;
    case "csv":
    case "xlsx":
    case "ods":
      return FileSpreadsheet;
    case "pdf":
    case "docx":
    case "txt":
    case "md":
      return FileText;
    default:
      return File;
  }
}
