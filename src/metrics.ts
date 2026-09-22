import type { HistogramStats, MetricSample, TimeSeries } from "./types.js";

/**
 * In-memory metrics registry with bounded per-series history.
 * All timestamps are caller-supplied so evaluation is deterministic.
 */
export class MetricsRegistry {
  private seriesMap = new Map<string, TimeSeries>();
  private counters = new Map<string, number>();
  private counterDeltas = new Map<string, { ts: number; by: number }[]>();
  private autoTs = 0;
  readonly maxSamples: number;

  constructor(maxSamples = 600) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1) {
      throw new Error(`maxSamples must be a positive integer, got ${maxSamples}`);
    }
    this.maxSamples = maxSamples;
  }

  /** Record a gauge/histogram sample into a named series. */
  record(name: string, value: number, ts: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`sample value for "${name}" must be finite, got ${value}`);
    }
    let s = this.seriesMap.get(name);
    if (!s) {
      s = { name, samples: [], maxSamples: this.maxSamples };
      this.seriesMap.set(name, s);
    }
    s.samples.push({ ts, value });
    if (s.samples.length > s.maxSamples) {
      s.samples.splice(0, s.samples.length - s.maxSamples);
    }
  }

  /** Convenience alias for record() with an auto-incrementing timestamp. */
  observe(name: string, value: number, ts?: number): void {
    this.record(name, value, ts ?? ++this.autoTs);
  }

  /** Set the latest value of a gauge series. */
  setGauge(name: string, value: number, ts: number): void {
    this.record(name, value, ts);
  }

  /** Latest gauge value, or undefined when the series is unknown. */
  gauge(name: string): number | undefined {
    return this.latest(name)?.value;
  }

  /** Increment a named counter (defaults to +1); ts enables rate queries. */
  increment(name: string, by = 1, ts?: number): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    if (ts !== undefined) {
      const d = this.counterDeltas.get(name) ?? [];
      d.push({ ts, by });
      this.counterDeltas.set(name, d);
    }
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  resetCounter(name: string): void {
    this.counters.delete(name);
    this.counterDeltas.delete(name);
  }

  /**
   * Average per-tick delta over the last `window` ticks, divided by `per`
   * (default: the window itself). Requires increments to carry timestamps.
   */
  rate(name: string, window: number, per = window): number {
    const d = this.counterDeltas.get(name) ?? [];
    if (d.length === 0 || window < 1) return 0;
    const lastTs = d[d.length - 1].ts;
    const sum = d.filter((x) => x.ts > lastTs - window).reduce((acc, x) => acc + x.by, 0);
    return sum / per;
  }

  /** Latest sample of a series, or undefined when the series is unknown. */
  latest(name: string): MetricSample | undefined {
    const s = this.seriesMap.get(name);
    return s && s.samples.length > 0 ? s.samples[s.samples.length - 1] : undefined;
  }

  /** Retained samples of a series (oldest first). */
  series(name: string): MetricSample[] {
    const s = this.seriesMap.get(name);
    return s ? s.samples.map((x) => ({ ...x })) : [];
  }

  /** Average of the last `window` samples (less if fewer exist). */
  windowMean(name: string, window: number): number | undefined {
    const s = this.seriesMap.get(name);
    if (!s || s.samples.length === 0) return undefined;
    const slice = s.samples.slice(-Math.max(1, window));
    return slice.reduce((acc, x) => acc + x.value, 0) / slice.length;
  }

  /** Histogram statistics over the full retained history of a series. */
  histogram(name: string): HistogramStats | undefined {
    const s = this.seriesMap.get(name);
    if (!s || s.samples.length === 0) return undefined;
    const values = s.samples.map((x) => x.value).slice().sort((a, b) => a - b);
    const count = values.length;
    const sum = values.reduce((acc, x) => acc + x, 0);
    return {
      count,
      min: values[0],
      max: values[count - 1],
      mean: sum / count,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
    };
  }

  /** ASCII sparkline over the most recent `width` samples. */
  sparkline(name: string, width = 20): string {
    const s = this.seriesMap.get(name);
    if (!s || s.samples.length === 0) return "";
    const slice = s.samples.slice(-width);
    const min = Math.min(...slice.map((x) => x.value));
    const max = Math.max(...slice.map((x) => x.value));
    const range = max - min;
    const glyphs = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
    return slice
      .map((x) => glyphs[range === 0 ? glyphs.length - 1 : Math.floor(((x.value - min) / range) * (glyphs.length - 1))])
      .join("");
  }

  seriesNames(): string[] {
    return [...this.seriesMap.keys()].sort();
  }

  snapshot(): Record<string, MetricSample[]> {
    const out: Record<string, MetricSample[]> = {};
    for (const [name, s] of this.seriesMap) out[name] = s.samples.map((x) => ({ ...x }));
    return out;
  }
}

/** Nearest-rank percentile over a pre-sorted ascending array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error("percentile of empty array");
  if (sorted.length === 1) return sorted[0];
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Arithmetic mean. */
export function mean(values: number[]): number {
  if (values.length === 0) throw new Error("mean of empty array");
  return values.reduce((acc, x) => acc + x, 0) / values.length;
}

export function compare(
  value: number,
  comparator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq",
  threshold: number,
): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "neq":
      return value !== threshold;
  }
}
