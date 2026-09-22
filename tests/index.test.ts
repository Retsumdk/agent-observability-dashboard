import { describe, test, expect } from "bun:test";
import { MetricsRegistry, compare, percentile, mean } from "../src/metrics.js";
import { HealthMonitor } from "../src/health.js";
import { AlertManager } from "../src/alerts.js";
import { Dashboard } from "../src/dashboard.js";
import { simulateFleet } from "../src/simulate.js";
import type { Snapshot } from "../src/types.js";

describe("metrics", () => {
  test("counters accumulate and reset", () => {
    const r = new MetricsRegistry();
    r.increment("requests", 10);
    r.increment("requests", 5);
    expect(r.counter("requests")).toBe(15);
    r.resetCounter("requests");
    expect(r.counter("requests")).toBe(0);
  });

  test("rate averages counter deltas over the trailing window", () => {
    const r = new MetricsRegistry();
    r.increment("requests", 100, 1);
    r.increment("requests", 100, 2);
    r.increment("requests", 50, 3);
    // trailing 3 ticks: 100+100+50 = 250 over 3 ticks
    expect(r.rate("requests", 3)).toBeCloseTo(250 / 3);
    // same window expressed per 2 ticks
    expect(r.rate("requests", 3, 2)).toBeCloseTo(125);
  });

  test("gauges track the latest value", () => {
    const r = new MetricsRegistry();
    r.setGauge("p95_latency", 210, 1);
    r.setGauge("p95_latency", 640, 2);
    expect(r.gauge("p95_latency")).toBe(640);
  });

  test("histogram percentiles and mean", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50.5);
    expect(percentile(values, 0.95)).toBe(95.05);
    expect(percentile(values, 0.99)).toBe(99.01);
    expect(mean(values)).toBe(50.5);
  });

  test("histogram observation feeds gauge and ring buffer", () => {
    const r = new MetricsRegistry();
    const values = [10, 20, 30, 40, 100];
    values.forEach((v, i) => r.observe("latency", v, i + 1));
    expect(r.gauge("latency")).toBe(100);
    expect(r.series("latency")).toHaveLength(5);
    const h = r.histogram("latency");
    expect(h!.count).toBe(5);
    expect(h!.p50).toBe(30);
  });

  test("ring buffer keeps only the newest samples", () => {
    const r = new MetricsRegistry(10);
    for (let i = 0; i < 30; i++) r.observe("latency", i, i);
    const series = r.series("latency");
    expect(series).toHaveLength(10);
    expect(series[series.length - 1].value).toBe(29);
    expect(series[0].value).toBe(20);
  });

  test("compare implements every comparator", () => {
    expect(compare(10, "gt", 5)).toBe(true);
    expect(compare(5, "gt", 10)).toBe(false);
    expect(compare(10, "gte", 10)).toBe(true);
    expect(compare(5, "lt", 10)).toBe(true);
    expect(compare(10, "lt", 5)).toBe(false);
    expect(compare(5, "lte", 5)).toBe(true);
    expect(compare(7, "eq", 7)).toBe(true);
    expect(compare(7, "neq", 8)).toBe(true);
  });

  test("rejects non-finite samples", () => {
    const r = new MetricsRegistry();
    expect(() => r.record("latency", Number.NaN, 1)).toThrow(/finite/);
  });
});

describe("health", () => {
  const observe = (h: HealthMonitor, ok: boolean, latencyMs = 100) =>
    h.observe({ agent: "svc", ok, latencyMs });

  test("stays healthy while under the failure threshold", () => {
    const h = new HealthMonitor({ failAfter: 3 });
    observe(h, false);
    observe(h, false);
    expect(h.status("svc")).toBe("healthy");
  });

  test("flips to down after consecutive failures", () => {
    const h = new HealthMonitor({ failAfter: 3 });
    observe(h, false);
    observe(h, false);
    observe(h, false);
    expect(h.status("svc")).toBe("down");
    expect(h.record("svc")!.consecutiveFailures).toBe(3);
  });

  test("recovers only after consecutive successes", () => {
    const h = new HealthMonitor({ failAfter: 2, recoverAfter: 2 });
    observe(h, false);
    observe(h, false);
    expect(h.status("svc")).toBe("down");
    observe(h, true);
    expect(h.status("svc")).toBe("down");
    observe(h, true);
    expect(h.status("svc")).toBe("healthy");
  });

  test("high latency degrades a healthy agent", () => {
    const h = new HealthMonitor({ degradedLatencyMs: 1500 });
    observe(h, true, 2000);
    expect(h.status("svc")).toBe("degraded");
    observe(h, true, 100);
    expect(h.status("svc")).toBe("healthy");
  });

  test("a single failed probe never downs the agent", () => {
    const h = new HealthMonitor({ failAfter: 3 });
    observe(h, false);
    observe(h, true);
    expect(h.status("svc")).toBe("healthy");
  });
});

