import React from "react";
import { FileText, X } from "lucide-react";

/** One file in the composer before it is sent; an image shows a thumbnail. */
export function ChatSelectedFile({
  file,
  disabled,
  onRemove,
}: {
  readonly file: File;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}): React.ReactNode {
  const preview = useImagePreview(file);
  return (
    <li
      className="chat-selected-file"
      data-kind={preview === null ? "file" : "image"}
      title={file.name}
    >
      {preview === null ? (
        <>
          <FileText size={16} aria-hidden="true" />
          <span>{file.name}</span>
        </>
      ) : (
        <>
          <img src={preview} alt="" decoding="async" />
          <span className="sr-only">{file.name}</span>
        </>
      )}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

function useImagePreview(file: File): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(previewImage.bind(null, file, setUrl), [file]);
  return url;
}

function previewImage(
  file: File,
  setUrl: (url: string | null) => void,
): (() => void) | undefined {
  if (!file.type.startsWith("image/")) {
    setUrl(null);
    return;
  }
  const url = URL.createObjectURL(file);
  setUrl(url);
  return revokePreview.bind(null, url);
}

function revokePreview(url: string): void {
  URL.revokeObjectURL(url);
}
