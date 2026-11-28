import { ArrowUp, Sparkles } from "lucide-react";
import React from "react";
import { askAgentInChat } from "./recipe-workspace";

const COMPOSER_EXAMPLE_MS = 6000;
const COMPOSER_EXAMPLES = [
  "Add a check after the last step",
  "Shorten the longest wait",
  "Find what makes this recipe late",
];

/** The words go to the chat as a draft. A person reads them there and sends them. */
export function AgentComposer(
  props: Readonly<{ chatPath: string; workflowId: string }>,
): React.ReactNode {
  const [words, setWords] = React.useState("");
  const [example, setExample] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setExample((value) => (value + 1) % COMPOSER_EXAMPLES.length);
    }, COMPOSER_EXAMPLE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const asked = words.trim();
  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (asked === "") return;
    askAgentInChat(
      props.chatPath,
      `Read the recipe workflow ${props.workflowId}, and propose a change. ${asked}`,
    );
  }
  return (
    <form
      className="recipe-graph-float recipe-graph-composer"
      onSubmit={submit}
    >
      <Sparkles size={16} aria-hidden="true" />
      <input
        aria-label="Tell the agent what to change"
        placeholder={COMPOSER_EXAMPLES[example]}
        value={words}
        onChange={(event) => {
          setWords(event.currentTarget.value);
        }}
      />
      <button
        type="submit"
        aria-label="Continue in chat"
        disabled={asked === ""}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </button>
    </form>
  );
}
