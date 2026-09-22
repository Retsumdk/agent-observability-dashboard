import type { AgentDefinition, DashboardOptions } from "./dashboard.js";
import { Dashboard } from "./dashboard.js";
import { AlertManager } from "./alerts.js";
import type { AlertRule } from "./types.js";

/** Seeded PRNG (mulberry32) so every demo/test run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FLEET_ALERT_RULES: AlertRule[] = [
  { id: "latency-critical", series: "orders-api.latency_ms", comparator: "gt", threshold: 1200, severity: "critical", forTicks: 3, description: "orders-api latency above 1200ms for 3 consecutive ticks" },
  { id: "checkout-errors", series: "checkout-worker.error_rate", comparator: "gt", threshold: 0.2, severity: "critical", forTicks: 2, description: "checkout-worker error rate above 20%" },
  { id: "mail-error-rate", series: "mail-sender.error_rate", comparator: "gt", threshold: 0.1, severity: "warning", forTicks: 3, description: "mail-sender error rate above 10%" },
];

export interface FleetOptions {
  seed?: number;
  /** Ticks the demo runs. */
  ticks?: number;
}

/**
 * Deterministic three-agent fleet:
 *  - orders-api: healthy, mild latency noise
 *  - checkout-worker: latency ramps up and it starts erroring mid-run (degrades then goes down)
 *  - mail-sender: healthy
 */
export function buildFleet(opts: FleetOptions = {}): { dashboard: Dashboard; ticks: number } {
  const rnd = mulberry32(opts.seed ?? 42);
  const ticks = opts.ticks ?? 12;

  const ordersApi: AgentDefinition = {
    name: "orders-api",
    probe: () => ({ ok: true, latencyMs: 90 + Math.floor(rnd() * 40) }),
    traffic: () => ({ requests: 400 + Math.floor(rnd() * 100), errors: Math.floor(rnd() * 4) }),
  };

  let checkoutTick = 0;

  const checkoutWorker: AgentDefinition = {
    name: "checkout-worker",
    probe: () => {
      checkoutTick += 1;
      // ramp: ticks 1-4 fine, 5-8 degrading, 9+ failing hard
      const latency = checkoutTick <= 4 ? 200 + rnd() * 60 : checkoutTick <= 8 ? 600 + (checkoutTick - 4) * 200 + rnd() * 80 : 2200 + rnd() * 300;
      const ok = checkoutTick <= 8;
      return { ok, latencyMs: Math.floor(latency), detail: ok ? undefined : "upstream timeout: payment-provider" };
    },
    traffic: () => {
      const requests = 120;
      const errors = checkoutTick <= 4 ? Math.floor(rnd() * 3) : checkoutTick <= 8 ? Math.floor(rnd() * 20) : 90 + Math.floor(rnd() * 20);
      return { requests, errors };
    },
  };

  const mailSender: AgentDefinition = {
    name: "mail-sender",
    probe: () => ({ ok: true, latencyMs: 40 + Math.floor(rnd() * 20) }),
    traffic: () => ({ requests: 250 + Math.floor(rnd() * 50), errors: Math.floor(rnd() * 3) }),
  };

  const dashboard = new Dashboard([ordersApi, checkoutWorker, mailSender], new AlertManager(FLEET_ALERT_RULES));
  return { dashboard, ticks };
}

/** Run the simulated fleet and return the final snapshot. */
export function runFleetDemo(opts: FleetOptions = {}): { dashboard: Dashboard; final: ReturnType<Dashboard["snapshot"]> } {
  const { dashboard, ticks } = buildFleet(opts);
  let final = dashboard.snapshot();
  for (let i = 0; i < ticks; i++) final = dashboard.tick();
  return { dashboard, final };
}

/**
 * Build the deterministic fleet and run `ticks` collection rounds against it.
 * Returns the dashboard positioned at the end of the run, ready to render.
 */
export function simulateFleet(ticks: number): Dashboard {
  const { dashboard } = buildFleet({ ticks });
  for (let i = 0; i < ticks; i++) dashboard.tick();
  return dashboard;
}