describe("alerts", () => {
  const RULES = [
    { id: "latency-high", series: "p95_latency", comparator: "gt" as const, threshold: 500, severity: "critical" as const, forTicks: 2 },
  ];

  test("does not fire before forTicks is reached", () => {
    const m = new MetricsRegistry();
    const alerts = new AlertManager(RULES);
    m.setGauge("p95_latency", 900, 1);
    let r = alerts.evaluate(m, 1);
    expect(r.fired).toHaveLength(0);
    m.setGauge("p95_latency", 900, 2);
    r = alerts.evaluate(m, 2);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0].state).toBe("firing");
    expect(r.fired[0].severity).toBe("critical");
  });

  test("resolves when the metric recovers", () => {
    const m = new MetricsRegistry();
    const alerts = new AlertManager(RULES);
    m.setGauge("p95_latency", 900, 1);
    alerts.evaluate(m, 1);
    m.setGauge("p95_latency", 900, 2);
    alerts.evaluate(m, 2);
    m.setGauge("p95_latency", 100, 3);
    const r = alerts.evaluate(m, 3);
    expect(r.fired).toHaveLength(0);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].state).toBe("resolved");
  });

  test("does not refire while already firing", () => {
    const m = new MetricsRegistry();
    const alerts = new AlertManager(RULES);
    m.setGauge("p95_latency", 900, 1);
    alerts.evaluate(m, 1);
    m.setGauge("p95_latency", 900, 2);
    expect(alerts.evaluate(m, 2).fired).toHaveLength(1);
    m.setGauge("p95_latency", 950, 3);
    const r = alerts.evaluate(m, 3);
    expect(r.fired).toHaveLength(0);
    expect(r.resolved).toHaveLength(0);
  });

  test("missing metric never fires", () => {
    const m = new MetricsRegistry();
    const alerts = new AlertManager([{ id: "missing", series: "nope", comparator: "gt", threshold: 1, severity: "info", forTicks: 1 }]);
    expect(alerts.evaluate(m, 1).fired).toHaveLength(0);
  });

  test("condition clearing before forTicks prevents firing", () => {
    const m = new MetricsRegistry();
    const alerts = new AlertManager(RULES);
    m.setGauge("p95_latency", 900, 1);
    alerts.evaluate(m, 1);
    m.setGauge("p95_latency", 100, 2);
    alerts.evaluate(m, 2);
    m.setGauge("p95_latency", 900, 3);
    expect(alerts.evaluate(m, 3).fired).toHaveLength(0);
  });

  test("rejects invalid rules", () => {
    expect(() => new AlertManager([{ id: "x", series: "s", comparator: "gt", threshold: Number.NaN, severity: "info", forTicks: 1 }])).toThrow(/finite/);
    expect(() => new AlertManager([{ id: "x", series: "s", comparator: "gt", threshold: 1, severity: "info", forTicks: 0 }])).toThrow(/forTicks/);
  });
});

describe("dashboard (end-to-end)", () => {
  test("simulated incident downs checkout-worker and fires its error-rate alert", () => {
    const d = simulateFleet(15);
    const snap = d.snapshot();

    const checkout = snap.agents.find((a) => a.agent === "checkout-worker")!;
    const orders = snap.agents.find((a) => a.agent === "orders-api")!;
    expect(checkout.status).toBe("down");
    expect(orders.status).toBe("healthy");

    const names = snap.alerts.filter((a) => a.state === "firing").map((a) => a.id);
    expect(names).toContain("checkout-errors");
  });

  test("render produces an ASCII board with agent rows, firing alerts and event log", () => {
    const d = simulateFleet(15);
    const text = d.render();
    expect(text).toContain("AGENT OBSERVABILITY DASHBOARD");
    expect(text).toContain("checkout-worker");
    expect(text).toContain("FIRING ALERTS");
    expect(text).toContain("DOWN");
    expect(text).toContain("FIRED");
  });

  test("snapshot round-trips through JSON and re-renders identically", () => {
    const d = simulateFleet(15);
    const json = JSON.parse(JSON.stringify(d.snapshot())) as Snapshot;
    const restored = Dashboard.fromSnapshot(json);
    expect(restored.snapshot()).toEqual(d.snapshot());
    expect(restored.render()).toBe(d.render());
  });

  test("alert timeline records fire and resolve transitions", () => {
    const d = simulateFleet(15);
    const timeline = d.alertTimeline();
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.some((l) => l.includes("FIRED"))).toBe(true);
  });
});
