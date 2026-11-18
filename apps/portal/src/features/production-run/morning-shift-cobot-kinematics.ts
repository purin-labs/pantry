import type {
  CompiledScenario,
  LogisticsView,
  TaskView,
} from "@seams/production-simulation";
import type { OvenLiveFrame } from "@seams/production-simulation/runs/oven-live-physics";
import { fr10WristIk } from "@seams/production-simulation/kinematics/fr10";
import type { SynchronizedCobotTransferState } from "./morning-shift-appliances";

export type BaseCobotTransferEntry = Omit<
  SynchronizedCobotTransferState,
  | "jointAnglesRad"
  | "endEffectorPoseMeters"
  | "gripperWidthMm"
  | "gripperForceNewtons"
  | "payloadMassKg"
  | "shoulderTorqueNm"
>;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The espresso arm's wrist IK with a wrist roll, rounded to 1 mrad. */
function solveAnalyticalFr10Ik(
  targetTool: readonly [number, number, number],
  baseZUp: readonly [number, number, number],
  psi: number,
  wristRollRad = 0,
): readonly [number, number, number, number, number, number] {
  const [j1, j2, j3, j4, j5, j6] = fr10WristIk(baseZUp)(targetTool, psi);
  return [
    Number(j1.toFixed(3)),
    Number(j2.toFixed(3)),
    Number(j3.toFixed(3)),
    Number(j4.toFixed(3)),
    Number(j5.toFixed(3)),
    Number((j6 + wristRollRad).toFixed(3)),
  ];
}

export function computeCobotKinematicsAndDynamics(
  cellId: string,
  status: SynchronizedCobotTransferState["status"],
  phase: string,
  progress: number,
  frame: OvenLiveFrame | null,
): Pick<
  SynchronizedCobotTransferState,
  | "jointAnglesRad"
  | "endEffectorPoseMeters"
  | "gripperWidthMm"
  | "gripperForceNewtons"
  | "payloadMassKg"
  | "shoulderTorqueNm"
