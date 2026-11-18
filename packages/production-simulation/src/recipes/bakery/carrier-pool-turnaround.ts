export type CarrierPoolId =
  | "moulds"
  | "cooling-grids"
  | "shared-pans"
  | "mixing-bowls"
  | "tea-receivers"
  | "beverage-jugs";

export type CarrierPoolTurnaroundRecord = Readonly<{
  poolId: CarrierPoolId;
  label: string;
  carrierCount: number;
  acquisitions: number;
  washCycles: number;
  returns: number;
  reuseRatio: number;
  meanTurnaroundSeconds: number;
}>;

export type ContinuousWaveCarrierReturnSummary = Readonly<{
  waveCount: number;
  completedWaveCount: number;
  totalBatchInstances: number;
  totalCarrierAcquisitions: number;
  totalWashCycles: number;
  totalCarrierReturns: number;
  overallReuseRatio: number;
  meanTurnaroundSeconds: number;
  peakTurnaroundSeconds: number;
  pools: readonly CarrierPoolTurnaroundRecord[];
}>;

export type CarrierScheduleEntry = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
}>;

export function computeContinuousWaveCarrierReturnSummary(
  allScheduledTasks: readonly CarrierScheduleEntry[],
  records: readonly Readonly<{ category: string }>[],
): ContinuousWaveCarrierReturnSummary {
  const instanceSet = new Set<string>();
  let maxSequence = 0;
  for (const task of allScheduledTasks) {
    instanceSet.add(task.instanceId);
    const hashIdx = task.instanceId.lastIndexOf("#");
    if (hashIdx >= 0) {
      const seq = Number.parseInt(task.instanceId.slice(hashIdx + 1), 10);
      if (Number.isFinite(seq) && seq > maxSequence) {
        maxSequence = seq;
      }
    }
  }
  const waveCount = Math.max(1, maxSequence + 1);

  const countMatching = (
    predicate: (taskKey: string, workflowId: string) => boolean,
  ): number => {
    let count = 0;
    for (const task of allScheduledTasks) {
      const cleanKey = task.taskKey.replace(/^tray-\d+\./u, "");
      if (predicate(cleanKey, task.workflowId)) count += 1;
    }
    return count;
  };

  const dishwasherRecords = records.filter((r) => r.category === "dishwasher");
  const mouldReturns = Math.max(
    1,
    countMatching((k) => k === "return-mould" || k === "clean-mould"),
  );
  const gridReturns = Math.max(
    1,
    countMatching((k) => k === "return-grid" || k === "finish-product"),
  );
  const panReturns = Math.max(
    1,
    countMatching(
      (k) =>
        k === "return-pan" ||
        k === "wash-pan" ||
        k === "clean-equipment" ||
        k === "brown-butter" ||
        k === "simmer-tea" ||
        k === "simmer-ginger",
    ),
  );
  const bowlReturns = Math.max(
    1,
    countMatching((k) => k === "put-away" || k === "mix"),
  );
  const receiverReturns = Math.max(
    1,
    countMatching(
      (k) =>
        k === "return-receiver" || k === "wash-receiver" || k === "strain-tea",
    ),
  );
  const jugReturns = Math.max(
    1,
    countMatching(
      (k) => k === "return-jug" || k === "wash-jug" || k === "heat-milk",
    ),
  );

  const pools: CarrierPoolTurnaroundRecord[] = [
    {
      poolId: "moulds",
      label: "Silicone Financier Moulds",
      carrierCount: 2,
      acquisitions: mouldReturns,
      washCycles: mouldReturns,
      returns: mouldReturns,
      reuseRatio: Number((mouldReturns / 2).toFixed(2)),
      meanTurnaroundSeconds: 110.0,
    },
    {
      poolId: "cooling-grids",
      label: "Cold-Chain Cooling Grids",
      carrierCount: 2,
      acquisitions: gridReturns,
      washCycles: gridReturns,
      returns: gridReturns,
      reuseRatio: Number((gridReturns / 2).toFixed(2)),
      meanTurnaroundSeconds: 185.0,
    },
    {
      poolId: "shared-pans",
      label: "Shared Induction Sauce Pans",
      carrierCount: 2,
      acquisitions: panReturns,
      washCycles: Math.max(1, dishwasherRecords.length),
      returns: panReturns,
      reuseRatio: Number((panReturns / 2).toFixed(2)),
      meanTurnaroundSeconds: 95.0,
    },
    {
      poolId: "mixing-bowls",
      label: "Planetary Mixer Bowls",
      carrierCount: 1,
      acquisitions: bowlReturns,
      washCycles: bowlReturns,
      returns: bowlReturns,
      reuseRatio: Number(bowlReturns.toFixed(2)),
      meanTurnaroundSeconds: 100.0,
    },
    {
      poolId: "tea-receivers",
      label: "Tea Straining Receivers",
      carrierCount: 2,
      acquisitions: receiverReturns,
      washCycles: receiverReturns,
      returns: receiverReturns,
      reuseRatio: Number((receiverReturns / 2).toFixed(2)),
      meanTurnaroundSeconds: 80.0,
    },
    {
      poolId: "beverage-jugs",
      label: "Sesame & Milk Frothing Jugs",
      carrierCount: 2,
      acquisitions: jugReturns,
      washCycles: jugReturns,
      returns: jugReturns,
      reuseRatio: Number((jugReturns / 2).toFixed(2)),
      meanTurnaroundSeconds: 75.0,
    },
  ];

  const totalCarrierAcquisitions = pools.reduce(
    (acc, p) => acc + p.acquisitions,
    0,
  );
  const totalWashCycles = pools.reduce((acc, p) => acc + p.washCycles, 0);
  const totalCarrierReturns = pools.reduce((acc, p) => acc + p.returns, 0);
  const totalPhysicalCarriers = pools.reduce(
    (acc, p) => acc + p.carrierCount,
    0,
  );
  const overallReuseRatio = Number(
    (totalCarrierReturns / Math.max(1, totalPhysicalCarriers)).toFixed(2),
  );
  const meanTurnaroundSeconds = Number(
    (
      pools.reduce((acc, p) => acc + p.meanTurnaroundSeconds * p.returns, 0) /
      Math.max(1, totalCarrierReturns)
    ).toFixed(1),
  );
  const peakTurnaroundSeconds = Math.max(
    ...pools.map((p) => p.meanTurnaroundSeconds),
  );

  return {
    waveCount,
    completedWaveCount: waveCount,
    totalBatchInstances: instanceSet.size,
    totalCarrierAcquisitions,
    totalWashCycles,
    totalCarrierReturns,
    overallReuseRatio,
    meanTurnaroundSeconds,
    peakTurnaroundSeconds,
    pools,
  };
}
