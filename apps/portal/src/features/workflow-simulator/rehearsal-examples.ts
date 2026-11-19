import type { BakeryRehearsalExample } from "@purin-labs/bakery-model/bakery-surface";
import exampleUrl from "../../../../../assets/bakery-mujoco/fr10-workcell/recordings/nominal.json?url";
import ovenExampleUrl from "../../../../../assets/bakery-mujoco/fr10-workcell/recordings/oven-loading.json?url";
import cycleExampleUrl from "../../../../../assets/bakery-mujoco/fr10-workcell/recordings/oven-cycle.json?url";
import rackCycleExampleUrl from "../../../../../assets/bakery-mujoco/fr10-workcell/recordings/oven-rack-cycle.json?url";

export async function readExample(
  task: BakeryRehearsalExample,
): Promise<string> {
  let url: string;
  switch (task) {
    case "table-to-rack":
      url = exampleUrl;
      break;
    case "table-to-oven":
      url = ovenExampleUrl;
      break;
    case "oven-cycle":
      url = cycleExampleUrl;
      break;
    case "rack-cycle":
      url = rackCycleExampleUrl;
      break;
  }
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      "Unable to load the example. You can still import a recording.",
    );
  return response.text();
}