> {
  const p = clamp01(progress);
  if (cellId === "espresso-cell") {
    const baseZUp: readonly [number, number, number] = [-0.54, -0.62, -0.03];
    let tcp: readonly [number, number, number] = [-0.12, -0.387, 0.235];
    let gripperWidthMm = 48;
    let gripperForceNewtons = 0;
    let payloadMassKg = 0;
    let wristRollRad = 0;

    if (status === "executing") {
      if (p < 0.14) {
        const t = p / 0.14;
        tcp = [-0.12, -0.375 + t * 0.18, 0.227];
        gripperWidthMm = 36;
        gripperForceNewtons = 18.5;
        payloadMassKg = 0.28;
      } else if (p < 0.82) {
        tcp = [-0.15, -0.34, 0.315];
        gripperWidthMm = 64;
        gripperForceNewtons = 0;
        payloadMassKg = 0;
      } else {
        const t = (p - 0.82) / 0.18;
        tcp = [-0.12, -0.195 - t * 0.18, 0.227];
        gripperWidthMm = 36;
        gripperForceNewtons = 21.0;
        payloadMassKg = 0.34;
      }
    } else if (status === "handoff") {
      tcp = [0.02 - p * 0.14, -0.28, 0.26];
      gripperWidthMm = 24;
      gripperForceNewtons = 34.0;
      payloadMassKg = 0.52;
      wristRollRad = Math.sin(p * Math.PI) * 0.45;
    } else if (status === "cascade-held") {
      tcp = [-0.15, -0.34, 0.315];
      gripperWidthMm = 60;
    }
    return armState(tcp, baseZUp, Math.PI * 0.44, 4.2, {
      gripperWidthMm,
      gripperForceNewtons,
      payloadMassKg,
      wristRollRad,
    });
  }

  if (cellId === "pour-over-cell") {
    const baseZUp: readonly [number, number, number] = [0, 0, 0.75];
    let tcp: readonly [number, number, number] = [0.44, -0.22, 1.0];
    let gripperWidthMm = 44;
    let gripperForceNewtons = 0;
    let payloadMassKg = 0;
    let wristRollRad = 0;

    if (status === "executing") {
      const isPour =
        phase === "pour-1" ||
        phase === "pour-2" ||
        phase === "pour-3" ||
        phase === "pour-4";
      if (isPour) {
        const theta = p * 28 * Math.PI;
        tcp = [
          0.54 + 0.022 * Math.cos(theta),
          0.09 + 0.022 * Math.sin(theta),
          1.08,
        ];
        gripperWidthMm = 24;
        gripperForceNewtons = 32.5;
        payloadMassKg = Number((1.18 - p * 0.32).toFixed(2));
        wristRollRad = -0.38;
      } else {
        tcp = [0.52, 0.02, 1.06];
        gripperWidthMm = 24;
        gripperForceNewtons = 29.0;
        payloadMassKg = Number((1.15 - p * 0.3).toFixed(2));
        wristRollRad = -0.08;
      }
    } else if (status === "handoff") {
      tcp = [0.52, -0.06, 1.02];
      gripperWidthMm = 28;
      gripperForceNewtons = 28.0;
      payloadMassKg = 1.18;
      wristRollRad = -0.22;
    } else if (status === "cascade-held") {
      tcp = [0.52, 0.02, 1.06];
      gripperWidthMm = 52;
    }
    return armState(tcp, baseZUp, 0, 5.6, {
      gripperWidthMm,
      gripperForceNewtons,
      payloadMassKg,
      wristRollRad,
    });
  }

  // Pan & cold-carrier MuJoCo cell (`tea-pan-cell` / `cold-rack-cell`)
  const motion =
    frame !== null
      ? frame.purpose === "admission" || frame.purpose === "removal"
        ? frame.after.motion
        : frame.motion
      : undefined;
  const sample =
    motion !== undefined
      ? motion.samples[motion.samples.length - 1]
      : undefined;
  const rawJoints = sample?.joints;
  const baseZUp: readonly [number, number, number] = [0, 0, 0.72];
  const activeGrasp = status === "executing" || status === "handoff";
  const tcp: readonly [number, number, number] = activeGrasp
    ? [0.58 + 0.14 * Math.sin(p * Math.PI), 0.12 * Math.cos(p * Math.PI), 0.96]
    : [0.46, 0.0, 0.92];
  const ikJoints = solveAnalyticalFr10Ik(
    tcp,
    baseZUp,
    0,
    activeGrasp ? 0.12 : 0,
  );
  const joints: readonly [number, number, number, number, number, number] =
    rawJoints !== undefined && rawJoints.length >= 6
      ? [
          Number((rawJoints[0] ?? 0).toFixed(3)),
          Number((rawJoints[1] ?? 0).toFixed(3)),
          Number((rawJoints[2] ?? 0).toFixed(3)),
          Number((rawJoints[3] ?? 0).toFixed(3)),
          Number((rawJoints[4] ?? 0).toFixed(3)),
          Number((rawJoints[5] ?? 0).toFixed(3)),
        ]
      : ikJoints;
  const payloadMassKg = activeGrasp ? 2.45 : 0;
  const gripperForceNewtons = activeGrasp ? 46.0 : 0;
  const gripperWidthMm = activeGrasp ? 32 : 76;
  const reachM = Math.hypot(tcp[0], tcp[1]);
  const shoulderTorqueNm = Number(
    ((4.2 + payloadMassKg) * 9.81 * reachM).toFixed(2),
  );
  return {
    jointAnglesRad: joints,
    endEffectorPoseMeters: roundedPose(tcp),
    gripperWidthMm,
    gripperForceNewtons,
    payloadMassKg,
    shoulderTorqueNm,
  };
}

type ArmGrip = Readonly<{
  gripperWidthMm: number;
  gripperForceNewtons: number;
  payloadMassKg: number;
  wristRollRad: number;
}>;

function roundedPose(
  tcp: readonly [number, number, number],
): [number, number, number] {
  return [
    Number(tcp[0].toFixed(3)),
    Number(tcp[1].toFixed(3)),
    Number(tcp[2].toFixed(3)),
  ];
}

/**
 * The state of a beverage arm at a tool point: its joints, its rounded pose,
 * and a shoulder torque estimate in which the wrist roll costs
 * `rollTorqueNm` per radian.
 */
