// The simulated resources native requests bind, as explicit instances (Plan
// 42F F2a). Their IDs are the identities saved runs and evidence already use.
// Poses are in the shared workcell model frame (metres; quaternion w, x, y, z)
// and come from the native fixture files, so their provenance is the model.
// The second independent world uses the same model with distinct instances.
// Their placement at the shared bakery station remains assumed.

export type Pose = readonly [
  x: number,
  y: number,
  z: number,
  qw: number,
  qx: number,
  qy: number,
  qz: number,
];
export type ResourceRole =
  "arm" | "tool" | "tray" | "source" | "destination" | "cell";
export type Provenance = "model" | "measured" | "assumed";
export type NativeSkill = "table-to-rack" | "table-to-oven";

// How the model names an instance: the moving bodies it owns and the world
// geometry whose names start with one of its prefixes.
export type FixtureIdentity = Readonly<{
  bodies: readonly string[];
  geometry: readonly string[];
}>;

const INSTANCES = [
  {
    id: "fr10-1",
    name: "Robot arm",
    role: "arm",
    model: "Selected execution robot",
    fixture: { bodies: ["robot"], geometry: ["pedestal_"] },
    pose: [0, 0, 0.75, 1, 0, 0, 0],
  },
  {
    id: "clamp-1",
    name: "Tray clamp",
    role: "tool",
    model: "Prototype tray clamp",
    fixture: { bodies: ["tool", "jaw"], geometry: [] },
    pose: null,
  },
  {
    id: "cold-tray-1",
    name: "Cold tray",
    role: "tray",
    model: "MBCO cold-proxy tray",
    fixture: { bodies: ["tray"], geometry: [] },
    pose: null,
  },
  {
    id: "source-table-1",
    name: "Source table",
    role: "source",
    model: "Stainless prep table",
    fixture: { bodies: [], geometry: ["table_"] },
    pose: [1.31, -0.5, 0.78, 1, 0, 0, 0],
  },
  {
    id: "rack-slot-1",
    name: "Rack slot",
    role: "destination",
    model: "Cooling rack slot",
    fixture: { bodies: [], geometry: ["rack_"] },
    pose: [1.05, 0.5, 0.79, 1, 0, 0, 0],
  },
  {
    id: "maruzen-shelf-3",
    name: "Maruzen shelf 3",
    role: "destination",
    model: "Maruzen MBCO-5E, shelf 3",
    fixture: { bodies: [], geometry: ["mbco_", "mbco4_", "oven_stand"] },
    pose: [1.35, 0.2, 0.444, Math.SQRT1_2, 0, 0, -Math.SQRT1_2],
  },
  {
    id: "cold-cell-1",
    name: "Robot cell 1",
    role: "cell",
    model: "Cold-tray workcell",
    // Named for the arm it contains; saved runs keep the ID.
    fixture: { bodies: [], geometry: ["destination_obstruction"] },
    pose: [0, 0, 0, 1, 0, 0, 0],
  },
] as const satisfies readonly Readonly<{
  id: string;
  name: string;
  role: ResourceRole;
  model: string;
  fixture: FixtureIdentity;
  pose: Pose | null;
}>[];

const SECOND_IDS = {
  "fr10-1": "fr10-2",
  "clamp-1": "clamp-2",
  "cold-tray-1": "cold-tray-2",
  "source-table-1": "source-table-2",
  "rack-slot-1": "rack-slot-2",
  "maruzen-shelf-3": "cell-2-maruzen-shelf-3",
  "cold-cell-1": "cold-cell-2",
} as const;

type ModelResource = (typeof INSTANCES)[number];
export type CellId = "cold-cell-1" | "cold-cell-2";
export type ResourceInstanceId =
  ModelResource["id"] | (typeof SECOND_IDS)[ModelResource["id"]];
export type ResourceInstance = Readonly<{
  id: ResourceInstanceId;
  name: string;
  role: ResourceRole;
  model: string;
  fixture: FixtureIdentity;
  pose: Pose | null;
  cellId: CellId;
  capacity: 1;
  availability: "available";
  provenance: Provenance;
}>;

export const RESOURCE_INSTANCES: readonly ResourceInstance[] = [
  ...INSTANCES.map(modelInstance),
  ...INSTANCES.map(secondModelInstance),
];

type CellBinding<N extends 1 | 2> = Readonly<{
  arm: `fr10-${N}`;
  tool: `clamp-${N}`;
  tray: `cold-tray-${N}`;
  source: `source-table-${N}`;
  destination:
    | `rack-slot-${N}`
    | (N extends 1 ? "maruzen-shelf-3" : "cell-2-maruzen-shelf-3");
  cell: `cold-cell-${N}`;
}>;
export type CapabilityBinding = CellBinding<1> | CellBinding<2>;
type Cell<N extends 1 | 2> = Readonly<{
  id: `cold-cell-${N}`;
  station: "cool";
  capacity: 1;
  placement: Readonly<{
    station: "cool";
    provenance: "assumed";
  }>;
  skills: Readonly<{
    "table-to-rack": CellBinding<N> &
      Readonly<{ destination: `rack-slot-${N}` }>;
    "table-to-oven": CellBinding<N> &
      Readonly<{
        destination: N extends 1 ? "maruzen-shelf-3" : "cell-2-maruzen-shelf-3";
      }>;
  }>;
}>;
export type CellInstance = Cell<1> | Cell<2>;

