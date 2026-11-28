import { Select } from "@purin-labs/ui/select";
import React from "react";
import {
  recurringColdCellScenario,
  type ColdCellComparison,
} from "@purin-labs/production-simulation/recipes/recurring-cold-cell";
import { parseNativeCell } from "@purin-labs/production-simulation/native/cell-adapter";
import {
  authoredId,
  type PhysicalCellDefinition,
} from "@purin-labs/production-simulation";
import { isRecord } from "@purin-labs/std";
import {
  parsePersistentCell,
  type PersistentRackCell,
} from "@purin-labs/bakery-model/bakery-physics";
import { openExecutionWorker, type ExecutionWorker } from "./execution-client";
import type { OvenRunSource } from "@purin-labs/production-simulation/runs/oven-run-file";

const CASES: readonly Readonly<{
  id: string;
  label: string;
  comparison: ColdCellComparison;
}>[] = [
  {
    id: "balanced-baseline",
    label: "Balanced · one buffer slot",
    comparison: { kind: "balanced", bufferSlots: 1, receivingHold: false },
  },
  {
    id: "balanced-hold",
    label: "Balanced · one slot · receiving hold",
    comparison: { kind: "balanced", bufferSlots: 1, receivingHold: true },
  },
  {
    id: "balanced-buffer",
    label: "Balanced · two buffer slots",
    comparison: { kind: "balanced", bufferSlots: 2, receivingHold: false },
  },
  {
    id: "balanced-hold-buffer",
    label: "Balanced · two slots · receiving hold",
    comparison: { kind: "balanced", bufferSlots: 2, receivingHold: true },
  },
  {
    id: "stress-one-slot",
    label: "Overload · one buffer slot",
    comparison: { kind: "stress", bufferSlots: 1 },
  },
  {
    id: "stress-two-slots",
    label: "Overload · two buffer slots",
    comparison: { kind: "stress", bufferSlots: 2 },
  },
];
const CASE_ITEMS = CASES.map((entry) => ({
  value: entry.id,
  label: entry.label,
}));

async function prepareCell(
  worker: ExecutionWorker,
  id: string,
): Promise<PersistentRackCell> {
  const reply = await worker.request({
    kind: "define",
    cell: id,
    fixture: "rack",
    robot: "fairino-fr10",
  });
  const cell =
    isRecord(reply) && reply.kind === "defined"
      ? parsePersistentCell(reply.definition)
      : null;
  if (
    cell === null ||
    cell.fixture !== "persistent-rack/1" ||
    cell.cellId !== id
  )
    throw new Error("The retained build returned an invalid rack cell.");
  return cell;
}

function physicalCell(cell: PersistentRackCell): PhysicalCellDefinition {
  const parsed = parseNativeCell(cell);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    id: parsed.value.cellId,
    modelHash: parsed.value.modelHash,
    controllerSourceHash: parsed.value.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel: authoredId("hold-model", "cold-cell-rest.1"),
  };
}

type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
type State = Readonly<{ selected: string; preparing: boolean; notice: string }>;

/** Six existing engine inputs. The form adds no scheduling decisions. */
export class ColdCellRouteAuthor extends React.Component<Props, State> {
  state: State = {
    selected: "balanced-baseline",
    preparing: false,
    notice: "",
  };
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }
  private change(value: string | null): void {
    if (value === null) return;
    this.setState({ selected: value });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.preparing) return;
    let selected = null;
    for (const entry of CASES)
      if (entry.id === this.state.selected) selected = entry;
    if (selected === null) return;
    this.setState({
      preparing: true,
      notice: "Preparing both retained cells…",
    });
    let worker: ExecutionWorker | null = null;
    try {
      const opened = await openExecutionWorker();
      if (!opened.ok)
        throw new Error(`Cannot prepare the route: ${opened.error.code}.`);
      worker = opened.value;
      const source = await prepareCell(worker, "source-cell");
      const receiving = await prepareCell(worker, "receiving-cell");
      const scenario = await recurringColdCellScenario(
        [physicalCell(source), physicalCell(receiving)],
        selected.comparison,
      );
      if (this.mounted)
        this.props.prepared({
          kind: "logistics",
          name: selected.label,
          scenario,
          cells: [source, receiving],
        });
    } catch (error) {
      if (this.mounted)
        this.setState({
          notice:
            error instanceof Error
              ? error.message
              : "The route could not be prepared.",
        });
    } finally {
      worker?.terminate();
      if (this.mounted) this.setState({ preparing: false });
    }
  }
  render(): React.ReactNode {
    return (
      <form
        aria-label="Recurring two-cell route"
        onSubmit={this.prepare.bind(this)}
      >
        <h3>Recurring two-cell logistics</h3>
        <p>
          24 orders, four reusable trays, two FR10 cells, and one baker.
          Separate transfers fill and empty the buffer. Unloading releases each
          tray for return.
        </p>
        <p>
          Balanced cases admit an order every 360 seconds. Overload cases use 90
          seconds. Compare buffer capacity within the same arrival and
          receiving-hold conditions.
        </p>
        <label>
          Logistics comparison
          <Select.Root
            items={CASE_ITEMS}
            value={this.state.selected}
            onValueChange={this.change.bind(this)}
            disabled={this.state.preparing}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{CASES.map(caseOption)}</Select.Popup>
          </Select.Root>
        </label>
        <button disabled={this.state.preparing}>Prepare two-cell route</button>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}

function caseOption(entry: (typeof CASES)[number]): React.ReactNode {
  return (
    <Select.Item key={entry.id} value={entry.id}>
      {entry.label}
    </Select.Item>
  );
}