function armState(
  tcp: readonly [number, number, number],
  baseZUp: readonly [number, number, number],
  wristPitchRad: number,
  rollTorqueNm: number,
  grip: ArmGrip,
): ReturnType<typeof computeCobotKinematicsAndDynamics> {
  const { gripperWidthMm, gripperForceNewtons, payloadMassKg, wristRollRad } =
    grip;
  const joints = solveAnalyticalFr10Ik(
    tcp,
    baseZUp,
    wristPitchRad,
    wristRollRad,
  );
  const reachM = Math.hypot(tcp[0] - baseZUp[0], tcp[1] - baseZUp[1]);
  const shoulderTorqueNm = Number(
    (
      (3.8 + payloadMassKg) * 9.81 * reachM +
      Math.abs(wristRollRad) * rollTorqueNm
    ).toFixed(2),
  );
  return {
    jointAnglesRad: joints,
    endEffectorPoseMeters: roundedPose(tcp),
    gripperWidthMm,
    gripperForceNewtons,
    payloadMassKg,
    shoulderTorqueNm,
  };
}

/** The brew tasks of one beverage workflow at `timeUs`. */
function brewTasks(
  logistics: LogisticsView,
  timeUs: number,
  instancePrefix: string,
  isBrew: (key: string) => boolean,
): Readonly<{
  completed: number;
  total: number;
  activeBrew: TaskView | null;
  activePrep: TaskView | null;
  lastBrew: TaskView | null;
}> {
  let completed = 0;
  let total = 0;
  let activeBrew: TaskView | null = null;
  let activePrep: TaskView | null = null;
  let lastBrew: TaskView | null = null;
  if (logistics.kind === "available") {
    for (const task of logistics.tasks) {
      if (
        task.subject.kind !== "workflow" ||
        !task.subject.instance.startsWith(instancePrefix)
      )
        continue;
      if (isBrew(task.subject.key)) {
        total += 1;
        if (task.kind === "completed" && task.completedAt <= timeUs) {
          completed += 1;
          lastBrew = task;
        } else if (task.kind === "executing") {
          activeBrew = task;
        }
      } else if (task.kind === "executing") {
        activePrep = task;
      }
    }
  }
  return { completed, total, activeBrew, activePrep, lastBrew };
}

