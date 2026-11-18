import type {
  CompiledScenario,
  LogisticsView,
  TaskView,
} from "@seams/production-simulation";
import type { OvenLiveFrame } from "@seams/production-simulation/runs/oven-live-physics";
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

function solveAnalyticalFr10Ik(
  targetTool: readonly [number, number, number],
  baseZUp: readonly [number, number, number],
  psi: number,
  wristRollRad = 0,
): readonly [number, number, number, number, number, number] {
  const a2 = 0.7;
  const a3 = 0.586;
  const d4 = 0.159;
  const p5x = targetTool[0] - 0.236 * Math.cos(psi);
  const p5y = targetTool[1] - 0.236 * Math.sin(psi);
  const p5z = targetTool[2] + 0.114;

  const dx = p5x - baseZUp[0];
  const dy = p5y - baseZUp[1];
  const dz = p5z - baseZUp[2];

  const u = Math.sqrt(Math.max(0.04, dx * dx + dy * dy - d4 * d4));
  const j1 = Math.atan2(dy, dx) + Math.atan2(d4, u);

  const z = dz - 0.18;
  const cosJ3 = Math.max(
    -0.999,
    Math.min(0.999, (u * u + z * z - a2 * a2 - a3 * a3) / (2 * a2 * a3)),
  );
  const j3 = -Math.acos(cosJ3);
  let j2 =
    Math.atan2(-z, -u) -
    Math.atan2(a3 * Math.sin(j3), a2 + a3 * Math.cos(j3));
  if (j2 > 0) j2 -= Math.PI * 2;
  const j4 = -Math.PI * 2 - j2 - j3;
  const j5 = j1 - psi - Math.PI / 2;
  const j6 = Math.PI / 2 + wristRollRad;
  return [
    Number(j1.toFixed(3)),
    Number(j2.toFixed(3)),
    Number(j3.toFixed(3)),
    Number(j4.toFixed(3)),
    Number(j5.toFixed(3)),
    Number(j6.toFixed(3)),
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
    const joints = solveAnalyticalFr10Ik(
      tcp,
      baseZUp,
      Math.PI * 0.44,
      wristRollRad,
    );
    const reachM = Math.hypot(tcp[0] - baseZUp[0], tcp[1] - baseZUp[1]);
    const shoulderTorqueNm = Number(
      ((3.8 + payloadMassKg) * 9.81 * reachM + Math.abs(wristRollRad) * 4.2).toFixed(2),
    );
    return {
      jointAnglesRad: joints,
      endEffectorPoseMeters: [
        Number(tcp[0].toFixed(3)),
        Number(tcp[1].toFixed(3)),
        Number(tcp[2].toFixed(3)),
      ],
      gripperWidthMm,
      gripperForceNewtons,
      payloadMassKg,
      shoulderTorqueNm,
    };
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
    const joints = solveAnalyticalFr10Ik(tcp, baseZUp, 0, wristRollRad);
    const reachM = Math.hypot(tcp[0] - baseZUp[0], tcp[1] - baseZUp[1]);
    const shoulderTorqueNm = Number(
      ((3.8 + payloadMassKg) * 9.81 * reachM + Math.abs(wristRollRad) * 5.6).toFixed(2),
    );
    return {
      jointAnglesRad: joints,
      endEffectorPoseMeters: [
        Number(tcp[0].toFixed(3)),
        Number(tcp[1].toFixed(3)),
        Number(tcp[2].toFixed(3)),
      ],
      gripperWidthMm,
      gripperForceNewtons,
      payloadMassKg,
      shoulderTorqueNm,
    };
  }

  // Pan & cold-carrier MuJoCo cell (`tea-pan-cell` / `cold-rack-cell`)
  const motion =
    frame !== null
      ? frame.purpose === "admission" || frame.purpose === "removal"
        ? frame.after.motion
        : frame.motion
      : undefined;
  const sample =
    motion !== undefined ? motion.samples[motion.samples.length - 1] : undefined;
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
    endEffectorPoseMeters: [
      Number(tcp[0].toFixed(3)),
      Number(tcp[1].toFixed(3)),
      Number(tcp[2].toFixed(3)),
    ],
    gripperWidthMm,
    gripperForceNewtons,
    payloadMassKg,
    shoulderTorqueNm,
  };
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
  if (hasEspressoWorkflow && !results.some((r) => r.cellId === "espresso-cell")) {
    let espressoCompleted = 0;
    let espressoTotal = 0;
    let activeBrew: TaskView | null = null;
    let activePrep: TaskView | null = null;
    let lastBrew: TaskView | null = null;
    if (logistics.kind === "available") {
      for (const task of logistics.tasks) {
        if (
          task.subject.kind !== "workflow" ||
          !task.subject.instance.startsWith("espresso-order")
        )
          continue;
        if (
          task.subject.key === "extract-espresso" ||
          task.subject.key === "prepare-espresso"
        ) {
          espressoTotal += 1;
          if (task.kind === "completed" && task.completedAt <= timeUs) {
            espressoCompleted += 1;
            lastBrew = task;
          } else if (task.kind === "executing") {
            activeBrew = task;
          }
        } else if (task.kind === "executing") {
          activePrep = task;
        }
      }
    }
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
    let pourOverCompleted = 0;
    let pourOverTotal = 0;
    let activeBrew: TaskView | null = null;
    let activePrep: TaskView | null = null;
    let lastBrew: TaskView | null = null;
    if (logistics.kind === "available") {
      for (const task of logistics.tasks) {
        if (
          task.subject.kind !== "workflow" ||
          !task.subject.instance.startsWith("pour-over-order#")
        )
          continue;
        if (task.subject.key === "brew-pour-over") {
          pourOverTotal += 1;
          if (task.kind === "completed" && task.completedAt <= timeUs) {
            pourOverCompleted += 1;
            lastBrew = task;
          } else if (task.kind === "executing") {
            activeBrew = task;
          }
        } else if (task.kind === "executing") {
          activePrep = task;
        }
      }
    }
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
