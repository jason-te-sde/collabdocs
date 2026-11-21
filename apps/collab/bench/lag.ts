import { percentile } from "./stats";

export interface Lag {
  p50: number;
  p99: number;
  max: number;
  mean: number;
  /** When the largest delay happened, in milliseconds after start(). */
  maxAtMs: number;
  samples: number;
}

/**
 * Event-loop lag: a timer that asks to fire every `intervalMs` and records how late it
 * was. Unlike Node's own histogram it keeps the time of the largest delay, and its first
 * tick is measured from start(), not from an earlier tick. A timer cannot fire exactly
 * on time, so an idle loop reads about a millisecond; that is timer slop, not lag.
 */
export class LagMeter {
  private delays: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private began = 0;
  private maxAt = 0;
  private max = 0;

  constructor(private readonly intervalMs = 5) {}

  start(): void {
    this.delays = [];
    this.max = 0;
    this.maxAt = 0;
    this.began = performance.now();
    let expected = this.began + this.intervalMs;
    const tick = (): void => {
      const now = performance.now();
      const late = Math.max(0, now - expected);
      this.delays.push(late);
      if (late > this.max) {
        this.max = late;
        this.maxAt = now - this.began;
      }
      expected = now + this.intervalMs;
      this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop(): Lag {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.delays.length === 0) throw new Error("the lag meter was not running");
    let sum = 0;
    for (const d of this.delays) sum += d;
    return {
      p50: percentile(this.delays, 50),
      p99: percentile(this.delays, 99),
      max: this.max,
      mean: sum / this.delays.length,
      maxAtMs: this.maxAt,
      samples: this.delays.length,
    };
  }
}