export function appendBeverageCobotCells(
  results: BaseCobotTransferEntry[],
  logistics: LogisticsView,
  scenario: CompiledScenario | undefined,
  timeUs: number,
): void {
  const hasEspressoWorkflow =
    scenario?.workflows.some((wf) => wf.id === "espresso-orders") ??
    (logistics.kind === "available" &&
      logistics.tasks.some(
        (t) =>
          t.subject.kind === "workflow" &&
          t.subject.instance.startsWith("espresso-order"),
      ));
  if (
    hasEspressoWorkflow &&
    !results.some((r) => r.cellId === "espresso-cell")
  ) {
    const {
      completed: espressoCompleted,
      total: espressoTotal,
      activeBrew,
      activePrep,
      lastBrew,
    } = brewTasks(
      logistics,
      timeUs,
      "espresso-order",
      (key) => key === "extract-espresso" || key === "prepare-espresso",
    );
    if (activeBrew !== null && activeBrew.kind === "executing") {
      const start = activeBrew.startedAt;
      const end = activeBrew.completesAt ?? start + 18_000_000;
      const progress = clamp01((timeUs - start) / Math.max(1, end - start));
      const elapsedS = progress * 18;
      const phase =
        elapsedS < 2.2
          ? "place-cup"
          : elapsedS < 15.6
            ? "extract-shot"
            : "serve-cup";
      results.push({
        cellId: "espresso-cell",
        robot: "fairino-fr10",
        status: "executing",
        taskId: activeBrew.id,
        label: `${activeBrew.id} (${phase})`,
        step: Math.round((espressoCompleted * 18 + elapsedS) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: espressoCompleted,
        totalTransfers: espressoTotal,
        progress,
        phase,
        cascadeHold: null,
      });
    } else if (activePrep !== null && activePrep.kind === "executing") {
      const start = activePrep.startedAt;
      const end = activePrep.completesAt ?? start + 12_000_000;
      const progress = clamp01((timeUs - start) / Math.max(1, end - start));
      results.push({
        cellId: "espresso-cell",
        robot: "fairino-fr10",
        status: "handoff",
        taskId: activePrep.id,
        label: `${activePrep.id} (dose-prep)`,
        step: Math.round((espressoCompleted * 18) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: espressoCompleted,
        totalTransfers: espressoTotal,
        progress,
        phase: "dose-prep",
        cascadeHold: null,
      });
    } else {
      results.push({
        cellId: "espresso-cell",
        robot: "fairino-fr10",
        status: "idle",
        taskId: lastBrew?.id ?? null,
        label:
          espressoCompleted > 0
            ? `Served ${espressoCompleted}/${espressoTotal} espresso cups`
            : "Barista espresso station ready",
        step: Math.round((espressoCompleted * 18) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: espressoCompleted,
        totalTransfers: espressoTotal,
        progress:
          espressoTotal > 0 && espressoCompleted === espressoTotal ? 1 : 0,
        phase: espressoCompleted > 0 ? "served" : "ready",
        cascadeHold: null,
      });
    }
  }

  const hasPourOverWorkflow =
    scenario?.workflows.some((wf) => wf.id === "pour-over-brew") ??
    (logistics.kind === "available" &&
      logistics.tasks.some(
        (t) =>
          t.subject.kind === "workflow" &&
          t.subject.instance.startsWith("pour-over-order#"),
      ));
  if (
    hasPourOverWorkflow &&
    !results.some((r) => r.cellId === "pour-over-cell")
  ) {
    const {
      completed: pourOverCompleted,
      total: pourOverTotal,
      activeBrew,
      activePrep,
      lastBrew,
    } = brewTasks(
      logistics,
      timeUs,
      "pour-over-order#",
      (key) => key === "brew-pour-over",
    );
    if (activeBrew !== null && activeBrew.kind === "executing") {
      const start = activeBrew.startedAt;
      const end = activeBrew.completesAt ?? start + 210_000_000;
      const progress = clamp01((timeUs - start) / Math.max(1, end - start));
      const brewS = progress * 210;
      const phase =
        brewS < 15
          ? "pour-1"
          : brewS < 40
            ? "rest-1"
            : brewS < 58
              ? "pour-2"
              : brewS < 70
                ? "rest-2"
                : brewS < 88
                  ? "pour-3"
                  : brewS < 100
                    ? "rest-3"
                    : brewS < 120
                      ? "pour-4"
                      : brewS < 192
                        ? "drainage"
                        : "return-kettle";
      results.push({
        cellId: "pour-over-cell",
        robot: "fairino-fr10",
        status: "executing",
        taskId: activeBrew.id,
        label: `${activeBrew.id} (${phase})`,
        step: Math.round((pourOverCompleted * 210 + brewS) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: pourOverCompleted,
        totalTransfers: pourOverTotal,
        progress,
        phase,
        cascadeHold: null,
      });
    } else if (activePrep !== null && activePrep.kind === "executing") {
      const start = activePrep.startedAt;
      const end = activePrep.completesAt ?? start + 20_000_000;
      const progress = clamp01((timeUs - start) / Math.max(1, end - start));
      results.push({
        cellId: "pour-over-cell",
        robot: "fairino-fr10",
        status: "handoff",
        taskId: activePrep.id,
        label: `${activePrep.id} (station-prep)`,
        step: Math.round((pourOverCompleted * 210) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: pourOverCompleted,
        totalTransfers: pourOverTotal,
        progress,
        phase: "station-prep",
        cascadeHold: null,
      });
    } else {
      results.push({
        cellId: "pour-over-cell",
        robot: "fairino-fr10",
        status: "idle",
        taskId: lastBrew?.id ?? null,
        label:
          pourOverCompleted > 0
            ? `Brewed ${pourOverCompleted}/${pourOverTotal} pour-over carafes`
            : "Barista pour-over station ready",
        step: Math.round((pourOverCompleted * 210) / 0.002),
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers: pourOverCompleted,
        totalTransfers: pourOverTotal,
        progress:
          pourOverTotal > 0 && pourOverCompleted === pourOverTotal ? 1 : 0,
        phase: pourOverCompleted > 0 ? "completed" : "prepared",
        cascadeHold: null,
      });
    }
  }
}
