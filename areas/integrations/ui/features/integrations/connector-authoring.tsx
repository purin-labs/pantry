import React from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@purin-labs/ui/index";
import { useNavigate } from "react-router";

export function ConnectorAuthoringAssistant(props: {
  readonly basePath: string;
}): React.ReactNode {
  const [request, setRequest] = React.useState("");
  const navigate = useNavigate();
  return (
    <form
      className="connector-chat-start"
      onSubmit={continueInChat.bind(null, props.basePath, request, navigate)}
    >
      <label htmlFor="connector-request">What would you like to connect?</label>
      <textarea
        id="connector-request"
        value={request}
        onChange={changeRequest.bind(null, setRequest)}
        rows={4}
        placeholder="Connect our delivery service so I can check shipment status and create shipping labels."
      />
      <p className="field-hint">
        Add the app name and what you want it to do. An API docs link helps.
      </p>
      <div className="connector-method-footer">
        <a href={props.basePath}>Cancel</a>
        <Button type="submit" variant="primary">
          Continue in chat <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

function changeRequest(
  setRequest: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLTextAreaElement>,
): void {
  setRequest(event.currentTarget.value);
}

function continueInChat(
  basePath: string,
  request: string,
  navigate: ReturnType<typeof useNavigate>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const path = basePath.replace(/\/integrations(?:\?.*)?$/u, "/chat");
  sessionStorage.setItem(`connector-chat-draft:${path}`, request.trim());
  void navigate(path);
}
