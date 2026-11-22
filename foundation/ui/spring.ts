// Closed-form spring step responses. A value that changes target many times is
// the sum of one response per change: each response starts at rest, so the
// total keeps its position and velocity through every interruption and stays a
// pure function of time.

export type Spring = {
  /** Perceptual duration in milliseconds: the period of the undamped spring. */
  readonly duration: number;
  /** 0 is critically damped; 0.2 overshoots by about 1.5%. */
  readonly bounce: number;
};

/** Progress from 0 toward 1, `elapsed` milliseconds after a step. */
function springStep(spring: Spring, elapsed: number): number {
  if (elapsed <= 0) return 0;
  const omega = (2 * Math.PI) / spring.duration;
  const zeta = 1 - spring.bounce;
  if (zeta >= 1) return 1 - Math.exp(-omega * elapsed) * (1 + omega * elapsed);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  return (
    1 -
    Math.exp(-zeta * omega * elapsed) *
      (Math.cos(damped * elapsed) +
        ((zeta * omega) / damped) * Math.sin(damped * elapsed))
  );
}

/** Milliseconds until the response stays within 0.1% of its target. */
function springSettleTime(spring: Spring): number {
  const omega = (2 * Math.PI) / spring.duration;
  const zeta = 1 - spring.bounce;
  // e^-u (1 + u) = 0.001 at u ≈ 9.23 for the critically damped response.
  if (zeta >= 1) return 9.23 / omega;
  return Math.log(1 / (0.001 * Math.sqrt(1 - zeta * zeta))) / (zeta * omega);
}

type Response = {
  readonly start: number;
  readonly delta: number;
  readonly spring: Spring;
};

export class SpringValue {
  private base: number;
  private responses: Response[] = [];

  constructor(value: number) {
    this.base = value;
  }

  get target(): number {
    return this.responses.reduce(addDelta, this.base);
  }

  /** Heads for `target` from wherever the value is at `now`. */
  set(target: number, now: number, spring: Spring): void {
    const delta = target - this.target;
    if (delta !== 0) this.responses.push({ start: now, delta, spring });
  }

  jump(target: number): void {
    this.base = target;
    this.responses = [];
  }

  value(now: number): number {
    let value = this.base;
    for (const response of this.responses)
      value += response.delta * springStep(response.spring, now - response.start);
    return value;
  }

  /** Folds settled responses into the base; true while any are still moving. */
  settle(now: number): boolean {
    const moving: Response[] = [];
    for (const response of this.responses) {
      if (now - response.start < springSettleTime(response.spring))
        moving.push(response);
      else this.base += response.delta;
    }
    this.responses = moving;
    return moving.length > 0;
  }
}

function addDelta(total: number, response: Response): number {
  return total + response.delta;
}
