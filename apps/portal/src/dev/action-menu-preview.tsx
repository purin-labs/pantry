import React from "react";
import {
  ChevronDown,
  Download,
  Link,
  Pencil,
  Printer,
  Trash2,
} from "lucide-react";
import { ActionMenu, type ActionMenuSection } from "../ui";

type State = { readonly receipt: string };

export class ActionMenuPreview extends React.Component<object, State> {
  state: State = { receipt: "No action chosen." };

  private choose(receipt: string): void {
    this.setState({ receipt });
  }
  private sections(): readonly ActionMenuSection[] {
    return [
      {
        id: "actions",
        label: "Actions",
        items: [
          {
            id: "export",
            label: "Export orders",
            description: "Download tomorrow’s production sheet",
            icon: <Download />,
            shortcut: "⌘E",
            onSelect: this.choose.bind(this, "Export orders chosen."),
          },
          {
            id: "copy",
            label: "Copy link",
            description: "Copy the order ledger link",
            icon: <Link />,
            shortcut: "⌘L",
            onSelect: this.choose.bind(this, "Copy link chosen."),
          },
          {
            id: "edit",
            label: "Edit quantities",
            description: "Change pickup quantities",
            icon: <Pencil />,
            shortcut: "⌘K",
            onSelect: this.choose.bind(this, "Edit quantities chosen."),
          },
          {
            id: "print",
            label: "Print labels",
            description: "Connect a printer first",
            icon: <Printer />,
            disabled: true,
            onSelect: this.choose.bind(this, "Print labels chosen."),
          },
        ],
      },
      {
        id: "danger",
        label: "Danger zone",
        items: [
          {
            id: "cancel",
            label: "Cancel export",
            description: "Discard the accepted snapshot",
            icon: <Trash2 />,
            shortcut: "⌘⇧K",
            tone: "danger",
            onSelect: this.choose.bind(this, "Cancel export chosen."),
          },
        ],
      },
    ];
  }
  render(): React.ReactNode {
    return (
      <section
        className="agent-preview-actions"
        aria-label="Action menu preview"
      >
        <h2>Action menu</h2>
        <ActionMenu
          label="Order actions"
          trigger={
            <button type="button">
              Order actions <ChevronDown size={15} aria-hidden="true" />
            </button>
          }
          sections={this.sections()}
        />
        <p role="status">{this.state.receipt}</p>
      </section>
    );
  }
}
