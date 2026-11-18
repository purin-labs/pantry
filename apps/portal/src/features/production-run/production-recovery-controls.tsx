import { Select } from "../../ui/select";
import React from "react";
import type {
  HostRequest,
  HostView,
  RecoveryView,
  CompiledScenario,
} from "@seams/production-simulation";
import type { StrictUnion, Variant } from "@seams/type-utils";
import { seconds } from "./oven-logistics";

export type ReviewedRecovery = Variant<HostRequest, "recover" | "recover-with-worker"> &
  Readonly<{ expectedControlRevision: number }>;
type RequiredRecovery = Variant<RecoveryView, "recovery-required">;
type Props = Readonly<{
  scenario: CompiledScenario;
  view: HostView;
  enabled: boolean;
  apply(command: ReviewedRecovery): void;
}>;
type State = StrictUnion<
  | Readonly<{ kind: "editing"; message: string }>
  | Readonly<{ kind: "reviewing"; command: ReviewedRecovery }>
>;

export class ProductionRecoveryControls extends React.Component<
  Props,
  Readonly<{ review: State }>
> {
  state: Readonly<{ review: State }> = {
    review: { kind: "editing", message: "" },
  };

  private setReview(review: State): void {
    this.setState({ review });
  }

  private review(
    task: RequiredRecovery,
    event: React.FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault();
    if (task.contents.kind !== "available") return;
    try {
      const fields = new FormData(event.currentTarget);
      const resource = recoveryResource(
        this.props.scenario,
        fields.get("resource"),
      );
      const storage = fields.get("storage");
      if (
        typeof storage !== "string" ||
        !recoveryStores(this.props.scenario).includes(storage)
      )
        throw new Error("Choose a declared carrier storage location.");
      const rawHandling = fields.get("handling");
      const handling =
        typeof rawHandling === "string" ? Number(rawHandling) * 1e6 : NaN;
      if (
        !Number.isSafeInteger(handling) ||
        handling <= 0 ||
        handling > 300e6 ||
        handling % 2000 !== 0
      )
        throw new Error(
          "Choose a handling time from 0.002 to 300 seconds on the 2 ms clock.",
        );
      const reports = [];
      for (const product of task.contents.products) {
        const destination = fields.get(`report:${product.product}`);
        if (
          typeof destination !== "string" ||
          !product.destinations.includes(destination)
        )
          throw new Error(
            `Choose a rejected-output destination for ${product.product}.`,
          );
        reports.push({ product: product.product, destination });
      }
      let command: ReviewedRecovery;
      if (resource.kind === "worker") {
        const location = fields.get("location");
        if (
          typeof location !== "string" ||
          !recoveryLocations(this.props.scenario).includes(location)
        )
          throw new Error(
            "Choose the location where the worker removes the carrier.",
          );
        command = {
          kind: "recover-with-worker",
          commandId: crypto.randomUUID(),
          expectedControlRevision: this.props.view.controlRevision,
          task: task.task,
          resource: resource.id,
          storage,
          handling,
          evidence: "assumed",
          reports,
          location,
        };
      } else
        command = {
          kind: "recover",
          commandId: crypto.randomUUID(),
          expectedControlRevision: this.props.view.controlRevision,
          task: task.task,
          resource: resource.id,
          storage,
          handling,
          evidence: "assumed",
          reports,
        };
      this.setReview({ kind: "reviewing", command });
    } catch (error) {
      this.setReview({
        kind: "editing",
        message: error instanceof Error ? error.message : "Invalid recovery.",
      });
    }
  }

  private edit(): void {
    this.setReview({ kind: "editing", message: "" });
  }
  private confirm(): void {
    if (
      this.state.review.kind !== "reviewing" ||
      !this.props.enabled ||
      this.state.review.command.expectedControlRevision !==
        this.props.view.controlRevision
    )
      return;
    this.props.apply(this.state.review.command);
    this.edit();
  }

  private row(task: RecoveryView): React.ReactNode {
    if (task.kind !== "recovery-required")
      return (
        <p key={task.task}>
          {task.task}: {task.kind}, {task.phase}. Resource {task.resource};
          destination {task.storage}.
        </p>
      );
    if (task.contents.kind === "unavailable")
      return (
        <p key={task.task}>
          Recovery bindings for {task.task} are unavailable in this retained
          build.
        </p>
      );
    const resources = recoveryResources(this.props.scenario);
    const locations = recoveryLocations(this.props.scenario);
    const stores = recoveryStores(this.props.scenario);
    return (
      <section key={task.task} aria-label={`Review recovery for ${task.task}`}>
        <h4>Review recovery for {task.task}</h4>
        <p>
          Remove {task.contents.carrier}, reject its contents, and return the
          arm from its failed state. Handling time is an explicit assumption.
        </p>
        <form
          aria-label={`Recovery for ${task.task}`}
          onSubmit={this.review.bind(this, task)}
        >
          <label>
            Recovery resource
            <Select.Root
              name="resource"
              required
              items={recoveryItems(resources)}
              defaultValue={resources[0] ?? null}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{resources.map(recoveryOption)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Worker recovery location
            <Select.Root
              name="location"
              items={recoveryItems(locations)}
              defaultValue={locations[0] ?? null}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{locations.map(recoveryOption)}</Select.Popup>
            </Select.Root>
          </label>
          <p>
            The location applies when a worker performs recovery. The engine
            checks travel and available capacity.
          </p>
          <label>
            Recovered carrier destination
            <Select.Root
              name="storage"
              required
              items={recoveryItems(stores)}
              defaultValue={stores[0] ?? null}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{stores.map(recoveryOption)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Recovery handling seconds
            <input
              name="handling"
              type="number"
              required
              min="0.002"
              max="300"
              step="0.002"
              defaultValue="30"
            />
          </label>
          {task.contents.products.map(recoveryProductField)}
          <button disabled={!this.props.enabled}>Review recovery</button>
        </form>
      </section>
    );
  }

  render(): React.ReactNode {
    if (this.props.view.recoveries.length === 0) return null;
    return (
      <section aria-label="Physical recovery controls">
        <h3>Physical recovery</h3>
        {this.state.review.kind === "editing" ? (
          <>
            {this.state.review.message && (
              <p role="status">{this.state.review.message}</p>
            )}
            {this.props.view.recoveries.map(this.row.bind(this))}
          </>
        ) : (
          <>
            <p>
              Recover {this.state.review.command.task} with{" "}
              {this.state.review.command.resource}. Move its carrier to{" "}
              {this.state.review.command.storage} after{" "}
              {seconds(this.state.review.command.handling)} seconds of handling.
            </p>
            <p>
              Reject all held contents at the selected reporting destinations.
              Keep the failed order and its evidence. Admitted recovery resumes
              execution.
            </p>
            <button
              disabled={
                !this.props.enabled ||
                this.state.review.command.expectedControlRevision !==
                  this.props.view.controlRevision
              }
              onClick={this.confirm.bind(this)}
            >
              Confirm physical recovery
            </button>
            <button onClick={this.edit.bind(this)}>Edit recovery</button>
          </>
        )}
      </section>
    );
  }
}
function recoveryResource(scenario: CompiledScenario, id: unknown) {
  for (const resource of scenario.resources)
    if (resource.id === id && resource.kind !== "batch") return resource;
  throw new Error("Choose a declared recovery resource.");
}
function recoveryStores(scenario: CompiledScenario): string[] {
  const stores = [];
  const batchStores = new Set<string>();
  for (const resource of scenario.resources)
    if (resource.kind === "batch") batchStores.add(resource.storage);
  for (const storage of scenario.storages)
    if (
      storage.cell === null &&
      storage.capacity.kind === "carriers" &&
      !batchStores.has(storage.id)
    )
      stores.push(storage.id);
  return stores;
}
function recoveryLocations(scenario: CompiledScenario): string[] {
  const locations = new Set<string>();
  for (const resource of scenario.resources) {
    if (resource.kind !== "worker") continue;
    locations.add(resource.initialLocation);
    for (const route of resource.travel) {
      locations.add(route.from);
      locations.add(route.to);
    }
  }
  return [...locations];
}
function recoveryResources(scenario: CompiledScenario): string[] {
  const resources = [];
  for (const resource of scenario.resources)
    if (resource.kind !== "batch") resources.push(resource.id);
  return resources;
}
function recoveryItems(
  values: readonly string[],
): Readonly<{ value: string; label: string }>[] {
  return values.map((value) => ({ value, label: value }));
}
function recoveryOption(value: string): React.ReactNode {
  return (
    <Select.Item key={value} value={value}>
      {value}
    </Select.Item>
  );
}
function recoveryProductField(
  product: Readonly<{ product: string; destinations: readonly string[] }>,
): React.ReactNode {
  return (
    <label key={product.product}>
      Rejected {product.product} destination
      <Select.Root
        name={`report:${product.product}`}
        required
        items={recoveryItems(product.destinations)}
        defaultValue={product.destinations[0] ?? null}
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          {product.destinations.map(recoveryOption)}
        </Select.Popup>
      </Select.Root>
    </label>
  );
}