export const COLD_CELL: Cell<1> = Object.freeze({
  id: "cold-cell-1",
  station: "cool",
  capacity: 1,
  placement: Object.freeze({
    station: "cool",
    provenance: "assumed",
  }),
  skills: Object.freeze({
    "table-to-rack": Object.freeze({
      arm: "fr10-1",
      tool: "clamp-1",
      tray: "cold-tray-1",
      source: "source-table-1",
      destination: "rack-slot-1",
      cell: "cold-cell-1",
    }),
    "table-to-oven": Object.freeze({
      arm: "fr10-1",
      tool: "clamp-1",
      tray: "cold-tray-1",
      source: "source-table-1",
      destination: "maruzen-shelf-3",
      cell: "cold-cell-1",
    }),
  }),
} satisfies Cell<1>);

const SECOND_ROBOT_CELL: Cell<2> = Object.freeze({
  id: "cold-cell-2",
  station: "cool",
  capacity: 1,
  placement: Object.freeze({
    station: "cool",
    provenance: "assumed",
  }),
  skills: Object.freeze({
    "table-to-rack": Object.freeze({
      arm: "fr10-2",
      tool: "clamp-2",
      tray: "cold-tray-2",
      source: "source-table-2",
      destination: "rack-slot-2",
      cell: "cold-cell-2",
    }),
    "table-to-oven": Object.freeze({
      arm: "fr10-2",
      tool: "clamp-2",
      tray: "cold-tray-2",
      source: "source-table-2",
      destination: "cell-2-maruzen-shelf-3",
      cell: "cold-cell-2",
    }),
  }),
} satisfies Cell<2>);

export function coldCell(id: CellId): CellInstance {
  switch (id) {
    case "cold-cell-1":
      return COLD_CELL;
    case "cold-cell-2":
      return SECOND_ROBOT_CELL;
  }
}

export function parseCellId(value: unknown): CellId | null {
  return value === "cold-cell-1" || value === "cold-cell-2" ? value : null;
}

export function nativeSkills(cell: CellInstance): readonly NativeSkill[] {
  const skills: NativeSkill[] = [];
  for (const skill of Object.keys(cell.skills))
    if (skill === "table-to-rack" || skill === "table-to-oven")
      skills.push(skill);
  return skills;
}

export function resourceInstance(id: ResourceInstanceId): ResourceInstance {
  const instance = RESOURCE_INSTANCES.find(hasInstanceId.bind(null, id));
  if (instance === undefined) throw new Error(`Unknown resource: ${id}`);
  return instance;
}

// The instance a model body or world geometry belongs to, if any.
export function instanceForFixture(
  body: string,
  geometry: string,
): ResourceInstanceId | null {
  for (const instance of RESOURCE_INSTANCES) {
    const fixture: FixtureIdentity = instance.fixture;
    if (body !== "world" && fixture.bodies.includes(body)) return instance.id;
    if (
      body === "world" &&
      fixture.geometry.some(prefixOf.bind(null, geometry))
    )
      return instance.id;
  }
  return null;
}

// A Plan 24 mapping names the simulated instance and the capability revision
// a physical enrollment must match. It grants no physical authority.
export type SimulatedInstanceReference = Readonly<{
  kind: "simulated-instance";
  instanceId: ResourceInstanceId;
  role: ResourceRole;
  capability: NativeSkill;
  revision: typeof CAPABILITY_REVISION;
}>;
export const CAPABILITY_REVISION = "fr10-cold-cell/1";

export function simulatedInstanceReference(
  id: ResourceInstanceId,
  capability: NativeSkill,
): SimulatedInstanceReference {
  const instance = resourceInstance(id);
  const binding = coldCell(instance.cellId).skills[capability];
  if (!Object.values(binding).includes(id))
    throw new Error(`${instance.name} is not bound by ${capability}.`);
  return {
    kind: "simulated-instance",
    instanceId: instance.id,
    role: instance.role,
    capability,
    revision: CAPABILITY_REVISION,
  };
}

function modelInstance(instance: (typeof INSTANCES)[number]): ResourceInstance {
  return Object.freeze({
    ...instance,
    cellId: "cold-cell-1",
    capacity: 1,
    availability: "available",
    provenance: "model",
  });
}
function secondModelInstance(instance: ModelResource): ResourceInstance {
  return Object.freeze({
    id: SECOND_IDS[instance.id],
    name:
      instance.role === "cell" ? "Robot cell 2" : `${instance.name} · Cell 2`,
    role: instance.role,
    model: instance.model,
    fixture: instance.fixture,
    pose: instance.pose,
    cellId: "cold-cell-2",
    capacity: 1,
    availability: "available",
    provenance: "model",
  });
}
function hasInstanceId(id: string, instance: ResourceInstance): boolean {
  return instance.id === id;
}
function prefixOf(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(prefix);
}
